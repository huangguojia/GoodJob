import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";
import type { WebsiteOpportunity } from "./types.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start prospect shortlist HTTP test server");
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
  return { response, json: await response.json() };
}

const store = getStore();
const insertedIds: string[] = [];

try {
  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: "shirley@goodjob.com",
      password: "goodjob123"
    })
  });
  assert.equal(login.response.status, 200);
  const token = String(login.json.token || "");
  const owner = store.users.find((item) => item.email === "shirley@goodjob.com");
  const otherOwner = store.users.find((item) => item.email === "mia@goodjob.com");
  assert.ok(owner);
  assert.ok(otherOwner);

  const suffix = Date.now();
  const candidate: WebsiteOpportunity = {
    id: `prospect-shortlist-${suffix}`,
    company: "Shortlist Flow Test Ltd",
    business: "Industrial lighting distribution",
    country: "GB",
    website: `https://shortlist-${suffix}.example.test`,
    contact: "Alex Morgan",
    contactInfo: "alex@example.test",
    description: "Shortlist HTTP flow test",
    ownerId: owner.id,
    teamId: owner.teamId,
    status: "preview",
    createdAt: new Date().toISOString()
  };
  const otherCandidate: WebsiteOpportunity = {
    ...structuredClone(candidate),
    id: `prospect-shortlist-other-${suffix}`,
    ownerId: otherOwner.id,
    website: `https://shortlist-other-${suffix}.example.test`
  };
  insertedIds.push(candidate.id, otherCandidate.id);
  store.websiteOpportunities.unshift(candidate, otherCandidate);
  const leadCountBefore = store.leads.length;

  const anonymous = await request("/api/prospect-list/batch", {
    method: "PATCH",
    body: JSON.stringify({ ids: [candidate.id], action: "shortlist" })
  });
  assert.equal(anonymous.response.status, 401);

  const crossOwner = await request("/api/prospect-list/batch", {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ ids: [otherCandidate.id], action: "shortlist" })
  });
  assert.equal(crossOwner.response.status, 404);
  assert.equal(otherCandidate.shortlistedAt, undefined);

  const effectiveAt = new Date().toISOString();
  const shortlisted = await request("/api/prospect-list/batch", {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ids: [candidate.id],
      action: "shortlist",
      sourceRunId: "run-shortlist-http-test",
      requestId: "prospect-shortlist-http-test",
      effectiveAt
    })
  });
  assert.equal(shortlisted.response.status, 200);
  assert.equal(shortlisted.json.opportunities.length, 1);
  assert.equal(shortlisted.json.opportunities[0].shortlistedAt, effectiveAt);
  assert.equal(shortlisted.json.opportunities[0].shortlistedBy, owner.id);
  assert.equal(shortlisted.json.opportunities[0].shortlistSourceRunId, "run-shortlist-http-test");
  assert.equal(shortlisted.json.opportunities[0].status, "preview");
  assert.equal(store.leads.length, leadCountBefore, "shortlisting must not create a lead");

  const replay = await request("/api/prospect-list/batch", {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ids: [candidate.id],
      action: "shortlist",
      sourceRunId: "different-run-must-not-rewrite",
      requestId: "prospect-shortlist-http-replay"
    })
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.json.opportunities[0].shortlistedAt, effectiveAt);
  assert.equal(replay.json.opportunities[0].shortlistSourceRunId, "run-shortlist-http-test");

  console.log(JSON.stringify({
    ok: true,
    candidateId: candidate.id,
    shortlistedAt: candidate.shortlistedAt,
    isolatedOtherOwner: true,
    leadCreated: false
  }, null, 2));
} finally {
  store.websiteOpportunities.splice(
    0,
    store.websiteOpportunities.length,
    ...store.websiteOpportunities.filter((item) => !insertedIds.includes(item.id))
  );
  server.close();
}
