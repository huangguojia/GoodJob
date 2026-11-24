/**
 * 登录、MFA。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, openModal, state, syncWorkspaceAccess } from "../prototype-api";
import { type User } from "./models";
import { refreshAll } from "./dashboard";
import { escapeHtml, qs, qsa, roleLabel, storage } from "./shared";
import { api, toast } from "./ui";
import { renderProfile } from "./profile";
import { recordLog } from "./logs";
import { applyTheme, getInitialTheme, rememberedWorkspaceView } from "./navigation";

export async function completeLogin(user: User) {
  localStorage.setItem(storage.user, JSON.stringify(user));
  state.user = user;
  applyAuthedUser(user);
  document.body.classList.add("is-authenticated");
  await refreshAll(user);
  activateNavView(state.iamCapabilities?.source === "platform" ? "platform-operations" : rememberedWorkspaceView(user));
  void recordLog({ level: "info", category: "auth", action: "login", message: `用户 ${user.name} 登录系统`, meta: { role: user.role } });
}

async function openMfaEnrollment(setupToken: string) {
  const enrollment = await api<{ secret: string; qrCode: string; recoveryCodes: string[] }>("/api/auth/mfa/enroll", {
    method: "POST",
    body: JSON.stringify({ setupToken })
  });
  openModal("启用运维双重验证", `
    <div class="form-grid">
      <div class="form-field full" style="text-align:center"><img src="${escapeHtml(enrollment.qrCode)}" alt="MFA 二维码" width="220" height="220"></div>
      <div class="form-field full"><label>手动密钥</label><input readonly value="${escapeHtml(enrollment.secret)}"></div>
      <div class="form-field full"><label>恢复码（仅展示一次）</label><textarea readonly rows="4">${escapeHtml(enrollment.recoveryCodes.join("  "))}</textarea></div>
      <div class="form-field full"><label>验证器中的 6 位验证码</label><input id="mfaEnrollmentCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>
    </div>`, `<button class="btn primary" id="confirmMfaEnrollment">确认启用</button>`);
  qs<HTMLInputElement>("#mfaEnrollmentCode")?.focus();
  qs("#confirmMfaEnrollment")?.addEventListener("click", () => void (async () => {
    const code = qs<HTMLInputElement>("#mfaEnrollmentCode")?.value.trim() || "";
    await api("/api/auth/mfa/confirm", { method: "POST", body: JSON.stringify({ setupToken, code }) });
    closeModal();
    toast("双重验证已启用，请重新登录", "success");
  })().catch((error) => toast(error instanceof Error ? error.message : "验证码确认失败", "error")));
}

function openMfaChallenge(email: string, challengeId: string) {
  openModal("运维安全验证", `
    <div class="form-grid"><div class="form-field full"><label>验证器验证码或恢复码</label><input id="mfaLoginCode" autocomplete="one-time-code" autofocus></div></div>`,
  `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="verifyMfaLogin">验证并登录</button>`);
  qs<HTMLInputElement>("#mfaLoginCode")?.focus();
  qs("#verifyMfaLogin")?.addEventListener("click", () => void (async () => {
    const code = qs<HTMLInputElement>("#mfaLoginCode")?.value.trim() || "";
    const verified = await api<{ user: User }>("/api/auth/mfa/verify", { method: "POST", body: JSON.stringify({ email, challengeId, code }) });
    closeModal();
    await completeLogin(verified.user);
  })().catch((error) => toast(error instanceof Error ? error.message : "安全验证失败", "error")));
}

type LoginResponse = {
  user?: User;
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
  setupToken?: string;
  challengeId?: string;
  email?: string;
};

async function applyLoginResponse(result: LoginResponse, fallbackEmail: string) {
  if (result.mfaSetupRequired && result.setupToken) { await openMfaEnrollment(result.setupToken); return; }
  if (result.mfaRequired && result.challengeId) { openMfaChallenge(result.email || fallbackEmail, result.challengeId); return; }
  if (!result.user) throw new Error("登录响应缺少用户信息");
  await completeLogin(result.user);
}

export async function loginWithPassword(email: string, password: string) {
  const result = await api<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  await applyLoginResponse(result, email);
}

/**
 * 本机一键登录：密码由服务端内置（personal / development 档位 + 本机回环才可用），
 * 浏览器只发一个空 POST，不接触明文密码。
 */
export async function loginWithLocalAdmin() {
  const result = await api<LoginResponse>("/api/auth/local-login", { method: "POST", body: JSON.stringify({}) });
  await applyLoginResponse(result, result.email || "");
}

/**
 * 登录页初始化：服务端说能用就显示「一键登录」；地址栏带 ?autologin=1 时直接进（单机版双击直达）。
 */
export async function initLocalOneClickLogin(options: { auto?: boolean } = {}) {
  const button = qs<HTMLButtonElement>("#localLoginButton");
  if (!button) return;
  let info: { enabled?: boolean; email?: string; autoLogin?: boolean } = {};
  try {
    info = await api<{ enabled?: boolean; email?: string; autoLogin?: boolean }>("/api/auth/local-login");
  } catch {
    return;
  }
  if (!info.enabled) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  const hint = qs<HTMLElement>("#localLoginHint");
  if (hint) hint.hidden = false;
  // 本机版把「一键登录」提到密码登录之上，并把密码登录降为备选（样式见 body.is-local-login）。
  const submit = qs<HTMLButtonElement>("#loginButton");
  const panel = button.parentElement;
  if (submit && panel && submit.parentElement === panel) {
    submit.textContent = "用密码登录";
    panel.insertBefore(button, submit);
    document.body.classList.add("is-local-login");
  }
  const emailInput = qs<HTMLInputElement>("#loginEmail");
  if (emailInput && !emailInput.value.trim() && info.email) emailInput.value = info.email;

  const idleLabel = button.textContent || "一键登录";
  button.onclick = () => {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "正在登录…";
    void loginWithLocalAdmin()
      .catch((error) => toast(error instanceof Error ? error.message : "一键登录失败", "error"))
      .finally(() => {
        button.disabled = false;
        button.textContent = idleLabel;
      });
  };

  const wantsAuto = options.auto !== false
    && (new URLSearchParams(window.location.search).get("autologin") === "1" || info.autoLogin === true);
  if (wantsAuto) {
    // 自动登录只跑一次：清掉地址栏参数，退出登录后停留在登录页而不是又被踢回工作台。
    window.history.replaceState(null, "", window.location.pathname);
    button.click();
  }
}

/** 从官方 WhatsApp 跳走时记住当前视图，返回后可落回原处。 */
const WHATSAPP_RETURN_KEY = "goodjob:whatsapp-return-view";
const WHATSAPP_RETURN_TTL_MS = 30 * 60 * 1000;

/**
 * 官方 WhatsApp 网页版入口。
 *
 * 同标签跳转，不开新窗口、不做 iframe：web.whatsapp.com 的 frame-ancestors 只允许
 * *.whatsapp.com，任何站点内嵌都会被浏览器直接拒绝。这里也不走反向代理、不引第三方
 * 协议库 —— 页面、凭据、消息全部留在 WhatsApp 官方站点与本机浏览器里。
 */
export function initOfficialWhatsAppEntry() {
  const link = qs<HTMLAnchorElement>("#loginWhatsApp");
  if (!link || link.dataset.wired === "1") return;
  link.dataset.wired = "1";
  const official = "https://web.whatsapp.com/";
  link.addEventListener("click", (event) => {
    // href 被改动就交回浏览器默认行为，避免把使用者带去非官方地址。
    if (link.getAttribute("href") !== official) return;
    event.preventDefault();
    try {
      const view = document.querySelector<HTMLElement>(".view.active")?.id || "dashboard";
      sessionStorage.setItem(WHATSAPP_RETURN_KEY, JSON.stringify({ view, at: Date.now() }));
    } catch {
      // 隐私模式等场景写不了 sessionStorage：不影响跳转，只是返回时不定位原视图。
    }
    window.location.assign(official);
  });
}

/**
 * 从外站（官方 WhatsApp）回到 CRM 时恢复跳走前的视图。
 * 只认 30 分钟内的记录，且目标视图必须真实存在，避免旧记录把人带错地方。
 */
export function restoreViewAfterExternalJump(): boolean {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(WHATSAPP_RETURN_KEY);
    if (raw) sessionStorage.removeItem(WHATSAPP_RETURN_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { view?: string; at?: number };
    if (!parsed?.view || typeof parsed.at !== "number") return false;
    if (Date.now() - parsed.at > WHATSAPP_RETURN_TTL_MS) return false;
    if (!document.getElementById(parsed.view)) return false;
    activateNavView(parsed.view);
    return true;
  } catch {
    return false;
  }
}

export function applyAuthedUser(user: User) {
  const profileName = `${user.name} / ${roleLabel[user.role]}`;
  document.body.dataset.role = user.role;
  syncWorkspaceAccess(user);
  qs("#scopeUser")!.textContent = profileName;
  qs("#scopeText")!.textContent = roleScopeText(user);
  qs("#currentAvatar")!.textContent = user.avatar;
  const topUserName = qs<HTMLElement>("#topUserName");
  const topUserRole = qs<HTMLElement>("#topUserRole");
  if (topUserName) topUserName.textContent = user.name;
  if (topUserRole) topUserRole.textContent = user.iamRoleNames?.join(" / ") || roleLabel[user.role];
  syncTrainingManagementUi(user);
  renderProfile(user);
  applyTheme(getInitialTheme());
}

function canManageTrainingUi(user = state.user) {
  return Boolean(user && hasIamCapability("training.manage"));
}

export const accessControlViews = [
  "member-management",
  "organization-structure",
  "role-management",
  "ui-access",
  "member-authorization",
  "permission-audit"
] as const;

export function isAccessControlView(view: string): view is typeof accessControlViews[number] {
  return (accessControlViews as readonly string[]).includes(view);
}

export function isSystemAdministrator(user = state.user) {
  return Boolean(user && (user.role === "admin" || user.role === "super_admin"));
}

export const viewPermissionRequirements: Record<string, string> = {
  dashboard: "workspace.dashboard.read",
  "lead-finder": "prospect.read",
  "prospect-list": "prospect.read",
  "ai-agent": "agent.use",
  "agent-skills": "agent.use",
  "sales-skill-center": "agent.use",
  "maintenance-center": "customer.read",
  "outreach-batches": "prospect.read",
  "outreach-journey": "prospect.read",
  "integration-center": "integration.read",
  exchange: "integration.read",
  "lead-ads": "lead.read",
  leads: "lead.read",
  customers: "customer.read",
  suppliers: "supplier.read",
  "packaging-plans": "packaging.read",
  "customer-pool": "customer.pool.claim",
  whatsapp: "communication.read",
  wecom: "communication.read",
  pipeline: "deal.read",
  documents: "document.read",
  "file-center": "training.read",
  commission: "commission.read",
  reports: "report.read",
  leaderboard: "report.read",
  "daily-reports": "daily_report.read",
  "approval-center": "approval.read",
  "approval-workflows": "approval.workflow.manage",
  inbox: "message.read",
  knowledge: "training.read",
  "mail-center": "communication.read",
  "kb-training": "training.read",
  exam: "training.read",
  "question-bank": "training.manage",
  "sales-distillation": "training.read",
  products: "product.read",
  shipments: "shipment.read",
  orders: "order.read",
  "order-detail": "order.read",
  "member-management": "member.read",
  "organization-structure": "org.read",
  "role-management": "role.read",
  "ui-access": "role.read",
  "member-authorization": "permission.assign",
  "permission-audit": "audit.read",
  settings: "system.settings.manage",
  "database-maintenance": "database.maintain",
  "platform-operations": "platform.dashboard.read"
};

export function hasIamCapability(permissionCode: string) {
  return Boolean(state.iamCapabilities?.permissions[permissionCode]?.length);
}

export function isPlatformOperator(user = state.user) {
  return Boolean(user && (user.role === "super_admin" || state.iamCapabilities?.source === "platform" || user.iamSource === "platform"));
}

export function canAccessWorkspaceView(view: string, user = state.user) {
  if (!user) return false;
  if (isPlatformOperator(user)) {
    return view === "platform-operations"
      && (!state.iamCapabilities || hasIamCapability("platform.dashboard.read"));
  }
  if (isAccessControlView(view) && !isSystemAdministrator(user)) return false;
  const requiredPermission = viewPermissionRequirements[view];
  if (requiredPermission && state.iamCapabilities) return hasIamCapability(requiredPermission);
  if (view === "database-maintenance") return hasIamCapability("database.maintain");
  if (isAccessControlView(view)) return hasIamCapability(view === "member-management" ? "member.read" : view === "organization-structure" ? "org.read" : view === "role-management" || view === "ui-access" ? "role.read" : view === "member-authorization" ? "permission.assign" : "audit.read");
  return true;
}

function syncTrainingManagementUi(user = state.user) {
  const canManage = canManageTrainingUi(user);
  qsa<HTMLElement>("#exam .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("发布考试") || button.textContent?.includes("题库维护") || button.textContent?.includes("分类目考试维护")) {
      button.classList.toggle("is-hidden", !canManage);
    }
  });
}

export function roleScopeText(user: User) {
  const permissions = state.iamCapabilities?.permissions || user.iamPermissions || {};
  if (state.iamCapabilities?.source === "platform" || user.iamSource === "platform") return "平台运维权限，禁止直接访问公司业务数据";
  const scopes = Object.values(permissions).flat();
  if (scopes.includes("tenant")) return "当前公司范围，具体模块按角色授权";
  if (scopes.includes("org_subtree")) return "本人及授权组织下属成员数据";
  if (scopes.includes("org_unit")) return "本人及授权组织成员数据";
  if (scopes.includes("self")) return "仅本人业务与本人待办";
  return "当前账号尚未获得业务数据范围";
}

export function updateProfileSmtpHints(user = state.user) {
  const passwordInput = qs<HTMLInputElement>("#profileSmtpPassword");
  const passwordHint = qs<HTMLElement>("#profileSmtpPasswordHint");
  const configHint = qs<HTMLElement>("#profileSmtpConfigHint");
  const port = Number(qs<HTMLInputElement>("#profileSmtpPort")?.value || user?.smtpPort || 465);
  const secure = qs<HTMLSelectElement>("#profileSmtpSecure")?.value !== "false";
  if (passwordInput) {
    passwordInput.placeholder = user?.hasSmtpPassword ? "已保存授权码；输入新授权码可覆盖" : "输入授权码后保存";
  }
  if (passwordHint) {
    passwordHint.className = user?.hasSmtpPassword ? "ok" : "";
    passwordHint.textContent = user?.hasSmtpPassword ? "授权码已保存到数据库，出于安全不会明文回显；留空保存会保留原授权码。" : "授权码保存后不会明文回显；QQ/企业邮箱通常需要专用授权码，不是网页登录密码。";
  }
  if (configHint) {
    if (port === 587 && secure) {
      configHint.className = "warn";
      configHint.textContent = "当前是 587 + SSL/TLS，通常会连接失败；请改为 STARTTLS/普通，或把端口改成 465。";
    } else if (port === 465 && !secure) {
      configHint.className = "warn";
      configHint.textContent = "当前是 465 + STARTTLS/普通，通常会连接失败；请改为 SSL/TLS，或把端口改成 587。";
    } else {
      configHint.className = "ok";
      configHint.textContent = port === 587 ? "587 建议使用 STARTTLS/普通；配置组合看起来正常。" : port === 465 ? "465 建议使用 SSL/TLS；配置组合看起来正常。" : "非标准端口，请确认服务商要求的加密方式。";
    }
  }
}
