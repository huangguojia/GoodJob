import assert from "node:assert/strict";
import {
  buildProspectProviderResolvedQueries,
  planProspectSearchRound,
  validateProspectSearchQueryPlan
} from "./prospect-search-planner.js";
import { prospectSuperSearchConvergenceReason } from "./prospect-super-search.js";
import { probableOfficialWebsite } from "./lead-providers.js";
import { webDiscoveryWebsite } from "./prospect-candidate-pipeline.js";
import {
  createProspectDeepMiningState,
  planProspectDeepMiningRound,
  selectNextDeepMiningTask,
  settleDeepMiningRound,
  synchronizeDeepMiningCandidates
} from "./prospect-deep-mining.js";
import type {
  ProspectResolvedQuerySnapshot,
  ProspectSuperSearchMission,
  WebsiteOpportunity
} from "./types.js";

const query: ProspectResolvedQuerySnapshot = {
  positiveKeywords: ["industrial pump"],
  synonyms: [],
  industryTerms: ["water"],
  purchaseScenarioTerms: ["supplier"],
  countries: ["Germany"],
  languages: ["en"],
  customerTypes: ["distributor"],
  exclusionKeywords: [],
  exclusionDomains: [],
  timeWindow: { mode: "all", from: "", to: "" }
};

function evidence(providerId: string, sourceUrl: string, payloadHash: string, summary: string) {
  return {
    providerId,
    providerRecordId: `${providerId}-${payloadHash}`,
    officialWebsite: sourceUrl,
    sourceUrl,
    recordType: "company_relationship",
    fetchedAt: "2026-07-31T00:00:00.000Z",
    payloadHash,
    evidenceSummary: summary,
    matchedFields: ["company", "officialWebsite"],
    adapterVersion: "test-v1",
    catalogPolicyVersion: "test-v1",
    sourceLevel: "public",
    fieldAuthority: { officialWebsite: "official" as const },
    retentionPolicyRef: "test"
  };
}

function candidate(id: string, teamId = "team_a", score = 70, source = true): WebsiteOpportunity {
  return {
    id,
    company: id === "root" ? "Root Pumps" : id === "child" ? "Partner GmbH" : "Other GmbH",
    business: "industrial pump distribution",
    country: "DE",
    website: `https://${id}.example.com`,
    contact: "",
    contactInfo: "",
    description: "public discovery",
    ownerId: "owner_a",
    teamId,
    status: "preview",
    createdAt: "2026-07-31T00:00:00.000Z",
    source: "web_search",
    sourceEvidence: source ? [evidence("web_search", `https://${id}.example.com/products`, `${id}-hash`, "authorized distributor and supplier relationship")] : [],
    scorecard: {
      version: "prospect-scorecard-v1",
      generatedAt: "2026-07-31T00:00:00.000Z",
      enterpriseConfidence: { score, status: "partial", reasonCodes: [], evidenceRefs: [] },
      icpMatch: { score, status: "partial", reasonCodes: [], evidenceRefs: [] },
      contactReadiness: { score: 55, status: "partial", reasonCodes: [], evidenceRefs: [] },
      actionPriority: { score, status: "partial", reasonCodes: [], evidenceRefs: [] },
      vqa: { qualified: false, reasonCodes: [] }
    }
  };
}

function mission(depth: "balanced" | "deep" | "extreme" = "deep"): ProspectSuperSearchMission {
  return {
    id: "pssm_test-deep-mining",
    teamId: "team_a",
    ownerId: "owner_a",
    campaignId: "campaign_a",
    strategyId: "strategy_a",
    status: "running",
    targetCandidateCount: 20,
    maxDurationMinutes: 60,
    depth,
    maxRounds: depth === "balanced" ? 4 : depth === "deep" ? 8 : 16,
    costLimit: 0,
    currency: "",
    aiMode: "off",
    currentRound: 1,
    currentRunId: "pr_test-round",
    totalCost: 0,
    rawCount: 1,
    uniqueCount: 1,
    candidateCount: 1,
    reviewReadyCount: 0,
    vqaCount: 0,
    pendingCount: 0,
    filteredCount: 0,
    revision: 1,
    startedAt: "2026-07-31T00:00:00.000Z",
    deadlineAt: "2030-07-31T00:00:00.000Z",
    stopReason: "",
    createdBy: "owner_a",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    deepMining: createProspectDeepMiningState(depth, depth === "balanced" ? 4 : depth === "deep" ? 8 : 16)
  };
}

function baseStore(m: ProspectSuperSearchMission) {
  const root = candidate("root");
  const child = candidate("child");
  return {
    prospectSuperSearchMissions: [m],
    websiteOpportunities: [root, child],
    prospectCandidateProcessingStates: [],
    prospectVerificationReports: [],
    prospectIcpAssessmentSnapshots: [],
    prospectContactabilityDecisions: [],
    companyVerificationSnapshots: []
  } as any;
}

function run() {
  assert.equal(
    probableOfficialWebsite("https://www.example.com/products/industrial-pumps?ref=search"),
    "https://www.example.com"
  );
  assert.equal(
    webDiscoveryWebsite("web", "https://www.example.com/products/industrial-pumps"),
    "https://www.example.com"
  );
  assert.equal(webDiscoveryWebsite("company", "https://registry.example/record/1"), "");
  const providerQueries = buildProspectProviderResolvedQueries({
    resolvedQuery: query,
    providerIds: ["web_search", "google_places", "procurement_tenders", "companies_house", "ai_search"],
    providerKinds: {
      web_search: "web",
      google_places: "maps",
      procurement_tenders: "procurement",
      companies_house: "registry",
      ai_search: "ai"
    },
    focusCompany: "Root Pumps"
  });
  assert.notDeepEqual(providerQueries.web_search, providerQueries.google_places);
  assert.match(providerQueries.google_places.purchaseScenarioTerms.join(" "), /distributor/);
  assert.deepEqual(providerQueries.companies_house.customerTypes, []);
  assert.match(providerQueries.procurement_tenders.purchaseScenarioTerms.join(" "), /tender/);

  const plan = planProspectSearchRound({
    baseQuery: query,
    missionId: "pssm_test",
    roundNo: 1,
    maxRounds: 4,
    depth: "balanced",
    providerIds: ["web_search", "google_places"],
    providerKinds: { web_search: "web", google_places: "maps" }
  });
  assert.ok(plan.providerResolvedQueries.google_places);
  assert.notEqual(plan.queryCells[0]?.queryText, plan.queryCells[1]?.queryText);
  validateProspectSearchQueryPlan({
    metadata: plan.metadata,
    resolvedQuery: plan.resolvedQuery,
    providerResolvedQueries: plan.providerResolvedQueries
  });
  assert.throws(() => validateProspectSearchQueryPlan({
    metadata: plan.metadata,
    resolvedQuery: plan.resolvedQuery,
    providerResolvedQueries: {
      ...plan.providerResolvedQueries,
      web_search: { ...plan.providerResolvedQueries.web_search!, positiveKeywords: ["tampered"] }
    }
  }), /完整性校验失败/u);

  const depthLimit = createProspectDeepMiningState("balanced", 4);
  depthLimit.tasks.push({
    id: "depth-limit",
    rootCandidateId: "root",
    candidateId: "child",
    nodeId: "node-child",
    parentNodeId: "node-root",
    depth: 1,
    status: "queued",
    runId: "",
    roundNo: 0,
    websiteProbeAttemptId: "",
    queryText: "",
    newNodeCount: 0,
    evidenceCount: 0,
    duplicateCount: 0,
    stopReason: "",
    createdAt: "2026-07-31T00:00:00.000Z",
    startedAt: "",
    completedAt: ""
  });
  assert.equal(selectNextDeepMiningTask(depthLimit), undefined);

  const m = mission("deep");
  const store = baseStore(m);
  assert.equal(synchronizeDeepMiningCandidates(store, m, ["root", "child", "missing"]), 2);
  assert.equal(m.deepMining?.summary.rootCandidateCount, 2);
  const task = selectNextDeepMiningTask(m.deepMining!);
  assert.ok(task);
  const deepPlan = planProspectDeepMiningRound({
    mission: m,
    task: task!,
    candidate: store.websiteOpportunities[0],
    baseQuery: query,
    providerIds: ["web_search"],
    providerKinds: { web_search: "web" }
  });
  assert.equal(deepPlan.metadata.theme, "deep_candidate");
  assert.match(deepPlan.queryCells[0]!.queryText, /root pumps/);

  m.currentRunId = "pr_deep";
  task!.status = "searching";
  task!.runId = "pr_deep";
  m.deepMining!.activeTaskId = task!.id;
  store.prospectCandidateProcessingStates.push({
    hitId: "hit_child",
    teamId: "team_a",
    ownerId: "owner_a",
    runId: "pr_deep",
    ledgerId: "ledger",
    status: "completed",
    failureCode: "",
    candidateId: "child",
    processedAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z"
  });
  const settled = settleDeepMiningRound(store, m, {
    id: "round",
    missionId: m.id,
    teamId: m.teamId,
    ownerId: m.ownerId,
    roundNo: 2,
    runId: "pr_deep",
    roundKind: "deep_mining",
    queryPlanSnapshot: query,
    rawCount: 1,
    uniqueCount: 1,
    candidateCount: 1,
    duplicateCount: 0,
    filteredCount: 0,
    pendingCount: 0,
    duplicateRate: 0,
    yieldRate: 1,
    cost: 0,
    decision: "pending",
    decisionReason: "",
    createdAt: "2026-07-31T00:00:00.000Z",
    completedAt: "2026-07-31T00:00:01.000Z"
  });
  assert.equal(settled.newNodes, 1);
  assert.equal(settled.relations, 1);
  assert.equal(m.deepMining?.summary.evidenceCount, 1);
  assert.equal(m.deepMining?.edges[0]?.relationType, "brand_distributor");
  assert.equal(m.deepMining?.tasks.filter((item) => item.rootCandidateId === "root" && item.candidateId === "child").length, 1);
  assert.equal(selectNextDeepMiningTask(m.deepMining!)?.depth, 1, "new relationship nodes should be recursively mined before untouched roots");

  const before = m.deepMining?.summary.evidenceCount;
  task!.status = "searching";
  task!.runId = "pr_deep_2";
  m.deepMining!.activeTaskId = task!.id;
  const second = settleDeepMiningRound(store, m, {
    id: "round-2",
    missionId: m.id,
    teamId: m.teamId,
    ownerId: m.ownerId,
    roundNo: 3,
    runId: "pr_deep_2",
    roundKind: "deep_mining",
    queryPlanSnapshot: query,
    rawCount: 1,
    uniqueCount: 1,
    candidateCount: 1,
    duplicateCount: 0,
    filteredCount: 0,
    pendingCount: 0,
    duplicateRate: 0,
    yieldRate: 1,
    cost: 0,
    decision: "pending",
    decisionReason: "",
    createdAt: "2026-07-31T00:00:00.000Z",
    completedAt: "2026-07-31T00:00:01.000Z"
  });
  assert.equal(second.evidence, 0);
  assert.equal(m.deepMining?.summary.evidenceCount, before);

  const isolated = candidate("team-b-child", "team_b");
  store.websiteOpportunities.push(isolated);
  assert.equal(synchronizeDeepMiningCandidates(store, m, [isolated.id]), 0);
  assert.equal(m.deepMining?.nodes.some((node) => node.candidateId === isolated.id), false);

  const noSource = candidate("no-source", "team_a", 90, false);
  store.websiteOpportunities.push(noSource);
  const beforeNodes = m.deepMining?.nodes.length;
  const taskNoSource = {
    ...task!,
    id: "pdmt_no-source",
    candidateId: "root",
    nodeId: m.deepMining!.nodes.find((node) => node.candidateId === "root")!.id,
    runId: "pr_no-source",
    status: "searching" as const
  };
  m.deepMining!.tasks.push(taskNoSource);
  m.deepMining!.activeTaskId = taskNoSource.id;
  store.prospectCandidateProcessingStates.push({
    hitId: "hit_no_source",
    teamId: "team_a",
    ownerId: "owner_a",
    runId: "pr_no-source",
    ledgerId: "ledger",
    status: "completed",
    failureCode: "",
    candidateId: "no-source",
    processedAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z"
  });
  const rejected = settleDeepMiningRound(store, m, {
    id: "round-no-source",
    missionId: m.id,
    teamId: m.teamId,
    ownerId: m.ownerId,
    roundNo: 4,
    runId: "pr_no-source",
    roundKind: "deep_mining",
    queryPlanSnapshot: query,
    rawCount: 1,
    uniqueCount: 1,
    candidateCount: 1,
    duplicateCount: 0,
    filteredCount: 0,
    pendingCount: 0,
    duplicateRate: 0,
    yieldRate: 1,
    cost: 0,
    decision: "pending",
    decisionReason: "",
    createdAt: "2026-07-31T00:00:00.000Z",
    completedAt: "2026-07-31T00:00:01.000Z"
  });
  assert.equal(rejected.newNodes, 0);
  assert.equal(m.deepMining?.nodes.length, beforeNodes);

  const restored = JSON.parse(JSON.stringify(m)) as ProspectSuperSearchMission;
  assert.equal(restored.deepMining?.summary.evidenceCount, m.deepMining?.summary.evidenceCount);
  assert.equal(restored.deepMining?.nodes.length, m.deepMining?.nodes.length);

  const completedMission = mission("balanced");
  completedMission.candidateCount = completedMission.targetCandidateCount;
  completedMission.reviewReadyCount = 0;
  completedMission.deepMining!.status = "completed";
  const completionStore = {
    prospectSuperSearchRounds: [],
    prospectCandidateProcessingStates: [],
    websiteOpportunities: []
  } as any;
  assert.match(
    prospectSuperSearchConvergenceReason(completionStore, completedMission),
    /目标候选数量/u
  );

  console.log("prospect-deep-mining-test: ok");
}

run();
