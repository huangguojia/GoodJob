/**
 * 平台运维与审批中心。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, confirmAction, openModal, state, syncWorkspaceAccess } from "../prototype-api";
import {
  type ApprovalAction, type ApprovalInstance, type ApprovalTask, type ApprovalWorkflow, type ApprovalWorkflowEdge,
  type ApprovalWorkflowNode, type ApprovalWorkflowNodeType, type IamCapabilitySnapshot, type PlatformAuditEvent,
  type PlatformOperator, type PlatformSupportRequest, type PlatformTenant, type User
} from "./models";
import { formatTime } from "./dashboard";
import { type PlatformTab, escapeHtml, qs, qsa, roleLabel } from "./shared";
import { api, toast } from "./ui";
import { hasIamCapability } from "./auth";
import { renderTopbarForView } from "./navigation";

let platformActiveTab: PlatformTab = "overview";
let platformOverview: { metrics: Record<string, number>; generatedAt: string } | null = null;
let platformTenants: PlatformTenant[] = [];
let platformSupportRequests: PlatformSupportRequest[] = [];
let platformOperators: PlatformOperator[] = [];
let platformHealthServices: Array<Record<string, unknown>> = [];
let platformAuditEvents: PlatformAuditEvent[] = [];
let approvalWorkflows: ApprovalWorkflow[] = [];
let approvalInstances: ApprovalInstance[] = [];
let approvalTasks: ApprovalTask[] = [];
let approvalCenterTab: "pending" | "mine" | "completed" = "pending";
let selectedApprovalInstanceId = "";
let approvalDesignerWorkflow: ApprovalWorkflow | null = null;
let approvalDesignerSelectedNodeId = "";
let approvalDesignerSelectedEdgeId = "";
let approvalDesignerConnectionSource = "";
let approvalDesignerDirty = false;

export async function loadIamCapabilities(user: User) {
  try {
    const response = await api<{ snapshot: IamCapabilitySnapshot }>("/api/iam/capabilities");
    state.iamCapabilities = response.snapshot;
  } catch {
    state.iamCapabilities = null;
  }
  if (state.iamCapabilities) {
    const roleNames = state.iamCapabilities.roleNames || [];
    const topUserRole = qs<HTMLElement>("#topUserRole");
    if (topUserRole) topUserRole.textContent = roleNames.join(" / ") || roleLabel[user.role];
    const scopeUser = qs<HTMLElement>("#scopeUser");
    if (scopeUser) scopeUser.textContent = `${user.name} / ${roleNames.join(" / ") || roleLabel[user.role]}`;
    const allScopes = Object.values(state.iamCapabilities.permissions).flat();
    const scopeText = qs<HTMLElement>("#scopeText");
    if (scopeText) scopeText.textContent = state.iamCapabilities.source === "platform" ? "平台运维控制域，不直接拥有公司业务权限" : allScopes.includes("tenant") ? "已按角色授权公司范围" : allScopes.includes("org_subtree") || allScopes.includes("org_unit") ? "已按角色授权组织范围" : "已按角色授权本人范围";
  }
  syncWorkspaceAccess(user);
  renderTopbarForView(qs<HTMLElement>(".view.active")?.id || "dashboard");
}

const platformTabPermission: Record<PlatformTab, string> = {
  overview: "platform.dashboard.read",
  tenants: "platform.tenant.metadata.read",
  support: "platform.support.request.create",
  operators: "platform.operator.read",
  health: "platform.health.read",
  audit: "platform.audit.read"
};

function platformStatusLabel(status: string) {
  return ({ trial: "公测", active: "启用", suspended: "已暂停", closed: "已关闭", pending: "待审批", approved: "已批准", rejected: "已拒绝", expired: "已过期", cancelled: "已取消", terminated: "已结束" } as Record<string, string>)[status] || status;
}

function platformMetric(label: string, value: number) {
  return `<div class="platform-metric"><span>${escapeHtml(label)}</span><b>${Number(value || 0).toLocaleString("zh-CN")}</b></div>`;
}

function platformTenantRows(items = platformTenants.slice(0, 12)) {
  return items.map((tenant) => `<tr>
    <td><div class="platform-cell-main"><b>${escapeHtml(tenant.name)}</b><small>${escapeHtml(tenant.code)} · ${escapeHtml(tenant.id)}</small></div></td>
    <td><span class="platform-status ${escapeHtml(tenant.status)}">${escapeHtml(platformStatusLabel(tenant.status))}</span></td>
    <td>${escapeHtml(tenant.planCode)}</td><td>${tenant.activeMemberCount} / ${tenant.seatLimit}</td>
    <td>${tenant.authorizationRevision}</td><td>${escapeHtml(formatTime(tenant.createdAt))}</td>
    <td><div class="platform-actions">${tenant.activeMemberCount === 0 && hasIamCapability("platform.tenant.admin.bootstrap")
      ? `<button class="platform-command primary" type="button" data-platform-bootstrap-admin data-tenant-id="${escapeHtml(tenant.id)}">设置管理员</button>` : ""}${tenant.status === "suspended"
      ? `<button class="platform-command" type="button" data-platform-tenant-action="restore" data-tenant-id="${escapeHtml(tenant.id)}">恢复</button>`
      : tenant.status !== "closed" ? `<button class="platform-command danger" type="button" data-platform-tenant-action="suspend" data-tenant-id="${escapeHtml(tenant.id)}">暂停</button>` : ""}</div></td>
  </tr>`).join("");
}

function renderPlatformOverview() {
  const metrics = platformOverview?.metrics || {};
  return `<div class="platform-metrics">
    ${platformMetric("公司总数", metrics.tenantCount || 0)}${platformMetric("正常服务", metrics.activeTenantCount || 0)}${platformMetric("暂停公司", metrics.suspendedTenantCount || 0)}
    ${platformMetric("启用成员", metrics.activeMemberCount || 0)}${platformMetric("待批支持", metrics.pendingSupportCount || 0)}${platformMetric("今日审计", metrics.todayAuditCount || 0)}
  </div>
  <section class="platform-section"><div class="platform-section-head"><h2>公司运行概况</h2><button class="platform-command" type="button" data-platform-open-tab="tenants">查看全部公司</button></div>
    <div class="platform-table-wrap"><table class="platform-table"><thead><tr><th>公司</th><th>状态</th><th>套餐</th><th>启用成员 / 席位</th><th>授权版本</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${platformTenantRows() || `<tr><td colspan="7" class="platform-empty">暂无公司</td></tr>`}</tbody></table></div>
  </section>`;
}

function renderPlatformTenants() {
  return `<section class="platform-section" style="margin-top:0"><div class="platform-section-head"><h2>公司管理</h2><div class="platform-actions"><span class="platform-status active">${platformTenants.length} 家公司</span>${hasIamCapability("platform.tenant.create") ? `<button class="platform-command primary" type="button" data-platform-create-tenant>创建公司</button>` : ""}</div></div>
    <div class="platform-table-wrap"><table class="platform-table"><thead><tr><th>公司</th><th>状态</th><th>套餐</th><th>启用成员 / 席位</th><th>授权版本</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${platformTenantRows(platformTenants) || `<tr><td colspan="7" class="platform-empty">暂无公司</td></tr>`}</tbody></table></div>
  </section>`;
}

function renderPlatformSupport() {
  const permissionLabels: Record<string, string> = { "customer.read": "客户", "lead.read": "线索", "deal.read": "商机", "daily_report.read": "日报" };
  const rows = platformSupportRequests.map((request) => {
    const ownRequest = request.requestedByUserId === state.user?.id;
    const session = request.session;
    const actions = request.status === "pending"
      ? `${hasIamCapability("platform.support.request.approve") && !ownRequest ? `<button class="platform-command primary" data-platform-support-review="approve" data-request-id="${escapeHtml(request.id)}">批准</button><button class="platform-command" data-platform-support-review="reject" data-request-id="${escapeHtml(request.id)}">拒绝</button>` : `<span class="platform-status">等待异人审批</span>`}`
      : request.status === "approved" && !session && ownRequest && hasIamCapability("platform.support.session.start")
        ? `<button class="platform-command primary" data-platform-support-start="${escapeHtml(request.id)}">启动会话</button>`
        : session?.status === "active"
          ? `<button class="platform-command" data-platform-support-read="${escapeHtml(session.id)}">进入支持视图</button><button class="platform-command danger" data-platform-support-terminate="${escapeHtml(session.id)}">结束</button>`
          : "";
    return `<tr><td><div class="platform-cell-main"><b>${escapeHtml(request.tenantName)}</b><small>${escapeHtml(request.ticketNo)}</small></div></td>
      <td><div class="platform-cell-main"><b>${escapeHtml(request.reason)}</b><small>${request.permissionCodes.map((code) => escapeHtml(permissionLabels[code] || code)).join("、")} · ${request.requestedMinutes} 分钟</small></div></td>
      <td><span class="platform-status ${escapeHtml(session?.status || request.status)}">${escapeHtml(platformStatusLabel(session?.status || request.status))}</span></td>
      <td>${escapeHtml(formatTime(request.createdAt))}</td><td>${actions}</td></tr>`;
  }).join("");
  return `<section class="platform-section" style="margin-top:0"><div class="platform-section-head"><h2>客户支持访问</h2>${hasIamCapability("platform.support.request.create") ? `<button class="platform-command primary" type="button" data-platform-create-support>创建访问申请</button>` : ""}</div>
    <div class="platform-table-wrap"><table class="platform-table"><thead><tr><th>公司 / 工单</th><th>访问原因与范围</th><th>状态</th><th>申请时间</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="platform-empty">暂无支持访问申请</td></tr>`}</tbody></table></div>
  </section>`;
}

function renderPlatformOperators() {
  const rows = platformOperators.map((operator) => `<tr><td><div class="platform-cell-main"><b>${escapeHtml(operator.name)}</b><small>${escapeHtml(operator.email)}</small></div></td><td>${escapeHtml(operator.roleNames)}</td><td><span class="platform-status ${escapeHtml(operator.status)}">${escapeHtml(platformStatusLabel(operator.status))}</span></td><td>${operator.mfaRequired ? "强制" : "未强制"}</td><td>${escapeHtml(formatTime(operator.updatedAt))}</td></tr>`).join("");
  return `<section class="platform-section" style="margin-top:0"><div class="platform-section-head"><h2>平台人员</h2><span class="platform-status">平台身份域</span></div><div class="platform-table-wrap"><table class="platform-table"><thead><tr><th>平台账号</th><th>平台角色</th><th>状态</th><th>MFA 策略</th><th>更新时间</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="platform-empty">暂无平台人员</td></tr>`}</tbody></table></div></section>`;
}

function renderPlatformHealth() {
  return `<section class="platform-section" style="margin-top:0"><div class="platform-section-head"><h2>服务健康</h2><span class="platform-status active">实时探测</span></div><div class="platform-health-grid">${platformHealthServices.map((service) => `<div class="platform-health-row"><div><span>${escapeHtml(String(service.code || "service"))}</span><b>${escapeHtml(String(service.name || "服务"))}</b></div><div><span class="platform-status active">正常 · ${escapeHtml(String(service.latencyMs ?? 0))} ms</span></div></div>`).join("") || `<div class="platform-empty">暂无健康数据</div>`}</div></section>`;
}

function renderPlatformAudit() {
  const rows = platformAuditEvents.map((event) => `<tr><td>${escapeHtml(formatTime(event.createdAt))}</td><td><div class="platform-cell-main"><b>${escapeHtml(event.actorName)}</b><small>${escapeHtml(event.actionCode)}</small></div></td><td>${escapeHtml(event.targetType)} · ${escapeHtml(event.targetId)}</td><td>${escapeHtml(event.tenantId || "平台")}</td><td>${escapeHtml(event.reason || "-")}</td><td><span class="platform-status active">${escapeHtml(event.resultStatus)}</span></td></tr>`).join("");
  return `<section class="platform-section" style="margin-top:0"><div class="platform-section-head"><h2>平台审计</h2><span class="platform-status">最近 ${platformAuditEvents.length} 条</span></div><div class="platform-table-wrap"><table class="platform-table"><thead><tr><th>时间</th><th>操作者 / 动作</th><th>目标</th><th>公司</th><th>原因</th><th>结果</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="platform-empty">暂无平台审计记录</td></tr>`}</tbody></table></div></section>`;
}

function renderPlatformOperations() {
  const root = qs<HTMLElement>("#platformOperationsRoot");
  if (!root) return;
  qsa<HTMLButtonElement>("[data-platform-tab]", qs("#platformTabs") || document).forEach((button) => {
    const tab = button.dataset.platformTab as PlatformTab;
    button.hidden = !hasIamCapability(platformTabPermission[tab]);
    button.classList.toggle("active", tab === platformActiveTab);
  });
  if (!hasIamCapability(platformTabPermission[platformActiveTab])) {
    platformActiveTab = (Object.keys(platformTabPermission) as PlatformTab[]).find((tab) => hasIamCapability(platformTabPermission[tab])) || "overview";
  }
  root.innerHTML = platformActiveTab === "tenants" ? renderPlatformTenants()
    : platformActiveTab === "support" ? renderPlatformSupport()
      : platformActiveTab === "operators" ? renderPlatformOperators()
        : platformActiveTab === "health" ? renderPlatformHealth()
          : platformActiveTab === "audit" ? renderPlatformAudit()
            : renderPlatformOverview();
  installPlatformOperationEvents();
}

function approvalStatusLabel(status: string) {
  return ({ draft: "草稿", running: "审批中", pending: "待处理", approved: "已通过", rejected: "已驳回", withdrawn: "已撤回", cancelled: "已取消", failed: "异常", active: "已发布", disabled: "已停用" } as Record<string, string>)[status] || status;
}

function approvalBusinessLabel(type: string) {
  return ({ quote: "报价审批", discount: "折扣审批", customer_transfer: "客户转移", export: "数据导出", commission: "提成审批", custom: "通用审批" } as Record<string, string>)[type] || type || "通用审批";
}

function approvalTaskInstanceId(task: ApprovalTask) { return String(task.instance_id || task.instanceId || ""); }
function approvalActionKey(prefix = "approval") { return `${prefix}:${Date.now()}:${crypto.randomUUID()}`; }

function renderApprovalMetrics() {
  const root = qs<HTMLElement>("#approvalMetrics");
  if (!root) return;
  const pending = approvalTasks.filter((item) => item.status === "pending").length;
  const running = approvalInstances.filter((item) => item.status === "running").length;
  const approved = approvalInstances.filter((item) => item.status === "approved").length;
  const rejected = approvalInstances.filter((item) => item.status === "rejected").length;
  root.innerHTML = `<div class="approval-metric"><span>待我审批</span><strong>${pending}</strong><small>${pending ? "请及时处理" : "当前没有积压"}</small></div><div class="approval-metric"><span>进行中</span><strong>${running}</strong><small>含我发起和参与事项</small></div><div class="approval-metric"><span>已通过</span><strong>${approved}</strong><small>当前可见范围</small></div><div class="approval-metric"><span>已驳回</span><strong>${rejected}</strong><small>当前可见范围</small></div>`;
  const navCount = qs<HTMLElement>("#approvalNavCount");
  if (navCount) { navCount.textContent = String(pending); navCount.hidden = pending === 0; }
}

function approvalCenterItems() {
  if (approvalCenterTab === "pending") return approvalTasks.filter((item) => item.status === "pending").map((task) => ({ task, id: approvalTaskInstanceId(task), title: task.title, summary: task.summary, status: task.status, owner: task.applicant_name || "申请人", time: task.submitted_at || "" }));
  if (approvalCenterTab === "completed") return approvalTasks.filter((item) => item.status !== "pending").map((task) => ({ task, id: approvalTaskInstanceId(task), title: task.title, summary: task.summary, status: task.status, owner: task.applicant_name || "申请人", time: task.submitted_at || "" }));
  const membershipId = state.iamCapabilities?.membershipId || "";
  return approvalInstances.filter((item) => !membershipId || item.applicantMembershipId === membershipId || state.iamCapabilities?.source === "legacy_compatibility").map((instance) => ({ instance, id: instance.id, title: instance.title, summary: instance.summary, status: instance.status, owner: instance.applicantName || "我发起", time: instance.submittedAt }));
}

function renderApprovalCenterList() {
  const root = qs<HTMLElement>("#approvalCenterList");
  const count = qs<HTMLElement>("#approvalListCount");
  const title = qs<HTMLElement>("#approvalListTitle");
  if (!root) return;
  const items = approvalCenterItems();
  if (count) count.textContent = `${items.length} 项`;
  if (title) title.textContent = approvalCenterTab === "pending" ? "待我审批" : approvalCenterTab === "mine" ? "我发起的" : "已处理";
  root.innerHTML = items.length ? items.map((item) => `<button type="button" class="approval-list-item ${selectedApprovalInstanceId === item.id ? "active" : ""}" data-approval-instance-id="${escapeHtml(item.id)}"><header><b>${escapeHtml(item.title || "未命名审批")}</b><em class="approval-state ${escapeHtml(item.status)}">${escapeHtml(approvalStatusLabel(item.status))}</em></header><p>${escapeHtml(item.summary || "未填写审批摘要")}</p><div class="approval-list-meta"><span>${escapeHtml(item.owner)}</span><time>${escapeHtml(item.time ? formatTime(item.time) : "")}</time></div></button>`).join("") : `<div class="approval-empty">${approvalCenterTab === "pending" ? "当前没有待审批事项" : approvalCenterTab === "mine" ? "尚未发起审批" : "暂无已处理事项"}</div>`;
  qsa<HTMLButtonElement>("[data-approval-instance-id]", root).forEach((button) => button.onclick = () => void openApprovalInstance(button.dataset.approvalInstanceId || ""));
}

function approvalActionText(action: ApprovalAction) {
  return ({ submit: "提交审批", approve: "审批通过", reject: "驳回申请", withdraw: "撤回申请", remind: "发起催办", comment: "补充评论", transfer: "转交审批", add_approver: "增加审批人" } as Record<string, string>)[action.action_type] || action.action_type;
}

async function openApprovalInstance(instanceId: string) {
  if (!instanceId) return;
  selectedApprovalInstanceId = instanceId;
  renderApprovalCenterList();
  const root = qs<HTMLElement>("#approvalCenterDetail");
  if (!root) return;
  root.innerHTML = `<div class="approval-detail-empty">正在读取审批详情</div>`;
  try {
    const data = await api<{ instance: ApprovalInstance; tasks: ApprovalTask[]; actions: ApprovalAction[] }>(`/api/v1/approval-instances/${encodeURIComponent(instanceId)}`);
    const instance = data.instance;
    const activeTask = (data.tasks || []).find((task) => task.status === "pending" && approvalTasks.some((mine) => mine.id === task.id));
    const canAct = Boolean(activeTask && hasIamCapability("approval.task.act"));
    const canWithdraw = instance.status === "running" && instance.applicantMembershipId === state.iamCapabilities?.membershipId;
    const actions = (data.actions || []).map((action) => `<li><i></i><div><b>${escapeHtml(approvalActionText(action))} · ${escapeHtml(action.actor_name || "系统")}</b><small>${escapeHtml(action.comment_text || "无补充说明")}</small></div><time>${escapeHtml(formatTime(action.created_at))}</time></li>`).join("");
    root.innerHTML = `<header class="approval-detail-head"><div><h2>${escapeHtml(instance.title)}</h2><p>${escapeHtml(instance.summary || "未填写审批摘要")}</p></div><div class="approval-detail-actions">${canWithdraw ? `<button class="btn" type="button" data-approval-withdraw>撤回</button>` : ""}${canAct ? `<button class="btn" type="button" data-approval-reject>驳回</button><button class="btn primary" type="button" data-approval-approve>同意</button>` : ""}</div></header><div class="approval-facts"><div><span>审批类型</span><b>${escapeHtml(approvalBusinessLabel(instance.businessType))}</b></div><div><span>当前状态</span><b>${escapeHtml(approvalStatusLabel(instance.status))}</b></div><div><span>申请人</span><b>${escapeHtml(instance.applicantName || "--")}</b></div><div><span>提交时间</span><b>${escapeHtml(formatTime(instance.submittedAt))}</b></div></div><ul class="approval-timeline">${actions || `<li><i></i><div><b>审批已创建</b><small>等待流程动作</small></div><time>${escapeHtml(formatTime(instance.submittedAt))}</time></li>`}</ul>`;
    qs<HTMLButtonElement>("[data-approval-approve]", root)?.addEventListener("click", () => activeTask && openApprovalDecision(activeTask, "approve"));
    qs<HTMLButtonElement>("[data-approval-reject]", root)?.addEventListener("click", () => activeTask && openApprovalDecision(activeTask, "reject"));
    qs<HTMLButtonElement>("[data-approval-withdraw]", root)?.addEventListener("click", () => void withdrawApprovalInstance(instance));
  } catch (error) { root.innerHTML = `<div class="approval-detail-empty">加载失败：${escapeHtml(error instanceof Error ? error.message : "未知错误")}</div>`; }
}

function openApprovalDecision(task: ApprovalTask, decision: "approve" | "reject") {
  openModal(decision === "approve" ? "同意审批" : "驳回审批", `<div class="form-grid"><div class="form-field full"><label>审批意见</label><textarea id="approvalDecisionComment" maxlength="1000" placeholder="${decision === "approve" ? "可填写确认说明" : "请说明驳回原因"}"></textarea></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn ${decision === "approve" ? "primary" : "danger"}" id="approvalDecisionConfirm">确认${decision === "approve" ? "同意" : "驳回"}</button>`);
  qs<HTMLButtonElement>("#approvalDecisionConfirm")?.addEventListener("click", async () => {
    const comment = qs<HTMLTextAreaElement>("#approvalDecisionComment")?.value.trim() || "";
    if (decision === "reject" && !comment) { toast("驳回时请填写原因", "error"); return; }
    try {
      await api(`/api/v1/approval-tasks/${encodeURIComponent(task.id)}/${decision}`, { method: "POST", body: JSON.stringify({ version: Number(task.version_no || 1), comment, idempotencyKey: approvalActionKey(decision) }) });
      closeModal(); toast(decision === "approve" ? "审批已通过" : "申请已驳回", "success"); await refreshApprovalCenter(true); await openApprovalInstance(approvalTaskInstanceId(task));
    } catch (error) { toast(error instanceof Error ? error.message : "审批处理失败", "error"); }
  });
}

async function withdrawApprovalInstance(instance: ApprovalInstance) {
  if (!await confirmAction({
    title: "撤回审批申请",
    message: `将撤回「${instance.title}」。`,
    consequences: ["当前审批流程会终止", "审批历史和操作记录会保留", "需要时可重新发起新的申请"],
    confirmLabel: "撤回申请",
    tone: "warning"
  })) return;
  try {
    await api(`/api/v1/approval-instances/${encodeURIComponent(instance.id)}/withdraw`, { method: "POST", body: JSON.stringify({ comment: "申请人主动撤回", idempotencyKey: approvalActionKey("withdraw") }) });
    toast("审批已撤回", "success"); await refreshApprovalCenter(true); await openApprovalInstance(instance.id);
  } catch (error) { toast(error instanceof Error ? error.message : "撤回失败", "error"); }
}

export async function refreshApprovalCenter(showError = false) {
  const root = qs<HTMLElement>("#approvalCenterList");
  if (root) root.innerHTML = `<div class="approval-loading">正在同步审批数据</div>`;
  try {
    const [taskData, instanceData, workflowData] = await Promise.all([api<{ tasks: ApprovalTask[] }>("/api/v1/approval-tasks"), api<{ instances: ApprovalInstance[] }>("/api/v1/approval-instances"), api<{ workflows: ApprovalWorkflow[] }>("/api/v1/approval-workflows")]);
    approvalTasks = taskData.tasks || []; approvalInstances = instanceData.instances || []; approvalWorkflows = workflowData.workflows || [];
    renderApprovalMetrics(); renderApprovalCenterList();
    if (selectedApprovalInstanceId) void openApprovalInstance(selectedApprovalInstanceId);
  } catch (error) { if (root) root.innerHTML = `<div class="approval-empty">审批数据加载失败</div>`; if (showError) toast(error instanceof Error ? error.message : "审批数据加载失败", "error"); }
}

function openApprovalInstanceCreate() {
  const active = approvalWorkflows.filter((item) => item.status === "active");
  if (!active.length) { toast("请先发布至少一个审批流程", "error"); if (hasIamCapability("approval.workflow.manage")) activateNavView("approval-workflows"); return; }
  const options = active.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(approvalBusinessLabel(item.businessType))}</option>`).join("");
  openModal("发起审批", `<div class="form-grid"><div class="form-field full"><label>审批流程</label><select id="approvalCreateWorkflow">${options}</select></div><div class="form-field full"><label>审批标题</label><input id="approvalCreateTitle" maxlength="220" placeholder="例如：客户报价折扣申请"></div><div class="form-field"><label>关联业务编号</label><input id="approvalCreateBusinessId" maxlength="120"></div><div class="form-field full"><label>申请摘要</label><textarea id="approvalCreateSummary" maxlength="500"></textarea></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="approvalCreateConfirm">提交审批</button>`);
  qs<HTMLButtonElement>("#approvalCreateConfirm")?.addEventListener("click", async () => {
    const workflowId = qs<HTMLSelectElement>("#approvalCreateWorkflow")?.value || "";
    const title = qs<HTMLInputElement>("#approvalCreateTitle")?.value.trim() || "";
    const summary = qs<HTMLTextAreaElement>("#approvalCreateSummary")?.value.trim() || "";
    const businessId = qs<HTMLInputElement>("#approvalCreateBusinessId")?.value.trim() || "";
    if (!title) { toast("请填写审批标题", "error"); return; }
    try {
      const data = await api<{ instance: ApprovalInstance }>("/api/v1/approval-instances", { method: "POST", body: JSON.stringify({ workflowId, title, summary, businessId, formData: {}, businessSnapshot: {}, comment: "", idempotencyKey: approvalActionKey("submit") }) });
      closeModal(); toast("审批已提交", "success"); await refreshApprovalCenter(); await openApprovalInstance(data.instance.id);
    } catch (error) { toast(error instanceof Error ? error.message : "审批提交失败", "error"); }
  });
}

function renderApprovalWorkflows() {
  const root = qs<HTMLElement>("#approvalWorkflowList"); const metrics = qs<HTMLElement>("#approvalWorkflowMetrics");
  if (!root) return;
  const active = approvalWorkflows.filter((item) => item.status === "active").length;
  const drafts = approvalWorkflows.filter((item) => item.status === "draft" || Boolean(item.draftVersionId)).length;
  const nodeCount = approvalWorkflows.reduce((sum, item) => sum + (item.nodeCount ?? item.nodes?.length ?? 0), 0);
  if (metrics) metrics.innerHTML = `<div class="approval-metric"><span>流程总数</span><strong>${approvalWorkflows.length}</strong><small>当前公司</small></div><div class="approval-metric"><span>已发布</span><strong>${active}</strong><small>可用于发起申请</small></div><div class="approval-metric"><span>草稿</span><strong>${drafts}</strong><small>发布前可检查</small></div><div class="approval-metric"><span>审批节点</span><strong>${nodeCount}</strong><small>全部流程合计</small></div>`;
  root.innerHTML = approvalWorkflows.length ? `<div class="approval-workflow-row head"><span>流程</span><span>业务类型</span><span>版本</span><span>状态</span><span>操作</span></div>${approvalWorkflows.map((item) => {
    const hasDraft = item.status === "draft" || Boolean(item.draftVersionId);
    return `<div class="approval-workflow-row"><div class="approval-workflow-primary"><i class="approval-workflow-mark">${escapeHtml(approvalBusinessLabel(item.businessType).slice(0, 1))}</i><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.code)} · ${item.nodeCount ?? item.nodes?.length ?? 0} 个节点 · 优先级 ${item.priority || 100}</small></div></div><span>${escapeHtml(approvalBusinessLabel(item.businessType))}</span><span>V${item.versionNo || 1}</span><span>${hasDraft ? `<em class="approval-draft-dot">待发布</em>` : `<em class="approval-state ${escapeHtml(item.status)}">${escapeHtml(approvalStatusLabel(item.status))}</em>`}</span><div class="approval-workflow-actions"><button class="btn" type="button" data-approval-workflow-view="${escapeHtml(item.id)}">${hasDraft ? "继续设计" : "编辑流程"}</button>${hasDraft ? `<button class="btn primary" type="button" data-approval-workflow-publish="${escapeHtml(item.id)}">检查并发布</button>` : ""}</div></div>`;
  }).join("")}` : `<div class="approval-empty">尚未配置审批流程，创建第一条流程后即可按业务自动流转。</div>`;
  qsa<HTMLButtonElement>("[data-approval-workflow-view]", root).forEach((button) => button.onclick = () => void showApprovalWorkflow(button.dataset.approvalWorkflowView || ""));
  qsa<HTMLButtonElement>("[data-approval-workflow-publish]", root).forEach((button) => button.onclick = () => void publishApprovalWorkflow(button.dataset.approvalWorkflowPublish || ""));
}

export async function refreshApprovalWorkflows(showError = false) {
  const root = qs<HTMLElement>("#approvalWorkflowList"); if (root) root.innerHTML = `<div class="approval-loading">正在同步审批流程</div>`;
  try { const data = await api<{ workflows: ApprovalWorkflow[] }>("/api/v1/approval-workflows"); approvalWorkflows = data.workflows || []; renderApprovalWorkflows(); }
  catch (error) { if (root) root.innerHTML = `<div class="approval-empty">审批流程加载失败</div>`; if (showError) toast(error instanceof Error ? error.message : "审批流程加载失败", "error"); }
}

async function showApprovalWorkflow(workflowId: string) {
  try {
    const { workflow } = await api<{ workflow: ApprovalWorkflow }>(`/api/v1/approval-workflows/${encodeURIComponent(workflowId)}`);
    openApprovalWorkflowDesigner(normalizeApprovalWorkflowClient(workflow));
  } catch (error) { toast(error instanceof Error ? error.message : "流程详情加载失败", "error"); }
}

async function publishApprovalWorkflow(workflowId: string) {
  const workflow = approvalWorkflows.find((item) => item.id === workflowId);
  try {
    const validation = await api<{ valid: boolean; issues: string[] }>(`/api/v1/approval-workflows/${encodeURIComponent(workflowId)}/validate`, { method: "POST", body: "{}" });
    if (!validation.valid) { toast(validation.issues?.[0] || "流程检查未通过", "error"); if (approvalDesignerWorkflow?.id === workflowId) showApprovalValidation(validation); return; }
  } catch (error) { toast(error instanceof Error ? error.message : "流程检查失败", "error"); return; }
  if (!await confirmAction({
    title: "发布审批流程",
    message: `将发布「${workflow?.name || "当前审批流程"}」。`,
    consequences: ["新申请会固定使用这个版本", "已经运行的审批实例不会切换版本"],
    confirmLabel: "发布流程",
    tone: "normal"
  })) return;
  try { await api(`/api/v1/approval-workflows/${encodeURIComponent(workflowId)}/publish`, { method: "POST", body: "{}" }); toast("审批流程已发布", "success"); approvalDesignerDirty = false; closeApprovalWorkflowDesigner(); await refreshApprovalWorkflows(); }
  catch (error) { toast(error instanceof Error ? error.message : "流程发布失败", "error"); }
}

function openApprovalWorkflowCreate() {
  openModal("新建审批流程", `<div class="form-grid"><div class="form-field full"><label>流程名称</label><input id="approvalWorkflowName" maxlength="160" placeholder="例如：大额报价审批"></div><div class="form-field"><label>流程编码</label><input id="approvalWorkflowCode" maxlength="80" placeholder="large_quote_approval"></div><div class="form-field"><label>业务类型</label><select id="approvalWorkflowBusiness"><option value="quote">报价审批</option><option value="discount">折扣审批</option><option value="customer_transfer">客户转移</option><option value="export">数据导出</option><option value="commission">提成审批</option><option value="custom">通用审批</option></select></div><div class="form-field full"><label>说明</label><div class="field-help">系统会建立开始、审批人和结束三个基础节点，进入设计器后可继续拖入条件、抄送和自动动作。</div></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="approvalWorkflowCreateConfirm">创建并设计</button>`);
  qs<HTMLButtonElement>("#approvalWorkflowCreateConfirm")?.addEventListener("click", async () => {
    const name = qs<HTMLInputElement>("#approvalWorkflowName")?.value.trim() || "";
    const code = qs<HTMLInputElement>("#approvalWorkflowCode")?.value.trim() || "";
    const businessType = qs<HTMLSelectElement>("#approvalWorkflowBusiness")?.value || "custom";
    if (!name || !code) { toast("请填写流程名称和编码", "error"); return; }
    const startId = approvalDesignerId("start"); const approvalId = approvalDesignerId("node"); const endId = approvalDesignerId("end");
    try {
      const data = await api<{ workflow: ApprovalWorkflow }>("/api/v1/approval-workflows", { method: "POST", body: JSON.stringify({ name, code, businessType, allowParallel: false, priority: 100, isDefault: false, triggerConfig: { enabled: true, conditions: [] }, formSchema: {}, nodes: [approvalDesignerNode(startId, "start", 80, 250), approvalDesignerNode(approvalId, "approval", 340, 250), approvalDesignerNode(endId, "end", 600, 250)], edges: [{ id: approvalDesignerId("edge"), source: startId, target: approvalId, label: "", priority: 10 }, { id: approvalDesignerId("edge"), source: approvalId, target: endId, label: "", priority: 20 }] }) });
      closeModal(); await refreshApprovalWorkflows(); openApprovalWorkflowDesigner(normalizeApprovalWorkflowClient(data.workflow));
    } catch (error) { toast(error instanceof Error ? error.message : "流程创建失败", "error"); }
  });
}

function approvalDesignerId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function approvalDesignerNode(id: string, type: ApprovalWorkflowNodeType, x: number, y: number): ApprovalWorkflowNode {
  const names: Record<ApprovalWorkflowNodeType, string> = { start: "发起申请", approval: "直属负责人审批", condition: "条件判断", cc: "抄送通知", automation: "自动动作", end: "流程结束" };
  return { id, type, name: names[type], position: { x, y }, approverStrategy: "requester_manager", approverConfig: {}, approvalMode: "single", config: {}, sortOrder: 1 };
}

function normalizeApprovalWorkflowClient(workflow: ApprovalWorkflow): ApprovalWorkflow {
  let nodes = (workflow.nodes || []).map((node, index) => ({
    ...node, type: node.type || "approval", position: node.position || { x: 300 + index * 220, y: 240 },
    approverStrategy: node.approverStrategy || "requester_manager", approverConfig: node.approverConfig || {},
    approvalMode: node.approvalMode || "single", config: node.config || {}, sortOrder: node.sortOrder || index + 1
  }));
  let edges = [...(workflow.edges || [])];
  if (!nodes.some((node) => node.type === "start")) nodes.unshift(approvalDesignerNode(approvalDesignerId("start"), "start", 70, 240));
  if (!nodes.some((node) => node.type === "end")) nodes.push(approvalDesignerNode(approvalDesignerId("end"), "end", 300 + nodes.length * 220, 240));
  if (!edges.length && nodes.length > 1) edges = nodes.slice(0, -1).map((node, index) => ({ id: approvalDesignerId("edge"), source: node.id, target: nodes[index + 1].id, label: "", priority: (index + 1) * 10 }));
  return { ...workflow, priority: workflow.priority || 100, triggerConfig: workflow.triggerConfig || { enabled: true, conditions: [] }, nodes, edges };
}

function approvalNodeMeta(node: ApprovalWorkflowNode) {
  const strategy = node.approverStrategy === "requester_manager" ? "申请人所在组织负责人" : node.approverStrategy === "permission_holder" ? "按权限匹配审批人" : node.approverStrategy === "role_in_tenant" ? "按角色匹配审批人" : "指定成员";
  const meta: Record<ApprovalWorkflowNodeType, { symbol: string; detail: string }> = {
    start: { symbol: "S", detail: "业务提交后进入流程" }, approval: { symbol: "✓", detail: strategy }, condition: { symbol: "◇", detail: "按业务字段选择分支" },
    cc: { symbol: "↗", detail: "向相关成员发送通知" }, automation: { symbol: "⚡", detail: "触发配置的业务动作" }, end: { symbol: "E", detail: "审批流程完成" }
  };
  return meta[node.type];
}

function markApprovalDesignerDirty() {
  approvalDesignerDirty = true;
  const stateEl = qs<HTMLElement>("#approvalDesignerSaveState");
  if (stateEl) { stateEl.textContent = "有未保存改动"; stateEl.classList.add("dirty"); }
}

function approvalDesignerPortAction(kind: "input" | "output", nodeId: string) {
  const workflow = approvalDesignerWorkflow; if (!workflow) return;
  if (kind === "output") { approvalDesignerConnectionSource = nodeId; renderApprovalDesigner(); return; }
  const source = approvalDesignerConnectionSource;
  if (!source) { toast("请先点击来源节点右侧的连接点", "error"); return; }
  if (source === nodeId || (workflow.edges || []).some((edge) => edge.source === source && edge.target === nodeId)) { toast("不能重复连接或连接到自身", "error"); return; }
  const edge: ApprovalWorkflowEdge = { id: approvalDesignerId("edge"), source, target: nodeId, label: "", priority: (workflow.edges || []).filter((item) => item.source === source).length * 10 + 10 };
  workflow.edges = [...(workflow.edges || []), edge]; approvalDesignerConnectionSource = ""; approvalDesignerSelectedNodeId = ""; approvalDesignerSelectedEdgeId = edge.id; markApprovalDesignerDirty(); renderApprovalDesigner(); renderApprovalInspector();
}

function renderApprovalDesigner() {
  const workflow = approvalDesignerWorkflow; const nodeLayer = qs<HTMLElement>("#approvalNodeLayer"); const edgeLayer = qs<SVGElement>("#approvalEdgeLayer");
  if (!workflow || !nodeLayer || !edgeLayer) return;
  const nodes = workflow.nodes || []; const edges = workflow.edges || []; const byId = new Map(nodes.map((node) => [node.id, node]));
  nodeLayer.innerHTML = nodes.map((node) => {
    const meta = approvalNodeMeta(node); const selected = node.id === approvalDesignerSelectedNodeId ? " selected" : "";
    return `<article class="approval-flow-node ${escapeHtml(node.type)}${selected}" data-approval-node="${escapeHtml(node.id)}" style="left:${Math.round(node.position.x)}px;top:${Math.round(node.position.y)}px"><header><i>${escapeHtml(meta.symbol)}</i><div><b>${escapeHtml(node.name)}</b><small>${escapeHtml(meta.detail)}</small></div></header>${node.type !== "start" ? `<button class="approval-node-port input" type="button" data-approval-port-input="${escapeHtml(node.id)}" aria-label="连接到该节点"><span aria-hidden="true">•</span></button>` : ""}${node.type !== "end" ? `<button class="approval-node-port output${approvalDesignerConnectionSource === node.id ? " active" : ""}" type="button" data-approval-port-output="${escapeHtml(node.id)}" aria-label="从该节点连线"><span aria-hidden="true">+</span></button>` : ""}</article>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-approval-port-output]", nodeLayer).forEach((button) => { button.onclick = (event) => { event.stopPropagation(); approvalDesignerPortAction("output", button.dataset.approvalPortOutput || ""); }; });
  qsa<HTMLButtonElement>("[data-approval-port-input]", nodeLayer).forEach((button) => { button.onclick = (event) => { event.stopPropagation(); approvalDesignerPortAction("input", button.dataset.approvalPortInput || ""); }; });
  const paths = edges.map((edge) => {
    const source = byId.get(edge.source); const target = byId.get(edge.target); if (!source || !target) return "";
    const sx = source.position.x + 174; const sy = source.position.y + 34; const tx = target.position.x; const ty = target.position.y + 34; const bend = Math.max(58, Math.abs(tx - sx) * .48);
    const d = `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`; const selected = edge.id === approvalDesignerSelectedEdgeId;
    const label = edge.label || (edge.condition ? `${edge.condition.field} ${edge.condition.operator}` : ""); const lx = (sx + tx) / 2; const ly = (sy + ty) / 2 - 7;
    return `<path class="approval-edge${selected ? " selected" : ""}" d="${d}" marker-end="url(#approvalArrow)"></path><path class="approval-edge-hit" d="${d}" data-approval-edge="${escapeHtml(edge.id)}"></path>${label ? `<text class="approval-edge-label" x="${lx}" y="${ly}" text-anchor="middle">${escapeHtml(label)}</text>` : ""}`;
  }).join("");
  edgeLayer.innerHTML = `<defs><marker id="approvalArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#8fa39c"></path></marker></defs>${paths}`;
  qsa<HTMLElement>("[data-approval-node]", nodeLayer).forEach((element) => setupApprovalNodeDrag(element));
  qsa<SVGPathElement>("[data-approval-edge]", edgeLayer).forEach((path) => path.addEventListener("click", (event) => { event.stopPropagation(); approvalDesignerSelectedEdgeId = path.dataset.approvalEdge || ""; approvalDesignerSelectedNodeId = ""; renderApprovalDesigner(); renderApprovalInspector(); }));
}

function setupApprovalNodeDrag(element: HTMLElement) {
  element.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const output = target.closest<HTMLButtonElement>("[data-approval-port-output]");
    if (output) { event.stopPropagation(); approvalDesignerConnectionSource = output.dataset.approvalPortOutput || ""; qsa<HTMLElement>(".approval-node-port.output", qs("#approvalNodeLayer") || document).forEach((port) => port.classList.toggle("active", port === output)); return; }
    const input = target.closest<HTMLButtonElement>("[data-approval-port-input]");
    if (input) {
      event.stopPropagation(); const workflow = approvalDesignerWorkflow; const source = approvalDesignerConnectionSource; const targetId = input.dataset.approvalPortInput || ""; if (!workflow) return;
      if (!source) { toast("请先点击来源节点右侧的连接点", "error"); return; }
      if (source === targetId || (workflow.edges || []).some((edge) => edge.source === source && edge.target === targetId)) { toast("不能重复连接或连接到自身", "error"); return; }
      const edge: ApprovalWorkflowEdge = { id: approvalDesignerId("edge"), source, target: targetId, label: "", priority: (workflow.edges || []).filter((item) => item.source === source).length * 10 + 10 };
      workflow.edges = [...(workflow.edges || []), edge]; approvalDesignerConnectionSource = ""; approvalDesignerSelectedNodeId = ""; approvalDesignerSelectedEdgeId = edge.id; markApprovalDesignerDirty(); renderApprovalDesigner(); renderApprovalInspector(); return;
    }
    approvalDesignerSelectedNodeId = element.dataset.approvalNode || ""; approvalDesignerSelectedEdgeId = ""; renderApprovalDesigner(); renderApprovalInspector();
  });
  element.addEventListener("pointerdown", (event) => {
    const outputPort = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-approval-port-output]");
    if (outputPort) { event.stopPropagation(); approvalDesignerConnectionSource = outputPort.dataset.approvalPortOutput || ""; qsa<HTMLElement>(".approval-node-port.output", qs("#approvalNodeLayer") || document).forEach((port) => port.classList.toggle("active", port === outputPort)); return; }
    if ((event.target as HTMLElement).closest("button")) return;
    const workflow = approvalDesignerWorkflow; const node = workflow?.nodes?.find((item) => item.id === element.dataset.approvalNode); if (!workflow || !node) return;
    approvalDesignerSelectedNodeId = node.id; approvalDesignerSelectedEdgeId = ""; renderApprovalInspector();
    const startX = event.clientX; const startY = event.clientY; const originX = node.position.x; const originY = node.position.y;
    element.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => { node.position = { x: Math.max(18, Math.min(1380, originX + moveEvent.clientX - startX)), y: Math.max(64, Math.min(880, originY + moveEvent.clientY - startY)) }; element.style.left = `${node.position.x}px`; element.style.top = `${node.position.y}px`; markApprovalDesignerDirty(); renderApprovalEdgesOnly(); };
    const up = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", up); renderApprovalDesigner(); };
    element.addEventListener("pointermove", move); element.addEventListener("pointerup", up);
    qsa<HTMLElement>(".approval-flow-node", qs("#approvalNodeLayer") || document).forEach((item) => item.classList.toggle("selected", item === element));
  });
}

function renderApprovalEdgesOnly() {
  const workflow = approvalDesignerWorkflow; const edgeLayer = qs<SVGElement>("#approvalEdgeLayer"); if (!workflow || !edgeLayer) return;
  const byId = new Map((workflow.nodes || []).map((node) => [node.id, node]));
  qsa<SVGPathElement>(".approval-edge,.approval-edge-hit", edgeLayer).forEach((path, index) => {
    const edge = (workflow.edges || [])[Math.floor(index / 2)]; const source = edge && byId.get(edge.source); const target = edge && byId.get(edge.target); if (!source || !target) return;
    const sx = source.position.x + 174; const sy = source.position.y + 34; const tx = target.position.x; const ty = target.position.y + 34; const bend = Math.max(58, Math.abs(tx - sx) * .48);
    path.setAttribute("d", `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`);
  });
}

function renderApprovalInspector(mode: "selection" | "workflow" = "selection") {
  const root = qs<HTMLElement>("#approvalInspector"); const workflow = approvalDesignerWorkflow; if (!root || !workflow) return;
  const node = workflow.nodes?.find((item) => item.id === approvalDesignerSelectedNodeId); const edge = workflow.edges?.find((item) => item.id === approvalDesignerSelectedEdgeId);
  if (mode === "workflow") { renderApprovalWorkflowSettings(root, workflow); return; }
  if (edge) { renderApprovalEdgeSettings(root, edge); return; }
  if (!node) { root.innerHTML = `<div class="approval-inspector-empty"><i>↖</i><b>选择一个节点</b><span>节点的审批人、条件和通知规则会显示在这里。</span></div>`; return; }
  const strategyValue = node.approverStrategy === "permission_holder" ? String(node.approverConfig.permissionCode || "approval.task.act") : node.approverStrategy === "role_in_tenant" ? String(node.approverConfig.roleCode || "") : node.approverStrategy === "specific_member" ? (Array.isArray(node.approverConfig.membershipIds) ? node.approverConfig.membershipIds.join(",") : "") : "";
  root.innerHTML = `<div class="approval-inspector-form"><header><div><span>节点属性</span><h2>${escapeHtml(node.name)}</h2></div><em>${escapeHtml(node.type)}</em></header><label class="approval-inspector-field"><span>节点名称</span><input id="approvalInspectorNodeName" maxlength="120" value="${escapeHtml(node.name)}"></label>${node.type === "approval" ? `<label class="approval-inspector-field"><span>审批人来源</span><select id="approvalInspectorStrategy"><option value="requester_manager"${node.approverStrategy === "requester_manager" ? " selected" : ""}>申请人所在组织负责人</option><option value="permission_holder"${node.approverStrategy === "permission_holder" ? " selected" : ""}>拥有指定权限的成员</option><option value="role_in_tenant"${node.approverStrategy === "role_in_tenant" ? " selected" : ""}>指定角色成员</option><option value="specific_member"${node.approverStrategy === "specific_member" ? " selected" : ""}>指定成员</option></select><small>人员来自成员、角色、权限和组织关系配置。</small></label><label class="approval-inspector-field"><span>审批规则</span><select id="approvalInspectorMode"><option value="single"${node.approvalMode === "single" ? " selected" : ""}>单人审批</option><option value="all"${node.approvalMode === "all" ? " selected" : ""}>会签：所有人同意</option><option value="any"${node.approvalMode === "any" ? " selected" : ""}>或签：任一人同意</option></select></label><label class="approval-inspector-field" id="approvalInspectorStrategyValueWrap"><span>策略参数</span><input id="approvalInspectorStrategyValue" maxlength="300" value="${escapeHtml(strategyValue)}" placeholder="权限编码 / 角色编码 / 成员 ID"><small>多个成员 ID 使用英文逗号分隔。</small></label><label class="approval-inspector-toggle"><input id="approvalInspectorSelf" type="checkbox"${node.approverConfig.allowSelfApproval === true ? " checked" : ""}><span><b>允许申请人审批自己提交的申请</b><small>默认关闭，避免同一人提交并通过。</small></span></label>` : node.type === "cc" ? `<label class="approval-inspector-field"><span>抄送对象</span><input id="approvalInspectorConfigValue" value="${escapeHtml(String(node.config.target || ""))}" placeholder="角色编码或成员 ID"></label>` : node.type === "automation" ? `<label class="approval-inspector-field"><span>业务动作</span><select id="approvalInspectorConfigValue"><option value="notify"${node.config.action === "notify" ? " selected" : ""}>发送站内通知</option><option value="update_status"${node.config.action === "update_status" ? " selected" : ""}>更新业务状态</option><option value="webhook"${node.config.action === "webhook" ? " selected" : ""}>触发已授权集成</option></select><small>动作进入可靠事件队列，由对应业务模块消费。</small></label>` : `<div class="approval-palette-note"><b>${node.type === "condition" ? "分支条件配置在线条上" : "系统节点"}</b><span>${node.type === "condition" ? "选中条件节点发出的连线，为每个分支填写字段、运算符和值，并保留一个默认分支。" : "开始和结束节点用于界定流程边界。"}</span></div>`}</div>`;
  qs<HTMLInputElement>("#approvalInspectorNodeName")?.addEventListener("change", (event) => { node.name = (event.currentTarget as HTMLInputElement).value.trim() || node.name; markApprovalDesignerDirty(); renderApprovalDesigner(); renderApprovalInspector(); });
  qs<HTMLSelectElement>("#approvalInspectorStrategy")?.addEventListener("change", (event) => { node.approverStrategy = (event.currentTarget as HTMLSelectElement).value as ApprovalWorkflowNode["approverStrategy"]; node.approverConfig = {}; markApprovalDesignerDirty(); renderApprovalDesigner(); renderApprovalInspector(); });
  qs<HTMLSelectElement>("#approvalInspectorMode")?.addEventListener("change", (event) => { node.approvalMode = (event.currentTarget as HTMLSelectElement).value as ApprovalWorkflowNode["approvalMode"]; markApprovalDesignerDirty(); });
  qs<HTMLInputElement>("#approvalInspectorStrategyValue")?.addEventListener("change", (event) => { const value = (event.currentTarget as HTMLInputElement).value.trim(); node.approverConfig = node.approverStrategy === "permission_holder" ? { ...node.approverConfig, permissionCode: value } : node.approverStrategy === "role_in_tenant" ? { ...node.approverConfig, roleCode: value } : node.approverStrategy === "specific_member" ? { ...node.approverConfig, membershipIds: value.split(",").map((item) => item.trim()).filter(Boolean) } : node.approverConfig; markApprovalDesignerDirty(); });
  qs<HTMLInputElement>("#approvalInspectorSelf")?.addEventListener("change", (event) => { node.approverConfig = { ...node.approverConfig, allowSelfApproval: (event.currentTarget as HTMLInputElement).checked }; markApprovalDesignerDirty(); });
  qs<HTMLInputElement>("#approvalInspectorConfigValue")?.addEventListener("change", (event) => { node.config = { ...node.config, target: (event.currentTarget as HTMLInputElement).value.trim() }; markApprovalDesignerDirty(); });
  qs<HTMLSelectElement>("#approvalInspectorConfigValue")?.addEventListener("change", (event) => { node.config = { ...node.config, action: (event.currentTarget as HTMLSelectElement).value }; markApprovalDesignerDirty(); });
}

function renderApprovalEdgeSettings(root: HTMLElement, edge: ApprovalWorkflowEdge) {
  const isDefault = !edge.condition;
  root.innerHTML = `<div class="approval-inspector-form"><header><div><span>连线属性</span><h2>${isDefault ? "默认分支" : "条件分支"}</h2></div><em>EDGE</em></header><label class="approval-inspector-field"><span>分支名称</span><input id="approvalInspectorEdgeLabel" maxlength="80" value="${escapeHtml(edge.label || "")}" placeholder="例如：金额超过 5 万"></label><label class="approval-inspector-toggle"><input id="approvalInspectorEdgeDefault" type="checkbox"${isDefault ? " checked" : ""}><span><b>设为默认分支</b><small>其它条件都不满足时走这条线。</small></span></label><label class="approval-inspector-field"><span>业务字段</span><input id="approvalInspectorEdgeField" value="${escapeHtml(edge.condition?.field || "amount")}"${isDefault ? " disabled" : ""} placeholder="amount / customer.grade"></label><label class="approval-inspector-field"><span>判断方式</span><select id="approvalInspectorEdgeOperator"${isDefault ? " disabled" : ""}><option value="greater_than">大于</option><option value="greater_or_equal">大于等于</option><option value="less_than">小于</option><option value="equals">等于</option><option value="not_equals">不等于</option><option value="contains">包含</option><option value="in">属于列表</option><option value="exists">已填写</option></select></label><label class="approval-inspector-field"><span>比较值</span><input id="approvalInspectorEdgeValue" value="${escapeHtml(String(edge.condition?.value ?? ""))}"${isDefault ? " disabled" : ""} placeholder="50000"></label></div>`;
  const operator = qs<HTMLSelectElement>("#approvalInspectorEdgeOperator"); if (operator && edge.condition) operator.value = edge.condition.operator;
  const sync = () => { const makeDefault = qs<HTMLInputElement>("#approvalInspectorEdgeDefault")?.checked; edge.label = qs<HTMLInputElement>("#approvalInspectorEdgeLabel")?.value.trim() || ""; edge.condition = makeDefault ? undefined : { field: qs<HTMLInputElement>("#approvalInspectorEdgeField")?.value.trim() || "amount", operator: (qs<HTMLSelectElement>("#approvalInspectorEdgeOperator")?.value || "equals") as NonNullable<ApprovalWorkflowEdge["condition"]>["operator"], value: qs<HTMLInputElement>("#approvalInspectorEdgeValue")?.value ?? "" }; markApprovalDesignerDirty(); renderApprovalDesigner(); if (makeDefault !== isDefault) renderApprovalInspector(); };
  ["#approvalInspectorEdgeLabel", "#approvalInspectorEdgeDefault", "#approvalInspectorEdgeField", "#approvalInspectorEdgeOperator", "#approvalInspectorEdgeValue"].forEach((selector) => qs<HTMLElement>(selector)?.addEventListener("change", sync));
}

function renderApprovalWorkflowSettings(root: HTMLElement, workflow: ApprovalWorkflow) {
  const conditions = Array.isArray(workflow.triggerConfig?.conditions) ? workflow.triggerConfig.conditions as Array<Record<string, unknown>> : []; const condition = conditions[0] || {};
  root.innerHTML = `<div class="approval-inspector-form"><header><div><span>流程设置</span><h2>${escapeHtml(workflow.name)}</h2></div><em>V${workflow.versionNo || 1}</em></header><label class="approval-inspector-field"><span>流程名称</span><input id="approvalInspectorWorkflowName" maxlength="160" value="${escapeHtml(workflow.name)}"></label><label class="approval-inspector-field"><span>业务类型</span><select id="approvalInspectorBusiness"><option value="quote">报价审批</option><option value="discount">折扣审批</option><option value="customer_transfer">客户转移</option><option value="export">数据导出</option><option value="commission">提成审批</option><option value="custom">通用审批</option></select></label><label class="approval-inspector-field"><span>匹配优先级</span><input id="approvalInspectorPriority" type="number" min="1" max="999" value="${workflow.priority || 100}"><small>数字越小越先匹配。</small></label><label class="approval-inspector-toggle"><input id="approvalInspectorDefault" type="checkbox"${workflow.isDefault ? " checked" : ""}><span><b>作为该业务类型的兜底流程</b><small>没有其它条件命中时使用。</small></span></label><label class="approval-inspector-field"><span>自动匹配字段</span><input id="approvalInspectorTriggerField" value="${escapeHtml(String(condition.field || ""))}" placeholder="例如 amount；不填则始终匹配"></label><label class="approval-inspector-field"><span>匹配方式</span><select id="approvalInspectorTriggerOperator"><option value="greater_than">大于</option><option value="greater_or_equal">大于等于</option><option value="less_than">小于</option><option value="equals">等于</option><option value="not_equals">不等于</option><option value="contains">包含</option></select></label><label class="approval-inspector-field"><span>匹配值</span><input id="approvalInspectorTriggerValue" value="${escapeHtml(String(condition.value ?? ""))}" placeholder="例如 50000"></label></div>`;
  const business = qs<HTMLSelectElement>("#approvalInspectorBusiness"); if (business) business.value = workflow.businessType;
  const triggerOperator = qs<HTMLSelectElement>("#approvalInspectorTriggerOperator"); if (triggerOperator) triggerOperator.value = String(condition.operator || "greater_than");
  const sync = () => { workflow.name = qs<HTMLInputElement>("#approvalInspectorWorkflowName")?.value.trim() || workflow.name; workflow.businessType = qs<HTMLSelectElement>("#approvalInspectorBusiness")?.value || workflow.businessType; workflow.priority = Math.max(1, Number(qs<HTMLInputElement>("#approvalInspectorPriority")?.value || 100)); workflow.isDefault = Boolean(qs<HTMLInputElement>("#approvalInspectorDefault")?.checked); const field = qs<HTMLInputElement>("#approvalInspectorTriggerField")?.value.trim() || ""; workflow.triggerConfig = { enabled: true, conditions: field ? [{ field, operator: qs<HTMLSelectElement>("#approvalInspectorTriggerOperator")?.value || "equals", value: qs<HTMLInputElement>("#approvalInspectorTriggerValue")?.value ?? "" }] : [] }; markApprovalDesignerDirty(); const title = qs<HTMLElement>("#approvalDesignerTitle"); if (title) title.textContent = workflow.name; };
  ["#approvalInspectorWorkflowName", "#approvalInspectorBusiness", "#approvalInspectorPriority", "#approvalInspectorDefault", "#approvalInspectorTriggerField", "#approvalInspectorTriggerOperator", "#approvalInspectorTriggerValue"].forEach((selector) => qs<HTMLElement>(selector)?.addEventListener("change", sync));
}

function openApprovalWorkflowDesigner(workflow: ApprovalWorkflow) {
  approvalDesignerWorkflow = workflow; approvalDesignerSelectedNodeId = ""; approvalDesignerSelectedEdgeId = ""; approvalDesignerConnectionSource = ""; approvalDesignerDirty = false;
  const library = qs<HTMLElement>("#approvalWorkflowLibrary"); const designer = qs<HTMLElement>("#approvalWorkflowDesigner"); if (library) library.hidden = true; if (designer) designer.hidden = false;
  const title = qs<HTMLElement>("#approvalDesignerTitle"); const saveState = qs<HTMLElement>("#approvalDesignerSaveState"); if (title) title.textContent = workflow.name; if (saveState) { saveState.textContent = workflow.draftVersionId || workflow.status === "draft" ? "草稿待发布" : `已发布 V${workflow.versionNo || 1}`; saveState.classList.remove("dirty"); }
  renderApprovalDesigner(); renderApprovalInspector(); setTimeout(() => fitApprovalDesignerCanvas(), 30);
}

function closeApprovalWorkflowDesigner() { const library = qs<HTMLElement>("#approvalWorkflowLibrary"); const designer = qs<HTMLElement>("#approvalWorkflowDesigner"); if (library) library.hidden = false; if (designer) designer.hidden = true; approvalDesignerWorkflow = null; }

async function requestCloseApprovalWorkflowDesigner() {
  if (approvalDesignerDirty && !await confirmAction({ title: "离开流程设计器", message: "当前还有未保存的修改。", consequences: ["离开后，本次画布调整不会保留"], confirmLabel: "放弃修改", tone: "warning" })) return;
  closeApprovalWorkflowDesigner(); await refreshApprovalWorkflows();
}

async function saveApprovalWorkflow(showToast = true) {
  const workflow = approvalDesignerWorkflow; if (!workflow) return false;
  try {
    const nodes = (workflow.nodes || []).map((node, index) => ({ ...node, sortOrder: index + 1 }));
    const data = await api<{ workflow: ApprovalWorkflow }>(`/api/v1/approval-workflows/${encodeURIComponent(workflow.id)}`, { method: "PUT", body: JSON.stringify({ name: workflow.name, code: workflow.code, businessType: workflow.businessType, allowParallel: workflow.allowParallel || false, priority: workflow.priority || 100, isDefault: workflow.isDefault || false, triggerConfig: workflow.triggerConfig || {}, formSchema: workflow.formSchema || {}, nodes, edges: workflow.edges || [] }) });
    approvalDesignerWorkflow = normalizeApprovalWorkflowClient(data.workflow); approvalDesignerDirty = false; const stateEl = qs<HTMLElement>("#approvalDesignerSaveState"); if (stateEl) { stateEl.textContent = "草稿已保存"; stateEl.classList.remove("dirty"); } renderApprovalDesigner(); renderApprovalInspector(); if (showToast) toast("审批流草稿已保存", "success"); return true;
  } catch (error) { toast(error instanceof Error ? error.message : "审批流保存失败", "error"); return false; }
}

function showApprovalValidation(result: { valid: boolean; issues: string[] }) {
  const drawer = qs<HTMLElement>("#approvalValidationDrawer"); const content = qs<HTMLElement>("#approvalValidationContent"); if (!drawer || !content) return;
  drawer.hidden = false; content.innerHTML = result.valid ? `<div class="approval-validation-ok">流程结构完整，可以发布。</div>` : (result.issues || []).map((issue) => `<div class="approval-validation-issue">${escapeHtml(issue)}</div>`).join("");
}

async function validateApprovalDesigner() { const workflow = approvalDesignerWorkflow; if (!workflow || !await saveApprovalWorkflow(false)) return null; try { const result = await api<{ valid: boolean; issues: string[] }>(`/api/v1/approval-workflows/${encodeURIComponent(workflow.id)}/validate`, { method: "POST", body: "{}" }); showApprovalValidation(result); return result; } catch (error) { toast(error instanceof Error ? error.message : "流程检查失败", "error"); return null; } }

function fitApprovalDesignerCanvas() { const canvas = qs<HTMLElement>("#approvalCanvas"); const nodes = approvalDesignerWorkflow?.nodes || []; if (!canvas || !nodes.length) return; const minX = Math.min(...nodes.map((node) => node.position.x)); const minY = Math.min(...nodes.map((node) => node.position.y)); canvas.scrollTo({ left: Math.max(0, minX - 90), top: Math.max(0, minY - 100), behavior: "smooth" }); }

function deleteApprovalDesignerSelection() {
  const workflow = approvalDesignerWorkflow; if (!workflow) return;
  if (approvalDesignerSelectedEdgeId) { workflow.edges = (workflow.edges || []).filter((edge) => edge.id !== approvalDesignerSelectedEdgeId); approvalDesignerSelectedEdgeId = ""; }
  else if (approvalDesignerSelectedNodeId) { const node = workflow.nodes?.find((item) => item.id === approvalDesignerSelectedNodeId); if (!node || node.type === "start" || node.type === "end") { toast("开始和结束节点不能删除", "error"); return; } workflow.nodes = (workflow.nodes || []).filter((item) => item.id !== node.id); workflow.edges = (workflow.edges || []).filter((edge) => edge.source !== node.id && edge.target !== node.id); approvalDesignerSelectedNodeId = ""; }
  else { toast("请先选择节点或连线", "error"); return; }
  markApprovalDesignerDirty(); renderApprovalDesigner(); renderApprovalInspector();
}

export function setupApprovalEvents() {
  qs<HTMLButtonElement>("#approvalRefreshButton")?.addEventListener("click", () => void refreshApprovalCenter(true));
  qs<HTMLButtonElement>("#approvalCreateInstanceButton")?.addEventListener("click", openApprovalInstanceCreate);
  qs<HTMLButtonElement>("#approvalWorkflowRefreshButton")?.addEventListener("click", () => void refreshApprovalWorkflows(true));
  qs<HTMLButtonElement>("#approvalWorkflowCreateButton")?.addEventListener("click", openApprovalWorkflowCreate);
  qs<HTMLButtonElement>("#approvalDesignerBack")?.addEventListener("click", () => void requestCloseApprovalWorkflowDesigner());
  qs<HTMLButtonElement>("#approvalDesignerSettings")?.addEventListener("click", () => { approvalDesignerSelectedNodeId = ""; approvalDesignerSelectedEdgeId = ""; renderApprovalDesigner(); renderApprovalInspector("workflow"); });
  qs<HTMLButtonElement>("#approvalDesignerSave")?.addEventListener("click", () => void saveApprovalWorkflow());
  qs<HTMLButtonElement>("#approvalDesignerValidate")?.addEventListener("click", () => void validateApprovalDesigner());
  qs<HTMLButtonElement>("#approvalDesignerPublish")?.addEventListener("click", async () => { const workflow = approvalDesignerWorkflow; if (!workflow) return; const result = await validateApprovalDesigner(); if (result?.valid) await publishApprovalWorkflow(workflow.id); });
  qs<HTMLButtonElement>("#approvalDesignerDelete")?.addEventListener("click", deleteApprovalDesignerSelection);
  qs<HTMLButtonElement>("#approvalDesignerFit")?.addEventListener("click", fitApprovalDesignerCanvas);
  qs<HTMLButtonElement>("#approvalValidationClose")?.addEventListener("click", () => { const drawer = qs<HTMLElement>("#approvalValidationDrawer"); if (drawer) drawer.hidden = true; });
  qsa<HTMLButtonElement>("[data-approval-palette]").forEach((button) => {
    button.addEventListener("dragstart", (event) => event.dataTransfer?.setData("application/x-goodjob-approval-node", button.dataset.approvalPalette || "approval"));
    button.addEventListener("click", () => {
      const workflow = approvalDesignerWorkflow; const canvas = qs<HTMLElement>("#approvalCanvas"); const type = button.dataset.approvalPalette as ApprovalWorkflowNodeType; if (!workflow || !canvas) return;
      const node = approvalDesignerNode(approvalDesignerId("node"), type, canvas.scrollLeft + Math.max(80, canvas.clientWidth / 2 - 87), canvas.scrollTop + Math.max(110, canvas.clientHeight / 2 - 34));
      workflow.nodes = [...(workflow.nodes || []), node]; approvalDesignerSelectedNodeId = node.id; approvalDesignerSelectedEdgeId = ""; markApprovalDesignerDirty(); renderApprovalDesigner(); renderApprovalInspector();
    });
  });
  const canvas = qs<HTMLElement>("#approvalCanvas");
  canvas?.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; });
  canvas?.addEventListener("drop", (event) => {
    event.preventDefault(); const workflow = approvalDesignerWorkflow; const type = event.dataTransfer?.getData("application/x-goodjob-approval-node") as ApprovalWorkflowNodeType; if (!workflow || !["approval", "condition", "cc", "automation"].includes(type)) return;
    const rect = canvas.getBoundingClientRect(); const node = approvalDesignerNode(approvalDesignerId("node"), type, Math.max(20, event.clientX - rect.left + canvas.scrollLeft - 87), Math.max(64, event.clientY - rect.top + canvas.scrollTop - 34));
    workflow.nodes = [...(workflow.nodes || []), node]; approvalDesignerSelectedNodeId = node.id; approvalDesignerSelectedEdgeId = ""; markApprovalDesignerDirty(); renderApprovalDesigner(); renderApprovalInspector();
  });
  canvas?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const output = target.closest<HTMLButtonElement>("[data-approval-port-output]");
    if (output) { approvalDesignerConnectionSource = output.dataset.approvalPortOutput || ""; renderApprovalDesigner(); return; }
    const input = target.closest<HTMLButtonElement>("[data-approval-port-input]");
    if (input) {
      const workflow = approvalDesignerWorkflow; const source = approvalDesignerConnectionSource; const targetId = input.dataset.approvalPortInput || ""; if (!workflow) return;
      if (!source) { toast("请先点击来源节点右侧的连接点", "error"); return; }
      if (source === targetId || (workflow.edges || []).some((edge) => edge.source === source && edge.target === targetId)) { toast("不能重复连接或连接到自身", "error"); return; }
      const edge: ApprovalWorkflowEdge = { id: approvalDesignerId("edge"), source, target: targetId, label: "", priority: (workflow.edges || []).filter((item) => item.source === source).length * 10 + 10 };
      workflow.edges = [...(workflow.edges || []), edge]; approvalDesignerConnectionSource = ""; approvalDesignerSelectedNodeId = ""; approvalDesignerSelectedEdgeId = edge.id; markApprovalDesignerDirty(); renderApprovalDesigner(); renderApprovalInspector(); return;
    }
    if (target.closest(".approval-flow-node") || (event.target as SVGElement).hasAttribute?.("data-approval-edge")) return;
    approvalDesignerSelectedNodeId = ""; approvalDesignerSelectedEdgeId = ""; approvalDesignerConnectionSource = ""; renderApprovalDesigner(); renderApprovalInspector();
  });
  qsa<HTMLButtonElement>("[data-approval-center-tab]").forEach((button) => button.addEventListener("click", () => {
    approvalCenterTab = button.dataset.approvalCenterTab as typeof approvalCenterTab;
    qsa<HTMLButtonElement>("[data-approval-center-tab]").forEach((item) => item.classList.toggle("active", item === button));
    selectedApprovalInstanceId = ""; renderApprovalCenterList();
    const detail = qs<HTMLElement>("#approvalCenterDetail"); if (detail) detail.innerHTML = `<div class="approval-detail-empty">从左侧选择一项查看审批内容</div>`;
  }));
}

export async function refreshPlatformOperations() {
  const calls: Array<Promise<void>> = [];
  if (hasIamCapability("platform.dashboard.read")) calls.push(api<{ metrics: Record<string, number>; generatedAt: string }>("/api/platform/v1/overview").then((data) => { platformOverview = data; }));
  if (hasIamCapability("platform.tenant.metadata.read")) calls.push(api<{ tenants: PlatformTenant[] }>("/api/platform/v1/tenants").then((data) => { platformTenants = data.tenants || []; }));
  if (hasIamCapability("platform.support.request.create")) calls.push(api<{ requests: PlatformSupportRequest[] }>("/api/platform/v1/support-requests").then((data) => { platformSupportRequests = data.requests || []; }));
  if (hasIamCapability("platform.operator.read")) calls.push(api<{ operators: PlatformOperator[] }>("/api/platform/v1/operators").then((data) => { platformOperators = data.operators || []; }));
  if (hasIamCapability("platform.health.read")) calls.push(api<{ services: Array<Record<string, unknown>> }>("/api/platform/v1/health").then((data) => { platformHealthServices = data.services || []; }));
  if (hasIamCapability("platform.audit.read")) calls.push(api<{ events: PlatformAuditEvent[] }>("/api/platform/v1/audit?limit=100").then((data) => { platformAuditEvents = data.events || []; }));
  const results = await Promise.allSettled(calls);
  const failed = results.find((result) => result.status === "rejected");
  renderPlatformOperations();
  if (failed?.status === "rejected") toast(failed.reason instanceof Error ? failed.reason.message : "部分平台数据读取失败", "error");
}

async function runPlatformMutation(action: () => Promise<unknown>, successMessage: string) {
  try {
    await action();
    closeModal();
    toast(successMessage);
    await refreshPlatformOperations();
  } catch (error) {
    toast(error instanceof Error ? error.message : "平台操作失败", "error");
  }
}

function openPlatformTenantCreator() {
  openModal("创建公司", `<div class="form-grid"><div class="form-field full"><label>公司名称</label><input id="platformTenantName" maxlength="200"></div><div class="form-field"><label>公司编码</label><input id="platformTenantCode" maxlength="64" placeholder="例如 acme-trading"></div><div class="form-field"><label>席位上限</label><input id="platformTenantSeats" type="number" min="1" max="10000" value="50"></div><div class="form-field full"><label>开通原因</label><textarea id="platformTenantReason" maxlength="500">公测公司开通</textarea></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="platformTenantSave">创建</button>`);
  qs("#platformTenantSave")?.addEventListener("click", () => void runPlatformMutation(() => api("/api/platform/v1/tenants", { method: "POST", body: JSON.stringify({ name: qs<HTMLInputElement>("#platformTenantName")?.value.trim(), code: qs<HTMLInputElement>("#platformTenantCode")?.value.trim(), seatLimit: Number(qs<HTMLInputElement>("#platformTenantSeats")?.value || 50), reason: qs<HTMLTextAreaElement>("#platformTenantReason")?.value.trim() }) }), "公司已创建"));
}

function openPlatformTenantAdminCreator(tenantId: string) {
  openModal("设置公司管理员", `<div class="form-grid"><div class="form-field"><label>管理员姓名</label><input id="platformAdminName" maxlength="100"></div><div class="form-field"><label>登录邮箱</label><input id="platformAdminEmail" type="email" maxlength="180"></div><div class="form-field full"><label>初始密码</label><input id="platformAdminPassword" type="password" minlength="12" maxlength="200" autocomplete="new-password"></div><div class="form-field full"><label>设置原因</label><textarea id="platformAdminReason" maxlength="500">公司管理员初始化</textarea></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="platformAdminSave">确认设置</button>`);
  qs("#platformAdminSave")?.addEventListener("click", () => void runPlatformMutation(() => api(`/api/platform/v1/tenants/${encodeURIComponent(tenantId)}/bootstrap-admin`, { method: "POST", body: JSON.stringify({ name: qs<HTMLInputElement>("#platformAdminName")?.value.trim(), email: qs<HTMLInputElement>("#platformAdminEmail")?.value.trim(), password: qs<HTMLInputElement>("#platformAdminPassword")?.value || "", reason: qs<HTMLTextAreaElement>("#platformAdminReason")?.value.trim() }) }), "公司管理员已设置"));
}

function openPlatformSupportCreator() {
  const tenantOptions = platformTenants.filter((tenant) => tenant.status !== "closed").map((tenant) => `<option value="${escapeHtml(tenant.id)}">${escapeHtml(tenant.name)}</option>`).join("");
  openModal("创建支持访问申请", `<div class="form-grid"><div class="form-field full"><label>目标公司</label><select id="platformSupportTenant">${tenantOptions}</select></div><div class="form-field"><label>工单号</label><input id="platformSupportTicket" maxlength="120"></div><div class="form-field"><label>访问时长</label><select id="platformSupportMinutes"><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="60">60 分钟</option></select></div><div class="form-field full"><label>只读范围</label><div><label><input type="checkbox" data-platform-support-permission value="customer.read" checked> 客户</label>　<label><input type="checkbox" data-platform-support-permission value="lead.read"> 线索</label>　<label><input type="checkbox" data-platform-support-permission value="deal.read"> 商机</label>　<label><input type="checkbox" data-platform-support-permission value="daily_report.read"> 日报</label></div></div><div class="form-field full"><label>访问原因</label><textarea id="platformSupportReason" maxlength="500" placeholder="说明客户问题和排查目的"></textarea></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="platformSupportSave">提交审批</button>`);
  qs("#platformSupportSave")?.addEventListener("click", () => void runPlatformMutation(() => api("/api/platform/v1/support-requests", { method: "POST", body: JSON.stringify({ tenantId: qs<HTMLSelectElement>("#platformSupportTenant")?.value, ticketNo: qs<HTMLInputElement>("#platformSupportTicket")?.value.trim(), reason: qs<HTMLTextAreaElement>("#platformSupportReason")?.value.trim(), requestedMinutes: Number(qs<HTMLSelectElement>("#platformSupportMinutes")?.value || 15), permissionCodes: qsa<HTMLInputElement>("[data-platform-support-permission]:checked").map((item) => item.value) }) }), "支持访问申请已提交"));
}

function openPlatformReasonAction(title: string, placeholder: string, action: (reason: string) => Promise<unknown>, successMessage: string) {
  openModal(title, `<div class="form-field"><label>操作原因</label><textarea id="platformActionReason" maxlength="500" placeholder="${escapeHtml(placeholder)}"></textarea></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="platformActionConfirm">确认</button>`);
  qs("#platformActionConfirm")?.addEventListener("click", () => void runPlatformMutation(() => action(qs<HTMLTextAreaElement>("#platformActionReason")?.value.trim() || ""), successMessage));
}

async function openPlatformSupportData(sessionId: string) {
  const request = platformSupportRequests.find((item) => item.session?.id === sessionId);
  if (!request) return;
  const resourceByPermission: Record<string, string> = { "customer.read": "customers", "lead.read": "leads", "deal.read": "deals", "daily_report.read": "daily-reports" };
  const resource = resourceByPermission[request.permissionCodes[0]] || "customers";
  openModal(`支持视图 · ${request.tenantName}`, `<div class="platform-loading">正在读取限时支持数据</div>`, `<button class="btn" data-modal-close>关闭</button>`);
  try {
    const result = await api<{ permissionCode: string; items: Array<Record<string, unknown>> }>(`/api/platform/v1/support-sessions/${encodeURIComponent(sessionId)}/resources/${resource}`);
    const keys = Object.keys(result.items[0] || {});
    const table = result.items.length ? `<div class="platform-table-wrap"><table class="platform-table"><thead><tr>${keys.map((key) => `<th>${escapeHtml(key)}</th>`).join("")}</tr></thead><tbody>${result.items.map((item) => `<tr>${keys.map((key) => `<td>${escapeHtml(String(item[key] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<div class="platform-empty">该范围暂无数据</div>`;
    openModal(`支持视图 · ${request.tenantName}`, `<p class="field-hint">限时只读 · ${escapeHtml(result.permissionCode)} · 每次读取均写入平台审计</p>${table}`, `<button class="btn" data-modal-close>关闭</button>`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "支持数据读取失败", "error");
    closeModal();
  }
}

function installPlatformOperationEvents() {
  qsa<HTMLButtonElement>("[data-platform-tab]", qs("#platformTabs") || document).forEach((button) => button.onclick = () => { platformActiveTab = button.dataset.platformTab as PlatformTab; renderPlatformOperations(); });
  qsa<HTMLButtonElement>("[data-platform-open-tab]").forEach((button) => button.onclick = () => { platformActiveTab = button.dataset.platformOpenTab as PlatformTab; renderPlatformOperations(); });
  qs<HTMLButtonElement>("[data-platform-create-tenant]")?.addEventListener("click", openPlatformTenantCreator);
  qsa<HTMLButtonElement>("[data-platform-bootstrap-admin]").forEach((button) => button.onclick = () => openPlatformTenantAdminCreator(button.dataset.tenantId || ""));
  qs<HTMLButtonElement>("[data-platform-create-support]")?.addEventListener("click", openPlatformSupportCreator);
  qsa<HTMLButtonElement>("[data-platform-tenant-action]").forEach((button) => button.onclick = () => {
    const action = button.dataset.platformTenantAction as "suspend" | "restore"; const tenantId = button.dataset.tenantId || "";
    openPlatformReasonAction(action === "suspend" ? "暂停公司" : "恢复公司", "填写状态变更原因", (reason) => api(`/api/platform/v1/tenants/${encodeURIComponent(tenantId)}/${action}`, { method: "POST", body: JSON.stringify({ reason }) }), action === "suspend" ? "公司已暂停" : "公司已恢复");
  });
  qsa<HTMLButtonElement>("[data-platform-support-review]").forEach((button) => button.onclick = () => {
    const decision = button.dataset.platformSupportReview || "reject"; const requestId = button.dataset.requestId || "";
    openPlatformReasonAction(decision === "approve" ? "批准支持访问" : "拒绝支持访问", "填写审批意见", (reviewNote) => api(`/api/platform/v1/support-requests/${encodeURIComponent(requestId)}/${decision}`, { method: "POST", body: JSON.stringify({ reviewNote }) }), decision === "approve" ? "申请已批准" : "申请已拒绝");
  });
  qsa<HTMLButtonElement>("[data-platform-support-start]").forEach((button) => button.onclick = () => void runPlatformMutation(() => api(`/api/platform/v1/support-requests/${encodeURIComponent(button.dataset.platformSupportStart || "")}/start-session`, { method: "POST", body: "{}" }), "限时支持会话已启动"));
  qsa<HTMLButtonElement>("[data-platform-support-terminate]").forEach((button) => button.onclick = () => openPlatformReasonAction("结束支持会话", "填写结束原因", (reason) => api(`/api/platform/v1/support-sessions/${encodeURIComponent(button.dataset.platformSupportTerminate || "")}/terminate`, { method: "POST", body: JSON.stringify({ reason }) }), "支持会话已结束"));
  qsa<HTMLButtonElement>("[data-platform-support-read]").forEach((button) => button.onclick = () => void openPlatformSupportData(button.dataset.platformSupportRead || ""));
}
