import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import {
  attachAgentJobIdempotencyAlias,
  enqueueAgentJob,
  findAgentJobByIdempotency,
  startAgentJob
} from "./agent-jobs.js";
import { materializeMarketOpportunityFacts } from "./market-opportunity-facts.js";
import { upsertMarketTradeObservations } from "./market-trade-observations.js";
import { createMysqlStore, createSerializedPersistence } from "./mysql-store.js";
import { readProviderResponseCache, writeProviderResponseCache } from "./provider-response-cache.js";
import { providerRequestFingerprint } from "./provider-request-logging.js";
import { buildProspectVerificationReport } from "./prospect-verification.js";
import { setStore } from "./store.js";
import type { TradeObservation } from "./provider-contract.js";
import type {
  ProviderEvidenceSnapshot,
  ProviderRequestLog,
  User,
  WebsiteOpportunity
} from "./types.js";

function connectionOptions(databaseUrl: URL) {
  return {
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password)
  };
}

async function main() {
  const configuredUrl = process.env.MYSQL_TEST_ADMIN_URL
    || process.env.DATABASE_URL
    || process.env.MYSQL_URL;
  if (!configuredUrl) {
    throw new Error("Provider MySQL persistence test requires MYSQL_TEST_ADMIN_URL, DATABASE_URL or MYSQL_URL");
  }

  const adminUrl = new URL(configuredUrl);
  const databaseName = `goodjob_provider_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let exitCode = 1;
  let databaseCreated = false;

  try {
    const queuedAliases = ["alias-that-must-roll-back"];
    let persistedAliases: string[] = [];
    let releaseFailedPersistence!: () => void;
    let markFailedPersistenceStarted!: () => void;
    const failedPersistenceGate = new Promise<void>((resolve) => {
      releaseFailedPersistence = resolve;
    });
    const failedPersistenceStarted = new Promise<void>((resolve) => {
      markFailedPersistenceStarted = resolve;
    });
    let persistenceRuns = 0;
    let activePersistenceRuns = 0;
    let maximumConcurrentPersistenceRuns = 0;
    const serializedPersist = createSerializedPersistence(
      () => [...queuedAliases],
      async (snapshot) => {
        persistenceRuns += 1;
        activePersistenceRuns += 1;
        maximumConcurrentPersistenceRuns = Math.max(
          maximumConcurrentPersistenceRuns,
          activePersistenceRuns
        );
        try {
          if (persistenceRuns === 1) {
            markFailedPersistenceStarted();
            await failedPersistenceGate;
            throw new Error("simulated queued persistence failure");
          }
          persistedAliases = snapshot;
        } finally {
          activePersistenceRuns -= 1;
        }
      }
    );
    const failedPersistence = serializedPersist();
    await failedPersistenceStarted;
    queuedAliases.splice(0, queuedAliases.length);
    const recoveryPersistence = serializedPersist();
    releaseFailedPersistence();
    await assert.rejects(
      failedPersistence,
      /simulated queued persistence failure/
    );
    await recoveryPersistence;
    assert.equal(maximumConcurrentPersistenceRuns, 1);
    assert.equal(persistenceRuns, 2);
    assert.deepEqual(
      persistedAliases,
      [],
      "失败持久化的别名快照不能在后续队列任务中复活"
    );

    await admin.query(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    databaseCreated = true;
    const testUrl = new URL(configuredUrl);
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();
    delete process.env.MYSQL_URL;

    const evidence: ProviderEvidenceSnapshot = {
      providerId: "persistence_test",
      providerRecordId: "record-001",
      officialWebsite: "https://example.test/",
      sourceUrl: "https://registry.example.test/record-001",
      recordType: "identity_evidence",
      fetchedAt: "2026-07-13T08:00:00.000Z",
      payloadHash: "a".repeat(64),
      evidenceSummary: "脱敏企业登记证据",
      matchedFields: ["company", "officialWebsite"],
      adapterVersion: "1.0.0",
      catalogPolicyVersion: "policy-1",
      sourceLevel: "identity",
      retentionPolicyRef: "provider_terms"
    };
    const opportunity: WebsiteOpportunity = {
      id: `provider_persistence_${randomUUID()}`,
      company: "脱敏测试企业",
      business: "工业零部件",
      country: "测试国家",
      website: "https://example.test/",
      contact: "待维护",
      contactInfo: "",
      description: "Provider 来源证据持久化测试",
      ownerId: "u_sales_shirley",
      teamId: "europe",
      status: "preview",
      source: "persistence_test",
      sourceLabel: "Persistence Test",
      sourceEvidence: [evidence],
      createdAt: "2026-07-13T08:00:00.000Z"
    };
    opportunity.verificationReport = buildProspectVerificationReport(
      opportunity,
      "2026-07-13T08:00:00.000Z"
    );
    const aiConfigId = `ai_persistence_${randomUUID()}`;
    const aiSecret = "mysql-ai-secret-7788";
    const cacheKey = {
      providerId: "un_comtrade",
      providerVersion: "1.0.0",
      requestFingerprint: providerRequestFingerprint({
        reporterCodes: ["842"],
        partnerCodes: ["0"],
        flow: "import",
        commodityCodes: ["940542"],
        periods: ["2023"]
      }),
      licenseScope: "public_api"
    };
    const cachePayload = {
      observations: [{
        reporterCountry: "USA",
        partnerCountry: "WORLD",
        commodityCode: "940542",
        period: "2023",
        tradeValueUsd: 2061149344
      }]
    };
    const teamBUser: User = {
      id: `trade_team_b_${randomUUID()}`,
      name: "Trade Team B",
      email: `trade-team-b-${randomUUID()}@example.test`,
      password: "test-only",
      role: "sales",
      teamId: "trade_team_b",
      avatar: "TB",
      status: "active",
      authVersion: 1
    };
    const teamASecondUser: User = {
      id: `trade_team_a_second_${randomUUID()}`,
      name: "Trade Team A Second",
      email: `trade-team-a-second-${randomUUID()}@example.test`,
      password: "test-only",
      role: "sales",
      teamId: "europe",
      avatar: "TA",
      status: "active",
      authVersion: 1
    };
    const baseTradeObservation: TradeObservation = {
      reporterCountry: "USA",
      partnerCountry: "WORLD",
      reporterCode: "842",
      partnerCode: "0",
      tradeFlow: "IMPORT",
      classification: "HS2022",
      requestedClassification: "HS2022",
      commodityCode: "940542",
      commodityDescription: "Other electric lamps and lighting fittings",
      period: "2023",
      tradeValueUsd: 1000000,
      netWeightKg: 12000,
      quantity: 12000,
      quantityUnit: "kg",
      isAggregate: true,
      suppressed: false,
      statusFlags: [],
      sourceRevision: "2026-07-12",
      providerRecordId: "un-comtrade:mysql-record-001",
      fetchedAt: "2026-07-13T08:00:00.000Z",
      payloadHash: "c".repeat(64),
      adapterVersion: "1.0.0"
    };

    await createMysqlStore();
    await admin.query(
      `ALTER TABLE \`${databaseName}\`.agent_jobs
       DROP INDEX uk_agent_job_idempotency,
       ADD INDEX uk_agent_job_idempotency(team_id, job_type, idempotency_key)`
    );
    await admin.query(
      `ALTER TABLE \`${databaseName}\`.agent_job_idempotency_aliases
       DROP INDEX uk_agent_job_alias_idempotency,
       ADD INDEX uk_agent_job_alias_idempotency(team_id, job_type, idempotency_key)`
    );
    await admin.query(
      `ALTER TABLE \`${databaseName}\`.provider_response_cache
       DROP INDEX uk_provider_response_cache,
       ADD UNIQUE KEY uk_provider_response_cache(provider_id, provider_version, request_fingerprint)`
    );
    await admin.query(
      `ALTER TABLE \`${databaseName}\`.provider_request_logs
       MODIFY COLUMN requested_at DATETIME NOT NULL`
    );
    await admin.query(
      `ALTER TABLE \`${databaseName}\`.market_trade_observations DROP INDEX uk_market_trade_observation`
    );
    await admin.query(
      `ALTER TABLE \`${databaseName}\`.market_trade_observations
       ADD UNIQUE KEY uk_market_trade_observation(
         team_id,
         campaign_id,
         provider_id,
         reporter_country,
         partner_country,
         trade_flow,
         classification,
         commodity_code,
         period_value
       )`
    );
    await admin.query(
      `ALTER TABLE \`${databaseName}\`.market_trade_observations
       DROP COLUMN reporter_code,
       DROP COLUMN partner_code,
       DROP COLUMN commodity_description,
       DROP COLUMN source_revision`
    );
    const firstStart = await createMysqlStore();
    setStore(firstStart);
    firstStart.users.push(teamASecondUser, teamBUser);
    const millisecondRequestLog: ProviderRequestLog = {
      id: `prl_millisecond_${randomUUID()}`,
      teamId: "europe",
      ownerId: "u_sales_shirley",
      providerId: "usaspending_awards",
      connectionId: "",
      runId: `prun_millisecond_${randomUUID()}`,
      runShardId: `prsh_millisecond_${randomUUID()}`,
      requestFingerprint: "b".repeat(64),
      endpointCode: "search_spending_by_award",
      httpStatus: 200,
      attempt: 1,
      quotaUnits: 1,
      costAmount: 0,
      currency: "",
      durationMs: 6789,
      responseSize: 1024,
      errorCode: "",
      requestedAt: "2026-07-16T08:09:10.789Z"
    };
    const interruptedMarketAnalysisPrimaryKey = `mysql-interrupted-market-analysis-${randomUUID()}`;
    const interruptedMarketAnalysisAliasKey = `mysql-interrupted-market-analysis-alias-${randomUUID()}`;
    const interruptedMarketAnalysisJob = enqueueAgentJob(firstStart, {
      teamId: "europe",
      ownerId: "u_sales_shirley",
      jobType: "prospect.market_analysis",
      aggregateType: "prospect_campaign_ref_compat_v1",
      aggregateId: "mysql_interrupted_campaign",
      idempotencyKey: interruptedMarketAnalysisPrimaryKey,
      input: {
        campaignId: "mysql_interrupted_campaign",
        providerId: "un_comtrade",
        requestFingerprint: "mysql-interrupted-fingerprint",
        query: {
          reporterCodes: ["842"],
          partnerCodes: ["0"],
          flow: "import",
          hsVersion: "HS2022",
          commodityCodes: ["940542"],
          periods: ["2023"],
          frequency: "annual",
          limit: 5
        }
      }
    }).job;
    const interruptedAlias = attachAgentJobIdempotencyAlias(
      firstStart,
      interruptedMarketAnalysisJob,
      interruptedMarketAnalysisAliasKey
    ).alias;
    assert.ok(interruptedAlias);
    startAgentJob(interruptedMarketAnalysisJob);
    const tradeTeamAFirst = await upsertMarketTradeObservations(firstStart, {
      teamId: "europe",
      ownerId: "u_sales_shirley",
      campaignId: "mysql_trade_campaign",
      providerId: "un_comtrade",
      observations: [
        baseTradeObservation,
        {
          ...baseTradeObservation,
          reporterCountry: "R".repeat(100),
          partnerCountry: "P".repeat(100),
          classification: "C".repeat(40),
          commodityCode: "940549",
          tradeValueUsd: null,
          netWeightKg: null,
          quantity: null,
          quantityUnit: null,
          suppressed: true,
          statusFlags: ["SUPPRESSED"],
          providerRecordId: "un-comtrade:mysql-record-002",
          payloadHash: "d".repeat(64)
        }
      ]
    });
    assert.equal(tradeTeamAFirst.createdCount, 2);
    const firstTradeId = tradeTeamAFirst.observations.find(
      (item) => item.commodityCode === "940542"
    )!.id;
    const firstTradeCreatedAt = tradeTeamAFirst.observations.find(
      (item) => item.commodityCode === "940542"
    )!.createdAt;
    const tradeTeamARepeated = await upsertMarketTradeObservations(firstStart, {
      teamId: "europe",
      ownerId: "u_sales_shirley",
      campaignId: "mysql_trade_campaign",
      providerId: "un_comtrade",
      observations: [{
        ...baseTradeObservation,
        reporterCountry: "usa",
        partnerCountry: "world",
        classification: "hs2022",
        tradeValueUsd: 1500000,
        statusFlags: ["REVISED"],
        fetchedAt: "2026-07-13T09:00:00.000Z",
        payloadHash: "e".repeat(64)
      }]
    });
    assert.equal(tradeTeamARepeated.createdCount, 0);
    assert.equal(tradeTeamARepeated.updatedCount, 1);
    assert.equal(tradeTeamARepeated.observations[0]?.id, firstTradeId);
    assert.equal(tradeTeamARepeated.observations[0]?.createdAt, firstTradeCreatedAt);
    const tradeTeamASecondOwner = await upsertMarketTradeObservations(firstStart, {
      teamId: "europe",
      ownerId: teamASecondUser.id,
      campaignId: "mysql_trade_campaign",
      providerId: "un_comtrade",
      observations: [{ ...baseTradeObservation, tradeValueUsd: 2250000 }]
    });
    assert.equal(tradeTeamASecondOwner.createdCount, 1);
    assert.equal(tradeTeamASecondOwner.updatedCount, 0);
    assert.notEqual(tradeTeamASecondOwner.observations[0]?.id, firstTradeId);
    const tradeTeamB = await upsertMarketTradeObservations(firstStart, {
      teamId: "trade_team_b",
      ownerId: teamBUser.id,
      campaignId: "mysql_trade_campaign",
      providerId: "un_comtrade",
      observations: [{ ...baseTradeObservation, tradeValueUsd: 2750000 }]
    });
    assert.equal(tradeTeamB.createdCount, 1);
    assert.equal(firstStart.marketTradeObservations.length, 4);

    const marketCampaignId = "mysql_market_opportunity_campaign";
    const marketFactJob = enqueueAgentJob(firstStart, {
      teamId: "europe",
      ownerId: "u_sales_shirley",
      jobType: "prospect.market_analysis",
      aggregateType: "prospect_campaign_ref_compat_v1",
      aggregateId: marketCampaignId,
      idempotencyKey: `mysql-market-facts-${randomUUID()}`,
      input: {
        campaignId: marketCampaignId,
        providerId: "un_comtrade",
        requestFingerprint: "mysql-market-facts-fingerprint",
        query: {
          reporterCodes: ["842"],
          partnerCodes: ["0", "156"],
          flow: "import",
          hsVersion: "HS2022",
          commodityCodes: ["940542"],
          periods: ["2022", "2023", "2024"],
          frequency: "annual",
          limit: 20
        }
      }
    }).job;
    const marketSource = await upsertMarketTradeObservations(firstStart, {
      teamId: "europe",
      ownerId: "u_sales_shirley",
      campaignId: marketCampaignId,
      providerId: "un_comtrade",
      observations: [
        {
          ...baseTradeObservation,
          period: "2022",
          tradeValueUsd: 100,
          providerRecordId: "un-comtrade:mysql-market-world-2022",
          payloadHash: "1".repeat(64)
        },
        {
          ...baseTradeObservation,
          period: "2023",
          tradeValueUsd: 120,
          providerRecordId: "un-comtrade:mysql-market-world-2023",
          payloadHash: "2".repeat(64)
        },
        {
          ...baseTradeObservation,
          period: "2024",
          tradeValueUsd: 144,
          providerRecordId: "un-comtrade:mysql-market-world-2024",
          payloadHash: "3".repeat(64)
        },
        {
          ...baseTradeObservation,
          partnerCountry: "China",
          partnerCode: "156",
          period: "2024",
          tradeValueUsd: 72,
          isAggregate: false,
          providerRecordId: "un-comtrade:mysql-market-china-2024",
          payloadHash: "4".repeat(64)
        }
      ]
    });
    assert.equal(marketSource.createdCount, 4);
    const marketFacts = await firstStart.persistMutation!(() => {
      const beforeBatchCount = firstStart.marketOpportunityBatches.length;
      const beforeSnapshotCount = firstStart.marketOpportunitySnapshots.length;
      const beforeEventCount = firstStart.marketOpportunityCalculationEvents.length;
      const value = materializeMarketOpportunityFacts(firstStart, {
        teamId: "europe",
        ownerId: "u_sales_shirley",
        campaignId: marketCampaignId,
        triggerJobId: marketFactJob.id,
        calculatedAt: "2026-07-13T10:00:00.000Z"
      });
      return {
        value,
        rollback: () => {
          firstStart.marketOpportunityBatches.splice(
            0,
            firstStart.marketOpportunityBatches.length - beforeBatchCount
          );
          firstStart.marketOpportunitySnapshots.splice(
            0,
            firstStart.marketOpportunitySnapshots.length - beforeSnapshotCount
          );
          firstStart.marketOpportunityCalculationEvents.splice(
            0,
            firstStart.marketOpportunityCalculationEvents.length - beforeEventCount
          );
        }
      };
    });
    assert.equal(marketFacts.batch.status, "metrics_ready");
    assert.equal(marketFacts.snapshots.length, 1);
    assert.equal(
      marketFacts.snapshots[0]?.metrics.reportedImportValueSeries[0]?.evidence.payloadHash,
      "1".repeat(64)
    );

    async function createIsolatedMarketFacts(input: {
      teamId: string;
      ownerId: string;
      campaignId: string;
      tradeValueUsd: number;
    }) {
      const job = enqueueAgentJob(firstStart, {
        teamId: input.teamId,
        ownerId: input.ownerId,
        jobType: "prospect.market_analysis",
        aggregateType: "prospect_campaign_ref_compat_v1",
        aggregateId: input.campaignId,
        idempotencyKey: `mysql-market-isolation-${randomUUID()}`,
        input: {
          campaignId: input.campaignId,
          providerId: "un_comtrade",
          requestFingerprint: `mysql-market-isolation-${input.ownerId}`,
          query: {
            reporterCodes: ["842"],
            partnerCodes: ["0"],
            flow: "import",
            hsVersion: "HS2022",
            commodityCodes: ["940542"],
            periods: ["2024"],
            frequency: "annual",
            limit: 5
          }
        }
      }).job;
      await upsertMarketTradeObservations(firstStart, {
        teamId: input.teamId,
        ownerId: input.ownerId,
        campaignId: input.campaignId,
        providerId: "un_comtrade",
        observations: [{
          ...baseTradeObservation,
          period: "2024",
          tradeValueUsd: input.tradeValueUsd,
          providerRecordId: `un-comtrade:${input.ownerId}:2024`,
          payloadHash: input.tradeValueUsd.toString(16).padStart(64, "0")
        }]
      });
      return firstStart.persistMutation!(() => {
        const beforeBatchCount = firstStart.marketOpportunityBatches.length;
        const beforeSnapshotCount = firstStart.marketOpportunitySnapshots.length;
        const beforeEventCount = firstStart.marketOpportunityCalculationEvents.length;
        const value = materializeMarketOpportunityFacts(firstStart, {
          teamId: input.teamId,
          ownerId: input.ownerId,
          campaignId: input.campaignId,
          triggerJobId: job.id,
          calculatedAt: "2026-07-13T10:30:00.000Z"
        });
        return {
          value,
          rollback: () => {
            firstStart.marketOpportunityBatches.splice(
              0,
              firstStart.marketOpportunityBatches.length - beforeBatchCount
            );
            firstStart.marketOpportunitySnapshots.splice(
              0,
              firstStart.marketOpportunitySnapshots.length - beforeSnapshotCount
            );
            firstStart.marketOpportunityCalculationEvents.splice(
              0,
              firstStart.marketOpportunityCalculationEvents.length - beforeEventCount
            );
          }
        };
      });
    }

    const secondOwnerFacts = await createIsolatedMarketFacts({
      teamId: "europe",
      ownerId: teamASecondUser.id,
      campaignId: marketCampaignId,
      tradeValueUsd: 220
    });
    const otherTeamFacts = await createIsolatedMarketFacts({
      teamId: "trade_team_b",
      ownerId: teamBUser.id,
      campaignId: marketCampaignId,
      tradeValueUsd: 330
    });
    assert.notEqual(secondOwnerFacts.batch.id, marketFacts.batch.id);
    assert.notEqual(otherTeamFacts.batch.id, marketFacts.batch.id);

    const sourceWorld2022 = firstStart.marketTradeObservations.find((item) =>
      item.teamId === "europe"
      && item.ownerId === "u_sales_shirley"
      && item.campaignId === marketCampaignId
      && item.partnerCode === "0"
      && item.period === "2022"
    );
    assert.ok(sourceWorld2022);
    sourceWorld2022.tradeValueUsd = 999;
    sourceWorld2022.payloadHash = "9".repeat(64);

    const invalidSnapshot = {
      ...marketFacts.snapshots[0]!,
      id: `mos_invalid_rollback_${randomUUID()}`,
      ownerId: teamASecondUser.id
    };
    await assert.rejects(
      () => firstStart.persistMutation!(() => {
        firstStart.marketOpportunitySnapshots.unshift(invalidSnapshot);
        return {
          value: invalidSnapshot.id,
          rollback: () => {
            const index = firstStart.marketOpportunitySnapshots.findIndex(
              (item) => item.id === invalidSnapshot.id
            );
            if (index >= 0) firstStart.marketOpportunitySnapshots.splice(index, 1);
          }
        };
      }),
      /市场机会事实快照持久化校验失败/
    );
    assert.equal(
      firstStart.marketOpportunitySnapshots.some((item) => item.id === invalidSnapshot.id),
      false
    );

    const barrierOrder: string[] = [];
    const queuedWrite = firstStart.persist().then(() => {
      barrierOrder.push("write");
    });
    const queuedRead = firstStart.readBarrier().then(() => {
      barrierOrder.push("read");
    });
    await Promise.all([queuedWrite, queuedRead]);
    assert.deepEqual(barrierOrder, ["write", "read"]);

    firstStart.websiteOpportunities.unshift(opportunity);
    firstStart.aiModelConfigs.unshift({
      id: aiConfigId,
      provider: "openai",
      protocol: "openai-compatible",
      name: "AI 密钥持久化测试",
      baseUrl: "https://api.openai.com/v1",
      model: "test-model",
      apiKey: aiSecret,
      enabled: false,
      temperature: 0.1,
      useLeadFinder: true,
      useWebsiteParse: false,
      useScoring: false,
      useEmailDraft: false,
      useExam: false,
      lastTestStatus: "untested",
      lastTestMessage: "",
      ownerId: "u_sales_shirley",
      teamId: "europe",
      updatedAt: "2026-07-13T08:00:00.000Z"
    });
    const customizedProvider = firstStart.providerCatalog.find((item) => item.code === "serper");
    const removedProvider = firstStart.providerCatalog.find((item) => item.code === "hunter");
    assert.ok(customizedProvider, "Default Serper catalog item must exist");
    assert.ok(removedProvider, "Default Hunter catalog item must exist");
    customizedProvider.name = "团队自定义搜索源";
    customizedProvider.status = "disabled";
    customizedProvider.updatedAt = "2026-07-13T09:00:00.000Z";
    firstStart.providerCatalog.splice(firstStart.providerCatalog.indexOf(removedProvider), 1);
    firstStart.providerRequestLogs.unshift(millisecondRequestLog);
    await firstStart.persist();
    await firstStart.persist();
    await writeProviderResponseCache(cacheKey, cachePayload, {
      fetchedAt: "2026-07-13T08:00:00.000Z",
      expiresAt: "2026-07-14T08:00:00.000Z"
    });

    const [encryptedRows] = await admin.query<Array<RowDataPacket & { api_key: string }>>(
      `SELECT api_key FROM \`${databaseName}\`.ai_model_configs WHERE id = ?`,
      [aiConfigId]
    );
    assert.match(encryptedRows[0]?.api_key || "", /^ai-v1\./);
    assert.notEqual(encryptedRows[0]?.api_key, aiSecret);
    const [cacheRows] = await admin.query<Array<RowDataPacket & { payload_encrypted: string }>>(
      `SELECT payload_encrypted FROM \`${databaseName}\`.provider_response_cache WHERE provider_id = ?`,
      ["un_comtrade"]
    );
    assert.match(cacheRows[0]?.payload_encrypted || "", /^cache-v1\./);
    assert.equal(cacheRows[0]?.payload_encrypted.includes("2061149344"), false);
    const [aliasRows] = await admin.query<Array<RowDataPacket & {
      job_id: string;
      idempotency_key: string;
    }>>(
      `SELECT job_id, idempotency_key
       FROM \`${databaseName}\`.agent_job_idempotency_aliases
       WHERE id = ?`,
      [interruptedAlias.id]
    );
    assert.equal(aliasRows[0]?.job_id, interruptedMarketAnalysisJob.id);
    assert.match(aliasRows[0]?.idempotency_key || "", /^[a-f0-9]{64}$/);
    assert.notEqual(aliasRows[0]?.idempotency_key, interruptedMarketAnalysisAliasKey);
    const [aliasIndexRows] = await admin.query<Array<RowDataPacket & {
      Key_name: string;
      Non_unique: number;
      Seq_in_index: number;
      Column_name: string;
    }>>(
      `SHOW INDEX FROM \`${databaseName}\`.agent_job_idempotency_aliases
       WHERE Key_name = 'uk_agent_job_alias_idempotency'`
    );
    assert.deepEqual(
      aliasIndexRows
        .sort((left, right) => left.Seq_in_index - right.Seq_in_index)
        .map((item) => item.Column_name),
      ["team_id", "job_type", "idempotency_key"]
    );
    assert.ok(aliasIndexRows.every((item) => Number(item.Non_unique) === 0));
    const [jobIndexRows] = await admin.query<Array<RowDataPacket & {
      Non_unique: number;
      Seq_in_index: number;
      Column_name: string;
    }>>(
      `SHOW INDEX FROM \`${databaseName}\`.agent_jobs
       WHERE Key_name = 'uk_agent_job_idempotency'`
    );
    assert.deepEqual(
      jobIndexRows
        .sort((left, right) => left.Seq_in_index - right.Seq_in_index)
        .map((item) => item.Column_name),
      ["team_id", "job_type", "idempotency_key"]
    );
    assert.ok(jobIndexRows.every((item) => Number(item.Non_unique) === 0));

    const conflictTargetJob = enqueueAgentJob(firstStart, {
      teamId: "europe",
      ownerId: "u_sales_shirley",
      jobType: "prospect.market_analysis",
      aggregateType: "prospect_campaign_ref_compat_v1",
      aggregateId: "mysql_conflict_target_campaign",
      idempotencyKey: `mysql-conflict-target-${randomUUID()}`,
      input: {
        campaignId: "mysql_conflict_target_campaign",
        providerId: "un_comtrade",
        requestFingerprint: "mysql-conflict-target-fingerprint",
        query: {
          reporterCodes: ["842"],
          partnerCodes: ["0"],
          flow: "import",
          hsVersion: "HS2022",
          commodityCodes: ["940542"],
          periods: ["2023"],
          frequency: "annual",
          limit: 5
        }
      }
    }).job;
    await firstStart.persist();
    const conflictingAliasId = `ajia_conflict_${randomUUID()}`;
    await admin.query(
      `INSERT INTO \`${databaseName}\`.agent_job_idempotency_aliases
       (id, job_id, team_id, job_type, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        conflictingAliasId,
        conflictTargetJob.id,
        interruptedMarketAnalysisJob.teamId,
        interruptedMarketAnalysisJob.jobType,
        interruptedMarketAnalysisJob.idempotencyKey
      ]
    );
    await assert.rejects(
      () => createMysqlStore(),
      /主任务与别名之间存在冲突绑定/
    );
    await admin.query(
      `DELETE FROM \`${databaseName}\`.agent_job_idempotency_aliases WHERE id = ?`,
      [conflictingAliasId]
    );
    const orphanAliasId = `ajia_orphan_${randomUUID()}`;
    await admin.query(
      `INSERT INTO \`${databaseName}\`.agent_job_idempotency_aliases
       (id, job_id, team_id, job_type, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        orphanAliasId,
        `missing_job_${randomUUID()}`,
        interruptedMarketAnalysisJob.teamId,
        interruptedMarketAnalysisJob.jobType,
        "f".repeat(64)
      ]
    );

    const secondStart = await createMysqlStore();
    setStore(secondStart);
    const recoveredInterruptedJob = secondStart.agentJobs.find(
      (item) => item.id === interruptedMarketAnalysisJob.id
    );
    assert.equal(recoveredInterruptedJob?.status, "failed");
    assert.equal(recoveredInterruptedJob?.errorCode, "EXECUTION_INTERRUPTED");
    assert.ok(recoveredInterruptedJob?.finishedAt);
    assert.equal(
      findAgentJobByIdempotency(secondStart, {
        teamId: "europe",
        jobType: "prospect.market_analysis",
        idempotencyKey: interruptedMarketAnalysisAliasKey
      })?.id,
      interruptedMarketAnalysisJob.id
    );
    assert.equal(
      secondStart.agentJobIdempotencyAliases.find(
        (item) => item.id === interruptedAlias.id
      )?.jobId,
      interruptedMarketAnalysisJob.id
    );
    const [orphanRows] = await admin.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count
       FROM \`${databaseName}\`.agent_job_idempotency_aliases
       WHERE id = ?`,
      [orphanAliasId]
    );
    assert.equal(Number(orphanRows[0]?.count || 0), 0);
    const reloaded = secondStart.websiteOpportunities.find((item) => item.id === opportunity.id);
    assert.ok(reloaded, "Provider opportunity must survive a cold MySQL store start");
    assert.deepEqual(reloaded.sourceEvidence, [evidence]);
    assert.deepEqual(reloaded.verificationReport, opportunity.verificationReport);
    assert.equal(reloaded.ownerId, opportunity.ownerId);
    assert.equal(reloaded.teamId, opportunity.teamId);
    assert.equal(
      secondStart.providerRequestLogs.find(
        (item) => item.id === millisecondRequestLog.id
      )?.requestedAt,
      millisecondRequestLog.requestedAt,
      "Provider request log milliseconds must survive repeated persistence"
    );
    assert.equal(
      secondStart.aiModelConfigs.find((item) => item.id === aiConfigId)?.apiKey,
      aiSecret,
      "Encrypted AI API key must decrypt after a cold MySQL store start"
    );
    const preservedProvider = secondStart.providerCatalog.find((item) => item.code === "serper");
    const restoredProvider = secondStart.providerCatalog.find((item) => item.code === "hunter");
    assert.equal(preservedProvider?.name, "团队自定义搜索源");
    assert.equal(preservedProvider?.status, "disabled");
    assert.ok(restoredProvider, "Missing default Provider must be restored during upgrade");
    const cacheHit = await readProviderResponseCache<typeof cachePayload>(
      cacheKey,
      new Date("2026-07-13T12:00:00.000Z")
    );
    assert.deepEqual(cacheHit?.payload, cachePayload);
    const reloadedTradeTeamA = secondStart.marketTradeObservations.filter(
      (item) => item.teamId === "europe" && item.campaignId === "mysql_trade_campaign"
    );
    const reloadedTradeTeamB = secondStart.marketTradeObservations.filter(
      (item) => item.teamId === "trade_team_b" && item.campaignId === "mysql_trade_campaign"
    );
    assert.equal(reloadedTradeTeamA.length, 3);
    assert.equal(reloadedTradeTeamB.length, 1);
    assert.equal(
      reloadedTradeTeamA.filter((item) => item.commodityCode === "940542").length,
      2
    );
    assert.equal(
      reloadedTradeTeamA.find((item) => item.ownerId === teamASecondUser.id)?.tradeValueUsd,
      2250000
    );
    assert.equal(
      reloadedTradeTeamA.find((item) => item.commodityCode === "940542")?.tradeValueUsd,
      1500000
    );
    assert.deepEqual(
      reloadedTradeTeamA.find((item) => item.commodityCode === "940542")?.statusFlags,
      ["REVISED"]
    );
    assert.equal(
      reloadedTradeTeamA.find((item) => item.commodityCode === "940542")?.reporterCountry,
      "usa"
    );
    assert.equal(
      reloadedTradeTeamA.find((item) => item.commodityCode === "940542")?.reporterCode,
      "842"
    );
    assert.equal(
      reloadedTradeTeamA.find((item) => item.commodityCode === "940542")?.partnerCode,
      "0"
    );
    assert.equal(
      reloadedTradeTeamA.find((item) => item.commodityCode === "940542")?.commodityDescription,
      "Other electric lamps and lighting fittings"
    );
    assert.equal(
      reloadedTradeTeamA.find((item) => item.commodityCode === "940542")?.sourceRevision,
      "2026-07-12"
    );
    assert.equal(
      reloadedTradeTeamA.find((item) => item.commodityCode === "940549")?.tradeValueUsd,
      null
    );
    assert.equal(
      reloadedTradeTeamA.find((item) => item.commodityCode === "940549")?.suppressed,
      true
    );

    const reloadedMarketBatch = secondStart.marketOpportunityBatches.find(
      (item) => item.id === marketFacts.batch.id
    );
    const reloadedMarketSnapshot = secondStart.marketOpportunitySnapshots.find(
      (item) => item.batchId === marketFacts.batch.id
    );
    const reloadedMarketEvent = secondStart.marketOpportunityCalculationEvents.find(
      (item) => item.id === marketFacts.event.id
    );
    assert.ok(reloadedMarketBatch);
    assert.ok(reloadedMarketSnapshot);
    assert.ok(reloadedMarketEvent);
    assert.equal(reloadedMarketBatch.teamId, "europe");
    assert.equal(reloadedMarketBatch.ownerId, "u_sales_shirley");
    assert.equal(reloadedMarketBatch.firstTriggerJobId, marketFactJob.id);
    assert.equal(
      reloadedMarketBatch.observationCutoffAt,
      "2026-07-13T08:00:00.000Z"
    );
    assert.equal(reloadedMarketEvent.batchId, reloadedMarketBatch.id);
    assert.equal(reloadedMarketEvent.triggerJobId, marketFactJob.id);
    assert.ok(reloadedMarketEvent.sequence > 0);
    assert.equal(reloadedMarketSnapshot.marketScore, null);
    assert.equal(reloadedMarketSnapshot.growthScore, null);
    assert.equal(reloadedMarketSnapshot.chinaSupplyScore, null);
    assert.equal(
      reloadedMarketSnapshot.metrics.reportedImportValueSeries[0]?.tradeValueUsd,
      100,
      "Immutable opportunity evidence must not follow later source observation changes"
    );
    assert.equal(
      reloadedMarketSnapshot.metrics.reportedImportValueSeries[0]?.evidence.payloadHash,
      "1".repeat(64),
      "Immutable evidence payload hash must survive cold start unchanged"
    );
    assert.equal(
      secondStart.marketTradeObservations.find((item) => item.id === sourceWorld2022.id)
        ?.tradeValueUsd,
      999
    );
    assert.equal(
      secondStart.marketOpportunityBatches.filter((item) =>
        item.campaignId === marketCampaignId
        && item.teamId === "europe"
        && item.ownerId === teamASecondUser.id
      ).length,
      1
    );
    assert.equal(
      secondStart.marketOpportunityBatches.filter((item) =>
        item.campaignId === marketCampaignId
        && item.teamId === "trade_team_b"
        && item.ownerId === teamBUser.id
      ).length,
      1
    );

    const originalCommodityDescription = reloadedMarketSnapshot.commodityDescription;
    reloadedMarketSnapshot.commodityDescription = "attempted immutable rewrite";
    await assert.rejects(
      () => secondStart.persist(),
      /市场机会事实快照不可变历史被删除或修改/
    );
    reloadedMarketSnapshot.commodityDescription = originalCommodityDescription;
    await secondStart.persist();

    await admin.query(
      `UPDATE \`${databaseName}\`.market_opportunity_snapshots
       SET metrics_json = JSON_SET(
         metrics_json,
         '$.reportedImportValueSeries',
         JSON_OBJECT()
       )
       WHERE id = ?`,
      [reloadedMarketSnapshot.id]
    );
    await assert.rejects(
      () => createMysqlStore(),
      /市场机会事实快照持久化校验失败/
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.market_opportunity_snapshots
       SET metrics_json = ? WHERE id = ?`,
      [JSON.stringify(reloadedMarketSnapshot.metrics), reloadedMarketSnapshot.id]
    );

    await admin.query(
      `UPDATE \`${databaseName}\`.market_opportunity_batches
       SET candidate_count = candidate_count + 1 WHERE id = ?`,
      [reloadedMarketBatch.id]
    );
    await assert.rejects(
      () => createMysqlStore(),
      /市场机会事实批次持久化校验失败/
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.market_opportunity_batches
       SET candidate_count = ? WHERE id = ?`,
      [reloadedMarketBatch.candidateCount, reloadedMarketBatch.id]
    );

    const crossOwnerTriggerJob = enqueueAgentJob(secondStart, {
      teamId: "europe",
      ownerId: teamASecondUser.id,
      jobType: "prospect.market_analysis",
      aggregateType: "prospect_campaign_ref_compat_v1",
      aggregateId: marketCampaignId,
      idempotencyKey: `mysql-cross-owner-trigger-${randomUUID()}`,
      input: {
        campaignId: marketCampaignId,
        providerId: "un_comtrade",
        requestFingerprint: "mysql-cross-owner-trigger-fingerprint",
        query: {
          reporterCodes: ["842"],
          partnerCodes: ["0"],
          flow: "import",
          hsVersion: "HS2022",
          commodityCodes: ["940542"],
          periods: ["2024"],
          frequency: "annual",
          limit: 5
        }
      }
    }).job;
    await secondStart.persist();
    await admin.query(
      `UPDATE \`${databaseName}\`.market_opportunity_calculation_events
       SET trigger_job_id = ? WHERE id = ?`,
      [crossOwnerTriggerJob.id, reloadedMarketEvent.id]
    );
    await assert.rejects(
      () => createMysqlStore(),
      /市场机会计算事件持久化校验失败/
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.market_opportunity_calculation_events
       SET trigger_job_id = ? WHERE id = ?`,
      [marketFactJob.id, reloadedMarketEvent.id]
    );

    const [marketScoreRows] = await admin.query<Array<RowDataPacket & {
      market_score: number | null;
      growth_score: number | null;
      china_supply_score: number | null;
    }>>(
      `SELECT market_score, growth_score, china_supply_score
       FROM \`${databaseName}\`.market_opportunity_snapshots
       WHERE id = ?`,
      [reloadedMarketSnapshot.id]
    );
    assert.equal(marketScoreRows[0]?.market_score, null);
    assert.equal(marketScoreRows[0]?.growth_score, null);
    assert.equal(marketScoreRows[0]?.china_supply_score, null);

    await admin.query(
      `UPDATE \`${databaseName}\`.market_opportunity_snapshots
       SET market_score = 1 WHERE id = ?`,
      [reloadedMarketSnapshot.id]
    );
    await assert.rejects(
      () => createMysqlStore(),
      /市场机会事实快照持久化校验失败/
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.market_opportunity_snapshots
       SET market_score = NULL WHERE id = ?`,
      [reloadedMarketSnapshot.id]
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.market_opportunity_snapshots
       SET owner_id = ? WHERE id = ?`,
      [teamASecondUser.id, reloadedMarketSnapshot.id]
    );
    await assert.rejects(
      () => createMysqlStore(),
      /市场机会事实快照持久化校验失败/
    );
    await admin.query(
      `UPDATE \`${databaseName}\`.market_opportunity_snapshots
       SET owner_id = ? WHERE id = ?`,
      ["u_sales_shirley", reloadedMarketSnapshot.id]
    );

    await admin.query(
      `ALTER TABLE \`${databaseName}\`.market_opportunity_snapshots
       DROP INDEX uk_market_opportunity_snapshot,
       ADD INDEX uk_market_opportunity_snapshot(batch_id, reporter_country)`
    );
    await createMysqlStore();
    const [marketSnapshotIndexRows] = await admin.query<Array<RowDataPacket & {
      Non_unique: number;
      Seq_in_index: number;
      Column_name: string;
    }>>(
      `SHOW INDEX FROM \`${databaseName}\`.market_opportunity_snapshots
       WHERE Key_name = 'uk_market_opportunity_snapshot'`
    );
    assert.deepEqual(
      marketSnapshotIndexRows
        .sort((left, right) => left.Seq_in_index - right.Seq_in_index)
        .map((item) => item.Column_name),
      ["batch_id", "reporter_code", "classification", "commodity_code"]
    );
    assert.ok(
      marketSnapshotIndexRows.every((item) => Number(item.Non_unique) === 0)
    );

    const thirdStart = await createMysqlStore();
    setStore(thirdStart);
    assert.equal(
      thirdStart.providerCatalog.find((item) => item.code === "serper")?.name,
      "团队自定义搜索源",
      "A later cold start must not overwrite the administrator's Provider customization"
    );
    assert.ok(
      thirdStart.providerCatalog.some((item) => item.code === "hunter"),
      "Restored Provider catalog item must be persisted"
    );
    assert.deepEqual(
      thirdStart.websiteOpportunities.find((item) => item.id === opportunity.id)?.sourceEvidence,
      [evidence],
      "Provider evidence must remain durable across repeated cold starts"
    );
    assert.deepEqual(
      thirdStart.websiteOpportunities.find((item) => item.id === opportunity.id)?.verificationReport,
      opportunity.verificationReport,
      "Verification report must remain durable across repeated cold starts"
    );

    const legacySecret = "legacy-plaintext-ai-secret";
    await admin.query(
      `UPDATE \`${databaseName}\`.ai_model_configs SET api_key = ? WHERE id = ?`,
      [legacySecret, aiConfigId]
    );
    const migratedStart = await createMysqlStore();
    assert.equal(
      migratedStart.aiModelConfigs.find((item) => item.id === aiConfigId)?.apiKey,
      legacySecret,
      "Legacy plaintext AI API keys must remain usable during migration"
    );
    const [migratedRows] = await admin.query<Array<RowDataPacket & { api_key: string }>>(
      `SELECT api_key FROM \`${databaseName}\`.ai_model_configs WHERE id = ?`,
      [aiConfigId]
    );
    assert.match(migratedRows[0]?.api_key || "", /^ai-v1\./);
    assert.notEqual(migratedRows[0]?.api_key, legacySecret);

    const [columns] = await admin.query<Array<RowDataPacket & { Field: string }>>(
      `SHOW COLUMNS FROM \`${databaseName}\`.website_opportunities`
    );
    assert.ok(columns.some((column) => column.Field === "source_evidence_json"));
    assert.ok(columns.some((column) => column.Field === "verification_report_json"));
    const [cacheColumns] = await admin.query<Array<RowDataPacket & { Field: string }>>(
      `SHOW COLUMNS FROM \`${databaseName}\`.provider_response_cache`
    );
    assert.equal(cacheColumns.some((column) => column.Field === "team_id"), false);
    assert.equal(cacheColumns.some((column) => column.Field === "owner_id"), false);
    const [cacheIndexes] = await admin.query<Array<RowDataPacket & {
      Key_name: string;
      Column_name: string;
      Seq_in_index: number;
    }>>(
      `SHOW INDEX FROM \`${databaseName}\`.provider_response_cache WHERE Key_name = 'uk_provider_response_cache'`
    );
    assert.deepEqual(
      cacheIndexes
        .sort((left, right) => left.Seq_in_index - right.Seq_in_index)
        .map((row) => row.Column_name),
      ["provider_id", "provider_version", "request_fingerprint", "license_scope"]
    );
    const [tradeIndexes] = await admin.query<Array<RowDataPacket & {
      Key_name: string;
      Column_name: string;
      Seq_in_index: number;
    }>>(
      `SHOW INDEX FROM \`${databaseName}\`.market_trade_observations WHERE Key_name = 'uk_market_trade_observation'`
    );
    assert.deepEqual(
      tradeIndexes
        .sort((left, right) => left.Seq_in_index - right.Seq_in_index)
        .map((row) => row.Column_name),
      [
        "team_id",
        "owner_id",
        "campaign_id",
        "provider_id",
        "reporter_country",
        "partner_country",
        "trade_flow",
        "classification",
        "commodity_code",
        "period_value"
      ]
    );
    const [tradeColumns] = await admin.query<Array<RowDataPacket & {
      Field: string;
      Type: string;
    }>>(
      `SHOW COLUMNS FROM \`${databaseName}\`.market_trade_observations`
    );
    const tradeColumnTypes = new Map(
      tradeColumns.map((column) => [column.Field, column.Type.toLowerCase()])
    );
    assert.equal(tradeColumnTypes.get("reporter_country"), "varchar(100)");
    assert.equal(tradeColumnTypes.get("partner_country"), "varchar(100)");
    assert.equal(tradeColumnTypes.get("classification"), "varchar(40)");
    assert.equal(tradeColumnTypes.get("reporter_code"), "varchar(16)");
    assert.equal(tradeColumnTypes.get("partner_code"), "varchar(16)");
    assert.equal(tradeColumnTypes.get("commodity_description"), "varchar(500)");
    assert.equal(tradeColumnTypes.get("source_revision"), "varchar(120)");
    const [requestLogColumns] = await admin.query<Array<RowDataPacket & {
      Field: string;
      Type: string;
    }>>(
      `SHOW COLUMNS FROM \`${databaseName}\`.provider_request_logs`
    );
    assert.equal(
      requestLogColumns.find((column) => column.Field === "requested_at")
        ?.Type.toLowerCase(),
      "datetime(3)"
    );

    console.log("Provider MySQL evidence, public cache and private trade observation persistence tests passed");
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
