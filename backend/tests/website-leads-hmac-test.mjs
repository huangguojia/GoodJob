import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";

const currentSecret = "website-test-secret-with-at-least-32-characters";
const { setWebsiteLeadIngressSettingsForTest } = await import("../dist/website-lead-ingress-settings.js");
setWebsiteLeadIngressSettingsForTest({
  schemaVersion: 1,
  enabled: true,
  ownerId: "u_sales_shirley",
  current: { id: "website-test-v1", secret: currentSecret },
  previous: null
});

const { app } = await import("../dist/server.js");
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start website lead test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

function signedHeaders(body, overrides = {}) {
  const keyId = overrides.keyId || "website-test-v1";
  const timestamp = overrides.timestamp || String(Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce || randomBytes(18).toString("base64url");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = ["v1", keyId, "POST", "/api/website-leads", timestamp, nonce, bodyHash].join("\n");
  const signature = createHmac("sha256", overrides.secret || currentSecret).update(canonical).digest("hex");
  return {
    "content-type": "application/json",
    "x-goodjob-key-id": keyId,
    "x-goodjob-timestamp": timestamp,
    "x-goodjob-nonce": nonce,
    "x-goodjob-signature": `v1=${signature}`
  };
}

const body = JSON.stringify({
  company: "Website HMAC Test GmbH",
  contact: "Test Buyer",
  email: "buyer@example.com",
  inquiryContent: "Please send technical data and a quotation.",
  sourceType: "outbound",
  sourceChannel: "spoofed-channel",
  externalId: `website-hmac-${Date.now()}`
});

try {
  const unsigned = await fetch(`${baseUrl}/api/website-leads`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(unsigned.status, 401);

  const wrongSecret = await fetch(`${baseUrl}/api/website-leads`, { method: "POST", headers: signedHeaders(body, { secret: "wrong-secret-with-at-least-32-characters" }), body });
  assert.equal(wrongSecret.status, 401);

  const expired = await fetch(`${baseUrl}/api/website-leads`, {
    method: "POST",
    headers: signedHeaders(body, { timestamp: String(Math.floor(Date.now() / 1000) - 600) }),
    body
  });
  assert.equal(expired.status, 401);

  const nonce = randomBytes(18).toString("base64url");
  const headers = signedHeaders(body, { nonce });
  const accepted = await fetch(`${baseUrl}/api/website-leads`, { method: "POST", headers, body });
  assert.equal(accepted.status, 201);
  const acceptedJson = await accepted.json();
  assert.equal(acceptedJson.received, true);
  assert.equal(acceptedJson.duplicate, false);
  assert.match(String(acceptedJson.leadId), /^lead_/u);

  const replay = await fetch(`${baseUrl}/api/website-leads`, { method: "POST", headers, body });
  assert.equal(replay.status, 409);

  const duplicate = await fetch(`${baseUrl}/api/website-leads`, { method: "POST", headers: signedHeaders(body), body });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const oldSecret = currentSecret;
  setWebsiteLeadIngressSettingsForTest({
    schemaVersion: 1,
    enabled: true,
    ownerId: "u_sales_shirley",
    current: { id: "website-test-v2", secret: "website-test-v2-secret-with-at-least-32-characters" },
    previous: { id: "website-test-v1", secret: oldSecret }
  });
  const rotationBody = JSON.stringify({ company: "Rotation Test GmbH", externalId: `rotation-${Date.now()}` });
  const previousAccepted = await fetch(`${baseUrl}/api/website-leads`, {
    method: "POST",
    headers: signedHeaders(rotationBody, { keyId: "website-test-v1", secret: oldSecret }),
    body: rotationBody
  });
  assert.equal(previousAccepted.status, 201);

  setWebsiteLeadIngressSettingsForTest({
    schemaVersion: 1,
    enabled: true,
    ownerId: "u_sales_shirley",
    current: { id: "website-test-v2", secret: "website-test-v2-secret-with-at-least-32-characters" },
    previous: null
  });
  const revokedPrevious = await fetch(`${baseUrl}/api/website-leads`, {
    method: "POST",
    headers: signedHeaders(rotationBody, { keyId: "website-test-v1", secret: oldSecret }),
    body: rotationBody
  });
  assert.equal(revokedPrevious.status, 401);

  console.log(JSON.stringify({
    websiteLeadHmacAccepted: true,
    invalidSignatureRejected: true,
    expiredSignatureRejected: true,
    replayRejected: true,
    idempotencyPreserved: true,
    overlapRotationAccepted: true,
    previousKeyRevoked: true
  }, null, 2));
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
