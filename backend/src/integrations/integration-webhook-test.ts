import assert from "node:assert/strict";
import { createWebhookSignature, normalizeVerifiedWebhook } from "./integration-webhook.js";

const secret = "webhook-test-secret-with-at-least-32-characters";
const timestamp = 1_786_089_600;
const nonce = "nonce_stage5_000001";
const rawBody = Buffer.from(JSON.stringify({ id: "evt_001", type: "customer.updated", value: "ok" }));
const signatureHeader = createWebhookSignature(rawBody, secret, timestamp, nonce);
const generic = normalizeVerifiedWebhook({
  connectorCode: "example-api",
  body: JSON.parse(rawBody.toString("utf8")),
  rawBody,
  secret,
  signatureHeader,
  nonce,
  nowMs: timestamp * 1_000
});
assert.equal(generic.notifications[0]?.externalEventId, "evt_001");
assert.equal(generic.notifications[0]?.eventType, "customer.updated");

assert.throws(() => normalizeVerifiedWebhook({
  connectorCode: "example-api",
  body: JSON.parse(rawBody.toString("utf8")),
  rawBody: Buffer.from(rawBody.toString("utf8").replace("ok", "tampered")),
  secret,
  signatureHeader,
  nonce,
  nowMs: timestamp * 1_000
}), /签名校验失败/u);

assert.throws(() => normalizeVerifiedWebhook({
  connectorCode: "example-api",
  body: JSON.parse(rawBody.toString("utf8")),
  rawBody,
  secret,
  signatureHeader,
  nonce,
  nowMs: (timestamp + 301) * 1_000
}), /时间/u);

const microsoftBody = {
  value: [{
    subscriptionId: "sub_001",
    changeType: "created",
    resource: "me/messages/message_001",
    clientState: secret,
    resourceData: { id: "message_001", "@odata.type": "#microsoft.graph.message" }
  }]
};
const microsoftRaw = Buffer.from(JSON.stringify(microsoftBody));
const microsoft = normalizeVerifiedWebhook({
  connectorCode: "microsoft-365",
  body: microsoftBody,
  rawBody: microsoftRaw,
  secret
});
assert.equal(microsoft.notifications.length, 1);
assert.equal(microsoft.notifications[0]?.eventType, "microsoft.message.created");
assert.throws(() => normalizeVerifiedWebhook({
  connectorCode: "microsoft-365",
  body: { value: [{ ...microsoftBody.value[0], clientState: "wrong" }] },
  rawBody: microsoftRaw,
  secret
}), /clientState/u);

console.log(JSON.stringify({
  ok: true,
  hmacSignature: true,
  timestampWindow: true,
  tamperRejected: true,
  microsoftClientState: true,
  batchNormalization: true
}, null, 2));
