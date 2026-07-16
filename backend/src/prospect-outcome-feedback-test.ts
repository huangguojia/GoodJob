import assert from "node:assert/strict";
import {
  generateProspectStrategySuggestions,
  prospectPerformance,
  recordAcquisitionOutcomeFeedback,
  reviewProspectStrategySuggestion
} from "./prospect-outcome-feedback.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type {
  Deal,
  ProspectCoverageEvent,
  ProspectSearchRun,
  ProspectTouchpoint,
  WebsiteOpportunity
} from "./types.js";

function isolatedStore(): CrmStore {
  return {
    ...getStore(),
    mode: "memory",
    websiteOpportunities: [],
    prospectTouchpoints: [],
    procurementSignals: [],
    dealRecommendations: [],
    acquisitionOutcomeFeedback: [],
    prospectStrategySuggestions: [],
    tenantProspects: [],
    prospectCoverageEvents: [],
    prospectSourceRawHits: [],
    prospectSourceRawBatches: [],
    prospectSearchRuns: [],
    prospectIcpAssessmentSnapshots: [],
    prospectStrategies: [],
    leads: [],
    customers: [],
    deals: [],
    dealEvents: [],
    async persist() {},
    async readBarrier() {}
  };
}

function candidate(
  id: string,
  ownerId = "sales-a",
  teamId = "team-a"
): WebsiteOpportunity {
  return {
    id,
    company: `Buyer ${id}`,
    business: "Industrial equipment",
    country: "DE",
    website: `https://${id}.example.test`,
    contact: "Buyer",
    contactInfo: `buyer@${id}.example.test`,
    ownerId,
    teamId,
    status: "contacted",
    tenantProspectId: `prospect-${id}`,
    organizationId: `organization-${id}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    description: ""
  };
}

function deal(
  id: string,
  ownerId = "sales-a",
  teamId = "team-a"
): Deal {
  return {
    id,
    customerId: `customer-${id}`,
    title: `Deal ${id}`,
    stage: "成交",
    product: "Industrial equipment",
    quantity: 10,
    unitPrice: 1000,
    amount: 10000,
    currency: "USD",
    amountType: "won",
    ownerId,
    teamId,
    nextAction: "安排交付",
    nextActionAt: "2026-07-20",
    expectedCloseAt: "2026-07-15",
    stageChangedAt: "2026-07-15T00:00:00.000Z",
    closedAt: "2026-07-15T00:00:00.000Z",
    wonReason: "客户确认 PI"
  };
}

function coverage(
  item: WebsiteOpportunity,
  sourceHitId = ""
): ProspectCoverageEvent {
  return {
    id: `coverage-${item.id}`,
    prospectId: item.tenantProspectId!,
    teamId: item.teamId,
    ownerId: item.ownerId,
    organizationId: item.organizationId!,
    resolutionId: `resolution-${item.id}`,
    rawRecordId: `record-${item.id}`,
    sourceHitId,
    campaignId: "campaign-a",
    strategyId: "strategy-a",
    runId: "run-a",
    shardId: "shard-a",
    sequence: 1,
    eventType: "coverage_classified",
    dispositionAction: "",
    classification: "net_new",
    queueAction: "enqueue",
    reasonCode: "new_organization",
    processingKeyHash: "a".repeat(64),
    requestHash: "b".repeat(64),
    newEvidenceKeyHashes: [],
    newSourceKeyHashes: [],
    evidenceSnapshotHash: "c".repeat(64),
    sourceSnapshotHash: "d".repeat(64),
    previousEventHash: "",
    eventHash: "e".repeat(64),
    createdAt: "2026-07-01T00:00:00.000Z"
  };
}

function outbound(item: WebsiteOpportunity): ProspectTouchpoint {
  return {
    id: `outbound-${item.id}`,
    teamId: item.teamId,
    ownerId: item.ownerId,
    prospectCandidateId: item.id,
    tenantProspectId: item.tenantProspectId,
    organizationId: item.organizationId,
    channel: "email",
    direction: "outbound",
    contactValue: item.contactInfo,
    subject: "Introduction",
    content: "Hello",
    requestId: `request-${item.id}`,
    occurredAt: "2026-07-02T00:00:00.000Z",
    createdAt: "2026-07-02T00:00:00.000Z"
  };
}

{
  const store = isolatedStore();
  const item = candidate("linked");
  const wonDeal = deal("linked");
  item.dealId = wonDeal.id;
  item.leadId = "lead-linked";
  item.customerId = wonDeal.customerId;
  store.websiteOpportunities.push(item);
  store.deals.push(wonDeal);
  store.tenantProspects.push({
    id: item.tenantProspectId!,
    teamId: item.teamId,
    organizationId: item.organizationId!,
    status: "converted",
    latestClassification: "net_new",
    queueState: "converted",
    queueReasonCode: "linked_crm",
    firstSeenAt: item.createdAt,
    lastSeenAt: item.createdAt,
    lastMaterialChangeAt: item.createdAt,
    lastQueuedAt: item.createdAt,
    lastReviewedAt: item.createdAt,
    nextReviewAt: "",
    hitCount: 1,
    sourceCount: 1,
    evidenceCount: 1,
    sourceKeyHashes: [],
    materialEvidenceKeyHashes: [],
    exclusionScope: "none",
    exclusionMode: "none",
    exclusionReasonCode: "",
    excludedUntil: "",
    leadId: item.leadId,
    customerId: item.customerId,
    dealId: wonDeal.id,
    version: 1,
    eventCount: 1,
    eventTailHash: "f".repeat(64),
    prospectHash: "0".repeat(64),
    createdAt: item.createdAt,
    updatedAt: item.createdAt
  });
  store.prospectCoverageEvents.push(coverage(item, "hit-a"));
  store.prospectSourceRawHits.push({
    id: "hit-a",
    batchId: "batch-a",
    recordId: "record-a",
    teamId: item.teamId,
    ownerId: item.ownerId,
    runId: "run-a",
    shardId: "shard-a",
    jobId: "job-a",
    attemptId: "attempt-a",
    ledgerId: "ledger-a",
    pageId: "page-a",
    ordinal: 1,
    fetchedAt: item.createdAt,
    hitHash: "1".repeat(64),
    createdAt: item.createdAt
  });
  store.prospectSourceRawBatches.push({
    id: "batch-a",
    teamId: item.teamId,
    ownerId: item.ownerId,
    runId: "run-a",
    shardId: "shard-a",
    jobId: "job-a",
    attemptId: "attempt-a",
    ledgerId: "ledger-a",
    pageId: "page-a",
    providerCode: "provider-a",
    connectionId: "connection-a",
    endpointCode: "search",
    adapterVersion: "v1",
    responseSchemaVersion: "fake-provider-source-records-v1",
    responseHash: "2".repeat(64),
    settlementHash: "3".repeat(64),
    rawArtifactHash: "4".repeat(64),
    recordCount: 1,
    licensePolicy: "test",
    retentionPolicy: "test",
    retentionDays: 30,
    retentionUntil: "2026-08-01T00:00:00.000Z",
    batchHash: "5".repeat(64),
    createdAt: item.createdAt
  });
  store.prospectSearchRuns.push({
    id: "run-a",
    teamId: item.teamId,
    ownerId: item.ownerId,
    campaignId: "campaign-a",
    campaignVersion: 3,
    strategyId: "strategy-a"
  } as ProspectSearchRun);

  const result = recordAcquisitionOutcomeFeedback(store, {
    deal: wonDeal,
    outcome: "won",
    reason: "客户确认 PI"
  });
  assert.equal(result.created, true);
  assert.deepEqual(result.feedback?.providerCodes, ["provider-a"]);
  assert.equal(result.feedback?.campaignVersion, 3);
  assert.equal(result.feedback?.ownerId, "sales-a");

  const replay = recordAcquisitionOutcomeFeedback(store, {
    deal: wonDeal,
    outcome: "won",
    reason: "重复请求"
  });
  assert.equal(replay.created, false);
  assert.equal(store.acquisitionOutcomeFeedback.length, 1);

  const summary = prospectPerformance(store, {
    teamId: "team-a",
    ownerId: "sales-a"
  });
  assert.equal(summary.metrics.candidates, 1);
  assert.equal(summary.metrics.leads, 1);
  assert.equal(summary.metrics.customers, 1);
  assert.equal(summary.metrics.deals, 1);
  assert.equal(summary.metrics.won, 1);
  assert.deepEqual(summary.metrics.wonRevenue, [{
    currency: "USD",
    amount: 10000
  }]);
  assert.equal(
    prospectPerformance(store, {
      teamId: "team-a",
      ownerId: "sales-b"
    }).metrics.candidates,
    0
  );
}

{
  const store = isolatedStore();
  const ordinaryDeal = deal("ordinary");
  store.deals.push(ordinaryDeal);
  const result = recordAcquisitionOutcomeFeedback(store, {
    deal: ordinaryDeal,
    outcome: "won",
    reason: "普通 CRM 商机"
  });
  assert.equal(result.feedback, undefined);
  assert.equal(store.acquisitionOutcomeFeedback.length, 0);
}

{
  const store = isolatedStore();
  for (let index = 0; index < 9; index += 1) {
    const item = candidate(`weak-${index}`);
    store.websiteOpportunities.push(item);
    store.prospectCoverageEvents.push(coverage(item));
    if (index < 4) store.prospectTouchpoints.push(outbound(item));
  }
  assert.equal(generateProspectStrategySuggestions(store, {
    teamId: "team-a",
    ownerId: "sales-a"
  }).length, 0);
}

{
  const store = isolatedStore();
  for (let index = 0; index < 10; index += 1) {
    const item = candidate(`sample-${index}`);
    store.websiteOpportunities.push(item);
    store.prospectCoverageEvents.push(coverage(item));
    if (index < 5) store.prospectTouchpoints.push(outbound(item));
  }
  const activeStrategy = {
    id: "strategy-a",
    teamId: "team-a",
    ownerId: "sales-a",
    status: "approved",
    revision: 4,
    query: { positiveKeywords: ["pump"] }
  };
  store.prospectStrategies.push(activeStrategy as never);
  const before = structuredClone(activeStrategy);
  const created = generateProspectStrategySuggestions(store, {
    teamId: "team-a",
    ownerId: "sales-a"
  }, "2026-07-15T06:00:00.000Z");
  assert.equal(created.length, 1);
  assert.equal(created[0]?.suggestionType, "refine_targeting_keywords");
  assert.equal(generateProspectStrategySuggestions(store, {
    teamId: "team-a",
    ownerId: "sales-a"
  }, "2026-07-15T07:00:00.000Z").length, 0);
  assert.equal(store.prospectStrategySuggestions.length, 1);

  reviewProspectStrategySuggestion(store, {
    teamId: "team-a",
    ownerId: "sales-a",
    suggestionId: created[0]!.id,
    status: "accepted",
    note: "进入人工策略评审"
  });
  assert.equal(created[0]!.status, "accepted");
  assert.deepEqual(activeStrategy, before);
  assert.throws(() => reviewProspectStrategySuggestion(store, {
    teamId: "team-a",
    ownerId: "sales-b",
    suggestionId: created[0]!.id,
    status: "rejected"
  }), /无权访问/u);
}

console.log("Prospect outcome feedback tests passed");
