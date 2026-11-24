/**
 * 工作区页签、二级菜单、主题换肤。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, renderOpenWorkspaceTabs, state } from "../prototype-api";
import { type User } from "./models";
import { refreshAll } from "./dashboard";
import { syncWhatsAppFrameTheme } from "./customers";
import { activeTodos, qs, storage } from "./shared";
import { api, toast } from "./ui";
import { applyAuthedUser, canAccessWorkspaceView, hasIamCapability } from "./auth";

export function openSecondaryDropdownForView(view: string) {
  const activeButton = qs<HTMLButtonElement>(`.sidebar button[data-view="${CSS.escape(view)}"]`);
  const section = activeButton?.closest<HTMLDetailsElement>(".nav-section");
  if (section) section.open = true;
}

export function workspaceViewStorageKey(user = state.user) {
  return `${storage.workspaceView}:${user?.id || "anonymous"}`;
}

export function rememberedWorkspaceView(user = state.user) {
  const view = sessionStorage.getItem(workspaceViewStorageKey(user)) || "dashboard";
  if (!qs<HTMLElement>(`#${CSS.escape(view)}`) || !canAccessWorkspaceView(view, user)) return "dashboard";
  return view;
}

/* ===================== 主题换肤 (Theme / Skin) ===================== */
type ThemeColors = { brand: string; brandStrong: string; brand2: string; brandTint: string; nav: string; ring: string };

export const THEME_PRESETS: { id: string; name: string; desc: string; colors: string[] }[] = [
  { id: "ocean",   name: "青绿 Ocean",   desc: "海洋 · 外贸本色", colors: ["#0f766e", "#0b5d57", "#e7f6f3", "#0c2b27"] },
  { id: "indigo",  name: "靛蓝 Indigo",  desc: "理性 · 商务沉稳", colors: ["#4f46e5", "#3730a3", "#eef0ff", "#151a35"] },
  { id: "amber",   name: "琥珀 Amber",   desc: "暖金 · 高级质感", colors: ["#b45309", "#8a3e0b", "#fbf1dd", "#271708"] },
  { id: "rose",    name: "玫红 Rose",    desc: "活力 · 现代醒目", colors: ["#be123c", "#9f1239", "#fdecee", "#2b0e17"] },
  { id: "paper",   name: "晨白 Paper",   desc: "浅色侧栏 · 轻盈留白", colors: ["#6366f1", "#a5b4fc", "#eef0ff", "#fbfcfd"] },
  { id: "slate",   name: "石墨 Slate",   desc: "中性 · 极简专业", colors: ["#334155", "#1e293b", "#eef2f6", "#0f172a"] },
  { id: "emerald", name: "翠绿 Emerald", desc: "自然 · 生机清新", colors: ["#047857", "#065f46", "#e7f8f1", "#072a20"] },
  { id: "violet",  name: "紫罗兰 Violet", desc: "优雅 · 神秘高贵", colors: ["#7c3aed", "#6d28d9", "#f3eefe", "#1b1233"] },
  { id: "azure",   name: "天青 Azure",   desc: "清爽 · 科技蓝调", colors: ["#1d6fb8", "#15578f", "#e8f3fb", "#0b1f33"] },
  { id: "coral",   name: "珊瑚 Coral",   desc: "热情 · 珊瑚暖调", colors: ["#e11d48", "#be123c", "#fdeaee", "#2a0a16"] },
  { id: "midnight",name: "午夜 Midnight",desc: "深邃 · 夜空静谧", colors: ["#1e3a8a", "#172554", "#e8edfb", "#0b1430"] },
  { id: "forest",  name: "森绿 Forest",  desc: "沉稳 · 森林绿意", colors: ["#166534", "#14532d", "#e7f6ec", "#072a18"] },
  { id: "magenta", name: "品红 Magenta", desc: "魅惑 · 潮流粉紫", colors: ["#c026d3", "#86198f", "#f9eafc", "#2a0b2e"] },
  { id: "sky",     name: "晴空 Sky",     desc: "明朗 · 天际蔚蓝", colors: ["#0369a1", "#075985", "#e6f3fa", "#07273a"] },
];
const THEME_STORAGE_KEY = "gj-theme";
// 系统默认主题：晨白 Paper（与 index.html 的 <html data-theme="paper"> 保持一致，
// 两处需同步修改）。登录页在 boot 阶段即套用该默认值。
export const THEME_DEFAULT = "paper";

function getStoredTheme(): string {
  try { return localStorage.getItem(THEME_STORAGE_KEY) || ""; } catch { return ""; }
}
export function getInitialTheme(): string {
  return state.user?.theme || getStoredTheme() || THEME_DEFAULT;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2; const d = max - min;
  if (d) { s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4; } h /= 6; }
  return { h: h * 360, s, l };
}
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h /= 360;
  const f = (p: number, q: number, t: number) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  let r: number, g: number, b: number;
  if (!s) { r = g = b = l; } else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = l * 2 - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return { r: r * 255, g: g * 255, b: b * 255 };
}
function relLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const a = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * a(r) + 0.7152 * a(g) + 0.0722 * a(b);
}
export function contrastRatio(fg: string, bg: string): number {
  const L1 = relLuminance(fg), L2 = relLuminance(bg);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}
function clamp(v: number, min: number, max: number): number { return Math.max(min, Math.min(max, v)); }

function deriveThemeColors(hexInput: string): ThemeColors {
  const hex = /^#[0-9a-fA-F]{6}$/.test(hexInput) ? hexInput : "#0f766e";
  const { r, g, b } = hexToRgb(hex);
  let { h, s, l } = rgbToHsl(r, g, b);
  let brandL = l, guard = 0;
  while (contrastRatio("#ffffff", rgbToHex(hslToRgb(h, s, brandL).r, hslToRgb(h, s, brandL).g, hslToRgb(h, s, brandL).b)) < 4.5 && guard < 24) {
    brandL = Math.max(0.12, brandL - 0.03); guard++;
  }
  const br = hslToRgb(h, s, brandL);
  const brand = rgbToHex(br.r, br.g, br.b);
  const st = hslToRgb(h, clamp(s + 0.04, 0.3, 1), Math.max(brandL - 0.10, 0.12));
  const brandStrong = rgbToHex(st.r, st.g, st.b);
  const t2 = hslToRgb(h, s, Math.max(brandL - 0.04, 0.14));
  const brand2 = rgbToHex(t2.r, t2.g, t2.b);
  const tt = hslToRgb(h, Math.min(s, 0.5), Math.min(brandL + 0.42, 0.94));
  const brandTint = rgbToHex(tt.r, tt.g, tt.b);
  const nv = hslToRgb(h, Math.min(s + 0.08, 1), Math.max(brandL - 0.30, 0.06));
  const nav = rgbToHex(nv.r, nv.g, nv.b);
  const ring = `rgba(${r}, ${g}, ${b}, .18)`;
  return { brand, brandStrong, brand2, brandTint, nav, ring };
}

export function applyTheme(theme: string): void {
  const root = document.documentElement;
  ["--brand", "--brand-strong", "--brand-2", "--brand-tint", "--nav", "--brand-ring"].forEach((v) => root.style.removeProperty(v));
  if (theme.startsWith("custom:")) {
    const hex = theme.slice(7);
    const c = deriveThemeColors(hex);
    root.dataset.theme = "custom";
    root.style.setProperty("--brand", c.brand);
    root.style.setProperty("--brand-strong", c.brandStrong);
    root.style.setProperty("--brand-2", c.brand2);
    root.style.setProperty("--brand-tint", c.brandTint);
    root.style.setProperty("--nav", c.nav);
    root.style.setProperty("--brand-ring", c.ring);
  } else {
    root.dataset.theme = theme || THEME_DEFAULT;
  }
  // 换肤后同步已挂载的即刻沟通 iframe（未挂载时是空操作）。
  syncWhatsAppFrameTheme();
}

export async function saveTheme(theme: string): Promise<void> {
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* ignore */ }
  try {
    await api<{ theme: string }>("/api/profile/theme", { method: "PATCH", body: JSON.stringify({ theme }) });
  } catch (e) {
    toast("主题已在本地保存，但同步到账号失败", "error");
  }
  if (state.user) state.user.theme = theme;
}
export function setThemeStatus(msg: string, kind: "preview" | "saved"): void {
  const el = qs<HTMLElement>("#themeStatus");
  if (!el) return;
  el.textContent = msg;
  el.className = `th-status th-status-${kind}`;
}

export function renderTopbarForView(view: string) {
  const searchWrap = qs<HTMLElement>("#topSearchWrap");
  const searchInput = qs<HTMLInputElement>("#topSearchInput");
  const context = qs<HTMLElement>("#topActionContext");
  const primaryButton = qs<HTMLButtonElement>("#topPrimaryAction");
  const primaryText = primaryButton?.querySelector("span");
  const isCustomerView = view === "customers";

  if (view === "platform-operations") {
    searchWrap?.classList.add("is-hidden");
    context?.classList.add("is-hidden");
    if (primaryButton) primaryButton.hidden = true;
    renderOpenWorkspaceTabs(view);
    return;
  }

  searchWrap?.classList.remove("is-hidden");
  qs<HTMLElement>("#topSearchToggle")?.setAttribute("aria-expanded", "false");
  context?.classList.toggle("is-hidden", !isCustomerView);
  if (searchInput) {
    // 搜索框现在是「点开才出现」，没有 placeholder 就是一个空槽，没人知道该输什么。
    // 客户视图按客户找，其他视图按模块名直达。
    searchInput.placeholder = isCustomerView ? "搜索客户、联系人、国家或产品" : "搜索模块，回车直达";
    searchInput.tabIndex = -1;
  }
  if (primaryButton) primaryButton.hidden = !isCustomerView || Boolean(state.iamCapabilities && !hasIamCapability("customer.create"));
  if (primaryText && isCustomerView) primaryText.textContent = "新增客户";
  renderOpenWorkspaceTabs(view);
  renderTopbarStats();
}

export function renderTopbarStats() {
  const todoCount = activeTodos(state.todos).filter((todo) => !todo.done).length;
  const todoNode = qs<HTMLElement>("#topTodoCount");
  if (todoNode) todoNode.textContent = String(todoCount);
  // 0 件时收回中性色，别用品牌色块喊「0」
  qs<HTMLElement>("#topTodoPill")?.classList.toggle("is-empty", todoCount === 0);
}

export async function loadProductConfig() {
  const versionNode = qs<HTMLElement>("#loginProductVersion");
  try {
    const response = await fetch("/product-config.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json() as { productName?: string; version?: string };
    const productName = String(config.productName || "GoodJob CRM").trim();
    const version = String(config.version || "").trim();
    if (versionNode) versionNode.textContent = version ? `${productName} · 版本 ${version}` : productName;
    if (version) document.title = `${productName} ${version} · 外贸客户管理系统`;
  } catch {
    if (versionNode) versionNode.textContent = "GoodJob CRM";
  }
}

export function resolveTopbarSearchView(rawValue: string) {
  const value = rawValue.trim().toLowerCase();
  if (!value) return null;
  const candidates: Array<[string, string]> = [
    ["工作台", "dashboard"],
    ["待办", "todo"],
    ["todo", "todo"],
    ["搜客清单", "prospect-list"],
    ["开发信", "prospect-list"],
    ["清单", "prospect-list"],
    ["搜客", "lead-finder"],
    ["获客", "lead-finder"],
    ["线索搜索", "lead-finder"],
    ["lead", "lead-finder"],
    ["prospect", "prospect-list"],
    ["ai agent", "ai-agent"],
    ["智能体", "ai-agent"],
    ["集成中心", "integration-center"],
    ["对接", "exchange"],
    ["报文", "exchange"],
    ["集成", "integration-center"],
    ["连接器", "integration-center"],
    ["mcp", "integration-center"],
    ["integration", "integration-center"],
    ["销售能力训练", "sales-distillation"],
    ["销售训练", "sales-distillation"],
    ["业务员蒸馏", "sales-distillation"],
    ["ai", "ai-config"],
    ["gpt", "ai-config"],
    ["模型", "ai-config"],
    ["apikey", "ai-config"],
    ["api key", "ai-config"],
    ["AI配置", "ai-config"],
    ["个人", "profile"],
    ["个人主页", "profile"],
    ["个人设置", "profile"],
    ["邮箱", "profile"],
    ["profile", "profile"],
    ["开发信回流", "email-return-flow"],
    ["回流", "email-return-flow"],
    ["邮件追踪", "email-return-flow"],
    ["回信", "email-return-flow"],
    ["退信", "email-return-flow"],
    ["客户公池", "customer-pool"],
    ["公池", "customer-pool"],
    ["客户", "customers"],
    ["customer", "customers"],
    ["communication", "whatsapp"],
    ["whatsapp", "whatsapp"],
    ["商机", "pipeline"],
    ["pipeline", "pipeline"],
    ["提醒", "reminders"],
    ["reminder", "reminders"],
    ["导入", "imports"],
    ["导出", "imports"],
    ["import", "imports"],
    ["数据库维护", "database-maintenance"],
    ["数据库迁移", "database-maintenance"],
    ["数据库备份", "database-maintenance"],
    ["mysql备份", "database-maintenance"],
    ["单据", "documents"],
    ["发票", "documents"],
    ["pi", "documents"],
    ["ci", "documents"],
    ["invoice", "documents"],
    ["document", "documents"],
    ["提成", "commission"],
    ["对账", "commission"],
    ["commission", "commission"],
    ["报表", "reports"],
    ["report", "reports"],
    ["企业微信", "wecom"],
    ["微信", "wecom"],
    ["日报", "daily-reports"],
    ["daily report", "daily-reports"],
    ["通知", "inbox"],
    ["消息", "inbox"],
    ["notification", "inbox"],
    ["inbox", "inbox"],
    ["资料", "knowledge"],
    ["knowledge", "knowledge"],
    ["考试", "exam"],
    ["exam", "exam"],
    ["工具", "tools"],
    ["ocr", "tools"],
    ["竞争", "competitors"],
    ["competitor", "competitors"],
    ["案例", "cases"],
    ["case", "cases"],
    ["问题", "problems"],
    ["problem", "problems"],
    ["备忘", "memos"],
    ["memo", "memos"],
    ["成员管理", "member-management"],
    ["组织权限", "organization-structure"],
    ["组织架构", "organization-structure"],
    ["权限管理", "role-management"],
    ["角色管理", "role-management"],
    ["界面开通", "ui-access"],
    ["模块开通", "ui-access"],
    ["成员授权", "member-authorization"],
    ["权限审计", "permission-audit"],
    ["organization", "organization-structure"],
    ["设置", "settings"],
    ["account", "settings"]
  ];
  return candidates.find(([keyword]) => value.includes(keyword))?.[1] || null;
}

export async function restoreSession() {
  const rawUser = localStorage.getItem(storage.user);
  localStorage.removeItem("gj_token");
  if (!rawUser) return;
  let user: User;
  try {
    ({ user } = await api<{ user: User }>("/api/auth/me"));
  } catch {
    localStorage.removeItem(storage.user);
    return;
  }
  localStorage.setItem(storage.user, JSON.stringify(user));
  state.user = user;
  applyAuthedUser(user);
  document.body.classList.add("is-authenticated");
  try {
    await refreshAll(user);
  } catch (error) {
    toast(error instanceof Error ? `数据加载失败：${error.message}` : "数据加载失败，请稍后重试", "error");
  }
  activateNavView(state.iamCapabilities?.source === "platform" ? "platform-operations" : rememberedWorkspaceView(user));
}

