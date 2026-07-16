import assert from "node:assert/strict";
import {
  applyProspectQualificationCommand,
  currentContactabilityDecision,
  listOwnerProspectQualification,
  ProspectQualificationError,
  validateProspectQualificationState
} from "./prospect-qualification.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type {
  Organization,
  ProspectCampaign,
  ProspectCampaignVersion,
  TenantProspect
} from "./types.js";

process.env.PROSPECT_QUALIFICATION_MASTER_SECRET =
  "prospect-qualification-test-master-secret-v1-".repeat(2);

const at = (minute: number) =>
  new Date(Date.UTC(2026, 6, 15, 8, minute)).toISOString();
const hash = (seed: number) => seed.toString(16).padStart(64, "0");

const base = getStore();
const store: CrmStore = {
  ...base,
  mode: "memory",
  organizations: [],
  tenantProspects: [],
  prospectCampaigns: [],
  prospectCampaignVersions: [],
  prospectEvidence: [],
  companyVerificationSnapshots: [],
  prospectIcpPolicySnapshots: [],
  prospectIcpAssessmentSnapshots: [],
  prospectContacts: [],
  prospectContactChannels: [],
  prospectContactVerificationSnapshots: [],
  prospectSuppressionEvents: [],
  prospectContactabilityDecisions: [],
  leads: [],
  leadActivities: [],
  customers: [],
  customerActivities: [],
  deals: [],
  dealEvents: [],
  websiteOpportunities: [],
  async persist() {
    // Isolated contract test.
  },
  async readBarrier() {
    // Isolated contract test.
  }
};

const teamId = "team-qualification-a";
const ownerId = "owner-qualification-a";
const otherOwnerId = "owner-qualification-b";
const organizationId = "org-qualification-a";
const prospectId = "prospect-qualification-a";
const campaignId = "campaign-qualification-a";

const organization: Organization = {
  id: organizationId,
  teamId,
  scopeType: "team",
  scopeId: teamId,
  status: "active",
  legalName: "Qualification Test GmbH",
  normalizedName: "qualification test gmbh",
  organizationHash: hash(1),
  createdAt: at(0)
};
const prospect: TenantProspect = {
  id: prospectId,
  teamId,
  organizationId,
  status: "active",
  latestClassification: "net_new",
  queueState: "pending",
  queueReasonCode: "NET_NEW",
  firstSeenAt: at(0),
  lastSeenAt: at(0),
  lastMaterialChangeAt: at(0),
  lastQueuedAt: at(0),
  lastReviewedAt: "",
  nextReviewAt: "",
  hitCount: 1,
  sourceCount: 1,
  evidenceCount: 0,
  sourceKeyHashes: [hash(2)],
  materialEvidenceKeyHashes: [],
  exclusionScope: "none",
  exclusionMode: "none",
  exclusionReasonCode: "",
  excludedUntil: "",
  leadId: "",
  customerId: "",
  dealId: "",
  version: 1,
  eventCount: 1,
  eventTailHash: hash(3),
  prospectHash: hash(4),
  createdAt: at(0),
  updatedAt: at(0)
};
const campaign: ProspectCampaign = {
  id: campaignId,
  teamId,
  ownerId,
  name: "Qualification Campaign",
  status: "active",
  currentVersion: 1,
  revision: 1,
  createdBy: ownerId,
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: ""
};
const campaignVersion: ProspectCampaignVersion = {
  id: "campaign-version-qualification-a",
  teamId,
  campaignId,
  version: 1,
  snapshot: {
    goal: "Find qualified industrial distributors",
    products: ["industrial lighting"],
    markets: ["DE"],
    customerTypes: ["distributor"],
    applicationScenarios: ["industrial retrofit"],
    icpRules: ["public industrial catalog"],
    exclusionRules: [],
    sourceProviderIds: ["companies-house"]
  },
  contentHash: hash(5),
  changeSummary: "Initial qualification test version",
  createdBy: ownerId,
  createdAt: at(0)
};
store.organizations.push(organization);
store.tenantProspects.push(prospect);
store.prospectCampaigns.push(campaign);
store.prospectCampaignVersions.push(campaignVersion);

const protectedCounts = {
  leads: store.leads.length,
  customers: store.customers.length,
  deals: store.deals.length,
  websiteOpportunities: store.websiteOpportunities.length
};

const registrationCommand = {
  kind: "append_evidence" as const,
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "evidence-registration",
  evidenceKind: "company_verification" as const,
  field: "registration_number" as const,
  value: "HRB 123456",
  sourceType: "authoritative_registry" as const,
  providerCode: "companies-house",
  sourceRef: "registry://de/hrb-123456",
  authorityCode: "DE-HRB",
  observedAt: at(1),
  expiresAt: at(120),
  createdAt: at(1)
};
const registration = applyProspectQualificationCommand(
  store,
  registrationCommand
);
assert.equal(registration.replayed, false);
assert.equal(
  applyProspectQualificationCommand(store, registrationCommand).replayed,
  true
);
assert.throws(
  () => applyProspectQualificationCommand(store, {
    ...registrationCommand,
    value: "HRB 999999"
  }),
  (error: unknown) =>
    error instanceof ProspectQualificationError
    && error.code === "QUALIFICATION_IDEMPOTENCY_CONFLICT"
);

const activeStatus = applyProspectQualificationCommand(store, {
  kind: "append_evidence",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "evidence-active",
  evidenceKind: "company_verification",
  field: "operating_status",
  value: "active",
  sourceType: "authoritative_registry",
  providerCode: "companies-house",
  sourceRef: "registry://de/hrb-123456/status",
  authorityCode: "DE-HRB",
  observedAt: at(2),
  expiresAt: at(120),
  createdAt: at(2)
});
const productEvidence = applyProspectQualificationCommand(store, {
  kind: "append_evidence",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "evidence-product",
  evidenceKind: "icp",
  field: "product_match",
  value: "industrial lighting distributor catalog",
  sourceType: "official_website",
  providerCode: "official-website",
  sourceRef: "https://qualification.example/products",
  observedAt: at(3),
  expiresAt: at(120),
  createdAt: at(3)
});
const contactEvidence = applyProspectQualificationCommand(store, {
  kind: "append_evidence",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "evidence-contact",
  evidenceKind: "contact",
  field: "contact_source",
  value: "sales@qualification.example",
  sourceType: "official_website",
  providerCode: "official-website",
  sourceRef: "https://qualification.example/contact",
  observedAt: at(4),
  expiresAt: at(120),
  createdAt: at(4)
});

const companyVerification = applyProspectQualificationCommand(store, {
  kind: "compute_company_verification",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "company-verification-v1",
  evidenceIds: [
    registration.record.id,
    activeStatus.record.id
  ],
  validUntil: at(110),
  createdAt: at(5)
});
assert.equal(
  "status" in companyVerification.record
    ? companyVerification.record.status
    : "",
  "verified_active"
);

const policy = applyProspectQualificationCommand(store, {
  kind: "publish_icp_policy",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "icp-policy-v1",
  campaignId,
  campaignVersion: 1,
  hardExclusions: ["sanctioned-country"],
  createdAt: at(6)
});
assert.ok("policyHash" in policy.record);

const assessment = applyProspectQualificationCommand(store, {
  kind: "assess_icp",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "icp-assessment-v1",
  policyId: policy.record.id,
  dimensionScores: {
    productApplicationMatch: 25,
    customerType: 12,
    marketCountry: 9,
    companyAuthenticity: 15,
    purchasingChannelCapability: 12,
    contactability: 8,
    freshness: 5
  },
  evidenceIds: [
    registration.record.id,
    productEvidence.record.id
  ],
  createdAt: at(7)
});
assert.equal(
  "result" in assessment.record ? assessment.record.result : "",
  "qualified"
);
const approvedAssessment = applyProspectQualificationCommand(store, {
  kind: "review_icp",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "icp-assessment-approval-v1",
  assessmentId: assessment.record.id,
  decision: "approved",
  createdAt: at(8)
});
assert.equal(
  "reviewStatus" in approvedAssessment.record
    ? approvedAssessment.record.reviewStatus
    : "",
  "approved"
);

const contact = applyProspectQualificationCommand(store, {
  kind: "add_contact",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "contact-sales-department",
  contactType: "department",
  department: "Sales",
  identityStatus: "source_confirmed",
  sourceEvidenceId: contactEvidence.record.id,
  createdAt: at(9)
});
const channel = applyProspectQualificationCommand(store, {
  kind: "add_contact_channel",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "contact-channel-email",
  contactId: contact.record.id,
  channelType: "email",
  value: "Sales@Qualification.Example",
  sourceEvidenceId: contactEvidence.record.id,
  acquiredAt: at(4),
  createdAt: at(10)
});
assert.equal("value" in channel.record ? channel.record.value : "", 
  "sales@qualification.example");

applyProspectQualificationCommand(store, {
  kind: "verify_contact_channel",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "contact-verification-domain",
  channelId: channel.record.id,
  status: "domain_valid",
  providerCode: "email-verifier",
  verifiedAt: at(11),
  expiresAt: at(100),
  createdAt: at(11)
});
const blockedBeforeVerification = applyProspectQualificationCommand(store, {
  kind: "evaluate_contactability",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "gate-before-verification",
  campaignId,
  campaignVersion: 1,
  channelId: channel.record.id,
  createdAt: at(12)
});
assert.equal(
  "status" in blockedBeforeVerification.record
    ? blockedBeforeVerification.record.status
    : "",
  "blocked"
);

applyProspectQualificationCommand(store, {
  kind: "verify_contact_channel",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "contact-verification-verified",
  channelId: channel.record.id,
  status: "verified",
  providerCode: "email-verifier",
  verifiedAt: at(13),
  expiresAt: at(100),
  createdAt: at(13)
});
const eligible = applyProspectQualificationCommand(store, {
  kind: "evaluate_contactability",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "gate-eligible",
  campaignId,
  campaignVersion: 1,
  channelId: channel.record.id,
  createdAt: at(14)
});
assert.equal(
  "status" in eligible.record ? eligible.record.status : "",
  "eligible"
);
const approved = applyProspectQualificationCommand(store, {
  kind: "approve_contactability",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "gate-approved",
  decisionId: eligible.record.id,
  createdAt: at(15)
});
assert.equal(
  "status" in approved.record ? approved.record.status : "",
  "approved_contactable"
);
assert.equal(currentContactabilityDecision(store, {
  teamId,
  ownerId,
  prospectId,
  campaignId,
  campaignVersion: 1,
  channelId: channel.record.id,
  at: at(16)
})?.status, "approved_contactable");

const otherOwnerView = listOwnerProspectQualification(store, {
  teamId,
  ownerId: otherOwnerId,
  prospectId
});
assert.equal(otherOwnerView.contacts.length, 0);
assert.equal(otherOwnerView.channels.length, 0);
assert.throws(
  () => applyProspectQualificationCommand(store, {
    kind: "verify_contact_channel",
    teamId,
    ownerId: otherOwnerId,
    actorId: otherOwnerId,
    prospectId,
    idempotencyKey: "cross-owner-channel-access",
    channelId: channel.record.id,
    status: "verified",
    providerCode: "email-verifier",
    verifiedAt: at(17),
    createdAt: at(17)
  }),
  (error: unknown) =>
    error instanceof ProspectQualificationError
    && error.code === "CONTACT_CHANNEL_NOT_FOUND"
);

applyProspectQualificationCommand(store, {
  kind: "set_suppression",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "organization-dnc",
  scope: "organization_all",
  action: "imposed",
  reasonCode: "OPTED_OUT",
  effectiveAt: at(18),
  createdAt: at(18)
});
assert.equal(currentContactabilityDecision(store, {
  teamId,
  ownerId,
  prospectId,
  campaignId,
  campaignVersion: 1,
  channelId: channel.record.id,
  at: at(19)
})?.status, "stale");
const blockedAfterSuppression = applyProspectQualificationCommand(store, {
  kind: "evaluate_contactability",
  teamId,
  ownerId,
  actorId: ownerId,
  prospectId,
  idempotencyKey: "gate-after-suppression",
  campaignId,
  campaignVersion: 1,
  channelId: channel.record.id,
  createdAt: at(19)
});
assert.equal(
  "reasonCodes" in blockedAfterSuppression.record
    ? blockedAfterSuppression.record.reasonCodes.includes("SUPPRESSED")
    : false,
  true
);

validateProspectQualificationState(store);
assert.deepEqual({
  leads: store.leads.length,
  customers: store.customers.length,
  deals: store.deals.length,
  websiteOpportunities: store.websiteOpportunities.length
}, protectedCounts);

console.log("Prospect qualification gate tests passed");
