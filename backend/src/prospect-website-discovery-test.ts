import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  discoverProspectWebsite,
  rankProspectWebsiteCandidates
} from "./prospect-website-discovery.js";
import type { ProviderRecord } from "./provider-contract.js";
import type { WebsiteOpportunity } from "./types.js";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function candidate(id: string, website = ""): WebsiteOpportunity {
  return {
    id,
    company: "Northstar Lighting LLC",
    business: "LED lighting distributor",
    country: "United States",
    website,
    contact: "待维护",
    contactInfo: "",
    description: "Website discovery test",
    ownerId: "website-owner",
    teamId: "website-team",
    status: "preview",
    createdAt: "2026-08-15T00:00:00.000Z"
  };
}

function record(input: {
  company: string;
  website: string;
  country?: string;
}): ProviderRecord {
  return {
    company: input.company,
    officialWebsite: input.website,
    website: input.website,
    country: input.country || "United States",
    business: "Lighting",
    contact: "",
    contactInfo: "",
    description: "",
    confidence: 70,
    providerRecordId: hash(input.website).slice(0, 24),
    sourceUrl: input.website,
    recordType: "discovery_page",
    fetchedAt: "2026-08-15T00:00:00.000Z",
    payloadHash: hash(`${input.company}:${input.website}`),
    evidenceSummary: `${input.company} official site`,
    matchedFields: ["company", "officialWebsite"],
    adapterVersion: "website-discovery-test-v1",
    catalogPolicyVersion: "website-discovery-test-v1",
    sourceLevel: "discovery",
    retentionPolicyRef: "test"
  };
}

const ranked = rankProspectWebsiteCandidates(candidate("rank"), [
  record({ company: "Unrelated Corporation", website: "https://unrelated.example" }),
  record({ company: "Northstar Lighting | Official Site", website: "https://northstar-lighting.com" })
]);
assert.equal(ranked[0]?.website, "https://northstar-lighting.com");
assert.ok((ranked[0]?.score || 0) >= 55);

let searchCalls = 0;
let persistCalls = 0;
const sourceCandidate = candidate("source", "https://source-provided.example/about");
const sourceAttempt = await discoverProspectWebsite({
  candidate: sourceCandidate,
  runId: "website-run-source",
  search: async () => {
    searchCalls += 1;
    return { providerId: "serper", records: [] };
  },
  persist: async () => { persistCalls += 1; }
});
assert.equal(sourceAttempt.outcome, "source_provided");
assert.equal(sourceAttempt.selectedWebsite, "https://source-provided.example");
assert.equal(searchCalls, 0);

const discoveredCandidate = candidate("discovered");
const discoveredAttempt = await discoverProspectWebsite({
  candidate: discoveredCandidate,
  runId: "website-run-discovered",
  search: async () => ({
    providerId: "serper",
    records: [record({
      company: "Northstar Lighting - Official Website",
      website: "https://northstar-lighting.com"
    })]
  }),
  persist: async () => { persistCalls += 1; }
});
assert.equal(discoveredAttempt.outcome, "discovered");
assert.equal(discoveredCandidate.website, "https://northstar-lighting.com");
assert.ok(discoveredAttempt.events.some((item) =>
  item.message.includes("已确认官网")
));

const unavailableCandidate = candidate("unavailable");
const unavailableAttempt = await discoverProspectWebsite({
  candidate: unavailableCandidate,
  runId: "website-run-unavailable",
  persist: async () => { persistCalls += 1; }
});
assert.equal(unavailableAttempt.outcome, "provider_unavailable");
assert.equal(unavailableAttempt.reasonCode, "WEBSITE_SEARCH_PROVIDER_UNAVAILABLE");
assert.equal(unavailableCandidate.website, "");
assert.equal(persistCalls, 3);

const retriedAttempt = await discoverProspectWebsite({
  candidate: unavailableCandidate,
  runId: "website-run-unavailable",
  retryExisting: true,
  search: async () => ({
    providerId: "openai_web_search",
    records: [record({
      company: "Northstar Lighting | Official Site",
      website: "https://northstar-lighting.com"
    })]
  }),
  persist: async () => { persistCalls += 1; }
});
assert.equal(retriedAttempt.outcome, "discovered");
assert.equal(retriedAttempt.providerId, "openai_web_search");
assert.equal(unavailableCandidate.website, "https://northstar-lighting.com");
assert.equal(unavailableCandidate.websiteDiscoveryAttempts?.length, 2);
assert.equal(persistCalls, 4);

console.log("Prospect official website discovery tests passed.");
