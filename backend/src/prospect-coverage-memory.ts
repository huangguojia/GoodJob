import {
  createHash,
  createHmac
} from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectCoverageClassification,
  ProspectCoverageEvent,
  TenantProspect
} from "./types.js";

export const PROSPECT_COVERAGE_MEMORY_CONTRACT =
  "team-prospect-coverage-memory-v1";

const activeTeamLocks = new Set<string>();
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export type ProspectCoverageEvidenceKind =
  | "official_domain"
  | "strong_identifier"
  | "verified_contact"
  | "registration_status"
  | "purchase_signal"
  | "product_signal"
  | "project_signal"
  | "import_signal";

export interface ProspectCoverageEvidenceInput {
  kind: ProspectCoverageEvidenceKind;
  factHash: string;
  observedAt: string;
  expiresAt?: string;
}

export interface RecordProspectCoverageInput {
  teamId: string;
  ownerId: string;
  resolutionId: string;
  sourceHitId: string;
  contractVersion: typeof PROSPECT_COVERAGE_MEMORY_CONTRACT;
  evidenceVersion: "material-evidence-v1";
  coveredAt: string;
  nextReviewAt?: string;
  evidence?: ProspectCoverageEvidenceInput[];
  coverageSecret: string;
}

export type RecordProspectCoveragePersistedInput = Omit<
  RecordProspectCoverageInput,
  "coverageSecret"
>;

export interface RecordProspectCoverageResult {
  idempotent: boolean;
  classification: ProspectCoverageClassification;
  queueAction: ProspectCoverageEvent["queueAction"];
  prospect: TenantProspect;
  event: ProspectCoverageEvent;
}

export interface SetTenantProspectDispositionInput {
  teamId: string;
  ownerId: string;
  prospectId: string;
  requestId: string;
  operationCode: "set_tenant_prospect_disposition_v1";
  action: Exclude<TenantProspectDispositionAction, "">;
  reasonCode: string;
  effectiveAt: string;
  exclusionScope?: "organization" | "team";
  excludedUntil?: string;
  nextReviewAt?: string;
  leadId?: string;
  customerId?: string;
  dealId?: string;
  coverageSecret: string;
}

export type SetTenantProspectDispositionPersistedInput = Omit<
  SetTenantProspectDispositionInput,
  "coverageSecret"
>;

export interface SetTenantProspectDispositionResult {
  idempotent: boolean;
  prospect: TenantProspect;
  event: ProspectCoverageEvent;
}

type TenantProspectDispositionAction =
  ProspectCoverageEvent["dispositionAction"];

type NormalizedCoverageEvidence = {
  kind: ProspectCoverageEvidenceKind | "legal_name";
  factHash: string;
  observedAt: string;
  expiresAt: string;
};

export class ProspectCoverageMemoryError extends Error {
  constructor(
    public readonly code:
      | "PROSPECT_COVERAGE_INVALID"
      | "PROSPECT_COVERAGE_NOT_ELIGIBLE"
      | "PROSPECT_COVERAGE_REPLAY_CONFLICT"
      | "PROSPECT_COVERAGE_TEAM_BUSY"
      | "PROSPECT_COVERAGE_MYSQL_TRANSACTION_REQUIRED"
      | "PROSPECT_COVERAGE_CONFIGURATION_INVALID"
      | "PROSPECT_COVERAGE_DATA_INTEGRITY_VIOLATION"
      | "PROSPECT_COVERAGE_CONCURRENCY_RETRY_EXHAUSTED"
      | "PROSPECT_COVERAGE_CACHE_UNAVAILABLE"
      | "PROSPECT_COVERAGE_COMMIT_OUTCOME_UNKNOWN",
    message: string
  ) {
    super(message);
    this.name = "ProspectCoverageMemoryError";
  }
}

function invalid(message: string): never {
  throw new ProspectCoverageMemoryError(
    "PROSPECT_COVERAGE_INVALID",
    message
  );
}

function integrityError(message: string): never {
  throw new ProspectCoverageMemoryError(
    "PROSPECT_COVERAGE_DATA_INTEGRITY_VIOLATION",
    message
  );
}

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") {
    integrityError("覆盖记忆事实无法 Canonical 化");
  }
  return result;
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function hmac(secret: string, value: unknown) {
  return createHmac("sha256", secret)
    .update(canonical(value))
    .digest("hex");
}

function requireText(value: string, label: string, max = 500) {
  if (typeof value !== "string"
    || !value.trim()
    || value.length > max) {
    invalid(`${label} 无效`);
  }
  return value.trim();
}

function requireOptionalText(value: string | undefined, label: string) {
  if (value === undefined || value === "") return "";
  return requireText(value, label);
}

function requireHash(value: string, label: string) {
  const normalized = requireText(value, label, 64).toLowerCase();
  if (!HASH_PATTERN.test(normalized)) invalid(`${label} 必须为 SHA-256`);
  return normalized;
}

function normalizeIso(value: string, label: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) invalid(`${label} 不是有效时间`);
  return new Date(time).toISOString();
}

function normalizeOptionalIso(value: string | undefined, label: string) {
  if (!value) return "";
  return normalizeIso(value, label);
}

function requireSecret(secret: string) {
  const normalized = requireText(secret, "覆盖记忆密钥", 10_000);
  if (Buffer.byteLength(normalized, "utf8") < 32) {
    invalid("覆盖记忆密钥至少需要 32 字节");
  }
  return normalized;
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function withTeamLock<T>(teamId: string, operation: () => T): T {
  if (activeTeamLocks.has(teamId)) {
    throw new ProspectCoverageMemoryError(
      "PROSPECT_COVERAGE_TEAM_BUSY",
      "同一团队覆盖记忆正在处理其它写入"
    );
  }
  activeTeamLocks.add(teamId);
  try {
    return operation();
  } finally {
    activeTeamLocks.delete(teamId);
  }
}

function tenantProspectWithoutHash(prospect: TenantProspect) {
  const { prospectHash: _prospectHash, ...rest } = prospect;
  return rest;
}

function coverageEventWithoutHash(event: ProspectCoverageEvent) {
  const { eventHash: _eventHash, ...rest } = event;
  return rest;
}

export function tenantProspectFactHash(
  prospect: TenantProspect,
  secret: string
) {
  return hmac(secret, {
    contract: PROSPECT_COVERAGE_MEMORY_CONTRACT,
    fact: "tenant_prospect",
    ...tenantProspectWithoutHash(prospect)
  });
}

export function prospectCoverageEventFactHash(
  event: ProspectCoverageEvent,
  secret: string
) {
  return hmac(secret, {
    contract: PROSPECT_COVERAGE_MEMORY_CONTRACT,
    fact: "prospect_coverage_event",
    ...coverageEventWithoutHash(event)
  });
}

function normalizedEvidence(
  input: readonly ProspectCoverageEvidenceInput[]
) {
  const normalized = input.map((item): NormalizedCoverageEvidence => {
    const observedAt = normalizeIso(item.observedAt, "覆盖证据观察时间");
    const expiresAt = normalizeOptionalIso(
      item.expiresAt,
      "覆盖证据失效时间"
    );
    if (expiresAt && expiresAt <= observedAt) {
      invalid("覆盖证据失效时间必须晚于观察时间");
    }
    return {
      kind: item.kind,
      factHash: requireHash(item.factHash, "覆盖证据事实摘要"),
      observedAt,
      expiresAt
    };
  });
  normalized.sort((left, right) =>
    left.kind.localeCompare(right.kind)
    || left.factHash.localeCompare(right.factHash)
    || left.observedAt.localeCompare(right.observedAt)
    || left.expiresAt.localeCompare(right.expiresAt)
  );
  const seen = new Set<string>();
  return normalized.filter((item) => {
    const key = `${item.kind}\u0000${item.factHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function verifiedCoverageContext(
  store: CrmStore,
  input: {
    teamId: string;
    ownerId: string;
    resolutionId: string;
    sourceHitId: string;
  }
) {
  const resolutions = store.organizationIdentityResolutions.filter((item) =>
    item.id === input.resolutionId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
  );
  if (resolutions.length !== 1) {
    invalid("企业身份 Resolution 不存在或不属于当前业务员");
  }
  const resolution = resolutions[0]!;
  if (!["new_entity", "exact_match"].includes(resolution.result)
    || !resolution.organizationId
    || !resolution.bindingId) {
    throw new ProspectCoverageMemoryError(
      "PROSPECT_COVERAGE_NOT_ELIGIBLE",
      "只有完成强身份绑定的企业才能进入团队覆盖记忆"
    );
  }
  const organizations = store.organizations.filter((item) =>
    item.id === resolution.organizationId
    && item.teamId === input.teamId
    && item.status === "active"
  );
  if (organizations.length !== 1) {
    integrityError("覆盖记忆引用的企业不存在或不唯一");
  }
  const bindings = store.organizationSourceBindings.filter((item) =>
    item.id === resolution.bindingId
    && item.organizationId === resolution.organizationId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
    && item.rawRecordId === resolution.rawRecordId
    && item.status === "active"
  );
  if (bindings.length !== 1) {
    integrityError("覆盖记忆引用的企业来源绑定不存在或不唯一");
  }
  const rawRecords = store.prospectSourceRawRecords.filter((item) =>
    item.id === resolution.rawRecordId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
  );
  if (rawRecords.length !== 1) {
    integrityError("覆盖记忆引用的 Provider Raw 不存在或不唯一");
  }
  const sourceHits = store.prospectSourceRawHits.filter((item) =>
    item.id === input.sourceHitId
    && item.recordId === resolution.rawRecordId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
  );
  if (sourceHits.length !== 1) {
    invalid("覆盖记忆来源命中不存在或不属于当前业务员");
  }
  const sourceHit = sourceHits[0]!;
  const runs = store.prospectSearchRuns.filter((item) =>
    item.id === sourceHit.runId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
  );
  if (runs.length !== 1) {
    integrityError("覆盖记忆来源命中缺少唯一搜索运行上下文");
  }
  const run = runs[0]!;
  if (sourceHit.shardId
    && !store.prospectRunShards.some((item) =>
      item.id === sourceHit.shardId
      && item.runId === sourceHit.runId
      && item.teamId === input.teamId
    )) {
    integrityError("覆盖记忆来源命中缺少搜索分片上下文");
  }
  return {
    resolution,
    organization: organizations[0]!,
    rawRecord: rawRecords[0]!,
    sourceHit,
    run
  };
}

function materialEvidenceKeys(
  store: CrmStore,
  context: ReturnType<typeof verifiedCoverageContext>,
  evidence: readonly NormalizedCoverageEvidence[],
  secret: string
) {
  const claimKeys = store.organizationIdentityClaims
    .filter((item) =>
      item.resolutionId === context.resolution.id
      && item.teamId === context.resolution.teamId
      && item.ownerId === context.resolution.ownerId
      && ["legal_name", "official_domain"].includes(item.kind)
    )
    .map((item) => hmac(secret, {
      version: "coverage-material-identity-claim-v1",
      teamId: item.teamId,
      kind: item.kind,
      normalizedValue: item.normalizedValue,
      scheme: item.scheme,
      jurisdiction: item.jurisdiction,
      entityType: item.entityType,
      subjectRef: item.subjectRef
    }));
  const identifierKeys = context.resolution.acceptedIdentifierIds.map((id) =>
    hmac(secret, {
      version: "coverage-material-strong-identifier-v1",
      teamId: context.resolution.teamId,
      identifierId: id
    })
  );
  const supplementalKeys = evidence.map((item) => hmac(secret, {
    version: "coverage-material-supplemental-v1",
    teamId: context.resolution.teamId,
    kind: item.kind,
    factHash: item.factHash
  }));
  return sortedUnique([
    ...claimKeys,
    ...identifierKeys,
    ...supplementalKeys
  ]);
}

function sourceKey(
  context: ReturnType<typeof verifiedCoverageContext>,
  secret: string
) {
  return hmac(secret, {
    version: "coverage-source-key-v1",
    teamId: context.resolution.teamId,
    providerCode: context.rawRecord.providerCode,
    connectionId: context.rawRecord.connectionId,
    endpointCode: context.rawRecord.endpointCode
  });
}

function applicableExclusion(prospect: TenantProspect, at: string) {
  if (prospect.status === "do_not_contact") {
    return { active: true, expired: false, reason: "DO_NOT_CONTACT" };
  }
  if (prospect.exclusionMode === "permanent") {
    return { active: true, expired: false, reason: "PERMANENT_EXCLUSION" };
  }
  if (prospect.exclusionMode === "temporary") {
    if (!prospect.excludedUntil) {
      integrityError("临时排除缺少到期时间");
    }
    if (prospect.excludedUntil > at) {
      return { active: true, expired: false, reason: "TEMPORARY_EXCLUSION" };
    }
    return { active: false, expired: true, reason: "EXCLUSION_EXPIRED" };
  }
  return { active: false, expired: false, reason: "" };
}

function classifyExistingProspect(
  prospect: TenantProspect,
  newEvidenceCount: number,
  coveredAt: string
) {
  const exclusion = applicableExclusion(prospect, coveredAt);
  if (exclusion.active) {
    return {
      classification: "excluded" as const,
      reasonCode: exclusion.reason
    };
  }
  if (exclusion.expired) {
    return {
      classification: "due_review" as const,
      reasonCode: "EXCLUSION_EXPIRED_REQUIRES_REVIEW"
    };
  }
  if (newEvidenceCount > 0) {
    return {
      classification: "new_intelligence" as const,
      reasonCode: "MATERIAL_EVIDENCE_ADDED"
    };
  }
  if (prospect.nextReviewAt && prospect.nextReviewAt <= coveredAt) {
    return {
      classification: "due_review" as const,
      reasonCode: "REVIEW_DATE_REACHED"
    };
  }
  return {
    classification: "duplicate" as const,
    reasonCode: "NO_MATERIAL_CHANGE"
  };
}

function queueTransition(
  prospect: TenantProspect,
  classification: ProspectCoverageClassification,
  reasonCode: string,
  at: string
): ProspectCoverageEvent["queueAction"] {
  if (classification === "excluded") {
    prospect.queueState = "suppressed";
    prospect.queueReasonCode = reasonCode;
    return "suppress";
  }
  if (prospect.status === "converted") {
    prospect.queueState = "converted";
    if (classification !== "duplicate") {
      prospect.queueReasonCode = "CRM_ENTITY_ALREADY_LINKED";
      return "suppress";
    }
    return "none";
  }
  if (["net_new", "new_intelligence", "due_review"].includes(
    classification
  )) {
    if (prospect.queueState !== "pending") {
      prospect.queueState = "pending";
      prospect.queueReasonCode = reasonCode;
      prospect.lastQueuedAt = at;
      return "enqueue";
    }
    return "none";
  }
  return "none";
}

function appendCoverageEvent(
  store: CrmStore,
  prospect: TenantProspect,
  event: ProspectCoverageEvent
) {
  const index = store.tenantProspects.findIndex((item) =>
    item.id === prospect.id && item.teamId === prospect.teamId
  );
  if (index < 0) {
    store.tenantProspects.push(prospect);
  } else {
    store.tenantProspects[index] = prospect;
  }
  store.prospectCoverageEvents.push(event);
}

function replayCoverageEvent(
  store: CrmStore,
  event: ProspectCoverageEvent,
  requestHash: string
) {
  if (event.requestHash !== requestHash) {
    throw new ProspectCoverageMemoryError(
      "PROSPECT_COVERAGE_REPLAY_CONFLICT",
      "相同覆盖处理键收到了不同请求内容"
    );
  }
  const prospects = store.tenantProspects.filter((item) =>
    item.id === event.prospectId && item.teamId === event.teamId
  );
  if (prospects.length !== 1) {
    integrityError("覆盖记忆幂等事件引用的候选不存在或不唯一");
  }
  return prospects[0]!;
}

export function recordProspectCoverage(
  store: CrmStore,
  rawInput: RecordProspectCoverageInput
): RecordProspectCoverageResult {
  if (store.mode === "mysql") {
    throw new ProspectCoverageMemoryError(
      "PROSPECT_COVERAGE_MYSQL_TRANSACTION_REQUIRED",
      "MySQL 覆盖记忆只能通过专用事务提交"
    );
  }
  if (rawInput.contractVersion !== PROSPECT_COVERAGE_MEMORY_CONTRACT
    || rawInput.evidenceVersion !== "material-evidence-v1") {
    invalid("覆盖记忆合同版本无效");
  }
  const secret = requireSecret(rawInput.coverageSecret);
  const teamId = requireText(rawInput.teamId, "覆盖记忆团队", 200);
  const ownerId = requireText(rawInput.ownerId, "覆盖记忆负责人", 200);
  const resolutionId = requireText(
    rawInput.resolutionId,
    "企业身份 Resolution",
    200
  );
  const sourceHitId = requireText(
    rawInput.sourceHitId,
    "Provider 来源命中",
    200
  );
  const coveredAt = normalizeIso(rawInput.coveredAt, "覆盖处理时间");
  const nextReviewAt = normalizeOptionalIso(
    rawInput.nextReviewAt,
    "下次复核时间"
  );
  const evidence = normalizedEvidence(rawInput.evidence || []);
  const context = verifiedCoverageContext(store, {
    teamId,
    ownerId,
    resolutionId,
    sourceHitId
  });
  const incomingEvidenceKeys = materialEvidenceKeys(
    store,
    context,
    evidence,
    secret
  );
  const incomingSourceKey = sourceKey(context, secret);
  const processingKeyHash = hmac(secret, {
    contract: PROSPECT_COVERAGE_MEMORY_CONTRACT,
    operation: "coverage_classified",
    teamId,
    ownerId,
    resolutionId,
    sourceHitId
  });
  const requestHash = hmac(secret, {
    contract: PROSPECT_COVERAGE_MEMORY_CONTRACT,
    teamId,
    ownerId,
    resolutionId,
    sourceHitId,
    coveredAt,
    nextReviewAt,
    evidence,
    organizationId: context.resolution.organizationId,
    rawArtifactHash: context.resolution.rawArtifactHash,
    campaignId: context.run.campaignId,
    strategyId: context.run.strategyId,
    runId: context.sourceHit.runId,
    shardId: context.sourceHit.shardId
  });

  return withTeamLock(teamId, () => {
    const replayEvents = store.prospectCoverageEvents.filter((item) =>
      item.teamId === teamId
      && item.ownerId === ownerId
      && item.processingKeyHash === processingKeyHash
    );
    if (replayEvents.length > 1) {
      integrityError("相同覆盖处理键存在多个事件");
    }
    if (replayEvents.length === 1) {
      const event = replayEvents[0]!;
      const prospect = replayCoverageEvent(store, event, requestHash);
      return {
        idempotent: true,
        classification: event.classification as
          ProspectCoverageClassification,
        queueAction: event.queueAction,
        prospect: structuredClone(prospect),
        event: structuredClone(event)
      };
    }

    const prospectId = `tpr_${hmac(secret, {
      version: "tenant-prospect-id-v1",
      teamId,
      organizationId: context.resolution.organizationId
    }).slice(0, 40)}`;
    const matches = store.tenantProspects.filter((item) =>
      item.teamId === teamId
      && item.organizationId === context.resolution.organizationId
    );
    if (matches.length > 1) {
      integrityError("团队企业存在多个覆盖记忆聚合");
    }
    if (matches.length === 1 && matches[0]!.id !== prospectId) {
      integrityError("团队企业覆盖记忆标识与确定性规则不一致");
    }

    const previous = matches[0] || null;
    const previousEvidence = new Set(
      previous?.materialEvidenceKeyHashes || []
    );
    const previousSources = new Set(previous?.sourceKeyHashes || []);
    const newEvidenceKeyHashes = incomingEvidenceKeys.filter(
      (key) => !previousEvidence.has(key)
    );
    const newSourceKeyHashes = previousSources.has(incomingSourceKey)
      ? []
      : [incomingSourceKey];
    const mergedEvidenceKeys = sortedUnique([
      ...previousEvidence,
      ...incomingEvidenceKeys
    ]);
    const mergedSourceKeys = sortedUnique([
      ...previousSources,
      incomingSourceKey
    ]);

    let classification: ProspectCoverageClassification;
    let reasonCode: string;
    let prospect: TenantProspect;
    if (!previous) {
      classification = "net_new";
      reasonCode = "TEAM_FIRST_COVERAGE";
      prospect = {
        id: prospectId,
        teamId,
        organizationId: context.resolution.organizationId,
        status: "active",
        latestClassification: classification,
        queueState: "none",
        queueReasonCode: "",
        firstSeenAt: coveredAt,
        lastSeenAt: coveredAt,
        lastMaterialChangeAt: coveredAt,
        lastQueuedAt: "",
        lastReviewedAt: "",
        nextReviewAt,
        hitCount: 1,
        sourceCount: mergedSourceKeys.length,
        evidenceCount: mergedEvidenceKeys.length,
        sourceKeyHashes: mergedSourceKeys,
        materialEvidenceKeyHashes: mergedEvidenceKeys,
        exclusionScope: "none",
        exclusionMode: "none",
        exclusionReasonCode: "",
        excludedUntil: "",
        leadId: "",
        customerId: "",
        dealId: "",
        version: 1,
        eventCount: 0,
        eventTailHash: "",
        prospectHash: "",
        createdAt: coveredAt,
        updatedAt: coveredAt
      };
    } else {
      prospect = structuredClone(previous);
      const decision = classifyExistingProspect(
        prospect,
        newEvidenceKeyHashes.length,
        coveredAt
      );
      classification = decision.classification;
      reasonCode = decision.reasonCode;
      prospect.latestClassification = classification;
      prospect.lastSeenAt = coveredAt;
      prospect.hitCount += 1;
      prospect.sourceKeyHashes = mergedSourceKeys;
      prospect.materialEvidenceKeyHashes = mergedEvidenceKeys;
      prospect.sourceCount = mergedSourceKeys.length;
      prospect.evidenceCount = mergedEvidenceKeys.length;
      prospect.version += 1;
      prospect.updatedAt = coveredAt;
      if (newEvidenceKeyHashes.length) {
        prospect.lastMaterialChangeAt = coveredAt;
        if (nextReviewAt) prospect.nextReviewAt = nextReviewAt;
      }
      const exclusion = applicableExclusion(prospect, coveredAt);
      if (exclusion.expired) {
        if (prospect.status === "excluded") prospect.status = "active";
        prospect.exclusionScope = "none";
        prospect.exclusionMode = "none";
        prospect.exclusionReasonCode = "";
        prospect.excludedUntil = "";
      }
    }
    const queueAction = queueTransition(
      prospect,
      classification,
      reasonCode,
      coveredAt
    );
    const previousEventHash = prospect.eventTailHash;
    const sequence = prospect.eventCount + 1;
    const event: ProspectCoverageEvent = {
      id: `pce_${hmac(secret, {
        version: "prospect-coverage-event-id-v1",
        prospectId,
        sequence,
        processingKeyHash
      }).slice(0, 40)}`,
      prospectId,
      teamId,
      ownerId,
      organizationId: prospect.organizationId,
      resolutionId,
      rawRecordId: context.resolution.rawRecordId,
      sourceHitId,
      campaignId: context.run.campaignId,
      strategyId: context.run.strategyId,
      runId: context.sourceHit.runId,
      shardId: context.sourceHit.shardId,
      sequence,
      eventType: "coverage_classified",
      dispositionAction: "",
      classification,
      queueAction,
      reasonCode,
      processingKeyHash,
      requestHash,
      newEvidenceKeyHashes,
      newSourceKeyHashes,
      evidenceSnapshotHash: hmac(secret, {
        version: "coverage-evidence-snapshot-v1",
        teamId,
        prospectId,
        keys: mergedEvidenceKeys
      }),
      sourceSnapshotHash: hmac(secret, {
        version: "coverage-source-snapshot-v1",
        teamId,
        prospectId,
        keys: mergedSourceKeys
      }),
      previousEventHash,
      eventHash: "",
      createdAt: coveredAt
    };
    event.eventHash = prospectCoverageEventFactHash(event, secret);
    prospect.eventCount = sequence;
    prospect.eventTailHash = event.eventHash;
    prospect.prospectHash = tenantProspectFactHash(prospect, secret);
    appendCoverageEvent(store, prospect, event);
    return {
      idempotent: false,
      classification,
      queueAction,
      prospect: structuredClone(prospect),
      event: structuredClone(event)
    };
  });
}

function verifyCrmLink(
  store: CrmStore,
  teamId: string,
  type: "lead" | "customer" | "deal",
  id: string
) {
  if (!id) return;
  const collection = type === "lead"
    ? store.leads
    : type === "customer"
      ? store.customers
      : store.deals;
  if (!collection.some((item) => item.id === id && item.teamId === teamId)) {
    invalid(`关联的 ${type} 不存在或不属于当前团队`);
  }
}

export function setTenantProspectDisposition(
  store: CrmStore,
  rawInput: SetTenantProspectDispositionInput
): SetTenantProspectDispositionResult {
  if (store.mode === "mysql") {
    throw new ProspectCoverageMemoryError(
      "PROSPECT_COVERAGE_MYSQL_TRANSACTION_REQUIRED",
      "MySQL 候选处置只能通过专用事务提交"
    );
  }
  if (rawInput.operationCode !== "set_tenant_prospect_disposition_v1") {
    invalid("候选处置合同版本无效");
  }
  const secret = requireSecret(rawInput.coverageSecret);
  const teamId = requireText(rawInput.teamId, "候选团队", 200);
  const ownerId = requireText(rawInput.ownerId, "处置操作人", 200);
  const prospectId = requireText(rawInput.prospectId, "候选标识", 200);
  const requestId = requireText(rawInput.requestId, "处置请求标识", 500);
  const reasonCode = requireText(rawInput.reasonCode, "处置原因", 200);
  const effectiveAt = normalizeIso(rawInput.effectiveAt, "处置生效时间");
  const excludedUntil = normalizeOptionalIso(
    rawInput.excludedUntil,
    "排除到期时间"
  );
  const nextReviewAt = normalizeOptionalIso(
    rawInput.nextReviewAt,
    "下次复核时间"
  );
  const leadId = requireOptionalText(rawInput.leadId, "线索标识");
  const customerId = requireOptionalText(rawInput.customerId, "客户标识");
  const dealId = requireOptionalText(rawInput.dealId, "商机标识");
  const exclusionScope = rawInput.exclusionScope || "organization";
  if (rawInput.action === "exclude_temporary"
    && (!excludedUntil || excludedUntil <= effectiveAt)) {
    invalid("临时排除必须设置晚于生效时间的到期时间");
  }
  if (rawInput.action === "link_crm" && !leadId && !customerId) {
    invalid("关联 CRM 至少需要一个线索或客户标识");
  }
  verifyCrmLink(store, teamId, "lead", leadId);
  verifyCrmLink(store, teamId, "customer", customerId);
  verifyCrmLink(store, teamId, "deal", dealId);
  const processingKeyHash = hmac(secret, {
    contract: PROSPECT_COVERAGE_MEMORY_CONTRACT,
    operation: "disposition_changed",
    teamId,
    ownerId,
    requestId
  });
  const requestHash = hmac(secret, {
    contract: PROSPECT_COVERAGE_MEMORY_CONTRACT,
    teamId,
    ownerId,
    prospectId,
    action: rawInput.action,
    reasonCode,
    effectiveAt,
    exclusionScope,
    excludedUntil,
    nextReviewAt,
    leadId,
    customerId,
    dealId
  });

  return withTeamLock(teamId, () => {
    const replayEvents = store.prospectCoverageEvents.filter((item) =>
      item.teamId === teamId
      && item.ownerId === ownerId
      && item.processingKeyHash === processingKeyHash
    );
    if (replayEvents.length > 1) {
      integrityError("相同候选处置处理键存在多个事件");
    }
    if (replayEvents.length === 1) {
      const event = replayEvents[0]!;
      const prospect = replayCoverageEvent(store, event, requestHash);
      return {
        idempotent: true,
        prospect: structuredClone(prospect),
        event: structuredClone(event)
      };
    }
    const matches = store.tenantProspects.filter((item) =>
      item.id === prospectId && item.teamId === teamId
    );
    if (matches.length !== 1) {
      invalid("候选不存在或不属于当前团队");
    }
    const prospect = structuredClone(matches[0]!);
    switch (rawInput.action) {
      case "exclude_temporary":
        if (prospect.status !== "converted") prospect.status = "excluded";
        prospect.exclusionScope = exclusionScope;
        prospect.exclusionMode = "temporary";
        prospect.exclusionReasonCode = reasonCode;
        prospect.excludedUntil = excludedUntil;
        prospect.queueState = prospect.status === "converted"
          ? "converted"
          : "suppressed";
        prospect.queueReasonCode = reasonCode;
        break;
      case "exclude_permanent":
        if (prospect.status !== "converted") prospect.status = "excluded";
        prospect.exclusionScope = exclusionScope;
        prospect.exclusionMode = "permanent";
        prospect.exclusionReasonCode = reasonCode;
        prospect.excludedUntil = "";
        prospect.queueState = prospect.status === "converted"
          ? "converted"
          : "suppressed";
        prospect.queueReasonCode = reasonCode;
        break;
      case "do_not_contact":
        prospect.status = "do_not_contact";
        prospect.exclusionScope = exclusionScope;
        prospect.exclusionMode = "permanent";
        prospect.exclusionReasonCode = reasonCode;
        prospect.excludedUntil = "";
        prospect.queueState = "suppressed";
        prospect.queueReasonCode = reasonCode;
        break;
      case "resume":
        prospect.status = prospect.leadId || prospect.customerId
          ? "converted"
          : "active";
        prospect.exclusionScope = "none";
        prospect.exclusionMode = "none";
        prospect.exclusionReasonCode = "";
        prospect.excludedUntil = "";
        prospect.queueState = prospect.status === "converted"
          ? "converted"
          : "none";
        prospect.queueReasonCode = "";
        if (nextReviewAt) prospect.nextReviewAt = nextReviewAt;
        break;
      case "mark_reviewed":
        prospect.lastReviewedAt = effectiveAt;
        prospect.nextReviewAt = nextReviewAt;
        if (prospect.status === "converted") {
          prospect.queueState = "converted";
        } else if (prospect.exclusionMode !== "none"
          || prospect.status === "do_not_contact") {
          prospect.queueState = "suppressed";
          prospect.queueReasonCode = prospect.exclusionReasonCode
            || "EXCLUSION_REQUIRES_EXPLICIT_RESUME";
        } else {
          prospect.queueState = "none";
          prospect.queueReasonCode = "";
        }
        break;
      case "link_crm":
        prospect.status = "converted";
        prospect.leadId = leadId || prospect.leadId;
        prospect.customerId = customerId || prospect.customerId;
        prospect.dealId = dealId || prospect.dealId;
        prospect.queueState = "converted";
        prospect.queueReasonCode = "CRM_ENTITY_ALREADY_LINKED";
        break;
      default:
        invalid("不支持的候选处置动作");
    }
    prospect.version += 1;
    prospect.updatedAt = effectiveAt;
    const sequence = prospect.eventCount + 1;
    const event: ProspectCoverageEvent = {
      id: `pce_${hmac(secret, {
        version: "prospect-coverage-event-id-v1",
        prospectId,
        sequence,
        processingKeyHash
      }).slice(0, 40)}`,
      prospectId,
      teamId,
      ownerId,
      organizationId: prospect.organizationId,
      resolutionId: "",
      rawRecordId: "",
      sourceHitId: "",
      campaignId: "",
      strategyId: "",
      runId: "",
      shardId: "",
      sequence,
      eventType: "disposition_changed",
      dispositionAction: rawInput.action,
      classification: "",
      queueAction: ["exclude_temporary", "exclude_permanent",
        "do_not_contact"].includes(rawInput.action)
        ? "suppress"
        : "none",
      reasonCode,
      processingKeyHash,
      requestHash,
      newEvidenceKeyHashes: [],
      newSourceKeyHashes: [],
      evidenceSnapshotHash: hmac(secret, {
        version: "coverage-evidence-snapshot-v1",
        teamId,
        prospectId,
        keys: prospect.materialEvidenceKeyHashes
      }),
      sourceSnapshotHash: hmac(secret, {
        version: "coverage-source-snapshot-v1",
        teamId,
        prospectId,
        keys: prospect.sourceKeyHashes
      }),
      previousEventHash: prospect.eventTailHash,
      eventHash: "",
      createdAt: effectiveAt
    };
    event.eventHash = prospectCoverageEventFactHash(event, secret);
    prospect.eventCount = sequence;
    prospect.eventTailHash = event.eventHash;
    prospect.prospectHash = tenantProspectFactHash(prospect, secret);
    appendCoverageEvent(store, prospect, event);
    return {
      idempotent: false,
      prospect: structuredClone(prospect),
      event: structuredClone(event)
    };
  });
}

export function listTenantProspects(
  store: CrmStore,
  input: { teamId: string }
) {
  const teamId = requireText(input.teamId, "候选团队", 200);
  return structuredClone(store.tenantProspects.filter((item) =>
    item.teamId === teamId
  ));
}

export function listOwnerProspectCoverageEvents(
  store: CrmStore,
  input: { teamId: string; ownerId: string; prospectId?: string }
) {
  const teamId = requireText(input.teamId, "覆盖事件团队", 200);
  const ownerId = requireText(input.ownerId, "覆盖事件负责人", 200);
  const prospectId = input.prospectId
    ? requireText(input.prospectId, "覆盖事件候选", 200)
    : "";
  return structuredClone(store.prospectCoverageEvents.filter((item) =>
    item.teamId === teamId
    && item.ownerId === ownerId
    && (!prospectId || item.prospectId === prospectId)
  ));
}

export function prospectCoverageSha256(value: unknown) {
  return sha256(value);
}
