import assert from "node:assert/strict";
import {
  ProviderContractError,
  normalizeProviderTradePage,
  normalizeTradeQuery,
  providerErrorFromUnknown
} from "./provider-contract.js";
import { createProviderHttpClient, setProviderHttpTestTransport } from "./provider-http-client.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import { LEAD_PROVIDERS } from "./lead-providers.js";
import { TRADE_PROVIDERS } from "./trade-providers.js";
import { UN_COMTRADE_PROVIDER } from "./un-comtrade-provider.js";

const baseQuery = normalizeTradeQuery({
  reporterCodes: ["842"],
  partnerCodes: ["0"],
  flow: "import",
  hsVersion: "HS2022",
  commodityCodes: ["940542"],
  periods: ["2023"],
  frequency: "annual",
  limit: 5
});

function tools() {
  return {
    http: createProviderHttpClient(UN_COMTRADE_PROVIDER.networkPolicy)
  };
}

function comtradeRecord(overrides: Record<string, unknown> = {}) {
  return {
    reporterCode: 842,
    reporterISO: "USA",
    reporterDesc: "United States of America",
    partnerCode: 0,
    partnerISO: "W00",
    partnerDesc: "World",
    flowCode: "M",
    classificationCode: "H6",
    classificationSearchCode: "HS",
    cmdCode: "940542",
    period: "2023",
    qtyUnitAbbr: "kg",
    qty: 62528615.027,
    netWgt: 62528615.027,
    primaryValue: 2061149344,
    isAggregate: true,
    isReported: true,
    isOriginalClassification: true,
    aggregateLevel: 6,
    ...overrides
  };
}

let requestedUrl = "";
setProviderHttpTestTransport(async (url) => {
  requestedUrl = url;
  return new Response(JSON.stringify({
    count: 1,
    data: [comtradeRecord()]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
});

const previewAdapterPage = await UN_COMTRADE_PROVIDER.trade(
  { query: baseQuery, cursor: "" },
  { apiKey: "" },
  tools()
);
const previewUrl = new URL(requestedUrl);
assert.equal(previewUrl.origin, "https://comtradeapi.un.org");
assert.equal(previewUrl.pathname, "/public/v1/preview/C/A/HS");
assert.equal(previewUrl.searchParams.get("period"), "2023");
assert.equal(previewUrl.searchParams.get("reporterCode"), "842");
assert.equal(previewUrl.searchParams.get("partnerCode"), "0");
assert.equal(previewUrl.searchParams.get("cmdCode"), "940542");
assert.equal(previewUrl.searchParams.get("flowCode"), "M");
assert.equal(previewUrl.searchParams.get("maxRecords"), "5");
assert.equal(previewUrl.searchParams.get("includeDesc"), "true");
assert.equal(previewUrl.searchParams.has("subscription-key"), false);

const previewPage = normalizeProviderTradePage({
  provider: UN_COMTRADE_PROVIDER,
  page: previewAdapterPage
});
assert.equal(previewPage.status, "partial_success");
assert.equal(previewPage.validCount, 1);
assert.equal(previewPage.observations[0]?.reporterCountry, "USA");
assert.equal(previewPage.observations[0]?.partnerCountry, "WORLD");
assert.equal(previewPage.observations[0]?.tradeFlow, "IMPORT");
assert.equal(previewPage.observations[0]?.classification, "HS2017");
assert.equal(previewPage.observations[0]?.requestedClassification, "HS2022");
assert.equal(previewPage.observations[0]?.tradeValueUsd, 2061149344);
assert.equal(previewPage.observations[0]?.netWeightKg, 62528615.027);
assert.equal(previewPage.observations[0]?.quantity, 62528615.027);
assert.equal(previewPage.observations[0]?.quantityUnit, "kg");
assert.equal(previewPage.observations[0]?.isAggregate, true);
assert.match(previewPage.warnings[0] || "", /HS2022->HS2017/);
assert.equal(previewPage.exhausted, true);

setProviderHttpTestTransport(async () =>
  new Response(JSON.stringify({
    count: 1,
    data: [comtradeRecord({ classificationCode: "H7" })]
  }), { status: 200 })
);
const limitedQuery = normalizeTradeQuery({
  ...baseQuery,
  limit: 1
});
const limitedAdapterPage = await UN_COMTRADE_PROVIDER.trade(
  { query: limitedQuery, cursor: "" },
  { apiKey: "" },
  tools()
);
assert.equal(limitedAdapterPage.exhausted, false);
assert.match(limitedAdapterPage.warnings?.join("\n") || "", /数据可能不完整/);

const validationQuery = normalizeTradeQuery({
  ...baseQuery,
  limit: 20
});
setProviderHttpTestTransport(async () =>
  new Response(JSON.stringify({
    count: 10,
    data: [
      comtradeRecord({ classificationCode: "H7" }),
      comtradeRecord({ reporterCode: 156 }),
      comtradeRecord({ partnerCode: 156 }),
      comtradeRecord({ cmdCode: "940541" }),
      comtradeRecord({ period: "2022" }),
      comtradeRecord({ flowCode: "X" }),
      comtradeRecord({ flowCode: "UNKNOWN" }),
      comtradeRecord({ primaryValue: -1 }),
      comtradeRecord({ netWgt: -1 }),
      comtradeRecord({ qty: -1 })
    ]
  }), { status: 200 })
);
const validatedAdapterPage = await UN_COMTRADE_PROVIDER.trade(
  { query: validationQuery, cursor: "" },
  { apiKey: "" },
  tools()
);
assert.equal(validatedAdapterPage.observations.length, 1);
assert.equal(validatedAdapterPage.invalidCount, 9);
assert.equal(validatedAdapterPage.observations[0]?.reporterCode, "842");
assert.equal(validatedAdapterPage.observations[0]?.partnerCode, "0");
assert.equal(validatedAdapterPage.observations[0]?.commodityCode, "940542");
assert.equal(validatedAdapterPage.observations[0]?.period, "2023");
assert.equal(validatedAdapterPage.observations[0]?.tradeFlow, "IMPORT");
assert.match(validatedAdapterPage.warnings?.join("\n") || "", /9 条 UN Comtrade 记录/);

setProviderHttpTestTransport(async (url) => {
  requestedUrl = url;
  return new Response(JSON.stringify({
    count: 1,
    data: [comtradeRecord({
      classificationCode: "H7",
      primaryValue: null,
      netWgt: null,
      qty: null,
      qtyUnitAbbr: null,
      isReported: false
    })]
  }), { status: 200 });
});

const keyedAdapterPage = await UN_COMTRADE_PROVIDER.trade(
  { query: baseQuery, cursor: "" },
  { apiKey: "private-test-key" },
  tools()
);
const keyedUrl = new URL(requestedUrl);
assert.equal(keyedUrl.pathname, "/data/v1/get/C/A/HS");
assert.equal(keyedUrl.searchParams.get("subscription-key"), "private-test-key");
const keyedPage = normalizeProviderTradePage({
  provider: UN_COMTRADE_PROVIDER,
  page: keyedAdapterPage
});
assert.equal(keyedPage.status, "success");
assert.equal(keyedPage.warnings.length, 0);
assert.equal(keyedPage.observations[0]?.classification, "HS2022");
assert.equal(keyedPage.observations[0]?.tradeValueUsd, null);
assert.equal(keyedPage.observations[0]?.netWeightKg, null);
assert.equal(keyedPage.observations[0]?.quantity, null);
assert.equal(keyedPage.observations[0]?.quantityUnit, null);
assert.equal(keyedPage.observations[0]?.suppressed, true);
assert.deepEqual(keyedPage.observations[0]?.statusFlags, [
  "NOT_REPORTED",
  "TRADE_VALUE_MISSING",
  "NET_WEIGHT_MISSING",
  "QUANTITY_MISSING"
]);

assert.throws(() => normalizeTradeQuery({
  reporterCodes: ["842"],
  partnerCodes: ["0"],
  flow: "import",
  hsVersion: "HS2022",
  commodityCodes: ["940542"],
  periods: ["202301"],
  frequency: "annual"
}));
assert.throws(() => normalizeTradeQuery({
  ...baseQuery,
  periods: ["202500"],
  frequency: "monthly"
}));
assert.throws(() => normalizeTradeQuery({
  ...baseQuery,
  periods: ["202513"],
  frequency: "monthly"
}));
assert.deepEqual(normalizeTradeQuery({
  ...baseQuery,
  periods: ["202501"],
  frequency: "monthly"
}).periods, ["202501"]);

setProviderHttpTestTransport(async () => new Response("bad request", { status: 400 }));
await assert.rejects(
  UN_COMTRADE_PROVIDER.trade(
    { query: baseQuery, cursor: "" },
    { apiKey: "" },
    tools()
  ).catch((error) => {
    throw providerErrorFromUnknown(error, "trade");
  }),
  (error: unknown) => error instanceof ProviderContractError
    && error.code === "PROVIDER_SCHEMA_CHANGED"
    && error.httpStatus === 400
);

setProviderHttpTestTransport(async () => new Response("rate limited", {
  status: 429,
  headers: { "retry-after": "60" }
}));
await assert.rejects(
  UN_COMTRADE_PROVIDER.trade(
    { query: baseQuery, cursor: "" },
    { apiKey: "" },
    tools()
  ).catch((error) => {
    throw providerErrorFromUnknown(error, "trade");
  }),
  (error: unknown) => error instanceof ProviderContractError
    && error.code === "PROVIDER_RATE_LIMITED"
    && error.retryable
    && Boolean(error.retryAfterAt)
);

setProviderHttpTestTransport(async () => new Response(JSON.stringify({
  data: [comtradeRecord({ primaryValue: "not-a-number" })]
}), { status: 200 }));
await assert.rejects(
  UN_COMTRADE_PROVIDER.trade(
    { query: baseQuery, cursor: "" },
    { apiKey: "" },
    tools()
  ),
  (error: unknown) => error instanceof ProviderContractError
    && error.code === "PROVIDER_SCHEMA_CHANGED"
    && error.phase === "trade"
);

assert.equal(TRADE_PROVIDERS.includes(UN_COMTRADE_PROVIDER), true);
assert.equal(LEAD_PROVIDERS.some((provider) => provider.id === UN_COMTRADE_PROVIDER.id), false);
assert.equal("search" in UN_COMTRADE_PROVIDER, false);
assert.equal(UN_COMTRADE_PROVIDER.adapterVersion, "1.1.0");
const catalogItem = createDefaultProviderCatalog().find((item) => item.code === "un_comtrade");
assert.equal(catalogItem?.category, "market_trade");
assert.equal(catalogItem?.sourceLevel, "market_opportunity");
assert.equal(catalogItem?.capabilities.includes("trade"), true);
assert.equal(catalogItem?.allowedFields.includes("company"), false);
assert.equal(catalogItem?.allowedFields.includes("tradeValueUsd"), true);

setProviderHttpTestTransport(null);
console.log("UN Comtrade provider tests passed");
