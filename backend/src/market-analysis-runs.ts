import { z } from "zod";
import { decryptAgentJobPayload } from "./agent-job-security.js";
import {
  attachAgentJobIdempotencyAlias,
  completeAgentJob,
  enqueueAgentJob,
  failAgentJob,
  findAgentJobByIdempotency,
  publicAgentJob,
  retryAgentJob,
  startAgentJob
} from "./agent-jobs.js";
import {
  applyMarketTradeObservations,
  marketTradeObservationIdentity,
} from "./market-trade-observations.js";
import { materializeMarketOpportunityFacts } from "./market-opportunity-facts.js";
import {
  normalizeTradeQuery,
  ProviderContractError,
  providerErrorFromUnknown,
  type NormalizedTradeQuery,
  type ProviderErrorCode,
  type TradeObservation,
  type TradeQuery
} from "./provider-contract.js";
import { providerRequestFingerprint } from "./provider-request-logging.js";
import {
  createProviderExecutionContext,
  executeProviderTradeQuery
} from "./provider-runtime.js";
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import { getTradeProvider } from "./trade-providers.js";
import type { AgentJob, MarketTradeObservation, SessionUser } from "./types.js";

export const MARKET_ANALYSIS_JOB_TYPE = "prospect.market_analysis";
export const MARKET_ANALYSIS_AGGREGATE_TYPE = "prospect_campaign_ref_compat_v1";
const CAMPAIGN_CONTRACT_MODE = "compat_v1";
const CAMPAIGN_SCOPE = "owner";
const EXECUTION_MODE = "inline_single_instance_v1";

interface RunScope {
  jobId: string;
  teamId: string;
  ownerId: string;
  campaignId: string;
  providerId: string;
}

interface RunStateSnapshot {
  job: AgentJob | null;
  providerRequestLogs: CrmStore["providerRequestLogs"];
}

interface ObservationStateSnapshot {
  identities: Set<string>;
  observations: MarketTradeObservation[];
}

interface StoredMarketAnalysisInput {
  campaignId: string;
  providerId: string;
  requestFingerprint: string;
  query: NormalizedTradeQuery;
}

interface MarketAnalysisObservationResult {
  id: string;
  providerId: string;
  reporterCountry: string;
  reporterCode: string;
  partnerCountry: string;
  partnerCode: string;
  tradeFlow: "IMPORT" | "EXPORT";
  classification: string;
  commodityCode: string;
  commodityDescription: string;
  period: string;
  tradeValueUsd: number | null;
  netWeightKg: number | null;
  quantity: number | null;
  quantityUnit: string | null;
  isAggregate: boolean;
  suppressed: boolean;
  statusFlags: string[];
  adapterVersion: string;
  sourceRevision: string | null;
  observedAt: string;
}

interface MarketAnalysisExecutionResult extends Record<string, unknown> {
  resultScope: "job_execution";
  providerId: string;
  status: string;
  cacheStatus: string;
  rawCount: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  createdCount: number;
  updatedCount: number;
  exhausted: boolean;
  nextCursor: string | null;
  warnings: string[];
  usage: Record<string, unknown>;
  querySummary: NormalizedTradeQuery;
  observations: MarketAnalysisObservationResult[];
  marketOpportunityCalculation: {
    batchId: string;
    eventId: string;
    datasetFingerprint: string;
    policyVersion: string;
    outcome: string;
    reusedBatch: boolean;
  } | null;
}

const normalizedTradeQueryResultSchema = z.object({
  reporterCodes: z.array(z.string()).min(1).max(20),
  partnerCodes: z.array(z.string()).min(1).max(20),
  flow: z.enum(["import", "export"]),
  hsVersion: z.enum(["HS", "HS2017", "HS2022"]),
  commodityCodes: z.array(z.string()).min(1).max(50),
  periods: z.array(z.string()).min(1).max(36),
  frequency: z.enum(["annual", "monthly"]),
  limit: z.number().int().min(1).max(500)
}).strict();

const marketAnalysisObservationResultSchema = z.object({
  id: z.string().min(1).max(100),
  providerId: z.string().min(1).max(80),
  reporterCountry: z.string().max(100),
  reporterCode: z.string().max(16),
  partnerCountry: z.string().max(100),
  partnerCode: z.string().max(16),
  tradeFlow: z.enum(["IMPORT", "EXPORT"]),
  classification: z.string().max(40),
  commodityCode: z.string().max(32),
  commodityDescription: z.string().max(500),
  period: z.string().max(16),
  tradeValueUsd: z.number().finite().nonnegative().nullable(),
  netWeightKg: z.number().finite().nonnegative().nullable(),
  quantity: z.number().finite().nonnegative().nullable(),
  quantityUnit: z.string().max(40).nullable(),
  isAggregate: z.boolean(),
  suppressed: z.boolean(),
  statusFlags: z.array(z.string().max(80)).max(30),
  adapterVersion: z.string().min(1).max(40),
  sourceRevision: z.string().max(120).nullable(),
  observedAt: z.string().datetime()
}).strict();

const marketAnalysisUsageResultSchema = z.object({
  requestCount: z.number().int().nonnegative().nullable(),
  quotaUsed: z.number().nonnegative().nullable(),
  quotaRemaining: z.number().nonnegative().nullable(),
  costAmount: z.number().nonnegative().nullable(),
  currency: z.string().max(20).nullable(),
  estimated: z.boolean(),
  display: z.string().max(500)
}).strict();

const legacyMarketAnalysisExecutionResultSchema = z.object({
  providerId: z.string().min(1).max(80),
  status: z.enum(["success", "success_empty", "partial_success", "failed", "skipped"]),
  cacheStatus: z.enum(["live", "cache"]),
  rawCount: z.number().int().nonnegative(),
  validCount: z.number().int().nonnegative(),
  invalidCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  nextCursor: z.string().nullable(),
  warnings: z.array(z.string().max(1000)).max(100),
  usage: marketAnalysisUsageResultSchema
}).strict();

const marketAnalysisExecutionResultSchema = legacyMarketAnalysisExecutionResultSchema.extend({
  resultScope: z.literal("job_execution"),
  querySummary: normalizedTradeQueryResultSchema,
  observations: z.array(marketAnalysisObservationResultSchema).max(500),
  marketOpportunityCalculation: z.object({
    batchId: z.string().min(1).max(100),
    eventId: z.string().min(1).max(100),
    datasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    policyVersion: z.string().min(1).max(80),
    outcome: z.enum(["metrics_ready", "partial", "insufficient_data"]),
    reusedBatch: z.boolean()
  }).strict().nullable().optional().default(null)
}).strict();

interface ActiveMarketAnalysisRun {
  job: AgentJob;
  ready: Promise<boolean>;
  promise: Promise<MarketAnalysisExecutionResult>;
  persistAlias(operation: () => Promise<void>): Promise<void>;
}

const activeMarketAnalysisRuns = new Map<string, ActiveMarketAnalysisRun>();

export interface CreateMarketAnalysisRunInput {
  store: CrmStore;
  user: SessionUser;
  campaignId: string;
  providerId: string;
  idempotencyKey: string;
  query: TradeQuery;
}

export class MarketAnalysisRunRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "MarketAnalysisRunRequestError";
    this.status = status;
    this.code = code;
  }
}

export class MarketAnalysisRunProviderError extends Error {
  readonly status: number;
  readonly failure: ProviderContractError;
  readonly job: AgentJob;

  constructor(status: number, failure: ProviderContractError, job: AgentJob) {
    super(failure.publicMessage);
    this.name = "MarketAnalysisRunProviderError";
    this.status = status;
    this.failure = failure;
    this.job = job;
  }
}

export function marketAnalysisRunMetadata() {
  return {
    campaignContractMode: CAMPAIGN_CONTRACT_MODE,
    campaignScope: CAMPAIGN_SCOPE,
    executionMode: EXECUTION_MODE,
    retryMode: "manual",
    autoRetryScheduled: false
  } as const;
}

function activeRunKey(input: {
  teamId: string;
  ownerId: string;
  campaignId: string;
  providerId: string;
  requestFingerprint: string;
}) {
  return [
    input.teamId,
    input.ownerId,
    input.campaignId,
    input.providerId,
    input.requestFingerprint
  ].join("\u001f");
}

function runScope(job: AgentJob, storedInput: StoredMarketAnalysisInput): RunScope {
  return {
    jobId: job.id,
    teamId: job.teamId,
    ownerId: job.ownerId,
    campaignId: storedInput.campaignId,
    providerId: storedInput.providerId
  };
}

function snapshotRunState(store: CrmStore, scope: RunScope): RunStateSnapshot {
  return {
    job: structuredClone(store.agentJobs.find((item) => item.id === scope.jobId) || null),
    providerRequestLogs: structuredClone(
      store.providerRequestLogs.filter((item) => item.runId === scope.jobId)
    )
  };
}

function restoreRunState(store: CrmStore, scope: RunScope, snapshot: RunStateSnapshot) {
  const jobIndex = store.agentJobs.findIndex((item) => item.id === scope.jobId);
  if (jobIndex >= 0) {
    if (snapshot.job) store.agentJobs.splice(jobIndex, 1, snapshot.job);
    else store.agentJobs.splice(jobIndex, 1);
  } else if (snapshot.job) {
    store.agentJobs.unshift(snapshot.job);
  }

  const unrelatedLogs = store.providerRequestLogs.filter((item) => item.runId !== scope.jobId);
  store.providerRequestLogs.splice(
    0,
    store.providerRequestLogs.length,
    ...snapshot.providerRequestLogs,
    ...unrelatedLogs
  );
}

function snapshotObservationState(
  store: CrmStore,
  scope: RunScope,
  observations: TradeObservation[]
): ObservationStateSnapshot {
  const identities = new Set(observations.map((observation) =>
    marketTradeObservationIdentity({
      teamId: scope.teamId,
      ownerId: scope.ownerId,
      campaignId: scope.campaignId,
      providerId: scope.providerId,
      reporterCountry: observation.reporterCountry,
      partnerCountry: observation.partnerCountry,
      tradeFlow: observation.tradeFlow,
      classification: observation.classification,
      commodityCode: observation.commodityCode,
      period: observation.period
    })
  ));
  return {
    identities,
    observations: structuredClone(
      store.marketTradeObservations.filter((item) =>
        identities.has(marketTradeObservationIdentity(item))
      )
    )
  };
}

function restoreObservationState(
  store: CrmStore,
  snapshot: ObservationStateSnapshot
) {
  const unrelated = store.marketTradeObservations.filter((item) =>
    !snapshot.identities.has(marketTradeObservationIdentity(item))
  );
  store.marketTradeObservations.splice(
    0,
    store.marketTradeObservations.length,
    ...snapshot.observations,
    ...unrelated
  );
}

function requestFingerprint(
  campaignId: string,
  providerId: string,
  query: NormalizedTradeQuery
) {
  return providerRequestFingerprint({
    operation: MARKET_ANALYSIS_JOB_TYPE,
    campaignId,
    providerId,
    query
  });
}

function providerFailureStatus(failure: ProviderContractError) {
  if (failure.code === "PROVIDER_RATE_LIMITED") return 429;
  if (failure.code === "PROVIDER_TIMEOUT") return 504;
  if (failure.code === "PROVIDER_AUTH_FAILED"
    || failure.code === "PROVIDER_CONNECTION_INVALID"
    || failure.code === "PROVIDER_DISABLED"
    || failure.code === "PROVIDER_QUOTA_EXHAUSTED"
    || failure.code === "PROVIDER_POLICY_BLOCKED") return 409;
  return 502;
}

function isProviderErrorCode(value: string): value is ProviderErrorCode {
  return new Set<ProviderErrorCode>([
    "PROVIDER_AUTH_FAILED",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_QUOTA_EXHAUSTED",
    "PROVIDER_TIMEOUT",
    "PROVIDER_NETWORK_ERROR",
    "PROVIDER_SCHEMA_CHANGED",
    "PROVIDER_POLICY_BLOCKED",
    "PROVIDER_DISABLED",
    "PROVIDER_CONNECTION_INVALID",
    "PROVIDER_CATALOG_MISSING",
    "PROVIDER_NOT_REGISTERED",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_INTERNAL_ERROR"
  ]).has(value as ProviderErrorCode);
}

function cooldownFailure(job: AgentJob) {
  const code = isProviderErrorCode(job.errorCode)
    ? job.errorCode
    : "PROVIDER_UNAVAILABLE";
  return new ProviderContractError({
    code,
    retryable: true,
    retryAfterAt: job.nextAttemptAt || null,
    publicMessage: job.errorMessage || "当前任务尚未到允许重试时间",
    httpStatus: code === "PROVIDER_RATE_LIMITED" ? 429 : null,
    phase: "trade"
  });
}

function publicMarketAnalysisObservation(
  item: MarketTradeObservation
): MarketAnalysisObservationResult {
  return {
    id: item.id,
    providerId: item.providerId,
    reporterCountry: item.reporterCountry,
    reporterCode: item.reporterCode,
    partnerCountry: item.partnerCountry,
    partnerCode: item.partnerCode,
    tradeFlow: item.tradeFlow,
    classification: item.classification,
    commodityCode: item.commodityCode,
    commodityDescription: item.commodityDescription,
    period: item.period,
    tradeValueUsd: item.tradeValueUsd,
    netWeightKg: item.netWeightKg,
    quantity: item.quantity,
    quantityUnit: item.quantityUnit || null,
    isAggregate: item.isAggregate,
    suppressed: item.suppressed,
    statusFlags: [...item.statusFlags],
    adapterVersion: item.adapterVersion,
    sourceRevision: item.sourceRevision || null,
    observedAt: item.observedAt
  };
}

function completedSummary(
  job: AgentJob,
  fallbackQuery: NormalizedTradeQuery
): MarketAnalysisExecutionResult | null {
  if (!job.outputJsonEncrypted) return null;
  try {
    const output = decryptAgentJobPayload(job, "output", job.outputJsonEncrypted);
    const current = marketAnalysisExecutionResultSchema.safeParse(output);
    if (current.success) return current.data;
    const legacy = legacyMarketAnalysisExecutionResultSchema.safeParse(output);
    if (!legacy.success) return null;
    return {
      ...legacy.data,
      resultScope: "job_execution",
      querySummary: fallbackQuery,
      observations: [],
      marketOpportunityCalculation: null
    };
  } catch {
    return null;
  }
}

function storedInputForJob(job: AgentJob): StoredMarketAnalysisInput {
  let payload: Record<string, unknown>;
  try {
    payload = decryptAgentJobPayload(job, "input", job.inputJsonEncrypted);
  } catch {
    throw new MarketAnalysisRunRequestError(
      409,
      "IDEMPOTENCY_STATE_INVALID",
      "历史运行状态不可读取，请更换幂等键后重试"
    );
  }
  const campaignId = typeof payload.campaignId === "string" ? payload.campaignId : "";
  const providerId = typeof payload.providerId === "string" ? payload.providerId : "";
  const storedFingerprint = typeof payload.requestFingerprint === "string"
    ? payload.requestFingerprint
    : "";
  let query: NormalizedTradeQuery;
  try {
    query = normalizeTradeQuery(payload.query as TradeQuery);
  } catch {
    throw new MarketAnalysisRunRequestError(
      409,
      "IDEMPOTENCY_STATE_INVALID",
      "历史市场分析参数已损坏，请更换幂等键后重试"
    );
  }
  if (!campaignId
    || !providerId
    || !storedFingerprint
    || requestFingerprint(campaignId, providerId, query) !== storedFingerprint
    || job.aggregateType !== MARKET_ANALYSIS_AGGREGATE_TYPE
    || job.aggregateId !== campaignId) {
    throw new MarketAnalysisRunRequestError(
      409,
      "IDEMPOTENCY_STATE_INVALID",
      "历史市场分析任务与兼容项目引用不一致，请更换幂等键后重试"
    );
  }
  return {
    campaignId,
    providerId,
    requestFingerprint: storedFingerprint,
    query
  };
}

function assertJobOwner(job: AgentJob, user: SessionUser) {
  if (job.teamId !== user.teamId || job.ownerId !== user.id) {
    throw new MarketAnalysisRunRequestError(404, "JOB_NOT_FOUND", "任务不存在或无权执行");
  }
}

function assertRetryDue(job: AgentJob) {
  if (!job.nextAttemptAt) return;
  const retryAt = new Date(job.nextAttemptAt);
  if (Number.isFinite(retryAt.getTime()) && retryAt.getTime() > Date.now()) {
    const failure = cooldownFailure(job);
    throw new MarketAnalysisRunProviderError(
      providerFailureStatus(failure),
      failure,
      job
    );
  }
}

function findMatchingCooldownJob(
  store: CrmStore,
  input: {
    user: SessionUser;
    campaignId: string;
    providerId: string;
    requestFingerprint: string;
  }
) {
  const now = Date.now();
  const candidates = store.agentJobs
    .filter((job) =>
      job.teamId === input.user.teamId
      && job.ownerId === input.user.id
      && job.jobType === MARKET_ANALYSIS_JOB_TYPE
      && job.aggregateType === MARKET_ANALYSIS_AGGREGATE_TYPE
      && job.aggregateId === input.campaignId
      && Boolean(job.nextAttemptAt)
      && new Date(job.nextAttemptAt).getTime() > now
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  for (const job of candidates) {
    const storedInput = storedInputForJob(job);
    if (storedInput.providerId === input.providerId
      && storedInput.requestFingerprint === input.requestFingerprint) {
      return job;
    }
  }
  return undefined;
}

async function attachAndPersistAlias(
  store: CrmStore,
  job: AgentJob,
  idempotencyScope: string
) {
  try {
    await persistStoreMutation(store, () => {
      const attached = attachAgentJobIdempotencyAlias(store, job, idempotencyScope);
      const attachedAliasId = attached.alias?.id || "";
      return {
        value: undefined,
        rollback: () => {
          if (!attachedAliasId) return;
          const aliasIndex = store.agentJobIdempotencyAliases.findIndex(
            (item) => item.id === attachedAliasId
          );
          if (aliasIndex >= 0) store.agentJobIdempotencyAliases.splice(aliasIndex, 1);
        }
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "该幂等键已绑定其他任务") {
      throw new MarketAnalysisRunRequestError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "该幂等键已用于不同的市场分析请求"
      );
    }
    throw error;
  }
}

async function persistStoreMutation<T>(
  store: CrmStore,
  mutation: () => PersistedStoreMutation<T>
) {
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

function prepareJobForExecution(job: AgentJob) {
  if (job.status === "running") {
    job.status = "failed";
    job.nextAttemptAt = "";
    job.finishedAt = new Date().toISOString();
    job.errorCode = "EXECUTION_INTERRUPTED";
    job.errorMessage = "服务重启前任务未完成，请手动重试";
  }
  if (job.status === "failed" || job.status === "dead_letter") {
    retryAgentJob(job);
  }
  if (job.status !== "queued" && job.status !== "retry_scheduled") {
    throw new MarketAnalysisRunRequestError(409, "JOB_NOT_RETRYABLE", "当前任务状态不能执行");
  }
}

function assertJobIdempotencyBindingAvailable(store: CrmStore, job: AgentJob) {
  const conflictingPrimary = store.agentJobs.find((item) =>
    item.id !== job.id
    && item.teamId === job.teamId
    && item.jobType === job.jobType
    && item.idempotencyKey === job.idempotencyKey
  );
  const conflictingAlias = store.agentJobIdempotencyAliases.find((item) =>
    item.jobId !== job.id
    && item.teamId === job.teamId
    && item.jobType === job.jobType
    && item.idempotencyKey === job.idempotencyKey
  );
  if (conflictingPrimary || conflictingAlias) {
    throw new MarketAnalysisRunRequestError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "该幂等键已用于不同的市场分析请求"
    );
  }
}

async function executeMarketAnalysisJob(input: {
  store: CrmStore;
  user: SessionUser;
  job: AgentJob;
  storedInput: StoredMarketAnalysisInput;
  onInitialPersisted?: () => void;
  beforeFinalPersist?: () => Promise<void>;
}) {
  const { store, user, job, storedInput } = input;
  assertJobOwner(job, user);
  const provider = getTradeProvider(storedInput.providerId);
  if (!provider) {
    throw new MarketAnalysisRunRequestError(400, "PROVIDER_NOT_REGISTERED", "未知的市场分析数据源");
  }
  const catalog = store.providerCatalog.find((item) => item.code === provider.id);
  if (!catalog) {
    throw new MarketAnalysisRunRequestError(409, "PROVIDER_CATALOG_MISSING", "市场分析数据源目录缺失");
  }
  assertRetryDue(job);
  const scope = runScope(job, storedInput);
  try {
    await persistStoreMutation(store, () => {
      const beforeStart = snapshotRunState(store, scope);
      assertJobIdempotencyBindingAvailable(store, job);
      if (!beforeStart.job) store.agentJobs.unshift(job);
      prepareJobForExecution(job);
      job.policyVersion = catalog.version;
      startAgentJob(job);
      return {
        value: undefined,
        rollback: () => restoreRunState(store, scope, beforeStart)
      };
    });
    input.onInitialPersisted?.();
  } catch (error) {
    throw error;
  }

  const runningSnapshot = snapshotRunState(store, scope);
  const connection = store.providerConnections.find((item) =>
    item.providerId === provider.id
    && item.scope === "personal"
    && item.ownerId === user.id
    && item.teamId === user.teamId
  );

  let page;
  try {
    page = await executeProviderTradeQuery({
      provider,
      catalog,
      context: createProviderExecutionContext({
        teamId: user.teamId,
        ownerId: user.id,
        runId: job.id,
        providerId: provider.id,
        operation: "trade",
        purpose: "prospect_campaign_market_analysis"
      }),
      connection,
      credential: connection ? undefined : { apiKey: "", baseUrl: "" },
      query: storedInput.query,
      onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
    });
  } catch (error) {
    const failure = providerErrorFromUnknown(error, "trade");
    failAgentJob(job, failure.code);
    job.nextAttemptAt = failure.retryable && failure.retryAfterAt
      ? failure.retryAfterAt
      : "";
    try {
      await store.persist();
    } catch (persistError) {
      restoreRunState(store, scope, runningSnapshot);
      throw persistError;
    }
    throw new MarketAnalysisRunProviderError(
      providerFailureStatus(failure),
      failure,
      job
    );
  }

  await input.beforeFinalPersist?.();
  try {
    return await persistStoreMutation(store, () => {
      const beforeFinal = {
        run: snapshotRunState(store, scope),
        observations: snapshotObservationState(store, scope, page.observations),
        batchIds: new Set(store.marketOpportunityBatches.map((item) => item.id)),
        snapshotIds: new Set(store.marketOpportunitySnapshots.map((item) => item.id)),
        calculationEventIds: new Set(
          store.marketOpportunityCalculationEvents.map((item) => item.id)
        )
      };
      const createdBatchIds = new Set<string>();
      const createdSnapshotIds = new Set<string>();
      const createdCalculationEventIds = new Set<string>();
      const restoreCreatedOpportunityFacts = () => {
        store.marketOpportunityBatches.splice(
          0,
          store.marketOpportunityBatches.length,
          ...store.marketOpportunityBatches.filter((item) => !createdBatchIds.has(item.id))
        );
        store.marketOpportunitySnapshots.splice(
          0,
          store.marketOpportunitySnapshots.length,
          ...store.marketOpportunitySnapshots.filter((item) => !createdSnapshotIds.has(item.id))
        );
        store.marketOpportunityCalculationEvents.splice(
          0,
          store.marketOpportunityCalculationEvents.length,
          ...store.marketOpportunityCalculationEvents.filter(
            (item) => !createdCalculationEventIds.has(item.id)
          )
        );
      };
      const restorePartiallyCreatedOpportunityFacts = () => {
        store.marketOpportunityBatches.splice(
          0,
          store.marketOpportunityBatches.length,
          ...store.marketOpportunityBatches.filter((item) => beforeFinal.batchIds.has(item.id))
        );
        store.marketOpportunitySnapshots.splice(
          0,
          store.marketOpportunitySnapshots.length,
          ...store.marketOpportunitySnapshots.filter((item) => beforeFinal.snapshotIds.has(item.id))
        );
        store.marketOpportunityCalculationEvents.splice(
          0,
          store.marketOpportunityCalculationEvents.length,
          ...store.marketOpportunityCalculationEvents.filter(
            (item) => beforeFinal.calculationEventIds.has(item.id)
          )
        );
      };
      try {
        const persistence = applyMarketTradeObservations(store, {
          teamId: user.teamId,
          ownerId: user.id,
          campaignId: storedInput.campaignId,
          providerId: provider.id,
          observations: page.observations,
          persist: false
        });
        const opportunity = materializeMarketOpportunityFacts(store, {
          teamId: user.teamId,
          ownerId: user.id,
          campaignId: storedInput.campaignId,
          triggerJobId: job.id
        });
        if (!opportunity.reusedBatch) createdBatchIds.add(opportunity.batch.id);
        for (const snapshot of opportunity.snapshots) createdSnapshotIds.add(snapshot.id);
        createdCalculationEventIds.add(opportunity.event.id);
        const result: MarketAnalysisExecutionResult = {
          resultScope: "job_execution",
          providerId: provider.id,
          status: page.status,
          cacheStatus: page.cacheStatus,
          rawCount: page.rawCount,
          validCount: page.validCount,
          invalidCount: page.invalidCount,
          duplicateCount: page.duplicateCount,
          createdCount: persistence.createdCount,
          updatedCount: persistence.updatedCount,
          exhausted: page.exhausted,
          nextCursor: page.nextCursor,
          warnings: page.warnings,
          usage: page.usage as unknown as Record<string, unknown>,
          querySummary: storedInput.query,
          observations: persistence.observations.map(publicMarketAnalysisObservation),
          marketOpportunityCalculation: {
            batchId: opportunity.batch.id,
            eventId: opportunity.event.id,
            datasetFingerprint: opportunity.batch.datasetFingerprint,
            policyVersion: opportunity.batch.policyVersion,
            outcome: opportunity.batch.status,
            reusedBatch: opportunity.reusedBatch
          }
        };
        completeAgentJob(job, result);
        return {
          value: result,
          rollback: () => {
            restoreRunState(store, scope, beforeFinal.run);
            restoreObservationState(store, beforeFinal.observations);
            restoreCreatedOpportunityFacts();
          }
        };
      } catch (error) {
        restoreRunState(store, scope, beforeFinal.run);
        restoreObservationState(store, beforeFinal.observations);
        restorePartiallyCreatedOpportunityFacts();
        throw error;
      }
    });
  } catch (error) {
    restoreRunState(store, scope, runningSnapshot);
    throw error;
  }
}

async function executeAsActiveRun(input: {
  store: CrmStore;
  user: SessionUser;
  job: AgentJob;
  storedInput: StoredMarketAnalysisInput;
}) {
  const key = activeRunKey({
    teamId: input.job.teamId,
    ownerId: input.job.ownerId,
    campaignId: input.storedInput.campaignId,
    providerId: input.storedInput.providerId,
    requestFingerprint: input.storedInput.requestFingerprint
  });
  const active = activeMarketAnalysisRuns.get(key);
  if (active) {
    return {
      duplicate: true,
      job: active.job,
      result: await active.promise
    };
  }

  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  let aliasPersistenceTail = Promise.resolve();
  const persistAlias = (operation: () => Promise<void>) => {
    const current = aliasPersistenceTail.then(operation);
    aliasPersistenceTail = current.catch(() => undefined);
    return current;
  };
  const promise = executeMarketAnalysisJob({
    ...input,
    onInitialPersisted: () => resolveReady(true),
    beforeFinalPersist: () => aliasPersistenceTail
  }).catch((error) => {
    resolveReady(false);
    throw error;
  });
  activeMarketAnalysisRuns.set(key, {
    job: input.job,
    ready,
    promise,
    persistAlias
  });
  try {
    return {
      duplicate: false,
      job: input.job,
      result: await promise
    };
  } finally {
    if (activeMarketAnalysisRuns.get(key)?.promise === promise) {
      activeMarketAnalysisRuns.delete(key);
    }
  }
}

function responseFor(
  duplicate: boolean,
  job: AgentJob,
  result: MarketAnalysisExecutionResult | null
) {
  return {
    duplicate,
    ...marketAnalysisRunMetadata(),
    job: publicAgentJob(job),
    result
  };
}

export async function createMarketAnalysisRun(input: CreateMarketAnalysisRunInput) {
  const { store, user } = input;
  const provider = getTradeProvider(input.providerId);
  if (!provider) {
    throw new MarketAnalysisRunRequestError(400, "PROVIDER_NOT_REGISTERED", "未知的市场分析数据源");
  }
  const catalog = store.providerCatalog.find((item) => item.code === provider.id);
  if (!catalog) {
    throw new MarketAnalysisRunRequestError(409, "PROVIDER_CATALOG_MISSING", "市场分析数据源目录缺失");
  }
  const query = normalizeTradeQuery(input.query);
  const fingerprint = requestFingerprint(input.campaignId, provider.id, query);
  const idempotencyScope = [
    MARKET_ANALYSIS_JOB_TYPE,
    user.id,
    input.campaignId,
    input.idempotencyKey
  ].join("|");
  const existingByIdempotency = findAgentJobByIdempotency(store, {
    teamId: user.teamId,
    jobType: MARKET_ANALYSIS_JOB_TYPE,
    idempotencyKey: idempotencyScope
  });
  if (existingByIdempotency) {
    assertJobOwner(existingByIdempotency, user);
    const storedInput = storedInputForJob(existingByIdempotency);
    if (storedInput.requestFingerprint !== fingerprint
      || storedInput.campaignId !== input.campaignId
      || storedInput.providerId !== provider.id) {
      throw new MarketAnalysisRunRequestError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "该幂等键已用于不同的市场分析请求"
      );
    }
    if (existingByIdempotency.status === "succeeded"
      || existingByIdempotency.status === "cancelled"
      || existingByIdempotency.status === "dead_letter") {
      return responseFor(
        true,
        existingByIdempotency,
        completedSummary(existingByIdempotency, storedInput.query)
      );
    }
    const executed = await executeAsActiveRun({
      store,
      user,
      job: existingByIdempotency,
      storedInput
    });
    return responseFor(true, executed.job, executed.result);
  }

  const activeKey = activeRunKey({
    teamId: user.teamId,
    ownerId: user.id,
    campaignId: input.campaignId,
    providerId: provider.id,
    requestFingerprint: fingerprint
  });
  const active = activeMarketAnalysisRuns.get(activeKey);
  if (active) {
    const ready = await active.ready;
    if (!ready) {
      await active.promise;
      throw new MarketAnalysisRunRequestError(
        409,
        "IDEMPOTENCY_STATE_CHANGED",
        "幂等状态已变化，请重新提交请求"
      );
    }
    await active.persistAlias(() =>
      attachAndPersistAlias(store, active.job, idempotencyScope)
    );
    const result = await active.promise;
    return responseFor(true, active.job, result);
  }

  const cooldownJob = findMatchingCooldownJob(store, {
    user,
    campaignId: input.campaignId,
    providerId: provider.id,
    requestFingerprint: fingerprint
  });
  if (cooldownJob) {
    await attachAndPersistAlias(store, cooldownJob, idempotencyScope);
    assertRetryDue(cooldownJob);
    throw new MarketAnalysisRunRequestError(
      409,
      "IDEMPOTENCY_STATE_CHANGED",
      "幂等状态已变化，请重新提交请求"
    );
  }

  const enqueued = enqueueAgentJob(store, {
    teamId: user.teamId,
    ownerId: user.id,
    jobType: MARKET_ANALYSIS_JOB_TYPE,
    aggregateType: MARKET_ANALYSIS_AGGREGATE_TYPE,
    aggregateId: input.campaignId,
    idempotencyKey: idempotencyScope,
    policyVersion: catalog.version,
    input: {
      campaignId: input.campaignId,
      campaignContractMode: CAMPAIGN_CONTRACT_MODE,
      campaignScope: CAMPAIGN_SCOPE,
      executionMode: EXECUTION_MODE,
      providerId: provider.id,
      requestFingerprint: fingerprint,
      query
    }
  });

  if (enqueued.duplicate) {
    throw new MarketAnalysisRunRequestError(
      409,
      "IDEMPOTENCY_STATE_CHANGED",
      "幂等状态已变化，请重新提交请求"
    );
  }
  const enqueuedIndex = store.agentJobs.findIndex((item) => item.id === enqueued.job.id);
  if (enqueuedIndex >= 0) store.agentJobs.splice(enqueuedIndex, 1);

  const storedInput: StoredMarketAnalysisInput = {
    campaignId: input.campaignId,
    providerId: provider.id,
    requestFingerprint: fingerprint,
    query
  };
  const executed = await executeAsActiveRun({
    store,
    user,
    job: enqueued.job,
    storedInput
  });
  return responseFor(executed.duplicate, executed.job, executed.result);
}

export async function retryMarketAnalysisJob(
  store: CrmStore,
  user: SessionUser,
  job: AgentJob
) {
  assertJobOwner(job, user);
  if (job.jobType !== MARKET_ANALYSIS_JOB_TYPE) {
    throw new MarketAnalysisRunRequestError(409, "JOB_TYPE_NOT_SUPPORTED", "该任务不属于市场分析");
  }
  if (job.status !== "failed" && job.status !== "dead_letter") {
    throw new MarketAnalysisRunRequestError(409, "JOB_NOT_RETRYABLE", "当前任务状态不能重试");
  }
  const storedInput = storedInputForJob(job);
  const executed = await executeAsActiveRun({
    store,
    user,
    job,
    storedInput
  });
  return responseFor(false, executed.job, executed.result);
}
