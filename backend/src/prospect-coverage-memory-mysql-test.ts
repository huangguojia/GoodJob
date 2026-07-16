import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import {
  ORGANIZATION_STRONG_IDENTITY_CONTRACT
} from "./organization-strong-identity.js";
import type {
  OrganizationIdentityClaimInput,
  ResolveOrganizationStrongIdentityPersistedInput
} from "./organization-strong-identity.js";
import {
  PROSPECT_COVERAGE_MEMORY_CONTRACT,
  ProspectCoverageMemoryError,
  listOwnerProspectCoverageEvents,
  listTenantProspects
} from "./prospect-coverage-memory.js";
import {
  ensureProspectCoverageSchema,
  loadProspectCoverageState
} from "./prospect-coverage-memory-mysql.js";
import {
  PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
  appendProspectSourceRawBatch,
  prospectProviderRawArtifactHash
} from "./prospect-source-raw.js";
import type {
  ProspectProviderSourceRecordInput
} from "./prospect-source-raw.js";
import { createMysqlStore } from "./mysql-store.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectSourceRawHit,
  ProspectSourceRawRecord
} from "./types.js";

const identityMasterSecret =
  "coverage-mysql-identity-master-secret-v1-".repeat(2);
const rawEnvelopeSecret =
  "coverage-mysql-raw-envelope-secret-v1-".repeat(2);
const rawIdentitySecret =
  "coverage-mysql-raw-identity-secret-v1-".repeat(2);
const coverageMasterSecret =
  "coverage-mysql-state-master-secret-v1-".repeat(2);
const at = (minute: number) =>
  new Date(Date.UTC(2026, 6, 14, 8, minute)).toISOString();
const hash = (seed: number) => seed.toString(16).padStart(64, "0");

type RawFixture = {
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  record: ProspectSourceRawRecord;
  hit: ProspectSourceRawHit;
};

let rawSequence = 0;
let resolutionSequence = 0;

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

function baseClaim(
  claim: Omit<
    OrganizationIdentityClaimInput,
    "normalizerVersion" | "validatorVersion" | "observedAt"
  >
): OrganizationIdentityClaimInput {
  return {
    ...claim,
    normalizerVersion: "claim-norm-v1",
    validatorVersion: "claim-validator-v1",
    observedAt: at(0)
  };
}

function identityClaims(registration: string) {
  return [
    baseClaim({
      kind: "registration_number",
      value: registration,
      normalizedValue: registration,
      scheme: "registry-a",
      jurisdiction: "DE",
      entityType: "legal_entity",
      subjectRef: "company"
    }),
    baseClaim({
      kind: "legal_name",
      value: "Coverage Test GmbH",
      jurisdiction: "DE",
      entityType: "legal_entity",
      subjectRef: "company"
    })
  ];
}

function createRawFixture(
  teamId: string,
  ownerId: string,
  connectionId: string
): RawFixture {
  rawSequence += 1;
  const suffix = String(rawSequence).padStart(4, "0");
  const fetchedAt = at(rawSequence);
  const runId = `coverage-run-${suffix}`;
  const shardId = `coverage-shard-${suffix}`;
  const sourceRecords: ProspectProviderSourceRecordInput[] = [{
    providerRecordId: `coverage-record-${suffix}`,
    sourceUrl: `https://coverage.example.test/${suffix}`,
    fetchedAt,
    payload: { company: "Coverage Test GmbH" }
  }];
  const baseStore = getStore();
  const generatorStore: CrmStore = {
    ...baseStore,
    mode: "memory",
    prospectSourceRawBatches: [],
    prospectSourceRawRecords: [],
    prospectSourceRawHits: [],
    async persist() {
      // Fixtures are inserted into the isolated MySQL database below.
    },
    async readBarrier() {
      // Fixture generation is synchronous.
    }
  };
  const result = appendProspectSourceRawBatch(generatorStore, {
    teamId,
    ownerId,
    runId,
    shardId,
    jobId: `coverage-job-${suffix}`,
    attemptId: `coverage-attempt-${suffix}`,
    ledgerId: `coverage-ledger-${suffix}`,
    pageId: `coverage-page-${suffix}`,
    providerCode: "identity.test-provider",
    connectionId,
    endpointCode: "company-identity",
    adapterVersion: "coverage-adapter-v1",
    responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
    responseHash: hash(rawSequence),
    settlementHash: hash(rawSequence + 10_000),
    rawArtifactHash: prospectProviderRawArtifactHash(sourceRecords),
    sourceRecords,
    policy: {
      licensePolicy: "coverage-public-api",
      retentionPolicy: "coverage-30-days",
      retentionDays: 30
    },
    envelopeSecret: rawEnvelopeSecret,
    identitySecret: rawIdentitySecret,
    createdAt: fetchedAt
  });
  return {
    teamId,
    ownerId,
    runId,
    shardId,
    record: result.records[0]!,
    hit: result.hits[0]!
  };
}

async function insertCoverageFixture(
  connection: mysql.Connection,
  fixture: RawFixture
) {
  const record = fixture.record;
  const hit = fixture.hit;
  await connection.query(
    `INSERT INTO prospect_source_raw_records (
       id,team_id,owner_id,provider_code,connection_id,endpoint_code,
       source_identity_hash,artifact_hash,envelope_version,
       encrypted_envelope,envelope_hash,first_observed_at,record_hash,
       created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      record.id,
      record.teamId,
      record.ownerId,
      record.providerCode,
      record.connectionId,
      record.endpointCode,
      record.sourceIdentityHash,
      record.artifactHash,
      record.envelopeVersion,
      record.encryptedEnvelope,
      record.envelopeHash,
      new Date(record.firstObservedAt),
      record.recordHash,
      new Date(record.createdAt)
    ]
  );
  await connection.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    await connection.query(
      `INSERT INTO prospect_search_runs (
         id,team_id,campaign_id,campaign_version,strategy_id,owner_id,
         status,revision_no,execution_epoch,operation_code,
         idempotency_key_hash,request_hash,query_fingerprint,
         execution_snapshot_json,execution_snapshot_hash,
         queue_bridge_version,parent_run_id,created_by,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        fixture.runId,
        fixture.teamId,
        `coverage-campaign-${rawSequence}`,
        1,
        `coverage-strategy-${rawSequence}`,
        fixture.ownerId,
        "succeeded",
        1,
        1,
        "create_search_run_v1",
        hash(rawSequence + 20_000),
        hash(rawSequence + 30_000),
        hash(rawSequence + 40_000),
        "{}",
        hash(rawSequence + 50_000),
        null,
        "",
        fixture.ownerId,
        new Date(record.createdAt),
        new Date(record.createdAt)
      ]
    );
    await connection.query(
      `INSERT INTO prospect_run_shards (
         id,team_id,run_id,provider_code,position_no,status,page_limit,
         result_limit,budget_limit,currency,adapter_version,
         contract_version,catalog_version,capabilities_json,access_mode,
         has_cursor,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        fixture.shardId,
        fixture.teamId,
        fixture.runId,
        record.providerCode,
        1,
        "succeeded",
        1,
        100,
        null,
        "",
        "coverage-adapter-v1",
        "coverage-contract-v1",
        "coverage-catalog-v1",
        "{}",
        "public_api",
        false,
        new Date(record.createdAt),
        new Date(record.createdAt)
      ]
    );
    await connection.query(
      `INSERT INTO prospect_source_raw_hits (
         id,batch_id,record_id,team_id,owner_id,run_id,shard_id,job_id,
         attempt_id,ledger_id,page_id,ordinal,fetched_at,hit_hash,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        hit.id,
        hit.batchId,
        hit.recordId,
        hit.teamId,
        hit.ownerId,
        hit.runId,
        hit.shardId,
        hit.jobId,
        hit.attemptId,
        hit.ledgerId,
        hit.pageId,
        hit.ordinal,
        new Date(hit.fetchedAt),
        hit.hitHash,
        new Date(hit.createdAt)
      ]
    );
  } finally {
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  }
}

function identityInput(
  fixture: RawFixture,
  registration: string
): ResolveOrganizationStrongIdentityPersistedInput {
  resolutionSequence += 1;
  return {
    teamId: fixture.teamId,
    ownerId: fixture.ownerId,
    rawRecordId: fixture.record.id,
    resolverVersion: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    parserVersion: "coverage-parser-v1",
    normalizerVersion: "coverage-normalizer-v1",
    resolvedAt: at(10 + resolutionSequence),
    authorityProfileCode: "identity-authority-test",
    authorityProfileVersion: "v1",
    claims: identityClaims(registration)
  };
}

function coverageInput(
  fixture: RawFixture,
  resolutionId: string,
  coveredAt: string,
  evidenceHash?: string
) {
  return {
    teamId: fixture.teamId,
    ownerId: fixture.ownerId,
    resolutionId,
    sourceHitId: fixture.hit.id,
    contractVersion: PROSPECT_COVERAGE_MEMORY_CONTRACT as
      typeof PROSPECT_COVERAGE_MEMORY_CONTRACT,
    evidenceVersion: "material-evidence-v1" as const,
    coveredAt,
    evidence: evidenceHash
      ? [{
          kind: "product_signal" as const,
          factHash: evidenceHash,
          observedAt: coveredAt
        }]
      : []
  };
}

function isCoverageIntegrityError(error: unknown) {
  return error instanceof ProspectCoverageMemoryError
    && error.code === "PROSPECT_COVERAGE_DATA_INTEGRITY_VIOLATION";
}

async function countBusinessRows(connection: mysql.Connection) {
  const counts: Record<string, number> = {};
  for (const table of ["leads", "customers", "deals"]) {
    const [rows] = await connection.query<Array<RowDataPacket>>(
      `SELECT COUNT(*) AS count FROM \`${table}\``
    );
    counts[table] = Number(rows[0]?.count || 0);
  }
  return counts;
}

async function main() {
  const applicationUrl = process.env.DATABASE_URL
    || process.env.MYSQL_URL
    || process.env.MYSQL_TEST_ADMIN_URL;
  const adminConnectionUrl = process.env.MYSQL_TEST_ADMIN_URL
    || applicationUrl;
  if (!applicationUrl || !adminConnectionUrl) {
    throw new Error(
      "Coverage MySQL test requires MYSQL_TEST_ADMIN_URL, "
      + "DATABASE_URL or MYSQL_URL"
    );
  }

  const adminUrl = new URL(adminConnectionUrl);
  const appUrl = new URL(applicationUrl);
  const databaseName =
    `goodjob_coverage_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
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
    process.env.ORGANIZATION_IDENTITY_MASTER_SECRET =
      identityMasterSecret;
    process.env.PROSPECT_SOURCE_RAW_ENVELOPE_SECRET =
      rawEnvelopeSecret;
    process.env.PROSPECT_COVERAGE_MASTER_SECRET =
      coverageMasterSecret;

    stage = "import deployment schema";
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

    const database = await mysql.createConnection({
      ...connectionOptions(testUrl),
      database: databaseName
    });
    const pool = mysql.createPool({
      uri: testUrl.toString(),
      connectionLimit: 4
    });

    stage = "schema and store startup";
    const store = await createMysqlStore();
    await ensureProspectCoverageSchema(pool);
    const [ownerKeyRows] = await database.query<Array<RowDataPacket>>(
      `SELECT constraint_name AS constraintName, column_name AS columnName
       FROM information_schema.key_column_usage
       WHERE table_schema = ?
         AND table_name = 'prospect_source_raw_hits'
         AND constraint_name IN (
           'fk_ps_raw_hit_batch','fk_ps_raw_hit_record'
         )
       ORDER BY constraint_name, ordinal_position`,
      [databaseName]
    );
    assert.deepEqual(
      ownerKeyRows.map((row) => [
        String(row.constraintName),
        String(row.columnName)
      ]),
      [
        ["fk_ps_raw_hit_batch", "team_id"],
        ["fk_ps_raw_hit_batch", "owner_id"],
        ["fk_ps_raw_hit_batch", "batch_id"],
        ["fk_ps_raw_hit_record", "team_id"],
        ["fk_ps_raw_hit_record", "owner_id"],
        ["fk_ps_raw_hit_record", "record_id"]
      ]
    );
    const businessBefore = await countBusinessRows(database);

    stage = "net new and idempotent replay";
    const first = createRawFixture("coverage-team-a", "owner-a", "source-a");
    await insertCoverageFixture(database, first);
    assert.ok(store.resolveOrganizationStrongIdentity);
    assert.ok(store.recordProspectCoverage);
    assert.ok(store.setTenantProspectDisposition);
    const firstIdentity = await store.resolveOrganizationStrongIdentity(
      identityInput(first, "COVERAGE-REG-100")
    );
    assert.ok(
      ["new_entity", "exact_match"].includes(
        firstIdentity.resolution.result
      )
        && firstIdentity.resolution.organizationId
        && firstIdentity.resolution.bindingId,
      JSON.stringify(firstIdentity.resolution)
    );
    const firstResult = await store.recordProspectCoverage(
      coverageInput(first, firstIdentity.resolution.id, at(20))
    );
    assert.equal(firstResult.classification, "net_new");
    assert.equal(firstResult.prospect.queueState, "pending");
    const replay = await store.recordProspectCoverage(
      coverageInput(first, firstIdentity.resolution.id, at(20))
    );
    assert.equal(replay.idempotent, true);

    stage = "cross owner duplicate and new intelligence";
    const duplicateSource =
      createRawFixture("coverage-team-a", "owner-b", "source-b");
    await insertCoverageFixture(database, duplicateSource);
    const duplicateIdentity =
      await store.resolveOrganizationStrongIdentity(
        identityInput(duplicateSource, "COVERAGE-REG-100")
      );
    assert.equal(
      duplicateIdentity.resolution.organizationId,
      firstIdentity.resolution.organizationId
    );
    const duplicate = await store.recordProspectCoverage(
      coverageInput(
        duplicateSource,
        duplicateIdentity.resolution.id,
        at(21)
      )
    );
    assert.equal(duplicate.classification, "duplicate");
    assert.equal(duplicate.prospect.sourceCount, 2);
    assert.equal(duplicate.prospect.queueState, "pending");

    const intelligenceSource =
      createRawFixture("coverage-team-a", "owner-b", "source-b");
    await insertCoverageFixture(database, intelligenceSource);
    const intelligenceIdentity =
      await store.resolveOrganizationStrongIdentity(
        identityInput(intelligenceSource, "COVERAGE-REG-100")
      );
    const intelligence = await store.recordProspectCoverage(
      coverageInput(
        intelligenceSource,
        intelligenceIdentity.resolution.id,
        at(22),
        hash(60_001)
      )
    );
    assert.equal(intelligence.classification, "new_intelligence");
    assert.equal(intelligence.prospect.sourceCount, 2);

    stage = "disposition persistence";
    const disposition = await store.setTenantProspectDisposition({
      teamId: "coverage-team-a",
      ownerId: "owner-a",
      prospectId: firstResult.prospect.id,
      requestId: "coverage-review-100",
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "mark_reviewed",
      reasonCode: "MANUAL_REVIEW_COMPLETED",
      effectiveAt: at(23),
      nextReviewAt: at(40)
    });
    assert.equal(disposition.prospect.queueState, "none");
    const dispositionReplay = await store.setTenantProspectDisposition({
      teamId: "coverage-team-a",
      ownerId: "owner-a",
      prospectId: firstResult.prospect.id,
      requestId: "coverage-review-100",
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "mark_reviewed",
      reasonCode: "MANUAL_REVIEW_COMPLETED",
      effectiveAt: at(23),
      nextReviewAt: at(40)
    });
    assert.equal(dispositionReplay.idempotent, true);

    stage = "team isolation and owner privacy";
    const otherTeam =
      createRawFixture("coverage-team-b", "owner-a", "source-a");
    await insertCoverageFixture(database, otherTeam);
    const otherIdentity = await store.resolveOrganizationStrongIdentity(
      identityInput(otherTeam, "COVERAGE-REG-100")
    );
    const otherResult = await store.recordProspectCoverage(
      coverageInput(otherTeam, otherIdentity.resolution.id, at(24))
    );
    assert.equal(otherResult.classification, "net_new");
    assert.equal(
      listTenantProspects(store, { teamId: "coverage-team-a" }).length,
      1
    );
    assert.equal(
      listTenantProspects(store, { teamId: "coverage-team-b" }).length,
      1
    );
    const ownerAEvents = listOwnerProspectCoverageEvents(store, {
      teamId: "coverage-team-a",
      ownerId: "owner-a"
    });
    const ownerBEvents = listOwnerProspectCoverageEvents(store, {
      teamId: "coverage-team-a",
      ownerId: "owner-b"
    });
    assert.ok(ownerAEvents.length > 0);
    assert.ok(ownerBEvents.length > 0);
    assert.ok(ownerAEvents.every((event) => event.ownerId === "owner-a"));
    assert.ok(ownerBEvents.every((event) => event.ownerId === "owner-b"));

    stage = "cold load and integrity rejection";
    const coldState = await loadProspectCoverageState(
      pool,
      "coverage-team-a"
    );
    assert.equal(coldState.tenantProspects.length, 1);
    assert.equal(coldState.prospectCoverageEvents.length, 4);
    const [prospectRows] = await database.query<Array<RowDataPacket>>(
      `SELECT id,row_mac FROM tenant_prospects
       WHERE team_id = 'coverage-team-a'`
    );
    const prospectRow = prospectRows[0]!;
    await database.query(
      "UPDATE tenant_prospects SET row_mac = ? WHERE id = ?",
      ["0".repeat(64), prospectRow.id]
    );
    await assert.rejects(
      loadProspectCoverageState(pool, "coverage-team-a"),
      isCoverageIntegrityError
    );
    await database.query(
      "UPDATE tenant_prospects SET row_mac = ? WHERE id = ?",
      [prospectRow.row_mac, prospectRow.id]
    );
    const [eventRows] = await database.query<Array<RowDataPacket>>(
      `SELECT id,row_mac FROM prospect_coverage_events
       WHERE team_id = 'coverage-team-a'
       ORDER BY sequence_no LIMIT 1`
    );
    const eventRow = eventRows[0]!;
    await database.query(
      "UPDATE prospect_coverage_events SET row_mac = ? WHERE id = ?",
      ["f".repeat(64), eventRow.id]
    );
    await assert.rejects(
      loadProspectCoverageState(pool, "coverage-team-a"),
      isCoverageIntegrityError
    );
    await database.query(
      "UPDATE prospect_coverage_events SET row_mac = ? WHERE id = ?",
      [eventRow.row_mac, eventRow.id]
    );
    assert.deepEqual(await countBusinessRows(database), businessBefore);

    await database.end();
    await pool.end();
    console.log(
      "Prospect coverage MySQL schema, persistence, isolation, cold load "
      + "and integrity tests passed"
    );
    exitCode = 0;
  } catch (error) {
    console.error(`Prospect coverage MySQL test failed at: ${stage}`);
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
      await admin.query(
        `DROP DATABASE IF EXISTS \`${databaseName}\``
      );
    }
    await admin.end();
    process.exit(exitCode);
  }
}

await main();
