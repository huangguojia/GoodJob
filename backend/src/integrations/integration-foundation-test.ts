import assert from "node:assert/strict";
import { ensureIntegrationSchema, INTEGRATION_TABLES } from "./integration-mysql-schema.js";
import {
  assertConnectionScopeInvariant,
  assertConnectionTransition,
  isConnectionTransitionAllowed
} from "./integration-types.js";
import { systemConnectorCatalog } from "./connector-catalog.js";

const statements: string[] = [];
await ensureIntegrationSchema({
  query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes("information_schema.columns")) return [[{ count: 1 }], []] as never;
    return [[], []] as never;
  }
} as never);

assert.ok(statements.length >= INTEGRATION_TABLES.length);
for (const table of INTEGRATION_TABLES) {
  assert.ok(statements.some((sql) => sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`)), `${table} 缺少建表语句`);
}
for (const expected of [
  "UNIQUE KEY uk_integration_connector_version",
  "UNIQUE KEY uk_integration_auth_state",
  "UNIQUE KEY uk_integration_tool_schema",
  "UNIQUE KEY uk_integration_tool_grant",
  "UNIQUE KEY uk_integration_approval_nonce",
  "UNIQUE KEY uk_integration_call_request",
  "UNIQUE KEY uk_integration_call_idempotency",
  "UNIQUE KEY uk_integration_connection_webhook_public",
  "UNIQUE KEY uk_integration_external_event"
]) {
  assert.ok(statements.some((sql) => sql.includes(expected)), `${expected} 缺失`);
}
assert.ok(statements.some((sql) => sql.includes("encrypted_value LONGTEXT")), "高敏凭据必须使用独立密文字段");

assert.equal(isConnectionTransitionAllowed("draft", "authorizing"), true);
assert.equal(isConnectionTransitionAllowed("active", "paused"), true);
assert.equal(isConnectionTransitionAllowed("paused", "active"), true);
assert.equal(isConnectionTransitionAllowed("disconnected", "active"), false);
assert.doesNotThrow(() => assertConnectionTransition("active", "disconnecting"));
assert.throws(() => assertConnectionTransition("disconnected", "active"), /不能从/u);

assert.doesNotThrow(() => assertConnectionScopeInvariant({
  scope: "personal", scopeId: "user_a", ownerId: "user_a", teamId: "team_a"
}));
assert.doesNotThrow(() => assertConnectionScopeInvariant({
  scope: "team", scopeId: "team_a", ownerId: "admin_a", teamId: "team_a"
}));
assert.doesNotThrow(() => assertConnectionScopeInvariant({
  scope: "platform", scopeId: "platform", ownerId: "root", teamId: "platform"
}));
assert.throws(() => assertConnectionScopeInvariant({
  scope: "personal", scopeId: "user_b", ownerId: "user_a", teamId: "team_a"
}), /scopeId/u);

const plannedGoogle = systemConnectorCatalog({ NODE_ENV: "test" }).find((item) => item.code === "google-workspace");
assert.equal(plannedGoogle?.status, "draft");
assert.equal(systemConnectorCatalog({
  NODE_ENV: "test", INTEGRATION_GOOGLE_CLIENT_ID: "google-client-id"
}).find((item) => item.code === "google-workspace")?.status, "draft");
const activeGoogle = systemConnectorCatalog({
  NODE_ENV: "test",
  INTEGRATION_GOOGLE_CLIENT_ID: "google-client-id",
  INTEGRATION_OAUTH_GOOGLE_CLIENT_SECRET: "server-only-secret"
}).find((item) => item.code === "google-workspace");
assert.equal(activeGoogle?.status, "active");
assert.equal(activeGoogle?.manifest.driver, "google_workspace");
assert.equal((activeGoogle?.manifest.oauth as { clientSecretEnv?: string }).clientSecretEnv, "INTEGRATION_OAUTH_GOOGLE_CLIENT_SECRET");
assert.equal(JSON.stringify(activeGoogle?.manifest).includes("server-only-secret"), false);

const activeErpNext = systemConnectorCatalog({
  NODE_ENV: "test", INTEGRATION_ERPNEXT_BASE_URL: "http://127.0.0.1:43210/"
}).find((item) => item.code === "erpnext");
assert.equal(activeErpNext?.status, "active");
assert.equal(activeErpNext?.manifest.driver, "erpnext");
assert.equal(activeErpNext?.manifest.authentication, "api_token");
assert.equal(JSON.stringify(activeErpNext?.manifest).includes("apiSecret"), true);
assert.equal(systemConnectorCatalog({ NODE_ENV: "test" }).find((item) => item.code === "odoo")?.status, "deprecated");
assert.equal(systemConnectorCatalog({ NODE_ENV: "test" }).find((item) => item.code === "international-logistics")?.status, "active");
const weCom = systemConnectorCatalog({ NODE_ENV: "test" }).find((item) => item.code === "wecom");
assert.equal(weCom?.status, "active");
assert.equal(weCom?.manifest.driver, "wecom");
assert.equal(weCom?.manifest.authentication, "api_token");
assert.equal((weCom?.manifest.credentialFields as unknown[]).length, 4);
assert.equal(weCom?.manifest.endpoint, "https://qyapi.weixin.qq.com/");

console.log(JSON.stringify({
  ok: true,
  tables: INTEGRATION_TABLES.length,
  uniqueConstraints: true,
  encryptedCredentialColumns: true,
  connectionStateMachine: true,
  connectionScopeInvariants: true,
  googleWorkspaceCatalogSecretSafe: true,
  secondBatchConnectorCatalog: true,
  weComOfficialConnectorCatalog: true
}, null, 2));
