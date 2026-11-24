/**
 * 社媒中心（Facebook 先行，其它平台预留）+ 消息推送中心（企业微信）。
 *
 * 社媒四个页面：账号连接 / 主页与内容 / 广告投放 / 表单线索（Meta 直连）。
 * 所有数据都来自 Meta 官方接口（后端代理，令牌只在服务端），这里只负责展示和操作入口。
 */
import { activateNavView, confirmAction, state } from "../prototype-api";
import { escapeHtml, qs } from "./shared";
import { api, setButtonPending, toast } from "./ui";

// ---------- 类型 ----------
interface SocialPage { id: string; name: string; category: string; pictureUrl: string; tasks: string[]; leadgenSubscribed: boolean; hasToken: boolean }
interface SocialAdAccount { id: string; accountId: string; name: string; currency: string; status: number; business: string }
interface SocialConnection {
  id: string; platform: string; fbUserId: string; name: string; pictureUrl: string;
  connectedBy: string; connectedByName: string; connectedAt: string; refreshedAt: string; tokenExpiresAt: string;
  grantedScopes: string[]; declinedScopes: string[]; pages: SocialPage[]; adAccounts: SocialAdAccount[];
}
interface SocialLeadgenLog { id: string; at: string; via: string; pageId: string; formId: string; leadgenId: string; leadId: string; status: string; message: string }
interface SocialOverview {
  meta: {
    configured: boolean; appId: string; graphVersion: string; leadOwnerId: string; secretSet: boolean; verifyToken: string; scopes: string[];
    redirectUri: string; webhookUrl: string; deauthorizeUrl: string; dataDeletionUrl: string;
  };
  connections: SocialConnection[];
  leadgen: { recent: SocialLeadgenLog[]; today: number; total: number };
  owners: Array<{ id: string; name: string; email: string }>;
  canManage: boolean;
  canConnect: boolean;
}

let overview: SocialOverview | null = null;
let selectedPageId = "";
let selectedAdAccountId = "";
let adsRange = "last_30d";
let socialBound = false;

const PLATFORMS: Array<{ key: string; name: string; note: string; ready: boolean; mark: string }> = [
  { key: "facebook", name: "Facebook", note: "主页、帖子、广告、表单线索", ready: true, mark: "f" },
  { key: "instagram", name: "Instagram", note: "专业账号内容与私信", ready: false, mark: "IG" },
  { key: "linkedin", name: "LinkedIn", note: "公司主页与线索表单", ready: false, mark: "in" },
  { key: "tiktok", name: "TikTok", note: "企业号与线索广告", ready: false, mark: "TT" },
  { key: "youtube", name: "YouTube", note: "频道数据", ready: false, mark: "YT" },
  { key: "x", name: "X", note: "账号与互动", ready: false, mark: "X" }
];

const fmtNum = (value: number) => (Number.isFinite(value) ? value.toLocaleString("en-US") : "0");
const fmtMoney = (value: number, currency = "") => `${currency ? `${currency} ` : ""}${(Number(value) || 0).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
function fmtTime(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function allPages() {
  return (overview?.connections || []).flatMap((connection) => connection.pages.map((page) => ({ ...page, owner: connection.name })));
}

function allAdAccounts() {
  return (overview?.connections || []).flatMap((connection) => connection.adAccounts.map((account) => ({ ...account, owner: connection.name })));
}

async function loadOverview(force = false) {
  if (overview && !force) return overview;
  overview = await api<SocialOverview>("/api/social/overview");
  return overview;
}

function root(view: string) {
  return qs<HTMLElement>(`#${view} .sm-root`);
}

function head(title: string, sub: string, actions = "") {
  return `<header class="sm-head"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(sub)}</p></div><div class="sm-head-actions">${actions}</div></header>`;
}

function emptyBlock(title: string, text: string, action = "") {
  return `<div class="sm-empty"><b>${escapeHtml(title)}</b><p>${escapeHtml(text)}</p>${action}</div>`;
}

function copyField(label: string, value: string, hint = "") {
  return `<div class="sm-copy"><span>${escapeHtml(label)}</span><code>${escapeHtml(value || "—")}</code>${value ? `<button type="button" class="sm-copy-btn" data-sm-copy="${escapeHtml(value)}">复制</button>` : ""}${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</div>`;
}

function needConnection(view: string) {
  const box = root(view);
  if (!box) return true;
  if (!overview?.meta.configured || !overview.connections.length) {
    box.innerHTML = head(view === "social-ads" ? "广告投放" : view === "social-forms" ? "表单线索" : "主页与内容", "先连接 Facebook 账号") +
      emptyBlock("还没有连接 Facebook", overview?.meta.configured ? "到「账号连接」点「连接 Facebook 账号」，授权后这里会显示你管理的主页和广告账户。" : "管理员先在「账号连接」里填写 Meta 应用信息，然后连接账号。",
        '<button class="btn primary" type="button" data-sm-go="social">去连接</button>');
    return true;
  }
  return false;
}

// ---------- 账号连接 ----------
function renderAccounts() {
  const box = root("social");
  if (!box || !overview) return;
  const meta = overview.meta;
  const connections = overview.connections;
  const platformCards = PLATFORMS.map((platform) => {
    const count = platform.key === "facebook" ? connections.length : 0;
    const status = !platform.ready ? "即将支持" : !meta.configured ? "待配置应用" : count ? `已连接 ${count} 个账号` : "未连接";
    return `<div class="sm-platform" data-ready="${platform.ready ? "1" : "0"}" data-on="${count ? "1" : "0"}" data-p="${platform.key}">
      <span class="sm-mark" data-p="${platform.key}">${escapeHtml(platform.mark)}</span>
      <div><b>${escapeHtml(platform.name)}</b><small>${escapeHtml(platform.note)}</small></div>
      <em>${escapeHtml(status)}</em>
    </div>`;
  }).join("");

  const setup = `
    <section class="sm-card sm-setup" id="smSetup" ${meta.configured ? "hidden" : ""}>
      <h3>配置 Meta 应用（管理员，一次即可）</h3>
      <ol class="sm-steps">
        <li><b>建应用</b>：打开 <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer">developers.facebook.com/apps</a>，创建「企业（Business）」类型应用，添加「Facebook 登录（企业版）」和「Webhooks」产品。</li>
        <li><b>填回调地址</b>：在 Facebook 登录设置的「有效 OAuth 跳转 URI」里填下面的授权回调地址；在「应用设置 → 基本」里填取消授权回调和数据删除请求地址。</li>
        <li><b>填到 CRM</b>：把「应用设置 → 基本」里的 App ID 和 App Secret 填到下面，保存。</li>
        <li><b>连接账号</b>：你和加入应用角色（管理员 / 开发者 / 测试人员）的同事可以直接授权使用；要给应用角色以外的账号用，需要在应用后台为 leads_retrieval、ads_read、pages_read_engagement 等权限提交审核，并完成企业验证。</li>
      </ol>
      <div class="sm-copies">
        ${copyField("授权回调（有效 OAuth 跳转 URI）", meta.redirectUri)}
        ${meta.configured ? copyField("取消授权回调", meta.deauthorizeUrl) + copyField("数据删除请求地址", meta.dataDeletionUrl) : '<p class="sm-note">保存应用后，这里会生成取消授权回调、数据删除请求和 Webhook 地址。</p>'}
      </div>
      ${overview.canManage ? `
      <div class="sm-form">
        <label><span>App ID</span><input id="smAppId" inputmode="numeric" value="${escapeHtml(meta.appId)}" placeholder="例如 1234567890123"></label>
        <label><span>App Secret</span><input id="smAppSecret" type="password" autocomplete="new-password" placeholder="${meta.secretSet ? "已保存，留空不修改" : "应用设置 → 基本 → 应用密钥"}"></label>
        <label><span>Graph API 版本</span><input id="smGraphVersion" value="${escapeHtml(meta.graphVersion)}"></label>
        <label><span>表单线索归属</span><select id="smLeadOwner"><option value="">授权这个主页的人</option>${overview.owners.map((owner) => `<option value="${escapeHtml(owner.id)}" ${owner.id === meta.leadOwnerId ? "selected" : ""}>${escapeHtml(owner.name)}</option>`).join("")}</select></label>
      </div>
      <div class="sm-actions"><button class="btn primary" type="button" id="smSaveApp">保存应用配置</button>${meta.configured ? '<button class="btn" type="button" data-sm-toggle-setup>收起</button>' : ""}</div>`
      : '<p class="sm-note">需要管理员来配置应用。</p>'}
    </section>`;

  const list = connections.length ? connections.map((connection) => {
    const expires = connection.tokenExpiresAt ? `授权有效期至 ${fmtTime(connection.tokenExpiresAt).slice(0, 10)}` : "长期有效";
    const missing = connection.declinedScopes.filter((scope) => overview!.meta.scopes.includes(scope));
    return `<article class="sm-conn">
      <div class="sm-conn-main">
        ${connection.pictureUrl ? `<img src="${escapeHtml(connection.pictureUrl)}" alt="" referrerpolicy="no-referrer">` : `<span class="sm-avatar">${escapeHtml(connection.name.slice(0, 1))}</span>`}
        <div>
          <b>${escapeHtml(connection.name)}</b>
          <small>${escapeHtml(connection.connectedByName || "—")} 于 ${fmtTime(connection.connectedAt)} 连接，${escapeHtml(expires)}</small>
        </div>
        <div class="sm-conn-stats"><span><b>${connection.pages.length}</b> 个主页</span><span><b>${connection.adAccounts.length}</b> 个广告账户</span></div>
        <div class="sm-conn-actions">
          <button class="btn" type="button" data-sm-refresh="${escapeHtml(connection.id)}">刷新</button>
          ${overview!.canManage || connection.connectedBy === state.user?.id ? `<button class="btn" type="button" data-sm-disconnect="${escapeHtml(connection.id)}">断开</button>` : ""}
        </div>
      </div>
      ${missing.length ? `<p class="sm-warn">授权时没有勾选：${escapeHtml(missing.join("、"))}。相关功能会不可用，重新连接时勾选即可。</p>` : ""}
      <div class="sm-chips">${connection.pages.map((page) => `<button type="button" class="sm-chip" data-sm-page="${escapeHtml(page.id)}">${page.pictureUrl ? `<img src="${escapeHtml(page.pictureUrl)}" alt="" referrerpolicy="no-referrer">` : ""}${escapeHtml(page.name)}${page.leadgenSubscribed ? "<i>表单直连</i>" : ""}</button>`).join("")}${connection.adAccounts.map((account) => `<button type="button" class="sm-chip is-ad" data-sm-ad="${escapeHtml(account.id)}">广告 · ${escapeHtml(account.name)}</button>`).join("")}</div>
    </article>`;
  }).join("") : emptyBlock("还没有连接的 Facebook 账号", meta.configured ? "点「连接 Facebook 账号」，用 Facebook 官方授权页登录并勾选权限。CRM 只读取你授权的主页、广告和表单数据。" : "管理员先完成上面的 Meta 应用配置。");

  box.innerHTML = `
    ${head("社媒账号", "连接公司的社媒账号，在 CRM 里查看主页、广告和表单线索。全部走平台官方授权接口。",
      `${meta.configured && overview.canManage ? '<button class="btn" type="button" data-sm-toggle-setup>Meta 应用设置</button>' : ""}${meta.configured && overview.canConnect ? '<button class="btn primary" type="button" id="smConnect">连接 Facebook 账号</button>' : ""}`)}
    <div class="sm-platforms">${platformCards}</div>
    ${setup}
    <section class="sm-section"><h2>Facebook 账号</h2>${list}</section>
    <section class="sm-trust">
      <b>数据与授权</b>
      <p>授权通过 Facebook 官方登录页完成，CRM 拿不到你的 Facebook 密码。访问令牌加密保存在服务器，接口不会回显；每次调用都带 appsecret_proof。点「断开」会同时在 Facebook 撤销授权并删除本地令牌。你也可以随时在 Facebook「设置 → 应用和网站」里移除授权，CRM 会收到通知并删除连接。</p>
    </section>`;
}

// ---------- 主页与内容 ----------
async function renderPages() {
  const box = root("social-pages");
  if (!box || needConnection("social-pages")) return;
  const pages = allPages();
  if (!pages.some((page) => page.id === selectedPageId)) selectedPageId = pages[0]?.id || "";
  const picker = pages.map((page) => `<button type="button" class="sm-tab" data-sm-page-pick="${escapeHtml(page.id)}" aria-pressed="${page.id === selectedPageId}">${escapeHtml(page.name)}</button>`).join("");
  box.innerHTML = `${head("主页与内容", "查看主页数据和最近发布的帖子。发帖、回复请在 Meta Business Suite 里操作。", `<a class="btn" href="https://business.facebook.com/latest/home" target="_blank" rel="noopener noreferrer">打开 Meta Business Suite</a>`)}
    <div class="sm-tabs">${picker || '<span class="sm-note">这个账号没有可管理的主页</span>'}</div>
    <div id="smPageBody"><div class="sm-loading">正在读取主页…</div></div>`;
  if (!selectedPageId) return;
  try {
    const data = await api<{ page: { id: string; name: string; category: string; about: string; link: string; fans: number; followers: number; pictureUrl: string; coverUrl: string; leadgenSubscribed: boolean }; posts: Array<{ id: string; message: string; createdAt: string; permalink: string; picture: string; reactions: number; comments: number; shares: number }> }>(`/api/social/meta/pages/${encodeURIComponent(selectedPageId)}`);
    const body = qs<HTMLElement>("#smPageBody");
    if (!body) return;
    const page = data.page;
    body.innerHTML = `
      <section class="sm-page-hero" ${page.coverUrl ? `style="--cover:url('${escapeHtml(page.coverUrl)}')"` : ""}>
        ${page.pictureUrl ? `<img src="${escapeHtml(page.pictureUrl)}" alt="" referrerpolicy="no-referrer">` : `<span class="sm-avatar big">${escapeHtml(page.name.slice(0, 1))}</span>`}
        <div class="sm-page-id"><h2>${escapeHtml(page.name)}</h2><p>${escapeHtml(page.category)}${page.link ? `　<a href="${escapeHtml(page.link)}" target="_blank" rel="noopener noreferrer">在 Facebook 打开</a>` : ""}</p>${page.about ? `<p class="sm-about">${escapeHtml(page.about)}</p>` : ""}</div>
        <dl class="sm-kpis"><div><dt>关注</dt><dd>${fmtNum(page.followers)}</dd></div><div><dt>点赞</dt><dd>${fmtNum(page.fans)}</dd></div><div><dt>表单直连</dt><dd class="${page.leadgenSubscribed ? "ok" : ""}">${page.leadgenSubscribed ? "已开启" : "未开启"}</dd></div></dl>
      </section>
      <h3 class="sm-sub">最近的帖子</h3>
      ${data.posts.length ? `<div class="sm-posts">${data.posts.map((post) => `
        <article class="sm-post">
          ${post.picture ? `<div class="sm-post-img" style="background-image:url('${escapeHtml(post.picture)}')"></div>` : ""}
          <p>${escapeHtml(post.message || "（没有文字内容）")}</p>
          <footer><span>${fmtTime(post.createdAt)}</span><span>赞 ${fmtNum(post.reactions)}</span><span>评论 ${fmtNum(post.comments)}</span><span>分享 ${fmtNum(post.shares)}</span>${post.permalink ? `<a href="${escapeHtml(post.permalink)}" target="_blank" rel="noopener noreferrer">查看</a>` : ""}</footer>
        </article>`).join("")}</div>` : emptyBlock("还没有帖子", "这个主页最近没有发布内容。")}`;
  } catch (error) {
    const body = qs<HTMLElement>("#smPageBody");
    if (body) body.innerHTML = emptyBlock("读取失败", error instanceof Error ? error.message : "Facebook 接口调用失败");
  }
}

// ---------- 广告投放 ----------
const RANGES: Array<[string, string]> = [["today", "今天"], ["yesterday", "昨天"], ["last_7d", "近 7 天"], ["last_30d", "近 30 天"], ["this_month", "本月"], ["last_month", "上月"]];
const CAMPAIGN_STATUS: Record<string, string> = { ACTIVE: "投放中", PAUSED: "已暂停", CAMPAIGN_PAUSED: "已暂停", ARCHIVED: "已归档", DELETED: "已删除", IN_PROCESS: "处理中", WITH_ISSUES: "有问题", PENDING_REVIEW: "审核中", DISAPPROVED: "未通过" };
const OBJECTIVES: Record<string, string> = { OUTCOME_LEADS: "潜在客户", OUTCOME_TRAFFIC: "流量", OUTCOME_ENGAGEMENT: "互动", OUTCOME_AWARENESS: "知名度", OUTCOME_SALES: "销量", OUTCOME_APP_PROMOTION: "应用推广", LEAD_GENERATION: "潜在客户", LINK_CLICKS: "链接点击", MESSAGES: "消息" };

async function renderAds() {
  const box = root("social-ads");
  if (!box || needConnection("social-ads")) return;
  const accounts = allAdAccounts();
  if (!accounts.some((account) => account.id === selectedAdAccountId)) selectedAdAccountId = accounts[0]?.id || "";
  box.innerHTML = `${head("广告投放", "只读查看广告账户的花费、效果和每个广告系列的表现。改预算、开停广告请在 Meta 广告管理工具里操作。",
    `<select id="smAdsRange" aria-label="时间范围">${RANGES.map(([key, label]) => `<option value="${key}" ${key === adsRange ? "selected" : ""}>${label}</option>`).join("")}</select><a class="btn" href="https://adsmanager.facebook.com/" target="_blank" rel="noopener noreferrer">打开广告管理工具</a>`)}
    <div class="sm-tabs">${accounts.map((account) => `<button type="button" class="sm-tab" data-sm-ad-pick="${escapeHtml(account.id)}" aria-pressed="${account.id === selectedAdAccountId}">${escapeHtml(account.name)}<small>${escapeHtml(account.currency)}</small></button>`).join("") || '<span class="sm-note">没有可读取的广告账户（授权时需要勾选 ads_read）</span>'}</div>
    <div id="smAdsBody">${selectedAdAccountId ? '<div class="sm-loading">正在读取广告数据…</div>' : ""}</div>`;
  if (!selectedAdAccountId) return;
  try {
    const data = await api<{ account: SocialAdAccount; summary: { spend: number; impressions: number; reach: number; clicks: number; ctr: number; cpc: number; leads: number }; campaigns: Array<{ id: string; name: string; status: string; objective: string; dailyBudget: number; lifetimeBudget: number; spend: number; impressions: number; clicks: number; ctr: number; cpc: number; leads: number }> }>(`/api/social/meta/adaccounts/${encodeURIComponent(selectedAdAccountId)}/campaigns?range=${adsRange}`);
    const body = qs<HTMLElement>("#smAdsBody");
    if (!body) return;
    const cur = data.account.currency;
    const s = data.summary;
    const cpl = s.leads ? s.spend / s.leads : 0;
    body.innerHTML = `
      <dl class="sm-metrics">
        <div><dt>花费</dt><dd>${fmtMoney(s.spend, cur)}</dd></div>
        <div><dt>展示</dt><dd>${fmtNum(s.impressions)}</dd></div>
        <div><dt>触达</dt><dd>${fmtNum(s.reach)}</dd></div>
        <div><dt>点击</dt><dd>${fmtNum(s.clicks)}</dd></div>
        <div><dt>点击率</dt><dd>${s.ctr.toFixed(2)}%</dd></div>
        <div><dt>单次点击</dt><dd>${fmtMoney(s.cpc, cur)}</dd></div>
        <div class="is-key"><dt>表单线索</dt><dd>${fmtNum(s.leads)}</dd></div>
        <div class="is-key"><dt>单条线索成本</dt><dd>${s.leads ? fmtMoney(cpl, cur) : "—"}</dd></div>
      </dl>
      ${data.campaigns.length ? `<div class="sm-table-wrap"><table class="sm-table">
        <thead><tr><th>广告系列</th><th>状态</th><th>目标</th><th class="num">预算</th><th class="num">花费</th><th class="num">展示</th><th class="num">点击</th><th class="num">点击率</th><th class="num">线索</th></tr></thead>
        <tbody>${data.campaigns.map((campaign) => `<tr>
          <td><b>${escapeHtml(campaign.name)}</b></td>
          <td><span class="sm-status" data-s="${escapeHtml(campaign.status)}">${escapeHtml(CAMPAIGN_STATUS[campaign.status] || campaign.status)}</span></td>
          <td>${escapeHtml(OBJECTIVES[campaign.objective] || campaign.objective || "—")}</td>
          <td class="num">${campaign.dailyBudget ? `${fmtMoney(campaign.dailyBudget, cur)}/天` : campaign.lifetimeBudget ? `${fmtMoney(campaign.lifetimeBudget, cur)} 总` : "—"}</td>
          <td class="num">${fmtMoney(campaign.spend, cur)}</td>
          <td class="num">${fmtNum(campaign.impressions)}</td>
          <td class="num">${fmtNum(campaign.clicks)}</td>
          <td class="num">${campaign.ctr.toFixed(2)}%</td>
          <td class="num"><b>${fmtNum(campaign.leads)}</b></td>
        </tr>`).join("")}</tbody></table></div>` : emptyBlock("这段时间没有广告系列数据", "换个时间范围看看。")}`;
  } catch (error) {
    const body = qs<HTMLElement>("#smAdsBody");
    if (body) body.innerHTML = emptyBlock("读取失败", error instanceof Error ? error.message : "Facebook 接口调用失败");
  }
}

// ---------- 表单线索（Meta 直连） ----------
async function renderForms() {
  const box = root("social-forms");
  if (!box || needConnection("social-forms")) return;
  const meta = overview!.meta;
  const pages = allPages();
  if (!pages.some((page) => page.id === selectedPageId)) selectedPageId = pages[0]?.id || "";
  const current = pages.find((page) => page.id === selectedPageId);
  const log = overview!.leadgen.recent;
  box.innerHTML = `${head("表单线索", "Facebook 线索广告的表单提交后，自动进 CRM 线索池（来源记为 Facebook 表单，并带上广告系列）。",
    `<button class="btn" type="button" data-sm-go="lead-ads">中转方式（Make / Zapier）</button><button class="btn primary" type="button" data-sm-go="leads">查看线索池</button>`)}
    <div class="sm-tabs">${pages.map((page) => `<button type="button" class="sm-tab" data-sm-page-pick="${escapeHtml(page.id)}" aria-pressed="${page.id === selectedPageId}">${escapeHtml(page.name)}${page.leadgenSubscribed ? "<i>已直连</i>" : ""}</button>`).join("")}</div>
    <section class="sm-card sm-direct" data-on="${current?.leadgenSubscribed ? "1" : "0"}">
      <div class="sm-direct-main">
        <span class="sm-dot" aria-hidden="true"></span>
        <div><b>${current?.leadgenSubscribed ? "表单线索直连已开启" : "表单线索直连未开启"}</b><p>${current?.leadgenSubscribed ? "这个主页的新表单提交会通过 Meta Webhook 实时推到 CRM，通常几秒内进线索池。" : "开启后，这个主页所有线索表单的新提交都会实时进 CRM 线索池。"}</p></div>
        ${overview!.canManage && current ? `<button class="btn ${current.leadgenSubscribed ? "" : "primary"}" type="button" data-sm-subscribe="${current.leadgenSubscribed ? "0" : "1"}">${current.leadgenSubscribed ? "关闭直连" : "开启直连"}</button>` : ""}
      </div>
      <details class="sm-howto" ${current?.leadgenSubscribed ? "" : "open"}>
        <summary>第一次开启前，在 Meta 应用后台做一次 Webhook 设置</summary>
        <ol class="sm-steps">
          <li>应用后台 → Webhooks → 对象选「Page（主页）」→ 订阅，回调网址和验证令牌填下面两项，点「验证并保存」。</li>
          <li>在 Page 的字段列表里找到 <b>leadgen</b>，点「订阅」。</li>
          <li>回到这里点「开启直连」，CRM 会把这个主页订阅到你的应用。</li>
        </ol>
        <div class="sm-copies">${copyField("回调网址", meta.webhookUrl)}${overview!.canManage ? copyField("验证令牌", meta.verifyToken, "只有管理员能看到") : ""}</div>
      </details>
    </section>
    <h3 class="sm-sub">线索表单</h3>
    <div id="smFormsBody"><div class="sm-loading">正在读取表单…</div></div>
    <h3 class="sm-sub">接收记录 <small>今天 ${overview!.leadgen.today} 条，累计 ${overview!.leadgen.total} 条</small></h3>
    ${log.length ? `<div class="sm-table-wrap"><table class="sm-table"><thead><tr><th>时间</th><th>方式</th><th>结果</th><th>说明</th></tr></thead><tbody>${log.map((item) => `<tr>
      <td>${fmtTime(item.at)}</td><td>${item.via === "webhook" ? "实时推送" : "手动导入"}</td>
      <td><span class="sm-status" data-s="${item.status === "created" ? "ACTIVE" : item.status === "duplicate" ? "PAUSED" : "DISAPPROVED"}">${item.status === "created" ? "已建线索" : item.status === "duplicate" ? "已存在" : "失败"}</span></td>
      <td>${escapeHtml(item.message)}</td></tr>`).join("")}</tbody></table></div>` : emptyBlock("还没有收到表单线索", "开启直连后，新的表单提交会出现在这里；也可以对已有表单点「导入最近线索」。")}`;
  if (!selectedPageId) return;
  try {
    const data = await api<{ leadgenSubscribed: boolean; forms: Array<{ id: string; name: string; status: string; leadsCount: number; createdAt: string; locale: string }> }>(`/api/social/meta/pages/${encodeURIComponent(selectedPageId)}/leadforms`);
    const body = qs<HTMLElement>("#smFormsBody");
    if (!body) return;
    body.innerHTML = data.forms.length ? `<div class="sm-table-wrap"><table class="sm-table"><thead><tr><th>表单</th><th>状态</th><th class="num">累计提交</th><th>创建时间</th><th></th></tr></thead><tbody>${data.forms.map((form) => `<tr>
      <td><b>${escapeHtml(form.name)}</b><small>${escapeHtml(form.locale)}</small></td>
      <td><span class="sm-status" data-s="${escapeHtml(form.status)}">${form.status === "ACTIVE" ? "使用中" : form.status === "ARCHIVED" ? "已归档" : escapeHtml(form.status)}</span></td>
      <td class="num">${fmtNum(form.leadsCount)}</td><td>${fmtTime(form.createdAt)}</td>
      <td class="num"><button class="btn" type="button" data-sm-backfill="${escapeHtml(form.id)}">导入最近线索</button></td></tr>`).join("")}</tbody></table></div>`
      : emptyBlock("这个主页还没有线索表单", "在 Meta 广告管理工具里创建「潜在客户」目标的广告时会新建表单。");
  } catch (error) {
    const body = qs<HTMLElement>("#smFormsBody");
    if (body) body.innerHTML = emptyBlock("读取失败", error instanceof Error ? error.message : "Facebook 接口调用失败");
  }
}

// ---------- 入口 ----------
export async function renderSocialView(view: string) {
  bindSocialEvents();
  const box = root(view);
  if (!box) return;
  if (!overview) box.innerHTML = '<div class="sm-loading">读取中…</div>';
  try {
    await loadOverview(view === "social");
  } catch (error) {
    box.innerHTML = emptyBlock("读取失败", error instanceof Error ? error.message : "社媒数据读取失败");
    return;
  }
  if (view === "social") renderAccounts();
  else if (view === "social-pages") await renderPages();
  else if (view === "social-ads") await renderAds();
  else if (view === "social-forms") await renderForms();
}

function currentSocialView() {
  return qs<HTMLElement>(".view.active")?.id || "social";
}

function bindSocialEvents() {
  if (socialBound) return;
  socialBound = true;
  document.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest(".sm-root")) return;
    const copy = target.closest<HTMLElement>("[data-sm-copy]");
    if (copy) {
      await navigator.clipboard?.writeText(copy.dataset.smCopy || "").catch(() => undefined);
      toast("已复制");
      return;
    }
    const go = target.closest<HTMLElement>("[data-sm-go]");
    if (go?.dataset.smGo) { activateNavView(go.dataset.smGo); return; }
    if (target.closest("[data-sm-toggle-setup]")) {
      const setup = qs<HTMLElement>("#smSetup");
      if (setup) setup.hidden = !setup.hidden;
      return;
    }
    const pagePick = target.closest<HTMLElement>("[data-sm-page-pick]");
    if (pagePick?.dataset.smPagePick) { selectedPageId = pagePick.dataset.smPagePick; void renderSocialView(currentSocialView()); return; }
    const adPick = target.closest<HTMLElement>("[data-sm-ad-pick]");
    if (adPick?.dataset.smAdPick) { selectedAdAccountId = adPick.dataset.smAdPick; void renderAds(); return; }
    const chipPage = target.closest<HTMLElement>("[data-sm-page]");
    if (chipPage?.dataset.smPage) { selectedPageId = chipPage.dataset.smPage; activateNavView("social-pages"); return; }
    const chipAd = target.closest<HTMLElement>("[data-sm-ad]");
    if (chipAd?.dataset.smAd) { selectedAdAccountId = chipAd.dataset.smAd; activateNavView("social-ads"); return; }
    const button = target.closest<HTMLButtonElement>("button");
    if (!button) return;
    if (button.id === "smSaveApp") {
      setButtonPending(button, true, "保存应用配置", "保存中");
      try {
        await api("/api/social/meta/app", {
          method: "PUT",
          body: JSON.stringify({
            appId: qs<HTMLInputElement>("#smAppId")?.value.trim() || "",
            appSecret: qs<HTMLInputElement>("#smAppSecret")?.value.trim() || undefined,
            graphVersion: qs<HTMLInputElement>("#smGraphVersion")?.value.trim() || "v23.0",
            leadOwnerId: qs<HTMLSelectElement>("#smLeadOwner")?.value || ""
          })
        });
        toast("Meta 应用已保存");
        await loadOverview(true);
        renderAccounts();
      } catch (error) {
        toast(error instanceof Error ? error.message : "保存失败", "error");
      } finally {
        setButtonPending(button, false, "保存应用配置", "保存中");
      }
      return;
    }
    if (button.id === "smConnect") {
      setButtonPending(button, true, "连接 Facebook 账号", "正在跳转");
      try {
        const result = await api<{ url: string }>("/api/social/meta/oauth/start", { method: "POST" });
        window.location.assign(result.url);
      } catch (error) {
        toast(error instanceof Error ? error.message : "无法发起授权", "error");
        setButtonPending(button, false, "连接 Facebook 账号", "正在跳转");
      }
      return;
    }
    if (button.dataset.smRefresh) {
      setButtonPending(button, true, "刷新", "刷新中");
      try {
        await api(`/api/social/meta/connections/${encodeURIComponent(button.dataset.smRefresh)}/refresh`, { method: "POST" });
        await loadOverview(true);
        renderAccounts();
        toast("已从 Facebook 刷新主页和广告账户");
      } catch (error) {
        toast(error instanceof Error ? error.message : "刷新失败", "error");
        setButtonPending(button, false, "刷新", "刷新中");
      }
      return;
    }
    if (button.dataset.smDisconnect) {
      const connection = overview?.connections.find((item) => item.id === button.dataset.smDisconnect);
      if (!await confirmAction({
        title: "断开 Facebook 账号",
        message: "断开后 CRM 将无法再读取这个账号的主页、广告和表单线索。",
        detail: connection?.name || "",
        detailLabel: "账号",
        consequences: ["在 Facebook 端撤销本应用的授权", "删除 CRM 保存的访问令牌", "已经进入线索池的线索不受影响"],
        confirmLabel: "断开"
      })) return;
      try {
        const result = await api<{ message: string }>(`/api/social/meta/connections/${encodeURIComponent(button.dataset.smDisconnect)}`, { method: "DELETE" });
        toast(result.message);
        await loadOverview(true);
        renderAccounts();
      } catch (error) {
        toast(error instanceof Error ? error.message : "断开失败", "error");
      }
      return;
    }
    if (button.dataset.smSubscribe) {
      const on = button.dataset.smSubscribe === "1";
      setButtonPending(button, true, on ? "开启直连" : "关闭直连", on ? "开启中" : "关闭中");
      try {
        await api(`/api/social/meta/pages/${encodeURIComponent(selectedPageId)}/leadgen/subscribe`, { method: "POST", body: JSON.stringify({ subscribe: on }) });
        toast(on ? "表单线索直连已开启" : "表单线索直连已关闭");
        await loadOverview(true);
        await renderForms();
      } catch (error) {
        toast(error instanceof Error ? error.message : "操作失败", "error");
        setButtonPending(button, false, on ? "开启直连" : "关闭直连", on ? "开启中" : "关闭中");
      }
      return;
    }
    if (button.dataset.smBackfill) {
      setButtonPending(button, true, "导入最近线索", "导入中");
      try {
        const result = await api<{ total: number; created: number; duplicate: number; failed: number }>(`/api/social/meta/forms/${encodeURIComponent(button.dataset.smBackfill)}/backfill`, { method: "POST", body: JSON.stringify({ pageId: selectedPageId }) });
        toast(`读取 ${result.total} 条：新建 ${result.created} 条线索，已存在 ${result.duplicate} 条${result.failed ? `，失败 ${result.failed} 条` : ""}`, result.failed ? "error" : undefined);
        await loadOverview(true);
        await renderForms();
      } catch (error) {
        toast(error instanceof Error ? error.message : "导入失败", "error");
        setButtonPending(button, false, "导入最近线索", "导入中");
      }
    }
  });
  document.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    if (target.id === "smAdsRange") {
      adsRange = target.value;
      void renderAds();
    }
  });
}

/** Facebook 授权回来时 URL 带 ?social_oauth=…：提示结果并打开账号连接页 */
export function consumeSocialOAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("social_oauth");
  if (!status) return;
  const message = params.get("social_message") || "";
  params.delete("social_oauth");
  params.delete("social_message");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    if (document.body.classList.contains("is-authenticated") && state.user) {
      window.clearInterval(timer);
      overview = null;
      activateNavView("social");
      toast(status === "ok" ? message || "Facebook 账号已连接" : `Facebook 授权没有完成：${message}`, status === "ok" ? undefined : "error");
    } else if (tries > 40) window.clearInterval(timer);
  }, 500);
}

// ===========================================================================
// 消息推送中心（企业微信）
// ===========================================================================
interface WecomView {
  settings: { enabled: boolean; mode: "app" | "robot"; corpId: string; agentId: string; secretSet: boolean; robotSet: boolean; sendToOwner: boolean; recipients: string[]; rules: Record<string, boolean>; updatedAt: string; configured: boolean };
  canManage: boolean;
  log: Array<{ id: string; at: string; event: string; title: string; recipients: string; status: string; message: string }>;
  stats: { sent: number; failed: number; lastSentAt: string };
}

let wecomView: WecomView | null = null;
let notifyBound = false;

const RULES: Array<[string, string, string]> = [
  ["emailOpened", "开发信第一次被打开", "客户打开开发信时推送，同一封只推一次"],
  ["emailReopened", "开发信再次被打开", "隔 6 小时以上又打开时再推一次，说明对方在反复看"],
  ["emailClicked", "开发信里的链接被点击", "对方点了信里的链接"],
  ["emailReplied", "客户回信", "收到对开发信的回复时推送，附回信摘要"],
  ["leadAds", "新的 Facebook 表单线索", "广告表单（直连或中转）有新提交时推送"]
];

export async function renderNotifyCenter() {
  const box = qs<HTMLElement>("#notify-center .nc-root");
  if (!box) return;
  bindNotifyEvents();
  try {
    wecomView = await api<WecomView>("/api/notify/wecom");
  } catch (error) {
    box.innerHTML = emptyBlock("读取失败", error instanceof Error ? error.message : "推送配置读取失败");
    return;
  }
  const s = wecomView.settings;
  const can = wecomView.canManage;
  const dis = can ? "" : "disabled";
  // 第一次配置时预填接收人
  const recipients = s.configured ? s.recipients : (s.recipients.length ? s.recipients : ["huangguojia@longtec.com"]);
  box.innerHTML = `
    <header class="sm-head"><div><h1>消息推送</h1><p>把客户的关键动作实时推到企业微信：开发信被打开、客户回信、新的广告表单线索。</p></div>
      <div class="sm-head-actions"><span class="nc-state" data-on="${s.enabled ? "1" : "0"}">${s.enabled ? "推送中" : "未开启"}</span></div></header>
    <div class="nc-grid">
      <section class="sm-card nc-form">
        <h3>企业微信</h3>
        <label class="nc-switch"><input type="checkbox" id="ncEnabled" ${s.enabled ? "checked" : ""} ${dis}><span>开启推送</span></label>
        <div class="nc-mode" role="radiogroup" aria-label="推送方式">
          <label><input type="radio" name="ncMode" value="app" ${s.mode === "app" ? "checked" : ""} ${dis}><span><b>自建应用</b><small>推给指定的人（推荐）</small></span></label>
          <label><input type="radio" name="ncMode" value="robot" ${s.mode === "robot" ? "checked" : ""} ${dis}><span><b>群机器人</b><small>推到一个群里</small></span></label>
        </div>
        <div class="nc-fields" data-mode="app" ${s.mode === "app" ? "" : "hidden"}>
          <label><span>企业 ID（CorpID）</span><input id="ncCorpId" value="${escapeHtml(s.corpId)}" placeholder="ww 开头" ${dis}></label>
          <label><span>应用 AgentID</span><input id="ncAgentId" inputmode="numeric" value="${escapeHtml(s.agentId)}" placeholder="1000002" ${dis}></label>
          <label class="wide"><span>应用 Secret</span><input id="ncSecret" type="password" autocomplete="new-password" placeholder="${s.secretSet ? "已保存，留空不修改" : "应用详情页里的 Secret"}" ${dis}></label>
          <label class="wide"><span>接收人 <small>一行一个，写企业微信绑定的邮箱或成员账号</small></span><textarea id="ncRecipients" rows="3" ${dis}>${escapeHtml(recipients.join("\n"))}</textarea></label>
          <label class="nc-check wide"><input type="checkbox" id="ncOwner" ${s.sendToOwner ? "checked" : ""} ${dis}><span>同时推给负责这封信 / 这条线索的业务员本人（按 CRM 登录邮箱匹配）</span></label>
        </div>
        <div class="nc-fields" data-mode="robot" ${s.mode === "robot" ? "" : "hidden"}>
          <label class="wide"><span>群机器人 Webhook 地址</span><input id="ncRobot" type="password" autocomplete="off" placeholder="${s.robotSet ? "已保存，留空不修改" : "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"}" ${dis}></label>
        </div>
        <h4>推送哪些消息</h4>
        <div class="nc-rules">${RULES.map(([key, label, note]) => `<label><input type="checkbox" data-nc-rule="${key}" ${s.rules[key] ? "checked" : ""} ${dis}><span><b>${label}</b><small>${note}</small></span></label>`).join("")}</div>
        ${can ? `<div class="sm-actions"><button class="btn primary" type="button" id="ncSave">保存</button><button class="btn" type="button" id="ncTest">发送测试消息</button></div><p class="nc-result" id="ncResult" hidden></p>` : '<p class="sm-note">只有管理员可以修改推送配置。</p>'}
      </section>
      <aside class="sm-card nc-guide">
        <h3>怎么拿到这几项</h3>
        <ol class="sm-steps">
          <li>企业微信管理后台 → <b>我的企业</b>，页面最下方的「企业ID」就是 CorpID。</li>
          <li><b>应用管理 → 自建 → 创建应用</b>（例如叫「CRM 提醒」），可见范围选上要接收消息的人。创建后在应用详情里能看到 AgentId 和 Secret（Secret 要在企业微信里点「查看」才发给你）。</li>
          <li>同一个应用详情页往下，找到 <b>企业可信 IP</b>，填上 CRM 服务器的公网 IP。不填会报 60020，消息发不出去。</li>
          <li>接收人写他在企业微信里绑定的邮箱（例如 huangguojia@longtec.com）。邮箱查不到成员时，改写成员账号（通讯录里成员详情的「账号」）。</li>
          <li>保存后点「发送测试消息」，手机企业微信收到就说明通了。</li>
        </ol>
        <p class="sm-note">群机器人更简单：在企业微信群里添加机器人，复制 Webhook 地址填进来即可，不需要可信 IP，但只能推到群里。</p>
      </aside>
    </div>
    <h3 class="sm-sub">推送记录 <small>成功 ${wecomView.stats.sent} 条，失败 ${wecomView.stats.failed} 条</small></h3>
    ${wecomView.log.length ? `<div class="sm-table-wrap"><table class="sm-table"><thead><tr><th>时间</th><th>消息</th><th>接收人</th><th>结果</th><th>说明</th></tr></thead><tbody>${wecomView.log.map((item) => `<tr>
      <td>${fmtTime(item.at)}</td><td><b>${escapeHtml(item.title)}</b></td><td>${escapeHtml(item.recipients)}</td>
      <td><span class="sm-status" data-s="${item.status === "sent" ? "ACTIVE" : "DISAPPROVED"}">${item.status === "sent" ? "已送达" : "失败"}</span></td>
      <td>${escapeHtml(item.message)}</td></tr>`).join("")}</tbody></table></div>` : emptyBlock("还没有推送记录", "开启后，开发信被打开、客户回信等消息推送后会记录在这里。")}`;
}

function notifyPayload() {
  const mode = (document.querySelector<HTMLInputElement>('input[name="ncMode"]:checked')?.value || "app") as "app" | "robot";
  const rules: Record<string, boolean> = {};
  document.querySelectorAll<HTMLInputElement>("[data-nc-rule]").forEach((input) => { rules[input.dataset.ncRule || ""] = input.checked; });
  return {
    enabled: Boolean(qs<HTMLInputElement>("#ncEnabled")?.checked),
    mode,
    corpId: qs<HTMLInputElement>("#ncCorpId")?.value.trim() || "",
    agentId: qs<HTMLInputElement>("#ncAgentId")?.value.trim() || "",
    secret: qs<HTMLInputElement>("#ncSecret")?.value.trim() || undefined,
    robotWebhook: qs<HTMLInputElement>("#ncRobot")?.value.trim() || undefined,
    sendToOwner: Boolean(qs<HTMLInputElement>("#ncOwner")?.checked),
    recipients: (qs<HTMLTextAreaElement>("#ncRecipients")?.value || "").split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean),
    rules
  };
}

function bindNotifyEvents() {
  if (notifyBound) return;
  notifyBound = true;
  document.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.name !== "ncMode") return;
    document.querySelectorAll<HTMLElement>(".nc-fields").forEach((box) => { box.hidden = box.dataset.mode !== target.value; });
  });
  document.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("#ncSave, #ncTest");
    if (!button) return;
    const result = qs<HTMLElement>("#ncResult");
    const show = (text: string, ok: boolean) => {
      if (!result) return;
      result.hidden = false;
      result.textContent = text;
      result.dataset.ok = ok ? "1" : "0";
    };
    if (button.id === "ncSave") {
      setButtonPending(button, true, "保存", "保存中");
      try {
        await api("/api/notify/wecom", { method: "PUT", body: JSON.stringify(notifyPayload()) });
        toast("推送配置已保存");
        await renderNotifyCenter();
      } catch (error) {
        show(error instanceof Error ? error.message : "保存失败", false);
        setButtonPending(button, false, "保存", "保存中");
      }
      return;
    }
    setButtonPending(button, true, "发送测试消息", "发送中");
    try {
      // 先保存当前填写，再测试，避免「改了没保存就测」测的是旧配置
      await api("/api/notify/wecom", { method: "PUT", body: JSON.stringify(notifyPayload()) });
      const sent = await api<{ ok: boolean; message: string; failed: Array<{ recipient: string; reason: string }> }>("/api/notify/wecom/test", { method: "POST" });
      show(`${sent.message}${sent.failed?.length ? `；未送达：${sent.failed.map((item) => `${item.recipient}（${item.reason}）`).join("、")}` : ""}`, sent.ok);
    } catch (error) {
      show(error instanceof Error ? error.message : "测试发送失败", false);
    } finally {
      setButtonPending(button, false, "发送测试消息", "发送中");
    }
  });
}
