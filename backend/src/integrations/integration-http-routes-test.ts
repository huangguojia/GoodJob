import assert from "node:assert/strict";
import express from "express";
import { signToken } from "../auth.js";
import { getStore } from "../store.js";
import { createOpenApiDocument } from "../swagger.js";
import type { SessionUser } from "../types.js";
import { integrationHttpRouter } from "./integration-http-routes.js";
import { setIntegrationControlPlaneService } from "./integration-runtime.js";
import type { IntegrationControlPlaneService } from "./integration-service.js";

function sessionUser(role: SessionUser["role"], id: string, teamId: string): SessionUser {
  return { id, role, teamId, name: id, email: `${id}@example.com`, avatar: id[0], authVersion: 1 };
}

const adminA = sessionUser("admin", "http_admin_a", "http_team_a");
const salesA = sessionUser("sales", "http_sales_a", "http_team_a");
const store = getStore();
for (const user of [adminA, salesA]) {
  if (!store.users.some((candidate) => candidate.id === user.id)) {
    store.users.push({ ...user, password: "unused", status: "active" });
  }
}

const app = express();
app.use(express.json());
app.use("/api/integrations", integrationHttpRouter);
const openApi = createOpenApiDocument(app) as {
  paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> }; responses?: Record<string, unknown> }>>;
};
assert.ok(openApi.paths["/api/integrations/catalog"]?.get);
assert.equal(
  openApi.paths["/api/integrations/connectors/private"]?.post?.requestBody?.content?.["application/json"]?.schema?.additionalProperties,
  false
);
assert.ok(openApi.paths["/api/integrations/connectors/private"]?.post?.responses?.["202"]);
assert.ok(openApi.paths["/api/integrations/connectors/reviews"]?.get);
assert.ok(openApi.paths["/api/integrations/connectors/{id}/review"]?.post);
assert.equal(
  openApi.paths["/api/integrations/connections"]?.post?.requestBody?.content?.["application/json"]?.schema?.additionalProperties,
  false
);
assert.ok(openApi.paths["/api/integrations/connections"]?.post?.responses?.["202"]);
assert.ok(openApi.paths["/api/integrations/connections"]?.post?.responses?.["503"]);
assert.ok(openApi.paths["/api/integrations/approvals/{id}/approve"]?.post?.responses?.["202"]);
assert.ok(openApi.paths["/api/integrations/calls/{id}/reconcile"]?.post);
assert.equal(
  openApi.paths["/api/integrations/events/{id}/link-customer"]?.post?.requestBody?.content?.["application/json"]?.schema?.additionalProperties,
  false
);
assert.ok(openApi.paths["/api/integrations/microsoft/mail/messages"]?.get);
assert.ok(openApi.paths["/api/integrations/microsoft/mail/send"]?.post?.responses?.["202"]);
assert.ok(openApi.paths["/api/integrations/microsoft/calendar/events"]?.post?.responses?.["202"]);
assert.ok(openApi.paths["/api/integrations/microsoft/business-calls/{id}"]?.get);
assert.ok(openApi.paths["/api/integrations/google/mail/messages"]?.get);
assert.ok(openApi.paths["/api/integrations/google/mail/send"]?.post?.responses?.["202"]);
assert.ok(openApi.paths["/api/integrations/google/calendar/events"]?.post?.responses?.["202"]);
assert.ok(openApi.paths["/api/integrations/google/business-calls/{id}"]?.get);
assert.ok(openApi.paths["/api/integrations/webhooks/{connectorCode}/{connectionPublicId}"]?.post?.responses?.["202"]);
assert.ok(openApi.paths["/api/integrations/usage"]?.get);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const address = server.address();
if (!address || typeof address === "string") throw new Error("integration HTTP test server failed to start");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, actor?: SessionUser, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(actor ? { authorization: `Bearer ${signToken(actor)}` } : {}),
      ...(options.headers || {})
    }
  });
  return { response, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

const fakeService = {
  oauthSuccessRedirectUrl: "",
  async catalog(actor: SessionUser) {
    assert.equal(actor.id, adminA.id);
    return [{ id: "icn_fake", name: "Fake MCP" }];
  },
  async approveTool(actor: SessionUser) {
    if (actor.role === "sales") {
      throw Object.assign(new Error("当前角色无权限审核工具"), {
        code: "INTEGRATION_PERMISSION_DENIED",
        status: 403
      });
    }
    return { id: "tool_a", status: "active" };
  },
  async connection(_actor: SessionUser, id: string) {
    if (id === "foreign_connection") {
      throw Object.assign(new Error("连接不存在或无权访问"), {
        code: "INTEGRATION_CONNECTION_NOT_FOUND",
        status: 404
      });
    }
    return { id };
  },
  async linkWebhookEventCustomer(actor: SessionUser, id: string, customerId: string) {
    assert.equal(actor.id, salesA.id);
    assert.equal(id, "event_needs_match");
    assert.equal(customerId, "customer_a");
    return { id, status: "processed", writebackStatus: "completed", linkedObjectId: customerId };
  },
  async dailyUsage(actor: SessionUser, usageDate: string) {
    assert.equal(actor.id, salesA.id);
    assert.equal(usageDate, "2026-08-07");
    return [{ usageDate, teamId: actor.teamId, connectionId: "icx_usage", toolSnapshotId: "its_usage", callCount: 2 }];
  },
  async receiveOAuthCallback(connectorCode: string, input: { state: string; code?: string }) {
    assert.equal(connectorCode, "fake-oauth-mcp");
    assert.equal(input.code, "test-code");
    return { transactionId: "iat_callback", connectionId: "icx_callback" };
  },
  async validateWebhookEndpoint(connectorCode: string, publicId: string) {
    assert.equal(connectorCode, "microsoft-365");
    if (publicId !== `iwp_${"a".repeat(32)}`) {
      throw Object.assign(new Error("Webhook 入口不存在或连接不可用"), { code: "INTEGRATION_WEBHOOK_NOT_FOUND", status: 404 });
    }
    return { connectionId: "icx_webhook" };
  },
  async receiveWebhook(input: { connectorCode: string; webhookPublicId: string; rawBody: Buffer }) {
    assert.equal(input.connectorCode, "microsoft-365");
    assert.equal(input.webhookPublicId, `iwp_${"a".repeat(32)}`);
    assert.ok(input.rawBody.length > 0);
    return { accepted: 1, duplicateCount: 0, events: [{ eventId: "iev_http", duplicate: false }] };
  }
} as unknown as IntegrationControlPlaneService;

try {
  setIntegrationControlPlaneService(null);
  const anonymous = await request("/api/integrations/catalog");
  assert.equal(anonymous.response.status, 401);

  const disabled = await request("/api/integrations/catalog", adminA);
  assert.equal(disabled.response.status, 503);
  assert.equal(disabled.body.errorCode, "INTEGRATION_DISABLED");

  setIntegrationControlPlaneService(fakeService);
  const callbackResponse = await fetch(`${baseUrl}/api/integrations/oauth/callback/fake-oauth-mcp?state=${"a".repeat(43)}&code=test-code`);
  assert.equal(callbackResponse.status, 202);
  assert.match(await callbackResponse.text(), /授权已接收/u);
  assert.equal(callbackResponse.headers.get("x-frame-options"), "DENY");
  const webhookValidation = await fetch(`${baseUrl}/api/integrations/webhooks/microsoft-365/iwp_${"a".repeat(32)}?validationToken=graph-validation-token`);
  assert.equal(webhookValidation.status, 200);
  assert.equal(await webhookValidation.text(), "graph-validation-token");
  const webhookNotification = await request(`/api/integrations/webhooks/microsoft-365/iwp_${"a".repeat(32)}`, undefined, {
    method: "POST",
    body: JSON.stringify({ value: [{ id: "notification_001" }] })
  });
  assert.equal(webhookNotification.response.status, 202);
  assert.equal(webhookNotification.body.received, true);
  const hiddenWebhook = await fetch(`${baseUrl}/api/integrations/webhooks/microsoft-365/iwp_${"b".repeat(32)}?validationToken=token`);
  assert.equal(hiddenWebhook.status, 404);
  const catalog = await request("/api/integrations/catalog", adminA, {
    headers: { "x-request-id": "request_stage1_http" }
  });
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.body.requestId, "request_stage1_http");
  assert.ok(Array.isArray(catalog.body.data));
  assert.deepEqual(catalog.body.uiAction, { type: "refresh", view: "integration-center" });

  const salesReview = await request("/api/integrations/tools/tool_a/approve", salesA, {
    method: "POST",
    body: JSON.stringify({
      stableAlias: "company.lookup",
      riskLevel: 1,
      permissionCode: "company.read",
      fieldAllowlist: ["query"],
      dailyCallLimit: 100
    })
  });
  assert.equal(salesReview.response.status, 403);
  assert.equal(salesReview.body.errorCode, "INTEGRATION_PERMISSION_DENIED");

  const crossTeam = await request("/api/integrations/connections/foreign_connection", salesA);
  assert.equal(crossTeam.response.status, 404);
  assert.equal(crossTeam.body.errorCode, "INTEGRATION_CONNECTION_NOT_FOUND");

  const invalid = await request("/api/integrations/connections", adminA, {
    method: "POST",
    body: JSON.stringify({ connectorId: "icn_fake", scope: "team", unexpected: true })
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.errorCode, "INTEGRATION_INPUT_INVALID");

  const invalidMail = await request("/api/integrations/microsoft/mail/send", salesA, {
    method: "POST",
    body: JSON.stringify({ customerId: "customer_a", to: ["not-an-email"], subject: "Test", body: "Body" })
  });
  assert.equal(invalidMail.response.status, 400);
  assert.equal(invalidMail.body.errorCode, "INTEGRATION_INPUT_INVALID");
  const invalidGoogleMail = await request("/api/integrations/google/mail/send", salesA, {
    method: "POST",
    body: JSON.stringify({ customerId: "customer_a", to: ["not-an-email"], subject: "Test", body: "Body" })
  });
  assert.equal(invalidGoogleMail.response.status, 400);
  assert.equal(invalidGoogleMail.body.errorCode, "INTEGRATION_INPUT_INVALID");

  const linkedEvent = await request("/api/integrations/events/event_needs_match/link-customer", salesA, {
    method: "POST",
    body: JSON.stringify({ customerId: "customer_a" })
  });
  assert.equal(linkedEvent.response.status, 200);
  assert.equal((linkedEvent.body.data as Record<string, unknown>).writebackStatus, "completed");
  const usage = await request("/api/integrations/usage?date=2026-08-07", salesA);
  assert.equal(usage.response.status, 200);
  assert.equal((usage.body.data as Array<Record<string, unknown>>)[0]?.callCount, 2);
} finally {
  setIntegrationControlPlaneService(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(JSON.stringify({
  ok: true,
  anonymousRejected: true,
  oauthCallbackPublicAndFrameBlocked: true,
  webhookPublicAndVerified: true,
  invalidWebhookHidden: true,
  disabledReturns503: true,
  salesReviewRejected: true,
  crossTeamHidden: true,
  invalidInputReturns400: true,
  swaggerContractsPublished: true,
  microsoftBusinessEndpointsDocumented: true,
  googleWorkspaceBusinessEndpointsDocumented: true,
  webhookManualLinkDocumentedAndMapped: true,
  dailyUsageDocumentedAndMapped: true,
  microsoftMailSchemaStrict: true,
  googleMailSchemaStrict: true,
  responseContractStable: true
}, null, 2));
