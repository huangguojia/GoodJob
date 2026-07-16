import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes
} from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectSourceRawBatch,
  ProspectSourceRawHit,
  ProspectSourceRawRecord
} from "./types.js";

export const PROSPECT_SOURCE_RAW_CONTRACT = "prospect_source_raw_v1";
export const PROSPECT_SOURCE_RAW_SCHEMA_VERSION =
  "fake-provider-source-records-v1";
export const PROSPECT_SOURCE_RAW_ENVELOPE_VERSION = "provider-raw-v1";

const MAX_SOURCE_RECORDS = 10_000;
const MAX_RECORD_BYTES = 1_048_576;
const MAX_BATCH_BYTES = 8_388_608;

export interface ProspectProviderSourceRecordInput {
  providerRecordId: string;
  sourceUrl: string;
  fetchedAt: string;
  payload: unknown;
}

export interface ProspectProviderRawPolicy {
  licensePolicy: string;
  retentionPolicy: string;
  retentionDays: number;
}

export interface AppendProspectSourceRawBatchInput {
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  jobId: string;
  attemptId: string;
  ledgerId: string;
  pageId: string;
  providerCode: string;
  connectionId: string;
  endpointCode: string;
  adapterVersion: string;
  responseSchemaVersion: string;
  responseHash: string;
  settlementHash: string;
  rawArtifactHash: string;
  sourceRecords: readonly ProspectProviderSourceRecordInput[];
  policy: ProspectProviderRawPolicy;
  envelopeSecret: string;
  identitySecret: string;
  createdAt: string;
}

export interface AppendProspectSourceRawBatchResult {
  idempotent: boolean;
  batch: ProspectSourceRawBatch;
  records: ProspectSourceRawRecord[];
  hits: ProspectSourceRawHit[];
}

export class ProspectSourceRawError extends Error {
  constructor(
    public readonly code:
      | "PROSPECT_SOURCE_RAW_INVALID"
      | "PROSPECT_SOURCE_RAW_CONFLICT"
      | "PROSPECT_SOURCE_RAW_ENVELOPE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "ProspectSourceRawError";
  }
}

function invalid(message: string): never {
  throw new ProspectSourceRawError("PROSPECT_SOURCE_RAW_INVALID", message);
}

function conflict(message: string): never {
  throw new ProspectSourceRawError("PROSPECT_SOURCE_RAW_CONFLICT", message);
}

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") {
    invalid("Provider 原始记录包含不可序列化的数据");
  }
  return result;
}

function assertJsonValue(
  value: unknown,
  depth = 0,
  budget = { nodes: 0 }
): void {
  budget.nodes += 1;
  if (depth > 30 || budget.nodes > 100_000) {
    invalid("Provider 原始记录层级或节点数量超限");
  }
  if (value === null
    || typeof value === "string"
    || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalid("Provider 原始记录只能包含有限数值");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === undefined) {
        invalid("Provider 原始记录数组不能包含 undefined");
      }
      assertJsonValue(item, depth + 1, budget);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    invalid("Provider 原始记录 payload 必须是 JSON 值");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid("Provider 原始记录不能包含非普通对象");
  }
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 500 || item === undefined) {
      invalid("Provider 原始记录对象键或字段值无效");
    }
    assertJsonValue(item, depth + 1, budget);
  }
}

function normalizedIso(value: string, fieldName: string) {
  if (typeof value !== "string" || !value.trim()) {
    invalid(`${fieldName} 不能为空`);
  }
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    invalid(`${fieldName} 不是有效时间`);
  }
  return new Date(time).toISOString();
}

function normalizedSourceUrl(value: string) {
  if (typeof value !== "string"
    || !value.trim()
    || value.length > 4_096) {
    invalid("Provider 原始记录 sourceUrl 无效");
  }
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password) {
      invalid("Provider 原始记录 sourceUrl 只允许无凭据 HTTP(S) 地址");
    }
    return url.toString();
  } catch (error) {
    if (error instanceof ProspectSourceRawError) throw error;
    invalid("Provider 原始记录 sourceUrl 无效");
  }
}

export function normalizeProspectProviderSourceRecords(
  value: unknown,
  expectedRawCount?: number
): ProspectProviderSourceRecordInput[] {
  if (!Array.isArray(value)
    || value.length > MAX_SOURCE_RECORDS
    || (expectedRawCount !== undefined
      && value.length !== expectedRawCount)) {
    invalid("Provider 原始记录数量与 rawCount 不一致或超过上限");
  }
  let batchBytes = 0;
  return value.map((candidate, index) => {
    if (!candidate
      || typeof candidate !== "object"
      || Array.isArray(candidate)) {
      invalid(`Provider 第 ${index + 1} 条原始记录结构无效`);
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.providerRecordId !== "string"
      || record.providerRecordId.length > 1_000
      || typeof record.sourceUrl !== "string"
      || typeof record.fetchedAt !== "string"
      || !Object.prototype.hasOwnProperty.call(record, "payload")) {
      invalid(`Provider 第 ${index + 1} 条原始记录字段无效`);
    }
    assertJsonValue(record.payload);
    const normalized: ProspectProviderSourceRecordInput = {
      providerRecordId: record.providerRecordId.trim(),
      sourceUrl: normalizedSourceUrl(record.sourceUrl),
      fetchedAt: normalizedIso(
        record.fetchedAt,
        `Provider 第 ${index + 1} 条原始记录 fetchedAt`
      ),
      payload: structuredClone(record.payload)
    };
    const recordBytes = Buffer.byteLength(canonical(normalized), "utf8");
    batchBytes += recordBytes;
    if (recordBytes > MAX_RECORD_BYTES || batchBytes > MAX_BATCH_BYTES) {
      invalid("Provider 原始记录单条或批次体积超过安全上限");
    }
    return normalized;
  });
}

export function prospectProviderRawArtifactHash(
  sourceRecords: readonly ProspectProviderSourceRecordInput[]
) {
  return createHash("sha256").update(canonical({
    contract: PROSPECT_SOURCE_RAW_CONTRACT,
    responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
    sourceRecords
  })).digest("hex");
}

function requireSecret(secret: string, label: string) {
  if (typeof secret !== "string"
    || Buffer.byteLength(secret, "utf8") < 32) {
    invalid(`${label} 至少需要 32 字节`);
  }
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function hmac(secret: string, value: unknown) {
  return createHmac("sha256", secret)
    .update(canonical(value))
    .digest("hex");
}

function rawEnvelopeKey(secret: string) {
  return createHash("sha256")
    .update("goodjob-provider-raw-envelope-key-v1\u001f")
    .update(secret)
    .digest();
}

type RawRecordPlaintext = {
  providerRecordId: string;
  sourceUrl: string;
  payload: unknown;
};

export interface ReadProspectSourceRawRecordInput {
  teamId: string;
  ownerId: string;
  recordId: string;
  envelopeSecret: string;
}

export interface ReadProspectSourceRawRecordResult {
  record: ProspectSourceRawRecord;
  plaintext: RawRecordPlaintext;
}

function rawRecordAad(
  record: Pick<
    ProspectSourceRawRecord,
    "id" | "teamId" | "ownerId" | "providerCode" | "connectionId"
      | "endpointCode" | "sourceIdentityHash" | "artifactHash"
      | "envelopeVersion" | "firstObservedAt" | "createdAt"
  >
) {
  return Buffer.from(canonical({
    contract: PROSPECT_SOURCE_RAW_CONTRACT,
    recordVersion: "prospect-source-raw-record-v1",
    id: record.id,
    teamId: record.teamId,
    ownerId: record.ownerId,
    providerCode: record.providerCode,
    connectionId: record.connectionId,
    endpointCode: record.endpointCode,
    sourceIdentityHash: record.sourceIdentityHash,
    artifactHash: record.artifactHash,
    envelopeVersion: record.envelopeVersion,
    firstObservedAt: record.firstObservedAt,
    createdAt: record.createdAt
  }), "utf8");
}

function encryptRawRecord(
  record: Parameters<typeof rawRecordAad>[0],
  value: RawRecordPlaintext,
  secret: string
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    rawEnvelopeKey(secret),
    iv
  );
  cipher.setAAD(rawRecordAad(record));
  const encrypted = Buffer.concat([
    cipher.update(canonical(value), "utf8"),
    cipher.final()
  ]);
  return [
    PROSPECT_SOURCE_RAW_ENVELOPE_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

function decryptRawRecord(
  record: ProspectSourceRawRecord,
  secret: string
): RawRecordPlaintext {
  const [version, ivText, tagText, payloadText, ...rest] =
    record.encryptedEnvelope.split(".");
  if (rest.length
    || version !== PROSPECT_SOURCE_RAW_ENVELOPE_VERSION
    || record.envelopeVersion !== PROSPECT_SOURCE_RAW_ENVELOPE_VERSION
    || !ivText
    || !tagText
    || !payloadText) {
    throw new ProspectSourceRawError(
      "PROSPECT_SOURCE_RAW_ENVELOPE_INVALID",
      "Provider 原始记录信封格式无效"
    );
  }
  try {
    const decode = (text: string) => {
      if (!/^[A-Za-z0-9_-]+$/.test(text)) {
        throw new Error("invalid base64url");
      }
      const decoded = Buffer.from(text, "base64url");
      if (decoded.toString("base64url") !== text) {
        throw new Error("non-canonical base64url");
      }
      return decoded;
    };
    const iv = decode(ivText);
    const tag = decode(tagText);
    const payload = decode(payloadText);
    if (iv.length !== 12 || tag.length !== 16 || !payload.length) {
      throw new Error("invalid envelope component length");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      rawEnvelopeKey(secret),
      iv,
      { authTagLength: 16 }
    );
    decipher.setAAD(rawRecordAad(record));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(payload),
      decipher.final()
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as RawRecordPlaintext;
    if (canonical(parsed) !== plaintext) {
      throw new Error("non-canonical plaintext");
    }
    return parsed;
  } catch {
    throw new ProspectSourceRawError(
      "PROSPECT_SOURCE_RAW_ENVELOPE_INVALID",
      "Provider 原始记录信封完整性校验失败"
    );
  }
}

function sourceIdentityHash(
  input: AppendProspectSourceRawBatchInput,
  source: ProspectProviderSourceRecordInput
) {
  const identity = source.providerRecordId
    ? {
        kind: "provider_record_id",
        value: source.providerRecordId
      }
    : {
        kind: "provider_payload",
        value: {
          sourceUrl: source.sourceUrl,
          payload: source.payload
        }
      };
  return hmac(input.identitySecret, {
    contract: PROSPECT_SOURCE_RAW_CONTRACT,
    identityVersion: "provider-source-identity-v1",
    teamId: input.teamId,
    ownerId: input.ownerId,
    providerCode: input.providerCode,
    connectionId: input.connectionId,
    endpointCode: input.endpointCode,
    identity
  });
}

function artifactHash(source: ProspectProviderSourceRecordInput) {
  return sha256({
    contract: PROSPECT_SOURCE_RAW_CONTRACT,
    artifactVersion: "provider-source-artifact-v1",
    providerRecordId: source.providerRecordId,
    sourceUrl: source.sourceUrl,
    payload: source.payload
  });
}

function recordId(input: {
  teamId: string;
  ownerId: string;
  providerCode: string;
  connectionId: string;
  endpointCode: string;
  sourceIdentityHash: string;
  artifactHash: string;
}, identitySecret: string) {
  return `psrr_${hmac(identitySecret, {
    contract: PROSPECT_SOURCE_RAW_CONTRACT,
    idVersion: "prospect-source-raw-record-id-v1",
    ...input
  }).slice(0, 40)}`;
}

function batchId(input: AppendProspectSourceRawBatchInput) {
  return `psrb_${sha256({
    contract: PROSPECT_SOURCE_RAW_CONTRACT,
    idVersion: "prospect-source-raw-batch-id-v1",
    teamId: input.teamId,
    ownerId: input.ownerId,
    ledgerId: input.ledgerId,
    pageId: input.pageId,
    responseHash: input.responseHash,
    settlementHash: input.settlementHash
  }).slice(0, 40)}`;
}

function hitId(batchIdValue: string, ordinal: number) {
  return `psrh_${sha256({
    contract: PROSPECT_SOURCE_RAW_CONTRACT,
    idVersion: "prospect-source-raw-hit-id-v1",
    batchId: batchIdValue,
    ordinal
  }).slice(0, 40)}`;
}

function rawRecordHash(record: Omit<ProspectSourceRawRecord, "recordHash">) {
  return sha256({
    contract: PROSPECT_SOURCE_RAW_CONTRACT,
    recordVersion: "prospect-source-raw-record-v1",
    ...record
  });
}

function rawHitHash(hit: Omit<ProspectSourceRawHit, "hitHash">) {
  return sha256({
    contract: PROSPECT_SOURCE_RAW_CONTRACT,
    hitVersion: "prospect-source-raw-hit-v1",
    ...hit
  });
}

function rawBatchHash(
  batch: Omit<ProspectSourceRawBatch, "batchHash">,
  hits: readonly ProspectSourceRawHit[]
) {
  return sha256({
    contract: PROSPECT_SOURCE_RAW_CONTRACT,
    batchVersion: "prospect-source-raw-batch-v1",
    ...batch,
    hits: hits
      .slice()
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((hit) => ({
        id: hit.id,
        recordId: hit.recordId,
        ordinal: hit.ordinal,
        fetchedAt: hit.fetchedAt,
        hitHash: hit.hitHash
      }))
  });
}

function validatePolicy(policy: ProspectProviderRawPolicy) {
  if (!policy
    || typeof policy.licensePolicy !== "string"
    || !policy.licensePolicy.trim()
    || policy.licensePolicy.length > 200
    || typeof policy.retentionPolicy !== "string"
    || !policy.retentionPolicy.trim()
    || policy.retentionPolicy.length > 200
    || !Number.isInteger(policy.retentionDays)
    || policy.retentionDays < 1
    || policy.retentionDays > 3_650) {
    invalid("Provider 原始记录许可或保留策略无效");
  }
}

function validateHash(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    invalid(`${label} 格式无效`);
  }
}

function verifyRecord(
  record: ProspectSourceRawRecord,
  expected: ProspectProviderSourceRecordInput,
  input: AppendProspectSourceRawBatchInput
) {
  const expectedIdentityHash = sourceIdentityHash(input, expected);
  const expectedArtifactHash = artifactHash(expected);
  if (record.teamId !== input.teamId
    || record.ownerId !== input.ownerId
    || record.providerCode !== input.providerCode
    || record.connectionId !== input.connectionId
    || record.endpointCode !== input.endpointCode
    || record.sourceIdentityHash !== expectedIdentityHash
    || record.artifactHash !== expectedArtifactHash
    || record.id !== recordId({
      teamId: input.teamId,
      ownerId: input.ownerId,
      providerCode: input.providerCode,
      connectionId: input.connectionId,
      endpointCode: input.endpointCode,
      sourceIdentityHash: expectedIdentityHash,
      artifactHash: expectedArtifactHash
    }, input.identitySecret)
    || record.envelopeHash !== createHash("sha256")
      .update(record.encryptedEnvelope)
      .digest("hex")
    || record.recordHash !== rawRecordHash(recordWithoutHash(record))) {
    conflict("Provider 原始记录已有事实与本次响应不一致");
  }
  const plaintext = decryptRawRecord(record, input.envelopeSecret);
  if (canonical(plaintext) !== canonical({
    providerRecordId: expected.providerRecordId,
    sourceUrl: expected.sourceUrl,
    payload: expected.payload
  })) {
    conflict("Provider 原始记录解密内容与本次响应不一致");
  }
}

function recordWithoutHash(record: ProspectSourceRawRecord) {
  const { recordHash: _recordHash, ...withoutHash } = record;
  return withoutHash;
}

function hitWithoutHash(hit: ProspectSourceRawHit) {
  const { hitHash: _hitHash, ...withoutHash } = hit;
  return withoutHash;
}

function batchWithoutHash(batch: ProspectSourceRawBatch) {
  const { batchHash: _batchHash, ...withoutHash } = batch;
  return withoutHash;
}

export function readProspectSourceRawRecord(
  store: CrmStore,
  input: ReadProspectSourceRawRecordInput
): ReadProspectSourceRawRecordResult {
  requireSecret(input.envelopeSecret, "Provider 原始记录加密密钥");
  const records = store.prospectSourceRawRecords.filter((item) =>
    item.id === input.recordId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
  );
  if (records.length !== 1) {
    conflict("Provider 原始记录不存在或不属于当前作用域");
  }
  const record = records[0]!;
  if (record.envelopeHash !== createHash("sha256")
      .update(record.encryptedEnvelope)
      .digest("hex")
    || record.recordHash !== rawRecordHash(recordWithoutHash(record))) {
    throw new ProspectSourceRawError(
      "PROSPECT_SOURCE_RAW_ENVELOPE_INVALID",
      "Provider 原始记录完整性校验失败"
    );
  }
  return {
    record: structuredClone(record),
    plaintext: structuredClone(decryptRawRecord(record, input.envelopeSecret))
  };
}

function replayExistingBatch(
  store: CrmStore,
  batch: ProspectSourceRawBatch,
  normalizedRecords: readonly ProspectProviderSourceRecordInput[],
  input: AppendProspectSourceRawBatchInput
): AppendProspectSourceRawBatchResult {
  const hits = store.prospectSourceRawHits
    .filter((item) => item.batchId === batch.id)
    .sort((left, right) => left.ordinal - right.ordinal);
  if (batch.teamId !== input.teamId
    || batch.ownerId !== input.ownerId
    || batch.runId !== input.runId
    || batch.shardId !== input.shardId
    || batch.jobId !== input.jobId
    || batch.attemptId !== input.attemptId
    || batch.ledgerId !== input.ledgerId
    || batch.pageId !== input.pageId
    || batch.providerCode !== input.providerCode
    || batch.connectionId !== input.connectionId
    || batch.endpointCode !== input.endpointCode
    || batch.adapterVersion !== input.adapterVersion
    || batch.responseSchemaVersion !== input.responseSchemaVersion
    || batch.responseHash !== input.responseHash
    || batch.settlementHash !== input.settlementHash
    || batch.rawArtifactHash !== input.rawArtifactHash
    || batch.recordCount !== normalizedRecords.length
    || batch.licensePolicy !== input.policy.licensePolicy.trim()
    || batch.retentionPolicy !== input.policy.retentionPolicy.trim()
    || batch.retentionDays !== input.policy.retentionDays
    || hits.length !== batch.recordCount
    || batch.batchHash !== rawBatchHash(batchWithoutHash(batch), hits)) {
    conflict("Provider 原始批次已有事实不完整或与本次响应冲突");
  }
  const resultRecords: ProspectSourceRawRecord[] = [];
  const seenRecordIds = new Set<string>();
  for (let index = 0; index < normalizedRecords.length; index += 1) {
    const hit = hits[index];
    const expected = normalizedRecords[index]!;
    if (!hit
      || hit.id !== hitId(batch.id, index + 1)
      || hit.teamId !== batch.teamId
      || hit.ownerId !== batch.ownerId
      || hit.runId !== batch.runId
      || hit.shardId !== batch.shardId
      || hit.jobId !== batch.jobId
      || hit.attemptId !== batch.attemptId
      || hit.ledgerId !== batch.ledgerId
      || hit.pageId !== batch.pageId
      || hit.ordinal !== index + 1
      || hit.fetchedAt !== expected.fetchedAt
      || hit.hitHash !== rawHitHash(hitWithoutHash(hit))) {
      conflict("Provider 原始命中已有事实不完整或顺序冲突");
    }
    const recordRows = store.prospectSourceRawRecords.filter((item) =>
      item.id === hit.recordId
    );
    if (recordRows.length !== 1) {
      conflict("Provider 原始命中引用的记录不存在或不唯一");
    }
    const record = recordRows[0]!;
    verifyRecord(record, expected, input);
    if (!seenRecordIds.has(record.id)) {
      seenRecordIds.add(record.id);
      resultRecords.push(record);
    }
  }
  return {
    idempotent: true,
    batch: structuredClone(batch),
    records: structuredClone(resultRecords),
    hits: structuredClone(hits)
  };
}

export function appendProspectSourceRawBatch(
  store: CrmStore,
  rawInput: AppendProspectSourceRawBatchInput
): AppendProspectSourceRawBatchResult {
  requireSecret(rawInput.envelopeSecret, "Provider 原始记录加密密钥");
  requireSecret(rawInput.identitySecret, "Provider 原始记录身份密钥");
  validatePolicy(rawInput.policy);
  const required = [
    rawInput.teamId,
    rawInput.ownerId,
    rawInput.runId,
    rawInput.shardId,
    rawInput.jobId,
    rawInput.attemptId,
    rawInput.ledgerId,
    rawInput.pageId,
    rawInput.providerCode,
    rawInput.connectionId,
    rawInput.endpointCode,
    rawInput.adapterVersion
  ];
  if (required.some((item) => typeof item !== "string" || !item.trim())
    || rawInput.responseSchemaVersion
      !== PROSPECT_SOURCE_RAW_SCHEMA_VERSION) {
    invalid("Provider 原始批次作用域或响应版本无效");
  }
  validateHash(rawInput.responseHash, "Provider 响应摘要");
  validateHash(rawInput.settlementHash, "Provider 结算摘要");
  validateHash(rawInput.rawArtifactHash, "Provider 原始工件摘要");
  const createdAt = normalizedIso(rawInput.createdAt, "Provider 原始批次时间");
  const sourceRecords = normalizeProspectProviderSourceRecords(
    rawInput.sourceRecords
  );
  const input: AppendProspectSourceRawBatchInput = {
    ...rawInput,
    teamId: rawInput.teamId.trim(),
    ownerId: rawInput.ownerId.trim(),
    runId: rawInput.runId.trim(),
    shardId: rawInput.shardId.trim(),
    jobId: rawInput.jobId.trim(),
    attemptId: rawInput.attemptId.trim(),
    ledgerId: rawInput.ledgerId.trim(),
    pageId: rawInput.pageId.trim(),
    providerCode: rawInput.providerCode.trim(),
    connectionId: rawInput.connectionId.trim(),
    endpointCode: rawInput.endpointCode.trim(),
    adapterVersion: rawInput.adapterVersion.trim(),
    sourceRecords,
    policy: {
      licensePolicy: rawInput.policy.licensePolicy.trim(),
      retentionPolicy: rawInput.policy.retentionPolicy.trim(),
      retentionDays: rawInput.policy.retentionDays
    },
    createdAt
  };
  if (prospectProviderRawArtifactHash(sourceRecords)
    !== input.rawArtifactHash) {
    conflict("Provider 原始工件摘要与响应记录不一致");
  }

  const batchesForLedger = store.prospectSourceRawBatches.filter((item) =>
    item.ledgerId === input.ledgerId
  );
  if (batchesForLedger.length > 1) {
    conflict("同一 Provider 账本存在多个原始批次");
  }
  if (batchesForLedger.length === 1) {
    return replayExistingBatch(
      store,
      batchesForLedger[0]!,
      sourceRecords,
      input
    );
  }

  const id = batchId(input);
  if (store.prospectSourceRawBatches.some((item) => item.id === id)
    || store.prospectSourceRawHits.some((item) => item.batchId === id)) {
    conflict("Provider 原始批次标识已被其它事实占用");
  }
  const retentionUntil = new Date(
    new Date(createdAt).getTime()
      + input.policy.retentionDays * 86_400_000
  ).toISOString();
  const records: ProspectSourceRawRecord[] = [];
  const hits: ProspectSourceRawHit[] = [];
  const newRecords: ProspectSourceRawRecord[] = [];
  const seenRecordIds = new Set<string>();
  const recordsById = new Map<string, ProspectSourceRawRecord>();
  const recordsByVersion = new Map<string, ProspectSourceRawRecord>();
  const versionKey = (record: Pick<
    ProspectSourceRawRecord,
    "teamId" | "ownerId" | "providerCode" | "connectionId"
      | "endpointCode" | "sourceIdentityHash" | "artifactHash"
  >) => canonical({
    teamId: record.teamId,
    ownerId: record.ownerId,
    providerCode: record.providerCode,
    connectionId: record.connectionId,
    endpointCode: record.endpointCode,
    sourceIdentityHash: record.sourceIdentityHash,
    artifactHash: record.artifactHash
  });
  const indexRecord = (record: ProspectSourceRawRecord) => {
    const byId = recordsById.get(record.id);
    const key = versionKey(record);
    const byVersion = recordsByVersion.get(key);
    if ((byId && byId !== record)
      || (byVersion && byVersion.id !== record.id)) {
      conflict("Provider 原始记录身份与版本事实不唯一");
    }
    recordsById.set(record.id, record);
    recordsByVersion.set(key, record);
  };
  for (const existing of store.prospectSourceRawRecords) {
    indexRecord(existing);
  }

  for (let index = 0; index < sourceRecords.length; index += 1) {
    const source = sourceRecords[index]!;
    const identityHash = sourceIdentityHash(input, source);
    const sourceArtifactHash = artifactHash(source);
    const idValue = recordId({
      teamId: input.teamId,
      ownerId: input.ownerId,
      providerCode: input.providerCode,
      connectionId: input.connectionId,
      endpointCode: input.endpointCode,
      sourceIdentityHash: identityHash,
      artifactHash: sourceArtifactHash
    }, input.identitySecret);
    const recordVersionKey = versionKey({
      teamId: input.teamId,
      ownerId: input.ownerId,
      providerCode: input.providerCode,
      connectionId: input.connectionId,
      endpointCode: input.endpointCode,
      sourceIdentityHash: identityHash,
      artifactHash: sourceArtifactHash
    });
    const recordById = recordsById.get(idValue);
    const recordByVersion = recordsByVersion.get(recordVersionKey);
    if (recordById && recordByVersion
      && recordById.id !== recordByVersion.id) {
      conflict("Provider 原始记录身份与版本事实不唯一");
    }
    let record = recordById || recordByVersion;
    if (record) {
      verifyRecord(record, source, input);
    } else {
      const recordBase = {
        id: idValue,
        teamId: input.teamId,
        ownerId: input.ownerId,
        providerCode: input.providerCode,
        connectionId: input.connectionId,
        endpointCode: input.endpointCode,
        sourceIdentityHash: identityHash,
        artifactHash: sourceArtifactHash,
        envelopeVersion: PROSPECT_SOURCE_RAW_ENVELOPE_VERSION,
        firstObservedAt: source.fetchedAt,
        createdAt
      } as const;
      const encryptedEnvelope = encryptRawRecord(recordBase, {
        providerRecordId: source.providerRecordId,
        sourceUrl: source.sourceUrl,
        payload: source.payload
      }, input.envelopeSecret);
      const withoutHash: Omit<ProspectSourceRawRecord, "recordHash"> = {
        ...recordBase,
        encryptedEnvelope,
        envelopeHash: createHash("sha256")
          .update(encryptedEnvelope)
          .digest("hex")
      };
      record = {
        ...withoutHash,
        recordHash: rawRecordHash(withoutHash)
      };
      newRecords.push(record);
      indexRecord(record);
    }
    if (!seenRecordIds.has(record.id)) {
      seenRecordIds.add(record.id);
      records.push(record);
    }
    const hitWithoutDigest: Omit<ProspectSourceRawHit, "hitHash"> = {
      id: hitId(id, index + 1),
      batchId: id,
      recordId: record.id,
      teamId: input.teamId,
      ownerId: input.ownerId,
      runId: input.runId,
      shardId: input.shardId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      ledgerId: input.ledgerId,
      pageId: input.pageId,
      ordinal: index + 1,
      fetchedAt: source.fetchedAt,
      createdAt
    };
    hits.push({
      ...hitWithoutDigest,
      hitHash: rawHitHash(hitWithoutDigest)
    });
  }

  const batchWithoutDigest: Omit<ProspectSourceRawBatch, "batchHash"> = {
    id,
    teamId: input.teamId,
    ownerId: input.ownerId,
    runId: input.runId,
    shardId: input.shardId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    ledgerId: input.ledgerId,
    pageId: input.pageId,
    providerCode: input.providerCode,
    connectionId: input.connectionId,
    endpointCode: input.endpointCode,
    adapterVersion: input.adapterVersion,
    responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
    responseHash: input.responseHash,
    settlementHash: input.settlementHash,
    rawArtifactHash: input.rawArtifactHash,
    recordCount: sourceRecords.length,
    licensePolicy: input.policy.licensePolicy,
    retentionPolicy: input.policy.retentionPolicy,
    retentionDays: input.policy.retentionDays,
    retentionUntil,
    createdAt
  };
  const batch: ProspectSourceRawBatch = {
    ...batchWithoutDigest,
    batchHash: rawBatchHash(batchWithoutDigest, hits)
  };
  store.prospectSourceRawRecords.push(...newRecords);
  store.prospectSourceRawBatches.push(batch);
  store.prospectSourceRawHits.push(...hits);
  return {
    idempotent: false,
    batch: structuredClone(batch),
    records: structuredClone(records),
    hits: structuredClone(hits)
  };
}
