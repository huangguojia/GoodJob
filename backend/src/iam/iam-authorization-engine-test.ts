import assert from "node:assert/strict";
import { authorizeIam } from "./iam-authorization-engine.js";
import type { IamCapabilitySnapshot } from "./iam-capabilities.js";

const snapshot: IamCapabilitySnapshot = {
  schemaVersion: "iam-foundation-v1", tenantId: "tenant-a", membershipId: "m1", revision: "2:4", source: "iam",
  permissions: { "customer.read": ["self", "org_subtree"], "customer.pool.claim": ["public_pool"] }, generatedAt: new Date().toISOString()
};
assert.equal(authorizeIam(snapshot, { actorId: "u1", tenantId: "tenant-a", permissionCode: "customer.read", object: { tenantId: "tenant-a", ownerId: "u1" } }).allowed, true);
assert.equal(authorizeIam(snapshot, { actorId: "u1", tenantId: "tenant-b", permissionCode: "customer.read" }).allowed, false);
assert.equal(authorizeIam(snapshot, { actorId: "u1", tenantId: "tenant-a", permissionCode: "customer.read", object: { tenantId: "tenant-b", ownerId: "u1" } }).allowed, false);
assert.equal(authorizeIam(snapshot, { actorId: "u1", tenantId: "tenant-a", permissionCode: "customer.pool.claim", object: { tenantId: "tenant-a", publicPool: true } }).allowed, true);
assert.equal(authorizeIam(snapshot, { actorId: "u1", tenantId: "tenant-a", permissionCode: "customer.delete", object: { tenantId: "tenant-a", ownerId: "u1" } }).allowed, false);
console.log(JSON.stringify({ ok: true, defaultDeny: true, tenantIsolation: true }));
