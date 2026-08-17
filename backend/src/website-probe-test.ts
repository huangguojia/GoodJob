import assert from "node:assert/strict";
import { buildProspectScorecard } from "./prospect-scorecard.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import { getStore, type CrmStore } from "./store.js";
import type { WebsiteOpportunity, WebsiteProbeAttempt } from "./types.js";
import {
  extractEvidence,
  queueWebsiteProbe,
  resumeWebsiteProbeAttempt,
  WebsiteProbeError,
  websiteProbeCapability
} from "./website-probe.js";

function isolatedStore(): CrmStore {
  const base = getStore();
  return {
    ...base,
    mode: "memory",
    websiteOpportunities: [],
    async persist() {
      // Isolated contract test.
    },
    async readBarrier() {
      // Isolated contract test.
    }
  };
}

function candidate(id: string, website: string): WebsiteOpportunity {
  return {
    id,
    company: `Probe ${id}`,
    business: "Industrial components",
    country: "United Kingdom",
    website,
    contact: "Purchasing",
    contactInfo: "private-buyer@example.test",
    description: "Website probe security test",
    ownerId: "owner-probe",
    teamId: "team-probe",
    status: "preview",
    createdAt: new Date().toISOString(),
    outreachState: "uncontacted"
  };
}

async function waitForTerminal(
  prospect: WebsiteOpportunity,
  attemptId: string
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const attempt = prospect.websiteProbeAttempts?.find((item) =>
      item.id === attemptId
    );
    if (attempt && ["completed", "failed"].includes(attempt.status)) {
      return attempt;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Probe ${attemptId} did not reach a terminal state`);
}

async function queueAndWait(
  store: CrmStore,
  prospect: WebsiteOpportunity
) {
  store.websiteOpportunities.push(prospect);
  const result = await queueWebsiteProbe(
    store,
    prospect,
    prospect.ownerId,
    async () => undefined
  );
  return await waitForTerminal(prospect, result.attempt.id);
}

async function main() {
  const originalEnabled = process.env.WEBSITE_PROBE_ENABLED;
  const originalInterval = process.env.WEBSITE_PROBE_TEAM_INTERVAL_MS;
  const store = isolatedStore();
  let requests: Array<{ url: string; method: string }> = [];
  try {
    process.env.WEBSITE_PROBE_ENABLED = "false";
    const disabled = candidate("disabled", "https://disabled.example.test/");
    await assert.rejects(
      queueWebsiteProbe(store, disabled, disabled.ownerId, async () => undefined),
      (error: unknown) => error instanceof WebsiteProbeError
        && error.code === "WEBSITE_PROBE_DISABLED"
    );
    assert.equal(disabled.websiteProbeAttempts, undefined);

    process.env.WEBSITE_PROBE_ENABLED = "true";
    process.env.WEBSITE_PROBE_TEAM_INTERVAL_MS = "0";
    const privateTarget = candidate("private", "https://127.0.0.1/");
    await assert.rejects(
      queueWebsiteProbe(store, privateTarget, privateTarget.ownerId, async () => undefined),
      (error: unknown) => error instanceof WebsiteProbeError
        && error.code === "WEBSITE_PROBE_URL_INVALID"
    );
    assert.equal(privateTarget.websiteProbeAttempts, undefined);

    for (const [id, country, website] of [
      ["mainland-country", "中国", "https://example.test/"],
      ["unknown-country", "未知", "https://example.test/"],
      ["unknown-english", "Unknown", "https://example.test/"],
      ["hong-kong-country", "香港", "https://example.test/"],
      ["macau-country", "Macao", "https://example.test/"],
      ["taiwan-country", "TW", "https://example.test/"],
      ["mainland-domain", "United Kingdom", "https://example.cn/"],
      ["hong-kong-domain", "United Kingdom", "https://example.hk/"],
      ["macau-domain", "United Kingdom", "https://example.mo/"],
      ["taiwan-domain", "United Kingdom", "https://example.tw/"],
      ["chinese-idn-domain", "United Kingdom", "https://example.xn--fiqs8s/"]
    ] as const) {
      const restricted = { ...candidate(id, website), country };
      await assert.rejects(
        queueWebsiteProbe(store, restricted, restricted.ownerId, async () => undefined),
        (error: unknown) => error instanceof WebsiteProbeError
          && error.code === "WEBSITE_PROBE_COUNTRY_BLOCKED"
      );
      assert.equal(restricted.websiteProbeAttempts, undefined);
    }
    assert.equal(websiteProbeCapability().foreignOnly, true);

    setProviderHttpTestTransport(async (url, init) => {
      requests.push({ url, method: String(init.method || "GET") });
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /\n", {
          status: 200,
          headers: { "content-type": "text/plain" }
        });
      }
      if (init.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-length": "1200"
          }
        });
      }
      return new Response(`<!doctype html><html lang="en"><head>
        <title>Example Industrial</title>
        <script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "Example Industrial Ltd",
          legalName: "Example Industrial Limited",
          industry: "Industrial fasteners",
          email: "do-not-store@example.test",
          telephone: "+1-202-555-0199",
          address: { addressCountry: "US" }
        })}</script></head><body>private-body-marker do-not-store@example.test
        <p>Industry leading protective coatings for global infrastructure.</p>
        <p>John Smith - Sales Manager</p>
        <a href="mailto:sales@evidence-example.com">Sales</a></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    const evidenceCandidate = candidate("evidence", "https://www.evidence-example.com/about");
    evidenceCandidate.contact = "待维护";
    evidenceCandidate.contactInfo = "";
    const scoreBefore = buildProspectScorecard(store, evidenceCandidate);
    const evidenceAttempt = await queueAndWait(store, evidenceCandidate);
    const scoreAfter = buildProspectScorecard(store, evidenceCandidate);
    assert.equal(evidenceAttempt.status, "completed");
    assert.equal(evidenceAttempt.outcome, "evidence_found");
    assert.equal(evidenceAttempt.robotsDecision, "allowed");
    assert.equal(evidenceAttempt.evidence?.organizationName, "Example Industrial Ltd");
    assert.equal(evidenceAttempt.evidence?.addressCountry, "US");
    assert.equal(evidenceAttempt.evidence?.publicContactEmail, "sales@evidence-example.com");
    assert.equal(evidenceCandidate.contactInfo, "sales@evidence-example.com");
    assert.equal(evidenceCandidate.contact, "John Smith");
    assert.deepEqual(
      evidenceCandidate.extractedContacts?.filter((item) => item.kind === "person").map((item) => item.name),
      ["John Smith"]
    );
    assert.equal(evidenceAttempt.events.map((item) => item.stage).join(","),
      "queued,dns,dns,robots,robots,head,head,body,body,evidence,completed");
    const persistedJson = JSON.stringify(evidenceAttempt);
    assert.doesNotMatch(persistedJson, /private-body-marker/u);
    assert.doesNotMatch(persistedJson, /do-not-store@example\.test/u);
    assert.doesNotMatch(persistedJson, /202-555-0199/u);
    assert.equal(scoreAfter.enterpriseConfidence.score, scoreBefore.enterpriseConfidence.score);
    assert.equal(scoreAfter.icpMatch.score, scoreBefore.icpMatch.score);
    assert.equal(evidenceCandidate.verificationReport?.accessMode, "controlled_probe");
    assert.equal(evidenceCandidate.verificationReport?.crawlerFree, false);
    assert.deepEqual(requests.map((item) => item.method), ["GET", "HEAD", "GET"]);

    requests = [];
    setProviderHttpTestTransport(async (url, init) => {
      requests.push({ url, method: String(init.method || "GET") });
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      }
      if (init.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.includes("/contact-us")) {
        return new Response("<html><body>contact-private-marker <a href=\"mailto:export@contact-page-example.com\">Export</a></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response("<html><head><title>Contact Page Example</title></head><body><a href=\"/contact-us\">Contact us</a></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const contactCandidate = candidate("contact-page", "https://contact-page-example.com/products/pumps");
    contactCandidate.contactInfo = "";
    const contactAttempt = await queueAndWait(store, contactCandidate);
    assert.equal(contactAttempt.outcome, "evidence_found");
    assert.equal(contactAttempt.evidence?.publicContactEmail, "export@contact-page-example.com");
    assert.equal(contactAttempt.evidence?.sourceUrl, "https://contact-page-example.com/contact-us");
    assert.ok(contactAttempt.events.some((item) => item.stage === "contact_page" && item.status === "completed"));
    assert.deepEqual(requests.map((item) => item.method), ["GET", "HEAD", "GET", "GET"]);
    assert.ok(requests.some((item) => item.url === "https://contact-page-example.com/products/pumps"));
    assert.doesNotMatch(JSON.stringify(contactAttempt), /contact-private-marker/u);

    const explicitExternalEmail = extractEvidence(
      '<html><body><a href="mailto:export.team@gmail.com">Email export sales</a></body></html>',
      "https://foreign-email-example.com/",
      "foreign-email-example.com",
      new Date().toISOString()
    );
    assert.equal(explicitExternalEmail.publicContactEmail, "export.team@gmail.com");
    const unlinkedExternalEmail = extractEvidence(
      "<html><body>Unrelated text: someone@gmail.com</body></html>",
      "https://foreign-email-example.com/",
      "foreign-email-example.com",
      new Date().toISOString()
    );
    assert.equal(unlinkedExternalEmail.publicContactEmail, "");

    requests = [];
    setProviderHttpTestTransport(async (url, init) => {
      requests.push({ url, method: String(init.method || "GET") });
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      }
      if (init.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(`<html><head><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Phone Only Example",
        telephone: ["20260806", "0160123", "11111111"]
      })}</script></head><body>Updated 2022-06-08 · Order 105700270617923 · Ref 02-70617923 <a href="tel:+44-20-7946-0958">Call sales</a></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const phoneCandidate = candidate("phone-only", "https://phone-only-example.com/");
    phoneCandidate.contactInfo = "";
    const phoneAttempt = await queueAndWait(store, phoneCandidate);
    assert.equal(phoneAttempt.outcome, "evidence_found");
    assert.equal(phoneCandidate.contactInfo, "+442079460958");
    assert.deepEqual(phoneAttempt.evidence?.publicContactPhones, ["+442079460958"]);
    assert.deepEqual(phoneCandidate.extractedContacts?.[0]?.phones, ["+442079460958"]);

    requests = [];
    setProviderHttpTestTransport(async (url, init) => {
      requests.push({ url, method: String(init.method || "GET") });
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      }
      if (new URL(url).pathname === "/" && init.method === "HEAD") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://locale-redirect-example.com/en-US/" }
        });
      }
      if (new URL(url).pathname === "/" && init.method === "GET") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://locale-redirect-example.com/en-US/" }
        });
      }
      if (init.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(
        "<html><body><a href=\"mailto:sales@locale-redirect-example.com\">Sales</a></body></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      );
    });
    const localeRedirectCandidate = candidate(
      "locale-redirect",
      "https://locale-redirect-example.com/"
    );
    localeRedirectCandidate.contactInfo = "";
    const localeRedirectAttempt = await queueAndWait(store, localeRedirectCandidate);
    assert.equal(localeRedirectAttempt.outcome, "evidence_found");
    assert.equal(localeRedirectCandidate.contactInfo, "sales@locale-redirect-example.com");
    assert.ok(requests.some((item) => item.url.endsWith("/en-US/")));

    requests = [];
    setProviderHttpTestTransport(async (url, init) => {
      requests.push({ url, method: String(init.method || "GET") });
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      if (init.method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
      return new Response("<html><head><title>Resumed probe</title></head><body></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const resumedCandidate = candidate("resumed", "https://resume-example.com/");
    const recoveredAttempt: WebsiteProbeAttempt = {
      id: "wpa_recovered_test",
      candidateId: resumedCandidate.id,
      teamId: resumedCandidate.teamId,
      ownerId: resumedCandidate.ownerId,
      domain: "resume-example.com",
      sourceUrl: "https://resume-example.com/",
      purpose: "company_evidence_enrichment",
      accessMode: "controlled_probe",
      policyVersion: "website-probe-policy-v3",
      status: "queued",
      outcome: "pending",
      robotsDecision: "pending",
      httpStatus: 0,
      responseBytes: 0,
      redirected: false,
      evidence: null,
      events: [],
      failureCode: "",
      failureMessage: "",
      startedAt: "",
      completedAt: "",
      createdAt: new Date().toISOString()
    };
    resumedCandidate.websiteProbeAttempts = [recoveredAttempt];
    store.websiteOpportunities.push(resumedCandidate);
    assert.equal(await resumeWebsiteProbeAttempt(
      store,
      resumedCandidate,
      recoveredAttempt,
      resumedCandidate.ownerId,
      async () => undefined
    ), true);
    const resumedAttempt = await waitForTerminal(resumedCandidate, recoveredAttempt.id);
    assert.equal(resumedAttempt.status, "completed");
    assert.equal(await resumeWebsiteProbeAttempt(
      store,
      resumedCandidate,
      recoveredAttempt,
      resumedCandidate.ownerId,
      async () => undefined
    ), false);

    requests = [];
    setProviderHttpTestTransport(async (url, init) => {
      requests.push({ url, method: String(init.method || "GET") });
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /\n", {
          status: 200,
          headers: { "content-type": "text/plain" }
        });
      }
      if (init.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    });
    const requestCountBeforeCache = requests.length;
    const cachedCandidate = candidate("cached", "https://www.evidence-example.com/");
    const cachedAttempt = await queueAndWait(store, cachedCandidate);
    assert.equal(requests.length, requestCountBeforeCache);
    assert.equal(cachedAttempt.outcome, "evidence_found");
    assert.equal(cachedAttempt.events.at(-1)?.metrics.networkAccess, false);

    requests = [];
    setProviderHttpTestTransport(async (url) => {
      requests.push({ url, method: "GET" });
      return new Response("User-agent: *\nDisallow: /\n", {
        status: 200,
        headers: { "content-type": "text/plain" }
      });
    });
    const deniedAttempt = await queueAndWait(
      store,
      candidate("robots-denied", "https://robots-denied-example.com/")
    );
    assert.equal(deniedAttempt.status, "completed");
    assert.equal(deniedAttempt.outcome, "robots_denied");
    assert.equal(deniedAttempt.evidence, null);
    assert.equal(requests.length, 1);

    requests = [];
    setProviderHttpTestTransport(async (url, init) => {
      requests.push({ url, method: String(init.method || "GET") });
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      }
      return new Response(null, {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    });
    const mimeAttempt = await queueAndWait(
      store,
      candidate("mime", "https://mime-example.com/")
    );
    assert.equal(mimeAttempt.outcome, "no_evidence");
    assert.deepEqual(requests.map((item) => item.method), ["GET", "HEAD"]);

    requests = [];
    setProviderHttpTestTransport(async (url, init) => {
      requests.push({ url, method: String(init.method || "GET") });
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      }
      if (init.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response("x".repeat(256 * 1024 + 1), {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const largeAttempt = await queueAndWait(
      store,
      candidate("large", "https://large-example.com/")
    );
    assert.equal(largeAttempt.status, "completed");
    assert.equal(largeAttempt.outcome, "no_evidence");
    assert.equal(largeAttempt.evidence?.publicContactEmail, "");
    assert.deepEqual(largeAttempt.evidence?.publicContactPhones, []);
    assert.equal(largeAttempt.responseBytes, 256 * 1024);
    assert.equal(
      largeAttempt.events.find((item) => item.stage === "body" && item.status === "completed")?.metrics.truncated,
      true
    );

    requests = [];
    setProviderHttpTestTransport(async (url, init) => {
      requests.push({ url, method: String(init.method || "GET") });
      throw new Error("simulated transient network failure");
    });
    const transientAttempts: WebsiteProbeAttempt[] = [];
    for (let index = 0; index < 3; index += 1) {
      transientAttempts.push(await queueAndWait(
        store,
        candidate(`transient-${index}`, "https://circuit-example.com/")
      ));
    }
    assert.ok(transientAttempts.every((item) =>
      item.status === "failed" && item.outcome === "unreachable"
    ));
    assert.equal(requests.length, 6, "each transient failure gets exactly one retry");
    assert.ok(transientAttempts.every((item) =>
      item.events.some((event) => event.metrics.retry === 1)
    ));
    const requestsBeforeCircuit = requests.length;
    const circuitAttempt = await queueAndWait(
      store,
      candidate("circuit-open", "https://circuit-example.com/")
    );
    assert.equal(circuitAttempt.outcome, "circuit_open");
    assert.equal(requests.length, requestsBeforeCircuit);
    assert.equal(circuitAttempt.events.at(-1)?.metrics.networkAccess, false);

    console.log(JSON.stringify({
      ok: true,
      defaultOff: false,
      ssrfBlocked: true,
      robotsRespected: true,
      mimeAndSizeBounded: true,
      htmlAndPersonalDataNotStored: true,
      publicSameDomainEmailBackfilled: true,
      cacheReusedWithoutNetwork: true,
      circuitBreakerStopsNetwork: true,
      unavailableIsScoreNeutral: true,
      realtimeStages: evidenceAttempt.events.length
    }, null, 2));
  } finally {
    setProviderHttpTestTransport(null);
    if (originalEnabled === undefined) delete process.env.WEBSITE_PROBE_ENABLED;
    else process.env.WEBSITE_PROBE_ENABLED = originalEnabled;
    if (originalInterval === undefined) delete process.env.WEBSITE_PROBE_TEAM_INTERVAL_MS;
    else process.env.WEBSITE_PROBE_TEAM_INTERVAL_MS = originalInterval;
  }
}

void main();
