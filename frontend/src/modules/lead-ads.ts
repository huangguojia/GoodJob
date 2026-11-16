/**
 * 表单线索：Facebook Lead Ads（经 Make / Zapier 等已过审中转）接入 CRM。
 *
 * 这个页面只做两件事：给出「往哪推、用什么钥匙推」的接入信息，
 * 以及展示已经推进来的线索（含广告系列归因）。
 */
import { activateNavView } from "../prototype-api";
import { escapeHtml, qs } from "./shared";
import { api, toast } from "./ui";
import { formatDateTime } from "./deals";

interface LeadAdsSettingsView {
  settings: { enabled: boolean; ownerId: string; token: string; tokenMasked: string; canReveal: boolean };
  webhook: { path: string; publicUrl: string; localUrl: string };
  owners: Array<{ id: string; name: string; email: string }>;
  stats: { today: number; total: number; lastReceivedAt: string };
}

interface LeadAdsLeadView {
  id: string;
  company: string;
  contact: string;
  email: string;
  phone: string;
  country: string;
  stage: string;
  status: string;
  sourceCampaign: string;
  externalId: string;
  inquiryContent: string;
  createdAt: string;
}

const ICON_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>`;
const ICON_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.6"/></svg>`;
const ICON_INBOX = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13h4l2 3h4l2-3h4"/><path d="M4 13 6.5 5h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/></svg>`;

let leadAdsSettings: LeadAdsSettingsView | null = null;
let leadAdsRows: LeadAdsLeadView[] = [];
let leadAdsTokenRevealed = false;
let leadAdsBound = false;
let leadAdsLoading = false;
/** 令牌显隐会重渲染配置区，用它兜住用户尚未保存的「归属」选择。 */
let leadAdsOwnerDraft: string | null = null;

function flashCopied(button: HTMLElement | null) {
  if (!button) return;
  const label = button.querySelector("span");
  if (!label) return;
  const original = label.textContent || "复制";
  label.textContent = "已复制";
  button.classList.add("is-copied");
  window.setTimeout(() => {
    label.textContent = original;
    button.classList.remove("is-copied");
  }, 1400);
}

function copyText(text: string, label: string, button?: HTMLElement | null) {
  if (!text) return;
  void navigator.clipboard?.writeText(text).then(
    () => {
      toast(`${label}已复制`, "success");
      flashCopied(button || null);
    },
    () => toast("复制失败，请手动选中文本", "error")
  );
}

function leadAdsTokenText() {
  if (!leadAdsSettings) return "";
  const { settings } = leadAdsSettings;
  if (settings.canReveal && leadAdsTokenRevealed) return settings.token;
  return settings.tokenMasked || "尚未生成";
}

function renderLeadAdsStatusPill() {
  const pill = qs<HTMLElement>("#leadAdsStatusPill");
  const text = qs<HTMLElement>("#leadAdsStatusText");
  if (!pill || !text) return;
  const on = Boolean(leadAdsSettings?.settings.enabled);
  pill.classList.toggle("is-on", on);
  text.textContent = leadAdsSettings ? (on ? "接收中" : "已停用") : "读取中";
}

function renderLeadAdsSummary() {
  const host = qs<HTMLElement>("#leadAdsSummary");
  if (!host) return;
  if (!leadAdsSettings) {
    host.innerHTML = `<div class="la-loading">正在读取接入状态…</div>`;
    renderLeadAdsStatusPill();
    return;
  }
  const { stats, settings } = leadAdsSettings;
  const last = stats.lastReceivedAt;
  host.innerHTML = [
    `<div class="la-meter-cell is-primary"><span class="la-meter-label">今日接收</span><b class="la-meter-value">${stats.today}<i>条</i></b><small>表单提交</small></div>`,
    `<div class="la-meter-cell"><span class="la-meter-label">累计接收</span><b class="la-meter-value">${stats.total}<i>条</i></b><small>已进线索池</small></div>`,
    `<div class="la-meter-cell is-time"><span class="la-meter-label">最近接收</span><b class="la-meter-value">${last ? escapeHtml(formatDateTime(last)) : "—"}</b><small>${last ? "后端已写入线索" : "还没有数据进来"}</small></div>`,
    `<div class="la-meter-cell is-state${settings.enabled ? " is-on" : ""}"><span class="la-meter-label">接入状态</span><b class="la-meter-value">${settings.enabled ? "接收中" : "已停用"}</b><small>${settings.tokenMasked ? "令牌已生成" : "尚未生成令牌"}</small></div>`
  ].join("");
  renderLeadAdsStatusPill();
}

function renderLeadAdsConfig() {
  const host = qs<HTMLElement>("#leadAdsConfig");
  if (!host) return;
  if (!leadAdsSettings) {
    host.innerHTML = `<div class="la-loading">正在读取接入配置…</div>`;
    return;
  }
  const { settings, webhook, owners } = leadAdsSettings;
  const selectedOwner = leadAdsOwnerDraft ?? settings.ownerId;
  const owner = owners.find((item) => item.id === selectedOwner);
  host.innerHTML = `
    <div class="la-config">
      <div class="la-field">
        <div class="la-label">公网接收地址 <em>线上</em></div>
        <div class="la-input">
          <span class="la-method">POST</span>
          <code>${escapeHtml(webhook.publicUrl)}</code>
          <button class="la-copy" type="button" data-ads-copy="public" aria-label="复制公网接收地址">${ICON_COPY}<span>复制</span></button>
        </div>
        <span class="la-hint">线上部署生效后可用；部署前先用下方本机地址联调</span>
      </div>
      <div class="la-field">
        <div class="la-label">本机地址 <em>联调</em></div>
        <div class="la-input">
          <span class="la-method">POST</span>
          <code>${escapeHtml(webhook.localUrl)}</code>
          <button class="la-copy" type="button" data-ads-copy="local" aria-label="复制本机接收地址">${ICON_COPY}<span>复制</span></button>
        </div>
        <span class="la-hint">只能在本机访问，中转平台在云端打不到</span>
      </div>
      <div class="la-field is-wide is-token">
        <div class="la-label">接入令牌 <em>请求头 X-GoodJob-LeadAds-Token</em></div>
        <div class="la-input">
          <code class="la-token-value">${escapeHtml(leadAdsTokenText())}</code>
          ${settings.canReveal ? `<button class="la-copy" type="button" data-ads-token-toggle aria-label="${leadAdsTokenRevealed ? "隐藏令牌" : "显示令牌"}">${ICON_EYE}<span>${leadAdsTokenRevealed ? "隐藏" : "显示"}</span></button>` : ""}
          <button class="la-copy" type="button" data-ads-token-copy aria-label="复制接入令牌">${ICON_COPY}<span>复制</span></button>
        </div>
        <span class="la-hint">${settings.canReveal ? "令牌等同写线索的钥匙，别贴进公开群或截图" : "当前账号只能查看令牌尾号，需要管理权限才能复制"}</span>
      </div>
      <div class="la-field is-wide is-inline">
        <div class="la-label">线索归属</div>
        <select id="leadAdsOwnerSelect">
          <option value="">自动（优先管理员）</option>
          ${owners.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selectedOwner ? " selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.email)}</option>`).join("")}
        </select>
        <span class="la-hint">${owner ? `当前落在 ${escapeHtml(owner.name)} 名下` : "当前按创建时间挑第一个有建线索权限的账号"}</span>
      </div>
    </div>
    <div class="la-actions">
      <button class="btn primary" type="button" id="leadAdsSaveButton">${settings.enabled ? "保存配置" : "启用接收"}</button>
      ${settings.enabled ? `<button class="btn" type="button" id="leadAdsDisableButton">停用接收</button>` : ""}
      <button class="btn" type="button" id="leadAdsRotateButton">重置令牌</button>
    </div>`;
}

function stageTone(stage: string) {
  if (/成交|赢单|已签|签约/u.test(stage)) return "green";
  if (/报价|方案|谈判/u.test(stage)) return "aqua";
  if (/跟进|沟通|推进|联系/u.test(stage)) return "amber";
  if (/新/u.test(stage)) return "blue";
  return "gray";
}

function renderLeadAdsRows() {
  const body = qs<HTMLElement>("#leadAdsRows");
  if (!body) return;
  const counter = qs<HTMLElement>("#leadAdsCount");
  if (counter) counter.textContent = `${leadAdsRows.length} 条`;
  if (!leadAdsRows.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="la-empty">
      <span class="la-empty-icon">${ICON_INBOX}</span>
      <b>还没有表单线索</b>
      <small>中转服务推送成功后，记录会立刻出现在这里；可先用本机地址发一条测试。</small>
    </div></td></tr>`;
    return;
  }
  const dash = `<span class="la-dash">—</span>`;
  body.innerHTML = leadAdsRows.map((row, index) => {
    const company = row.company || "";
    const initial = company.trim().charAt(0) || "?";
    const stage = row.stage || "";
    return `
    <tr style="--la-i:${index}">
      <td class="la-time">${escapeHtml(formatDateTime(row.createdAt))}</td>
      <td><div class="la-company"><span class="la-avatar">${escapeHtml(initial)}</span><b>${escapeHtml(company || "—")}</b></div></td>
      <td>${row.contact ? escapeHtml(row.contact) : dash}</td>
      <td class="la-mail">${row.email ? escapeHtml(row.email) : dash}</td>
      <td>${row.country ? escapeHtml(row.country) : dash}</td>
      <td>${row.sourceCampaign ? `<span class="la-campaign" title="${escapeHtml(row.sourceCampaign)}">${escapeHtml(row.sourceCampaign)}</span>` : dash}</td>
      <td>${stage ? `<span class="badge ${stageTone(stage)}">${escapeHtml(stage)}</span>` : dash}</td>
    </tr>`;
  }).join("");
}

export function renderLeadAdsWorkspace() {
  renderLeadAdsSummary();
  renderLeadAdsConfig();
  renderLeadAdsRows();
}

export async function loadLeadAdsData() {
  if (leadAdsLoading) return;
  leadAdsLoading = true;
  try {
    const [settings, rows] = await Promise.all([
      api<LeadAdsSettingsView>("/api/lead-ads/settings"),
      api<{ leads: LeadAdsLeadView[] }>("/api/lead-ads/leads")
    ]);
    leadAdsSettings = settings;
    leadAdsRows = rows.leads || [];
    renderLeadAdsWorkspace();
  } catch (error) {
    toast(error instanceof Error ? error.message : "表单线索加载失败", "error");
    const summary = qs<HTMLElement>("#leadAdsSummary");
    if (summary) summary.innerHTML = `<div class="la-loading">接入信息读取失败，稍后重试</div>`;
  } finally {
    leadAdsLoading = false;
  }
}

async function saveLeadAdsSettings(payload: { enabled: boolean; ownerId: string; rotateToken: boolean }, button: HTMLButtonElement | null, doneText: string) {
  button?.setAttribute("disabled", "disabled");
  try {
    await api("/api/lead-ads/settings", { method: "POST", body: JSON.stringify(payload) });
    leadAdsTokenRevealed = false;
    leadAdsOwnerDraft = null;
    toast(doneText, "success");
    await loadLeadAdsData();
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
  } finally {
    button?.removeAttribute("disabled");
  }
}

export function bindLeadAdsEvents() {
  if (leadAdsBound) return;
  leadAdsBound = true;

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("#leadAdsRefreshButton")) {
      void loadLeadAdsData();
      return;
    }
    if (target.closest("#leadAdsOpenLeadsButton")) {
      activateNavView("leads");
      return;
    }
    const copyButton = target.closest<HTMLElement>("[data-ads-copy]");
    if (copyButton) {
      const key = copyButton.dataset.adsCopy === "local" ? "localUrl" : "publicUrl";
      copyText(leadAdsSettings?.webhook[key] || "", "接收地址", copyButton);
      return;
    }
    if (target.closest("[data-ads-token-toggle]")) {
      const select = qs<HTMLSelectElement>("#leadAdsOwnerSelect");
      if (select) leadAdsOwnerDraft = select.value;
      leadAdsTokenRevealed = !leadAdsTokenRevealed;
      renderLeadAdsConfig();
      return;
    }
    const tokenCopyButton = target.closest<HTMLElement>("[data-ads-token-copy]");
    if (tokenCopyButton) {
      if (!leadAdsSettings?.settings.token) {
        toast("当前账号无法查看令牌全文", "error");
        return;
      }
      copyText(leadAdsSettings.settings.token, "令牌", tokenCopyButton);
      return;
    }
    const saveButton = target.closest<HTMLButtonElement>("#leadAdsSaveButton");
    if (saveButton && leadAdsSettings) {
      void saveLeadAdsSettings({
        enabled: true,
        ownerId: qs<HTMLSelectElement>("#leadAdsOwnerSelect")?.value || "",
        rotateToken: false
      }, saveButton, "已启用表单线索接收");
      return;
    }
    const disableButton = target.closest<HTMLButtonElement>("#leadAdsDisableButton");
    if (disableButton && leadAdsSettings) {
      void saveLeadAdsSettings({
        enabled: false,
        ownerId: qs<HTMLSelectElement>("#leadAdsOwnerSelect")?.value || "",
        rotateToken: false
      }, disableButton, "已停用表单线索接收");
      return;
    }
    const rotateButton = target.closest<HTMLButtonElement>("#leadAdsRotateButton");
    if (rotateButton && leadAdsSettings) {
      if (!window.confirm("重置后旧令牌立即失效，Make / Zapier 那边必须同步改成新令牌。继续？")) return;
      void saveLeadAdsSettings({
        enabled: leadAdsSettings.settings.enabled,
        ownerId: qs<HTMLSelectElement>("#leadAdsOwnerSelect")?.value || "",
        rotateToken: true
      }, rotateButton, "令牌已重置，请同步更新中转服务");
    }
  });
}
