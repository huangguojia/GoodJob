import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes
} from "node:crypto";
import mysql from "mysql2/promise";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  applyProspectQualificationCommand,
  PROSPECT_QUALIFICATION_ARRAYS,
  PROSPECT_QUALIFICATION_CONTRACT,
  PROSPECT_QUALIFICATION_RECORD_TYPES,
  ProspectQualificationError,
  validateProspectQualificationState
} from "./prospect-qualification.js";
import type {
  ProspectQualificationCommand,
  ProspectQualificationCommandResult
} from "./prospect-qualification.js";
import type { CrmStore } from "./store.js";
import type {
  CompanyVerificationSnapshot,
  ProspectContact,
  ProspectContactChannel,
  ProspectContactVerificationSnapshot,
  ProspectContactabilityDecision,
  ProspectEvidence,
  ProspectIcpAssessmentSnapshot,
  ProspectIcpPolicySnapshot,
  ProspectSuppressionEvent
} from "./types.js";

const PERSISTENCE_SCHEMA_VERSION = "prospect-qualification-mysql-v1";
const SCHEMA_LOCK = "goodjob_prospect_qualification_schema_v1";
const HKDF_SALT = Buffer.from("goodjob-prospect-qualification-v1", "utf8");

type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;

type QualificationSecrets = {
  encryptionKey: Buffer;
  rowIntegrityKey: Buffer;
  metadataKey: Buffer;
  keyFingerprint: string;
};

type QualificationRecord =
  | ProspectEvidence
  | CompanyVerificationSnapshot
  | ProspectIcpPolicySnapshot
  | ProspectIcpAssessmentSnapshot
  | ProspectContact
  | ProspectContactChannel
  | ProspectContactVerificationSnapshot
  | ProspectSuppressionEvent
  | ProspectContactabilityDecision;

export type ProspectQualificationState = {
  prospectEvidence: ProspectEvidence[];
  companyVerificationSnapshots: CompanyVerificationSnapshot[];
  prospectIcpPolicySnapshots: ProspectIcpPolicySnapshot[];
  prospectIcpAssessmentSnapshots: ProspectIcpAssessmentSnapshot[];
  prospectContacts: ProspectContact[];
  prospectContactChannels: ProspectContactChannel[];
  prospectContactVerificationSnapshots:
    ProspectContactVerificationSnapshot[];
  prospectSuppressionEvents: ProspectSuppressionEvent[];
  prospectContactabilityDecisions: ProspectContactabilityDecision[];
};

const EMPTY_STATE: ProspectQualificationState = {
  prospectEvidence: [],
  companyVerificationSnapshots: [],
  prospectIcpPolicySnapshots: [],
  prospectIcpAssessmentSnapshots: [],
  prospectContacts: [],
  prospectContactChannels: [],
  prospectContactVerificationSnapshots: [],
  prospectSuppressionEvents: [],
  prospectContactabilityDecisions: []
};

const ARRAY_BY_RECORD_TYPE = Object.fromEntries(
  Object.entries(PROSPECT_QUALIFICATION_RECORD_TYPES)
    .map(([arrayName, recordType]) => [recordType, arrayName])
) as Record<
  typeof PROSPECT_QUALIFICATION_RECORD_TYPES[
    keyof typeof PROSPECT_QUALIFICATION_RECORD_TYPES
  ],
  keyof ProspectQualificationState
>;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS prospect_qualification_contract_metadata (
    id TINYINT PRIMARY KEY,
    contract_version VARCHAR(80) NOT NULL,
    persistence_schema_version VARCHAR(80) NOT NULL,
    key_fingerprint CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    metadata_mac CHAR(64) NOT NULL,
    CONSTRAINT chk_pq_metadata_singleton CHECK (id = 1),
    CONSTRAINT chk_pq_metadata_status CHECK (status = 'active')
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS prospect_qualification_team_guards (
    team_id VARCHAR(64) PRIMARY KEY,
    guard_version BIGINT NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT chk_pq_guard_version CHECK (guard_version >= 1)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS prospect_qualification_facts (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    prospect_id VARCHAR(90) NOT NULL,
    organization_id VARCHAR(90) NOT NULL,
    record_type VARCHAR(60) NOT NULL,
    visibility_scope VARCHAR(20) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    record_hash CHAR(64) NOT NULL,
    encrypted_payload LONGTEXT NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    UNIQUE KEY uk_pq_fact_team_id(team_id, id),
    UNIQUE KEY uk_pq_fact_idempotency(
      team_id,owner_id,record_type,idempotency_key_hash
    ),
    INDEX idx_pq_fact_owner_prospect(
      team_id,owner_id,prospect_id,record_type,created_at
    ),
    INDEX idx_pq_fact_organization(
      team_id,organization_id,record_type,created_at
    ),
    CONSTRAINT chk_pq_fact_visibility CHECK (
      visibility_scope IN ('team','owner')
    )
  ) ENGINE=InnoDB`
];

const qualificationQueues =
  new WeakMap<CrmStore, Map<string, Promise<unknown>>>();

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") {
    throw new ProspectQualificationError(
      "QUALIFICATION_CANONICAL_INVALID",
      "资格事实无法规范化"
    );
  }
  return result;
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function hmac(key: Buffer, value: unknown) {
  return createHmac("sha256", key)
    .update(canonical(value))
    .digest("hex");
}

function configurationError(message: string): never {
  throw new ProspectQualificationError(
    "QUALIFICATION_CONFIGURATION_INVALID",
    message
  );
}

function integrityError(message: string): never {
  throw new ProspectQualificationError(
    "QUALIFICATION_DATA_INTEGRITY",
    message
  );
}

function configuredSecrets(required: boolean) {
  const master = process.env.PROSPECT_QUALIFICATION_MASTER_SECRET
    || process.env.PROSPECT_COVERAGE_MASTER_SECRET
    || process.env.ORGANIZATION_IDENTITY_MASTER_SECRET;
  if (!master && !required) return null;
  if (!master || Buffer.byteLength(master, "utf8") < 32) {
    configurationError(
      "PROSPECT_QUALIFICATION_MASTER_SECRET 必须至少包含 32 字节"
    );
  }
  const derive = (info: string) => Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(master, "utf8"),
    HKDF_SALT,
    Buffer.from(info, "utf8"),
    32
  ));
  const fingerprintKey = derive("key-fingerprint-v1");
  return {
    encryptionKey: derive("payload-aes-256-gcm-v1"),
    rowIntegrityKey: derive("row-integrity-hmac-v1"),
    metadataKey: derive("metadata-hmac-v1"),
    keyFingerprint: sha256({
      contract: PERSISTENCE_SCHEMA_VERSION,
      key: fingerprintKey.toString("base64url")
    })
  };
}

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) {
    integrityError("资格事实数据库时间无效");
  }
  return date.toISOString();
}

async function queryRows<T>(
  source: QuerySource,
  sql: string,
  values: unknown[] = []
) {
  const [rows] = await source.query(sql, values);
  return rows as T[];
}

function encryptPayload(value: QualificationRecord, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(canonical(value), "utf8");
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);
  return JSON.stringify({
    version: "aes-256-gcm-v1",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  });
}

function decryptPayload(value: string, key: Buffer) {
  let envelope: {
    version: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };
  try {
    envelope = JSON.parse(value);
  } catch {
    integrityError("资格事实密文封装不是有效 JSON");
  }
  if (envelope.version !== "aes-256-gcm-v1") {
    integrityError("资格事实密文版本不受支持");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8")) as QualificationRecord;
  } catch {
    integrityError("资格事实密文认证失败");
  }
}

function metadataBase(secrets: QualificationSecrets, createdAt: string) {
  return {
    id: 1,
    contract_version: PROSPECT_QUALIFICATION_CONTRACT,
    persistence_schema_version: PERSISTENCE_SCHEMA_VERSION,
    key_fingerprint: secrets.keyFingerprint,
    status: "active",
    created_at: createdAt
  };
}

function metadataMac(
  value: ReturnType<typeof metadataBase>,
  secrets: QualificationSecrets
) {
  return hmac(secrets.metadataKey, {
    contract: PERSISTENCE_SCHEMA_VERSION,
    row: "metadata",
    value
  });
}

async function factCount(source: QuerySource) {
  const rows = await queryRows<{ count: number | string }>(
    source,
    "SELECT COUNT(*) AS count FROM prospect_qualification_facts"
  );
  return Number(rows[0]?.count || 0);
}

async function validateMetadata(
  source: QuerySource,
  secrets: QualificationSecrets | null,
  lockForUpdate = false
) {
  const rows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM prospect_qualification_contract_metadata
     WHERE id = 1${lockForUpdate ? " FOR UPDATE" : ""}`
  );
  if (!rows.length) {
    if (await factCount(source)) {
      integrityError("资格事实存在但缺少合同元数据");
    }
    return false;
  }
  if (!secrets) {
    configurationError("已有资格事实，但服务端资格密钥未配置");
  }
  const row = rows[0]!;
  const expected = metadataBase(secrets, iso(row.created_at));
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === "created_at" ? iso(row[key]) : row[key];
    if (String(actual ?? "") !== String(value)) {
      configurationError("资格事实合同版本或密钥不匹配");
    }
  }
  if (String(row.metadata_mac || "")
    !== metadataMac(expected, secrets)) {
    integrityError("资格事实元数据 MAC 校验失败");
  }
  return true;
}

async function initializeMetadata(
  connection: mysql.PoolConnection,
  secrets: QualificationSecrets,
  createdAt: string
) {
  if (await validateMetadata(connection, secrets, true)) return;
  const value = metadataBase(secrets, createdAt);
  await connection.query(
    `INSERT INTO prospect_qualification_contract_metadata (
       id,contract_version,persistence_schema_version,key_fingerprint,
       status,created_at,metadata_mac
     ) VALUES (?,?,?,?,?,?,?)`,
    [
      value.id,
      value.contract_version,
      value.persistence_schema_version,
      value.key_fingerprint,
      value.status,
      new Date(value.created_at),
      metadataMac(value, secrets)
    ]
  );
}

function factIndex(record: QualificationRecord) {
  const recordTypeEntry = Object.entries(
    PROSPECT_QUALIFICATION_RECORD_TYPES
  ).find(([arrayName]) =>
    (recordTypeRows(record, arrayName as keyof ProspectQualificationState))
  );
  if (!recordTypeEntry) integrityError("无法识别资格事实类型");
  const [, recordType] = recordTypeEntry;
  const ownerId = "ownerId" in record ? record.ownerId : "";
  const prospectId = "prospectId" in record ? record.prospectId : "";
  const organizationId =
    "organizationId" in record ? record.organizationId : "";
  const visibilityScope = recordType === "company_verification_snapshot"
    || recordType === "prospect_suppression_event"
    ? "team"
    : "owner";
  return {
    recordType,
    ownerId,
    prospectId,
    organizationId,
    visibilityScope
  };
}

function recordTypeRows(
  record: QualificationRecord,
  arrayName: keyof ProspectQualificationState
) {
  switch (arrayName) {
    case "prospectEvidence":
      return "kind" in record && "field" in record;
    case "companyVerificationSnapshots":
      return "status" in record && "authorityCodes" in record
        && "validUntil" in record;
    case "prospectIcpPolicySnapshots":
      return "policyHash" in record;
    case "prospectIcpAssessmentSnapshots":
      return "dimensionScores" in record && "totalScore" in record;
    case "prospectContacts":
      return "contactType" in record && "identityStatus" in record;
    case "prospectContactChannels":
      return "channelType" in record && "normalizedValueHash" in record
        && "value" in record;
    case "prospectContactVerificationSnapshots":
      return "verifiedAt" in record && "previousVerificationId" in record;
    case "prospectSuppressionEvents":
      return "scopeKeyHash" in record && "action" in record;
    case "prospectContactabilityDecisions":
      return "dependencyHash" in record && "reasonCodes" in record;
  }
}

function rowMac(
  row: {
    id: string;
    teamId: string;
    ownerId: string;
    prospectId: string;
    organizationId: string;
    recordType: string;
    visibilityScope: string;
    idempotencyKeyHash: string;
    requestHash: string;
    recordHash: string;
    encryptedPayload: string;
    payloadHash: string;
    createdAt: string;
  },
  secrets: QualificationSecrets
) {
  return hmac(secrets.rowIntegrityKey, {
    contract: PERSISTENCE_SCHEMA_VERSION,
    table: "prospect_qualification_facts",
    row
  });
}

async function insertFact(
  connection: mysql.PoolConnection,
  record: QualificationRecord,
  secrets: QualificationSecrets
) {
  const index = factIndex(record);
  const encryptedPayload = encryptPayload(record, secrets.encryptionKey);
  const payloadHash = sha256(record);
  const row = {
    id: record.id,
    teamId: record.teamId,
    ownerId: index.ownerId,
    prospectId: index.prospectId,
    organizationId: index.organizationId,
    recordType: index.recordType,
    visibilityScope: index.visibilityScope,
    idempotencyKeyHash: record.idempotencyKeyHash,
    requestHash: record.requestHash,
    recordHash: record.recordHash,
    encryptedPayload,
    payloadHash,
    createdAt: record.createdAt
  };
  await connection.query(
    `INSERT INTO prospect_qualification_facts (
       id,team_id,owner_id,prospect_id,organization_id,record_type,
       visibility_scope,idempotency_key_hash,request_hash,record_hash,
       encrypted_payload,payload_hash,created_at,row_mac
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.teamId,
      row.ownerId,
      row.prospectId,
      row.organizationId,
      row.recordType,
      row.visibilityScope,
      row.idempotencyKeyHash,
      row.requestHash,
      row.recordHash,
      row.encryptedPayload,
      row.payloadHash,
      new Date(row.createdAt),
      rowMac(row, secrets)
    ]
  );
}

export async function ensureProspectQualificationSchema(pool: mysql.Pool) {
  const connection = await pool.getConnection();
  let acquired = false;
  try {
    const rows = await queryRows<{ acquired: number | string }>(
      connection,
      "SELECT GET_LOCK(?, 30) AS acquired",
      [SCHEMA_LOCK]
    );
    acquired = Number(rows[0]?.acquired || 0) === 1;
    if (!acquired) configurationError("无法获取资格 Schema 锁");
    for (const sql of SCHEMA_SQL) await connection.query(sql);
  } finally {
    if (acquired) {
      await connection.query("SELECT RELEASE_LOCK(?)", [SCHEMA_LOCK]);
    }
    connection.release();
  }
}

export async function loadProspectQualificationState(
  source: QuerySource,
  teamId?: string
): Promise<ProspectQualificationState> {
  const secrets = configuredSecrets(false);
  if (!await validateMetadata(source, secrets)) {
    return structuredClone(EMPTY_STATE);
  }
  const rows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM prospect_qualification_facts
     ${teamId ? "WHERE team_id = ?" : ""}
     ORDER BY created_at,id`,
    teamId ? [teamId] : []
  );
  const state = structuredClone(EMPTY_STATE);
  for (const raw of rows) {
    const row = {
      id: String(raw.id || ""),
      teamId: String(raw.team_id || ""),
      ownerId: String(raw.owner_id || ""),
      prospectId: String(raw.prospect_id || ""),
      organizationId: String(raw.organization_id || ""),
      recordType: String(raw.record_type || ""),
      visibilityScope: String(raw.visibility_scope || ""),
      idempotencyKeyHash: String(raw.idempotency_key_hash || ""),
      requestHash: String(raw.request_hash || ""),
      recordHash: String(raw.record_hash || ""),
      encryptedPayload: String(raw.encrypted_payload || ""),
      payloadHash: String(raw.payload_hash || ""),
      createdAt: iso(raw.created_at)
    };
    if (!secrets || String(raw.row_mac || "") !== rowMac(row, secrets)) {
      integrityError("资格事实 Row MAC 校验失败");
    }
    const record = decryptPayload(row.encryptedPayload, secrets.encryptionKey);
    if (sha256(record) !== row.payloadHash
      || record.id !== row.id
      || record.teamId !== row.teamId
      || record.recordHash !== row.recordHash
      || record.idempotencyKeyHash !== row.idempotencyKeyHash
      || record.requestHash !== row.requestHash
      || record.createdAt !== row.createdAt) {
      integrityError("资格事实索引与密文载荷不一致");
    }
    const expectedIndex = factIndex(record);
    if (expectedIndex.recordType !== row.recordType
      || expectedIndex.ownerId !== row.ownerId
      || expectedIndex.prospectId !== row.prospectId
      || expectedIndex.organizationId !== row.organizationId
      || expectedIndex.visibilityScope !== row.visibilityScope) {
      integrityError("资格事实作用域索引不一致");
    }
    const arrayName = ARRAY_BY_RECORD_TYPE[
      row.recordType as keyof typeof ARRAY_BY_RECORD_TYPE
    ];
    if (!arrayName) integrityError("资格事实类型不受支持");
    (state[arrayName] as QualificationRecord[]).push(record);
  }
  return state;
}

function replaceTeamState(
  store: CrmStore,
  teamId: string,
  state: ProspectQualificationState
) {
  for (const key of PROSPECT_QUALIFICATION_ARRAYS) {
    const target = store[key] as QualificationRecord[];
    const retained = target.filter((item) => item.teamId !== teamId);
    target.splice(
      0,
      target.length,
      ...retained,
      ...(state[key] as QualificationRecord[])
    );
  }
}

function enqueueTeam<T>(
  store: CrmStore,
  teamId: string,
  operation: () => Promise<T>
) {
  let queues = qualificationQueues.get(store);
  if (!queues) {
    queues = new Map();
    qualificationQueues.set(store, queues);
  }
  const previous = queues.get(teamId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(teamId, current);
  return current.finally(() => {
    if (queues?.get(teamId) === current) queues.delete(teamId);
  });
}

export async function applyProspectQualificationCommandMysql(
  pool: mysql.Pool,
  store: CrmStore,
  command: ProspectQualificationCommand
): Promise<ProspectQualificationCommandResult> {
  return enqueueTeam(store, command.teamId, async () => {
    const secrets = configuredSecrets(true)!;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const createdAt = command.createdAt || new Date().toISOString();
      await initializeMetadata(connection, secrets, iso(createdAt));
      await connection.query(
        `INSERT INTO prospect_qualification_team_guards (
           team_id,guard_version,updated_at
         ) VALUES (?,1,?)
         ON DUPLICATE KEY UPDATE team_id = VALUES(team_id)`,
        [command.teamId, new Date(createdAt)]
      );
      await connection.query(
        `SELECT guard_version FROM prospect_qualification_team_guards
         WHERE team_id = ? FOR UPDATE`,
        [command.teamId]
      );
      const state = await loadProspectQualificationState(
        connection,
        command.teamId
      );
      const local = {
        ...store,
        ...state,
        mode: "memory"
      } as CrmStore;
      const result = applyProspectQualificationCommand(local, command);
      if (!result.replayed) {
        await insertFact(connection, result.record, secrets);
        await connection.query(
          `UPDATE prospect_qualification_team_guards
           SET guard_version = guard_version + 1,updated_at = ?
           WHERE team_id = ?`,
          [new Date(createdAt), command.teamId]
        );
      }
      await connection.commit();
      replaceTeamState(store, command.teamId, stateFromStore(local));
      validateProspectQualificationState(store);
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });
}

function stateFromStore(store: CrmStore): ProspectQualificationState {
  return {
    prospectEvidence: store.prospectEvidence,
    companyVerificationSnapshots: store.companyVerificationSnapshots,
    prospectIcpPolicySnapshots: store.prospectIcpPolicySnapshots,
    prospectIcpAssessmentSnapshots: store.prospectIcpAssessmentSnapshots,
    prospectContacts: store.prospectContacts,
    prospectContactChannels: store.prospectContactChannels,
    prospectContactVerificationSnapshots:
      store.prospectContactVerificationSnapshots,
    prospectSuppressionEvents: store.prospectSuppressionEvents,
    prospectContactabilityDecisions:
      store.prospectContactabilityDecisions
  };
}

export async function ensureProspectQualificationTeamCache(
  pool: mysql.Pool,
  store: CrmStore,
  teamId: string
) {
  return enqueueTeam(store, teamId, async () => {
    const state = await loadProspectQualificationState(pool, teamId);
    replaceTeamState(store, teamId, state);
    validateProspectQualificationState(store);
  });
}
