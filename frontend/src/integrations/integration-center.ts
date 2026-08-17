import {
  createIntegrationClient,
  type ConnectionScope,
  type IntegrationCall,
  type IntegrationAuthTransaction,
  type IntegrationApproval,
  type IntegrationCatalogItem,
  type IntegrationConnectorReview,
  type IntegrationConnection,
  type IntegrationDailyUsage,
  type IntegrationEvent,
  type IntegrationAccount,
  type IntegrationRequest,
  type IntegrationTool,
  type WecomCommandEndpoint,
  type WecomMemberBinding,
  type WorkspaceMailMessage
} from "./integration-api";
import { mountLocalRunnerCenter } from "./local-runner-center";

export interface IntegrationCenterDependencies {
  request: IntegrationRequest;
  toast(message: string, type?: "ok" | "error" | "success" | "warn" | "info"): void;
  openModal(title: string, body: string, foot: string): void;
  closeModal(): void;
  hasPermission(permissionCode: string): boolean;
  permissionScopes(permissionCode: string): string[];
}

interface LinkableCustomer {
  id: string;
  company: string;
  contact: string;
  ownerName?: string;
}

export interface IntegrationCenterController {
  refresh(silent?: boolean): Promise<void>;
}

const connectionStatus: Record<string, string> = {
  draft: "草稿", authorizing: "授权中", pending_confirmation: "待确认", discovering: "发现工具中",
  pending_review: "待审核", active: "运行中", degraded: "服务异常", reauthorization_required: "需重新授权",
  paused: "已暂停", disconnecting: "正在解绑", disconnected: "已解绑", failed: "连接失败"
};
const toolStatus: Record<string, string> = {
  discovered: "已发现", pending_review: "待审核", active: "已启用", quarantined: "已隔离",
  rejected: "已拒绝", retired: "已停用"
};
const callStatus: Record<string, string> = {
  created: "已创建", awaiting_approval: "待审批", queued: "排队中", running: "执行中", succeeded: "成功",
  failed: "失败", unknown_outcome: "结果待确认", reconciliation_required: "待对账", cancelled: "已取消"
};
const eventStatus: Record<string, string> = {
  received: "已接收", verified: "已验签", queued: "排队中", processing: "处理中", processed: "已处理",
  ignored: "已忽略", dead_letter: "死信", replayed: "已回放"
};
const eventWritebackStatus: Record<string, string> = {
  pending: "待写入 CRM", completed: "已写入客户", needs_match: "待关联客户", failed: "回写失败"
};
const typeLabel: Record<string, string> = {
  native_mcp: "MCP", official_api: "官方 API", webhook: "Webhook", internal: "内部数据源"
};
const connectorStatus: Record<string, string> = {
  active: "可连接", draft: "规划中", review: "审核中", disabled: "未通过", deprecated: "已停用"
};
const connectorReviewStatus: Record<string, string> = {
  pending: "待平台审核", approved: "已通过", rejected: "未通过"
};

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char] || char));
}

function category(connector: IntegrationCatalogItem) {
  if (["microsoft-365", "google-workspace", "google-drive-trade-docs"].includes(connector.code)) return "collaboration";
  if (["odoo", "erpnext"].includes(connector.code)) return "erp";
  if (connector.code.includes("logistics")) return "logistics";
  return "data";
}

function formatDate(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function statusTone(status: string) {
  if (["active", "succeeded"].includes(status)) return "is-active";
  if (["failed", "degraded", "disabled", "rejected", "quarantined", "unknown_outcome", "reconciliation_required"].includes(status)) return "is-error";
  if (["pending", "pending_review", "review", "discovering", "queued", "running", "reauthorization_required"].includes(status)) return "is-warn";
  return "";
}

function inputFields(tool: IntegrationTool) {
  try {
    const schema = JSON.parse(tool.inputSchemaJson) as { properties?: Record<string, unknown> };
    return Object.keys(schema.properties || {});
  } catch {
    return [];
  }
}

function previewValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function mountIntegrationCenter(dependencies: IntegrationCenterDependencies): IntegrationCenterController {
  const root = document.querySelector<HTMLElement>("#integration-center .integration-center");
  const client = createIntegrationClient(dependencies.request);
  if (!root) return { async refresh() {} };

  const one = <T extends Element>(selector: string, scope: ParentNode = root) => scope.querySelector<T>(selector);
  const all = <T extends Element>(selector: string, scope: ParentNode = root) => [...scope.querySelectorAll<T>(selector)];
  let catalog: IntegrationCatalogItem[] = [];
  let connections: IntegrationConnection[] = [];
  let tools: IntegrationTool[] = [];
  let calls: IntegrationCall[] = [];
  let usage: IntegrationDailyUsage[] = [];
  let events: IntegrationEvent[] = [];
  let approvals: IntegrationApproval[] = [];
  let connectorReviews: IntegrationConnectorReview[] = [];
  let wecomEndpoints: WecomCommandEndpoint[] = [];
  let wecomBindings: WecomMemberBinding[] = [];
  let accounts: IntegrationAccount[] = [];
  let selectedConnectorId = "";
  let activeFilter = "all";
  let loading: Promise<void> | null = null;
  let settleTimer = 0;
  let workspaceProvider: "microsoft" | "google" = "microsoft";
  let workspaceMessages: WorkspaceMailMessage[] = [];
  const platformReviewOnly = dependencies.hasPermission("platform.integration.connector.review")
    && !dependencies.hasPermission("integration.read");
  const localRunnerCenter = mountLocalRunnerCenter(root, dependencies);

  const canManageWecom = () => dependencies.hasPermission("integration.manage");
  const wecomConnectorConnections = () => connections.filter((connection) => {
    const connector = connectorFor(connection.connectorId);
    return connector?.code === "wecom" && !["disconnected", "failed"].includes(connection.status);
  });

  const showHome = () => {
    root.classList.add("is-launcher");
    root.classList.remove("is-detail-open");
    root.classList.add("detail-closed");
    all<HTMLButtonElement>("[data-integration-tab]").forEach((button) => button.classList.remove("active"));
    all<HTMLElement>("[data-integration-panel]").forEach((panel) => { panel.hidden = true; });
  };

  const showTab = (name: string) => {
    root.classList.remove("is-launcher");
    all<HTMLButtonElement>("[data-integration-tab]").forEach((button) => button.classList.toggle("active", button.dataset.integrationTab === name));
    all<HTMLElement>("[data-integration-panel]").forEach((panel) => { panel.hidden = panel.dataset.integrationPanel !== name; });
    root.classList.remove("is-detail-open");
    root.classList.add("detail-closed");
    if (name === "local-runner") localRunnerCenter.activate();
  };

  const setHealth = (label: string, tone: "active" | "error" | "loading") => {
    const health = one<HTMLElement>(".integration-health");
    if (!health) return;
    health.className = `integration-health is-${tone}`;
    const text = health.lastChild;
    if (text) text.textContent = label;
  };

  const connectionFor = (connectorId: string) => connections.find((item) => item.connectorId === connectorId && item.status !== "disconnected");
  const connectorFor = (connectorId: string) => catalog.find((item) => item.id === connectorId);
  const connectionName = (connectionId: string) => connections.find((item) => item.id === connectionId)?.displayName || "未知连接";

  const accountSummary = (connection: IntegrationConnection) => {
    try {
      const info = JSON.parse(connection.serverInfoJson || "{}") as {
        authorizationIssuer?: string;
        account?: { name?: string; email?: string; organization?: string };
        grantedScopes?: string[];
      };
      return {
        issuer: info.authorizationIssuer || "",
        name: info.account?.name || info.account?.email || "外部账号",
        email: info.account?.email || "",
        organization: info.account?.organization || "",
        scopes: Array.isArray(info.grantedScopes) ? info.grantedScopes : []
      };
    } catch {
      return { issuer: "", name: "外部账号", email: "", organization: "", scopes: [] as string[] };
    }
  };

  const renderOverview = () => {
    const activeConnections = connections.filter((item) => !["disconnected", "failed"].includes(item.status));
    const activeTools = tools.filter((item) => item.status === "active");
    const pendingTools = tools.filter((item) => item.status === "pending_review");
    const pendingApprovals = approvals.filter((item) => item.status === "pending");
    const pendingConnectorReviews = connectorReviews.filter((item) => item.status === "pending");
    const numbers = [catalog.length, activeConnections.length, activeTools.length, pendingTools.length + pendingConnectorReviews.length];
    all<HTMLElement>(".integration-overview strong").forEach((node, index) => { node.textContent = String(numbers[index] || 0); });
    const launchCount = (tab: string, value: number) => {
      const node = one<HTMLElement>(`[data-integration-launch-count="${tab}"]`);
      if (node) node.textContent = String(value);
    };
    launchCount("catalog", catalog.length);
    launchCount("connected", activeConnections.length);
    launchCount("wecom-commands", wecomEndpoints.length);
    launchCount("permissions", activeTools.length);
    launchCount("approvals", pendingTools.length + pendingApprovals.length);
    launchCount("events", events.length);
    launchCount("activity", calls.length);
    launchCount("connector-reviews", pendingConnectorReviews.length);
    const connectedBadge = one<HTMLElement>('[data-integration-tab="connected"] span');
    const approvalBadge = one<HTMLElement>('[data-integration-tab="approvals"] span');
    const connectorReviewBadge = one<HTMLElement>('[data-integration-tab="connector-reviews"] span');
    if (connectedBadge) connectedBadge.textContent = String(activeConnections.length);
    if (approvalBadge) approvalBadge.textContent = String(pendingTools.length + pendingApprovals.length);
    if (connectorReviewBadge) connectorReviewBadge.textContent = String(pendingConnectorReviews.length);
  };

  const openConnector = (connectorId: string) => {
    selectedConnectorId = connectorId;
    all<HTMLButtonElement>("[data-integration-connector]").forEach((card) => card.classList.toggle("selected", card.dataset.integrationConnector === connectorId));
    const connector = catalog.find((item) => item.id === connectorId);
    if (!connector) return;
    const connection = connectionFor(connector.id);
    const relatedTools = connection ? tools.filter((item) => item.connectionId === connection.id) : [];
    const setText = (selector: string, value: string) => { const node = one<HTMLElement>(selector); if (node) node.textContent = value; };
    setText("#integrationDetailMark", connector.name.trim().slice(0, 1).toUpperCase() || "-");
    setText("#integrationDetailKind", typeLabel[connector.type] || "连接器");
    setText("#integrationDetailName", connector.name);
    setText("#integrationDetailRisk", relatedTools.length ? `最高 R${Math.max(...relatedTools.map((item) => item.riskLevel))}` : "待发现");
    setText("#integrationDetailScope", connection ? `${connection.scope === "personal" ? "个人" : connection.scope === "team" ? "团队" : "平台"}范围 · 服务端加密凭证` : "连接后按账号与团队隔离");
    setText("#integrationDetailToolCount", `${relatedTools.length} 项`);
    const list = one<HTMLElement>("#integrationDetailTools");
    if (list) list.innerHTML = relatedTools.length
      ? relatedTools.map((tool) => `<li>${escapeHtml(tool.displayName || tool.remoteName)}</li>`).join("")
      : "<li>连接成功后自动发现可用工具</li>";
    const state = one<HTMLElement>(".integration-detail-state span");
    if (state) state.innerHTML = `<i></i>${escapeHtml(connection ? connectionStatus[connection.status] || connection.status : connectorStatus[connector.status] || "尚未开放")}`;
    const connectButton = one<HTMLButtonElement>("#integrationPrototypeConnect");
    if (connectButton) {
      connectButton.disabled = connector.status !== "active";
      const label = connectButton.querySelector("span");
      if (label) label.textContent = connection ? "查看连接" : connector.status === "active" ? "开始连接" : connector.status === "review" ? "等待审核" : "暂未开放";
    }
    root.classList.remove("detail-closed");
    root.classList.add("is-detail-open");
  };

  const renderCatalog = () => {
    const grid = one<HTMLElement>("#integrationCatalogGrid");
    const empty = one<HTMLElement>("#integrationEmptyFilter");
    const search = one<HTMLInputElement>("#integrationSearchInput")?.value.trim().toLowerCase() || "";
    const visible = catalog.filter((connector) => (activeFilter === "all" || category(connector) === activeFilter)
      && (!search || `${connector.name} ${connector.code} ${connector.description} ${typeLabel[connector.type] || ""}`.toLowerCase().includes(search)));
    const count = one<HTMLElement>(".integration-section-head > span");
    if (count) count.textContent = `${catalog.length} 个连接器`;
    if (grid) grid.innerHTML = visible.map((connector) => {
      const connection = connectionFor(connector.id);
      const relatedTools = connection ? tools.filter((tool) => tool.connectionId === connection.id) : [];
      const status = connection ? connectionStatus[connection.status] || connection.status : connectorStatus[connector.status] || connector.status;
      return `<button class="integration-app-card ${connector.id === selectedConnectorId ? "selected" : ""}" type="button" data-integration-connector="${escapeHtml(connector.id)}">
        <span class="integration-app-mark">${escapeHtml(connector.name.trim().slice(0, 1).toUpperCase())}</span>
        <span class="integration-app-main"><span class="integration-app-name"><b>${escapeHtml(connector.name)}</b><em>${escapeHtml(status)}</em></span>
        <small>${escapeHtml(connector.description)}</small><span class="integration-app-tags"><i>${escapeHtml(typeLabel[connector.type] || connector.type)}</i><i>${relatedTools.length ? `${relatedTools.length} 个工具` : connector.manifest.stage === "planned" ? "规划中" : "待发现"}</i></span></span>
        <svg class="integration-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>`;
    }).join("");
    if (empty) empty.hidden = visible.length > 0;
    all<HTMLButtonElement>("[data-integration-connector]").forEach((card) => card.addEventListener("click", () => openConnector(card.dataset.integrationConnector || "")));
    if (!selectedConnectorId || !catalog.some((item) => item.id === selectedConnectorId)) selectedConnectorId = catalog[0]?.id || "";
    if (selectedConnectorId) openConnector(selectedConnectorId);
  };

  const renderConnections = () => {
    const panel = one<HTMLElement>('[data-integration-panel="connected"]');
    if (!panel) return;
    const canConnect = dependencies.hasPermission("integration.connect");
    const visible = connections.filter((item) => item.status !== "disconnected");
    panel.innerHTML = `<div class="integration-workspace-head"><div><h2>已连接应用</h2><p>查看工具发现、健康状态和授权范围。</p></div>${canConnect ? `<button class="btn" type="button" data-integration-open-catalog>添加连接</button>` : ""}</div>
      ${visible.length ? `<div class="integration-permission-list">${visible.map((connection) => `<div class="integration-permission-row integration-connection-row">
        <span><b>${escapeHtml(connection.displayName)}</b><small>${escapeHtml(connectorFor(connection.connectorId)?.name || connection.connectorId)}</small>${connection.lastHealthAt ? `<small>最近检查 ${escapeHtml(new Date(connection.lastHealthAt).toLocaleString("zh-CN"))}${connection.lastHealthLatencyMs ? ` · ${connection.lastHealthLatencyMs} ms` : ""}</small>` : ""}${connection.lastErrorMessage ? `<small title="${escapeHtml(connection.lastErrorMessage)}">${escapeHtml(connection.lastErrorMessage)}</small>` : ""}</span>
        <span>${connection.scope === "personal" ? "个人" : connection.scope === "team" ? "团队" : "平台"}</span>
        <em class="integration-status ${statusTone(connection.status)}">${escapeHtml(connectionStatus[connection.status] || connection.status)}</em>
        <span class="integration-row-actions">${connection.status === "authorizing" ? `<button class="btn primary" data-connection-action="authorize" data-id="${escapeHtml(connection.id)}" type="button">继续授权</button>` : ""}${connection.status === "pending_confirmation" ? `<button class="btn primary" data-connection-action="confirm" data-id="${escapeHtml(connection.id)}" type="button">确认账号</button>` : ""}${connection.status === "reauthorization_required" ? `<button class="btn primary" data-connection-action="reauthorize" data-id="${escapeHtml(connection.id)}" type="button">重新授权</button>` : ""}${["active", "pending_review"].includes(connection.status) ? `<button class="btn" data-connection-action="pause" data-id="${escapeHtml(connection.id)}" type="button">暂停</button>` : ""}${connection.status === "paused" ? `<button class="btn" data-connection-action="resume" data-id="${escapeHtml(connection.id)}" type="button">恢复</button>` : ""}${["active", "degraded", "pending_review"].includes(connection.status) ? `<button class="btn" data-connection-action="refresh" data-id="${escapeHtml(connection.id)}" type="button">发现工具</button>` : ""}${!["discovering", "disconnecting"].includes(connection.status) ? `<button class="btn" data-connection-action="disconnect" data-id="${escapeHtml(connection.id)}" type="button">解绑</button>` : ""}</span>
      </div>`).join("")}</div>` : `<div class="integration-empty-state"><h3>暂无已连接应用</h3><p>从应用目录选择已开放的连接器。</p>${canConnect ? `<button class="btn primary" type="button" data-integration-open-catalog>浏览应用目录</button>` : ""}</div>`}`;
    if (!canConnect) all<HTMLElement>("[data-connection-action]", panel).forEach((button) => button.remove());
    all<HTMLButtonElement>("[data-integration-open-catalog]", panel).forEach((button) => button.addEventListener("click", () => showTab("catalog")));
    all<HTMLButtonElement>("[data-connection-action]", panel).forEach((button) => button.addEventListener("click", () => void connectionAction(button)));
  };

  const renderTools = () => {
    const panel = one<HTMLElement>('[data-integration-panel="permissions"]');
    if (!panel) return;
    const canReview = dependencies.hasPermission("integration.manage");
    const canExecute = dependencies.hasPermission("integration.execute");
    panel.innerHTML = `<div class="integration-workspace-head"><div><h2>工具与权限</h2><p>只有审核通过的稳定别名可被 Agent 调用。</p></div><span class="integration-workspace-state">${tools.filter((item) => item.status === "active").length} 项已启用</span></div>
      ${tools.length ? `<div class="integration-permission-list"><div class="integration-permission-row integration-tool-row integration-permission-head"><span>工具</span><span>连接</span><span>权限与用量</span><span>状态与操作</span></div>${tools.map((tool) => {
        let dailyCallLimit = 100;
        try { dailyCallLimit = Number((JSON.parse(tool.reviewJson || "{}") as Record<string, unknown>).dailyCallLimit || 100); } catch { dailyCallLimit = 100; }
        const today = usage.find((item) => item.toolSnapshotId === tool.id);
        return `<div class="integration-permission-row integration-tool-row">
        <span><b>${escapeHtml(tool.displayName || tool.remoteName)}</b><small>${escapeHtml(tool.stableAlias || tool.remoteName)}</small></span>
        <span>${escapeHtml(connectionName(tool.connectionId))}</span><span>R${tool.riskLevel} · ${escapeHtml(tool.permissionCode || "待配置")}<small>今日 ${today?.callCount || 0} / ${dailyCallLimit} 次 · 成功 ${today?.successCount || 0} · 失败 ${today?.failureCount || 0}</small></span>
        <span class="integration-tool-actions"><em class="integration-status ${statusTone(tool.status)}">${escapeHtml(toolStatus[tool.status] || tool.status)}</em>${canReview && tool.status === "pending_review" ? `<button class="btn" data-review-tool="${escapeHtml(tool.id)}" type="button">审核</button>` : ""}${canExecute && tool.status === "active" && tool.riskLevel === 0 ? `<button class="btn" data-test-tool="${escapeHtml(tool.id)}" type="button">测试</button>` : ""}</span>
      </div>`; }).join("")}</div>` : `<div class="integration-empty-state"><h3>尚未发现工具</h3><p>连接 MCP 服务后会自动读取工具清单。</p></div>`}`;
    all<HTMLButtonElement>("[data-review-tool]", panel).forEach((button) => button.addEventListener("click", () => openReview(button.dataset.reviewTool || "")));
    all<HTMLButtonElement>("[data-test-tool]", panel).forEach((button) => button.addEventListener("click", () => void testTool(button.dataset.testTool || "", button)));
  };

  const renderApprovals = () => {
    const panel = one<HTMLElement>('[data-integration-panel="approvals"]');
    if (!panel) return;
    const pendingTools = tools.filter((item) => item.status === "pending_review");
    const pendingExecutions = approvals.filter((item) => item.status === "pending");
    const canReview = dependencies.hasPermission("integration.manage");
    const canApprove = dependencies.hasPermission("integration.approval.act");
    panel.innerHTML = `<div class="integration-workspace-head"><div><h2>操作审批</h2><p>核对冻结参数、外部目标与数据范围。</p></div><span class="integration-workspace-state">${pendingExecutions.length + pendingTools.length} 项待处理</span></div>
      ${pendingExecutions.length ? `<div class="integration-permission-list">${pendingExecutions.map((approval) => {
        const egress = (approval.inputSummary.dataEgress || {}) as { fields?: Array<{ field: string; classification: string }> };
        const targetEntry = Object.entries(approval.frozenInput).find(([field]) => /recipient|email|phone|target|to|url/iu.test(field));
        const fields = (egress.fields || []).map((item) => `${item.field} · ${item.classification}`).join("、");
        const preview = Object.entries(approval.frozenInput).slice(0, 5).map(([field, value]) => `${field}: ${previewValue(value)}`).join("；");
        return `<div class="integration-permission-row integration-approval-row">
          <span><b>${escapeHtml(approval.tool.displayName || approval.tool.remoteName)}</b><small>${escapeHtml(approval.connectionName)} · R${approval.riskLevel}</small><small>${escapeHtml(preview)}</small></span>
          <span><b>外部目标</b><small>${escapeHtml(targetEntry ? previewValue(targetEntry[1]) : "按冻结参数执行")}</small></span>
          <span><b>发送数据</b><small>${escapeHtml(fields || Object.keys(approval.frozenInput).join("、"))}</small><small>有效至 ${escapeHtml(formatDate(approval.expiresAt))}</small></span>
          <span class="integration-row-actions">${canApprove ? `<button class="btn primary" data-approve-execution="${escapeHtml(approval.id)}" type="button">批准执行</button><button class="btn" data-reject-execution="${escapeHtml(approval.id)}" type="button">拒绝</button>` : "等待经理或管理员审批"}</span>
        </div>`;
      }).join("")}</div>` : `<div class="integration-empty-state"><h3>当前没有待审批操作</h3><p>需要人工确认的外部写入会出现在这里。</p></div>`}
      <div class="integration-workspace-head"><div><h2>工具审核</h2><p>确认风险等级、字段范围与允许角色后再启用。</p></div><span class="integration-workspace-state">${pendingTools.length} 项待审核</span></div>
      ${pendingTools.length ? `<div class="integration-permission-list">${pendingTools.map((tool) => `<div class="integration-permission-row integration-approval-row"><span><b>${escapeHtml(tool.displayName || tool.remoteName)}</b><small>${escapeHtml(tool.description)}</small></span><span>${escapeHtml(connectionName(tool.connectionId))}</span><span>Schema ${escapeHtml(tool.schemaHash.slice(0, 10))}</span><span class="integration-row-actions">${canReview ? `<button class="btn primary" data-review-tool="${escapeHtml(tool.id)}" type="button">审核</button><button class="btn" data-reject-tool="${escapeHtml(tool.id)}" type="button">拒绝</button>` : "等待管理员审核"}</span></div>`).join("")}</div>` : ""}`;
    all<HTMLButtonElement>("[data-review-tool]", panel).forEach((button) => button.addEventListener("click", () => openReview(button.dataset.reviewTool || "")));
    all<HTMLButtonElement>("[data-reject-tool]", panel).forEach((button) => button.addEventListener("click", () => void rejectTool(button.dataset.rejectTool || "")));
    all<HTMLButtonElement>("[data-approve-execution]", panel).forEach((button) => button.addEventListener("click", () => void approveExecution(button.dataset.approveExecution || "", button)));
    all<HTMLButtonElement>("[data-reject-execution]", panel).forEach((button) => button.addEventListener("click", () => void rejectExecution(button.dataset.rejectExecution || "")));
  };

  const renderConnectorReviews = () => {
    const panel = one<HTMLElement>('[data-integration-panel="connector-reviews"]');
    if (!panel) return;
    const canManage = dependencies.hasPermission("integration.manage");
    const canPlatformReview = dependencies.hasPermission("platform.integration.connector.review");
    if (!canManage && !canPlatformReview) return;
    const pending = connectorReviews.filter((item) => item.status === "pending");
    panel.innerHTML = `<div class="integration-workspace-head"><div><h2>连接器审核</h2><p>${canPlatformReview ? "核对私有 MCP 端点、认证方式和 Manifest 指纹。" : "查看本团队提交记录与平台审核结果。"}</p></div><span class="integration-workspace-state">${pending.length} 项待处理</span></div>
      ${connectorReviews.length ? `<div class="integration-permission-list"><div class="integration-permission-row integration-connector-review-row integration-permission-head"><span>连接器</span><span>端点</span><span>认证与工具</span><span>状态</span><span>操作</span></div>${connectorReviews.map((review) => {
        const manifest = review.connector.manifest;
        const note = review.reviewNote ? `<small>意见：${escapeHtml(review.reviewNote)}</small>` : "";
        return `<div class="integration-permission-row integration-connector-review-row">
          <span><b>${escapeHtml(review.connector.name)}</b><small>${escapeHtml(review.connector.code)} · ${escapeHtml(review.connector.version)} · 团队 ${escapeHtml(review.teamId)}</small><small>提交人 ${escapeHtml(review.submittedBy)} · ${escapeHtml(formatDate(review.createdAt))}</small></span>
          <span><b>${escapeHtml(new URL(manifest.endpoint).hostname)}</b><code title="${escapeHtml(manifest.endpoint)}">${escapeHtml(manifest.endpoint)}</code><small>指纹 ${escapeHtml(review.manifestHash.slice(0, 14))}</small></span>
          <span>${manifest.authentication === "oauth2" ? "OAuth 2.0" : "无需认证"}<small>上限 ${manifest.maxTools || 200} 个工具</small>${manifest.oauth?.clientSecretEnv ? `<small>密钥引用 ${escapeHtml(manifest.oauth.clientSecretEnv)}</small>` : ""}</span>
          <em class="integration-status ${statusTone(review.status)}">${escapeHtml(connectorReviewStatus[review.status] || review.status)}</em>
          <span class="integration-row-actions">${canPlatformReview && review.status === "pending" ? `<button class="btn primary" type="button" data-approve-connector="${escapeHtml(review.connectorId)}">通过</button><button class="btn" type="button" data-reject-connector="${escapeHtml(review.connectorId)}">驳回</button>` : note || "-"}</span>
        </div>`;
      }).join("")}</div>` : `<div class="integration-empty-state"><h3>暂无连接器审核记录</h3><p>团队提交私有连接器后会显示在这里。</p></div>`}`;
    all<HTMLButtonElement>("[data-approve-connector]", panel).forEach((button) => button.addEventListener("click", () => void reviewConnector(button.dataset.approveConnector || "", "approved")));
    all<HTMLButtonElement>("[data-reject-connector]", panel).forEach((button) => button.addEventListener("click", () => void reviewConnector(button.dataset.rejectConnector || "", "rejected")));
  };

  const renderCalls = () => {
    const panel = one<HTMLElement>('[data-integration-panel="activity"]');
    if (!panel) return;
    const canReconcile = dependencies.hasPermission("integration.manage");
    panel.innerHTML = `<div class="integration-workspace-head"><div><h2>运行记录</h2><p>记录调用人、工具、结果和外部来源凭据。</p></div><span class="integration-workspace-state">最近 ${calls.length} 条</span></div>
      ${calls.length ? `<div class="integration-permission-list"><div class="integration-permission-row integration-call-row integration-permission-head"><span>时间</span><span>工具</span><span>调用人</span><span>结果</span><span>来源</span></div>${calls.map((call) => {
        const tool = tools.find((item) => item.id === call.toolSnapshotId);
        return `<div class="integration-permission-row integration-call-row"><span>${escapeHtml(formatDate(call.createdAt))}</span><span><b>${escapeHtml(tool?.displayName || tool?.stableAlias || call.toolSnapshotId)}</b><small>${escapeHtml(call.requestId)}</small></span><span>${escapeHtml(call.actorId)}</span><em class="integration-status ${statusTone(call.status)}" title="${escapeHtml(call.errorMessage)}">${escapeHtml(callStatus[call.status] || call.status)}</em><span class="integration-row-actions" title="${escapeHtml(call.externalReceipt)}">${escapeHtml(call.externalReceipt || "-")}${canReconcile && ["unknown_outcome", "reconciliation_required"].includes(call.status) ? `<button class="btn" data-reconcile-call="${escapeHtml(call.id)}" type="button">人工对账</button>` : ""}</span></div>`;
      }).join("")}</div>` : `<div class="integration-empty-state"><h3>暂无运行记录</h3><p>审核通过的只读工具执行后会留下审计证据。</p></div>`}`;
    all<HTMLButtonElement>("[data-reconcile-call]", panel).forEach((button) => button.addEventListener("click", () => openReconciliation(button.dataset.reconcileCall || "")));
  };

  const renderEvents = () => {
    const panel = one<HTMLElement>('[data-integration-panel="events"]');
    if (!panel) return;
    const canReplay = dependencies.hasPermission("integration.execute");
    panel.innerHTML = `<div class="integration-workspace-head"><div><h2>事件与死信</h2><p>查看外部通知的验签、去重、处理和失败状态。</p></div><span class="integration-workspace-state">最近 ${events.length} 条</span></div>
      ${events.length ? `<div class="integration-permission-list"><div class="integration-permission-row integration-event-row integration-permission-head"><span>接收时间</span><span>事件</span><span>连接</span><span>状态</span><span>业务结果</span></div>${events.map((event) => `<div class="integration-permission-row integration-event-row"><span>${escapeHtml(formatDate(event.receivedAt))}</span><span><b>${escapeHtml(event.eventType)}</b><small>${escapeHtml(event.externalEventId)}</small></span><span>${escapeHtml(connectionName(event.connectionId))}</span><em class="integration-status ${statusTone(event.status)}" title="${escapeHtml(event.errorMessage)}">${escapeHtml(eventStatus[event.status] || event.status)} · ${event.attemptCount} 次</em><span class="integration-row-actions">${event.status === "dead_letter" && canReplay ? `<button class="btn" data-replay-event="${escapeHtml(event.id)}" type="button">回放</button>` : event.writebackStatus === "needs_match" && canReplay ? `<button class="btn primary" data-link-event-customer="${escapeHtml(event.id)}" type="button">关联客户</button>` : escapeHtml(eventWritebackStatus[event.writebackStatus] || event.errorCode || "-")}</span></div>`).join("")}</div>` : `<div class="integration-empty-state"><h3>暂无外部事件</h3><p>配置连接器订阅后，外部通知会在这里留下处理证据。</p></div>`}`;
    all<HTMLButtonElement>("[data-replay-event]", panel).forEach((button) => button.addEventListener("click", async () => {
      const eventId = button.dataset.replayEvent || "";
      button.disabled = true;
      try {
        await client.replayEvent(eventId);
        dependencies.toast("事件已重新放回队列", "success");
        await refresh(true);
      } catch (error) {
        button.disabled = false;
        dependencies.toast(error instanceof Error ? error.message : "事件回放失败", "error");
      }
    }));
    all<HTMLButtonElement>("[data-link-event-customer]", panel).forEach((button) => button.addEventListener("click", () => {
      void openEventCustomerLink(button.dataset.linkEventCustomer || "", button);
    }));
  };

  const wecomConnectionName = (connectionId: string) => connectionName(connectionId);

  const openWecomEndpointForm = () => {
    if (!canManageWecom()) return;
    const availableConnections = wecomConnectorConnections();
    if (!availableConnections.length) {
      dependencies.toast("请先在应用目录连接企业微信官方连接器", "info");
      showTab("catalog");
      return;
    }
    const existing = wecomEndpoints.find((endpoint) => endpoint.status === "active");
    dependencies.openModal("配置企业微信指令回调", `<div class="form-grid integration-wecom-form">
      <p class="hint full">企业微信后台的 Token 和 EncodingAESKey 只提交到服务端加密保存，保存后不会再次显示。</p>
      <label>企业微信连接<select id="integrationWecomConnection">${availableConnections.map((connection) => `<option value="${escapeHtml(connection.id)}" ${connection.id === existing?.connectionId ? "selected" : ""}>${escapeHtml(connection.displayName)} · ${escapeHtml(connectionStatus[connection.status] || connection.status)}</option>`).join("")}</select></label>
      <label>CorpID<input id="integrationWecomCorpId" maxlength="100" autocomplete="off" value="${escapeHtml(existing?.corpId || "")}" placeholder="例如：wwxxxxxxxxxxxxxxxx"></label>
      <label>Token<input id="integrationWecomToken" type="password" maxlength="128" autocomplete="new-password" required placeholder="粘贴企业微信回调 Token"></label>
      <label>EncodingAESKey<input id="integrationWecomAesKey" type="password" maxlength="43" minlength="43" autocomplete="new-password" required placeholder="43 位字符"></label>
      <p class="hint full">配置完成后，将回调地址复制到企业微信应用的“接收消息”配置中，并完成 URL 验证。</p>
    </div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationWecomEndpointConfirm" type="button">保存并启用</button>`);
    one<HTMLButtonElement>("#integrationWecomEndpointConfirm", document)?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const corpId = one<HTMLInputElement>("#integrationWecomCorpId", document)?.value.trim() || "";
      const callbackToken = one<HTMLInputElement>("#integrationWecomToken", document)?.value.trim() || "";
      const encodingAesKey = one<HTMLInputElement>("#integrationWecomAesKey", document)?.value.trim() || "";
      if (!/^[A-Za-z0-9_-]{3,100}$/u.test(corpId)) { dependencies.toast("CorpID 格式不正确", "error"); return; }
      if (!callbackToken || callbackToken.length > 128) { dependencies.toast("请填写有效的 Token", "error"); return; }
      if (!/^[A-Za-z0-9]{43}$/u.test(encodingAesKey)) { dependencies.toast("EncodingAESKey 必须是 43 位字符", "error"); return; }
      button.disabled = true;
      try {
        await client.createWecomEndpoint({
          connectionId: one<HTMLSelectElement>("#integrationWecomConnection", document)?.value || "",
          corpId,
          callbackToken,
          encodingAesKey
        });
        dependencies.closeModal();
        dependencies.toast("企业微信回调已启用", "success");
        await refresh(true);
      } catch (error) {
        button.disabled = false;
        dependencies.toast(error instanceof Error ? error.message : "企业微信回调配置失败", "error");
      }
    });
  };

  const openWecomBindingForm = () => {
    if (!canManageWecom()) return;
    const endpoints = wecomEndpoints.filter((endpoint) => endpoint.status === "active");
    if (!endpoints.length) {
      dependencies.toast("请先启用企业微信指令回调", "info");
      return;
    }
    const activeAccounts = accounts.filter((account) => account.status !== "disabled");
    if (!activeAccounts.length) {
      dependencies.toast("当前团队没有可绑定的 CRM 成员", "info");
      return;
    }
    dependencies.openModal("绑定企业微信成员", `<div class="form-grid integration-wecom-form">
      <p class="hint full">绑定后，企业微信成员只能通过 CRM 查询自己的待办、客户和商机。写入指令仍需回到 Agent 或审批中心确认。</p>
      <label>企业微信回调<select id="integrationWecomBindingEndpoint">${endpoints.map((endpoint) => `<option value="${escapeHtml(endpoint.connectionId)}">${escapeHtml(wecomConnectionName(endpoint.connectionId))} · ${escapeHtml(endpoint.corpId)}</option>`).join("")}</select></label>
      <label>CRM 成员<select id="integrationWecomBindingCrmUser">${activeAccounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} · ${escapeHtml(account.email)}</option>`).join("")}</select></label>
      <label class="full">企业微信 UserID<input id="integrationWecomBindingUserId" maxlength="128" autocomplete="off" placeholder="企业微信成员资料中的 UserID" required></label>
      <p class="hint full">UserID 区分大小写，请从企业微信通讯录或成员详情中复制，不要填写姓名。</p>
    </div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationWecomBindingConfirm" type="button">保存绑定</button>`);
    one<HTMLButtonElement>("#integrationWecomBindingConfirm", document)?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const wecomUserId = one<HTMLInputElement>("#integrationWecomBindingUserId", document)?.value.trim() || "";
      if (!wecomUserId) { dependencies.toast("请填写企业微信 UserID", "error"); return; }
      button.disabled = true;
      try {
        await client.createWecomBinding({
          connectionId: one<HTMLSelectElement>("#integrationWecomBindingEndpoint", document)?.value || "",
          wecomUserId,
          crmUserId: one<HTMLSelectElement>("#integrationWecomBindingCrmUser", document)?.value || ""
        });
        dependencies.closeModal();
        dependencies.toast("企业微信成员已绑定", "success");
        await refresh(true);
      } catch (error) {
        button.disabled = false;
        dependencies.toast(error instanceof Error ? error.message : "成员绑定失败", "error");
      }
    });
  };

  const disableWecomEndpoint = async (endpointId: string) => {
    if (!endpointId || !canManageWecom()) return;
    if (!await confirmAction("停用企业微信回调", "停用后企业微信将无法继续向 CRM 发送指令，已有绑定不会被删除。")) return;
    try {
      await client.disableWecomEndpoint(endpointId);
      dependencies.toast("企业微信回调已停用", "success");
      await refresh(true);
    } catch (error) {
      dependencies.toast(error instanceof Error ? error.message : "停用回调失败", "error");
    }
  };

  const revokeWecomBinding = async (bindingId: string) => {
    if (!bindingId || !canManageWecom()) return;
    if (!await confirmAction("撤销成员绑定", "撤销后该企业微信成员将不能查询 CRM 数据。")) return;
    try {
      await client.revokeWecomBinding(bindingId);
      dependencies.toast("成员绑定已撤销", "success");
      await refresh(true);
    } catch (error) {
      dependencies.toast(error instanceof Error ? error.message : "撤销绑定失败", "error");
    }
  };

  const copyWecomCallback = async (endpoint: WecomCommandEndpoint) => {
    const value = endpoint.callbackUrl || endpoint.callbackPath;
    try {
      await navigator.clipboard.writeText(value);
      dependencies.toast("回调地址已复制", "success");
    } catch {
      dependencies.toast(value, "info");
    }
  };

  const renderWecomCommands = () => {
    const panel = one<HTMLElement>('[data-integration-panel="wecom-commands"]');
    if (!panel) return;
    const tab = one<HTMLElement>('[data-integration-tab="wecom-commands"]');
    const activeEndpoints = wecomEndpoints.filter((endpoint) => endpoint.status === "active");
    if (tab) {
      const badge = tab.querySelector("span");
      if (badge) badge.textContent = String(activeEndpoints.length);
    }
    if (!canManageWecom()) {
      const selfBinding = wecomBindings.find((binding) => binding.status === "active");
      panel.innerHTML = `<div class="integration-empty-state integration-wecom-readonly"><span class="integration-empty-icon"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/></svg></span><h3>企业微信指令由管理员配置</h3><p>当前账号没有回调和成员绑定管理权限。企业微信查询仍按 CRM 当前账号与团队边界隔离，写入操作必须经过 Agent 或审批中心确认。</p><div class="integration-wecom-binding-status ${selfBinding ? "is-active" : ""}"><i></i>${selfBinding ? "当前账号已绑定企业微信" : "当前账号尚未绑定企业微信"}</div></div>`;
      return;
    }
    const wecomConnections = wecomConnectorConnections();
    const connectionIds = new Set(wecomConnections.map((connection) => connection.id));
    const visibleBindings = wecomBindings.filter((binding) => connectionIds.has(binding.connectionId));
    panel.innerHTML = `<div class="integration-workspace-head integration-wecom-head"><div><h2>企业微信指令</h2><p>让团队成员从企业微信查询 CRM；所有写入动作保留 Agent 待确认边界。</p></div><div class="integration-workspace-head-actions"><span class="integration-workspace-state">${activeEndpoints.length ? "回调已启用" : "尚未启用"}</span><button class="btn" type="button" data-wecom-refresh>刷新</button><button class="btn primary" type="button" data-wecom-configure>配置回调</button></div></div>
      <div class="integration-wecom-summary"><div><span>官方连接</span><strong>${wecomConnections.length}</strong><small>仅显示企业微信官方连接器</small></div><div><span>已启用回调</span><strong>${activeEndpoints.length}</strong><small>企业微信服务器可访问</small></div><div><span>有效绑定</span><strong>${visibleBindings.filter((binding) => binding.status === "active").length}</strong><small>按企业微信 UserID 唯一绑定</small></div><div><span>安全边界</span><strong>只读</strong><small>写入进入 Agent 确认</small></div></div>
      ${wecomConnections.length ? `<section class="integration-wecom-section"><header><div><h3>回调地址</h3><p>把地址填入企业微信自建应用的接收消息配置。</p></div><button class="btn" type="button" data-wecom-configure>新增或更新</button></header>${activeEndpoints.length ? activeEndpoints.map((endpoint) => `<div class="integration-wecom-endpoint"><div class="integration-wecom-endpoint-mark">企</div><div class="integration-wecom-endpoint-main"><b>${escapeHtml(wecomConnectionName(endpoint.connectionId))}</b><small>CorpID ${escapeHtml(endpoint.corpId)} · 已验签加密 · ${escapeHtml(formatDate(endpoint.updatedAt))} 更新</small><code title="${escapeHtml(endpoint.callbackUrl || endpoint.callbackPath)}">${escapeHtml(endpoint.callbackUrl || endpoint.callbackPath)}</code></div><div class="integration-row-actions"><button class="btn" type="button" data-wecom-copy="${escapeHtml(endpoint.id)}">复制地址</button><button class="btn" type="button" data-wecom-disable="${escapeHtml(endpoint.id)}">停用</button></div></div>`).join("") : `<div class="integration-wecom-inline-empty"><b>还没有启用回调</b><span>配置 CorpID、Token 和 EncodingAESKey 后生成地址。</span></div>`}</section>` : `<section class="integration-wecom-section"><div class="integration-wecom-inline-empty"><b>先连接企业微信官方连接器</b><span>在应用目录中完成企业微信连接后，才能配置指令回调。</span><button class="btn primary" type="button" data-integration-open-catalog>浏览应用目录</button></div></section>`}
      <section class="integration-wecom-section"><header><div><h3>成员绑定</h3><p>一个企业微信 UserID 只能绑定一个 CRM 成员，撤销后立即失效。</p></div><button class="btn primary" type="button" data-wecom-bind ${activeEndpoints.length ? "" : "disabled"}>绑定成员</button></header>${visibleBindings.length ? `<div class="integration-permission-list integration-wecom-binding-list"><div class="integration-permission-row integration-wecom-binding-row integration-permission-head"><span>CRM 成员</span><span>企业微信 UserID</span><span>连接与验证</span><span>状态与操作</span></div>${visibleBindings.map((binding) => `<div class="integration-permission-row integration-wecom-binding-row"><span><b>${escapeHtml(binding.crmUserName || binding.crmUserId)}</b><small>${escapeHtml(accounts.find((account) => account.id === binding.crmUserId)?.email || binding.crmUserId)}</small></span><span><code>${escapeHtml(binding.wecomUserId)}</code></span><span><small>${escapeHtml(wecomConnectionName(binding.connectionId))}</small><small>验证于 ${escapeHtml(formatDate(binding.verifiedAt))}</small></span><span class="integration-row-actions"><em class="integration-status ${binding.status === "active" ? "is-active" : ""}">${binding.status === "active" ? "已生效" : "已撤销"}</em>${binding.status === "active" ? `<button class="btn" type="button" data-wecom-revoke="${escapeHtml(binding.id)}">撤销</button>` : ""}</span></div>`).join("")}</div>` : `<div class="integration-wecom-inline-empty"><b>暂无成员绑定</b><span>完成回调配置后，绑定企业微信 UserID 与 CRM 成员。</span></div>`}</section>`;
    all<HTMLButtonElement>("[data-wecom-configure]", panel).forEach((button) => button.addEventListener("click", openWecomEndpointForm));
    all<HTMLButtonElement>("[data-wecom-bind]", panel).forEach((button) => button.addEventListener("click", openWecomBindingForm));
    all<HTMLButtonElement>("[data-wecom-refresh]", panel).forEach((button) => button.addEventListener("click", () => void refresh(false)));
    all<HTMLButtonElement>("[data-wecom-disable]", panel).forEach((button) => button.addEventListener("click", () => void disableWecomEndpoint(button.dataset.wecomDisable || "")));
    all<HTMLButtonElement>("[data-wecom-revoke]", panel).forEach((button) => button.addEventListener("click", () => void revokeWecomBinding(button.dataset.wecomRevoke || "")));
    all<HTMLButtonElement>("[data-wecom-copy]", panel).forEach((button) => button.addEventListener("click", () => {
      const endpoint = wecomEndpoints.find((item) => item.id === button.dataset.wecomCopy);
      if (endpoint) void copyWecomCallback(endpoint);
    }));
    all<HTMLButtonElement>("[data-integration-open-catalog]", panel).forEach((button) => button.addEventListener("click", () => showTab("catalog")));
  };

  const workspaceConfig = () => workspaceProvider === "google"
    ? { connectorCode: "google-workspace", name: "Google Workspace", meeting: "Google Meet" }
    : { connectorCode: "microsoft-365", name: "Microsoft 365", meeting: "Teams" };

  const workspaceReady = () => {
    const connector = catalog.find((item) => item.code === workspaceConfig().connectorCode);
    if (!connector) return false;
    const activeConnections = new Set(connections.filter((item) => item.connectorId === connector.id && item.status === "active").map((item) => item.id));
    const required = new Set(["mail.search_messages", "mail.get_message", "mail.send_message", "calendar.create_event"]);
    return [...required].every((remoteName) => tools.some((tool) => activeConnections.has(tool.connectionId) && tool.remoteName === remoteName && tool.status === "active"));
  };

  const mailSender = (message: WorkspaceMailMessage) => {
    const address = message.sender?.emailAddress || message.from?.emailAddress || {};
    return { name: address.name || address.address || "未知发件人", email: address.address || "" };
  };

  const renderWorkspaceMessages = () => {
    const panel = one<HTMLElement>("#integrationWorkspaceResults");
    const state = one<HTMLElement>("#integrationWorkspaceState");
    const searchButton = one<HTMLButtonElement>("#integrationWorkspaceSearchButton");
    const config = workspaceConfig();
    const ready = workspaceReady();
    const title = one<HTMLElement>("#integrationWorkspaceTitle");
    if (title) title.textContent = config.name;
    all<HTMLButtonElement>("[data-integration-workspace-provider]").forEach((button) => {
      const active = button.dataset.integrationWorkspaceProvider === workspaceProvider;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    if (state) state.textContent = ready ? "连接可用" : "等待个人连接";
    if (searchButton) searchButton.disabled = !ready;
    if (!panel) return;
    if (!ready) {
      panel.innerHTML = `<div class="integration-empty-state"><h3>${escapeHtml(config.name)} 尚未就绪</h3><button class="btn primary" type="button" data-integration-open-catalog>前往连接</button></div>`;
      one<HTMLButtonElement>("[data-integration-open-catalog]", panel)?.addEventListener("click", () => showTab("catalog"));
      return;
    }
    if (!workspaceMessages.length) {
      panel.innerHTML = `<div class="integration-empty-state"><h3>暂无邮件结果</h3></div>`;
      return;
    }
    panel.innerHTML = workspaceMessages.map((message) => {
      const sender = mailSender(message);
      const match = message.crmMatch;
      const company = match.customer?.company || (match.status === "ambiguous" ? match.candidates.map((item) => item.company).slice(0, 2).join(" / ") : "未匹配客户");
      const matchLabel = match.status === "matched" ? company : match.status === "ambiguous" ? `待确认：${company}` : "未匹配客户";
      const date = formatDate(message.receivedAt);
      return `<article class="integration-mail-row">
        <span class="integration-mail-avatar">${escapeHtml((sender.name || sender.email || "?").slice(0, 1).toUpperCase())}</span>
        <div class="integration-mail-party"><b>${escapeHtml(sender.name)}</b><small>${escapeHtml(sender.email || date)}</small></div>
        <div class="integration-mail-main"><b>${escapeHtml(message.subject || "(无主题)")}</b><p>${escapeHtml(message.bodyPreview || "")}</p></div>
        <div class="integration-mail-match"><em class="${match.status === "matched" ? "is-matched" : match.status === "ambiguous" ? "is-ambiguous" : ""}">${escapeHtml(matchLabel)}</em><small>${escapeHtml(date)}</small></div>
        <div class="integration-mail-actions">${match.customer ? `<button class="btn" type="button" data-workspace-reply="${escapeHtml(message.id)}">回复</button><button class="btn" type="button" data-workspace-meeting="${escapeHtml(message.id)}">约会议</button>` : ""}</div>
      </article>`;
    }).join("");
    all<HTMLButtonElement>("[data-workspace-reply]", panel).forEach((button) => button.addEventListener("click", () => void openWorkspaceReply(button.dataset.workspaceReply || "")));
    all<HTMLButtonElement>("[data-workspace-meeting]", panel).forEach((button) => button.addEventListener("click", () => openWorkspaceMeeting(button.dataset.workspaceMeeting || "")));
  };

  const searchWorkspaceMail = async () => {
    const panel = one<HTMLElement>("#integrationWorkspaceResults");
    const button = one<HTMLButtonElement>("#integrationWorkspaceSearchButton");
    if (!panel || !button || !workspaceReady()) return;
    button.disabled = true;
    panel.innerHTML = `<div class="integration-mail-skeleton"></div><div class="integration-mail-skeleton"></div><div class="integration-mail-skeleton"></div>`;
    try {
      const searchInput = {
        query: one<HTMLInputElement>("#integrationWorkspaceSearch")?.value.trim() || "",
        folder: (one<HTMLSelectElement>("#integrationWorkspaceFolder")?.value || "inbox") as "inbox" | "sentitems" | "drafts",
        pageSize: 25
      };
      const response = workspaceProvider === "google"
        ? await client.searchGoogleMail(searchInput)
        : await client.searchMicrosoftMail({ ...searchInput, offset: 0 });
      workspaceMessages = response.messages || [];
      renderWorkspaceMessages();
    } catch (error) {
      panel.innerHTML = `<div class="integration-empty-state"><h3>邮件读取失败</h3><p>${escapeHtml(error instanceof Error ? error.message : "请稍后重试")}</p></div>`;
      dependencies.toast(error instanceof Error ? error.message : "邮件读取失败", "error");
    } finally {
      button.disabled = !workspaceReady();
    }
  };

  const messageById = (messageId: string) => workspaceMessages.find((message) => message.id === messageId);

  async function openWorkspaceReply(messageId: string) {
    const message = messageById(messageId);
    const customer = message?.crmMatch.customer;
    if (!message || !customer) return;
    const sender = mailSender(message);
    let quoted = "";
    try {
      const detail = await (workspaceProvider === "google" ? client.googleMessage(messageId) : client.microsoftMessage(messageId)) as { result?: { structuredContent?: { message?: { body?: { content?: string } } } } };
      quoted = String(detail.result?.structuredContent?.message?.body?.content || "").slice(0, 1200);
    } catch {
      quoted = message.bodyPreview || "";
    }
    const subject = /^re:/iu.test(message.subject || "") ? message.subject : `Re: ${message.subject || "Inquiry"}`;
    dependencies.openModal("回复客户邮件", `<div class="form-grid">
      <label>客户<input value="${escapeHtml(customer.company)}" disabled></label>
      <label>收件人<input id="integrationMailTo" type="email" value="${escapeHtml(sender.email)}"></label>
      <label>主题<input id="integrationMailSubject" maxlength="255" value="${escapeHtml(subject)}"></label>
      <label>正文<textarea id="integrationMailBody" rows="10" maxlength="50000">\n\n${escapeHtml(quoted ? `----- Original message -----\n${quoted}` : "")}</textarea></label>
      <label>下次跟进<input id="integrationMailFollowAt" type="datetime-local"></label>
    </div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationMailSendConfirm" type="button">提交审批</button>`);
    one<HTMLButtonElement>("#integrationMailSendConfirm", document)?.addEventListener("click", async (event) => {
      const action = event.currentTarget as HTMLButtonElement;
      const to = one<HTMLInputElement>("#integrationMailTo", document)?.value.trim() || "";
      const body = one<HTMLTextAreaElement>("#integrationMailBody", document)?.value.trim() || "";
      if (!to || !body) { dependencies.toast("请填写收件人和正文", "error"); return; }
      action.disabled = true;
      try {
        const mailInput = {
          customerId: customer.customerId,
          to: [to],
          subject: one<HTMLInputElement>("#integrationMailSubject", document)?.value.trim() || subject,
          body,
          conversationId: message.conversationId || "",
          nextFollowAt: one<HTMLInputElement>("#integrationMailFollowAt", document)?.value || ""
        };
        if (workspaceProvider === "google") await client.sendGoogleMail({ ...mailInput, inReplyTo: message.internetMessageId || "" });
        else await client.sendMicrosoftMail(mailInput);
        dependencies.closeModal();
        dependencies.toast("邮件参数已冻结，等待审批", "success");
        await refresh(true);
        showTab("approvals");
      } catch (error) {
        action.disabled = false;
        dependencies.toast(error instanceof Error ? error.message : "邮件提交失败", "error");
      }
    });
  }

  function openWorkspaceMeeting(messageId: string) {
    const message = messageById(messageId);
    const customer = message?.crmMatch.customer;
    if (!message || !customer) return;
    const sender = mailSender(message);
    const start = new Date(Date.now() + 24 * 60 * 60_000);
    start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    const localValue = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    dependencies.openModal("安排客户会议", `<div class="form-grid">
      <label>客户<input value="${escapeHtml(customer.company)}" disabled></label>
      <label>参与人<input id="integrationMeetingAttendee" type="email" value="${escapeHtml(sender.email)}"></label>
      <label>主题<input id="integrationMeetingSubject" maxlength="255" value="${escapeHtml(`Meeting with ${customer.company}`)}"></label>
      <label>开始时间<input id="integrationMeetingStart" type="datetime-local" value="${localValue(start)}"></label>
      <label>结束时间<input id="integrationMeetingEnd" type="datetime-local" value="${localValue(end)}"></label>
      <label>时区<input id="integrationMeetingTimezone" value="${escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}"></label>
      <label><input id="integrationMeetingOnline" type="checkbox" checked> ${escapeHtml(workspaceConfig().meeting)} 在线会议</label>
      <label>下次跟进<input id="integrationMeetingFollowAt" type="datetime-local"></label>
    </div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationMeetingConfirm" type="button">提交审批</button>`);
    one<HTMLButtonElement>("#integrationMeetingConfirm", document)?.addEventListener("click", async (event) => {
      const action = event.currentTarget as HTMLButtonElement;
      const startValue = one<HTMLInputElement>("#integrationMeetingStart", document)?.value || "";
      const endValue = one<HTMLInputElement>("#integrationMeetingEnd", document)?.value || "";
      if (!startValue || !endValue || new Date(endValue).getTime() <= new Date(startValue).getTime()) { dependencies.toast("会议结束时间必须晚于开始时间", "error"); return; }
      action.disabled = true;
      try {
        const meetingInput = {
          customerId: customer.customerId,
          subject: one<HTMLInputElement>("#integrationMeetingSubject", document)?.value.trim() || `Meeting with ${customer.company}`,
          startUtc: new Date(startValue).toISOString(),
          endUtc: new Date(endValue).toISOString(),
          timeZone: one<HTMLInputElement>("#integrationMeetingTimezone", document)?.value.trim() || "UTC",
          attendees: [one<HTMLInputElement>("#integrationMeetingAttendee", document)?.value.trim() || sender.email],
          onlineMeeting: one<HTMLInputElement>("#integrationMeetingOnline", document)?.checked !== false,
          nextFollowAt: one<HTMLInputElement>("#integrationMeetingFollowAt", document)?.value || ""
        };
        if (workspaceProvider === "google") await client.createGoogleEvent(meetingInput);
        else await client.createMicrosoftEvent(meetingInput);
        dependencies.closeModal();
        dependencies.toast("会议参数已冻结，等待审批", "success");
        await refresh(true);
        showTab("approvals");
      } catch (error) {
        action.disabled = false;
        dependencies.toast(error instanceof Error ? error.message : "会议提交失败", "error");
      }
    });
  }

  const renderAll = () => {
    renderOverview();
    renderCatalog();
    renderConnections();
    renderTools();
    renderApprovals();
    renderConnectorReviews();
    renderCalls();
    renderEvents();
    renderWecomCommands();
    renderWorkspaceMessages();
  };

  const refresh = async (silent = false) => {
    if (loading) return loading;
    syncCapabilityUi();
    setHealth("正在同步集成状态", "loading");
    void localRunnerCenter.refresh(true);
    loading = (async () => {
      try {
        if (platformReviewOnly) {
          connectorReviews = await client.connectorReviews();
          catalog = []; connections = []; tools = []; calls = []; approvals = []; events = []; usage = [];
          renderAll();
          showTab("connector-reviews");
          setHealth("平台连接器审核已连接", "active");
          return;
        }
        const canManageConnectors = dependencies.hasPermission("integration.manage");
        const canReviewConnectors = canManageConnectors || dependencies.hasPermission("platform.integration.connector.review");
        const wecomRequests = canManageWecom()
          ? [client.wecomEndpoints(), client.wecomBindings(), client.accounts()] as const
          : [Promise.resolve({ endpoints: [] as WecomCommandEndpoint[] }), client.wecomBindings(), Promise.resolve({ accounts: [] as IntegrationAccount[] })] as const;
        const [catalogResult, connectionsResult, toolsResult, callsResult, approvalsResult, eventsResult, usageResult, connectorReviewsResult, wecomEndpointsResult, wecomBindingsResult, accountsResult] = await Promise.all([
          client.catalog(), client.connections(), client.tools(), client.calls(), client.approvals(), client.events(), client.usage(),
          canReviewConnectors ? client.connectorReviews() : Promise.resolve([]),
          ...wecomRequests
        ]);
        catalog = catalogResult;
        connections = connectionsResult;
        tools = toolsResult;
        calls = callsResult;
        approvals = approvalsResult;
        events = eventsResult;
        usage = usageResult;
        connectorReviews = connectorReviewsResult;
        wecomEndpoints = wecomEndpointsResult.endpoints;
        wecomBindings = wecomBindingsResult.bindings;
        accounts = accountsResult.accounts;
        renderAll();
        setHealth("集成服务已连接", "active");
      } catch (error) {
        setHealth("集成服务未启用", "error");
        if (!silent) dependencies.toast(error instanceof Error ? error.message : "集成数据加载失败", "error");
      } finally {
        loading = null;
      }
    })();
    return loading;
  };

  const scheduleRefresh = () => {
    window.clearTimeout(settleTimer);
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      await refresh(true);
      if (attempts < 5 && connections.some((item) => ["discovering", "authorizing", "pending_confirmation"].includes(item.status))) {
        settleTimer = window.setTimeout(() => void poll(), 2500);
      }
    };
    settleTimer = window.setTimeout(() => void poll(), 1500);
  };

  const openEventCustomerLink = async (eventId: string, sourceButton: HTMLButtonElement) => {
    if (!eventId) return;
    sourceButton.disabled = true;
    try {
      const customerScopes = dependencies.permissionScopes("customer.read");
      const scope = customerScopes.some((item) => ["org_unit", "org_subtree", "tenant"].includes(item)) ? "team" : "mine";
      const result = await dependencies.request<{ customers: LinkableCustomer[] }>(`/api/customers?scope=${scope}`);
      const customers = result.customers || [];
      if (!customers.length) {
        dependencies.toast("当前范围内没有可关联客户", "warn");
        return;
      }
      dependencies.openModal("关联邮件客户", `<div class="form-grid">
        <label>CRM 客户<select id="integrationEventCustomerSelect">${customers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.company)}${customer.contact ? ` · ${escapeHtml(customer.contact)}` : ""}${customer.ownerName ? ` · ${escapeHtml(customer.ownerName)}` : ""}</option>`).join("")}</select></label>
        <p class="hint">确认后，这封邮件会写入所选客户的跟进记录。</p>
      </div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationEventCustomerConfirm" type="button">确认关联</button>`);
      one<HTMLButtonElement>("#integrationEventCustomerConfirm", document)?.addEventListener("click", async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        const customerId = one<HTMLSelectElement>("#integrationEventCustomerSelect", document)?.value || "";
        if (!customerId) return;
        button.disabled = true;
        try {
          await client.linkEventCustomer(eventId, customerId);
          dependencies.closeModal();
          dependencies.toast("邮件已关联并写入客户记录", "success");
          await refresh(true);
        } catch (error) {
          button.disabled = false;
          dependencies.toast(error instanceof Error ? error.message : "客户关联失败", "error");
        }
      });
    } catch (error) {
      dependencies.toast(error instanceof Error ? error.message : "客户列表加载失败", "error");
    } finally {
      sourceButton.disabled = false;
    }
  };

  const confirmOAuthAccount = async (connectionId: string, transactionId = "") => {
    await refresh(true);
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) throw new Error("连接状态尚未同步");
    const account = accountSummary(connection);
    return new Promise<void>((resolve, reject) => {
      dependencies.openModal("确认授权账号", `<div class="form-grid"><p><strong>${escapeHtml(account.name)}</strong>${account.email ? `<br>${escapeHtml(account.email)}` : ""}</p>${account.organization ? `<p class="hint">组织：${escapeHtml(account.organization)}</p>` : ""}${account.issuer ? `<p class="hint">授权服务：${escapeHtml(account.issuer)}</p>` : ""}${account.scopes.length ? `<p class="hint">已授权范围：${account.scopes.map(escapeHtml).join("、")}</p>` : ""}<p class="hint">确认后才会发现工具，工具仍需管理员逐项审核。</p></div>`, `<button class="btn" id="integrationOAuthCancel" type="button">稍后确认</button><button class="btn primary" id="integrationOAuthConfirm" type="button">确认并发现工具</button>`);
      one<HTMLButtonElement>("#integrationOAuthCancel", document)?.addEventListener("click", () => { dependencies.closeModal(); resolve(); });
      one<HTMLButtonElement>("#integrationOAuthConfirm", document)?.addEventListener("click", async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        try {
          await client.confirmAuthorization(connectionId, transactionId);
          dependencies.closeModal();
          dependencies.toast("账号已确认，正在发现可用工具", "success");
          await refresh(true);
          scheduleRefresh();
          resolve();
        } catch (error) {
          button.disabled = false;
          reject(error);
        }
      });
    });
  };

  const runOAuthFlow = async (
    connection: IntegrationConnection,
    initialTransaction?: IntegrationAuthTransaction,
    authorizationWindow?: Window | null
  ) => {
    let transaction = initialTransaction || await client.startAuthorization(connection.id);
    dependencies.openModal("连接外部账号", `<div class="form-grid"><p id="integrationOAuthProgress">正在核验授权服务...</p><p class="hint">授权码和凭据只在服务端处理，不会进入浏览器存储。</p><p id="integrationOAuthFallback"></p></div>`, `<button class="btn" data-modal-close type="button">后台继续</button>`);
    const deadline = Math.min(new Date(transaction.expiresAt).getTime() || Date.now() + 10 * 60_000, Date.now() + 10 * 60_000);
    let authorizationOpened = false;
    while (Date.now() < deadline) {
      transaction = await client.authTransaction(transaction.id);
      const progress = one<HTMLElement>("#integrationOAuthProgress", document);
      if (transaction.status === "authorize_url_ready" && transaction.authorizationUrl && !authorizationOpened) {
        authorizationOpened = true;
        if (progress) progress.textContent = `请在 ${transaction.authorizationHost || "外部授权页"} 完成授权`;
        if (authorizationWindow && !authorizationWindow.closed) authorizationWindow.location.href = transaction.authorizationUrl;
        else {
          const fallback = one<HTMLElement>("#integrationOAuthFallback", document);
          if (fallback) fallback.innerHTML = `<a class="btn primary" href="${escapeHtml(transaction.authorizationUrl)}" target="_blank" rel="noopener noreferrer">打开授权页面</a>`;
        }
      }
      if (transaction.status === "completed") {
        if (authorizationWindow && !authorizationWindow.closed) authorizationWindow.close();
        await confirmOAuthAccount(connection.id, transaction.id);
        return;
      }
      if (["failed", "expired"].includes(transaction.status)) throw new Error("外部授权未完成，请检查连接状态后重试");
      await new Promise((resolve) => window.setTimeout(resolve, 1_200));
    }
    throw new Error("授权等待超时，请重新发起授权");
  };

  const openPrivateConnectorForm = () => {
    dependencies.openModal("提交私有连接器", `<div class="form-grid integration-private-form">
      <label class="form-field">连接器名称<input id="integrationPrivateName" maxlength="160" autocomplete="off" placeholder="例如：团队采购系统"></label>
      <label class="form-field">连接器代码<input id="integrationPrivateCode" maxlength="100" autocomplete="off" placeholder="例如：team-purchasing"></label>
      <label class="form-field">版本<input id="integrationPrivateVersion" maxlength="40" value="1.0.0"></label>
      <label class="form-field">Native MCP 地址<input id="integrationPrivateEndpoint" type="url" maxlength="2000" autocomplete="off" placeholder="https://mcp.example.com/mcp"></label>
      <label class="form-field">认证方式<select id="integrationPrivateAuthentication"><option value="none">无需认证</option><option value="oauth2">OAuth 2.0</option></select></label>
      <label class="form-field">最大工具数<input id="integrationPrivateMaxTools" type="number" min="1" max="200" value="50"></label>
      <div class="integration-private-oauth" data-private-oauth-fields hidden>
        <label class="form-field">OAuth Client ID<input id="integrationPrivateClientId" maxlength="300" autocomplete="off"></label>
        <label class="form-field">密钥环境变量名<input id="integrationPrivateSecretEnv" maxlength="120" autocomplete="off" placeholder="INTEGRATION_TEAM_MCP_SECRET"></label>
        <label class="form-field full">OAuth Scopes<input id="integrationPrivateScopes" maxlength="2000" autocomplete="off" placeholder="mcp.tools.read offline_access"></label>
      </div>
      <label class="form-field full">用途说明<textarea id="integrationPrivateDescription" rows="4" maxlength="1000"></textarea></label>
      <p class="hint">系统只保存端点和 Manifest，不下载连接器代码。生产环境端点必须使用 HTTPS。</p>
    </div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationPrivateSubmit" type="button">提交审核</button>`);
    const authentication = one<HTMLSelectElement>("#integrationPrivateAuthentication", document);
    const oauthFields = one<HTMLElement>("[data-private-oauth-fields]", document);
    authentication?.addEventListener("change", () => { if (oauthFields) oauthFields.hidden = authentication.value !== "oauth2"; });
    one<HTMLButtonElement>("#integrationPrivateSubmit", document)?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const endpointValue = one<HTMLInputElement>("#integrationPrivateEndpoint", document)?.value.trim() || "";
      let endpoint: URL;
      try { endpoint = new URL(endpointValue); } catch { dependencies.toast("请输入有效的 MCP 地址", "error"); return; }
      if (endpoint.username || endpoint.password || endpoint.hash) { dependencies.toast("MCP 地址不能包含账号、密码或 fragment", "error"); return; }
      const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
      if (endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:")) { dependencies.toast("MCP 地址必须使用 HTTPS", "error"); return; }
      const authMode = (authentication?.value || "none") as "none" | "oauth2";
      const clientId = one<HTMLInputElement>("#integrationPrivateClientId", document)?.value.trim() || "";
      const secretEnv = one<HTMLInputElement>("#integrationPrivateSecretEnv", document)?.value.trim() || "";
      const scopes = (one<HTMLInputElement>("#integrationPrivateScopes", document)?.value || "").split(/[\s,]+/u).filter(Boolean);
      if (authMode === "oauth2" && (!clientId || !scopes.length)) { dependencies.toast("OAuth 认证需要 Client ID 和 Scopes", "error"); return; }
      if (secretEnv && !/^INTEGRATION_[A-Z0-9_]+$/u.test(secretEnv)) { dependencies.toast("密钥环境变量必须以 INTEGRATION_ 开头", "error"); return; }
      button.disabled = true;
      try {
        await client.createPrivateConnector({
          name: one<HTMLInputElement>("#integrationPrivateName", document)?.value.trim() || "",
          code: one<HTMLInputElement>("#integrationPrivateCode", document)?.value.trim().toLowerCase() || "",
          version: one<HTMLInputElement>("#integrationPrivateVersion", document)?.value.trim() || "1.0.0",
          description: one<HTMLTextAreaElement>("#integrationPrivateDescription", document)?.value.trim() || "",
          manifest: {
            schemaVersion: "1.0",
            stage: "available",
            driver: "native_mcp",
            endpoint: endpoint.toString(),
            approvedHosts: [endpoint.hostname.toLowerCase()],
            allowedPorts: [Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80))],
            ...(loopback && endpoint.protocol === "http:" ? { allowInsecureLoopback: true } : {}),
            authentication: authMode,
            ...(authMode === "oauth2" ? { oauth: { clientId, scopes, ...(secretEnv ? { clientSecretEnv: secretEnv } : {}) } } : {}),
            maxTools: Math.max(1, Math.min(200, Number(one<HTMLInputElement>("#integrationPrivateMaxTools", document)?.value || 50)))
          }
        });
        dependencies.closeModal();
        dependencies.toast("私有连接器已提交审核", "success");
        await refresh(true);
        showTab("connector-reviews");
      } catch (error) {
        button.disabled = false;
        dependencies.toast(error instanceof Error ? error.message : "连接器提交失败", "error");
      }
    });
  };

  const reviewConnector = async (connectorId: string, decision: "approved" | "rejected") => {
    const review = connectorReviews.find((item) => item.connectorId === connectorId);
    if (!review) return;
    const execute = async (note: string) => {
      try {
        await client.reviewPrivateConnector(connectorId, decision, note);
        dependencies.closeModal();
        dependencies.toast(decision === "approved" ? "连接器已通过审核" : "连接器已驳回并隔离", "success");
        await refresh(true);
        showTab("connector-reviews");
      } catch (error) {
        dependencies.toast(error instanceof Error ? error.message : "连接器审核失败", "error");
      }
    };
    if (decision === "approved") {
      if (await confirmAction("通过私有连接器", `确认 ${review.connector.name} 的端点与 Manifest 配置符合平台安全要求。`)) await execute("端点与 Manifest 配置审核通过");
      return;
    }
    dependencies.openModal("驳回私有连接器", `<div class="form-grid"><p><strong>${escapeHtml(review.connector.name)}</strong></p><label>审核意见<textarea id="integrationConnectorRejectNote" rows="5" maxlength="1000"></textarea></label></div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationConnectorRejectConfirm" type="button">确认驳回</button>`);
    one<HTMLButtonElement>("#integrationConnectorRejectConfirm", document)?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const note = one<HTMLTextAreaElement>("#integrationConnectorRejectNote", document)?.value.trim() || "";
      if (!note) { dependencies.toast("请填写审核意见", "error"); return; }
      button.disabled = true;
      await execute(note);
      button.disabled = false;
    });
  };

  const openConnect = () => {
    const connector = catalog.find((item) => item.id === selectedConnectorId);
    if (!connector) return;
    const existing = connectionFor(connector.id);
    if (existing) { showTab("connected"); return; }
    if (connector.status !== "active") {
      dependencies.toast(connector.status === "review" ? "该连接器正在等待平台审核" : connector.status === "disabled" ? "该连接器未通过审核，不能创建连接" : "该连接器仍在规划中，暂不能授权", "info");
      return;
    }
    const grantedScopes = dependencies.permissionScopes("integration.connect");
    if (!grantedScopes.length) {
      dependencies.toast("当前角色没有创建连接的权限", "error");
      return;
    }
    const scopes: Array<{ value: ConnectionScope; label: string }> = [
      ...(grantedScopes.includes("tenant") ? [{ value: "team" as const, label: "当前团队" }] : []),
      { value: "personal", label: "仅本人" }
    ];
    const credentialFields = connector.manifest.authentication === "api_token"
      ? connector.manifest.credentialFields || [] : [];
    const credentialInputs = credentialFields.map((field) => `<label>${escapeHtml(field.label)}<input type="password" autocomplete="new-password" data-integration-credential="${escapeHtml(field.key)}" minlength="${field.minLength}" maxlength="${field.maxLength}" required>${field.help ? `<small class="hint">${escapeHtml(field.help)}</small>` : ""}</label>`).join("");
    dependencies.openModal(`连接 ${connector.name}`, `<div class="form-grid"><label>连接名称<input id="integrationConnectionName" value="${escapeHtml(connector.name)}"></label><label>开放范围<select id="integrationConnectionScope">${scopes.map((scope) => `<option value="${scope.value}">${scope.label}</option>`).join("")}</select></label>${credentialInputs}<p class="hint">凭证经服务端加密后绑定当前连接；连接完成后仍需审核每个工具。</p></div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationConnectionConfirm" type="button">开始连接</button>`);
    one<HTMLButtonElement>("#integrationConnectionConfirm", document)?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      const authorizationWindow = connector.manifest.authentication === "oauth2"
        ? window.open("about:blank", "goodjob-integration-oauth", "width=720,height=760")
        : null;
      try {
        const credentials = Object.fromEntries(all<HTMLInputElement>("[data-integration-credential]", document).map((input) => [
          input.dataset.integrationCredential || "", input.value.trim()
        ]).filter(([key]) => Boolean(key)));
        const invalidCredential = credentialFields.find((field) => {
          const value = credentials[field.key] || "";
          return value.length < field.minLength || value.length > field.maxLength;
        });
        if (invalidCredential) {
          dependencies.toast(`请正确填写${invalidCredential.label}`, "error");
          button.disabled = false;
          return;
        }
        const connection = await client.createConnection({
          connectorId: connector.id,
          scope: one<HTMLSelectElement>("#integrationConnectionScope", document)?.value as ConnectionScope,
          displayName: one<HTMLInputElement>("#integrationConnectionName", document)?.value.trim() || connector.name,
          ...(credentialFields.length ? { credentials } : {})
        });
        dependencies.closeModal();
        if (connector.manifest.authentication === "oauth2") {
          await runOAuthFlow(connection, undefined, authorizationWindow);
          return;
        }
        dependencies.toast("连接任务已提交，正在发现工具", "success");
        await refresh(true);
        showTab("connected");
        scheduleRefresh();
      } catch (error) {
        if (authorizationWindow && !authorizationWindow.closed) authorizationWindow.close();
        dependencies.toast(error instanceof Error ? error.message : "连接失败", "error");
        button.disabled = false;
      }
    });
  };

  const openReview = (toolId: string) => {
    const tool = tools.find((item) => item.id === toolId);
    if (!tool) return;
    const fields = inputFields(tool);
    dependencies.openModal("审核外部工具", `<div class="form-grid">
      <label>稳定别名<input id="integrationToolAlias" value="${escapeHtml(tool.remoteName)}"></label>
      <label>权限代码<input id="integrationToolPermission" value="${escapeHtml(tool.remoteName.replace(/[^a-z0-9]+/giu, ".").toLowerCase())}.read"></label>
      <label>风险等级<select id="integrationToolRisk"><option value="0">R0 无参数只读</option><option value="1">R1 常规只读</option><option value="2">R2 敏感只读</option><option value="3">R3 低风险写入</option><option value="4">R4 外发或业务写入</option><option value="5">R5 高影响写入</option></select></label>
      <label>审批策略<select id="integrationApprovalPolicy"><option value="risk_based">按风险等级</option><option value="always">每次审批</option></select></label>
      <label>每日调用上限<input id="integrationDailyLimit" type="number" min="1" max="10000" value="100"></label>
      <fieldset><legend>开放范围</legend><p class="hint">工具授权绑定当前团队，并继续叠加 CRM 权限码与数据范围校验。历史角色字段仅用于兼容旧配置。</p></fieldset>
      <fieldset><legend>允许发送字段</legend>${fields.length ? fields.map((field) => `<label><input type="checkbox" data-integration-field="${escapeHtml(field)}" checked> ${escapeHtml(field)}</label>`).join("") : "<span class=\"hint\">该工具没有输入字段</span>"}</fieldset>
      <fieldset><legend>允许数据分类</legend><label><input type="checkbox" data-integration-data-class="public" checked> 公开</label><label><input type="checkbox" data-integration-data-class="business" checked> 业务</label><label><input type="checkbox" data-integration-data-class="personal" checked> 联系人</label><label><input type="checkbox" data-integration-data-class="sensitive"> 敏感业务</label></fieldset>
      <fieldset><legend>写入完成证据</legend><label><input type="checkbox" data-integration-evidence="created_object_id" checked> 外部对象编号</label><label><input type="checkbox" data-integration-evidence="external_receipt_id"> 外部回执编号</label><label><input type="checkbox" data-integration-evidence="state_transition"> 状态变化</label><label><input type="checkbox" data-integration-evidence="read_after_write_match"> 写后回读一致</label><label><input type="checkbox" data-integration-evidence="delivery_acceptance"> 投递接受</label><label><input type="checkbox" data-integration-evidence="file_artifact"> 文件编号与校验值</label></fieldset>
    </div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationReviewConfirm" type="button">审核并启用</button>`);
    const riskSelect = one<HTMLSelectElement>("#integrationToolRisk", document);
    if (riskSelect) riskSelect.value = String(tool.riskLevel || 0);
    const graphReviewPolicy: Record<string, { risk: number; evidence: string[]; sensitive?: boolean }> = {
      "mail.list_accounts": { risk: 1, evidence: [] },
      "mail.search_messages": { risk: 2, evidence: [] },
      "mail.get_message": { risk: 2, evidence: [], sensitive: true },
      "calendar.list_events": { risk: 2, evidence: [] },
      "calendar.get_availability": { risk: 2, evidence: [] },
      "mail.create_draft": { risk: 3, evidence: ["created_object_id"], sensitive: true },
      "mail.send_message": { risk: 4, evidence: ["external_receipt_id", "delivery_acceptance"], sensitive: true },
      "calendar.create_event": { risk: 4, evidence: ["created_object_id"], sensitive: true },
      "calendar.update_event": { risk: 4, evidence: ["state_transition", "read_after_write_match"], sensitive: true },
      "erp.customers.search": { risk: 2, evidence: [], sensitive: true },
      "erp.quotations.search": { risk: 2, evidence: [], sensitive: true },
      "erp.quotations.get": { risk: 2, evidence: [], sensitive: true },
      "erp.quotations.create": { risk: 4, evidence: ["created_object_id", "read_after_write_match"], sensitive: true },
      "erp.sales_orders.search": { risk: 2, evidence: [], sensitive: true },
      "erp.sales_orders.get": { risk: 2, evidence: [], sensitive: true },
      "erp.sales_orders.create": { risk: 4, evidence: ["created_object_id", "read_after_write_match"], sensitive: true },
      "erp.inventory.get_balance": { risk: 1, evidence: [] },
      "erp.invoices.search": { risk: 2, evidence: [], sensitive: true },
      "logistics.search_trackers": { risk: 2, evidence: [], sensitive: true },
      "logistics.get_tracking": { risk: 2, evidence: [], sensitive: true },
      "logistics.create_tracking": { risk: 3, evidence: ["created_object_id", "read_after_write_match"], sensitive: true },
      "storage.list_files": { risk: 2, evidence: [], sensitive: true },
      "storage.get_file_metadata": { risk: 2, evidence: [], sensitive: true },
      "storage.create_folder": { risk: 3, evidence: ["created_object_id"], sensitive: true },
      "storage.upload_trade_document": { risk: 4, evidence: ["created_object_id", "file_artifact"], sensitive: true },
      "storage.share_document": { risk: 4, evidence: ["external_receipt_id", "delivery_acceptance"], sensitive: true },
      "wecom.departments.list": { risk: 1, evidence: [] },
      "wecom.members.list": { risk: 2, evidence: [], sensitive: true },
      "wecom.external_contacts.list": { risk: 2, evidence: [], sensitive: true },
      "wecom.external_contacts.get": { risk: 2, evidence: [], sensitive: true },
      "wecom.app_message.send_text": { risk: 4, evidence: ["external_receipt_id", "delivery_acceptance"], sensitive: true }
    };
    const graphPolicy = graphReviewPolicy[tool.remoteName];
    if (graphPolicy && riskSelect) {
      riskSelect.value = String(graphPolicy.risk);
      const approvalPolicy = one<HTMLSelectElement>("#integrationApprovalPolicy", document);
      if (approvalPolicy && graphPolicy.risk >= 4) approvalPolicy.value = "always";
      all<HTMLInputElement>("[data-integration-evidence]", document).forEach((input) => { input.checked = graphPolicy.evidence.includes(input.dataset.integrationEvidence || ""); });
      const sensitive = one<HTMLInputElement>('[data-integration-data-class="sensitive"]', document);
      if (sensitive) sensitive.checked = graphPolicy.sensitive === true;
      const permission = one<HTMLInputElement>("#integrationToolPermission", document);
      if (permission && graphPolicy.risk >= 3) permission.value = tool.remoteName.replace(/[^a-z0-9]+/giu, ".").toLowerCase();
    }
    one<HTMLButtonElement>("#integrationReviewConfirm", document)?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        await client.approveTool(tool.id, {
          stableAlias: one<HTMLInputElement>("#integrationToolAlias", document)?.value.trim() || tool.remoteName,
          permissionCode: one<HTMLInputElement>("#integrationToolPermission", document)?.value.trim() || `${tool.remoteName}.read`,
          riskLevel: Number(one<HTMLSelectElement>("#integrationToolRisk", document)?.value || 0),
          dailyCallLimit: Number(one<HTMLInputElement>("#integrationDailyLimit", document)?.value || 100),
          fieldAllowlist: all<HTMLInputElement>("[data-integration-field]:checked", document).map((input) => input.dataset.integrationField || "").filter(Boolean),
          allowedDataClasses: all<HTMLInputElement>("[data-integration-data-class]:checked", document).map((input) => input.dataset.integrationDataClass as "public" | "business" | "personal" | "sensitive"),
          approvalPolicy: one<HTMLSelectElement>("#integrationApprovalPolicy", document)?.value as "risk_based" | "always",
          completionEvidence: all<HTMLInputElement>("[data-integration-evidence]:checked", document).map((input) => input.dataset.integrationEvidence as "created_object_id" | "external_receipt_id" | "state_transition" | "read_after_write_match" | "delivery_acceptance" | "file_artifact")
        });
        dependencies.closeModal();
        dependencies.toast("工具已审核并启用", "success");
        await refresh(true);
      } catch (error) {
        dependencies.toast(error instanceof Error ? error.message : "工具审核失败", "error");
        button.disabled = false;
      }
    });
  };

  const openApiCredentialRefresh = (connection: IntegrationConnection, connector: IntegrationCatalogItem) => {
    const fields = connector.manifest.credentialFields || [];
    const inputs = fields.map((field) => `<label>${escapeHtml(field.label)}<input type="password" autocomplete="new-password" data-integration-refresh-credential="${escapeHtml(field.key)}" minlength="${field.minLength}" maxlength="${field.maxLength}" required>${field.help ? `<small class="hint">${escapeHtml(field.help)}</small>` : ""}</label>`).join("");
    dependencies.openModal(`更新 ${connector.name} 凭据`, `<div class="form-grid">${inputs}<p class="hint">新凭据加密保存后，系统会重新验证连接并发现工具。</p></div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationCredentialRefreshConfirm" type="button">验证并更新</button>`);
    one<HTMLButtonElement>("#integrationCredentialRefreshConfirm", document)?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const credentials = Object.fromEntries(all<HTMLInputElement>("[data-integration-refresh-credential]", document).map((input) => [
        input.dataset.integrationRefreshCredential || "", input.value.trim()
      ]).filter(([key]) => Boolean(key)));
      const invalid = fields.find((field) => (credentials[field.key] || "").length < field.minLength || (credentials[field.key] || "").length > field.maxLength);
      if (invalid) { dependencies.toast(`请正确填写${invalid.label}`, "error"); return; }
      button.disabled = true;
      try {
        await client.replaceApiCredentials(connection.id, credentials);
        dependencies.closeModal();
        dependencies.toast("凭据已更新，正在验证连接", "success");
        await refresh(true);
      } catch (error) {
        button.disabled = false;
        dependencies.toast(error instanceof Error ? error.message : "凭据更新失败", "error");
      }
    });
  };

  const confirmAction = (title: string, detail: string) => new Promise<boolean>((resolve) => {
    dependencies.openModal(title, `<p>${escapeHtml(detail)}</p>`, `<button class="btn" id="integrationConfirmCancel" type="button">取消</button><button class="btn primary" id="integrationConfirmAction" type="button">确认</button>`);
    one<HTMLButtonElement>("#integrationConfirmCancel", document)?.addEventListener("click", () => { dependencies.closeModal(); resolve(false); });
    one<HTMLButtonElement>("#integrationConfirmAction", document)?.addEventListener("click", () => { dependencies.closeModal(); resolve(true); });
  });

  const approveExecution = async (approvalId: string, button: HTMLButtonElement) => {
    const approval = approvals.find((item) => item.id === approvalId);
    if (!approval) return;
    if (!await confirmAction("批准外部操作", `将按已冻结参数执行 ${approval.tool.displayName || approval.tool.remoteName}。`)) return;
    button.disabled = true;
    try {
      await client.approveExecution(approvalId);
      dependencies.toast("审批已消费，外部操作开始执行", "success");
      await refresh(true);
      showTab("activity");
    } catch (error) {
      dependencies.toast(error instanceof Error ? error.message : "批准失败", "error");
      button.disabled = false;
    }
  };

  const rejectExecution = async (approvalId: string) => {
    const approval = approvals.find((item) => item.id === approvalId);
    if (!approval) return;
    dependencies.openModal("拒绝外部操作", `<div class="form-grid"><p><strong>${escapeHtml(approval.tool.displayName || approval.tool.remoteName)}</strong></p><label>拒绝原因<textarea id="integrationRejectExecutionNote" rows="4" maxlength="1000"></textarea></label></div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationRejectExecutionConfirm" type="button">确认拒绝</button>`);
    one<HTMLButtonElement>("#integrationRejectExecutionConfirm", document)?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        await client.rejectExecution(approvalId, one<HTMLTextAreaElement>("#integrationRejectExecutionNote", document)?.value.trim() || "未通过业务审核");
        dependencies.closeModal();
        dependencies.toast("外部操作已拒绝", "success");
        await refresh(true);
      } catch (error) {
        dependencies.toast(error instanceof Error ? error.message : "拒绝失败", "error");
        button.disabled = false;
      }
    });
  };

  const openReconciliation = (callId: string) => {
    const call = calls.find((item) => item.id === callId);
    if (!call) return;
    dependencies.openModal("外部操作人工对账", `<div class="form-grid"><p><strong>${escapeHtml(call.requestId)}</strong></p><label>回查结果<select id="integrationReconcileOutcome"><option value="succeeded">确认外部已执行</option><option value="failed">确认外部未执行</option></select></label><label>外部回执编号<input id="integrationReconcileReceipt" maxlength="500"></label><label>回查说明<textarea id="integrationReconcileNote" rows="5" maxlength="1000"></textarea></label></div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="integrationReconcileConfirm" type="button">提交对账结论</button>`);
    one<HTMLButtonElement>("#integrationReconcileConfirm", document)?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const outcome = one<HTMLSelectElement>("#integrationReconcileOutcome", document)?.value as "succeeded" | "failed";
      const externalReceipt = one<HTMLInputElement>("#integrationReconcileReceipt", document)?.value.trim() || "";
      const note = one<HTMLTextAreaElement>("#integrationReconcileNote", document)?.value.trim() || "";
      if (!note || (outcome === "succeeded" && !externalReceipt)) {
        dependencies.toast(outcome === "succeeded" ? "确认成功时请填写外部回执编号和回查说明" : "请填写回查说明", "error");
        return;
      }
      button.disabled = true;
      try {
        await client.reconcileCall(callId, { outcome, note, externalReceipt });
        dependencies.closeModal();
        dependencies.toast("对账结论已记录", "success");
        await refresh(true);
      } catch (error) {
        dependencies.toast(error instanceof Error ? error.message : "对账失败", "error");
        button.disabled = false;
      }
    });
  };

  const connectionAction = async (button: HTMLButtonElement) => {
    const id = button.dataset.id || "";
    const action = button.dataset.connectionAction || "";
    if (!id) return;
    if (action === "disconnect" && !await confirmAction("解绑连接", "解绑后该连接的工具将不可再调用。")) return;
    button.disabled = true;
    try {
      if (action === "authorize") {
        const connection = connections.find((item) => item.id === id);
        if (!connection) return;
        const authorizationWindow = window.open("about:blank", "goodjob-integration-oauth", "width=720,height=760");
        await runOAuthFlow(connection, undefined, authorizationWindow);
        return;
      }
      if (action === "confirm") {
        await confirmOAuthAccount(id);
        return;
      }
      if (action === "reauthorize") {
        const connection = connections.find((item) => item.id === id);
        if (!connection) return;
        const connector = connectorFor(connection.connectorId);
        if (connector?.manifest.authentication === "api_token") {
          openApiCredentialRefresh(connection, connector);
          return;
        }
        const authorizationWindow = window.open("about:blank", "goodjob-integration-oauth", "width=720,height=760");
        const transaction = await client.reauthorizeConnection(id);
        await runOAuthFlow(connection, transaction, authorizationWindow);
        return;
      }
      if (action === "pause") await client.pauseConnection(id);
      if (action === "resume") await client.resumeConnection(id);
      if (action === "refresh") await client.refreshTools(id);
      if (action === "disconnect") await client.disconnectConnection(id);
      dependencies.toast(action === "refresh" ? "工具发现任务已提交" : "连接状态已更新", "success");
      await refresh(true);
      if (action === "refresh") scheduleRefresh();
    } catch (error) {
      dependencies.toast(error instanceof Error ? error.message : "连接操作失败", "error");
      button.disabled = false;
    }
  };

  const rejectTool = async (toolId: string) => {
    if (!await confirmAction("拒绝工具", "该 Schema 快照将被标记为拒绝，不会开放调用。")) return;
    try {
      await client.rejectTool(toolId, "管理员在集成中心拒绝");
      dependencies.toast("工具已拒绝", "success");
      await refresh(true);
    } catch (error) {
      dependencies.toast(error instanceof Error ? error.message : "拒绝工具失败", "error");
    }
  };

  const testTool = async (toolId: string, button: HTMLButtonElement) => {
    button.disabled = true;
    try {
      await client.testTool(toolId);
      dependencies.toast("测试调用已进入安全执行队列", "success");
      scheduleRefresh();
    } catch (error) {
      dependencies.toast(error instanceof Error ? error.message : "测试调用失败", "error");
      button.disabled = false;
    }
  };

  const connectorReviewTab = one<HTMLButtonElement>('[data-integration-tab="connector-reviews"]');
  const privateConnectorButton = one<HTMLButtonElement>("#integrationPrivateConnectorButton");
  const syncCapabilityUi = () => {
    const canManageConnectors = dependencies.hasPermission("integration.manage");
    const canReviewConnectors = canManageConnectors || dependencies.hasPermission("platform.integration.connector.review");
    if (connectorReviewTab) connectorReviewTab.hidden = !canReviewConnectors;
    const connectorReviewLaunchCard = one<HTMLButtonElement>("#integrationLaunchConnectorReviews");
    if (connectorReviewLaunchCard) connectorReviewLaunchCard.hidden = !canReviewConnectors;
    if (privateConnectorButton) privateConnectorButton.hidden = !canManageConnectors;
    if (platformReviewOnly) {
      all<HTMLButtonElement>("[data-integration-tab]").forEach((button) => {
        button.hidden = button.dataset.integrationTab !== "connector-reviews";
      });
      all<HTMLButtonElement>("[data-integration-launch-tab]").forEach((button) => {
        button.hidden = button.dataset.integrationLaunchTab !== "connector-reviews";
      });
    }
    const connectButton = one<HTMLButtonElement>("#integrationPrototypeConnect");
    if (connectButton) connectButton.hidden = !dependencies.hasPermission("integration.connect");
  };
  syncCapabilityUi();

  all<HTMLElement>("[data-integration-panel]").forEach((panel) => {
    if (one("[data-integration-home]", panel)) return;
    panel.insertAdjacentHTML("afterbegin", `<button class="integration-panel-back" type="button" data-integration-home><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span>返回集成中心</span></button>`);
  });

  all<HTMLButtonElement>("[data-integration-tab]").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.integrationTab || "catalog")));
  all<HTMLButtonElement>("[data-integration-launch-tab]").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.integrationLaunchTab || "catalog")));
  all<HTMLButtonElement>("[data-integration-home]").forEach((button) => button.addEventListener("click", showHome));
  all<HTMLButtonElement>("[data-integration-filter]").forEach((button) => button.addEventListener("click", () => {
    activeFilter = button.dataset.integrationFilter || "all";
    all<HTMLButtonElement>("[data-integration-filter]").forEach((item) => item.classList.toggle("active", item === button));
    renderCatalog();
  }));
  one<HTMLInputElement>("#integrationSearchInput")?.addEventListener("input", renderCatalog);
  one<HTMLButtonElement>("#integrationDetailClose")?.addEventListener("click", () => { root.classList.remove("is-detail-open"); root.classList.add("detail-closed"); });
  one<HTMLButtonElement>("#integrationConnectButton")?.addEventListener("click", () => showTab("catalog"));
  one<HTMLButtonElement>("#integrationPrototypeConnect")?.addEventListener("click", openConnect);
  privateConnectorButton?.addEventListener("click", openPrivateConnectorForm);
  one<HTMLButtonElement>("#integrationWorkspaceSearchButton")?.addEventListener("click", () => void searchWorkspaceMail());
  one<HTMLInputElement>("#integrationWorkspaceSearch")?.addEventListener("keydown", (event) => { if (event.key === "Enter") void searchWorkspaceMail(); });
  all<HTMLButtonElement>("[data-integration-workspace-provider]").forEach((button) => button.addEventListener("click", () => {
    workspaceProvider = button.dataset.integrationWorkspaceProvider === "google" ? "google" : "microsoft";
    workspaceMessages = [];
    renderWorkspaceMessages();
  }));

  all<HTMLElement>(".integration-overview strong").forEach((node) => { node.textContent = "0"; });
  const initialGrid = one<HTMLElement>("#integrationCatalogGrid");
  if (initialGrid) initialGrid.innerHTML = `<div class="integration-empty-state"><h3>等待读取连接器</h3><p>进入集成中心后从服务端同步。</p></div>`;
  root.classList.add("detail-closed");
  showHome();

  return { refresh };
}
