import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ProspectCandidatePipeline } from "./prospect-candidate-pipeline.js";
import {
  PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
  appendProspectSourceRawBatch,
  prospectProviderRawArtifactHash,
  type ProspectProviderSourceRecordInput
} from "./prospect-source-raw.js";
import { getStore } from "./store.js";
import type { ProviderCatalogItem } from "./types.js";

const store = getStore();
const teamId = "candidate-dedup-team";
const ownerId = "candidate-dedup-owner";
const providerCode = "candidate_dedup_fixture";
const envelopeSecret = "candidate-dedup-envelope-secret-at-least-32-characters";
const originalPersist = store.persist;
const originalPersistCandidateMutation = store.persistProspectCandidateMutation;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function catalog(): ProviderCatalogItem {
  const now = "2026-08-15T00:00:00.000Z";
  return {
    id: `provider_${providerCode}`,
    code: providerCode,
    name: "Candidate dedup fixture",
    category: "web",
    sourceLevel: "public_web",
    accessMode: "api",
    baseUrl: "https://directory.example.test",
    officialDocsUrl: "",
    capabilities: ["company"],
    allowedFields: [
      "company", "officialWebsite", "country", "business", "contact",
      "contactInfo", "description", "providerRecordId", "sourceUrl",
      "recordType", "evidenceSummary", "matchedFields"
    ],
    fieldAuthority: {
      company: "discovery",
      officialWebsite: "discovery",
      contact: "discovery",
      contactInfo: "discovery",
      providerRecordId: "discovery"
    },
    licensePolicy: { tier: "free", requiresKey: false },
    defaultRatePolicy: {},
    retentionPolicy: { mode: "provider_terms", retentionDays: 30 },
    status: "active",
    version: "candidate-dedup-test-v1",
    reviewedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function sourceRecord(
  sequence: number,
  contactInfo = ""
): ProspectProviderSourceRecordInput {
  const fetchedAt = `2026-08-15T00:0${sequence}:00.000Z`;
  const providerRecordId = `directory-record-${sequence}`;
  return {
    providerRecordId,
    sourceUrl: `https://directory.example.test/company/${sequence}`,
    fetchedAt,
    payload: {
      company: "Northstar Lighting LLC",
      officialWebsite: "https://northstar-lighting.example",
      website: "https://northstar-lighting.example",
      country: "US",
      business: "Lighting distributor",
      contact: "",
      contactInfo,
      description: "Public directory result",
      providerRecordId,
      sourceUrl: `https://directory.example.test/company/${sequence}`,
      recordType: "company",
      fetchedAt,
      payloadHash: hash(`${providerRecordId}:${contactInfo}`),
      evidenceSummary: "Public company directory entry",
      matchedFields: contactInfo
        ? ["company", "officialWebsite", "country", "contactInfo"]
        : ["company", "officialWebsite", "country"],
      adapterVersion: "candidate-dedup-test-v1",
      catalogPolicyVersion: "candidate-dedup-test-v1",
      sourceLevel: "public_web",
      retentionPolicyRef: "test-30-days"
    }
  };
}

function appendRun(sequence: number, contactInfo = "") {
  const sourceRecords = [sourceRecord(sequence, contactInfo)];
  return appendProspectSourceRawBatch(store, {
    teamId,
    ownerId,
    runId: `candidate-dedup-run-${sequence}`,
    shardId: `candidate-dedup-shard-${sequence}`,
    jobId: `candidate-dedup-job-${sequence}`,
    attemptId: `candidate-dedup-attempt-${sequence}`,
    ledgerId: `candidate-dedup-ledger-${sequence}`,
    pageId: `candidate-dedup-page-${sequence}`,
    providerCode,
    connectionId: `${providerCode}:default`,
    endpointCode: "company-search",
    adapterVersion: "candidate-dedup-test-v1",
    responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
    responseHash: hash(`response-${sequence}`),
    settlementHash: hash(`settlement-${sequence}`),
    rawArtifactHash: prospectProviderRawArtifactHash(sourceRecords),
    sourceRecords,
    policy: {
      licensePolicy: "test-public-api",
      retentionPolicy: "test-30-days",
      retentionDays: 30
    },
    envelopeSecret,
    identitySecret: "candidate-dedup-identity-secret-at-least-32-characters",
    createdAt: `2026-08-15T00:0${sequence}:00.000Z`
  });
}

const snapshots = {
  catalog: structuredClone(store.providerCatalog),
  opportunities: structuredClone(store.websiteOpportunities),
  batches: structuredClone(store.prospectSourceRawBatches),
  records: structuredClone(store.prospectSourceRawRecords),
  hits: structuredClone(store.prospectSourceRawHits),
  processing: structuredClone(store.prospectCandidateProcessingStates || [])
};

try {
  store.persist = async () => undefined;
  store.persistProspectCandidateMutation = async (mutation) => mutation().value;
  store.providerCatalog.push(catalog());
  const pipeline = new ProspectCandidatePipeline({
    store,
    rawEnvelopeSecret: envelopeSecret,
    identitySecret: "candidate-dedup-identity-secret-at-least-32-characters",
    coverageSecret: "candidate-dedup-coverage-secret-at-least-32-characters"
  });

  appendRun(1);
  const first = await pipeline.processPending({ teamId, ownerId });
  assert.equal(first.created, 1);
  assert.equal(first.suppressed, 0);

  appendRun(2);
  const duplicate = await pipeline.processPending({ teamId, ownerId });
  assert.deepEqual(duplicate.failures, []);
  assert.equal(duplicate.created, 0);
  assert.equal(duplicate.suppressed, 1, JSON.stringify(duplicate));
  const duplicateState = store.prospectCandidateProcessingStates?.find((item) =>
    item.runId === "candidate-dedup-run-2"
  );
  assert.equal(duplicateState?.candidateId, undefined);
  assert.equal(
    duplicateState?.failureCode,
    "HISTORICAL_DUPLICATE_NO_CHANGE"
  );

  appendRun(3, "sales@northstar-lighting.example");
  const newContact = await pipeline.processPending({ teamId, ownerId });
  assert.equal(newContact.created, 0);
  assert.equal(newContact.suppressed, 0);
  const newContactState = store.prospectCandidateProcessingStates?.find((item) =>
    item.runId === "candidate-dedup-run-3"
  );
  assert.ok(newContactState?.candidateId);
  assert.equal(newContactState?.failureCode, "");
  const candidates = store.websiteOpportunities.filter((item) =>
    item.teamId === teamId && item.ownerId === ownerId
  );
  assert.equal(candidates.length, 1);
  assert.equal(
    candidates[0]?.contactInfo,
    "sales@northstar-lighting.example"
  );

  console.log("Prospect candidate history dedup tests passed.");
} finally {
  store.persist = originalPersist;
  store.persistProspectCandidateMutation = originalPersistCandidateMutation;
  store.providerCatalog.splice(0, store.providerCatalog.length, ...snapshots.catalog);
  store.websiteOpportunities.splice(
    0,
    store.websiteOpportunities.length,
    ...snapshots.opportunities
  );
  store.prospectSourceRawBatches.splice(
    0,
    store.prospectSourceRawBatches.length,
    ...snapshots.batches
  );
  store.prospectSourceRawRecords.splice(
    0,
    store.prospectSourceRawRecords.length,
    ...snapshots.records
  );
  store.prospectSourceRawHits.splice(
    0,
    store.prospectSourceRawHits.length,
    ...snapshots.hits
  );
  store.prospectCandidateProcessingStates ||= [];
  store.prospectCandidateProcessingStates.splice(
    0,
    store.prospectCandidateProcessingStates.length,
    ...snapshots.processing
  );
}
