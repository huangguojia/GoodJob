import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { AppConfig } from "../src/server/config";
import { createAppRuntime } from "../src/server/app";
import { applyDemoCleanup, planDemoCleanup } from "../src/server/db/demo-cleanup";
import { createDatabase, databaseTimestamp, type Database } from "../src/server/db/database";
import { migrate } from "../src/server/db/migrate";
import { Repository } from "../src/server/db/repository";
import { seed, seedDemo } from "../src/server/db/seed";

const mysqlUrl = process.env.TEST_MYSQL_DATABASE_URL?.trim();
const describeMysql = mysqlUrl ? describe : describe.skip;

describeMysql("MySQL Communication persistence", () => {
  let database: Database;
  let repository: Repository;
  const config: AppConfig = {
    nodeEnv: "test",
    port: 0,
    webOrigin: "http://127.0.0.1",
    databaseClient: "mysql",
    databaseUrl: mysqlUrl,
    pglitePath: ".data/mysql-integration-unused",
    sessionMasterKey: randomBytes(32).toString("base64"),
    seedDemo: false,
    allowPrivateAiEndpoints: false
  };

  beforeAll(async () => {
    database = await createDatabase(config);
    await migrate(database);
    await migrate(database);
    repository = new Repository(database);
    await seed(database, repository, config);
  });

  afterAll(async () => database?.close());

  it("creates all schema versions idempotently and rolls transactions back", async () => {
    const versions = await database.query<{ version: number }>(
      "SELECT version FROM communication_schema_migrations ORDER BY version"
    );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const collations = await database.query<{ table_collation: string }>(
      `SELECT DISTINCT table_collation AS table_collation FROM information_schema.tables
       WHERE table_schema=DATABASE() AND table_name IN ('channel_accounts','provider_session_keys','messages')`
    );
    expect(collations.rows.map((row) => row.table_collation)).toEqual(["utf8mb4_bin"]);

    const id = randomUUID();
    await expect(database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO channel_accounts(
          id,name,provider,status,purpose_label,lead_types_json,region,priority,risk_accepted,created_at,updated_at
        ) VALUES($1,'rollback','demo','unconfigured','','[]','',100,0,$2,$2)`,
        [id, databaseTimestamp(new Date())]
      );
      throw new Error("rollback marker");
    })).rejects.toThrow("rollback marker");
    expect((await database.query("SELECT id FROM channel_accounts WHERE id=$1", [id])).rows).toHaveLength(0);
  });

  it("self-heals owner defaults when legacy defaults are absent", async () => {
    await database.query("DELETE FROM integration_preferences WHERE id='default'");
    await database.query("DELETE FROM media_retention_settings WHERE id='default'");

    await expect(repository.getIntegrationPreference("mysql-default-recovery-user")).resolves.toMatchObject({
      strategy: "free_first",
      defaultProvider: "baileys"
    });
    await expect(repository.getMediaRetentionPolicy("mysql-default-recovery-user")).resolves.toMatchObject({
      mode: "immediate",
      days: 0
    });

    await seed(database, repository, config);
    expect((await database.query("SELECT id FROM integration_preferences WHERE id='default'")).rows).toHaveLength(1);
    expect((await database.query("SELECT id FROM media_retention_settings WHERE id='default'")).rows).toHaveLength(1);
  });

  it("round-trips automation timestamps as UTC instants", async () => {
    const nextAnalysisAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const nextDailyTodoAt = new Date(Date.now() + 18 * 3_600_000).toISOString();
    const settings = await repository.saveAutomationSettings({
      ownerUserId: "mysql-timezone-user",
      analysisIntervalHours: 6,
      intelligenceMode: "rules",
      intelligenceProviderId: null,
      dailyTodoHour: 9,
      dailyTodoMinute: 0,
      timezone: "Asia/Shanghai",
      enabled: true,
      nextAnalysisAt,
      nextDailyTodoAt
    });

    expect(new Date(settings.nextAnalysisAt!).getTime()).toBe(new Date(nextAnalysisAt).getTime());
    expect(new Date(settings.nextDailyTodoAt!).getTime()).toBe(new Date(nextDailyTodoAt).getTime());
  });

  it("preserves idempotency, ownership, encrypted sessions, relations, and cleanup invariants", async () => {
    const account = await repository.createAccount({
      name: "MySQL protected account",
      provider: "baileys",
      riskAccepted: true,
      ownerUserId: "mysql-test-user"
    });
    await repository.setSessionValue(account.id, "creds", "primary", "encrypted-session-payload");
    const firstContact = await repository.upsertContact({
      accountId: account.id,
      providerContactId: "12025550123@s.whatsapp.net",
      displayName: "First name",
      phone: "+12025550123",
      source: "baileys"
    });
    const updatedContact = await repository.upsertContact({
      accountId: account.id,
      providerContactId: "12025550123@s.whatsapp.net",
      displayName: "Updated name",
      phone: "+12025550123",
      source: "baileys"
    });
    expect(updatedContact).toMatchObject({ id: firstContact.id, displayName: "Updated name" });

    const conversation = await repository.ensureConversationForContact(firstContact.id);
    const firstMessage = await repository.createMessage({
      accountId: account.id,
      conversationId: conversation.id,
      clientMessageId: "mysql-idempotency-key",
      direction: "outbound",
      body: "MySQL persistence",
      status: "queued"
    });
    const duplicate = await repository.createMessage({
      accountId: account.id,
      conversationId: conversation.id,
      clientMessageId: "mysql-idempotency-key",
      direction: "outbound",
      body: "must not replace original",
      status: "queued"
    });
    expect(duplicate.id).toBe(firstMessage.id);
    expect(duplicate.body).toBe("MySQL persistence");

    const profile = await repository.createAiProfile({
      name: "MySQL AI",
      kind: "openai",
      model: "test-model",
      ownerUserId: "mysql-test-user"
    });
    await repository.updateTranslationPreference({ providerId: profile.id }, "mysql-test-user");
    const translation = await repository.createPendingTranslation({
      messageId: firstMessage.id,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      profileId: profile.id,
      model: profile.model,
      trigger: "manual"
    });
    expect((await repository.completeTranslation(translation.id, "MySQL 持久化", 3)).status).toBe("translated");

    await repository.updateMediaRetentionPolicy("days", 30, "mysql-test-user");
    expect(await repository.getMediaRetentionPolicy("mysql-test-user")).toMatchObject({ mode: "days", days: 30 });
    expect((await repository.listAccounts("mysql-test-user")).map((item) => item.id)).toContain(account.id);
    expect(await repository.getSessionValue(account.id, "creds", "primary")).toBe("encrypted-session-payload");

    await seedDemo(database, repository, { nodeEnv: "test" });
    const plan = await planDemoCleanup(database);
    const result = await applyDemoCleanup(database, plan.planDigest);
    expect(result.deleted.accounts).toBe(2);
    expect(await repository.getAccount(account.id)).not.toBeNull();
    expect(await repository.getSessionValue(account.id, "creds", "primary")).toBe("encrypted-session-payload");
  });

  it("starts the production runtime on MySQL and reports readiness", async () => {
    const runtime = await createAppRuntime({
      ...config,
      nodeEnv: "production",
      webOrigin: "https://crm.example.test",
      autoMigrate: false,
      enableDemoProvider: false,
      crmJwtSecret: "mysql-runtime-test-secret-at-least-32-characters"
    });
    try {
      const ready = await request(runtime.app).get("/api/health/ready").expect(200);
      expect(ready.body).toMatchObject({ status: "ready", ready: true, database: "mysql" });
    } finally {
      await runtime.close();
    }
  });
});
