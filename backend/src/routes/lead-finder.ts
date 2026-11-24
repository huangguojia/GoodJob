/**
 * AI 搜客（Lead Finder / Lfind）路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import { aiEngineFallbackAdapters, engineCliProfile, readTeamAiEngineSettings, type AiEngineAdapter } from "../ai-engine-settings.js";
import { applyCliProfileToPrompt } from "../ai-engine-service.js";
import type { Express } from "express";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { canSeeOwner, requireAuth } from "../auth.js";
import { callAiModel, extractJsonObject } from "../ai-model-runtime.js";
import { aiWebSearchPolicy, webSearchFailureSuggestion } from "../ai-web-search-policy.js";
import { createAiSearchProvider } from "../ai-search-provider.js";
import { type Customer, type ExtractedWebsiteContact, type Lead, type ProviderCatalogItem, type ProviderConnection, type ProviderEvidenceSnapshot, type SessionUser, type WebsiteOpportunity } from "../types.js";
import { createCredentialRef, encryptProviderConfiguration } from "../credential-security.js";
import { getLocalRunnerService } from "../integrations/integration-runtime.js";
import { getStore } from "../store.js";
import { DEFAULT_LEAD_SEARCH_PROVIDER_IDS, getProvider, LEAD_PROVIDERS, type LeadQuery, type RawLead } from "../lead-providers.js";
import { getTradeProvider } from "../trade-providers.js";
import { ProviderContractError, type ProviderErrorCode, providerErrorFromUnknown, type ProviderRecord } from "../provider-contract.js";
import { assertProviderBaseUrlAllowed } from "../provider-http-client.js";
import { providerRequestFingerprint } from "../provider-request-logging.js";
import { launchLeadFinder, launchLeadFinderSchema } from "../lead-finder-launch.js";
import { createProviderExecutionContext, executeProviderHealth, executeProviderPreflight, executeProviderSearch, providerRequiresKey } from "../provider-runtime.js";
import { contactChannelsFromText } from "../prospect-contact-enrichment.js";
import { prospectRunIdempotencyKeySchema } from "../prospect-runs.js";
import { withProspectVerificationReport } from "../prospect-verification.js";
import {
  aiSearchStatus,
  allProviderStatuses,
  asyncRoute,
  configSupportsUseCase,
  getAiConfig,
  getProviderConnection,
  mergeProviderEvidence,
  normalizeCrmCompanyName,
  normalizeProviderCountry,
  normalizeWebsite,
  persistCandidateChanges,
  persistProviderOpportunities,
  providerCatalogByCode,
  providerEvidenceSnapshot,
  readProviderConnectionConfiguration,
  scheduleContactEnrichment,
  sendProspectCampaignError,
  setProspectRunEtag,
  synchronizeProspectQueue,
  websiteDomainKey
} from "../server-core.js";

const leadFinderSearchSchema = z.object({
  productKeywords: z.string().default(""),
  countries: z.string().default(""),
  industry: z.string().default(""),
  customerType: z.string().default(""),
  goal: z.string().default(""),
  limit: z.number().min(1).max(30).default(10)
});

function emailsFromText(value: string) {
  return [...new Set((value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) || [])
    .map((item) => item.toLocaleLowerCase("en-US")))];
}

function crmCandidateEmails(candidate: Pick<WebsiteOpportunity, "contactInfo" | "contact" | "description">) {
  return new Set(emailsFromText([
    candidate.contactInfo,
    candidate.contact,
    candidate.description
  ].filter(Boolean).join(" ")));
}

function crmWebsiteDomains(values: string[]) {
  return new Set(values
    .map((value) => websiteDomainKey(value))
    .filter((value) => value && value.includes(".")));
}

function sameKnownCompany(
  candidateName: string,
  candidateCountry: string,
  existingName: string,
  existingCountry: string
) {
  const leftName = normalizeCrmCompanyName(candidateName);
  const rightName = normalizeCrmCompanyName(existingName);
  if (!leftName || !rightName || leftName !== rightName) return false;
  const leftCountry = normalizeProviderCountry(candidateCountry);
  const rightCountry = normalizeProviderCountry(existingCountry);
  if (leftCountry && rightCountry) return leftCountry === rightCountry;
  return leftName.length >= 8;
}

function existingCrmCustomerMatch(
  candidate: WebsiteOpportunity,
  customer: Customer
) {
  if (candidate.teamId !== customer.teamId) return "";
  const candidateDomains = crmWebsiteDomains([
    candidate.website,
    ...(candidate.sourceEvidence || []).flatMap((item) => [
      item.officialWebsite,
      item.sourceUrl
    ])
  ]);
  const customerDomains = crmWebsiteDomains([
    customer.website || ""
  ]);
  if ([...candidateDomains].some((domain) => customerDomains.has(domain))) {
    return "官网域名已在客户库";
  }
  const candidateEmails = crmCandidateEmails(candidate);
  const customerEmails = new Set(emailsFromText([
    customer.email || "",
    customer.contactRemark || "",
    customer.documentContact || ""
  ].join(" ")));
  if ([...candidateEmails].some((email) => customerEmails.has(email))) {
    return "联系邮箱已在客户库";
  }
  const customerNames = [
    customer.company,
    customer.companyFullName || "",
    customer.billingName || ""
  ].filter(Boolean);
  if (customerNames.some((name) =>
    sameKnownCompany(candidate.company, candidate.country, name, customer.country)
  )) {
    return "公司名称与国家已在客户库";
  }
  return "";
}

function existingCrmLeadMatch(
  candidate: WebsiteOpportunity,
  lead: Lead
) {
  if (candidate.teamId !== lead.teamId || lead.deletedAt || lead.status === "invalid") return "";
  const candidateDomains = crmWebsiteDomains([
    candidate.website,
    ...(candidate.sourceEvidence || []).flatMap((item) => [
      item.officialWebsite,
      item.sourceUrl
    ])
  ]);
  const leadDomains = crmWebsiteDomains([lead.sourceUrl || ""]);
  if ([...candidateDomains].some((domain) => leadDomains.has(domain))) {
    return "官网域名已在线索库";
  }
  const candidateEmails = crmCandidateEmails(candidate);
  const leadEmails = new Set(emailsFromText([
    lead.email,
    lead.remark,
    lead.inquiryContent || ""
  ].join(" ")));
  if ([...candidateEmails].some((email) => leadEmails.has(email))) {
    return "联系邮箱已在线索库";
  }
  if (sameKnownCompany(candidate.company, candidate.country, lead.company, lead.country)) {
    return "公司名称与国家已在线索库";
  }
  return "";
}

function filterExistingCrmOpportunities(
  opportunities: WebsiteOpportunity[],
  store: ReturnType<typeof getStore>,
  teamId: string
) {
  const filtered: WebsiteOpportunity[] = [];
  const skipped: Array<{ company: string; reason: string }> = [];
  const customers = store.customers.filter((item) => item.teamId === teamId);
  const leads = store.leads.filter((item) => item.teamId === teamId);
  for (const opportunity of opportunities) {
    const customerReason = customers
      .map((customer) => existingCrmCustomerMatch(opportunity, customer))
      .find(Boolean);
    if (customerReason) {
      skipped.push({ company: opportunity.company, reason: customerReason });
      continue;
    }
    const leadReason = leads
      .map((lead) => existingCrmLeadMatch(opportunity, lead))
      .find(Boolean);
    if (leadReason) {
      skipped.push({ company: opportunity.company, reason: leadReason });
      continue;
    }
    filtered.push(opportunity);
  }
  return { opportunities: filtered, skipped };
}

function recordProviderPreflightFailure(
  user: SessionUser,
  runId: string,
  providerId: string,
  errorCode: ProviderErrorCode,
  endpointCode: string
) {
  const requestedAt = new Date().toISOString();
  const normalizedProviderId = providerId.trim().slice(0, 64) || "unknown";
  getStore().providerRequestLogs.unshift({
    id: `prl_${randomUUID()}`,
    teamId: user.teamId,
    ownerId: user.id,
    providerId: normalizedProviderId,
    connectionId: "",
    runId,
    runShardId: `${runId}_${normalizedProviderId}`,
    requestFingerprint: providerRequestFingerprint({ providerId: normalizedProviderId, endpointCode, errorCode }),
    endpointCode,
    httpStatus: 0,
    attempt: 1,
    quotaUnits: 0,
    costAmount: 0,
    currency: "",
    durationMs: 0,
    responseSize: 0,
    errorCode: errorCode.toLocaleLowerCase(),
    requestedAt
  });
}

function providerConnectionConfiguration(connection?: ProviderConnection) {
  return readProviderConnectionConfiguration(connection).configuration;
}

function publicLeadSourceConfig(connection: ProviderConnection) {
  const connectionRead = readProviderConnectionConfiguration(connection);
  const configuration = connectionRead.configuration;
  return {
    id: connection.id,
    provider: connection.providerId,
    scope: connection.scope,
    apiKey: configuration.apiKey ? `****${configuration.apiKey.slice(-4)}` : "",
    hasApiKey: Boolean(configuration.apiKey),
    baseUrl: configuration.baseUrl,
    enabled: connection.status === "active" && connectionRead.readable,
    lastTestAt: connection.lastHealthAt,
    lastTestStatus: connectionRead.readable ? connection.lastHealthStatus : "failed",
    lastTestMessage: connectionRead.readable ? connection.lastHealthMessage : "连接凭据不可读取，请重新保存",
    usage: connection.usage,
    updatedAt: connection.updatedAt
  };
}

function publicProviderCatalogItem(item: ProviderCatalogItem) {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    category: item.category,
    sourceLevel: item.sourceLevel,
    accessMode: item.accessMode,
    baseUrl: item.baseUrl,
    officialDocsUrl: item.officialDocsUrl,
    capabilities: item.capabilities,
    allowedFields: item.allowedFields,
    fieldAuthority: item.fieldAuthority || {},
    licensePolicy: item.licensePolicy,
    defaultRatePolicy: item.defaultRatePolicy,
    retentionPolicy: item.retentionPolicy,
    status: item.status,
    version: item.version,
    reviewedAt: item.reviewedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function getConfigurableProvider(id: string) {
  return getProvider(id) || getTradeProvider(id);
}

const leadSearchSchema = z.object({
  goal: z.string().default(""),
  productKeywords: z.string().default(""),
  countries: z.string().default(""),
  industry: z.string().default(""),
  customerType: z.string().default(""),
  excludeKeywords: z.string().default(""),
  sources: z.array(z.string().trim().min(1).max(64).regex(/^[a-z0-9_]+$/i)).max(64).default([]),
  useAi: z.boolean().default(false),
  // 自动流可选每次找 10 / 20 / 30 / 50 家（旧上限 30，Lfind 内部再截到 20，实际常常只回 9 家）
  limit: z.number().min(1).max(50).default(12)
});

const lfindSourceSchema = z.object({
  url: z.string().trim().max(1200).default(""),
  title: z.string().trim().max(300).default(""),
  evidence: z.string().trim().max(1600).default(""),
  fields: z.array(z.string().trim().max(60)).max(20).default([])
}).passthrough();

/**
 * CLI 的「来源可信度」用词与后端契约不是一套词汇表：
 * 单个来源写 official / registry / reputable_directory，整份报告却要求
 * official_confirmed / multi_source_supported …。模型很自然会把单个来源的词
 * 直接搬到报告级字段上（2026-11-22 实测 7/20 家写成 registry），
 * 而 z.enum 一遇到不认识的词就抛错 —— 整份 57KB、20 家公司的结果被一起判死，
 * 前端只显示「格式不对」，看上去像第一步又崩了。
 *
 * 这里的处理原则与 skipped（数字/数组都接受）一致：**能收敛就收敛，不为一个标签丢整批数据。**
 */
function lfindAliasKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

/** 单个来源的可信度 → 契约枚举（未知一律降到 weak，不阻断） */
function lfindSourceAuthenticity(value: unknown) {
  const aliases: Record<string, "official" | "registry" | "reputable_directory" | "search_result" | "weak"> = {
    official: "official",
    official_website: "official",
    official_site: "official",
    company_website: "official",
    official_confirmed: "official",
    registry: "registry",
    registry_record: "registry",
    government_registry: "registry",
    official_registry: "registry",
    companies_house: "registry",
    government: "registry",
    reputable_directory: "reputable_directory",
    directory: "reputable_directory",
    chamber_of_commerce: "reputable_directory",
    trade_association: "reputable_directory",
    search_result: "search_result",
    search: "search_result",
    web_search: "search_result",
    third_party: "search_result",
    weak: "weak",
    unknown: "weak"
  };
  return aliases[lfindAliasKey(value)] ?? "weak";
}

/** 报告级可信度 → 契约枚举。registry/official 都算「官方确认」；目录/搜索结果算单来源 */
function lfindSourceAuthenticityOverall(value: unknown) {
  const aliases: Record<string, "official_confirmed" | "multi_source_supported" | "single_source_supported" | "weak" | "unknown"> = {
    official: "official_confirmed",
    official_confirmed: "official_confirmed",
    registry: "official_confirmed",
    official_registry: "official_confirmed",
    government_registry: "official_confirmed",
    government: "official_confirmed",
    multi_source_supported: "multi_source_supported",
    multi_source: "multi_source_supported",
    corroborated: "multi_source_supported",
    multiple_sources: "multi_source_supported",
    single_source_supported: "single_source_supported",
    single_source: "single_source_supported",
    search_result: "single_source_supported",
    reputable_directory: "single_source_supported",
    directory: "single_source_supported",
    weak: "weak",
    unknown: "unknown"
  };
  return aliases[lfindAliasKey(value)] ?? "unknown";
}

const lfindSearchReportSourceSchema = z.object({
  url: z.string().trim().max(1200).default(""),
  title: z.string().trim().max(300).default(""),
  authenticity: z.preprocess(lfindSourceAuthenticity, z.enum(["official", "registry", "reputable_directory", "search_result", "weak"]).default("weak")),
  verifiedFields: z.array(z.string().trim().max(60)).max(20).default([]),
  finding: z.string().trim().max(1200).default("")
}).passthrough();

const lfindSearchReportSchema = z.object({
  summary: z.string().trim().max(1600).default(""),
  sourceAuthenticity: z.preprocess(
    lfindSourceAuthenticityOverall,
    z.enum(["official_confirmed", "multi_source_supported", "single_source_supported", "weak", "unknown"]).default("unknown")
  ),
  verifiedFields: z.array(z.string().trim().max(60)).max(30).default([]),
  checkedSources: z.array(lfindSearchReportSourceSchema).max(20).default([]),
  contactFinding: z.object({
    status: z.preprocess(
      (value) => {
        const aliases: Record<string, "source_confirmed" | "missing" | "conflicting" | "unverified"> = {
          source_confirmed: "source_confirmed",
          confirmed: "source_confirmed",
          found: "source_confirmed",
          verified: "source_confirmed",
          missing: "missing",
          not_found: "missing",
          none: "missing",
          conflicting: "conflicting",
          conflict: "conflicting",
          disputed: "conflicting",
          unverified: "unverified",
          unknown: "unverified"
        };
        return aliases[lfindAliasKey(value)] ?? "unverified";
      },
      z.enum(["source_confirmed", "missing", "conflicting", "unverified"]).default("unverified")
    ),
    value: z.string().trim().max(320).default(""),
    sourceUrl: z.string().trim().max(1200).default("")
  }).passthrough().default({}),
  nextAction: z.string().trim().max(1000).default("")
}).passthrough();

/** 数字字段容错："20"、"85%"、20.4 都能收；实在解析不出用兜底值，不阻断整份结果 */
function lfindNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/gu, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function lfindInt(value: unknown, fallback = 0) {
  return Math.max(0, Math.trunc(lfindNumber(value, fallback)));
}

export const lfindResultSchema = z.object({
  // 契约版本是固定的：模型写成 1.0 / v1 都按同一份结构解析，不为一句话丢整批
  version: z.preprocess(() => "goodjob-lfind-v1", z.literal("goodjob-lfind-v1").default("goodjob-lfind-v1")),
  summary: z.object({
    target: z.string().trim().max(500).default(""),
    markets: z.array(z.string().trim().max(100)).max(30).default([]),
    products: z.array(z.string().trim().max(120)).max(30).default([]),
    customerType: z.string().trim().max(160).default(""),
    rawFound: z.preprocess((value) => lfindInt(value, 0), z.number().int().min(0).default(0)),
    accepted: z.preprocess((value) => lfindInt(value, 0), z.number().int().min(0).default(0)),
    skipped: z.preprocess((value) => lfindInt(value, 0), z.number().int().min(0).default(0)),
    noResultReason: z.string().trim().max(1000).default("")
  }).passthrough().default({}),
  opportunities: z.array(z.object({
    company: z.string().trim().min(1).max(240),
    business: z.string().trim().max(800).default("待维护"),
    country: z.string().trim().max(120).default("未知"),
    website: z.string().trim().max(1200).default(""),
    contact: z.string().trim().max(160).default(""),
    contactInfo: z.string().trim().max(320).default(""),
    description: z.string().trim().max(3000).default(""),
    confidence: z.preprocess((value) => Math.min(100, Math.max(0, lfindNumber(value, 55))), z.number().default(55)),
    qualification: z.preprocess(
      (value) => {
        const aliases: Record<string, "worth_following" | "review_needed" | "low_fit"> = {
          worth_following: "worth_following",
          qualified: "worth_following",
          high: "worth_following",
          fit: "worth_following",
          review_needed: "review_needed",
          review: "review_needed",
          needs_review: "review_needed",
          medium: "review_needed",
          low_fit: "low_fit",
          low: "low_fit",
          not_fit: "low_fit",
          reject: "low_fit",
          excluded: "low_fit"
        };
        return aliases[lfindAliasKey(value)] ?? "review_needed";
      },
      z.enum(["worth_following", "review_needed", "low_fit"]).default("review_needed")
    ),
    uncertainPoints: z.array(z.string().trim().max(400)).max(12).default([]),
    searchReport: lfindSearchReportSchema.optional(),
    sources: z.array(lfindSourceSchema).max(20).default([])
  }).passthrough()).max(100).default([]),
  // ⚠️ CLI 经常把「被跳过条数」直接写成数字（summary.skipped 就是数字），这里必须容忍：
  // 以前严格要求数组，模型一写数字就 422 把整份已跑出来的结果全判死，
  // 自动流于是每点一次「继续运行」就失败一次（2026-11-09 卡死事故的根因）。
  skipped: z.preprocess((value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      const count = Math.max(0, Math.min(200, Math.trunc(value)));
      return Array.from({ length: count }, () => ({
        company: "",
        reason: "other",
        detail: "CLI 只返回了跳过数量，未给出逐条明细",
        sourceUrl: ""
      }));
    }
    if (value == null) return [];
    return value;
  }, z.array(z.object({
    company: z.string().trim().max(240).default(""),
    reason: z.string().trim().max(80).default("other"),
    detail: z.string().trim().max(1000).default(""),
    sourceUrl: z.string().trim().max(1200).default("")
  }).passthrough()).max(200).default([])),
  failures: z.array(z.object({
    stage: z.string().trim().max(80).default("verification"),
    reason: z.string().trim().max(1000).default(""),
    suggestion: z.string().trim().max(1000).default("")
  }).passthrough()).max(50).default([])
}).passthrough();

type LfindResult = z.infer<typeof lfindResultSchema>;

function lfindHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * 搜索目标数量（发给 CLI 的 quantity target）。
 *
 * 2026-11-22：查重名录彻底移出提示词。原因是它根本不需要待在对话里 ——
 *   1) 客户库 / 线索库：结果回来先过 filterExistingCrmOpportunities（域名、邮箱、公司名+国家）；
 *   2) 历史候选池：persistProviderOpportunities 用 isSameProviderOpportunity 合并证据，不新增重复行。
 * 两处都是确定性规则，不依赖模型"自觉跳过"。名录唯一的旧作用是省 CLI 的搜索预算，
 * 代价却是把 2 万～3.5 万字符塞进每次对话（2026-11-22 因此整单被 Runner 拒掉）。
 * 现在改成后端去重，代价是重复率上升，所以把目标量放大 60%（上限 50）来补偿净新增。
 */
export function lfindTargetCount(limit: number) {
  return Math.min(50, Math.max(1, Math.ceil(limit * 1.6)));
}

export function lfindPrompt(input: z.infer<typeof leadSearchSchema>) {
  const target = lfindTargetCount(input.limit);
  return [
    "Use $lfind.",
    "Run a GoodJob Lfind public-source overseas B2B prospect discovery task.",
    "Return only the final JSON object following goodjob-lfind-v1. No markdown fences, no explanations after JSON.",
    "",
    "Execution discipline (important):",
    "- This environment has no built-in web search. Use the goodjob_browser controlled browser (Playwright tools) for ALL public web lookups; it is the only search channel.",
    "- If a search engine blocks you (reCAPTCHA, consent wall, 429), do NOT investigate or repair the browser. Immediately switch to a different engine or query (e.g. Bing, DuckDuckGo, Google with different wording) and continue.",
    "- Spend at most 2 minutes total on browser troubleshooting of any kind. Guard the total budget: finish within 25 minutes and start writing the final JSON by minute 22 at the latest.",
    "- If time runs short, return fewer candidates (even zero) with a valid JSON object and explain in summary/failures. An empty opportunities array with valid schema is a successful outcome; a timeout with no output is not.",
    `- Quantity target: aim for ${target} accepted candidates. Do not stop after the first handful; keep widening queries (more cities, synonyms, distributor/importer/integrator directories, trade-show exhibitor lists, association member lists) until you reach the target or the time budget. Work in batches and keep the JSON valid at every point.`,
    "",
    "GoodJob search request:",
    JSON.stringify({
      goal: input.goal,
      productKeywords: input.productKeywords,
      countries: input.countries,
      industry: input.industry,
      customerType: input.customerType,
      excludeKeywords: input.excludeKeywords,
      limit: target
    }, null, 2),
    "",
    "Deduplication is handled downstream by the CRM, not by you. Report every company that matches the request above and has credible public evidence; do NOT pre-filter against companies you guess may already be in our database, and do NOT shorten the list to avoid duplicates. The CRM will match your results against its customer, lead, and earlier-candidate records by official domain, public email, and company name plus country, then merge or drop the duplicates.",
    "",
    "Quality requirements:",
    "- Keep only overseas companies with credible public source evidence.",
    "- Do not invent official domains or contacts.",
    "- Accepted candidates must include a source-backed email, phone, or WhatsApp value in contactInfo.",
    "- Contact values must appear in cited public source evidence. If no source-backed contact is found, move the company to skipped with reason no_contact and list the checked sources.",
    "- Every accepted candidate must include searchReport with source authenticity, checked source URLs, verified fields, contact source status, and next action.",
    "- For every skipped or failed item, explain the concrete reason.",
    "- If available sources are not enough, return empty opportunities and fill failures with adjustment advice."
  ].join("\n");
}

/**
 * Excel 名单导入的识别指令。
 *
 * 用户传的表格是任意版式（中英文表头、合并单元格、多个 sheet），交给本机 CLI 读文件后
 * 输出同一份 goodjob-lfind-v1 契约 —— 后端复用现成的解析、查重、入池与证据合并链路，
 * 不新增第二套导入格式。
 */
function excelImportPrompt(filePath: string, originalName: string) {
  return [
    "Use your local tools (python/openpyxl, csv reader, or any available reader) to READ this spreadsheet file:",
    filePath,
    `Original file name: ${originalName}`,
    "",
    "It is a user-supplied prospect list in an ARBITRARY layout: Chinese or English headers, merged cells, several sheets, extra notes. Read every sheet and every data row.",
    "Return ONLY the final JSON object following goodjob-lfind-v1. No markdown fences, no explanations after JSON.",
    "",
    "Rules:",
    "- One opportunity per company row. Skip rows without a company name.",
    "- Map whatever columns mean: company name, country, website, contact person, email, phone/WhatsApp, business/notes. Column order is not fixed; match by header meaning, and fall back to cell shape (e.g. a cell containing @ is an email).",
    "- contactInfo = all emails / phones / WhatsApp values found in that row, joined by \" | \". contact = contact person name, or the first email when there is no person name.",
    "- sources: exactly ONE entry per opportunity: {\"url\":\"file://" + filePath.replace(/"/g, "") + "\",\"title\":\"Excel 导入：" + originalName.replace(/"/g, "") + "\",\"evidence\":\"the raw cell text of that row (trimmed)\",\"fields\":[only the fields actually present, e.g. \"company\",\"email\",\"phone\",\"website\"]}",
    "- NEVER invent data, never look anything up on the web, never enrich. Use only what the file contains.",
    "- If the same company appears more than once in the file, merge them into one opportunity.",
    "- summary: target = the import file name, rawFound = number of data rows read, accepted = opportunities.length, skipped = number of skipped rows.",
    "- skipped[] entries: {company, reason, detail, sourceUrl:\"\"} for rows without a company name or unreadable rows.",
    "- confidence: 90 when an email is present, 70 when only phone/WhatsApp, 50 otherwise.",
    "- If the file cannot be read at all, still return valid JSON with zero opportunities and a failures[] entry explaining the concrete reason."
  ].join("\n");
}

async function lfindRunnerPlan(user: SessionUser, preferredAdapter: AiEngineAdapter = "workbuddy") {
  const service = getLocalRunnerService();
  if (!service) return {
    configured: false,
    message: "当前数据库运行模式未启用本地 Runner 服务",
    suggestion: "请使用 MySQL 版服务，并在集成中心完成 GoodJob Runner 配对。",
    service: null,
    runner: null
  };
  try {
    const runners = await service.runners(user);
    // 引擎无关：codex（旧 Codex CLI）与 workbuddy（WorkBuddy CLI）都按同一份
    // goodjob-lfind-v1 JSON 契约执行，任务派发只看 prompt + workspace。
    // 优先挑具备团队首选 CLI 的 Runner；没有再退到具备另一个 CLI 的 Runner
    const candidates = runners.filter((item) =>
      item.online
      && (item.capabilities.includes("codex") || item.capabilities.includes("workbuddy"))
      && item.workspaces.length
    );
    const runner = candidates.find((item) => item.capabilities.includes(preferredAdapter)) || candidates[0] || null;
    return runner ? {
      configured: true,
      message: `已选择 ${runner.displayName} 执行 Lfind 深入查询`,
      suggestion: "",
      service,
      runner
    } : {
      configured: false,
      message: "没有可用的在线 CLI Runner",
      suggestion: "请在集成中心启动并配对 GoodJob Runner，确认本机 CLI 显示在线，并授权一个工作目录。",
      service,
      runner: null
    };
  } catch (error) {
    return {
      configured: false,
      message: error instanceof Error ? `Runner 状态读取失败：${error.message}` : "Runner 状态读取失败",
      suggestion: "请检查集成中心、本地 Runner 进程和网络连接。",
      service,
      runner: null
    };
  }
}

function lfindEvidenceSnapshot(
  taskId: string,
  opportunity: LfindResult["opportunities"][number],
  source: LfindResult["opportunities"][number]["sources"][number],
  index: number,
  providerId = "lfind"
): ProviderEvidenceSnapshot {
  const payloadHash = lfindHash({
    company: opportunity.company,
    country: opportunity.country,
    website: opportunity.website,
    url: source.url,
    evidence: source.evidence
  });
  const matchedFields = [...new Set(source.fields.length ? source.fields : [
    "identity",
    ...(opportunity.website ? ["website"] : []),
    "business",
    ...(opportunity.contactInfo ? ["contact"] : [])
  ])];
  return {
    providerId,
    providerRecordId: `${providerId}:${lfindHash({
      company: opportunity.company,
      country: opportunity.country,
      website: opportunity.website
    }).slice(0, 32)}:${index}`,
    officialWebsite: normalizeWebsite(opportunity.website || ""),
    sourceUrl: normalizeWebsite(source.url || opportunity.website || ""),
    recordType: "public_source_research",
    fetchedAt: new Date().toISOString(),
    payloadHash,
    evidenceSummary: source.evidence || source.title || "Lfind public source evidence",
    matchedFields,
    adapterVersion: "lfind-skill-v1",
    catalogPolicyVersion: "goodjob-lfind-v1",
    sourceLevel: "assisted",
    fieldAuthority: Object.fromEntries(matchedFields.map((field) => [
      field,
      field === "contact" ? "corroborated" : "assisted"
    ])),
    retentionPolicyRef: "public_source_reference"
  };
}

/**
 * sources[].fields 里哪些标记算「这条来源承载了联系方式」。
 *
 * 🔴 CLI 很少写 "contact"，实际给的是 email / phone / whatsapp。2026-11-09 巴西那次：
 * 12 家候选全带 vendas@xxx.com.br + 电话，fields 写的是 ['company','address','phone','email','website']，
 * 旧逻辑只认 "contact" → 12 家全被判「没有来源支持的联系方式」→ 获客节点失败、入池 0 条。
 * 这是「明明搜到了却运行不起来」的第二个根因。
 */
const LFIND_CONTACT_FIELDS = new Set(["contact", "email", "phone", "tel", "telephone", "whatsapp"]);

function lfindSourceCarriesContact(
  source: { fields: string[]; evidence: string },
  contactInfo: string
) {
  if ((source.fields || []).some((field) => LFIND_CONTACT_FIELDS.has(String(field).toLowerCase()))) return true;
  const info = String(contactInfo || "").trim();
  if (!info) return false;
  return String(source.evidence || "").toLocaleLowerCase("en-US").includes(info.toLocaleLowerCase("en-US"));
}

function lfindContactEvidence(
  opportunity: LfindResult["opportunities"][number],
  sourceLabel: string
): ExtractedWebsiteContact[] {
  if (!opportunity.contactInfo) return [];
  const channels = contactChannelsFromText(opportunity.contactInfo);
  if (!channels.emails.length && !channels.phones.length) return [];
  const contactSource = opportunity.sources.find((source) => lfindSourceCarriesContact(source, opportunity.contactInfo));
  if (!contactSource?.url) return [];
  return [{
    kind: opportunity.contact ? "person" : "company",
    name: opportunity.contact || opportunity.company,
    title: opportunity.contact ? "公开联系人" : "公司公开联系",
    emails: channels.emails,
    phones: channels.phones,
    whatsapp: [],
    source: "lfind",
    sourceLabel,
    sourceKind: "local_runner",
    confidence: Math.max(50, Math.min(80, opportunity.confidence)),
    verificationStatus: "source_confirmed",
    observedAt: new Date().toISOString(),
    reasonCodes: ["LFIND_PUBLIC_SOURCE_CONTACT"],
    evidenceExcerpt: contactSource.evidence,
    corroboratedSources: [{
      sourceId: "lfind",
      sourceLabel,
      evidenceUrl: normalizeWebsite(contactSource.url)
    }],
    evidenceUrl: normalizeWebsite(contactSource.url)
  }];
}

function lfindOpportunityHasSourceBackedContact(
  opportunity: LfindResult["opportunities"][number],
  sourceLabel: string
) {
  return lfindContactEvidence(opportunity, sourceLabel).length > 0;
}

function lfindSearchReportFromResultOpportunity(
  opportunity: LfindResult["opportunities"][number],
  sourceLabel: string
): NonNullable<WebsiteOpportunity["searchReport"]> {
  const supplied = opportunity.searchReport;
  const contactEvidence = lfindContactEvidence(opportunity, sourceLabel);
  const verifiedFields = [...new Set([
    ...(supplied?.verifiedFields || []),
    ...opportunity.sources.flatMap((source) => source.fields || []),
    ...(opportunity.website ? ["website"] : []),
    ...(contactEvidence.length ? ["contact"] : [])
  ].filter(Boolean))];
  const checkedSources = (supplied?.checkedSources?.length
    ? supplied.checkedSources
    : opportunity.sources.map((source) => ({
        url: source.url,
        title: source.title,
        authenticity: (source.url && normalizeWebsite(source.url) === normalizeWebsite(opportunity.website || ""))
          ? "official" as const
          : "search_result" as const,
        verifiedFields: source.fields || [],
        finding: source.evidence || source.title || "公开来源记录"
      }))
  ).map((source) => ({
    url: normalizeWebsite(source.url || ""),
    title: source.title || source.url || "公开来源",
    authenticity: source.authenticity || "weak",
    verifiedFields: [...new Set(source.verifiedFields?.length ? source.verifiedFields : verifiedFields)],
    finding: source.finding || "公开来源记录"
  }));
  const officialSource = checkedSources.some((source) => source.authenticity === "official");
  const sourceAuthenticity = supplied?.sourceAuthenticity && supplied.sourceAuthenticity !== "unknown"
    ? supplied.sourceAuthenticity
    : officialSource
      ? "official_confirmed"
      : checkedSources.length >= 2
        ? "multi_source_supported"
        : checkedSources.length === 1
          ? "single_source_supported"
          : "unknown";
  const contactSource = contactEvidence[0]?.corroboratedSources?.[0]?.evidenceUrl || "";
  const summary = supplied?.summary || [
    checkedSources.length ? `已核验 ${checkedSources.length} 个公开来源` : "暂无可核验来源",
    verifiedFields.length ? `确认字段：${verifiedFields.join("、")}` : "",
    contactEvidence.length ? "联系方式有公开来源支撑" : "未取得可用联系方式"
  ].filter(Boolean).join("；");
  return {
    summary,
    sourceAuthenticity,
    verifiedFields,
    checkedSources,
    contactFinding: {
      status: contactEvidence.length ? "source_confirmed" : supplied?.contactFinding?.status || "missing",
      value: contactEvidence.length ? opportunity.contactInfo : supplied?.contactFinding?.value || "",
      sourceUrl: contactSource || supplied?.contactFinding?.sourceUrl || ""
    },
    nextAction: supplied?.nextAction || (contactEvidence.length
      ? "可打开来源链接复核后加入搜客清单"
      : "需补充公开联系方式来源后再跟进")
  };
}

function lfindOpportunitiesFromResult(
  parsed: LfindResult,
  taskId: string,
  user: SessionUser,
  sourceLabel: string,
  options: { providerId?: string; idPrefix?: string } = {}
) {
  const providerId = options.providerId || "lfind";
  const idPrefix = options.idPrefix || "lf_lfind";
  return parsed.opportunities.flatMap((item, index): WebsiteOpportunity[] => {
    if (!item.sources.length) return [];
    const website = normalizeWebsite(item.website || "");
    const sourceEvidence = item.sources.map((source, sourceIndex) =>
      lfindEvidenceSnapshot(taskId, item, source, sourceIndex, providerId)
    );
    const uncertain = item.uncertainPoints.length
      ? ` 待复核：${item.uncertainPoints.join("；")}`
      : "";
    return [withProspectVerificationReport({
      id: `${idPrefix}_${lfindHash({ taskId, company: item.company, index }).slice(0, 24)}`,
      company: item.company,
      business: item.business || "待维护",
      country: item.country || "未知",
      website,
      contact: item.contact || "待维护",
      contactInfo: item.contactInfo || "",
      description: item.description || `Lfind 深入查询候选。${uncertain}`.trim(),
      ownerId: user.id,
      teamId: user.teamId,
      status: "preview",
      createdAt: new Date().toISOString(),
      parseMode: "ai",
      source: providerId,
      sourceLabel,
      sourceEvidence,
      extractedContacts: lfindContactEvidence(item, sourceLabel),
      searchReport: lfindSearchReportFromResultOpportunity(item, sourceLabel),
      confidence: item.confidence
    })];
  });
}

/**
 * 同一个 lfind 任务可能被重复同步（搜客页与自动流页同时轮询、页面刷新后重查）。
 * 第二次 persist 时，上一轮新增的候选已经存在，全部会变成「未变化」——如果直接按
 * unchanged 过滤就会返回空，前端会误报「没有候选」。这里按 taskId 缓存第一次算出的
 * 「本轮有效候选（新增或有新证据）」id，保证同一任务多次同步结果稳定。
 * 进程重启后缓存丢失属于可接受退化：最多把整批当成有效候选返回一次。
 */
const lfindRunCandidateIds = new Map<string, string[]>();

function lfindRunCacheKey(user: SessionUser, taskId: string) {
  // 带 teamId：taskId 虽随机，但缓存不该跨团队复用（多团队共用一套进程时会串）
  return `${user.teamId}:${taskId}`;
}

function lfindRunCandidateIdsFor(
  user: SessionUser,
  taskId: string,
  persistence: ReturnType<typeof persistProviderOpportunities>
) {
  const key = lfindRunCacheKey(user, taskId);
  const cached = lfindRunCandidateIds.get(key);
  if (cached) return new Set(cached);
  const ids = persistence.opportunities
    .filter((item) => !persistence.unchangedIds.has(item.id))
    .map((item) => item.id);
  lfindRunCandidateIds.set(key, ids);
  if (lfindRunCandidateIds.size > 200) {
    const oldest = lfindRunCandidateIds.keys().next().value;
    if (oldest) lfindRunCandidateIds.delete(oldest);
  }
  return new Set(ids);
}

async function syncLfindTaskResult(user: SessionUser, taskId: string) {
  const plan = await lfindRunnerPlan(user);
  if (!plan.service) {
    throw Object.assign(new Error(plan.message), {
      status: 503,
      code: "LFIND_RUNNER_UNAVAILABLE",
      suggestion: plan.suggestion
    });
  }
  const detail = await plan.service.task(user, taskId);
  if (detail.task.status !== "succeeded") {
    return {
      task: detail.task,
      events: detail.events,
      synced: false,
      opportunities: [] as WebsiteOpportunity[],
      incrementalStats: null,
      skipped: [] as Array<{ company: string; reason: string }>,
      lfind: null as LfindResult | null
    };
  }
  const parsed = lfindResultSchema.parse(extractJsonObject(detail.task.resultText));
  const sourceLabel = `Lfind Skill · ${detail.task.id.slice(-8)}`;
  const contactReadyOpportunities = parsed.opportunities.filter((item) =>
    lfindOpportunityHasSourceBackedContact(item, sourceLabel)
  );
  const contactSkipped = parsed.opportunities
    .filter((item) => !lfindOpportunityHasSourceBackedContact(item, sourceLabel))
    .map((item) => ({
      company: item.company || "未命名候选",
      reason: "no_contact",
      detail: `未找到来源支持的公开邮箱、电话或 WhatsApp；已核验来源：${item.sources.map((source) => source.url || source.title).filter(Boolean).join("；") || "无可用来源"}`,
      sourceUrl: item.sources[0]?.url || item.website || ""
    }));
  const normalizedLfind = {
    ...parsed,
    opportunities: contactReadyOpportunities,
    skipped: [...parsed.skipped, ...contactSkipped],
    summary: {
      ...parsed.summary,
      accepted: contactReadyOpportunities.length,
      skipped: (parsed.summary.skipped || parsed.skipped.length) + contactSkipped.length,
      noResultReason: contactReadyOpportunities.length
        ? parsed.summary.noResultReason
        : parsed.summary.noResultReason || "没有找到带公开联系方式来源的可跟进候选"
    }
  };
  const rawOpportunities = lfindOpportunitiesFromResult(normalizedLfind, detail.task.id, user, sourceLabel);
  const store = getStore();
  const existingFilter = filterExistingCrmOpportunities(rawOpportunities, store, user.teamId);
  await store.reloadProspectCandidates?.();
  const persistence = persistProviderOpportunities(existingFilter.opportunities, {
    rawCount: parsed.summary.rawFound || parsed.opportunities.length,
    deduplicatedCount: Math.max(0, parsed.summary.rawFound - parsed.opportunities.length),
    existingFilteredCount: existingFilter.skipped.length
  });
  await persistCandidateChanges(store, persistence.opportunities, true);
  // 只把「本轮新增 / 有新证据」的候选交回前端：历史候选已经背调过、也可能已经写过信，
  // 再当成本轮候选会把它们重复送进第 2、3 步。查重不再依赖 CLI 看名录，而由这里确定性地拦。
  const hasCachedRun = lfindRunCandidateIds.has(lfindRunCacheKey(user, taskId));
  const runCandidateIds = lfindRunCandidateIdsFor(user, taskId, persistence);
  // 任务完成很久之后的重查（页面刷新 + 后端重启导致缓存丢失）：此时整批都会算「未变化」，
  // 若仍按 fresh 过滤就会返回空、被前端误报成「没有候选」。这种场景保持旧行为，返回完整列表。
  const finishedAt = Date.parse(detail.task.finishedAt || "");
  const isLateResync = !hasCachedRun
    && Number.isFinite(finishedAt)
    && finishedAt > 0
    && Date.now() - finishedAt > 10 * 60_000;
  const runOpportunities = isLateResync
    ? persistence.opportunities
    : persistence.opportunities.filter((item) => runCandidateIds.has(item.id));
  const duplicateHistory = persistence.opportunities
    .filter((item) => persistence.unchangedIds.has(item.id))
    .slice(0, 12)
    .map((item) => ({
      company: item.company,
      reason: "历史候选重复：已合并证据，不再重复背调/写信"
    }));
  const runId = `lfind_${taskId}`;
  for (const candidateId of runOpportunities.slice(0, 8).map((item) => item.id)) {
    void scheduleContactEnrichment(user, candidateId, runId);
  }
  return {
    task: detail.task,
    events: detail.events,
    synced: true,
    opportunities: runOpportunities,
    incrementalStats: persistence.incrementalStats,
    skipped: [
      ...existingFilter.skipped,
      ...duplicateHistory,
      ...parsed.skipped.map((item) => ({
        company: item.company || "未命名候选",
        reason: item.detail || item.reason
      })),
      ...contactSkipped.map((item) => ({
        company: item.company,
        reason: item.detail || item.reason
      }))
    ],
    lfind: normalizedLfind
  };
}

export function registerLeadFinderRoutes(app: Express) {
  app.post("/api/lead-finder/free-search", requireAuth, asyncRoute(async (req, res) => {
    const body = leadFinderSearchSchema.parse(req.body);
    const store = getStore();
    const user = req.user!;
    const limit = Math.min(body.limit, 12);
    const runId = `prun_free_${randomUUID()}`;
    const query: LeadQuery = {
      ...body,
      excludeKeywords: "",
      limit: Math.ceil(limit / 2)
    };
    const providerIds = [
      "gleif",
      "wikidata",
      "eu_ted",
      "world_bank_procurement",
      "uk_contracts_finder"
    ];
    const sourceStats: Array<{
      id: string;
      name: string;
      count: number;
      status: string;
      error?: string;
      errorCode?: string;
      retryable?: boolean;
      retryAfterAt?: string | null;
    }> = [];
    const pages = await Promise.all(providerIds.map(async (providerId) => {
      const provider = getProvider(providerId);
      const catalog = providerCatalogByCode(providerId);
      if (!provider || !catalog) {
        recordProviderPreflightFailure(user, runId, providerId, "PROVIDER_CATALOG_MISSING", "free_search");
        sourceStats.push({
          id: providerId,
          name: provider?.name || providerId,
          count: 0,
          status: "failed",
          error: "数据源目录缺失",
          errorCode: "PROVIDER_CATALOG_MISSING",
          retryable: false,
          retryAfterAt: null
        });
        return { providerId, records: [] as ProviderRecord[] };
      }
      try {
        const page = await executeProviderSearch({
          provider,
          catalog,
          context: createProviderExecutionContext({
            teamId: user.teamId,
            ownerId: user.id,
            runId,
            providerId,
            operation: "search",
            purpose: "legacy_free_search"
          }),
          credential: { apiKey: "", baseUrl: "" },
          query,
          onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
        });
        sourceStats.push({
          id: providerId,
          name: catalog.name || provider.name,
          count: page.records.length,
          status: page.status
        });
        return { providerId, records: page.records };
      } catch (error) {
        const failure = providerErrorFromUnknown(error, "search");
        sourceStats.push({
          id: providerId,
          name: catalog.name || provider.name,
          count: 0,
          status: "failed",
          error: failure.publicMessage,
          errorCode: failure.code,
          retryable: failure.retryable,
          retryAfterAt: failure.retryAfterAt
        });
        return { providerId, records: [] as ProviderRecord[] };
      }
    }));
    const mergedRecords: Array<ProviderRecord & { source: string; sourceEvidence: ProviderEvidenceSnapshot[] }> = [];
    const mergedByKey = new Map<string, (typeof mergedRecords)[number]>();
    for (const page of pages) {
      for (const record of page.records) {
        const domain = websiteDomainKey(record.officialWebsite || record.website || "");
        const strongKey = record.providerRecordId
          ? `${page.providerId}:id:${record.providerRecordId}`
          : record.payloadHash
            ? `${page.providerId}:hash:${record.payloadHash}`
            : "";
        const domainKey = domain ? `domain:${domain}` : "";
        const existing = [strongKey, domainKey]
          .filter(Boolean)
          .map((key) => mergedByKey.get(key))
          .find(Boolean);
        const evidence = providerEvidenceSnapshot(page.providerId, record);
        if (existing) {
          existing.sourceEvidence = mergeProviderEvidence(existing.sourceEvidence, [evidence]);
          if (!existing.officialWebsite && record.officialWebsite) {
            existing.officialWebsite = record.officialWebsite;
            existing.website = record.officialWebsite;
          }
          if (!existing.contactInfo && record.contactInfo) existing.contactInfo = record.contactInfo;
          if ((!existing.contact || existing.contact === "待维护") && record.contact) existing.contact = record.contact;
          existing.confidence = Math.max(existing.confidence || 0, record.confidence || 0);
          if (strongKey) mergedByKey.set(strongKey, existing);
          if (domainKey) mergedByKey.set(domainKey, existing);
          continue;
        }
        const mergedRecord = {
          ...record,
          source: page.providerId,
          sourceEvidence: [evidence]
        };
        mergedRecords.push(mergedRecord);
        if (strongKey) mergedByKey.set(strongKey, mergedRecord);
        if (domainKey) mergedByKey.set(domainKey, mergedRecord);
      }
    }
    const merged: WebsiteOpportunity[] = mergedRecords.slice(0, limit).map((record) =>
      withProspectVerificationReport({
        id: `lf_${record.source}_${randomUUID()}`,
        company: record.company,
        business: record.business || "待维护",
        country: record.country || "未知",
        website: normalizeWebsite(record.officialWebsite || record.website || ""),
        contact: record.contact || "待维护",
        contactInfo: record.contactInfo || "",
        description: record.description || record.evidenceSummary || "公开来源候选，待核实。",
        ownerId: user.id,
        teamId: user.teamId,
        status: "preview",
        createdAt: new Date().toISOString(),
        parseMode: "rule",
        source: record.source,
        sourceLabel: getProvider(record.source)?.name || record.source,
        sourceEvidence: record.sourceEvidence,
        confidence: record.confidence
      })
    );
    await store.reloadProspectCandidates?.();
    const persistence = persistProviderOpportunities(merged, {
      rawCount: pages.reduce((sum, page) => sum + page.records.length, 0),
      deduplicatedCount: Math.max(0, pages.reduce((sum, page) => sum + page.records.length, 0) - mergedRecords.length)
    });
    await persistCandidateChanges(
      store,
      persistence.opportunities,
      true
    );
    res.json({
      opportunities: persistence.opportunities,
      sources: Object.fromEntries(sourceStats.map((item) => [item.id, item.count])),
      sourceStats,
      incrementalStats: persistence.incrementalStats,
      runId
    });
  }));

  app.get("/api/lead-finder/providers", requireAuth, (req, res) => {
    res.json({ providers: allProviderStatuses(req.user!) });
  });

  // 将自然语言搜客目标解析为标准英文搜索结构（国家/产品/行业/客户类型/排除词/项目名称）
  // 复用用户已配置的「搜客」用途 AI 模型，结果在界面上可编辑确认后用于创建获客项目
  app.post("/api/lead-finder/parse-goal", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ goal: z.string().trim().min(1).max(2000) }).parse(req.body);
    const config = getAiConfig(req.user!, "leadFinder");
    if (!config || !config.apiKey || !configSupportsUseCase(config, "leadFinder")) {
      res.status(422).json({ message: "未配置可用于搜客的 AI 模型，请先在「AI 模型配置」中启用「搜客」用途" });
      return;
    }
    const customerTypes = [
      "*", "经销商 / Distributor", "系统集成商 / System Integrator",
      "OEM 设备厂", "EPC 工程承包商", "MRO 服务商", "终端工厂"
    ];
    const prompt = [
      "你是一个外贸获客意图解析器。用户用中文或英文描述他想寻找的客户，你需要把它转述成用于海外搜索引擎的标准英文搜索条件。",
      "只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。JSON 结构：",
      "{",
      "  \"name\": \"简短的英文项目名称，用于标识这次搜客任务\",",
      "  \"markets\": [\"标准英文国家/地区名数组，例如 Thailand、United States、Germany；若未指定具体国家填 [\\\"Global\\\"]\"],",
      "  \"products\": [\"英文产品/行业关键词数组，描述要找买家的具体产品，例如 instruments and meters\"],",
      "  \"industries\": [\"英文行业词数组，可选，可空\"],",
      "  \"customerType\": \"必须是下列之一: " + customerTypes.join(" | ") + "\",",
      "  \"exclusions\": [\"不想要的客户/关键词英文数组，可选，可空\"]",
      "}",
      "要求：",
      "1. 全部用英文，使用外贸/搜索引擎友好的标准术语。",
      "2. markets 用规范英文国名；若用户说全球/worldwide/不限国家，用 [\"Global\"]。",
      "3. customerType 必须严格是给定枚举中的一个（含 \"*\" 表示不限）。",
      "4. products 至少给 1 个，尽量贴合用户意图。",
      `用户输入：${body.goal}`
    ].join("\n");
    let parsed: Record<string, unknown>;
    try {
      const content = await callAiModel(config, prompt, 4000, undefined, 110_000);
      parsed = extractJsonObject(content) as Record<string, unknown>;
    } catch (err) {
      res.status(502).json({ message: "AI 解析失败：" + (err instanceof Error ? err.message : "模型返回无法解析") });
      return;
    }
    const strArr = (value: unknown): string[] =>
      Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 30) : [];
    let markets = strArr(parsed.markets);
    const products = strArr(parsed.products);
    const industries = strArr(parsed.industries);
    const exclusions = strArr(parsed.exclusions);
    const name = String(parsed.name || "").trim().slice(0, 200);
    let customerType = String(parsed.customerType || "*").trim();
    if (!customerTypes.includes(customerType)) customerType = "*";
    const isGlobal = markets.length === 0 || markets.some((m) => /^(global|全球|all|worldwide|不限)$/i.test(m.trim()));
    if (isGlobal) markets = ["Global"];
    if (!products.length && isGlobal) {
      res.status(422).json({ message: "AI 未能从描述中识别出产品或市场，请补充更具体的目标（如产品、国家）" });
      return;
    }
    res.json({ name, markets, products, industries, customerType, exclusions });
  }));

  app.post("/api/lead-finder/launch", requireAuth, asyncRoute(async (req, res) => {
    const rawIdempotencyKey = req.header("Idempotency-Key");
    if (!rawIdempotencyKey) {
      res.status(400).json({
        message: "必须提供 Idempotency-Key 请求头",
        errorCode: "IDEMPOTENCY_KEY_REQUIRED"
      });
      return;
    }
    const idempotencyKey = prospectRunIdempotencyKeySchema.parse(
      rawIdempotencyKey
    );
    const body = launchLeadFinderSchema.parse(req.body);
    try {
      const result = await launchLeadFinder({
        store: getStore(),
        user: req.user!,
        body,
        idempotencyKey,
        onRunCreated: synchronizeProspectQueue
      });
      setProspectRunEtag(res, result);
      res.setHeader(
        "Server-Timing",
        [
          `campaign;dur=${result.launchTimings.campaignMs}`,
          `strategy;dur=${result.launchTimings.strategyMs}`,
          `approval;dur=${result.launchTimings.approvalMs}`,
          `activation;dur=${result.launchTimings.activationMs}`,
          `run;dur=${result.launchTimings.runMs}`,
          `queue;dur=${result.launchTimings.queueMs}`,
          `total;dur=${result.launchTimings.totalMs}`
        ].join(", ")
      );
      res.setHeader("Idempotency-Replayed", result.launchReplayed ? "true" : "false");
      res.location(`/api/prospect-runs/${result.run.id}`);
      res.status(result.launchReplayed ? 200 : 201).json(result);
    } catch (error) {
      if (sendProspectCampaignError(res, error)) return;
      throw error;
    }
  }));

  app.get("/api/lead-finder/provider-catalog", requireAuth, (_req, res) => {
    const providers = getStore().providerCatalog
      .filter((item) => item.status !== "disabled")
      .map(publicProviderCatalogItem);
    res.json({ providers });
  });

  app.get("/api/lead-finder/provider-request-logs", requireAuth, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const providerId = String(req.query.provider || "").trim();
    const runId = String(req.query.runId || "").trim();
    const visible = getStore().providerRequestLogs
      .filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId))
      .filter((item) => !providerId || item.providerId === providerId)
      .filter((item) => !runId || item.runId === runId)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
    res.json({ logs: visible.slice(0, limit), total: visible.length });
  });

  app.post("/api/lead-finder/source-config", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      provider: z.string().min(1).max(40),
      apiKey: z.string().max(400).optional().default(""),
      baseUrl: z.string().max(255).optional().default(""),
      enabled: z.boolean().optional().default(false)
    });
    const body = schema.parse(req.body);
    const provider = getConfigurableProvider(body.provider);
    if (!provider) {
      res.status(404).json({
        message: "未知数据源",
        errorCode: "PROVIDER_NOT_REGISTERED",
        retryable: false,
        retryAfterAt: null
      });
      return;
    }
    const catalog = providerCatalogByCode(provider.id);
    if (!catalog) {
      res.status(409).json({ message: "数据源目录缺失，暂不能保存连接" });
      return;
    }
    if (catalog.accessMode !== "api" || provider.accessMode !== "api") {
      res.status(400).json({
        message: "该来源用于官方入口人工核验；取得企业页或结果页链接后，可返回获客页面解析，无需保存 API 连接",
        errorCode: "PROVIDER_POLICY_BLOCKED",
        retryable: false,
        retryAfterAt: null
      });
      return;
    }
    if (provider.id === "us_census_trade" && body.baseUrl.trim()) {
      res.status(400).json({ message: "美国 Census 数据源使用固定官方地址，不允许自定义基础地址" });
      return;
    }
    if (body.baseUrl) assertProviderBaseUrlAllowed(body.baseUrl, provider.networkPolicy);
    const store = getStore();
    const existing = getProviderConnection(req.user!, body.provider);
    const existingConfiguration = providerConnectionConfiguration(existing);
    const apiKey = body.apiKey && !body.apiKey.includes("****") ? body.apiKey : existingConfiguration.apiKey;
    const baseUrl = provider.id === "us_census_trade"
      ? ""
      : body.baseUrl || existingConfiguration.baseUrl;
    if (providerRequiresKey(provider, catalog) && body.enabled && !apiKey) {
      res.status(400).json({
        message: provider.id === "sec_edgar"
          ? "启用前请填写 SEC Fair Access User-Agent（系统名 联系邮箱）"
          : "启用前请先填写该数据源的 API Key"
      });
      return;
    }
    const now = new Date().toISOString();
    const id = existing?.id || `pc_${provider.id}_${req.user!.id}_${Date.now()}`;
    const context = { id, providerId: provider.id, ownerId: req.user!.id, teamId: req.user!.teamId };
    const connection: ProviderConnection = {
      ...context,
      scope: "personal",
      credentialRef: existing?.credentialRef || createCredentialRef(),
      configurationEncrypted: encryptProviderConfiguration(context, { apiKey, baseUrl }),
      status: body.enabled ? "active" : "disabled",
      quotaPolicy: existing?.quotaPolicy || {},
      budgetPolicy: existing?.budgetPolicy || {},
      lastHealthAt: existing?.lastHealthAt || "",
      lastHealthStatus: existing?.lastHealthStatus || "untested",
      lastErrorCode: existing?.lastErrorCode || "",
      lastHealthMessage: existing?.lastHealthMessage || "",
      usage: existing?.usage || "",
      createdBy: existing?.createdBy || req.user!.id,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (existing) Object.assign(existing, connection);
    else store.providerConnections.unshift(connection);
    await store.persist();
    res.json({ config: publicLeadSourceConfig(connection), providers: allProviderStatuses(req.user!) });
  }));

  app.post("/api/lead-finder/source-config/test", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({ provider: z.string().min(1).max(40) });
    const body = schema.parse(req.body);
    const provider = getConfigurableProvider(body.provider);
    if (!provider) {
      res.status(404).json({ message: "未知数据源" });
      return;
    }
    const store = getStore();
    const catalog = providerCatalogByCode(provider.id);
    if (!catalog) {
      res.status(409).json({
        message: "数据源目录缺失，暂不能测试连接",
        errorCode: "PROVIDER_CATALOG_MISSING",
        retryable: false,
        retryAfterAt: null
      });
      return;
    }
    if (catalog.accessMode !== "api" || provider.accessMode !== "api") {
      res.status(400).json({
        message: "该来源不是自动 API，请通过官方入口检索或下载后导入",
        errorCode: "PROVIDER_POLICY_BLOCKED",
        retryable: false,
        retryAfterAt: null
      });
      return;
    }
    const connection = getProviderConnection(req.user!, provider.id);
    const connectionRead = readProviderConnectionConfiguration(connection);
    const configuration = connectionRead.configuration;
    if (connection && !connectionRead.readable) {
      res.status(409).json({
        message: "连接凭据不可读取，请重新保存后再测试",
        errorCode: "PROVIDER_CONNECTION_INVALID",
        retryable: false,
        retryAfterAt: null
      });
      return;
    }
    if (providerRequiresKey(provider, catalog) && !configuration.apiKey) {
      res.status(400).json({
        message: provider.id === "sec_edgar"
          ? "请先保存 SEC Fair Access User-Agent，再测试连接"
          : "请先保存该数据源的 API Key，再测试连接",
        errorCode: "PROVIDER_CONNECTION_INVALID",
        retryable: false,
        retryAfterAt: null
      });
      return;
    }
    const runId = `prun_test_${randomUUID()}`;
    let result: Awaited<ReturnType<typeof executeProviderHealth>>;
    let failure: ProviderContractError | null = null;
    try {
      result = await executeProviderHealth({
        provider,
        catalog,
        context: createProviderExecutionContext({
          teamId: req.user!.teamId,
          ownerId: req.user!.id,
          runId,
          providerId: provider.id,
          operation: "health",
          purpose: "provider_connection_test"
        }),
        connection,
        credential: connection ? undefined : configuration,
        allowDisabledConnectionForHealth: true,
        onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
      });
    } catch (error) {
      failure = providerErrorFromUnknown(error, "health");
      result = { ok: false, message: `连接异常：${failure.publicMessage}` };
    }
    const errorCode = result.ok ? "" : failure?.code || "PROVIDER_UNAVAILABLE";
    const retryable = result.ok ? false : failure?.retryable || false;
    const retryAfterAt = result.ok ? null : failure?.retryAfterAt || null;
    if (connection) {
      connection.lastHealthAt = new Date().toISOString();
      connection.lastHealthStatus = result.ok ? "passed" : "failed";
      connection.lastErrorCode = errorCode.toLocaleLowerCase();
      connection.lastHealthMessage = result.message;
      if (result.usage?.display) connection.usage = result.usage.display;
      connection.updatedAt = new Date().toISOString();
    }
    await store.persist();
    res.json({
      ok: result.ok,
      message: result.message,
      usage: result.usage?.display || "",
      errorCode,
      retryable,
      retryAfterAt,
      providers: allProviderStatuses(req.user!)
    });
  }));

  app.delete("/api/lead-finder/source-config/:provider", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const index = store.providerConnections.findIndex((item) =>
      item.providerId === req.params.provider
      && item.ownerId === req.user!.id
      && item.teamId === req.user!.teamId
    );
    if (index < 0) {
      res.status(404).json({ message: "配置不存在或无权删除" });
      return;
    }
    store.providerConnections.splice(index, 1);
    await store.persist();
    res.json({ providers: allProviderStatuses(req.user!) });
  }));

  app.post("/api/lead-finder/lfind-tasks", requireAuth, asyncRoute(async (req, res) => {
    const body = leadSearchSchema.parse(req.body);
    // 跟随团队「AI 执行设置」里选的 CLI；所选 Runner 没有该 CLI 时自动改用另一个
    const engineSettings = await readTeamAiEngineSettings(req.user!.teamId);
    const plan = await lfindRunnerPlan(req.user!, engineSettings.cliAdapter);
    if (!plan.configured || !plan.service || !plan.runner) {
      res.status(409).json({
        message: plan.message,
        errorCode: "LFIND_RUNNER_NOT_CONFIGURED",
        suggestion: plan.suggestion
      });
      return;
    }
    // 按选中 Runner 实际具备的适配器声明引擎：团队首选的 CLI 优先，没有就用另一个；
    // createTask 不传 adapter 时默认 codex，会在只装 WorkBuddy 的机器上误报「未检测到 CLI」。
    const preferredAdapter = engineSettings.cliAdapter;
    const adapter: AiEngineAdapter = plan.runner.capabilities.includes(preferredAdapter)
      ? preferredAdapter
      : aiEngineFallbackAdapters(preferredAdapter).find((item) => plan.runner!.capabilities.includes(item)) || preferredAdapter;
    const task = await plan.service.createTask(req.user!, {
      runnerId: plan.runner.id,
      prompt: applyCliProfileToPrompt(lfindPrompt(body), engineCliProfile(engineSettings, adapter)),
      workspace: plan.runner.workspaces[0],
      adapter,
      executionMode: "read_only",
      timeoutSeconds: 1800
    });
    res.status(201).json({
      task,
      message: "Lfind 深入查询已进入本地 Runner 队列",
      suggestion: "页面会自动刷新任务进度；若长时间无返回，请在集成中心查看 Runner 执行记录。"
    });
  }));

  app.get("/api/lead-finder/lfind-tasks/:id", requireAuth, asyncRoute(async (req, res) => {
    try {
      res.json(await syncLfindTaskResult(req.user!, req.params.id));
    } catch (error) {
      const value = error as { status?: number; code?: string; suggestion?: string; message?: string };
      res.status(value.status || 422).json({
        message: value.message || "Lfind 任务结果无法同步",
        errorCode: value.code || "LFIND_RESULT_INVALID",
        suggestion: value.suggestion || "请在集成中心查看任务最终回复，确认返回的是 goodjob-lfind-v1 JSON。"
      });
    }
  }));

  // ---------------------------------------------------------------------------
  // Excel 名单导入：任意版式表格 → 本机 CLI 识别 → 走同一套查重/入池链路
  // 用户场景：自动流第 1 步跑完后，把自己整理的名单（Excel/CSV）并进本轮，
  // 与搜出来的公司一起进入背调、写信。
  // ---------------------------------------------------------------------------
  const EXCEL_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
  const excelImportDir = path.join(os.homedir(), ".goodjob-crm", "imports");

  app.post("/api/lead-finder/excel-imports", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      filename: z.string().trim().min(1).max(160),
      contentBase64: z.string().min(1)
    }).parse(req.body);
    const ext = path.extname(body.filename).toLowerCase();
    if (![".xlsx", ".xls", ".csv"].includes(ext)) {
      res.status(400).json({ message: "只支持 .xlsx / .xls / .csv 文件" });
      return;
    }
    const buffer = Buffer.from(body.contentBase64, "base64");
    if (!buffer.length) {
      res.status(400).json({ message: "文件内容为空" });
      return;
    }
    if (buffer.length > EXCEL_IMPORT_MAX_BYTES) {
      res.status(413).json({ message: "Excel 文件不能超过 8MB" });
      return;
    }
    const engineSettings = await readTeamAiEngineSettings(req.user!.teamId);
    const plan = await lfindRunnerPlan(req.user!, engineSettings.cliAdapter);
    if (!plan.configured || !plan.service || !plan.runner) {
      res.status(409).json({
        message: plan.message,
        errorCode: "LFIND_RUNNER_NOT_CONFIGURED",
        suggestion: plan.suggestion
      });
      return;
    }
    const preferredAdapter = engineSettings.cliAdapter;
    const adapter: AiEngineAdapter = plan.runner.capabilities.includes(preferredAdapter)
      ? preferredAdapter
      : aiEngineFallbackAdapters(preferredAdapter).find((item) => plan.runner!.capabilities.includes(item)) || preferredAdapter;
    await mkdir(excelImportDir, { recursive: true });
    const storedPath = path.join(excelImportDir, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
    await writeFile(storedPath, buffer);
    const task = await plan.service.createTask(req.user!, {
      runnerId: plan.runner.id,
      prompt: applyCliProfileToPrompt(excelImportPrompt(storedPath, body.filename), engineCliProfile(engineSettings, adapter)),
      workspace: plan.runner.workspaces[0],
      adapter,
      executionMode: "read_only",
      timeoutSeconds: 900
    });
    res.status(201).json({
      task,
      filename: body.filename,
      message: "Excel 已交给本机 CLI 识别，通常几十秒出结果",
      suggestion: "识别完成后会按域名 / 邮箱 / 公司名自动与候选池查重，重复的合并证据，不新增重复行。"
    });
  }));

  app.get("/api/lead-finder/excel-imports/:taskId", requireAuth, asyncRoute(async (req, res) => {
    const plan = await lfindRunnerPlan(req.user!);
    if (!plan.service) {
      res.status(503).json({
        message: plan.message,
        errorCode: "LFIND_RUNNER_UNAVAILABLE",
        suggestion: plan.suggestion
      });
      return;
    }
    const detail = await plan.service.task(req.user!, req.params.taskId);
    if (detail.task.status !== "succeeded") {
      res.json({
        task: detail.task,
        events: detail.events,
        synced: false,
        opportunities: [] as WebsiteOpportunity[],
        incrementalStats: null,
        skipped: [] as Array<{ company: string; reason: string }>,
        lfind: null as LfindResult | null
      });
      return;
    }
    const parsed = lfindResultSchema.parse(extractJsonObject(detail.task.resultText));
    const sourceLabel = `Excel 导入 · ${detail.task.id.slice(-8)}`;
    // providerId 继续用 lfind 口径：证据记录键与搜客结果一致，同一家公司（含改名换域名场景）
    // 才能在 isSameProviderOpportunity 里合并；对外来源用 source/sourceLabel 标成 Excel 导入。
    const rawOpportunities = lfindOpportunitiesFromResult(
      parsed,
      detail.task.id,
      req.user!,
      sourceLabel,
      { idPrefix: "lf_excel" }
    ).map((item) => ({ ...item, source: "excel_import", sourceLabel }));
    const store = getStore();
    const existingFilter = filterExistingCrmOpportunities(rawOpportunities, store, req.user!.teamId);
    await store.reloadProspectCandidates?.();
    const persistence = persistProviderOpportunities(existingFilter.opportunities, {
      rawCount: parsed.summary.rawFound || parsed.opportunities.length,
      deduplicatedCount: 0,
      existingFilteredCount: existingFilter.skipped.length
    });
    await persistCandidateChanges(store, persistence.opportunities, true);
    res.json({
      task: detail.task,
      events: detail.events,
      synced: true,
      opportunities: persistence.opportunities,
      incrementalStats: persistence.incrementalStats,
      skipped: existingFilter.skipped,
      lfind: parsed
    });
  }));

  app.post("/api/lead-finder/search", requireAuth, asyncRoute(async (req, res) => {
    const body = leadSearchSchema.parse(req.body);
    const store = getStore();
    const user = req.user!;
    const runId = `prun_search_${randomUUID()}`;
    const query: LeadQuery = {
      goal: body.goal,
      productKeywords: body.productKeywords,
      countries: body.countries,
      industry: body.industry,
      customerType: body.customerType,
      excludeKeywords: body.excludeKeywords,
      limit: Math.min(body.limit, 15)
    };

    // 是否需要 Key 统一以持久化 Catalog 策略为准，实际可执行性由 Runtime 校验并记录审计。
    const chosen = body.sources.length
      ? LEAD_PROVIDERS.filter((provider) => body.sources.includes(provider.id))
      : LEAD_PROVIDERS.filter((provider) =>
          DEFAULT_LEAD_SEARCH_PROVIDER_IDS.includes(
            provider.id as (typeof DEFAULT_LEAD_SEARCH_PROVIDER_IDS)[number]
          )
        );
    const activeProviders = chosen.filter((provider) =>
      provider.accessMode === "api"
      && providerCatalogByCode(provider.id)?.accessMode === "api"
    );
    const unknownSourceIds = [...new Set(body.sources.filter((id) =>
      id !== "ai_search" && !LEAD_PROVIDERS.some((provider) => provider.id === id)
    ))];
    const skipped: string[] = [];
    const wantsAiSearch = body.sources.includes("ai_search");

    const searchProviders = activeProviders.filter((provider) => provider.category !== "email");
    const contactOnlyProviders = activeProviders.filter((provider) => provider.category === "email");

    const sourceStats: Array<{
      id: string;
      name: string;
      count: number;
      status?: string;
      error?: string;
      errorCode?: string;
      retryable?: boolean;
      retryAfterAt?: string | null;
      nextCursor?: string | null;
      usage?: string;
    }> = [];
    for (const providerId of unknownSourceIds) {
      recordProviderPreflightFailure(user, runId, providerId, "PROVIDER_NOT_REGISTERED", "search_preflight");
      sourceStats.push({
        id: providerId,
        name: providerId,
        count: 0,
        status: "failed",
        error: "未知数据源",
        errorCode: "PROVIDER_NOT_REGISTERED",
        retryable: false,
        retryAfterAt: null
      });
    }
    type CollectedLead = RawLead & {
      source: string;
      sourceLabel: string;
      payloadHash?: string;
      sourceEvidence: ProviderEvidenceSnapshot[];
    };
    const collected: CollectedLead[] = [];

    await Promise.all(contactOnlyProviders.map(async (provider) => {
      const catalog = providerCatalogByCode(provider.id);
      if (!catalog) return;
      const connection = getProviderConnection(user, provider.id);
      try {
        await executeProviderPreflight({
          provider,
          catalog,
          context: createProviderExecutionContext({
            teamId: user.teamId,
            ownerId: user.id,
            runId,
            providerId: provider.id,
            operation: "enrich",
            purpose: "lead_finder_contact_source_preflight"
          }),
          connection,
          credential: connection ? undefined : { apiKey: "", baseUrl: "" },
          onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
        });
      } catch (error) {
        const failure = providerErrorFromUnknown(error, "enrich");
        sourceStats.push({
          id: provider.id,
          name: provider.name,
          count: 0,
          status: "failed",
          error: failure.publicMessage,
          errorCode: failure.code,
          retryable: failure.retryable,
          retryAfterAt: failure.retryAfterAt
        });
      }
    }));

    await Promise.all(searchProviders.map(async (provider) => {
      const connection = getProviderConnection(user, provider.id);
      const catalog = providerCatalogByCode(provider.id);
      if (!catalog) {
        recordProviderPreflightFailure(user, runId, provider.id, "PROVIDER_CATALOG_MISSING", "search_preflight");
        sourceStats.push({
          id: provider.id,
          name: provider.name,
          count: 0,
          status: "failed",
          error: "数据源目录缺失",
          errorCode: "PROVIDER_CATALOG_MISSING",
          retryable: false,
          retryAfterAt: null
        });
        return;
      }
      try {
        const result = await executeProviderSearch({
          provider,
          catalog,
          context: createProviderExecutionContext({
            teamId: user.teamId,
            ownerId: user.id,
            runId,
            providerId: provider.id,
            operation: "search",
            purpose: "lead_finder_search"
          }),
          connection,
          credential: connection ? undefined : { apiKey: "", baseUrl: "" },
          query,
          onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
        });
        for (const lead of result.records) {
          if (!lead.company) continue;
          collected.push({
            ...lead,
            source: provider.id,
            sourceLabel: provider.name,
            sourceEvidence: [providerEvidenceSnapshot(provider.id, lead)]
          });
        }
        sourceStats.push({
          id: provider.id,
          name: provider.name,
          count: result.records.length,
          status: result.status,
          nextCursor: result.nextCursor,
          usage: result.usage.display
        });
      } catch (error) {
        const failure = providerErrorFromUnknown(error, "search");
        sourceStats.push({
          id: provider.id,
          name: provider.name,
          count: 0,
          status: "failed",
          error: failure.publicMessage,
          errorCode: failure.code,
          retryable: failure.retryable,
          retryAfterAt: failure.retryAfterAt
        });
      }
    }));

    // AI 搜索：用「AI 模型配置」里已启用并勾选自动获客的模型直接生成候选公司
    if (wantsAiSearch) {
      const aiSearchConfig = getAiConfig(user, "leadFinder");
      const catalog = providerCatalogByCode("ai_search");
      if (!catalog) {
        recordProviderPreflightFailure(user, runId, "ai_search", "PROVIDER_CATALOG_MISSING", "search_preflight");
        sourceStats.push({
          id: "ai_search",
          name: "AI 搜索",
          count: 0,
          status: "failed",
          error: "AI 搜索目录缺失",
          errorCode: "PROVIDER_CATALOG_MISSING",
          retryable: false,
          retryAfterAt: null
        });
      } else if (aiSearchConfig?.enabled && aiSearchConfig.apiKey && aiSearchConfig.useLeadFinder && aiSearchStatus(user).ready) {
        try {
          const provider = createAiSearchProvider(aiSearchConfig);
          const result = await executeProviderSearch({
            provider,
            catalog,
            context: createProviderExecutionContext({
              teamId: user.teamId,
              ownerId: user.id,
              runId,
              providerId: provider.id,
              operation: "search",
              purpose: "lead_finder_ai_search"
            }),
            credential: {
              apiKey: aiSearchConfig.apiKey,
              baseUrl: aiSearchConfig.baseUrl
            },
            query,
            onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
          });
          for (const lead of result.records) {
            if (!lead.company) continue;
            const evidence = providerEvidenceSnapshot("ai_search", lead);
            const authoritativeContact = ["official", "corroborated"].includes(
              evidence.fieldAuthority?.contactInfo || ""
            );
            collected.push({
              ...lead,
              contact: authoritativeContact ? lead.contact : "待维护",
              contactInfo: authoritativeContact ? lead.contactInfo : "",
              source: "ai_search",
              sourceLabel: "AI 搜索",
              sourceEvidence: [evidence]
            });
          }
          sourceStats.push({
            id: "ai_search",
            name: "AI 搜索",
            count: result.records.length,
            status: result.status,
            nextCursor: result.nextCursor,
            usage: result.usage.display
          });
        } catch (error) {
          const failure = providerErrorFromUnknown(error, "search");
          sourceStats.push({
            id: "ai_search",
            name: "AI 搜索",
            count: 0,
            status: "failed",
            error: failure.publicMessage,
            errorCode: failure.code,
            retryable: failure.retryable,
            retryAfterAt: failure.retryAfterAt
          });
        }
      } else {
        const providerStatus = aiSearchStatus(user);
        const policy = aiSearchConfig ? aiWebSearchPolicy(aiSearchConfig) : null;
        const errorCode: ProviderErrorCode = !aiSearchConfig || !aiSearchConfig.apiKey || !aiSearchConfig.enabled || !aiSearchConfig.useLeadFinder
          ? "PROVIDER_CONNECTION_INVALID"
          : policy?.reasonCode || "AI_WEB_SEARCH_NOT_TESTED";
        const errorMessage = !aiSearchConfig || !aiSearchConfig.apiKey || !aiSearchConfig.enabled || !aiSearchConfig.useLeadFinder
          ? "请先启用可用于自动获客的 AI 模型"
          : providerStatus.lastTestMessage || `${policy?.message || "官网联网能力尚未验证"} ${policy ? webSearchFailureSuggestion(policy) : ""}`.trim();
        recordProviderPreflightFailure(user, runId, "ai_search", errorCode, "search_preflight");
        sourceStats.push({
          id: "ai_search",
          name: catalog.name || "AI 搜索",
          count: 0,
          status: "failed",
          error: errorMessage,
          errorCode,
          retryable: false,
          retryAfterAt: null
        });
        skipped.push(`AI 搜索（${errorMessage}）`);
      }
    }

    // 同批次只按强标识或“官网域名 + 国家”合并；同名公司不再直接视为同一主体。
    const deduped: CollectedLead[] = [];
    for (const lead of collected) {
      const domain = websiteDomainKey(lead.officialWebsite || lead.website || "");
      const country = (lead.country || "").trim().toLocaleLowerCase();
      const existing = deduped.find((row) => {
        const sameProviderRecord = Boolean(
          lead.providerRecordId
          && row.providerRecordId
          && lead.source === row.source
          && lead.providerRecordId === row.providerRecordId
        );
        const samePayload = Boolean(
          lead.payloadHash
          && row.payloadHash
          && lead.source === row.source
          && lead.payloadHash === row.payloadHash
        );
        const rowDomain = websiteDomainKey(row.officialWebsite || row.website || "");
        const sameDomainCountry = Boolean(
          domain
          && rowDomain === domain
          && (row.country || "").trim().toLocaleLowerCase() === country
        );
        return sameProviderRecord || samePayload || sameDomainCountry;
      });
      if (existing) {
        existing.sourceEvidence = mergeProviderEvidence(existing.sourceEvidence, lead.sourceEvidence);
        if (!existing.officialWebsite && lead.officialWebsite) {
          existing.officialWebsite = lead.officialWebsite;
          existing.website = lead.officialWebsite;
        }
        if (!existing.contactInfo && lead.contactInfo) existing.contactInfo = lead.contactInfo;
        if ((!existing.contact || existing.contact === "待维护") && lead.contact) existing.contact = lead.contact;
        existing.confidence = Math.max(existing.confidence || 0, lead.confidence || 0);
        continue;
      }
      deduped.push(lead);
    }

    // 落库为 WebsiteOpportunity
    const opportunities: WebsiteOpportunity[] = deduped.slice(0, query.limit * 2).map((lead) =>
      withProspectVerificationReport({
        id: `lf_${lead.source}_${randomUUID()}`,
        company: lead.company,
        business: lead.business || "待维护",
        country: lead.country || "未知",
        website: normalizeWebsite(lead.website || ""),
        contact: lead.contact || "待维护",
        contactInfo: lead.contactInfo || "",
        description: lead.description || "自动获客候选，待核实。",
        ownerId: user.id,
        teamId: user.teamId,
        status: "preview",
        createdAt: new Date().toISOString(),
        parseMode: lead.source === "ai_search" ? "ai" : "rule",
        source: lead.source,
        sourceLabel: lead.sourceLabel,
        sourceEvidence: lead.sourceEvidence,
        confidence: lead.confidence
      })
    );
    const existingFilter = filterExistingCrmOpportunities(
      opportunities,
      store,
      user.teamId
    );
    if (existingFilter.skipped.length) {
      skipped.push(...existingFilter.skipped.slice(0, 12).map((item) =>
        `${item.company}（${item.reason}）`
      ));
    }

    await store.reloadProspectCandidates?.();
    const persistence = persistProviderOpportunities(existingFilter.opportunities, {
      rawCount: collected.length,
      deduplicatedCount: Math.max(0, collected.length - deduped.length),
      existingFilteredCount: existingFilter.skipped.length
    });
    await persistCandidateChanges(
      store,
      persistence.opportunities,
      true
    );

    // 公司候选先返回；联系人接口和境外官网验证在后台并行补全，避免搜索页死等。
    const configuredLimit = Number(process.env.AUTO_CONTACT_ENRICHMENT_LIMIT);
    const contactEnrichmentLimit = Number.isFinite(configuredLimit) && configuredLimit > 0
      ? Math.max(1, Math.min(20, Math.trunc(configuredLimit)))
      : 12;
    const contactEnrichmentTargetIds = persistence.opportunities
      .filter((opp) => opp.ownerId === user.id && opp.teamId === user.teamId)
      .slice(0, contactEnrichmentLimit)
      .map((opp) => opp.id);
    for (const candidateId of contactEnrichmentTargetIds) {
      void scheduleContactEnrichment(user, candidateId, runId);
    }
    const contactEnrichmentPlannedCount = contactEnrichmentTargetIds.length;

    res.json({
      opportunities: persistence.opportunities,
      sourceStats,
      incrementalStats: persistence.incrementalStats,
      skipped,
      providersUsed: activeProviders.map((provider) => provider.id),
      autoProbePlannedCount: contactEnrichmentPlannedCount,
      contactEnrichmentPlannedCount,
      runId
    });
  }));
}
