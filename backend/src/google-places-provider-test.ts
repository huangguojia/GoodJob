import assert from "node:assert/strict";
import { getProvider } from "./lead-providers.js";

const provider = getProvider("google_places");
assert.ok(provider?.search, "Google Places provider must be registered with search support");

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
  { apiKey: "google-places-test-key" },
  {
    http: {
      async fetch(url, init) {
        requestedUrl = url;
        requestedInit = init;
        return new Response(JSON.stringify({
          places: [{
            id: "ChIJ-test-place",
            displayName: { text: "Berlin Pump Technik GmbH" },
            formattedAddress: "Industriestrasse 8, Berlin, Germany",
            internationalPhoneNumber: "+49 30 123456",
            websiteUri: "https://berlin-pump.example",
            businessStatus: "OPERATIONAL",
            types: ["industrial_equipment_supplier"],
            googleMapsUri: "https://maps.google.com/?cid=123"
          }],
          nextPageToken: "next-page"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  }
);

assert.equal(requestedUrl, "https://places.googleapis.com/v1/places:searchText");
assert.equal(requestedInit?.method, "POST");
const headers = new Headers(requestedInit?.headers);
assert.equal(headers.get("X-Goog-Api-Key"), "google-places-test-key");
assert.match(headers.get("X-Goog-FieldMask") || "", /places\.websiteUri/u);
const requestBody = JSON.parse(String(requestedInit?.body || "{}"));
assert.match(requestBody.textQuery, /industrial pump/u);
assert.equal(requestBody.regionCode, "de");
assert.equal(page.records.length, 1);
assert.equal(page.records[0]?.company, "Berlin Pump Technik GmbH");
assert.equal(page.records[0]?.recordType, "discovery_page");
assert.equal(page.records[0]?.providerRecordId, "ChIJ-test-place");
assert.equal(page.records[0]?.contactInfo, "+49 30 123456");
assert.equal(page.records[0]?.sourceUrl, "https://maps.google.com/?cid=123");
assert.equal(page.nextCursor, "next-page");
assert.equal(page.exhausted, false);

console.log(JSON.stringify({
  ok: true,
  provider: provider.id,
  officialApi: requestedUrl,
  normalizedRecords: page.records.length,
  pagination: page.nextCursor
}, null, 2));
