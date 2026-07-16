import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import { getProvider } from "./lead-providers.js";
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
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import type {
  ProspectCampaign,
  ProspectRunEvent,
  ProspectRunEventType,
  ProspectRunExecutionSnapshot,
  ProspectRunProviderSnapshot,
  ProspectRunShard,
  ProspectSearchRun,
  ProspectSearchRunStatus,
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
}) {
  return stableHash({
    contractVersion: RUN_CONTRACT_VERSION,
    method: "POST",
    path: `/api/prospect-strategies/${input.strategyId}/runs`,
    strategyId: input.strategyId,
    ifMatch: input.ifMatch.trim(),
    body: {
      reason: input.body.reason?.trim() || ""
    }
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
      adapterVersion: provider?.adapterVersion || "ai-search-control-v1",
      contractVersion: provider?.contractVersion || RUN_CONTRACT_VERSION,
      catalogVersion: catalog.version,
      capabilities: [...catalog.capabilities].sort(),
      accessMode: catalog.accessMode
    };
  });
}

function executionSnapshot(
  store: CrmStore,
  campaign: ProspectCampaign,
  strategy: ProspectStrategy
): ProspectRunExecutionSnapshot {
  const version = campaignVersion(store, campaign, strategy.campaignVersion);
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
    resolvedQuery: resolveProspectStrategyQuery(strategy.query, version),
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
      .map(publicEvent)
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
    body: input.body
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
      const snapshot = executionSnapshot(input.store, campaign, strategy);
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
