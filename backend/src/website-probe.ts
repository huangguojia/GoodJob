import { createHash, randomUUID } from "node:crypto";
import { load } from "cheerio";
import robotsParser from "robots-parser";
import { getDomain } from "tldts";
import { ProviderContractError } from "./provider-contract.js";
import {
  createProviderHttpClient,
  resolveProviderPublicAddresses
} from "./provider-http-client.js";
import type { CrmStore } from "./store.js";
import type {
  WebsiteOpportunity,
  WebsiteProbeAttempt,
  WebsiteProbeEvidence,
  WebsiteProbeEvent,
  WebsiteProbeStage
} from "./types.js";

const POLICY_VERSION = "website-probe-policy-v2" as const;
const USER_AGENT = "GoodJobCRM-WebsiteProbe/1.0";
const MAX_RESPONSE_BYTES = 64 * 1024;
const CACHE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CIRCUIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const domainQueues = new Map<string, Promise<void>>();
const teamNextAllowedAt = new Map<string, number>();
const parseRobots = robotsParser as unknown as (
  url: string,
  body: string
) => { isAllowed(url: string, userAgent?: string): boolean | undefined };

export class WebsiteProbeError extends Error {
  constructor(
    public readonly code:
      | "WEBSITE_PROBE_DISABLED"
      | "WEBSITE_PROBE_NOT_OWNED"
      | "WEBSITE_PROBE_URL_INVALID"
      | "WEBSITE_PROBE_ATTEMPT_NOT_FOUND",
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "WebsiteProbeError";
  }
}

type PersistCandidate = (candidate: WebsiteOpportunity) => Promise<void>;

function featureEnabled() {
  return process.env.WEBSITE_PROBE_ENABLED !== "false";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function candidateById(store: CrmStore, candidateId: string) {
  return store.websiteOpportunities.find((item) => item.id === candidateId);
}

function attemptById(
  store: CrmStore,
  candidateId: string,
  attemptId: string
) {
  return candidateById(store, candidateId)?.websiteProbeAttempts?.find(
    (item) => item.id === attemptId
  );
}

function canonicalTarget(candidate: WebsiteOpportunity) {
  let url: URL;
  try {
    url = new URL(candidate.website);
  } catch {
    throw new WebsiteProbeError(
      "WEBSITE_PROBE_URL_INVALID",
      "候选官网必须是完整的 HTTPS 地址",
      400
    );
  }
  if (url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || url.hostname.includes("%")) {
    throw new WebsiteProbeError(
      "WEBSITE_PROBE_URL_INVALID",
      "官网探针只允许不含凭据的 HTTPS 标准端口",
      400
    );
  }
  const domain = getDomain(url.hostname, { allowPrivateDomains: false });
  if (!domain) {
    throw new WebsiteProbeError(
      "WEBSITE_PROBE_URL_INVALID",
      "官网域名不是可注册的公网域名",
      400
    );
  }
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  return {
    domain: domain.toLocaleLowerCase("en-US"),
    hostname,
    homeUrl: `https://${hostname}/`,
    robotsUrl: `https://${hostname}/robots.txt`
  };
}

function appendEvent(
  attempt: WebsiteProbeAttempt,
  stage: WebsiteProbeStage,
  status: WebsiteProbeEvent["status"],
  message: string,
  metrics: WebsiteProbeEvent["metrics"] = {}
) {
  const event: WebsiteProbeEvent = {
    id: `wpe_${randomUUID()}`,
    sequence: attempt.events.length + 1,
    stage,
    status,
    message,
    metrics,
    createdAt: nowIso()
  };
  attempt.events.push(event);
  return event;
}

async function mutateAttempt(
  store: CrmStore,
  candidateId: string,
  attemptId: string,
  persist: PersistCandidate,
  mutation: (attempt: WebsiteProbeAttempt) => void
) {
  const candidate = candidateById(store, candidateId);
  const attempt = attemptById(store, candidateId, attemptId);
  if (!candidate || !attempt) {
    throw new WebsiteProbeError(
      "WEBSITE_PROBE_ATTEMPT_NOT_FOUND",
      "官网探针任务不存在或已失效",
      404
    );
  }
  mutation(attempt);
  await persist(candidate);
}

function allDomainAttempts(
  store: CrmStore,
  teamId: string,
  domain: string
) {
  return store.websiteOpportunities
    .filter((item) => item.teamId === teamId)
    .flatMap((item) => item.websiteProbeAttempts || [])
    .filter((item) => item.domain === domain)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function recentCachedAttempt(
  store: CrmStore,
  teamId: string,
  domain: string,
  at: number
) {
  return allDomainAttempts(store, teamId, domain).find((item) =>
    item.status === "completed"
    && Boolean(item.completedAt)
    && at - new Date(item.completedAt).getTime() < CACHE_WINDOW_MS
  );
}

function circuitOpen(
  store: CrmStore,
  teamId: string,
  domain: string,
  at: number
) {
  const recent = allDomainAttempts(store, teamId, domain)
    .filter((item) =>
      item.status === "failed"
      && at - new Date(item.completedAt || item.createdAt).getTime()
        < CIRCUIT_WINDOW_MS
    )
    .slice(0, 3);
  return recent.length === 3 && recent.every((item) =>
    item.outcome === "unreachable" || item.outcome === "rate_limited"
  );
}

function alternateHost(hostname: string, domain: string) {
  if (hostname === domain) return `www.${domain}`;
  if (hostname === `www.${domain}`) return domain;
  return "";
}

function networkPolicy(hostname: string, domain: string) {
  const alternate = alternateHost(hostname, domain);
  return {
    allowedHosts: [hostname],
    redirectHosts: alternate ? [alternate] : [],
    allowedPaths: ["/", "/robots.txt"],
    allowedPathPrefixes: [],
    allowedMethods: ["GET", "HEAD"] as Array<"GET" | "HEAD">,
    maxRedirects: 1,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    timeoutMs: Math.max(
      2_000,
      Math.min(30_000, Number(process.env.WEBSITE_PROBE_TIMEOUT_MS || 18_000))
    )
  };
}

async function controlledFetch(
  url: string,
  method: "GET" | "HEAD",
  policy: ReturnType<typeof networkPolicy>
) {
  return await createProviderHttpClient(policy).fetch(url, {
    method,
    headers: {
      accept: "text/html,text/plain;q=0.8",
      "user-agent": USER_AGENT
    }
  });
}

async function waitForTeamBudget(teamId: string) {
  const intervalMs = Math.max(
    0,
    Math.min(60_000, Number(process.env.WEBSITE_PROBE_TEAM_INTERVAL_MS || 3_000))
  );
  const waitMs = Math.max(0, (teamNextAllowedAt.get(teamId) || 0) - Date.now());
  if (waitMs) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  teamNextAllowedAt.set(teamId, Date.now() + intervalMs);
}

async function fetchWithOneTransientRetry(
  operation: () => Promise<Response>,
  onRetry: (reason: string) => Promise<void>
) {
  try {
    const first = await operation();
    if (first.status < 500 || first.status > 599) return first;
    await onRetry(`HTTP_${first.status}`);
  } catch (error) {
    if (error instanceof ProviderContractError) throw error;
    await onRetry("NETWORK_ERROR");
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  return await operation();
}

function responseFailure(response: Response) {
  if (response.status === 429) {
    return { outcome: "rate_limited" as const, code: "HTTP_429" };
  }
  return {
    outcome: "unreachable" as const,
    code: `HTTP_${response.status || 0}`
  };
}

function normalizedText(value: unknown, max = 240) {
  return typeof value === "string"
    ? value.replace(/\s+/gu, " ").trim().slice(0, max)
    : "";
}

function organizationNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(organizationNodes);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const nested = organizationNodes(record["@graph"]);
  const rawType = record["@type"];
  const types = (Array.isArray(rawType) ? rawType : [rawType])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLocaleLowerCase("en-US"));
  const isOrganization = types.some((item) =>
    item === "organization"
    || item === "corporation"
    || item.endsWith("business")
  );
  return isOrganization ? [record, ...nested] : nested;
}

function countryValue(value: unknown) {
  if (typeof value === "string") return normalizedText(value, 80);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return normalizedText(record.name || record["@id"], 80);
}

function publicSameDomainEmail(value: unknown, domain: string) {
  if (typeof value !== "string") return "";
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep the original value when a malformed percent escape is present.
  }
  const candidate = decoded
    .replace(/^mailto:/iu, "")
    .split("?")[0]!
    .trim()
    .match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/iu)?.[0]
    .toLocaleLowerCase("en-US") || "";
  if (!candidate || candidate.length > 254) return "";
  const [localPart, hostname] = candidate.split("@");
  if (!localPart || !hostname || /^(?:no-?reply|do-?not-?reply)$/iu.test(localPart)) {
    return "";
  }
  const emailDomain = getDomain(hostname, { allowPrivateDomains: false })
    ?.toLocaleLowerCase("en-US") || "";
  return emailDomain === domain ? candidate : "";
}

function publicContactEmail(
  html: string,
  nodes: Array<Record<string, unknown>>,
  domain: string
) {
  const $ = load(html, { xmlMode: false });
  const values: string[] = [];
  nodes.forEach((node) => {
    const emails = Array.isArray(node.email) ? node.email : [node.email];
    emails.forEach((email) => {
      if (typeof email === "string") values.push(email);
    });
  });
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href") || "";
    if (/^mailto:/iu.test(href)) values.push(href);
  });
  values.push(...($("body").text().match(
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/giu
  ) || []));
  const preferredLocalParts = [
    "sales", "info", "contact", "hello", "export", "business", "office", "support"
  ];
  return [...new Set(values
    .map((value) => publicSameDomainEmail(value, domain))
    .filter(Boolean))]
    .sort((left, right) => {
      const leftRank = preferredLocalParts.indexOf(left.split("@")[0] || "");
      const rightRank = preferredLocalParts.indexOf(right.split("@")[0] || "");
      return (leftRank < 0 ? preferredLocalParts.length : leftRank)
        - (rightRank < 0 ? preferredLocalParts.length : rightRank)
        || left.localeCompare(right);
    })[0] || "";
}

function extractEvidence(
  html: string,
  sourceUrl: string,
  domain: string,
  observedAt: string
): WebsiteProbeEvidence {
  const $ = load(html, { xmlMode: false });
  const nodes: Array<Record<string, unknown>> = [];
  $("script[type='application/ld+json']").each((_index, element) => {
    const text = $(element).text().trim();
    if (!text || text.length > MAX_RESPONSE_BYTES) return;
    try {
      nodes.push(...organizationNodes(JSON.parse(text)));
    } catch {
      // Invalid JSON-LD is ignored; no facts are inferred from broken markup.
    }
  });
  const node = nodes[0] || {};
  const address = node.address && typeof node.address === "object"
    ? node.address as Record<string, unknown>
    : {};
  const pageTitle = normalizedText($("title").first().text(), 200);
  const language = normalizedText($("html").attr("lang"), 30);
  const organizationName = normalizedText(node.name, 200);
  const legalName = normalizedText(node.legalName, 200);
  const addressCountry = countryValue(address.addressCountry);
  const businessCategory = normalizedText(
    node.industry || node.category || node.description,
    240
  );
  const contactEmail = publicContactEmail(html, nodes, domain);
  const facts = {
    canonicalDomain: domain,
    pageTitle,
    language,
    organizationName,
    legalName,
    addressCountry,
    businessCategory,
    publicContactEmail: contactEmail,
    sourceUrl,
    observedAt
  };
  return {
    ...facts,
    payloadHash: sha256(JSON.stringify(facts))
  };
}

async function finishAttempt(
  store: CrmStore,
  candidateId: string,
  attemptId: string,
  persist: PersistCandidate,
  input: {
    status: "completed" | "failed";
    outcome: WebsiteProbeAttempt["outcome"];
    stage: "completed" | "failed";
    message: string;
    failureCode?: string;
    failureMessage?: string;
  }
) {
  await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
    attempt.status = input.status;
    attempt.outcome = input.outcome;
    attempt.failureCode = input.failureCode || "";
    attempt.failureMessage = input.failureMessage || "";
    attempt.completedAt = nowIso();
    appendEvent(
      attempt,
      input.stage,
      input.status === "completed" ? "completed" : "failed",
      input.message,
      { outcome: input.outcome }
    );
  });
}

async function executeAttempt(
  store: CrmStore,
  candidateId: string,
  attemptId: string,
  target: ReturnType<typeof canonicalTarget>,
  persist: PersistCandidate
) {
  const policy = networkPolicy(target.hostname, target.domain);
  try {
    await waitForTeamBudget(candidateById(store, candidateId)!.teamId);
    await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
      attempt.status = "running";
      attempt.startedAt = nowIso();
      appendEvent(attempt, "dns", "started", "正在校验官网域名的全部 DNS 地址");
    });
    const addresses = await resolveProviderPublicAddresses(target.hostname);
    await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
      appendEvent(attempt, "dns", "completed", "DNS 公网检查通过，请求将由安全客户端固定公网地址", {
        addressCount: addresses.length,
        allPublic: true
      });
      appendEvent(attempt, "robots", "started", "正在读取 robots.txt 访问规则");
    });

    const robotsResponse = await fetchWithOneTransientRetry(
      () => controlledFetch(target.robotsUrl, "GET", policy),
      async (reason) => mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
        appendEvent(attempt, "robots", "started", "robots.txt 瞬时失败，正在进行唯一一次重试", {
          retry: 1,
          reason
        });
      })
    );
    if (robotsResponse.status === 401 || robotsResponse.status === 403) {
      await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
        attempt.robotsDecision = "denied";
        attempt.httpStatus = robotsResponse.status;
        appendEvent(attempt, "robots", "completed", "robots.txt 或站点策略拒绝自动访问，探针停止", {
          allowed: false,
          httpStatus: robotsResponse.status
        });
      });
      await finishAttempt(store, candidateId, attemptId, persist, {
        status: "completed",
        outcome: "robots_denied",
        stage: "completed",
        message: "官网验证已结束：站点策略不允许访问，候选评分保持不变"
      });
      return;
    }
    if (robotsResponse.status === 429 || robotsResponse.status >= 500) {
      const failure = responseFailure(robotsResponse);
      await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
        attempt.robotsDecision = "unavailable";
        attempt.httpStatus = robotsResponse.status;
        appendEvent(attempt, "robots", "failed", "robots.txt 暂时不可用，未继续访问首页", {
          httpStatus: robotsResponse.status
        });
      });
      await finishAttempt(store, candidateId, attemptId, persist, {
        status: "failed",
        outcome: failure.outcome,
        stage: "failed",
        message: "官网验证已结束：站点暂时不可达，候选评分保持不变",
        failureCode: failure.code,
        failureMessage: "robots.txt 暂时不可用"
      });
      return;
    }
    let robotsAllowed = true;
    if (robotsResponse.ok) {
      const robotsText = await robotsResponse.text();
      robotsAllowed = parseRobots(target.robotsUrl, robotsText)
        .isAllowed(target.homeUrl, USER_AGENT) !== false;
    }
    await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
      attempt.robotsDecision = robotsAllowed ? "allowed" : "denied";
      appendEvent(attempt, "robots", "completed", robotsAllowed
        ? "robots.txt 允许访问官网首页"
        : "robots.txt 禁止访问官网首页，探针停止", {
        allowed: robotsAllowed,
        httpStatus: robotsResponse.status
      });
    });
    if (!robotsAllowed) {
      await finishAttempt(store, candidateId, attemptId, persist, {
        status: "completed",
        outcome: "robots_denied",
        stage: "completed",
        message: "官网验证已结束：robots.txt 禁止访问，候选评分保持不变"
      });
      return;
    }

    await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
      appendEvent(attempt, "head", "started", "正在检查官网首页状态、类型和大小");
    });
    const headResponse = await fetchWithOneTransientRetry(
      () => controlledFetch(target.homeUrl, "HEAD", policy),
      async (reason) => mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
        appendEvent(attempt, "head", "started", "首页预检瞬时失败，正在进行唯一一次重试", {
          retry: 1,
          reason
        });
      })
    );
    if (!headResponse.ok && ![405, 501].includes(headResponse.status)) {
      const failure = responseFailure(headResponse);
      await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
        attempt.httpStatus = headResponse.status;
        appendEvent(attempt, "head", "failed", "官网首页状态检查未通过", {
          httpStatus: headResponse.status
        });
      });
      await finishAttempt(store, candidateId, attemptId, persist, {
        status: "failed",
        outcome: failure.outcome,
        stage: "failed",
        message: "官网验证已结束：首页不可达，候选评分保持不变",
        failureCode: failure.code,
        failureMessage: "官网首页状态检查未通过"
      });
      return;
    }
    const headType = (headResponse.headers.get("content-type") || "")
      .split(";")[0]!.trim().toLocaleLowerCase("en-US");
    const declaredLength = Number(headResponse.headers.get("content-length") || 0);
    if (declaredLength > MAX_RESPONSE_BYTES
      || (headType && !["text/html", "text/plain"].includes(headType))) {
      await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
        attempt.httpStatus = headResponse.status;
        appendEvent(attempt, "head", "completed", "首页内容不符合最小取证策略，已停止读取正文", {
          httpStatus: headResponse.status,
          contentType: headType || "unknown",
          declaredBytes: declaredLength
        });
      });
      await finishAttempt(store, candidateId, attemptId, persist, {
        status: "completed",
        outcome: "no_evidence",
        stage: "completed",
        message: "官网验证已结束：未读取不符合策略的正文，候选评分保持不变"
      });
      return;
    }
    await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
      attempt.httpStatus = headResponse.status;
      attempt.redirected = Boolean(headResponse.url && headResponse.url !== target.homeUrl);
      appendEvent(attempt, "head", "completed", "首页状态和内容类型检查通过", {
        httpStatus: headResponse.status,
        contentType: headType || "unknown",
        declaredBytes: declaredLength,
        redirected: attempt.redirected
      });
      appendEvent(attempt, "body", "started", `正在读取首页正文样本（上限 ${(MAX_RESPONSE_BYTES / 1024).toFixed(0)} KiB）`);
    });

    const bodyResponse = await fetchWithOneTransientRetry(
      () => controlledFetch(target.homeUrl, "GET", policy),
      async (reason) => mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
        appendEvent(attempt, "body", "started", "正文读取瞬时失败，正在进行唯一一次重试", {
          retry: 1,
          reason
        });
      })
    );
    if (!bodyResponse.ok) {
      const failure = responseFailure(bodyResponse);
      await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
        attempt.httpStatus = bodyResponse.status;
        appendEvent(attempt, "body", "failed", "官网正文读取失败", {
          httpStatus: bodyResponse.status
        });
      });
      await finishAttempt(store, candidateId, attemptId, persist, {
        status: "failed",
        outcome: failure.outcome,
        stage: "failed",
        message: "官网验证已结束：正文不可达，候选评分保持不变",
        failureCode: failure.code,
        failureMessage: "官网正文读取失败"
      });
      return;
    }
    const bodyType = (bodyResponse.headers.get("content-type") || "")
      .split(";")[0]!.trim().toLocaleLowerCase("en-US");
    if (bodyType && !["text/html", "text/plain"].includes(bodyType)) {
      await finishAttempt(store, candidateId, attemptId, persist, {
        status: "completed",
        outcome: "no_evidence",
        stage: "completed",
        message: "官网验证已结束：正文类型不符合取证策略，候选评分保持不变"
      });
      return;
    }
    const html = await bodyResponse.text();
    const responseBytes = Buffer.byteLength(html);
    const observedAt = nowIso();
    const evidence = extractEvidence(
      html,
      bodyResponse.url || target.homeUrl,
      target.domain,
      observedAt
    );
    const hasOrganizationEvidence = Boolean(
      evidence.organizationName
      || evidence.legalName
      || evidence.addressCountry
      || evidence.businessCategory
    );
    const hasUsableEvidence = hasOrganizationEvidence
      || Boolean(evidence.publicContactEmail);
    const candidate = candidateById(store, candidateId);
    if (candidate && !candidate.contactInfo && evidence.publicContactEmail) {
      candidate.contactInfo = evidence.publicContactEmail;
    }
    await mutateAttempt(store, candidateId, attemptId, persist, (attempt) => {
      attempt.httpStatus = bodyResponse.status;
      attempt.responseBytes = responseBytes;
      attempt.redirected = attempt.redirected
        || Boolean(bodyResponse.url && bodyResponse.url !== target.homeUrl);
      appendEvent(attempt, "body", "completed", "首页正文样本读取完成，原文不会保存", {
        httpStatus: bodyResponse.status,
        responseBytes,
        contentType: bodyType || "unknown",
        redirected: attempt.redirected
      });
      attempt.evidence = evidence;
      appendEvent(attempt, "evidence", "completed", hasUsableEvidence
        ? "已提取官网公开业务邮箱或组织级弱证据"
        : "未发现可用的公开业务邮箱或组织级结构化证据", {
        organizationName: Boolean(evidence.organizationName || evidence.legalName),
        country: Boolean(evidence.addressCountry),
        businessCategory: Boolean(evidence.businessCategory),
        publicContactEmail: Boolean(evidence.publicContactEmail),
        language: Boolean(evidence.language)
      });
    });
    await finishAttempt(store, candidateId, attemptId, persist, {
      status: "completed",
      outcome: hasUsableEvidence ? "evidence_found" : "no_evidence",
      stage: "completed",
      message: hasUsableEvidence
        ? "官网验证已结束：公开业务邮箱已回填，组织证据仍需交叉验证"
        : "官网验证已结束：未取得公开邮箱或组织级证据，候选评分保持不变"
    });
  } catch (error) {
    const current = attemptById(store, candidateId, attemptId);
    if (current && !["completed", "failed"].includes(current.status)) {
      const policyBlocked = error instanceof ProviderContractError
        && error.code === "PROVIDER_POLICY_BLOCKED";
      await finishAttempt(store, candidateId, attemptId, persist, {
        status: "failed",
        outcome: policyBlocked ? "policy_blocked" : "unreachable",
        stage: "failed",
        message: policyBlocked
          ? "官网验证已结束：安全策略阻止访问，候选评分保持不变"
          : "官网验证已结束：网络访问失败，候选评分保持不变",
        failureCode: policyBlocked ? error.code : "NETWORK_ERROR",
        failureMessage: error instanceof Error ? error.message.slice(0, 500) : "网络访问失败"
      });
    }
  }
}

export async function queueWebsiteProbe(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  actorId: string,
  persist: PersistCandidate
) {
  if (!featureEnabled()) {
    throw new WebsiteProbeError(
      "WEBSITE_PROBE_DISABLED",
      "官网低频验证已由管理员关闭",
      503
    );
  }
  if (candidate.ownerId !== actorId) {
    throw new WebsiteProbeError(
      "WEBSITE_PROBE_NOT_OWNED",
      "只有候选归属业务员可以发起官网低频验证",
      403
    );
  }
  const target = canonicalTarget(candidate);
  const createdAt = nowIso();
  const attempt: WebsiteProbeAttempt = {
    id: `wpa_${randomUUID()}`,
    candidateId: candidate.id,
    teamId: candidate.teamId,
    ownerId: candidate.ownerId,
    domain: target.domain,
    sourceUrl: target.homeUrl,
    purpose: "company_evidence_enrichment",
    accessMode: "controlled_probe",
    policyVersion: POLICY_VERSION,
    status: "queued",
    outcome: "pending",
    robotsDecision: "pending",
    httpStatus: 0,
    responseBytes: 0,
    redirected: false,
    evidence: null,
    events: [],
    failureCode: "",
    failureMessage: "",
    startedAt: "",
    completedAt: "",
    createdAt
  };
  appendEvent(attempt, "queued", "completed", "官网低频验证已排队", {
    domain: target.domain,
    maxBodyBytes: MAX_RESPONSE_BYTES,
    cacheHours: 24,
    maxRedirects: 1
  });
  candidate.websiteProbeAttempts ||= [];
  candidate.websiteProbeAttempts.unshift(attempt);

  const cached = recentCachedAttempt(
    store,
    candidate.teamId,
    target.domain,
    Date.now()
  );
  if (cached && cached.id !== attempt.id) {
    attempt.status = "completed";
    attempt.outcome = cached.outcome;
    attempt.robotsDecision = cached.robotsDecision;
    attempt.httpStatus = cached.httpStatus;
    attempt.responseBytes = 0;
    attempt.redirected = cached.redirected;
    attempt.evidence = cached.evidence ? structuredClone(cached.evidence) : null;
    if (!candidate.contactInfo && attempt.evidence?.publicContactEmail) {
      candidate.contactInfo = attempt.evidence.publicContactEmail;
    }
    attempt.startedAt = createdAt;
    attempt.completedAt = createdAt;
    appendEvent(attempt, "completed", "completed", "已复用团队 24 小时内的同域验证结果，未再次访问官网", {
      cachedAttemptId: cached.id,
      networkAccess: false,
      outcome: cached.outcome
    });
    await persist(candidate);
    return { attempt, replayed: true };
  }
  if (circuitOpen(store, candidate.teamId, target.domain, Date.now())) {
    attempt.status = "failed";
    attempt.outcome = "circuit_open";
    attempt.failureCode = "DOMAIN_CIRCUIT_OPEN";
    attempt.failureMessage = "同域最近三次瞬时访问失败，24 小时熔断已开启";
    attempt.startedAt = createdAt;
    attempt.completedAt = createdAt;
    appendEvent(attempt, "failed", "failed", "官网验证已结束：同域连续失败已熔断，未发起网络访问", {
      networkAccess: false,
      priorTransientFailures: 3
    });
    await persist(candidate);
    return { attempt, replayed: false };
  }

  await persist(candidate);
  const queueKey = `${candidate.teamId}:${target.domain}`;
  const previous = domainQueues.get(queueKey) || Promise.resolve();
  const work = previous
    .catch(() => undefined)
    .then(() => executeAttempt(
      store,
      candidate.id,
      attempt.id,
      target,
      persist
    ))
    .finally(() => {
      if (domainQueues.get(queueKey) === work) domainQueues.delete(queueKey);
    });
  domainQueues.set(queueKey, work);
  void work.catch(() => undefined);
  return { attempt, replayed: false };
}

export function websiteProbeDetail(
  candidate: WebsiteOpportunity,
  attemptId = ""
) {
  const attempts = candidate.websiteProbeAttempts || [];
  const attempt = attemptId
    ? attempts.find((item) => item.id === attemptId)
    : attempts[0];
  if (!attempt) {
    throw new WebsiteProbeError(
      "WEBSITE_PROBE_ATTEMPT_NOT_FOUND",
      "该候选还没有官网验证记录",
      404
    );
  }
  return {
    enabled: featureEnabled(),
    attempt,
    terminal: attempt.status === "completed" || attempt.status === "failed"
  };
}

export function websiteProbeCapability() {
  return {
    enabled: featureEnabled(),
    policyVersion: POLICY_VERSION,
    defaultOff: false,
    accessMode: "controlled_probe" as const,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    cacheHours: 24,
    maxRedirects: 1
  };
}
