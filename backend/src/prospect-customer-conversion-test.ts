import assert from "node:assert/strict";
import {
  convertProspectToCustomer,
  type ConvertProspectToCustomerInput,
  ProspectCustomerConversionError
} from "./prospect-customer-conversion.js";
import {
  PROSPECT_LEAD_CONVERSION_CONTRACT,
  PROSPECT_LEAD_SOURCE_CHANNEL
} from "./prospect-lead-conversion.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type {
  Customer,
  CustomerAcquisitionSourceEvent,
  Lead,
  LeadSourceEvent,
  TenantProspect
} from "./types.js";

const coverageSecret =
  "prospect-customer-conversion-test-secret-v1-".repeat(2);
const at = (minute: number) =>
  new Date(Date.UTC(2026, 6, 15, 10, minute)).toISOString();
const hash = (seed: number) => seed.toString(16).padStart(64, "0");
let sequence = 0;

type Fixture = {
  store: CrmStore;
  teamId: string;
  ownerId: string;
  otherOwnerId: string;
  organizationId: string;
  prospect: TenantProspect;
  lead: Lead;
  source: LeadSourceEvent;
  input: ConvertProspectToCustomerInput;
};

function isolatedStore(): CrmStore {
  const base = getStore();
  return {
    ...base,
    mode: "memory",
    customers: [],
    customerActivities: [],
    customerAcquisitionSourceEvents: [],
    leads: [],
    leadActivities: [],
    leadSourceEvents: [],
    tenantProspects: [],
    prospectCoverageEvents: [],
    deals: [],
    dealEvents: [],
    todos: [],
    websiteOpportunities: [],
    async persist() {
      // Isolated in-memory contract test.
    },
    async readBarrier() {
      // The test executes synchronously.
    }
  };
}

function customer(
  id: string,
  teamId: string,
  ownerId: string,
  company = "Existing Customer GmbH"
): Customer {
  return {
    id,
    company,
    country: "DE",
    contact: "Existing Buyer",
    ownerId,
    teamId,
    stage: "报价",
    amount: 88000,
    health: 91,
    nextReminder: "保留原提醒",
    wecomBound: true,
    billingName: "Existing Billing GmbH",
    billingAddress: "Existing billing address",
    documentContact: "Existing document contact",
    defaultPortDischarge: "Hamburg",
    defaultIncoterm: "FOB",
    defaultPaymentTerm: "30% deposit"
  };
}

function acquisitionEvent(
  fixture: Fixture,
  input: Partial<CustomerAcquisitionSourceEvent> = {}
): CustomerAcquisitionSourceEvent {
  sequence += 1;
  return {
    id: `case-existing-${sequence}`,
    teamId: fixture.teamId,
    ownerId: fixture.ownerId,
    customerId: `customer-existing-${sequence}`,
    leadId: `lead-existing-${sequence}`,
    leadSourceEventId: `source-existing-${sequence}`,
    prospectId: `prospect-existing-${sequence}`,
    organizationId: `organization-existing-${sequence}`,
    sourceChannel: PROSPECT_LEAD_SOURCE_CHANNEL,
    sourceCampaign: "existing-campaign",
    sourceUrl: "https://source.example.test/existing",
    mode: "create_new",
    processingKeyHash: hash(40_000 + sequence),
    requestHash: hash(50_000 + sequence),
    createdAt: at(1),
    ...input
  };
}

function createFixture(suffix: string): Fixture {
  sequence += 1;
  const store = isolatedStore();
  const teamId = `team-${suffix}`;
  const ownerId = `owner-${suffix}`;
  const otherOwnerId = `other-owner-${suffix}`;
  const organizationId = `organization-${suffix}`;
  const prospectId = `prospect-${suffix}`;
  const leadId = `lead-${suffix}`;
  const lead: Lead = {
    id: leadId,
    company: `Acquisition ${suffix} GmbH`,
    contact: "Anna Buyer",
    country: "DE",
    email: `anna@${suffix}.example.test`,
    phone: "",
    wechat: "",
    source: "智能获客",
    intent: "高",
    stage: "新线索",
    status: "new",
    ownerId,
    teamId,
    estimatedAmount: 32000,
    nextFollowAt: at(60),
    lastActivityAt: at(10),
    remark: "人工确认的智能获客线索",
    convertedCustomerId: "",
    convertedDealId: "",
    sourceType: "outbound",
    sourceChannel: PROSPECT_LEAD_SOURCE_CHANNEL,
    sourceCampaign: `campaign-${suffix}`,
    externalId: prospectId,
    sourceUrl: `https://${suffix}.example.test`,
    createdAt: at(10)
  };
  const prospect: TenantProspect = {
    id: prospectId,
    teamId,
    organizationId,
    status: "converted",
    latestClassification: "net_new",
    queueState: "converted",
    queueReasonCode: "CRM_ENTITY_ALREADY_LINKED",
    firstSeenAt: at(0),
    lastSeenAt: at(0),
    lastMaterialChangeAt: at(0),
    lastQueuedAt: at(0),
    lastReviewedAt: at(5),
    nextReviewAt: at(100),
    hitCount: 1,
    sourceCount: 1,
    evidenceCount: 1,
    sourceKeyHashes: [hash(sequence + 1)],
    materialEvidenceKeyHashes: [hash(sequence + 2)],
    exclusionScope: "none",
    exclusionMode: "none",
    exclusionReasonCode: "",
    excludedUntil: "",
    leadId,
    customerId: "",
    dealId: "",
    version: 2,
    eventCount: 2,
    eventTailHash: hash(sequence + 3),
    prospectHash: hash(sequence + 4),
    createdAt: at(0),
    updatedAt: at(10)
  };
  const source: LeadSourceEvent = {
    id: `source-${suffix}`,
    leadId,
    sourceType: "outbound",
    channel: PROSPECT_LEAD_SOURCE_CHANNEL,
    campaign: `campaign-${suffix}`,
    externalId: prospectId,
    sourceUrl: `https://${suffix}.example.test`,
    occurredAt: at(10),
    receivedAt: at(10),
    rawPayload: JSON.stringify({
      contract: PROSPECT_LEAD_CONVERSION_CONTRACT,
      prospectId,
      organizationId,
      createdLead: true
    }),
    ownerId,
    teamId
  };
  store.leads.push(lead);
  store.leadSourceEvents.push(source);
  store.tenantProspects.push(prospect);
  return {
    store,
    teamId,
    ownerId,
    otherOwnerId,
    organizationId,
    prospect,
    lead,
    source,
    input: {
      operationCode: "convert_prospect_to_customer_v1",
      leadId,
      mode: "create_new",
      existingCustomerId: "",
      company: "",
      contact: "",
      country: "",
      nextReminder: "",
      teamId,
      ownerId,
      prospectId,
      idempotencyKey: `customer-conversion-${suffix}`,
      convertedAt: at(20),
      coverageSecret
    }
  };
}

function isConversionError(
  code: ProspectCustomerConversionError["code"]
) {
  return (error: unknown) =>
    error instanceof ProspectCustomerConversionError && error.code === code;
}

function protectedState(store: CrmStore) {
  return {
    deals: structuredClone(store.deals),
    dealEvents: structuredClone(store.dealEvents),
    todos: structuredClone(store.todos),
    websiteOpportunities: structuredClone(store.websiteOpportunities)
  };
}

function testCreateAndIdempotency() {
  const fixture = createFixture("create");
  const protectedBefore = protectedState(fixture.store);
  const result = convertProspectToCustomer(fixture.store, fixture.input);

  assert.equal(result.replayed, false);
  assert.equal(result.created, true);
  assert.equal(result.customer.company, fixture.lead.company);
  assert.equal(result.customer.contact, fixture.lead.contact);
  assert.equal(result.customer.country, fixture.lead.country);
  assert.equal(result.customer.nextReminder, fixture.lead.nextFollowAt);
  assert.equal(result.customer.ownerId, fixture.ownerId);
  assert.equal(result.customer.teamId, fixture.teamId);
  assert.equal(result.customer.billingName, "");
  assert.equal(result.customer.billingAddress, "");
  assert.equal(result.customer.documentContact, "");
  assert.equal(result.lead.convertedCustomerId, result.customer.id);
  assert.equal(result.lead.convertedDealId, "");
  assert.equal(result.prospect.customerId, result.customer.id);
  assert.equal(
    result.sourceEvent.leadSourceEventId,
    fixture.source.id
  );
  assert.equal(result.sourceEvent.organizationId, fixture.organizationId);
  assert.equal(
    result.coverageEvent.reasonCode,
    "HUMAN_CONFIRMED_CUSTOMER_CONVERSION"
  );
  assert.equal(fixture.store.customers.length, 1);
  assert.equal(fixture.store.customerAcquisitionSourceEvents.length, 1);
  assert.equal(fixture.store.customerActivities.length, 1);
  assert.equal(fixture.store.leadActivities.length, 1);
  assert.deepEqual(protectedState(fixture.store), protectedBefore);

  const replay = convertProspectToCustomer(fixture.store, fixture.input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.customer.id, result.customer.id);
  assert.equal(fixture.store.customers.length, 1);
  assert.equal(fixture.store.customerAcquisitionSourceEvents.length, 1);
  assert.equal(fixture.store.customerActivities.length, 1);
  assert.equal(fixture.store.leadActivities.length, 1);
  assert.throws(
    () => convertProspectToCustomer(fixture.store, {
      ...fixture.input,
      company: "Changed payload"
    }),
    isConversionError(
      "PROSPECT_CUSTOMER_CONVERSION_IDEMPOTENCY_CONFLICT"
    )
  );
}

function testLinkExistingWithoutOverwriting() {
  const fixture = createFixture("link");
  const existing = customer(
    "customer-current-owner",
    fixture.teamId,
    fixture.ownerId
  );
  fixture.store.customers.push(existing);
  const masterBefore = structuredClone(existing);
  const result = convertProspectToCustomer(fixture.store, {
    ...fixture.input,
    mode: "link_existing",
    existingCustomerId: existing.id
  });

  assert.equal(result.created, false);
  assert.equal(result.customer.id, existing.id);
  assert.deepEqual(
    fixture.store.customers.find((item) => item.id === existing.id),
    masterBefore
  );
  assert.equal(fixture.store.customers.length, 1);
  assert.equal(result.lead.convertedCustomerId, existing.id);
  assert.equal(result.prospect.customerId, existing.id);
}

function testOwnerAndSourceIsolation() {
  const owner = createFixture("owner-isolation");
  owner.store.customers.push(customer(
    "customer-other-owner",
    owner.teamId,
    owner.otherOwnerId
  ));
  const ownerBefore = {
    customers: structuredClone(owner.store.customers),
    leads: structuredClone(owner.store.leads),
    prospects: structuredClone(owner.store.tenantProspects),
    sourceEvents: structuredClone(
      owner.store.customerAcquisitionSourceEvents
    )
  };
  assert.throws(
    () => convertProspectToCustomer(owner.store, {
      ...owner.input,
      mode: "link_existing",
      existingCustomerId: "customer-other-owner"
    }),
    isConversionError("PROSPECT_CUSTOMER_CONVERSION_NOT_FOUND")
  );
  assert.deepEqual(owner.store.customers, ownerBefore.customers);
  assert.deepEqual(owner.store.leads, ownerBefore.leads);
  assert.deepEqual(owner.store.tenantProspects, ownerBefore.prospects);
  assert.deepEqual(
    owner.store.customerAcquisitionSourceEvents,
    ownerBefore.sourceEvents
  );

  const source = createFixture("invalid-source");
  source.source.rawPayload = JSON.stringify({
    contract: "untrusted-contract",
    prospectId: source.prospect.id,
    organizationId: source.organizationId
  });
  const sourceBefore = {
    customers: structuredClone(source.store.customers),
    leads: structuredClone(source.store.leads),
    prospects: structuredClone(source.store.tenantProspects),
    events: structuredClone(source.store.prospectCoverageEvents)
  };
  assert.throws(
    () => convertProspectToCustomer(source.store, source.input),
    isConversionError(
      "PROSPECT_CUSTOMER_CONVERSION_SOURCE_INVALID"
    )
  );
  assert.deepEqual(source.store.customers, sourceBefore.customers);
  assert.deepEqual(source.store.leads, sourceBefore.leads);
  assert.deepEqual(source.store.tenantProspects, sourceBefore.prospects);
  assert.deepEqual(source.store.prospectCoverageEvents, sourceBefore.events);
}

function testOrganizationOwnershipConflict() {
  const fixture = createFixture("organization-conflict");
  fixture.store.customerAcquisitionSourceEvents.push(acquisitionEvent(
    fixture,
    {
      teamId: fixture.teamId,
      ownerId: fixture.otherOwnerId,
      organizationId: fixture.organizationId
    }
  ));
  assert.throws(
    () => convertProspectToCustomer(fixture.store, fixture.input),
    isConversionError(
      "PROSPECT_CUSTOMER_CONVERSION_ORGANIZATION_OWNERSHIP_CONFLICT"
    )
  );
  assert.equal(fixture.store.customers.length, 0);
  assert.equal(fixture.lead.convertedCustomerId, "");
  assert.equal(fixture.prospect.customerId, "");
}

testCreateAndIdempotency();
testLinkExistingWithoutOverwriting();
testOwnerAndSourceIsolation();
testOrganizationOwnershipConflict();

console.log(
  "Prospect customer conversion create, link, isolation, source, "
  + "idempotency and protected-entity tests passed"
);
