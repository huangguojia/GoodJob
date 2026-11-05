/**
 * toast、弹窗、确认框、按钮状态、api() 请求封装。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { state } from "../prototype-api";
import { cookieValue, escapeHtml, qs, storage } from "./shared";
import { ensureUiLayer } from "./agent";

export function toast(
  message: string,
  type: "ok" | "error" | "success" | "warn" | "info" = "ok"
) {
  ensureUiLayer();
  const stack = qs<HTMLElement>(".toast-stack")!;
  const item = document.createElement("div");
  const normalizedType = type === "ok" ? "success" : type === "warn" ? "warning" : type;
  const labels: Record<string, string> = { success: "已完成", error: "需要处理", warning: "请留意", info: "提示" };
  const icons: Record<string, string> = { success: "✓", error: "!", warning: "!", info: "i" };
  item.className = `toast toast-${normalizedType}`;
  item.setAttribute("role", normalizedType === "error" ? "alert" : "status");
  item.innerHTML = `<span class="toast-icon" aria-hidden="true">${icons[normalizedType] || "i"}</span><span class="toast-copy"><b>${labels[normalizedType] || "提示"}</b><span>${escapeHtml(message)}</span></span><button class="toast-dismiss" type="button" aria-label="关闭提示">×</button>`;
  item.querySelector<HTMLButtonElement>(".toast-dismiss")?.addEventListener("click", () => item.remove());
  stack.appendChild(item);
  window.setTimeout(() => { item.classList.add("is-leaving"); window.setTimeout(() => item.remove(), 180); }, normalizedType === "error" ? 5200 : 3400);
}

export interface ModalOptions {
  closeOnBackdrop?: boolean;
  /** 额外挂到 .modal 上的类名（用于加宽等单一变体）；openModal 每次会先清掉已知变体类 */
  modalClass?: string;
  /** 抬头副标题。默认那句「填写信息后保存」对选择器类弹窗是错的，这类必须自己给。 */
  description?: string;
}

export interface ConfirmActionOptions {
  title: string;
  message: string;
  consequences?: string[];
  detail?: string;
  detailLabel?: string;
  confirmLabel?: string;
  tone?: "danger" | "warning" | "normal";
  verificationText?: string;
}

export function setButtonPending(button: HTMLButtonElement | null, pending: boolean, idleLabel: string, pendingLabel: string) {
  if (!button) return;
  button.disabled = pending;
  button.classList.toggle("is-loading", pending);
  if (pending) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
  button.textContent = pending ? pendingLabel : idleLabel;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || "GET").toUpperCase();
  const csrfToken = cookieValue("gj_csrf");
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: "请求失败" }));
    if (response.status === 401 && path !== "/api/auth/login") {
      localStorage.removeItem(storage.user);
      state.user = null;
      document.body.classList.remove("is-authenticated");
    }
    throw new Error(body.message || "请求失败");
  }
  return response.json() as Promise<T>;
}
