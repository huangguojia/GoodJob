import assert from "node:assert/strict";
import { EU_TED_PROVIDER } from "./eu-ted-provider.js";
import { LEAD_PROVIDERS } from "./lead-providers.js";
import {
  normalizeProviderPage,
  normalizeProviderQuery
} from "./provider-contract.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import {
  createProviderHttpClient,
  setProviderHttpTestTransport
} from "./provider-http-client.js";
import { UK_CONTRACTS_FINDER_PROVIDER } from "./uk-contracts-finder-provider.js";
import { WORLD_BANK_PROCUREMENT_PROVIDER } from "./world-bank-procurement-provider.js";

const query = normalizeProviderQuery({
  goal: "find solar lighting buyers",
  productKeywords: "solar lighting",
  countries: "",
  industry: "renewable energy",
  customerType: "public buyer",
  excludeKeywords: "consulting",
  limit: 5
});

function tools(provider: typeof EU_TED_PROVIDER) {
  return { http: createProviderHttpClient(provider.networkPolicy) };
}

let requestedUrl = "";
let requestedBody = "";
setProviderHttpTestTransport(async (url, init) => {
  requestedUrl = url;
  requestedBody = String(init.body || "");
  return new Response(JSON.stringify({
    notices: [{
      "publication-number": "123456-2026",
      "notice-title": { eng: "Supply and installation of solar lighting" },
      "buyer-name": { eng: ["City of Example"] },
      "buyer-country": ["ESP"],
      "publication-date": "2026-07-15+02:00",
      deadline: "2026-08-30+02:00",
      "classification-cpv": ["31527200"],
      "notice-type": "competition",
      links: {
        html: {
          ENG: "https://ted.europa.eu/en/notice/-/detail/123456-2026"
        }
      }
    }],
    totalNoticeCount: 1,
    timedOut: false
  }), { status: 200 });
});

const tedPage = await EU_TED_PROVIDER.search!(
  { query, cursor: "" },
  { apiKey: "" },
  tools(EU_TED_PROVIDER)
);
assert.equal(requestedUrl, "https://api.ted.europa.eu/v3/notices/search");
assert.match(requestedBody, /FT ~ \(solar lighting\)/);
assert.match(requestedBody, /SORT BY PD DESC/);
assert.equal(tedPage.records[0]?.company, "City of Example");
assert.equal(tedPage.records[0]?.recordType, "business_signal");

setProviderHttpTestTransport(async (url) => {
  requestedUrl = url;
  return new Response(JSON.stringify({
    total: "1",
    procnotices: [{
      id: "OP00999999",
      notice_type: "Invitation for Bids",
      noticedate: "15-Jul-2026",
      notice_status: "Published",
      submission_deadline_date: "2026-08-30T00:00:00Z",
      project_ctry_name: "Nigeria",
      project_id: "P123456",
      project_name: "Renewable Energy Project",
      bid_reference_no: "NG-SOLAR-001",
      bid_description: "Supply and installation of solar lighting",
      procurement_method_name: "Request for Bids",
      contact_email: "buyer@example.org",
      contact_name: "Jane Buyer",
      contact_organization: "Example Energy Agency"
    }]
  }), { status: 200 });
});

const worldBankPage = await WORLD_BANK_PROCUREMENT_PROVIDER.search!(
  { query, cursor: "" },
  { apiKey: "" },
  tools(WORLD_BANK_PROCUREMENT_PROVIDER)
);
assert.match(requestedUrl, /qterm=solar\+lighting/);
assert.equal(worldBankPage.records[0]?.company, "Example Energy Agency");
assert.equal(worldBankPage.records[0]?.contactInfo, "buyer@example.org");
assert.equal(worldBankPage.records[0]?.recordType, "business_signal");

setProviderHttpTestTransport(async (url, init) => {
  requestedUrl = url;
  requestedBody = String(init.body || "");
  return new Response(JSON.stringify({
    hitCount: 1,
    noticeList: [{
      item: {
        id: "notice-001",
        noticeIdentifier: "CF-001",
        title: "Solar lighting framework",
        description: "Supply of solar lighting for public buildings",
        publishedDate: "2026-07-15T00:00:00Z",
        deadlineDate: "2026-08-30T00:00:00Z",
        noticeType: "Contract",
        noticeStatus: "Open",
        organisationName: "Example Borough Council",
        regionText: "London",
        isSuitableForSme: true
      }
    }]
  }), { status: 200 });
});

const contractsFinderPage = await UK_CONTRACTS_FINDER_PROVIDER.search!(
  { query, cursor: "" },
  { apiKey: "" },
  tools(UK_CONTRACTS_FINDER_PROVIDER)
);
assert.equal(
  requestedUrl,
  "https://www.contractsfinder.service.gov.uk/api/rest/2/search_notices/json"
);
assert.match(requestedBody, /"keyword":"solar lighting"/);
assert.equal(contractsFinderPage.records[0]?.company, "Example Borough Council");
assert.match(contractsFinderPage.records[0]?.description || "", /适合中小企业参与/);

for (const provider of [
  EU_TED_PROVIDER,
  WORLD_BANK_PROCUREMENT_PROVIDER,
  UK_CONTRACTS_FINDER_PROVIDER
]) {
  assert.equal(provider.requiresKey, false);
  assert.equal(provider.tier, "free");
  assert.equal(LEAD_PROVIDERS.includes(provider), true);
  const catalog = createDefaultProviderCatalog()
    .find((item) => item.code === provider.id)!;
  assert.equal(catalog.sourceLevel, "business_signal");
  assert.equal(catalog.licensePolicy.requiresKey, false);
  assert.equal(catalog.defaultRatePolicy.requestsPerMinute, 30);
  const page = provider === EU_TED_PROVIDER
    ? tedPage
    : provider === WORLD_BANK_PROCUREMENT_PROVIDER
      ? worldBankPage
      : contractsFinderPage;
  const normalized = normalizeProviderPage({
    provider,
    catalogPolicyVersion: catalog.version,
    sourceLevel: catalog.sourceLevel,
    allowedFields: catalog.allowedFields,
    retentionPolicy: catalog.retentionPolicy,
    page
  });
  assert.equal(normalized.validCount, 1);
  assert.equal(normalized.records[0]?.recordType, "business_signal");
}

let transportCalls = 0;
setProviderHttpTestTransport(async () => {
  transportCalls += 1;
  return new Response("{}");
});
const skippedUk = await UK_CONTRACTS_FINDER_PROVIDER.search!(
  {
    query: normalizeProviderQuery({
      goal: "find buyers",
      productKeywords: "solar",
      countries: "Germany",
      industry: "",
      customerType: "",
      excludeKeywords: "",
      limit: 5
    }),
    cursor: ""
  },
  { apiKey: "" },
  tools(UK_CONTRACTS_FINDER_PROVIDER)
);
assert.equal(transportCalls, 0);
assert.equal(skippedUk.records.length, 0);
assert.equal(skippedUk.usage?.requestCount, 0);

setProviderHttpTestTransport(null);
console.log("Procurement provider tests passed");
