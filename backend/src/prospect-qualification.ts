import {
  createHash,
  createHmac,
  randomUUID
} from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { CrmStore } from "./store.js";
import type {
  CompanyVerificationSnapshot,
  ProspectContact,
  ProspectContactChannel,
  ProspectContactChannelType,
  ProspectContactVerificationSnapshot,
  ProspectContactVerificationStatus,
  ProspectContactabilityDecision,
  ProspectEvidence,
  ProspectEvidenceField,
  ProspectEvidenceKind,
  ProspectEvidenceSourceType,
  ProspectIcpAssessmentSnapshot,
  ProspectIcpDimensionScores,
  ProspectIcpPolicySnapshot,
  ProspectIcpWeights,
  ProspectSuppressionEvent,
  ProspectSuppressionScope
} from "./types.js";

export const PROSPECT_QUALIFICATION_CONTRACT =
  "prospect-qualification-gate-v1";
export const PROSPECT_ICP_SCORING_CONTRACT =
  "prospect-icp-scoring-v1";

const DEFAULT_ICP_WEIGHTS: ProspectIcpWeights = {
  productApplicationMatch: 30,
  customerType: 15,
  marketCountry: 10,
  companyAuthenticity: 15,
  purchasingChannelCapability: 15,
  contactability: 10,
  freshness: 5
};

const ACTIVE_VALUES = new Set([
  "active",
  "registered",
  "operating",
  "in_operation",
  "正常",
  "存续",
  "在营"
]);
const INACTIVE_VALUES = new Set([
  "inactive",
  "dissolved",
  "liquidated",
  "struck_off",
  "closed",
  "注销",
  "吊销"
]);

export const PROSPECT_QUALIFICATION_ARRAYS = [
  "prospectEvidence",
  "companyVerificationSnapshots",
  "prospectIcpPolicySnapshots",
  "prospectIcpAssessmentSnapshots",
  "prospectContacts",
  "prospectContactChannels",
  "prospectContactVerificationSnapshots",
  "prospectSuppressionEvents",
  "prospectContactabilityDecisions"
] as const;

export const PROSPECT_QUALIFICATION_RECORD_TYPES = {
  prospectEvidence: "prospect_evidence",
  companyVerificationSnapshots: "company_verification_snapshot",
  prospectIcpPolicySnapshots: "prospect_icp_policy_snapshot",
  prospectIcpAssessmentSnapshots: "prospect_icp_assessment_snapshot",
  prospectContacts: "prospect_contact",
  prospectContactChannels: "prospect_contact_channel",
  prospectContactVerificationSnapshots:
    "prospect_contact_verification_snapshot",
  prospectSuppressionEvents: "prospect_suppression_event",
  prospectContactabilityDecisions: "prospect_contactability_decision"
} as const;

type QualificationRecord =
  | ProspectEvidence
  | CompanyVerificationSnapshot
  | ProspectIcpPolicySnapshot
  | ProspectIcpAssessmentSnapshot
  | ProspectContact
  | ProspectContactChannel
  | ProspectContactVerificationSnapshot
  | ProspectSuppressionEvent
  | ProspectContactabilityDecision;

type BaseCommand = {
  teamId: string;
  ownerId: string;
  actorId: string;
  prospectId: string;
  idempotencyKey: string;
  createdAt?: string;
};

export type ProspectQualificationCommand =
  | (BaseCommand & {
      kind: "append_evidence";
      evidenceKind: ProspectEvidenceKind;
      field: ProspectEvidenceField;
      value: string;
      sourceType: ProspectEvidenceSourceType;
      providerCode: string;
      sourceRef: string;
      excerpt?: string;
      authorityCode?: string;
      observedAt: string;
      expiresAt?: string;
    })
  | (BaseCommand & {
      kind: "compute_company_verification";
      evidenceIds: string[];
      validUntil: string;
    })
  | (BaseCommand & {
      kind: "review_company_verification";
      snapshotId: string;
      decision: "approved" | "rejected";
    })
  | (BaseCommand & {
      kind: "publish_icp_policy";
      campaignId: string;
      campaignVersion: number;
      weights?: ProspectIcpWeights;
      qualifiedThreshold?: number;
      borderlineThreshold?: number;
      productMinimum?: number;
      hardExclusions?: string[];
    })
  | (BaseCommand & {
      kind: "assess_icp";
      policyId: string;
      dimensionScores: ProspectIcpDimensionScores;
      evidenceIds: string[];
      hardGateReasonCodes?: string[];
    })
  | (BaseCommand & {
      kind: "review_icp";
      assessmentId: string;
      decision: "approved" | "rejected";
    })
  | (BaseCommand & {
      kind: "add_contact";
      contactType: ProspectContact["contactType"];
      name?: string;
      department?: string;
      title?: string;
      identityStatus: ProspectContact["identityStatus"];
      sourceEvidenceId: string;
    })
  | (BaseCommand & {
      kind: "add_contact_channel";
      contactId: string;
      channelType: ProspectContactChannelType;
      value: string;
      sourceEvidenceId: string;
      acquiredAt: string;
    })
  | (BaseCommand & {
      kind: "verify_contact_channel";
      channelId: string;
      status: ProspectContactVerificationStatus;
      providerCode: string;
      reasonCode?: string;
      verifiedAt: string;
      expiresAt?: string;
    })
  | (BaseCommand & {
      kind: "set_suppression";
      scope: ProspectSuppressionScope;
      action: "imposed" | "revoked";
      contactId?: string;
      channelId?: string;
      channelType?: ProspectContactChannelType;
      reasonCode: string;
      reasonNote?: string;
      effectiveAt: string;
      expiresAt?: string;
    })
  | (BaseCommand & {
      kind: "evaluate_contactability";
      campaignId: string;
      campaignVersion: number;
      channelId: string;
    })
  | (BaseCommand & {
      kind: "approve_contactability";
      decisionId: string;
    });

export interface ProspectQualificationCommandResult {
  kind: ProspectQualificationCommand["kind"];
  record: QualificationRecord;
  replayed: boolean;
}

export class ProspectQualificationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProspectQualificationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProspectQualificationError(code, message);
}

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") {
    fail("QUALIFICATION_CANONICAL_INVALID", "资格事实无法规范化");
  }
  return result;
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function qualificationSecret() {
  const value = process.env.PROSPECT_QUALIFICATION_MASTER_SECRET
    || process.env.PROSPECT_COVERAGE_MASTER_SECRET
    || process.env.ORGANIZATION_IDENTITY_MASTER_SECRET
    || (process.env.NODE_ENV === "production"
      ? ""
      : "goodjob-prospect-qualification-development-secret-v1");
  if (Buffer.byteLength(value, "utf8") < 32) {
    fail(
      "QUALIFICATION_SECRET_INVALID",
      "PROSPECT_QUALIFICATION_MASTER_SECRET 必须至少包含 32 字节"
    );
  }
  return value;
}

function hmac(value: unknown) {
  return createHmac("sha256", qualificationSecret())
    .update(canonical(value))
    .digest("hex");
}

function required(value: string | undefined, label: string) {
  const normalized = String(value || "").trim();
  if (!normalized) fail("QUALIFICATION_INPUT_INVALID", `${label}不能为空`);
  return normalized;
}

function iso(value: string | undefined, label: string) {
  const parsed = new Date(required(value, label));
  if (!Number.isFinite(parsed.getTime())) {
    fail("QUALIFICATION_INPUT_INVALID", `${label}不是有效时间`);
  }
  return parsed.toISOString();
}

function optionalIso(value: string | undefined, label: string) {
  return value ? iso(value, label) : "";
}

function normalizeList(values: readonly string[]) {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].sort();
}

function commandRequestHash(command: ProspectQualificationCommand) {
  const {
    idempotencyKey: _idempotencyKey,
    createdAt: _createdAt,
    ...request
  } = command;
  return hmac({
    contract: PROSPECT_QUALIFICATION_CONTRACT,
    request
  });
}

function idempotencyHash(command: ProspectQualificationCommand) {
  return hmac({
    contract: PROSPECT_QUALIFICATION_CONTRACT,
    operation: command.kind,
    teamId: command.teamId,
    ownerId: command.ownerId,
    key: required(command.idempotencyKey, "幂等键")
  });
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function recordHash(
  recordType: string,
  value: Omit<QualificationRecord, "recordHash">
) {
  return hmac({
    contract: PROSPECT_QUALIFICATION_CONTRACT,
    recordType,
    value
  });
}

function finalize<T extends Omit<QualificationRecord, "recordHash">>(
  recordType: string,
  value: T
) {
  return {
    ...value,
    recordHash: recordHash(recordType, value)
  } as T & { recordHash: string };
}

function findReplay<T extends QualificationRecord>(
  rows: readonly T[],
  command: ProspectQualificationCommand
) {
  const keyHash = idempotencyHash(command);
  const requestHash = commandRequestHash(command);
  const existing = rows.find((item) =>
    item.idempotencyKeyHash === keyHash
  );
  if (existing && existing.requestHash !== requestHash) {
    fail(
      "QUALIFICATION_IDEMPOTENCY_CONFLICT",
      "同一幂等键已用于不同资格请求"
    );
  }
  return { existing, keyHash, requestHash };
}

function requireProspect(
  store: CrmStore,
  teamId: string,
  prospectId: string
) {
  const prospect = store.tenantProspects.find((item) =>
    item.teamId === teamId && item.id === prospectId
  );
  if (!prospect) fail("PROSPECT_NOT_FOUND", "候选不存在");
  const organization = store.organizations.find((item) =>
    item.teamId === teamId && item.id === prospect.organizationId
  );
  if (!organization) {
    fail("ORGANIZATION_NOT_FOUND", "候选关联企业不存在");
  }
  return { prospect, organization };
}

function ownerEvidence(
  store: CrmStore,
  command: BaseCommand,
  evidenceIds: readonly string[]
) {
  const ids = normalizeList(evidenceIds);
  if (!ids.length) {
    fail("EVIDENCE_REQUIRED", "至少需要一条来源证据");
  }
  const rows = ids.map((evidenceId) => {
    const evidence = store.prospectEvidence.find((item) =>
      item.id === evidenceId
      && item.teamId === command.teamId
      && item.ownerId === command.ownerId
      && item.prospectId === command.prospectId
    );
    if (!evidence) {
      fail("EVIDENCE_NOT_FOUND", "证据不存在或不属于当前业务员");
    }
    return evidence;
  });
  return rows;
}

function latestByCreatedAt<T extends { createdAt: string }>(
  values: readonly T[]
) {
  return values.reduce<T | undefined>((latest, current) =>
    !latest || current.createdAt > latest.createdAt ? current : latest,
  undefined);
}

function isExpired(expiresAt: string, at: string) {
  return Boolean(expiresAt && expiresAt < at);
}

function evidenceSnapshotHash(evidence: readonly ProspectEvidence[]) {
  return sha256(evidence
    .map((item) => ({
      id: item.id,
      recordHash: item.recordHash
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

function appendEvidence(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "append_evidence" }
  >
) {
  const replay = findReplay(store.prospectEvidence, command);
  if (replay.existing) return replay.existing;
  const { organization } = requireProspect(
    store,
    command.teamId,
    command.prospectId
  );
  const normalizedValue = required(command.value, "证据值")
    .trim()
    .toLowerCase();
  const createdAt = iso(
    command.createdAt || new Date().toISOString(),
    "创建时间"
  );
  const evidence = finalize("prospect_evidence", {
    id: id("pe"),
    teamId: command.teamId,
    ownerId: command.ownerId,
    prospectId: command.prospectId,
    organizationId: organization.id,
    kind: command.evidenceKind,
    field: command.field,
    normalizedValue,
    valueHash: hmac({
      field: command.field,
      value: normalizedValue
    }),
    sourceType: command.sourceType,
    providerCode: required(command.providerCode, "Provider"),
    sourceRef: required(command.sourceRef, "来源引用"),
    excerpt: String(command.excerpt || "").trim(),
    authorityCode: String(command.authorityCode || "").trim(),
    observedAt: iso(command.observedAt, "证据观察时间"),
    expiresAt: optionalIso(command.expiresAt, "证据失效时间"),
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt
  });
  store.prospectEvidence.push(evidence);
  return evidence;
}

function computeCompanyVerification(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "compute_company_verification" }
  >
) {
  const replay = findReplay(store.companyVerificationSnapshots, command);
  if (replay.existing) return replay.existing;
  const { organization } = requireProspect(
    store,
    command.teamId,
    command.prospectId
  );
  const createdAt = iso(
    command.createdAt || new Date().toISOString(),
    "创建时间"
  );
  const evidence = ownerEvidence(store, command, command.evidenceIds)
    .filter((item) => !isExpired(item.expiresAt, createdAt));
  if (!evidence.length) {
    fail("EVIDENCE_EXPIRED", "企业核验证据均已过期");
  }

  const authoritative = evidence.filter((item) =>
    item.sourceType === "authoritative_registry"
  );
  const statusValues = authoritative
    .filter((item) => item.field === "operating_status")
    .map((item) => item.normalizedValue);
  const hasActive = statusValues.some((value) => ACTIVE_VALUES.has(value));
  const hasInactive = statusValues.some((value) =>
    INACTIVE_VALUES.has(value)
  );
  const hasStrongIdentifier = authoritative.some((item) =>
    item.field === "registration_number"
  );
  const hasOfficialDomain = evidence.some((item) =>
    item.field === "official_domain"
    && item.sourceType === "official_website"
  );
  const independentSources = new Set(evidence.map((item) =>
    `${item.providerCode}\u0000${item.sourceRef}`
  ));
  const conflictFields: ProspectEvidenceField[] = [
    "registration_number",
    "jurisdiction"
  ];
  const hasConflict = conflictFields.some((field) =>
    new Set(evidence
      .filter((item) => item.field === field)
      .map((item) => item.normalizedValue)
    ).size > 1
  ) || (hasActive && hasInactive);

  let status: CompanyVerificationSnapshot["status"] = "unverified";
  const reasonCodes: string[] = [];
  if (hasConflict) {
    status = "conflicting";
    reasonCodes.push("COMPANY_EVIDENCE_CONFLICT");
  } else if (hasInactive) {
    status = "verified_inactive";
    reasonCodes.push("AUTHORITATIVE_INACTIVE_STATUS");
  } else if (hasActive && hasStrongIdentifier) {
    status = "verified_active";
    reasonCodes.push("AUTHORITATIVE_ACTIVE_WITH_STRONG_IDENTIFIER");
  } else if (hasOfficialDomain && independentSources.size >= 2) {
    status = "partially_verified";
    reasonCodes.push("OFFICIAL_WEBSITE_WITH_INDEPENDENT_SUPPORT");
  } else {
    reasonCodes.push("INSUFFICIENT_COMPANY_EVIDENCE");
  }

  const snapshot = finalize("company_verification_snapshot", {
    id: id("cvs"),
    teamId: command.teamId,
    prospectId: command.prospectId,
    organizationId: organization.id,
    status,
    reasonCodes,
    authorityCodes: normalizeList(evidence.map((item) =>
      item.authorityCode
    )),
    evidenceSnapshotHash: evidenceSnapshotHash(evidence),
    reviewStatus: status === "partially_verified"
      || status === "conflicting"
      ? "pending_review" as const
      : "not_required" as const,
    reviewedBy: "",
    reviewedAt: "",
    validUntil: iso(command.validUntil, "核验有效期"),
    previousSnapshotId: latestByCreatedAt(
      store.companyVerificationSnapshots.filter((item) =>
        item.teamId === command.teamId
        && item.prospectId === command.prospectId
      )
    )?.id || "",
    contractVersion: PROSPECT_QUALIFICATION_CONTRACT,
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt
  });
  store.companyVerificationSnapshots.push(snapshot);
  return snapshot;
}

function reviewCompanyVerification(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "review_company_verification" }
  >
) {
  const replay = findReplay(store.companyVerificationSnapshots, command);
  if (replay.existing) return replay.existing;
  requireProspect(store, command.teamId, command.prospectId);
  const source = store.companyVerificationSnapshots.find((item) =>
    item.id === command.snapshotId
    && item.teamId === command.teamId
    && item.prospectId === command.prospectId
  );
  if (!source) fail("VERIFICATION_NOT_FOUND", "企业核验快照不存在");
  if (command.decision === "approved"
    && source.status !== "partially_verified") {
    fail(
      "VERIFICATION_REVIEW_INVALID",
      "只有部分核验结论可以人工批准"
    );
  }
  const createdAt = iso(
    command.createdAt || new Date().toISOString(),
    "创建时间"
  );
  const { recordHash: _sourceRecordHash, ...sourceValue } = source;
  const snapshot = finalize("company_verification_snapshot", {
    ...sourceValue,
    id: id("cvs"),
    reviewStatus: command.decision,
    reviewedBy: required(command.actorId, "审核人"),
    reviewedAt: createdAt,
    previousSnapshotId: source.id,
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt
  });
  store.companyVerificationSnapshots.push(snapshot);
  return snapshot;
}

function validateWeights(weights: ProspectIcpWeights) {
  const keys = Object.keys(DEFAULT_ICP_WEIGHTS) as Array<
    keyof ProspectIcpWeights
  >;
  const total = keys.reduce((sum, key) => {
    const weight = Number(weights[key]);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
      fail("ICP_POLICY_INVALID", `ICP 权重 ${key} 无效`);
    }
    return sum + weight;
  }, 0);
  if (total !== 100) {
    fail("ICP_POLICY_INVALID", "ICP 权重合计必须为 100");
  }
}

function publishIcpPolicy(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "publish_icp_policy" }
  >
) {
  const replay = findReplay(store.prospectIcpPolicySnapshots, command);
  if (replay.existing) return replay.existing;
  requireProspect(store, command.teamId, command.prospectId);
  const campaignVersion = store.prospectCampaignVersions.find((item) =>
    item.teamId === command.teamId
    && item.campaignId === command.campaignId
    && item.version === command.campaignVersion
  );
  if (!campaignVersion) {
    fail("CAMPAIGN_VERSION_NOT_FOUND", "获客项目版本不存在");
  }
  const weights = command.weights || DEFAULT_ICP_WEIGHTS;
  validateWeights(weights);
  const qualifiedThreshold = command.qualifiedThreshold ?? 70;
  const borderlineThreshold = command.borderlineThreshold ?? 55;
  const productMinimum = command.productMinimum ?? 18;
  if (borderlineThreshold < 0
    || qualifiedThreshold > 100
    || borderlineThreshold >= qualifiedThreshold
    || productMinimum < 0
    || productMinimum > weights.productApplicationMatch) {
    fail("ICP_POLICY_INVALID", "ICP 阈值配置无效");
  }
  const createdAt = iso(
    command.createdAt || new Date().toISOString(),
    "创建时间"
  );
  const policyBase = {
    teamId: command.teamId,
    ownerId: command.ownerId,
    campaignId: command.campaignId,
    campaignVersion: command.campaignVersion,
    campaignContentHash: campaignVersion.contentHash,
    weights,
    qualifiedThreshold,
    borderlineThreshold,
    productMinimum,
    hardExclusions: normalizeList(command.hardExclusions || []),
    scoringContractVersion: PROSPECT_ICP_SCORING_CONTRACT
  };
  const policy = finalize("prospect_icp_policy_snapshot", {
    id: id("icpp"),
    ...policyBase,
    policyHash: sha256(policyBase),
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt
  });
  store.prospectIcpPolicySnapshots.push(policy);
  return policy;
}

function validateDimensionScores(
  scores: ProspectIcpDimensionScores,
  weights: ProspectIcpWeights
) {
  const keys = Object.keys(weights) as Array<keyof ProspectIcpWeights>;
  return keys.reduce((total, key) => {
    const score = Number(scores[key]);
    if (!Number.isFinite(score) || score < 0 || score > weights[key]) {
      fail("ICP_SCORE_INVALID", `ICP 维度 ${key} 分值无效`);
    }
    return total + score;
  }, 0);
}

function latestCompanyVerification(
  store: CrmStore,
  teamId: string,
  prospectId: string
) {
  return latestByCreatedAt(store.companyVerificationSnapshots.filter((item) =>
    item.teamId === teamId && item.prospectId === prospectId
  ));
}

function assessIcp(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "assess_icp" }
  >
) {
  const replay = findReplay(store.prospectIcpAssessmentSnapshots, command);
  if (replay.existing) return replay.existing;
  const { prospect, organization } = requireProspect(
    store,
    command.teamId,
    command.prospectId
  );
  const policy = store.prospectIcpPolicySnapshots.find((item) =>
    item.id === command.policyId
    && item.teamId === command.teamId
    && item.ownerId === command.ownerId
  );
  if (!policy) fail("ICP_POLICY_NOT_FOUND", "ICP 规则快照不存在");
  const evidence = ownerEvidence(store, command, command.evidenceIds);
  const totalScore = validateDimensionScores(
    command.dimensionScores,
    policy.weights
  );
  const hardGateReasonCodes = new Set(normalizeList(
    command.hardGateReasonCodes || []
  ));
  const company = latestCompanyVerification(
    store,
    command.teamId,
    command.prospectId
  );
  if (prospect.status !== "active") {
    hardGateReasonCodes.add("PROSPECT_NOT_ACTIVE");
  }
  if (!company || company.status === "unverified") {
    hardGateReasonCodes.add("COMPANY_NOT_VERIFIED");
  } else if (company.status === "verified_inactive") {
    hardGateReasonCodes.add("COMPANY_INACTIVE");
  } else if (company.status === "conflicting") {
    hardGateReasonCodes.add("COMPANY_IDENTITY_CONFLICT");
  } else if (company.status === "partially_verified"
    && company.reviewStatus !== "approved") {
    hardGateReasonCodes.add("COMPANY_REVIEW_REQUIRED");
  }
  if (command.dimensionScores.productApplicationMatch
    < policy.productMinimum) {
    hardGateReasonCodes.add("PRODUCT_MINIMUM_NOT_MET");
  }
  if (!evidence.some((item) => item.field === "product_match")) {
    hardGateReasonCodes.add("PRODUCT_EVIDENCE_MISSING");
  }

  let result: ProspectIcpAssessmentSnapshot["result"];
  if (hardGateReasonCodes.size) {
    result = "blocked";
  } else if (totalScore >= policy.qualifiedThreshold) {
    result = "qualified";
  } else if (totalScore >= policy.borderlineThreshold) {
    result = "borderline";
  } else {
    result = "not_qualified";
  }
  const createdAt = iso(
    command.createdAt || new Date().toISOString(),
    "创建时间"
  );
  const assessment = finalize("prospect_icp_assessment_snapshot", {
    id: id("icpa"),
    teamId: command.teamId,
    ownerId: command.ownerId,
    prospectId: command.prospectId,
    organizationId: organization.id,
    policyId: policy.id,
    campaignId: policy.campaignId,
    campaignVersion: policy.campaignVersion,
    dimensionScores: command.dimensionScores,
    totalScore,
    result,
    hardGateReasonCodes: [...hardGateReasonCodes].sort(),
    evidenceIds: normalizeList(command.evidenceIds),
    evidenceSnapshotHash: evidenceSnapshotHash(evidence),
    reviewStatus: "pending_review" as const,
    reviewedBy: "",
    reviewedAt: "",
    previousAssessmentId: latestByCreatedAt(
      store.prospectIcpAssessmentSnapshots.filter((item) =>
        item.teamId === command.teamId
        && item.ownerId === command.ownerId
        && item.prospectId === command.prospectId
        && item.policyId === policy.id
      )
    )?.id || "",
    scoringContractVersion: PROSPECT_ICP_SCORING_CONTRACT,
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt
  });
  store.prospectIcpAssessmentSnapshots.push(assessment);
  return assessment;
}

function reviewIcp(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "review_icp" }
  >
) {
  const replay = findReplay(store.prospectIcpAssessmentSnapshots, command);
  if (replay.existing) return replay.existing;
  requireProspect(store, command.teamId, command.prospectId);
  const source = store.prospectIcpAssessmentSnapshots.find((item) =>
    item.id === command.assessmentId
    && item.teamId === command.teamId
    && item.ownerId === command.ownerId
    && item.prospectId === command.prospectId
  );
  if (!source) fail("ICP_ASSESSMENT_NOT_FOUND", "ICP 评分快照不存在");
  if (command.decision === "approved" && source.result !== "qualified") {
    fail("ICP_REVIEW_INVALID", "只有合格的 ICP 评估可以批准");
  }
  const createdAt = iso(
    command.createdAt || new Date().toISOString(),
    "创建时间"
  );
  const { recordHash: _sourceRecordHash, ...sourceValue } = source;
  const assessment = finalize("prospect_icp_assessment_snapshot", {
    ...sourceValue,
    id: id("icpa"),
    reviewStatus: command.decision,
    reviewedBy: required(command.actorId, "审核人"),
    reviewedAt: createdAt,
    previousAssessmentId: source.id,
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt
  });
  store.prospectIcpAssessmentSnapshots.push(assessment);
  return assessment;
}

function requireSourceEvidence(
  store: CrmStore,
  command: BaseCommand,
  evidenceId: string
) {
  return ownerEvidence(store, command, [evidenceId])[0]!;
}

function addContact(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "add_contact" }
  >
) {
  const replay = findReplay(store.prospectContacts, command);
  if (replay.existing) return replay.existing;
  const { organization } = requireProspect(
    store,
    command.teamId,
    command.prospectId
  );
  requireSourceEvidence(store, command, command.sourceEvidenceId);
  const name = String(command.name || "").trim();
  const department = String(command.department || "").trim();
  const title = String(command.title || "").trim();
  if (command.contactType === "named_person" && !name) {
    fail("CONTACT_INPUT_INVALID", "具名联系人必须填写姓名");
  }
  if (command.contactType === "department" && !department) {
    fail("CONTACT_INPUT_INVALID", "部门联系人必须填写部门");
  }
  const contact = finalize("prospect_contact", {
    id: id("pc"),
    teamId: command.teamId,
    ownerId: command.ownerId,
    prospectId: command.prospectId,
    organizationId: organization.id,
    contactType: command.contactType,
    name,
    department,
    title,
    identityStatus: command.identityStatus,
    sourceEvidenceId: command.sourceEvidenceId,
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt: iso(
      command.createdAt || new Date().toISOString(),
      "创建时间"
    )
  });
  store.prospectContacts.push(contact);
  return contact;
}

function normalizeChannelValue(
  channelType: ProspectContactChannelType,
  value: string
) {
  const raw = required(value, "联系方式");
  if (channelType === "email") return raw.toLowerCase();
  if (channelType === "phone" || channelType === "whatsapp") {
    const prefix = raw.trim().startsWith("+") ? "+" : "";
    const digits = raw.replaceAll(/\D/gu, "");
    if (digits.length < 6) {
      fail("CONTACT_CHANNEL_INVALID", "电话或 WhatsApp 号码格式无效");
    }
    return `${prefix}${digits}`;
  }
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    url.hash = "";
    return url.toString();
  } catch {
    fail("CONTACT_CHANNEL_INVALID", "官网表单地址无效");
  }
}

function ownerContact(
  store: CrmStore,
  command: BaseCommand,
  contactId: string
) {
  const contact = store.prospectContacts.find((item) =>
    item.id === contactId
    && item.teamId === command.teamId
    && item.ownerId === command.ownerId
    && item.prospectId === command.prospectId
  );
  if (!contact) fail("CONTACT_NOT_FOUND", "联系人不存在或不可见");
  return contact;
}

function ownerChannel(
  store: CrmStore,
  command: BaseCommand,
  channelId: string
) {
  const channel = store.prospectContactChannels.find((item) =>
    item.id === channelId
    && item.teamId === command.teamId
    && item.ownerId === command.ownerId
    && item.prospectId === command.prospectId
  );
  if (!channel) {
    fail("CONTACT_CHANNEL_NOT_FOUND", "联系方式不存在或不可见");
  }
  return channel;
}

function addContactChannel(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "add_contact_channel" }
  >
) {
  const replay = findReplay(store.prospectContactChannels, command);
  if (replay.existing) return replay.existing;
  const contact = ownerContact(store, command, command.contactId);
  requireSourceEvidence(store, command, command.sourceEvidenceId);
  const value = normalizeChannelValue(command.channelType, command.value);
  const normalizedValueHash = hmac({
    channelType: command.channelType,
    value
  });
  const duplicate = store.prospectContactChannels.find((item) =>
    item.teamId === command.teamId
    && item.ownerId === command.ownerId
    && item.organizationId === contact.organizationId
    && item.channelType === command.channelType
    && item.normalizedValueHash === normalizedValueHash
  );
  if (duplicate) return duplicate;
  const channel = finalize("prospect_contact_channel", {
    id: id("pcc"),
    teamId: command.teamId,
    ownerId: command.ownerId,
    prospectId: command.prospectId,
    organizationId: contact.organizationId,
    contactId: contact.id,
    channelType: command.channelType,
    value,
    normalizedValueHash,
    sourceEvidenceId: command.sourceEvidenceId,
    acquiredAt: iso(command.acquiredAt, "联系方式取得时间"),
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt: iso(
      command.createdAt || new Date().toISOString(),
      "创建时间"
    )
  });
  store.prospectContactChannels.push(channel);
  return channel;
}

function verifyContactChannel(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "verify_contact_channel" }
  >
) {
  const replay = findReplay(
    store.prospectContactVerificationSnapshots,
    command
  );
  if (replay.existing) return replay.existing;
  const channel = ownerChannel(store, command, command.channelId);
  const current = latestByCreatedAt(
    store.prospectContactVerificationSnapshots.filter((item) =>
      item.teamId === command.teamId
      && item.ownerId === command.ownerId
      && item.channelId === channel.id
    )
  );
  const terminal = new Set<ProspectContactVerificationStatus>([
    "bounced",
    "opted_out",
    "invalid"
  ]);
  if (current && terminal.has(current.status)
    && current.status !== command.status) {
    fail(
      "CONTACT_VERIFICATION_TRANSITION_INVALID",
      "终止状态的联系方式不能直接恢复，请新建并重新核验"
    );
  }
  const verification = finalize("prospect_contact_verification_snapshot", {
    id: id("pcv"),
    teamId: command.teamId,
    ownerId: command.ownerId,
    prospectId: command.prospectId,
    organizationId: channel.organizationId,
    contactId: channel.contactId,
    channelId: channel.id,
    status: command.status,
    providerCode: required(command.providerCode, "验证 Provider"),
    reasonCode: String(command.reasonCode || "").trim(),
    verifiedAt: iso(command.verifiedAt, "验证时间"),
    expiresAt: optionalIso(command.expiresAt, "验证失效时间"),
    previousVerificationId: current?.id || "",
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt: iso(
      command.createdAt || new Date().toISOString(),
      "创建时间"
    )
  });
  store.prospectContactVerificationSnapshots.push(verification);
  return verification;
}

function suppressionScopeKey(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "set_suppression" }
  >,
  organizationId: string
) {
  if (command.scope === "organization_all") {
    return {
      contactId: "",
      channelId: "",
      channelType: "" as const,
      rawKey: `organization:${organizationId}:all`
    };
  }
  if (command.scope === "organization_channel") {
    const channelType = command.channelType
      || (command.channelId
        ? ownerChannel(store, command, command.channelId).channelType
        : undefined);
    if (!channelType) {
      fail(
        "SUPPRESSION_INPUT_INVALID",
        "企业通道抑制必须指定通道类型"
      );
    }
    return {
      contactId: "",
      channelId: "",
      channelType,
      rawKey: `organization:${organizationId}:${channelType}`
    };
  }
  const contact = ownerContact(
    store,
    command,
    required(command.contactId, "联系人")
  );
  if (command.scope === "contact_all") {
    return {
      contactId: contact.id,
      channelId: "",
      channelType: "" as const,
      rawKey: `contact:${contact.id}:all`
    };
  }
  const channel = ownerChannel(
    store,
    command,
    required(command.channelId, "联系方式")
  );
  if (channel.contactId !== contact.id) {
    fail("SUPPRESSION_INPUT_INVALID", "联系方式不属于指定联系人");
  }
  return {
    contactId: contact.id,
    channelId: channel.id,
    channelType: channel.channelType,
    rawKey:
      `channel:${channel.channelType}:${channel.normalizedValueHash}`
  };
}

function setSuppression(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "set_suppression" }
  >
) {
  const replay = findReplay(store.prospectSuppressionEvents, command);
  if (replay.existing) return replay.existing;
  const { organization } = requireProspect(
    store,
    command.teamId,
    command.prospectId
  );
  const scope = suppressionScopeKey(store, command, organization.id);
  const scopeKeyHash = hmac({
    teamId: command.teamId,
    scope: command.scope,
    key: scope.rawKey
  });
  const previous = latestByCreatedAt(
    store.prospectSuppressionEvents.filter((item) =>
      item.teamId === command.teamId
      && item.scopeKeyHash === scopeKeyHash
    )
  );
  if (command.action === "revoked"
    && (!previous || previous.action !== "imposed")) {
    fail("SUPPRESSION_REVOKE_INVALID", "没有可撤销的有效抑制记录");
  }
  const event = finalize("prospect_suppression_event", {
    id: id("pse"),
    teamId: command.teamId,
    ownerId: command.ownerId,
    prospectId: command.prospectId,
    organizationId: organization.id,
    contactId: scope.contactId,
    channelId: scope.channelId,
    channelType: scope.channelType,
    scope: command.scope,
    scopeKeyHash,
    action: command.action,
    reasonCode: required(command.reasonCode, "抑制原因"),
    reasonNote: String(command.reasonNote || "").trim(),
    effectiveAt: iso(command.effectiveAt, "生效时间"),
    expiresAt: optionalIso(command.expiresAt, "失效时间"),
    createdBy: required(command.actorId, "操作人"),
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt: iso(
      command.createdAt || new Date().toISOString(),
      "创建时间"
    )
  });
  store.prospectSuppressionEvents.push(event);
  return event;
}

function latestAssessment(
  store: CrmStore,
  input: {
    teamId: string;
    ownerId: string;
    prospectId: string;
    campaignId: string;
    campaignVersion: number;
  }
) {
  return latestByCreatedAt(
    store.prospectIcpAssessmentSnapshots.filter((item) =>
      item.teamId === input.teamId
      && item.ownerId === input.ownerId
      && item.prospectId === input.prospectId
      && item.campaignId === input.campaignId
      && item.campaignVersion === input.campaignVersion
    )
  );
}

function activeSuppressionHashes(
  store: CrmStore,
  input: {
    teamId: string;
    organizationId: string;
    contactId: string;
    channel: ProspectContactChannel;
    at: string;
  }
) {
  const keys = [
    hmac({
      teamId: input.teamId,
      scope: "organization_all",
      key: `organization:${input.organizationId}:all`
    }),
    hmac({
      teamId: input.teamId,
      scope: "organization_channel",
      key:
        `organization:${input.organizationId}:${input.channel.channelType}`
    }),
    hmac({
      teamId: input.teamId,
      scope: "contact_all",
      key: `contact:${input.contactId}:all`
    }),
    hmac({
      teamId: input.teamId,
      scope: "contact_channel",
      key:
        `channel:${input.channel.channelType}:`
        + input.channel.normalizedValueHash
    })
  ];
  return keys.filter((key) => {
    const latest = latestByCreatedAt(
      store.prospectSuppressionEvents.filter((item) =>
        item.teamId === input.teamId && item.scopeKeyHash === key
      )
    );
    return Boolean(latest
      && latest.action === "imposed"
      && latest.effectiveAt <= input.at
      && !isExpired(latest.expiresAt, input.at));
  }).sort();
}

function evaluateGateState(
  store: CrmStore,
  input: {
    teamId: string;
    ownerId: string;
    prospectId: string;
    campaignId: string;
    campaignVersion: number;
    channelId: string;
    at: string;
  }
) {
  const { prospect, organization } = requireProspect(
    store,
    input.teamId,
    input.prospectId
  );
  const channel = ownerChannel(store, {
    ...input,
    actorId: input.ownerId,
    idempotencyKey: "gate-evaluation"
  }, input.channelId);
  const contact = ownerContact(store, {
    ...input,
    actorId: input.ownerId,
    idempotencyKey: "gate-evaluation"
  }, channel.contactId);
  const company = latestCompanyVerification(
    store,
    input.teamId,
    input.prospectId
  );
  const assessment = latestAssessment(store, input);
  const verification = latestByCreatedAt(
    store.prospectContactVerificationSnapshots.filter((item) =>
      item.teamId === input.teamId
      && item.ownerId === input.ownerId
      && item.channelId === channel.id
    )
  );
  const suppressions = activeSuppressionHashes(store, {
    teamId: input.teamId,
    organizationId: organization.id,
    contactId: contact.id,
    channel,
    at: input.at
  });
  const blocked = new Set<string>();
  const review = new Set<string>();

  if (prospect.status !== "active") blocked.add("PROSPECT_NOT_ACTIVE");
  if (!company || isExpired(company.validUntil, input.at)) {
    blocked.add("COMPANY_VERIFICATION_MISSING_OR_EXPIRED");
  } else if (company.status === "verified_inactive") {
    blocked.add("COMPANY_INACTIVE");
  } else if (company.status === "conflicting") {
    blocked.add("COMPANY_IDENTITY_CONFLICT");
  } else if (company.status === "unverified") {
    blocked.add("COMPANY_UNVERIFIED");
  } else if (company.status === "partially_verified"
    && company.reviewStatus !== "approved") {
    review.add("COMPANY_REVIEW_REQUIRED");
  }

  if (!assessment) {
    review.add("ICP_ASSESSMENT_MISSING");
  } else if (assessment.result === "blocked"
    || assessment.result === "not_qualified"
    || assessment.reviewStatus === "rejected") {
    blocked.add("ICP_NOT_QUALIFIED");
  } else if (assessment.result !== "qualified"
    || assessment.reviewStatus !== "approved") {
    review.add("ICP_REVIEW_REQUIRED");
  }

  if (!channel.sourceEvidenceId || !channel.acquiredAt) {
    blocked.add("CONTACT_SOURCE_INCOMPLETE");
  }
  if (!verification || isExpired(verification.expiresAt, input.at)) {
    blocked.add("CONTACT_VERIFICATION_MISSING_OR_EXPIRED");
  } else if (verification.status !== "verified") {
    blocked.add(`CONTACT_${verification.status.toUpperCase()}`);
  }
  if (suppressions.length) blocked.add("SUPPRESSED");

  const status = blocked.size
    ? "blocked" as const
    : review.size
      ? "review_required" as const
      : "eligible" as const;
  const reasonCodes = [...blocked, ...review].sort();
  const dependencyHash = sha256({
    contract: PROSPECT_QUALIFICATION_CONTRACT,
    prospect: {
      id: prospect.id,
      version: prospect.version,
      status: prospect.status,
      prospectHash: prospect.prospectHash
    },
    company: company
      ? { id: company.id, recordHash: company.recordHash }
      : null,
    assessment: assessment
      ? { id: assessment.id, recordHash: assessment.recordHash }
      : null,
    channel: { id: channel.id, recordHash: channel.recordHash },
    verification: verification
      ? { id: verification.id, recordHash: verification.recordHash }
      : null,
    suppressions
  });
  return {
    prospect,
    organization,
    channel,
    status,
    reasonCodes,
    dependencyHash
  };
}

function evaluateContactability(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "evaluate_contactability" }
  >
) {
  const replay = findReplay(store.prospectContactabilityDecisions, command);
  if (replay.existing) return replay.existing;
  const createdAt = iso(
    command.createdAt || new Date().toISOString(),
    "创建时间"
  );
  const result = evaluateGateState(store, {
    teamId: command.teamId,
    ownerId: command.ownerId,
    prospectId: command.prospectId,
    campaignId: command.campaignId,
    campaignVersion: command.campaignVersion,
    channelId: command.channelId,
    at: createdAt
  });
  const decision = finalize("prospect_contactability_decision", {
    id: id("pcd"),
    teamId: command.teamId,
    ownerId: command.ownerId,
    prospectId: command.prospectId,
    organizationId: result.organization.id,
    campaignId: command.campaignId,
    campaignVersion: command.campaignVersion,
    channelId: result.channel.id,
    status: result.status,
    reasonCodes: result.reasonCodes,
    dependencyHash: result.dependencyHash,
    approvedBy: "",
    approvedAt: "",
    previousDecisionId: latestByCreatedAt(
      store.prospectContactabilityDecisions.filter((item) =>
        item.teamId === command.teamId
        && item.ownerId === command.ownerId
        && item.prospectId === command.prospectId
        && item.campaignId === command.campaignId
        && item.campaignVersion === command.campaignVersion
        && item.channelId === command.channelId
      )
    )?.id || "",
    contractVersion: PROSPECT_QUALIFICATION_CONTRACT,
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt
  });
  store.prospectContactabilityDecisions.push(decision);
  return decision;
}

function approveContactability(
  store: CrmStore,
  command: Extract<
    ProspectQualificationCommand,
    { kind: "approve_contactability" }
  >
) {
  const replay = findReplay(store.prospectContactabilityDecisions, command);
  if (replay.existing) return replay.existing;
  const source = store.prospectContactabilityDecisions.find((item) =>
    item.id === command.decisionId
    && item.teamId === command.teamId
    && item.ownerId === command.ownerId
    && item.prospectId === command.prospectId
  );
  if (!source) fail("CONTACTABILITY_NOT_FOUND", "可联系门禁结论不存在");
  if (source.status !== "eligible") {
    fail("CONTACTABILITY_APPROVAL_INVALID", "只有待人工确认的可联系记录可批准");
  }
  const createdAt = iso(
    command.createdAt || new Date().toISOString(),
    "创建时间"
  );
  const current = evaluateGateState(store, {
    teamId: source.teamId,
    ownerId: source.ownerId,
    prospectId: source.prospectId,
    campaignId: source.campaignId,
    campaignVersion: source.campaignVersion,
    channelId: source.channelId,
    at: createdAt
  });
  if (current.status !== "eligible"
    || current.dependencyHash !== source.dependencyHash) {
    fail(
      "CONTACTABILITY_STALE",
      "资格事实已变化，请重新执行可联系门禁"
    );
  }
  const { recordHash: _sourceRecordHash, ...sourceValue } = source;
  const decision = finalize("prospect_contactability_decision", {
    ...sourceValue,
    id: id("pcd"),
    status: "approved_contactable" as const,
    approvedBy: required(command.actorId, "批准人"),
    approvedAt: createdAt,
    previousDecisionId: source.id,
    idempotencyKeyHash: replay.keyHash,
    requestHash: replay.requestHash,
    createdAt
  });
  store.prospectContactabilityDecisions.push(decision);
  return decision;
}

export function applyProspectQualificationCommand(
  store: CrmStore,
  command: ProspectQualificationCommand
): ProspectQualificationCommandResult {
  required(command.teamId, "团队");
  required(command.ownerId, "业务员");
  required(command.actorId, "操作人");
  required(command.prospectId, "候选");
  const beforeCount = PROSPECT_QUALIFICATION_ARRAYS.reduce((count, key) =>
    count + store[key].length,
  0);
  let record: QualificationRecord;
  switch (command.kind) {
    case "append_evidence":
      record = appendEvidence(store, command);
      break;
    case "compute_company_verification":
      record = computeCompanyVerification(store, command);
      break;
    case "review_company_verification":
      record = reviewCompanyVerification(store, command);
      break;
    case "publish_icp_policy":
      record = publishIcpPolicy(store, command);
      break;
    case "assess_icp":
      record = assessIcp(store, command);
      break;
    case "review_icp":
      record = reviewIcp(store, command);
      break;
    case "add_contact":
      record = addContact(store, command);
      break;
    case "add_contact_channel":
      record = addContactChannel(store, command);
      break;
    case "verify_contact_channel":
      record = verifyContactChannel(store, command);
      break;
    case "set_suppression":
      record = setSuppression(store, command);
      break;
    case "evaluate_contactability":
      record = evaluateContactability(store, command);
      break;
    case "approve_contactability":
      record = approveContactability(store, command);
      break;
  }
  return {
    kind: command.kind,
    record,
    replayed: PROSPECT_QUALIFICATION_ARRAYS.reduce((count, key) =>
      count + store[key].length,
    0) === beforeCount
  };
}

export function listOwnerProspectQualification(
  store: CrmStore,
  input: {
    teamId: string;
    ownerId: string;
    prospectId: string;
  }
) {
  requireProspect(store, input.teamId, input.prospectId);
  const ownerFilter = <T extends {
    teamId: string;
    ownerId: string;
    prospectId: string;
  }>(rows: readonly T[]) => rows.filter((item) =>
    item.teamId === input.teamId
    && item.ownerId === input.ownerId
    && item.prospectId === input.prospectId
  );
  return {
    evidence: ownerFilter(store.prospectEvidence),
    companyVerification: latestCompanyVerification(
      store,
      input.teamId,
      input.prospectId
    ) || null,
    icpPolicies: store.prospectIcpPolicySnapshots.filter((item) =>
      item.teamId === input.teamId && item.ownerId === input.ownerId
    ),
    icpAssessments: ownerFilter(store.prospectIcpAssessmentSnapshots),
    contacts: ownerFilter(store.prospectContacts),
    channels: ownerFilter(store.prospectContactChannels),
    contactVerifications: ownerFilter(
      store.prospectContactVerificationSnapshots
    ),
    suppressions: store.prospectSuppressionEvents.filter((item) =>
      item.teamId === input.teamId
      && item.prospectId === input.prospectId
      && (item.ownerId === input.ownerId
        || item.scope.startsWith("organization_"))
    ).map((item) => item.ownerId === input.ownerId
      ? item
      : {
          id: item.id,
          scope: item.scope,
          action: item.action,
          reasonCode: "SUPPRESSED",
          effectiveAt: item.effectiveAt,
          expiresAt: item.expiresAt
        }),
    contactabilityDecisions: ownerFilter(
      store.prospectContactabilityDecisions
    )
  };
}

export function currentContactabilityDecision(
  store: CrmStore,
  input: {
    teamId: string;
    ownerId: string;
    prospectId: string;
    campaignId: string;
    campaignVersion: number;
    channelId: string;
    at?: string;
  }
) {
  const latest = latestByCreatedAt(
    store.prospectContactabilityDecisions.filter((item) =>
      item.teamId === input.teamId
      && item.ownerId === input.ownerId
      && item.prospectId === input.prospectId
      && item.campaignId === input.campaignId
      && item.campaignVersion === input.campaignVersion
      && item.channelId === input.channelId
    )
  );
  if (!latest) return null;
  const current = evaluateGateState(store, {
    ...input,
    at: iso(input.at || new Date().toISOString(), "检查时间")
  });
  if (latest.dependencyHash === current.dependencyHash
    && (latest.status !== "approved_contactable"
      || current.status === "eligible")) {
    return latest;
  }
  return {
    ...latest,
    status: "stale" as const,
    reasonCodes: normalizeList([
      ...latest.reasonCodes,
      "QUALIFICATION_FACTS_CHANGED"
    ])
  };
}

export function validateProspectQualificationState(store: CrmStore) {
  const seen = new Set<string>();
  for (const key of PROSPECT_QUALIFICATION_ARRAYS) {
    for (const item of store[key]) {
      const scopedId = `${item.teamId}\u0000${item.id}`;
      if (seen.has(scopedId)) {
        fail("QUALIFICATION_DATA_INTEGRITY", "资格事实 ID 重复");
      }
      seen.add(scopedId);
      const { recordHash: actual, ...withoutHash } = item;
      if (actual !== recordHash(
        PROSPECT_QUALIFICATION_RECORD_TYPES[key],
        withoutHash as never
      )) {
        fail("QUALIFICATION_DATA_INTEGRITY", "资格事实摘要校验失败");
      }
      if ("prospectId" in item) {
        requireProspect(store, item.teamId, item.prospectId);
      } else {
        const campaignVersion = store.prospectCampaignVersions.find(
          (version) =>
            version.teamId === item.teamId
            && version.campaignId === item.campaignId
            && version.version === item.campaignVersion
        );
        if (!campaignVersion) {
          fail(
            "QUALIFICATION_DATA_INTEGRITY",
            "ICP 规则关联的项目版本不存在"
          );
        }
      }
      if ("ownerId" in item && !item.ownerId) {
        fail("QUALIFICATION_DATA_INTEGRITY", "私有资格事实缺少业务员");
      }
    }
  }
}
