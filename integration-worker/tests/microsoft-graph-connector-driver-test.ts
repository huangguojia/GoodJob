import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { MicrosoftGraphConnectorDriver } from "../src/drivers/microsoft-graph-connector-driver.js";
import type { DriverRuntimeContext } from "../src/drivers/connector-driver.js";
import type { OAuthTransactionContext } from "../src/oauth/oauth-types.js";
import type { WorkerConnectorManifest } from "../src/repository.js";

let baseUrl = "";
let expectedChallenge = "";
let tokenRequests = 0;
let refreshRequests = 0;
let draftCounter = 0;
let subscriptionCounter = 0;
const called = new Set<string>();

const json = (response: import("node:http").ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
};

const jwt = () => [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ aud: "00000003-0000-0000-c000-000000000000", sub: "graph-user" })).toString("base64url"),
  "test-signature"
].join(".");

const bodyOf = async (request: import("node:http").IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", baseUrl || "http://127.0.0.1");
  if (url.pathname === "/oidc/.well-known/openid-configuration") {
    json(response, {
      issuer: `${baseUrl}/oidc`,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      userinfo_endpoint: `${baseUrl}/userinfo`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"]
    });
    return;
  }
  if (url.pathname === "/token" && request.method === "POST") {
    const body = new URLSearchParams(await bodyOf(request));
    assert.equal(body.has("resource"), false);
    if (body.get("grant_type") === "authorization_code") {
      tokenRequests += 1;
      assert.equal(createHash("sha256").update(body.get("code_verifier") || "").digest("base64url"), expectedChallenge);
      json(response, { access_token: jwt(), refresh_token: "graph-refresh", token_type: "Bearer", expires_in: 3600, scope: "Mail.Read Calendars.ReadWrite" });
      return;
    }
    if (body.get("grant_type") === "refresh_token") {
      refreshRequests += 1;
      json(response, { access_token: jwt(), token_type: "Bearer", expires_in: 3600, scope: "Mail.Read Calendars.ReadWrite" });
      return;
    }
  }
  if (url.pathname === "/userinfo") {
    json(response, { sub: "graph-user", name: "Graph User", email: "seller@example.test" });
    return;
  }
  if (url.pathname === "/v1.0/me" && request.method === "GET") {
    called.add("mail.list_accounts");
    json(response, { id: "graph-user", displayName: "Graph User", mail: "seller@example.test" });
    return;
  }
  if (url.pathname === "/v1.0/me/mailFolders/inbox/messages") {
    called.add("mail.search_messages");
    assert.equal(url.searchParams.get("$top"), "10");
    json(response, { value: [{ id: "msg-in-1", subject: "LED inquiry", receivedDateTime: "2026-08-07T01:00:00Z", bodyPreview: "Please quote", from: { emailAddress: { address: "buyer@example.test" } } }] });
    return;
  }
  if (url.pathname === "/v1.0/me/messages/msg-in-1" && request.method === "GET") {
    called.add("mail.get_message");
    json(response, { id: "msg-in-1", subject: "LED inquiry", body: { contentType: "text", content: "Please quote 1,000 units." } });
    return;
  }
  if (url.pathname === "/v1.0/me/messages" && request.method === "POST") {
    const body = JSON.parse(await bodyOf(request)) as Record<string, unknown>;
    assert.equal(body.subject, "Quotation");
    draftCounter += 1;
    json(response, { id: `draft-${draftCounter}`, isDraft: true, "@odata.etag": `W/\"draft-${draftCounter}\"` }, 201);
    return;
  }
  if (/^\/v1\.0\/me\/messages\/draft-\d+\/send$/u.test(url.pathname) && request.method === "POST") {
    called.add("mail.send_message");
    response.writeHead(202);
    response.end();
    return;
  }
  if (url.pathname === "/v1.0/me/calendarView") {
    called.add("calendar.list_events");
    json(response, { value: [{ id: "event-existing", subject: "Buyer call", start: { dateTime: "2026-08-08T02:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-08-08T02:30:00Z", timeZone: "UTC" } }] });
    return;
  }
  if (url.pathname === "/v1.0/me/calendar/getSchedule" && request.method === "POST") {
    called.add("calendar.get_availability");
    json(response, { value: [{ scheduleId: "buyer@example.test", availabilityView: "00", scheduleItems: [{ status: "busy", subject: "private title", start: { dateTime: "2026-08-08T02:00:00Z" }, end: { dateTime: "2026-08-08T02:30:00Z" } }] }] });
    return;
  }
  if (url.pathname === "/v1.0/me/events" && request.method === "POST") {
    called.add("calendar.create_event");
    const body = JSON.parse(await bodyOf(request)) as Record<string, unknown>;
    assert.ok(body.transactionId);
    json(response, { id: "event-1", "@odata.etag": "W/\"v1\"", webLink: "https://outlook.example.test/event-1", onlineMeeting: { joinUrl: "https://teams.example.test/meeting-1" } }, 201);
    return;
  }
  if (url.pathname === "/v1.0/me/events/event-1" && request.method === "PATCH") {
    called.add("calendar.update_event");
    assert.equal(request.headers["if-match"], "W/\"v1\"");
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/v1.0/me/events/event-1" && request.method === "GET") {
    json(response, { id: "event-1", subject: "Updated buyer call", changeKey: "v2", webLink: "https://outlook.example.test/event-1" });
    return;
  }
  if (url.pathname === "/v1.0/subscriptions" && request.method === "POST") {
    const body = JSON.parse(await bodyOf(request)) as Record<string, unknown>;
    assert.equal(body.resource, "me/mailFolders('Inbox')/messages");
    assert.equal(body.changeType, "created");
    assert.ok(body.clientState);
    subscriptionCounter += 1;
    json(response, {
      id: `subscription-${subscriptionCounter}`,
      resource: body.resource,
      changeType: body.changeType,
      expirationDateTime: "2026-08-09T01:00:00Z"
    }, 201);
    return;
  }
  if (/^\/v1\.0\/subscriptions\/subscription-\d+$/u.test(url.pathname) && request.method === "PATCH") {
    json(response, {
      id: url.pathname.split("/").pop(),
      resource: "me/mailFolders('Inbox')/messages",
      changeType: "created",
      expirationDateTime: "2026-08-10T01:00:00Z"
    });
    return;
  }
  if (/^\/v1\.0\/subscriptions\/subscription-\d+$/u.test(url.pathname) && request.method === "DELETE") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("fake Graph server failed");
baseUrl = `http://127.0.0.1:${address.port}`;

const manifest: WorkerConnectorManifest = {
  driver: "microsoft_graph",
  endpoint: `${baseUrl}/v1.0/`,
  approvedHosts: ["127.0.0.1"],
  allowedPorts: [address.port],
  allowInsecureLoopback: true,
  authentication: "oauth2",
  oauth: {
    profile: "fixed_oidc",
    clientId: "graph-test-client",
    scopes: ["openid", "offline_access", "Mail.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"],
    authorizationServerUrl: `${baseUrl}/oidc`,
    metadataUrl: `${baseUrl}/oidc/.well-known/openid-configuration`,
    acceptedAudiences: ["00000003-0000-0000-c000-000000000000"],
    useResourceParameter: false
  }
};

const driver = new MicrosoftGraphConnectorDriver();
const oauthContext: OAuthTransactionContext = {
  state: "graph-state-value",
  nonce: "graph-nonce-value",
  connectorCode: "microsoft-365",
  resourceUri: manifest.endpoint,
  requestedScopes: manifest.oauth!.scopes
};

try {
  const prepared = await driver.prepareAuthorization(manifest, oauthContext, "https://crm.example.test/api/integrations/oauth/callback/microsoft-365");
  const authorizationUrl = new URL(prepared.context.authorizationUrl!);
  expectedChallenge = authorizationUrl.searchParams.get("code_challenge") || "";
  assert.ok(expectedChallenge);
  assert.equal(authorizationUrl.searchParams.has("resource"), false);
  const exchanged = await driver.completeAuthorization(manifest, { ...prepared.context, authorizationCode: "graph-code" }, "https://crm.example.test/api/integrations/oauth/callback/microsoft-365");
  assert.equal(tokenRequests, 1);
  assert.equal((exchanged.accountSummary.account as Record<string, unknown>).email, "seller@example.test");
  await driver.refreshCredential(manifest, exchanged.credential);
  assert.equal(refreshRequests, 1);
  assert.equal((await driver.revokeCredential(manifest, exchanged.credential)).remoteRevocationSupported, false);

  const context: DriverRuntimeContext = {
    connectionId: "icx_graph_test",
    manifest,
    timeoutMs: 5_000,
    maxResponseBytes: 512 * 1024,
    accessToken: jwt(),
    tokenFingerprint: "test-token",
    requestId: "request-graph-test"
  };
  const discovery = await driver.discoverTools(context);
  assert.equal(discovery.tools.length, 9);
  assert.deepEqual(discovery.tools.map((tool) => tool.remoteName), [
    "mail.list_accounts", "mail.search_messages", "mail.get_message", "calendar.list_events",
    "calendar.get_availability", "mail.create_draft", "mail.send_message",
    "calendar.create_event", "calendar.update_event"
  ]);
  await driver.invokeTool(context, "mail.list_accounts", {});
  const search = await driver.invokeTool(context, "mail.search_messages", { query: "LED", folder: "inbox", pageSize: 10, offset: 0 });
  assert.equal((search.structuredContent as Record<string, unknown>).source, "microsoft-graph://me/inbox/messages");
  await driver.invokeTool(context, "mail.get_message", { messageId: "msg-in-1" });
  await driver.invokeTool(context, "calendar.list_events", { startUtc: "2026-08-08T00:00:00Z", endUtc: "2026-08-09T00:00:00Z", timeZone: "UTC" });
  const availability = await driver.invokeTool(context, "calendar.get_availability", { schedules: ["buyer@example.test"], startUtc: "2026-08-08T00:00:00Z", endUtc: "2026-08-09T00:00:00Z", timeZone: "UTC" });
  assert.equal(JSON.stringify(availability).includes("private title"), false);
  const draft = await driver.invokeTool(context, "mail.create_draft", { to: ["buyer@example.test"], subject: "Quotation", body: "Draft quotation" });
  called.add("mail.create_draft");
  assert.equal((draft.structuredContent as Record<string, unknown>).messageId, "draft-1");
  const sent = await driver.invokeTool(context, "mail.send_message", { to: ["buyer@example.test"], subject: "Quotation", body: "Final quotation" });
  assert.equal((sent.structuredContent as Record<string, unknown>).deliveryAccepted, true);
  const createdEvent = await driver.invokeTool(context, "calendar.create_event", { subject: "Buyer call", startUtc: "2026-08-08T02:00:00Z", endUtc: "2026-08-08T02:30:00Z", timeZone: "UTC", attendees: ["buyer@example.test"], onlineMeeting: true });
  assert.equal((createdEvent.structuredContent as Record<string, unknown>).eventId, "event-1");
  const updatedEvent = await driver.invokeTool(context, "calendar.update_event", { eventId: "event-1", etag: "W/\"v1\"", subject: "Updated buyer call" });
  assert.equal((updatedEvent.structuredContent as Record<string, unknown>).readAfterWriteMatch, true);
  const subscription = await driver.registerWebhook(context, {
    notificationUrl: "http://127.0.0.1:4188/api/integrations/webhooks/microsoft-365/iwp_test",
    clientState: "client-state-test",
    resource: "me/mailFolders('Inbox')/messages",
    changeTypes: "created"
  });
  assert.equal(subscription.id, "subscription-1");
  const renewed = await driver.renewWebhook(context, subscription.id);
  assert.equal(renewed.id, subscription.id);
  await driver.unregisterWebhook(context, subscription.id);
  assert.deepEqual([...called].sort(), discovery.tools.map((tool) => tool.remoteName).sort());
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(JSON.stringify({
  ok: true,
  fixedOidcPkce: true,
  fixedAudienceValidated: true,
  legacyResourceParameterOmitted: true,
  toolsDiscovered: 9,
  allToolsInvoked: true,
  mailPaginationBounded: true,
  messageIdBeforeSend: true,
  availabilityPrivateSubjectRemoved: true,
  calendarEtagRequired: true,
  calendarReadAfterWrite: true
  ,webhookRegisterRenewDelete: true
}, null, 2));
