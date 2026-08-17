import assert from "node:assert/strict";
import { publicUser } from "./auth.js";
import {
  activateProspectCampaign,
  createProspectCampaign,
  prospectCampaignEtag
} from "./prospect-campaigns.js";
import {
  approveProspectStrategy,
  prospectStrategyEtag,
  updateProspectStrategy
} from "./prospect-strategies.js";
import {
  createProspectRun,
  prospectRunEtag,
  transitionProspectRun
} from "./prospect-runs.js";
import {
  enhanceProspectSearchRoundPlan,
  planProspectSearchRound,
  validateProspectSearchQueryPlan
} from "./prospect-search-planner.js";
import {
  createProspectSuperSearch,
  listProspectSuperSearches,
  prospectSuperSearchConvergenceReason,
  prospectSuperSearchEtag,
  prospectSuperSearchPreview,
  ProspectSuperSearchError,
  ProspectSuperSearchRunner,
  refreshProspectSuperSearchMissionResults,
  superSearchDetail,
  transitionProspectSuperSearch
} from "./prospect-super-search.js";
import { getStore } from "./store.js";
import type {
  ProspectExecutionAttempt,
  ProspectExecutionLease,
  Role,
  User
} from "./types.js";

function testUser(id: string, teamId: string, role: Role): User {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    password: "test-only",
    role,
    teamId,
    avatar: id.slice(0, 2).toUpperCase(),
    status: "active",
    authVersion: 1
  };
}

const store = getStore();
const original = {
  users: [...store.users],
  campaigns: [...store.prospectCampaigns],
  versions: [...store.prospectCampaignVersions],
  campaignEvents: [...store.prospectCampaignEvents],
  strategies: [...store.prospectStrategies],
  strategyEvents: [...store.prospectStrategyEvents],
  runs: [...store.prospectSearchRuns],
  shards: [...store.prospectRunShards],
  runEvents: [...store.prospectRunEvents],
  parentBindings: [...store.prospectRunQueueParentBindings],
  childBindings: [...store.prospectRunQueueChildBindings],
  jobs: [...store.agentJobs],
  aliases: [...store.agentJobIdempotencyAliases],
  missions: [...store.prospectSuperSearchMissions],
  rounds: [...store.prospectSuperSearchRounds],
  events: [...store.prospectSuperSearchEvents],
  executionAttempts: [...store.prospectExecutionAttempts],
  executionLeases: [...store.prospectExecutionLeases],
  persist: store.persist,
  persistMutation: store.persistMutation,
  persistProspectExecutionMutation: store.persistProspectExecutionMutation
};

const owner = testUser("super_search_owner", "super_search_team", "sales");
const peer = testUser("super_search_peer", "super_search_team", "sales");
const manager = testUser("super_search_manager", "super_search_team", "manager");
const outsider = testUser("super_search_outsider", "other_team", "manager");
store.users.push(owner, peer, manager, outsider);
store.prospectCampaigns.splice(0);
store.prospectCampaignVersions.splice(0);
store.prospectCampaignEvents.splice(0);
store.prospectStrategies.splice(0);
store.prospectStrategyEvents.splice(0);
store.prospectSearchRuns.splice(0);
store.prospectRunShards.splice(0);
store.prospectRunEvents.splice(0);
store.prospectRunQueueParentBindings.splice(0);
store.prospectRunQueueChildBindings.splice(0);
store.agentJobs.splice(0);
store.agentJobIdempotencyAliases.splice(0);
store.prospectSuperSearchMissions.splice(0);
store.prospectSuperSearchRounds.splice(0);
store.prospectSuperSearchEvents.splice(0);
store.prospectExecutionAttempts.splice(0);
store.persist = async () => undefined;
store.persistMutation = undefined;
store.persistProspectExecutionMutation = undefined;

try {
  const preview = prospectSuperSearchPreview({
    products: ["industrial pump"],
    markets: ["Germany", "France"],
    customerTypes: ["Distributor"],
    industries: ["water treatment"],
    providerIds: ["gleif", "wikidata"],
    depth: "deep",
    targetCandidateCount: 300,
    maxDurationMinutes: 480,
    costLimit: 0,
    currency: "",
    webSearchMode: "off",
    mapSearchMode: "off",
    aiDiscoveryMode: "off"
  });
  assert.equal(preview.maxRounds, 8);
  assert.equal(preview.providerCount, 2);
  assert.ok(preview.maximumCells > preview.cellsPerRound);
  const webPreview = prospectSuperSearchPreview({
    products: ["industrial pump"],
    markets: ["Germany"],
    customerTypes: ["Distributor"],
    industries: [],
    providerIds: ["gleif", "serper"],
    depth: "balanced",
    targetCandidateCount: 20,
    maxDurationMinutes: 60,
    costLimit: 0,
    currency: "",
    webSearchMode: "api",
    mapSearchMode: "off",
    aiDiscoveryMode: "off"
  });
  assert.equal(webPreview.webSearchMode, "api");
  assert.equal(webPreview.webProviderCount, 1);
  assert.deepEqual(webPreview.webProviderIds, ["serper"]);
  const mapPreview = prospectSuperSearchPreview({
    products: ["industrial pump"],
    markets: ["Germany"],
    customerTypes: ["Distributor"],
    industries: ["water treatment"],
    providerIds: ["gleif", "google_places"],
    depth: "balanced",
    targetCandidateCount: 20,
    maxDurationMinutes: 60,
    costLimit: 50,
    currency: "USD",
    webSearchMode: "off",
    mapSearchMode: "google_places",
    aiDiscoveryMode: "off"
  });
  assert.equal(mapPreview.mapSearchMode, "google_places");
  assert.deepEqual(mapPreview.mapProviderIds, ["google_places"]);
  const aiDiscoveryPreview = prospectSuperSearchPreview({
    products: ["industrial pump"],
    markets: ["Germany"],
    customerTypes: ["Distributor"],
    industries: ["water treatment"],
    providerIds: ["gleif", "ai_search"],
    depth: "balanced",
    targetCandidateCount: 20,
    maxDurationMinutes: 60,
    costLimit: 0,
    currency: "",
    webSearchMode: "off",
    mapSearchMode: "off",
    aiDiscoveryMode: "model"
  });
  assert.equal(aiDiscoveryPreview.aiDiscoveryMode, "model");
  assert.deepEqual(aiDiscoveryPreview.aiDiscoveryProviderIds, ["ai_search"]);

  const plannerBase = {
    positiveKeywords: ["industrial pump"],
    synonyms: ["process pump"],
    industryTerms: ["water treatment"],
    purchaseScenarioTerms: [],
    countries: ["germany", "france", "spain", "italy"],
    languages: [],
    customerTypes: [],
    exclusionKeywords: [],
    exclusionDomains: [],
    timeWindow: { mode: "all" as const, from: "", to: "" }
  };
  const plannerInput = {
    baseQuery: plannerBase,
    missionId: "pssm_00000000-0000-4000-8000-000000000001",
    maxRounds: 8,
    depth: "deep" as const,
    providerIds: ["gleif", "wikidata"]
  };
  const plannedRounds = [1, 2, 3, 4].map((roundNo) =>
    planProspectSearchRound({ ...plannerInput, roundNo })
  );
  assert.equal(new Set(plannedRounds.map((item) => item.metadata.fingerprint)).size, 4);
  assert.notDeepEqual(plannedRounds[0]?.resolvedQuery, plannedRounds[1]?.resolvedQuery);
  assert.ok(plannedRounds[1]?.resolvedQuery.purchaseScenarioTerms.some((term) =>
    ["handler", "vertriebspartner", "distributeur", "revendeur"].includes(term)
  ));
  assert.ok(plannedRounds[2]?.resolvedQuery.purchaseScenarioTerms.some((term) =>
    ["rfq", "tender", "procurement", "ausschreibung", "appel d'offres", "licitacion", "solicitud de cotizacion"].includes(term)
  ));
  assert.deepEqual(
    planProspectSearchRound({ ...plannerInput, roundNo: 2 }).resolvedQuery.countries,
    plannedRounds[1]?.resolvedQuery.countries
  );
  assert.ok(plannedRounds.every((item) => item.queryCells.length <= 48));
  assert.ok(plannedRounds.every((item) =>
    item.resolvedQuery.countries.length === 1
    && item.resolvedQuery.languages.length === 1
    && item.resolvedQuery.customerTypes.length === 1
    && item.resolvedQuery.purchaseScenarioTerms.length === 1
    && item.queryCells.length === plannerInput.providerIds.length
    && item.queryCells.every((cell) =>
      cell.market === item.resolvedQuery.countries[0]
      && cell.language === item.resolvedQuery.languages[0]
      && cell.customerType === item.resolvedQuery.customerTypes[0]
    )
  ));
  assert.equal(
    new Set(plannedRounds.flatMap((item) =>
      item.queryCells.map((cell) => cell.fingerprint)
    )).size,
    plannedRounds.length * plannerInput.providerIds.length
  );
  assert.ok(plannedRounds.every((item) => ![
    ...item.resolvedQuery.customerTypes,
    ...item.resolvedQuery.purchaseScenarioTerms
  ].includes("all")));
  validateProspectSearchQueryPlan({
    metadata: plannedRounds[0]!.metadata,
    resolvedQuery: plannedRounds[0]!.resolvedQuery
  });
  assert.throws(() => validateProspectSearchQueryPlan({
    metadata: plannedRounds[0]!.metadata,
    resolvedQuery: {
      ...plannedRounds[0]!.resolvedQuery,
      positiveKeywords: ["tampered"]
    }
  }), /完整性校验失败/u);
  const aiEnhancedPlan = enhanceProspectSearchRoundPlan(plannedRounds[1]!, {
    synonyms: ["industrial process pump"],
    purchaseScenarioTerms: ["regional pump partner"],
    customerTypes: ["technical distributor"],
    languages: ["de"]
  });
  assert.equal(aiEnhancedPlan.metadata.planningMode, "ai_enhanced");
  assert.notEqual(aiEnhancedPlan.metadata.fingerprint, plannedRounds[1]?.metadata.fingerprint);
  assert.ok(aiEnhancedPlan.resolvedQuery.synonyms.includes("industrial process pump"));
  assert.equal(aiEnhancedPlan.resolvedQuery.languages.length, 1);
  assert.equal(aiEnhancedPlan.resolvedQuery.customerTypes.length, 1);
  assert.equal(aiEnhancedPlan.resolvedQuery.purchaseScenarioTerms.length, 1);
  validateProspectSearchQueryPlan({
    metadata: aiEnhancedPlan.metadata,
    resolvedQuery: aiEnhancedPlan.resolvedQuery
  });

  const created = await createProspectCampaign({
    store,
    user: publicUser(owner),
    body: {
      name: "超级搜索闭环测试",
      snapshot: {
        goal: "持续开发德国工业泵分销商",
        products: ["industrial pump"],
        markets: ["Germany"],
        customerTypes: ["Distributor"],
        applicationScenarios: ["water treatment"],
        icpRules: ["B2B distributor"],
        exclusionRules: ["consumer only"],
        sourceProviderIds: ["gleif"]
      }
    },
    requestId: "super-search-campaign-create"
  });
  const strategy = store.prospectStrategies.find((item) => item.campaignId === created.campaign.id)!;
  await updateProspectStrategy({
    store,
    user: publicUser(owner),
    strategyId: strategy.id,
    ifMatch: prospectStrategyEtag(strategy),
    body: {
      query: {
        synonyms: ["Industriepumpe"],
        industryTerms: ["Wasseraufbereitung"],
        purchaseScenarioTerms: ["Lieferant", "Ausschreibung"]
      },
      providerPlan: [{
        providerId: "gleif",
        priority: 1,
        pageLimit: 1,
        resultLimit: 20,
        budgetLimit: null,
        currency: ""
      }]
    },
    requestId: "super-search-strategy-update"
  });
  await approveProspectStrategy({
    store,
    user: publicUser(owner),
    strategyId: strategy.id,
    ifMatch: prospectStrategyEtag(strategy),
    requestId: "super-search-strategy-approve"
  });
  await activateProspectCampaign({
    store,
    user: publicUser(owner),
    campaignId: created.campaign.id,
    ifMatch: prospectCampaignEtag(created.campaign),
    requestId: "super-search-campaign-activate"
  });

  await assert.rejects(
    () => createProspectSuperSearch({
      store,
      user: publicUser(owner),
      body: {
        strategyId: strategy.id,
        targetCandidateCount: 20,
        maxDurationMinutes: 60,
        depth: "balanced",
        costLimit: 0,
        currency: "",
        aiMode: "off",
        webSearchMode: "api",
        mapSearchMode: "off",
        aiDiscoveryMode: "off"
      }
    }),
    (error: unknown) => error instanceof ProspectSuperSearchError
      && error.code === "SUPER_SEARCH_WEB_PROVIDER_REQUIRED"
  );
  strategy.providerPlan = [{
    providerId: "serper",
    priority: 1,
    pageLimit: 1,
    resultLimit: 20,
    budgetLimit: null,
    currency: ""
  }];
  await assert.rejects(
    () => createProspectSuperSearch({
      store,
      user: publicUser(owner),
      body: {
        strategyId: strategy.id,
        targetCandidateCount: 20,
        maxDurationMinutes: 60,
        depth: "balanced",
        costLimit: 0,
        currency: "",
        aiMode: "off",
        webSearchMode: "off",
        mapSearchMode: "off",
        aiDiscoveryMode: "off"
      }
    }),
    (error: unknown) => error instanceof ProspectSuperSearchError
      && error.code === "SUPER_SEARCH_WEB_PROVIDER_NOT_ALLOWED"
  );
  strategy.providerPlan = [{
    providerId: "gleif",
    priority: 1,
    pageLimit: 1,
    resultLimit: 20,
    budgetLimit: null,
    currency: ""
  }];
  await assert.rejects(
    () => createProspectSuperSearch({
      store,
      user: publicUser(owner),
      body: {
        strategyId: strategy.id,
        targetCandidateCount: 20,
        maxDurationMinutes: 60,
        depth: "balanced",
        costLimit: 0,
        currency: "",
        aiMode: "off",
        webSearchMode: "off",
        mapSearchMode: "google_places",
        aiDiscoveryMode: "off"
      }
    }),
    (error: unknown) => error instanceof ProspectSuperSearchError
      && error.code === "SUPER_SEARCH_MAP_PROVIDER_REQUIRED"
  );
  strategy.providerPlan = [{
    providerId: "google_places",
    priority: 1,
    pageLimit: 1,
    resultLimit: 20,
    budgetLimit: 20,
    currency: "USD"
  }];
  await assert.rejects(
    () => createProspectSuperSearch({
      store,
      user: publicUser(owner),
      body: {
        strategyId: strategy.id,
        targetCandidateCount: 20,
        maxDurationMinutes: 60,
        depth: "balanced",
        costLimit: 20,
        currency: "USD",
        aiMode: "off",
        webSearchMode: "off",
        mapSearchMode: "off",
        aiDiscoveryMode: "off"
      }
    }),
    (error: unknown) => error instanceof ProspectSuperSearchError
      && error.code === "SUPER_SEARCH_MAP_PROVIDER_NOT_ALLOWED"
  );
  strategy.providerPlan = [{
    providerId: "gleif",
    priority: 1,
    pageLimit: 1,
    resultLimit: 20,
    budgetLimit: null,
    currency: ""
  }];
  await assert.rejects(
    () => createProspectSuperSearch({
      store,
      user: publicUser(owner),
      body: {
        strategyId: strategy.id,
        targetCandidateCount: 20,
        maxDurationMinutes: 60,
        depth: "balanced",
        costLimit: 0,
        currency: "",
        aiMode: "off",
        webSearchMode: "off",
        mapSearchMode: "off",
        aiDiscoveryMode: "model"
      }
    }),
    (error: unknown) => error instanceof ProspectSuperSearchError
      && error.code === "SUPER_SEARCH_AI_DISCOVERY_PROVIDER_REQUIRED"
  );
  strategy.providerPlan = [{
    providerId: "ai_search",
    priority: 1,
    pageLimit: 1,
    resultLimit: 20,
    budgetLimit: null,
    currency: ""
  }];
  await assert.rejects(
    () => createProspectSuperSearch({
      store,
      user: publicUser(owner),
      body: {
        strategyId: strategy.id,
        targetCandidateCount: 20,
        maxDurationMinutes: 60,
        depth: "balanced",
        costLimit: 0,
        currency: "",
        aiMode: "off",
        webSearchMode: "off",
        mapSearchMode: "off",
        aiDiscoveryMode: "off"
      }
    }),
    (error: unknown) => error instanceof ProspectSuperSearchError
      && error.code === "SUPER_SEARCH_AI_DISCOVERY_PROVIDER_NOT_ALLOWED"
  );
  strategy.providerPlan = [{
    providerId: "gleif",
    priority: 1,
    pageLimit: 1,
    resultLimit: 20,
    budgetLimit: null,
    currency: ""
  }];

  const missionResult = await createProspectSuperSearch({
    store,
    user: publicUser(owner),
    body: {
      strategyId: strategy.id,
      targetCandidateCount: 20,
      maxDurationMinutes: 60,
      depth: "balanced",
      costLimit: 0,
      currency: "",
      aiMode: "off",
      webSearchMode: "off",
      mapSearchMode: "off",
      aiDiscoveryMode: "off"
    }
  });
  const mission = store.prospectSuperSearchMissions.find((item) => item.id === missionResult.mission.id)!;
  assert.equal(mission.status, "running");
  assert.equal(mission.currentRound, 1);
  assert.equal(missionResult.rounds.length, 1);
  assert.equal(missionResult.mission.webSearchMode, "off");
  assert.deepEqual(missionResult.mission.webProviderIds, []);
  assert.equal(missionResult.mission.mapSearchMode, "off");
  assert.equal(missionResult.mission.aiDiscoveryMode, "off");
  assert.deepEqual(missionResult.rounds[0]?.queryPlanSnapshot.countries, ["germany"]);
  assert.equal(missionResult.rounds[0]?.queryPlanSnapshot.customerTypes.length, 1);
  assert.equal(missionResult.rounds[0]?.queryPlanSnapshot.languages.length, 1);
  assert.equal(missionResult.rounds[0]?.queryTheme, "baseline");
  assert.equal(missionResult.rounds[0]?.queryPlanFingerprint?.length, 64);
  assert.equal(
    store.prospectSearchRuns.find((item) => item.id === mission.currentRunId)?.executionSnapshot.queryPlan?.missionId,
    mission.id
  );
  assert.equal(listProspectSuperSearches(store, publicUser(peer)).total, 0);
  assert.equal(listProspectSuperSearches(store, publicUser(manager)).total, 1);
  assert.equal(listProspectSuperSearches(store, publicUser(outsider)).total, 0);

  const paused = await transitionProspectSuperSearch({
    store,
    user: publicUser(owner),
    missionId: mission.id,
    ifMatch: prospectSuperSearchEtag(mission),
    action: "pause"
  });
  assert.equal(paused.mission.status, "paused");
  const resumed = await transitionProspectSuperSearch({
    store,
    user: publicUser(owner),
    missionId: mission.id,
    ifMatch: prospectSuperSearchEtag(paused.mission),
    action: "resume"
  });
  assert.equal(resumed.mission.status, "running");

  const runner = new ProspectSuperSearchRunner(store);
  for (let expectedRound = 2; expectedRound <= 4; expectedRound += 1) {
    const current = store.prospectSearchRuns.find((item) => item.id === mission.currentRunId)!;
    current.status = expectedRound === 2 ? "partial_success" : "succeeded_empty";
    current.revision += 1;
    current.updatedAt = new Date().toISOString();
    await runner.tick();
    if (expectedRound <= 4) assert.equal(mission.currentRound, expectedRound);
  }
  const finalRun = store.prospectSearchRuns.find((item) => item.id === mission.currentRunId)!;
  finalRun.status = "succeeded_empty";
  finalRun.revision += 1;
  finalRun.updatedAt = new Date().toISOString();
  await runner.tick();
  const completed = superSearchDetail(store, publicUser(owner), mission.id);
  assert.equal(completed.mission.status, "partial_success");
  assert.equal(completed.rounds.length, 4);
  assert.equal(completed.mission.stopReason, "已达到最大搜索轮次");
  assert.ok(completed.events.some((item) => item.type === "completed"));
  assert.deepEqual(
    completed.rounds.map((item) => item.queryTheme),
    ["baseline", "local_channel", "procurement", "project_engineering"]
  );
  assert.equal(new Set(completed.rounds.map((item) => item.queryPlanFingerprint)).size, 4);
  assert.ok(completed.rounds.every((item) => item.queryCells?.length === 1));
  assert.ok(completed.rounds.every((item) =>
    item.queryCells?.every((cell) => cell.status === "succeeded_empty" && cell.rawCount === 0)
  ));
  const storedCompletedMission = store.prospectSuperSearchMissions.find((item) => item.id === completed.mission.id)!;
  const revisionBeforeRefresh = storedCompletedMission.revision;
  refreshProspectSuperSearchMissionResults(store, completed.mission.id);
  assert.equal(
    storedCompletedMission.revision,
    revisionBeforeRefresh,
    "refresh without metric changes must not create a new mission revision"
  );

  const costRound = store.prospectSuperSearchRounds.find((item) =>
    item.id === completed.rounds[0]!.id
  )!;
  const costShard = store.prospectRunShards.find((item) =>
    item.runId === costRound.runId
  )!;
  const costAttempt = (overrides: Partial<ProspectExecutionAttempt>): ProspectExecutionAttempt => ({
    id: `pea_${Math.random().toString(16).slice(2)}`,
    teamId: mission.teamId,
    ownerId: mission.ownerId,
    runId: costRound.runId,
    shardId: costShard.id,
    jobId: "job-super-search-cost",
    leaseId: "lease-super-search-cost",
    providerCode: costShard.providerCode,
    checkpointNo: 1,
    checkpointCallNo: 1,
    providerAttemptNo: 1,
    status: "succeeded",
    requestHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    errorCode: "",
    errorMessage: "",
    retryable: false,
    retryAfterAt: "",
    usageJson: "{}",
    costKind: "actual",
    costAmount: 0.25,
    currency: "USD",
    startedAt: costRound.createdAt,
    finishedAt: costRound.completedAt,
    createdAt: costRound.createdAt,
    version: 1,
    ...overrides
  });
  store.prospectExecutionAttempts.push(costAttempt({}));
  storedCompletedMission.currency = "USD";
  const revisionBeforeCostRefresh = storedCompletedMission.revision;
  refreshProspectSuperSearchMissionResults(store, completed.mission.id);
  assert.equal(costRound.cost, 0.25);
  assert.equal(costRound.costIntegrityStatus, "complete");
  assert.equal(costRound.queryCells?.[0]?.costAmount, 0.25);
  assert.equal(storedCompletedMission.totalCost, 0.25);
  assert.equal(storedCompletedMission.revision, revisionBeforeCostRefresh + 1);
  storedCompletedMission.costLimit = 0.2;
  assert.equal(
    prospectSuperSearchConvergenceReason(store, storedCompletedMission),
    "已达到费用上限"
  );
  store.prospectExecutionAttempts.push(costAttempt({
    id: "pea-super-search-unknown-cost",
    checkpointCallNo: 2,
    providerAttemptNo: 2,
    costKind: "unknown",
    costAmount: null,
    currency: ""
  }));
  storedCompletedMission.costLimit = 10;
  refreshProspectSuperSearchMissionResults(store, completed.mission.id);
  assert.equal(costRound.costUnknownCount, 1);
  assert.equal(
    prospectSuperSearchConvergenceReason(store, storedCompletedMission),
    "费用回执不完整，已停止后续调用"
  );

  const standard = await createProspectRun({
    store,
    user: publicUser(owner),
    strategyId: strategy.id,
    ifMatch: prospectStrategyEtag(strategy),
    idempotencyKey: "standard-search-without-ai-0001",
    body: { reason: "验证标准搜索不依赖 AI" },
    requestId: "standard-search-without-ai"
  });
  const standardRun = store.prospectSearchRuns.find((item) => item.id === standard.run.id)!;
  assert.equal(standardRun.executionSnapshot.queryPlan, undefined);
  assert.deepEqual(standardRun.executionSnapshot.campaign.snapshot.sourceProviderIds, ["gleif"]);
  await transitionProspectRun({
    store,
    user: publicUser(owner),
    runId: standardRun.id,
    ifMatch: prospectRunEtag(standardRun),
    action: "cancel",
    body: { reason: "测试完成" },
    requestId: "standard-search-without-ai-cancel"
  });

  const stalledResult = await createProspectSuperSearch({
    store,
    user: publicUser(owner),
    body: {
      strategyId: strategy.id,
      targetCandidateCount: 20,
      maxDurationMinutes: 60,
      depth: "balanced",
      costLimit: 0,
      currency: "",
      aiMode: "off",
      webSearchMode: "off",
      mapSearchMode: "off",
      aiDiscoveryMode: "off"
    }
  });
  const stalledMission = store.prospectSuperSearchMissions.find((item) =>
    item.id === stalledResult.mission.id
  )!;
  const stalledRun = store.prospectSearchRuns.find((item) =>
    item.id === stalledMission.currentRunId
  )!;
  const oldProgressAt = new Date(Date.now() - 3 * 60_000).toISOString();
  stalledMission.deadlineAt = new Date(Date.now() + 60 * 60_000).toISOString();
  stalledRun.updatedAt = oldProgressAt;
  const stalledShard = store.prospectRunShards.find((item) =>
    item.runId === stalledRun.id
  )!;
  stalledShard.updatedAt = oldProgressAt;
  const stalledJobId = store.prospectRunQueueChildBindings.find((item) =>
    item.runId === stalledRun.id && item.shardId === stalledShard.id
  )!.jobId;
  const heartbeatOnlyLease: ProspectExecutionLease = {
    id: "lease-super-search-heartbeat-only",
    teamId: stalledRun.teamId,
    ownerId: stalledRun.ownerId,
    runId: stalledRun.id,
    shardId: stalledShard.id,
    jobId: stalledJobId,
    kernelEpoch: 1,
    runEpoch: stalledRun.executionEpoch,
    fenceToken: 1,
    claimTokenHmac: "a".repeat(64),
    workerId: "heartbeat-only-test",
    status: "active",
    claimedAt: oldProgressAt,
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    requestStartedAt: oldProgressAt,
    releasedAt: "",
    releaseReason: "",
    version: 2
  };
  store.prospectExecutionLeases.push(heartbeatOnlyLease);
  const originalStallMs = process.env.PROSPECT_SUPER_SEARCH_STALL_MS;
  process.env.PROSPECT_SUPER_SEARCH_STALL_MS = "120000";
  let cancelledRunId = "";
  const stalledRunner = new ProspectSuperSearchRunner(store, {
    onRunStalled: async (runId) => {
      cancelledRunId = runId;
      stalledRun.status = "cancelled";
      stalledRun.updatedAt = new Date().toISOString();
    }
  });
  await stalledRunner.tick();
  if (originalStallMs === undefined) {
    delete process.env.PROSPECT_SUPER_SEARCH_STALL_MS;
  } else {
    process.env.PROSPECT_SUPER_SEARCH_STALL_MS = originalStallMs;
  }
  assert.equal(cancelledRunId, stalledRun.id);
  assert.equal(stalledMission.status, "failed");
  assert.match(stalledMission.stopReason, /长时间无进展/u);

  completed.mission.currentRound = 2;
  completed.mission.maxRounds = 8;
  completed.mission.candidateCount = 0;
  completed.mission.deadlineAt = new Date(Date.now() + 60_000).toISOString();
  store.prospectSuperSearchRounds
    .filter((item) => item.missionId === completed.mission.id)
    .slice(-2)
    .forEach((item) => {
    item.yieldRate = 0.01;
    item.duplicateRate = 0.95;
  });
  assert.equal(
    prospectSuperSearchConvergenceReason(store, completed.mission),
    "连续两轮新增率过低且重复率过高，搜索已收敛"
  );

  console.log(JSON.stringify({
    ok: true,
    previewCells: preview.maximumCells,
    missionStatus: completed.mission.status,
    rounds: completed.rounds.length,
    ownerIsolation: true,
    pauseResume: true,
    maxRoundConvergence: true,
    lowYieldConvergence: true,
    roundPlansUnique: true,
    standardSearchWithoutAi: true,
    stalledRunCancelled: true,
    singleSourceFailureDegraded: true
  }, null, 2));
} finally {
  store.users.splice(0, store.users.length, ...original.users);
  store.prospectCampaigns.splice(0, store.prospectCampaigns.length, ...original.campaigns);
  store.prospectCampaignVersions.splice(0, store.prospectCampaignVersions.length, ...original.versions);
  store.prospectCampaignEvents.splice(0, store.prospectCampaignEvents.length, ...original.campaignEvents);
  store.prospectStrategies.splice(0, store.prospectStrategies.length, ...original.strategies);
  store.prospectStrategyEvents.splice(0, store.prospectStrategyEvents.length, ...original.strategyEvents);
  store.prospectSearchRuns.splice(0, store.prospectSearchRuns.length, ...original.runs);
  store.prospectRunShards.splice(0, store.prospectRunShards.length, ...original.shards);
  store.prospectRunEvents.splice(0, store.prospectRunEvents.length, ...original.runEvents);
  store.prospectRunQueueParentBindings.splice(0, store.prospectRunQueueParentBindings.length, ...original.parentBindings);
  store.prospectRunQueueChildBindings.splice(0, store.prospectRunQueueChildBindings.length, ...original.childBindings);
  store.agentJobs.splice(0, store.agentJobs.length, ...original.jobs);
  store.agentJobIdempotencyAliases.splice(0, store.agentJobIdempotencyAliases.length, ...original.aliases);
  store.prospectSuperSearchMissions.splice(0, store.prospectSuperSearchMissions.length, ...original.missions);
  store.prospectSuperSearchRounds.splice(0, store.prospectSuperSearchRounds.length, ...original.rounds);
  store.prospectSuperSearchEvents.splice(0, store.prospectSuperSearchEvents.length, ...original.events);
  store.prospectExecutionAttempts.splice(0, store.prospectExecutionAttempts.length, ...original.executionAttempts);
  store.prospectExecutionLeases.splice(0, store.prospectExecutionLeases.length, ...original.executionLeases);
  store.persist = original.persist;
  store.persistMutation = original.persistMutation;
  store.persistProspectExecutionMutation = original.persistProspectExecutionMutation;
}
