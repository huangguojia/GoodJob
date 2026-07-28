import {
  currentContactabilityDecision,
  prospectCandidateQualificationStageCurrent
} from "./prospect-qualification.js";
import { ensureProspectVerificationReport } from "./prospect-verification.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectScoreComponent,
  ProspectScorecard,
  WebsiteOpportunity
} from "./types.js";

export const PROSPECT_SCORECARD_VERSION = "prospect-scorecard-v1";

function latest<T extends { createdAt: string }>(rows: T[]) {
  return rows.reduce<T | undefined>((latestRow, current) =>
    !latestRow || current.createdAt >= latestRow.createdAt
      ? current
      : latestRow,
  undefined);
}

function component(
  score: number,
  status: ProspectScoreComponent["status"],
  reasonCodes: string[],
  evidenceRefs: string[] = []
): ProspectScoreComponent {
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    status,
    reasonCodes: [...new Set(reasonCodes)],
    evidenceRefs: [...new Set(evidenceRefs.filter(Boolean))]
  };
}

function enterpriseScore(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  generatedAt: string
) {
  const prospectId = candidate.tenantProspectId || "";
  const snapshot = prospectId
    ? latest(store.companyVerificationSnapshots.filter((item) =>
        item.teamId === candidate.teamId
        && item.prospectId === prospectId
      ))
    : undefined;
  if (snapshot && !prospectCandidateQualificationStageCurrent(
    store,
    candidate,
    "company"
  )) {
    return component(20, "unverified", ["CANDIDATE_IDENTITY_CHANGED"], [
      snapshot.id
    ]);
  }
  if (snapshot) {
    if (snapshot.validUntil && snapshot.validUntil < generatedAt) {
      return component(30, "unverified", ["COMPANY_VERIFICATION_EXPIRED"], [snapshot.id]);
    }
    if (snapshot.status === "verified_active") {
      return component(100, "verified", snapshot.reasonCodes, [snapshot.id]);
    }
    if (snapshot.status === "partially_verified") {
      return snapshot.reviewStatus === "approved"
        ? component(85, "verified", ["PARTIAL_COMPANY_VERIFICATION_APPROVED"], [snapshot.id])
        : component(65, "partial", ["COMPANY_REVIEW_REQUIRED"], [snapshot.id]);
    }
    if (snapshot.status === "verified_inactive") {
      return component(0, "blocked", ["COMPANY_INACTIVE"], [snapshot.id]);
    }
    if (snapshot.status === "conflicting") {
      return component(15, "blocked", ["COMPANY_IDENTITY_CONFLICT"], [snapshot.id]);
    }
    return component(25, "unverified", ["COMPANY_UNVERIFIED"], [snapshot.id]);
  }

  const report = ensureProspectVerificationReport(candidate).verificationReport;
  const identityPassed = report?.checks.some((item) =>
    item.code === "enterprise_identity" && item.status === "passed"
  );
  const multiSourcePassed = report?.checks.some((item) =>
    item.code === "multi_source_consistency" && item.status === "passed"
  );
  if (identityPassed && multiSourcePassed) {
    return component(85, "verified", ["OFFICIAL_IDENTITY_AND_DOMAIN_CORROBORATED"]);
  }
  if (identityPassed) {
    return component(70, "partial", ["OFFICIAL_IDENTITY_FOUND", "DOMAIN_CORROBORATION_REQUIRED"]);
  }
  if (report?.level === "L4" || report?.level === "L5") {
    return component(55, "partial", ["HUMAN_REVIEW_WITHOUT_OFFICIAL_IDENTITY"]);
  }
  if (candidate.sourceEvidence?.length) {
    return component(25, "unverified", ["DISCOVERY_EVIDENCE_ONLY"]);
  }
  return component(0, "unverified", ["COMPANY_EVIDENCE_MISSING"]);
}

function icpScore(store: CrmStore, candidate: WebsiteOpportunity) {
  const prospectId = candidate.tenantProspectId || "";
  const assessment = prospectId
    ? latest(store.prospectIcpAssessmentSnapshots.filter((item) =>
        item.teamId === candidate.teamId
        && item.ownerId === candidate.ownerId
        && item.prospectId === prospectId
      ))
    : undefined;
  if (!assessment) {
    return component(0, "unverified", ["ICP_ASSESSMENT_MISSING"]);
  }
  if (!prospectCandidateQualificationStageCurrent(
    store,
    candidate,
    "icp"
  )) {
    return component(0, "unverified", ["CANDIDATE_ICP_INPUT_CHANGED"], [
      assessment.id
    ]);
  }
  const refs = [assessment.id, ...assessment.evidenceIds];
  if (assessment.result === "blocked" || assessment.hardGateReasonCodes.length) {
    return component(assessment.totalScore, "blocked", [
      "ICP_HARD_GATE_BLOCKED",
      ...assessment.hardGateReasonCodes
    ], refs);
  }
  if (assessment.result === "not_qualified" || assessment.reviewStatus === "rejected") {
    return component(assessment.totalScore, "blocked", ["ICP_NOT_QUALIFIED"], refs);
  }
  if (assessment.result === "qualified" && assessment.reviewStatus === "approved") {
    return component(assessment.totalScore, "verified", ["ICP_QUALIFIED_APPROVED"], refs);
  }
  return component(assessment.totalScore, "partial", ["ICP_REVIEW_REQUIRED"], refs);
}

function contactScore(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  generatedAt: string
) {
  const prospectId = candidate.tenantProspectId || "";
  if (prospectId && !prospectCandidateQualificationStageCurrent(
    store,
    candidate,
    "channel"
  )) {
    return component(0, "unverified", ["CANDIDATE_CHANNEL_CHANGED"]);
  }
  const gateCurrent = prospectCandidateQualificationStageCurrent(
    store,
    candidate,
    "contactability"
  );
  const decisions = prospectId
    ? store.prospectContactabilityDecisions.filter((item) =>
        item.teamId === candidate.teamId
        && item.ownerId === candidate.ownerId
        && item.prospectId === prospectId
      )
    : [];
  const approved = decisions
    .filter((item) => item.status === "approved_contactable")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .find((item) => {
      const current = currentContactabilityDecision(store, {
        teamId: item.teamId,
        ownerId: item.ownerId,
        prospectId: item.prospectId,
        campaignId: item.campaignId,
        campaignVersion: item.campaignVersion,
        channelId: item.channelId,
        at: generatedAt
      });
      return current?.id === item.id
        && current.status === "approved_contactable";
    });
  if (approved && gateCurrent) {
    return component(100, "verified", ["CONTACTABILITY_APPROVED"], [approved.id, approved.channelId]);
  }

  const verification = prospectId
    ? latest(store.prospectContactVerificationSnapshots.filter((item) =>
        item.teamId === candidate.teamId
        && item.ownerId === candidate.ownerId
        && item.prospectId === prospectId
      ))
    : undefined;
  if (verification) {
    if (verification.expiresAt && verification.expiresAt < generatedAt) {
      return component(30, "unverified", ["CONTACT_VERIFICATION_EXPIRED"], [verification.id]);
    }
    if (verification.status === "verified") {
      return component(80, "partial", ["HUMAN_CONTACTABILITY_APPROVAL_REQUIRED"], [verification.id]);
    }
    if (["bounced", "opted_out", "invalid"].includes(verification.status)) {
      return component(0, "blocked", [`CONTACT_${verification.status.toUpperCase()}`], [verification.id]);
    }
    if (verification.status === "domain_valid") {
      return component(55, "partial", ["CONTACT_CHANNEL_NOT_FULLY_VERIFIED"], [verification.id]);
    }
    return component(30, "unverified", ["CONTACT_CHANNEL_DISCOVERED_ONLY"], [verification.id]);
  }
  if (candidate.verifiedAt && candidate.contactInfo) {
    return component(50, "partial", ["LEGACY_HUMAN_CONTACT_REVIEW", "CHANNEL_VERIFICATION_REQUIRED"]);
  }
  return component(0, "unverified", ["VERIFIED_CONTACT_CHANNEL_MISSING"]);
}

function signalScore(candidate: WebsiteOpportunity) {
  if (candidate.outreachState === "replied") return 100;
  if (candidate.sourceEvidence?.some((item) => item.sourceLevel === "business_signal")) return 80;
  if (candidate.outreachState === "awaiting_reply") return 55;
  if (candidate.lastTouchpointAt) return 45;
  return 0;
}

function hasActiveSuppression(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  generatedAt: string
) {
  if (!candidate.tenantProspectId) return false;
  const latestByScope = new Map<string, typeof store.prospectSuppressionEvents[number]>();
  store.prospectSuppressionEvents
    .filter((item) =>
      item.teamId === candidate.teamId
      && item.prospectId === candidate.tenantProspectId
      && item.effectiveAt <= generatedAt
    )
    .forEach((item) => {
      const current = latestByScope.get(item.scopeKeyHash);
      if (!current || current.createdAt < item.createdAt) {
        latestByScope.set(item.scopeKeyHash, item);
      }
    });
  return [...latestByScope.values()].some((item) =>
    item.action === "imposed"
    && (!item.expiresAt || item.expiresAt >= generatedAt)
  );
}

export function buildProspectScorecard(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  generatedAt = new Date().toISOString()
): ProspectScorecard {
  const enterpriseConfidence = enterpriseScore(store, candidate, generatedAt);
  const icpMatch = icpScore(store, candidate);
  const formalProspect = candidate.tenantProspectId
    ? store.tenantProspects.find((item) =>
        item.id === candidate.tenantProspectId
        && item.teamId === candidate.teamId
      )
    : undefined;
  const complianceBlocked = candidate.status === "excluded"
    || candidate.outreachState === "suppressed"
    || Boolean(formalProspect && (
      formalProspect.status === "do_not_contact"
      || formalProspect.queueState === "suppressed"
      || formalProspect.exclusionMode !== "none"
    ))
    || hasActiveSuppression(store, candidate, generatedAt);
  const contactReadiness = complianceBlocked
    ? component(0, "blocked", ["COMPLIANCE_BLOCKED"])
    : contactScore(store, candidate, generatedAt);
  const purchaseSignal = signalScore(candidate);
  const actionPriority = component(
    enterpriseConfidence.score * 0.25
      + icpMatch.score * 0.35
      + contactReadiness.score * 0.25
      + purchaseSignal * 0.15,
    enterpriseConfidence.status === "blocked"
      || icpMatch.status === "blocked"
      || contactReadiness.status === "blocked"
      || complianceBlocked
      ? "blocked"
      : [enterpriseConfidence, icpMatch, contactReadiness]
          .every((item) => item.status === "verified")
        ? "verified"
        : "partial",
    [
      ...(purchaseSignal ? ["PURCHASE_OR_ENGAGEMENT_SIGNAL_FOUND"] : ["PURCHASE_SIGNAL_MISSING"]),
      ...(complianceBlocked ? ["COMPLIANCE_BLOCKED"] : [])
    ]
  );
  const vqaReasonCodes = [
    ...(!candidate.tenantProspectId || !candidate.organizationId
      ? ["RESOLVED_ORGANIZATION_MISSING"]
      : []),
    ...(enterpriseConfidence.status !== "verified"
      ? ["ENTERPRISE_VERIFICATION_NOT_PASSED"]
      : []),
    ...(icpMatch.status !== "verified" || icpMatch.score < 70
      ? ["ICP_GATE_NOT_PASSED"]
      : []),
    ...(contactReadiness.status !== "verified"
      ? ["CONTACTABILITY_GATE_NOT_PASSED"]
      : []),
    ...(complianceBlocked
      ? ["COMPLIANCE_BLOCKED"]
      : [])
  ];
  return {
    version: PROSPECT_SCORECARD_VERSION,
    generatedAt,
    enterpriseConfidence,
    icpMatch,
    contactReadiness,
    actionPriority,
    vqa: {
      qualified: vqaReasonCodes.length === 0,
      reasonCodes: vqaReasonCodes
    }
  };
}

export function refreshProspectScorecard(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  generatedAt = new Date().toISOString()
) {
  candidate.scorecard = buildProspectScorecard(store, candidate, generatedAt);
  return candidate;
}

export function isProspectReviewReady(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  generatedAt = new Date().toISOString()
) {
  if (!candidate.tenantProspectId
    || !candidate.organizationId
    || candidate.status === "excluded") return false;
  const prospect = store.tenantProspects.find((item) =>
    item.id === candidate.tenantProspectId
    && item.teamId === candidate.teamId
    && item.organizationId === candidate.organizationId
  );
  if (!prospect
    || prospect.status !== "active"
    || prospect.exclusionMode !== "none"
    || prospect.queueState === "suppressed") return false;
  const scorecard = buildProspectScorecard(store, candidate, generatedAt);
  const verifiedChannelAwaitingApproval =
    scorecard.contactReadiness.status === "partial"
    && scorecard.contactReadiness.reasonCodes.length === 1
    && scorecard.contactReadiness.reasonCodes[0]
      === "HUMAN_CONTACTABILITY_APPROVAL_REQUIRED";
  return scorecard.enterpriseConfidence.status === "verified"
    && scorecard.icpMatch.status === "verified"
    && scorecard.icpMatch.score >= 70
    && (scorecard.contactReadiness.status === "verified"
      || verifiedChannelAwaitingApproval);
}

export function prospectCandidateQualificationCounts(
  store: CrmStore,
  input: {
    teamId: string;
    ownerId: string;
    candidateIds: ReadonlySet<string>;
    generatedAt?: string;
  }
) {
  let reviewReadyCount = 0;
  let vqaCount = 0;
  for (const candidate of store.websiteOpportunities) {
    if (candidate.teamId !== input.teamId
      || candidate.ownerId !== input.ownerId
      || !input.candidateIds.has(candidate.id)) continue;
    const scorecard = buildProspectScorecard(
      store,
      candidate,
      input.generatedAt
    );
    if (isProspectReviewReady(store, candidate, input.generatedAt)) {
      reviewReadyCount += 1;
    }
    if (scorecard.vqa.qualified) vqaCount += 1;
  }
  return { reviewReadyCount, vqaCount };
}
