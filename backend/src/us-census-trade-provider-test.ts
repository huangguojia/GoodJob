import assert from "node:assert/strict";
import {
  ProviderContractError,
  normalizeProviderTradePage,
  normalizeTradeQuery,
  providerErrorFromUnknown,
  type NormalizedTradeQuery,
  type ProviderCredential
} from "./provider-contract.js";
import {
  assertProviderRequestAllowed,
  createProviderHttpClient,
  setProviderHttpTestTransport
} from "./provider-http-client.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import { LEAD_PROVIDERS } from "./lead-providers.js";
import { TRADE_PROVIDERS } from "./trade-providers.js";
import { US_CENSUS_TRADE_PROVIDER } from "./us-census-trade-provider.js";

const baseQuery = normalizeTradeQuery({
  reporterCodes: ["842"],
  partnerCodes: ["1220"],
  flow: "import",
  hsVersion: "HS",
  commodityCodes: ["9405"],
  periods: ["202401", "202402", "202403"],
  frequency: "monthly",
  limit: 50
});

function tools() {
  return {
    http: createProviderHttpClient(US_CENSUS_TRADE_PROVIDER.networkPolicy)
  };
}

function censusHeader(flow: "import" | "export") {
  return flow === "import"
    ? [
        "GEN_VAL_MO",
        "I_COMMODITY",
        "I_COMMODITY_LDESC",
        "COMM_LVL",
        "CTY_CODE",
        "CTY_NAME",
        "YEAR",
        "MONTH",
        "LAST_UPDATE"
      ]
    : [
        "ALL_VAL_MO",
        "E_COMMODITY",
        "E_COMMODITY_LDESC",
        "COMM_LVL",
        "CTY_CODE",
        "CTY_NAME",
        "YEAR",
        "MONTH",
        "LAST_UPDATE"
      ];
}

function censusRow(
  flow: "import" | "export",
  overrides: Partial<Record<
    "value" | "commodity" | "description" | "level" | "partnerCode"
    | "partnerName" | "year" | "month" | "lastUpdate",
    string
  >> = {}
) {
  const values = {
    value: "1234567",
    commodity: "9405",
    description: "LAMPS AND LIGHTING FITTINGS",
    level: "4",
    partnerCode: "1220",
    partnerName: "Canada",
    year: "2024",
    month: "01",
    lastUpdate: "2026-07-01",
    ...overrides
  };
  return [
    values.value,
    values.commodity,
    values.description,
    values.level,
    values.partnerCode,
    values.partnerName,
    values.year,
    values.month,
    values.lastUpdate
  ];
}

function consecutiveMonths(startYear: number, startMonth: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const monthIndex = startYear * 12 + startMonth - 1 + index;
    const year = Math.floor(monthIndex / 12);
    const month = monthIndex % 12 + 1;
    return `${year}${String(month).padStart(2, "0")}`;
  });
}

async function runTrade(
  query: NormalizedTradeQuery = baseQuery,
  credential: ProviderCredential = { apiKey: " census-test-key " }
) {
  return await US_CENSUS_TRADE_PROVIDER.trade(
    { query, cursor: "" },
    credential,
    tools()
  );
}

async function expectProviderCode(
  operation: Promise<unknown>,
  code: ProviderContractError["code"],
  httpStatus?: number
) {
  await assert.rejects(operation, (error: unknown) => {
    const normalized = providerErrorFromUnknown(error, "trade");
    return normalized.code === code
      && (httpStatus === undefined || normalized.httpStatus === httpStatus);
  });
}

let requestedUrl = "";
let requestedInit: RequestInit | undefined;
setProviderHttpTestTransport(async (url, init) => {
  requestedUrl = url;
  requestedInit = init;
  return new Response(JSON.stringify([
    censusHeader("import"),
    censusRow("import"),
    censusRow("import", {
      value: "0",
      year: "2024",
      month: "02",
      lastUpdate: "2026-07-02"
    })
  ]), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
});

const importAdapterPage = await runTrade();
const importUrl = new URL(requestedUrl);
assert.equal(importUrl.origin, "https://api.census.gov");
assert.equal(importUrl.pathname, "/data/timeseries/intltrade/imports/hs");
assert.equal(importUrl.searchParams.get("time"), "from 2024-01 to 2024-03");
assert.equal(importUrl.searchParams.get("I_COMMODITY"), "9405");
assert.equal(importUrl.searchParams.get("CTY_CODE"), "1220");
assert.equal(importUrl.searchParams.get("key"), "census-test-key");
assert.match(importUrl.searchParams.get("get") || "", /GEN_VAL_MO/);
assert.match(importUrl.searchParams.get("get") || "", /I_COMMODITY_LDESC/);
assert.equal(requestedInit?.method, "GET");
assert.equal(new Headers(requestedInit?.headers).get("accept"), "application/json");

const importPage = normalizeProviderTradePage({
  provider: US_CENSUS_TRADE_PROVIDER,
  page: importAdapterPage
});
assert.equal(importPage.status, "partial_success");
assert.equal(importPage.rawCount, 2);
assert.equal(importPage.validCount, 2);
assert.equal(importPage.invalidCount, 0);
assert.equal(importPage.observations[0]?.reporterCountry, "USA");
assert.equal(importPage.observations[0]?.partnerCountry, "Canada");
assert.equal(importPage.observations[0]?.reporterCode, "842");
assert.equal(importPage.observations[0]?.partnerCode, "1220");
assert.equal(importPage.observations[0]?.tradeFlow, "IMPORT");
assert.equal(importPage.observations[0]?.classification, "CENSUS_HS_CURRENT");
assert.equal(importPage.observations[0]?.requestedClassification, "HS");
assert.equal(importPage.observations[0]?.commodityCode, "9405");
assert.equal(importPage.observations[0]?.commodityDescription, "LAMPS AND LIGHTING FITTINGS");
assert.equal(importPage.observations[0]?.period, "202401");
assert.equal(importPage.observations[0]?.tradeValueUsd, 1234567);
assert.equal(importPage.observations[0]?.netWeightKg, null);
assert.equal(importPage.observations[0]?.quantity, null);
assert.equal(importPage.observations[0]?.quantityUnit, null);
assert.equal(importPage.observations[0]?.sourceRevision, "2026-07-01");
assert.deepEqual(importPage.observations[0]?.statusFlags, [
  "REPORTER_CODE:842",
  "PARTNER_CODE:1220",
  "COMMODITY_CODE:9405",
  "HS_LEVEL:4",
  "VALUE_BASIS:GEN_VAL_MO",
  "FIELD_MAPPING:census_intltrade_hs_v1"
]);
assert.equal(importPage.observations[1]?.tradeValueUsd, 0);
assert.equal(importPage.observations[1]?.statusFlags.includes("VALUE_ZERO_REPORTED"), true);
assert.match(importPage.warnings.join("\n"), /unavailableMonths=202403/);

const exportQuery = normalizeTradeQuery({
  ...baseQuery,
  flow: "export",
  commodityCodes: ["940542"],
  periods: ["202412"]
});
setProviderHttpTestTransport(async (url) => {
  requestedUrl = url;
  return new Response(JSON.stringify([
    censusHeader("export"),
    censusRow("export", {
      commodity: "940542",
      description: "ELECTRIC CEILING OR WALL LIGHTING FITTINGS",
      level: "6",
      year: "2024",
      month: "12",
      value: "7654321"
    })
  ]), { status: 200 });
});
const exportAdapterPage = await runTrade(exportQuery);
const exportUrl = new URL(requestedUrl);
assert.equal(exportUrl.pathname, "/data/timeseries/intltrade/exports/hs");
assert.equal(exportUrl.searchParams.get("E_COMMODITY"), "940542");
assert.match(exportUrl.searchParams.get("get") || "", /ALL_VAL_MO/);
assert.equal(exportUrl.searchParams.has("GEN_VAL_MO"), false);
const exportPage = normalizeProviderTradePage({
  provider: US_CENSUS_TRADE_PROVIDER,
  page: exportAdapterPage
});
assert.equal(exportPage.observations[0]?.tradeFlow, "EXPORT");
assert.equal(exportPage.observations[0]?.tradeValueUsd, 7654321);
assert.equal(exportPage.observations[0]?.statusFlags.includes("VALUE_BASIS:ALL_VAL_MO"), true);

for (const commodityCode of ["94", "9405", "940542"]) {
  setProviderHttpTestTransport(async () =>
    new Response(JSON.stringify([censusHeader("import")]), { status: 200 })
  );
  await runTrade(normalizeTradeQuery({
    ...baseQuery,
    commodityCodes: [commodityCode],
    periods: ["202401"]
  }));
}
const thirtySixMonths = consecutiveMonths(2022, 1, 36);
await runTrade({
  ...baseQuery,
  periods: thirtySixMonths
});

const invalidQueries: Array<Partial<NormalizedTradeQuery>> = [
  { reporterCodes: ["156"] },
  { reporterCodes: ["842", "156"] },
  { partnerCodes: ["220"] },
  { partnerCodes: ["1220", "5700"] },
  { hsVersion: "HS2022" },
  { frequency: "annual", periods: ["2024"] },
  { commodityCodes: ["94054210"] },
  { commodityCodes: ["94", "9405"] },
  { periods: ["202401", "202403"] },
  { periods: consecutiveMonths(2021, 1, 37) }
];
for (const override of invalidQueries) {
  const query = {
    ...baseQuery,
    ...override
  } as NormalizedTradeQuery;
  await expectProviderCode(runTrade(query), "PROVIDER_POLICY_BLOCKED");
}
await expectProviderCode(
  runTrade(baseQuery, { apiKey: "", baseUrl: "" }),
  "PROVIDER_CONNECTION_INVALID"
);
await expectProviderCode(
  runTrade(baseQuery, { apiKey: "key", baseUrl: "https://api.census.gov" }),
  "PROVIDER_POLICY_BLOCKED"
);

setProviderHttpTestTransport(async () => new Response(null, { status: 204 }));
const noContentPage = await runTrade();
assert.equal(noContentPage.observations.length, 0);
assert.match(noContentPage.warnings?.join("\n") || "", /unavailableMonths=202401,202402,202403/);

setProviderHttpTestTransport(async () => new Response("[]", { status: 200 }));
const emptyArrayPage = await runTrade();
assert.equal(emptyArrayPage.observations.length, 0);
assert.equal(emptyArrayPage.rawCount, 0);

setProviderHttpTestTransport(async () =>
  new Response(JSON.stringify([censusHeader("import")]), { status: 200 })
);
const headerOnlyPage = await runTrade();
assert.equal(headerOnlyPage.observations.length, 0);
assert.equal(headerOnlyPage.rawCount, 0);
assert.match(headerOnlyPage.warnings?.join("\n") || "", /unavailableMonths=202401,202402,202403/);

setProviderHttpTestTransport(async () =>
  new Response(JSON.stringify([
    censusHeader("import"),
    censusRow("import", { value: "" }),
    censusRow("import", { value: "not-a-number", month: "02" }),
    censusRow("import", { value: "-1", month: "02" }),
    censusRow("import", { value: "99", partnerCode: "5700", month: "01" }),
    censusRow("import", { value: "99", commodity: "9406", month: "01" }),
    censusRow("import", { value: "99", year: "2023", month: "12" }),
    censusRow("import", { value: "0", month: "03" })
  ]), { status: 200 })
);
const invalidAmountPage = await runTrade();
assert.equal(invalidAmountPage.observations.length, 1);
assert.equal(invalidAmountPage.observations[0]?.tradeValueUsd, 0);
assert.equal(invalidAmountPage.invalidCount, 6);
assert.match(invalidAmountPage.warnings?.join("\n") || "", /6 条 Census 记录/);
assert.match(invalidAmountPage.warnings?.join("\n") || "", /unavailableMonths=202401,202402/);

for (const payload of [
  { data: [] },
  [["GEN_VAL_MO"]],
  [["GEN_VAL_MO", 123]],
  [
    censusHeader("import").filter((field) => field !== "LAST_UPDATE"),
    censusRow("import").slice(0, -1)
  ]
]) {
  setProviderHttpTestTransport(async () =>
    new Response(JSON.stringify(payload), { status: 200 })
  );
  await expectProviderCode(runTrade(), "PROVIDER_SCHEMA_CHANGED");
}

for (const [status, expectedCode] of [
  [401, "PROVIDER_AUTH_FAILED"],
  [403, "PROVIDER_AUTH_FAILED"],
  [429, "PROVIDER_RATE_LIMITED"],
  [500, "PROVIDER_UNAVAILABLE"],
  [503, "PROVIDER_UNAVAILABLE"]
] as const) {
  setProviderHttpTestTransport(async () =>
    new Response("provider failure", {
      status,
      headers: status === 429 ? { "retry-after": "60" } : {}
    })
  );
  await expectProviderCode(runTrade(), expectedCode, status);
}

assertProviderRequestAllowed(
  "https://api.census.gov/data/timeseries/intltrade/imports/hs?get=GEN_VAL_MO",
  "GET",
  US_CENSUS_TRADE_PROVIDER.networkPolicy
);
assertProviderRequestAllowed(
  "https://api.census.gov/data/timeseries/intltrade/exports/hs?get=ALL_VAL_MO",
  "GET",
  US_CENSUS_TRADE_PROVIDER.networkPolicy
);
for (const blockedUrl of [
  "https://example.com/data/timeseries/intltrade/imports/hs",
  "https://api.census.gov/data/timeseries/intltrade/imports/hs/extra",
  "https://api.census.gov/data/timeseries/intltrade/imports",
  "http://api.census.gov/data/timeseries/intltrade/imports/hs"
]) {
  assert.throws(() =>
    assertProviderRequestAllowed(blockedUrl, "GET", US_CENSUS_TRADE_PROVIDER.networkPolicy)
  );
}
assert.throws(() =>
  assertProviderRequestAllowed(
    "https://api.census.gov/data/timeseries/intltrade/imports/hs",
    "POST",
    US_CENSUS_TRADE_PROVIDER.networkPolicy
  )
);

assert.equal(TRADE_PROVIDERS.includes(US_CENSUS_TRADE_PROVIDER), true);
assert.equal(LEAD_PROVIDERS.some((provider) => provider.id === US_CENSUS_TRADE_PROVIDER.id), false);
assert.equal("search" in US_CENSUS_TRADE_PROVIDER, false);
assert.equal(US_CENSUS_TRADE_PROVIDER.requiresKey, true);
assert.deepEqual(US_CENSUS_TRADE_PROVIDER.networkPolicy.allowedPaths, [
  "/data/timeseries/intltrade/imports/hs",
  "/data/timeseries/intltrade/exports/hs"
]);
assert.deepEqual(US_CENSUS_TRADE_PROVIDER.networkPolicy.allowedPathPrefixes, []);
const catalogItem = createDefaultProviderCatalog()
  .find((item) => item.code === US_CENSUS_TRADE_PROVIDER.id);
assert.equal(catalogItem?.category, "market_trade");
assert.equal(catalogItem?.sourceLevel, "market_opportunity");
assert.equal(catalogItem?.capabilities.includes("trade"), true);
assert.equal(catalogItem?.allowedFields.includes("company"), false);
assert.equal(catalogItem?.allowedFields.includes("sourceRevision"), true);
assert.deepEqual(catalogItem?.defaultRatePolicy, {
  cacheTtlSeconds: 86400,
  maxConcurrentPerConnection: 1,
  minIntervalMs: 1000,
  requestsPerMinute: 30
});

setProviderHttpTestTransport(null);
console.log("US Census trade provider tests passed");
