/**
 * 邮件回流。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, openModal, state } from "../prototype-api";
import { type User } from "./models";
import { formatTime } from "./dashboard";
import { escapeHtml, qs, qsa } from "./shared";
import { api, setButtonPending, toast } from "./ui";
import { updateStoredUser } from "./profile";
import { EMAIL_RETURN_EVENT_META, type EmailReturnFlowLog, type EmailReturnFlowTouchpoint, emailReturnFlowStatusBadges } from "./container-load";

let emailReturnFlowFilter = "all";

export async function renderEmailReturnFlow() {
  const box = qs<HTMLElement>("#emailReturnFlowPage");
  if (!box) return;
  try {
    const profile = await api<{ user: User }>("/api/profile");
    updateStoredUser(profile.user);
  } catch {
    /* 发送台账仍可独立加载，资料状态沿用当前会话缓存。 */
  }
  box.className = "deck";
  const user = state.user;
  const syncState = !user?.inboundSyncEnabled
    ? "off"
    : user.lastInboundSyncStatus === "error"
      ? "error"
      : user.lastInboundSyncAt
        ? "ok"
        : "pending";
  const syncText =
    syncState === "error" ? "收信监听异常"
      : syncState === "ok" ? `收信已同步 · ${formatTime(user!.lastInboundSyncAt!)}`
      : syncState === "pending" ? "收信监听待首次同步"
      : "收信监听未开启";
  const syncBadge = `<span class="deck-sync ${syncState === "ok" ? "is-ok" : syncState === "error" ? "is-error" : "is-warn"}"><span class="dot"></span>${syncText}</span>`;
  box.innerHTML = `
    <div class="deck-top">
      <div class="deck-crumb">Outbound Intelligence · <b>回流</b></div>
      <div class="deck-live">● 收信监听 <b>${escapeHtml(syncState === "ok" ? "已同步" : syncState === "error" ? "异常" : syncState === "pending" ? "待首次同步" : "未开启")}</b></div>
    </div>
    <header class="deck-hero">
      <div>
        <div class="deck-kicker">开发信 · 回流分析</div>
        <h1>开发信<br/><em>回流</em></h1>
        <div class="deck-sub">打开、点击、回信、退信——一封邮件的完整生命周期，压进一屏。</div>
      </div>
      <div class="deck-actions">${syncBadge}${user?.inboundSyncEnabled ? `<button class="deck-btn" id="emailReturnSync">立即同步</button>` : ""}<button class="deck-btn" id="emailReturnRefresh">↻ 刷新</button></div>
    </header>
    <div class="deck-ticker"><div class="deck-run" id="deckTicker"></div></div>
    <div id="emailReturnTrackBanner" style="padding:0 var(--pad-x,24px)"></div>
    <section class="deck-kpis" id="emailReturnStats"><div class="deck-loading"><i></i>加载中…</div></section>
    <div class="deck-toolbar">
      <select id="emailReturnFilter" aria-label="按业务对象筛选">
        <option value="all">全部对象</option>
        <option value="prospect_candidate">搜客候选</option>
        <option value="lead">线索</option>
        <option value="customer">客户</option>
      </select>
      <span class="deck-count" id="emailReturnCount"></span>
    </div>
    <div class="deck-list" id="emailReturnList"><div class="deck-loading"><i></i>正在加载发送记录…</div></div>
  `;
  qs<HTMLButtonElement>("#emailReturnRefresh", box)?.addEventListener("click", () => void renderEmailReturnFlow());
  // 已读追踪状态条：未启用时提醒，启用时显示域名（best-effort，接口失败不影响页面）
  void api<{ config: { enabled: boolean; baseUrl: string; messageIdDomain: string } }>("/api/email-tracking/config").then(({ config }) => {
    const anchor = qs<HTMLElement>("#emailReturnTrackBanner", box);
    if (!anchor) return;
    anchor.innerHTML = config.enabled
      ? `<span class="rf-track is-on">👁 已读追踪已开启 · <b>${escapeHtml(config.messageIdDomain)}</b>（打开/点击信号会自动回流到下方台账）<a href="#" data-goto-tracking>配置</a></span>`
      : `<span class="rf-track is-off">👁 已读追踪未启用——现在发出的邮件无法知道客户有没有看。到 <a href="#" data-goto-tracking>邮件中心 → 邮箱设置</a> 填一个公网地址即可开启</span>`;
    anchor.querySelector<HTMLAnchorElement>("[data-goto-tracking]")?.addEventListener("click", (event) => {
      event.preventDefault();
      activateNavView("mail-settings");
    });
  }).catch(() => { /* 状态条失败不打扰 */ });
  qs<HTMLButtonElement>("#emailReturnSync", box)?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    setButtonPending(button, true, "立即同步", "同步中");
    try {
      const result = await api<{ user: User; summary: { scanned: number; matched: number } }>("/api/profile/inbound-mail/sync", { method: "POST" });
      updateStoredUser(result.user);
      toast(`收信同步完成：扫描 ${result.summary.scanned} 封，匹配 ${result.summary.matched} 封`);
      await renderEmailReturnFlow();
    } catch (error) {
      toast(error instanceof Error ? error.message : "收信同步失败", "error");
      setButtonPending(button, false, "立即同步", "同步中");
    }
  });
  const filter = qs<HTMLSelectElement>("#emailReturnFilter", box);
  if (filter) {
    filter.value = emailReturnFlowFilter;
    filter.addEventListener("change", () => {
      emailReturnFlowFilter = filter.value;
      void loadEmailReturnLogs(box);
    });
  }
  await loadEmailReturnLogs(box);
}

async function loadEmailReturnLogs(box: HTMLElement) {
  const list = qs<HTMLElement>("#emailReturnList", box);
  const stats = qs<HTMLElement>("#emailReturnStats", box);
  const count = qs<HTMLElement>("#emailReturnCount", box);
  if (!list) return;
  try {
    const qsParam = emailReturnFlowFilter && emailReturnFlowFilter !== "all" ? `?entityType=${encodeURIComponent(emailReturnFlowFilter)}` : "";
    const result = await api<{ logs: EmailReturnFlowLog[]; total: number }>(`/api/outbound-emails${qsParam}`);
    const logs = result.logs || [];
    const opened = logs.filter((l) => (l.openCount || 0) > 0).length;
    const clicked = logs.filter((l) => (l.clickCount || 0) > 0).length;
    const replied = logs.filter((l) => l.repliedAt).length;
    const bounced = logs.filter((l) => l.bouncedAt).length;
    if (stats) {
      stats.innerHTML = `
        <div class="deck-kpi"><div class="lab">已发送</div><div class="v">${logs.length}</div></div>
        <div class="deck-kpi"><div class="lab">打开信号</div><div class="v open">${opened}</div></div>
        <div class="deck-kpi"><div class="lab">点击信号</div><div class="v click">${clicked}</div></div>
        <div class="deck-kpi"><div class="lab">回复</div><div class="v reply">${replied}</div></div>
        <div class="deck-kpi"><div class="lab">退信</div><div class="v bounce">${bounced}</div></div>`;
      const deckTicker = qs<HTMLElement>("#deckTicker", box);
      if (deckTicker) {
        const labelOf = (l: EmailReturnFlowLog) =>
          l.bouncedAt ? "退信" : l.repliedAt ? "已回信" : (l.openCount || 0) > 0 ? "已打开" : (l.clickCount || 0) > 0 ? "已点击" : "已发送";
        const items = logs.length
          ? logs.map((l) => `<span><b>${escapeHtml(l.entityName || l.to || "—")}</b> ${labelOf(l)}</span>`)
          : Array.from({ length: 4 }, () => `<span>等待数据 · 去「开发信」发一封，这里会出现回流状态</span>`);
        const seq = items.join("");
        deckTicker.classList.toggle("is-static", !logs.length);
        deckTicker.innerHTML = logs.length ? seq + seq : seq;
      }
    }
    if (count) count.textContent = `共 ${result.total} 条记录`;
    if (!logs.length) {
      list.innerHTML = `<div class="deck-empty"><b>还没有开发信回流数据</b>去「搜客清单」或「开发信」给客户发一封，这里就会出现它的打开 / 点击 / 回信 / 退信状态。</div>`;
      return;
    }
      list.innerHTML = `
      <table>
        <thead><tr><th>收件人 / 对象</th><th>主题</th><th>发送时间</th><th>回流状态</th><th></th></tr></thead>
        <tbody>
          ${logs.map((log) => {
            const ini = escapeHtml((log.entityName || log.to || "?").trim().slice(0, 2));
            return `
            <tr data-message-id="${escapeHtml(log.messageId)}" class="email-return-row">
              <td><span class="deck-avatar">${ini}</span><span class="deck-name">${escapeHtml(log.entityName || log.to || "—")}</span>${log.entityName && log.to ? `<span class="deck-email">${escapeHtml(log.to)}</span>` : ""}</td>
              <td><span class="deck-subject">${escapeHtml(log.subject || "（无主题）")}</span></td>
              <td><span class="deck-time">${escapeHtml(formatTime(log.sentAt))}</span></td>
              <td>${emailReturnFlowStatusBadges(log).replace(/rf-pill/g, "deck-pill")}</td>
              <td><button class="deck-detail" data-detail="${escapeHtml(log.messageId)}">时间线</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
    qsa<HTMLButtonElement>("[data-detail]", list).forEach((button) => {
      button.addEventListener("click", () => void openEmailReturnDetail(button.dataset.detail || ""));
    });
    qsa<HTMLElement>(".email-return-row", list).forEach((row) => {
      row.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        const id = row.dataset.messageId || "";
        if (id) void openEmailReturnDetail(id);
      });
    });
  } catch (error) {
    if (list) list.innerHTML = `<div class="email-return-empty">加载失败：${escapeHtml(error instanceof Error ? error.message : "未知错误")}</div>`;
  }
}

export async function openEmailReturnDetail(messageId: string) {
  if (!messageId) return;
  openModal("开发信回流时间线", `<div class="email-return-detail-loading"><i></i>加载中…</div>`, `<button class="btn" data-modal-close>关闭</button>`);
  try {
    const result = await api<{ log: EmailReturnFlowLog; touchpoints: EmailReturnFlowTouchpoint[] }>(`/api/outbound-emails/${encodeURIComponent(messageId)}`);
    const log = result.log;
    const meta = EMAIL_RETURN_EVENT_META;
    const timeline = result.touchpoints.length
      ? `<ul class="email-return-timeline">${result.touchpoints.map((tp) => {
        const m = meta[tp.eventType || "send"] || meta.send;
        const time = tp.occurredAt ? formatTime(tp.occurredAt) : "";
        const extra = tp.eventType === "click" && tp.content
          ? `<small>链接：${escapeHtml(tp.content)}</small>`
          : tp.subject
            ? `<small>${escapeHtml(tp.subject)}</small>`
            : tp.content
              ? `<small>${escapeHtml(tp.content)}</small>`
              : "";
        return `<li class="ert-${m.cls}"><span class="ert-icon">${m.icon}</span><div><b>${m.label}</b> <span class="ert-time">${escapeHtml(time)}</span>${extra ? `<div>${extra}</div>` : ""}</div></li>`;
      }).join("")}</ul>`
      : `<div class="email-return-empty">暂无回流事件。打开/点击需邮件在公网送达并加载追踪像素；回信/退信需开启 IMAP 收信监听。</div>`;
    const body = `
      <div class="email-return-detail-head">
        <div><span>收件人</span><b>${escapeHtml(log.entityName || log.to || "—")}</b></div>
        <div><span>主题</span><b>${escapeHtml(log.subject || "（无主题）")}</b></div>
        <div><span>发送</span><b>${escapeHtml(formatTime(log.sentAt))}</b></div>
      </div>
      <div class="email-return-detail-status">${emailReturnFlowStatusBadges(log)}</div>
      ${timeline}`;
    openModal(`开发信回流 · ${log.entityName || log.to || "详情"}`, body, `<button class="btn" data-modal-close>关闭</button>`);
  } catch (error) {
    openModal("开发信回流时间线", `<div class="email-return-empty">加载失败：${escapeHtml(error instanceof Error ? error.message : "未知错误")}</div>`, `<button class="btn" data-modal-close>关闭</button>`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 邮件中心（#mail-center）
//   收件箱 / 客户速查 / 交互旅程 / 工具箱
//   账号体系复用「发件邮箱池」（sender_mailboxes），不另建第二套邮箱配置。
// ═══════════════════════════════════════════════════════════════════════════

export type MailCenterTab = "inbox" | "lookup" | "journey" | "toolbox";

export interface MailCenterAccount {
  id: string;
  label: string;
  email: string;
  fromName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  enabled: boolean;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  lastSyncAt: string;
  lastSyncStatus: string;
  lastSyncError: string;
  lastSyncScanned: number;
  lastSyncSaved: number;
  totalMessages: number;
  unreadMessages: number;
  inboundMessages: number;
  matchedMessages: number;
  lastMessageAt: string;
}

export interface MailCenterMessage {
  id: string;
  mailboxId: string;
  mailboxEmail: string;
  direction: "inbound" | "outbound";
  subject: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string[];
  ccAddresses: string[];
  sentAt: string;
  snippet: string;
  bodyText: string;
  hasAttachments: boolean;
  sizeBytes: number;
  entityType: "" | "customer" | "lead";
  entityId: string;
  matchSource: "" | "address" | "domain";
  readAt: string;
  /** 真实 Message-ID 与被回复的 Message-ID（回复/转发线程头用） */
  messageId?: string;
  inReplyTo?: string;
}

export interface MailCenterCustomerItem {
  entityType: "customer" | "lead";
  entityId: string;
  company: string;
  contact: string;
  email: string;
  ownerName: string;
  stage: string;
  mailTotal: number;
  mailInbound: number;
  lastMailAt: string;
}

export interface MailCenterJourneyEvent {
  id: string;
  kind: "outbound" | "inbound" | "bounce" | "activity" | "todo" | "deal";
  at: string;
  title: string;
  detail: string;
  subject: string;
  channel: "email" | "whatsapp" | "phone" | "system";
  direction: "outbound" | "inbound" | "internal";
  status: string;
  classification: string;
  messageId: string;
  source: string;
  /** 这封信的正文摘要（服务端已切掉引用历史与签名） */
  preview?: string;
  /** 对应 mail_center_messages.id；没有原文的事件（跟进/待办/打开点击）为空 */
  mailId?: string;
}

export interface MailCenterJourneyEndpoint {
  mailId: string;
  at: string;
  subject: string;
  from: string;
  direction: string;
}

export interface MailCenterJourney {
  /** 以邮件为起点且未归属客户时为空串 —— 旅程依然成立 */
  entityType: "customer" | "lead" | "";
  entityId: string;
  company: string;
  email: string;
  /** entity = 从客户档案看（自动生成）；person = 和这个发信人的全部往来；thread = 单封邮件所在线程 */
  source?: "entity" | "person" | "thread";
  /** 这封信是否已归属客户/线索（未归属也能看旅程，只是没有跟进与商机） */
  matched?: boolean;
  /** message=信件自身（或同一条往来）已归属；email=按对方地址反查到的档案 */
  matchSource?: "message" | "email" | "";
  anchorMailId?: string;
  anchorEventId?: string;
  anchorSubject?: string;
  anchorAt?: string;
  /** 入口邮件的方向：决定抬头写「发信人」还是「收件人」 */
  anchorDirection?: "inbound" | "outbound";
  counterpart?: string;
  /** 来信的发件人显示名；去信库里没存收件人姓名，为空 */
  counterpartName?: string;
  /** 仅线程视角：这条线程从第一封到最新一封 */
  thread?: {
    key: string;
    count: number;
    origin: MailCenterJourneyEndpoint | null;
    end: MailCenterJourneyEndpoint | null;
  };
  events: MailCenterJourneyEvent[];
  stats: {
    total: number;
    outbound: number;
    inbound: number;
    replies: number;
    bounces: number;
    days: number;
    firstAt: string;
    lastAt: string;
    avgReplyHours: number;
    replyRate: number;
  };
}

export interface MailCenterCustomerDetail {
  entity: { entityType: "customer" | "lead"; entityId: string; company: string; contact: string; ownerName: string };
  email: string;
  messages: MailCenterMessage[];
  stats: { total: number; inbound: number; replies: number; lastReplyAt: string; lastMessageAt: string };
}

export interface MailCenterTool {
  key: string;
  name: string;
  desc: string;
  color: string;
  icon: string;
  badge?: string;
  /** 推荐位：横排大卡（3 个一行），其余工具走 4 列小卡 */
  featured?: boolean;
  run: () => void;
}

export interface MailCenterToolSection {
  /** 分组标识，改文案不影响已记录的最近使用 */
  key: string;
  title: string;
  note: string;
  items: MailCenterTool[];
}

/** AI 邮件助手的六种动作，顺序与后端白名单一致 */
export type MailAssistAction = "draft" | "summarize" | "polish" | "continue" | "translate" | "optimize";

export const mailCenterState: {
  loaded: boolean;
  loading: boolean;
  tab: MailCenterTab;
  accounts: MailCenterAccount[];
  activeAccountId: string;
  direction: string;
  folder: string;
  folders: Array<{ kind: string; label: string; total: number; unread: number }>;
  keyword: string;
  messages: MailCenterMessage[];
  total: number;
  activeMessageId: string;
  activeMessage: MailCenterMessage | null;
  lookupKeyword: string;
  lookupItems: MailCenterCustomerItem[];
  lookupLoading: boolean;
  lookupActive: string;
  lookupDetail: MailCenterCustomerDetail | null;
  journeyKey: string;
  journey: MailCenterJourney | null;
  /** 旅程图上选中的那一个事件；空 = 自动落在最近一条 */
  journeyEventId: string;
  journeyLoading: boolean;
  /** 阅读栏「旅程」按钮展开的两个入口（发信人 / 本线程）；每次换信自动收起 */
  journeyMenuOpen: boolean;
  /** 「从交互旅程定位过来」的那封邮件：列表里闪一下，只闪一次 */
  locatedMessageId: string;
  toolKeyword: string;
  syncing: string;
  /** AI 邮件助手抽屉：输入与结果都放 state，整页重绘后不丢 */
  assistOpen: boolean;
  assistAction: MailAssistAction;
  assistSource: string;
  assistSourceLabel: string;
  assistLang: "en" | "zh";
  assistLoading: boolean;
  assistResult: string;
  assistError: string;
  assistMessageId: string;
  /** 写邮件弹窗：打开时的预填值与发送中标记（弹窗本身是临时 DOM，值走实时读取） */
  composeSending: boolean;
} = {
  loaded: false,
  loading: false,
  tab: "inbox",
  accounts: [],
  activeAccountId: "",
  direction: "",
  folder: "inbox",
  folders: [],
  keyword: "",
  messages: [],
  total: 0,
  activeMessageId: "",
  activeMessage: null,
  lookupKeyword: "",
  lookupItems: [],
  lookupLoading: false,
  lookupActive: "",
  lookupDetail: null,
  journeyKey: "",
  journey: null,
  journeyEventId: "",
  journeyLoading: false,
  journeyMenuOpen: false,
  locatedMessageId: "",
  toolKeyword: "",
  syncing: "",
  assistOpen: false,
  assistAction: "draft",
  assistSource: "",
  assistSourceLabel: "",
  assistLang: "en",
  assistLoading: false,
  assistResult: "",
  assistError: "",
  assistMessageId: "",
  composeSending: false
};

const MC_ICONS: Record<string, string> = {
  sync: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5v5.2h-5.2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.6 6.4 12 13l8.4-6.6"/>',
  inbox: '<path d="M4 13h4l1.6 2.6h4.8L16 13h4"/><path d="M4 13 6.4 5.6A2 2 0 0 1 8.3 4h7.4a2 2 0 0 1 1.9 1.6L20 13v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  shield: '<path d="M12 3 20 7v5c0 5-3.6 8.2-8 9-4.4-.8-8-4-8-9V7z"/><path d="m9 12 2 2 4-4"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6"/>',
  route: '<circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.4 6H14a4 4 0 0 1 0 8H9.5"/><path d="m11.5 17-2.5-2.5L11.5 12"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.6a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.2-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.1z"/>',
  alert: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  reply: '<path d="M9.5 6 4 11.5 9.5 17"/><path d="M4 11.5h9.5A6.5 6.5 0 0 1 20 18v1"/>',
  send: '<path d="M21 3 10.5 13.5"/><path d="M21 3 14.5 21l-4-7.5L3 9.5z"/>',
  ai: '<path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z"/><path d="M18.5 16.5 19.2 18.7 21.5 19.4 19.2 20.1 18.5 22 17.8 20.1 15.5 19.4 17.8 18.7z"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4 17 5-4 4 3 3-2 4 3"/>',
  qr: '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 14h2v2h-2zM18 14h2M14 18h6v2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  wrench: '<path d="M14.7 6.3a4.5 4.5 0 0 1 6 6l-2.1-2.1-1.4 1.4 2.1 2.1a4.5 4.5 0 0 1-6-6L7 14.9a2.1 2.1 0 1 0 3 3z"/>',
  box: '<path d="M3 7.5 12 3l9 4.5-9 4.5z"/><path d="M3 7.5v9L12 21l9-4.5v-9"/><path d="M12 12v9"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h6M7 14h4"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.8h5V7"/><path d="M6.4 7l1 12.2A1.8 1.8 0 0 0 9.2 21h5.6a1.8 1.8 0 0 0 1.8-1.8L17.6 7"/><path d="M10 11v6M14 11v6"/>',
  junk: '<path d="M12 3.6 21 8.4v7.2L12 20.4 3 15.6V8.4z"/><path d="m12 8 1.3 2.4 2.7.4-2 2 .5 2.8-2.5-1.3-2.5 1.3.5-2.8-2-2 2.7-.4z"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 5.5v16"/>',
  // AI 邮件助手用：写信 / 总结 / 润色 / 续写 / 翻译 / 英文优化
  pen: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l4 4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h8"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  wand: '<path d="M5 19 15.5 8.5"/><path d="M16.8 7.2 18 6"/><path d="M14 4.5V3M19.5 9H21M17.8 5.2 19 4"/><path d="M6.5 4.5 7 6l1.5.5L7 7l-.5 1.5L6 7l-1.5-.5L6 6z"/>',
  forward: '<path d="M4 7h8a4 4 0 0 1 0 8H8"/><path d="m11 18-3-3 3-3"/><path d="M17 5v6M20 8h-6"/>',
  translate: '<path d="M4 5h8M8 5v2c0 3.5-2 6-4 7"/><path d="M6 9c.8 2.2 2.4 3.8 4.5 4.6"/><path d="m12.5 20 3.5-9 3.5 9"/><path d="M14 17h4.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.6 9.5h16.8M3.6 14.5h16.8"/><path d="M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z"/>'
};

/** 收件箱页签里的文件夹切换；顺序即展示顺序 */
export const MC_FOLDERS: Array<{ kind: string; label: string; icon: string }> = [
  { kind: "inbox", label: "收件箱", icon: "inbox" },
  { kind: "sent", label: "已发送", icon: "send" },
  { kind: "trash", label: "垃圾箱", icon: "trash" },
  { kind: "junk", label: "垃圾邮件", icon: "junk" }
];

export function mcIcon(name: string) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${MC_ICONS[name] || MC_ICONS.mail}</svg>`;
}

// 头像色板：同一个人永远同一色，靠种子哈希，不随机
const MC_AVATAR_TONES: Array<[string, string]> = [
  ["#4a8ef7", "#83bcff"],
  ["#12a594", "#57cfc0"],
  ["#7c5cff", "#ab93ff"],
  ["#df8a2c", "#f3bd72"],
  ["#dd5878", "#f692a8"],
  ["#5b6f96", "#98accb"]
];

function mcAvatarTone(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return MC_AVATAR_TONES[hash % MC_AVATAR_TONES.length];
}

export function mcAvatar(text: string, seed: string) {
  const raw = (text || "").trim();
  const initial = /^[A-Za-z]/.test(raw) ? raw.charAt(0).toUpperCase() : raw.charAt(0) || "?";
  const [from, to] = mcAvatarTone(seed || raw || "?");
  return `<span class="mc-avatar" style="--a1:${from};--a2:${to}" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

export function mcDateTime(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function mcRelativeTime(value: string) {
  if (!value) return "还没同步";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "—";
  const diff = Date.now() - time;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2 * 86_400_000) return "昨天";
  return mcDateTime(value).slice(0, 10);
}

export function mcSyncIntervalLabel(minutes: number) {
  const value = Number(minutes || 60);
  if (value >= 1440) return "每天";
  if (value >= 60 && value % 60 === 0) return `每 ${value / 60} 小时`;
  return `每 ${value} 分钟`;
}

export function mcSyncTone(account: MailCenterAccount) {
  if (mailCenterState.syncing === account.id) return { cls: "is-running", text: "同步中" };
  if (account.lastSyncStatus === "error") return { cls: "is-error", text: "同步失败" };
  if (account.lastSyncStatus === "ok" || account.lastSyncStatus === "partial") return { cls: "is-ok", text: mcRelativeTime(account.lastSyncAt) };
  return { cls: "", text: account.lastSyncAt ? mcRelativeTime(account.lastSyncAt) : "等待首次同步" };
}

export const MC_REPLY_CLASSIFICATION: Record<string, string> = {
  clear_demand: "明确询盘",
  referral: "转介绍",
  no_current_demand: "暂无需求",
  rejected: "明确拒绝",
  unsubscribed: "要求退订",
  bounced: "退信",
  auto_unknown: "自动回复/待确认"
};

export const MC_SOURCE_LABEL: Record<string, string> = {
  outbound_log: "发信台账",
  mail_center: "邮件",
  touchpoint: "触达记录",
  customer_activity: "客户活动",
  todo: "跟进任务"
};

export function mcEmpty(title: string, desc: string, action = "") {
  return `<div class="mc-empty"><b>${escapeHtml(title)}</b><span>${escapeHtml(desc)}</span>${action}</div>`;
}

export function mcGuessSmtpHost(email: string) {
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (!domain) return "smtp.exmail.qq.com";
  if (/^(qq|foxmail)\.com$/.test(domain)) return "smtp.qq.com";
  if (/^163\.com$/.test(domain)) return "smtp.163.com";
  if (/^126\.com$/.test(domain)) return "smtp.126.com";
  if (/^gmail\.com$/.test(domain)) return "smtp.gmail.com";
  if (/^(outlook|hotmail|live)\.com$/.test(domain)) return "smtp-mail.outlook.com";
  if (/^yahoo\.com$/.test(domain)) return "smtp.yahoo.com";
  if (/^aliyun\.com$/.test(domain)) return "smtp.aliyun.com";
  return `smtp.${domain}`;
}
