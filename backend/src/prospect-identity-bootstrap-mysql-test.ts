import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { publicUser } from "./auth.js";
import { createMysqlStore } from "./mysql-store.js";
import {
  attachProspectIdentityBootstrapRun,
  beginProspectIdentityBootstrap
} from "./prospect-identity-bootstrap.js";
import type {
  ProspectIdentityBootstrapAttempt,
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
  const configuredUrl = process.env.MYSQL_TEST_ADMIN_URL;
  if (!configuredUrl) {
    throw new Error(
      "Prospect identity bootstrap MySQL test requires "
      + "MYSQL_TEST_ADMIN_URL"
    );
  }
  const adminUrl = new URL(configuredUrl);
  const databaseName = `goodjob_identity_bootstrap_test_${
    randomUUID().replaceAll("-", "").slice(0, 12)
  }`;
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

    const store = await createMysqlStore();
    const owner = store.users.find((item) => item.id === "u_sales_shirley");
    assert.ok(owner);
    const user = publicUser(owner);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const candidate: WebsiteOpportunity = {
      id: `identity-bootstrap-mysql-${suffix}`,
      company: "MySQL Bootstrap Candidate",
      business: "Industrial products",
      country: "Global",
      website: `https://identity-bootstrap-${suffix}.example.test`,
      contact: "Purchasing",
      contactInfo: "",
      description: "Reference-only candidate",
      ownerId: owner.id,
      teamId: owner.teamId,
      status: "preview",
      createdAt: "2026-07-26T00:00:00.000Z",
      parseMode: "reference",
      source: "website-reference",
      sourceLabel: "官网链接登记",
      sourceEvidence: [],
      identityBootstrapAttempts: []
    };
    store.websiteOpportunities.unshift(candidate);
    assert.ok(store.persistProspectCandidates);
    await store.persistProspectCandidates([candidate.id]);

    const attempt: ProspectIdentityBootstrapAttempt = {
      id: `pib_mysql_${suffix}`,
      version: "prospect-identity-bootstrap-v1",
      requestIdHash: "a".repeat(64),
      providerId: "gleif",
      registrationNumber: "529900T8BM49AURSDO55",
      normalizedIdentifier: "529900T8BM49AURSDO55",
      taskStatus: "running",
      outcome: "pending",
      campaignId: "",
      campaignVersion: 0,
      strategyId: "",
      runId: "",
      sourceCandidateId: "",
      sourceRawRecordId: "",
      sourceHitId: "",
      resolutionId: "",
      conflictId: "",
      organizationId: "",
      tenantProspectId: "",
      errorCode: "",
      errorMessage: "",
      events: [{
        id: `pib_mysql_${suffix}:event:1`,
        sequence: 1,
        stage: "validation",
        status: "completed",
        label: "权威注册号已校验",
        detail: "GLEIF LEI · 529900T8BM49AURSDO55",
        createdAt: "2026-07-26T00:00:00.000Z"
      }],
      createdBy: owner.id,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      endedAt: ""
    };
    const begun = await beginProspectIdentityBootstrap({
      store,
      user,
      candidateId: candidate.id,
      attempt
    });
    assert.equal(begun.replayed, false);

    const coldStore = await createMysqlStore();
    const coldCandidate = coldStore.websiteOpportunities.find((item) =>
      item.id === candidate.id
    );
    assert.ok(coldCandidate);
    assert.equal(coldCandidate.identityBootstrapAttempts?.length, 1);
    assert.equal(
      coldCandidate.identityBootstrapAttempts?.[0]?.registrationNumber,
      "529900T8BM49AURSDO55"
    );

    await attachProspectIdentityBootstrapRun({
      store: coldStore,
      user: publicUser(
        coldStore.users.find((item) => item.id === owner.id)!
      ),
      candidateId: candidate.id,
      attemptId: attempt.id,
      campaignId: `campaign-${suffix}`,
      campaignVersion: 1,
      strategyId: `strategy-${suffix}`,
      runId: `run-${suffix}`,
      at: "2026-07-26T00:01:00.000Z"
    });

    const finalStore = await createMysqlStore();
    const persisted = finalStore.websiteOpportunities.find((item) =>
      item.id === candidate.id
    )?.identityBootstrapAttempts?.[0];
    assert.ok(persisted);
    assert.equal(persisted.runId, `run-${suffix}`);
    assert.equal(persisted.campaignId, `campaign-${suffix}`);
    assert.deepEqual(
      persisted.events.map((item) => item.stage),
      ["validation", "campaign"]
    );

    const [columnRows] = await admin.query<mysql.RowDataPacket[]>(
      `SELECT identity_bootstrap_attempts_json AS attempts
       FROM \`${databaseName}\`.website_opportunities WHERE id = ?`,
      [candidate.id]
    );
    assert.equal(columnRows.length, 1);
    assert.ok(columnRows[0]?.attempts);

    console.log(JSON.stringify({
      ok: true,
      candidateId: candidate.id,
      attemptId: persisted.id,
      runId: persisted.runId,
      coldRestartPersisted: true
    }, null, 2));
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
