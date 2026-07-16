import assert from "node:assert/strict";
import { publicUser, signToken } from "./auth.js";
import {
  validateMarketOpportunityCursorSecurity
} from "./market-opportunity-list.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import { app } from "./server.js";
import { getStore, type PersistedStoreMutation } from "./store.js";
import { createOpenApiDocument } from "./swagger.js";
import type {
  MarketOpportunityBatch,
  MarketOpportunityCalculationEvent,
  MarketOpportunityEvidence,
  MarketOpportunitySnapshot,
  User
} from "./types.js";

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

function batch(overrides: Partial<MarketOpportunityBatch>): MarketOpportunityBatch {
  return {
    id: "mob_latest",
    teamId: "market_list_team_a",
    ownerId: "market_list_sales_a",
    campaignId: "campaign_market",
    providerId: "un_comtrade",
    datasetFingerprint: "b".repeat(64),
    policyVersion: "market_opportunity_facts_v1",
    status: "partial",
    emptyReason: "",
    candidateCount: 3,
    readyCount: 2,
    comparisonPeriods: ["2024"],
    firstTriggerJobId: "job_latest",
    observationCutoffAt: "2026-07-13T10:55:00.000Z",
    createdAt: "2026-07-13T11:00:00.000Z",
    ...overrides
  };
}

function calculation(
  overrides: Partial<MarketOpportunityCalculationEvent>
): MarketOpportunityCalculationEvent {
  return {
    id: "moe_latest",
    teamId: "market_list_team_a",
    ownerId: "market_list_sales_a",
    campaignId: "campaign_market",
    triggerJobId: "job_latest",
    batchId: "mob_latest",
    datasetFingerprint: "b".repeat(64),
    policyVersion: "market_opportunity_facts_v1",
    outcome: "partial",
    reusedBatch: false,
    sequence: 4,
    calculatedAt: "2026-07-13T11:00:00.000Z",
    ...overrides
  };
}

function evidence(overrides: Partial<MarketOpportunityEvidence> = {}): MarketOpportunityEvidence {
  return {
    observationId: "mto_private_evidence",
    payloadHash: "f".repeat(64),
    providerId: "un_comtrade",
    adapterVersion: "1.0.0",
    sourceRevision: "2026-07-13",
    period: "2024",
    reporterCountry: "United States",
    reporterCode: "842",
    partnerCountry: "World",
    partnerCode: "0",
    tradeFlow: "IMPORT",
    classification: "HS2022",
    commodityCode: "940542",
    tradeValueUsd: 144,
    suppressed: false,
    statusFlags: [],
    ...overrides
  };
}

function snapshot(
  overrides: Partial<MarketOpportunitySnapshot>
): MarketOpportunitySnapshot {
  const reporterCountry = overrides.reporterCountry || "United States";
  const reporterCode = overrides.reporterCode || "842";
  const itemEvidence = evidence({ reporterCountry, reporterCode });
  return {
    id: "mos_latest_usa",
    batchId: "mob_latest",
    teamId: "market_list_team_a",
    ownerId: "market_list_sales_a",
    campaignId: "campaign_market",
    providerId: "un_comtrade",
    reporterCountry,
    reporterCode,
    classification: "HS2022",
    commodityCode: "940542",
    commodityDescription: "Electric lamps",
    comparisonPeriod: "2024",
    snapshotStatus: "metrics_ready",
    insufficiencyReasons: [],
    metrics: {
      metricVersion: "market_opportunity_facts_v1",
      reportedImportValueSeries: [
        {
          period: "2022",
          tradeValueUsd: 100,
          evidence: evidence({
            reporterCountry,
            reporterCode,
            period: "2022",
            tradeValueUsd: 100
          })
        },
        {
          period: "2023",
          tradeValueUsd: 120,
          evidence: evidence({
            reporterCountry,
            reporterCode,
            period: "2023",
            tradeValueUsd: 120
          })
        },
        {
          period: "2024",
          tradeValueUsd: 144,
          evidence: itemEvidence
        }
      ],
      yoyChanges: [
        {
          fromPeriod: "2022",
          toPeriod: "2023",
          value: 0.2,
          reason: ""
        },
        {
          fromPeriod: "2023",
          toPeriod: "2024",
          value: 0.2,
          reason: ""
        }
      ],
      twoYearCagr: 0.2,
      twoYearCagrReason: "",
      chinaMainlandSupplyShare: 0.5,
      chinaMainlandSupplyShareReason: "",
      chinaMainlandEvidence: evidence({
        reporterCountry,
        reporterCode,
        partnerCountry: "China",
        partnerCode: "156",
        tradeValueUsd: 72,
        payloadHash: "e".repeat(64)
      })
    },
    marketScore: null,
    growthScore: null,
    chinaSupplyScore: null,
    createdAt: "2026-07-13T11:00:00.000Z",
    ...overrides
  };
}

const store = getStore();
const salesA = user("market_list_sales_a", "sales", "market_list_team_a");
const adminA = user("market_list_admin_a", "admin", "market_list_team_a");
const salesB = user("market_list_sales_b", "sales", "market_list_team_b");
store.users.push(salesA, adminA, salesB);
store.marketOpportunityBatches.splice(0);
store.marketOpportunitySnapshots.splice(0);
store.marketOpportunityCalculationEvents.splice(0);

const latestBatch = batch({});
const historicalReadyBatch = batch({
  id: "mob_historical_ready",
  datasetFingerprint: "a".repeat(64),
  status: "metrics_ready",
  candidateCount: 1,
  readyCount: 1,
  createdAt: "2026-07-13T10:00:00.000Z"
});
const adminPrivateBatch = batch({
  id: "mob_admin_private",
  ownerId: adminA.id,
  datasetFingerprint: "c".repeat(64)
});
const otherTeamBatch = batch({
  id: "mob_other_team",
  teamId: salesB.teamId,
  ownerId: salesB.id,
  datasetFingerprint: "d".repeat(64)
});
store.marketOpportunityBatches.push(
  latestBatch,
  historicalReadyBatch,
  adminPrivateBatch,
  otherTeamBatch
);
store.marketOpportunityCalculationEvents.push(
  calculation({}),
  calculation({
    id: "zzzz_same_timestamp_but_older",
    triggerJobId: "job_same_timestamp_older",
    batchId: historicalReadyBatch.id,
    datasetFingerprint: historicalReadyBatch.datasetFingerprint,
    outcome: "metrics_ready",
    sequence: 3
  }),
  calculation({
    id: "moe_historical",
    triggerJobId: "job_historical",
    batchId: historicalReadyBatch.id,
    datasetFingerprint: historicalReadyBatch.datasetFingerprint,
    outcome: "metrics_ready",
    sequence: 2,
    calculatedAt: "2026-07-13T10:00:00.000Z"
  }),
  calculation({
    id: "moe_admin_private",
    ownerId: adminA.id,
    triggerJobId: "job_admin",
    batchId: adminPrivateBatch.id,
    datasetFingerprint: adminPrivateBatch.datasetFingerprint
    ,
    sequence: 1
  }),
  calculation({
    id: "moe_other_team",
    teamId: salesB.teamId,
    ownerId: salesB.id,
    triggerJobId: "job_other_team",
    batchId: otherTeamBatch.id,
    datasetFingerprint: otherTeamBatch.datasetFingerprint
    ,
    sequence: 1
  })
);
store.marketOpportunitySnapshots.push(
  snapshot({
    id: "mos_latest_canada",
    reporterCountry: "Canada",
    reporterCode: "124"
  }),
  snapshot({
    id: "mos_latest_germany",
    reporterCountry: "Germany",
    reporterCode: "276"
  }),
  snapshot({}),
  snapshot({
    id: "mos_historical",
    batchId: historicalReadyBatch.id,
    reporterCountry: "Japan",
    reporterCode: "392",
    createdAt: historicalReadyBatch.createdAt
  }),
  snapshot({
    id: "mos_admin_private",
    batchId: adminPrivateBatch.id,
    ownerId: adminA.id
  }),
  snapshot({
    id: "mos_other_team",
    batchId: otherTeamBatch.id,
    teamId: salesB.teamId,
    ownerId: salesB.id
  })
);

const tokenA = signToken(publicUser(salesA));
const tokenAdminA = signToken(publicUser(adminA));
const tokenB = signToken(publicUser(salesB));
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start market opportunity list test server");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(
  token: string | null,
  campaignId: string,
  query: Record<string, string | number> = {}
) {
  const url = new URL(
    `/api/prospect-campaigns/${campaignId}/market-opportunities`,
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
  throw new Error("Market opportunity GET must not call Provider");
});
const originalPersist = store.persist.bind(store);
const originalPersistMutation = store.persistMutation;
const originalReadBarrier = store.readBarrier.bind(store);
let persistCalls = 0;
let mutationCalls = 0;
let readBarrierCalls = 0;
store.persist = async () => {
  persistCalls += 1;
};
store.persistMutation = async <T>(
  operation: () => PersistedStoreMutation<T>
): Promise<T> => {
  mutationCalls += 1;
  return operation().value;
};
store.readBarrier = async () => {
  readBarrierCalls += 1;
};
const jobCountBefore = store.agentJobs.length;
const batchCountBefore = store.marketOpportunityBatches.length;
const snapshotCountBefore = store.marketOpportunitySnapshots.length;
const calculationCountBefore = store.marketOpportunityCalculationEvents.length;

try {
  const anonymous = await request(null, "campaign_market");
  assert.equal(anonymous.response.status, 401);

  const neverCalculated = await request(tokenA, "campaign_never_calculated");
  assert.equal(neverCalculated.response.status, 200);
  assert.equal(neverCalculated.json.calculationStatus, "never_calculated");
  assert.equal(neverCalculated.json.latestCalculation, null);
  assert.equal(neverCalculated.json.selectedBatch, null);
  assert.equal(neverCalculated.json.lastMetricsReadyBatch, null);
  assert.equal(
    neverCalculated.json.absenceMeaning,
    "no_fact_snapshot_does_not_mean_zero_or_no_market"
  );
  assert.equal(neverCalculated.json.fallbackReason, null);
  assert.equal(neverCalculated.json.isStale, false);
  assert.deepEqual(neverCalculated.json.opportunities, []);

  const invalidLimit = await request(tokenA, "campaign_market", { limit: 101 });
  assert.equal(invalidLimit.response.status, 400);

  const latest = await request(tokenA, "campaign_market", { limit: 2 });
  assert.equal(latest.response.status, 200);
  assert.equal(latest.json.campaignScope, "owner");
  assert.equal(latest.json.dataScope, "country_trade_statistics");
  assert.equal(latest.json.opportunityScope, "market_opportunity_fact_snapshots_v1");
  assert.equal(latest.json.scoringStatus, "not_scored_v1");
  assert.equal(latest.json.calculationStatus, "partial");
  assert.equal(latest.json.selectedBatch.id, latestBatch.id);
  assert.equal(latest.json.latestCalculation.batchId, latestBatch.id);
  assert.equal(latest.json.selectedCalculation.batchId, latestBatch.id);
  assert.equal(latest.json.lastMetricsReadyBatch.id, latestBatch.id);
  assert.equal(latest.json.isHistorical, false);
  assert.equal(latest.json.isStale, true);
  assert.equal(latest.json.fallbackReason, null);
  assert.equal(latest.json.selectedBatch.firstTriggerJobId, "job_latest");
  assert.equal(
    latest.json.selectedBatch.observationCutoffAt,
    "2026-07-13T10:55:00.000Z"
  );
  assert.equal(latest.json.total, 3);
  assert.equal(latest.json.pageCount, 2);
  assert.equal(latest.json.hasMore, true);
  assert.ok(latest.json.nextCursor);
  assert.deepEqual(
    latest.json.opportunities.map((item: { country: string }) => item.country),
    ["Canada", "Germany"]
  );
  assert.match(latest.json.interpretation, /不等同于消费市场规模、真实需求或采购意向/);

  const publicJson = JSON.stringify(latest.json);
  for (const privateField of [
    "teamId",
    "ownerId",
    "payloadHash",
    "rawRecordId",
    "marketScore",
    "growthScore",
    "chinaSupplyScore"
  ]) {
    assert.equal(publicJson.includes(`"${privateField}"`), false);
  }
  assert.equal(latest.json.opportunities[0].metrics.reportedImportValueSeries.length, 3);
  assert.equal("nextAction" in latest.json.opportunities[0], false);
  assert.equal(
    latest.json.opportunities[0].metrics.reportedImportValueSeries[2]
      .evidence.reportedImportValueUsd,
    144
  );

  const secondPage = await request(tokenA, "campaign_market", {
    limit: 2,
    cursor: latest.json.nextCursor
  });
  assert.equal(secondPage.response.status, 200);
  assert.deepEqual(
    secondPage.json.opportunities.map((item: { country: string }) => item.country),
    ["United States"]
  );

  const tamperedCursor = `${latest.json.nextCursor.slice(0, -1)}x`;
  const tampered = await request(tokenA, "campaign_market", {
    limit: 2,
    cursor: tamperedCursor
  });
  assert.equal(tampered.response.status, 400);
  assert.equal(tampered.json.errorCode, "MARKET_OPPORTUNITY_CURSOR_INVALID");

  const crossFilter = await request(tokenA, "campaign_market", {
    limit: 2,
    countryCode: "842",
    cursor: latest.json.nextCursor
  });
  assert.equal(crossFilter.response.status, 400);
  assert.equal(crossFilter.json.errorCode, "MARKET_OPPORTUNITY_CURSOR_INVALID");

  const crossOwnerCursor = await request(tokenAdminA, "campaign_market", {
    limit: 2,
    cursor: latest.json.nextCursor
  });
  assert.equal(crossOwnerCursor.response.status, 400);
  const crossTeamCursor = await request(tokenB, "campaign_market", {
    limit: 2,
    cursor: latest.json.nextCursor
  });
  assert.equal(crossTeamCursor.response.status, 400);
  const crossBatchCursor = await request(tokenA, "campaign_market", {
    batchId: historicalReadyBatch.id,
    limit: 2,
    cursor: latest.json.nextCursor
  });
  assert.equal(crossBatchCursor.response.status, 400);

  const historical = await request(tokenA, "campaign_market", {
    batchId: historicalReadyBatch.id
  });
  assert.equal(historical.response.status, 200);
  assert.equal(historical.json.selectedBatch.id, historicalReadyBatch.id);
  assert.equal(historical.json.selectedCalculation.batchId, historicalReadyBatch.id);
  assert.equal(historical.json.latestCalculation.batchId, latestBatch.id);
  assert.equal(historical.json.lastMetricsReadyBatch.id, latestBatch.id);
  assert.equal(historical.json.isHistorical, true);
  assert.equal(historical.json.total, 1);
  assert.equal(historical.json.opportunities[0].id, "mos_historical");

  for (const hiddenBatchId of [
    adminPrivateBatch.id,
    otherTeamBatch.id,
    "mob_does_not_exist"
  ]) {
    const hidden = await request(tokenA, "campaign_market", {
      batchId: hiddenBatchId
    });
    assert.equal(hidden.response.status, 404);
    assert.equal(hidden.json.errorCode, "MARKET_OPPORTUNITY_BATCH_NOT_FOUND");
  }
  const adminCannotReadSales = await request(tokenAdminA, "campaign_market", {
    batchId: latestBatch.id
  });
  assert.equal(adminCannotReadSales.response.status, 404);
  const otherTeamCannotReadSales = await request(tokenB, "campaign_market", {
    batchId: latestBatch.id
  });
  assert.equal(otherTeamCannotReadSales.response.status, 404);

  const adminOwn = await request(tokenAdminA, "campaign_market");
  assert.equal(adminOwn.response.status, 200);
  assert.equal(adminOwn.json.selectedBatch.id, adminPrivateBatch.id);
  assert.equal(adminOwn.json.total, 1);
  assert.equal(adminOwn.json.opportunities[0].id, "mos_admin_private");

  assert.equal(providerCalls, 0);
  assert.equal(persistCalls, 0);
  assert.equal(mutationCalls, 0);
  assert.equal(store.agentJobs.length, jobCountBefore);
  assert.equal(store.marketOpportunityBatches.length, batchCountBefore);
  assert.equal(store.marketOpportunitySnapshots.length, snapshotCountBefore);
  assert.equal(
    store.marketOpportunityCalculationEvents.length,
    calculationCountBefore
  );
  // Anonymous and invalid-query requests are rejected before any store read.
  assert.equal(readBarrierCalls, 15);

  const document = createOpenApiDocument(app);
  const operation = (document.paths as Record<string, Record<string, any>>)
    ["/api/prospect-campaigns/{id}/market-opportunities"]?.get;
  assert.ok(operation);
  for (const name of [
    "batchId",
    "countryCode",
    "classification",
    "commodityCode",
    "snapshotStatus",
    "cursor",
    "limit"
  ]) {
    assert.ok(operation.parameters.some((item: { name: string }) => item.name === name));
  }
  const successSchema = operation.responses["200"].content["application/json"].schema;
  assert.equal(successSchema.additionalProperties, false);
  assert.equal(successSchema.properties.campaignScope.enum[0], "owner");
  assert.equal(successSchema.properties.scoringStatus.enum[0], "not_scored_v1");
  assert.ok(successSchema.required.includes("absenceMeaning"));
  assert.ok(successSchema.required.includes("fallbackReason"));
  assert.ok(successSchema.required.includes("isStale"));
  assert.equal(
    successSchema.properties.opportunities.items.required.includes("nextAction"),
    false
  );
  assert.equal(successSchema.properties.opportunities.items.additionalProperties, false);
  assert.equal(
    successSchema.properties.opportunities.items.properties.metrics.additionalProperties,
    false
  );
  assert.equal(
    successSchema.properties.opportunities.items.properties.metrics
      .properties.reportedImportValueSeries.items.properties.evidence
      .additionalProperties,
    false
  );
  assert.ok(operation.responses["400"].content["application/json"].schema.oneOf);
  assert.equal(
    operation.responses["404"].content["application/json"].schema.$ref,
    "#/components/schemas/MarketOpportunityListRequestError"
  );
  assert.ok(operation.responses["401"]);
  assert.ok(operation.responses["500"]);
  assert.match(operation.description, /经理、管理员和超级管理员也只能读取自己名下的数据/);
  assert.match(operation.description, /不会静默回退/);
  assert.match(operation.description, /不等同于消费市场规模/);
  assert.match(operation.description, /不会自动创建线索、客户或商机/);

  const marketAnalysisOperation = (document.paths as Record<string, Record<string, any>>)
    ["/api/prospect-campaigns/{id}/market-analysis-runs"]?.post;
  const analysisResult = marketAnalysisOperation.responses["201"]
    .content["application/json"].schema.properties.result;
  assert.ok(analysisResult.required.includes("marketOpportunityCalculation"));
  assert.equal(
    analysisResult.properties.marketOpportunityCalculation.additionalProperties,
    false
  );

  const previousNodeEnv = process.env.NODE_ENV;
  const previousCursorSecret = process.env.MARKET_OPPORTUNITY_CURSOR_SECRET;
  process.env.NODE_ENV = "production";
  delete process.env.MARKET_OPPORTUNITY_CURSOR_SECRET;
  assert.throws(
    () => validateMarketOpportunityCursorSecurity(),
    /生产环境必须配置至少 32 字节/
  );
  process.env.MARKET_OPPORTUNITY_CURSOR_SECRET =
    "market-opportunity-cursor-test-secret-at-least-32-bytes";
  assert.doesNotThrow(() => validateMarketOpportunityCursorSecurity());
  process.env.NODE_ENV = previousNodeEnv;
  if (previousCursorSecret === undefined) {
    delete process.env.MARKET_OPPORTUNITY_CURSOR_SECRET;
  } else {
    process.env.MARKET_OPPORTUNITY_CURSOR_SECRET = previousCursorSecret;
  }

  console.log(
    "Market opportunity list latest/history, isolation, cursor, purity, barrier and Swagger tests passed"
  );
} finally {
  store.persist = originalPersist;
  store.persistMutation = originalPersistMutation;
  store.readBarrier = originalReadBarrier;
  setProviderHttpTestTransport(null);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
