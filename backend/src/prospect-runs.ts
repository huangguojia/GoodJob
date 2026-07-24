import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import { AI_SEARCH_ADAPTER_VERSION } from "./ai-search-provider.js";
import { getProvider } from "./lead-providers.js";
import { PROVIDER_CONTRACT_VERSION } from "./provider-contract.js";
import { isActiveProspectRun } from "./prospect-run-guards.js";
import {
  cancelProspectRunQueueBridge,
  PROSPECT_RUN_QUEUE_BRIDGE_VERSION,
  ProspectRunQueueBridgeIntegrityError,
  registerProspectRunQueueBridge,
  validateProspectRunQueueBridge
} from "./prospect-run-queue-bridge.js";
import {
  prospectStrategyEtag,
  prospectStrategyRunReadinessIssues,
  resolveProspectStrategyQuery
} from "./prospect-strategies.js";
import { validateProspectSearchQueryPlan } from "./prospect-search-planner.js";
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import type {
  ProspectCampaign,
  ProspectCandidateProcessingState,
  ProspectExecutionPage,
  ProspectRunEvent,
  ProspectRunEventType,
  ProspectRunExecutionSnapshot,
  ProspectRunProviderSnapshot,
  ProspectRunShard,
  ProspectResolvedQuerySnapshot,
  ProspectSearchQueryPlanMetadata,
  ProspectSearchRun,
  ProspectSearchRunStatus,
  ProspectSourceRawHit,
  ProspectStrategy,
  SessionUser
} from "./types.js";

const RUN_CONTRACT_VERSION = "search_run_control_plane_v1";
const RUN_OPERATION_CODE = "create_search_run_v1";
const CURSOR_VERSION = 1;
const CURSOR_SORT = "created_at_desc_id_desc";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEVELOPMENT_IDEMPOTENCY_SECRET = randomBytes(48).toString("base64url");
const DEVELOPMENT_CURSOR_SECRET = randomBytes(48).toString("base64url");
const uuidV4Pattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const prospectRunIdSchema = z.string()
  .trim()
  .regex(new RegExp(`^pr_${uuidV4Pattern}$`, "i"));

export const prospectRunIdempotencyKeySchema = z.string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const createProspectRunSchema = z.object({
  reason: z.string().trim().max(500).optional()
}).strict();

export const prospectRunActionSchema = z.object({
  reason: z.string().trim().max(500).optional()
}).strict();

const prospectRunListQuerySchema = z.object({
  campaignId: z.string().trim().min(1).max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(),
  strategyId: z.string().trim().min(1).max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(),
  ownerId: z.string().trim().min(1).max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(),
  status: z.enum(["queued", "paused", "cancelled"]).optional(),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
}).strict();

const cursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  filterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sort: z.literal(CURSOR_SORT),
  createdAt: z.string().datetime(),
  id: prospectRunIdSchema
}).strict();

type CreateRunBody = z.infer<typeof createProspectRunSchema>;
type RunActionBody = z.infer<typeof prospectRunActionSchema>;
type RunListQuery = z.infer<typeof prospectRunListQuerySchema>;
type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export interface ProspectRunQueryPlanOverride {
  resolvedQuery: ProspectResolvedQuerySnapshot;
  metadata: ProspectSearchQueryPlanMetadata;
}

interface NormalizedRunFilters {
  campaignId: string | null;
  strategyId: string | null;
  ownerId: string | null;
  status: ProspectSearchRunStatus | null;
}

export class ProspectRunRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ProspectRunRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function prospectRunMetadata() {
  return {
    contractVersion: RUN_CONTRACT_VERSION,
    executionMode: "control_plane_only_v1",
    executionAvailable: false,
    hasExecutionData: false
  } as const;
}

export function validateProspectRunSecurity() {
  const idempotencySecret =
    process.env.PROSPECT_RUN_IDEMPOTENCY_SECRET?.trim() || "";
  const cursorSecret = process.env.PROSPECT_RUN_CURSOR_SECRET?.trim() || "";
  if (process.env.NODE_ENV === "production"
    && Buffer.byteLength(idempotencySecret, "utf8") < 32) {
    throw new Error(
      "生产环境必须配置至少 32 字节的 PROSPECT_RUN_IDEMPOTENCY_SECRET"
    );
  }
  if (process.env.NODE_ENV === "production"
    && Buffer.byteLength(cursorSecret, "utf8") < 32) {
    throw new Error(
      "生产环境必须配置至少 32 字节的 PROSPECT_RUN_CURSOR_SECRET"
    );
  }
}

function configuredSecret(
  environmentName: "PROSPECT_RUN_IDEMPOTENCY_SECRET" | "PROSPECT_RUN_CURSOR_SECRET",
  fallback: string
) {
  const configured = process.env[environmentName]?.trim() || "";
  if (configured && Buffer.byteLength(configured, "utf8") < 32) {
    throw new Error(`${environmentName} 至少需要 32 字节`);
  }
  return configured || fallback;
}

function stableHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function prospectRunExecutionSnapshotHash(
  snapshot: ProspectRunExecutionSnapshot
) {
  return stableHash(snapshot);
}

function idempotencyKeyHash(rawKey: string) {
  return createHmac(
    "sha256",
    configuredSecret(
      "PROSPECT_RUN_IDEMPOTENCY_SECRET",
      DEVELOPMENT_IDEMPOTENCY_SECRET
    )
  )
    .update(rawKey)
    .digest("hex");
}

function createRequestHash(input: {
  strategyId: string;
  ifMatch: string;
  body: CreateRunBody;
  queryPlanOverride?: ProspectRunQueryPlanOverride;
}) {
  return stableHash({
    contractVersion: RUN_CONTRACT_VERSION,
    method: "POST",
    path: `/api/prospect-strategies/${input.strategyId}/runs`,
    strategyId: input.strategyId,
    ifMatch: input.ifMatch.trim(),
    body: {
      reason: input.body.reason?.trim() || ""
    },
    ...(input.queryPlanOverride
      ? { queryPlanOverride: input.queryPlanOverride }
      : {})
  });
}

function assertRunRole(user: SessionUser) {
  if (user.role === "super_admin") {
    throw new ProspectRunRequestError(
      403,
      "RUN_ACCESS_FORBIDDEN",
      "超级管理员默认不能访问团队搜索运行"
    );
  }
}

function canReadCampaign(user: SessionUser, campaign: ProspectCampaign) {
  if (user.role === "super_admin") return false;
  if (user.role === "manager" || user.role === "admin") {
    return user.teamId === campaign.teamId;
  }
  return user.teamId === campaign.teamId && user.id === campaign.ownerId;
}

function visibleCampaign(
  store: CrmStore,
  user: SessionUser,
  campaignId: string,
  teamId?: string
) {
  assertRunRole(user);
  const campaign = store.prospectCampaigns.find((item) =>
    item.id === campaignId && (!teamId || item.teamId === teamId)
  );
  return campaign && canReadCampaign(user, campaign) ? campaign : null;
}

function findVisibleStrategy(
  store: CrmStore,
  user: SessionUser,
  strategyId: string
) {
  assertRunRole(user);
  const strategy = store.prospectStrategies.find((item) => item.id === strategyId);
  if (!strategy) {
    throw new ProspectRunRequestError(
      404,
      "STRATEGY_NOT_FOUND",
      "搜索策略不存在或无权访问"
    );
  }
  const campaign = visibleCampaign(
    store,
    user,
    strategy.campaignId,
    strategy.teamId
  );
  if (!campaign) {
    throw new ProspectRunRequestError(
      404,
      "STRATEGY_NOT_FOUND",
      "搜索策略不存在或无权访问"
    );
  }
  return { strategy, campaign };
}

function findVisibleRun(
  store: CrmStore,
  user: SessionUser,
  runId: string
) {
  assertRunRole(user);
  const run = store.prospectSearchRuns.find((item) => item.id === runId);
  const campaign = run
    ? visibleCampaign(store, user, run.campaignId, run.teamId)
    : null;
  if (!run || !campaign) {
    throw new ProspectRunRequestError(
      404,
      "RUN_NOT_FOUND",
      "搜索运行不存在或无权访问"
    );
  }
  return { run, campaign };
}

function assertStrategyIfMatch(strategy: ProspectStrategy, ifMatch?: string) {
  if (!ifMatch) {
    throw new ProspectRunRequestError(
      428,
      "PRECONDITION_REQUIRED",
      "创建搜索运行必须提供 Strategy If-Match"
    );
  }
  const expected = prospectStrategyEtag(strategy);
  if (ifMatch.trim() !== expected) {
    throw new ProspectRunRequestError(
      412,
      "STRATEGY_REVISION_CONFLICT",
      "搜索策略已被其他操作更新，请刷新后重试",
      { revision: strategy.revision, etag: expected }
    );
  }
}

export function prospectRunEtag(
  run: Pick<ProspectSearchRun, "id" | "revision">
) {
  return `"${run.id}:${run.revision}"`;
}

function assertRunIfMatch(run: ProspectSearchRun, ifMatch?: string) {
  if (!ifMatch) {
    throw new ProspectRunRequestError(
      428,
      "PRECONDITION_REQUIRED",
      "修改搜索运行必须提供 If-Match"
    );
  }
  const expected = prospectRunEtag(run);
  if (ifMatch.trim() !== expected) {
    throw new ProspectRunRequestError(
      412,
      "RUN_REVISION_CONFLICT",
      "搜索运行已被其他操作更新，请刷新后重试",
      { revision: run.revision, etag: expected }
    );
  }
}

function campaignVersion(
  store: CrmStore,
  campaign: ProspectCampaign,
  versionNumber: number
) {
  const version = store.prospectCampaignVersions.find((item) =>
    item.teamId === campaign.teamId
    && item.campaignId === campaign.id
    && item.version === versionNumber
  );
  if (!version) {
    throw new ProspectRunRequestError(
      409,
      "RUN_SOURCE_INTEGRITY_INVALID",
      "搜索运行引用的项目版本不存在"
    );
  }
  return version;
}

function runReadinessIssues(
  store: CrmStore,
  campaign: ProspectCampaign,
  strategy: ProspectStrategy
) {
  const issues: Array<{
    code: string;
    field: string;
    message: string;
    providerId?: string;
  }> = [];
  if (campaign.status !== "active") {
    issues.push({
      code: "CAMPAIGN_NOT_ACTIVE",
      field: "campaign.status",
      message: "获客项目必须处于活动状态"
    });
  }
  return [
    ...issues,
    ...prospectStrategyRunReadinessIssues(store, campaign, strategy)
  ];
}

function providerSnapshot(
  store: CrmStore,
  strategy: ProspectStrategy
): ProspectRunProviderSnapshot[] {
  return strategy.providerPlan.map((plan, index) => {
    const catalog = store.providerCatalog.find((item) =>
      item.code.toLocaleLowerCase("en-US") === plan.providerId
    );
    if (!catalog) {
      throw new ProspectRunRequestError(
        409,
        "RUN_SOURCE_INTEGRITY_INVALID",
        `数据源 ${plan.providerId} 不在当前目录中`
      );
    }
    const provider = plan.providerId === "ai_search"
      ? null
      : getProvider(plan.providerId);
    if (plan.providerId !== "ai_search" && !provider) {
      throw new ProspectRunRequestError(
        409,
        "RUN_SOURCE_INTEGRITY_INVALID",
        `数据源 ${plan.providerId} 缺少执行适配器`
      );
    }
    return {
      providerCode: plan.providerId,
      position: index + 1,
      priority: plan.priority,
      pageLimit: plan.pageLimit,
      resultLimit: plan.resultLimit,
      budgetLimit: plan.budgetLimit,
      currency: plan.currency,
      adapterVersion: provider?.adapterVersion || AI_SEARCH_ADAPTER_VERSION,
      contractVersion: provider?.contractVersion || PROVIDER_CONTRACT_VERSION,
      catalogVersion: catalog.version,
      capabilities: [...catalog.capabilities].sort(),
      accessMode: catalog.accessMode
    };
  });
}

function executionSnapshot(
  store: CrmStore,
  campaign: ProspectCampaign,
  strategy: ProspectStrategy,
  queryPlanOverride?: ProspectRunQueryPlanOverride
): ProspectRunExecutionSnapshot {
  const version = campaignVersion(store, campaign, strategy.campaignVersion);
  if (queryPlanOverride) {
    validateProspectSearchQueryPlan({
      metadata: queryPlanOverride.metadata,
      resolvedQuery: queryPlanOverride.resolvedQuery
    });
    const mission = store.prospectSuperSearchMissions.find((item) =>
      item.id === queryPlanOverride.metadata.missionId
      && item.teamId === campaign.teamId
      && item.ownerId === campaign.ownerId
      && item.campaignId === campaign.id
      && item.strategyId === strategy.id
    );
    if (!mission
      || queryPlanOverride.metadata.roundNo !== mission.currentRound + 1
      || queryPlanOverride.metadata.roundNo > mission.maxRounds) {
      throw new ProspectRunRequestError(
        409,
        "RUN_QUERY_PLAN_INVALID",
        "超级搜索查询计划与当前任务轮次不一致"
      );
    }
  }
  return {
    contractVersion: RUN_CONTRACT_VERSION,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      version: version.version,
      contentHash: version.contentHash,
      snapshot: structuredClone(version.snapshot)
    },
    strategy: {
      id: strategy.id,
      name: strategy.name,
      revision: strategy.revision,
      fingerprintVersion: strategy.fingerprintVersion,
      queryFingerprint: strategy.queryFingerprint,
      query: structuredClone(strategy.query)
    },
    resolvedQuery: queryPlanOverride
      ? structuredClone(queryPlanOverride.resolvedQuery)
      : resolveProspectStrategyQuery(strategy.query, version),
    ...(queryPlanOverride
      ? { queryPlan: structuredClone(queryPlanOverride.metadata) }
      : {}),
    providerPlan: providerSnapshot(store, strategy)
  };
}

function publicExecutionSnapshot(snapshot: ProspectRunExecutionSnapshot) {
  return {
    contractVersion: snapshot.contractVersion,
    campaign: {
      id: snapshot.campaign.id,
      name: snapshot.campaign.name,
      version: snapshot.campaign.version,
      snapshot: structuredClone(snapshot.campaign.snapshot)
    },
    strategy: {
      id: snapshot.strategy.id,
      name: snapshot.strategy.name,
      revision: snapshot.strategy.revision,
      fingerprintVersion: snapshot.strategy.fingerprintVersion,
      query: structuredClone(snapshot.strategy.query)
    },
    resolvedQuery: structuredClone(snapshot.resolvedQuery),
    ...(snapshot.queryPlan
      ? { queryPlan: structuredClone(snapshot.queryPlan) }
      : {}),
    providerPlan: structuredClone(snapshot.providerPlan)
  };
}

function publicRun(run: ProspectSearchRun, includeSnapshot: boolean) {
  return {
    id: run.id,
    campaignId: run.campaignId,
    campaignVersion: run.campaignVersion,
    strategyId: run.strategyId,
    ownerId: run.ownerId,
    status: run.status,
    revision: run.revision,
    parentRunId: run.parentRunId || null,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    pausedAt: run.pausedAt || null,
    cancelledAt: run.cancelledAt || null,
    ...(includeSnapshot
      ? { executionSnapshot: publicExecutionSnapshot(run.executionSnapshot) }
      : {})
  };
}

function publicShard(shard: ProspectRunShard) {
  const { teamId: _teamId, ...visible } = shard;
  return visible;
}

function publicEvent(event: ProspectRunEvent) {
  const { teamId: _teamId, ...visible } = event;
  return visible;
}

function executionPhaseStatus(run: ProspectSearchRun, phase: "snapshot" | "queue" | "sources" | "raw" | "clean" | "pool", count = 0) {
  const terminal = ["succeeded", "succeeded_empty", "partial_success", "failed", "cancelled"].includes(run.status);
  if (phase === "snapshot") return "succeeded";
  if (phase === "queue") return run.status === "queued" ? "running" : "succeeded";
  if (phase === "sources") return run.status === "failed" ? "failed" : run.status === "partial_success" ? "partial" : terminal ? "succeeded" : "running";
  if (!terminal) return count > 0 ? "running" : "pending";
  if (run.status === "failed" && count === 0) return "blocked";
  return "succeeded";
}

function failureStage(errorCode: string, hasRequest: boolean) {
  if (/AUTH|CONNECTION|CONFIG|KEY/u.test(errorCode)) return "来源连接";
  if (/RATE|THROTTLE|QUOTA|BUDGET/u.test(errorCode)) return "额度与限流";
  if (/SCHEMA|RESPONSE|PARSE/u.test(errorCode)) return "响应解析";
  if (/TIMEOUT|NETWORK|HTTP|REJECT|OUTCOME/u.test(errorCode) || hasRequest) return "来源请求";
  if (/CANCEL|PAUSE/u.test(errorCode)) return "任务控制";
  return "来源执行";
}

function cleaningReasonLabel(code: string) {
  const labels: Record<string, string> = {
    PROVIDER_INVALID_RECORD: "来源返回记录缺少有效字段，已在适配器解析阶段淘汰",
    PROVIDER_DUPLICATE_RECORD: "来源页内记录重复，已在适配器归一阶段合并",
    CANDIDATE_PAYLOAD_INVALID: "候选缺少公司名、来源编号、时间或摘要等必需字段",
    PROSPECT_SOURCE_RAW_ENVELOPE_INVALID: "原始结果完整性校验失败，未进入候选池",
    CANDIDATE_ID_CONFLICT: "候选唯一标识与已有记录冲突",
    TEAM_FIRST_COVERAGE: "团队首次发现该企业，已进入候选池",
    MATERIAL_EVIDENCE_ADDED: "已有企业出现新增证据，已归并到原候选",
    REVIEW_DATE_REACHED: "已有企业达到复核时间，已重新进入核验队列",
    EXCLUSION_EXPIRED_REQUIRES_REVIEW: "原排除规则已到期，已重新进入复核",
    NO_MATERIAL_CHANGE: "已有企业且没有新增有效证据，不重复入池",
    IDENTITY_OR_SOURCE_MATCH: "来源记录、官网域名与国家或企业身份命中已有候选，证据已合并",
    COVERAGE_SUPPRESSED: "已命中团队重复、排除或勿联系规则，不重复进入候选池",
    CANDIDATE_ACCEPTED: "候选通过字段校验与身份归一，已进入候选池",
    PENDING_CLEANING: "来源已返回，但尚未完成字段校验、身份归一与覆盖分流"
  };
  return labels[code] || `按规则 ${code || "UNCLASSIFIED"} 完成处理`;
}

function prospectCleaningReport(
  store: CrmStore,
  run: ProspectSearchRun,
  shards: ProspectRunShard[],
  pages: ProspectExecutionPage[],
  rawHits: ProspectSourceRawHit[],
  processing: ProspectCandidateProcessingState[]
) {
  const shardById = new Map(shards.map((item) => [item.id, item]));
  const ledgerById = new Map(
    store.prospectProviderRequestLedgers
      .filter((item) => item.teamId === run.teamId && item.runId === run.id)
      .map((item) => [item.id, item])
  );
  const hitById = new Map(rawHits.map((item) => [item.id, item]));
  const coverageByHit = new Map(
    store.prospectCoverageEvents
      .filter((item) => item.teamId === run.teamId && item.runId === run.id && item.sourceHitId)
      .map((item) => [item.sourceHitId, item])
  );
  const candidateById = new Map(
    store.websiteOpportunities
      .filter((item) => item.teamId === run.teamId)
      .map((item) => [item.id, item])
  );
  const providerRawCount = pages.reduce((sum, item) => sum + item.rawCount, 0);
  const providerInvalidCount = pages.reduce((sum, item) => sum + item.invalidCount, 0);
  const providerDuplicateCount = pages.reduce((sum, item) => sum + item.duplicateCount, 0);
  const rejectedCount = processing.filter((item) => item.status === "rejected").length;
  const suppressedCount = processing.filter((item) => item.status === "completed" && !item.candidateId).length;
  const candidateReferences = processing.filter((item) => item.status === "completed" && item.candidateId);
  const candidateIds = new Set(candidateReferences.map((item) => item.candidateId!));
  const mergedCount = Math.max(0, candidateReferences.length - candidateIds.size);
  const pendingCount = Math.max(0, rawHits.length - processing.length);
  const reasonCounts = new Map<string, number>();
  const addReason = (code: string, count = 1) => {
    if (count > 0) reasonCounts.set(code, (reasonCounts.get(code) || 0) + count);
  };
  addReason("PROVIDER_INVALID_RECORD", providerInvalidCount);
  addReason("PROVIDER_DUPLICATE_RECORD", providerDuplicateCount);
  for (const item of processing) {
    if (item.status === "rejected") {
      addReason(item.failureCode || "CANDIDATE_PAYLOAD_INVALID");
      continue;
    }
    const coverage = coverageByHit.get(item.hitId);
    if (!item.candidateId) addReason(coverage?.reasonCode || "COVERAGE_SUPPRESSED");
    else if (coverage?.classification === "duplicate" || coverage?.classification === "new_intelligence") {
      addReason(coverage.reasonCode || "IDENTITY_OR_SOURCE_MATCH");
    }
  }
  const seenCandidateIds = new Set<string>();
  const processedRecords = [...processing]
    .sort((left, right) => left.processedAt.localeCompare(right.processedAt) || left.hitId.localeCompare(right.hitId))
    .map((item) => {
      const hit = hitById.get(item.hitId);
      const ledger = ledgerById.get(item.ledgerId);
      const providerCode = ledger?.providerCode || (hit ? shardById.get(hit.shardId)?.providerCode : "") || "unknown";
      const coverage = coverageByHit.get(item.hitId);
      const candidate = item.candidateId ? candidateById.get(item.candidateId) : undefined;
      let outcome: "accepted" | "merged" | "suppressed" | "rejected";
      let reasonCode: string;
      if (item.status === "rejected") {
        outcome = "rejected";
        reasonCode = item.failureCode || "CANDIDATE_PAYLOAD_INVALID";
      } else if (!item.candidateId) {
        outcome = "suppressed";
        reasonCode = coverage?.reasonCode || "COVERAGE_SUPPRESSED";
      } else if (coverage?.classification === "duplicate"
        || coverage?.classification === "new_intelligence"
        || seenCandidateIds.has(item.candidateId)) {
        outcome = "merged";
        reasonCode = coverage?.reasonCode || "IDENTITY_OR_SOURCE_MATCH";
      } else {
        outcome = "accepted";
        reasonCode = coverage?.reasonCode || "CANDIDATE_ACCEPTED";
      }
      if (item.candidateId) seenCandidateIds.add(item.candidateId);
      return {
        hitId: item.hitId,
        providerCode,
        outcome,
        reasonCode,
        reason: cleaningReasonLabel(reasonCode),
        candidateId: item.candidateId || "",
        candidateName: candidate?.company || "",
        processedAt: item.processedAt
      };
    });
  const processedHitIds = new Set(processing.map((item) => item.hitId));
  const pendingRecords = rawHits
    .filter((item) => !processedHitIds.has(item.id))
    .map((hit) => ({
      hitId: hit.id,
      providerCode: shardById.get(hit.shardId)?.providerCode || ledgerById.get(hit.ledgerId)?.providerCode || "unknown",
      outcome: "pending" as const,
      reasonCode: "PENDING_CLEANING",
      reason: cleaningReasonLabel("PENDING_CLEANING"),
      candidateId: "",
      candidateName: "",
      processedAt: hit.fetchedAt || hit.createdAt
    }));
  const records = [...processedRecords, ...pendingRecords]
    .sort((left, right) => left.processedAt.localeCompare(right.processedAt) || left.hitId.localeCompare(right.hitId))
    .slice(-100);
  return {
    summary: {
      providerRawCount,
      providerInvalidCount,
      providerDuplicateCount,
      pipelineHitCount: rawHits.length,
      processedCount: processing.length,
      pendingCount,
      rejectedCount,
      suppressedCount,
      mergedCount,
      candidateCount: candidateIds.size
    },
    stages: [
      { id: "provider_normalize", name: "来源解析", input: providerRawCount, output: rawHits.length, removed: providerInvalidCount + providerDuplicateCount, result: `无效 ${providerInvalidCount}，来源内重复 ${providerDuplicateCount}` },
      { id: "payload_validate", name: "字段校验", input: rawHits.length, output: Math.max(0, processing.length - rejectedCount), removed: rejectedCount, result: `拒绝 ${rejectedCount}，待处理 ${pendingCount}` },
      { id: "identity_merge", name: "身份归一", input: candidateReferences.length, output: candidateIds.size, removed: mergedCount, result: `归并 ${mergedCount} 条到已有候选` },
      { id: "coverage_route", name: "覆盖分流", input: processing.length, output: candidateIds.size, removed: suppressedCount, result: `重复、排除或勿联系分流 ${suppressedCount} 条` }
    ],
    reasons: [...reasonCounts.entries()]
      .map(([code, count]) => ({ code, label: cleaningReasonLabel(code), count }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
    sources: shards.map((shard) => {
      const sourcePages = pages.filter((item) => item.shardId === shard.id);
      const sourceLedgers = new Set(
        [...ledgerById.values()].filter((item) => item.shardId === shard.id).map((item) => item.id)
      );
      const sourceStates = processing.filter((item) => sourceLedgers.has(item.ledgerId));
      return {
        providerCode: shard.providerCode,
        rawCount: sourcePages.reduce((sum, item) => sum + item.rawCount, 0),
        invalidCount: sourcePages.reduce((sum, item) => sum + item.invalidCount, 0),
        duplicateCount: sourcePages.reduce((sum, item) => sum + item.duplicateCount, 0),
        processedCount: sourceStates.length,
        rejectedCount: sourceStates.filter((item) => item.status === "rejected").length,
        candidateCount: new Set(sourceStates.map((item) => item.candidateId).filter(Boolean)).size
      };
    }),
    records
  };
}

export function prospectRunDiagnostics(store: CrmStore, run: ProspectSearchRun) {
  const shards = store.prospectRunShards
    .filter((item) => item.teamId === run.teamId && item.runId === run.id)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  const rawHits = store.prospectSourceRawHits.filter((item) => item.teamId === run.teamId && item.runId === run.id);
  const pages = store.prospectExecutionPages.filter((item) => item.teamId === run.teamId && item.runId === run.id);
  const processing = (store.prospectCandidateProcessingStates || []).filter((item) => item.teamId === run.teamId && item.runId === run.id);
  const accepted = processing.filter((item) => item.status === "completed").length;
  const rejected = processing.filter((item) => item.status === "rejected").length;
  const succeededSources = shards.filter((item) => ["succeeded", "succeeded_empty", "partial_success"].includes(item.status)).length;
  const failedSources = shards.filter((item) => item.status === "failed").length;
  const phases = [
    { id: "snapshot", name: "策略与条件", status: executionPhaseStatus(run, "snapshot"), result: `${run.executionSnapshot.providerPlan.length} 个来源，策略版本 ${run.executionSnapshot.strategy.revision}` },
    { id: "queue", name: "任务调度", status: executionPhaseStatus(run, "queue"), result: run.status === "queued" ? "正在等待 Worker" : `运行状态 ${run.status}` },
    { id: "sources", name: "来源搜索", status: executionPhaseStatus(run, "sources"), result: `成功 ${succeededSources}，失败 ${failedSources}，共 ${shards.length}` },
    { id: "raw", name: "原始结果", status: executionPhaseStatus(run, "raw", rawHits.length), result: `${pages.length} 页，${rawHits.length} 条原始命中` },
    { id: "clean", name: "清洗归一", status: executionPhaseStatus(run, "clean", processing.length), result: `通过 ${accepted}，淘汰 ${rejected}` },
    { id: "pool", name: "候选入池", status: executionPhaseStatus(run, "pool", accepted), result: `${accepted} 条形成候选` }
  ];
  const sources = shards.map((shard) => {
    const binding = store.prospectRunQueueChildBindings.find((item) => item.teamId === run.teamId && item.runId === run.id && item.shardId === shard.id);
    const job = binding ? store.agentJobs.find((item) => item.id === binding.jobId && item.teamId === run.teamId) : undefined;
    const attempts = store.prospectExecutionAttempts
      .filter((item) => item.teamId === run.teamId && item.runId === run.id && item.shardId === shard.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const ledgers = store.prospectProviderRequestLedgers
      .filter((item) => item.teamId === run.teamId && item.runId === run.id && item.shardId === shard.id)
      .sort((left, right) => left.preparedAt.localeCompare(right.preparedAt));
    const checkpoint = store.prospectExecutionCheckpoints
      .filter((item) => item.teamId === run.teamId && item.runId === run.id && item.shardId === shard.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const latestAttempt = [...attempts].reverse().find((item) => item.errorCode || item.errorMessage);
    const latestLedger = [...ledgers].reverse().find((item) => item.errorCode || item.httpStatus || item.providerOutcomeCode);
    const storedErrorCode = latestAttempt?.errorCode || checkpoint?.lastErrorCode || job?.errorCode || latestLedger?.errorCode || "";
    const storedErrorMessage = latestAttempt?.errorMessage || checkpoint?.lastErrorMessage || job?.errorMessage || "";
    const legacyAiFailureDetailUnavailable = shard.providerCode === "ai_search"
      && [400, 404, 422].includes(latestLedger?.httpStatus || 0)
      && storedErrorCode === "PROVIDER_INTERNAL_ERROR";
    const errorCode = storedErrorCode;
    const errorMessage = legacyAiFailureDetailUnavailable
      ? `AI 搜索执行失败；HTTP ${latestLedger?.httpStatus} 是旧版调度器的兜底状态，不足以证明模型拒绝了请求。该任务未保存原始失败原因，请重新测试模型配置或重跑 AI 来源`
      : storedErrorMessage;
    const visibleLegacyMessage = (code: string, message: string) => legacyAiFailureDetailUnavailable && code === "PROVIDER_INTERNAL_ERROR"
      ? errorMessage
      : message;
    const failure = errorCode || errorMessage || shard.status === "failed" ? {
      stage: failureStage(errorCode, Boolean(latestLedger)),
      errorCode: errorCode || "PROVIDER_EXECUTION_FAILED",
      errorMessage: errorMessage || "来源执行失败，未返回更多说明",
      httpStatus: latestLedger?.httpStatus ?? null,
      providerOutcomeCode: latestLedger?.providerOutcomeCode || "",
      retryable: latestAttempt?.retryable ?? Boolean(job && job.attemptCount < job.maxAttempts),
      retryAfterAt: latestAttempt?.retryAfterAt || checkpoint?.retryAfterAt || job?.nextAttemptAt || "",
      occurredAt: latestAttempt?.finishedAt || job?.finishedAt || shard.updatedAt
    } : null;
    return {
      shardId: shard.id,
      providerCode: shard.providerCode,
      status: shard.status,
      job: job ? { id: job.id, status: job.status, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts, errorCode: job.errorCode, errorMessage: visibleLegacyMessage(job.errorCode, job.errorMessage), nextAttemptAt: job.nextAttemptAt, startedAt: job.startedAt, finishedAt: job.finishedAt } : null,
      checkpoint: checkpoint ? { pageSequence: checkpoint.pageSequence, totalCallCount: checkpoint.totalCallCount, acceptedCount: checkpoint.acceptedCount, rawCount: checkpoint.rawCount, invalidCount: checkpoint.invalidCount, duplicateCount: checkpoint.duplicateCount, partial: checkpoint.partial, completionReason: checkpoint.completionReason, lastErrorCode: checkpoint.lastErrorCode, lastErrorMessage: visibleLegacyMessage(checkpoint.lastErrorCode, checkpoint.lastErrorMessage), retryAfterAt: checkpoint.retryAfterAt, updatedAt: checkpoint.updatedAt } : null,
      attempts: attempts.slice(-12).map((item) => ({ id: item.id, attempt: item.providerAttemptNo, status: item.status, errorCode: item.errorCode, errorMessage: visibleLegacyMessage(item.errorCode, item.errorMessage), retryable: item.retryable, retryAfterAt: item.retryAfterAt, startedAt: item.startedAt, finishedAt: item.finishedAt })),
      requests: ledgers.slice(-12).map((item) => ({ id: item.id, endpointCode: item.endpointCode, status: item.status, httpStatus: item.httpStatus, providerOutcomeCode: item.providerOutcomeCode, settlementKind: item.settlementKind, errorCode: item.errorCode, preparedAt: item.preparedAt, responseReceivedAt: item.responseReceivedAt, settledAt: item.settledAt })),
      failure
    };
  });
  return {
    phases,
    sources,
    cleaningReport: prospectCleaningReport(store, run, shards, pages, rawHits, processing),
    summary: {
      rawHits: rawHits.length,
      pages: pages.length,
      accepted,
      rejected,
      succeededSources,
      failedSources,
      candidateIds: [...new Set(processing.filter((item) => item.status === "completed" && item.candidateId).map((item) => item.candidateId!))]
    }
  };
}

function runDetail(store: CrmStore, run: ProspectSearchRun) {
  verifyStoredSnapshot(run);
  verifyQueueBridge(store, run);
  return {
    ...prospectRunMetadata(),
    run: publicRun(run, true),
    shards: store.prospectRunShards
      .filter((item) => item.teamId === run.teamId && item.runId === run.id)
      .sort((left, right) =>
        left.position - right.position || left.id.localeCompare(right.id)
      )
      .map(publicShard),
    events: store.prospectRunEvents
      .filter((item) => item.teamId === run.teamId && item.runId === run.id)
      .sort((left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id)
      )
      .map(publicEvent),
    diagnostics: prospectRunDiagnostics(store, run)
  };
}

function snapshotRunState(store: CrmStore) {
  return {
    runs: structuredClone(store.prospectSearchRuns),
    shards: structuredClone(store.prospectRunShards),
    events: structuredClone(store.prospectRunEvents),
    jobs: structuredClone(store.agentJobs),
    jobAliases: structuredClone(store.agentJobIdempotencyAliases),
    parentBindings: structuredClone(store.prospectRunQueueParentBindings),
    childBindings: structuredClone(store.prospectRunQueueChildBindings)
  };
}

function restoreRunState(
  store: CrmStore,
  snapshot: ReturnType<typeof snapshotRunState>
) {
  store.prospectSearchRuns.splice(
    0,
    store.prospectSearchRuns.length,
    ...snapshot.runs
  );
  store.prospectRunShards.splice(
    0,
    store.prospectRunShards.length,
    ...snapshot.shards
  );
  store.prospectRunEvents.splice(
    0,
    store.prospectRunEvents.length,
    ...snapshot.events
  );
  store.agentJobs.splice(0, store.agentJobs.length, ...snapshot.jobs);
  store.agentJobIdempotencyAliases.splice(
    0,
    store.agentJobIdempotencyAliases.length,
    ...snapshot.jobAliases
  );
  store.prospectRunQueueParentBindings.splice(
    0,
    store.prospectRunQueueParentBindings.length,
    ...snapshot.parentBindings
  );
  store.prospectRunQueueChildBindings.splice(
    0,
    store.prospectRunQueueChildBindings.length,
    ...snapshot.childBindings
  );
}

async function persistRunMutation<T>(
  store: CrmStore,
  mutation: () => PersistedStoreMutation<T>
) {
  if (store.persistProspectExecutionMutation) {
    return store.persistProspectExecutionMutation(mutation);
  }
  if (store.persistMutation) return store.persistMutation(mutation);
  const applied = mutation();
  try {
    await store.persist();
    return applied.value;
  } catch (error) {
    applied.rollback();
    throw error;
  }
}

function nextEventSequence(store: CrmStore, run: ProspectSearchRun) {
  return store.prospectRunEvents.reduce(
    (highest, event) =>
      event.teamId === run.teamId && event.runId === run.id
        ? Math.max(highest, event.sequence)
        : highest,
    0
  ) + 1;
}

function createRunEvent(input: {
  store: CrmStore;
  run: ProspectSearchRun;
  eventType: ProspectRunEventType;
  actorId: string;
  requestId: string;
  fromStatus: ProspectSearchRunStatus | "";
  fromRevision: number;
  reason: string;
}) {
  return {
    id: `pre_${randomUUID()}`,
    teamId: input.run.teamId,
    runId: input.run.id,
    sequence: nextEventSequence(input.store, input.run),
    eventType: input.eventType,
    actorId: input.actorId,
    requestId: input.requestId,
    fromStatus: input.fromStatus,
    toStatus: input.run.status,
    fromRevision: input.fromRevision,
    toRevision: input.run.revision,
    reason: input.reason,
    createdAt: input.run.updatedAt
  } satisfies ProspectRunEvent;
}

function idempotencyMatch(input: {
  store: CrmStore;
  user: SessionUser;
  keyHash: string;
}) {
  return input.store.prospectSearchRuns.find((run) =>
    run.teamId === input.user.teamId
    && run.createdBy === input.user.id
    && run.operationCode === RUN_OPERATION_CODE
    && run.idempotencyKeyHash === input.keyHash
  );
}

function replayResult(input: {
  store: CrmStore;
  user: SessionUser;
  keyHash: string;
  requestHash: string;
}) {
  const run = idempotencyMatch(input);
  if (!run) return null;
  const campaign = visibleCampaign(
    input.store,
    input.user,
    run.campaignId,
    run.teamId
  );
  if (!campaign) {
    throw new ProspectRunRequestError(
      409,
      "IDEMPOTENCY_KEY_UNAVAILABLE",
      "该幂等键已用于当前不可访问的请求，请更换幂等键"
    );
  }
  if (run.requestHash !== input.requestHash) {
    throw new ProspectRunRequestError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "该 Idempotency-Key 已用于不同的搜索运行请求"
    );
  }
  return {
    ...runDetail(input.store, run),
    idempotencyReplayed: true,
    teamDuplicateAssociation: null
  };
}

function activeDuplicate(
  store: CrmStore,
  strategy: ProspectStrategy,
  ownerId: string
) {
  return store.prospectSearchRuns.find((run) =>
    run.teamId === strategy.teamId
    && run.ownerId === ownerId
    && run.queryFingerprint === strategy.queryFingerprint
    && isActiveProspectRun(run)
  );
}

function teamDuplicateAssociation(
  store: CrmStore,
  user: SessionUser,
  strategy: ProspectStrategy,
  ownerId: string
) {
  if (user.role !== "manager" && user.role !== "admin") return null;
  const duplicate = store.prospectSearchRuns.find((run) =>
    run.teamId === strategy.teamId
    && run.ownerId !== ownerId
    && run.queryFingerprint === strategy.queryFingerprint
    && isActiveProspectRun(run)
  );
  return duplicate ? {
    exists: true,
    runId: duplicate.id,
    campaignId: duplicate.campaignId,
    ownerId: duplicate.ownerId,
    status: duplicate.status
  } : null;
}

function isDuplicateKeyError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; errno?: unknown };
  return value.code === "ER_DUP_ENTRY" || value.errno === 1062;
}

async function recoverCreateConflict(input: {
  store: CrmStore;
  user: SessionUser;
  strategyId: string;
  keyHash: string;
  requestHash: string;
}) {
  try {
    await input.store.reloadProspectRuns?.();
  } catch {
    throw new ProspectRunRequestError(
      503,
      "RUN_CONFLICT_RECOVERY_UNAVAILABLE",
      "搜索运行并发冲突恢复暂不可用，请稍后重试"
    );
  }
  findVisibleStrategy(input.store, input.user, input.strategyId);
  const replay = replayResult(input);
  if (replay) return replay;
  const { strategy, campaign } = findVisibleStrategy(
    input.store,
    input.user,
    input.strategyId
  );
  const duplicate = activeDuplicate(
    input.store,
    strategy,
    campaign.ownerId
  );
  if (duplicate) {
    throw new ProspectRunRequestError(
      409,
      "ACTIVE_RUN_EXISTS",
      "当前负责人已有相同搜索范围的活动运行",
      { runId: duplicate.id, campaignId: duplicate.campaignId }
    );
  }
  throw new ProspectRunRequestError(
    409,
    "RUN_CONCURRENT_CONFLICT",
    "搜索运行已被并发请求更新，请刷新后重试"
  );
}

export async function createProspectRun(input: {
  store: CrmStore;
  user: SessionUser;
  strategyId: string;
  ifMatch?: string;
  idempotencyKey: string;
  body: CreateRunBody;
  requestId: string;
  queryPlanOverride?: ProspectRunQueryPlanOverride;
}) {
  const preflight = findVisibleStrategy(
    input.store,
    input.user,
    input.strategyId
  );
  const ifMatch = input.ifMatch || "";
  if (!ifMatch) {
    assertStrategyIfMatch(preflight.strategy, input.ifMatch);
  }
  const keyHash = idempotencyKeyHash(input.idempotencyKey);
  const requestHash = createRequestHash({
    strategyId: input.strategyId,
    ifMatch,
    body: input.body,
    queryPlanOverride: input.queryPlanOverride
  });

  try {
    return await persistRunMutation(input.store, () => {
      const { strategy, campaign } = findVisibleStrategy(
        input.store,
        input.user,
        input.strategyId
      );
      const replay = replayResult({
        store: input.store,
        user: input.user,
        keyHash,
        requestHash
      });
      if (replay) {
        return {
          value: replay,
          rollback: () => undefined
        };
      }
      assertStrategyIfMatch(strategy, input.ifMatch);

      const issues = runReadinessIssues(input.store, campaign, strategy);
      if (issues.length) {
        throw new ProspectRunRequestError(
          422,
          "RUN_NOT_READY",
          "搜索运行尚未通过就绪校验",
          { issues }
        );
      }
      const duplicate = activeDuplicate(
        input.store,
        strategy,
        campaign.ownerId
      );
      if (duplicate) {
        throw new ProspectRunRequestError(
          409,
          "ACTIVE_RUN_EXISTS",
          "当前负责人已有相同搜索范围的活动运行",
          { runId: duplicate.id, campaignId: duplicate.campaignId }
        );
      }
      const association = teamDuplicateAssociation(
        input.store,
        input.user,
        strategy,
        campaign.ownerId
      );
      const snapshot = executionSnapshot(
        input.store,
        campaign,
        strategy,
        input.queryPlanOverride
      );
      const before = snapshotRunState(input.store);
      const now = new Date().toISOString();
      const run: ProspectSearchRun = {
        id: `pr_${randomUUID()}`,
        teamId: campaign.teamId,
        campaignId: campaign.id,
        campaignVersion: campaign.currentVersion,
        strategyId: strategy.id,
        ownerId: campaign.ownerId,
        status: "queued",
        revision: 1,
        executionEpoch: 1,
        operationCode: RUN_OPERATION_CODE,
        idempotencyKeyHash: keyHash,
        requestHash,
        queryFingerprint: strategy.queryFingerprint,
        executionSnapshot: snapshot,
        executionSnapshotHash: prospectRunExecutionSnapshotHash(snapshot),
        queueBridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION,
        parentRunId: "",
        createdBy: input.user.id,
        createdAt: now,
        updatedAt: now,
        pausedAt: "",
        cancelledAt: ""
      };
      input.store.prospectSearchRuns.push(run);
      for (const provider of snapshot.providerPlan) {
        input.store.prospectRunShards.push({
          id: `prsh_${randomUUID()}`,
          teamId: run.teamId,
          runId: run.id,
          providerCode: provider.providerCode,
          position: provider.position,
          status: "queued",
          pageLimit: provider.pageLimit,
          resultLimit: provider.resultLimit,
          budgetLimit: provider.budgetLimit,
          currency: provider.currency,
          adapterVersion: provider.adapterVersion,
          contractVersion: provider.contractVersion,
          catalogVersion: provider.catalogVersion,
          capabilities: [...provider.capabilities],
          accessMode: provider.accessMode,
          hasCursor: false,
          createdAt: now,
          updatedAt: now
        });
      }
      input.store.prospectRunEvents.push(createRunEvent({
        store: input.store,
        run,
        eventType: "created",
        actorId: input.user.id,
        requestId: input.requestId,
        fromStatus: "",
        fromRevision: 0,
        reason: input.body.reason || "创建搜索运行控制意图"
      }));
      registerProspectRunQueueBridge(input.store, run);
      return {
        value: {
          ...runDetail(input.store, run),
          idempotencyReplayed: false,
          teamDuplicateAssociation: association
        },
        rollback: () => restoreRunState(input.store, before)
      };
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    return recoverCreateConflict({
      store: input.store,
      user: input.user,
      strategyId: input.strategyId,
      keyHash,
      requestHash
    });
  }
}

export function parseProspectRunListQuery(value: unknown) {
  return prospectRunListQuerySchema.parse(value);
}

function normalizedFilters(query: RunListQuery): NormalizedRunFilters {
  return {
    campaignId: query.campaignId || null,
    strategyId: query.strategyId || null,
    ownerId: query.ownerId || null,
    status: query.status || null
  };
}

function matchesFilters(run: ProspectSearchRun, filters: NormalizedRunFilters) {
  if (filters.campaignId && run.campaignId !== filters.campaignId) return false;
  if (filters.strategyId && run.strategyId !== filters.strategyId) return false;
  if (filters.ownerId && run.ownerId !== filters.ownerId) return false;
  if (filters.status && run.status !== filters.status) return false;
  return true;
}

function compareRuns(left: ProspectSearchRun, right: ProspectSearchRun) {
  return right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id);
}

function afterCursor(run: ProspectSearchRun, cursor: CursorPayload) {
  return run.createdAt < cursor.createdAt
    || (run.createdAt === cursor.createdAt && run.id < cursor.id);
}

function cursorContext(user: SessionUser) {
  return [user.teamId, user.id, user.role].join("\u001f");
}

function cursorSignature(encoded: string, context: string) {
  return createHmac(
    "sha256",
    configuredSecret("PROSPECT_RUN_CURSOR_SECRET", DEVELOPMENT_CURSOR_SECRET)
  )
    .update(context)
    .update("\n")
    .update(encoded)
    .digest("base64url");
}

function validSignature(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function encodeCursor(payload: CursorPayload, context: string) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64url");
  return `${encoded}.${cursorSignature(encoded, context)}`;
}

function decodeCursor(value: string, context: string) {
  const [encoded, signature, ...rest] = value.split(".");
  if (!encoded || !signature || rest.length
    || !validSignature(signature, cursorSignature(encoded, context))) {
    throw new ProspectRunRequestError(
      400,
      "RUN_CURSOR_INVALID",
      "分页游标无效、已过期或不属于当前查询"
    );
  }
  try {
    return cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
    );
  } catch {
    throw new ProspectRunRequestError(
      400,
      "RUN_CURSOR_INVALID",
      "分页游标无效、已过期或不属于当前查询"
    );
  }
}

export function listProspectRuns(input: {
  store: CrmStore;
  user: SessionUser;
  query: RunListQuery;
}) {
  assertRunRole(input.user);
  const filters = normalizedFilters(input.query);
  const context = cursorContext(input.user);
  const filterFingerprint = stableHash(filters);
  const cursor = input.query.cursor
    ? decodeCursor(input.query.cursor, context)
    : null;
  if (cursor && cursor.filterFingerprint !== filterFingerprint) {
    throw new ProspectRunRequestError(
      400,
      "RUN_CURSOR_INVALID",
      "分页游标无效、已过期或不属于当前查询"
    );
  }
  const matched = input.store.prospectSearchRuns
    .filter((run) => Boolean(visibleCampaign(
      input.store,
      input.user,
      run.campaignId,
      run.teamId
    )))
    .filter((run) => matchesFilters(run, filters))
    .sort(compareRuns);
  const remaining = cursor
    ? matched.filter((run) => afterCursor(run, cursor))
    : matched;
  const page = remaining.slice(0, input.query.limit);
  const hasMore = remaining.length > page.length;
  const last = page.at(-1);
  return {
    ...prospectRunMetadata(),
    sort: CURSOR_SORT,
    filters,
    total: matched.length,
    pageCount: page.length,
    hasMore,
    nextCursor: hasMore && last
      ? encodeCursor({
          v: CURSOR_VERSION,
          filterFingerprint,
          sort: CURSOR_SORT,
          createdAt: last.createdAt,
          id: last.id
        }, context)
      : null,
    runs: page.map((run) => publicRun(run, false))
  };
}

export function getProspectRun(
  store: CrmStore,
  user: SessionUser,
  runId: string
) {
  return runDetail(store, findVisibleRun(store, user, runId).run);
}

function verifyStoredSnapshot(run: ProspectSearchRun) {
  if (prospectRunExecutionSnapshotHash(run.executionSnapshot)
    !== run.executionSnapshotHash) {
    throw new ProspectRunRequestError(
      409,
      "RUN_SNAPSHOT_INTEGRITY_INVALID",
      "搜索运行快照校验失败，不能继续变更状态"
    );
  }
}

function verifyQueueBridge(store: CrmStore, run: ProspectSearchRun) {
  try {
    return validateProspectRunQueueBridge(store, run);
  } catch (error) {
    if (error instanceof ProspectRunQueueBridgeIntegrityError) {
      throw new ProspectRunRequestError(
        409,
        error.code,
        "搜索运行队列桥接完整性校验失败，不能继续操作"
      );
    }
    throw error;
  }
}

function assertShardState(
  store: CrmStore,
  run: ProspectSearchRun,
  expectedStatus: ProspectSearchRunStatus
) {
  const shards = store.prospectRunShards.filter((item) =>
    item.teamId === run.teamId && item.runId === run.id
  );
  if (shards.length !== run.executionSnapshot.providerPlan.length
    || shards.some((shard) => shard.status !== expectedStatus)) {
    throw new ProspectRunRequestError(
      409,
      "RUN_SHARD_STATE_INVALID",
      "搜索运行分片状态不一致，不能继续变更状态"
    );
  }
  return shards;
}

function transitionDefinition(
  current: ProspectSearchRunStatus,
  action: "pause" | "resume" | "cancel"
) {
  if (action === "pause" && current === "queued") {
    return { status: "paused", eventType: "paused" } as const;
  }
  if (action === "resume" && current === "paused") {
    return { status: "queued", eventType: "resumed" } as const;
  }
  if (action === "cancel" && (current === "queued" || current === "paused")) {
    return { status: "cancelled", eventType: "cancelled" } as const;
  }
  throw new ProspectRunRequestError(
    409,
    "RUN_STATE_INVALID",
    `搜索运行不能从 ${current} 执行 ${action}`
  );
}

export async function transitionProspectRun(input: {
  store: CrmStore;
  user: SessionUser;
  runId: string;
  ifMatch?: string;
  action: "pause" | "resume" | "cancel";
  body: RunActionBody;
  requestId: string;
}) {
  return persistRunMutation(input.store, () => {
    const before = snapshotRunState(input.store);
    const { run, campaign } = findVisibleRun(
      input.store,
      input.user,
      input.runId
    );
    assertRunIfMatch(run, input.ifMatch);
    verifyStoredSnapshot(run);
    verifyQueueBridge(input.store, run);
    const transition = transitionDefinition(run.status, input.action);
    if (input.action === "resume") {
      const strategy = input.store.prospectStrategies.find((item) =>
        item.id === run.strategyId
        && item.teamId === run.teamId
        && item.campaignId === run.campaignId
      );
      if (!strategy || campaign.ownerId !== run.ownerId) {
        throw new ProspectRunRequestError(
          409,
          "RUN_SOURCE_INTEGRITY_INVALID",
          "搜索运行与当前项目或策略归属不一致"
        );
      }
      const issues = runReadinessIssues(input.store, campaign, strategy);
      if (issues.length) {
        throw new ProspectRunRequestError(
          422,
          "RUN_NOT_READY",
          "搜索运行恢复前的就绪校验未通过",
          { issues }
        );
      }
      const duplicate = input.store.prospectSearchRuns.find((item) =>
        item.id !== run.id
        && item.teamId === run.teamId
        && item.ownerId === run.ownerId
        && item.queryFingerprint === run.queryFingerprint
        && isActiveProspectRun(item)
      );
      if (duplicate) {
        throw new ProspectRunRequestError(
          409,
          "ACTIVE_RUN_EXISTS",
          "当前负责人已有相同搜索范围的活动运行",
          { runId: duplicate.id, campaignId: duplicate.campaignId }
        );
      }
    }
    const shards = assertShardState(input.store, run, run.status);
    const previousStatus = run.status;
    const previousRevision = run.revision;
    const now = new Date().toISOString();
    if (input.action === "cancel") {
      cancelProspectRunQueueBridge(input.store, run, now);
    }
    run.status = transition.status;
    run.revision += 1;
    run.updatedAt = now;
    run.pausedAt = transition.status === "paused"
      ? now
      : transition.status === "queued"
        ? ""
        : run.pausedAt;
    run.cancelledAt = transition.status === "cancelled" ? now : "";
    for (const shard of shards) {
      shard.status = transition.status;
      shard.updatedAt = now;
    }
    input.store.prospectRunEvents.push(createRunEvent({
      store: input.store,
      run,
      eventType: transition.eventType,
      actorId: input.user.id,
      requestId: input.requestId,
      fromStatus: previousStatus,
      fromRevision: previousRevision,
      reason: input.body.reason || (
        input.action === "pause"
          ? "暂停搜索运行"
          : input.action === "resume"
            ? "恢复搜索运行"
            : "取消搜索运行"
      )
    }));
    return {
      value: runDetail(input.store, run),
      rollback: () => restoreRunState(input.store, before)
    };
  });
}
