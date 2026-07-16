import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { publicUser } from "./auth.js";
import {
  activateProspectCampaign,
  createProspectCampaign,
  prospectCampaignEtag,
  transitionProspectCampaign
} from "./prospect-campaigns.js";
import { createMysqlStore } from "./mysql-store.js";
import {
  createProspectRun,
  ProspectRunRequestError,
  transitionProspectRun
} from "./prospect-runs.js";
import {
  approveProspectStrategy,
  prospectStrategyEtag,
  updateProspectStrategy
} from "./prospect-strategies.js";

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

async function main() {
  const applicationUrl = process.env.DATABASE_URL
    || process.env.MYSQL_URL
    || process.env.MYSQL_TEST_ADMIN_URL;
  const adminConnectionUrl = process.env.MYSQL_TEST_ADMIN_URL
    || applicationUrl;
  if (!applicationUrl || !adminConnectionUrl) {
    throw new Error(
      "Prospect Run MySQL test requires MYSQL_TEST_ADMIN_URL, DATABASE_URL or MYSQL_URL"
    );
  }

  const adminUrl = new URL(adminConnectionUrl);
  const appUrl = new URL(applicationUrl);
  const databaseName =
    `goodjob_run_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let databaseCreated = false;
  let grantedAccount = "";
  let exitCode = 1;
  let stage = "create database";

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
    const [baselineTables] = await admin.query<Array<RowDataPacket>>(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = ?
         AND table_name IN (
           'prospect_search_runs',
           'prospect_run_shards',
           'prospect_run_events',
           'prospect_run_queue_parent_bindings',
           'prospect_run_queue_child_bindings'
         )
       ORDER BY table_name`,
      [databaseName]
    );
    assert.deepEqual(
      baselineTables.map((row) => String(row.tableName)),
      [
        "prospect_run_events",
        "prospect_run_queue_child_bindings",
        "prospect_run_queue_parent_bindings",
        "prospect_run_shards",
        "prospect_search_runs"
      ]
    );
    const [strategyReferenceIndex] = await admin.query<Array<RowDataPacket>>(
      `SELECT GROUP_CONCAT(
         column_name ORDER BY seq_in_index
       ) AS columnsList
       FROM information_schema.statistics
       WHERE table_schema = ?
         AND table_name = 'prospect_strategies'
         AND index_name = 'uk_prospect_strategy_run_ref'
         AND non_unique = 0`,
      [databaseName]
    );
    assert.equal(
      strategyReferenceIndex[0]?.columnsList,
      "team_id,campaign_id,campaign_version,id"
    );

    stage = "create ready campaign";
    const setupStore = await createMysqlStore();
    const owner = setupStore.users.find(
      (item) => item.id === "u_sales_shirley"
    );
    assert.ok(owner);
    const created = await createProspectCampaign({
      store: setupStore,
      user: publicUser(owner),
      body: {
        name: "MySQL 搜索运行控制面项目",
        snapshot: fullSnapshot
      },
      requestId: "run-mysql-campaign-create"
    });
    const campaign = created.campaign;
    const strategy = setupStore.prospectStrategies.find(
      (item) => item.campaignId === campaign.id
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
          resultLimit: 100,
          budgetLimit: null,
          currency: ""
        }],
        reason: "冻结搜索运行数据源计划"
      },
      requestId: "run-mysql-strategy-update"
    });
    await approveProspectStrategy({
      store: setupStore,
      user: publicUser(owner),
      strategyId: strategy.id,
      ifMatch: prospectStrategyEtag(updatedStrategy.strategy),
      reason: "MySQL 搜索运行测试审批",
      requestId: "run-mysql-strategy-approve"
    });
    await activateProspectCampaign({
      store: setupStore,
      user: publicUser(owner),
      campaignId: campaign.id,
      ifMatch: prospectCampaignEtag(campaign),
      requestId: "run-mysql-campaign-activate"
    });

    stage = "create pause race campaign";
    const raceCreated = await createProspectCampaign({
      store: setupStore,
      user: publicUser(owner),
      body: {
        name: "MySQL 暂停创建竞态项目",
        snapshot: fullSnapshot
      },
      requestId: "run-mysql-race-campaign-create"
    });
    const raceCampaign = raceCreated.campaign;
    const raceStrategy = setupStore.prospectStrategies.find(
      (item) => item.campaignId === raceCampaign.id
    );
    assert.ok(raceStrategy);
    const raceUpdatedStrategy = await updateProspectStrategy({
      store: setupStore,
      user: publicUser(owner),
      strategyId: raceStrategy.id,
      ifMatch: prospectStrategyEtag(raceStrategy),
      body: {
        providerPlan: [{
          providerId: "gleif",
          priority: 20,
          pageLimit: 3,
          resultLimit: 100,
          budgetLimit: null,
          currency: ""
        }],
        reason: "冻结竞态测试数据源计划"
      },
      requestId: "run-mysql-race-strategy-update"
    });
    await approveProspectStrategy({
      store: setupStore,
      user: publicUser(owner),
      strategyId: raceStrategy.id,
      ifMatch: prospectStrategyEtag(raceUpdatedStrategy.strategy),
      reason: "MySQL 竞态测试审批",
      requestId: "run-mysql-race-strategy-approve"
    });
    await activateProspectCampaign({
      store: setupStore,
      user: publicUser(owner),
      campaignId: raceCampaign.id,
      ifMatch: prospectCampaignEtag(raceCampaign),
      requestId: "run-mysql-race-campaign-activate"
    });

    stage = "load campaign race store";
    const raceStore = await createMysqlStore();

    stage = "campaign pause create race";
    const raceStoreOwner = raceStore.users.find(
      (item) => item.id === owner.id
    )!;
    const raceStoreCampaign = raceStore.prospectCampaigns.find(
      (item) => item.id === raceCampaign.id
    )!;
    const raceStoreStrategy = raceStore.prospectStrategies.find(
      (item) => item.id === raceStrategy.id
    )!;
    const pauseCreateResults = await Promise.allSettled([
      transitionProspectCampaign({
        store: raceStore,
        user: publicUser(raceStoreOwner),
        campaignId: raceStoreCampaign.id,
        ifMatch: prospectCampaignEtag(raceStoreCampaign),
        targetStatus: "paused",
        reason: "MySQL 并发暂停项目",
        requestId: "run-mysql-race-pause"
      }),
      createProspectRun({
        store: raceStore,
        user: publicUser(raceStoreOwner),
        strategyId: raceStoreStrategy.id,
        ifMatch: prospectStrategyEtag(raceStoreStrategy),
        idempotencyKey: `run-mysql-race-${randomUUID()}`,
        body: { reason: "与项目暂停交错创建" },
        requestId: "run-mysql-race-create"
      })
    ]);
    assert.equal(pauseCreateResults[0]?.status, "fulfilled");
    assert.equal(pauseCreateResults[1]?.status, "rejected");
    const pauseCreateError = (
      pauseCreateResults[1] as PromiseRejectedResult
    ).reason;
    assert.equal(pauseCreateError instanceof ProspectRunRequestError, true);
    assert.equal(pauseCreateError.code, "RUN_NOT_READY");
    assert.equal(
      (pauseCreateError.details.issues as Array<{ code: string }>).some(
        (item) => item.code === "CAMPAIGN_NOT_ACTIVE"
      ),
      true
    );
    assert.equal(
      raceStore.prospectSearchRuns.some(
        (item) => item.campaignId === raceStoreCampaign.id
      ),
      false
    );

    stage = "same-store active uniqueness";
    await activateProspectCampaign({
      store: raceStore,
      user: publicUser(raceStoreOwner),
      campaignId: raceStoreCampaign.id,
      ifMatch: prospectCampaignEtag(raceStoreCampaign),
      requestId: "run-mysql-race-reactivate"
    });
    const activeRaceResults = await Promise.allSettled([
      createProspectRun({
        store: raceStore,
        user: publicUser(raceStoreOwner),
        strategyId: raceStoreStrategy.id,
        ifMatch: prospectStrategyEtag(raceStoreStrategy),
        idempotencyKey: `run-mysql-active-a-${randomUUID()}`,
        body: { reason: "同实例同指纹异键 A" },
        requestId: "run-mysql-active-a"
      }),
      createProspectRun({
        store: raceStore,
        user: publicUser(raceStoreOwner),
        strategyId: raceStoreStrategy.id,
        ifMatch: prospectStrategyEtag(raceStoreStrategy),
        idempotencyKey: `run-mysql-active-b-${randomUUID()}`,
        body: { reason: "同实例同指纹异键 B" },
        requestId: "run-mysql-active-b"
      })
    ]);
    const activeRaceCreated = activeRaceResults.find(
      (item): item is PromiseFulfilledResult<
        Awaited<ReturnType<typeof createProspectRun>>
      > => item.status === "fulfilled"
    );
    const activeRaceRejected = activeRaceResults.find(
      (item): item is PromiseRejectedResult => item.status === "rejected"
    );
    assert.ok(activeRaceCreated);
    assert.ok(activeRaceRejected);
    assert.equal(
      activeRaceRejected.reason instanceof ProspectRunRequestError,
      true
    );
    assert.equal(activeRaceRejected.reason.code, "ACTIVE_RUN_EXISTS");
    await transitionProspectRun({
      store: raceStore,
      user: publicUser(raceStoreOwner),
      runId: activeRaceCreated.value.run.id,
      ifMatch: `"${activeRaceCreated.value.run.id}:${
        activeRaceCreated.value.run.revision
      }"`,
      action: "cancel",
      body: { reason: "结束同实例活动唯一性测试" },
      requestId: "run-mysql-active-cancel"
    });

    stage = "load concurrent stores";
    const creatorStore = await createMysqlStore();
    const replayStore = await createMysqlStore();
    const changedRequestStore = await createMysqlStore();
    const activeConflictStore = await createMysqlStore();
    const creatorOwner = creatorStore.users.find(
      (item) => item.id === owner.id
    )!;
    const creatorStrategy = creatorStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    )!;
    const idempotencyKey = `run-mysql-${randomUUID()}`;

    stage = "same-store concurrent exact replay";
    const sameStoreRequests = await Promise.all([
      createProspectRun({
        store: creatorStore,
        user: publicUser(creatorOwner),
        strategyId: creatorStrategy.id,
        ifMatch: prospectStrategyEtag(creatorStrategy),
        idempotencyKey,
        body: { reason: "首次创建搜索运行" },
        requestId: "run-mysql-create-a"
      }),
      createProspectRun({
        store: creatorStore,
        user: publicUser(creatorOwner),
        strategyId: creatorStrategy.id,
        ifMatch: prospectStrategyEtag(creatorStrategy),
        idempotencyKey,
        body: { reason: "首次创建搜索运行" },
        requestId: "run-mysql-create-b"
      })
    ]);
    const createdRun = sameStoreRequests.find(
      (item) => !item.idempotencyReplayed
    )!;
    const sameStoreReplay = sameStoreRequests.find(
      (item) => item.idempotencyReplayed
    )!;
    assert.ok(createdRun);
    assert.ok(sameStoreReplay);
    const runId = createdRun.run.id;
    assert.equal(sameStoreReplay.run.id, runId);
    assert.equal(createdRun.idempotencyReplayed, false);
    assert.equal(createdRun.executionMode, "control_plane_only_v1");
    assert.equal(createdRun.executionAvailable, false);
    assert.equal(createdRun.hasExecutionData, false);
    assert.equal(createdRun.shards.length, 1);
    assert.equal(createdRun.events.length, 1);
    assert.equal(
      creatorStore.prospectRunQueueParentBindings.filter(
        (item) => item.runId === runId
      ).length,
      1
    );
    assert.equal(
      creatorStore.prospectRunQueueChildBindings.filter(
        (item) => item.runId === runId
      ).length,
      1
    );
    assert.equal(
      creatorStore.agentJobs.filter((item) => item.aggregateId === runId)
        .length,
      2
    );

    stage = "concurrent exact replay";
    const replayStrategy = replayStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    )!;
    const replay = await createProspectRun({
      store: replayStore,
      user: publicUser(
        replayStore.users.find((item) => item.id === owner.id)!
      ),
      strategyId: replayStrategy.id,
      ifMatch: prospectStrategyEtag(replayStrategy),
      idempotencyKey,
      body: { reason: "首次创建搜索运行" },
      requestId: "run-mysql-replay"
    });
    assert.equal(replay.run.id, runId);
    assert.equal(replay.idempotencyReplayed, true);
    assert.equal(
      replayStore.prospectRunShards.filter((item) => item.runId === runId)
        .length,
      1
    );
    assert.equal(
      replayStore.prospectRunEvents.filter((item) => item.runId === runId)
        .length,
      1
    );
    assert.equal(
      replayStore.prospectRunQueueParentBindings.filter(
        (item) => item.runId === runId
      ).length,
      1
    );
    assert.equal(
      replayStore.prospectRunQueueChildBindings.filter(
        (item) => item.runId === runId
      ).length,
      1
    );
    assert.equal(
      replayStore.agentJobs.filter((item) => item.aggregateId === runId)
        .length,
      2
    );

    stage = "concurrent changed request conflict";
    const changedStrategy = changedRequestStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    )!;
    await assert.rejects(
      createProspectRun({
        store: changedRequestStore,
        user: publicUser(
          changedRequestStore.users.find((item) => item.id === owner.id)!
        ),
        strategyId: changedStrategy.id,
        ifMatch: prospectStrategyEtag(changedStrategy),
        idempotencyKey,
        body: { reason: "变更后的请求内容" },
        requestId: "run-mysql-changed-request"
      }),
      (error: unknown) => error instanceof ProspectRunRequestError
        && error.status === 409
        && error.code === "IDEMPOTENCY_KEY_CONFLICT"
    );

    stage = "concurrent active duplicate conflict";
    const conflictStrategy = activeConflictStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    )!;
    await assert.rejects(
      createProspectRun({
        store: activeConflictStore,
        user: publicUser(
          activeConflictStore.users.find((item) => item.id === owner.id)!
        ),
        strategyId: conflictStrategy.id,
        ifMatch: prospectStrategyEtag(conflictStrategy),
        idempotencyKey: `run-mysql-active-${randomUUID()}`,
        body: { reason: "并发重复活动运行" },
        requestId: "run-mysql-active-conflict"
      }),
      (error: unknown) => error instanceof ProspectRunRequestError
        && error.status === 409
        && error.code === "ACTIVE_RUN_EXISTS"
    );

    stage = "verify database constraints and secret hygiene";
    const [runRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT idempotency_key_hash, status, revision_no, queue_bridge_version
       FROM \`${databaseName}\`.prospect_search_runs
       WHERE id = ?`,
      [runId]
    );
    assert.equal(runRows.length, 1);
    assert.equal(runRows[0]?.status, "queued");
    assert.equal(Number(runRows[0]?.revision_no), 1);
    assert.equal(runRows[0]?.queue_bridge_version, "v1");
    assert.match(String(runRows[0]?.idempotency_key_hash), /^[a-f0-9]{64}$/);
    assert.notEqual(runRows[0]?.idempotency_key_hash, idempotencyKey);

    const [indexRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT index_name AS indexName,
         GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columnsList
       FROM information_schema.statistics
       WHERE table_schema = ?
         AND table_name = 'prospect_search_runs'
         AND non_unique = 0
       GROUP BY index_name`,
      [databaseName]
    );
    const uniqueIndexes = new Map(
      indexRows.map((row) => [row.indexName, row.columnsList])
    );
    assert.equal(
      uniqueIndexes.get("uk_prospect_run_idempotency"),
      "team_id,created_by,operation_code,idempotency_key_hash"
    );
    assert.equal(
      uniqueIndexes.get("uk_prospect_run_active_fingerprint"),
      "active_team_id,active_owner_id,active_query_fingerprint"
    );
    const [bridgeIndexRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT table_name AS tableName, index_name AS indexName,
         GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columnsList
       FROM information_schema.statistics
       WHERE table_schema = ?
         AND non_unique = 0
         AND index_name IN (
           'uk_agent_job_queue_bridge_ref',
           'uk_prospect_run_shard_team_run_id',
           'uk_prospect_run_queue_parent_run',
           'uk_prospect_run_queue_parent_job',
           'uk_prospect_run_queue_parent_child_ref',
           'uk_prospect_run_queue_child_shard',
           'uk_prospect_run_queue_child_job'
         )
       GROUP BY table_name, index_name`,
      [databaseName]
    );
    const bridgeIndexes = new Map(
      bridgeIndexRows.map((row) => [
        `${row.tableName}.${row.indexName}`,
        row.columnsList
      ])
    );
    assert.equal(
      bridgeIndexes.get("agent_jobs.uk_agent_job_queue_bridge_ref"),
      "team_id,owner_id,id,job_type,parent_job_id"
    );
    assert.equal(
      bridgeIndexes.get(
        "prospect_run_shards.uk_prospect_run_shard_team_run_id"
      ),
      "team_id,run_id,id"
    );
    assert.equal(
      bridgeIndexes.get(
        "prospect_run_queue_parent_bindings.uk_prospect_run_queue_parent_run"
      ),
      "team_id,run_id"
    );
    assert.equal(
      bridgeIndexes.get(
        "prospect_run_queue_child_bindings.uk_prospect_run_queue_child_shard"
      ),
      "team_id,run_id,shard_id"
    );

    const [bridgeForeignKeys] = await admin.query<Array<RowDataPacket>>(
      `SELECT constraint_name AS constraintName, delete_rule AS deleteRule
       FROM information_schema.referential_constraints
       WHERE constraint_schema = ?
         AND constraint_name LIKE 'fk_prospect_run_queue_%'`,
      [databaseName]
    );
    assert.equal(bridgeForeignKeys.length, 6);
    assert.equal(
      bridgeForeignKeys.every((row) => row.deleteRule === "RESTRICT"),
      true
    );

    const [bridgeCounts] = await admin.query<Array<RowDataPacket>>(
      `SELECT
         (SELECT COUNT(*) FROM \`${databaseName}\`.
           prospect_run_queue_parent_bindings WHERE run_id = ?) AS parents,
         (SELECT COUNT(*) FROM \`${databaseName}\`.
           prospect_run_queue_child_bindings WHERE run_id = ?) AS children,
         (SELECT COUNT(*) FROM \`${databaseName}\`.
           agent_jobs WHERE aggregate_id = ?) AS jobs`,
      [runId, runId, runId]
    );
    assert.equal(Number(bridgeCounts[0]?.parents), 1);
    assert.equal(Number(bridgeCounts[0]?.children), 1);
    assert.equal(Number(bridgeCounts[0]?.jobs), 2);

    await assert.rejects(
      admin.query(
        `DELETE FROM \`${databaseName}\`.prospect_run_queue_parent_bindings
         WHERE run_id = ?`,
        [runId]
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "ER_ROW_IS_REFERENCED_2"
    );

    const [columnRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT column_name AS columnName
       FROM information_schema.columns
       WHERE table_schema = ?
         AND table_name IN (
           'prospect_search_runs',
           'prospect_run_shards',
           'prospect_run_events'
         )`,
      [databaseName]
    );
    const columns = columnRows.map((row) => String(row.columnName));
    for (const forbidden of [
      "idempotency_key",
      "credential",
      "secret",
      "cursor",
      "checkpoint"
    ]) {
      assert.equal(columns.includes(forbidden), false);
    }

    await assert.rejects(
      admin.query(
        `INSERT INTO \`${databaseName}\`.prospect_run_shards (
           id,team_id,run_id,provider_code,position_no,status,page_limit,
           result_limit,budget_limit,currency,adapter_version,contract_version,
           catalog_version,capabilities_json,access_mode,has_cursor,created_at,
           updated_at
         )
         SELECT ?,team_id,run_id,provider_code,position_no,status,page_limit,
           result_limit,budget_limit,currency,adapter_version,contract_version,
           catalog_version,capabilities_json,access_mode,has_cursor,created_at,
           updated_at
         FROM \`${databaseName}\`.prospect_run_shards
         WHERE run_id = ?`,
        [`prsh_${randomUUID()}`, runId]
      ),
      (error: unknown) => (error as { code?: string }).code === "ER_DUP_ENTRY"
    );
    await assert.rejects(
      admin.query(
        `UPDATE \`${databaseName}\`.prospect_run_shards
         SET has_cursor = TRUE WHERE run_id = ?`,
        [runId]
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "ER_CHECK_CONSTRAINT_VIOLATED"
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO \`${databaseName}\`.prospect_run_shards (
           id,team_id,run_id,provider_code,position_no,status,page_limit,
           result_limit,budget_limit,currency,adapter_version,contract_version,
           catalog_version,capabilities_json,access_mode,has_cursor,created_at,
           updated_at
         )
         SELECT ?,'cross_team',run_id,provider_code,position_no,status,
           page_limit,result_limit,budget_limit,currency,adapter_version,
           contract_version,catalog_version,capabilities_json,access_mode,
           has_cursor,created_at,updated_at
         FROM \`${databaseName}\`.prospect_run_shards
         WHERE run_id = ?`,
        [`prsh_${randomUUID()}`, runId]
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "ER_NO_REFERENCED_ROW_2"
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO \`${databaseName}\`.prospect_run_events (
           id,team_id,run_id,sequence_no,event_type,actor_id,request_id,
           from_status,to_status,from_revision,to_revision,reason,created_at
         )
         SELECT ?,'cross_team',run_id,sequence_no,event_type,actor_id,
           request_id,from_status,to_status,from_revision,to_revision,reason,
           created_at
         FROM \`${databaseName}\`.prospect_run_events
         WHERE run_id = ? AND sequence_no = 1`,
        [`pre_${randomUUID()}`, runId]
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "ER_NO_REFERENCED_ROW_2"
    );

    stage = "campaign pause and stale CAS rollback";
    const pauseStore = await createMysqlStore();
    const staleStore = await createMysqlStore();
    const pauseCampaign = pauseStore.prospectCampaigns.find(
      (item) => item.id === campaign.id
    )!;
    await transitionProspectCampaign({
      store: pauseStore,
      user: publicUser(
        pauseStore.users.find((item) => item.id === owner.id)!
      ),
      campaignId: campaign.id,
      ifMatch: prospectCampaignEtag(pauseCampaign),
      targetStatus: "paused",
      reason: "MySQL 原子暂停项目和运行",
      requestId: "run-mysql-campaign-pause"
    });
    const staleRun = staleStore.prospectSearchRuns.find(
      (item) => item.id === runId
    )!;
    await assert.rejects(
      transitionProspectRun({
        store: staleStore,
        user: publicUser(
          staleStore.users.find((item) => item.id === owner.id)!
        ),
        runId,
        ifMatch: `"${runId}:${staleRun.revision}"`,
        action: "pause",
        body: { reason: "过期实例重复暂停" },
        requestId: "run-mysql-stale-pause"
      }),
      /并发版本冲突/
    );
    const rolledBackRun = staleStore.prospectSearchRuns.find(
      (item) => item.id === runId
    )!;
    assert.equal(rolledBackRun.status, "queued");
    assert.equal(rolledBackRun.revision, 1);
    assert.equal(
      staleStore.prospectRunEvents.filter((item) => item.runId === runId)
        .length,
      1
    );

    stage = "cold restart paused state";
    const pausedStore = await createMysqlStore();
    const pausedCampaign = pausedStore.prospectCampaigns.find(
      (item) => item.id === campaign.id
    )!;
    const pausedRun = pausedStore.prospectSearchRuns.find(
      (item) => item.id === runId
    )!;
    assert.equal(pausedCampaign.status, "paused");
    assert.equal(pausedRun.status, "paused");
    assert.equal(pausedRun.revision, 2);
    assert.equal(
      pausedStore.prospectRunShards.find((item) => item.runId === runId)
        ?.status,
      "paused"
    );
    assert.equal(
      pausedStore.prospectRunEvents.filter((item) => item.runId === runId)
        .length,
      2
    );
    assert.deepEqual(
      pausedStore.agentJobs
        .filter((item) => item.aggregateId === runId)
        .map((item) => item.status),
      ["queued", "queued"]
    );

    stage = "reactivate without auto resume";
    await activateProspectCampaign({
      store: pausedStore,
      user: publicUser(
        pausedStore.users.find((item) => item.id === owner.id)!
      ),
      campaignId: campaign.id,
      ifMatch: prospectCampaignEtag(pausedCampaign),
      requestId: "run-mysql-reactivate"
    });
    assert.equal(pausedRun.status, "paused");
    await transitionProspectRun({
      store: pausedStore,
      user: publicUser(
        pausedStore.users.find((item) => item.id === owner.id)!
      ),
      runId,
      ifMatch: `"${runId}:${pausedRun.revision}"`,
      action: "resume",
      body: { reason: "人工恢复运行" },
      requestId: "run-mysql-resume"
    });
    await transitionProspectRun({
      store: pausedStore,
      user: publicUser(
        pausedStore.users.find((item) => item.id === owner.id)!
      ),
      runId,
      ifMatch: `"${runId}:${pausedRun.revision}"`,
      action: "cancel",
      body: { reason: "结束控制面测试" },
      requestId: "run-mysql-cancel"
    });

    stage = "cold restart cancelled history";
    const finalStore = await createMysqlStore();
    const finalRun = finalStore.prospectSearchRuns.find(
      (item) => item.id === runId
    )!;
    assert.equal(finalRun.status, "cancelled");
    assert.equal(finalRun.revision, 4);
    assert.equal(
      finalStore.prospectRunShards.find((item) => item.runId === runId)
        ?.status,
      "cancelled"
    );
    assert.deepEqual(
      finalStore.prospectRunEvents
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.sequence - right.sequence)
        .map((item) => item.eventType),
      ["created", "paused", "resumed", "cancelled"]
    );
    assert.deepEqual(
      finalStore.agentJobs
        .filter((item) => item.aggregateId === runId)
        .map((item) => item.status),
      ["cancelled", "cancelled"]
    );

    stage = "append-only persistence guard";
    const immutableEvent = finalStore.prospectRunEvents.find(
      (item) => item.runId === runId
    )!;
    const originalReason = immutableEvent.reason;
    immutableEvent.reason = "试图改写运行审计历史";
    await assert.rejects(
      finalStore.persist(),
      /获客搜索运行审计事件不可变历史被修改/
    );
    immutableEvent.reason = originalReason;

    stage = "snapshot tamper cold-start guard";
    await admin.query(
      `UPDATE \`${databaseName}\`.prospect_search_runs
       SET execution_snapshot_json = JSON_SET(
         execution_snapshot_json,
         '$.campaign.name',
         'tampered'
       )
       WHERE id = ?`,
      [runId]
    );
    await assert.rejects(
      createMysqlStore(),
      /获客搜索运行执行快照哈希不一致/
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.prospect_search_runs
       SET execution_snapshot_json = ? WHERE id = ?`,
      [JSON.stringify(finalRun.executionSnapshot), runId]
    );

    stage = "event-chain tamper cold-start guard";
    const createdEvent = finalStore.prospectRunEvents
      .filter((item) => item.runId === runId)
      .sort((left, right) => left.sequence - right.sequence)[0]!;
    await admin.query(
      `UPDATE \`${databaseName}\`.prospect_run_events
       SET event_type = 'paused' WHERE id = ?`,
      [createdEvent.id]
    );
    await assert.rejects(
      createMysqlStore(),
      /revision 与首个审计事件不一致/
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.prospect_run_events
       SET event_type = 'created' WHERE id = ?`,
      [createdEvent.id]
    );

    stage = "queue bridge binding tamper cold-start guard";
    const parentBinding = finalStore.prospectRunQueueParentBindings.find(
      (item) => item.runId === runId
    )!;
    await admin.query(
      `UPDATE \`${databaseName}\`.prospect_run_queue_parent_bindings
       SET binding_hash = ? WHERE id = ?`,
      ["0".repeat(64), parentBinding.id]
    );
    await assert.rejects(
      createMysqlStore(),
      /父桥接绑定完整性校验失败/
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.prospect_run_queue_parent_bindings
       SET binding_hash = ? WHERE id = ?`,
      [parentBinding.bindingHash, parentBinding.id]
    );

    stage = "queue bridge job digest tamper cold-start guard";
    const parentJob = finalStore.agentJobs.find(
      (item) => item.id === parentBinding.jobId
    )!;
    await admin.query(
      `UPDATE \`${databaseName}\`.agent_jobs
       SET idempotency_key = ? WHERE id = ?`,
      ["0".repeat(64), parentJob.id]
    );
    await assert.rejects(
      createMysqlStore(),
      /任务字段完整性校验失败/
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.agent_jobs
       SET idempotency_key = ? WHERE id = ?`,
      [parentJob.idempotencyKey, parentJob.id]
    );

    stage = "orphan reserved job cold-start guard";
    const orphanJobId = `aj_${randomUUID()}`;
    const orphanIdempotencyKey = randomUUID()
      .replaceAll("-", "")
      .repeat(2);
    await admin.query(
      `INSERT INTO \`${databaseName}\`.agent_jobs (
         id,team_id,owner_id,job_type,aggregate_type,aggregate_id,
         parent_job_id,status,priority,idempotency_key,policy_version,
         input_json_encrypted,output_json_encrypted,attempt_count,max_attempts,
         next_attempt_at,error_code,error_message,trace_id,started_at,
         finished_at,created_at
       )
       SELECT ?,team_id,owner_id,job_type,aggregate_type,aggregate_id,
         parent_job_id,status,priority,?,policy_version,input_json_encrypted,
         output_json_encrypted,attempt_count,max_attempts,next_attempt_at,
         error_code,error_message,CONCAT('trace_', ?),started_at,finished_at,
         created_at
       FROM \`${databaseName}\`.agent_jobs
       WHERE aggregate_id = ? AND job_type = 'prospect.orchestrate'`,
      [orphanJobId, orphanIdempotencyKey, randomUUID(), runId]
    );
    await assert.rejects(
      createMysqlStore(),
      /未绑定搜索运行的桥接任务/
    );
    await admin.query(
      `DELETE FROM \`${databaseName}\`.agent_jobs WHERE id = ?`,
      [orphanJobId]
    );

    stage = "final valid cold restart";
    const verifiedStore = await createMysqlStore();
    assert.equal(
      verifiedStore.prospectSearchRuns.find((item) => item.id === runId)
        ?.status,
      "cancelled"
    );
    console.log(
      "Prospect Run MySQL schema, cold restart, conflict recovery, CAS, isolation and tamper tests passed"
    );
    exitCode = 0;
  } catch (error) {
    console.error(`Prospect Run MySQL test failed at: ${stage}`);
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
