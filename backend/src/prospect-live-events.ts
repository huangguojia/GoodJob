import type { CrmStore } from "./store.js";
import type {
  ProspectSearchRun,
  ProspectSearchRunStatus,
  ProspectSearchQueryCell
} from "./types.js";

export interface ProspectLiveEvent {
  id: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  type: string;
  stage: string;
  entityType: string;
  entityId: string;
  status: string;
  progress: number | null;
  metrics: Record<string, number | string | boolean | null>;
  failureCode: string;
  retryable: boolean;
  message: string;
}

export interface ProspectRunFeedReadInput {
  teamId: string;
  runId: string;
  after: string;
  limit: number;
}

export interface ProspectRunFeedReadResult {
  events: ProspectLiveEvent[];
  terminal: boolean;
}

interface UnsequencedLiveEvent extends Omit<ProspectLiveEvent, "sequence"> {}

const TERMINAL_RUN_STATUSES = new Set<ProspectSearchRunStatus>([
  "cancelled",
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed"
]);

function time(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function runProgress(store: CrmStore, run: ProspectSearchRun) {
  if (TERMINAL_RUN_STATUSES.has(run.status)) return 100;
  const shards = store.prospectRunShards.filter((item) =>
    item.teamId === run.teamId && item.runId === run.id
  );
  if (!shards.length) return 0;
  const units = shards.reduce((total, shard) => {
    if (["succeeded", "succeeded_empty", "partial_success", "failed", "cancelled"].includes(shard.status)) {
      return total + 1;
    }
    if (["running", "pause_requested", "cancel_requested"].includes(shard.status)) {
      return total + 0.5;
    }
    return total;
  }, 0);
  return Math.round(units / shards.length * 100);
}

function runMessage(status: ProspectSearchRunStatus) {
  const messages: Record<ProspectSearchRunStatus, string> = {
    queued: "搜客任务已进入执行队列",
    running: "搜客任务正在执行",
    pause_requested: "搜客任务正在保存进度并暂停",
    paused: "搜客任务已暂停",
    cancel_requested: "搜客任务正在结束",
    cancelled: "搜客任务已结束",
    succeeded: "搜客任务已结束",
    succeeded_empty: "搜客任务已结束，未发现候选",
    partial_success: "搜客任务已结束，部分来源未完成",
    failed: "搜客任务已结束，执行详情包含失败原因"
  };
  return messages[status];
}

function executionStage(eventType: string) {
  if (eventType.includes("lease")) return "dispatch";
  if (eventType === "request_started") return "search";
  if (eventType === "page_accepted") return "collect";
  if (eventType === "retry_scheduled") return "retry";
  if (eventType.includes("completed")) return "complete";
  if (eventType.includes("pause") || eventType.includes("cancel")) return "control";
  return "execution";
}

function executionMessage(eventType: string) {
  const messages: Record<string, string> = {
    kernel_started: "执行内核已启动",
    lease_claimed: "来源执行权已领取",
    lease_heartbeat: "来源执行租约有效",
    request_started: "已向数据源发起请求",
    page_accepted: "数据源返回页已验收并持久化",
    retry_scheduled: "来源请求已安排重试",
    pause_settled: "来源进度已保存并暂停",
    cancel_settled: "来源执行已结束",
    lease_recovered: "来源执行租约已恢复",
    shard_completed: "数据源执行已结束",
    run_completed: "搜客任务执行已结束"
  };
  return messages[eventType] || `执行事实已记录：${eventType}`;
}

function attemptMessage(status: string, providerCode: string) {
  const messages: Record<string, string> = {
    claimed: `${providerCode} 请求已领取`,
    request_started: `${providerCode} 请求已发出`,
    succeeded: `${providerCode} 请求已结算`,
    failed: `${providerCode} 请求失败`,
    request_outcome_unknown: `${providerCode} 请求结果待核对`,
    cancelled_late: `${providerCode} 请求在结束指令后返回`
  };
  return messages[status] || `${providerCode} 请求状态已更新`;
}

function cellEvent(input: {
  runId: string;
  missionId: string;
  roundId: string;
  roundCreatedAt: string;
  roundCompletedAt: string;
  cell: ProspectSearchQueryCell;
}): UnsequencedLiveEvent {
  const occurredAt = input.cell.completedAt || input.roundCompletedAt || input.roundCreatedAt;
  const completed = input.cell.status !== "planned";
  return {
    id: `cell:${input.missionId}:${input.roundId}:${input.cell.fingerprint}:${input.cell.status}:${input.cell.completedAt || "planned"}`,
    runId: input.runId,
    occurredAt,
    type: completed ? "cell.completed" : "cell.planned",
    stage: completed ? "search" : "planning",
    entityType: "query_cell",
    entityId: input.cell.fingerprint,
    status: input.cell.status,
    progress: completed ? 100 : 0,
    metrics: {
      providerId: input.cell.providerId,
      market: input.cell.market,
      language: input.cell.language,
      customerType: input.cell.customerType,
      rawCount: input.cell.rawCount ?? 0,
      invalidCount: input.cell.invalidCount ?? 0,
      duplicateCount: input.cell.duplicateCount ?? 0,
      candidateCount: input.cell.candidateCount ?? 0,
      costAmount: input.cell.costAmount ?? null,
      costUnknownCount: input.cell.costUnknownCount ?? 0,
      currency: input.cell.currency || ""
    },
    failureCode: input.cell.errorCode || "",
    retryable: false,
    message: completed
      ? `${input.cell.providerId} 查询单元已结束：${input.cell.market} / ${input.cell.language} / ${input.cell.customerType}`
      : `${input.cell.providerId} 查询单元已规划：${input.cell.market} / ${input.cell.language} / ${input.cell.customerType}`
  };
}

export function projectProspectLiveEvents(
  store: CrmStore,
  run: ProspectSearchRun
): ProspectLiveEvent[] {
  const events: UnsequencedLiveEvent[] = [];
  const progress = runProgress(store, run);

  for (const event of store.prospectRunEvents.filter((item) =>
    item.teamId === run.teamId && item.runId === run.id
  )) {
    events.push({
      id: `run:${event.id}`,
      runId: run.id,
      occurredAt: event.createdAt,
      type: `run.${event.eventType}`,
      stage: "lifecycle",
      entityType: "run",
      entityId: run.id,
      status: event.toStatus,
      progress,
      metrics: { revision: event.toRevision },
      failureCode: event.eventType === "failed" ? "RUN_FAILED" : "",
      retryable: false,
      message: event.reason || runMessage(event.toStatus)
    });
  }

  for (const event of store.prospectExecutionEvents.filter((item) =>
    item.teamId === run.teamId && item.runId === run.id
      && item.eventType !== "lease_heartbeat"
  )) {
    events.push({
      id: `execution:${event.id}`,
      runId: run.id,
      occurredAt: event.createdAt,
      type: `execution.${event.eventType}`,
      stage: executionStage(event.eventType),
      entityType: event.eventType === "run_completed" ? "run" : "shard",
      entityId: event.eventType === "run_completed" ? run.id : event.shardId,
      status: event.eventType,
      progress,
      metrics: {
        kernelEpoch: event.kernelEpoch,
        runEpoch: event.runEpoch,
        fenceToken: event.fenceToken
      },
      failureCode: "",
      retryable: event.eventType === "retry_scheduled",
      message: executionMessage(event.eventType)
    });
  }

  for (const page of store.prospectExecutionPages.filter((item) =>
    item.teamId === run.teamId && item.runId === run.id
  )) {
    events.push({
      id: `page:${page.id}`,
      runId: run.id,
      occurredAt: page.createdAt,
      type: "page.persisted",
      stage: "collect",
      entityType: "page",
      entityId: page.id,
      status: page.partial ? "partial" : "accepted",
      progress: null,
      metrics: {
        providerId: page.providerCode,
        pageSequence: page.pageSequence,
        rawCount: page.rawCount,
        acceptedCount: page.acceptedCount,
        invalidCount: page.invalidCount,
        duplicateCount: page.duplicateCount,
        partial: page.partial
      },
      failureCode: "",
      retryable: false,
      message: `${page.providerCode} 第 ${page.pageSequence} 页已保存：原始 ${page.rawCount}，接受 ${page.acceptedCount}，无效 ${page.invalidCount}，重复 ${page.duplicateCount}`
    });
  }

  for (const attempt of store.prospectExecutionAttempts.filter((item) =>
    item.teamId === run.teamId && item.runId === run.id
  )) {
    events.push({
      id: `attempt:${attempt.id}:${attempt.version}:${attempt.status}:${attempt.finishedAt || "active"}`,
      runId: run.id,
      occurredAt: attempt.finishedAt || attempt.startedAt || attempt.createdAt,
      type: `attempt.${attempt.status}`,
      stage: "provider_request",
      entityType: "attempt",
      entityId: attempt.id,
      status: attempt.status,
      progress: null,
      metrics: {
        providerId: attempt.providerCode,
        attempt: attempt.providerAttemptNo,
        checkpoint: attempt.checkpointNo,
        costKind: attempt.costKind,
        costAmount: attempt.costAmount,
        currency: attempt.currency || ""
      },
      failureCode: attempt.errorCode,
      retryable: attempt.retryable,
      message: attempt.errorMessage || attemptMessage(attempt.status, attempt.providerCode)
    });
  }

  for (const state of (store.prospectCandidateProcessingStates || []).filter((item) =>
    item.teamId === run.teamId && item.runId === run.id
  )) {
    events.push({
      id: `candidate:${state.hitId}:${state.status}:${state.updatedAt}`,
      runId: run.id,
      occurredAt: state.updatedAt || state.processedAt,
      type: state.status === "completed" ? "candidate.persisted" : "candidate.rejected",
      stage: "candidate_processing",
      entityType: state.candidateId ? "candidate" : "raw_hit",
      entityId: state.candidateId || state.hitId,
      status: state.status,
      progress: null,
      metrics: {},
      failureCode: state.failureCode,
      retryable: false,
      message: state.status === "completed"
        ? "候选已完成身份归一、覆盖分流并保存"
        : `原始命中未进入候选池：${state.failureCode || "不满足处理规则"}`
    });
  }

  const rounds = store.prospectSuperSearchRounds.filter((item) =>
    item.teamId === run.teamId && item.runId === run.id
  );
  const missionIds = new Set(rounds.map((item) => item.missionId));
  for (const event of store.prospectSuperSearchEvents.filter((item) =>
    item.teamId === run.teamId && missionIds.has(item.missionId)
  )) {
    events.push({
      id: `mission:${event.id}`,
      runId: run.id,
      occurredAt: event.createdAt,
      type: `mission.${event.type}`,
      stage: event.type.startsWith("round_") ? "round" : "mission",
      entityType: "mission",
      entityId: event.missionId,
      status: event.type,
      progress: null,
      metrics: {},
      failureCode: event.type === "failed" ? "MISSION_FAILED" : "",
      retryable: false,
      message: event.message
    });
  }
  for (const round of rounds) {
    for (const cell of round.queryCells || []) {
      events.push(cellEvent({
        runId: run.id,
        missionId: round.missionId,
        roundId: round.id,
        roundCreatedAt: round.createdAt,
        roundCompletedAt: round.completedAt,
        cell
      }));
    }
  }

  return events
    .sort((left, right) =>
      time(left.occurredAt) - time(right.occurredAt)
      || left.id.localeCompare(right.id)
    )
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}

export function prospectLiveEventsAfter(
  events: ProspectLiveEvent[],
  lastEventId: string
) {
  if (!lastEventId) return events;
  const index = events.findIndex((event) => event.id === lastEventId);
  if (index < 0) return events;
  return events.slice(index + 1);
}

interface MemoryFeedState {
  nextOffset: number;
  offsets: Map<string, number>;
}

const memoryFeedStates = new WeakMap<CrmStore, MemoryFeedState>();

function memoryFeedState(store: CrmStore) {
  const existing = memoryFeedStates.get(store);
  if (existing) return existing;
  const created: MemoryFeedState = { nextOffset: 1, offsets: new Map() };
  memoryFeedStates.set(store, created);
  return created;
}

export async function readProspectRunFeedMemory(
  store: CrmStore,
  input: ProspectRunFeedReadInput
): Promise<ProspectRunFeedReadResult> {
  const run = store.prospectSearchRuns.find((item) =>
    item.teamId === input.teamId && item.id === input.runId
  );
  if (!run) return { events: [], terminal: true };
  const state = memoryFeedState(store);
  const projected = projectProspectLiveEvents(store, run);
  for (const event of projected) {
    if (state.offsets.has(event.id)) continue;
    state.offsets.set(event.id, state.nextOffset++);
  }
  const after = Number(input.after || 0);
  const events = projected
    .map((event) => ({
      event,
      offset: state.offsets.get(event.id) || 0
    }))
    .filter((item) => item.offset > after)
    .sort((left, right) => left.offset - right.offset)
    .slice(0, input.limit)
    .map(({ event, offset }) => ({
      ...event,
      id: String(offset),
      sequence: offset
    }));
  return {
    events,
    terminal: TERMINAL_RUN_STATUSES.has(run.status)
  };
}
