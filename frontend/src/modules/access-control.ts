/**
 * 成员、组织、角色、授权、审计、账号、临时账号。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, confirmAction, openModal, state } from "../prototype-api";
import { type AccessAuditEvent, type AccessControlOverview, type AccessControlPage, type AccessControlScope, type Role, type User } from "./models";
import { badge, escapeHtml, qs, qsa, roleLabel, viewLabels } from "./shared";
import { loadIamCapabilities } from "./platform-approvals";
import { api, setButtonPending, toast } from "./ui";
import { accessControlViews, canAccessWorkspaceView, hasIamCapability } from "./auth";
import { formatDateTime } from "./deals";
import {
  type AccessControlUiModule, accessControlLoading, accessControlModulePermissions, accessControlModuleState,
  accessControlPermissionVersion, accessControlScopeBadge, accessControlScopeText, accessControlSuggestedScope,
  accessControlUiModules, activeAccessControlPage, activeAccessControlRoot, refreshMysqlImportStatus
} from "./database-maintenance";

let accessControlOverview: AccessControlOverview | null = null;
let accessControlSelectedRoleId = "";
let accessControlSelectedMemberId = "";
let accessControlOrganizationFilter: "all" | "unassigned" = "all";
let accessControlAuditEvents: AccessAuditEvent[] = [];

export async function loadAccessControl(teamId = "") {
  const activeView = qs<HTMLElement>(".iam-view.active")?.id || "member-management";
  if (!state.user || !canAccessWorkspaceView(activeView, state.user)) return;
  accessControlLoading();
  try {
    const queryParams = new URLSearchParams();
    if (state.iamCapabilities?.source === "platform" && teamId) queryParams.set("teamId", teamId);
    queryParams.set("page", activeAccessControlPage());
    const query = `?${queryParams.toString()}`;
    accessControlOverview = await api<AccessControlOverview>(`/api/access-control/overview${query}`);
    if (activeAccessControlPage() === "audit" && accessControlOverview.company) {
      const auditQuery = new URLSearchParams({ limit: "100" });
      if (state.iamCapabilities?.source === "platform") auditQuery.set("tenantId", accessControlOverview.company.id);
      accessControlAuditEvents = (await api<{ events: AccessAuditEvent[] }>(`/api/v1/access-audit-events?${auditQuery.toString()}`)).events;
    }
    if (!accessControlSelectedRoleId || !accessControlOverview.roles.some((role) => role.id === accessControlSelectedRoleId)) {
      accessControlSelectedRoleId = accessControlOverview.roles[0]?.id || "";
    }
    if (!accessControlSelectedMemberId || !accessControlOverview.members.some((member) => member.id === accessControlSelectedMemberId)) {
      accessControlSelectedMemberId = accessControlOverview.members[0]?.id || "";
    }
    renderAccessControl();
  } catch (error) {
    const root = activeAccessControlRoot();
    if (root) root.innerHTML = `<div class="ac-empty"><div><h2>组织与权限加载失败</h2><p>${escapeHtml(error instanceof Error ? error.message : "请求失败")}</p><button class="btn" type="button" data-ac-retry>重新加载</button></div></div>`;
    qs<HTMLButtonElement>("[data-ac-retry]", root || document)?.addEventListener("click", () => void loadAccessControl(teamId));
  }
}

function accessControlCompanyOptions(overview: AccessControlOverview) {
  if (state.iamCapabilities?.source !== "platform") return "";
  return `<select class="ac-company-select" id="accessControlCompanySelect" aria-label="公司上下文">
    <option value="">选择公司</option>
    ${overview.companies.map((company) => `<option value="${escapeHtml(company.id)}" ${overview.company?.id === company.id ? "selected" : ""}>${escapeHtml(company.name)} · ${company.memberCount} 人</option>`).join("")}
  </select>`;
}

function accessControlTenantBody(overview: AccessControlOverview) {
  return state.iamCapabilities?.source === "platform" && overview.company ? { tenantId: overview.company.id } : {};
}

async function mutateAccessControl(operation: () => Promise<unknown>, success: string) {
  try {
    await operation();
    if (state.user) await loadIamCapabilities(state.user);
    await loadAccessControl(accessControlOverview?.company?.id || "");
    closeModal();
    toast(success);
  } catch (error) {
    toast(error instanceof Error ? error.message : "权限配置失败", "error");
  }
}

function openAccessControlMemberEditor(overview: AccessControlOverview, memberId: string) {
  const member = overview.members.find((item) => item.id === memberId);
  if (!member) return;
  const options = overview.organizationUnits.filter((unit) => unit.type !== "unassigned" && unit.status !== "disabled").map((unit) => `<option value="${escapeHtml(unit.id)}" ${unit.id === member.organizationUnitId ? "selected" : ""}>${escapeHtml(unit.name)}</option>`).join("");
  openModal("编辑成员", `<div class="form-grid"><div class="form-field full"><label>成员</label><input value="${escapeHtml(member.name)} · ${escapeHtml(member.email)}" disabled></div><div class="form-field"><label>成员状态</label><select id="iamMemberStatus"><option value="active" ${member.status === "active" ? "selected" : ""}>启用</option><option value="suspended" ${member.status !== "active" ? "selected" : ""}>停用</option></select></div><div class="form-field"><label>所属组织</label><select id="iamMemberOrg">${options}</select></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveIamMember">保存</button>`);
  qs("#saveIamMember")?.addEventListener("click", () => void mutateAccessControl(() => api(`/api/v1/members/${encodeURIComponent(member.id)}`, { method: "PATCH", body: JSON.stringify({ ...accessControlTenantBody(overview), status: qs<HTMLSelectElement>("#iamMemberStatus")?.value, organizationUnitId: qs<HTMLSelectElement>("#iamMemberOrg")?.value, reason: "成员目录调整" }) }), "成员设置已更新"));
}

/**
 * 删除成员：要求原样输入姓名。
 * 不用「确定/取消」那种弹窗 —— 删人不可逆，点错一次就是事故，
 * 输入姓名这个动作本身就是让人再看一眼"删的是谁"。
 */
function openAccessControlMemberDeleter(overview: AccessControlOverview, member: AccessControlOverview["members"][number]) {
  openModal("删除成员", `<div class="form-grid">
    <div class="form-field full"><label>将要删除</label><input value="${escapeHtml(member.name)} · ${escapeHtml(member.email)}" disabled></div>
    <div class="form-field full"><label>输入成员姓名确认</label><input id="iamDeleteConfirmName" autocomplete="off" placeholder="请输入：${escapeHtml(member.name)}"></div>
  </div><p class="ac-danger-note">删除后该成员立即失去登录权限，并从成员目录消失；邮箱会被释放，可以拿来重新建账号。名下已产生的客户、订单、文件与审计记录会保留，不再归属到在册成员。此操作不可撤销。</p>`,
  `<button class="btn" data-modal-close>取消</button><button class="btn danger" id="confirmDeleteMember">确认删除</button>`,
  { description: "删除后不可恢复，该成员的邮箱将被释放" });
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs<HTMLButtonElement>("#confirmDeleteMember")?.addEventListener("click", () => {
    const confirmName = qs<HTMLInputElement>("#iamDeleteConfirmName")?.value.trim() || "";
    if (confirmName !== member.name) {
      toast("请输入完整的成员姓名以确认删除", "error");
      return;
    }
    void (async () => {
      try {
        const result = await api<{ data?: { identity?: string } }>(`/api/v1/members/${encodeURIComponent(member.id)}`, {
          method: "DELETE",
          body: JSON.stringify({ ...accessControlTenantBody(overview), confirmName, reason: "删除成员" })
        });
        if (state.user) await loadIamCapabilities(state.user);
        await loadAccessControl(accessControlOverview?.company?.id || "");
        closeModal();
        // 三种收尾要说清楚，否则用户不知道邮箱到底释放了没有
        const identity = result?.data?.identity || "deleted";
        toast(identity === "member-removed"
          ? "已从当前公司移出；该账号在其他公司仍然可用"
          : identity === "identity-retained"
            ? "成员已删除，邮箱已释放；历史业务记录保留为只读主体"
            : "成员已彻底删除，邮箱已释放");
      } catch (error) {
        toast(error instanceof Error ? error.message : "删除成员失败", "error");
      }
    })();
  });
}

function openAccessControlMemberCreator(overview: AccessControlOverview) {
  openModal("新增成员", `<div class="form-grid"><div class="form-field"><label>姓名</label><input id="iamNewMemberName" maxlength="100"></div><div class="form-field"><label>邮箱</label><input id="iamNewMemberEmail" type="email" maxlength="180"></div><div class="form-field"><label>初始密码</label><input id="iamNewMemberPassword" type="password" minlength="8" autocomplete="new-password"></div><div class="form-field"><label>角色</label><select id="iamNewMemberRole">${overview.roles.filter((role) => role.status !== "disabled").map((role) => `<option value="${escapeHtml(role.id)}">${escapeHtml(role.name)}</option>`).join("")}</select></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveIamNewMember">创建成员</button>`);
  qs("#saveIamNewMember")?.addEventListener("click", () => {
    const name = qs<HTMLInputElement>("#iamNewMemberName")?.value.trim() || "";
    const email = qs<HTMLInputElement>("#iamNewMemberEmail")?.value.trim() || "";
    const password = qs<HTMLInputElement>("#iamNewMemberPassword")?.value || "";
    if (!name || !email || password.length < 8) { toast("请填写姓名、邮箱和至少 8 位密码", "error"); return; }
    void mutateAccessControl(() => api("/api/v1/members", { method: "POST", body: JSON.stringify({ ...accessControlTenantBody(overview), name, email, password, roleId: qs<HTMLSelectElement>("#iamNewMemberRole")?.value, reason: "新增成员" }) }), "成员已创建");
  });
}

function openAccessControlOrganizationEditor(overview: AccessControlOverview, unitId = "") {
  const unit = overview.organizationUnits.find((item) => item.id === unitId);
  const parentOptions = overview.organizationUnits.filter((item) => item.id !== unitId && item.status !== "disabled" && item.type !== "unassigned").map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === unit?.parentId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
  openModal(unit ? "编辑组织" : "新增组织", `<div class="form-grid"><div class="form-field full"><label>组织名称</label><input id="iamOrgName" maxlength="160" value="${escapeHtml(unit?.name || "")}"></div>${unit ? `<div class="form-field"><label>上级组织</label><select id="iamOrgParent">${parentOptions}</select></div><div class="form-field"><label>状态</label><select id="iamOrgStatus"><option value="active" ${unit.status !== "disabled" ? "selected" : ""}>启用</option><option value="disabled" ${unit.status === "disabled" ? "selected" : ""}>停用</option></select></div>` : `<div class="form-field"><label>上级组织</label><select id="iamOrgParent">${parentOptions}</select></div><div class="form-field"><label>组织编码</label><input id="iamOrgCode" maxlength="80" placeholder="例如 sales-east"></div>`}</div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveIamOrg">保存</button>`);
  qs("#saveIamOrg")?.addEventListener("click", () => {
    const name = qs<HTMLInputElement>("#iamOrgName")?.value.trim() || "";
    if (!name) { toast("请填写组织名称", "error"); return; }
    const path = unit ? `/api/v1/organization-units/${encodeURIComponent(unit.id)}` : "/api/v1/organization-units";
    const body = unit ? { ...accessControlTenantBody(overview), name, parentId: qs<HTMLSelectElement>("#iamOrgParent")?.value, status: qs<HTMLSelectElement>("#iamOrgStatus")?.value, reason: "组织架构调整" } : { ...accessControlTenantBody(overview), name, parentId: qs<HTMLSelectElement>("#iamOrgParent")?.value, code: qs<HTMLInputElement>("#iamOrgCode")?.value.trim(), reason: "新增组织" };
    void mutateAccessControl(() => api(path, { method: unit ? "PATCH" : "POST", body: JSON.stringify(body) }), unit ? "组织已更新" : "组织已创建");
  });
}

function openAccessControlRoleCreator(overview: AccessControlOverview, cloneRoleId = "") {
  const source = overview.roles.find((item) => item.id === cloneRoleId);
  openModal(source ? "复制角色" : "新增角色", `<div class="form-grid"><div class="form-field full"><label>角色名称</label><input id="iamRoleName" maxlength="120" value="${escapeHtml(source ? `${source.name} 副本` : "")}"></div><div class="form-field full"><label>职责说明</label><textarea id="iamRoleDescription" maxlength="500">${escapeHtml(source?.description || source?.summary || "")}</textarea></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveIamRole">创建</button>`);
  qs("#saveIamRole")?.addEventListener("click", () => {
    const name = qs<HTMLInputElement>("#iamRoleName")?.value.trim() || ""; if (!name) { toast("请填写角色名称", "error"); return; }
    const path = source ? `/api/v1/roles/${encodeURIComponent(source.id)}/clone` : "/api/v1/roles";
    void mutateAccessControl(() => api(path, { method: "POST", body: JSON.stringify({ ...accessControlTenantBody(overview), name, description: qs<HTMLTextAreaElement>("#iamRoleDescription")?.value.trim(), reason: source ? "复制角色" : "新增角色" }) }), "角色已创建");
  });
}

function renderAccessControlCompanyPicker(overview: AccessControlOverview) {
  return `<div class="ac-workbench"><div class="ac-empty"><div><h2>选择公司上下文</h2><p>平台账号按公司独立查看组织和权限，数据不会跨公司合并。</p><div class="ac-company-grid">
    ${overview.companies.map((company) => `<button class="ac-company-card" type="button" data-ac-company="${escapeHtml(company.id)}"><span><b>${escapeHtml(company.name)}</b><small>${escapeHtml(company.id)}</small></span><span class="ac-count">${company.memberCount}</span></button>`).join("") || `<div><b>暂无公司</b></div>`}
  </div></div></div></div>`;
}

function accessControlMemberRows(members: AccessControlOverview["members"]) {
  return members.map((member) => {
    const active = member.status === "active";
    return `<tr data-ac-member-open="${escapeHtml(member.id)}" data-ac-search-row="${escapeHtml(`${member.name} ${member.email} ${member.roleName} ${member.organizationUnitName}`.toLowerCase())}">
    <td><div class="ac-member-cell"><span class="ac-avatar">${escapeHtml(member.avatar || member.name.slice(0, 2))}</span><span class="ac-member-copy"><b>${escapeHtml(member.name)}</b><small>${escapeHtml(member.email)}</small></span></div></td>
    <td><span class="ac-role-chip ${member.roleCode}">${escapeHtml(member.roleName)}</span></td>
    <td>${escapeHtml(member.organizationUnitName)}</td>
    <td><span class="ac-status-chip ${member.status}">${active ? "启用" : "停用"}</span></td>
    <td><div class="ac-row-actions">
      <button class="btn" type="button" data-ac-member-toggle="${escapeHtml(member.id)}" data-ac-member-next="${active ? "suspended" : "active"}">${active ? "停用" : "恢复"}</button>
      <button class="btn danger" type="button" data-ac-member-delete="${escapeHtml(member.id)}">删除</button>
    </div></td>
  </tr>`;
  }).join("");
}

function renderAccessControlOrganization(overview: AccessControlOverview) {
  const members = accessControlOrganizationFilter === "unassigned"
    ? overview.members.filter((member) => !member.organizationUnitId)
    : overview.members;
  const companyUnit = overview.organizationUnits.find((unit) => unit.type === "company");
  const unassignedUnit = overview.organizationUnits.find((unit) => unit.type === "unassigned");
  return `<div class="ac-workbench ac-org-layout">
    <aside class="ac-pane">
      <div class="ac-pane-head"><h2>公司组织</h2><span>${overview.metrics?.organizationUnitCount || 0} 个节点</span></div>
      <div class="ac-tree">
        <button class="ac-tree-row ${accessControlOrganizationFilter === "all" ? "active" : ""}" type="button" data-ac-org-filter="all"><span class="ac-tree-mark">司</span><span class="ac-tree-copy"><b>${escapeHtml(companyUnit?.name || overview.company?.name || "当前公司")}</b><small>公司根组织</small></span><span class="ac-count">${companyUnit?.memberCount || 0}</span></button>
        <button class="ac-tree-row child ${accessControlOrganizationFilter === "unassigned" ? "active" : ""}" type="button" data-ac-org-filter="unassigned"><span class="ac-tree-mark">未</span><span class="ac-tree-copy"><b>${escapeHtml(unassignedUnit?.name || "未分配组织")}</b><small>待建立成员关系</small></span><span class="ac-count">${unassignedUnit?.memberCount || 0}</span></button>
        ${overview.organizationUnits.filter((unit) => unit.type !== "company" && unit.type !== "unassigned").map((unit) => `<div class="ac-tree-row child"><span class="ac-tree-mark">组</span><span class="ac-tree-copy"><b>${escapeHtml(unit.name)}</b><small>${escapeHtml(unit.code || "组织节点")}</small></span><span class="ac-count">${unit.memberCount}</span><button class="btn icon-only" type="button" data-ac-org-edit="${escapeHtml(unit.id)}" title="编辑组织">编辑</button></div>`).join("")}
      </div>
    </aside>
    <section class="ac-pane">
      <div class="ac-pane-head"><h2>成员目录</h2><div class="ac-head-actions"><label class="ac-search"><input id="accessControlOrganizationSearch" placeholder="搜索成员、邮箱或角色" autocomplete="off"></label><button class="btn primary" type="button" data-ac-org-add>新增组织</button></div></div>
      <div class="ac-member-table-wrap"><table class="ac-member-table"><thead><tr><th style="width:34%">成员</th><th style="width:17%">当前角色</th><th style="width:20%">组织归属</th><th style="width:12%">状态</th><th style="width:17%">操作</th></tr></thead><tbody id="accessControlOrganizationRows">${accessControlMemberRows(members) || `<tr><td colspan="5">暂无成员</td></tr>`}</tbody></table></div>
    </section>
    <aside class="ac-pane">
      <div class="ac-pane-head"><h3>公司边界</h3><span class="ac-status-chip active">已隔离</span></div>
      <div class="ac-overview-list">
        <div class="ac-overview-row"><span>公司</span><b>${escapeHtml(overview.company?.name || "-")}</b></div>
        <div class="ac-overview-row"><span>隔离范围</span><b>当前公司</b></div>
        <div class="ac-overview-row"><span>成员</span><b>${overview.metrics?.memberCount || 0} 人</b></div>
        <div class="ac-overview-row"><span>组织节点</span><b>${overview.metrics?.organizationUnitCount || 0} 个</b></div>
        <div class="ac-overview-row"><span>未分配成员</span><b>${overview.metrics?.unassignedMemberCount || 0} 人</b></div>
        <div class="ac-overview-row"><span>跨公司访问</span><b>默认拒绝</b></div>
      </div>
      <div class="ac-policy-note">租户边界使用当前公司的唯一标识；成员、角色和后续组织节点都限定在该边界内。</div>
    </aside>
  </div>`;
}

function renderAccessControlMemberManagement(overview: AccessControlOverview) {
  return `<div class="ac-workbench">
    <section class="ac-pane">
      <div class="ac-pane-head"><div class="ac-pane-title"><h2>公司成员</h2><span>共 ${overview.members.length} 位</span></div><label class="ac-search"><input id="accessControlOrganizationSearch" placeholder="搜索姓名、邮箱或角色" autocomplete="off"></label></div>
      <div class="ac-member-table-wrap"><table class="ac-member-table ac-member-directory-table"><thead><tr><th>成员</th><th>当前角色</th><th>所属组织</th><th>状态</th><th>操作</th></tr></thead><tbody id="accessControlOrganizationRows">${overview.members.map((member) => `<tr data-ac-search-row="${escapeHtml(`${member.name} ${member.email} ${member.roleName}`.toLowerCase())}"><td><div class="ac-member-cell"><span class="ac-avatar">${escapeHtml(member.avatar || member.name.slice(0, 2))}</span><span class="ac-member-copy"><b>${escapeHtml(member.name)}</b><small>${escapeHtml(member.email)}${member.employeeNo ? ` · ${escapeHtml(member.employeeNo)}` : ""}</small></span></div></td><td><span class="ac-role-chip ${member.roleCode}">${escapeHtml(member.roleName)}</span></td><td><span class="ac-cell-main">${escapeHtml(member.organizationUnitName)}</span></td><td><span class="ac-status-chip ${member.status}">${member.status === "active" ? "启用" : "停用"}</span></td><td><div class="ac-row-actions"><button class="btn" type="button" data-ac-member-edit="${escapeHtml(member.id)}">编辑</button><button class="btn" type="button" data-ac-member-toggle="${escapeHtml(member.id)}" data-ac-member-next="${member.status === "active" ? "suspended" : "active"}">${member.status === "active" ? "停用" : "恢复"}</button><button class="btn danger" type="button" data-ac-member-delete="${escapeHtml(member.id)}">删除</button><button class="btn" type="button" data-ac-member-open="${escapeHtml(member.id)}">权限</button></div></td></tr>`).join("") || `<tr><td colspan="5"><div class="ac-table-empty">暂无成员</div></td></tr>`}</tbody></table></div>
    </section>
  </div>`;
}

function renderAccessControlUiAccess(overview: AccessControlOverview) {
  const selected = overview.roles.find((role) => role.id === accessControlSelectedRoleId) || overview.roles[0];
  const grouped = new Map<string, AccessControlUiModule[]>();
  accessControlUiModules.forEach((module) => grouped.set(module.group, [...(grouped.get(module.group) || []), module]));
  const modules = [...grouped.entries()].map(([group, items]) => {
    const cards = items.map((module) => {
      const stateInfo = selected ? accessControlModuleState(overview, selected, module) : null;
      const permissions = stateInfo?.permissions || [];
      const statusText = stateInfo?.status === "open" ? "已开通" : stateInfo?.status === "partial" ? "部分开通" : "未开通";
      const statusTone = stateInfo?.status === "open" ? "active" : stateInfo?.status === "partial" ? "warning" : "disabled";
      const views = module.views.map((view) => viewLabels[view] || view).join("、");
      const protectedBaselineNames = (stateInfo?.protectedBaseline || []).slice(0, 2).map((permission) => permission.name).join("、");
      const closeLocked = Boolean(stateInfo?.closeLocked);
      const closeReason = closeLocked
        ? `系统预设角色必须保留基础权限：${protectedBaselineNames}${(stateInfo?.protectedBaseline.length || 0) > 2 ? "等" : ""}。复制角色后可自由调整。`
        : stateInfo?.status === "closed" ? "该模块当前未开通" : "关闭后将撤销该模块包含的授权，菜单会隐藏。";
      const permissionList = permissions.slice(0, 5).map((permission) => {
        const scope = selected ? permission.grants[selected.id] || "none" : "none";
        return `<li><span>${escapeHtml(permission.name)}</span>${accessControlScopeBadge(scope)}</li>`;
      }).join("");
      const more = permissions.length > 5 ? `<li><span>还有 ${permissions.length - 5} 项权限</span><em>发布时一并处理</em></li>` : "";
      const missing = stateInfo?.missing ? `<div class="ac-ui-warning">有 ${stateInfo.missing} 项界面权限暂未进入权限目录，升级后会显示为可配置项。</div>` : "";
      return `<article class="ac-ui-card is-${statusTone}" data-ac-ui-card="${escapeHtml(module.id)}">
        <header><div><span>${escapeHtml(module.edition)}</span><h3>${escapeHtml(module.name)}</h3></div><b>${statusText}</b></header>
        <p>${escapeHtml(module.summary)}</p>
        <div class="ac-ui-views"><span>界面</span><strong>${escapeHtml(views || "后台能力")}</strong></div>
        <div class="ac-ui-visibility"><span>菜单显示</span><strong class="${stateInfo?.visible ? "is-visible" : "is-menu-hidden"}">${stateInfo?.visible ? "可见" : "隐藏"}</strong></div>
        <div class="ac-ui-version"><span>权限版本</span><strong>${escapeHtml(accessControlPermissionVersion(permissions))}</strong></div>
        <ul>${permissionList}${more || (permissions.length ? "" : `<li><span>暂无可配置权限</span><em>等待权限目录更新</em></li>`)}</ul>
        ${missing}
        <footer>
          <button class="btn" type="button" data-ac-module-detail="${escapeHtml(module.id)}">查看权限</button>
          <button class="btn primary" type="button" data-ac-module-enable="${escapeHtml(module.id)}" ${!selected || stateInfo?.status === "open" ? "disabled" : ""}>开通模块</button>
          <button class="btn danger" type="button" data-ac-module-disable="${escapeHtml(module.id)}" title="${escapeHtml(closeReason)}" aria-label="${escapeHtml(closeReason)}" ${!selected || stateInfo?.status === "closed" || closeLocked ? "disabled" : ""}>${closeLocked ? "基础必需" : "关闭模块"}</button>
        </footer>
        ${closeLocked ? `<div class="ac-ui-lock-note">基础必需：${escapeHtml(protectedBaselineNames)}${(stateInfo?.protectedBaseline.length || 0) > 2 ? "等" : ""}。系统预设角色不能取消这些权限。</div>` : ""}
      </article>`;
    }).join("");
    return `<section class="ac-ui-group"><div class="ac-ui-group-head"><h3>${escapeHtml(group)}</h3><span>${items.length} 个模块</span></div><div class="ac-ui-grid">${cards}</div></section>`;
  }).join("");
  return `<div class="ac-workbench ac-ui-layout">
    <aside class="ac-pane"><div class="ac-pane-head"><div class="ac-pane-title"><h2>选择角色</h2><span>界面会按角色权限自动出现</span></div></div><div class="ac-role-list">
      ${overview.roles.map((role) => `<button class="ac-role-item ${role.code} ${role.id === selected?.id ? "active" : ""}" type="button" data-ac-role="${escapeHtml(role.id)}"><span class="ac-role-symbol">${escapeHtml(role.name.slice(0, 1))}</span><span class="ac-role-copy"><b>${escapeHtml(role.name)}</b><small>${role.memberCount} 名成员 · ${role.permissionCount} 项权限 · ${role.is_protected ? "系统预设" : "可自定义"}</small></span><span class="ac-count">${role.moduleCount}</span></button>`).join("")}
    </div></aside>
    <section class="ac-pane">
      <div class="ac-ui-brief">
        <div><h2>${escapeHtml(selected?.name || "角色界面")}</h2><p>菜单显示取决于查看权限；“部分开通”表示菜单可见但操作权限未全部配置。${selected?.is_protected ? "系统预设角色的基础权限不能取消；需要完全自定义时，请先复制角色。" : "当前是自定义角色，可以按岗位开通或关闭模块。"}</p></div>
        <div class="ac-ui-legend"><span><i class="active"></i>已开通</span><span><i class="warning"></i>部分开通</span><span><i></i>未开通</span></div>
      </div>
      <div class="ac-ui-scroll">${modules}</div>
    </section>
  </div>`;
}

function renderAccessControlRoles(overview: AccessControlOverview) {
  const selected = overview.roles.find((role) => role.id === accessControlSelectedRoleId) || overview.roles[0];
  const grouped = new Map<string, AccessControlOverview["permissions"]>();
  overview.permissions.forEach((permission) => grouped.set(permission.module, [...(grouped.get(permission.module) || []), permission]));
  const body = [...grouped.entries()].map(([module, permissions]) => `<tr class="ac-module-row"><td colspan="2"><span>${escapeHtml(module)}</span><small>${permissions.length} 项</small></td></tr>${permissions.map((permission) => `<tr>
    <td><span class="ac-permission-name"><b>${escapeHtml(permission.name)}</b><small>${escapeHtml(permission.code)}</small></span></td>
    <td><select class="ac-scope-select" data-ac-role-scope="${escapeHtml(permission.code)}" aria-label="${escapeHtml(permission.name)}授权范围"><option value="none">未授权</option>${(permission.scopeModes || ["self", "org_unit", "org_subtree", "tenant", "public_pool"]).map((scope) => `<option value="${scope}" ${selected && permission.grants[selected.id] === scope ? "selected" : ""}>${accessControlScopeText[scope]}</option>`).join("")}</select></td>
  </tr>`).join("")}`).join("");
  return `<div class="ac-workbench ac-role-layout">
    <aside class="ac-pane"><div class="ac-pane-head"><div class="ac-pane-title"><h2>角色</h2><span>${overview.roles.length} 个角色模板</span></div><button class="btn primary" type="button" data-ac-role-add>新增角色</button></div><div class="ac-role-list">
      ${overview.roles.map((role) => `<button class="ac-role-item ${role.code} ${role.id === selected?.id ? "active" : ""}" type="button" data-ac-role="${escapeHtml(role.id)}"><span class="ac-role-symbol">${escapeHtml(role.name.slice(0, 1))}</span><span class="ac-role-copy"><b>${escapeHtml(role.name)}</b><small>${role.memberCount} 名成员 · ${role.permissionCount} 项权限</small></span><span class="ac-count">${role.moduleCount}</span></button>`).join("")}
    </div></aside>
    <section class="ac-pane">
      <div class="ac-role-summary"><div class="ac-role-intro"><span class="ac-role-symbol ${selected?.code || ""}">${escapeHtml((selected?.name || "角").slice(0, 1))}</span><div><h2>${escapeHtml(selected?.name || "角色权限")}</h2><p>${escapeHtml(selected?.description || selected?.summary || "尚未填写角色职责说明")}</p><div class="ac-inline-actions"><button class="btn" type="button" data-ac-role-clone="${escapeHtml(selected?.id || "")}">复制角色</button>${selected && !selected.is_protected ? `<button class="btn danger" type="button" data-ac-role-disable="${escapeHtml(selected.id)}">停用角色</button>` : ""}</div></div></div><div class="ac-role-stats"><div class="ac-role-stat"><span>成员</span><b>${selected?.memberCount || 0}</b></div><div class="ac-role-stat"><span>已授权</span><b>${selected?.permissionCount || 0}</b></div><div class="ac-role-stat"><span>业务模块</span><b>${selected?.moduleCount || 0}</b></div></div></div>
      <div class="ac-permission-toolbar"><div><h3>权限明细</h3><span>设置当前角色在各业务模块中的数据范围</span></div><button class="btn primary" type="button" data-ac-role-save="${escapeHtml(selected?.id || "")}">发布权限</button></div>
      <div class="ac-permission-table-wrap"><table class="ac-permission-table"><thead><tr><th>权限项</th><th>授权范围</th></tr></thead><tbody>${body}</tbody></table></div>
    </section>
  </div>`;
}

function renderAccessControlMembers(overview: AccessControlOverview) {
  const selected = overview.members.find((member) => member.id === accessControlSelectedMemberId) || overview.members[0];
  const selectedRoleIds = selected ? (selected.roleIds?.length ? selected.roleIds : [selected.roleId]) : [];
  const scopeRank: Record<AccessControlScope, number> = { none: 0, self: 1, org_unit: 2, org_subtree: 3, tenant: 4, public_pool: 5, platform: 6 };
  const memberScope = (permission: AccessControlOverview["permissions"][number]) => {
    const scopes = selectedRoleIds.map((roleId) => permission.grants[roleId] || "none");
    scopes.push(...(selected?.temporaryGrants || []).filter((grant) => grant.permissionCode === permission.code).map((grant) => grant.scopeMode));
    return scopes.sort((left, right) => scopeRank[right] - scopeRank[left])[0] || "none";
  };
  const effective = selected ? overview.permissions.filter((permission) => memberScope(permission) !== "none") : [];
  return `<div class="ac-workbench ac-member-layout">
    <aside class="ac-pane"><div class="ac-pane-head"><div class="ac-pane-title"><h2>选择成员</h2><span>${overview.members.length} 位公司成员</span></div><label class="ac-search"><input id="accessControlMemberSearch" placeholder="搜索成员" autocomplete="off"></label></div><div class="ac-member-list" id="accessControlMemberList">
      ${overview.members.map((member) => `<button class="ac-member-item ${member.id === selected?.id ? "active" : ""}" type="button" data-ac-member="${escapeHtml(member.id)}" data-ac-search-row="${escapeHtml(`${member.name} ${member.email} ${member.roleName}`.toLowerCase())}"><span class="ac-avatar">${escapeHtml(member.avatar || member.name.slice(0, 2))}</span><span class="ac-member-copy"><b>${escapeHtml(member.name)}</b><small>${escapeHtml(member.roleName)} · ${escapeHtml(member.organizationUnitName)}</small></span><span class="ac-status-chip ${member.status}">${member.status === "active" ? "启用" : "停用"}</span></button>`).join("") || `<div class="ac-empty"><p>暂无成员</p></div>`}
    </div></aside>
    <section class="ac-pane">${selected ? `<div class="ac-member-detail">
      <div class="ac-member-detail-head"><div class="ac-member-detail-person"><span class="ac-avatar">${escapeHtml(selected.avatar || selected.name.slice(0, 2))}</span><div><h2>${escapeHtml(selected.name)}</h2><p>${escapeHtml(selected.email)}</p></div></div><div class="ac-member-head-actions"><span class="ac-role-chip ${selected.roleCode}">${escapeHtml(selected.roleName)}</span><span class="ac-status-chip ${selected.status}">${selected.status === "active" ? "启用" : "停用"}</span><button class="btn" type="button" data-ac-member-toggle="${escapeHtml(selected.id)}" data-ac-member-next="${selected.status === "active" ? "suspended" : "active"}">${selected.status === "active" ? "停用" : "恢复"}</button><button class="btn danger" type="button" data-ac-member-delete="${escapeHtml(selected.id)}">删除成员</button></div></div>
      <section class="ac-detail-section"><div class="ac-section-head"><div><h3>授权关系</h3><span>角色决定成员的基础权限</span></div><button class="btn primary" type="button" data-ac-member-role-save="${escapeHtml(selected.membershipId || selected.id)}">保存角色</button></div>
      <div class="ac-assignment-chain"><div class="ac-chain-node"><span>公司</span><b>${escapeHtml(overview.company?.name || "-")}</b></div><div class="ac-chain-node"><span>所属组织</span><b>${escapeHtml(selected.organizationUnitName)}</b></div><div class="ac-chain-node ac-chain-role"><span>已分配角色</span><div class="ac-role-checks" id="iamMemberRoleIds">${overview.roles.filter((item) => item.status !== "disabled").map((item) => `<label><input type="checkbox" value="${escapeHtml(item.id)}" ${selectedRoleIds.includes(item.id) ? "checked" : ""}><span>${escapeHtml(item.name)}</span></label>`).join("")}</div></div></div></section>
      <section class="ac-detail-section"><div class="ac-section-head"><div><h3>有效权限</h3><span>角色与临时授权合并后共 ${effective.length} 项</span></div></div>
      <div class="ac-effective-grid">${effective.map((permission) => `<div class="ac-effective-row"><span><b>${escapeHtml(permission.name)}</b><small>${escapeHtml(permission.module)}</small></span>${accessControlScopeBadge(memberScope(permission))}</div>`).join("") || `<div class="ac-table-empty">当前成员没有有效权限</div>`}</div></section>
      <section class="ac-detail-section"><div class="ac-section-head"><div><h3>临时授权</h3><span>到期后自动失效，不改变角色模板</span></div></div><div class="ac-grant-form"><div class="form-field"><label>权限</label><select id="iamGrantPermission">${overview.permissions.map((permission) => `<option value="${escapeHtml(permission.code)}">${escapeHtml(permission.name)}</option>`).join("")}</select></div><div class="form-field"><label>范围</label><select id="iamGrantScope"><option value="self">本人</option><option value="org_subtree">本组织及下级</option><option value="tenant">当前公司</option></select></div><div class="form-field"><label>截止时间</label><input id="iamGrantUntil" type="datetime-local"></div><div class="form-field"><label>授权原因</label><input id="iamGrantReason" value="临时业务授权"></div><button class="btn" type="button" data-ac-member-grant="${escapeHtml(selected.membershipId || selected.id)}">新增临时授权</button></div><div class="ac-grant-list">${(selected.temporaryGrants || []).map((grant) => `<div class="ac-effective-row"><span><b>${escapeHtml(grant.permissionCode)}</b><small>截止 ${escapeHtml(new Date(grant.validUntil).toLocaleString("zh-CN"))}</small></span><button class="btn danger" type="button" data-ac-grant-revoke="${escapeHtml(grant.id)}">撤销</button></div>`).join("")}</div></section>
    </div>` : `<div class="ac-empty"><div><h2>暂无成员</h2></div></div>`}</section>
  </div>`;
}

const accessControlAuditActionText: Record<string, string> = {
  "member.create": "新增成员",
  "member.update": "更新成员",
  "organization.create": "新增组织",
  "organization.update": "更新组织",
  "organization.assign": "调整组织归属",
  "role.create": "新增角色",
  "role.clone": "复制角色",
  "role.update": "更新角色",
  "role.disable": "停用角色",
  "role.permissions.replace": "发布角色权限",
  "member.roles.replace": "调整成员角色",
  "member.grants.create": "新增临时授权",
  "member.grants.revoke": "撤销临时授权",
  "member.delete": "删除成员"
};

const accessControlAuditTargetText: Record<string, string> = {
  tenant: "公司权限",
  membership: "公司成员",
  member: "公司成员",
  organization: "组织节点",
  role: "角色模板",
  grant: "临时授权"
};

function renderAccessControlAudit(overview: AccessControlOverview) {
  const highRiskCount = overview.permissions.filter((permission) => permission.riskLevel === "high" || permission.riskLevel === "critical").length;
  return `<div class="ac-workbench ac-audit-layout">
    <section class="ac-pane">
      <div class="ac-pane-head"><div class="ac-pane-title"><h2>权限变更记录</h2><span>最近 100 条操作</span></div><span class="ac-audit-note">仅记录已提交的权限变更</span></div>
      <div class="ac-member-table-wrap"><table class="ac-member-table ac-audit-table"><thead><tr><th>时间</th><th>操作者</th><th>变更对象</th><th>动作</th><th>结果</th></tr></thead><tbody>${accessControlAuditEvents.map((event) => { const actor = overview.members.find((member) => member.id === event.actorIdentityId); const createdAt = new Date(event.createdAt); return `<tr><td><time class="ac-audit-time"><b>${escapeHtml(createdAt.toLocaleDateString("zh-CN"))}</b><small>${escapeHtml(createdAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }))}</small></time></td><td><div class="ac-audit-actor"><span class="ac-avatar">${escapeHtml(actor?.avatar || actor?.name.slice(0, 2) || "管")}</span><span><b>${escapeHtml(actor?.name || "系统管理员")}</b><small>${escapeHtml(actor?.email || "管理员操作")}</small></span></div></td><td><span class="ac-audit-target"><b>${escapeHtml(accessControlAuditTargetText[event.targetType] || "权限对象")}</b><small>变更记录已留痕</small></span></td><td><span class="ac-audit-action"><b>${escapeHtml(accessControlAuditActionText[event.actionCode] || "权限配置变更")}</b><small>已提交</small></span></td><td><span class="ac-status-chip ${event.resultStatus === "success" ? "active" : "disabled"}">${event.resultStatus === "success" ? "成功" : "失败"}</span></td></tr>`; }).join("") || `<tr><td colspan="5"><div class="ac-table-empty">暂无权限变更记录</div></td></tr>`}</tbody></table></div>
    </section>
    <aside class="ac-pane">
      <div class="ac-pane-head"><h3>授权基线</h3><span class="ac-status-chip active">运行中</span></div>
      <div class="ac-overview-list">
        <div class="ac-overview-row"><span>权限目录</span><b>${overview.foundation.permissionCount} 项</b></div>
        <div class="ac-overview-row"><span>高风险权限</span><b>${highRiskCount} 项</b></div>
        <div class="ac-overview-row"><span>公司边界</span><b>强制隔离</b></div>
        <div class="ac-overview-row"><span>未授权请求</span><b>默认拒绝</b></div>
        <div class="ac-overview-row"><span>基线版本</span><b>${escapeHtml(overview.foundation.schemaVersion)}</b></div>
      </div>
    </aside>
  </div>`;
}

function openAccessControlGuide() {
  openModal("权限管理使用说明", `<div class="ac-guide">
    <section class="ac-guide-access"><span class="ac-guide-access-mark">权限</span><div><b>仅超级管理员和管理员可以设置</b><p>其他成员不会显示权限管理入口。管理员在所属公司范围内配置，实际可执行操作仍以当前账号获得的管理权限为准。</p></div></section>
    <div class="ac-guide-heading"><h3>推荐配置顺序</h3><span>从组织边界到成员生效</span></div>
    <ol class="ac-guide-steps">
      <li><span class="ac-guide-step-no">01</span><div><b>建立组织架构</b><p>先维护部门或业务组，明确成员的数据归属边界。</p></div></li>
      <li><span class="ac-guide-step-no">02</span><div><b>创建角色并配置权限</b><p>在角色管理中选择角色，逐项设置授权范围，检查无误后点击“发布权限”。</p></div></li>
      <li><span class="ac-guide-step-no">03</span><div><b>维护公司成员</b><p>新增成员或调整成员状态、所属组织；停用成员前先确认其未负责关键业务。</p></div></li>
      <li><span class="ac-guide-step-no">04</span><div><b>给成员分配角色</b><p>在成员授权中选择成员，勾选一个或多个角色并保存。临时授权必须填写原因和截止时间。</p></div></li>
      <li><span class="ac-guide-step-no">05</span><div><b>通过审计复核</b><p>前往权限审计确认操作者、变更对象、动作和结果，保证关键调整可追溯。</p></div></li>
    </ol>
    <div class="ac-guide-heading"><h3>数据范围怎么选</h3><span>不同权限项提供的范围可能不同</span></div>
    <div class="ac-guide-scopes"><div class="ac-guide-scope"><b>本人</b><span>仅处理成员本人负责的数据</span></div><div class="ac-guide-scope"><b>本组织及下级</b><span>适合经理和区域负责人</span></div><div class="ac-guide-scope"><b>当前公司</b><span>覆盖本公司全部业务数据</span></div><div class="ac-guide-scope"><b>公池</b><span>仅操作公司共享资源</span></div></div>
    <p class="ac-guide-note">建议遵循最小权限原则：优先授予满足岗位需要的最小范围，临时需求使用有截止时间的临时授权。</p>
  </div>`, `<button class="btn primary" type="button" data-modal-close>我知道了</button>`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("ac-guide-modal");
  const description = qs<HTMLElement>("#modalDescription");
  if (description) description.textContent = "管理员配置组织、角色和成员授权的操作指引";
}

function mutateAccessControlModule(
  overview: AccessControlOverview,
  roleId: string,
  moduleId: string,
  action: "enable" | "disable"
) {
  const role = overview.roles.find((item) => item.id === roleId);
  const module = accessControlUiModules.find((item) => item.id === moduleId);
  if (!role || !module) return;
  const stateInfo = accessControlModuleState(overview, role, module);
  if (action === "disable" && stateInfo.closeLocked) {
    const names = stateInfo.protectedBaseline.slice(0, 2).map((permission) => permission.name).join("、");
    toast(`该模块包含系统预设角色的基础权限：${names}${stateInfo.protectedBaseline.length > 2 ? "等" : ""}，请复制角色后调整`, "error");
    return;
  }
  const modulePermissionCodes = new Set(module.permissionCodes);
  const bindings = overview.permissions.flatMap((permission) => {
    const current = permission.grants[role.id] || "none";
    if (action === "disable" && modulePermissionCodes.has(permission.code)) return [];
    if (action === "enable" && modulePermissionCodes.has(permission.code)) {
      return [{ permissionCode: permission.code, scopeMode: current === "none" ? accessControlSuggestedScope(role, permission) : current }];
    }
    return current === "none" ? [] : [{ permissionCode: permission.code, scopeMode: current }];
  });
  const reason = action === "enable" ? `开通界面模块：${module.name}` : `关闭界面模块：${module.name}`;
  void mutateAccessControl(() => api(`/api/v1/roles/${encodeURIComponent(role.id)}/permissions`, {
    method: "PUT",
    body: JSON.stringify({ ...accessControlTenantBody(overview), bindings, reason })
  }), action === "enable" ? "界面模块已开通" : "界面模块已关闭");
}

function openAccessControlModuleDetail(overview: AccessControlOverview, roleId: string, moduleId: string) {
  const role = overview.roles.find((item) => item.id === roleId);
  const module = accessControlUiModules.find((item) => item.id === moduleId);
  if (!role || !module) return;
  const permissions = accessControlModulePermissions(overview, module);
  const rows = permissions.map((permission) => `<tr><td><b>${escapeHtml(permission.name)}</b><small>${escapeHtml(permission.code)}</small></td><td>${accessControlScopeBadge(permission.grants[role.id] || "none")}</td><td>${escapeHtml(permission.introducedVersion || "当前版本")}</td><td>${escapeHtml(permission.riskLevel)}</td></tr>`).join("");
  openModal(`${module.name} · ${role.name}`, `<div class="ac-ui-detail"><p>${escapeHtml(module.summary)}</p><div class="ac-ui-views"><span>相关界面</span><strong>${escapeHtml(module.views.map((view) => viewLabels[view] || view).join("、"))}</strong></div><table><thead><tr><th>权限</th><th>当前范围</th><th>版本</th><th>风险</th></tr></thead><tbody>${rows || `<tr><td colspan="4">暂无权限项</td></tr>`}</tbody></table></div>`, `<button class="btn" data-modal-close>关闭</button><button class="btn primary" id="acModuleJumpRole">去角色权限明细</button>`);
  qs<HTMLButtonElement>("#acModuleJumpRole")?.addEventListener("click", () => {
    closeModal();
    accessControlSelectedRoleId = role.id;
    activateNavView("role-management", renderAccessControl);
  });
}

function bindAccessControlInteractions(overview: AccessControlOverview) {
  const root = activeAccessControlRoot();
  if (!root) return;
  const find = <T extends Element>(selector: string) => root.querySelector<T>(selector);
  const findAll = <T extends Element>(selector: string) => [...root.querySelectorAll<T>(selector)];
  find<HTMLSelectElement>("#accessControlCompanySelect")?.addEventListener("change", (event) => {
    const teamId = (event.currentTarget as HTMLSelectElement).value;
    accessControlOverview = null;
    void loadAccessControl(teamId);
  });
  findAll<HTMLButtonElement>("[data-ac-company]").forEach((button) => button.addEventListener("click", () => void loadAccessControl(button.dataset.acCompany || "")));
  find<HTMLButtonElement>("[data-ac-refresh]")?.addEventListener("click", () => void loadAccessControl(overview.company?.id || ""));
  find<HTMLButtonElement>("[data-ac-guide]")?.addEventListener("click", openAccessControlGuide);
  find<HTMLButtonElement>("[data-ac-add-member]")?.addEventListener("click", () => openAccessControlMemberCreator(overview));
  find<HTMLButtonElement>("[data-ac-org-add]")?.addEventListener("click", () => openAccessControlOrganizationEditor(overview));
  findAll<HTMLButtonElement>("[data-ac-org-edit]").forEach((button) => button.addEventListener("click", () => openAccessControlOrganizationEditor(overview, button.dataset.acOrgEdit || "")));
  findAll<HTMLButtonElement>("[data-ac-member-edit]").forEach((button) => button.addEventListener("click", () => openAccessControlMemberEditor(overview, button.dataset.acMemberEdit || "")));
  // 组织架构页的行整行可点（打开分配权限），所以这两个按钮必须掐断冒泡，否则点删除会先跳走
  findAll<HTMLButtonElement>("[data-ac-member-toggle]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const userId = button.dataset.acMemberToggle || "";
    const next = button.dataset.acMemberNext === "active" ? "active" : "suspended";
    void mutateAccessControl(
      () => api(`/api/v1/members/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ ...accessControlTenantBody(overview), status: next, reason: next === "active" ? "恢复成员" : "停用成员" }) }),
      next === "active" ? "成员已恢复" : "成员已停用，将立即失去登录状态"
    );
  }));
  findAll<HTMLButtonElement>("[data-ac-member-delete]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const member = overview.members.find((item) => item.id === (button.dataset.acMemberDelete || ""));
    if (!member) { toast("成员信息已变化，请刷新后重试", "error"); return; }
    openAccessControlMemberDeleter(overview, member);
  }));
  findAll<HTMLButtonElement>("[data-ac-org-filter]").forEach((button) => button.addEventListener("click", () => {
    accessControlOrganizationFilter = button.dataset.acOrgFilter === "unassigned" ? "unassigned" : "all";
    renderAccessControl();
  }));
  findAll<HTMLButtonElement>("[data-ac-role]").forEach((button) => button.addEventListener("click", () => {
    accessControlSelectedRoleId = button.dataset.acRole || "";
    renderAccessControl();
  }));
  findAll<HTMLButtonElement>("[data-ac-module-enable]").forEach((button) => button.addEventListener("click", () => mutateAccessControlModule(overview, accessControlSelectedRoleId, button.dataset.acModuleEnable || "", "enable")));
  findAll<HTMLButtonElement>("[data-ac-module-disable]").forEach((button) => button.addEventListener("click", () => mutateAccessControlModule(overview, accessControlSelectedRoleId, button.dataset.acModuleDisable || "", "disable")));
  findAll<HTMLButtonElement>("[data-ac-module-detail]").forEach((button) => button.addEventListener("click", () => openAccessControlModuleDetail(overview, accessControlSelectedRoleId, button.dataset.acModuleDetail || "")));
  find<HTMLButtonElement>("[data-ac-role-add]")?.addEventListener("click", () => openAccessControlRoleCreator(overview));
  find<HTMLButtonElement>("[data-ac-role-clone]")?.addEventListener("click", (event) => openAccessControlRoleCreator(overview, (event.currentTarget as HTMLButtonElement).dataset.acRoleClone || ""));
  find<HTMLButtonElement>("[data-ac-role-disable]")?.addEventListener("click", (event) => {
    const roleId = (event.currentTarget as HTMLButtonElement).dataset.acRoleDisable || "";
    void mutateAccessControl(() => api(`/api/v1/roles/${encodeURIComponent(roleId)}/disable`, { method: "POST", body: JSON.stringify({ ...accessControlTenantBody(overview), reason: "角色停用" }) }), "角色已停用");
  });
  find<HTMLButtonElement>("[data-ac-role-save]")?.addEventListener("click", (event) => {
    const roleId = (event.currentTarget as HTMLButtonElement).dataset.acRoleSave || "";
    const bindings = findAll<HTMLSelectElement>("[data-ac-role-scope]").flatMap((select) => select.value === "none" ? [] : [{ permissionCode: select.dataset.acRoleScope || "", scopeMode: select.value }]);
    void mutateAccessControl(() => api(`/api/v1/roles/${encodeURIComponent(roleId)}/permissions`, { method: "PUT", body: JSON.stringify({ ...accessControlTenantBody(overview), bindings, reason: "角色权限发布" }) }), "角色权限已发布");
  });
  findAll<HTMLElement>("[data-ac-member-open]").forEach((row) => row.addEventListener("click", () => {
    accessControlSelectedMemberId = row.dataset.acMemberOpen || "";
    activateNavView("member-authorization", renderAccessControl);
  }));
  findAll<HTMLButtonElement>("[data-ac-member]").forEach((button) => button.addEventListener("click", () => {
    accessControlSelectedMemberId = button.dataset.acMember || "";
    renderAccessControl();
  }));
  find<HTMLButtonElement>("[data-ac-member-role-save]")?.addEventListener("click", (event) => {
    const membershipId = (event.currentTarget as HTMLButtonElement).dataset.acMemberRoleSave || "";
    const roleIds = findAll<HTMLInputElement>("#iamMemberRoleIds input:checked").map((input) => input.value);
    if (!roleIds.length) { toast("至少保留一个角色", "error"); return; }
    void mutateAccessControl(() => api(`/api/v1/members/${encodeURIComponent(membershipId)}/role-assignments`, { method: "PUT", body: JSON.stringify({ ...accessControlTenantBody(overview), roleIds, reason: "成员角色调整" }) }), "成员角色已更新");
  });
  find<HTMLButtonElement>("[data-ac-member-grant]")?.addEventListener("click", (event) => {
    const membershipId = (event.currentTarget as HTMLButtonElement).dataset.acMemberGrant || "";
    const raw = find<HTMLInputElement>("#iamGrantUntil")?.value || "";
    if (!raw) { toast("请选择临时授权截止时间", "error"); return; }
    void mutateAccessControl(() => api(`/api/v1/members/${encodeURIComponent(membershipId)}/temporary-grants`, { method: "POST", body: JSON.stringify({ ...accessControlTenantBody(overview), permissionCode: find<HTMLSelectElement>("#iamGrantPermission")?.value, scopeMode: find<HTMLSelectElement>("#iamGrantScope")?.value, validUntil: new Date(raw).toISOString(), reason: find<HTMLInputElement>("#iamGrantReason")?.value || "临时业务授权" }) }), "临时授权已生效");
  });
  findAll<HTMLButtonElement>("[data-ac-grant-revoke]").forEach((button) => button.addEventListener("click", () => {
    void mutateAccessControl(() => api(`/api/v1/member-temporary-grants/${encodeURIComponent(button.dataset.acGrantRevoke || "")}`, { method: "DELETE", body: JSON.stringify(accessControlTenantBody(overview)) }), "临时授权已撤销");
  }));
  const bindSearch = (inputId: string, containerId: string) => {
    find<HTMLInputElement>(`#${inputId}`)?.addEventListener("input", (event) => {
      const value = (event.currentTarget as HTMLInputElement).value.trim().toLowerCase();
      findAll<HTMLElement>(`#${containerId} [data-ac-search-row]`).forEach((row) => {
        row.hidden = Boolean(value && !String(row.dataset.acSearchRow || "").includes(value));
      });
    });
  };
  bindSearch("accessControlOrganizationSearch", "accessControlOrganizationRows");
  bindSearch("accessControlMemberSearch", "accessControlMemberList");
}

function renderAccessControl() {
  const root = activeAccessControlRoot();
  const overview = accessControlOverview;
  if (!root || !overview) return;
  const page = activeAccessControlPage();
  const pageTitle: Record<AccessControlPage, string> = {
    members: "成员管理",
    organization: "组织架构",
    roles: "角色管理",
    ui: "界面开通",
    authorization: "成员授权",
    audit: "权限审计"
  };
  const body = !overview.company
    ? renderAccessControlCompanyPicker(overview)
    : page === "roles"
      ? renderAccessControlRoles(overview)
      : page === "ui"
        ? renderAccessControlUiAccess(overview)
      : page === "authorization"
        ? renderAccessControlMembers(overview)
        : page === "organization"
          ? renderAccessControlOrganization(overview)
          : page === "audit"
            ? renderAccessControlAudit(overview)
            : renderAccessControlMemberManagement(overview);
  root.innerHTML = `<div class="ac-shell">
    <header class="ac-page-head"><div class="ac-title"><div class="ac-title-line"><h1>${pageTitle[page]}</h1><span class="ac-boundary-state">公司级隔离</span></div><p>${overview.company ? `当前公司：${escapeHtml(overview.company.name)}` : "平台公司目录"}</p></div><div class="ac-head-actions">${accessControlCompanyOptions(overview)}<button class="btn" type="button" data-ac-refresh>刷新</button>${page === "members" ? `<button class="btn primary" type="button" data-ac-add-member data-permission="member.manage" ${overview.company ? "" : "disabled"}>新增成员</button>` : ""}</div></header>
    <div class="ac-tab-panel">${body}</div>
    <button class="ac-guide-fab" type="button" data-ac-guide aria-label="权限使用说明" title="权限使用说明">?</button>
  </div>`;
  qsa<HTMLElement>("[data-permission]", root).forEach((node) => {
    const permission = String(node.dataset.permission || "").trim();
    if (permission && state.iamCapabilities) node.hidden = !hasIamCapability(permission);
  });
  bindAccessControlInteractions(overview);
}

export async function renderAccounts(user: User) {
  const tbody = qs<HTMLElement>("#settings tbody");
  if (!tbody) return;
  const canManage = hasIamCapability("member.manage");
  const addButton = qsa<HTMLButtonElement>("#settings .page-head .btn").find((button) => button.textContent?.includes("新增账号"));
  if (addButton) {
    addButton.disabled = !canManage;
    addButton.title = canManage ? "新增系统账号" : "只有管理员和超级管理员可以管理账号";
  }
  if (!canManage) {
    void refreshMysqlImportStatus();
    state.accounts = [user];
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>账号管理仅管理员可用</b><span>当前账号可查看授权范围说明；账号新增、停用和角色调整由管理员或超级管理员处理。</span></div></td></tr>`;
    renderAccountMetrics([user], false);
    return;
  }
  const accounts = (await api<{ accounts: User[] }>("/api/accounts")).accounts;
  state.accounts = accounts;
  renderAccountMetrics(accounts, true);
  tbody.innerHTML = accounts.map((account) => {
    const isDisabled = (account as User & { status?: string }).status === "disabled";
    const status = isDisabled ? "停用" : "启用";
    const canManageAccount = canManageRoleInUi(account);
    const disableAllowed = canManageAccount && !isDisabled;
    const disableLabel = account.id === user.id ? "当前账号" : isDisabled ? "已停用" : disableAllowed ? "停用" : "受保护";
    const expiryTitle = account.expiresAt ? ` title="${escapeHtml(formatDateTime(account.expiresAt))} 到期"` : "";
    return `<tr data-account-id="${escapeHtml(account.id)}"><td><div class="company"><span class="avatar">${escapeHtml(account.avatar)}</span><div><b>${escapeHtml(account.name)}</b><span>${escapeHtml(account.email)}</span></div></div></td><td>${badge(roleLabel[account.role], account.role === "super_admin" ? "red" : account.role === "admin" ? "amber" : account.role === "manager" ? "green" : "")}</td><td>${accountBusinessScope(account.role)}</td><td>${accountPersonalScope(account.role)}</td><td><div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">${badge(status, isDisabled ? "gray" : "green")}${isDisabled ? "" : `<span${expiryTitle}>${accountExpiryBadge(account)}</span>`}</div></td><td><div class="inline-actions"><button class="btn" data-password-account ${canManageAccount ? "" : "disabled"}>设密码</button><button class="btn" data-expiry-account ${canManageAccount ? "" : "disabled"}>有效期</button><button class="btn" data-disable-account ${disableAllowed ? "" : "disabled"}>${disableLabel}</button><button class="btn danger" data-delete-account ${canManageAccount ? "" : "disabled"}>删除</button></div></td></tr>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-password-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => openPasswordModal(button.closest<HTMLElement>("tr")?.dataset.accountId || ""));
  });
  qsa<HTMLButtonElement>("[data-expiry-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => {
      const account = state.accounts.find((item) => item.id === (button.closest<HTMLElement>("tr")?.dataset.accountId || ""));
      if (account) openAccountExpiryModal(account);
    });
  });
  qsa<HTMLButtonElement>("[data-disable-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => void disableAccount(button.closest<HTMLElement>("tr")?.dataset.accountId || "", button));
  });
  qsa<HTMLButtonElement>("[data-delete-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => void deleteAccount(button.closest<HTMLElement>("tr")?.dataset.accountId || "", button));
  });
  void refreshMysqlImportStatus();
}

function renderAccountMetrics(accounts: User[], canManage: boolean) {
  const cards = qsa<HTMLElement>("#settings .dense-card");
  const active = accounts.filter((account) => (account as User & { status?: string }).status !== "disabled").length;
  const managers = accounts.filter((account) => account.role === "manager").length;
  const sales = accounts.filter((account) => account.role === "sales").length;
  const values = [
    { value: String(active), note: canManage ? "来自可见账号数据" : "当前账号" },
    { value: String(managers), note: "可见范围内" },
    { value: String(sales), note: "可见范围内" },
    { value: "--", note: "当前接口未提供登录异常统计" }
  ];
  cards.forEach((card, index) => {
    const value = values[index];
    const strong = card.querySelector("b");
    const note = card.querySelector("small");
    if (strong && value) strong.textContent = value.value;
    if (note && value) note.textContent = value.note;
  });
}

function canManageRoleInUi(account: User) {
  return Boolean(state.user && hasIamCapability("member.manage")
    && account.id !== state.user.id
    && account.teamId === state.user.teamId
    && account.role !== "super_admin");
}

/** 账号有效期徽章：永久 / 剩 N 天 / 今天到期 / 已过期 */
function accountExpiryBadge(account: User) {
  if (!account.expiresAt) return badge("永久", "gray");
  if (account.expired) return badge("已过期", "red");
  const days = account.daysLeft;
  if (days === null || days === undefined) return badge("限期", "amber");
  if (days <= 0) return badge("今天到期", "red");
  if (days <= 3) return badge(`剩 ${days} 天`, "red");
  if (days <= 7) return badge(`剩 ${days} 天`, "amber");
  return badge(`剩 ${days} 天`, "blue");
}

/** 有效期管理弹窗：续期 / 改期 / 恢复永久 */
function openAccountExpiryModal(account: User) {
  if (!state.user || !hasIamCapability("member.manage")) {
    toast("无账号管理权限", "error");
    return;
  }
  const current = account.expiresAt
    ? `${formatDateTime(account.expiresAt)}${account.expired ? "（已过期）" : account.daysLeft !== null && account.daysLeft !== undefined ? `（剩 ${account.daysLeft} 天）` : ""}`
    : "永久有效";
  openModal(`账号有效期 · ${account.name}`, `
    <div class="form-grid">
      <div class="form-field full"><label>当前有效期</label><input readonly value="${escapeHtml(current)}"></div>
      <div class="form-field"><label>设置为</label>
        <select id="accountExpiryMode">
          <option value="7" selected>从现在起 7 天（标准）</option>
          <option value="3">从现在起 3 天</option>
          <option value="30">从现在起 30 天</option>
          <option value="90">从现在起 90 天</option>
          <option value="365">从现在起 365 天</option>
          <option value="custom">自定义到期时间</option>
          <option value="forever">恢复永久有效</option>
        </select>
      </div>
      <div class="form-field" id="accountExpiryCustomField" hidden><label>到期时间</label><input id="accountExpiryCustom" type="datetime-local"></div>
      <div class="form-field full" style="color:#758296;font-size:10px;line-height:1.5">到期后该账号无法登录、已有登录立即失效；恢复永久后可正常使用。</div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveAccountExpiryButton">保存有效期</button>`);
  qs<HTMLSelectElement>("#accountExpiryMode")?.addEventListener("change", (event) => {
    const mode = (event.currentTarget as HTMLSelectElement).value;
    const field = qs<HTMLElement>("#accountExpiryCustomField");
    if (field) field.hidden = mode !== "custom";
  });
  qs("#saveAccountExpiryButton")?.addEventListener("click", () => void saveAccountExpiry(account));
}

async function saveAccountExpiry(account: User) {
  const mode = qs<HTMLSelectElement>("#accountExpiryMode")?.value || "forever";
  let body: Record<string, unknown> = {};
  try {
    if (mode === "forever") {
      body = {};
    } else if (mode === "custom") {
      const raw = qs<HTMLInputElement>("#accountExpiryCustom")?.value.trim() || "";
      if (!raw) {
        toast("请选择自定义到期时间", "error");
        return;
      }
      body = { expiresAt: new Date(raw).toISOString() };
    } else {
      body = { expiresInDays: Number(mode) };
    }
    const result = await api<{ account: User }>(`/api/accounts/${encodeURIComponent(account.id)}/expiry`, {
      method: "PATCH",
      body: JSON.stringify(body)
    });
    const index = state.accounts.findIndex((item) => item.id === account.id);
    if (index >= 0) state.accounts[index] = result.account;
    closeModal();
    toast(mode === "forever" ? "已恢复永久有效" : "账号有效期已更新", "success");
    await renderAccounts(state.user!);
    await loadTrialAccounts().catch(() => undefined);
  } catch (error) {
    toast(error instanceof Error ? error.message : "有效期保存失败", "error");
  }
}

/* ==================== 临时账号：批量生成 + 有效期管理 + 导出 ==================== */

/** 临时账号标准有效期：7 天（与后端 TRIAL_ACCOUNT_DAYS 对齐） */
const TRIAL_ACCOUNT_DAYS = 7;

/** 最近一次批量生成的明文凭据（仅当前会话内存，刷新即丢） */
let lastGeneratedTrialBatch: Array<{ id: string; name: string; email: string; password: string; expiresAt: string }> = [];

export async function loadTrialAccounts() {
  const panel = qs<HTMLElement>("#trialAccountsPanel");
  if (!panel) return;
  const canManage = hasIamCapability("member.manage");
  const isSuper = state.user?.role === "super_admin" || canManage;
  panel.hidden = !canManage;
  if (!canManage) return;
  const refreshButton = qs<HTMLButtonElement>("#trialRefreshButton");
  const exportButton = qs<HTMLButtonElement>("#trialExportButton");
  const generateButton = qs<HTMLButtonElement>("#trialGenerateButton");
  if (generateButton) {
    generateButton.hidden = !isSuper;
    if (!generateButton.dataset.trialBound) {
      generateButton.dataset.trialBound = "1";
      generateButton.addEventListener("click", openTrialGenerateModal);
    }
  }
  if (refreshButton && !refreshButton.dataset.trialBound) {
    refreshButton.dataset.trialBound = "1";
    refreshButton.addEventListener("click", () => void loadTrialAccounts());
  }
  if (exportButton && !exportButton.dataset.trialBound) {
    exportButton.dataset.trialBound = "1";
    exportButton.addEventListener("click", exportExistingTrialAccounts);
  }
  const tbody = qs<HTMLElement>("#trialAccountsBody");
  if (!tbody) return;
  try {
    const accounts = (await api<{ accounts: User[] }>("/api/accounts")).accounts;
    state.accounts = accounts;
    const expiring = accounts.filter((account) => (account.expiresAt || "").trim());
    tbody.innerHTML = expiring.map((account) => {
      const disabled = (account as User & { status?: string }).status === "disabled";
      return `<tr data-trial-row="${escapeHtml(`${account.name} ${account.email}`.toLowerCase())}"><td><div class="company"><span class="avatar">${escapeHtml(account.avatar)}</span><div><b>${escapeHtml(account.name)}</b><span>${escapeHtml(account.email)}</span></div></div></td><td>${escapeHtml(roleLabel[account.role] || account.role)} · ${escapeHtml(account.teamId)}</td><td>${accountExpiryBadge(account)}</td><td>${badge(disabled ? "停用" : "启用", disabled ? "gray" : "green")}</td><td><div class="inline-actions"><button class="btn" data-trial-renew="${escapeHtml(account.id)}" ${isSuper ? "" : "disabled"} title="在当前到期时间上加 7 天">+7 天</button><button class="btn" data-trial-expiry="${escapeHtml(account.id)}" ${isSuper ? "" : "disabled"}>有效期</button></div></td></tr>`;
    }).join("") || `<tr><td colspan="5" style="color:#8490a1;font-size:11px;">暂无带有效期的账号——用「生成临时账号」创建 7 天试用账号。</td></tr>`;
    qsa<HTMLButtonElement>("[data-trial-renew]", tbody).forEach((button) => {
      button.addEventListener("click", () => void renewTrialAccount(button.dataset.trialRenew || "", button));
    });
    qsa<HTMLButtonElement>("[data-trial-expiry]", tbody).forEach((button) => {
      button.addEventListener("click", () => {
        const account = state.accounts.find((item) => item.id === button.dataset.trialExpiry);
        if (account) openAccountExpiryModal(account);
      });
    });
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#b4423d;font-size:11px;">加载失败：${escapeHtml(error instanceof Error ? error.message : "未知错误")}</td></tr>`;
  }
}

/** 在当前到期时间上加 7 天（已过期则从此刻起算），不会缩短已有剩余时间 */
async function renewTrialAccount(accountId: string, button?: HTMLButtonElement) {
  if (!hasIamCapability("member.manage")) {
    toast("无账号管理权限", "error");
    return;
  }
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) {
    toast("账号已变化，请刷新后重试", "error");
    return;
  }
  if (button?.disabled) return;
  if (button) {
    button.disabled = true;
    button.textContent = "续期中…";
  }
  const now = Date.now();
  const current = account.expiresAt ? Date.parse(account.expiresAt) : NaN;
  const base = Number.isFinite(current) && current > now ? current : now;
  try {
    await api(`/api/accounts/${encodeURIComponent(accountId)}/expiry`, {
      method: "PATCH",
      body: JSON.stringify({ expiresAt: new Date(base + TRIAL_ACCOUNT_DAYS * 86_400_000).toISOString() })
    });
    toast(`已续 ${TRIAL_ACCOUNT_DAYS} 天`, "success");
    if (state.user) await renderAccounts(state.user).catch(() => undefined);
    await loadTrialAccounts().catch(() => undefined);
  } catch (error) {
    toast(error instanceof Error ? error.message : "续期失败", "error");
    if (button) {
      button.disabled = false;
      button.textContent = `+${TRIAL_ACCOUNT_DAYS} 天`;
    }
  }
}

function openTrialGenerateModal() {
  if (!hasIamCapability("member.manage")) {
    toast("只有管理员可以生成临时账号", "error");
    return;
  }
  openModal("生成临时账号", `
    <div class="form-grid">
      <div class="form-field"><label>数量（1-200）</label><input id="trialCount" type="number" min="1" max="200" value="1"></div>
      <div class="form-field"><label>有效天数</label><select id="trialDays"><option value="7" selected>7 天（标准）</option><option value="1">1 天</option><option value="3">3 天</option><option value="30">30 天</option><option value="90">90 天</option></select></div>
      <div class="form-field"><label>名称前缀</label><input id="trialNamePrefix" value="临时账号"></div>
      <div class="form-field"><label>邮箱前缀</label><input id="trialEmailPrefix" value="trial"></div>
      <div class="form-field"><label>邮箱域名</label><input id="trialEmailDomain" value="goodjob.com"></div>
      <div class="form-field"><label>团队编号</label><input id="trialTeamId" value="europe" placeholder="例如 europe"></div>
      <div class="form-field full" style="color:#758296;font-size:10px;line-height:1.5">账号密码随机生成，只在生成结果里显示一次，请当场复制或导出 CSV。到期后账号自动禁止登录、已有登录立即失效；需要延期可在列表里点「+7 天」。</div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="trialGenerateSubmitButton">生成</button>`);
  qs("#trialGenerateSubmitButton")?.addEventListener("click", () => void generateTrialAccounts());
}

async function generateTrialAccounts() {
  const count = Number(qs<HTMLInputElement>("#trialCount")?.value || 0);
  const days = Number(qs<HTMLSelectElement>("#trialDays")?.value || TRIAL_ACCOUNT_DAYS);
  const namePrefix = qs<HTMLInputElement>("#trialNamePrefix")?.value.trim() || "临时账号";
  const emailPrefix = qs<HTMLInputElement>("#trialEmailPrefix")?.value.trim() || "trial";
  const emailDomain = qs<HTMLInputElement>("#trialEmailDomain")?.value.trim() || "goodjob.com";
  const teamId = qs<HTMLInputElement>("#trialTeamId")?.value.trim() || "";
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    toast("数量需在 1-200 之间", "error");
    return;
  }
  if (!teamId || teamId === "all") {
    toast("请填写临时账号所属团队编号", "error");
    return;
  }
  const button = qs<HTMLButtonElement>("#trialGenerateSubmitButton");
  if (button) {
    button.disabled = true;
    button.textContent = "生成中…";
  }
  try {
    const result = await api<{ generated: number; accounts: Array<{ id: string; name: string; email: string; password: string; expiresAt: string }> }>("/api/accounts/generate", {
      method: "POST",
      body: JSON.stringify({ count, expiresInDays: days, namePrefix, emailPrefix, emailDomain, teamId })
    });
    lastGeneratedTrialBatch = result.accounts;
    if (state.user) await renderAccounts(state.user).catch(() => undefined);
    await loadTrialAccounts().catch(() => undefined);
    closeModal();
    renderTrialBatchResult(result.accounts, days, teamId);
    toast(`已生成 ${result.generated} 个临时账号（${days} 天有效）`, "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "生成失败", "error");
    if (button) {
      button.disabled = false;
      button.textContent = "生成";
    }
  }
}

function renderTrialBatchResult(accounts: Array<{ id: string; name: string; email: string; password: string; expiresAt: string }>, days: number, teamId: string) {
  openModal(`生成成功 · ${accounts.length} 个临时账号（${days} 天）`, `
    <div style="max-height:46vh;overflow:auto;">
      <table class="items-table">
        <thead><tr><th>姓名</th><th>登录邮箱</th><th>密码</th><th>到期时间</th></tr></thead>
        <tbody>${accounts.map((account) => `<tr><td>${escapeHtml(account.name)}</td><td>${escapeHtml(account.email)}</td><td><code>${escapeHtml(account.password)}</code></td><td>${escapeHtml(formatDateTime(account.expiresAt))}</td></tr>`).join("")}</tbody>
      </table>
    </div>
    <p style="color:#b4423d;font-size:10px;margin-top:10px;">密码仅本次显示，关闭弹窗后无法再次查看，请立即复制或导出 CSV（团队：${escapeHtml(teamId)}；${days} 天后自动失效）。</p>
  `, `<button class="btn" id="trialCopyButton">复制全部</button><button class="btn primary" id="trialExportCsvButton">导出 CSV</button>`);
  qs("#trialCopyButton")?.addEventListener("click", () => {
    const text = accounts.map((account) => `${account.name}    ${account.email}    ${account.password}    ${account.expiresAt}`).join("\n");
    void navigator.clipboard?.writeText(text).then(() => toast("已复制到剪贴板", "success")).catch(() => toast("复制失败，请手动选择文本复制", "error"));
  });
  qs("#trialExportCsvButton")?.addEventListener("click", () => exportTrialCsv(accounts));
}

function trialCsvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadTrialCsv(filename: string, header: string[], rows: Array<Array<string | number>>) {
  const lines = [header, ...rows].map((row) => row.map(trialCsvCell).join(","));
  const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** 导出刚生成的批次（含明文密码，仅生成后的当前会话可用） */
function exportTrialCsv(accounts: Array<{ id: string; name: string; email: string; password: string; expiresAt: string }>) {
  if (!accounts.length) {
    toast("没有可导出的账号", "error");
    return;
  }
  downloadTrialCsv(`临时账号_${new Date().toISOString().slice(0, 10)}.csv`,
    ["姓名", "登录邮箱", "密码", "到期时间"],
    accounts.map((account) => [account.name, account.email, account.password, formatDateTime(account.expiresAt)]));
}

/** 导出当前所有带有效期的账号（不含密码） */
function exportExistingTrialAccounts() {
  const accounts = state.accounts.filter((account) => (account.expiresAt || "").trim());
  if (!accounts.length) {
    toast("暂无带有效期的账号可导出", "error");
    return;
  }
  downloadTrialCsv(`有效期账号_${new Date().toISOString().slice(0, 10)}.csv`,
    ["姓名", "登录邮箱", "角色", "团队", "到期时间", "剩余天数", "状态"],
    accounts.map((account) => [
      account.name,
      account.email,
      roleLabel[account.role] || account.role,
      account.teamId,
      formatDateTime(account.expiresAt),
      account.daysLeft === null || account.daysLeft === undefined ? "—" : account.daysLeft,
      (account as User & { status?: string }).status === "disabled" ? "停用" : account.expired ? "已过期" : "启用"
    ]));
  toast(`已导出 ${accounts.length} 个账号`, "success");
}

function accountBusinessScope(role: Role) {
  if (role === "sales") return "本人业务数据";
  if (role === "manager") return "本团队业务数据";
  if (role === "admin") return "本团队业务数据 + 团队账号管理";
  return "全局业务数据 + 最高权限";
}

function accountPersonalScope(_role: Role) {
  return "待办/备忘仅本人";
}

async function saveAccount() {
  if (!state.user || !hasIamCapability("member.manage")) {
    toast("无账号管理权限", "error");
    return;
  }
  const name = qs<HTMLInputElement>("#accountNameInput")?.value.trim() || "";
  const email = qs<HTMLInputElement>("#accountEmailInput")?.value.trim() || "";
  const password = qs<HTMLInputElement>("#accountPasswordInput")?.value || "";
  const role = qs<HTMLSelectElement>("#accountRoleInput")?.value || "sales";
  const teamId = qs<HTMLInputElement>("#accountTeamInput")?.value.trim() || "";
  if (!name || !email || password.length < 8) {
    toast("请填写账号姓名、邮箱和至少 8 位密码", "error");
    return;
  }
  if (state.user.role === "super_admin" && role !== "super_admin" && !teamId) {
    toast("请填写账号所属团队编号", "error");
    return;
  }
  const expiryMode = qs<HTMLSelectElement>("#accountExpiryInput")?.value || "";
  let expiryPayload: Record<string, unknown> = {};
  if (expiryMode === "custom") {
    const raw = qs<HTMLInputElement>("#accountExpiryCreateInput")?.value.trim() || "";
    if (!raw) {
      toast("请选择自定义到期时间", "error");
      return;
    }
    expiryPayload = { expiresAt: new Date(raw).toISOString() };
  } else if (expiryMode) {
    expiryPayload = { expiresInDays: Number(expiryMode) };
  }
  const result = await api<{ account: User }>("/api/accounts", {
    method: "POST",
    body: JSON.stringify({
      name,
      email,
      password,
      role,
      teamId: role === "super_admin" ? "all" : teamId || state.user.teamId,
      ...expiryPayload
    })
  });
  state.accounts.unshift(result.account);
  await renderAccounts(state.user!);
  if (accessControlViews.some((view) => qs<HTMLElement>(`#${view}`)?.classList.contains("active"))) {
    await loadAccessControl(accessControlOverview?.company?.id || "");
  }
  closeModal();
  toast("账号已新增");
}

function openPasswordModal(id: string) {
  const account = state.accounts.find((item) => item.id === id);
  if (!account) {
    toast("账号不存在", "error");
    return;
  }
  if (!canManageRoleInUi(account)) {
    toast("无权设置该账号密码", "error");
    return;
  }
  openModal("设置账号密码", `
    <div class="form-grid">
      <div class="form-field full"><label>账号</label><input value="${escapeHtml(account.email)}" disabled></div>
      <div class="form-field full"><label>新密码</label><input id="accountNewPasswordInput" type="password" value="" autocomplete="new-password" placeholder="至少 8 位"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="savePasswordButton">保存密码</button>`);
  qs("#savePasswordButton")?.addEventListener("click", () => void saveAccountPassword(id));
}

async function saveAccountPassword(id: string) {
  const password = qs<HTMLInputElement>("#accountNewPasswordInput")?.value || "";
  if (password.length < 8) {
    toast("密码至少 8 位", "error");
    return;
  }
  await api(`/api/accounts/${id}/password`, {
    method: "PATCH",
    body: JSON.stringify({ password })
  });
  closeModal();
  toast("密码已更新");
}

async function disableAccount(id: string, button?: HTMLButtonElement) {
  if (!id || id === state.user?.id) {
    toast("当前登录账号不能停用", "error");
    return;
  }
  const account = state.accounts.find((item) => item.id === id);
  if (state.user?.role === "admin" && account?.role === "super_admin") {
    toast("管理员不能停用超级管理员", "error");
    return;
  }
  if (!account) {
    toast("账号不存在", "error");
    return;
  }
  if (!await confirmAction({
    title: "停用成员账号",
    message: "该成员会立即退出可登录账号范围。",
    detail: `${account.name}（${account.email}）`,
    detailLabel: "成员账号",
    consequences: ["成员将无法继续登录", "账号和名下业务数据仍会保留"],
    confirmLabel: "停用账号",
    tone: "warning"
  })) return;
  setButtonPending(button || null, true, "停用", "停用中");
  try {
    await api(`/api/accounts/${id}/disable`, { method: "PATCH" });
    await renderAccounts(state.user!);
    toast("成员账号已停用");
  } catch (error) {
    setButtonPending(button || null, false, "停用", "停用中");
    toast(error instanceof Error ? error.message : "停用账号失败", "error");
  }
}

async function deleteAccount(id: string, button?: HTMLButtonElement) {
  if (!id || id === state.user?.id) {
    toast("当前登录账号不能删除", "error");
    return;
  }
  const account = state.accounts.find((item) => item.id === id);
  if (!account || !canManageRoleInUi(account)) {
    toast("无权删除该账号", "error");
    return;
  }
  if (!await confirmAction({
    title: "删除成员账号",
    message: "该成员将无法继续登录 GoodJob CRM。",
    detail: `${account.name}（${account.email}）`,
    detailLabel: "成员账号",
    consequences: ["账号权限会立即失效", "该成员名下的业务数据不会随账号删除"],
    confirmLabel: "删除账号",
    tone: "danger"
  })) return;
  setButtonPending(button || null, true, "删除", "删除中");
  try {
    await api(`/api/accounts/${id}`, { method: "DELETE" });
    state.accounts = state.accounts.filter((item) => item.id !== id);
    await renderAccounts(state.user!);
    toast("成员账号已删除");
  } catch (error) {
    setButtonPending(button || null, false, "删除", "删除中");
    toast(error instanceof Error ? error.message : "删除账号失败", "error");
  }
}
