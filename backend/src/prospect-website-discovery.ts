import { randomUUID } from "node:crypto";
import type { ProviderRecord } from "./provider-contract.js";
import type {
  ProspectWebsiteDiscoveryAttempt,
  ProspectWebsiteDiscoveryCandidate,
  ProspectWebsiteDiscoveryEvent,
  WebsiteOpportunity
} from "./types.js";

export interface ProspectWebsiteDiscoverySearchResult {
  providerId: string;
  records: ProviderRecord[];
  errorCode?: string;
  errorMessage?: string;
}

export type ProspectWebsiteDiscoverySearch = (input: {
  candidate: WebsiteOpportunity;
  runId: string;
  query: string;
}) => Promise<ProspectWebsiteDiscoverySearchResult>;

const COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation",
  "company", "co", "gmbh", "ag", "sa", "sas", "srl", "bv", "plc",
  "group", "holding", "holdings"
]);
const BLOCKED_HOSTS = /(?:^|\.)(?:linkedin\.com|facebook\.com|instagram\.com|youtube\.com|wikipedia\.org|amazon\.[a-z.]+|alibaba\.com|indeed\.[a-z.]+|glassdoor\.[a-z.]+)$/iu;

function nowIso() {
  return new Date().toISOString();
}

function tokens(value: string) {
  return [...new Set(value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((item) => item.length >= 2 && !COMPANY_SUFFIXES.has(item)))];
}

function websiteOrigin(value: string) {
  try {
    const url = new URL(/^https?:\/\//iu.test(value) ? value : `https://${value}`);
    if (!/^https?:$/u.test(url.protocol)
      || url.username
      || url.password
      || BLOCKED_HOSTS.test(url.hostname)) return "";
    return `https://${url.hostname.toLocaleLowerCase("en-US")}`;
  } catch {
    return "";
  }
}

function overlapRatio(expected: string[], actual: string[]) {
  if (!expected.length || !actual.length) return 0;
  const values = new Set(actual);
  return expected.filter((item) => values.has(item)).length / expected.length;
}

export function rankProspectWebsiteCandidates(
  candidate: Pick<WebsiteOpportunity, "company" | "country">,
  records: ProviderRecord[]
): ProspectWebsiteDiscoveryCandidate[] {
  const companyTokens = tokens(candidate.company);
  const country = candidate.country.trim().toLocaleLowerCase("en-US");
  const ranked = records.flatMap((record) => {
    const website = websiteOrigin(record.officialWebsite || record.website || "");
    if (!website) return [];
    const hostname = new URL(website).hostname.replace(/^www\./iu, "");
    const titleTokens = tokens(`${record.company} ${record.evidenceSummary || ""}`);
    const domainTokens = tokens(hostname.split(".")[0] || hostname);
    const titleOverlap = overlapRatio(companyTokens, titleTokens);
    const domainOverlap = overlapRatio(companyTokens, domainTokens);
    const countryMatch = Boolean(
      country
      && record.country
      && record.country.trim().toLocaleLowerCase("en-US") === country
    );
    const score = Math.min(100, Math.round(
      titleOverlap * 58
      + domainOverlap * 30
      + (countryMatch ? 8 : 0)
      + 4
    ));
    const reasons = [
      `名称匹配 ${Math.round(titleOverlap * 100)}%`,
      `域名匹配 ${Math.round(domainOverlap * 100)}%`,
      countryMatch ? "国家一致" : "国家未确认"
    ];
    return [{
      website,
      title: record.company || hostname,
      score,
      reasons
    }];
  });
  const byWebsite = new Map<string, ProspectWebsiteDiscoveryCandidate>();
  for (const item of ranked) {
    const previous = byWebsite.get(item.website);
    if (!previous || item.score > previous.score) byWebsite.set(item.website, item);
  }
  return [...byWebsite.values()]
    .sort((left, right) => right.score - left.score || left.website.localeCompare(right.website))
    .slice(0, 5);
}

function event(
  stage: ProspectWebsiteDiscoveryEvent["stage"],
  status: ProspectWebsiteDiscoveryEvent["status"],
  message: string
): ProspectWebsiteDiscoveryEvent {
  return { id: `pwde_${randomUUID()}`, stage, status, message, createdAt: nowIso() };
}

function attemptBase(
  candidate: WebsiteOpportunity,
  runId: string,
  query: string
): ProspectWebsiteDiscoveryAttempt {
  const createdAt = nowIso();
  return {
    id: `pwda_${randomUUID()}`,
    runId,
    candidateId: candidate.id,
    teamId: candidate.teamId,
    ownerId: candidate.ownerId,
    providerId: "",
    status: "completed",
    outcome: "not_found",
    query,
    selectedWebsite: "",
    reasonCode: "WEBSITE_NOT_FOUND",
    reason: "没有取得可信官网",
    candidates: [],
    events: [event("queued", "completed", "官网发现任务已进入处理链路")],
    createdAt,
    completedAt: createdAt
  };
}

export async function discoverProspectWebsite(input: {
  candidate: WebsiteOpportunity;
  runId: string;
  search?: ProspectWebsiteDiscoverySearch;
  retryExisting?: boolean;
  persist(candidate: WebsiteOpportunity): Promise<void>;
}) {
  const { candidate, runId } = input;
  candidate.websiteDiscoveryAttempts ||= [];
  const existing = candidate.websiteDiscoveryAttempts.find((item) => item.runId === runId);
  if (existing && !input.retryExisting) return existing;
  const query = `"${candidate.company}" official website ${candidate.country}`.trim();
  const attempt = attemptBase(candidate, runId, query);
  candidate.websiteDiscoveryAttempts.unshift(attempt);
  if (websiteOrigin(candidate.website)) {
    attempt.outcome = "source_provided";
    attempt.selectedWebsite = websiteOrigin(candidate.website);
    attempt.reasonCode = "WEBSITE_SOURCE_PROVIDED";
    attempt.reason = "数据源已直接提供官网";
    attempt.events.push(event("source", "completed", `数据源官网：${attempt.selectedWebsite}`));
    attempt.events.push(event("completed", "completed", "官网发现完成，无需额外搜索"));
    await input.persist(candidate);
    return attempt;
  }
  if (!input.search) {
    attempt.providerId = "unconfigured";
    attempt.outcome = "provider_unavailable";
    attempt.reasonCode = "WEBSITE_SEARCH_PROVIDER_UNAVAILABLE";
    attempt.reason = "未配置可用的官网搜索 API";
    attempt.events.push(event("search", "failed", attempt.reason));
    attempt.events.push(event("failed", "failed", "官网发现结束：缺少可用搜索源"));
    await input.persist(candidate);
    return attempt;
  }
  attempt.events.push(event("search", "started", `正在通过搜索 API 查询：${query}`));
  try {
    const result = await input.search({ candidate, runId, query });
    attempt.providerId = result.providerId;
    if (result.errorCode) {
      attempt.status = "failed";
      attempt.outcome = result.errorCode === "WEBSITE_SEARCH_PROVIDER_UNAVAILABLE"
        ? "provider_unavailable"
        : "provider_failed";
      attempt.reasonCode = result.errorCode;
      attempt.reason = result.errorMessage || "官网搜索 API 执行失败";
      attempt.events.push(event("search", "failed", attempt.reason));
      attempt.events.push(event("failed", "failed", "官网发现结束：搜索源执行失败"));
      attempt.completedAt = nowIso();
      await input.persist(candidate);
      return attempt;
    }
    attempt.events.push(event("search", "completed", `${result.providerId} 返回 ${result.records.length} 个网页候选`));
    attempt.candidates = rankProspectWebsiteCandidates(candidate, result.records);
    const top = attempt.candidates[0];
    attempt.events.push(event(
      "ranking",
      "completed",
      top
        ? `最高候选 ${top.website}，可信评分 ${top.score}`
        : "搜索结果中没有可用企业域名"
    ));
    if (top && top.score >= 55) {
      candidate.website = top.website;
      attempt.outcome = "discovered";
      attempt.selectedWebsite = top.website;
      attempt.reasonCode = "WEBSITE_DISCOVERED_CONFIRMED";
      attempt.reason = `搜索 API 候选通过名称与域名校验，评分 ${top.score}`;
      attempt.events.push(event("completed", "completed", `已确认官网：${top.website}`));
    } else {
      attempt.outcome = "not_found";
      attempt.reasonCode = top ? "WEBSITE_CANDIDATE_LOW_CONFIDENCE" : "WEBSITE_NOT_FOUND";
      attempt.reason = top
        ? `最高候选评分 ${top.score}，未达到 55 分确认阈值`
        : "搜索 API 未返回可确认的企业官网";
      attempt.events.push(event("completed", "completed", `未确认官网：${attempt.reason}`));
    }
  } catch (error) {
    attempt.status = "failed";
    attempt.outcome = "provider_failed";
    attempt.reasonCode = "WEBSITE_SEARCH_PROVIDER_FAILED";
    attempt.reason = error instanceof Error ? error.message.slice(0, 240) : "官网搜索 API 执行失败";
    attempt.events.push(event("search", "failed", attempt.reason));
    attempt.events.push(event("failed", "failed", "官网发现结束：搜索源执行异常"));
  }
  attempt.completedAt = nowIso();
  await input.persist(candidate);
  return attempt;
}
