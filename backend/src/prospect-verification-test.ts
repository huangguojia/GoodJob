import assert from "node:assert/strict";
import {
  buildProspectVerificationReport,
  ensureProspectVerificationReport,
  prospectVerificationReferenceTime
} from "./prospect-verification.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import type { ProviderEvidenceSnapshot, WebsiteOpportunity } from "./types.js";

const createdAt = "2026-07-16T08:00:00.000Z";
const catalog = createDefaultProviderCatalog();
const catalogByCode = (code: string) => catalog.find((item) => item.code === code);

assert.equal(catalogByCode("gleif")?.fieldAuthority?.company, "official");
assert.equal(catalogByCode("companies_house")?.fieldAuthority?.providerRecordId, "official");
assert.equal(catalogByCode("google_places")?.sourceLevel, "discovery");
assert.equal(catalogByCode("google_places")?.fieldAuthority?.company, "corroborated");
assert.equal(catalogByCode("apollo")?.sourceLevel, "company_reference");
assert.equal(catalogByCode("apollo")?.fieldAuthority?.company, "corroborated");
assert.equal(catalogByCode("serper")?.fieldAuthority?.officialWebsite, "discovery");
assert.equal(catalogByCode("ai_search")?.fieldAuthority?.contactInfo, "assisted");

function evidence(
  providerId: string,
  sourceLevel: string,
  officialWebsite = "",
  websiteAuthority: "official" | "corroborated" | "discovery" = "discovery"
): ProviderEvidenceSnapshot {
  return {
    providerId,
    providerRecordId: `${providerId}-record`,
    officialWebsite,
    sourceUrl: `https://api.example.test/${providerId}`,
    recordType: sourceLevel === "identity" ? "company_registry" : "search_result",
    fetchedAt: createdAt,
    payloadHash: providerId.padEnd(64, "0").slice(0, 64),
    evidenceSummary: sourceLevel === "identity" ? "企业登记记录" : "授权搜索 API 返回记录",
    matchedFields: ["company", ...(officialWebsite ? ["officialWebsite"] : [])],
    adapterVersion: "1.0.0",
    catalogPolicyVersion: "policy-1",
    sourceLevel,
    fieldAuthority: {
      company: sourceLevel === "identity" ? "official" : "discovery",
      providerRecordId: sourceLevel === "identity" ? "official" : "discovery",
      ...(officialWebsite ? { officialWebsite: websiteAuthority } : {})
    },
    retentionPolicyRef: "provider_terms"
  };
}

function opportunity(
  overrides: Partial<WebsiteOpportunity> = {}
): WebsiteOpportunity {
  return {
    id: "verification-test",
    company: "Example Industries",
    business: "Industrial equipment",
    country: "Test Country",
    website: "https://example.test/",
    contact: "待人工核实",
    contactInfo: "",
    description: "校验测试",
    ownerId: "test-owner",
    teamId: "test-team",
    status: "preview",
    createdAt,
    sourceEvidence: [],
    ...overrides
  };
}

const l0 = buildProspectVerificationReport(opportunity(), createdAt);
assert.equal(l0.level, "L0");
assert.equal(l0.crawlerFree, true);
assert.equal(
  l0.checks.find((item) => item.code === "crawler_free_policy")?.status,
  "passed"
);

const l1 = buildProspectVerificationReport(opportunity({
  sourceEvidence: [evidence("search-a", "discovery")]
}), createdAt);
assert.equal(l1.level, "L1");

const l2 = buildProspectVerificationReport(opportunity({
  sourceEvidence: [evidence("registry-a", "identity")]
}), createdAt);
assert.equal(l2.level, "L2");

const twoSourcesWithoutDomains = buildProspectVerificationReport(opportunity({
  sourceEvidence: [
    evidence("registry-a", "identity"),
    evidence("search-b", "discovery")
  ]
}), createdAt);
assert.equal(twoSourcesWithoutDomains.level, "L2");

const l3 = buildProspectVerificationReport(opportunity({
  sourceEvidence: [
    evidence("registry-a", "identity", "https://example.test/", "corroborated"),
    evidence("search-b", "discovery", "https://www.example.test/about", "corroborated")
  ]
}), createdAt);
assert.equal(l3.level, "L3");

const searchOnlyDomains = buildProspectVerificationReport(opportunity({
  sourceEvidence: [
    evidence("search-a", "discovery", "https://example.test/"),
    evidence("search-b", "discovery", "https://example.test/")
  ]
}), createdAt);
assert.equal(searchOnlyDomains.level, "L1");

const legacyBroadIdentityLabel = evidence("commercial-company-api", "identity");
delete legacyBroadIdentityLabel.fieldAuthority;
const conservativeLegacy = buildProspectVerificationReport(opportunity({
  sourceEvidence: [legacyBroadIdentityLabel]
}), createdAt);
assert.equal(conservativeLegacy.level, "L1");

const conflictingDomains = buildProspectVerificationReport(opportunity({
  sourceEvidence: [
    evidence("registry-a", "identity", "https://example.test/", "corroborated"),
    evidence("search-b", "discovery", "https://different.example/", "corroborated")
  ]
}), createdAt);
assert.equal(conflictingDomains.level, "L2");

const l4 = buildProspectVerificationReport(opportunity({
  status: "contactable",
  verifiedAt: "2026-07-16T09:00:00.000Z"
}), createdAt);
assert.equal(l4.level, "L4");

const l5 = buildProspectVerificationReport(opportunity({
  status: "contacted",
  verifiedAt: "2026-07-16T09:00:00.000Z",
  outreachState: "replied",
  lastReplyClassification: "clear_demand"
}), createdAt);
assert.equal(l5.level, "L5");

const historical = opportunity({
  createdAt: "2026-07-10T08:00:00.000Z",
  statusChangedAt: "2026-07-12T08:00:00.000Z",
  verifiedAt: "2026-07-13T08:00:00.000Z",
  sourceEvidence: [
    {
      ...evidence("registry-a", "identity", "https://example.test/", "corroborated"),
      fetchedAt: "2026-07-13T08:00:00.000Z"
    },
    {
      ...evidence("search-b", "discovery", "https://example.test/", "corroborated"),
      fetchedAt: "2026-07-14T08:00:00.000Z"
    }
  ]
});
assert.equal(
  prospectVerificationReferenceTime(historical),
  "2026-07-14T08:00:00.000Z"
);
ensureProspectVerificationReport(historical);
assert.equal(
  historical.verificationReport?.generatedAt,
  "2026-07-14T08:00:00.000Z"
);
const stableReport = historical.verificationReport;
ensureProspectVerificationReport(historical);
assert.equal(historical.verificationReport, stableReport);

console.log("prospect verification tests passed");
