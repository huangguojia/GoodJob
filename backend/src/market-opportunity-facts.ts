import { createHash, randomUUID } from "node:crypto";
import type { CrmStore } from "./store.js";
import type {
  MarketOpportunityBatch,
  MarketOpportunityCalculationEvent,
  MarketOpportunityEvidence,
  MarketOpportunityMetrics,
  MarketOpportunitySnapshot,
  MarketTradeObservation
} from "./types.js";

export const MARKET_OPPORTUNITY_POLICY_VERSION = "market_opportunity_facts_v1";
const PROVIDER_ID = "un_comtrade";
const WORLD_PARTNER_CODE = "0";
const CHINA_MAINLAND_PARTNER_CODE = "156";

interface OpportunityScope {
  teamId: string;
  ownerId: string;
  campaignId: string;
  triggerJobId: string;
  calculatedAt?: string;
}

interface ProductGroup {
  classification: string;
  commodityCode: string;
  observations: MarketTradeObservation[];
}

function stableFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalized(value: string) {
  return value.trim().normalize("NFKC").toLowerCase();
}

function productKey(item: MarketTradeObservation) {
  return [item.classification, item.commodityCode].map(normalized).join("\u001f");
}

function reporterKey(item: MarketTradeObservation) {
  return normalized(item.reporterCode);
}

function sourceObservations(
  store: CrmStore,
  scope: Pick<OpportunityScope, "teamId" | "ownerId" | "campaignId">
) {
  return store.marketTradeObservations.filter((item) =>
    item.teamId === scope.teamId
    && item.ownerId === scope.ownerId
    && item.campaignId === scope.campaignId
    && item.providerId === PROVIDER_ID
    && item.tradeFlow === "IMPORT"
    && /^\d{4}$/.test(item.period)
    && Boolean(item.reporterCode.trim())
    && Boolean(item.classification.trim())
    && Boolean(item.commodityCode.trim())
  );
}

export function currentMarketOpportunityDatasetFingerprint(
  store: CrmStore,
  scope: Pick<OpportunityScope, "teamId" | "ownerId" | "campaignId">
) {
  return marketOpportunityDatasetFingerprint(sourceObservations(store, scope));
}

export function marketOpportunityDatasetFingerprint(
  observations: MarketTradeObservation[]
) {
  return stableFingerprint(
    observations
      .map((item) => ({
        id: item.id,
        providerId: item.providerId,
        reporterCountry: item.reporterCountry,
        reporterCode: item.reporterCode,
        partnerCountry: item.partnerCountry,
        partnerCode: item.partnerCode,
        tradeFlow: item.tradeFlow,
        classification: item.classification,
        commodityCode: item.commodityCode,
        commodityDescription: item.commodityDescription,
        period: item.period,
        tradeValueUsd: item.tradeValueUsd,
        suppressed: item.suppressed,
        statusFlags: item.statusFlags,
        payloadHash: item.payloadHash,
        adapterVersion: item.adapterVersion,
        sourceRevision: item.sourceRevision,
        observedAt: item.observedAt
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
}

function evidence(item: MarketTradeObservation): MarketOpportunityEvidence {
  return {
    observationId: item.id,
    payloadHash: item.payloadHash,
    providerId: PROVIDER_ID,
    adapterVersion: item.adapterVersion,
    sourceRevision: item.sourceRevision,
    period: item.period,
    reporterCountry: item.reporterCountry,
    reporterCode: item.reporterCode,
    partnerCountry: item.partnerCountry,
    partnerCode: item.partnerCode,
    tradeFlow: "IMPORT",
    classification: item.classification,
    commodityCode: item.commodityCode,
    tradeValueUsd: item.tradeValueUsd,
    suppressed: item.suppressed,
    statusFlags: [...item.statusFlags]
  };
}

function isUsableValue(item: MarketTradeObservation) {
  return !item.suppressed
    && !item.statusFlags.includes("CLASSIFICATION_CONVERTED")
    && typeof item.tradeValueUsd === "number"
    && Number.isFinite(item.tradeValueUsd)
    && item.tradeValueUsd >= 0;
}

function matchingPartner(
  observations: MarketTradeObservation[],
  reporter: MarketTradeObservation,
  period: string,
  partnerCode: string
) {
  return observations
    .filter((item) =>
      reporterKey(item) === reporterKey(reporter)
      && item.period === period
      && item.partnerCode === partnerCode
    )
    .sort((left, right) => {
      const observedOrder = right.observedAt.localeCompare(left.observedAt);
      return observedOrder || right.id.localeCompare(left.id);
    });
}

function selectEvidence(
  candidates: MarketTradeObservation[],
  kind: "world" | "china"
) {
  if (!candidates.length) {
    return {
      item: null,
      reason: kind === "world"
        ? "missing_world_observation"
        : "missing_china_mainland_observation"
    } as const;
  }
  const signatures = new Set(candidates.map((item) => JSON.stringify({
    payloadHash: item.payloadHash,
    tradeValueUsd: item.tradeValueUsd,
    suppressed: item.suppressed,
    statusFlags: [...item.statusFlags].sort()
  })));
  if (signatures.size > 1) {
    return {
      item: null,
      reason: kind === "world"
        ? "conflicting_world_observations"
        : "conflicting_china_mainland_observations"
    } as const;
  }
  const item = candidates[0]!;
  if (!isUsableValue(item)) {
    return {
      item: null,
      reason: kind === "world"
        ? "world_value_unavailable"
        : "china_mainland_value_unavailable"
    } as const;
  }
  return { item, reason: "" } as const;
}

function emptyMetrics(): MarketOpportunityMetrics {
  return {
    metricVersion: MARKET_OPPORTUNITY_POLICY_VERSION,
    reportedImportValueSeries: [],
    yoyChanges: [],
    twoYearCagr: null,
    twoYearCagrReason: "insufficient_world_series",
    chinaMainlandSupplyShare: null,
    chinaMainlandSupplyShareReason: "insufficient_world_series",
    chinaMainlandEvidence: null
  };
}

function calculateSnapshot(input: {
  batch: MarketOpportunityBatch;
  group: ProductGroup;
  reporter: MarketTradeObservation;
  comparisonPeriod: string;
  createdAt: string;
}): MarketOpportunitySnapshot {
  const reasons: string[] = [];
  const metrics = emptyMetrics();
  const comparisonYear = Number(input.comparisonPeriod);
  const periods = Number.isInteger(comparisonYear)
    ? [comparisonYear - 2, comparisonYear - 1, comparisonYear].map(String)
    : [];

  if (!periods.length) {
    reasons.push("missing_common_comparison_period");
  } else {
    for (const period of periods) {
      const selected = selectEvidence(
        matchingPartner(
          input.group.observations,
          input.reporter,
          period,
          WORLD_PARTNER_CODE
        ),
        "world"
      );
      if (!selected.item) {
        reasons.push(`${selected.reason}:${period}`);
        continue;
      }
      metrics.reportedImportValueSeries.push({
        period,
        tradeValueUsd: selected.item.tradeValueUsd!,
        evidence: evidence(selected.item)
      });
    }
  }

  if (metrics.reportedImportValueSeries.length === 3) {
    for (let index = 1; index < metrics.reportedImportValueSeries.length; index += 1) {
      const previous = metrics.reportedImportValueSeries[index - 1]!;
      const current = metrics.reportedImportValueSeries[index]!;
      metrics.yoyChanges.push({
        fromPeriod: previous.period,
        toPeriod: current.period,
        value: previous.tradeValueUsd === 0
          ? null
          : (current.tradeValueUsd - previous.tradeValueUsd) / previous.tradeValueUsd,
        reason: previous.tradeValueUsd === 0 ? "base_period_zero" : ""
      });
    }
    const first = metrics.reportedImportValueSeries[0]!;
    const latest = metrics.reportedImportValueSeries[2]!;
    if (first.tradeValueUsd === 0) {
      metrics.twoYearCagrReason = "base_period_zero";
    } else {
      metrics.twoYearCagr = Math.pow(latest.tradeValueUsd / first.tradeValueUsd, 1 / 2) - 1;
      metrics.twoYearCagrReason = "";
    }

    const china = selectEvidence(
      matchingPartner(
        input.group.observations,
        input.reporter,
        input.comparisonPeriod,
        CHINA_MAINLAND_PARTNER_CODE
      ),
      "china"
    );
    if (!china.item) {
      metrics.chinaMainlandSupplyShareReason = china.reason;
    } else if (latest.tradeValueUsd <= 0) {
      metrics.chinaMainlandSupplyShareReason = "world_value_not_positive";
    } else if (china.item.tradeValueUsd! > latest.tradeValueUsd) {
      metrics.chinaMainlandSupplyShareReason = "china_mainland_value_exceeds_world";
    } else {
      metrics.chinaMainlandSupplyShare =
        china.item.tradeValueUsd! / latest.tradeValueUsd;
      metrics.chinaMainlandSupplyShareReason = "";
      metrics.chinaMainlandEvidence = evidence(china.item);
    }
  } else if (periods.length) {
    reasons.unshift("non_contiguous_three_year_series");
  }

  return {
    id: `mos_${randomUUID()}`,
    batchId: input.batch.id,
    teamId: input.batch.teamId,
    ownerId: input.batch.ownerId,
    campaignId: input.batch.campaignId,
    providerId: PROVIDER_ID,
    reporterCountry: input.reporter.reporterCountry,
    reporterCode: input.reporter.reporterCode,
    classification: input.group.classification,
    commodityCode: input.group.commodityCode,
    commodityDescription: input.reporter.commodityDescription,
    comparisonPeriod: input.comparisonPeriod,
    snapshotStatus: reasons.length ? "insufficient_data" : "metrics_ready",
    insufficiencyReasons: reasons,
    metrics,
    marketScore: null,
    growthScore: null,
    chinaSupplyScore: null,
    createdAt: input.createdAt
  };
}

function buildGroups(observations: MarketTradeObservation[]) {
  const groups = new Map<string, ProductGroup>();
  for (const item of observations) {
    const key = productKey(item);
    const existing = groups.get(key);
    if (existing) {
      existing.observations.push(item);
    } else {
      groups.set(key, {
        classification: item.classification,
        commodityCode: item.commodityCode,
        observations: [item]
      });
    }
  }
  return [...groups.values()].sort((left, right) =>
    left.classification.localeCompare(right.classification)
    || left.commodityCode.localeCompare(right.commodityCode)
  );
}

function comparisonPeriod(group: ProductGroup) {
  const currentYear = new Date().getUTCFullYear();
  return group.observations
    .filter((item) =>
      item.partnerCode === WORLD_PARTNER_CODE
      && isUsableValue(item)
      && Number(item.period) < currentYear
    )
    .map((item) => item.period)
    .sort((left, right) => right.localeCompare(left))[0] || "";
}

export function materializeMarketOpportunityFacts(
  store: CrmStore,
  scope: OpportunityScope
) {
  const observations = sourceObservations(store, scope);
  const datasetFingerprint = marketOpportunityDatasetFingerprint(observations);
  const existingBatch = store.marketOpportunityBatches.find((item) =>
    item.teamId === scope.teamId
    && item.ownerId === scope.ownerId
    && item.campaignId === scope.campaignId
    && item.providerId === PROVIDER_ID
    && item.datasetFingerprint === datasetFingerprint
    && item.policyVersion === MARKET_OPPORTUNITY_POLICY_VERSION
  );
  const calculatedAt = scope.calculatedAt || new Date().toISOString();
  const observationCutoffAt = observations
    .map((item) => item.observedAt)
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] || null;
  let batch = existingBatch;
  let snapshots: MarketOpportunitySnapshot[] = [];

  if (!batch) {
    const groups = buildGroups(observations);
    const candidates = groups.flatMap((group) => {
      const reporters = new Map<string, MarketTradeObservation>();
      for (const item of group.observations) {
        if (!reporters.has(reporterKey(item))) reporters.set(reporterKey(item), item);
      }
      const commonPeriod = comparisonPeriod(group);
      return [...reporters.values()]
        .sort((left, right) =>
          left.reporterCountry.localeCompare(right.reporterCountry)
          || left.reporterCode.localeCompare(right.reporterCode)
        )
        .map((reporter) => ({ group, reporter, commonPeriod }));
    });
    batch = {
      id: `mob_${randomUUID()}`,
      teamId: scope.teamId,
      ownerId: scope.ownerId,
      campaignId: scope.campaignId,
      providerId: PROVIDER_ID,
      datasetFingerprint,
      policyVersion: MARKET_OPPORTUNITY_POLICY_VERSION,
      status: "insufficient_data",
      emptyReason: observations.length ? "" : "no_eligible_observations",
      candidateCount: candidates.length,
      readyCount: 0,
      comparisonPeriods: [...new Set(candidates.map((item) => item.commonPeriod).filter(Boolean))].sort(),
      firstTriggerJobId: scope.triggerJobId,
      observationCutoffAt,
      createdAt: calculatedAt
    };
    snapshots = candidates.map((candidate) => calculateSnapshot({
      batch: batch!,
      group: candidate.group,
      reporter: candidate.reporter,
      comparisonPeriod: candidate.commonPeriod,
      createdAt: calculatedAt
    }));
    batch.readyCount = snapshots.filter((item) => item.snapshotStatus === "metrics_ready").length;
    batch.status = batch.readyCount === snapshots.length && snapshots.length
      ? "metrics_ready"
      : batch.readyCount
        ? "partial"
        : "insufficient_data";
    if (!batch.emptyReason && !batch.readyCount) {
      batch.emptyReason = snapshots.some((item) =>
        item.insufficiencyReasons.includes("non_contiguous_three_year_series")
      )
        ? "non_contiguous_three_year_series"
        : batch.comparisonPeriods.length
          ? "all_candidates_insufficient"
        : "missing_world_series";
    }
    store.marketOpportunityBatches.unshift(batch);
    store.marketOpportunitySnapshots.unshift(...snapshots);
  }

  const event: MarketOpportunityCalculationEvent = {
    id: `moe_${randomUUID()}`,
    teamId: scope.teamId,
    ownerId: scope.ownerId,
    campaignId: scope.campaignId,
    triggerJobId: scope.triggerJobId,
    batchId: batch.id,
    datasetFingerprint,
    policyVersion: MARKET_OPPORTUNITY_POLICY_VERSION,
    outcome: batch.status,
    reusedBatch: Boolean(existingBatch),
    sequence: Math.max(
      0,
      ...store.marketOpportunityCalculationEvents.map((item) => item.sequence)
    ) + 1,
    calculatedAt
  };
  store.marketOpportunityCalculationEvents.unshift(event);
  return {
    batch,
    snapshots,
    event,
    reusedBatch: event.reusedBatch
  };
}
