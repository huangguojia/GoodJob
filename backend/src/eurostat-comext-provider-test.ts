import assert from "node:assert/strict";
import {
  ProviderContractError,
  normalizeProviderTradePage,
  normalizeTradeQuery,
  providerErrorFromUnknown,
  type NormalizedTradeQuery
} from "./provider-contract.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import {
  assertProviderRequestAllowed,
  createProviderHttpClient,
  setProviderHttpTestTransport
} from "./provider-http-client.js";
import { EUROSTAT_COMEXT_PROVIDER } from "./eurostat-comext-provider.js";
import { LEAD_PROVIDERS } from "./lead-providers.js";
import { TRADE_PROVIDERS } from "./trade-providers.js";

const baseQuery = normalizeTradeQuery({
  reporterCodes: ["276"],
  partnerCodes: ["156"],
  flow: "import",
  hsVersion: "HS",
  commodityCodes: ["9405"],
  periods: ["202401", "202402", "202403"],
  frequency: "monthly",
  limit: 50
});

function tools() {
  return {
    http: createProviderHttpClient(EUROSTAT_COMEXT_PROVIDER.networkPolicy)
  };
}

function responsePayload() {
  return {
    version: "2.0",
    class: "dataset",
    updated: "2026-07-01T12:00:00Z",
    id: ["freq", "reporter", "partner", "product", "flow", "indicators", "time"],
    size: [1, 1, 1, 1, 1, 3, 3],
    dimension: {
      freq: { category: { index: { M: 0 }, label: { M: "Monthly" } } },
      reporter: { category: { index: { DE: 0 }, label: { DE: "Germany" } } },
      partner: { category: { index: { CN: 0 }, label: { CN: "China" } } },
      product: {
        category: {
          index: { "9405": 0 },
          label: { "9405": "Lamps and lighting fittings" }
        }
      },
      flow: { category: { index: { "1": 0 }, label: { "1": "Import" } } },
      indicators: {
        category: {
          index: {
            VALUE_IN_EUROS: 0,
            QUANTITY_IN_100KG: 1,
            SUPPLEMENTARY_QUANTITY: 2
          }
        }
      },
      time: {
        category: {
          index: {
            "2024-01": 0,
            "2024-02": 1,
            "2024-03": 2
          }
        }
      }
    },
    value: {
      "0": 1000,
      "2": 3000,
      "3": 2,
      "4": 0,
      "6": 10,
      "8": 30
    }
  };
}

let requestedUrl = "";
let requestedInit: RequestInit | undefined;
setProviderHttpTestTransport(async (url, init) => {
  requestedUrl = url;
  requestedInit = init;
  return new Response(JSON.stringify(responsePayload()), { status: 200 });
});

const adapterPage = await EUROSTAT_COMEXT_PROVIDER.trade(
  { query: baseQuery, cursor: "" },
  { apiKey: "" },
  tools()
);
const requestUrl = new URL(requestedUrl);
assert.equal(requestUrl.origin, "https://ec.europa.eu");
assert.equal(
  requestUrl.pathname,
  "/eurostat/api/comext/dissemination/statistics/1.0/data/DS-045409"
);
assert.equal(requestUrl.searchParams.get("freq"), "M");
assert.equal(requestUrl.searchParams.get("reporter"), "DE");
assert.equal(requestUrl.searchParams.get("partner"), "CN");
assert.equal(requestUrl.searchParams.get("product"), "9405");
assert.equal(requestUrl.searchParams.get("flow"), "1");
assert.equal(requestUrl.searchParams.get("sinceTimePeriod"), "2024-01");
assert.equal(requestUrl.searchParams.get("untilTimePeriod"), "2024-03");
assert.equal(requestedInit?.method, "GET");

const page = normalizeProviderTradePage({
  provider: EUROSTAT_COMEXT_PROVIDER,
  page: adapterPage
});
assert.equal(page.status, "success");
assert.equal(page.observations.length, 3);
assert.equal(page.observations[0]?.reporterCountry, "Germany");
assert.equal(page.observations[0]?.partnerCountry, "China");
assert.equal(page.observations[0]?.tradeFlow, "IMPORT");
assert.equal(page.observations[0]?.classification, "EUROSTAT_COMEXT_CN");
assert.equal(page.observations[0]?.commodityDescription, "Lamps and lighting fittings");
assert.equal(page.observations[0]?.period, "202401");
assert.equal(page.observations[0]?.tradeValueUsd, null);
assert.equal(page.observations[0]?.netWeightKg, 200);
assert.equal(page.observations[0]?.quantity, 10);
assert.equal(page.observations[0]?.quantityUnit, "supplementary unit");
assert.equal(page.observations[0]?.statusFlags.includes("VALUE_EUR:1000"), true);
assert.equal(page.observations[0]?.statusFlags.includes("TRADE_VALUE_USD_NOT_CONVERTED"), true);
assert.equal(page.observations[1]?.tradeValueUsd, null);
assert.equal(page.observations[1]?.netWeightKg, 0);
assert.equal(page.observations[1]?.suppressed, false);
assert.equal(page.observations[2]?.netWeightKg, null);
assert.equal(page.observations[2]?.quantity, 30);
assert.equal(page.observations[2]?.sourceRevision, "2026-07-01T12:00:00Z");

async function expectPolicy(query: NormalizedTradeQuery, baseUrl = "") {
  await assert.rejects(
    EUROSTAT_COMEXT_PROVIDER.trade(
      { query, cursor: "" },
      { apiKey: "", baseUrl },
      tools()
    ),
    (error: unknown) =>
      providerErrorFromUnknown(error, "trade").code === "PROVIDER_POLICY_BLOCKED"
  );
}

for (const override of [
  { reporterCodes: ["842"] },
  { partnerCodes: ["999"] },
  { reporterCodes: ["276", "250"] },
  { partnerCodes: ["156", "842"] },
  { hsVersion: "HS2022" },
  { frequency: "annual", periods: ["2024"] },
  { commodityCodes: ["94054210"] },
  { commodityCodes: ["94", "9405"] },
  { periods: ["202401", "202403"] }
] as Array<Partial<NormalizedTradeQuery>>) {
  await expectPolicy({ ...baseQuery, ...override } as NormalizedTradeQuery);
}
await expectPolicy(baseQuery, "https://ec.europa.eu");

setProviderHttpTestTransport(async () =>
  new Response(JSON.stringify({ ...responsePayload(), id: ["freq"] }), { status: 200 })
);
await assert.rejects(
  EUROSTAT_COMEXT_PROVIDER.trade(
    { query: baseQuery, cursor: "" },
    { apiKey: "" },
    tools()
  ),
  (error: unknown) => error instanceof ProviderContractError
    && error.code === "PROVIDER_SCHEMA_CHANGED"
);

assertProviderRequestAllowed(
  "https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data/DS-045409?freq=M",
  "GET",
  EUROSTAT_COMEXT_PROVIDER.networkPolicy
);
assert.throws(() =>
  assertProviderRequestAllowed(
    "https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data/OTHER",
    "GET",
    EUROSTAT_COMEXT_PROVIDER.networkPolicy
  )
);

assert.equal(TRADE_PROVIDERS.includes(EUROSTAT_COMEXT_PROVIDER), true);
assert.equal(LEAD_PROVIDERS.some((provider) => provider.id === EUROSTAT_COMEXT_PROVIDER.id), false);
const catalogItem = createDefaultProviderCatalog()
  .find((item) => item.code === EUROSTAT_COMEXT_PROVIDER.id);
assert.equal(catalogItem?.category, "market_trade");
assert.equal(catalogItem?.allowedFields.includes("company"), false);
assert.equal(catalogItem?.allowedFields.includes("tradeValueUsd"), true);

setProviderHttpTestTransport(null);
console.log("Eurostat Comext provider tests passed");
