/**
 * 系统日志。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { logCategoryFilterValue, logLevelFilterValue, logSearchValue, state } from "../prototype-api";
import { type Shipment } from "./models";
import { escapeHtml, qs } from "./shared";
import { api } from "./ui";
import { COURIER_MAP, SHIPMENT_STATUS_LABEL } from "./products";
import { SHIP_STEPS, type ShipIconName, shIcon } from "./insights";

// ---- 系统日志：类型 / 标签 / 图标 / 写入 ----
type LogLevel = "info" | "success" | "warning" | "error";
export type LogCategory = "auth" | "product" | "shipment" | "system";
export interface LogEntry {
  id: string;
  level: LogLevel;
  category: LogCategory;
  action: string;
  message: string;
  actorId: string;
  actorName: string;
  meta: Record<string, unknown>;
  createdAt: string;
  ownerId: string;
  teamId: string;
}
const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  info: "信息", success: "成功", warning: "警告", error: "错误"
};
export const LOG_CATEGORY_LABEL: Record<LogCategory, string> = {
  auth: "认证", product: "产品", shipment: "发货", system: "系统"
};
const LOG_CATEGORY_ICON: Record<LogCategory, string> = {
  auth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  product: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  shipment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/></svg>',
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'
};
export const LOG_LEVEL_ICON: Record<LogLevel, string> = {
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>'
};

export async function recordLog(entry: {
  level: LogLevel; category: LogCategory; action: string; message: string; meta?: Record<string, unknown>;
}): Promise<void> {
  if (!state.user) return;
  const payload = {
    level: entry.level,
    category: entry.category,
    action: entry.action,
    message: entry.message,
    actorId: state.user.id,
    actorName: state.user.name,
    meta: entry.meta || {},
    createdAt: new Date().toISOString()
  };
  try {
    await api<{ log: LogEntry }>("/api/tools/logs", { method: "POST", body: JSON.stringify(payload) });
  } catch (err) {
    console.warn("记录系统日志失败:", err);
  }
}

const COURIER_BRAND: Record<string, { c: string; m: string; t?: string }> = {
  sf: { c: "#111111", m: "SF" }, yto: { c: "#2b6cb0", m: "YTO" }, zto: { c: "#e4002b", m: "ZTO" }, sto: { c: "#0a7d3f", m: "STO" },
  yunda: { c: "#2b3a8c", m: "YD" }, jd: { c: "#e1251b", m: "JD" }, ems: { c: "#007a33", m: "EMS" },
  dhl: { c: "#ffcc00", m: "DHL", t: "#d40511" }, fedex: { c: "#4d148c", m: "FX" }, ups: { c: "#644117", m: "UPS" }, tt: { c: "#1a73e8", m: "17" }
};
export function courierBadge(key: string): string {
  const b = COURIER_BRAND[key] || { c: "#6b7280", m: (key || "?").toUpperCase().slice(0, 3) };
  const label = COURIER_MAP[key]?.label || key || "—";
  return `<span class="sh-courier-mark" style="--c:${b.c};--ct:${b.t || "#ffffff"}">${shIcon("truck")}<span>${escapeHtml(label)}</span></span>`;
}

export function stepperNodesHtml(s: Shipment): string {
  if (s.status === "exception") {
    return `<span class="sh-step exception is-current"><span class="sh-step-ico">${shIcon("exception")}</span><span class="sh-step-label">${SHIPMENT_STATUS_LABEL.exception}</span></span>`;
  }
  const step = SHIP_STEPS.indexOf(s.status);
  return SHIP_STEPS.map((st, i) => {
    const cls = i < step ? "done" : i === step ? "current" : "todo";
    return `<span class="sh-step ${cls}"><span class="sh-step-ico">${shIcon(st as ShipIconName)}</span><span class="sh-step-label">${SHIPMENT_STATUS_LABEL[st]}</span></span>`;
  }).join("");
}

function formatLogTime(iso: string): { rel: string; abs: string } {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { rel: "—", abs: iso };
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  let rel: string;
  if (min < 1) rel = "刚刚";
  else if (min < 60) rel = `${min} 分钟前`;
  else if (min < 1440) rel = `${Math.floor(min / 60)} 小时前`;
  else rel = `${Math.floor(min / 1440)} 天前`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const abs = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { rel, abs };
}
function isSameDay(iso: string): boolean {
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

export async function loadLogs(): Promise<void> {
  const board = qs<HTMLElement>("#logBoard");
  if (board) board.innerHTML = `<div class="lg-empty"><div class="lg-empty-icon">…</div><p>加载中…</p></div>`;
  try {
    const params = new URLSearchParams();
    if (logLevelFilterValue) params.set("level", logLevelFilterValue);
    if (logCategoryFilterValue) params.set("category", logCategoryFilterValue);
    if (logSearchValue) params.set("keyword", logSearchValue);
    const result = await api<{ logs: LogEntry[] }>(`/api/tools/logs?${params.toString()}`);
    state.logs = result.logs || [];
    renderLogs();
  } catch (err) {
    if (board) board.innerHTML = `<div class="lg-empty"><div class="lg-empty-icon">!</div><p>日志加载失败：${err instanceof Error ? err.message : "未知错误"}</p></div>`;
  }
}

function renderLogs(): void {
  const board = qs<HTMLElement>("#logBoard");
  const empty = qs<HTMLElement>("#logEmpty");
  if (!board) return;
  const all = state.logs.slice();
  const set = (id: string, v: string | number) => { const el = qs<HTMLElement>(id); if (el) el.textContent = String(v); };
  set("#logCount", all.length);
  set("#logToday", all.filter((l) => isSameDay(l.createdAt)).length);
  set("#logWarn", all.filter((l) => l.level === "warning").length);
  set("#logErr", all.filter((l) => l.level === "error").length);
  if (!all.length) {
    board.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  board.innerHTML = all.map(logRowHtml).join("");
}

function logRowHtml(l: LogEntry): string {
  const t = formatLogTime(l.createdAt);
  return `
  <article class="lg-row" data-log-id="${escapeHtml(l.id)}">
    <div class="lg-time"><b>${t.rel}</b>${t.abs}</div>
    <div class="lg-ico lg-lv-${l.level}">${LOG_LEVEL_ICON[l.level]}</div>
    <div class="lg-cat">${LOG_CATEGORY_ICON[l.category]}<span>${LOG_CATEGORY_LABEL[l.category]}</span></div>
    <div class="lg-main">
      <div class="lg-msg">${escapeHtml(l.message)}</div>
      <div class="lg-meta"><span class="lg-tag">${escapeHtml(l.action)}</span><span>${escapeHtml(LOG_LEVEL_LABEL[l.level])}</span></div>
    </div>
    <div class="lg-actor"><b>${escapeHtml(l.actorName || "系统")}</b><span>${escapeHtml(l.category)}</span></div>
  </article>`;
}

export function openLogDrawer(l: LogEntry): void {
  const drawer = qs<HTMLElement>("#logDrawer");
  const inner = qs<HTMLElement>("#logDrawerInner");
  const scrim = qs<HTMLElement>("#logScrim");
  if (!drawer || !inner) return;
  const t = formatLogTime(l.createdAt);
  const metaJson = l.meta && Object.keys(l.meta).length
    ? `<div class="lg-drawer-sec"><h4>附加信息 (meta)</h4><pre class="lg-json">${escapeHtml(JSON.stringify(l.meta, null, 2))}</pre></div>`
    : "";
  inner.innerHTML = `
    <button class="lg-drawer-close" id="logDrawerClose" type="button" aria-label="关闭">&times;</button>
    <div class="lg-row-head">
      <div class="lg-ico lg-lv-${l.level}">${LOG_LEVEL_ICON[l.level]}</div>
      <div>
        <div class="lg-cat">${LOG_CATEGORY_ICON[l.category]}<span>${LOG_CATEGORY_LABEL[l.category]} · ${LOG_LEVEL_LABEL[l.level]}</span></div>
        <h2>${escapeHtml(l.message)}</h2>
      </div>
    </div>
    <div class="lg-drawer-sec"><h4>概览</h4>
      <dl class="lg-def">
        <div><dt>动作</dt><dd class="lg-mono">${escapeHtml(l.action)}</dd></div>
        <div><dt>等级</dt><dd>${escapeHtml(LOG_LEVEL_LABEL[l.level])}</dd></div>
        <div><dt>分类</dt><dd>${escapeHtml(LOG_CATEGORY_LABEL[l.category])}</dd></div>
        <div><dt>操作人</dt><dd>${escapeHtml(l.actorName || "系统")}</dd></div>
        <div><dt>操作人ID</dt><dd class="lg-mono">${escapeHtml(l.actorId)}</dd></div>
        <div><dt>记录ID</dt><dd class="lg-mono">${escapeHtml(l.id)}</dd></div>
        <div><dt>时间</dt><dd class="lg-mono">${t.abs}</dd></div>
      </dl>
    </div>
    ${metaJson}`;
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  if (scrim) scrim.hidden = false;
  qs<HTMLElement>("#logDrawerClose")?.addEventListener("click", closeLogDrawer);
  scrim?.addEventListener("click", closeLogDrawer, { once: true });
}

function closeLogDrawer(): void {
  const drawer = qs<HTMLElement>("#logDrawer");
  const scrim = qs<HTMLElement>("#logScrim");
  drawer?.classList.remove("is-open");
  drawer?.setAttribute("aria-hidden", "true");
  if (scrim) scrim.hidden = true;
}
