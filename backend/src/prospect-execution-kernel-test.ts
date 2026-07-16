import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  ProspectExecutionKernel,
  ProspectExecutionKernelError
} from "./prospect-execution-kernel.js";
import {
  DeterministicFakeProspectProvider
} from "./prospect-fake-provider.js";
import {
  prospectProviderResponseComponentHashes,
  prospectProviderResponseHash
} from "./prospect-provider-request-ledger.js";
import type {
  FakeProspectProviderDispatchRequest,
  FakeProspectProviderRequest
} from "./prospect-fake-provider.js";
import {
  registerProspectRunQueueBridge,
  validateProspectRunQueueBridge
} from "./prospect-run-queue-bridge.js";
import {
  prospectRunExecutionSnapshotHash
} from "./prospect-runs.js";
import { getStore } from "./store.js";
import type {
  ProspectRunExecutionSnapshot,
  ProspectSearchRun,
  ProspectStrategyQuery,
  User
} from "./types.js";

const store = getStore();
const original = {
  users: structuredClone(store.users),
  runs: structuredClone(store.prospectSearchRuns),
  shards: structuredClone(store.prospectRunShards),
  runEvents: structuredClone(store.prospectRunEvents),
  jobs: structuredClone(store.agentJobs),
  parentBindings: structuredClone(store.prospectRunQueueParentBindings),
  childBindings: structuredClone(store.prospectRunQueueChildBindings),
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

function clearExecutionState() {
  store.prospectSearchRuns.length = 0;
  store.prospectRunShards.length = 0;
  store.prospectRunEvents.length = 0;
  store.agentJobs.length = 0;
  store.prospectRunQueueParentBindings.length = 0;
  store.prospectRunQueueChildBindings.length = 0;
  store.prospectExecutionKernelStates.length = 0;
  store.prospectExecutionCheckpoints.length = 0;
  store.prospectStrategySourcePositions.length = 0;
  store.prospectExecutionLeases.length = 0;
  store.prospectExecutionAttempts.length = 0;
  store.prospectProviderRequestLedgers.length = 0;
  store.prospectProviderRequestDispatches.length = 0;
  store.prospectProviderRequestEvents.length = 0;
  store.prospectProviderRequestAttemptBindings.length = 0;
  store.prospectProviderRequestAccountingEvidence.length = 0;
  store.prospectSourceRawBatches.length = 0;
  store.prospectSourceRawRecords.length = 0;
  store.prospectSourceRawHits.length = 0;
  store.prospectExecutionPages.length = 0;
  store.prospectExecutionEvents.length = 0;
  store.prospectExecutionThrottleBuckets.length = 0;
}

function executionStateSnapshot() {
  return {
    runs: structuredClone(store.prospectSearchRuns),
    shards: structuredClone(store.prospectRunShards),
    runEvents: structuredClone(store.prospectRunEvents),
    jobs: structuredClone(store.agentJobs),
    parentBindings: structuredClone(store.prospectRunQueueParentBindings),
    childBindings: structuredClone(store.prospectRunQueueChildBindings),
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

class DelayedFakeProspectProvider
  extends DeterministicFakeProspectProvider {
  constructor(
    scripts: ConstructorParameters<
      typeof DeterministicFakeProspectProvider
    >[0],
    private readonly delayMs: number
  ) {
    super(scripts);
  }

  override async search(request: FakeProspectProviderRequest) {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.search(request);
  }
}

class InspectingFakeProspectProvider
  extends DeterministicFakeProspectProvider {
  constructor(
    scripts: ConstructorParameters<
      typeof DeterministicFakeProspectProvider
    >[0],
    private readonly inspect: (
      request: FakeProspectProviderDispatchRequest
    ) => void
  ) {
    super(scripts);
  }

  override async dispatch(
    request: FakeProspectProviderDispatchRequest
  ) {
    this.inspect(request);
    return super.dispatch(request);
  }
}

function owner(): User {
  const existing = store.users.find((item) =>
    item.status === "active"
    && item.role !== "super_admin"
    && item.teamId !== "all"
  );
  if (existing) return existing;
  const created: User = {
    id: `u_test_${randomUUID()}`,
    name: "Kernel Test",
    email: `kernel-${randomUUID()}@example.test`,
    password: "test-only",
    role: "sales",
    teamId: "kernel-test-team",
    avatar: "KT",
    status: "active",
    authVersion: 1
  };
  store.users.push(created);
  return created;
}

function snapshot(providerCodes: string[]): ProspectRunExecutionSnapshot {
  const query: ProspectStrategyQuery = {
    keywordMode: "specific",
    positiveKeywords: ["industrial lighting"],
    synonyms: [],
    industryTerms: [],
    purchaseScenarioTerms: [],
    countryMode: "global",
    countries: [],
    languages: ["en"],
    customerTypeMode: "all",
    customerTypes: [],
    exclusionKeywords: [],
    exclusionDomains: [],
    timeWindow: { mode: "all", from: "", to: "" }
  };
  return {
    contractVersion: "search_run_control_plane_v1",
    campaign: {
      id: `pcg_${randomUUID()}`,
      name: "Kernel test campaign",
      version: 1,
      contentHash: "a".repeat(64),
      snapshot: {
        goal: "test",
        products: ["industrial lighting"],
        markets: [],
        customerTypes: [],
        applicationScenarios: [],
        icpRules: [],
        exclusionRules: [],
        sourceProviderIds: providerCodes
      }
    },
    strategy: {
      id: `pstr_${randomUUID()}`,
      name: "Kernel test strategy",
      revision: 1,
      fingerprintVersion: "v1",
      queryFingerprint: "b".repeat(64),
      query
    },
    resolvedQuery: {
      positiveKeywords: [...query.positiveKeywords],
      synonyms: [],
      industryTerms: [],
      purchaseScenarioTerms: [],
      countries: [],
      languages: [...query.languages],
      customerTypes: [],
      exclusionKeywords: [],
      exclusionDomains: [],
      timeWindow: { ...query.timeWindow }
    },
    providerPlan: providerCodes.map((providerCode, index) => ({
      providerCode,
      position: index + 1,
      priority: 50,
      pageLimit: 2,
      resultLimit: 20,
      budgetLimit: null,
      currency: "",
      adapterVersion: "fake-v1",
      contractVersion: "provider-search-v1",
      catalogVersion: "test-v1",
      capabilities: ["company_search"],
      accessMode: "api"
    }))
  };
}

function createRun(
  runOwner: User,
  providerCodes: string[],
  sourceSnapshot?: ProspectRunExecutionSnapshot
) {
  const now = "2026-07-14T00:00:00.000Z";
  const executionSnapshot = sourceSnapshot
    ? structuredClone(sourceSnapshot)
    : snapshot(providerCodes);
  const run: ProspectSearchRun = {
    id: `pr_${randomUUID()}`,
    teamId: runOwner.teamId,
    campaignId: executionSnapshot.campaign.id,
    campaignVersion: executionSnapshot.campaign.version,
    strategyId: executionSnapshot.strategy.id,
    ownerId: runOwner.id,
    status: "queued",
    revision: 1,
    executionEpoch: 1,
    operationCode: "create_search_run_v1",
    idempotencyKeyHash: "c".repeat(64),
    requestHash: "d".repeat(64),
    queryFingerprint: executionSnapshot.strategy.queryFingerprint,
    executionSnapshot,
    executionSnapshotHash:
      prospectRunExecutionSnapshotHash(executionSnapshot),
    queueBridgeVersion: "v1",
    parentRunId: "",
    createdBy: runOwner.id,
    createdAt: now,
    updatedAt: now,
    pausedAt: "",
    cancelledAt: ""
  };
  store.prospectSearchRuns.push(run);
  for (const provider of executionSnapshot.providerPlan) {
    store.prospectRunShards.push({
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
      capabilities: provider.capabilities,
      accessMode: provider.accessMode,
      hasCursor: false,
      createdAt: now,
      updatedAt: now
    });
  }
  store.prospectRunEvents.push({
    id: `pre_${randomUUID()}`,
    teamId: run.teamId,
    runId: run.id,
    sequence: 1,
    eventType: "created",
    actorId: runOwner.id,
    requestId: `test:${run.id}`,
    fromStatus: "",
    toStatus: "queued",
    fromRevision: 0,
    toRevision: 1,
    reason: "test",
    createdAt: now
  });
  registerProspectRunQueueBridge(store, run);
  return run;
}

function repeatedRun(
  runOwner: User,
  sourceRun: ProspectSearchRun,
  mutateSnapshot?: (value: ProspectRunExecutionSnapshot) => void
) {
  const executionSnapshot = structuredClone(sourceRun.executionSnapshot);
  mutateSnapshot?.(executionSnapshot);
  return createRun(
    runOwner,
    executionSnapshot.providerPlan.map((item) => item.providerCode),
    executionSnapshot
  );
}

try {
  clearExecutionState();
  const runOwner = owner();
  const run = createRun(runOwner, ["fake.alpha", "fake.beta"]);
  assert.throws(
    () => new ProspectExecutionKernel({
      store,
      workerId: "worker-1",
      allowedRunIds: [],
      claimSecret: "s".repeat(32)
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_ALLOWED_RUNS_REQUIRED"
  );
  assert.throws(
    () => new ProspectExecutionKernel({
      store,
      workerId: "worker-1",
      allowedRunIds: [run.id],
      claimSecret: "s".repeat(32),
      providerRequestIdempotencySecret: "weak"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_IDEMPOTENCY_SECRET_WEAK"
  );
  assert.throws(
    () => new ProspectExecutionKernel({
      store,
      workerId: "worker-1",
      allowedRunIds: [run.id],
      claimSecret: "s".repeat(32),
      providerRequestEnvelopeSecret: "weak"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_ENVELOPE_SECRET_WEAK"
  );
  assert.throws(
    () => new ProspectExecutionKernel({
      store,
      workerId: "worker-1",
      allowedRunIds: [run.id],
      claimSecret: "s".repeat(32),
      providerResponseEnvelopeSecret: "weak"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RESPONSE_ENVELOPE_SECRET_WEAK"
  );

  const kernel = new ProspectExecutionKernel({
    store,
    workerId: "worker-1",
    allowedRunIds: [run.id],
    claimSecret: "s".repeat(32),
    leaseMs: 5_000,
    deadlineMs: 20_000
  });
  const state = await kernel.start("2026-07-14T00:00:01.000Z");
  assert.equal(state.kernelEpoch, 1);
  const first = await kernel.claimNext("2026-07-14T00:00:02.000Z");
  assert.ok(first);
  assert.equal(first.shard.providerCode, "fake.alpha");
  assert.equal(first.job.status, "running");
  assert.equal(store.prospectSearchRuns[0]?.status, "running");
  assert.equal(store.prospectExecutionAttempts.length, 1);
  assert.equal(store.prospectExecutionAttempts[0]?.status, "claimed");
  assert.equal(store.prospectExecutionAttempts[0]?.providerAttemptNo, 0);
  assert.equal(store.prospectExecutionLeases.length, 1);
  assert.equal(store.prospectExecutionLeases[0]?.claimTokenHmac.includes(
    first.claimToken
  ), false);
  assert.equal(
    await kernel.claimNext("2026-07-14T00:00:03.000Z"),
    null,
    "同一 Run 有活动租约时不能领取第二个子任务"
  );
  const heartbeat = await kernel.heartbeat({
    leaseId: first.lease.id,
    claimToken: first.claimToken,
    now: "2026-07-14T00:00:04.000Z"
  });
  assert.equal(heartbeat.expiresAt, "2026-07-14T00:00:09.000Z");
  await assert.rejects(
    kernel.heartbeat({
      leaseId: first.lease.id,
      claimToken: "invalid-token",
      now: "2026-07-14T00:00:05.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_CLAIM_TOKEN_INVALID"
  );

  const restarted = new ProspectExecutionKernel({
    store,
    workerId: "worker-2",
    allowedRunIds: [run.id],
    claimSecret: "s".repeat(32)
  });
  const restartedState = await restarted.start("2026-07-14T00:00:06.000Z");
  assert.equal(restartedState.kernelEpoch, 2);
  assert.equal(store.prospectExecutionLeases[0]?.status, "expired");
  assert.equal(store.prospectRunShards[0]?.status, "queued");
  assert.equal(store.agentJobs.find((item) =>
    item.id === first.job.id
  )?.status, "queued");
  const reclaimed = await restarted.claimNext(
    "2026-07-14T00:00:07.000Z"
  );
  assert.ok(reclaimed);
  assert.equal(reclaimed.job.id, first.job.id);
  assert.equal(reclaimed.lease.fenceToken, 2);
  assert.equal(store.prospectExecutionAttempts.length, 2);
  assert.equal(store.prospectExecutionAttempts[0]?.status, "failed");
  assert.equal(store.prospectExecutionAttempts[0]?.providerAttemptNo, 0);
  assert.doesNotThrow(() => validateProspectRunQueueBridge(store, run));

  const executionKernel = new ProspectExecutionKernel({
    store,
    workerId: "worker-3",
    allowedRunIds: [run.id],
    claimSecret: "s".repeat(32)
  });
  await executionKernel.start("2026-07-14T00:00:08.000Z");
  const provider = new DeterministicFakeProspectProvider({
    "fake.alpha": [
      {
        kind: "success",
        acceptedCount: 2,
        rawCount: 3,
        invalidCount: 1,
        duplicateCount: 0,
        hasMore: true,
        cursor: "secret-alpha-cursor",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 3 },
        cost: { kind: "estimated", amount: 0.01, currency: "USD" }
      },
      {
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "actual", amount: 0.02, currency: "USD" }
      }
    ],
    "fake.beta": [
      {
        kind: "failure",
        errorCode: "PROVIDER_RATE_LIMITED",
        errorMessage: "rate limited",
        retryable: true,
        retryAfterAt: "2026-07-14T00:00:20.000Z",
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "unknown", amount: null, currency: "" }
      },
      {
        kind: "failure",
        errorCode: "PROVIDER_TIMEOUT",
        errorMessage: "timeout",
        retryable: true,
        retryAfterAt: "2026-07-14T00:00:30.000Z",
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "estimated", amount: 0.01, currency: "USD" }
      },
      {
        kind: "success",
        acceptedCount: 0,
        rawCount: 0,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "actual", amount: 0, currency: "USD" }
      }
    ]
  });
  assert.equal(
    (await executionKernel.executeNext(
      provider,
      "2026-07-14T00:00:09.000Z"
    )).kind,
    "success"
  );
  const alphaCheckpoint = store.prospectExecutionCheckpoints.find((item) =>
    item.runId === run.id && item.providerCode === "fake.alpha"
  )!;
  assert.equal(alphaCheckpoint.checkpointNo, 2);
  assert.equal(alphaCheckpoint.checkpointCallCount, 0);
  assert.equal(alphaCheckpoint.acceptedCount, 2);
  assert.ok(alphaCheckpoint.encryptedCursor);
  assert.equal(
    alphaCheckpoint.encryptedCursor.includes("secret-alpha-cursor"),
    false
  );
  assert.equal(
    (await executionKernel.executeNext(
      provider,
      "2026-07-14T00:00:10.000Z"
    )).kind,
    "success"
  );
  assert.equal(
    store.prospectRunShards.find((item) =>
      item.runId === run.id && item.providerCode === "fake.alpha"
    )?.status,
    "succeeded"
  );
  const firstBeta = await executionKernel.executeNext(
    provider,
    "2026-07-14T00:00:11.000Z"
  );
  assert.equal(firstBeta.kind, "failure");
  assert.equal(
    store.prospectExecutionCheckpoints.find((item) =>
      item.runId === run.id && item.providerCode === "fake.beta"
    )?.checkpointCallCount,
    1
  );
  assert.equal(
    (await executionKernel.executeNext(
      provider,
      "2026-07-14T00:00:12.000Z"
    )).kind,
    "idle",
    "retryAfterAt 到达前不能再次调用 Provider"
  );
  assert.equal(
    (await executionKernel.executeNext(
      provider,
      "2026-07-14T00:00:20.000Z"
    )).kind,
    "failure"
  );
  assert.equal(
    (await executionKernel.executeNext(
      provider,
      "2026-07-14T00:00:30.000Z"
    )).kind,
    "success"
  );
  const betaCheckpoint = store.prospectExecutionCheckpoints.find((item) =>
    item.runId === run.id && item.providerCode === "fake.beta"
  )!;
  assert.equal(betaCheckpoint.checkpointCallCount, 3);
  assert.equal(store.prospectSearchRuns[0]?.status, "succeeded");
  assert.equal(store.prospectExecutionPages.length, 3);
  assert.equal(
    store.prospectExecutionPages.reduce(
      (sum, item) => sum + item.acceptedCount,
      0
    ),
    3
  );
  assert.equal(
    store.prospectExecutionAttempts.filter((item) =>
      item.providerAttemptNo > 0
    ).length,
    5
  );
  assert.equal(JSON.stringify(store.prospectExecutionPages).includes(
    "secret-alpha-cursor"
  ), false);
  assert.doesNotThrow(() => validateProspectRunQueueBridge(store, run));

  const prepareRun = createRun(runOwner, ["fake.prepare"]);
  const prepareKernel = new ProspectExecutionKernel({
    store,
    workerId: "prepare-worker",
    allowedRunIds: [prepareRun.id],
    claimSecret: "g".repeat(32),
    providerRequestIdempotencySecret: "i".repeat(32),
    providerRequestEnvelopeSecret: "e".repeat(32)
  });
  await prepareKernel.start("2026-07-14T00:10:00.000Z");
  const prepareProvider = new DeterministicFakeProspectProvider({
    "fake.prepare": [{
      kind: "success",
      acceptedCount: 1,
      rawCount: 1,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: false,
      cursor: "",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 1 },
      cost: { kind: "unknown", amount: null, currency: "" }
    }]
  });
  const prepareClaim = await prepareKernel.claimNext(
    "2026-07-14T00:10:01.000Z"
  );
  assert.ok(prepareClaim);
  const prepareCheckpoint =
    store.prospectExecutionCheckpoints.find((item) =>
      item.runId === prepareRun.id
    )!;
  const prepareJob = store.agentJobs.find((item) =>
    item.id === prepareClaim.job.id
  )!;
  const throttleCountBeforePrepare =
    store.prospectExecutionThrottleBuckets.length;
  const prepared = await prepareKernel.prepareProviderRequest({
    leaseId: prepareClaim.lease.id,
    claimToken: prepareClaim.claimToken,
    now: "2026-07-14T00:10:02.000Z"
  });
  assert.equal(prepared.ledger.status, "prepared");
  assert.equal(prepared.ledger.teamId, runOwner.teamId);
  assert.equal(prepared.ledger.ownerId, runOwner.id);
  assert.equal(prepared.ledger.originAttemptId, prepareClaim.attempt.id);
  assert.equal(prepared.ledger.logicalRequestNo, 1);
  assert.equal(prepared.providerRequest.checkpointCallNo, 1);
  assert.equal(prepared.dispatchRequest.connectionId, "fake:fake.prepare");
  assert.equal(
    prepared.dispatchRequest.endpointCode,
    "company-search"
  );
  assert.equal(
    store.prospectProviderRequestLedgers.filter((item) =>
      item.runId === prepareRun.id
    ).length,
    1
  );
  assert.equal(
    store.prospectProviderRequestAttemptBindings.filter((item) =>
      item.ledgerId === prepared.ledger.id
    ).length,
    1
  );
  assert.deepEqual(
    store.prospectProviderRequestEvents
      .filter((item) => item.ledgerId === prepared.ledger.id)
      .map((item) => [item.sequence, item.eventType]),
    [[1, "prepared"]]
  );
  assert.equal(prepareProvider.listPhysicalCalls().length, 0);
  assert.equal(prepareClaim.attempt.status, "claimed");
  assert.equal(
    store.prospectExecutionAttempts.find((item) =>
      item.id === prepareClaim.attempt.id
    )?.status,
    "claimed"
  );
  assert.equal(
    store.prospectExecutionLeases.find((item) =>
      item.id === prepareClaim.lease.id
    )?.requestStartedAt,
    ""
  );
  assert.equal(prepareCheckpoint.totalCallCount, 0);
  assert.equal(prepareCheckpoint.checkpointCallCount, 0);
  assert.equal(prepareJob.attemptCount, 0);
  assert.equal(
    store.prospectExecutionThrottleBuckets.length,
    throttleCountBeforePrepare
  );
  assert.equal(
    prepared.ledger.encryptedRequestEnvelope.includes(
      "industrial lighting"
    ),
    false
  );
  const preparedAgain = await prepareKernel.prepareProviderRequest({
    leaseId: prepareClaim.lease.id,
    claimToken: prepareClaim.claimToken,
    now: "2026-07-14T00:10:03.000Z"
  });
  assert.equal(preparedAgain.ledger.id, prepared.ledger.id);
  assert.equal(
    store.prospectProviderRequestLedgers.filter((item) =>
      item.runId === prepareRun.id
    ).length,
    1
  );
  assert.equal(
    store.prospectProviderRequestAttemptBindings.filter((item) =>
      item.ledgerId === prepared.ledger.id
    ).length,
    1
  );
  assert.equal(
    store.prospectProviderRequestEvents.filter((item) =>
      item.ledgerId === prepared.ledger.id
    ).length,
    1
  );
  await prepareKernel.requestPause(
    prepareRun.id,
    "2026-07-14T00:10:04.000Z"
  );
  assert.equal(prepareRun.status, "paused");
  assert.equal(
    store.prospectProviderRequestLedgers.find((item) =>
      item.id === prepared.ledger.id
    )?.status,
    "prepared"
  );
  await assert.rejects(
    prepareKernel.dispatchPreparedProviderRequest(prepareProvider, {
      leaseId: prepareClaim.lease.id,
      claimToken: prepareClaim.claimToken,
      ledgerId: prepared.ledger.id,
      now: "2026-07-14T00:10:04.500Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_LEASE_NOT_ACTIVE"
  );
  assert.equal(prepareProvider.listPhysicalCalls().length, 0);
  await prepareKernel.resume(
    prepareRun.id,
    "2026-07-14T00:10:05.000Z"
  );
  const resumedPrepareClaim = await prepareKernel.claimNext(
    "2026-07-14T00:10:06.000Z"
  );
  assert.ok(resumedPrepareClaim);
  const reboundPrepared = await prepareKernel.prepareProviderRequest({
    leaseId: resumedPrepareClaim.lease.id,
    claimToken: resumedPrepareClaim.claimToken,
    now: "2026-07-14T00:10:07.000Z"
  });
  assert.equal(reboundPrepared.ledger.id, prepared.ledger.id);
  assert.deepEqual(
    store.prospectProviderRequestAttemptBindings
      .filter((item) => item.ledgerId === prepared.ledger.id)
      .map((item) => item.bindingNo),
    [1, 2]
  );
  await prepareKernel.requestCancel(
    prepareRun.id,
    "2026-07-14T00:10:08.000Z"
  );
  const cancelledPreparedLedger =
    store.prospectProviderRequestLedgers.find((item) =>
      item.id === prepared.ledger.id
    )!;
  assert.equal(cancelledPreparedLedger.status, "settled");
  assert.equal(
    cancelledPreparedLedger.settlementKind,
    "cancelled_before_dispatch"
  );
  assert.equal(cancelledPreparedLedger.dispatchStartedAt, "");
  assert.ok(cancelledPreparedLedger.settlementHash);
  assert.deepEqual(
    store.prospectProviderRequestEvents
      .filter((item) => item.ledgerId === prepared.ledger.id)
      .map((item) => [item.sequence, item.fromStatus, item.toStatus]),
    [
      [1, "", "prepared"],
      [2, "prepared", "settled"]
    ]
  );
  await assert.rejects(
    prepareKernel.dispatchPreparedProviderRequest(prepareProvider, {
      leaseId: resumedPrepareClaim.lease.id,
      claimToken: resumedPrepareClaim.claimToken,
      ledgerId: prepared.ledger.id,
      now: "2026-07-14T00:10:09.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_LEASE_NOT_ACTIVE"
  );
  assert.equal(prepareProvider.listPhysicalCalls().length, 0);

  const cursorPrepareRun = createRun(
    runOwner,
    ["fake.prepare-cursor"]
  );
  const cursorPrepareKernel = new ProspectExecutionKernel({
    store,
    workerId: "prepare-cursor-worker",
    allowedRunIds: [cursorPrepareRun.id],
    claimSecret: "h".repeat(32),
    cursorSecret: "c".repeat(32),
    providerRequestEnvelopeSecret: "n".repeat(32)
  });
  await cursorPrepareKernel.start("2026-07-14T00:20:00.000Z");
  const cursorPrepareProvider = new DeterministicFakeProspectProvider({
    "fake.prepare-cursor": [{
      kind: "success",
      acceptedCount: 1,
      rawCount: 1,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: true,
      cursor: "prepare-private-cursor",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 1 },
      cost: { kind: "unknown", amount: null, currency: "" }
    }]
  });
  assert.equal(
    (
      await cursorPrepareKernel.executeNext(
        cursorPrepareProvider,
        "2026-07-14T00:20:01.000Z"
      )
    ).kind,
    "success"
  );
  const cursorPrepareClaim = await cursorPrepareKernel.claimNext(
    "2026-07-14T00:20:02.000Z"
  );
  assert.ok(cursorPrepareClaim);
  const cursorCheckpoint =
    store.prospectExecutionCheckpoints.find((item) =>
      item.runId === cursorPrepareRun.id
    )!;
  const cursorJob = store.agentJobs.find((item) =>
    item.id === cursorPrepareClaim.job.id
  )!;
  const cursorCountsBefore = {
    total: cursorCheckpoint.totalCallCount,
    checkpoint: cursorCheckpoint.checkpointCallCount,
    attempts: cursorJob.attemptCount
  };
  const cursorPrepared =
    await cursorPrepareKernel.prepareProviderRequest({
      leaseId: cursorPrepareClaim.lease.id,
      claimToken: cursorPrepareClaim.claimToken,
      now: "2026-07-14T00:20:03.000Z"
    });
  assert.equal(
    cursorPrepared.providerRequest.cursor,
    "prepare-private-cursor"
  );
  assert.equal(
    cursorPrepared.ledger.encryptedRequestEnvelope.includes(
      "prepare-private-cursor"
    ),
    false
  );
  assert.equal(
    cursorPrepared.ledger.encryptedRequestEnvelope.includes(
      "industrial lighting"
    ),
    false
  );
  assert.deepEqual({
    total: cursorCheckpoint.totalCallCount,
    checkpoint: cursorCheckpoint.checkpointCallCount,
    attempts: cursorJob.attemptCount
  }, cursorCountsBefore);
  assert.equal(cursorPrepareProvider.listPhysicalCalls().length, 0);
  await cursorPrepareKernel.requestCancel(
    cursorPrepareRun.id,
    "2026-07-14T00:20:04.000Z"
  );

  const prepareRollbackRun = createRun(
    runOwner,
    ["fake.prepare-rollback"]
  );
  const prepareRollbackKernel = new ProspectExecutionKernel({
    store,
    workerId: "prepare-rollback-worker",
    allowedRunIds: [prepareRollbackRun.id],
    claimSecret: "j".repeat(32)
  });
  await prepareRollbackKernel.start("2026-07-14T00:30:00.000Z");
  const prepareRollbackClaim = await prepareRollbackKernel.claimNext(
    "2026-07-14T00:30:01.000Z"
  );
  assert.ok(prepareRollbackClaim);
  const beforePreparePersistenceFailure = executionStateSnapshot();
  const originalPersist = store.persist;
  store.persist = async () => {
    throw new Error("forced Provider preparation persistence failure");
  };
  try {
    await assert.rejects(
      prepareRollbackKernel.prepareProviderRequest({
        leaseId: prepareRollbackClaim.lease.id,
        claimToken: prepareRollbackClaim.claimToken,
        now: "2026-07-14T00:30:02.000Z"
      }),
      /forced Provider preparation persistence failure/
    );
  } finally {
    store.persist = originalPersist;
  }
  assert.deepEqual(
    executionStateSnapshot(),
    beforePreparePersistenceFailure
  );
  await prepareRollbackKernel.requestCancel(
    prepareRollbackRun.id,
    "2026-07-14T00:30:03.000Z"
  );

  const dispatchRollbackRun = createRun(
    runOwner,
    ["fake.dispatch-rollback"]
  );
  const dispatchRollbackKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-rollback-worker",
    allowedRunIds: [dispatchRollbackRun.id],
    claimSecret: "k".repeat(32)
  });
  await dispatchRollbackKernel.start("2026-07-14T00:31:00.000Z");
  const dispatchRollbackClaim = await dispatchRollbackKernel.claimNext(
    "2026-07-14T00:31:01.000Z"
  );
  assert.ok(dispatchRollbackClaim);
  const dispatchRollbackPrepared =
    await dispatchRollbackKernel.prepareProviderRequest({
      leaseId: dispatchRollbackClaim.lease.id,
      claimToken: dispatchRollbackClaim.claimToken,
      now: "2026-07-14T00:31:02.000Z"
    });
  const dispatchRollbackProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-rollback": [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "unknown", amount: null, currency: "" }
      }]
    });
  const beforeDispatchPersistenceFailure = executionStateSnapshot();
  store.persist = async () => {
    throw new Error("forced Provider dispatch persistence failure");
  };
  try {
    await assert.rejects(
      dispatchRollbackKernel.dispatchPreparedProviderRequest(
        dispatchRollbackProvider,
        {
          leaseId: dispatchRollbackClaim.lease.id,
          claimToken: dispatchRollbackClaim.claimToken,
          ledgerId: dispatchRollbackPrepared.ledger.id,
          now: "2026-07-14T00:31:03.000Z"
        }
      ),
      /forced Provider dispatch persistence failure/
    );
  } finally {
    store.persist = originalPersist;
  }
  assert.deepEqual(
    executionStateSnapshot(),
    beforeDispatchPersistenceFailure
  );
  assert.equal(dispatchRollbackProvider.listPhysicalCalls().length, 0);
  await dispatchRollbackKernel.requestCancel(
    dispatchRollbackRun.id,
    "2026-07-14T00:31:04.000Z"
  );

  const dispatchRun = createRun(
    runOwner,
    ["fake.dispatch-confirmed"]
  );
  const dispatchKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-worker",
    allowedRunIds: [dispatchRun.id],
    claimSecret: "m".repeat(32),
    providerRequestIdempotencySecret: "q".repeat(32),
    providerRequestEnvelopeSecret: "r".repeat(32),
    providerRawEnvelopeSecret: "v".repeat(32),
    providerRawIdentitySecret: "w".repeat(32),
    providerRawPolicies: {
      "fake.dispatch-confirmed": {
        licensePolicy: "test-public-api",
        retentionPolicy: "test-30-days",
        retentionDays: 30
      }
    }
  });
  await dispatchKernel.start("2026-07-14T00:32:00.000Z");
  const dispatchClaim = await dispatchKernel.claimNext(
    "2026-07-14T00:32:01.000Z"
  );
  assert.ok(dispatchClaim);
  const dispatchPrepared =
    await dispatchKernel.prepareProviderRequest({
      leaseId: dispatchClaim.lease.id,
      claimToken: dispatchClaim.claimToken,
      now: "2026-07-14T00:32:02.000Z"
    });
  const dispatchCheckpoint =
    store.prospectExecutionCheckpoints.find((item) =>
      item.runId === dispatchRun.id
    )!;
  const dispatchJob = store.agentJobs.find((item) =>
    item.id === dispatchClaim.job.id
  )!;
  const dispatchCountersBefore = {
    total: dispatchCheckpoint.totalCallCount,
    checkpoint: dispatchCheckpoint.checkpointCallCount,
    attempts: dispatchJob.attemptCount
  };
  let observedDurableDispatchStart = false;
  const dispatchProvider = new InspectingFakeProspectProvider({
    "fake.dispatch-confirmed": [{
      kind: "success",
      acceptedCount: 2,
      rawCount: 2,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: false,
      cursor: "",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 2 },
      cost: { kind: "actual", amount: 0.02, currency: "USD" },
      responseSchemaVersion: "fake-provider-source-records-v1",
      sourceRecords: [
        {
          providerRecordId: "company-001",
          sourceUrl: "https://example.test/company/001",
          fetchedAt: "2026-07-14T00:31:58.000Z",
          payload: {
            companyName: "Example Industrial Lighting GmbH",
            country: "DE"
          }
        },
        {
          providerRecordId: "company-002",
          sourceUrl: "https://example.test/company/002",
          fetchedAt: "2026-07-14T00:31:59.000Z",
          payload: {
            companyName: "Example Warehouse Systems AG",
            country: "DE"
          }
        }
      ]
    }]
  }, (request) => {
    const persistedLedger =
      store.prospectProviderRequestLedgers.find((item) =>
        item.id === dispatchPrepared.ledger.id
      );
    const persistedDispatch =
      store.prospectProviderRequestDispatches.find((item) =>
        item.ledgerId === dispatchPrepared.ledger.id
      );
    const persistedAttempt =
      store.prospectExecutionAttempts.find((item) =>
        item.id === dispatchClaim.attempt.id
      );
    const persistedLease =
      store.prospectExecutionLeases.find((item) =>
        item.id === dispatchClaim.lease.id
      );
    assert.equal(persistedLedger?.status, "dispatch_started");
    assert.equal(persistedDispatch?.status, "started");
    assert.equal(persistedAttempt?.status, "request_started");
    assert.equal(persistedAttempt?.requestHash, request.requestHash);
    assert.equal(
      persistedLease?.requestStartedAt,
      "2026-07-14T00:32:03.000Z"
    );
    observedDurableDispatchStart = true;
  });
  const dispatchResult =
    await dispatchKernel.dispatchPreparedProviderRequest(
      dispatchProvider,
      {
        leaseId: dispatchClaim.lease.id,
        claimToken: dispatchClaim.claimToken,
        ledgerId: dispatchPrepared.ledger.id,
        now: "2026-07-14T00:32:03.000Z"
      }
    );
  assert.equal(dispatchResult.kind, "response_received");
  assert.equal(observedDurableDispatchStart, true);
  assert.equal(dispatchProvider.listPhysicalCalls().length, 1);
  assert.equal(
    dispatchProvider.listPhysicalCalls()
      .filter((item) => item.providerExecuted).length,
    1
  );
  const confirmedLedger =
    store.prospectProviderRequestLedgers.find((item) =>
      item.id === dispatchPrepared.ledger.id
    )!;
  const confirmedDispatch =
    store.prospectProviderRequestDispatches.find((item) =>
      item.ledgerId === dispatchPrepared.ledger.id
    )!;
  assert.equal(confirmedLedger.status, "response_received");
  assert.equal(confirmedDispatch.status, "response_received");
  assert.ok(confirmedLedger.externalRequestId);
  assert.equal(
    confirmedLedger.externalRequestId,
    confirmedDispatch.externalRequestId
  );
  assert.equal(
    confirmedLedger.responseHash,
    dispatchResult.response.responseHash
  );
  assert.equal(
    confirmedLedger.rawResponseHash,
    dispatchResult.response.rawResponseHash
  );
  assert.equal(
    confirmedLedger.normalizedResultHash,
    dispatchResult.response.normalizedResultHash
  );
  assert.equal(
    confirmedLedger.responseAccountingEvidenceHash,
    dispatchResult.response.accountingEvidenceHash
  );
  assert.equal(confirmedLedger.httpStatus, 200);
  assert.equal(confirmedLedger.providerOutcomeCode, "SUCCESS");
  assert.match(
    confirmedLedger.encryptedResponseEnvelope,
    /^provider-response-v1\./
  );
  assert.match(
    confirmedLedger.responseEvidenceRef,
    /^sha256:[a-f0-9]{64}$/
  );
  assert.equal(
    confirmedLedger.encryptedResponseEnvelope.includes("requestUnits"),
    false
  );
  assert.equal(
    confirmedLedger.encryptedResponseEnvelope.includes("USD"),
    false
  );
  assert.equal(
    confirmedDispatch.responseHash,
    confirmedLedger.responseHash
  );
  assert.ok(
    confirmedLedger.dispatchConfirmedAt
      < confirmedLedger.responseReceivedAt
  );
  assert.equal(
    store.prospectExecutionLeases.find((item) =>
      item.id === dispatchClaim.lease.id
    )?.releaseReason,
    "RESPONSE_RECEIVED_PENDING_SETTLEMENT"
  );
  const pendingAttempt = store.prospectExecutionAttempts.find((item) =>
    item.id === dispatchClaim.attempt.id
  )!;
  assert.equal(pendingAttempt.status, "request_started");
  assert.equal(pendingAttempt.responseHash, "");
  assert.equal(pendingAttempt.usageJson, "");
  assert.equal(pendingAttempt.costKind, "unknown");
  assert.equal(pendingAttempt.costAmount, null);
  assert.equal(
    store.prospectExecutionPages.some((item) =>
      item.runId === dispatchRun.id
    ),
    false
  );
  assert.equal(
    store.prospectProviderRequestAccountingEvidence.some((item) =>
      item.ledgerId === confirmedLedger.id
    ),
    false
  );
  assert.deepEqual({
    total: dispatchCheckpoint.totalCallCount,
    checkpoint: dispatchCheckpoint.checkpointCallCount,
    attempts: dispatchJob.attemptCount
  }, {
    total: dispatchCountersBefore.total + 1,
    checkpoint: dispatchCountersBefore.checkpoint + 1,
    attempts: dispatchCountersBefore.attempts + 1
  });
  assert.deepEqual(
    store.prospectProviderRequestEvents
      .filter((item) => item.ledgerId === dispatchPrepared.ledger.id)
      .map((item) => [item.sequence, item.eventType]),
    [
      [1, "prepared"],
      [2, "dispatch_started"],
      [3, "dispatch_confirmed"],
      [4, "response_received"]
    ]
  );
  const responseState = executionStateSnapshot();
  const replayedPersisted =
    await dispatchKernel.persistPreparedProviderResponse({
      leaseId: dispatchClaim.lease.id,
      claimToken: dispatchClaim.claimToken,
      ledgerId: dispatchPrepared.ledger.id,
      response: dispatchResult.response,
      now: "2026-07-14T00:32:04.000Z"
    });
  assert.equal(replayedPersisted.kind, "response_received");
  assert.deepEqual(executionStateSnapshot(), responseState);

  const conflictingStep = {
    ...dispatchResult.response.step,
    acceptedCount: 1
  };
  assert.equal(conflictingStep.kind, "success");
  const conflictingHashes =
    prospectProviderResponseComponentHashes(conflictingStep);
  const conflictingResponseHash = prospectProviderResponseHash({
    contractVersion: confirmedLedger.contractVersion,
    requestHash: confirmedLedger.requestHash,
    idempotencyKey: confirmedLedger.idempotencyKey,
    providerCode: confirmedLedger.providerCode,
    connectionId: confirmedLedger.connectionId,
    endpointCode: confirmedLedger.endpointCode,
    externalRequestId: confirmedLedger.externalRequestId,
    httpStatus: 200,
    rawResponseHash: conflictingHashes.rawResponseHash,
    normalizedResultHash: conflictingHashes.normalizedResultHash,
    accountingEvidenceHash: conflictingHashes.accountingEvidenceHash
  });
  await assert.rejects(
    dispatchKernel.persistPreparedProviderResponse({
      leaseId: dispatchClaim.lease.id,
      claimToken: dispatchClaim.claimToken,
      ledgerId: dispatchPrepared.ledger.id,
      response: {
        step: conflictingStep,
        externalRequestId: confirmedLedger.externalRequestId,
        httpStatus: 200,
        ...conflictingHashes,
        responseHash: conflictingResponseHash,
        replayed: true
      },
      now: "2026-07-14T00:32:04.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RESPONSE_CONFLICT"
  );
  assert.deepEqual(executionStateSnapshot(), responseState);
  await assert.rejects(
    dispatchKernel.persistPreparedProviderResponse({
      leaseId: dispatchClaim.lease.id,
      claimToken: "wrong-claim-token",
      ledgerId: dispatchPrepared.ledger.id,
      response: dispatchResult.response,
      now: "2026-07-14T00:32:04.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_CLAIM_TOKEN_INVALID"
  );
  const originalResponseEnvelope =
    confirmedLedger.encryptedResponseEnvelope;
  confirmedLedger.encryptedResponseEnvelope =
    `${originalResponseEnvelope.slice(0, -1)}${
      originalResponseEnvelope.endsWith("A") ? "B" : "A"
    }`;
  await assert.rejects(
    dispatchKernel.persistPreparedProviderResponse({
      leaseId: dispatchClaim.lease.id,
      claimToken: dispatchClaim.claimToken,
      ledgerId: dispatchPrepared.ledger.id,
      response: dispatchResult.response,
      now: "2026-07-14T00:32:04.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RESPONSE_ENVELOPE_INVALID"
  );
  confirmedLedger.encryptedResponseEnvelope = originalResponseEnvelope;

  const originalRawResponseHash = confirmedLedger.rawResponseHash;
  confirmedLedger.rawResponseHash = "0".repeat(64);
  await assert.rejects(
    dispatchKernel.persistPreparedProviderResponse({
      leaseId: dispatchClaim.lease.id,
      claimToken: dispatchClaim.claimToken,
      ledgerId: dispatchPrepared.ledger.id,
      response: dispatchResult.response,
      now: "2026-07-14T00:32:04.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RESPONSE_CONFLICT"
  );
  confirmedLedger.rawResponseHash = originalRawResponseHash;

  const originalHttpStatus = confirmedLedger.httpStatus;
  confirmedLedger.httpStatus = 201;
  await assert.rejects(
    dispatchKernel.persistPreparedProviderResponse({
      leaseId: dispatchClaim.lease.id,
      claimToken: dispatchClaim.claimToken,
      ledgerId: dispatchPrepared.ledger.id,
      response: dispatchResult.response,
      now: "2026-07-14T00:32:04.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RESPONSE_CONFLICT"
  );
  confirmedLedger.httpStatus = originalHttpStatus;

  const originalProviderOutcomeCode =
    confirmedLedger.providerOutcomeCode;
  confirmedLedger.providerOutcomeCode = "TAMPERED";
  await assert.rejects(
    dispatchKernel.persistPreparedProviderResponse({
      leaseId: dispatchClaim.lease.id,
      claimToken: dispatchClaim.claimToken,
      ledgerId: dispatchPrepared.ledger.id,
      response: dispatchResult.response,
      now: "2026-07-14T00:32:04.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RESPONSE_CONFLICT"
  );
  confirmedLedger.providerOutcomeCode = originalProviderOutcomeCode;
  assert.deepEqual(executionStateSnapshot(), responseState);

  const dispatchRecoveryKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-recovery-worker",
    allowedRunIds: [dispatchRun.id],
    claimSecret: "m".repeat(32),
    providerRequestIdempotencySecret: "q".repeat(32),
    providerRequestEnvelopeSecret: "r".repeat(32),
    providerRawEnvelopeSecret: "v".repeat(32),
    providerRawIdentitySecret: "w".repeat(32),
    providerRawPolicies: {
      "fake.dispatch-confirmed": {
        licensePolicy: "test-public-api",
        retentionPolicy: "test-30-days",
        retentionDays: 30
      }
    }
  });
  await dispatchRecoveryKernel.start("2026-07-14T00:32:04.000Z");
  assert.equal(confirmedLedger.status, "response_received");
  assert.equal(confirmedDispatch.status, "response_received");
  assert.equal(dispatchRun.status, "running");
  assert.equal(dispatchProvider.listPhysicalCalls().length, 1);
  const replayedAfterRestart =
    await dispatchRecoveryKernel.dispatchPreparedProviderRequest(
      dispatchProvider,
      {
        leaseId: dispatchClaim.lease.id,
        claimToken: dispatchClaim.claimToken,
        ledgerId: dispatchPrepared.ledger.id,
        now: "2026-07-14T00:32:05.000Z"
      }
    );
  assert.equal(replayedAfterRestart.kind, "response_received");
  assert.equal(dispatchProvider.listPhysicalCalls().length, 1);
  assert.equal(
    await dispatchRecoveryKernel.claimNext(
      "2026-07-14T00:32:06.000Z"
    ),
    null
  );
  await assert.rejects(
    dispatchRecoveryKernel.completePage({
      leaseId: dispatchClaim.lease.id,
      claimToken: dispatchClaim.claimToken,
      result: dispatchResult.response.step.kind === "success"
        ? dispatchResult.response.step
        : assert.fail("expected success response"),
      responseHash: confirmedLedger.responseHash,
      now: "2026-07-14T00:32:07.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_LEASE_NOT_ACTIVE"
  );
  await assert.rejects(
    dispatchRecoveryKernel.settlePersistedProviderResponse({
      teamId: "other-team",
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: confirmedLedger.responseHash,
      now: "2026-07-14T00:32:07.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_SETTLEMENT_SCOPE_INVALID"
  );
  await assert.rejects(
    dispatchRecoveryKernel.settlePersistedProviderResponse({
      teamId: confirmedLedger.teamId,
      ownerId: "other-owner",
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: confirmedLedger.responseHash,
      now: "2026-07-14T00:32:07.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_SETTLEMENT_SCOPE_INVALID"
  );
  await assert.rejects(
    dispatchRecoveryKernel.settlePersistedProviderResponse({
      teamId: confirmedLedger.teamId,
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: "0".repeat(64),
      now: "2026-07-14T00:32:07.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_SETTLEMENT_CONFLICT"
  );
  const crmCountsBeforeSettlement = {
    leads: store.leads.length,
    customers: store.customers.length,
    deals: store.deals.length,
    websiteOpportunities: store.websiteOpportunities.length
  };
  const responseLeaseBeforeSettlement = structuredClone(
    store.prospectExecutionLeases.find((item) =>
      item.id === dispatchClaim.lease.id
    )!
  );
  const successfulSettlement =
    await dispatchRecoveryKernel.settlePersistedProviderResponse({
      teamId: confirmedLedger.teamId,
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: confirmedLedger.responseHash,
      now: "2026-07-14T00:32:07.000Z"
    });
  assert.equal(successfulSettlement.kind, "success");
  assert.equal(successfulSettlement.idempotent, false);
  assert.equal(successfulSettlement.ledger.status, "settled");
  assert.equal(successfulSettlement.ledger.settlementKind, "success");
  assert.match(
    successfulSettlement.ledger.settlementHash,
    /^[a-f0-9]{64}$/
  );
  assert.equal(successfulSettlement.attempt.status, "succeeded");
  assert.equal(
    successfulSettlement.accountingEvidence.provenance,
    "provider_reported"
  );
  assert.equal(successfulSettlement.accountingEvidence.costAmount, 0.02);
  assert.equal(successfulSettlement.accountingEvidence.currency, "USD");
  assert.equal(successfulSettlement.page?.acceptedCount, 2);
  assert.equal(successfulSettlement.page?.payloadHash, confirmedLedger.responseHash);
  assert.equal(successfulSettlement.rawBatch?.idempotent, false);
  assert.equal(
    successfulSettlement.rawBatch?.batch.ledgerId,
    confirmedLedger.id
  );
  assert.equal(successfulSettlement.rawBatch?.batch.recordCount, 2);
  assert.equal(dispatchRun.status, "succeeded");
  assert.deepEqual(
    store.prospectExecutionLeases.find((item) =>
      item.id === dispatchClaim.lease.id
    ),
    responseLeaseBeforeSettlement
  );
  assert.deepEqual({
    leads: store.leads.length,
    customers: store.customers.length,
    deals: store.deals.length,
    websiteOpportunities: store.websiteOpportunities.length
  }, crmCountsBeforeSettlement);
  const rawBatch =
    await dispatchRecoveryKernel.persistSettledProviderRawBatch({
      teamId: confirmedLedger.teamId,
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: successfulSettlement.ledger.responseHash,
      expectedSettlementHash: successfulSettlement.ledger.settlementHash
    });
  assert.equal(rawBatch.idempotent, true);
  assert.equal(rawBatch.batch.ledgerId, confirmedLedger.id);
  assert.equal(rawBatch.batch.recordCount, 2);
  assert.equal(rawBatch.records.length, 2);
  assert.deepEqual(
    rawBatch.hits.map((item) => item.ordinal),
    [1, 2]
  );
  assert.equal(
    rawBatch.records.some((item) =>
      item.encryptedEnvelope.includes("Example Industrial Lighting")
    ),
    false
  );
  assert.deepEqual({
    leads: store.leads.length,
    customers: store.customers.length,
    deals: store.deals.length,
    websiteOpportunities: store.websiteOpportunities.length
  }, crmCountsBeforeSettlement);
  assert.deepEqual(rawBatch.batch, successfulSettlement.rawBatch?.batch);
  assert.deepEqual(rawBatch.records, successfulSettlement.rawBatch?.records);
  assert.deepEqual(rawBatch.hits, successfulSettlement.rawBatch?.hits);
  const replayedRawBatch =
    await dispatchRecoveryKernel.persistSettledProviderRawBatch({
      teamId: confirmedLedger.teamId,
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: successfulSettlement.ledger.responseHash,
      expectedSettlementHash: successfulSettlement.ledger.settlementHash
    });
  assert.equal(replayedRawBatch.idempotent, true);
  assert.deepEqual(replayedRawBatch.batch, rawBatch.batch);
  assert.deepEqual(replayedRawBatch.records, rawBatch.records);
  assert.deepEqual(replayedRawBatch.hits, rawBatch.hits);
  const storedRawBatch = store.prospectSourceRawBatches.find((item) =>
    item.id === rawBatch.batch.id
  )!;
  const originalRawBatchHash = storedRawBatch.batchHash;
  storedRawBatch.batchHash = "0".repeat(64);
  const tamperedBatchState = executionStateSnapshot();
  await assert.rejects(
    dispatchRecoveryKernel.persistSettledProviderRawBatch({
      teamId: confirmedLedger.teamId,
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: successfulSettlement.ledger.responseHash,
      expectedSettlementHash: successfulSettlement.ledger.settlementHash
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RAW_CONFLICT"
  );
  assert.deepEqual(executionStateSnapshot(), tamperedBatchState);
  storedRawBatch.batchHash = originalRawBatchHash;

  const storedRawRecord = store.prospectSourceRawRecords.find((item) =>
    item.id === rawBatch.records[0]?.id
  )!;
  const originalRawRecordHash = storedRawRecord.recordHash;
  storedRawRecord.recordHash = "0".repeat(64);
  const tamperedRecordState = executionStateSnapshot();
  await assert.rejects(
    dispatchRecoveryKernel.persistSettledProviderRawBatch({
      teamId: confirmedLedger.teamId,
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: successfulSettlement.ledger.responseHash,
      expectedSettlementHash: successfulSettlement.ledger.settlementHash
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RAW_CONFLICT"
  );
  assert.deepEqual(executionStateSnapshot(), tamperedRecordState);
  storedRawRecord.recordHash = originalRawRecordHash;

  const storedRawHit = store.prospectSourceRawHits.find((item) =>
    item.id === rawBatch.hits[0]?.id
  )!;
  const originalRawHitHash = storedRawHit.hitHash;
  storedRawHit.hitHash = "0".repeat(64);
  const tamperedHitState = executionStateSnapshot();
  await assert.rejects(
    dispatchRecoveryKernel.persistSettledProviderRawBatch({
      teamId: confirmedLedger.teamId,
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: successfulSettlement.ledger.responseHash,
      expectedSettlementHash: successfulSettlement.ledger.settlementHash
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RAW_CONFLICT"
  );
  assert.deepEqual(executionStateSnapshot(), tamperedHitState);
  storedRawHit.hitHash = originalRawHitHash;
  await assert.rejects(
    dispatchRecoveryKernel.persistSettledProviderRawBatch({
      teamId: "other-team",
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: successfulSettlement.ledger.responseHash,
      expectedSettlementHash: successfulSettlement.ledger.settlementHash
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RAW_SCOPE_INVALID"
  );
  await assert.rejects(
    dispatchRecoveryKernel.persistSettledProviderRawBatch({
      teamId: confirmedLedger.teamId,
      ownerId: "other-owner",
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: successfulSettlement.ledger.responseHash,
      expectedSettlementHash: successfulSettlement.ledger.settlementHash
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RAW_SCOPE_INVALID"
  );
  await assert.rejects(
    dispatchRecoveryKernel.persistSettledProviderRawBatch({
      teamId: confirmedLedger.teamId,
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: successfulSettlement.ledger.responseHash,
      expectedSettlementHash: "0".repeat(64)
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RAW_CONFLICT"
  );
  const successfulSettlementState = executionStateSnapshot();
  const replayedSettlement =
    await dispatchRecoveryKernel.settlePersistedProviderResponse({
      teamId: confirmedLedger.teamId,
      ownerId: confirmedLedger.ownerId,
      runId: confirmedLedger.runId,
      ledgerId: confirmedLedger.id,
      expectedResponseHash: confirmedLedger.responseHash,
      now: "2026-07-14T00:32:08.000Z"
    });
  assert.equal(replayedSettlement.kind, "success");
  assert.equal(replayedSettlement.idempotent, true);
  assert.deepEqual(executionStateSnapshot(), successfulSettlementState);
  assert.doesNotThrow(
    () => validateProspectRunQueueBridge(store, dispatchRun)
  );

  const rawRollbackRun = createRun(
    runOwner,
    ["fake.dispatch-raw-rollback"]
  );
  const rawRollbackKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-raw-rollback-worker",
    allowedRunIds: [rawRollbackRun.id],
    claimSecret: "a".repeat(32),
    providerRawEnvelopeSecret: "b".repeat(32),
    providerRawIdentitySecret: "d".repeat(32),
    providerRawPolicies: {
      "fake.dispatch-raw-rollback": {
        licensePolicy: "test-public-api",
        retentionPolicy: "test-30-days",
        retentionDays: 30
      }
    }
  });
  await rawRollbackKernel.start("2026-07-14T00:32:08.100Z");
  const rawRollbackClaim = await rawRollbackKernel.claimNext(
    "2026-07-14T00:32:08.200Z"
  );
  assert.ok(rawRollbackClaim);
  const rawRollbackPrepared =
    await rawRollbackKernel.prepareProviderRequest({
      leaseId: rawRollbackClaim.lease.id,
      claimToken: rawRollbackClaim.claimToken,
      now: "2026-07-14T00:32:08.300Z"
    });
  const rawRollbackProvider = new DeterministicFakeProspectProvider({
    "fake.dispatch-raw-rollback": [{
      kind: "success",
      acceptedCount: 1,
      rawCount: 1,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: false,
      cursor: "",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 1 },
      cost: { kind: "unknown", amount: null, currency: "" },
      responseSchemaVersion: "fake-provider-source-records-v1",
      sourceRecords: [{
        providerRecordId: "rollback-company-001",
        sourceUrl: "https://example.test/company/rollback-001",
        fetchedAt: "2026-07-14T00:32:08.050Z",
        payload: { companyName: "Rollback Example Ltd" }
      }]
    }]
  });
  const rawRollbackResponse =
    await rawRollbackKernel.dispatchPreparedProviderRequest(
      rawRollbackProvider,
      {
        leaseId: rawRollbackClaim.lease.id,
        claimToken: rawRollbackClaim.claimToken,
        ledgerId: rawRollbackPrepared.ledger.id,
        now: "2026-07-14T00:32:08.400Z"
      }
    );
  assert.equal(rawRollbackResponse.kind, "response_received");
  const beforeRawSettlementFailure = executionStateSnapshot();
  store.persist = async () => {
    throw new Error("forced raw settlement persistence failure");
  };
  try {
    await assert.rejects(
      rawRollbackKernel.settlePersistedProviderResponse({
        teamId: rawRollbackPrepared.ledger.teamId,
        ownerId: rawRollbackPrepared.ledger.ownerId,
        runId: rawRollbackPrepared.ledger.runId,
        ledgerId: rawRollbackPrepared.ledger.id,
        expectedResponseHash: rawRollbackResponse.response.responseHash,
        now: "2026-07-14T00:32:08.500Z"
      }),
      /forced raw settlement persistence failure/
    );
  } finally {
    store.persist = originalPersist;
  }
  assert.deepEqual(executionStateSnapshot(), beforeRawSettlementFailure);
  assert.equal(
    store.prospectSourceRawBatches.some((item) =>
      item.ledgerId === rawRollbackPrepared.ledger.id
    ),
    false
  );
  const rawRollbackSettlement =
    await rawRollbackKernel.settlePersistedProviderResponse({
      teamId: rawRollbackPrepared.ledger.teamId,
      ownerId: rawRollbackPrepared.ledger.ownerId,
      runId: rawRollbackPrepared.ledger.runId,
      ledgerId: rawRollbackPrepared.ledger.id,
      expectedResponseHash: rawRollbackResponse.response.responseHash,
      now: "2026-07-14T00:32:08.600Z"
    });
  assert.equal(rawRollbackSettlement.kind, "success");
  assert.equal(rawRollbackSettlement.rawBatch?.idempotent, false);
  assert.equal(
    store.prospectSourceRawBatches.filter((item) =>
      item.ledgerId === rawRollbackPrepared.ledger.id
    ).length,
    1
  );

  const emptyRawRun = createRun(
    runOwner,
    ["fake.dispatch-empty-raw"]
  );
  const emptyRawKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-empty-raw-worker",
    allowedRunIds: [emptyRawRun.id],
    claimSecret: "e".repeat(32),
    providerRawPolicies: {
      "fake.dispatch-empty-raw": {
        licensePolicy: "test-public-api",
        retentionPolicy: "test-7-days",
        retentionDays: 7
      }
    }
  });
  await emptyRawKernel.start("2026-07-14T00:32:09.000Z");
  const emptyRawClaim = await emptyRawKernel.claimNext(
    "2026-07-14T00:32:09.100Z"
  );
  assert.ok(emptyRawClaim);
  const emptyRawPrepared = await emptyRawKernel.prepareProviderRequest({
    leaseId: emptyRawClaim.lease.id,
    claimToken: emptyRawClaim.claimToken,
    now: "2026-07-14T00:32:09.200Z"
  });
  const emptyRawProvider = new DeterministicFakeProspectProvider({
    "fake.dispatch-empty-raw": [{
      kind: "success",
      acceptedCount: 0,
      rawCount: 0,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: false,
      cursor: "",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 0 },
      cost: { kind: "actual", amount: 0, currency: "USD" },
      responseSchemaVersion: "fake-provider-source-records-v1",
      sourceRecords: []
    }]
  });
  const emptyRawResponse =
    await emptyRawKernel.dispatchPreparedProviderRequest(
      emptyRawProvider,
      {
        leaseId: emptyRawClaim.lease.id,
        claimToken: emptyRawClaim.claimToken,
        ledgerId: emptyRawPrepared.ledger.id,
        now: "2026-07-14T00:32:09.300Z"
      }
    );
  assert.equal(emptyRawResponse.kind, "response_received");
  const emptyRawSettlement =
    await emptyRawKernel.settlePersistedProviderResponse({
      teamId: emptyRawPrepared.ledger.teamId,
      ownerId: emptyRawPrepared.ledger.ownerId,
      runId: emptyRawPrepared.ledger.runId,
      ledgerId: emptyRawPrepared.ledger.id,
      expectedResponseHash: emptyRawResponse.response.responseHash,
      now: "2026-07-14T00:32:09.400Z"
    });
  assert.equal(emptyRawSettlement.kind, "success");
  assert.equal(emptyRawSettlement.runStatus, "succeeded_empty");
  assert.equal(emptyRawSettlement.rawBatch?.batch.recordCount, 0);
  assert.deepEqual(emptyRawSettlement.rawBatch?.records, []);
  assert.deepEqual(emptyRawSettlement.rawBatch?.hits, []);

  const missingRawPolicyRun = createRun(
    runOwner,
    ["fake.dispatch-missing-raw-policy"]
  );
  const missingRawPolicyKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-missing-raw-policy-worker",
    allowedRunIds: [missingRawPolicyRun.id],
    claimSecret: "h".repeat(32)
  });
  await missingRawPolicyKernel.start("2026-07-14T00:32:09.500Z");
  const missingRawPolicyClaim =
    await missingRawPolicyKernel.claimNext(
      "2026-07-14T00:32:09.600Z"
    );
  assert.ok(missingRawPolicyClaim);
  const missingRawPolicyPrepared =
    await missingRawPolicyKernel.prepareProviderRequest({
      leaseId: missingRawPolicyClaim.lease.id,
      claimToken: missingRawPolicyClaim.claimToken,
      now: "2026-07-14T00:32:09.700Z"
    });
  const missingRawPolicyProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-missing-raw-policy": [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "unknown", amount: null, currency: "" },
        responseSchemaVersion: "fake-provider-source-records-v1",
        sourceRecords: [{
          providerRecordId: "missing-policy-company-001",
          sourceUrl: "https://example.test/company/missing-policy-001",
          fetchedAt: "2026-07-14T00:32:09.450Z",
          payload: { companyName: "Missing Policy Example Ltd" }
        }]
      }]
    });
  const missingRawPolicyResponse =
    await missingRawPolicyKernel.dispatchPreparedProviderRequest(
      missingRawPolicyProvider,
      {
        leaseId: missingRawPolicyClaim.lease.id,
        claimToken: missingRawPolicyClaim.claimToken,
        ledgerId: missingRawPolicyPrepared.ledger.id,
        now: "2026-07-14T00:32:09.800Z"
      }
    );
  assert.equal(missingRawPolicyResponse.kind, "response_received");
  const beforeMissingRawPolicySettlement = executionStateSnapshot();
  await assert.rejects(
    missingRawPolicyKernel.settlePersistedProviderResponse({
      teamId: missingRawPolicyPrepared.ledger.teamId,
      ownerId: missingRawPolicyPrepared.ledger.ownerId,
      runId: missingRawPolicyPrepared.ledger.runId,
      ledgerId: missingRawPolicyPrepared.ledger.id,
      expectedResponseHash:
        missingRawPolicyResponse.response.responseHash,
      now: "2026-07-14T00:32:09.900Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_RAW_POLICY_REQUIRED"
  );
  assert.deepEqual(
    executionStateSnapshot(),
    beforeMissingRawPolicySettlement
  );
  assert.equal(
    store.prospectSourceRawBatches.some((item) =>
      item.ledgerId === missingRawPolicyPrepared.ledger.id
    ),
    false
  );

  const failureResponseRun = createRun(
    runOwner,
    ["fake.dispatch-failure-response"]
  );
  const failureResponseKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-failure-response-worker",
    allowedRunIds: [failureResponseRun.id],
    claimSecret: "f".repeat(32)
  });
  await failureResponseKernel.start("2026-07-14T00:32:10.000Z");
  const failureResponseClaim = await failureResponseKernel.claimNext(
    "2026-07-14T00:32:11.000Z"
  );
  assert.ok(failureResponseClaim);
  const failureResponsePrepared =
    await failureResponseKernel.prepareProviderRequest({
      leaseId: failureResponseClaim.lease.id,
      claimToken: failureResponseClaim.claimToken,
      now: "2026-07-14T00:32:12.000Z"
    });
  const failureResponseProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-failure-response": [{
        kind: "failure",
        errorCode: "PROVIDER_RATE_LIMITED",
        errorMessage: "rate limited",
        retryable: true,
        retryAfterAt: "2026-07-14T00:33:00.000Z",
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "actual", amount: 0.01, currency: "USD" }
      }]
    });
  const failureResponseResult =
    await failureResponseKernel.dispatchPreparedProviderRequest(
      failureResponseProvider,
      {
        leaseId: failureResponseClaim.lease.id,
        claimToken: failureResponseClaim.claimToken,
        ledgerId: failureResponsePrepared.ledger.id,
        now: "2026-07-14T00:32:13.000Z"
      }
    );
  assert.equal(failureResponseResult.kind, "response_received");
  assert.equal(failureResponseResult.response.step.kind, "failure");
  const failureResponseLedger =
    store.prospectProviderRequestLedgers.find((item) =>
      item.id === failureResponsePrepared.ledger.id
    )!;
  assert.equal(failureResponseLedger.status, "response_received");
  assert.equal(
    failureResponseLedger.providerOutcomeCode,
    "PROVIDER_RATE_LIMITED"
  );
  assert.equal(failureResponseLedger.httpStatus, 503);
  assert.match(
    failureResponseLedger.encryptedResponseEnvelope,
    /^provider-response-v1\./
  );
  assert.equal(
    store.prospectExecutionAttempts.find((item) =>
      item.id === failureResponseClaim.attempt.id
    )?.status,
    "request_started"
  );
  assert.equal(failureResponseRun.status, "running");
  assert.equal(
    store.prospectExecutionPages.some((item) =>
      item.runId === failureResponseRun.id
    ),
    false
  );
  assert.equal(
    store.prospectProviderRequestAccountingEvidence.some((item) =>
      item.ledgerId === failureResponseLedger.id
    ),
    false
  );
  const failureSettlement =
    await failureResponseKernel.settlePersistedProviderResponse({
      teamId: failureResponseLedger.teamId,
      ownerId: failureResponseLedger.ownerId,
      runId: failureResponseLedger.runId,
      ledgerId: failureResponseLedger.id,
      expectedResponseHash: failureResponseLedger.responseHash,
      now: "2026-07-14T00:32:14.000Z"
    });
  assert.equal(failureSettlement.kind, "failure");
  assert.equal(failureSettlement.retryScheduled, true);
  assert.equal(
    failureSettlement.retryAfterAt,
    "2026-07-14T00:33:00.000Z"
  );
  assert.equal(failureSettlement.attempt.status, "failed");
  assert.equal(failureSettlement.ledger.status, "settled");
  assert.equal(failureSettlement.ledger.settlementKind, "failure");
  assert.equal(
    failureSettlement.accountingEvidence.provenance,
    "provider_reported"
  );
  assert.equal(
    store.prospectExecutionPages.some((item) =>
      item.runId === failureResponseRun.id
    ),
    false
  );
  assert.equal(
    store.prospectRunShards.find((item) =>
      item.runId === failureResponseRun.id
    )?.status,
    "retry_scheduled"
  );
  assert.equal(failureSettlement.rawBatch, undefined);
  assert.equal(
    store.prospectSourceRawBatches.some((item) =>
      item.ledgerId === failureResponseLedger.id
    ),
    false
  );

  const terminalFailureRun = createRun(
    runOwner,
    ["fake.dispatch-terminal-failure"]
  );
  const terminalFailureKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-terminal-failure-worker",
    allowedRunIds: [terminalFailureRun.id],
    claimSecret: "v".repeat(32)
  });
  await terminalFailureKernel.start("2026-07-14T00:32:20.000Z");
  const terminalFailureClaim = await terminalFailureKernel.claimNext(
    "2026-07-14T00:32:21.000Z"
  );
  assert.ok(terminalFailureClaim);
  const terminalFailurePrepared =
    await terminalFailureKernel.prepareProviderRequest({
      leaseId: terminalFailureClaim.lease.id,
      claimToken: terminalFailureClaim.claimToken,
      now: "2026-07-14T00:32:22.000Z"
    });
  const terminalFailureProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-terminal-failure": [{
        kind: "failure",
        errorCode: "PROVIDER_AUTH_FAILED",
        errorMessage: "authentication failed",
        retryable: false,
        retryAfterAt: "",
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "estimated", amount: 0.005, currency: "USD" }
      }]
    });
  const terminalFailureResponse =
    await terminalFailureKernel.dispatchPreparedProviderRequest(
      terminalFailureProvider,
      {
        leaseId: terminalFailureClaim.lease.id,
        claimToken: terminalFailureClaim.claimToken,
        ledgerId: terminalFailurePrepared.ledger.id,
        now: "2026-07-14T00:32:23.000Z"
      }
    );
  assert.equal(terminalFailureResponse.kind, "response_received");
  const terminalFailureSettlement =
    await terminalFailureKernel.settlePersistedProviderResponse({
      teamId: terminalFailurePrepared.ledger.teamId,
      ownerId: terminalFailurePrepared.ledger.ownerId,
      runId: terminalFailurePrepared.ledger.runId,
      ledgerId: terminalFailurePrepared.ledger.id,
      expectedResponseHash: terminalFailureResponse.response.responseHash,
      now: "2026-07-14T00:32:24.000Z"
    });
  assert.equal(terminalFailureSettlement.kind, "failure");
  assert.equal(terminalFailureSettlement.retryScheduled, false);
  assert.equal(terminalFailureRun.status, "failed");
  assert.equal(
    terminalFailureSettlement.accountingEvidence.provenance,
    "estimated"
  );
  assert.equal(
    terminalFailureSettlement.accountingEvidence.estimationMethodVersion,
    "fake-provider-estimate-v1"
  );

  const pendingPauseRun = createRun(
    runOwner,
    ["fake.dispatch-pending-pause"]
  );
  const pendingPauseKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-pending-pause-worker",
    allowedRunIds: [pendingPauseRun.id],
    claimSecret: "w".repeat(32)
  });
  await pendingPauseKernel.start("2026-07-14T00:32:30.000Z");
  const pendingPauseClaim = await pendingPauseKernel.claimNext(
    "2026-07-14T00:32:31.000Z"
  );
  assert.ok(pendingPauseClaim);
  const pendingPausePrepared =
    await pendingPauseKernel.prepareProviderRequest({
      leaseId: pendingPauseClaim.lease.id,
      claimToken: pendingPauseClaim.claimToken,
      now: "2026-07-14T00:32:32.000Z"
    });
  const pendingPauseProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-pending-pause": [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: true,
        cursor: "pending-pause-cursor",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "unknown", amount: null, currency: "" }
      }]
    });
  const pendingPauseResponse =
    await pendingPauseKernel.dispatchPreparedProviderRequest(
      pendingPauseProvider,
      {
        leaseId: pendingPauseClaim.lease.id,
        claimToken: pendingPauseClaim.claimToken,
        ledgerId: pendingPausePrepared.ledger.id,
        now: "2026-07-14T00:32:33.000Z"
      }
    );
  assert.equal(pendingPauseResponse.kind, "response_received");
  await pendingPauseKernel.requestPause(
    pendingPauseRun.id,
    "2026-07-14T00:32:34.000Z"
  );
  assert.equal(pendingPauseRun.status, "pause_requested");
  assert.equal(
    store.prospectRunShards.find((item) =>
      item.runId === pendingPauseRun.id
    )?.status,
    "pause_requested"
  );
  const pendingPauseSettlement =
    await pendingPauseKernel.settlePersistedProviderResponse({
      teamId: pendingPausePrepared.ledger.teamId,
      ownerId: pendingPausePrepared.ledger.ownerId,
      runId: pendingPausePrepared.ledger.runId,
      ledgerId: pendingPausePrepared.ledger.id,
      expectedResponseHash: pendingPauseResponse.response.responseHash,
      now: "2026-07-14T00:32:35.000Z"
    });
  assert.equal(pendingPauseSettlement.kind, "success");
  assert.equal(pendingPauseSettlement.rawBatch, undefined);
  assert.equal(
    store.prospectSourceRawBatches.some((item) =>
      item.ledgerId === pendingPausePrepared.ledger.id
    ),
    false
  );
  assert.equal(pendingPauseRun.status, "paused");
  assert.equal(
    store.prospectRunShards.find((item) =>
      item.runId === pendingPauseRun.id
    )?.status,
    "paused"
  );

  const startedRecoveryRun = createRun(
    runOwner,
    ["fake.dispatch-started-recovery"]
  );
  const startedRecoveryKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-started-worker",
    allowedRunIds: [startedRecoveryRun.id],
    claimSecret: "n".repeat(32)
  });
  await startedRecoveryKernel.start("2026-07-14T00:33:00.000Z");
  const startedRecoveryClaim = await startedRecoveryKernel.claimNext(
    "2026-07-14T00:33:01.000Z"
  );
  assert.ok(startedRecoveryClaim);
  const startedRecoveryPrepared =
    await startedRecoveryKernel.prepareProviderRequest({
      leaseId: startedRecoveryClaim.lease.id,
      claimToken: startedRecoveryClaim.claimToken,
      now: "2026-07-14T00:33:02.000Z"
    });
  const startedRecoveryProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-started-recovery": [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "unknown", amount: null, currency: "" }
      }]
    });
  const durableStart =
    await startedRecoveryKernel.startPreparedProviderDispatch({
      leaseId: startedRecoveryClaim.lease.id,
      claimToken: startedRecoveryClaim.claimToken,
      ledgerId: startedRecoveryPrepared.ledger.id,
      now: "2026-07-14T00:33:03.000Z"
    });
  assert.equal(durableStart.ready, true);
  assert.equal(startedRecoveryProvider.listPhysicalCalls().length, 0);
  const startedRestartKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-started-restart-worker",
    allowedRunIds: [startedRecoveryRun.id],
    claimSecret: "n".repeat(32)
  });
  await startedRestartKernel.start("2026-07-14T00:33:04.000Z");
  const unknownStartedLedger =
    store.prospectProviderRequestLedgers.find((item) =>
      item.id === startedRecoveryPrepared.ledger.id
    )!;
  const unknownStartedDispatch =
    store.prospectProviderRequestDispatches.find((item) =>
      item.ledgerId === startedRecoveryPrepared.ledger.id
    )!;
  assert.equal(unknownStartedLedger.status, "outcome_unknown");
  assert.equal(unknownStartedDispatch.status, "outcome_unknown");
  assert.equal(unknownStartedDispatch.providerExecuted, false);
  assert.equal(startedRecoveryProvider.listPhysicalCalls().length, 0);
  assert.equal(startedRecoveryRun.status, "failed");

  const concurrentDispatchRun = createRun(
    runOwner,
    ["fake.dispatch-concurrent"]
  );
  const concurrentDispatchKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-concurrent-worker",
    allowedRunIds: [concurrentDispatchRun.id],
    claimSecret: "o".repeat(32)
  });
  await concurrentDispatchKernel.start("2026-07-14T00:34:00.000Z");
  const concurrentDispatchClaim =
    await concurrentDispatchKernel.claimNext(
      "2026-07-14T00:34:01.000Z"
    );
  assert.ok(concurrentDispatchClaim);
  const concurrentDispatchPrepared =
    await concurrentDispatchKernel.prepareProviderRequest({
      leaseId: concurrentDispatchClaim.lease.id,
      claimToken: concurrentDispatchClaim.claimToken,
      now: "2026-07-14T00:34:02.000Z"
    });
  const concurrentDispatchProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-concurrent": [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "unknown", amount: null, currency: "" },
        fakeDelayMs: 10
      }]
    });
  const concurrentDispatchResults = await Promise.allSettled([
    concurrentDispatchKernel.dispatchPreparedProviderRequest(
      concurrentDispatchProvider,
      {
        leaseId: concurrentDispatchClaim.lease.id,
        claimToken: concurrentDispatchClaim.claimToken,
        ledgerId: concurrentDispatchPrepared.ledger.id,
        now: "2026-07-14T00:34:03.000Z"
      }
    ),
    concurrentDispatchKernel.dispatchPreparedProviderRequest(
      concurrentDispatchProvider,
      {
        leaseId: concurrentDispatchClaim.lease.id,
        claimToken: concurrentDispatchClaim.claimToken,
        ledgerId: concurrentDispatchPrepared.ledger.id,
        now: "2026-07-14T00:34:03.000Z"
      }
    )
  ]);
  assert.equal(
    concurrentDispatchResults.filter(
      (item) => item.status === "fulfilled"
    ).length,
    1
  );
  assert.equal(
    concurrentDispatchResults.filter(
      (item) =>
        item.status === "rejected"
        && item.reason instanceof ProspectExecutionKernelError
        && item.reason.code === "EXECUTION_REQUEST_ALREADY_STARTED"
    ).length,
    1
  );
  assert.equal(concurrentDispatchProvider.listPhysicalCalls().length, 1);
  assert.equal(
    concurrentDispatchProvider.listPhysicalCalls()
      .filter((item) => item.providerExecuted).length,
    1
  );
  const concurrentRecoveryKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-concurrent-recovery-worker",
    allowedRunIds: [concurrentDispatchRun.id],
    claimSecret: "o".repeat(32)
  });
  await concurrentRecoveryKernel.start("2026-07-14T00:34:05.000Z");
  assert.equal(concurrentDispatchProvider.listPhysicalCalls().length, 1);

  const dispatchRaceRun = createRun(
    runOwner,
    ["fake.dispatch-recovery-race"]
  );
  const dispatchRaceKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-race-worker",
    allowedRunIds: [dispatchRaceRun.id],
    claimSecret: "z".repeat(32)
  });
  await dispatchRaceKernel.start("2026-07-14T00:34:10.000Z");
  const dispatchRaceClaim = await dispatchRaceKernel.claimNext(
    "2026-07-14T00:34:11.000Z"
  );
  assert.ok(dispatchRaceClaim);
  const dispatchRacePrepared =
    await dispatchRaceKernel.prepareProviderRequest({
      leaseId: dispatchRaceClaim.lease.id,
      claimToken: dispatchRaceClaim.claimToken,
      now: "2026-07-14T00:34:12.000Z"
    });
  const dispatchRaceProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-recovery-race": [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "unknown", amount: null, currency: "" },
        fakeDelayMs: 30
      }]
    });
  const racingDispatch =
    dispatchRaceKernel.dispatchPreparedProviderRequest(
      dispatchRaceProvider,
      {
        leaseId: dispatchRaceClaim.lease.id,
        claimToken: dispatchRaceClaim.claimToken,
        ledgerId: dispatchRacePrepared.ledger.id,
        now: "2026-07-14T00:34:13.000Z"
      }
    );
  const dispatchRacePageCount =
    store.prospectExecutionPages.length;
  const dispatchRaceAccountingCount =
    store.prospectProviderRequestAccountingEvidence.length;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    store.prospectProviderRequestLedgers.find((item) =>
      item.id === dispatchRacePrepared.ledger.id
    )?.status,
    "dispatch_started"
  );
  const dispatchRaceRecoveryKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-race-recovery-worker",
    allowedRunIds: [dispatchRaceRun.id],
    claimSecret: "z".repeat(32)
  });
  await dispatchRaceRecoveryKernel.start("2026-07-14T00:34:14.000Z");
  const dispatchRaceTerminalLease = structuredClone(
    store.prospectExecutionLeases.find((item) =>
      item.id === dispatchRaceClaim.lease.id
    )!
  );
  const racingResult = await racingDispatch;
  assert.equal(racingResult.kind, "response_received");
  assert.equal(dispatchRaceProvider.listPhysicalCalls().length, 1);
  const dispatchRaceLedger =
    store.prospectProviderRequestLedgers.find((item) =>
      item.id === dispatchRacePrepared.ledger.id
    )!;
  const dispatchRaceDispatch =
    store.prospectProviderRequestDispatches.find((item) =>
      item.ledgerId === dispatchRacePrepared.ledger.id
    )!;
  const dispatchRaceAttempt =
    store.prospectExecutionAttempts.find((item) =>
      item.id === dispatchRaceClaim.attempt.id
    )!;
  const dispatchRaceLease =
    store.prospectExecutionLeases.find((item) =>
      item.id === dispatchRaceClaim.lease.id
    )!;
  assert.equal(dispatchRaceLedger.status, "response_received");
  assert.equal(dispatchRaceDispatch.status, "response_received");
  assert.equal(dispatchRaceAttempt.status, "request_outcome_unknown");
  assert.equal(dispatchRaceRun.status, "failed");
  assert.ok(dispatchRaceLedger.unknownAt);
  assert.ok(dispatchRaceLedger.unknownReason);
  assert.ok(
    dispatchRaceLedger.responseReceivedAt > dispatchRaceLedger.unknownAt
  );
  assert.equal(dispatchRaceLease.releaseReason, "REQUEST_OUTCOME_UNKNOWN");
  assert.deepEqual(dispatchRaceLease, dispatchRaceTerminalLease);
  assert.equal(
    store.prospectExecutionPages.length,
    dispatchRacePageCount
  );
  assert.equal(
    store.prospectProviderRequestAccountingEvidence.length,
    dispatchRaceAccountingCount
  );
  assert.deepEqual(
    store.prospectProviderRequestEvents
      .filter((item) => item.ledgerId === dispatchRaceLedger.id)
      .map((item) => [item.sequence, item.eventType]),
    [
      [1, "prepared"],
      [2, "dispatch_started"],
      [3, "outcome_unknown"],
      [4, "dispatch_confirmed"],
      [5, "response_received"]
    ]
  );
  const dispatchRacePersistedState = executionStateSnapshot();
  const dispatchRaceReplayed =
    await dispatchRaceRecoveryKernel.dispatchPreparedProviderRequest(
      dispatchRaceProvider,
      {
        leaseId: dispatchRaceClaim.lease.id,
        claimToken: dispatchRaceClaim.claimToken,
        ledgerId: dispatchRacePrepared.ledger.id,
        now: "2026-07-14T00:34:15.000Z"
      }
    );
  assert.equal(dispatchRaceReplayed.kind, "response_received");
  assert.equal(dispatchRaceProvider.listPhysicalCalls().length, 1);
  assert.deepEqual(executionStateSnapshot(), dispatchRacePersistedState);

  const cancelledResponseRun = createRun(
    runOwner,
    ["fake.dispatch-cancelled-response"]
  );
  const cancelledResponseKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-cancelled-response-worker",
    allowedRunIds: [cancelledResponseRun.id],
    claimSecret: "c".repeat(32),
    providerRawPolicies: {
      "fake.dispatch-cancelled-response": {
        licensePolicy: "test-public-api",
        retentionPolicy: "test-7-days",
        retentionDays: 7
      }
    }
  });
  await cancelledResponseKernel.start("2026-07-14T00:34:20.000Z");
  const cancelledResponseClaim =
    await cancelledResponseKernel.claimNext(
      "2026-07-14T00:34:21.000Z"
    );
  assert.ok(cancelledResponseClaim);
  const cancelledResponsePrepared =
    await cancelledResponseKernel.prepareProviderRequest({
      leaseId: cancelledResponseClaim.lease.id,
      claimToken: cancelledResponseClaim.claimToken,
      now: "2026-07-14T00:34:22.000Z"
    });
  const cancelledResponseProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-cancelled-response": [{
        kind: "success",
        acceptedCount: 2,
        rawCount: 2,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 2 },
        cost: { kind: "unknown", amount: null, currency: "" },
        responseSchemaVersion: "fake-provider-source-records-v1",
        sourceRecords: [
          {
            providerRecordId: "cancelled-company-001",
            sourceUrl: "https://example.test/company/cancelled-001",
            fetchedAt: "2026-07-14T00:34:22.000Z",
            payload: { companyName: "Cancelled Example One Ltd" }
          },
          {
            providerRecordId: "cancelled-company-002",
            sourceUrl: "https://example.test/company/cancelled-002",
            fetchedAt: "2026-07-14T00:34:22.500Z",
            payload: { companyName: "Cancelled Example Two Ltd" }
          }
        ],
        fakeDelayMs: 30
      }]
    });
  const cancelledResponseDispatch =
    cancelledResponseKernel.dispatchPreparedProviderRequest(
      cancelledResponseProvider,
      {
        leaseId: cancelledResponseClaim.lease.id,
        claimToken: cancelledResponseClaim.claimToken,
        ledgerId: cancelledResponsePrepared.ledger.id,
        now: "2026-07-14T00:34:23.000Z"
      }
    );
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cancelledResponseKernel.requestCancel(
    cancelledResponseRun.id,
    "2026-07-14T00:34:24.000Z"
  );
  assert.equal(cancelledResponseRun.status, "cancel_requested");
  const cancelledResponseRecoveryKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-cancelled-response-recovery-worker",
    allowedRunIds: [cancelledResponseRun.id],
    claimSecret: "c".repeat(32),
    providerRawPolicies: {
      "fake.dispatch-cancelled-response": {
        licensePolicy: "test-public-api",
        retentionPolicy: "test-7-days",
        retentionDays: 7
      }
    }
  });
  await cancelledResponseRecoveryKernel.start(
    "2026-07-14T00:34:25.000Z"
  );
  const cancelledResponseTerminalLease = structuredClone(
    store.prospectExecutionLeases.find((item) =>
      item.id === cancelledResponseClaim.lease.id
    )!
  );
  const cancelledResponseResult = await cancelledResponseDispatch;
  assert.equal(cancelledResponseResult.kind, "response_received");
  const cancelledResponseLedger =
    store.prospectProviderRequestLedgers.find((item) =>
      item.id === cancelledResponsePrepared.ledger.id
    )!;
  assert.equal(cancelledResponseLedger.status, "response_received");
  assert.match(
    cancelledResponseLedger.unknownReason,
    /cancelled_with_provider_request_in_flight/
  );
  assert.equal(cancelledResponseRun.status, "cancelled");
  assert.equal(
    store.prospectExecutionAttempts.find((item) =>
      item.id === cancelledResponseClaim.attempt.id
    )?.status,
    "request_outcome_unknown"
  );
  assert.equal(
    store.prospectExecutionPages.some((item) =>
      item.runId === cancelledResponseRun.id
    ),
    false
  );
  assert.equal(
    store.prospectProviderRequestAccountingEvidence.some((item) =>
      item.ledgerId === cancelledResponseLedger.id
    ),
    false
  );
  const cancelledResponseLease = store.prospectExecutionLeases.find((item) =>
    item.id === cancelledResponseClaim.lease.id
  );
  assert.equal(
    cancelledResponseLease?.releaseReason,
    "CANCELLED_REQUEST_OUTCOME_UNKNOWN"
  );
  assert.deepEqual(cancelledResponseLease, cancelledResponseTerminalLease);
  const cancelledLateSettlement =
    await cancelledResponseRecoveryKernel.settlePersistedProviderResponse({
      teamId: cancelledResponseLedger.teamId,
      ownerId: cancelledResponseLedger.ownerId,
      runId: cancelledResponseLedger.runId,
      ledgerId: cancelledResponseLedger.id,
      expectedResponseHash: cancelledResponseLedger.responseHash,
      now: "2026-07-14T00:34:26.000Z"
    });
  assert.equal(cancelledLateSettlement.kind, "cancelled_late");
  assert.equal(cancelledLateSettlement.ledger.status, "cancelled_late");
  assert.equal(
    cancelledLateSettlement.ledger.settlementKind,
    "cancelled_late"
  );
  assert.equal(cancelledLateSettlement.attempt.status, "cancelled_late");
  assert.equal(
    cancelledLateSettlement.accountingEvidence.provenance,
    "unknown"
  );
  assert.equal(cancelledResponseRun.status, "cancelled");
  assert.equal(cancelledLateSettlement.rawBatch, undefined);
  assert.equal(
    store.prospectSourceRawBatches.some((item) =>
      item.ledgerId === cancelledResponseLedger.id
    ),
    false
  );
  assert.equal(
    store.prospectExecutionPages.some((item) =>
      item.runId === cancelledResponseRun.id
    ),
    false
  );
  assert.deepEqual(
    store.prospectExecutionLeases.find((item) =>
      item.id === cancelledResponseClaim.lease.id
    ),
    cancelledResponseTerminalLease
  );

  const interruptedDispatchRun = createRun(
    runOwner,
    ["fake.dispatch-interrupted"]
  );
  const interruptedDispatchKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-interrupted-worker",
    allowedRunIds: [interruptedDispatchRun.id],
    claimSecret: "t".repeat(32)
  });
  await interruptedDispatchKernel.start("2026-07-14T00:35:00.000Z");
  const interruptedDispatchClaim =
    await interruptedDispatchKernel.claimNext(
      "2026-07-14T00:35:01.000Z"
    );
  assert.ok(interruptedDispatchClaim);
  const interruptedDispatchPrepared =
    await interruptedDispatchKernel.prepareProviderRequest({
      leaseId: interruptedDispatchClaim.lease.id,
      claimToken: interruptedDispatchClaim.claimToken,
      now: "2026-07-14T00:35:02.000Z"
    });
  const interruptedDispatchProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-interrupted": [{
        kind: "success",
        acceptedCount: 3,
        rawCount: 3,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 3 },
        cost: { kind: "actual", amount: 0.03, currency: "USD" },
        fakeFaultAfter: "response_generated"
      }]
    });
  await assert.rejects(
    interruptedDispatchKernel.dispatchPreparedProviderRequest(
      interruptedDispatchProvider,
      {
        leaseId: interruptedDispatchClaim.lease.id,
        claimToken: interruptedDispatchClaim.claimToken,
        ledgerId: interruptedDispatchPrepared.ledger.id,
        now: "2026-07-14T00:35:03.000Z"
      }
    ),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PROVIDER_OUTCOME_UNKNOWN"
  );
  const interruptedLedger =
    store.prospectProviderRequestLedgers.find((item) =>
      item.id === interruptedDispatchPrepared.ledger.id
    )!;
  const interruptedDispatch =
    store.prospectProviderRequestDispatches.find((item) =>
      item.ledgerId === interruptedDispatchPrepared.ledger.id
    )!;
  assert.equal(interruptedDispatchProvider.listPhysicalCalls().length, 1);
  assert.equal(
    interruptedDispatchProvider.listPhysicalCalls()
      .filter((item) => item.providerExecuted).length,
    1
  );
  assert.equal(interruptedLedger.status, "outcome_unknown");
  assert.equal(interruptedDispatch.status, "outcome_unknown");
  assert.equal(interruptedDispatchRun.status, "failed");
  assert.equal(
    store.prospectExecutionAttempts.find((item) =>
      item.id === interruptedDispatchClaim.attempt.id
    )?.status,
    "request_outcome_unknown"
  );
  assert.equal(
    await interruptedDispatchKernel.claimNext(
      "2026-07-14T00:35:04.000Z"
    ),
    null,
    "结果未知的 Provider 请求不得自动重发"
  );

  const throttledDispatchRun = createRun(
    runOwner,
    ["fake.dispatch-throttled"]
  );
  const throttledDispatchKernel = new ProspectExecutionKernel({
    store,
    workerId: "dispatch-throttled-worker",
    allowedRunIds: [throttledDispatchRun.id],
    claimSecret: "x".repeat(32)
  });
  await throttledDispatchKernel.start("2026-07-14T00:36:00.000Z");
  const throttledDispatchClaim =
    await throttledDispatchKernel.claimNext(
      "2026-07-14T00:36:01.000Z"
    );
  assert.ok(throttledDispatchClaim);
  const throttledDispatchPrepared =
    await throttledDispatchKernel.prepareProviderRequest({
      leaseId: throttledDispatchClaim.lease.id,
      claimToken: throttledDispatchClaim.claimToken,
      now: "2026-07-14T00:36:02.000Z"
    });
  const throttledDispatchProvider =
    new DeterministicFakeProspectProvider({
      "fake.dispatch-throttled": [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "unknown", amount: null, currency: "" }
      }]
    });
  const throttleId = createHash("sha256").update([
    throttledDispatchPrepared.ledger.teamId,
    throttledDispatchPrepared.ledger.providerCode,
    throttledDispatchPrepared.ledger.connectionId
  ].join("\u001f")).digest("hex");
  store.prospectExecutionThrottleBuckets.push({
    id: throttleId,
    teamId: throttledDispatchPrepared.ledger.teamId,
    providerCode: throttledDispatchPrepared.ledger.providerCode,
    connectionId: throttledDispatchPrepared.ledger.connectionId,
    availableAt: "2026-07-14T00:36:10.000Z",
    version: 1,
    updatedAt: "2026-07-14T00:36:02.000Z"
  });
  const throttledDispatchResult =
    await throttledDispatchKernel.dispatchPreparedProviderRequest(
      throttledDispatchProvider,
      {
        leaseId: throttledDispatchClaim.lease.id,
        claimToken: throttledDispatchClaim.claimToken,
        ledgerId: throttledDispatchPrepared.ledger.id,
        now: "2026-07-14T00:36:03.000Z"
      }
    );
  assert.equal(throttledDispatchResult.kind, "throttled");
  assert.equal(throttledDispatchProvider.listPhysicalCalls().length, 0);
  assert.equal(
    store.prospectProviderRequestLedgers.find((item) =>
      item.id === throttledDispatchPrepared.ledger.id
    )?.status,
    "prepared"
  );
  assert.equal(
    store.prospectExecutionCheckpoints.find((item) =>
      item.runId === throttledDispatchRun.id
    )?.totalCallCount,
    0
  );
  assert.equal(
    store.agentJobs.find((item) =>
      item.id === throttledDispatchClaim.job.id
    )?.attemptCount,
    0
  );
  await throttledDispatchKernel.requestCancel(
    throttledDispatchRun.id,
    "2026-07-14T00:36:04.000Z"
  );

  const pauseRun = createRun(runOwner, ["fake.pause"]);
  const pauseKernel = new ProspectExecutionKernel({
    store,
    workerId: "pause-worker",
    allowedRunIds: [pauseRun.id],
    claimSecret: "p".repeat(32)
  });
  await pauseKernel.start("2026-07-14T01:00:00.000Z");
  const pauseProvider = new DeterministicFakeProspectProvider({
    "fake.pause": [
      {
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: true,
        cursor: "pause-cursor",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "actual", amount: 0.01, currency: "USD" }
      },
      {
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "actual", amount: 0.01, currency: "USD" }
      }
    ]
  });
  const pauseClaim = await pauseKernel.claimNext(
    "2026-07-14T01:00:01.000Z"
  );
  assert.ok(pauseClaim);
  const pauseStarted = await pauseKernel.beginRequest({
    leaseId: pauseClaim.lease.id,
    claimToken: pauseClaim.claimToken,
    now: "2026-07-14T01:00:02.000Z"
  });
  assert.equal(pauseStarted.ready, true);
  await pauseKernel.requestPause(
    pauseRun.id,
    "2026-07-14T01:00:03.000Z"
  );
  assert.equal(pauseRun.status, "pause_requested");
  if (!pauseStarted.ready) throw new Error("pause request did not start");
  const pauseResponse = await pauseProvider.search(pauseStarted.request);
  if (pauseResponse.step.kind !== "success") {
    throw new Error("pause test expected success");
  }
  const pauseSettled = await pauseKernel.completePage({
    leaseId: pauseClaim.lease.id,
    claimToken: pauseClaim.claimToken,
    result: pauseResponse.step,
    responseHash: pauseResponse.responseHash,
    now: "2026-07-14T01:00:04.000Z"
  });
  assert.equal(pauseSettled.accepted, true);
  assert.equal(pauseRun.status, "paused");
  assert.equal(
    store.prospectRunShards.find((item) => item.runId === pauseRun.id)
      ?.status,
    "paused"
  );
  const pauseEpoch = pauseRun.executionEpoch;
  await pauseKernel.resume(pauseRun.id, "2026-07-14T01:00:05.000Z");
  assert.equal(pauseRun.executionEpoch, pauseEpoch + 1);
  assert.equal(
    (await pauseKernel.executeNext(
      pauseProvider,
      "2026-07-14T01:00:06.000Z"
    )).kind,
    "success"
  );
  assert.equal(pauseRun.status, "succeeded");
  assert.doesNotThrow(() => validateProspectRunQueueBridge(store, pauseRun));

  const pauseBeforeRequestRun = createRun(runOwner, ["fake.pause-before"]);
  const pauseBeforeRequestKernel = new ProspectExecutionKernel({
    store,
    workerId: "pause-before-worker",
    allowedRunIds: [pauseBeforeRequestRun.id],
    claimSecret: "q".repeat(32)
  });
  await pauseBeforeRequestKernel.start("2026-07-14T01:10:00.000Z");
  const pauseBeforeClaim = await pauseBeforeRequestKernel.claimNext(
    "2026-07-14T01:10:01.000Z"
  );
  assert.ok(pauseBeforeClaim);
  await pauseBeforeRequestKernel.requestPause(
    pauseBeforeRequestRun.id,
    "2026-07-14T01:10:02.000Z"
  );
  assert.equal(pauseBeforeRequestRun.status, "paused");
  assert.equal(
    store.prospectExecutionLeases.find((item) =>
      item.id === pauseBeforeClaim.lease.id
    )?.releaseReason,
    "PAUSED_BEFORE_REQUEST"
  );
  assert.equal(
    store.prospectExecutionAttempts.find((item) =>
      item.leaseId === pauseBeforeClaim.lease.id
    )?.errorCode,
    "PAUSED_BEFORE_REQUEST"
  );
  await assert.rejects(
    pauseBeforeRequestKernel.beginRequest({
      leaseId: pauseBeforeClaim.lease.id,
      claimToken: pauseBeforeClaim.claimToken,
      now: "2026-07-14T01:10:03.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_LEASE_NOT_ACTIVE"
  );
  assert.doesNotThrow(
    () => validateProspectRunQueueBridge(store, pauseBeforeRequestRun)
  );

  const pauseRecoveryRun = createRun(
    runOwner,
    ["fake.pause-recovery-active", "fake.pause-recovery-waiting"]
  );
  const pauseRecoveryKernel = new ProspectExecutionKernel({
    store,
    workerId: "pause-recovery-worker-1",
    allowedRunIds: [pauseRecoveryRun.id],
    claimSecret: "r".repeat(32)
  });
  await pauseRecoveryKernel.start("2026-07-14T01:20:00.000Z");
  const pauseRecoveryClaim = await pauseRecoveryKernel.claimNext(
    "2026-07-14T01:20:01.000Z"
  );
  assert.ok(pauseRecoveryClaim);
  const pauseRecoveryStarted = await pauseRecoveryKernel.beginRequest({
    leaseId: pauseRecoveryClaim.lease.id,
    claimToken: pauseRecoveryClaim.claimToken,
    now: "2026-07-14T01:20:02.000Z"
  });
  assert.equal(pauseRecoveryStarted.ready, true);
  await pauseRecoveryKernel.requestPause(
    pauseRecoveryRun.id,
    "2026-07-14T01:20:03.000Z"
  );
  assert.equal(pauseRecoveryRun.status, "pause_requested");
  const pauseRecoveryRestarted = new ProspectExecutionKernel({
    store,
    workerId: "pause-recovery-worker-2",
    allowedRunIds: [pauseRecoveryRun.id],
    claimSecret: "r".repeat(32)
  });
  await pauseRecoveryRestarted.start("2026-07-14T01:20:04.000Z");
  assert.equal(pauseRecoveryRun.status, "paused");
  assert.equal(
    store.prospectRunShards.find((item) =>
      item.id === pauseRecoveryClaim.shard.id
    )?.status,
    "failed"
  );
  assert.equal(
    store.prospectRunShards.find((item) =>
      item.runId === pauseRecoveryRun.id
      && item.id !== pauseRecoveryClaim.shard.id
    )?.status,
    "paused"
  );
  assert.doesNotThrow(
    () => validateProspectRunQueueBridge(store, pauseRecoveryRun)
  );

  const cancelRun = createRun(runOwner, ["fake.cancel"]);
  const cancelKernel = new ProspectExecutionKernel({
    store,
    workerId: "cancel-worker",
    allowedRunIds: [cancelRun.id],
    claimSecret: "x".repeat(32)
  });
  await cancelKernel.start("2026-07-14T02:00:00.000Z");
  const cancelProvider = new DeterministicFakeProspectProvider({
    "fake.cancel": [{
      kind: "success",
      acceptedCount: 9,
      rawCount: 9,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: false,
      cursor: "",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 9 },
      cost: { kind: "actual", amount: 0.03, currency: "USD" }
    }]
  });
  const cancelClaim = await cancelKernel.claimNext(
    "2026-07-14T02:00:01.000Z"
  );
  assert.ok(cancelClaim);
  const cancelStarted = await cancelKernel.beginRequest({
    leaseId: cancelClaim.lease.id,
    claimToken: cancelClaim.claimToken,
    now: "2026-07-14T02:00:02.000Z"
  });
  if (!cancelStarted.ready) throw new Error("cancel request did not start");
  const pageCountBeforeCancel = store.prospectExecutionPages.length;
  await cancelKernel.requestCancel(
    cancelRun.id,
    "2026-07-14T02:00:03.000Z"
  );
  assert.equal(cancelRun.status, "cancel_requested");
  await assert.rejects(
    cancelKernel.heartbeat({
      leaseId: cancelClaim.lease.id,
      claimToken: cancelClaim.claimToken,
      now: "2026-07-14T02:00:04.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_LEASE_FENCE_INVALID"
  );
  const cancelResponse = await cancelProvider.search(cancelStarted.request);
  if (cancelResponse.step.kind !== "success") {
    throw new Error("cancel test expected success");
  }
  const cancelledLate = await cancelKernel.completePage({
    leaseId: cancelClaim.lease.id,
    claimToken: cancelClaim.claimToken,
    result: cancelResponse.step,
    responseHash: cancelResponse.responseHash,
    now: "2026-07-14T02:00:05.000Z"
  });
  assert.equal(cancelledLate.accepted, false);
  assert.equal(cancelledLate.lateCancellation, true);
  assert.equal(cancelRun.status, "cancelled");
  assert.equal(store.prospectExecutionPages.length, pageCountBeforeCancel);
  assert.equal(
    store.prospectExecutionAttempts.find((item) =>
      item.leaseId === cancelClaim.lease.id
    )?.status,
    "cancelled_late"
  );
  assert.doesNotThrow(() => validateProspectRunQueueBridge(store, cancelRun));

  const cancelBeforeRequestRun = createRun(
    runOwner,
    ["fake.cancel-before"]
  );
  const cancelBeforeRequestKernel = new ProspectExecutionKernel({
    store,
    workerId: "cancel-before-worker",
    allowedRunIds: [cancelBeforeRequestRun.id],
    claimSecret: "y".repeat(32)
  });
  await cancelBeforeRequestKernel.start("2026-07-14T02:10:00.000Z");
  const cancelBeforeClaim = await cancelBeforeRequestKernel.claimNext(
    "2026-07-14T02:10:01.000Z"
  );
  assert.ok(cancelBeforeClaim);
  await cancelBeforeRequestKernel.requestCancel(
    cancelBeforeRequestRun.id,
    "2026-07-14T02:10:02.000Z"
  );
  assert.equal(cancelBeforeRequestRun.status, "cancelled");
  assert.equal(
    store.prospectExecutionLeases.find((item) =>
      item.id === cancelBeforeClaim.lease.id
    )?.releaseReason,
    "CANCELLED_BEFORE_REQUEST"
  );
  assert.equal(
    store.prospectExecutionCheckpoints.find((item) =>
      item.runId === cancelBeforeRequestRun.id
    )?.completionReason,
    "CANCELLED_BY_USER"
  );
  assert.doesNotThrow(
    () => validateProspectRunQueueBridge(store, cancelBeforeRequestRun)
  );

  const unknownRun = createRun(runOwner, ["fake.unknown"]);
  const unknownKernel = new ProspectExecutionKernel({
    store,
    workerId: "unknown-worker-1",
    allowedRunIds: [unknownRun.id],
    claimSecret: "u".repeat(32)
  });
  await unknownKernel.start("2026-07-14T03:00:00.000Z");
  const unknownClaim = await unknownKernel.claimNext(
    "2026-07-14T03:00:01.000Z"
  );
  assert.ok(unknownClaim);
  const unknownStarted = await unknownKernel.beginRequest({
    leaseId: unknownClaim.lease.id,
    claimToken: unknownClaim.claimToken,
    now: "2026-07-14T03:00:02.000Z"
  });
  assert.equal(unknownStarted.ready, true);
  const recoveryKernel = new ProspectExecutionKernel({
    store,
    workerId: "unknown-worker-2",
    allowedRunIds: [unknownRun.id],
    claimSecret: "u".repeat(32)
  });
  await recoveryKernel.start("2026-07-14T03:00:03.000Z");
  assert.equal(unknownRun.status, "failed");
  assert.equal(
    store.prospectExecutionAttempts.find((item) =>
      item.leaseId === unknownClaim.lease.id
    )?.status,
    "request_outcome_unknown"
  );
  assert.equal(
    await recoveryKernel.claimNext("2026-07-14T03:00:04.000Z"),
    null,
    "REQUEST_OUTCOME_UNKNOWN 不得自动重试"
  );
  assert.doesNotThrow(() => validateProspectRunQueueBridge(store, unknownRun));

  const partialRun = createRun(runOwner, ["fake.fail", "fake.continue"]);
  const partialKernel = new ProspectExecutionKernel({
    store,
    workerId: "partial-worker",
    allowedRunIds: [partialRun.id],
    claimSecret: "f".repeat(32)
  });
  await partialKernel.start("2026-07-14T04:00:00.000Z");
  const partialProvider = new DeterministicFakeProspectProvider({
    "fake.fail": [
      {
        kind: "failure",
        errorCode: "PROVIDER_TIMEOUT",
        errorMessage: "timeout-1",
        retryable: true,
        retryAfterAt: "2026-07-14T04:00:02.000Z",
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "unknown", amount: null, currency: "" }
      },
      {
        kind: "failure",
        errorCode: "PROVIDER_TIMEOUT",
        errorMessage: "timeout-2",
        retryable: true,
        retryAfterAt: "2026-07-14T04:00:03.000Z",
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "unknown", amount: null, currency: "" }
      },
      {
        kind: "failure",
        errorCode: "PROVIDER_TIMEOUT",
        errorMessage: "timeout-3",
        retryable: true,
        retryAfterAt: "2026-07-14T04:00:04.000Z",
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "unknown", amount: null, currency: "" }
      }
    ],
    "fake.continue": [{
      kind: "success",
      acceptedCount: 1,
      rawCount: 1,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: false,
      cursor: "",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 1 },
      cost: { kind: "actual", amount: 0.01, currency: "USD" }
    }]
  });
  await partialKernel.executeNext(
    partialProvider,
    "2026-07-14T04:00:01.000Z"
  );
  await partialKernel.executeNext(
    partialProvider,
    "2026-07-14T04:00:02.000Z"
  );
  await partialKernel.executeNext(
    partialProvider,
    "2026-07-14T04:00:03.000Z"
  );
  assert.equal(
    store.agentJobs.find((item) =>
      item.id === store.prospectRunQueueChildBindings.find((binding) =>
        binding.runId === partialRun.id
        && store.prospectRunShards.find((shard) =>
          shard.id === binding.shardId
        )?.providerCode === "fake.fail"
      )?.jobId
    )?.status,
    "dead_letter"
  );
  assert.equal(partialRun.status, "running");
  await partialKernel.executeNext(
    partialProvider,
    "2026-07-14T04:00:04.000Z"
  );
  assert.equal(partialRun.status, "partial_success");
  assert.doesNotThrow(() => validateProspectRunQueueBridge(store, partialRun));

  const rollbackRun = createRun(runOwner, ["fake.rollback"]);
  const rollbackWriterKernel = new ProspectExecutionKernel({
    store,
    workerId: "rollback-writer",
    allowedRunIds: [rollbackRun.id],
    claimSecret: "v".repeat(32),
    cursorSecret: "a".repeat(32)
  });
  await rollbackWriterKernel.start("2026-07-14T05:00:00.000Z");
  const rollbackProvider = new DeterministicFakeProspectProvider({
    "fake.rollback": [{
      kind: "success",
      acceptedCount: 1,
      rawCount: 1,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: true,
      cursor: "rollback-private-cursor",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 1 },
      cost: { kind: "actual", amount: 0, currency: "USD" }
    }]
  });
  assert.equal(
    (
      await rollbackWriterKernel.executeNext(
        rollbackProvider,
        "2026-07-14T05:00:01.000Z"
      )
    ).kind,
    "success"
  );
  const rollbackReaderKernel = new ProspectExecutionKernel({
    store,
    workerId: "rollback-reader",
    allowedRunIds: [rollbackRun.id],
    claimSecret: "v".repeat(32),
    cursorSecret: "b".repeat(32)
  });
  await rollbackReaderKernel.start("2026-07-14T05:00:02.000Z");
  const rollbackClaim = await rollbackReaderKernel.claimNext(
    "2026-07-14T05:00:03.000Z"
  );
  assert.ok(rollbackClaim);
  const beforeRejectedBegin = executionStateSnapshot();
  await assert.rejects(
    rollbackReaderKernel.beginRequest({
      leaseId: rollbackClaim.lease.id,
      claimToken: rollbackClaim.claimToken,
      now: "2026-07-14T05:00:04.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_CURSOR_INVALID"
  );
  assert.deepEqual(executionStateSnapshot(), beforeRejectedBegin);
  assert.doesNotThrow(
    () => validateProspectRunQueueBridge(store, rollbackRun)
  );
  await rollbackReaderKernel.requestCancel(
    rollbackRun.id,
    "2026-07-14T05:00:05.000Z"
  );

  const shortTagRun = createRun(runOwner, ["fake.short-tag"]);
  const shortTagWriterKernel = new ProspectExecutionKernel({
    store,
    workerId: "short-tag-writer",
    allowedRunIds: [shortTagRun.id],
    claimSecret: "w".repeat(32),
    cursorSecret: "c".repeat(32)
  });
  await shortTagWriterKernel.start("2026-07-14T05:10:00.000Z");
  const shortTagProvider = new DeterministicFakeProspectProvider({
    "fake.short-tag": [{
      kind: "success",
      acceptedCount: 1,
      rawCount: 1,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: true,
      cursor: "short-tag-private-cursor",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 1 },
      cost: { kind: "actual", amount: 0, currency: "USD" }
    }]
  });
  assert.equal(
    (
      await shortTagWriterKernel.executeNext(
        shortTagProvider,
        "2026-07-14T05:10:01.000Z"
      )
    ).kind,
    "success"
  );
  const shortTagReaderKernel = new ProspectExecutionKernel({
    store,
    workerId: "short-tag-reader",
    allowedRunIds: [shortTagRun.id],
    claimSecret: "w".repeat(32),
    cursorSecret: "c".repeat(32)
  });
  await shortTagReaderKernel.start("2026-07-14T05:10:02.000Z");
  const shortTagClaim = await shortTagReaderKernel.claimNext(
    "2026-07-14T05:10:03.000Z"
  );
  assert.ok(shortTagClaim);
  const shortTagCheckpoint =
    store.prospectExecutionCheckpoints.find(
      (item) => item.runId === shortTagRun.id
    )!;
  const shortTagParts = shortTagCheckpoint.encryptedCursor.split(".");
  shortTagParts[2] = Buffer.from(
    shortTagParts[2]!,
    "base64url"
  ).subarray(0, 15).toString("base64url");
  shortTagCheckpoint.encryptedCursor = shortTagParts.join(".");
  const beforeShortTagRejection = executionStateSnapshot();
  await assert.rejects(
    shortTagReaderKernel.beginRequest({
      leaseId: shortTagClaim.lease.id,
      claimToken: shortTagClaim.claimToken,
      now: "2026-07-14T05:10:04.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_CURSOR_INVALID"
  );
  assert.deepEqual(executionStateSnapshot(), beforeShortTagRejection);
  await shortTagReaderKernel.requestCancel(
    shortTagRun.id,
    "2026-07-14T05:10:05.000Z"
  );

  const cursorHashRun = createRun(runOwner, ["fake.cursor-hash"]);
  const cursorHashWriterKernel = new ProspectExecutionKernel({
    store,
    workerId: "cursor-hash-writer",
    allowedRunIds: [cursorHashRun.id],
    claimSecret: "z".repeat(32),
    cursorSecret: "d".repeat(32)
  });
  await cursorHashWriterKernel.start("2026-07-14T05:20:00.000Z");
  const cursorHashProvider = new DeterministicFakeProspectProvider({
    "fake.cursor-hash": [{
      kind: "success",
      acceptedCount: 1,
      rawCount: 1,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: true,
      cursor: "hash-private-cursor",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 1 },
      cost: { kind: "actual", amount: 0, currency: "USD" }
    }]
  });
  assert.equal(
    (
      await cursorHashWriterKernel.executeNext(
        cursorHashProvider,
        "2026-07-14T05:20:01.000Z"
      )
    ).kind,
    "success"
  );
  const cursorHashReaderKernel = new ProspectExecutionKernel({
    store,
    workerId: "cursor-hash-reader",
    allowedRunIds: [cursorHashRun.id],
    claimSecret: "z".repeat(32),
    cursorSecret: "d".repeat(32)
  });
  await cursorHashReaderKernel.start("2026-07-14T05:20:02.000Z");
  const cursorHashClaim = await cursorHashReaderKernel.claimNext(
    "2026-07-14T05:20:03.000Z"
  );
  assert.ok(cursorHashClaim);
  const cursorHashCheckpoint =
    store.prospectExecutionCheckpoints.find(
      (item) => item.runId === cursorHashRun.id
    )!;
  cursorHashCheckpoint.cursorHash = "0".repeat(64);
  const beforeCursorHashRejection = executionStateSnapshot();
  await assert.rejects(
    cursorHashReaderKernel.beginRequest({
      leaseId: cursorHashClaim.lease.id,
      claimToken: cursorHashClaim.claimToken,
      now: "2026-07-14T05:20:04.000Z"
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_CURSOR_INVALID"
  );
  assert.deepEqual(executionStateSnapshot(), beforeCursorHashRejection);
  await cursorHashReaderKernel.requestCancel(
    cursorHashRun.id,
    "2026-07-14T05:20:05.000Z"
  );

  const crossRunSnapshot = snapshot(["fake.cross-run-position"]);
  crossRunSnapshot.providerPlan[0]!.pageLimit = 1;
  const crossRunSource = createRun(
    runOwner,
    ["fake.cross-run-position"],
    crossRunSnapshot
  );
  const crossRunCursorSecret = "x".repeat(32);
  const crossRunSourceKernel = new ProspectExecutionKernel({
    store,
    workerId: "cross-run-source-worker",
    allowedRunIds: [crossRunSource.id],
    claimSecret: "y".repeat(32),
    cursorSecret: crossRunCursorSecret
  });
  await crossRunSourceKernel.start("2026-07-14T05:25:00.000Z");
  const crossRunSourceProvider =
    new DeterministicFakeProspectProvider({
      "fake.cross-run-position": [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: true,
        cursor: "cross-run-page-2",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "actual", amount: 0, currency: "USD" }
      }]
    });
  assert.equal(
    (
      await crossRunSourceKernel.executeNext(
        crossRunSourceProvider,
        "2026-07-14T05:25:01.000Z"
      )
    ).kind,
    "success"
  );
  const continuablePosition =
    store.prospectStrategySourcePositions.find((item) =>
      item.sourceRunId === crossRunSource.id
    );
  assert.ok(continuablePosition);
  assert.equal(continuablePosition.status, "continuable");
  assert.equal(continuablePosition.version, 1);
  assert.equal(
    continuablePosition.encryptedCursor.includes("cross-run-page-2"),
    false
  );
  assert.equal(
    store.prospectRunShards.find((item) =>
      item.runId === crossRunSource.id
    )?.hasCursor,
    false
  );
  assert.equal(
    JSON.stringify(store.prospectExecutionEvents.filter((item) =>
      item.runId === crossRunSource.id
    )).includes("cross-run-page-2"),
    false
  );

  const crossRunResume = repeatedRun(runOwner, crossRunSource);
  const crossRunResumeKernel = new ProspectExecutionKernel({
    store,
    workerId: "cross-run-resume-worker",
    allowedRunIds: [crossRunResume.id],
    claimSecret: "y".repeat(32),
    cursorSecret: crossRunCursorSecret
  });
  await crossRunResumeKernel.start("2026-07-14T05:25:02.000Z");
  const crossRunResumeProvider =
    new DeterministicFakeProspectProvider({
      "fake.cross-run-position": [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "actual", amount: 0, currency: "USD" }
      }]
    });
  let resumedCursor = "";
  assert.equal(
    (
      await crossRunResumeKernel.executeNext({
        search: async (request) => {
          resumedCursor = request.cursor;
          return crossRunResumeProvider.search(request);
        }
      }, "2026-07-14T05:25:03.000Z")
    ).kind,
    "success"
  );
  assert.equal(resumedCursor, "cross-run-page-2");
  const exhaustedPosition =
    store.prospectStrategySourcePositions.find((item) =>
      item.id === continuablePosition.id
    );
  assert.ok(exhaustedPosition);
  assert.equal(exhaustedPosition.status, "exhausted");
  assert.equal(exhaustedPosition.version, 2);
  assert.equal(exhaustedPosition.encryptedCursor, "");
  assert.equal(exhaustedPosition.sourceRunId, crossRunResume.id);

  const crossRunExhausted = repeatedRun(runOwner, crossRunSource);
  const crossRunExhaustedKernel = new ProspectExecutionKernel({
    store,
    workerId: "cross-run-exhausted-worker",
    allowedRunIds: [crossRunExhausted.id],
    claimSecret: "y".repeat(32),
    cursorSecret: crossRunCursorSecret
  });
  await crossRunExhaustedKernel.start("2026-07-14T05:25:04.000Z");
  let exhaustedProviderCalls = 0;
  assert.equal(
    (
      await crossRunExhaustedKernel.executeNext({
        search: async () => {
          exhaustedProviderCalls += 1;
          throw new Error("exhausted position must not call Provider");
        }
      }, "2026-07-14T05:25:05.000Z")
    ).kind,
    "idle"
  );
  assert.equal(exhaustedProviderCalls, 0);
  assert.equal(crossRunExhausted.status, "succeeded_empty");
  assert.equal(
    store.prospectRunShards.find((item) =>
      item.runId === crossRunExhausted.id
    )?.status,
    "succeeded_empty"
  );
  assert.equal(
    store.prospectExecutionCheckpoints.find((item) =>
      item.runId === crossRunExhausted.id
    )?.completionReason,
    "SOURCE_POSITION_EXHAUSTED"
  );

  const failedResumeSnapshot = snapshot(["fake.failed-resume"]);
  failedResumeSnapshot.providerPlan[0]!.pageLimit = 1;
  const failedResumeSource = createRun(
    runOwner,
    ["fake.failed-resume"],
    failedResumeSnapshot
  );
  const failedResumeCursorSecret = "f".repeat(32);
  const failedResumeSourceKernel = new ProspectExecutionKernel({
    store,
    workerId: "failed-resume-source-worker",
    allowedRunIds: [failedResumeSource.id],
    claimSecret: "g".repeat(32),
    cursorSecret: failedResumeCursorSecret
  });
  await failedResumeSourceKernel.start("2026-07-14T05:26:00.000Z");
  const failedResumeSourceProvider =
    new DeterministicFakeProspectProvider({
      "fake.failed-resume": [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: true,
        cursor: "retry-this-page",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "actual", amount: 0, currency: "USD" }
      }]
    });
  await failedResumeSourceKernel.executeNext(
    failedResumeSourceProvider,
    "2026-07-14T05:26:01.000Z"
  );
  const positionBeforeFailure = structuredClone(
    store.prospectStrategySourcePositions.find((item) =>
      item.sourceRunId === failedResumeSource.id
    )
  );
  assert.ok(positionBeforeFailure);

  const failedResumeRun = repeatedRun(runOwner, failedResumeSource);
  const failedResumeKernel = new ProspectExecutionKernel({
    store,
    workerId: "failed-resume-worker",
    allowedRunIds: [failedResumeRun.id],
    claimSecret: "g".repeat(32),
    cursorSecret: failedResumeCursorSecret
  });
  await failedResumeKernel.start("2026-07-14T05:26:02.000Z");
  const failedResumeProvider =
    new DeterministicFakeProspectProvider({
      "fake.failed-resume": [{
        kind: "failure",
        errorCode: "PROVIDER_REJECTED",
        errorMessage: "request rejected",
        retryable: false,
        retryAfterAt: "",
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "unknown", amount: null, currency: "" }
      }]
    });
  let failedResumeCursor = "";
  assert.equal(
    (
      await failedResumeKernel.executeNext({
        search: async (request) => {
          failedResumeCursor = request.cursor;
          return failedResumeProvider.search(request);
        }
      }, "2026-07-14T05:26:03.000Z")
    ).kind,
    "failure"
  );
  assert.equal(failedResumeCursor, "retry-this-page");
  assert.deepEqual(
    store.prospectStrategySourcePositions.find((item) =>
      item.id === positionBeforeFailure.id
    ),
    positionBeforeFailure
  );

  const changedQueryRun = repeatedRun(
    runOwner,
    failedResumeSource,
    (executionSnapshot) => {
      executionSnapshot.strategy.queryFingerprint = "e".repeat(64);
    }
  );
  const changedQueryKernel = new ProspectExecutionKernel({
    store,
    workerId: "changed-query-worker",
    allowedRunIds: [changedQueryRun.id],
    claimSecret: "g".repeat(32),
    cursorSecret: failedResumeCursorSecret
  });
  await changedQueryKernel.start("2026-07-14T05:26:04.000Z");
  const changedQueryProvider =
    new DeterministicFakeProspectProvider({
      "fake.failed-resume": [{
        kind: "success",
        acceptedCount: 0,
        rawCount: 0,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "actual", amount: 0, currency: "USD" }
      }]
    });
  let changedQueryCursor = "not-observed";
  await changedQueryKernel.executeNext({
    search: async (request) => {
      changedQueryCursor = request.cursor;
      return changedQueryProvider.search(request);
    }
  }, "2026-07-14T05:26:05.000Z");
  assert.equal(changedQueryCursor, "");

  const isolatedOwner: User = {
    ...runOwner,
    id: `u_isolated_${randomUUID()}`,
    name: "Isolated Owner",
    email: `isolated-${randomUUID()}@example.test`
  };
  store.users.push(isolatedOwner);
  const isolatedOwnerRun = repeatedRun(isolatedOwner, failedResumeSource);
  const isolatedOwnerKernel = new ProspectExecutionKernel({
    store,
    workerId: "isolated-owner-worker",
    allowedRunIds: [isolatedOwnerRun.id],
    claimSecret: "g".repeat(32),
    cursorSecret: failedResumeCursorSecret
  });
  await isolatedOwnerKernel.start("2026-07-14T05:26:06.000Z");
  const isolatedOwnerProvider =
    new DeterministicFakeProspectProvider({
      "fake.failed-resume": [{
        kind: "success",
        acceptedCount: 0,
        rawCount: 0,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: false,
        cursor: "",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "actual", amount: 0, currency: "USD" }
      }]
    });
  let isolatedOwnerCursor = "not-observed";
  await isolatedOwnerKernel.executeNext({
    search: async (request) => {
      isolatedOwnerCursor = request.cursor;
      return isolatedOwnerProvider.search(request);
    }
  }, "2026-07-14T05:26:07.000Z");
  assert.equal(isolatedOwnerCursor, "");

  const slowResponseRun = createRun(runOwner, ["fake.slow-response"]);
  const slowResponseKernel = new ProspectExecutionKernel({
    store,
    workerId: "slow-response-worker",
    allowedRunIds: [slowResponseRun.id],
    claimSecret: "l".repeat(32),
    leaseMs: 1_000,
    deadlineMs: 1_000
  });
  await slowResponseKernel.start("2026-07-14T05:30:00.000Z");
  const slowResponseProvider = new DelayedFakeProspectProvider({
    "fake.slow-response": [{
      kind: "success",
      acceptedCount: 1,
      rawCount: 1,
      invalidCount: 0,
      duplicateCount: 0,
      hasMore: false,
      cursor: "",
      partial: false,
      usage: { requestUnits: 1, resultUnits: 1 },
      cost: { kind: "actual", amount: 0, currency: "USD" }
    }]
  }, 1_100);
  await assert.rejects(
    slowResponseKernel.executeNext(
      slowResponseProvider,
      "2026-07-14T05:30:01.000Z"
    ),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_LEASE_FENCE_INVALID"
  );
  assert.equal(
    store.prospectExecutionPages.some(
      (item) => item.runId === slowResponseRun.id
    ),
    false
  );
  assert.equal(
    store.prospectExecutionAttempts.find(
      (item) => item.runId === slowResponseRun.id
    )?.status,
    "request_started"
  );
  assert.equal(
    await slowResponseKernel.recoverExpiredLeases(
      "2026-07-14T05:30:03.000Z"
    ),
    1
  );
  assert.equal(slowResponseRun.status, "failed");
  assert.equal(
    store.prospectExecutionAttempts.find(
      (item) => item.runId === slowResponseRun.id
    )?.status,
    "request_outcome_unknown"
  );

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  assert.throws(
    () => new ProspectExecutionKernel({
      store,
      workerId: "production-worker",
      allowedRunIds: [run.id],
      claimSecret: "s".repeat(32)
    }),
    (error: unknown) =>
      error instanceof ProspectExecutionKernelError
      && error.code === "EXECUTION_PERSISTED_RUN_SCOPE_REQUIRED"
  );
  process.env.NODE_ENV = previousNodeEnv;
  console.log("Prospect execution claim/lease tests passed");
} finally {
  store.users.splice(0, store.users.length, ...original.users);
  store.prospectSearchRuns.splice(0, store.prospectSearchRuns.length, ...original.runs);
  store.prospectRunShards.splice(0, store.prospectRunShards.length, ...original.shards);
  store.prospectRunEvents.splice(0, store.prospectRunEvents.length, ...original.runEvents);
  store.agentJobs.splice(0, store.agentJobs.length, ...original.jobs);
  store.prospectRunQueueParentBindings.splice(
    0,
    store.prospectRunQueueParentBindings.length,
    ...original.parentBindings
  );
  store.prospectRunQueueChildBindings.splice(
    0,
    store.prospectRunQueueChildBindings.length,
    ...original.childBindings
  );
  store.prospectExecutionKernelStates.splice(
    0,
    store.prospectExecutionKernelStates.length,
    ...original.kernelStates
  );
  store.prospectExecutionCheckpoints.splice(
    0,
    store.prospectExecutionCheckpoints.length,
    ...original.checkpoints
  );
  store.prospectStrategySourcePositions.splice(
    0,
    store.prospectStrategySourcePositions.length,
    ...original.sourcePositions
  );
  store.prospectExecutionLeases.splice(
    0,
    store.prospectExecutionLeases.length,
    ...original.leases
  );
  store.prospectExecutionAttempts.splice(
    0,
    store.prospectExecutionAttempts.length,
    ...original.attempts
  );
  store.prospectProviderRequestLedgers.splice(
    0,
    store.prospectProviderRequestLedgers.length,
    ...original.providerRequestLedgers
  );
  store.prospectProviderRequestDispatches.splice(
    0,
    store.prospectProviderRequestDispatches.length,
    ...original.providerRequestDispatches
  );
  store.prospectProviderRequestEvents.splice(
    0,
    store.prospectProviderRequestEvents.length,
    ...original.providerRequestEvents
  );
  store.prospectProviderRequestAttemptBindings.splice(
    0,
    store.prospectProviderRequestAttemptBindings.length,
    ...original.providerRequestAttemptBindings
  );
  store.prospectProviderRequestAccountingEvidence.splice(
    0,
    store.prospectProviderRequestAccountingEvidence.length,
    ...original.providerRequestAccountingEvidence
  );
  store.prospectSourceRawBatches.splice(
    0,
    store.prospectSourceRawBatches.length,
    ...original.sourceRawBatches
  );
  store.prospectSourceRawRecords.splice(
    0,
    store.prospectSourceRawRecords.length,
    ...original.sourceRawRecords
  );
  store.prospectSourceRawHits.splice(
    0,
    store.prospectSourceRawHits.length,
    ...original.sourceRawHits
  );
  store.prospectExecutionPages.splice(
    0,
    store.prospectExecutionPages.length,
    ...original.pages
  );
  store.prospectExecutionEvents.splice(
    0,
    store.prospectExecutionEvents.length,
    ...original.events
  );
  store.prospectExecutionThrottleBuckets.splice(
    0,
    store.prospectExecutionThrottleBuckets.length,
    ...original.throttles
  );
}
