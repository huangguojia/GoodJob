import { z } from "zod";
import {
  applyProspectQualificationCommand,
  currentContactabilityDecision,
  latestProspectCandidateQualificationRevision,
  listOwnerProspectQualification,
  prospectCandidateQualificationStageCurrent,
  type ProspectQualificationCommand,
  type ProspectQualificationCommandResult
} from "./prospect-qualification.js";
import { refreshProspectScorecard } from "./prospect-scorecard.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectContactChannel,
  ProspectContactabilityDecision,
  ProspectIcpDimensionScores,
  ProspectSearchRun,
  WebsiteOpportunity
} from "./types.js";

const httpsUrl = z.string().trim().url().max(1000).refine(
  (value) => value.startsWith("https://"),
  "来源链接必须使用 HTTPS"
);
const requestId = z.string().trim().min(8).max(120);
const isoTime = z.string().datetime();

const registryProviderSchema = z.enum([
  "gleif",
  "companies_house",
  "sec_edgar",
  "fr_company_search"
]);

export const prospectCompanyQualificationSchema = z.object({
  requestId,
  providerCode: registryProviderSchema,
  registrationNumber: z.string().trim().min(2).max(80),
  operatingStatus: z.enum([
    "active",
    "registered",
    "operating",
    "in_operation",
    "inactive",
    "dissolved",
    "liquidated",
    "struck_off",
    "closed"
  ]),
  jurisdiction: z.string().trim().min(2).max(40),
  sourceRef: httpsUrl,
  authorityCode: z.string().trim().min(2).max(80),
  observedAt: isoTime,
  validUntil: isoTime,
  officialDomain: z.string().trim().url().max(500).optional().default("")
}).strict().superRefine((value, context) => {
  const identifier = normalizeRegistryIdentifier(
    value.providerCode,
    value.registrationNumber
  );
  if (!identifier) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["registrationNumber"],
      message: "注册号格式与所选权威数据源不匹配"
    });
  }
  if (new Date(value.validUntil).getTime()
    <= new Date(value.observedAt).getTime()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["validUntil"],
      message: "企业核验有效期必须晚于证据观察时间"
    });
  }
});

const icpEvidenceSchema = z.object({
  field: z.enum([
    "product_match",
    "customer_type",
    "market_match",
    "purchasing_capability",
    "freshness"
  ]),
  value: z.string().trim().min(2).max(1000),
  sourceType: z.enum([
    "official_website",
    "licensed_data",
    "public_directory",
    "crm_manual"
  ]),
  providerCode: z.string().trim().min(2).max(80),
  sourceRef: z.string().trim().min(3).max(1000),
  excerpt: z.string().trim().max(1000).optional().default(""),
  observedAt: isoTime,
  expiresAt: isoTime.optional().default("")
}).strict();

const icpScoresSchema = z.object({
  productApplicationMatch: z.number().int().min(0).max(30),
  customerType: z.number().int().min(0).max(15),
  marketCountry: z.number().int().min(0).max(10),
  companyAuthenticity: z.number().int().min(0).max(15),
  purchasingChannelCapability: z.number().int().min(0).max(15),
  contactability: z.number().int().min(0).max(10),
  freshness: z.number().int().min(0).max(5)
}).strict();

export const prospectIcpQualificationSchema = z.object({
  requestId,
  campaignId: z.string().trim().min(1).max(80).optional().default(""),
  campaignVersion: z.number().int().positive().optional(),
  dimensionScores: icpScoresSchema,
  evidence: z.array(icpEvidenceSchema).min(1).max(12),
  hardGateReasonCodes: z.array(z.string().trim().min(1).max(80))
    .max(20).optional().default([])
}).strict().superRefine((value, context) => {
  if (!value.evidence.some((item) => item.field === "product_match")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "ICP 评估至少需要一条产品/应用匹配证据"
    });
  }
  if (value.evidence.some((item) =>
    item.expiresAt
    && new Date(item.expiresAt).getTime() <= new Date(item.observedAt).getTime()
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "ICP 证据有效期必须晚于观察时间"
    });
  }
});

export const prospectQualificationApprovalSchema = z.object({
  requestId
}).strict();

export const prospectChannelQualificationSchema = z.object({
  requestId,
  contactType: z.enum(["named_person", "department", "company_public"]),
  name: z.string().trim().max(120).optional().default(""),
  department: z.string().trim().max(120).optional().default(""),
  title: z.string().trim().max(120).optional().default(""),
  identityStatus: z.enum([
    "unconfirmed",
    "source_confirmed",
    "human_confirmed"
  ]),
  channelType: z.enum(["email", "phone", "whatsapp", "website_form"]),
  value: z.string().trim().min(3).max(500),
  sourceType: z.enum([
    "official_website",
    "licensed_data",
    "public_directory",
    "crm_manual"
  ]),
  sourceProviderCode: z.string().trim().min(2).max(80),
  sourceRef: z.string().trim().min(3).max(1000),
  excerpt: z.string().trim().max(1000).optional().default(""),
  acquiredAt: isoTime,
  verificationBasis: z.enum([
    "official_source_manual",
    "provider_verified",
    "positive_reply"
  ]),
  verificationProviderCode: z.string().trim().min(2).max(80),
  verificationReasonCode: z.string().trim().min(2).max(120),
  verifiedAt: isoTime,
  expiresAt: isoTime,
  humanConfirmed: z.literal(true)
}).strict().superRefine((value, context) => {
  if (value.contactType === "named_person" && !value.name) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: "具名联系人必须填写姓名"
    });
  }
  if (value.contactType === "department" && !value.department) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["department"],
      message: "部门联系人必须填写部门"
    });
  }
  if (value.verificationBasis === "official_source_manual"
    && value.sourceType !== "official_website") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceType"],
      message: "官网人工核验必须引用企业官方网页"
    });
  }
  if (new Date(value.expiresAt).getTime()
    <= new Date(value.verifiedAt).getTime()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "联系方式验证有效期必须晚于验证时间"
    });
  }
});

export const prospectContactabilityEvaluationSchema = z.object({
  requestId,
  channelId: z.string().trim().min(1).max(90).optional().default("")
}).strict();

export const prospectSuppressionSchema = z.object({
  requestId,
  scope: z.enum([
    "contact_channel",
    "contact_all",
    "organization_channel",
    "organization_all"
  ]),
  action: z.enum(["imposed", "revoked"]),
  contactId: z.string().trim().max(90).optional().default(""),
  channelId: z.string().trim().max(90).optional().default(""),
  channelType: z.enum(["email", "phone", "whatsapp", "website_form"])
    .optional(),
  reasonCode: z.string().trim().min(2).max(120),
  reasonNote: z.string().trim().max(500).optional().default(""),
  effectiveAt: isoTime,
  expiresAt: isoTime.optional().default(""),
  doNotContact: z.boolean().optional().default(false)
}).strict().superRefine((value, context) => {
  if (value.doNotContact
    && (value.action !== "imposed" || value.scope !== "organization_all")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["doNotContact"],
      message: "永久禁止联系必须使用企业全局抑制"
    });
  }
});

export type ProspectCompanyQualificationInput = z.infer<
  typeof prospectCompanyQualificationSchema
>;
export type ProspectIcpQualificationInput = z.infer<
  typeof prospectIcpQualificationSchema
>;
export type ProspectChannelQualificationInput = z.infer<
  typeof prospectChannelQualificationSchema
>;
export type ProspectSuppressionInput = z.infer<
  typeof prospectSuppressionSchema
>;

export class ProspectQualificationWorkflowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "ProspectQualificationWorkflowError";
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new ProspectQualificationWorkflowError(code, message, status);
}

function normalizeRegistryIdentifier(providerCode: string, raw: string) {
  const value = raw.trim().toLocaleUpperCase("en-US");
  if (providerCode === "gleif") {
    if (!/^[A-Z0-9]{20}$/u.test(value)) return "";
    const expanded = value.split("").map((character) =>
      /[A-Z]/u.test(character)
        ? String(character.charCodeAt(0) - 55)
        : character
    ).join("");
    let remainder = 0;
    for (const character of expanded) {
      remainder = (remainder * 10 + Number(character)) % 97;
    }
    return remainder === 1 ? value : "";
  }
  if (providerCode === "companies_house") {
    return /^[A-Z0-9]{6,10}$/u.test(value) ? value : "";
  }
  if (providerCode === "sec_edgar") {
    return /^CIK:\d{10}$/u.test(value) ? value : "";
  }
  if (providerCode === "fr_company_search") {
    return /^SIREN:\d{9}$/u.test(value) ? value : "";
  }
  return "";
}

async function apply(
  store: CrmStore,
  command: ProspectQualificationCommand
): Promise<ProspectQualificationCommandResult> {
  return store.applyProspectQualification
    ? store.applyProspectQualification(command)
    : applyProspectQualificationCommand(store, command);
}

async function checkpointCandidateStage(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  actorId: string,
  requestKey: string,
  stage: "company" | "icp" | "channel" | "contactability",
  sourceFactId: string
) {
  const revision = latestProspectCandidateQualificationRevision(
    store,
    candidate
  )?.revision || 0;
  return apply(store, {
    ...baseCommand(candidate, actorId, requestKey),
    kind: "checkpoint_candidate_qualification",
    candidateId: candidate.id,
    stage,
    revision,
    sourceFactId
  });
}

function candidateRuns(store: CrmStore, candidate: WebsiteOpportunity) {
  const runIds = (store.prospectCandidateProcessingStates || [])
    .filter((item) =>
      item.teamId === candidate.teamId
      && item.ownerId === candidate.ownerId
      && item.candidateId === candidate.id
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((item) => item.runId);
  const coverageRunIds = store.prospectCoverageEvents
    .filter((item) =>
      item.teamId === candidate.teamId
      && item.ownerId === candidate.ownerId
      && item.prospectId === candidate.tenantProspectId
      && item.runId
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((item) => item.runId);
  const ordered = [...new Set([...runIds, ...coverageRunIds])];
  return ordered.map((runId) => store.prospectSearchRuns.find((item) =>
    item.id === runId
    && item.teamId === candidate.teamId
    && item.ownerId === candidate.ownerId
  )).filter((item): item is ProspectSearchRun => Boolean(item));
}

export function prospectQualificationCampaignContext(
  store: CrmStore,
  candidate: WebsiteOpportunity
) {
  const run = candidateRuns(store, candidate)[0];
  if (!run) return null;
  const campaign = store.prospectCampaigns.find((item) =>
    item.id === run.campaignId && item.teamId === candidate.teamId
  );
  const version = store.prospectCampaignVersions.find((item) =>
    item.teamId === candidate.teamId
    && item.campaignId === run.campaignId
    && item.version === run.campaignVersion
  );
  if (!campaign || !version) return null;
  return {
    runId: run.id,
    campaignId: campaign.id,
    campaignVersion: version.version,
    campaignName: campaign.name,
    campaignSnapshot: version.snapshot
  };
}

function prospectForCandidate(store: CrmStore, candidate: WebsiteOpportunity) {
  if (!candidate.tenantProspectId || !candidate.organizationId) {
    fail(
      "CANDIDATE_FORMAL_IDENTITY_MISSING",
      "候选尚未完成企业身份归一，不能进入正式资格审查"
    );
  }
  const prospect = store.tenantProspects.find((item) =>
    item.id === candidate.tenantProspectId
    && item.teamId === candidate.teamId
    && item.organizationId === candidate.organizationId
  );
  if (!prospect) {
    fail(
      "CANDIDATE_FORMAL_IDENTITY_STALE",
      "候选关联的企业身份已不存在，请重新执行候选归一"
    );
  }
  return prospect;
}

function baseCommand(
  candidate: WebsiteOpportunity,
  actorId: string,
  idempotencyKey: string,
  createdAt = new Date().toISOString()
) {
  const prospectId = candidate.tenantProspectId;
  if (!prospectId) {
    fail(
      "CANDIDATE_FORMAL_IDENTITY_MISSING",
      "候选尚未完成企业身份归一，不能进入正式资格审查"
    );
  }
  return {
    teamId: candidate.teamId,
    ownerId: candidate.ownerId,
    actorId,
    prospectId,
    idempotencyKey,
    createdAt
  };
}

function latestApprovedDecision(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  at = new Date().toISOString()
) {
  if (!candidate.tenantProspectId) return null;
  if (!prospectCandidateQualificationStageCurrent(
    store,
    candidate,
    "contactability"
  )) return null;
  const decisions = store.prospectContactabilityDecisions
    .filter((item) =>
      item.teamId === candidate.teamId
      && item.ownerId === candidate.ownerId
      && item.prospectId === candidate.tenantProspectId
      && item.status === "approved_contactable"
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return decisions.find((item) => {
    const current = currentContactabilityDecision(store, {
      teamId: item.teamId,
      ownerId: item.ownerId,
      prospectId: item.prospectId,
      campaignId: item.campaignId,
      campaignVersion: item.campaignVersion,
      channelId: item.channelId,
      at
    });
    return current?.id === item.id && current.status === "approved_contactable";
  }) || null;
}

export function prospectQualificationView(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  at = new Date().toISOString()
) {
  refreshProspectScorecard(store, candidate, at);
  const campaign = prospectQualificationCampaignContext(store, candidate);
  const blockers: string[] = [];
  let qualification = null;
  if (!candidate.tenantProspectId || !candidate.organizationId) {
    blockers.push("CANDIDATE_FORMAL_IDENTITY_MISSING");
  } else {
    const prospect = store.tenantProspects.find((item) =>
      item.id === candidate.tenantProspectId
      && item.teamId === candidate.teamId
    );
    if (!prospect) blockers.push("CANDIDATE_FORMAL_IDENTITY_STALE");
    else if (prospect.status === "do_not_contact") {
      blockers.push("PROSPECT_DO_NOT_CONTACT");
    } else if (!["active", "converted"].includes(prospect.status)) {
      blockers.push("PROSPECT_NOT_ACTIVE");
    }
    qualification = listOwnerProspectQualification(store, {
      teamId: candidate.teamId,
      ownerId: candidate.ownerId,
      prospectId: candidate.tenantProspectId
    });
  }
  if (!campaign) blockers.push("CAMPAIGN_CONTEXT_MISSING");
  const approvedDecision = latestApprovedDecision(store, candidate, at);
  const approvedChannel = approvedDecision
    ? store.prospectContactChannels.find((item) =>
        item.id === approvedDecision.channelId
        && item.teamId === candidate.teamId
        && item.ownerId === candidate.ownerId
      ) || null
    : null;
  return {
    candidateId: candidate.id,
    prospectId: candidate.tenantProspectId || "",
    organizationId: candidate.organizationId || "",
    campaign,
    blockers: [...new Set(blockers)],
    qualification,
    approvedDecision,
    approvedChannel,
    scorecard: candidate.scorecard,
    stageCurrency: {
      company: prospectCandidateQualificationStageCurrent(
        store,
        candidate,
        "company"
      ),
      icp: prospectCandidateQualificationStageCurrent(
        store,
        candidate,
        "icp"
      ),
      channel: prospectCandidateQualificationStageCurrent(
        store,
        candidate,
        "channel"
      ),
      contactability: prospectCandidateQualificationStageCurrent(
        store,
        candidate,
        "contactability"
      )
    },
    vqaQualified: Boolean(candidate.scorecard?.vqa.qualified),
    nextStep: qualificationNextStep(store, candidate, qualification, campaign)
  };
}

function qualificationNextStep(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  qualification: ReturnType<typeof listOwnerProspectQualification> | null,
  campaign: ReturnType<typeof prospectQualificationCampaignContext>
) {
  if (!candidate.tenantProspectId || !candidate.organizationId) {
    return "resolve_identity" as const;
  }
  if (!campaign) return "resolve_campaign" as const;
  if (!qualification?.companyVerification
    || !prospectCandidateQualificationStageCurrent(
      store,
      candidate,
      "company"
    )
    || !["verified_active", "partially_verified"].includes(
      qualification.companyVerification.status
    )) return "verify_company" as const;
  const assessment = qualification.icpAssessments.at(-1);
  if (!assessment) return "assess_icp" as const;
  if (!prospectCandidateQualificationStageCurrent(store, candidate, "icp")) {
    return "assess_icp" as const;
  }
  if (assessment.reviewStatus !== "approved") return "approve_icp" as const;
  if (!qualification.channels.length
    || !qualification.contactVerifications.length
    || !prospectCandidateQualificationStageCurrent(
      store,
      candidate,
      "channel"
    )) {
    return "verify_channel" as const;
  }
  const decision = qualification.contactabilityDecisions.at(-1);
  if (!decision
    || !prospectCandidateQualificationStageCurrent(
      store,
      candidate,
      "contactability"
    )
    || ["blocked", "review_required", "stale"].includes(
      decision.status
  )) return "evaluate_contactability" as const;
  if (decision.status === "eligible") return "approve_contactability" as const;
  return "ready" as const;
}

export async function recordProspectCompanyQualification(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  actorId: string,
  input: ProspectCompanyQualificationInput
) {
  prospectForCandidate(store, candidate);
  const identifier = normalizeRegistryIdentifier(
    input.providerCode,
    input.registrationNumber
  );
  if (!identifier) {
    fail(
      "AUTHORITATIVE_IDENTIFIER_INVALID",
      "注册号未通过所选权威数据源的结构校验",
      400
    );
  }
  const now = new Date().toISOString();
  const base = (suffix: string) => baseCommand(
    candidate,
    actorId,
    `${input.requestId}:company:${suffix}`,
    now
  );
  const evidenceIds: string[] = [];
  for (const evidence of [
    { field: "registration_number" as const, value: identifier },
    { field: "operating_status" as const, value: input.operatingStatus },
    { field: "jurisdiction" as const, value: input.jurisdiction }
  ]) {
    const result = await apply(store, {
      ...base(evidence.field),
      kind: "append_evidence",
      evidenceKind: "company_verification",
      field: evidence.field,
      value: evidence.value,
      sourceType: "authoritative_registry",
      providerCode: input.providerCode,
      sourceRef: input.sourceRef,
      authorityCode: input.authorityCode,
      observedAt: input.observedAt,
      expiresAt: input.validUntil
    });
    evidenceIds.push(result.record.id);
  }
  if (input.officialDomain) {
    const result = await apply(store, {
      ...base("official-domain"),
      kind: "append_evidence",
      evidenceKind: "company_verification",
      field: "official_domain",
      value: input.officialDomain,
      sourceType: "official_website",
      providerCode: "official_website_manual_review",
      sourceRef: input.officialDomain,
      observedAt: input.observedAt,
      expiresAt: input.validUntil
    });
    evidenceIds.push(result.record.id);
  }
  const snapshot = await apply(store, {
    ...base("snapshot"),
    kind: "compute_company_verification",
    evidenceIds,
    validUntil: input.validUntil
  });
  await checkpointCandidateStage(
    store,
    candidate,
    actorId,
    `${input.requestId}:company:checkpoint`,
    "company",
    snapshot.record.id
  );
  return prospectQualificationView(store, candidate);
}

function explicitCampaignContext(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  input: ProspectIcpQualificationInput
) {
  const inferred = prospectQualificationCampaignContext(store, candidate);
  if (!input.campaignId) {
    if (!inferred) {
      fail(
        "CAMPAIGN_CONTEXT_MISSING",
        "无法确定候选所属获客项目，不能生成 ICP 评估"
      );
    }
    return inferred;
  }
  const campaign = store.prospectCampaigns.find((item) =>
    item.id === input.campaignId
    && item.teamId === candidate.teamId
    && item.ownerId === candidate.ownerId
  );
  const versionNo = input.campaignVersion || campaign?.currentVersion;
  const version = store.prospectCampaignVersions.find((item) =>
    item.teamId === candidate.teamId
    && item.campaignId === input.campaignId
    && item.version === versionNo
  );
  if (!campaign || !version) {
    fail("CAMPAIGN_CONTEXT_INVALID", "指定的获客项目版本不存在", 404);
  }
  return {
    runId: inferred?.runId || "",
    campaignId: campaign.id,
    campaignVersion: version.version,
    campaignName: campaign.name,
    campaignSnapshot: version.snapshot
  };
}

export async function recordProspectIcpQualification(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  actorId: string,
  input: ProspectIcpQualificationInput
) {
  prospectForCandidate(store, candidate);
  if (!prospectCandidateQualificationStageCurrent(
    store,
    candidate,
    "company"
  )) {
    fail(
      "CANDIDATE_COMPANY_QUALIFICATION_STALE",
      "企业资料已变化，请先重新完成企业核验"
    );
  }
  const campaign = explicitCampaignContext(store, candidate, input);
  const now = new Date().toISOString();
  const base = (suffix: string) => baseCommand(
    candidate,
    actorId,
    `${input.requestId}:icp:${suffix}`,
    now
  );
  const evidenceIds: string[] = [];
  for (const [index, evidence] of input.evidence.entries()) {
    const result = await apply(store, {
      ...base(`evidence:${index}`),
      kind: "append_evidence",
      evidenceKind: "icp",
      field: evidence.field,
      value: evidence.value,
      sourceType: evidence.sourceType,
      providerCode: evidence.providerCode,
      sourceRef: evidence.sourceRef,
      excerpt: evidence.excerpt,
      observedAt: evidence.observedAt,
      expiresAt: evidence.expiresAt
    });
    evidenceIds.push(result.record.id);
  }
  let policy = store.prospectIcpPolicySnapshots
    .filter((item) =>
      item.teamId === candidate.teamId
      && item.ownerId === candidate.ownerId
      && item.campaignId === campaign.campaignId
      && item.campaignVersion === campaign.campaignVersion
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!policy) {
    const result = await apply(store, {
      ...base("policy"),
      kind: "publish_icp_policy",
      campaignId: campaign.campaignId,
      campaignVersion: campaign.campaignVersion
    });
    policy = result.record as typeof policy;
  }
  if (!policy) fail("ICP_POLICY_CREATION_FAILED", "ICP 规则快照创建失败", 500);
  const assessment = await apply(store, {
    ...base("assessment"),
    kind: "assess_icp",
    policyId: policy.id,
    dimensionScores: input.dimensionScores as ProspectIcpDimensionScores,
    evidenceIds,
    hardGateReasonCodes: input.hardGateReasonCodes
  });
  await checkpointCandidateStage(
    store,
    candidate,
    actorId,
    `${input.requestId}:icp:assessment-checkpoint`,
    "icp",
    assessment.record.id
  );
  return prospectQualificationView(store, candidate);
}

export async function approveProspectIcpQualification(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  actorId: string,
  assessmentId: string,
  input: z.infer<typeof prospectQualificationApprovalSchema>
) {
  prospectForCandidate(store, candidate);
  const currentRevision = latestProspectCandidateQualificationRevision(
    store,
    candidate
  );
  if (currentRevision) {
    const currentAssessmentCheckpoint =
      store.prospectCandidateQualificationCheckpoints
        .filter((item) =>
          item.teamId === candidate.teamId
          && item.ownerId === candidate.ownerId
          && item.prospectId === candidate.tenantProspectId
          && item.candidateId === candidate.id
          && item.stage === "icp"
        )
        .sort((left, right) => right.revision - left.revision)[0];
    if (!currentAssessmentCheckpoint
      || currentAssessmentCheckpoint.revision !== currentRevision.revision
      || currentAssessmentCheckpoint.sourceFactId !== assessmentId) {
      fail(
        "CANDIDATE_ICP_QUALIFICATION_STALE",
        "候选资料已变化，请重新生成 ICP 评估后再批准"
      );
    }
  }
  const reviewed = await apply(store, {
    ...baseCommand(
      candidate,
      actorId,
      `${input.requestId}:icp:approve:${assessmentId}`
    ),
    kind: "review_icp",
    assessmentId,
    decision: "approved"
  });
  await checkpointCandidateStage(
    store,
    candidate,
    actorId,
    `${input.requestId}:icp:checkpoint:${assessmentId}`,
    "icp",
    reviewed.record.id
  );
  return prospectQualificationView(store, candidate);
}

export async function recordProspectChannelQualification(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  actorId: string,
  input: ProspectChannelQualificationInput
) {
  prospectForCandidate(store, candidate);
  const now = new Date().toISOString();
  const base = (suffix: string) => baseCommand(
    candidate,
    actorId,
    `${input.requestId}:channel:${suffix}`,
    now
  );
  const evidence = await apply(store, {
    ...base("evidence"),
    kind: "append_evidence",
    evidenceKind: "contact",
    field: "contact_source",
    value: input.value,
    sourceType: input.sourceType,
    providerCode: input.sourceProviderCode,
    sourceRef: input.sourceRef,
    excerpt: input.excerpt,
    observedAt: input.acquiredAt,
    expiresAt: input.expiresAt
  });
  const contact = await apply(store, {
    ...base("contact"),
    kind: "add_contact",
    contactType: input.contactType,
    name: input.name,
    department: input.department,
    title: input.title,
    identityStatus: input.identityStatus,
    sourceEvidenceId: evidence.record.id
  });
  const channel = await apply(store, {
    ...base("value"),
    kind: "add_contact_channel",
    contactId: contact.record.id,
    channelType: input.channelType,
    value: input.value,
    sourceEvidenceId: evidence.record.id,
    acquiredAt: input.acquiredAt
  });
  const verification = await apply(store, {
    ...base("verification"),
    kind: "verify_contact_channel",
    channelId: channel.record.id,
    status: "verified",
    providerCode: input.verificationProviderCode,
    reasonCode:
      `${input.verificationBasis}:${input.verificationReasonCode}`,
    verifiedAt: input.verifiedAt,
    expiresAt: input.expiresAt
  });
  await checkpointCandidateStage(
    store,
    candidate,
    actorId,
    `${input.requestId}:channel:checkpoint`,
    "channel",
    verification.record.id
  );
  return prospectQualificationView(store, candidate);
}

function channelForEvaluation(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  channelId: string
): ProspectContactChannel {
  const matches = store.prospectContactChannels.filter((item) =>
    item.teamId === candidate.teamId
    && item.ownerId === candidate.ownerId
    && item.prospectId === candidate.tenantProspectId
    && (!channelId || item.id === channelId)
  ).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (!matches[0]) {
    fail("CONTACT_CHANNEL_MISSING", "没有可用于门禁评估的联系方式");
  }
  return matches[0];
}

export async function evaluateProspectContactability(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  actorId: string,
  input: z.infer<typeof prospectContactabilityEvaluationSchema>
) {
  prospectForCandidate(store, candidate);
  const campaign = prospectQualificationCampaignContext(store, candidate);
  if (!campaign) {
    fail("CAMPAIGN_CONTEXT_MISSING", "无法确定候选所属获客项目");
  }
  for (const stage of ["company", "icp", "channel"] as const) {
    if (!prospectCandidateQualificationStageCurrent(
      store,
      candidate,
      stage
    )) {
      fail(
        "CANDIDATE_QUALIFICATION_STALE",
        "候选资料已变化，请先重新完成受影响的资格步骤"
      );
    }
  }
  const channel = channelForEvaluation(store, candidate, input.channelId);
  const evaluated = await apply(store, {
    ...baseCommand(
      candidate,
      actorId,
      `${input.requestId}:contactability:evaluate:${channel.id}`
    ),
    kind: "evaluate_contactability",
    campaignId: campaign.campaignId,
    campaignVersion: campaign.campaignVersion,
    channelId: channel.id
  });
  await checkpointCandidateStage(
    store,
    candidate,
    actorId,
    `${input.requestId}:contactability:checkpoint:${channel.id}`,
    "contactability",
    evaluated.record.id
  );
  return prospectQualificationView(store, candidate);
}

export async function approveProspectContactability(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  actorId: string,
  decisionId: string,
  input: z.infer<typeof prospectQualificationApprovalSchema>
) {
  prospectForCandidate(store, candidate);
  if (!prospectCandidateQualificationStageCurrent(
    store,
    candidate,
    "contactability"
  )) {
    fail(
      "CANDIDATE_QUALIFICATION_STALE",
      "候选资料已变化，请重新执行可联系门禁"
    );
  }
  const approved = await apply(store, {
    ...baseCommand(
      candidate,
      actorId,
      `${input.requestId}:contactability:approve:${decisionId}`
    ),
    kind: "approve_contactability",
    decisionId
  });
  await checkpointCandidateStage(
    store,
    candidate,
    actorId,
    `${input.requestId}:contactability:approved-checkpoint:${decisionId}`,
    "contactability",
    approved.record.id
  );
  return prospectQualificationView(store, candidate);
}

export async function setProspectSuppression(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  actorId: string,
  input: ProspectSuppressionInput
) {
  const prospect = prospectForCandidate(store, candidate);
  await apply(store, {
    ...baseCommand(
      candidate,
      actorId,
      `${input.requestId}:suppression:${input.action}:${input.scope}`,
      input.effectiveAt
    ),
    kind: "set_suppression",
    scope: input.scope,
    action: input.action,
    contactId: input.contactId || undefined,
    channelId: input.channelId || undefined,
    channelType: input.channelType,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt || undefined
  });
  if (input.doNotContact && store.setTenantProspectDisposition) {
    await store.setTenantProspectDisposition({
      teamId: candidate.teamId,
      ownerId: candidate.ownerId,
      prospectId: prospect.id,
      requestId: `${input.requestId}:coverage:dnc`,
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "do_not_contact",
      reasonCode: input.reasonCode,
      effectiveAt: input.effectiveAt,
      exclusionScope: "organization"
    });
  }
  if (input.action === "imposed") {
    candidate.status = "excluded";
    candidate.excludedReason = input.reasonNote || input.reasonCode;
    candidate.outreachState = "suppressed";
    candidate.statusChangedAt = input.effectiveAt;
  }
  return prospectQualificationView(store, candidate);
}

export function currentApprovedProspectDecision(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  at = new Date().toISOString()
): {
  decision: ProspectContactabilityDecision;
  channel: ProspectContactChannel;
} | null {
  const decision = latestApprovedDecision(store, candidate, at);
  if (!decision) return null;
  const channel = store.prospectContactChannels.find((item) =>
    item.id === decision.channelId
    && item.teamId === candidate.teamId
    && item.ownerId === candidate.ownerId
    && item.prospectId === candidate.tenantProspectId
  );
  return channel ? { decision, channel } : null;
}
