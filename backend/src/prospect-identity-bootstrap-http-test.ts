import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";
import type { WebsiteOpportunity } from "./types.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start prospect identity bootstrap HTTP test server");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const json = await response.json();
  return { response, json };
}

try {
  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: "shirley@goodjob.com",
      password: "goodjob123"
    })
  });
  assert.equal(login.response.ok, true);
  const token = String(login.json.token || "");
  const store = getStore();
  const owner = store.users.find((item) =>
    item.email === "shirley@goodjob.com"
  );
  const otherOwner = store.users.find((item) =>
    item.email === "mia@goodjob.com"
  );
  assert.ok(owner);
  assert.ok(otherOwner);
  const suffix = Date.now();
  const target: WebsiteOpportunity = {
    id: `identity-bootstrap-http-${suffix}`,
    company: "HTTP Bootstrap Candidate",
    business: "Industrial products",
    country: "Global",
    website: `https://identity-bootstrap-${suffix}.example.test`,
    contact: "Purchasing",
    contactInfo: "",
    description: "Reference-only candidate",
    ownerId: owner.id,
    teamId: owner.teamId,
    status: "preview",
    createdAt: new Date().toISOString(),
    parseMode: "reference",
    source: "website-reference",
    sourceLabel: "官网链接登记",
    sourceEvidence: [],
    identityBootstrapAttempts: []
  };
  const otherTarget: WebsiteOpportunity = {
    ...structuredClone(target),
    id: `identity-bootstrap-http-other-${suffix}`,
    ownerId: otherOwner.id,
    website: `https://identity-bootstrap-other-${suffix}.example.test`
  };
  store.websiteOpportunities.unshift(target, otherTarget);

  const anonymous = await request(
    `/api/prospect-list/${encodeURIComponent(target.id)}/identity-bootstrap`
  );
  assert.equal(anonymous.response.status, 401);

  const guide = await request(
    `/api/prospect-list/${encodeURIComponent(target.id)}/identity-bootstrap`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  assert.equal(guide.response.status, 200);
  assert.equal(guide.json.formallyResolved, false);
  assert.ok(guide.json.providers.some((item: { id: string }) =>
    item.id === "gleif"
  ));

  const crossOwner = await request(
    `/api/prospect-list/${encodeURIComponent(otherTarget.id)}/identity-bootstrap`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  assert.equal(crossOwner.response.status, 403);

  const invalid = await request(
    `/api/prospect-list/${encodeURIComponent(target.id)}/identity-bootstrap`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        providerId: "gleif",
        registrationNumber: "INVALID",
        requestId: "identity-bootstrap-http-invalid"
      })
    }
  );
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.json.errorCode, "IDENTITY_BOOTSTRAP_INVALID");
  assert.equal(target.identityBootstrapAttempts?.length, 0);

  const start = await request(
    `/api/prospect-list/${encodeURIComponent(target.id)}/identity-bootstrap`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        providerId: "gleif",
        registrationNumber: "529900T8BM49AURSDO55",
        requestId: "identity-bootstrap-http-success"
      })
    }
  );
  assert.equal(start.response.status, 201);
  assert.equal(start.json.taskStatus, "running");
  assert.equal(start.json.taskStatusLabel, "进行中");
  assert.ok(start.json.attempt?.runId);
  assert.ok(start.json.attempt?.campaignId);
  assert.equal(start.json.attempt?.events?.[0]?.stage, "validation");
  assert.equal(start.json.attempt?.events?.[1]?.stage, "campaign");

  const replay = await request(
    `/api/prospect-list/${encodeURIComponent(target.id)}/identity-bootstrap`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        providerId: "gleif",
        registrationNumber: "529900T8BM49AURSDO55",
        requestId: "identity-bootstrap-http-success"
      })
    }
  );
  assert.equal(replay.response.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.attempt.id, start.json.attempt.id);
  assert.equal(target.identityBootstrapAttempts?.length, 1);

  const run = store.prospectSearchRuns.find((item) =>
    item.id === start.json.attempt.runId
  );
  assert.ok(run);
  run.status = "succeeded_empty";
  run.updatedAt = new Date().toISOString();

  const reconciled = await request(
    `/api/prospect-list/${encodeURIComponent(target.id)}`
    + `/identity-bootstrap/${encodeURIComponent(start.json.attempt.id)}/reconcile`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}"
    }
  );
  assert.equal(reconciled.response.status, 200);
  assert.equal(reconciled.json.taskStatus, "ended");
  assert.equal(reconciled.json.taskStatusLabel, "已结束");
  assert.equal(reconciled.json.attempt.outcome, "not_found");
  assert.equal(reconciled.json.attempt.errorCode, "AUTHORITY_IDENTIFIER_NOT_FOUND");
  assert.equal(reconciled.json.candidate.organizationId, undefined);

  const detail = await request(
    `/api/prospect-list/${encodeURIComponent(target.id)}`
    + `/identity-bootstrap/${encodeURIComponent(start.json.attempt.id)}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  assert.equal(detail.response.status, 200);
  assert.equal(detail.json.taskStatusLabel, "已结束");
  assert.equal(detail.json.attempt.outcome, "not_found");
  assert.ok(detail.json.attempt.events.some((item: { status: string }) =>
    item.status === "failed"
  ));

  console.log(JSON.stringify({
    ok: true,
    attemptId: start.json.attempt.id,
    runId: start.json.attempt.runId,
    replayed: replay.json.replayed,
    taskStatusLabel: detail.json.taskStatusLabel,
    outcome: detail.json.attempt.outcome
  }, null, 2));
} finally {
  server.close();
}
