import { createHash, randomUUID } from "node:crypto";
import {
  prospectProviderResponseComponentHashes,
  prospectProviderResponseHash,
  sha256CanonicalJson
} from "./prospect-provider-request-ledger.js";
import {
  PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
  normalizeProspectProviderSourceRecords,
  prospectProviderRawArtifactHash
} from "./prospect-source-raw.js";
import type {
  ProspectProviderSourceRecordInput
} from "./prospect-source-raw.js";

export interface FakeProspectProviderUsage {
  requestUnits: number;
  resultUnits: number;
}

export interface FakeProspectProviderCost {
  kind: "actual" | "estimated" | "unknown";
  amount: number | null;
  currency: string;
}

export interface FakeProspectProviderSuccess {
  kind: "success";
  acceptedCount: number;
  rawCount: number;
  invalidCount: number;
  duplicateCount: number;
  hasMore: boolean;
  cursor: string;
  partial: boolean;
  usage: FakeProspectProviderUsage;
  cost: FakeProspectProviderCost;
  responseSchemaVersion?: typeof PROSPECT_SOURCE_RAW_SCHEMA_VERSION;
  rawArtifactHash?: string;
  sourceRecords?: ProspectProviderSourceRecordInput[];
}

export interface FakeProspectProviderFailure {
  kind: "failure";
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  retryAfterAt: string;
  usage: FakeProspectProviderUsage;
  cost: FakeProspectProviderCost;
}

export type FakeProspectProviderStep =
  | FakeProspectProviderSuccess
  | FakeProspectProviderFailure;

export type FakeProspectProviderFaultAfter =
  | "accepted"
  | "confirmed"
  | "response_generated";

export type FakeProspectProviderScriptStep =
  FakeProspectProviderStep & {
    fakeFaultAfter?: FakeProspectProviderFaultAfter;
    fakeDelayMs?: number;
  };

// Legacy request kept until the execution kernel switches to dispatch().
export interface FakeProspectProviderRequest {
  runId: string;
  shardId: string;
  providerCode: string;
  checkpointNo: number;
  checkpointCallNo: number;
  cursor: string;
  requestHash: string;
}

export interface FakeProspectProviderDispatchRequest {
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  providerCode: string;
  connectionId: string;
  endpointCode: string;
  adapterVersion: string;
  contractVersion: string;
  requestHash: string;
  idempotencyKey: string;
}

export interface FakeProspectProviderQueryScope {
  teamId: string;
  ownerId: string;
  providerCode: string;
  connectionId: string;
  endpointCode: string;
}

export interface FakeProspectProviderResponse {
  step: FakeProspectProviderStep;
  externalRequestId: string;
  httpStatus: number;
  rawResponseHash: string;
  normalizedResultHash: string;
  accountingEvidenceHash: string;
  responseHash: string;
  replayed: boolean;
}

export interface FakeProspectProviderPhysicalCall {
  id: string;
  invocationNo: number;
  operation:
    | "dispatch"
    | "query_by_idempotency_key"
    | "query_by_external_request_id";
  teamId: string;
  ownerId: string;
  providerCode: string;
  connectionId: string;
  endpointCode: string;
  idempotencyKey: string;
  requestHash: string;
  accepted: boolean;
  replayed: boolean;
  providerExecuted: boolean;
  externalRequestId: string;
  responseHash: string;
  errorCode: string;
  occurredAt: string;
}

interface StoredFakeProspectProviderResponse {
  request: FakeProspectProviderDispatchRequest;
  response: FakeProspectProviderResponse;
}

export class FakeProspectProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "FakeProspectProviderError";
  }
}

function normalizedNonnegative(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Fake Provider 数量和费用必须是非负有限值");
  }
  return value;
}

function resultFromScriptStep(
  step: FakeProspectProviderScriptStep
): FakeProspectProviderStep {
  const {
    fakeFaultAfter: _fakeFaultAfter,
    fakeDelayMs: _fakeDelayMs,
    ...result
  } = step;
  const providerResult = result as FakeProspectProviderStep;
  if (providerResult.kind !== "success") return providerResult;
  const hasRawFields = providerResult.responseSchemaVersion !== undefined
    || providerResult.rawArtifactHash !== undefined
    || providerResult.sourceRecords !== undefined;
  if (!hasRawFields) return providerResult;
  if (providerResult.responseSchemaVersion
      !== PROSPECT_SOURCE_RAW_SCHEMA_VERSION
    || !Array.isArray(providerResult.sourceRecords)) {
    throw new Error("Fake Provider 原始记录合同不完整");
  }
  const sourceRecords = normalizeProspectProviderSourceRecords(
    providerResult.sourceRecords,
    providerResult.rawCount
  );
  const rawArtifactHash = prospectProviderRawArtifactHash(sourceRecords);
  if (providerResult.rawArtifactHash
    && providerResult.rawArtifactHash !== rawArtifactHash) {
    throw new Error("Fake Provider 原始工件摘要不一致");
  }
  return {
    ...providerResult,
    responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
    rawArtifactHash,
    sourceRecords
  };
}

function validateStep(step: FakeProspectProviderScriptStep) {
  const result = resultFromScriptStep(step);
  normalizedNonnegative(result.usage.requestUnits);
  normalizedNonnegative(result.usage.resultUnits);
  if (result.cost.amount !== null) normalizedNonnegative(result.cost.amount);
  if (result.cost.kind === "unknown" && result.cost.amount !== null) {
    throw new Error("未知费用不能携带金额");
  }
  if (result.cost.amount !== null
    && !/^[A-Z]{3}$/.test(result.cost.currency)) {
    throw new Error("Fake Provider 费用币种无效");
  }
  if (step.fakeDelayMs !== undefined) {
    normalizedNonnegative(step.fakeDelayMs);
  }
  if (result.kind === "success") {
    normalizedNonnegative(result.acceptedCount);
    normalizedNonnegative(result.rawCount);
    normalizedNonnegative(result.invalidCount);
    normalizedNonnegative(result.duplicateCount);
    if (result.acceptedCount
      + result.invalidCount
      + result.duplicateCount > result.rawCount) {
      throw new Error("Fake Provider 页数量关系无效");
    }
    if (result.hasMore !== Boolean(result.cursor)) {
      throw new Error("Fake Provider cursor 与 hasMore 必须一致");
    }
  } else {
    if (!result.errorCode.trim() || !result.errorMessage.trim()) {
      throw new Error("Fake Provider 失败步骤必须包含安全错误信息");
    }
    if (result.retryAfterAt
      && !Number.isFinite(new Date(result.retryAfterAt).getTime())) {
      throw new Error("Fake Provider retryAfterAt 无效");
    }
  }
}

function validateDispatchRequest(request: FakeProspectProviderDispatchRequest) {
  const required = [
    request.teamId,
    request.ownerId,
    request.runId,
    request.shardId,
    request.providerCode,
    request.connectionId,
    request.endpointCode,
    request.adapterVersion,
    request.contractVersion
  ];
  if (required.some((item) => !item.trim())) {
    throw new FakeProspectProviderError(
      "FAKE_PROVIDER_REQUEST_INVALID",
      "Fake Provider 请求作用域不完整"
    );
  }
  if (!/^[a-f0-9]{64}$/.test(request.requestHash)
    || !/^[a-f0-9]{64}$/.test(request.idempotencyKey)) {
    throw new FakeProspectProviderError(
      "FAKE_PROVIDER_REQUEST_INVALID",
      "Fake Provider 请求哈希或幂等键无效"
    );
  }
}

function responseStatus(step: FakeProspectProviderStep) {
  if (step.kind === "success") return 200;
  return step.retryable ? 503 : 400;
}

function fakeInterruptionCode(faultAfter: FakeProspectProviderFaultAfter) {
  if (faultAfter === "accepted") {
    return "FAKE_PROVIDER_ACCEPTED_THEN_INTERRUPTED";
  }
  if (faultAfter === "confirmed") {
    return "FAKE_PROVIDER_CONFIRMED_THEN_INTERRUPTED";
  }
  return "FAKE_PROVIDER_RESPONSE_GENERATED_THEN_INTERRUPTED";
}

export class DeterministicFakeProspectProvider {
  private readonly scripts: ReadonlyMap<
    string,
    readonly FakeProspectProviderScriptStep[]
  >;
  private readonly legacyOffsets = new Map<string, number>();
  private readonly dispatchOffsets = new Map<string, number>();
  private readonly responsesByKey =
    new Map<string, StoredFakeProspectProviderResponse>();
  private readonly responsesByExternalId =
    new Map<string, StoredFakeProspectProviderResponse>();
  private readonly physicalCalls: FakeProspectProviderPhysicalCall[] = [];
  private invocationNo = 0;

  constructor(
    scripts: Readonly<
      Record<string, readonly FakeProspectProviderScriptStep[]>
    >
  ) {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Fake Provider 仅允许在测试环境构造");
    }
    const entries = Object.entries(scripts);
    if (!entries.length) throw new Error("Fake Provider 必须提供脚本");
    for (const [providerCode, steps] of entries) {
      if (!providerCode.trim() || !steps.length) {
        throw new Error("Fake Provider 数据源代码和步骤不能为空");
      }
      steps.forEach(validateStep);
    }
    this.scripts = new Map(entries);
  }

  private requestScopeKey(request: FakeProspectProviderDispatchRequest) {
    return [
      request.teamId,
      request.ownerId,
      request.connectionId,
      request.endpointCode,
      request.idempotencyKey
    ].join("\u001f");
  }

  private externalScopeKey(
    scope: FakeProspectProviderQueryScope,
    externalRequestId: string
  ) {
    return [
      scope.teamId,
      scope.ownerId,
      scope.providerCode,
      scope.connectionId,
      scope.endpointCode,
      externalRequestId
    ].join("\u001f");
  }

  private scriptScopeKey(request: FakeProspectProviderDispatchRequest) {
    return [
      request.teamId,
      request.ownerId,
      request.runId,
      request.shardId,
      request.providerCode,
      request.connectionId,
      request.endpointCode
    ].join("\u001f");
  }

  private recordCall(input: Omit<
    FakeProspectProviderPhysicalCall,
    "id" | "invocationNo" | "occurredAt"
  >) {
    const call: FakeProspectProviderPhysicalCall = {
      id: `fake_call_${randomUUID()}`,
      invocationNo: ++this.invocationNo,
      occurredAt: new Date().toISOString(),
      ...input
    };
    this.physicalCalls.push(call);
    return call;
  }

  private cloneResponse(
    stored: StoredFakeProspectProviderResponse,
    replayed: boolean
  ): FakeProspectProviderResponse {
    return {
      ...structuredClone(stored.response),
      replayed
    };
  }

  async dispatch(
    request: FakeProspectProviderDispatchRequest
  ): Promise<FakeProspectProviderResponse> {
    validateDispatchRequest(request);
    const steps = this.scripts.get(request.providerCode);
    if (!steps) {
      throw new FakeProspectProviderError(
        "FAKE_PROVIDER_SCRIPT_NOT_FOUND",
        "Fake Provider 未配置该数据源脚本"
      );
    }
    const requestScopeKey = this.requestScopeKey(request);
    const existing = this.responsesByKey.get(requestScopeKey);
    if (existing) {
      if (existing.request.requestHash !== request.requestHash) {
        this.recordCall({
          operation: "dispatch",
          teamId: request.teamId,
          ownerId: request.ownerId,
          providerCode: request.providerCode,
          connectionId: request.connectionId,
          endpointCode: request.endpointCode,
          idempotencyKey: request.idempotencyKey,
          requestHash: request.requestHash,
          accepted: false,
          replayed: false,
          providerExecuted: false,
          externalRequestId: "",
          responseHash: "",
          errorCode: "IDEMPOTENCY_KEY_REQUEST_MISMATCH"
        });
        throw new FakeProspectProviderError(
          "IDEMPOTENCY_KEY_REQUEST_MISMATCH",
          "同一幂等键不能绑定不同请求"
        );
      }
      this.recordCall({
        operation: "dispatch",
        teamId: request.teamId,
        ownerId: request.ownerId,
        providerCode: request.providerCode,
        connectionId: request.connectionId,
        endpointCode: request.endpointCode,
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        accepted: true,
        replayed: true,
        providerExecuted: false,
        externalRequestId: existing.response.externalRequestId,
        responseHash: existing.response.responseHash,
        errorCode: ""
      });
      return this.cloneResponse(existing, true);
    }

    const scriptScopeKey = this.scriptScopeKey(request);
    const offset = this.dispatchOffsets.get(scriptScopeKey) || 0;
    const scripted = steps[offset];
    if (!scripted) {
      throw new FakeProspectProviderError(
        "FAKE_PROVIDER_SCRIPT_EXHAUSTED",
        "Fake Provider 脚本步骤已耗尽"
      );
    }
    this.dispatchOffsets.set(scriptScopeKey, offset + 1);
    const step = resultFromScriptStep(scripted);
    const externalRequestId = `fake_req_${
      createHash("sha256")
        .update([
          requestScopeKey,
          request.requestHash
        ].join("\u001f"))
        .digest("hex")
        .slice(0, 32)
    }`;
    const {
      rawResponseHash,
      normalizedResultHash,
      accountingEvidenceHash
    } = prospectProviderResponseComponentHashes(step);
    const httpStatus = responseStatus(step);
    const responseHash = prospectProviderResponseHash({
      contractVersion: request.contractVersion,
      requestHash: request.requestHash,
      idempotencyKey: request.idempotencyKey,
      providerCode: request.providerCode,
      connectionId: request.connectionId,
      endpointCode: request.endpointCode,
      externalRequestId,
      httpStatus,
      rawResponseHash,
      normalizedResultHash,
      accountingEvidenceHash
    });
    const stored: StoredFakeProspectProviderResponse = {
      request: structuredClone(request),
      response: {
        step: structuredClone(step),
        externalRequestId,
        httpStatus,
        rawResponseHash,
        normalizedResultHash,
        accountingEvidenceHash,
        responseHash,
        replayed: false
      }
    };
    this.responsesByKey.set(requestScopeKey, stored);
    this.responsesByExternalId.set(
      this.externalScopeKey(request, externalRequestId),
      stored
    );
    this.recordCall({
      operation: "dispatch",
      teamId: request.teamId,
      ownerId: request.ownerId,
      providerCode: request.providerCode,
      connectionId: request.connectionId,
      endpointCode: request.endpointCode,
      idempotencyKey: request.idempotencyKey,
      requestHash: request.requestHash,
      accepted: true,
      replayed: false,
      providerExecuted: true,
      externalRequestId,
      responseHash,
      errorCode: scripted.fakeFaultAfter
        ? fakeInterruptionCode(scripted.fakeFaultAfter)
        : ""
    });
    if (scripted.fakeDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, scripted.fakeDelayMs)
      );
    }
    if (scripted.fakeFaultAfter) {
      throw new FakeProspectProviderError(
        fakeInterruptionCode(scripted.fakeFaultAfter),
        "Fake Provider 已记录请求后模拟中断"
      );
    }
    return this.cloneResponse(stored, false);
  }

  async getByIdempotencyKey(input: FakeProspectProviderQueryScope & {
    idempotencyKey: string;
    requestHash: string;
  }) {
    const key = [
      input.teamId,
      input.ownerId,
      input.connectionId,
      input.endpointCode,
      input.idempotencyKey
    ].join("\u001f");
    const stored = this.responsesByKey.get(key);
    const found = stored
      && stored.request.providerCode === input.providerCode
      && stored.request.requestHash === input.requestHash;
    this.recordCall({
      operation: "query_by_idempotency_key",
      teamId: input.teamId,
      ownerId: input.ownerId,
      providerCode: input.providerCode,
      connectionId: input.connectionId,
      endpointCode: input.endpointCode,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      accepted: Boolean(found),
      replayed: Boolean(found),
      providerExecuted: false,
      externalRequestId: found ? stored.response.externalRequestId : "",
      responseHash: found ? stored.response.responseHash : "",
      errorCode: found ? "" : "FAKE_PROVIDER_REQUEST_NOT_FOUND"
    });
    if (!found) {
      throw new FakeProspectProviderError(
        "FAKE_PROVIDER_REQUEST_NOT_FOUND",
        "Fake Provider 未找到该作用域内的请求"
      );
    }
    return this.cloneResponse(stored, true);
  }

  async getByExternalRequestId(input: FakeProspectProviderQueryScope & {
    externalRequestId: string;
  }) {
    const stored = this.responsesByExternalId.get(
      this.externalScopeKey(input, input.externalRequestId)
    );
    this.recordCall({
      operation: "query_by_external_request_id",
      teamId: input.teamId,
      ownerId: input.ownerId,
      providerCode: input.providerCode,
      connectionId: input.connectionId,
      endpointCode: input.endpointCode,
      idempotencyKey: stored?.request.idempotencyKey || "",
      requestHash: stored?.request.requestHash || "",
      accepted: Boolean(stored),
      replayed: Boolean(stored),
      providerExecuted: false,
      externalRequestId: input.externalRequestId,
      responseHash: stored?.response.responseHash || "",
      errorCode: stored ? "" : "FAKE_PROVIDER_REQUEST_NOT_FOUND"
    });
    if (!stored) {
      throw new FakeProspectProviderError(
        "FAKE_PROVIDER_REQUEST_NOT_FOUND",
        "Fake Provider 未找到该作用域内的请求"
      );
    }
    return this.cloneResponse(stored, true);
  }

  listPhysicalCalls() {
    return structuredClone(this.physicalCalls);
  }

  async search(request: FakeProspectProviderRequest) {
    const steps = this.scripts.get(request.providerCode);
    if (!steps) throw new Error("Fake Provider 未配置该数据源脚本");
    const key = [
      request.runId,
      request.shardId,
      request.providerCode
    ].join("\u001f");
    const offset = this.legacyOffsets.get(key) || 0;
    const scripted = steps[offset];
    if (!scripted) throw new Error("Fake Provider 脚本步骤已耗尽");
    this.legacyOffsets.set(key, offset + 1);
    const step = resultFromScriptStep(scripted);
    const responseHash = sha256CanonicalJson({
      requestHash: request.requestHash,
      providerCode: request.providerCode,
      checkpointNo: request.checkpointNo,
      checkpointCallNo: request.checkpointCallNo,
      step
    });
    return {
      step: structuredClone(step),
      responseHash
    };
  }
}
