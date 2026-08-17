import assert from "node:assert/strict";
import {
  IAM_FOUNDATION_SCHEMA_VERSION,
  IAM_PERMISSION_CATALOG,
  legacyPermissionScope
} from "./iam-foundation.js";

assert.equal(IAM_FOUNDATION_SCHEMA_VERSION, "iam-foundation-v1");
assert.equal(new Set(IAM_PERMISSION_CATALOG.map((item) => item.code)).size, IAM_PERMISSION_CATALOG.length);
assert.equal(legacyPermissionScope("sales", "customer.read"), "self");
assert.equal(legacyPermissionScope("sales", "customer.export"), "self");
assert.equal(legacyPermissionScope("manager", "customer.export"), "org_subtree");
assert.equal(legacyPermissionScope("admin", "role.manage"), "tenant");
assert.equal(legacyPermissionScope("sales", "customer.pool.claim"), "public_pool");
assert.ok(IAM_PERMISSION_CATALOG.every((item) => item.code.includes(".") && item.scopeModes.length > 0));

console.log(JSON.stringify({
  ok: true,
  schemaVersion: IAM_FOUNDATION_SCHEMA_VERSION,
  permissionCount: IAM_PERMISSION_CATALOG.length,
  legacyCompatibility: true
}, null, 2));
