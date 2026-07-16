import { randomUUID } from "node:crypto";
import { validateProspectRunQueueBridge } from "./prospect-run-queue-bridge.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectRunEvent,
  ProspectSearchRun,
  ProspectSearchRunStatus
} from "./types.js";

const ACTIVE_RUN_STATUSES = new Set<ProspectSearchRunStatus>([
  "queued",
  "running",
  "pause_requested",
  "paused",
  "cancel_requested"
]);

export function isActiveProspectRun(run: ProspectSearchRun) {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

export function activeProspectRunsForCampaign(
  store: CrmStore,
  teamId: string,
  campaignId: string
) {
  return store.prospectSearchRuns.filter((run) =>
    run.teamId === teamId
    && run.campaignId === campaignId
    && isActiveProspectRun(run)
  );
}

export function activeProspectRunsForStrategy(
  store: CrmStore,
  teamId: string,
  strategyId: string
) {
  return store.prospectSearchRuns.filter((run) =>
    run.teamId === teamId
    && run.strategyId === strategyId
    && isActiveProspectRun(run)
  );
}

export function activeProspectRunsForOwner(
  store: CrmStore,
  teamId: string,
  ownerId: string
) {
  return store.prospectSearchRuns.filter((run) =>
    run.teamId === teamId
    && run.ownerId === ownerId
    && isActiveProspectRun(run)
  );
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

function runEvent(input: {
  store: CrmStore;
  run: ProspectSearchRun;
  actorId: string;
  requestId: string;
  fromStatus: ProspectSearchRunStatus;
  fromRevision: number;
  reason: string;
}) {
  return {
    id: `pre_${randomUUID()}`,
    teamId: input.run.teamId,
    runId: input.run.id,
    sequence: nextEventSequence(input.store, input.run),
    eventType: "paused",
    actorId: input.actorId,
    requestId: input.requestId,
    fromStatus: input.fromStatus,
    toStatus: "paused",
    fromRevision: input.fromRevision,
    toRevision: input.run.revision,
    reason: input.reason,
    createdAt: input.run.updatedAt
  } satisfies ProspectRunEvent;
}

export function pauseQueuedProspectRunsForCampaign(input: {
  store: CrmStore;
  teamId: string;
  campaignId: string;
  actorId: string;
  requestId: string;
  reason: string;
  now?: string;
}) {
  const now = input.now || new Date().toISOString();
  const queuedRuns = input.store.prospectSearchRuns.filter((run) =>
    run.teamId === input.teamId
    && run.campaignId === input.campaignId
    && run.status === "queued"
  );
  queuedRuns.forEach((run) =>
    validateProspectRunQueueBridge(input.store, run)
  );
  for (const run of queuedRuns) {
    const previousStatus = run.status;
    const previousRevision = run.revision;
    run.status = "paused";
    run.revision += 1;
    run.pausedAt = now;
    run.updatedAt = now;
    for (const shard of input.store.prospectRunShards) {
      if (shard.teamId !== run.teamId || shard.runId !== run.id) continue;
      if (shard.status === "queued") {
        shard.status = "paused";
        shard.updatedAt = now;
      }
    }
    input.store.prospectRunEvents.push(runEvent({
      store: input.store,
      run,
      actorId: input.actorId,
      requestId: input.requestId,
      fromStatus: previousStatus,
      fromRevision: previousRevision,
      reason: input.reason
    }));
  }
  return queuedRuns;
}
