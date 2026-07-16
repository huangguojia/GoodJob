import { createHmac, randomUUID } from "node:crypto";
import { encryptAgentJobPayload } from "./agent-job-security.js";
import type { CrmStore } from "./store.js";
import type { AgentJob, AgentJobIdempotencyAlias, AgentJobStatus } from "./types.js";

const RETRYABLE_STATUSES = new Set<AgentJobStatus>(["failed", "dead_letter"]);
const CANCELLABLE_STATUSES = new Set<AgentJobStatus>(["queued", "running", "retry_scheduled"]);
export const PROSPECT_RUN_ORCHESTRATE_JOB_TYPE = "prospect.orchestrate";
export const PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE = "prospect.provider.fetch";
const PROSPECT_RUN_BRIDGE_JOB_TYPES = new Set([
  PROSPECT_RUN_ORCHESTRATE_JOB_TYPE,
  PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE
]);

export function isProspectRunBridgeJob(
  job: Pick<AgentJob, "jobType">
) {
  return PROSPECT_RUN_BRIDGE_JOB_TYPES.has(job.jobType);
}

function assertGenericAgentJob(job: Pick<AgentJob, "jobType">) {
  if (isProspectRunBridgeJob(job)) {
    throw new Error("任务不存在或不能通过通用任务入口操作");
  }
}

function idempotencySecret() {
  return process.env.AGENT_JOB_ENCRYPTION_KEY
    || process.env.PROVIDER_CREDENTIAL_KEY
    || process.env.JWT_SECRET
    || process.env.DATABASE_URL
    || process.env.MYSQL_URL
    || "goodjob-agent-job-idempotency-development";
}

function idempotencyDigest(value: string) {
  return createHmac("sha256", idempotencySecret()).update(value).digest("hex");
}

export function prospectRunBridgeIdempotencyDigest(value: string) {
  return idempotencyDigest(value.trim());
}

function safeFailureMessage(errorCode: string) {
  const messages: Record<string, string> = {
    PROVIDER_AUTH_INVALID: "数据源授权已失效，请更新连接后重试",
    PROVIDER_AUTH_FAILED: "数据源授权已失效，请更新连接后重试",
    PROVIDER_RATE_LIMITED: "数据源正在限流，请在允许时间后手动重试",
    PROVIDER_QUOTA_EXHAUSTED: "数据源额度已用尽，请在额度恢复后重试",
    PROVIDER_TIMEOUT: "数据源响应超时，请稍后重试",
    PROVIDER_SCHEMA_CHANGED: "数据源返回格式发生变化，任务已暂停",
    PROVIDER_POLICY_BLOCKED: "当前任务不符合来源使用策略，已停止执行",
    BUDGET_LIMIT_REACHED: "当前团队预算已达到上限",
    EXECUTION_INTERRUPTED: "服务重启前任务未完成，请手动重试",
    CANCELLED_BY_USER: "任务已由用户取消"
  };
  return messages[errorCode] || "任务执行失败，请稍后重试或联系管理员";
}

export interface EnqueueAgentJobInput {
  teamId: string;
  ownerId: string;
  jobType: string;
  aggregateType: string;
  aggregateId: string;
  parentJobId?: string;
  priority?: number;
  idempotencyKey: string;
  policyVersion?: string;
  input?: Record<string, unknown>;
  maxAttempts?: number;
  traceId?: string;
}

export function findAgentJobByIdempotency(
  store: CrmStore,
  input: Pick<EnqueueAgentJobInput, "teamId" | "jobType" | "idempotencyKey">
) {
  const teamId = input.teamId.trim();
  const jobType = input.jobType.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!teamId || !jobType || !idempotencyKey) return undefined;
  if (PROSPECT_RUN_BRIDGE_JOB_TYPES.has(jobType)) return undefined;
  const digest = idempotencyDigest(idempotencyKey);
  const primary = store.agentJobs.find((item) =>
    item.teamId === teamId
    && item.jobType === jobType
    && item.idempotencyKey === digest
  );
  if (primary) return primary;
  const alias = store.agentJobIdempotencyAliases.find((item) =>
    item.teamId === teamId
    && item.jobType === jobType
    && item.idempotencyKey === digest
  );
  if (!alias) return undefined;
  return store.agentJobs.find((item) =>
    item.id === alias.jobId
    && item.teamId === teamId
    && item.jobType === jobType
  );
}

export function attachAgentJobIdempotencyAlias(
  store: CrmStore,
  job: AgentJob,
  rawIdempotencyKey: string
) {
  assertGenericAgentJob(job);
  if (!store.agentJobs.some((item) =>
    item.id === job.id
    && item.teamId === job.teamId
    && item.jobType === job.jobType
  )) {
    throw new Error("幂等别名目标任务不存在");
  }
  const idempotencyKey = rawIdempotencyKey.trim();
  if (!idempotencyKey) throw new Error("智能获客任务别名必须提供幂等键");
  const digest = idempotencyDigest(idempotencyKey);
  if (job.idempotencyKey === digest) {
    return { alias: null, duplicate: true };
  }
  const primary = store.agentJobs.find((item) =>
    item.teamId === job.teamId
    && item.jobType === job.jobType
    && item.idempotencyKey === digest
  );
  if (primary) {
    if (primary.id === job.id) return { alias: null, duplicate: true };
    throw new Error("该幂等键已绑定其他任务");
  }
  const existing = store.agentJobIdempotencyAliases.find((item) =>
    item.teamId === job.teamId
    && item.jobType === job.jobType
    && item.idempotencyKey === digest
  );
  if (existing) {
    if (existing.jobId === job.id) return { alias: existing, duplicate: true };
    throw new Error("该幂等键已绑定其他任务");
  }
  const alias: AgentJobIdempotencyAlias = {
    id: `ajia_${randomUUID()}`,
    jobId: job.id,
    teamId: job.teamId,
    jobType: job.jobType,
    idempotencyKey: digest,
    createdAt: new Date().toISOString()
  };
  store.agentJobIdempotencyAliases.unshift(alias);
  return { alias, duplicate: false };
}

export function enqueueAgentJob(store: CrmStore, input: EnqueueAgentJobInput) {
  const teamId = input.teamId.trim();
  const ownerId = input.ownerId.trim();
  const jobType = input.jobType.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!teamId || !ownerId) throw new Error("智能获客任务必须明确指定团队和负责人");
  if (!/^[a-z0-9._-]{3,80}$/i.test(jobType)) throw new Error("智能获客任务类型格式无效");
  if (PROSPECT_RUN_BRIDGE_JOB_TYPES.has(jobType)) {
    throw new Error("该任务类型仅允许由搜索运行桥接器创建");
  }
  if (!idempotencyKey) throw new Error("智能获客任务必须提供幂等键");
  const owner = store.users.find((item) => item.id === ownerId && item.status === "active");
  if (!owner || owner.teamId !== teamId) {
    throw new Error("任务负责人不存在、已停用或不属于当前团队");
  }

  const digest = idempotencyDigest(idempotencyKey);
  const existing = findAgentJobByIdempotency(store, {
    teamId,
    jobType,
    idempotencyKey
  });
  if (existing) return { job: existing, duplicate: true };

  if (input.parentJobId) {
    const parent = store.agentJobs.find((item) => item.id === input.parentJobId);
    if (!parent || parent.teamId !== teamId) throw new Error("父任务不存在或不属于当前团队");
  }

  const id = `aj_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const context = { id, teamId, ownerId, jobType };
  const job: AgentJob = {
    ...context,
    aggregateType: input.aggregateType.trim().slice(0, 80),
    aggregateId: input.aggregateId.trim().slice(0, 100),
    parentJobId: input.parentJobId || "",
    status: "queued",
    priority: Math.min(100, Math.max(0, Math.trunc(input.priority ?? 50))),
    idempotencyKey: digest,
    policyVersion: (input.policyVersion || "v1").trim().slice(0, 40),
    inputJsonEncrypted: encryptAgentJobPayload(context, "input", input.input || {}),
    outputJsonEncrypted: "",
    attemptCount: 0,
    maxAttempts: Math.min(10, Math.max(1, Math.trunc(input.maxAttempts ?? 3))),
    nextAttemptAt: createdAt,
    errorCode: "",
    errorMessage: "",
    traceId: (input.traceId || `trace_${randomUUID()}`).trim().slice(0, 100),
    startedAt: "",
    finishedAt: "",
    createdAt
  };
  store.agentJobs.unshift(job);
  return { job, duplicate: false };
}

export interface RegisterProspectRunBridgeJobInput {
  teamId: string;
  ownerId: string;
  jobType:
    | typeof PROSPECT_RUN_ORCHESTRATE_JOB_TYPE
    | typeof PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE;
  aggregateId: string;
  parentJobId: string;
  priority: number;
  idempotencyKey: string;
  input: Record<string, unknown>;
  maxAttempts: number;
  createdAt: string;
}

export function registerProspectRunBridgeJob(
  store: CrmStore,
  input: RegisterProspectRunBridgeJobInput
) {
  const owner = store.users.find((item) =>
    item.id === input.ownerId
    && item.teamId === input.teamId
    && item.status === "active"
  );
  if (!owner) throw new Error("搜索运行桥接任务负责人无效");
  if (!PROSPECT_RUN_BRIDGE_JOB_TYPES.has(input.jobType)) {
    throw new Error("搜索运行桥接任务类型无效");
  }
  if (input.jobType === PROSPECT_RUN_ORCHESTRATE_JOB_TYPE
    && input.parentJobId) {
    throw new Error("搜索运行父桥接任务不能引用父任务");
  }
  if (input.jobType === PROSPECT_RUN_PROVIDER_FETCH_JOB_TYPE) {
    const parent = store.agentJobs.find((item) =>
      item.id === input.parentJobId
      && item.teamId === input.teamId
      && item.ownerId === input.ownerId
      && item.jobType === PROSPECT_RUN_ORCHESTRATE_JOB_TYPE
    );
    if (!parent) throw new Error("搜索运行子桥接任务缺少同域父任务");
  }
  if (!input.idempotencyKey.trim()) {
    throw new Error("搜索运行桥接任务必须提供幂等键");
  }
  const id = `aj_${randomUUID()}`;
  const context = {
    id,
    teamId: input.teamId,
    ownerId: input.ownerId,
    jobType: input.jobType
  };
  const job: AgentJob = {
    ...context,
    aggregateType: "prospect_search_run_queue_bridge_v1",
    aggregateId: input.aggregateId,
    parentJobId: input.parentJobId,
    status: "queued",
    priority: Math.min(100, Math.max(0, Math.trunc(input.priority))),
    idempotencyKey: prospectRunBridgeIdempotencyDigest(input.idempotencyKey),
    policyVersion: "queue_bridge_v1",
    inputJsonEncrypted: encryptAgentJobPayload(context, "input", input.input),
    outputJsonEncrypted: "",
    attemptCount: 0,
    maxAttempts: Math.min(10, Math.max(1, Math.trunc(input.maxAttempts))),
    nextAttemptAt: "",
    errorCode: "",
    errorMessage: "",
    traceId: `trace_${randomUUID()}`,
    startedAt: "",
    finishedAt: "",
    createdAt: input.createdAt
  };
  store.agentJobs.push(job);
  return job;
}

export function startAgentJob(job: AgentJob) {
  assertGenericAgentJob(job);
  if (job.status !== "queued" && job.status !== "retry_scheduled") {
    throw new Error("当前任务状态不能开始执行");
  }
  if (job.status === "retry_scheduled") {
    const retryAt = new Date(job.nextAttemptAt);
    if (!Number.isFinite(retryAt.getTime())) throw new Error("任务重试时间无效");
    if (retryAt.getTime() > Date.now()) throw new Error("任务尚未到重试时间");
  }
  job.status = "running";
  job.attemptCount += 1;
  job.startedAt = new Date().toISOString();
  job.finishedAt = "";
  job.nextAttemptAt = "";
  job.errorCode = "";
  job.errorMessage = "";
  return job;
}

export function completeAgentJob(job: AgentJob, output: Record<string, unknown> = {}) {
  assertGenericAgentJob(job);
  if (job.status !== "running") throw new Error("只有执行中的任务可以完成");
  job.outputJsonEncrypted = encryptAgentJobPayload(job, "output", output);
  job.status = "succeeded";
  job.finishedAt = new Date().toISOString();
  job.errorCode = "";
  job.errorMessage = "";
  return job;
}

export function failAgentJob(job: AgentJob, errorCode: string, nextAttemptAt = "") {
  assertGenericAgentJob(job);
  if (job.status !== "running") throw new Error("只有执行中的任务可以记录失败");
  const normalizedCode = errorCode.trim().slice(0, 80) || "AGENT_JOB_FAILED";
  const retryAt = nextAttemptAt ? new Date(nextAttemptAt) : null;
  if (retryAt && Number.isNaN(retryAt.getTime())) {
    throw new Error("任务下次重试时间格式无效");
  }
  job.errorCode = normalizedCode;
  job.errorMessage = safeFailureMessage(normalizedCode);
  if (retryAt && job.attemptCount < job.maxAttempts) {
    job.status = "retry_scheduled";
    job.nextAttemptAt = retryAt.toISOString();
    job.finishedAt = "";
  } else {
    job.status = job.attemptCount >= job.maxAttempts ? "dead_letter" : "failed";
    job.nextAttemptAt = "";
    job.finishedAt = new Date().toISOString();
  }
  return job;
}

export function retryAgentJob(job: AgentJob) {
  assertGenericAgentJob(job);
  if (!RETRYABLE_STATUSES.has(job.status)) throw new Error("当前任务状态不能重试");
  if (job.status === "dead_letter" && job.attemptCount >= job.maxAttempts) {
    job.maxAttempts = Math.min(10, job.attemptCount + 1);
  }
  job.status = "queued";
  job.nextAttemptAt = new Date().toISOString();
  job.finishedAt = "";
  job.errorCode = "";
  job.errorMessage = "";
  return job;
}

export function cancelAgentJob(job: AgentJob) {
  assertGenericAgentJob(job);
  if (!CANCELLABLE_STATUSES.has(job.status)) throw new Error("当前任务状态不能取消");
  job.status = "cancelled";
  job.nextAttemptAt = "";
  job.finishedAt = new Date().toISOString();
  job.errorCode = "CANCELLED_BY_USER";
  job.errorMessage = safeFailureMessage(job.errorCode);
  return job;
}

export function recoverInterruptedAgentJobs(store: CrmStore, jobType: string) {
  if (PROSPECT_RUN_BRIDGE_JOB_TYPES.has(jobType)) {
    throw new Error("搜索运行桥接任务不能通过通用恢复入口处理");
  }
  const now = new Date().toISOString();
  const recovered = store.agentJobs.filter((job) =>
    job.jobType === jobType && job.status === "running"
  );
  recovered.forEach((job) => {
    job.status = "failed";
    job.nextAttemptAt = "";
    job.finishedAt = now;
    job.errorCode = "EXECUTION_INTERRUPTED";
    job.errorMessage = safeFailureMessage(job.errorCode);
  });
  return recovered.length;
}

export function publicAgentJob(job: AgentJob) {
  assertGenericAgentJob(job);
  return {
    id: job.id,
    teamId: job.teamId,
    ownerId: job.ownerId,
    jobType: job.jobType,
    aggregateType: job.aggregateType,
    aggregateId: job.aggregateId,
    parentJobId: job.parentJobId,
    status: job.status,
    priority: job.priority,
    policyVersion: job.policyVersion,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt,
    errorCode: job.errorCode,
    failureReason: job.errorMessage,
    traceId: job.traceId,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt
  };
}

export function cancelProspectRunBridgeJob(job: AgentJob, cancelledAt: string) {
  if (!isProspectRunBridgeJob(job) || job.status !== "queued") {
    throw new Error("搜索运行桥接任务状态不允许取消");
  }
  job.status = "cancelled";
  job.nextAttemptAt = "";
  job.finishedAt = cancelledAt;
  job.errorCode = "CANCELLED_BY_USER";
  job.errorMessage = safeFailureMessage(job.errorCode);
  return job;
}
