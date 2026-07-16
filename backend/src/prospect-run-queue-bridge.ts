import { createHash, randomUUID } from "node:crypto";
import { decryptAgentJobPayload } from "./agent-job-security.js";
import {
  cancelProspectRunBridgeJob,
  isProspectRunBridgeJob,
  PROSPECT_RUN_ORCHESTRATE_JOB_TYPE,
  PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE,
  prospectRunBridgeIdempotencyDigest,
  registerProspectRunBridgeJob
} from "./agent-jobs.js";
import type { CrmStore } from "./store.js";
import type {
  AgentJob,
  AgentJobStatus,
  ProspectRunQueueChildBinding,
  ProspectRunQueueParentBinding,
  ProspectRunShard,
  ProspectSearchRun
} from "./types.js";

export const PROSPECT_RUN_QUEUE_BRIDGE_VERSION = "v1";

const BRIDGE_AGGREGATE_TYPE = "prospect_search_run_queue_bridge_v1";
const ALLOWED_JOB_STATUSES = new Set<AgentJobStatus>([
  "queued",
  "running",
  "retry_scheduled",
  "succeeded",
  "failed",
  "cancelled",
  "dead_letter"
]);
const TRACE_ID_PATTERN =
  /^trace_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProspectRunQueueBridgeIntegrityError extends Error {
  readonly code = "RUN_QUEUE_BRIDGE_INTEGRITY_INVALID";
  readonly runId: string;

  constructor(runId: string, message: string) {
    super(message);
    this.name = "ProspectRunQueueBridgeIntegrityError";
    this.runId = runId;
  }
}

function fail(runId: string, message: string): never {
  throw new ProspectRunQueueBridgeIntegrityError(runId, message);
}

function bindingHash(input: {
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string | null;
  jobId: string;
  jobType: string;
  parentJobId: string;
  bridgeVersion: "v1";
  executionSnapshotHash: string;
}) {
  return createHash("sha256").update(JSON.stringify({
    teamId: input.teamId,
    ownerId: input.ownerId,
    runId: input.runId,
    shardId: input.shardId,
    jobId: input.jobId,
    jobType: input.jobType,
    parentJobId: input.parentJobId,
    bridgeVersion: input.bridgeVersion,
    executionSnapshotHash: input.executionSnapshotHash
  })).digest("hex");
}

function sortedRunShards(store: CrmStore, run: ProspectSearchRun) {
  return store.prospectRunShards
    .filter((item) => item.teamId === run.teamId && item.runId === run.id)
    .sort((left, right) =>
      left.position - right.position || left.id.localeCompare(right.id)
    );
}

function assertShardPlan(
  run: ProspectSearchRun,
  shards: ProspectRunShard[]
) {
  if (shards.length !== run.executionSnapshot.providerPlan.length) {
    fail(run.id, "搜索运行桥接分片数量与执行快照不一致");
  }
  for (const [index, shard] of shards.entries()) {
    const plan = run.executionSnapshot.providerPlan[index];
    if (!plan
      || shard.position !== plan.position
      || shard.providerCode !== plan.providerCode) {
      fail(run.id, "搜索运行桥接分片顺序或数据源与执行快照不一致");
    }
  }
}

function exactPayload(
  runId: string,
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
    || expectedKeys.some((key) => actual[key] !== expected[key])) {
    fail(runId, "搜索运行桥接任务载荷不符合最小化契约");
  }
}

function decryptedPayload(
  run: ProspectSearchRun,
  job: AgentJob
) {
  try {
    return decryptAgentJobPayload(job, "input", job.inputJsonEncrypted);
  } catch {
    fail(run.id, "搜索运行桥接任务密文完整性校验失败");
  }
}

function validateJobBase(
  run: ProspectSearchRun,
  binding:
    | ProspectRunQueueParentBinding
    | ProspectRunQueueChildBinding,
  job: AgentJob,
  expectedIdempotencyKey: string
) {
  if (!ALLOWED_JOB_STATUSES.has(job.status)) {
    fail(run.id, "搜索运行桥接任务进入了不允许的执行状态");
  }
  if (job.teamId !== binding.teamId
    || job.ownerId !== binding.ownerId
    || job.id !== binding.jobId
    || job.jobType !== binding.jobType
    || job.parentJobId !== binding.parentJobId
    || job.aggregateType !== BRIDGE_AGGREGATE_TYPE
    || job.aggregateId !== run.id
    || job.policyVersion !== "queue_bridge_v1"
    || job.outputJsonEncrypted
    || job.attemptCount < 0
    || job.priority !== 50
    || job.idempotencyKey !== expectedIdempotencyKey
    || !job.inputJsonEncrypted
    || !TRACE_ID_PATTERN.test(job.traceId)) {
    fail(run.id, "搜索运行桥接任务字段完整性校验失败");
  }
  if (job.status === "queued"
    && (job.nextAttemptAt
      || job.finishedAt
      || job.errorCode
      || job.errorMessage)) {
    fail(run.id, "排队中的搜索运行桥接任务包含终态字段");
  }
  if (job.status === "running"
    && (!job.startedAt
      || job.nextAttemptAt
      || job.finishedAt
      || job.errorCode
      || job.errorMessage)) {
    fail(run.id, "执行中的搜索运行桥接任务字段不完整");
  }
  if (job.status === "retry_scheduled"
    && (!job.startedAt
      || !job.nextAttemptAt
      || job.finishedAt
      || !job.errorCode
      || !job.errorMessage)) {
    fail(run.id, "待重试的搜索运行桥接任务字段不完整");
  }
  if (job.status === "succeeded"
    && ((job.jobType === PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
        && !job.startedAt)
      || job.nextAttemptAt
      || !job.finishedAt
      || job.errorCode
      || job.errorMessage)) {
    fail(run.id, "成功的搜索运行桥接任务字段不完整");
  }
  if ((job.status === "failed" || job.status === "dead_letter")
    && ((job.jobType === PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
        && !job.startedAt)
      || job.nextAttemptAt
      || !job.finishedAt
      || !job.errorCode
      || !job.errorMessage)) {
    fail(run.id, "失败的搜索运行桥接任务字段不完整");
  }
  if (job.status === "cancelled"
    && (!job.finishedAt
      || job.errorCode !== "CANCELLED_BY_USER"
      || !job.errorMessage)) {
    fail(run.id, "已取消的搜索运行桥接任务终态字段不完整");
  }
}

function expectedParentJobStatus(run: ProspectSearchRun): AgentJobStatus {
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "failed") return "failed";
  if (run.status === "succeeded"
    || run.status === "succeeded_empty"
    || run.status === "partial_success") {
    return "succeeded";
  }
  return "queued";
}

function allowedChildJobStatuses(
  shard: ProspectRunShard
): ReadonlySet<AgentJobStatus> {
  switch (shard.status) {
    case "queued":
      return new Set(["queued"]);
    case "running":
    case "pause_requested":
    case "cancel_requested":
      return new Set(["running"]);
    case "retry_scheduled":
      return new Set(["retry_scheduled"]);
    case "paused":
      return new Set(["queued", "retry_scheduled"]);
    case "cancelled":
      return new Set(["cancelled"]);
    case "succeeded":
    case "succeeded_empty":
    case "partial_success":
      return new Set(["succeeded"]);
    case "failed":
      return new Set(["failed", "dead_letter"]);
  }
}

function validateRunShardState(
  run: ProspectSearchRun,
  shards: ProspectRunShard[]
) {
  const statuses = new Set(shards.map((item) => item.status));
  const allIn = (...allowed: ProspectRunShard["status"][]) =>
    [...statuses].every((status) => allowed.includes(status));
  const valid = run.status === "queued"
    ? allIn(
        "queued",
        "retry_scheduled",
        "succeeded",
        "succeeded_empty",
        "partial_success",
        "failed"
      ) && (statuses.has("queued") || statuses.has("retry_scheduled"))
    : run.status === "running"
      ? allIn(
          "queued",
          "running",
          "retry_scheduled",
          "succeeded",
          "succeeded_empty",
          "partial_success",
          "failed"
        )
      : run.status === "pause_requested"
        ? allIn(
            "pause_requested",
            "paused",
            "succeeded",
            "succeeded_empty",
            "partial_success",
            "failed"
          )
        : run.status === "paused"
          ? allIn(
              "paused",
              "succeeded",
              "succeeded_empty",
              "partial_success",
              "failed"
            ) && statuses.has("paused")
          : run.status === "cancel_requested"
            ? allIn(
                "cancel_requested",
                "cancelled",
                "succeeded",
                "succeeded_empty",
                "partial_success",
                "failed"
              )
            : run.status === "cancelled"
              ? statuses.size === 1 && statuses.has("cancelled")
              : run.status === "succeeded"
                ? allIn("succeeded", "succeeded_empty")
                  && statuses.has("succeeded")
                : run.status === "succeeded_empty"
                  ? statuses.size === 1 && statuses.has("succeeded_empty")
                  : run.status === "partial_success"
                    ? allIn(
                        "succeeded",
                        "succeeded_empty",
                        "partial_success",
                        "failed"
                      )
                      && (statuses.has("failed")
                        || statuses.has("partial_success"))
                    : run.status === "failed"
                      ? statuses.size === 1 && statuses.has("failed")
                      : false;
  if (!valid) {
    fail(run.id, "搜索运行与分片执行状态不一致");
  }
}

function validateParent(
  store: CrmStore,
  run: ProspectSearchRun,
  binding: ProspectRunQueueParentBinding
) {
  const expectedHash = bindingHash({
    teamId: run.teamId,
    ownerId: run.ownerId,
    runId: run.id,
    shardId: null,
    jobId: binding.jobId,
    jobType: PROSPECT_RUN_ORCHESTRATE_JOB_TYPE,
    parentJobId: "",
    bridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION,
    executionSnapshotHash: run.executionSnapshotHash
  });
  if (binding.teamId !== run.teamId
    || binding.runId !== run.id
    || binding.ownerId !== run.ownerId
    || binding.jobType !== PROSPECT_RUN_ORCHESTRATE_JOB_TYPE
    || binding.parentJobId !== ""
    || binding.bridgeVersion !== PROSPECT_RUN_QUEUE_BRIDGE_VERSION
    || binding.executionSnapshotHash !== run.executionSnapshotHash
    || binding.createdAt !== run.createdAt
    || binding.bindingHash !== expectedHash) {
    fail(run.id, "搜索运行父桥接绑定完整性校验失败");
  }
  const job = store.agentJobs.find((item) => item.id === binding.jobId);
  if (!job) fail(run.id, "搜索运行父桥接任务不存在");
  validateJobBase(
    run,
    binding,
    job,
    prospectRunBridgeIdempotencyDigest(
      `queue-bridge:v1:${run.teamId}:${run.id}:parent`
    )
  );
  if (job.maxAttempts !== 1
    || job.status !== expectedParentJobStatus(run)
    || job.attemptCount !== 0
    || job.startedAt) {
    fail(run.id, "搜索运行父桥接任务重试策略无效");
  }
  exactPayload(
    run.id,
    decryptedPayload(run, job),
    {
      runId: run.id,
      executionSnapshotHash: run.executionSnapshotHash,
      bridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION
    }
  );
  return job;
}

function validateChild(
  store: CrmStore,
  run: ProspectSearchRun,
  shard: ProspectRunShard,
  parent: ProspectRunQueueParentBinding,
  binding: ProspectRunQueueChildBinding
) {
  const expectedHash = bindingHash({
    teamId: run.teamId,
    ownerId: run.ownerId,
    runId: run.id,
    shardId: shard.id,
    jobId: binding.jobId,
    jobType: PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE,
    parentJobId: parent.jobId,
    bridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION,
    executionSnapshotHash: run.executionSnapshotHash
  });
  if (binding.teamId !== run.teamId
    || binding.runId !== run.id
    || binding.shardId !== shard.id
    || binding.ownerId !== run.ownerId
    || binding.jobType !== PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
    || binding.parentJobId !== parent.jobId
    || binding.bridgeVersion !== PROSPECT_RUN_QUEUE_BRIDGE_VERSION
    || binding.executionSnapshotHash !== run.executionSnapshotHash
    || binding.createdAt !== run.createdAt
    || binding.bindingHash !== expectedHash) {
    fail(run.id, "搜索运行子桥接绑定完整性校验失败");
  }
  const job = store.agentJobs.find((item) => item.id === binding.jobId);
  if (!job) fail(run.id, "搜索运行子桥接任务不存在");
  validateJobBase(
    run,
    binding,
    job,
    prospectRunBridgeIdempotencyDigest(
      `queue-bridge:v1:${run.teamId}:${run.id}:shard:${shard.id}`
    )
  );
  if (job.maxAttempts !== 3
    || !allowedChildJobStatuses(shard).has(job.status)) {
    fail(run.id, "搜索运行子桥接任务重试策略无效");
  }
  exactPayload(
    run.id,
    decryptedPayload(run, job),
    {
      runId: run.id,
      shardId: shard.id,
      providerCode: shard.providerCode,
      executionSnapshotHash: run.executionSnapshotHash,
      bridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION
    }
  );
  return job;
}

export function registerProspectRunQueueBridge(
  store: CrmStore,
  run: ProspectSearchRun
) {
  if (run.queueBridgeVersion !== PROSPECT_RUN_QUEUE_BRIDGE_VERSION) {
    fail(run.id, "搜索运行未声明 Queue Bridge v1");
  }
  const shards = sortedRunShards(store, run);
  assertShardPlan(run, shards);
  if (store.prospectRunQueueParentBindings.some((item) =>
    item.teamId === run.teamId && item.runId === run.id
  ) || store.prospectRunQueueChildBindings.some((item) =>
    item.teamId === run.teamId && item.runId === run.id
  )) {
    fail(run.id, "搜索运行桥接图已存在，不能重复创建");
  }

  const originalJobsLength = store.agentJobs.length;
  const originalParentLength = store.prospectRunQueueParentBindings.length;
  const originalChildLength = store.prospectRunQueueChildBindings.length;
  try {
    const parentJob = registerProspectRunBridgeJob(store, {
      teamId: run.teamId,
      ownerId: run.ownerId,
      jobType: PROSPECT_RUN_ORCHESTRATE_JOB_TYPE,
      aggregateId: run.id,
      parentJobId: "",
      priority: 50,
      idempotencyKey: `queue-bridge:v1:${run.teamId}:${run.id}:parent`,
      input: {
        runId: run.id,
        executionSnapshotHash: run.executionSnapshotHash,
        bridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION
      },
      maxAttempts: 1,
      createdAt: run.createdAt
    });
    const parentBinding: ProspectRunQueueParentBinding = {
      id: `prqpb_${randomUUID()}`,
      teamId: run.teamId,
      runId: run.id,
      ownerId: run.ownerId,
      jobId: parentJob.id,
      jobType: PROSPECT_RUN_ORCHESTRATE_JOB_TYPE,
      parentJobId: "",
      bridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION,
      executionSnapshotHash: run.executionSnapshotHash,
      bindingHash: bindingHash({
        teamId: run.teamId,
        ownerId: run.ownerId,
        runId: run.id,
        shardId: null,
        jobId: parentJob.id,
        jobType: PROSPECT_RUN_ORCHESTRATE_JOB_TYPE,
        parentJobId: "",
        bridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION,
        executionSnapshotHash: run.executionSnapshotHash
      }),
      createdAt: run.createdAt
    };
    store.prospectRunQueueParentBindings.push(parentBinding);

    for (const shard of shards) {
      const childJob = registerProspectRunBridgeJob(store, {
        teamId: run.teamId,
        ownerId: run.ownerId,
        jobType: PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE,
        aggregateId: run.id,
        parentJobId: parentJob.id,
        priority: 50,
        idempotencyKey: `queue-bridge:v1:${run.teamId}:${run.id}:shard:${shard.id}`,
        input: {
          runId: run.id,
          shardId: shard.id,
          providerCode: shard.providerCode,
          executionSnapshotHash: run.executionSnapshotHash,
          bridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION
        },
        maxAttempts: 3,
        createdAt: run.createdAt
      });
      store.prospectRunQueueChildBindings.push({
        id: `prqcb_${randomUUID()}`,
        teamId: run.teamId,
        runId: run.id,
        shardId: shard.id,
        ownerId: run.ownerId,
        jobId: childJob.id,
        jobType: PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE,
        parentJobId: parentJob.id,
        bridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION,
        executionSnapshotHash: run.executionSnapshotHash,
        bindingHash: bindingHash({
          teamId: run.teamId,
          ownerId: run.ownerId,
          runId: run.id,
          shardId: shard.id,
          jobId: childJob.id,
          jobType: PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE,
          parentJobId: parentJob.id,
          bridgeVersion: PROSPECT_RUN_QUEUE_BRIDGE_VERSION,
          executionSnapshotHash: run.executionSnapshotHash
        }),
        createdAt: run.createdAt
      });
    }
    validateProspectRunQueueBridge(store, run);
  } catch (error) {
    store.agentJobs.splice(originalJobsLength);
    store.prospectRunQueueParentBindings.splice(originalParentLength);
    store.prospectRunQueueChildBindings.splice(originalChildLength);
    throw error;
  }
}

export function validateProspectRunQueueBridge(
  store: CrmStore,
  run: ProspectSearchRun
) {
  const parents = store.prospectRunQueueParentBindings.filter((item) =>
    item.teamId === run.teamId && item.runId === run.id
  );
  const children = store.prospectRunQueueChildBindings.filter((item) =>
    item.teamId === run.teamId && item.runId === run.id
  );
  if (run.queueBridgeVersion === null) {
    if (parents.length || children.length) {
      fail(run.id, "历史搜索运行不能存在 Queue Bridge v1 绑定");
    }
    return { parentJob: null, childJobs: [] };
  }
  if (run.queueBridgeVersion !== PROSPECT_RUN_QUEUE_BRIDGE_VERSION) {
    fail(run.id, "搜索运行桥接版本无效");
  }
  if (parents.length !== 1) {
    fail(run.id, "搜索运行必须且只能存在一个父桥接绑定");
  }
  const shards = sortedRunShards(store, run);
  assertShardPlan(run, shards);
  validateRunShardState(run, shards);
  if (children.length !== shards.length) {
    fail(run.id, "搜索运行子桥接绑定数量与分片数量不一致");
  }
  const parent = parents[0];
  const parentJob = validateParent(store, run, parent);
  const childJobs = shards.map((shard) => {
    const matches = children.filter((item) => item.shardId === shard.id);
    if (matches.length !== 1) {
      fail(run.id, "搜索运行分片必须且只能存在一个子桥接绑定");
    }
    return validateChild(store, run, shard, parent, matches[0]);
  });
  if (new Set([parentJob.id, ...childJobs.map((item) => item.id)]).size
    !== childJobs.length + 1) {
    fail(run.id, "搜索运行桥接任务被重复绑定");
  }
  return { parentJob, childJobs };
}

export function validateAllProspectRunQueueBridges(store: CrmStore) {
  for (const run of store.prospectSearchRuns) {
    validateProspectRunQueueBridge(store, run);
  }
  const runs = new Map(store.prospectSearchRuns.map((run) => [
    `${run.teamId}\u001f${run.id}`,
    run
  ]));
  const parentBindingIds = new Set<string>();
  for (const binding of store.prospectRunQueueParentBindings) {
    if (parentBindingIds.has(binding.id)) {
      fail(binding.runId, "搜索运行父桥接绑定主键重复");
    }
    parentBindingIds.add(binding.id);
  }
  const childBindingIds = new Set<string>();
  for (const binding of store.prospectRunQueueChildBindings) {
    if (childBindingIds.has(binding.id)) {
      fail(binding.runId, "搜索运行子桥接绑定主键重复");
    }
    childBindingIds.add(binding.id);
  }
  for (const binding of [
    ...store.prospectRunQueueParentBindings,
    ...store.prospectRunQueueChildBindings
  ]) {
    if (!runs.has(`${binding.teamId}\u001f${binding.runId}`)) {
      fail(binding.runId, "发现未关联搜索运行的桥接绑定");
    }
  }
  const boundJobIds = new Set([
    ...store.prospectRunQueueParentBindings.map((item) => item.jobId),
    ...store.prospectRunQueueChildBindings.map((item) => item.jobId)
  ]);
  for (const job of store.agentJobs.filter(isProspectRunBridgeJob)) {
    if (!boundJobIds.has(job.id)) {
      fail(job.aggregateId, "发现未绑定搜索运行的桥接任务");
    }
    if (store.agentJobIdempotencyAliases.some((item) =>
      item.jobId === job.id
    )) {
      fail(job.aggregateId, "搜索运行桥接任务不能存在通用幂等别名");
    }
  }
  for (const jobId of boundJobIds) {
    const matches = store.agentJobs.filter((item) => item.id === jobId);
    if (matches.length !== 1 || !isProspectRunBridgeJob(matches[0])) {
      const binding = [
        ...store.prospectRunQueueParentBindings,
        ...store.prospectRunQueueChildBindings
      ].find((item) => item.jobId === jobId);
      fail(binding?.runId || "", "桥接绑定未指向唯一的保留类型任务");
    }
  }
}

export function cancelProspectRunQueueBridge(
  store: CrmStore,
  run: ProspectSearchRun,
  cancelledAt: string
) {
  const graph = validateProspectRunQueueBridge(store, run);
  if (!graph.parentJob) return;
  for (const job of [graph.parentJob, ...graph.childJobs]) {
    cancelProspectRunBridgeJob(job, cancelledAt);
  }
}
