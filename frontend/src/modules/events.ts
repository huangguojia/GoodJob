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

/**
 * 登录页不再预填任何账号密码（2026-11-19 用户明确要求）。
 *
 * 历史实现会把内置管理员 admin@goodjob.com 静默填进输入框，公网部署后等于把
 * 一个真实超管账号名暴露给所有访客，且用户每次都要手动清空。现在保留函数名
 * 仅为兼容既有调用点，落点必须始终是空输入框。
 */
export function prefillLoginCredentials() {
  if (document.body.classList.contains("is-authenticated")) return;
  const emailInput = qs<HTMLInputElement>("#loginEmail");
  const passwordInput = qs<HTMLInputElement>("#loginPassword");
  if (!emailInput || !passwordInput) return;
  // 只清理「上一版静默内嵌」可能残留的值，绝不写入默认账号
  if (emailInput.value === "admin@goodjob.com") emailInput.value = "";
  if (emailInput.value === "" && passwordInput.value === "goodjob123") passwordInput.value = "";
}

/** 邮件中心的子视图在「最近打开」里共用一个页签，别把一节拆成四个标签 */
export function workspaceTabKey(view: string) {
  if (view !== "mail-center" && MAIL_SECTION_ITEMS.some((item) => item.view === view)) return "mail-center";
  // 任务归档是自动流下的子页面：共用「自动流获客」一个页签
  if (view === "auto-flow-history") return "auto-flow";
  return view;
}
