import { createHash, createHmac } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type {
  ProspectExecutionAttempt,
  ProspectExecutionPage,
  ProspectProviderRequestAccountingEvidence,
  ProspectProviderRequestDispatch,
  ProspectProviderRequestDispatchStatus,
  ProspectProviderRequestSettlementKind,
  ProspectProviderRequestStatus
} from "./types.js";

export const PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT =
  "provider_request_ledger_v1";

export interface ProspectProviderRequestHashInput {
  contractVersion: string;
  requestSchemaVersion: string;
  adapterVersion: string;
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  checkpointNo: number;
  logicalRequestNo: number;
  providerCode: string;
  connectionId: string;
  connectionRevision: string;
  endpointCode: string;
  providerPayload: unknown;
}

export interface ProspectProviderResponseHashInput {
  contractVersion: string;
  requestHash: string;
  idempotencyKey: string;
  providerCode: string;
  connectionId: string;
  endpointCode: string;
  externalRequestId: string;
  httpStatus: number | null;
  rawResponseHash: string;
  normalizedResultHash: string;
  accountingEvidenceHash: string;
}

export interface ProspectProviderSettlementHashInput {
  contractVersion: string;
  teamId: string;
  ownerId: string;
  runId: string;
  ledgerId: string;
  requestHash: string;
  idempotencyKey: string;
  externalRequestId: string;
  responseHash: string;
  dispatchId: string;
  attemptId: string;
  settlementKind: Exclude<
    ProspectProviderRequestSettlementKind,
    "" | "cancelled_before_dispatch"
  >;
  settlementAt: string;
  attempt: ProspectExecutionAttempt;
  accountingEvidence: ProspectProviderRequestAccountingEvidence;
  page: ProspectExecutionPage | null;
}

const ledgerTransitions: Record<
  ProspectProviderRequestStatus,
  ReadonlySet<ProspectProviderRequestStatus>
> = {
  prepared: new Set(["dispatch_started", "settled"]),
  dispatch_started: new Set([
    "dispatch_confirmed",
    "response_received",
    "outcome_unknown"
  ]),
  dispatch_confirmed: new Set([
    "response_received",
    "outcome_unknown"
  ]),
  response_received: new Set(["settled", "cancelled_late"]),
  outcome_unknown: new Set([
    "dispatch_started",
    "dispatch_confirmed",
    "response_received",
    "cancelled_late"
  ]),
  settled: new Set(),
  cancelled_late: new Set()
};

const dispatchTransitions: Record<
  ProspectProviderRequestDispatchStatus,
  ReadonlySet<ProspectProviderRequestDispatchStatus>
> = {
  started: new Set([
    "confirmed",
    "response_received",
    "outcome_unknown",
    "rejected"
  ]),
  confirmed: new Set(["response_received", "outcome_unknown"]),
  outcome_unknown: new Set(["confirmed", "response_received"]),
  response_received: new Set(),
  rejected: new Set()
};

export function sha256CanonicalJson(value: unknown) {
  return createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");
}

export function prospectProviderRequestHash(
  input: ProspectProviderRequestHashInput
) {
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    requestSchemaVersion: input.requestSchemaVersion,
    adapterVersion: input.adapterVersion,
    teamId: input.teamId,
    ownerId: input.ownerId,
    runId: input.runId,
    shardId: input.shardId,
    checkpointNo: input.checkpointNo,
    logicalRequestNo: input.logicalRequestNo,
    providerCode: input.providerCode,
    connectionId: input.connectionId,
    connectionRevision: input.connectionRevision,
    endpointCode: input.endpointCode,
    providerPayload: input.providerPayload
  });
}

export function prospectProviderRequestIdempotencyKey(input: {
  teamId: string;
  ownerId: string;
  connectionId: string;
  endpointCode: string;
  requestHash: string;
}, secret: string) {
  if (secret.length < 32) {
    throw new Error("Provider 请求幂等密钥至少需要 32 个字符");
  }
  return createHmac("sha256", secret)
    .update([
      PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
      input.teamId,
      input.ownerId,
      input.connectionId,
      input.endpointCode,
      input.requestHash
    ].join("\u001f"))
    .digest("hex");
}

export function prospectProviderResponseHash(
  input: ProspectProviderResponseHashInput
) {
  return sha256CanonicalJson(input);
}

export function prospectProviderResponseComponentHashes(
  step: { usage: unknown; cost: unknown }
) {
  return {
    rawResponseHash: sha256CanonicalJson({ step }),
    normalizedResultHash: sha256CanonicalJson(step),
    accountingEvidenceHash: prospectProviderAccountingEvidenceHash(step)
  };
}

export function prospectProviderAccountingEvidenceHash(
  step: { usage: unknown; cost: unknown }
) {
  return sha256CanonicalJson({
    usage: step.usage,
    cost: step.cost
  });
}

export function prospectProviderAccountingEvidenceRef(input: {
  ledgerId: string;
  responseHash: string;
  accountingEvidenceHash: string;
}) {
  return `sha256:${sha256CanonicalJson({
    contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
    evidenceVersion: "provider-accounting-evidence-v1",
    ...input
  })}`;
}

export function prospectProviderSettlementHash(
  input: ProspectProviderSettlementHashInput
) {
  return sha256CanonicalJson({
    contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
    settlementVersion: "provider-response-settlement-v1",
    ...input
  });
}

export function prospectProviderDispatchConfirmationRef(input: {
  ledgerId: string;
  dispatchId: string;
  externalRequestId: string;
  responseHash: string;
}) {
  return `sha256:${sha256CanonicalJson(input)}`;
}

export function prospectProviderResponseEvidenceRef(input: {
  ledgerId: string;
  dispatchId: string;
  requestHash: string;
  idempotencyKey: string;
  externalRequestId: string;
  responseHash: string;
}) {
  return `sha256:${sha256CanonicalJson({
    contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
    envelopeVersion: "provider-response-v1",
    ...input
  })}`;
}

export function isProspectProviderRequestTransitionAllowed(
  fromStatus: ProspectProviderRequestStatus,
  toStatus: ProspectProviderRequestStatus
) {
  return ledgerTransitions[fromStatus].has(toStatus);
}

export function isProspectProviderDispatchTransitionAllowed(
  fromStatus: ProspectProviderRequestDispatchStatus,
  toStatus: ProspectProviderRequestDispatchStatus
) {
  return dispatchTransitions[fromStatus].has(toStatus);
}

export function hasValidProspectProviderDispatchStatusFacts(
  dispatch: ProspectProviderRequestDispatch
) {
  if (dispatch.status === "started") {
    return !dispatch.finishedAt
      && !dispatch.confirmedAt
      && !dispatch.externalRequestId
      && !dispatch.responseHash
      && !dispatch.errorCode
      && !dispatch.replayed
      && !dispatch.providerExecuted;
  }
  if (dispatch.status === "confirmed") {
    return Boolean(dispatch.confirmedAt)
      && Boolean(dispatch.externalRequestId)
      && !dispatch.finishedAt
      && !dispatch.responseHash
      && !dispatch.errorCode;
  }
  if (dispatch.status === "response_received") {
    return Boolean(dispatch.finishedAt)
      && Boolean(dispatch.responseHash);
  }
  if (dispatch.status === "outcome_unknown") {
    return Boolean(dispatch.finishedAt)
      && Boolean(dispatch.errorCode)
      && !dispatch.responseHash;
  }
  return Boolean(dispatch.finishedAt)
    && Boolean(dispatch.errorCode)
    && !dispatch.providerExecuted
    && !dispatch.responseHash;
}
