import { z } from "zod";
import {
  defineProvider,
  providerHttpStatusError,
  type RawLead
} from "./provider-contract.js";
import {
  firstCountryInEnglish,
  freeProcurementUsage,
  isExcludedProcurement,
  positiveCursor,
  procurementSchemaError,
  procurementSearchTerms,
  textLimit
} from "./procurement-provider-utils.js";

const WORLD_BANK_HOST = "search.worldbank.org";
const WORLD_BANK_BASE_URL = `https://${WORLD_BANK_HOST}`;
const WORLD_BANK_PATH = "/api/v2/procnotices";

const noticeSchema = z.object({
  id: z.string().min(1),
  notice_type: z.string().optional(),
  noticedate: z.string().optional(),
  notice_status: z.string().optional(),
  submission_deadline_date: z.string().optional(),
  project_ctry_name: z.string().optional(),
  project_id: z.string().optional(),
  project_name: z.string().optional(),
  bid_reference_no: z.string().optional(),
  bid_description: z.string().optional(),
  procurement_method_name: z.string().optional(),
  contact_address: z.string().optional(),
  contact_ctry_name: z.string().optional(),
  contact_email: z.string().optional(),
  contact_name: z.string().optional(),
  contact_organization: z.string().optional(),
  contact_phone_no: z.string().optional()
}).passthrough();

const responseSchema = z.object({
  total: z.union([z.string(), z.number()]).default(0),
  procnotices: z.array(noticeSchema).default([])
}).passthrough();

function toLead(
  notice: z.infer<typeof noticeSchema>,
  query: Parameters<typeof isExcludedProcurement>[1]
): RawLead | null {
  const business = textLimit(
    notice.bid_description || notice.project_name || "世界银行公开采购需求",
    500
  );
  const company = textLimit(
    notice.contact_organization || notice.project_name || "世界银行项目采购机构",
    200
  );
  if (!company || isExcludedProcurement(`${company} ${business}`, query)) return null;
  const deadline = notice.submission_deadline_date?.slice(0, 10) || "";
  const description = [
    notice.project_name ? `项目：${notice.project_name}` : "",
    business,
    notice.procurement_method_name ? `方式：${notice.procurement_method_name}` : "",
    notice.bid_reference_no ? `编号：${notice.bid_reference_no}` : "",
    deadline ? `截止：${deadline}` : ""
  ].filter(Boolean).join("；");
  const contactInfo = textLimit(
    notice.contact_email || notice.contact_phone_no || "",
    255
  );
  return {
    company,
    officialWebsite: "",
    country: textLimit(
      notice.contact_ctry_name || notice.project_ctry_name || "",
      100
    ),
    business,
    contact: textLimit(notice.contact_name || "采购部门", 160),
    contactInfo,
    description: textLimit(description, 2000),
    confidence: contactInfo ? 90 : 84,
    providerRecordId: `WB:${notice.id}`,
    sourceUrl: `https://projects.worldbank.org/en/projects-operations/procurement-detail/${encodeURIComponent(notice.id)}`,
    recordType: "business_signal",
    evidenceSummary: textLimit(`世界银行官方采购公告：${description}`, 1000),
    matchedFields: [
      "company",
      "country",
      "business",
      "description",
      ...(notice.contact_name ? ["contact"] : []),
      ...(contactInfo ? ["contactInfo"] : [])
    ]
  };
}

export const WORLD_BANK_PROCUREMENT_PROVIDER = defineProvider({
  id: "world_bank_procurement",
  name: "世界银行采购公告",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "procurement", "contact", "business_signal"],
  docsUrl: "https://search.worldbank.org/api/v2/procnotices",
  keyHint: "世界银行公开搜索接口，无需 API Key。",
  defaultBaseUrl: WORLD_BANK_BASE_URL,
  costNote: "完全免费，覆盖全球项目采购需求，部分公告含采购联系人和公开邮箱。",
  networkPolicy: {
    allowedHosts: [WORLD_BANK_HOST],
    allowedPathPrefixes: [WORLD_BANK_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 8 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query, cursor }, _cred, tools) {
    const terms = procurementSearchTerms(query);
    if (!terms.length) {
      return {
        records: [],
        rawCount: 0,
        exhausted: true,
        warnings: ["世界银行采购公告需要产品或行业关键词，本次未调用接口"],
        usage: { ...freeProcurementUsage("世界银行公开采购公告"), requestCount: 0 }
      };
    }
    const limit = Math.min(query.limit, 10);
    const offset = positiveCursor(cursor, 0, 10_000);
    const country = firstCountryInEnglish(query);
    const qterm = [...terms, country].filter(Boolean).join(" ");
    const url = new URL(`${WORLD_BANK_BASE_URL}${WORLD_BANK_PATH}`);
    url.searchParams.set("format", "json");
    url.searchParams.set("rows", String(limit));
    url.searchParams.set("os", String(offset));
    url.searchParams.set("qterm", qterm);
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "World Bank Procurement");
    let data: z.infer<typeof responseSchema>;
    try {
      data = responseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("世界银行采购公告", error);
    }
    const records = data.procnotices
      .map((notice) => toLead(notice, query))
      .filter((record): record is RawLead => Boolean(record));
    const total = Number(data.total) || 0;
    const nextOffset = offset + data.procnotices.length;
    const hasNext = data.procnotices.length === limit
      && nextOffset < total
      && nextOffset < 10_000;
    return {
      records,
      rawCount: data.procnotices.length,
      invalidCount: data.procnotices.length - records.length,
      nextCursor: hasNext ? String(nextOffset) : null,
      exhausted: !hasNext,
      warnings: [],
      usage: freeProcurementUsage(`世界银行命中 ${total} 条公开采购公告`)
    };
  },
  async health() {
    return { ok: true, message: "世界银行采购公告公开接口，内置可用，无需配置" };
  }
});
