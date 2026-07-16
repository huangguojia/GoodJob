import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { CrmStore } from "./store.js";
import type {
  AcquisitionOutcome,
  AcquisitionOutcomeFeedback,
  Deal,
  ProspectCoverageEvent,
  ProspectStrategySuggestion,
  ProspectStrategySuggestionStatus,
  ProspectStrategySuggestionType,
  WebsiteOpportunity
} from "./types.js";

const VALID_REPLY_CLASSIFICATIONS = new Set([
  "clear_demand",
  "interested_nurture",
  "referral"
]);

function sha256(value: unknown) {
  return createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");
}

function compareDateDesc(left: { createdAt: string }, right: { createdAt: string }) {
  return right.createdAt.localeCompare(left.createdAt);
}

function latestCoverageEvent(
  store: CrmStore,
  scope: { teamId: string; ownerId: string },
  prospectId: string
) {
  return store.prospectCoverageEvents
    .filter((item) =>
      item.teamId === scope.teamId
      && item.ownerId === scope.ownerId
      && item.prospectId === prospectId
      && Boolean(item.campaignId)
      && Boolean(item.strategyId)
    )
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
      || right.sequence - left.sequence
    )[0];
}

function providerCodesForCoverageEvent(
  store: CrmStore,
  event: ProspectCoverageEvent | undefined
) {
  if (!event?.sourceHitId) return [];
  const hit = store.prospectSourceRawHits.find((item) =>
    item.id === event.sourceHitId
    && item.teamId === event.teamId
    && item.ownerId === event.ownerId
  );
  if (!hit) return [];
  const batch = store.prospectSourceRawBatches.find((item) =>
    item.id === hit.batchId
    && item.teamId === event.teamId
    && item.ownerId === event.ownerId
  );
  return batch?.providerCode ? [batch.providerCode] : [];
}

function resolveAcquisitionLink(store: CrmStore, deal: Deal) {
  const recommendation = store.dealRecommendations.find((item) =>
    item.teamId === deal.teamId
    && item.ownerId === deal.ownerId
    && item.linkedDealId === deal.id
  );
  const linkedCandidate = store.websiteOpportunities.find((item) =>
    item.teamId === deal.teamId
    && item.ownerId === deal.ownerId
    && item.dealId === deal.id
  );
  const linkedProspect = store.tenantProspects.find((item) =>
    item.teamId === deal.teamId
    && item.dealId === deal.id
  );
  const candidate = recommendation
    ? store.websiteOpportunities.find((item) =>
      item.id === recommendation.prospectCandidateId
      && item.teamId === deal.teamId
      && item.ownerId === deal.ownerId
    )
    : linkedCandidate
      || store.websiteOpportunities.find((item) =>
        item.teamId === deal.teamId
        && item.ownerId === deal.ownerId
        && item.tenantProspectId === linkedProspect?.id
      );
  const tenantProspect = linkedProspect
    || store.tenantProspects.find((item) =>
      item.teamId === deal.teamId
      && item.id === (recommendation?.tenantProspectId || candidate?.tenantProspectId)
    );
  if (!recommendation && !linkedCandidate && !linkedProspect) return undefined;
  return { recommendation, candidate, tenantProspect };
}

export function recordAcquisitionOutcomeFeedback(
  store: CrmStore,
  input: {
    deal: Deal;
    outcome: AcquisitionOutcome;
    reasonCategory?: string;
    reason: string;
    closedAt?: string;
  }
) {
  const existing = store.acquisitionOutcomeFeedback.find((item) =>
    item.teamId === input.deal.teamId
    && item.ownerId === input.deal.ownerId
    && item.dealId === input.deal.id
  );
  if (existing) return { feedback: existing, created: false };

  const link = resolveAcquisitionLink(store, input.deal);
  if (!link) return { feedback: undefined, created: false };

  const prospectId = link.tenantProspect?.id
    || link.recommendation?.tenantProspectId
    || link.candidate?.tenantProspectId
    || "";
  const coverage = prospectId
    ? latestCoverageEvent(store, input.deal, prospectId)
    : undefined;
  const run = coverage
    ? store.prospectSearchRuns.find((item) =>
      item.id === coverage.runId
      && item.teamId === input.deal.teamId
      && item.ownerId === input.deal.ownerId
    )
    : undefined;
  const assessment = prospectId
    ? store.prospectIcpAssessmentSnapshots
      .filter((item) =>
        item.teamId === input.deal.teamId
        && item.ownerId === input.deal.ownerId
        && item.prospectId === prospectId
        && (!coverage?.campaignId || item.campaignId === coverage.campaignId)
      )
      .sort(compareDateDesc)[0]
    : undefined;
  const providerCodes = providerCodesForCoverageEvent(store, coverage);
  const attributionReasonCodes = [
    link.recommendation ? "linked_deal_recommendation" : "",
    link.candidate ? "linked_website_opportunity" : "",
    link.tenantProspect ? "linked_tenant_prospect" : "",
    coverage ? "coverage_context_resolved" : "coverage_context_missing",
    providerCodes.length ? "provider_resolved" : "provider_missing",
    assessment ? "icp_assessment_resolved" : "icp_assessment_missing"
  ].filter(Boolean);
  const closedAt = input.closedAt || input.deal.closedAt || new Date().toISOString();
  const values = {
    teamId: input.deal.teamId,
    ownerId: input.deal.ownerId,
    dealId: input.deal.id,
    customerId: input.deal.customerId,
    leadId: link.recommendation?.leadId
      || link.candidate?.leadId
      || link.tenantProspect?.leadId
      || "",
    prospectCandidateId: link.recommendation?.prospectCandidateId
      || link.candidate?.id
      || "",
    tenantProspectId: prospectId,
    organizationId: link.recommendation?.organizationId
      || link.candidate?.organizationId
      || link.tenantProspect?.organizationId
      || "",
    campaignId: coverage?.campaignId || "",
    campaignVersion: run?.campaignVersion || assessment?.campaignVersion || 0,
    strategyId: coverage?.strategyId || "",
    runId: coverage?.runId || "",
    providerCodes,
    icpAssessmentId: assessment?.id || "",
    icpPolicyId: assessment?.policyId || "",
    outcome: input.outcome,
    amount: Number(input.deal.amount || 0),
    currency: input.deal.currency || "USD",
    reasonCategory: input.reasonCategory?.trim() || "",
    reason: input.reason.trim(),
    closedAt,
    attributionConfidence: coverage
      ? (providerCodes.length ? 100 : 85)
      : 65,
    attributionReasonCodes
  };
  const payloadHash = sha256(values);
  const feedback: AcquisitionOutcomeFeedback = {
    id: `aof_${payloadHash.slice(0, 28)}`,
    ...values,
    payloadHash,
    createdAt: closedAt
  };
  store.acquisitionOutcomeFeedback.unshift(feedback);
  return { feedback, created: true };
}

function acquisitionDealIds(
  store: CrmStore,
  scope: { teamId: string; ownerId: string },
  candidates: WebsiteOpportunity[]
) {
  const ids = new Set<string>();
  for (const item of candidates) {
    if (item.dealId) ids.add(item.dealId);
  }
  for (const item of store.dealRecommendations) {
    if (item.teamId === scope.teamId
      && item.ownerId === scope.ownerId
      && item.linkedDealId) {
      ids.add(item.linkedDealId);
    }
  }
  const prospectIds = new Set(
    candidates.map((item) => item.tenantProspectId).filter(Boolean)
  );
  for (const item of store.tenantProspects) {
    if (item.teamId === scope.teamId
      && prospectIds.has(item.id)
      && item.dealId) {
      ids.add(item.dealId);
    }
  }
  return new Set([...ids].filter((id) =>
    store.deals.some((deal) =>
      deal.id === id
      && deal.teamId === scope.teamId
      && deal.ownerId === scope.ownerId
    )
  ));
}

function candidateCampaignContext(
  store: CrmStore,
  scope: { teamId: string; ownerId: string },
  candidate: WebsiteOpportunity
) {
  if (!candidate.tenantProspectId) return undefined;
  const event = latestCoverageEvent(store, scope, candidate.tenantProspectId);
  if (!event) return undefined;
  const run = store.prospectSearchRuns.find((item) =>
    item.id === event.runId
    && item.teamId === scope.teamId
    && item.ownerId === scope.ownerId
  );
  return {
    campaignId: event.campaignId,
    campaignVersion: run?.campaignVersion || 0,
    strategyId: event.strategyId,
    runId: event.runId
  };
}

function revenueRows(feedback: AcquisitionOutcomeFeedback[]) {
  const amounts = new Map<string, number>();
  for (const item of feedback) {
    if (item.outcome !== "won") continue;
    amounts.set(item.currency, (amounts.get(item.currency) || 0) + item.amount);
  }
  return [...amounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({
      currency,
      amount: Math.round(amount * 100) / 100
    }));
}

export function prospectPerformance(
  store: CrmStore,
  scope: { teamId: string; ownerId: string }
) {
  const candidates = store.websiteOpportunities.filter((item) =>
    item.teamId === scope.teamId && item.ownerId === scope.ownerId
  );
  const candidateIds = new Set(candidates.map((item) => item.id));
  const touchpoints = store.prospectTouchpoints.filter((item) =>
    item.teamId === scope.teamId
    && item.ownerId === scope.ownerId
    && candidateIds.has(item.prospectCandidateId)
  );
  const contactedIds = new Set(
    touchpoints
      .filter((item) => item.direction === "outbound")
      .map((item) => item.prospectCandidateId)
  );
  const validReplyIds = new Set(
    touchpoints
      .filter((item) =>
        item.direction === "inbound"
        && VALID_REPLY_CLASSIFICATIONS.has(item.replyClassification || "")
      )
      .map((item) => item.prospectCandidateId)
  );
  const leadIds = new Set(candidates.map((item) => item.leadId).filter(Boolean));
  const customerIds = new Set(candidates.map((item) => item.customerId).filter(Boolean));
  for (const item of store.tenantProspects) {
    if (item.teamId !== scope.teamId) continue;
    if (!candidates.some((candidate) => candidate.tenantProspectId === item.id)) continue;
    if (item.leadId) leadIds.add(item.leadId);
    if (item.customerId) customerIds.add(item.customerId);
  }
  const dealIds = acquisitionDealIds(store, scope, candidates);
  const feedback = store.acquisitionOutcomeFeedback.filter((item) =>
    item.teamId === scope.teamId && item.ownerId === scope.ownerId
  );
  const pendingSuggestions = store.prospectStrategySuggestions.filter((item) =>
    item.teamId === scope.teamId
    && item.ownerId === scope.ownerId
    && item.status === "pending"
  ).length;

  const campaignMap = new Map<string, {
    campaignId: string;
    campaignVersion: number;
    strategyId: string;
    candidates: number;
    contacted: number;
    validReplies: number;
    deals: number;
    won: number;
    lost: number;
  }>();
  for (const candidate of candidates) {
    const context = candidateCampaignContext(store, scope, candidate);
    if (!context) continue;
    const key = `${context.campaignId}\u0000${context.strategyId}`;
    const row = campaignMap.get(key) || {
      campaignId: context.campaignId,
      campaignVersion: context.campaignVersion,
      strategyId: context.strategyId,
      candidates: 0,
      contacted: 0,
      validReplies: 0,
      deals: 0,
      won: 0,
      lost: 0
    };
    row.candidates += 1;
    if (contactedIds.has(candidate.id)) row.contacted += 1;
    if (validReplyIds.has(candidate.id)) row.validReplies += 1;
    campaignMap.set(key, row);
  }
  for (const item of feedback) {
    if (!item.campaignId || !item.strategyId) continue;
    const key = `${item.campaignId}\u0000${item.strategyId}`;
    const row = campaignMap.get(key) || {
      campaignId: item.campaignId,
      campaignVersion: item.campaignVersion,
      strategyId: item.strategyId,
      candidates: 0,
      contacted: 0,
      validReplies: 0,
      deals: 0,
      won: 0,
      lost: 0
    };
    row.deals += 1;
    row[item.outcome] += 1;
    campaignMap.set(key, row);
  }

  const providerMap = new Map<string, {
    providerCode: string;
    outcomes: number;
    won: number;
    lost: number;
    wonRevenue: Array<{ currency: string; amount: number }>;
  }>();
  for (const item of feedback) {
    for (const providerCode of item.providerCodes) {
      const providerFeedback = feedback.filter((entry) =>
        entry.providerCodes.includes(providerCode)
      );
      providerMap.set(providerCode, {
        providerCode,
        outcomes: providerFeedback.length,
        won: providerFeedback.filter((entry) => entry.outcome === "won").length,
        lost: providerFeedback.filter((entry) => entry.outcome === "lost").length,
        wonRevenue: revenueRows(providerFeedback)
      });
    }
  }

  return {
    scope,
    metrics: {
      candidates: candidates.length,
      contacted: contactedIds.size,
      validReplies: validReplyIds.size,
      validReplyRate: contactedIds.size
        ? Math.round((validReplyIds.size / contactedIds.size) * 1000) / 10
        : 0,
      leads: leadIds.size,
      customers: customerIds.size,
      deals: dealIds.size,
      won: feedback.filter((item) => item.outcome === "won").length,
      lost: feedback.filter((item) => item.outcome === "lost").length,
      wonRevenue: revenueRows(feedback),
      pendingSuggestions
    },
    campaignBreakdown: [...campaignMap.values()].sort((left, right) =>
      right.candidates - left.candidates
      || left.campaignId.localeCompare(right.campaignId)
    ),
    providerBreakdown: [...providerMap.values()].sort((left, right) =>
      right.outcomes - left.outcomes
      || left.providerCode.localeCompare(right.providerCode)
    )
  };
}

function sampleRange(dates: string[]) {
  const values = dates.filter(Boolean).sort();
  return {
    sampleFrom: values[0] || "",
    sampleTo: values[values.length - 1] || ""
  };
}

function insertSuggestion(
  store: CrmStore,
  input: Omit<
    ProspectStrategySuggestion,
    "id" | "payloadHash" | "status" | "reviewedBy" | "reviewedAt"
      | "reviewNote" | "createdAt" | "updatedAt"
  >,
  now: string
) {
  const payloadHash = sha256(input);
  const existing = store.prospectStrategySuggestions.find((item) =>
    item.teamId === input.teamId
    && item.ownerId === input.ownerId
    && item.payloadHash === payloadHash
  );
  if (existing) return undefined;
  const suggestion: ProspectStrategySuggestion = {
    id: `pss_${payloadHash.slice(0, 28)}`,
    ...input,
    payloadHash,
    status: "pending",
    reviewedBy: "",
    reviewedAt: "",
    reviewNote: "",
    createdAt: now,
    updatedAt: now
  };
  store.prospectStrategySuggestions.unshift(suggestion);
  return suggestion;
}

function suggestionInput(
  scope: { teamId: string; ownerId: string },
  context: {
    campaignId: string;
    campaignVersion: number;
    strategyId: string;
  },
  suggestionType: ProspectStrategySuggestionType,
  sampleMetrics: Record<string, unknown>,
  proposedAdjustments: Record<string, unknown>,
  rationale: string,
  reasonCodes: string[],
  range: { sampleFrom: string; sampleTo: string }
) {
  return {
    ...scope,
    ...context,
    suggestionType,
    sampleMetrics,
    proposedAdjustments,
    rationale,
    reasonCodes,
    ...range
  };
}

export function generateProspectStrategySuggestions(
  store: CrmStore,
  scope: { teamId: string; ownerId: string },
  now = new Date().toISOString()
) {
  const performance = prospectPerformance(store, scope);
  const candidates = store.websiteOpportunities.filter((item) =>
    item.teamId === scope.teamId && item.ownerId === scope.ownerId
  );
  const candidateIds = new Set(candidates.map((item) => item.id));
  const touchpoints = store.prospectTouchpoints.filter((item) =>
    item.teamId === scope.teamId
    && item.ownerId === scope.ownerId
    && candidateIds.has(item.prospectCandidateId)
  );
  const contactedIds = new Set(
    touchpoints.filter((item) => item.direction === "outbound")
      .map((item) => item.prospectCandidateId)
  );
  const validReplyIds = new Set(
    touchpoints.filter((item) =>
      item.direction === "inbound"
      && VALID_REPLY_CLASSIFICATIONS.has(item.replyClassification || "")
    ).map((item) => item.prospectCandidateId)
  );
  const created: ProspectStrategySuggestion[] = [];

  for (const group of performance.campaignBreakdown) {
    if (group.candidates < 10 || group.contacted < 5) continue;
    const replyRate = group.validReplies / group.contacted;
    if (replyRate >= 0.1) continue;
    const groupCandidates = candidates.filter((candidate) => {
      const context = candidateCampaignContext(store, scope, candidate);
      return context?.campaignId === group.campaignId
        && context.strategyId === group.strategyId;
    });
    const range = sampleRange([
      ...groupCandidates.map((item) => item.createdAt),
      ...touchpoints
        .filter((item) => groupCandidates.some((candidate) =>
          candidate.id === item.prospectCandidateId
        ))
        .map((item) => item.occurredAt)
    ]);
    const suggestion = insertSuggestion(store, suggestionInput(
      scope,
      group,
      "refine_targeting_keywords",
      {
        candidates: group.candidates,
        contacted: group.contacted,
        validReplies: group.validReplies,
        validReplyRate: Math.round(replyRate * 1000) / 10
      },
      {
        action: "review_keywords_and_exclusions",
        keepManualApproval: true
      },
      "已有足够触达样本，但有效回复率偏低，建议人工检查关键词、客户类型和排除条件。",
      ["minimum_reply_sample_met", "valid_reply_rate_below_10_percent"],
      range
    ), now);
    if (suggestion) created.push(suggestion);
  }

  const feedback = store.acquisitionOutcomeFeedback.filter((item) =>
    item.teamId === scope.teamId
    && item.ownerId === scope.ownerId
    && item.campaignId
    && item.strategyId
  );
  const outcomeGroups = new Map<string, AcquisitionOutcomeFeedback[]>();
  for (const item of feedback) {
    const key = `${item.campaignId}\u0000${item.strategyId}`;
    outcomeGroups.set(key, [...(outcomeGroups.get(key) || []), item]);
  }
  for (const outcomes of outcomeGroups.values()) {
    const first = outcomes[0]!;
    const context = {
      campaignId: first.campaignId,
      campaignVersion: Math.max(...outcomes.map((item) => item.campaignVersion)),
      strategyId: first.strategyId
    };
    const range = sampleRange(outcomes.map((item) => item.closedAt));
    const providerRows = new Map<string, AcquisitionOutcomeFeedback[]>();
    for (const item of outcomes) {
      for (const providerCode of item.providerCodes) {
        providerRows.set(
          providerCode,
          [...(providerRows.get(providerCode) || []), item]
        );
      }
    }
    const comparableProviders = [...providerRows.entries()]
      .filter(([, rows]) => rows.length >= 2)
      .map(([providerCode, rows]) => ({
        providerCode,
        outcomes: rows.length,
        won: rows.filter((item) => item.outcome === "won").length,
        winRate: rows.filter((item) => item.outcome === "won").length / rows.length
      }))
      .sort((left, right) =>
        right.winRate - left.winRate
        || right.outcomes - left.outcomes
        || left.providerCode.localeCompare(right.providerCode)
      );
    if (comparableProviders.length >= 2) {
      const best = comparableProviders[0]!;
      const worst = comparableProviders[comparableProviders.length - 1]!;
      if (best.winRate - worst.winRate >= 0.25) {
        const commonMetrics = {
          bestProvider: best,
          comparedProvider: worst,
          winRateDifferencePoints:
            Math.round((best.winRate - worst.winRate) * 1000) / 10
        };
        const increase = insertSuggestion(store, suggestionInput(
          scope,
          context,
          "increase_provider_priority",
          commonMetrics,
          {
            providerCode: best.providerCode,
            direction: "increase",
            keepManualApproval: true
          },
          `${best.providerCode} 的成交率明显高于可比来源，建议人工评估提高其搜索优先级。`,
          ["provider_minimum_outcomes_met", "provider_win_rate_gap_at_least_25_points"],
          range
        ), now);
        if (increase) created.push(increase);
        const decrease = insertSuggestion(store, suggestionInput(
          scope,
          context,
          "decrease_provider_priority",
          commonMetrics,
          {
            providerCode: worst.providerCode,
            direction: "decrease",
            keepManualApproval: true
          },
          `${worst.providerCode} 的成交率明显低于可比来源，建议人工评估降低其搜索优先级。`,
          ["provider_minimum_outcomes_met", "provider_win_rate_gap_at_least_25_points"],
          range
        ), now);
        if (decrease) created.push(decrease);
      }
    }

    const lost = outcomes.filter((item) => item.outcome === "lost");
    if (outcomes.length >= 3 && lost.length >= 2) {
      const categoryCounts = new Map<string, number>();
      for (const item of lost) {
        const category = item.reasonCategory || "未分类";
        categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      }
      const dominant = [...categoryCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
      if (dominant && dominant[1] >= 2 && dominant[1] / lost.length >= 0.6) {
        const suggestion = insertSuggestion(store, suggestionInput(
          scope,
          context,
          "review_icp_exclusions",
          {
            closedDeals: outcomes.length,
            lostDeals: lost.length,
            dominantLossCategory: dominant[0],
            dominantLossCount: dominant[1]
          },
          {
            reviewLossCategory: dominant[0],
            action: "review_hard_exclusions",
            keepManualApproval: true
          },
          `丢单原因“${dominant[0]}”重复出现，建议人工检查是否应加入 ICP 排除条件。`,
          ["minimum_closed_sample_met", "dominant_loss_category_repeated"],
          range
        ), now);
        if (suggestion) created.push(suggestion);
      }
    }

    if (outcomes.length >= 3) {
      const assessed = outcomes.map((item) => ({
        outcome: item.outcome,
        assessment: store.prospectIcpAssessmentSnapshots.find((assessment) =>
          assessment.id === item.icpAssessmentId
          && assessment.teamId === scope.teamId
          && assessment.ownerId === scope.ownerId
        )
      })).filter((item) => item.assessment);
      const wonScores = assessed
        .filter((item) => item.outcome === "won")
        .map((item) => item.assessment!.totalScore);
      const lostScores = assessed
        .filter((item) => item.outcome === "lost")
        .map((item) => item.assessment!.totalScore);
      if (wonScores.length && lostScores.length && assessed.length >= 3) {
        const average = (values: number[]) =>
          values.reduce((sum, value) => sum + value, 0) / values.length;
        const wonAverage = average(wonScores);
        const lostAverage = average(lostScores);
        if (Math.abs(wonAverage - lostAverage) < 10) {
          const suggestion = insertSuggestion(store, suggestionInput(
            scope,
            context,
            "review_icp_weights",
            {
              assessedDeals: assessed.length,
              wonAverageScore: Math.round(wonAverage * 10) / 10,
              lostAverageScore: Math.round(lostAverage * 10) / 10,
              scoreGap: Math.round(Math.abs(wonAverage - lostAverage) * 10) / 10
            },
            {
              action: "review_dimension_weights",
              keepManualApproval: true
            },
            "现有 ICP 分数未能明显区分成交和丢单样本，建议人工复核各维度权重。",
            ["minimum_assessed_outcomes_met", "icp_score_separation_below_10_points"],
            range
          ), now);
          if (suggestion) created.push(suggestion);
        }
      }
    }
  }

  return created;
}

export function reviewProspectStrategySuggestion(
  store: CrmStore,
  input: {
    teamId: string;
    ownerId: string;
    suggestionId: string;
    status: Exclude<ProspectStrategySuggestionStatus, "pending">;
    note?: string;
    reviewedAt?: string;
  }
) {
  const suggestion = store.prospectStrategySuggestions.find((item) =>
    item.id === input.suggestionId
  );
  if (!suggestion
    || suggestion.teamId !== input.teamId
    || suggestion.ownerId !== input.ownerId) {
    throw new Error("无权访问该获客策略建议");
  }
  if (suggestion.status !== "pending") {
    throw new Error("该获客策略建议已经处理");
  }
  const reviewedAt = input.reviewedAt || new Date().toISOString();
  suggestion.status = input.status;
  suggestion.reviewedBy = input.ownerId;
  suggestion.reviewedAt = reviewedAt;
  suggestion.reviewNote = input.note?.trim() || "";
  suggestion.updatedAt = reviewedAt;
  return suggestion;
}
