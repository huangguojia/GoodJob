import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { publicUser } from "./auth.js";
import {
  activateProspectCampaign,
  createProspectCampaign,
  prospectCampaignEtag
} from "./prospect-campaigns.js";
import {
  ProspectExecutionKernel,
  ProspectExecutionKernelError
} from "./prospect-execution-kernel.js";
import {
  DeterministicFakeProspectProvider
} from "./prospect-fake-provider.js";
import type {
  FakeProspectProviderDispatchRequest
} from "./prospect-fake-provider.js";
import { createMysqlStore } from "./mysql-store.js";
import { createProspectRun } from "./prospect-runs.js";
import {
  PROSPECT_SOURCE_RAW_SCHEMA_VERSION
} from "./prospect-source-raw.js";
import {
  approveProspectStrategy,
  prospectStrategyEtag,
  updateProspectStrategy
} from "./prospect-strategies.js";
import type { CrmStore } from "./store.js";

function connectionOptions(databaseUrl: URL) {
  return {
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password)
  };
}

function sqlString(value: string) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

const fullSnapshot = {
  goal: "开发公开资料可核验的德国工业照明进口商",
  products: ["LED flood light"],
  markets: ["Germany"],
  customerTypes: ["Importer"],
  applicationScenarios: ["Warehouse project"],
  icpRules: ["Has a public industrial lighting catalog"],
  exclusionRules: ["Consumer-only retailer"],
  sourceProviderIds: ["gleif"]
};

function executionStateSnapshot(store: CrmStore) {
  return {
    runs: structuredClone(store.prospectSearchRuns),
    shards: structuredClone(store.prospectRunShards),
    runEvents: structuredClone(store.prospectRunEvents),
    jobs: structuredClone(store.agentJobs),
    parentBindings: structuredClone(
      store.prospectRunQueueParentBindings
    ),
    childBindings: structuredClone(
      store.prospectRunQueueChildBindings
    ),
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
    providerRequestAttemptBindings:
      structuredClone(store.prospectProviderRequestAttemptBindings),
    providerRequestEvents:
      structuredClone(store.prospectProviderRequestEvents),
    providerRequestAccountingEvidence:
      structuredClone(store.prospectProviderRequestAccountingEvidence),
    pages: structuredClone(store.prospectExecutionPages),
    events: structuredClone(store.prospectExecutionEvents),
    throttles: structuredClone(store.prospectExecutionThrottleBuckets)
  };
}

function restoreExecutionState(
  store: CrmStore,
  snapshot: ReturnType<typeof executionStateSnapshot>
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
    ...snapshot.runEvents
  );
  store.agentJobs.splice(0, store.agentJobs.length, ...snapshot.jobs);
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
  store.prospectExecutionKernelStates.splice(
    0,
    store.prospectExecutionKernelStates.length,
    ...snapshot.kernelStates
  );
  store.prospectExecutionCheckpoints.splice(
    0,
    store.prospectExecutionCheckpoints.length,
    ...snapshot.checkpoints
  );
  store.prospectStrategySourcePositions.splice(
    0,
    store.prospectStrategySourcePositions.length,
    ...snapshot.sourcePositions
  );
  store.prospectExecutionLeases.splice(
    0,
    store.prospectExecutionLeases.length,
    ...snapshot.leases
  );
  store.prospectExecutionAttempts.splice(
    0,
    store.prospectExecutionAttempts.length,
    ...snapshot.attempts
  );
  store.prospectProviderRequestLedgers.splice(
    0,
    store.prospectProviderRequestLedgers.length,
    ...snapshot.providerRequestLedgers
  );
  store.prospectProviderRequestDispatches.splice(
    0,
    store.prospectProviderRequestDispatches.length,
    ...snapshot.providerRequestDispatches
  );
  store.prospectProviderRequestAttemptBindings.splice(
    0,
    store.prospectProviderRequestAttemptBindings.length,
    ...snapshot.providerRequestAttemptBindings
  );
  store.prospectProviderRequestEvents.splice(
    0,
    store.prospectProviderRequestEvents.length,
    ...snapshot.providerRequestEvents
  );
  store.prospectProviderRequestAccountingEvidence.splice(
    0,
    store.prospectProviderRequestAccountingEvidence.length,
    ...snapshot.providerRequestAccountingEvidence
  );
  store.prospectExecutionPages.splice(
    0,
    store.prospectExecutionPages.length,
    ...snapshot.pages
  );
  store.prospectExecutionEvents.splice(
    0,
    store.prospectExecutionEvents.length,
    ...snapshot.events
  );
  store.prospectExecutionThrottleBuckets.splice(
    0,
    store.prospectExecutionThrottleBuckets.length,
    ...snapshot.throttles
  );
}

async function expectRejectedMutation(
  store: CrmStore,
  mutate: () => void,
  pattern: RegExp
) {
  const before = executionStateSnapshot(store);
  try {
    mutate();
    await assert.rejects(store.persist(), pattern);
  } finally {
    restoreExecutionState(store, before);
  }
}

class MysqlInspectingFakeProspectProvider
  extends DeterministicFakeProspectProvider {
  constructor(
    scripts: ConstructorParameters<
      typeof DeterministicFakeProspectProvider
    >[0],
    private readonly inspect: (
      request: FakeProspectProviderDispatchRequest
    ) => Promise<void>
  ) {
    super(scripts);
  }

  override async dispatch(request: FakeProspectProviderDispatchRequest) {
    await this.inspect(request);
    return super.dispatch(request);
  }
}

async function main() {
  const applicationUrl = process.env.DATABASE_URL
    || process.env.MYSQL_URL
    || process.env.MYSQL_TEST_ADMIN_URL;
  const adminConnectionUrl = process.env.MYSQL_TEST_ADMIN_URL
    || applicationUrl;
  if (!applicationUrl || !adminConnectionUrl) {
    throw new Error(
      "Prospect execution MySQL test requires MYSQL_TEST_ADMIN_URL, "
      + "DATABASE_URL or MYSQL_URL"
    );
  }

  const adminUrl = new URL(adminConnectionUrl);
  const appUrl = new URL(applicationUrl);
  const databaseName =
    `goodjob_execution_test_${
      randomUUID().replaceAll("-", "").slice(0, 16)
    }`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let databaseCreated = false;
  let grantedAccount = "";
  let exitCode = 1;
  let stage = "create database";
  const timelineStart = Date.now() + 10 * 60_000;
  let timelineTick = 0;
  const tick = () => new Date(
    timelineStart + timelineTick++ * 1_000
  ).toISOString();

  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    databaseCreated = true;
    const appProbe = await mysql.createConnection(connectionOptions(appUrl));
    const [accountRows] = await appProbe.query<Array<RowDataPacket>>(
      "SELECT CURRENT_USER() AS account"
    );
    await appProbe.end();
    grantedAccount = String(accountRows[0]?.account || "");
    const separator = grantedAccount.lastIndexOf("@");
    if (separator <= 0) {
      throw new Error("Cannot resolve MySQL application account");
    }
    const accountUser = grantedAccount.slice(0, separator);
    const accountHost = grantedAccount.slice(separator + 1);
    await admin.query(
      `GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO ${
        sqlString(accountUser)
      }@${sqlString(accountHost)}`
    );
    const testUrl = new URL(applicationUrl);
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();
    delete process.env.MYSQL_URL;

    stage = "import deployment baseline schema";
    const schemaConnection = await mysql.createConnection({
      ...connectionOptions(testUrl),
      database: databaseName,
      multipleStatements: true
    });
    try {
      const schemaSql = await readFile(
        new URL("../schema.mysql.sql", import.meta.url),
        "utf8"
      );
      await schemaConnection.query(schemaSql);
    } finally {
      await schemaConnection.end();
    }
    const [executionTables] = await admin.query<Array<RowDataPacket>>(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = ?
         AND table_name IN (
           'search_execution_kernel_state',
           'prospect_execution_checkpoints',
           'prospect_execution_leases',
           'prospect_execution_attempts',
           'prospect_execution_pages',
           'prospect_execution_events',
           'prospect_execution_throttles',
           'prospect_strategy_source_positions',
           'prospect_source_raw_batches',
           'prospect_source_raw_records',
           'prospect_source_raw_hits'
         )
       ORDER BY table_name`,
      [databaseName]
    );
    assert.deepEqual(
      executionTables.map((row) => String(row.tableName)),
      [
        "prospect_execution_attempts",
        "prospect_execution_checkpoints",
        "prospect_execution_events",
        "prospect_execution_leases",
        "prospect_execution_pages",
        "prospect_execution_throttles",
        "prospect_source_raw_batches",
        "prospect_source_raw_hits",
        "prospect_source_raw_records",
        "prospect_strategy_source_positions",
        "search_execution_kernel_state"
      ]
    );

    stage = "create ready campaign and first run";
    const setupStore = await createMysqlStore();
    const owner = setupStore.users.find(
      (item) => item.id === "u_sales_shirley"
    );
    assert.ok(owner);
    const createdCampaign = await createProspectCampaign({
      store: setupStore,
      user: publicUser(owner),
      body: {
        name: "MySQL 搜索执行内核项目",
        snapshot: fullSnapshot
      },
      requestId: "execution-mysql-campaign-create"
    });
    const strategy = setupStore.prospectStrategies.find(
      (item) => item.campaignId === createdCampaign.campaign.id
    );
    assert.ok(strategy);
    const updatedStrategy = await updateProspectStrategy({
      store: setupStore,
      user: publicUser(owner),
      strategyId: strategy.id,
      ifMatch: prospectStrategyEtag(strategy),
      body: {
        providerPlan: [{
          providerId: "gleif",
          priority: 20,
          pageLimit: 3,
          resultLimit: 20,
          budgetLimit: null,
          currency: ""
        }],
        reason: "冻结 MySQL 执行测试数据源计划"
      },
      requestId: "execution-mysql-strategy-update"
    });
    const approvedStrategy = await approveProspectStrategy({
      store: setupStore,
      user: publicUser(owner),
      strategyId: strategy.id,
      ifMatch: prospectStrategyEtag(updatedStrategy.strategy),
      reason: "MySQL 搜索执行测试审批",
      requestId: "execution-mysql-strategy-approve"
    });
    await activateProspectCampaign({
      store: setupStore,
      user: publicUser(owner),
      campaignId: createdCampaign.campaign.id,
      ifMatch: prospectCampaignEtag(createdCampaign.campaign),
      requestId: "execution-mysql-campaign-activate"
    });
    const firstRunResult = await createProspectRun({
      store: setupStore,
      user: publicUser(owner),
      strategyId: strategy.id,
      ifMatch: prospectStrategyEtag(approvedStrategy.strategy),
      idempotencyKey: `execution-mysql-first-${randomUUID()}`,
      body: { reason: "验证执行事实持久化" },
      requestId: "execution-mysql-first-run"
    });
    const firstRunId = firstRunResult.run.id;

    stage = "persist encrypted cursor and pause";
    const claimSecret = "mysql-execution-claim-secret-at-least-32-characters";
    const cursorSecret =
      "mysql-execution-cursor-secret-at-least-32-characters";
    const firstKernel = new ProspectExecutionKernel({
      store: setupStore,
      workerId: "mysql-worker-1",
      allowedRunIds: [firstRunId],
      claimSecret,
      cursorSecret
    });
    stage = "start first execution kernel";
    const firstKernelState = await firstKernel.start(tick());
    assert.equal(firstKernelState.kernelEpoch, 1);
    stage = "claim first execution lease";
    const firstClaim = await firstKernel.claimNext(tick());
    assert.ok(firstClaim);
    stage = "begin first provider request";
    const firstStarted = await firstKernel.beginRequest({
      leaseId: firstClaim.lease.id,
      claimToken: firstClaim.claimToken,
      now: tick()
    });
    assert.equal(firstStarted.ready, true);
    if (!firstStarted.ready) throw new Error("first request was deferred");
    stage = "request pause during first provider request";
    await firstKernel.requestPause(firstRunId, tick());
    const firstProvider = new DeterministicFakeProspectProvider({
      gleif: [{
        kind: "success",
        acceptedCount: 2,
        rawCount: 3,
        invalidCount: 1,
        duplicateCount: 0,
        hasMore: true,
        cursor: "mysql-private-cursor",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 3 },
        cost: { kind: "estimated", amount: 0.01, currency: "USD" }
      }]
    });
    const firstResponse = await firstProvider.search(firstStarted.request);
    if (firstResponse.step.kind !== "success") {
      throw new Error("first page must succeed");
    }
    stage = "settle first provider page while pausing";
    const firstSettlement = await firstKernel.completePage({
      leaseId: firstClaim.lease.id,
      claimToken: firstClaim.claimToken,
      result: firstResponse.step,
      responseHash: firstResponse.responseHash,
      now: tick()
    });
    assert.equal(firstSettlement.accepted, true);
    assert.equal(firstSettlement.runStatus, "paused");

    stage = "cold reload encrypted execution facts";
    const pausedStore = await createMysqlStore();
    const pausedRun = pausedStore.prospectSearchRuns.find(
      (item) => item.id === firstRunId
    );
    assert.ok(pausedRun);
    assert.equal(pausedRun.status, "paused");
    const pausedCheckpoint = pausedStore.prospectExecutionCheckpoints.find(
      (item) => item.runId === firstRunId
    );
    assert.ok(pausedCheckpoint);
    assert.equal(pausedCheckpoint.checkpointNo, 2);
    assert.equal(pausedCheckpoint.pageSequence, 1);
    assert.equal(pausedCheckpoint.acceptedCount, 2);
    assert.match(pausedCheckpoint.encryptedCursor, /^v1\./);
    assert.match(pausedCheckpoint.cursorHash, /^[a-f0-9]{64}$/);
    assert.equal(
      pausedCheckpoint.encryptedCursor.includes("mysql-private-cursor"),
      false
    );
    const pausedSourcePosition =
      pausedStore.prospectStrategySourcePositions.find((item) =>
        item.sourceRunId === firstRunId
      );
    assert.ok(pausedSourcePosition);
    assert.equal(pausedSourcePosition.status, "continuable");
    assert.equal(pausedSourcePosition.version, 1);
    assert.match(pausedSourcePosition.encryptedCursor, /^v1\./);
    assert.match(pausedSourcePosition.cursorHash, /^[a-f0-9]{64}$/);
    assert.equal(
      pausedSourcePosition.encryptedCursor.includes(
        "mysql-private-cursor"
      ),
      false
    );
    const [cursorRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT encrypted_cursor, cursor_hash, 'checkpoint' AS cursor_type
       FROM \`${databaseName}\`.prospect_execution_checkpoints
       WHERE run_id = ?
       UNION ALL
       SELECT encrypted_cursor, cursor_hash, 'source_position' AS cursor_type
       FROM \`${databaseName}\`.prospect_strategy_source_positions
       WHERE source_run_id = ?`,
      [firstRunId, firstRunId]
    );
    assert.equal(cursorRows.length, 2);
    assert.equal(
      cursorRows.every((row) =>
        /^v1\./.test(String(row.encrypted_cursor))
        && /^[a-f0-9]{64}$/.test(String(row.cursor_hash))
      ),
      true
    );
    assert.equal(
      JSON.stringify(cursorRows).includes("mysql-private-cursor"),
      false
    );

    stage = "resume with epoch advancement and finish";
    const resumedKernel = new ProspectExecutionKernel({
      store: pausedStore,
      workerId: "mysql-worker-2",
      allowedRunIds: [firstRunId],
      claimSecret,
      cursorSecret
    });
    const resumedKernelState = await resumedKernel.start(tick());
    assert.equal(resumedKernelState.kernelEpoch, 2);
    const previousRunEpoch = pausedRun.executionEpoch;
    await resumedKernel.resume(firstRunId, tick());
    assert.equal(pausedRun.executionEpoch, previousRunEpoch + 1);
    assert.equal(pausedCheckpoint.runEpoch, pausedRun.executionEpoch);
    const resumedProvider = new DeterministicFakeProspectProvider({
      gleif: [{
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
      }]
    });
    const resumedResult = await resumedKernel.executeNext(
      resumedProvider,
      tick()
    );
    assert.equal(resumedResult.kind, "success");
    assert.equal(pausedRun.status, "succeeded");

    stage = "verify costs usage hashes pages events and leases after reload";
    const finishedStore = await createMysqlStore();
    const finishedCheckpoint =
      finishedStore.prospectExecutionCheckpoints.find(
        (item) => item.runId === firstRunId
      );
    assert.ok(finishedCheckpoint);
    assert.equal(finishedCheckpoint.acceptedCount, 3);
    assert.equal(finishedCheckpoint.rawCount, 4);
    assert.equal(finishedCheckpoint.invalidCount, 1);
    assert.equal(finishedCheckpoint.pageSequence, 2);
    assert.equal(finishedCheckpoint.totalCallCount, 2);
    assert.equal(finishedCheckpoint.completionReason, "PROVIDER_EXHAUSTED");
    assert.equal(finishedCheckpoint.encryptedCursor, "");
    const finishedSourcePosition =
      finishedStore.prospectStrategySourcePositions.find((item) =>
        item.id === pausedSourcePosition.id
      );
    assert.ok(finishedSourcePosition);
    assert.equal(finishedSourcePosition.status, "exhausted");
    assert.equal(finishedSourcePosition.version, 2);
    assert.equal(finishedSourcePosition.encryptedCursor, "");
    assert.equal(finishedSourcePosition.cursorHash, "");
    const finishedAttempts = finishedStore.prospectExecutionAttempts
      .filter((item) => item.runId === firstRunId)
      .sort((left, right) =>
        left.providerAttemptNo - right.providerAttemptNo
      );
    assert.equal(finishedAttempts.length, 2);
    assert.deepEqual(
      finishedAttempts.map((item) => item.status),
      ["succeeded", "succeeded"]
    );
    assert.deepEqual(
      finishedAttempts.map((item) => item.costAmount),
      [0.01, 0.02]
    );
    assert.deepEqual(
      finishedAttempts.map((item) => JSON.parse(item.usageJson)),
      [
        { requestUnits: 1, resultUnits: 3 },
        { requestUnits: 1, resultUnits: 1 }
      ]
    );
    assert.equal(
      finishedAttempts.every((item) =>
        /^[a-f0-9]{64}$/.test(item.requestHash)
        && /^[a-f0-9]{64}$/.test(item.responseHash)
      ),
      true
    );
    assert.equal(
      finishedStore.prospectExecutionPages.filter(
        (item) => item.runId === firstRunId
      ).length,
      2
    );
    assert.equal(
      finishedStore.prospectExecutionLeases.filter(
        (item) => item.runId === firstRunId
      ).every((item) =>
        item.status === "released"
        && Boolean(item.releasedAt)
        && Boolean(item.releaseReason)
      ),
      true
    );
    const firstRunEventTypes = finishedStore.prospectExecutionEvents
      .filter((item) => item.runId === firstRunId)
      .map((item) => item.eventType);
    assert.equal(
      firstRunEventTypes.filter((item) => item === "page_accepted").length,
      2
    );
    assert.equal(firstRunEventTypes.includes("pause_settled"), true);
    assert.equal(firstRunEventTypes.includes("run_completed"), true);
    const [secretScanRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT
         (SELECT GROUP_CONCAT(encrypted_cursor SEPARATOR '')
          FROM \`${databaseName}\`.prospect_execution_checkpoints
          WHERE run_id = ?) AS cursors,
         (SELECT GROUP_CONCAT(encrypted_cursor SEPARATOR '')
          FROM \`${databaseName}\`.prospect_strategy_source_positions
          WHERE source_run_id = ?) AS sourcePositionCursors,
         (SELECT GROUP_CONCAT(COALESCE(usage_json, '') SEPARATOR '')
          FROM \`${databaseName}\`.prospect_execution_attempts
          WHERE run_id = ?) AS usageFacts,
         (SELECT GROUP_CONCAT(detail_hash SEPARATOR '')
          FROM \`${databaseName}\`.prospect_execution_events
          WHERE run_id = ?) AS eventFacts`,
      [firstRunId, firstRunId, firstRunId, firstRunId]
    );
    assert.equal(
      JSON.stringify(secretScanRows).includes("mysql-private-cursor"),
      false
    );

    stage = "cold-start lease recovery and fence advancement";
    const finishedOwner = finishedStore.users.find(
      (item) => item.id === owner.id
    );
    const finishedStrategy = finishedStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    );
    assert.ok(finishedOwner);
    assert.ok(finishedStrategy);
    const resetSourcePositionMemoryForScenario = async (
      store: CrmStore
    ) => {
      await admin.query(
        `DELETE FROM \`${databaseName}\`.prospect_strategy_source_positions`
      );
      store.prospectStrategySourcePositions.splice(
        0,
        store.prospectStrategySourcePositions.length
      );
    };

    stage = "pause claimed work before provider request";
    await resetSourcePositionMemoryForScenario(finishedStore);
    const pauseBeforeRequestRunResult = await createProspectRun({
      store: finishedStore,
      user: publicUser(finishedOwner),
      strategyId: finishedStrategy.id,
      ifMatch: prospectStrategyEtag(finishedStrategy),
      idempotencyKey: `execution-mysql-pause-before-${randomUUID()}`,
      body: { reason: "验证请求前暂停不会调用 Provider" },
      requestId: "execution-mysql-pause-before-run"
    });
    const pauseBeforeRequestRunId = pauseBeforeRequestRunResult.run.id;
    const pauseBeforeRequestKernel = new ProspectExecutionKernel({
      store: finishedStore,
      workerId: "mysql-pause-before-worker",
      allowedRunIds: [pauseBeforeRequestRunId],
      claimSecret,
      cursorSecret
    });
    await pauseBeforeRequestKernel.start(tick());
    const pauseBeforeRequestClaim =
      await pauseBeforeRequestKernel.claimNext(tick());
    assert.ok(pauseBeforeRequestClaim);
    const pausedBeforeRequest = await pauseBeforeRequestKernel.requestPause(
      pauseBeforeRequestRunId,
      tick()
    );
    assert.equal(pausedBeforeRequest.status, "paused");

    const pauseBeforeRequestStore = await createMysqlStore();
    const persistedPauseRun =
      pauseBeforeRequestStore.prospectSearchRuns.find(
        (item) => item.id === pauseBeforeRequestRunId
      );
    const persistedPauseCheckpoint =
      pauseBeforeRequestStore.prospectExecutionCheckpoints.find(
        (item) => item.runId === pauseBeforeRequestRunId
      );
    const persistedPauseLease =
      pauseBeforeRequestStore.prospectExecutionLeases.find(
        (item) => item.id === pauseBeforeRequestClaim.lease.id
      );
    const persistedPauseAttempt =
      pauseBeforeRequestStore.prospectExecutionAttempts.find(
        (item) => item.leaseId === pauseBeforeRequestClaim.lease.id
      );
    const persistedPauseShard =
      pauseBeforeRequestStore.prospectRunShards.find(
        (item) => item.runId === pauseBeforeRequestRunId
      );
    assert.equal(persistedPauseRun?.status, "paused");
    assert.equal(persistedPauseShard?.status, "paused");
    assert.equal(persistedPauseCheckpoint?.totalCallCount, 0);
    assert.equal(persistedPauseCheckpoint?.checkpointCallCount, 0);
    assert.equal(persistedPauseLease?.status, "released");
    assert.equal(
      persistedPauseLease?.releaseReason,
      "PAUSED_BEFORE_REQUEST"
    );
    assert.equal(persistedPauseAttempt?.status, "failed");
    assert.equal(
      persistedPauseAttempt?.errorCode,
      "PAUSED_BEFORE_REQUEST"
    );
    const pauseCleanupKernel = new ProspectExecutionKernel({
      store: pauseBeforeRequestStore,
      workerId: "mysql-pause-cleanup-worker",
      allowedRunIds: [pauseBeforeRequestRunId],
      claimSecret,
      cursorSecret
    });
    await pauseCleanupKernel.start(tick());
    assert.equal(
      (
        await pauseCleanupKernel.requestCancel(
          pauseBeforeRequestRunId,
          tick()
        )
      ).status,
      "cancelled"
    );

    stage = "cancel checkpoint before next provider request";
    await resetSourcePositionMemoryForScenario(pauseBeforeRequestStore);
    const cancelBeforeRequestRunResult = await createProspectRun({
      store: pauseBeforeRequestStore,
      user: publicUser(
        pauseBeforeRequestStore.users.find(
          (item) => item.id === owner.id
        )!
      ),
      strategyId: finishedStrategy.id,
      ifMatch: prospectStrategyEtag(
        pauseBeforeRequestStore.prospectStrategies.find(
          (item) => item.id === finishedStrategy.id
        )!
      ),
      idempotencyKey: `execution-mysql-cancel-before-${randomUUID()}`,
      body: { reason: "验证取消清理游标与重试检查点" },
      requestId: "execution-mysql-cancel-before-run"
    });
    const cancelBeforeRequestRunId =
      cancelBeforeRequestRunResult.run.id;
    const cancelBeforeRequestKernel = new ProspectExecutionKernel({
      store: pauseBeforeRequestStore,
      workerId: "mysql-cancel-before-worker",
      allowedRunIds: [cancelBeforeRequestRunId],
      claimSecret,
      cursorSecret
    });
    await cancelBeforeRequestKernel.start(tick());
    const checkpointProvider = new DeterministicFakeProspectProvider({
      gleif: [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: true,
        cursor: "mysql-cancel-private-cursor",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "estimated", amount: 0, currency: "USD" }
      }]
    });
    assert.equal(
      (
        await cancelBeforeRequestKernel.executeNext(
          checkpointProvider,
          tick()
        )
      ).kind,
      "success"
    );
    const cancelClaim = await cancelBeforeRequestKernel.claimNext(tick());
    assert.ok(cancelClaim);
    const cancelledBeforeRequest =
      await cancelBeforeRequestKernel.requestCancel(
        cancelBeforeRequestRunId,
        tick()
      );
    assert.equal(cancelledBeforeRequest.status, "cancelled");

    const cancelledBeforeRequestStore = await createMysqlStore();
    const persistedCancelledRun =
      cancelledBeforeRequestStore.prospectSearchRuns.find(
        (item) => item.id === cancelBeforeRequestRunId
      );
    const persistedCancelledCheckpoint =
      cancelledBeforeRequestStore.prospectExecutionCheckpoints.find(
        (item) => item.runId === cancelBeforeRequestRunId
      );
    const persistedCancelledLease =
      cancelledBeforeRequestStore.prospectExecutionLeases.find(
        (item) => item.id === cancelClaim.lease.id
      );
    const persistedCancelledAttempt =
      cancelledBeforeRequestStore.prospectExecutionAttempts.find(
        (item) => item.leaseId === cancelClaim.lease.id
      );
    assert.equal(persistedCancelledRun?.status, "cancelled");
    assert.equal(persistedCancelledCheckpoint?.encryptedCursor, "");
    assert.equal(persistedCancelledCheckpoint?.cursorHash, "");
    assert.equal(persistedCancelledCheckpoint?.retryAfterAt, "");
    assert.equal(
      persistedCancelledCheckpoint?.completionReason,
      "CANCELLED_BY_USER"
    );
    assert.equal(
      persistedCancelledCheckpoint?.lastErrorCode,
      "CANCELLED_BY_USER"
    );
    assert.equal(persistedCancelledLease?.status, "released");
    assert.equal(
      persistedCancelledLease?.releaseReason,
      "CANCELLED_BEFORE_REQUEST"
    );
    assert.equal(persistedCancelledAttempt?.status, "failed");
    assert.equal(
      persistedCancelledAttempt?.errorCode,
      "CANCELLED_BEFORE_REQUEST"
    );
    assert.equal(
      JSON.stringify({
        checkpoint: persistedCancelledCheckpoint,
        attempts:
          cancelledBeforeRequestStore.prospectExecutionAttempts.filter(
            (item) => item.runId === cancelBeforeRequestRunId
          )
      }).includes("mysql-cancel-private-cursor"),
      false
    );

    stage = "rollback wrong cursor key before MySQL persistence";
    const cursorRollbackOwner =
      cancelledBeforeRequestStore.users.find(
        (item) => item.id === owner.id
      );
    const cursorRollbackStrategy =
      cancelledBeforeRequestStore.prospectStrategies.find(
        (item) => item.id === finishedStrategy.id
      );
    assert.ok(cursorRollbackOwner);
    assert.ok(cursorRollbackStrategy);
    await resetSourcePositionMemoryForScenario(cancelledBeforeRequestStore);
    const cursorRollbackRunResult = await createProspectRun({
      store: cancelledBeforeRequestStore,
      user: publicUser(cursorRollbackOwner),
      strategyId: cursorRollbackStrategy.id,
      ifMatch: prospectStrategyEtag(cursorRollbackStrategy),
      idempotencyKey: `execution-mysql-cursor-rollback-${randomUUID()}`,
      body: { reason: "验证游标解密失败的内存与数据库原子回滚" },
      requestId: "execution-mysql-cursor-rollback-run"
    });
    const cursorRollbackRunId = cursorRollbackRunResult.run.id;
    const cursorRollbackWriter = new ProspectExecutionKernel({
      store: cancelledBeforeRequestStore,
      workerId: "mysql-cursor-rollback-writer",
      allowedRunIds: [cursorRollbackRunId],
      claimSecret,
      cursorSecret
    });
    await cursorRollbackWriter.start(tick());
    const cursorRollbackProvider =
      new DeterministicFakeProspectProvider({
        gleif: [{
          kind: "success",
          acceptedCount: 1,
          rawCount: 1,
          invalidCount: 0,
          duplicateCount: 0,
          hasMore: true,
          cursor: "mysql-rollback-private-cursor",
          partial: false,
          usage: { requestUnits: 1, resultUnits: 1 },
          cost: { kind: "estimated", amount: 0, currency: "USD" }
        }]
      });
    assert.equal(
      (
        await cursorRollbackWriter.executeNext(
          cursorRollbackProvider,
          tick()
        )
      ).kind,
      "success"
    );
    const cursorRollbackReader = new ProspectExecutionKernel({
      store: cancelledBeforeRequestStore,
      workerId: "mysql-cursor-rollback-reader",
      allowedRunIds: [cursorRollbackRunId],
      claimSecret,
      cursorSecret: `${cursorSecret}-wrong`
    });
    await cursorRollbackReader.start(tick());
    const cursorRollbackClaim =
      await cursorRollbackReader.claimNext(tick());
    assert.ok(cursorRollbackClaim);
    const beforeCursorRollback =
      executionStateSnapshot(cancelledBeforeRequestStore);
    await assert.rejects(
      cursorRollbackReader.beginRequest({
        leaseId: cursorRollbackClaim.lease.id,
        claimToken: cursorRollbackClaim.claimToken,
        now: tick()
      }),
      /执行游标完整性校验失败/
    );
    assert.deepEqual(
      executionStateSnapshot(cancelledBeforeRequestStore),
      beforeCursorRollback
    );
    const cursorRollbackColdStore = await createMysqlStore();
    const cursorRollbackCheckpoint =
      cursorRollbackColdStore.prospectExecutionCheckpoints.find(
        (item) => item.runId === cursorRollbackRunId
      );
    const cursorRollbackAttempt =
      cursorRollbackColdStore.prospectExecutionAttempts.find(
        (item) => item.leaseId === cursorRollbackClaim.lease.id
      );
    const cursorRollbackLease =
      cursorRollbackColdStore.prospectExecutionLeases.find(
        (item) => item.id === cursorRollbackClaim.lease.id
      );
    assert.equal(cursorRollbackCheckpoint?.totalCallCount, 1);
    assert.equal(cursorRollbackCheckpoint?.checkpointCallCount, 0);
    assert.equal(cursorRollbackAttempt?.status, "claimed");
    assert.equal(cursorRollbackAttempt?.requestHash, "");
    assert.equal(cursorRollbackLease?.status, "active");
    assert.equal(cursorRollbackLease?.requestStartedAt, "");
    await cursorRollbackReader.requestCancel(
      cursorRollbackRunId,
      tick()
    );

    stage = "serialize concurrent claims in one MySQL kernel";
    const concurrentClaimOwner =
      cancelledBeforeRequestStore.users.find(
        (item) => item.id === owner.id
      );
    const concurrentClaimStrategy =
      cancelledBeforeRequestStore.prospectStrategies.find(
        (item) => item.id === finishedStrategy.id
      );
    assert.ok(concurrentClaimOwner);
    assert.ok(concurrentClaimStrategy);
    await resetSourcePositionMemoryForScenario(cursorRollbackColdStore);
    const concurrentClaimRunResult = await createProspectRun({
      store: cancelledBeforeRequestStore,
      user: publicUser(concurrentClaimOwner),
      strategyId: concurrentClaimStrategy.id,
      ifMatch: prospectStrategyEtag(concurrentClaimStrategy),
      idempotencyKey: `execution-mysql-concurrent-claim-${randomUUID()}`,
      body: { reason: "验证单实例内并发领取仅生成一个活动租约" },
      requestId: "execution-mysql-concurrent-claim-run"
    });
    const concurrentClaimRunId = concurrentClaimRunResult.run.id;
    const concurrentClaimKernel = new ProspectExecutionKernel({
      store: cancelledBeforeRequestStore,
      workerId: "mysql-concurrent-claim-worker",
      allowedRunIds: [concurrentClaimRunId],
      claimSecret,
      cursorSecret
    });
    await concurrentClaimKernel.start(tick());
    const concurrentClaimTimes = [tick(), tick()];
    const concurrentClaims = await Promise.all(
      concurrentClaimTimes.map((claimAt) =>
        concurrentClaimKernel.claimNext(claimAt)
      )
    );
    const acceptedConcurrentClaims =
      concurrentClaims.filter((item) => item !== null);
    assert.equal(acceptedConcurrentClaims.length, 1);
    assert.equal(
      concurrentClaims.filter((item) => item === null).length,
      1
    );
    const acceptedConcurrentClaim = acceptedConcurrentClaims[0]!;
    const concurrentClaimColdStore = await createMysqlStore();
    assert.equal(
      concurrentClaimColdStore.prospectExecutionLeases.filter(
        (item) =>
          item.runId === concurrentClaimRunId
          && item.status === "active"
      ).length,
      1
    );
    assert.equal(
      concurrentClaimColdStore.prospectExecutionAttempts.filter(
        (item) => item.runId === concurrentClaimRunId
      ).length,
      1
    );
    assert.equal(
      concurrentClaimColdStore.prospectExecutionLeases.find(
        (item) => item.runId === concurrentClaimRunId
      )?.id,
      acceptedConcurrentClaim.lease.id
    );
    await concurrentClaimKernel.requestCancel(
      concurrentClaimRunId,
      tick()
    );

    await resetSourcePositionMemoryForScenario(concurrentClaimColdStore);
    const recoveryRunResult = await createProspectRun({
      store: cancelledBeforeRequestStore,
      user: publicUser(
        cancelledBeforeRequestStore.users.find(
          (item) => item.id === owner.id
        )!
      ),
      strategyId: finishedStrategy.id,
      ifMatch: prospectStrategyEtag(
        cancelledBeforeRequestStore.prospectStrategies.find(
          (item) => item.id === finishedStrategy.id
        )!
      ),
      idempotencyKey: `execution-mysql-recovery-${randomUUID()}`,
      body: { reason: "验证冷启动租约回收" },
      requestId: "execution-mysql-recovery-run"
    });
    const recoveryRunId = recoveryRunResult.run.id;
    const recoveryClaimKernel = new ProspectExecutionKernel({
      store: cancelledBeforeRequestStore,
      workerId: "mysql-recovery-worker-1",
      allowedRunIds: [recoveryRunId],
      claimSecret,
      cursorSecret
    });
    await recoveryClaimKernel.start(tick());
    const abandonedClaim = await recoveryClaimKernel.claimNext(tick());
    assert.ok(abandonedClaim);

    const abandonedStore = await createMysqlStore();
    assert.equal(
      abandonedStore.prospectExecutionLeases.find(
        (item) => item.id === abandonedClaim.lease.id
      )?.status,
      "active"
    );
    const recoveryKernel = new ProspectExecutionKernel({
      store: abandonedStore,
      workerId: "mysql-recovery-worker-2",
      allowedRunIds: [recoveryRunId],
      claimSecret,
      cursorSecret
    });
    await recoveryKernel.start(tick());
    const recoveredLease = abandonedStore.prospectExecutionLeases.find(
      (item) => item.id === abandonedClaim.lease.id
    );
    const recoveredAttempt = abandonedStore.prospectExecutionAttempts.find(
      (item) => item.leaseId === abandonedClaim.lease.id
    );
    assert.equal(recoveredLease?.status, "expired");
    assert.equal(
      recoveredLease?.releaseReason,
      "LEASE_RECOVERED_BEFORE_REQUEST"
    );
    assert.equal(recoveredAttempt?.status, "failed");
    assert.equal(recoveredAttempt?.retryable, true);
    const reclaimed = await recoveryKernel.claimNext(tick());
    assert.ok(reclaimed);
    assert.equal(reclaimed.job.id, abandonedClaim.job.id);
    assert.equal(reclaimed.lease.fenceToken, 2);
    const recoveryProvider = new DeterministicFakeProspectProvider({
      gleif: [{
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
    const recoveredStarted = await recoveryKernel.beginRequest({
      leaseId: reclaimed.lease.id,
      claimToken: reclaimed.claimToken,
      now: tick()
    });
    assert.equal(recoveredStarted.ready, true);
    if (!recoveredStarted.ready) {
      throw new Error("recovered request was deferred");
    }
    const recoveryResponse = await recoveryProvider.search(
      recoveredStarted.request
    );
    if (recoveryResponse.step.kind !== "success") {
      throw new Error("recovery page must succeed");
    }
    await recoveryKernel.completePage({
      leaseId: reclaimed.lease.id,
      claimToken: reclaimed.claimToken,
      result: recoveryResponse.step,
      responseHash: recoveryResponse.responseHash,
      now: tick()
    });
    assert.equal(
      abandonedStore.prospectSearchRuns.find(
        (item) => item.id === recoveryRunId
      )?.status,
      "succeeded"
    );

    stage = "stale kernel and checkpoint CAS";
    const staleKernelStore = await createMysqlStore();
    const freshKernelStore = await createMysqlStore();
    const freshKernel = new ProspectExecutionKernel({
      store: freshKernelStore,
      workerId: "mysql-cas-worker",
      allowedRunIds: [firstRunId],
      claimSecret,
      cursorSecret
    });
    await freshKernel.start(tick());
    await assert.rejects(
      staleKernelStore.persist(),
      /搜索执行内核 epoch CAS 冲突/
    );
    const staleCheckpointStore = await createMysqlStore();
    const staleCheckpoint =
      staleCheckpointStore.prospectExecutionCheckpoints.find(
        (item) => item.runId === firstRunId
      );
    assert.ok(staleCheckpoint);
    await admin.query(
      `UPDATE \`${databaseName}\`.prospect_execution_checkpoints
       SET version_no = version_no + 1 WHERE id = ?`,
      [staleCheckpoint.id]
    );
    await assert.rejects(
      staleCheckpointStore.persist(),
      /搜索执行 checkpoint CAS 冲突或作用域被修改/
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.prospect_execution_checkpoints
       SET version_no = ? WHERE id = ?`,
      [staleCheckpoint.version, staleCheckpoint.id]
    );

    stage = "create active guard run";
    const guardStore = await createMysqlStore();
    const guardOwner = guardStore.users.find(
      (item) => item.id === owner.id
    );
    const guardStrategy = guardStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    );
    assert.ok(guardOwner);
    assert.ok(guardStrategy);
    await resetSourcePositionMemoryForScenario(guardStore);
    const guardRunResult = await createProspectRun({
      store: guardStore,
      user: publicUser(guardOwner),
      strategyId: guardStrategy.id,
      ifMatch: prospectStrategyEtag(guardStrategy),
      idempotencyKey: `execution-mysql-guard-${randomUUID()}`,
      body: { reason: "验证执行事实不可变与隔离约束" },
      requestId: "execution-mysql-guard-run"
    });
    const guardRunId = guardRunResult.run.id;
    const guardKernel = new ProspectExecutionKernel({
      store: guardStore,
      workerId: "mysql-guard-worker",
      allowedRunIds: [guardRunId],
      claimSecret,
      cursorSecret
    });
    await guardKernel.start(tick());
    const guardFirstProvider = new DeterministicFakeProspectProvider({
      gleif: [{
        kind: "success",
        acceptedCount: 1,
        rawCount: 1,
        invalidCount: 0,
        duplicateCount: 0,
        hasMore: true,
        cursor: "guard-private-cursor",
        partial: false,
        usage: { requestUnits: 1, resultUnits: 1 },
        cost: { kind: "estimated", amount: 0.01, currency: "USD" }
      }]
    });
    assert.equal(
      (await guardKernel.executeNext(guardFirstProvider, tick())).kind,
      "success"
    );
    await guardKernel.requestPause(guardRunId, tick());
    await guardKernel.resume(guardRunId, tick());
    const guardClaim = await guardKernel.claimNext(tick());
    assert.ok(guardClaim);
    const activeGuardLease = guardStore.prospectExecutionLeases.find(
      (item) => item.id === guardClaim.lease.id
    );
    assert.ok(activeGuardLease);
    assert.equal(activeGuardLease.runEpoch, 2);

    stage = "reject checkpoint rollback and completed mutation";
    await expectRejectedMutation(
      guardStore,
      () => {
        const checkpoint = guardStore.prospectExecutionCheckpoints.find(
          (item) => item.runId === guardRunId
        )!;
        const page = guardStore.prospectExecutionPages.find(
          (item) => item.runId === guardRunId
        )!;
        checkpoint.acceptedCount = 0;
        checkpoint.rawCount = 0;
        checkpoint.version += 1;
        checkpoint.updatedAt = tick();
        page.acceptedCount = 0;
        page.rawCount = 0;
      },
      /搜索执行 checkpoint 发生回退或终态被修改/
    );
    await expectRejectedMutation(
      guardStore,
      () => {
        const checkpoint = guardStore.prospectExecutionCheckpoints.find(
          (item) => item.runId === firstRunId
        )!;
        checkpoint.lastErrorMessage = "试图修改已完成 checkpoint";
        checkpoint.version += 1;
        checkpoint.updatedAt = tick();
      },
      /搜索执行 checkpoint 发生回退或终态被修改/
    );

    stage = "reject terminal lease and settled attempt mutation";
    await expectRejectedMutation(
      guardStore,
      () => {
        const lease = guardStore.prospectExecutionLeases.find(
          (item) => item.runId === firstRunId
        )!;
        lease.releaseReason = "TAMPERED_RELEASE_REASON";
        lease.version += 1;
      },
      /搜索执行租约终态不允许修改/
    );
    await expectRejectedMutation(
      guardStore,
      () => {
        const attempt = guardStore.prospectExecutionAttempts.find(
          (item) =>
            item.runId === firstRunId && item.status === "succeeded"
        )!;
        const page = guardStore.prospectExecutionPages.find(
          (item) => item.attemptId === attempt.id
        )!;
        const replacementHash = "e".repeat(64);
        attempt.responseHash = replacementHash;
        attempt.usageJson = JSON.stringify({
          requestUnits: 99,
          resultUnits: 99
        });
        attempt.costAmount = 999;
        attempt.version += 1;
        page.payloadHash = replacementHash;
      },
      /搜索执行尝试状态迁移无效或终态被修改/
    );

    stage = "reject throttle rollback duplicate lease and stale epoch";
    await expectRejectedMutation(
      guardStore,
      () => {
        const throttle =
          guardStore.prospectExecutionThrottleBuckets[0]!;
        throttle.availableAt = new Date(
          Date.parse(throttle.availableAt) - 1_000
        ).toISOString();
        throttle.updatedAt = tick();
        throttle.version += 1;
      },
      /搜索执行限流桶 CAS 冲突或作用域被修改/
    );
    await expectRejectedMutation(
      guardStore,
      () => {
        const lease = guardStore.prospectExecutionLeases.find(
          (item) => item.id === guardClaim.lease.id
        )!;
        const attempt = guardStore.prospectExecutionAttempts.find(
          (item) => item.leaseId === lease.id
        )!;
        const duplicateLease = structuredClone(lease);
        duplicateLease.id = `pexls_${randomUUID()}`;
        duplicateLease.fenceToken += 1;
        duplicateLease.claimTokenHmac = "f".repeat(64);
        duplicateLease.version = 1;
        const duplicateAttempt = structuredClone(attempt);
        duplicateAttempt.id = `pexat_${randomUUID()}`;
        duplicateAttempt.leaseId = duplicateLease.id;
        duplicateAttempt.version = 1;
        guardStore.prospectExecutionLeases.push(duplicateLease);
        guardStore.prospectExecutionAttempts.push(duplicateAttempt);
      },
      /同一搜索运行或任务存在冲突的活动租约/
    );
    await expectRejectedMutation(
      guardStore,
      () => {
        const lease = guardStore.prospectExecutionLeases.find(
          (item) => item.id === guardClaim.lease.id
        )!;
        lease.runEpoch -= 1;
        lease.version += 1;
      },
      /同一搜索运行或任务存在冲突的活动租约/
    );

    stage = "reject team owner queue bridge and history tampering";
    await expectRejectedMutation(
      guardStore,
      () => {
        const checkpoint = guardStore.prospectExecutionCheckpoints.find(
          (item) => item.runId === guardRunId
        )!;
        checkpoint.teamId = "cross-team";
      },
      /搜索执行 checkpoint 引用、计数或作用域无效/
    );
    await expectRejectedMutation(
      guardStore,
      () => {
        const checkpoint = guardStore.prospectExecutionCheckpoints.find(
          (item) => item.runId === guardRunId
        )!;
        const otherOwner = guardStore.users.find(
          (item) => item.id !== checkpoint.ownerId
        );
        assert.ok(otherOwner);
        checkpoint.ownerId = otherOwner.id;
      },
      /搜索执行 checkpoint 引用、计数或作用域无效/
    );
    await expectRejectedMutation(
      guardStore,
      () => {
        const parent =
          guardStore.prospectRunQueueParentBindings.find(
            (item) => item.runId === guardRunId
          )!;
        parent.bindingHash = "0".repeat(64);
      },
      /父桥接绑定完整性校验失败/
    );
    await expectRejectedMutation(
      guardStore,
      () => {
        const index = guardStore.prospectRunQueueChildBindings.findIndex(
          (item) => item.runId === guardRunId
        );
        guardStore.prospectRunQueueChildBindings.splice(index, 1);
      },
      /搜索执行 checkpoint 引用、计数或作用域无效/
    );
    await expectRejectedMutation(
      guardStore,
      () => {
        const event = guardStore.prospectExecutionEvents.find(
          (item) => item.runId === firstRunId
        )!;
        event.detailHash = "0".repeat(64);
      },
      /搜索执行事件不可变历史被删除或修改/
    );
    await expectRejectedMutation(
      guardStore,
      () => {
        const index = guardStore.prospectExecutionEvents.findIndex(
          (item) => item.runId === firstRunId
        );
        guardStore.prospectExecutionEvents.splice(index, 1);
      },
      /搜索执行事件不可变历史被删除或修改/
    );

    stage = "verify SQL team and owner tamper transaction rollback";
    const transactionConnection = await mysql.createConnection({
      ...connectionOptions(testUrl),
      database: databaseName
    });
    try {
      const [kernelRows] =
        await transactionConnection.query<Array<RowDataPacket>>(
          `SELECT instance_id AS instanceId
           FROM search_execution_kernel_state
           WHERE id = 'search_execution_kernel_v1'`
        );
      const originalInstanceId = String(kernelRows[0]?.instanceId || "");
      const guardCheckpoint =
        guardStore.prospectExecutionCheckpoints.find(
          (item) => item.runId === guardRunId
        )!;
      const otherOwner = guardStore.users.find(
        (item) => item.id !== guardCheckpoint.ownerId
      );
      assert.ok(otherOwner);
      for (const [column, value] of [
        ["team_id", "cross-team"],
        ["owner_id", otherOwner.id]
      ] as const) {
        await transactionConnection.beginTransaction();
        try {
          await transactionConnection.query(
            `UPDATE search_execution_kernel_state
             SET instance_id = 'must-rollback'
             WHERE id = 'search_execution_kernel_v1'`
          );
          await assert.rejects(
            transactionConnection.query(
              `UPDATE prospect_execution_checkpoints
               SET ${column} = ? WHERE id = ?`,
              [value, guardCheckpoint.id]
            )
          );
        } finally {
          await transactionConnection.rollback();
        }
        const [rolledBackRows] =
          await transactionConnection.query<Array<RowDataPacket>>(
            `SELECT instance_id AS instanceId
             FROM search_execution_kernel_state
             WHERE id = 'search_execution_kernel_v1'`
          );
        assert.equal(
          String(rolledBackRows[0]?.instanceId || ""),
          originalInstanceId
        );
      }
    } finally {
      await transactionConnection.end();
    }

    stage = "finish guard run and verify final cold reload";
    const guardFinalProvider = new DeterministicFakeProspectProvider({
      gleif: [{
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
    const guardStarted = await guardKernel.beginRequest({
      leaseId: guardClaim.lease.id,
      claimToken: guardClaim.claimToken,
      now: tick()
    });
    assert.equal(guardStarted.ready, true);
    if (!guardStarted.ready) throw new Error("guard request was deferred");
    assert.equal(guardStarted.request.cursor, "guard-private-cursor");
    const guardResponse = await guardFinalProvider.search(
      guardStarted.request
    );
    if (guardResponse.step.kind !== "success") {
      throw new Error("guard final page must succeed");
    }
    await guardKernel.completePage({
      leaseId: guardClaim.lease.id,
      claimToken: guardClaim.claimToken,
      result: guardResponse.step,
      responseHash: guardResponse.responseHash,
      now: tick()
    });
    const verifiedStore = await createMysqlStore();
    assert.equal(
      verifiedStore.prospectSearchRuns.find(
        (item) => item.id === guardRunId
      )?.status,
      "succeeded"
    );
    assert.equal(
      verifiedStore.prospectExecutionPages.filter(
        (item) => item.runId === guardRunId
      ).length,
      2
    );
    assert.equal(
      JSON.stringify({
        checkpoints: verifiedStore.prospectExecutionCheckpoints,
        attempts: verifiedStore.prospectExecutionAttempts,
        pages: verifiedStore.prospectExecutionPages,
        events: verifiedStore.prospectExecutionEvents
      }).includes("guard-private-cursor"),
      false
    );

    stage = "persist prepared request and physical dispatch facts";
    const dispatchOwner = verifiedStore.users.find(
      (item) => item.id === owner.id
    );
    const dispatchStrategy = verifiedStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    );
    assert.ok(dispatchOwner);
    assert.ok(dispatchStrategy);
    await resetSourcePositionMemoryForScenario(verifiedStore);
    const dispatchRunResult = await createProspectRun({
      store: verifiedStore,
      user: publicUser(dispatchOwner),
      strategyId: dispatchStrategy.id,
      ifMatch: prospectStrategyEtag(dispatchStrategy),
      idempotencyKey: `execution-mysql-dispatch-${randomUUID()}`,
      body: { reason: "验证准备账本与物理派发分离持久化" },
      requestId: "execution-mysql-dispatch-run"
    });
    const dispatchRunId = dispatchRunResult.run.id;
    const providerRequestIdempotencySecret =
      "mysql-provider-idempotency-secret-at-least-32-characters";
    const providerRequestEnvelopeSecret =
      "mysql-provider-envelope-secret-at-least-32-characters";
    const providerRawEnvelopeSecret =
      "mysql-provider-raw-envelope-secret-at-least-32-characters";
    const providerRawIdentitySecret =
      "mysql-provider-raw-identity-secret-at-least-32-characters";
    const providerRawPolicies = {
      gleif: {
        licensePolicy: "mysql-test-public-api",
        retentionPolicy: "mysql-test-30-days",
        retentionDays: 30
      }
    };
    const mysqlRawPlaintextMarker =
      "MYSQL_RAW_PLAINTEXT_MUST_NOT_APPEAR";
    const mysqlRawCompanyName =
      `${mysqlRawPlaintextMarker} Industrial Lighting GmbH`;
    const mysqlRawSourceRecord = {
      providerRecordId: "mysql-raw-company-001",
      sourceUrl: "https://example.test/mysql-raw-company-001",
      fetchedAt: tick(),
      payload: {
        companyName: mysqlRawCompanyName,
        country: "DE",
        website: "https://mysql-raw-company-001.example.test"
      }
    };
    const dispatchKernel = new ProspectExecutionKernel({
      store: verifiedStore,
      workerId: "mysql-dispatch-worker",
      allowedRunIds: [dispatchRunId],
      claimSecret,
      cursorSecret,
      providerRequestIdempotencySecret,
      providerRequestEnvelopeSecret,
      providerRawEnvelopeSecret,
      providerRawIdentitySecret,
      providerRawPolicies
    });
    await dispatchKernel.start(tick());
    const dispatchClaim = await dispatchKernel.claimNext(tick());
    assert.ok(dispatchClaim);
    const prepared = await dispatchKernel.prepareProviderRequest({
      leaseId: dispatchClaim.lease.id,
      claimToken: dispatchClaim.claimToken,
      now: tick()
    });
    const preparedStore = await createMysqlStore();
    const persistedPrepared =
      preparedStore.prospectProviderRequestLedgers.find(
        (item) => item.id === prepared.ledger.id
      );
    assert.equal(persistedPrepared?.status, "prepared");
    assert.match(
      persistedPrepared?.encryptedRequestEnvelope || "",
      /^provider-request-v1\./
    );
    assert.equal(
      (persistedPrepared?.encryptedRequestEnvelope || "")
        .includes("工业照明"),
      false
    );
    await expectRejectedMutation(
      verifiedStore,
      () => {
        const ledger = verifiedStore.prospectProviderRequestLedgers.find(
          (item) => item.id === prepared.ledger.id
        )!;
        ledger.status = "dispatch_started";
        ledger.dispatchStartedAt = tick();
        ledger.dispatchConfirmedAt = ledger.dispatchStartedAt;
        ledger.externalRequestId = "must-not-exist-before-confirmation";
        ledger.dispatchConfirmationRef = `sha256:${"0".repeat(64)}`;
        ledger.updatedAt = ledger.dispatchStartedAt;
        ledger.version += 1;
      },
      /Provider 请求账本身份、哈希、时间或状态无效/
    );

    let durableDispatchObserved = false;
    let dispatchProvider!: MysqlInspectingFakeProspectProvider;
    dispatchProvider = new MysqlInspectingFakeProspectProvider({
      gleif: [{
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
        responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
        sourceRecords: [mysqlRawSourceRecord, mysqlRawSourceRecord]
      }]
    }, async (request): Promise<void> => {
      const startedStore = await createMysqlStore();
      const startedLedger =
        startedStore.prospectProviderRequestLedgers.find(
          (item) => item.id === prepared.ledger.id
        );
      const startedDispatch =
        startedStore.prospectProviderRequestDispatches.find(
          (item) => item.ledgerId === prepared.ledger.id
        );
      const startedAttempt = startedStore.prospectExecutionAttempts.find(
        (item) => item.id === dispatchClaim.attempt.id
      );
      assert.equal(startedLedger?.status, "dispatch_started");
      assert.equal(startedDispatch?.status, "started");
      assert.equal(startedDispatch?.requestHash, request.requestHash);
      assert.equal(startedAttempt?.status, "request_started");
      assert.equal(dispatchProvider.listPhysicalCalls().length, 0);
      durableDispatchObserved = true;
    });
    const dispatchResult =
      await dispatchKernel.dispatchPreparedProviderRequest(
        dispatchProvider,
        {
          leaseId: dispatchClaim.lease.id,
          claimToken: dispatchClaim.claimToken,
          ledgerId: prepared.ledger.id,
          now: tick()
        }
      );
    assert.equal(dispatchResult.kind, "response_received");
    assert.equal(durableDispatchObserved, true);
    assert.equal(dispatchProvider.listPhysicalCalls().length, 1);
    assert.equal(
      dispatchProvider.listPhysicalCalls()
        .filter((item) => item.providerExecuted).length,
      1
    );

    const confirmedStore = await createMysqlStore();
    const confirmedLedger =
      confirmedStore.prospectProviderRequestLedgers.find(
        (item) => item.id === prepared.ledger.id
      );
    const confirmedDispatch =
      confirmedStore.prospectProviderRequestDispatches.find(
        (item) => item.ledgerId === prepared.ledger.id
      );
    assert.equal(confirmedLedger?.status, "response_received");
    assert.equal(confirmedDispatch?.status, "response_received");
    assert.ok(confirmedLedger?.externalRequestId);
    assert.equal(
      confirmedLedger?.responseHash,
      dispatchResult.response.responseHash
    );
    assert.equal(
      confirmedLedger?.rawResponseHash,
      dispatchResult.response.rawResponseHash
    );
    assert.equal(
      confirmedLedger?.normalizedResultHash,
      dispatchResult.response.normalizedResultHash
    );
    assert.equal(
      confirmedLedger?.responseAccountingEvidenceHash,
      dispatchResult.response.accountingEvidenceHash
    );
    assert.equal(confirmedLedger?.httpStatus, 200);
    assert.equal(confirmedLedger?.providerOutcomeCode, "SUCCESS");
    assert.match(
      confirmedLedger?.encryptedResponseEnvelope || "",
      /^provider-response-v1\./
    );
    assert.match(
      confirmedLedger?.responseEvidenceRef || "",
      /^sha256:[a-f0-9]{64}$/
    );
    assert.equal(
      (confirmedLedger?.encryptedResponseEnvelope || "")
        .includes("requestUnits"),
      false
    );
    assert.equal(
      confirmedStore.prospectExecutionLeases.find(
        (item) => item.id === dispatchClaim.lease.id
      )?.releaseReason,
      "RESPONSE_RECEIVED_PENDING_SETTLEMENT"
    );
    assert.equal(
      confirmedStore.prospectExecutionAttempts.find(
        (item) => item.id === dispatchClaim.attempt.id
      )?.status,
      "request_started"
    );
    assert.equal(
      confirmedStore.prospectExecutionPages.some(
        (item) => item.runId === dispatchRunId
      ),
      false
    );
    assert.equal(
      confirmedStore.prospectProviderRequestAccountingEvidence.some(
        (item) => item.ledgerId === prepared.ledger.id
      ),
      false
    );
    assert.deepEqual(
      confirmedStore.prospectProviderRequestEvents
        .filter((item) => item.ledgerId === prepared.ledger.id)
        .map((item) => [item.sequence, item.eventType]),
      [
        [1, "prepared"],
        [2, "dispatch_started"],
        [3, "dispatch_confirmed"],
        [4, "response_received"]
      ]
    );

    const dispatchRecoveryKernel = new ProspectExecutionKernel({
      store: confirmedStore,
      workerId: "mysql-dispatch-recovery-worker",
      allowedRunIds: [dispatchRunId],
      claimSecret,
      cursorSecret,
      providerRequestIdempotencySecret,
      providerRequestEnvelopeSecret,
      providerRawEnvelopeSecret,
      providerRawIdentitySecret,
      providerRawPolicies
    });
    await dispatchRecoveryKernel.start(tick());
    assert.equal(dispatchProvider.listPhysicalCalls().length, 1);
    const replayedResponse =
      await dispatchRecoveryKernel.dispatchPreparedProviderRequest(
        dispatchProvider,
        {
          leaseId: dispatchClaim.lease.id,
          claimToken: dispatchClaim.claimToken,
          ledgerId: prepared.ledger.id,
          now: tick()
        }
      );
    assert.equal(replayedResponse.kind, "response_received");
    assert.equal(dispatchProvider.listPhysicalCalls().length, 1);

    const mutableConfirmedLedger =
      confirmedStore.prospectProviderRequestLedgers.find(
        (item) => item.id === prepared.ledger.id
      )!;
    const originalResponseEnvelope =
      mutableConfirmedLedger.encryptedResponseEnvelope;
    mutableConfirmedLedger.encryptedResponseEnvelope =
      `${originalResponseEnvelope.slice(0, -1)}${
        originalResponseEnvelope.endsWith("A") ? "B" : "A"
      }`;
    await assert.rejects(
      dispatchRecoveryKernel.dispatchPreparedProviderRequest(
        dispatchProvider,
        {
          leaseId: dispatchClaim.lease.id,
          claimToken: dispatchClaim.claimToken,
          ledgerId: prepared.ledger.id,
          now: tick()
        }
      ),
      (error: unknown) =>
        error instanceof ProspectExecutionKernelError
        && error.code === "EXECUTION_PROVIDER_RESPONSE_ENVELOPE_INVALID"
    );
    mutableConfirmedLedger.encryptedResponseEnvelope =
      originalResponseEnvelope;

    await expectRejectedMutation(
      confirmedStore,
      () => {
        const ledger = confirmedStore.prospectProviderRequestLedgers.find(
          (item) => item.id === prepared.ledger.id
        )!;
        ledger.rawResponseHash = "0".repeat(64);
      },
      /Provider 请求账本身份、哈希、时间或状态无效/
    );
    await expectRejectedMutation(
      confirmedStore,
      () => {
        const ledger = confirmedStore.prospectProviderRequestLedgers.find(
          (item) => item.id === prepared.ledger.id
        )!;
        ledger.httpStatus = 201;
      },
      /Provider 请求账本身份、哈希、时间或状态无效/
    );
    await expectRejectedMutation(
      confirmedStore,
      () => {
        const ledger = confirmedStore.prospectProviderRequestLedgers.find(
          (item) => item.id === prepared.ledger.id
        )!;
        ledger.providerOutcomeCode = "TAMPERED";
      },
      /Provider 响应接收事件摘要无效/
    );
    await expectRejectedMutation(
      confirmedStore,
      () => {
        const responseEvent =
          confirmedStore.prospectProviderRequestEvents.find(
            (item) =>
              item.ledgerId === prepared.ledger.id
              && item.eventType === "response_received"
          )!;
        responseEvent.detailHash = "0".repeat(64);
      },
      /Provider 响应接收事件摘要无效/
    );
    await expectRejectedMutation(
      confirmedStore,
      () => {
        const ledger = confirmedStore.prospectProviderRequestLedgers.find(
          (item) => item.id === prepared.ledger.id
        )!;
        ledger.ownerId = confirmedStore.users.find(
          (item) => item.id !== ledger.ownerId
            && item.teamId === ledger.teamId
        )?.id || "cross-owner";
      },
      /Provider 请求账本身份、哈希、时间或状态无效/
    );

    const recoveredDispatchStore = await createMysqlStore();
    assert.equal(
      recoveredDispatchStore.prospectProviderRequestLedgers.find(
        (item) => item.id === prepared.ledger.id
      )?.status,
      "response_received"
    );
    assert.equal(
      recoveredDispatchStore.prospectProviderRequestDispatches.find(
        (item) => item.ledgerId === prepared.ledger.id
      )?.status,
      "response_received"
    );
    assert.equal(
      recoveredDispatchStore.prospectExecutionAttempts.find(
        (item) => item.id === dispatchClaim.attempt.id
      )?.status,
      "request_started"
    );

    stage = "persist late response after outcome unknown recovery";
    const lateResponseOwner = recoveredDispatchStore.users.find(
      (item) => item.id === owner.id
    );
    assert.ok(lateResponseOwner);
    const lateResponseCampaign = await createProspectCampaign({
      store: recoveredDispatchStore,
      user: publicUser(lateResponseOwner),
      body: {
        name: "MySQL 迟到响应恢复项目",
        snapshot: {
          ...fullSnapshot,
          markets: ["France"]
        }
      },
      requestId: "execution-mysql-late-response-campaign-create"
    });
    const lateResponseStrategy =
      recoveredDispatchStore.prospectStrategies.find(
        (item) => item.campaignId === lateResponseCampaign.campaign.id
      );
    assert.ok(lateResponseStrategy);
    const updatedLateResponseStrategy = await updateProspectStrategy({
      store: recoveredDispatchStore,
      user: publicUser(lateResponseOwner),
      strategyId: lateResponseStrategy.id,
      ifMatch: prospectStrategyEtag(lateResponseStrategy),
      body: {
        providerPlan: [{
          providerId: "gleif",
          priority: 20,
          pageLimit: 3,
          resultLimit: 20,
          budgetLimit: null,
          currency: ""
        }],
        reason: "冻结 MySQL 迟到响应测试数据源计划"
      },
      requestId: "execution-mysql-late-response-strategy-update"
    });
    const approvedLateResponseStrategy = await approveProspectStrategy({
      store: recoveredDispatchStore,
      user: publicUser(lateResponseOwner),
      strategyId: lateResponseStrategy.id,
      ifMatch: prospectStrategyEtag(updatedLateResponseStrategy.strategy),
      reason: "MySQL 迟到响应恢复测试审批",
      requestId: "execution-mysql-late-response-strategy-approve"
    });
    await activateProspectCampaign({
      store: recoveredDispatchStore,
      user: publicUser(lateResponseOwner),
      campaignId: lateResponseCampaign.campaign.id,
      ifMatch: prospectCampaignEtag(lateResponseCampaign.campaign),
      requestId: "execution-mysql-late-response-campaign-activate"
    });
    await resetSourcePositionMemoryForScenario(recoveredDispatchStore);
    const lateResponseRunResult = await createProspectRun({
      store: recoveredDispatchStore,
      user: publicUser(lateResponseOwner),
      strategyId: lateResponseStrategy.id,
      ifMatch: prospectStrategyEtag(approvedLateResponseStrategy.strategy),
      idempotencyKey: `execution-mysql-late-response-${randomUUID()}`,
      body: { reason: "验证结果未知后迟到响应仍可安全落库" },
      requestId: "execution-mysql-late-response-run"
    });
    const lateResponseRunId = lateResponseRunResult.run.id;
    const lateResponseKernel = new ProspectExecutionKernel({
      store: recoveredDispatchStore,
      workerId: "mysql-late-response-worker",
      allowedRunIds: [lateResponseRunId],
      claimSecret,
      cursorSecret,
      providerRequestIdempotencySecret,
      providerRequestEnvelopeSecret,
      providerRawEnvelopeSecret,
      providerRawIdentitySecret,
      providerRawPolicies
    });
    await lateResponseKernel.start(tick());
    const lateResponseClaim = await lateResponseKernel.claimNext(tick());
    assert.ok(lateResponseClaim);
    const lateResponsePrepared =
      await lateResponseKernel.prepareProviderRequest({
        leaseId: lateResponseClaim.lease.id,
        claimToken: lateResponseClaim.claimToken,
        now: tick()
      });
    let releaseLateResponse!: () => void;
    let observeDurableDispatch!: () => void;
    const lateResponseGate = new Promise<void>((resolve) => {
      releaseLateResponse = resolve;
    });
    const durableDispatchGate = new Promise<void>((resolve) => {
      observeDurableDispatch = resolve;
    });
    const lateResponseProvider =
      new MysqlInspectingFakeProspectProvider({
        gleif: [{
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
      }, async () => {
        observeDurableDispatch();
        await lateResponseGate;
      });
    const lateResponseInFlight =
      lateResponseKernel.dispatchPreparedProviderRequest(
        lateResponseProvider,
        {
          leaseId: lateResponseClaim.lease.id,
          claimToken: lateResponseClaim.claimToken,
          ledgerId: lateResponsePrepared.ledger.id,
          now: tick()
        }
      );
    await durableDispatchGate;
    const lateResponseRecoveryKernel = new ProspectExecutionKernel({
      store: recoveredDispatchStore,
      workerId: "mysql-late-response-recovery-worker",
      allowedRunIds: [lateResponseRunId],
      claimSecret,
      cursorSecret,
      providerRequestIdempotencySecret,
      providerRequestEnvelopeSecret,
      providerRawEnvelopeSecret,
      providerRawIdentitySecret,
      providerRawPolicies
    });
    await lateResponseRecoveryKernel.start(tick());
    const unknownResponseStore = await createMysqlStore();
    const unknownResponseLedger =
      unknownResponseStore.prospectProviderRequestLedgers.find(
        (item) => item.id === lateResponsePrepared.ledger.id
      );
    assert.equal(unknownResponseLedger?.status, "outcome_unknown");
    assert.ok(unknownResponseLedger?.unknownAt);
    assert.ok(unknownResponseLedger?.unknownReason);
    const unknownResponseLease =
      unknownResponseStore.prospectExecutionLeases.find(
        (item) => item.id === lateResponseClaim.lease.id
      );
    assert.ok(unknownResponseLease);
    const unknownResponseLeaseSnapshot = structuredClone(
      unknownResponseLease
    );
    assert.equal(
      unknownResponseStore.prospectProviderRequestDispatches.find(
        (item) => item.ledgerId === lateResponsePrepared.ledger.id
      )?.status,
      "outcome_unknown"
    );
    releaseLateResponse();
    const lateResponseResult = await lateResponseInFlight;
    assert.equal(lateResponseResult.kind, "response_received");
    assert.equal(lateResponseProvider.listPhysicalCalls().length, 1);
    const persistedLateResponseStore = await createMysqlStore();
    const persistedLateResponseLedger =
      persistedLateResponseStore.prospectProviderRequestLedgers.find(
        (item) => item.id === lateResponsePrepared.ledger.id
      );
    const persistedLateResponseDispatch =
      persistedLateResponseStore.prospectProviderRequestDispatches.find(
        (item) => item.ledgerId === lateResponsePrepared.ledger.id
      );
    assert.equal(persistedLateResponseLedger?.status, "response_received");
    assert.equal(
      persistedLateResponseDispatch?.status,
      "response_received"
    );
    assert.ok(persistedLateResponseLedger?.unknownAt);
    assert.ok(persistedLateResponseLedger?.unknownReason);
    assert.equal(persistedLateResponseLedger?.errorCode, "");
    assert.equal(persistedLateResponseDispatch?.errorCode, "");
    assert.deepEqual(
      persistedLateResponseStore.prospectExecutionLeases.find(
        (item) => item.id === lateResponseClaim.lease.id
      ),
      unknownResponseLeaseSnapshot
    );
    assert.equal(
      persistedLateResponseStore.prospectExecutionAttempts.find(
        (item) => item.id === lateResponseClaim.attempt.id
      )?.status,
      "request_outcome_unknown"
    );
    assert.equal(
      persistedLateResponseStore.prospectExecutionPages.some(
        (item) => item.runId === lateResponseRunId
      ),
      false
    );
    assert.equal(
      persistedLateResponseStore
        .prospectProviderRequestAccountingEvidence.some(
          (item) => item.ledgerId === lateResponsePrepared.ledger.id
        ),
      false
    );
    assert.deepEqual(
      persistedLateResponseStore.prospectProviderRequestEvents
        .filter((item) => item.ledgerId === lateResponsePrepared.ledger.id)
        .map((item) => [item.sequence, item.eventType]),
      [
        [1, "prepared"],
        [2, "dispatch_started"],
        [3, "outcome_unknown"],
        [4, "dispatch_confirmed"],
        [5, "response_received"]
      ]
    );
    const replayedLateResponse =
      await lateResponseRecoveryKernel.dispatchPreparedProviderRequest(
        lateResponseProvider,
        {
          leaseId: lateResponseClaim.lease.id,
          claimToken: lateResponseClaim.claimToken,
          ledgerId: lateResponsePrepared.ledger.id,
          now: tick()
        }
      );
    assert.equal(replayedLateResponse.kind, "response_received");
    assert.equal(lateResponseProvider.listPhysicalCalls().length, 1);

    stage = "cold-start concurrent Provider response settlement";
    const settlementStoreA = await createMysqlStore();
    const settlementLedgerA =
      settlementStoreA.prospectProviderRequestLedgers.find(
        (item) => item.id === prepared.ledger.id
      );
    assert.ok(settlementLedgerA);
    assert.equal(settlementLedgerA.status, "response_received");
    const settlementLeaseBefore = structuredClone(
      settlementStoreA.prospectExecutionLeases.find(
        (item) => item.id === dispatchClaim.lease.id
      )!
    );
    const crmFactsBeforeSettlement = {
      leads: settlementStoreA.leads.length,
      customers: settlementStoreA.customers.length,
      deals: settlementStoreA.deals.length,
      websiteOpportunities:
        settlementStoreA.websiteOpportunities.length
    };
    const settlementKernelA = new ProspectExecutionKernel({
      store: settlementStoreA,
      workerId: "mysql-settlement-race-worker-a",
      allowedRunIds: [dispatchRunId],
      claimSecret,
      cursorSecret,
      providerRequestIdempotencySecret,
      providerRequestEnvelopeSecret,
      providerRawEnvelopeSecret,
      providerRawIdentitySecret,
      providerRawPolicies
    });
    await settlementKernelA.start(tick());
    const settlementStoreB = await createMysqlStore();
    const settlementKernelB = new ProspectExecutionKernel({
      store: settlementStoreB,
      workerId: "mysql-settlement-race-worker-b",
      allowedRunIds: [dispatchRunId],
      claimSecret,
      cursorSecret,
      providerRequestIdempotencySecret,
      providerRequestEnvelopeSecret,
      providerRawEnvelopeSecret,
      providerRawIdentitySecret,
      providerRawPolicies
    });
    await settlementKernelB.start(tick());
    await settlementStoreA.reloadProspectRuns?.();

    const settlementLedgerB =
      settlementStoreB.prospectProviderRequestLedgers.find(
        (item) => item.id === prepared.ledger.id
      )!;
    const otherSettlementOwner = settlementStoreB.users.find(
      (item) => item.id !== settlementLedgerB.ownerId
    );
    assert.ok(otherSettlementOwner);
    await assert.rejects(
      settlementKernelB.settlePersistedProviderResponse({
        teamId: "cross-team",
        ownerId: settlementLedgerB.ownerId,
        runId: settlementLedgerB.runId,
        ledgerId: settlementLedgerB.id,
        expectedResponseHash: settlementLedgerB.responseHash,
        now: tick()
      }),
      (error: unknown) =>
        error instanceof ProspectExecutionKernelError
        && error.code === "EXECUTION_PROVIDER_SETTLEMENT_SCOPE_INVALID"
    );
    await assert.rejects(
      settlementKernelB.settlePersistedProviderResponse({
        teamId: settlementLedgerB.teamId,
        ownerId: otherSettlementOwner.id,
        runId: settlementLedgerB.runId,
        ledgerId: settlementLedgerB.id,
        expectedResponseHash: settlementLedgerB.responseHash,
        now: tick()
      }),
      (error: unknown) =>
        error instanceof ProspectExecutionKernelError
        && error.code === "EXECUTION_PROVIDER_SETTLEMENT_SCOPE_INVALID"
    );
    await assert.rejects(
      settlementKernelB.settlePersistedProviderResponse({
        teamId: settlementLedgerB.teamId,
        ownerId: settlementLedgerB.ownerId,
        runId: settlementLedgerB.runId,
        ledgerId: settlementLedgerB.id,
        expectedResponseHash: "0".repeat(64),
        now: tick()
      }),
      (error: unknown) =>
        error instanceof ProspectExecutionKernelError
        && error.code === "EXECUTION_PROVIDER_SETTLEMENT_CONFLICT"
    );
    const originalSettlementEnvelope =
      settlementLedgerB.encryptedResponseEnvelope;
    settlementLedgerB.encryptedResponseEnvelope =
      `${originalSettlementEnvelope.slice(0, -1)}${
        originalSettlementEnvelope.endsWith("A") ? "B" : "A"
      }`;
    await assert.rejects(
      settlementKernelB.settlePersistedProviderResponse({
        teamId: settlementLedgerB.teamId,
        ownerId: settlementLedgerB.ownerId,
        runId: settlementLedgerB.runId,
        ledgerId: settlementLedgerB.id,
        expectedResponseHash: settlementLedgerB.responseHash,
        now: tick()
      }),
      (error: unknown) =>
        error instanceof ProspectExecutionKernelError
        && error.code === "EXECUTION_PROVIDER_RESPONSE_ENVELOPE_INVALID"
    );
    settlementStoreB.prospectProviderRequestLedgers.find(
      (item) => item.id === prepared.ledger.id
    )!.encryptedResponseEnvelope = originalSettlementEnvelope;

    const settlementAt = tick();
    const concurrentSettlements = await Promise.allSettled([
      settlementKernelA.settlePersistedProviderResponse({
        teamId: settlementLedgerA.teamId,
        ownerId: settlementLedgerA.ownerId,
        runId: settlementLedgerA.runId,
        ledgerId: settlementLedgerA.id,
        expectedResponseHash: settlementLedgerA.responseHash,
        now: settlementAt
      }),
      settlementKernelB.settlePersistedProviderResponse({
        teamId: settlementLedgerB.teamId,
        ownerId: settlementLedgerB.ownerId,
        runId: settlementLedgerB.runId,
        ledgerId: settlementLedgerB.id,
        expectedResponseHash: settlementLedgerB.responseHash,
        now: settlementAt
      })
    ]);
    const fulfilledSettlements = concurrentSettlements.filter(
      (item) => item.status === "fulfilled"
    );
    const rejectedSettlements = concurrentSettlements.filter(
      (item) => item.status === "rejected"
    );
    assert.equal(fulfilledSettlements.length, 1);
    assert.equal(rejectedSettlements.length, 1);
    assert.match(
      String(
        (rejectedSettlements[0] as PromiseRejectedResult).reason
      ),
      /CAS|不可变证据|历史不允许删除/
    );
    const winnerIndex = concurrentSettlements.findIndex(
      (item) => item.status === "fulfilled"
    );
    const winningKernel = winnerIndex === 0
      ? settlementKernelA
      : settlementKernelB;
    const winningSettlement =
      (concurrentSettlements[winnerIndex] as PromiseFulfilledResult<
        Awaited<ReturnType<
          typeof settlementKernelA.settlePersistedProviderResponse
        >>
      >).value;
    assert.equal(winningSettlement.kind, "success");
    assert.equal(winningSettlement.idempotent, false);

    const winningSettlementStore = winnerIndex === 0
      ? settlementStoreA
      : settlementStoreB;
    const winningRawState = {
      batches: structuredClone(
        winningSettlementStore.prospectSourceRawBatches
      ),
      records: structuredClone(
        winningSettlementStore.prospectSourceRawRecords
      ),
      hits: structuredClone(
        winningSettlementStore.prospectSourceRawHits
      )
    };
    const settledDispatchStore = await createMysqlStore();
    assert.deepEqual(
      settledDispatchStore.prospectSourceRawBatches,
      winningRawState.batches
    );
    assert.deepEqual(
      settledDispatchStore.prospectSourceRawRecords,
      winningRawState.records
    );
    assert.deepEqual(
      settledDispatchStore.prospectSourceRawHits,
      winningRawState.hits
    );
    const settledDispatchLedger =
      settledDispatchStore.prospectProviderRequestLedgers.find(
        (item) => item.id === prepared.ledger.id
      );
    assert.equal(settledDispatchLedger?.status, "settled");
    assert.equal(settledDispatchLedger?.settlementKind, "success");
    assert.equal(
      settledDispatchStore.prospectExecutionAttempts.find(
        (item) => item.id === dispatchClaim.attempt.id
      )?.status,
      "succeeded"
    );
    assert.equal(
      settledDispatchStore.prospectExecutionPages.filter(
        (item) => item.attemptId === dispatchClaim.attempt.id
      ).length,
      1
    );
    assert.equal(
      settledDispatchStore.prospectProviderRequestAccountingEvidence
        .filter((item) => item.ledgerId === prepared.ledger.id).length,
      1
    );
    assert.deepEqual(
      settledDispatchStore.prospectExecutionLeases.find(
        (item) => item.id === dispatchClaim.lease.id
      ),
      settlementLeaseBefore
    );
    assert.deepEqual(
      {
        leads: settledDispatchStore.leads.length,
        customers: settledDispatchStore.customers.length,
        deals: settledDispatchStore.deals.length,
        websiteOpportunities:
          settledDispatchStore.websiteOpportunities.length
      },
      crmFactsBeforeSettlement
    );
    const settledRawBatch =
      settledDispatchStore.prospectSourceRawBatches.find(
        (item) => item.ledgerId === prepared.ledger.id
      );
    assert.ok(settledRawBatch);
    assert.equal(settledRawBatch.recordCount, 2);
    assert.equal(
      settledDispatchStore.prospectSourceRawRecords.filter(
        (item) =>
          item.teamId === settledRawBatch.teamId
          && item.ownerId === settledRawBatch.ownerId
          && item.providerCode === settledRawBatch.providerCode
          && item.connectionId === settledRawBatch.connectionId
          && item.endpointCode === settledRawBatch.endpointCode
      ).length,
      1
    );
    const settledRawHits =
      settledDispatchStore.prospectSourceRawHits.filter(
        (item) => item.batchId === settledRawBatch.id
      );
    assert.deepEqual(
      settledRawHits.map((item) => item.ordinal),
      [1, 2]
    );
    assert.equal(settledRawHits[0]?.recordId, settledRawHits[1]?.recordId);
    const restoredRawState = {
      batches: structuredClone(
        settledDispatchStore.prospectSourceRawBatches
      ),
      records: structuredClone(
        settledDispatchStore.prospectSourceRawRecords
      ),
      hits: structuredClone(settledDispatchStore.prospectSourceRawHits)
    };
    settledDispatchStore.prospectSourceRawBatches.length = 0;
    settledDispatchStore.prospectSourceRawRecords.length = 0;
    settledDispatchStore.prospectSourceRawHits.length = 0;
    await settledDispatchStore.reloadProspectRuns?.();
    assert.deepEqual(
      settledDispatchStore.prospectSourceRawBatches,
      restoredRawState.batches
    );
    assert.deepEqual(
      settledDispatchStore.prospectSourceRawRecords,
      restoredRawState.records
    );
    assert.deepEqual(
      settledDispatchStore.prospectSourceRawHits,
      restoredRawState.hits
    );
    const [rawRecordRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT *
       FROM \`${databaseName}\`.prospect_source_raw_records
       WHERE team_id = ? AND id = ?`,
      [settledRawBatch.teamId, settledRawHits[0]?.recordId]
    );
    assert.equal(rawRecordRows.length, 1);
    assert.match(
      String(rawRecordRows[0]?.encrypted_envelope || ""),
      /^provider-raw-v1\./
    );
    const [rawBatchRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT *
       FROM \`${databaseName}\`.prospect_source_raw_batches
       WHERE team_id = ? AND id = ?`,
      [settledRawBatch.teamId, settledRawBatch.id]
    );
    const [rawHitRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT *
       FROM \`${databaseName}\`.prospect_source_raw_hits
       WHERE team_id = ? AND batch_id = ?
       ORDER BY ordinal`,
      [settledRawBatch.teamId, settledRawBatch.id]
    );
    const persistedRawText = JSON.stringify({
      records: rawRecordRows,
      batches: rawBatchRows,
      hits: rawHitRows
    });
    assert.equal(persistedRawText.includes(mysqlRawPlaintextMarker), false);
    assert.equal(persistedRawText.includes(mysqlRawCompanyName), false);
    const replayedSettlement =
      await winningKernel.settlePersistedProviderResponse({
        teamId: winningSettlement.ledger.teamId,
        ownerId: winningSettlement.ledger.ownerId,
        runId: winningSettlement.ledger.runId,
        ledgerId: winningSettlement.ledger.id,
        expectedResponseHash: winningSettlement.ledger.responseHash,
        now: tick()
      });
    assert.equal(replayedSettlement.kind, "success");
    assert.equal(replayedSettlement.idempotent, true);

    stage = "reject settled Provider response tampering";
    const settlementAuditKernel = new ProspectExecutionKernel({
      store: settledDispatchStore,
      workerId: "mysql-settlement-audit-worker",
      allowedRunIds: [dispatchRunId],
      claimSecret,
      cursorSecret,
      providerRequestIdempotencySecret,
      providerRequestEnvelopeSecret,
      providerRawEnvelopeSecret,
      providerRawIdentitySecret,
      providerRawPolicies
    });
    await settlementAuditKernel.start(tick());
    const auditLedger =
      settledDispatchStore.prospectProviderRequestLedgers.find(
        (item) => item.id === prepared.ledger.id
      )!;
    const originalAuditEnvelope = auditLedger.encryptedResponseEnvelope;
    auditLedger.encryptedResponseEnvelope =
      `${originalAuditEnvelope.slice(0, -1)}${
        originalAuditEnvelope.endsWith("A") ? "B" : "A"
      }`;
    await assert.rejects(
      settlementAuditKernel.settlePersistedProviderResponse({
        teamId: auditLedger.teamId,
        ownerId: auditLedger.ownerId,
        runId: auditLedger.runId,
        ledgerId: auditLedger.id,
        expectedResponseHash: auditLedger.responseHash,
        now: tick()
      }),
      (error: unknown) =>
        error instanceof ProspectExecutionKernelError
        && error.code === "EXECUTION_PROVIDER_RESPONSE_ENVELOPE_INVALID"
    );
    settledDispatchStore.prospectProviderRequestLedgers.find(
      (item) => item.id === prepared.ledger.id
    )!.encryptedResponseEnvelope = originalAuditEnvelope;
    await expectRejectedMutation(
      settledDispatchStore,
      () => {
        const evidence =
          settledDispatchStore
            .prospectProviderRequestAccountingEvidence.find(
              (item) => item.ledgerId === prepared.ledger.id
            )!;
        evidence.evidenceHash = "0".repeat(64);
      },
      /Provider 响应结算成本证据来源、摘要或引用无效/
    );
    await expectRejectedMutation(
      settledDispatchStore,
      () => {
        const evidence =
          settledDispatchStore
            .prospectProviderRequestAccountingEvidence.find(
              (item) => item.ledgerId === prepared.ledger.id
            )!;
        evidence.provenance = "invoice_confirmed";
      },
      /Provider 响应结算成本证据来源、摘要或引用无效/
    );
    await expectRejectedMutation(
      settledDispatchStore,
      () => {
        const ledger =
          settledDispatchStore.prospectProviderRequestLedgers.find(
            (item) => item.id === prepared.ledger.id
          )!;
        ledger.settlementHash = "0".repeat(64);
      },
      /Provider 响应结算事件或不可变摘要无效/
    );
    await expectRejectedMutation(
      settledDispatchStore,
      () => {
        const page = settledDispatchStore.prospectExecutionPages.find(
          (item) => item.attemptId === dispatchClaim.attempt.id
        )!;
        page.acceptedCount += 1;
      },
      /页摘要引用、哈希或计数无效|checkpoint 与调用或页摘要聚合不一致|结算事件或不可变摘要无效/
    );

    stage = "cold-start cancelled-late response settlement";
    const lateSettlementStore = await createMysqlStore();
    const lateSettlementLedger =
      lateSettlementStore.prospectProviderRequestLedgers.find(
        (item) => item.id === lateResponsePrepared.ledger.id
      );
    assert.ok(lateSettlementLedger);
    const lateSettlementLeaseBefore = structuredClone(
      lateSettlementStore.prospectExecutionLeases.find(
        (item) => item.id === lateResponseClaim.lease.id
      )!
    );
    const lateSettlementKernel = new ProspectExecutionKernel({
      store: lateSettlementStore,
      workerId: "mysql-late-settlement-worker",
      allowedRunIds: [lateResponseRunId],
      claimSecret,
      cursorSecret,
      providerRequestIdempotencySecret,
      providerRequestEnvelopeSecret
    });
    await lateSettlementKernel.start(tick());
    const lateSettlement =
      await lateSettlementKernel.settlePersistedProviderResponse({
        teamId: lateSettlementLedger.teamId,
        ownerId: lateSettlementLedger.ownerId,
        runId: lateSettlementLedger.runId,
        ledgerId: lateSettlementLedger.id,
        expectedResponseHash: lateSettlementLedger.responseHash,
        now: tick()
      });
    assert.equal(lateSettlement.kind, "cancelled_late");
    assert.equal(lateSettlement.attempt.status, "cancelled_late");
    assert.equal(lateSettlement.accountingEvidence.provenance, "unknown");
    assert.equal(
      lateSettlementStore.prospectExecutionPages.some(
        (item) => item.attemptId === lateResponseClaim.attempt.id
      ),
      false
    );
    assert.deepEqual(
      lateSettlementStore.prospectExecutionLeases.find(
        (item) => item.id === lateResponseClaim.lease.id
      ),
      lateSettlementLeaseBefore
    );

    stage = "cold-start failed Provider response settlement";
    const failureOwner = lateSettlementStore.users.find(
      (item) => item.id === owner.id
    );
    const failureStrategy = lateSettlementStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    );
    assert.ok(failureOwner);
    assert.ok(failureStrategy);
    await resetSourcePositionMemoryForScenario(lateSettlementStore);
    const failureRunResult = await createProspectRun({
      store: lateSettlementStore,
      user: publicUser(failureOwner),
      strategyId: failureStrategy.id,
      ifMatch: prospectStrategyEtag(failureStrategy),
      idempotencyKey: `execution-mysql-settlement-failure-${randomUUID()}`,
      body: { reason: "验证 Provider 失败响应冷启动结算" },
      requestId: "execution-mysql-settlement-failure-run"
    });
    const failureRunId = failureRunResult.run.id;
    const failureDispatchKernel = new ProspectExecutionKernel({
      store: lateSettlementStore,
      workerId: "mysql-failure-dispatch-worker",
      allowedRunIds: [failureRunId],
      claimSecret,
      cursorSecret,
      providerRequestIdempotencySecret,
      providerRequestEnvelopeSecret
    });
    await failureDispatchKernel.start(tick());
    const failureClaim = await failureDispatchKernel.claimNext(tick());
    assert.ok(failureClaim);
    const failurePrepared =
      await failureDispatchKernel.prepareProviderRequest({
        leaseId: failureClaim.lease.id,
        claimToken: failureClaim.claimToken,
        now: tick()
      });
    const failureRetryAt = new Date(
      timelineStart + 60 * 60_000
    ).toISOString();
    const failureProvider = new DeterministicFakeProspectProvider({
      gleif: [{
        kind: "failure",
        errorCode: "PROVIDER_RATE_LIMITED",
        errorMessage: "rate limited",
        retryable: true,
        retryAfterAt: failureRetryAt,
        usage: { requestUnits: 1, resultUnits: 0 },
        cost: { kind: "estimated", amount: 0.005, currency: "USD" }
      }]
    });
    const failureResponse =
      await failureDispatchKernel.dispatchPreparedProviderRequest(
        failureProvider,
        {
          leaseId: failureClaim.lease.id,
          claimToken: failureClaim.claimToken,
          ledgerId: failurePrepared.ledger.id,
          now: tick()
        }
      );
    assert.equal(failureResponse.kind, "response_received");
    const failurePendingStore = await createMysqlStore();
    const failurePendingLedger =
      failurePendingStore.prospectProviderRequestLedgers.find(
        (item) => item.id === failurePrepared.ledger.id
      );
    assert.ok(failurePendingLedger);
    const failureSettlementKernel = new ProspectExecutionKernel({
      store: failurePendingStore,
      workerId: "mysql-failure-settlement-worker",
      allowedRunIds: [failureRunId],
      claimSecret,
      cursorSecret,
      providerRequestIdempotencySecret,
      providerRequestEnvelopeSecret
    });
    await failureSettlementKernel.start(tick());
    const failureSettlement =
      await failureSettlementKernel.settlePersistedProviderResponse({
        teamId: failurePendingLedger.teamId,
        ownerId: failurePendingLedger.ownerId,
        runId: failurePendingLedger.runId,
        ledgerId: failurePendingLedger.id,
        expectedResponseHash: failurePendingLedger.responseHash,
        now: tick()
      });
    assert.equal(failureSettlement.kind, "failure");
    assert.equal(failureSettlement.retryScheduled, true);
    assert.equal(failureSettlement.retryAfterAt, failureRetryAt);
    assert.equal(
      failureSettlement.accountingEvidence.provenance,
      "estimated"
    );
    assert.equal(
      failureSettlement.accountingEvidence.estimationMethodVersion,
      "fake-provider-estimate-v1"
    );
    assert.equal(
      failurePendingStore.prospectExecutionPages.some(
        (item) => item.attemptId === failureClaim.attempt.id
      ),
      false
    );
    const coldFailureStore = await createMysqlStore();
    assert.equal(
      coldFailureStore.prospectProviderRequestLedgers.find(
        (item) => item.id === failurePrepared.ledger.id
      )?.settlementKind,
      "failure"
    );
    assert.equal(
      coldFailureStore.prospectProviderRequestAccountingEvidence.filter(
        (item) => item.ledgerId === failurePrepared.ledger.id
      ).length,
      1
    );
    assert.equal(
      coldFailureStore.prospectExecutionPages.some(
        (item) => item.attemptId === failureClaim.attempt.id
      ),
      false
    );

    console.log(
      "Prospect execution MySQL persistence, CAS, recovery, "
      + "settlement, immutability and isolation tests passed"
    );
    exitCode = 0;
  } catch (error) {
    console.error(`Prospect execution MySQL test failed at: ${stage}`);
    console.error(error);
  } finally {
    if (databaseCreated) {
      if (grantedAccount) {
        const separator = grantedAccount.lastIndexOf("@");
        const accountUser = grantedAccount.slice(0, separator);
        const accountHost = grantedAccount.slice(separator + 1);
        await admin.query(
          `REVOKE ALL PRIVILEGES ON \`${databaseName}\`.* FROM ${
            sqlString(accountUser)
          }@${sqlString(accountHost)}`
        ).catch(() => undefined);
      }
      await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    }
    await admin.end();
    process.exit(exitCode);
  }
}

await main();
