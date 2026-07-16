import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import {
  listOwnerProspectQualification,
  ProspectQualificationError
} from "./prospect-qualification.js";
import {
  applyProspectQualificationCommandMysql,
  ensureProspectQualificationSchema,
  loadProspectQualificationState
} from "./prospect-qualification-mysql.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type {
  Organization,
  TenantProspect
} from "./types.js";

const masterSecret =
  "prospect-qualification-mysql-master-secret-v1-".repeat(2);
const at = (minute: number) =>
  new Date(Date.UTC(2026, 6, 15, 9, minute)).toISOString();
const hash = (seed: number) => seed.toString(16).padStart(64, "0");

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

function qualificationStore(
  teamId: string,
  ownerId: string,
  prospectId: string,
  organizationId: string
) {
  const base = getStore();
  const organization: Organization = {
    id: organizationId,
    teamId,
    scopeType: "team",
    scopeId: teamId,
    status: "active",
    legalName: "Qualification Persistence GmbH",
    normalizedName: "qualification persistence gmbh",
    organizationHash: hash(1),
    createdAt: at(0)
  };
  const prospect: TenantProspect = {
    id: prospectId,
    teamId,
    organizationId,
    status: "active",
    latestClassification: "net_new",
    queueState: "pending",
    queueReasonCode: "NET_NEW",
    firstSeenAt: at(0),
    lastSeenAt: at(0),
    lastMaterialChangeAt: at(0),
    lastQueuedAt: at(0),
    lastReviewedAt: "",
    nextReviewAt: "",
    hitCount: 1,
    sourceCount: 1,
    evidenceCount: 0,
    sourceKeyHashes: [hash(2)],
    materialEvidenceKeyHashes: [],
    exclusionScope: "none",
    exclusionMode: "none",
    exclusionReasonCode: "",
    excludedUntil: "",
    leadId: "",
    customerId: "",
    dealId: "",
    version: 1,
    eventCount: 1,
    eventTailHash: hash(3),
    prospectHash: hash(4),
    createdAt: at(0),
    updatedAt: at(0)
  };
  return {
    ...base,
    mode: "mysql",
    organizations: [organization],
    tenantProspects: [prospect],
    prospectEvidence: [],
    companyVerificationSnapshots: [],
    prospectIcpPolicySnapshots: [],
    prospectIcpAssessmentSnapshots: [],
    prospectContacts: [],
    prospectContactChannels: [],
    prospectContactVerificationSnapshots: [],
    prospectSuppressionEvents: [],
    prospectContactabilityDecisions: [],
    leads: [],
    customers: [],
    deals: [],
    websiteOpportunities: [],
    async persist() {
      // Qualification facts use their dedicated append-only persistence.
    },
    async readBarrier() {
      // The MySQL command path provides its own serialization.
    }
  } as CrmStore;
}

async function main() {
  const applicationUrl = process.env.DATABASE_URL
    || process.env.MYSQL_URL
    || process.env.MYSQL_TEST_ADMIN_URL;
  const adminConnectionUrl = process.env.MYSQL_TEST_ADMIN_URL
    || applicationUrl;
  if (!applicationUrl || !adminConnectionUrl) {
    throw new Error(
      "Qualification MySQL test requires MYSQL_TEST_ADMIN_URL, "
      + "DATABASE_URL or MYSQL_URL"
    );
  }

  const adminUrl = new URL(adminConnectionUrl);
  const appUrl = new URL(applicationUrl);
  const databaseName =
    `goodjob_qualification_test_${
      randomUUID().replaceAll("-", "").slice(0, 16)
    }`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let databaseCreated = false;
  let grantedAccount = "";
  let exitCode = 1;
  let pool: mysql.Pool | undefined;
  let testTeamId = "";

  try {
    const testUrl = new URL(applicationUrl);
    try {
      await admin.query(
        `CREATE DATABASE \`${databaseName}\`
         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      databaseCreated = true;

      const appProbe = await mysql.createConnection(
        connectionOptions(appUrl)
      );
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
      testUrl.pathname = `/${databaseName}`;
    } catch (error) {
      const code = String((error as { code?: string }).code || "");
      if (!["ER_DBACCESS_DENIED_ERROR", "ER_ACCESS_DENIED_ERROR"]
        .includes(code)) {
        throw error;
      }
    }
    if (!process.env.PROSPECT_QUALIFICATION_MASTER_SECRET
      && !process.env.PROSPECT_COVERAGE_MASTER_SECRET
      && !process.env.ORGANIZATION_IDENTITY_MASTER_SECRET) {
      process.env.PROSPECT_QUALIFICATION_MASTER_SECRET = masterSecret;
    }
    pool = mysql.createPool({
      uri: testUrl.toString(),
      connectionLimit: 4
    });
    await ensureProspectQualificationSchema(pool);

    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const teamId = `team-qualification-mysql-${suffix}`;
    testTeamId = teamId;
    const otherTeamId = "team-qualification-mysql-b";
    const ownerId = "owner-qualification-mysql-a";
    const otherOwnerId = "owner-qualification-mysql-b";
    const prospectId = "prospect-qualification-mysql-a";
    const organizationId = "organization-qualification-mysql-a";
    const store = qualificationStore(
      teamId,
      ownerId,
      prospectId,
      organizationId
    );
    const protectedCounts = {
      leads: store.leads.length,
      customers: store.customers.length,
      deals: store.deals.length,
      websiteOpportunities: store.websiteOpportunities.length
    };
    const command = {
      kind: "append_evidence" as const,
      teamId,
      ownerId,
      actorId: ownerId,
      prospectId,
      idempotencyKey: "mysql-evidence-registration",
      evidenceKind: "company_verification" as const,
      field: "registration_number" as const,
      value: "HRB 654321",
      sourceType: "authoritative_registry" as const,
      providerCode: "registry-test",
      sourceRef: "registry://qualification/hrb-654321",
      authorityCode: "DE-HRB",
      observedAt: at(1),
      expiresAt: at(120),
      createdAt: at(1)
    };

    const inserted = await applyProspectQualificationCommandMysql(
      pool,
      store,
      command
    );
    assert.equal(inserted.replayed, false);
    assert.equal(
      (await applyProspectQualificationCommandMysql(
        pool,
        store,
        command
      )).replayed,
      true
    );

    const coldState = await loadProspectQualificationState(pool, teamId);
    assert.equal(coldState.prospectEvidence.length, 1);
    assert.equal(
      coldState.prospectEvidence[0]?.normalizedValue,
      "hrb 654321"
    );
    assert.equal(
      (await loadProspectQualificationState(pool, otherTeamId))
        .prospectEvidence.length,
      0
    );

    const coldStore = qualificationStore(
      teamId,
      ownerId,
      prospectId,
      organizationId
    );
    Object.assign(coldStore, coldState);
    assert.equal(
      listOwnerProspectQualification(coldStore, {
        teamId,
        ownerId,
        prospectId
      }).evidence.length,
      1
    );
    assert.equal(
      listOwnerProspectQualification(coldStore, {
        teamId,
        ownerId: otherOwnerId,
        prospectId
      }).evidence.length,
      0
    );
    await assert.rejects(
      applyProspectQualificationCommandMysql(pool, coldStore, {
        ...command,
        ownerId: otherOwnerId,
        actorId: otherOwnerId,
        idempotencyKey: "mysql-cross-owner-conflict",
        kind: "compute_company_verification",
        evidenceIds: [inserted.record.id],
        validUntil: at(100),
        createdAt: at(2)
      }),
      (error: unknown) =>
        error instanceof ProspectQualificationError
        && error.code === "EVIDENCE_NOT_FOUND"
    );
    assert.deepEqual({
      leads: store.leads.length,
      customers: store.customers.length,
      deals: store.deals.length,
      websiteOpportunities: store.websiteOpportunities.length
    }, protectedCounts);

    const database = await mysql.createConnection({
      ...connectionOptions(testUrl),
      database: decodeURIComponent(testUrl.pathname.replace(/^\//u, ""))
    });
    const [factRows] = await database.query<Array<RowDataPacket>>(
      "SELECT encrypted_payload FROM prospect_qualification_facts"
    );
    assert.equal(factRows.length, 1);
    assert.equal(
      String(factRows[0]?.encrypted_payload || "").includes("HRB 654321"),
      false
    );
    await database.end();

    console.log(
      "Prospect qualification MySQL persistence and isolation tests passed"
    );
    exitCode = 0;
  } catch (error) {
    console.error(error);
  } finally {
    if (pool && testTeamId) {
      await pool.query(
        "DELETE FROM prospect_qualification_facts WHERE team_id = ?",
        [testTeamId]
      ).catch(() => undefined);
      await pool.query(
        "DELETE FROM prospect_qualification_team_guards WHERE team_id = ?",
        [testTeamId]
      ).catch(() => undefined);
    }
    if (pool) await pool.end();
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
