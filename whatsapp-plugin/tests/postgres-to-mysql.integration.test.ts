import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config";
import { createDatabase, type Database } from "../src/server/db/database";
import { migrate } from "../src/server/db/migrate";
import { Repository } from "../src/server/db/repository";
import { seed, seedDemo } from "../src/server/db/seed";
import {
  migrateCommunicationSnapshot,
  prepareMysqlCommunicationTarget
} from "../src/server/scripts/migrate-postgres-to-mysql";

const mysqlUrl = process.env.TEST_MYSQL_MIGRATION_DATABASE_URL?.trim();
const describeMigration = mysqlUrl ? describe : describe.skip;

describeMigration("PostgreSQL to MySQL Communication migration", () => {
  let source: Database;
  let target: Database;
  let protectedAccountId = "";
  let unownedCollisionRejected = false;

  beforeAll(async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "communication-migration-source-"));
    const sourceConfig: AppConfig = {
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://127.0.0.1",
      databaseClient: "pglite",
      pglitePath: path.join(directory, "pgdata"),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: false,
      allowPrivateAiEndpoints: false
    };
    source = await createDatabase(sourceConfig);
    await migrate(source);
    const repository = new Repository(source);
    await seed(source, repository, sourceConfig);
    await seedDemo(source, repository, { nodeEnv: "test" });

    const account = await repository.createAccount({
      name: "Protected Meta account",
      provider: "meta",
      phone: "+12025550999",
      riskAccepted: true,
      ownerUserId: "migration-user"
    });
    protectedAccountId = account.id;
    await repository.setSessionValue(account.id, "creds", "primary", "encrypted-migration-session");
    await repository.setSessionValue(account.id, "keys", "key-2", "encrypted-migration-key");
    const app = await repository.createMetaApp({
      name: "Migration Meta app",
      appId: "migration-app-id",
      appSecretCipher: "encrypted-app-secret",
      appSecretMask: "****cret",
      verifyTokenDigest: "verify-token-digest",
      verifyTokenMask: "****oken",
      webhookKey: "migration-webhook-key",
      ownerUserId: "migration-user"
    });
    await repository.upsertMetaConfiguration({
      accountId: account.id,
      appConfigId: app.id,
      wabaId: "migration-waba",
      phoneNumberId: "migration-phone-number",
      accessTokenCipher: "encrypted-access-token",
      accessTokenMask: "****oken",
      graphApiVersion: "v23.0"
    });
    await repository.audit("migration.fixture", "account", account.id, "success", { preserved: true });

    target = await createDatabase({ ...sourceConfig, databaseClient: "mysql", databaseUrl: mysqlUrl });
    await target.exec("CREATE TABLE contacts (id VARCHAR(191) PRIMARY KEY) ENGINE=InnoDB");
    try {
      await prepareMysqlCommunicationTarget(target);
    } catch (error) {
      unownedCollisionRejected = /Refusing to adopt unowned tables/u.test(String(error));
    }
    await target.exec("DROP TABLE contacts");
    await prepareMysqlCommunicationTarget(target);
  });

  afterAll(async () => {
    await Promise.all([source?.close(), target?.close()]);
  });

  it("copies every table in small pages and records a verified cutover", async () => {
    expect(unownedCollisionRejected).toBe(true);
    const summaries = await migrateCommunicationSnapshot(source, target, { apply: true, batchSize: 2 });
    expect(summaries).toHaveLength(15);
    expect(summaries.find((item) => item.table === "channel_accounts")?.rows).toBe(3);
    expect(summaries.find((item) => item.table === "provider_session_keys")?.rows).toBe(2);

    const repository = new Repository(target);
    expect(await repository.getSessionValue(protectedAccountId, "creds", "primary")).toBe(
      "encrypted-migration-session"
    );
    const meta = await repository.getMetaCredentialSecret(protectedAccountId);
    expect(meta).toMatchObject({
      appSecretCipher: "encrypted-app-secret",
      accessTokenCipher: "encrypted-access-token"
    });
    expect((await target.query("SELECT id FROM communication_data_migrations")).rows).toHaveLength(1);
  });

  it("supports read-only re-verification and blocks a second destructive apply", async () => {
    await expect(migrateCommunicationSnapshot(source, target, { apply: false, batchSize: 2 })).resolves.toHaveLength(15);
    await expect(migrateCommunicationSnapshot(source, target, { apply: true, batchSize: 2 })).rejects.toThrow(
      /already complete/u
    );
    await expect(
      migrateCommunicationSnapshot(source, target, { apply: true, resumeCompleted: true, batchSize: 2 })
    ).resolves.toHaveLength(15);
    expect((await target.query("SELECT id FROM communication_data_migrations")).rows).toHaveLength(1);
  });

  it("refuses a completed resume when the legacy source changed after rollback", async () => {
    await source.query("UPDATE audit_logs SET details_json='{}' WHERE action='migration.fixture'");
    await expect(
      migrateCommunicationSnapshot(source, target, { apply: true, resumeCompleted: true, batchSize: 2 })
    ).rejects.toThrow(/Verification failed for audit_logs/u);
    await source.query(
      "UPDATE audit_logs SET details_json=$1 WHERE action='migration.fixture'",
      [JSON.stringify({ preserved: true })]
    );
    await expect(migrateCommunicationSnapshot(source, target, { apply: false, batchSize: 2 })).resolves.toHaveLength(15);
  });

  it("detects target drift by row count, primary keys, and full content", async () => {
    await target.query("UPDATE audit_logs SET details_json='{}' WHERE action='migration.fixture'");
    await expect(migrateCommunicationSnapshot(source, target, { apply: false, batchSize: 2 })).rejects.toThrow(
      /Verification failed for audit_logs/u
    );
  });
});
