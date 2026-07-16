import { z } from "zod";
import {
  ProviderContractError,
  defineProvider,
  providerHttpStatusError,
  type NormalizedProviderQuery,
  type ProviderAdapterPage,
  type ProviderUsage,
  type RawLead
} from "./provider-contract.js";

const SEC_HOST = "www.sec.gov";
const SEC_BASE_URL = `https://${SEC_HOST}`;
const SEC_TICKERS_PATH = "/files/company_tickers.json";
const SEC_BROWSE_URL = `${SEC_BASE_URL}/edgar/browse/`;

const tickerRecordSchema = z.object({
  cik_str: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d{1,10}$/)
  ]),
  ticker: z.string().min(1).max(30),
  title: z.string().min(1).max(300)
}).strict();

const responseSchema = z.record(tickerRecordSchema);

const QUERY_STOP_WORDS = new Set([
  "buyer", "buyers", "company", "companies", "customer", "customers",
  "distributor", "distributors", "find", "importer", "importers",
  "manufacturer", "manufacturers", "product", "products", "search",
  "supplier", "suppliers", "target", "采购商", "公司", "客户", "经销商",
  "进口商", "目标", "产品", "搜索", "寻找", "制造商", "供应商"
]);

function providerError(
  message: string,
  code: "PROVIDER_CONNECTION_INVALID" | "PROVIDER_POLICY_BLOCKED" | "PROVIDER_SCHEMA_CHANGED",
  phase: "search" | "health" = "search"
) {
  return new ProviderContractError({
    code,
    retryable: false,
    retryAfterAt: null,
    publicMessage: message,
    httpStatus: null,
    phase
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
    display: "SEC EDGAR 官方公开公司目录"
  };
}

function validateConnection(userAgent: string, baseUrl: string, phase: "search" | "health") {
  if (baseUrl.trim()) {
    throw providerError("SEC EDGAR 使用固定官方地址，不允许自定义基础地址", "PROVIDER_POLICY_BLOCKED", phase);
  }
  const normalized = userAgent.trim();
  if (normalized.length < 8 || normalized.length > 200
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.split(/\s+/).at(-1) || "")) {
    throw providerError(
      "SEC Fair Access 要求填写可识别的 User-Agent，例如 GoodJobCRM admin@example.com",
      "PROVIDER_CONNECTION_INVALID",
      phase
    );
  }
  return normalized;
}

function normalizeText(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function queryTerms(query: NormalizedProviderQuery) {
  const values = [
    ...query.productKeywords,
    ...query.industries,
    ...query.customerTypes,
    query.goal
  ];
  return [...new Set(values
    .flatMap((value) => normalizeText(value).split(/\s+/))
    .filter((value) => value.length >= 2 && !QUERY_STOP_WORDS.has(value))
  )].slice(0, 40);
}

function excluded(title: string, query: NormalizedProviderQuery) {
  const normalized = normalizeText(title);
  return query.excludeKeywords.some((keyword) => normalized.includes(normalizeText(keyword)));
}

function matchScore(title: string, ticker: string, terms: string[]) {
  const normalizedTitle = normalizeText(title);
  const normalizedTicker = normalizeText(ticker);
  if (terms.includes(normalizedTicker)) return 100;
  if (terms.includes(normalizedTitle)) return 98;
  if (terms.some((term) => normalizedTitle.startsWith(term))) return 92;
  const matches = terms.filter((term) =>
    normalizedTitle.includes(term) || normalizedTicker.includes(term)
  ).length;
  if (!matches) return 0;
  return Math.min(90, 70 + matches * 5);
}

function parseResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value as Record<string, unknown>).length > 25_000) {
    throw providerError("SEC EDGAR 返回结构发生变化，已暂停本次查询", "PROVIDER_SCHEMA_CHANGED");
  }
  try {
    return Object.values(responseSchema.parse(value));
  } catch (error) {
    throw new ProviderContractError({
      code: "PROVIDER_SCHEMA_CHANGED",
      retryable: false,
      retryAfterAt: null,
      publicMessage: "SEC EDGAR 返回字段发生变化，已暂停本次查询",
      httpStatus: null,
      phase: "search"
    }, { cause: error });
  }
}

function toLead(
  record: z.infer<typeof tickerRecordSchema>,
  confidence: number
): RawLead {
  const cik = String(record.cik_str).padStart(10, "0");
  const ticker = record.ticker.trim().toUpperCase();
  const title = record.title.trim().slice(0, 200);
  const sourceUrl = `${SEC_BROWSE_URL}?CIK=${encodeURIComponent(cik)}&owner=exclude`;
  return {
    company: title,
    officialWebsite: "",
    country: "",
    business: "SEC 申报企业，具体业务待核实",
    contact: "待维护",
    contactInfo: "",
    description: `SEC CIK ${cik}；Ticker ${ticker}`,
    confidence,
    providerRecordId: `CIK:${cik}`,
    sourceUrl,
    recordType: "identity_evidence",
    evidenceSummary: `${title} 已出现在 SEC 官方公司目录，CIK ${cik}，Ticker ${ticker}。`,
    matchedFields: ["company", "description"]
  };
}

async function fetchTickers(
  userAgent: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>
) {
  const response = await fetcher(`${SEC_BASE_URL}${SEC_TICKERS_PATH}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": userAgent
    }
  });
  if (!response.ok) throw providerHttpStatusError(response, "SEC EDGAR");
  return parseResponse(await response.json());
}

export const SEC_EDGAR_PROVIDER = defineProvider({
  id: "sec_edgar",
  name: "SEC EDGAR",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: true,
  capabilities: ["company", "identity"],
  docsUrl: "https://www.sec.gov/search-filings/edgar-application-programming-interfaces",
  keyHint: "这里不是填写 API Key。请按 SEC Fair Access 要求填写“系统名 联系邮箱”，例如 GoodJobCRM admin@example.com。",
  defaultBaseUrl: SEC_BASE_URL,
  costNote: "免费官方接口；用于核验美国上市及 SEC 申报企业，不提供联系人。",
  networkPolicy: {
    allowedHosts: [SEC_HOST],
    allowedPathPrefixes: [],
    allowedPaths: [SEC_TICKERS_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 12 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query }, cred, tools): Promise<ProviderAdapterPage> {
    const userAgent = validateConnection(cred.apiKey, cred.baseUrl || "", "search");
    const terms = queryTerms(query);
    if (!terms.length) {
      return {
        records: [],
        rawCount: 0,
        invalidCount: 0,
        exhausted: true,
        warnings: ["SEC EDGAR 需要公司名称或股票代码关键词，本次未调用接口"],
        usage: { ...usage(), requestCount: 0 }
      };
    }
    const entries = await fetchTickers(userAgent, tools.http.fetch);
    const records = entries
      .map((entry) => ({ entry, score: matchScore(entry.title, entry.ticker, terms) }))
      .filter(({ entry, score }) => score > 0 && !excluded(entry.title, query))
      .sort((left, right) =>
        right.score - left.score || left.entry.title.localeCompare(right.entry.title)
      )
      .slice(0, query.limit)
      .map(({ entry, score }) => toLead(entry, score));
    return {
      records,
      rawCount: entries.length,
      invalidCount: 0,
      exhausted: true,
      warnings: [],
      usage: usage()
    };
  },
  async health(cred, tools) {
    const userAgent = validateConnection(cred.apiKey, cred.baseUrl || "", "health");
    const entries = await fetchTickers(userAgent, tools.http.fetch);
    return {
      ok: true,
      message: entries.length
        ? "SEC EDGAR 连接通过，User-Agent 已生效"
        : "SEC EDGAR 连接通过，官方目录当前为空",
      usage: usage()
    };
  }
});
