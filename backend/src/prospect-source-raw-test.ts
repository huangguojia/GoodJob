import assert from "node:assert/strict";
import {
  PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
  ProspectSourceRawError,
  appendProspectSourceRawBatch,
  prospectProviderRawArtifactHash
} from "./prospect-source-raw.js";
import type {
  AppendProspectSourceRawBatchInput,
  ProspectProviderSourceRecordInput
} from "./prospect-source-raw.js";
import { getStore } from "./store.js";

const store = getStore();
const original = {
  batches: structuredClone(store.prospectSourceRawBatches),
  records: structuredClone(store.prospectSourceRawRecords),
  hits: structuredClone(store.prospectSourceRawHits)
};

const envelopeSecret = "raw-envelope-test-secret-".repeat(2);
const identitySecret = "raw-identity-test-secret-".repeat(2);
const policy = {
  licensePolicy: "test-public-api",
  retentionPolicy: "test-30-days",
  retentionDays: 30
};

function input(
  sequence: number,
  sourceRecords: ProspectProviderSourceRecordInput[],
  overrides: Partial<AppendProspectSourceRawBatchInput> = {}
): AppendProspectSourceRawBatchInput {
  const suffix = String(sequence).padStart(3, "0");
  return {
    teamId: "raw-team-a",
    ownerId: "raw-owner-a",
    runId: `raw-run-${suffix}`,
    shardId: `raw-shard-${suffix}`,
    jobId: `raw-job-${suffix}`,
    attemptId: `raw-attempt-${suffix}`,
    ledgerId: `raw-ledger-${suffix}`,
    pageId: `raw-page-${suffix}`,
    providerCode: "fake.raw-provider",
    connectionId: "fake.raw-provider:default",
    endpointCode: "company-search",
    adapterVersion: "fake-adapter-v1",
    responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
    responseHash: sequence.toString(16).padStart(64, "0"),
    settlementHash: (sequence + 1).toString(16).padStart(64, "0"),
    rawArtifactHash: prospectProviderRawArtifactHash(sourceRecords),
    sourceRecords,
    policy,
    envelopeSecret,
    identitySecret,
    createdAt: `2026-07-14T01:${suffix.slice(1)}:00.000Z`,
    ...overrides
  };
}

const firstSource: ProspectProviderSourceRecordInput = {
  providerRecordId: "company-001",
  sourceUrl: "https://example.test/company/001",
  fetchedAt: "2026-07-14T01:00:01.000Z",
  payload: {
    companyName: "Example Industrial Lighting GmbH",
    country: "DE"
  }
};

try {
  store.prospectSourceRawBatches.length = 0;
  store.prospectSourceRawRecords.length = 0;
  store.prospectSourceRawHits.length = 0;

  const duplicateBatchInput = input(1, [firstSource, firstSource]);
  const duplicateBatch = appendProspectSourceRawBatch(
    store,
    duplicateBatchInput
  );
  assert.equal(duplicateBatch.idempotent, false);
  assert.equal(duplicateBatch.batch.recordCount, 2);
  assert.equal(duplicateBatch.records.length, 1);
  assert.equal(duplicateBatch.hits.length, 2);
  assert.deepEqual(
    duplicateBatch.hits.map((item) => item.ordinal),
    [1, 2]
  );
  assert.equal(
    duplicateBatch.hits[0]?.recordId,
    duplicateBatch.hits[1]?.recordId
  );
  assert.equal(store.prospectSourceRawRecords.length, 1);
  assert.equal(
    store.prospectSourceRawRecords[0]?.encryptedEnvelope.includes(
      "Example Industrial Lighting"
    ),
    false
  );

  const duplicateReplay = appendProspectSourceRawBatch(
    store,
    duplicateBatchInput
  );
  assert.equal(duplicateReplay.idempotent, true);
  assert.deepEqual(duplicateReplay, {
    ...duplicateBatch,
    idempotent: true
  });

  const exactRepeat = appendProspectSourceRawBatch(
    store,
    input(2, [firstSource])
  );
  assert.equal(exactRepeat.idempotent, false);
  assert.equal(store.prospectSourceRawRecords.length, 1);
  assert.equal(
    exactRepeat.records[0]?.id,
    duplicateBatch.records[0]?.id
  );
  assert.equal(
    exactRepeat.records[0]?.encryptedEnvelope,
    duplicateBatch.records[0]?.encryptedEnvelope
  );

  const changedSource: ProspectProviderSourceRecordInput = {
    ...firstSource,
    fetchedAt: "2026-07-14T01:02:01.000Z",
    payload: {
      companyName: "Example Industrial Lighting GmbH",
      country: "DE",
      employeeRange: "51-200"
    }
  };
  const changedVersion = appendProspectSourceRawBatch(
    store,
    input(3, [changedSource])
  );
  assert.equal(changedVersion.records.length, 1);
  assert.equal(store.prospectSourceRawRecords.length, 2);
  assert.notEqual(
    changedVersion.records[0]?.id,
    duplicateBatch.records[0]?.id
  );
  assert.equal(
    changedVersion.records[0]?.sourceIdentityHash,
    duplicateBatch.records[0]?.sourceIdentityHash
  );
  assert.notEqual(
    changedVersion.records[0]?.artifactHash,
    duplicateBatch.records[0]?.artifactHash
  );

  const endpointIsolated = appendProspectSourceRawBatch(
    store,
    input(4, [firstSource], {
      endpointCode: "company-detail"
    })
  );
  assert.equal(store.prospectSourceRawRecords.length, 3);
  assert.notEqual(
    endpointIsolated.records[0]?.sourceIdentityHash,
    duplicateBatch.records[0]?.sourceIdentityHash
  );

  const tenantIsolated = appendProspectSourceRawBatch(
    store,
    input(5, [firstSource], {
      teamId: "raw-team-b",
      ownerId: "raw-owner-b"
    })
  );
  assert.equal(store.prospectSourceRawRecords.length, 4);
  assert.notEqual(
    tenantIsolated.records[0]?.id,
    duplicateBatch.records[0]?.id
  );
  assert.notEqual(
    tenantIsolated.records[0]?.sourceIdentityHash,
    duplicateBatch.records[0]?.sourceIdentityHash
  );

  const emptyInput = input(6, []);
  const emptyBatch = appendProspectSourceRawBatch(store, emptyInput);
  assert.equal(emptyBatch.idempotent, false);
  assert.equal(emptyBatch.batch.recordCount, 0);
  assert.deepEqual(emptyBatch.records, []);
  assert.deepEqual(emptyBatch.hits, []);
  assert.equal(
    appendProspectSourceRawBatch(store, emptyInput).idempotent,
    true
  );

  const beforeInvalidArtifact = {
    batches: structuredClone(store.prospectSourceRawBatches),
    records: structuredClone(store.prospectSourceRawRecords),
    hits: structuredClone(store.prospectSourceRawHits)
  };
  assert.throws(
    () => appendProspectSourceRawBatch(store, input(7, [firstSource], {
      rawArtifactHash: "0".repeat(64)
    })),
    (error: unknown) =>
      error instanceof ProspectSourceRawError
      && error.code === "PROSPECT_SOURCE_RAW_CONFLICT"
  );
  assert.deepEqual({
    batches: store.prospectSourceRawBatches,
    records: store.prospectSourceRawRecords,
    hits: store.prospectSourceRawHits
  }, beforeInvalidArtifact);

  const firstRecord = store.prospectSourceRawRecords.find((item) =>
    item.id === duplicateBatch.records[0]?.id
  )!;
  const originalEnvelope = firstRecord.encryptedEnvelope;
  firstRecord.encryptedEnvelope = `${originalEnvelope.slice(0, -1)}${
    originalEnvelope.endsWith("A") ? "B" : "A"
  }`;
  assert.throws(
    () => appendProspectSourceRawBatch(store, duplicateBatchInput),
    (error: unknown) =>
      error instanceof ProspectSourceRawError
      && error.code === "PROSPECT_SOURCE_RAW_CONFLICT"
  );
  firstRecord.encryptedEnvelope = originalEnvelope;

  const firstHit = store.prospectSourceRawHits.find((item) =>
    item.batchId === duplicateBatch.batch.id && item.ordinal === 1
  )!;
  firstHit.ordinal = 3;
  assert.throws(
    () => appendProspectSourceRawBatch(store, duplicateBatchInput),
    (error: unknown) =>
      error instanceof ProspectSourceRawError
      && error.code === "PROSPECT_SOURCE_RAW_CONFLICT"
  );
  firstHit.ordinal = 1;

  const storedBatch = store.prospectSourceRawBatches.find((item) =>
    item.id === duplicateBatch.batch.id
  )!;
  const originalBatchHash = storedBatch.batchHash;
  storedBatch.batchHash = "f".repeat(64);
  assert.throws(
    () => appendProspectSourceRawBatch(store, duplicateBatchInput),
    (error: unknown) =>
      error instanceof ProspectSourceRawError
      && error.code === "PROSPECT_SOURCE_RAW_CONFLICT"
  );
  storedBatch.batchHash = originalBatchHash;

  console.log("Prospect source raw persistence tests passed");
} finally {
  store.prospectSourceRawBatches.splice(
    0,
    store.prospectSourceRawBatches.length,
    ...original.batches
  );
  store.prospectSourceRawRecords.splice(
    0,
    store.prospectSourceRawRecords.length,
    ...original.records
  );
  store.prospectSourceRawHits.splice(
    0,
    store.prospectSourceRawHits.length,
    ...original.hits
  );
}
