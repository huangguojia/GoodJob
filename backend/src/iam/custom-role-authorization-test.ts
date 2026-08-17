import assert from "node:assert/strict";
import { canManageAccounts, canSeeOwner, hasIamPermission, hasIamScope, isPlatformIdentity } from "../auth.js";
import type { SessionUser } from "../types.js";
import { scopeCovers } from "./iam-management-service.js";

const customRoleActor: SessionUser = {
  id: "custom_manager",
  name: "Custom Manager",
  email: "custom@example.test",
  role: "sales",
  teamId: "tenant_a",
  avatar: "CM",
  authVersion: 1,
  iamSource: "iam",
  iamRoleNames: ["区域负责人"],
  iamPermissions: {
    "member.manage": ["org_subtree"],
    "commission.manage": ["org_subtree"],
    "training.manage": ["org_subtree"],
    "integration.manage": ["tenant"],
    "document.manage": ["org_subtree"]
  },
  iamDataScope: { permissionCode: "document.manage", tenantWide: false, ownerIds: ["custom_manager", "sales_child"] }
};

assert.equal(canManageAccounts(customRoleActor), true);
assert.equal(hasIamPermission(customRoleActor, "commission.manage"), true);
assert.equal(hasIamPermission(customRoleActor, "training.manage"), true);
assert.equal(hasIamPermission(customRoleActor, "integration.manage"), true);
assert.equal(hasIamScope(customRoleActor, "document.manage", ["org_subtree", "tenant"]), true);
assert.equal(canSeeOwner(customRoleActor, "sales_child", "tenant_a"), true);
assert.equal(canSeeOwner(customRoleActor, "sales_outside", "tenant_a"), false);
assert.equal(canSeeOwner(customRoleActor, "sales_child", "tenant_b"), false);
assert.equal(isPlatformIdentity(customRoleActor), false);
assert.equal(scopeCovers("org_subtree", "org_unit"), true);
assert.equal(scopeCovers("org_unit", "org_subtree"), false);
assert.equal(scopeCovers("self", "tenant"), false);

const denied = { ...customRoleActor, iamPermissions: {}, iamDataScope: undefined };
assert.equal(hasIamPermission(denied, "commission.manage"), false);
assert.equal(canSeeOwner(denied, denied.id, denied.teamId), false);

const platform = { ...customRoleActor, iamSource: "platform" as const, iamDataScope: undefined };
assert.equal(isPlatformIdentity(platform), true);
assert.equal(canSeeOwner(platform, "sales_child", "tenant_a"), false);

console.log(JSON.stringify({ ok: true, customRoleEffective: true, defaultDeny: true, crossTenantBlocked: true, platformBusinessAccessBlocked: true }, null, 2));
