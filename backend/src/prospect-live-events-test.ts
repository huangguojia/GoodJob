import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryStore } from "./store.js";
import { readProspectRunFeedMemory } from "./prospect-live-events.js";
import type {
  ProspectExecutionAttempt,
  ProspectSearchRun
} from "./types.js";

const original = {
  runs: structuredClone(memoryStore.prospectSearchRuns),
  shards: structuredClone(memoryStore.prospectRunShards),
  runEvents: structuredClone(memoryStore.prospectRunEvents),
  executionEvents: structuredClone(memoryStore.prospectExecutionEvents),
  pages: structuredClone(memoryStore.prospectExecutionPages),
  attempts: structuredClone(memoryStore.prospectExecutionAttempts),
  processing: structuredClone(memoryStore.prospectCandidateProcessingStates || []),
  missions: structuredClone(memoryStore.prospectSuperSearchMissions),
  rounds: structuredClone(memoryStore.prospectSuperSearchRounds),
  missionEvents: structuredClone(memoryStore.prospectSuperSearchEvents)
};

const now = "2026-07-26T08:00:00.000Z";
const runId = `pr_${randomUUID()}`;
const teamId = "team-live-feed-test";
const ownerId = "user-live-feed-test";
const campaignId = `pc_${randomUUID()}`;
const strategyId = `ps_${randomUUID()}`;
const run: ProspectSearchRun = {
  id: runId,
  teamId,
  campaignId,
  campaignVersion: 1,
  strategyId,
  ownerId,
  status: "running",
  revision: 2,
  executionEpoch: 1,
  operationCode: "create_search_run_v1",
  idempotencyKeyHash: "a".repeat(64),
  requestHash: "b".repeat(64),
  queryFingerprint: "c".repeat(64),
  executionSnapshot: {
    contractVersion: "search_run_control_plane_v1",
    campaign: {
      id: campaignId,
      name: "Feed test",
      version: 1,
      contentHash: "d".repeat(64),
      snapshot: {
        goal: "test",
        products: ["pump"],
        markets: ["DE"],
        customerTypes: ["distributor"],
        applicationScenarios: [],
        icpRules: [],
        exclusionRules: [],
        sourceProviderIds: ["gleif"]
      }
    },
    strategy: {
      id: strategyId,
      name: "Feed strategy",
      revision: 1,
      fingerprintVersion: "v1",
      queryFingerprint: "c".repeat(64),
      query: {
        keywordMode: "specific",
        positiveKeywords: ["pump"],
        synonyms: [],
        industryTerms: [],
        purchaseScenarioTerms: [],
        countryMode: "specific",
        countries: ["DE"],
        languages: ["de"],
        customerTypeMode: "specific",
        customerTypes: ["distributor"],
        exclusionKeywords: [],
        exclusionDomains: [],
        timeWindow: { mode: "all", from: "", to: "" }
      }
    },
    resolvedQuery: {
      positiveKeywords: ["pump"],
      synonyms: [],
      industryTerms: [],
      purchaseScenarioTerms: [],
      countries: ["DE"],
      languages: ["de"],
      customerTypes: ["distributor"],
      exclusionKeywords: [],
      exclusionDomains: [],
      timeWindow: { mode: "all", from: "", to: "" }
    },
    providerPlan: []
  },
  executionSnapshotHash: "e".repeat(64),
  queueBridgeVersion: "v1",
  parentRunId: "",
  createdBy: ownerId,
  createdAt: now,
  updatedAt: now,
  pausedAt: "",
  cancelledAt: ""
};

try {
  memoryStore.prospectSearchRuns.push(run);
  memoryStore.prospectRunEvents.push({
    id: `pre_${randomUUID()}`,
    teamId,
    runId,
    sequence: 1,
    eventType: "created",
    actorId: ownerId,
    requestId: "feed-test:create",
    fromStatus: "",
    toStatus: "queued",
    fromRevision: 0,
    toRevision: 1,
    reason: "任务事实已创建",
    createdAt: now
  });
  memoryStore.prospectExecutionPages.push({
    id: `pep_${randomUUID()}`,
    teamId,
    ownerId,
    runId,
    shardId: `prsh_${randomUUID()}`,
    jobId: `aj_${randomUUID()}`,
    attemptId: `pea_${randomUUID()}`,
    providerCode: "gleif",
    checkpointNo: 1,
    pageSequence: 1,
    payloadHash: "f".repeat(64),
    acceptedCount: 2,
    rawCount: 3,
    invalidCount: 1,
    duplicateCount: 0,
    partial: false,
    createdAt: now
  });
  (memoryStore.prospectCandidateProcessingStates ||= []).push({
    hitId: `psrh_${randomUUID()}`,
    teamId,
    ownerId,
    runId,
    ledgerId: `pprl_${randomUUID()}`,
    status: "completed",
    failureCode: "",
    candidateId: `lf_gleif_${randomUUID()}`,
    processedAt: now,
    updatedAt: now
  });

  const first = await readProspectRunFeedMemory(memoryStore, {
    teamId,
    runId,
    after: "0",
    limit: 100
  });
  assert.equal(first.terminal, false);
  assert.deepEqual(
    first.events.map((event) => event.type),
    ["candidate.persisted", "page.persisted", "run.created"].sort()
  );
  assert.equal(first.events.every((event, index) => event.sequence === index + 1), true);
  assert.equal(JSON.stringify(first.events).includes("encrypted"), false);
  assert.equal(JSON.stringify(first.events).includes("apiKey"), false);

  const cursor = first.events.at(-1)!.id;
  const replay = await readProspectRunFeedMemory(memoryStore, {
    teamId,
    runId,
    after: cursor,
    limit: 100
  });
  assert.equal(replay.events.length, 0);

  const attempt: ProspectExecutionAttempt = {
    id: `pea_${randomUUID()}`,
    teamId,
    ownerId,
    runId,
    shardId: `prsh_${randomUUID()}`,
    jobId: `aj_${randomUUID()}`,
    leaseId: `pel_${randomUUID()}`,
    providerCode: "gleif",
    checkpointNo: 1,
    checkpointCallNo: 1,
    providerAttemptNo: 1,
    status: "request_started",
    requestHash: "1".repeat(64),
    responseHash: "",
    errorCode: "",
    errorMessage: "",
    retryable: false,
    retryAfterAt: "",
    usageJson: "{}",
    costKind: "unknown",
    costAmount: null,
    currency: "",
    startedAt: now,
    finishedAt: "",
    createdAt: now,
    version: 1
  };
  memoryStore.prospectExecutionAttempts.push(attempt);
  const attemptStarted = await readProspectRunFeedMemory(memoryStore, {
    teamId,
    runId,
    after: cursor,
    limit: 100
  });
  assert.equal(attemptStarted.events.length, 1);
  assert.equal(attemptStarted.events[0].type, "attempt.request_started");

  attempt.status = "succeeded";
  attempt.responseHash = "2".repeat(64);
  attempt.costKind = "actual";
  attempt.costAmount = 0.01;
  attempt.currency = "USD";
  attempt.finishedAt = "2026-07-26T08:00:01.000Z";
  attempt.version = 2;
  const attemptFinished = await readProspectRunFeedMemory(memoryStore, {
    teamId,
    runId,
    after: attemptStarted.events[0].id,
    limit: 100
  });
  assert.equal(attemptFinished.events.length, 1);
  assert.equal(attemptFinished.events[0].type, "attempt.succeeded");
  assert.equal(attemptFinished.events[0].metrics.costAmount, 0.01);

  const missionId = `pssm_${randomUUID()}`;
  memoryStore.prospectSuperSearchMissions.push({
    id: missionId,
    teamId,
    ownerId,
    campaignId,
    strategyId,
    status: "running"
  } as any);
  memoryStore.prospectSuperSearchRounds.push({
    id: `pssr_${randomUUID()}`,
    missionId,
    teamId,
    ownerId,
    roundNo: 2,
    runId,
    roundKind: "deep_mining",
    queryCells: [],
    createdAt: now,
    completedAt: ""
  } as any);
  memoryStore.prospectSuperSearchEvents.push({
    id: `psse_${randomUUID()}`,
    missionId,
    teamId,
    ownerId,
    sequence: 1,
    type: "deep_evidence_found",
    message: "归档 2 条可追溯证据",
    metadata: { evidenceCount: 2, candidateId: "candidate-a" },
    createdAt: "2026-07-26T08:00:02.000Z"
  });
  const deepEvent = await readProspectRunFeedMemory(memoryStore, {
    teamId,
    runId,
    after: attemptFinished.events[0].id,
    limit: 100
  });
  assert.equal(deepEvent.events.length, 1);
  assert.equal(deepEvent.events[0].type, "mission.deep_evidence_found");
  assert.equal(deepEvent.events[0].stage, "deep_mining");
  assert.equal(deepEvent.events[0].metrics.evidenceCount, 2);

  const hidden = await readProspectRunFeedMemory(memoryStore, {
    teamId: "another-team",
    runId,
    after: "0",
    limit: 100
  });
  assert.equal(hidden.events.length, 0);

  run.status = "succeeded";
  const terminal = await readProspectRunFeedMemory(memoryStore, {
    teamId,
    runId,
    after: deepEvent.events[0].id,
    limit: 100
  });
  assert.equal(terminal.terminal, true);

  console.log("Prospect live event feed tests passed");
} finally {
  memoryStore.prospectSearchRuns.splice(0, memoryStore.prospectSearchRuns.length, ...original.runs);
  memoryStore.prospectRunShards.splice(0, memoryStore.prospectRunShards.length, ...original.shards);
  memoryStore.prospectRunEvents.splice(0, memoryStore.prospectRunEvents.length, ...original.runEvents);
  memoryStore.prospectExecutionEvents.splice(0, memoryStore.prospectExecutionEvents.length, ...original.executionEvents);
  memoryStore.prospectExecutionPages.splice(0, memoryStore.prospectExecutionPages.length, ...original.pages);
  memoryStore.prospectExecutionAttempts.splice(0, memoryStore.prospectExecutionAttempts.length, ...original.attempts);
  (memoryStore.prospectCandidateProcessingStates ||= []).splice(
    0,
    memoryStore.prospectCandidateProcessingStates!.length,
    ...original.processing
  );
  memoryStore.prospectSuperSearchMissions.splice(0, memoryStore.prospectSuperSearchMissions.length, ...original.missions);
  memoryStore.prospectSuperSearchRounds.splice(0, memoryStore.prospectSuperSearchRounds.length, ...original.rounds);
  memoryStore.prospectSuperSearchEvents.splice(0, memoryStore.prospectSuperSearchEvents.length, ...original.missionEvents);
}
