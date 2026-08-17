import assert from "node:assert/strict";
import { createIntegrationClient } from "./integration-api.js";

const requests: Array<{ path: string; init?: RequestInit }> = [];
const client = createIntegrationClient(async <T>(path: string, init?: RequestInit) => {
  requests.push({ path, init });
  if (path.startsWith("/api/wecom-command/endpoints")) return { endpoints: [] } as T;
  if (path.startsWith("/api/wecom-command/bindings")) return { bindings: [] } as T;
  if (path === "/api/accounts") return { accounts: [] } as T;
  return { requestId: "request_frontend_test", data: path.endsWith("/catalog") ? [{ id: "catalog_a" }] : [] } as T;
});

const catalog = await client.catalog();
assert.deepEqual(catalog, [{ id: "catalog_a" }]);
await client.connections();
await client.localRunners();
await client.createLocalRunnerPairing("Mac Studio");
await client.localRunnerTasks();
await client.createLocalRunnerTask({ runnerId: "runner_a", prompt: "Inspect CRM", workspace: "/workspace", executionMode: "read_only", timeoutSeconds: 600 });
await client.localRunnerTask("task_a");
await client.cancelLocalRunnerTask("task_a");
await client.connectorReviews("pending");
await client.createPrivateConnector({
  name: "Team MCP",
  code: "team-mcp",
  version: "1.0.0",
  description: "private connector",
  manifest: {
    schemaVersion: "1.0", stage: "available", driver: "native_mcp",
    endpoint: "https://mcp.example.test/mcp", approvedHosts: ["mcp.example.test"],
    allowedPorts: [443], authentication: "none", maxTools: 20
  }
});
await client.reviewPrivateConnector("icn_private", "approved", "checked");
await client.tools();
await client.calls();
await client.usage("2026-08-07");
await client.createConnection({ connectorId: "icn_a", scope: "team", displayName: "Team MCP" });
await client.startAuthorization("icx_a");
await client.authTransaction("iat_a");
await client.confirmAuthorization("icx_a", "iat_a");
await client.reauthorizeConnection("icx_a");
await client.approveTool("tool_a", {
  stableAlias: "company.lookup",
  riskLevel: 1,
  permissionCode: "company.read",
  fieldAllowlist: ["query"],
  dailyCallLimit: 100,
  allowedDataClasses: ["public", "business"],
  approvalPolicy: "risk_based",
  completionEvidence: []
});
await client.approvals();
await client.approveExecution("approval_a");
await client.rejectExecution("approval_b", "not approved");
await client.reconcileCall("call_a", { outcome: "succeeded", note: "checked", externalReceipt: "receipt_a" });
await client.searchMicrosoftMail({ query: "LED inquiry", folder: "inbox", pageSize: 25, offset: 0 });
await client.microsoftMessage("message_a");
await client.sendMicrosoftMail({ customerId: "customer_a", to: ["buyer@example.test"], subject: "Quotation", body: "Quotation body" });
await client.createMicrosoftEvent({ customerId: "customer_a", subject: "Buyer call", startUtc: "2026-08-08T02:00:00Z", endUtc: "2026-08-08T02:30:00Z", timeZone: "Asia/Shanghai", attendees: ["buyer@example.test"] });
await client.searchGoogleMail({ query: "LED inquiry", folder: "inbox", pageSize: 25 });
await client.googleMessage("gmail_message_a");
await client.sendGoogleMail({ customerId: "customer_a", to: ["buyer@example.test"], subject: "Quotation", body: "Quotation body", conversationId: "gmail_thread_a", inReplyTo: "<gmail_message_a@example.test>" });
await client.createGoogleEvent({ customerId: "customer_a", subject: "Buyer call", startUtc: "2026-08-08T02:00:00Z", endUtc: "2026-08-08T02:30:00Z", timeZone: "Asia/Shanghai", attendees: ["buyer@example.test"] });
await client.events("dead_letter");
await client.replayEvent("event_a");
await client.linkEventCustomer("event_a", "customer_a");
await client.wecomEndpoints();
await client.createWecomEndpoint({ connectionId: "wecom_connection_a", corpId: "ww_corp_a", callbackToken: "token_a", encodingAesKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" });
await client.disableWecomEndpoint("endpoint_a");
await client.wecomBindings();
await client.createWecomBinding({ connectionId: "wecom_connection_a", wecomUserId: "zhangsan", crmUserId: "u_sales_a" });
await client.revokeWecomBinding("binding_a");
await client.accounts();

assert.deepEqual(requests.slice(0, 2).map((request) => request.path), [
  "/api/integrations/catalog",
  "/api/integrations/connections"
]);
assert.ok(requests.some((request) => request.path === "/api/integrations/connectors/reviews?status=pending"));
assert.ok(requests.some((request) => request.path === "/api/integrations/local-runners/pairings"
  && JSON.parse(String(request.init?.body)).deviceName === "Mac Studio"));
assert.ok(requests.some((request) => request.path === "/api/integrations/local-runner-tasks" && request.init?.method === "POST"
  && JSON.parse(String(request.init?.body)).executionMode === "read_only"));
assert.ok(requests.some((request) => request.path === "/api/integrations/local-runner-tasks/task_a/cancel"));
assert.ok(requests.some((request) => request.path === "/api/integrations/connectors/private"
  && JSON.parse(String(request.init?.body)).manifest.endpoint === "https://mcp.example.test/mcp"));
assert.ok(requests.some((request) => request.path === "/api/integrations/connectors/icn_private/review"
  && JSON.parse(String(request.init?.body)).decision === "approved"));
assert.ok(requests.some((request) => request.path.startsWith("/api/integrations/google/mail/messages?")));
assert.ok(requests.some((request) => request.path === "/api/integrations/google/mail/send"
  && JSON.parse(String(request.init?.body)).conversationId === "gmail_thread_a"
  && JSON.parse(String(request.init?.body)).inReplyTo === "<gmail_message_a@example.test>"));
assert.ok(requests.some((request) => request.path === "/api/integrations/google/calendar/events" && request.init?.method === "POST"));
const usageRequest = requests.find((request) => request.path === "/api/integrations/usage?date=2026-08-07");
assert.ok(usageRequest);
const createConnectionRequest = requests.find((request) => request.path === "/api/integrations/connections" && request.init?.method === "POST");
assert.deepEqual(JSON.parse(String(createConnectionRequest?.init?.body)), {
  connectorId: "icn_a",
  scope: "team",
  displayName: "Team MCP"
});
assert.ok(requests.some((request) => request.path === "/api/integrations/connections/icx_a/auth/start"));
assert.ok(requests.some((request) => request.path === "/api/integrations/auth/transactions/iat_a"));
assert.ok(requests.some((request) => request.path === "/api/integrations/connections/icx_a/confirm"
  && JSON.parse(String(request.init?.body)).transactionId === "iat_a"));
assert.ok(requests.some((request) => request.path === "/api/integrations/connections/icx_a/reauthorize"));
assert.ok(requests.some((request) => request.path === "/api/integrations/approvals"));
assert.ok(requests.some((request) => request.path === "/api/integrations/approvals/approval_a/approve"));
assert.ok(requests.some((request) => request.path === "/api/integrations/calls/call_a/reconcile"));
assert.ok(requests.some((request) => request.path.startsWith("/api/integrations/microsoft/mail/messages?query=LED+inquiry")));
assert.ok(requests.some((request) => request.path === "/api/integrations/microsoft/mail/send"));
assert.ok(requests.some((request) => request.path === "/api/integrations/microsoft/calendar/events"));
assert.ok(requests.some((request) => request.path === "/api/integrations/events/event_a/link-customer"
  && JSON.parse(String(request.init?.body)).customerId === "customer_a"));
assert.ok(requests.some((request) => request.path === "/api/wecom-command/endpoints" && request.init?.method === "POST"
  && JSON.parse(String(request.init?.body)).encodingAesKey.length === 43));
assert.ok(requests.some((request) => request.path === "/api/wecom-command/endpoints/endpoint_a/disable"));
assert.ok(requests.some((request) => request.path === "/api/wecom-command/bindings" && request.init?.method === "POST"
  && JSON.parse(String(request.init?.body)).wecomUserId === "zhangsan"));
assert.ok(requests.some((request) => request.path === "/api/wecom-command/bindings/binding_a" && request.init?.method === "DELETE"));
assert.ok(requests.some((request) => request.path === "/api/accounts"));
assert.ok(!Object.keys(client).some((name) => name === "callArbitraryTool"));

console.log(JSON.stringify({
  ok: true,
  envelopeUnwrapped: true,
  privateConnectorReviewEndpointsMapped: true,
  lifecycleEndpointsMapped: true,
  microsoftBusinessEndpointsMapped: true,
  googleWorkspaceBusinessEndpointsMapped: true,
  webhookEventEndpointsMapped: true,
  wecomCommandEndpointsMapped: true,
  arbitraryToolCallNotExposed: true
}, null, 2));
