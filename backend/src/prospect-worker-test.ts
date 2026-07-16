import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  defineProvider,
  ProviderContractError,
  PROVIDER_CONTRACT_VERSION,
  type LeadProvider
} from "./provider-contract.js";
import { ProspectProviderDispatcher } from "./prospect-provider-dispatcher.js";
import {
  registerProspectRunQueueBridge,
  validateProspectRunQueueBridge
} from "./prospect-run-queue-bridge.js";
import {
  PROSPECT_COVERAGE_MEMORY_CONTRACT,
  recordProspectCoverage
} from "./prospect-coverage-memory.js";
import {
  prospectRunExecutionSnapshotHash
} from "./prospect-runs.js";
import { ProspectCandidatePipeline } from "./prospect-candidate-pipeline.js";
import {
  syncProspectCandidateCoverage
} from "./prospect-candidate-actions.js";
import { ProspectWorker } from "./prospect-worker.js";
import { getStore } from "./store.js";
import type {
  ProspectRunExecutionSnapshot,
  ProspectSearchRun,
  ProspectStrategyQuery,
  ProviderCatalogItem,
  User
} from "./types.js";

const store = getStore();
const successCode = "worker_stage_success";
const failureCode = "worker_stage_failure";
const gleifCode = "gleif";
const adapterVersion = "worker-stage-v1";
const catalogVersion = "worker-policy-v1";

function testUser(id: string, teamId: string): User {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    password: "test-only",
    role: "sales",
    teamId,
    avatar: id.slice(0, 2).toUpperCase(),
    status: "active",
    authVersion: 1
  };
}

function testProviderCatalog(
  provider: LeadProvider
): ProviderCatalogItem {
  const now = "2026-07-15T00:00:00.000Z";
  return {
    id: `provider_${provider.id}`,
    code: provider.id,
    name: provider.name,
    category: provider.category,
    sourceLevel: "identity",
    accessMode: provider.accessMode,
    baseUrl: provider.defaultBaseUrl || "",
    officialDocsUrl: provider.docsUrl,
    capabilities: [...provider.capabilities],
    allowedFields: [
      "company",
      "officialWebsite",
      "country",
      "business",
      "description",
      "providerRecordId",
      "sourceUrl",
      "recordType",
      "evidenceSummary",
      "matchedFields"
    ],
    licensePolicy: { tier: "free", requiresKey: false },
    defaultRatePolicy: {},
    retentionPolicy: {
      mode: "provider_terms",
      retentionDays: 30
    },
    status: "active",
    version: catalogVersion,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function executionSnapshot(
  providerCodes: string[]
): ProspectRunExecutionSnapshot {
  const query: ProspectStrategyQuery = {
    keywordMode: "specific",
    positiveKeywords: ["industrial lighting"],
    synonyms: ["warehouse light"],
    industryTerms: ["industrial distribution"],
    purchaseScenarioTerms: ["import"],
    countryMode: "specific",
    countries: ["DE"],
    languages: ["en"],
    customerTypeMode: "specific",
    customerTypes: ["importer"],
    exclusionKeywords: [],
    exclusionDomains: [],
    timeWindow: { mode: "all", from: "", to: "" }
  };
  return {
    contractVersion: "search_run_control_plane_v1",
    campaign: {
      id: `pcg_${randomUUID()}`,
      name: "Worker stage campaign",
      version: 1,
      contentHash: "a".repeat(64),
      snapshot: {
        goal: "Find verified industrial lighting importers",
        products: ["industrial lighting"],
        markets: ["DE"],
        customerTypes: ["importer"],
        applicationScenarios: ["warehouse"],
        icpRules: [],
        exclusionRules: [],
        sourceProviderIds: providerCodes
      }
    },
    strategy: {
      id: `pstr_${randomUUID()}`,
      name: "Worker stage strategy",
      revision: 1,
      fingerprintVersion: "v1",
      queryFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      query
    },
    resolvedQuery: {
      positiveKeywords: [...query.positiveKeywords],
      synonyms: [...query.synonyms],
      industryTerms: [...query.industryTerms],
      purchaseScenarioTerms: [...query.purchaseScenarioTerms],
      countries: [...query.countries],
      languages: [...query.languages],
      customerTypes: [...query.customerTypes],
      exclusionKeywords: [],
      exclusionDomains: [],
      timeWindow: { ...query.timeWindow }
    },
    providerPlan: providerCodes.map((providerCode, index) => ({
      providerCode,
      position: index + 1,
      priority: 50,
      pageLimit: 1,
      resultLimit: 10,
      budgetLimit: null,
      currency: "",
      adapterVersion,
      contractVersion: PROVIDER_CONTRACT_VERSION,
      catalogVersion,
      capabilities: ["company"],
      accessMode: "api"
    }))
  };
}

function createRun(owner: User, providerCodes: string[]) {
  const now = new Date().toISOString();
  const snapshot = executionSnapshot(providerCodes);
  const run: ProspectSearchRun = {
    id: `pr_${randomUUID()}`,
    teamId: owner.teamId,
    campaignId: snapshot.campaign.id,
    campaignVersion: 1,
    strategyId: snapshot.strategy.id,
    ownerId: owner.id,
    status: "queued",
    revision: 1,
    executionEpoch: 1,
    operationCode: "create_search_run_v1",
    idempotencyKeyHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    requestHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    queryFingerprint: snapshot.strategy.queryFingerprint,
    executionSnapshot: snapshot,
    executionSnapshotHash: prospectRunExecutionSnapshotHash(snapshot),
    queueBridgeVersion: "v1",
    parentRunId: "",
    createdBy: owner.id,
    createdAt: now,
    updatedAt: now,
    pausedAt: "",
    cancelledAt: ""
  };
  store.prospectSearchRuns.push(run);
  for (const provider of snapshot.providerPlan) {
    store.prospectRunShards.push({
      id: `prsh_${randomUUID()}`,
      teamId: run.teamId,
      runId: run.id,
      providerCode: provider.providerCode,
      position: provider.position,
      status: "queued",
      pageLimit: provider.pageLimit,
      resultLimit: provider.resultLimit,
      budgetLimit: provider.budgetLimit,
      currency: provider.currency,
      adapterVersion: provider.adapterVersion,
      contractVersion: provider.contractVersion,
      catalogVersion: provider.catalogVersion,
      capabilities: [...provider.capabilities],
      accessMode: provider.accessMode,
      hasCursor: false,
      createdAt: now,
      updatedAt: now
    });
  }
  store.prospectRunEvents.push({
    id: `pre_${randomUUID()}`,
    teamId: run.teamId,
    runId: run.id,
    sequence: 1,
    eventType: "created",
    actorId: owner.id,
    requestId: `worker-test:${run.id}`,
    fromStatus: "",
    toStatus: "queued",
    fromRevision: 0,
    toRevision: 1,
    reason: "worker stage test",
    createdAt: now
  });
  registerProspectRunQueueBridge(store, run);
  return run;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3_000
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const successProvider = defineProvider({
  id: successCode,
  name: "Worker success provider",
  adapterVersion,
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company"],
  docsUrl: "https://example.com/provider-docs",
  keyHint: "",
  defaultBaseUrl: "https://example.com/api",
  costNote: "",
  networkPolicy: {
    allowedHosts: ["example.com"],
    allowedPathPrefixes: ["/api/"],
    allowedMethods: ["GET"]
  },
  async search(_request, _credential, tools) {
    assert.ok(tools.http);
    return {
      records: [{
        company: "Worker Verified Company",
        officialWebsite: "https://example.com/company",
        country: "DE",
        business: "Industrial lighting importer",
        description: "Stage-level background execution fixture",
        providerRecordId: `worker-record-${randomUUID()}`,
        sourceUrl: "https://example.com/company/profile",
        recordType: "identity_evidence",
        evidenceSummary: "Verified provider fixture",
        matchedFields: ["company", "country"]
      }],
      exhausted: true
    };
  },
  async health() {
    return { ok: true, message: "ok" };
  }
});

const failureProvider = defineProvider({
  id: failureCode,
  name: "Worker failure provider",
  adapterVersion,
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company"],
  docsUrl: "https://example.com/provider-docs",
  keyHint: "",
  defaultBaseUrl: "https://example.com/api",
  costNote: "",
  networkPolicy: {
    allowedHosts: ["example.com"],
    allowedPathPrefixes: ["/api/"],
    allowedMethods: ["GET"]
  },
  async search() {
    throw new ProviderContractError({
      code: "PROVIDER_AUTH_FAILED",
      retryable: false,
      retryAfterAt: null,
      publicMessage: "Provider credential rejected",
      httpStatus: 401,
      phase: "search"
    });
  },
  async health() {
    return { ok: false, message: "not configured" };
  }
});

const gleifProvider = defineProvider({
  id: gleifCode,
  name: "GLEIF worker fixture",
  adapterVersion,
  tier: "free",
  category: "company",
  requiresKey: false,
  capabilities: ["company"],
  docsUrl: "https://www.gleif.org/",
  keyHint: "",
  defaultBaseUrl: "https://api.gleif.org/api/v1",
  costNote: "",
  networkPolicy: {
    allowedHosts: ["api.gleif.org"],
    allowedPathPrefixes: ["/api/v1/"],
    allowedMethods: ["GET"]
  },
  async search() {
    return {
      records: [{
        company: "GLEIF Worker Company",
        officialWebsite: "",
        country: "DE",
        business: "Industrial lighting importer",
        description: "Authoritative legal entity identity fixture",
        providerRecordId: "5493001KJTIIGC8Y1R12",
        sourceUrl:
          "https://search.gleif.org/#/record/5493001KJTIIGC8Y1R12",
        recordType: "identity_evidence",
        evidenceSummary: "GLEIF legal entity identity",
        matchedFields: ["company", "country"]
      }],
      exhausted: true
    };
  },
  async health() {
    return { ok: true, message: "ok" };
  }
});

const originalPersist = store.persist;
const originalPersistProspectExecutionMutation =
  store.persistProspectExecutionMutation;
const originalPersistProspectCandidateMutation =
  store.persistProspectCandidateMutation;
let executionMutationCount = 0;
let candidateMutationCount = 0;
store.persist = async () => undefined;
store.persistProspectExecutionMutation = async <T>(mutation: () => {
  value: T;
  rollback(): void;
}) => {
  executionMutationCount += 1;
  return mutation().value;
};
store.persistProspectCandidateMutation = async <T>(mutation: () => {
  value: T;
  rollback(): void;
}) => {
  candidateMutationCount += 1;
  return mutation().value;
};
const ownerA = testUser("worker_owner_a", "worker_team_a");
const ownerB = testUser("worker_owner_b", "worker_team_b");
store.users.push(ownerA, ownerB);
store.providerCatalog.splice(
  0,
  store.providerCatalog.length,
  ...store.providerCatalog.filter((item) => item.code !== gleifCode)
);
store.providerCatalog.push(
  testProviderCatalog(successProvider),
  testProviderCatalog(failureProvider),
  testProviderCatalog(gleifProvider)
);

const businessCounts = {
  leads: store.leads.length,
  customers: store.customers.length,
  deals: store.deals.length,
  opportunities: store.websiteOpportunities.length
};
const teamARun = createRun(ownerA, [
  successCode,
  failureCode,
  gleifCode
]);
const teamBRun = createRun(ownerB, [successCode]);
const teamARepeatRun = createRun(ownerA, [gleifCode]);
const dispatchScopes: string[] = [];
const dispatcher = new ProspectProviderDispatcher({
  store,
  resolveProvider(request) {
    dispatchScopes.push([
      request.teamId,
      request.ownerId,
      request.runId,
      request.providerCode
    ].join(":"));
    if (request.providerCode === successCode) {
      return { provider: successProvider };
    }
    if (request.providerCode === failureCode) {
      return { provider: failureProvider };
    }
    if (request.providerCode === gleifCode) {
      return { provider: gleifProvider };
    }
    return undefined;
  }
});
const providerRawEnvelopeSecret =
  "worker-stage-provider-raw-secret-at-least-32-characters";
const organizationIdentitySecret =
  "worker-stage-identity-secret-at-least-32-characters";
const prospectCoverageSecret =
  "worker-stage-coverage-secret-at-least-32-characters";
const worker = new ProspectWorker({
  store,
  dispatcher,
  claimSecret: "worker-stage-test-secret-at-least-32-characters",
  providerRawEnvelopeSecret,
  organizationIdentitySecret,
  prospectCoverageSecret,
  workerId: "worker-stage-test",
  pollMs: 5_000
});

try {
  await worker.start();
  await waitFor(
    () => teamARun.status === "partial_success"
      && teamBRun.status === "succeeded"
      && teamARepeatRun.status === "succeeded",
    "all team-scoped runs to finish"
  );
  assert.equal(teamARun.status, "partial_success");
  assert.equal(teamBRun.status, "succeeded");
  assert.equal(teamARepeatRun.status, "succeeded");
  assert.equal(dispatchScopes.length, 5);
  assert.ok(
    executionMutationCount > 0,
    "execution kernel should prefer the prospect execution transaction path"
  );
  assert.ok(
    candidateMutationCount > 0,
    "candidate cleaning should prefer its dedicated transaction path"
  );
  assert.ok(dispatchScopes.every((scope) =>
    scope.startsWith(`${ownerA.teamId}:${ownerA.id}:`)
    || scope.startsWith(`${ownerB.teamId}:${ownerB.id}:`)
  ));
  assert.equal(
    store.prospectProviderRequestLedgers.filter((item) =>
      item.runId === teamARun.id || item.runId === teamBRun.id
      || item.runId === teamARepeatRun.id
    ).length,
    5
  );
  assert.equal(
    store.prospectSourceRawHits.filter((item) =>
      item.runId === teamARun.id
    ).length,
    2
  );
  assert.equal(
    store.prospectSourceRawHits.filter((item) =>
      item.runId === teamARepeatRun.id
    ).length,
    1
  );
  assert.equal(
    store.prospectSourceRawHits.filter((item) =>
      item.runId === teamBRun.id
    ).length,
    1
  );
  for (const ledger of store.prospectProviderRequestLedgers.filter(
    (item) => item.runId === teamARun.id
      || item.runId === teamBRun.id
      || item.runId === teamARepeatRun.id
  )) {
    const run = ledger.runId === teamARun.id
      ? teamARun
      : ledger.runId === teamBRun.id
        ? teamBRun
        : teamARepeatRun;
    assert.equal(ledger.teamId, run.teamId);
    assert.equal(ledger.ownerId, run.ownerId);
    assert.equal(ledger.status, "settled");
  }
  assert.deepEqual({
    leads: store.leads.length,
    customers: store.customers.length,
    deals: store.deals.length
  }, {
    leads: businessCounts.leads,
    customers: businessCounts.customers,
    deals: businessCounts.deals
  });
  const generated = store.websiteOpportunities.filter((item) =>
    item.source === successCode
    && [teamARun.id, teamBRun.id].some((runId) =>
      item.sourceEvidence?.some((evidence) =>
        evidence.providerRecordId.includes("worker-record-")
        && store.prospectSourceRawHits.some((hit) =>
          hit.runId === runId
          && hit.teamId === item.teamId
          && hit.ownerId === item.ownerId
        )
      )
    )
  );
  assert.equal(generated.length, 2);
  assert.equal(
    generated.filter((item) =>
      item.teamId === ownerA.teamId && item.ownerId === ownerA.id
    ).length,
    1
  );
  assert.equal(
    generated.filter((item) =>
      item.teamId === ownerB.teamId && item.ownerId === ownerB.id
    ).length,
    1
  );
  const gleifCandidate = store.websiteOpportunities.find((item) =>
    item.teamId === ownerA.teamId
    && item.ownerId === ownerA.id
    && item.source === gleifCode
    && item.sourceEvidence?.some((evidence) =>
      evidence.providerRecordId === "5493001KJTIIGC8Y1R12"
    )
  );
  assert.ok(gleifCandidate);
  assert.equal(
    store.organizations.filter((item) =>
      item.teamId === ownerA.teamId
    ).length,
    1
  );
  assert.equal(
    store.tenantProspects.filter((item) =>
      item.teamId === ownerA.teamId
    ).length,
    1
  );
  assert.equal(
    store.prospectCoverageEvents.filter((item) =>
      item.teamId === ownerA.teamId
      && item.sourceHitId
    ).length,
    2
  );
  assert.deepEqual(
    store.prospectCoverageEvents
      .filter((item) =>
        item.teamId === ownerA.teamId
        && item.sourceHitId
      )
      .map((item) => item.classification)
      .sort(),
    ["duplicate", "net_new"]
  );
  assert.equal(
    store.websiteOpportunities.filter((item) =>
      item.teamId === ownerA.teamId
      && item.ownerId === ownerA.id
      && item.organizationId === gleifCandidate.organizationId
    ).length,
    1
  );
  const opportunityCountBeforeReplay = store.websiteOpportunities.length;
  const replay = await new ProspectCandidatePipeline({
    store,
    rawEnvelopeSecret: providerRawEnvelopeSecret,
    identitySecret: organizationIdentitySecret,
    coverageSecret: prospectCoverageSecret
  }).processPending();
  assert.equal(replay.failures.length, 0);
  assert.equal(replay.attempted, 0);
  assert.equal(replay.processed, 0);
  assert.equal(replay.suppressed, 0);
  assert.equal(
    store.prospectCandidateProcessingStates?.filter((item) =>
      item.teamId === ownerA.teamId
      || item.teamId === ownerB.teamId
    ).length,
    4
  );
  assert.equal(store.websiteOpportunities.length, opportunityCountBeforeReplay);
  assert.equal(
    store.prospectCoverageEvents.filter((item) =>
      item.teamId === ownerA.teamId
      && item.sourceHitId
    ).length,
    2
  );
  const dispositionBusinessCounts = {
    leads: store.leads.length,
    customers: store.customers.length,
    deals: store.deals.length
  };
  await syncProspectCandidateCoverage({
    store,
    candidate: gleifCandidate,
    actorId: ownerA.id,
    action: "exclude",
    requestId: "worker-test-exclude-trusted-candidate",
    effectiveAt: new Date().toISOString(),
    coverageSecret: prospectCoverageSecret
  });
  gleifCandidate.excludedReason = "非目标行业";
  assert.equal(
    store.tenantProspects.find((item) =>
      item.id === gleifCandidate.tenantProspectId
    )?.status,
    "excluded"
  );
  const initialCoverageEvent = store.prospectCoverageEvents.find((item) =>
    item.teamId === ownerA.teamId
    && item.organizationId === gleifCandidate.organizationId
    && item.classification === "net_new"
  );
  assert.ok(initialCoverageEvent);
  const originalHit = store.prospectSourceRawHits.find((item) =>
    item.id === initialCoverageEvent.sourceHitId
  );
  assert.ok(originalHit);
  const excludedAt = new Date(Date.now() + 1_000).toISOString();
  const excludedHit = {
    ...originalHit,
    id: `psrh_${randomUUID()}`,
    batchId: `psrb_${randomUUID()}`,
    ledgerId: `pprl_${randomUUID()}`,
    ordinal: originalHit.ordinal + 100,
    fetchedAt: excludedAt,
    createdAt: excludedAt
  };
  store.prospectSourceRawHits.push(excludedHit);
  const excludedCoverage = recordProspectCoverage(store, {
    teamId: ownerA.teamId,
    ownerId: ownerA.id,
    resolutionId: initialCoverageEvent.resolutionId,
    sourceHitId: excludedHit.id,
    contractVersion: PROSPECT_COVERAGE_MEMORY_CONTRACT,
    evidenceVersion: "material-evidence-v1",
    coveredAt: excludedAt,
    evidence: [],
    coverageSecret: prospectCoverageSecret
  });
  assert.equal(excludedCoverage.classification, "excluded");
  assert.equal(excludedCoverage.queueAction, "suppress");
  assert.equal(
    store.websiteOpportunities.filter((item) =>
      item.teamId === ownerA.teamId
      && item.organizationId === gleifCandidate.organizationId
    ).length,
    1
  );
  await syncProspectCandidateCoverage({
    store,
    candidate: gleifCandidate,
    actorId: ownerA.id,
    action: "restore",
    requestId: "worker-test-restore-trusted-candidate",
    effectiveAt: new Date(Date.now() + 2_000).toISOString(),
    coverageSecret: prospectCoverageSecret
  });
  assert.equal(gleifCandidate.status, "preview");
  assert.equal(
    store.tenantProspects.find((item) =>
      item.id === gleifCandidate.tenantProspectId
    )?.status,
    "active"
  );
  const reviewedAt = new Date(Date.now() + 3_000).toISOString();
  await syncProspectCandidateCoverage({
    store,
    candidate: gleifCandidate,
    actorId: ownerA.id,
    action: "mark-contactable",
    requestId: "worker-test-review-trusted-candidate",
    effectiveAt: reviewedAt,
    coverageSecret: prospectCoverageSecret
  });
  assert.equal(gleifCandidate.status, "contactable");
  assert.equal(
    store.tenantProspects.find((item) =>
      item.id === gleifCandidate.tenantProspectId
    )?.lastReviewedAt,
    reviewedAt
  );
  const linkedLead = {
    id: `lead_${randomUUID()}`,
    company: gleifCandidate.company,
    contact: "Purchasing Team",
    country: gleifCandidate.country,
    email: "",
    phone: "",
    wechat: "",
    source: gleifCandidate.sourceLabel || "GLEIF",
    sourceType: "outbound" as const,
    sourceChannel: gleifCode,
    sourceCampaign: "",
    externalId: gleifCandidate.id,
    sourceUrl: "",
    intent: "中",
    stage: "新线索",
    status: "new" as const,
    ownerId: ownerA.id,
    teamId: ownerA.teamId,
    estimatedAmount: 0,
    nextFollowAt: "",
    lastActivityAt: "刚刚",
    remark: "",
    convertedCustomerId: "",
    convertedDealId: "",
    createdAt: new Date(Date.now() + 4_000).toISOString()
  };
  store.leads.push(linkedLead);
  await syncProspectCandidateCoverage({
    store,
    candidate: gleifCandidate,
    actorId: ownerA.id,
    action: "link-lead",
    requestId: "worker-test-link-trusted-candidate",
    effectiveAt: linkedLead.createdAt,
    leadId: linkedLead.id,
    coverageSecret: prospectCoverageSecret
  });
  assert.equal(
    store.tenantProspects.find((item) =>
      item.id === gleifCandidate.tenantProspectId
    )?.leadId,
    linkedLead.id
  );
  assert.equal(gleifCandidate.coverageQueueState, "converted");
  assert.equal(gleifCandidate.status, "synced");
  assert.deepEqual({
    leads: store.leads.length,
    customers: store.customers.length,
    deals: store.deals.length
  }, {
    leads: dispositionBusinessCounts.leads + 1,
    customers: dispositionBusinessCounts.customers,
    deals: dispositionBusinessCounts.deals
  });
  assert.doesNotThrow(() =>
    validateProspectRunQueueBridge(store, teamARun)
  );
  assert.doesNotThrow(() =>
    validateProspectRunQueueBridge(store, teamBRun)
  );
  assert.doesNotThrow(() =>
    validateProspectRunQueueBridge(store, teamARepeatRun)
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  const stopStartedAt = Date.now();
  await worker.stop();
  assert.ok(
    Date.now() - stopStartedAt < 1_000,
    "idle worker should wake and stop without waiting for poll timeout"
  );
  console.log("Prospect worker stage test passed");
} finally {
  await worker.stop();
  store.persist = originalPersist;
  store.persistProspectExecutionMutation =
    originalPersistProspectExecutionMutation;
  store.persistProspectCandidateMutation =
    originalPersistProspectCandidateMutation;
}
