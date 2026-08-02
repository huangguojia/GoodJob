import { createHash, randomUUID } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  buildProspectProviderResolvedQueries,
  PROSPECT_SEARCH_PLANNER_VERSION,
  prospectProviderQueriesFingerprint,
  prospectSearchQueryPlanFingerprint,
  type ProspectSearchRoundPlan
} from "./prospect-search-planner.js";
import { refreshProspectScorecard } from "./prospect-scorecard.js";
import { ensureProspectVerificationReport } from "./prospect-verification.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectDeepMiningEvidence,
  ProspectDeepMiningNode,
  ProspectDeepMiningRelationType,
  ProspectDeepMiningState,
  ProspectDeepMiningTask,
  ProspectResolvedQuerySnapshot,
  ProspectSuperSearchDepth,
  ProspectSuperSearchMission,
  ProspectSuperSearchRound,
  ProviderEvidenceSnapshot,
  ProviderFieldAuthorityLevel,
  WebsiteOpportunity
} from "./types.js";

const limits: Record<ProspectSuperSearchDepth, {
  maxDepth: number;
  maxRootCandidates: number;
  maxQueries: number;
  maxWebsiteProbes: number;
}> = {
  balanced: { maxDepth: 1, maxRootCandidates: 3, maxQueries: 3, maxWebsiteProbes: 2 },
  deep: { maxDepth: 2, maxRootCandidates: 10, maxQueries: 7, maxWebsiteProbes: 5 },
  extreme: { maxDepth: 3, maxRootCandidates: 20, maxQueries: 15, maxWebsiteProbes: 10 }
};

function hash(value: unknown) {
  return createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");
}

function normalized(value: string, max = 500) {
  return value.trim().replace(/\s+/gu, " ").slice(0, max);
}

function sourceUrl(evidence: ProviderEvidenceSnapshot) {
  return normalized(evidence.sourceUrl || evidence.officialWebsite || "", 1_000);
}

function authority(evidence: ProviderEvidenceSnapshot): ProviderFieldAuthorityLevel {
  const values = Object.values(evidence.fieldAuthority || {});
  if (values.includes("official")) return "official";
  if (values.includes("corroborated")) return "corroborated";
  if (values.includes("discovery")) return "discovery";
  return "assisted";
}

function nodeId(missionId: string, rootCandidateId: string, candidateId: string) {
  return `pdmn_${hash({ missionId, rootCandidateId, candidateId }).slice(0, 32)}`;
}

function taskId(missionId: string, rootCandidateId: string, candidateId: string) {
  return `pdmt_${hash({ missionId, rootCandidateId, candidateId }).slice(0, 32)}`;
}

function nodeFromCandidate(input: {
  missionId: string;
  rootCandidateId: string;
  parentNodeId: string;
  depth: number;
  candidate: WebsiteOpportunity;
  evidenceIds?: string[];
}) : ProspectDeepMiningNode {
  const scorecard = input.candidate.scorecard;
  const now = new Date().toISOString();
  return {
    id: nodeId(input.missionId, input.rootCandidateId, input.candidate.id),
    rootCandidateId: input.rootCandidateId,
    candidateId: input.candidate.id,
    parentNodeId: input.parentNodeId,
    company: input.candidate.company,
    country: input.candidate.country,
    website: input.candidate.website,
    depth: input.depth,
    evidenceIds: [...new Set(input.evidenceIds || [])],
    enterpriseVerificationScore: scorecard?.enterpriseConfidence.score || 0,
    contactReadinessScore: scorecard?.contactReadiness.score || 0,
    actionPriorityScore: scorecard?.actionPriority.score || 0,
    verificationStatus: scorecard?.enterpriseConfidence.status || "unverified",
    conflict: scorecard?.enterpriseConfidence.status === "blocked",
    createdAt: now,
    updatedAt: now
  };
}

function taskFromNode(missionId: string, node: ProspectDeepMiningNode): ProspectDeepMiningTask {
  return {
    id: taskId(missionId, node.rootCandidateId, node.candidateId),
    rootCandidateId: node.rootCandidateId,
    candidateId: node.candidateId,
    nodeId: node.id,
    parentNodeId: node.parentNodeId,
    depth: node.depth,
    status: "queued",
    runId: "",
    roundNo: 0,
    websiteProbeAttemptId: "",
    queryText: "",
    newNodeCount: 0,
    evidenceCount: 0,
    duplicateCount: 0,
    stopReason: "",
    createdAt: node.createdAt,
    startedAt: "",
    completedAt: ""
  };
}

export function createProspectDeepMiningState(
  depth: ProspectSuperSearchDepth,
  maxRounds?: number
): ProspectDeepMiningState {
  const configured = limits[depth];
  return {
    version: "prospect-deep-mining-v1",
    status: "queued",
    maxDepth: configured.maxDepth,
    maxRootCandidates: configured.maxRootCandidates,
    maxQueries: Math.min(configured.maxQueries, Math.max(1, (maxRounds || configured.maxQueries + 1) - 1)),
    maxWebsiteProbes: configured.maxWebsiteProbes,
    queriesUsed: 0,
    websiteProbesUsed: 0,
    activeTaskId: "",
    tasks: [],
    nodes: [],
    edges: [],
    evidence: [],
    summary: {
      rootCandidateCount: 0,
      researchedCandidateCount: 0,
      relationCount: 0,
      evidenceCount: 0,
      verifiedCompanyCount: 0,
      contactReadyCount: 0,
      researchReadyCount: 0,
      stoppedTaskCount: 0
    },
    stopReason: "",
    startedAt: "",
    endedAt: ""
  };
}

function refreshNodeScores(
  store: CrmStore,
  mission: ProspectSuperSearchMission,
  node: ProspectDeepMiningNode
) {
  const candidate = store.websiteOpportunities.find((item) =>
    item.id === node.candidateId
    && item.teamId === mission.teamId
    && item.ownerId === mission.ownerId
  );
  if (!candidate) return;
  try {
    ensureProspectVerificationReport(candidate);
    refreshProspectScorecard(store, candidate);
  } catch {
    // A partially hydrated worker snapshot may not contain qualification tables;
    // retain the last durable score until the next full store read.
  }
  node.enterpriseVerificationScore = candidate.scorecard?.enterpriseConfidence.score || 0;
  node.contactReadinessScore = candidate.scorecard?.contactReadiness.score || 0;
  node.actionPriorityScore = candidate.scorecard?.actionPriority.score || 0;
  node.verificationStatus = candidate.scorecard?.enterpriseConfidence.status || "unverified";
  node.conflict = node.verificationStatus === "blocked";
  node.updatedAt = new Date().toISOString();
}

export function refreshProspectDeepMiningSummary(
  store: CrmStore,
  mission: ProspectSuperSearchMission
) {
  const state = mission.deepMining;
  if (!state) return;
  state.nodes.forEach((node) => refreshNodeScores(store, mission, node));
  state.summary = {
    rootCandidateCount: new Set(state.nodes.map((item) => item.rootCandidateId)).size,
    researchedCandidateCount: state.nodes.length,
    relationCount: state.edges.length,
    evidenceCount: state.evidence.length,
    verifiedCompanyCount: state.nodes.filter((item) => item.verificationStatus === "verified").length,
    contactReadyCount: state.nodes.filter((item) => item.contactReadinessScore >= 70).length,
    researchReadyCount: state.nodes.filter((item) =>
      item.enterpriseVerificationScore >= 70
      && item.evidenceIds.length > 0
    ).length,
    stoppedTaskCount: state.tasks.filter((item) => item.status === "stopped" || item.status === "failed").length
  };
}

export function synchronizeDeepMiningCandidates(
  store: CrmStore,
  mission: ProspectSuperSearchMission,
  candidateIds: Iterable<string>
) {
  const state = mission.deepMining ||= createProspectDeepMiningState(mission.depth, mission.maxRounds);
  const existingRoots = new Set(state.nodes.filter((item) => item.depth === 0).map((item) => item.candidateId));
  const candidates = [...new Set(candidateIds)]
    .map((id) => store.websiteOpportunities.find((item) =>
      item.id === id
      && item.teamId === mission.teamId
      && item.ownerId === mission.ownerId
      && item.status !== "excluded"
    ))
    .filter((item): item is WebsiteOpportunity => Boolean(item))
    .sort((left, right) =>
      (right.scorecard?.actionPriority.score || right.confidence || 0)
        - (left.scorecard?.actionPriority.score || left.confidence || 0)
      || left.createdAt.localeCompare(right.createdAt)
    );
  let added = 0;
  for (const candidate of candidates) {
    if (existingRoots.has(candidate.id) || existingRoots.size >= state.maxRootCandidates) continue;
    try {
      ensureProspectVerificationReport(candidate);
      refreshProspectScorecard(store, candidate);
    } catch {
      // Scoring is advisory; evidence graph persistence must remain durable.
    }
    const node = nodeFromCandidate({
      missionId: mission.id,
      rootCandidateId: candidate.id,
      parentNodeId: "",
      depth: 0,
      candidate
    });
    state.nodes.push(node);
    state.tasks.push(taskFromNode(mission.id, node));
    existingRoots.add(candidate.id);
    added += 1;
  }
  refreshProspectDeepMiningSummary(store, mission);
  return added;
}

export function selectNextDeepMiningTask(state: ProspectDeepMiningState) {
  if (state.queriesUsed >= state.maxQueries) return undefined;
  return state.tasks
    .filter((item) => item.status === "queued" && item.depth < state.maxDepth)
    .sort((left, right) => right.depth - left.depth || left.createdAt.localeCompare(right.createdAt))[0];
}

function queryText(query: ProspectResolvedQuerySnapshot) {
  return [...new Set([
    ...query.positiveKeywords,
    ...query.synonyms,
    ...query.industryTerms,
    ...query.purchaseScenarioTerms,
    ...query.customerTypes,
    ...query.countries
  ])].filter(Boolean).join(" ").slice(0, 600);
}

export function planProspectDeepMiningRound(input: {
  mission: ProspectSuperSearchMission;
  task: ProspectDeepMiningTask;
  candidate: WebsiteOpportunity;
  baseQuery: ProspectResolvedQuerySnapshot;
  providerIds: string[];
  providerKinds?: Record<string, string>;
}): ProspectSearchRoundPlan {
  const roundNo = input.mission.currentRound + 1;
  const resolvedQuery: ProspectResolvedQuerySnapshot = {
    ...structuredClone(input.baseQuery),
    positiveKeywords: [normalized(input.candidate.company, 200)],
    synonyms: [],
    industryTerms: [normalized(input.candidate.business, 200)].filter(Boolean),
    purchaseScenarioTerms: [
      "subsidiary", "distributor", "authorized partner", "supplier",
      "buyer", "contract award", "project"
    ],
    countries: [normalized(input.candidate.country, 120)].filter((item) => item && item !== "未知"),
    languages: input.baseQuery.languages.length ? [...input.baseQuery.languages] : ["en"],
    customerTypes: ["related company", "buyer", "supplier", "partner"],
    exclusionKeywords: [...input.baseQuery.exclusionKeywords],
    exclusionDomains: [...input.baseQuery.exclusionDomains]
  };
  const providerResolvedQueries = buildProspectProviderResolvedQueries({
    resolvedQuery,
    providerIds: input.providerIds,
    providerKinds: input.providerKinds,
    focusCompany: input.candidate.company
  });
  const theme = "deep_candidate";
  const metadata = {
    source: "super_search" as const,
    plannerVersion: PROSPECT_SEARCH_PLANNER_VERSION,
    missionId: input.mission.id,
    roundNo,
    theme,
    planningMode: "rules" as const,
    fingerprint: prospectSearchQueryPlanFingerprint({
      missionId: input.mission.id,
      roundNo,
      theme,
      planningMode: "rules",
      resolvedQuery,
      providerResolvedQueries
    }),
    providerQueriesFingerprint: prospectProviderQueriesFingerprint(providerResolvedQueries)
  };
  const queryCells = input.providerIds.map((providerId) => {
    const providerQuery = providerResolvedQueries[providerId] || resolvedQuery;
    const cell = {
      market: providerQuery.countries[0] || "global",
      language: providerQuery.languages[0] || "en",
      customerType: providerQuery.customerTypes[0] || "related company",
      queryTheme: theme,
      providerId,
      queryText: queryText(providerQuery)
    };
    return { ...cell, fingerprint: hash(cell), status: "planned" as const };
  });
  return {
    resolvedQuery,
    providerResolvedQueries,
    metadata,
    coverageGaps: [`围绕“${input.candidate.company}”核验关系、采购信号和公开联系入口`],
    queryCells
  };
}

export function startDeepMiningTask(
  state: ProspectDeepMiningState,
  task: ProspectDeepMiningTask,
  runId: string,
  roundNo: number,
  plannedQuery: string
) {
  const now = new Date().toISOString();
  task.status = "searching";
  task.runId = runId;
  task.roundNo = roundNo;
  task.queryText = plannedQuery;
  task.startedAt = now;
  state.activeTaskId = task.id;
  state.status = "searching";
  state.startedAt ||= now;
  state.queriesUsed += 1;
}

export function attachDeepMiningWebsiteProbe(
  state: ProspectDeepMiningState,
  task: ProspectDeepMiningTask,
  attemptId: string
) {
  if (!attemptId || task.websiteProbeAttemptId) return false;
  task.websiteProbeAttemptId = attemptId;
  state.websiteProbesUsed += 1;
  return true;
}

function relationType(evidence: ProviderEvidenceSnapshot[]): ProspectDeepMiningRelationType {
  const text = evidence.map((item) => `${item.recordType} ${item.evidenceSummary}`).join(" ").toLocaleLowerCase("en-US");
  if (/subsidiar|parent compan|holding/u.test(text)) return "parent_subsidiary";
  if (/distributor|dealer|reseller/u.test(text)) return "brand_distributor";
  if (/award|framework contract|winning bidder/u.test(text)) return "procurement_award";
  if (/buyer|supplier|vendor/u.test(text)) return "buyer_supplier";
  if (/project owner|contractor|\bepc\b/u.test(text)) return "project_owner_contractor";
  if (/certified|authorized partner/u.test(text)) return "certified_partner";
  if (/representative|sales agent/u.test(text)) return "regional_representative";
  if (/contact|email/u.test(text)) return "contact_channel";
  return "related_company";
}

function evidenceForCandidate(input: {
  state: ProspectDeepMiningState;
  nodeId: string;
  candidate: WebsiteOpportunity;
  task: ProspectDeepMiningTask;
  providerIds: Set<string>;
}) {
  const created: ProspectDeepMiningEvidence[] = [];
  for (const item of input.candidate.sourceEvidence || []) {
    const url = sourceUrl(item);
    if (!url || (input.providerIds.size && !input.providerIds.has(item.providerId))) continue;
    const id = `pdme_${hash({
      candidateId: input.candidate.id,
      providerId: item.providerId,
      sourceUrl: url,
      payloadHash: item.payloadHash
    }).slice(0, 32)}`;
    if (input.state.evidence.some((entry) => entry.id === id)) continue;
    const evidence: ProspectDeepMiningEvidence = {
      id,
      nodeId: input.nodeId,
      candidateId: input.candidate.id,
      providerId: item.providerId,
      sourceUrl: url,
      summary: normalized(item.evidenceSummary || `${input.candidate.company} 的公开来源发现`, 1_000),
      queryText: input.task.queryText,
      authority: authority(item),
      observedAt: item.fetchedAt,
      payloadHash: item.payloadHash
    };
    input.state.evidence.push(evidence);
    created.push(evidence);
  }
  return created;
}

export function settleDeepMiningRound(
  store: CrmStore,
  mission: ProspectSuperSearchMission,
  round: ProspectSuperSearchRound
) {
  const state = mission.deepMining;
  if (!state || round.roundKind !== "deep_mining") return { newNodes: 0, evidence: 0, relations: 0, duplicates: 0 };
  const task = state.tasks.find((item) => item.id === state.activeTaskId || item.runId === round.runId);
  if (!task || ["completed", "failed", "stopped"].includes(task.status)) {
    return { newNodes: 0, evidence: 0, relations: 0, duplicates: 0 };
  }
  const providerIds = new Set((round.queryCells || []).map((item) => item.providerId));
  const candidateIds = [...new Set((store.prospectCandidateProcessingStates || [])
    .filter((item) =>
      item.teamId === mission.teamId
      && item.ownerId === mission.ownerId
      && item.runId === round.runId
      && item.status === "completed"
      && item.candidateId
    )
    .map((item) => item.candidateId!))];
  let newNodes = 0;
  let evidenceCount = 0;
  let relations = 0;
  let duplicates = 0;
  for (const candidateId of candidateIds) {
    if (candidateId === task.candidateId) {
      duplicates += 1;
      continue;
    }
    const candidate = store.websiteOpportunities.find((item) =>
      item.id === candidateId
      && item.teamId === mission.teamId
      && item.ownerId === mission.ownerId
    );
    if (!candidate) continue;
    const existingNode = state.nodes.find((item) =>
      item.rootCandidateId === task.rootCandidateId
      && item.candidateId === candidate.id
    );
    const targetNodeId = existingNode?.id
      || nodeId(mission.id, task.rootCandidateId, candidate.id);
    const createdEvidence = evidenceForCandidate({ state, nodeId: targetNodeId, candidate, task, providerIds });
    if (!createdEvidence.length) continue;
    evidenceCount += createdEvidence.length;
    const node = existingNode || nodeFromCandidate({
      missionId: mission.id,
      rootCandidateId: task.rootCandidateId,
      parentNodeId: task.nodeId,
      depth: task.depth + 1,
      candidate,
      evidenceIds: createdEvidence.map((item) => item.id)
    });
    node.evidenceIds = [...new Set([...node.evidenceIds, ...createdEvidence.map((item) => item.id)])];
    node.updatedAt = new Date().toISOString();
    if (!existingNode) {
      state.nodes.push(node);
      newNodes += 1;
    } else {
      duplicates += 1;
    }
    const edgeKey = `${task.nodeId}:${node.id}`;
    let edge = state.edges.find((item) => `${item.fromNodeId}:${item.toNodeId}` === edgeKey);
    if (!edge) {
      const sourceEvidence = (candidate.sourceEvidence || []).filter((item) => sourceUrl(item));
      edge = {
        id: `pdmedge_${hash({ missionId: mission.id, edgeKey }).slice(0, 32)}`,
        rootCandidateId: task.rootCandidateId,
        fromNodeId: task.nodeId,
        toNodeId: node.id,
        relationType: relationType(sourceEvidence),
        confidence: Math.min(100, 35 + createdEvidence.length * 15 + (createdEvidence.some((item) => item.authority === "official") ? 25 : 0)),
        evidenceIds: createdEvidence.map((item) => item.id),
        sourceUrls: [...new Set(createdEvidence.map((item) => item.sourceUrl))],
        verified: createdEvidence.some((item) => item.authority === "official" || item.authority === "corroborated"),
        conflict: false,
        createdAt: new Date().toISOString()
      };
      state.edges.push(edge);
      relations += 1;
    } else {
      edge.evidenceIds = [...new Set([...edge.evidenceIds, ...createdEvidence.map((item) => item.id)])];
      edge.sourceUrls = [...new Set([...edge.sourceUrls, ...createdEvidence.map((item) => item.sourceUrl)])];
    }
    if (!existingNode
      && node.depth < state.maxDepth
      && !state.tasks.some((item) => item.rootCandidateId === node.rootCandidateId && item.candidateId === node.candidateId)) {
      state.tasks.push(taskFromNode(mission.id, node));
    }
  }
  task.newNodeCount += newNodes;
  task.evidenceCount += evidenceCount;
  task.duplicateCount += duplicates;
  if (task.websiteProbeAttemptId) {
    const candidate = store.websiteOpportunities.find((item) => item.id === task.candidateId);
    const attempt = candidate?.websiteProbeAttempts?.find((item) => item.id === task.websiteProbeAttemptId);
    if (attempt && !["completed", "failed"].includes(attempt.status)) {
      task.status = "verifying";
      state.status = "verifying";
      refreshProspectDeepMiningSummary(store, mission);
      return { newNodes, evidence: evidenceCount, relations, duplicates };
    }
  }
  task.status = "completed";
  task.stopReason = newNodes ? "本层证据已归档" : evidenceCount ? "证据已合并，未产生新关系节点" : "本轮没有返回可追溯的新证据";
  task.completedAt = new Date().toISOString();
  state.activeTaskId = "";
  state.status = "queued";
  refreshProspectDeepMiningSummary(store, mission);
  return { newNodes, evidence: evidenceCount, relations, duplicates };
}

export function settleDeepMiningVerification(
  store: CrmStore,
  mission: ProspectSuperSearchMission
) {
  const state = mission.deepMining;
  if (!state) return [];
  const settled: ProspectDeepMiningTask[] = [];
  for (const task of state.tasks.filter((item) => item.status === "verifying")) {
    const candidate = store.websiteOpportunities.find((item) =>
      item.id === task.candidateId
      && item.teamId === mission.teamId
      && item.ownerId === mission.ownerId
    );
    const attempt = candidate?.websiteProbeAttempts?.find((item) => item.id === task.websiteProbeAttemptId);
    if (!attempt || !["completed", "failed"].includes(attempt.status)) continue;
    if (candidate) {
      try {
        ensureProspectVerificationReport(candidate);
        refreshProspectScorecard(store, candidate);
      } catch {
        // The website probe result is still recorded even if a qualification gate is unavailable.
      }
    }
    task.status = "completed";
    task.stopReason = task.newNodeCount
      ? "关系证据和官网验证均已归档"
      : attempt.outcome === "evidence_found"
        ? "官网证据已归档，本轮未产生新关系节点"
        : "本轮没有取得可追溯的新关系证据";
    task.completedAt = new Date().toISOString();
    if (state.activeTaskId === task.id) state.activeTaskId = "";
    settled.push(task);
  }
  if (settled.length) state.status = "queued";
  refreshProspectDeepMiningSummary(store, mission);
  return settled;
}

export function finishDeepMiningState(
  state: ProspectDeepMiningState,
  reason: string,
  failed = false
) {
  const now = new Date().toISOString();
  for (const task of state.tasks) {
    if (["queued", "searching", "verifying"].includes(task.status)) {
      task.status = "stopped";
      task.stopReason = reason;
      task.completedAt = now;
    }
  }
  state.activeTaskId = "";
  state.status = failed ? "failed" : "completed";
  state.stopReason = reason;
  state.endedAt = now;
}

export function deepMiningHasPendingWork(state: ProspectDeepMiningState | undefined) {
  return Boolean(state?.tasks.some((item) => ["queued", "searching", "verifying"].includes(item.status)));
}

export function canQueueDeepMiningWebsiteProbe(state: ProspectDeepMiningState, candidate: WebsiteOpportunity) {
  return Boolean(
    candidate.website
    && state.websiteProbesUsed < state.maxWebsiteProbes
    && !candidate.websiteProbeAttempts?.some((item) => ["queued", "running"].includes(item.status))
  );
}

export const prospectDeepMiningTestSupport = {
  relationType,
  evidenceForCandidate,
  limits,
  hash,
  randomId: () => randomUUID()
};
