import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { publicUser } from "./auth.js";
import { createMysqlStore } from "./mysql-store.js";
import {
  createProspectCampaign,
  createProspectCampaignVersion,
  prospectCampaignEtag,
  prospectCampaignSnapshotHash
} from "./prospect-campaigns.js";
import { prospectStrategyFingerprint } from "./prospect-strategies.js";
import type { AgentJob, ProspectCampaignVersion } from "./types.js";

function connectionOptions(databaseUrl: URL) {
  return {
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password)
  };
}

const fullSnapshot = {
  goal: "开发公开资料可验证的工业照明进口商",
  products: ["LED flood light"],
  markets: ["Germany"],
  customerTypes: ["Importer"],
  applicationScenarios: ["Warehouse and outdoor project lighting"],
  icpRules: ["Has a public industrial lighting catalog"],
  exclusionRules: ["Consumer-only retailer"],
  sourceProviderIds: ["un_comtrade"]
};

async function main() {
  const configuredUrl = process.env.MYSQL_TEST_ADMIN_URL
    || process.env.DATABASE_URL
    || process.env.MYSQL_URL;
  if (!configuredUrl) {
    throw new Error(
      "Prospect Campaign MySQL test requires MYSQL_TEST_ADMIN_URL, DATABASE_URL or MYSQL_URL"
    );
  }

  const adminUrl = new URL(configuredUrl);
  const databaseName = `goodjob_campaign_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let databaseCreated = false;
  let exitCode = 1;

  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    databaseCreated = true;
    const testUrl = new URL(configuredUrl);
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();
    delete process.env.MYSQL_URL;

    const firstStore = await createMysqlStore();
    const owner = firstStore.users.find((item) => item.id === "u_sales_shirley");
    assert.ok(owner);
    const session = publicUser(owner);

    const created = await createProspectCampaign({
      store: firstStore,
      user: session,
      body: { name: "德国工业照明获客项目" },
      requestId: "mysql-campaign-create"
    });
    const campaignId = created.campaign.id;
    assert.match(
      campaignId,
      /^pc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    assert.equal(created.campaign.currentVersion, 1);
    assert.equal(created.versions.length, 1);
    assert.equal(created.events.length, 1);

    const secondStore = await createMysqlStore();
    const reloadedDraft = secondStore.prospectCampaigns.find(
      (item) => item.id === campaignId
    );
    assert.ok(reloadedDraft);
    assert.equal(reloadedDraft.name, "德国工业照明获客项目");
    assert.equal(reloadedDraft.currentVersion, 1);
    assert.equal(
      secondStore.prospectCampaignVersions.filter(
        (item) => item.campaignId === campaignId
      ).length,
      1
    );
    assert.equal(
      secondStore.prospectCampaignEvents.filter(
        (item) => item.campaignId === campaignId
      ).length,
      1
    );

    const versioned = await createProspectCampaignVersion({
      store: secondStore,
      user: publicUser(
        secondStore.users.find((item) => item.id === owner.id)!
      ),
      campaignId,
      ifMatch: prospectCampaignEtag(reloadedDraft),
      body: {
        snapshot: fullSnapshot,
        changeSummary: "补齐首版 ICP 与排除规则"
      },
      requestId: "mysql-campaign-version-2"
    });
    assert.equal(versioned.created, true);
    assert.equal(versioned.campaign.currentVersion, 2);
    assert.equal(versioned.campaign.revision, 2);

    const thirdStore = await createMysqlStore();
    const reloadedVersioned = thirdStore.prospectCampaigns.find(
      (item) => item.id === campaignId
    );
    assert.ok(reloadedVersioned);
    assert.equal(reloadedVersioned.currentVersion, 2);
    const persistedVersions = thirdStore.prospectCampaignVersions
      .filter((item) => item.campaignId === campaignId)
      .sort((left, right) => left.version - right.version);
    assert.equal(persistedVersions.length, 2);
    assert.deepEqual(persistedVersions[1]?.snapshot, fullSnapshot);
    assert.equal(
      persistedVersions[1]?.contentHash,
      prospectCampaignSnapshotHash(fullSnapshot)
    );
    assert.equal(
      thirdStore.prospectCampaignEvents.filter(
        (item) => item.campaignId === campaignId
      ).length,
      2
    );

    const persistedVersion = persistedVersions[0]!;
    const originalVersion = structuredClone(persistedVersion);
    const linkedStrategy = thirdStore.prospectStrategies.find(
      (item) =>
        item.campaignId === campaignId
        && item.campaignVersion === persistedVersion.version
    )!;
    const originalStrategyFingerprint = linkedStrategy.queryFingerprint;
    persistedVersion.snapshot.goal = "试图改写不可变历史";
    persistedVersion.contentHash = prospectCampaignSnapshotHash(
      persistedVersion.snapshot
    );
    linkedStrategy.queryFingerprint = prospectStrategyFingerprint({
      version: persistedVersion,
      query: linkedStrategy.query,
      providerPlan: linkedStrategy.providerPlan
    });
    await assert.rejects(
      thirdStore.persist(),
      /获客项目版本不可变历史被删除或修改/
    );
    Object.assign(persistedVersion, originalVersion);
    linkedStrategy.queryFingerprint = originalStrategyFingerprint;

    const campaign = thirdStore.prospectCampaigns.find(
      (item) => item.id === campaignId
    )!;
    const originalCurrentVersion = campaign.currentVersion;
    campaign.currentVersion = 99;
    await assert.rejects(
      thirdStore.persist(),
      /获客项目当前版本指针无效/
    );
    campaign.currentVersion = originalCurrentVersion;

    const malformedVersion = structuredClone(
      persistedVersions[1]!
    ) as ProspectCampaignVersion;
    malformedVersion.id = `pcv_${randomUUID()}`;
    malformedVersion.version = 3;
    malformedVersion.contentHash = "0".repeat(64);
    thirdStore.prospectCampaignVersions.push(malformedVersion);
    await assert.rejects(
      thirdStore.persist(),
      /获客项目版本快照或内容哈希不一致/
    );
    thirdStore.prospectCampaignVersions.pop();

    const formalNamespaceJob: AgentJob = {
      id: `job_${randomUUID()}`,
      teamId: owner.teamId,
      ownerId: owner.id,
      jobType: "prospect.market_analysis",
      aggregateType: "prospect_campaign_ref_compat_v1",
      aggregateId: `pc_${randomUUID()}`,
      parentJobId: "",
      status: "queued",
      priority: 0,
      idempotencyKey: `campaign-mysql-namespace-${randomUUID()}`,
      policyVersion: "test",
      inputJsonEncrypted: "test",
      outputJsonEncrypted: "",
      attemptCount: 0,
      maxAttempts: 1,
      nextAttemptAt: "",
      errorCode: "",
      errorMessage: "",
      traceId: `trace_${randomUUID()}`,
      startedAt: "",
      finishedAt: "",
      createdAt: new Date().toISOString()
    };
    thirdStore.agentJobs.push(formalNamespaceJob);
    await assert.rejects(
      thirdStore.persist(),
      /pc_ 正式命名空间中的旧兼容市场数据/
    );
    thirdStore.agentJobs.pop();

    const invalidExistingVersion = structuredClone(
      persistedVersions[1]!
    ) as ProspectCampaignVersion;
    invalidExistingVersion.id = `pcv_${randomUUID()}`;
    invalidExistingVersion.version = 3;
    invalidExistingVersion.contentHash = "f".repeat(64);
    thirdStore.prospectCampaignVersions.push(invalidExistingVersion);
    const campaignCountBeforeRollback = thirdStore.prospectCampaigns.length;
    const eventCountBeforeRollback = thirdStore.prospectCampaignEvents.length;
    await assert.rejects(
      createProspectCampaign({
        store: thirdStore,
        user: publicUser(
          thirdStore.users.find((item) => item.id === owner.id)!
        ),
        body: { name: "必须回滚的项目" },
        requestId: "mysql-campaign-rollback"
      }),
      /获客项目版本快照或内容哈希不一致/
    );
    assert.equal(thirdStore.prospectCampaigns.length, campaignCountBeforeRollback);
    assert.equal(thirdStore.prospectCampaignEvents.length, eventCountBeforeRollback);
    assert.equal(
      thirdStore.prospectCampaigns.some((item) => item.name === "必须回滚的项目"),
      false
    );
    thirdStore.prospectCampaignVersions.pop();

    await thirdStore.persist();
    const [campaignRows] = await admin.query<Array<RowDataPacket>>(
      `SELECT id, current_version, revision_no
       FROM \`${databaseName}\`.prospect_campaigns WHERE id = ?`,
      [campaignId]
    );
    assert.equal(campaignRows.length, 1);
    assert.equal(Number(campaignRows[0]?.current_version), 2);
    assert.equal(Number(campaignRows[0]?.revision_no), 2);

    const finalStore = await createMysqlStore();
    assert.equal(
      finalStore.prospectCampaignVersions.filter(
        (item) => item.campaignId === campaignId
      ).length,
      2
    );
    assert.equal(
      finalStore.prospectCampaignEvents.filter(
        (item) => item.campaignId === campaignId
      ).length,
      2
    );

    console.log(
      "Prospect Campaign MySQL cold restart, append-only, rollback and validation tests passed"
    );
    exitCode = 0;
  } catch (error) {
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
