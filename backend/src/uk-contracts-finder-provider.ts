import { z } from "zod";
import {
  defineProvider,
  providerHttpStatusError,
  type RawLead
} from "./provider-contract.js";
import {
  freeProcurementUsage,
  isExcludedProcurement,
  procurementSchemaError,
  procurementSearchTerms,
  textLimit
} from "./procurement-provider-utils.js";

const CONTRACTS_FINDER_HOST = "www.contractsfinder.service.gov.uk";
const CONTRACTS_FINDER_BASE_URL = `https://${CONTRACTS_FINDER_HOST}`;
const CONTRACTS_FINDER_PATH = "/api/rest/2/search_notices/json";

const UK_ALIASES = new Set([
  "uk", "united kingdom", "great britain", "england", "scotland",
  "wales", "northern ireland", "英国", "英格兰", "苏格兰", "威尔士", "北爱尔兰"
]);

const noticeItemSchema = z.object({
  id: z.string().min(1),
  noticeIdentifier: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  cpvDescription: z.string().optional(),
  publishedDate: z.string().optional(),
  deadlineDate: z.string().nullable().optional(),
  valueLow: z.number().nullable().optional(),
  valueHigh: z.number().nullable().optional(),
  noticeType: z.string().optional(),
  noticeStatus: z.string().optional(),
  organisationName: z.string().optional(),
  regionText: z.string().optional(),
  isSuitableForSme: z.boolean().optional()
}).passthrough();

const responseSchema = z.object({
  hitCount: z.number().int().nonnegative().default(0),
  noticeList: z.array(z.object({
    item: noticeItemSchema
  }).passthrough()).default([])
}).passthrough();

function targetsUnitedKingdom(countries: string[]) {
  return !countries.length || countries.some((country) =>
    UK_ALIASES.has(country.toLocaleLowerCase())
  );
}

function toLead(
  notice: z.infer<typeof noticeItemSchema>,
  query: Parameters<typeof isExcludedProcurement>[1]
): RawLead | null {
  const company = textLimit(notice.organisationName || "英国公共采购机构", 200);
  const title = textLimit(notice.title || notice.cpvDescription || "英国公开采购需求", 500);
  const detail = textLimit(notice.description || "", 1200);
  if (!company || isExcludedProcurement(`${company} ${title} ${detail}`, query)) {
    return null;
  }
  const description = [
    title,
    detail,
    notice.deadlineDate ? `截止：${notice.deadlineDate.slice(0, 10)}` : "",
    notice.regionText ? `地区：${notice.regionText}` : "",
    notice.isSuitableForSme ? "适合中小企业参与" : ""
  ].filter(Boolean).join("；");
  return {
    company,
    officialWebsite: "",
    country: "United Kingdom",
    business: title,
    contact: "采购部门",
    contactInfo: "",
    description: textLimit(description, 2000),
    confidence: 86,
    providerRecordId: `CF:${notice.noticeIdentifier || notice.id}`,
    sourceUrl: `${CONTRACTS_FINDER_BASE_URL}/Notice/${encodeURIComponent(notice.id)}`,
    recordType: "business_signal",
    evidenceSummary: textLimit(`英国 Contracts Finder 官方采购公告：${description}`, 1000),
    matchedFields: ["company", "country", "business", "description"]
  };
}

export const UK_CONTRACTS_FINDER_PROVIDER = defineProvider({
  id: "uk_contracts_finder",
  name: "英国 Contracts Finder",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "procurement", "business_signal"],
  docsUrl: "https://www.contractsfinder.service.gov.uk/apidocumentation/home",
  keyHint: "英国政府官方公开接口，无需 API Key。",
  defaultBaseUrl: CONTRACTS_FINDER_BASE_URL,
  costNote: "完全免费，查询英国仍开放的政府采购需求和采购机构。",
  networkPolicy: {
    allowedHosts: [CONTRACTS_FINDER_HOST],
    allowedPathPrefixes: [CONTRACTS_FINDER_PATH],
    allowedMethods: ["POST"],
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query }, _cred, tools) {
    if (!targetsUnitedKingdom(query.countries)) {
      return {
        records: [],
        rawCount: 0,
        exhausted: true,
        warnings: ["目标国家不是英国，本次已自动跳过 Contracts Finder"],
        usage: { ...freeProcurementUsage("英国政府公开采购公告"), requestCount: 0 }
      };
    }
    const terms = procurementSearchTerms(query);
    if (!terms.length) {
      return {
        records: [],
        rawCount: 0,
        exhausted: true,
        warnings: ["Contracts Finder 需要产品或行业关键词，本次未调用接口"],
        usage: { ...freeProcurementUsage("英国政府公开采购公告"), requestCount: 0 }
      };
    }
    const response = await tools.http.fetch(
      `${CONTRACTS_FINDER_BASE_URL}${CONTRACTS_FINDER_PATH}`,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          searchCriteria: {
            types: ["Contract"],
            statuses: ["Open"],
            keyword: terms.join(" "),
            queryString: null,
            regions: [],
            cpvCodes: [],
            publishedFrom: null,
            publishedTo: null,
            closingFrom: null,
            closingTo: null
          },
          size: Math.min(query.limit, 20)
        })
      }
    );
    if (!response.ok) throw providerHttpStatusError(response, "UK Contracts Finder");
    let data: z.infer<typeof responseSchema>;
    try {
      data = responseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("英国 Contracts Finder", error);
    }
    const records = data.noticeList
      .map(({ item }) => toLead(item, query))
      .filter((record): record is RawLead => Boolean(record));
    return {
      records,
      rawCount: data.noticeList.length,
      invalidCount: data.noticeList.length - records.length,
      exhausted: true,
      warnings: [],
      usage: freeProcurementUsage(`Contracts Finder 返回 ${data.hitCount} 条开放采购公告`)
    };
  },
  async health() {
    return { ok: true, message: "英国 Contracts Finder 官方公开接口，内置可用，无需配置" };
  }
});
