import assert from "node:assert/strict";
import { app, setOutboundEmailDispatchObserverForTest } from "./server.js";
import { getStore } from "./store.js";
import {
  decryptMailCredential,
  encryptMailCredential,
  isEncryptedMailCredential
} from "./credential-security.js";
import { classifyInboundReply, InboundMailWatcher } from "./inbound-mail-watcher.js";
import type { OutboundEmailLog } from "./types.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start email delivery test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const json = await response.json();
  return { response, json };
}

const store = getStore();
const owner = store.users.find((item) => item.email === "shirley@goodjob.com");
assert.ok(owner);
const userSnapshot = structuredClone(owner);
const logsSnapshot = structuredClone(store.outboundEmailLogs);
const touchpointsSnapshot = structuredClone(store.prospectTouchpoints);
const leadActivitiesSnapshot = structuredClone(store.leadActivities);
const internalMessagesSnapshot = structuredClone(store.internalMessages);
const todosSnapshot = structuredClone(store.todos);
let dispatchCount = 0;
const originalDomainLimit = process.env.OUTBOUND_EMAIL_DOMAIN_WINDOW_LIMIT;

try {
  const credentialContext = { id: owner.id, teamId: owner.teamId, kind: "smtp" as const };
  const encrypted = encryptMailCredential(credentialContext, "mail-app-password-123");
  assert.equal(isEncryptedMailCredential(encrypted), true);
  assert.equal(encrypted.includes("mail-app-password-123"), false);
  assert.equal(decryptMailCredential(credentialContext, encrypted), "mail-app-password-123");
  assert.equal(decryptMailCredential(credentialContext, "legacy-plain-password"), "legacy-plain-password");

  owner.outboundEmail = "shirley@example.test";
  owner.emailSenderName = "Shirley";
  owner.smtpHost = "smtp.example.test";
  owner.smtpPort = 465;
  owner.smtpSecure = true;
  owner.smtpUser = "shirley@example.test";
  owner.smtpPassword = "test-app-password";

  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: owner.email, password: "goodjob123" })
  });
  assert.equal(login.response.ok, true);
  const token = String(login.json.token || "");
  const headers = { authorization: `Bearer ${token}` };
  const payload = {
    to: "buyer@example.test",
    company: "Example Buyer",
    subject: "Industrial components",
    body: "This is a controlled idempotent development email test.",
    requestId: "email-delivery-idempotency-test"
  };

  setOutboundEmailDispatchObserverForTest(() => { dispatchCount += 1; });
  const first = await request("/api/profile/send-development-email", {
    method: "POST", headers, body: JSON.stringify(payload)
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.sent.replayed, false);

  const replay = await request("/api/profile/send-development-email", {
    method: "POST", headers, body: JSON.stringify(payload)
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.sent.replayed, true);
  assert.equal(dispatchCount, 1, "same requestId must cross SMTP boundary only once");

  const conflict = await request("/api/profile/send-development-email", {
    method: "POST", headers, body: JSON.stringify({ ...payload, subject: "Changed subject" })
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.json.errorCode, "OUTBOUND_EMAIL_IDEMPOTENCY_CONFLICT");

  process.env.OUTBOUND_EMAIL_DOMAIN_WINDOW_LIMIT = "1";
  const throttled = await request("/api/profile/send-development-email", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, requestId: "email-delivery-domain-throttle-test" })
  });
  assert.equal(throttled.response.status, 400);
  assert.match(String(throttled.json.message || ""), /发信保护/u);
  assert.equal(dispatchCount, 1, "risk policy must block before SMTP boundary");
  if (originalDomainLimit === undefined) delete process.env.OUTBOUND_EMAIL_DOMAIN_WINDOW_LIMIT;
  else process.env.OUTBOUND_EMAIL_DOMAIN_WINDOW_LIMIT = originalDomainLimit;

  setOutboundEmailDispatchObserverForTest(() => {
    dispatchCount += 1;
    throw new Error("simulated uncertain SMTP boundary");
  });
  const uncertainPayload = { ...payload, requestId: "email-delivery-uncertain-test" };
  const uncertain = await request("/api/profile/send-development-email", {
    method: "POST", headers, body: JSON.stringify(uncertainPayload)
  });
  assert.equal(uncertain.response.status, 400);
  const uncertainReplay = await request("/api/profile/send-development-email", {
    method: "POST", headers, body: JSON.stringify(uncertainPayload)
  });
  assert.equal(uncertainReplay.response.status, 409);
  assert.equal(uncertainReplay.json.errorCode, "OUTBOUND_EMAIL_DISPATCH_UNCERTAIN");
  assert.equal(dispatchCount, 2, "uncertain result must not be dispatched again");

  const sentLog = store.outboundEmailLogs.find((item) => item.requestId === payload.requestId);
  assert.ok(sentLog);
  assert.equal(sentLog.dispatchStatus, "sent");
  assert.ok(store.prospectTouchpoints.some((item) =>
    item.ownerId === owner.id && item.messageId === sentLog.messageId && item.eventType === "send"
  ));

  const foreignOwner = store.users.find((item) => item.id !== owner.id && item.teamId !== owner.teamId)
    || store.users.find((item) => item.id !== owner.id);
  assert.ok(foreignOwner);
  const foreignLog: OutboundEmailLog = {
    id: "oel_foreign_email_delivery_test",
    teamId: foreignOwner.teamId,
    ownerId: foreignOwner.id,
    messageId: "foreign-email-delivery-test@example.test",
    entityType: "unknown",
    entityId: "",
    to: "foreign@example.test",
    subject: "Foreign private email",
    source: "test",
    sentAt: new Date().toISOString(),
    dispatchStatus: "sent",
    createdAt: new Date().toISOString()
  };
  store.outboundEmailLogs.unshift(foreignLog);
  const list = await request("/api/outbound-emails", { headers });
  assert.equal(list.response.status, 200);
  assert.equal(list.json.logs.some((item: OutboundEmailLog) => item.id === foreignLog.id), false);

  const parsed = (subject: string, text: string) => ({ subject, text, headers: new Map() }) as never;
  assert.equal(classifyInboundReply(parsed("Re: hello", "Thanks, I will review it.")), "auto_unknown");
  assert.equal(classifyInboundReply(parsed("Re: hello", "Please contact my purchasing colleague.")), "referral");
  assert.equal(classifyInboundReply(parsed("Re: hello", "We have no current demand, try next quarter.")), "no_current_demand");
  assert.equal(classifyInboundReply(parsed("Quotation", "Please send your price list and MOQ.")), "clear_demand");

  const ownedLead = store.leads.find((item) => item.ownerId === owner.id && !item.deletedAt);
  assert.ok(ownedLead);
  const replyLog: OutboundEmailLog = {
    id: "oel_inbound_reply_test",
    teamId: owner.teamId,
    ownerId: owner.id,
    messageId: "outbound-reply-test@example.test",
    entityType: "lead",
    entityId: ownedLead.id,
    to: "buyer-reply@example.test",
    subject: "Initial quotation",
    source: "test",
    requestId: "inbound-reply-ledger-test",
    payloadHash: "test",
    dispatchStatus: "sent",
    sentAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  store.outboundEmailLogs.unshift(replyLog);
  const watcher = new InboundMailWatcher(store);
  const rawReply = [
    "From: Buyer <buyer-reply@example.test>",
    "To: Shirley <shirley@example.test>",
    "Message-ID: <reply-inbound-test@example.test>",
    "In-Reply-To: <outbound-reply-test@example.test>",
    "References: <outbound-reply-test@example.test>",
    "Subject: Re: Initial quotation",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please send your price list and MOQ."
  ].join("\r\n");
  assert.equal(await watcher.applyMessage(owner, rawReply), "reply");
  assert.equal(await watcher.applyMessage(owner, rawReply), "duplicate");
  assert.ok(store.prospectTouchpoints.some((item) =>
    item.messageId === "outbound-reply-test@example.test"
    && item.leadId === ownedLead.id
    && item.replyClassification === "clear_demand"
  ));
  assert.ok(store.internalMessages.some((item) =>
    item.recipientId === owner.id
    && item.idempotencyKey === "email-return:reply-inbound-test@example.test"
    && item.relatedType === "email_return"
    && item.relatedId === replyLog.messageId
  ));

  console.log("Email delivery security tests passed");
} finally {
  setOutboundEmailDispatchObserverForTest(null);
  if (originalDomainLimit === undefined) delete process.env.OUTBOUND_EMAIL_DOMAIN_WINDOW_LIMIT;
  else process.env.OUTBOUND_EMAIL_DOMAIN_WINDOW_LIMIT = originalDomainLimit;
  Object.assign(owner, userSnapshot);
  store.outboundEmailLogs.splice(0, store.outboundEmailLogs.length, ...logsSnapshot);
  store.prospectTouchpoints.splice(0, store.prospectTouchpoints.length, ...touchpointsSnapshot);
  store.leadActivities.splice(0, store.leadActivities.length, ...leadActivitiesSnapshot);
  store.internalMessages.splice(0, store.internalMessages.length, ...internalMessagesSnapshot);
  store.todos.splice(0, store.todos.length, ...todosSnapshot);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
