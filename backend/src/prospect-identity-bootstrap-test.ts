import assert from "node:assert/strict";
import {
  attachProspectIdentityBootstrapRun,
  beginProspectIdentityBootstrap,
  normalizeProspectIdentityRegistration,
  ProspectIdentityBootstrapError,
  reconcileProspectIdentityBootstrap
} from "./prospect-identity-bootstrap.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectIdentityBootstrapAttempt,
  ProspectSearchRun,
  SessionUser,
  WebsiteOpportunity
} from "./types.js";

const user = getStore().users.find((item) =>
  item.email === "shirley@goodjob.com"
)! as SessionUser;

assert.equal(
  normalizeProspectIdentityRegistration("companies_house", "SC-123456")
    .normalizedIdentifier,
  "SC123456"
);
assert.equal(
  normalizeProspectIdentityRegistration("companies_house", "R0 123456")
    .normalizedIdentifier,
  "R0123456"
);
assert.throws(
  () => normalizeProspectIdentityRegistration("companies_house", "1234567"),
  (error: unknown) => error instanceof ProspectIdentityBootstrapError
    && error.code === "IDENTITY_BOOTSTRAP_INVALID"
);

function candidate(id: string): WebsiteOpportunity {
  return {
    id,
    company: "Bootstrap Website Candidate",
    business: "Industrial products",
    country: "Global",
    website: `https://${id}.example.test`,
    contact: "Purchasing",
    contactInfo: "",
    description: "Reference-only candidate",
    ownerId: user.id,
    teamId: user.teamId,
    status: "preview",
    createdAt: "2026-07-26T00:00:00.000Z",
    parseMode: "reference",
    source: "website-reference",
    sourceLabel: "官网链接登记",
    sourceEvidence: [],
    identityBootstrapAttempts: []
  };
}

function isolatedStore(): CrmStore {
  const base = getStore();
  return {
    ...base,
    mode: "memory",
    websiteOpportunities: [],
    prospectSearchRuns: [],
    prospectSourceRawHits: [],
    prospectCandidateProcessingStates: [],
    organizationIdentityClaims: [],
    organizationIdentityResolutions: [],
    organizationIdentityConflicts: [],
    tenantProspects: [],
    prospectCoverageEvents: [],
    async persist() {
      // Isolated in-memory contract test.
    },
    async readBarrier() {
      // Synchronous memory snapshot.
    },
    persistProspectCandidateMutation: undefined
  };
}

function attempt(
  id: string,
  candidateId: string,
  registrationNumber = "529900T8BM49AURSDO55"
): ProspectIdentityBootstrapAttempt {
  return {
    id,
    version: "prospect-identity-bootstrap-v1",
    requestIdHash: `request-${candidateId}`.padEnd(64, "0").slice(0, 64),
    providerId: "gleif",
    registrationNumber,
    normalizedIdentifier: registrationNumber,
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
      id: `${id}:event:1`,
      sequence: 1,
      stage: "validation",
      status: "completed",
      label: "权威注册号已校验",
      detail: registrationNumber,
      createdAt: "2026-07-26T00:00:00.000Z"
    }],
    createdBy: user.id,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    endedAt: ""
  };
}

function run(id: string, status: ProspectSearchRun["status"]) {
  return {
    id,
    teamId: user.teamId,
    ownerId: user.id,
    campaignId: `campaign-${id}`,
    campaignVersion: 1,
    strategyId: `strategy-${id}`,
    status
  } as ProspectSearchRun;
}

function addSuccessfulLineage(
  store: CrmStore,
  input: {
    runId: string;
    registrationNumber: string;
    targetId: string;
    suffix: string;
  }
) {
  const rawRecordId = `raw-${input.suffix}`;
  const hitId = `hit-${input.suffix}`;
  const resolutionId = `resolution-${input.suffix}`;
  const organizationId = `organization-${input.suffix}`;
  const prospectId = `prospect-${input.suffix}`;
  const sourceCandidateId = `source-${input.suffix}`;
  store.prospectSourceRawHits.push({
    id: hitId,
    batchId: `batch-${input.suffix}`,
    recordId: rawRecordId,
    teamId: user.teamId,
    ownerId: user.id,
    runId: input.runId,
    shardId: `shard-${input.suffix}`,
    jobId: `job-${input.suffix}`,
    attemptId: `provider-attempt-${input.suffix}`,
    ledgerId: `ledger-${input.suffix}`,
    pageId: `page-${input.suffix}`,
    ordinal: 1,
    fetchedAt: "2026-07-26T00:01:00.000Z",
    hitHash: "a".repeat(64),
    createdAt: "2026-07-26T00:01:00.000Z"
  });
  store.prospectCandidateProcessingStates!.push({
    hitId,
    teamId: user.teamId,
    ownerId: user.id,
    runId: input.runId,
    ledgerId: `ledger-${input.suffix}`,
    status: "completed",
    failureCode: "",
    candidateId: sourceCandidateId,
    processedAt: "2026-07-26T00:02:00.000Z",
    updatedAt: "2026-07-26T00:02:00.000Z"
  });
  store.organizationIdentityClaims.push({
    id: `claim-${input.suffix}`,
    resolutionId,
    teamId: user.teamId,
    ownerId: user.id,
    rawRecordId,
    ordinal: 1,
    kind: "lei",
    originalValue: input.registrationNumber,
    normalizedValue: input.registrationNumber,
    scheme: "iso-17442",
    jurisdiction: "GLOBAL",
    entityType: "legal_entity",
    subjectRef: `gleif:${input.registrationNumber}`,
    classification: "strong_identifier_eligible",
    normalizerVersion: "gleif-lei-normalizer-v1",
    validatorVersion: "iso-17442-mod97-v1",
    authorityProfileCode: "gleif-company-identity",
    observedAt: "2026-07-26T00:01:00.000Z",
    claimHash: "b".repeat(64),
    claimFactHash: "c".repeat(64),
    createdAt: "2026-07-26T00:01:00.000Z"
  });
  store.organizationIdentityResolutions.push({
    id: resolutionId,
    teamId: user.teamId,
    ownerId: user.id,
    rawRecordId,
    rawArtifactHash: "d".repeat(64),
    processingKeyHash: "e".repeat(64),
    claimHash: "f".repeat(64),
    resolverContractVersion: "organization-strong-identity-v1",
    parserVersion: "test-v1",
    normalizerVersion: "test-v1",
    authorityProfileCode: "gleif-company-identity",
    authorityProfileVersion: "v1",
    authorityProfileHash: "1".repeat(64),
    result: "exact_match",
    decisionReasonCode: "AUTHORIZED_STRONG_IDENTIFIER_EXACT_MATCH",
    organizationId,
    bindingId: `binding-${input.suffix}`,
    conflictId: "",
    matchedIdentifierIds: [`identifier-${input.suffix}`],
    acceptedIdentifierIds: [],
    bindingRelationRole: "created_new",
    relationHash: "2".repeat(64),
    eventCount: 1,
    eventTailHash: "3".repeat(64),
    resolutionHash: "4".repeat(64),
    createdAt: "2026-07-26T00:01:00.000Z"
  });
  store.tenantProspects.push({
    id: prospectId,
    teamId: user.teamId,
    organizationId,
    status: "active",
    latestClassification: "net_new",
    queueState: "pending",
    queueReasonCode: "TEAM_FIRST_COVERAGE",
    firstSeenAt: "2026-07-26T00:01:00.000Z",
    lastSeenAt: "2026-07-26T00:01:00.000Z",
    lastMaterialChangeAt: "2026-07-26T00:01:00.000Z",
    lastQueuedAt: "2026-07-26T00:01:00.000Z",
    lastReviewedAt: "",
    nextReviewAt: "",
    hitCount: 1,
    sourceCount: 1,
    evidenceCount: 1,
    sourceKeyHashes: ["5".repeat(64)],
    materialEvidenceKeyHashes: ["6".repeat(64)],
    exclusionScope: "none",
    exclusionMode: "none",
    exclusionReasonCode: "",
    excludedUntil: "",
    leadId: "",
    customerId: "",
    dealId: "",
    version: 1,
    eventCount: 1,
    eventTailHash: "7".repeat(64),
    prospectHash: "8".repeat(64),
    createdAt: "2026-07-26T00:01:00.000Z",
    updatedAt: "2026-07-26T00:01:00.000Z"
  });
  store.prospectCoverageEvents.push({
    id: `coverage-${input.suffix}`,
    prospectId,
    teamId: user.teamId,
    ownerId: user.id,
    organizationId,
    resolutionId,
    rawRecordId,
    sourceHitId: hitId,
    campaignId: `campaign-${input.runId}`,
    strategyId: `strategy-${input.runId}`,
    runId: input.runId,
    shardId: `shard-${input.suffix}`,
    classification: "net_new",
    reasonCode: "TEAM_FIRST_COVERAGE"
  } as CrmStore["prospectCoverageEvents"][number]);
  store.websiteOpportunities.push({
    ...candidate(sourceCandidateId),
    source: "gleif",
    sourceLabel: "GLEIF",
    tenantProspectId: prospectId,
    organizationId,
    sourceEvidence: [{
      providerId: "gleif",
      providerRecordId: input.registrationNumber,
      officialWebsite: "https://verified.example.test",
      sourceUrl: "https://api.gleif.org/api/v1/lei-records/test",
      recordType: "official_company",
      fetchedAt: "2026-07-26T00:01:00.000Z",
      payloadHash: "9".repeat(64),
      evidenceSummary: "Official LEI record",
      matchedFields: ["providerRecordId", "company"],
      adapterVersion: "test-v1",
      catalogPolicyVersion: "1.0",
      sourceLevel: "identity",
      retentionPolicyRef: "provider_terms"
    }]
  });
}

assert.equal(
  normalizeProspectIdentityRegistration("sec_edgar", "cik: 1234")
    .registrationNumber,
  "CIK:0000001234"
);
assert.equal(
  normalizeProspectIdentityRegistration("fr_company_search", "siren 123456789")
    .normalizedIdentifier,
  "123456789"
);
assert.throws(
  () => normalizeProspectIdentityRegistration("gleif", "INVALID"),
  (error) => error instanceof ProspectIdentityBootstrapError
    && error.code === "IDENTITY_BOOTSTRAP_INVALID"
);

const store = isolatedStore();
const target = candidate("manual-target");
store.websiteOpportunities.push(target);
const firstAttempt = attempt("attempt-success", target.id);
const begun = await beginProspectIdentityBootstrap({
  store,
  user,
  candidateId: target.id,
  attempt: firstAttempt
});
assert.equal(begun.replayed, false);
const replay = await beginProspectIdentityBootstrap({
  store,
  user,
  candidateId: target.id,
  attempt: firstAttempt
});
assert.equal(replay.replayed, true);
assert.equal(target.identityBootstrapAttempts?.length, 1);

store.prospectSearchRuns.push(run("run-success", "queued"));
await attachProspectIdentityBootstrapRun({
  store,
  user,
  candidateId: target.id,
  attemptId: firstAttempt.id,
  campaignId: "campaign-run-success",
  campaignVersion: 1,
  strategyId: "strategy-run-success",
  runId: "run-success",
  at: "2026-07-26T00:00:30.000Z"
});
const pending = await reconcileProspectIdentityBootstrap({
  store,
  user,
  candidateId: target.id,
  attemptId: firstAttempt.id,
  at: "2026-07-26T00:00:40.000Z"
});
assert.equal(pending.attempt.taskStatus, "running");
assert.equal(pending.changed, false);

store.prospectSearchRuns[0]!.status = "succeeded";
addSuccessfulLineage(store, {
  runId: "run-success",
  registrationNumber: firstAttempt.registrationNumber,
  targetId: target.id,
  suffix: "success"
});
const linked = await reconcileProspectIdentityBootstrap({
  store,
  user,
  candidateId: target.id,
  attemptId: firstAttempt.id,
  at: "2026-07-26T00:03:00.000Z"
});
assert.equal(linked.attempt.taskStatus, "ended");
assert.equal(linked.attempt.outcome, "linked");
assert.equal(linked.candidate.organizationId, "organization-success");
assert.equal(linked.candidate.tenantProspectId, "prospect-success");
assert.ok(linked.candidate.sourceEvidence?.some((item) =>
  item.providerId === "gleif"
));
assert.deepEqual(
  linked.attempt.events.map((item) => item.stage),
  ["validation", "campaign", "provider", "identity", "coverage", "binding"]
);
const linkedReplay = await reconcileProspectIdentityBootstrap({
  store,
  user,
  candidateId: target.id,
  attemptId: firstAttempt.id,
  at: "2026-07-26T00:04:00.000Z"
});
assert.equal(linkedReplay.changed, false);

const emptyStore = isolatedStore();
const emptyTarget = candidate("manual-empty");
const emptyAttempt = attempt("attempt-empty", emptyTarget.id);
emptyAttempt.runId = "run-empty";
emptyAttempt.campaignId = "campaign-run-empty";
emptyAttempt.campaignVersion = 1;
emptyAttempt.strategyId = "strategy-run-empty";
emptyTarget.identityBootstrapAttempts = [emptyAttempt];
emptyStore.websiteOpportunities.push(emptyTarget);
emptyStore.prospectSearchRuns.push(run("run-empty", "succeeded_empty"));
const empty = await reconcileProspectIdentityBootstrap({
  store: emptyStore,
  user,
  candidateId: emptyTarget.id,
  attemptId: emptyAttempt.id,
  at: "2026-07-26T00:05:00.000Z"
});
assert.equal(empty.attempt.taskStatus, "ended");
assert.equal(empty.attempt.outcome, "not_found");
assert.equal(empty.candidate.organizationId, undefined);

const conflictStore = isolatedStore();
const conflictTarget = candidate("manual-conflict");
const conflictAttempt = attempt("attempt-conflict", conflictTarget.id);
conflictAttempt.runId = "run-conflict";
conflictAttempt.campaignId = "campaign-run-conflict";
conflictAttempt.campaignVersion = 1;
conflictAttempt.strategyId = "strategy-run-conflict";
conflictTarget.identityBootstrapAttempts = [conflictAttempt];
conflictStore.websiteOpportunities.push(conflictTarget);
conflictStore.prospectSearchRuns.push(run("run-conflict", "succeeded"));
addSuccessfulLineage(conflictStore, {
  runId: "run-conflict",
  registrationNumber: conflictAttempt.registrationNumber,
  targetId: conflictTarget.id,
  suffix: "conflict"
});
const conflictResolution = conflictStore.organizationIdentityResolutions[0]!;
conflictResolution.result = "conflict";
conflictResolution.conflictId = "identity-conflict-1";
conflictResolution.organizationId = "";
conflictResolution.bindingId = "";
conflictStore.organizationIdentityConflicts.push({
  id: "identity-conflict-1",
  teamId: user.teamId,
  ownerId: user.id,
  resolutionId: conflictResolution.id,
  rawRecordId: conflictResolution.rawRecordId,
  conflictType: "identifier_split",
  organizationIds: ["organization-a", "organization-b"],
  identifierKeys: [],
  status: "open",
  relationHash: "b".repeat(64),
  conflictHash: "a".repeat(64),
  createdAt: "2026-07-26T00:01:00.000Z"
});
const conflicted = await reconcileProspectIdentityBootstrap({
  store: conflictStore,
  user,
  candidateId: conflictTarget.id,
  attemptId: conflictAttempt.id,
  at: "2026-07-26T00:05:00.000Z"
});
assert.equal(conflicted.attempt.taskStatus, "ended");
assert.equal(conflicted.attempt.outcome, "identity_conflict");
assert.equal(conflicted.attempt.conflictId, "identity-conflict-1");
assert.equal(conflicted.candidate.organizationId, undefined);

const rollbackStore = isolatedStore();
const rollbackTarget = candidate("manual-rollback");
rollbackStore.websiteOpportunities.push(rollbackTarget);
rollbackStore.persist = async () => {
  throw new Error("simulated persistence failure");
};
await assert.rejects(() => beginProspectIdentityBootstrap({
  store: rollbackStore,
  user,
  candidateId: rollbackTarget.id,
  attempt: attempt("attempt-rollback", rollbackTarget.id)
}));
assert.equal(rollbackTarget.identityBootstrapAttempts?.length, 0);

console.log(JSON.stringify({
  ok: true,
  linkedOrganizationId: linked.candidate.organizationId,
  linkedProspectId: linked.candidate.tenantProspectId,
  noResultOutcome: empty.attempt.outcome,
  conflictOutcome: conflicted.attempt.outcome,
  rollbackProtected: true
}, null, 2));
