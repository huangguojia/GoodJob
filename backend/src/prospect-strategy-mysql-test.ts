import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { publicUser } from "./auth.js";
import {
  activateProspectCampaign,
  createProspectCampaign,
  prospectCampaignEtag,
  updateProspectCampaign
} from "./prospect-campaigns.js";
import { createMysqlStore } from "./mysql-store.js";
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

const fullSnapshot = {
  goal: "开发公开资料可核验的德国照明进口商",
  products: ["LED flood light"],
  markets: ["Germany"],
  customerTypes: ["Importer"],
  applicationScenarios: ["Warehouse project"],
  icpRules: [],
  exclusionRules: [],
  sourceProviderIds: ["gleif"]
};

async function main() {
  const configuredUrl = process.env.MYSQL_TEST_ADMIN_URL
    || process.env.DATABASE_URL
    || process.env.MYSQL_URL;
  if (!configuredUrl) {
    throw new Error(
      "Prospect Strategy MySQL test requires MYSQL_TEST_ADMIN_URL, DATABASE_URL or MYSQL_URL"
    );
  }

  const adminUrl = new URL(configuredUrl);
  const databaseName = `goodjob_strategy_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let databaseCreated = false;
  let exitCode = 1;
  let stage = "create database";

  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    databaseCreated = true;
    const testUrl = new URL(configuredUrl);
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();
    delete process.env.MYSQL_URL;

    stage = "create first store";
    const firstStore = await createMysqlStore();
    const owner = firstStore.users.find(
      (item) => item.id === "u_sales_shirley"
    );
    const nextOwner = firstStore.users.find(
      (item) => item.id === "u_sales_mia"
    );
    const manager = firstStore.users.find(
      (item) => item.id === "u_manager_alex"
    );
    assert.ok(owner);
    assert.ok(nextOwner);
    assert.ok(manager);

    stage = "create campaign and default strategy";
    const created = await createProspectCampaign({
      store: firstStore,
      user: publicUser(owner),
      body: {
        name: "MySQL 搜索策略项目",
        snapshot: fullSnapshot
      },
      requestId: "strategy-mysql-create"
    });
    const campaignId = created.campaign.id;
    const strategy = firstStore.prospectStrategies.find(
      (item) => item.campaignId === campaignId
    );
    assert.ok(strategy);
    assert.match(
      strategy.id,
      /^ps_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    assert.equal(strategy.revision, 1);
    assert.equal(firstStore.prospectStrategyEvents.length, 1);

    stage = "first cold restart";
    const secondStore = await createMysqlStore();
    const reloadedCampaign = secondStore.prospectCampaigns.find(
      (item) => item.id === campaignId
    );
    const reloadedStrategy = secondStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    );
    assert.ok(reloadedCampaign);
    assert.ok(reloadedStrategy);
    assert.deepEqual(reloadedStrategy.query.positiveKeywords, []);
    assert.equal(reloadedStrategy.queryFingerprint.length, 64);
    assert.equal(
      secondStore.prospectStrategyEvents.filter(
        (item) => item.strategyId === strategy.id
      ).length,
      1
    );

    stage = "update strategy";
    const updated = await updateProspectStrategy({
      store: secondStore,
      user: publicUser(
        secondStore.users.find((item) => item.id === owner.id)!
      ),
      strategyId: reloadedStrategy.id,
      ifMatch: prospectStrategyEtag(reloadedStrategy),
      body: {
        providerPlan: [{
          providerId: "gleif",
          priority: 20,
          pageLimit: 3,
          resultLimit: 100,
          budgetLimit: null,
          currency: ""
        }],
        query: {
          synonyms: ["industrial floodlight"]
        },
        reason: "补全免费数据源"
      },
      requestId: "strategy-mysql-update"
    });
    stage = "approve strategy";
    const approved = await approveProspectStrategy({
      store: secondStore,
      user: publicUser(
        secondStore.users.find((item) => item.id === owner.id)!
      ),
      strategyId: reloadedStrategy.id,
      ifMatch: prospectStrategyEtag(updated.strategy),
      reason: "MySQL 审批",
      requestId: "strategy-mysql-approve"
    });
    assert.equal(approved.strategy.status, "approved");

    stage = "activate campaign";
    const activated = await activateProspectCampaign({
      store: secondStore,
      user: publicUser(
        secondStore.users.find((item) => item.id === owner.id)!
      ),
      campaignId,
      ifMatch: prospectCampaignEtag(reloadedCampaign),
      requestId: "strategy-mysql-activate"
    });
    assert.equal(activated.campaign.status, "active");

    stage = "second cold restart";
    const thirdStore = await createMysqlStore();
    const persistedCampaign = thirdStore.prospectCampaigns.find(
      (item) => item.id === campaignId
    );
    const persistedStrategy = thirdStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    );
    assert.ok(persistedCampaign);
    assert.ok(persistedStrategy);
    assert.equal(persistedCampaign.status, "active");
    assert.equal(persistedStrategy.status, "approved");
    assert.equal(persistedStrategy.revision, 3);
    assert.equal(
      thirdStore.prospectStrategyEvents.filter(
        (item) => item.strategyId === strategy.id
      ).length,
      3
    );

    const strategyRevisionBeforeTransfer = persistedStrategy.revision;
    stage = "transfer owner";
    await updateProspectCampaign({
      store: thirdStore,
      user: publicUser(
        thirdStore.users.find((item) => item.id === manager.id)!
      ),
      campaignId,
      ifMatch: prospectCampaignEtag(persistedCampaign),
      body: {
        ownerId: nextOwner.id,
        reason: "MySQL 负责人转交"
      },
      requestId: "strategy-mysql-transfer"
    });
    assert.equal(persistedStrategy.ownerId, nextOwner.id);
    assert.equal(persistedStrategy.revision, strategyRevisionBeforeTransfer + 1);

    stage = "third cold restart";
    const fourthStore = await createMysqlStore();
    const transferredStrategy = fourthStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    );
    assert.ok(transferredStrategy);
    assert.equal(transferredStrategy.ownerId, nextOwner.id);
    assert.equal(transferredStrategy.revision, 4);
    assert.equal(
      fourthStore.prospectStrategyEvents.filter(
        (item) => item.strategyId === strategy.id
      ).length,
      4
    );

    const originalFingerprint = transferredStrategy.queryFingerprint;
    transferredStrategy.queryFingerprint = "0".repeat(64);
    await assert.rejects(
      fourthStore.persist(),
      /获客搜索策略规范化内容或查询指纹不一致/
    );
    transferredStrategy.queryFingerprint = originalFingerprint;

    const persistedEvent = fourthStore.prospectStrategyEvents.find(
      (item) => item.strategyId === strategy.id
    )!;
    const originalReason = persistedEvent.reason;
    persistedEvent.reason = "试图改写审计历史";
    await assert.rejects(
      fourthStore.persist(),
      /获客搜索策略审计事件不可变历史被删除或修改/
    );
    persistedEvent.reason = originalReason;

    const campaignCountBeforeRollback = fourthStore.prospectCampaigns.length;
    const strategyCountBeforeRollback = fourthStore.prospectStrategies.length;
    transferredStrategy.queryFingerprint = "f".repeat(64);
    await assert.rejects(
      createProspectCampaign({
        store: fourthStore,
        user: publicUser(
          fourthStore.users.find((item) => item.id === owner.id)!
        ),
        body: {
          name: "必须整体回滚的策略项目",
          snapshot: fullSnapshot
        },
        requestId: "strategy-mysql-rollback"
      }),
      /获客搜索策略规范化内容或查询指纹不一致/
    );
    assert.equal(
      fourthStore.prospectCampaigns.length,
      campaignCountBeforeRollback
    );
    assert.equal(
      fourthStore.prospectStrategies.length,
      strategyCountBeforeRollback
    );
    assert.equal(
      fourthStore.prospectCampaigns.some(
        (item) => item.name === "必须整体回滚的策略项目"
      ),
      false
    );
    fourthStore.prospectStrategies.find(
      (item) => item.id === strategy.id
    )!.queryFingerprint = originalFingerprint;
    stage = "final valid persist";
    await fourthStore.persist();

    const [strategyRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT owner_id, status, revision_no, query_fingerprint
       FROM \`${databaseName}\`.prospect_strategies WHERE id = ?`,
      [strategy.id]
    );
    assert.equal(strategyRows.length, 1);
    assert.equal(strategyRows[0]?.owner_id, nextOwner.id);
    assert.equal(strategyRows[0]?.status, "approved");
    assert.equal(Number(strategyRows[0]?.revision_no), 4);
    assert.equal(strategyRows[0]?.query_fingerprint, originalFingerprint);

    const [eventRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT COUNT(*) AS total
       FROM \`${databaseName}\`.prospect_strategy_events
       WHERE strategy_id = ?`,
      [strategy.id]
    );
    assert.equal(Number(eventRows[0]?.total), 4);

    console.log(
      "Prospect strategy MySQL cold restart, activation, transfer, append-only and rollback tests passed"
    );
    exitCode = 0;
  } catch (error) {
    console.error(`Prospect strategy MySQL test failed at: ${stage}`);
    console.error(error);
  } finally {
    if (databaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    }
    await admin.end();
    process.exit(exitCode);
  }
}

await main();
