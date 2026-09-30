import { randomUUID } from "node:crypto";
import type {
  ExtractedWebsiteContact,
  ProspectContactEnrichmentAttempt,
  ProspectContactEnrichmentSourceResult,
  ProspectContactEvidenceVerification,
  ProviderEvidenceSnapshot,
  WebsiteOpportunity
} from "./types.js";

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const PHONE_PATTERN = /(?:\+|00)?\d[\d\s().-]{6,}\d/gu;

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedPhone(value: string) {
  const prefix = value.trim().startsWith("+") ? "+" : "";
  const digits = value.replace(/\D/gu, "");
  return digits.length >= 7 ? `${prefix}${digits}` : "";
}

export function contactChannelsFromText(value: string) {
  const emails = unique((value.match(EMAIL_PATTERN) || []).map((item) =>
    item.toLocaleLowerCase("en-US")
  ));
  const phones = unique((value.match(PHONE_PATTERN) || [])
    .map(normalizedPhone)
    .filter(Boolean));
  return { emails, phones };
}

function contactIdentity(contact: ExtractedWebsiteContact) {
  const channels = [
    ...contact.emails.map((value) => `email:${value.toLocaleLowerCase("en-US")}`),
    ...contact.phones.map((value) => `phone:${normalizedPhone(value)}`),
    ...contact.whatsapp.map((value) => `whatsapp:${normalizedPhone(value)}`)
  ].filter((value) => !value.endsWith(":"));
  if (channels.length) return channels.sort()[0]!;
  return [
    contact.kind,
    contact.name.trim().toLocaleLowerCase("en-US"),
    contact.title.trim().toLocaleLowerCase("en-US"),
    contact.source
  ].join("|");
}

const verificationRank: Record<ProspectContactEvidenceVerification, number> = {
  verified: 4,
  source_confirmed: 3,
  syntax_valid: 2,
  unverified: 1
};

function strongerContact(
  left: ExtractedWebsiteContact,
  right: ExtractedWebsiteContact
) {
  const leftVerification = left.verificationStatus || "unverified";
  const rightVerification = right.verificationStatus || "unverified";
  const leftScore = verificationRank[leftVerification] * 100
    + (left.confidence || 0)
    + (left.kind === "person" ? 15 : 0);
  const rightScore = verificationRank[rightVerification] * 100
    + (right.confidence || 0)
    + (right.kind === "person" ? 15 : 0);
  return rightScore > leftScore ? right : left;
}

export function mergeProspectContactEvidence(
  existing: ExtractedWebsiteContact[],
  incoming: ExtractedWebsiteContact[]
) {
  const merged = new Map<string, ExtractedWebsiteContact>();
  for (const candidate of [...existing, ...incoming]) {
    const contact: ExtractedWebsiteContact = {
      ...candidate,
      emails: unique(candidate.emails.map((value) => value.toLocaleLowerCase("en-US"))),
      phones: unique(candidate.phones.map(normalizedPhone).filter(Boolean)),
      whatsapp: unique(candidate.whatsapp.map(normalizedPhone).filter(Boolean)),
      corroboratedSources: candidate.corroboratedSources || [{
        sourceId: candidate.source,
        sourceLabel: candidate.sourceLabel || candidate.source,
        evidenceUrl: candidate.evidenceUrl
      }]
    };
    const key = contactIdentity(contact);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, contact);
      continue;
    }
    const preferred = strongerContact(previous, contact);
    merged.set(key, {
      ...preferred,
      emails: unique([...previous.emails, ...contact.emails]),
      phones: unique([...previous.phones, ...contact.phones]),
      whatsapp: unique([...previous.whatsapp, ...contact.whatsapp]),
      confidence: Math.max(previous.confidence || 0, contact.confidence || 0),
      reasonCodes: unique([
        ...(previous.reasonCodes || []),
        ...(contact.reasonCodes || []),
        "MULTI_SOURCE_DEDUPED"
      ]),
      corroboratedSources: [...new Map([
        ...(previous.corroboratedSources || []),
        ...(contact.corroboratedSources || [])
      ].map((source) => [`${source.sourceId}|${source.evidenceUrl}`, source])).values()]
    });
  }
  return [...merged.values()];
}

function websiteProbeProgress(attempt: NonNullable<WebsiteOpportunity["websiteProbeAttempts"]>[number]) {
  const terminalRank = ["completed", "failed"].includes(attempt.status) ? 1 : 0;
  const lastEventAt = attempt.events.at(-1)?.createdAt || attempt.completedAt || attempt.startedAt || attempt.createdAt;
  return [attempt.events.length, terminalRank, Date.parse(lastEventAt) || 0] as const;
}

function newerWebsiteProbeAttempt(
  left: NonNullable<WebsiteOpportunity["websiteProbeAttempts"]>[number],
  right: NonNullable<WebsiteOpportunity["websiteProbeAttempts"]>[number]
) {
  const leftProgress = websiteProbeProgress(left);
  const rightProgress = websiteProbeProgress(right);
  for (let index = 0; index < leftProgress.length; index += 1) {
    if (leftProgress[index] !== rightProgress[index]) {
      return leftProgress[index]! > rightProgress[index]! ? left : right;
    }
  }
  return right;
}

export function mergeWebsiteProbeCandidateProgress(
  latest: WebsiteOpportunity,
  incoming: WebsiteOpportunity
) {
  const attempts = new Map(
    (latest.websiteProbeAttempts || []).map((attempt) => [attempt.id, attempt])
  );
  for (const incomingAttempt of incoming.websiteProbeAttempts || []) {
    const current = attempts.get(incomingAttempt.id);
    attempts.set(
      incomingAttempt.id,
      structuredClone(current
        ? newerWebsiteProbeAttempt(current, incomingAttempt)
        : incomingAttempt)
    );
  }
  latest.websiteProbeAttempts = [...attempts.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
  latest.extractedContacts = mergeProspectContactEvidence(
    latest.extractedContacts || [],
    incoming.extractedContacts || []
  );
  if (!latest.contactInfo && incoming.contactInfo) latest.contactInfo = incoming.contactInfo;
  if ((!latest.contact?.trim() || /^(?:待维护|待确认|未知|-|—)$/u.test(latest.contact.trim()))
    && incoming.contact?.trim()) {
    latest.contact = incoming.contact;
  }
  return latest;
}

function evidenceUrl(evidence: ProviderEvidenceSnapshot[] | undefined) {
  return evidence?.find((item) => item.sourceUrl)?.sourceUrl
    || evidence?.find((item) => item.officialWebsite)?.officialWebsite
    || "";
}

export function sourceRecordContactEvidence(
  candidate: Pick<WebsiteOpportunity,
    "company" | "contact" | "contactInfo" | "source" | "sourceLabel" | "sourceEvidence" | "createdAt">
): ExtractedWebsiteContact[] {
  const aiAssisted = ["ai_search", "openai_web_search"].includes(
    candidate.source || ""
  );
  const authoritativeContactEvidence = candidate.sourceEvidence?.some((item) =>
    item.matchedFields.includes("contactInfo")
    && ["official", "corroborated"].includes(
      item.fieldAuthority?.contactInfo || ""
    )
  );
  if (aiAssisted && !authoritativeContactEvidence) return [];
  const channels = contactChannelsFromText(candidate.contactInfo || "");
  if (!channels.emails.length && !channels.phones.length) return [];
  const sourceId = candidate.source || candidate.sourceEvidence?.[0]?.providerId || "source_record";
  const sourceLabel = candidate.sourceLabel || sourceId;
  const explicitPerson = candidate.contact?.trim()
    && !/^(?:待维护|待确认|未知|-|—)$/u.test(candidate.contact.trim());
  return [{
    kind: explicitPerson ? "person" : "company",
    name: explicitPerson ? candidate.contact.trim() : candidate.company,
    title: explicitPerson ? "公开来源联系人" : "公司公开联系",
    emails: channels.emails,
    phones: channels.phones,
    whatsapp: [],
    source: sourceId,
    sourceLabel,
    sourceKind: "source_record",
    confidence: 72,
    verificationStatus: "source_confirmed",
    observedAt: candidate.createdAt,
    reasonCodes: ["CONTACT_PRESENT_IN_PROVIDER_RECORD"],
    evidenceUrl: evidenceUrl(candidate.sourceEvidence)
  }];
}

export function providerContactEvidence(input: {
  company: string;
  contact: string;
  contactInfo: string;
  sourceId: string;
  sourceLabel: string;
  sourceUrl: string;
  confidence?: number;
  observedAt?: string;
}) {
  const channels = contactChannelsFromText(input.contactInfo);
  const explicitPerson = input.contact.trim()
    && !/^(?:待维护|待确认|未知|-|—)$/u.test(input.contact.trim());
  if (!channels.emails.length && !channels.phones.length) return [];
  const confidence = Math.max(0, Math.min(100, input.confidence || 65));
  return [{
    kind: explicitPerson ? "person" : "company",
    name: explicitPerson ? input.contact.trim() : input.company,
    title: explicitPerson ? "联系人补全结果" : "公司公开联系",
    emails: channels.emails,
    phones: channels.phones,
    whatsapp: [],
    source: input.sourceId,
    sourceLabel: input.sourceLabel,
    sourceKind: "contact_provider" as const,
    confidence,
    verificationStatus: (confidence >= 90 ? "verified" : "syntax_valid") as ProspectContactEvidenceVerification,
    observedAt: input.observedAt || new Date().toISOString(),
    reasonCodes: [confidence >= 90
      ? "CONTACT_PROVIDER_HIGH_CONFIDENCE"
      : "CONTACT_PROVIDER_RESULT"],
    evidenceUrl: input.sourceUrl
  } satisfies ExtractedWebsiteContact];
}

function bestChannel(contact: ExtractedWebsiteContact) {
  if (contact.emails[0]) return { type: "email" as const, value: contact.emails[0], score: 30 };
  if (contact.whatsapp[0]) return { type: "whatsapp" as const, value: contact.whatsapp[0], score: 20 };
  if (contact.phones[0]) return { type: "phone" as const, value: contact.phones[0], score: 10 };
  return null;
}

export function recommendProspectContact(contacts: ExtractedWebsiteContact[]) {
  return contacts.map((contact) => {
    const channel = bestChannel(contact);
    if (!channel) return null;
    const verification = contact.verificationStatus || "unverified";
    return {
      contact,
      channel,
      score: verificationRank[verification] * 100
        + (contact.confidence || 0)
        + (contact.kind === "person" ? 20 : 0)
        + channel.score
        + Math.min(15, ((contact.corroboratedSources || []).length - 1) * 5)
    };
  }).filter(Boolean).sort((left, right) => right!.score - left!.score)[0] || null;
}

export function createContactEnrichmentAttempt(input: {
  candidate: WebsiteOpportunity;
  runId: string;
  providerSources: Array<{ id: string; label: string; configured: boolean }>;
  includeWebsite: boolean;
  webSearch?: { configured: boolean; label?: string; message?: string; suggestion?: string };
  runner?: { configured: boolean; label?: string; message?: string; suggestion?: string };
  deadlineMs?: number;
}) {
  const now = new Date().toISOString();
  const optionalSource = (
    sourceId: string,
    sourceLabel: string,
    sourceKind: "web_search" | "local_runner",
    plan?: { configured: boolean; label?: string; message?: string; suggestion?: string }
  ): ProspectContactEnrichmentSourceResult | null => plan ? {
    id: `ces_${randomUUID()}`,
    sourceId,
    sourceLabel: plan.label || sourceLabel,
    sourceKind,
    status: plan.configured ? "queued" : "skipped",
    outcome: plan.configured ? "pending" : "not_configured",
    contactCount: 0,
    message: plan.message || (plan.configured ? "等待后台执行" : "当前来源未配置"),
    suggestion: plan.suggestion,
    startedAt: "",
    completedAt: plan.configured ? "" : now
  } : null;
  const sourceContacts = sourceRecordContactEvidence(input.candidate);
  input.candidate.extractedContacts = mergeProspectContactEvidence(
    input.candidate.extractedContacts || [],
    sourceContacts
  );
  const sources: ProspectContactEnrichmentSourceResult[] = [{
    id: `ces_${randomUUID()}`,
    sourceId: input.candidate.source || "source_record",
    sourceLabel: input.candidate.sourceLabel || "候选原始来源",
    sourceKind: "source_record",
    status: "completed",
    outcome: sourceContacts.length ? "contact_found" : "no_contact",
    contactCount: sourceContacts.length,
    message: sourceContacts.length ? "原始公开来源已提供联系方式" : "原始来源未提供可识别联系方式",
    startedAt: now,
    completedAt: now
  }, ...input.providerSources.map((source) => ({
    id: `ces_${randomUUID()}`,
    sourceId: source.id,
    sourceLabel: source.label,
    sourceKind: "contact_provider" as const,
    status: source.configured ? "queued" as const : "skipped" as const,
    outcome: source.configured ? "pending" as const : "not_configured" as const,
    contactCount: 0,
    message: source.configured ? "等待联系人接口返回" : "未配置此联系人来源",
    suggestion: source.configured ? "" : "请由管理员在集成中心配置并测试该联系人接口；未配置不会阻塞其他来源。",
    startedAt: "",
    completedAt: source.configured ? "" : now
  }))];
  const webSearch = optionalSource("native_web_search", "AI 联网搜索", "web_search", input.webSearch);
  if (webSearch) sources.push(webSearch);
  if (input.includeWebsite) {
    sources.push({
      id: `ces_${randomUUID()}`,
      sourceId: "website_probe",
      sourceLabel: "境外企业官网",
      sourceKind: "official_website",
      status: "queued",
      outcome: "pending",
      contactCount: 0,
      message: "等待境外官网公开资料核验",
      suggestion: input.candidate.website
        ? "官网资料核验失败时请检查网址是否正确；系统不会处理登录、验证码或其他受限内容。"
        : "候选尚无可信官网，将先尝试联网发现官网；仍未确认时需要补充官网或配置搜索来源。",
      startedAt: "",
      completedAt: ""
    });
  }
  const runner = optionalSource("codex_runner", "Codex Runner 深度补漏", "local_runner", input.runner);
  if (runner) sources.push(runner);
  const deadlineMs = Math.max(60_000, Math.min(10 * 60_000, input.deadlineMs || 3 * 60_000));
  const attempt: ProspectContactEnrichmentAttempt = {
    id: `cea_${randomUUID()}`,
    runId: input.runId,
    candidateId: input.candidate.id,
    teamId: input.candidate.teamId,
    ownerId: input.candidate.ownerId,
    status: "queued",
    sources,
    recommendedContact: null,
    contactCount: input.candidate.extractedContacts.length,
    summary: "多来源联系人查找已排队",
    deadlineAt: new Date(Date.parse(now) + deadlineMs).toISOString(),
    lastProgressAt: now,
    createdAt: now,
    startedAt: "",
    completedAt: ""
  };
  input.candidate.contactEnrichmentAttempts ||= [];
  input.candidate.contactEnrichmentAttempts.unshift(attempt);
  input.candidate.contactEnrichmentAttempts = input.candidate.contactEnrichmentAttempts.slice(0, 8);
  refreshContactEnrichmentAttempt(input.candidate, attempt);
  return attempt;
}

export function contactEnrichmentSource(
  attempt: ProspectContactEnrichmentAttempt,
  sourceId: string
) {
  return attempt.sources.find((source) => source.sourceId === sourceId);
}

export function refreshContactEnrichmentAttempt(
  candidate: WebsiteOpportunity,
  attempt: ProspectContactEnrichmentAttempt
) {
  attempt.lastProgressAt = new Date().toISOString();
  const contacts = candidate.extractedContacts || [];
  const recommendation = recommendProspectContact(contacts);
  attempt.contactCount = contacts.filter((contact) =>
    contact.emails.length || contact.phones.length || contact.whatsapp.length
  ).length;
  attempt.recommendedContact = recommendation ? {
    contactName: recommendation.contact.name,
    contactTitle: recommendation.contact.title,
    channelType: recommendation.channel.type,
    channelValue: recommendation.channel.value,
    sourceId: recommendation.contact.source,
    sourceLabel: recommendation.contact.sourceLabel || recommendation.contact.source,
    confidence: recommendation.contact.confidence || 0,
    verificationStatus: recommendation.contact.verificationStatus || "unverified",
    reason: recommendation.contact.kind === "person"
      ? "具名联系人且具备可用渠道"
      : "当前可信度最高的公司级公开渠道"
  } : null;
  const pending = attempt.sources.some((source) =>
    source.status === "queued" || source.status === "running"
  );
  const failed = attempt.sources.some((source) => source.status === "failed");
  if (pending) {
    attempt.status = attempt.startedAt ? "running" : "queued";
    attempt.summary = attempt.recommendedContact
      ? "已找到可用联系方式，其他来源仍在交叉核对"
      : "正在并行查询公开来源与境外官网";
    return attempt;
  }
  attempt.completedAt ||= new Date().toISOString();
  attempt.status = attempt.recommendedContact
    ? failed ? "partial" : "completed"
    : failed ? "failed" : "completed";
  attempt.summary = attempt.recommendedContact
    ? `已汇总 ${attempt.contactCount} 条去重联系方式`
    : "已完成查询，当前授权来源未返回可用联系方式";
  return attempt;
}

export function expireContactEnrichmentAttempt(
  candidate: WebsiteOpportunity,
  attempt: ProspectContactEnrichmentAttempt,
  at = new Date()
) {
  if (!attempt.deadlineAt || Date.parse(attempt.deadlineAt) > at.getTime()) return false;
  const pending = attempt.sources.filter((source) =>
    source.status === "queued" || source.status === "running"
  );
  if (!pending.length) return false;
  const completedAt = at.toISOString();
  for (const source of pending) {
    source.status = "failed";
    source.outcome = "timed_out";
    source.completedAt = completedAt;
    source.errorCode = "CONTACT_SOURCE_TIMEOUT";
    source.retryable = true;
    source.message = `${source.sourceLabel}超过任务截止时间仍未返回，系统已停止等待`;
    source.suggestion ||= source.sourceKind === "local_runner"
      ? "请检查本地 Runner 是否在线、Codex CLI 是否可用；恢复后可点击继续查询。"
      : source.sourceKind === "web_search"
        ? "请检查模型 API Key、额度、Base URL 和 Web Search 支持，或减少同时查询的客户数量。"
        : "请检查官网或数据源连接状态，稍后重试；批量任务可适当减少数量。";
  }
  refreshContactEnrichmentAttempt(candidate, attempt);
  attempt.completedAt = completedAt;
  attempt.status = attempt.recommendedContact ? "partial" : "failed";
  attempt.summary = attempt.recommendedContact
    ? `已取得 ${attempt.contactCount} 条联系方式，但 ${pending.length} 个来源超时`
    : `${pending.length} 个来源长时间无返回，查询已结束`;
  return true;
}
