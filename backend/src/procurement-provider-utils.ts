import {
  ProviderContractError,
  type NormalizedProviderQuery,
  type ProviderUsage
} from "./provider-contract.js";

const SEARCH_STOP_WORDS = new Set([
  "buyer", "buyers", "company", "companies", "customer", "customers",
  "find", "finding", "importer", "importers", "lead", "leads", "procurement",
  "purchase", "purchasing", "search", "target", "采购", "采购商", "公司",
  "客户", "获客", "进口商", "目标", "搜索", "寻找"
]);

const COUNTRY_ALIASES: Record<string, string> = {
  china: "China",
  中国: "China",
  germany: "Germany",
  德国: "Germany",
  france: "France",
  法国: "France",
  italy: "Italy",
  意大利: "Italy",
  spain: "Spain",
  西班牙: "Spain",
  portugal: "Portugal",
  葡萄牙: "Portugal",
  poland: "Poland",
  波兰: "Poland",
  netherlands: "Netherlands",
  荷兰: "Netherlands",
  belgium: "Belgium",
  比利时: "Belgium",
  sweden: "Sweden",
  瑞典: "Sweden",
  norway: "Norway",
  挪威: "Norway",
  denmark: "Denmark",
  丹麦: "Denmark",
  finland: "Finland",
  芬兰: "Finland",
  "united kingdom": "United Kingdom",
  uk: "United Kingdom",
  英国: "United Kingdom",
  "united states": "United States",
  usa: "United States",
  us: "United States",
  美国: "United States",
  india: "India",
  印度: "India",
  indonesia: "Indonesia",
  印度尼西亚: "Indonesia",
  vietnam: "Vietnam",
  越南: "Vietnam",
  thailand: "Thailand",
  泰国: "Thailand",
  malaysia: "Malaysia",
  马来西亚: "Malaysia",
  nigeria: "Nigeria",
  尼日利亚: "Nigeria",
  kenya: "Kenya",
  肯尼亚: "Kenya",
  egypt: "Egypt",
  埃及: "Egypt",
  brazil: "Brazil",
  巴西: "Brazil",
  mexico: "Mexico",
  墨西哥: "Mexico",
  turkey: "Turkey",
  土耳其: "Turkey",
  uae: "United Arab Emirates",
  阿联酋: "United Arab Emirates"
};

function normalizedWords(value: string) {
  return (value.match(/[\p{L}\p{N}]+/gu) || [])
    .map((item) => item.toLocaleLowerCase())
    .filter((item) => item.length >= 2 && !SEARCH_STOP_WORDS.has(item));
}

export function procurementSearchTerms(query: NormalizedProviderQuery) {
  const preferred = query.productKeywords.length
    ? query.productKeywords
    : query.industries.length
      ? query.industries
      : [query.goal];
  return [...new Set(preferred.flatMap(normalizedWords))].slice(0, 8);
}

export function firstCountryInEnglish(query: NormalizedProviderQuery) {
  const country = query.countries[0]?.trim() || "";
  return COUNTRY_ALIASES[country.toLocaleLowerCase()] || country;
}

export function isExcludedProcurement(
  value: string,
  query: NormalizedProviderQuery
) {
  const normalized = plainText(value).toLocaleLowerCase();
  return query.excludeKeywords.some((keyword) =>
    normalized.includes(plainText(keyword).toLocaleLowerCase())
  );
}

export function plainText(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&nbsp;|&#xa0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function textLimit(value: string, length: number) {
  return plainText(value).slice(0, length);
}

export function positiveCursor(value: string, fallback: number, maximum = 10_000) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : fallback;
}

export function freeProcurementUsage(display: string): Partial<ProviderUsage> {
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

export function procurementSchemaError(source: string, cause: unknown) {
  return new ProviderContractError({
    code: "PROVIDER_SCHEMA_CHANGED",
    retryable: false,
    retryAfterAt: null,
    publicMessage: `${source} 返回字段发生变化，已暂停本次查询`,
    httpStatus: null,
    phase: "search"
  }, { cause });
}
