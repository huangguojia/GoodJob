import { randomUUID } from "node:crypto";
import { z } from "zod";
import { callAiModel, extractJsonObject } from "./ai-model-runtime.js";
import { getProvider } from "./lead-providers.js";
import {
  createProspectRun,
  prospectRunDiagnostics,
  prospectRunEtag,
  transitionProspectRun
} from "./prospect-runs.js";
import {
  prospectStrategyEtag,
  resolveProspectStrategyQuery
} from "./prospect-strategies.js";
import {
  enhanceProspectSearchRoundPlan,
  planProspectSearchRound
} from "./prospect-search-planner.js";
import { prospectCandidateQualificationCounts } from "./prospect-scorecard.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectSearchRun,
  ProspectSuperSearchDepth,
  ProspectSuperSearchEvent,
  ProspectSuperSearchMission,
  ProspectSuperSearchRound,
  SessionUser
} from "./types.js";

const terminalRunStatuses = new Set<ProspectSearchRun["status"]>([
  "cancelled",
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed"
]);

const activeMissionStatuses = new Set<ProspectSuperSearchMission["status"]>([
  "queued",
  "running"
]);

const depthRounds: Record<ProspectSuperSearchDepth, number> = {
  balanced: 4,
  deep: 8,
  extreme: 16
};

const queryThemeLabels: Record<string, string> = {
  baseline: "基础覆盖",
  local_channel: "当地语言渠道",
  procurement: "采购与招标",
  project_engineering: "项目与工程",
  trade_channel: "进口与批发渠道",
  oem_integration: "OEM 与系统集成",
  vendor_registration: "供应商准入",
  directory_association: "行业协会与目录",
  aftermarket_service: "售后与 MRO",
  contract_award: "中标与框架合同",
  expansion_signal: "扩产与新建项目",
  certification_ecosystem: "认证与授权生态",
  regional_long_tail: "区域长尾渠道",
  application_specialist: "应用方案商",
  replacement_demand: "改造与替换需求",
  coverage_recovery: "覆盖缺口恢复"
};

export const prospectSuperSearchPreviewSchema = z.object({
  products: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  markets: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
  customerTypes: z.array(z.string().trim().min(1).max(160)).min(1).max(20),
  industries: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  providerIds: z.array(z.string().trim().regex(/^[a-z0-9_]+$/)).min(1).max(30),
  depth: z.enum(["balanced", "deep", "extreme"]).default("deep"),
  targetCandidateCount: z.number().int().min(20).max(10_000).default(300),
  maxDurationMinutes: z.number().int().min(30).max(4_320).default(480),
  costLimit: z.number().finite().min(0).max(1_000_000).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).or(z.literal("")).default(""),
  webSearchMode: z.enum(["off", "api"]).default("off"),
  mapSearchMode: z.enum(["off", "google_places"]).default("off"),
  aiDiscoveryMode: z.enum(["off", "model"]).default("off")
}).strict().superRefine((value, context) => {
  if (value.costLimit > 0 && !value.currency) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["currency"], message: "设置费用上限时必须填写币种" });
  }
  if (value.costLimit === 0 && value.currency) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["currency"], message: "免费搜索不要填写币种" });
  }
});

export const createProspectSuperSearchSchema = z.object({
  strategyId: z.string().trim().min(1).max(80),
  targetCandidateCount: z.number().int().min(20).max(10_000).default(300),
  maxDurationMinutes: z.number().int().min(30).max(4_320).default(480),
  depth: z.enum(["balanced", "deep", "extreme"]).default("deep"),
  costLimit: z.number().finite().min(0).max(1_000_000).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).or(z.literal("")).default(""),
  aiMode: z.enum(["auto", "off"]).default("auto"),
  webSearchMode: z.enum(["off", "api"]).default("off"),
  mapSearchMode: z.enum(["off", "google_places"]).default("off"),
  aiDiscoveryMode: z.enum(["off", "model"]).default("off")
}).strict().superRefine((value, context) => {
  if (value.costLimit > 0 && !value.currency) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["currency"], message: "设置费用上限时必须填写币种" });
  }
  if (value.costLimit === 0 && value.currency) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["currency"], message: "免费搜索不要填写币种" });
  }
});

export const prospectSuperSearchActionSchema = z.object({
  reason: z.string().trim().max(500).default("")
}).strict();

const aiQueryEnhancementSchema = z.object({
  synonyms: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  industryTerms: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  purchaseScenarioTerms: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  customerTypes: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  languages: z.array(z.string().trim().min(1).max(40)).max(10).default([])
}).strict();

export class ProspectSuperSearchError extends Error {
  readonly details: Record<string, unknown> = {};

  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ProspectSuperSearchError";
  }
}

function visibleTo(user: SessionUser, mission: ProspectSuperSearchMission) {
  if (user.role === "super_admin") return false;
  if (user.role === "manager" || user.role === "admin") return mission.teamId === user.teamId;
  return mission.teamId === user.teamId && mission.ownerId === user.id;
}

function findVisibleMission(store: CrmStore, user: SessionUser, missionId: string) {
  const mission = store.prospectSuperSearchMissions.find((item) => item.id === missionId);
  if (!mission || !visibleTo(user, mission)) {
    throw new ProspectSuperSearchError(404, "SUPER_SEARCH_NOT_FOUND", "超级搜索任务不存在或无权访问");
  }
  return mission;
}

function assertMissionEtag(mission: ProspectSuperSearchMission, ifMatch?: string) {
  if (!ifMatch) throw new ProspectSuperSearchError(428, "PRECONDITION_REQUIRED", "修改超级搜索任务必须提供 If-Match");
  if (ifMatch.trim() !== prospectSuperSearchEtag(mission)) {
    throw new ProspectSuperSearchError(412, "SUPER_SEARCH_REVISION_CONFLICT", "超级搜索任务已更新，请刷新后重试");
  }
}

function appendEvent(
  store: CrmStore,
  mission: ProspectSuperSearchMission,
  type: ProspectSuperSearchEvent["type"],
  message: string
) {
  const sequence = store.prospectSuperSearchEvents.filter((item) => item.missionId === mission.id).length + 1;
  store.prospectSuperSearchEvents.push({
    id: `psse_${randomUUID()}`,
    missionId: mission.id,
    teamId: mission.teamId,
    ownerId: mission.ownerId,
    sequence,
    type,
    message,
    createdAt: new Date().toISOString()
  });
}

function missionUser(store: CrmStore, mission: ProspectSuperSearchMission): SessionUser {
  const user = store.users.find((item) => item.id === mission.ownerId && item.teamId === mission.teamId && item.status === "active");
  if (!user || user.role === "super_admin") {
    throw new ProspectSuperSearchError(409, "SUPER_SEARCH_OWNER_INVALID", "超级搜索任务负责人不存在或已停用");
  }
  return { ...user, authVersion: user.authVersion || 1 };
}

function missionRounds(store: CrmStore, missionId: string) {
  return store.prospectSuperSearchRounds
    .filter((item) => item.missionId === missionId)
    .sort((left, right) => left.roundNo - right.roundNo);
}

function missionEvents(store: CrmStore, missionId: string) {
  return store.prospectSuperSearchEvents
    .filter((item) => item.missionId === missionId)
    .sort((left, right) => left.sequence - right.sequence);
}

function webProviderIdsFromIds(store: CrmStore | undefined, providerIds: string[]) {
  return [...new Set(providerIds.filter((providerId) => {
    const catalog = store?.providerCatalog.find((item) =>
      item.code.toLocaleLowerCase("en-US") === providerId.toLocaleLowerCase("en-US")
    );
    if (catalog) {
      return catalog.status === "active"
        && catalog.category === "web"
        && catalog.accessMode === "api"
        && catalog.capabilities.includes("web");
    }
    const provider = getProvider(providerId);
    return provider?.category === "web"
      && provider.accessMode === "api"
      && provider.capabilities.includes("web");
  }))];
}

function mapProviderIdsFromIds(store: CrmStore | undefined, providerIds: string[]) {
  return [...new Set(providerIds.filter((providerId) => {
    const catalog = store?.providerCatalog.find((item) =>
      item.code.toLocaleLowerCase("en-US") === providerId.toLocaleLowerCase("en-US")
    );
    if (catalog) {
      return catalog.status === "active"
        && catalog.accessMode === "api"
        && catalog.capabilities.includes("maps");
    }
    const provider = getProvider(providerId);
    return provider?.accessMode === "api" && provider.capabilities.includes("maps");
  }))];
}

function aiDiscoveryProviderIdsFromIds(store: CrmStore | undefined, providerIds: string[]) {
  return [...new Set(providerIds.filter((providerId) => {
    const normalizedId = providerId.toLocaleLowerCase("en-US");
    const catalog = store?.providerCatalog.find((item) =>
      item.code.toLocaleLowerCase("en-US") === normalizedId
    );
    if (catalog) {
      return catalog.status === "active"
        && catalog.accessMode === "api"
        && catalog.category === "ai"
        && catalog.capabilities.includes("ai");
    }
    return normalizedId === "ai_search";
  }))];
}

function missionSearchModes(store: CrmStore, mission: ProspectSuperSearchMission) {
  const strategy = store.prospectStrategies.find((item) =>
    item.id === mission.strategyId && item.teamId === mission.teamId
  );
  const providerIds = strategy?.providerPlan.map((item) => item.providerId) || [];
  const webProviderIds = webProviderIdsFromIds(
    store,
    providerIds
  );
  const mapProviderIds = mapProviderIdsFromIds(store, providerIds);
  const aiDiscoveryProviderIds = aiDiscoveryProviderIdsFromIds(store, providerIds);
  const runIds = new Set(missionRounds(store, mission.id).map((item) => item.runId));
  const candidateIds = [...new Set(
    (store.prospectCandidateProcessingStates || [])
      .filter((item) => runIds.has(item.runId) && item.status === "completed" && item.candidateId)
      .map((item) => item.candidateId!)
  )];
  return {
    webSearchMode: webProviderIds.length ? "api" as const : "off" as const,
    webProviderIds,
    mapSearchMode: mapProviderIds.includes("google_places") ? "google_places" as const : "off" as const,
    mapProviderIds,
    aiDiscoveryMode: aiDiscoveryProviderIds.includes("ai_search") ? "model" as const : "off" as const,
    aiDiscoveryProviderIds,
    candidateIds
  };
}

function candidateQualificationCounts(
  store: CrmStore,
  mission: ProspectSuperSearchMission,
  candidateIds: ReadonlySet<string>
) {
  return prospectCandidateQualificationCounts(store, {
    teamId: mission.teamId,
    ownerId: mission.ownerId,
    candidateIds
  });
}

function missionCandidateIds(store: CrmStore, mission: ProspectSuperSearchMission) {
  const runIds = new Set(missionRounds(store, mission.id).map((item) => item.runId));
  return new Set(
    (store.prospectCandidateProcessingStates || [])
      .filter((item) =>
        item.teamId === mission.teamId
        && item.ownerId === mission.ownerId
        && runIds.has(item.runId)
        && item.status === "completed"
        && item.candidateId
      )
      .map((item) => item.candidateId!)
  );
}

function liveMissionCounts(store: CrmStore, mission: ProspectSuperSearchMission) {
  const rounds = missionRounds(store, mission.id);
  const candidateIds = missionCandidateIds(store, mission);
  const counts = candidateQualificationCounts(store, mission, candidateIds);
  const hasCandidateRefs = candidateIds.size > 0;
  return {
    rawCount: rounds.reduce((sum, item) => sum + item.rawCount, 0),
    uniqueCount: hasCandidateRefs
      ? candidateIds.size
      : rounds.reduce((sum, item) => sum + item.uniqueCount, 0),
    candidateCount: hasCandidateRefs
      ? candidateIds.size
      : rounds.reduce((sum, item) => sum + item.candidateCount, 0),
    reviewReadyCount: hasCandidateRefs
      ? counts.reviewReadyCount
      : mission.reviewReadyCount ?? mission.candidateCount,
    vqaCount: hasCandidateRefs ? counts.vqaCount : mission.vqaCount || 0,
    pendingCount: rounds.reduce((sum, item) => sum + item.pendingCount, 0),
    filteredCount: rounds.reduce((sum, item) => sum + item.filteredCount, 0),
    totalCost: rounds.reduce((sum, item) => sum + item.cost, 0)
  };
}

function liveRoundSnapshot(
  store: CrmStore,
  mission: ProspectSuperSearchMission,
  round: ProspectSuperSearchRound
) {
  const candidateIds = new Set(
    (store.prospectCandidateProcessingStates || [])
      .filter((item) =>
        item.teamId === mission.teamId
        && item.ownerId === mission.ownerId
        && item.runId === round.runId
        && item.status === "completed"
        && item.candidateId
      )
      .map((item) => item.candidateId!)
  );
  if (!candidateIds.size) return { ...round };
  const counts = candidateQualificationCounts(store, mission, candidateIds);
  return {
    ...round,
    reviewReadyCount: counts.reviewReadyCount,
    vqaCount: counts.vqaCount,
    yieldRate: round.rawCount
      ? counts.reviewReadyCount / round.rawCount
      : 0
  };
}

function updateMissionTotals(store: CrmStore, mission: ProspectSuperSearchMission) {
  Object.assign(mission, liveMissionCounts(store, mission));
}

function runCostSummary(
  store: CrmStore,
  mission: ProspectSuperSearchMission,
  runId: string
) {
  const byProvider = new Map<string, {
    amount: number;
    unknownCount: number;
    currencyMismatch: boolean;
  }>();
  for (const attempt of store.prospectExecutionAttempts.filter((item) =>
    item.runId === runId
    && item.teamId === mission.teamId
    && item.ownerId === mission.ownerId
    && Boolean(item.finishedAt)
  )) {
    const current = byProvider.get(attempt.providerCode) || {
      amount: 0,
      unknownCount: 0,
      currencyMismatch: false
    };
    if (attempt.costAmount === null || attempt.costKind === "unknown") {
      current.unknownCount += 1;
    } else {
      current.amount += attempt.costAmount;
      if (attempt.costAmount > 0
        && mission.currency
        && attempt.currency !== mission.currency) {
        current.currencyMismatch = true;
      }
    }
    byProvider.set(attempt.providerCode, current);
  }
  return {
    byProvider,
    amount: [...byProvider.values()].reduce((sum, item) => sum + item.amount, 0),
    unknownCount: [...byProvider.values()].reduce((sum, item) => sum + item.unknownCount, 0),
    currencyMismatch: [...byProvider.values()].some((item) => item.currencyMismatch)
  };
}

export function refreshProspectSuperSearchMissionResults(
  store: CrmStore,
  missionId: string
) {
  const mission = store.prospectSuperSearchMissions.find((item) => item.id === missionId);
  if (!mission) return null;
  const before = JSON.stringify({
    mission,
    rounds: missionRounds(store, mission.id)
  });
  for (const round of missionRounds(store, mission.id)) {
    const run = store.prospectSearchRuns.find((item) =>
      item.id === round.runId && item.teamId === mission.teamId
    );
    if (!run) continue;
    const report = prospectRunDiagnostics(store, run).cleaningReport;
    const summary = report.summary;
    const cleaningByProvider = new Map(
      report.sources.map((item) => [item.providerCode, item])
    );
    const cost = runCostSummary(store, mission, run.id);
    round.rawCount = summary.providerRawCount;
    round.uniqueCount = summary.candidateCount;
    round.candidateCount = summary.candidateCount;
    const roundCandidateIds = new Set(
      (store.prospectCandidateProcessingStates || [])
        .filter((item) =>
          item.teamId === mission.teamId
          && item.ownerId === mission.ownerId
          && item.runId === run.id
          && item.status === "completed"
          && item.candidateId
        )
        .map((item) => item.candidateId!)
    );
    const qualificationCounts = candidateQualificationCounts(
      store,
      mission,
      roundCandidateIds
    );
    round.reviewReadyCount = qualificationCounts.reviewReadyCount;
    round.vqaCount = qualificationCounts.vqaCount;
    round.duplicateCount = summary.providerDuplicateCount + summary.mergedCount + summary.suppressedCount;
    round.filteredCount = summary.providerInvalidCount + summary.rejectedCount + summary.suppressedCount + summary.mergedCount;
    round.pendingCount = summary.pendingCount;
    round.duplicateRate = summary.providerRawCount ? round.duplicateCount / summary.providerRawCount : 0;
    round.yieldRate = summary.providerRawCount
      ? (round.reviewReadyCount || 0) / summary.providerRawCount
      : 0;
    round.queryCells = (round.queryCells || []).map((cell) => {
      const cleaning = cleaningByProvider.get(cell.providerId);
      const providerCost = cost.byProvider.get(cell.providerId);
      return {
        ...cell,
        rawCount: cleaning?.rawCount || 0,
        invalidCount: cleaning?.invalidCount || 0,
        duplicateCount: cleaning?.duplicateCount || 0,
        candidateCount: cleaning?.candidateCount || 0,
        costAmount: providerCost?.amount || 0,
        costUnknownCount: providerCost?.unknownCount || 0,
        currency: mission.currency
      };
    });
    round.cost = cost.amount;
    round.costUnknownCount = cost.unknownCount;
    round.costIntegrityStatus = cost.currencyMismatch
      ? "currency_mismatch"
      : cost.unknownCount
        ? "unknown"
        : "complete";
  }
  updateMissionTotals(store, mission);
  const after = JSON.stringify({
    mission,
    rounds: missionRounds(store, mission.id)
  });
  if (before !== after) {
    mission.revision += 1;
    mission.updatedAt = new Date().toISOString();
  }
  return mission;
}

function completeRound(store: CrmStore, mission: ProspectSuperSearchMission, run: ProspectSearchRun) {
  const round = store.prospectSuperSearchRounds.find((item) => item.missionId === mission.id && item.runId === run.id);
  if (!round || round.completedAt) return round;
  const diagnostics = prospectRunDiagnostics(store, run);
  const summary = diagnostics.cleaningReport.summary;
  const sourceByProvider = new Map(
    diagnostics.sources.map((item) => [item.providerCode, item])
  );
  const cleaningByProvider = new Map(
    diagnostics.cleaningReport.sources.map((item) => [item.providerCode, item])
  );
  const cost = runCostSummary(store, mission, run.id);
  const completedAt = new Date().toISOString();
  round.queryCells = (round.queryCells || []).map((cell) => {
    const source = sourceByProvider.get(cell.providerId);
    const cleaning = cleaningByProvider.get(cell.providerId);
    const providerCost = cost.byProvider.get(cell.providerId);
    const status = source?.status === "failed"
      ? "failed"
      : source?.status === "cancelled"
        ? "cancelled"
        : source?.status === "partial_success"
          ? "partial_success"
          : (cleaning?.rawCount || 0) > 0
            ? "succeeded"
            : "succeeded_empty";
    return {
      ...cell,
      status,
      rawCount: cleaning?.rawCount || 0,
      invalidCount: cleaning?.invalidCount || 0,
      duplicateCount: cleaning?.duplicateCount || 0,
      candidateCount: cleaning?.candidateCount || 0,
      costAmount: providerCost?.amount || 0,
      costUnknownCount: providerCost?.unknownCount || 0,
      currency: mission.currency,
      errorCode: source?.failure?.errorCode || "",
      errorMessage: source?.failure?.errorMessage || "",
      completedAt
    };
  });
  round.rawCount = summary.providerRawCount;
  round.uniqueCount = summary.candidateCount;
  round.candidateCount = summary.candidateCount;
  const roundCandidateIds = new Set(
    (store.prospectCandidateProcessingStates || [])
      .filter((item) =>
        item.teamId === mission.teamId
        && item.ownerId === mission.ownerId
        && item.runId === run.id
        && item.status === "completed"
        && item.candidateId
      )
      .map((item) => item.candidateId!)
  );
  const qualificationCounts = candidateQualificationCounts(
    store,
    mission,
    roundCandidateIds
  );
  round.reviewReadyCount = qualificationCounts.reviewReadyCount;
  round.vqaCount = qualificationCounts.vqaCount;
  round.duplicateCount = summary.providerDuplicateCount + summary.mergedCount + summary.suppressedCount;
  round.filteredCount = summary.providerInvalidCount + summary.rejectedCount + summary.suppressedCount + summary.mergedCount;
  round.pendingCount = summary.pendingCount;
  round.duplicateRate = summary.providerRawCount ? round.duplicateCount / summary.providerRawCount : 0;
  round.yieldRate = summary.providerRawCount
    ? (round.reviewReadyCount || 0) / summary.providerRawCount
    : 0;
  round.cost = cost.amount;
  round.costUnknownCount = cost.unknownCount;
  round.costIntegrityStatus = cost.currencyMismatch
    ? "currency_mismatch"
    : cost.unknownCount
      ? "unknown"
      : "complete";
  round.completedAt = completedAt;
  updateMissionTotals(store, mission);
  appendEvent(
    store,
    mission,
    "round_completed",
    `第 ${round.roundNo} 轮完成：原始 ${round.rawCount}，候选 ${round.candidateCount}，可审查 ${round.reviewReadyCount || 0}，VQA ${round.vqaCount || 0}，过滤 ${round.filteredCount}`
  );
  return round;
}

export function prospectSuperSearchConvergenceReason(store: CrmStore, mission: ProspectSuperSearchMission) {
  const now = Date.now();
  if ((mission.reviewReadyCount || 0) >= mission.targetCandidateCount) {
    return "已达到目标可审查候选数量";
  }
  if (now >= new Date(mission.deadlineAt).getTime()) return "已达到最长运行时间";
  if (mission.costLimit > 0 && mission.totalCost >= mission.costLimit) return "已达到费用上限";
  const completed = missionRounds(store, mission.id).filter((item) => item.completedAt);
  if (mission.costLimit > 0 && completed.some((item) => item.costIntegrityStatus === "currency_mismatch")) {
    return "费用回执币种与任务预算不一致，已停止后续调用";
  }
  if (mission.costLimit > 0 && completed.some((item) => (item.costUnknownCount || 0) > 0)) {
    return "费用回执不完整，已停止后续调用";
  }
  if (mission.currentRound >= mission.maxRounds) return "已达到最大搜索轮次";
  const recent = completed.slice(-2);
  if (recent.length === 2 && recent.every((item) => item.yieldRate < 0.03 && item.duplicateRate > 0.9)) {
    return "连续两轮新增率过低且重复率过高，搜索已收敛";
  }
  return "";
}

function finishMission(
  store: CrmStore,
  mission: ProspectSuperSearchMission,
  status: "succeeded" | "partial_success" | "failed" | "cancelled",
  reason: string
) {
  mission.status = status;
  mission.stopReason = reason;
  mission.revision += 1;
  mission.updatedAt = new Date().toISOString();
  const round = missionRounds(store, mission.id).find((item) => item.roundNo === mission.currentRound);
  if (round && round.decision === "pending") {
    round.decision = status === "cancelled" ? "manual_stop" : status === "failed" ? "failed" : "limit_reached";
    round.decisionReason = reason;
  }
  appendEvent(store, mission, status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "completed", reason);
}

async function startRound(
  store: CrmStore,
  mission: ProspectSuperSearchMission,
  onRunCreated?: () => void | Promise<void>
) {
  const strategy = store.prospectStrategies.find((item) => item.id === mission.strategyId && item.teamId === mission.teamId);
  if (!strategy || strategy.status !== "approved") {
    throw new ProspectSuperSearchError(409, "SUPER_SEARCH_STRATEGY_INVALID", "超级搜索策略不存在、未审批或已停用");
  }
  const user = missionUser(store, mission);
  const roundNo = mission.currentRound + 1;
  const version = store.prospectCampaignVersions.find((item) =>
    item.teamId === mission.teamId
    && item.campaignId === mission.campaignId
    && item.version === strategy.campaignVersion
  );
  if (!version) {
    throw new ProspectSuperSearchError(409, "SUPER_SEARCH_VERSION_INVALID", "超级搜索项目版本不存在");
  }
  const previousRounds = missionRounds(store, mission.id);
  let plan = planProspectSearchRound({
    baseQuery: resolveProspectStrategyQuery(strategy.query, version),
    missionId: mission.id,
    roundNo,
    maxRounds: mission.maxRounds,
    depth: mission.depth,
    providerIds: strategy.providerPlan.map((item) => item.providerId),
    previousRounds: previousRounds.map((item) => ({
      roundNo: item.roundNo,
      rawCount: item.rawCount,
      candidateCount: item.candidateCount,
      duplicateRate: item.duplicateRate,
      yieldRate: item.yieldRate,
      queryTheme: item.queryTheme
    }))
  });
  if (mission.aiMode === "auto") {
    const config = store.aiModelConfigs
      .filter((item) =>
        item.ownerId === mission.ownerId
        && item.teamId === mission.teamId
        && item.enabled
        && item.apiKey
        && item.useLeadFinder !== false
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (config) {
      try {
        const content = await callAiModel(config, [
          "你是外贸 B2B 查询规划器，只补充搜索表达，不生成公司、联系人、邮箱、电话或网址。",
          "只返回 JSON 对象，字段必须严格为 synonyms、industryTerms、purchaseScenarioTerms、customerTypes、languages，值均为字符串数组。",
          "表达必须服务于指定市场、产品和本轮主题；不得增加国家、数据源、预算或排除规则。",
          `本轮主题：${plan.metadata.theme}`,
          `当前查询：${JSON.stringify(plan.resolvedQuery)}`,
          `覆盖缺口：${JSON.stringify(plan.coverageGaps)}`
        ].join("\n"));
        const enhancement = aiQueryEnhancementSchema.parse(extractJsonObject(content));
        plan = enhanceProspectSearchRoundPlan(plan, enhancement);
      } catch {
        plan = {
          ...plan,
          coverageGaps: [
            ...plan.coverageGaps,
            "AI 查询扩展不可用或未通过校验，已自动使用规则规划继续"
          ]
        };
      }
    }
  }
  const result = await createProspectRun({
    store,
    user,
    strategyId: strategy.id,
    ifMatch: prospectStrategyEtag(strategy),
    idempotencyKey: `super-search:${mission.id}:round:${roundNo}`,
    body: { reason: `超级搜索第 ${roundNo}/${mission.maxRounds} 轮` },
    requestId: `super-search:${mission.id}:${roundNo}`,
    queryPlanOverride: {
      resolvedQuery: plan.resolvedQuery,
      metadata: plan.metadata
    }
  });
  const storedRun = store.prospectSearchRuns.find((item) => item.id === result.run.id);
  if (!storedRun) throw new ProspectSuperSearchError(500, "SUPER_SEARCH_RUN_MISSING", "首轮搜索已创建但未能读取运行快照");
  const now = new Date().toISOString();
  const round: ProspectSuperSearchRound = {
    id: `pssr_${randomUUID()}`,
    missionId: mission.id,
    teamId: mission.teamId,
    ownerId: mission.ownerId,
    roundNo,
    runId: result.run.id,
    queryPlanSnapshot: structuredClone(storedRun.executionSnapshot.resolvedQuery),
    plannerVersion: plan.metadata.plannerVersion,
    planningMode: plan.metadata.planningMode,
    queryTheme: plan.metadata.theme,
    queryPlanFingerprint: plan.metadata.fingerprint,
    coverageGaps: [...plan.coverageGaps],
    queryCells: structuredClone(plan.queryCells),
    rawCount: 0,
    uniqueCount: 0,
    candidateCount: 0,
    reviewReadyCount: 0,
    vqaCount: 0,
    duplicateCount: 0,
    filteredCount: 0,
    pendingCount: 0,
    duplicateRate: 0,
    yieldRate: 0,
    cost: 0,
    costUnknownCount: 0,
    costIntegrityStatus: "complete",
    decision: "pending",
    decisionReason: "",
    createdAt: now,
    completedAt: ""
  };
  store.prospectSuperSearchRounds.push(round);
  mission.currentRound = roundNo;
  mission.currentRunId = result.run.id;
  mission.status = "running";
  mission.revision += 1;
  mission.updatedAt = now;
  appendEvent(
    store,
    mission,
    "round_started",
    `第 ${roundNo} 轮“${queryThemeLabels[plan.metadata.theme] || plan.metadata.theme}”已进入队列，执行 ${result.shards.length} 个数据源`
  );
  await store.persist();
  await onRunCreated?.();
  return result;
}

export function prospectSuperSearchPreview(input: z.infer<typeof prospectSuperSearchPreviewSchema>) {
  const parsed = prospectSuperSearchPreviewSchema.parse(input);
  const webProviderIds = webProviderIdsFromIds(undefined, parsed.providerIds);
  const mapProviderIds = mapProviderIdsFromIds(undefined, parsed.providerIds);
  const aiDiscoveryProviderIds = aiDiscoveryProviderIdsFromIds(undefined, parsed.providerIds);
  const maxRounds = depthRounds[parsed.depth];
  const marketCells = parsed.markets.length * parsed.customerTypes.length;
  const queryThemes = Math.max(1, parsed.products.length + parsed.industries.length);
  const coverageCombinations = Math.min(500, marketCells * queryThemes);
  const cellsPerRound = parsed.providerIds.length;
  return {
    mode: "super" as const,
    maxRounds,
    marketCells,
    queryThemes,
    coverageCombinations,
    providerCount: parsed.providerIds.length,
    webSearchMode: parsed.webSearchMode,
    webProviderCount: webProviderIds.length,
    webProviderIds,
    mapSearchMode: parsed.mapSearchMode,
    mapProviderCount: mapProviderIds.length,
    mapProviderIds,
    aiDiscoveryMode: parsed.aiDiscoveryMode,
    aiDiscoveryProviderCount: aiDiscoveryProviderIds.length,
    aiDiscoveryProviderIds,
    cellsPerRound,
    maximumCells: cellsPerRound * maxRounds,
    targetCandidateCount: parsed.targetCandidateCount,
    maxDurationMinutes: parsed.maxDurationMinutes,
    costLimit: parsed.costLimit,
    currency: parsed.currency,
    usesPaidBudget: parsed.costLimit > 0
  };
}

export function prospectSuperSearchEtag(mission: Pick<ProspectSuperSearchMission, "id" | "revision">) {
  return `"${mission.id}:${mission.revision}"`;
}

export async function createProspectSuperSearch(input: {
  store: CrmStore;
  user: SessionUser;
  body: z.infer<typeof createProspectSuperSearchSchema>;
  onRunCreated?: () => void | Promise<void>;
}) {
  if (input.user.role === "super_admin") {
    throw new ProspectSuperSearchError(403, "SUPER_SEARCH_FORBIDDEN", "超级管理员默认不能创建团队搜客任务");
  }
  const body = createProspectSuperSearchSchema.parse(input.body);
  const strategy = input.store.prospectStrategies.find((item) =>
    item.id === body.strategyId && item.teamId === input.user.teamId
    && (item.ownerId === input.user.id || input.user.role === "manager" || input.user.role === "admin")
  );
  if (!strategy || strategy.status !== "approved") {
    throw new ProspectSuperSearchError(409, "SUPER_SEARCH_STRATEGY_INVALID", "请先使用当前账号审批一个可执行搜索策略");
  }
  const webProviderIds = webProviderIdsFromIds(
    input.store,
    strategy.providerPlan.map((item) => item.providerId)
  );
  if (body.webSearchMode === "api" && !webProviderIds.length) {
    throw new ProspectSuperSearchError(
      409,
      "SUPER_SEARCH_WEB_PROVIDER_REQUIRED",
      "实时网页搜索已开启，请先配置并选择一个可用的 Web Search API"
    );
  }
  if (body.webSearchMode === "off" && webProviderIds.length) {
    throw new ProspectSuperSearchError(
      409,
      "SUPER_SEARCH_WEB_PROVIDER_NOT_ALLOWED",
      "实时网页搜索未开启，请关闭 Web 搜索来源或开启实时网页搜索"
    );
  }
  const mapProviderIds = mapProviderIdsFromIds(
    input.store,
    strategy.providerPlan.map((item) => item.providerId)
  );
  if (body.mapSearchMode === "google_places" && !mapProviderIds.includes("google_places")) {
    throw new ProspectSuperSearchError(
      409,
      "SUPER_SEARCH_MAP_PROVIDER_REQUIRED",
      "地图企业搜索已开启，请先配置并选择 Google Places"
    );
  }
  if (body.mapSearchMode === "off" && mapProviderIds.length) {
    throw new ProspectSuperSearchError(
      409,
      "SUPER_SEARCH_MAP_PROVIDER_NOT_ALLOWED",
      "地图企业搜索未开启，请关闭地图来源或开启地图企业搜索"
    );
  }
  const aiDiscoveryProviderIds = aiDiscoveryProviderIdsFromIds(
    input.store,
    strategy.providerPlan.map((item) => item.providerId)
  );
  if (body.aiDiscoveryMode === "model" && !aiDiscoveryProviderIds.includes("ai_search")) {
    throw new ProspectSuperSearchError(
      409,
      "SUPER_SEARCH_AI_DISCOVERY_PROVIDER_REQUIRED",
      "AI 深度发现已开启，请先配置并选择 AI 搜索来源"
    );
  }
  if (body.aiDiscoveryMode === "off" && aiDiscoveryProviderIds.length) {
    throw new ProspectSuperSearchError(
      409,
      "SUPER_SEARCH_AI_DISCOVERY_PROVIDER_NOT_ALLOWED",
      "AI 深度发现未开启，请关闭 AI 搜索来源或开启 AI 深度发现"
    );
  }
  const existing = input.store.prospectSuperSearchMissions.find((item) =>
    item.strategyId === strategy.id && activeMissionStatuses.has(item.status)
  );
  if (existing) {
    throw new ProspectSuperSearchError(409, "SUPER_SEARCH_ALREADY_ACTIVE", "该策略已有进行中的超级搜索任务");
  }
  const now = new Date();
  const mission: ProspectSuperSearchMission = {
    id: `pssm_${randomUUID()}`,
    teamId: strategy.teamId,
    ownerId: strategy.ownerId,
    campaignId: strategy.campaignId,
    strategyId: strategy.id,
    status: "queued",
    targetCandidateCount: body.targetCandidateCount,
    maxDurationMinutes: body.maxDurationMinutes,
    depth: body.depth,
    maxRounds: depthRounds[body.depth],
    costLimit: body.costLimit,
    currency: body.currency,
    aiMode: body.aiMode,
    currentRound: 0,
    currentRunId: "",
    totalCost: 0,
    rawCount: 0,
    uniqueCount: 0,
    candidateCount: 0,
    vqaCount: 0,
    pendingCount: 0,
    filteredCount: 0,
    revision: 1,
    startedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + body.maxDurationMinutes * 60_000).toISOString(),
    stopReason: "",
    createdBy: input.user.id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  input.store.prospectSuperSearchMissions.push(mission);
  appendEvent(
    input.store,
    mission,
    "created",
    `超级搜索已创建：目标 ${mission.targetCandidateCount} 家可审查候选，最多 ${mission.maxRounds} 轮${webProviderIds.length ? `，实时 Web API ${webProviderIds.length} 个` : ""}${mapProviderIds.length ? `，地图来源 ${mapProviderIds.length} 个` : ""}${aiDiscoveryProviderIds.length ? "，AI 深度发现已启用" : ""}`
  );
  await input.store.persist();
  try {
    const run = await startRound(input.store, mission, input.onRunCreated);
    return { ...superSearchDetail(input.store, input.user, mission), run };
  } catch (error) {
    finishMission(input.store, mission, "failed", error instanceof Error ? error.message : "首轮搜索启动失败");
    await input.store.persist();
    throw error;
  }
}

export function listProspectSuperSearches(store: CrmStore, user: SessionUser, limit = 30) {
  const missions = store.prospectSuperSearchMissions
    .filter((item) => visibleTo(user, item))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.min(100, Math.max(1, limit)))
    .map((item) => {
      const liveMission = { ...item, ...liveMissionCounts(store, item) };
      return {
      ...liveMission,
      ...missionSearchModes(store, item),
      rounds: missionRounds(store, item.id).map((round) =>
        liveRoundSnapshot(store, item, round)
      ),
      acceptance: superSearchAcceptance(store, liveMission)
    };});
  return { missions, total: missions.length };
}

function superSearchAcceptance(
  store: CrmStore,
  mission: ProspectSuperSearchMission
) {
  const rounds = missionRounds(store, mission.id);
  const cells = rounds.flatMap((item) => item.queryCells || []);
  const failedSources = cells.filter((item) => item.status === "failed");
  const skippedSources = cells.filter((item) => item.status === "cancelled");
  const completedSources = cells.filter((item) =>
    ["succeeded", "succeeded_empty", "partial_success"].includes(item.status)
  );
  const terminal = ["cancelled", "succeeded", "partial_success", "failed"]
    .includes(mission.status);
  const reviewReadyCount = mission.reviewReadyCount || 0;
  const vqaCount = mission.vqaCount || 0;
  const outcome = !terminal ? "running"
    : mission.status === "cancelled" ? "cancelled"
      : reviewReadyCount >= mission.targetCandidateCount ? "success"
        : mission.candidateCount > 0 || completedSources.length > 0
          ? "partial_success"
          : mission.status === "failed" ? "failed" : "empty";
  const recommendedNextAction = outcome === "running"
    ? "等待当前搜索轮次完成"
    : vqaCount > 0
      ? "复核已通过 VQA 的候选并确认转线索顺序"
      : reviewReadyCount > 0
        ? "在搜客清单完成企业、ICP、渠道和可联系审批"
        : failedSources.length
          ? "检查失败来源的错误码、配额和连接状态后重试"
          : "调整目标市场、关键词或数据源后重新搜索";
  return {
    outcome,
    sourceReturnedCount: mission.rawCount,
    candidateCount: mission.candidateCount,
    reviewReadyCount,
    vqaCount,
    targetReviewReadyCount: mission.targetCandidateCount,
    sourceSuccessCount: completedSources.length,
    sourceFailureCount: failedSources.length,
    sourceSkippedCount: skippedSources.length,
    totalCost: mission.totalCost,
    currency: mission.currency,
    costIntegrityStatus: rounds.some((item) =>
      item.costIntegrityStatus === "currency_mismatch"
    ) ? "currency_mismatch"
      : rounds.some((item) => item.costIntegrityStatus === "unknown")
        ? "unknown" : "complete",
    stopReason: mission.stopReason,
    recommendedNextAction,
    failedSources: failedSources.map((item) => ({
      providerId: item.providerId,
      errorCode: item.errorCode || "PROVIDER_EXECUTION_FAILED",
      errorMessage: item.errorMessage || "来源执行失败"
    }))
  };
}

export function superSearchDetail(store: CrmStore, user: SessionUser, missionInput: string | ProspectSuperSearchMission) {
  const mission = typeof missionInput === "string" ? findVisibleMission(store, user, missionInput) : missionInput;
  if (!visibleTo(user, mission)) throw new ProspectSuperSearchError(404, "SUPER_SEARCH_NOT_FOUND", "超级搜索任务不存在或无权访问");
  const run = mission.currentRunId ? store.prospectSearchRuns.find((item) => item.id === mission.currentRunId) : undefined;
  const liveMission = { ...mission, ...liveMissionCounts(store, mission) };
  return {
    mission: { ...liveMission, ...missionSearchModes(store, mission) },
    rounds: missionRounds(store, mission.id).map((round) =>
      liveRoundSnapshot(store, mission, round)
    ),
    events: missionEvents(store, mission.id),
    currentRun: run || null,
    currentDiagnostics: run ? prospectRunDiagnostics(store, run) : null,
    acceptance: superSearchAcceptance(store, liveMission)
  };
}

export async function transitionProspectSuperSearch(input: {
  store: CrmStore;
  user: SessionUser;
  missionId: string;
  ifMatch?: string;
  action: "pause" | "resume" | "cancel";
  reason?: string;
  onRunChanged?: () => void | Promise<void>;
}) {
  const mission = findVisibleMission(input.store, input.user, input.missionId);
  assertMissionEtag(mission, input.ifMatch);
  const run = input.store.prospectSearchRuns.find((item) => item.id === mission.currentRunId && item.teamId === mission.teamId);
  if (!run) throw new ProspectSuperSearchError(409, "SUPER_SEARCH_RUN_MISSING", "当前搜索轮次不存在");
  if (input.action === "pause") {
    if (!activeMissionStatuses.has(mission.status)) throw new ProspectSuperSearchError(409, "SUPER_SEARCH_STATE_INVALID", "当前任务不能暂停");
    if (["queued", "running", "retry_scheduled"].includes(run.status)) {
      await transitionProspectRun({ store: input.store, user: input.user, runId: run.id, ifMatch: prospectRunEtag(run), action: "pause", body: { reason: input.reason || "用户暂停超级搜索" }, requestId: `super-search:${mission.id}:pause:${mission.revision}` });
    }
    mission.status = "paused";
    mission.revision += 1;
    mission.updatedAt = new Date().toISOString();
    appendEvent(input.store, mission, "paused", input.reason || "用户暂停超级搜索");
  } else if (input.action === "resume") {
    if (mission.status !== "paused") throw new ProspectSuperSearchError(409, "SUPER_SEARCH_STATE_INVALID", "当前任务不能恢复");
    if (run.status === "paused") {
      await transitionProspectRun({ store: input.store, user: input.user, runId: run.id, ifMatch: prospectRunEtag(run), action: "resume", body: { reason: input.reason || "用户恢复超级搜索" }, requestId: `super-search:${mission.id}:resume:${mission.revision}` });
    }
    mission.status = "running";
    mission.revision += 1;
    mission.updatedAt = new Date().toISOString();
    appendEvent(input.store, mission, "resumed", input.reason || "用户恢复超级搜索");
  } else {
    if (!["queued", "running", "paused"].includes(mission.status)) throw new ProspectSuperSearchError(409, "SUPER_SEARCH_STATE_INVALID", "当前任务不能取消");
    if (!terminalRunStatuses.has(run.status)) {
      await transitionProspectRun({ store: input.store, user: input.user, runId: run.id, ifMatch: prospectRunEtag(run), action: "cancel", body: { reason: input.reason || "用户取消超级搜索" }, requestId: `super-search:${mission.id}:cancel:${mission.revision}` });
    }
    finishMission(input.store, mission, "cancelled", input.reason || "用户取消超级搜索");
  }
  await input.store.persist();
  await input.onRunChanged?.();
  return superSearchDetail(input.store, input.user, mission);
}

export class ProspectSuperSearchRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly store: CrmStore,
    private readonly options: { pollMs?: number; onRunCreated?: () => void | Promise<void> } = {}
  ) {}

  async start() {
    if (this.timer) return;
    await this.tick();
    this.timer = setInterval(() => void this.tick(), Math.max(500, this.options.pollMs || 5_000));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.store.readBarrier();
      for (const mission of this.store.prospectSuperSearchMissions.filter((item) => activeMissionStatuses.has(item.status))) {
        const run = this.store.prospectSearchRuns.find((item) => item.id === mission.currentRunId && item.teamId === mission.teamId);
        if (!run || !terminalRunStatuses.has(run.status)) continue;
        const round = completeRound(this.store, mission, run);
        const stopReason = prospectSuperSearchConvergenceReason(this.store, mission);
        if (run.status === "cancelled") {
          finishMission(this.store, mission, "cancelled", "当前轮次已取消");
        } else if (stopReason) {
          if (round && round.decision === "pending") {
            round.decision = stopReason.includes("收敛") ? "converged" : "limit_reached";
            round.decisionReason = stopReason;
          }
          finishMission(
            this.store,
            mission,
            (mission.reviewReadyCount || 0) >= mission.targetCandidateCount
              ? "succeeded"
              : mission.candidateCount
                ? "partial_success"
                : run.status === "failed" ? "failed" : "partial_success",
            stopReason
          );
        } else {
          if (round && round.decision === "pending") {
            round.decision = "continue";
            round.decisionReason = "仍有覆盖空间，继续下一轮";
          }
          await this.store.persist();
          try {
            await startRound(this.store, mission, this.options.onRunCreated);
          } catch (error) {
            finishMission(
              this.store,
              mission,
              "failed",
              error instanceof Error ? error.message : "下一轮搜索启动失败"
            );
            await this.store.persist();
          }
          continue;
        }
        await this.store.persist();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "test") console.error("[super-search]", error);
    } finally {
      this.ticking = false;
    }
  }
}
