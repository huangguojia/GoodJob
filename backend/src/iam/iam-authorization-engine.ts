import type { IamCapabilitySnapshot } from "./iam-capabilities.js";
import type { IamScopeMode } from "./iam-foundation.js";

export interface IamAuthorizationObject {
  tenantId: string;
  ownerId?: string;
  organizationUnitId?: string;
  organizationPath?: string;
  publicPool?: boolean;
}

export interface IamAuthorizationContext {
  actorId: string;
  tenantId: string;
  organizationUnitIds?: string[];
  organizationPaths?: string[];
  permissionCode: string;
  object?: IamAuthorizationObject;
}

export interface IamAuthorizationDecision {
  allowed: boolean;
  permissionCode: string;
  matchedScope: IamScopeMode | "";
  reason: string;
}

export function authorizeIam(snapshot: IamCapabilitySnapshot, input: IamAuthorizationContext): IamAuthorizationDecision {
  if (!input.tenantId || snapshot.tenantId !== input.tenantId) {
    return { allowed: false, permissionCode: input.permissionCode, matchedScope: "", reason: "租户边界不匹配" };
  }
  const object = input.object;
  if (object && object.tenantId !== input.tenantId) {
    return { allowed: false, permissionCode: input.permissionCode, matchedScope: "", reason: "对象不属于当前租户" };
  }
  const scopes = snapshot.permissions[input.permissionCode] || [];
  for (const scope of scopes) {
    if (!object) return { allowed: true, permissionCode: input.permissionCode, matchedScope: scope, reason: "操作权限已授予" };
    if (scope === "tenant") return { allowed: true, permissionCode: input.permissionCode, matchedScope: scope, reason: "命中公司范围" };
    if (scope === "public_pool" && object.publicPool) return { allowed: true, permissionCode: input.permissionCode, matchedScope: scope, reason: "命中客户公池范围" };
    if (scope === "self" && object.ownerId === input.actorId) return { allowed: true, permissionCode: input.permissionCode, matchedScope: scope, reason: "命中本人范围" };
    if (scope === "org_unit" && object.organizationUnitId && input.organizationUnitIds?.includes(object.organizationUnitId)) return { allowed: true, permissionCode: input.permissionCode, matchedScope: scope, reason: "命中本组织范围" };
    if (scope === "org_subtree" && object.organizationPath && input.organizationPaths?.some((path) => object.organizationPath!.startsWith(path))) return { allowed: true, permissionCode: input.permissionCode, matchedScope: scope, reason: "命中组织树范围" };
  }
  return { allowed: false, permissionCode: input.permissionCode, matchedScope: "", reason: "默认拒绝：没有匹配的权限数据范围" };
}
