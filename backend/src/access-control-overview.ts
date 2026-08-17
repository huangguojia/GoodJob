import type { CompanyProfile, Role, SessionUser, User } from "./types.js";
import {
  IAM_FOUNDATION_SCHEMA_VERSION,
  IAM_PERMISSION_CATALOG,
  legacyPermissionScope,
  type IamRiskLevel,
  type IamScopeMode
} from "./iam/iam-foundation.js";
import { hasIamPermission, isPlatformIdentity } from "./auth.js";

export type AccessScopePreview = "none" | IamScopeMode | "platform";

export class AccessControlOverviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AccessControlOverviewError";
  }
}

const roleDefinitions: Array<{
  code: Exclude<Role, "super_admin">;
  name: string;
  summary: string;
}> = [
  { code: "admin", name: "公司管理员", summary: "当前公司的成员、配置与全部业务数据" },
  { code: "manager", name: "销售主管", summary: "当前公司的业务协作与经营数据" },
  { code: "sales", name: "业务员", summary: "本人负责的客户、线索、商机与日常工作" }
];

const permissionDefinitions: Array<{
  code: string;
  module: string;
  name: string;
  riskLevel: IamRiskLevel;
  grants: Record<Exclude<Role, "super_admin">, AccessScopePreview>;
}> = IAM_PERMISSION_CATALOG.map((permission) => ({
  code: permission.code,
  module: permission.module,
  name: permission.name,
  riskLevel: permission.riskLevel,
  grants: {
    sales: legacyPermissionScope("sales", permission.code) || "none",
    manager: legacyPermissionScope("manager", permission.code) || "none",
    admin: legacyPermissionScope("admin", permission.code) || "none"
  }
}));

function uniqueTenantIds(users: User[]) {
  return [...new Set(users
    .filter((user) => user.role !== "super_admin" && user.teamId && user.teamId !== "all")
    .map((user) => user.teamId))].sort((left, right) => left.localeCompare(right));
}

function companyName(teamId: string, profiles: CompanyProfile[]) {
  return profiles.find((profile) => profile.teamId === teamId)?.companyName?.trim() || teamId;
}

export function buildAccessControlOverview(input: {
  actor: SessionUser;
  users: User[];
  companyProfiles: CompanyProfile[];
  requestedTeamId?: string;
  canView?: boolean;
}) {
  const { actor, users, companyProfiles } = input;
  if (input.canView !== true && !hasIamPermission(actor, "role.read") && !isPlatformIdentity(actor)) {
    throw new AccessControlOverviewError(403, "当前账号没有组织与权限查看权限");
  }
  const tenantIds = uniqueTenantIds(users);
  const companies = tenantIds.map((teamId) => ({
    id: teamId,
    name: companyName(teamId, companyProfiles),
    memberCount: users.filter((user) => user.teamId === teamId && user.role !== "super_admin").length
  }));
  const requestedTeamId = String(input.requestedTeamId || "").trim();
  const teamId = isPlatformIdentity(actor) ? requestedTeamId : actor.teamId;
  if (!isPlatformIdentity(actor) && requestedTeamId && requestedTeamId !== actor.teamId) {
    throw new AccessControlOverviewError(404, "公司不存在");
  }
  if (!teamId) {
    return {
      foundation: {
        schemaVersion: IAM_FOUNDATION_SCHEMA_VERSION,
        mode: "legacy_compatibility" as const,
        permissionCount: IAM_PERMISSION_CATALOG.length
      },
      companies,
      company: null,
      metrics: null,
      organizationUnits: [],
      roles: [],
      permissions: [],
      members: []
    };
  }
  if (!tenantIds.includes(teamId)) throw new AccessControlOverviewError(404, "公司不存在");

  const companyUsers = users
    .filter((user) => user.teamId === teamId && user.role !== "super_admin")
    .sort((left, right) => Number(right.status === "active") - Number(left.status === "active") || left.name.localeCompare(right.name));
  const company = { id: teamId, name: companyName(teamId, companyProfiles) };
  const roles = roleDefinitions.map((definition) => {
    const rolePermissions = permissionDefinitions.filter((permission) => permission.grants[definition.code] !== "none");
    return {
      ...definition,
      id: `legacy_${definition.code}`,
      memberCount: companyUsers.filter((user) => user.role === definition.code).length,
      permissionCount: rolePermissions.length,
      moduleCount: new Set(rolePermissions.map((permission) => permission.module)).size,
      source: "legacy_policy" as const
    };
  });
  const members = companyUsers.map((user) => {
    const role = roles.find((item) => item.code === user.role);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      status: user.status,
      roleId: role?.id || "",
      roleCode: user.role,
      roleName: role?.name || user.role,
      organizationUnitId: "",
      organizationUnitName: "未分配组织"
    };
  });
  return {
    foundation: {
      schemaVersion: IAM_FOUNDATION_SCHEMA_VERSION,
      mode: "legacy_compatibility" as const,
      permissionCount: IAM_PERMISSION_CATALOG.length
    },
    companies,
    company,
    metrics: {
      memberCount: members.length,
      activeMemberCount: members.filter((member) => member.status === "active").length,
      roleCount: roles.length,
      organizationUnitCount: 1,
      unassignedMemberCount: members.length
    },
    organizationUnits: [
      { id: `company_${teamId}`, parentId: "", name: company.name, type: "company" as const, memberCount: members.length },
      { id: `unassigned_${teamId}`, parentId: `company_${teamId}`, name: "未分配组织", type: "unassigned" as const, memberCount: members.length }
    ],
    roles,
    permissions: permissionDefinitions.map((permission) => ({
      code: permission.code,
      module: permission.module,
      name: permission.name,
      riskLevel: permission.riskLevel,
      grants: Object.fromEntries(roles.map((role) => [role.id, permission.grants[role.code]]))
    })),
    members
  };
}
