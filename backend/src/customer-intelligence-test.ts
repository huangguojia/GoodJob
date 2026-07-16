import assert from "node:assert/strict";
import {
  acceptCustomerIntelligence,
  generateCustomerIntelligenceSuggestion,
  rejectCustomerIntelligence
} from "./customer-intelligence.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type { Customer, WebsiteOpportunity } from "./types.js";

function isolatedStore(): CrmStore {
  return {
    ...getStore(),
    mode: "memory",
    customers: [],
    customerActivities: [],
    customerIntelligenceSuggestions: [],
    websiteOpportunities: [],
    async persist() {},
    async readBarrier() {}
  };
}

function customer(
  ownerId = "sales-a",
  teamId = "team-a"
): Customer {
  return {
    id: "customer-a",
    company: "Existing Buyer GmbH",
    country: "DE",
    contact: "Anna Buyer",
    ownerId,
    teamId,
    stage: "报价",
    amount: 50000,
    health: 88,
    nextReminder: "2026-07-20",
    wecomBound: false,
    billingName: "Existing Buyer GmbH",
    billingAddress: "Hamburg",
    documentContact: "old@buyer.example.test",
    defaultPortDischarge: "Hamburg",
    defaultIncoterm: "FOB",
    defaultPaymentTerm: "30% deposit"
  };
}

function candidate(
  ownerId = "sales-a",
  teamId = "team-a"
): WebsiteOpportunity {
  return {
    id: "candidate-a",
    company: "Existing Buyer AG",
    business: "Industrial pump distribution",
    country: "AT",
    website: "https://buyer.example.test",
    contact: "Anna Schmidt",
    contactInfo: "anna@buyer.example.test",
    description: "官网显示公司名称、采购联系人和主营业务已更新",
    ownerId,
    teamId,
    status: "contacted",
    source: "官网公开资料",
    sourceLabel: "官网公开资料",
    sourceEvidence: [{
      providerId: "official-website",
      providerRecordId: "buyer-about",
      sourceUrl: "https://buyer.example.test/about",
      officialWebsite: "https://buyer.example.test",
      recordType: "company_profile",
      fetchedAt: "2026-07-15T02:00:00.000Z",
      payloadHash: "a".repeat(64),
      evidenceSummary: "官网关于我们页面及联系页面",
      matchedFields: ["company", "contact", "business"],
      adapterVersion: "test-v1",
      catalogPolicyVersion: "test-v1",
      sourceLevel: "official",
      retentionPolicyRef: "public-source-test"
    }],
    createdAt: "2026-07-15T02:00:00.000Z"
  };
}

{
  const store = isolatedStore();
  const target = customer();
  const prospect = candidate();
  store.customers.push(target);
  const before = structuredClone(target);

  const created = generateCustomerIntelligenceSuggestion(store, {
    customer: target,
    candidate: prospect,
    observedAt: "2026-07-15T03:00:00.000Z"
  });
  assert.equal(created.created, true);
  assert.deepEqual(target, before);
  assert.equal(created.suggestion?.status, "pending");

  const replay = generateCustomerIntelligenceSuggestion(store, {
    customer: target,
    candidate: prospect,
    observedAt: "2026-07-15T03:05:00.000Z"
  });
  assert.equal(replay.created, false);
  assert.equal(replay.suggestion?.id, created.suggestion?.id);
  assert.equal(store.customerIntelligenceSuggestions.length, 1);
}

{
  const store = isolatedStore();
  const target = customer();
  store.customers.push(target);
  const suggestion = generateCustomerIntelligenceSuggestion(store, {
    customer: target,
    candidate: candidate()
  }).suggestion!;

  const accepted = acceptCustomerIntelligence(store, {
    suggestionId: suggestion.id,
    teamId: target.teamId,
    ownerId: target.ownerId,
    selectedFields: ["country", "documentContact"],
    reviewedAt: "2026-07-15T04:00:00.000Z"
  });
  assert.equal(target.company, "Existing Buyer GmbH");
  assert.equal(target.country, "AT");
  assert.equal(target.contact, "Anna Buyer");
  assert.match(target.documentContact, /anna@buyer\.example\.test/u);
  assert.deepEqual(
    accepted.suggestion.acceptedFields,
    ["country", "documentContact"]
  );
  assert.equal(store.customerActivities.length, 1);
  assert.match(store.customerActivities[0]!.content, /官网公开资料/u);
}

{
  const store = isolatedStore();
  const target = customer();
  store.customers.push(target);
  const suggestion = generateCustomerIntelligenceSuggestion(store, {
    customer: target,
    candidate: candidate()
  }).suggestion!;
  target.country = "CH";

  assert.throws(
    () => acceptCustomerIntelligence(store, {
      suggestionId: suggestion.id,
      teamId: target.teamId,
      ownerId: target.ownerId,
      selectedFields: ["country"]
    }),
    /已发生变化/u
  );
  assert.equal(target.country, "CH");
  assert.equal(suggestion.status, "pending");
  assert.equal(store.customerActivities.length, 0);
}

{
  const store = isolatedStore();
  const target = customer();
  store.customers.push(target);
  const before = structuredClone(target);
  const suggestion = generateCustomerIntelligenceSuggestion(store, {
    customer: target,
    candidate: candidate()
  }).suggestion!;

  assert.throws(
    () => acceptCustomerIntelligence(store, {
      suggestionId: suggestion.id,
      teamId: target.teamId,
      ownerId: "sales-b",
      selectedFields: []
    }),
    /无权访问/u
  );
  assert.throws(
    () => rejectCustomerIntelligence(store, {
      suggestionId: suggestion.id,
      teamId: "team-b",
      ownerId: target.ownerId
    }),
    /无权访问/u
  );
  rejectCustomerIntelligence(store, {
    suggestionId: suggestion.id,
    teamId: target.teamId,
    ownerId: target.ownerId,
    reason: "资料不适用于当前客户主档"
  });
  assert.equal(suggestion.status, "rejected");
  assert.deepEqual(target, before);
  assert.equal(store.customerActivities.length, 0);
}

{
  const store = isolatedStore();
  const target = customer();
  const prospect = candidate();
  prospect.company = target.company;
  prospect.country = target.country;
  prospect.contact = "";
  prospect.contactInfo = "";
  store.customers.push(target);
  const before = structuredClone(target);
  const suggestion = generateCustomerIntelligenceSuggestion(store, {
    customer: target,
    candidate: prospect
  }).suggestion!;

  assert.equal(suggestion.suggestedFields.length, 0);
  acceptCustomerIntelligence(store, {
    suggestionId: suggestion.id,
    teamId: target.teamId,
    ownerId: target.ownerId,
    selectedFields: []
  });
  assert.deepEqual(target, before);
  assert.equal(store.customerActivities.length, 1);
  assert.match(
    store.customerActivities[0]!.content,
    /仅采纳来源证据/u
  );
}

assert.throws(
  () => generateCustomerIntelligenceSuggestion(isolatedStore(), {
    customer: customer("sales-a", "team-a"),
    candidate: candidate("sales-b", "team-a")
  }),
  /归属不一致/u
);
assert.throws(
  () => generateCustomerIntelligenceSuggestion(isolatedStore(), {
    customer: customer("sales-a", "team-a"),
    candidate: candidate("sales-a", "team-b")
  }),
  /归属不一致/u
);

console.log("Customer intelligence tests passed");
