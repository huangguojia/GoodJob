import { isDeepStrictEqual } from "node:util";
import { validLei } from "./prospect-identity-authority-profiles.js";
import { refreshProspectScorecard } from "./prospect-scorecard.js";
import { withProspectVerificationReport } from "./prospect-verification.js";
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import type {
  ProspectIdentityAuthorityProvider,
  ProspectIdentityBootstrapAttempt,
  ProspectIdentityBootstrapEvent,
  ProspectIdentityBootstrapStage,
  ProviderEvidenceSnapshot,
  SessionUser,
  WebsiteOpportunity
} from "./types.js";

export const PROSPECT_IDENTITY_BOOTSTRAP_VERSION =
  "prospect-identity-bootstrap-v1" as const;

export interface ProspectIdentityAuthorityGuide {
  id: ProspectIdentityAuthorityProvider;
  name: string;
  jurisdiction: string;
  market: string;
  identifierLabel: string;
  example: string;
  profileCode: string;
  scheme: string;
  requiresKey: boolean;
  credentialKind: "none" | "api_key" | "fair_access_user_agent";
  setupNote: string;
}

export const PROSPECT_IDENTITY_AUTHORITY_GUIDES:
ProspectIdentityAuthorityGuide[] = [{
  id: "gleif",
  name: "GLEIF LEI",
  jurisdiction: "GLOBAL",
  market: "Global",
  identifierLabel: "LEI",
  example: "20 位 LEI",
  profileCode: "gleif-company-identity",
  scheme: "iso-17442",
  requiresKey: false,
  credentialKind: "none",
  setupNote: "免费官方接口，无需注册或配置凭据。"
}, {
  id: "companies_house",
  name: "UK Companies House",
  jurisdiction: "GB",
  market: "United Kingdom",
  identifierLabel: "Company number",
  example: "例如 01234567 或 SC123456",
  profileCode: "companies-house-company-identity",
  scheme: "uk-companies-house",
  requiresKey: true,
  credentialKind: "api_key",
  setupNote: "需要在 Companies House 开发者平台免费申请 API Key。"
}, {
  id: "sec_edgar",
  name: "SEC EDGAR",
  jurisdiction: "US",
  market: "United States",
  identifierLabel: "CIK",
  example: "1 至 10 位 CIK",
  profileCode: "sec-edgar-company-identity",
  scheme: "us-sec-cik",
  requiresKey: true,
  credentialKind: "fair_access_user_agent",
  setupNote: "无需申请 API Key，但必须配置“系统名 联系邮箱”作为 SEC Fair Access User-Agent。"
}, {
  id: "fr_company_search",
  name: "法国企业登记",
  jurisdiction: "FR",
  market: "France",
  identifierLabel: "SIREN",
  example: "9 位 SIREN",
  profileCode: "fr-siren-company-identity",
  scheme: "fr-siren",
  requiresKey: false,
  credentialKind: "none",
  setupNote: "免费官方接口，无需注册或配置凭据。"
}];

export class ProspectIdentityBootstrapError extends Error {
  constructor(
    public readonly code:
      | "IDENTITY_BOOTSTRAP_INVALID"
      | "IDENTITY_BOOTSTRAP_NOT_FOUND"
      | "IDENTITY_BOOTSTRAP_FORBIDDEN"
      | "IDENTITY_BOOTSTRAP_ALREADY_FORMAL"
      | "IDENTITY_BOOTSTRAP_ALREADY_RUNNING"
      | "IDENTITY_BOOTSTRAP_RUN_NOT_READY"
      | "IDENTITY_BOOTSTRAP_CONFLICT"
      | "IDENTITY_BOOTSTRAP_DATA_INTEGRITY",
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "ProspectIdentityBootstrapError";
  }
}

function fail(
  code: ProspectIdentityBootstrapError["code"],
  message: string,
  status = 409
): never {
  throw new ProspectIdentityBootstrapError(code, message, status);
}

function authorityGuide(providerId: ProspectIdentityAuthorityProvider) {
  const guide = PROSPECT_IDENTITY_AUTHORITY_GUIDES.find(
    (item) => item.id === providerId
  );
  if (!guide) {
    fail("IDENTITY_BOOTSTRAP_INVALID", "不支持该企业身份权威来源", 400);
  }
  return guide;
}

export function normalizeProspectIdentityRegistration(
  providerId: ProspectIdentityAuthorityProvider,
  rawValue: string
) {
  const guide = authorityGuide(providerId);
  const raw = String(rawValue || "").trim().toLocaleUpperCase("en-US");
  if (!raw || raw.length > 80) {
    fail("IDENTITY_BOOTSTRAP_INVALID", `${guide.identifierLabel} 无效`, 400);
  }
  if (providerId === "gleif") {
    const normalized = raw.replace(/\s+/gu, "");
    if (!validLei(normalized)) {
      fail("IDENTITY_BOOTSTRAP_INVALID", "LEI 未通过 ISO 17442 校验", 400);
    }
    return {
      guide,
      registrationNumber: normalized,
      providerRecordId: normalized,
      normalizedIdentifier: normalized
    };
  }
  if (providerId === "companies_house") {
    const normalized = raw.replace(/[\s-]+/gu, "");
    if (!/^(?:\d{8}|[A-Z][A-Z0-9]\d{6})$/u.test(normalized)) {
      fail("IDENTITY_BOOTSTRAP_INVALID", "Companies House 公司编号必须为 8 个字符", 400);
    }
    return {
      guide,
      registrationNumber: normalized,
      providerRecordId: normalized,
      normalizedIdentifier: normalized
    };
  }
  if (providerId === "sec_edgar") {
    const digits = raw.replace(/^CIK\s*:?\s*/u, "").replace(/\s+/gu, "");
    if (!/^\d{1,10}$/u.test(digits)) {
      fail("IDENTITY_BOOTSTRAP_INVALID", "SEC CIK 格式无效", 400);
    }
    const normalized = digits.padStart(10, "0");
    return {
      guide,
      registrationNumber: `CIK:${normalized}`,
      providerRecordId: `CIK:${normalized}`,
      normalizedIdentifier: normalized
    };
  }
  const digits = raw.replace(/^SIREN\s*:?\s*/u, "").replace(/\s+/gu, "");
  if (!/^\d{9}$/u.test(digits)) {
    fail("IDENTITY_BOOTSTRAP_INVALID", "法国 SIREN 必须为 9 位数字", 400);
  }
  return {
    guide,
    registrationNumber: `SIREN:${digits}`,
    providerRecordId: `SIREN:${digits}`,
    normalizedIdentifier: digits
  };
}

function ownedCandidate(
  store: CrmStore,
  user: SessionUser,
  candidateId: string
) {
  const candidate = store.websiteOpportunities.find((item) =>
    item.id === candidateId && item.teamId === user.teamId
  );
  if (!candidate) {
    fail(
      "IDENTITY_BOOTSTRAP_NOT_FOUND",
      "官网候选不存在或无权访问",
      404
    );
  }
  if (candidate.ownerId !== user.id) {
    fail(
      "IDENTITY_BOOTSTRAP_FORBIDDEN",
      "只有候选归属业务员可以发起正式身份引导",
      403
    );
  }
  return candidate;
}

function cloneAttempts(candidate: WebsiteOpportunity) {
  return structuredClone(candidate.identityBootstrapAttempts || []);
}

function event(
  attempt: ProspectIdentityBootstrapAttempt,
  stage: ProspectIdentityBootstrapStage,
  status: ProspectIdentityBootstrapEvent["status"],
  label: string,
  detail: string,
  at: string
) {
  const existing = attempt.events.find((item) => item.stage === stage);
  if (existing) {
    Object.assign(existing, { status, label, detail, createdAt: at });
    return;
  }
  const sequence = attempt.events.length + 1;
  attempt.events.push({
    id: `${attempt.id}:event:${sequence}`,
    sequence,
    stage,
    status,
    label,
    detail,
    createdAt: at
  });
}

async function persistCandidateMutation<T>(
  store: CrmStore,
  mutation: () => PersistedStoreMutation<T>
) {
  if (store.persistProspectCandidateMutation) {
    return store.persistProspectCandidateMutation(mutation);
  }
  const applied = mutation();
  try {
    await store.persist();
    return applied.value;
  } catch (error) {
    applied.rollback();
    throw error;
  }
}

export async function beginProspectIdentityBootstrap(input: {
  store: CrmStore;
  user: SessionUser;
  candidateId: string;
  attempt: ProspectIdentityBootstrapAttempt;
}) {
  return persistCandidateMutation(input.store, () => {
    const candidate = ownedCandidate(
      input.store,
      input.user,
      input.candidateId
    );
    const before = cloneAttempts(candidate);
    const attempts = candidate.identityBootstrapAttempts ||= [];
    const replay = attempts.find((item) =>
      item.requestIdHash === input.attempt.requestIdHash
    );
    if (replay) {
      if (replay.providerId !== input.attempt.providerId
        || replay.normalizedIdentifier
          !== input.attempt.normalizedIdentifier) {
        fail(
          "IDENTITY_BOOTSTRAP_CONFLICT",
          "相同 requestId 已用于不同的企业身份引导请求"
        );
      }
      return {
        value: { candidate: structuredClone(candidate), attempt: replay, replayed: true },
        rollback: () => undefined
      };
    }
    if (candidate.status === "synced" || candidate.leadId) {
      fail(
        "IDENTITY_BOOTSTRAP_ALREADY_FORMAL",
        "已进入 CRM 的候选不能重新发起身份引导"
      );
    }
    if (candidate.tenantProspectId || candidate.organizationId) {
      fail(
        "IDENTITY_BOOTSTRAP_ALREADY_FORMAL",
        "候选已经具备正式企业身份"
      );
    }
    if (attempts.some((item) => item.taskStatus === "running")) {
      fail(
        "IDENTITY_BOOTSTRAP_ALREADY_RUNNING",
        "该候选已有正在执行的身份引导任务"
      );
    }
    if (attempts.length >= 20) {
      fail(
        "IDENTITY_BOOTSTRAP_INVALID",
        "该候选的身份引导尝试已达上限，请联系管理员复核",
        400
      );
    }
    attempts.unshift(structuredClone(input.attempt));
    return {
      value: {
        candidate: structuredClone(candidate),
        attempt: structuredClone(input.attempt),
        replayed: false
      },
      rollback: () => {
        candidate.identityBootstrapAttempts = before;
      }
    };
  });
}

export async function attachProspectIdentityBootstrapRun(input: {
  store: CrmStore;
  user: SessionUser;
  candidateId: string;
  attemptId: string;
  campaignId: string;
  campaignVersion: number;
  strategyId: string;
  runId: string;
  at: string;
}) {
  return persistCandidateMutation(input.store, () => {
    const candidate = ownedCandidate(input.store, input.user, input.candidateId);
    const before = cloneAttempts(candidate);
    const attempt = candidate.identityBootstrapAttempts?.find(
      (item) => item.id === input.attemptId
    );
    if (!attempt) {
      fail("IDENTITY_BOOTSTRAP_NOT_FOUND", "身份引导任务不存在", 404);
    }
    if (attempt.runId && attempt.runId !== input.runId) {
      fail(
        "IDENTITY_BOOTSTRAP_CONFLICT",
        "身份引导任务已绑定到不同的搜索运行"
      );
    }
    Object.assign(attempt, {
      campaignId: input.campaignId,
      campaignVersion: input.campaignVersion,
      strategyId: input.strategyId,
      runId: input.runId,
      updatedAt: input.at
    });
    event(
      attempt,
      "campaign",
      "completed",
      "正式搜索上下文已建立",
      `Campaign ${input.campaignId} / Run ${input.runId}`,
      input.at
    );
    return {
      value: { candidate: structuredClone(candidate), attempt: structuredClone(attempt) },
      rollback: () => {
        candidate.identityBootstrapAttempts = before;
      }
    };
  });
}

export async function failProspectIdentityBootstrap(input: {
  store: CrmStore;
  user: SessionUser;
  candidateId: string;
  attemptId: string;
  errorCode: string;
  errorMessage: string;
  at: string;
}) {
  return persistCandidateMutation(input.store, () => {
    const candidate = ownedCandidate(input.store, input.user, input.candidateId);
    const before = cloneAttempts(candidate);
    const attempt = candidate.identityBootstrapAttempts?.find(
      (item) => item.id === input.attemptId
    );
    if (!attempt) {
      fail("IDENTITY_BOOTSTRAP_NOT_FOUND", "身份引导任务不存在", 404);
    }
    if (attempt.taskStatus === "ended") {
      return {
        value: { candidate: structuredClone(candidate), attempt: structuredClone(attempt) },
        rollback: () => undefined
      };
    }
    Object.assign(attempt, {
      taskStatus: "ended",
      outcome: "failed",
      errorCode: input.errorCode.slice(0, 100),
      errorMessage: input.errorMessage.slice(0, 500),
      updatedAt: input.at,
      endedAt: input.at
    });
    event(
      attempt,
      "provider",
      "failed",
      "权威来源搜索未完成",
      attempt.errorMessage,
      input.at
    );
    return {
      value: { candidate: structuredClone(candidate), attempt: structuredClone(attempt) },
      rollback: () => {
        candidate.identityBootstrapAttempts = before;
      }
    };
  });
}

const terminalRunStatuses = new Set([
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed",
  "cancelled"
]);

function mergedEvidence(items: ProviderEvidenceSnapshot[][]) {
  const result = new Map<string, ProviderEvidenceSnapshot>();
  items.flat().forEach((item) => {
    result.set(
      `${item.providerId}\u0000${item.providerRecordId}\u0000${item.payloadHash}`,
      item
    );
  });
  return [...result.values()];
}

function bootstrapLineage(
  store: CrmStore,
  attempt: ProspectIdentityBootstrapAttempt
) {
  const guide = authorityGuide(attempt.providerId);
  const run = store.prospectSearchRuns.find((item) =>
    item.id === attempt.runId
    && item.ownerId === attempt.createdBy
  );
  if (!run) {
    fail(
      "IDENTITY_BOOTSTRAP_DATA_INTEGRITY",
      "身份引导缺少正式搜索运行",
      500
    );
  }
  const hits = store.prospectSourceRawHits.filter((item) =>
    item.runId === run.id
    && item.teamId === run.teamId
    && item.ownerId === run.ownerId
  );
  const hitIds = new Set(hits.map((item) => item.id));
  const processedHits = new Set((store.prospectCandidateProcessingStates || [])
    .filter((item) => hitIds.has(item.hitId))
    .map((item) => item.hitId));
  const terminal = terminalRunStatuses.has(run.status);
  if (!terminal || hits.some((item) => !processedHits.has(item.id))) {
    return { state: "running" as const, run, hits };
  }
  const rawRecordIds = new Set(hits.map((item) => item.recordId));
  const matchingClaims = store.organizationIdentityClaims.filter((item) =>
    item.teamId === run.teamId
    && item.ownerId === run.ownerId
    && rawRecordIds.has(item.rawRecordId)
    && item.authorityProfileCode === guide.profileCode
    && item.classification === "strong_identifier_eligible"
    && item.scheme === guide.scheme
    && item.jurisdiction === guide.jurisdiction
    && item.normalizedValue === attempt.normalizedIdentifier
  );
  const resolutionIds = new Set(matchingClaims.map((item) => item.resolutionId));
  const resolutions = store.organizationIdentityResolutions.filter((item) =>
    resolutionIds.has(item.id)
    && item.teamId === run.teamId
    && item.ownerId === run.ownerId
    && rawRecordIds.has(item.rawRecordId)
  );
  const conflict = resolutions
    .map((resolution) => store.organizationIdentityConflicts.find((item) =>
      item.id === resolution.conflictId
      && item.teamId === run.teamId
    ))
    .find(Boolean);
  if (conflict) {
    const resolution = resolutions.find((item) => item.conflictId === conflict.id)!;
    return { state: "conflict" as const, run, hits, resolution, conflict };
  }
  const resolved = resolutions.filter((item) =>
    ["new_entity", "exact_match"].includes(item.result)
    && item.organizationId
  );
  if (resolved.length > 1
    && new Set(resolved.map((item) => item.organizationId)).size > 1) {
    fail(
      "IDENTITY_BOOTSTRAP_DATA_INTEGRITY",
      "同一权威注册号在当前运行中解析到多个企业",
      500
    );
  }
  const resolution = resolved[0];
  if (!resolution) {
    return {
      state: run.status === "failed" || run.status === "cancelled"
        ? "failed" as const
        : "not_found" as const,
      run,
      hits
    };
  }
  const hit = hits.find((item) => item.recordId === resolution.rawRecordId);
  const coverage = hit
    ? store.prospectCoverageEvents.find((item) =>
        item.teamId === run.teamId
        && item.ownerId === run.ownerId
        && item.runId === run.id
        && item.sourceHitId === hit.id
        && item.resolutionId === resolution.id
      )
    : undefined;
  const prospect = coverage
    ? store.tenantProspects.find((item) =>
        item.id === coverage.prospectId
        && item.teamId === run.teamId
        && item.organizationId === resolution.organizationId
      )
    : undefined;
  if (!hit || !coverage || !prospect) {
    fail(
      "IDENTITY_BOOTSTRAP_DATA_INTEGRITY",
      "权威企业身份已解析，但团队覆盖血缘不完整",
      500
    );
  }
  const processingCandidateIds = new Set((store.prospectCandidateProcessingStates || [])
    .filter((item) => item.runId === run.id && item.candidateId)
    .map((item) => item.candidateId!));
  const sourceCandidates = store.websiteOpportunities.filter((item) =>
    item.teamId === run.teamId
    && item.ownerId === run.ownerId
    && item.organizationId === resolution.organizationId
    && (processingCandidateIds.has(item.id)
      || item.sourceEvidence?.some((evidence) =>
        evidence.providerId === attempt.providerId
        && evidence.providerRecordId === attempt.registrationNumber
      ))
  );
  return {
    state: "linked" as const,
    run,
    hits,
    hit,
    resolution,
    coverage,
    prospect,
    sourceCandidates
  };
}

export async function reconcileProspectIdentityBootstrap(input: {
  store: CrmStore;
  user: SessionUser;
  candidateId: string;
  attemptId: string;
  at: string;
}) {
  const candidate = ownedCandidate(input.store, input.user, input.candidateId);
  const current = candidate.identityBootstrapAttempts?.find(
    (item) => item.id === input.attemptId
  );
  if (!current) {
    fail("IDENTITY_BOOTSTRAP_NOT_FOUND", "身份引导任务不存在", 404);
  }
  if (current.taskStatus === "ended") {
    return { candidate: structuredClone(candidate), attempt: structuredClone(current), changed: false };
  }
  if (!current.runId) {
    return { candidate: structuredClone(candidate), attempt: structuredClone(current), changed: false };
  }
  const lineage = bootstrapLineage(input.store, current);
  if (lineage.state === "running") {
    return { candidate: structuredClone(candidate), attempt: structuredClone(current), changed: false };
  }
  return persistCandidateMutation(input.store, () => {
    const target = ownedCandidate(input.store, input.user, input.candidateId);
    const before = structuredClone(target);
    const attempt = target.identityBootstrapAttempts?.find(
      (item) => item.id === input.attemptId
    );
    if (!attempt) {
      fail("IDENTITY_BOOTSTRAP_NOT_FOUND", "身份引导任务不存在", 404);
    }
    if (attempt.taskStatus === "ended") {
      return {
        value: { candidate: structuredClone(target), attempt: structuredClone(attempt), changed: false },
        rollback: () => undefined
      };
    }
    event(
      attempt,
      "provider",
      lineage.state === "failed" ? "failed" : "completed",
      lineage.state === "failed" ? "权威来源运行失败" : "权威来源搜索已结束",
      `Run ${lineage.run.id}，原始命中 ${lineage.hits.length} 条`,
      input.at
    );
    if (lineage.state === "failed" || lineage.state === "not_found") {
      Object.assign(attempt, {
        taskStatus: "ended",
        outcome: lineage.state === "failed" ? "failed" : "not_found",
        errorCode: lineage.state === "failed"
          ? "AUTHORITY_PROVIDER_RUN_FAILED"
          : "AUTHORITY_IDENTIFIER_NOT_FOUND",
        errorMessage: lineage.state === "failed"
          ? "权威数据源运行失败，请查看来源详情后重试"
          : "权威数据源未返回与该注册号一致的正式企业记录",
        updatedAt: input.at,
        endedAt: input.at
      });
      event(
        attempt,
        "identity",
        "failed",
        "正式企业身份未建立",
        attempt.errorMessage,
        input.at
      );
    } else if (lineage.state === "conflict") {
      Object.assign(attempt, {
        taskStatus: "ended",
        outcome: "identity_conflict",
        resolutionId: lineage.resolution.id,
        conflictId: lineage.conflict.id,
        errorCode: "AUTHORITY_IDENTITY_CONFLICT",
        errorMessage: "权威标识与已有企业身份发生冲突，需先完成人工冲突审核",
        updatedAt: input.at,
        endedAt: input.at
      });
      event(
        attempt,
        "identity",
        "failed",
        "企业身份存在冲突",
        attempt.errorMessage,
        input.at
      );
    } else {
      if (lineage.state !== "linked"
        || !lineage.resolution
        || !lineage.prospect
        || !lineage.coverage
        || !lineage.hit
        || !lineage.sourceCandidates) {
        fail(
          "IDENTITY_BOOTSTRAP_DATA_INTEGRITY",
          "身份引导终态缺少可绑定的正式血缘",
          500
        );
      }
      if (target.organizationId
        && target.organizationId !== lineage.resolution.organizationId) {
        fail(
          "IDENTITY_BOOTSTRAP_CONFLICT",
          "候选已绑定到另一企业，不能覆盖正式身份"
        );
      }
      if (target.tenantProspectId
        && target.tenantProspectId !== lineage.prospect.id) {
        fail(
          "IDENTITY_BOOTSTRAP_CONFLICT",
          "候选已绑定到另一团队覆盖对象，不能覆盖"
        );
      }
      const sourceEvidence = mergedEvidence([
        target.sourceEvidence || [],
        ...lineage.sourceCandidates.map((item) => item.sourceEvidence || [])
      ]);
      Object.assign(target, {
        tenantProspectId: lineage.prospect.id,
        organizationId: lineage.resolution.organizationId,
        coverageClassification: lineage.coverage.classification,
        coverageQueueState: lineage.prospect.queueState,
        coverageReasonCode: lineage.coverage.reasonCode,
        sourceEvidence
      });
      Object.assign(attempt, {
        taskStatus: "ended",
        outcome: "linked",
        sourceCandidateId: lineage.sourceCandidates[0]?.id || "",
        sourceRawRecordId: lineage.resolution.rawRecordId,
        sourceHitId: lineage.hit.id,
        resolutionId: lineage.resolution.id,
        organizationId: lineage.resolution.organizationId,
        tenantProspectId: lineage.prospect.id,
        errorCode: "",
        errorMessage: "",
        updatedAt: input.at,
        endedAt: input.at
      });
      event(
        attempt,
        "identity",
        "completed",
        "强企业身份已解析",
        `Resolution ${lineage.resolution.id}`,
        input.at
      );
      event(
        attempt,
        "coverage",
        "completed",
        "团队覆盖对象已确认",
        `TenantProspect ${lineage.prospect.id}`,
        input.at
      );
      event(
        attempt,
        "binding",
        "completed",
        "官网候选已绑定正式企业",
        `Organization ${lineage.resolution.organizationId}`,
        input.at
      );
      withProspectVerificationReport(target, input.at);
      refreshProspectScorecard(input.store, target, input.at);
    }
    return {
      value: {
        candidate: structuredClone(target),
        attempt: structuredClone(attempt),
        changed: !isDeepStrictEqual(before, target)
      },
      rollback: () => {
        Object.keys(target).forEach((key) => Reflect.deleteProperty(target, key));
        Object.assign(target, before);
      }
    };
  });
}

export function prospectIdentityBootstrapView(
  store: CrmStore,
  user: SessionUser,
  candidateId: string
) {
  const candidate = ownedCandidate(store, user, candidateId);
  return {
    candidateId: candidate.id,
    formallyResolved: Boolean(
      candidate.tenantProspectId && candidate.organizationId
    ),
    providers: PROSPECT_IDENTITY_AUTHORITY_GUIDES.map((guide) => {
      const catalog = store.providerCatalog.find((item) =>
        item.code === guide.id
      );
      return {
        ...guide,
        catalogStatus: catalog?.status || "disabled",
        docsUrl: catalog?.officialDocsUrl || ""
      };
    }),
    attempts: structuredClone(candidate.identityBootstrapAttempts || [])
  };
}
