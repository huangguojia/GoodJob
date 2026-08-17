import assert from "node:assert/strict";
import {
  contactChannelsFromText,
  createContactEnrichmentAttempt,
  mergeProspectContactEvidence,
  providerContactEvidence,
  recommendProspectContact,
  sourceRecordContactEvidence
} from "./prospect-contact-enrichment.js";
import type { WebsiteOpportunity } from "./types.js";

const now = new Date().toISOString();
const candidate: WebsiteOpportunity = {
  id: "candidate-contact-test",
  company: "Acme Distribution",
  business: "Lighting distributor",
  country: "United States",
  website: "https://acme.example",
  contact: "Sales Desk",
  contactInfo: "sales@acme.example / +1 (415) 555-0123",
  description: "",
  ownerId: "owner-a",
  teamId: "team-a",
  status: "preview",
  createdAt: now,
  source: "public_procurement",
  sourceLabel: "Public Procurement"
};

assert.deepEqual(contactChannelsFromText(candidate.contactInfo), {
  emails: ["sales@acme.example"],
  phones: ["+14155550123"]
});

const sourceContacts = sourceRecordContactEvidence(candidate);
assert.equal(sourceContacts.length, 1);
assert.equal(sourceContacts[0]?.verificationStatus, "source_confirmed");

const providerContacts = providerContactEvidence({
  company: candidate.company,
  contact: "Alex Morgan",
  contactInfo: "sales@acme.example",
  sourceId: "contact_api",
  sourceLabel: "Contact API",
  sourceUrl: "https://provider.example/evidence/1",
  confidence: 94,
  observedAt: now
});
const merged = mergeProspectContactEvidence(sourceContacts, providerContacts);
assert.equal(merged.length, 1, "相同邮箱必须跨来源去重");
assert.equal(merged[0]?.name, "Alex Morgan", "高可信具名联系人应成为推荐主体");
assert.equal(merged[0]?.corroboratedSources?.length, 2, "去重后必须保留交叉来源");
assert.equal(recommendProspectContact(merged)?.channel.value, "sales@acme.example");

const attempt = createContactEnrichmentAttempt({
  candidate: { ...candidate, extractedContacts: [] },
  runId: "run-contact-test",
  providerSources: [
    { id: "contact_api", label: "Contact API", configured: true },
    { id: "optional_api", label: "Optional API", configured: false }
  ],
  includeWebsite: true
});
assert.equal(attempt.sources.length, 4);
assert.equal(attempt.sources.find((item) => item.sourceId === "optional_api")?.outcome, "not_configured");
assert.equal(attempt.sources.find((item) => item.sourceId === "website_probe")?.status, "queued");

const aiCandidate = {
  ...candidate,
  source: "ai_search",
  sourceLabel: "AI Search",
  sourceEvidence: []
};
assert.equal(
  sourceRecordContactEvidence(aiCandidate).length,
  0,
  "AI 辅助结果不得直接成为联系人事实"
);

console.log("prospect contact enrichment tests passed");
