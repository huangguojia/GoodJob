/**
 * WhatsApp 会话工作台。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, openModal, state } from "../prototype-api";
import { type WhatsAppBinding, type WhatsAppMessage, type WhatsAppModes, type WhatsAppThread } from "./models";
import { customerContactDetails, normalizeWhatsAppPhone } from "./customers";
import { escapeHtml, qs, qsa } from "./shared";
import { renderCustomerDetailPage } from "./customer-detail";
import { api, toast } from "./ui";

let whatsappRefreshTimer = 0;
let whatsappRefreshing = false;

// ===================== WhatsApp 会话工作台 =====================
type WhatsAppCustomerSummary = { id: string; company: string; country: string; contact: string };
type WhatsAppBindingMode = "manual" | "twilio-api" | "web-scan";

function waInitials(name: string) {
  const value = (name || "?").trim();
  return value ? value.slice(0, 2).toUpperCase() : "?";
}

function waFormatTime(iso: string, compact = false) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (compact && sameDay) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toLocaleString("zh-CN", compact
    ? { month: "2-digit", day: "2-digit" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

// 客户号码 → WhatsApp 网页版直链。
// 刻意不用 wa.me / api.whatsapp.com —— 那两者是 universal 链接，设备上装了 WhatsApp
// 桌面客户端就会被唤起 App，落到另一个关联设备，而不是使用者已扫码登录的浏览器会话。
export function whatsAppWebLink(phone: string, text = "") {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (digits.length < 6) return "";
  // text 参数让 WhatsApp 打开会话时直接预填消息草稿（官方 send?phone&text= 用法）
  return text ? `https://web.whatsapp.com/send?phone=${digits}&text=${encodeURIComponent(text)}` : `https://web.whatsapp.com/send?phone=${digits}`;
}

// WhatsApp 入口统一可用性判定。判定源就是 openWhatsAppForContact() 用的那两个函数，
// 所以「灰」精确等于「点了必然打不开」——不会出现按钮亮着、点下去才弹错的落差。
export function whatsAppEntryHref(phone: string) {
  return whatsAppWebLink(normalizeWhatsAppPhone(phone));
}

export function whatsAppEntryClass(phone: string, base = "btn") {
  return `${base} wa-action ${whatsAppEntryHref(phone) ? "is-ready" : "is-empty"}`;
}

export function whatsAppEntryAttrs(phone: string, emptyTip = "该客户未维护 WhatsApp 号码，补齐国家码手机号后即可直接打开") {
  return whatsAppEntryHref(phone)
    ? `title="在网页版 WhatsApp 打开该客户会话"`
    : `disabled aria-disabled="true" title="${emptyTip}"`;
}

function waStatusLabel(status: string) {
  return status === "read" ? "已读"
    : status === "delivered" ? "已送达"
      : status === "failed" ? "发送失败"
        : status === "recorded" ? "已记录"
          : status === "sent" ? "已发送" : status;
}

function updateWhatsAppStatus() {
  const unread = state.whatsappThreads.reduce((sum, item) => sum + Number(item.unreadCount || 0), 0);
  const navUnread = qs<HTMLElement>("#waNavUnread");
  if (navUnread) {
    navUnread.hidden = unread === 0;
    navUnread.textContent = unread > 99 ? "99+" : String(unread);
  }
  const status = qs<HTMLElement>("#waChannelStatus");
  if (!status) return;
  const officialReady = Boolean(state.whatsappModes?.twilioApi.available);
  status.classList.toggle("is-ready", officialReady);
  const label = qs<HTMLElement>("span", status);
  if (label) label.textContent = officialReady ? "官方通道已连接" : "人工同步";
}

export function renderWhatsAppThreads() {
  const list = qs<HTMLElement>("#waThreadList");
  if (!list) return;
  const keyword = state.waThreadSearch.trim().toLowerCase();
  const threads = state.whatsappThreads.filter((item) => {
    const haystack = [item.company, item.country, item.contact, item.phoneNumber, item.lastMessage].join(" ").toLowerCase();
    return !keyword || haystack.includes(keyword);
  });
  if (!threads.length) {
    list.innerHTML = `<div class="wa-empty"><b>${state.whatsappThreads.length ? "没有匹配会话" : "暂无会话"}</b><span>${state.whatsappThreads.length ? "" : "点击新会话选择客户"}</span></div>`;
    updateWhatsAppStatus();
    return;
  }
  list.innerHTML = threads.map((item) => `
    <button class="wa-thread ${item.customerId === state.selectedWaCustomerId ? "active" : ""}" data-wa-customer="${escapeHtml(item.customerId)}" type="button">
      <span class="wa-avatar">${escapeHtml(waInitials(item.company))}</span>
      <span class="wa-thread-main">
        <span class="wa-thread-line"><b>${escapeHtml(item.company)}</b><time>${escapeHtml(waFormatTime(item.lastMessageAt, true))}</time></span>
        <span>${escapeHtml(item.lastMessage || item.phoneNumber || item.contact || "暂无消息")}</span>
      </span>
      ${item.unreadCount ? `<span class="wa-unread">${Math.min(item.unreadCount, 99)}</span>` : ""}
    </button>`).join("");
  qsa<HTMLButtonElement>("[data-wa-customer]", list).forEach((button) => {
    button.addEventListener("click", () => void openWhatsAppThread(button.dataset.waCustomer || ""));
  });
  updateWhatsAppStatus();
}

export function openWhatsAppCustomerPicker() {
  const renderList = (keyword = "") => {
    const list = qs<HTMLElement>("#waCustomerPickerList");
    if (!list) return;
    const query = keyword.trim().toLowerCase();
    const customers = state.customers.filter((customer) =>
      !query || [customer.company, customer.contact, customer.country].join(" ").toLowerCase().includes(query)
    );
    list.innerHTML = customers.length ? customers.map((customer) => `
      <button class="customer-picker-row" type="button" data-wa-pick-customer="${escapeHtml(customer.id)}">
        <span class="wa-avatar">${escapeHtml(waInitials(customer.company))}</span>
        <span><b>${escapeHtml(customer.company)}</b><small>${escapeHtml([customer.contact, customer.country].filter(Boolean).join(" · ") || "客户资料")}</small></span>
      </button>`).join("") : `<div class="empty-cell">没有匹配客户</div>`;
    qsa<HTMLButtonElement>("[data-wa-pick-customer]", list).forEach((button) => {
      button.addEventListener("click", () => {
        const customerId = button.dataset.waPickCustomer || "";
        closeModal();
        void openWhatsAppThread(customerId);
      });
    });
  };
  openModal("新建 WhatsApp 会话", `
    <div class="form-field"><label>客户</label><input id="waCustomerPickerSearch" placeholder="搜索客户或联系人"></div>
    <div class="customer-picker-list" id="waCustomerPickerList"></div>
  `, `<button class="btn" data-modal-close>关闭</button>`);
  renderList();
  qs<HTMLInputElement>("#waCustomerPickerSearch")?.addEventListener("input", (event) => renderList((event.currentTarget as HTMLInputElement).value));
}

async function openWhatsAppThread(customerId: string, quiet = false) {
  if (!customerId) return;
  state.selectedWaCustomerId = customerId;
  renderWhatsAppThreads();
  const layout = qs<HTMLElement>("#whatsapp .wa-layout");
  layout?.classList.add("wa-mobile-chat-open");
  qs<HTMLElement>("#waInfoCol")?.classList.remove("is-open");
  const chat = qs<HTMLElement>("#waChatCol");
  if (chat && !quiet) chat.innerHTML = `<div class="wa-empty"><b>正在读取会话</b></div>`;
  try {
    const data = await api<{ binding: WhatsAppBinding | null; messages: WhatsAppMessage[]; canManage: boolean; customer: WhatsAppCustomerSummary }>(`/api/whatsapp/customers/${encodeURIComponent(customerId)}/messages`);
    state.whatsappMessages = data.messages;
    state.whatsappBinding = data.binding;
    renderWhatsAppChat(data.customer, data.binding, data.messages, data.canManage);
    renderWhatsAppInfo(data.customer, data.binding, data.canManage);
    const thread = state.whatsappThreads.find((item) => item.customerId === customerId);
    if (thread?.unreadCount) {
      thread.unreadCount = 0;
      renderWhatsAppThreads();
      void api(`/api/whatsapp/customers/${encodeURIComponent(customerId)}/read`, { method: "POST" }).catch(() => null);
    }
  } catch (error) {
    if (chat) chat.innerHTML = `<div class="wa-empty"><b>会话读取失败</b><span>${escapeHtml(error instanceof Error ? error.message : "请稍后重试")}</span></div>`;
  }
}

function renderWhatsAppChat(customer: WhatsAppCustomerSummary, binding: WhatsAppBinding | null, messages: WhatsAppMessage[], canManage: boolean) {
  const chat = qs<HTMLElement>("#waChatCol");
  if (!chat) return;
  const bubbles = messages.map((message) => {
    const isChinese = /[一-鿿]/.test(message.content);
    const translated = message.contentTranslated
      ? `<span class="wa-translated">${escapeHtml(message.contentTranslated)}</span>`
      : (!isChinese && message.direction === "inbound" ? `<button class="wa-translate-btn" data-wa-translate="${escapeHtml(message.id)}" type="button">翻译</button>` : "");
    return `<div class="wa-msg ${message.direction === "inbound" ? "in" : "out"} ${message.status === "failed" ? "is-failed" : ""}" data-wa-msg="${escapeHtml(message.id)}">
      ${escapeHtml(message.content)}${translated}
      <span class="wa-time">${escapeHtml(waFormatTime(message.createdAt))}${message.direction === "outbound" ? ` · ${escapeHtml(waStatusLabel(message.status))}` : ""}</span>
    </div>`;
  }).join("");
  const mode = binding?.bindingMode || "manual";
  const integrated = mode !== "manual";
  const connected = mode === "twilio-api" || (mode === "web-scan" && binding?.connectionStatus === "connected");
  const canCompose = canManage && Boolean(binding) && (!integrated || connected);
  const customerRecord = state.customers.find((item) => item.id === customer.id);
  const masterWhatsapp = customerRecord ? customerContactDetails(customerRecord).whatsapp : "";
  const link = whatsAppWebLink(binding?.phoneNumber || masterWhatsapp);
  chat.innerHTML = `
    <div class="wa-chat-head">
      <button class="wa-icon-button wa-mobile-back" id="waMobileBackButton" type="button" title="返回会话" aria-label="返回会话"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
      <span class="wa-avatar">${escapeHtml(waInitials(customer.company))}</span>
      <span class="wa-chat-title"><b>${escapeHtml(customer.company)}</b><span>${escapeHtml(binding?.phoneNumber || masterWhatsapp || "未绑定号码")}</span></span>
      <span class="wa-chat-actions">
        ${link ? `<a class="wa-icon-button wa-open-link" href="${link}" target="_blank" rel="noopener" title="在 WhatsApp 打开" aria-label="在 WhatsApp 打开"><svg viewBox="0 0 24 24"><path d="M14 5h5v5"/><path d="m10 14 9-9"/><path d="M19 13v6H5V5h6"/></svg></a>` : ""}
        <button class="wa-icon-button wa-mobile-info" id="waMobileInfoButton" type="button" title="客户与通道" aria-label="客户与通道"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg></button>
      </span>
    </div>
    <div class="wa-messages" id="waMessages">${bubbles || `<div class="wa-empty"><b>暂无消息</b></div>`}</div>
    <div class="wa-compose">
      <select id="waDirection" ${integrated ? "disabled" : ""}>${integrated ? `<option value="outbound">发送消息</option>` : `<option value="inbound">收到消息</option><option value="outbound">发送消息</option>`}</select>
      <textarea id="waContentInput" placeholder="${!canManage ? "仅客户负责人可发送" : binding ? (canCompose ? "输入消息" : "通道未连接") : "先完成号码绑定"}" ${canCompose ? "" : "disabled"}></textarea>
      <button class="btn" id="waSendButton" type="button" ${canCompose ? "" : "disabled"}>${integrated ? "发送" : "记录"}</button>
    </div>`;
  const messageBox = qs<HTMLElement>("#waMessages", chat);
  if (messageBox) messageBox.scrollTop = messageBox.scrollHeight;
  qsa<HTMLButtonElement>("[data-wa-translate]", chat).forEach((button) => {
    button.addEventListener("click", () => void translateWhatsAppMessage(button.dataset.waTranslate || "", customer.id));
  });
  qs<HTMLButtonElement>("#waSendButton", chat)?.addEventListener("click", () => void addWhatsAppMessage(customer.id));
  qs<HTMLTextAreaElement>("#waContentInput", chat)?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void addWhatsAppMessage(customer.id);
    }
  });
  qs<HTMLButtonElement>("#waMobileBackButton", chat)?.addEventListener("click", () => layoutForWhatsApp()?.classList.remove("wa-mobile-chat-open"));
  qs<HTMLButtonElement>("#waMobileInfoButton", chat)?.addEventListener("click", () => qs<HTMLElement>("#waInfoCol")?.classList.add("is-open"));
}

function layoutForWhatsApp() {
  return qs<HTMLElement>("#whatsapp .wa-layout");
}

function renderWhatsAppInfo(customer: WhatsAppCustomerSummary, binding: WhatsAppBinding | null, canManage: boolean) {
  const info = qs<HTMLElement>("#waInfoCol");
  if (!info) return;
  const mode = binding?.bindingMode || "manual";
  const contact = state.customers.find((item) => item.id === customer.id);
  const details = contact ? customerContactDetails(contact) : { email: "", phone: "", whatsapp: "", wechat: "" };
  const modes = state.whatsappModes;
  const modeOptions: Array<{ id: WhatsAppBindingMode; label: string; available: boolean }> = [
    { id: "manual", label: "人工", available: true },
    { id: "twilio-api", label: "官方 API", available: Boolean(modes?.twilioApi.available) || mode === "twilio-api" },
    { id: "web-scan", label: "测试扫码", available: Boolean(modes?.webScan.available) || mode === "web-scan" }
  ];
  const link = whatsAppWebLink(binding?.phoneNumber || details.whatsapp || "");
  info.innerHTML = `
    <div class="wa-info-head">
      <div><h3>${escapeHtml(customer.company)}</h3><p class="wa-info-sub">${escapeHtml([customer.contact, customer.country].filter(Boolean).join(" · ") || "客户资料")}</p></div>
      <button class="wa-icon-button wa-info-close" id="waInfoCloseButton" type="button" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="wa-contact-facts">
      <div class="info"><span>客户号码</span><b>${escapeHtml(binding?.phoneNumber || details.whatsapp || "未绑定")}</b></div>
      <div class="info"><span>联系人</span><b>${escapeHtml(customer.contact || binding?.waProfileName || "未填写")}</b></div>
    </div>
    <div class="wa-channel-panel">
      <label>通道</label>
      <div class="wa-mode-switch">${modeOptions.map((item) => `<button type="button" data-wa-mode="${item.id}" class="${item.id === mode ? "active" : ""}" ${item.available && canManage ? "" : "disabled"}>${item.label}</button>`).join("")}</div>
      <div class="wa-binding-content" id="waBindingModeContent">${renderBindingModeContent(mode, binding, details.whatsapp, canManage)}</div>
    </div>
    <div class="wa-info-footer">
      ${link ? `<a class="btn wa-open-link" href="${link}" target="_blank" rel="noopener">在 WhatsApp 打开</a>` : ""}
      <button class="btn" id="waOpenCustomerButton" type="button">客户全景</button>
    </div>`;
  setupBindingModeListeners(customer.id, binding, details.whatsapp, canManage);
  qs<HTMLButtonElement>("#waInfoCloseButton", info)?.addEventListener("click", () => info.classList.remove("is-open"));
  qs<HTMLButtonElement>("#waOpenCustomerButton", info)?.addEventListener("click", () => {
    if (!contact) return;
    state.selectedCustomerId = contact.id;
    renderCustomerDetailPage(contact);
    activateNavView("customer-detail");
  });
}

function renderBindingModeContent(mode: WhatsAppBindingMode, binding: WhatsAppBinding | null, fallbackPhone = "", canManage = true) {
  const disabled = canManage ? "" : "disabled";
  if (mode === "manual") {
    return `
      <div class="wa-binding-state"><i></i><span>${canManage ? "人工同步" : "仅查看"}</span></div>
      <div class="wa-bind-box">
        <input id="waBindPhone" placeholder="客户 WhatsApp 号码" value="${escapeHtml(binding?.phoneNumber || fallbackPhone)}" ${disabled}>
        <input id="waBindName" placeholder="WhatsApp 昵称" value="${escapeHtml(binding?.waProfileName || "")}" ${disabled}>
        <button class="btn" id="waBindButton" type="button" ${disabled}>保存绑定</button>
      </div>`;
  }
  if (mode === "twilio-api") {
    const available = Boolean(state.whatsappModes?.twilioApi.available);
    return `
      <div class="wa-binding-state ${binding?.connectionStatus === "connected" ? "is-connected" : ""}"><i></i><span>${binding?.connectionStatus === "connected" ? "官方通道已连接" : (available ? "官方通道可配置" : "管理员未配置官方通道")}</span></div>
      <div class="wa-bind-box">
        <input id="waOfficialCustomerPhone" placeholder="客户 WhatsApp 号码" value="${escapeHtml(binding?.phoneNumber || fallbackPhone)}" ${disabled}>
        <input id="waTwilioPhone" placeholder="企业 WhatsApp 发信号码" value="${escapeHtml(binding?.twilioPhoneNumber || "")}" ${disabled}>
        <button class="btn primary" id="waTwilioBindButton" type="button" ${available && canManage ? "" : "disabled"}>连接官方通道</button>
      </div>
      <div class="wa-safety wa-official-note">首次主动联系须使用已审核模板，客户回复后的会话窗口内可发送自由文本。</div>`;
  }
  const connected = binding?.connectionStatus === "connected";
  const pending = binding?.connectionStatus === "qr-pending";
  return `
    <div class="wa-binding-state ${connected ? "is-connected" : ""}"><i></i><span>${connected ? "测试设备已连接" : pending ? "等待扫码" : "测试通道未连接"}</span></div>
    ${connected
      ? `<div class="wa-bind-box"><input id="waWebCustomerPhone" placeholder="客户 WhatsApp 号码" value="${escapeHtml(binding?.phoneNumber || fallbackPhone)}" ${disabled}><button class="btn" id="waDisconnectButton" type="button" ${disabled}>断开测试设备</button></div>`
      : pending
        ? `<div class="wa-qr" id="waQrCodeContainer"><span>正在生成二维码</span></div>`
        : `<div class="wa-bind-box"><input id="waWebCustomerPhone" placeholder="客户 WhatsApp 号码" value="${escapeHtml(binding?.phoneNumber || fallbackPhone)}" ${disabled}><button class="btn" id="waStartScanButton" type="button" ${disabled}>启动测试扫码</button></div>`}
    <div class="wa-safety">非官方协议仅限隔离测试账号，生产环境不可启用。</div>`;
}

function setupBindingModeListeners(customerId: string, binding: WhatsAppBinding | null, fallbackPhone = "", canManage = true) {
  const content = qs<HTMLElement>("#waBindingModeContent");
  qsa<HTMLButtonElement>("[data-wa-mode]", qs<HTMLElement>("#waInfoCol") || document).forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.waMode as WhatsAppBindingMode;
      qsa<HTMLButtonElement>("[data-wa-mode]").forEach((item) => item.classList.toggle("active", item === button));
      if (content) content.innerHTML = renderBindingModeContent(mode, binding, fallbackPhone, canManage);
      setupBindingActions(customerId, mode);
    });
  });
  if (!canManage) return;
  setupBindingActions(customerId, binding?.bindingMode || "manual");
}

function setupBindingActions(customerId: string, mode: WhatsAppBindingMode) {
  if (mode === "manual") {
    qs<HTMLButtonElement>("#waBindButton")?.addEventListener("click", () => void bindWhatsAppManual(customerId));
  } else if (mode === "twilio-api") {
    qs<HTMLButtonElement>("#waTwilioBindButton")?.addEventListener("click", () => void bindWhatsAppTwilio(customerId));
  } else {
    qs<HTMLButtonElement>("#waStartScanButton")?.addEventListener("click", () => void startWebScanBinding(customerId));
    qs<HTMLButtonElement>("#waDisconnectButton")?.addEventListener("click", () => void disconnectWebScan(customerId));
  }
}

async function bindWhatsAppManual(customerId: string) {
  const phoneNumber = qs<HTMLInputElement>("#waBindPhone")?.value.trim() || "";
  const waProfileName = qs<HTMLInputElement>("#waBindName")?.value.trim() || "";
  if (phoneNumber.length < 5) { toast("请输入有效的客户号码", "error"); return; }
  try {
    await api(`/api/whatsapp/customers/${encodeURIComponent(customerId)}/binding`, { method: "POST", body: JSON.stringify({ phoneNumber, waProfileName }) });
    await reloadWhatsAppThreads(true);
    await openWhatsAppThread(customerId);
    toast("WhatsApp 号码已绑定");
  } catch (error) {
    toast(error instanceof Error ? error.message : "绑定失败", "error");
  }
}

async function bindWhatsAppTwilio(customerId: string) {
  const phoneNumber = qs<HTMLInputElement>("#waOfficialCustomerPhone")?.value.trim() || "";
  const twilioPhoneNumber = qs<HTMLInputElement>("#waTwilioPhone")?.value.trim() || "";
  if (phoneNumber.length < 5 || twilioPhoneNumber.length < 5) { toast("请填写客户号码和企业发信号码", "error"); return; }
  try {
    await api("/api/whatsapp/binding/twilio/start", { method: "POST", body: JSON.stringify({ customerId, phoneNumber, twilioPhoneNumber }) });
    await reloadWhatsAppThreads(true);
    await openWhatsAppThread(customerId);
    toast("官方通道已连接");
  } catch (error) {
    toast(error instanceof Error ? error.message : "官方通道连接失败", "error");
  }
}

async function startWebScanBinding(customerId: string) {
  const phoneNumber = qs<HTMLInputElement>("#waWebCustomerPhone")?.value.trim() || "";
  if (phoneNumber.length < 5) { toast("请输入客户 WhatsApp 号码", "error"); return; }
  try {
    await api(`/api/whatsapp/customers/${encodeURIComponent(customerId)}/binding`, { method: "POST", body: JSON.stringify({ phoneNumber, waProfileName: "" }) });
    const result = await api<{ clientId: string }>("/api/whatsapp/binding/web-scan/start", { method: "POST", body: JSON.stringify({ customerId }) });
    await openWhatsAppThread(customerId);
    void pollQrCode(result.clientId, customerId);
  } catch (error) {
    toast(error instanceof Error ? error.message : "测试扫码启动失败", "error");
  }
}

async function pollQrCode(clientId: string, customerId: string) {
  const container = qs<HTMLElement>("#waQrCodeContainer");
  if (!container) return;
  const eventSource = new EventSource(`/api/whatsapp/binding/web-scan/qr/${encodeURIComponent(clientId)}`);
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data) as { qrDataUrl?: string; timeout?: boolean };
    if (data.qrDataUrl) container.innerHTML = `<img src="${escapeHtml(data.qrDataUrl)}" width="220" height="220" alt="WhatsApp 扫码二维码">`;
    if (data.timeout) {
      eventSource.close();
      container.innerHTML = `<span>二维码已过期</span>`;
    }
  };
  eventSource.onerror = () => {
    eventSource.close();
    if (!container.querySelector("img")) container.innerHTML = `<span>二维码读取失败</span>`;
  };
  let checks = 0;
  const timer = window.setInterval(async () => {
    checks += 1;
    try {
      const result = await api<{ status: string }>(`/api/whatsapp/binding/web-scan/status/${encodeURIComponent(clientId)}`);
      if (result.status === "connected") {
        window.clearInterval(timer);
        eventSource.close();
        await reloadWhatsAppThreads(true);
        await openWhatsAppThread(customerId);
        toast("测试设备已连接");
      } else if (result.status === "error" || checks >= 30) {
        window.clearInterval(timer);
      }
    } catch {
      window.clearInterval(timer);
    }
  }, 2000);
}

async function disconnectWebScan(customerId: string) {
  try {
    await api("/api/whatsapp/binding/web-scan/disconnect", { method: "POST", body: JSON.stringify({ customerId }) });
    await reloadWhatsAppThreads(true);
    await openWhatsAppThread(customerId);
    toast("测试设备已断开");
  } catch (error) {
    toast(error instanceof Error ? error.message : "断开失败", "error");
  }
}

async function reloadWhatsAppModes() {
  try {
    const data = await api<{ modes: WhatsAppModes }>("/api/whatsapp/binding-modes");
    state.whatsappModes = data.modes;
    updateWhatsAppStatus();
  } catch {
    state.whatsappModes = null;
    updateWhatsAppStatus();
  }
}

async function reloadWhatsAppThreads(quiet = false) {
  try {
    const data = await api<{ threads: WhatsAppThread[] }>("/api/whatsapp/threads");
    state.whatsappThreads = data.threads;
    renderWhatsAppThreads();
  } catch (error) {
    if (!quiet) toast(error instanceof Error ? error.message : "WhatsApp 会话加载失败", "error");
  }
}

export async function refreshWhatsAppWorkspace() {
  if (whatsappRefreshing) return;
  whatsappRefreshing = true;
  try {
    await Promise.all([reloadWhatsAppThreads(true), reloadWhatsAppModes()]);
    if (state.selectedWaCustomerId) await openWhatsAppThread(state.selectedWaCustomerId, true);
  } finally {
    whatsappRefreshing = false;
  }
}

export function syncWhatsAppRefresh(active: boolean) {
  window.clearInterval(whatsappRefreshTimer);
  whatsappRefreshTimer = 0;
  if (!active) return;
  whatsappRefreshTimer = window.setInterval(() => void refreshWhatsAppWorkspace(), 12000);
}

async function addWhatsAppMessage(customerId: string) {
  const direction = (qs<HTMLSelectElement>("#waDirection")?.value || "outbound") as "inbound" | "outbound";
  const input = qs<HTMLTextAreaElement>("#waContentInput");
  const content = input?.value.trim() || "";
  if (!content) { toast("请输入消息内容", "error"); return; }
  const button = qs<HTMLButtonElement>("#waSendButton");
  if (button) button.disabled = true;
  try {
    const result = await api<{ delivery: { mode: WhatsAppBindingMode; delivered: boolean } }>(`/api/whatsapp/customers/${encodeURIComponent(customerId)}/messages`, { method: "POST", body: JSON.stringify({ direction, content }) });
    if (input) input.value = "";
    await reloadWhatsAppThreads(true);
    await openWhatsAppThread(customerId, true);
    if (direction === "outbound" && result.delivery.mode !== "manual") {
      toast(result.delivery.delivered ? "消息已发送" : "消息发送失败，已保留失败记录", result.delivery.delivered ? "ok" : "error");
    } else {
      toast("消息已记录");
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : "消息处理失败", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function translateWhatsAppMessage(messageId: string, customerId: string) {
  if (!messageId) return;
  try {
    const result = await api<{ skipped?: boolean }>(`/api/whatsapp/messages/${encodeURIComponent(messageId)}/translate`, { method: "POST" });
    if (result.skipped) { toast("中文消息无需翻译"); return; }
    await openWhatsAppThread(customerId, true);
    toast("翻译完成");
  } catch (error) {
    toast(error instanceof Error ? error.message : "翻译失败，请先配置 AI 模型", "error");
  }
}
