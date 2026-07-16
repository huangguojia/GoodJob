import { z } from "zod";
import {
  defineProvider,
  providerHttpStatusError,
  type RawLead
} from "./provider-contract.js";
import {
  freeProcurementUsage,
  isExcludedProcurement,
  positiveCursor,
  procurementSchemaError,
  procurementSearchTerms,
  textLimit
} from "./procurement-provider-utils.js";

const TED_HOST = "api.ted.europa.eu";
const TED_BASE_URL = `https://${TED_HOST}`;
const TED_SEARCH_PATH = "/v3/notices/search";

const COUNTRY_CODES: Record<string, string> = {
  austria: "AUT", 奥地利: "AUT", belgium: "BEL", 比利时: "BEL",
  bulgaria: "BGR", 保加利亚: "BGR", croatia: "HRV", 克罗地亚: "HRV",
  cyprus: "CYP", 塞浦路斯: "CYP", czechia: "CZE", "czech republic": "CZE", 捷克: "CZE",
  denmark: "DNK", 丹麦: "DNK", estonia: "EST", 爱沙尼亚: "EST",
  finland: "FIN", 芬兰: "FIN", france: "FRA", 法国: "FRA",
  germany: "DEU", 德国: "DEU", greece: "GRC", 希腊: "GRC",
  hungary: "HUN", 匈牙利: "HUN", iceland: "ISL", 冰岛: "ISL",
  ireland: "IRL", 爱尔兰: "IRL", italy: "ITA", 意大利: "ITA",
  latvia: "LVA", 拉脱维亚: "LVA", lithuania: "LTU", 立陶宛: "LTU",
  luxembourg: "LUX", 卢森堡: "LUX", malta: "MLT", 马耳他: "MLT",
  netherlands: "NLD", 荷兰: "NLD", norway: "NOR", 挪威: "NOR",
  poland: "POL", 波兰: "POL", portugal: "PRT", 葡萄牙: "PRT",
  romania: "ROU", 罗马尼亚: "ROU", slovakia: "SVK", 斯洛伐克: "SVK",
  slovenia: "SVN", 斯洛文尼亚: "SVN", spain: "ESP", 西班牙: "ESP",
  sweden: "SWE", 瑞典: "SWE", switzerland: "CHE", 瑞士: "CHE"
};

const COUNTRY_NAMES = Object.fromEntries(
  Object.entries(COUNTRY_CODES)
    .filter(([name]) => /^[a-z]/.test(name))
    .map(([name, code]) => [
      code,
      name.replace(/\b\w/g, (character) => character.toUpperCase())
    ])
);

const localizedValueSchema = z.record(
  z.union([z.string(), z.array(z.string())])
);

const tedNoticeSchema = z.object({
  "publication-number": z.string().min(1),
  "notice-title": localizedValueSchema.optional(),
  "buyer-name": localizedValueSchema.optional(),
  "buyer-country": z.array(z.string()).optional(),
  "publication-date": z.string().optional(),
  deadline: z.union([z.string(), z.array(z.string())]).optional(),
  "classification-cpv": z.array(z.string()).optional(),
  "notice-type": z.string().optional(),
  links: z.object({
    html: z.record(z.string()).optional(),
    htmlDirect: z.record(z.string()).optional()
  }).passthrough().optional()
}).passthrough();

const tedResponseSchema = z.object({
  notices: z.array(tedNoticeSchema).default([]),
  totalNoticeCount: z.number().int().nonnegative().default(0),
  timedOut: z.boolean().optional()
}).passthrough();

function localizedText(
  value: z.infer<typeof localizedValueSchema> | undefined
) {
  if (!value) return "";
  const selected = value.eng ?? value.ENG ?? Object.values(value)[0];
  return Array.isArray(selected) ? selected[0] || "" : selected || "";
}

function sourceUrl(notice: z.infer<typeof tedNoticeSchema>) {
  const links = notice.links?.html || notice.links?.htmlDirect;
  if (links) return links.ENG || links.eng || Object.values(links)[0] || "";
  return `https://ted.europa.eu/en/notice/-/detail/${notice["publication-number"]}`;
}

function dateFloor() {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 2);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("");
}

function expertQuery(
  terms: string[],
  countryCode: string
) {
  const fullText = terms.length === 1
    ? `FT ~ ${terms[0]}`
    : `FT ~ (${terms.join(" ")})`;
  return [
    fullText,
    countryCode ? `CY = ${countryCode}` : "",
    `PD >= ${dateFloor()}`
  ].filter(Boolean).join(" AND ") + " SORT BY PD DESC";
}

function toLead(
  notice: z.infer<typeof tedNoticeSchema>,
  query: Parameters<typeof isExcludedProcurement>[1]
): RawLead | null {
  const title = textLimit(localizedText(notice["notice-title"]), 500);
  const buyer = textLimit(localizedText(notice["buyer-name"]), 200);
  if (!buyer || isExcludedProcurement(`${buyer} ${title}`, query)) return null;
  const countryCode = notice["buyer-country"]?.[0] || "";
  const deadline = Array.isArray(notice.deadline)
    ? notice.deadline[0] || ""
    : notice.deadline || "";
  const publicationDate = notice["publication-date"] || "";
  const cpv = (notice["classification-cpv"] || []).slice(0, 5).join(", ");
  const description = [
    title,
    publicationDate ? `发布日期 ${publicationDate.slice(0, 10)}` : "",
    deadline ? `截止日期 ${deadline.slice(0, 10)}` : "",
    cpv ? `CPV ${cpv}` : ""
  ].filter(Boolean).join("；");
  return {
    company: buyer,
    officialWebsite: "",
    country: COUNTRY_NAMES[countryCode] || countryCode,
    business: title || "欧盟公开采购需求",
    contact: "采购部门",
    contactInfo: "",
    description: textLimit(description, 2000),
    confidence: 84,
    providerRecordId: `TED:${notice["publication-number"]}`,
    sourceUrl: sourceUrl(notice),
    recordType: "business_signal",
    evidenceSummary: textLimit(`TED 官方采购公告：${description}`, 1000),
    matchedFields: ["company", "country", "business", "description"]
  };
}

export const EU_TED_PROVIDER = defineProvider({
  id: "eu_ted",
  name: "欧盟 TED 采购公告",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "procurement", "business_signal"],
  docsUrl: "https://docs.ted.europa.eu/api/latest/index.html",
  keyHint: "欧盟官方公开接口，无需 API Key。",
  defaultBaseUrl: TED_BASE_URL,
  costNote: "完全免费，按产品关键词查找欧盟最新公开采购公告和采购机构。",
  networkPolicy: {
    allowedHosts: [TED_HOST],
    allowedPathPrefixes: [TED_SEARCH_PATH],
    allowedMethods: ["POST"],
    maxResponseBytes: 6 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query, cursor }, _cred, tools) {
    const terms = procurementSearchTerms(query);
    if (!terms.length) {
      return {
        records: [],
        rawCount: 0,
        exhausted: true,
        warnings: ["TED 需要产品或行业关键词，本次未调用接口"],
        usage: { ...freeProcurementUsage("欧盟官方采购公告"), requestCount: 0 }
      };
    }
    const requestedCountries = query.countries.map((item) =>
      COUNTRY_CODES[item.toLocaleLowerCase()]
    ).filter(Boolean);
    if (query.countries.length && !requestedCountries.length) {
      return {
        records: [],
        rawCount: 0,
        exhausted: true,
        warnings: ["目标国家不在 TED 覆盖范围，本次已自动跳过"],
        usage: { ...freeProcurementUsage("欧盟官方采购公告"), requestCount: 0 }
      };
    }
    const page = Math.max(1, positiveCursor(cursor, 1, 100));
    const limit = Math.min(query.limit, 20);
    const response = await tools.http.fetch(`${TED_BASE_URL}${TED_SEARCH_PATH}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        query: expertQuery(terms, requestedCountries[0] || ""),
        fields: [
          "publication-number",
          "notice-title",
          "buyer-name",
          "buyer-country",
          "publication-date",
          "deadline",
          "classification-cpv",
          "notice-type"
        ],
        page,
        limit,
        scope: "ACTIVE",
        checkQuerySyntax: false,
        paginationMode: "PAGE_NUMBER"
      })
    });
    if (!response.ok) throw providerHttpStatusError(response, "EU TED");
    let data: z.infer<typeof tedResponseSchema>;
    try {
      data = tedResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("EU TED", error);
    }
    const records = data.notices
      .map((notice) => toLead(notice, query))
      .filter((record): record is RawLead => Boolean(record));
    const hasNext = page * limit < data.totalNoticeCount && page < 100;
    return {
      records,
      rawCount: data.notices.length,
      invalidCount: data.notices.length - records.length,
      nextCursor: hasNext ? String(page + 1) : null,
      exhausted: !hasNext,
      warnings: data.timedOut ? ["TED 本次查询达到服务端时限，结果可能不完整"] : [],
      usage: freeProcurementUsage(`TED 命中 ${data.totalNoticeCount} 条公开采购公告`)
    };
  },
  async health() {
    return { ok: true, message: "欧盟 TED 官方公开接口，内置可用，无需配置" };
  }
});
