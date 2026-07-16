import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
} from "./agent-jobs.js";
import {
  validateProspectRunQueueBridge
} from "./prospect-run-queue-bridge.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
  prospectProviderAccountingEvidenceHash,
  prospectProviderAccountingEvidenceRef,
  prospectProviderDispatchConfirmationRef,
  prospectProviderRequestHash,
  prospectProviderRequestIdempotencyKey,
  prospectProviderResponseComponentHashes,
  prospectProviderResponseEvidenceRef,
  prospectProviderResponseHash,
  prospectProviderSettlementHash,
  sha256CanonicalJson
} from "./prospect-provider-request-ledger.js";
import {
  PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
  ProspectSourceRawError,
  appendProspectSourceRawBatch,
  normalizeProspectProviderSourceRecords,
  prospectProviderRawArtifactHash
} from "./prospect-source-raw.js";
import {
  prospectStrategySourcePositionIdentity,
  prospectStrategySourcePositionIdentityHash
} from "./prospect-strategy-source-position.js";
import type {
  FakeProspectProviderDispatchRequest,
  FakeProspectProviderFailure,
  FakeProspectProviderRequest,
  FakeProspectProviderResponse,
  FakeProspectProviderSuccess
} from "./prospect-fake-provider.js";
import type {
  AppendProspectSourceRawBatchResult,
  ProspectProviderRawPolicy,
  ProspectProviderSourceRecordInput
} from "./prospect-source-raw.js";
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import type {
  AgentJob,
  ProspectExecutionAttempt,
  ProspectExecutionCheckpoint,
  ProspectExecutionEvent,
  ProspectExecutionLease,
  ProspectExecutionPage,
  ProspectProviderRequestAccountingEvidence,
  ProspectProviderRequestAttemptBinding,
  ProspectProviderRequestDispatch,
  ProspectProviderRequestEvent,
  ProspectProviderRequestLedger,
  ProspectRunEvent,
  ProspectRunShard,
  ProspectSearchRun,
  ProspectStrategySourcePosition
} from "./types.js";

const KERNEL_STATE_ID = "search_execution_kernel_v1";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_DEADLINE_MS = 120_000;
const PROVIDER_REQUEST_SCHEMA_VERSION = "provider-search-request-v1";
const PROVIDER_ENDPOINT_CODE = "company-search";

export class ProspectExecutionKernelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProspectExecutionKernelError";
    this.code = code;
  }
}

export interface ProspectExecutionClaim {
  lease: ProspectExecutionLease;
  attempt: ProspectExecutionAttempt;
  claimToken: string;
  run: ProspectSearchRun;
  shard: ProspectRunShard;
  job: AgentJob;
}

export interface ProspectExecutionKernelOptions {
  store: CrmStore;
  workerId: string;
  allowedRunIds?: Iterable<string>;
  allowPersistedRuns?: boolean;
  claimSecret: string;
  cursorSecret?: string;
  providerRequestIdempotencySecret?: string;
  providerRequestEnvelopeSecret?: string;
  providerResponseEnvelopeSecret?: string;
  providerRawEnvelopeSecret?: string;
  providerRawIdentitySecret?: string;
  providerRawPolicies?: Readonly<
    Record<string, ProspectProviderRawPolicy>
  >;
  instanceId?: string;
  leaseMs?: number;
  deadlineMs?: number;
  throttleIntervalMs?: number;
}

export interface ProspectExecutionProviderDispatcher {
  dispatch(
    request: FakeProspectProviderDispatchRequest,
    providerRequest?: FakeProspectProviderRequest
  ): Promise<FakeProspectProviderResponse>;
}

export interface ProspectPreparedProviderRequest {
  ledger: ProspectProviderRequestLedger;
  dispatchRequest: FakeProspectProviderDispatchRequest;
  providerRequest: FakeProspectProviderRequest;
}

interface StartPreparedProviderDispatchReady {
  ready: true;
  ledger: ProspectProviderRequestLedger;
  dispatch: ProspectProviderRequestDispatch;
  dispatchRequest: FakeProspectProviderDispatchRequest;
  providerRequest: FakeProspectProviderRequest;
}

interface StartPreparedProviderDispatchDeferred {
  ready: false;
  retryAfterAt: string;
}

type StartPreparedProviderDispatchResult =
  | StartPreparedProviderDispatchReady
  | StartPreparedProviderDispatchDeferred;

interface DispatchPreparedProviderRequestResponseReceived {
  kind: "response_received";
  ledger: ProspectProviderRequestLedger;
  dispatch: ProspectProviderRequestDispatch;
  response: FakeProspectProviderResponse;
}

interface DispatchPreparedProviderRequestDeferred {
  kind: "throttled";
  retryAfterAt: string;
}

type DispatchPreparedProviderRequestResult =
  | DispatchPreparedProviderRequestResponseReceived
  | DispatchPreparedProviderRequestDeferred;

interface BeginRequestReady {
  ready: true;
  request: {
    runId: string;
    shardId: string;
    providerCode: string;
    checkpointNo: number;
    checkpointCallNo: number;
    cursor: string;
    requestHash: string;
  };
  attempt: ProspectExecutionAttempt;
}

interface BeginRequestDeferred {
  ready: false;
  retryAfterAt: string;
}

type BeginRequestResult = BeginRequestReady | BeginRequestDeferred;

interface CompletePageResult {
  accepted: boolean;
  lateCancellation: boolean;
  page?: ProspectExecutionPage;
  runStatus: ProspectSearchRun["status"];
  shardStatus: ProspectRunShard["status"];
}

interface FailRequestResult {
  retryScheduled: boolean;
  lateCancellation: boolean;
  retryAfterAt?: string;
  runStatus: ProspectSearchRun["status"];
  shardStatus: ProspectRunShard["status"];
}

interface SettlePersistedProviderResponseResult {
  kind: "success" | "failure" | "cancelled_late";
  idempotent: boolean;
  ledger: ProspectProviderRequestLedger;
  attempt: ProspectExecutionAttempt;
  accountingEvidence: ProspectProviderRequestAccountingEvidence;
  page?: ProspectExecutionPage;
  rawBatch?: AppendProspectSourceRawBatchResult;
  retryScheduled: boolean;
  retryAfterAt: string;
  runStatus: ProspectSearchRun["status"];
  shardStatus: ProspectRunShard["status"];
}

function plusMilliseconds(iso: string, amount: number) {
  return new Date(new Date(iso).getTime() + amount).toISOString();
}

function latestIso(...values: string[]) {
  const candidates = values.filter(Boolean);
  if (!candidates.length) {
    throw new ProspectExecutionKernelError(
      "EXECUTION_TIME_INVALID",
      "执行内核缺少可比较的时间"
    );
  }
  return new Date(Math.max(...candidates.map(validIso))).toISOString();
}

function validIso(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    throw new ProspectExecutionKernelError(
      "EXECUTION_TIME_INVALID",
      "执行内核时间格式无效"
    );
  }
  return time;
}

function safeProviderOutcomeCode(
  step: FakeProspectProviderSuccess | FakeProspectProviderFailure
) {
  if (step.kind === "success") return "SUCCESS";
  const code = step.errorCode.trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 100);
  if (!code) {
    throw new ProspectExecutionKernelError(
      "EXECUTION_PROVIDER_RESPONSE_INVALID",
      "Provider 失败响应缺少安全结果码"
    );
  }
  return code;
}

function validateProviderResponseStep(
  step: FakeProspectProviderSuccess | FakeProspectProviderFailure
) {
  if (!step || typeof step !== "object"
    || (step.kind !== "success" && step.kind !== "failure")) {
    throw new ProspectExecutionKernelError(
      "EXECUTION_PROVIDER_RESPONSE_INVALID",
      "Provider 响应结果结构无效"
    );
  }
  const usage = step.usage;
  const cost = step.cost;
  if (!usage
    || !Number.isFinite(usage.requestUnits)
    || usage.requestUnits < 0
    || !Number.isFinite(usage.resultUnits)
    || usage.resultUnits < 0
    || !cost
    || !["actual", "estimated", "unknown"].includes(cost.kind)
    || (cost.amount !== null
      && (!Number.isFinite(cost.amount) || cost.amount < 0))
    || (cost.kind === "unknown" && cost.amount !== null)
    || (cost.amount === null
      ? Boolean(cost.currency)
      : !/^[A-Z]{3}$/.test(cost.currency))) {
    throw new ProspectExecutionKernelError(
      "EXECUTION_PROVIDER_RESPONSE_INVALID",
      "Provider 响应用量或费用结构无效"
    );
  }
  if (step.kind === "success") {
    const counts = [
      step.acceptedCount,
      step.rawCount,
      step.invalidCount,
      step.duplicateCount
    ];
    if (counts.some((item) => !Number.isInteger(item) || item < 0)
      || step.acceptedCount + step.invalidCount + step.duplicateCount
        > step.rawCount
      || step.hasMore !== Boolean(step.cursor)
      || typeof step.partial !== "boolean") {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RESPONSE_INVALID",
        "Provider 成功响应计数或游标结构无效"
      );
    }
    const hasRawFields = step.responseSchemaVersion !== undefined
      || step.rawArtifactHash !== undefined
      || step.sourceRecords !== undefined;
    if (hasRawFields) {
      try {
        if (step.responseSchemaVersion
            !== PROSPECT_SOURCE_RAW_SCHEMA_VERSION
          || typeof step.rawArtifactHash !== "string"
          || !Array.isArray(step.sourceRecords)) {
          throw new Error("raw contract incomplete");
        }
        const sourceRecords = normalizeProspectProviderSourceRecords(
          step.sourceRecords,
          step.rawCount
        );
        if (!isDeepStrictEqual(sourceRecords, step.sourceRecords)
          || prospectProviderRawArtifactHash(sourceRecords)
            !== step.rawArtifactHash) {
          throw new Error("raw contract mismatch");
        }
      } catch {
        throw new ProspectExecutionKernelError(
          "EXECUTION_PROVIDER_RESPONSE_INVALID",
          "Provider 成功响应的原始记录合同或工件摘要无效"
        );
      }
    }
    return;
  }
  if (!step.errorCode.trim()
    || !step.errorMessage.trim()
    || typeof step.retryable !== "boolean"
    || (step.retryAfterAt
      && !Number.isFinite(new Date(step.retryAfterAt).getTime()))) {
    throw new ProspectExecutionKernelError(
      "EXECUTION_PROVIDER_RESPONSE_INVALID",
      "Provider 失败响应错误事实无效"
    );
  }
}

function detailHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeMessage(code: string) {
  if (code === "REQUEST_OUTCOME_UNKNOWN") {
    return "请求已发出但结果未知，为避免重复获客已停止自动重试";
  }
  return "搜索执行未完成，请查看执行审计";
}

function persistedSourcePositionIdentity(
  position: ProspectStrategySourcePosition
) {
  return {
    teamId: position.teamId,
    ownerId: position.ownerId,
    campaignId: position.campaignId,
    campaignVersion: position.campaignVersion,
    strategyId: position.strategyId,
    providerCode: position.providerCode,
    queryFingerprint: position.queryFingerprint,
    connectionId: position.connectionId,
    endpointCode: position.endpointCode,
    adapterVersion: position.adapterVersion,
    contractVersion: position.contractVersion,
    catalogVersion: position.catalogVersion,
    timeWindowMode: position.timeWindowMode,
    timeWindowFrom: position.timeWindowFrom,
    timeWindowTo: position.timeWindowTo
  };
}

function snapshot(store: CrmStore) {
  return {
    runs: structuredClone(store.prospectSearchRuns),
    shards: structuredClone(store.prospectRunShards),
    runEvents: structuredClone(store.prospectRunEvents),
    jobs: structuredClone(store.agentJobs),
    kernelStates: structuredClone(store.prospectExecutionKernelStates),
    checkpoints: structuredClone(store.prospectExecutionCheckpoints),
    sourcePositions:
      structuredClone(store.prospectStrategySourcePositions),
    leases: structuredClone(store.prospectExecutionLeases),
    attempts: structuredClone(store.prospectExecutionAttempts),
    providerRequestLedgers:
      structuredClone(store.prospectProviderRequestLedgers),
    providerRequestDispatches:
      structuredClone(store.prospectProviderRequestDispatches),
    providerRequestEvents:
      structuredClone(store.prospectProviderRequestEvents),
    providerRequestAttemptBindings:
      structuredClone(store.prospectProviderRequestAttemptBindings),
    providerRequestAccountingEvidence:
      structuredClone(store.prospectProviderRequestAccountingEvidence),
    sourceRawBatches: structuredClone(store.prospectSourceRawBatches),
    sourceRawRecords: structuredClone(store.prospectSourceRawRecords),
    sourceRawHits: structuredClone(store.prospectSourceRawHits),
    pages: structuredClone(store.prospectExecutionPages),
    events: structuredClone(store.prospectExecutionEvents),
    throttles: structuredClone(store.prospectExecutionThrottleBuckets)
  };
}

function restore(store: CrmStore, before: ReturnType<typeof snapshot>) {
  store.prospectSearchRuns.splice(
    0,
    store.prospectSearchRuns.length,
    ...before.runs
  );
  store.prospectRunShards.splice(
    0,
    store.prospectRunShards.length,
    ...before.shards
  );
  store.prospectRunEvents.splice(
    0,
    store.prospectRunEvents.length,
    ...before.runEvents
  );
  store.agentJobs.splice(0, store.agentJobs.length, ...before.jobs);
  store.prospectExecutionKernelStates.splice(
    0,
    store.prospectExecutionKernelStates.length,
    ...before.kernelStates
  );
  store.prospectExecutionCheckpoints.splice(
    0,
    store.prospectExecutionCheckpoints.length,
    ...before.checkpoints
  );
  store.prospectStrategySourcePositions.splice(
    0,
    store.prospectStrategySourcePositions.length,
    ...before.sourcePositions
  );
  store.prospectExecutionLeases.splice(
    0,
    store.prospectExecutionLeases.length,
    ...before.leases
  );
  store.prospectExecutionAttempts.splice(
    0,
    store.prospectExecutionAttempts.length,
    ...before.attempts
  );
  store.prospectProviderRequestLedgers.splice(
    0,
    store.prospectProviderRequestLedgers.length,
    ...before.providerRequestLedgers
  );
  store.prospectProviderRequestDispatches.splice(
    0,
    store.prospectProviderRequestDispatches.length,
    ...before.providerRequestDispatches
  );
  store.prospectProviderRequestEvents.splice(
    0,
    store.prospectProviderRequestEvents.length,
    ...before.providerRequestEvents
  );
  store.prospectProviderRequestAttemptBindings.splice(
    0,
    store.prospectProviderRequestAttemptBindings.length,
    ...before.providerRequestAttemptBindings
  );
  store.prospectProviderRequestAccountingEvidence.splice(
    0,
    store.prospectProviderRequestAccountingEvidence.length,
    ...before.providerRequestAccountingEvidence
  );
  store.prospectSourceRawBatches.splice(
    0,
    store.prospectSourceRawBatches.length,
    ...before.sourceRawBatches
  );
  store.prospectSourceRawRecords.splice(
    0,
    store.prospectSourceRawRecords.length,
    ...before.sourceRawRecords
  );
  store.prospectSourceRawHits.splice(
    0,
    store.prospectSourceRawHits.length,
    ...before.sourceRawHits
  );
  store.prospectExecutionPages.splice(
    0,
    store.prospectExecutionPages.length,
    ...before.pages
  );
  store.prospectExecutionEvents.splice(
    0,
    store.prospectExecutionEvents.length,
    ...before.events
  );
  store.prospectExecutionThrottleBuckets.splice(
    0,
    store.prospectExecutionThrottleBuckets.length,
    ...before.throttles
  );
}

async function persistMutation<T>(
  store: CrmStore,
  mutation: () => PersistedStoreMutation<T>
) {
  const guardedMutation = () => {
    const before = snapshot(store);
    try {
      return mutation();
    } catch (error) {
      if (!isDeepStrictEqual(snapshot(store), before)) {
        restore(store, before);
      }
      throw error;
    }
  };
  if (store.persistProspectExecutionMutation) {
    return store.persistProspectExecutionMutation(guardedMutation);
  }
  if (store.persistMutation) {
    return store.persistMutation(guardedMutation);
  }
  const applied = guardedMutation();
  try {
    await store.persist();
    return applied.value;
  } catch (error) {
    applied.rollback();
    throw error;
  }
}

function nextRunEventSequence(store: CrmStore, run: ProspectSearchRun) {
  return store.prospectRunEvents.reduce(
    (highest, event) =>
      event.teamId === run.teamId && event.runId === run.id
        ? Math.max(highest, event.sequence)
        : highest,
    0
  ) + 1;
}

function appendRunStartedEvent(
  store: CrmStore,
  run: ProspectSearchRun,
  previousStatus: ProspectSearchRun["status"],
  previousRevision: number,
  now: string
) {
  const event: ProspectRunEvent = {
    id: `pre_${randomUUID()}`,
    teamId: run.teamId,
    runId: run.id,
    sequence: nextRunEventSequence(store, run),
    eventType: "started",
    actorId: "system:search-execution-kernel",
    requestId: `kernel:${run.id}:${run.executionEpoch}`,
    fromStatus: previousStatus,
    toStatus: run.status,
    fromRevision: previousRevision,
    toRevision: run.revision,
    reason: "测试执行内核领取首个数据源分片",
    createdAt: now
  };
  store.prospectRunEvents.push(event);
}

function appendRunTransitionEvent(
  store: CrmStore,
  input: {
    run: ProspectSearchRun;
    previousStatus: ProspectSearchRun["status"];
    previousRevision: number;
    eventType: ProspectRunEvent["eventType"];
    reason: string;
    now: string;
  }
) {
  const event: ProspectRunEvent = {
    id: `pre_${randomUUID()}`,
    teamId: input.run.teamId,
    runId: input.run.id,
    sequence: nextRunEventSequence(store, input.run),
    eventType: input.eventType,
    actorId: "system:search-execution-kernel",
    requestId: `kernel:${input.run.id}:${input.run.executionEpoch}:${input.run.revision}`,
    fromStatus: input.previousStatus,
    toStatus: input.run.status,
    fromRevision: input.previousRevision,
    toRevision: input.run.revision,
    reason: input.reason,
    createdAt: input.now
  };
  store.prospectRunEvents.push(event);
}

function appendExecutionEvent(
  store: CrmStore,
  input: Omit<ProspectExecutionEvent, "id" | "detailHash"> & {
    detail: unknown;
  }
) {
  const event: ProspectExecutionEvent = {
    id: `pexe_${randomUUID()}`,
    teamId: input.teamId,
    ownerId: input.ownerId,
    runId: input.runId,
    shardId: input.shardId,
    jobId: input.jobId,
    eventType: input.eventType,
    kernelEpoch: input.kernelEpoch,
    runEpoch: input.runEpoch,
    fenceToken: input.fenceToken,
    detailHash: detailHash(input.detail),
    createdAt: input.createdAt
  };
  store.prospectExecutionEvents.push(event);
  return event;
}

export class ProspectExecutionKernel {
  private readonly store: CrmStore;
  private readonly workerId: string;
  private readonly allowedRunIds: ReadonlySet<string>;
  private readonly allowPersistedRuns: boolean;
  private readonly claimSecret: string;
  private readonly cursorKey: Buffer;
  private readonly providerRequestIdempotencySecret: string;
  private readonly providerRequestEnvelopeKey: Buffer;
  private readonly providerResponseEnvelopeKey: Buffer;
  private readonly providerRawEnvelopeSecret: string;
  private readonly providerRawIdentitySecret: string;
  private readonly providerRawPolicies:
    ReadonlyMap<string, ProspectProviderRawPolicy>;
  private readonly instanceId: string;
  private readonly leaseMs: number;
  private readonly deadlineMs: number;
  private readonly throttleIntervalMs: number;
  private kernelEpoch = 0;

  constructor(options: ProspectExecutionKernelOptions) {
    const allowedRunIds = new Set(
      [...(options.allowedRunIds || [])]
        .map((item) => item.trim())
        .filter(Boolean)
    );
    const allowPersistedRuns = options.allowPersistedRuns === true;
    if (process.env.NODE_ENV !== "test" && !allowPersistedRuns) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PERSISTED_RUN_SCOPE_REQUIRED",
        "生产执行内核必须显式启用持久化运行作用域"
      );
    }
    if (!allowPersistedRuns && !allowedRunIds.size) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_ALLOWED_RUNS_REQUIRED",
        "测试执行内核必须显式提供非空 allowedRunIds"
      );
    }
    if (Buffer.byteLength(options.claimSecret, "utf8") < 32) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_CLAIM_SECRET_WEAK",
        "测试执行内核 claimSecret 至少需要 32 字节"
      );
    }
    const cursorSecret = options.cursorSecret || options.claimSecret;
    if (Buffer.byteLength(cursorSecret, "utf8") < 32) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_CURSOR_SECRET_WEAK",
        "测试执行内核 cursorSecret 至少需要 32 字节"
      );
    }
    const providerRequestIdempotencySecret =
      options.providerRequestIdempotencySecret
      || createHmac("sha256", options.claimSecret)
        .update("goodjob-provider-request-idempotency-v1")
        .digest("hex");
    if (Buffer.byteLength(providerRequestIdempotencySecret, "utf8") < 32) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_IDEMPOTENCY_SECRET_WEAK",
        "测试执行内核 Provider 请求幂等密钥至少需要 32 字节"
      );
    }
    const providerRequestEnvelopeSecret =
      options.providerRequestEnvelopeSecret
      || createHmac("sha256", options.claimSecret)
        .update("goodjob-provider-request-envelope-v1")
        .digest("hex");
    if (Buffer.byteLength(providerRequestEnvelopeSecret, "utf8") < 32) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_ENVELOPE_SECRET_WEAK",
        "测试执行内核 Provider 请求信封密钥至少需要 32 字节"
      );
    }
    const providerResponseEnvelopeSecret =
      options.providerResponseEnvelopeSecret
      || createHmac("sha256", options.claimSecret)
        .update("goodjob-provider-response-envelope-v1")
        .digest("hex");
    if (Buffer.byteLength(providerResponseEnvelopeSecret, "utf8") < 32) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RESPONSE_ENVELOPE_SECRET_WEAK",
        "测试执行内核 Provider 响应信封密钥至少需要 32 字节"
      );
    }
    const providerRawEnvelopeSecret =
      options.providerRawEnvelopeSecret
      || createHmac("sha256", options.claimSecret)
        .update("goodjob-provider-raw-envelope-v1")
        .digest("hex");
    if (Buffer.byteLength(providerRawEnvelopeSecret, "utf8") < 32) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RAW_ENVELOPE_SECRET_WEAK",
        "测试执行内核 Provider 原始记录加密密钥至少需要 32 字节"
      );
    }
    const providerRawIdentitySecret =
      options.providerRawIdentitySecret
      || createHmac("sha256", options.claimSecret)
        .update("goodjob-provider-raw-identity-v1")
        .digest("hex");
    if (Buffer.byteLength(providerRawIdentitySecret, "utf8") < 32) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RAW_IDENTITY_SECRET_WEAK",
        "测试执行内核 Provider 原始记录身份密钥至少需要 32 字节"
      );
    }
    const providerRawPolicies = new Map<
      string,
      ProspectProviderRawPolicy
    >();
    for (const [rawProviderCode, rawPolicy] of Object.entries(
      options.providerRawPolicies || {}
    )) {
      const providerCode = rawProviderCode.trim();
      if (!providerCode
        || !rawPolicy
        || typeof rawPolicy.licensePolicy !== "string"
        || !rawPolicy.licensePolicy.trim()
        || typeof rawPolicy.retentionPolicy !== "string"
        || !rawPolicy.retentionPolicy.trim()
        || !Number.isInteger(rawPolicy.retentionDays)
        || rawPolicy.retentionDays < 1
        || rawPolicy.retentionDays > 3_650) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_PROVIDER_RAW_POLICY_INVALID",
          "测试执行内核 Provider 原始记录许可或保留策略无效"
        );
      }
      providerRawPolicies.set(providerCode, {
        licensePolicy: rawPolicy.licensePolicy.trim(),
        retentionPolicy: rawPolicy.retentionPolicy.trim(),
        retentionDays: rawPolicy.retentionDays
      });
    }
    if (!options.workerId.trim()) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_WORKER_ID_REQUIRED",
        "测试执行内核必须提供 workerId"
      );
    }
    this.store = options.store;
    this.workerId = options.workerId.trim();
    this.allowedRunIds = allowedRunIds;
    this.allowPersistedRuns = allowPersistedRuns;
    this.claimSecret = options.claimSecret;
    this.cursorKey = createHash("sha256").update(cursorSecret).digest();
    this.providerRequestIdempotencySecret =
      providerRequestIdempotencySecret;
    this.providerRequestEnvelopeKey = createHash("sha256")
      .update("goodjob-provider-request-envelope-key-v1\u001f")
      .update(providerRequestEnvelopeSecret)
      .digest();
    this.providerResponseEnvelopeKey = createHash("sha256")
      .update("goodjob-provider-response-envelope-key-v1\u001f")
      .update(providerResponseEnvelopeSecret)
      .digest();
    this.providerRawEnvelopeSecret = providerRawEnvelopeSecret;
    this.providerRawIdentitySecret = providerRawIdentitySecret;
    this.providerRawPolicies = providerRawPolicies;
    this.instanceId = options.instanceId?.trim() || `kernel_${randomUUID()}`;
    this.leaseMs = Math.max(1_000, Math.trunc(
      options.leaseMs ?? DEFAULT_LEASE_MS
    ));
    this.deadlineMs = Math.max(this.leaseMs, Math.trunc(
      options.deadlineMs ?? DEFAULT_DEADLINE_MS
    ));
    this.throttleIntervalMs = Math.max(
      0,
      Math.trunc(options.throttleIntervalMs ?? 0)
    );
  }

  private isRunAllowed(runId: string) {
    if (this.allowedRunIds.has(runId)) return true;
    if (!this.allowPersistedRuns) return false;
    const run = this.store.prospectSearchRuns.find((item) =>
      item.id === runId
    );
    if (!run || run.queueBridgeVersion !== "v1") return false;
    const binding = this.store.prospectRunQueueParentBindings.find((item) =>
      item.runId === run.id
      && item.teamId === run.teamId
      && item.ownerId === run.ownerId
      && item.bridgeVersion === "v1"
    );
    return Boolean(binding && this.store.agentJobs.some((item) =>
      item.id === binding.jobId
      && item.teamId === run.teamId
      && item.ownerId === run.ownerId
      && item.jobType === "prospect.orchestrate"
    ));
  }

  private providerConnectionId(input: {
    teamId: string;
    ownerId: string;
    providerCode: string;
  }) {
    if (!this.allowPersistedRuns) {
      return `fake:${input.providerCode}`;
    }
    return this.store.providerConnections.find((item) =>
      item.providerId === input.providerCode
      && item.teamId === input.teamId
      && item.ownerId === input.ownerId
      && item.scope === "personal"
      && item.status === "active"
    )?.id || `builtin:${input.providerCode}`;
  }

  private isRawCapableProviderSuccess(
    step: FakeProspectProviderSuccess | FakeProspectProviderFailure
  ): step is FakeProspectProviderSuccess & {
    responseSchemaVersion: typeof PROSPECT_SOURCE_RAW_SCHEMA_VERSION;
    rawArtifactHash: string;
    sourceRecords: ProspectProviderSourceRecordInput[];
  } {
    return step.kind === "success"
      && step.responseSchemaVersion === PROSPECT_SOURCE_RAW_SCHEMA_VERSION
      && typeof step.rawArtifactHash === "string"
      && Array.isArray(step.sourceRecords);
  }

  private appendSettledProviderRawFacts(input: {
    ledger: ProspectProviderRequestLedger;
    attempt: ProspectExecutionAttempt;
    page: ProspectExecutionPage;
    response: FakeProspectProviderResponse;
    requireExisting: boolean;
  }) {
    const { ledger, attempt, page, response } = input;
    if (!this.isRawCapableProviderSuccess(response.step)) {
      return undefined;
    }
    const policy = this.providerRawPolicies.get(ledger.providerCode);
    if (!policy) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RAW_POLICY_REQUIRED",
        "Provider 原始记录未配置许可与保留策略，不能完成成功结算"
      );
    }
    const existingBatches = this.store.prospectSourceRawBatches.filter(
      (item) =>
        item.ledgerId === ledger.id
        && item.teamId === ledger.teamId
        && item.ownerId === ledger.ownerId
    );
    if (input.requireExisting && existingBatches.length !== 1) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RAW_STATE_INVALID",
        "已成功结算的 Provider 响应缺少唯一原始批次"
      );
    }
    if (ledger.status !== "settled"
      || ledger.settlementKind !== "success"
      || !ledger.settlementHash
      || !ledger.settledAt
      || attempt.status !== "succeeded"
      || page.payloadHash !== ledger.responseHash
      || page.rawCount !== response.step.rawCount
      || response.step.sourceRecords.length !== response.step.rawCount) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RAW_STATE_INVALID",
        "Provider 原始记录与成功结算、执行页或响应数量不一致"
      );
    }
    try {
      return appendProspectSourceRawBatch(this.store, {
        teamId: ledger.teamId,
        ownerId: ledger.ownerId,
        runId: ledger.runId,
        shardId: ledger.shardId,
        jobId: ledger.jobId,
        attemptId: attempt.id,
        ledgerId: ledger.id,
        pageId: page.id,
        providerCode: ledger.providerCode,
        connectionId: ledger.connectionId,
        endpointCode: ledger.endpointCode,
        adapterVersion: ledger.adapterVersion,
        responseSchemaVersion: response.step.responseSchemaVersion,
        responseHash: ledger.responseHash,
        settlementHash: ledger.settlementHash,
        rawArtifactHash: response.step.rawArtifactHash,
        sourceRecords: response.step.sourceRecords,
        policy,
        envelopeSecret: this.providerRawEnvelopeSecret,
        identitySecret: this.providerRawIdentitySecret,
        createdAt: ledger.settledAt
      });
    } catch (error) {
      if (error instanceof ProspectSourceRawError) {
        throw new ProspectExecutionKernelError(
          error.code === "PROSPECT_SOURCE_RAW_CONFLICT"
            ? "EXECUTION_PROVIDER_RAW_CONFLICT"
            : "EXECUTION_PROVIDER_RAW_INVALID",
          error.message
        );
      }
      throw error;
    }
  }

  private providerRequestEnvelopeAad(
    ledger: Pick<
      ProspectProviderRequestLedger,
      "id" | "teamId" | "ownerId" | "runId" | "shardId" | "jobId"
        | "checkpointNo" | "logicalRequestNo" | "providerCode"
        | "connectionId" | "endpointCode" | "idempotencyKey" | "requestHash"
    >
  ) {
    return Buffer.from(canonicalJsonStringify({
      contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
      ledgerId: ledger.id,
      teamId: ledger.teamId,
      ownerId: ledger.ownerId,
      runId: ledger.runId,
      shardId: ledger.shardId,
      jobId: ledger.jobId,
      checkpointNo: ledger.checkpointNo,
      logicalRequestNo: ledger.logicalRequestNo,
      providerCode: ledger.providerCode,
      connectionId: ledger.connectionId,
      endpointCode: ledger.endpointCode,
      idempotencyKey: ledger.idempotencyKey,
      requestHash: ledger.requestHash
    }), "utf8");
  }

  private encryptProviderRequestEnvelope(
    ledger: Parameters<
      ProspectExecutionKernel["providerRequestEnvelopeAad"]
    >[0],
    value: unknown
  ) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.providerRequestEnvelopeKey,
      iv
    );
    cipher.setAAD(this.providerRequestEnvelopeAad(ledger));
    const encrypted = Buffer.concat([
      cipher.update(canonicalJsonStringify(value), "utf8"),
      cipher.final()
    ]);
    return [
      "provider-request-v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url")
    ].join(".");
  }

  private decryptProviderRequestEnvelope(
    ledger: ProspectProviderRequestLedger
  ) {
    const [version, ivText, tagText, payloadText] =
      ledger.encryptedRequestEnvelope.split(".");
    if (version !== "provider-request-v1"
      || !ivText
      || !tagText
      || !payloadText) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_ENVELOPE_INVALID",
        "Provider 请求信封格式无效"
      );
    }
    try {
      const iv = Buffer.from(ivText, "base64url");
      const tag = Buffer.from(tagText, "base64url");
      const payload = Buffer.from(payloadText, "base64url");
      if (iv.length !== 12
        || tag.length !== 16
        || !payload.length
        || iv.toString("base64url") !== ivText
        || tag.toString("base64url") !== tagText
        || payload.toString("base64url") !== payloadText) {
        throw new Error("invalid envelope encoding");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.providerRequestEnvelopeKey,
        iv,
        { authTagLength: 16 }
      );
      decipher.setAAD(this.providerRequestEnvelopeAad(ledger));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(payload),
        decipher.final()
      ]);
      return JSON.parse(plaintext.toString("utf8")) as {
        providerPayload: unknown;
        dispatchRequest: FakeProspectProviderDispatchRequest;
        providerRequest: FakeProspectProviderRequest;
      };
    } catch {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_ENVELOPE_INVALID",
        "Provider 请求信封完整性校验失败"
      );
    }
  }

  private providerResponseEnvelopeAad(
    ledger: Pick<
      ProspectProviderRequestLedger,
      "id" | "teamId" | "ownerId" | "runId" | "shardId" | "jobId"
        | "requestHash" | "idempotencyKey" | "externalRequestId"
        | "responseHash" | "responseEvidenceRef"
    >,
    dispatch: Pick<ProspectProviderRequestDispatch, "id" | "attemptId">
  ) {
    return Buffer.from(canonicalJsonStringify({
      contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
      envelopeVersion: "provider-response-v1",
      ledgerId: ledger.id,
      dispatchId: dispatch.id,
      attemptId: dispatch.attemptId,
      teamId: ledger.teamId,
      ownerId: ledger.ownerId,
      runId: ledger.runId,
      shardId: ledger.shardId,
      jobId: ledger.jobId,
      requestHash: ledger.requestHash,
      idempotencyKey: ledger.idempotencyKey,
      externalRequestId: ledger.externalRequestId,
      responseHash: ledger.responseHash,
      responseEvidenceRef: ledger.responseEvidenceRef
    }), "utf8");
  }

  private encryptProviderResponseEnvelope(
    ledger: Parameters<
      ProspectExecutionKernel["providerResponseEnvelopeAad"]
    >[0],
    dispatch: Parameters<
      ProspectExecutionKernel["providerResponseEnvelopeAad"]
    >[1],
    value: unknown
  ) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.providerResponseEnvelopeKey,
      iv
    );
    cipher.setAAD(this.providerResponseEnvelopeAad(ledger, dispatch));
    const encrypted = Buffer.concat([
      cipher.update(canonicalJsonStringify(value), "utf8"),
      cipher.final()
    ]);
    return [
      "provider-response-v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url")
    ].join(".");
  }

  private decryptProviderResponseEnvelope(
    ledger: ProspectProviderRequestLedger,
    dispatch: ProspectProviderRequestDispatch
  ) {
    const [version, ivText, tagText, payloadText] =
      ledger.encryptedResponseEnvelope.split(".");
    if (version !== "provider-response-v1"
      || !ivText
      || !tagText
      || !payloadText) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RESPONSE_ENVELOPE_INVALID",
        "Provider 响应信封格式无效"
      );
    }
    try {
      const iv = Buffer.from(ivText, "base64url");
      const tag = Buffer.from(tagText, "base64url");
      const payload = Buffer.from(payloadText, "base64url");
      if (iv.length !== 12
        || tag.length !== 16
        || !payload.length
        || iv.toString("base64url") !== ivText
        || tag.toString("base64url") !== tagText
        || payload.toString("base64url") !== payloadText) {
        throw new Error("invalid envelope encoding");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.providerResponseEnvelopeKey,
        iv,
        { authTagLength: 16 }
      );
      decipher.setAAD(this.providerResponseEnvelopeAad(ledger, dispatch));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(payload),
        decipher.final()
      ]);
      return JSON.parse(plaintext.toString("utf8")) as Omit<
        FakeProspectProviderResponse,
        "replayed"
      > & { providerOutcomeCode: string };
    } catch {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RESPONSE_ENVELOPE_INVALID",
        "Provider 响应信封完整性校验失败"
      );
    }
  }

  private settlePreparedProviderRequestsBeforeDispatch(
    run: ProspectSearchRun,
    now: string
  ) {
    for (const ledger of this.store.prospectProviderRequestLedgers) {
      if (ledger.teamId !== run.teamId
        || ledger.ownerId !== run.ownerId
        || ledger.runId !== run.id
        || ledger.status !== "prepared") {
        continue;
      }
      const bindings = this.store.prospectProviderRequestAttemptBindings
        .filter((item) =>
          item.teamId === ledger.teamId
          && item.ownerId === ledger.ownerId
          && item.ledgerId === ledger.id
        )
        .sort((left, right) => left.bindingNo - right.bindingNo);
      const attemptId = bindings.at(-1)?.attemptId
        || ledger.originAttemptId;
      const settlement = {
        contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
        ledgerId: ledger.id,
        requestHash: ledger.requestHash,
        settlementKind: "cancelled_before_dispatch",
        settledAt: now
      } as const;
      const previousStatus = ledger.status;
      ledger.status = "settled";
      ledger.settlementKind = "cancelled_before_dispatch";
      ledger.settlementHash = sha256CanonicalJson(settlement);
      ledger.errorCode = "CANCELLED_BY_USER";
      ledger.settledAt = now;
      ledger.updatedAt = now;
      ledger.version += 1;
      const event: ProspectProviderRequestEvent = {
        id: `ppre_${randomUUID()}`,
        ledgerId: ledger.id,
        dispatchId: "",
        attemptId,
        teamId: ledger.teamId,
        ownerId: ledger.ownerId,
        sequence: ledger.version,
        eventType: "settled",
        fromStatus: previousStatus,
        toStatus: ledger.status,
        detailHash: sha256CanonicalJson(settlement),
        createdAt: now
      };
      this.store.prospectProviderRequestEvents.push(event);
    }
  }

  private transitionProviderDispatchOutcomeUnknown(input: {
    lease: ProspectExecutionLease;
    attempt: ProspectExecutionAttempt;
    now: string;
    reason: string;
  }) {
    const dispatches = this.store.prospectProviderRequestDispatches.filter(
      (item) =>
        item.teamId === input.lease.teamId
        && item.ownerId === input.lease.ownerId
        && item.runId === input.lease.runId
        && item.shardId === input.lease.shardId
        && item.attemptId === input.attempt.id
        && (item.status === "started" || item.status === "confirmed")
    );
    if (!dispatches.length) return false;
    if (dispatches.length !== 1) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_DISPATCH_CONFLICT",
        "同一执行尝试存在多个未结算的 Provider 派发"
      );
    }
    const dispatch = dispatches[0]!;
    const ledger = this.store.prospectProviderRequestLedgers.find((item) =>
      item.id === dispatch.ledgerId
      && item.teamId === dispatch.teamId
      && item.ownerId === dispatch.ownerId
      && item.runId === dispatch.runId
      && item.shardId === dispatch.shardId
      && (item.status === "dispatch_started"
        || item.status === "dispatch_confirmed")
    );
    const binding =
      this.store.prospectProviderRequestAttemptBindings.find((item) =>
        item.teamId === dispatch.teamId
        && item.ownerId === dispatch.ownerId
        && item.ledgerId === dispatch.ledgerId
        && item.attemptId === input.attempt.id
      );
    if (!ledger || !binding
      || ledger.requestHash !== dispatch.requestHash
      || ledger.idempotencyKey !== dispatch.idempotencyKey) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_DISPATCH_SCOPE_INVALID",
        "Provider 派发记录与请求账本或执行尝试不一致"
      );
    }
    const previousStatus = ledger.status;
    const unknownReason = input.reason.slice(0, 500);
    dispatch.status = "outcome_unknown";
    dispatch.errorCode = "REQUEST_OUTCOME_UNKNOWN";
    dispatch.finishedAt = input.now;
    dispatch.version += 1;
    ledger.status = "outcome_unknown";
    ledger.unknownReason = unknownReason;
    ledger.errorCode = "REQUEST_OUTCOME_UNKNOWN";
    ledger.unknownAt = input.now;
    ledger.updatedAt = input.now;
    ledger.version += 1;
    const detail = {
      contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
      ledgerId: ledger.id,
      dispatchId: dispatch.id,
      requestHash: ledger.requestHash,
      previousStatus,
      status: ledger.status,
      reason: unknownReason
    };
    this.store.prospectProviderRequestEvents.push({
      id: `ppre_${randomUUID()}`,
      ledgerId: ledger.id,
      dispatchId: dispatch.id,
      attemptId: input.attempt.id,
      teamId: ledger.teamId,
      ownerId: ledger.ownerId,
      sequence: ledger.version,
      eventType: "outcome_unknown",
      fromStatus: previousStatus,
      toStatus: "outcome_unknown",
      detailHash: sha256CanonicalJson(detail),
      createdAt: input.now
    });
    return true;
  }

  private terminateProviderRequestAsOutcomeUnknown(input: {
    leaseId: string;
    claimToken: string;
    now: string;
    reason: string;
  }) {
    const lease = this.store.prospectExecutionLeases.find((item) =>
      item.id === input.leaseId
      && this.isRunAllowed(item.runId)
    );
    if (!lease) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_LEASE_NOT_ACTIVE",
        "执行租约不存在、已失效或不在白名单内"
      );
    }
    this.assertClaimToken(lease, input.claimToken);
    if (lease.status !== "active") {
      const attempt = this.store.prospectExecutionAttempts.find((item) =>
        item.leaseId === lease.id
        && item.teamId === lease.teamId
        && item.jobId === lease.jobId
      );
      const dispatch =
        this.store.prospectProviderRequestDispatches.find((item) =>
          item.teamId === lease.teamId
          && item.ownerId === lease.ownerId
          && item.runId === lease.runId
          && item.shardId === lease.shardId
          && item.attemptId === attempt?.id
          && item.status === "outcome_unknown"
        );
      const ledger = dispatch
        ? this.store.prospectProviderRequestLedgers.find((item) =>
            item.id === dispatch.ledgerId
            && item.teamId === dispatch.teamId
            && item.ownerId === dispatch.ownerId
            && item.status === "outcome_unknown"
          )
        : null;
      if (attempt?.status === "request_outcome_unknown"
        && dispatch
        && ledger) {
        return;
      }
      throw new ProspectExecutionKernelError(
        "EXECUTION_LEASE_NOT_ACTIVE",
        "执行租约已经失效且不存在可复用的结果未知事实"
      );
    }
    const run = this.store.prospectSearchRuns.find((item) =>
      item.id === lease.runId
      && item.teamId === lease.teamId
      && item.ownerId === lease.ownerId
    );
    const shard = this.store.prospectRunShards.find((item) =>
      item.id === lease.shardId
      && item.runId === lease.runId
      && item.teamId === lease.teamId
    );
    const job = this.store.agentJobs.find((item) =>
      item.id === lease.jobId
      && item.teamId === lease.teamId
      && item.ownerId === lease.ownerId
      && item.jobType === PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
    );
    const attempt = this.store.prospectExecutionAttempts.find((item) =>
      item.leaseId === lease.id
      && item.teamId === lease.teamId
      && item.jobId === lease.jobId
    );
    const checkpoint = this.store.prospectExecutionCheckpoints.find((item) =>
      item.teamId === lease.teamId
      && item.runId === lease.runId
      && item.shardId === lease.shardId
      && item.jobId === lease.jobId
    );
    if (!run || !shard || !job || !attempt || !checkpoint
      || attempt.status !== "request_started"
      || !lease.requestStartedAt) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_DISPATCH_SCOPE_INVALID",
        "Provider 派发中断时的运行、分片或尝试状态无效"
      );
    }
    if (!this.transitionProviderDispatchOutcomeUnknown({
      lease,
      attempt,
      now: input.now,
      reason: input.reason
    })) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_DISPATCH_MISSING",
        "Provider 派发中断时缺少持久化派发事实"
      );
    }
    const cancelled = run.status === "cancel_requested"
      && run.executionEpoch === lease.runEpoch + 1;
    lease.status = "released";
    lease.releasedAt = input.now;
    lease.releaseReason = cancelled
      ? "CANCELLED_REQUEST_OUTCOME_UNKNOWN"
      : "REQUEST_OUTCOME_UNKNOWN";
    lease.version += 1;
    attempt.status = "request_outcome_unknown";
    attempt.errorCode = "REQUEST_OUTCOME_UNKNOWN";
    attempt.errorMessage = safeMessage(attempt.errorCode);
    attempt.retryable = false;
    attempt.finishedAt = input.now;
    attempt.version += 1;
    job.status = cancelled ? "cancelled" : "failed";
    job.nextAttemptAt = "";
    job.finishedAt = input.now;
    job.errorCode = cancelled
      ? "CANCELLED_BY_USER"
      : "REQUEST_OUTCOME_UNKNOWN";
    job.errorMessage = cancelled
      ? "任务已由用户取消"
      : safeMessage(job.errorCode);
    shard.status = cancelled
      ? "cancelled"
      : checkpoint.acceptedCount > 0
        ? "partial_success"
        : "failed";
    shard.updatedAt = input.now;
    appendExecutionEvent(this.store, {
      teamId: lease.teamId,
      ownerId: lease.ownerId,
      runId: lease.runId,
      shardId: lease.shardId,
      jobId: lease.jobId,
      eventType: "lease_recovered",
      kernelEpoch: this.kernelEpoch,
      runEpoch: run.executionEpoch,
      fenceToken: lease.fenceToken,
      detail: {
        reason: lease.releaseReason,
        source: "provider_dispatch_exception"
      },
      createdAt: input.now
    });
    this.finishRunIfTerminal(run, input.now);
    this.settlePauseIfReady(run, input.now);
  }

  private claimTokenHmac(
    lease: Pick<
      ProspectExecutionLease,
      "id" | "teamId" | "runId" | "jobId" | "kernelEpoch"
        | "runEpoch" | "fenceToken"
    >,
    claimToken: string
  ) {
    return createHmac("sha256", this.claimSecret)
      .update([
        lease.id,
        lease.teamId,
        lease.runId,
        lease.jobId,
        lease.kernelEpoch,
        lease.runEpoch,
        lease.fenceToken,
        claimToken
      ].join("\u001f"))
      .digest("hex");
  }

  private assertClaimToken(
    lease: ProspectExecutionLease,
    claimToken: string
  ) {
    const expected = Buffer.from(lease.claimTokenHmac, "hex");
    const actual = Buffer.from(
      this.claimTokenHmac(lease, claimToken),
      "hex"
    );
    if (expected.length !== actual.length
      || !timingSafeEqual(expected, actual)) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_CLAIM_TOKEN_INVALID",
        "执行租约令牌无效"
      );
    }
  }

  private cursorAad(input: {
    teamId: string;
    runId: string;
    shardId: string;
    providerCode: string;
    runEpoch: number;
    checkpointNo: number;
  }) {
    return Buffer.from([
      input.teamId,
      input.runId,
      input.shardId,
      input.providerCode,
      input.runEpoch,
      input.checkpointNo
    ].join("\u001f"), "utf8");
  }

  private encryptCursor(
    cursor: string,
    input: Parameters<ProspectExecutionKernel["cursorAad"]>[0]
  ) {
    if (!cursor) return { encrypted: "", hash: "" };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.cursorKey, iv);
    cipher.setAAD(this.cursorAad(input));
    const ciphertext = Buffer.concat([
      cipher.update(cursor, "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return {
      encrypted: [
        "v1",
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url")
      ].join("."),
      hash: createHash("sha256").update(cursor).digest("hex")
    };
  }

  private decryptCursor(
    encrypted: string,
    expectedHash: string,
    input: Parameters<ProspectExecutionKernel["cursorAad"]>[0]
  ) {
    if (!encrypted) {
      if (expectedHash) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_CURSOR_INVALID",
          "执行游标密文与摘要状态不一致"
        );
      }
      return "";
    }
    const parts = encrypted.split(".");
    if (parts.length !== 4) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_CURSOR_INVALID",
        "执行游标密文格式无效"
      );
    }
    const [version, ivText, tagText, ciphertextText] = parts;
    if (version !== "v1"
      || !ivText
      || !tagText
      || !ciphertextText
      || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_CURSOR_INVALID",
        "执行游标密文或摘要格式无效"
      );
    }
    try {
      const decodeSegment = (text: string) => {
        if (!/^[A-Za-z0-9_-]+$/.test(text)) {
          throw new Error("invalid base64url");
        }
        const decoded = Buffer.from(text, "base64url");
        if (decoded.toString("base64url") !== text) {
          throw new Error("non-canonical base64url");
        }
        return decoded;
      };
      const iv = decodeSegment(ivText);
      const tag = decodeSegment(tagText);
      const ciphertext = decodeSegment(ciphertextText);
      if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
        throw new Error("invalid aes-gcm component length");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.cursorKey,
        iv,
        { authTagLength: 16 }
      );
      decipher.setAAD(this.cursorAad(input));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);
      const cursor = plaintext.toString("utf8");
      if (!cursor || !Buffer.from(cursor, "utf8").equals(plaintext)) {
        throw new Error("invalid cursor plaintext");
      }
      const actualHash = createHash("sha256").update(plaintext).digest();
      const persistedHash = Buffer.from(expectedHash, "hex");
      if (persistedHash.length !== actualHash.length
        || !timingSafeEqual(persistedHash, actualHash)) {
        throw new Error("cursor hash mismatch");
      }
      return cursor;
    } catch {
      throw new ProspectExecutionKernelError(
        "EXECUTION_CURSOR_INVALID",
        "执行游标完整性校验失败"
      );
    }
  }

  private sourcePositionAad(position: Pick<
    ProspectStrategySourcePosition,
    "id" | "identityHash" | "teamId" | "ownerId" | "providerCode"
  >) {
    return Buffer.from([
      "goodjob-prospect-strategy-source-position-cursor-v1",
      position.id,
      position.identityHash,
      position.teamId,
      position.ownerId,
      position.providerCode
    ].join("\u001f"), "utf8");
  }

  private encryptSourcePositionCursor(
    cursor: string,
    position: Parameters<
      ProspectExecutionKernel["sourcePositionAad"]
    >[0]
  ) {
    if (!cursor) return { encrypted: "", hash: "" };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.cursorKey, iv);
    cipher.setAAD(this.sourcePositionAad(position));
    const ciphertext = Buffer.concat([
      cipher.update(cursor, "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return {
      encrypted: [
        "v1",
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url")
      ].join("."),
      hash: createHash("sha256").update(cursor).digest("hex")
    };
  }

  private decryptSourcePositionCursor(
    position: ProspectStrategySourcePosition
  ) {
    if (position.status !== "continuable"
      || !position.encryptedCursor
      || !/^[a-f0-9]{64}$/.test(position.cursorHash)) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_SOURCE_POSITION_INVALID",
        "获客数据源续搜位置状态无效，已停止自动从头搜索"
      );
    }
    const parts = position.encryptedCursor.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") {
      throw new ProspectExecutionKernelError(
        "EXECUTION_SOURCE_POSITION_INVALID",
        "获客数据源续搜位置密文格式无效，已停止自动从头搜索"
      );
    }
    try {
      const decodeSegment = (text: string) => {
        if (!/^[A-Za-z0-9_-]+$/.test(text)) {
          throw new Error("invalid base64url");
        }
        const decoded = Buffer.from(text, "base64url");
        if (decoded.toString("base64url") !== text) {
          throw new Error("non-canonical base64url");
        }
        return decoded;
      };
      const iv = decodeSegment(parts[1] || "");
      const tag = decodeSegment(parts[2] || "");
      const ciphertext = decodeSegment(parts[3] || "");
      if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
        throw new Error("invalid aes-gcm component length");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.cursorKey,
        iv,
        { authTagLength: 16 }
      );
      decipher.setAAD(this.sourcePositionAad(position));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);
      const cursor = plaintext.toString("utf8");
      const actualHash = createHash("sha256").update(plaintext).digest();
      const expectedHash = Buffer.from(position.cursorHash, "hex");
      if (!cursor
        || !Buffer.from(cursor, "utf8").equals(plaintext)
        || expectedHash.length !== actualHash.length
        || !timingSafeEqual(expectedHash, actualHash)) {
        throw new Error("source position cursor integrity mismatch");
      }
      return cursor;
    } catch {
      throw new ProspectExecutionKernelError(
        "EXECUTION_SOURCE_POSITION_INVALID",
        "获客数据源续搜位置完整性校验失败，已停止自动从头搜索"
      );
    }
  }

  private sourcePositionScope(input: {
    run: ProspectSearchRun;
    shard: ProspectRunShard;
    connectionId: string;
  }) {
    const identity = prospectStrategySourcePositionIdentity({
      ...input,
      endpointCode: PROVIDER_ENDPOINT_CODE
    });
    const identityHash =
      prospectStrategySourcePositionIdentityHash(identity);
    const matches = this.store.prospectStrategySourcePositions.filter(
      (item) =>
        item.teamId === identity.teamId
        && item.ownerId === identity.ownerId
        && item.identityHash === identityHash
    );
    if (matches.length > 1) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_SOURCE_POSITION_CONFLICT",
        "获客数据源续搜位置存在重复作用域"
      );
    }
    const position = matches[0];
    if (position
      && !isDeepStrictEqual(
        persistedSourcePositionIdentity(position),
        identity
      )) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_SOURCE_POSITION_CONFLICT",
        "获客数据源续搜位置身份摘要发生冲突"
      );
    }
    return { identity, identityHash, position };
  }

  private createCheckpoint(input: {
    run: ProspectSearchRun;
    shard: ProspectRunShard;
    job: AgentJob;
    now: string;
    cursor?: string;
    completionReason?: string;
  }): ProspectExecutionCheckpoint {
    const checkpointNo = 1;
    const encryptedCursor = this.encryptCursor(input.cursor || "", {
      teamId: input.run.teamId,
      runId: input.run.id,
      shardId: input.shard.id,
      providerCode: input.shard.providerCode,
      runEpoch: input.run.executionEpoch,
      checkpointNo
    });
    const checkpoint: ProspectExecutionCheckpoint = {
      id: `pexcp_${randomUUID()}`,
      teamId: input.run.teamId,
      ownerId: input.run.ownerId,
      runId: input.run.id,
      shardId: input.shard.id,
      jobId: input.job.id,
      providerCode: input.shard.providerCode,
      runEpoch: input.run.executionEpoch,
      checkpointNo,
      encryptedCursor: encryptedCursor.encrypted,
      cursorHash: encryptedCursor.hash,
      pageSequence: 0,
      totalCallCount: 0,
      checkpointCallCount: 0,
      acceptedCount: 0,
      rawCount: 0,
      invalidCount: 0,
      duplicateCount: 0,
      retryAfterAt: "",
      lastErrorCode: "",
      lastErrorMessage: "",
      partial: false,
      completionReason: input.completionReason || "",
      version: 1,
      createdAt: input.now,
      updatedAt: input.now
    };
    this.store.prospectExecutionCheckpoints.push(checkpoint);
    return checkpoint;
  }

  private upsertSourcePosition(input: {
    run: ProspectSearchRun;
    shard: ProspectRunShard;
    page: ProspectExecutionPage;
    connectionId: string;
    cursor: string;
    hasMore: boolean;
    now: string;
    onlyIfMissing?: boolean;
  }) {
    const scope = this.sourcePositionScope(input);
    if (input.onlyIfMissing && scope.position) return scope.position;
    if (scope.position?.sourcePageId === input.page.id) {
      return scope.position;
    }
    const status = input.hasMore ? "continuable" : "exhausted";
    if (input.hasMore && !input.cursor) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_SOURCE_POSITION_INVALID",
        "Provider 声明仍有后续数据但未返回续搜位置"
      );
    }
    const position: ProspectStrategySourcePosition = scope.position || {
      id: `pssp_${randomUUID()}`,
      identityHash: scope.identityHash,
      ...scope.identity,
      status,
      encryptedCursor: "",
      cursorHash: "",
      sourceRunId: input.run.id,
      sourceShardId: input.shard.id,
      sourcePageId: input.page.id,
      sourceCheckpointNo: input.page.checkpointNo,
      sourcePageSequence: input.page.pageSequence,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now
    };
    const encryptedCursor = this.encryptSourcePositionCursor(
      input.hasMore ? input.cursor : "",
      position
    );
    position.status = status;
    position.encryptedCursor = encryptedCursor.encrypted;
    position.cursorHash = encryptedCursor.hash;
    position.sourceRunId = input.run.id;
    position.sourceShardId = input.shard.id;
    position.sourcePageId = input.page.id;
    position.sourceCheckpointNo = input.page.checkpointNo;
    position.sourcePageSequence = input.page.pageSequence;
    position.updatedAt = input.now;
    if (scope.position) {
      position.version += 1;
    } else {
      this.store.prospectStrategySourcePositions.push(position);
    }
    return position;
  }

  private activeLease(input: {
    leaseId: string;
    claimToken: string;
    now: string;
    allowCancelledEpoch?: boolean;
  }) {
    const lease = this.store.prospectExecutionLeases.find((item) =>
      item.id === input.leaseId
    );
    if (!lease
      || lease.status !== "active"
      || !this.isRunAllowed(lease.runId)) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_LEASE_NOT_ACTIVE",
        "执行租约不存在、已失效或不在白名单内"
      );
    }
    this.assertClaimToken(lease, input.claimToken);
    const run = this.store.prospectSearchRuns.find((item) =>
      item.id === lease.runId
      && item.teamId === lease.teamId
      && item.ownerId === lease.ownerId
    );
    const shard = this.store.prospectRunShards.find((item) =>
      item.id === lease.shardId
      && item.runId === lease.runId
      && item.teamId === lease.teamId
    );
    const job = this.store.agentJobs.find((item) =>
      item.id === lease.jobId
      && item.teamId === lease.teamId
      && item.ownerId === lease.ownerId
      && item.jobType === PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
    );
    const attempt = this.store.prospectExecutionAttempts.find((item) =>
      item.leaseId === lease.id
      && item.teamId === lease.teamId
      && item.jobId === lease.jobId
    );
    const checkpoint = this.store.prospectExecutionCheckpoints.find((item) =>
      item.teamId === lease.teamId
      && item.runId === lease.runId
      && item.shardId === lease.shardId
      && item.jobId === lease.jobId
    );
    if (!run || !shard || !job || !attempt || !checkpoint) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_LEASE_SCOPE_INVALID",
        "执行租约引用了不存在或跨团队的执行事实"
      );
    }
    const cancelledEpoch = input.allowCancelledEpoch
      && run.status === "cancel_requested"
      && run.executionEpoch === lease.runEpoch + 1;
    if (lease.kernelEpoch !== this.kernelEpoch
      || (!cancelledEpoch && lease.runEpoch !== run.executionEpoch)
      || validIso(lease.expiresAt) <= validIso(input.now)
      || validIso(lease.deadlineAt) <= validIso(input.now)) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_LEASE_FENCE_INVALID",
        "执行租约 epoch、fence 或有效期校验失败"
      );
    }
    return { lease, run, shard, job, attempt, checkpoint, cancelledEpoch };
  }

  private assertStarted() {
    if (this.kernelEpoch < 1) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_KERNEL_NOT_STARTED",
        "执行内核尚未启动"
      );
    }
  }

  private verifyAllowedRunsExist() {
    for (const runId of this.allowedRunIds) {
      if (!this.store.prospectSearchRuns.some((item) => item.id === runId)) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_ALLOWED_RUN_NOT_FOUND",
          `allowedRunIds 包含不存在的搜索运行：${runId}`
        );
      }
    }
  }

  private parentJob(run: ProspectSearchRun) {
    const binding = this.store.prospectRunQueueParentBindings.find((item) =>
      item.teamId === run.teamId && item.runId === run.id
    );
    const job = binding
      ? this.store.agentJobs.find((item) =>
          item.id === binding.jobId
          && item.teamId === binding.teamId
          && item.ownerId === binding.ownerId
        )
      : null;
    if (!binding || !job) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PARENT_JOB_MISSING",
        "搜索运行缺少父聚合任务"
      );
    }
    return job;
  }

  private childJob(run: ProspectSearchRun, shard: ProspectRunShard) {
    const binding = this.store.prospectRunQueueChildBindings.find((item) =>
      item.teamId === run.teamId
      && item.runId === run.id
      && item.shardId === shard.id
    );
    const job = binding
      ? this.store.agentJobs.find((item) =>
          item.id === binding.jobId
          && item.teamId === binding.teamId
          && item.ownerId === binding.ownerId
          && item.jobType === PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
        )
      : null;
    if (!binding || !job) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_CHILD_JOB_MISSING",
        "搜索运行分片缺少子执行任务"
      );
    }
    return job;
  }

  private releaseLease(
    lease: ProspectExecutionLease,
    now: string,
    reason: string
  ) {
    lease.status = "released";
    lease.releasedAt = now;
    lease.releaseReason = reason;
    lease.version += 1;
  }

  private settlePauseIfReady(run: ProspectSearchRun, now: string) {
    if (run.status !== "pause_requested"
      || this.store.prospectExecutionLeases.some((item) =>
        item.teamId === run.teamId
        && item.runId === run.id
        && item.status === "active"
      )) {
      return false;
    }
    const shards = this.store.prospectRunShards.filter((item) =>
      item.teamId === run.teamId && item.runId === run.id
    );
    const allowed = new Set<ProspectRunShard["status"]>([
      "paused",
      "succeeded",
      "succeeded_empty",
      "partial_success",
      "failed"
    ]);
    if (!shards.some((item) => item.status === "paused")
      || shards.some((item) => !allowed.has(item.status))) {
      return false;
    }
    const previousStatus = run.status;
    const previousRevision = run.revision;
    run.status = "paused";
    run.revision += 1;
    run.pausedAt = now;
    run.updatedAt = now;
    appendRunTransitionEvent(this.store, {
      run,
      previousStatus,
      previousRevision,
      eventType: "paused",
      reason: "当前在途页已结算，搜索运行进入暂停状态",
      now
    });
    appendExecutionEvent(this.store, {
      teamId: run.teamId,
      ownerId: run.ownerId,
      runId: run.id,
      shardId: "",
      jobId: this.parentJob(run).id,
      eventType: "pause_settled",
      kernelEpoch: this.kernelEpoch,
      runEpoch: run.executionEpoch,
      fenceToken: 0,
      detail: { status: run.status },
      createdAt: now
    });
    return true;
  }

  private finishRunIfTerminal(run: ProspectSearchRun, now: string) {
    const shards = this.store.prospectRunShards.filter((item) =>
      item.teamId === run.teamId && item.runId === run.id
    );
    const terminalStatuses = new Set<ProspectRunShard["status"]>([
      "cancelled",
      "succeeded",
      "succeeded_empty",
      "partial_success",
      "failed"
    ]);
    if (!shards.length
      || shards.some((item) => !terminalStatuses.has(item.status))) {
      return false;
    }
    const previousStatus = run.status;
    const previousRevision = run.revision;
    if (run.status === "cancel_requested"
      || shards.every((item) => item.status === "cancelled")) {
      for (const shard of shards) shard.status = "cancelled";
      run.status = "cancelled";
      run.cancelledAt = now;
    } else {
      const failedCount = shards.filter((item) =>
        item.status === "failed"
      ).length;
      const partialCount = shards.filter((item) =>
        item.status === "partial_success"
      ).length;
      const completedCount = shards.filter((item) =>
        item.status === "succeeded"
        || item.status === "succeeded_empty"
        || item.status === "partial_success"
      ).length;
      const acceptedCount = this.store.prospectExecutionCheckpoints
        .filter((item) =>
          item.teamId === run.teamId && item.runId === run.id
        )
        .reduce((sum, item) => sum + item.acceptedCount, 0);
      if (failedCount === shards.length) {
        run.status = "failed";
      } else if (failedCount > 0 || partialCount > 0) {
        run.status = "partial_success";
      } else if (completedCount === shards.length && acceptedCount > 0) {
        run.status = "succeeded";
      } else {
        run.status = "succeeded_empty";
      }
    }
    run.revision += 1;
    run.updatedAt = now;
    const parent = this.parentJob(run);
    parent.finishedAt = now;
    parent.nextAttemptAt = "";
    if (run.status === "cancelled") {
      parent.status = "cancelled";
      parent.errorCode = "CANCELLED_BY_USER";
      parent.errorMessage = "任务已由用户取消";
    } else if (run.status === "failed") {
      parent.status = "failed";
      parent.errorCode = "ALL_SOURCES_FAILED";
      parent.errorMessage = "所有数据源均执行失败";
    } else {
      parent.status = "succeeded";
      parent.errorCode = "";
      parent.errorMessage = "";
    }
    appendRunTransitionEvent(this.store, {
      run,
      previousStatus,
      previousRevision,
      eventType: run.status === "failed"
        ? "failed"
        : run.status === "cancelled"
          ? "cancelled"
          : "completed",
      reason: run.status === "cancelled"
        ? "搜索运行已取消"
        : run.status === "failed"
          ? "搜索运行的全部数据源均失败"
          : "搜索运行执行完成",
      now
    });
    appendExecutionEvent(this.store, {
      teamId: run.teamId,
      ownerId: run.ownerId,
      runId: run.id,
      shardId: "",
      jobId: parent.id,
      eventType: "run_completed",
      kernelEpoch: this.kernelEpoch,
      runEpoch: run.executionEpoch,
      fenceToken: 0,
      detail: { status: run.status },
      createdAt: now
    });
    return true;
  }

  private finishShard(
    input: {
      run: ProspectSearchRun;
      shard: ProspectRunShard;
      job: AgentJob;
      lease: ProspectExecutionLease;
      checkpointAcceptedCount: number;
      now: string;
      status: "succeeded" | "succeeded_empty" | "partial_success" | "failed";
      errorCode?: string;
      errorMessage?: string;
    }
  ) {
    input.shard.status = input.status;
    input.shard.updatedAt = input.now;
    input.job.status = input.status === "failed"
      ? (input.job.attemptCount >= input.job.maxAttempts
          ? "dead_letter"
          : "failed")
      : "succeeded";
    input.job.nextAttemptAt = "";
    input.job.finishedAt = input.now;
    input.job.errorCode = input.errorCode || "";
    input.job.errorMessage = input.errorMessage || "";
    this.releaseLease(input.lease, input.now, input.status);
    appendExecutionEvent(this.store, {
      teamId: input.run.teamId,
      ownerId: input.run.ownerId,
      runId: input.run.id,
      shardId: input.shard.id,
      jobId: input.job.id,
      eventType: "shard_completed",
      kernelEpoch: this.kernelEpoch,
      runEpoch: input.run.executionEpoch,
      fenceToken: input.lease.fenceToken,
      detail: {
        status: input.status,
        acceptedCount: input.checkpointAcceptedCount,
        errorCode: input.errorCode || ""
      },
      createdAt: input.now
    });
    this.finishRunIfTerminal(input.run, input.now);
  }

  private finishShardAfterPersistedResponse(
    input: {
      run: ProspectSearchRun;
      shard: ProspectRunShard;
      job: AgentJob;
      checkpointAcceptedCount: number;
      fenceToken: number;
      now: string;
      status: "succeeded" | "succeeded_empty" | "partial_success" | "failed";
      errorCode?: string;
      errorMessage?: string;
    }
  ) {
    input.shard.status = input.status;
    input.shard.updatedAt = input.now;
    input.job.status = input.status === "failed"
      ? (input.job.attemptCount >= input.job.maxAttempts
          ? "dead_letter"
          : "failed")
      : "succeeded";
    input.job.nextAttemptAt = "";
    input.job.finishedAt = input.now;
    input.job.errorCode = input.errorCode || "";
    input.job.errorMessage = input.errorMessage || "";
    appendExecutionEvent(this.store, {
      teamId: input.run.teamId,
      ownerId: input.run.ownerId,
      runId: input.run.id,
      shardId: input.shard.id,
      jobId: input.job.id,
      eventType: "shard_completed",
      kernelEpoch: this.kernelEpoch,
      runEpoch: input.run.executionEpoch,
      fenceToken: input.fenceToken,
      detail: {
        status: input.status,
        acceptedCount: input.checkpointAcceptedCount,
        errorCode: input.errorCode || ""
      },
      createdAt: input.now
    });
    this.finishRunIfTerminal(input.run, input.now);
  }

  private fallbackRetryAt(input: {
    runId: string;
    shardId: string;
    checkpointNo: number;
    checkpointCallNo: number;
    now: string;
  }) {
    const exponential = Math.min(
      60_000,
      1_000 * (2 ** Math.max(0, input.checkpointCallNo - 1))
    );
    const jitterHex = createHash("sha256").update([
      input.runId,
      input.shardId,
      input.checkpointNo,
      input.checkpointCallNo
    ].join("\u001f")).digest("hex").slice(0, 4);
    const jitter = Number.parseInt(jitterHex, 16) % 251;
    return plusMilliseconds(input.now, exponential + jitter);
  }

  async start(now = new Date().toISOString()) {
    validIso(now);
    this.verifyAllowedRunsExist();
    return persistMutation(this.store, () => {
      const before = snapshot(this.store);
      const previousEpoch = this.store.prospectExecutionKernelStates.reduce(
        (highest, state) => Math.max(highest, state.kernelEpoch),
        0
      );
      this.kernelEpoch = previousEpoch + 1;
      const state = {
        id: KERNEL_STATE_ID,
        kernelEpoch: this.kernelEpoch,
        instanceId: this.instanceId,
        startedAt: now,
        updatedAt: now
      } as const;
      this.store.prospectExecutionKernelStates.splice(
        0,
        this.store.prospectExecutionKernelStates.length,
        state
      );
      this.recoverLeasesInMutation(now, true);
      return {
        value: structuredClone(state),
        rollback: () => restore(this.store, before)
      };
    });
  }

  private recoverLeasesInMutation(now: string, previousKernelOnly: boolean) {
    const nowTime = validIso(now);
    let recovered = 0;
    for (const lease of this.store.prospectExecutionLeases) {
      if (lease.status !== "active"
        || !this.isRunAllowed(lease.runId)
        || (previousKernelOnly && lease.kernelEpoch === this.kernelEpoch)
        || (!previousKernelOnly && validIso(lease.expiresAt) > nowTime)) {
        continue;
      }
      const run = this.store.prospectSearchRuns.find((item) =>
        item.id === lease.runId
        && item.teamId === lease.teamId
        && item.ownerId === lease.ownerId
      );
      const shard = this.store.prospectRunShards.find((item) =>
        item.id === lease.shardId
        && item.runId === lease.runId
        && item.teamId === lease.teamId
      );
      const job = this.store.agentJobs.find((item) =>
        item.id === lease.jobId
        && item.teamId === lease.teamId
        && item.ownerId === lease.ownerId
        && item.jobType === PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
      );
      if (!run || !shard || !job) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_LEASE_SCOPE_INVALID",
          "执行租约引用了不存在或跨团队的运行、分片或任务"
        );
      }
      const attempt = this.store.prospectExecutionAttempts.find((item) =>
        item.leaseId === lease.id
        && item.teamId === lease.teamId
        && item.jobId === lease.jobId
      );
      if (!attempt) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_ATTEMPT_MISSING",
          "执行租约缺少对应尝试事实"
        );
      }
      if (lease.requestStartedAt) {
        const responseDispatch =
          this.store.prospectProviderRequestDispatches.find((item) =>
            item.teamId === lease.teamId
            && item.ownerId === lease.ownerId
            && item.runId === lease.runId
            && item.shardId === lease.shardId
            && item.attemptId === attempt.id
            && item.status === "response_received"
          );
        const responseLedger = responseDispatch
          ? this.store.prospectProviderRequestLedgers.find((item) =>
              item.id === responseDispatch.ledgerId
              && item.teamId === responseDispatch.teamId
              && item.ownerId === responseDispatch.ownerId
              && item.runId === responseDispatch.runId
              && item.shardId === responseDispatch.shardId
              && item.status === "response_received"
              && item.responseHash === responseDispatch.responseHash
              && item.externalRequestId
                === responseDispatch.externalRequestId
            )
          : null;
        if (responseDispatch && responseLedger) {
          lease.status = "expired";
          lease.releasedAt = now;
          lease.releaseReason =
            "RESPONSE_RECEIVED_PENDING_SETTLEMENT";
          lease.version += 1;
          appendExecutionEvent(this.store, {
            teamId: lease.teamId,
            ownerId: lease.ownerId,
            runId: lease.runId,
            shardId: lease.shardId,
            jobId: lease.jobId,
            eventType: "lease_recovered",
            kernelEpoch: this.kernelEpoch,
            runEpoch: run.executionEpoch,
            fenceToken: lease.fenceToken,
            detail: { reason: lease.releaseReason },
            createdAt: now
          });
          recovered += 1;
          continue;
        }
        this.transitionProviderDispatchOutcomeUnknown({
          lease,
          attempt,
          now,
          reason: run.status === "cancel_requested"
            ? "cancelled_with_provider_request_in_flight"
            : previousKernelOnly
              ? "kernel_restart_before_response_settlement"
              : "lease_expired_before_response_settlement"
        });
      }
      lease.status = "expired";
      lease.releasedAt = now;
      lease.version += 1;
      if (run.status === "cancel_requested"
        && run.executionEpoch === lease.runEpoch + 1) {
        lease.releaseReason = lease.requestStartedAt
          ? "CANCELLED_REQUEST_OUTCOME_UNKNOWN"
          : "CANCELLED_BEFORE_REQUEST";
        attempt.status = lease.requestStartedAt
          ? "request_outcome_unknown"
          : "failed";
        attempt.errorCode = lease.releaseReason;
        attempt.errorMessage = "取消恢复已生效，未接受任何迟到业务数据";
        attempt.retryable = false;
        attempt.finishedAt = now;
        attempt.version += 1;
        job.status = "cancelled";
        job.nextAttemptAt = "";
        job.finishedAt = now;
        job.errorCode = "CANCELLED_BY_USER";
        job.errorMessage = "任务已由用户取消";
        shard.status = "cancelled";
        shard.updatedAt = now;
        appendExecutionEvent(this.store, {
          teamId: lease.teamId,
          ownerId: lease.ownerId,
          runId: lease.runId,
          shardId: lease.shardId,
          jobId: lease.jobId,
          eventType: "lease_recovered",
          kernelEpoch: this.kernelEpoch,
          runEpoch: run.executionEpoch,
          fenceToken: lease.fenceToken,
          detail: { reason: lease.releaseReason },
          createdAt: now
        });
        this.finishRunIfTerminal(run, now);
        recovered += 1;
        continue;
      }
      if (!lease.requestStartedAt) {
        lease.releaseReason = "LEASE_RECOVERED_BEFORE_REQUEST";
        job.status = "queued";
        job.startedAt = "";
        job.finishedAt = "";
        job.nextAttemptAt = "";
        job.errorCode = "";
        job.errorMessage = "";
        shard.status = run.status === "pause_requested"
          ? "paused"
          : "queued";
        shard.updatedAt = now;
        attempt.status = "failed";
        attempt.errorCode = "LEASE_RECOVERED_BEFORE_REQUEST";
        attempt.errorMessage = "请求尚未发出，租约已安全回收";
        attempt.retryable = true;
        attempt.finishedAt = now;
        attempt.version += 1;
      } else {
        lease.releaseReason = "REQUEST_OUTCOME_UNKNOWN";
        job.status = "failed";
        job.nextAttemptAt = "";
        job.finishedAt = now;
        job.errorCode = "REQUEST_OUTCOME_UNKNOWN";
        job.errorMessage = safeMessage(job.errorCode);
        attempt.status = "request_outcome_unknown";
        attempt.errorCode = job.errorCode;
        attempt.errorMessage = job.errorMessage;
        attempt.retryable = false;
        attempt.finishedAt = now;
        attempt.version += 1;
        const checkpoint = this.store.prospectExecutionCheckpoints.find(
          (item) =>
            item.teamId === lease.teamId
            && item.runId === lease.runId
            && item.shardId === lease.shardId
        );
        shard.status = (checkpoint?.acceptedCount || 0) > 0
          ? "partial_success"
          : "failed";
        shard.updatedAt = now;
      }
      appendExecutionEvent(this.store, {
        teamId: lease.teamId,
        ownerId: lease.ownerId,
        runId: lease.runId,
        shardId: lease.shardId,
        jobId: lease.jobId,
        eventType: "lease_recovered",
        kernelEpoch: this.kernelEpoch,
        runEpoch: run.executionEpoch,
        fenceToken: lease.fenceToken,
        detail: { reason: lease.releaseReason },
        createdAt: now
      });
      if (lease.requestStartedAt) {
        this.finishRunIfTerminal(run, now);
      }
      this.settlePauseIfReady(run, now);
      recovered += 1;
    }
    return recovered;
  }

  async recoverExpiredLeases(now = new Date().toISOString()) {
    this.assertStarted();
    return persistMutation(this.store, () => {
      const before = snapshot(this.store);
      const recovered = this.recoverLeasesInMutation(now, false);
      return {
        value: recovered,
        rollback: () => restore(this.store, before)
      };
    });
  }

  async claimNext(now = new Date().toISOString()) {
    this.assertStarted();
    validIso(now);
    return persistMutation(this.store, () => {
      const before = snapshot(this.store);
      const candidates = this.store.prospectRunQueueChildBindings
        .map((binding) => {
          const run = this.store.prospectSearchRuns.find((item) =>
            item.id === binding.runId
            && item.teamId === binding.teamId
            && item.ownerId === binding.ownerId
          );
          const shard = this.store.prospectRunShards.find((item) =>
            item.id === binding.shardId
            && item.runId === binding.runId
            && item.teamId === binding.teamId
          );
          const job = this.store.agentJobs.find((item) =>
            item.id === binding.jobId
            && item.teamId === binding.teamId
            && item.ownerId === binding.ownerId
            && item.jobType === PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
          );
          return run && shard && job ? { binding, run, shard, job } : null;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .filter(({ run, shard, job }) =>
          this.isRunAllowed(run.id)
          && (run.status === "queued" || run.status === "running")
          && (shard.status === "queued"
            || shard.status === "retry_scheduled")
          && (job.status === "queued" || job.status === "retry_scheduled")
          && (!job.nextAttemptAt
            || validIso(job.nextAttemptAt) <= validIso(now))
          && !this.store.prospectExecutionLeases.some((lease) =>
            lease.runId === run.id && lease.status === "active"
          )
        )
        .sort((left, right) =>
          left.run.createdAt.localeCompare(right.run.createdAt)
          || left.shard.position - right.shard.position
          || left.job.id.localeCompare(right.job.id)
        );
      for (const selected of candidates) {
        validateProspectRunQueueBridge(this.store, selected.run);
        let checkpoint = this.store.prospectExecutionCheckpoints.find(
          (item) =>
            item.teamId === selected.run.teamId
            && item.runId === selected.run.id
            && item.shardId === selected.shard.id
        );
        let initialCursor = "";
        if (!checkpoint) {
          const connectionId = this.providerConnectionId({
            teamId: selected.run.teamId,
            ownerId: selected.run.ownerId,
            providerCode: selected.shard.providerCode
          });
          const sourcePosition = this.sourcePositionScope({
            run: selected.run,
            shard: selected.shard,
            connectionId
          }).position;
          if (sourcePosition?.status === "exhausted") {
            checkpoint = this.createCheckpoint({
              run: selected.run,
              shard: selected.shard,
              job: selected.job,
              now,
              completionReason: "SOURCE_POSITION_EXHAUSTED"
            });
            selected.shard.status = "succeeded_empty";
            selected.shard.updatedAt = now;
            selected.job.status = "succeeded";
            selected.job.startedAt = selected.job.startedAt || now;
            selected.job.finishedAt = now;
            selected.job.nextAttemptAt = "";
            selected.job.errorCode = "";
            selected.job.errorMessage = "";
            appendExecutionEvent(this.store, {
              teamId: selected.run.teamId,
              ownerId: selected.run.ownerId,
              runId: selected.run.id,
              shardId: selected.shard.id,
              jobId: selected.job.id,
              eventType: "shard_completed",
              kernelEpoch: this.kernelEpoch,
              runEpoch: selected.run.executionEpoch,
              fenceToken: 0,
              detail: {
                status: "succeeded_empty",
                acceptedCount: 0,
                errorCode: ""
              },
              createdAt: now
            });
            this.finishRunIfTerminal(selected.run, now);
            validateProspectRunQueueBridge(this.store, selected.run);
            continue;
          }
          if (sourcePosition?.status === "continuable") {
            initialCursor =
              this.decryptSourcePositionCursor(sourcePosition);
          }
        }

        const previousStatus = selected.run.status;
        const previousRevision = selected.run.revision;
        if (selected.run.status === "queued") {
          selected.run.status = "running";
          selected.run.revision += 1;
          selected.run.updatedAt = now;
          appendRunStartedEvent(
            this.store,
            selected.run,
            previousStatus,
            previousRevision,
            now
          );
        }
        selected.shard.status = "running";
        selected.shard.updatedAt = now;
        selected.job.status = "running";
        selected.job.startedAt = selected.job.startedAt || now;
        selected.job.finishedAt = "";
        selected.job.nextAttemptAt = "";
        selected.job.errorCode = "";
        selected.job.errorMessage = "";

        checkpoint ||= this.createCheckpoint({
          run: selected.run,
          shard: selected.shard,
          job: selected.job,
          now,
          cursor: initialCursor
        });
        const fenceToken = this.store.prospectExecutionLeases.reduce(
          (highest, lease) =>
            lease.teamId === selected.run.teamId
              && lease.jobId === selected.job.id
              ? Math.max(highest, lease.fenceToken)
              : highest,
          0
        ) + 1;
        const claimToken = randomBytes(32).toString("hex");
        const lease: ProspectExecutionLease = {
          id: `pexls_${randomUUID()}`,
          teamId: selected.run.teamId,
          ownerId: selected.run.ownerId,
          runId: selected.run.id,
          shardId: selected.shard.id,
          jobId: selected.job.id,
          kernelEpoch: this.kernelEpoch,
          runEpoch: selected.run.executionEpoch,
          fenceToken,
          claimTokenHmac: "",
          workerId: this.workerId,
          status: "active",
          claimedAt: now,
          heartbeatAt: now,
          expiresAt: plusMilliseconds(now, this.leaseMs),
          deadlineAt: plusMilliseconds(now, this.deadlineMs),
          requestStartedAt: "",
          releasedAt: "",
          releaseReason: "",
          version: 1
        };
        lease.claimTokenHmac = this.claimTokenHmac(lease, claimToken);
        this.store.prospectExecutionLeases.push(lease);
        const attempt: ProspectExecutionAttempt = {
          id: `pexat_${randomUUID()}`,
          teamId: lease.teamId,
          ownerId: lease.ownerId,
          runId: lease.runId,
          shardId: lease.shardId,
          jobId: lease.jobId,
          leaseId: lease.id,
          providerCode: selected.shard.providerCode,
          checkpointNo: checkpoint.checkpointNo,
          checkpointCallNo: 0,
          providerAttemptNo: 0,
          status: "claimed",
          requestHash: "",
          responseHash: "",
          errorCode: "",
          errorMessage: "",
          retryable: false,
          retryAfterAt: "",
          usageJson: "",
          costKind: "unknown",
          costAmount: null,
          currency: "",
          startedAt: "",
          finishedAt: "",
          createdAt: now,
          version: 1
        };
        this.store.prospectExecutionAttempts.push(attempt);
        appendExecutionEvent(this.store, {
          teamId: lease.teamId,
          ownerId: lease.ownerId,
          runId: lease.runId,
          shardId: lease.shardId,
          jobId: lease.jobId,
          eventType: "lease_claimed",
          kernelEpoch: lease.kernelEpoch,
          runEpoch: lease.runEpoch,
          fenceToken: lease.fenceToken,
          detail: {
            workerId: lease.workerId,
            expiresAt: lease.expiresAt,
            deadlineAt: lease.deadlineAt
          },
          createdAt: now
        });
        validateProspectRunQueueBridge(this.store, selected.run);
        return {
          value: {
            lease: structuredClone(lease),
            attempt: structuredClone(attempt),
            claimToken,
            run: structuredClone(selected.run),
            shard: structuredClone(selected.shard),
            job: structuredClone(selected.job)
          } satisfies ProspectExecutionClaim,
          rollback: () => restore(this.store, before)
        };
      }
      return {
        value: null,
        rollback: () => restore(this.store, before)
      };
    });
  }

  async prepareProviderRequest(input: {
    leaseId: string;
    claimToken: string;
    now?: string;
  }) {
    this.assertStarted();
    const now = input.now || new Date().toISOString();
    validIso(now);
    return persistMutation<ProspectPreparedProviderRequest>(
      this.store,
      () => {
        const before = snapshot(this.store);
        const scope = this.activeLease({
          leaseId: input.leaseId,
          claimToken: input.claimToken,
          now
        });
        if (scope.run.status === "pause_requested"
          || scope.shard.status === "pause_requested") {
          throw new ProspectExecutionKernelError(
            "EXECUTION_REQUEST_BLOCKED_BY_PAUSE",
            "暂停请求已生效，不能准备新的 Provider 请求"
          );
        }
        if (scope.attempt.status !== "claimed"
          || scope.lease.requestStartedAt) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_REQUEST_ALREADY_STARTED",
            "当前租约已经开始或完成 Provider 请求"
          );
        }
        if (scope.checkpoint.checkpointCallCount >= 3) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_CHECKPOINT_ATTEMPTS_EXHAUSTED",
            "当前 checkpoint 的三次总调用已耗尽"
          );
        }
        const providerSnapshot =
          scope.run.executionSnapshot.providerPlan.find((item) =>
            item.providerCode === scope.shard.providerCode
          );
        if (!providerSnapshot
          || providerSnapshot.adapterVersion !== scope.shard.adapterVersion
          || providerSnapshot.contractVersion
            !== scope.shard.contractVersion
          || providerSnapshot.catalogVersion !== scope.shard.catalogVersion
          || providerSnapshot.pageLimit !== scope.shard.pageLimit
          || providerSnapshot.resultLimit !== scope.shard.resultLimit) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_SNAPSHOT_INVALID",
            "Provider 执行快照与分片配置不一致"
          );
        }
        const cursor = this.decryptCursor(
          scope.checkpoint.encryptedCursor,
          scope.checkpoint.cursorHash,
          {
            teamId: scope.run.teamId,
            runId: scope.run.id,
            shardId: scope.shard.id,
            providerCode: scope.shard.providerCode,
            runEpoch: scope.run.executionEpoch,
            checkpointNo: scope.checkpoint.checkpointNo
          }
        );
        const logicalRequestNo = scope.checkpoint.totalCallCount + 1;
        const checkpointCallNo =
          scope.checkpoint.checkpointCallCount + 1;
        const connectionId = this.providerConnectionId({
          teamId: scope.run.teamId,
          ownerId: scope.run.ownerId,
          providerCode: scope.shard.providerCode
        });
        const connectionRevision = scope.shard.catalogVersion;
        const connectionConfigHash = sha256CanonicalJson({
          providerCode: scope.shard.providerCode,
          connectionId,
          connectionRevision,
          endpointCode: PROVIDER_ENDPOINT_CODE,
          adapterVersion: scope.shard.adapterVersion,
          contractVersion: scope.shard.contractVersion,
          accessMode: scope.shard.accessMode,
          capabilities: scope.shard.capabilities
        });
        const providerPayload = {
          query: structuredClone(scope.run.executionSnapshot.resolvedQuery),
          cursor,
          checkpoint: {
            checkpointNo: scope.checkpoint.checkpointNo,
            checkpointCallNo,
            logicalRequestNo
          },
          limits: {
            pageLimit: scope.shard.pageLimit,
            resultLimit: scope.shard.resultLimit,
            remainingResultLimit: Math.max(
              0,
              scope.shard.resultLimit - scope.checkpoint.acceptedCount
            )
          }
        };
        const requestHash = prospectProviderRequestHash({
          contractVersion: scope.shard.contractVersion,
          requestSchemaVersion: PROVIDER_REQUEST_SCHEMA_VERSION,
          adapterVersion: scope.shard.adapterVersion,
          teamId: scope.run.teamId,
          ownerId: scope.run.ownerId,
          runId: scope.run.id,
          shardId: scope.shard.id,
          checkpointNo: scope.checkpoint.checkpointNo,
          logicalRequestNo,
          providerCode: scope.shard.providerCode,
          connectionId,
          connectionRevision,
          endpointCode: PROVIDER_ENDPOINT_CODE,
          providerPayload
        });
        const idempotencyKey = prospectProviderRequestIdempotencyKey({
          teamId: scope.run.teamId,
          ownerId: scope.run.ownerId,
          connectionId,
          endpointCode: PROVIDER_ENDPOINT_CODE,
          requestHash
        }, this.providerRequestIdempotencySecret);
        const dispatchRequest: FakeProspectProviderDispatchRequest = {
          teamId: scope.run.teamId,
          ownerId: scope.run.ownerId,
          runId: scope.run.id,
          shardId: scope.shard.id,
          providerCode: scope.shard.providerCode,
          connectionId,
          endpointCode: PROVIDER_ENDPOINT_CODE,
          adapterVersion: scope.shard.adapterVersion,
          contractVersion: scope.shard.contractVersion,
          requestHash,
          idempotencyKey
        };
        const providerRequest: FakeProspectProviderRequest = {
          runId: scope.run.id,
          shardId: scope.shard.id,
          providerCode: scope.shard.providerCode,
          checkpointNo: scope.checkpoint.checkpointNo,
          checkpointCallNo,
          cursor,
          requestHash
        };
        const existing =
          this.store.prospectProviderRequestLedgers.find((item) =>
            item.teamId === scope.run.teamId
            && item.runId === scope.run.id
            && item.shardId === scope.shard.id
            && item.checkpointNo === scope.checkpoint.checkpointNo
            && item.logicalRequestNo === logicalRequestNo
          );
        if (existing) {
          const envelope = this.decryptProviderRequestEnvelope(existing);
          if (existing.status !== "prepared"
            || existing.ownerId !== scope.run.ownerId
            || existing.jobId !== scope.job.id
            || existing.providerCode !== scope.shard.providerCode
            || existing.connectionId !== connectionId
            || existing.connectionRevision !== connectionRevision
            || existing.connectionConfigHash !== connectionConfigHash
            || existing.endpointCode !== PROVIDER_ENDPOINT_CODE
            || existing.adapterVersion !== scope.shard.adapterVersion
            || existing.contractVersion !== scope.shard.contractVersion
            || existing.requestSchemaVersion
              !== PROVIDER_REQUEST_SCHEMA_VERSION
            || existing.requestHash !== requestHash
            || existing.idempotencyKey !== idempotencyKey
            || !isDeepStrictEqual(envelope.providerPayload, providerPayload)
            || !isDeepStrictEqual(
              envelope.dispatchRequest,
              dispatchRequest
            )
            || !isDeepStrictEqual(
              envelope.providerRequest,
              providerRequest
            )) {
            throw new ProspectExecutionKernelError(
              "EXECUTION_PROVIDER_PREPARED_REQUEST_CONFLICT",
              "已准备的 Provider 请求与当前逻辑请求不一致"
            );
          }
          const existingBinding =
            this.store.prospectProviderRequestAttemptBindings.find((item) =>
              item.teamId === existing.teamId
              && item.ownerId === existing.ownerId
              && item.ledgerId === existing.id
              && item.attemptId === scope.attempt.id
            );
          if (!existingBinding) {
            const bindingNo =
              this.store.prospectProviderRequestAttemptBindings.reduce(
                (highest, item) =>
                  item.teamId === existing.teamId
                    && item.ledgerId === existing.id
                    ? Math.max(highest, item.bindingNo)
                    : highest,
                0
              ) + 1;
            const binding: ProspectProviderRequestAttemptBinding = {
              id: `pprb_${randomUUID()}`,
              ledgerId: existing.id,
              attemptId: scope.attempt.id,
              teamId: existing.teamId,
              ownerId: existing.ownerId,
              bindingNo,
              createdAt: now
            };
            this.store.prospectProviderRequestAttemptBindings.push(binding);
          }
          return {
            value: {
              ledger: structuredClone(existing),
              dispatchRequest: structuredClone(dispatchRequest),
              providerRequest: structuredClone(providerRequest)
            },
            rollback: () => restore(this.store, before)
          };
        }
        const ledger: ProspectProviderRequestLedger = {
          id: `pprl_${randomUUID()}`,
          teamId: scope.run.teamId,
          ownerId: scope.run.ownerId,
          runId: scope.run.id,
          shardId: scope.shard.id,
          jobId: scope.job.id,
          originAttemptId: scope.attempt.id,
          checkpointNo: scope.checkpoint.checkpointNo,
          logicalRequestNo,
          providerCode: scope.shard.providerCode,
          connectionId,
          connectionRevision,
          connectionConfigHash,
          endpointCode: PROVIDER_ENDPOINT_CODE,
          adapterVersion: scope.shard.adapterVersion,
          contractVersion: scope.shard.contractVersion,
          requestSchemaVersion: PROVIDER_REQUEST_SCHEMA_VERSION,
          idempotencyKey,
          requestHash,
          encryptedRequestEnvelope: "",
          requestEvidenceRef: `sha256:${requestHash}`,
          status: "prepared",
          externalRequestId: "",
          dispatchConfirmationRef: "",
          encryptedResponseEnvelope: "",
          responseEvidenceRef: "",
          responseHash: "",
          rawResponseHash: "",
          normalizedResultHash: "",
          responseAccountingEvidenceHash: "",
          httpStatus: null,
          providerOutcomeCode: "",
          settlementKind: "",
          settlementHash: "",
          unknownReason: "",
          errorCode: "",
          kernelEpochAtPrepare: scope.lease.kernelEpoch,
          runEpochAtPrepare: scope.lease.runEpoch,
          fenceTokenAtPrepare: scope.lease.fenceToken,
          leaseIdAtPrepare: scope.lease.id,
          preparedAt: now,
          dispatchStartedAt: "",
          dispatchConfirmedAt: "",
          responseReceivedAt: "",
          unknownAt: "",
          settledAt: "",
          cancelledLateAt: "",
          updatedAt: now,
          version: 1
        };
        ledger.encryptedRequestEnvelope =
          this.encryptProviderRequestEnvelope(ledger, {
            providerPayload,
            dispatchRequest,
            providerRequest
          });
        const binding: ProspectProviderRequestAttemptBinding = {
          id: `pprb_${randomUUID()}`,
          ledgerId: ledger.id,
          attemptId: scope.attempt.id,
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          bindingNo: 1,
          createdAt: now
        };
        const preparedDetail = {
          contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
          ledgerId: ledger.id,
          requestHash: ledger.requestHash,
          idempotencyKey: ledger.idempotencyKey,
          requestEvidenceRef: ledger.requestEvidenceRef,
          status: ledger.status
        };
        const event: ProspectProviderRequestEvent = {
          id: `ppre_${randomUUID()}`,
          ledgerId: ledger.id,
          dispatchId: "",
          attemptId: scope.attempt.id,
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          sequence: 1,
          eventType: "prepared",
          fromStatus: "",
          toStatus: "prepared",
          detailHash: sha256CanonicalJson(preparedDetail),
          createdAt: now
        };
        this.store.prospectProviderRequestLedgers.push(ledger);
        this.store.prospectProviderRequestAttemptBindings.push(binding);
        this.store.prospectProviderRequestEvents.push(event);
        return {
          value: {
            ledger: structuredClone(ledger),
            dispatchRequest: structuredClone(dispatchRequest),
            providerRequest: structuredClone(providerRequest)
          },
          rollback: () => restore(this.store, before)
        };
      }
    );
  }

  async startPreparedProviderDispatch(input: {
    leaseId: string;
    claimToken: string;
    ledgerId: string;
    now?: string;
  }) {
    this.assertStarted();
    const now = input.now || new Date().toISOString();
    validIso(now);
    return persistMutation<StartPreparedProviderDispatchResult>(
      this.store,
      () => {
        const before = snapshot(this.store);
        const scope = this.activeLease({
          leaseId: input.leaseId,
          claimToken: input.claimToken,
          now
        });
        if (scope.run.status === "pause_requested"
          || scope.shard.status === "pause_requested") {
          throw new ProspectExecutionKernelError(
            "EXECUTION_REQUEST_BLOCKED_BY_PAUSE",
            "暂停请求已生效，不能派发 Provider 请求"
          );
        }
        if (scope.attempt.status !== "claimed"
          || scope.lease.requestStartedAt) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_REQUEST_ALREADY_STARTED",
            "当前租约已经开始或完成 Provider 请求"
          );
        }
        if (scope.checkpoint.checkpointCallCount >= 3) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_CHECKPOINT_ATTEMPTS_EXHAUSTED",
            "当前 checkpoint 的三次总调用已耗尽"
          );
        }
        const ledger = this.store.prospectProviderRequestLedgers.find(
          (item) =>
            item.id === input.ledgerId
            && item.teamId === scope.run.teamId
            && item.ownerId === scope.run.ownerId
            && item.runId === scope.run.id
            && item.shardId === scope.shard.id
            && item.jobId === scope.job.id
        );
        const binding =
          this.store.prospectProviderRequestAttemptBindings.find((item) =>
            item.teamId === scope.run.teamId
            && item.ownerId === scope.run.ownerId
            && item.ledgerId === input.ledgerId
            && item.attemptId === scope.attempt.id
          );
        if (!ledger || !binding || ledger.status !== "prepared") {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_PREPARED_REQUEST_INVALID",
            "Provider 请求账本不存在、未绑定当前尝试或已离开准备状态"
          );
        }
        if (validIso(ledger.preparedAt) > validIso(now)
          || ledger.checkpointNo !== scope.checkpoint.checkpointNo
          || ledger.logicalRequestNo !== scope.checkpoint.totalCallCount + 1
          || ledger.providerCode !== scope.shard.providerCode
          || ledger.adapterVersion !== scope.shard.adapterVersion
          || ledger.contractVersion !== scope.shard.contractVersion
          || ledger.connectionRevision !== scope.shard.catalogVersion
          || ledger.endpointCode !== PROVIDER_ENDPOINT_CODE
          || ledger.requestSchemaVersion
            !== PROVIDER_REQUEST_SCHEMA_VERSION) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_PREPARED_REQUEST_CONFLICT",
            "Provider 请求账本与当前 checkpoint 或执行快照不一致"
          );
        }
        if (this.store.prospectProviderRequestDispatches.some((item) =>
          item.teamId === ledger.teamId && item.ledgerId === ledger.id
        )) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_DISPATCH_ALREADY_EXISTS",
            "当前 Provider 请求已经存在派发事实"
          );
        }
        const providerSnapshot =
          scope.run.executionSnapshot.providerPlan.find((item) =>
            item.providerCode === scope.shard.providerCode
          );
        if (!providerSnapshot
          || providerSnapshot.adapterVersion !== ledger.adapterVersion
          || providerSnapshot.contractVersion !== ledger.contractVersion
          || providerSnapshot.catalogVersion !== ledger.connectionRevision
          || providerSnapshot.pageLimit !== scope.shard.pageLimit
          || providerSnapshot.resultLimit !== scope.shard.resultLimit) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_SNAPSHOT_INVALID",
            "Provider 执行快照与已准备请求不一致"
          );
        }
        const envelope = this.decryptProviderRequestEnvelope(ledger);
        const checkpointCallNo =
          scope.checkpoint.checkpointCallCount + 1;
        const cursor = this.decryptCursor(
          scope.checkpoint.encryptedCursor,
          scope.checkpoint.cursorHash,
          {
            teamId: scope.run.teamId,
            runId: scope.run.id,
            shardId: scope.shard.id,
            providerCode: scope.shard.providerCode,
            runEpoch: scope.run.executionEpoch,
            checkpointNo: scope.checkpoint.checkpointNo
          }
        );
        const expectedPayload = {
          query: structuredClone(scope.run.executionSnapshot.resolvedQuery),
          cursor,
          checkpoint: {
            checkpointNo: scope.checkpoint.checkpointNo,
            checkpointCallNo,
            logicalRequestNo: ledger.logicalRequestNo
          },
          limits: {
            pageLimit: scope.shard.pageLimit,
            resultLimit: scope.shard.resultLimit,
            remainingResultLimit: Math.max(
              0,
              scope.shard.resultLimit - scope.checkpoint.acceptedCount
            )
          }
        };
        const expectedConnectionConfigHash = sha256CanonicalJson({
          providerCode: scope.shard.providerCode,
          connectionId: ledger.connectionId,
          connectionRevision: ledger.connectionRevision,
          endpointCode: ledger.endpointCode,
          adapterVersion: scope.shard.adapterVersion,
          contractVersion: scope.shard.contractVersion,
          accessMode: scope.shard.accessMode,
          capabilities: scope.shard.capabilities
        });
        const expectedRequestHash = prospectProviderRequestHash({
          contractVersion: ledger.contractVersion,
          requestSchemaVersion: ledger.requestSchemaVersion,
          adapterVersion: ledger.adapterVersion,
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          runId: ledger.runId,
          shardId: ledger.shardId,
          checkpointNo: ledger.checkpointNo,
          logicalRequestNo: ledger.logicalRequestNo,
          providerCode: ledger.providerCode,
          connectionId: ledger.connectionId,
          connectionRevision: ledger.connectionRevision,
          endpointCode: ledger.endpointCode,
          providerPayload: envelope.providerPayload
        });
        const expectedIdempotencyKey =
          prospectProviderRequestIdempotencyKey({
            teamId: ledger.teamId,
            ownerId: ledger.ownerId,
            connectionId: ledger.connectionId,
            endpointCode: ledger.endpointCode,
            requestHash: ledger.requestHash
          }, this.providerRequestIdempotencySecret);
        const expectedDispatchRequest: FakeProspectProviderDispatchRequest = {
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          runId: ledger.runId,
          shardId: ledger.shardId,
          providerCode: ledger.providerCode,
          connectionId: ledger.connectionId,
          endpointCode: ledger.endpointCode,
          adapterVersion: ledger.adapterVersion,
          contractVersion: ledger.contractVersion,
          requestHash: ledger.requestHash,
          idempotencyKey: ledger.idempotencyKey
        };
        const expectedProviderRequest: FakeProspectProviderRequest = {
          runId: ledger.runId,
          shardId: ledger.shardId,
          providerCode: ledger.providerCode,
          checkpointNo: ledger.checkpointNo,
          checkpointCallNo,
          cursor,
          requestHash: ledger.requestHash
        };
        if (ledger.connectionConfigHash !== expectedConnectionConfigHash
          || ledger.requestHash !== expectedRequestHash
          || ledger.idempotencyKey !== expectedIdempotencyKey
          || !isDeepStrictEqual(envelope.providerPayload, expectedPayload)
          || !isDeepStrictEqual(
            envelope.dispatchRequest,
            expectedDispatchRequest
          )
          || !isDeepStrictEqual(
            envelope.providerRequest,
            expectedProviderRequest
          )) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_PREPARED_REQUEST_CONFLICT",
            "Provider 请求信封与持久化身份、游标或哈希不一致"
          );
        }

        const throttleId = createHash("sha256").update([
          scope.run.teamId,
          ledger.providerCode,
          ledger.connectionId
        ].join("\u001f")).digest("hex");
        let throttle = this.store.prospectExecutionThrottleBuckets.find(
          (item) =>
            item.id === throttleId
            && item.teamId === scope.run.teamId
            && item.providerCode === ledger.providerCode
            && item.connectionId === ledger.connectionId
        );
        if (!throttle) {
          throttle = {
            id: throttleId,
            teamId: scope.run.teamId,
            providerCode: ledger.providerCode,
            connectionId: ledger.connectionId,
            availableAt: now,
            version: 1,
            updatedAt: now
          };
          this.store.prospectExecutionThrottleBuckets.push(throttle);
        }
        if (validIso(throttle.availableAt) > validIso(now)) {
          scope.attempt.status = "failed";
          scope.attempt.errorCode = "PROVIDER_THROTTLE_DEFERRED";
          scope.attempt.errorMessage = "Provider 调用窗口尚未开放";
          scope.attempt.retryable = true;
          scope.attempt.retryAfterAt = throttle.availableAt;
          scope.attempt.finishedAt = now;
          scope.attempt.version += 1;
          scope.checkpoint.retryAfterAt = throttle.availableAt;
          scope.checkpoint.updatedAt = now;
          scope.checkpoint.version += 1;
          scope.job.status = "retry_scheduled";
          scope.job.nextAttemptAt = throttle.availableAt;
          scope.job.errorCode = scope.attempt.errorCode;
          scope.job.errorMessage = scope.attempt.errorMessage;
          scope.shard.status = "retry_scheduled";
          scope.shard.updatedAt = now;
          this.releaseLease(
            scope.lease,
            now,
            "PROVIDER_THROTTLE_DEFERRED"
          );
          return {
            value: {
              ready: false as const,
              retryAfterAt: throttle.availableAt
            },
            rollback: () => restore(this.store, before)
          };
        }

        throttle.availableAt = plusMilliseconds(
          now,
          this.throttleIntervalMs
        );
        throttle.version += 1;
        throttle.updatedAt = now;
        scope.checkpoint.checkpointCallCount += 1;
        scope.checkpoint.totalCallCount += 1;
        scope.checkpoint.retryAfterAt = "";
        scope.checkpoint.updatedAt = now;
        scope.checkpoint.version += 1;
        scope.job.attemptCount += 1;
        scope.attempt.status = "request_started";
        scope.attempt.checkpointNo = ledger.checkpointNo;
        scope.attempt.checkpointCallNo = checkpointCallNo;
        scope.attempt.providerAttemptNo = scope.job.attemptCount;
        scope.attempt.requestHash = ledger.requestHash;
        scope.attempt.startedAt = now;
        scope.attempt.version += 1;
        scope.lease.requestStartedAt = now;
        scope.lease.version += 1;
        const dispatchNo =
          this.store.prospectProviderRequestDispatches.reduce(
            (highest, item) =>
              item.teamId === ledger.teamId
                && item.ledgerId === ledger.id
                ? Math.max(highest, item.dispatchNo)
                : highest,
            0
          ) + 1;
        const dispatch: ProspectProviderRequestDispatch = {
          id: `pprd_${randomUUID()}`,
          ledgerId: ledger.id,
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          runId: ledger.runId,
          shardId: ledger.shardId,
          attemptId: scope.attempt.id,
          dispatchNo,
          operation: "dispatch",
          status: "started",
          idempotencyKey: ledger.idempotencyKey,
          requestHash: ledger.requestHash,
          replayed: false,
          providerExecuted: false,
          externalRequestId: "",
          responseHash: "",
          errorCode: "",
          startedAt: now,
          confirmedAt: "",
          finishedAt: "",
          version: 1
        };
        const previousStatus = ledger.status;
        ledger.status = "dispatch_started";
        ledger.dispatchStartedAt = now;
        ledger.updatedAt = now;
        ledger.version += 1;
        const dispatchDetail = {
          contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
          ledgerId: ledger.id,
          dispatchId: dispatch.id,
          requestHash: ledger.requestHash,
          idempotencyKey: ledger.idempotencyKey,
          dispatchNo,
          status: ledger.status
        };
        this.store.prospectProviderRequestDispatches.push(dispatch);
        this.store.prospectProviderRequestEvents.push({
          id: `ppre_${randomUUID()}`,
          ledgerId: ledger.id,
          dispatchId: dispatch.id,
          attemptId: scope.attempt.id,
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          sequence: ledger.version,
          eventType: "dispatch_started",
          fromStatus: previousStatus,
          toStatus: ledger.status,
          detailHash: sha256CanonicalJson(dispatchDetail),
          createdAt: now
        });
        appendExecutionEvent(this.store, {
          teamId: scope.run.teamId,
          ownerId: scope.run.ownerId,
          runId: scope.run.id,
          shardId: scope.shard.id,
          jobId: scope.job.id,
          eventType: "request_started",
          kernelEpoch: scope.lease.kernelEpoch,
          runEpoch: scope.lease.runEpoch,
          fenceToken: scope.lease.fenceToken,
          detail: {
            checkpointNo: scope.attempt.checkpointNo,
            checkpointCallNo: scope.attempt.checkpointCallNo,
            providerAttemptNo: scope.attempt.providerAttemptNo,
            requestHash: ledger.requestHash,
            ledgerId: ledger.id,
            dispatchId: dispatch.id
          },
          createdAt: now
        });
        return {
          value: {
            ready: true as const,
            ledger: structuredClone(ledger),
            dispatch: structuredClone(dispatch),
            dispatchRequest: structuredClone(expectedDispatchRequest),
            providerRequest: structuredClone(expectedProviderRequest)
          },
          rollback: () => restore(this.store, before)
        };
      }
    );
  }

  private providerResponseFacts(
    dispatchRequest: FakeProspectProviderDispatchRequest,
    response: FakeProspectProviderResponse
  ) {
    validateProviderResponseStep(response.step);
    if (!response.externalRequestId.trim()
      || !Number.isInteger(response.httpStatus)
      || response.httpStatus < 100
      || response.httpStatus > 599) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RESPONSE_INVALID",
        "Provider 响应缺少有效外部请求编号或 HTTP 状态"
      );
    }
    const componentHashes =
      prospectProviderResponseComponentHashes(response.step);
    const responseHash = prospectProviderResponseHash({
      contractVersion: dispatchRequest.contractVersion,
      requestHash: dispatchRequest.requestHash,
      idempotencyKey: dispatchRequest.idempotencyKey,
      providerCode: dispatchRequest.providerCode,
      connectionId: dispatchRequest.connectionId,
      endpointCode: dispatchRequest.endpointCode,
      externalRequestId: response.externalRequestId,
      httpStatus: response.httpStatus,
      rawResponseHash: componentHashes.rawResponseHash,
      normalizedResultHash: componentHashes.normalizedResultHash,
      accountingEvidenceHash: componentHashes.accountingEvidenceHash
    });
    if (response.rawResponseHash !== componentHashes.rawResponseHash
      || response.normalizedResultHash
        !== componentHashes.normalizedResultHash
      || response.accountingEvidenceHash
        !== componentHashes.accountingEvidenceHash
      || response.responseHash !== responseHash) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RESPONSE_INVALID",
        "Provider 响应摘要与服务端复算结果不一致"
      );
    }
    return {
      ...componentHashes,
      responseHash,
      providerOutcomeCode: safeProviderOutcomeCode(response.step)
    };
  }

  private verifiedProviderResponse(
    ledger: ProspectProviderRequestLedger,
    dispatch: ProspectProviderRequestDispatch
  ) {
    const envelope = this.decryptProviderResponseEnvelope(ledger, dispatch);
    const response: FakeProspectProviderResponse = {
      step: envelope.step,
      externalRequestId: envelope.externalRequestId,
      httpStatus: envelope.httpStatus,
      rawResponseHash: envelope.rawResponseHash,
      normalizedResultHash: envelope.normalizedResultHash,
      accountingEvidenceHash: envelope.accountingEvidenceHash,
      responseHash: envelope.responseHash,
      replayed: dispatch.replayed
    };
    const dispatchRequest: FakeProspectProviderDispatchRequest = {
      teamId: ledger.teamId,
      ownerId: ledger.ownerId,
      runId: ledger.runId,
      shardId: ledger.shardId,
      providerCode: ledger.providerCode,
      connectionId: ledger.connectionId,
      endpointCode: ledger.endpointCode,
      adapterVersion: ledger.adapterVersion,
      contractVersion: ledger.contractVersion,
      requestHash: ledger.requestHash,
      idempotencyKey: ledger.idempotencyKey
    };
    const facts = this.providerResponseFacts(dispatchRequest, response);
    const expectedConfirmationRef =
      prospectProviderDispatchConfirmationRef({
        ledgerId: ledger.id,
        dispatchId: dispatch.id,
        externalRequestId: ledger.externalRequestId,
        responseHash: ledger.responseHash
      });
    const expectedEvidenceRef = prospectProviderResponseEvidenceRef({
      ledgerId: ledger.id,
      dispatchId: dispatch.id,
      requestHash: ledger.requestHash,
      idempotencyKey: ledger.idempotencyKey,
      externalRequestId: ledger.externalRequestId,
      responseHash: ledger.responseHash
    });
    if (envelope.providerOutcomeCode !== facts.providerOutcomeCode
      || ledger.providerOutcomeCode !== facts.providerOutcomeCode
      || ledger.rawResponseHash !== facts.rawResponseHash
      || ledger.normalizedResultHash !== facts.normalizedResultHash
      || ledger.responseAccountingEvidenceHash
        !== facts.accountingEvidenceHash
      || ledger.httpStatus !== response.httpStatus
      || ledger.dispatchConfirmationRef !== expectedConfirmationRef
      || ledger.responseEvidenceRef !== expectedEvidenceRef) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RESPONSE_CONFLICT",
        "Provider 响应证据与持久化摘要不一致"
      );
    }
    return response;
  }

  private persistedProviderResponse(input: {
    leaseId: string;
    claimToken: string;
    ledgerId: string;
  }): DispatchPreparedProviderRequestResponseReceived | null {
    this.assertStarted();
    const lease = this.store.prospectExecutionLeases.find((item) =>
      item.id === input.leaseId
      && this.isRunAllowed(item.runId)
    );
    if (!lease) return null;
    this.assertClaimToken(lease, input.claimToken);
    const ledger = this.store.prospectProviderRequestLedgers.find((item) =>
      item.id === input.ledgerId
      && item.teamId === lease.teamId
      && item.ownerId === lease.ownerId
      && item.runId === lease.runId
      && item.shardId === lease.shardId
      && item.jobId === lease.jobId
      && item.leaseIdAtPrepare === lease.id
      && item.status === "response_received"
    );
    if (!ledger) return null;
    const attempt = this.store.prospectExecutionAttempts.find((item) =>
      item.leaseId === lease.id
      && item.teamId === lease.teamId
      && item.ownerId === lease.ownerId
      && item.runId === lease.runId
      && item.shardId === lease.shardId
      && item.jobId === lease.jobId
    );
    const dispatch = attempt
      ? this.store.prospectProviderRequestDispatches.find((item) =>
          item.ledgerId === ledger.id
          && item.teamId === ledger.teamId
          && item.ownerId === ledger.ownerId
          && item.attemptId === attempt.id
          && item.status === "response_received"
        )
      : null;
    const leaseReleaseMatchesAttempt =
      attempt?.status === "request_started"
        ? lease.releaseReason === "RESPONSE_RECEIVED_PENDING_SETTLEMENT"
        : attempt?.status === "request_outcome_unknown"
          && [
            "REQUEST_OUTCOME_UNKNOWN",
            "CANCELLED_REQUEST_OUTCOME_UNKNOWN"
          ].includes(lease.releaseReason);
    if (!attempt
      || !dispatch
      || dispatch.requestHash !== ledger.requestHash
      || dispatch.idempotencyKey !== ledger.idempotencyKey
      || dispatch.externalRequestId !== ledger.externalRequestId
      || dispatch.responseHash !== ledger.responseHash
      || !["released", "expired"].includes(lease.status)
      || !leaseReleaseMatchesAttempt) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RESPONSE_SCOPE_INVALID",
        "Provider 响应与租约、账本或派发作用域不一致"
      );
    }
    const response = this.verifiedProviderResponse(ledger, dispatch);
    return {
      kind: "response_received",
      ledger: structuredClone(ledger),
      dispatch: structuredClone(dispatch),
      response: structuredClone(response)
    };
  }

  async persistPreparedProviderResponse(input: {
    leaseId: string;
    claimToken: string;
    ledgerId: string;
    response: FakeProspectProviderResponse;
    now?: string;
  }): Promise<DispatchPreparedProviderRequestResponseReceived> {
    this.assertStarted();
    const now = input.now || new Date().toISOString();
    validIso(now);
    return persistMutation(this.store, () => {
      const before = snapshot(this.store);
      const lease = this.store.prospectExecutionLeases.find((item) =>
        item.id === input.leaseId
        && this.isRunAllowed(item.runId)
      );
      if (!lease) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_LEASE_NOT_ACTIVE",
          "执行租约不存在、已失效或不在白名单内"
        );
      }
      this.assertClaimToken(lease, input.claimToken);
      const attempt = this.store.prospectExecutionAttempts.find((item) =>
        item.leaseId === lease.id
        && item.teamId === lease.teamId
        && item.ownerId === lease.ownerId
        && item.runId === lease.runId
        && item.shardId === lease.shardId
        && item.jobId === lease.jobId
      );
      const ledger = this.store.prospectProviderRequestLedgers.find((item) =>
        item.id === input.ledgerId
        && item.teamId === lease.teamId
        && item.ownerId === lease.ownerId
        && item.runId === lease.runId
        && item.shardId === lease.shardId
        && item.jobId === lease.jobId
        && item.leaseIdAtPrepare === lease.id
      );
      const dispatch = attempt && ledger
        ? this.store.prospectProviderRequestDispatches.find((item) =>
            item.ledgerId === ledger.id
            && item.teamId === ledger.teamId
            && item.ownerId === ledger.ownerId
            && item.runId === ledger.runId
            && item.shardId === ledger.shardId
            && item.attemptId === attempt.id
          )
        : null;
      if (!attempt || !ledger || !dispatch
        || dispatch.requestHash !== ledger.requestHash
        || dispatch.idempotencyKey !== ledger.idempotencyKey) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_PROVIDER_RESPONSE_SCOPE_INVALID",
          "Provider 响应与租约、账本、尝试或派发作用域不一致"
        );
      }
      const dispatchRequest: FakeProspectProviderDispatchRequest = {
        teamId: ledger.teamId,
        ownerId: ledger.ownerId,
        runId: ledger.runId,
        shardId: ledger.shardId,
        providerCode: ledger.providerCode,
        connectionId: ledger.connectionId,
        endpointCode: ledger.endpointCode,
        adapterVersion: ledger.adapterVersion,
        contractVersion: ledger.contractVersion,
        requestHash: ledger.requestHash,
        idempotencyKey: ledger.idempotencyKey
      };
      const facts = this.providerResponseFacts(
        dispatchRequest,
        input.response
      );
      if (ledger.status === "response_received") {
        const persisted = this.persistedProviderResponse(input);
        if (!persisted
          || persisted.response.responseHash !== facts.responseHash) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_RESPONSE_CONFLICT",
            "同一 Provider 请求不能绑定不同响应"
          );
        }
        return {
          value: persisted,
          rollback: () => restore(this.store, before)
        };
      }
      const activeResponseScope = lease.status === "active"
        && attempt.status === "request_started"
        && ["dispatch_started", "dispatch_confirmed"].includes(ledger.status)
        && ["started", "confirmed"].includes(dispatch.status);
      const recoveredUnknownResponseScope =
        ["released", "expired"].includes(lease.status)
        && attempt.status === "request_outcome_unknown"
        && ledger.status === "outcome_unknown"
        && dispatch.status === "outcome_unknown"
        && [
          "REQUEST_OUTCOME_UNKNOWN",
          "CANCELLED_REQUEST_OUTCOME_UNKNOWN"
        ].includes(lease.releaseReason);
      if ((!activeResponseScope && !recoveredUnknownResponseScope)
        || !lease.requestStartedAt
        || validIso(now) < validIso(dispatch.startedAt)) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_PROVIDER_RESPONSE_SCOPE_INVALID",
          "Provider 响应到达时执行状态已经失效或时间发生回退"
        );
      }
      const confirmationRef = prospectProviderDispatchConfirmationRef({
        ledgerId: ledger.id,
        dispatchId: dispatch.id,
        externalRequestId: input.response.externalRequestId,
        responseHash: facts.responseHash
      });
      const responseObservationFloor = latestIso(
        now,
        dispatch.startedAt,
        dispatch.finishedAt,
        ledger.updatedAt,
        ledger.unknownAt,
        lease.releasedAt
      );
      const needsDispatchConfirmation = !ledger.dispatchConfirmedAt;
      const confirmationAt = ledger.dispatchConfirmedAt
        || (ledger.status === "outcome_unknown"
          ? plusMilliseconds(responseObservationFloor, 1)
          : responseObservationFloor);
      const responseReceivedAt = plusMilliseconds(
        latestIso(responseObservationFloor, confirmationAt),
        1
      );
      if (needsDispatchConfirmation) {
        const previousStatus = ledger.status;
        ledger.status = "dispatch_confirmed";
        ledger.externalRequestId = input.response.externalRequestId;
        ledger.dispatchConfirmationRef = confirmationRef;
        ledger.dispatchConfirmedAt = confirmationAt;
        ledger.updatedAt = confirmationAt;
        ledger.version += 1;
        const confirmationDetail = {
          contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
          ledgerId: ledger.id,
          dispatchId: dispatch.id,
          requestHash: ledger.requestHash,
          externalRequestId: input.response.externalRequestId,
          confirmationRef,
          replayed: input.response.replayed,
          status: ledger.status
        };
        this.store.prospectProviderRequestEvents.push({
          id: `ppre_${randomUUID()}`,
          ledgerId: ledger.id,
          dispatchId: dispatch.id,
          attemptId: dispatch.attemptId,
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          sequence: ledger.version,
          eventType: "dispatch_confirmed",
          fromStatus: previousStatus,
          toStatus: ledger.status,
          detailHash: sha256CanonicalJson(confirmationDetail),
          createdAt: confirmationAt
        });
      } else if (ledger.externalRequestId
          !== input.response.externalRequestId
        || ledger.dispatchConfirmationRef !== confirmationRef
        || dispatch.externalRequestId
          !== input.response.externalRequestId) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_PROVIDER_RESPONSE_CONFLICT",
          "Provider 响应与已确认派发事实不一致"
        );
      }

      dispatch.status = "response_received";
      dispatch.replayed = input.response.replayed;
      dispatch.providerExecuted =
        dispatch.operation === "dispatch" && !input.response.replayed;
      dispatch.externalRequestId = input.response.externalRequestId;
      dispatch.responseHash = facts.responseHash;
      dispatch.errorCode = "";
      dispatch.confirmedAt = dispatch.confirmedAt || confirmationAt;
      dispatch.finishedAt = responseReceivedAt;
      dispatch.version += 1;

      const previousStatus = ledger.status;
      ledger.status = "response_received";
      ledger.externalRequestId = input.response.externalRequestId;
      ledger.dispatchConfirmationRef = confirmationRef;
      ledger.responseHash = facts.responseHash;
      ledger.rawResponseHash = facts.rawResponseHash;
      ledger.normalizedResultHash = facts.normalizedResultHash;
      ledger.responseAccountingEvidenceHash =
        facts.accountingEvidenceHash;
      ledger.httpStatus = input.response.httpStatus;
      ledger.providerOutcomeCode = facts.providerOutcomeCode;
      ledger.errorCode = "";
      ledger.responseReceivedAt = responseReceivedAt;
      ledger.updatedAt = responseReceivedAt;
      ledger.version += 1;
      ledger.responseEvidenceRef = prospectProviderResponseEvidenceRef({
        ledgerId: ledger.id,
        dispatchId: dispatch.id,
        requestHash: ledger.requestHash,
        idempotencyKey: ledger.idempotencyKey,
        externalRequestId: ledger.externalRequestId,
        responseHash: ledger.responseHash
      });
      ledger.encryptedResponseEnvelope =
        this.encryptProviderResponseEnvelope(ledger, dispatch, {
          step: structuredClone(input.response.step),
          externalRequestId: ledger.externalRequestId,
          httpStatus: ledger.httpStatus,
          rawResponseHash: ledger.rawResponseHash,
          normalizedResultHash: ledger.normalizedResultHash,
          accountingEvidenceHash:
            ledger.responseAccountingEvidenceHash,
          responseHash: ledger.responseHash,
          providerOutcomeCode: ledger.providerOutcomeCode
        });
      const responseDetail = {
        contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
        ledgerId: ledger.id,
        dispatchId: dispatch.id,
        requestHash: ledger.requestHash,
        externalRequestId: ledger.externalRequestId,
        responseEvidenceRef: ledger.responseEvidenceRef,
        responseHash: ledger.responseHash,
        rawResponseHash: ledger.rawResponseHash,
        normalizedResultHash: ledger.normalizedResultHash,
        accountingEvidenceHash:
          ledger.responseAccountingEvidenceHash,
        httpStatus: ledger.httpStatus,
        providerOutcomeCode: ledger.providerOutcomeCode,
        status: ledger.status
      };
      this.store.prospectProviderRequestEvents.push({
        id: `ppre_${randomUUID()}`,
        ledgerId: ledger.id,
        dispatchId: dispatch.id,
        attemptId: dispatch.attemptId,
        teamId: ledger.teamId,
        ownerId: ledger.ownerId,
        sequence: ledger.version,
        eventType: "response_received",
        fromStatus: previousStatus,
        toStatus: ledger.status,
        detailHash: sha256CanonicalJson(responseDetail),
        createdAt: responseReceivedAt
      });
      if (lease.status === "active") {
        this.releaseLease(
          lease,
          responseReceivedAt,
          "RESPONSE_RECEIVED_PENDING_SETTLEMENT"
        );
      }
      return {
        value: {
          kind: "response_received",
          ledger: structuredClone(ledger),
          dispatch: structuredClone(dispatch),
          response: structuredClone(input.response)
        },
        rollback: () => restore(this.store, before)
      };
    });
  }

  async dispatchPreparedProviderRequest(
    provider: ProspectExecutionProviderDispatcher,
    input: {
      leaseId: string;
      claimToken: string;
      ledgerId: string;
      now?: string;
    }
  ) {
    const now = input.now || new Date().toISOString();
    const persisted = this.persistedProviderResponse(input);
    if (persisted) return persisted;
    const startedAtMonotonic = performance.now();
    const started = await this.startPreparedProviderDispatch({
      ...input,
      now
    });
    if (!started.ready) {
      return {
        kind: "throttled" as const,
        retryAfterAt: started.retryAfterAt
      } satisfies DispatchPreparedProviderRequestDeferred;
    }
    let response: FakeProspectProviderResponse;
    try {
      response = await provider.dispatch(
        started.dispatchRequest,
        started.providerRequest
      );
    } catch (error) {
      const unknownAt = plusMilliseconds(
        now,
        Math.max(1, Math.ceil(performance.now() - startedAtMonotonic))
      );
      const providerErrorCode = typeof error === "object"
        && error !== null
        && "code" in error
        ? String((error as { code?: unknown }).code || "UNCLASSIFIED")
          .replace(/[^a-zA-Z0-9_.-]/g, "_")
          .slice(0, 80)
        : "UNCLASSIFIED";
      await persistMutation(this.store, () => {
        const before = snapshot(this.store);
        this.terminateProviderRequestAsOutcomeUnknown({
          leaseId: input.leaseId,
          claimToken: input.claimToken,
          now: unknownAt,
          reason: `provider_dispatch_exception:${providerErrorCode}`
        });
        return {
          value: undefined,
          rollback: () => restore(this.store, before)
        };
      });
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_OUTCOME_UNKNOWN",
        "Provider 请求已派发但结果无法安全确认，系统不会自动重试"
      );
    }
    const confirmedAt = plusMilliseconds(
      now,
      Math.max(1, Math.ceil(performance.now() - startedAtMonotonic))
    );
    return this.persistPreparedProviderResponse({
      leaseId: input.leaseId,
      claimToken: input.claimToken,
      ledgerId: input.ledgerId,
      response,
      now: confirmedAt
    });
  }

  async settlePersistedProviderResponse(input: {
    teamId: string;
    ownerId: string;
    runId: string;
    ledgerId: string;
    expectedResponseHash: string;
    now?: string;
  }): Promise<SettlePersistedProviderResponseResult> {
    this.assertStarted();
    const now = input.now || new Date().toISOString();
    validIso(now);
    return persistMutation<SettlePersistedProviderResponseResult>(
      this.store,
      () => {
        const before = snapshot(this.store);
        const run = this.store.prospectSearchRuns.find((item) =>
          item.id === input.runId
          && item.teamId === input.teamId
          && item.ownerId === input.ownerId
          && this.isRunAllowed(item.id)
        );
        const ledger = run
          ? this.store.prospectProviderRequestLedgers.find((item) =>
              item.id === input.ledgerId
              && item.teamId === input.teamId
              && item.ownerId === input.ownerId
              && item.runId === input.runId
            )
          : null;
        if (!run || !ledger) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_SETTLEMENT_SCOPE_INVALID",
            "Provider 响应结算不在当前团队、业务员或运行作用域内"
          );
        }
        if (!/^[a-f0-9]{64}$/.test(input.expectedResponseHash)
          || ledger.responseHash !== input.expectedResponseHash) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_SETTLEMENT_CONFLICT",
            "Provider 响应结算摘要与持久化响应不一致"
          );
        }
        const shard = this.store.prospectRunShards.find((item) =>
          item.id === ledger.shardId
          && item.teamId === ledger.teamId
          && item.runId === ledger.runId
          && item.providerCode === ledger.providerCode
        );
        const job = this.store.agentJobs.find((item) =>
          item.id === ledger.jobId
          && item.teamId === ledger.teamId
          && item.ownerId === ledger.ownerId
          && item.jobType === PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
        );
        const checkpoint =
          this.store.prospectExecutionCheckpoints.find((item) =>
            item.teamId === ledger.teamId
            && item.ownerId === ledger.ownerId
            && item.runId === ledger.runId
            && item.shardId === ledger.shardId
            && item.jobId === ledger.jobId
          );
        const responseDispatches =
          this.store.prospectProviderRequestDispatches.filter((item) =>
            item.ledgerId === ledger.id
            && item.teamId === ledger.teamId
            && item.ownerId === ledger.ownerId
            && item.runId === ledger.runId
            && item.shardId === ledger.shardId
            && item.status === "response_received"
          );
        const dispatch = responseDispatches.length === 1
          ? responseDispatches[0]
          : null;
        const attempt = dispatch
          ? this.store.prospectExecutionAttempts.find((item) =>
              item.id === dispatch.attemptId
              && item.teamId === ledger.teamId
              && item.ownerId === ledger.ownerId
              && item.runId === ledger.runId
              && item.shardId === ledger.shardId
              && item.jobId === ledger.jobId
              && item.providerCode === ledger.providerCode
            )
          : null;
        const lease = attempt
          ? this.store.prospectExecutionLeases.find((item) =>
              item.id === attempt.leaseId
              && item.id === ledger.leaseIdAtPrepare
              && item.teamId === ledger.teamId
              && item.ownerId === ledger.ownerId
              && item.runId === ledger.runId
              && item.shardId === ledger.shardId
              && item.jobId === ledger.jobId
            )
          : null;
        const binding = attempt
          ? this.store.prospectProviderRequestAttemptBindings.find((item) =>
              item.ledgerId === ledger.id
              && item.attemptId === attempt.id
              && item.teamId === ledger.teamId
              && item.ownerId === ledger.ownerId
            )
          : null;
        const terminalLeaseReason = lease
          && [
            "RESPONSE_RECEIVED_PENDING_SETTLEMENT",
            "REQUEST_OUTCOME_UNKNOWN",
            "CANCELLED_REQUEST_OUTCOME_UNKNOWN"
          ].includes(lease.releaseReason);
        if (!shard
          || !job
          || !checkpoint
          || !dispatch
          || !attempt
          || !lease
          || !binding
          || dispatch.requestHash !== ledger.requestHash
          || dispatch.idempotencyKey !== ledger.idempotencyKey
          || dispatch.externalRequestId !== ledger.externalRequestId
          || dispatch.responseHash !== ledger.responseHash
          || !["released", "expired"].includes(lease.status)
          || !terminalLeaseReason
          || validIso(now) < validIso(ledger.responseReceivedAt)) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_SETTLEMENT_SCOPE_INVALID",
            "Provider 响应结算引用的运行、派发、尝试或终态租约不一致"
          );
        }
        const response = this.verifiedProviderResponse(ledger, dispatch);
        const accountingEvidenceRows =
          this.store.prospectProviderRequestAccountingEvidence.filter(
            (item) =>
              item.ledgerId === ledger.id
              && item.teamId === ledger.teamId
              && item.ownerId === ledger.ownerId
          );
        const pages = this.store.prospectExecutionPages.filter((item) =>
          item.attemptId === attempt.id
          && item.teamId === ledger.teamId
          && item.ownerId === ledger.ownerId
          && item.runId === ledger.runId
          && item.shardId === ledger.shardId
        );

        if (ledger.status === "settled"
          || ledger.status === "cancelled_late") {
          const settlementKind = ledger.settlementKind;
          const accountingEvidence = accountingEvidenceRows[0];
          const page = pages[0];
          const settlementAt = ledger.status === "cancelled_late"
            ? ledger.cancelledLateAt
            : ledger.settledAt;
          const validKind = settlementKind === "success"
            || settlementKind === "failure"
            || settlementKind === "cancelled_late";
          const expectedPageCount = settlementKind === "success" ? 1 : 0;
          if (!validKind
            || accountingEvidenceRows.length !== 1
            || !accountingEvidence
            || pages.length !== expectedPageCount
            || !settlementAt
            || ledger.settlementHash !== prospectProviderSettlementHash({
              contractVersion: ledger.contractVersion,
              teamId: ledger.teamId,
              ownerId: ledger.ownerId,
              runId: ledger.runId,
              ledgerId: ledger.id,
              requestHash: ledger.requestHash,
              idempotencyKey: ledger.idempotencyKey,
              externalRequestId: ledger.externalRequestId,
              responseHash: ledger.responseHash,
              dispatchId: dispatch.id,
              attemptId: attempt.id,
              settlementKind,
              settlementAt,
              attempt,
              accountingEvidence,
              page: page || null
            })) {
            throw new ProspectExecutionKernelError(
              "EXECUTION_PROVIDER_SETTLEMENT_CONFLICT",
              "Provider 响应已有结算事实不完整或摘要不一致"
            );
          }
          const rawBatch = page
            ? this.appendSettledProviderRawFacts({
                ledger,
                attempt,
                page,
                response,
                requireExisting: true
              })
            : undefined;
          if (settlementKind === "success" && page) {
            if (response.step.kind !== "success") {
              throw new ProspectExecutionKernelError(
                "EXECUTION_PROVIDER_SETTLEMENT_CONFLICT",
                "Provider 成功结算与响应结果不一致"
              );
            }
            this.upsertSourcePosition({
              run,
              shard,
              page,
              connectionId: ledger.connectionId,
              cursor: response.step.cursor,
              hasMore: response.step.hasMore,
              now: settlementAt,
              onlyIfMissing: true
            });
          }
          return {
            value: {
              kind: settlementKind,
              idempotent: true,
              ledger: structuredClone(ledger),
              attempt: structuredClone(attempt),
              accountingEvidence: structuredClone(accountingEvidence),
              ...(page ? { page: structuredClone(page) } : {}),
              ...(rawBatch ? { rawBatch } : {}),
              retryScheduled: settlementKind === "failure"
                && Boolean(attempt.retryAfterAt),
              retryAfterAt: settlementKind === "failure"
                ? attempt.retryAfterAt
                : "",
              runStatus: run.status,
              shardStatus: shard.status
            },
            rollback: () => restore(this.store, before)
          };
        }

        if (ledger.status !== "response_received"
          || accountingEvidenceRows.length
          || pages.length
          || !["request_started", "request_outcome_unknown"].includes(
            attempt.status
          )) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_SETTLEMENT_STATE_INVALID",
            "Provider 响应尚未进入可结算状态或已存在冲突事实"
          );
        }
        const normalSettlement = attempt.status === "request_started"
          && (run.status === "running"
            || run.status === "pause_requested");
        const lateSettlement = attempt.status === "request_outcome_unknown"
          || run.status === "cancel_requested"
          || [
            "cancelled",
            "failed",
            "partial_success",
            "succeeded",
            "succeeded_empty"
          ].includes(run.status);
        if (!normalSettlement && !lateSettlement) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_SETTLEMENT_STATE_INVALID",
            "Provider 响应与当前运行状态不允许结算"
          );
        }

        const evidenceHash =
          prospectProviderAccountingEvidenceHash(response.step);
        if (evidenceHash !== ledger.responseAccountingEvidenceHash) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_PROVIDER_SETTLEMENT_CONFLICT",
            "Provider 成本证据摘要与响应组件不一致"
          );
        }
        const accountingEvidence: ProspectProviderRequestAccountingEvidence = {
          id: `pprae_${randomUUID()}`,
          ledgerId: ledger.id,
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          sequence: 1,
          provenance: response.step.cost.kind === "actual"
            ? "provider_reported"
            : response.step.cost.kind,
          usageJson: canonicalJsonStringify(response.step.usage),
          costAmount: response.step.cost.amount,
          currency: response.step.cost.currency,
          evidenceRef: prospectProviderAccountingEvidenceRef({
            ledgerId: ledger.id,
            responseHash: ledger.responseHash,
            accountingEvidenceHash: evidenceHash
          }),
          evidenceHash,
          estimationMethodVersion:
            response.step.cost.kind === "estimated"
              ? "fake-provider-estimate-v1"
              : "",
          createdAt: now
        };
        this.store.prospectProviderRequestAccountingEvidence.push(
          accountingEvidence
        );
        attempt.responseHash = ledger.responseHash;
        attempt.usageJson = accountingEvidence.usageJson;
        attempt.costKind = response.step.cost.kind;
        attempt.costAmount = response.step.cost.amount;
        attempt.currency = response.step.cost.currency;
        attempt.finishedAt = now;
        attempt.retryAfterAt = "";
        attempt.version += 1;

        let kind: SettlePersistedProviderResponseResult["kind"];
        let page: ProspectExecutionPage | undefined;
        let retryScheduled = false;
        let retryAfterAt = "";
        if (lateSettlement) {
          kind = "cancelled_late";
          attempt.status = "cancelled_late";
          attempt.errorCode = response.step.kind === "failure"
            ? response.step.errorCode.slice(0, 80)
            : "CANCELLED_BY_USER";
          attempt.errorMessage = response.step.kind === "failure"
            ? response.step.errorMessage.slice(0, 500)
            : "运行已终止，迟到响应仅保留审计与成本事实";
          attempt.retryable = false;
          if (run.status === "cancel_requested") {
            shard.status = "cancelled";
            shard.updatedAt = now;
            job.status = "cancelled";
            job.nextAttemptAt = "";
            job.finishedAt = now;
            job.errorCode = "CANCELLED_BY_USER";
            job.errorMessage = "任务已由用户取消";
            this.finishRunIfTerminal(run, now);
          }
        } else if (response.step.kind === "success") {
          kind = "success";
          attempt.status = "succeeded";
          attempt.errorCode = "";
          attempt.errorMessage = "";
          attempt.retryable = false;
          const remaining = Math.max(
            0,
            shard.resultLimit - checkpoint.acceptedCount
          );
          const acceptedCount = Math.min(
            remaining,
            Math.trunc(response.step.acceptedCount)
          );
          const partial = response.step.partial
            || acceptedCount !== response.step.acceptedCount;
          page = {
            id: `pexpg_${randomUUID()}`,
            teamId: run.teamId,
            ownerId: run.ownerId,
            runId: run.id,
            shardId: shard.id,
            jobId: job.id,
            attemptId: attempt.id,
            providerCode: shard.providerCode,
            checkpointNo: attempt.checkpointNo,
            pageSequence: checkpoint.pageSequence + 1,
            payloadHash: ledger.responseHash,
            acceptedCount,
            rawCount: Math.trunc(response.step.rawCount),
            invalidCount: Math.trunc(response.step.invalidCount),
            duplicateCount: Math.trunc(response.step.duplicateCount),
            partial,
            createdAt: now
          };
          this.store.prospectExecutionPages.push(page);
          checkpoint.pageSequence = page.pageSequence;
          checkpoint.acceptedCount += page.acceptedCount;
          checkpoint.rawCount += page.rawCount;
          checkpoint.invalidCount += page.invalidCount;
          checkpoint.duplicateCount += page.duplicateCount;
          checkpoint.partial ||= page.partial;
          checkpoint.lastErrorCode = "";
          checkpoint.lastErrorMessage = "";
          checkpoint.retryAfterAt = "";
          const reachedLimit = checkpoint.pageSequence >= shard.pageLimit
            || checkpoint.acceptedCount >= shard.resultLimit;
          const naturalEnd = !response.step.hasMore || reachedLimit;
          if (!naturalEnd) {
            const nextCheckpointNo = checkpoint.checkpointNo + 1;
            const encryptedCursor = this.encryptCursor(
              response.step.cursor,
              {
                teamId: run.teamId,
                runId: run.id,
                shardId: shard.id,
                providerCode: shard.providerCode,
                runEpoch: run.executionEpoch,
                checkpointNo: nextCheckpointNo
              }
            );
            checkpoint.checkpointNo = nextCheckpointNo;
            checkpoint.checkpointCallCount = 0;
            checkpoint.encryptedCursor = encryptedCursor.encrypted;
            checkpoint.cursorHash = encryptedCursor.hash;
          } else {
            checkpoint.encryptedCursor = "";
            checkpoint.cursorHash = "";
            checkpoint.completionReason = reachedLimit
              ? "SEARCH_LIMIT_REACHED"
              : "PROVIDER_EXHAUSTED";
          }
          checkpoint.updatedAt = now;
          checkpoint.version += 1;
          appendExecutionEvent(this.store, {
            teamId: run.teamId,
            ownerId: run.ownerId,
            runId: run.id,
            shardId: shard.id,
            jobId: job.id,
            eventType: "page_accepted",
            kernelEpoch: this.kernelEpoch,
            runEpoch: run.executionEpoch,
            fenceToken: ledger.fenceTokenAtPrepare,
            detail: {
              pageSequence: page.pageSequence,
              acceptedCount: page.acceptedCount,
              rawCount: page.rawCount,
              payloadHash: page.payloadHash,
              partial: page.partial
            },
            createdAt: now
          });
          if (naturalEnd) {
            const status = checkpoint.partial
              ? "partial_success"
              : checkpoint.acceptedCount > 0
                ? "succeeded"
                : "succeeded_empty";
            this.finishShardAfterPersistedResponse({
              run,
              shard,
              job,
              checkpointAcceptedCount: checkpoint.acceptedCount,
              fenceToken: ledger.fenceTokenAtPrepare,
              now,
              status
            });
            this.settlePauseIfReady(run, now);
          } else if (run.status === "pause_requested") {
            shard.status = "paused";
            shard.updatedAt = now;
            job.status = "queued";
            job.nextAttemptAt = "";
            this.settlePauseIfReady(run, now);
          } else {
            shard.status = "queued";
            shard.updatedAt = now;
            job.status = "queued";
            job.nextAttemptAt = "";
          }
        } else {
          kind = "failure";
          attempt.status = "failed";
          attempt.errorCode = response.step.errorCode.slice(0, 80);
          attempt.errorMessage = response.step.errorMessage.slice(0, 500);
          attempt.retryable = response.step.retryable;
          const exhausted = checkpoint.checkpointCallCount >= 3;
          if (response.step.retryable && !exhausted) {
            const providerRetryAt = response.step.retryAfterAt
              && validIso(response.step.retryAfterAt) > validIso(now)
              ? response.step.retryAfterAt
              : "";
            retryAfterAt = providerRetryAt || this.fallbackRetryAt({
              runId: run.id,
              shardId: shard.id,
              checkpointNo: checkpoint.checkpointNo,
              checkpointCallNo: checkpoint.checkpointCallCount,
              now
            });
            retryScheduled = true;
            attempt.retryAfterAt = retryAfterAt;
            checkpoint.retryAfterAt = retryAfterAt;
            checkpoint.lastErrorCode = attempt.errorCode;
            checkpoint.lastErrorMessage = attempt.errorMessage;
            checkpoint.updatedAt = now;
            checkpoint.version += 1;
            job.status = "retry_scheduled";
            job.nextAttemptAt = retryAfterAt;
            job.finishedAt = "";
            job.errorCode = attempt.errorCode;
            job.errorMessage = attempt.errorMessage;
            shard.status = run.status === "pause_requested"
              ? "paused"
              : "retry_scheduled";
            shard.updatedAt = now;
            appendExecutionEvent(this.store, {
              teamId: run.teamId,
              ownerId: run.ownerId,
              runId: run.id,
              shardId: shard.id,
              jobId: job.id,
              eventType: "retry_scheduled",
              kernelEpoch: this.kernelEpoch,
              runEpoch: run.executionEpoch,
              fenceToken: ledger.fenceTokenAtPrepare,
              detail: {
                checkpointNo: checkpoint.checkpointNo,
                checkpointCallNo: checkpoint.checkpointCallCount,
                retryAfterAt,
                errorCode: attempt.errorCode
              },
              createdAt: now
            });
            this.settlePauseIfReady(run, now);
          } else {
            checkpoint.lastErrorCode = attempt.errorCode;
            checkpoint.lastErrorMessage = attempt.errorMessage;
            checkpoint.retryAfterAt = "";
            checkpoint.partial = checkpoint.acceptedCount > 0;
            checkpoint.completionReason = exhausted
              ? "CHECKPOINT_ATTEMPTS_EXHAUSTED"
              : "NON_RETRYABLE_FAILURE";
            checkpoint.updatedAt = now;
            checkpoint.version += 1;
            const status = checkpoint.acceptedCount > 0
              ? "partial_success"
              : "failed";
            this.finishShardAfterPersistedResponse({
              run,
              shard,
              job,
              checkpointAcceptedCount: checkpoint.acceptedCount,
              fenceToken: ledger.fenceTokenAtPrepare,
              now,
              status,
              errorCode: attempt.errorCode,
              errorMessage: attempt.errorMessage
            });
            this.settlePauseIfReady(run, now);
          }
        }

        const previousStatus = ledger.status;
        const settlementAt = now;
        ledger.status = kind === "cancelled_late"
          ? "cancelled_late"
          : "settled";
        ledger.settlementKind = kind;
        ledger.errorCode = kind === "success"
          ? ""
          : attempt.errorCode;
        ledger.settledAt = kind === "cancelled_late" ? "" : settlementAt;
        ledger.cancelledLateAt =
          kind === "cancelled_late" ? settlementAt : "";
        ledger.updatedAt = settlementAt;
        ledger.version += 1;
        ledger.settlementHash = prospectProviderSettlementHash({
          contractVersion: ledger.contractVersion,
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          runId: ledger.runId,
          ledgerId: ledger.id,
          requestHash: ledger.requestHash,
          idempotencyKey: ledger.idempotencyKey,
          externalRequestId: ledger.externalRequestId,
          responseHash: ledger.responseHash,
          dispatchId: dispatch.id,
          attemptId: attempt.id,
          settlementKind: kind,
          settlementAt,
          attempt,
          accountingEvidence,
          page: page || null
        });
        this.store.prospectProviderRequestEvents.push({
          id: `ppre_${randomUUID()}`,
          ledgerId: ledger.id,
          dispatchId: dispatch.id,
          attemptId: attempt.id,
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          sequence: ledger.version,
          eventType: ledger.status,
          fromStatus: previousStatus,
          toStatus: ledger.status,
          detailHash: ledger.settlementHash,
          createdAt: settlementAt
        });
        const rawBatch = page
          ? this.appendSettledProviderRawFacts({
              ledger,
              attempt,
              page,
              response,
              requireExisting: false
            })
          : undefined;
        if (kind === "success" && page) {
          if (response.step.kind !== "success") {
            throw new ProspectExecutionKernelError(
              "EXECUTION_PROVIDER_SETTLEMENT_CONFLICT",
              "Provider 成功结算与响应结果不一致"
            );
          }
          this.upsertSourcePosition({
            run,
            shard,
            page,
            connectionId: ledger.connectionId,
            cursor: response.step.cursor,
            hasMore: response.step.hasMore,
            now: settlementAt
          });
        }
        return {
          value: {
            kind,
            idempotent: false,
            ledger: structuredClone(ledger),
            attempt: structuredClone(attempt),
            accountingEvidence: structuredClone(accountingEvidence),
            ...(page ? { page: structuredClone(page) } : {}),
            ...(rawBatch ? { rawBatch } : {}),
            retryScheduled,
            retryAfterAt,
            runStatus: run.status,
            shardStatus: shard.status
          },
          rollback: () => restore(this.store, before)
        };
      }
    );
  }

  async persistSettledProviderRawBatch(input: {
    teamId: string;
    ownerId: string;
    runId: string;
    ledgerId: string;
    expectedResponseHash: string;
    expectedSettlementHash: string;
  }): Promise<AppendProspectSourceRawBatchResult> {
    this.assertStarted();
    await this.store.readBarrier();
    const run = this.store.prospectSearchRuns.find((item) =>
      item.id === input.runId
      && item.teamId === input.teamId
      && item.ownerId === input.ownerId
      && this.isRunAllowed(item.id)
    );
    const ledger = run
      ? this.store.prospectProviderRequestLedgers.find((item) =>
          item.id === input.ledgerId
          && item.teamId === input.teamId
          && item.ownerId === input.ownerId
          && item.runId === input.runId
        )
      : null;
    if (!run || !ledger) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RAW_SCOPE_INVALID",
        "Provider 原始批次不在当前团队、业务员或运行作用域内"
      );
    }
    if (!/^[a-f0-9]{64}$/.test(input.expectedResponseHash)
      || !/^[a-f0-9]{64}$/.test(input.expectedSettlementHash)
      || ledger.responseHash !== input.expectedResponseHash
      || ledger.settlementHash !== input.expectedSettlementHash) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RAW_CONFLICT",
        "Provider 原始批次摘要与持久化响应或结算不一致"
      );
    }
    const dispatches =
      this.store.prospectProviderRequestDispatches.filter((item) =>
        item.ledgerId === ledger.id
        && item.teamId === ledger.teamId
        && item.ownerId === ledger.ownerId
        && item.runId === ledger.runId
        && item.shardId === ledger.shardId
        && item.status === "response_received"
      );
    const dispatch = dispatches.length === 1 ? dispatches[0] : null;
    const attempt = dispatch
      ? this.store.prospectExecutionAttempts.find((item) =>
          item.id === dispatch.attemptId
          && item.teamId === ledger.teamId
          && item.ownerId === ledger.ownerId
          && item.runId === ledger.runId
          && item.shardId === ledger.shardId
          && item.jobId === ledger.jobId
          && item.providerCode === ledger.providerCode
        )
      : null;
    const pages = attempt
      ? this.store.prospectExecutionPages.filter((item) =>
          item.attemptId === attempt.id
          && item.teamId === ledger.teamId
          && item.ownerId === ledger.ownerId
          && item.runId === ledger.runId
          && item.shardId === ledger.shardId
        )
      : [];
    const accountingEvidenceRows =
      this.store.prospectProviderRequestAccountingEvidence.filter((item) =>
        item.ledgerId === ledger.id
        && item.teamId === ledger.teamId
        && item.ownerId === ledger.ownerId
      );
    const page = pages.length === 1 ? pages[0] : null;
    const accountingEvidence = accountingEvidenceRows.length === 1
      ? accountingEvidenceRows[0]
      : null;
    if (!dispatch
      || !attempt
      || !page
      || !accountingEvidence
      || ledger.status !== "settled"
      || ledger.settlementKind !== "success"
      || attempt.status !== "succeeded"
      || page.payloadHash !== ledger.responseHash
      || !ledger.settledAt
      || ledger.settlementHash !== prospectProviderSettlementHash({
        contractVersion: ledger.contractVersion,
        teamId: ledger.teamId,
        ownerId: ledger.ownerId,
        runId: ledger.runId,
        ledgerId: ledger.id,
        requestHash: ledger.requestHash,
        idempotencyKey: ledger.idempotencyKey,
        externalRequestId: ledger.externalRequestId,
        responseHash: ledger.responseHash,
        dispatchId: dispatch.id,
        attemptId: attempt.id,
        settlementKind: "success",
        settlementAt: ledger.settledAt,
        attempt,
        accountingEvidence,
        page
      })) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RAW_STATE_INVALID",
        "Provider 原始批次引用的成功结算事实不完整或已被篡改"
      );
    }
    const response = this.verifiedProviderResponse(ledger, dispatch);
    const result = this.appendSettledProviderRawFacts({
      ledger,
      attempt,
      page,
      response,
      requireExisting: true
    });
    if (!result) {
      throw new ProspectExecutionKernelError(
        "EXECUTION_PROVIDER_RAW_UNAVAILABLE",
        "该 Provider 成功响应未声明逐条原始记录合同"
      );
    }
    return result;
  }

  async beginRequest(input: {
    leaseId: string;
    claimToken: string;
    now?: string;
  }) {
    this.assertStarted();
    const now = input.now || new Date().toISOString();
    validIso(now);
    return persistMutation<BeginRequestResult>(this.store, () => {
      const before = snapshot(this.store);
      const scope = this.activeLease({
        leaseId: input.leaseId,
        claimToken: input.claimToken,
        now
      });
      if (scope.run.status === "pause_requested"
        || scope.shard.status === "pause_requested") {
        throw new ProspectExecutionKernelError(
          "EXECUTION_REQUEST_BLOCKED_BY_PAUSE",
          "暂停请求已生效，不能再发起新的 Provider 请求"
        );
      }
      if (scope.attempt.status !== "claimed"
        || scope.lease.requestStartedAt) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_REQUEST_ALREADY_STARTED",
          "当前租约已经开始或完成 Provider 请求"
        );
      }
      if (scope.checkpoint.checkpointCallCount >= 3) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_CHECKPOINT_ATTEMPTS_EXHAUSTED",
          "当前 checkpoint 的三次总调用已耗尽"
        );
      }
      const connectionId = `fake:${scope.shard.providerCode}`;
      const throttleId = createHash("sha256").update([
        scope.run.teamId,
        scope.shard.providerCode,
        connectionId
      ].join("\u001f")).digest("hex");
      let throttle = this.store.prospectExecutionThrottleBuckets.find(
        (item) =>
          item.id === throttleId
          && item.teamId === scope.run.teamId
          && item.providerCode === scope.shard.providerCode
          && item.connectionId === connectionId
      );
      if (!throttle) {
        throttle = {
          id: throttleId,
          teamId: scope.run.teamId,
          providerCode: scope.shard.providerCode,
          connectionId,
          availableAt: now,
          version: 1,
          updatedAt: now
        };
        this.store.prospectExecutionThrottleBuckets.push(throttle);
      }
      if (validIso(throttle.availableAt) > validIso(now)) {
        scope.attempt.status = "failed";
        scope.attempt.errorCode = "PROVIDER_THROTTLE_DEFERRED";
        scope.attempt.errorMessage = "Provider 调用窗口尚未开放";
        scope.attempt.retryable = true;
        scope.attempt.retryAfterAt = throttle.availableAt;
        scope.attempt.finishedAt = now;
        scope.attempt.version += 1;
        scope.checkpoint.retryAfterAt = throttle.availableAt;
        scope.checkpoint.updatedAt = now;
        scope.checkpoint.version += 1;
        scope.job.status = "retry_scheduled";
        scope.job.nextAttemptAt = throttle.availableAt;
        scope.job.errorCode = scope.attempt.errorCode;
        scope.job.errorMessage = scope.attempt.errorMessage;
        scope.shard.status = "retry_scheduled";
        scope.shard.updatedAt = now;
        this.releaseLease(scope.lease, now, "PROVIDER_THROTTLE_DEFERRED");
        return {
          value: {
            ready: false as const,
            retryAfterAt: throttle.availableAt
          },
          rollback: () => restore(this.store, before)
        };
      }
      throttle.availableAt = plusMilliseconds(
        now,
        this.throttleIntervalMs
      );
      throttle.version += 1;
      throttle.updatedAt = now;
      scope.checkpoint.checkpointCallCount += 1;
      scope.checkpoint.totalCallCount += 1;
      scope.checkpoint.retryAfterAt = "";
      scope.checkpoint.updatedAt = now;
      scope.checkpoint.version += 1;
      scope.job.attemptCount += 1;
      const requestHash = detailHash({
        executionSnapshotHash: scope.run.executionSnapshotHash,
        providerCode: scope.shard.providerCode,
        checkpointNo: scope.checkpoint.checkpointNo,
        checkpointCallNo: scope.checkpoint.checkpointCallCount,
        cursorHash: scope.checkpoint.cursorHash,
        runEpoch: scope.run.executionEpoch
      });
      scope.attempt.status = "request_started";
      scope.attempt.checkpointNo = scope.checkpoint.checkpointNo;
      scope.attempt.checkpointCallNo =
        scope.checkpoint.checkpointCallCount;
      scope.attempt.providerAttemptNo = scope.job.attemptCount;
      scope.attempt.requestHash = requestHash;
      scope.attempt.startedAt = now;
      scope.lease.requestStartedAt = now;
      scope.attempt.version += 1;
      scope.lease.version += 1;
      appendExecutionEvent(this.store, {
        teamId: scope.run.teamId,
        ownerId: scope.run.ownerId,
        runId: scope.run.id,
        shardId: scope.shard.id,
        jobId: scope.job.id,
        eventType: "request_started",
        kernelEpoch: scope.lease.kernelEpoch,
        runEpoch: scope.lease.runEpoch,
        fenceToken: scope.lease.fenceToken,
        detail: {
          checkpointNo: scope.attempt.checkpointNo,
          checkpointCallNo: scope.attempt.checkpointCallNo,
          providerAttemptNo: scope.attempt.providerAttemptNo,
          requestHash
        },
        createdAt: now
      });
      const cursor = this.decryptCursor(
        scope.checkpoint.encryptedCursor,
        scope.checkpoint.cursorHash,
        {
          teamId: scope.run.teamId,
          runId: scope.run.id,
          shardId: scope.shard.id,
          providerCode: scope.shard.providerCode,
          runEpoch: scope.run.executionEpoch,
          checkpointNo: scope.checkpoint.checkpointNo
        }
      );
      return {
        value: {
          ready: true as const,
          request: {
            runId: scope.run.id,
            shardId: scope.shard.id,
            providerCode: scope.shard.providerCode,
            checkpointNo: scope.attempt.checkpointNo,
            checkpointCallNo: scope.attempt.checkpointCallNo,
            cursor,
            requestHash
          },
          attempt: structuredClone(scope.attempt)
        },
        rollback: () => restore(this.store, before)
      };
    });
  }

  async completePage(input: {
    leaseId: string;
    claimToken: string;
    result: FakeProspectProviderSuccess;
    responseHash: string;
    now?: string;
  }) {
    this.assertStarted();
    const now = input.now || new Date().toISOString();
    validIso(now);
    return persistMutation<CompletePageResult>(this.store, () => {
      const before = snapshot(this.store);
      const scope = this.activeLease({
        leaseId: input.leaseId,
        claimToken: input.claimToken,
        now,
        allowCancelledEpoch: true
      });
      if (scope.attempt.status !== "request_started") {
        throw new ProspectExecutionKernelError(
          "EXECUTION_REQUEST_NOT_STARTED",
          "Provider 请求尚未开始或已经结算"
        );
      }
      scope.attempt.responseHash = input.responseHash;
      scope.attempt.usageJson = canonicalJsonStringify(input.result.usage);
      scope.attempt.costKind = input.result.cost.kind;
      scope.attempt.costAmount = input.result.cost.amount;
      scope.attempt.currency = input.result.cost.currency;
      scope.attempt.finishedAt = now;
      scope.attempt.version += 1;
      if (scope.cancelledEpoch) {
        scope.attempt.status = "cancelled_late";
        scope.attempt.errorCode = "CANCELLED_BY_USER";
        scope.attempt.errorMessage = "取消已生效，迟到响应仅保留审计事实";
        scope.job.status = "cancelled";
        scope.job.nextAttemptAt = "";
        scope.job.finishedAt = now;
        scope.job.errorCode = "CANCELLED_BY_USER";
        scope.job.errorMessage = "任务已由用户取消";
        scope.shard.status = "cancelled";
        scope.shard.updatedAt = now;
        this.releaseLease(scope.lease, now, "CANCELLED_LATE_RESPONSE");
        this.finishRunIfTerminal(scope.run, now);
        return {
          value: {
            accepted: false,
            lateCancellation: true,
            runStatus: scope.run.status,
            shardStatus: scope.shard.status
          },
          rollback: () => restore(this.store, before)
        };
      }

      const remaining = Math.max(
        0,
        scope.shard.resultLimit - scope.checkpoint.acceptedCount
      );
      const acceptedCount = Math.min(
        remaining,
        Math.trunc(input.result.acceptedCount)
      );
      const partial = input.result.partial
        || acceptedCount !== input.result.acceptedCount;
      scope.attempt.status = "succeeded";
      const page: ProspectExecutionPage = {
        id: `pexpg_${randomUUID()}`,
        teamId: scope.run.teamId,
        ownerId: scope.run.ownerId,
        runId: scope.run.id,
        shardId: scope.shard.id,
        jobId: scope.job.id,
        attemptId: scope.attempt.id,
        providerCode: scope.shard.providerCode,
        checkpointNo: scope.attempt.checkpointNo,
        pageSequence: scope.checkpoint.pageSequence + 1,
        payloadHash: input.responseHash,
        acceptedCount,
        rawCount: Math.trunc(input.result.rawCount),
        invalidCount: Math.trunc(input.result.invalidCount),
        duplicateCount: Math.trunc(input.result.duplicateCount),
        partial,
        createdAt: now
      };
      this.store.prospectExecutionPages.push(page);
      scope.checkpoint.pageSequence = page.pageSequence;
      scope.checkpoint.acceptedCount += page.acceptedCount;
      scope.checkpoint.rawCount += page.rawCount;
      scope.checkpoint.invalidCount += page.invalidCount;
      scope.checkpoint.duplicateCount += page.duplicateCount;
      scope.checkpoint.partial ||= page.partial;
      scope.checkpoint.lastErrorCode = "";
      scope.checkpoint.lastErrorMessage = "";
      scope.checkpoint.retryAfterAt = "";
      const reachedLimit = scope.checkpoint.pageSequence
          >= scope.shard.pageLimit
        || scope.checkpoint.acceptedCount >= scope.shard.resultLimit;
      const naturalEnd = !input.result.hasMore || reachedLimit;
      if (!naturalEnd) {
        const nextCheckpointNo = scope.checkpoint.checkpointNo + 1;
        const encryptedCursor = this.encryptCursor(
          input.result.cursor,
          {
            teamId: scope.run.teamId,
            runId: scope.run.id,
            shardId: scope.shard.id,
            providerCode: scope.shard.providerCode,
            runEpoch: scope.run.executionEpoch,
            checkpointNo: nextCheckpointNo
          }
        );
        scope.checkpoint.checkpointNo = nextCheckpointNo;
        scope.checkpoint.checkpointCallCount = 0;
        scope.checkpoint.encryptedCursor = encryptedCursor.encrypted;
        scope.checkpoint.cursorHash = encryptedCursor.hash;
      } else {
        scope.checkpoint.encryptedCursor = "";
        scope.checkpoint.cursorHash = "";
        scope.checkpoint.completionReason = reachedLimit
          ? "SEARCH_LIMIT_REACHED"
          : "PROVIDER_EXHAUSTED";
      }
      scope.checkpoint.updatedAt = now;
      scope.checkpoint.version += 1;
      appendExecutionEvent(this.store, {
        teamId: scope.run.teamId,
        ownerId: scope.run.ownerId,
        runId: scope.run.id,
        shardId: scope.shard.id,
        jobId: scope.job.id,
        eventType: "page_accepted",
        kernelEpoch: scope.lease.kernelEpoch,
        runEpoch: scope.lease.runEpoch,
        fenceToken: scope.lease.fenceToken,
        detail: {
          pageSequence: page.pageSequence,
          acceptedCount: page.acceptedCount,
          rawCount: page.rawCount,
          payloadHash: page.payloadHash,
          partial: page.partial
        },
        createdAt: now
      });
      if (naturalEnd) {
        const status = scope.checkpoint.partial
          ? "partial_success"
          : scope.checkpoint.acceptedCount > 0
            ? "succeeded"
            : "succeeded_empty";
        this.finishShard({
          run: scope.run,
          shard: scope.shard,
          job: scope.job,
          lease: scope.lease,
          checkpointAcceptedCount: scope.checkpoint.acceptedCount,
          now,
          status
        });
        this.settlePauseIfReady(scope.run, now);
      } else if (scope.run.status === "pause_requested") {
        scope.shard.status = "paused";
        scope.shard.updatedAt = now;
        scope.job.status = "queued";
        scope.job.nextAttemptAt = "";
        this.releaseLease(scope.lease, now, "PAUSED_AFTER_PAGE");
        this.settlePauseIfReady(scope.run, now);
      } else {
        scope.shard.status = "queued";
        scope.shard.updatedAt = now;
        scope.job.status = "queued";
        scope.job.nextAttemptAt = "";
        this.releaseLease(scope.lease, now, "PAGE_ACCEPTED");
      }
      this.upsertSourcePosition({
        run: scope.run,
        shard: scope.shard,
        page,
        connectionId: this.providerConnectionId({
          teamId: scope.run.teamId,
          ownerId: scope.run.ownerId,
          providerCode: scope.shard.providerCode
        }),
        cursor: input.result.cursor,
        hasMore: input.result.hasMore,
        now
      });
      return {
        value: {
          accepted: true,
          lateCancellation: false,
          page: structuredClone(page),
          runStatus: scope.run.status,
          shardStatus: scope.shard.status
        },
        rollback: () => restore(this.store, before)
      };
    });
  }

  async failRequest(input: {
    leaseId: string;
    claimToken: string;
    result: FakeProspectProviderFailure;
    responseHash: string;
    now?: string;
  }) {
    this.assertStarted();
    const now = input.now || new Date().toISOString();
    validIso(now);
    return persistMutation<FailRequestResult>(this.store, () => {
      const before = snapshot(this.store);
      const scope = this.activeLease({
        leaseId: input.leaseId,
        claimToken: input.claimToken,
        now,
        allowCancelledEpoch: true
      });
      if (scope.attempt.status !== "request_started") {
        throw new ProspectExecutionKernelError(
          "EXECUTION_REQUEST_NOT_STARTED",
          "Provider 请求尚未开始或已经结算"
        );
      }
      scope.attempt.responseHash = input.responseHash;
      scope.attempt.usageJson = canonicalJsonStringify(input.result.usage);
      scope.attempt.costKind = input.result.cost.kind;
      scope.attempt.costAmount = input.result.cost.amount;
      scope.attempt.currency = input.result.cost.currency;
      scope.attempt.finishedAt = now;
      scope.attempt.version += 1;
      if (scope.cancelledEpoch) {
        scope.attempt.status = "cancelled_late";
        scope.attempt.errorCode = input.result.errorCode;
        scope.attempt.errorMessage = input.result.errorMessage;
        scope.attempt.retryable = false;
        scope.job.status = "cancelled";
        scope.job.nextAttemptAt = "";
        scope.job.finishedAt = now;
        scope.job.errorCode = "CANCELLED_BY_USER";
        scope.job.errorMessage = "任务已由用户取消";
        scope.shard.status = "cancelled";
        scope.shard.updatedAt = now;
        this.releaseLease(scope.lease, now, "CANCELLED_LATE_FAILURE");
        this.finishRunIfTerminal(scope.run, now);
        return {
          value: {
            retryScheduled: false,
            lateCancellation: true,
            runStatus: scope.run.status,
            shardStatus: scope.shard.status
          },
          rollback: () => restore(this.store, before)
        };
      }
      scope.attempt.status = "failed";
      scope.attempt.errorCode = input.result.errorCode.slice(0, 80);
      scope.attempt.errorMessage = input.result.errorMessage.slice(0, 500);
      scope.attempt.retryable = input.result.retryable;
      const exhausted = scope.checkpoint.checkpointCallCount >= 3;
      if (input.result.retryable && !exhausted) {
        const providerRetryAt = input.result.retryAfterAt
          && validIso(input.result.retryAfterAt) > validIso(now)
          ? input.result.retryAfterAt
          : "";
        const retryAfterAt = providerRetryAt || this.fallbackRetryAt({
          runId: scope.run.id,
          shardId: scope.shard.id,
          checkpointNo: scope.checkpoint.checkpointNo,
          checkpointCallNo: scope.checkpoint.checkpointCallCount,
          now
        });
        scope.attempt.retryAfterAt = retryAfterAt;
        scope.checkpoint.retryAfterAt = retryAfterAt;
        scope.checkpoint.lastErrorCode = scope.attempt.errorCode;
        scope.checkpoint.lastErrorMessage = scope.attempt.errorMessage;
        scope.checkpoint.updatedAt = now;
        scope.checkpoint.version += 1;
        scope.job.status = "retry_scheduled";
        scope.job.nextAttemptAt = retryAfterAt;
        scope.job.finishedAt = "";
        scope.job.errorCode = scope.attempt.errorCode;
        scope.job.errorMessage = scope.attempt.errorMessage;
        scope.shard.status = scope.run.status === "pause_requested"
          ? "paused"
          : "retry_scheduled";
        scope.shard.updatedAt = now;
        this.releaseLease(scope.lease, now, "RETRY_SCHEDULED");
        appendExecutionEvent(this.store, {
          teamId: scope.run.teamId,
          ownerId: scope.run.ownerId,
          runId: scope.run.id,
          shardId: scope.shard.id,
          jobId: scope.job.id,
          eventType: "retry_scheduled",
          kernelEpoch: scope.lease.kernelEpoch,
          runEpoch: scope.lease.runEpoch,
          fenceToken: scope.lease.fenceToken,
          detail: {
            checkpointNo: scope.checkpoint.checkpointNo,
            checkpointCallNo: scope.checkpoint.checkpointCallCount,
            retryAfterAt,
            errorCode: scope.attempt.errorCode
          },
          createdAt: now
        });
        this.settlePauseIfReady(scope.run, now);
        return {
          value: {
            retryScheduled: true,
            lateCancellation: false,
            retryAfterAt,
            runStatus: scope.run.status,
            shardStatus: scope.shard.status
          },
          rollback: () => restore(this.store, before)
        };
      }
      scope.checkpoint.lastErrorCode = scope.attempt.errorCode;
      scope.checkpoint.lastErrorMessage = scope.attempt.errorMessage;
      scope.checkpoint.retryAfterAt = "";
      scope.checkpoint.partial = scope.checkpoint.acceptedCount > 0;
      scope.checkpoint.completionReason = exhausted
        ? "CHECKPOINT_ATTEMPTS_EXHAUSTED"
        : "NON_RETRYABLE_FAILURE";
      scope.checkpoint.updatedAt = now;
      scope.checkpoint.version += 1;
      const status = scope.checkpoint.acceptedCount > 0
        ? "partial_success"
        : "failed";
      this.finishShard({
        run: scope.run,
        shard: scope.shard,
        job: scope.job,
        lease: scope.lease,
        checkpointAcceptedCount: scope.checkpoint.acceptedCount,
        now,
        status,
        errorCode: scope.attempt.errorCode,
        errorMessage: scope.attempt.errorMessage
      });
      this.settlePauseIfReady(scope.run, now);
      return {
        value: {
          retryScheduled: false,
          lateCancellation: false,
          retryAfterAt: "",
          runStatus: scope.run.status,
          shardStatus: scope.shard.status
        },
        rollback: () => restore(this.store, before)
      };
    });
  }

  async requestPause(
    runId: string,
    now = new Date().toISOString()
  ) {
    this.assertStarted();
    validIso(now);
    return persistMutation(this.store, () => {
      const before = snapshot(this.store);
      const run = this.store.prospectSearchRuns.find((item) =>
        item.id === runId && this.isRunAllowed(item.id)
      );
      if (!run || (run.status !== "queued" && run.status !== "running")) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_PAUSE_STATE_INVALID",
          "当前搜索运行状态不能暂停"
        );
      }
      validateProspectRunQueueBridge(this.store, run);
      const activeLeases = this.store.prospectExecutionLeases.filter((item) =>
        item.teamId === run.teamId
        && item.runId === run.id
        && item.status === "active"
      );
      if (activeLeases.length > 1) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_ACTIVE_LEASE_CONFLICT",
          "同一搜索运行存在多个活动租约"
        );
      }
      const activeLease = activeLeases[0];
      const pendingResponseLedgers =
        this.store.prospectProviderRequestLedgers.filter((item) =>
          item.teamId === run.teamId
          && item.ownerId === run.ownerId
          && item.runId === run.id
          && item.status === "response_received"
        );
      if (pendingResponseLedgers.length > 1
        || (activeLease && pendingResponseLedgers.length)) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_PROVIDER_SETTLEMENT_CONFLICT",
          "同一搜索运行存在冲突的活动租约或待结算响应"
        );
      }
      const pendingResponseLedger = pendingResponseLedgers[0];
      const activeRequestInFlight = Boolean(activeLease?.requestStartedAt);
      const settlementOutstanding = Boolean(pendingResponseLedger);
      const requestInFlight =
        activeRequestInFlight || settlementOutstanding;
      if (activeLease && !activeRequestInFlight) {
        const attempt = this.store.prospectExecutionAttempts.find((item) =>
          item.teamId === activeLease.teamId
          && item.leaseId === activeLease.id
          && item.jobId === activeLease.jobId
        );
        if (!attempt || attempt.status !== "claimed") {
          throw new ProspectExecutionKernelError(
            "EXECUTION_ATTEMPT_SCOPE_INVALID",
            "暂停前的执行尝试状态或作用域无效"
          );
        }
        this.releaseLease(activeLease, now, "PAUSED_BEFORE_REQUEST");
        attempt.status = "failed";
        attempt.errorCode = "PAUSED_BEFORE_REQUEST";
        attempt.errorMessage = "Provider 请求尚未发出，租约已安全释放";
        attempt.retryable = true;
        attempt.finishedAt = now;
        attempt.version += 1;
        const activeJob = this.store.agentJobs.find((item) =>
          item.id === activeLease.jobId
          && item.teamId === activeLease.teamId
          && item.ownerId === activeLease.ownerId
        );
        if (!activeJob) {
          throw new ProspectExecutionKernelError(
            "EXECUTION_CHILD_JOB_MISSING",
            "暂停前的执行租约缺少子任务"
          );
        }
        activeJob.status = "queued";
        activeJob.startedAt = "";
        activeJob.nextAttemptAt = "";
        activeJob.finishedAt = "";
        activeJob.errorCode = "";
        activeJob.errorMessage = "";
      }
      const previousStatus = run.status;
      const previousRevision = run.revision;
      const activeShardId = requestInFlight
        ? pendingResponseLedger?.shardId || activeLease?.shardId || ""
        : "";
      for (const shard of this.store.prospectRunShards.filter((item) =>
        item.teamId === run.teamId && item.runId === run.id
      )) {
        if ([
          "cancelled",
          "succeeded",
          "succeeded_empty",
          "partial_success",
          "failed"
        ].includes(shard.status)) {
          continue;
        }
        if (shard.id === activeShardId) {
          shard.status = "pause_requested";
        } else {
          shard.status = "paused";
        }
        shard.updatedAt = now;
      }
      run.status = requestInFlight ? "pause_requested" : "paused";
      run.revision += 1;
      run.updatedAt = now;
      run.pausedAt = requestInFlight ? "" : now;
      appendRunTransitionEvent(this.store, {
        run,
        previousStatus,
        previousRevision,
        eventType: requestInFlight ? "pause_requested" : "paused",
        reason: requestInFlight
          ? "等待当前在途页结算后暂停"
          : "搜索运行已暂停",
        now
      });
      validateProspectRunQueueBridge(this.store, run);
      return {
        value: structuredClone(run),
        rollback: () => restore(this.store, before)
      };
    });
  }

  async resume(runId: string, now = new Date().toISOString()) {
    this.assertStarted();
    validIso(now);
    return persistMutation(this.store, () => {
      const before = snapshot(this.store);
      const run = this.store.prospectSearchRuns.find((item) =>
        item.id === runId && this.isRunAllowed(item.id)
      );
      if (!run || run.status !== "paused") {
        throw new ProspectExecutionKernelError(
          "EXECUTION_RESUME_STATE_INVALID",
          "只有完全暂停的搜索运行可以恢复"
        );
      }
      if (this.store.prospectExecutionLeases.some((item) =>
        item.teamId === run.teamId
        && item.runId === run.id
        && item.status === "active"
      )) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_RESUME_LEASE_ACTIVE",
          "存在活动租约时不能恢复搜索运行"
        );
      }
      validateProspectRunQueueBridge(this.store, run);
      const previousStatus = run.status;
      const previousRevision = run.revision;
      const previousExecutionEpoch = run.executionEpoch;
      run.status = "queued";
      run.revision += 1;
      run.executionEpoch += 1;
      run.updatedAt = now;
      run.pausedAt = "";
      for (const shard of this.store.prospectRunShards.filter((item) =>
        item.teamId === run.teamId
        && item.runId === run.id
        && item.status === "paused"
      )) {
        const checkpoint = this.store.prospectExecutionCheckpoints.find(
          (item) =>
            item.teamId === run.teamId
            && item.runId === run.id
            && item.shardId === shard.id
        );
        const job = this.childJob(run, shard);
        if (checkpoint?.encryptedCursor) {
          const cursor = this.decryptCursor(
            checkpoint.encryptedCursor,
            checkpoint.cursorHash,
            {
              teamId: run.teamId,
              runId: run.id,
              shardId: shard.id,
              providerCode: shard.providerCode,
              runEpoch: previousExecutionEpoch,
              checkpointNo: checkpoint.checkpointNo
            }
          );
          const encryptedCursor = this.encryptCursor(cursor, {
            teamId: run.teamId,
            runId: run.id,
            shardId: shard.id,
            providerCode: shard.providerCode,
            runEpoch: run.executionEpoch,
            checkpointNo: checkpoint.checkpointNo
          });
          checkpoint.encryptedCursor = encryptedCursor.encrypted;
          checkpoint.cursorHash = encryptedCursor.hash;
        }
        if (checkpoint) {
          checkpoint.runEpoch = run.executionEpoch;
          checkpoint.updatedAt = now;
          checkpoint.version += 1;
        }
        if (checkpoint?.retryAfterAt
          && validIso(checkpoint.retryAfterAt) > validIso(now)) {
          shard.status = "retry_scheduled";
          job.status = "retry_scheduled";
          job.nextAttemptAt = checkpoint.retryAfterAt;
        } else {
          shard.status = "queued";
          job.status = "queued";
          job.nextAttemptAt = "";
          if (checkpoint) checkpoint.retryAfterAt = "";
        }
        shard.updatedAt = now;
      }
      appendRunTransitionEvent(this.store, {
        run,
        previousStatus,
        previousRevision,
        eventType: "resumed",
        reason: "搜索运行已恢复，保留原 checkpoint 与重试时间",
        now
      });
      validateProspectRunQueueBridge(this.store, run);
      return {
        value: structuredClone(run),
        rollback: () => restore(this.store, before)
      };
    });
  }

  async requestCancel(
    runId: string,
    now = new Date().toISOString()
  ) {
    this.assertStarted();
    validIso(now);
    return persistMutation(this.store, () => {
      const before = snapshot(this.store);
      const run = this.store.prospectSearchRuns.find((item) =>
        item.id === runId && this.isRunAllowed(item.id)
      );
      if (!run || ![
        "queued",
        "running",
        "pause_requested",
        "paused"
      ].includes(run.status)) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_CANCEL_STATE_INVALID",
          "当前搜索运行状态不能取消"
        );
      }
      validateProspectRunQueueBridge(this.store, run);
      const activeLeases = this.store.prospectExecutionLeases.filter((item) =>
        item.teamId === run.teamId
        && item.runId === run.id
        && item.status === "active"
      );
      if (activeLeases.length > 1) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_ACTIVE_LEASE_CONFLICT",
          "同一搜索运行存在多个活动租约"
        );
      }
      const activeLease = activeLeases[0];
      const pendingResponseLedgers =
        this.store.prospectProviderRequestLedgers.filter((item) =>
          item.teamId === run.teamId
          && item.ownerId === run.ownerId
          && item.runId === run.id
          && item.status === "response_received"
        );
      if (pendingResponseLedgers.length > 1
        || (activeLease && pendingResponseLedgers.length)) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_PROVIDER_SETTLEMENT_CONFLICT",
          "同一搜索运行存在冲突的活动租约或待结算响应"
        );
      }
      const pendingResponseLedger = pendingResponseLedgers[0];
      const activeRequestInFlight = Boolean(activeLease?.requestStartedAt);
      const settlementOutstanding = Boolean(pendingResponseLedger);
      const requestInFlight =
        activeRequestInFlight || settlementOutstanding;
      if (!requestInFlight) {
        this.settlePreparedProviderRequestsBeforeDispatch(run, now);
      }
      if (activeLease && !activeRequestInFlight) {
        const attempt = this.store.prospectExecutionAttempts.find((item) =>
          item.teamId === activeLease.teamId
          && item.leaseId === activeLease.id
          && item.jobId === activeLease.jobId
        );
        if (!attempt || attempt.status !== "claimed") {
          throw new ProspectExecutionKernelError(
            "EXECUTION_ATTEMPT_SCOPE_INVALID",
            "取消前的执行尝试状态或作用域无效"
          );
        }
        this.releaseLease(activeLease, now, "CANCELLED_BEFORE_REQUEST");
        attempt.status = "failed";
        attempt.errorCode = "CANCELLED_BEFORE_REQUEST";
        attempt.errorMessage = "Provider 请求尚未发出，搜索运行已取消";
        attempt.retryable = false;
        attempt.finishedAt = now;
        attempt.version += 1;
      }
      const previousStatus = run.status;
      const previousRevision = run.revision;
      run.executionEpoch += 1;
      run.status = requestInFlight ? "cancel_requested" : "cancelled";
      run.revision += 1;
      run.updatedAt = now;
      run.cancelledAt = requestInFlight ? "" : now;
      const activeShardId = requestInFlight
        ? pendingResponseLedger?.shardId || activeLease?.shardId || ""
        : "";
      for (const shard of this.store.prospectRunShards.filter((item) =>
        item.teamId === run.teamId && item.runId === run.id
      )) {
        const job = this.childJob(run, shard);
        const checkpoint = this.store.prospectExecutionCheckpoints.find(
          (item) =>
            item.teamId === run.teamId
            && item.runId === run.id
            && item.shardId === shard.id
        );
        if (checkpoint && !checkpoint.completionReason) {
          checkpoint.encryptedCursor = "";
          checkpoint.cursorHash = "";
          checkpoint.retryAfterAt = "";
          checkpoint.lastErrorCode = "CANCELLED_BY_USER";
          checkpoint.lastErrorMessage = "搜索运行已由用户取消";
          checkpoint.completionReason = "CANCELLED_BY_USER";
          checkpoint.updatedAt = now;
          checkpoint.version += 1;
        }
        if (shard.id === activeShardId) {
          shard.status = "cancel_requested";
          shard.updatedAt = now;
          continue;
        }
        shard.status = "cancelled";
        shard.updatedAt = now;
        job.status = "cancelled";
        job.nextAttemptAt = "";
        job.finishedAt = now;
        job.errorCode = "CANCELLED_BY_USER";
        job.errorMessage = "任务已由用户取消";
      }
      if (requestInFlight) {
        appendRunTransitionEvent(this.store, {
          run,
          previousStatus,
          previousRevision,
          eventType: "cancel_requested",
          reason: "取消已生效，等待在途请求只记录审计事实",
          now
        });
      } else {
        const parent = this.parentJob(run);
        parent.status = "cancelled";
        parent.finishedAt = now;
        parent.errorCode = "CANCELLED_BY_USER";
        parent.errorMessage = "任务已由用户取消";
        appendRunTransitionEvent(this.store, {
          run,
          previousStatus,
          previousRevision,
          eventType: "cancelled",
          reason: "搜索运行已取消",
          now
        });
      }
      validateProspectRunQueueBridge(this.store, run);
      return {
        value: structuredClone(run),
        rollback: () => restore(this.store, before)
      };
    });
  }

  async executeNext(
    provider: {
      search(request: {
        runId: string;
        shardId: string;
        providerCode: string;
        checkpointNo: number;
        checkpointCallNo: number;
        cursor: string;
        requestHash: string;
      }): Promise<{
        step: FakeProspectProviderSuccess | FakeProspectProviderFailure;
        responseHash: string;
      }>;
    },
    now = new Date().toISOString()
  ) {
    const startedAtMonotonic = performance.now();
    const claim = await this.claimNext(now);
    if (!claim) return { kind: "idle" as const };
    const started = await this.beginRequest({
      leaseId: claim.lease.id,
      claimToken: claim.claimToken,
      now
    });
    if (!started.ready) {
      return {
        kind: "throttled" as const,
        retryAfterAt: started.retryAfterAt
      };
    }
    const response = await provider.search(started.request);
    const settlementNow = plusMilliseconds(
      now,
      Math.max(1, Math.ceil(performance.now() - startedAtMonotonic))
    );
    if (response.step.kind === "success") {
      return {
        kind: "success" as const,
        result: await this.completePage({
          leaseId: claim.lease.id,
          claimToken: claim.claimToken,
          result: response.step,
          responseHash: response.responseHash,
          now: settlementNow
        })
      };
    }
    return {
      kind: "failure" as const,
      result: await this.failRequest({
        leaseId: claim.lease.id,
        claimToken: claim.claimToken,
        result: response.step,
        responseHash: response.responseHash,
        now: settlementNow
      })
    };
  }

  async heartbeat(input: {
    leaseId: string;
    claimToken: string;
    now?: string;
  }) {
    this.assertStarted();
    const now = input.now || new Date().toISOString();
    const nowTime = validIso(now);
    return persistMutation(this.store, () => {
      const before = snapshot(this.store);
      const lease = this.store.prospectExecutionLeases.find((item) =>
        item.id === input.leaseId
      );
      if (!lease
        || lease.status !== "active"
        || !this.isRunAllowed(lease.runId)) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_LEASE_NOT_ACTIVE",
          "执行租约不存在、已失效或不在白名单内"
        );
      }
      this.assertClaimToken(lease, input.claimToken);
      const run = this.store.prospectSearchRuns.find((item) =>
        item.id === lease.runId
        && item.teamId === lease.teamId
        && item.ownerId === lease.ownerId
      );
      if (!run
        || lease.kernelEpoch !== this.kernelEpoch
        || lease.runEpoch !== run.executionEpoch
        || validIso(lease.expiresAt) <= nowTime
        || validIso(lease.deadlineAt) <= nowTime) {
        throw new ProspectExecutionKernelError(
          "EXECUTION_LEASE_FENCE_INVALID",
          "执行租约 epoch、fence 或有效期校验失败"
        );
      }
      lease.heartbeatAt = now;
      lease.expiresAt = new Date(Math.min(
        nowTime + this.leaseMs,
        validIso(lease.deadlineAt)
      )).toISOString();
      lease.version += 1;
      appendExecutionEvent(this.store, {
        teamId: lease.teamId,
        ownerId: lease.ownerId,
        runId: lease.runId,
        shardId: lease.shardId,
        jobId: lease.jobId,
        eventType: "lease_heartbeat",
        kernelEpoch: lease.kernelEpoch,
        runEpoch: lease.runEpoch,
        fenceToken: lease.fenceToken,
        detail: { expiresAt: lease.expiresAt },
        createdAt: now
      });
      return {
        value: structuredClone(lease),
        rollback: () => restore(this.store, before)
      };
    });
  }
}
