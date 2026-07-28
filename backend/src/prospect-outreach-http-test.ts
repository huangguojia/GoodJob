import assert from "node:assert/strict";
import {
  app,
  setOutboundEmailDispatchObserverForTest
} from "./server.js";
import { getStore } from "./store.js";
import type {
  CompanyProfile,
  Customer,
  CustomerAcquisitionSourceEvent,
  Lead,
  LeadSourceEvent,
  WebsiteOpportunity,
  WhatsAppBinding
} from "./types.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start prospect outreach HTTP test server");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const json = await response.json();
  return { response, json };
}

const store = getStore();
let dispatchCount = 0;
let candidate: WebsiteOpportunity | null = null;
let lead: Lead | null = null;
let customer: Customer | null = null;
let sourceEvent: LeadSourceEvent | null = null;
let acquisitionEvent: CustomerAcquisitionSourceEvent | null = null;
let whatsappBinding: WhatsAppBinding | null = null;
let originalCompanyProfile: CompanyProfile | null = null;
let insertedCompanyProfile = false;
let historicalTouchpointId = "";

try {
  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: "shirley@goodjob.com",
      password: "goodjob123"
    })
  });
  assert.equal(login.response.ok, true);
  const token = String(login.json.token || "");
  const owner = store.users.find((item) => item.email === "shirley@goodjob.com");
  assert.ok(owner);
  const companyProfile = store.companyProfiles.find((item) =>
    item.teamId === owner.teamId
  );
  if (companyProfile) {
    originalCompanyProfile = structuredClone(companyProfile);
    Object.assign(companyProfile, {
      companyName: "GoodJob Test Exporter",
      productSummary: "Industrial test products",
      website: "https://goodjob.example.test"
    });
  } else {
    insertedCompanyProfile = true;
    store.companyProfiles.push({
      teamId: owner.teamId,
      companyName: "GoodJob Test Exporter",
      productSummary: "Industrial test products",
      website: "https://goodjob.example.test",
      address: "",
      phone: "",
      email: "",
      updatedBy: owner.id,
      updatedAt: new Date().toISOString()
    });
  }

  candidate = {
    id: `candidate-http-blocked-${Date.now()}`,
    company: "Blocked Outreach Test Limited",
    business: "Industrial components",
    country: "GB",
    website: "https://blocked-outreach.example.test",
    contact: "Purchasing",
    contactInfo: "buyer@blocked-outreach.example.test",
    description: "HTTP outreach gate integration test",
    ownerId: owner.id,
    teamId: owner.teamId,
    status: "preview",
    createdAt: new Date().toISOString(),
    outreachState: "uncontacted"
  };
  store.websiteOpportunities.push(candidate);

  setOutboundEmailDispatchObserverForTest(() => {
    dispatchCount += 1;
  });
  const candidateBefore = structuredClone(candidate);
  const userBefore = {
    lastDevelopmentEmailAt: owner.lastDevelopmentEmailAt,
    lastDevelopmentEmailTo: owner.lastDevelopmentEmailTo,
    lastDevelopmentEmailSubject: owner.lastDevelopmentEmailSubject
  };
  const touchpointCountBefore = store.prospectTouchpoints.length;
  const todoCountBefore = store.todos.length;

  const blocked = await request(
    `/api/prospect-list/${encodeURIComponent(candidate.id)}/send-development-email`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        to: candidate.contactInfo,
        subject: "This message must be blocked",
        body: "This development email must not reach the SMTP dispatch boundary.",
        requestId: "blocked-outreach-http-request"
      })
    }
  );

  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.json.errorCode, "PROSPECT_OUTREACH_NOT_RESOLVED");
  assert.equal(dispatchCount, 0, "blocked request must make zero SMTP dispatches");
  assert.equal(store.prospectTouchpoints.length, touchpointCountBefore);
  assert.equal(store.todos.length, todoCountBefore);
  assert.deepEqual(candidate, candidateBefore);
  assert.deepEqual({
    lastDevelopmentEmailAt: owner.lastDevelopmentEmailAt,
    lastDevelopmentEmailTo: owner.lastDevelopmentEmailTo,
    lastDevelopmentEmailSubject: owner.lastDevelopmentEmailSubject
  }, userBefore);

  const historicalCandidateBefore = structuredClone(candidate);
  const historicalTodoCount = store.todos.length;
  const historicalTouchpointCount = store.prospectTouchpoints.length;
  const missingRecordMode = await request(
    `/api/prospect-list/${encodeURIComponent(candidate.id)}/touchpoints`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        channel: "email",
        requestId: "historical-mode-required"
      })
    }
  );
  assert.equal(missingRecordMode.response.status, 400);
  assert.equal(store.prospectTouchpoints.length, historicalTouchpointCount);
  const historical = await request(
    `/api/prospect-list/${encodeURIComponent(candidate.id)}/touchpoints`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        recordMode: "historical",
        channel: "email",
        contactValue: candidate.contactInfo,
        subject: "Previously sent outside CRM",
        content: "Historical fact only; no sending or follow-up automation.",
        occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
        requestId: "historical-fact-only-http"
      })
    }
  );
  assert.equal(historical.response.status, 201);
  historicalTouchpointId = String(historical.json.touchpoint?.id || "");
  assert.ok(historicalTouchpointId);
  assert.equal(store.prospectTouchpoints.length, historicalTouchpointCount + 1);
  assert.equal(store.todos.length, historicalTodoCount);
  assert.deepEqual(candidate, historicalCandidateBefore);

  const fixtureId = Date.now();
  lead = {
    id: `lead-http-blocked-${fixtureId}`,
    company: candidate.company,
    contact: candidate.contact,
    country: candidate.country,
    email: candidate.contactInfo,
    phone: "+447700900123",
    wechat: "",
    source: "prospect_conversion",
    intent: "medium",
    stage: "待跟进",
    status: "new",
    ownerId: owner.id,
    teamId: owner.teamId,
    estimatedAmount: 0,
    nextFollowAt: "",
    lastActivityAt: "",
    remark: "",
    convertedCustomerId: "",
    convertedDealId: "",
    sourceType: "outbound",
    sourceChannel: "prospect_conversion",
    sourceCampaign: "http-gate-test",
    externalId: "missing-formal-prospect",
    sourceUrl: candidate.website,
    createdAt: new Date().toISOString()
  };
  customer = {
    id: `customer-http-blocked-${fixtureId}`,
    company: candidate.company,
    country: candidate.country,
    contact: candidate.contact,
    whatsapp: "+447700900123",
    ownerId: owner.id,
    teamId: owner.teamId,
    stage: "跟进中",
    amount: 0,
    health: 50,
    nextReminder: "",
    wecomBound: false,
    billingName: "",
    billingAddress: "",
    documentContact: candidate.contactInfo,
    defaultPortDischarge: "",
    defaultIncoterm: "",
    defaultPaymentTerm: "",
    poolStatus: "owned"
  };
  candidate.leadId = lead.id;
  candidate.customerId = customer.id;
  sourceEvent = {
    id: `lead-source-http-blocked-${fixtureId}`,
    leadId: lead.id,
    sourceType: "outbound",
    channel: "prospect_conversion",
    campaign: "http-gate-test",
    externalId: "missing-formal-prospect",
    sourceUrl: candidate.website,
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    rawPayload: JSON.stringify({ prospectId: "missing-formal-prospect" }),
    ownerId: owner.id,
    teamId: owner.teamId
  };
  acquisitionEvent = {
    id: `customer-source-http-blocked-${fixtureId}`,
    teamId: owner.teamId,
    ownerId: owner.id,
    customerId: customer.id,
    leadId: lead.id,
    leadSourceEventId: sourceEvent.id,
    prospectId: "missing-formal-prospect",
    organizationId: "missing-organization",
    sourceChannel: "prospect_conversion",
    sourceCampaign: "http-gate-test",
    sourceUrl: candidate.website,
    mode: "create_new",
    processingKeyHash: "http-gate-processing",
    requestHash: "http-gate-request",
    createdAt: new Date().toISOString()
  };
  whatsappBinding = {
    id: `whatsapp-binding-http-blocked-${fixtureId}`,
    customerId: customer.id,
    phoneNumber: customer.whatsapp!,
    waProfileName: "Blocked Gate",
    lastMessageAt: "",
    unreadCount: 0,
    createdAt: new Date().toISOString(),
    bindingMode: "twilio-api",
    twilioPhoneNumber: "+14155238886",
    connectionStatus: "connected"
  };
  store.leads.push(lead);
  store.customers.push(customer);
  store.leadSourceEvents.push(sourceEvent);
  store.customerAcquisitionSourceEvents.push(acquisitionEvent);
  store.whatsappBindings.push(whatsappBinding);

  const sideEffectsBefore = {
    dispatchCount,
    leadActivities: store.leadActivities.length,
    customerActivities: store.customerActivities.length,
    touchpoints: store.prospectTouchpoints.length,
    todos: store.todos.length,
    whatsappMessages: store.whatsappMessages.length,
    candidate: structuredClone(candidate),
    lead: structuredClone(lead),
    customer: structuredClone(customer)
  };
  const blockedRequests = [
    request(`/api/leads/${encodeURIComponent(lead.id)}/send-email`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        to: lead.email,
        subject: "Blocked lead email",
        body: "This managed lead email must be blocked before SMTP dispatch."
      })
    }),
    request("/api/development-email/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        entityType: "lead",
        entityId: lead.id,
        to: lead.email,
        subject: "Blocked generic lead email",
        body: "This managed lead email must be blocked before SMTP dispatch.",
        nextFollowAt: ""
      })
    }),
    request("/api/development-email/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        entityType: "customer",
        entityId: customer.id,
        to: candidate.contactInfo,
        subject: "Blocked generic customer email",
        body: "This managed customer email must be blocked before SMTP dispatch.",
        nextFollowAt: ""
      })
    }),
    request(`/api/whatsapp/customers/${encodeURIComponent(customer.id)}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        direction: "outbound",
        content: "This managed customer message must be blocked before transport."
      })
    })
  ];
  for (const blockedRequest of await Promise.all(blockedRequests)) {
    assert.equal(blockedRequest.response.status, 409, JSON.stringify(blockedRequest.json));
    assert.equal(blockedRequest.json.errorCode, "PROSPECT_OUTREACH_NOT_RESOLVED");
  }
  assert.equal(dispatchCount, sideEffectsBefore.dispatchCount);
  assert.equal(store.leadActivities.length, sideEffectsBefore.leadActivities);
  assert.equal(store.customerActivities.length, sideEffectsBefore.customerActivities);
  assert.equal(store.prospectTouchpoints.length, sideEffectsBefore.touchpoints);
  assert.equal(store.todos.length, sideEffectsBefore.todos);
  assert.equal(store.whatsappMessages.length, sideEffectsBefore.whatsappMessages);
  assert.deepEqual(candidate, sideEffectsBefore.candidate);
  assert.deepEqual(lead, sideEffectsBefore.lead);
  assert.deepEqual(customer, sideEffectsBefore.customer);

  console.log("Prospect outreach HTTP gate tests passed");
} finally {
  setOutboundEmailDispatchObserverForTest(null);
  if (candidate) {
    const index = store.websiteOpportunities.findIndex((item) =>
      item.id === candidate!.id
    );
    if (index >= 0) store.websiteOpportunities.splice(index, 1);
  }
  if (lead) store.leads = store.leads.filter((item) => item.id !== lead!.id);
  if (customer) store.customers = store.customers.filter((item) => item.id !== customer!.id);
  if (sourceEvent) store.leadSourceEvents = store.leadSourceEvents.filter((item) => item.id !== sourceEvent!.id);
  if (acquisitionEvent) store.customerAcquisitionSourceEvents = store.customerAcquisitionSourceEvents.filter((item) => item.id !== acquisitionEvent!.id);
  if (whatsappBinding) store.whatsappBindings = store.whatsappBindings.filter((item) => item.id !== whatsappBinding!.id);
  if (historicalTouchpointId) {
    store.prospectTouchpoints = store.prospectTouchpoints.filter((item) =>
      item.id !== historicalTouchpointId
    );
  }
  if (insertedCompanyProfile && candidate) {
    store.companyProfiles = store.companyProfiles.filter((item) =>
      item.teamId !== candidate!.teamId
    );
  } else if (originalCompanyProfile) {
    const current = store.companyProfiles.find((item) =>
      item.teamId === originalCompanyProfile!.teamId
    );
    if (current) Object.assign(current, originalCompanyProfile);
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
