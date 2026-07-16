import { z } from "zod";
import {
  defineProvider,
  providerHttpStatusError,
  type LeadProvider,
  type NormalizedProviderQuery,
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

function identityUsage(label: string) {
  return freeProcurementUsage(label);
}

const FRANCE_ALIASES = new Set(["france", "french", "法国"]);
const FRANCE_HOST = "recherche-entreprises.api.gouv.fr";
const FRANCE_BASE_URL = `https://${FRANCE_HOST}`;
const FRANCE_PATH = "/search";

const franceOfficeSchema = z.object({
  activite_principale: z.string().nullable().optional(),
  adresse: z.string().nullable().optional(),
  code_postal: z.string().nullable().optional(),
  libelle_commune: z.string().nullable().optional(),
  siret: z.string().nullable().optional()
}).passthrough().nullable().optional();

const franceCompanySchema = z.object({
  nom_complet: z.string().min(1),
  siren: z.string().min(1),
  activite_principale: z.string().nullable().optional(),
  etat_administratif: z.string().nullable().optional(),
  siege: franceOfficeSchema
}).passthrough();

const franceResponseSchema = z.object({
  results: z.array(franceCompanySchema).default([]),
  total_results: z.number().int().nonnegative().default(0),
  page: z.number().int().positive().optional(),
  per_page: z.number().int().positive().optional(),
  total_pages: z.number().int().nonnegative().optional()
}).passthrough();

export const FR_COMPANY_SEARCH_PROVIDER = defineProvider({
  id: "fr_company_search",
  name: "法国企业名录",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "identity"],
  docsUrl: "https://recherche-entreprises.api.gouv.fr/docs/",
  keyHint: "法国政府官方企业检索接口，无需 API Key。",
  defaultBaseUrl: FRANCE_BASE_URL,
  costNote: "完全免费，核验法国企业名称、SIREN、SIRET、地址和经营状态。",
  networkPolicy: {
    allowedHosts: [FRANCE_HOST],
    allowedPathPrefixes: [FRANCE_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query, cursor }, _cred, tools) {
    if (!targetsCountry(query.countries, FRANCE_ALIASES)) {
      return skippedPage("目标国家不是法国，本次已自动跳过法国企业名录", "法国官方企业名录");
    }
    const terms = procurementSearchTerms(query);
    if (!terms.length) {
      return skippedPage("法国企业名录需要产品、行业或企业关键词", "法国官方企业名录");
    }
    const page = Math.max(1, positiveCursor(cursor, 1, 100));
    const limit = Math.min(query.limit, 25);
    const url = new URL(`${FRANCE_BASE_URL}${FRANCE_PATH}`);
    url.searchParams.set("q", terms.join(" "));
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(limit));
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "France Company Search");
    let data: z.infer<typeof franceResponseSchema>;
    try {
      data = franceResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("法国企业名录", error);
    }
    const records = data.results
      .filter((item) => !isExcludedProcurement(
        `${item.nom_complet} ${item.activite_principale || ""} ${item.siege?.adresse || ""}`,
        query
      ))
      .map<RawLead>((item) => {
        const address = textLimit([
          item.siege?.adresse || "",
          item.siege?.code_postal || "",
          item.siege?.libelle_commune || ""
        ].filter(Boolean).join(" "), 500);
        const activity = item.activite_principale || item.siege?.activite_principale || "";
        return {
          company: textLimit(item.nom_complet, 200),
          officialWebsite: "",
          country: "France",
          business: textLimit(activity ? `NAF ${activity}` : "法国注册企业", 500),
          contact: "",
          contactInfo: "",
          description: textLimit([
            item.etat_administratif === "A" ? "登记状态：在营" : item.etat_administratif ? `登记状态：${item.etat_administratif}` : "",
            address ? `注册地址：${address}` : "",
            item.siege?.siret ? `SIRET：${item.siege.siret}` : ""
          ].filter(Boolean).join("；"), 2000),
          confidence: item.etat_administratif === "A" ? 94 : 86,
          providerRecordId: `SIREN:${item.siren}`,
          sourceUrl: `https://annuaire-entreprises.data.gouv.fr/entreprise/${encodeURIComponent(item.siren)}`,
          recordType: "identity_evidence",
          evidenceSummary: textLimit(`法国政府企业名录：${item.nom_complet}；SIREN ${item.siren}${address ? `；${address}` : ""}`, 1000),
          matchedFields: ["company", "country", "description"]
        };
      });
    const totalPages = data.total_pages || Math.ceil(data.total_results / limit);
    const hasNext = page < totalPages && page < 100;
    return {
      records,
      rawCount: data.results.length,
      invalidCount: data.results.length - records.length,
      nextCursor: hasNext ? String(page + 1) : null,
      exhausted: !hasNext,
      warnings: [],
      usage: identityUsage(`法国企业名录命中 ${data.total_results} 家`)
    };
  },
  async health() {
    return { ok: true, message: "法国政府企业名录公开接口，内置可用，无需配置" };
  }
});

const ROR_HOST = "api.ror.org";
const ROR_BASE_URL = `https://${ROR_HOST}`;
const ROR_PATH = "/v2/organizations";

const rorItemSchema = z.object({
  id: z.string().url(),
  names: z.array(z.object({
    value: z.string(),
    types: z.array(z.string()).default([]),
    lang: z.string().nullable().optional()
  }).passthrough()).default([]),
  locations: z.array(z.object({
    geonames_details: z.object({
      country_name: z.string().optional(),
      country_code: z.string().optional(),
      name: z.string().optional()
    }).passthrough().optional()
  }).passthrough()).default([]),
  types: z.array(z.string()).default([]),
  links: z.array(z.object({
    type: z.string().optional(),
    value: z.string().optional()
  }).passthrough()).default([])
}).passthrough();

const rorResponseSchema = z.object({
  number_of_results: z.number().int().nonnegative().default(0),
  items: z.array(rorItemSchema).default([])
}).passthrough();

export const ROR_PROVIDER = defineProvider({
  id: "ror",
  name: "ROR 全球机构库",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "identity", "website"],
  docsUrl: "https://ror.readme.io/docs/rest-api",
  keyHint: "ROR 官方开放机构接口，无需 API Key。",
  defaultBaseUrl: ROR_BASE_URL,
  costNote: "完全免费，适合核验科研、医疗、教育及部分企业机构的名称、国家和官网。",
  networkPolicy: {
    allowedHosts: [ROR_HOST],
    allowedPathPrefixes: [ROR_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query, cursor }, _cred, tools) {
    const terms = procurementSearchTerms(query);
    if (!terms.length) return skippedPage("ROR 需要产品、行业或机构关键词", "ROR 全球机构库");
    const page = Math.max(1, positiveCursor(cursor, 1, 100));
    const url = new URL(`${ROR_BASE_URL}${ROR_PATH}`);
    url.searchParams.set("query", terms.join(" "));
    url.searchParams.set("page", String(page));
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "ROR");
    let data: z.infer<typeof rorResponseSchema>;
    try {
      data = rorResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("ROR 全球机构库", error);
    }
    const requestedCountry = query.countries[0]?.toLocaleLowerCase() || "";
    const records = data.items
      .filter((item) => {
        const country = item.locations[0]?.geonames_details?.country_name || "";
        return (!requestedCountry || country.toLocaleLowerCase().includes(requestedCountry))
          && !isExcludedProcurement(item.names.map((name) => name.value).join(" "), query);
      })
      .slice(0, query.limit)
      .map<RawLead>((item) => {
        const displayName = item.names.find((name) => name.types.includes("ror_display"))?.value
          || item.names.find((name) => name.types.includes("label"))?.value
          || item.names[0]?.value
          || "Unknown organization";
        const location = item.locations[0]?.geonames_details;
        const website = item.links.find((link) => link.type === "website")?.value || "";
        return {
          company: textLimit(displayName, 200),
          officialWebsite: website,
          country: textLimit(location?.country_name || "", 100),
          business: textLimit(item.types.join(", ") || "研究及专业机构", 500),
          contact: "",
          contactInfo: "",
          description: textLimit([
            location?.name ? `所在地：${location.name}` : "",
            item.types.length ? `机构类型：${item.types.join(", ")}` : ""
          ].filter(Boolean).join("；"), 2000),
          confidence: website ? 92 : 86,
          providerRecordId: `ROR:${item.id.split("/").pop() || item.id}`,
          sourceUrl: item.id,
          recordType: "identity_evidence",
          evidenceSummary: textLimit(`ROR 官方机构记录：${displayName}${location?.country_name ? `；${location.country_name}` : ""}`, 1000),
          matchedFields: ["company", "country", ...(website ? ["officialWebsite"] : [])]
        };
      });
    const pageSize = data.items.length || 20;
    const hasNext = data.items.length > 0 && page * pageSize < data.number_of_results && page < 100;
    return {
      records,
      rawCount: data.items.length,
      invalidCount: data.items.length - records.length,
      nextCursor: hasNext ? String(page + 1) : null,
      exhausted: !hasNext,
      warnings: [],
      usage: identityUsage(`ROR 命中 ${data.number_of_results} 家机构`)
    };
  },
  async health() {
    return { ok: true, message: "ROR 官方开放接口，内置可用，无需配置" };
  }
});

const US_ALIASES = new Set(["us", "usa", "united states", "united states of america", "美国"]);
const NPPES_HOST = "npiregistry.cms.hhs.gov";
const NPPES_BASE_URL = `https://${NPPES_HOST}`;
const NPPES_PATH = "/api/";

const nppesResultSchema = z.object({
  number: z.string().min(1),
  basic: z.object({
    organization_name: z.string().min(1),
    status: z.string().optional(),
    authorized_official_first_name: z.string().optional(),
    authorized_official_last_name: z.string().optional(),
    authorized_official_title_or_position: z.string().optional(),
    authorized_official_telephone_number: z.string().optional()
  }).passthrough(),
  addresses: z.array(z.object({
    address_purpose: z.string().optional(),
    address_1: z.string().optional(),
    address_2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
    country_name: z.string().optional(),
    telephone_number: z.string().optional()
  }).passthrough()).default([]),
  taxonomies: z.array(z.object({
    desc: z.string().optional(),
    primary: z.boolean().optional()
  }).passthrough()).default([])
}).passthrough();

const nppesResponseSchema = z.object({
  result_count: z.number().int().nonnegative().default(0),
  results: z.array(nppesResultSchema).default([])
}).passthrough();

export const NPPES_PROVIDER = defineProvider({
  id: "nppes",
  name: "美国 NPPES 医疗机构",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "identity", "contact", "healthcare"],
  docsUrl: "https://npiregistry.cms.hhs.gov/api-page",
  keyHint: "美国 CMS 官方 NPI Registry 接口，无需 API Key。",
  defaultBaseUrl: NPPES_BASE_URL,
  costNote: "完全免费，用于发现和核验美国医院、诊所、实验室及其他医疗组织。",
  networkPolicy: {
    allowedHosts: [NPPES_HOST],
    allowedPathPrefixes: [NPPES_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query, cursor }, _cred, tools) {
    if (!targetsCountry(query.countries, US_ALIASES)) {
      return skippedPage("目标国家不是美国，本次已自动跳过 NPPES", "美国 NPPES 医疗机构");
    }
    const terms = procurementSearchTerms(query);
    if (!terms.length) return skippedPage("NPPES 需要医疗产品、行业或机构关键词", "美国 NPPES 医疗机构");
    const limit = Math.min(query.limit, 20);
    const skip = positiveCursor(cursor, 0, 1_000);
    const url = new URL(`${NPPES_BASE_URL}${NPPES_PATH}`);
    url.searchParams.set("version", "2.1");
    url.searchParams.set("enumeration_type", "NPI-2");
    url.searchParams.set("organization_name", terms.join(" "));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("skip", String(skip));
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "NPPES");
    let data: z.infer<typeof nppesResponseSchema>;
    try {
      data = nppesResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("美国 NPPES", error);
    }
    const records = data.results
      .filter((item) => !isExcludedProcurement(
        `${item.basic.organization_name} ${item.taxonomies.map((taxonomy) => taxonomy.desc || "").join(" ")}`,
        query
      ))
      .map<RawLead>((item) => {
        const address = item.addresses.find((entry) => entry.address_purpose === "LOCATION") || item.addresses[0];
        const taxonomy = item.taxonomies.find((entry) => entry.primary)?.desc || item.taxonomies[0]?.desc || "";
        const official = [
          item.basic.authorized_official_first_name || "",
          item.basic.authorized_official_last_name || ""
        ].filter(Boolean).join(" ");
        const phone = address?.telephone_number || item.basic.authorized_official_telephone_number || "";
        return {
          company: textLimit(item.basic.organization_name, 200),
          officialWebsite: "",
          country: "United States",
          business: textLimit(taxonomy || "美国医疗服务机构", 500),
          contact: textLimit(official || item.basic.authorized_official_title_or_position || "", 160),
          contactInfo: textLimit(phone, 255),
          description: textLimit([
            address ? [address.address_1, address.address_2, address.city, address.state, address.postal_code].filter(Boolean).join(" ") : "",
            item.basic.status === "A" ? "NPI 状态：有效" : item.basic.status ? `NPI 状态：${item.basic.status}` : ""
          ].filter(Boolean).join("；"), 2000),
          confidence: item.basic.status === "A" ? 94 : 86,
          providerRecordId: `NPI:${item.number}`,
          sourceUrl: `https://npiregistry.cms.hhs.gov/provider-view/${encodeURIComponent(item.number)}`,
          recordType: "identity_evidence",
          evidenceSummary: textLimit(`美国 NPI Registry：${item.basic.organization_name}；NPI ${item.number}${taxonomy ? `；${taxonomy}` : ""}`, 1000),
          matchedFields: ["company", "country", "business", ...(phone ? ["contactInfo"] : [])]
        };
      });
    const hasNext = data.results.length === limit && skip + data.results.length < 1_000;
    return {
      records,
      rawCount: data.results.length,
      invalidCount: data.results.length - records.length,
      nextCursor: hasNext ? String(skip + data.results.length) : null,
      exhausted: !hasNext,
      warnings: [],
      usage: identityUsage(`NPPES 返回 ${data.result_count} 家医疗机构`)
    };
  },
  async health() {
    return { ok: true, message: "美国 NPPES 官方公开接口，内置可用，无需配置" };
  }
});

const OPENFDA_HOST = "api.fda.gov";
const OPENFDA_BASE_URL = `https://${OPENFDA_HOST}`;
const OPENFDA_PATH = "/device/510k.json";

const openFdaItemSchema = z.object({
  k_number: z.string().min(1),
  applicant: z.string().min(1),
  device_name: z.string().optional(),
  decision_date: z.string().optional(),
  contact: z.string().optional(),
  address_1: z.string().optional(),
  address_2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country_code: z.string().optional(),
  zip_code: z.string().optional()
}).passthrough();

const openFdaResponseSchema = z.object({
  meta: z.object({
    results: z.object({
      skip: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      total: z.number().int().nonnegative()
    }).passthrough()
  }).passthrough(),
  results: z.array(openFdaItemSchema).default([])
}).passthrough();

export const OPENFDA_510K_PROVIDER = defineProvider({
  id: "openfda_510k",
  name: "美国 FDA 510(k)",
  adapterVersion: "1.0.0",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company", "identity", "medical_device"],
  docsUrl: "https://open.fda.gov/apis/device/510k/",
  keyHint: "openFDA 官方公开接口，无需 API Key；可选 Key 不是运行必需。",
  defaultBaseUrl: OPENFDA_BASE_URL,
  costNote: "完全免费，通过医疗器械 510(k) 记录发现申请企业、产品和公开联系人。",
  networkPolicy: {
    allowedHosts: [OPENFDA_HOST],
    allowedPathPrefixes: [OPENFDA_PATH],
    allowedMethods: ["GET"],
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutMs: 20_000
  },
  async search({ query, cursor }, _cred, tools) {
    const terms = procurementSearchTerms(query);
    if (!terms.length) return skippedPage("FDA 510(k) 需要医疗器械产品关键词", "openFDA 510(k)");
    const limit = Math.min(query.limit, 20);
    const skip = positiveCursor(cursor, 0, 1_000);
    const url = new URL(`${OPENFDA_BASE_URL}${OPENFDA_PATH}`);
    url.searchParams.set("search", `device_name:"${terms.join(" ")}"`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("skip", String(skip));
    const response = await tools.http.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (response.status === 404) {
      return {
        records: [],
        rawCount: 0,
        exhausted: true,
        warnings: ["openFDA 未找到匹配的 510(k) 医疗器械记录"],
        usage: identityUsage("openFDA 510(k) 未命中")
      };
    }
    if (!response.ok) throw providerHttpStatusError(response, "openFDA 510(k)");
    let data: z.infer<typeof openFdaResponseSchema>;
    try {
      data = openFdaResponseSchema.parse(await response.json());
    } catch (error) {
      throw procurementSchemaError("openFDA 510(k)", error);
    }
    const records = data.results
      .filter((item) => !isExcludedProcurement(`${item.applicant} ${item.device_name || ""}`, query))
      .map<RawLead>((item) => ({
        company: textLimit(item.applicant, 200),
        officialWebsite: "",
        country: textLimit(item.country_code || "", 100),
        business: textLimit(item.device_name || "FDA 510(k) 医疗器械", 500),
        contact: textLimit(item.contact || "", 160),
        contactInfo: "",
        description: textLimit([
          item.device_name || "",
          item.decision_date ? `FDA 决定日期：${item.decision_date}` : "",
          [item.address_1, item.address_2, item.city, item.state, item.zip_code].filter(Boolean).join(" ")
        ].filter(Boolean).join("；"), 2000),
        confidence: 92,
        providerRecordId: `FDA510K:${item.k_number}`,
        sourceUrl: `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=${encodeURIComponent(item.k_number)}`,
        recordType: "identity_evidence",
        evidenceSummary: textLimit(`FDA 510(k) 官方记录：${item.applicant}；${item.k_number}；${item.device_name || ""}`, 1000),
        matchedFields: ["company", "country", "business", ...(item.contact ? ["contact"] : [])]
      }));
    const total = data.meta.results.total;
    const nextSkip = skip + data.results.length;
    const hasNext = data.results.length === limit && nextSkip < total && nextSkip < 1_000;
    return {
      records,
      rawCount: data.results.length,
      invalidCount: data.results.length - records.length,
      nextCursor: hasNext ? String(nextSkip) : null,
      exhausted: !hasNext,
      warnings: ["openFDA 明确提示公开数据未经临床验证，本来源仅用于企业发现和证据核验。"],
      usage: identityUsage(`openFDA 命中 ${total} 条 510(k) 记录`)
    };
  },
  async health() {
    return { ok: true, message: "openFDA 510(k) 官方公开接口，内置可用，无需配置" };
  }
});

export const PUBLIC_COMPANY_PROVIDERS: LeadProvider[] = [
  FR_COMPANY_SEARCH_PROVIDER,
  ROR_PROVIDER,
  NPPES_PROVIDER,
  OPENFDA_510K_PROVIDER
];
