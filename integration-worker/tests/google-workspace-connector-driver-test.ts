import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runConnectorDriverComplianceSuite, type ConnectorManifest } from "@goodjob/integration-connector-sdk";
import { GoogleWorkspaceConnectorDriver, googleOfflineAuthorizationUrl } from "../src/drivers/google-workspace-connector-driver.js";
import type { DriverRuntimeContext } from "../src/drivers/connector-driver.js";

const requests: Array<{ method: string; url: URL; body: Record<string, unknown>; authorization: string }> = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  let body: Record<string, unknown> = {};
  try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {}; } catch { body = {}; }
  const authorization = String(request.headers.authorization || "");
  requests.push({ method: request.method || "GET", url, body, authorization });
  response.setHeader("content-type", "application/json");
  if (authorization === "Bearer expired-token") {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }));
    return;
  }
  if (url.pathname === "/gmail/v1/users/me/profile") {
    response.end(JSON.stringify({ emailAddress: "seller@example.test", messagesTotal: 18 }));
    return;
  }
  if (url.pathname === "/gmail/v1/users/me/messages" && request.method === "GET") {
    response.end(JSON.stringify({ messages: [{ id: "m1", threadId: "thread-1" }], nextPageToken: "next-page", resultSizeEstimate: 1 }));
    return;
  }
  if (url.pathname === "/gmail/v1/users/me/messages/m1") {
    const full = url.searchParams.get("format") === "full";
    response.end(JSON.stringify({
      id: "m1",
      threadId: "thread-1",
      internalDate: "1786000000000",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "LED quotation request",
      payload: {
        mimeType: full ? "multipart/alternative" : "text/plain",
        headers: [
          { name: "From", value: "Buyer <buyer@example.com>" },
          { name: "To", value: "seller@example.test" },
          { name: "Subject", value: "LED inquiry" },
          { name: "Date", value: "Thu, 06 Aug 2026 10:00:00 +0000" },
          { name: "Message-ID", value: "<mail-1@example.com>" }
        ],
        ...(full ? { parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Please quote 500 units.").toString("base64url") } }] } : {})
      }
    }));
    return;
  }
  if (url.pathname === "/gmail/v1/users/me/drafts" && request.method === "POST") {
    response.end(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1" } }));
    return;
  }
  if (url.pathname === "/gmail/v1/users/me/messages/send" && request.method === "POST") {
    response.end(JSON.stringify({ id: "sent-1", threadId: "thread-1", labelIds: ["SENT"] }));
    return;
  }
  if (url.pathname === "/calendar/v3/freeBusy" && request.method === "POST") {
    response.end(JSON.stringify({ calendars: { "buyer@example.com": { busy: [{ start: "2026-08-08T02:00:00Z", end: "2026-08-08T02:30:00Z" }] } } }));
    return;
  }
  if (url.pathname === "/calendar/v3/calendars/primary/events" && request.method === "GET") {
    response.end(JSON.stringify({ items: [{ id: "event-1", summary: "Buyer call", etag: "etag-1", start: { dateTime: "2026-08-08T02:00:00Z" }, end: { dateTime: "2026-08-08T02:30:00Z" }, htmlLink: "https://calendar.google.test/event-1" }], nextPageToken: "event-next" }));
    return;
  }
  if (url.pathname === "/calendar/v3/calendars/primary/events" && request.method === "POST") {
    response.end(JSON.stringify({ id: String(body.id || "event-created"), etag: "etag-created", htmlLink: "https://calendar.google.test/created", hangoutLink: "https://meet.google.test/abc" }));
    return;
  }
  if (/^\/calendar\/v3\/calendars\/primary\/events\/[^/]+$/u.test(url.pathname) && request.method === "PATCH") {
    response.end(JSON.stringify({ id: url.pathname.split("/").at(-1), etag: "etag-updated", htmlLink: "https://calendar.google.test/updated" }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: { status: "NOT_FOUND" } }));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("测试服务器启动失败");

const endpoint = `http://127.0.0.1:${address.port}/`;
const context: DriverRuntimeContext = {
  connectionId: "google-connection",
  manifest: {
    schemaVersion: "1.0",
    stage: "available",
    driver: "google_workspace",
    endpoint,
    approvedHosts: ["127.0.0.1", "accounts.google.test"],
    allowedPorts: [address.port, 443],
    allowInsecureLoopback: true,
    authentication: "oauth2",
    oauth: {
      profile: "fixed_oidc",
      clientId: "google-client",
      clientSecretEnv: "INTEGRATION_OAUTH_GOOGLE_TEST_SECRET",
      scopes: ["openid", "gmail.readonly"],
      authorizationServerUrl: "https://accounts.google.test/",
      metadataUrl: "https://accounts.google.test/.well-known/openid-configuration",
      acceptedAudiences: ["google-client"],
      useResourceParameter: false
    },
    maxTools: 9
  },
  timeoutMs: 2_000,
  maxResponseBytes: 2_000_000,
  accessToken: "google-access-token",
  requestId: "google-request-1"
};

const driver = new GoogleWorkspaceConnectorDriver();
const offlineAuthorization = new URL(googleOfflineAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=test"));
assert.equal(offlineAuthorization.searchParams.get("access_type"), "offline");
assert.equal(offlineAuthorization.searchParams.get("include_granted_scopes"), "true");
assert.equal(offlineAuthorization.searchParams.get("prompt"), "consent");
driver.validateConfiguration(context.manifest);
const discovery = await driver.discoverTools(context);
assert.equal(discovery.tools.length, 9);
assert.equal(discovery.serverName, "Google Workspace");

const account = await driver.invokeTool(context, "mail.list_accounts", {});
assert.equal((account.structuredContent?.account as Record<string, unknown>).email, "seller@example.test");

const searched = await driver.invokeTool(context, "mail.search_messages", { query: "LED", folder: "inbox", pageSize: 25 });
const messages = searched.structuredContent?.messages as Array<Record<string, unknown>>;
assert.equal(messages.length, 1);
assert.equal(messages[0]?.conversationId, "thread-1");
assert.equal(((messages[0]?.sender as Record<string, unknown>).emailAddress as Record<string, unknown>).address, "buyer@example.com");
assert.equal((searched.structuredContent?.page as Record<string, unknown>).nextPageToken, "next-page");

const full = await driver.invokeTool(context, "mail.get_message", { messageId: "m1" });
assert.equal((((full.structuredContent?.message as Record<string, unknown>).body as Record<string, unknown>).content), "Please quote 500 units.");

const events = await driver.invokeTool(context, "calendar.list_events", {
  startUtc: "2026-08-08T00:00:00Z", endUtc: "2026-08-09T00:00:00Z", timeZone: "Asia/Shanghai"
});
assert.equal((events.structuredContent?.events as unknown[]).length, 1);

const availability = await driver.invokeTool(context, "calendar.get_availability", {
  schedules: ["buyer@example.com"], startUtc: "2026-08-08T00:00:00Z", endUtc: "2026-08-09T00:00:00Z",
  timeZone: "Asia/Shanghai", intervalMinutes: 30
});
assert.equal((((availability.structuredContent?.availability as Array<Record<string, unknown>>)[0]?.busy) as unknown[]).length, 1);

const draft = await driver.invokeTool(context, "mail.create_draft", {
  to: ["buyer@example.com"], subject: "Quotation", body: "Attached quotation", bodyType: "text"
});
assert.equal(draft.structuredContent?.createdObjectId, "draft-1");

const sent = await driver.invokeTool(context, "mail.send_message", {
  to: ["buyer@example.com"], cc: [], subject: "Quotation", body: "Attached quotation", threadId: "thread-1",
  inReplyTo: "<mail-1@example.com>"
});
assert.equal(sent.structuredContent?.externalReceiptId, "sent-1");
assert.equal(sent.structuredContent?.deliveryAccepted, true);
const sendRequest = requests.find((item) => item.url.pathname.endsWith("/messages/send"));
assert.equal((sendRequest?.body as Record<string, unknown>).threadId, "thread-1");
assert.match(Buffer.from(String(sendRequest?.body.raw || ""), "base64url").toString("utf8"), /Subject: Quotation/u);
assert.match(Buffer.from(String(sendRequest?.body.raw || ""), "base64url").toString("utf8"), /In-Reply-To: <mail-1@example\.com>/u);

const created = await driver.invokeTool(context, "calendar.create_event", {
  subject: "Buyer call", startUtc: "2026-08-08T02:00:00Z", endUtc: "2026-08-08T02:30:00Z",
  timeZone: "Asia/Shanghai", attendees: ["buyer@example.com"], onlineMeeting: true
});
assert.ok(created.structuredContent?.createdObjectId);
assert.equal(created.structuredContent?.stateTransition, "missing->created");

const updated = await driver.invokeTool(context, "calendar.update_event", {
  eventId: "event-1", etag: "etag-1", subject: "Updated buyer call"
});
assert.equal(updated.structuredContent?.externalReceiptId, "event-1");
assert.equal(updated.structuredContent?.readAfterWriteMatch, true);
assert.equal(requests.find((item) => item.method === "PATCH")?.authorization, "Bearer google-access-token");

await assert.rejects(
  () => driver.invokeTool({ ...context, accessToken: "expired-token" }, "mail.list_accounts", {}),
  /INTEGRATION_REAUTH_REQUIRED/u
);
await assert.rejects(
  () => driver.invokeTool(context, "calendar.update_event", { eventId: "event-1", etag: "etag-1" }),
  /至少填写一个会议变更字段/u
);
await assert.rejects(
  () => driver.invokeTool(context, "unknown.tool", {}),
  /INTEGRATION_TOOL_NOT_APPROVED/u
);

const compliance = await runConnectorDriverComplianceSuite({
  driver,
  validManifest: context.manifest,
  invalidManifest: { ...context.manifest, endpoint: "https://unapproved.example.test/" } as ConnectorManifest,
  context,
  knownToolName: "mail.list_accounts",
  knownToolInput: {},
  maxTools: 9,
  getToolNames: (value) => value.tools.map((tool) => tool.remoteName),
  validateKnownResult(value) {
    assert.equal((value.structuredContent?.account as Record<string, unknown>).email, "seller@example.test");
  },
  isUnknownToolDenied: (error) => /INTEGRATION_TOOL_NOT_APPROVED/u.test(error instanceof Error ? error.message : String(error))
});
assert.equal(compliance.driverType, "google_workspace");
assert.equal(compliance.connectionClosed, true);

await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log("Google Workspace official connector driver tests passed");
