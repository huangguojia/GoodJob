import { z } from "zod";
import {
  defineProvider,
  providerHttpStatusError,
  type LeadProvider,
  type ProviderAdapterPage,
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

const US_ALIASES = new Set(["us", "usa", "united states", "united states of america", "美国"]);
const UK_ALIASES = new Set(["uk", "united kingdom", "great britain", "england", "scotland", "wales", "英国", "英格兰", "苏格兰", "威尔士"]);
const BRAZIL_ALIASES = new Set(["brazil", "brasil", "巴西"]);
const MEXICO_ALIASES = new Set(["mexico", "méxico", "墨西哥"]);
const SINGAPORE_ALIASES = new Set(["singapore", "sg", "新加坡"]);

function targetsCountry(countries: string[], aliases: Set<string>) {
  return !countries.length || countries.some((country) =>
    aliases.has(country.toLocaleLowerCase())
  );
}

function skippedPage(message: string, label: string): ProviderAdapterPage {
  return {
    records: [],
    rawCount: 0,
    exhausted: true,
    warnings: [message],
    usage: { ...freeProcurementUsage(label), requestCount: 0 }
  };
}

function dateText(date: Date, format: "iso" | "us" | "compact") {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  if (format === "us") return `${month}/${day}/${year}`;
  if (format === "compact") return `${year}${month}${day}`;
  return `${year}-${month}-${day}`;
}

function recentDate(months: number) {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
}

const USASPENDING_HOST = "api.usaspending.gov";
const USASPENDING_BASE_URL = `https://${USASPENDING_HOST}`;
const USASPENDING_PATH = "/api/v2/search/spending_by_award/";

const usaAwardSchema = z.object({
  internal_id: z.union([z.string(), z.number()]).optional(),
  "Award ID": z.string().min(1),
  "Recipient Name": z.string().min(1),
  "Award Amount": z.number().nullable().optional(),
  Description: z.string().nullable().optional(),
  "Start Date": z.string().nullable().optional(),
  "End Date": z.string().nullable().optional(),
  "Awarding Agency": z.string().nullable().optional(),
  generated_internal_id: z.string().optional()
}).passthrough();

const usaSpendingResponseSchema = z.object({
  page_metadata: z.object({
    page: z.number().int().positive(),
    hasNext: z.boolean()
  }).passthrough(),
  results: z.array(usaAwardSchema).default([])
}).passthrough();

export const USASPENDING_AWARDS_PROVIDER = defineProvider({
  id: "usaspending_awards",
  name: "USAspending 联邦采购",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "procurement", "business_signal"],
  docsUrl: "https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/api_contracts/contracts/v2/search/spending_by_award.md",
  keyHint: "美国财政部 USAspending 官方接口，无需 API Key。",
  defaultBaseUrl: USASPENDING_BASE_URL,
  costNote: "完全免费，按产品关键词发现已获得美国联邦合同的供应商和采购描述。",
  networkPolicy: {
    allowedHosts: [USASPENDING_HOST],
    allowedPathPrefixes: [USASPENDING_PATH],
    allowedMethods: ["POST"],
    maxResponseBytes: 6 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query, cursor }, _cred, tools) {
    if (!targetsCountry(query.countries, US_ALIASES)) {
      return skippedPage("目标国家不是美国，本次已自动跳过 USAspending", "USAspending 联邦采购");
    }
    const terms = procurementSearchTerms(query);
    if (!terms.length) return skippedPage("USAspending 需要产品或行业关键词", "USAspending 联邦采购");
    const page = Math.max(1, positiveCursor(cursor, 1, 100));
    const limit = Math.min(query.limit, 20);
    const response = await tools.http.fetch(`${USASPENDING_BASE_URL}${USASPENDING_PATH}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        filters: {
          time_period: [{
            start_date: dateText(recentDate(24), "iso"),
            end_date: dateText(new Date(), "iso")
          }],
          award_type_codes: ["A", "B", "C", "D"],
          keywords: terms
        },
        fields: [
          "Award ID",
          "Recipient Name",
          "Award Amount",
          "Description",
          "Start Date",
          "End Date",
          "Awarding Agency"
        ],
        page,
        limit,
        subawards: false
      })
    });
    if (!response.ok) throw providerHttpStatusError(response, "USAspending");
    let data: z.infer<typeof usaSpendingResponseSchema>;
    try {
      data = usaSpendingResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("USAspending", error);
    }
    const records = data.results
      .filter((item) => !isExcludedProcurement(`${item["Recipient Name"]} ${item.Description || ""}`, query))
      .map<RawLead>((item) => {
        const amount = typeof item["Award Amount"] === "number"
          ? item["Award Amount"].toLocaleString("en-US", { style: "currency", currency: "USD" })
          : "";
        const description = [
          item.Description || "",
          item["Awarding Agency"] ? `采购机构：${item["Awarding Agency"]}` : "",
          amount ? `合同金额：${amount}` : "",
          item["Start Date"] ? `开始：${item["Start Date"]}` : "",
          item["End Date"] ? `结束：${item["End Date"]}` : ""
        ].filter(Boolean).join("；");
        const awardRef = item.generated_internal_id || item["Award ID"];
        return {
          company: textLimit(item["Recipient Name"], 200),
          officialWebsite: "",
          country: "United States",
          business: textLimit(item.Description || "美国联邦采购合同", 500),
          contact: "采购/合同部门",
          contactInfo: "",
          description: textLimit(description, 2000),
          confidence: 90,
          providerRecordId: `USASPENDING:${item["Award ID"]}`,
          sourceUrl: `https://www.usaspending.gov/award/${encodeURIComponent(awardRef)}/`,
          recordType: "business_signal",
          evidenceSummary: textLimit(`USAspending 官方合同记录：${description}`, 1000),
          matchedFields: ["company", "country", "business", "description"]
        };
      });
    return {
      records,
      rawCount: data.results.length,
      invalidCount: data.results.length - records.length,
      nextCursor: data.page_metadata.hasNext && page < 100 ? String(page + 1) : null,
      exhausted: !data.page_metadata.hasNext || page >= 100,
      warnings: [],
      usage: freeProcurementUsage(`USAspending 第 ${page} 页返回 ${data.results.length} 条合同`)
    };
  },
  async health() {
    return { ok: true, message: "USAspending 官方公开接口，内置可用，无需配置" };
  }
});

const FIND_TENDER_HOST = "www.find-tender.service.gov.uk";
const FIND_TENDER_BASE_URL = `https://${FIND_TENDER_HOST}`;
const FIND_TENDER_PATH = "/api/1.0/ocdsReleasePackages";

const findTenderPartySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  roles: z.array(z.string()).default([]),
  address: z.object({
    countryName: z.string().optional(),
    locality: z.string().optional()
  }).passthrough().optional(),
  contactPoint: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    telephone: z.string().optional()
  }).passthrough().optional(),
  details: z.object({
    url: z.string().optional()
  }).passthrough().optional()
}).passthrough();

const findTenderReleaseSchema = z.object({
  ocid: z.string().min(1),
  id: z.string().min(1),
  date: z.string().optional(),
  tag: z.array(z.string()).default([]),
  buyer: z.object({
    id: z.string().optional(),
    name: z.string().min(1)
  }).passthrough().nullable().optional(),
  tender: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    procurementMethodDetails: z.string().optional()
  }).passthrough().optional(),
  parties: z.array(findTenderPartySchema).default([])
}).passthrough();

const findTenderResponseSchema = z.object({
  links: z.object({
    next: z.string().url().optional()
  }).passthrough().optional(),
  releases: z.array(findTenderReleaseSchema).default([])
}).passthrough();

function readFindTenderCursor(value: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { cursor?: unknown; updatedTo?: unknown };
    return typeof parsed.cursor === "string" && typeof parsed.updatedTo === "string"
      ? { cursor: parsed.cursor, updatedTo: parsed.updatedTo }
      : null;
  } catch {
    return null;
  }
}

export const UK_FIND_A_TENDER_PROVIDER = defineProvider({
  id: "uk_find_a_tender",
  name: "英国 Find a Tender",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "procurement", "contact", "business_signal"],
  docsUrl: "https://www.find-tender.service.gov.uk/Developer",
  keyHint: "英国政府 OCDS 公开接口，无需 API Key。",
  defaultBaseUrl: FIND_TENDER_BASE_URL,
  costNote: "完全免费，覆盖英国高价值采购公告、采购方、供应商及部分公开联系方式。",
  networkPolicy: {
    allowedHosts: [FIND_TENDER_HOST],
    allowedPathPrefixes: [FIND_TENDER_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 8 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query, cursor }, _cred, tools) {
    if (!targetsCountry(query.countries, UK_ALIASES)) {
      return skippedPage("目标国家不是英国，本次已自动跳过 Find a Tender", "英国 Find a Tender");
    }
    const terms = procurementSearchTerms(query);
    if (!terms.length) return skippedPage("Find a Tender 需要产品或行业关键词", "英国 Find a Tender");
    const url = new URL(`${FIND_TENDER_BASE_URL}${FIND_TENDER_PATH}`);
    url.searchParams.set("limit", "100");
    const saved = readFindTenderCursor(cursor);
    if (saved) {
      url.searchParams.set("updatedTo", saved.updatedTo);
      url.searchParams.set("cursor", saved.cursor);
    } else {
      url.searchParams.set("updatedFrom", `${dateText(recentDate(18), "iso")}T00:00:00Z`);
    }
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "UK Find a Tender");
    let data: z.infer<typeof findTenderResponseSchema>;
    try {
      data = findTenderResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("英国 Find a Tender", error);
    }
    const termSet = terms.map((term) => term.toLocaleLowerCase());
    const records = data.releases
      .filter((release) => {
        const buyer = release.parties.find((party) => party.roles.includes("buyer"));
        const buyerName = release.buyer?.name || buyer?.name || "";
        const text = `${buyerName} ${release.tender?.title || ""} ${release.tender?.description || ""}`.toLocaleLowerCase();
        return Boolean(buyerName)
          && termSet.some((term) => text.includes(term))
          && !isExcludedProcurement(text, query);
      })
      .slice(0, query.limit)
      .map<RawLead>((release) => {
        const buyer = release.parties.find((party) => party.roles.includes("buyer"));
        const buyerName = release.buyer?.name || buyer?.name || "英国采购机构";
        const description = [
          release.tender?.title || "",
          release.tender?.description || "",
          release.tender?.status ? `状态：${release.tender.status}` : "",
          release.date ? `更新：${release.date.slice(0, 10)}` : ""
        ].filter(Boolean).join("；");
        const contactInfo = buyer?.contactPoint?.email || buyer?.contactPoint?.telephone || "";
        return {
          company: textLimit(buyerName, 200),
          officialWebsite: buyer?.details?.url || "",
          country: buyer?.address?.countryName || "United Kingdom",
          business: textLimit(release.tender?.title || "英国公开采购需求", 500),
          contact: textLimit(buyer?.contactPoint?.name || "采购部门", 160),
          contactInfo: textLimit(contactInfo, 255),
          description: textLimit(description, 2000),
          confidence: contactInfo ? 92 : 86,
          providerRecordId: `FTS:${release.ocid}:${release.id}`,
          sourceUrl: `https://www.find-tender.service.gov.uk/Notice/${encodeURIComponent(release.id)}`,
          recordType: "business_signal",
          evidenceSummary: textLimit(`英国 Find a Tender 官方公告：${description}`, 1000),
          matchedFields: ["company", "country", "business", "description", ...(buyer?.details?.url ? ["officialWebsite"] : []), ...(contactInfo ? ["contactInfo"] : [])]
        };
      });
    let nextCursor: string | null = null;
    if (data.links?.next) {
      const next = new URL(data.links.next);
      const cursorValue = next.searchParams.get("cursor");
      const updatedTo = next.searchParams.get("updatedTo");
      if (next.hostname === FIND_TENDER_HOST && next.pathname === FIND_TENDER_PATH && cursorValue && updatedTo) {
        nextCursor = JSON.stringify({ cursor: cursorValue, updatedTo });
      }
    }
    return {
      records,
      rawCount: data.releases.length,
      invalidCount: data.releases.length - records.length,
      nextCursor,
      exhausted: !nextCursor,
      warnings: records.length ? [] : ["本页英国采购公告未命中关键词，后台续搜可继续检查后续页面"],
      usage: freeProcurementUsage(`Find a Tender 本页扫描 ${data.releases.length} 条公告`)
    };
  },
  async health() {
    return { ok: true, message: "英国 Find a Tender 官方公开接口，内置可用，无需配置" };
  }
});

const SAM_HOST = "api.sam.gov";
const SAM_BASE_URL = `https://${SAM_HOST}`;
const SAM_PATH = "/opportunities/v2/search";

const samOpportunitySchema = z.object({
  noticeId: z.string().min(1),
  title: z.string().min(1),
  solicitationNumber: z.string().nullable().optional(),
  fullParentPathName: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  subtier: z.string().nullable().optional(),
  office: z.string().nullable().optional(),
  postedDate: z.string().nullable().optional(),
  responseDeadLine: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  uiLink: z.string().nullable().optional(),
  pointOfContact: z.array(z.object({
    fullName: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional()
  }).passthrough()).optional()
}).passthrough();

const samResponseSchema = z.object({
  totalRecords: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  opportunitiesData: z.array(samOpportunitySchema).default([])
}).passthrough();

export const SAM_OPPORTUNITIES_PROVIDER = defineProvider({
  id: "sam_opportunities",
  name: "美国 SAM.gov 商机",
  adapterVersion: "1.0.0",
  tier: "byok_free",
  category: "company",
  requiresKey: true,
  capabilities: ["company", "procurement", "contact", "business_signal"],
  docsUrl: "https://open.gsa.gov/api/get-opportunities-public-api/",
  keyHint: "在 SAM.gov 个人资料中申请免费的 Public API Key。",
  defaultBaseUrl: SAM_BASE_URL,
  costNote: "API Key 免费，查询美国联邦招标、预告、寻源和采购联系人。",
  networkPolicy: {
    allowedHosts: [SAM_HOST],
    allowedPathPrefixes: [SAM_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 8 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query, cursor }, cred, tools) {
    if (!targetsCountry(query.countries, US_ALIASES)) {
      return skippedPage("目标国家不是美国，本次已自动跳过 SAM.gov", "SAM.gov 商机");
    }
    const terms = procurementSearchTerms(query);
    if (!terms.length) return skippedPage("SAM.gov 需要产品或行业关键词", "SAM.gov 商机");
    const limit = Math.min(query.limit, 20);
    const offset = positiveCursor(cursor, 0, 1_000);
    const url = new URL(`${SAM_BASE_URL}${SAM_PATH}`);
    url.searchParams.set("api_key", cred.apiKey);
    url.searchParams.set("postedFrom", dateText(recentDate(12), "us"));
    url.searchParams.set("postedTo", dateText(new Date(), "us"));
    url.searchParams.set("title", terms.join(" "));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "SAM.gov");
    let data: z.infer<typeof samResponseSchema>;
    try {
      data = samResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("SAM.gov", error);
    }
    const records = data.opportunitiesData
      .filter((item) => !isExcludedProcurement(`${item.title} ${item.fullParentPathName || ""}`, query))
      .map<RawLead>((item) => {
        const point = item.pointOfContact?.[0];
        const buyer = item.office || item.subtier || item.department || item.fullParentPathName || "美国联邦采购机构";
        const description = [
          item.title,
          item.type ? `公告类型：${item.type}` : "",
          item.postedDate ? `发布日期：${item.postedDate.slice(0, 10)}` : "",
          item.responseDeadLine ? `响应截止：${item.responseDeadLine.slice(0, 10)}` : "",
          item.solicitationNumber ? `采购编号：${item.solicitationNumber}` : ""
        ].filter(Boolean).join("；");
        return {
          company: textLimit(buyer, 200),
          officialWebsite: "",
          country: "United States",
          business: textLimit(item.title, 500),
          contact: textLimit(point?.fullName || "采购部门", 160),
          contactInfo: textLimit(point?.email || point?.phone || "", 255),
          description: textLimit(description, 2000),
          confidence: point?.email ? 94 : 88,
          providerRecordId: `SAM:${item.noticeId}`,
          sourceUrl: item.uiLink || `https://sam.gov/opp/${encodeURIComponent(item.noticeId)}/view`,
          recordType: "business_signal",
          evidenceSummary: textLimit(`SAM.gov 官方采购公告：${description}`, 1000),
          matchedFields: ["company", "country", "business", "description", ...(point?.fullName ? ["contact"] : []), ...(point?.email || point?.phone ? ["contactInfo"] : [])]
        };
      });
    const nextOffset = offset + data.opportunitiesData.length;
    const hasNext = data.opportunitiesData.length === limit && nextOffset < data.totalRecords && nextOffset < 1_000;
    return {
      records,
      rawCount: data.opportunitiesData.length,
      invalidCount: data.opportunitiesData.length - records.length,
      nextCursor: hasNext ? String(nextOffset) : null,
      exhausted: !hasNext,
      warnings: [],
      usage: freeProcurementUsage(`SAM.gov 命中 ${data.totalRecords} 条采购公告`)
    };
  },
  async health(cred, tools) {
    const url = new URL(`${SAM_BASE_URL}${SAM_PATH}`);
    url.searchParams.set("api_key", cred.apiKey);
    url.searchParams.set("postedFrom", dateText(recentDate(1), "us"));
    url.searchParams.set("postedTo", dateText(new Date(), "us"));
    url.searchParams.set("limit", "1");
    url.searchParams.set("offset", "0");
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "SAM.gov");
    return { ok: true, message: "SAM.gov Public API Key 验证通过" };
  }
});

const PNCP_HOST = "pncp.gov.br";
const PNCP_BASE_URL = `https://${PNCP_HOST}`;
const PNCP_PATH = "/api/consulta/v1/contratacoes/proposta";

const pncpRecordSchema = z.object({
  numeroControlePNCP: z.string().min(1),
  objetoCompra: z.string().min(1),
  dataPublicacaoPncp: z.string().nullable().optional(),
  dataEncerramentoProposta: z.string().nullable().optional(),
  modalidadeNome: z.string().nullable().optional(),
  valorTotalEstimado: z.number().nullable().optional(),
  linkSistemaOrigem: z.string().nullable().optional(),
  orgaoEntidade: z.object({
    razaoSocial: z.string().min(1),
    cnpj: z.string().optional()
  }).passthrough(),
  unidadeOrgao: z.object({
    ufNome: z.string().nullable().optional(),
    ufSigla: z.string().nullable().optional(),
    municipioNome: z.string().nullable().optional(),
    nomeUnidade: z.string().nullable().optional()
  }).passthrough().optional()
}).passthrough();

const pncpResponseSchema = z.object({
  data: z.array(pncpRecordSchema).default([]),
  totalRegistros: z.number().int().nonnegative().default(0),
  totalPaginas: z.number().int().nonnegative().default(0),
  numeroPagina: z.number().int().positive().default(1),
  paginasRestantes: z.number().int().nonnegative().optional(),
  empty: z.boolean().optional()
}).passthrough();

function pncpSourceUrl(item: z.infer<typeof pncpRecordSchema>) {
  const raw = item.linkSistemaOrigem || "";
  if (raw) {
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).toString();
    } catch {
      // Fall through to the PNCP search page.
    }
  }
  return `https://pncp.gov.br/app/editais?q=${encodeURIComponent(item.numeroControlePNCP)}`;
}

export const BRAZIL_PNCP_PROVIDER = defineProvider({
  id: "brazil_pncp",
  name: "巴西 PNCP 采购",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "procurement", "business_signal"],
  docsUrl: "https://pncp.gov.br/api/consulta/swagger-ui/index.html",
  keyHint: "巴西国家公共采购门户官方接口，无需 API Key。",
  defaultBaseUrl: PNCP_BASE_URL,
  costNote: "完全免费，扫描仍在接收报价的巴西公共采购并按产品关键词过滤。",
  networkPolicy: {
    allowedHosts: [PNCP_HOST],
    allowedPathPrefixes: [PNCP_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 8 * 1024 * 1024,
    timeoutMs: 25_000
  },
  async search({ query, cursor }, _cred, tools) {
    if (!targetsCountry(query.countries, BRAZIL_ALIASES)) {
      return skippedPage("目标国家不是巴西，本次已自动跳过 PNCP", "巴西 PNCP 采购");
    }
    const terms = procurementSearchTerms(query);
    if (!terms.length) return skippedPage("PNCP 需要产品或行业关键词", "巴西 PNCP 采购");
    const page = Math.max(1, positiveCursor(cursor, 1, 200));
    const url = new URL(`${PNCP_BASE_URL}${PNCP_PATH}`);
    url.searchParams.set("dataFinal", dateText(new Date(), "compact"));
    url.searchParams.set("pagina", String(page));
    url.searchParams.set("tamanhoPagina", "50");
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (response.status === 204) {
      return {
        records: [],
        rawCount: 0,
        exhausted: true,
        warnings: [],
        usage: freeProcurementUsage("PNCP 当前无开放采购")
      };
    }
    if (!response.ok) throw providerHttpStatusError(response, "Brazil PNCP");
    let data: z.infer<typeof pncpResponseSchema>;
    try {
      data = pncpResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("巴西 PNCP", error);
    }
    const termSet = terms.map((term) => term.toLocaleLowerCase());
    const records = data.data
      .filter((item) => {
        const text = `${item.objetoCompra} ${item.orgaoEntidade.razaoSocial}`.toLocaleLowerCase();
        return termSet.some((term) => text.includes(term))
          && !isExcludedProcurement(text, query);
      })
      .slice(0, query.limit)
      .map<RawLead>((item) => {
        const amount = typeof item.valorTotalEstimado === "number"
          ? item.valorTotalEstimado.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
          : "";
        const description = [
          item.objetoCompra,
          item.modalidadeNome ? `方式：${item.modalidadeNome}` : "",
          amount ? `预计金额：${amount}` : "",
          item.dataEncerramentoProposta ? `报价截止：${item.dataEncerramentoProposta.slice(0, 10)}` : "",
          item.unidadeOrgao?.municipioNome ? `地区：${item.unidadeOrgao.municipioNome}/${item.unidadeOrgao.ufSigla || ""}` : ""
        ].filter(Boolean).join("；");
        return {
          company: textLimit(item.orgaoEntidade.razaoSocial, 200),
          officialWebsite: "",
          country: "Brazil",
          business: textLimit(item.objetoCompra, 500),
          contact: textLimit(item.unidadeOrgao?.nomeUnidade || "采购部门", 160),
          contactInfo: "",
          description: textLimit(description, 2000),
          confidence: 88,
          providerRecordId: `PNCP:${item.numeroControlePNCP}`,
          sourceUrl: pncpSourceUrl(item),
          recordType: "business_signal",
          evidenceSummary: textLimit(`巴西 PNCP 官方采购公告：${description}`, 1000),
          matchedFields: ["company", "country", "business", "description"]
        };
      });
    const hasNext = page < data.totalPaginas && page < 200;
    return {
      records,
      rawCount: data.data.length,
      invalidCount: data.data.length - records.length,
      nextCursor: hasNext ? String(page + 1) : null,
      exhausted: !hasNext,
      warnings: records.length ? [] : ["本页 PNCP 公告未命中关键词，后台续搜可继续检查后续页面"],
      usage: freeProcurementUsage(`PNCP 当前开放 ${data.totalRegistros} 条采购`)
    };
  },
  async health() {
    return { ok: true, message: "巴西 PNCP 官方公开接口，内置可用，无需配置" };
  }
});

const DENUE_HOST = "www.inegi.org.mx";
const DENUE_BASE_URL = `https://${DENUE_HOST}`;
const DENUE_PATH = "/app/api/denue/v1/consulta/Buscar/";

const denueItemSchema = z.object({
  Id: z.string().min(1),
  Nombre: z.string().min(1),
  Razon_social: z.string().nullable().optional(),
  Clase_actividad: z.string().nullable().optional(),
  Estrato: z.string().nullable().optional(),
  Tipo_vialidad: z.string().nullable().optional(),
  Calle: z.string().nullable().optional(),
  Num_Exterior: z.string().nullable().optional(),
  Colonia: z.string().nullable().optional(),
  CP: z.string().nullable().optional(),
  Municipio: z.string().nullable().optional(),
  Entidad: z.string().nullable().optional(),
  Telefono: z.string().nullable().optional(),
  Correo_e: z.string().nullable().optional(),
  Sitio_internet: z.string().nullable().optional()
}).passthrough();

const denueResponseSchema = z.array(denueItemSchema);

export const MEXICO_DENUE_PROVIDER = defineProvider({
  id: "mexico_denue",
  name: "墨西哥 DENUE 企业名录",
  adapterVersion: "1.0.0",
  tier: "byok_free",
  category: "company",
  requiresKey: true,
  capabilities: ["company", "identity", "contact", "website"],
  docsUrl: "https://www.inegi.org.mx/servicios/api_denue.html",
  keyHint: "在墨西哥 INEGI 免费申请 DENUE Token。",
  defaultBaseUrl: DENUE_BASE_URL,
  costNote: "Token 免费，查询墨西哥经营单位、行业、地址、电话、邮箱及官网。",
  networkPolicy: {
    allowedHosts: [DENUE_HOST],
    allowedPathPrefixes: [DENUE_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 8 * 1024 * 1024,
    timeoutMs: 25_000
  },
  async search({ query, cursor }, cred, tools) {
    if (!targetsCountry(query.countries, MEXICO_ALIASES)) {
      return skippedPage("目标国家不是墨西哥，本次已自动跳过 DENUE", "墨西哥 DENUE");
    }
    const terms = procurementSearchTerms(query);
    if (!terms.length) return skippedPage("DENUE 需要产品、行业或企业关键词", "墨西哥 DENUE");
    const start = Math.max(1, positiveCursor(cursor, 1, 1_000));
    const end = Math.min(start + Math.min(query.limit, 20) - 1, 1_000);
    const url = `${DENUE_BASE_URL}${DENUE_PATH}${encodeURIComponent(terms.join(" "))}/00/${start}/${end}/${encodeURIComponent(cred.apiKey)}`;
    const response = await tools.http.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "Mexico DENUE");
    let data: z.infer<typeof denueResponseSchema>;
    try {
      data = denueResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("墨西哥 DENUE", error);
    }
    const records = data
      .filter((item) => !isExcludedProcurement(`${item.Nombre} ${item.Razon_social || ""} ${item.Clase_actividad || ""}`, query))
      .map<RawLead>((item) => {
        const website = item.Sitio_internet || "";
        const contactInfo = item.Correo_e || item.Telefono || "";
        const description = [
          item.Clase_actividad || "",
          item.Estrato ? `规模：${item.Estrato}` : "",
          [item.Tipo_vialidad, item.Calle, item.Num_Exterior, item.Colonia, item.CP, item.Municipio, item.Entidad].filter(Boolean).join(" ")
        ].filter(Boolean).join("；");
        return {
          company: textLimit(item.Razon_social || item.Nombre, 200),
          officialWebsite: website,
          country: "Mexico",
          business: textLimit(item.Clase_actividad || "墨西哥经营单位", 500),
          contact: "",
          contactInfo: textLimit(contactInfo, 255),
          description: textLimit(description, 2000),
          confidence: website || item.Correo_e ? 92 : 86,
          providerRecordId: `DENUE:${item.Id}`,
          sourceUrl: `https://www.inegi.org.mx/app/mapa/denue/default.aspx?id=${encodeURIComponent(item.Id)}`,
          recordType: "identity_evidence",
          evidenceSummary: textLimit(`墨西哥 DENUE 官方企业记录：${item.Razon_social || item.Nombre}；${description}`, 1000),
          matchedFields: ["company", "country", "business", ...(website ? ["officialWebsite"] : []), ...(contactInfo ? ["contactInfo"] : [])]
        };
      });
    const hasNext = data.length === end - start + 1 && end < 1_000;
    return {
      records,
      rawCount: data.length,
      invalidCount: data.length - records.length,
      nextCursor: hasNext ? String(end + 1) : null,
      exhausted: !hasNext,
      warnings: [],
      usage: freeProcurementUsage(`DENUE 返回 ${data.length} 家经营单位`)
    };
  },
  async health(cred, tools) {
    const url = `${DENUE_BASE_URL}${DENUE_PATH}industrial/00/1/1/${encodeURIComponent(cred.apiKey)}`;
    const response = await tools.http.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "Mexico DENUE");
    return { ok: true, message: "墨西哥 DENUE Token 验证通过" };
  }
});

const FMCSA_HOST = "mobile.fmcsa.dot.gov";
const FMCSA_BASE_URL = `https://${FMCSA_HOST}`;
const FMCSA_PATH = "/qc/services/carriers/name/";

const fmcsaCarrierSchema = z.object({
  carrier: z.object({
    dotNumber: z.union([z.string(), z.number()]),
    legalName: z.string().min(1),
    dbaName: z.string().nullable().optional(),
    allowedToOperate: z.string().nullable().optional(),
    statusCode: z.string().nullable().optional(),
    phyCountry: z.string().nullable().optional(),
    phyState: z.string().nullable().optional(),
    phyCity: z.string().nullable().optional(),
    phyStreet: z.string().nullable().optional(),
    telephone: z.string().nullable().optional(),
    emailAddress: z.string().nullable().optional()
  }).passthrough()
}).passthrough();

const fmcsaResponseSchema = z.object({
  content: z.array(fmcsaCarrierSchema).default([])
}).passthrough();

export const FMCSA_QCMOBILE_PROVIDER = defineProvider({
  id: "fmcsa_qcmobile",
  name: "美国 FMCSA 承运商",
  adapterVersion: "1.0.0",
  tier: "byok_free",
  category: "company",
  requiresKey: true,
  capabilities: ["company", "identity", "contact", "logistics"],
  docsUrl: "https://mobile.fmcsa.dot.gov/QCDevsite/docs/qcApi",
  keyHint: "向美国 FMCSA 申请免费的 QCMobile WebKey。",
  defaultBaseUrl: FMCSA_BASE_URL,
  costNote: "WebKey 免费，发现和核验美国货运、物流及承运企业的 USDOT 状态与联系方式。",
  networkPolicy: {
    allowedHosts: [FMCSA_HOST],
    allowedPathPrefixes: [FMCSA_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query }, cred, tools) {
    if (!targetsCountry(query.countries, US_ALIASES)) {
      return skippedPage("目标国家不是美国，本次已自动跳过 FMCSA", "美国 FMCSA 承运商");
    }
    const terms = procurementSearchTerms(query);
    if (!terms.length) return skippedPage("FMCSA 需要物流、承运商或企业关键词", "美国 FMCSA 承运商");
    const url = new URL(`${FMCSA_BASE_URL}${FMCSA_PATH}${encodeURIComponent(terms.join(" "))}`);
    url.searchParams.set("webKey", cred.apiKey);
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "FMCSA QCMobile");
    let data: z.infer<typeof fmcsaResponseSchema>;
    try {
      data = fmcsaResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("美国 FMCSA", error);
    }
    const records = data.content
      .filter(({ carrier }) => !isExcludedProcurement(`${carrier.legalName} ${carrier.dbaName || ""}`, query))
      .slice(0, query.limit)
      .map<RawLead>(({ carrier }) => {
        const dotNumber = String(carrier.dotNumber);
        const contactInfo = carrier.emailAddress || carrier.telephone || "";
        const description = [
          carrier.dbaName ? `DBA：${carrier.dbaName}` : "",
          carrier.allowedToOperate ? `运营许可：${carrier.allowedToOperate}` : "",
          carrier.statusCode ? `状态：${carrier.statusCode}` : "",
          [carrier.phyStreet, carrier.phyCity, carrier.phyState].filter(Boolean).join(" ")
        ].filter(Boolean).join("；");
        return {
          company: textLimit(carrier.legalName, 200),
          officialWebsite: "",
          country: textLimit(carrier.phyCountry || "United States", 100),
          business: "货运、物流及商业承运",
          contact: "",
          contactInfo: textLimit(contactInfo, 255),
          description: textLimit(description, 2000),
          confidence: carrier.allowedToOperate === "Y" ? 94 : 86,
          providerRecordId: `USDOT:${dotNumber}`,
          sourceUrl: `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${encodeURIComponent(dotNumber)}`,
          recordType: "identity_evidence",
          evidenceSummary: textLimit(`FMCSA 官方承运商记录：${carrier.legalName}；USDOT ${dotNumber}；${description}`, 1000),
          matchedFields: ["company", "country", "business", ...(contactInfo ? ["contactInfo"] : [])]
        };
      });
    return {
      records,
      rawCount: data.content.length,
      invalidCount: data.content.length - records.length,
      exhausted: true,
      warnings: [],
      usage: freeProcurementUsage(`FMCSA 返回 ${data.content.length} 家承运商`)
    };
  },
  async health(cred, tools) {
    const url = new URL(`${FMCSA_BASE_URL}${FMCSA_PATH}UPS`);
    url.searchParams.set("webKey", cred.apiKey);
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "FMCSA QCMobile");
    return { ok: true, message: "FMCSA QCMobile WebKey 验证通过" };
  }
});

const GEBIZ_HOST = "data.gov.sg";
const GEBIZ_BASE_URL = `https://${GEBIZ_HOST}`;
const GEBIZ_PATH = "/api/action/datastore_search";
const GEBIZ_RESOURCE_ID = "d_acde1106003906a75c3fa052592f2fcb";

const gebizRecordSchema = z.object({
  _id: z.union([z.string(), z.number()]),
  tender_no: z.string().min(1),
  tender_description: z.string().min(1),
  agency: z.string().min(1),
  award_date: z.string().nullable().optional(),
  tender_detail_status: z.string().nullable().optional(),
  supplier_name: z.string().nullable().optional(),
  awarded_amt: z.union([z.string(), z.number()]).nullable().optional()
}).passthrough();

const gebizResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    records: z.array(gebizRecordSchema).default([]),
    total: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().optional()
  }).passthrough()
}).passthrough();

export const SINGAPORE_GEBIZ_PROVIDER = defineProvider({
  id: "singapore_gebiz",
  name: "新加坡 GeBIZ 中标数据",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "procurement", "business_signal"],
  docsUrl: "https://data.gov.sg/collections/1920/view",
  keyHint: "新加坡政府开放数据接口，无需 API Key。",
  defaultBaseUrl: GEBIZ_BASE_URL,
  costNote: "完全免费，通过 GeBIZ 已授标记录发现采购机构、供应商、产品描述和中标金额。",
  networkPolicy: {
    allowedHosts: [GEBIZ_HOST],
    allowedPathPrefixes: [GEBIZ_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 6 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query, cursor }, _cred, tools) {
    if (!targetsCountry(query.countries, SINGAPORE_ALIASES)) {
      return skippedPage("目标国家不是新加坡，本次已自动跳过 GeBIZ", "新加坡 GeBIZ");
    }
    const terms = procurementSearchTerms(query);
    if (!terms.length) return skippedPage("GeBIZ 需要产品或行业关键词", "新加坡 GeBIZ");
    const limit = Math.min(query.limit, 20);
    const offset = positiveCursor(cursor, 0, 10_000);
    const url = new URL(`${GEBIZ_BASE_URL}${GEBIZ_PATH}`);
    url.searchParams.set("resource_id", GEBIZ_RESOURCE_ID);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("q", terms.join(" "));
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "Singapore GeBIZ");
    let data: z.infer<typeof gebizResponseSchema>;
    try {
      data = gebizResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("新加坡 GeBIZ", error);
    }
    const records = data.result.records
      .filter((item) => !isExcludedProcurement(`${item.supplier_name || ""} ${item.agency} ${item.tender_description}`, query))
      .map<RawLead>((item) => {
        const company = item.supplier_name || item.agency;
        const amount = item.awarded_amt === null || item.awarded_amt === undefined
          ? ""
          : String(item.awarded_amt);
        const description = [
          item.tender_description,
          `采购机构：${item.agency}`,
          item.supplier_name ? `中标供应商：${item.supplier_name}` : "",
          amount ? `中标金额：SGD ${amount}` : "",
          item.award_date ? `授标日期：${item.award_date}` : "",
          item.tender_detail_status ? `状态：${item.tender_detail_status}` : ""
        ].filter(Boolean).join("；");
        return {
          company: textLimit(company, 200),
          officialWebsite: "",
          country: "Singapore",
          business: textLimit(item.tender_description, 500),
          contact: item.supplier_name ? "销售/投标部门" : "采购部门",
          contactInfo: "",
          description: textLimit(description, 2000),
          confidence: item.supplier_name ? 90 : 84,
          providerRecordId: `GEBIZ:${item.tender_no}:${String(item._id)}`,
          sourceUrl: `https://www.gebiz.gov.sg/ptn/opportunity/BOListing.xhtml?origin=search&tenderNo=${encodeURIComponent(item.tender_no)}`,
          recordType: "business_signal",
          evidenceSummary: textLimit(`新加坡 GeBIZ 官方授标记录：${description}`, 1000),
          matchedFields: ["company", "country", "business", "description"]
        };
      });
    const nextOffset = offset + data.result.records.length;
    const hasNext = data.result.records.length === limit && nextOffset < data.result.total && nextOffset < 10_000;
    return {
      records,
      rawCount: data.result.records.length,
      invalidCount: data.result.records.length - records.length,
      nextCursor: hasNext ? String(nextOffset) : null,
      exhausted: !hasNext,
      warnings: ["GeBIZ 当前开放数据为已授标记录，适合反查真实采购方和供应商，不代表仍在开放报价。"],
      usage: freeProcurementUsage(`GeBIZ 命中 ${data.result.total} 条授标记录`)
    };
  },
  async health() {
    return { ok: true, message: "新加坡 GeBIZ 政府开放数据接口，内置可用，无需配置" };
  }
});

export const PUBLIC_PROCUREMENT_PROVIDERS: LeadProvider[] = [
  USASPENDING_AWARDS_PROVIDER,
  UK_FIND_A_TENDER_PROVIDER,
  SAM_OPPORTUNITIES_PROVIDER,
  BRAZIL_PNCP_PROVIDER,
  MEXICO_DENUE_PROVIDER,
  FMCSA_QCMOBILE_PROVIDER,
  SINGAPORE_GEBIZ_PROVIDER
];
