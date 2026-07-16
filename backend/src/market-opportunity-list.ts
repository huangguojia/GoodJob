import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import { currentMarketOpportunityDatasetFingerprint } from "./market-opportunity-facts.js";
import type { CrmStore } from "./store.js";
import type {
  MarketOpportunityCalculationEvent,
  MarketOpportunityEvidence,
  MarketOpportunitySnapshot,
  SessionUser
} from "./types.js";

const CURSOR_VERSION = 1;
const CURSOR_SORT = "country_classification_commodity_id_asc";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEVELOPMENT_CURSOR_SECRET = randomBytes(48).toString("base64url");

const optionalCode = (max: number) =>
  z.string().trim().min(1).max(max).regex(/^[A-Za-z0-9._-]+$/).optional();

const querySchema = z.object({
  batchId: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  countryCode: optionalCode(16),
  classification: optionalCode(40),
  commodityCode: optionalCode(32),
  snapshotStatus: z.enum(["metrics_ready", "insufficient_data"]).optional(),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
}).strict();

const cursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  filterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  batchId: z.string().min(1).max(80),
  sort: z.literal(CURSOR_SORT),
  reporterCountry: z.string().max(100),
  reporterCode: z.string().max(16),
  classification: z.string().max(40),
  commodityCode: z.string().max(32),
  id: z.string().min(1).max(80)
}).strict();

type ParsedQuery = z.infer<typeof querySchema>;
type CursorPayload = z.infer<typeof cursorPayloadSchema>;

interface NormalizedFilters {
  countryCode: string | null;
  classification: string | null;
  commodityCode: string | null;
  snapshotStatus: "metrics_ready" | "insufficient_data" | null;
}

export class MarketOpportunityListRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "MarketOpportunityListRequestError";
    this.status = status;
    this.code = code;
  }
}

export function validateMarketOpportunityCursorSecurity() {
  const configured = process.env.MARKET_OPPORTUNITY_CURSOR_SECRET?.trim() || "";
  if (process.env.NODE_ENV === "production" && Buffer.byteLength(configured, "utf8") < 32) {
    throw new Error("生产环境必须配置至少 32 字节的 MARKET_OPPORTUNITY_CURSOR_SECRET");
  }
}

function cursorSecret() {
  const configured = process.env.MARKET_OPPORTUNITY_CURSOR_SECRET?.trim() || "";
  if (configured && Buffer.byteLength(configured, "utf8") < 32) {
    throw new Error("MARKET_OPPORTUNITY_CURSOR_SECRET 至少需要 32 字节");
  }
  return configured || DEVELOPMENT_CURSOR_SECRET;
}

function stableFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedFilters(query: ParsedQuery): NormalizedFilters {
  return {
    countryCode: query.countryCode || null,
    classification: query.classification?.toUpperCase() || null,
    commodityCode: query.commodityCode?.toUpperCase() || null,
    snapshotStatus: query.snapshotStatus || null
  };
}

function scopeContext(user: SessionUser, campaignId: string, batchId: string) {
  return [user.teamId, user.id, campaignId, batchId].join("\u001f");
}

function cursorSignature(encodedPayload: string, context: string) {
  return createHmac("sha256", cursorSecret())
    .update(context)
    .update("\n")
    .update(encodedPayload)
    .digest("base64url");
}

function encodeCursor(payload: CursorPayload, context: string) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${cursorSignature(encoded, context)}`;
}

function validSignature(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function decodeCursor(value: string, context: string) {
  const [encoded, signature, ...rest] = value.split(".");
  if (!encoded || !signature || rest.length
    || !validSignature(signature, cursorSignature(encoded, context))) {
    throw new MarketOpportunityListRequestError(
      400,
      "MARKET_OPPORTUNITY_CURSOR_INVALID",
      "分页游标无效、已过期或不属于当前查询"
    );
  }
  try {
    return cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
    );
  } catch {
    throw new MarketOpportunityListRequestError(
      400,
      "MARKET_OPPORTUNITY_CURSOR_INVALID",
      "分页游标无效、已过期或不属于当前查询"
    );
  }
}

function compareSnapshots(left: MarketOpportunitySnapshot, right: MarketOpportunitySnapshot) {
  return left.reporterCountry.localeCompare(right.reporterCountry)
    || left.reporterCode.localeCompare(right.reporterCode)
    || left.classification.localeCompare(right.classification)
    || left.commodityCode.localeCompare(right.commodityCode)
    || left.id.localeCompare(right.id);
}

function afterCursor(item: MarketOpportunitySnapshot, cursor: CursorPayload) {
  const cursorItem = {
    ...item,
    reporterCountry: cursor.reporterCountry,
    reporterCode: cursor.reporterCode,
    classification: cursor.classification,
    commodityCode: cursor.commodityCode,
    id: cursor.id
  };
  return compareSnapshots(item, cursorItem) > 0;
}

function matchesFilters(item: MarketOpportunitySnapshot, filters: NormalizedFilters) {
  if (filters.countryCode && item.reporterCode !== filters.countryCode) return false;
  if (filters.classification
    && item.classification.toUpperCase() !== filters.classification) return false;
  if (filters.commodityCode
    && item.commodityCode.toUpperCase() !== filters.commodityCode) return false;
  if (filters.snapshotStatus && item.snapshotStatus !== filters.snapshotStatus) return false;
  return true;
}

function publicEvidence(item: MarketOpportunityEvidence) {
  return {
    observationId: item.observationId,
    providerId: item.providerId,
    adapterVersion: item.adapterVersion,
    sourceRevision: item.sourceRevision || null,
    period: item.period,
    reporterCountry: item.reporterCountry,
    reporterCode: item.reporterCode,
    partnerCountry: item.partnerCountry,
    partnerCode: item.partnerCode,
    tradeFlow: item.tradeFlow,
    classification: item.classification,
    commodityCode: item.commodityCode,
    reportedImportValueUsd: item.tradeValueUsd,
    suppressed: item.suppressed,
    statusFlags: [...item.statusFlags]
  };
}

function publicSnapshot(item: MarketOpportunitySnapshot) {
  return {
    id: item.id,
    country: item.reporterCountry,
    countryCode: item.reporterCode,
    classification: item.classification,
    commodityCode: item.commodityCode,
    commodityDescription: item.commodityDescription,
    comparisonPeriod: item.comparisonPeriod || null,
    snapshotStatus: item.snapshotStatus,
    insufficiencyReasons: [...item.insufficiencyReasons],
    scoringStatus: "not_scored_v1",
    metrics: {
      metricVersion: item.metrics.metricVersion,
      reportedImportValueSeries: item.metrics.reportedImportValueSeries.map((point) => ({
        period: point.period,
        reportedImportValueUsd: point.tradeValueUsd,
        evidence: publicEvidence(point.evidence)
      })),
      yoyChanges: item.metrics.yoyChanges.map((change) => ({ ...change })),
      twoYearCagr: item.metrics.twoYearCagr,
      twoYearCagrReason: item.metrics.twoYearCagrReason || null,
      chinaMainlandSupplyShare: item.metrics.chinaMainlandSupplyShare,
      chinaMainlandSupplyShareReason:
        item.metrics.chinaMainlandSupplyShareReason || null,
      chinaMainlandEvidence: item.metrics.chinaMainlandEvidence
        ? publicEvidence(item.metrics.chinaMainlandEvidence)
        : null
    }
  };
}

function publicCalculation(item: MarketOpportunityCalculationEvent | undefined) {
  return item ? {
    eventId: item.id,
    triggerJobId: item.triggerJobId,
    batchId: item.batchId,
    outcome: item.outcome,
    reusedBatch: item.reusedBatch,
    sequence: item.sequence,
    calculatedAt: item.calculatedAt
  } : null;
}

function latestFirst<T extends { calculatedAt?: string; createdAt?: string; id: string }>(
  left: T,
  right: T
) {
  const leftAt = left.calculatedAt || left.createdAt || "";
  const rightAt = right.calculatedAt || right.createdAt || "";
  return rightAt.localeCompare(leftAt) || right.id.localeCompare(left.id);
}

function latestCalculationFirst(
  left: MarketOpportunityCalculationEvent,
  right: MarketOpportunityCalculationEvent
) {
  return right.sequence - left.sequence
    || right.calculatedAt.localeCompare(left.calculatedAt)
    || right.id.localeCompare(left.id);
}

export function parseMarketOpportunityListQuery(value: unknown) {
  return querySchema.parse(value);
}

export function listMarketOpportunities(input: {
  store: CrmStore;
  user: SessionUser;
  campaignId: string;
  campaignContractMode?: "compat_v1" | "formal_v1";
  query: ParsedQuery;
}) {
  const inScope = <T extends { teamId: string; ownerId: string; campaignId: string }>(
    item: T
  ) => item.teamId === input.user.teamId
    && item.ownerId === input.user.id
    && item.campaignId === input.campaignId;
  const calculations = input.store.marketOpportunityCalculationEvents
    .filter(inScope)
    .sort(latestCalculationFirst);
  const latestCalculation = calculations[0];
  const selectedBatch = input.query.batchId
    ? input.store.marketOpportunityBatches.find((item) =>
        item.id === input.query.batchId && inScope(item)
      )
    : latestCalculation
      ? input.store.marketOpportunityBatches.find((item) =>
          item.id === latestCalculation.batchId && inScope(item)
        )
      : undefined;

  if (input.query.batchId && !selectedBatch) {
    throw new MarketOpportunityListRequestError(
      404,
      "MARKET_OPPORTUNITY_BATCH_NOT_FOUND",
      "市场机会事实批次不存在或无权访问"
    );
  }

  const lastMetricsReadyBatch = input.store.marketOpportunityBatches
    .filter((item) => inScope(item) && item.readyCount > 0)
    .sort(latestFirst)[0];
  const filters = normalizedFilters(input.query);

  if (!selectedBatch) {
    return {
      campaignId: input.campaignId,
      campaignContractMode: input.campaignContractMode || "compat_v1",
      campaignScope: "owner",
      dataScope: "country_trade_statistics",
      opportunityScope: "market_opportunity_fact_snapshots_v1",
      scoringStatus: "not_scored_v1",
      calculationStatus: "never_calculated",
      absenceMeaning: "no_fact_snapshot_does_not_mean_zero_or_no_market",
      fallbackReason: null,
      interpretation:
        "报告进口额是海关统计事实，不等同于消费市场规模、真实需求或采购意向；转口、保税贸易、本地产量及统计差异会影响解读。",
      sort: CURSOR_SORT,
      filters,
      latestCalculation: null,
      selectedCalculation: null,
      selectedBatch: null,
      lastMetricsReadyBatch: null,
      isHistorical: false,
      isCurrentDataset: false,
      isStale: false,
      total: 0,
      pageCount: 0,
      hasMore: false,
      nextCursor: null,
      opportunities: []
    };
  }

  const selectedCalculation = calculations.find((item) => item.batchId === selectedBatch.id);
  const matched = input.store.marketOpportunitySnapshots
    .filter((item) => item.batchId === selectedBatch.id && inScope(item))
    .filter((item) => matchesFilters(item, filters))
    .sort(compareSnapshots);
  const filterHash = stableFingerprint(filters);
  const context = scopeContext(input.user, input.campaignId, selectedBatch.id);
  const cursor = input.query.cursor ? decodeCursor(input.query.cursor, context) : null;
  if (cursor && (cursor.filterFingerprint !== filterHash
    || cursor.batchId !== selectedBatch.id)) {
    throw new MarketOpportunityListRequestError(
      400,
      "MARKET_OPPORTUNITY_CURSOR_INVALID",
      "分页游标无效、已过期或不属于当前查询"
    );
  }
  const remaining = cursor ? matched.filter((item) => afterCursor(item, cursor)) : matched;
  const page = remaining.slice(0, input.query.limit);
  const hasMore = remaining.length > page.length;
  const last = page.at(-1);
  const nextCursor = hasMore && last
    ? encodeCursor({
        v: CURSOR_VERSION,
        filterFingerprint: filterHash,
        batchId: selectedBatch.id,
        sort: CURSOR_SORT,
        reporterCountry: last.reporterCountry,
        reporterCode: last.reporterCode,
        classification: last.classification,
        commodityCode: last.commodityCode,
        id: last.id
      }, context)
    : null;
  const currentFingerprint = currentMarketOpportunityDatasetFingerprint(input.store, {
    teamId: input.user.teamId,
    ownerId: input.user.id,
    campaignId: input.campaignId
  });
  const publicBatch = (batch: typeof selectedBatch | undefined) => batch ? {
    id: batch.id,
    providerId: batch.providerId,
    policyVersion: batch.policyVersion,
    status: batch.status,
    emptyReason: batch.emptyReason || null,
    candidateCount: batch.candidateCount,
    readyCount: batch.readyCount,
    comparisonPeriods: [...batch.comparisonPeriods],
    firstTriggerJobId: batch.firstTriggerJobId,
    observationCutoffAt: batch.observationCutoffAt,
    createdAt: batch.createdAt
  } : null;

  return {
    campaignId: input.campaignId,
    campaignContractMode: input.campaignContractMode || "compat_v1",
    campaignScope: "owner",
    dataScope: "country_trade_statistics",
    opportunityScope: "market_opportunity_fact_snapshots_v1",
    scoringStatus: "not_scored_v1",
    calculationStatus: selectedBatch.status,
    absenceMeaning: "no_fact_snapshot_does_not_mean_zero_or_no_market",
    fallbackReason: null,
    interpretation:
      "报告进口额是海关统计事实，不等同于消费市场规模、真实需求或采购意向；转口、保税贸易、本地产量及统计差异会影响解读。",
    sort: CURSOR_SORT,
    filters,
    latestCalculation: publicCalculation(latestCalculation),
    selectedCalculation: publicCalculation(selectedCalculation),
    selectedBatch: publicBatch(selectedBatch),
    lastMetricsReadyBatch: publicBatch(lastMetricsReadyBatch),
    isHistorical: Boolean(latestCalculation && latestCalculation.batchId !== selectedBatch.id),
    isCurrentDataset: selectedBatch.datasetFingerprint === currentFingerprint,
    isStale: selectedBatch.datasetFingerprint !== currentFingerprint,
    total: matched.length,
    pageCount: page.length,
    hasMore,
    nextCursor,
    opportunities: page.map(publicSnapshot)
  };
}
