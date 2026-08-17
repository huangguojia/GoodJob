import { createHash, randomUUID } from "node:crypto";
import type mysql from "mysql2/promise";
import type { SessionUser } from "../types.js";
import { hashPassword, isPlatformIdentity } from "../auth.js";
import {
  IAM_FOUNDATION_SCHEMA_VERSION,
  IAM_PERMISSION_CATALOG,
  legacyPermissionScope,
  type IamScopeMode
} from "./iam-foundation.js";
import { loadIamCapabilitySnapshot, type IamCapabilitySnapshot } from "./iam-capabilities.js";

type Queryable = mysql.Pool | mysql.PoolConnection;
type AuditContext = { requestId?: string; ip?: string; reason?: string; ticketNo?: string };
type Mutation = "member.create" | "member.update" | "organization.create" | "organization.update" | "organization.assign" |
  "role.create" | "role.clone" | "role.update" | "role.disable" | "role.permissions.replace" |
  "member.roles.replace" | "member.grants.create" | "member.grants.revoke";

export interface IamManagementService {
  listPlatformTenants(actor: SessionUser): Promise<Record<string, unknown>>;
  getOverview(actor: SessionUser, requestedTenantId?: string): Promise<Record<string, unknown>>;
  listAudit(actor: SessionUser, query: { limit?: number; tenantId?: string; targetType?: string }): Promise<Record<string, unknown>>;
  mutate(actor: SessionUser, operation: Mutation, payload: Record<string, unknown>, context?: AuditContext): Promise<Record<string, unknown>>;
  evaluatePreview(actor: SessionUser, input: { permissionCode: string; objectTenantId?: string; ownerId?: string; scopeMode?: IamScopeMode }): Promise<Record<string, unknown>>;
}

function mysqlDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error("截止时间格式无效"), { status: 400 });
  const part = (number: number, width = 2) => String(number).padStart(width, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}.${part(date.getMilliseconds(), 3)}`;
}
function id(prefix: string) { return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 40)}`; }
function hash(value: string) { return createHash("sha256").update(value || "").digest("hex"); }
function json(value: unknown) { return JSON.stringify(value ?? null); }
function rows<T>(value: unknown) { return value as T[]; }
function one<T>(value: unknown) { return rows<T>(value)[0]; }
function jsonArray(value: unknown) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(String(value || "[]")); } catch { return []; }
}

const scopeRank: Record<string, number> = { none: 0, self: 1, org_unit: 2, org_subtree: 3, tenant: 4, public_pool: 5, assigned_set: 2 };
const roleNames: Record<string, string> = { admin: "公司管理员", manager: "销售主管", sales: "业务员" };
const MAX_TEMPORARY_GRANT_MS = 90 * 24 * 60 * 60 * 1000;

export function scopeCovers(granted: IamScopeMode, requested: IamScopeMode) {
  if (granted === requested || granted === "tenant") return true;
  if (requested === "public_pool") return granted === "public_pool";
  if (granted === "org_subtree") return ["self", "org_unit", "org_subtree"].includes(requested);
  if (granted === "org_unit") return requested === "self" || requested === "org_unit";
  return false;
}

async function assertDelegableBindings(
  queryable: Queryable,
  actor: SessionUser,
  entries: Array<{ permissionCode: string; scopeMode: IamScopeMode }>
) {
  const snapshot = await loadIamCapabilitySnapshot(queryable as mysql.Pool, actor);
  for (const entry of entries) {
    const grantedScopes = snapshot.permissions[entry.permissionCode] || [];
    if (!grantedScopes.some((scope) => scopeCovers(scope, entry.scopeMode))) {
      throw Object.assign(new Error(`不能授予超出当前账号范围的权限：${entry.permissionCode} (${entry.scopeMode})`), { status: 403 });
    }
  }
}

function protectedRoleTemplate(code: string): "admin" | "manager" | "sales" | null {
  if (["legacy_admin", "company_admin"].includes(code)) return "admin";
  if (["legacy_manager", "sales_manager"].includes(code)) return "manager";
  if (["legacy_sales", "sales_rep"].includes(code)) return "sales";
  return null;
}

const protectedRoleTemplateLabels: Record<"admin" | "manager" | "sales", string> = {
  admin: "公司管理员",
  manager: "销售主管",
  sales: "业务员"
};

const iamScopeModeLabels: Record<IamScopeMode, string> = {
  self: "本人",
  org_unit: "本组织",
  org_subtree: "本组织及下级",
  tenant: "当前公司",
  public_pool: "客户公池"
};

function assertProtectedRoleBaseline(roleCode: string, entries: Array<{ permissionCode: string; scopeMode: IamScopeMode }>) {
  const template = protectedRoleTemplate(roleCode);
  if (!template) return;
  const missing: Array<{ name: string; scope: string }> = [];
  for (const definition of IAM_PERMISSION_CATALOG) {
    const baseline = legacyPermissionScope(template, definition.code);
    if (!baseline) continue;
    if (!entries.some((entry) => entry.permissionCode === definition.code && scopeCovers(entry.scopeMode, baseline))) {
      missing.push({ name: definition.name, scope: iamScopeModeLabels[baseline] });
    }
  }
  if (missing.length) {
    const details = missing.slice(0, 4).map((item) => `“${item.name}”（最低范围：${item.scope}）`).join("、");
    const more = missing.length > 4 ? `等 ${missing.length} 项基础权限` : "";
    throw Object.assign(new Error(`无法发布“${protectedRoleTemplateLabels[template]}”：这是系统预设角色，${details}${more}不能取消或缩小。请恢复这些权限；如需更精简的角色，请复制该角色后修改副本。`), { status: 400 });
  }
}

function selectedTenant(actor: SessionUser, requested: string | undefined) {
  const platform = isPlatformIdentity(actor);
  const tenantId = platform ? String(requested || "").trim() : actor.teamId;
  if (!tenantId || (!platform && requested && requested !== actor.teamId)) {
    throw Object.assign(new Error("公司上下文不存在或不可访问"), { status: 404 });
  }
  return tenantId;
}

async function assertTenantOperator(pool: Queryable, actor: SessionUser, tenantId: string, permission: string) {
  if (isPlatformIdentity(actor)) {
    const found = one<{ id: string; status: string }>((await pool.query(
      `SELECT po.id, po.status FROM platform_operators po
       JOIN platform_operator_role_assignments pora ON pora.operator_id = po.id AND pora.status = 'active'
       JOIN platform_roles pr ON pr.id = pora.role_id AND pr.status = 'active'
       JOIN platform_role_permissions prp ON prp.role_id = pr.id AND prp.permission_code = ?
       WHERE po.user_id = ? AND po.status = 'active' LIMIT 1`, [permission, actor.id]
    ))[0]);
    if (!found) throw Object.assign(new Error("当前平台运维账号没有该平台权限"), { status: 403 });
    return;
  }
  const [snapshot, membershipResult] = await Promise.all([
    loadIamCapabilitySnapshot(pool as mysql.Pool, actor),
    pool.query(`SELECT id FROM tenant_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active' LIMIT 1`, [tenantId, actor.id])
  ]);
  if (!one(membershipResult[0])) throw Object.assign(new Error("当前账号不属于该公司"), { status: 403 });
  if (!snapshot.permissions[permission]?.length) throw Object.assign(new Error("当前账号没有执行该操作的权限"), { status: 403 });
}

async function bumpRevision(connection: mysql.PoolConnection, tenantId: string, membershipIds: string[]) {
  await connection.query(`UPDATE tenants SET authz_revision = authz_revision + 1, updated_at = NOW(3) WHERE id = ?`, [tenantId]);
  for (const membershipId of [...new Set(membershipIds.filter(Boolean))]) {
    await connection.query(`UPDATE tenant_memberships SET membership_auth_version = membership_auth_version + 1, updated_at = NOW(3) WHERE tenant_id = ? AND id = ?`, [tenantId, membershipId]);
    await connection.query(`INSERT INTO authorization_revisions (tenant_id, membership_id, revision, changed_at)
      VALUES (?, ?, 2, NOW(3)) ON DUPLICATE KEY UPDATE revision = revision + 1, changed_at = NOW(3)`, [tenantId, membershipId]);
  }
  await connection.query(`INSERT INTO authorization_revisions (tenant_id, membership_id, revision, changed_at)
    VALUES (?, '', 2, NOW(3)) ON DUPLICATE KEY UPDATE revision = revision + 1, changed_at = NOW(3)`, [tenantId]);
  const [revisionRows] = await connection.query(`SELECT authz_revision FROM tenants WHERE id = ?`, [tenantId]);
  return Number(one<{ authz_revision: number }>(revisionRows)?.authz_revision || 1);
}

async function audit(connection: mysql.PoolConnection, actor: SessionUser, tenantId: string, operation: string, targetType: string, targetId: string, before: unknown, after: unknown, context: AuditContext, revision: number) {
  const auditId = id("audit");
  await connection.query(`INSERT INTO authorization_audit_events
    (id, tenant_id, actor_identity_id, actor_membership_id, target_type, target_id, action_code,
     before_summary_json, after_summary_json, impact_summary, reason, ticket_no, request_id,
     session_id_hash, ip_hash, result_status, created_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', NOW(3))`, [
    auditId, tenantId, actor.id, targetType, targetId, operation, json(before), json(after),
    `${operation} 已生效，授权版本 ${revision}`, String(context.reason || ""), String(context.ticketNo || ""),
    String(context.requestId || ""), hash(actor.id), hash(context.ip || "")
  ]);
  return auditId;
}

async function queryOverview(pool: Queryable, tenantId: string) {
  const [tenantResult, memberResult, orgResult, roleResult, permissionResult, bindingResult, relationResult] = await Promise.all([
    pool.query(`SELECT id, name, status, plan_code, seat_limit, authz_revision FROM tenants WHERE id = ? LIMIT 1`, [tenantId]),
    pool.query(`SELECT tm.id, tm.user_id, tm.employee_no, tm.title, tm.status, tm.primary_org_unit_id, u.name, u.email, u.avatar, u.role AS legacy_role
      FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.tenant_id = ? ORDER BY tm.status, u.name`, [tenantId]),
    pool.query(`SELECT id, parent_id, name, code, unit_type AS type, status, path FROM organization_units WHERE tenant_id = ? ORDER BY path, sort_order, name`, [tenantId]),
    pool.query(`SELECT id, name, code, description, source, status, is_protected, version_no FROM roles WHERE tenant_id = ? ORDER BY is_protected DESC, name`, [tenantId]),
    pool.query(`SELECT code, module_name AS module, name, risk_level AS riskLevel, scope_modes_json FROM permissions WHERE status = 'active' ORDER BY module_name, code`),
    pool.query(`SELECT role_id, permission_code, scope_mode FROM role_permission_bindings WHERE tenant_id = ?`, [tenantId]),
    pool.query(`SELECT membership_id, org_unit_id, relation_type FROM organization_memberships
      WHERE tenant_id = ? AND (valid_from IS NULL OR valid_from <= NOW(3))
      AND (valid_until IS NULL OR valid_until > NOW(3))`, [tenantId])
  ]);
  const tenantRows = tenantResult[0];
  const memberRows = memberResult[0];
  const orgRows = orgResult[0];
  const roleRows = roleResult[0];
  const permissionRows = permissionResult[0];
  const bindingRows = bindingResult[0];
  const relationRows = rows<any>(relationResult[0]);
  const members: any[] = rows<any>(memberRows).map((member) => ({
    id: member.user_id, membershipId: member.id, name: member.name, email: member.email, avatar: member.avatar || "",
    status: member.status === "active" ? "active" : "disabled", roleId: "", roleCode: member.legacy_role || "sales",
    roleName: roleNames[member.legacy_role] || member.legacy_role || "未配置角色", employeeNo: member.employee_no || "", title: member.title || "",
    organizationUnitId: member.primary_org_unit_id || "", organizationUnitName: "未分配组织"
  }));
  const orgMap = new Map(rows<any>(orgRows).map((org) => [org.id, org]));
  for (const member of rows<any>(memberRows)) {
    const view = members.find((item) => item.membershipId === member.id);
    if (view) {
      const relations = relationRows.filter((item) => item.membership_id === member.id);
      view.organizationUnitName = orgMap.get(member.primary_org_unit_id)?.name || "未分配组织";
      view.organizationUnitIds = relations.map((item) => item.org_unit_id);
      view.secondaryOrganizationUnitIds = relations
        .filter((item) => item.relation_type === "secondary")
        .map((item) => item.org_unit_id);
      view.secondaryOrganizationUnitNames = view.secondaryOrganizationUnitIds
        .map((orgId: string) => orgMap.get(orgId)?.name)
        .filter(Boolean);
    }
  }
  const roles = rows<any>(roleRows);
  const bindings = rows<any>(bindingRows);
  const roleMembers = new Map<string, number>();
  const [assignmentResult] = await pool.query(`SELECT membership_id, role_id FROM member_role_assignments WHERE tenant_id = ? AND status = 'active'`, [tenantId]);
  const assignments = rows<any>(assignmentResult);
  const [grantResult] = await pool.query(`SELECT id, membership_id, permission_code, scope_mode, valid_until, reason FROM member_permission_grants WHERE tenant_id = ? AND status = 'active' AND valid_until > NOW(3) ORDER BY valid_until`, [tenantId]);
  const grants = rows<any>(grantResult);
  for (const assignment of assignments) roleMembers.set(assignment.role_id, (roleMembers.get(assignment.role_id) || 0) + 1);
  for (const member of members) {
    const memberAssignments = assignments.filter((item) => item.membership_id === member.membershipId);
    const assigned = memberAssignments[0];
    const role = roles.find((item) => item.id === assigned?.role_id);
    if (role) { member.roleId = role.id; member.roleCode = role.code; member.roleName = role.name; }
    member.roleIds = memberAssignments.map((item) => item.role_id);
    member.temporaryGrants = grants.filter((item) => item.membership_id === member.membershipId).map((item) => ({ id: item.id, permissionCode: item.permission_code, scopeMode: item.scope_mode, validUntil: new Date(item.valid_until).toISOString(), reason: item.reason || "" }));
  }
  const permissions = rows<any>(permissionRows).map((permission) => {
    const grants: Record<string, string> = {};
    for (const role of roles) {
      const roleBindings = bindings.filter((binding) => binding.role_id === role.id && binding.permission_code === permission.code);
      grants[role.id] = roleBindings.sort((a, b) => (scopeRank[b.scope_mode] || 0) - (scopeRank[a.scope_mode] || 0))[0]?.scope_mode || "none";
    }
    return { code: permission.code, module: permission.module, name: permission.name, riskLevel: permission.riskLevel, scopeModes: jsonArray(permission.scope_modes_json), grants };
  });
  const tenant = one<any>(tenantRows);
  return {
    foundation: { schemaVersion: IAM_FOUNDATION_SCHEMA_VERSION, mode: "iam", permissionCount: permissions.length },
    companies: tenant ? [{ id: tenant.id, name: tenant.name, memberCount: members.length }] : [],
    company: tenant ? { id: tenant.id, name: tenant.name, status: tenant.status, planCode: tenant.plan_code, seatLimit: Number(tenant.seat_limit), authorizationRevision: Number(tenant.authz_revision) } : null,
    metrics: tenant ? { memberCount: members.length, activeMemberCount: members.filter((m) => m.status === "active").length, roleCount: roles.length, organizationUnitCount: rows<any>(orgRows).length, unassignedMemberCount: members.filter((m) => !m.organizationUnitId).length } : null,
    organizationUnits: rows<any>(orgRows).map((org) => ({ id: org.id, parentId: org.parent_id || "", name: org.name, type: org.type, memberCount: new Set(relationRows.filter((item) => item.org_unit_id === org.id).map((item) => item.membership_id)).size, status: org.status, code: org.code })),
    roles: roles.map((role) => ({ ...role, memberCount: roleMembers.get(role.id) || 0, permissionCount: bindings.filter((b) => b.role_id === role.id).length, moduleCount: new Set(permissions.filter((p) => p.grants[role.id] !== "none").map((p) => p.module)).size })),
    permissions, members
  };
}

export function createIamManagementService(pool: mysql.Pool): IamManagementService {
  return {
    async listPlatformTenants(actor) {
      if (!isPlatformIdentity(actor)) throw Object.assign(new Error("该接口仅供平台运维操作员使用"), { status: 403 });
      await assertTenantOperator(pool, actor, "", "platform.tenant.metadata.read");
      const [tenantRows] = await pool.query(`SELECT t.id, t.code, t.name, t.status, t.plan_code, t.seat_limit, t.authz_revision,
        COUNT(tm.id) AS member_count FROM tenants t LEFT JOIN tenant_memberships tm ON tm.tenant_id = t.id
        GROUP BY t.id, t.code, t.name, t.status, t.plan_code, t.seat_limit, t.authz_revision ORDER BY t.created_at DESC`);
      return { tenants: rows<any>(tenantRows).map((row) => ({ id: row.id, code: row.code, name: row.name, status: row.status, planCode: row.plan_code, seatLimit: Number(row.seat_limit), authorizationRevision: Number(row.authz_revision), memberCount: Number(row.member_count) })) };
    },
    async getOverview(actor, requestedTenantId) {
      if (actor.role !== "admin" && actor.role !== "super_admin") {
        throw Object.assign(new Error("权限管理仅管理员和超级管理员可访问"), { status: 403 });
      }
      if (isPlatformIdentity(actor) && !requestedTenantId) {
        await assertTenantOperator(pool, actor, "", "platform.tenant.metadata.read");
        const [tenantRows] = await pool.query(`SELECT t.id, t.name, COUNT(tm.id) AS member_count FROM tenants t LEFT JOIN tenant_memberships tm ON tm.tenant_id = t.id GROUP BY t.id, t.name ORDER BY t.name`);
        return { foundation: { schemaVersion: IAM_FOUNDATION_SCHEMA_VERSION, mode: "iam", permissionCount: IAM_PERMISSION_CATALOG.length }, companies: rows<any>(tenantRows).map((row) => ({ id: row.id, name: row.name, memberCount: Number(row.member_count) })), company: null, metrics: null, organizationUnits: [], roles: [], permissions: [], members: [] };
      }
      const tenantId = selectedTenant(actor, requestedTenantId);
      await assertTenantOperator(pool, actor, tenantId, isPlatformIdentity(actor) ? "platform.tenant.metadata.read" : "member.read");
      return queryOverview(pool, tenantId);
    },
    async listAudit(actor, query) {
      if (actor.role !== "admin" && actor.role !== "super_admin") {
        throw Object.assign(new Error("权限审计仅管理员和超级管理员可访问"), { status: 403 });
      }
      const tenantId = selectedTenant(actor, query.tenantId);
      await assertTenantOperator(pool, actor, tenantId, isPlatformIdentity(actor) ? "platform.audit.read" : "audit.read");
      const limit = Math.max(1, Math.min(200, Number(query.limit || 50)));
      const [auditRows] = await pool.query(`SELECT id, actor_identity_id, target_type, target_id, action_code, impact_summary, reason, ticket_no, result_status, created_at FROM authorization_audit_events WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ${limit}`, [tenantId]);
      return { tenantId, events: rows<any>(auditRows).map((row) => ({ id: row.id, actorIdentityId: row.actor_identity_id, targetType: row.target_type, targetId: row.target_id, actionCode: row.action_code, impactSummary: row.impact_summary, reason: row.reason, ticketNo: row.ticket_no, resultStatus: row.result_status, createdAt: new Date(row.created_at).toISOString() })) };
    },
    async evaluatePreview(actor, input) {
      const tenantId = selectedTenant(actor, input.objectTenantId || actor.teamId);
      const snapshot = await loadIamCapabilitySnapshot(pool, actor);
      const scopes = snapshot.source !== "platform" && snapshot.tenantId === tenantId
        ? (snapshot.permissions[input.permissionCode] || [])
        : [];
      const allowed = scopes.length > 0 && (!input.scopeMode || scopes.includes(input.scopeMode));
      return { allowed, permissionCode: input.permissionCode, requestedScope: input.scopeMode || "", matchedScopes: scopes, tenantId, reason: allowed ? "命中当前授权快照" : "默认拒绝：未命中权限或数据范围" };
    },
    async mutate(actor, operation, payload, context = {}) {
      const tenantId = selectedTenant(actor, String(payload.tenantId || actor.teamId));
      const permission = operation === "role.permissions.replace" || operation === "member.roles.replace" || operation.startsWith("member.grants")
        ? "permission.assign"
        : operation.startsWith("organization") ? "org.manage"
          : operation.startsWith("role") ? "role.manage" : "member.manage";
      await assertTenantOperator(pool, actor, tenantId, permission);
      const connection = await pool.getConnection();
      let released = false;
      let revision = 1;
      let auditId = "";
      const affected: string[] = [];
      try {
        await connection.beginTransaction();
        let targetType = "tenant"; let targetId = tenantId; let before: unknown = null; let after: unknown = null;
        if (operation === "member.create") {
          const name = String(payload.name || "").trim(); const email = String(payload.email || "").trim().toLowerCase(); const password = String(payload.password || ""); const roleId = String(payload.roleId || "");
          if (!name || !email || password.length < 8 || !roleId) throw Object.assign(new Error("成员姓名、邮箱、密码和角色不能为空"), { status: 400 });
          const role = one<any>((await connection.query(`SELECT id, code, status FROM roles WHERE tenant_id = ? AND id = ? AND status = 'active'`, [tenantId, roleId]))[0]); if (!role) throw Object.assign(new Error("角色不存在或已停用"), { status: 400 });
          const [existing] = await connection.query(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email]); if (one(existing)) throw Object.assign(new Error("邮箱已被使用"), { status: 409 });
          const userId = id("user"); const membershipId = id("mem"); const root = one<any>((await connection.query(`SELECT id FROM organization_units WHERE tenant_id = ? AND unit_type = 'company' LIMIT 1`, [tenantId]))[0]);
          const legacyRole = ["sales", "manager", "admin"].includes(role.code) ? role.code : "sales";
          await connection.query(`INSERT INTO users (id, name, email, password_hash, role, team_id, avatar, status, auth_version) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1)`, [userId, name, email, await hashPassword(password), legacyRole, tenantId, name.slice(0, 2).toUpperCase()]);
          await connection.query(`INSERT INTO tenant_memberships (id, tenant_id, user_id, status, primary_org_unit_id, membership_auth_version, joined_at, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, 1, NOW(3), NOW(3), NOW(3))`, [membershipId, tenantId, userId, root?.id || null]);
          if (root?.id) await connection.query(`INSERT INTO organization_memberships (id, tenant_id, membership_id, org_unit_id, relation_type, created_by, created_at) VALUES (?, ?, ?, ?, 'primary', ?, NOW(3))`, [id("om"), tenantId, membershipId, root.id, actor.id]);
          await connection.query(`INSERT INTO member_role_assignments (id, tenant_id, membership_id, role_id, status, reason, granted_by, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?, NOW(3))`, [id("mra"), tenantId, membershipId, roleId, String(payload.reason || "新增成员"), actor.id]);
          affected.push(membershipId); targetType = "membership"; targetId = membershipId; after = { userId, membershipId, name, email, roleId };
        } else if (operation === "member.update") {
          const userId = String(payload.userId || "");
          const membership = one<any>((await connection.query(`SELECT tm.*, u.status AS user_status FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.tenant_id = ? AND tm.user_id = ? LIMIT 1`, [tenantId, userId]))[0]);
          if (!membership) throw Object.assign(new Error("成员不存在或不属于当前公司"), { status: 404 });
          before = { status: membership.status, primaryOrgUnitId: membership.primary_org_unit_id };
          const status = payload.status === undefined ? membership.status : (payload.status === "active" ? "active" : "suspended");
          const orgUnitId = payload.organizationUnitId === undefined ? membership.primary_org_unit_id : String(payload.organizationUnitId || "");
          if (orgUnitId) { const org = one<any>((await connection.query(`SELECT id FROM organization_units WHERE tenant_id = ? AND id = ? AND status = 'active'`, [tenantId, orgUnitId]))[0]); if (!org) throw Object.assign(new Error("组织节点不存在或已停用"), { status: 400 }); }
          await connection.query(`UPDATE tenant_memberships SET status = ?, primary_org_unit_id = NULLIF(?, ''), membership_auth_version = membership_auth_version + 1, updated_at = NOW(3) WHERE tenant_id = ? AND id = ?`, [status, orgUnitId, tenantId, membership.id]);
          if (payload.organizationUnitId !== undefined) {
            await connection.query(`UPDATE organization_memberships SET valid_until = NOW(3)
              WHERE tenant_id = ? AND membership_id = ? AND relation_type = 'primary'
              AND (valid_until IS NULL OR valid_until > NOW(3))`, [tenantId, membership.id]);
            if (orgUnitId) await connection.query(`INSERT INTO organization_memberships
              (id, tenant_id, membership_id, org_unit_id, relation_type, valid_from, valid_until, created_by, created_at)
              VALUES (?, ?, ?, ?, 'primary', NOW(3), NULL, ?, NOW(3))
              ON DUPLICATE KEY UPDATE valid_from = NOW(3), valid_until = NULL, created_by = VALUES(created_by)`,
            [id("om"), tenantId, membership.id, orgUnitId, actor.id]);
          }
          await connection.query(`UPDATE users SET status = ?, auth_version = auth_version + 1 WHERE id = ? AND team_id = ?`, [status === "active" ? "active" : "disabled", userId, tenantId]);
          affected.push(membership.id); targetType = "membership"; targetId = membership.id; after = { status, primaryOrgUnitId: orgUnitId };
        } else if (operation === "organization.create") {
          const name = String(payload.name || "").trim(); const code = String(payload.code || name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-"); const parentId = String(payload.parentId || "");
          if (!name || !code) throw Object.assign(new Error("组织名称和编码不能为空"), { status: 400 });
          let path = "/"; let depth = 0;
          if (parentId) { const parent = one<any>((await connection.query(`SELECT path, depth FROM organization_units WHERE tenant_id = ? AND id = ? AND status = 'active'`, [tenantId, parentId]))[0]); if (!parent) throw Object.assign(new Error("父组织不存在"), { status: 400 }); path = parent.path; depth = Number(parent.depth) + 1; }
          if (depth > 8) throw Object.assign(new Error("组织层级最多 8 层"), { status: 400 });
          targetId = id("org"); path = `${path}${targetId}/`;
          await connection.query(`INSERT INTO organization_units (id, tenant_id, parent_id, name, code, unit_type, path, depth, sort_order, status, version_no, created_at, updated_at) VALUES (?, ?, NULLIF(?, ''), ?, ?, 'department', ?, ?, 0, 'active', 1, NOW(3), NOW(3))`, [targetId, tenantId, parentId, name, code, path, depth]);
          after = { name, code, parentId };
        } else if (operation === "organization.update") {
          targetId = String(payload.organizationUnitId || "");
          const org = one<any>((await connection.query(`SELECT * FROM organization_units WHERE tenant_id = ? AND id = ?`, [tenantId, targetId]))[0]);
          if (!org) throw Object.assign(new Error("组织节点不存在"), { status: 404 });
          if (org.unit_type === "company" && payload.status === "disabled") throw Object.assign(new Error("公司根组织不能停用"), { status: 400 });
          if (payload.status === "disabled") {
            const occupied = one<{ count: number }>((await connection.query(`SELECT COUNT(*) AS count FROM tenant_memberships WHERE tenant_id = ? AND primary_org_unit_id = ? AND status IN ('active','invited')`, [tenantId, targetId]))[0]);
            const children = one<{ count: number }>((await connection.query(`SELECT COUNT(*) AS count FROM organization_units WHERE tenant_id = ? AND parent_id = ? AND status = 'active'`, [tenantId, targetId]))[0]);
            if (Number(occupied?.count || 0) || Number(children?.count || 0)) throw Object.assign(new Error("请先转移该组织的成员和下级组织，再停用该节点"), { status: 409 });
          }
          before = { name: org.name, status: org.status, parentId: org.parent_id || "" };
          const name = payload.name === undefined ? org.name : String(payload.name).trim(); const status = payload.status === "disabled" ? "disabled" : "active";
          let parentId = org.parent_id || "";
          let path = org.path; let depth = Number(org.depth);
          if (payload.parentId !== undefined && String(payload.parentId || "") !== parentId) {
            if (org.unit_type === "company") throw Object.assign(new Error("公司根组织不能移动"), { status: 400 });
            parentId = String(payload.parentId || "");
            const parent = one<any>((await connection.query(`SELECT id, path, depth FROM organization_units WHERE tenant_id = ? AND id = ? AND status = 'active'`, [tenantId, parentId]))[0]);
            if (!parent || parent.id === targetId || String(parent.path).startsWith(org.path)) throw Object.assign(new Error("上级组织无效，不能移动到自身或下级节点"), { status: 400 });
            const oldPath = org.path; const oldDepth = Number(org.depth); path = `${parent.path}${targetId}/`; depth = Number(parent.depth) + 1; const depthDelta = depth - oldDepth;
            const [descendantRows] = await connection.query(`SELECT MAX(depth) AS max_depth FROM organization_units WHERE tenant_id = ? AND path LIKE CONCAT(?, '%')`, [tenantId, oldPath]);
            if (Number(one<{ max_depth: number }>(descendantRows)?.max_depth || depth) + depthDelta > 8) throw Object.assign(new Error("移动后组织层级将超过 8 层"), { status: 400 });
            await connection.query(`UPDATE organization_units SET path = CONCAT(?, SUBSTRING(path, ?)), depth = depth + ? WHERE tenant_id = ? AND path LIKE CONCAT(?, '%') AND id <> ?`, [path, oldPath.length + 1, depthDelta, tenantId, oldPath, targetId]);
          }
          await connection.query(`UPDATE organization_units SET name = ?, parent_id = NULLIF(?, ''), path = ?, depth = ?, status = ?, version_no = version_no + 1, updated_at = NOW(3) WHERE tenant_id = ? AND id = ?`, [name, parentId, path, depth, status, tenantId, targetId]); after = { name, status, parentId };
        } else if (operation === "organization.assign") {
          const userId = String(payload.userId || ""); const orgUnitId = String(payload.organizationUnitId || "");
          const secondaryOrganizationUnitIds = [...new Set(Array.isArray(payload.secondaryOrganizationUnitIds)
            ? payload.secondaryOrganizationUnitIds.map(String).filter((item) => item && item !== orgUnitId)
            : [])].slice(0, 20);
          const membership = one<any>((await connection.query(`SELECT id FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId]))[0]);
          const org = one<any>((await connection.query(`SELECT id FROM organization_units WHERE tenant_id = ? AND id = ? AND status = 'active'`, [tenantId, orgUnitId]))[0]);
          if (!membership || !org) throw Object.assign(new Error("成员或组织节点不属于当前公司"), { status: 400 });
          if (secondaryOrganizationUnitIds.length) {
            const [secondaryRows] = await connection.query(`SELECT id FROM organization_units WHERE tenant_id = ? AND status = 'active' AND id IN (${secondaryOrganizationUnitIds.map(() => "?").join(",")})`, [tenantId, ...secondaryOrganizationUnitIds]);
            if (rows<any>(secondaryRows).length !== secondaryOrganizationUnitIds.length) throw Object.assign(new Error("次组织节点不存在、已停用或不属于当前公司"), { status: 400 });
          }
          await connection.query(`UPDATE tenant_memberships SET primary_org_unit_id = ?, membership_auth_version = membership_auth_version + 1, updated_at = NOW(3) WHERE tenant_id = ? AND id = ?`, [orgUnitId, tenantId, membership.id]);
          await connection.query(`UPDATE organization_memberships SET valid_until = NOW(3)
            WHERE tenant_id = ? AND membership_id = ? AND (valid_until IS NULL OR valid_until > NOW(3))`, [tenantId, membership.id]);
          await connection.query(`INSERT INTO organization_memberships
            (id, tenant_id, membership_id, org_unit_id, relation_type, valid_from, valid_until, created_by, created_at)
            VALUES (?, ?, ?, ?, 'primary', NOW(3), NULL, ?, NOW(3))
            ON DUPLICATE KEY UPDATE valid_from = NOW(3), valid_until = NULL, created_by = VALUES(created_by)`,
          [id("om"), tenantId, membership.id, orgUnitId, actor.id]);
          for (const secondaryOrgId of secondaryOrganizationUnitIds) await connection.query(`INSERT INTO organization_memberships
            (id, tenant_id, membership_id, org_unit_id, relation_type, valid_from, valid_until, created_by, created_at)
            VALUES (?, ?, ?, ?, 'secondary', NOW(3), NULL, ?, NOW(3))
            ON DUPLICATE KEY UPDATE valid_from = NOW(3), valid_until = NULL, created_by = VALUES(created_by)`,
          [id("om"), tenantId, membership.id, secondaryOrgId, actor.id]);
          affected.push(membership.id); targetType = "membership"; targetId = membership.id; after = { organizationUnitId: orgUnitId, secondaryOrganizationUnitIds };
        } else if (operation === "role.create" || operation === "role.clone") {
          const sourceId = operation === "role.clone" ? String(payload.sourceRoleId || "") : "";
          const source = sourceId ? one<any>((await connection.query(`SELECT * FROM roles WHERE tenant_id = ? AND id = ?`, [tenantId, sourceId]))[0]) : null;
          if (sourceId && !source) throw Object.assign(new Error("源角色不存在"), { status: 404 });
          if (source) {
            const [sourceBindingRows] = await connection.query(`SELECT permission_code, scope_mode FROM role_permission_bindings WHERE tenant_id = ? AND role_id = ?`, [tenantId, sourceId]);
            await assertDelegableBindings(connection, actor, rows<any>(sourceBindingRows).map((entry) => ({ permissionCode: entry.permission_code, scopeMode: entry.scope_mode })));
          }
          const name = String(payload.name || (source ? `${source.name} 副本` : "新角色")).trim(); const code = String(payload.code || `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`).slice(0, 80);
          targetId = id("role"); await connection.query(`INSERT INTO roles (id, tenant_id, name, code, description, source, status, is_protected, version_no, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'custom', 'active', FALSE, 1, ?, ?, NOW(3), NOW(3))`, [targetId, tenantId, name, code, String(payload.description || source?.description || ""), actor.id, actor.id]);
          if (source) await connection.query(`INSERT INTO role_permission_bindings (id, tenant_id, role_id, permission_code, scope_mode, scope_config_json, created_by, created_at) SELECT CONCAT('rpb_', LEFT(SHA2(CONCAT(?, permission_code, scope_mode), 256), 40)), tenant_id, ?, permission_code, scope_mode, scope_config_json, ?, NOW(3) FROM role_permission_bindings WHERE tenant_id = ? AND role_id = ?`, [targetId, targetId, actor.id, tenantId, sourceId]);
          after = { name, code, clonedFrom: sourceId };
        } else if (operation === "role.update" || operation === "role.disable") {
          targetId = String(payload.roleId || ""); const role = one<any>((await connection.query(`SELECT * FROM roles WHERE tenant_id = ? AND id = ?`, [tenantId, targetId]))[0]);
          if (!role) throw Object.assign(new Error("角色不存在"), { status: 404 }); if (role.is_protected && operation === "role.disable") throw Object.assign(new Error("系统保护角色不能停用"), { status: 400 });
          if (operation === "role.disable") {
            const assigned = one<{ count: number }>((await connection.query(`SELECT COUNT(*) AS count FROM member_role_assignments WHERE tenant_id = ? AND role_id = ? AND status = 'active'`, [tenantId, targetId]))[0]);
            if (Number(assigned?.count || 0)) throw Object.assign(new Error("该角色仍有成员，请先完成成员角色转移"), { status: 409 });
          }
          before = { name: role.name, status: role.status }; const name = payload.name === undefined ? role.name : String(payload.name).trim(); const status = operation === "role.disable" ? "disabled" : (payload.status === "draft" ? "draft" : "active");
          await connection.query(`UPDATE roles SET name = ?, description = ?, status = ?, version_no = version_no + 1, updated_by = ?, updated_at = NOW(3) WHERE tenant_id = ? AND id = ?`, [name, String(payload.description || role.description || ""), status, actor.id, tenantId, targetId]); after = { name, status };
        } else if (operation === "role.permissions.replace") {
          targetId = String(payload.roleId || ""); const role = one<any>((await connection.query(`SELECT id, code, is_protected FROM roles WHERE tenant_id = ? AND id = ?`, [tenantId, targetId]))[0]); if (!role) throw Object.assign(new Error("角色不存在"), { status: 404 });
          const entries = (Array.isArray(payload.bindings) ? payload.bindings as Array<Record<string, unknown>> : []).map((entry) => ({ permissionCode: String(entry.permissionCode || ""), scopeMode: String(entry.scopeMode || "") as IamScopeMode }));
          for (const entry of entries) { const permissionCode = String(entry.permissionCode || ""); const scopeMode = String(entry.scopeMode || ""); const definition = IAM_PERMISSION_CATALOG.find((item) => item.code === permissionCode); if (!definition || !definition.scopeModes.includes(scopeMode as IamScopeMode)) throw Object.assign(new Error(`权限范围无效：${permissionCode}`), { status: 400 }); }
          await assertDelegableBindings(connection, actor, entries);
          if (role.is_protected) assertProtectedRoleBaseline(role.code, entries);
          await connection.query(`DELETE FROM role_permission_bindings WHERE tenant_id = ? AND role_id = ?`, [tenantId, targetId]);
          for (const entry of entries) await connection.query(`INSERT INTO role_permission_bindings (id, tenant_id, role_id, permission_code, scope_mode, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW(3))`, [id("rpb"), tenantId, targetId, entry.permissionCode, entry.scopeMode, actor.id]);
          const [memberRows] = await connection.query(`SELECT membership_id FROM member_role_assignments WHERE tenant_id = ? AND role_id = ? AND status = 'active'`, [tenantId, targetId]); affected.push(...rows<{ membership_id: string }>(memberRows).map((item) => item.membership_id)); after = { bindingCount: entries.length };
        } else if (operation === "member.roles.replace") {
          const membershipId = String(payload.membershipId || ""); const member = one<any>((await connection.query(`SELECT id FROM tenant_memberships WHERE tenant_id = ? AND id = ?`, [tenantId, membershipId]))[0]); if (!member) throw Object.assign(new Error("成员不存在"), { status: 404 });
          const roleIds = Array.isArray(payload.roleIds) ? payload.roleIds.map(String).filter(Boolean) : [];
          if (!roleIds.length) throw Object.assign(new Error("至少保留一个角色"), { status: 400 });
          const [validRoles] = await connection.query(`SELECT id FROM roles WHERE tenant_id = ? AND id IN (${roleIds.map(() => "?").join(",")}) AND status = 'active'`, [tenantId, ...roleIds]); if (rows<any>(validRoles).length !== new Set(roleIds).size) throw Object.assign(new Error("存在不属于当前公司的角色"), { status: 400 });
          const [roleBindingRows] = await connection.query(`SELECT permission_code, scope_mode FROM role_permission_bindings WHERE tenant_id = ? AND role_id IN (${roleIds.map(() => "?").join(",")})`, [tenantId, ...roleIds]);
          await assertDelegableBindings(connection, actor, rows<any>(roleBindingRows).map((entry) => ({ permissionCode: entry.permission_code, scopeMode: entry.scope_mode })));
          before = rows<any>((await connection.query(`SELECT role_id FROM member_role_assignments WHERE tenant_id = ? AND membership_id = ? AND status = 'active'`, [tenantId, membershipId]))[0]);
          await connection.query(`UPDATE member_role_assignments SET status = 'revoked', revoked_by = ?, revoked_at = NOW(3) WHERE tenant_id = ? AND membership_id = ? AND status = 'active'`, [actor.id, tenantId, membershipId]);
          for (const roleId of roleIds) await connection.query(`INSERT INTO member_role_assignments (id, tenant_id, membership_id, role_id, status, reason, granted_by, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE status = 'active', reason = VALUES(reason), granted_by = VALUES(granted_by), revoked_by = NULL, revoked_at = NULL, created_at = NOW(3)`, [id("mra"), tenantId, membershipId, roleId, String(payload.reason || "权限配置"), actor.id]);
          affected.push(membershipId); targetType = "membership"; targetId = membershipId; after = { roleIds };
        } else if (operation === "member.grants.create") {
          const membershipId = String(payload.membershipId || ""); const permissionCode = String(payload.permissionCode || ""); const scopeMode = String(payload.scopeMode || ""); const validUntil = String(payload.validUntil || "");
          const validUntilTime = new Date(validUntil).getTime();
          if (!IAM_PERMISSION_CATALOG.find((p) => p.code === permissionCode)?.scopeModes.includes(scopeMode as IamScopeMode) || !Number.isFinite(validUntilTime) || validUntilTime <= Date.now() || validUntilTime - Date.now() > MAX_TEMPORARY_GRANT_MS) throw Object.assign(new Error("临时授权参数无效，截止时间必须在未来 90 天内"), { status: 400 });
          await assertDelegableBindings(connection, actor, [{ permissionCode, scopeMode: scopeMode as IamScopeMode }]);
          const member = one<any>((await connection.query(`SELECT id FROM tenant_memberships WHERE tenant_id = ? AND id = ?`, [tenantId, membershipId]))[0]); if (!member) throw Object.assign(new Error("成员不存在"), { status: 404 });
          targetType = "membership"; targetId = membershipId; await connection.query(`INSERT INTO member_permission_grants (id, tenant_id, membership_id, permission_code, scope_mode, valid_until, reason, ticket_no, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`, [id("grant"), tenantId, membershipId, permissionCode, scopeMode, mysqlDate(validUntil), String(payload.reason || ""), String(payload.ticketNo || ""), actor.id]); affected.push(membershipId); after = { permissionCode, scopeMode, validUntil };
        } else if (operation === "member.grants.revoke") {
          targetId = String(payload.grantId || ""); const grant = one<any>((await connection.query(`SELECT * FROM member_permission_grants WHERE tenant_id = ? AND id = ? AND status = 'active'`, [tenantId, targetId]))[0]); if (!grant) throw Object.assign(new Error("临时授权不存在"), { status: 404 });
          await connection.query(`UPDATE member_permission_grants SET status = 'revoked', revoked_by = ?, revoked_at = NOW(3) WHERE tenant_id = ? AND id = ?`, [actor.id, tenantId, targetId]); affected.push(grant.membership_id); after = { status: "revoked" }; targetType = "grant";
        } else throw Object.assign(new Error("不支持的权限管理操作"), { status: 400 });
        revision = await bumpRevision(connection, tenantId, affected);
        auditId = await audit(connection, actor, tenantId, operation, targetType, targetId, before, after, context, revision);
        await connection.commit();
        return { ok: true, data: after || {}, auditId, authorizationRevision: revision, requestId: context.requestId || "" };
      } catch (error) {
        await connection.rollback();
        const retryCount = Number(payload.__deadlockRetry || 0);
        if (typeof error === "object" && error && "code" in error && error.code === "ER_LOCK_DEADLOCK" && retryCount < 2) {
          connection.release();
          released = true;
          return this.mutate(actor, operation, { ...payload, __deadlockRetry: retryCount + 1 }, context);
        }
        throw error;
      } finally { if (!released) connection.release(); }
    }
  };
}
