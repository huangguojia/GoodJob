/**
 * 全局事件绑定（installEvents）。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { type IntegrationCenterController, mountIntegrationCenter } from "../integrations/integration-center";
import { closeModal, openModal, state } from "../prototype-api";
import { qs } from "./shared";
import { api, toast } from "./ui";
import { hasIamCapability } from "./auth";
import { MAIL_SECTION_ITEMS } from "./mail-center";

export let integrationCenterController: IntegrationCenterController | null = null;

export function installIntegrationCenterInteractions() {
  integrationCenterController = mountIntegrationCenter({
    request: api,
    toast,
    openModal,
    closeModal,
    hasPermission: hasIamCapability,
    permissionScopes: (permissionCode) => state.iamCapabilities?.permissions[permissionCode] || []
  });
}

/** 登录页默认账号（静默内嵌用）：默认管理员 */
const DEFAULT_LOGIN_EMAIL = "admin@goodjob.com";
const DEFAULT_LOGIN_PASSWORD = "goodjob123";

/**
 * 登录页默认账号静默内嵌：打开登录页时把默认管理员账号密码填进输入框。
 * 只在输入框为空时填充，不清空用户已输入内容；页面上不展示任何明文提示块。
 */
export function prefillLoginCredentials() {
  if (document.body.classList.contains("is-authenticated")) return;
  const emailInput = qs<HTMLInputElement>("#loginEmail");
  const passwordInput = qs<HTMLInputElement>("#loginPassword");
  if (!emailInput || !passwordInput) return;
  if (!emailInput.value.trim()) emailInput.value = DEFAULT_LOGIN_EMAIL;
  if (!passwordInput.value) passwordInput.value = DEFAULT_LOGIN_PASSWORD;
}

/** 邮件中心的子视图在「最近打开」里共用一个页签，别把一节拆成四个标签 */
export function workspaceTabKey(view: string) {
  if (view !== "mail-center" && MAIL_SECTION_ITEMS.some((item) => item.view === view)) return "mail-center";
  return view;
}
