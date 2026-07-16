import {
  ProviderContractError,
  defineTradeProvider,
  providerHttpStatusError,
  type NormalizedTradeQuery,
  type ProviderTradeAdapterPage,
  type ProviderUsage,
  type TradeObservationAdapter
} from "./provider-contract.js";

const CENSUS_HOST = "api.census.gov";
const CENSUS_BASE_URL = `https://${CENSUS_HOST}`;
const IMPORT_PATH = "/data/timeseries/intltrade/imports/hs";
const EXPORT_PATH = "/data/timeseries/intltrade/exports/hs";
const FIELD_MAPPING_VERSION = "census_intltrade_hs_v1";

function providerError(message: string, code: "PROVIDER_POLICY_BLOCKED" | "PROVIDER_CONNECTION_INVALID" | "PROVIDER_SCHEMA_CHANGED") {
  return new ProviderContractError({
    code,
    retryable: false,
    retryAfterAt: null,
    publicMessage: message,
    httpStatus: null,
    phase: "trade"
  });
}

function usage(): Partial<ProviderUsage> {
  return {
    requestCount: 1,
    quotaUsed: null,
    quotaRemaining: null,
    costAmount: 0,
    currency: "USD",
    estimated: false,
    display: "美国 Census International Trade 官方 API"
  };
}

function monthNumber(period: string) {
  return Number(period.slice(0, 4)) * 12 + Number(period.slice(4, 6)) - 1;
}

function censusMonth(period: string) {
  return `${period.slice(0, 4)}-${period.slice(4, 6)}`;
}

function validateQuery(query: NormalizedTradeQuery, credentialBaseUrl: string) {
  if (credentialBaseUrl.trim()) {
    throw providerError("美国 Census 数据源使用固定官方地址，不允许自定义基础地址", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.reporterCodes.length !== 1 || query.reporterCodes[0] !== "842") {
    throw providerError("美国 Census Trade 当前仅支持 reporterCodes=[\"842\"]", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.partnerCodes.length !== 1 || !/^\d{4}$/.test(query.partnerCodes[0] || "")) {
    throw providerError("美国 Census Trade 当前仅支持单个 4 位 CTY_CODE", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.hsVersion !== "HS") {
    throw providerError("美国 Census Trade 当前仅支持官方现行 HS 分类", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.frequency !== "monthly") {
    throw providerError("美国 Census Trade 当前仅支持月度查询", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.commodityCodes.length !== 1 || !/^(?:\d{2}|\d{4}|\d{6})$/.test(query.commodityCodes[0] || "")) {
    throw providerError("美国 Census Trade 当前仅支持单个 2、4 或 6 位 HS 编码", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.periods.length < 1 || query.periods.length > 36) {
    throw providerError("美国 Census Trade 查询月份必须为连续的 1 至 36 个月", "PROVIDER_POLICY_BLOCKED");
  }
  const sortedPeriods = [...query.periods].sort();
  if (sortedPeriods.some((period, index) =>
    !/^\d{6}$/.test(period)
    || !/^(?:0[1-9]|1[0-2])$/.test(period.slice(4))
    || (index > 0 && monthNumber(period) !== monthNumber(sortedPeriods[index - 1]!) + 1)
  )) {
    throw providerError("美国 Census Trade 查询月份必须使用 YYYYMM 且保持连续", "PROVIDER_POLICY_BLOCKED");
  }
}

function requestDefinition(query: NormalizedTradeQuery) {
  return query.flow === "import"
    ? {
        path: IMPORT_PATH,
        valueField: "GEN_VAL_MO",
        commodityField: "I_COMMODITY",
        descriptionField: "I_COMMODITY_LDESC"
      }
    : {
        path: EXPORT_PATH,
        valueField: "ALL_VAL_MO",
        commodityField: "E_COMMODITY",
        descriptionField: "E_COMMODITY_LDESC"
      };
}

function requestUrl(query: NormalizedTradeQuery, apiKey: string) {
  const definition = requestDefinition(query);
  const sortedPeriods = [...query.periods].sort();
  const fields = [
    definition.valueField,
    definition.commodityField,
    definition.descriptionField,
    "COMM_LVL",
    "CTY_CODE",
    "CTY_NAME",
    "YEAR",
    "MONTH",
    "LAST_UPDATE"
  ];
  const url = new URL(definition.path, CENSUS_BASE_URL);
  url.searchParams.set("get", fields.join(","));
  url.searchParams.set(
    "time",
    `from ${censusMonth(sortedPeriods[0]!)} to ${censusMonth(sortedPeriods.at(-1)!)}`
  );
  url.searchParams.set(definition.commodityField, query.commodityCodes[0]!);
  url.searchParams.set("CTY_CODE", query.partnerCodes[0]!);
  url.searchParams.set("key", apiKey);
  return url.toString();
}

function stringCell(row: unknown[], index: number) {
  const value = row[index];
  return value === null || value === undefined ? "" : String(value).trim();
}

function parseResponse(value: unknown, query: NormalizedTradeQuery): ProviderTradeAdapterPage {
  if (!Array.isArray(value)) {
    throw providerError("美国 Census 返回结构发生变化，已暂停本次查询", "PROVIDER_SCHEMA_CHANGED");
  }
  if (!value.length) {
    return {
      observations: [],
      rawCount: 0,
      invalidCount: 0,
      exhausted: true,
      warnings: [`unavailableMonths=${[...query.periods].sort().join(",")}`],
      usage: usage()
    };
  }
  const header = value[0];
  if (!Array.isArray(header) || header.some((item) => typeof item !== "string")) {
    throw providerError("美国 Census 返回表头结构发生变化，已暂停本次查询", "PROVIDER_SCHEMA_CHANGED");
  }
  const definition = requestDefinition(query);
  const requiredFields = [
    definition.valueField,
    definition.commodityField,
    definition.descriptionField,
    "COMM_LVL",
    "CTY_CODE",
    "CTY_NAME",
    "YEAR",
    "MONTH",
    "LAST_UPDATE"
  ];
  const indexes = new Map(header.map((field, index) => [String(field), index]));
  if (requiredFields.some((field) => !indexes.has(field))) {
    throw providerError("美国 Census 返回字段发生变化，已暂停本次查询", "PROVIDER_SCHEMA_CHANGED");
  }

  const observations: TradeObservationAdapter[] = [];
  let invalidCount = 0;
  const returnedPeriods = new Set<string>();
  const requestedPeriods = new Set(query.periods);
  const requestedPartnerCode = query.partnerCodes[0]!;
  const requestedCommodityCode = query.commodityCodes[0]!;
  for (const rawRow of value.slice(1)) {
    if (!Array.isArray(rawRow)) {
      invalidCount += 1;
      continue;
    }
    const cell = (field: string) => stringCell(rawRow, indexes.get(field)!);
    const amountText = cell(definition.valueField);
    const amount = amountText === "" ? Number.NaN : Number(amountText);
    const year = cell("YEAR");
    const month = cell("MONTH").padStart(2, "0");
    const period = `${year}${month}`;
    const partnerCode = cell("CTY_CODE");
    const commodityCode = cell(definition.commodityField);
    if (!Number.isFinite(amount)
      || amount < 0
      || !/^\d{6}$/.test(period)
      || !/^\d{4}$/.test(partnerCode)
      || !/^(?:\d{2}|\d{4}|\d{6})$/.test(commodityCode)
      || !requestedPeriods.has(period)
      || partnerCode !== requestedPartnerCode
      || commodityCode !== requestedCommodityCode) {
      invalidCount += 1;
      continue;
    }
    returnedPeriods.add(period);
    const hsLevel = cell("COMM_LVL") || String(commodityCode.length);
    const statusFlags = [
      "REPORTER_CODE:842",
      `PARTNER_CODE:${partnerCode}`,
      `COMMODITY_CODE:${commodityCode}`,
      `HS_LEVEL:${hsLevel}`,
      `VALUE_BASIS:${definition.valueField}`,
      `FIELD_MAPPING:${FIELD_MAPPING_VERSION}`
    ];
    if (amount === 0) statusFlags.push("VALUE_ZERO_REPORTED");
    observations.push({
      reporterCountry: "USA",
      partnerCountry: cell("CTY_NAME") || partnerCode,
      reporterCode: "842",
      partnerCode,
      tradeFlow: query.flow === "import" ? "IMPORT" : "EXPORT",
      classification: "CENSUS_HS_CURRENT",
      requestedClassification: "HS",
      commodityCode,
      commodityDescription: cell(definition.descriptionField),
      period,
      tradeValueUsd: amount,
      netWeightKg: null,
      quantity: null,
      quantityUnit: null,
      isAggregate: true,
      suppressed: false,
      statusFlags,
      sourceRevision: cell("LAST_UPDATE") || null,
      providerRecordId: [
        "842",
        partnerCode,
        query.flow === "import" ? "IMPORT" : "EXPORT",
        commodityCode,
        period
      ].join(":")
    });
  }
  const unavailableMonths = [...query.periods].sort().filter((period) => !returnedPeriods.has(period));
  const warnings = [
    ...(invalidCount ? [`${invalidCount} 条 Census 记录因关键字段缺失、格式无效或超出查询范围未写入`] : []),
    ...(unavailableMonths.length ? [`unavailableMonths=${unavailableMonths.join(",")}`] : [])
  ];
  return {
    observations,
    rawCount: Math.max(0, value.length - 1),
    invalidCount,
    exhausted: true,
    warnings,
    usage: usage()
  };
}

async function fetchTrade(
  query: NormalizedTradeQuery,
  apiKey: string,
  baseUrl: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>
) {
  validateQuery(query, baseUrl);
  if (!apiKey.trim()) {
    throw providerError("美国 Census 数据源连接缺少有效 API Key", "PROVIDER_CONNECTION_INVALID");
  }
  const response = await fetcher(requestUrl(query, apiKey.trim()), {
    method: "GET",
    headers: { accept: "application/json" }
  });
  if (response.status === 204) {
    return parseResponse([], query);
  }
  if (!response.ok) throw providerHttpStatusError(response, "美国 Census");
  return parseResponse(await response.json(), query);
}

export const US_CENSUS_TRADE_PROVIDER = defineTradeProvider({
  id: "us_census_trade",
  name: "美国 Census International Trade",
  tier: "free",
  category: "market_trade",
  requiresKey: true,
  capabilities: ["trade"],
  docsUrl: "https://www.census.gov/data/developers/data-sets/international-trade.html",
  keyHint: "需要个人 Census API Key；密钥仅保存在当前账号的加密 Provider Connection 中。",
  defaultBaseUrl: CENSUS_BASE_URL,
  costNote: "美国 Census 官方月度国际贸易统计 API。",
  networkPolicy: {
    allowedHosts: [CENSUS_HOST],
    allowedPathPrefixes: [],
    allowedPaths: [IMPORT_PATH, EXPORT_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async trade({ query }, cred, tools) {
    return await fetchTrade(query, cred.apiKey, cred.baseUrl || "", tools.http.fetch);
  },
  async health(cred, tools) {
    const result = await fetchTrade({
      reporterCodes: ["842"],
      partnerCodes: ["1220"],
      flow: "import",
      hsVersion: "HS",
      commodityCodes: ["9405"],
      periods: ["202401"],
      frequency: "monthly",
      limit: 10
    }, cred.apiKey, cred.baseUrl || "", tools.http.fetch);
    return {
      ok: true,
      message: result.observations.length
        ? "美国 Census Trade 连接通过"
        : "美国 Census Trade 连接通过，测试月份暂无可用记录",
      usage: result.usage
    };
  }
});
