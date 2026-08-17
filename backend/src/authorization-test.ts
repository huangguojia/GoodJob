import assert from "node:assert/strict";
import {
  assertObjectScope,
  authorize,
  rejectClientScopeSelectors,
  resolveDataScope
} from "./authorization.js";
import type { SessionUser } from "./types.js";

function user(role: SessionUser["role"], id: string, teamId: string): SessionUser {
  return {
    id,
    teamId,
    role,
    name: id,
    email: `${id}@example.com`,
    avatar: id.slice(0, 1),
    authVersion: 1
  };
}

const salesA = user("sales", "sales_a", "team_a");
const managerA = user("manager", "manager_a", "team_a");
const adminA = user("admin", "admin_a", "team_a");
const adminB = user("admin", "admin_b", "team_b");
const superAdmin = user("super_admin", "root", "platform");
superAdmin.iamSource = "platform";
superAdmin.iamPermissions = { "platform.integration.connector.review": ["tenant"] };

assert.deepEqual(resolveDataScope(salesA), { type: "personal", ownerId: "sales_a", teamId: "team_a" });
assert.deepEqual(resolveDataScope(managerA), { type: "team", teamId: "team_a" });
assert.deepEqual(resolveDataScope(adminA), { type: "team", teamId: "team_a" });
assert.throws(() => resolveDataScope(superAdmin), /平台运维/u);
assert.throws(() => resolveDataScope(superAdmin, { type: "team", teamId: "team_b" }), /平台运维/u);
assert.deepEqual(resolveDataScope(superAdmin, { type: "platform" }, "platform.integration.connector.review"), { type: "platform" });

assert.throws(() => resolveDataScope(salesA, { type: "team", teamId: "team_a" }), /不能扩大/u);
assert.throws(() => resolveDataScope(managerA, { type: "team", teamId: "team_b" }), /其他团队/u);
assert.throws(() => resolveDataScope(adminB, { type: "platform" }), /平台级/u);
assert.throws(() => resolveDataScope(superAdmin, { type: "team" }), /平台运维/u);

for (const resource of [
  "business.record",
  "integration.connection",
  "integration.tool",
  "integration.approval",
  "integration.call",
  "integration.event"
] as const) {
  const scope = resource === "integration.approval"
    ? authorize({ actor: managerA, resource, action: "read" }).scope
    : authorize({ actor: salesA, resource, action: "read" }).scope;
  assert.doesNotThrow(() => assertObjectScope(
    resource === "integration.approval" ? managerA : salesA,
    scope,
    resource === "integration.approval"
      ? { teamId: "team_a", ownerId: "sales_a" }
      : { teamId: "team_a", ownerId: "sales_a" }
  ));
  assert.throws(() => assertObjectScope(
    resource === "integration.approval" ? managerA : salesA,
    scope,
    { teamId: "team_b", ownerId: "sales_b" }
  ), /不属于/u);
}

assert.throws(() => authorize({
  actor: salesA,
  resource: "integration.tool",
  action: "grant"
}), /没有执行/u);
assert.throws(() => authorize({
  actor: adminA,
  resource: "unknown.resource",
  action: "read"
}), /未知资源权限/u);
assert.throws(() => rejectClientScopeSelectors({ teamId: "team_b" }), /teamId/u);
assert.throws(() => rejectClientScopeSelectors({ ownerId: "sales_b" }), /ownerId/u);

console.log(JSON.stringify({
  ok: true,
  defaultDeny: true,
  salesIsolation: true,
  teamIsolation: true,
  explicitSuperAdminContext: true,
  forgedScopeBlocked: true
}, null, 2));
