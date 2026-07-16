import { z } from "zod";
import {
  ProviderContractError,
  defineTradeProvider,
  providerHttpStatusError,
  type NormalizedTradeQuery,
  type ProviderTradeAdapterPage,
  type ProviderUsage,
  type TradeObservationAdapter
} from "./provider-contract.js";

const EUROSTAT_HOST = "ec.europa.eu";
const EUROSTAT_BASE_URL = `https://${EUROSTAT_HOST}`;
const DATASET_CODE = "DS-045409";
const DATASET_PATH = `/eurostat/api/comext/dissemination/statistics/1.0/data/${DATASET_CODE}`;
const EXPECTED_DIMENSIONS = [
  "freq",
  "reporter",
  "partner",
  "product",
  "flow",
  "indicators",
  "time"
] as const;

const COUNTRY_CODES: Record<string, { code: string; label: string }> = {
  "0": { code: "WORLD", label: "World" },
  "32": { code: "AR", label: "Argentina" },
  "36": { code: "AU", label: "Australia" },
  "40": { code: "AT", label: "Austria" },
  "50": { code: "BD", label: "Bangladesh" },
  "56": { code: "BE", label: "Belgium" },
  "76": { code: "BR", label: "Brazil" },
  "100": { code: "BG", label: "Bulgaria" },
  "124": { code: "CA", label: "Canada" },
  "144": { code: "LK", label: "Sri Lanka" },
  "152": { code: "CL", label: "Chile" },
  "156": { code: "CN", label: "China" },
  "170": { code: "CO", label: "Colombia" },
  "191": { code: "HR", label: "Croatia" },
  "196": { code: "CY", label: "Cyprus" },
  "203": { code: "CZ", label: "Czechia" },
  "208": { code: "DK", label: "Denmark" },
  "233": { code: "EE", label: "Estonia" },
  "246": { code: "FI", label: "Finland" },
  "250": { code: "FR", label: "France" },
  "276": { code: "DE", label: "Germany" },
  "300": { code: "EL", label: "Greece" },
  "344": { code: "HK", label: "Hong Kong" },
  "348": { code: "HU", label: "Hungary" },
  "356": { code: "IN", label: "India" },
  "360": { code: "ID", label: "Indonesia" },
  "372": { code: "IE", label: "Ireland" },
  "376": { code: "IL", label: "Israel" },
  "380": { code: "IT", label: "Italy" },
  "392": { code: "JP", label: "Japan" },
  "410": { code: "KR", label: "South Korea" },
  "428": { code: "LV", label: "Latvia" },
  "440": { code: "LT", label: "Lithuania" },
  "442": { code: "LU", label: "Luxembourg" },
  "458": { code: "MY", label: "Malaysia" },
  "470": { code: "MT", label: "Malta" },
  "484": { code: "MX", label: "Mexico" },
  "490": { code: "TW", label: "Taiwan" },
  "504": { code: "MA", label: "Morocco" },
  "528": { code: "NL", label: "Netherlands" },
  "554": { code: "NZ", label: "New Zealand" },
  "578": { code: "NO", label: "Norway" },
  "586": { code: "PK", label: "Pakistan" },
  "604": { code: "PE", label: "Peru" },
  "608": { code: "PH", label: "Philippines" },
  "616": { code: "PL", label: "Poland" },
  "620": { code: "PT", label: "Portugal" },
  "642": { code: "RO", label: "Romania" },
  "643": { code: "RU", label: "Russia" },
  "682": { code: "SA", label: "Saudi Arabia" },
  "702": { code: "SG", label: "Singapore" },
  "703": { code: "SK", label: "Slovakia" },
  "704": { code: "VN", label: "Vietnam" },
  "705": { code: "SI", label: "Slovenia" },
  "710": { code: "ZA", label: "South Africa" },
  "724": { code: "ES", label: "Spain" },
  "752": { code: "SE", label: "Sweden" },
  "756": { code: "CH", label: "Switzerland" },
  "764": { code: "TH", label: "Thailand" },
  "784": { code: "AE", label: "United Arab Emirates" },
  "792": { code: "TR", label: "Turkey" },
  "804": { code: "UA", label: "Ukraine" },
  "818": { code: "EG", label: "Egypt" },
  "826": { code: "GB", label: "United Kingdom" },
  "842": { code: "US", label: "United States" }
};

const EU_REPORTER_CODES = new Set([
  "40", "56", "100", "191", "196", "203", "208", "233", "246",
  "250", "276", "300", "348", "372", "380", "428", "440", "442",
  "470", "528", "616", "620", "642", "703", "705", "724", "752"
]);

const categorySchema = z.object({
  index: z.union([
    z.record(z.number().int().nonnegative()),
    z.array(z.string().min(1).max(120))
  ]),
  label: z.record(z.string().max(500)).optional()
}).passthrough();

const responseSchema = z.object({
  id: z.array(z.string().min(1).max(80)).max(20),
  size: z.array(z.number().int().nonnegative()).max(20),
  value: z.union([
    z.array(z.number().finite().nullable()),
    z.record(z.union([z.number().finite(), z.null()]))
  ]),
  dimension: z.record(z.object({
    category: categorySchema
  }).passthrough()),
  updated: z.string().max(120).optional()
}).passthrough();

type EurostatResponse = z.infer<typeof responseSchema>;

function providerError(
  message: string,
  code: "PROVIDER_POLICY_BLOCKED" | "PROVIDER_SCHEMA_CHANGED"
) {
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
    currency: "EUR",
    estimated: false,
    display: "Eurostat Comext 官方统计 API"
  };
}

function canonicalNumericCode(value: string) {
  return String(Number(value));
}

function country(value: string) {
  return COUNTRY_CODES[canonicalNumericCode(value)] || null;
}

function monthNumber(period: string) {
  return Number(period.slice(0, 4)) * 12 + Number(period.slice(4, 6)) - 1;
}

function eurostatMonth(period: string) {
  return `${period.slice(0, 4)}-${period.slice(4, 6)}`;
}

function validateQuery(query: NormalizedTradeQuery, baseUrl: string) {
  if (baseUrl.trim()) {
    throw providerError("Eurostat Comext 使用固定官方地址，不允许自定义基础地址", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.frequency !== "monthly") {
    throw providerError("Eurostat Comext 当前仅支持月度查询", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.hsVersion !== "HS") {
    throw providerError("Eurostat Comext 当前仅支持官方现行 HS/CN 口径", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.reporterCodes.length !== 1
    || !EU_REPORTER_CODES.has(canonicalNumericCode(query.reporterCodes[0] || ""))
    || !country(query.reporterCodes[0] || "")) {
    throw providerError("Eurostat Comext 当前仅支持单个欧盟成员国报告代码", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.partnerCodes.length !== 1 || !country(query.partnerCodes[0] || "")) {
    throw providerError("Eurostat Comext 当前仅支持单个已映射的伙伴国代码", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.commodityCodes.length !== 1
    || !/^(?:\d{2}|\d{4}|\d{6})$/.test(query.commodityCodes[0] || "")) {
    throw providerError("Eurostat Comext 当前仅支持单个 2、4 或 6 位 HS 编码", "PROVIDER_POLICY_BLOCKED");
  }
  if (query.periods.length < 1 || query.periods.length > 36) {
    throw providerError("Eurostat Comext 查询月份必须为连续的 1 至 36 个月", "PROVIDER_POLICY_BLOCKED");
  }
  const sortedPeriods = [...query.periods].sort();
  if (sortedPeriods.some((period, index) =>
    !/^\d{6}$/.test(period)
    || !/^(?:0[1-9]|1[0-2])$/.test(period.slice(4))
    || (index > 0 && monthNumber(period) !== monthNumber(sortedPeriods[index - 1]!) + 1)
  )) {
    throw providerError("Eurostat Comext 查询月份必须使用 YYYYMM 且保持连续", "PROVIDER_POLICY_BLOCKED");
  }
}

function requestUrl(query: NormalizedTradeQuery) {
  const reporter = country(query.reporterCodes[0]!)!;
  const partner = country(query.partnerCodes[0]!)!;
  const periods = [...query.periods].sort();
  const url = new URL(DATASET_PATH, EUROSTAT_BASE_URL);
  url.searchParams.set("lang", "en");
  url.searchParams.set("freq", "M");
  url.searchParams.set("reporter", reporter.code);
  url.searchParams.set("partner", partner.code);
  url.searchParams.set("product", query.commodityCodes[0]!);
  url.searchParams.set("flow", query.flow === "import" ? "1" : "2");
  url.searchParams.set("sinceTimePeriod", eurostatMonth(periods[0]!));
  url.searchParams.set("untilTimePeriod", eurostatMonth(periods.at(-1)!));
  return url.toString();
}

function categoryIndexes(category: z.infer<typeof categorySchema>) {
  return Array.isArray(category.index)
    ? new Map(category.index.map((code, index) => [code, index]))
    : new Map(Object.entries(category.index));
}

function flattenedIndex(
  ids: string[],
  sizes: number[],
  coordinates: Record<string, number>
) {
  let result = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    const coordinate = coordinates[id];
    const size = sizes[index]!;
    if (coordinate === undefined || coordinate < 0 || coordinate >= size) return null;
    result = result * size + coordinate;
  }
  return result;
}

function valueAt(data: EurostatResponse, index: number | null) {
  if (index === null) return null;
  const raw = Array.isArray(data.value)
    ? data.value[index]
    : data.value[String(index)];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

function parseResponse(value: unknown, query: NormalizedTradeQuery): ProviderTradeAdapterPage {
  let data: EurostatResponse;
  try {
    data = responseSchema.parse(value);
  } catch (error) {
    throw new ProviderContractError({
      code: "PROVIDER_SCHEMA_CHANGED",
      retryable: false,
      retryAfterAt: null,
      publicMessage: "Eurostat Comext 返回结构发生变化，已暂停本次查询",
      httpStatus: null,
      phase: "trade"
    }, { cause: error });
  }
  if (data.id.length !== data.size.length
    || data.id.length !== EXPECTED_DIMENSIONS.length
    || EXPECTED_DIMENSIONS.some((dimension) => !data.id.includes(dimension))
    || EXPECTED_DIMENSIONS.some((dimension) => !data.dimension[dimension]?.category)) {
    throw providerError("Eurostat Comext 返回维度发生变化，已暂停本次查询", "PROVIDER_SCHEMA_CHANGED");
  }

  const indexes = Object.fromEntries(EXPECTED_DIMENSIONS.map((dimension) => [
    dimension,
    categoryIndexes(data.dimension[dimension]!.category)
  ])) as Record<typeof EXPECTED_DIMENSIONS[number], Map<string, number>>;
  const reporter = country(query.reporterCodes[0]!)!;
  const partner = country(query.partnerCodes[0]!)!;
  const product = query.commodityCodes[0]!;
  const flow = query.flow === "import" ? "1" : "2";
  const fixedCodes = {
    freq: "M",
    reporter: reporter.code,
    partner: partner.code,
    product,
    flow
  };
  const fixedCoordinates: Record<string, number> = {};
  for (const [dimension, code] of Object.entries(fixedCodes)) {
    const coordinate = indexes[dimension as keyof typeof indexes].get(code);
    if (coordinate === undefined) {
      return {
        observations: [],
        rawCount: 0,
        invalidCount: 0,
        exhausted: true,
        warnings: ["Eurostat Comext 本次查询暂无匹配维度或数据"],
        usage: usage()
      };
    }
    fixedCoordinates[dimension] = coordinate;
  }

  const indicatorCodes = [
    "VALUE_IN_EUROS",
    "QUANTITY_IN_100KG",
    "SUPPLEMENTARY_QUANTITY"
  ] as const;
  const requestedPeriods = new Set(query.periods);
  const returnedPeriods = new Set<string>();
  const timeEntries = [...indexes.time.entries()]
    .map(([period, coordinate]) => ({
      apiPeriod: period,
      period: period.replace("-", ""),
      coordinate
    }))
    .filter((item) => requestedPeriods.has(item.period))
    .sort((left, right) => left.period.localeCompare(right.period));
  const productLabel = data.dimension.product?.category.label?.[product] || "";
  const observations: TradeObservationAdapter[] = timeEntries.map((time) => {
    returnedPeriods.add(time.period);
    const indicatorValue = (indicator: typeof indicatorCodes[number]) => {
      const indicatorCoordinate = indexes.indicators.get(indicator);
      if (indicatorCoordinate === undefined) return null;
      return valueAt(data, flattenedIndex(data.id, data.size, {
        ...fixedCoordinates,
        indicators: indicatorCoordinate,
        time: time.coordinate
      }));
    };
    const valueEur = indicatorValue("VALUE_IN_EUROS");
    const quantity100Kg = indicatorValue("QUANTITY_IN_100KG");
    const supplementaryQuantity = indicatorValue("SUPPLEMENTARY_QUANTITY");
    const statusFlags = [
      "VALUE_CURRENCY:EUR",
      ...(valueEur === null
        ? ["VALUE_EUR_MISSING_OR_SUPPRESSED"]
        : [`VALUE_EUR:${valueEur}`, "TRADE_VALUE_USD_NOT_CONVERTED"]),
      ...(quantity100Kg === null ? ["NET_WEIGHT_MISSING"] : ["NET_WEIGHT_FROM_100KG"]),
      ...(supplementaryQuantity === null
        ? ["SUPPLEMENTARY_QUANTITY_MISSING"]
        : ["SUPPLEMENTARY_QUANTITY_REPORTED"])
    ];
    return {
      reporterCountry: data.dimension.reporter?.category.label?.[reporter.code] || reporter.label,
      partnerCountry: data.dimension.partner?.category.label?.[partner.code] || partner.label,
      reporterCode: canonicalNumericCode(query.reporterCodes[0]!),
      partnerCode: canonicalNumericCode(query.partnerCodes[0]!),
      tradeFlow: query.flow === "import" ? "IMPORT" : "EXPORT",
      classification: "EUROSTAT_COMEXT_CN",
      requestedClassification: "HS",
      commodityCode: product,
      commodityDescription: productLabel,
      period: time.period,
      tradeValueUsd: null,
      netWeightKg: quantity100Kg === null ? null : quantity100Kg * 100,
      quantity: supplementaryQuantity,
      quantityUnit: supplementaryQuantity === null ? null : "supplementary unit",
      isAggregate: product.length < 6,
      suppressed: valueEur === null && quantity100Kg === null && supplementaryQuantity === null,
      statusFlags,
      sourceRevision: data.updated || null,
      providerRecordId: [
        DATASET_CODE,
        reporter.code,
        partner.code,
        query.flow === "import" ? "IMPORT" : "EXPORT",
        product,
        time.period
      ].join(":")
    };
  });
  const unavailableMonths = [...requestedPeriods].sort()
    .filter((period) => !returnedPeriods.has(period));
  return {
    observations,
    rawCount: timeEntries.length,
    invalidCount: 0,
    exhausted: true,
    warnings: unavailableMonths.length
      ? [`unavailableMonths=${unavailableMonths.join(",")}`]
      : [],
    usage: usage()
  };
}

async function fetchTrade(
  query: NormalizedTradeQuery,
  baseUrl: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>
) {
  validateQuery(query, baseUrl);
  const response = await fetcher(requestUrl(query), {
    method: "GET",
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw providerHttpStatusError(response, "Eurostat Comext");
  return parseResponse(await response.json(), query);
}

export const EUROSTAT_COMEXT_PROVIDER = defineTradeProvider({
  id: "eurostat_comext",
  name: "Eurostat Comext",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "market_trade",
  requiresKey: false,
  capabilities: ["trade"],
  docsUrl: "https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started/comext-database",
  keyHint: "Eurostat 官方免费统计接口，无需 API Key。",
  defaultBaseUrl: EUROSTAT_BASE_URL,
  costNote: "欧盟月度货物贸易统计；欧元原值保留为证据，不伪装成美元。",
  networkPolicy: {
    allowedHosts: [EUROSTAT_HOST],
    allowedPathPrefixes: [],
    allowedPaths: [DATASET_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async trade({ query }, cred, tools) {
    return await fetchTrade(query, cred.baseUrl || "", tools.http.fetch);
  },
  async health(cred, tools) {
    const result = await fetchTrade({
      reporterCodes: ["276"],
      partnerCodes: ["156"],
      flow: "import",
      hsVersion: "HS",
      commodityCodes: ["9405"],
      periods: ["202401"],
      frequency: "monthly",
      limit: 10
    }, cred.baseUrl || "", tools.http.fetch);
    return {
      ok: true,
      message: result.observations.length
        ? "Eurostat Comext 连接通过"
        : "Eurostat Comext 连接通过，测试月份暂无可用记录",
      usage: result.usage
    };
  }
});
