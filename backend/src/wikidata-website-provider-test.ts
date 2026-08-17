import assert from "node:assert/strict";
import { getProvider } from "./lead-providers.js";

const provider = getProvider("wikidata");
assert.ok(provider?.search, "Wikidata provider must support search");

const requests: string[] = [];
const page = await provider.search(
  {
    query: {
      goal: "Northstar Lighting official website",
      productKeywords: ["Northstar Lighting"],
      countries: ["United States"],
      industries: ["lighting"],
      customerTypes: ["company"],
      excludeKeywords: [],
      limit: 5
    },
    cursor: ""
  },
  { apiKey: "" },
  {
    http: {
      async fetch(url) {
        requests.push(url);
        const action = new URL(url).searchParams.get("action");
        if (action === "wbsearchentities") {
          return new Response(JSON.stringify({
            search: [{
              id: "Q123",
              label: "Northstar Lighting",
              description: "American lighting company",
              concepturi: "https://www.wikidata.org/wiki/Q123"
            }]
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          entities: {
            Q123: {
              claims: {
                P856: [{ mainsnak: { datavalue: { value: "https://northstar-lighting.example" } } }]
              }
            }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  }
);

assert.equal(requests.length, 2);
assert.equal(page.records.length, 1);
assert.equal(page.records[0]?.officialWebsite, "https://northstar-lighting.example");
assert.ok(page.records[0]?.matchedFields.includes("officialWebsite"));
assert.match(page.records[0]?.evidenceSummary || "", /官方网站/u);

console.log("Wikidata official website fallback test passed");
