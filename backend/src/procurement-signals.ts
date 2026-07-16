import { randomUUID } from "node:crypto";
import type { CrmStore } from "./store.js";
import type {
  Deal,
  DealRecommendation,
  ProcurementEvidenceType,
  ProcurementSignal,
  ProspectTouchpoint,
  WebsiteOpportunity
} from "./types.js";

const strongEvidence = new Set<ProcurementEvidenceType>([
  "quote_request",
  "quantity",
  "sample_request",
  "purchase_timeline",
  "target_price",
  "certification",
  "delivery",
  "project_tender",
  "manual_confirmation"
]);

const reasonLabels: Record<ProcurementEvidenceType, string> = {
  quote_request: "买方要求报价",
  product_requirement: "产品或应用明确",
  quantity: "数量或项目规模明确",
  sample_request: "存在具体样品需求",
  purchase_timeline: "采购时间表明确",
  target_price: "讨论目标价或商业条款",
  certification: "提出认证要求",
  delivery: "提出交付要求",
  project_tender: "存在具体项目或招标节点",
  manual_confirmation: "业务员确认存在真实推进机会"
};

export interface RecordProcurementSignalInput {
  candidate: WebsiteOpportunity;
  touchpoint: ProspectTouchpoint;
  actorId: string;
  evidenceSummary?: string;
  evidenceTypes?: ProcurementEvidenceType[];
  product?: string;
  specification?: string;
  quantity?: number;
  quantityType?: ProcurementSignal["quantityType"];
  targetPrice?: number;
  currency?: string;
  priceBasis?: string;
  deliveryRequirement?: string;
  certificationRequirement?: string;
  purchaseTimeline?: string;
  projectName?: string;
  buyerRole?: string;
  nextAction?: string;
  confidence?: number;
}

export interface DealRecommendationAssessment {
  eligible: boolean;
  reasonCodes: string[];
  missingFields: string[];
  duplicateDeals: Deal[];
}

function clean(value: unknown, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isoAfter(value: string, days: number) {
  return new Date(new Date(value).getTime() + days * 86400000).toISOString();
}

function dateAfter(value: string, days: number) {
  return isoAfter(value, days).slice(0, 10);
}

function normalizedProduct(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function productLooksSimilar(left: string, right: string) {
  const a = normalizedProduct(left);
  const b = normalizedProduct(right);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const tokensA = new Set(a.split(/\s+/u).filter((item) => item.length > 1));
  const tokensB = b.split(/\s+/u).filter((item) => item.length > 1);
  return tokensB.some((item) => tokensA.has(item));
}

function resolveCustomerId(store: CrmStore, signal: ProcurementSignal) {
  if (signal.customerId) return signal.customerId;
  const candidate = store.websiteOpportunities.find((item) =>
    item.id === signal.prospectCandidateId
    && item.teamId === signal.teamId
    && item.ownerId === signal.ownerId
  );
  if (candidate?.customerId) return candidate.customerId;
  const leadId = signal.leadId || candidate?.leadId;
  const lead = leadId
    ? store.leads.find((item) =>
      item.id === leadId
      && item.teamId === signal.teamId
      && item.ownerId === signal.ownerId
    )
    : undefined;
  if (lead?.convertedCustomerId) return lead.convertedCustomerId;
  const prospectId = signal.tenantProspectId || candidate?.tenantProspectId;
  return prospectId
    ? store.tenantProspects.find((item) =>
      item.id === prospectId && item.teamId === signal.teamId
    )?.customerId || ""
    : "";
}

export function resolveRecommendationCustomerId(
  store: CrmStore,
  recommendation: DealRecommendation
) {
  if (recommendation.customerId) return recommendation.customerId;
  const signal = store.procurementSignals.find((item) =>
    item.id === recommendation.signalId
    && item.teamId === recommendation.teamId
    && item.ownerId === recommendation.ownerId
  );
  return signal ? resolveCustomerId(store, signal) : "";
}

export function activeDuplicateDeals(
  store: CrmStore,
  signal: ProcurementSignal
) {
  const customerId = resolveCustomerId(store, signal);
  if (!customerId || !signal.product) return [];
  return store.deals.filter((deal) =>
    deal.teamId === signal.teamId
    && deal.ownerId === signal.ownerId
    && deal.customerId === customerId
    && !deal.archivedAt
    && deal.stage !== "成交"
    && deal.stage !== "丢单"
    && productLooksSimilar(deal.product, signal.product)
  );
}

function derivedEvidence(input: RecordProcurementSignalInput) {
  const evidence = new Set(input.evidenceTypes || []);
  if (clean(input.product, 200)) evidence.add("product_requirement");
  if (Number(input.quantity || 0) > 0) evidence.add("quantity");
  if (Number(input.targetPrice || 0) > 0) evidence.add("target_price");
  if (clean(input.deliveryRequirement)) evidence.add("delivery");
  if (clean(input.certificationRequirement)) evidence.add("certification");
  if (clean(input.purchaseTimeline)) evidence.add("purchase_timeline");
  if (clean(input.projectName)) evidence.add("project_tender");
  return [...evidence];
}

function defaultNextAction(signal: Pick<
  ProcurementSignal,
  "nextAction" | "quantity" | "targetPrice" | "purchaseTimeline"
>) {
  if (signal.nextAction) return signal.nextAction;
  if (!signal.quantity) return "确认采购数量、规格与年度用量";
  if (!signal.targetPrice) return "确认报价条款并准备正式报价";
  if (!signal.purchaseTimeline) return "确认采购窗口和交付节点";
  return "按客户需求准备报价并确认下一次沟通时间";
}

export function assessDealRecommendation(
  store: CrmStore,
  signal: ProcurementSignal
): DealRecommendationAssessment {
  const reasonCodes = signal.evidenceTypes
    .filter((type) => type === "product_requirement" || strongEvidence.has(type));
  const missingFields: string[] = [];
  if (!signal.product) missingFields.push("产品/应用");
  if (!signal.evidenceTypes.some((type) => strongEvidence.has(type))) {
    missingFields.push("真实采购动作");
  }
  if (!defaultNextAction(signal)) missingFields.push("下一步动作");
  const eligible = signal.status === "confirmed"
    && Boolean(signal.product)
    && signal.evidenceTypes.some((type) => strongEvidence.has(type));
  return {
    eligible,
    reasonCodes,
    missingFields,
    duplicateDeals: activeDuplicateDeals(store, signal)
  };
}

export function recordProcurementSignal(
  store: CrmStore,
  input: RecordProcurementSignalInput
) {
  if (input.candidate.ownerId !== input.actorId) {
    throw new Error("只有候选归属业务员可以确认采购信号");
  }
  if (input.touchpoint.prospectCandidateId !== input.candidate.id
    || input.touchpoint.teamId !== input.candidate.teamId
    || input.touchpoint.ownerId !== input.candidate.ownerId
    || input.touchpoint.direction !== "inbound"
    || input.touchpoint.replyClassification !== "clear_demand") {
    throw new Error("采购信号必须来自当前候选的明确需求回复");
  }
  const existing = store.procurementSignals.find((item) =>
    item.teamId === input.candidate.teamId
    && item.ownerId === input.actorId
    && item.prospectCandidateId === input.candidate.id
    && item.sourceTouchpointId === input.touchpoint.id
  );
  if (existing) {
    return {
      signal: existing,
      assessment: assessDealRecommendation(store, existing),
      replayed: true
    };
  }
  const observedAt = input.touchpoint.occurredAt;
  const evidenceTypes = derivedEvidence(input);
  const product = clean(input.product, 200);
  const signal: ProcurementSignal = {
    id: `psig_${randomUUID()}`,
    teamId: input.candidate.teamId,
    ownerId: input.candidate.ownerId,
    prospectCandidateId: input.candidate.id,
    tenantProspectId: input.candidate.tenantProspectId,
    organizationId: input.candidate.organizationId,
    leadId: input.candidate.leadId,
    customerId: input.candidate.customerId,
    sourceTouchpointId: input.touchpoint.id,
    sourceType: "buyer_reply",
    evidenceTypes,
    evidenceSummary: clean(
      input.evidenceSummary || input.touchpoint.content,
      2000
    ),
    product,
    specification: clean(input.specification, 1000),
    quantity: Math.max(0, Math.round(Number(input.quantity || 0))),
    quantityType: input.quantityType || "unknown",
    targetPrice: Math.max(0, Number(input.targetPrice || 0)),
    currency: /^[A-Z]{3}$/u.test(String(input.currency || "").toUpperCase())
      ? String(input.currency).toUpperCase()
      : "USD",
    priceBasis: clean(input.priceBasis, 80),
    deliveryRequirement: clean(input.deliveryRequirement),
    certificationRequirement: clean(input.certificationRequirement),
    purchaseTimeline: clean(input.purchaseTimeline),
    projectName: clean(input.projectName),
    buyerRole: clean(input.buyerRole, 100),
    nextAction: clean(input.nextAction, 200),
    confidence: clamp(Number(input.confidence ?? 85), 0, 100),
    status: product && evidenceTypes.some((type) => strongEvidence.has(type))
      ? "confirmed"
      : "needs_review",
    observedAt,
    validUntil: isoAfter(observedAt, 120),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  signal.nextAction = defaultNextAction(signal);
  store.procurementSignals.unshift(signal);
  return {
    signal,
    assessment: assessDealRecommendation(store, signal),
    replayed: false
  };
}

export function proposeDealRecommendation(
  store: CrmStore,
  signal: ProcurementSignal
) {
  const assessment = assessDealRecommendation(store, signal);
  const existing = store.dealRecommendations.find((item) =>
    item.signalId === signal.id
    && item.teamId === signal.teamId
    && item.ownerId === signal.ownerId
  );
  if (!assessment.eligible) {
    return { recommendation: existing, assessment, created: false };
  }
  if (existing && ["converted_by_user", "linked_existing_deal"].includes(existing.status)) {
    return { recommendation: existing, assessment, created: false };
  }
  const customerId = resolveCustomerId(store, signal);
  const now = new Date().toISOString();
  const score = clamp(
    48
      + assessment.reasonCodes.length * 7
      + (signal.buyerRole ? 5 : 0)
      + (signal.specification ? 5 : 0)
      + (signal.sourceType === "buyer_reply" ? 12 : 0),
    0,
    96
  );
  const values: Omit<DealRecommendation, "id" | "createdAt"> = {
    signalId: signal.id,
    teamId: signal.teamId,
    ownerId: signal.ownerId,
    prospectCandidateId: signal.prospectCandidateId,
    tenantProspectId: signal.tenantProspectId,
    organizationId: signal.organizationId,
    leadId: signal.leadId,
    customerId: customerId || undefined,
    suggestedTitle: `${signal.product} 采购需求`,
    suggestedProduct: [
      signal.product,
      signal.specification
    ].filter(Boolean).join(" / "),
    suggestedQuantity: signal.quantity,
    suggestedUnitPrice: signal.targetPrice,
    suggestedAmount: signal.quantity && signal.targetPrice
      ? Math.round(signal.quantity * signal.targetPrice * 100) / 100
      : 0,
    currency: signal.currency,
    initialStage: "询盘",
    nextAction: defaultNextAction(signal),
    nextActionAt: dateAfter(now, 2),
    expectedCloseAt: signal.purchaseTimeline,
    reasonCodes: assessment.reasonCodes,
    missingFields: assessment.missingFields,
    evidenceRefs: [signal.sourceTouchpointId],
    recommendationScore: score,
    duplicateDealIds: assessment.duplicateDeals.map((item) => item.id),
    status: "generated",
    expiresAt: signal.validUntil,
    updatedAt: now
  };
  if (existing) {
    Object.assign(existing, values);
    return { recommendation: existing, assessment, created: false };
  }
  const recommendation: DealRecommendation = {
    id: `drec_${randomUUID()}`,
    ...values,
    createdAt: now
  };
  store.dealRecommendations.unshift(recommendation);
  return { recommendation, assessment, created: true };
}

export function dismissDealRecommendation(
  recommendation: DealRecommendation,
  actorId: string,
  reason: string
) {
  if (recommendation.ownerId !== actorId) {
    throw new Error("只有建议归属业务员可以处理商机建议");
  }
  if (["converted_by_user", "linked_existing_deal"].includes(recommendation.status)) {
    throw new Error("已关联商机的建议不能忽略");
  }
  recommendation.status = "dismissed";
  recommendation.reviewedBy = actorId;
  recommendation.reviewedAt = new Date().toISOString();
  recommendation.reviewReason = clean(reason, 500) || "业务员判断暂不建立商机";
  recommendation.updatedAt = recommendation.reviewedAt;
  return recommendation;
}

export function linkRecommendationToDeal(
  store: CrmStore,
  recommendation: DealRecommendation,
  deal: Deal,
  actorId: string,
  mode: "linked_existing_deal" | "converted_by_user"
) {
  if (recommendation.ownerId !== actorId
    || deal.ownerId !== recommendation.ownerId
    || deal.teamId !== recommendation.teamId) {
    throw new Error("商机建议与商机归属不一致");
  }
  const customerId = resolveRecommendationCustomerId(store, recommendation);
  if (!customerId) {
    throw new Error("请先将候选确认到客户，再关联商机");
  }
  if (deal.customerId !== customerId) {
    throw new Error("商机建议与客户不一致");
  }
  const now = new Date().toISOString();
  recommendation.customerId = deal.customerId;
  recommendation.linkedDealId = deal.id;
  recommendation.status = mode;
  recommendation.reviewedBy = actorId;
  recommendation.reviewedAt = now;
  recommendation.updatedAt = now;
  const signal = store.procurementSignals.find((item) =>
    item.id === recommendation.signalId
  );
  if (signal) signal.customerId = deal.customerId;
  const candidate = store.websiteOpportunities.find((item) =>
    item.id === recommendation.prospectCandidateId
  );
  if (candidate) {
    candidate.customerId = deal.customerId;
    candidate.dealId = deal.id;
  }
  const lead = recommendation.leadId
    ? store.leads.find((item) => item.id === recommendation.leadId)
    : undefined;
  if (lead) {
    lead.convertedCustomerId = deal.customerId;
    lead.convertedDealId = deal.id;
  }
  const prospect = recommendation.tenantProspectId
    ? store.tenantProspects.find((item) =>
      item.id === recommendation.tenantProspectId
      && item.teamId === recommendation.teamId
    )
    : undefined;
  if (prospect) {
    prospect.customerId = deal.customerId;
    prospect.dealId = deal.id;
  }
  return recommendation;
}

export function linkProcurementContextToLead(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  leadId: string
) {
  store.procurementSignals
    .filter((item) =>
      item.teamId === candidate.teamId
      && item.ownerId === candidate.ownerId
      && item.prospectCandidateId === candidate.id
    )
    .forEach((item) => {
      item.leadId = leadId;
      item.updatedAt = new Date().toISOString();
    });
  store.dealRecommendations
    .filter((item) =>
      item.teamId === candidate.teamId
      && item.ownerId === candidate.ownerId
      && item.prospectCandidateId === candidate.id
    )
    .forEach((item) => {
      item.leadId = leadId;
      item.updatedAt = new Date().toISOString();
    });
}

export function linkProcurementContextToCustomer(
  store: CrmStore,
  context: {
    teamId: string;
    ownerId: string;
    leadId?: string;
    tenantProspectId?: string;
    prospectCandidateIds?: string[];
  },
  customerId: string
) {
  const candidateIds = new Set(context.prospectCandidateIds || []);
  const matches = (item: Pick<
    ProcurementSignal,
    "teamId" | "ownerId" | "leadId" | "tenantProspectId" | "prospectCandidateId"
  >) =>
    item.teamId === context.teamId
    && item.ownerId === context.ownerId
    && (
      Boolean(context.leadId && item.leadId === context.leadId)
      || Boolean(
        context.tenantProspectId
        && item.tenantProspectId === context.tenantProspectId
      )
      || candidateIds.has(item.prospectCandidateId)
    );
  store.procurementSignals
    .filter(matches)
    .forEach((item) => {
      item.customerId = customerId;
      item.updatedAt = new Date().toISOString();
    });
  store.dealRecommendations
    .filter(matches)
    .forEach((item) => {
      item.customerId = customerId;
      item.updatedAt = new Date().toISOString();
    });
}

export function recommendationReasonText(recommendation: DealRecommendation) {
  return recommendation.reasonCodes
    .map((code) => reasonLabels[code as ProcurementEvidenceType] || code);
}
