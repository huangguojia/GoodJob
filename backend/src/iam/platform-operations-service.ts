import { createHash, randomUUID } from "node:crypto";
import type mysql from "mysql2/promise";
import type { SessionUser } from "../types.js";
import { hashPassword } from "../auth.js";
import { IAM_PERMISSION_CATALOG, legacyPermissionScope } from "./iam-foundation.js";

type AuditContext = { requestId?: string; ip?: string };
type Queryable = mysql.Pool | mysql.PoolConnection;

const SUPPORT_READ_PERMISSIONS = new Set([
  "customer.read",
  "lead.read",
  "deal.read",
  "daily_report.read"
]);

export interface PlatformOperationsService {
  getOverview(actor: SessionUser): Promise<Record<string, unknown>>;
  listTenants(actor: SessionUser): Promise<Record<string, unknown>>;
  createTenant(actor: SessionUser, input: Record<string, unknown>, context?: AuditContext): Promise<Record<string, unknown>>;
  bootstrapTenantAdmin(actor: SessionUser, tenantId: string, input: Record<string, unknown>, context?: AuditContext): Promise<Record<string, unknown>>;
  changeTenantStatus(actor: SessionUser, tenantId: string, action: "suspend" | "restore", input: Record<string, unknown>, context?: AuditContext): Promise<Record<string, unknown>>;
  listOperators(actor: SessionUser): Promise<Record<string, unknown>>;
  listSupportRequests(actor: SessionUser): Promise<Record<string, unknown>>;
  createSupportRequest(actor: SessionUser, input: Record<string, unknown>, context?: AuditContext): Promise<Record<string, unknown>>;
  reviewSupportRequest(actor: SessionUser, requestId: string, decision: "approve" | "reject", input: Record<string, unknown>, context?: AuditContext): Promise<Record<string, unknown>>;
  startSupportSession(actor: SessionUser, requestId: string, context?: AuditContext): Promise<Record<string, unknown>>;
  terminateSupportSession(actor: SessionUser, sessionId: string, input: Record<string, unknown>, context?: AuditContext): Promise<Record<string, unknown>>;
  readSupportResource(actor: SessionUser, sessionId: string, resource: "customers" | "leads" | "deals" | "daily-reports", context?: AuditContext): Promise<Record<string, unknown>>;
  getHealth(actor: SessionUser): Promise<Record<string, unknown>>;
  listAudit(actor: SessionUser, limit?: number): Promise<Record<string, unknown>>;
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 40)}`;
}

function rows<T>(value: unknown) {
  return value as T[];
}

function one<T>(value: unknown) {
  return rows<T>(value)[0];
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

async function requirePlatformPermission(queryable: Queryable, actor: SessionUser, permissionCode: string) {
  const [result] = await queryable.query(
    `SELECT po.id AS operator_id
     FROM platform_operators po
     JOIN platform_operator_role_assignments pora
       ON pora.operator_id = po.id AND pora.status = 'active'
     JOIN platform_roles pr ON pr.id = pora.role_id AND pr.status = 'active'
     JOIN platform_role_permissions prp
       ON prp.role_id = pr.id AND prp.permission_code = ?
     WHERE po.user_id = ? AND po.status = 'active'
     LIMIT 1`,
    [permissionCode, actor.id]
  );
  const operator = one<{ operator_id: string }>(result);
  if (!operator) fail(403, "当前账号没有该平台运维权限");
  return operator.operator_id;
}

async function writeAudit(
  connection: mysql.PoolConnection,
  operatorId: string,
  actionCode: string,
  targetType: string,
  targetId: string,
  tenantId: string | null,
  reason: string,
  summary: unknown,
  context: AuditContext = {}
) {
  const auditId = id("paudit");
  const ipHash = createHash("sha256").update(String(context.ip || "")).digest("hex");
  await connection.query(
    `INSERT INTO platform_audit_events
      (id, actor_operator_id, action_code, target_type, target_id, tenant_id,
       result_status, reason, request_id, ip_hash, summary_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'success', ?, ?, ?, ?, NOW(3))`,
    [auditId, operatorId, actionCode, targetType, targetId, tenantId, reason,
      String(context.requestId || ""), ipHash, JSON.stringify(summary ?? null)]
  );
  return auditId;
}

async function withTransaction<T>(pool: mysql.Pool, work: (connection: mysql.PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function seedTenantRoles(connection: mysql.PoolConnection, tenantId: string, operatorId: string) {
  const templates = [
    { legacy: "admin" as const, code: "company_admin", name: "公司管理员", description: "公司成员、组织、权限和业务管理模板" },
    { legacy: "manager" as const, code: "sales_manager", name: "销售经理", description: "公司经营和销售管理模板" },
    { legacy: "sales" as const, code: "sales_rep", name: "业务员", description: "本人业务跟进模板" }
  ];
  for (const template of templates) {
    const roleId = id("role");
    await connection.query(
      `INSERT INTO roles
        (id, tenant_id, name, code, description, source, status, is_protected,
         version_no, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'template', 'active', TRUE, 1, ?, ?, NOW(3), NOW(3))`,
      [roleId, tenantId, template.name, template.code, template.description, operatorId, operatorId]
    );
    for (const permission of IAM_PERMISSION_CATALOG) {
      const scope = legacyPermissionScope(template.legacy, permission.code);
      if (!scope) continue;
      await connection.query(
        `INSERT INTO role_permission_bindings
          (id, tenant_id, role_id, permission_code, scope_mode, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
        [id("rpb"), tenantId, roleId, permission.code, scope, operatorId]
      );
    }
  }
}

function supportPermissionForResource(resource: string) {
  return resource === "customers" ? "customer.read"
    : resource === "leads" ? "lead.read"
      : resource === "deals" ? "deal.read"
        : "daily_report.read";
}

export function createPlatformOperationsService(pool: mysql.Pool): PlatformOperationsService {
  return {
    async getOverview(actor) {
      await requirePlatformPermission(pool, actor, "platform.dashboard.read");
      const [[tenantResult], [memberResult], [supportResult], [auditResult]] = await Promise.all([
        pool.query(`SELECT status, COUNT(*) AS count FROM tenants GROUP BY status`),
        pool.query(`SELECT COUNT(*) AS count FROM tenant_memberships WHERE status = 'active'`),
        pool.query(`SELECT status, COUNT(*) AS count FROM support_access_requests GROUP BY status`),
        pool.query(`SELECT COUNT(*) AS count FROM platform_audit_events WHERE created_at >= CURRENT_DATE()`)
      ]);
      const tenants = Object.fromEntries(rows<any>(tenantResult).map((row) => [row.status, Number(row.count)]));
      const support = Object.fromEntries(rows<any>(supportResult).map((row) => [row.status, Number(row.count)]));
      return {
        generatedAt: new Date().toISOString(),
        metrics: {
          tenantCount: Object.values(tenants).reduce((sum: number, count) => sum + Number(count), 0),
          activeTenantCount: Number(tenants.active || 0) + Number(tenants.trial || 0),
          suspendedTenantCount: Number(tenants.suspended || 0),
          activeMemberCount: Number(one<any>(memberResult)?.count || 0),
          pendingSupportCount: Number(support.pending || 0),
          activeSupportCount: Number(support.approved || 0),
          todayAuditCount: Number(one<any>(auditResult)?.count || 0)
        }
      };
    },

    async listTenants(actor) {
      await requirePlatformPermission(pool, actor, "platform.tenant.metadata.read");
      const [result] = await pool.query(
        `SELECT t.id, t.code, t.name, t.status, t.plan_code, t.seat_limit,
          t.trial_expires_at, t.authz_revision, t.created_at,
          COUNT(tm.id) AS member_count,
          SUM(CASE WHEN tm.status = 'active' THEN 1 ELSE 0 END) AS active_member_count
         FROM tenants t
         LEFT JOIN tenant_memberships tm ON tm.tenant_id = t.id
         GROUP BY t.id, t.code, t.name, t.status, t.plan_code, t.seat_limit,
          t.trial_expires_at, t.authz_revision, t.created_at
         ORDER BY t.created_at DESC`
      );
      return { tenants: rows<any>(result).map((row) => ({
        id: row.id, code: row.code, name: row.name, status: row.status,
        planCode: row.plan_code, seatLimit: Number(row.seat_limit),
        memberCount: Number(row.member_count), activeMemberCount: Number(row.active_member_count),
        authorizationRevision: Number(row.authz_revision),
        trialExpiresAt: row.trial_expires_at ? new Date(row.trial_expires_at).toISOString() : "",
        createdAt: new Date(row.created_at).toISOString()
      })) };
    },

    async createTenant(actor, input, context) {
      const name = String(input.name || "").trim();
      const code = String(input.code || "").trim().toLowerCase();
      const reason = String(input.reason || "新公司开通").trim();
      const seatLimit = Math.max(1, Math.min(10000, Number(input.seatLimit || 50)));
      const planCode = String(input.planCode || "beta").trim().slice(0, 40);
      if (name.length < 2 || !/^[a-z0-9][a-z0-9_-]{1,62}$/u.test(code)) fail(400, "公司名称或公司编码格式无效");
      return withTransaction(pool, async (connection) => {
        const operatorId = await requirePlatformPermission(connection, actor, "platform.tenant.create");
        const tenantId = id("tenant").slice(0, 64);
        await connection.query(
          `INSERT INTO tenants
            (id, code, name, status, plan_code, seat_limit, authz_revision, created_at, updated_at)
           VALUES (?, ?, ?, 'trial', ?, ?, 1, NOW(3), NOW(3))`,
          [tenantId, code, name, planCode, seatLimit]
        );
        const rootId = id("org");
        await connection.query(
          `INSERT INTO organization_units
            (id, tenant_id, parent_id, name, code, unit_type, path, depth, status, created_at, updated_at)
           VALUES (?, ?, NULL, ?, 'company', 'company', ?, 0, 'active', NOW(3), NOW(3))`,
          [rootId, tenantId, name, `/${rootId}/`]
        );
        await seedTenantRoles(connection, tenantId, operatorId);
        await connection.query(
          `INSERT INTO tenant_lifecycle_events
            (id, tenant_id, event_type, previous_status, next_status, reason, actor_operator_id, created_at)
           VALUES (?, ?, 'created', '', 'trial', ?, ?, NOW(3))`,
          [id("tle"), tenantId, reason, operatorId]
        );
        const auditId = await writeAudit(connection, operatorId, "platform.tenant.create", "tenant", tenantId, tenantId, reason, { name, code, planCode, seatLimit }, context);
        return { ok: true, tenant: { id: tenantId, name, code, status: "trial", planCode, seatLimit }, auditId };
      });
    },

    async bootstrapTenantAdmin(actor, tenantId, input, context) {
      const name = String(input.name || "").trim();
      const email = String(input.email || "").trim().toLowerCase();
      const password = String(input.password || "");
      const reason = String(input.reason || "公司管理员初始化").trim();
      if (!name || !/^\S+@\S+\.\S+$/u.test(email) || password.length < 12) fail(400, "管理员姓名、邮箱或初始密码不符合要求");
      return withTransaction(pool, async (connection) => {
        const operatorId = await requirePlatformPermission(connection, actor, "platform.tenant.admin.bootstrap");
        const tenant = one<any>((await connection.query(`SELECT id, status FROM tenants WHERE id = ? FOR UPDATE`, [tenantId]))[0]);
        if (!tenant || !["trial", "active"].includes(tenant.status)) fail(404, "公司不存在或当前不可启用成员");
        const existingAdmin = one<any>((await connection.query(`SELECT tm.id FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.tenant_id = ? AND tm.status = 'active' AND u.role = 'admin' LIMIT 1`, [tenantId]))[0]);
        if (existingAdmin) fail(409, "该公司已经存在管理员");
        const duplicateEmail = one<any>((await connection.query(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email]))[0]);
        if (duplicateEmail) fail(409, "该邮箱已被使用");
        const root = one<any>((await connection.query(`SELECT id FROM organization_units WHERE tenant_id = ? AND unit_type = 'company' AND status = 'active' LIMIT 1`, [tenantId]))[0]);
        const role = one<any>((await connection.query(`SELECT id FROM roles WHERE tenant_id = ? AND code IN ('company_admin','legacy_admin') AND status = 'active' ORDER BY code = 'company_admin' DESC LIMIT 1`, [tenantId]))[0]);
        if (!root || !role) fail(409, "公司组织或管理员角色尚未初始化");
        const userId = id("user").slice(0, 64); const membershipId = id("mem");
        await connection.query(`INSERT INTO users (id, name, email, password_hash, role, team_id, avatar, status, auth_version) VALUES (?, ?, ?, ?, 'admin', ?, ?, 'active', 1)`, [userId, name, email, await hashPassword(password), tenantId, name.slice(0, 2).toUpperCase()]);
        await connection.query(`INSERT INTO tenant_memberships (id, tenant_id, user_id, status, primary_org_unit_id, membership_auth_version, joined_at, invited_by, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, 1, NOW(3), ?, NOW(3), NOW(3))`, [membershipId, tenantId, userId, root.id, operatorId]);
        await connection.query(`INSERT INTO organization_memberships (id, tenant_id, membership_id, org_unit_id, relation_type, valid_from, created_by, created_at) VALUES (?, ?, ?, ?, 'primary', NOW(3), ?, NOW(3))`, [id("om"), tenantId, membershipId, root.id, operatorId]);
        await connection.query(`INSERT INTO member_role_assignments (id, tenant_id, membership_id, role_id, scope_anchor_org_unit_id, status, reason, granted_by, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NOW(3))`, [id("mra"), tenantId, membershipId, role.id, root.id, reason, operatorId]);
        await connection.query(`UPDATE tenants SET authz_revision = authz_revision + 1, updated_at = NOW(3) WHERE id = ?`, [tenantId]);
        const auditId = await writeAudit(connection, operatorId, "platform.tenant.admin.bootstrap", "tenant_membership", membershipId, tenantId, reason, { userId, email }, context);
        return { ok: true, administrator: { id: userId, membershipId, name, email, tenantId }, auditId };
      });
    },

    async changeTenantStatus(actor, tenantId, action, input, context) {
      const reason = String(input.reason || "").trim();
      if (reason.length < 4) fail(400, "请填写本次状态变更原因");
      return withTransaction(pool, async (connection) => {
        const permission = action === "suspend" ? "platform.tenant.suspend" : "platform.tenant.restore";
        const operatorId = await requirePlatformPermission(connection, actor, permission);
        const tenant = one<any>((await connection.query(`SELECT id, status FROM tenants WHERE id = ? FOR UPDATE`, [tenantId]))[0]);
        if (!tenant) fail(404, "公司不存在");
        const nextStatus = action === "suspend" ? "suspended" : "active";
        if (tenant.status === "closed") fail(409, "已关闭公司不能通过该操作恢复");
        await connection.query(`UPDATE tenants SET status = ?, authz_revision = authz_revision + 1, updated_at = NOW(3) WHERE id = ?`, [nextStatus, tenantId]);
        await connection.query(
          `INSERT INTO tenant_lifecycle_events
            (id, tenant_id, event_type, previous_status, next_status, reason, actor_operator_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))`,
          [id("tle"), tenantId, action, tenant.status, nextStatus, reason, operatorId]
        );
        const auditId = await writeAudit(connection, operatorId, permission, "tenant", tenantId, tenantId, reason, { previousStatus: tenant.status, nextStatus }, context);
        return { ok: true, tenantId, status: nextStatus, auditId };
      });
    },

    async listOperators(actor) {
      await requirePlatformPermission(pool, actor, "platform.operator.read");
      const [result] = await pool.query(
        `SELECT po.id, po.status, po.mfa_required, po.updated_at, u.id AS user_id,
          u.name, u.email, GROUP_CONCAT(pr.name ORDER BY pr.name SEPARATOR '、') AS role_names
         FROM platform_operators po JOIN users u ON u.id = po.user_id
         LEFT JOIN platform_operator_role_assignments pora ON pora.operator_id = po.id AND pora.status = 'active'
         LEFT JOIN platform_roles pr ON pr.id = pora.role_id AND pr.status = 'active'
         GROUP BY po.id, po.status, po.mfa_required, po.updated_at, u.id, u.name, u.email
         ORDER BY u.name`
      );
      return { operators: rows<any>(result).map((row) => ({
        id: row.id, userId: row.user_id, name: row.name, email: row.email,
        status: row.status, mfaRequired: Boolean(row.mfa_required),
        roleNames: row.role_names || "未分配", updatedAt: new Date(row.updated_at).toISOString()
      })) };
    },

    async listSupportRequests(actor) {
      await requirePlatformPermission(pool, actor, "platform.support.request.create");
      await pool.query(`UPDATE support_access_requests SET status = 'expired', updated_at = NOW(3) WHERE status = 'pending' AND expires_at <= NOW(3)`);
      await pool.query(`UPDATE support_sessions SET status = 'expired' WHERE status = 'active' AND expires_at <= NOW(3)`);
      const [result] = await pool.query(
        `SELECT sar.*, t.name AS tenant_name, requester.user_id AS requester_user_id,
          reviewer.user_id AS reviewer_user_id, ss.id AS session_id, ss.status AS session_status,
          ss.started_at, ss.expires_at AS session_expires_at, ss.access_count
         FROM support_access_requests sar
         JOIN tenants t ON t.id = sar.tenant_id
         JOIN platform_operators requester ON requester.id = sar.requested_by
         LEFT JOIN platform_operators reviewer ON reviewer.id = sar.reviewed_by
         LEFT JOIN support_sessions ss ON ss.request_id = sar.id
         ORDER BY sar.created_at DESC LIMIT 200`
      );
      return { requests: rows<any>(result).map((row) => ({
        id: row.id, tenantId: row.tenant_id, tenantName: row.tenant_name,
        ticketNo: row.ticket_no, reason: row.reason,
        permissionCodes: jsonArray(row.permission_codes_json), requestedMinutes: Number(row.requested_minutes),
        status: row.status, requestedByUserId: row.requester_user_id,
        reviewedByUserId: row.reviewer_user_id || "", reviewNote: row.review_note || "",
        session: row.session_id ? { id: row.session_id, status: row.session_status, accessCount: Number(row.access_count), startedAt: new Date(row.started_at).toISOString(), expiresAt: new Date(row.session_expires_at).toISOString() } : null,
        createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString()
      })) };
    },

    async createSupportRequest(actor, input, context) {
      const tenantId = String(input.tenantId || "").trim();
      const ticketNo = String(input.ticketNo || "").trim();
      const reason = String(input.reason || "").trim();
      const requestedMinutes = Math.max(1, Math.min(60, Number(input.requestedMinutes || 15)));
      const permissionCodes = [...new Set((Array.isArray(input.permissionCodes) ? input.permissionCodes : []).map(String))];
      if (!tenantId || ticketNo.length < 3 || reason.length < 6 || !permissionCodes.length) fail(400, "公司、工单、原因和访问范围不能为空");
      if (permissionCodes.some((code) => !SUPPORT_READ_PERMISSIONS.has(code))) fail(400, "支持访问只允许申请已登记的只读权限");
      return withTransaction(pool, async (connection) => {
        const operatorId = await requirePlatformPermission(connection, actor, "platform.support.request.create");
        if (!one((await connection.query(`SELECT id FROM tenants WHERE id = ? AND status <> 'closed'`, [tenantId]))[0])) fail(404, "公司不存在或已关闭");
        const requestId = id("support");
        await connection.query(
          `INSERT INTO support_access_requests
            (id, tenant_id, ticket_no, reason, permission_codes_json, requested_minutes,
             status, requested_by, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, DATE_ADD(NOW(3), INTERVAL 24 HOUR), NOW(3), NOW(3))`,
          [requestId, tenantId, ticketNo, reason, JSON.stringify(permissionCodes), requestedMinutes, operatorId]
        );
        const auditId = await writeAudit(connection, operatorId, "platform.support.request.create", "support_request", requestId, tenantId, reason, { ticketNo, permissionCodes, requestedMinutes }, context);
        return { ok: true, requestId, status: "pending", auditId };
      });
    },

    async reviewSupportRequest(actor, requestId, decision, input, context) {
      const reviewNote = String(input.reviewNote || "").trim();
      if (reviewNote.length < 3) fail(400, "请填写审批意见");
      return withTransaction(pool, async (connection) => {
        const operatorId = await requirePlatformPermission(connection, actor, "platform.support.request.approve");
        const request = one<any>((await connection.query(`SELECT * FROM support_access_requests WHERE id = ? FOR UPDATE`, [requestId]))[0]);
        if (!request) fail(404, "支持访问申请不存在");
        if (request.status !== "pending" || new Date(request.expires_at).getTime() <= Date.now()) fail(409, "该申请已失效或已处理");
        if (request.requested_by === operatorId) fail(403, "申请人不能审批自己的支持访问申请");
        const status = decision === "approve" ? "approved" : "rejected";
        await connection.query(`UPDATE support_access_requests SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = NOW(3), updated_at = NOW(3) WHERE id = ?`, [status, operatorId, reviewNote, requestId]);
        const actionCode = `platform.support.request.${decision}`;
        const auditId = await writeAudit(connection, operatorId, actionCode, "support_request", requestId, request.tenant_id, reviewNote, { status }, context);
        return { ok: true, requestId, status, auditId };
      });
    },

    async startSupportSession(actor, requestId, context) {
      return withTransaction(pool, async (connection) => {
        const operatorId = await requirePlatformPermission(connection, actor, "platform.support.session.start");
        const request = one<any>((await connection.query(`SELECT * FROM support_access_requests WHERE id = ? FOR UPDATE`, [requestId]))[0]);
        if (!request) fail(404, "支持访问申请不存在");
        if (request.status !== "approved") fail(409, "支持访问申请尚未批准");
        if (request.requested_by !== operatorId) fail(403, "只有申请人可以启动该支持会话");
        const existing = one<any>((await connection.query(`SELECT id, status, expires_at FROM support_sessions WHERE request_id = ?`, [requestId]))[0]);
        if (existing) return { ok: true, sessionId: existing.id, status: existing.status, expiresAt: new Date(existing.expires_at).toISOString(), reused: true };
        const sessionId = id("ssn");
        await connection.query(
          `INSERT INTO support_sessions
            (id, request_id, tenant_id, operator_id, permission_codes_json, status, started_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'active', NOW(3), DATE_ADD(NOW(3), INTERVAL ? MINUTE))`,
          [sessionId, requestId, request.tenant_id, operatorId, JSON.stringify(jsonArray(request.permission_codes_json)), request.requested_minutes]
        );
        const auditId = await writeAudit(connection, operatorId, "platform.support.session.start", "support_session", sessionId, request.tenant_id, request.reason, { requestId, requestedMinutes: request.requested_minutes }, context);
        const session = one<any>((await connection.query(`SELECT expires_at FROM support_sessions WHERE id = ?`, [sessionId]))[0]);
        return { ok: true, sessionId, status: "active", expiresAt: new Date(session.expires_at).toISOString(), auditId };
      });
    },

    async terminateSupportSession(actor, sessionId, input, context) {
      const reason = String(input.reason || "主动结束支持访问").trim();
      return withTransaction(pool, async (connection) => {
        const operatorId = await requirePlatformPermission(connection, actor, "platform.support.session.terminate");
        const session = one<any>((await connection.query(`SELECT * FROM support_sessions WHERE id = ? FOR UPDATE`, [sessionId]))[0]);
        if (!session) fail(404, "支持会话不存在");
        if (session.status === "active") await connection.query(`UPDATE support_sessions SET status = 'terminated', terminated_at = NOW(3), terminated_by = ?, termination_reason = ? WHERE id = ?`, [operatorId, reason, sessionId]);
        const auditId = await writeAudit(connection, operatorId, "platform.support.session.terminate", "support_session", sessionId, session.tenant_id, reason, { previousStatus: session.status }, context);
        return { ok: true, sessionId, status: session.status === "active" ? "terminated" : session.status, auditId };
      });
    },

    async readSupportResource(actor, sessionId, resource, context) {
      const operatorId = await requirePlatformPermission(pool, actor, "platform.support.session.start");
      const session = one<any>((await pool.query(
        `SELECT * FROM support_sessions WHERE id = ? AND operator_id = ? AND status = 'active' AND expires_at > NOW(3)`,
        [sessionId, operatorId]
      ))[0]);
      if (!session) fail(403, "支持会话不存在、已结束或已过期");
      const permissionCode = supportPermissionForResource(resource);
      if (!jsonArray(session.permission_codes_json).includes(permissionCode)) fail(403, "该支持会话未申请此读取范围");
      let result: unknown;
      if (resource === "customers") {
        [result] = await pool.query(`SELECT id, company, country, stage, owner_id, created_at FROM customers WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`, [session.tenant_id]);
      } else if (resource === "leads") {
        [result] = await pool.query(`SELECT id, company, country, stage, status, owner_id, last_activity_at FROM leads WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 50`, [session.tenant_id]);
      } else if (resource === "deals") {
        [result] = await pool.query(`SELECT id, customer_id, title, stage, product, amount, currency, owner_id, updated_at FROM deals WHERE tenant_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50`, [session.tenant_id]);
      } else {
        [result] = await pool.query(`SELECT id, report_date, report_status, owner_id, submitted_at FROM daily_reports WHERE team_id = ? ORDER BY report_date DESC, submitted_at DESC LIMIT 50`, [session.tenant_id]);
      }
      await withTransaction(pool, async (connection) => {
        await connection.query(`UPDATE support_sessions SET access_count = access_count + 1, last_accessed_at = NOW(3) WHERE id = ?`, [sessionId]);
        await writeAudit(connection, operatorId, `platform.support.read.${resource}`, "support_session", sessionId, session.tenant_id, "限时支持会话读取", { permissionCode, rowCount: rows<any>(result).length }, context);
      });
      return { sessionId, tenantId: session.tenant_id, permissionCode, items: result, generatedAt: new Date().toISOString() };
    },

    async getHealth(actor) {
      await requirePlatformPermission(pool, actor, "platform.health.read");
      const started = Date.now();
      const [databaseResult] = await pool.query(`SELECT DATABASE() AS database_name, VERSION() AS version`);
      const [tableResult] = await pool.query(`SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()`);
      return {
        generatedAt: new Date().toISOString(),
        services: [
          { code: "api", name: "CRM API", status: "healthy", latencyMs: 0 },
          { code: "database", name: "MySQL", status: "healthy", latencyMs: Date.now() - started, version: one<any>(databaseResult)?.version || "", tableCount: Number(one<any>(tableResult)?.count || 0) }
        ]
      };
    },

    async listAudit(actor, limit = 100) {
      await requirePlatformPermission(pool, actor, "platform.audit.read");
      const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
      const [result] = await pool.query(
        `SELECT pae.id, pae.action_code, pae.target_type, pae.target_id, pae.tenant_id,
          pae.result_status, pae.reason, pae.request_id, pae.summary_json, pae.created_at,
          u.name AS actor_name
         FROM platform_audit_events pae
         JOIN platform_operators po ON po.id = pae.actor_operator_id
         JOIN users u ON u.id = po.user_id
         ORDER BY pae.created_at DESC, pae.id DESC LIMIT ${safeLimit}`
      );
      return { events: rows<any>(result).map((row) => ({
        id: row.id, actionCode: row.action_code, targetType: row.target_type,
        targetId: row.target_id, tenantId: row.tenant_id || "", resultStatus: row.result_status,
        reason: row.reason, requestId: row.request_id, summary: row.summary_json,
        actorName: row.actor_name, createdAt: new Date(row.created_at).toISOString()
      })) };
    }
  };
}
