import assert from "node:assert/strict";
import {
  applyProspectQualificationCommand,
  currentContactabilityDecision,
  prospectCandidateQualificationBasisHash,
  prospectCandidateQualificationChangedFields
} from "./prospect-qualification.js";
import {
  approveProspectContactability,
  approveProspectIcpQualification,
  evaluateProspectContactability,
  prospectIcpQualificationSchema,
  prospectQualificationView,
  recordProspectChannelQualification,
  recordProspectCompanyQualification,
  recordProspectIcpQualification
} from "./prospect-qualification-workflow.js";
import {
  assertCrmOutreachEligible,
  assertProspectEmailOutreachEligible,
  ProspectOutreachEligibilityError
} from "./prospect-outreach-eligibility.js";
import { prospectCandidateQualificationCounts } from "./prospect-scorecard.js";
import { getStore, type CrmStore } from "./store.js";
import type {
  Customer,
  Lead,
  Organization,
  ProspectCampaign,
  ProspectCampaignVersion,
  ProspectSearchRun,
  TenantProspect,
  WebsiteOpportunity
} from "./types.js";

process.env.PROSPECT_QUALIFICATION_MASTER_SECRET =
  "prospect-workflow-test-master-secret-v1-".repeat(2);

const now = Date.now();
const at = (days: number) => new Date(now + days * 86400000).toISOString();
const hash = (seed: number) => seed.toString(16).padStart(64, "0");

function fixture() {
  const base = getStore();
  const teamId = "team-workflow";
  const ownerId = "owner-workflow";
  const organizationId = "org-workflow";
  const prospectId = "prospect-workflow";
  const campaignId = "campaign-workflow";
  const candidateId = "candidate-workflow";
  const organization: Organization = {
    id: organizationId,
    teamId,
    scopeType: "team",
    scopeId: teamId,
    status: "active",
    legalName: "Workflow Test Limited",
    normalizedName: "workflow test limited",
    organizationHash: hash(1),
    createdAt: at(-5)
  };
  const prospect: TenantProspect = {
    id: prospectId,
    teamId,
    organizationId,
    status: "active",
    latestClassification: "net_new",
    queueState: "pending",
    queueReasonCode: "NET_NEW",
    firstSeenAt: at(-5),
    lastSeenAt: at(-5),
    lastMaterialChangeAt: at(-5),
    lastQueuedAt: at(-5),
    lastReviewedAt: "",
    nextReviewAt: "",
    hitCount: 1,
    sourceCount: 1,
    evidenceCount: 1,
    sourceKeyHashes: [hash(2)],
    materialEvidenceKeyHashes: [hash(3)],
    exclusionScope: "none",
    exclusionMode: "none",
    exclusionReasonCode: "",
    excludedUntil: "",
    leadId: "",
    customerId: "",
    dealId: "",
    version: 1,
    eventCount: 1,
    eventTailHash: hash(4),
    prospectHash: hash(5),
    createdAt: at(-5),
    updatedAt: at(-5)
  };
  const campaign: ProspectCampaign = {
    id: campaignId,
    teamId,
    ownerId,
    name: "Workflow qualification campaign",
    status: "active",
    currentVersion: 1,
    revision: 1,
    createdBy: ownerId,
    createdAt: at(-5),
    updatedAt: at(-5),
    archivedAt: ""
  };
  const campaignVersion: ProspectCampaignVersion = {
    id: "campaign-version-workflow",
    teamId,
    campaignId,
    version: 1,
    snapshot: {
      goal: "Find UK industrial distributors",
      products: ["industrial lighting"],
      markets: ["GB"],
      customerTypes: ["distributor"],
      applicationScenarios: ["industrial retrofit"],
      icpRules: ["Official catalog confirms product match"],
      exclusionRules: [],
      sourceProviderIds: ["companies_house"]
    },
    contentHash: hash(6),
    changeSummary: "Workflow test",
    createdBy: ownerId,
    createdAt: at(-5)
  };
  const run = {
    id: "run-workflow",
    teamId,
    campaignId,
    campaignVersion: 1,
    strategyId: "strategy-workflow",
    ownerId,
    status: "succeeded",
    createdAt: at(-4),
    updatedAt: at(-4)
  } as ProspectSearchRun;
  const candidate: WebsiteOpportunity = {
    id: candidateId,
    company: organization.legalName,
    business: "Industrial lighting distributor",
    country: "GB",
    website: "https://workflow.example.test/",
    contact: "Purchasing",
    contactInfo: "sales@workflow.example.test",
    description: "Formal workflow test candidate",
    ownerId,
    teamId,
    status: "preview",
    createdAt: at(-4),
    tenantProspectId: prospectId,
    organizationId,
    outreachState: "uncontacted"
  };
  const store = {
    ...base,
    mode: "memory",
    organizations: [organization],
    tenantProspects: [prospect],
    prospectCampaigns: [campaign],
    prospectCampaignVersions: [campaignVersion],
    prospectSearchRuns: [run],
    prospectCandidateProcessingStates: [{
      hitId: "hit-workflow",
      teamId,
      ownerId,
      runId: run.id,
      ledgerId: "ledger-workflow",
      status: "completed",
      failureCode: "",
      candidateId,
      processedAt: at(-4),
      updatedAt: at(-4)
    }],
    prospectCoverageEvents: [],
    prospectEvidence: [],
    prospectCandidateQualificationRevisions: [],
    prospectCandidateQualificationCheckpoints: [],
    companyVerificationSnapshots: [],
    prospectIcpPolicySnapshots: [],
    prospectIcpAssessmentSnapshots: [],
    prospectContacts: [],
    prospectContactChannels: [],
    prospectContactVerificationSnapshots: [],
    prospectSuppressionEvents: [],
    prospectContactabilityDecisions: [],
    websiteOpportunities: [candidate],
    leads: [],
    customers: [],
    leadActivities: [],
    leadSourceEvents: [],
    customerAcquisitionSourceEvents: [],
    async persist() {
      // Isolated in-memory contract test.
    },
    async readBarrier() {
      // The test executes synchronously.
    },
    async applyProspectQualification(command) {
      return applyProspectQualificationCommand(store, command);
    },
    setTenantProspectDisposition: undefined
  } as CrmStore;
  return { store, candidate, prospect, ownerId };
}

async function amendCandidateBasis(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  ownerId: string,
  patch: Partial<Pick<WebsiteOpportunity,
    "company" | "business" | "country" | "website" | "contact"
    | "contactInfo" | "description">>,
  requestId: string
) {
  const before = { ...candidate };
  Object.assign(candidate, patch);
  const changedFields = prospectCandidateQualificationChangedFields(
    before,
    candidate
  );
  if (!changedFields.length) return null;
  return store.applyProspectQualification!({
    kind: "amend_candidate_qualification_basis",
    teamId: candidate.teamId,
    ownerId: candidate.ownerId,
    actorId: ownerId,
    prospectId: candidate.tenantProspectId!,
    idempotencyKey: requestId,
    candidateId: candidate.id,
    changedFields,
    beforeBasisHash: prospectCandidateQualificationBasisHash(before),
    afterBasisHash: prospectCandidateQualificationBasisHash(candidate)
  });
}

function icpInput(requestId: string) {
  return {
    requestId,
    campaignId: "",
    dimensionScores: {
      productApplicationMatch: 28,
      customerType: 14,
      marketCountry: 10,
      companyAuthenticity: 15,
      purchasingChannelCapability: 13,
      contactability: 9,
      freshness: 5
    },
    evidence: [{
      field: "product_match" as const,
      value: "Official industrial lighting distributor catalog",
      sourceType: "official_website" as const,
      providerCode: "official_website_manual_review",
      sourceRef: "https://workflow.example.test/products",
      excerpt: "Industrial lighting distribution",
      observedAt: at(-1),
      expiresAt: at(30)
    }],
    hardGateReasonCodes: []
  };
}

async function approvedFixture() {
  const context = fixture();
  const { store, candidate, ownerId } = context;
  await recordProspectCompanyQualification(store, candidate, ownerId, {
    requestId: "workflow-company-request",
    providerCode: "companies_house",
    registrationNumber: "01234567",
    operatingStatus: "active",
    jurisdiction: "GB",
    sourceRef: "https://find-and-update.company-information.service.gov.uk/company/01234567",
    authorityCode: "GB-COMPANIES-HOUSE",
    observedAt: at(-1),
    validUntil: at(90),
    officialDomain: candidate.website
  });
  await recordProspectIcpQualification(
    store,
    candidate,
    ownerId,
    icpInput("workflow-icp-request")
  );
  const assessment = store.prospectIcpAssessmentSnapshots.at(-1)!;
  await approveProspectIcpQualification(
    store,
    candidate,
    ownerId,
    assessment.id,
    { requestId: "workflow-icp-approval" }
  );
  await recordProspectChannelQualification(store, candidate, ownerId, {
    requestId: "workflow-channel-request",
    contactType: "department",
    name: "",
    department: "Sales",
    title: "",
    identityStatus: "source_confirmed",
    channelType: "email",
    value: candidate.contactInfo,
    sourceType: "official_website",
    sourceProviderCode: "official_website_manual_review",
    sourceRef: "https://workflow.example.test/contact",
    excerpt: "Public sales contact",
    acquiredAt: at(-1),
    verificationBasis: "official_source_manual",
    verificationProviderCode: "human_official_source_review",
    verificationReasonCode: "public_channel_confirmed",
    verifiedAt: at(-1),
    expiresAt: at(30),
    humanConfirmed: true
  });
  assert.deepEqual(
    prospectCandidateQualificationCounts(store, {
      teamId: candidate.teamId,
      ownerId,
      candidateIds: new Set([candidate.id])
    }),
    { reviewReadyCount: 1, vqaCount: 0 },
    "verified company, approved ICP and verified channel must enter RRQ before final approval"
  );
  await evaluateProspectContactability(store, candidate, ownerId, {
    requestId: "workflow-contactability-evaluation",
    channelId: ""
  });
  const eligible = store.prospectContactabilityDecisions.at(-1)!;
  assert.equal(eligible.status, "eligible");
  await approveProspectContactability(
    store,
    candidate,
    ownerId,
    eligible.id,
    { requestId: "workflow-contactability-approval" }
  );
  assert.deepEqual(
    prospectCandidateQualificationCounts(store, {
      teamId: candidate.teamId,
      ownerId,
      candidateIds: new Set([candidate.id])
    }),
    { reviewReadyCount: 1, vqaCount: 1 },
    "final approval must retain RRQ and add VQA"
  );
  return context;
}

assert.equal(prospectIcpQualificationSchema.safeParse({
  requestId: "ai-only-evidence-request",
  dimensionScores: {
    productApplicationMatch: 30,
    customerType: 15,
    marketCountry: 10,
    companyAuthenticity: 15,
    purchasingChannelCapability: 15,
    contactability: 10,
    freshness: 5
  },
  evidence: [{
    field: "product_match",
    value: "AI says this company matches",
    sourceType: "ai_assisted",
    providerCode: "ai",
    sourceRef: "ai://answer",
    observedAt: at(-1)
  }]
}).success, false);

{
  const { store, candidate } = await approvedFixture();
  const view = prospectQualificationView(store, candidate);
  assert.equal(
    view.vqaQualified,
    true,
    JSON.stringify(view.scorecard, null, 2)
  );
  assert.equal(view.nextStep, "ready");
  const eligibility = assertProspectEmailOutreachEligible(
    store,
    candidate,
    "SALES@WORKFLOW.EXAMPLE.TEST"
  );
  assert.equal(eligibility.channel.value, "sales@workflow.example.test");
  assert.throws(
    () => assertProspectEmailOutreachEligible(
      store,
      candidate,
      "attacker@other.example.test"
    ),
    (error: unknown) =>
      error instanceof ProspectOutreachEligibilityError
      && error.code === "PROSPECT_OUTREACH_CHANNEL_MISMATCH"
  );

  const lead: Lead = {
    id: "lead-workflow",
    company: candidate.company,
    contact: candidate.contact,
    country: candidate.country,
    email: candidate.contactInfo,
    phone: "",
    wechat: "",
    source: "prospect_conversion",
    intent: "medium",
    stage: "待跟进",
    status: "new",
    ownerId: candidate.ownerId,
    teamId: candidate.teamId,
    estimatedAmount: 0,
    nextFollowAt: "",
    lastActivityAt: "",
    remark: "",
    convertedCustomerId: "",
    convertedDealId: "",
    sourceType: "outbound",
    sourceChannel: "prospect_conversion",
    sourceCampaign: "campaign-workflow",
    externalId: candidate.tenantProspectId!,
    sourceUrl: candidate.website,
    createdAt: at(0)
  };
  candidate.leadId = lead.id;
  store.leads.push(lead);
  store.leadSourceEvents.push({
    id: "lead-source-workflow",
    leadId: lead.id,
    sourceType: "outbound",
    channel: "prospect_conversion",
    campaign: "campaign-workflow",
    externalId: candidate.tenantProspectId!,
    sourceUrl: candidate.website,
    occurredAt: at(0),
    receivedAt: at(0),
    rawPayload: JSON.stringify({ prospectId: candidate.tenantProspectId }),
    ownerId: candidate.ownerId,
    teamId: candidate.teamId
  });
  const formalProspect = store.tenantProspects[0]!;
  formalProspect.status = "converted";
  formalProspect.queueState = "converted";
  formalProspect.leadId = lead.id;
  assert.equal(assertCrmOutreachEligible(store, {
    target: { entityType: "lead", entity: lead },
    actorId: lead.ownerId,
    channel: "email",
    recipient: lead.email
  }).mode, "prospect_managed");

  const customer: Customer = {
    id: "customer-workflow",
    company: candidate.company,
    country: candidate.country,
    contact: candidate.contact,
    ownerId: candidate.ownerId,
    teamId: candidate.teamId,
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
  candidate.customerId = customer.id;
  store.customers.push(customer);
  store.customerAcquisitionSourceEvents.push({
    id: "customer-source-workflow",
    teamId: candidate.teamId,
    ownerId: candidate.ownerId,
    customerId: customer.id,
    leadId: lead.id,
    leadSourceEventId: "lead-source-workflow",
    prospectId: candidate.tenantProspectId!,
    organizationId: candidate.organizationId!,
    sourceChannel: "prospect_conversion",
    sourceCampaign: "campaign-workflow",
    sourceUrl: candidate.website,
    mode: "create_new",
    processingKeyHash: hash(20),
    requestHash: hash(21),
    createdAt: at(0)
  });
  assert.equal(assertCrmOutreachEligible(store, {
    target: { entityType: "customer", entity: customer },
    actorId: customer.ownerId,
    channel: "email",
    recipient: candidate.contactInfo
  }).mode, "prospect_managed");
}

{
  const { store, candidate, prospect } = await approvedFixture();
  prospect.status = "do_not_contact";
  prospect.queueState = "suppressed";
  prospect.exclusionMode = "permanent";
  assert.throws(
    () => assertProspectEmailOutreachEligible(
      store,
      candidate,
      candidate.contactInfo
    ),
    (error: unknown) =>
      error instanceof ProspectOutreachEligibilityError
      && error.code === "PROSPECT_OUTREACH_DO_NOT_CONTACT"
  );
  assert.equal(
    prospectQualificationView(store, candidate).scorecard?.contactReadiness.status,
    "blocked"
  );
}

{
  const { store, candidate } = await approvedFixture();
  const approved = store.prospectContactabilityDecisions.at(-1)!;
  const expiredDecision = currentContactabilityDecision(store, {
    teamId: approved.teamId,
    ownerId: approved.ownerId,
    prospectId: approved.prospectId,
    campaignId: approved.campaignId,
    campaignVersion: approved.campaignVersion,
    channelId: approved.channelId,
    at: at(31)
  });
  assert.equal(
    expiredDecision?.status,
    "stale",
    JSON.stringify(expiredDecision, null, 2)
  );
  const expiredView = prospectQualificationView(store, candidate, at(31));
  assert.equal(
    expiredView.scorecard?.vqa.qualified,
    false,
    JSON.stringify(expiredView.scorecard, null, 2)
  );
  assert.throws(
    () => assertProspectEmailOutreachEligible(
      store,
      candidate,
      candidate.contactInfo,
      at(31)
    ),
    (error: unknown) =>
      error instanceof ProspectOutreachEligibilityError
      && error.code === "PROSPECT_OUTREACH_NOT_VQA"
  );
}

{
  const { store, candidate, ownerId } = await approvedFixture();
  const channel = store.prospectContactChannels.at(-1)!;
  await store.applyProspectQualification!({
    kind: "verify_contact_channel",
    teamId: candidate.teamId,
    ownerId,
    actorId: ownerId,
    prospectId: candidate.tenantProspectId!,
    idempotencyKey: "workflow-channel-bounced",
    channelId: channel.id,
    status: "bounced",
    providerCode: "outreach_delivery",
    reasonCode: "smtp_bounce",
    verifiedAt: at(1),
    createdAt: at(1)
  });
  assert.throws(
    () => assertProspectEmailOutreachEligible(
      store,
      candidate,
      candidate.contactInfo,
      at(2)
    ),
    (error: unknown) =>
      error instanceof ProspectOutreachEligibilityError
      && error.code === "PROSPECT_OUTREACH_NOT_VQA"
  );
}

{
  const { store, candidate, ownerId } = await approvedFixture();
  await amendCandidateBasis(store, candidate, ownerId, {
    company: "Workflow Test Holdings Limited"
  }, "workflow-amend-company");
  const view = prospectQualificationView(store, candidate);
  assert.equal(view.vqaQualified, false);
  assert.deepEqual(view.stageCurrency, {
    company: false,
    icp: false,
    channel: false,
    contactability: false
  });
  assert.equal(view.nextStep, "verify_company");
}

{
  const { store, candidate, ownerId } = await approvedFixture();
  const originalBusiness = candidate.business;
  await amendCandidateBasis(store, candidate, ownerId, {
    business: "Industrial automation distributor"
  }, "workflow-amend-business");
  let view = prospectQualificationView(store, candidate);
  assert.equal(view.vqaQualified, false);
  assert.deepEqual(view.stageCurrency, {
    company: true,
    icp: false,
    channel: true,
    contactability: false
  });
  assert.equal(view.nextStep, "assess_icp");

  await amendCandidateBasis(store, candidate, ownerId, {
    business: originalBusiness
  }, "workflow-revert-business");
  view = prospectQualificationView(store, candidate);
  assert.equal(view.vqaQualified, false, "restoring old text must not revive approval");
  assert.equal(view.stageCurrency.icp, false);
  assert.equal(view.stageCurrency.contactability, false);
  assert.equal(store.prospectCandidateQualificationRevisions.length, 2);

  await recordProspectIcpQualification(
    store,
    candidate,
    ownerId,
    icpInput("workflow-requalified-icp")
  );
  const assessment = store.prospectIcpAssessmentSnapshots.at(-1)!;
  await approveProspectIcpQualification(
    store,
    candidate,
    ownerId,
    assessment.id,
    { requestId: "workflow-requalified-icp-approval" }
  );
  view = prospectQualificationView(store, candidate);
  assert.equal(view.stageCurrency.icp, true);
  assert.equal(view.stageCurrency.contactability, false);
  assert.equal(view.vqaQualified, false);

  await evaluateProspectContactability(store, candidate, ownerId, {
    requestId: "workflow-requalified-contactability",
    channelId: ""
  });
  const decision = store.prospectContactabilityDecisions.at(-1)!;
  assert.equal(decision.status, "eligible");
  await approveProspectContactability(
    store,
    candidate,
    ownerId,
    decision.id,
    { requestId: "workflow-requalified-contactability-approval" }
  );
  view = prospectQualificationView(store, candidate);
  assert.equal(view.stageCurrency.contactability, true);
  assert.equal(view.vqaQualified, true);
}

{
  const { store, candidate, ownerId } = await approvedFixture();
  await amendCandidateBasis(store, candidate, ownerId, {
    contactInfo: "new.sales@workflow.example.test"
  }, "workflow-amend-channel");
  const view = prospectQualificationView(store, candidate);
  assert.equal(view.vqaQualified, false);
  assert.deepEqual(view.stageCurrency, {
    company: true,
    icp: true,
    channel: false,
    contactability: false
  });
  assert.equal(view.nextStep, "verify_channel");
}

{
  const { store, candidate, ownerId } = await approvedFixture();
  const beforeHash = prospectCandidateQualificationBasisHash(candidate);
  const beforeRevisionCount =
    store.prospectCandidateQualificationRevisions.length;
  const result = await amendCandidateBasis(store, candidate, ownerId, {
    company: `  ${candidate.company.toLocaleUpperCase("en-US")}  `,
    website: "HTTPS://WWW.WORKFLOW.EXAMPLE.TEST"
  }, "workflow-normalized-equivalent");
  assert.equal(result, null);
  assert.equal(prospectCandidateQualificationBasisHash(candidate), beforeHash);
  assert.equal(
    store.prospectCandidateQualificationRevisions.length,
    beforeRevisionCount
  );
  assert.equal(prospectQualificationView(store, candidate).vqaQualified, true);
}

console.log("Prospect qualification workflow tests passed");
