import type { SessionUser } from "./types.js";
import { legacyPermissionScope } from "./iam/iam-foundation.js";

export type AuthorizationAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "execute"
  | "review"
  | "grant"
  | "approve"
  | "pause"
  | "disconnect"
  | "manage";

export type AuthorizationResource =
  | "business.record"
  | "integration.connector"
  | "integration.connection"
  | "integration.tool"
  | "integration.approval"
  | "integration.call"
  | "integration.event"
  | "integration.policy";

export type DataScopeType = "personal" | "team" | "platform";

export interface DataScope {
  type: DataScopeType;
  ownerId?: string;
  ownerIds?: string[];
  teamId?: string;
}

export interface ScopeRequest {
  type?: DataScopeType;
  ownerId?: string;
  ownerIds?: string[];
  teamId?: string;
}

export interface ScopedObject {
  ownerId?: string | null;
  teamId?: string | null;
}

export interface AuthorizationInput {
  actor: SessionUser;
  resource: AuthorizationResource | string;
  action: AuthorizationAction;
  requestedScope?: ScopeRequest;
  object?: ScopedObject;
  payload?: unknown;
}

export interface AuthorizationDecision {
  allowed: true;
  resource: AuthorizationResource;
  action: AuthorizationAction;
  scope: DataScope;
}

export class AuthorizationError extends Error {
  readonly code: "AUTHORIZATION_DENIED" | "DATA_SCOPE_DENIED" | "UNKNOWN_PERMISSION";
  readonly status = 403;

  constructor(
    code: AuthorizationError["code"],
    message: string
  ) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

type PermissionPolicy = Partial<Record<AuthorizationAction, string>>;

const policies: Record<AuthorizationResource, PermissionPolicy> = {
  "business.record": {
    read: "integration.read", create: "integration.execute", update: "integration.execute",
    delete: "integration.manage", execute: "integration.execute", manage: "integration.manage"
  },
  "integration.connector": {
    read: "integration.read", create: "integration.manage", update: "integration.manage",
    review: "platform.integration.connector.review", pause: "integration.manage", manage: "integration.manage"
  },
  "integration.connection": {
    read: "integration.read", create: "integration.connect", update: "integration.connect",
    execute: "integration.execute", pause: "integration.connect", disconnect: "integration.connect",
    manage: "integration.manage"
  },
  "integration.tool": {
    read: "integration.read", execute: "integration.execute", review: "integration.manage",
    grant: "integration.manage", pause: "integration.manage", manage: "integration.manage"
  },
  "integration.approval": {
    read: "integration.read", create: "integration.execute", approve: "integration.approval.act",
    manage: "integration.manage"
  },
  "integration.call": {
    read: "integration.read", create: "integration.execute", execute: "integration.execute",
    pause: "integration.manage", manage: "integration.manage"
  },
  "integration.event": {
    read: "integration.read", update: "integration.execute", execute: "integration.execute",
    manage: "integration.manage"
  },
  "integration.policy": {
    read: "integration.manage", create: "integration.manage", update: "integration.manage",
    delete: "integration.manage", manage: "integration.manage"
  }
};

function platformIdentity(actor: SessionUser) {
  return actor.iamSource === "platform" || (!actor.iamSource && actor.role === "super_admin");
}

function permissionScopes(actor: SessionUser, permissionCode: string) {
  if (actor.iamPermissions) return actor.iamPermissions[permissionCode] || [];
  if (platformIdentity(actor)) return [];
  if (actor.role === "super_admin") return [];
  const scope = legacyPermissionScope(actor.role, permissionCode);
  return scope ? [scope] : [];
}

function hasPermission(actor: SessionUser, permissionCode: string) {
  return permissionScopes(actor, permissionCode).length > 0;
}

function denied(code: AuthorizationError["code"], message: string): never {
  throw new AuthorizationError(code, message);
}

export function resolveDataScope(
  actor: SessionUser,
  requested: ScopeRequest = {},
  permissionCode = "integration.read"
): DataScope {
  const requestedType = requested.type;
  if (requestedType === "platform") {
    if (!platformIdentity(actor) || !hasPermission(actor, permissionCode)) denied("DATA_SCOPE_DENIED", "当前账号不能使用平台级数据范围");
    if (requested.ownerId || requested.ownerIds?.length || requested.teamId) denied("DATA_SCOPE_DENIED", "平台范围不能混入个人或团队范围");
    return { type: "platform" };
  }
  if (platformIdentity(actor)) denied("DATA_SCOPE_DENIED", "平台运维身份不能访问公司数据范围");
  const scopes = permissionScopes(actor, permissionCode);
  if (!scopes.length) denied("AUTHORIZATION_DENIED", "当前账号没有执行该操作的权限");
  const resolved = actor.iamDataScope?.permissionCode === permissionCode ? actor.iamDataScope : undefined;
  const tenantWide = resolved?.tenantWide === true || scopes.includes("tenant");
  const organizationWide = scopes.includes("org_unit") || scopes.includes("org_subtree");
  const resolvedOwnerIds = [...new Set((resolved?.ownerIds || []).filter(Boolean))];

  if (requestedType === "team") {
    const teamId = String(requested.teamId || actor.teamId).trim();
    if (!teamId) denied("DATA_SCOPE_DENIED", "团队数据范围缺少团队上下文");
    if (teamId !== actor.teamId) denied("DATA_SCOPE_DENIED", "不能访问其他团队数据");
    if (requested.ownerId) denied("DATA_SCOPE_DENIED", "团队范围不能混入单个 ownerId");
    if (!tenantWide && !organizationWide) denied("DATA_SCOPE_DENIED", "当前权限不能扩大为团队数据范围");
    const requestedOwners = [...new Set((requested.ownerIds || []).filter(Boolean))];
    if (tenantWide && !requestedOwners.length) return { type: "team", teamId };
    const allowedOwners = resolvedOwnerIds.length ? resolvedOwnerIds : [actor.id];
    const ownerIds = requestedOwners.length ? requestedOwners : allowedOwners;
    if (ownerIds.some((ownerId) => !allowedOwners.includes(ownerId))) denied("DATA_SCOPE_DENIED", "不能访问授权组织范围之外的数据");
    return { type: "team", teamId, ownerIds };
  }

  if (requestedType && requestedType !== "personal") denied("DATA_SCOPE_DENIED", "不支持的数据范围");
  const ownerId = String(requested.ownerId || actor.id).trim();
  if (ownerId !== actor.id) denied("DATA_SCOPE_DENIED", "个人范围只能使用当前登录账号");
  if (requested.teamId && requested.teamId !== actor.teamId) denied("DATA_SCOPE_DENIED", "个人范围不能跨团队");
  if (!requestedType && tenantWide) return { type: "team", teamId: actor.teamId };
  if (!requestedType && organizationWide) {
    if (!actor.iamPermissions && !resolved) return { type: "team", teamId: actor.teamId };
    return { type: "team", teamId: actor.teamId, ownerIds: resolvedOwnerIds.length ? resolvedOwnerIds : [actor.id] };
  }
  return { type: "personal", ownerId: actor.id, teamId: actor.teamId };
}

export function assertObjectScope(
  actor: SessionUser,
  scope: DataScope,
  object: ScopedObject
): void {
  if (scope.type === "platform") {
    if (!platformIdentity(actor)) denied("DATA_SCOPE_DENIED", "当前账号不能访问平台级对象");
    return;
  }
  if (scope.type === "team") {
    if (!object.teamId || object.teamId !== scope.teamId) denied("DATA_SCOPE_DENIED", "对象不属于当前团队范围");
    if (scope.ownerIds?.length && object.ownerId && !scope.ownerIds.includes(object.ownerId)) {
      denied("DATA_SCOPE_DENIED", "对象不属于当前组织授权范围");
    }
    return;
  }
  if (!object.ownerId || object.ownerId !== actor.id) denied("DATA_SCOPE_DENIED", "对象不属于当前账号");
  if (object.teamId && object.teamId !== actor.teamId) denied("DATA_SCOPE_DENIED", "对象团队与当前账号不一致");
}

export function rejectClientScopeSelectors(
  payload: unknown,
  fields: readonly string[] = ["teamId", "ownerId", "ownerIds"]
): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  const forged = fields.find((field) => Object.prototype.hasOwnProperty.call(record, field));
  if (forged) denied("DATA_SCOPE_DENIED", `${forged} 必须由服务端根据登录身份确定`);
}

export function authorize(input: AuthorizationInput): AuthorizationDecision {
  const policy = policies[input.resource as AuthorizationResource];
  if (!policy) denied("UNKNOWN_PERMISSION", `未知资源权限：${input.resource}`);
  const permissionCode = policy[input.action];
  if (!permissionCode || !hasPermission(input.actor, permissionCode)) denied("AUTHORIZATION_DENIED", "当前账号没有执行该操作的权限");
  rejectClientScopeSelectors(input.payload);
  const scope = resolveDataScope(input.actor, input.requestedScope, permissionCode);
  if (input.object) assertObjectScope(input.actor, scope, input.object);
  return {
    allowed: true,
    resource: input.resource as AuthorizationResource,
    action: input.action,
    scope
  };
}
