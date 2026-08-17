import assert from "node:assert/strict";
import { aiWebsiteCitationsToProviderRecords } from "./prospect-ai-website-discovery.js";

const records = aiWebsiteCitationsToProviderRecords({
  company: "Northstar Lighting LLC",
  country: "United States",
  business: "LED lighting distributor"
}, [
  {
    title: "Northstar Lighting | Official Website",
    url: "https://northstar-lighting.example/about",
    startIndex: 0,
    endIndex: 20
  },
  {
    title: "Unsafe result",
    url: "http://unsafe.example",
    startIndex: 21,
    endIndex: 30
  }
]);

assert.equal(records.length, 1);
assert.equal(records[0]?.officialWebsite, "https://northstar-lighting.example/about");
assert.equal(records[0]?.company, "Northstar Lighting | Official Website");
assert.equal(records[0]?.sourceLevel, "discovery");
assert.equal(records[0]?.matchedFields.includes("officialWebsite"), true);

console.log("OpenAI website citation mapping test passed");
