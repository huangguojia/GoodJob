/**
 * 账号、成员、组织、角色、授权、审计、平台运维、审批流路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canManageAccount, canManageAccounts, canManageRole, canSeeOwner, hashPassword, publicUser, requireAuth } from "../auth.js";
import { AccessControlOverviewError, buildAccessControlOverview } from "../access-control-overview.js";
import { type CrmStore, getStore } from "../store.js";
import { activeProspectRunsForOwner } from "../prospect-run-guards.js";
import { accountUser, asyncRoute, requestCorrelationId } from "../server-core.js";

/** 临时账号的标准有效期：7 天（产品口径，批量生成与续期都以此为准） */
const TRIAL_ACCOUNT_DAYS = 7;

/** 把「天数 / ISO 时间 / 空值」统一折算成账号到期时间（ISO；空 = 永久） */
function resolveAccountExpiry(expiresInDays?: number, expiresAt?: string) {
  if (typeof expiresInDays === "number" && Number.isFinite(expiresInDays)) {
    return new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
  }
  const raw = (expiresAt || "").trim();
  if (!raw) return "";
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) throw Object.assign(new Error("有效期格式无效"), { status: 400 });
  return new Date(ts).toISOString();
}

function iamServiceOrFail(res: Response) {
  const service = getStore().iamManagement;
  if (!service) res.status(503).json({ message: "权限管理写入服务仅在 MySQL 持久化模式可用" });
  return service;
}

function iamMutationContext(req: Request) {
  return {
    requestId: requestCorrelationId(req),
    ip: req.ip || "",
    reason: String(req.body?.reason || "").slice(0, 500),
    ticketNo: String(req.body?.ticketNo || "").slice(0, 120)
  };
}

async function sendIamMutation(req: Request, res: Response, operation: Parameters<NonNullable<CrmStore["iamManagement"]>["mutate"]>[1], payload: Record<string, unknown>) {
  const service = iamServiceOrFail(res);
  if (!service) return;
  try {
    const result = await service.mutate(req.user!, operation, payload, iamMutationContext(req));
    if (operation === "member.create" || operation === "member.update" || operation === "member.delete") await getStore().reloadIamUsers?.();
    res.json(result);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
    res.status(Number.isFinite(status) ? status : 500).json({ message: error instanceof Error ? error.message : "权限管理操作失败" });
  }
}

function platformServiceOrFail(res: Response) {
  const service = getStore().platformOperations;
  if (!service) res.status(503).json({ message: "平台运维服务仅在 MySQL 持久化模式可用" });
  return service;
}

function platformMutationContext(req: Request) {
  return { requestId: requestCorrelationId(req), ip: req.ip || "" };
}

async function sendPlatformAction(res: Response, action: () => Promise<Record<string, unknown>>, fallback: string) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await action());
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
    res.status(Number.isFinite(status) ? status : 500).json({ message: error instanceof Error ? error.message : fallback });
  }
}

function approvalServiceOrFail(res: Response) {
  const service = getStore().approvalOperations;
  if (!service) res.status(503).json({ message: "审批服务尚未就绪" });
  return service;
}

const approvalNodeInputSchema = z.object({
  id: z.string().trim().max(90).optional(),
  type: z.enum(["start", "approval", "condition", "cc", "automation", "end"]).default("approval"),
  name: z.string().trim().min(1).max(120),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 0, y: 0 }),
  approverStrategy: z.enum(["specific_member", "role_in_tenant", "requester_manager", "permission_holder"]).default("requester_manager"),
  approverConfig: z.record(z.string(), z.unknown()).default({}),
  approvalMode: z.enum(["single", "all", "any"]).default("single"),
  config: z.record(z.string(), z.unknown()).default({}),
  sortOrder: z.number().int().nonnegative().optional()
}).strict();

const approvalEdgeInputSchema = z.object({
  id: z.string().trim().max(90).optional(), source: z.string().trim().min(1).max(90), target: z.string().trim().min(1).max(90),
  label: z.string().trim().max(80).default(""), priority: z.number().int().min(0).max(999).default(100),
  condition: z.object({
    field: z.string().trim().min(1).max(160),
    operator: z.enum(["equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "contains", "in", "exists"]),
    value: z.unknown().optional()
  }).strict().optional()
}).strict();

const approvalWorkflowInputSchema = z.object({
  code: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(160),
  businessType: z.enum(["quote", "discount", "customer_transfer", "export", "commission", "custom"]),
  allowParallel: z.boolean().default(false),
  triggerConfig: z.record(z.string(), z.unknown()).default({}),
  formSchema: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(1).max(999).default(100),
  isDefault: z.boolean().default(false),
  nodes: z.array(approvalNodeInputSchema).min(1).max(60),
  edges: z.array(approvalEdgeInputSchema).max(120).default([])
}).strict();

const approvalActionSchema = z.object({
  version: z.number().int().positive().optional(),
  comment: z.string().trim().max(1000).default(""),
  idempotencyKey: z.string().trim().min(8).max(160)
}).strict();

export function registerIamRoutes(app: Express) {
  app.get("/api/accounts", requireAuth, (req, res) => {
    if (!canManageAccounts(req.user)) {
      res.status(403).json({ message: "无账号管理权限" });
      return;
    }
    const { users } = getStore();
    const accounts = users.filter((user) => canSeeOwner(req.user!, user.id, user.teamId));
    res.json({ accounts: accounts.map(accountUser) });
  });

  app.get("/api/access-control/overview", requireAuth, asyncRoute(async (req, res) => {
    try {
      if (req.user?.role !== "admin" && req.user?.role !== "super_admin") {
        res.status(403).json({ message: "权限管理仅管理员和超级管理员可访问" });
        return;
      }
      const query = z.object({
        teamId: z.string().trim().min(1).max(64).optional(),
        page: z.enum(["members", "organization", "roles", "ui", "authorization", "audit"]).default("members")
      }).parse(req.query);
      const store = getStore();
      const requiredPermission: Record<typeof query.page, string> = {
        members: "member.read",
        organization: "org.read",
        roles: "role.read",
        ui: "role.read",
        authorization: "permission.assign",
        audit: "audit.read"
      };
      if (store.getIamCapabilitySnapshot) {
        const snapshot = await store.getIamCapabilitySnapshot(req.user!);
        const required = snapshot.source === "platform"
          ? query.page === "audit" ? "platform.audit.read" : "platform.tenant.metadata.read"
          : requiredPermission[query.page];
        const hasRequired = Boolean(snapshot.permissions[required]?.length);
        const hasPlatformTenantRead = snapshot.source !== "platform"
          || Boolean(snapshot.permissions["platform.tenant.metadata.read"]?.length);
        if (!hasRequired || !hasPlatformTenantRead) {
          res.status(403).json({ message: "当前账号没有该权限页面的查看权限" });
          return;
        }
      }
      if (store.iamManagement) {
        res.json(await store.iamManagement.getOverview(req.user!, query.teamId));
        return;
      }
      res.json(buildAccessControlOverview({
        actor: req.user!,
        users: store.users,
        companyProfiles: store.companyProfiles,
        requestedTeamId: query.teamId,
        canView: true
      }));
    } catch (error) {
      if (error instanceof AccessControlOverviewError) {
        res.status(error.status).json({ message: error.message });
        return;
      }
      throw error;
    }
  }));

  app.get("/api/v1/members", requireAuth, asyncRoute(async (req, res) => {
    const service = iamServiceOrFail(res); if (!service) return;
    const overview = await service.getOverview(req.user!, String(req.query.tenantId || "") || undefined);
    res.json({ data: overview.members || [], metrics: overview.metrics || null });
  }));

  app.post("/api/v1/members", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), name: z.string().trim().min(1).max(100), email: z.string().email().max(180), password: z.string().min(8).max(200), roleId: z.string().min(1).max(90), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "member.create", body);
  }));

  app.patch("/api/v1/members/:id", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), status: z.enum(["active", "suspended"]).optional(), organizationUnitId: z.string().max(90).optional(), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "member.update", { ...body, userId: req.params.id });
  }));

  // 删除成员：不可逆。confirmName 必须与成员姓名完全一致，用来挡住"点错了就删"。
  // 有业务引用的成员会保留一个不可登录的历史主体，保证文件/订单/审计不断链。
  app.delete("/api/v1/members/:id", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), confirmName: z.string().trim().min(1).max(100), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "member.delete", { ...body, userId: req.params.id });
  }));

  app.get("/api/v1/organization-units", requireAuth, asyncRoute(async (req, res) => {
    const service = iamServiceOrFail(res); if (!service) return;
    const overview = await service.getOverview(req.user!, String(req.query.tenantId || "") || undefined);
    res.json({ data: overview.organizationUnits || [] });
  }));

  app.post("/api/v1/organization-units", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), parentId: z.string().max(90).optional(), name: z.string().trim().min(1).max(160), code: z.string().trim().max(80).optional(), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "organization.create", body);
  }));

  app.patch("/api/v1/organization-units/:id", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), name: z.string().trim().min(1).max(160).optional(), parentId: z.string().max(90).optional(), status: z.enum(["active", "disabled"]).optional(), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "organization.update", { ...body, organizationUnitId: req.params.id });
  }));

  app.put("/api/v1/members/:id/organization-memberships", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      tenantId: z.string().max(64).optional(),
      organizationUnitId: z.string().min(1).max(90),
      secondaryOrganizationUnitIds: z.array(z.string().min(1).max(90)).max(20).optional().default([]),
      reason: z.string().max(500).optional()
    }).parse(req.body);
    await sendIamMutation(req, res, "organization.assign", { ...body, userId: req.params.id });
  }));

  app.get("/api/v1/roles", requireAuth, asyncRoute(async (req, res) => {
    const service = iamServiceOrFail(res); if (!service) return;
    const overview = await service.getOverview(req.user!, String(req.query.tenantId || "") || undefined);
    res.json({ data: overview.roles || [], permissions: overview.permissions || [] });
  }));

  app.post("/api/v1/roles", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), name: z.string().trim().min(1).max(120), code: z.string().trim().max(80).optional(), description: z.string().max(500).optional(), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "role.create", body);
  }));

  app.patch("/api/v1/roles/:id", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), name: z.string().trim().min(1).max(120).optional(), description: z.string().max(500).optional(), status: z.enum(["draft", "active"]).optional(), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "role.update", { ...body, roleId: req.params.id });
  }));

  app.post("/api/v1/roles/:id/clone", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), name: z.string().trim().max(120).optional(), code: z.string().trim().max(80).optional(), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "role.clone", { ...body, sourceRoleId: req.params.id });
  }));

  app.post("/api/v1/roles/:id/disable", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "role.disable", { ...body, roleId: req.params.id });
  }));

  app.put("/api/v1/roles/:id/permissions", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), bindings: z.array(z.object({ permissionCode: z.string().min(3).max(120), scopeMode: z.enum(["self", "org_unit", "org_subtree", "tenant", "public_pool"]) })).max(200), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "role.permissions.replace", { ...body, roleId: req.params.id });
  }));

  app.put("/api/v1/members/:id/role-assignments", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), roleIds: z.array(z.string().min(1).max(90)).min(1).max(20), reason: z.string().max(500).optional() }).parse(req.body);
    await sendIamMutation(req, res, "member.roles.replace", { ...body, membershipId: req.params.id });
  }));

  app.post("/api/v1/members/:id/temporary-grants", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), permissionCode: z.string().min(3).max(120), scopeMode: z.enum(["self", "org_unit", "org_subtree", "tenant", "public_pool"]), validUntil: z.string().datetime(), reason: z.string().trim().min(1).max(500), ticketNo: z.string().max(120).optional() }).parse(req.body);
    await sendIamMutation(req, res, "member.grants.create", { ...body, membershipId: req.params.id });
  }));

  app.delete("/api/v1/member-temporary-grants/:id", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ tenantId: z.string().max(64).optional(), reason: z.string().max(500).optional() }).parse(req.body || {});
    await sendIamMutation(req, res, "member.grants.revoke", { ...body, grantId: req.params.id });
  }));

  app.get("/api/v1/access-audit-events", requireAuth, asyncRoute(async (req, res) => {
    const service = iamServiceOrFail(res); if (!service) return;
    try { res.json(await service.listAudit(req.user!, { tenantId: String(req.query.tenantId || "") || undefined, limit: Number(req.query.limit || 50), targetType: String(req.query.targetType || "") })); }
    catch (error) { const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500; res.status(status).json({ message: error instanceof Error ? error.message : "审计日志读取失败" }); }
  }));

  app.post("/api/v1/access/evaluate-preview", requireAuth, asyncRoute(async (req, res) => {
    const service = iamServiceOrFail(res); if (!service) return;
    const body = z.object({ permissionCode: z.string().min(3).max(120), objectTenantId: z.string().max(64).optional(), ownerId: z.string().max(64).optional(), scopeMode: z.enum(["self", "org_unit", "org_subtree", "tenant", "public_pool"]).optional() }).parse(req.body);
    res.json({ data: await service.evaluatePreview(req.user!, body) });
  }));

  app.get("/api/platform/v1/overview", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    await sendPlatformAction(res, () => service.getOverview(req.user!), "平台概览读取失败");
  }));

  app.get("/api/platform/v1/tenants", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    await sendPlatformAction(res, () => service.listTenants(req.user!), "平台租户目录读取失败");
  }));

  app.post("/api/platform/v1/tenants", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    const body = z.object({
      name: z.string().trim().min(2).max(200),
      code: z.string().trim().min(2).max(64),
      planCode: z.string().trim().max(40).optional(),
      seatLimit: z.number().int().min(1).max(10000).optional(),
      reason: z.string().trim().min(2).max(500).optional()
    }).parse(req.body);
    await sendPlatformAction(res, () => service.createTenant(req.user!, body, platformMutationContext(req)), "公司创建失败");
  }));

  app.post("/api/platform/v1/tenants/:id/bootstrap-admin", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    const body = z.object({
      name: z.string().trim().min(1).max(100),
      email: z.string().trim().email().max(180),
      password: z.string().min(12).max(200),
      reason: z.string().trim().min(2).max(500).optional()
    }).parse(req.body);
    await sendPlatformAction(res, () => service.bootstrapTenantAdmin(req.user!, req.params.id, body, platformMutationContext(req)), "公司管理员初始化失败");
  }));

  app.post("/api/platform/v1/tenants/:id/:action", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    const action = z.enum(["suspend", "restore"]).parse(req.params.action);
    const body = z.object({ reason: z.string().trim().min(4).max(500) }).parse(req.body);
    await sendPlatformAction(res, () => service.changeTenantStatus(req.user!, req.params.id, action, body, platformMutationContext(req)), "公司状态变更失败");
  }));

  app.get("/api/platform/v1/operators", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    await sendPlatformAction(res, () => service.listOperators(req.user!), "平台人员读取失败");
  }));

  app.get("/api/platform/v1/support-requests", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    await sendPlatformAction(res, () => service.listSupportRequests(req.user!), "支持访问申请读取失败");
  }));

  app.post("/api/platform/v1/support-requests", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    const body = z.object({
      tenantId: z.string().trim().min(1).max(64),
      ticketNo: z.string().trim().min(3).max(120),
      reason: z.string().trim().min(6).max(500),
      permissionCodes: z.array(z.enum(["customer.read", "lead.read", "deal.read", "daily_report.read"])).min(1).max(4),
      requestedMinutes: z.number().int().min(1).max(60).default(15)
    }).parse(req.body);
    await sendPlatformAction(res, () => service.createSupportRequest(req.user!, body, platformMutationContext(req)), "支持访问申请创建失败");
  }));

  app.post("/api/platform/v1/support-requests/:id/start-session", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    await sendPlatformAction(res, () => service.startSupportSession(req.user!, req.params.id, platformMutationContext(req)), "支持会话启动失败");
  }));

  app.post("/api/platform/v1/support-requests/:id/:decision", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    const decision = z.enum(["approve", "reject"]).parse(req.params.decision);
    const body = z.object({ reviewNote: z.string().trim().min(3).max(500) }).parse(req.body);
    await sendPlatformAction(res, () => service.reviewSupportRequest(req.user!, req.params.id, decision, body, platformMutationContext(req)), "支持访问审批失败");
  }));

  app.post("/api/platform/v1/support-sessions/:id/terminate", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    const body = z.object({ reason: z.string().trim().min(2).max(500).optional() }).parse(req.body || {});
    await sendPlatformAction(res, () => service.terminateSupportSession(req.user!, req.params.id, body, platformMutationContext(req)), "支持会话终止失败");
  }));

  app.get("/api/platform/v1/support-sessions/:id/resources/:resource", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    const resource = z.enum(["customers", "leads", "deals", "daily-reports"]).parse(req.params.resource);
    await sendPlatformAction(res, () => service.readSupportResource(req.user!, req.params.id, resource, platformMutationContext(req)), "支持数据读取失败");
  }));

  app.get("/api/platform/v1/health", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    await sendPlatformAction(res, () => service.getHealth(req.user!), "服务健康读取失败");
  }));

  app.get("/api/platform/v1/audit", requireAuth, asyncRoute(async (req, res) => {
    const service = platformServiceOrFail(res); if (!service) return;
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
    await sendPlatformAction(res, () => service.listAudit(req.user!, limit), "平台审计读取失败");
  }));

  app.get("/api/iam/capabilities", requireAuth, asyncRoute(async (req, res) => {
    const loadSnapshot = getStore().getIamCapabilitySnapshot;
    if (!loadSnapshot) {
      res.status(503).json({ message: "权限能力服务尚未就绪" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ snapshot: await loadSnapshot(req.user!) });
  }));

  app.get("/api/v1/approval-workflows", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    res.json(await service.listWorkflows(req.user!));
  }));

  app.post("/api/v1/approval-workflows", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    res.status(201).json(await service.createWorkflow(req.user!, approvalWorkflowInputSchema.parse(req.body)));
  }));

  app.put("/api/v1/approval-workflows/:id", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    res.json(await service.updateWorkflow(req.user!, req.params.id, approvalWorkflowInputSchema.parse(req.body)));
  }));

  app.post("/api/v1/approval-workflows/resolve", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    const body = z.object({ businessType: z.string().trim().min(1).max(60), context: z.record(z.string(), z.unknown()).default({}) }).strict().parse(req.body);
    res.json(await service.resolveWorkflow(req.user!, body));
  }));

  app.get("/api/v1/approval-workflows/:id", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    res.json(await service.getWorkflow(req.user!, req.params.id));
  }));

  app.post("/api/v1/approval-workflows/:id/validate", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    res.json(await service.validateWorkflow(req.user!, req.params.id));
  }));

  app.post("/api/v1/approval-workflows/:id/publish", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    res.json(await service.publishWorkflow(req.user!, req.params.id));
  }));

  app.get("/api/v1/approval-instances", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    const status = z.enum(["draft", "running", "approved", "rejected", "withdrawn", "cancelled", "failed"]).optional().parse(req.query.status);
    res.json(await service.listInstances(req.user!, status));
  }));

  app.post("/api/v1/approval-instances", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    const body = z.object({
      workflowId: z.string().trim().max(90).default(""), businessType: z.string().trim().max(60).default(""), businessId: z.string().trim().max(120).default(""),
      title: z.string().trim().min(2).max(220), summary: z.string().trim().max(500).default(""),
      formData: z.record(z.string(), z.unknown()).default({}), businessSnapshot: z.record(z.string(), z.unknown()).default({}),
      comment: z.string().trim().max(1000).default(""), idempotencyKey: z.string().trim().min(8).max(160)
    }).strict().parse(req.body);
    res.status(201).json(await service.createInstance(req.user!, body, { requestId: String(req.headers["x-request-id"] || "") }));
  }));

  app.get("/api/v1/approval-instances/:id", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    res.json(await service.getInstance(req.user!, req.params.id));
  }));

  app.post("/api/v1/approval-instances/:id/withdraw", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    res.json(await service.withdrawInstance(req.user!, req.params.id, approvalActionSchema.omit({ version: true }).parse(req.body)));
  }));

  app.post("/api/v1/approval-instances/:id/remind", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    res.json(await service.remindInstance(req.user!, req.params.id, approvalActionSchema.omit({ version: true }).parse(req.body)));
  }));

  app.get("/api/v1/approval-tasks", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    const status = z.enum(["pending", "approved", "rejected", "transferred", "cancelled", "expired"]).optional().parse(req.query.status);
    res.json(await service.listTasks(req.user!, status));
  }));

  app.post("/api/v1/approval-tasks/:id/:decision", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    const decision = z.enum(["approve", "reject"]).parse(req.params.decision);
    res.json(await service.decideTask(req.user!, req.params.id, decision, approvalActionSchema.parse(req.body)));
  }));

  app.post("/api/v1/approval-tasks/:id/transfer", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    const body = approvalActionSchema.omit({ version: true }).extend({ membershipId: z.string().trim().min(1).max(90) }).parse(req.body);
    res.json(await service.transferTask(req.user!, req.params.id, body));
  }));

  app.post("/api/v1/approval-tasks/:id/add-approver", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    const body = approvalActionSchema.omit({ version: true }).extend({ membershipId: z.string().trim().min(1).max(90) }).parse(req.body);
    res.json(await service.addApprover(req.user!, req.params.id, body));
  }));

  app.post("/api/v1/approval-tasks/:id/comment", requireAuth, asyncRoute(async (req, res) => {
    const service = approvalServiceOrFail(res); if (!service) return;
    res.json(await service.commentTask(req.user!, req.params.id, approvalActionSchema.omit({ version: true }).parse(req.body)));
  }));

  app.post("/api/accounts", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageAccounts(req.user)) {
      res.status(403).json({ message: "无账号管理权限" });
      return;
    }
    const schema = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      password: z.string().min(8).max(128),
      role: z.enum(["sales", "manager", "admin", "super_admin"]).default("sales"),
      teamId: z.string().min(1).optional(),
      /** 账号有效期天数（1-3650）；不传 = 永久。也可直接传 expiresAt（ISO 时间）。 */
      expiresInDays: z.number().int().min(1).max(3650).optional(),
      expiresAt: z.string().min(10).max(40).optional()
    });
    const body = schema.parse(req.body);
    if (!canManageRole(req.user!, body.role)) {
      res.status(403).json({ message: "无权创建该角色账号" });
      return;
    }
    const store = getStore();
    if (store.users.some((user) => user.email === body.email)) {
      res.status(409).json({ message: "账号邮箱已存在" });
      return;
    }
    const teamId = req.user!.teamId;
    if (!teamId) {
      res.status(400).json({ message: "超级管理员创建账号时必须指定团队编号" });
      return;
    }
    if (body.role === "admin" && store.users.some((user) => user.role === "admin" && user.teamId === teamId)) {
      res.status(409).json({ message: "该团队已存在管理员，每个公测团队只允许一名管理员" });
      return;
    }
    const user = {
      id: `u_${Date.now()}`,
      name: body.name,
      email: body.email,
      password: await hashPassword(body.password),
      role: body.role,
      teamId,
      avatar: body.name.slice(0, 2).toUpperCase(),
      status: "active" as const,
      expiresAt: resolveAccountExpiry(body.expiresInDays, body.expiresAt)
    };
    store.users.unshift(user);
    await store.persist();
    res.json({ account: accountUser(user) });
  }));

  /** 批量生成带有效期的临时账号：明文密码只在本响应出现一次，库中只存哈希 */
  app.post("/api/accounts/generate", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageAccounts(req.user)) {
      res.status(403).json({ message: "只有管理员可以生成临时账号" });
      return;
    }
    const schema = z.object({
      count: z.number().int().min(1).max(200).default(1),
      expiresInDays: z.number().int().min(1).max(3650).default(TRIAL_ACCOUNT_DAYS),
      namePrefix: z.string().min(1).max(30).default("临时账号"),
      emailPrefix: z.string().min(1).max(30).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).default("trial"),
      emailDomain: z.string().min(3).max(100).regex(/^[A-Za-z0-9.-]+$/).default("goodjob.com"),
      teamId: z.string().min(1).max(64).optional()
    });
    const body = schema.parse(req.body ?? {});
    const teamId = (body.teamId || req.user!.teamId || "").trim();
    if (!teamId || teamId === "all") {
      res.status(400).json({ message: "请填写临时账号所属团队编号（不能是 all）" });
      return;
    }
    const store = getStore();
    const existingEmails = new Set(store.users.map((user) => user.email.toLowerCase()));
    const taken = new Set<string>();
    const passwordChars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const randomString = (length: number, chars: string) => {
      const bytes = randomBytes(length);
      let out = "";
      for (let i = 0; i < length; i += 1) out += chars[bytes[i] % chars.length];
      return out;
    };
    const expiresAt = resolveAccountExpiry(body.expiresInDays, "");
    const created: Array<{ id: string; name: string; email: string; password: string; expiresAt: string }> = [];
    for (let index = 0; index < body.count; index += 1) {
      let email = "";
      do {
        email = `${body.emailPrefix}.${randomString(6, "abcdefghjkmnpqrstuvwxyz23456789")}@${body.emailDomain}`.toLowerCase();
      } while (existingEmails.has(email) || taken.has(email));
      taken.add(email);
      const name = `${body.namePrefix}${String(index + 1).padStart(2, "0")}`;
      const password = randomString(12, passwordChars);
      const user = {
        id: `u_${Date.now()}_${index}`,
        name,
        email,
        password: await hashPassword(password),
        role: "sales" as const,
        teamId,
        avatar: name.slice(0, 2).toUpperCase(),
        status: "active" as const,
        expiresAt
      };
      store.users.unshift(user);
      created.push({ id: user.id, name, email, password, expiresAt });
    }
    await store.persist();
    res.json({ generated: created.length, expiresInDays: body.expiresInDays, teamId, expiresAt, accounts: created });
  }));

  app.patch("/api/accounts/:id/password", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageAccounts(req.user)) {
      res.status(403).json({ message: "无账号管理权限" });
      return;
    }
    const schema = z.object({ password: z.string().min(8).max(128) });
    const body = schema.parse(req.body);
    const store = getStore();
    const user = store.users.find((item) => item.id === req.params.id);
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    if (!canManageAccount(req.user!, publicUser(user))) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    user.password = await hashPassword(body.password);
    user.authVersion = (user.authVersion || 1) + 1;
    await store.persist();
    res.json({ account: accountUser(user) });
  }));

  /** 设置 / 续期 / 清除账号有效期：expiresAt 传 ISO 时间或天数 expiresInDays；传 null 或省略 = 恢复永久 */
  app.patch("/api/accounts/:id/expiry", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageAccounts(req.user)) {
      res.status(403).json({ message: "无账号管理权限" });
      return;
    }
    const schema = z.object({
      expiresAt: z.string().min(10).max(40).nullable().optional(),
      expiresInDays: z.number().int().min(1).max(3650).nullable().optional()
    });
    const body = schema.parse(req.body || {});
    const store = getStore();
    const user = store.users.find((item) => item.id === req.params.id);
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    if (!canManageAccount(req.user!, publicUser(user))) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    const clearing = body.expiresAt === null || body.expiresInDays === null
      || (body.expiresAt === undefined && body.expiresInDays === undefined);
    user.expiresAt = clearing
      ? ""
      : resolveAccountExpiry(
        body.expiresInDays === null ? undefined : body.expiresInDays,
        body.expiresAt === null ? undefined : body.expiresAt
      );
    await store.persist();
    res.json({ account: accountUser(user) });
  }));

  app.patch("/api/accounts/:id/disable", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageAccounts(req.user)) {
      res.status(403).json({ message: "无账号管理权限" });
      return;
    }
    const store = getStore();
    const user = store.users.find((item) => item.id === req.params.id);
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    if (user.id === req.user!.id) {
      res.status(400).json({ message: "不能停用当前登录账号" });
      return;
    }
    if (!canManageAccount(req.user!, publicUser(user))) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    user.status = "disabled";
    user.authVersion = (user.authVersion || 1) + 1;
    await store.persist();
    res.json({ account: accountUser(user) });
  }));

  app.delete("/api/accounts/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageAccounts(req.user)) {
      res.status(403).json({ message: "无账号管理权限" });
      return;
    }
    const store = getStore();
    const index = store.users.findIndex((item) => item.id === req.params.id);
    const user = index >= 0 ? store.users[index] : null;
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    if (user.id === req.user!.id) {
      res.status(400).json({ message: "不能删除当前登录账号" });
      return;
    }
    if (!canManageAccount(req.user!, publicUser(user))) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    if (store.prospectCampaigns.some((item) => item.ownerId === user.id)) {
      res.status(409).json({ message: "该账号仍负责获客项目，请先转交项目后再删除" });
      return;
    }
    if (activeProspectRunsForOwner(store, user.teamId, user.id).length) {
      res.status(409).json({
        message: "该账号仍有活动搜索运行，请先取消运行后再删除"
      });
      return;
    }
    store.users.splice(index, 1);
    await store.persist();
    res.json({ ok: true, id: req.params.id });
  }));
}
