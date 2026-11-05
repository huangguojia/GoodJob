/**
 * 对接中心。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { closeModal, confirmAction, openModal } from "../prototype-api";
import { badge, escapeHtml, qs, qsa } from "./shared";
import { api, toast } from "./ui";
import { formatDateTime } from "./deals";

// ---------------------------------------------------------------------------
// 对接中心：对接方管理 + 报文收发 + 报文日志
// ---------------------------------------------------------------------------

interface ExchangeEndpointView {
  id: string;
  name: string;
  direction: "outbound" | "inbound" | "both";
  baseUrl: string;
  authType: "none" | "bearer" | "header";
  authName: string;
  authSecret: string;
  inboundKey: string;
  extraHeadersJson: string;
  description: string;
  onReceive: "log" | "create_lead";
  enabled: boolean;
  createdAt: string;
}

interface ExchangeMessageView {
  id: string;
  endpointId: string;
  endpointName: string;
  direction: "outbound" | "inbound";
  topic: string;
  method: string;
  url: string;
  status: "ok" | "failed" | "received";
  httpStatus: number | null;
  durationMs: number | null;
  errorMessage: string;
  leadId: string;
  sourceIp: string;
  createdAt: string;
}

let exchangeEndpoints: ExchangeEndpointView[] = [];
let exchangeMessages: ExchangeMessageView[] = [];
let exchangeOnlyFailed = false;

const EXCHANGE_DIRECTION_LABEL: Record<string, string> = { outbound: "推送", inbound: "接收", both: "双向" };

function prettyJsonText(text: string): string {
  if (!text) return "（空）";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function copyExchangeText(text: string, label: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast(`${label}已复制`, "success"),
    () => toast("复制失败，请手动选择复制", "error")
  );
}

export async function loadExchangeData() {
  try {
    const params = new URLSearchParams({ limit: "200" });
    const endpointFilter = qs<HTMLSelectElement>("#exchangeEndpointFilter")?.value || "";
    if (endpointFilter) params.set("endpointId", endpointFilter);
    const directionFilter = qs<HTMLSelectElement>("#exchangeDirectionFilter")?.value || "";
    if (directionFilter) params.set("direction", directionFilter);
    if (exchangeOnlyFailed) params.set("onlyFailed", "1");
    const [endpointResult, messageResult] = await Promise.all([
      api<{ endpoints: ExchangeEndpointView[] }>("/api/exchange/endpoints"),
      api<{ messages: ExchangeMessageView[] }>(`/api/exchange/messages?${params.toString()}`)
    ]);
    exchangeEndpoints = endpointResult.endpoints || [];
    exchangeMessages = messageResult.messages || [];
    renderExchange();
  } catch (error) {
    toast(error instanceof Error ? error.message : "对接中心数据加载失败", "error");
  }
}

function renderExchange() {
  const endpointBox = qs<HTMLElement>("#exchangeEndpointList");
  const tbody = qs<HTMLElement>("#exchangeMessagesBody");
  if (!endpointBox || !tbody) return;

  const totalCell = qs<HTMLElement>("#exchangeEndpointCount");
  if (totalCell) totalCell.textContent = String(exchangeEndpoints.length);
  const today = new Date().toDateString();
  const todayCount = exchangeMessages.filter((item) => new Date(item.createdAt).toDateString() === today).length;
  const todayCell = qs<HTMLElement>("#exchangeTodayCount");
  if (todayCell) todayCell.textContent = String(todayCount);
  const failedCell = qs<HTMLElement>("#exchangeFailedCount");
  if (failedCell) failedCell.textContent = String(exchangeMessages.filter((item) => item.status === "failed").length);
  const last = exchangeMessages[0];
  const lastCell = qs<HTMLElement>("#exchangeLastActive");
  const lastSource = qs<HTMLElement>("#exchangeLastActiveSource");
  if (lastCell && lastSource) {
    if (last) {
      lastCell.textContent = formatDateTime(last.createdAt);
      lastSource.textContent = `${last.direction === "outbound" ? "发往" : "来自"} ${last.endpointName || "未知对接方"}`;
    } else {
      lastCell.textContent = "—";
      lastSource.textContent = "暂无收发";
    }
  }

  endpointBox.innerHTML = exchangeEndpoints.length ? exchangeEndpoints.map((endpoint) => {
    const canSend = endpoint.direction !== "inbound" && Boolean(endpoint.baseUrl);
    const showInbound = endpoint.direction !== "outbound";
    return `<div class="exchange-endpoint-card ${endpoint.enabled ? "" : "disabled"}">
      <header><b>${escapeHtml(endpoint.name)}</b><span>${badge(EXCHANGE_DIRECTION_LABEL[endpoint.direction] || endpoint.direction, endpoint.direction === "inbound" ? "green" : "blue")}${endpoint.enabled ? "" : badge("已停用", "gray")}</span></header>
      ${endpoint.baseUrl ? `<div class="exchange-endpoint-url">推送地址：${escapeHtml(endpoint.baseUrl)}</div>` : `<div class="exchange-endpoint-url">未配置推送地址</div>`}
      ${showInbound ? `<div class="exchange-inbound-url"><span>接收地址：${escapeHtml(`${location.origin}/api/exchange/in/${endpoint.inboundKey}`)}</span><button class="btn" type="button" data-exchange-copy-inbound="${escapeHtml(endpoint.inboundKey)}">复制</button></div>` : ""}
      ${showInbound ? `<div class="exchange-endpoint-desc">${endpoint.onReceive === "create_lead" ? badge("接收后自动建线索", "green") : badge("接收仅记录报文", "gray")}</div>` : ""}
      ${endpoint.description ? `<div class="exchange-endpoint-desc">${escapeHtml(endpoint.description)}</div>` : ""}
      <footer>
        ${canSend ? `<button class="btn primary" type="button" data-exchange-send="${escapeHtml(endpoint.id)}">发送报文</button>` : ""}
        <button class="btn" type="button" data-exchange-edit="${escapeHtml(endpoint.id)}">编辑</button>
        <button class="btn danger subtle" type="button" data-exchange-delete="${escapeHtml(endpoint.id)}">删除</button>
      </footer>
    </div>`;
  }).join("") : `<div class="exchange-empty" style="grid-column:1/-1">还没有对接方。点右上角「新建对接」登记第一个外部系统：<br>填对方系统的接收地址，就能推送报文；登记后系统会生成一个接收地址，对方也能把报文推进来。</div>`;

  const endpointFilter = qs<HTMLSelectElement>("#exchangeEndpointFilter");
  if (endpointFilter) {
    const current = endpointFilter.value;
    endpointFilter.innerHTML = `<option value="">全部对接方</option>${exchangeEndpoints.map((endpoint) => `<option value="${escapeHtml(endpoint.id)}">${escapeHtml(endpoint.name)}</option>`).join("")}`;
    if ([...endpointFilter.options].some((option) => option.value === current)) endpointFilter.value = current;
  }

  tbody.innerHTML = exchangeMessages.length ? exchangeMessages.map((item) => {
    const directionLabel = item.direction === "outbound" ? `<span class="exchange-dir-badge outbound">↑ 发出</span>` : `<span class="exchange-dir-badge inbound">↓ 接收</span>`;
    const statusBadge = item.status === "ok" ? badge("成功", "green") : item.status === "failed" ? badge("失败", "red") : badge("已接收", "green");
    const leadBadge = item.leadId ? badge("已建线索", "green") : "";
    return `<tr data-exchange-message="${escapeHtml(item.id)}" style="cursor:pointer">
      <td>${escapeHtml(formatDateTime(item.createdAt))}</td>
      <td>${directionLabel}</td>
      <td>${escapeHtml(item.endpointName || "—")}</td>
      <td>${escapeHtml(item.topic || "—")}</td>
      <td>${escapeHtml(item.sourceIp || "—")}</td>
      <td>${statusBadge}${leadBadge ? ` ${leadBadge}` : ""}</td>
      <td>${item.httpStatus ?? "—"}</td>
      <td>${item.durationMs != null ? `${item.durationMs}ms` : "—"}</td>
      <td><button class="btn tiny" type="button" data-exchange-detail="${escapeHtml(item.id)}">详情</button></td>
    </tr>`;
  }).join("") : `<tr><td colspan="9" class="empty-cell">暂无报文。配置对接方后点「发送报文」，或把接收地址交给对方系统，收发都会记录在这里。</td></tr>`;

  qsa<HTMLButtonElement>("[data-exchange-send]", endpointBox).forEach((button) => button.addEventListener("click", () => {
    const endpoint = exchangeEndpoints.find((item) => item.id === button.dataset.exchangeSend);
    if (endpoint) openExchangeSendModal(endpoint);
  }));
  qsa<HTMLButtonElement>("[data-exchange-edit]", endpointBox).forEach((button) => button.addEventListener("click", () => {
    const endpoint = exchangeEndpoints.find((item) => item.id === button.dataset.exchangeEdit);
    if (endpoint) openExchangeEndpointModal(endpoint);
  }));
  qsa<HTMLButtonElement>("[data-exchange-delete]", endpointBox).forEach((button) => button.addEventListener("click", () => {
    const endpoint = exchangeEndpoints.find((item) => item.id === button.dataset.exchangeDelete);
    if (endpoint) void deleteExchangeEndpoint(endpoint);
  }));
  qsa<HTMLButtonElement>("[data-exchange-copy-inbound]", endpointBox).forEach((button) => button.addEventListener("click", () => {
    copyExchangeText(`${location.origin}/api/exchange/in/${button.dataset.exchangeCopyInbound}`, "接收地址");
  }));
  qsa<HTMLButtonElement>("[data-exchange-detail]", tbody).forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    void openExchangeMessageDetail(button.dataset.exchangeDetail || "");
  }));
  qsa<HTMLTableRowElement>("[data-exchange-message]", tbody).forEach((row) => row.addEventListener("click", () => {
    void openExchangeMessageDetail(row.dataset.exchangeMessage || "");
  }));
}

function openExchangeEndpointModal(endpoint?: ExchangeEndpointView) {
  const editing = Boolean(endpoint);
  const body = `
    <p class="modal-hint">对接方 = 一个外部系统的收发配置。「推送」= 我方主动发报文给对方；「接收」= 对方按系统生成的接收地址推送进来；可双向。</p>
    <div class="form-grid">
      <div class="form-field"><label>名称 *</label><input id="exchangeNameInput" value="${escapeHtml(endpoint?.name || "")}" placeholder="例如：金蝶云 ERP"></div>
      <div class="form-field"><label>方向</label><select id="exchangeDirectionInput">
        <option value="outbound" ${endpoint?.direction === "outbound" ? "selected" : ""}>推送（我方 → 对方）</option>
        <option value="inbound" ${endpoint?.direction === "inbound" ? "selected" : ""}>接收（对方 → 我方）</option>
        <option value="both" ${endpoint?.direction === "both" ? "selected" : ""}>双向</option>
      </select></div>
      <div class="form-field full"><label>推送地址（对方的接收 URL）</label><input id="exchangeBaseUrlInput" value="${escapeHtml(endpoint?.baseUrl || "")}" placeholder="https://api.example.com/webhook/goodjob"></div>
      <div class="form-field"><label>鉴权方式</label><select id="exchangeAuthTypeInput">
        <option value="none" ${endpoint?.authType === "none" ? "selected" : ""}>无</option>
        <option value="bearer" ${endpoint?.authType === "bearer" ? "selected" : ""}>Bearer Token</option>
        <option value="header" ${endpoint?.authType === "header" ? "selected" : ""}>自定义请求头</option>
      </select></div>
      <div class="form-field"><label>自定义头名称（鉴权方式=自定义请求头时填）</label><input id="exchangeAuthNameInput" value="${escapeHtml(endpoint?.authName || "")}" placeholder="例如 X-Api-Key"></div>
      <div class="form-field full"><label>鉴权密钥 / Token</label><input id="exchangeAuthSecretInput" type="password" value="${escapeHtml(endpoint?.authSecret || "")}" placeholder="对方系统分配的密钥"></div>
      <div class="form-field full"><label>附加请求头（JSON，可选）</label><input id="exchangeExtraHeadersInput" value="${escapeHtml(endpoint?.extraHeadersJson === "{}" ? "" : endpoint?.extraHeadersJson || "")}" placeholder='{"X-Tenant":"goodjob"}'></div>
      <div class="form-field full"><label>描述</label><input id="exchangeDescriptionInput" value="${escapeHtml(endpoint?.description || "")}" placeholder="对接内容、负责人、注意事项等"></div>
      <div class="form-field full"><label>接收处理（仅接收/双向方向生效）</label><select id="exchangeOnReceiveInput">
        <option value="log" ${(endpoint?.onReceive || "log") === "log" ? "selected" : ""}>仅记录报文（默认）</option>
        <option value="create_lead" ${endpoint?.onReceive === "create_lead" ? "selected" : ""}>自动创建线索（报文含公司名即建线索，重复自动关联）</option>
      </select><small style="color:var(--text-tertiary,#8a94a6);font-size:11px;display:block;margin-top:4px">开启后，对方推来的报文会解析公司/联系人/邮箱等字段直接进入「线索」，并保留原始报文血缘。</small></div>
      <label class="form-field full" style="display:flex;gap:8px;align-items:center"><input id="exchangeEnabledInput" type="checkbox" ${!endpoint || endpoint.enabled ? "checked" : ""}>启用该对接方</label>
    </div>`;
  const foot = `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="exchangeSaveEndpointButton">${editing ? "保存修改" : "创建对接方"}</button>`;
  openModal(editing ? `编辑对接方 · ${endpoint!.name}` : "新建对接方", body, foot, { closeOnBackdrop: false });
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs<HTMLButtonElement>("#exchangeSaveEndpointButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const name = qs<HTMLInputElement>("#exchangeNameInput")?.value.trim() || "";
    if (!name) {
      toast("请填写名称", "error");
      return;
    }
    let extraHeadersJson = "{}";
    const extraRaw = qs<HTMLInputElement>("#exchangeExtraHeadersInput")?.value.trim() || "";
    if (extraRaw) {
      try {
        extraHeadersJson = JSON.stringify(JSON.parse(extraRaw));
      } catch {
        toast("附加请求头不是合法 JSON，例如 {\"X-Tenant\":\"goodjob\"}", "error");
        return;
      }
    }
    const payload = {
      name,
      direction: qs<HTMLSelectElement>("#exchangeDirectionInput")?.value || "outbound",
      baseUrl: qs<HTMLInputElement>("#exchangeBaseUrlInput")?.value.trim() || "",
      authType: qs<HTMLSelectElement>("#exchangeAuthTypeInput")?.value || "none",
      authName: qs<HTMLInputElement>("#exchangeAuthNameInput")?.value.trim() || "",
      authSecret: qs<HTMLInputElement>("#exchangeAuthSecretInput")?.value || "",
      extraHeadersJson,
      description: qs<HTMLInputElement>("#exchangeDescriptionInput")?.value.trim() || "",
      onReceive: qs<HTMLSelectElement>("#exchangeOnReceiveInput")?.value === "create_lead" && (qs<HTMLSelectElement>("#exchangeDirectionInput")?.value || "outbound") !== "outbound" ? "create_lead" : "log",
      enabled: qs<HTMLInputElement>("#exchangeEnabledInput")?.checked ?? true
    };
    button.disabled = true;
    try {
      if (editing) {
        await api(`/api/exchange/endpoints/${encodeURIComponent(endpoint!.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast("对接方已保存", "success");
      } else {
        await api("/api/exchange/endpoints", { method: "POST", body: JSON.stringify(payload) });
        toast("对接方已创建", "success");
      }
      closeModal();
      await loadExchangeData();
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败", "error");
      button.disabled = false;
    }
  });
}

async function deleteExchangeEndpoint(endpoint: ExchangeEndpointView) {
  const ok = await confirmAction({
    title: "删除对接方",
    message: `确定删除对接方「${endpoint.name}」吗？`,
    consequences: ["该对接方的配置与接收地址会立即失效", "已产生的报文日志会保留，但无法再按该对接方筛选"],
    confirmLabel: "删除",
    tone: "danger"
  });
  if (!ok) return;
  try {
    await api(`/api/exchange/endpoints/${encodeURIComponent(endpoint.id)}`, { method: "DELETE" });
    toast("对接方已删除", "success");
    await loadExchangeData();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败", "error");
  }
}

function openExchangeSendModal(endpoint: ExchangeEndpointView) {
  const body = `
    <p class="modal-hint">向「${escapeHtml(endpoint.name)}」推送一条报文。报文体为 JSON，发送后可在报文日志查看对方返回的完整响应。</p>
    <div class="form-grid">
      <div class="form-field"><label>主题（topic，用于日志归类）</label><input id="exchangeSendTopic" value="test" placeholder="例如 order.created"></div>
      <div class="form-field"><label>HTTP 方法</label><select id="exchangeSendMethod"><option>POST</option><option>PUT</option><option>PATCH</option></select></div>
      <div class="form-field full"><label>报文体（JSON）</label><textarea id="exchangeSendBody" rows="10" style="font-family:var(--font-mono,monospace);font-size:12px">${escapeHtml('{\n  "event": "customer.created",\n  "name": "示例客户",\n  "country": "德国"\n}')}</textarea></div>
    </div>`;
  const foot = `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="exchangeSendSubmitButton">发送报文</button>`;
  openModal(`发送报文 · ${endpoint.name}`, body, foot, { closeOnBackdrop: false });
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs<HTMLButtonElement>("#exchangeSendSubmitButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    let payload: unknown;
    const raw = qs<HTMLTextAreaElement>("#exchangeSendBody")?.value.trim() || "";
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        toast("报文体不是合法 JSON", "error");
        return;
      }
    }
    button.disabled = true;
    try {
      const result = await api<{ message: ExchangeMessageView & { responseBody: string; errorMessage: string } }>(
        `/api/exchange/endpoints/${encodeURIComponent(endpoint.id)}/send`,
        { method: "POST", body: JSON.stringify({ topic: qs<HTMLInputElement>("#exchangeSendTopic")?.value.trim() || "message", method: qs<HTMLSelectElement>("#exchangeSendMethod")?.value || "POST", payload }) }
      );
      closeModal();
      const ok = result.message.status === "ok";
      toast(ok ? `报文已送达（HTTP ${result.message.httpStatus}，${result.message.durationMs}ms）` : `发送失败：${result.message.errorMessage || `HTTP ${result.message.httpStatus}`}`, ok ? "success" : "error");
      const detail = `<div class="exchange-msg-detail">
        <div><div class="exchange-detail-head"><b>对方响应（HTTP ${result.message.httpStatus ?? "—"}）</b></div><pre>${escapeHtml(prettyJsonText(result.message.responseBody))}</pre></div>
      </div>`;
      openModal(ok ? "发送成功" : "发送失败", detail, `<button class="btn" data-modal-close>关闭</button><button class="btn primary" id="exchangeAfterSendLog">查看报文日志</button>`);
      qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
      qs<HTMLButtonElement>("#exchangeAfterSendLog")?.addEventListener("click", () => {
        closeModal();
        void loadExchangeData();
      });
      await loadExchangeData();
    } catch (error) {
      toast(error instanceof Error ? error.message : "发送失败", "error");
      button.disabled = false;
    }
  });
}

async function openExchangeMessageDetail(messageId: string) {
  try {
    const result = await api<{ message: ExchangeMessageView & { requestHeadersJson: string; requestBody: string; responseHeadersJson: string; responseBody: string; url: string } }>(
      `/api/exchange/messages/${encodeURIComponent(messageId)}`
    );
    const message = result.message;
    const detail = `<div class="exchange-msg-detail">
      <div><div class="exchange-detail-head"><b>基本信息</b></div>
        <pre>${escapeHtml(`方向：${message.direction === "outbound" ? "发出 → 对方" : "对方 → 接收"}\n对接方：${message.endpointName || "—"}\n来源 IP：${message.sourceIp || "—"}\n主题：${message.topic || "—"}\n${message.method} ${message.url}\n状态：${message.status === "ok" ? "成功" : message.status === "failed" ? "失败" : "已接收"} · HTTP ${message.httpStatus ?? "—"} · ${message.durationMs != null ? `${message.durationMs}ms` : "—"}${message.leadId ? `\n建线索：${message.leadId}${message.status === "received" ? "（收到的报文已自动进入线索）" : ""}` : ""}${message.errorMessage ? `\n错误：${message.errorMessage}` : ""}`)}</pre></div>
      <div><div class="exchange-detail-head"><b>请求头</b><button class="btn" type="button" data-exchange-copy="${escapeHtml(message.id)}" data-copy-part="request-headers">复制</button></div><pre>${escapeHtml(prettyJsonText(message.requestHeadersJson))}</pre></div>
      <div><div class="exchange-detail-head"><b>请求体（我方报文）</b><button class="btn" type="button" data-exchange-copy="${escapeHtml(message.id)}" data-copy-part="request-body">复制</button></div><pre>${escapeHtml(prettyJsonText(message.requestBody))}</pre></div>
      <div><div class="exchange-detail-head"><b>响应头</b></div><pre>${escapeHtml(prettyJsonText(message.responseHeadersJson))}</pre></div>
      <div><div class="exchange-detail-head"><b>响应体（对方报文）</b><button class="btn" type="button" data-exchange-copy="${escapeHtml(message.id)}" data-copy-part="response-body">复制</button></div><pre>${escapeHtml(prettyJsonText(message.responseBody))}</pre></div>
    </div>`;
    openModal(`报文详情 · ${message.topic || message.id}`, detail, `<button class="btn primary" data-modal-close>关闭</button>`);
    qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
    qsa<HTMLButtonElement>("[data-exchange-copy]").forEach((button) => button.addEventListener("click", async () => {
      const fresh = await api<{ message: ExchangeMessageView & { requestHeadersJson: string; requestBody: string; responseBody: string } }>(
        `/api/exchange/messages/${encodeURIComponent(messageId)}`
      );
      const part = button.dataset.copyPart;
      const text = part === "request-headers" ? prettyJsonText(fresh.message.requestHeadersJson)
        : part === "request-body" ? prettyJsonText(fresh.message.requestBody)
        : prettyJsonText(fresh.message.responseBody);
      copyExchangeText(text, "报文内容");
    }));
  } catch (error) {
    toast(error instanceof Error ? error.message : "报文详情加载失败", "error");
  }
}

export function bindExchangeEvents() {
  qs<HTMLButtonElement>("#exchangeCreateButton")?.addEventListener("click", () => openExchangeEndpointModal());
  qs<HTMLButtonElement>("#exchangeRefreshButton")?.addEventListener("click", () => void loadExchangeData());
  qs<HTMLSelectElement>("#exchangeEndpointFilter")?.addEventListener("change", () => void loadExchangeData());
  qs<HTMLSelectElement>("#exchangeDirectionFilter")?.addEventListener("change", () => void loadExchangeData());
  qs<HTMLButtonElement>("#exchangeFailedToggle")?.addEventListener("click", (event) => {
    exchangeOnlyFailed = !exchangeOnlyFailed;
    (event.currentTarget as HTMLButtonElement).classList.toggle("primary", exchangeOnlyFailed);
    void loadExchangeData();
  });
}
