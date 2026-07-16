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
  PROSPECT_COVERAGE_MEMORY_CONTRACT
} from "./prospect-coverage-memory.js";
import {
  ensureProspectCoverageSchema,
  loadProspectCoverageState
} from "./prospect-coverage-memory-mysql.js";
import {
  normalizeProspectCampaignSnapshot,
  prospectCampaignSnapshotHash
} from "./prospect-campaigns.js";
import {
  prospectRunExecutionSnapshotHash
} from "./prospect-runs.js";
import {
  normalizeProspectStrategyProviderPlan,
  normalizeProspectStrategyQuery,
  prospectStrategyFingerprint,
  resolveProspectStrategyQuery
} from "./prospect-strategies.js";
import {
  ensureProspectQualificationSchema
} from "./prospect-qualification-mysql.js";
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
  ProspectCampaign,
  ProspectCampaignVersion,
  ProspectRunEvent,
  ProspectRunExecutionSnapshot,
  ProspectRunShard,
  ProspectSearchRun,
  ProspectSourceRawHit,
  ProspectSourceRawRecord,
  ProspectStrategy,
  ProspectStrategyEvent
} from "./types.js";

const identityMasterSecret =
  "conversion-mysql-identity-master-secret-v1-".repeat(2);
const rawEnvelopeSecret =
  "conversion-mysql-raw-envelope-secret-v1-".repeat(2);
const rawIdentitySecret =
  "conversion-mysql-raw-identity-secret-v1-".repeat(2);
const coverageMasterSecret =
  "conversion-mysql-coverage-master-secret-v1-".repeat(2);
const qualificationMasterSecret =
  "conversion-mysql-qualification-master-secret-v1-".repeat(2);
const at = (minute: number) =>
  new Date(Date.UTC(2026, 6, 15, 9, minute)).toISOString();
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
      value: `Conversion ${registration} GmbH`,
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
  const runId = `pr_${randomUUID()}`;
  const shardId = `prsh_${randomUUID()}`;
  const sourceRecords: ProspectProviderSourceRecordInput[] = [{
    providerRecordId: `conversion-record-${suffix}`,
    sourceUrl: `https://conversion.example.test/${suffix}`,
    fetchedAt,
    payload: { company: `Conversion Test ${suffix} GmbH` }
  }];
  const baseStore = getStore();
  const generatorStore: CrmStore = {
    ...baseStore,
    mode: "memory",
    prospectSourceRawBatches: [],
    prospectSourceRawRecords: [],
    prospectSourceRawHits: [],
    async persist() {
      // Fixtures are inserted into the isolated database below.
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
    jobId: `conversion-job-${suffix}`,
    attemptId: `conversion-attempt-${suffix}`,
    ledgerId: `conversion-ledger-${suffix}`,
    pageId: `conversion-page-${suffix}`,
    providerCode: "identity.test-provider",
    connectionId,
    endpointCode: "company-identity",
    adapterVersion: "conversion-adapter-v1",
    responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
    responseHash: hash(rawSequence),
    settlementHash: hash(rawSequence + 10_000),
    rawArtifactHash: prospectProviderRawArtifactHash(sourceRecords),
    sourceRecords,
    policy: {
      licensePolicy: "conversion-public-api",
      retentionPolicy: "conversion-30-days",
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

async function insertRawFixture(
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
    parserVersion: "conversion-parser-v1",
    normalizerVersion: "conversion-normalizer-v1",
    resolvedAt: at(10 + resolutionSequence),
    authorityProfileCode: "identity-authority-test",
    authorityProfileVersion: "v1",
    claims: identityClaims(registration)
  };
}

function coverageInput(
  fixture: RawFixture,
  resolutionId: string,
  coveredAt: string
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
    evidence: []
  };
}

async function addCampaign(
  store: CrmStore,
  connection: mysql.Connection,
  teamId: string,
  ownerId: string,
  campaignId: string,
  suffix: string,
  fixture: RawFixture
) {
  const snapshot = normalizeProspectCampaignSnapshot({
    goal: "Find qualified distributors",
    products: ["industrial lighting"],
    markets: ["DE"],
    customerTypes: ["distributor"],
    applicationScenarios: ["industrial retrofit"],
    icpRules: ["public product catalog"],
    exclusionRules: [],
    sourceProviderIds: ["identity.test-provider"]
  });
  const campaign: ProspectCampaign = {
    id: campaignId,
    teamId,
    ownerId,
    name: `Conversion Campaign ${suffix}`,
    status: "active",
    currentVersion: 1,
    revision: 1,
    createdBy: ownerId,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: ""
  };
  const version: ProspectCampaignVersion = {
    id: `pcv_${randomUUID()}`,
    teamId,
    campaignId,
    version: 1,
    snapshot,
    contentHash: prospectCampaignSnapshotHash(snapshot),
    changeSummary: "Initial version",
    createdBy: ownerId,
    createdAt: at(0)
  };
  const query = normalizeProspectStrategyQuery();
  const providerPlan = normalizeProspectStrategyProviderPlan([{
    providerId: fixture.record.providerCode,
    priority: 10,
    pageLimit: 1,
    resultLimit: 100,
    budgetLimit: null,
    currency: ""
  }]);
  const strategy: ProspectStrategy = {
    id: `ps_${randomUUID()}`,
    teamId,
    campaignId,
    campaignVersion: 1,
    name: `Conversion Strategy ${suffix}`,
    status: "approved",
    revision: 2,
    query,
    providerPlan,
    queryFingerprint: prospectStrategyFingerprint({
      version,
      query,
      providerPlan
    }),
    fingerprintVersion: "v1",
    ownerId,
    createdBy: ownerId,
    approvedBy: ownerId,
    approvedAt: at(1),
    disabledBy: "",
    disabledAt: "",
    disableReason: "",
    createdAt: at(0),
    updatedAt: at(1)
  };
  const strategyEvents: ProspectStrategyEvent[] = [{
    id: `pse_${randomUUID()}`,
    teamId,
    campaignId,
    strategyId: strategy.id,
    eventType: "created",
    actorId: ownerId,
    requestId: `conversion-strategy-create-${suffix}`,
    fromStatus: "",
    toStatus: "draft",
    fromRevision: 0,
    toRevision: 1,
    reason: "Create conversion test strategy",
    createdAt: at(0)
  }, {
    id: `pse_${randomUUID()}`,
    teamId,
    campaignId,
    strategyId: strategy.id,
    eventType: "approved",
    actorId: ownerId,
    requestId: `conversion-strategy-approve-${suffix}`,
    fromStatus: "draft",
    toStatus: "approved",
    fromRevision: 1,
    toRevision: 2,
    reason: "Approve conversion test strategy",
    createdAt: at(1)
  }];
  const executionSnapshot: ProspectRunExecutionSnapshot = {
    contractVersion: "search_run_control_plane_v1",
    campaign: {
      id: campaign.id,
      name: campaign.name,
      version: version.version,
      contentHash: version.contentHash,
      snapshot: structuredClone(version.snapshot)
    },
    strategy: {
      id: strategy.id,
      name: strategy.name,
      revision: strategy.revision,
      fingerprintVersion: strategy.fingerprintVersion,
      queryFingerprint: strategy.queryFingerprint,
      query: structuredClone(strategy.query)
    },
    resolvedQuery: resolveProspectStrategyQuery(strategy.query, version),
    providerPlan: [{
      providerCode: fixture.record.providerCode,
      position: 1,
      priority: providerPlan[0]!.priority,
      pageLimit: providerPlan[0]!.pageLimit,
      resultLimit: providerPlan[0]!.resultLimit,
      budgetLimit: providerPlan[0]!.budgetLimit,
      currency: providerPlan[0]!.currency,
      adapterVersion: "conversion-adapter-v1",
      contractVersion: "conversion-contract-v1",
      catalogVersion: "conversion-catalog-v1",
      capabilities: [],
      accessMode: "api"
    }]
  };
  const run: ProspectSearchRun = {
    id: fixture.runId,
    teamId,
    campaignId,
    campaignVersion: 1,
    strategyId: strategy.id,
    ownerId,
    status: "succeeded",
    revision: 3,
    executionEpoch: 1,
    operationCode: "create_search_run_v1",
    idempotencyKeyHash: hash(rawSequence + 20_000),
    requestHash: hash(rawSequence + 30_000),
    queryFingerprint: strategy.queryFingerprint,
    executionSnapshot,
    executionSnapshotHash:
      prospectRunExecutionSnapshotHash(executionSnapshot),
    queueBridgeVersion: null,
    parentRunId: "",
    createdBy: ownerId,
    createdAt: at(0),
    updatedAt: at(2),
    pausedAt: "",
    cancelledAt: ""
  };
  const shard: ProspectRunShard = {
    id: fixture.shardId,
    teamId,
    runId: run.id,
    providerCode: fixture.record.providerCode,
    position: 1,
    status: "succeeded",
    pageLimit: 1,
    resultLimit: 100,
    budgetLimit: null,
    currency: "",
    adapterVersion: "conversion-adapter-v1",
    contractVersion: "conversion-contract-v1",
    catalogVersion: "conversion-catalog-v1",
    capabilities: [],
    accessMode: "api",
    hasCursor: false,
    createdAt: at(0),
    updatedAt: at(2)
  };
  const runEvents: ProspectRunEvent[] = [{
    id: `pre_${randomUUID()}`,
    teamId,
    runId: run.id,
    sequence: 1,
    eventType: "created",
    actorId: ownerId,
    requestId: `conversion-run-create-${suffix}`,
    fromStatus: "",
    toStatus: "queued",
    fromRevision: 0,
    toRevision: 1,
    reason: "Create conversion test run",
    createdAt: at(0)
  }, {
    id: `pre_${randomUUID()}`,
    teamId,
    runId: run.id,
    sequence: 2,
    eventType: "started",
    actorId: ownerId,
    requestId: `conversion-run-start-${suffix}`,
    fromStatus: "queued",
    toStatus: "running",
    fromRevision: 1,
    toRevision: 2,
    reason: "Start conversion test run",
    createdAt: at(1)
  }, {
    id: `pre_${randomUUID()}`,
    teamId,
    runId: run.id,
    sequence: 3,
    eventType: "completed",
    actorId: ownerId,
    requestId: `conversion-run-complete-${suffix}`,
    fromStatus: "running",
    toStatus: "succeeded",
    fromRevision: 2,
    toRevision: 3,
    reason: "Complete conversion test run",
    createdAt: at(2)
  }];
  await connection.query(
    `INSERT INTO prospect_campaigns (
       id,team_id,owner_id,name,status,current_version,revision_no,
       created_by,created_at,updated_at,archived_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      campaign.id,
      campaign.teamId,
      campaign.ownerId,
      campaign.name,
      campaign.status,
      campaign.currentVersion,
      campaign.revision,
      campaign.createdBy,
      new Date(campaign.createdAt),
      new Date(campaign.updatedAt),
      null
    ]
  );
  await connection.query(
    `INSERT INTO prospect_campaign_versions (
       id,team_id,campaign_id,version_no,snapshot_json,content_hash,
       change_summary,created_by,created_at
     ) VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      version.id,
      version.teamId,
      version.campaignId,
      version.version,
      JSON.stringify(version.snapshot),
      version.contentHash,
      version.changeSummary,
      version.createdBy,
      new Date(version.createdAt)
    ]
  );
  await connection.query(
    `INSERT INTO prospect_strategies (
       id,team_id,campaign_id,campaign_version,owner_id,name,status,
       revision_no,execution_epoch,query_json,provider_plan_json,
       query_fingerprint,fingerprint_version,created_by,approved_by,
       approved_at,disabled_by,disabled_at,disable_reason,created_at,
       updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      strategy.id,
      strategy.teamId,
      strategy.campaignId,
      strategy.campaignVersion,
      strategy.ownerId,
      strategy.name,
      strategy.status,
      strategy.revision,
      1,
      JSON.stringify(strategy.query),
      JSON.stringify(strategy.providerPlan),
      strategy.queryFingerprint,
      strategy.fingerprintVersion,
      strategy.createdBy,
      strategy.approvedBy,
      new Date(strategy.approvedAt),
      "",
      null,
      "",
      new Date(strategy.createdAt),
      new Date(strategy.updatedAt)
    ]
  );
  for (const event of strategyEvents) {
    await connection.query(
      `INSERT INTO prospect_strategy_events (
         id,team_id,campaign_id,strategy_id,event_type,actor_id,
         request_id,from_status,to_status,from_revision,to_revision,
         reason,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        event.id,
        event.teamId,
        event.campaignId,
        event.strategyId,
        event.eventType,
        event.actorId,
        event.requestId,
        event.fromStatus,
        event.toStatus,
        event.fromRevision,
        event.toRevision,
        event.reason,
        new Date(event.createdAt)
      ]
    );
  }
  await connection.query(
    `INSERT INTO prospect_search_runs (
       id,team_id,campaign_id,campaign_version,strategy_id,owner_id,
       status,revision_no,execution_epoch,operation_code,
       idempotency_key_hash,request_hash,query_fingerprint,
       execution_snapshot_json,execution_snapshot_hash,
       queue_bridge_version,parent_run_id,created_by,created_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      run.id,
      run.teamId,
      run.campaignId,
      run.campaignVersion,
      run.strategyId,
      run.ownerId,
      run.status,
      run.revision,
      run.executionEpoch,
      run.operationCode,
      run.idempotencyKeyHash,
      run.requestHash,
      run.queryFingerprint,
      JSON.stringify(run.executionSnapshot),
      run.executionSnapshotHash,
      run.queueBridgeVersion,
      run.parentRunId,
      run.createdBy,
      new Date(run.createdAt),
      new Date(run.updatedAt)
    ]
  );
  for (const event of runEvents) {
    await connection.query(
      `INSERT INTO prospect_run_events (
         id,team_id,run_id,sequence_no,event_type,actor_id,request_id,
         from_status,to_status,from_revision,to_revision,reason,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        event.id,
        event.teamId,
        event.runId,
        event.sequence,
        event.eventType,
        event.actorId,
        event.requestId,
        event.fromStatus,
        event.toStatus,
        event.fromRevision,
        event.toRevision,
        event.reason,
        new Date(event.createdAt)
      ]
    );
  }
  await connection.query(
    `INSERT INTO prospect_run_shards (
       id,team_id,run_id,provider_code,position_no,status,page_limit,
       result_limit,budget_limit,currency,adapter_version,
       contract_version,catalog_version,capabilities_json,access_mode,
       has_cursor,created_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      shard.id,
      shard.teamId,
      shard.runId,
      shard.providerCode,
      shard.position,
      shard.status,
      shard.pageLimit,
      shard.resultLimit,
      shard.budgetLimit,
      shard.currency,
      shard.adapterVersion,
      shard.contractVersion,
      shard.catalogVersion,
      JSON.stringify(shard.capabilities),
      shard.accessMode,
      shard.hasCursor,
      new Date(shard.createdAt),
      new Date(shard.updatedAt)
    ]
  );
  store.prospectCampaigns.push(campaign);
  store.prospectCampaignVersions.push(version);
  store.prospectStrategies.push(strategy);
  store.prospectStrategyEvents.push(...strategyEvents);
  store.prospectSearchRuns.push(run);
  store.prospectRunShards.push(shard);
  store.prospectRunEvents.push(...runEvents);
}

async function qualifyProspect(
  store: CrmStore,
  input: {
    teamId: string;
    ownerId: string;
    prospectId: string;
    campaignId: string;
    suffix: string;
    offset: number;
  }
) {
  assert.ok(store.applyProspectQualification);
  const apply = store.applyProspectQualification;
  const registration = await apply({
    kind: "append_evidence",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-registration-${input.suffix}`,
    evidenceKind: "company_verification",
    field: "registration_number",
    value: `HRB-${input.suffix}`,
    sourceType: "authoritative_registry",
    providerCode: "registry-test",
    sourceRef: `registry://conversion/${input.suffix}`,
    authorityCode: "DE-HRB",
    observedAt: at(input.offset + 1),
    expiresAt: at(input.offset + 100),
    createdAt: at(input.offset + 1)
  });
  const active = await apply({
    kind: "append_evidence",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-active-${input.suffix}`,
    evidenceKind: "company_verification",
    field: "operating_status",
    value: "active",
    sourceType: "authoritative_registry",
    providerCode: "registry-test",
    sourceRef: `registry://conversion/${input.suffix}/status`,
    authorityCode: "DE-HRB",
    observedAt: at(input.offset + 2),
    expiresAt: at(input.offset + 100),
    createdAt: at(input.offset + 2)
  });
  const product = await apply({
    kind: "append_evidence",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-product-${input.suffix}`,
    evidenceKind: "icp",
    field: "product_match",
    value: "industrial lighting distributor catalog",
    sourceType: "official_website",
    providerCode: "official-website",
    sourceRef: `https://${input.suffix}.example.test/products`,
    observedAt: at(input.offset + 3),
    expiresAt: at(input.offset + 100),
    createdAt: at(input.offset + 3)
  });
  const contactEvidence = await apply({
    kind: "append_evidence",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-contact-evidence-${input.suffix}`,
    evidenceKind: "contact",
    field: "contact_source",
    value: `sales@${input.suffix}.example.test`,
    sourceType: "official_website",
    providerCode: "official-website",
    sourceRef: `https://${input.suffix}.example.test/contact`,
    observedAt: at(input.offset + 4),
    expiresAt: at(input.offset + 100),
    createdAt: at(input.offset + 4)
  });
  await apply({
    kind: "compute_company_verification",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-company-verification-${input.suffix}`,
    evidenceIds: [registration.record.id, active.record.id],
    validUntil: at(input.offset + 100),
    createdAt: at(input.offset + 5)
  });
  const policy = await apply({
    kind: "publish_icp_policy",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-policy-${input.suffix}`,
    campaignId: input.campaignId,
    campaignVersion: 1,
    hardExclusions: [],
    createdAt: at(input.offset + 6)
  });
  const assessment = await apply({
    kind: "assess_icp",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-assessment-${input.suffix}`,
    policyId: policy.record.id,
    dimensionScores: {
      productApplicationMatch: 25,
      customerType: 12,
      marketCountry: 9,
      companyAuthenticity: 15,
      purchasingChannelCapability: 12,
      contactability: 8,
      freshness: 5
    },
    evidenceIds: [registration.record.id, product.record.id],
    createdAt: at(input.offset + 7)
  });
  await apply({
    kind: "review_icp",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-assessment-review-${input.suffix}`,
    assessmentId: assessment.record.id,
    decision: "approved",
    createdAt: at(input.offset + 8)
  });
  const contact = await apply({
    kind: "add_contact",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-contact-${input.suffix}`,
    contactType: "department",
    department: "Sales",
    identityStatus: "source_confirmed",
    sourceEvidenceId: contactEvidence.record.id,
    createdAt: at(input.offset + 9)
  });
  const channel = await apply({
    kind: "add_contact_channel",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-channel-${input.suffix}`,
    contactId: contact.record.id,
    channelType: "email",
    value: `sales@${input.suffix}.example.test`,
    sourceEvidenceId: contactEvidence.record.id,
    acquiredAt: at(input.offset + 4),
    createdAt: at(input.offset + 10)
  });
  await apply({
    kind: "verify_contact_channel",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-channel-verification-${input.suffix}`,
    channelId: channel.record.id,
    status: "verified",
    providerCode: "email-verifier",
    verifiedAt: at(input.offset + 11),
    expiresAt: at(input.offset + 100),
    createdAt: at(input.offset + 11)
  });
  const eligible = await apply({
    kind: "evaluate_contactability",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-contactability-${input.suffix}`,
    campaignId: input.campaignId,
    campaignVersion: 1,
    channelId: channel.record.id,
    createdAt: at(input.offset + 12)
  });
  const approved = await apply({
    kind: "approve_contactability",
    teamId: input.teamId,
    ownerId: input.ownerId,
    actorId: input.ownerId,
    prospectId: input.prospectId,
    idempotencyKey: `mysql-approval-${input.suffix}`,
    decisionId: eligible.record.id,
    createdAt: at(input.offset + 13)
  });
  return approved.record.id;
}

async function countRows(connection: mysql.Connection) {
  const result: Record<string, number> = {};
  for (const table of [
    "leads",
    "lead_source_events",
    "lead_activities",
    "customers",
    "customer_activities",
    "customer_acquisition_source_events",
    "deals",
    "deal_events",
    "todos",
    "website_opportunities",
    "prospect_coverage_events"
  ]) {
    const [rows] = await connection.query<Array<RowDataPacket>>(
      `SELECT COUNT(*) AS count FROM \`${table}\``
    );
    result[table] = Number(rows[0]?.count || 0);
  }
  return result;
}

async function main() {
  const applicationUrl = process.env.DATABASE_URL
    || process.env.MYSQL_URL
    || process.env.MYSQL_TEST_ADMIN_URL;
  const adminConnectionUrl = process.env.MYSQL_TEST_ADMIN_URL
    || applicationUrl;
  if (!applicationUrl || !adminConnectionUrl) {
    throw new Error(
      "Lead conversion MySQL test requires MYSQL_TEST_ADMIN_URL, "
      + "DATABASE_URL or MYSQL_URL"
    );
  }

  const adminUrl = new URL(adminConnectionUrl);
  const appUrl = new URL(applicationUrl);
  const databaseName =
    `goodjob_conversion_test_${
      randomUUID().replaceAll("-", "").slice(0, 16)
    }`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let databaseCreated = false;
  let grantedAccount = "";
  let exitCode = 1;
  let stage = "create database";
  let database: mysql.Connection | undefined;
  let pool: mysql.Pool | undefined;

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
    process.env.PROSPECT_SOURCE_RAW_IDENTITY_SECRET =
      rawIdentitySecret;
    process.env.PROSPECT_COVERAGE_MASTER_SECRET =
      coverageMasterSecret;
    process.env.PROSPECT_QUALIFICATION_MASTER_SECRET =
      qualificationMasterSecret;

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

    database = await mysql.createConnection({
      ...connectionOptions(testUrl),
      database: databaseName
    });
    pool = mysql.createPool({
      uri: testUrl.toString(),
      connectionLimit: 4
    });

    stage = "schema and store startup";
    const store = await createMysqlStore();
    await ensureProspectCoverageSchema(pool);
    await ensureProspectQualificationSchema(pool);
    assert.ok(store.resolveOrganizationStrongIdentity);
    assert.ok(store.recordProspectCoverage);
    assert.ok(store.convertProspectToLead);
    assert.ok(store.convertProspectToCustomer);
    const protectedBefore = await countRows(database);

    stage = "successful conversion and replay";
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const owner = store.users.find(
      (item) => item.id === "u_sales_shirley"
    ) || store.users.find(
      (item) => item.role === "sales" && item.status === "active"
    );
    assert.ok(owner, "conversion test requires an active sales user");
    const teamId = owner.teamId;
    const ownerId = owner.id;
    const campaignId = `pc_${randomUUID()}`;
    const first = createRawFixture(teamId, ownerId, "conversion-source-a");
    await addCampaign(
      store,
      database,
      teamId,
      ownerId,
      campaignId,
      `${suffix}-1`,
      first
    );
    await insertRawFixture(database, first);
    const firstIdentity = await store.resolveOrganizationStrongIdentity(
      identityInput(first, `CONVERSION-REG-${suffix}-1`)
    );
    const firstCoverage = await store.recordProspectCoverage(
      coverageInput(first, firstIdentity.resolution.id, at(20))
    );
    const firstDecisionId = await qualifyProspect(store, {
      teamId,
      ownerId,
      prospectId: firstCoverage.prospect.id,
      campaignId,
      suffix: `${suffix}-1`,
      offset: 20
    });
    const conversionInput = {
      operationCode: "convert_prospect_to_lead_v1" as const,
      decisionId: firstDecisionId,
      mode: "create_new" as const,
      existingLeadId: "",
      company: "",
      contact: "",
      country: "DE",
      intent: "高" as const,
      estimatedAmount: 25000,
      nextFollowAt: at(80),
      remark: "MySQL transaction conversion",
      teamId,
      ownerId,
      prospectId: firstCoverage.prospect.id,
      idempotencyKey: `mysql-conversion-${suffix}-1`,
      convertedAt: at(34)
    };
    const converted = await store.convertProspectToLead(conversionInput);
    assert.equal(converted.replayed, false);
    assert.equal(converted.created, true);
    assert.equal(converted.lead.ownerId, ownerId);
    assert.equal(converted.lead.teamId, teamId);
    const countsAfterConversion = await countRows(database);
    assert.equal(
      countsAfterConversion.leads,
      protectedBefore.leads + 1
    );
    assert.equal(
      countsAfterConversion.lead_source_events,
      protectedBefore.lead_source_events + 1
    );
    assert.equal(
      countsAfterConversion.lead_activities,
      protectedBefore.lead_activities + 1
    );
    assert.equal(
      countsAfterConversion.prospect_coverage_events,
      protectedBefore.prospect_coverage_events + 2
    );
    assert.equal(countsAfterConversion.customers, protectedBefore.customers);
    assert.equal(countsAfterConversion.deals, protectedBefore.deals);
    assert.equal(
      countsAfterConversion.website_opportunities,
      protectedBefore.website_opportunities
    );

    const replay = await store.convertProspectToLead(conversionInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.lead.id, converted.lead.id);
    assert.deepEqual(await countRows(database), countsAfterConversion);

    stage = "successful customer conversion and replay";
    const customerConversionInput = {
      operationCode: "convert_prospect_to_customer_v1" as const,
      leadId: converted.lead.id,
      mode: "create_new" as const,
      existingCustomerId: "",
      company: "",
      contact: "",
      country: "",
      nextReminder: "",
      teamId,
      ownerId,
      prospectId: firstCoverage.prospect.id,
      idempotencyKey: `mysql-customer-conversion-${suffix}-1`,
      convertedAt: at(35)
    };
    const customerConverted = await store.convertProspectToCustomer(
      customerConversionInput
    );
    assert.equal(customerConverted.replayed, false);
    assert.equal(customerConverted.created, true);
    assert.equal(customerConverted.customer.ownerId, ownerId);
    assert.equal(customerConverted.customer.teamId, teamId);
    assert.equal(customerConverted.customer.billingName, "");
    assert.equal(customerConverted.customer.billingAddress, "");
    assert.equal(customerConverted.lead.convertedDealId, "");
    assert.equal(
      customerConverted.sourceEvent.leadSourceEventId,
      converted.sourceEvent.id
    );
    const countsAfterCustomerConversion = await countRows(database);
    assert.equal(
      countsAfterCustomerConversion.customers,
      countsAfterConversion.customers + 1
    );
    assert.equal(
      countsAfterCustomerConversion.customer_activities,
      countsAfterConversion.customer_activities + 1
    );
    assert.equal(
      countsAfterCustomerConversion.customer_acquisition_source_events,
      countsAfterConversion.customer_acquisition_source_events + 1
    );
    assert.equal(
      countsAfterCustomerConversion.lead_activities,
      countsAfterConversion.lead_activities + 1
    );
    assert.equal(
      countsAfterCustomerConversion.prospect_coverage_events,
      countsAfterConversion.prospect_coverage_events + 1
    );
    assert.equal(
      countsAfterCustomerConversion.deals,
      countsAfterConversion.deals
    );
    assert.equal(
      countsAfterCustomerConversion.deal_events,
      countsAfterConversion.deal_events
    );
    assert.equal(
      countsAfterCustomerConversion.todos,
      countsAfterConversion.todos
    );
    assert.equal(
      countsAfterCustomerConversion.website_opportunities,
      countsAfterConversion.website_opportunities
    );

    const customerReplay = await store.convertProspectToCustomer(
      customerConversionInput
    );
    assert.equal(customerReplay.replayed, true);
    assert.equal(
      customerReplay.customer.id,
      customerConverted.customer.id
    );
    assert.deepEqual(
      await countRows(database),
      countsAfterCustomerConversion
    );

    stage = "customer conversion cold load";
    const coldCoverage = await loadProspectCoverageState(pool, teamId);
    const coldProspect = coldCoverage.tenantProspects.find(
      (item) => item.id === firstCoverage.prospect.id
    );
    assert.equal(coldProspect?.status, "converted");
    assert.equal(coldProspect?.leadId, converted.lead.id);
    assert.equal(
      coldProspect?.customerId,
      customerConverted.customer.id
    );
    const coldStore = await createMysqlStore();
    assert.equal(
      coldStore.customers.some((item) =>
        item.id === customerConverted.customer.id
        && item.teamId === teamId
        && item.ownerId === ownerId
      ),
      true
    );
    assert.equal(
      coldStore.customerAcquisitionSourceEvents.some((item) =>
        item.id === customerConverted.sourceEvent.id
        && item.customerId === customerConverted.customer.id
        && item.leadId === converted.lead.id
        && item.prospectId === firstCoverage.prospect.id
      ),
      true
    );
    const [leadRows] = await database.query<Array<RowDataPacket>>(
      `SELECT id,owner_id,team_id,source_channel,external_id,
              converted_customer_id,converted_deal_id
       FROM leads WHERE id = ?`,
      [converted.lead.id]
    );
    assert.equal(leadRows.length, 1);
    assert.equal(String(leadRows[0]?.owner_id), ownerId);
    assert.equal(String(leadRows[0]?.team_id), teamId);
    assert.equal(String(leadRows[0]?.source_channel), "prospect_conversion");
    assert.equal(
      String(leadRows[0]?.external_id),
      firstCoverage.prospect.id
    );
    assert.equal(
      String(leadRows[0]?.converted_customer_id),
      customerConverted.customer.id
    );
    assert.equal(String(leadRows[0]?.converted_deal_id || ""), "");

    stage = "transaction rollback";
    const secondCampaignId = `pc_${randomUUID()}`;
    const second = createRawFixture(
      teamId,
      ownerId,
      "conversion-source-rollback"
    );
    await addCampaign(
      store,
      database,
      teamId,
      ownerId,
      secondCampaignId,
      `${suffix}-rollback`,
      second
    );
    await insertRawFixture(database, second);
    const secondIdentity = await store.resolveOrganizationStrongIdentity(
      identityInput(second, `CONVERSION-REG-${suffix}-2`)
    );
    const secondCoverage = await store.recordProspectCoverage(
      coverageInput(second, secondIdentity.resolution.id, at(50))
    );
    const secondDecisionId = await qualifyProspect(store, {
      teamId,
      ownerId,
      prospectId: secondCoverage.prospect.id,
      campaignId: secondCampaignId,
      suffix: `${suffix}-rollback`,
      offset: 50
    });
    const beforeRollback = await countRows(database);
    await admin.query(`USE \`${databaseName}\``);
    await admin.query(
      `CREATE TRIGGER fail_human_conversion_event
       BEFORE INSERT ON prospect_coverage_events
       FOR EACH ROW
       SIGNAL SQLSTATE '45000'
       SET MESSAGE_TEXT = 'forced conversion rollback'`
    );
    try {
      await assert.rejects(store.convertProspectToLead({
        ...conversionInput,
        decisionId: secondDecisionId,
        prospectId: secondCoverage.prospect.id,
        idempotencyKey: `mysql-conversion-${suffix}-rollback`,
        convertedAt: at(64)
      }));
    } finally {
      await admin.query(
        `DROP TRIGGER IF EXISTS \`${databaseName}\`.fail_human_conversion_event`
      );
    }
    assert.deepEqual(await countRows(database), beforeRollback);
    const rollbackCoverage = await loadProspectCoverageState(pool, teamId);
    const rollbackProspect = rollbackCoverage.tenantProspects.find(
      (item) => item.id === secondCoverage.prospect.id
    );
    assert.equal(rollbackProspect?.status, "active");
    assert.equal(rollbackProspect?.leadId, "");

    stage = "customer conversion transaction rollback";
    const secondConverted = await store.convertProspectToLead({
      ...conversionInput,
      decisionId: secondDecisionId,
      prospectId: secondCoverage.prospect.id,
      idempotencyKey: `mysql-conversion-${suffix}-after-rollback`,
      convertedAt: at(65)
    });
    const beforeCustomerRollback = await countRows(database);
    await admin.query(
      `CREATE TRIGGER fail_customer_conversion_coverage_event
       BEFORE INSERT ON prospect_coverage_events
       FOR EACH ROW
       SIGNAL SQLSTATE '45000'
       SET MESSAGE_TEXT = 'forced customer conversion rollback'`
    );
    try {
      await assert.rejects(store.convertProspectToCustomer({
        ...customerConversionInput,
        leadId: secondConverted.lead.id,
        prospectId: secondCoverage.prospect.id,
        idempotencyKey:
          `mysql-customer-conversion-${suffix}-rollback`,
        convertedAt: at(66)
      }));
    } finally {
      await admin.query(
        `DROP TRIGGER IF EXISTS \`${databaseName}\`.${
          "fail_customer_conversion_coverage_event"
        }`
      );
    }
    assert.deepEqual(
      await countRows(database),
      beforeCustomerRollback
    );
    const customerRollbackCoverage = await loadProspectCoverageState(
      pool,
      teamId
    );
    const customerRollbackProspect =
      customerRollbackCoverage.tenantProspects.find(
        (item) => item.id === secondCoverage.prospect.id
      );
    assert.equal(customerRollbackProspect?.status, "converted");
    assert.equal(
      customerRollbackProspect?.leadId,
      secondConverted.lead.id
    );
    assert.equal(customerRollbackProspect?.customerId, "");
    const [secondLeadRows] = await database.query<Array<RowDataPacket>>(
      `SELECT converted_customer_id,converted_deal_id
       FROM leads WHERE id = ?`,
      [secondConverted.lead.id]
    );
    assert.equal(
      String(secondLeadRows[0]?.converted_customer_id || ""),
      ""
    );
    assert.equal(
      String(secondLeadRows[0]?.converted_deal_id || ""),
      ""
    );

    console.log(
      "Prospect lead/customer conversion MySQL transaction, replay, "
      + "cold load and rollback tests passed"
    );
    exitCode = 0;
  } catch (error) {
    console.error(`Prospect lead conversion MySQL test failed at: ${stage}`);
    console.error(error);
  } finally {
    if (pool) await pool.end();
    if (database) await database.end();
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
