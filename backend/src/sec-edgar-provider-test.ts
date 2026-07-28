import assert from "node:assert/strict";
import {
  ProviderContractError,
  normalizeProviderPage,
  normalizeProviderQuery,
  providerErrorFromUnknown
} from "./provider-contract.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import { createProviderHttpClient, setProviderHttpTestTransport } from "./provider-http-client.js";
import { LEAD_PROVIDERS } from "./lead-providers.js";
import { SEC_EDGAR_PROVIDER } from "./sec-edgar-provider.js";

const query = normalizeProviderQuery({
  goal: "find Apple public company",
  productKeywords: "Apple",
  countries: "United States",
  industry: "technology",
  customerType: "",
  excludeKeywords: "Applied",
  limit: 5
});

function tools() {
  return {
    http: createProviderHttpClient(SEC_EDGAR_PROVIDER.networkPolicy)
  };
}

let requestedUrl = "";
let requestedInit: RequestInit | undefined;
setProviderHttpTestTransport(async (url, init) => {
  requestedUrl = url;
  requestedInit = init;
  return new Response(JSON.stringify({
    "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
    "1": { cik_str: 1090872, ticker: "A", title: "Agilent Technologies Inc." },
    "2": { cik_str: 6951, ticker: "AMAT", title: "Applied Materials Inc." }
  }), { status: 200 });
});

const adapterPage = await SEC_EDGAR_PROVIDER.search!(
  { query, cursor: "" },
  { apiKey: "GoodJobCRM admin@example.com" },
  tools()
);
assert.equal(requestedUrl, "https://www.sec.gov/files/company_tickers.json");
assert.equal(new Headers(requestedInit?.headers).get("user-agent"), "GoodJobCRM admin@example.com");
assert.equal(adapterPage.rawCount, 3);
assert.equal(adapterPage.records.length, 1);
assert.equal(adapterPage.records[0]?.company, "Apple Inc.");
assert.equal(adapterPage.records[0]?.providerRecordId, "CIK:0000320193");
assert.equal(adapterPage.records[0]?.recordType, "identity_evidence");
assert.match(adapterPage.records[0]?.sourceUrl || "", /CIK=0000320193/);

setProviderHttpTestTransport(async (url, init) => {
  requestedUrl = url;
  requestedInit = init;
  return new Response(JSON.stringify({
    cik: "0000320193",
    name: "Apple Inc.",
    tickers: ["AAPL"],
    exchanges: ["Nasdaq"],
    sicDescription: "Electronic Computers",
    stateOfIncorporation: "CA"
  }));
});
const exactCikPage = await SEC_EDGAR_PROVIDER.search!(
  {
    query: normalizeProviderQuery({
      goal: "verify SEC registrant",
      productKeywords: "CIK:320193",
      countries: "United States",
      industry: "",
      customerType: "",
      excludeKeywords: "",
      limit: 5
    }),
    cursor: ""
  },
  { apiKey: "GoodJobCRM admin@example.com" },
  tools()
);
assert.equal(requestedUrl, "https://data.sec.gov/submissions/CIK0000320193.json");
assert.equal(new Headers(requestedInit?.headers).get("user-agent"), "GoodJobCRM admin@example.com");
assert.equal(exactCikPage.records.length, 1);
assert.equal(exactCikPage.records[0]?.providerRecordId, "CIK:0000320193");
assert.equal(exactCikPage.records[0]?.confidence, 98);
assert.match(exactCikPage.usage?.display || "", /精确核验/);

setProviderHttpTestTransport(async () => new Response("{}", { status: 404 }));
const missingCikPage = await SEC_EDGAR_PROVIDER.search!(
  {
    query: normalizeProviderQuery({
      goal: "verify SEC registrant",
      productKeywords: "CIK:320193",
      countries: "United States",
      industry: "",
      customerType: "",
      excludeKeywords: "",
      limit: 5
    }),
    cursor: ""
  },
  { apiKey: "GoodJobCRM admin@example.com" },
  tools()
);
assert.equal(missingCikPage.records.length, 0);
assert.match(missingCikPage.usage?.display || "", /未找到/);

setProviderHttpTestTransport(async () => new Response(JSON.stringify({
  cik: "0000789019",
  name: "Wrong Registrant",
  tickers: [],
  exchanges: []
})));
await assert.rejects(
  SEC_EDGAR_PROVIDER.search!(
    {
      query: normalizeProviderQuery({
        goal: "verify SEC registrant",
        productKeywords: "CIK:320193",
        countries: "United States",
        industry: "",
        customerType: "",
        excludeKeywords: "",
        limit: 5
      }),
      cursor: ""
    },
    { apiKey: "GoodJobCRM admin@example.com" },
    tools()
  ),
  (error: unknown) => error instanceof ProviderContractError
    && error.code === "PROVIDER_SCHEMA_CHANGED"
);

const catalogItem = createDefaultProviderCatalog()
  .find((item) => item.code === SEC_EDGAR_PROVIDER.id)!;
const normalizedPage = normalizeProviderPage({
  provider: SEC_EDGAR_PROVIDER,
  catalogPolicyVersion: catalogItem.version,
  sourceLevel: catalogItem.sourceLevel,
  allowedFields: catalogItem.allowedFields,
  retentionPolicy: catalogItem.retentionPolicy,
  page: adapterPage
});
assert.equal(normalizedPage.status, "success");
assert.equal(normalizedPage.validCount, 1);
assert.equal(normalizedPage.records[0]?.recordType, "identity_evidence");
assert.equal(normalizedPage.records[0]?.sourceLevel, "identity");

for (const credential of [
  { apiKey: "" },
  { apiKey: "anonymous-client" },
  { apiKey: "GoodJobCRM admin@example.com", baseUrl: "https://www.sec.gov" }
]) {
  await assert.rejects(
    SEC_EDGAR_PROVIDER.search!(
      { query, cursor: "" },
      credential,
      tools()
    ),
    (error: unknown) => {
      const normalized = providerErrorFromUnknown(error, "search");
      return normalized.code === (credential.baseUrl
        ? "PROVIDER_POLICY_BLOCKED"
        : "PROVIDER_CONNECTION_INVALID");
    }
  );
}

let transportCalls = 0;
setProviderHttpTestTransport(async () => {
  transportCalls += 1;
  return new Response("{}");
});
const noKeywordPage = await SEC_EDGAR_PROVIDER.search!(
  {
    query: normalizeProviderQuery({
      goal: "find buyers",
      productKeywords: "",
      countries: "",
      industry: "",
      customerType: "",
      excludeKeywords: "",
      limit: 5
    }),
    cursor: ""
  },
  { apiKey: "GoodJobCRM admin@example.com" },
  tools()
);
assert.equal(transportCalls, 0);
assert.equal(noKeywordPage.records.length, 0);
assert.equal(noKeywordPage.usage?.requestCount, 0);

setProviderHttpTestTransport(async () =>
  new Response(JSON.stringify({
    "0": { cik_str: "invalid", ticker: "AAPL", title: "Apple Inc." }
  }), { status: 200 })
);
await assert.rejects(
  SEC_EDGAR_PROVIDER.search!(
    { query, cursor: "" },
    { apiKey: "GoodJobCRM admin@example.com" },
    tools()
  ),
  (error: unknown) => error instanceof ProviderContractError
    && error.code === "PROVIDER_SCHEMA_CHANGED"
);

assert.equal(LEAD_PROVIDERS.includes(SEC_EDGAR_PROVIDER), true);
assert.equal(SEC_EDGAR_PROVIDER.requiresKey, true);
assert.equal(SEC_EDGAR_PROVIDER.adapterVersion, "1.1.0");
assert.equal(catalogItem.category, "company");
assert.equal(catalogItem.defaultRatePolicy.minIntervalMs, 120);

setProviderHttpTestTransport(null);
console.log("SEC EDGAR provider tests passed");
