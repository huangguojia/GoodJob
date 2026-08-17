import type mysql from "mysql2/promise";
import { ensurePlatformMfaTables } from "./platform-mfa.js";

export type IamScopeMode = "self" | "org_unit" | "org_subtree" | "tenant" | "public_pool";
export type IamRiskLevel = "normal" | "sensitive" | "high" | "critical";

export interface IamPermissionDefinition {
  code: string;
  module: string;
  name: string;
  riskLevel: IamRiskLevel;
  scopeModes: IamScopeMode[];
}

export const IAM_FOUNDATION_SCHEMA_VERSION = "iam-foundation-v1";

export const IAM_PERMISSION_CATALOG: IamPermissionDefinition[] = [
  { code: "workspace.dashboard.read", module: "工作台", name: "查看经营工作台", riskLevel: "normal", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "workspace.dashboard.manage", module: "工作台", name: "维护工作台业务内容", riskLevel: "normal", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "lead.read", module: "线索", name: "查看线索", riskLevel: "normal", scopeModes: ["self", "org_unit", "org_subtree", "tenant"] },
  { code: "lead.create", module: "线索", name: "创建线索", riskLevel: "normal", scopeModes: ["self", "org_unit", "tenant"] },
  { code: "lead.update", module: "线索", name: "维护线索", riskLevel: "normal", scopeModes: ["self", "org_unit", "org_subtree", "tenant"] },
  { code: "lead.delete", module: "线索", name: "删除线索", riskLevel: "high", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "lead.assign", module: "线索", name: "分配线索", riskLevel: "sensitive", scopeModes: ["org_unit", "org_subtree", "tenant"] },
  { code: "lead.export", module: "线索", name: "导出线索", riskLevel: "high", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "customer.read", module: "客户", name: "查看客户", riskLevel: "normal", scopeModes: ["self", "org_unit", "org_subtree", "tenant", "public_pool"] },
  { code: "customer.create", module: "客户", name: "创建客户", riskLevel: "normal", scopeModes: ["self", "org_unit", "tenant"] },
  { code: "customer.update", module: "客户", name: "维护客户", riskLevel: "normal", scopeModes: ["self", "org_unit", "org_subtree", "tenant"] },
  { code: "customer.delete", module: "客户", name: "删除客户", riskLevel: "high", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "customer.assign", module: "客户", name: "分配客户", riskLevel: "sensitive", scopeModes: ["org_unit", "org_subtree", "tenant"] },
  { code: "customer.export", module: "客户", name: "导出客户", riskLevel: "critical", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "customer.pool.claim", module: "客户", name: "领取公池客户", riskLevel: "normal", scopeModes: ["public_pool"] },
  { code: "customer.pool.release", module: "客户", name: "释放客户到公池", riskLevel: "sensitive", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "deal.read", module: "商机", name: "查看商机", riskLevel: "normal", scopeModes: ["self", "org_unit", "org_subtree", "tenant"] },
  { code: "deal.create", module: "商机", name: "创建商机", riskLevel: "normal", scopeModes: ["self", "org_unit", "tenant"] },
  { code: "deal.update", module: "商机", name: "维护商机", riskLevel: "normal", scopeModes: ["self", "org_unit", "org_subtree", "tenant"] },
  { code: "deal.delete", module: "商机", name: "删除商机", riskLevel: "high", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "deal.stage.advance", module: "商机", name: "推进商机阶段", riskLevel: "normal", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "deal.stage.override", module: "商机", name: "跨阶段推进商机", riskLevel: "sensitive", scopeModes: ["org_subtree", "tenant"] },
  { code: "deal.quote.create", module: "商机", name: "创建报价与 PI", riskLevel: "sensitive", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "report.read", module: "经营", name: "查看经营报表", riskLevel: "sensitive", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "report.export", module: "经营", name: "导出经营报表", riskLevel: "critical", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "daily_report.read", module: "协作", name: "查看日报", riskLevel: "normal", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "daily_report.create", module: "协作", name: "提交日报", riskLevel: "normal", scopeModes: ["self"] },
  { code: "daily_report.comment", module: "协作", name: "评论日报", riskLevel: "normal", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "reminder.read", module: "协作", name: "查看提醒规则", riskLevel: "normal", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "reminder.manage", module: "协作", name: "维护提醒规则", riskLevel: "sensitive", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "message.read", module: "协作", name: "查看站内消息", riskLevel: "normal", scopeModes: ["self"] },
  { code: "message.send", module: "协作", name: "发送站内消息", riskLevel: "normal", scopeModes: ["self", "org_unit", "org_subtree", "tenant"] },
  { code: "document.read", module: "单据", name: "查看外贸单据", riskLevel: "sensitive", scopeModes: ["self", "org_unit", "org_subtree", "tenant"] },
  { code: "document.manage", module: "单据", name: "维护外贸单据", riskLevel: "high", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "document.approve", module: "单据", name: "审核外贸单据", riskLevel: "critical", scopeModes: ["org_subtree", "tenant"] },
  { code: "commission.read", module: "提成", name: "查看提成对账", riskLevel: "sensitive", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "commission.manage", module: "提成", name: "维护提成对账", riskLevel: "critical", scopeModes: ["org_subtree", "tenant"] },
  { code: "prospect.read", module: "获客", name: "查看获客任务与候选", riskLevel: "normal", scopeModes: ["self", "org_unit", "org_subtree", "tenant"] },
  { code: "prospect.execute", module: "获客", name: "执行获客任务", riskLevel: "sensitive", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "communication.read", module: "通信", name: "查看客户通信", riskLevel: "sensitive", scopeModes: ["self", "org_unit", "org_subtree", "tenant"] },
  { code: "communication.send", module: "通信", name: "发送客户通信", riskLevel: "high", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "agent.use", module: "Agent", name: "使用业务 Agent", riskLevel: "sensitive", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "agent.manage", module: "Agent", name: "管理 Agent 与知识", riskLevel: "high", scopeModes: ["org_subtree", "tenant"] },
  { code: "integration.read", module: "集成", name: "查看外部工具连接", riskLevel: "sensitive", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "integration.connect", module: "集成", name: "创建与维护外部工具连接", riskLevel: "high", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "integration.execute", module: "集成", name: "调用已审核外部工具", riskLevel: "high", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "integration.approval.act", module: "集成", name: "审批外部工具操作", riskLevel: "critical", scopeModes: ["org_subtree", "tenant"] },
  { code: "integration.manage", module: "集成", name: "管理外部工具连接", riskLevel: "critical", scopeModes: ["tenant"] },
  { code: "training.read", module: "培训", name: "查看资料与训练", riskLevel: "normal", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "training.manage", module: "培训", name: "管理资料与训练", riskLevel: "sensitive", scopeModes: ["org_subtree", "tenant"] },
  { code: "product.read", module: "产品", name: "查看产品资料", riskLevel: "normal", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "product.manage", module: "产品", name: "维护产品资料", riskLevel: "sensitive", scopeModes: ["org_subtree", "tenant"] },
  { code: "shipment.read", module: "发货", name: "查看发货信息", riskLevel: "normal", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "shipment.manage", module: "发货", name: "维护发货信息", riskLevel: "sensitive", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "approval.read", module: "审批", name: "查看审批中心", riskLevel: "normal", scopeModes: ["self", "org_subtree", "tenant"] },
  { code: "approval.task.act", module: "审批", name: "处理审批任务", riskLevel: "sensitive", scopeModes: ["self"] },
  { code: "approval.workflow.manage", module: "审批", name: "管理审批流程", riskLevel: "critical", scopeModes: ["tenant"] },
  { code: "member.read", module: "组织", name: "查看公司成员", riskLevel: "sensitive", scopeModes: ["org_unit", "org_subtree", "tenant"] },
  { code: "member.manage", module: "组织", name: "管理公司成员", riskLevel: "critical", scopeModes: ["org_unit", "org_subtree", "tenant"] },
  { code: "org.read", module: "组织", name: "查看组织架构", riskLevel: "normal", scopeModes: ["org_unit", "org_subtree", "tenant"] },
  { code: "org.manage", module: "组织", name: "管理组织架构", riskLevel: "critical", scopeModes: ["tenant"] },
  { code: "role.read", module: "权限", name: "查看角色", riskLevel: "sensitive", scopeModes: ["tenant"] },
  { code: "role.manage", module: "权限", name: "管理角色", riskLevel: "critical", scopeModes: ["tenant"] },
  { code: "permission.assign", module: "权限", name: "授予成员权限", riskLevel: "critical", scopeModes: ["org_unit", "org_subtree", "tenant"] },
  { code: "audit.read", module: "权限", name: "查看权限审计", riskLevel: "high", scopeModes: ["tenant"] },
  { code: "system.settings.manage", module: "系统", name: "维护公司设置", riskLevel: "critical", scopeModes: ["tenant"] },
  { code: "database.maintain", module: "系统", name: "执行数据库维护", riskLevel: "critical", scopeModes: ["tenant"] }
];

export const PLATFORM_PERMISSION_CODES = [
  "platform.dashboard.read", "platform.tenant.metadata.read", "platform.tenant.create",
  "platform.tenant.admin.bootstrap",
  "platform.tenant.suspend", "platform.tenant.restore", "platform.tenant.plan.manage",
  "platform.operator.read", "platform.operator.manage", "platform.role.manage",
  "platform.support.request.create", "platform.support.request.approve",
  "platform.support.session.start", "platform.support.session.terminate",
  "platform.health.read", "platform.job.read", "platform.job.execute",
  "platform.release.manage", "platform.integration.connector.review",
  "platform.audit.read", "platform.audit.export"
] as const;

const salesPermissions = new Set([
  "workspace.dashboard.read", "workspace.dashboard.manage", "lead.read", "lead.create", "lead.update", "lead.delete",
  "customer.read", "customer.create", "customer.update", "customer.delete", "customer.pool.claim",
  "customer.pool.release", "customer.export", "deal.read", "deal.create", "deal.update", "deal.delete",
  "deal.stage.advance", "deal.quote.create", "report.read", "daily_report.read",
  "daily_report.create", "daily_report.comment", "message.read", "message.send",
  "reminder.read", "reminder.manage",
  "document.read", "document.manage", "commission.read", "prospect.read", "prospect.execute",
  "communication.read", "communication.send", "agent.use", "integration.read", "integration.connect",
  "integration.execute", "training.read",
  "product.read", "shipment.read", "shipment.manage", "approval.read"
]);

const managerExtraPermissions = new Set([
  "lead.assign", "lead.export", "customer.assign", "report.export",
  "deal.stage.override",
  "commission.manage", "document.approve", "agent.manage", "integration.manage", "integration.approval.act", "training.manage",
  "product.manage", "approval.task.act", "approval.workflow.manage"
]);

export function legacyPermissionScope(
  role: "sales" | "manager" | "admin",
  permissionCode: string
): IamScopeMode | null {
  if (role === "admin") {
    const definition = IAM_PERMISSION_CATALOG.find((permission) => permission.code === permissionCode);
    if (!definition) return null;
    if (definition.scopeModes.includes("tenant")) return "tenant";
    if (definition.scopeModes.includes("public_pool")) return "public_pool";
    return definition.scopeModes[0] || null;
  }
  if (!salesPermissions.has(permissionCode) && !managerExtraPermissions.has(permissionCode)) return null;
  if (role === "sales" && managerExtraPermissions.has(permissionCode)) return null;
  if (permissionCode === "customer.pool.claim") return "public_pool";
  if (permissionCode === "daily_report.create") return "self";
  if (permissionCode === "message.send") return "tenant";
  if (role === "manager" && permissionCode === "integration.connect") return "tenant";
  if (role === "manager" && permissionCode === "reminder.manage") return "self";
  const definition = IAM_PERMISSION_CATALOG.find((permission) => permission.code === permissionCode);
  if (!definition) return null;
  if (role === "sales") return definition.scopeModes.includes("self") ? "self" : definition.scopeModes[0] || null;
  if (definition.scopeModes.includes("org_subtree")) return "org_subtree";
  if (definition.scopeModes.includes("tenant")) return "tenant";
  if (definition.scopeModes.includes("org_unit")) return "org_unit";
  return definition.scopeModes[0] || null;
}

async function createTables(pool: mysql.Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS tenants (
    id VARCHAR(64) PRIMARY KEY,
    code VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    plan_code VARCHAR(40) NOT NULL DEFAULT 'beta',
    seat_limit INT NOT NULL DEFAULT 50,
    trial_expires_at DATETIME(3) NULL,
    data_region VARCHAR(40) NOT NULL DEFAULT '',
    timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Shanghai',
    locale VARCHAR(20) NOT NULL DEFAULT 'zh-CN',
    authz_revision BIGINT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT chk_tenants_status CHECK (status IN ('trial','active','suspended','closed'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tenant_memberships (
    id VARCHAR(90) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    employee_no VARCHAR(80) NOT NULL DEFAULT '',
    title VARCHAR(120) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    primary_org_unit_id VARCHAR(90) NULL,
    membership_auth_version BIGINT NOT NULL DEFAULT 1,
    joined_at DATETIME(3) NULL,
    left_at DATETIME(3) NULL,
    invited_by VARCHAR(90) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_tenant_membership_user(tenant_id, user_id),
    UNIQUE KEY uk_tenant_membership_scope(tenant_id, id),
    INDEX idx_tenant_membership_status(tenant_id, status),
    CONSTRAINT fk_tenant_membership_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_tenant_membership_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT chk_tenant_membership_status CHECK (status IN ('invited','active','suspended','left'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS organization_units (
    id VARCHAR(90) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    parent_id VARCHAR(90) NULL,
    name VARCHAR(160) NOT NULL,
    code VARCHAR(80) NOT NULL,
    unit_type VARCHAR(20) NOT NULL,
    path VARCHAR(900) NOT NULL,
    depth INT NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    version_no BIGINT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_organization_unit_code(tenant_id, code),
    UNIQUE KEY uk_organization_unit_scope(tenant_id, id),
    INDEX idx_organization_unit_path(tenant_id, path(255)),
    CONSTRAINT fk_organization_unit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT chk_organization_unit_depth CHECK (depth BETWEEN 0 AND 8),
    CONSTRAINT chk_organization_unit_status CHECK (status IN ('active','disabled'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS organization_memberships (
    id VARCHAR(90) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    membership_id VARCHAR(90) NOT NULL,
    org_unit_id VARCHAR(90) NOT NULL,
    relation_type VARCHAR(20) NOT NULL,
    is_leader BOOLEAN NOT NULL DEFAULT FALSE,
    valid_from DATETIME(3) NULL,
    valid_until DATETIME(3) NULL,
    created_by VARCHAR(90) NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_org_membership_relation(tenant_id, membership_id, org_unit_id, relation_type),
    INDEX idx_org_membership_unit(tenant_id, org_unit_id),
    CONSTRAINT fk_org_membership_member FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id),
    CONSTRAINT fk_org_membership_unit FOREIGN KEY (tenant_id, org_unit_id) REFERENCES organization_units(tenant_id, id),
    CONSTRAINT chk_org_membership_relation CHECK (relation_type IN ('primary','secondary'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS permissions (
    code VARCHAR(120) PRIMARY KEY,
    domain_name VARCHAR(20) NOT NULL DEFAULT 'tenant',
    module_name VARCHAR(80) NOT NULL,
    resource_name VARCHAR(80) NOT NULL,
    action_name VARCHAR(80) NOT NULL,
    name VARCHAR(160) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    risk_level VARCHAR(20) NOT NULL,
    scope_modes_json JSON NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    introduced_version VARCHAR(40) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT chk_permissions_risk CHECK (risk_level IN ('normal','sensitive','high','critical'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS roles (
    id VARCHAR(90) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    name VARCHAR(120) NOT NULL,
    code VARCHAR(80) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    source VARCHAR(20) NOT NULL DEFAULT 'custom',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    is_protected BOOLEAN NOT NULL DEFAULT FALSE,
    version_no BIGINT NOT NULL DEFAULT 1,
    created_by VARCHAR(90) NULL,
    updated_by VARCHAR(90) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_roles_code(tenant_id, code),
    UNIQUE KEY uk_roles_scope(tenant_id, id),
    CONSTRAINT fk_roles_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT chk_roles_status CHECK (status IN ('draft','active','disabled'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS role_permission_bindings (
    id VARCHAR(90) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    role_id VARCHAR(90) NOT NULL,
    permission_code VARCHAR(120) NOT NULL,
    scope_mode VARCHAR(20) NOT NULL,
    scope_config_json JSON NULL,
    field_policy_id VARCHAR(90) NULL,
    condition_policy_id VARCHAR(90) NULL,
    created_by VARCHAR(90) NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_role_permission_binding(tenant_id, role_id, permission_code, scope_mode),
    INDEX idx_role_permission_permission(permission_code),
    CONSTRAINT fk_role_permission_role FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id),
    CONSTRAINT fk_role_permission_code FOREIGN KEY (permission_code) REFERENCES permissions(code),
    CONSTRAINT chk_role_permission_scope CHECK (scope_mode IN ('self','org_unit','org_subtree','tenant','public_pool','assigned_set'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS member_role_assignments (
    id VARCHAR(90) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    membership_id VARCHAR(90) NOT NULL,
    role_id VARCHAR(90) NOT NULL,
    scope_anchor_org_unit_id VARCHAR(90) NULL,
    valid_from DATETIME(3) NULL,
    valid_until DATETIME(3) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    reason VARCHAR(500) NOT NULL DEFAULT '',
    granted_by VARCHAR(90) NULL,
    revoked_by VARCHAR(90) NULL,
    revoked_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_member_role_active(tenant_id, membership_id, role_id),
    INDEX idx_member_role_status(tenant_id, membership_id, status),
    CONSTRAINT fk_member_role_member FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id),
    CONSTRAINT fk_member_role_role FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id),
    CONSTRAINT chk_member_role_status CHECK (status IN ('active','revoked','expired'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS member_permission_grants (
    id VARCHAR(90) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    membership_id VARCHAR(90) NOT NULL,
    permission_code VARCHAR(120) NOT NULL,
    scope_mode VARCHAR(20) NOT NULL,
    scope_config_json JSON NULL,
    valid_until DATETIME(3) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    ticket_no VARCHAR(120) NOT NULL DEFAULT '',
    granted_by VARCHAR(90) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    revoked_by VARCHAR(90) NULL,
    revoked_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    INDEX idx_member_permission_active(tenant_id, membership_id, status, valid_until),
    CONSTRAINT fk_member_permission_member FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id),
    CONSTRAINT fk_member_permission_code FOREIGN KEY (permission_code) REFERENCES permissions(code),
    CONSTRAINT chk_member_permission_status CHECK (status IN ('active','revoked','expired'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS authorization_revisions (
    tenant_id VARCHAR(64) NOT NULL,
    membership_id VARCHAR(90) NOT NULL DEFAULT '',
    revision BIGINT NOT NULL DEFAULT 1,
    changed_at DATETIME(3) NOT NULL,
    PRIMARY KEY (tenant_id, membership_id),
    CONSTRAINT fk_authorization_revision_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS authorization_audit_events (
    id VARCHAR(90) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    actor_identity_id VARCHAR(64) NOT NULL,
    actor_membership_id VARCHAR(90) NULL,
    target_type VARCHAR(40) NOT NULL,
    target_id VARCHAR(120) NOT NULL,
    action_code VARCHAR(120) NOT NULL,
    before_summary_json JSON NULL,
    after_summary_json JSON NULL,
    impact_summary VARCHAR(500) NOT NULL DEFAULT '',
    reason VARCHAR(500) NOT NULL DEFAULT '',
    ticket_no VARCHAR(120) NOT NULL DEFAULT '',
    request_id VARCHAR(90) NOT NULL DEFAULT '',
    session_id_hash CHAR(64) NOT NULL DEFAULT '',
    ip_hash CHAR(64) NOT NULL DEFAULT '',
    result_status VARCHAR(20) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    INDEX idx_authorization_audit_tenant(tenant_id, created_at, id),
    INDEX idx_authorization_audit_target(tenant_id, target_type, target_id),
    CONSTRAINT fk_authorization_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT chk_authorization_audit_status CHECK (result_status IN ('success','rejected','failed','rolled_back'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS platform_operators (
    id VARCHAR(90) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    mfa_required BOOLEAN NOT NULL DEFAULT TRUE,
    auth_version BIGINT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT fk_platform_operator_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT chk_platform_operator_status CHECK (status IN ('active','suspended','disabled'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS platform_roles (
    id VARCHAR(90) PRIMARY KEY,
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    is_protected BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS platform_role_permissions (
    role_id VARCHAR(90) NOT NULL,
    permission_code VARCHAR(120) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (role_id, permission_code),
    CONSTRAINT fk_platform_role_permission_role FOREIGN KEY (role_id) REFERENCES platform_roles(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS platform_operator_role_assignments (
    operator_id VARCHAR(90) NOT NULL,
    role_id VARCHAR(90) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    granted_at DATETIME(3) NOT NULL,
    PRIMARY KEY (operator_id, role_id),
    CONSTRAINT fk_platform_operator_role_operator FOREIGN KEY (operator_id) REFERENCES platform_operators(id),
    CONSTRAINT fk_platform_operator_role_role FOREIGN KEY (role_id) REFERENCES platform_roles(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS platform_audit_events (
    id VARCHAR(90) PRIMARY KEY,
    actor_operator_id VARCHAR(90) NOT NULL,
    action_code VARCHAR(120) NOT NULL,
    target_type VARCHAR(60) NOT NULL,
    target_id VARCHAR(120) NOT NULL,
    tenant_id VARCHAR(64) NULL,
    result_status VARCHAR(20) NOT NULL,
    reason VARCHAR(500) NOT NULL DEFAULT '',
    request_id VARCHAR(90) NOT NULL DEFAULT '',
    ip_hash CHAR(64) NOT NULL DEFAULT '',
    summary_json JSON NULL,
    created_at DATETIME(3) NOT NULL,
    INDEX idx_platform_audit_created(created_at, id),
    INDEX idx_platform_audit_tenant(tenant_id, created_at),
    CONSTRAINT fk_platform_audit_operator FOREIGN KEY (actor_operator_id) REFERENCES platform_operators(id),
    CONSTRAINT fk_platform_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT chk_platform_audit_status CHECK (result_status IN ('success','rejected','failed'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tenant_lifecycle_events (
    id VARCHAR(90) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    previous_status VARCHAR(20) NOT NULL DEFAULT '',
    next_status VARCHAR(20) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    actor_operator_id VARCHAR(90) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    INDEX idx_tenant_lifecycle(tenant_id, created_at),
    CONSTRAINT fk_tenant_lifecycle_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_tenant_lifecycle_operator FOREIGN KEY (actor_operator_id) REFERENCES platform_operators(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS support_access_requests (
    id VARCHAR(90) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    ticket_no VARCHAR(120) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    permission_codes_json JSON NOT NULL,
    requested_minutes INT NOT NULL DEFAULT 15,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    requested_by VARCHAR(90) NOT NULL,
    reviewed_by VARCHAR(90) NULL,
    review_note VARCHAR(500) NOT NULL DEFAULT '',
    reviewed_at DATETIME(3) NULL,
    expires_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    INDEX idx_support_request_status(status, created_at),
    INDEX idx_support_request_tenant(tenant_id, created_at),
    CONSTRAINT fk_support_request_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_support_request_requester FOREIGN KEY (requested_by) REFERENCES platform_operators(id),
    CONSTRAINT fk_support_request_reviewer FOREIGN KEY (reviewed_by) REFERENCES platform_operators(id),
    CONSTRAINT chk_support_request_status CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
    CONSTRAINT chk_support_request_minutes CHECK (requested_minutes BETWEEN 1 AND 60)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS support_sessions (
    id VARCHAR(90) PRIMARY KEY,
    request_id VARCHAR(90) NOT NULL UNIQUE,
    tenant_id VARCHAR(64) NOT NULL,
    operator_id VARCHAR(90) NOT NULL,
    permission_codes_json JSON NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    started_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    terminated_at DATETIME(3) NULL,
    terminated_by VARCHAR(90) NULL,
    termination_reason VARCHAR(500) NOT NULL DEFAULT '',
    last_accessed_at DATETIME(3) NULL,
    access_count BIGINT NOT NULL DEFAULT 0,
    INDEX idx_support_session_active(operator_id, status, expires_at),
    INDEX idx_support_session_tenant(tenant_id, started_at),
    CONSTRAINT fk_support_session_request FOREIGN KEY (request_id) REFERENCES support_access_requests(id),
    CONSTRAINT fk_support_session_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_support_session_operator FOREIGN KEY (operator_id) REFERENCES platform_operators(id),
    CONSTRAINT fk_support_session_terminator FOREIGN KEY (terminated_by) REFERENCES platform_operators(id),
    CONSTRAINT chk_support_session_status CHECK (status IN ('active','expired','terminated'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function seedPermissionCatalog(pool: mysql.Pool) {
  for (const permission of IAM_PERMISSION_CATALOG) {
    const parts = permission.code.split(".");
    const actionName = parts.pop() || "read";
    const resourceName = parts.join(".");
    await pool.query(
      `INSERT INTO permissions
        (code, domain_name, module_name, resource_name, action_name, name, description,
         risk_level, scope_modes_json, status, introduced_version, updated_at)
       VALUES (?, 'tenant', ?, ?, ?, ?, '', ?, ?, 'active', ?, NOW(3))
       ON DUPLICATE KEY UPDATE module_name=VALUES(module_name), resource_name=VALUES(resource_name),
         action_name=VALUES(action_name), name=VALUES(name), risk_level=VALUES(risk_level),
         scope_modes_json=VALUES(scope_modes_json), status='active', updated_at=NOW(3)`,
      [permission.code, permission.module, resourceName, actionName, permission.name,
        permission.riskLevel, JSON.stringify(permission.scopeModes), IAM_FOUNDATION_SCHEMA_VERSION]
    );
  }
}

async function seedLegacyCompatibility(pool: mysql.Pool) {
  await pool.query(`INSERT INTO tenants
    (id, code, name, status, plan_code, seat_limit, timezone, locale, authz_revision, created_at, updated_at)
    SELECT DISTINCT u.team_id, u.team_id,
      COALESCE(NULLIF(cp.company_name, ''), u.team_id), 'active', 'beta', 50,
      'Asia/Shanghai', 'zh-CN', 1, NOW(3), NOW(3)
    FROM users u
    LEFT JOIN company_profiles cp ON cp.team_id = u.team_id
    WHERE u.role <> 'super_admin' AND u.team_id <> '' AND u.team_id <> 'all'
    ON DUPLICATE KEY UPDATE name=VALUES(name), updated_at=NOW(3)`);
  await pool.query(`INSERT INTO organization_units
    (id, tenant_id, parent_id, name, code, unit_type, path, depth, sort_order,
     status, version_no, created_at, updated_at)
    SELECT CONCAT('org_', LEFT(SHA2(t.id, 256), 32)), t.id, NULL, t.name,
      'company-root', 'company',
      CONCAT('/', CONCAT('org_', LEFT(SHA2(t.id, 256), 32)), '/'),
      0, 0, 'active', 1, NOW(3), NOW(3)
    FROM tenants t
    ON DUPLICATE KEY UPDATE name=VALUES(name), updated_at=NOW(3)`);
  await pool.query(`INSERT INTO tenant_memberships
    (id, tenant_id, user_id, title, status, primary_org_unit_id,
     membership_auth_version, joined_at, created_at, updated_at)
    SELECT CONCAT('mem_', LEFT(SHA2(CONCAT(u.team_id, ':', u.id), 256), 40)),
      u.team_id, u.id, '', IF(u.status='active','active','suspended'),
      CONCAT('org_', LEFT(SHA2(u.team_id, 256), 32)), 1, u.created_at, NOW(3), NOW(3)
    FROM users u
    WHERE u.role <> 'super_admin' AND u.team_id <> '' AND u.team_id <> 'all'
    ON DUPLICATE KEY UPDATE status=VALUES(status), primary_org_unit_id=VALUES(primary_org_unit_id), updated_at=NOW(3)`);
  await pool.query(`INSERT INTO organization_memberships
    (id, tenant_id, membership_id, org_unit_id, relation_type, is_leader,
     valid_from, created_at)
    SELECT CONCAT('om_', LEFT(SHA2(CONCAT(tm.tenant_id, ':', tm.id, ':primary'), 256), 40)),
      tm.tenant_id, tm.id, tm.primary_org_unit_id, 'primary', FALSE, tm.joined_at, NOW(3)
    FROM tenant_memberships tm
    WHERE tm.primary_org_unit_id IS NOT NULL
    ON DUPLICATE KEY UPDATE org_unit_id=VALUES(org_unit_id)`);
  await pool.query(`INSERT INTO roles
    (id, tenant_id, name, code, description, source, status, is_protected,
     version_no, created_at, updated_at)
    SELECT CONCAT('role_', LEFT(SHA2(CONCAT(t.id, ':', templates.code), 256), 40)),
      t.id, templates.name, templates.code, templates.description,
      'migrated', 'active', TRUE, 1, NOW(3), NOW(3)
    FROM tenants t
    JOIN (
      SELECT 'legacy_admin' code, '公司管理员' name, '迁移期公司管理角色' description
      UNION ALL SELECT 'legacy_manager', '销售主管', '迁移期团队经营角色'
      UNION ALL SELECT 'legacy_sales', '业务员', '迁移期本人业务角色'
    ) templates ON TRUE
    ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description), updated_at=NOW(3)`);
  for (const role of ["sales", "manager", "admin"] as const) {
    for (const permission of IAM_PERMISSION_CATALOG) {
      const scope = legacyPermissionScope(role, permission.code);
      if (!scope) continue;
      await pool.query(
        `INSERT IGNORE INTO role_permission_bindings
          (id, tenant_id, role_id, permission_code, scope_mode, created_at)
         SELECT CONCAT('rpb_', LEFT(SHA2(CONCAT(r.tenant_id, ':', r.id, ':', ?, ':', ?), 256), 40)),
           r.tenant_id, r.id, ?, ?, NOW(3)
         FROM roles r WHERE r.code = ?`,
        [permission.code, scope, permission.code, scope, `legacy_${role}`]
      );
    }
  }
  await pool.query(`INSERT INTO member_role_assignments
    (id, tenant_id, membership_id, role_id, scope_anchor_org_unit_id,
     status, reason, created_at)
    SELECT CONCAT('mra_', LEFT(SHA2(CONCAT(tm.tenant_id, ':', tm.id, ':', r.id), 256), 40)),
      tm.tenant_id, tm.id, r.id, tm.primary_org_unit_id, 'active', 'legacy migration', NOW(3)
    FROM tenant_memberships tm
    JOIN users u ON u.id = tm.user_id
    JOIN roles r ON r.tenant_id = tm.tenant_id AND r.code = CONCAT('legacy_', u.role)
    WHERE u.role IN ('sales','manager','admin')
    ON DUPLICATE KEY UPDATE status='active', scope_anchor_org_unit_id=VALUES(scope_anchor_org_unit_id)`);
  await pool.query(`INSERT INTO authorization_revisions (tenant_id, membership_id, revision, changed_at)
    SELECT id, '', authz_revision, NOW(3) FROM tenants
    ON DUPLICATE KEY UPDATE revision=GREATEST(revision, VALUES(revision))`);
  await pool.query(`INSERT INTO authorization_revisions (tenant_id, membership_id, revision, changed_at)
    SELECT tenant_id, id, membership_auth_version, NOW(3) FROM tenant_memberships
    ON DUPLICATE KEY UPDATE revision=GREATEST(revision, VALUES(revision))`);
  await pool.query(`INSERT INTO platform_roles
    (id, code, name, status, is_protected, created_at, updated_at)
    VALUES ('platform_owner', 'platform_owner', '平台所有者', 'active', TRUE, NOW(3), NOW(3))
    ON DUPLICATE KEY UPDATE name=VALUES(name), updated_at=NOW(3)`);
  await pool.query(`INSERT INTO platform_operators
    (id, user_id, status, mfa_required, auth_version, created_at, updated_at)
    SELECT CONCAT('pop_', LEFT(SHA2(u.id, 256), 40)), u.id, 'active', TRUE, 1, NOW(3), NOW(3)
    FROM users u WHERE u.role = 'super_admin'
    ON DUPLICATE KEY UPDATE status='active', updated_at=NOW(3)`);
  await pool.query(`INSERT IGNORE INTO platform_operator_role_assignments
    (operator_id, role_id, status, granted_at)
    SELECT id, 'platform_owner', 'active', NOW(3) FROM platform_operators`);
  for (const permissionCode of PLATFORM_PERMISSION_CODES) {
    await pool.query(`INSERT IGNORE INTO platform_role_permissions (role_id, permission_code, created_at)
      VALUES ('platform_owner', ?, NOW(3))`, [permissionCode]);
  }
}

export async function ensureIamFoundationSchema(pool: mysql.Pool) {
  await createTables(pool);
  await ensurePlatformMfaTables(pool);
  await seedPermissionCatalog(pool);
  await seedLegacyCompatibility(pool);
}
