import assert from "node:assert/strict";
import { app } from "./server.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import { getStore } from "./store.js";
import type { WebsiteOpportunity } from "./types.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start website probe HTTP test server");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

async function jsonRequest(path: string, options: RequestInit = {}) {
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
let probeCandidate: WebsiteOpportunity | null = null;
const originalEnabled = process.env.WEBSITE_PROBE_ENABLED;
const originalInterval = process.env.WEBSITE_PROBE_TEAM_INTERVAL_MS;

try {
  const login = await jsonRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: "shirley@goodjob.com",
      password: "goodjob123"
    })
  });
  assert.equal(login.response.ok, true);
  const token = String(login.json.token || "");
  const owner = store.users.find((item) => item.email === "shirley@goodjob.com");
  assert.ok(owner);
  const authorization = { authorization: `Bearer ${token}` };
  probeCandidate = {
    id: `website-probe-http-${Date.now()}`,
    company: "Website Probe HTTP Limited",
    business: "Industrial components",
    country: "GB",
    website: "https://probe-http-example.com/about",
    contact: "Purchasing",
    contactInfo: "",
    description: "Website probe HTTP and SSE test",
    ownerId: owner.id,
    teamId: owner.teamId,
    status: "preview",
    createdAt: new Date().toISOString(),
    outreachState: "uncontacted"
  };
  store.websiteOpportunities.push(probeCandidate);

  process.env.WEBSITE_PROBE_ENABLED = "false";
  const attemptsBeforeDisabled = probeCandidate.websiteProbeAttempts?.length || 0;
  const disabled = await jsonRequest(
    `/api/prospect-list/${encodeURIComponent(probeCandidate.id)}/website-probe`,
    {
      method: "POST",
      headers: authorization,
      body: "{}"
    }
  );
  assert.equal(disabled.response.status, 503);
  assert.equal(disabled.json.errorCode, "WEBSITE_PROBE_DISABLED");
  assert.equal(probeCandidate.websiteProbeAttempts?.length || 0, attemptsBeforeDisabled);

  process.env.WEBSITE_PROBE_ENABLED = "true";
  process.env.WEBSITE_PROBE_TEAM_INTERVAL_MS = "0";
  const transportRequests: string[] = [];
  setProviderHttpTestTransport(async (url, init) => {
    transportRequests.push(`${String(init.method || "GET")} ${url}`);
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nAllow: /\n", {
        status: 200,
        headers: { "content-type": "text/plain" }
      });
    }
    if (init.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    return new Response(`<!doctype html><html lang="en"><head>
      <title>Probe HTTP</title>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Website Probe HTTP Limited",
        address: { addressCountry: "GB" }
      })}</script></head><body>Company homepage
      <a href="mailto:contact@probe-http-example.com">Email sales</a></body></html>`, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  });

  const started = await jsonRequest(
    `/api/prospect-list/${encodeURIComponent(probeCandidate.id)}/website-probe`,
    {
      method: "POST",
      headers: authorization,
      body: "{}"
    }
  );
  assert.equal(started.response.status, 202);
  const attemptId = String(started.json.attempt.id || "");
  assert.ok(attemptId);

  const eventResponse = await fetch(
    `${baseUrl}/api/prospect-list/${encodeURIComponent(probeCandidate.id)}/website-probe/${encodeURIComponent(attemptId)}/events?after=0`,
    { headers: authorization }
  );
  assert.equal(eventResponse.status, 200);
  const eventText = await eventResponse.text();
  assert.match(eventText, /event: probe_event/u);
  assert.match(eventText, /"stage":"dns"/u);
  assert.match(eventText, /"stage":"robots"/u);
  assert.match(eventText, /"stage":"head"/u);
  assert.match(eventText, /"stage":"body"/u);
  assert.match(eventText, /"stage":"evidence"/u);
  assert.match(eventText, /event: done/u);

  const detail = await jsonRequest(
    `/api/prospect-list/${encodeURIComponent(probeCandidate.id)}/website-probe/${encodeURIComponent(attemptId)}`,
    { headers: authorization }
  );
  assert.equal(detail.response.status, 200);
  assert.equal(detail.json.terminal, true);
  assert.equal(detail.json.attempt.status, "completed");
  assert.equal(detail.json.attempt.outcome, "evidence_found");
  assert.equal(detail.json.attempt.evidence.organizationName, "Website Probe HTTP Limited");
  assert.equal(detail.json.attempt.evidence.publicContactEmail, "contact@probe-http-example.com");
  assert.equal(detail.json.opportunity.contactInfo, "contact@probe-http-example.com");
  assert.equal(detail.json.opportunity.verificationReport.accessMode, "controlled_probe");
  assert.equal(detail.json.opportunity.verificationReport.crawlerFree, false);
  assert.deepEqual(transportRequests.map((item) => item.split(" ")[0]), [
    "GET",
    "HEAD",
    "GET"
  ]);

  console.log("Website probe HTTP and SSE tests passed");
} finally {
  setProviderHttpTestTransport(null);
  if (probeCandidate) {
    store.websiteOpportunities = store.websiteOpportunities.filter((item) =>
      item.id !== probeCandidate!.id
    );
  }
  if (originalEnabled === undefined) delete process.env.WEBSITE_PROBE_ENABLED;
  else process.env.WEBSITE_PROBE_ENABLED = originalEnabled;
  if (originalInterval === undefined) delete process.env.WEBSITE_PROBE_TEAM_INTERVAL_MS;
  else process.env.WEBSITE_PROBE_TEAM_INTERVAL_MS = originalInterval;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
