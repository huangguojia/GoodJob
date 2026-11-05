/**
 * 邮件中心。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, confirmAction, openModal, state } from "../prototype-api";
import { escapeHtml, qs, qsa } from "./shared";
import { openCustomerDetailPage } from "./customer-detail";
import { api, setButtonPending, toast } from "./ui";
import { openLead } from "./leads";
import {
  MC_FOLDERS, MC_REPLY_CLASSIFICATION, MC_SOURCE_LABEL, type MailAssistAction, type MailCenterAccount,
  type MailCenterCustomerDetail, type MailCenterCustomerItem, type MailCenterJourney, type MailCenterJourneyEndpoint,
  type MailCenterJourneyEvent, type MailCenterMessage, type MailCenterTab, type MailCenterTool,
  type MailCenterToolSection, mailCenterState, mcAvatar, mcDateTime, mcEmpty, mcGuessSmtpHost, mcIcon, mcRelativeTime,
  mcSyncIntervalLabel, mcSyncTone
} from "./email-return-flow";

// ── 渲染 ────────────────────────────────────────────────────────────────────

/**
 * 邮件中心的二级导航。
 *
 * 以前跟邮箱有关的东西散在三处：邮箱账号配置在「个人设置」，发信批次 / 自动发信挂在
 * 「客户管理」，收件箱在「邮件中心」。结果就是——配完邮箱不知道去哪发信，发信出了问题
 * 也不知道该回哪个页面看。现在统一成一条二级导航，四个视图共用同一份条目：
 *  · 收件箱 / 客户速查 / 交互旅程 / 工具箱 → 都是 #mail-center 内部页签
 *  · 自动发信 / 发信明细                 → 各自的独立视图（内容各自很重，不塞进一个页面）
 *  · 邮箱设置                            → 原来个人设置里的邮箱面板，整块搬过来
 */
type MailSectionItem = {
  key: string;
  label: string;
  icon: string;
  view: string;
  /** 只有 view 是 mail-center 时才有：定位到哪个内部页签 */
  tab?: MailCenterTab;
  /** 收尾的齿轮位（配置类，不在主流程里） */
  gear?: boolean;
};

export const MAIL_SECTION_ITEMS: MailSectionItem[] = [
  { key: "inbox", label: "收件箱", icon: "inbox", view: "mail-center", tab: "inbox" },
  { key: "outreach-batches", label: "自动发信", icon: "send", view: "outreach-batches" },
  { key: "outreach-journey", label: "发信明细", icon: "chart", view: "outreach-journey" },
  { key: "lookup", label: "客户速查", icon: "user", view: "mail-center", tab: "lookup" },
  { key: "journey", label: "交互旅程", icon: "route", view: "mail-center", tab: "journey" },
  { key: "toolbox", label: "工具箱", icon: "grid", view: "mail-center", tab: "toolbox" },
  { key: "mail-settings", label: "邮箱设置", icon: "gear", view: "mail-settings", gear: true }
];

/** 当前停在这一节的哪一项：侧栏高亮与二级导航的选中态都读它 */
function mailSectionKey(): string {
  const activeView = qs<HTMLElement>(".view.active")?.id || "";
  if (activeView === "mail-center") return mailCenterState.tab;
  return activeView;
}

export function renderMailSectionNav() {
  const current = mailSectionKey();
  qsa<HTMLElement>(".mail-section-nav").forEach((nav) => {
    const tabs = MAIL_SECTION_ITEMS.filter((item) => !item.gear).map((item) => {
      const unread = item.key === "inbox" ? mcInboxTotal() : 0;
      return `<button type="button" class="msn-tab ${item.key === current ? "is-active" : ""}" data-msn="${item.key}" role="tab" aria-selected="${item.key === current}">${mcIcon(item.icon)}${escapeHtml(item.label)}${unread ? `<em>${unread > 99 ? "99+" : unread}</em>` : ""}</button>`;
    }).join("");
    const gear = MAIL_SECTION_ITEMS.find((item) => item.gear)!;
    nav.innerHTML = `<div class="msn-tabs" role="tablist" aria-label="邮件中心">${tabs}</div><span class="msn-spacer"></span><button type="button" class="msn-gear ${gear.key === current ? "is-active" : ""}" data-msn="${gear.key}">${mcIcon(gear.icon)}${escapeHtml(gear.label)}</button>`;
    // 用 onclick 赋值而不是 addEventListener：导航每次切页都会重渲染，
    // addEventListener 会一层层叠上去，点一次触发 N 次
    nav.onclick = (event) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-msn]");
      if (!button) return;
      openMailSection(button.dataset.msn || "");
    };
  });
}

function openMailSection(key: string) {
  const item = MAIL_SECTION_ITEMS.find((entry) => entry.key === key);
  if (!item) return;
  if (item.view === "mail-center") {
    openMailCenterTab(item.tab || "inbox");
    return;
  }
  activateNavView(item.view);
}

/** 邮件中心内部换页签：已经在邮件中心就只换页签，别把整个视图重载一遍 */
function openMailCenterTab(tab: MailCenterTab) {
  const inMailCenter = qs<HTMLElement>(".view.active")?.id === "mail-center";
  if (!inMailCenter) {
    mailCenterState.tab = tab;
    activateNavView("mail-center");
    return;
  }
  if (mailCenterState.tab === tab) {
    renderMailSectionNav();
    return;
  }
  mailCenterState.tab = tab;
  renderMailCenterPage();
  renderMailSectionNav();
  if (tab === "inbox") void loadMailCenterMessages({ silent: true });
  if (tab === "lookup" || tab === "journey") void loadMailCenterLookup({ silent: true });
}

function renderMailCenterPage() {
  const page = qs<HTMLElement>("#mailCenterPage");
  if (!page) return;
  // 只有收件箱以外的页签才有悬浮「看邮箱」，也才需要给它留 96px 底边距；
  // 收件箱无条件留 96px 就是纯空白（用户截图吐槽过「下面留这么多空白」）。
  page.className = mailCenterState.tab === "inbox" ? "mc-page" : "mc-page has-fab";
  page.innerHTML = `
    <header class="mc-head">
      <div class="mc-head-main">
        <span class="mc-head-badge">${mcIcon("mail")}</span>
        <div class="mc-head-text">
          <h1>邮件中心</h1>
          <p>收邮件、发开发信、查客户往来、配发件邮箱——都在这一节里</p>
        </div>
      </div>
      <div class="mc-head-actions">
        <span class="mc-sync-state ${mailCenterState.syncing ? "is-warn" : ""}"><i></i>${mailCenterState.syncing ? "正在同步邮箱…" : "自动同步已开启"}</span>
        <button class="btn primary" type="button" data-mc-action="compose">${mcIcon("pen")} 写邮件</button>
        <button class="btn" type="button" data-mc-action="add-account">绑定邮箱</button>
        <button class="btn" type="button" data-mc-action="sync-all" ${mailCenterState.syncing ? "disabled" : ""}>立即同步全部</button>
      </div>
    </header>
    <div class="mc-accounts" id="mcAccountList">${renderMailCenterAccounts()}</div>
    <div id="mcTabBody"></div>
    <div id="mcAssistant"></div>
    ${mailCenterState.tab === "inbox" ? "" : `<button class="mc-mail-fab" type="button" data-mc-action="open-mailbox" aria-label="看邮箱，回到收件箱">
      <span class="mc-mail-fab-mark">${mcIcon("inbox")}${mcInboxUnread() ? `<i>${mcInboxUnread() > 99 ? "99+" : mcInboxUnread()}</i>` : ""}</span>
      <span class="mc-mail-fab-text">看邮箱</span>
    </button>`}
  `;
  renderMailCenterTabBody();
  renderMailCenterAssist();
  bindMailCenterPage();
  // 页签栏已经上移到视图顶部（跨视图共用的二级导航），这里只管把选中态刷新一下
  renderMailSectionNav();
}

/** 悬浮「看邮箱」：不管当前在哪个页签，一键回收到收件箱，并把以前的筛选清干净 */
function openMailCenterMailbox() {
  const reset = mailCenterState.tab !== "inbox"
    || mailCenterState.folder !== "inbox"
    || Boolean(mailCenterState.direction || mailCenterState.keyword || mailCenterState.activeMessageId);
  mailCenterState.tab = "inbox";
  mailCenterState.folder = "inbox";
  mailCenterState.direction = "";
  mailCenterState.keyword = "";
  mailCenterState.activeMessageId = "";
  mailCenterState.activeMessage = null;
  if (reset) renderMailCenterPage();
  void loadMailCenterMessages({ silent: true }).then(() => {
    // 从工具箱/旅程跳回来时页面往往停在下方，把列表带回视野
    qs<HTMLElement>("#mcMessageList")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function renderMailCenterAccounts() {
  if (!mailCenterState.accounts.length) {
    return `<div class="mc-account-add is-first" data-mc-action="add-account" role="button" tabindex="0">
      <b>+</b><span>绑定第一个邮箱，开始同步收件</span>
    </div>`;
  }
  const cards = mailCenterState.accounts.map((account, index) => {
    const tone = mcSyncTone(account);
    const active = mailCenterState.activeAccountId === account.id;
    const error = account.lastSyncStatus === "error" && account.lastSyncError
      ? `<div class="mc-account-error">${escapeHtml(account.lastSyncError.slice(0, 160))}</div>` : "";
    return `<article class="mc-account ${account.syncEnabled ? "" : "is-off"} ${active ? "is-active" : ""}" style="--mc-i:${index}"
      data-mc-account-select="${escapeHtml(account.id)}" role="button" tabindex="0"
      aria-pressed="${active ? "true" : "false"}"
      title="${active ? "再点一次回到全部邮箱" : "只看这个邮箱的邮件"}">
      <div class="mc-account-top">
        <span class="mc-account-face">
          ${mcAvatar(account.label || account.email, account.email)}
          <i class="mc-account-dot ${tone.cls}"></i>
        </span>
        <div class="mc-account-name">
          <b>${escapeHtml(account.label || account.email)}</b>
          <span>${escapeHtml(account.email)}</span>
        </div>
        <button class="mc-acc-edit" type="button" data-mc-account-action="edit" data-mc-account="${escapeHtml(account.id)}" title="编辑账号" aria-label="编辑账号">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h3.6L18 9.6a2.4 2.4 0 0 0-3.6-3.6L4 16.4z"/><path d="m13.4 7 3.6 3.6"/></svg>
          <span>编辑</span>
        </button>
      </div>
      <div class="mc-account-figs">
        <span><b>${account.totalMessages}</b><i>邮件</i></span>
        <span class="${account.unreadMessages ? "is-hot" : ""}"><b>${account.unreadMessages}</b><i>未读</i></span>
        <span><b>${account.matchedMessages}</b><i>已归属</i></span>
      </div>
      ${error}
      <div class="mc-account-foot">
        <span>${account.syncEnabled ? mcSyncIntervalLabel(account.syncIntervalMinutes) : "已暂停同步"} · ${escapeHtml(tone.text)}</span>
        <span class="mc-mini">
          <button type="button" data-mc-account-action="sync" data-mc-account="${escapeHtml(account.id)}" ${mailCenterState.syncing === account.id ? "disabled" : ""}>同步</button>
          <button type="button" data-mc-account-action="check" data-mc-account="${escapeHtml(account.id)}" ${mailCenterState.syncing === account.id ? "disabled" : ""}>体检</button>
        </span>
      </div>
    </article>`;
  }).join("");
  const add = mailCenterState.accounts.length < 10
    ? `<div class="mc-account-add" data-mc-action="add-account" role="button" tabindex="0"><b>+</b><span>再绑定一个邮箱</span></div>`
    : "";
  return cards + add;
}

function mcFolderLabel(kind: string) {
  return MC_FOLDERS.find((item) => item.kind === kind)?.label || "收件箱";
}

/** 与后端 `MAIL_SOURCE_LIMIT` 对齐：单封最多同步前 2MB 正文 */
const MC_SOURCE_LIMIT = 2 * 1024 * 1024;

const MC_ENTITY_MAP: Record<string, string> = {  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", mdash: "—",
  ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·"
};

/**
 * 邮件摘要/正文里常带着发信端的 HTML 实体（`&nbsp;` 尤其多）。
 * 直接渲染会在列表里露出一串 `&nbsp;`，读起来像乱码，所以先还原成普通文本。
 */
function mcPlainText(value: string) {
  return String(value || "").replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#")) {
      const hex = name[1] === "x" || name[1] === "X";
      const code = Number.parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return MC_ENTITY_MAP[name.toLowerCase()] ?? whole;
  });
}

/** 顶部「收件箱」页签上的数字永远取收件箱文件夹的总数，不跟着当前所在文件夹变 */
function mcInboxTotal() {  const inbox = mailCenterState.folders.find((folder) => folder.kind === "inbox");
  return Number(inbox?.total ?? 0);
}

/** 收件箱未读数：悬浮「看邮箱」上的角标，别用全部账号相加（会把已发送算进去） */
function mcInboxUnread() {
  const inbox = mailCenterState.folders.find((folder) => folder.kind === "inbox");
  return Number(inbox?.unread ?? 0);
}

function refreshMailCenterInboxTab() {
  // 收件箱数字现在挂在二级导航上（页签栏已上移），同步完只重画导航和悬浮角标，
  // 不能整页重绘——那会把用户正在读的那封信、滚动位置全清掉。
  renderMailSectionNav();
  const mark = qs<HTMLElement>(".mc-mail-fab-mark");
  if (mark) {
    const unread = mcInboxUnread();
    mark.innerHTML = `${mcIcon("inbox")}${unread ? `<i>${unread > 99 ? "99+" : unread}</i>` : ""}`;
  }
}

function renderMailCenterFolderTabs() {
  return MC_FOLDERS.map((item) => {
    const stat = mailCenterState.folders.find((folder) => folder.kind === item.kind);
    const total = Number(stat?.total || 0);
    const unread = Number(stat?.unread || 0);
    return `<button class="mc-folder ${mailCenterState.folder === item.kind ? "is-active" : ""}" type="button"
      role="tab" aria-selected="${mailCenterState.folder === item.kind}" data-mc-folder="${item.kind}">
      ${mcIcon(item.icon)}<span>${item.label}</span>${total ? `<em>${total}</em>` : ""}${unread ? `<i class="mc-folder-dot" title="${unread} 封未读"></i>` : ""}
    </button>`;
  }).join("");
}

/**
 * 收件箱两栏刚好填满可视高度：列表与详情各自内部滚动，而不是在下面留一大片空白。
 *
 * 为什么用 JS 量而不是纯 CSS：这一栏顶部到底有多高，取决于窗口宽度（账号条会换行）、
 * 有没有多账号提示条等等。写死 `calc(100vh - Npx)` 一旦换行就差几十像素，
 * 差的那几十像素要么变成空白、要么把整页顶出一条滚动条。
 */
let mailCenterHeightBound = false;

/**
 * 从某个元素往上直到滚动容器，中间所有祖先的「底边留白」之和。
 *
 * 坑：这一栏不是 `.main` 的直接子元素，外面还套着 `.workspace`，而它的
 * `padding-bottom` 有 24~28px。只减 `.main` 的 padding（0px）就会让两栏
 * 压到 workspace 的内边距之下，整页顶出一条小滚动条——实测正好多出 20px。
 */
function mailCenterBottomInset(from: HTMLElement, stop: HTMLElement): number {
  let inset = 0;
  let node: HTMLElement | null = from;
  while (node && node !== stop) {
    const style = getComputedStyle(node);
    inset += (Number.parseFloat(style.paddingBottom) || 0) + (Number.parseFloat(style.marginBottom) || 0);
    node = node.parentElement;
  }
  if (node === stop) inset += Number.parseFloat(getComputedStyle(stop).paddingBottom) || 0;
  return inset;
}

function syncMailCenterColumnHeight() {
  const inbox = qs<HTMLElement>(".mc-inbox");
  const main = qs<HTMLElement>(".main");
  if (!inbox || !main) return;
  // 整行高度 = 可视高度 − 这一行顶部在滚动容器里的位置 − 下方全部留白。
  // 用「相对滚动容器」的偏移，页面已经往下滚过也不会算错。
  const topInMain = inbox.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
  const inset = mailCenterBottomInset(inbox, main);
  // 下限 240：再往下两栏都只剩一条缝；窗口实在太矮时宁可整页滚一点
  const available = Math.max(240, Math.round(main.clientHeight - topInMain - inset));
  inbox.style.setProperty("--mc-inbox-h", `${available}px`);
}

function bindMailCenterHeightSync() {
  if (mailCenterHeightBound) return;
  mailCenterHeightBound = true;
  window.addEventListener("resize", () => {
    if (mailCenterState.tab !== "inbox") return;
    // 窗口一变宽账号卡会重新换行，量第一帧拿到的是回流前的旧高度（实测差 23px，
    // 多出来的就成了底部空白），所以跟首次渲染一样补量一次
    syncMailCenterColumnHeight();
    window.setTimeout(syncMailCenterColumnHeight, 350);
  });
}

function renderMailCenterTabBody() {
  const body = qs<HTMLElement>("#mcTabBody");
  if (!body) return;
  // 重绘页签体会连阅读栏一起重建：正在写的信先落一次草稿，别丢最后几百毫秒的输入
  // （就地回复和阅读栏写信区都算——两者都长在这个会被换掉的 body 里）
  if (document.getElementById("mcComposePane") || document.getElementById("mcComposeInline")) mcComposeDraftSaveNow();
  // 重建会把写信界面整个抹掉，专注态必须同时撤：不然账号统计条一直藏着不回来（实测切「已发送」后复现）
  mcFocusWriting(false);
  if (mailCenterState.tab === "inbox") {
    const scope = mailCenterState.activeAccountId
      ? mailCenterState.accounts.find((account) => account.id === mailCenterState.activeAccountId)
      : null;
    body.innerHTML = `
      <div class="mc-inbox">
        <section class="mc-panel">
          <div class="mc-panel-head">
            <b id="mcFolderTitle">${escapeHtml(mcFolderLabel(mailCenterState.folder))}</b>
            <span class="mc-panel-count" id="mcInboxCount">${mailCenterState.total} 封</span>
            ${scope ? `<button class="mc-scope" type="button" data-mc-action="clear-account" title="清除邮箱筛选，回到全部邮箱">
              <i></i><span class="mc-scope-name">只看 ${escapeHtml(scope.label || scope.email)}</span><span class="mc-scope-x" aria-hidden="true">×</span>
            </button>` : ""}
            <span class="mc-grow"></span>
            <button class="mc-mini" type="button" data-mc-action="refresh">刷新</button>
          </div>
          <div class="mc-folders" role="tablist" aria-label="邮件文件夹">
            ${renderMailCenterFolderTabs()}
          </div>
          <div class="mc-filters">
            <select data-mc-filter="mailbox" aria-label="邮箱账号">
              <option value="">全部邮箱</option>
              ${mailCenterState.accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${mailCenterState.activeAccountId === account.id ? "selected" : ""}>${escapeHtml(account.label || account.email)}</option>`).join("")}
            </select>
            ${mailCenterState.folder === "sent" ? "" : `<select data-mc-filter="direction" aria-label="收发方向">
              <option value="">全部方向</option>
              <option value="inbound" ${mailCenterState.direction === "inbound" ? "selected" : ""}>只看客户来信</option>
              <option value="outbound" ${mailCenterState.direction === "outbound" ? "selected" : ""}>只看发出</option>
            </select>`}
            <input id="mcMessageSearch" placeholder="搜主题、发件人、正文摘要" value="${escapeHtml(mailCenterState.keyword)}" autocomplete="off">
          </div>
          <div class="mc-msg-list" id="mcMessageList"></div>
        </section>
        <section class="mc-panel mc-detail" id="mcMessageDetail"></section>
      </div>`;
    renderMailCenterMessageList();
    renderMailCenterMessageDetail();
    bindMailCenterHeightSync();
    // 量两次：账号卡 / 邮件行排完版后高度会再变一次（1280 宽时尤其明显），
    // 只量一帧会差出几十像素，正好把整页顶出一条滚动条
    requestAnimationFrame(() => {
      syncMailCenterColumnHeight();
      window.setTimeout(syncMailCenterColumnHeight, 350);
    });
    return;
  }
  if (mailCenterState.tab === "lookup") {
    body.innerHTML = `
      <div class="mc-lookup">
        <div class="mc-searchbar">
          ${mcIcon("search")}
          <input id="mcLookupSearch" placeholder="输入客户公司、联系人或邮箱，例如 longtec、alice@…" value="${escapeHtml(mailCenterState.lookupKeyword)}" autocomplete="off">
          <span class="mc-hint">选中客户即可看到邮箱与全部回复</span>
        </div>
        <div class="mc-lookup-grid">
          <section class="mc-panel">
            <div class="mc-panel-head"><b>客户</b><span class="mc-grow"></span><span style="color:#94a3b6;font-size:11px">有往来优先</span></div>
            <div id="mcLookupList"></div>
          </section>
          <section class="mc-panel" id="mcLookupDetail"></section>
        </div>
      </div>`;
    renderMailCenterLookupList();
    renderMailCenterLookupDetail();
    return;
  }
  if (mailCenterState.tab === "journey") {
    body.innerHTML = `
      <div class="mc-lookup">
        <div class="mc-searchbar">
          ${mcIcon("route")}
          <input id="mcJourneySearch" placeholder="搜索客户，生成与他的完整交互时间线" value="${escapeHtml(mailCenterState.lookupKeyword)}" autocomplete="off">
          <span class="mc-hint">${escapeHtml(mailCenterJourneyHint())}</span>
        </div>
        <div class="mc-lookup-grid">
          <section class="mc-panel">
            <div class="mc-panel-head"><b>选择客户</b><span class="mc-grow"></span></div>
            <div id="mcJourneyList"></div>
          </section>
          <section class="mc-panel" id="mcJourneyDetail"></section>
        </div>
      </div>`;
    renderMailCenterJourneyList();
    renderMailCenterJourneyDetail();
    return;
  }
  renderMailCenterToolbox();
}

function renderMailCenterMessageList() {
  const list = qs<HTMLElement>("#mcMessageList");
  if (!list) return;
  if (mailCenterState.loading) {
    list.innerHTML = mcEmpty("正在加载邮件…", "首次同步需要连接邮箱服务器，稍等几秒");
    return;
  }
  if (!mailCenterState.messages.length) {
    if (!mailCenterState.accounts.length) {
      list.innerHTML = mcEmpty(
        "还没有绑定邮箱",
        "绑定后每个邮箱会按自己的频率自动收件",
        `<button class="btn primary" type="button" data-mc-action="add-account">绑定邮箱</button>`
      );
      return;
    }
    // 文件夹是空的很正常（比如从没删过信），别拿「还没同步」去糊弄
    const empty: Record<string, [string, string]> = {
      inbox: ["收件箱还没有邮件", "点上方「刷新」，或检查同步频率与 IMAP 配置"],
      sent: ["已发送还没有邮件", "同步只拉最近 7 天；更早的信可在邮箱网页端查看"],
      trash: ["垃圾箱是空的", "同步只拉最近 7 天；更早删除的信可在邮箱网页端查看"],
      junk: ["没有垃圾邮件", "被邮箱判为垃圾的来信会出现在这里"]
    };
    const [title, hint] = empty[mailCenterState.folder] || ["这个文件夹没有邮件", "换个文件夹看看"];
    list.innerHTML = mcEmpty(title, hint);
    return;
  }
  list.innerHTML = mailCenterState.messages.map((message, index) => {
    const isInbound = message.direction === "inbound";
    const matched = message.entityType ? `<span class="mc-chip">已归属客户</span>` : "";
    const faceText = isInbound ? (message.fromName || message.fromAddress) : (message.toAddresses[0] || "我");
    const faceSeed = isInbound ? (message.fromAddress || faceText) : (message.toAddresses[0] || message.mailboxEmail);
    return `<button class="mc-msg ${mailCenterState.activeMessageId === message.id ? "is-active" : ""} ${mailCenterState.locatedMessageId === message.id ? "is-located" : ""} ${message.readAt ? "" : "is-unread"}" type="button" data-mc-message="${escapeHtml(message.id)}" style="--mc-i:${index}">
      <span class="mc-msg-av">
        ${mcAvatar(faceText, faceSeed)}
        <i class="mc-msg-dir ${isInbound ? "is-in" : "is-out"}">${isInbound ? "↓" : "↑"}</i>
      </span>
      <span class="mc-msg-main">
        <span class="mc-msg-subject"><b>${escapeHtml(message.subject || "(无主题)")}</b></span>
        <span class="mc-msg-meta">${escapeHtml(isInbound ? (message.fromName || message.fromAddress) : `发给 ${message.toAddresses[0] || "—"}`)}${matched}</span>
        <span class="mc-msg-snippet">${escapeHtml(mcPlainText(message.snippet) || "（无正文摘要）")}</span>
      </span>
      <span class="mc-msg-time">${mcRelativeTime(message.sentAt)}</span>
    </button>`;
  }).join("");
}

/* ===== 回复 / 全部回复 / 转发：预填与引用块 ===== */

type McComposeMode = "reply" | "replyAll" | "forward";

/** 主题前缀：已带同类前缀（Re:/Fwd:）不重复叠 */
function mcThreadSubject(subject: string, prefix: "Re" | "Fwd") {
  const base = subject.trim();
  if (!base) return prefix === "Re" ? "(无主题)" : base;
  if (prefix === "Re") return /^re(\[\d+\])?\s*:/i.test(base) ? base : `Re: ${base}`;
  return /^fw[d]?(\[\d+\])?\s*:/i.test(base) ? base : `Fwd: ${base}`;
}

/** 引用正文块（全部内联样式，发出后版式仍在；转义原文防注入） */
function mcQuoteBodyHtml(message: MailCenterMessage) {
  const lines = String(message.bodyText || message.snippet || "").replace(/\r/g, "").split("\n");
  const html = lines.map((line) => (line.trim() ? `${escapeHtml(line)}<br>` : "<br>")).join("");
  return `<div style="margin-top:8px;padding:2px 0 2px 12px;border-left:3px solid #dfe7f2;color:#3d4d66">${html || "<br>"}</div>`;
}

/** 回复引用：标准「在 xx 写道：」引头 */
function mcReplyQuoteHtml(message: MailCenterMessage) {
  const who = message.fromName || message.fromAddress;
  return `<div style="margin-top:14px;padding-top:8px;border-top:1px solid #dfe7f2;font-size:13px;color:#7b8aa0">在 ${escapeHtml(mcDateTime(message.sentAt))}，${escapeHtml(who)} &lt;${escapeHtml(message.fromAddress)}&gt; 写道：</div>${mcQuoteBodyHtml(message)}`;
}

/** 转发引用：转发邮件头 + 正文 */
function mcForwardQuoteHtml(message: MailCenterMessage) {
  const row = (label: string, value: string) => `<div style="margin:2px 0"><span style="color:#7b8aa0">${label}</span>${escapeHtml(value || "—")}</div>`;
  return `<div style="margin-top:14px;padding-top:8px;border-top:1px solid #dfe7f2;font-size:13px;color:#3d4d66"><div style="color:#7b8aa0;margin-bottom:4px">---------- 转发邮件 ----------</div>${row("发件人：", `${message.fromName || ""} ${message.fromAddress}`.trim())}${row("日期：", mcDateTime(message.sentAt))}${row("主题：", message.subject || "(无主题)")}${row("收件人：", message.toAddresses.join(", "))}${message.ccAddresses.length ? row("抄送：", message.ccAddresses.join(", ")) : ""}${mcQuoteBodyHtml(message)}</div>`;
}

/** 由一封已有邮件算出回复/全部回复/转发的预填（收件人、主题、引用、线程头、发件邮箱） */
function mcComposePrefillForMessage(message: MailCenterMessage, mode: McComposeMode) {
  const ownAddresses = mailCenterState.accounts.map((item) => (item.email || "").trim().toLowerCase()).filter(Boolean);
  const isOwnAddress = (addr: string) => ownAddresses.includes(addr.trim().toLowerCase());
  const inbound = message.direction === "inbound";
  // 回自己发出的信 → 回到原收件人；回客户来信 → 回到发件人
  const primary = (inbound ? message.fromAddress : message.toAddresses[0] || message.fromAddress).trim();
  let cc = "";
  if (mode === "replyAll" && primary) {
    const pool = inbound
      ? [...message.toAddresses, ...message.ccAddresses]
      : [...message.toAddresses.slice(1), ...message.ccAddresses];
    cc = Array.from(new Set(pool.map((item) => item.trim()).filter((item) =>
      item && !isOwnAddress(item) && item.toLowerCase() !== primary.toLowerCase()))).join(", ");
  }
  return {
    // 转发不预填收件人（转发对象由用户自己挑）；回复/全部回复才回到 primary
    to: mode === "forward" ? "" : primary,
    cc,
    subject: mode === "forward" ? mcThreadSubject(message.subject, "Fwd") : mcThreadSubject(message.subject, "Re"),
    quoteHtml: mode === "forward" ? mcForwardQuoteHtml(message) : mcReplyQuoteHtml(message),
    // 线程链：references = 原信引用链 + 原信自身 Message-ID
    inReplyTo: (message.messageId || "").trim(),
    references: [message.inReplyTo || "", message.messageId || ""].map((item) => item.trim()).filter(Boolean).join(" "),
    mailboxId: message.mailboxId
  };
}

/** 纯文本正文里的 URL / 邮箱变可点链接（先转义再 linkify，单趟替换不会互相嵌套） */
function mcLinkifyPlainText(text: string) {
  return text.replace(/(https?:\/\/[^\s<>"')\]]+|[\w.+-]+@[\w-]+\.[\w.-]{2,})/g, (match) => {
    if (/^https?:/i.test(match)) return `<a href="${match}" target="_blank" rel="noopener noreferrer">${match}</a>`;
    return `<a href="mailto:${match}">${match}</a>`;
  });
}

function renderMailCenterMessageDetail() {
  const detail = qs<HTMLElement>("#mcMessageDetail");
  if (!detail) return;
  // 写邮件占着阅读栏时，后台刷新（同步/未读角标/列表重载）不能把写信区抹掉；
  // 主动关闭或换信都会先走 closeComposeDrawer，那时这里已经没有 pane。
  if (document.getElementById("mcComposePane")) return;
  const message = mailCenterState.activeMessage;
  // 就地回复开着时：同一封信的静默重渲染别把编辑器抹了；换了信就收起回复
  const inline = document.getElementById("mcComposeInline");
  if (inline) {
    if (message && inline.dataset.mcForMessage === message.id) return;
    inline.remove();
    detail.classList.remove("is-replying");
  }
  if (!message) {
    detail.innerHTML = `<div class="mc-detail-empty">选择左侧一封邮件查看正文<br><span style="color:#9aa9bb;font-size:11px">邮件只在本机数据库，不会外传</span></div>`;
    return;
  }
  // 收件人超过 3 个折叠成 +N，点开展开（别让收件人列表把正文顶下去）
  const recipients = message.toAddresses.filter(Boolean);
  const shownRecipients = recipients.slice(0, 3);
  const hiddenCount = recipients.length - shownRecipients.length;
  const recipientPills = shownRecipients.map((addr) => `<span class="mc-meta-pill">${escapeHtml(addr)}</span>`).join("")
    + (hiddenCount > 0 ? `<button type="button" class="mc-meta-pill mc-meta-more" data-mc-expand-to title="展开全部收件人">+${hiddenCount}</button>` : "")
    + recipients.slice(3).map((addr) => `<span class="mc-meta-pill" data-mc-hidden-to hidden>${escapeHtml(addr)}</span>`).join("");
  detail.innerHTML = `
    <div class="mc-detail-scroll">
    <div class="mc-detail-head">
      <h2>${escapeHtml(message.subject || "(无主题)")}</h2>
      <div class="mc-detail-from">
        ${mcAvatar(message.fromName || message.fromAddress, message.fromAddress)}
        <div class="mc-detail-from-text">
          <b>${escapeHtml(message.fromName || message.fromAddress)}</b>
          <span>${escapeHtml(message.fromAddress)}</span>
        </div>
        <time>${mcDateTime(message.sentAt)}</time>
      </div>
      <div class="mc-detail-meta">
        ${recipientPills || `<span class="mc-meta-pill">收件人 —</span>`}
        <span class="mc-meta-pill">${message.direction === "outbound" ? "发出邮箱" : "收件邮箱"} ${escapeHtml(message.mailboxEmail)}</span>
      </div>
      <div class="mc-detail-actions">
        <button type="button" class="btn primary" data-mc-compose-mode="reply">回复</button>
        <button type="button" class="btn" data-mc-compose-mode="replyAll">全部回复</button>
        <button type="button" class="btn" data-mc-compose-mode="forward">转发</button>
        <button type="button" class="btn mc-btn-journey ${mailCenterState.journeyMenuOpen ? "is-open" : ""}" data-mc-journey-toggle aria-expanded="${mailCenterState.journeyMenuOpen ? "true" : "false"}" title="按${message.direction === "inbound" ? "发信人" : "收件人"}或按这封邮件的线程看往来">${mcIcon("route")}旅程</button>
        <button type="button" class="btn mc-btn-ghost" data-mc-mark-unread title="列表里重新显示为未读">标记为未读</button>
      </div>
      ${mailCenterState.journeyMenuOpen ? `<div class="mc-journey-entry">
        <button type="button" data-mc-mail-journey="${escapeHtml(message.id)}" data-mc-journey-scope="person">
          <b>与${message.direction === "inbound" ? "发信人" : "收件人"}的全部往来</b>
          <small>${escapeHtml(message.direction === "inbound" ? (message.fromName || message.fromAddress) : (message.toAddresses[0] || "对方"))} 的所有线程 + CRM 跟进、待办与商机</small>
        </button>
        <button type="button" data-mc-mail-journey="${escapeHtml(message.id)}" data-mc-journey-scope="thread">
          <b>这封邮件的前后往来</b>
          <small>顺着回复链找到这条线程的第一封和最新一封</small>
        </button>
      </div>` : ""}
    </div>
    ${message.hasAttachments ? `<div class="mc-attach-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>这封邮件带有附件。附件原件保存在你的邮箱服务器上，请到邮箱网页端下载；本机索引只同步了文字正文。</div>` : ""}
    <div class="mc-detail-body">${mcLinkifyPlainText(escapeHtml(mcPlainText(message.bodyText || message.snippet) || "（这封邮件没有可显示的纯文本正文）"))}</div>
    ${Number(message.sizeBytes || 0) > MC_SOURCE_LIMIT ? `<div class="mc-detail-note">这封邮件 ${(Number(message.sizeBytes) / 1048576).toFixed(1)}MB，正文只同步了前 ${Math.round(MC_SOURCE_LIMIT / 1048576)}MB（多为附件体积）；完整原文请在邮箱网页端查看。</div>` : ""}
    </div>`;
  qsa<HTMLElement>("[data-mc-compose-mode]", detail).forEach((node) => {
    node.addEventListener("click", () => {
      const mode = (node.dataset.mcComposeMode || "reply") as McComposeMode;
      // 回复/全部回复/转发 = 就地回复（原信就在上面）；新写信才开右下浮窗
      openMailCenterInlineCompose(message, mode);
    });
  });
  // 展开全部收件人
  detail.querySelector("[data-mc-expand-to]")?.addEventListener("click", () => {
    qsa<HTMLElement>("[data-mc-hidden-to]", detail).forEach((node) => { node.hidden = false; });
    detail.querySelector("[data-mc-expand-to]")?.remove();
  });
  // 标记为未读：本机索引清已读，回列表重新亮蓝点
  detail.querySelector("[data-mc-mark-unread]")?.addEventListener("click", () => {
    void (async () => {
      try {
        await api(`/api/mail-center/messages/${encodeURIComponent(message.id)}/unread`, { method: "POST" });
        message.readAt = "";
        const inList = mailCenterState.messages.find((item) => item.id === message.id);
        if (inList) inList.readAt = "";
        mailCenterState.activeMessage = null;
        renderMailCenterMessageList();
        renderMailCenterMessageDetail();
        toast("已标记为未读", "success");
      } catch (error) {
        toast(error instanceof Error ? error.message : "操作失败", "error");
      }
    })();
  });
}

function renderMailCenterLookupList() {
  const list = qs<HTMLElement>("#mcLookupList");
  if (!list) return;
  if (mailCenterState.lookupLoading) {
    list.innerHTML = mcEmpty("正在检索客户…", "");
    return;
  }
  if (!mailCenterState.lookupItems.length) {
    list.innerHTML = mcEmpty(
      mailCenterState.lookupKeyword ? "没有匹配的客户" : "输入关键词开始查找",
      mailCenterState.lookupKeyword ? "试试公司名的一部分、联系人姓名或邮箱" : "支持客户与线索，按邮件往来时间排序"
    );
    return;
  }
  list.innerHTML = mailCenterState.lookupItems.map((item, index) => {
    const key = `${item.entityType}:${item.entityId}`;
    return `<button class="mc-person ${mailCenterState.lookupActive === key ? "is-active" : ""}" type="button" data-mc-customer="${escapeHtml(key)}" style="--mc-i:${index}">
      <span class="mc-person-main">
        ${mcAvatar(item.company || item.contact || "?", item.email || item.entityId)}
        <span class="mc-person-text">
          <b>${escapeHtml(item.company || "（未命名）")}</b>
          <small>${escapeHtml(item.email || "未登记邮箱")}${item.contact ? ` · ${escapeHtml(item.contact)}` : ""}</small>
        </span>
      </span>
      <span class="mc-person-side">
        <em>${item.mailTotal}</em>
        <span>${item.lastMailAt ? mcRelativeTime(item.lastMailAt) : "无往来"}</span>
      </span>
    </button>`;
  }).join("");
}

function renderMailCenterLookupDetail() {
  const detail = qs<HTMLElement>("#mcLookupDetail");
  if (!detail) return;
  const data = mailCenterState.lookupDetail;
  if (!data) {
    detail.innerHTML = `<div class="mc-detail-empty">选择左侧客户<br><span style="color:#9aa9bb;font-size:11px">这里会显示他的邮箱、来信数与最近回复</span></div>`;
    return;
  }
  const rows = data.messages.slice(0, 12).map((message) => `
    <button class="mc-msg is-compact" type="button" data-mc-open-message="${escapeHtml(message.id)}" style="--mc-i:0">
      <span class="mc-msg-av">
        ${mcAvatar(message.fromName || message.fromAddress, message.fromAddress)}
        <i class="mc-msg-dir ${message.direction === "inbound" ? "is-in" : "is-out"}">${message.direction === "inbound" ? "↓" : "↑"}</i>
      </span>
      <span class="mc-msg-main">
        <span class="mc-msg-subject"><b>${escapeHtml(message.subject || "(无主题)")}</b></span>
        <span class="mc-msg-snippet">${escapeHtml(mcPlainText(message.snippet))}</span>
      </span>
      <span class="mc-msg-time">${mcDateTime(message.sentAt).slice(5, 16)}</span>
    </button>`).join("");
  detail.innerHTML = `
    <div class="mc-detail-head mc-lookup-head">
      <div class="mc-lookup-title">
        ${mcAvatar(data.entity.company || data.entity.contact || "?", data.email || data.entity.entityId)}
        <div class="mc-lookup-title-text">
          <h2>${escapeHtml(data.entity.company || "（未命名）")}</h2>
          <div class="mc-detail-meta">
            ${data.email ? `<span class="mc-mailbox-chip">${escapeHtml(data.email)}</span>` : `<span style="color:#b23a57">未登记邮箱，无法归集邮件</span>`}
            <span>${escapeHtml(data.entity.contact || "未登记联系人")}</span>
            <span>负责人：${escapeHtml(data.entity.ownerName || "—")}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="mc-lookup-summary">
      <div><b>${data.stats.total}</b><span>往来邮件</span></div>
      <div><b>${data.stats.inbound}</b><span>客户来信</span></div>
      <div><b>${data.stats.replies}</b><span>客户回信</span></div>
      <div><b>${data.stats.lastReplyAt ? mcRelativeTime(data.stats.lastReplyAt) : "—"}</b><span>最近回复</span></div>
    </div>
    <div class="mc-lookup-actions">
      <button class="btn primary" type="button" data-mc-action="open-journey" data-mc-entity="${escapeHtml(data.entity.entityType + ":" + data.entity.entityId)}">查看交互旅程</button>
      <button class="btn" type="button" data-mc-action="write-mail" data-mc-entity="${escapeHtml(data.entity.entityType + ":" + data.entity.entityId)}">去写信</button>
    </div>
    <div class="mc-lookup-rows">${rows || mcEmpty("还没有往来邮件", "这个客户名下没有同步到邮件记录")}</div>`;
}

function mailCenterJourneyHint() {
  const journey = mailCenterState.journey;
  if (!journey) return "从右侧选一个客户，或在邮件阅读栏点「旅程」按发信人 / 本线程看";
  if (journey.source === "thread") {
    return `线程 · ${journey.thread?.origin?.subject || journey.anchorSubject || "这封邮件"}（起源 → 最新）`;
  }
  if (journey.source === "person") {
    // 旅程的主体是「人」，不是那封信：抬头先报发信人/收件人，邮件只说明从哪儿进来
    const who = journey.counterpartName || journey.counterpart || journey.email || "对方";
    return `与${journey.anchorDirection === "outbound" ? "收件人" : "发信人"} ${who} 的旅程`;
  }
  return `已选 ${journey.company || ""}`;
}

/** 旅程加载完只重画详情区时，搜索栏那句提示不会跟着更新 —— 单独补一次 */
function refreshMailCenterJourneyHint() {
  const hint = document.querySelector<HTMLElement>("#mcJourneySearch")?.closest(".mc-searchbar")?.querySelector<HTMLElement>(".mc-hint");
  if (hint) hint.textContent = mailCenterJourneyHint();
}

function renderMailCenterJourneyList() {
  const list = qs<HTMLElement>("#mcJourneyList");
  if (!list) return;
  if (!mailCenterState.lookupItems.length) {
    list.innerHTML = mcEmpty("还没有客户可展示", "先在上方搜索客户；也可以打开任意一封邮件，在「旅程」里按发信人或按线程看");
    return;
  }
  list.innerHTML = mailCenterState.lookupItems.map((item, index) => {
    const key = `entity:${item.entityType}:${item.entityId}`;
    return `<button class="mc-person ${mailCenterState.journeyKey === key ? "is-active" : ""}" type="button" data-mc-journey="${escapeHtml(key)}" style="--mc-i:${index}">
      <span class="mc-person-main">
        ${mcAvatar(item.company || item.contact || "?", item.email || item.entityId)}
        <span class="mc-person-text">
          <b>${escapeHtml(item.company || "（未命名）")}</b>
          <small>${escapeHtml(item.email || "未登记邮箱")}</small>
        </span>
      </span>
      <span class="mc-person-side"><em>${item.mailTotal}</em><span>${item.lastMailAt ? mcRelativeTime(item.lastMailAt) : "无往来"}</span></span>
    </button>`;
  }).join("");
}

type McJourneyBucket = {
  key: string;
  label: string;
  up: MailCenterJourneyEvent[];
  down: MailCenterJourneyEvent[];
};

/** 同一天同一侧最多画 5 个站点：4 条事件 + 1 个「还有 N 条」，再多图就成烟花 */
const MC_JOURNEY_STACK_LIMIT = 5;

function mcJourneySortedEvents(journey: MailCenterJourney) {
  return journey.events
    .filter((event) => Number.isFinite(new Date(event.at).getTime()))
    .slice()
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

/**
 * 一天一列。客户来信挂在轴下、我们发出（含退信、跟进、活动）挂在轴上，
 * 这样「问—答」在视觉上就是一上一下的对话，而不是一长串卡片。
 */
function mcJourneyBuckets(events: MailCenterJourneyEvent[]): McJourneyBucket[] {
  const buckets: McJourneyBucket[] = [];
  const byKey = new Map<string, McJourneyBucket>();
  for (const event of events) {
    const date = new Date(event.at);
    const pad = (value: number) => String(value).padStart(2, "0");
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { key, label: key.slice(5), up: [], down: [] };
      byKey.set(key, bucket);
      buckets.push(bucket);
    }
    (event.kind === "inbound" ? bucket.down : bucket.up).push(event);
  }
  return buckets;
}

const MC_JOURNEY_GLYPHS = {
  out: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  in: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  rose: '<path d="M12 7v6.4"/><path d="M12 17.2v.01"/>',
  soft: '<path d="M5 12.5l4.4 4.4L19 7.2"/>',
  plain: '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>'
};

function mcJourneyGlyph(path: string) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function mcJourneyTone(event: MailCenterJourneyEvent) {
  if (event.kind === "bounce") return { cls: "is-rose", glyph: mcJourneyGlyph(MC_JOURNEY_GLYPHS.rose) };
  if (event.kind === "inbound") return { cls: "is-in", glyph: mcJourneyGlyph(MC_JOURNEY_GLYPHS.in) };
  if (event.kind === "outbound") return { cls: "is-out", glyph: mcJourneyGlyph(MC_JOURNEY_GLYPHS.out) };
  if (event.kind === "todo") return { cls: "is-soft", glyph: mcJourneyGlyph(MC_JOURNEY_GLYPHS.soft) };
  return { cls: "is-soft", glyph: mcJourneyGlyph(MC_JOURNEY_GLYPHS.plain) };
}

function mcJourneyKindLabel(event: MailCenterJourneyEvent) {
  if (event.kind === "bounce") return "退信";
  if (event.kind === "inbound") return "客户来信";
  if (event.kind === "outbound") return "我们发出";
  if (event.kind === "todo") return "跟进任务";
  if (event.kind === "deal") return "商机";
  return "客户活动";
}

function mcJourneyGapLabel(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

/** 轴上一侧的全部站点：节点 + 时间，超出上限的折成「+N」 */
function mcJourneyCellsHtml(list: MailCenterJourneyEvent[], orderOf: Map<string, number>) {
  const shown = list.length > MC_JOURNEY_STACK_LIMIT ? list.slice(0, MC_JOURNEY_STACK_LIMIT - 1) : list;
  const rest = list.slice(shown.length);
  const cells = shown.map((event) => {
    const tone = mcJourneyTone(event);
    const at = mcDateTime(event.at);
    const active = mailCenterState.journeyEventId === event.id;
    return `<div class="mc-node-cell">
      <button class="mc-node ${tone.cls}${active ? " is-active" : ""}" type="button"
        data-mc-journey-event="${escapeHtml(event.id)}" style="--mc-order:${orderOf.get(event.id) ?? 0}"
        aria-label="${escapeHtml(`${event.title}，${at}`)}"
        aria-pressed="${active}">${tone.glyph}</button>
      <span class="mc-node-time">${escapeHtml(at.slice(11))}</span>
    </div>`;
  }).join("");
  // 折叠掉的那些仍然让人知道有：悬停能看到标题，不至于是个哑数字
  const more = rest.length
    ? `<span class="mc-node-more" title="${escapeHtml(rest.map((event) => `${event.title} · ${mcDateTime(event.at)}`).join("\n"))}">+${rest.length}</span>`
    : "";
  return cells + more;
}

function mcJourneyColumnHtml(bucket: McJourneyBucket, orderOf: Map<string, number>, showDate: boolean) {
  // 选中节点所在的那一天整列提亮，图上的点与下方的详情卡才对得上
  const current = [...bucket.up, ...bucket.down].some((event) => event.id === mailCenterState.journeyEventId);
  return `<div class="mc-flow-col${current ? " is-current" : ""}">
    <span class="mc-flow-spine" aria-hidden="true"></span>
    <div class="mc-flow-up">${mcJourneyCellsHtml(bucket.up, orderOf)}</div>
    <div class="mc-flow-down">${mcJourneyCellsHtml(bucket.down, orderOf)}</div>
    <span class="mc-flow-date">${showDate ? escapeHtml(bucket.label) : ""}</span>
  </div>`;
}

/** 图表下方的事件详情卡：跟着选中节点走，切换只重画这一块，图不动、滚动位置不动 */
function mcJourneyFocusHtml(journey: MailCenterJourney) {
  const events = mcJourneySortedEvents(journey);
  if (!events.length) return "";
  let index = events.findIndex((event) => event.id === mailCenterState.journeyEventId);
  if (index < 0) index = events.length - 1;
  const event = events[index];
  const tone = mcJourneyTone(event);
  const prev = index > 0 ? events[index - 1] : null;
  const gap = prev ? mcJourneyGapLabel(new Date(event.at).getTime() - new Date(prev.at).getTime()) : "";
  const tags = [
    MC_SOURCE_LABEL[event.source] || "",
    MC_REPLY_CLASSIFICATION[event.classification] || "",
    event.channel === "whatsapp" ? "WhatsApp" : event.channel === "phone" ? "电话" : ""
  ].filter(Boolean).map((tag) => `<span class="mc-focus-tag">${escapeHtml(tag)}</span>`).join("");
  const preview = String(event.preview || "").trim();
  const mailId = String(event.mailId || "");
  // 正文先给个能读的摘要；被截断时点「展开」再去取全文，避免每换一个节点都拉一次正文
  const longBody = preview.length > 80 || preview.split("\n").length > 3;
  const body = preview
    ? `<div class="mc-focus-body" data-mc-focus-body>
        <pre class="mc-focus-text" data-mc-focus-text>${escapeHtml(preview)}</pre>
        ${longBody ? `<button class="mc-focus-more" type="button" data-mc-focus-more="${escapeHtml(event.id)}">展开正文</button>` : ""}
      </div>`
    : "";
  // 整张卡可点：用户要的是「点一下就带我去那封信」，不必先找按钮；
  // 卡片里的翻页/展开按钮各自有 stopPropagation 之外的判断，不会误触
  return `<div class="mc-focus ${tone.cls}${mailId ? " is-openable" : ""}"${mailId ? ` data-mc-locate-event="${escapeHtml(event.id)}" role="button" tabindex="0" title="点击在邮件列表中定位这封邮件"` : ""}>
    <span class="mc-focus-icon">${tone.glyph}</span>
    <div class="mc-focus-main">
      <div class="mc-focus-top">
        <b>${escapeHtml(event.title)}</b>
        <span class="mc-focus-kind">${escapeHtml(mcJourneyKindLabel(event))}</span>
        <time>${escapeHtml(mcDateTime(event.at))}</time>
      </div>
      ${event.subject ? `<div class="mc-focus-subject">${escapeHtml(event.subject)}</div>` : ""}
      ${body}
      ${event.detail ? `<div class="mc-focus-detail">${escapeHtml(event.detail)}</div>` : ""}
      ${tags ? `<div class="mc-focus-tags">${tags}</div>` : ""}
    </div>
    <div class="mc-focus-side">
      <div class="mc-focus-gap">${gap ? `<b>${gap}</b><span>距上一条</span>` : `<b>首条</b><span>旅程起点</span>`}</div>
      ${mailId ? `<button class="mc-focus-open" type="button" data-mc-locate-event="${escapeHtml(event.id)}">${mcIcon("mail")}<span>定位邮件</span></button>` : ""}
      <div class="mc-focus-nav">
        <button type="button" data-mc-journey-step="-1" ${index <= 0 ? "disabled" : ""} aria-label="上一条事件">‹</button>
        <span>${index + 1} / ${events.length}</span>
        <button type="button" data-mc-journey-step="1" ${index >= events.length - 1 ? "disabled" : ""} aria-label="下一条事件">›</button>
      </div>
    </div>
  </div>`;
}

function renderMailCenterJourneyDetail() {
  const detail = qs<HTMLElement>("#mcJourneyDetail");
  if (!detail) return;
  if (mailCenterState.journeyLoading) {
    detail.innerHTML = `<div class="mc-detail-empty">正在汇总交互记录…</div>`;
    return;
  }
  const journey = mailCenterState.journey;
  if (!journey) {
    detail.innerHTML = `<div class="mc-detail-empty">选择左侧客户<br><span style="color:#9aa9bb;font-size:11px">旅程会合并发信、来信、打开/点击、跟进与待办</span></div>`;
    return;
  }
  const events = mcJourneySortedEvents(journey);
  const source = journey.source || "entity";
  // person = 和这个发信人的全部往来；thread = 这封邮件所在线程（起源 → 最新）
  const mailOrigin = source === "person" || source === "thread";
  const threadView = source === "thread";
  const anchorEvent = mailOrigin
    ? events.find((event) => event.id === journey.anchorEventId)
      || events.find((event) => event.mailId === journey.anchorMailId)
      || null
    : null;
  // 邮件进来的旅程：抬头的主体是「这个人」，邮件只作为入口说明
  const personSide = journey.anchorDirection === "outbound" ? "收件人" : "发信人";
  const personName = mailOrigin
    ? (journey.counterpartName
      || (journey.matched ? journey.company : "")
      || journey.counterpart
      || journey.email
      || `这位${personSide}`)
    : "";
  const personAddress = mailOrigin ? (journey.counterpart || journey.email || "") : "";
  const companyChip = mailOrigin && journey.matched && journey.company && journey.company !== personName
    ? journey.company
    : "";
  const matchState = journey.matched
    ? `${journey.matchSource === "email" ? "按发信邮箱匹配到客户" : "已归属客户"}${journey.company ? ` · ${escapeHtml(journey.company)}` : ""}`
    : `未建档 · 按${personSide}地址归集`;
  const threadOrigin = journey.thread?.origin || null;
  const threadEnd = journey.thread?.end || null;
  const threadEndpoint = (label: string, endpoint: MailCenterJourneyEndpoint | null) => endpoint
    ? `<span class="mc-thread-endpoint">
        <i>${label}</i>
        <b>${escapeHtml(mcDateTime(endpoint.at))}</b>
        <span>${endpoint.direction === "inbound" ? "客户来信" : "我们发出"} · ${escapeHtml(mcPlainText(endpoint.from) || "—")}</span>
      </span>`
    : `<span class="mc-thread-endpoint is-empty"><i>${label}</i><b>—</b><span>没有同步到</span></span>`;
  if (!events.length) {
    detail.innerHTML = threadView
      ? mcEmpty("这条线程只有这一封", "没找到更早的父信或后续回复；同一个人其他线程可以看「发信人全部往来」")
      : mailOrigin
        ? mcEmpty(`还没看到与这位${personSide}的往来`, "这封信可能是唯一一封，或同步范围还没覆盖到更早的邮件")
        : mcEmpty("还没有可展示的交互", "这个客户在 CRM 里既没有发信记录，也没有同步到邮件");
    return;
  }
  if (!events.some((event) => event.id === mailCenterState.journeyEventId)) {
    // 默认落在最近一条：打开就能看到「现在谈到哪了」
    mailCenterState.journeyEventId = events[events.length - 1].id;
  }
  const buckets = mcJourneyBuckets(events);
  const orderOf = new Map(events.map((event, index) => [event.id, index] as const));
  const stack = Math.min(MC_JOURNEY_STACK_LIMIT, Math.max(1, ...buckets.map((bucket) => Math.max(bucket.up.length, bucket.down.length))));
  const step = Math.ceil(buckets.length / 6);
  const columns = buckets.map((bucket, index) => {
    const showDate = index === 0 || index === buckets.length - 1 || index % step === 0;
    return mcJourneyColumnHtml(bucket, orderOf, showDate);
  }).join("");
  detail.innerHTML = `
    <div class="mc-detail-head mc-journey-head">
      ${threadView ? `<div class="mc-journey-origin is-thread">
        <span class="mc-origin-tag">${mcIcon("route")}线程全貌</span>
        <span class="mc-thread-range">
          ${threadEndpoint("起源", threadOrigin)}
          <span class="mc-thread-arrow" aria-hidden="true">→</span>
          ${threadEndpoint("最新", threadEnd)}
          <span class="mc-thread-count">共 ${journey.thread?.count || events.length} 封</span>
        </span>
        <span class="mc-grow"></span>
        ${journey.matched && journey.entityType && journey.entityId
          ? `<button class="mc-origin-link" type="button" data-mc-journey-entity="${escapeHtml(journey.entityType + ":" + journey.entityId)}">按客户查看</button>`
          : ""}
        <button class="mc-origin-link" type="button" data-mc-journey-person="${escapeHtml(journey.anchorMailId || "")}">看${personSide}全部往来</button>
        <button class="mc-origin-link" type="button" data-mc-journey-mail-back>回到这封邮件</button>
      </div>` : mailOrigin ? `<div class="mc-journey-origin">
        <span class="mc-origin-tag">${mcIcon("mail")}从这封信进来</span>
        <span class="mc-origin-text">
          <b>${escapeHtml(journey.anchorSubject || anchorEvent?.subject || "（无主题）")}</b>
          <span>${escapeHtml(journey.anchorAt ? mcDateTime(journey.anchorAt) : anchorEvent ? mcDateTime(anchorEvent.at) : "")}</span>
        </span>
        <span class="mc-origin-state ${journey.matched ? "is-matched" : ""}">${matchState}</span>
        <span class="mc-grow"></span>
        ${journey.matched && journey.entityType && journey.entityId
          ? `<button class="mc-origin-link" type="button" data-mc-journey-entity="${escapeHtml(journey.entityType + ":" + journey.entityId)}">按客户查看</button>`
          : ""}
        <button class="mc-origin-link" type="button" data-mc-journey-thread="${escapeHtml(journey.anchorMailId || "")}">看这封邮件的线程</button>
        <button class="mc-origin-link" type="button" data-mc-journey-mail-back>回到这封邮件</button>
      </div>` : ""}
      <div class="mc-journey-title">
        ${mcAvatar(mailOrigin ? personName : journey.company || journey.email || "?", mailOrigin ? (personAddress || personName) : (journey.email || journey.company || ""))}
        <div class="mc-journey-title-text">
          ${threadView ? `
            <b class="mc-journey-subject">${escapeHtml(threadOrigin?.subject || journey.anchorSubject || "（无主题）")}</b>
            ${personAddress && personAddress !== personName ? `<span class="mc-mailbox-chip">${escapeHtml(personAddress)}</span>` : ""}
            ${companyChip ? `<span class="mc-mailbox-chip is-company">${escapeHtml(companyChip)}</span>` : ""}
            <span class="mc-journey-span">${journey.thread?.count || events.length} 封邮件 · ${journey.stats.days ? `跨度 ${journey.stats.days} 天` : "同一天"} · ${matchState}</span>` : mailOrigin ? `
            <b>${escapeHtml(personName)}</b>
            ${personAddress && personAddress !== personName ? `<span class="mc-mailbox-chip">${escapeHtml(personAddress)}</span>` : ""}
            ${companyChip ? `<span class="mc-mailbox-chip is-company">${escapeHtml(companyChip)}</span>` : ""}
            <span class="mc-journey-span">与这位${personSide}的全部往来 · ${journey.stats.days ? `跨度 ${journey.stats.days} 天` : "同一天"} · ${events.length} 个节点</span>` : `
            <b>${escapeHtml(journey.company || "（未命名）")}</b>
            ${journey.email ? `<span class="mc-mailbox-chip">${escapeHtml(journey.email)}</span>` : ""}
            <span class="mc-journey-span">${journey.stats.days ? `跨度 ${journey.stats.days} 天` : "同一天"} · ${events.length} 个节点</span>`}
        </div>
      </div>
      <div class="mc-journey-stats">
        <div class="mc-jstat"><b>${journey.stats.total}</b><span>交互事件</span></div>
        <div class="mc-jstat is-brand"><b>${journey.stats.outbound}</b><span>我们发出</span></div>
        <div class="mc-jstat is-teal"><b>${journey.stats.inbound}</b><span>客户回应</span></div>
        <div class="mc-jstat"><b>${journey.stats.outbound ? `${journey.stats.replyRate}%` : "—"}</b><span>回复率</span></div>
        <div class="mc-jstat ${journey.stats.bounces ? "is-rose" : ""}"><b>${journey.stats.bounces}</b><span>退信</span></div>
      </div>
    </div>
    <div class="mc-flow">
      <div class="mc-flow-tools">
        <div class="mc-journey-legend">
          <span class="is-out"><i></i>我们发出</span>
          <span class="is-in"><i></i>客户来信</span>
          <span class="is-soft"><i></i>跟进/系统</span>
          <span class="is-rose"><i></i>退信</span>
        </div>
        <button class="mc-journey-replay" type="button" data-mc-journey-replay>${mcIcon("sync")}重播</button>
      </div>
      <div class="mc-flow-scroll" data-mc-flow-scroll>
        <div class="mc-flow-canvas" data-mc-flow-canvas style="--mc-stack:${stack}">
          <span class="mc-flow-axis" aria-hidden="true"></span>
          ${columns}
        </div>
      </div>
    </div>
    <div id="mcJourneyFocus">${mcJourneyFocusHtml(journey)}</div>`;
  // 客户可能聊了两个月，默认停在最近的一列，而不是让人自己拖到最右边
  const scroller = qs<HTMLElement>("[data-mc-flow-scroll]");
  if (scroller && scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft = scroller.scrollWidth;
  // 从某封信进来时，锚点可能在一个月前：默认停在最右就等于没锚定，得把这封信带到眼前。
  // ⚠️ 只挪横向滚动，不用 scrollIntoView —— 后者会连带滚外层页面，一进来页头就没了。
  if (mailOrigin && mailCenterState.journeyEventId && scroller) {
    const anchorNode = Array.from(document.querySelectorAll<HTMLElement>("[data-mc-journey-event]"))
      .find((node) => node.dataset.mcJourneyEvent === mailCenterState.journeyEventId);
    if (anchorNode) {
      const box = scroller.getBoundingClientRect();
      const target = anchorNode.getBoundingClientRect();
      scroller.scrollLeft += (target.left + target.width / 2) - (box.left + box.width / 2);
    }
  }
}

/** 选中某个节点：只换详情卡和激活态，不重建图表（否则动画重放、横向滚动位置也会被拉回） */
function selectMailCenterJourneyEvent(id: string) {
  const journey = mailCenterState.journey;
  if (!journey || !id) return;
  mailCenterState.journeyEventId = id;
  const focus = qs<HTMLElement>("#mcJourneyFocus");
  if (focus) focus.innerHTML = mcJourneyFocusHtml(journey);
  const nodes = document.querySelectorAll<HTMLElement>("[data-mc-journey-event]");
  nodes.forEach((node) => {
    const active = node.dataset.mcJourneyEvent === id;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll<HTMLElement>(".mc-flow-col.is-current").forEach((col) => col.classList.remove("is-current"));
  const activeNode = document.querySelector<HTMLElement>(`[data-mc-journey-event="${id.replace(/"/g, '\\"')}"]`);
  activeNode?.closest<HTMLElement>(".mc-flow-col")?.classList.add("is-current");
}

/** 上一条 / 下一条：选中项若被横向滚出视野，顺手带回来 */
function stepMailCenterJourney(delta: number) {
  const journey = mailCenterState.journey;
  if (!journey || !delta) return;
  const events = mcJourneySortedEvents(journey);
  const current = events.findIndex((event) => event.id === mailCenterState.journeyEventId);
  const next = Math.min(events.length - 1, Math.max(0, (current < 0 ? events.length - 1 : current) + delta));
  const target = events[next];
  if (!target || target.id === mailCenterState.journeyEventId) return;
  selectMailCenterJourneyEvent(target.id);
  const node = document.querySelector<HTMLElement>(`[data-mc-journey-event="${target.id.replace(/"/g, '\\"')}"]`);
  node?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
}

/** 重播：换一个 keyframes 名重跑一遍依次点亮，节点会按时间顺序一个个亮起来 */
function replayMailCenterJourney() {
  const canvas = qs<HTMLElement>("[data-mc-flow-canvas]");
  if (!canvas) return;
  canvas.classList.remove("is-playing");
  void canvas.offsetWidth;
  canvas.classList.add("is-playing");
  window.setTimeout(() => canvas.classList.remove("is-playing"), 2600);
}

/* ===== 节点悬浮卡：图上扫一眼就知道这封信说了什么，点一下去邮件列表 ===== */

/**
 * 浮卡挂在 body 上（不能被 `.mc-flow-scroll` 的 overflow 裁掉），
 * 因此里面的样式**一律写死颜色**，不能吃 `--mc-*` 令牌——那些定义在 #mail-center 子树里。
 */
let mcNodeTipEl: HTMLElement | null = null;
let mcNodeTipAnchor: HTMLElement | null = null;
let mcNodeTipId = "";
let mcNodeTipTimer = 0;
let mcNodeTipBound = false;
let mcNodeTipFocusBound = false;

function mcJourneyEventOf(id: string) {
  return mailCenterState.journey?.events.find((event) => event.id === id) || null;
}

function mcNodeTipHtml(event: MailCenterJourneyEvent) {
  const tone = mcJourneyTone(event);
  const preview = String(event.preview || "").trim();
  const mailId = String(event.mailId || "");
  const lines = preview ? preview.split("\n").slice(0, 12).join("\n") : "";
  return `<div class="mc-tip-head">
      <span class="mc-tip-dot ${tone.cls}">${tone.glyph}</span>
      <div class="mc-tip-title">
        <b>${escapeHtml(event.title)}</b>
        <span>${escapeHtml(mcJourneyKindLabel(event))} · ${escapeHtml(mcDateTime(event.at))}</span>
      </div>
    </div>
    ${event.subject ? `<div class="mc-tip-subject">${escapeHtml(event.subject)}</div>` : ""}
    ${lines
      ? `<pre class="mc-tip-body">${escapeHtml(lines)}</pre>`
      : `<div class="mc-tip-body is-empty">${escapeHtml(event.detail || "这条事件没有邮件正文")}</div>`}
    ${mailId
      ? `<button class="mc-tip-go" type="button" data-mc-tip-locate="${escapeHtml(event.id)}">在邮件列表中打开 <span aria-hidden="true">→</span></button>`
      : `<div class="mc-tip-none">这条没有邮件原文${event.channel === "email" ? "" : "（跟进记录 / 系统事件）"}</div>`}`;
}

function ensureMcNodeTip() {
  if (mcNodeTipEl) return mcNodeTipEl;
  const tip = document.createElement("div");
  tip.className = "mc-node-tip";
  tip.hidden = true;
  // 鼠标从节点移到浮卡上时要留着（不然去点「打开」的途中就消失了）
  tip.addEventListener("mouseenter", () => window.clearTimeout(mcNodeTipTimer));
  tip.addEventListener("mouseleave", () => hideMcNodeTip());
  tip.onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-mc-tip-locate]");
    if (!button) return;
    const id = button.dataset.mcTipLocate || "";
    hideMcNodeTip(0);
    void locateMailCenterJourneyEvent(id);
  };
  document.body.appendChild(tip);
  mcNodeTipEl = tip;
  return tip;
}

function placeMcNodeTip(node: HTMLElement) {
  const tip = mcNodeTipEl;
  if (!tip) return;
  const rect = node.getBoundingClientRect();
  const width = Math.min(360, Math.max(220, window.innerWidth - 24));
  tip.style.width = `${width}px`;
  const height = tip.offsetHeight || 180;
  const left = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12));
  // 优先往上弹（节点在图里，上方空间更富裕）；贴着顶边时改弹到下方
  const above = rect.top - height - 14;
  const top = above >= 8 ? above : Math.min(rect.bottom + 14, Math.max(8, window.innerHeight - height - 12));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function showMcNodeTip(node: HTMLElement, id: string) {
  const event = mcJourneyEventOf(id);
  if (!event) return;
  window.clearTimeout(mcNodeTipTimer);
  const tip = ensureMcNodeTip();
  if (mcNodeTipId !== id) {
    mcNodeTipId = id;
    tip.innerHTML = mcNodeTipHtml(event);
  }
  mcNodeTipAnchor = node;
  tip.hidden = false;
  placeMcNodeTip(node);
}

function hideMcNodeTip(delay = 150) {
  window.clearTimeout(mcNodeTipTimer);
  mcNodeTipTimer = window.setTimeout(() => {
    if (mcNodeTipEl) mcNodeTipEl.hidden = true;
    mcNodeTipId = "";
    mcNodeTipAnchor = null;
  }, delay);
}

/**
 * 浮卡跟着节点走。
 * 早先的做法是「一滚动就关掉」，实测鼠标只是把图带进视野、或者横向拖一下泳道，
 * 卡片就闪没了——用户会以为悬停压根没反应。现在改成重新贴到节点上，
 * 只有节点真的滚出视口才收。
 */
function bindMcNodeTipGlobal() {
  if (mcNodeTipBound) return;
  mcNodeTipBound = true;
  document.addEventListener("scroll", () => {
    if (!mcNodeTipEl || mcNodeTipEl.hidden) return;
    const anchor = mcNodeTipAnchor;
    if (!anchor || !anchor.isConnected) { hideMcNodeTip(0); return; }
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
      hideMcNodeTip(0);
      return;
    }
    placeMcNodeTip(anchor);
  }, true);
  window.addEventListener("resize", () => {
    if (mcNodeTipEl && !mcNodeTipEl.hidden && mcNodeTipAnchor?.isConnected) placeMcNodeTip(mcNodeTipAnchor);
    else hideMcNodeTip(0);
  });
}

/** 展开/收起正文：摘要被截断时顺手取一次全文，别让人对着 480 字猜后半段 */
async function toggleMailCenterJourneyBody(eventId: string, button: HTMLElement) {
  const box = button.closest<HTMLElement>("[data-mc-focus-body]");
  const text = box?.querySelector<HTMLElement>("[data-mc-focus-text]");
  if (!box || !text) return;
  const open = box.classList.toggle("is-open");
  button.textContent = open ? "收起" : "展开正文";
  if (!open || box.dataset.fullLoaded === "1") return;
  const event = mcJourneyEventOf(eventId);
  if (!event?.mailId || !String(event.preview || "").endsWith("…")) return;
  box.dataset.fullLoaded = "1";
  try {
    const result = await api<{ message: MailCenterMessage }>(`/api/mail-center/messages/${encodeURIComponent(event.mailId)}`);
    const body = String(result.message?.bodyText || "").trim().replace(/\n{3,}/g, "\n\n");
    // 正文可能比卡片高得多，给个上限：这里要看的是「信里说了什么」，不是归档原件
    if (body) text.textContent = body.length > 4000 ? `${body.slice(0, 4000)}…` : body;
  } catch {
    /* 取不到就保持摘要，别把卡片变成一个红叉 */
  }
}

/**
 * 点节点/浮卡/详情卡 → 去邮件列表里把这封信找出来。
 *
 * 三个坑：
 * ① 可能不在当前文件夹（发出 → 已发送，来信 → 收件箱），得先切文件夹；
 * ② 可能排在 200 名开外，普通分页永远看不到 → 用 focusId 让服务端把这行补进来；
 * ③ 关键词/方向筛选还挂着的话，列表里就是空的 → 定位时清掉，否则「定位成功」等于一片空白。
 */
async function locateMailCenterJourneyEvent(eventId: string) {
  const event = mcJourneyEventOf(eventId);
  if (!event) return;
  const mailId = String(event.mailId || "");
  if (!mailId) {
    toast("这条没有邮件原文（跟进记录 / 待办 / 打开点击），定位不了邮件列表", "warn");
    return;
  }
  mailCenterState.tab = "inbox";
  mailCenterState.folder = event.direction === "inbound" ? "inbox" : "sent";
  mailCenterState.direction = "";
  mailCenterState.keyword = "";
  mailCenterState.activeMessageId = "";
  mailCenterState.activeMessage = null;
  mailCenterState.locatedMessageId = mailId;
  renderMailCenterPage();
  renderMailSectionNav();
  await loadMailCenterMessages({ silent: true, focusId: mailId });
  await openMailCenterMessage(mailId);
  focusLocatedMessageRow(mailId);
}

/** 列表里把定位到的行滚到眼前并闪一下：不给反馈的话，用户会以为「点了没反应」 */
function focusLocatedMessageRow(id: string) {
  const row = document.querySelector<HTMLElement>(`.mc-msg[data-mc-message="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center", inline: "nearest" });
  row.classList.remove("is-located");
  void row.offsetWidth;
  row.classList.add("is-located");
  window.setTimeout(() => row.classList.remove("is-located"), 2400);
  mailCenterState.locatedMessageId = "";
}

function mailCenterToolSections(): MailCenterToolSection[] {
  return [
    {
      key: "recommend",
      title: "推荐使用",
      note: "每天都会点到的三个动作",
      items: [
        {
          key: "tracking", name: "邮件追踪", desc: "快速知晓邮件阅读状态", color: "#12a594", icon: "chart", featured: true,
          run: () => activateNavView("email-return-flow")
        },
        {
          key: "assist-draft", name: "智能助手", desc: "一句话解决写邮件、总结邮件", color: "#7c5cff", icon: "ai", badge: "AI", featured: true,
          run: () => openMailCenterAssist("draft")
        },
        {
          key: "lookup", name: "客户邮箱速查", desc: "选客户，直接看他登记的邮箱和所有来信", color: "#378ADD", icon: "user", featured: true,
          run: () => { mailCenterState.tab = "lookup"; renderMailCenterPage(); void loadMailCenterLookup(); }
        }
      ]
    },
    {
      key: "agent",
      title: "Mail Agent",
      note: "六种写法，都从当前这封邮件出发",
      items: [
        {
          key: "assist-write", name: "AI 写信", desc: "按客户与场景输出高质量邮件内容", color: "#7c5cff", icon: "pen",
          run: () => openMailCenterAssist("draft")
        },
        {
          key: "assist-summary", name: "AI 总结", desc: "快速总结邮件内容要点", color: "#4a8ef7", icon: "list",
          run: () => openMailCenterAssist("summarize")
        },
        {
          key: "assist-polish", name: "AI 润色", desc: "助力邮件内容质量提升", color: "#df8a2c", icon: "wand",
          run: () => openMailCenterAssist("polish")
        },
        {
          key: "assist-continue", name: "AI 续写", desc: "自动续写邮件，让内容更完整", color: "#12a594", icon: "forward",
          run: () => openMailCenterAssist("continue")
        },
        {
          key: "assist-translate", name: "AI 翻译", desc: "高效精准的中英文互译", color: "#2f9bb8", icon: "translate",
          run: () => openMailCenterAssist("translate")
        },
        {
          key: "assist-optimize", name: "AI 英文优化", desc: "英语邮件写作不再烦恼", color: "#dd5878", icon: "globe",
          run: () => openMailCenterAssist("optimize")
        }
      ]
    },
    {
      key: "mail",
      title: "邮件收发",
      note: "收件、发出与异常排查",
      items: [
        {
          key: "inbox", name: "收件箱", desc: "按账号和方向筛邮件，点开即看正文", color: "#378ADD", icon: "inbox",
          run: () => { mailCenterState.tab = "inbox"; mailCenterState.folder = "inbox"; renderMailCenterPage(); void loadMailCenterMessages(); }
        },
        {
          key: "unread", name: "只看客户来信", desc: "过滤掉通知与营销邮件，只看对方说的话", color: "#1f9d8f", icon: "reply",
          run: () => {
            mailCenterState.tab = "inbox";
            mailCenterState.folder = "inbox";
            mailCenterState.direction = "inbound";
            renderMailCenterPage();
            void loadMailCenterMessages();
          }
        },
        {
          key: "sent", name: "已发送", desc: "我方发出去的信，含网页端直接回的", color: "#5b7591", icon: "send",
          run: () => {
            mailCenterState.tab = "inbox";
            mailCenterState.folder = "sent";
            mailCenterState.direction = "";
            renderMailCenterPage();
            void loadMailCenterMessages();
          }
        },
        {
          key: "bounce", name: "退信排查", desc: "列出退信、投递失败与无法送达的通知", color: "#d94a6a", icon: "alert",
          run: () => {
            mailCenterState.tab = "inbox";
            mailCenterState.folder = "inbox";
            mailCenterState.direction = "";
            mailCenterState.keyword = "undeliverable";
            renderMailCenterPage();
            void loadMailCenterMessages();
          }
        }
      ]
    }
  ];
}

// ── 工具箱 ──────────────────────────────────────────────────────────────────

/** 最近使用：只存 key，顺序靠前；隐私模式写不进去也不影响使用 */
const MC_TOOL_RECENT_KEY = "gj_mc_recent_tools";

function mcToolRecentKeys(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(MC_TOOL_RECENT_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string" && Boolean(key)).slice(0, 6);
  } catch {
    return [];
  }
}

function mcToolRemember(key: string) {
  if (!key) return;
  const next = [key, ...mcToolRecentKeys().filter((item) => item !== key)].slice(0, 6);
  try {
    localStorage.setItem(MC_TOOL_RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 写不进去就算了，最近使用只是锦上添花 */
  }
}

function mcToolAll(): MailCenterTool[] {
  return mailCenterToolSections().flatMap((section) => section.items);
}

/** 只高亮第一处命中的关键词；两边都过 escapeHtml，长度口径一致，不会切到实体中间 */
function mcToolHighlight(text: string, keyword: string) {
  const safe = escapeHtml(text);
  if (!keyword) return safe;
  const needle = escapeHtml(keyword);
  const at = safe.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return safe;
  return `${safe.slice(0, at)}<mark>${safe.slice(at, at + needle.length)}</mark>${safe.slice(at + needle.length)}`;
}

const MC_TOOL_SUGGESTS = ["写信", "总结", "翻译", "追踪", "退信"];

function renderMailCenterToolbox() {
  const body = qs<HTMLElement>("#mcTabBody");
  if (!body) return;
  const sections = mailCenterToolSections();
  const total = sections.reduce((sum, section) => sum + section.items.length, 0);

  body.innerHTML = `
    <div class="mc-toolbox">
      <div class="mc-tool-bar">
        <div class="mc-tool-search">
          ${mcIcon("search")}
          <input id="mcToolSearch" placeholder="搜索工具：写信、总结、翻译、退信…" value="${escapeHtml(mailCenterState.toolKeyword)}" autocomplete="off" aria-label="搜索工具">
          <button class="mc-tool-clear" type="button" data-mc-tool-clear-search aria-label="清空搜索">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>
          </button>
        </div>
        <span class="mc-tool-total">共 <b>${total}</b> 个工具</span>
      </div>
      <div id="mcToolResults">${renderMailCenterToolResults()}</div>
    </div>`;
}

/** 只重画结果区：搜索输入时不能把整块换掉，否则光标和焦点都会丢 */
function renderMailCenterToolResults() {
  const keyword = mailCenterState.toolKeyword.trim();
  const needle = keyword.toLowerCase();
  const sections = mailCenterToolSections()
    .map((section) => ({
      ...section,
      items: needle
        ? section.items.filter((item) => `${item.name} ${item.desc}`.toLowerCase().includes(needle))
        : section.items
    }))
    .filter((section) => section.items.length);

  const recent = (!needle ? mcToolRecentKeys() : [])
    .map((key) => mcToolAll().find((item) => item.key === key))
    .filter((item): item is MailCenterTool => Boolean(item))
    .slice(0, 5);
  const recentHtml = recent.length
    ? `<section class="mc-tool-recent">
        <span class="mc-tool-recent-label">${mcIcon("clock")}最近使用</span>
        <div class="mc-tool-recent-list">
          ${recent.map((item) => `<button type="button" class="mc-tool-pill" data-mc-tool="${escapeHtml(item.key)}" style="--mc-tool-color:${item.color}">
            <span class="mc-tool-pill-icon">${mcIcon(item.icon)}</span>${escapeHtml(item.name)}
          </button>`).join("")}
        </div>
        <button class="mc-tool-link" type="button" data-mc-tool-clear>清空</button>
      </section>`
    : "";

  let index = 0;
  const html = sections.map((section) => {
    // 推荐位是横排大卡：一屏 3 个，跟下面 4 列的小卡不是同一种网格
    const hero = Boolean(section.items[0]?.featured);
    return `
    <section class="mc-tool-section">
      <div class="mc-tool-section-head">
        <b>${escapeHtml(section.title)}</b>
        <span>${escapeHtml(section.note)}</span>
        <i aria-hidden="true"></i>
      </div>
      <div class="mc-tool-grid ${hero ? "mc-tool-hero-grid" : ""}">
        ${section.items.map((item) => {
          const order = index++;
          return `<button class="mc-tool ${item.featured ? "is-featured" : ""}" type="button" data-mc-tool="${escapeHtml(item.key)}" style="--mc-tool-color:${item.color};--mc-i:${order}">
            <span class="mc-tool-icon">${mcIcon(item.icon)}</span>
            <span class="mc-tool-body">
              <b>${mcToolHighlight(item.name, keyword)}${item.badge ? `<em>${escapeHtml(item.badge)}</em>` : ""}</b>
              <span>${mcToolHighlight(item.desc, keyword)}</span>
            </span>
            <span class="mc-tool-go" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 16.5 16.5 7.5"/><path d="M9.5 7.5h7v7"/></svg></span>
          </button>`;
        }).join("")}
      </div>
    </section>`;
  }).join("");

  const empty = `<div class="mc-tool-empty">
    <span class="mc-tool-empty-icon">${mcIcon("search")}</span>
    <b>没有找到「${escapeHtml(keyword || "这个分类")}」相关的工具</b>
    <span>换个说法试试，或者从下面这些常用词里挑</span>
    <div class="mc-tool-empty-keys">
      ${MC_TOOL_SUGGESTS.map((word) => `<button type="button" data-mc-tool-suggest="${escapeHtml(word)}">${escapeHtml(word)}</button>`).join("")}
    </div>
  </div>`;

  return `<div class="mc-tool-results">${recentHtml}${html || empty}</div>`;
}

// ── AI 邮件助手 ─────────────────────────────────────────────────────────────
//
// 六个动作共用同一个抽屉：左边选动作，中间放素材，右下出结果。
// 之所以不做成六个独立弹窗，是因为业务员真正的工作流是「读一封客户信 → 换个动作
// 试第二遍」，来回切换动作时素材必须留在原地。
//
// ⚠️ 这是邮件中心里唯一会把正文交给模型的地方（本机 CLI，用户点「生成」才触发），
// 界面必须写清楚，结果也不落库、不自动发送。

const MC_ASSIST_ACTIONS: Array<{ key: MailAssistAction; label: string; hint: string; placeholder: string }> = [
  {
    key: "draft", label: "AI 写信", hint: "按要点写一封可直接发出的邮件",
    placeholder: "写给谁、想说什么。例如：DENSI 询 2000 台，先确认型号与交期，语气客气但不催"
  },
  {
    key: "summarize", label: "AI 总结", hint: "长邮件压成几条要点",
    placeholder: "粘贴客户来信，或在收件箱里选一封再点进来"
  },
  {
    key: "polish", label: "AI 润色", hint: "措辞更清楚、更专业，不增删事实",
    placeholder: "粘贴你写好的邮件，我改措辞不改意思"
  },
  {
    key: "continue", label: "AI 续写", hint: "从断点接着写完",
    placeholder: "粘贴写到一半的邮件，我接着往下写"
  },
  {
    key: "translate", label: "AI 翻译", hint: "中英互译，保留结构与数字",
    placeholder: "中文自动译成英文，英文自动译成中文"
  },
  {
    key: "optimize", label: "AI 英文优化", hint: "改成地道商务英语，去掉中式表达",
    placeholder: "粘贴英文草稿，我改成母语级的商务表达"
  }
];

function mcAssistMeta(action: MailAssistAction) {
  return MC_ASSIST_ACTIONS.find((item) => item.key === action) || MC_ASSIST_ACTIONS[0];
}

/** 抽屉开着时按 Esc 关闭。必须挂在 document 上：切动作会重绘抽屉，
 *  被点的按钮随即被替换掉，焦点掉回 body，page 上的 keydown 就收不到了。 */
let mcAssistKeyHandler: ((event: KeyboardEvent) => void) | null = null;

function bindMailCenterAssistKeys() {
  if (mcAssistKeyHandler) return;
  mcAssistKeyHandler = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !mailCenterState.assistOpen) return;
    event.stopPropagation();
    closeMailCenterAssist();
  };
  document.addEventListener("keydown", mcAssistKeyHandler);
}

function unbindMailCenterAssistKeys() {
  if (!mcAssistKeyHandler) return;
  document.removeEventListener("keydown", mcAssistKeyHandler);
  mcAssistKeyHandler = null;
}

/** 打开抽屉：默认把当前选中那封邮件带进来（用户改过就不覆盖） */
function openMailCenterAssist(action: MailAssistAction) {
  const message = mailCenterState.activeMessage;
  mailCenterState.assistOpen = true;
  mailCenterState.assistAction = action;
  mailCenterState.assistError = "";
  if (message && message.id !== mailCenterState.assistMessageId) {
    mailCenterState.assistSource = mcPlainText(message.bodyText || message.snippet || "");
    mailCenterState.assistSourceLabel = `${message.subject || "(无主题)"} · ${message.fromName || message.fromAddress}`;
    mailCenterState.assistMessageId = message.id;
    mailCenterState.assistResult = "";
  }
  bindMailCenterAssistKeys();
  renderMailCenterAssist();
  window.setTimeout(() => qs<HTMLTextAreaElement>("#mcAssistSource")?.focus(), 30);
}

function closeMailCenterAssist() {
  mailCenterState.assistOpen = false;
  unbindMailCenterAssistKeys();
  renderMailCenterAssist();
}

function renderMailCenterAssist() {
  const mount = qs<HTMLElement>("#mcAssistant");
  if (!mount) return;
  if (!mailCenterState.assistOpen) {
    mount.innerHTML = "";
    return;
  }
  const action = mailCenterState.assistAction;
  const meta = mcAssistMeta(action);
  const source = mailCenterState.assistSource;
  const tabs = MC_ASSIST_ACTIONS.map((item) => `
    <button type="button" class="mc-assist-tab ${item.key === action ? "is-active" : ""}" data-mc-assist-action="${item.key}" aria-pressed="${item.key === action}">
      ${item.label}
    </button>`).join("");

  mount.innerHTML = `
    <div class="mc-assist-mask" data-mc-assist-close></div>
    <aside class="mc-assist" role="dialog" aria-modal="true" aria-label="AI 邮件助手">
      <header class="mc-assist-head">
        <span class="mc-assist-mark">${mcIcon("ai")}</span>
        <div class="mc-assist-title">
          <b>AI 邮件助手</b>
          <small>${escapeHtml(meta.hint)}</small>
        </div>
        <button type="button" class="mc-assist-x" data-mc-assist-close aria-label="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>
        </button>
      </header>
      <div class="mc-assist-tabs" role="tablist" aria-label="AI 动作">${tabs}</div>
      ${action === "draft" ? `<div class="mc-assist-lang">
        <span>写成</span>
        <button type="button" class="${mailCenterState.assistLang === "en" ? "is-active" : ""}" data-mc-assist-lang="en">英文</button>
        <button type="button" class="${mailCenterState.assistLang === "zh" ? "is-active" : ""}" data-mc-assist-lang="zh">中文</button>
      </div>` : ""}
      <div class="mc-assist-field">
        <div class="mc-assist-field-head">
          <b>${action === "draft" ? "这封信要说什么" : "要处理的邮件内容"}</b>
          <span>${escapeHtml(mailCenterState.assistSourceLabel || "手动粘贴")}</span>
        </div>
        <textarea id="mcAssistSource" spellcheck="false" placeholder="${escapeHtml(meta.placeholder)}">${escapeHtml(source)}</textarea>
      </div>
      <div class="mc-assist-bar">
        <button class="btn primary" type="button" data-mc-assist-run ${mailCenterState.assistLoading || !source.trim() ? "disabled" : ""}>
          ${mailCenterState.assistLoading ? "正在生成…" : "生成"}
        </button>
        <button class="btn" type="button" data-mc-assist-pull>取当前选中的邮件</button>
        <span class="mc-assist-note">只在这一步把这段文字交给本机 CLI 的模型；结果不落库，也不会自动发出去</span>
      </div>
      <div class="mc-assist-out" id="mcAssistOut">${mcAssistOutHtml()}</div>
    </aside>`;
}

/** 结果区单独重画：生成过程中只换这一块，输入框的滚动位置和光标都不动 */
function mcAssistOutHtml() {
  if (mailCenterState.assistLoading) {
    return `<div class="mc-assist-loading">
      <i></i><i></i><i></i>
      <span>正在让模型读这封邮件…本机 CLI 首次调用大约 5–10 秒</span>
    </div>`;
  }
  if (mailCenterState.assistError) {
    return `<div class="mc-assist-error">
      <b>没生成出来</b>
      <span>${escapeHtml(mailCenterState.assistError)}</span>
      <button type="button" class="btn" data-mc-assist-run>再试一次</button>
    </div>`;
  }
  if (!mailCenterState.assistResult.trim()) {
    return `<div class="mc-assist-idle">
      <span>${mcIcon("ai")}</span>
      <b>结果会出现在这里</b>
      <span>生成后可以一键复制，或带着客户去写信页继续改</span>
    </div>`;
  }
  return `<div class="mc-assist-result">
    <div class="mc-assist-result-head">
      <b>生成结果</b>
      <span class="mc-grow"></span>
      <button type="button" class="mc-assist-mini" data-mc-assist-copy>复制</button>
      <button type="button" class="mc-assist-mini" data-mc-assist-write>去写信</button>
    </div>
    <div class="mc-assist-text">${escapeHtml(mailCenterState.assistResult)}</div>
  </div>`;
}

async function runMailCenterAssist() {
  const text = mailCenterState.assistSource.trim();
  if (!text || mailCenterState.assistLoading) return;
  mailCenterState.assistLoading = true;
  mailCenterState.assistError = "";
  mailCenterState.assistResult = "";
  refreshMailCenterAssistOut();
  try {
    const result = await api<{ text: string }>("/api/mail-center/assist", {
      method: "POST",
      body: JSON.stringify({
        action: mailCenterState.assistAction,
        text,
        messageId: mailCenterState.assistMessageId,
        lang: mailCenterState.assistLang
      })
    });
    mailCenterState.assistResult = mcPlainText(result.text || "").trim();
    if (!mailCenterState.assistResult) mailCenterState.assistError = "模型返回了空内容，换个动作或补几句素材再试";
  } catch (error) {
    mailCenterState.assistError = error instanceof Error ? error.message : "AI 生成失败";
  } finally {
    mailCenterState.assistLoading = false;
    refreshMailCenterAssistOut();
  }
}

/** 只换结果区 + 主按钮文案；抽屉其余部分保持不动 */
function refreshMailCenterAssistOut() {
  const out = qs<HTMLElement>("#mcAssistOut");
  if (out) out.innerHTML = mcAssistOutHtml();
  const run = qs<HTMLButtonElement>("[data-mc-assist-run]");
  if (run) {
    run.disabled = mailCenterState.assistLoading || !mailCenterState.assistSource.trim();
    run.textContent = mailCenterState.assistLoading ? "正在生成…" : "生成";
  }
}

/** 把当前选中邮件的正文抓进抽屉；没选就如实说一句 */
function pullMailCenterAssistMessage() {
  const message = mailCenterState.activeMessage || mailCenterState.messages.find((item) => item.id === mailCenterState.activeMessageId);
  if (!message) {
    toast("收件箱里还没选中邮件", "error");
    return;
  }
  mailCenterState.assistSource = mcPlainText(message.bodyText || message.snippet || "");
  mailCenterState.assistSourceLabel = `${message.subject || "(无主题)"} · ${message.fromName || message.fromAddress}`;
  mailCenterState.assistMessageId = message.id;
  mailCenterState.assistResult = "";
  mailCenterState.assistError = "";
  renderMailCenterAssist();
}

async function copyMailCenterAssistResult() {
  const text = mailCenterState.assistResult.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板", "success");
  } catch {
    // 非 https / 无权限时退化到手动选中
    const box = qs<HTMLElement>(".mc-assist-text");
    if (box) {
      const range = document.createRange();
      range.selectNodeContents(box);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      toast("已选中结果，按 ⌘C 复制", "success");
    }
  }
}


// ── 数据加载 ────────────────────────────────────────────────────────────────

export async function loadMailCenter(options: { silent?: boolean } = {}) {
  const page = qs<HTMLElement>("#mailCenterPage");
  if (!page) return;
  if (!mailCenterState.loaded) {
    page.innerHTML = `<div class="mc-empty"><b>正在加载邮件中心…</b><span>读取邮箱账号与收件索引</span></div>`;
  }
  try {
    await loadMailCenterAccounts();
    await loadMailCenterFolders().catch(() => undefined);
    if (!mailCenterState.loaded) mailCenterState.loaded = true;
    renderMailCenterPage();
    if (mailCenterState.tab === "inbox") await loadMailCenterMessages({ silent: true });
    if (mailCenterState.tab === "lookup" || mailCenterState.tab === "journey") await loadMailCenterLookup({ silent: true });
    if (mailCenterState.journeyKey) {
      // 键里带视角前缀：entity=客户档案 / person=发信人 / thread=单封线程
      const [kind, ...rest] = mailCenterState.journeyKey.split(":");
      if (kind === "entity" && rest.length > 1) {
        await loadMailCenterJourney(rest[0], rest.slice(1).join(":"));
      } else if ((kind === "person" || kind === "thread") && rest.length) {
        await loadMailCenterMessageJourney(rest.join(":"), kind);
      }
    }
    updateMailCenterNavBadge();
  } catch (error) {
    if (!options.silent) toast(error instanceof Error ? error.message : "邮件中心加载失败", "error");
    page.innerHTML = `<div class="mc-empty"><b>邮件中心加载失败</b><span>${escapeHtml(error instanceof Error ? error.message : "未知错误")}</span><button class="btn" type="button" data-mc-action="reload">重试</button></div>`;
    bindMailCenterPage();
  }
}

async function loadMailCenterAccounts() {
  const result = await api<{ accounts: MailCenterAccount[] }>("/api/mail-center/accounts");
  mailCenterState.accounts = result.accounts || [];
  // 账号被删掉后筛选条件还留着，会让收件箱永远空着（且界面上找不到原因）
  if (mailCenterState.activeAccountId
    && !mailCenterState.accounts.some((account) => account.id === mailCenterState.activeAccountId)) {
    mailCenterState.activeAccountId = "";
  }
  const list = qs<HTMLElement>("#mcAccountList");
  if (list) list.innerHTML = renderMailCenterAccounts();
  updateMailCenterNavBadge();
}

function updateMailCenterNavBadge() {
  const badge = qs<HTMLElement>("#mailCenterNavUnread");
  if (!badge) return;
  const unread = mailCenterState.accounts.reduce((sum, account) => sum + Number(account.unreadMessages || 0), 0);
  badge.textContent = unread > 99 ? "99+" : String(unread);
  badge.hidden = unread <= 0;
}

async function loadMailCenterFolders() {
  const params = new URLSearchParams();
  if (mailCenterState.activeAccountId) params.set("mailboxId", mailCenterState.activeAccountId);
  const result = await api<{ folders: Array<{ kind: string; label: string; total: number; unread: number }> }>(
    `/api/mail-center/folders?${params.toString()}`
  );
  mailCenterState.folders = result.folders || [];
  const tabs = qs<HTMLElement>(".mc-folders");
  if (tabs) tabs.innerHTML = renderMailCenterFolderTabs();
  refreshMailCenterInboxTab();
}

async function loadMailCenterMessages(options: { silent?: boolean; focusId?: string } = {}) {
  mailCenterState.loading = true;
  renderMailCenterMessageList();
  try {
    const params = new URLSearchParams({ limit: "40", folder: mailCenterState.folder || "inbox" });
    if (mailCenterState.activeAccountId) params.set("mailboxId", mailCenterState.activeAccountId);
    // 已发送里全是自己发出的信，方向筛选没有意义
    if (mailCenterState.folder !== "sent" && mailCenterState.direction) params.set("direction", mailCenterState.direction);
    if (mailCenterState.keyword.trim()) params.set("q", mailCenterState.keyword.trim());
    // 从交互旅程定位过来：这封信可能排在第 200 位，让服务端把这一行补进首屏
    if (options.focusId) params.set("focusId", options.focusId);
    const result = await api<{ messages: MailCenterMessage[]; total: number }>(`/api/mail-center/messages?${params.toString()}`);
    mailCenterState.messages = result.messages || [];
    mailCenterState.total = Number(result.total || 0);
    if (mailCenterState.activeMessageId
      && !mailCenterState.messages.some((message) => message.id === mailCenterState.activeMessageId)) {
      mailCenterState.activeMessage = null;
      mailCenterState.activeMessageId = "";
    }
    const count = qs<HTMLElement>("#mcInboxCount");
    if (count) count.textContent = `${mailCenterState.total} 封`;
    const title = qs<HTMLElement>("#mcFolderTitle");
    if (title) title.textContent = mcFolderLabel(mailCenterState.folder);
    // 首屏 folders 请求先于列表返回，这里再校一次页签数字，避免刚进来显示 0
    if (!mailCenterState.folders.length) {
      void loadMailCenterFolders().catch(() => undefined);
    }
    refreshMailCenterInboxTab();
  } catch (error) {
    if (!options.silent) toast(error instanceof Error ? error.message : "邮件列表加载失败", "error");
  } finally {
    mailCenterState.loading = false;
    renderMailCenterMessageList();
    renderMailCenterMessageDetail();
  }
}

async function openMailCenterMessage(id: string) {
  if (!id) return;
  // 正在写邮件时点了另一封：先把草稿存掉、收起写信区，再打开新邮件
  if (document.getElementById("mcComposePane")) closeComposeDrawer();
  mailCenterState.activeMessageId = id;
  mailCenterState.journeyMenuOpen = false;
  const cached = mailCenterState.messages.find((message) => message.id === id) || null;
  mailCenterState.activeMessage = cached;
  renderMailCenterMessageList();
  renderMailCenterMessageDetail();
  try {
    const result = await api<{ message: MailCenterMessage }>(`/api/mail-center/messages/${encodeURIComponent(id)}`);
    if (mailCenterState.activeMessageId !== id) return;
    mailCenterState.activeMessage = result.message;
    renderMailCenterMessageDetail();
    const target = mailCenterState.messages.find((message) => message.id === id);
    if (target && !target.readAt) {
      target.readAt = new Date().toISOString();
      renderMailCenterMessageList();
      void api(`/api/mail-center/messages/${encodeURIComponent(id)}/read`, { method: "POST", body: "{}" })
        .then(() => loadMailCenterAccounts())
        .catch(() => undefined);
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : "邮件加载失败", "error");
  }
}

/**
 * 点账号卡 = 把邮件列表切到只看这个邮箱；再点一次收回「全部邮箱」。
 * 卡片高亮、筛选下拉、列表三者必须同时变 —— 只改 state 不重绘，就是用户说的
 * 「点了切换邮箱，下面邮件不刷新」。
 */
function selectMailCenterAccount(id: string) {
  const next = mailCenterState.activeAccountId === id ? "" : id;
  const account = mailCenterState.accounts.find((item) => item.id === next);
  mailCenterState.activeAccountId = next;
  // 换账号等于换了一份数据源：右边那封详情不能还挂着上一个邮箱的正文
  mailCenterState.activeMessageId = "";
  mailCenterState.activeMessage = null;
  const list = qs<HTMLElement>("#mcAccountList");
  if (list) list.innerHTML = renderMailCenterAccounts();
  if (mailCenterState.tab === "inbox") {
    // 范围徽章 / 筛选下拉 / 列表占位都在 tabBody 里
    renderMailCenterTabBody();
  }
  toast(next
    ? `已切到「${account?.label || account?.email}」，只看这个邮箱的邮件`
    : "已切回全部邮箱", "info");
  void loadMailCenterFolders().catch(() => undefined);
  if (mailCenterState.tab === "inbox") void loadMailCenterMessages({ silent: true });
}

async function runMailCenterSync(accountId: string) {
  const targets = accountId
    ? mailCenterState.accounts.filter((account) => account.id === accountId)
    : mailCenterState.accounts.filter((account) => account.syncEnabled);
  if (!targets.length) {
    toast("还没有可同步的邮箱，先绑定一个账号", "error");
    return;
  }
  mailCenterState.syncing = accountId || "all";
  const list = qs<HTMLElement>("#mcAccountList");
  if (list) list.innerHTML = renderMailCenterAccounts();
  toast(accountId ? "正在连接邮箱并拉取收件…" : `正在依次同步 ${targets.length} 个邮箱…`, "info");
  let saved = 0;
  let failed = 0;
  let lastError = "";
  for (const account of targets) {
    try {
      const result = await api<{ summary: { saved: number } }>(`/api/mail-center/accounts/${encodeURIComponent(account.id)}/sync`, {
        method: "POST",
        body: "{}"
      });
      saved += Number(result.summary?.saved || 0);
    } catch (error) {
      failed += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  mailCenterState.syncing = "";
  await loadMailCenterAccounts();
  await loadMailCenterFolders().catch(() => undefined);
  if (mailCenterState.tab === "inbox") await loadMailCenterMessages({ silent: true });
  if (failed) {
    toast(`${targets.length - failed} 个邮箱同步完成，${failed} 个失败：${lastError}`, "error");
  } else {
    toast(`同步完成，新增 ${saved} 封邮件`, "success");
  }
}

async function runMailCenterCheck(accountId: string) {
  const account = mailCenterState.accounts.find((item) => item.id === accountId);
  if (!account) return;
  mailCenterState.syncing = accountId;
  const list = qs<HTMLElement>("#mcAccountList");
  if (list) list.innerHTML = renderMailCenterAccounts();
  try {
    const result = await api<{ ok: boolean; host: string; inboxMessages: number; folders: Array<{ path: string }> }>(
      `/api/mail-center/accounts/${encodeURIComponent(accountId)}/check`,
      { method: "POST", body: "{}" }
    );
    openModal("邮箱体检结果", `
      <div class="mc-form-note" style="margin-bottom:10px">
        <b>${escapeHtml(account.email)}</b> 连接正常。<br>
        IMAP 主机：${escapeHtml(result.host)} · 收件箱 ${result.inboxMessages} 封 · 可见文件夹 ${result.folders.length} 个
      </div>
      <div style="max-height:220px;overflow:auto;font-size:12px;color:#5b7591;line-height:1.9">
        ${result.folders.slice(0, 20).map((folder) => `<div>${escapeHtml(folder.path)}</div>`).join("")}
      </div>`, `<button class="btn primary" data-modal-close>知道了</button>`);
    qsa<HTMLElement>("[data-modal-close]", qs("#appModal") || document).forEach((node) => {
      node.addEventListener("click", closeModal);
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : "邮箱体检失败", "error");
  } finally {
    mailCenterState.syncing = "";
    if (list) list.innerHTML = renderMailCenterAccounts();
  }
}

async function loadMailCenterLookup(options: { silent?: boolean } = {}) {
  mailCenterState.lookupLoading = true;
  renderMailCenterLookupList();
  renderMailCenterJourneyList();
  try {
    const params = new URLSearchParams({ q: mailCenterState.lookupKeyword.trim(), withMail: "1" });
    const result = await api<{ items: MailCenterCustomerItem[] }>(`/api/mail-center/customers?${params.toString()}`);
    mailCenterState.lookupItems = result.items || [];
  } catch (error) {
    if (!options.silent) toast(error instanceof Error ? error.message : "客户检索失败", "error");
  } finally {
    mailCenterState.lookupLoading = false;
    renderMailCenterLookupList();
    renderMailCenterJourneyList();
  }
}

async function openMailCenterCustomer(entityType: string, entityId: string) {
  mailCenterState.lookupActive = `${entityType}:${entityId}`;
  mailCenterState.lookupDetail = null;
  renderMailCenterLookupList();
  renderMailCenterLookupDetail();
  try {
    const result = await api<MailCenterCustomerDetail>(
      `/api/mail-center/customer/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`
    );
    if (mailCenterState.lookupActive !== `${entityType}:${entityId}`) return;
    mailCenterState.lookupDetail = result;
    renderMailCenterLookupDetail();
  } catch (error) {
    toast(error instanceof Error ? error.message : "客户邮件加载失败", "error");
  }
}

async function loadMailCenterJourney(entityType: string, entityId: string) {
  const key = `entity:${entityType}:${entityId}`;
  mailCenterState.journeyKey = key;
  mailCenterState.journeyLoading = true;
  mailCenterState.journey = null;
  // 换了客户，上一家选中的事件 id 就没意义了，让渲染自己落到最近一条
  mailCenterState.journeyEventId = "";
  renderMailCenterJourneyList();
  renderMailCenterJourneyDetail();
  try {
    const result = await api<MailCenterJourney>(
      `/api/mail-center/journey/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`
    );
    if (mailCenterState.journeyKey !== key) return;
    mailCenterState.journey = result;
    refreshMailCenterJourneyHint();
    renderMailCenterJourneyDetail();
  } catch (error) {
    mailCenterState.journeyLoading = false;
    toast(error instanceof Error ? error.message : "旅程加载失败", "error");
    renderMailCenterJourneyDetail();
  } finally {
    mailCenterState.journeyLoading = false;
    renderMailCenterJourneyDetail();
  }
}

/**
 * 以某一封信为起点生成旅程：切到旅程页签 + 拉「按往来地址归集」的旅程。
 * 入口在邮件阅读栏的「形成旅程」按钮上 —— 原先只有归属了客户的信才能看旅程，
 * 没有归属的来信（新客户、退信、陌生询盘）就断在收件箱里了。
 */
async function loadMailCenterMessageJourney(messageId: string, scope: "person" | "thread" = "person") {
  if (!messageId) return;
  // 两个视角各自缓存键：切回「发信人」时不会被线程请求的返回盖掉
  const key = `${scope}:${messageId}`;
  mailCenterState.tab = "journey";
  mailCenterState.journeyMenuOpen = false;
  mailCenterState.journeyKey = key;
  mailCenterState.journeyLoading = true;
  mailCenterState.journey = null;
  mailCenterState.journeyEventId = "";
  mailCenterState.lookupKeyword = "";
  renderMailCenterPage();
  renderMailSectionNav();
  renderMailCenterJourneyList();
  renderMailCenterJourneyDetail();
  // 左侧客户名单顺手补一次：旅程页签的骨架是「左选主体、右看时间线」
  void loadMailCenterLookup({ silent: true });
  try {
    const result = await api<MailCenterJourney>(
      `/api/mail-center/journey/message/${encodeURIComponent(messageId)}?scope=${scope}`
    );
    if (mailCenterState.journeyKey !== key) return;
    mailCenterState.journey = result;
    mailCenterState.journeyEventId = result.anchorEventId
      || result.events.find((event) => event.mailId === messageId)?.id
      || "";
    refreshMailCenterJourneyHint();
  } catch (error) {
    toast(error instanceof Error ? error.message : "旅程加载失败", "error");
  } finally {
    if (mailCenterState.journeyKey === key) {
      mailCenterState.journeyLoading = false;
      renderMailCenterJourneyDetail();
      scrollMailCenterJourneyIntoView();
    }
  }
}

/**
 * 窄屏（< 1180px）时旅程详情会落到客户列表下面，点完按钮看不到结果 —— 等于"点了没反应"。
 * 只在详情确实不在视野内时把主滚动容器带到它头上，桌面宽屏不动。
 */
function scrollMailCenterJourneyIntoView() {
  const panel = qs<HTMLElement>("#mcJourneyDetail");
  if (!panel || !panel.isConnected) return;
  const rect = panel.getBoundingClientRect();
  if (rect.top >= 0 && rect.top < window.innerHeight * 0.55) return;
  const scroller = document.querySelector<HTMLElement>(".main");
  if (scroller && scroller.contains(panel)) {
    const offset = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
    scroller.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
    return;
  }
  window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - 12), behavior: "smooth" });
}

/** 从「邮件起点」的旅程回到那封信：按方向落回收件箱/已发送，再定位 */
function backToJourneySourceMail() {
  const journey = mailCenterState.journey;
  const anchorId = journey?.anchorEventId
    || journey?.events.find((event) => event.mailId === journey?.anchorMailId)?.id
    || "";
  if (anchorId) {
    void locateMailCenterJourneyEvent(anchorId);
    return;
  }
  const mailId = journey?.anchorMailId || "";
  if (!mailId) return;
  mailCenterState.tab = "inbox";
  mailCenterState.folder = "inbox";
  mailCenterState.direction = "";
  mailCenterState.keyword = "";
  mailCenterState.locatedMessageId = mailId;
  renderMailCenterPage();
  renderMailSectionNav();
  void loadMailCenterMessages({ silent: true, focusId: mailId }).then(() => openMailCenterMessage(mailId));
}

/** 署名尾缀：优先用个人设置里维护的邮件签名（emailSignature），没设置才回落账号名+邮箱；
 *  随正文一起可编辑（富文本编辑器用 HTML 形态） */
function mcComposeSignatureLines(account: MailCenterAccount | undefined) {
  const custom = (state.user?.emailSignature || "").trim();
  if (custom) return custom.split(/\r?\n/).slice(0, 8).filter((line) => line.trim());
  return [account?.fromName?.trim() || "", account?.email || ""].filter(Boolean);
}

function mcComposeSignatureHtml(account: MailCenterAccount | undefined) {
  const lines = mcComposeSignatureLines(account);
  return lines.length ? `<br><br>--<br>${lines.map(escapeHtml).join("<br>")}` : "";
}

/* ===== 写邮件：收件人 chips + CRM 联系人自动补全 ===== */

const mcChipsTokens = new WeakMap<HTMLElement, string[]>();
const MC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MC_DRAFT_KEY = "gj_mc_compose_draft";
// 就地回复的草稿按原信分开存，绝不串进「新写信」的草稿
const MC_REPLY_DRAFT_PREFIX = "gj_mc_reply_draft:";

/** 当前写信界面的根节点：阅读栏整块写信 / 就地回复 / 右下浮窗（三者互斥） */
function mcComposeRoot(): HTMLElement | null {
  return document.getElementById("mcComposePane")
    || document.getElementById("mcComposeInline")
    || document.getElementById("mcComposeDrawer");
}

/** 当前写信界面的草稿落在哪个 key：就地回复（按原信 id）或新写信 */
function mcComposeDraftKey() {
  const inline = document.getElementById("mcComposeInline");
  const forMessage = inline?.dataset.mcForMessage || "";
  return forMessage ? MC_REPLY_DRAFT_PREFIX + forMessage : MC_DRAFT_KEY;
}
const MC_ATTACH_MAX_TOTAL = 12 * 1024 * 1024;
const MC_ATTACH_MAX_ONE = 8 * 1024 * 1024;

interface McComposeAttachment { filename: string; size: number; contentBase64: string; contentType: string }
let mcComposeAttachments: McComposeAttachment[] = [];
let mcComposeDraftTimer = 0;

function mcSplitEmailText(raw: string) {
  return raw.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean);
}

/** 只提交合法地址，返回留在输入框里的残余（不合法不打断输入） */
function mcChipsCommitValid(box: HTMLElement, raw: string) {
  const tokens = mcChipsTokens.get(box) || [];
  let remainder = "";
  for (const part of mcSplitEmailText(raw)) {
    if (MC_EMAIL_RE.test(part)) {
      if (!tokens.includes(part)) tokens.push(part);
    } else {
      remainder += (remainder ? ", " : "") + part;
    }
  }
  mcChipsTokens.set(box, tokens);
  mcChipsRender(box);
  return remainder;
}

function mcChipsRender(box: HTMLElement) {
  const input = box.querySelector<HTMLInputElement>("input");
  if (!input) return;
  box.querySelectorAll(".mc-chip").forEach((node) => node.remove());
  for (const token of mcChipsTokens.get(box) || []) {
    const chip = document.createElement("span");
    chip.className = "mc-chip";
    const text = document.createElement("span");
    text.className = "mc-chip-text";
    text.textContent = token;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mc-chip-x";
    remove.title = "移除";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      mcChipsTokens.set(box, (mcChipsTokens.get(box) || []).filter((item) => item !== token));
      mcChipsRender(box);
      mcComposeDraftSaveSoon();
    });
    chip.append(text, remove);
    box.insertBefore(chip, input);
  }
}

function mcChipsValue(box: HTMLElement) {
  const input = box.querySelector<HTMLInputElement>("input");
  const typed = input ? input.value.trim() : "";
  return [...(mcChipsTokens.get(box) || []), ...mcSplitEmailText(typed)].join(",");
}

function mcChipsSetValues(box: HTMLElement, values: string[]) {
  mcChipsTokens.set(box, values.map((item) => item.trim()).filter(Boolean));
  mcChipsRender(box);
}

/** CRM 联系人自动补全：客户 + 线索（服务端 /api/mail-center/customers 全量拉一次，本地过滤） */
let mcContactPool: Array<{ email: string; label: string }> | null = null;

async function mcEnsureContactPool() {
  if (mcContactPool) return;
  try {
    const result = await api<{ items: MailCenterCustomerItem[] }>("/api/mail-center/customers?withMail=1");
    const pool = new Map<string, string>();
    for (const item of result.items || []) {
      const key = (item.email || "").trim().toLowerCase();
      if (!key || pool.has(key)) continue;
      pool.set(key, [item.company, item.contact].filter(Boolean).join(" · "));
    }
    mcContactPool = Array.from(pool, ([email, label]) => ({ email, label }));
  } catch {
    mcContactPool = [];
  }
}

function mcContactSuggestions(query: string, exclude: string[]) {
  const q = query.trim().toLowerCase();
  if (!q || !mcContactPool) return [];
  const out: Array<{ email: string; label: string }> = [];
  for (const item of mcContactPool) {
    if (exclude.includes(item.email)) continue;
    if (item.email.includes(q) || item.label.toLowerCase().includes(q)) {
      out.push(item);
      if (out.length >= 6) break;
    }
  }
  return out;
}

let mcSuggestState: { box: HTMLElement; items: Array<{ email: string; label: string }>; active: number; el: HTMLElement } | null = null;

function mcSuggestClose() {
  if (mcSuggestState) { mcSuggestState.el.remove(); mcSuggestState = null; }
}

function mcSuggestShow(box: HTMLElement, input: HTMLInputElement) {
  mcSuggestClose();
  const typed = mcSplitEmailText(input.value);
  const items = mcContactSuggestions(typed[typed.length - 1] || "", [...(mcChipsTokens.get(box) || []), ...typed]);
  if (!items.length) return;
  const el = document.createElement("div");
  el.className = "mc-suggest";
  items.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mc-suggest-item" + (index === 0 ? " is-active" : "");
    row.innerHTML = `<span class="mc-suggest-email"></span><small class="mc-suggest-label"></small>`;
    (row.querySelector(".mc-suggest-email") as HTMLElement).textContent = item.email;
    (row.querySelector(".mc-suggest-label") as HTMLElement).textContent = item.label;
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => {
      mcChipsTokens.set(box, [...(mcChipsTokens.get(box) || []), item.email]);
      input.value = "";
      mcChipsRender(box);
      mcSuggestClose();
      input.focus();
      mcComposeDraftSaveSoon();
    });
    el.appendChild(row);
  });
  document.body.appendChild(el);
  const rect = input.getBoundingClientRect();
  el.style.left = `${Math.round(rect.left)}px`;
  el.style.top = `${Math.round(rect.bottom + 4)}px`;
  el.style.minWidth = `${Math.max(260, Math.round(rect.width))}px`;
  mcSuggestState = { box, items, active: 0, el };
}

function mcSuggestMove(delta: number) {
  if (!mcSuggestState) return;
  mcSuggestState.active = (mcSuggestState.active + delta + mcSuggestState.items.length) % mcSuggestState.items.length;
  mcSuggestState.el.querySelectorAll(".mc-suggest-item").forEach((node, index) => {
    node.classList.toggle("is-active", index === mcSuggestState!.active);
  });
}

function mcSuggestPick() {
  if (!mcSuggestState) return false;
  const item = mcSuggestState.items[mcSuggestState.active];
  const box = mcSuggestState.box;
  const input = box.querySelector<HTMLInputElement>("input");
  if (item && input) {
    mcChipsTokens.set(box, [...(mcChipsTokens.get(box) || []), item.email]);
    input.value = "";
    mcChipsRender(box);
  }
  mcSuggestClose();
  input?.focus();
  mcComposeDraftSaveSoon();
  return true;
}

/** 把一个 chips 容器接上键盘/粘贴/补全行为 */
function mcChipsInit(box: HTMLElement) {
  const input = box.querySelector<HTMLInputElement>("input");
  if (!input) return;
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!mcSuggestState || mcSuggestState.box !== box) {
        void mcEnsureContactPool().then(() => mcSuggestShow(box, input));
      } else mcSuggestMove(1);
      return;
    }
    if (event.key === "ArrowUp") { event.preventDefault(); mcSuggestMove(-1); return; }
    if (event.key === "Escape") { mcSuggestClose(); return; }
    if (event.key === "Enter") {
      event.preventDefault();
      if (mcSuggestState && mcSuggestState.box === box && mcSuggestState.items.length) { mcSuggestPick(); return; }
      input.value = mcChipsCommitValid(box, input.value);
      mcComposeDraftSaveSoon();
      return;
    }
    if (event.key === "," || event.key === ";") {
      event.preventDefault();
      input.value = mcChipsCommitValid(box, input.value);
      mcSuggestClose();
      mcComposeDraftSaveSoon();
      return;
    }
    if (event.key === "Backspace" && !input.value) {
      const tokens = mcChipsTokens.get(box) || [];
      if (tokens.length) {
        mcChipsTokens.set(box, tokens.slice(0, -1));
        mcChipsRender(box);
        mcComposeDraftSaveSoon();
      }
    }
  });
  input.addEventListener("input", () => {
    if (/[,;\s]/.test(input.value)) input.value = mcChipsCommitValid(box, input.value);
    void mcEnsureContactPool().then(() => mcSuggestShow(box, input));
  });
  input.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") || "";
    if (!text) return;
    event.preventDefault();
    input.value = mcChipsCommitValid(box, text);
  });
  input.addEventListener("blur", () => {
    input.value = mcChipsCommitValid(box, input.value);
    window.setTimeout(() => { if (mcSuggestState && mcSuggestState.box === box) mcSuggestClose(); }, 120);
    mcComposeDraftSaveSoon();
  });
}

/* ===== 写邮件：草稿自动保存（localStorage，按账号恢复） ===== */

function mcComposeCollectDraft() {
  const toBox = qs<HTMLElement>("#mcComposeToBox");
  const ccBox = qs<HTMLElement>("#mcComposeCcBox");
  const bccBox = qs<HTMLElement>("#mcComposeBccBox");
  const editor = qs<HTMLElement>("#mcComposeBody");
  const root = mcComposeRoot();
  return {
    mailboxId: qs<HTMLSelectElement>("#mcComposeMailbox")?.value || "",
    to: toBox ? mcChipsValue(toBox) : "",
    cc: ccBox ? mcChipsValue(ccBox) : "",
    bcc: bccBox ? mcChipsValue(bccBox) : "",
    subject: qs<HTMLInputElement>("#mcComposeSubject")?.value.trim() || "",
    html: editor ? editor.innerHTML : "",
    // 会话线程头（回复/转发时随草稿保存，恢复后发送仍能归进原会话）
    inReplyTo: root?.dataset.mcInReplyTo || "",
    references: root?.dataset.mcReferences || "",
    ts: new Date().toISOString()
  };
}

function mcComposeDraftSaveSoon() {
  window.clearTimeout(mcComposeDraftTimer);
  mcComposeDraftTimer = window.setTimeout(mcComposeDraftSaveNow, 700);
}

export function mcComposeDraftSaveNow() {
  if (!qs("#mcComposeBody")) return;
  const draftKey = mcComposeDraftKey();
  const draft = mcComposeCollectDraft();
  const bodyText = (editorTextOf(draft.html) || "").replace(/\s|--/g, "").trim();
  if (!draft.to && !draft.cc && !draft.bcc && !draft.subject && !bodyText) {
    localStorage.removeItem(draftKey);
    return;
  }
  try {
    localStorage.setItem(draftKey, JSON.stringify(draft));
  } catch {
    // 正文里塞了大图（dataURL）可能超 localStorage 配额：去掉内嵌图再存一版
    try {
      localStorage.setItem(draftKey, JSON.stringify({ ...draft, html: draft.html.replace(/<img[^>]*>/g, "") }));
    } catch { /* 实在存不下就放弃，不影响编辑 */ }
  }
  const state = qs<HTMLElement>("#mcComposeDraftState");
  if (state) {
    state.textContent = `草稿已保存 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    state.classList.add("is-visible");
    window.setTimeout(() => state.classList.remove("is-visible"), 2200);
  }
}

/** 富文本片段转纯文本（草稿判空用） */
function editorTextOf(html: string) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

function mcFormatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function mcRenderAttachList() {
  const list = qs<HTMLElement>("#mcAttachList");
  if (!list) return;
  list.innerHTML = mcComposeAttachments.map((item, index) => `
    <span class="mc-attach-chip" title="${escapeHtml(item.filename)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      <span class="mc-attach-name">${escapeHtml(item.filename)}</span>
      <small>${mcFormatSize(item.size)}</small>
      <button type="button" class="mc-attach-x" data-mc-attach-remove="${index}" title="移除附件">×</button>
    </span>`).join("");
  qsa<HTMLElement>("[data-mc-attach-remove]", list).forEach((node) => {
    node.addEventListener("click", () => {
      mcComposeAttachments.splice(Number(node.dataset.mcAttachRemove), 1);
      mcRenderAttachList();
    });
  });
}

function mcAddComposeFiles(files: File[]) {
  for (const file of files) {
    if (file.size > MC_ATTACH_MAX_ONE) { toast(`「${file.name}」超过单文件 8MB 上限`, "error"); continue; }
    if (mcComposeAttachments.reduce((sum, item) => sum + item.size, 0) + file.size > MC_ATTACH_MAX_TOTAL) {
      toast("附件总大小超过 12MB 上限", "error");
      break;
    }
    const item: McComposeAttachment = { filename: file.name, size: file.size, contentBase64: "", contentType: file.type || "application/octet-stream" };
    mcComposeAttachments.push(item);
    mcRenderAttachList();
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      item.contentBase64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
      mcRenderAttachList();
    };
    reader.onerror = () => toast(`「${file.name}」读取失败`, "error");
    reader.readAsDataURL(file);
  }
}

/** 通讯录选人：从客户/线索邮箱里挑人，一键加入收件人/抄送/密送。
 *  CRM 邮件的核心优势就是联系人都在库里，不该逼用户手打地址。 */
function openMailCenterContactPicker() {
  const toBox = qs<HTMLElement>("#mcComposeToBox");
  const ccBox = qs<HTMLElement>("#mcComposeCcBox");
  const bccBox = qs<HTMLElement>("#mcComposeBccBox");
  if (!toBox || !ccBox || !bccBox) { toast("写信界面已关闭", "warn"); return; }
  openModal("从通讯录添加联系人", `
    <div class="mc-picker">
      <div class="mc-picker-bar">
        <input id="mcPickerSearch" type="text" placeholder="搜公司、联系人或邮箱">
        <select id="mcPickerTarget" title="选中的地址加到哪一行">
          <option value="to">加入收件人</option>
          <option value="cc">加入抄送</option>
          <option value="bcc">加入密送</option>
        </select>
      </div>
      <div class="mc-picker-list" id="mcPickerList"><div class="mc-picker-loading">正在读取通讯录…</div></div>
      <div class="mc-picker-count" id="mcPickerCount"></div>
    </div>`,
    `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="mcPickerAdd">添加所选</button>`);
  // 弹窗挂在 #appModal，不在 #mail-center 子树里，--mc-* 令牌必须自带
  qs("#appModal .modal")?.classList.add("mail-center-compose-modal");
  qsa<HTMLElement>("[data-modal-close]", qs("#appModal") || document).forEach((node) => {
    node.addEventListener("click", closeModal);
  });
  const listEl = qs<HTMLElement>("#mcPickerList");
  const searchInput = qs<HTMLInputElement>("#mcPickerSearch");
  const countEl = qs<HTMLElement>("#mcPickerCount");
  // 勾选用 Set 记录（按邮箱）：搜索过滤会重渲染列表，勾选状态不能被吃掉
  const picked = new Set<string>();
  const updateCount = () => {
    if (countEl) {
      const pool = mcContactPool || [];
      countEl.textContent = pool.length ? `共 ${pool.length} 位联系人 · 已选 ${picked.size}` : "";
    }
  };
  const renderList = () => {
    if (!listEl) return;
    const keyword = (searchInput?.value || "").trim().toLowerCase();
    const pool = mcContactPool || [];
    const rows = pool
      .filter((item) => !keyword || item.email.toLowerCase().includes(keyword) || item.label.toLowerCase().includes(keyword))
      .map((item) => `
        <label class="mc-picker-row">
          <input type="checkbox" value="${escapeHtml(item.email)}" ${picked.has(item.email) ? "checked" : ""}>
          <span class="mc-picker-row-text"><b>${escapeHtml(item.label || "（未命名）")}</b><small>${escapeHtml(item.email)}</small></span>
        </label>`).join("");
    listEl.innerHTML = rows || `<div class="mc-picker-loading">${keyword ? "没有匹配的联系人" : "通讯录是空的：先把客户/线索登记上邮箱"}</div>`;
    updateCount();
  };
  listEl?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.type !== "checkbox") return;
    if (input.checked) picked.add(input.value);
    else picked.delete(input.value);
    updateCount();
  });
  searchInput?.addEventListener("input", renderList);
  void mcEnsureContactPool().then(renderList);
  qs("#mcPickerAdd")?.addEventListener("click", () => {
    const pickedEmails = Array.from(picked);
    if (!pickedEmails.length) { toast("先勾选要添加的联系人", "warn"); return; }
    const target = qs<HTMLSelectElement>("#mcPickerTarget")?.value || "to";
    const box = target === "cc" ? ccBox : target === "bcc" ? bccBox : toBox;
    const merged = Array.from(new Set([...(mcChipsTokens.get(box) || []), ...pickedEmails]));
    mcChipsSetValues(box, merged);
    if (target !== "to") {
      const row = qs<HTMLElement>(target === "cc" ? "#mcComposeCcRow" : "#mcComposeBccRow");
      const toggle = qs<HTMLElement>(target === "cc" ? "#mcComposeCcToggle" : "#mcComposeBccToggle");
      if (row) row.hidden = false;
      if (toggle) toggle.remove();
    }
    mcComposeDraftSaveSoon();
    closeModal();
    toast(`已添加 ${pickedEmails.length} 个地址到${target === "to" ? "收件人" : target === "cc" ? "抄送" : "密送"}`, "success");
  });
}

/**
 * 写信 / 回复时的「专注态」：把账号统计条收起来，高度全给阅读栏。
 *
 * 为什么必须这么做：800px 高的窗口里，页头 + 账号卡占掉 250px，三栏只剩 360px；
 * 回复框自身就要 240px，原信连一行半都剩不下（实测 1200×800 时原信完全不可见）。
 * 账号统计在写信时是纯噪音，收起来换 130px 给正文——关闭写信即恢复。
 */
function mcFocusWriting(on: boolean) {
  document.getElementById("mail-center")?.classList.toggle("is-writing", on);
  // 账号条 display 一变，这一行的顶部位置就变了，必须重量一次（否则高度差 130px）
  if (qs<HTMLElement>(".mc-inbox")) syncMailCenterColumnHeight();
}

/** 同一时间只允许一个写信界面（阅读栏整块写信 或 就地回复），开新的先全拆 */
function mcComposeTeardownAll() {
  document.getElementById("mcComposeDrawer")?.remove();
  document.getElementById("mcComposeInline")?.remove();
  document.getElementById("mcMessageDetail")?.classList.remove("is-replying");
  const pane = document.getElementById("mcComposePane");
  if (pane) {
    pane.closest("#mcMessageDetail")?.classList.remove("is-composing");
    pane.remove();
  }
  mcFocusWriting(false);
}

function closeComposeDrawer(skipSave = false) {
  if (!skipSave) mcComposeDraftSaveNow();
  const drawer = document.getElementById("mcComposeDrawer");
  if (drawer) {
    drawer.classList.remove("is-open");
    window.setTimeout(() => drawer.remove(), 280);
  }
  document.getElementById("mcComposeInline")?.remove();
  document.getElementById("mcMessageDetail")?.classList.remove("is-replying");
  // 阅读栏里的整块写信区：关掉后要把原来那封邮件（或空态）放回去
  const pane = document.getElementById("mcComposePane");
  if (pane) {
    pane.closest("#mcMessageDetail")?.classList.remove("is-composing");
    pane.remove();
    renderMailCenterMessageDetail();
  }
  mcFocusWriting(false);
}

type McComposePrefill = { to?: string; cc?: string; subject?: string; quoteHtml?: string; inReplyTo?: string; references?: string; mailboxId?: string };
type McComposeDraft = { mailboxId?: string; to?: string; cc?: string; bcc?: string; subject?: string; html?: string; inReplyTo?: string; references?: string };

/** 富文本工具栏（浮窗/就地回复共用）：B/I/U/S · 文字颜色/高亮/字号/字体 · 格式刷/插入图片 · 对齐 · 列表/链接/清除 */
function mcComposeToolbarHtml() {
  const align = (cmd: string, title: string, lines: string) =>
    `<button type="button" data-cmd="${cmd}" title="${title}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${lines}</svg></button>`;
  return `<div class="mc-compose-tools" id="mcComposeTools">
          <button type="button" data-cmd="bold" title="加粗"><b>B</b></button>
          <button type="button" data-cmd="italic" title="斜体"><i>I</i></button>
          <button type="button" data-cmd="underline" title="下划线"><u>U</u></button>
          <button type="button" data-cmd="strikeThrough" title="删除线"><s>S</s></button>
          <span class="mc-tools-sep"></span>
          <label class="mc-tool-color" title="文字颜色"><input type="color" data-tool="foreColor" value="#16223b"><span class="mc-tool-color-a" style="color:#d94a6a">A</span></label>
          <label class="mc-tool-color" title="背景高亮"><input type="color" data-tool="hiliteColor" value="#ffe58f"><span class="mc-tool-color-a" style="background:#ffe58f;color:#8a6321">A</span></label>
          <select data-tool="fontSize" title="字号"><option value="">字号</option><option value="2">小</option><option value="3">标准</option><option value="4">中大</option><option value="5">大</option><option value="6">特大</option></select>
          <select data-tool="fontName" title="字体"><option value="">字体</option><option value="Arial">Arial</option><option value="Georgia">Georgia</option><option value="'Times New Roman',serif">Times</option><option value="SimSun,serif">宋体</option><option value="'Microsoft YaHei',sans-serif">微软雅黑</option><option value="'Courier New',monospace">等宽</option></select>
          <span class="mc-tools-sep"></span>
          <button type="button" data-cmd="brush" title="格式刷：把光标放进带格式的文字点一下，再选中目标文字点一下">格式刷</button>
          <button type="button" data-cmd="insertImage" title="插入图片：自动压缩并作为邮件内嵌图发出（对方邮箱可见）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>图片</button>
          <span class="mc-tools-sep"></span>
          ${align("justifyLeft", "左对齐", '<path d="M4 6h16M4 12h10M4 18h13"/>')}
          ${align("justifyCenter", "居中", '<path d="M4 6h16M7 12h10M6 18h12"/>')}
          ${align("justifyRight", "右对齐", '<path d="M4 6h16M10 12h10M7 18h13"/>')}
          <span class="mc-tools-sep"></span>
          <button type="button" data-cmd="insertUnorderedList" title="无序列表">•&nbsp;列表</button>
          <button type="button" data-cmd="insertOrderedList" title="有序列表">1.&nbsp;列表</button>
          <button type="button" data-cmd="createLink" title="插入链接"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
          <button type="button" data-cmd="removeFormat" title="清除格式">清除</button>
          <span class="mc-compose-hint">支持 Ctrl+Enter 发送</span>
        </div>
        <input type="file" id="mcImageInput" accept="image/*" hidden>`;
}

/** 信封 + 编辑器 + 附件区（浮窗/就地回复共用） */
function mcComposeStackHtml(account: MailCenterAccount, withNote = true) {
  return `<div class="mc-compose-stack">
      <div class="mc-compose-env">
        <div class="mc-compose-row">
          <span class="mc-compose-row-label">发件人</span>
          <div class="mc-compose-row-main">
            <select id="mcComposeMailbox">
              ${mailCenterState.accounts.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === account.id ? "selected" : ""}>${escapeHtml(item.label || item.email)} · ${escapeHtml(item.email)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="mc-compose-row">
          <span class="mc-compose-row-label">收件人</span>
          <div class="mc-compose-row-main">
            <div class="mc-chips" id="mcComposeToBox"><input type="text" placeholder="输入邮箱，回车成签；可从客户/线索中自动补全"></div>
          </div>
          <button type="button" class="mc-compose-link" id="mcComposeContactsBtn" title="从客户/线索通讯录里挑选收件人">通讯录</button>
          <button type="button" class="mc-compose-link" id="mcComposeCcToggle">抄送</button>
          <button type="button" class="mc-compose-link" id="mcComposeBccToggle">密送</button>
        </div>
        <div class="mc-compose-row" id="mcComposeCcRow" hidden>
          <span class="mc-compose-row-label">抄送</span>
          <div class="mc-compose-row-main">
            <div class="mc-chips" id="mcComposeCcBox"><input type="text" placeholder="抄送邮箱，回车成签"></div>
          </div>
        </div>
        <div class="mc-compose-row" id="mcComposeBccRow" hidden>
          <span class="mc-compose-row-label">密送</span>
          <div class="mc-compose-row-main">
            <div class="mc-chips" id="mcComposeBccBox"><input type="text" placeholder="密送邮箱，收件人不可见，回车成签"></div>
          </div>
        </div>
        <div class="mc-compose-row">
          <span class="mc-compose-row-label">主题</span>
          <div class="mc-compose-row-main">
            <input id="mcComposeSubject" type="text" maxlength="300" placeholder="邮件主题">
          </div>
        </div>
      </div>
      <div class="mc-compose-editor-wrap">
        ${mcComposeToolbarHtml()}
        <div id="mcComposeBody" class="mc-compose-editor" contenteditable="true" data-placeholder="写下这封邮件的内容…"></div>
      </div>
      <div class="mc-compose-bar">
        <button type="button" class="mc-compose-bar-btn" id="mcAttachBtn" title="添加附件">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>附件
        </button>
        <input type="file" id="mcAttachInput" multiple hidden>
        <span class="mc-compose-draft" id="mcComposeDraftState"></span>
      </div>
      <div class="mc-attach-list" id="mcAttachList"></div>
      ${withNote ? mcComposeNoteHtml() : ""}
    </div>`;
}

/** 说明条：浮窗/就地回复放正文末尾；阅读栏整块写信时挪到页脚一行（省高度，正文能多两行） */
function mcComposeNoteHtml(extraClass = "") {
  return `<div class="mc-form-note ${extraClass}" title="发送使用所选账号的 SMTP 配置；署名来自邮箱设置里的邮件签名，随正文发出、可就地修改；副本自动归档「已发送」；也可把文件直接拖进正文。">发送使用所选账号的 SMTP 配置；署名来自<button type="button" class="mc-compose-link" data-mc-edit-signature>邮箱设置里的邮件签名</button>，随正文发出、可就地修改；副本自动归档「已发送」。也可把文件直接拖进正文。</div>`;
}

function mcComposeFootHtml(cancelLabel = "存草稿并收起", footNote = "") {
  return `<div class="mc-compose-drawer-foot">
      ${footNote}
      <button class="btn" id="mcComposeCancel">${cancelLabel}</button>
      <button class="btn primary" id="mcComposeSend"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg><span class="mc-send-label">发送</span></button>
    </div>`;
}

/**
 * showMin：只有浮窗能「最小化成标题条」
 * showClose：就地回复不要这个 ×——它和抬头「取消」重复，而且 × 是浮窗的招牌动作，
 *            留着就会把阅读栏里的一块重新看成小弹窗（用户已按此否掉过一版）
 */
function mcComposeHeadButtonsHtml(showMin = true, showClose = true) {
  return `<button type="button" class="mc-personalize-btn" id="mcPersonalizeBtn" title="结合客户背调，把邮件改写成千人千面版本">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 15l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/></svg>
        <span class="mc-personalize-label">千人千面</span>
      </button>
      ${showMin ? `<button type="button" class="mc-compose-head-btn" id="mcComposeMin" title="最小化（草稿自动保留）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg></button>` : ""}
      ${showClose ? `<button type="button" class="mc-compose-head-btn mc-compose-drawer-close" id="mcComposeClose" title="关闭（草稿自动保存）">×</button>` : ""}`;
}

/**
 * 新写一封 = 占满阅读栏（跟「回复」同一个位置：右栏那一整块）。
 * 用户明确要求：回复和发邮件都在右边这一整块里，不要右下角小浮窗、也不要侧边抽屉。
 */
function openMailCenterComposePane(host: HTMLElement, account: MailCenterAccount, prefill: McComposePrefill, draft: McComposeDraft | null) {
  const pane = document.createElement("div");
  pane.className = "mail-center-compose-modal mc-compose-pane";
  pane.id = "mcComposePane";
  pane.innerHTML = `
    <div class="mc-compose-pane-head">
      <h3>写邮件</h3>
      <span class="mc-compose-inline-sub">草稿自动保存 · Esc 关闭</span>
      ${mcComposeHeadButtonsHtml(false)}
    </div>
    <div class="mc-compose-pane-body">${mcComposeStackHtml(account, false)}</div>
    ${mcComposeFootHtml("存草稿并关闭", mcComposeNoteHtml("mc-compose-foot-note"))}`;
  host.innerHTML = "";
  host.classList.add("is-composing");
  host.appendChild(pane);
  mcFocusWriting(true);
  // 阅读栏本来就不高：把「附件」从正文下面那条挪到页脚，正文能多一行（拖拽仍然可用）
  const attachBtn = pane.querySelector<HTMLElement>("#mcAttachBtn");
  if (attachBtn) pane.querySelector(".mc-compose-drawer-foot")?.prepend(attachBtn);
  mcComposeWire(pane, prefill, draft, account);
  host.scrollTop = 0;
}

function openMailCenterCompose(prefill: McComposePrefill = {}) {
  const accounts = mailCenterState.accounts;
  if (!accounts.length) {
    toast("还没有绑定邮箱，先绑定一个发件账号", "warn");
    openMailCenterAccountModal();
    return;
  }
  const activeId = mailCenterState.activeAccountId || accounts[0].id;
  let account = accounts.find((item) => item.id === activeId) || accounts[0];
  if (prefill.mailboxId && accounts.some((item) => item.id === prefill.mailboxId)) {
    // 回复/转发：默认用原邮件的收发邮箱，保持会话在同一账号下
    account = accounts.find((item) => item.id === prefill.mailboxId) || account;
  }
  mcComposeAttachments = [];
  mcContactPool = null; // 每次打开重取一次联系人池，保证新建的测试档案能被补全到
  void mcEnsureContactPool();
  // 草稿恢复：没有显式预填（收件人/引用块）时，取上次未发送的草稿
  let draft: McComposeDraft | null = null;
  if (!prefill.to && !prefill.quoteHtml) {
    try {
      const raw = localStorage.getItem(MC_DRAFT_KEY);
      if (raw) draft = JSON.parse(raw);
    } catch { draft = null; }
  }
  if (!prefill.mailboxId && draft?.mailboxId && accounts.some((item) => item.id === draft!.mailboxId)) {
    account = accounts.find((item) => item.id === draft!.mailboxId) || account;
  }
  mcComposeTeardownAll();
  // 不在收件箱页签（客户速查 / 旅程 / 自动发信…）时压根没有阅读栏：先切回收件箱，
  // 让写信永远长在右边那一整块里，而不是另开一个小窗。
  if (mailCenterState.tab !== "inbox") {
    mailCenterState.tab = "inbox";
    // 从速查/旅程跳过来写信：落到收件箱，别停在「已发送」（写信跟文件夹无关，但列表要看得懂）
    mailCenterState.folder = "inbox";
    mailCenterState.activeMessageId = "";
    mailCenterState.activeMessage = null;
    renderMailCenterPage();
    void loadMailCenterMessages({ silent: true });
  }
  const host = document.getElementById("mcMessageDetail");
  if (host) {
    openMailCenterComposePane(host, account, prefill, draft);
    return;
  }
  // 极端兜底：阅读栏没渲染出来（正常不会走到），才退回右下角浮窗
  const drawer = document.createElement("div");
  drawer.className = "mail-center-compose-modal mc-compose-drawer";
  drawer.id = "mcComposeDrawer";
  drawer.innerHTML = `
    <div class="mc-compose-drawer-head">
      <h3>写邮件</h3>
      <span class="mc-compose-drawer-sub">草稿自动保存 · Esc 关闭 · 可最小化</span>
      ${mcComposeHeadButtonsHtml()}
    </div>
    <div class="mc-compose-drawer-body">${mcComposeStackHtml(account)}</div>
    ${mcComposeFootHtml()}`;
  document.body.appendChild(drawer);
  requestAnimationFrame(() => drawer.classList.add("is-open"));
  mcComposeWire(drawer, prefill, draft, account);
}

/** 就地回复 / 全部回复 / 转发：写信界面长在阅读栏里，原信内容就在上面，边看边回（Gmail inline reply 惯例） */
function openMailCenterInlineCompose(message: MailCenterMessage, mode: McComposeMode) {
  const accounts = mailCenterState.accounts;
  if (!accounts.length) {
    toast("还没有绑定邮箱，先绑定一个发件账号", "warn");
    openMailCenterAccountModal();
    return;
  }
  const prefill = mcComposePrefillForMessage(message, mode);
  const account = accounts.find((item) => item.id === prefill.mailboxId)
    || accounts.find((item) => item.id === (mailCenterState.activeAccountId || "")) || accounts[0];
  // 这封信如果有写到一半的回复草稿，原样恢复（收件人/正文/引用都回来）
  let saved: McComposeDraft | null = null;
  try {
    const raw = localStorage.getItem(MC_REPLY_DRAFT_PREFIX + message.id);
    if (raw) saved = JSON.parse(raw);
  } catch { saved = null; }
  mcComposeAttachments = [];
  mcContactPool = null;
  void mcEnsureContactPool();
  mcComposeTeardownAll();
  const detail = qs<HTMLElement>("#mcMessageDetail");
  if (!detail) { openMailCenterCompose(prefill); return; } // 阅读栏不在了就退回浮窗
  const actionText = mode === "reply" ? "回复" : mode === "replyAll" ? "全部回复" : "转发";
  const card = document.createElement("div");
  card.className = "mail-center-compose-modal mc-compose-inline";
  card.id = "mcComposeInline";
  card.dataset.mcForMessage = message.id;
  card.innerHTML = `
    <div class="mc-compose-inline-head">
      <h3 title="${escapeHtml(message.subject || "(无主题)")}">${actionText}</h3>
      <span class="mc-compose-inline-sub" title="用 ${escapeHtml(account.email)} 发，引用原文已附在正文末尾">用 ${escapeHtml(account.email)} 发</span>
      ${mcComposeHeadButtonsHtml(false, false)}
      <button type="button" class="mc-compose-head-text" data-mc-compose-cancel>取消</button>
    </div>
    <div class="mc-compose-inline-body">${mcComposeStackHtml(account)}</div>
    ${mcComposeFootHtml()}`;
  // 附件按钮挪到回复卡页脚（正文下面那条太吃高度，且会被工具栏挤成半行）
  const attachBtn = card.querySelector<HTMLElement>("#mcAttachBtn");
  if (attachBtn) card.querySelector(".mc-compose-drawer-foot")?.prepend(attachBtn);
  detail.appendChild(card);
  // 回复卡钉在阅读栏底部（原信上半部分自己滚），这样一进来就能看见正文和发送键
  detail.classList.add("is-replying");
  mcFocusWriting(true);
  mcComposeWire(card, prefill, saved, account);
}

/** 引用块：包一层不可编辑容器；长引用默认折叠（内容仍在 DOM 里，发送不受折叠影响） */
function mcQuoteBlockHtml(quoteHtml: string) {
  const plain = editorTextOf(quoteHtml) || "";
  const collapsed = plain.length > 400 || quoteHtml.length > 2000;
  return `<div class="mc-quote-block${collapsed ? " is-collapsed" : ""}" contenteditable="false">`
    + `<button type="button" class="mc-quote-toggle">${collapsed ? "显示引用的原文" : "隐藏引用的原文"}</button>`
    + `<div class="mc-quote-content">${quoteHtml}</div></div>`;
}

/** 写信界面接线（浮窗/就地回复共用；同一时间只有一个实例，全局 id 查询即当前实例） */

// 工具栏选区与格式刷状态（单实例，全局即可）
let mcSavedToolRange: Range | null = null;
let mcFormatBrush: { bold: boolean; italic: boolean; underline: boolean; color: string; bg: string; size: string } | null = null;

function mcCaptureEditorRange(editor: HTMLElement | null): Range | null {
  const sel = window.getSelection();
  if (editor && sel && sel.rangeCount && editor.contains(sel.anchorNode)) return sel.getRangeAt(0).cloneRange();
  return null;
}

function mcRestoreEditorRange(editor: HTMLElement | null) {
  editor?.focus();
  if (mcSavedToolRange) {
    try {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(mcSavedToolRange);
    } catch { /* 选区已失效就忽略 */ }
  }
}

/** 取光标所在处的字符格式（格式刷的"刷子"） */
function mcCaptureBrushFormat() {
  const sel = window.getSelection();
  const anchor = sel && sel.rangeCount ? sel.anchorNode : null;
  const node = anchor ? (anchor.nodeType === 3 ? anchor.parentElement : (anchor as HTMLElement)) : null;
  if (!node) return null;
  const s = window.getComputedStyle(node);
  const px = parseFloat(s.fontSize);
  return {
    bold: Number(s.fontWeight) >= 600,
    italic: s.fontStyle === "italic",
    underline: s.textDecorationLine.includes("underline"),
    color: s.color,
    bg: s.backgroundColor,
    size: px >= 20 ? "6" : px >= 16.5 ? "5" : px <= 11.5 ? "2" : px <= 13.5 ? "3" : "4"
  };
}

function mcApplyBrush() {
  const b = mcFormatBrush;
  if (!b) return;
  document.execCommand("styleWithCSS", false, "true");
  document.execCommand("removeFormat");
  if (b.bold) document.execCommand("bold");
  if (b.italic) document.execCommand("italic");
  if (b.underline) document.execCommand("underline");
  document.execCommand("foreColor", false, b.color);
  if (b.bg && b.bg !== "rgba(0, 0, 0, 0)" && b.bg !== "transparent") document.execCommand("hiliteColor", false, b.bg);
  document.execCommand("fontSize", false, b.size);
}

/** 插入图片：>800px 宽等比压缩为 jpg(0.82)；小 png 保留原样（透明通道）。
 *  编辑器里存 dataURL，发送时后端抽出来转 CID 内嵌附件（data URI 在 Gmail/Outlook 会被吞）。 */
async function mcInsertInlineImage(file: File) {
  const editor = qs<HTMLElement>("#mcComposeBody");
  if (!editor || !file.type.startsWith("image/")) { toast("只能插入图片文件", "error"); return; }
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取失败"));
      reader.readAsDataURL(file);
    });
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("解码失败")); img.src = dataUrl; });
    let out = dataUrl;
    if (img.naturalWidth > 800 || (file.type !== "image/png" && dataUrl.length > 400_000)) {
      const w = Math.min(800, img.naturalWidth);
      const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
      out = canvas.toDataURL("image/jpeg", 0.82);
    }
    mcRestoreEditorRange(editor);
    document.execCommand("insertImage", false, out);
    mcComposeDraftSaveSoon();
    toast("图片已插入正文，发送时自动转为邮件内嵌图", "success");
  } catch (error) {
    toast(error instanceof Error ? `图片插入失败：${error.message}` : "图片插入失败", "error");
  }
}

function mcComposeWire(root: HTMLElement, prefill: McComposePrefill, draft: McComposeDraft | null, account: MailCenterAccount) {
  // 会话线程头挂根节点 dataset：发送与草稿保存都从这里取
  root.dataset.mcInReplyTo = prefill.inReplyTo || draft?.inReplyTo || "";
  root.dataset.mcReferences = prefill.references || draft?.references || "";
  root.querySelector("#mcComposeClose")?.addEventListener("click", () => closeComposeDrawer());
  root.querySelector("#mcComposeCancel")?.addEventListener("click", () => closeComposeDrawer());
  // 就地回复抬头的「取消」（不用 id：页脚的存草稿按钮已经占了 #mcComposeCancel）
  root.querySelectorAll("[data-mc-compose-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => closeComposeDrawer());
  });
  // 最小化成标题条（Gmail 式）：点「─」收起，点标题条展开
  root.querySelector("#mcComposeMin")?.addEventListener("click", () => {
    root.classList.add("is-min");
    const title = root.querySelector(".mc-compose-drawer-head h3, .mc-compose-inline-head h3");
    if (title) title.setAttribute("title", "点击展开");
  });
  root.querySelector(".mc-compose-drawer-head, .mc-compose-inline-head")?.addEventListener("click", (event) => {
    if (root.classList.contains("is-min") && !(event.target as HTMLElement).closest("button")) {
      root.classList.remove("is-min");
    }
  });
  root.addEventListener("keydown", (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key === "Escape") { event.preventDefault(); closeComposeDrawer(); return; }
    if ((keyEvent.ctrlKey || keyEvent.metaKey) && keyEvent.key === "Enter") {
      event.preventDefault();
      void sendMailCenterCompose();
    }
  });
  const toBox = qs<HTMLElement>("#mcComposeToBox");
  const ccBox = qs<HTMLElement>("#mcComposeCcBox");
  const bccBox = qs<HTMLElement>("#mcComposeBccBox");
  if (toBox) mcChipsInit(toBox);
  if (ccBox) mcChipsInit(ccBox);
  if (bccBox) mcChipsInit(bccBox);
  const editor = qs<HTMLElement>("#mcComposeBody");
  if (editor) {
    if (draft?.html) {
      // 有已保存的草稿：整份恢复（就地回复按原信恢复，含引用块与已写内容）
      editor.innerHTML = draft.html;
    } else if (prefill.quoteHtml) {
      // 回复/转发：光标放最上面先写内容，签名与引用块留在下方；引用包一层便于千人千面改写后原样保留
      editor.innerHTML = `${mcComposeSignatureHtml(account)}${mcQuoteBlockHtml(prefill.quoteHtml)}`;
      try {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      } catch { /* 个别环境拿不到 selection，不影响编辑 */ }
    } else {
      editor.innerHTML = mcComposeSignatureHtml(account);
    }
    editor.addEventListener("input", () => mcComposeDraftSaveSoon());
    editor.addEventListener("dragover", (event) => { event.preventDefault(); editor.classList.add("is-dragover"); });
    editor.addEventListener("dragleave", () => editor.classList.remove("is-dragover"));
    editor.addEventListener("drop", (event) => {
      event.preventDefault();
      editor.classList.remove("is-dragover");
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) mcAddComposeFiles(files);
    });
    // 截图/复制的图片直接 Ctrl+V 进正文（内嵌图，发送时转附件）
    editor.addEventListener("paste", (event: ClipboardEvent) => {
      const items = Array.from(event.clipboardData?.items || []);
      const imgItem = items.find((item) => item.type.startsWith("image/"));
      if (!imgItem) return;
      const file = imgItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      void mcInsertInlineImage(file);
    });
    // 引用块折叠/展开（块本身不可编辑，点击标题条切换）
    editor.addEventListener("click", (event) => {
      const toggle = (event.target as HTMLElement).closest(".mc-quote-toggle");
      const block = toggle?.closest(".mc-quote-block");
      if (!toggle || !block) return;
      block.classList.toggle("is-collapsed");
      toggle.textContent = block.classList.contains("is-collapsed") ? "显示引用的原文" : "隐藏引用的原文";
    });
  }
  // 格式工具栏：mousedown 阻断是为了不丢编辑区选区；颜色选择器要真正点击，只存选区不拦默认
  const captureRange = () => { mcSavedToolRange = mcCaptureEditorRange(editor); };
  const restoreRange = () => mcRestoreEditorRange(editor);
  const tools = qs("#mcComposeTools");
  tools?.addEventListener("mousedown", (event) => {
    captureRange();
    if (!(event.target as HTMLElement).closest('input[type="color"]')) event.preventDefault();
  });
  // 颜色/字号/字体：input/change 触发，作用在保存的选区上
  tools?.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    const tool = input.dataset?.tool || "";
    if (tool === "foreColor" || tool === "hiliteColor") {
      restoreRange();
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand(tool, false, input.value);
      mcComposeDraftSaveSoon();
    }
  });
  tools?.addEventListener("change", (event) => {
    const select = event.target as HTMLSelectElement;
    const tool = select.dataset?.tool || "";
    if (!select.value) return;
    if (tool === "fontSize") {
      restoreRange();
      document.execCommand("fontSize", false, select.value);
      select.value = "";
      mcComposeDraftSaveSoon();
    }
    if (tool === "fontName") {
      restoreRange();
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand("fontName", false, select.value);
      select.value = "";
      mcComposeDraftSaveSoon();
    }
  });
  tools?.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-cmd]");
    if (!btn || !editor) return;
    const cmd = btn.dataset.cmd || "";
    if (cmd === "createLink") {
      const url = window.prompt("链接地址（https://…）");
      if (url && /^https?:\/\//i.test(url.trim())) document.execCommand("createLink", false, url.trim());
      return;
    }
    if (cmd === "insertImage") {
      restoreRange();
      qs<HTMLInputElement>("#mcImageInput")?.click();
      return;
    }
    if (cmd === "brush") {
      // 格式刷：第一次点=取当前光标处的格式；再选中目标文字点一下=套用
      const sel = window.getSelection();
      if (mcFormatBrush) {
        if (sel && !sel.isCollapsed) {
          restoreRange();
          mcApplyBrush();
          mcFormatBrush = null;
          btn.classList.remove("is-armed");
        } else {
          toast("先选中要套用格式的文字，再点格式刷", "info");
        }
      } else {
        captureRange();
        mcFormatBrush = mcCaptureBrushFormat();
        if (mcFormatBrush) {
          btn.classList.add("is-armed");
          toast("格式已取到：选中目标文字再点一次格式刷", "info");
        } else {
          toast("先把光标放进要复制的格式文字里", "info");
        }
      }
      return;
    }
    document.execCommand(cmd, false);
    editor.focus();
  });
  // 插入图片：压缩到 800px 宽（jpg 质量 0.82；小 png 保留透明通道），发送时后端转内嵌附件
  qs<HTMLInputElement>("#mcImageInput")?.addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void mcInsertInlineImage(file);
  });
  // 附件
  qs("#mcAttachBtn")?.addEventListener("click", () => qs<HTMLInputElement>("#mcAttachInput")?.click());
  qs("#mcAttachInput")?.addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files?.length) mcAddComposeFiles(Array.from(input.files));
    input.value = "";
  });
  // 抄送 / 密送 行
  const revealRow = (toggleId: string, rowId: string) => {
    qs("#" + toggleId)?.addEventListener("click", () => {
      qs("#" + toggleId)?.remove();
      const row = qs<HTMLElement>("#" + rowId);
      if (row) { row.hidden = false; row.querySelector("input")?.focus(); }
    });
  };
  revealRow("mcComposeCcToggle", "mcComposeCcRow");
  revealRow("mcComposeBccToggle", "mcComposeBccRow");
  // 通讯录选人
  qs("#mcComposeContactsBtn")?.addEventListener("click", () => openMailCenterContactPicker());
  // 去邮箱设置维护邮件签名（先存草稿；写信界面关掉，别浮在设置页上面）
  qs("[data-mc-edit-signature]")?.addEventListener("click", () => {
    mcComposeDraftSaveNow();
    mcComposeTeardownAll();
    activateNavView("mail-settings");
  });
  // 草稿：填入预填/恢复内容后再挂监听；已保存草稿的值优先于预填（用户改过的收件人不被覆盖）
  if (toBox) {
    const toTokens = mcSplitEmailText(draft?.to || prefill.to || "");
    if (toTokens.length) mcChipsSetValues(toBox, toTokens);
  }
  const ccPrefill = draft?.cc || prefill.cc || "";
  if (ccBox && ccPrefill) {
    qs("#mcComposeCcRow")?.removeAttribute("hidden");
    qs("#mcComposeCcToggle")?.remove();
    mcChipsSetValues(ccBox, mcSplitEmailText(ccPrefill));
  }
  if (bccBox && draft?.bcc) { qs("#mcComposeBccRow")?.removeAttribute("hidden"); qs("#mcComposeBccToggle")?.remove(); mcChipsSetValues(bccBox, mcSplitEmailText(draft.bcc)); }
  const subjectValue = draft?.subject || prefill.subject || "";
  if (subjectValue) {
    const subjectInput = qs<HTMLInputElement>("#mcComposeSubject");
    if (subjectInput) subjectInput.value = subjectValue;
  }
  if (draft?.html) toast(prefill.quoteHtml ? "已恢复这封信的回复草稿" : "已恢复上次未发送的草稿", "info");
  qs("#mcComposeSubject")?.addEventListener("input", () => mcComposeDraftSaveSoon());
  qs("#mcComposeMailbox")?.addEventListener("change", () => mcComposeDraftSaveSoon());
  if (prefill.quoteHtml) {
    // 回复/转发：光标直接落在正文开头，边看原信边写（别再抢到主题上）
    editor?.focus();
  } else if (prefill.to) {
    qs<HTMLInputElement>("#mcComposeSubject")?.focus();
  } else {
    toBox?.querySelector<HTMLInputElement>("input")?.focus();
  }
  qs("#mcComposeSend")?.addEventListener("click", () => void sendMailCenterCompose());
  // 千人千面：抽屉头部的品牌蓝入口
  qs("#mcPersonalizeBtn")?.addEventListener("click", (event) => {
    void runMailCenterPersonalize(event.currentTarget as HTMLButtonElement);
  });
}

/** 千人千面生成：单次请求覆盖「背调核对（缺就补跑）→ CLI 结合背调与当前内容改写」，
 *  按耗时分阶段换按钮文案，成功后回填主题与正文（署名尾缀重新补上）。 */
async function runMailCenterPersonalize(btn: HTMLButtonElement) {
  if (mailCenterState.composeSending || btn.disabled) return;
  const toBox = qs<HTMLElement>("#mcComposeToBox");
  const to = toBox ? mcChipsValue(toBox) : "";
  if (!to) { toast("请先填写收件人邮箱", "error"); return; }
  const subject = qs<HTMLInputElement>("#mcComposeSubject")?.value.trim() || "";
  const editor = qs<HTMLElement>("#mcComposeBody");
  // 署名尾缀不参与改写，发送时统一再补
  const content = (editor ? (editor.innerText || "") : "").replace(/\n--\n[\s\S]*$/, "").trim();
  mailCenterState.composeSending = true;
  btn.disabled = true;
  btn.classList.add("is-busy");
  const stages = ["背调核对中…", "正在结合背调改写…", "千人千面打磨中…"];
  let stageIndex = 0;
  const stageTimer = window.setInterval(() => {
    stageIndex = Math.min(stageIndex + 1, stages.length - 1);
    const label = btn.querySelector<HTMLElement>(".mc-personalize-label");
    if (label) label.textContent = stages[stageIndex];
  }, 9000);
  const finish = () => {
    window.clearInterval(stageTimer);
    mailCenterState.composeSending = false;
    btn.disabled = false;
    btn.classList.remove("is-busy");
    const label = btn.querySelector<HTMLElement>(".mc-personalize-label");
    if (label) label.textContent = "千人千面";
  };
  try {
    const result = await api<{ text?: string; pending?: boolean; message?: string; research?: { matched: boolean; reused: boolean; ran: boolean } }>(
      "/api/mail-center/personalize",
      { method: "POST", body: JSON.stringify({ to, subject, content, lang: "" }) }
    );
    if (result.pending) {
      toast(result.message || "背调任务已排队，稍后再点一次", "warn");
      finish();
      return;
    }
    let text = String(result.text || "").trim();
    let nextSubject = "";
    const subjectMatch = text.match(/^subject\s*[:：]\s*(.+)$/im);
    if (subjectMatch && subjectMatch.index !== undefined) {
      nextSubject = subjectMatch[1].trim();
      text = text.slice(subjectMatch.index + subjectMatch[0].length).replace(/^\s*\n+/, "");
    }
    const mailbox = mailCenterState.accounts.find((item) => item.id === qs<HTMLSelectElement>("#mcComposeMailbox")?.value);
    if (editor) {
      // 千人千面只改写正文；回复场景的引用块原样保留在末尾
      const quoteBlock = editor.querySelector(".mc-quote-block");
      editor.innerHTML = `${escapeHtml(text).replace(/\n/g, "<br>")}${mcComposeSignatureHtml(mailbox)}`;
      if (quoteBlock) editor.appendChild(quoteBlock);
      mcComposeDraftSaveSoon();
    }
    if (nextSubject) {
      const subjectInput = qs<HTMLInputElement>("#mcComposeSubject");
      if (subjectInput) subjectInput.value = nextSubject;
    }
    const research = result.research;
    toast(research?.matched
      ? (research.ran ? "已补跑背调并生成千人千面版本" : "已结合既有背调生成千人千面版本")
      : "收件邮箱未匹配到客户/线索，已按邮件内容生成", "success");
    finish();
  } catch (error) {
    toast(error instanceof Error ? error.message : "千人千面生成失败", "error");
    finish();
  }
}

async function sendMailCenterCompose() {
  const sendBtn = qs<HTMLButtonElement>("#mcComposeSend");
  if (!sendBtn || mailCenterState.composeSending) return;
  const mailboxId = qs<HTMLSelectElement>("#mcComposeMailbox")?.value || "";
  const toBox = qs<HTMLElement>("#mcComposeToBox");
  const ccBox = qs<HTMLElement>("#mcComposeCcBox");
  const bccBox = qs<HTMLElement>("#mcComposeBccBox");
  // 输入框里打了一半没回车的地址，先替用户提交掉（合法成签，非法拦下来）
  let invalid = "";
  for (const [label, box] of [["收件人", toBox], ["抄送", ccBox], ["密送", bccBox]] as Array<[string, HTMLElement | null]>) {
    const input = box?.querySelector<HTMLInputElement>("input");
    const raw = input?.value.trim() || "";
    if (!raw) continue;
    const remainder = mcChipsCommitValid(box!, raw);
    if (input) input.value = remainder;
    if (remainder && !invalid) invalid = `${label}里的「${remainder}」`;
  }
  if (invalid) {
    toast(`${invalid} 不是有效邮箱，改一下再发`, "error");
    return;
  }
  const to = toBox ? mcChipsValue(toBox) : "";
  const cc = ccBox ? mcChipsValue(ccBox) : "";
  const bcc = bccBox ? mcChipsValue(bccBox) : "";
  const subject = qs<HTMLInputElement>("#mcComposeSubject")?.value.trim() || "";
  const editor = qs<HTMLElement>("#mcComposeBody");
  const html = editor ? editor.innerHTML : "";
  const content = editor ? (editor.innerText || editor.textContent || "").trim() : "";
  if (!to) { toast("请填写收件人邮箱", "error"); toBox?.querySelector<HTMLInputElement>("input")?.focus(); return; }
  if (!content && !mcComposeAttachments.length) { toast("邮件正文不能为空", "error"); editor?.focus(); return; }
  if (mcComposeAttachments.some((item) => !item.contentBase64)) { toast("附件还在读取中，等一下再发", "warn"); return; }
  // 守门一：没主题（Gmail 式确认，不硬拦）
  if (!subject) {
    const ok = await confirmAction({
      title: "发送没有主题的邮件？",
      message: "主题空着，对方在收件箱里会看到「（无主题）」，正式商务邮件建议补一句主题。",
      confirmLabel: "不写主题，直接发",
      tone: "warning"
    });
    if (!ok) { qs<HTMLInputElement>("#mcComposeSubject")?.focus(); return; }
  }
  // 守门二：正文提到附件却没带附件（经典翻车现场）
  if (!mcComposeAttachments.length && /附件|attached|attachment|enclosed|添付/i.test(content)) {
    const ok = await confirmAction({
      title: "正文提到了附件，但这封信没有附件",
      message: "要么补上附件再发，要么把正文里的附件说法改掉，避免对方空等。",
      confirmLabel: "确认没有附件，发送",
      tone: "warning"
    });
    if (!ok) return;
  }
  mailCenterState.composeSending = true;
  sendBtn.disabled = true;
  sendBtn.classList.add("is-sending");
  const sendLabel = sendBtn.querySelector<HTMLElement>(".mc-send-label");
  if (sendLabel) sendLabel.textContent = "发送中…";
  try {
    const root = mcComposeRoot();
    await api("/api/mail-center/send", { method: "POST", body: JSON.stringify({
      mailboxId, to, cc, bcc, subject, content, html,
      inReplyTo: root?.dataset.mcInReplyTo || "",
      references: root?.dataset.mcReferences || "",
      attachments: mcComposeAttachments
        .filter((item) => item.contentBase64)
        .map((item) => ({ filename: item.filename, contentBase64: item.contentBase64, contentType: item.contentType }))
    }) });
    // 发送成功：清掉对应草稿（新写信 / 按原信存的回复草稿），关界面时别再存回去
    localStorage.removeItem(MC_DRAFT_KEY);
    if (root?.dataset.mcForMessage) localStorage.removeItem(MC_REPLY_DRAFT_PREFIX + root.dataset.mcForMessage);
    closeComposeDrawer(true);
    toast("邮件已发送，副本已归档到「已发送」", "success");
    void loadMailCenterFolders();
    if (mailCenterState.folder === "sent") void loadMailCenterMessages({ silent: true });
  } catch (error) {
    toast(error instanceof Error ? error.message : "发送失败，请检查发件账号配置", "error");
    mailCenterState.composeSending = false;
    sendBtn.disabled = false;
    sendBtn.classList.remove("is-sending");
    if (sendLabel) sendLabel.textContent = "发送";
  }
}

function openMailCenterAccountModal(account?: MailCenterAccount) {
  const editing = Boolean(account);
  const passwordHint = editing ? "留空 = 保留原授权码" : "企业邮箱的客户端授权码 / 应用专用密码";
  openModal(editing ? "编辑邮箱账号" : "绑定邮箱账号", `
    <div class="form-grid">
      <div class="form-field">
        <label>账号名称</label>
        <input id="mcAccountLabel" maxlength="60" value="${escapeHtml(account?.label || "")}" placeholder="例如 主邮箱 / 询盘专用">
      </div>
      <div class="form-field">
        <label>邮箱地址</label>
        <input id="mcAccountEmail" type="email" value="${escapeHtml(account?.email || "")}" placeholder="sales@yourcompany.com">
      </div>
      <div class="form-field">
        <label>SMTP 授权码</label>
        <input id="mcAccountPassword" type="password" autocomplete="new-password" placeholder="${escapeHtml(passwordHint)}">
      </div>
      <div class="form-field">
        <label>SMTP 主机</label>
        <input id="mcAccountSmtpHost" value="${escapeHtml(account?.smtpHost || "")}" placeholder="smtp.exmail.qq.com">
      </div>
      <div class="form-field">
        <label>SMTP 端口</label>
        <input id="mcAccountSmtpPort" type="number" value="${account?.smtpPort || 465}" min="1" max="65535">
      </div>
      <div class="form-field">
        <label>IMAP 主机（可留空自动推导）</label>
        <input id="mcAccountImapHost" value="${escapeHtml(account?.imapHost || "")}" placeholder="imap.exmail.qq.com">
      </div>
      <div class="form-field">
        <label>自动同步频率</label>
        <select id="mcAccountInterval">
          <option value="15">每 15 分钟</option>
          <option value="30">每 30 分钟</option>
          <option value="60" selected>每小时</option>
          <option value="120">每 2 小时</option>
          <option value="240">每 4 小时</option>
          <option value="1440">每天</option>
        </select>
      </div>
      <div class="form-field">
        <label>收件同步</label>
        <select id="mcAccountSyncEnabled">
          <option value="1" selected>开启（按频率自动收件）</option>
          <option value="0">暂停</option>
        </select>
      </div>
      <div class="form-field full">
        <div class="mc-form-note">授权码只在本机加密保存，用于 SMTP 发信与 IMAP 收件；不会上传到任何第三方。IMAP 主机留空时会按 SMTP 主机推导（如 smtp.exmail.qq.com → imap.exmail.qq.com）。</div>
      </div>
      <div class="form-field full">
        <div class="mc-probe" id="mcAccountProbe" hidden></div>
      </div>
    </div>`, `<button class="btn" id="mcAccountTest" type="button">测试连接</button><span class="modal-foot-spacer"></span><button class="btn" data-modal-close>取消</button><button class="btn primary" id="mcAccountSave">${editing ? "保存修改" : "绑定并同步"}</button>`);
  qs("#appModal .modal")?.classList.add("mail-center-account-modal");
  qsa<HTMLElement>("[data-modal-close]", qs("#appModal") || document).forEach((node) => {
    node.addEventListener("click", closeModal);
  });
  const interval = qs<HTMLSelectElement>("#mcAccountInterval");
  if (interval && account) interval.value = String(account.syncIntervalMinutes || 60);
  const syncEnabled = qs<HTMLSelectElement>("#mcAccountSyncEnabled");
  if (syncEnabled && account) syncEnabled.value = account.syncEnabled ? "1" : "0";
  const hostInput = qs<HTMLInputElement>("#mcAccountSmtpHost");
  const emailInput = qs<HTMLInputElement>("#mcAccountEmail");
  emailInput?.addEventListener("blur", () => {
    if (!hostInput || hostInput.value.trim()) return;
    if (!emailInput.value.includes("@")) return;
    hostInput.value = mcGuessSmtpHost(emailInput.value.trim());
  });
  qs("#mcAccountSave")?.addEventListener("click", () => void saveMailCenterAccount(account));
  qs("#mcAccountTest")?.addEventListener("click", () => void testMailCenterAccountConnection(account));
}

interface MailProbeSide {
  ok: boolean;
  host: string;
  port: number;
  message: string;
  ms?: number;
  letters?: number;
  folders?: number;
}

/**
 * 弹窗里的「测试连接」：拿表单当前值直接探一次，不用先保存。
 * SMTP 走 verify（不发信）、IMAP 只读打开收件箱 —— 两个通道分开报，才知道该改哪一格。
 */
async function testMailCenterAccountConnection(account?: MailCenterAccount) {
  const email = qs<HTMLInputElement>("#mcAccountEmail")?.value.trim() || "";
  const password = qs<HTMLInputElement>("#mcAccountPassword")?.value || "";
  const smtpHostRaw = qs<HTMLInputElement>("#mcAccountSmtpHost")?.value.trim() || "";
  const smtpPort = Number(qs<HTMLInputElement>("#mcAccountSmtpPort")?.value || 465);
  const imapHost = qs<HTMLInputElement>("#mcAccountImapHost")?.value.trim() || "";
  if (!email || !email.includes("@")) { toast("请先填写邮箱地址", "error"); return; }
  if (!password && !account) { toast("请先填写 SMTP 授权码，测试连接需要它", "error"); return; }
  const smtpHost = smtpHostRaw || mcGuessSmtpHost(email);
  if (!smtpHostRaw) {
    const input = qs<HTMLInputElement>("#mcAccountSmtpHost");
    if (input) input.value = smtpHost;
  }
  const out = qs<HTMLElement>("#mcAccountProbe");
  const button = qs<HTMLButtonElement>("#mcAccountTest");
  if (button?.disabled) return;
  if (out) {
    out.hidden = false;
    out.className = "mc-probe is-running";
    out.innerHTML = `<b>正在连 SMTP 与 IMAP…</b><span>两个通道一起探，最多等 20 秒</span>`;
  }
  setButtonPending(button, true, "测试连接", "测试中…");
  try {
    const result = await api<{ ok: boolean; email: string; smtp: MailProbeSide; imap: MailProbeSide }>(
      "/api/mail-center/test-connection",
      { method: "POST", body: JSON.stringify({
        // 编辑态授权码留空 = 用库里那份，别逼用户重新输一遍
        mailboxId: account?.id || "",
        email, password,
        smtpHost, smtpPort,
        imapHost
      }) }
    );
    const line = (label: string, side: MailProbeSide | undefined) => {
      if (!side) return "";
      const ok = Boolean(side.ok);
      const where = `${side.host || "—"}${side.port ? `:${side.port}` : ""}`;
      return `<div class="mc-probe-line ${ok ? "is-ok" : "is-bad"}">
        <b>${label}</b>
        <span class="mc-probe-state">${ok ? "通过" : "失败"}</span>
        <span class="mc-probe-msg">${escapeHtml(side.message || "")}</span>
        <i>${escapeHtml(where)}${side.ms ? ` · ${(side.ms / 1000).toFixed(1)}s` : ""}</i>
      </div>`;
    };
    if (out) {
      out.className = `mc-probe ${result.ok ? "is-ok" : "is-bad"}`;
      out.innerHTML = `${line("SMTP 发信", result.smtp)}${line("IMAP 收信", result.imap)}`;
    }
    toast(
      result.ok ? "两个通道都连通了，可以保存" : "有通道没通，按下面提示改完再测",
      result.ok ? "success" : "error"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "测试失败";
    if (out) {
      out.hidden = false;
      out.className = "mc-probe is-bad";
      out.innerHTML = `<div class="mc-probe-line is-bad"><b>配置</b><span class="mc-probe-state">失败</span><span class="mc-probe-msg">${escapeHtml(message)}</span></div>`;
    }
    toast(message, "error");
  } finally {
    setButtonPending(button, false, "测试连接", "测试连接");
  }
}

async function saveMailCenterAccount(account?: MailCenterAccount) {
  const label = qs<HTMLInputElement>("#mcAccountLabel")?.value.trim() || "";
  const email = qs<HTMLInputElement>("#mcAccountEmail")?.value.trim() || "";
  const password = qs<HTMLInputElement>("#mcAccountPassword")?.value || "";
  const smtpHost = qs<HTMLInputElement>("#mcAccountSmtpHost")?.value.trim() || "";
  const smtpPort = Number(qs<HTMLInputElement>("#mcAccountSmtpPort")?.value || 465);
  const imapHost = qs<HTMLInputElement>("#mcAccountImapHost")?.value.trim() || "";
  const interval = Number(qs<HTMLSelectElement>("#mcAccountInterval")?.value || 60);
  const syncEnabled = (qs<HTMLSelectElement>("#mcAccountSyncEnabled")?.value || "1") === "1";
  if (!email || !email.includes("@")) { toast("请填写有效的邮箱地址", "error"); return; }
  if (!account && !password) { toast("请填写 SMTP 授权码", "error"); return; }
  const host = smtpHost || mcGuessSmtpHost(email);
  const button = qs<HTMLButtonElement>("#mcAccountSave");
  if (button?.disabled) return;
  if (button) setButtonPending(button, true, account ? "保存修改" : "绑定并同步", "提交中…");
  try {
    const payload: Record<string, unknown> = {
      label: label || email,
      email,
      smtpHost: host,
      smtpPort,
      smtpSecure: smtpPort !== 587,
      smtpUser: email,
      enabled: true,
      imapHost
    };
    if (password) payload.smtpPassword = password;
    let mailboxId = account?.id || "";
    if (account) {
      await api(`/api/sender-mailboxes/${encodeURIComponent(account.id)}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
    } else {
      if (!password) throw new Error("请填写 SMTP 授权码");
      const created = await api<{ mailbox: { id: string } }>("/api/sender-mailboxes", {
        method: "POST",
        body: JSON.stringify({ ...payload, smtpPassword: password })
      });
      mailboxId = created.mailbox?.id || "";
    }
    if (mailboxId) {
      await api(`/api/mail-center/accounts/${encodeURIComponent(mailboxId)}/sync`, {
        method: "PATCH",
        body: JSON.stringify({ syncEnabled, syncIntervalMinutes: interval })
      }).catch(() => undefined);
    }
    closeModal();
    toast(account ? "邮箱已更新" : "邮箱已绑定，开始同步", "success");
    await loadMailCenterAccounts();
    renderMailCenterPage();
    if (!account && mailboxId) {
      void runMailCenterSync(mailboxId);
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
    if (button) setButtonPending(button, false, account ? "保存修改" : "绑定并同步", account ? "保存修改" : "绑定并同步");
  }
}

// ── 事件绑定（委托在静态容器上，重复调用安全）────────────────────────────────

function bindMailCenterPage() {
  const page = qs<HTMLElement>("#mailCenterPage");
  if (!page) return;

  page.onclick = (event) => {
    const target = event.target as HTMLElement;
    // AI 助手抽屉：先于工具卡判断，抽屉里的按钮不带 data-mc-tool
    if (target.closest("[data-mc-assist-close]")) { closeMailCenterAssist(); return; }
    const assistAction = target.closest<HTMLElement>("[data-mc-assist-action]");
    if (assistAction?.dataset.mcAssistAction) {
      mailCenterState.assistAction = assistAction.dataset.mcAssistAction as MailAssistAction;
      // 换动作等于换任务，上一轮的结果必须清掉，否则会误当成新动作的输出
      mailCenterState.assistResult = "";
      mailCenterState.assistError = "";
      renderMailCenterAssist();
      return;
    }
    const assistLang = target.closest<HTMLElement>("[data-mc-assist-lang]");
    if (assistLang?.dataset.mcAssistLang) {
      mailCenterState.assistLang = assistLang.dataset.mcAssistLang === "zh" ? "zh" : "en";
      renderMailCenterAssist();
      return;
    }
    if (target.closest("[data-mc-assist-run]")) { void runMailCenterAssist(); return; }
    if (target.closest("[data-mc-assist-pull]")) { pullMailCenterAssistMessage(); return; }
    if (target.closest("[data-mc-assist-copy]")) { void copyMailCenterAssistResult(); return; }
    if (target.closest("[data-mc-assist-write]")) {
      const message = mailCenterState.activeMessage
        || mailCenterState.messages.find((item) => item.id === mailCenterState.assistMessageId);
      if (!message?.entityType || !message.entityId) {
        toast("这封邮件还没归属客户，先把它绑到客户名下再写信", "error");
        return;
      }
      closeMailCenterAssist();
      if (message.entityType === "customer") {
        const customer = state.customers.find((item) => item.id === message.entityId);
        if (!customer) { toast("客户不存在或无权访问", "error"); return; }
        activateNavView("customers", () => openCustomerDetailPage(customer));
      } else {
        activateNavView("leads", () => void openLead(message.entityId));
      }
      return;
    }
    const toolSuggest = target.closest<HTMLElement>("[data-mc-tool-suggest]");
    if (toolSuggest) {
      mailCenterState.toolKeyword = toolSuggest.dataset.mcToolSuggest || "";
      renderMailCenterToolbox();
      qs<HTMLInputElement>("#mcToolSearch")?.focus();
      return;
    }
    if (target.closest("[data-mc-tool-clear-search]")) {
      mailCenterState.toolKeyword = "";
      renderMailCenterToolbox();
      qs<HTMLInputElement>("#mcToolSearch")?.focus();
      return;
    }
    if (target.closest("[data-mc-tool-clear]")) {
      try {
        localStorage.removeItem(MC_TOOL_RECENT_KEY);
      } catch {
        /* 清不掉也无所谓，下次点击会重新写 */
      }
      const results = qs<HTMLElement>("#mcToolResults");
      if (results) results.innerHTML = renderMailCenterToolResults();
      return;
    }
    const tool = target.closest<HTMLElement>("[data-mc-tool]");
    if (tool) {
      const key = tool.dataset.mcTool || "";
      const item = mailCenterToolSections().flatMap((section) => section.items).find((entry) => entry.key === key);
      // 先记最近使用再执行：有些工具会跳走页面，跳走后就写不进去了
      mcToolRemember(key);
      item?.run();
      // 还在工具箱里的（同步、体检、绑定）就地刷新一下最近使用，别等用户切走再回来
      if (mailCenterState.tab === "toolbox") {
        const results = qs<HTMLElement>("#mcToolResults");
        if (results) results.innerHTML = renderMailCenterToolResults();
      }
      return;
    }
    const tab = target.closest<HTMLElement>("[data-mc-tab]");
    if (tab) {
      openMailCenterTab((tab.dataset.mcTab || "inbox") as MailCenterTab);
      return;
    }
    const folder = target.closest<HTMLElement>("[data-mc-folder]");
    if (folder) {
      const next = folder.dataset.mcFolder || "inbox";
      if (mailCenterState.folder === next) return;
      mailCenterState.folder = next;
      // 切换文件夹等于换了一份数据源：清空详情，别让上一封的内容挂在右边
      mailCenterState.activeMessageId = "";
      mailCenterState.activeMessage = null;
      mailCenterState.direction = "";
      renderMailCenterTabBody();
      void loadMailCenterMessages({ silent: true });
      return;
    }
    const accountAction = target.closest<HTMLElement>("[data-mc-account-action]");
    if (accountAction) {
      const id = accountAction.dataset.mcAccount || "";
      const action = accountAction.dataset.mcAccountAction;
      const account = mailCenterState.accounts.find((item) => item.id === id);
      if (!account) return;
      if (action === "sync") void runMailCenterSync(id);
      if (action === "check") void runMailCenterCheck(id);
      if (action === "edit") openMailCenterAccountModal(account);
      return;
    }
    // 卡片本体 = 按邮箱筛选（卡片里的按钮在上面已经先拦截了）
    const accountSelect = target.closest<HTMLElement>("[data-mc-account-select]");
    if (accountSelect?.dataset.mcAccountSelect) {
      selectMailCenterAccount(accountSelect.dataset.mcAccountSelect);
      return;
    }
    const action = target.closest<HTMLElement>("[data-mc-action]")?.dataset.mcAction;
    if (action) {
      if (action === "compose") { openMailCenterCompose(); return; }
      if (action === "add-account") { openMailCenterAccountModal(); return; }
      if (action === "clear-account") { selectMailCenterAccount(mailCenterState.activeAccountId); return; }
      if (action === "open-mailbox") { openMailCenterMailbox(); return; }
      if (action === "sync-all") { void runMailCenterSync(""); return; }
      if (action === "refresh") { void loadMailCenterMessages(); void loadMailCenterAccounts(); void loadMailCenterFolders(); return; }
      if (action === "reload") { void loadMailCenter({ silent: false }); return; }
      if (action === "open-journey") {
        const [entityType, ...rest] = (target.closest<HTMLElement>("[data-mc-entity]")?.dataset.mcEntity || "").split(":");
        if (!entityType) return;
        mailCenterState.tab = "journey";
        mailCenterState.lookupKeyword = "";
        renderMailCenterPage();
        void loadMailCenterLookup({ silent: true }).then(() => loadMailCenterJourney(entityType, rest.join(":")));
        return;
      }
      if (action === "write-mail") {
        const [entityType, ...rest] = (target.closest<HTMLElement>("[data-mc-entity]")?.dataset.mcEntity || "").split(":");
        const entityId = rest.join(":");
        // 速查列表的数据源是 /api/mail-center/customers（含邮箱）；state.customers 在邮件中心页可能根本没加载，别依赖它
        const item = mailCenterState.lookupItems.find((entry) => entry.entityType === entityType && entry.entityId === entityId)
          || (entityType === "customer"
            ? state.customers.find((entry) => entry.id === entityId)
            : state.leads.find((entry) => entry.id === entityId));
        if (!item) { openMailCenterCompose(); return; }
        const email = ("email" in item ? item.email : "") || "";
        openMailCenterCompose({ to: email });
        if (!email) toast("该档案还没有维护邮箱，已打开写邮件；请先在资料里补上", "warn");
        return;
      }
    }
    const message = target.closest<HTMLElement>("[data-mc-message]");
    if (message?.dataset.mcMessage) { void openMailCenterMessage(message.dataset.mcMessage); return; }
    const openMessage = target.closest<HTMLElement>("[data-mc-open-message]");
    if (openMessage?.dataset.mcOpenMessage) {
      mailCenterState.tab = "inbox";
      renderMailCenterPage();
      void loadMailCenterMessages({ silent: true }).then(() => openMailCenterMessage(openMessage.dataset.mcOpenMessage || ""));
      return;
    }
    const customer = target.closest<HTMLElement>("[data-mc-customer]");
    if (customer?.dataset.mcCustomer) {
      const [entityType, ...rest] = customer.dataset.mcCustomer.split(":");
      void openMailCenterCustomer(entityType, rest.join(":"));
      return;
    }
    const journeyNode = target.closest<HTMLElement>("[data-mc-journey-event]");
    if (journeyNode?.dataset.mcJourneyEvent) {
      selectMailCenterJourneyEvent(journeyNode.dataset.mcJourneyEvent);
      return;
    }
    const journeyStep = target.closest<HTMLElement>("[data-mc-journey-step]");
    if (journeyStep) {
      stepMailCenterJourney(Number(journeyStep.dataset.mcJourneyStep) || 0);
      return;
    }
    if (target.closest<HTMLElement>("[data-mc-journey-replay]")) {
      replayMailCenterJourney();
      return;
    }
    // 详情卡上的「展开正文」必须先于整卡定位判断：它也在卡里
    const focusMore = target.closest<HTMLElement>("[data-mc-focus-more]");
    if (focusMore) {
      void toggleMailCenterJourneyBody(focusMore.dataset.mcFocusMore || "", focusMore);
      return;
    }
    const locate = target.closest<HTMLElement>("[data-mc-locate-event]");
    if (locate?.dataset.mcLocateEvent) {
      void locateMailCenterJourneyEvent(locate.dataset.mcLocateEvent);
      return;
    }
    const journey = target.closest<HTMLElement>("[data-mc-journey]");
    if (journey?.dataset.mcJourney) {
      // 键带视角前缀：entity:<客户|线索>:<id>；列表里的按钮以后还会加别的视角
      const [kind, entityType, ...rest] = journey.dataset.mcJourney.split(":");
      if (kind === "entity" && entityType) void loadMailCenterJourney(entityType, rest.join(":"));
      return;
    }
    // 阅读栏的「旅程」：先展开两个入口（发信人 / 本线程），都不要求这封信已归属客户
    if (target.closest("[data-mc-journey-toggle]")) {
      mailCenterState.journeyMenuOpen = !mailCenterState.journeyMenuOpen;
      renderMailCenterMessageDetail();
      return;
    }
    const mailJourneyButton = target.closest<HTMLElement>("[data-mc-mail-journey]");
    if (mailJourneyButton) {
      const scope = mailJourneyButton.dataset.mcJourneyScope === "thread" ? "thread" : "person";
      void loadMailCenterMessageJourney(
        mailJourneyButton.dataset.mcMailJourney || mailCenterState.activeMessageId,
        scope
      );
      return;
    }
    // 旅程抬头上的两个切换口：从线程切回发信人、或从发信人切到本线程
    const journeyPerson = target.closest<HTMLElement>("[data-mc-journey-person]");
    if (journeyPerson) {
      void loadMailCenterMessageJourney(journeyPerson.dataset.mcJourneyPerson || "", "person");
      return;
    }
    const journeyThread = target.closest<HTMLElement>("[data-mc-journey-thread]");
    if (journeyThread) {
      void loadMailCenterMessageJourney(journeyThread.dataset.mcJourneyThread || "", "thread");
      return;
    }
    // 邮件起点的旅程抬头：回到那封信 / 换成客户视角
    if (target.closest("[data-mc-journey-mail-back]")) {
      backToJourneySourceMail();
      return;
    }
    const journeyEntity = target.closest<HTMLElement>("[data-mc-journey-entity]");
    if (journeyEntity?.dataset.mcJourneyEntity) {
      const [entityType, ...rest] = journeyEntity.dataset.mcJourneyEntity.split(":");
      if (entityType) void loadMailCenterJourney(entityType, rest.join(":"));
      return;
    }
  };

  // 节点悬浮卡：鼠标扫过就能读正文，点浮卡上的按钮直接定位到邮件列表
  bindMcNodeTipGlobal();
  page.onmouseover = (event) => {
    const target = event.target as HTMLElement;
    const node = target.closest<HTMLElement>("[data-mc-journey-event]");
    if (node?.dataset.mcJourneyEvent) {
      showMcNodeTip(node, node.dataset.mcJourneyEvent);
      return;
    }
    if (!target.closest(".mc-node-tip")) hideMcNodeTip();
  };
  page.onmouseout = (event) => {
    const node = (event.target as HTMLElement).closest<HTMLElement>("[data-mc-journey-event]");
    if (!node) return;
    const to = event.relatedTarget as HTMLElement | null;
    // 在节点内部移动（svg/path 之间），或者直接移进浮卡，都别收
    if (to && (to.closest("[data-mc-journey-event]") === node || to.closest(".mc-node-tip"))) return;
    hideMcNodeTip();
  };
  // 键盘也要能用：Tab 到节点看内容，Enter/空格 执行定位
  if (!mcNodeTipFocusBound) {
    mcNodeTipFocusBound = true;
    // focusin/focusout 只能走 addEventListener（HTMLElement 上没有这两个属性），
    // 而 #mailCenterPage 这个壳子在重绘时不会被换掉，所以只绑一次
    page.addEventListener("focusin", (event) => {
      const node = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-mc-journey-event]");
      if (node?.dataset.mcJourneyEvent) showMcNodeTip(node, node.dataset.mcJourneyEvent);
    });
    page.addEventListener("focusout", () => hideMcNodeTip(0));
  }
  page.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    const accountCard = target.closest<HTMLElement>(".mc-account[data-mc-account-select]");
    if (accountCard?.dataset.mcAccountSelect) {
      event.preventDefault();
      selectMailCenterAccount(accountCard.dataset.mcAccountSelect);
      return;
    }
    const card = target.closest<HTMLElement>(".mc-focus[data-mc-locate-event]");
    if (!card) return;
    event.preventDefault();
    void locateMailCenterJourneyEvent(card.dataset.mcLocateEvent || "");
  };

  page.onchange = (event) => {
    const target = event.target as HTMLElement;
    const filter = target.closest<HTMLSelectElement>("[data-mc-filter]")?.dataset.mcFilter;
    if (!filter) return;
    if (filter === "mailbox") {
      mailCenterState.activeAccountId = (target as HTMLSelectElement).value;
      // 账号换了，各文件夹的数量也要跟着换
      void loadMailCenterFolders();
    }
    if (filter === "direction") mailCenterState.direction = (target as HTMLSelectElement).value;
    void loadMailCenterMessages();
  };

  let messageTimer = 0;
  let lookupTimer = 0;
  page.oninput = (event) => {
    const target = event.target as HTMLInputElement;
    // 抽屉正文只写 state、不重绘：重绘会把光标顶回开头
    if (target.id === "mcAssistSource") {
      mailCenterState.assistSource = target.value;
      const run = qs<HTMLButtonElement>("[data-mc-assist-run]");
      if (run) run.disabled = !target.value.trim();
      return;
    }
    if (target.id === "mcMessageSearch") {
      mailCenterState.keyword = target.value;
      window.clearTimeout(messageTimer);
      messageTimer = window.setTimeout(() => void loadMailCenterMessages({ silent: true }), 320);
      return;
    }
    if (target.id === "mcLookupSearch" || target.id === "mcJourneySearch") {
      mailCenterState.lookupKeyword = target.value;
      window.clearTimeout(lookupTimer);
      lookupTimer = window.setTimeout(() => void loadMailCenterLookup({ silent: true }), 320);
      return;
    }
    if (target.id === "mcToolSearch") {
      mailCenterState.toolKeyword = target.value;
      // 只换结果区：整块重画会把输入框连同焦点、光标位置一起换掉
      const results = qs<HTMLElement>("#mcToolResults");
      if (results) results.innerHTML = renderMailCenterToolResults();
      return;
    }
  };

  page.onkeydown = (event) => {
    const target = event.target as HTMLElement;
    if (event.key !== "Enter") return;
    // 抽屉里是多行文本，Enter 必须留给换行；只有 ⌘/Ctrl+Enter 才提交
    if (target.id === "mcAssistSource") {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        void runMailCenterAssist();
      }
      return;
    }
    if (target.id === "mcLookupSearch" || target.id === "mcJourneySearch") {
      event.preventDefault();
      void loadMailCenterLookup();
    }
  };
}
