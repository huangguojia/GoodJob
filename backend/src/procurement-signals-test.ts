import assert from "node:assert/strict";
import {
  dismissDealRecommendation,
  linkProcurementContextToLead,
  linkRecommendationToDeal,
  proposeDealRecommendation,
  recordProcurementSignal
} from "./procurement-signals.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type {
  Deal,
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
    tenantProspects: [],
    leads: [],
    customers: [],
    deals: [],
    dealEvents: [],
    async persist() {},
    async readBarrier() {}
  };
}

function candidate(ownerId = "sales-a", teamId = "team-a"): WebsiteOpportunity {
  return {
    id: "candidate-a",
    company: "Buyer A",
    business: "Industrial pump",
    country: "DE",
    website: "https://buyer-a.example.test",
    contact: "Anna",
    contactInfo: "anna@buyer-a.example.test",
    description: "",
    ownerId,
    teamId,
    status: "contacted",
    createdAt: "2026-07-01T00:00:00.000Z"
  };
}

function reply(item: WebsiteOpportunity): ProspectTouchpoint {
  return {
    id: "touchpoint-clear-demand",
    teamId: item.teamId,
    ownerId: item.ownerId,
    prospectCandidateId: item.id,
    channel: "email",
    direction: "inbound",
    contactValue: item.contactInfo,
    subject: "RFQ",
    content: "Please quote 500 industrial pumps for our September project.",
    replyClassification: "clear_demand",
    requestId: "reply-1",
    occurredAt: "2026-07-15T02:00:00.000Z",
    createdAt: "2026-07-15T02:00:00.000Z"
  };
}

function recordStrongSignal(store: CrmStore) {
  const prospect = candidate();
  const touchpoint = reply(prospect);
  store.websiteOpportunities.push(prospect);
  store.prospectTouchpoints.push(touchpoint);
  return recordProcurementSignal(store, {
    candidate: prospect,
    touchpoint,
    actorId: prospect.ownerId,
    evidenceTypes: ["quote_request"],
    product: "Industrial pump P-500",
    specification: "380V, CE required",
    quantity: 500,
    quantityType: "order",
    purchaseTimeline: "2026-09-15",
    nextAction: "确认包装和贸易条款"
  });
}

{
  const store = isolatedStore();
  const result = recordStrongSignal(store);
  assert.equal(result.assessment.eligible, true);
  assert.equal(store.procurementSignals.length, 1);
  assert.equal(store.deals.length, 0);
  assert.equal(store.customers.length, 0);
  const proposed = proposeDealRecommendation(store, result.signal);
  assert.equal(proposed.recommendation?.status, "generated");
  assert.equal(proposed.recommendation?.suggestedQuantity, 500);
  assert.equal(store.dealRecommendations.length, 1);
  assert.equal(store.deals.length, 0);

  const replay = recordStrongSignal(store);
  assert.equal(replay.replayed, true);
  assert.equal(store.procurementSignals.length, 1);
}

{
  const store = isolatedStore();
  const prospect = candidate();
  const touchpoint = reply(prospect);
  store.websiteOpportunities.push(prospect);
  const weak = recordProcurementSignal(store, {
    candidate: prospect,
    touchpoint,
    actorId: prospect.ownerId,
    evidenceSummary: "Please send a catalogue."
  });
  assert.equal(weak.assessment.eligible, false);
  const proposed = proposeDealRecommendation(store, weak.signal);
  assert.equal(proposed.recommendation, undefined);
  assert.equal(store.dealRecommendations.length, 0);
}

{
  const store = isolatedStore();
  const result = recordStrongSignal(store);
  result.signal.customerId = "customer-a";
  store.customers.push({
    id: "customer-a",
    company: "Buyer A",
    country: "DE",
    contact: "Anna",
    ownerId: "sales-a",
    teamId: "team-a",
    stage: "询盘",
    amount: 0,
    health: 80,
    nextReminder: "",
    wecomBound: false,
    billingName: "Buyer A",
    billingAddress: "",
    documentContact: "",
    defaultPortDischarge: "",
    defaultIncoterm: "",
    defaultPaymentTerm: ""
  });
  const duplicate: Deal = {
    id: "deal-existing",
    customerId: "customer-a",
    title: "Pump RFQ",
    stage: "已报价",
    product: "Industrial pump P-500",
    quantity: 500,
    unitPrice: 20,
    amount: 10000,
    currency: "USD",
    amountType: "quoted",
    ownerId: "sales-a",
    teamId: "team-a",
    nextAction: "等待回复",
    nextActionAt: "2026-07-20",
    expectedCloseAt: "",
    stageChangedAt: "2026-07-10T00:00:00.000Z"
  };
  store.deals.push(duplicate);
  const proposed = proposeDealRecommendation(store, result.signal);
  assert.deepEqual(proposed.recommendation?.duplicateDealIds, ["deal-existing"]);
  linkRecommendationToDeal(
    store,
    proposed.recommendation!,
    duplicate,
    "sales-a",
    "linked_existing_deal"
  );
  assert.equal(proposed.recommendation?.linkedDealId, "deal-existing");
  assert.equal(proposed.recommendation?.status, "linked_existing_deal");
}

{
  const store = isolatedStore();
  const result = recordStrongSignal(store);
  const recommendation = proposeDealRecommendation(
    store,
    result.signal
  ).recommendation!;
  assert.throws(
    () => dismissDealRecommendation(recommendation, "sales-b", "not mine"),
    /只有建议归属业务员/u
  );
  dismissDealRecommendation(recommendation, "sales-a", "暂不推进");
  assert.equal(recommendation.status, "dismissed");
}

{
  const store = isolatedStore();
  const result = recordStrongSignal(store);
  const recommendation = proposeDealRecommendation(
    store,
    result.signal
  ).recommendation!;
  linkProcurementContextToLead(
    store,
    store.websiteOpportunities[0]!,
    "lead-a"
  );
  assert.equal(result.signal.leadId, "lead-a");
  assert.equal(recommendation.leadId, "lead-a");
}

console.log("Procurement signal tests passed");
