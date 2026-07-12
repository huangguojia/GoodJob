import type { LeadSourceTier } from "./types.js";
import { fetchPublicUrl } from "./outbound-security.js";

/**
 * 自动获客数据源适配层。
 *
 * 每个数据源实现统一的 LeadProvider 接口：
 * - search()：按获客条件返回候选公司（原始字段，后续由 server 统一去重、评分、落库）。
 * - test()：用用户填写的 API Key 做一次最小真实调用，验证“配上 key 就能用”。
 * - enrich()（可选）：邮箱/联系人补全，作用在已发现的域名上（Hunter 等）。
 *
 * 免费源（GLEIF/Wikidata）无需 key，内置可用；其余为“自带 key 即插即用”。
 */

export interface LeadQuery {
  goal: string;
  productKeywords: string;
  countries: string;
  industry: string;
  customerType: string;
  excludeKeywords: string;
  limit: number;
}

export interface ProviderCredential {
  apiKey: string;
  baseUrl?: string;
}

export interface RawLead {
  company: string;
  website?: string;
  country?: string;
  business?: string;
  contact?: string;
  contactInfo?: string;
  description?: string;
  confidence?: number;
}

export interface ProviderResult {
  leads: RawLead[];
  usage?: string;
  calls: number;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  usage?: string;
}

export interface LeadProvider {
  id: string;
  name: string;
  tier: LeadSourceTier;
  category: "web" | "company" | "email";
  requiresKey: boolean;
  capabilities: string[];
  docsUrl: string;
  keyHint: string;
  defaultBaseUrl?: string;
  costNote: string;
  search(query: LeadQuery, cred: ProviderCredential): Promise<ProviderResult>;
  test(cred: ProviderCredential): Promise<ProviderTestResult>;
  enrich?(domain: string, cred: ProviderCredential): Promise<{ contact?: string; contactInfo?: string } | null>;
}

const DEFAULT_TIMEOUT = 12000;

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetchPublicUrl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function firstToken(value: string) {
  return value.split(/,|，|\/|、/)[0]?.trim() || "";
}

function webQueryText(query: LeadQuery) {
  const exclude = query.excludeKeywords
    .split(/,|，/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `-${item}`)
    .join(" ");
  return [query.goal, query.productKeywords, query.industry, query.customerType, query.countries, exclude]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function companyQueryText(query: LeadQuery) {
  return [query.productKeywords, query.industry, query.customerType, query.countries]
    .map(firstToken)
    .filter(Boolean)
    .join(" ")
    .trim() || query.goal || "instrumentation supplier";
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

/** 判断某网页是否值得作为候选（过滤明显的目录/招聘/维基类站点）。 */
const NON_COMPANY_HOSTS = /wikipedia\.org|linkedin\.com|facebook\.com|youtube\.com|amazon\.|alibaba\.com|indeed\.|glassdoor\.|reddit\.com|quora\.com/i;

function webResultToLead(title: string, link: string, snippet: string, query: LeadQuery): RawLead | null {
  if (!link) return null;
  if (NON_COMPANY_HOSTS.test(link)) return null;
  const domain = domainFromUrl(link);
  const company = (title || "").split(/[-|｜–—]/)[0].trim() || companyFromDomain(domain);
  return {
    company: company.slice(0, 120),
    website: `https://${domain}`,
    country: firstToken(query.countries) || "未知",
    business: (snippet || query.productKeywords || query.industry || "").slice(0, 160) || "待核实业务",
    contact: "待维护",
    contactInfo: "",
    description: (snippet || "").slice(0, 240),
    confidence: 62
  };
}

// ---------------------------------------------------------------------------
// Web 搜索源：产出公司官网 URL，交给 server 端官网解析补全字段
// ---------------------------------------------------------------------------

const serper: LeadProvider = {
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
  async search(query, cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://google.serper.dev").replace(/\/+$/, "");
    const gl = countryToGl(firstToken(query.countries));
    const response = await fetchWithTimeout(`${base}/search`, {
      method: "POST",
      headers: { "X-API-KEY": cred.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ q: webQueryText(query), num: Math.min(query.limit, 20), gl, hl: "en" })
    });
    if (!response.ok) throw new Error(`Serper HTTP ${response.status}`);
    const data = (await response.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
    const leads = (data.organic || [])
      .map((item) => webResultToLead(item.title || "", item.link || "", item.snippet || "", query))
      .filter((item): item is RawLead => Boolean(item));
    return { leads, calls: 1 };
  },
  async test(cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://google.serper.dev").replace(/\/+$/, "");
    const response = await fetchWithTimeout(`${base}/search`, {
      method: "POST",
      headers: { "X-API-KEY": cred.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ q: "industrial instrument supplier", num: 1 })
    });
    if (response.status === 401 || response.status === 403) return { ok: false, message: "API Key 无效或未授权" };
    if (!response.ok) return { ok: false, message: `连接失败：HTTP ${response.status}` };
    return { ok: true, message: "Serper 连接通过，可用于 Web 搜客" };
  }
};

const brave: LeadProvider = {
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
  async search(query, cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.search.brave.com/res/v1").replace(/\/+$/, "");
    const country = countryToGl(firstToken(query.countries)).toUpperCase();
    const url = `${base}/web/search?q=${encodeURIComponent(webQueryText(query))}&count=${Math.min(query.limit, 20)}${country ? `&country=${country}` : ""}`;
    const response = await fetchWithTimeout(url, {
      headers: { "X-Subscription-Token": cred.apiKey, accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Brave HTTP ${response.status}`);
    const data = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    const leads = (data.web?.results || [])
      .map((item) => webResultToLead(item.title || "", item.url || "", item.description || "", query))
      .filter((item): item is RawLead => Boolean(item));
    const remaining = response.headers.get("X-RateLimit-Remaining") || "";
    return { leads, calls: 1, usage: remaining ? `本月剩余额度约 ${remaining}` : undefined };
  },
  async test(cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.search.brave.com/res/v1").replace(/\/+$/, "");
    const response = await fetchWithTimeout(`${base}/web/search?q=instrument%20supplier&count=1`, {
      headers: { "X-Subscription-Token": cred.apiKey, accept: "application/json" }
    });
    if (response.status === 401 || response.status === 422) return { ok: false, message: "Subscription Token 无效" };
    if (!response.ok) return { ok: false, message: `连接失败：HTTP ${response.status}` };
    const remaining = response.headers.get("X-RateLimit-Remaining") || "";
    return { ok: true, message: "Brave Search 连接通过", usage: remaining ? `剩余额度约 ${remaining}` : undefined };
  }
};

const serpapi: LeadProvider = {
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
  async search(query, cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://serpapi.com").replace(/\/+$/, "");
    const gl = countryToGl(firstToken(query.countries));
    const url = `${base}/search.json?engine=google&q=${encodeURIComponent(webQueryText(query))}&num=${Math.min(query.limit, 20)}${gl ? `&gl=${gl}` : ""}&api_key=${encodeURIComponent(cred.apiKey)}`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`SerpApi HTTP ${response.status}`);
    const data = (await response.json()) as { organic_results?: Array<{ title?: string; link?: string; snippet?: string }> };
    const leads = (data.organic_results || [])
      .map((item) => webResultToLead(item.title || "", item.link || "", item.snippet || "", query))
      .filter((item): item is RawLead => Boolean(item));
    return { leads, calls: 1 };
  },
  async test(cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://serpapi.com").replace(/\/+$/, "");
    const response = await fetchWithTimeout(`${base}/account?api_key=${encodeURIComponent(cred.apiKey)}`);
    if (response.status === 401) return { ok: false, message: "API Key 无效" };
    if (!response.ok) return { ok: false, message: `连接失败：HTTP ${response.status}` };
    const data = (await response.json().catch(() => ({}))) as { total_searches_left?: number; plan_searches_left?: number };
    const left = data.total_searches_left ?? data.plan_searches_left;
    return { ok: true, message: "SerpApi 连接通过", usage: left !== undefined ? `剩余搜索额度 ${left}` : undefined };
  }
};

// ---------------------------------------------------------------------------
// 公司库源：直接产出公司实体
// ---------------------------------------------------------------------------

const gleif: LeadProvider = {
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
  async search(query, cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.gleif.org/api/v1").replace(/\/+$/, "");
    const q = companyQueryText(query);
    const response = await fetchWithTimeout(`${base}/lei-records?filter[fulltext]=${encodeURIComponent(q)}&page[size]=${Math.min(query.limit, 15)}`, {
      headers: { accept: "application/vnd.api+json" }
    });
    if (!response.ok) throw new Error(`GLEIF HTTP ${response.status}`);
    const data = (await response.json()) as { data?: Array<{ id?: string; attributes?: { lei?: string; entity?: { legalName?: { name?: string }; legalAddress?: { country?: string; city?: string } } } }> };
    const leads = (data.data || []).map((item): RawLead => {
      const entity = item.attributes?.entity;
      const lei = item.attributes?.lei || item.id || "";
      const city = entity?.legalAddress?.city || "";
      return {
        company: entity?.legalName?.name || "GLEIF Entity",
        website: lei ? `https://search.gleif.org/#/record/${lei}` : "https://search.gleif.org/",
        country: entity?.legalAddress?.country || firstToken(query.countries) || "未知",
        business: query.productKeywords || query.industry || "法人实体 / 待核实业务",
        contact: "待维护",
        contactInfo: "",
        description: `GLEIF 公开法人实体。${city ? `城市：${city}。` : ""}需继续核实官网、采购角色与产品匹配。`,
        confidence: 46
      };
    });
    return { leads, calls: 1 };
  },
  async test() {
    return { ok: true, message: "GLEIF 免费公开接口，内置可用，无需配置" };
  }
};

const wikidata: LeadProvider = {
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
  async search(query, cred) {
    const base = cred.baseUrl || this.defaultBaseUrl || "https://www.wikidata.org/w/api.php";
    const q = companyQueryText(query);
    const response = await fetchWithTimeout(`${base}?action=wbsearchentities&language=en&format=json&type=item&limit=${Math.min(query.limit, 15)}&search=${encodeURIComponent(q)}`, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);
    const data = (await response.json()) as { search?: Array<{ id?: string; label?: string; description?: string; concepturi?: string }> };
    const leads = (data.search || [])
      .filter((item) => item.label)
      .map((item): RawLead => ({
        company: item.label || "Wikidata Entity",
        website: item.concepturi || (item.id ? `https://www.wikidata.org/wiki/${item.id}` : "https://www.wikidata.org/"),
        country: firstToken(query.countries) || "未知",
        business: query.productKeywords || query.industry || item.description || "公开实体 / 待核实业务",
        contact: "待维护",
        contactInfo: "",
        description: `Wikidata 公开实体：${item.description || "描述待补充"}。需继续核实官网与真实采购意向。`,
        confidence: 42
      }));
    return { leads, calls: 1 };
  },
  async test() {
    return { ok: true, message: "Wikidata 免费公开接口，内置可用，无需配置" };
  }
};

const opencorporates: LeadProvider = {
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
  async search(query, cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.opencorporates.com/v0.4").replace(/\/+$/, "");
    const q = companyQueryText(query);
    const response = await fetchWithTimeout(`${base}/companies/search?q=${encodeURIComponent(q)}&per_page=${Math.min(query.limit, 15)}&api_token=${encodeURIComponent(cred.apiKey)}`);
    if (!response.ok) throw new Error(`OpenCorporates HTTP ${response.status}`);
    const data = (await response.json()) as { results?: { companies?: Array<{ company?: { name?: string; company_number?: string; jurisdiction_code?: string; registered_address_in_full?: string; opencorporates_url?: string } }> } };
    const leads = (data.results?.companies || []).map((wrap): RawLead => {
      const c = wrap.company || {};
      return {
        company: c.name || "Company",
        website: c.opencorporates_url || "",
        country: (c.jurisdiction_code || firstToken(query.countries) || "未知").toUpperCase(),
        business: query.productKeywords || query.industry || "工商注册实体 / 待核实业务",
        contact: "待维护",
        contactInfo: "",
        description: `OpenCorporates 注册记录：${c.registered_address_in_full || "地址待补充"}。注册号 ${c.company_number || "-"}。`,
        confidence: 50
      };
    });
    return { leads, calls: 1 };
  },
  async test(cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.opencorporates.com/v0.4").replace(/\/+$/, "");
    const response = await fetchWithTimeout(`${base}/companies/search?q=instrument&per_page=1&api_token=${encodeURIComponent(cred.apiKey)}`);
    if (response.status === 401 || response.status === 403) return { ok: false, message: "API Token 无效或未授权" };
    if (!response.ok) return { ok: false, message: `连接失败：HTTP ${response.status}` };
    return { ok: true, message: "OpenCorporates 连接通过" };
  }
};

const companiesHouse: LeadProvider = {
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
  async search(query, cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.company-information.service.gov.uk").replace(/\/+$/, "");
    const auth = "Basic " + Buffer.from(`${cred.apiKey}:`).toString("base64");
    const q = companyQueryText(query);
    const response = await fetchWithTimeout(`${base}/search/companies?q=${encodeURIComponent(q)}&items_per_page=${Math.min(query.limit, 15)}`, {
      headers: { authorization: auth, accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Companies House HTTP ${response.status}`);
    const data = (await response.json()) as { items?: Array<{ title?: string; company_number?: string; address_snippet?: string; company_status?: string }> };
    const leads = (data.items || []).map((item): RawLead => ({
      company: item.title || "UK Company",
      website: item.company_number ? `https://find-and-update.company-information.service.gov.uk/company/${item.company_number}` : "",
      country: "United Kingdom",
      business: query.productKeywords || query.industry || "英国注册公司 / 待核实业务",
      contact: "待维护",
      contactInfo: "",
      description: `Companies House：${item.address_snippet || "地址待补充"}。状态 ${item.company_status || "-"}，注册号 ${item.company_number || "-"}。`,
      confidence: 52
    }));
    return { leads, calls: 1 };
  },
  async test(cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.company-information.service.gov.uk").replace(/\/+$/, "");
    const auth = "Basic " + Buffer.from(`${cred.apiKey}:`).toString("base64");
    const response = await fetchWithTimeout(`${base}/search/companies?q=instrument&items_per_page=1`, {
      headers: { authorization: auth, accept: "application/json" }
    });
    if (response.status === 401) return { ok: false, message: "API Key 无效" };
    if (!response.ok) return { ok: false, message: `连接失败：HTTP ${response.status}` };
    return { ok: true, message: "Companies House 连接通过（仅英国公司）" };
  }
};

const apollo: LeadProvider = {
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
  async search(query, cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.apollo.io").replace(/\/+$/, "");
    const locations = query.countries.split(/,|，/).map((item) => item.trim()).filter(Boolean).slice(0, 3);
    const keyword = [firstToken(query.productKeywords), firstToken(query.industry)].filter(Boolean).join(" ").trim();
    const response = await fetchWithTimeout(`${base}/api/v1/mixed_companies/search`, {
      method: "POST",
      headers: { "x-api-key": cred.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        q_organization_name: keyword || undefined,
        organization_locations: locations.length ? locations : undefined,
        page: 1,
        per_page: Math.min(query.limit, 15)
      })
    });
    if (!response.ok) throw new Error(`Apollo HTTP ${response.status}`);
    const data = (await response.json()) as { organizations?: ApolloOrg[]; accounts?: ApolloOrg[] };
    const orgs = [...(data.organizations || []), ...(data.accounts || [])];
    const leads = orgs.slice(0, query.limit).map((org): RawLead => ({
      company: org.name || "Company",
      website: org.website_url || (org.primary_domain ? `https://${org.primary_domain}` : ""),
      country: org.country || firstToken(query.countries) || "未知",
      business: org.industry || query.productKeywords || query.industry || "待核实业务",
      contact: "待维护",
      contactInfo: org.primary_phone?.number || "",
      description: (org.short_description || "").slice(0, 240) || `${org.name || "该公司"} Apollo 组织资料。`,
      confidence: 72
    }));
    return { leads, calls: 1 };
  },
  async test(cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.apollo.io").replace(/\/+$/, "");
    const response = await fetchWithTimeout(`${base}/v1/auth/health`, {
      headers: { "x-api-key": cred.apiKey, accept: "application/json" }
    });
    if (response.status === 401) return { ok: false, message: "API Key 无效" };
    if (!response.ok) return { ok: false, message: `连接失败：HTTP ${response.status}` };
    return { ok: true, message: "Apollo 连接通过" };
  }
};

interface ApolloOrg {
  name?: string;
  website_url?: string;
  primary_domain?: string;
  country?: string;
  industry?: string;
  short_description?: string;
  primary_phone?: { number?: string };
}

const peopledatalabs: LeadProvider = {
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
  async search(query, cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.peopledatalabs.com/v5").replace(/\/+$/, "");
    const must: Array<Record<string, unknown>> = [];
    const industry = firstToken(query.industry) || firstToken(query.productKeywords);
    const country = firstToken(query.countries);
    if (industry) must.push({ match: { industry: industry } });
    if (country) must.push({ match: { location_country: country.toLowerCase() } });
    const body = {
      query: { bool: { must: must.length ? must : [{ match_all: {} }] } },
      size: Math.min(query.limit, 15)
    };
    const response = await fetchWithTimeout(`${base}/company/search`, {
      method: "POST",
      headers: { "X-Api-Key": cred.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`PDL HTTP ${response.status}`);
    const data = (await response.json()) as { data?: Array<{ display_name?: string; name?: string; website?: string; location?: { country?: string }; industry?: string; summary?: string }> };
    const leads = (data.data || []).map((item): RawLead => ({
      company: item.display_name || item.name || "Company",
      website: item.website ? `https://${item.website.replace(/^https?:\/\//, "")}` : "",
      country: item.location?.country || firstToken(query.countries) || "未知",
      business: item.industry || query.productKeywords || query.industry || "待核实业务",
      contact: "待维护",
      contactInfo: "",
      description: (item.summary || "").slice(0, 240) || `${item.display_name || item.name || "该公司"} PDL 公司资料。`,
      confidence: 70
    }));
    return { leads, calls: 1 };
  },
  async test(cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.peopledatalabs.com/v5").replace(/\/+$/, "");
    const response = await fetchWithTimeout(`${base}/company/search`, {
      method: "POST",
      headers: { "X-Api-Key": cred.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: { bool: { must: [{ match_all: {} }] } }, size: 1 })
    });
    if (response.status === 401) return { ok: false, message: "API Key 无效" };
    if (response.status === 402) return { ok: true, message: "Key 有效，但账户额度受限（HTTP 402）" };
    if (!response.ok) return { ok: false, message: `连接失败：HTTP ${response.status}` };
    return { ok: true, message: "People Data Labs 连接通过" };
  }
};

// ---------------------------------------------------------------------------
// 邮箱源：作用于已发现的域名，补全联系人/邮箱
// ---------------------------------------------------------------------------

const hunter: LeadProvider = {
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
  async search(query, cred) {
    // Hunter 需要域名或公司名；这里以公司名（客户类型/行业组合）做一次示例查询。
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.hunter.io/v2").replace(/\/+$/, "");
    const company = firstToken(query.productKeywords) || firstToken(query.industry);
    if (!company) return { leads: [], calls: 0 };
    const response = await fetchWithTimeout(`${base}/domain-search?company=${encodeURIComponent(company)}&limit=${Math.min(query.limit, 10)}&api_key=${encodeURIComponent(cred.apiKey)}`);
    if (!response.ok) throw new Error(`Hunter HTTP ${response.status}`);
    const data = (await response.json()) as HunterDomainResponse;
    const d = data.data;
    if (!d || !d.domain) return { leads: [], calls: 1 };
    const email = d.emails?.[0];
    return {
      leads: [{
        company: d.organization || companyFromDomain(d.domain),
        website: `https://${d.domain}`,
        country: d.country || firstToken(query.countries) || "未知",
        business: query.productKeywords || query.industry || "待核实业务",
        contact: email ? `${email.first_name || ""} ${email.last_name || ""}`.trim() || "待维护" : "待维护",
        contactInfo: email?.value || "",
        description: `Hunter 域名邮箱发现：${d.domain}，找到 ${d.emails?.length || 0} 个公开邮箱。`,
        confidence: email ? 74 : 58
      }],
      calls: 1
    };
  },
  async test(cred) {
    const base = (cred.baseUrl || this.defaultBaseUrl || "https://api.hunter.io/v2").replace(/\/+$/, "");
    const response = await fetchWithTimeout(`${base}/account?api_key=${encodeURIComponent(cred.apiKey)}`);
    if (response.status === 401) return { ok: false, message: "API Key 无效" };
    if (!response.ok) return { ok: false, message: `连接失败：HTTP ${response.status}` };
    const data = (await response.json().catch(() => ({}))) as { data?: { requests?: { searches?: { available?: number; used?: number } } } };
    const searches = data.data?.requests?.searches;
    return {
      ok: true,
      message: "Hunter 连接通过",
      usage: searches ? `本月搜索额度 ${searches.used ?? 0}/${searches.available ?? "-"}` : undefined
    };
  },
  async enrich(domain, cred) {
    const base = (cred.baseUrl || "https://api.hunter.io/v2").replace(/\/+$/, "");
    try {
      const response = await fetchWithTimeout(`${base}/domain-search?domain=${encodeURIComponent(domain)}&limit=1&api_key=${encodeURIComponent(cred.apiKey)}`);
      if (!response.ok) return null;
      const data = (await response.json()) as HunterDomainResponse;
      const email = data.data?.emails?.[0];
      if (!email?.value) return null;
      return {
        contact: `${email.first_name || ""} ${email.last_name || ""}`.trim() || undefined,
        contactInfo: email.value
      };
    } catch {
      return null;
    }
  }
};

interface HunterDomainResponse {
  data?: {
    domain?: string;
    organization?: string;
    country?: string;
    emails?: Array<{ value?: string; first_name?: string; last_name?: string; position?: string }>;
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
  companiesHouse,
  opencorporates,
  apollo,
  peopledatalabs,
  hunter
];

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
    costNote: provider.costNote
  };
}
