import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config";
import { applyDemoCleanup, planDemoCleanup } from "../src/server/db/demo-cleanup";
import { createDatabase, type Database } from "../src/server/db/database";
import { migrate } from "../src/server/db/migrate";
import { Repository } from "../src/server/db/repository";
import { seed, seedDemo } from "../src/server/db/seed";
import { parseCleanupCliOptions, runCleanup } from "../src/server/scripts/cleanup-demo";

const databases: Database[] = [];

async function testRuntime(): Promise<{ config: AppConfig; database: Database; repository: Repository }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wa-crm-lifecycle-"));
  const config: AppConfig = {
    nodeEnv: "test",
    port: 0,
    webOrigin: "http://localhost:5173",
    databaseClient: "pglite",
    pglitePath: path.join(directory, "pgdata"),
    sessionMasterKey: randomBytes(32).toString("base64"),
    seedDemo: false,
    allowPrivateAiEndpoints: false
  };
  const database = await createDatabase(config);
  databases.push(database);
  await migrate(database);
  const repository = new Repository(database);
  await seed(database, repository, config);
  return { config, database, repository };
}

async function unmigratedDatabase(): Promise<Database> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wa-crm-unmigrated-"));
  const database = await createDatabase({
    nodeEnv: "test",
    port: 0,
    webOrigin: "http://localhost:5173",
    databaseClient: "pglite",
    pglitePath: path.join(directory, "pgdata"),
    sessionMasterKey: randomBytes(32).toString("base64"),
    seedDemo: false,
    allowPrivateAiEndpoints: false
  });
  databases.push(database);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("database lifecycle", () => {
  it("runs versioned migrations idempotently and initializes no Demo or Mock data", async () => {
    const { config, database, repository } = await testRuntime();
    await migrate(database);
    await seed(database, repository, config);

    const versions = await database.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version"
    );
    const accounts = await database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM channel_accounts");
    const mocks = await database.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM ai_provider_profiles WHERE kind='mock'"
    );
    const preference = await database.query<{
      auto_translate: number;
      provider_id: string | null;
    }>("SELECT auto_translate,provider_id FROM translation_preferences WHERE id='default'");

    expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Number(accounts.rows[0].count)).toBe(0);
    expect(Number(mocks.rows[0].count)).toBe(0);
    expect(preference.rows[0]).toMatchObject({ auto_translate: 0, provider_id: null });
  });

  it("rolls a failed callback back on the same database connection", async () => {
    const { database } = await testRuntime();
    await expect(
      database.transaction(async (transaction) => {
        const timestamp = new Date().toISOString();
        await transaction.query(
          `INSERT INTO channel_accounts(
             id,name,provider,status,purpose_label,lead_types_json,region,priority,risk_accepted,created_at,updated_at
           ) VALUES($1,'rollback-test','demo','unconfigured','','[]','',100,1,$2,$2)`,
          [randomUUID(), timestamp]
        );
        throw new Error("force rollback");
      })
    ).rejects.toThrow("force rollback");

    const accounts = await database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM channel_accounts");
    expect(Number(accounts.rows[0].count)).toBe(0);
  });

  it("allows explicit non-production Demo seeding and keeps it idempotent", async () => {
    const { database, repository } = await testRuntime();
    await expect(seedDemo(database, repository, { nodeEnv: "production" })).rejects.toThrow(/disabled/u);

    const first = await seedDemo(database, repository, { nodeEnv: "test" });
    const second = await seedDemo(database, repository, { nodeEnv: "test" });
    expect(first).toMatchObject({ created: true, accounts: 2, contacts: 3, conversations: 3, messages: 4 });
    expect(second).toMatchObject({ created: false, accounts: 2, contacts: 3, conversations: 3, messages: 4 });

    const preference = await database.query<{ auto_translate: number; provider_kind: string }>(
      `SELECT pref.auto_translate,p.kind AS provider_kind FROM translation_preferences pref
       JOIN ai_provider_profiles p ON p.id=pref.provider_id WHERE pref.id='default'`
    );
    expect(preference.rows[0]).toMatchObject({ auto_translate: 1, provider_kind: "mock" });
  });

  it("requires the latest digest and preserves non-Demo data including session key contents", async () => {
    const { database, repository } = await testRuntime();
    await seedDemo(database, repository, { nodeEnv: "test" });

    const realAccount = await repository.createAccount({
      name: "Protected account",
      provider: "baileys",
      purposeLabel: "protected",
      riskAccepted: true
    });
    await repository.setSessionValue(realAccount.id, "creds", "primary", "encrypted-auth-state-a");
    const realContact = await repository.upsertContact({
      accountId: realAccount.id,
      providerContactId: "12025550001@s.whatsapp.net",
      displayName: "Protected contact",
      phone: "+12025550001",
      source: "baileys",
      origin: "whatsapp_sync"
    });
    const realConversation = await repository.ensureConversationForContact(realContact.id);
    await repository.createMessage({
      accountId: realAccount.id,
      conversationId: realConversation.id,
      providerMessageId: "protected-message",
      direction: "inbound",
      body: "Protected message",
      status: "delivered"
    });
    const openAi = await repository.createAiProfile({
      name: "Protected AI",
      kind: "openai",
      baseUrl: "https://api.example.test/v1",
      apiKeyCipher: "encrypted-key",
      apiKeyMask: "****test",
      model: "protected-model"
    });
    await repository.updateTranslationPreference({ autoTranslate: false, providerId: openAi.id });

    const stalePlan = await planDemoCleanup(database);
    await repository.setSessionValue(realAccount.id, "creds", "primary", "encrypted-auth-state-b");
    const plan = await planDemoCleanup(database);
    expect(plan.protectedDigest).not.toBe(stalePlan.protectedDigest);
    expect(plan.planDigest).not.toBe(stalePlan.planDigest);
    expect(plan.counts).toMatchObject({
      demoAccounts: 2,
      demoContacts: 3,
      demoConversations: 3,
      demoMessages: 4,
      demoTranslations: 2,
      demoRoutingRules: 2,
      blockedMixedRoutingRules: 0,
      demoCrmContacts: 1,
      removableMockProfiles: 1,
      blockedMockProfiles: 0
    });
    const serializedPlan = JSON.stringify(plan);
    expect(serializedPlan).not.toContain("Protected message");
    expect(serializedPlan).not.toContain("encrypted-auth-state");
    expect(serializedPlan).not.toContain("+12025550001");

    await expect(applyDemoCleanup(database, stalePlan.planDigest)).rejects.toThrow(/plan changed/u);
    const result = await applyDemoCleanup(database, plan.planDigest);
    expect(result.deleted).toEqual({ accounts: 2, routingRules: 2, crmContacts: 1, mockProfiles: 1 });
    expect(result.auditRecordsCreated).toBe(1);
    expect(result.protectedDigest).toBe(plan.protectedDigest);

    const remaining = await planDemoCleanup(database);
    expect(remaining.hasTargets).toBe(false);
    expect(remaining.protectedDigest).toBe(plan.protectedDigest);
    expect(remaining.protectedCounts).toMatchObject({
      accounts: 1,
      contacts: 1,
      conversations: 1,
      messages: 1,
      sessionKeys: 1,
      aiProfiles: 1
    });
    const second = await applyDemoCleanup(database, remaining.planDigest);
    expect(second.auditRecordsCreated).toBe(0);
    expect(second.deleted).toEqual({ accounts: 0, routingRules: 0, crmContacts: 0, mockProfiles: 0 });

    const cleanupAudit = await database.query<{ details_json: string }>(
      "SELECT details_json FROM audit_logs WHERE action='maintenance.demo_cleanup'"
    );
    expect(cleanupAudit.rows).toHaveLength(1);
    expect(cleanupAudit.rows[0].details_json).not.toContain("Protected message");
    expect(cleanupAudit.rows[0].details_json).not.toContain("encrypted-auth-state");
    expect(cleanupAudit.rows[0].details_json).not.toContain("+12025550001");
  });

  it("blocks the entire cleanup when a routing rule mixes Demo and protected accounts", async () => {
    const { database, repository } = await testRuntime();
    await seedDemo(database, repository, { nodeEnv: "test" });
    const [demoAccount] = await repository.listAccounts();
    const protectedAccount = await repository.createAccount({
      name: "Protected routing account",
      provider: "baileys",
      riskAccepted: true
    });
    const mixedRule = await repository.createRoutingRule({
      name: "Mixed rule",
      leadType: "mixed",
      region: "",
      preferredAccountId: demoAccount.id,
      fallbackAccountId: protectedAccount.id,
      priority: 1,
      enabled: true
    });

    const firstPlan = await planDemoCleanup(database);
    expect(firstPlan.counts).toMatchObject({
      demoAccounts: 2,
      demoRoutingRules: 2,
      blockedMixedRoutingRules: 1
    });
    expect(firstPlan.protectedCounts.routingRules).toBe(1);

    await database.query(
      "UPDATE routing_rules SET name='Changed mixed rule',updated_at=$2 WHERE id=$1",
      [mixedRule.id, "2099-01-01T00:00:00.000Z"]
    );
    const currentPlan = await planDemoCleanup(database);
    expect(currentPlan.protectedDigest).not.toBe(firstPlan.protectedDigest);
    await expect(applyDemoCleanup(database, firstPlan.planDigest)).rejects.toThrow(/plan changed/u);
    await expect(applyDemoCleanup(database, currentPlan.planDigest)).rejects.toThrow(/mix Demo and non-Demo/u);

    const remainingAccounts = await database.query<{ provider: string; count: number }>(
      "SELECT provider,COUNT(*)::int AS count FROM channel_accounts GROUP BY provider ORDER BY provider"
    );
    expect(remainingAccounts.rows).toEqual([
      { provider: "baileys", count: 1 },
      { provider: "demo", count: 2 }
    ]);
    const remainingRules = await database.query<{ id: string }>("SELECT id FROM routing_rules ORDER BY id");
    expect(remainingRules.rows).toHaveLength(3);
    expect(remainingRules.rows.some((row) => row.id === mixedRule.id)).toBe(true);
    const audits = await database.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action='maintenance.demo_cleanup'"
    );
    expect(Number(audits.rows[0].count)).toBe(0);
  });

  it("keeps dry-run read-only and never initializes an unmigrated database", async () => {
    const { database, repository } = await testRuntime();
    await seedDemo(database, repository, { nodeEnv: "test" });
    const dataSnapshot = async (): Promise<Record<string, number>> => {
      const result = await database.query<Record<string, number>>(
        `SELECT
          (SELECT COUNT(*)::int FROM schema_migrations) AS migrations,
          (SELECT COUNT(*)::int FROM channel_accounts) AS accounts,
          (SELECT COUNT(*)::int FROM contacts) AS contacts,
          (SELECT COUNT(*)::int FROM conversations) AS conversations,
          (SELECT COUNT(*)::int FROM messages) AS messages,
          (SELECT COUNT(*)::int FROM translations) AS translations,
          (SELECT COUNT(*)::int FROM routing_rules) AS routing_rules,
          (SELECT COUNT(*)::int FROM crm_contacts) AS crm_contacts,
          (SELECT COUNT(*)::int FROM ai_provider_profiles) AS ai_profiles,
          (SELECT COUNT(*)::int FROM audit_logs) AS audits`
      );
      return result.rows[0];
    };
    const before = await dataSnapshot();
    const report = await runCleanup(database, { apply: false });
    expect(report.hasTargets).toBe(true);
    expect(await dataSnapshot()).toEqual(before);

    const empty = await unmigratedDatabase();
    await expect(runCleanup(empty, { apply: false })).rejects.toThrow();
    await expect(
      runCleanup(empty, { apply: true, planDigest: "a".repeat(64) })
    ).rejects.toThrow();
    const applicationTables = await empty.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN ('schema_migrations','channel_accounts','audit_logs')`
    );
    expect(Number(applicationTables.rows[0].count)).toBe(0);
  });

  it("retains Mock profiles referenced by preferences or real-message translations", async () => {
    const { database, repository } = await testRuntime();
    const preferenceMock = await repository.createAiProfile({
      name: "Preference Mock",
      kind: "mock",
      model: "mock-preference"
    });
    await repository.updateTranslationPreference({ providerId: preferenceMock.id });

    const translationMock = await repository.createAiProfile({
      name: "Translation Mock",
      kind: "mock",
      model: "mock-real-message"
    });
    const account = await repository.createAccount({
      name: "Real account",
      provider: "baileys",
      riskAccepted: true
    });
    const contact = await repository.upsertContact({
      accountId: account.id,
      providerContactId: "12025550002@s.whatsapp.net",
      phone: "+12025550002",
      source: "baileys"
    });
    const conversation = await repository.ensureConversationForContact(contact.id);
    const message = await repository.createMessage({
      accountId: account.id,
      conversationId: conversation.id,
      providerMessageId: "real-mock-translation",
      direction: "inbound",
      body: "Keep the original message",
      status: "delivered"
    });
    await repository.createPendingTranslation({
      messageId: message.id,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      profileId: translationMock.id,
      model: translationMock.model,
      trigger: "manual"
    });

    const plan = await planDemoCleanup(database);
    expect(plan.counts).toMatchObject({ removableMockProfiles: 0, blockedMockProfiles: 2 });
    expect(plan.hasTargets).toBe(false);
    const result = await applyDemoCleanup(database, plan.planDigest);
    expect(result.deleted.mockProfiles).toBe(0);

    const mocks = await database.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM ai_provider_profiles WHERE kind='mock'"
    );
    expect(Number(mocks.rows[0].count)).toBe(2);
  });

  it("keeps cleanup CLI apply mode explicitly digest-gated", () => {
    expect(parseCleanupCliOptions([])).toEqual({ apply: false, planDigest: undefined });
    expect(() => parseCleanupCliOptions(["--apply"])).toThrow(/requires --plan-digest/u);
    expect(() => parseCleanupCliOptions(["--plan-digest=abc"])).toThrow(/together with --apply/u);
    expect(() => parseCleanupCliOptions(["--force"])).toThrow(/unknown/iu);
    expect(parseCleanupCliOptions(["--apply", `--plan-digest=${"a".repeat(64)}`])).toEqual({
      apply: true,
      planDigest: "a".repeat(64)
    });
  });
});
