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
let ownerMailOriginal: Record<string, unknown> | null = null;

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

  // 资格审核链已移除：发信只依赖发件配置。测试里给 owner 配置 SMTP（NODE_ENV=test
  // 下 nodemailer 使用 streamTransport，不会真实外发）。
  ownerMailOriginal = {
    outboundEmail: owner.outboundEmail,
    smtpHost: owner.smtpHost,
    smtpUser: owner.smtpUser,
    smtpPassword: owner.smtpPassword,
    smtpPort: owner.smtpPort,
    smtpSecure: owner.smtpSecure
  };
  Object.assign(owner, {
    outboundEmail: owner.outboundEmail || "sales@goodjob.example.test",
    smtpHost: owner.smtpHost || "smtp.goodjob.example.test",
    smtpUser: owner.smtpUser || "sales@goodjob.example.test",
    smtpPassword: owner.smtpPassword || "test-password",
    smtpPort: owner.smtpPort ?? 465,
    smtpSecure: owner.smtpSecure ?? true
  });

  setOutboundEmailDispatchObserverForTest(() => {
    dispatchCount += 1;
  });
  const userBefore = {
    lastDevelopmentEmailAt: owner.lastDevelopmentEmailAt,
    lastDevelopmentEmailTo: owner.lastDevelopmentEmailTo,
    lastDevelopmentEmailSubject: owner.lastDevelopmentEmailSubject
  };
  const touchpointCountBefore = store.prospectTouchpoints.length;
  const todoCountBefore = store.todos.length;

  const allowedSend = await request(
    `/api/prospect-list/${encodeURIComponent(candidate.id)}/send-development-email`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        to: candidate.contactInfo,
        subject: "Outreach without qualification gates",
        body: "Qualification gates were removed, so this candidate email is accepted.",
        requestId: "allowed-outreach-http-request"
      })
    }
  );

  assert.equal(allowedSend.response.ok, true, JSON.stringify(allowedSend.json));
  assert.equal(dispatchCount, 1, "allowed request must dispatch exactly once");
  assert.equal(store.prospectTouchpoints.length, touchpointCountBefore + 1);
  assert.equal(candidate.lastDevelopmentEmailTo, candidate.contactInfo);
  assert.notDeepEqual({
    lastDevelopmentEmailAt: owner.lastDevelopmentEmailAt,
    lastDevelopmentEmailTo: owner.lastDevelopmentEmailTo,
    lastDevelopmentEmailSubject: owner.lastDevelopmentEmailSubject
  }, userBefore);
  void todoCountBefore;

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
    whatsappMessages: store.whatsappMessages.length
  };
  // 资格审核链已移除：带搜客血缘的线索 / 客户发信不再要求正式身份与人工批准。
  const allowedRequests = [
    request(`/api/leads/${encodeURIComponent(lead.id)}/send-email`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        to: lead.email,
        subject: "Managed lead email allowed",
        body: "Managed lineage emails no longer require formal identity records.",
        requestId: "managed-lead-send-http"
      })
    }),
    request("/api/development-email/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        entityType: "lead",
        entityId: lead.id,
        to: lead.email,
        subject: "Generic lead email allowed",
        body: "Generic lead sends no longer require formal identity records.",
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
        subject: "Generic customer email allowed",
        body: "Generic customer sends no longer require formal identity records.",
        nextFollowAt: ""
      })
    })
  ];
  for (const allowedRequest of await Promise.all(allowedRequests)) {
    assert.equal(allowedRequest.response.ok, true, JSON.stringify(allowedRequest.json));
  }
  assert.equal(dispatchCount, sideEffectsBefore.dispatchCount + 3);
  assert.equal(store.whatsappMessages.length, sideEffectsBefore.whatsappMessages);

  console.log("Prospect outreach HTTP gate tests passed");
} finally {
  setOutboundEmailDispatchObserverForTest(null);
  if (ownerMailOriginal) {
    const ownerNow = store.users.find((item) => item.email === "shirley@goodjob.com");
    if (ownerNow) Object.assign(ownerNow, ownerMailOriginal);
  }
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
