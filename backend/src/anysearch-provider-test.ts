import assert from "node:assert/strict";
import { getProvider } from "./lead-providers.js";

const provider = getProvider("anysearch");
assert.ok(provider?.search, "AnySearch provider must be registered with search support");

let requestedUrl = "";
let requestedInit: RequestInit | undefined;
const page = await provider.search(
  {
    query: {
      goal: "开发德国工业泵经销商",
      productKeywords: ["industrial pump"],
      countries: ["Germany"],
      industries: ["water treatment"],
      customerTypes: ["Distributor"],
      excludeKeywords: [],
      limit: 20
    },
    cursor: ""
  },
  { apiKey: "anysearch-test-key" },
  {
    http: {
      async fetch(url, init) {
        requestedUrl = url;
        requestedInit = init;
        return new Response(JSON.stringify({
          code: 0,
          message: "success",
          request_id: "req_test_anysearch",
          data: {
            results: [
              {
                title: "Berlin Pump Technik GmbH - Industrial Pumps",
                url: "https://berlin-pump.example/products",
                snippet: "Industrial pump distributor for water treatment plants in Germany.",
                score: 0.72
              },
              {
                title: "LinkedIn directory result",
                url: "https://linkedin.com/company/not-a-direct-source",
                snippet: "Directory page should not become a company candidate."
              }
            ],
            metadata: {
              total_results: 2,
              search_time_ms: 42
            }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  }
);

assert.equal(requestedUrl, "https://api.anysearch.com/v1/search");
assert.equal(requestedInit?.method, "POST");
const headers = new Headers(requestedInit?.headers);
assert.equal(headers.get("authorization"), "Bearer anysearch-test-key");
assert.equal(headers.get("content-type"), "application/json");
const requestBody = JSON.parse(String(requestedInit?.body || "{}"));
assert.match(requestBody.query, /industrial pump/u);
assert.equal(requestBody.max_results, 20);
assert.deepEqual(requestBody.content_types, ["web"]);
assert.equal(page.rawCount, 2);
assert.equal(page.invalidCount, 1);
assert.equal(page.records.length, 1);
assert.equal(page.records[0]?.company, "Berlin Pump Technik GmbH");
assert.equal(page.records[0]?.officialWebsite, "https://berlin-pump.example");
assert.equal(page.records[0]?.sourceUrl, "https://berlin-pump.example/products");
assert.equal(page.records[0]?.recordType, "discovery_page");
assert.equal(page.records[0]?.confidence, 72);
assert.match(page.records[0]?.evidenceSummary || "", /Industrial pump/u);

let anonymousHeader = "";
await provider.health(
  { apiKey: "" },
  {
    http: {
      async fetch(_url, init) {
        anonymousHeader = new Headers(init?.headers).get("authorization") || "";
        return new Response(JSON.stringify({
          code: 0,
          data: { results: [{ title: "Supplier", url: "https://supplier.example", snippet: "Supplier" }] }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  }
);
assert.equal(anonymousHeader, "");

console.log(JSON.stringify({
  ok: true,
  provider: provider.id,
  officialApi: requestedUrl,
  normalizedRecords: page.records.length,
  anonymousHealth: true
}, null, 2));
