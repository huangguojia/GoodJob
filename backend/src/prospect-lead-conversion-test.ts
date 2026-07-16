import assert from "node:assert/strict";
import {
  convertProspectToLead,
  type ConvertProspectToLeadInput,
  ProspectLeadConversionError
} from "./prospect-lead-conversion.js";
import {
  PROSPECT_COVERAGE_MEMORY_CONTRACT,
  recordProspectCoverage,
  setTenantProspectDisposition
} from "./prospect-coverage-memory.js";
import {
  applyProspectQualificationCommand
} from "./prospect-qualification.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type {
  Lead,
  Organization,
  OrganizationIdentityClaim,
  OrganizationIdentityResolution,
  OrganizationSourceBinding,
  ProspectCampaign,
  ProspectCampaignVersion,
  ProspectRunShard,
  ProspectSearchRun,
  ProspectSourceRawHit,
  ProspectSourceRawRecord
} from "./types.js";

process.env.PROSPECT_QUALIFICATION_MASTER_SECRET =
  "prospect-lead-conversion-qualification-test-v1-".repeat(2);

const coverageSecret =
  "prospect-lead-conversion-coverage-test-secret-v1-".repeat(2);
const at = (minute: number) =>
  new Date(Date.UTC(2026, 6, 15, 8, minute)).toISOString();
const hash = (seed: number) => seed.toString(16).padStart(64, "0");
let sequence = 0;

type Fixture = {
  store: CrmStore;
  teamId: string;
  ownerId: string;
  otherOwnerId: string;
  prospectId: string;
  organizationId: string;
  decisionId: string;
  input: ConvertProspectToLeadInput;
};

function isolatedStore(): CrmStore {
  const base = getStore();
  return {
    ...base,
    mode: "memory",
    organizations: [],
    organizationIdentityClaims: [],
    organizationAcceptedIdentifiers: [],
    organizationIdentityResolutions: [],
    organizationSourceBindings: [],
    organizationIdentityConflicts: [],
    organizationIdentityEvents: [],
    prospectSourceRawRecords: [],
    prospectSourceRawHits: [],
    prospectSearchRuns: [],
    prospectRunShards: [],
    prospectCampaigns: [],
    prospectCampaignVersions: [],
    tenantProspects: [],
    prospectCoverageEvents: [],
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
    leadSourceEvents: [],
    leadActivities: [],
    customers: [],
    customerActivities: [],
    deals: [],
    dealEvents: [],
    websiteOpportunities: [],
    async persist() {
      // Isolated in-memory contract test.
    },
    async readBarrier() {
      // The test executes synchronously.
    }
  };
}

function addCoverageContext(
  store: CrmStore,
  input: {
    suffix: string;
    teamId: string;
    ownerId: string;
    organizationId: string;
    campaignId: string;
  }
) {
  const rawRecordId = `raw-${input.suffix}`;
  const sourceHitId = `hit-${input.suffix}`;
  const resolutionId = `resolution-${input.suffix}`;
  const bindingId = `binding-${input.suffix}`;
  const runId = `run-${input.suffix}`;
  const shardId = `shard-${input.suffix}`;

  const rawRecord: ProspectSourceRawRecord = {
    id: rawRecordId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    providerCode: "conversion.test-provider",
    connectionId: `connection-${input.suffix}`,
    endpointCode: "company-search",
    sourceIdentityHash: hash(sequence + 1),
    artifactHash: hash(sequence + 2),
    envelopeVersion: "provider-raw-v1",
    encryptedEnvelope: "test-only",
    envelopeHash: hash(sequence + 3),
    firstObservedAt: at(0),
    recordHash: hash(sequence + 4),
    createdAt: at(0)
  };
  const sourceHit: ProspectSourceRawHit = {
    id: sourceHitId,
    batchId: `batch-${input.suffix}`,
    recordId: rawRecordId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    runId,
    shardId,
    jobId: `job-${input.suffix}`,
    attemptId: `attempt-${input.suffix}`,
    ledgerId: `ledger-${input.suffix}`,
    pageId: `page-${input.suffix}`,
    ordinal: 1,
    fetchedAt: at(0),
    hitHash: hash(sequence + 5),
    createdAt: at(0)
  };
  const claim: OrganizationIdentityClaim = {
    id: `claim-${input.suffix}`,
    resolutionId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    rawRecordId,
    ordinal: 1,
    kind: "legal_name",
    originalValue: "Conversion Test GmbH",
    normalizedValue: "conversion test gmbh",
    scheme: "",
    jurisdiction: "DE",
    entityType: "legal_entity",
    subjectRef: "company",
    classification: "association_fact",
    normalizerVersion: "conversion-test-v1",
    validatorVersion: "conversion-test-v1",
    authorityProfileCode: "conversion-test",
    observedAt: at(0),
    claimHash: hash(sequence + 6),
    claimFactHash: hash(sequence + 7),
    createdAt: at(0)
  };
  const resolution: OrganizationIdentityResolution = {
    id: resolutionId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    rawRecordId,
    rawArtifactHash: rawRecord.artifactHash,
    processingKeyHash: hash(sequence + 8),
    claimHash: hash(sequence + 9),
    resolverContractVersion: "organization-strong-identity-v1",
    parserVersion: "conversion-test-v1",
    normalizerVersion: "conversion-test-v1",
    authorityProfileCode: "conversion-test",
    authorityProfileVersion: "v1",
    authorityProfileHash: hash(sequence + 10),
    result: "new_entity",
    decisionReasonCode: "NEW_STRONG_IDENTITY",
    organizationId: input.organizationId,
    bindingId,
    conflictId: "",
    matchedIdentifierIds: [],
    acceptedIdentifierIds: [],
    bindingRelationRole: "created_new",
    relationHash: hash(sequence + 11),
    eventCount: 1,
    eventTailHash: hash(sequence + 12),
    resolutionHash: hash(sequence + 13),
    createdAt: at(0)
  };
  const binding: OrganizationSourceBinding = {
    id: bindingId,
    organizationId: input.organizationId,
    resolutionId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    rawRecordId,
    status: "active",
    bindingHash: hash(sequence + 14),
    createdAt: at(0)
  };
  const run = {
    id: runId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    campaignId: input.campaignId,
    strategyId: `strategy-${input.suffix}`
  } as unknown as ProspectSearchRun;
  const shard = {
    id: shardId,
    teamId: input.teamId,
    runId
  } as unknown as ProspectRunShard;

  store.prospectSourceRawRecords.push(rawRecord);
  store.prospectSourceRawHits.push(sourceHit);
  store.organizationIdentityClaims.push(claim);
  store.organizationIdentityResolutions.push(resolution);
  store.organizationSourceBindings.push(binding);
  store.prospectSearchRuns.push(run);
  store.prospectRunShards.push(shard);
  return { resolutionId, sourceHitId };
}

function existingLead(
  id: string,
  teamId: string,
  ownerId: string
): Lead {
  return {
    id,
    company: "Existing Lead GmbH",
    contact: "Purchasing",
    country: "DE",
    email: "buying@example.test",
    phone: "",
    wechat: "",
    source: "manual",
    intent: "中",
    stage: "新线索",
    status: "new",
    ownerId,
    teamId,
    estimatedAmount: 5000,
    nextFollowAt: "",
    lastActivityAt: "",
    remark: "",
    convertedCustomerId: "",
    convertedDealId: "",
    sourceType: "outbound",
    sourceChannel: "manual",
    sourceCampaign: "",
    externalId: "",
    sourceUrl: "",
    createdAt: at(0)
  };
}

function createApprovedFixture(label: string): Fixture {
  sequence += 100;
  const suffix = `${label}-${sequence}`;
  const teamId = `team-${suffix}`;
  const ownerId = `owner-${suffix}`;
  const otherOwnerId = `owner-other-${suffix}`;
  const organizationId = `organization-${suffix}`;
  const campaignId = `campaign-${suffix}`;
  const store = isolatedStore();
  const organization: Organization = {
    id: organizationId,
    teamId,
    scopeType: "team",
    scopeId: teamId,
    status: "active",
    legalName: "Conversion Test GmbH",
    normalizedName: "conversion test gmbh",
    organizationHash: hash(sequence + 20),
    createdAt: at(0)
  };
  const campaign: ProspectCampaign = {
    id: campaignId,
    teamId,
    ownerId,
    name: "Conversion Test Campaign",
    status: "active",
    currentVersion: 1,
    revision: 1,
    createdBy: ownerId,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: ""
  };
  const campaignVersion: ProspectCampaignVersion = {
    id: `campaign-version-${suffix}`,
    teamId,
    campaignId,
    version: 1,
    snapshot: {
      goal: "Find qualified distributors",
      products: ["industrial lighting"],
      markets: ["DE"],
      customerTypes: ["distributor"],
      applicationScenarios: ["industrial retrofit"],
      icpRules: ["public product catalog"],
      exclusionRules: [],
      sourceProviderIds: ["conversion.test-provider"]
    },
    contentHash: hash(sequence + 21),
    changeSummary: "Initial version",
    createdBy: ownerId,
    createdAt: at(0)
  };
  store.organizations.push(organization);
  store.prospectCampaigns.push(campaign);
  store.prospectCampaignVersions.push(campaignVersion);
  const context = addCoverageContext(store, {
    suffix,
    teamId,
    ownerId,
    organizationId,
    campaignId
  });
  const coverage = recordProspectCoverage(store, {
    teamId,
    ownerId,
    resolutionId: context.resolutionId,
    sourceHitId: context.sourceHitId,
    contractVersion: PROSPECT_COVERAGE_MEMORY_CONTRACT,
    evidenceVersion: "material-evidence-v1",
    coveredAt: at(0),
    evidence: [],
    coverageSecret
  });
  const prospectId = coverage.prospect.id;
  const registration = applyProspectQualificationCommand(store, {
    kind: "append_evidence",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `registration-${suffix}`,
    evidenceKind: "company_verification",
    field: "registration_number",
    value: `HRB-${sequence}`,
    sourceType: "authoritative_registry",
    providerCode: "registry-test",
    sourceRef: `registry://conversion/${suffix}`,
    authorityCode: "DE-HRB",
    observedAt: at(1),
    expiresAt: at(80),
    createdAt: at(1)
  });
  const active = applyProspectQualificationCommand(store, {
    kind: "append_evidence",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `active-${suffix}`,
    evidenceKind: "company_verification",
    field: "operating_status",
    value: "active",
    sourceType: "authoritative_registry",
    providerCode: "registry-test",
    sourceRef: `registry://conversion/${suffix}/status`,
    authorityCode: "DE-HRB",
    observedAt: at(2),
    expiresAt: at(80),
    createdAt: at(2)
  });
  const product = applyProspectQualificationCommand(store, {
    kind: "append_evidence",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `product-${suffix}`,
    evidenceKind: "icp",
    field: "product_match",
    value: "industrial lighting distributor catalog",
    sourceType: "official_website",
    providerCode: "official-website",
    sourceRef: `https://${suffix}.example.test/products`,
    observedAt: at(3),
    expiresAt: at(80),
    createdAt: at(3)
  });
  const contactEvidence = applyProspectQualificationCommand(store, {
    kind: "append_evidence",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `contact-evidence-${suffix}`,
    evidenceKind: "contact",
    field: "contact_source",
    value: `sales@${suffix}.example.test`,
    sourceType: "official_website",
    providerCode: "official-website",
    sourceRef: `https://${suffix}.example.test/contact`,
    observedAt: at(4),
    expiresAt: at(80),
    createdAt: at(4)
  });
  applyProspectQualificationCommand(store, {
    kind: "compute_company_verification",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `company-verification-${suffix}`,
    evidenceIds: [registration.record.id, active.record.id],
    validUntil: at(80),
    createdAt: at(5)
  });
  const policy = applyProspectQualificationCommand(store, {
    kind: "publish_icp_policy",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `policy-${suffix}`,
    campaignId,
    campaignVersion: 1,
    hardExclusions: [],
    createdAt: at(6)
  });
  const assessment = applyProspectQualificationCommand(store, {
    kind: "assess_icp",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `assessment-${suffix}`,
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
    evidenceIds: [registration.record.id, product.record.id],
    createdAt: at(7)
  });
  applyProspectQualificationCommand(store, {
    kind: "review_icp",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `assessment-review-${suffix}`,
    assessmentId: assessment.record.id,
    decision: "approved",
    createdAt: at(8)
  });
  const contact = applyProspectQualificationCommand(store, {
    kind: "add_contact",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `contact-${suffix}`,
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
    idempotencyKey: `channel-${suffix}`,
    contactId: contact.record.id,
    channelType: "email",
    value: `sales@${suffix}.example.test`,
    sourceEvidenceId: contactEvidence.record.id,
    acquiredAt: at(4),
    createdAt: at(10)
  });
  applyProspectQualificationCommand(store, {
    kind: "verify_contact_channel",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `channel-verification-${suffix}`,
    channelId: channel.record.id,
    status: "verified",
    providerCode: "email-verifier",
    verifiedAt: at(11),
    expiresAt: at(80),
    createdAt: at(11)
  });
  const eligible = applyProspectQualificationCommand(store, {
    kind: "evaluate_contactability",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `contactability-${suffix}`,
    campaignId,
    campaignVersion: 1,
    channelId: channel.record.id,
    createdAt: at(12)
  });
  const approved = applyProspectQualificationCommand(store, {
    kind: "approve_contactability",
    teamId,
    ownerId,
    actorId: ownerId,
    prospectId,
    idempotencyKey: `approval-${suffix}`,
    decisionId: eligible.record.id,
    createdAt: at(13)
  });
  const decisionId = approved.record.id;
  return {
    store,
    teamId,
    ownerId,
    otherOwnerId,
    prospectId,
    organizationId,
    decisionId,
    input: {
      operationCode: "convert_prospect_to_lead_v1",
      decisionId,
      mode: "create_new",
      existingLeadId: "",
      company: "",
      contact: "",
      country: "DE",
      intent: "高",
      estimatedAmount: 12000,
      nextFollowAt: at(40),
      remark: "人工确认的合格候选",
      teamId,
      ownerId,
      prospectId,
      idempotencyKey: `convert-${suffix}`,
      convertedAt: at(14),
      coverageSecret
    }
  };
}

function isConversionError(code: ProspectLeadConversionError["code"]) {
  return (error: unknown) =>
    error instanceof ProspectLeadConversionError && error.code === code;
}

function testCreateAndIdempotency() {
  const fixture = createApprovedFixture("create");
  const protectedCounts = {
    customers: fixture.store.customers.length,
    deals: fixture.store.deals.length,
    websiteOpportunities: fixture.store.websiteOpportunities.length
  };
  const result = convertProspectToLead(fixture.store, fixture.input);
  assert.equal(result.replayed, false);
  assert.equal(result.created, true);
  assert.equal(result.lead.ownerId, fixture.ownerId);
  assert.equal(result.lead.teamId, fixture.teamId);
  assert.equal(result.lead.company, "Conversion Test GmbH");
  assert.equal(result.lead.email.startsWith("sales@create-"), true);
  assert.equal(result.lead.sourceChannel, "prospect_conversion");
  assert.equal(result.prospect.status, "converted");
  assert.equal(result.prospect.leadId, result.lead.id);
  assert.equal(
    result.coverageEvent.reasonCode,
    "HUMAN_CONFIRMED_LEAD_CONVERSION"
  );
  assert.equal(fixture.store.leads.length, 1);
  assert.equal(fixture.store.leadSourceEvents.length, 1);
  assert.equal(fixture.store.leadActivities.length, 1);
  assert.deepEqual({
    customers: fixture.store.customers.length,
    deals: fixture.store.deals.length,
    websiteOpportunities: fixture.store.websiteOpportunities.length
  }, protectedCounts);

  const replay = convertProspectToLead(fixture.store, fixture.input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.lead.id, result.lead.id);
  assert.equal(fixture.store.leads.length, 1);
  assert.equal(fixture.store.leadSourceEvents.length, 1);
  assert.equal(fixture.store.leadActivities.length, 1);
  assert.throws(
    () => convertProspectToLead(fixture.store, {
      ...fixture.input,
      remark: "同一个幂等键不能修改请求"
    }),
    isConversionError("PROSPECT_LEAD_CONVERSION_IDEMPOTENCY_CONFLICT")
  );
  assert.throws(
    () => convertProspectToLead(fixture.store, {
      ...fixture.input,
      idempotencyKey: `${fixture.input.idempotencyKey}-second`
    }),
    isConversionError("PROSPECT_LEAD_CONVERSION_ALREADY_COMPLETED")
  );
}

function testLinkExistingAndOwnerIsolation() {
  const fixture = createApprovedFixture("link");
  const lead = existingLead(
    "lead-existing-current-owner",
    fixture.teamId,
    fixture.ownerId
  );
  fixture.store.leads.push(lead);
  const result = convertProspectToLead(fixture.store, {
    ...fixture.input,
    mode: "link_existing",
    existingLeadId: lead.id
  });
  assert.equal(result.created, false);
  assert.equal(result.lead.id, lead.id);
  assert.equal(fixture.store.leads.length, 1);
  assert.equal(fixture.store.leadSourceEvents.length, 1);
  assert.equal(fixture.store.leadActivities.length, 1);

  const inaccessible = createApprovedFixture("link-other-owner");
  inaccessible.store.leads.push(existingLead(
    "lead-existing-other-owner",
    inaccessible.teamId,
    inaccessible.otherOwnerId
  ));
  const before = {
    leads: structuredClone(inaccessible.store.leads),
    sources: structuredClone(inaccessible.store.leadSourceEvents),
    activities: structuredClone(inaccessible.store.leadActivities),
    prospects: structuredClone(inaccessible.store.tenantProspects),
    events: structuredClone(inaccessible.store.prospectCoverageEvents)
  };
  assert.throws(
    () => convertProspectToLead(inaccessible.store, {
      ...inaccessible.input,
      mode: "link_existing",
      existingLeadId: "lead-existing-other-owner"
    }),
    isConversionError("PROSPECT_LEAD_CONVERSION_NOT_FOUND")
  );
  assert.deepEqual(inaccessible.store.leads, before.leads);
  assert.deepEqual(inaccessible.store.leadSourceEvents, before.sources);
  assert.deepEqual(inaccessible.store.leadActivities, before.activities);
  assert.deepEqual(inaccessible.store.tenantProspects, before.prospects);
  assert.deepEqual(inaccessible.store.prospectCoverageEvents, before.events);
}

function testApprovalAndTenantGuards() {
  const missing = createApprovedFixture("missing-approval");
  assert.throws(
    () => convertProspectToLead(missing.store, {
      ...missing.input,
      decisionId: "missing-decision"
    }),
    isConversionError("PROSPECT_LEAD_CONVERSION_NOT_APPROVED")
  );

  const stale = createApprovedFixture("stale-approval");
  assert.throws(
    () => convertProspectToLead(stale.store, {
      ...stale.input,
      convertedAt: at(90)
    }),
    isConversionError("PROSPECT_LEAD_CONVERSION_STALE")
  );

  const owner = createApprovedFixture("owner-isolation");
  assert.throws(
    () => convertProspectToLead(owner.store, {
      ...owner.input,
      ownerId: owner.otherOwnerId
    }),
    isConversionError("PROSPECT_LEAD_CONVERSION_NOT_APPROVED")
  );

  const team = createApprovedFixture("team-isolation");
  assert.throws(
    () => convertProspectToLead(team.store, {
      ...team.input,
      teamId: "different-team"
    }),
    isConversionError("PROSPECT_LEAD_CONVERSION_NOT_FOUND")
  );
}

function testDispositionGuards() {
  for (const action of ["exclude_permanent", "do_not_contact"] as const) {
    const fixture = createApprovedFixture(action);
    setTenantProspectDisposition(fixture.store, {
      teamId: fixture.teamId,
      ownerId: fixture.ownerId,
      prospectId: fixture.prospectId,
      requestId: `guard-${action}`,
      operationCode: "set_tenant_prospect_disposition_v1",
      action,
      reasonCode: action === "do_not_contact" ? "OPTED_OUT" : "NOT_A_FIT",
      effectiveAt: at(14),
      coverageSecret
    });
    assert.throws(
      () => convertProspectToLead(fixture.store, {
        ...fixture.input,
        convertedAt: at(15)
      }),
      isConversionError("PROSPECT_LEAD_CONVERSION_NOT_ELIGIBLE")
    );
    assert.equal(fixture.store.leads.length, 0);
    assert.equal(fixture.store.leadSourceEvents.length, 0);
    assert.equal(fixture.store.leadActivities.length, 0);
  }
}

testCreateAndIdempotency();
testLinkExistingAndOwnerIsolation();
testApprovalAndTenantGuards();
testDispositionGuards();

console.log(
  "Prospect human-confirmed lead conversion memory tests passed"
);
