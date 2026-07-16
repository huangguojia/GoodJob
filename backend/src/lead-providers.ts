import {
  defineProvider,
  providerHttpStatusError,
  type LeadProvider,
  type NormalizedProviderQuery,
  type ProviderAdapterPage,
  type ProviderUsage,
  type RawLead
} from "./provider-contract.js";
import { EU_TED_PROVIDER } from "./eu-ted-provider.js";
import { SEC_EDGAR_PROVIDER } from "./sec-edgar-provider.js";
import { UK_CONTRACTS_FINDER_PROVIDER } from "./uk-contracts-finder-provider.js";
import { WORLD_BANK_PROCUREMENT_PROVIDER } from "./world-bank-procurement-provider.js";
import { PUBLIC_COMPANY_PROVIDERS } from "./public-company-providers.js";
import { PUBLIC_PROCUREMENT_PROVIDERS } from "./public-procurement-providers.js";
import { ASSISTED_SOURCE_PROVIDERS } from "./assisted-source-providers.js";

/**
 * 自动获客数据源适配层。
 *
 * 每个数据源实现统一的 LeadProvider 接口：
 * - search()：按获客条件返回候选公司（原始字段，后续由运行时统一校验、去重、评分、落库）。
 * - health()：用用户填写的 API Key 做一次最小真实调用，验证“配上 key 就能用”。
 * - enrich()（可选）：邮箱/联系人补全，作用在已发现的域名上（Hunter 等）。
 *
 * 免费源（GLEIF/Wikidata/公共采购公告）无需 key，内置可用；其余为“自带 key 即插即用”。
 */

export type { LeadProvider, LeadQuery, ProviderCredential, RawLead } from "./provider-contract.js";

function firstToken(value: string | string[]) {
  if (Array.isArray(value)) return value[0]?.trim() || "";
  return value.split(/,|，|\/|、/)[0]?.trim() || "";
}

function webQueryText(query: NormalizedProviderQuery) {
  const exclude = query.excludeKeywords
    .map((item) => `-${item}`)
    .join(" ");
  return [
    query.goal,
    query.productKeywords.join(" "),
    query.industries.join(" "),
    query.customerTypes.join(" "),
    query.countries.join(" "),
    exclude
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function companyQueryText(query: NormalizedProviderQuery) {
  return [query.productKeywords, query.industries, query.customerTypes, query.countries]
    .map(firstToken)
    .filter(Boolean)
    .join(" ")
    .trim() || query.goal || "product supplier";
}

function domainFromUrl(raw: string) {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./i, "");
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
  }
}

function companyFromDomain(domain: string) {
  const core = domain.split(".")[0] || domain;
  return core.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function probableOfficialWebsite(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isHomeLikePath = path === "/" || /^\/[a-z]{2}(?:-[a-z]{2})?$/i.test(path);
    return isHomeLikePath ? url.origin : "";
  } catch {
    return "";
  }
}

/** 判断某网页是否值得作为候选（过滤明显的目录/招聘/维基类站点）。 */
const NON_COMPANY_HOSTS = /wikipedia\.org|linkedin\.com|facebook\.com|youtube\.com|amazon\.|alibaba\.com|indeed\.|glassdoor\.|reddit\.com|quora\.com/i;

function webResultToLead(
  title: string,
  link: string,
  snippet: string,
  query: NormalizedProviderQuery
): RawLead | null {
  if (!link) return null;
  if (NON_COMPANY_HOSTS.test(link)) return null;
  const domain = domainFromUrl(link);
  const company = (title || "").split(/[-|｜–—]/)[0].trim() || companyFromDomain(domain);
  return {
    company: company.slice(0, 120),
    officialWebsite: probableOfficialWebsite(link),
    country: firstToken(query.countries) || "未知",
    business: (snippet || query.productKeywords.join(", ") || query.industries.join(", ") || "").slice(0, 160) || "待核实业务",
    contact: "待维护",
    contactInfo: "",
    description: (snippet || "").slice(0, 240),
    confidence: 62,
    sourceUrl: link,
    recordType: "discovery_page",
    evidenceSummary: (snippet || title || "公开搜索结果").slice(0, 500),
    matchedFields: [
      "company",
      ...(probableOfficialWebsite(link) ? ["officialWebsite"] : []),
      "description"
    ]
  };
}

function usage(display = "", requestCount: number | null = 1): Partial<ProviderUsage> {
  return {
    requestCount,
    quotaUsed: null,
    quotaRemaining: null,
    costAmount: null,
    currency: null,
    estimated: false,
    display
  };
}

function providerPage(
  records: RawLead[],
  options: {
    display?: string;
    requestCount?: number | null;
    rawCount?: number;
    invalidCount?: number;
    warnings?: string[];
    nextCursor?: string | null;
    exhausted?: boolean;
  } = {}
): ProviderAdapterPage {
  return {
    records,
    rawCount: options.rawCount ?? records.length,
    invalidCount: options.invalidCount ?? 0,
    warnings: options.warnings || [],
    nextCursor: options.nextCursor ?? null,
    exhausted: options.exhausted ?? true,
    usage: usage(options.display, options.requestCount ?? 1)
  };
}

// ---------------------------------------------------------------------------
// Web 搜索源：仅使用搜索 API 返回的索引标题、摘要和链接，不访问企业网页。
// ---------------------------------------------------------------------------

const serper = defineProvider({
  id: "serper",
  name: "Serper (Google)",
  tier: "byok_free",
  category: "web",
  requiresKey: true,
  capabilities: ["web"],
  docsUrl: "https://serper.dev",
  keyHint: "在 serper.dev 注册后获取 API Key（含 2500 次免费额度）。",
  defaultBaseUrl: "https://google.serper.dev",
  costNote: "免费额度 2500 次，超出按次计费。",
  networkPolicy: {
    allowedHosts: ["google.serper.dev"],
    allowedPathPrefixes: ["/search"],
    allowedMethods: ["POST"]
  },
  async search({ query }, cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://google.serper.dev").replace(/\/+$/, "");
    const gl = countryToGl(firstToken(query.countries));
    const response = await tools.http.fetch(`${base}/search`, {
      method: "POST",
      headers: { "X-API-KEY": cred.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ q: webQueryText(query), num: Math.min(query.limit, 20), gl, hl: "en" })
    });
    if (!response.ok) throw providerHttpStatusError(response, "Serper");
    const data = (await response.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
    const leads = (data.organic || [])
      .map((item) => webResultToLead(item.title || "", item.link || "", item.snippet || "", query))
      .filter((item): item is RawLead => Boolean(item));
    return providerPage(leads, { rawCount: data.organic?.length || 0 });
  },
  async health(cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://google.serper.dev").replace(/\/+$/, "");
    const response = await tools.http.fetch(`${base}/search`, {
      method: "POST",
      headers: { "X-API-KEY": cred.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ q: "industrial product supplier", num: 1 })
    });
    if (!response.ok) throw providerHttpStatusError(response, "Serper");
    return { ok: true, message: "Serper 连接通过，可用于 Web 搜客" };
  }
});

const brave = defineProvider({
  id: "brave",
  name: "Brave Search",
  tier: "byok_free",
  category: "web",
  requiresKey: true,
  capabilities: ["web"],
  docsUrl: "https://api-dashboard.search.brave.com",
  keyHint: "在 Brave Search API 控制台获取 Subscription Token（免费 2000 次/月）。",
  defaultBaseUrl: "https://api.search.brave.com/res/v1",
  costNote: "免费额度 2000 次/月，1 次/秒。",
  networkPolicy: {
    allowedHosts: ["api.search.brave.com"],
    allowedPathPrefixes: ["/res/v1/"],
    allowedMethods: ["GET"]
  },
  async search({ query }, cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.search.brave.com/res/v1").replace(/\/+$/, "");
    const country = countryToGl(firstToken(query.countries)).toUpperCase();
    const url = `${base}/web/search?q=${encodeURIComponent(webQueryText(query))}&count=${Math.min(query.limit, 20)}${country ? `&country=${country}` : ""}`;
    const response = await tools.http.fetch(url, {
      headers: { "X-Subscription-Token": cred.apiKey, accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "Brave");
    const data = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    const leads = (data.web?.results || [])
      .map((item) => webResultToLead(item.title || "", item.url || "", item.description || "", query))
      .filter((item): item is RawLead => Boolean(item));
    const remaining = response.headers.get("X-RateLimit-Remaining") || "";
    return providerPage(leads, {
      rawCount: data.web?.results?.length || 0,
      display: remaining ? `本月剩余额度约 ${remaining}` : ""
    });
  },
  async health(cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.search.brave.com/res/v1").replace(/\/+$/, "");
    const response = await tools.http.fetch(`${base}/web/search?q=industrial%20product%20supplier&count=1`, {
      headers: { "X-Subscription-Token": cred.apiKey, accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "Brave");
    const remaining = response.headers.get("X-RateLimit-Remaining") || "";
    return { ok: true, message: "Brave Search 连接通过", usage: usage(remaining ? `剩余额度约 ${remaining}` : "") };
  }
});

const serpapi = defineProvider({
  id: "serpapi",
  name: "SerpApi (Google)",
  tier: "paid",
  category: "web",
  requiresKey: true,
  capabilities: ["web"],
  docsUrl: "https://serpapi.com",
  keyHint: "在 serpapi.com 获取 API Key（免费 100 次/月）。",
  defaultBaseUrl: "https://serpapi.com",
  costNote: "免费 100 次/月，超出按套餐计费。",
  networkPolicy: {
    allowedHosts: ["serpapi.com"],
    allowedPathPrefixes: ["/search.json", "/account"],
    allowedMethods: ["GET"]
  },
  async search({ query }, cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://serpapi.com").replace(/\/+$/, "");
    const gl = countryToGl(firstToken(query.countries));
    const url = `${base}/search.json?engine=google&q=${encodeURIComponent(webQueryText(query))}&num=${Math.min(query.limit, 20)}${gl ? `&gl=${gl}` : ""}&api_key=${encodeURIComponent(cred.apiKey)}`;
    const response = await tools.http.fetch(url);
    if (!response.ok) throw providerHttpStatusError(response, "SerpApi");
    const data = (await response.json()) as { organic_results?: Array<{ title?: string; link?: string; snippet?: string }> };
    const leads = (data.organic_results || [])
      .map((item) => webResultToLead(item.title || "", item.link || "", item.snippet || "", query))
      .filter((item): item is RawLead => Boolean(item));
    return providerPage(leads, { rawCount: data.organic_results?.length || 0 });
  },
  async health(cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://serpapi.com").replace(/\/+$/, "");
    const response = await tools.http.fetch(`${base}/account?api_key=${encodeURIComponent(cred.apiKey)}`);
    if (!response.ok) throw providerHttpStatusError(response, "SerpApi");
    const data = (await response.json().catch(() => ({}))) as { total_searches_left?: number; plan_searches_left?: number };
    const left = data.total_searches_left ?? data.plan_searches_left;
    return {
      ok: true,
      message: "SerpApi 连接通过",
      usage: usage(left !== undefined ? `剩余搜索额度 ${left}` : "")
    };
  }
});

// ---------------------------------------------------------------------------
// 公司库源：直接产出公司实体
// ---------------------------------------------------------------------------

const gleif = defineProvider({
  id: "gleif",
  name: "GLEIF 法人库",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company"],
  docsUrl: "https://www.gleif.org/en/lei-data/gleif-api",
  keyHint: "免费公开接口，无需 API Key。",
  defaultBaseUrl: "https://api.gleif.org/api/v1",
  costNote: "完全免费，覆盖全球有 LEI 的法人实体。",
  networkPolicy: {
    allowedHosts: ["api.gleif.org"],
    allowedPathPrefixes: ["/api/v1/"],
    allowedMethods: ["GET"]
  },
  async search({ query }, cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.gleif.org/api/v1").replace(/\/+$/, "");
    const q = companyQueryText(query);
    const response = await tools.http.fetch(`${base}/lei-records?filter[fulltext]=${encodeURIComponent(q)}&page[size]=${Math.min(query.limit, 15)}`, {
      headers: { accept: "application/vnd.api+json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "GLEIF");
    const data = (await response.json()) as { data?: Array<{ id?: string; attributes?: { lei?: string; entity?: { legalName?: { name?: string }; legalAddress?: { country?: string; city?: string } } } }> };
    const leads = (data.data || []).map((item): RawLead => {
      const entity = item.attributes?.entity;
      const lei = item.attributes?.lei || item.id || "";
      const city = entity?.legalAddress?.city || "";
      return {
        company: entity?.legalName?.name || "GLEIF Entity",
        officialWebsite: "",
        country: entity?.legalAddress?.country || firstToken(query.countries) || "未知",
        business: query.productKeywords.join(", ") || query.industries.join(", ") || "法人实体 / 待核实业务",
        contact: "待维护",
        contactInfo: "",
        description: `GLEIF 公开法人实体。${city ? `城市：${city}。` : ""}需继续核实官网、采购角色与产品匹配。`,
        confidence: 46,
        providerRecordId: lei,
        sourceUrl: lei ? `https://search.gleif.org/#/record/${lei}` : "",
        recordType: "identity_evidence",
        evidenceSummary: `GLEIF 法人身份记录${city ? `，注册地址城市 ${city}` : ""}`,
        matchedFields: ["company", "country"]
      };
    });
    return providerPage(leads, { rawCount: data.data?.length || 0 });
  },
  async health() {
    return { ok: true, message: "GLEIF 免费公开接口，内置可用，无需配置" };
  }
});

const wikidata = defineProvider({
  id: "wikidata",
  name: "Wikidata 公开实体",
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company"],
  docsUrl: "https://www.wikidata.org/w/api.php",
  keyHint: "免费公开接口，无需 API Key。",
  defaultBaseUrl: "https://www.wikidata.org/w/api.php",
  costNote: "完全免费，数据质量参差，作为兜底补充。",
  networkPolicy: {
    allowedHosts: ["www.wikidata.org"],
    allowedPathPrefixes: ["/w/api.php"],
    allowedMethods: ["GET"]
  },
  async search({ query }, cred, tools) {
    const base = cred.baseUrl || this.defaultBaseUrl || "https://www.wikidata.org/w/api.php";
    const q = companyQueryText(query);
    const response = await tools.http.fetch(`${base}?action=wbsearchentities&language=en&format=json&type=item&limit=${Math.min(query.limit, 15)}&search=${encodeURIComponent(q)}`, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "Wikidata");
    const data = (await response.json()) as { search?: Array<{ id?: string; label?: string; description?: string; concepturi?: string }> };
    const leads = (data.search || [])
      .filter((item) => item.label)
      .map((item): RawLead => ({
        company: item.label || "Wikidata Entity",
        officialWebsite: "",
        country: firstToken(query.countries) || "未知",
        business: query.productKeywords.join(", ") || query.industries.join(", ") || item.description || "公开实体 / 待核实业务",
        contact: "待维护",
        contactInfo: "",
        description: `Wikidata 公开实体：${item.description || "描述待补充"}。需继续核实官网与真实采购意向。`,
        confidence: 42,
        providerRecordId: item.id || "",
        sourceUrl: item.concepturi || (item.id ? `https://www.wikidata.org/wiki/${item.id}` : ""),
        recordType: "identity_evidence",
        evidenceSummary: `Wikidata 实体描述：${item.description || "待补充"}`,
        matchedFields: ["company", "description"]
      }));
    return providerPage(leads, { rawCount: data.search?.length || 0 });
  },
  async health() {
    return { ok: true, message: "Wikidata 免费公开接口，内置可用，无需配置" };
  }
});

const opencorporates = defineProvider({
  id: "opencorporates",
  name: "OpenCorporates",
  tier: "paid",
  category: "company",
  requiresKey: true,
  capabilities: ["company"],
  docsUrl: "https://api.opencorporates.com/documentation/API-Reference",
  keyHint: "在 opencorporates.com 申请 API Token 后填入。",
  defaultBaseUrl: "https://api.opencorporates.com/v0.4",
  costNote: "开放/商业混合，需申请 token，注意商用条款。",
  networkPolicy: {
    allowedHosts: ["api.opencorporates.com"],
    allowedPathPrefixes: ["/v0.4/"],
    allowedMethods: ["GET"]
  },
  async search({ query }, cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.opencorporates.com/v0.4").replace(/\/+$/, "");
    const q = companyQueryText(query);
    const response = await tools.http.fetch(`${base}/companies/search?q=${encodeURIComponent(q)}&per_page=${Math.min(query.limit, 15)}&api_token=${encodeURIComponent(cred.apiKey)}`);
    if (!response.ok) throw providerHttpStatusError(response, "OpenCorporates");
    const data = (await response.json()) as { results?: { companies?: Array<{ company?: { name?: string; company_number?: string; jurisdiction_code?: string; registered_address_in_full?: string; opencorporates_url?: string } }> } };
    const leads = (data.results?.companies || []).map((wrap): RawLead => {
      const c = wrap.company || {};
      const providerRecordId = [c.jurisdiction_code, c.company_number].filter(Boolean).join(":");
      return {
        company: c.name || "Company",
        officialWebsite: "",
        country: (c.jurisdiction_code || firstToken(query.countries) || "未知").toUpperCase(),
        business: query.productKeywords.join(", ") || query.industries.join(", ") || "工商注册实体 / 待核实业务",
        contact: "待维护",
        contactInfo: "",
        description: `OpenCorporates 注册记录：${c.registered_address_in_full || "地址待补充"}。注册号 ${c.company_number || "-"}。`,
        confidence: 50,
        providerRecordId,
        sourceUrl: c.opencorporates_url || "",
        recordType: "identity_evidence",
        evidenceSummary: `工商注册号 ${c.company_number || "待补充"}，辖区 ${c.jurisdiction_code || "待补充"}`,
        matchedFields: ["company", "country", "description"]
      };
    });
    return providerPage(leads, { rawCount: data.results?.companies?.length || 0 });
  },
  async health(cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.opencorporates.com/v0.4").replace(/\/+$/, "");
    const response = await tools.http.fetch(`${base}/companies/search?q=industrial%20product&per_page=1&api_token=${encodeURIComponent(cred.apiKey)}`);
    if (!response.ok) throw providerHttpStatusError(response, "OpenCorporates");
    return { ok: true, message: "OpenCorporates 连接通过" };
  }
});

const companiesHouse = defineProvider({
  id: "companies_house",
  name: "Companies House (UK)",
  tier: "byok_free",
  category: "company",
  requiresKey: true,
  capabilities: ["company"],
  docsUrl: "https://developer.company-information.service.gov.uk/",
  keyHint: "在英国 Companies House 开发者平台免费申请 API Key。",
  defaultBaseUrl: "https://api.company-information.service.gov.uk",
  costNote: "免费，仅覆盖英国注册公司。",
  networkPolicy: {
    allowedHosts: ["api.company-information.service.gov.uk"],
    allowedPathPrefixes: ["/"],
    allowedMethods: ["GET"]
  },
  async search({ query }, cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.company-information.service.gov.uk").replace(/\/+$/, "");
    const auth = "Basic " + Buffer.from(`${cred.apiKey}:`).toString("base64");
    const q = companyQueryText(query);
    const response = await tools.http.fetch(`${base}/search/companies?q=${encodeURIComponent(q)}&items_per_page=${Math.min(query.limit, 15)}`, {
      headers: { authorization: auth, accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "Companies House");
    const data = (await response.json()) as { items?: Array<{ title?: string; company_number?: string; address_snippet?: string; company_status?: string }> };
    const leads = (data.items || []).map((item): RawLead => ({
      company: item.title || "UK Company",
      officialWebsite: "",
      country: "United Kingdom",
      business: query.productKeywords.join(", ") || query.industries.join(", ") || "英国注册公司 / 待核实业务",
      contact: "待维护",
      contactInfo: "",
      description: `Companies House：${item.address_snippet || "地址待补充"}。状态 ${item.company_status || "-"}，注册号 ${item.company_number || "-"}。`,
      confidence: 52,
      providerRecordId: item.company_number || "",
      sourceUrl: item.company_number ? `https://find-and-update.company-information.service.gov.uk/company/${item.company_number}` : "",
      recordType: "identity_evidence",
      evidenceSummary: `英国公司注册号 ${item.company_number || "待补充"}，状态 ${item.company_status || "待补充"}`,
      matchedFields: ["company", "country", "description"]
    }));
    return providerPage(leads, { rawCount: data.items?.length || 0 });
  },
  async health(cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.company-information.service.gov.uk").replace(/\/+$/, "");
    const auth = "Basic " + Buffer.from(`${cred.apiKey}:`).toString("base64");
    const response = await tools.http.fetch(`${base}/search/companies?q=industrial%20product&items_per_page=1`, {
      headers: { authorization: auth, accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "Companies House");
    return { ok: true, message: "Companies House 连接通过（仅英国公司）" };
  }
});

const apollo = defineProvider({
  id: "apollo",
  name: "Apollo.io",
  tier: "paid",
  category: "company",
  requiresKey: true,
  capabilities: ["company", "email"],
  docsUrl: "https://docs.apollo.io/",
  keyHint: "在 Apollo 后台 Settings → Integrations → API 获取 Key。",
  defaultBaseUrl: "https://api.apollo.io",
  costNote: "付费，高质量 B2B 公司/联系人；注意额度与合规。",
  networkPolicy: {
    allowedHosts: ["api.apollo.io"],
    allowedPathPrefixes: ["/api/v1/", "/v1/"],
    allowedMethods: ["GET", "POST"]
  },
  async search({ query }, cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.apollo.io").replace(/\/+$/, "");
    const locations = query.countries.slice(0, 3);
    const keyword = [firstToken(query.productKeywords), firstToken(query.industries)].filter(Boolean).join(" ").trim();
    const response = await tools.http.fetch(`${base}/api/v1/mixed_companies/search`, {
      method: "POST",
      headers: { "x-api-key": cred.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        q_organization_name: keyword || undefined,
        organization_locations: locations.length ? locations : undefined,
        page: 1,
        per_page: Math.min(query.limit, 15)
      })
    });
    if (!response.ok) throw providerHttpStatusError(response, "Apollo");
    const data = (await response.json()) as { organizations?: ApolloOrg[]; accounts?: ApolloOrg[] };
    const orgs = [...(data.organizations || []), ...(data.accounts || [])];
    const leads = orgs.slice(0, query.limit).map((org): RawLead => ({
      company: org.name || "Company",
      officialWebsite: org.website_url || (org.primary_domain ? `https://${org.primary_domain}` : ""),
      country: org.country || firstToken(query.countries) || "未知",
      business: org.industry || query.productKeywords.join(", ") || query.industries.join(", ") || "待核实业务",
      contact: "待维护",
      contactInfo: org.primary_phone?.number || "",
      description: (org.short_description || "").slice(0, 240) || `${org.name || "该公司"} Apollo 组织资料。`,
      confidence: 72,
      providerRecordId: org.id || org.primary_domain || org.website_url || "",
      sourceUrl: "",
      recordType: "company_candidate",
      evidenceSummary: (org.short_description || `${org.name || "该公司"} Apollo 组织资料`).slice(0, 500),
      matchedFields: ["company", "officialWebsite", "country", "business", "contactInfo"]
    }));
    return providerPage(leads, { rawCount: orgs.length });
  },
  async health(cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.apollo.io").replace(/\/+$/, "");
    const response = await tools.http.fetch(`${base}/v1/auth/health`, {
      headers: { "x-api-key": cred.apiKey, accept: "application/json" }
    });
    if (!response.ok) throw providerHttpStatusError(response, "Apollo");
    return { ok: true, message: "Apollo 连接通过" };
  }
});

interface ApolloOrg {
  id?: string;
  name?: string;
  website_url?: string;
  primary_domain?: string;
  country?: string;
  industry?: string;
  short_description?: string;
  primary_phone?: { number?: string };
}

const peopledatalabs = defineProvider({
  id: "pdl",
  name: "People Data Labs",
  tier: "paid",
  category: "company",
  requiresKey: true,
  capabilities: ["company", "enrich"],
  docsUrl: "https://docs.peopledatalabs.com/",
  keyHint: "在 PDL 控制台获取 API Key。",
  defaultBaseUrl: "https://api.peopledatalabs.com/v5",
  costNote: "付费，公司/人员字段丰富，按匹配计费。",
  networkPolicy: {
    allowedHosts: ["api.peopledatalabs.com"],
    allowedPathPrefixes: ["/v5/"],
    allowedMethods: ["POST"]
  },
  async search({ query }, cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.peopledatalabs.com/v5").replace(/\/+$/, "");
    const must: Array<Record<string, unknown>> = [];
    const industry = firstToken(query.industries) || firstToken(query.productKeywords);
    const country = firstToken(query.countries);
    if (industry) must.push({ match: { industry: industry } });
    if (country) must.push({ match: { location_country: country.toLowerCase() } });
    const body = {
      query: { bool: { must: must.length ? must : [{ match_all: {} }] } },
      size: Math.min(query.limit, 15)
    };
    const response = await tools.http.fetch(`${base}/company/search`, {
      method: "POST",
      headers: { "X-Api-Key": cred.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw providerHttpStatusError(response, "PDL");
    const data = (await response.json()) as { data?: Array<{ id?: string; display_name?: string; name?: string; website?: string; location?: { country?: string }; industry?: string; summary?: string }> };
    const leads = (data.data || []).map((item): RawLead => ({
      company: item.display_name || item.name || "Company",
      officialWebsite: item.website ? `https://${item.website.replace(/^https?:\/\//, "")}` : "",
      country: item.location?.country || firstToken(query.countries) || "未知",
      business: item.industry || query.productKeywords.join(", ") || query.industries.join(", ") || "待核实业务",
      contact: "待维护",
      contactInfo: "",
      description: (item.summary || "").slice(0, 240) || `${item.display_name || item.name || "该公司"} PDL 公司资料。`,
      confidence: 70,
      providerRecordId: item.id || item.website || "",
      sourceUrl: "",
      recordType: "company_candidate",
      evidenceSummary: (item.summary || `${item.display_name || item.name || "该公司"} PDL 公司资料`).slice(0, 500),
      matchedFields: ["company", "officialWebsite", "country", "business"]
    }));
    return providerPage(leads, { rawCount: data.data?.length || 0 });
  },
  async health(cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.peopledatalabs.com/v5").replace(/\/+$/, "");
    const response = await tools.http.fetch(`${base}/company/search`, {
      method: "POST",
      headers: { "X-Api-Key": cred.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: { bool: { must: [{ match_all: {} }] } }, size: 1 })
    });
    if (!response.ok) throw providerHttpStatusError(response, "People Data Labs");
    return { ok: true, message: "People Data Labs 连接通过" };
  }
});

// ---------------------------------------------------------------------------
// 邮箱源：作用于已发现的域名，补全联系人/邮箱
// ---------------------------------------------------------------------------

const hunter = defineProvider({
  id: "hunter",
  name: "Hunter.io",
  tier: "paid",
  category: "email",
  requiresKey: true,
  capabilities: ["email", "enrich"],
  docsUrl: "https://hunter.io/api-documentation",
  keyHint: "在 hunter.io 后台获取 API Key（含少量免费额度）。",
  defaultBaseUrl: "https://api.hunter.io/v2",
  costNote: "找域名邮箱最直接，免费额度有限，超出付费。",
  networkPolicy: {
    allowedHosts: ["api.hunter.io"],
    allowedPathPrefixes: ["/v2/"],
    allowedMethods: ["GET"]
  },
  async search({ query }, cred, tools) {
    // Hunter 需要域名或公司名；这里以公司名（客户类型/行业组合）做一次示例查询。
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.hunter.io/v2").replace(/\/+$/, "");
    const company = firstToken(query.productKeywords) || firstToken(query.industries);
    if (!company) return providerPage([], { requestCount: 0 });
    const response = await tools.http.fetch(`${base}/domain-search?company=${encodeURIComponent(company)}&limit=${Math.min(query.limit, 10)}&api_key=${encodeURIComponent(cred.apiKey)}`);
    if (!response.ok) throw providerHttpStatusError(response, "Hunter");
    const data = (await response.json()) as HunterDomainResponse;
    const d = data.data;
    if (!d || !d.domain) return providerPage([]);
    const email = d.emails?.[0];
    return providerPage([{
        company: d.organization || companyFromDomain(d.domain),
        officialWebsite: `https://${d.domain}`,
        country: d.country || firstToken(query.countries) || "未知",
        business: query.productKeywords.join(", ") || query.industries.join(", ") || "待核实业务",
        contact: email ? `${email.first_name || ""} ${email.last_name || ""}`.trim() || "待维护" : "待维护",
        contactInfo: email?.value || "",
        description: `Hunter 域名邮箱发现：${d.domain}，找到 ${d.emails?.length || 0} 个公开邮箱。`,
        confidence: email ? 74 : 58,
        providerRecordId: email?.value ? `${d.domain}:${email.value.toLocaleLowerCase()}` : d.domain,
        sourceUrl: "",
        recordType: email ? "contact_evidence" : "company_candidate",
        evidenceSummary: `Hunter 域名记录，公开邮箱数量 ${d.emails?.length || 0}`,
        matchedFields: email
          ? ["company", "officialWebsite", "country", "contact", "contactInfo"]
          : ["company", "officialWebsite", "country"]
      }]);
  },
  async health(cred, tools) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.hunter.io/v2").replace(/\/+$/, "");
    const response = await tools.http.fetch(`${base}/account?api_key=${encodeURIComponent(cred.apiKey)}`);
    if (!response.ok) throw providerHttpStatusError(response, "Hunter");
    const data = (await response.json().catch(() => ({}))) as { data?: { requests?: { searches?: { available?: number; used?: number } } } };
    const searches = data.data?.requests?.searches;
    return {
      ok: true,
      message: "Hunter 连接通过",
      usage: usage(searches ? `本月搜索额度 ${searches.used ?? 0}/${searches.available ?? "-"}` : "")
    };
  },
  async enrich({ domain }, cred, tools) {
    const base = (cred.baseUrl || "https://api.hunter.io/v2").replace(/\/+$/, "");
    const response = await tools.http.fetch(`${base}/domain-search?domain=${encodeURIComponent(domain)}&limit=1&api_key=${encodeURIComponent(cred.apiKey)}`);
    if (!response.ok) throw providerHttpStatusError(response, "Hunter");
    const data = (await response.json()) as HunterDomainResponse;
    const email = data.data?.emails?.[0];
    if (!email?.value) return null;
    const verification = email.verification?.status || "";
    return {
      contact: `${email.first_name || ""} ${email.last_name || ""}`.trim() || undefined,
      contactInfo: email.value,
      officialWebsite: `https://${domain}`,
      sourceUrl: `${base}/domain-search?domain=${encodeURIComponent(domain)}&limit=1`,
      providerRecordId: `${domain}:${email.value.toLocaleLowerCase()}`,
      evidenceSummary: [
        `Hunter API 返回域名 ${domain} 的公开邮箱`,
        verification ? `验证状态 ${verification}` : ""
      ].filter(Boolean).join("；"),
      matchedFields: ["officialWebsite", "contact", "contactInfo"],
      confidence: typeof email.confidence === "number" ? email.confidence : undefined
    };
  }
});

interface HunterDomainResponse {
  data?: {
    domain?: string;
    organization?: string;
    country?: string;
    emails?: Array<{
      value?: string;
      first_name?: string;
      last_name?: string;
      position?: string;
      confidence?: number;
      verification?: { status?: string };
    }>;
  };
}

// ---------------------------------------------------------------------------

function countryToGl(country: string) {
  const map: Record<string, string> = {
    germany: "de", 德国: "de", uk: "gb", "united kingdom": "gb", 英国: "gb", 英格兰: "gb",
    turkey: "tr", 土耳其: "tr", india: "in", 印度: "in", uae: "ae", 阿联酋: "ae",
    usa: "us", 美国: "us", "united states": "us", france: "fr", 法国: "fr", italy: "it", 意大利: "it",
    spain: "es", 西班牙: "es", netherlands: "nl", 荷兰: "nl", poland: "pl", 波兰: "pl",
    russia: "ru", 俄罗斯: "ru", brazil: "br", 巴西: "br", mexico: "mx", 墨西哥: "mx",
    china: "cn", 中国: "cn", japan: "jp", 日本: "jp", korea: "kr", 韩国: "kr"
  };
  return map[country.trim().toLowerCase()] || "";
}

export const LEAD_PROVIDERS: LeadProvider[] = [
  serper,
  brave,
  serpapi,
  gleif,
  wikidata,
  EU_TED_PROVIDER,
  WORLD_BANK_PROCUREMENT_PROVIDER,
  UK_CONTRACTS_FINDER_PROVIDER,
  companiesHouse,
  opencorporates,
  SEC_EDGAR_PROVIDER,
  ...PUBLIC_COMPANY_PROVIDERS,
  ...PUBLIC_PROCUREMENT_PROVIDERS,
  ...ASSISTED_SOURCE_PROVIDERS,
  apollo,
  peopledatalabs,
  hunter
];

export const DEFAULT_LEAD_SEARCH_PROVIDER_IDS = [
  "gleif",
  "wikidata",
  "eu_ted",
  "world_bank_procurement",
  "fr_company_search",
  "usaspending_awards"
] as const;

const DEFAULT_LEAD_SEARCH_PROVIDER_ID_SET = new Set<string>(
  DEFAULT_LEAD_SEARCH_PROVIDER_IDS
);

export function getProvider(id: string): LeadProvider | undefined {
  return LEAD_PROVIDERS.find((item) => item.id === id);
}

export function providerMeta(provider: LeadProvider) {
  return {
    id: provider.id,
    name: provider.name,
    tier: provider.tier,
    category: provider.category,
    requiresKey: provider.requiresKey,
    capabilities: provider.capabilities,
    docsUrl: provider.docsUrl,
    keyHint: provider.keyHint,
    defaultBaseUrl: provider.defaultBaseUrl || "",
    costNote: provider.costNote,
    accessMode: provider.accessMode,
    recommended: DEFAULT_LEAD_SEARCH_PROVIDER_ID_SET.has(provider.id)
  };
}
