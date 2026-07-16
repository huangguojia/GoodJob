import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import type { CrmStore } from "./store.js";
import type { MarketTradeObservation, SessionUser } from "./types.js";

const CURSOR_VERSION = 1;
const CURSOR_SORT = "period_desc_created_desc_id_desc";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEVELOPMENT_CURSOR_SECRET = randomBytes(48).toString("base64url");

type PeriodType = "annual" | "monthly" | "unknown";
type ValueState = "reported" | "reported_zero" | "suppressed" | "unavailable" | "unknown";
type MeasurementState = "reported" | "reported_zero" | "unavailable";

const optionalFilter = (max: number, pattern?: RegExp) => {
  let schema = z.string().trim().min(1).max(max);
  if (pattern) schema = schema.regex(pattern);
  return schema.optional();
};

const publicPeriodSchema = z.string().regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/);

const querySchema = z.object({
  providerId: optionalFilter(80, /^[A-Za-z0-9._-]+$/),
  reporterCode: optionalFilter(16, /^[A-Za-z0-9._-]+$/),
  partnerCode: optionalFilter(16, /^[A-Za-z0-9._-]+$/),
  flow: z.enum(["import", "export"]).optional(),
  classification: optionalFilter(40, /^[A-Za-z0-9._-]+$/),
  commodityCode: optionalFilter(32, /^[A-Za-z0-9._-]+$/),
  periodType: z.enum(["annual", "monthly"]).optional(),
  period: publicPeriodSchema.optional(),
  periodFrom: publicPeriodSchema.optional(),
  periodTo: publicPeriodSchema.optional(),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
}).strict().superRefine((value, context) => {
  const hasFrom = Boolean(value.periodFrom);
  const hasTo = Boolean(value.periodTo);
  if (hasFrom !== hasTo) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: hasFrom ? ["periodTo"] : ["periodFrom"],
      message: "periodFrom 和 periodTo 必须同时提供"
    });
  }
  if (value.period && (hasFrom || hasTo)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["period"],
      message: "period 不能与 periodFrom/periodTo 同时使用"
    });
  }
  const periods = [value.period, value.periodFrom, value.periodTo].filter(
    (item): item is string => Boolean(item)
  );
  const inferredTypes = new Set(periods.map(publicPeriodType));
  if (inferredTypes.size > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["periodFrom"],
      message: "期间筛选必须全部为年度或全部为月度"
    });
  }
  const inferredType = periods.length ? publicPeriodType(periods[0]!) : null;
  if (value.periodType && inferredType && value.periodType !== inferredType) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["periodType"],
      message: "periodType 与期间格式不一致"
    });
  }
  if (value.periodFrom && value.periodTo
    && internalPeriod(value.periodFrom) > internalPeriod(value.periodTo)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["periodFrom"],
      message: "periodFrom 不能晚于 periodTo"
    });
  }
});

const cursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  filterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  datasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sort: z.literal(CURSOR_SORT),
  periodSortKey: z.string().min(1).max(40),
  createdAt: z.string().datetime(),
  id: z.string().min(1).max(100)
}).strict();

type ParsedQuery = z.infer<typeof querySchema>;
type CursorPayload = z.infer<typeof cursorPayloadSchema>;

interface NormalizedFilters {
  providerId: string | null;
  reporterCode: string | null;
  partnerCode: string | null;
  flow: "import" | "export" | null;
  classification: string | null;
  commodityCode: string | null;
  periodType: "annual" | "monthly" | null;
  period: string | null;
  periodFrom: string | null;
  periodTo: string | null;
}

export class TradeObservationListRequestError extends Error {
  readonly status = 400;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TradeObservationListRequestError";
    this.code = code;
  }
}

export function tradeObservationListMetadata(
  campaignContractMode: "compat_v1" | "formal_v1" = "compat_v1"
) {
  return {
    campaignContractMode,
    campaignScope: "owner",
    observationScope: "campaign_current_observations",
    dataScope: "country_trade_statistics",
    absenceMeaning: "not_observed_not_zero",
    sort: CURSOR_SORT
  } as const;
}

export function validateTradeObservationCursorSecurity() {
  const configured = process.env.TRADE_OBSERVATION_CURSOR_SECRET?.trim() || "";
  if (process.env.NODE_ENV === "production" && configured.length < 32) {
    throw new Error("生产环境必须配置至少 32 位的 TRADE_OBSERVATION_CURSOR_SECRET");
  }
}

function cursorSecret() {
  const configured = process.env.TRADE_OBSERVATION_CURSOR_SECRET?.trim() || "";
  if (configured && configured.length < 32) {
    throw new Error("TRADE_OBSERVATION_CURSOR_SECRET 至少需要 32 位");
  }
  return configured || DEVELOPMENT_CURSOR_SECRET;
}

function publicPeriodType(value: string): Exclude<PeriodType, "unknown"> {
  return value.includes("-") ? "monthly" : "annual";
}

function internalPeriod(value: string) {
  return value.replace("-", "");
}

function storedPeriodType(value: string): PeriodType {
  if (/^\d{4}$/.test(value)) return "annual";
  if (/^\d{4}(?:0[1-9]|1[0-2])$/.test(value)) return "monthly";
  return "unknown";
}

function publicPeriod(value: string) {
  return storedPeriodType(value) === "monthly"
    ? `${value.slice(0, 4)}-${value.slice(4)}`
    : value;
}

function normalizedFilters(query: ParsedQuery): NormalizedFilters {
  const inferredType = query.period
    ? publicPeriodType(query.period)
    : query.periodFrom
      ? publicPeriodType(query.periodFrom)
      : null;
  return {
    providerId: query.providerId?.toLocaleLowerCase() || null,
    reporterCode: query.reporterCode || null,
    partnerCode: query.partnerCode || null,
    flow: query.flow || null,
    classification: query.classification?.toUpperCase() || null,
    commodityCode: query.commodityCode?.toUpperCase() || null,
    periodType: query.periodType || inferredType,
    period: query.period || null,
    periodFrom: query.periodFrom || null,
    periodTo: query.periodTo || null
  };
}

function stableFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function filterFingerprint(filters: NormalizedFilters) {
  return stableFingerprint(filters);
}

function datasetFingerprint(observations: MarketTradeObservation[]) {
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
        netWeightKg: item.netWeightKg,
        quantity: item.quantity,
        quantityUnit: item.quantityUnit,
        isAggregate: item.isAggregate,
        suppressed: item.suppressed,
        statusFlags: item.statusFlags,
        payloadHash: item.payloadHash,
        adapterVersion: item.adapterVersion,
        sourceRevision: item.sourceRevision,
        observedAt: item.observedAt,
        createdAt: item.createdAt
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
}

function scopeContext(user: SessionUser, campaignId: string) {
  return [user.teamId, user.id, campaignId].join("\u001f");
}

function cursorSignature(encodedPayload: string, context: string) {
  return createHmac("sha256", cursorSecret())
    .update(context)
    .update("\n")
    .update(encodedPayload)
    .digest("base64url");
}

function encodeCursor(payload: CursorPayload, context: string) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${cursorSignature(encodedPayload, context)}`;
}

function validSignature(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function decodeCursor(value: string, context: string) {
  const [encodedPayload, signature, ...rest] = value.split(".");
  if (!encodedPayload || !signature || rest.length
    || !validSignature(signature, cursorSignature(encodedPayload, context))) {
    throw new TradeObservationListRequestError(
      "TRADE_OBSERVATION_CURSOR_INVALID",
      "分页游标无效、已过期或不属于当前查询"
    );
  }
  try {
    return cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))
    );
  } catch {
    throw new TradeObservationListRequestError(
      "TRADE_OBSERVATION_CURSOR_INVALID",
      "分页游标无效、已过期或不属于当前查询"
    );
  }
}

function matchesFilters(item: MarketTradeObservation, filters: NormalizedFilters) {
  const itemPeriodType = storedPeriodType(item.period);
  if (filters.providerId && item.providerId.toLocaleLowerCase() !== filters.providerId) return false;
  if (filters.reporterCode && item.reporterCode !== filters.reporterCode) return false;
  if (filters.partnerCode && item.partnerCode !== filters.partnerCode) return false;
  if (filters.flow && item.tradeFlow !== (filters.flow === "import" ? "IMPORT" : "EXPORT")) return false;
  if (filters.classification && item.classification.toUpperCase() !== filters.classification) return false;
  if (filters.commodityCode && item.commodityCode.toUpperCase() !== filters.commodityCode) return false;
  if (filters.periodType && itemPeriodType !== filters.periodType) return false;
  if (filters.period && item.period !== internalPeriod(filters.period)) return false;
  if (filters.periodFrom && item.period < internalPeriod(filters.periodFrom)) return false;
  if (filters.periodTo && item.period > internalPeriod(filters.periodTo)) return false;
  return true;
}

function periodSortKey(item: MarketTradeObservation) {
  return storedPeriodType(item.period) === "unknown"
    ? `0:${item.period}`
    : `1:${item.period}`;
}

function compareObservations(left: MarketTradeObservation, right: MarketTradeObservation) {
  const periodOrder = periodSortKey(right).localeCompare(periodSortKey(left));
  if (periodOrder) return periodOrder;
  const createdOrder = right.createdAt.localeCompare(left.createdAt);
  if (createdOrder) return createdOrder;
  return right.id.localeCompare(left.id);
}

function afterCursor(item: MarketTradeObservation, cursor: CursorPayload) {
  const itemPeriodSortKey = periodSortKey(item);
  if (itemPeriodSortKey !== cursor.periodSortKey) {
    return itemPeriodSortKey.localeCompare(cursor.periodSortKey) < 0;
  }
  if (item.createdAt !== cursor.createdAt) {
    return item.createdAt.localeCompare(cursor.createdAt) < 0;
  }
  return item.id.localeCompare(cursor.id) < 0;
}

function tradeValueState(item: MarketTradeObservation): ValueState {
  if (item.suppressed) return "suppressed";
  if (item.tradeValueUsd === 0) return "reported_zero";
  if (typeof item.tradeValueUsd === "number") return "reported";
  if (item.statusFlags.includes("TRADE_VALUE_MISSING")) return "unavailable";
  return "unknown";
}

function measurementState(value: number | null): MeasurementState {
  if (value === 0) return "reported_zero";
  if (typeof value === "number") return "reported";
  return "unavailable";
}

function publicObservation(item: MarketTradeObservation) {
  const state = tradeValueState(item);
  return {
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
    periodType: storedPeriodType(item.period),
    period: publicPeriod(item.period),
    tradeValueUsd: item.tradeValueUsd,
    tradeValueState: state,
    netWeightKg: item.netWeightKg,
    netWeightState: measurementState(item.netWeightKg),
    quantity: item.quantity,
    quantityUnit: item.quantityUnit || null,
    quantityState: measurementState(item.quantity),
    isAggregate: item.isAggregate,
    suppressed: item.suppressed,
    statusFlags: [...item.statusFlags],
    adapterVersion: item.adapterVersion,
    sourceRevision: item.sourceRevision || null,
    observedAt: item.observedAt,
    createdAt: item.createdAt
  };
}

export function parseTradeObservationListQuery(value: unknown) {
  return querySchema.parse(value);
}

export function listTradeObservations(input: {
  store: CrmStore;
  user: SessionUser;
  campaignId: string;
  campaignContractMode?: "compat_v1" | "formal_v1";
  query: ParsedQuery;
}) {
  const filters = normalizedFilters(input.query);
  const filterHash = filterFingerprint(filters);
  const matched = input.store.marketTradeObservations
    .filter((item) =>
      item.teamId === input.user.teamId
      && item.ownerId === input.user.id
      && item.campaignId === input.campaignId
    )
    .filter((item) => matchesFilters(item, filters))
    .sort(compareObservations);
  const datasetHash = datasetFingerprint(matched);
  const context = scopeContext(input.user, input.campaignId);
  const cursor = input.query.cursor ? decodeCursor(input.query.cursor, context) : null;
  if (cursor && (cursor.filterFingerprint !== filterHash
    || cursor.datasetFingerprint !== datasetHash)) {
    throw new TradeObservationListRequestError(
      "TRADE_OBSERVATION_CURSOR_INVALID",
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
        datasetFingerprint: datasetHash,
        sort: CURSOR_SORT,
        periodSortKey: periodSortKey(last),
        createdAt: last.createdAt,
        id: last.id
      }, context)
    : null;
  return {
    campaignId: input.campaignId,
    ...tradeObservationListMetadata(input.campaignContractMode),
    filters,
    total: matched.length,
    pageCount: page.length,
    hasMore,
    nextCursor,
    observations: page.map(publicObservation)
  };
}
