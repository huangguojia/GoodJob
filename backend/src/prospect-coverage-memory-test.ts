import assert from "node:assert/strict";
import {
  PROSPECT_COVERAGE_MEMORY_CONTRACT,
  listOwnerProspectCoverageEvents,
  listTenantProspects,
  recordProspectCoverage,
  setTenantProspectDisposition
} from "./prospect-coverage-memory.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type {
  Organization,
  OrganizationAcceptedIdentifier,
  OrganizationIdentityClaim,
  OrganizationIdentityResolution,
  OrganizationSourceBinding,
  ProspectRunShard,
  ProspectSearchRun,
  ProspectSourceRawHit,
  ProspectSourceRawRecord
} from "./types.js";

const store = getStore();
const coverageSecret = "prospect-coverage-memory-test-secret-v1-".repeat(2);
const at = (minute: number) =>
  new Date(Date.UTC(2026, 6, 14, 8, minute)).toISOString();
const hash = (seed: number) => seed.toString(16).padStart(64, "0");

const coverageArrayNames = [
  "tenantProspects",
  "prospectCoverageEvents"
] as const;
const contextArrayNames = [
  "organizations",
  "organizationIdentityClaims",
  "organizationAcceptedIdentifiers",
  "organizationIdentityResolutions",
  "organizationSourceBindings",
  "prospectSourceRawRecords",
  "prospectSourceRawHits",
  "prospectSearchRuns",
  "prospectRunShards"
] as const;
const protectedBusinessArrayNames = [
  "leads",
  "leadActivities",
  "customers",
  "customerActivities",
  "deals",
  "dealEvents",
  "websiteOpportunities"
] as const;

type ArrayName =
  | typeof coverageArrayNames[number]
  | typeof contextArrayNames[number]
  | typeof protectedBusinessArrayNames[number];

function snapshotArrays(names: readonly ArrayName[]) {
  return Object.fromEntries(names.map((name) => [
    name,
    structuredClone(store[name])
  ])) as Record<ArrayName, unknown[]>;
}

function restoreArrays(
  names: readonly ArrayName[],
  snapshot: Record<ArrayName, unknown[]>
) {
  for (const name of names) {
    const target = store[name] as unknown[];
    target.splice(0, target.length, ...snapshot[name]);
  }
}

function addOrganization(teamId: string, organizationId: string) {
  const organization: Organization = {
    id: organizationId,
    teamId,
    scopeType: "team",
    scopeId: teamId,
    status: "active",
    legalName: `${organizationId} Limited`,
    normalizedName: organizationId.toLowerCase(),
    organizationHash: hash(100),
    createdAt: at(0)
  };
  store.organizations.push(organization);
}

function addCoverageContext(input: {
  teamId: string;
  ownerId: string;
  organizationId: string;
  suffix: string;
  connectionId: string;
  normalizedName?: string;
  acceptedIdentifierId?: string;
}) {
  const runId = `run_${input.suffix}`;
  const shardId = `shard_${input.suffix}`;
  const rawRecordId = `raw_${input.suffix}`;
  const sourceHitId = `hit_${input.suffix}`;
  const resolutionId = `resolution_${input.suffix}`;
  const bindingId = `binding_${input.suffix}`;
  const claimId = `claim_${input.suffix}`;
  const campaignId = `campaign_${input.suffix}`;
  const strategyId = `strategy_${input.suffix}`;

  store.prospectSearchRuns.push({
    id: runId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    campaignId,
    strategyId
  } as unknown as ProspectSearchRun);
  store.prospectRunShards.push({
    id: shardId,
    teamId: input.teamId,
    runId
  } as unknown as ProspectRunShard);

  const rawRecord: ProspectSourceRawRecord = {
    id: rawRecordId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    providerCode: "coverage.test-provider",
    connectionId: input.connectionId,
    endpointCode: "company-search",
    sourceIdentityHash: hash(1),
    artifactHash: hash(2),
    envelopeVersion: "provider-raw-v1",
    encryptedEnvelope: "test-only",
    envelopeHash: hash(3),
    firstObservedAt: at(0),
    recordHash: hash(4),
    createdAt: at(0)
  };
  const sourceHit: ProspectSourceRawHit = {
    id: sourceHitId,
    batchId: `batch_${input.suffix}`,
    recordId: rawRecordId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    runId,
    shardId,
    jobId: `job_${input.suffix}`,
    attemptId: `attempt_${input.suffix}`,
    ledgerId: `ledger_${input.suffix}`,
    pageId: `page_${input.suffix}`,
    ordinal: 1,
    fetchedAt: at(0),
    hitHash: hash(5),
    createdAt: at(0)
  };
  const claim: OrganizationIdentityClaim = {
    id: claimId,
    resolutionId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    rawRecordId,
    ordinal: 1,
    kind: "legal_name",
    originalValue: input.normalizedName || "Acme Limited",
    normalizedValue: input.normalizedName || "acme limited",
    scheme: "",
    jurisdiction: "",
    entityType: "legal_entity",
    subjectRef: "company",
    classification: "association_fact",
    normalizerVersion: "coverage-test-v1",
    validatorVersion: "coverage-test-v1",
    authorityProfileCode: "coverage-test",
    observedAt: at(0),
    claimHash: hash(6),
    claimFactHash: hash(7),
    createdAt: at(0)
  };
  const acceptedIdentifierIds = input.acceptedIdentifierId
    ? [input.acceptedIdentifierId]
    : [];
  const resolution: OrganizationIdentityResolution = {
    id: resolutionId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    rawRecordId,
    rawArtifactHash: rawRecord.artifactHash,
    processingKeyHash: hash(8),
    claimHash: hash(9),
    resolverContractVersion: "organization-strong-identity-v1",
    parserVersion: "coverage-test-v1",
    normalizerVersion: "coverage-test-v1",
    authorityProfileCode: "coverage-test",
    authorityProfileVersion: "v1",
    authorityProfileHash: hash(10),
    result: acceptedIdentifierIds.length ? "exact_match" : "new_entity",
    decisionReasonCode: acceptedIdentifierIds.length
      ? "EXACT_IDENTIFIER_MATCH"
      : "NEW_STRONG_IDENTITY",
    organizationId: input.organizationId,
    bindingId,
    conflictId: "",
    matchedIdentifierIds: acceptedIdentifierIds,
    acceptedIdentifierIds,
    bindingRelationRole: acceptedIdentifierIds.length
      ? "reused_existing"
      : "created_new",
    relationHash: hash(11),
    eventCount: 1,
    eventTailHash: hash(12),
    resolutionHash: hash(13),
    createdAt: at(0)
  };
  const binding: OrganizationSourceBinding = {
    id: bindingId,
    organizationId: input.organizationId,
    resolutionId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    rawRecordId,
    status: "active",
    bindingHash: hash(14),
    createdAt: at(0)
  };

  store.prospectSourceRawRecords.push(rawRecord);
  store.prospectSourceRawHits.push(sourceHit);
  store.organizationIdentityClaims.push(claim);
  store.organizationIdentityResolutions.push(resolution);
  store.organizationSourceBindings.push(binding);
  return { resolutionId, sourceHitId };
}

function addAcceptedIdentifier(input: {
  id: string;
  teamId: string;
  organizationId: string;
  ownerId: string;
  claimId: string;
  rawRecordId: string;
}) {
  const identifier: OrganizationAcceptedIdentifier = {
    id: input.id,
    organizationId: input.organizationId,
    teamId: input.teamId,
    kind: "lei",
    scheme: "iso-17442",
    jurisdiction: "GLOBAL",
    normalizedValue: "549300TESTCOVERAGE0001",
    normalizedValueHash: hash(20),
    sourceClaimId: input.claimId,
    sourceRawRecordId: input.rawRecordId,
    sourceOwnerId: input.ownerId,
    authorityProfileCode: "coverage-test",
    authorityProfileVersion: "v1",
    status: "active",
    identifierHash: hash(21),
    createdAt: at(0)
  };
  store.organizationAcceptedIdentifiers.push(identifier);
}

function record(input: {
  teamId: string;
  ownerId: string;
  resolutionId: string;
  sourceHitId: string;
  coveredAt: string;
  nextReviewAt?: string;
  evidenceHash?: string;
}) {
  return recordProspectCoverage(store, {
    teamId: input.teamId,
    ownerId: input.ownerId,
    resolutionId: input.resolutionId,
    sourceHitId: input.sourceHitId,
    contractVersion: PROSPECT_COVERAGE_MEMORY_CONTRACT,
    evidenceVersion: "material-evidence-v1",
    coveredAt: input.coveredAt,
    nextReviewAt: input.nextReviewAt,
    evidence: input.evidenceHash
      ? [{
          kind: "product_signal",
          factHash: input.evidenceHash,
          observedAt: input.coveredAt
        }]
      : [],
    coverageSecret
  });
}

function assertBusinessDataUnchanged(
  before: Record<ArrayName, unknown[]>
) {
  for (const name of protectedBusinessArrayNames) {
    assert.deepEqual(store[name], before[name], `${name} 不得被覆盖记忆改写`);
  }
}

function runStageScenario() {
  const allNames = [
    ...coverageArrayNames,
    ...contextArrayNames,
    ...protectedBusinessArrayNames
  ];
  const before = snapshotArrays(allNames);
  try {
    for (const name of [...coverageArrayNames, ...contextArrayNames]) {
      (store[name] as unknown[]).splice(0);
    }

    addOrganization("team-a", "org-a");
    addOrganization("team-b", "org-b");
    const first = addCoverageContext({
      teamId: "team-a",
      ownerId: "owner-a",
      organizationId: "org-a",
      suffix: "a1",
      connectionId: "source-a"
    });
    const initial = record({
      teamId: "team-a",
      ownerId: "owner-a",
      ...first,
      coveredAt: at(1),
      nextReviewAt: at(20)
    });
    assert.equal(initial.classification, "net_new");
    assert.equal(initial.queueAction, "enqueue");
    assert.equal(initial.prospect.hitCount, 1);
    assert.equal(initial.prospect.queueState, "pending");

    const replay = record({
      teamId: "team-a",
      ownerId: "owner-a",
      ...first,
      coveredAt: at(1),
      nextReviewAt: at(20)
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.prospect.hitCount, 1);
    assert.equal(store.prospectCoverageEvents.length, 1);

    const secondSource = addCoverageContext({
      teamId: "team-a",
      ownerId: "owner-b",
      organizationId: "org-a",
      suffix: "a2",
      connectionId: "source-b"
    });
    const duplicate = record({
      teamId: "team-a",
      ownerId: "owner-b",
      ...secondSource,
      coveredAt: at(2)
    });
    assert.equal(duplicate.classification, "duplicate");
    assert.equal(duplicate.prospect.sourceCount, 2);
    assert.equal(duplicate.prospect.queueState, "pending");
    assert.equal(duplicate.queueAction, "none");

    const intelligenceContext = addCoverageContext({
      teamId: "team-a",
      ownerId: "owner-b",
      organizationId: "org-a",
      suffix: "a3",
      connectionId: "source-b"
    });
    const intelligence = record({
      teamId: "team-a",
      ownerId: "owner-b",
      ...intelligenceContext,
      coveredAt: at(3),
      evidenceHash: hash(30)
    });
    assert.equal(intelligence.classification, "new_intelligence");
    assert.equal(intelligence.prospect.evidenceCount, 2);
    assert.equal(intelligence.prospect.queueState, "pending");

    setTenantProspectDisposition(store, {
      teamId: "team-a",
      ownerId: "owner-a",
      prospectId: initial.prospect.id,
      requestId: "temporary-exclusion",
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "exclude_temporary",
      reasonCode: "NOT_CURRENT_TARGET",
      effectiveAt: at(4),
      excludedUntil: at(10),
      coverageSecret
    });
    const excludedContext = addCoverageContext({
      teamId: "team-a",
      ownerId: "owner-a",
      organizationId: "org-a",
      suffix: "a4",
      connectionId: "source-a"
    });
    const excluded = record({
      teamId: "team-a",
      ownerId: "owner-a",
      ...excludedContext,
      coveredAt: at(5),
      evidenceHash: hash(31)
    });
    assert.equal(excluded.classification, "excluded");
    assert.equal(excluded.prospect.queueState, "suppressed");

    const dueContext = addCoverageContext({
      teamId: "team-a",
      ownerId: "owner-a",
      organizationId: "org-a",
      suffix: "a5",
      connectionId: "source-a"
    });
    const due = record({
      teamId: "team-a",
      ownerId: "owner-a",
      ...dueContext,
      coveredAt: at(11)
    });
    assert.equal(due.classification, "due_review");
    assert.equal(due.prospect.queueState, "pending");

    setTenantProspectDisposition(store, {
      teamId: "team-a",
      ownerId: "owner-a",
      prospectId: initial.prospect.id,
      requestId: "permanent-exclusion",
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "exclude_permanent",
      reasonCode: "DO_NOT_TARGET",
      effectiveAt: at(12),
      coverageSecret
    });
    const permanentContext = addCoverageContext({
      teamId: "team-a",
      ownerId: "owner-b",
      organizationId: "org-a",
      suffix: "a6",
      connectionId: "source-c"
    });
    assert.equal(record({
      teamId: "team-a",
      ownerId: "owner-b",
      ...permanentContext,
      coveredAt: at(13),
      evidenceHash: hash(32)
    }).classification, "excluded");

    setTenantProspectDisposition(store, {
      teamId: "team-a",
      ownerId: "owner-a",
      prospectId: initial.prospect.id,
      requestId: "resume-after-review",
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "resume",
      reasonCode: "MANUAL_REVIEW_APPROVED",
      effectiveAt: at(14),
      nextReviewAt: at(30),
      coverageSecret
    });

    const leadBefore = store.leads.length;
    store.leads.push({
      id: "existing-lead-a",
      teamId: "team-a"
    } as unknown as CrmStore["leads"][number]);
    const linked = setTenantProspectDisposition(store, {
      teamId: "team-a",
      ownerId: "owner-a",
      prospectId: initial.prospect.id,
      requestId: "link-existing-crm",
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "link_crm",
      reasonCode: "MANUAL_CRM_CONVERSION",
      effectiveAt: at(15),
      leadId: "existing-lead-a",
      coverageSecret
    });
    assert.equal(linked.prospect.status, "converted");
    assert.equal(store.leads.length, leadBefore + 1);
    store.leads.splice(leadBefore, 1);

    const afterLinkContext = addCoverageContext({
      teamId: "team-a",
      ownerId: "owner-b",
      organizationId: "org-a",
      suffix: "a7",
      connectionId: "source-d"
    });
    const afterLink = record({
      teamId: "team-a",
      ownerId: "owner-b",
      ...afterLinkContext,
      coveredAt: at(16),
      evidenceHash: hash(33)
    });
    assert.equal(afterLink.classification, "new_intelligence");
    assert.equal(afterLink.prospect.queueState, "converted");
    assert.equal(afterLink.queueAction, "suppress");

    const teamBContext = addCoverageContext({
      teamId: "team-b",
      ownerId: "owner-a",
      organizationId: "org-b",
      suffix: "b1",
      connectionId: "source-a"
    });
    assert.equal(record({
      teamId: "team-b",
      ownerId: "owner-a",
      ...teamBContext,
      coveredAt: at(17)
    }).classification, "net_new");

    assert.equal(listTenantProspects(store, {
      teamId: "team-a"
    }).length, 1);
    assert.equal(listTenantProspects(store, {
      teamId: "team-b"
    }).length, 1);
    const ownerAEvents = listOwnerProspectCoverageEvents(store, {
      teamId: "team-a",
      ownerId: "owner-a"
    });
    const ownerBEvents = listOwnerProspectCoverageEvents(store, {
      teamId: "team-a",
      ownerId: "owner-b"
    });
    assert.ok(ownerAEvents.length > 0);
    assert.ok(ownerBEvents.length > 0);
    assert.ok(ownerAEvents.every((event) => event.ownerId === "owner-a"));
    assert.ok(ownerBEvents.every((event) => event.ownerId === "owner-b"));
    assertBusinessDataUnchanged(before);
  } finally {
    restoreArrays(allNames, before);
  }
}

runStageScenario();
console.log("Prospect coverage memory stage tests passed");
