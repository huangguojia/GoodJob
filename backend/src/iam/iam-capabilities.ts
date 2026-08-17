import type mysql from "mysql2/promise";
import type { SessionUser } from "../types.js";
import {
  IAM_FOUNDATION_SCHEMA_VERSION,
  IAM_PERMISSION_CATALOG,
  PLATFORM_PERMISSION_CODES,
  legacyPermissionScope,
  type IamScopeMode
} from "./iam-foundation.js";

export interface IamCapabilitySnapshot {
  schemaVersion: string;
  tenantId: string;
  membershipId: string;
  revision: string;
  source: "iam" | "legacy_compatibility" | "platform";
  permissions: Record<string, IamScopeMode[]>;
  roleNames: string[];
  generatedAt: string;
}

function addScope(
  target: Record<string, IamScopeMode[]>,
  permissionCode: string,
  scopeMode: IamScopeMode
) {
  const scopes = target[permissionCode] || [];
  if (!scopes.includes(scopeMode)) scopes.push(scopeMode);
  target[permissionCode] = scopes;
}

export function buildLegacyCapabilitySnapshot(actor: SessionUser): IamCapabilitySnapshot {
  const permissions: Record<string, IamScopeMode[]> = {};
  if (actor.iamSource === "platform" || (!actor.iamSource && actor.role === "super_admin")) {
    PLATFORM_PERMISSION_CODES.forEach((permissionCode) => addScope(permissions, permissionCode, "tenant"));
    return {
      schemaVersion: IAM_FOUNDATION_SCHEMA_VERSION,
      tenantId: "",
      membershipId: "",
      revision: `platform:${actor.authVersion}`,
      source: "platform",
      permissions,
      roleNames: ["平台运维"],
      generatedAt: new Date().toISOString()
    };
  }
  const legacyRole = actor.role as "sales" | "manager" | "admin";
  for (const permission of IAM_PERMISSION_CATALOG) {
    const scope = legacyPermissionScope(legacyRole, permission.code);
    if (scope) addScope(permissions, permission.code, scope);
  }
  return {
    schemaVersion: IAM_FOUNDATION_SCHEMA_VERSION,
    tenantId: actor.teamId,
    membershipId: `legacy:${actor.id}`,
    revision: `legacy:${actor.authVersion}`,
    source: "legacy_compatibility",
    permissions,
    roleNames: [actor.role === "admin" ? "公司管理员" : actor.role === "manager" ? "销售主管" : "业务员"],
    generatedAt: new Date().toISOString()
  };
}

export async function loadIamCapabilitySnapshot(
  pool: mysql.Pool,
  actor: SessionUser
): Promise<IamCapabilitySnapshot> {
  if (actor.iamSource === "platform" || (!actor.iamSource && actor.role === "super_admin")) {
    const [permissionRows] = await pool.query(
      `SELECT DISTINCT prp.permission_code, pr.name AS role_name
       FROM platform_operators po
       JOIN platform_operator_role_assignments pora
         ON pora.operator_id = po.id AND pora.status = 'active'
       JOIN platform_roles pr ON pr.id = pora.role_id AND pr.status = 'active'
       JOIN platform_role_permissions prp ON prp.role_id = pr.id
       WHERE po.user_id = ? AND po.status = 'active'`,
      [actor.id]
    );
    const permissions: Record<string, IamScopeMode[]> = {};
    for (const row of permissionRows as Array<{ permission_code: string; role_name: string }>) {
      addScope(permissions, row.permission_code, "tenant");
    }
    return {
      schemaVersion: IAM_FOUNDATION_SCHEMA_VERSION,
      tenantId: "",
      membershipId: "",
      revision: `platform:${actor.authVersion}`,
      source: "platform",
      permissions,
      roleNames: [...new Set((permissionRows as Array<{ role_name: string }>).map((row) => row.role_name))],
      generatedAt: new Date().toISOString()
    };
  }

  const [membershipRows] = await pool.query(
    `SELECT tm.id, tm.tenant_id, tm.membership_auth_version, t.authz_revision
     FROM tenant_memberships tm
     JOIN tenants t ON t.id = tm.tenant_id AND t.status IN ('trial','active')
     WHERE tm.user_id = ? AND tm.tenant_id = ? AND tm.status = 'active'
     LIMIT 1`,
    [actor.id, actor.teamId]
  );
  const membership = (membershipRows as Array<{
    id: string;
    tenant_id: string;
    membership_auth_version: number;
    authz_revision: number;
  }>)[0];
  if (!membership) {
    return {
      schemaVersion: IAM_FOUNDATION_SCHEMA_VERSION,
      tenantId: actor.teamId,
      membershipId: "",
      revision: `inactive:${actor.authVersion}`,
      source: "iam",
      permissions: {},
      roleNames: [],
      generatedAt: new Date().toISOString()
    };
  }

  const [roleRows] = await pool.query(
    `SELECT rpb.permission_code, rpb.scope_mode, r.name AS role_name
     FROM member_role_assignments mra
     JOIN roles r ON r.tenant_id = mra.tenant_id AND r.id = mra.role_id AND r.status = 'active'
     JOIN role_permission_bindings rpb ON rpb.tenant_id = r.tenant_id AND rpb.role_id = r.id
     JOIN permissions p ON p.code = rpb.permission_code AND p.status = 'active'
     WHERE mra.tenant_id = ? AND mra.membership_id = ? AND mra.status = 'active'
       AND (mra.valid_from IS NULL OR mra.valid_from <= NOW(3))
       AND (mra.valid_until IS NULL OR mra.valid_until > NOW(3))`,
    [membership.tenant_id, membership.id]
  );
  const [grantRows] = await pool.query(
    `SELECT mpg.permission_code, mpg.scope_mode
     FROM member_permission_grants mpg
     JOIN permissions p ON p.code = mpg.permission_code AND p.status = 'active'
     WHERE mpg.tenant_id = ? AND mpg.membership_id = ? AND mpg.status = 'active'
       AND mpg.valid_until > NOW(3)`,
    [membership.tenant_id, membership.id]
  );
  const permissions: Record<string, IamScopeMode[]> = {};
  for (const row of [...roleRows as Array<{ permission_code: string; scope_mode: IamScopeMode }>,
    ...grantRows as Array<{ permission_code: string; scope_mode: IamScopeMode }>]) {
    addScope(permissions, row.permission_code, row.scope_mode);
  }
  return {
    schemaVersion: IAM_FOUNDATION_SCHEMA_VERSION,
    tenantId: membership.tenant_id,
    membershipId: membership.id,
    revision: `${membership.authz_revision}:${membership.membership_auth_version}`,
    source: "iam",
    permissions,
    roleNames: [...new Set((roleRows as Array<{ role_name: string }>).map((row) => row.role_name))],
    generatedAt: new Date().toISOString()
  };
}
