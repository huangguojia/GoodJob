import { createHash } from "node:crypto";
import {
  ORGANIZATION_STRONG_IDENTITY_CONTRACT,
  resolveOrganizationStrongIdentity,
  type OrganizationIdentityAuthorityProfile,
  type ResolveOrganizationStrongIdentityPersistedInput,
  type ResolveOrganizationStrongIdentityResult
} from "./organization-strong-identity.js";
import {
  PROSPECT_COVERAGE_MEMORY_CONTRACT,
  recordProspectCoverage,
  type RecordProspectCoveragePersistedInput,
  type RecordProspectCoverageResult
} from "./prospect-coverage-memory.js";
import {
  ProspectSourceRawError,
  readProspectSourceRawRecord
} from "./prospect-source-raw.js";
import { withProspectVerificationReport } from "./prospect-verification.js";
import type { ProviderRecord } from "./provider-contract.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectSourceRawHit,
  ProviderEvidenceSnapshot,
  WebsiteOpportunity
} from "./types.js";

const CANDIDATE_PIPELINE_VERSION = "prospect-candidate-pipeline-v1";
const GLEIF_AUTHORITY_PROFILE: OrganizationIdentityAuthorityProfile = {
  profileCode: "gleif-company-identity",
  profileVersion: "v1",
  providerCode: "gleif",
  endpointCode: "company-search",
  allowMultiIdentifierSubjectBinding: true,
  rules: [{
    kind: "lei",
    scheme: "iso-17442",
    jurisdictions: ["GLOBAL"],
    entityTypes: ["legal_entity"],
    normalizerVersions: ["gleif-lei-normalizer-v1"],
    validatorVersions: ["iso-17442-mod97-v1"]
  }]
};

const COUNTRY_ALIASES: Record<string, string> = {
  austria: "AT",
  奥地利: "AT",
  australia: "AU",
  澳大利亚: "AU",
  belgium: "BE",
  比利时: "BE",
  brazil: "BR",
  巴西: "BR",
  canada: "CA",
  加拿大: "CA",
  switzerland: "CH",
  瑞士: "CH",
  china: "CN",
  中国: "CN",
  germany: "DE",
  deutschland: "DE",
  德国: "DE",
  spain: "ES",
  西班牙: "ES",
  france: "FR",
  法国: "FR",
  uk: "GB",
  unitedkingdom: "GB",
  greatbritain: "GB",
  英国: "GB",
  indonesia: "ID",
  印度尼西亚: "ID",
  india: "IN",
  印度: "IN",
  italy: "IT",
  意大利: "IT",
  japan: "JP",
  日本: "JP",
  korea: "KR",
  southkorea: "KR",
  韩国: "KR",
  mexico: "MX",
  墨西哥: "MX",
  malaysia: "MY",
  马来西亚: "MY",
  netherlands: "NL",
  holland: "NL",
  荷兰: "NL",
  poland: "PL",
  波兰: "PL",
  russia: "RU",
  俄罗斯: "RU",
  singapore: "SG",
  新加坡: "SG",
  turkey: "TR",
  türkiye: "TR",
  土耳其: "TR",
  taiwan: "TW",
  中国台湾: "TW",
  usa: "US",
  unitedstates: "US",
  unitedstatesofamerica: "US",
  美国: "US",
  vietnam: "VN",
  越南: "VN"
};

export interface ProspectCandidatePipelineOptions {
  store: CrmStore;
  rawEnvelopeSecret: string;
  identitySecret: string;
  coverageSecret: string;
}

export interface ProspectCandidatePipelineFilter {
  teamId?: string;
  ownerId?: string;
  runId?: string;
  ledgerId?: string;
}

export interface ProspectCandidatePipelineFailure {
  hitId: string;
  runId: string;
  ledgerId: string;
  code: string;
}

export interface ProspectCandidatePipelineResult {
  attempted: number;
  processed: number;
  created: number;
  updated: number;
  suppressed: number;
  trustedIdentityResolved: number;
  coverageRecorded: number;
  skipped: number;
  failures: ProspectCandidatePipelineFailure[];
}

interface ProspectCandidateMergeResult {
  created: boolean;
  updated: boolean;
  suppressed: boolean;
  candidateId?: string;
  alreadyProcessed?: boolean;
}

class ProspectCandidatePipelineError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ProspectCandidatePipelineError";
  }
}

function sha256(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function text(value: unknown, max: number) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function normalizeWebsite(value: string) {
  const normalized = value.trim();
  if (!normalized) return "";
  return (/^https?:\/\//iu.test(normalized)
    ? normalized
    : `https://${normalized}`).slice(0, 255);
}

function websiteDomain(value: string) {
  if (!value) return "";
  try {
    return new URL(normalizeWebsite(value))
      .hostname
      .replace(/^www\./iu, "")
      .toLocaleLowerCase("en-US");
  } catch {
    return "";
  }
}

function normalizeCountry(value: string) {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[.\s_()-]+/gu, "");
  if (!normalized || ["unknown", "未知", "待维护", "n/a", "na"].includes(normalized)) {
    return "";
  }
  if (/^[a-z]{2}$/u.test(normalized)) return normalized.toUpperCase();
  return COUNTRY_ALIASES[normalized] || normalized;
}

function validLei(value: string) {
  const normalized = value.trim().toLocaleUpperCase("en-US");
  if (!/^[A-Z0-9]{20}$/u.test(normalized)) return false;
  const expanded = normalized
    .split("")
    .map((character) =>
      /[A-Z]/u.test(character)
        ? String(character.charCodeAt(0) - 55)
        : character
    )
    .join("");
  let remainder = 0;
  for (const character of expanded) {
    remainder = (remainder * 10 + Number(character)) % 97;
  }
  return remainder === 1;
}

function providerRecord(payload: unknown): ProviderRecord {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProspectCandidatePipelineError(
      "CANDIDATE_PAYLOAD_INVALID",
      "Provider 原始结果不是公司候选记录"
    );
  }
  const record = payload as Partial<ProviderRecord>;
  if (!text(record.company, 200)
    || !text(record.providerRecordId, 255)
    || !text(record.payloadHash, 64)
    || !text(record.fetchedAt, 100)
    || !Array.isArray(record.matchedFields)) {
    throw new ProspectCandidatePipelineError(
      "CANDIDATE_PAYLOAD_INVALID",
      "Provider 原始结果缺少候选必需字段"
    );
  }
  if (!Number.isFinite(new Date(record.fetchedAt!).getTime())
    || !/^[a-f0-9]{64}$/iu.test(record.payloadHash!)) {
    throw new ProspectCandidatePipelineError(
      "CANDIDATE_PAYLOAD_INVALID",
      "Provider 原始结果时间或摘要无效"
    );
  }
  return record as ProviderRecord;
}

function evidenceSnapshot(
  providerCode: string,
  record: ProviderRecord
): ProviderEvidenceSnapshot {
  return {
    providerId: providerCode,
    providerRecordId: text(record.providerRecordId, 255),
    officialWebsite: normalizeWebsite(
      text(record.officialWebsite || record.website, 255)
    ),
    sourceUrl: text(record.sourceUrl, 1_000),
    recordType: text(record.recordType, 100),
    fetchedAt: new Date(record.fetchedAt).toISOString(),
    payloadHash: text(record.payloadHash, 64).toLocaleLowerCase("en-US"),
    evidenceSummary: text(record.evidenceSummary, 1_000),
    matchedFields: record.matchedFields
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.slice(0, 100)),
    adapterVersion: text(record.adapterVersion, 100),
    catalogPolicyVersion: text(record.catalogPolicyVersion, 100),
    sourceLevel: text(record.sourceLevel, 100),
    retentionPolicyRef: text(record.retentionPolicyRef, 100)
  };
}

function evidenceKey(item: ProviderEvidenceSnapshot) {
  return [
    item.providerId,
    item.providerRecordId || item.payloadHash,
    item.payloadHash
  ].join(":");
}

function mergeEvidence(
  current: ProviderEvidenceSnapshot[] = [],
  incoming: ProviderEvidenceSnapshot[] = []
) {
  const merged = new Map<string, ProviderEvidenceSnapshot>();
  for (const item of [...current, ...incoming]) {
    merged.set(evidenceKey(item), item);
  }
  return [...merged.values()];
}

function evidenceRecordKeys(evidence: ProviderEvidenceSnapshot[] = []) {
  return new Set(evidence
    .filter((item) => item.providerId && item.providerRecordId)
    .map((item) => `${item.providerId}:${item.providerRecordId}`));
}

function sameCandidate(
  existing: WebsiteOpportunity,
  incoming: WebsiteOpportunity
) {
  if (existing.teamId !== incoming.teamId
    || existing.ownerId !== incoming.ownerId) {
    return false;
  }
  const incomingKeys = evidenceRecordKeys(incoming.sourceEvidence);
  if ([...evidenceRecordKeys(existing.sourceEvidence)]
    .some((key) => incomingKeys.has(key))) {
    return true;
  }
  const existingDomain = websiteDomain(existing.website);
  const incomingDomain = websiteDomain(incoming.website);
  const existingCountry = normalizeCountry(existing.country);
  const incomingCountry = normalizeCountry(incoming.country);
  return Boolean(
    existingDomain
    && incomingDomain
    && existingDomain === incomingDomain
    && existingCountry
    && incomingCountry
    && existingCountry === incomingCountry
  );
}

function hasManualState(opportunity: WebsiteOpportunity) {
  return Boolean(
    opportunity.statusChangedAt
    || opportunity.verifiedAt
    || opportunity.status !== "preview"
    || opportunity.customerId
    || opportunity.dealId
    || opportunity.leadId
    || opportunity.lastDevelopmentEmailAt
    || opportunity.lastDevelopmentEmailSubject
    || opportunity.lastDevelopmentEmailTo
    || opportunity.excludedReason
  );
}

function candidateId(input: {
  teamId: string;
  ownerId: string;
  providerCode: string;
  providerRecordId: string;
  payloadHash: string;
}) {
  return `web_auto_${sha256({
    version: "provider-candidate-id-v1",
    ...input
  }).slice(0, 40)}`;
}

function candidateFromRecord(
  store: CrmStore,
  hit: ProspectSourceRawHit,
  providerCode: string,
  record: ProviderRecord
): WebsiteOpportunity {
  const catalog = store.providerCatalog.find((item) =>
    item.code === providerCode
  );
  const website = normalizeWebsite(
    text(record.officialWebsite || record.website, 255)
  );
  return withProspectVerificationReport({
    id: candidateId({
      teamId: hit.teamId,
      ownerId: hit.ownerId,
      providerCode,
      providerRecordId: record.providerRecordId,
      payloadHash: record.payloadHash
    }),
    company: text(record.company, 200),
    business: text(record.business, 255) || "待维护",
    country: text(record.country, 80) || "未知",
    website,
    contact: text(record.contact, 120) || "待维护",
    contactInfo: text(record.contactInfo, 255),
    description: text(
      record.description
        || record.evidenceSummary
        || "公开来源候选，待业务员核实。",
      4_000
    ),
    ownerId: hit.ownerId,
    teamId: hit.teamId,
    status: "preview",
    createdAt: hit.createdAt,
    parseMode: "rule",
    source: providerCode.slice(0, 40),
    sourceLabel: text(catalog?.name || providerCode, 80),
    sourceEvidence: [evidenceSnapshot(providerCode, record)],
    confidence: typeof record.confidence === "number"
      ? Math.max(0, Math.min(100, Math.round(record.confidence)))
      : undefined
  }, hit.createdAt);
}

function mergeCandidate(
  store: CrmStore,
  incoming: WebsiteOpportunity
) {
  const existing = store.websiteOpportunities.find((item) =>
    sameCandidate(item, incoming)
    || Boolean(
      incoming.organizationId
      && item.organizationId === incoming.organizationId
      && item.teamId === incoming.teamId
      && item.ownerId === incoming.ownerId
    )
  );
  if (!existing) {
    if (store.websiteOpportunities.some((item) =>
      item.id === incoming.id
    )) {
      throw new ProspectCandidatePipelineError(
        "CANDIDATE_ID_CONFLICT",
        "候选确定性标识已被其它记录占用"
      );
    }
    store.websiteOpportunities.unshift(incoming);
    return { candidate: incoming, created: true };
  }
  const sourceEvidence = mergeEvidence(
    existing.sourceEvidence,
    incoming.sourceEvidence
  );
  const confidence = Math.max(
    existing.confidence || 0,
    incoming.confidence || 0
  );
  if (hasManualState(existing)) {
    existing.sourceEvidence = sourceEvidence;
    existing.confidence = confidence;
    existing.tenantProspectId = incoming.tenantProspectId
      || existing.tenantProspectId;
    existing.organizationId = incoming.organizationId
      || existing.organizationId;
    existing.coverageClassification = incoming.coverageClassification
      || existing.coverageClassification;
    existing.coverageQueueState = incoming.coverageQueueState
      || existing.coverageQueueState;
    existing.coverageReasonCode = incoming.coverageReasonCode
      || existing.coverageReasonCode;
    withProspectVerificationReport(existing);
    return { candidate: existing, created: false };
  }
  Object.assign(existing, incoming, {
    id: existing.id,
    createdAt: existing.createdAt,
    status: existing.status,
    customerId: existing.customerId,
    dealId: existing.dealId,
    leadId: existing.leadId,
    sourceEvidence,
    confidence
  });
  withProspectVerificationReport(existing);
  return { candidate: existing, created: false };
}

function existingCandidate(
  store: CrmStore,
  incoming: WebsiteOpportunity
) {
  return store.websiteOpportunities.find((item) =>
    sameCandidate(item, incoming)
    || Boolean(
      incoming.organizationId
      && item.organizationId === incoming.organizationId
      && item.teamId === incoming.teamId
      && item.ownerId === incoming.ownerId
    )
  );
}

function applyCoverageState(
  candidate: WebsiteOpportunity,
  coverage: RecordProspectCoverageResult
) {
  candidate.tenantProspectId = coverage.prospect.id;
  candidate.organizationId = coverage.prospect.organizationId;
  candidate.coverageClassification = coverage.classification;
  candidate.coverageQueueState = coverage.prospect.queueState;
  candidate.coverageReasonCode = coverage.event.reasonCode;
  if (coverage.prospect.status === "excluded"
    || coverage.prospect.status === "do_not_contact") {
    candidate.status = "excluded";
    candidate.excludedReason = coverage.prospect.exclusionReasonCode
      || coverage.event.reasonCode
      || "团队覆盖规则已排除";
    candidate.statusChangedAt = coverage.prospect.updatedAt;
  } else if (coverage.prospect.status === "converted") {
    candidate.status = "synced";
    candidate.leadId = coverage.prospect.leadId || candidate.leadId;
    candidate.customerId =
      coverage.prospect.customerId || candidate.customerId;
    candidate.dealId = coverage.prospect.dealId || candidate.dealId;
    candidate.statusChangedAt = coverage.prospect.updatedAt;
  }
  withProspectVerificationReport(
    candidate,
    coverage.prospect.updatedAt
  );
}

function failureCode(error: unknown) {
  if (error instanceof ProspectSourceRawError
    || error instanceof ProspectCandidatePipelineError) {
    return error.code;
  }
  if (typeof error === "object"
    && error !== null
    && "code" in error) {
    return String((error as { code?: unknown }).code || "UNCLASSIFIED");
  }
  return "UNCLASSIFIED";
}

function candidateMutation<T>(
  store: CrmStore,
  operation: () => T
) {
  const processingStates = store.prospectCandidateProcessingStates ||= [];
  const previousCandidates = structuredClone(store.websiteOpportunities);
  const previousProcessingStates = structuredClone(processingStates);
  const rollback = () => {
    store.websiteOpportunities.splice(
      0,
      store.websiteOpportunities.length,
      ...structuredClone(previousCandidates)
    );
    processingStates.splice(
      0,
      processingStates.length,
      ...structuredClone(previousProcessingStates)
    );
  };
  try {
    return {
      value: operation(),
      rollback
    };
  } catch (error) {
    rollback();
    throw error;
  }
}

export class ProspectCandidatePipeline {
  private readonly store: CrmStore;
  private readonly rawEnvelopeSecret: string;
  private readonly identitySecret: string;
  private readonly coverageSecret: string;
  constructor(options: ProspectCandidatePipelineOptions) {
    this.store = options.store;
    this.rawEnvelopeSecret = options.rawEnvelopeSecret;
    this.identitySecret = options.identitySecret;
    this.coverageSecret = options.coverageSecret;
  }

  async processPending(
    filter: ProspectCandidatePipelineFilter = {}
  ): Promise<ProspectCandidatePipelineResult> {
    const terminalHitIds = new Set(
      (this.store.prospectCandidateProcessingStates || [])
        .map((item) => item.hitId)
    );
    const hits = this.store.prospectSourceRawHits
      .filter((hit) =>
        !terminalHitIds.has(hit.id)
        && (!filter.teamId || hit.teamId === filter.teamId)
        && (!filter.ownerId || hit.ownerId === filter.ownerId)
        && (!filter.runId || hit.runId === filter.runId)
        && (!filter.ledgerId || hit.ledgerId === filter.ledgerId)
      )
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.ordinal - right.ordinal
      );
    const result: ProspectCandidatePipelineResult = {
      attempted: hits.length,
      processed: 0,
      created: 0,
      updated: 0,
      suppressed: 0,
      trustedIdentityResolved: 0,
      coverageRecorded: 0,
      skipped: 0,
      failures: []
    };
    for (const hit of hits) {
      try {
        const outcome = await this.processHit(hit);
        if (outcome.alreadyProcessed) {
          result.skipped += 1;
          continue;
        }
        result.processed += 1;
        result.created += outcome.created ? 1 : 0;
        result.updated += outcome.updated ? 1 : 0;
        result.suppressed += outcome.suppressed ? 1 : 0;
        result.trustedIdentityResolved += outcome.trustedIdentityResolved
          ? 1
          : 0;
        result.coverageRecorded += outcome.coverageRecorded ? 1 : 0;
      } catch (error) {
        const code = failureCode(error);
        if (code === "PROSPECT_SOURCE_RAW_ENVELOPE_INVALID"
          || code === "CANDIDATE_PAYLOAD_INVALID") {
          try {
            await this.persistCandidateTerminal(
              hit,
              "rejected",
              code,
              () => ({
                created: false,
                updated: false,
                suppressed: false
              })
            );
            result.skipped += 1;
          } catch (persistError) {
            result.failures.push({
              hitId: hit.id,
              runId: hit.runId,
              ledgerId: hit.ledgerId,
              code: failureCode(persistError)
            });
            continue;
          }
        }
        result.failures.push({
          hitId: hit.id,
          runId: hit.runId,
          ledgerId: hit.ledgerId,
          code
        });
      }
    }
    return result;
  }

  private async processHit(hit: ProspectSourceRawHit) {
    const raw = readProspectSourceRawRecord(this.store, {
      teamId: hit.teamId,
      ownerId: hit.ownerId,
      recordId: hit.recordId,
      envelopeSecret: this.rawEnvelopeSecret
    });
    const record = providerRecord(raw.plaintext.payload);
    const providerCode = raw.record.providerCode;
    const incoming = candidateFromRecord(
      this.store,
      hit,
      providerCode,
      record
    );
    let trustedIdentityResolved = false;
    let coverageRecorded = false;
    let created = false;
    let updated = false;
    let suppressed = false;
    if (providerCode === "gleif"
      && raw.record.endpointCode === "company-search"
      && validLei(record.providerRecordId)) {
      const identity = await this.resolveGleifIdentity(
        hit,
        raw.record.id,
        record
      );
      trustedIdentityResolved = true;
      const coverage = await this.recordCoverage(hit, identity, record);
      coverageRecorded = true;
      incoming.tenantProspectId = coverage.prospect.id;
      incoming.organizationId = coverage.prospect.organizationId;
      incoming.coverageClassification = coverage.classification;
      incoming.coverageQueueState = coverage.prospect.queueState;
      incoming.coverageReasonCode = coverage.event.reasonCode;
      const merged = await this.persistCandidateMerge(hit, () => {
        const existing = existingCandidate(this.store, incoming);
        if (coverage.queueAction !== "enqueue" && !existing) {
          return {
            created: false,
            updated: false,
            suppressed: true,
            candidateId: undefined
          };
        }
        const outcome = mergeCandidate(this.store, incoming);
        applyCoverageState(outcome.candidate, coverage);
        return {
          created: outcome.created,
          updated: !outcome.created,
          suppressed: coverage.queueAction !== "enqueue",
          candidateId: outcome.candidate.id
        };
      });
      if (merged.alreadyProcessed) {
        return {
          ...merged,
          trustedIdentityResolved: false,
          coverageRecorded: false
        };
      }
      created = merged.created;
      updated = merged.updated;
      suppressed = merged.suppressed;
    } else {
      const merged = await this.persistCandidateMerge(hit, () => {
        const outcome = mergeCandidate(this.store, incoming);
        return {
          created: outcome.created,
          updated: !outcome.created,
          suppressed: false,
          candidateId: outcome.candidate.id
        };
      });
      if (merged.alreadyProcessed) {
        return {
          ...merged,
          trustedIdentityResolved: false,
          coverageRecorded: false
        };
      }
      created = merged.created;
      updated = merged.updated;
    }
    return {
      created,
      updated,
      suppressed,
      trustedIdentityResolved,
      coverageRecorded
    };
  }

  private async persistCandidateMerge(
    hit: ProspectSourceRawHit,
    operation: () => ProspectCandidateMergeResult
  ) {
    return this.persistCandidateTerminal(
      hit,
      "completed",
      "",
      operation
    );
  }

  private async persistCandidateTerminal(
    hit: ProspectSourceRawHit,
    status: "completed" | "rejected",
    failure: string,
    operation: () => ProspectCandidateMergeResult
  ) {
    const mutation = () => candidateMutation(this.store, () => {
      const processingStates =
        this.store.prospectCandidateProcessingStates ||= [];
      const existing = processingStates.find((item) =>
        item.hitId === hit.id
      );
      if (existing) {
        if (existing.teamId !== hit.teamId
          || existing.ownerId !== hit.ownerId
          || existing.runId !== hit.runId
          || existing.ledgerId !== hit.ledgerId) {
          throw new ProspectCandidatePipelineError(
            "CANDIDATE_PROCESSING_SCOPE_CONFLICT",
            "候选处理状态与原始命中隔离范围冲突"
          );
        }
        return {
          created: false,
          updated: false,
          suppressed: false,
          candidateId: existing.candidateId,
          alreadyProcessed: true
        };
      }
      const outcome = operation();
      const processedAt = new Date().toISOString();
      processingStates.push({
        hitId: hit.id,
        teamId: hit.teamId,
        ownerId: hit.ownerId,
        runId: hit.runId,
        ledgerId: hit.ledgerId,
        status,
        failureCode: failure,
        candidateId: outcome.candidateId,
        processedAt,
        updatedAt: processedAt
      });
      return outcome;
    });
    if (this.store.persistProspectCandidateMutation) {
      return this.store.persistProspectCandidateMutation(mutation);
    }
    const applied = mutation();
    try {
      await this.store.persist();
      return applied.value;
    } catch (error) {
      applied.rollback();
      throw error;
    }
  }

  private async resolveGleifIdentity(
    hit: ProspectSourceRawHit,
    rawRecordId: string,
    record: ProviderRecord
  ) {
    const observedAt = new Date(record.fetchedAt).toISOString();
    const subjectRef = `gleif:${record.providerRecordId
      .trim()
      .toLocaleUpperCase("en-US")}`;
    const persistedInput: ResolveOrganizationStrongIdentityPersistedInput = {
      teamId: hit.teamId,
      ownerId: hit.ownerId,
      rawRecordId,
      resolverVersion: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
      parserVersion: CANDIDATE_PIPELINE_VERSION,
      normalizerVersion: CANDIDATE_PIPELINE_VERSION,
      resolvedAt: observedAt,
      authorityProfileCode: GLEIF_AUTHORITY_PROFILE.profileCode,
      authorityProfileVersion: GLEIF_AUTHORITY_PROFILE.profileVersion,
      claims: [{
        kind: "legal_name" as const,
        value: record.company,
        entityType: "legal_entity" as const,
        subjectRef,
        normalizerVersion: "gleif-legal-name-normalizer-v1",
        validatorVersion: "gleif-legal-name-present-v1",
        observedAt
      }, {
        kind: "lei" as const,
        value: record.providerRecordId,
        entityType: "legal_entity" as const,
        subjectRef,
        normalizerVersion: "gleif-lei-normalizer-v1",
        validatorVersion: "iso-17442-mod97-v1",
        observedAt
      }]
    };
    if (this.store.resolveOrganizationStrongIdentity) {
      return this.store.resolveOrganizationStrongIdentity(persistedInput);
    }
    return resolveOrganizationStrongIdentity(this.store, {
      ...persistedInput,
      envelopeSecret: this.rawEnvelopeSecret,
      identitySecret: this.identitySecret,
      authorityProfile: GLEIF_AUTHORITY_PROFILE
    });
  }

  private async recordCoverage(
    hit: ProspectSourceRawHit,
    identity: ResolveOrganizationStrongIdentityResult,
    record: ProviderRecord
  ) {
    const coveredAt = new Date(record.fetchedAt).toISOString();
    const input: RecordProspectCoveragePersistedInput = {
      teamId: hit.teamId,
      ownerId: hit.ownerId,
      resolutionId: identity.resolution.id,
      sourceHitId: hit.id,
      contractVersion: PROSPECT_COVERAGE_MEMORY_CONTRACT,
      evidenceVersion: "material-evidence-v1" as const,
      coveredAt,
      evidence: [{
        kind: "strong_identifier" as const,
        factHash: sha256({
          version: "gleif-lei-evidence-v1",
          lei: record.providerRecordId
            .trim()
            .toLocaleUpperCase("en-US")
        }),
        observedAt: coveredAt
      }]
    };
    if (this.store.recordProspectCoverage) {
      return this.store.recordProspectCoverage(input);
    }
    return recordProspectCoverage(this.store, {
      ...input,
      coverageSecret: this.coverageSecret
    });
  }
}
