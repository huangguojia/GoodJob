import assert from "node:assert/strict";
import {
  DeterministicFakeProspectProvider,
  FakeProspectProviderError
} from "./prospect-fake-provider.js";
import type {
  FakeProspectProviderDispatchRequest,
  FakeProspectProviderSuccess
} from "./prospect-fake-provider.js";
import {
  hasValidProspectProviderDispatchStatusFacts,
  isProspectProviderDispatchTransitionAllowed,
  prospectProviderRequestHash,
  prospectProviderRequestIdempotencyKey
} from "./prospect-provider-request-ledger.js";
import type { ProspectProviderRequestDispatch } from "./types.js";

const idempotencySecret =
  "goodjob-provider-request-ledger-test-secret-2026";

function success(
  acceptedCount: number,
  overrides: Partial<FakeProspectProviderSuccess> = {}
): FakeProspectProviderSuccess {
  return {
    kind: "success",
    acceptedCount,
    rawCount: acceptedCount,
    invalidCount: 0,
    duplicateCount: 0,
    hasMore: false,
    cursor: "",
    partial: false,
    usage: {
      requestUnits: 1,
      resultUnits: acceptedCount
    },
    cost: {
      kind: "unknown",
      amount: null,
      currency: ""
    },
    ...overrides
  };
}

function dispatchRequest(input: {
  logicalRequestNo: number;
  payload?: unknown;
  teamId?: string;
  ownerId?: string;
}): FakeProspectProviderDispatchRequest {
  const teamId = input.teamId || "team-ledger-a";
  const ownerId = input.ownerId || "owner-ledger-a";
  const requestHash = prospectProviderRequestHash({
    contractVersion: "provider-search-v1",
    requestSchemaVersion: "provider-search-request-v1",
    adapterVersion: "fake-v2",
    teamId,
    ownerId,
    runId: "run-ledger-a",
    shardId: "shard-ledger-a",
    checkpointNo: 1,
    logicalRequestNo: input.logicalRequestNo,
    providerCode: "fake-search",
    connectionId: "fake-connection-a",
    connectionRevision: "revision-1",
    endpointCode: "company-search",
    providerPayload: input.payload || {
      keywords: ["industrial lighting"]
    }
  });
  return {
    teamId,
    ownerId,
    runId: "run-ledger-a",
    shardId: "shard-ledger-a",
    providerCode: "fake-search",
    connectionId: "fake-connection-a",
    endpointCode: "company-search",
    adapterVersion: "fake-v2",
    contractVersion: "provider-search-v1",
    requestHash,
    idempotencyKey: prospectProviderRequestIdempotencyKey({
      teamId,
      ownerId,
      connectionId: "fake-connection-a",
      endpointCode: "company-search",
      requestHash
    }, idempotencySecret)
  };
}

const firstRequest = dispatchRequest({ logicalRequestNo: 1 });
assert.equal(
  firstRequest.requestHash,
  dispatchRequest({ logicalRequestNo: 1 }).requestHash
);
assert.equal(
  firstRequest.idempotencyKey,
  dispatchRequest({ logicalRequestNo: 1 }).idempotencyKey
);
assert.notEqual(
  firstRequest.requestHash,
  dispatchRequest({ logicalRequestNo: 2 }).requestHash
);

const provider = new DeterministicFakeProspectProvider({
  "fake-search": [
    { ...success(1), fakeDelayMs: 5 },
    success(2),
    success(3)
  ]
});
const concurrent = await Promise.all([
  provider.dispatch(firstRequest),
  provider.dispatch(firstRequest),
  provider.dispatch(firstRequest)
]);
assert.equal(
  new Set(concurrent.map((item) => item.externalRequestId)).size,
  1
);
assert.equal(
  new Set(concurrent.map((item) => item.responseHash)).size,
  1
);
assert.equal(concurrent.filter((item) => item.replayed).length, 2);
assert.equal(concurrent[0]?.step.kind, "success");
assert.equal(
  concurrent[0]?.step.kind === "success"
    ? concurrent[0].step.acceptedCount
    : -1,
  1
);

const secondRequest = dispatchRequest({ logicalRequestNo: 2 });
const second = await provider.dispatch(secondRequest);
assert.equal(
  second.step.kind === "success" ? second.step.acceptedCount : -1,
  2
);
await assert.rejects(
  provider.dispatch({
    ...secondRequest,
    idempotencyKey: firstRequest.idempotencyKey
  }),
  (error: unknown) =>
    error instanceof FakeProspectProviderError
    && error.code === "IDEMPOTENCY_KEY_REQUEST_MISMATCH"
);

const byKey = await provider.getByIdempotencyKey({
  teamId: firstRequest.teamId,
  ownerId: firstRequest.ownerId,
  providerCode: firstRequest.providerCode,
  connectionId: firstRequest.connectionId,
  endpointCode: firstRequest.endpointCode,
  idempotencyKey: firstRequest.idempotencyKey,
  requestHash: firstRequest.requestHash
});
assert.equal(byKey.responseHash, concurrent[0]?.responseHash);
const byExternalId = await provider.getByExternalRequestId({
  teamId: firstRequest.teamId,
  ownerId: firstRequest.ownerId,
  providerCode: firstRequest.providerCode,
  connectionId: firstRequest.connectionId,
  endpointCode: firstRequest.endpointCode,
  externalRequestId: concurrent[0]!.externalRequestId
});
assert.equal(byExternalId.responseHash, concurrent[0]?.responseHash);
await assert.rejects(
  provider.getByExternalRequestId({
    teamId: "team-ledger-b",
    ownerId: "owner-ledger-b",
    providerCode: firstRequest.providerCode,
    connectionId: firstRequest.connectionId,
    endpointCode: firstRequest.endpointCode,
    externalRequestId: concurrent[0]!.externalRequestId
  }),
  (error: unknown) =>
    error instanceof FakeProspectProviderError
    && error.code === "FAKE_PROVIDER_REQUEST_NOT_FOUND"
);

const calls = provider.listPhysicalCalls();
assert.equal(
  calls.filter((item) => item.operation === "dispatch").length,
  5
);
assert.equal(
  calls.filter((item) => item.providerExecuted).length,
  2
);
assert.equal(
  calls.filter((item) =>
    item.operation !== "dispatch" && item.providerExecuted
  ).length,
  0
);

const interruptedProvider = new DeterministicFakeProspectProvider({
  "fake-search": [{
    ...success(7),
    fakeFaultAfter: "response_generated"
  }]
});
const interruptedRequest = dispatchRequest({ logicalRequestNo: 9 });
await assert.rejects(
  interruptedProvider.dispatch(interruptedRequest),
  (error: unknown) =>
    error instanceof FakeProspectProviderError
    && error.code
      === "FAKE_PROVIDER_RESPONSE_GENERATED_THEN_INTERRUPTED"
);
const recovered = await interruptedProvider.getByIdempotencyKey({
  teamId: interruptedRequest.teamId,
  ownerId: interruptedRequest.ownerId,
  providerCode: interruptedRequest.providerCode,
  connectionId: interruptedRequest.connectionId,
  endpointCode: interruptedRequest.endpointCode,
  idempotencyKey: interruptedRequest.idempotencyKey,
  requestHash: interruptedRequest.requestHash
});
assert.equal(
  recovered.step.kind === "success"
    ? recovered.step.acceptedCount
    : -1,
  7
);
assert.equal(
  interruptedProvider.listPhysicalCalls()
    .filter((item) => item.providerExecuted).length,
  1
);

const responseBindingProvider = new DeterministicFakeProspectProvider({
  "fake-search": [success(1), success(1)]
});
const responseA = await responseBindingProvider.dispatch(
  dispatchRequest({ logicalRequestNo: 20 })
);
const responseB = await responseBindingProvider.dispatch(
  dispatchRequest({ logicalRequestNo: 21 })
);
assert.notEqual(responseA.responseHash, responseB.responseHash);

const unknownDispatch: ProspectProviderRequestDispatch = {
  id: "dispatch-ledger-recovery",
  ledgerId: "ledger-recovery",
  teamId: "team-ledger-a",
  ownerId: "owner-ledger-a",
  runId: "run-ledger-a",
  shardId: "shard-ledger-a",
  attemptId: "attempt-ledger-a",
  dispatchNo: 1,
  operation: "dispatch",
  status: "outcome_unknown",
  idempotencyKey: firstRequest.idempotencyKey,
  requestHash: firstRequest.requestHash,
  replayed: false,
  providerExecuted: true,
  externalRequestId: "",
  responseHash: "",
  errorCode: "REQUEST_OUTCOME_UNKNOWN",
  startedAt: "2026-07-14T01:00:00.000Z",
  confirmedAt: "",
  finishedAt: "2026-07-14T01:00:01.000Z",
  version: 2
};
assert.equal(
  hasValidProspectProviderDispatchStatusFacts(unknownDispatch),
  true
);
const startedDispatch: ProspectProviderRequestDispatch = {
  ...unknownDispatch,
  id: "dispatch-ledger-started",
  ledgerId: "ledger-started",
  status: "started",
  providerExecuted: false,
  errorCode: "",
  confirmedAt: "",
  finishedAt: "",
  version: 1
};
assert.equal(
  hasValidProspectProviderDispatchStatusFacts(startedDispatch),
  true
);
assert.equal(
  hasValidProspectProviderDispatchStatusFacts({
    ...startedDispatch,
    confirmedAt: "2026-07-14T01:00:01.000Z"
  }),
  false,
  "started 状态不得提前出现派发确认时间"
);
assert.equal(
  hasValidProspectProviderDispatchStatusFacts({
    ...startedDispatch,
    providerExecuted: true
  }),
  false,
  "started 状态不得提前宣称 Provider 已执行"
);
assert.equal(
  isProspectProviderDispatchTransitionAllowed(
    "outcome_unknown",
    "response_received"
  ),
  true
);
assert.equal(
  hasValidProspectProviderDispatchStatusFacts({
    ...unknownDispatch,
    status: "response_received",
    externalRequestId: recovered.externalRequestId,
    responseHash: recovered.responseHash,
    errorCode: "",
    version: 3
  }),
  true
);

console.log("Provider Request Ledger v1 Fake Provider tests passed");
