import assert from "node:assert/strict";
import { publicUser, signToken } from "./auth.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import { app } from "./server.js";
import { getStore } from "./store.js";
import { createOpenApiDocument } from "./swagger.js";
import { validateTradeObservationCursorSecurity } from "./trade-observation-list.js";
import type { MarketTradeObservation, User } from "./types.js";

function user(id: string, role: User["role"], teamId: string): User {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    password: "test-only",
    role,
    teamId,
    avatar: id.slice(0, 2).toUpperCase(),
    status: "active",
    authVersion: 1
  };
}

function observation(overrides: Partial<MarketTradeObservation>): MarketTradeObservation {
  return {
    id: "mto_test",
    teamId: "trade_list_team_a",
    ownerId: "trade_list_sales_a",
    campaignId: "campaign_paging",
    providerId: "un_comtrade",
    reporterCountry: "USA",
    partnerCountry: "WORLD",
    reporterCode: "842",
    partnerCode: "0",
    tradeFlow: "IMPORT",
    classification: "HS2022",
    commodityCode: "940542",
    commodityDescription: "Lighting fittings",
    period: "202401",
    tradeValueUsd: 1000,
    netWeightKg: 20,
    quantity: 20,
    quantityUnit: "kg",
    isAggregate: true,
    suppressed: false,
    statusFlags: [],
    rawRecordId: "private-provider-record",
    payloadHash: "a".repeat(64),
    adapterVersion: "1.1.0",
    sourceRevision: "2026-07-13",
    observedAt: "2026-07-13T10:00:00.000Z",
    createdAt: "2026-07-13T09:00:00.000Z",
    ...overrides
  };
}

const store = getStore();
const salesA = user("trade_list_sales_a", "sales", "trade_list_team_a");
const managerA = user("trade_list_manager_a", "manager", "trade_list_team_a");
const salesB = user("trade_list_sales_b", "sales", "trade_list_team_b");
store.users.push(salesA, managerA, salesB);
store.marketTradeObservations.splice(0);

for (let index = 0; index < 205; index += 1) {
  const padded = String(index).padStart(3, "0");
  store.marketTradeObservations.push(observation({
    id: `mto_page_${padded}`,
    rawRecordId: `private-record-${padded}`,
    payloadHash: index.toString(16).padStart(64, "0")
  }));
}
store.marketTradeObservations.push(
  observation({
    id: "mto_manager_private",
    ownerId: managerA.id,
    rawRecordId: "manager-private-record"
  }),
  observation({
    id: "mto_team_b_private",
    teamId: salesB.teamId,
    ownerId: salesB.id,
    rawRecordId: "team-b-private-record"
  }),
  observation({
    id: "mto_other_campaign",
    campaignId: "campaign_other"
  }),
  observation({
    id: "mto_filter_month_202312",
    campaignId: "campaign_filters",
    period: "202312",
    tradeValueUsd: 0,
    netWeightKg: 0,
    quantity: 0,
    createdAt: "2026-07-12T09:00:00.000Z",
    payloadHash: "b".repeat(64)
  }),
  observation({
    id: "mto_filter_month_202401",
    campaignId: "campaign_filters",
    period: "202401",
    tradeValueUsd: null,
    netWeightKg: null,
    quantity: null,
    quantityUnit: "",
    statusFlags: ["TRADE_VALUE_MISSING"],
    payloadHash: "c".repeat(64)
  }),
  observation({
    id: "mto_filter_annual_2023",
    campaignId: "campaign_filters",
    period: "2023",
    providerId: "us_census_trade",
    tradeValueUsd: 3000,
    payloadHash: "d".repeat(64)
  }),
  observation({
    id: "mto_filter_suppressed",
    campaignId: "campaign_filters",
    period: "2022",
    tradeValueUsd: 0,
    suppressed: true,
    statusFlags: ["NOT_REPORTED"],
    payloadHash: "e".repeat(64)
  }),
  observation({
    id: "mto_filter_unknown",
    campaignId: "campaign_filters",
    period: "latest",
    tradeValueUsd: null,
    payloadHash: "f".repeat(64)
  })
);

const tokenA = signToken(publicUser(salesA));
const tokenManagerA = signToken(publicUser(managerA));
const tokenB = signToken(publicUser(salesB));
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start trade observation list test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(
  token: string | null,
  campaignId: string,
  query: Record<string, string | number> = {}
) {
  const url = new URL(
    `/api/prospect-campaigns/${campaignId}/trade-observations`,
    baseUrl
  );
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  return {
    response,
    json: await response.json().catch(() => ({}))
  };
}

let providerCalls = 0;
setProviderHttpTestTransport(async () => {
  providerCalls += 1;
  throw new Error("Trade observation GET must not call Provider");
});
const originalPersist = store.persist.bind(store);
let persistCalls = 0;
store.persist = async () => {
  persistCalls += 1;
};

try {
  const anonymous = await request(null, "campaign_paging");
  assert.equal(anonymous.response.status, 401);

  const invalidLimit = await request(tokenA, "campaign_paging", { limit: 201 });
  assert.equal(invalidLimit.response.status, 400);
  const incompleteRange = await request(tokenA, "campaign_filters", {
    periodFrom: "2023-01"
  });
  assert.equal(incompleteRange.response.status, 400);
  const mixedRange = await request(tokenA, "campaign_filters", {
    periodFrom: "2023",
    periodTo: "2024-01"
  });
  assert.equal(mixedRange.response.status, 400);
  const reversedRange = await request(tokenA, "campaign_filters", {
    periodFrom: "2024-01",
    periodTo: "2023-12"
  });
  assert.equal(reversedRange.response.status, 400);
  const mismatchedPeriodType = await request(tokenA, "campaign_filters", {
    periodType: "annual",
    period: "2024-01"
  });
  assert.equal(mismatchedPeriodType.response.status, 400);

  const firstPage = await request(tokenA, "campaign_paging", { limit: 2 });
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.json.campaignContractMode, "compat_v1");
  assert.equal(firstPage.json.campaignScope, "owner");
  assert.equal(firstPage.json.observationScope, "campaign_current_observations");
  assert.equal(firstPage.json.dataScope, "country_trade_statistics");
  assert.equal(firstPage.json.absenceMeaning, "not_observed_not_zero");
  assert.equal(firstPage.json.sort, "period_desc_created_desc_id_desc");
  assert.equal(firstPage.json.total, 205);
  assert.equal(firstPage.json.pageCount, 2);
  assert.equal(firstPage.json.hasMore, true);
  assert.ok(firstPage.json.nextCursor);
  assert.deepEqual(
    firstPage.json.observations.map((item: { id: string }) => item.id),
    ["mto_page_204", "mto_page_203"]
  );
  const cursorPayload = JSON.parse(
    Buffer.from(firstPage.json.nextCursor.split(".")[0], "base64url").toString("utf8")
  );
  assert.equal(JSON.stringify(cursorPayload).includes(salesA.id), false);
  assert.equal(JSON.stringify(cursorPayload).includes(salesA.teamId), false);
  assert.equal(JSON.stringify(cursorPayload).includes("campaign_paging"), false);

  const secondPage = await request(tokenA, "campaign_paging", {
    limit: 2,
    cursor: firstPage.json.nextCursor
  });
  assert.equal(secondPage.response.status, 200);
  assert.equal(secondPage.json.total, 205);
  assert.deepEqual(
    secondPage.json.observations.map((item: { id: string }) => item.id),
    ["mto_page_202", "mto_page_201"]
  );

  const tamperedCursor = `${firstPage.json.nextCursor.slice(0, -1)}x`;
  const tampered = await request(tokenA, "campaign_paging", {
    limit: 2,
    cursor: tamperedCursor
  });
  assert.equal(tampered.response.status, 400);
  assert.equal(tampered.json.errorCode, "TRADE_OBSERVATION_CURSOR_INVALID");

  const crossFilter = await request(tokenA, "campaign_paging", {
    limit: 2,
    commodityCode: "940542",
    cursor: firstPage.json.nextCursor
  });
  assert.equal(crossFilter.response.status, 400);
  assert.equal(crossFilter.json.errorCode, "TRADE_OBSERVATION_CURSOR_INVALID");
  const crossOwner = await request(tokenManagerA, "campaign_paging", {
    limit: 2,
    cursor: firstPage.json.nextCursor
  });
  assert.equal(crossOwner.response.status, 400);
  const crossCampaign = await request(tokenA, "campaign_other", {
    limit: 2,
    cursor: firstPage.json.nextCursor
  });
  assert.equal(crossCampaign.response.status, 400);

  const changedObservation = store.marketTradeObservations.find(
    (item) => item.id === "mto_page_100"
  );
  assert.ok(changedObservation);
  changedObservation.observedAt = "2026-07-13T11:00:00.000Z";
  const staleCursor = await request(tokenA, "campaign_paging", {
    limit: 2,
    cursor: firstPage.json.nextCursor
  });
  assert.equal(staleCursor.response.status, 400);
  assert.equal(staleCursor.json.errorCode, "TRADE_OBSERVATION_CURSOR_INVALID");

  const statusCursorPage = await request(tokenA, "campaign_paging", { limit: 2 });
  assert.ok(statusCursorPage.json.nextCursor);
  changedObservation.statusFlags = ["SOURCE_REVISED"];
  const staleStatusCursor = await request(tokenA, "campaign_paging", {
    limit: 2,
    cursor: statusCursorPage.json.nextCursor
  });
  assert.equal(staleStatusCursor.response.status, 400);
  assert.equal(staleStatusCursor.json.errorCode, "TRADE_OBSERVATION_CURSOR_INVALID");

  const maxPage = await request(tokenA, "campaign_paging", { limit: 200 });
  assert.equal(maxPage.response.status, 200);
  assert.equal(maxPage.json.pageCount, 200);
  assert.equal(maxPage.json.hasMore, true);
  assert.ok(maxPage.json.nextCursor);

  const managerOwn = await request(tokenManagerA, "campaign_paging");
  assert.equal(managerOwn.response.status, 200);
  assert.equal(managerOwn.json.total, 1);
  assert.equal(managerOwn.json.observations[0]?.id, "mto_manager_private");
  assert.equal(
    managerOwn.json.observations.some((item: { id: string }) =>
      item.id.startsWith("mto_page_")
    ),
    false
  );
  const teamBOwn = await request(tokenB, "campaign_paging");
  assert.equal(teamBOwn.response.status, 200);
  assert.equal(teamBOwn.json.total, 1);
  assert.equal(teamBOwn.json.observations[0]?.id, "mto_team_b_private");

  const monthlyRange = await request(tokenA, "campaign_filters", {
    periodType: "monthly",
    periodFrom: "2023-12",
    periodTo: "2024-01"
  });
  assert.equal(monthlyRange.response.status, 200);
  assert.deepEqual(
    monthlyRange.json.observations.map((item: { period: string }) => item.period),
    ["2024-01", "2023-12"]
  );
  assert.equal(monthlyRange.json.filters.periodType, "monthly");
  assert.equal(monthlyRange.json.observations[0].tradeValueUsd, null);
  assert.equal(monthlyRange.json.observations[0].tradeValueState, "unavailable");
  assert.equal(monthlyRange.json.observations[0].netWeightState, "unavailable");
  assert.equal(monthlyRange.json.observations[0].quantityState, "unavailable");
  assert.equal(monthlyRange.json.observations[0].quantityUnit, null);
  assert.equal(monthlyRange.json.observations[1].tradeValueUsd, 0);
  assert.equal(monthlyRange.json.observations[1].tradeValueState, "reported_zero");
  assert.equal(monthlyRange.json.observations[1].netWeightState, "reported_zero");
  assert.equal(monthlyRange.json.observations[1].quantityState, "reported_zero");
  assert.deepEqual(monthlyRange.json.observations[1].statusFlags, []);

  const annual = await request(tokenA, "campaign_filters", {
    periodType: "annual",
    period: "2023",
    providerId: "US_CENSUS_TRADE"
  });
  assert.equal(annual.response.status, 200);
  assert.equal(annual.json.total, 1);
  assert.equal(annual.json.observations[0].periodType, "annual");
  assert.equal(annual.json.observations[0].period, "2023");

  const allFilters = await request(tokenA, "campaign_filters");
  assert.equal(allFilters.response.status, 200);
  const suppressed = allFilters.json.observations.find(
    (item: { id: string }) => item.id === "mto_filter_suppressed"
  );
  assert.equal(suppressed.tradeValueState, "suppressed");
  assert.equal(suppressed.tradeValueUsd, 0);
  assert.deepEqual(suppressed.statusFlags, ["NOT_REPORTED"]);
  const unknown = allFilters.json.observations.find(
    (item: { id: string }) => item.id === "mto_filter_unknown"
  );
  assert.equal(unknown.periodType, "unknown");
  assert.equal(unknown.tradeValueState, "unknown");
  assert.deepEqual(unknown.statusFlags, []);
  const unknownWithPeriodType = await request(tokenA, "campaign_filters", {
    periodType: "annual"
  });
  assert.equal(
    unknownWithPeriodType.json.observations.some(
      (item: { id: string }) => item.id === "mto_filter_unknown"
    ),
    false
  );

  for (const item of allFilters.json.observations) {
    assert.equal("teamId" in item, false);
    assert.equal("ownerId" in item, false);
    assert.equal("campaignId" in item, false);
    assert.equal("rawRecordId" in item, false);
    assert.equal("payloadHash" in item, false);
  }

  const empty = await request(tokenA, "campaign_unused");
  assert.equal(empty.response.status, 200);
  assert.equal(empty.json.total, 0);
  assert.equal(empty.json.pageCount, 0);
  assert.equal(empty.json.hasMore, false);
  assert.equal(empty.json.nextCursor, null);
  assert.deepEqual(empty.json.observations, []);

  assert.equal(providerCalls, 0);
  assert.equal(persistCalls, 0);

  const document = createOpenApiDocument(app);
  const operation = (document.paths as Record<string, Record<string, any>>)
    ["/api/prospect-campaigns/{id}/trade-observations"]?.get;
  assert.ok(operation);
  assert.equal(operation.tags[0], "获客项目");
  for (const name of [
    "providerId",
    "reporterCode",
    "partnerCode",
    "flow",
    "classification",
    "commodityCode",
    "periodType",
    "period",
    "periodFrom",
    "periodTo",
    "cursor",
    "limit"
  ]) {
    assert.ok(operation.parameters.some((item: { name: string }) => item.name === name));
  }
  const successSchema = operation.responses["200"].content["application/json"].schema;
  assert.equal(successSchema.additionalProperties, false);
  assert.deepEqual(
    successSchema.properties.campaignContractMode.enum,
    ["compat_v1", "formal_v1"]
  );
  assert.equal(successSchema.properties.campaignScope.enum[0], "owner");
  assert.equal(successSchema.properties.dataScope.enum[0], "country_trade_statistics");
  assert.equal(successSchema.properties.observations.items.additionalProperties, false);
  assert.match(
    successSchema.properties.observations.items.properties.statusFlags.description,
    /原样返回持久化的 Provider 状态标记/
  );
  assert.ok(operation.responses["400"].content["application/json"].schema.oneOf);
  assert.ok(operation.responses["401"]);
  assert.ok(operation.responses["500"].content["application/json"].schema);
  assert.match(operation.description, /不是企业、采购商、采购意向、推荐客户或销售线索/);
  assert.match(operation.description, /数据新增或更新后旧 cursor 返回 400/);
  assert.match(operation.description, /pc_<UUID> 按正式项目校验/);
  assert.match(operation.description, /正式项目不存在或不属于当前负责人时统一返回 404/);
  assert.match(operation.description, /未使用的兼容引用返回 200 空数组/);

  const previousNodeEnv = process.env.NODE_ENV;
  const previousCursorSecret = process.env.TRADE_OBSERVATION_CURSOR_SECRET;
  process.env.NODE_ENV = "production";
  delete process.env.TRADE_OBSERVATION_CURSOR_SECRET;
  assert.throws(
    () => validateTradeObservationCursorSecurity(),
    /生产环境必须配置至少 32 位/
  );
  process.env.TRADE_OBSERVATION_CURSOR_SECRET = "trade-observation-cursor-test-secret-32-plus";
  assert.doesNotThrow(() => validateTradeObservationCursorSecurity());
  process.env.NODE_ENV = previousNodeEnv;
  if (previousCursorSecret === undefined) {
    delete process.env.TRADE_OBSERVATION_CURSOR_SECRET;
  } else {
    process.env.TRADE_OBSERVATION_CURSOR_SECRET = previousCursorSecret;
  }

  console.log("Trade observation list API pagination, filters, isolation, security and Swagger tests passed");
} finally {
  store.persist = originalPersist;
  setProviderHttpTestTransport(null);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
