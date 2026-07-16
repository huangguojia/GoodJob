import { z } from "zod";
import {
  ProviderContractError,
  defineTradeProvider,
  providerHttpStatusError,
  type NormalizedTradeQuery,
  type ProviderTradeAdapterPage,
  type ProviderUsage,
  type TradeHsVersion,
  type TradeObservationAdapter
} from "./provider-contract.js";

const UN_COMTRADE_HOST = "comtradeapi.un.org";
const UN_COMTRADE_BASE_URL = `https://${UN_COMTRADE_HOST}`;

const rawRecordSchema = z.object({
  reporterCode: z.number().int().nonnegative().optional(),
  reporterISO: z.string().max(10).nullable().optional(),
  reporterDesc: z.string().max(160).nullable().optional(),
  partnerCode: z.number().int().nonnegative().optional(),
  partnerISO: z.string().max(10).nullable().optional(),
  partnerDesc: z.string().max(160).nullable().optional(),
  flowCode: z.string().max(10).nullable().optional(),
  classificationCode: z.string().max(20).nullable().optional(),
  classificationSearchCode: z.string().max(20).nullable().optional(),
  cmdCode: z.string().max(12),
  period: z.string().max(12),
  primaryValue: z.number().finite().nullable().optional(),
  netWgt: z.number().finite().nullable().optional(),
  qty: z.number().finite().nullable().optional(),
  qtyUnitAbbr: z.string().max(40).nullable().optional(),
  isAggregate: z.boolean().nullable().optional(),
  isReported: z.boolean().nullable().optional(),
  isOriginalClassification: z.boolean().nullable().optional(),
  aggregateLevel: z.number().int().nonnegative().nullable().optional()
}).passthrough();

const responseSchema = z.object({
  data: z.array(rawRecordSchema).max(500),
  count: z.number().int().nonnegative().optional()
}).passthrough();

type RawComtradeRecord = z.infer<typeof rawRecordSchema>;

function usage(display: string): Partial<ProviderUsage> {
  return {
    requestCount: 1,
    quotaUsed: null,
    quotaRemaining: null,
    costAmount: 0,
    currency: "USD",
    estimated: false,
    display
  };
}

function actualClassification(code: string | null | undefined) {
  const normalized = (code || "").trim().toUpperCase();
  if (normalized === "H6") return "HS2017";
  if (normalized === "H7") return "HS2022";
  return normalized || "HS";
}

function requestedClassificationMatches(actual: string, requested: TradeHsVersion) {
  return requested === "HS" || actual === requested;
}

function countryLabel(
  iso: string | null | undefined,
  description: string | null | undefined,
  code: number | undefined
) {
  if (code === 0 || description?.trim().toLocaleLowerCase() === "world") return "WORLD";
  return iso?.trim().toUpperCase() || description?.trim() || String(code ?? "UNKNOWN");
}

function tradeFlow(record: RawComtradeRecord) {
  const flow = (record.flowCode || "").trim().toUpperCase();
  if (flow === "M" || flow === "X") return flow === "M" ? "IMPORT" as const : "EXPORT" as const;
  return null;
}

function statusFlags(record: RawComtradeRecord) {
  const flags: string[] = [];
  if (record.isReported === false) flags.push("NOT_REPORTED");
  if (record.isOriginalClassification === false) flags.push("CLASSIFICATION_CONVERTED");
  if (record.primaryValue === null || record.primaryValue === undefined) flags.push("TRADE_VALUE_MISSING");
  if (record.netWgt === null || record.netWgt === undefined) flags.push("NET_WEIGHT_MISSING");
  if (record.qty === null || record.qty === undefined) flags.push("QUANTITY_MISSING");
  return flags;
}

function canonicalNumericCode(value: string | number | undefined) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const numeric = Number(normalized);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? String(numeric) : null;
}

function recordMatchesQuery(record: RawComtradeRecord, query: NormalizedTradeQuery) {
  const reporterCode = canonicalNumericCode(record.reporterCode);
  const partnerCode = canonicalNumericCode(record.partnerCode);
  const requestedReporters = new Set(query.reporterCodes.map(canonicalNumericCode).filter(Boolean));
  const requestedPartners = new Set(query.partnerCodes.map(canonicalNumericCode).filter(Boolean));
  const expectedFlow = query.flow === "import" ? "IMPORT" : "EXPORT";
  const flow = tradeFlow(record);
  return Boolean(
    reporterCode
    && partnerCode
    && requestedReporters.has(reporterCode)
    && requestedPartners.has(partnerCode)
    && query.commodityCodes.includes(record.cmdCode.trim())
    && query.periods.includes(record.period.trim())
    && flow === expectedFlow
    && (record.primaryValue === null
      || record.primaryValue === undefined
      || record.primaryValue >= 0)
    && (record.netWgt === null || record.netWgt === undefined || record.netWgt >= 0)
    && (record.qty === null || record.qty === undefined || record.qty >= 0)
  );
}

function observation(record: RawComtradeRecord, query: NormalizedTradeQuery): TradeObservationAdapter {
  const classification = actualClassification(record.classificationCode || record.classificationSearchCode);
  const reporter = countryLabel(record.reporterISO, record.reporterDesc, record.reporterCode);
  const partner = countryLabel(record.partnerISO, record.partnerDesc, record.partnerCode);
  const flow = tradeFlow(record);
  if (!flow) throw new Error("UN Comtrade flow must be validated before mapping");
  const commodityCode = record.cmdCode.trim();
  const period = record.period.trim();
  return {
    reporterCountry: reporter,
    partnerCountry: partner,
    reporterCode: String(record.reporterCode ?? ""),
    partnerCode: String(record.partnerCode ?? ""),
    tradeFlow: flow,
    classification,
    requestedClassification: query.hsVersion,
    commodityCode,
    commodityDescription: "",
    period,
    tradeValueUsd: record.primaryValue ?? null,
    netWeightKg: record.netWgt ?? null,
    quantity: record.qty ?? null,
    quantityUnit: record.qtyUnitAbbr?.trim() || null,
    isAggregate: record.isAggregate ?? ((record.aggregateLevel || commodityCode.length) < 6),
    suppressed: record.isReported === false,
    statusFlags: statusFlags(record),
    sourceRevision: null,
    providerRecordId: [
      reporter,
      partner,
      flow,
      classification,
      commodityCode,
      period
    ].join(":")
  };
}

function parseResponse(value: unknown, query: NormalizedTradeQuery): ProviderTradeAdapterPage {
  let parsed: z.infer<typeof responseSchema>;
  try {
    parsed = responseSchema.parse(value);
  } catch (error) {
    throw new ProviderContractError({
      code: "PROVIDER_SCHEMA_CHANGED",
      retryable: false,
      retryAfterAt: null,
      publicMessage: "UN Comtrade 返回结构发生变化，已暂停本次查询",
      httpStatus: null,
      phase: "trade"
    }, { cause: error });
  }
  const validRecords = parsed.data.filter((record) => recordMatchesQuery(record, query));
  const invalidCount = parsed.data.length - validRecords.length;
  const observations = validRecords.map((record) => observation(record, query));
  const versionMismatches = [...new Set(observations
    .filter((item) => !requestedClassificationMatches(item.classification, query.hsVersion))
    .map((item) => `${item.requestedClassification}->${item.classification}`))];
  const reachedLimit = parsed.data.length >= query.limit;
  return {
    observations,
    rawCount: parsed.count ?? parsed.data.length,
    invalidCount,
    exhausted: !reachedLimit,
    warnings: [
      ...(invalidCount
        ? [`${invalidCount} 条 UN Comtrade 记录因关键字段缺失、数值无效或超出查询范围未写入`]
        : []),
      ...versionMismatches.map((item) => `UN Comtrade 分类版本不匹配：${item}，该记录不可直接用于同比`),
      ...(reachedLimit ? ["结果达到本次查询上限，当前数据可能不完整，请缩小国家、商品编码或时间范围后重试"] : [])
    ],
    usage: usage("UN Comtrade 官方 API")
  };
}

function requestUrl(query: NormalizedTradeQuery, apiKey: string) {
  const frequencyCode = query.frequency === "annual" ? "A" : "M";
  const endpoint = apiKey
    ? `/data/v1/get/C/${frequencyCode}/HS`
    : `/public/v1/preview/C/${frequencyCode}/HS`;
  const url = new URL(endpoint, UN_COMTRADE_BASE_URL);
  url.searchParams.set("period", query.periods.join(","));
  url.searchParams.set("reporterCode", query.reporterCodes.join(","));
  url.searchParams.set("cmdCode", query.commodityCodes.join(","));
  url.searchParams.set("flowCode", query.flow === "import" ? "M" : "X");
  url.searchParams.set("partnerCode", query.partnerCodes.join(","));
  url.searchParams.set("partner2Code", "0");
  url.searchParams.set("customsCode", "C00");
  url.searchParams.set("motCode", "0");
  url.searchParams.set("maxRecords", String(query.limit));
  url.searchParams.set("includeDesc", "true");
  if (apiKey) url.searchParams.set("subscription-key", apiKey);
  return url.toString();
}

function validateUnComtradeQuery(query: NormalizedTradeQuery) {
  if ([...query.reporterCodes, ...query.partnerCodes].some((code) => !/^\d{1,3}$/.test(code))) {
    throw new ProviderContractError({
      code: "PROVIDER_POLICY_BLOCKED",
      retryable: false,
      retryAfterAt: null,
      publicMessage: "UN Comtrade 国家代码必须为 1 至 3 位数字",
      httpStatus: null,
      phase: "trade"
    });
  }
}

async function fetchTrade(
  query: NormalizedTradeQuery,
  apiKey: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>
) {
  validateUnComtradeQuery(query);
  const response = await fetcher(requestUrl(query, apiKey), {
    method: "GET",
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw providerHttpStatusError(response, "UN Comtrade");
  return parseResponse(await response.json(), query);
}

export const UN_COMTRADE_PROVIDER = defineTradeProvider({
  id: "un_comtrade",
  name: "UN Comtrade",
  adapterVersion: "1.1.0",
  tier: "free",
  category: "market_trade",
  requiresKey: false,
  capabilities: ["trade"],
  docsUrl: "https://comtradeapi.un.org/",
  keyHint: "无 Key 可使用官方 Preview；配置 UN Comtrade Key 后使用正式查询接口。",
  defaultBaseUrl: UN_COMTRADE_BASE_URL,
  costNote: "官方公开贸易统计接口；配额与单次返回上限以当前官方政策为准。",
  networkPolicy: {
    allowedHosts: [UN_COMTRADE_HOST],
    allowedPathPrefixes: ["/public/v1/preview/", "/data/v1/get/"],
    allowedMethods: ["GET"],
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async trade({ query }, cred, tools) {
    return await fetchTrade(query, cred.apiKey.trim(), tools.http.fetch);
  },
  async health(cred, tools) {
    const result = await fetchTrade({
      reporterCodes: ["842"],
      partnerCodes: ["0"],
      flow: "import",
      hsVersion: "HS",
      commodityCodes: ["940542"],
      periods: ["2023"],
      frequency: "annual",
      limit: 1
    }, cred.apiKey.trim(), tools.http.fetch);
    return {
      ok: true,
      message: result.observations.length
        ? "UN Comtrade 连接通过"
        : "UN Comtrade 连接通过，测试查询暂无记录",
      usage: result.usage
    };
  }
});
