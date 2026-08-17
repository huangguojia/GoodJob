import assert from "node:assert/strict";
import { assertAgentApiToolRisk, classifyAgentApiRequest, deniedAgentApiReason, normalizeAgentApiPath, redactAgentApiData, routeTemplateMatches } from "./agent-api-policy.js";

const denied = [
  "/api/auth/me",
  "/api/accounts",
  "/api/accounts/u1/password",
  "/api/system/database-import/status",
  "/api/system/database-maintenance/status",
  "/api/system/database-backups/jobs",
  "/api/admin/updates/apply",
  "/api/profile",
  "/api/profile/email-binding",
  "/api/tools/ai-config",
  "/api/lead-finder/source-config",
  "/api/internal-messages/recipients",
  "/api/prospect-list/assignees",
  "/api/whatsapp/binding/web-scan/start",
  "/api/integrations/catalog",
  "/api/integrations/tools/tool_a/test",
  "/api/agent/plan",
  "/api/agent/runs/one",
  "/api/agent/api/request"
];
denied.forEach((path) => assert.ok(deniedAgentApiReason(path), `${path} 必须被拒绝`));

assert.equal(classifyAgentApiRequest("GET", "/api/customers"), "read");
assert.equal(classifyAgentApiRequest("POST", "/api/customers"), "write");
assert.equal(classifyAgentApiRequest("PATCH", "/api/deals/d1"), "write");
assert.equal(classifyAgentApiRequest("POST", "/api/development-email/send"), "external");
assert.equal(classifyAgentApiRequest("POST", "/api/whatsapp/customers/c1/messages"), "external");
assert.equal(classifyAgentApiRequest("POST", "/api/lead-finder/search"), "external");
assert.equal(classifyAgentApiRequest("POST", "/api/lead-finder/launch"), "external");
assert.equal(classifyAgentApiRequest("POST", "/api/internal-messages"), "external");
assert.throws(() => classifyAgentApiRequest("GET", "/api/accounts"), /账号/u);
assert.throws(() => normalizeAgentApiPath("https://example.com/api/customers"), /站内接口/u);
assert.throws(() => normalizeAgentApiPath("/api/customers?scope=team"), /query/u);
assert.throws(() => normalizeAgentApiPath("/api/../accounts"), /格式无效/u);

assert.equal(assertAgentApiToolRisk("api.read", "GET", "/api/customers"), "read");
assert.equal(assertAgentApiToolRisk("api.write", "POST", "/api/customers"), "write");
assert.equal(assertAgentApiToolRisk("api.external", "POST", "/api/development-email/send"), "external");
assert.throws(() => assertAgentApiToolRisk("api.write", "POST", "/api/development-email/send"), /api.external/u);
assert.throws(() => assertAgentApiToolRisk("api.read", "POST", "/api/customers"), /api.write/u);

assert.equal(routeTemplateMatches("/api/customers/:id/activities", "/api/customers/c1/activities"), true);
assert.equal(routeTemplateMatches("/api/customers/{id}/activities", "/api/customers/c1/activities"), true);
assert.equal(routeTemplateMatches("/api/customers/:id", "/api/customers/c1/activities"), false);
assert.equal(routeTemplateMatches("/api/customers/:id", "/api/accounts/u1"), false);

assert.deepEqual(redactAgentApiData({ customer: { email: "buyer@example.com" }, apiKey: "secret", users: [{ email: "staff@example.com" }], nested: { password: "123" } }), {
  customer: { email: "buyer@example.com" },
  apiKey: "[已保护]",
  users: "[已保护]",
  nested: { password: "[已保护]" }
});

console.log(JSON.stringify({ ok: true, businessReadWriteAllowed: true, externalRiskEnforced: true, accountRoutesDenied: denied.length, routeForgeryBlocked: true, credentialRedaction: true }, null, 2));
