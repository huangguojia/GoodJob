import assert from "node:assert/strict";
import { materializeMarketOpportunityFacts } from "./market-opportunity-facts.js";
import { memoryStore, type CrmStore } from "./store.js";
import type { MarketTradeObservation } from "./types.js";

function observation(overrides: Partial<MarketTradeObservation>): MarketTradeObservation {
  return {
    id: `mto_${overrides.reporterCode}_${overrides.partnerCode}_${overrides.period}`,
    teamId: "team_a",
    ownerId: "owner_a",
    campaignId: "campaign_a",
    providerId: "un_comtrade",
    reporterCountry: "United States",
    partnerCountry: overrides.partnerCode === "156" ? "China" : "World",
    reporterCode: "842",
    partnerCode: "0",
    tradeFlow: "IMPORT",
    classification: "HS2022",
    commodityCode: "940542",
    commodityDescription: "Electric lamps",
    period: "2024",
    tradeValueUsd: 100,
    netWeightKg: null,
    quantity: null,
    quantityUnit: "",
    isAggregate: overrides.partnerCode !== "156",
    suppressed: false,
    statusFlags: [],
    rawRecordId: "provider-private-record",
    payloadHash: "a".repeat(64),
    adapterVersion: "1.0.0",
    sourceRevision: "2026-07-13",
    observedAt: "2026-07-13T08:00:00.000Z",
    createdAt: "2026-07-13T08:00:00.000Z",
    ...overrides
  };
}

function createStore(observations: MarketTradeObservation[]): CrmStore {
  return {
    ...memoryStore,
    marketTradeObservations: observations,
    marketOpportunityBatches: [],
    marketOpportunitySnapshots: [],
    marketOpportunityCalculationEvents: []
  };
}

const observations = [
  observation({ reporterCode: "842", period: "2022", tradeValueUsd: 100 }),
  observation({ reporterCode: "842", period: "2023", tradeValueUsd: 121 }),
  observation({ reporterCode: "842", period: "2024", tradeValueUsd: 144 }),
  observation({
    id: "mto_usa_china_2024",
    reporterCode: "842",
    partnerCode: "156",
    partnerCountry: "China",
    period: "2024",
    tradeValueUsd: 72,
    isAggregate: false,
    payloadHash: "b".repeat(64)
  }),
  observation({
    id: "mto_usa_current_year",
    reporterCode: "842",
    period: String(new Date().getUTCFullYear()),
    tradeValueUsd: 999
  }),
  observation({
    id: "mto_canada_2021",
    reporterCountry: "Canada",
    reporterCode: "124",
    period: "2021",
    tradeValueUsd: 50
  }),
  observation({
    id: "mto_canada_2022",
    reporterCountry: "Canada",
    reporterCode: "124",
    period: "2022",
    tradeValueUsd: 60
  }),
  observation({
    id: "mto_canada_2023",
    reporterCountry: "Canada",
    reporterCode: "124",
    period: "2023",
    tradeValueUsd: 70
  }),
  observation({
    id: "mto_other_owner",
    ownerId: "owner_b",
    reporterCountry: "Germany",
    reporterCode: "276",
    period: "2025",
    tradeValueUsd: 500
  }),
  observation({
    id: "mto_other_team",
    teamId: "team_b",
    ownerId: "owner_a",
    reporterCountry: "France",
    reporterCode: "251",
    period: "2025",
    tradeValueUsd: 400
  })
];
const store = createStore(observations);
const first = materializeMarketOpportunityFacts(store, {
  teamId: "team_a",
  ownerId: "owner_a",
  campaignId: "campaign_a",
  triggerJobId: "job_1",
  calculatedAt: "2026-07-13T09:00:00.000Z"
});

assert.equal(first.reusedBatch, false);
assert.equal(first.batch.status, "partial");
assert.equal(first.batch.candidateCount, 2);
assert.equal(first.batch.readyCount, 1);
assert.deepEqual(first.batch.comparisonPeriods, ["2024"]);
assert.equal(first.snapshots.length, 2);
assert.equal(store.marketOpportunityCalculationEvents.length, 1);

const usa = first.snapshots.find((item) => item.reporterCode === "842");
const canada = first.snapshots.find((item) => item.reporterCode === "124");
assert.ok(usa);
assert.ok(canada);
assert.equal(usa.snapshotStatus, "metrics_ready");
assert.deepEqual(
  usa.metrics.reportedImportValueSeries.map((item) => [item.period, item.tradeValueUsd]),
  [["2022", 100], ["2023", 121], ["2024", 144]]
);
assert.equal(usa.metrics.yoyChanges[0]?.value, 0.21);
assert.ok(Math.abs((usa.metrics.yoyChanges[1]?.value || 0) - (23 / 121)) < 1e-12);
assert.ok(Math.abs((usa.metrics.twoYearCagr || 0) - 0.2) < 1e-12);
assert.equal(usa.metrics.chinaMainlandSupplyShare, 0.5);
assert.equal(usa.metrics.chinaMainlandEvidence?.payloadHash, "b".repeat(64));
assert.equal(usa.marketScore, null);
assert.equal(usa.growthScore, null);
assert.equal(usa.chinaSupplyScore, null);

assert.equal(canada.comparisonPeriod, "2024");
assert.equal(canada.snapshotStatus, "insufficient_data");
assert.ok(canada.insufficiencyReasons.includes("missing_world_observation:2024"));
assert.equal(
  first.snapshots.some((item) => item.reporterCode === "276" || item.reporterCode === "251"),
  false
);

const savedFirstValue = usa.metrics.reportedImportValueSeries[0]!.tradeValueUsd;
observations[0]!.tradeValueUsd = 999999;
assert.equal(usa.metrics.reportedImportValueSeries[0]!.tradeValueUsd, savedFirstValue);
observations[0]!.tradeValueUsd = 100;

const repeated = materializeMarketOpportunityFacts(store, {
  teamId: "team_a",
  ownerId: "owner_a",
  campaignId: "campaign_a",
  triggerJobId: "job_2",
  calculatedAt: "2026-07-13T10:00:00.000Z"
});
assert.equal(repeated.reusedBatch, true);
assert.equal(repeated.batch.id, first.batch.id);
assert.equal(repeated.snapshots.length, 0);
assert.equal(store.marketOpportunityBatches.length, 1);
assert.equal(store.marketOpportunitySnapshots.length, 2);
assert.equal(store.marketOpportunityCalculationEvents.length, 2);
assert.equal(store.marketOpportunityCalculationEvents[0]?.triggerJobId, "job_2");

const zeroBaseStore = createStore([
  observation({ period: "2022", tradeValueUsd: 0 }),
  observation({ period: "2023", tradeValueUsd: 10 }),
  observation({ period: "2024", tradeValueUsd: 20 })
]);
const zeroBase = materializeMarketOpportunityFacts(zeroBaseStore, {
  teamId: "team_a",
  ownerId: "owner_a",
  campaignId: "campaign_a",
  triggerJobId: "job_zero"
});
assert.equal(zeroBase.batch.status, "metrics_ready");
assert.equal(zeroBase.snapshots[0]?.metrics.yoyChanges[0]?.value, null);
assert.equal(zeroBase.snapshots[0]?.metrics.yoyChanges[0]?.reason, "base_period_zero");
assert.equal(zeroBase.snapshots[0]?.metrics.twoYearCagr, null);
assert.equal(zeroBase.snapshots[0]?.metrics.twoYearCagrReason, "base_period_zero");

const invalidChinaStore = createStore([
  observation({ period: "2022", tradeValueUsd: 100 }),
  observation({ period: "2023", tradeValueUsd: 100 }),
  observation({ period: "2024", tradeValueUsd: 100 }),
  observation({
    id: "mto_invalid_china",
    partnerCode: "156",
    partnerCountry: "China",
    period: "2024",
    tradeValueUsd: 120,
    isAggregate: false
  })
]);
const invalidChina = materializeMarketOpportunityFacts(invalidChinaStore, {
  teamId: "team_a",
  ownerId: "owner_a",
  campaignId: "campaign_a",
  triggerJobId: "job_invalid_china"
});
assert.equal(invalidChina.snapshots[0]?.snapshotStatus, "metrics_ready");
assert.equal(invalidChina.snapshots[0]?.metrics.chinaMainlandSupplyShare, null);
assert.equal(
  invalidChina.snapshots[0]?.metrics.chinaMainlandSupplyShareReason,
  "china_mainland_value_exceeds_world"
);

const emptyStore = createStore([]);
const empty = materializeMarketOpportunityFacts(emptyStore, {
  teamId: "team_a",
  ownerId: "owner_a",
  campaignId: "campaign_empty",
  triggerJobId: "job_empty"
});
assert.equal(empty.batch.status, "insufficient_data");
assert.equal(empty.batch.emptyReason, "no_eligible_observations");
assert.equal(empty.batch.candidateCount, 0);
assert.equal(empty.snapshots.length, 0);
assert.equal(emptyStore.marketOpportunityCalculationEvents.length, 1);

const suppressedLatestStore = createStore([
  observation({ period: "2021", tradeValueUsd: 80 }),
  observation({ period: "2022", tradeValueUsd: 90 }),
  observation({ period: "2023", tradeValueUsd: 100 }),
  observation({
    id: "mto_suppressed_latest",
    period: "2024",
    tradeValueUsd: null,
    suppressed: true
  })
]);
const suppressedLatest = materializeMarketOpportunityFacts(suppressedLatestStore, {
  teamId: "team_a",
  ownerId: "owner_a",
  campaignId: "campaign_a",
  triggerJobId: "job_suppressed_latest"
});
assert.equal(suppressedLatest.batch.status, "metrics_ready");
assert.deepEqual(suppressedLatest.batch.comparisonPeriods, ["2023"]);
assert.deepEqual(
  suppressedLatest.snapshots[0]?.metrics.reportedImportValueSeries.map((item) => item.period),
  ["2021", "2022", "2023"]
);

const renamedReporterStore = createStore([
  observation({
    id: "mto_renamed_2022",
    reporterCountry: "United States of America",
    period: "2022",
    tradeValueUsd: 100
  }),
  observation({
    id: "mto_renamed_2023",
    reporterCountry: "United States",
    period: "2023",
    tradeValueUsd: 110
  }),
  observation({
    id: "mto_renamed_2024",
    reporterCountry: "USA",
    period: "2024",
    tradeValueUsd: 120
  })
]);
const renamedReporter = materializeMarketOpportunityFacts(renamedReporterStore, {
  teamId: "team_a",
  ownerId: "owner_a",
  campaignId: "campaign_a",
  triggerJobId: "job_renamed_reporter"
});
assert.equal(renamedReporter.batch.candidateCount, 1);
assert.equal(renamedReporter.batch.readyCount, 1);
assert.equal(renamedReporter.snapshots.length, 1);
assert.deepEqual(
  renamedReporter.snapshots[0]?.metrics.reportedImportValueSeries.map((item) => item.period),
  ["2022", "2023", "2024"]
);

const nonContiguousStore = createStore([
  observation({ period: "2022", tradeValueUsd: 100 }),
  observation({ period: "2024", tradeValueUsd: 120 })
]);
const nonContiguous = materializeMarketOpportunityFacts(nonContiguousStore, {
  teamId: "team_a",
  ownerId: "owner_a",
  campaignId: "campaign_a",
  triggerJobId: "job_non_contiguous"
});
assert.equal(nonContiguous.batch.emptyReason, "non_contiguous_three_year_series");
assert.ok(
  nonContiguous.snapshots[0]?.insufficiencyReasons.includes(
    "non_contiguous_three_year_series"
  )
);
assert.ok(
  nonContiguous.snapshots[0]?.insufficiencyReasons.includes(
    "missing_world_observation:2023"
  )
);

console.log("Market opportunity fact calculation, reuse and isolation tests passed");
