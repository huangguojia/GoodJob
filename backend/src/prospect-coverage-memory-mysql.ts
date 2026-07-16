import {
  createHash,
  createHmac,
  hkdfSync
} from "node:crypto";
import mysql from "mysql2/promise";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  PROSPECT_COVERAGE_MEMORY_CONTRACT,
  ProspectCoverageMemoryError,
  prospectCoverageEventFactHash,
  recordProspectCoverage,
  setTenantProspectDisposition,
  tenantProspectFactHash
} from "./prospect-coverage-memory.js";
import type {
  RecordProspectCoveragePersistedInput,
  RecordProspectCoverageResult,
  SetTenantProspectDispositionPersistedInput,
  SetTenantProspectDispositionResult
} from "./prospect-coverage-memory.js";
import {
  loadOrganizationIdentityState
} from "./organization-strong-identity-mysql.js";
import {
  convertProspectToCustomer,
  prospectCustomerConversionIds,
  ProspectCustomerConversionError
} from "./prospect-customer-conversion.js";
import type {
  ConvertProspectToCustomerPersistedInput,
  ConvertProspectToCustomerResult
} from "./prospect-customer-conversion.js";
import {
  convertProspectToLead,
  prospectLeadConversionIds,
  PROSPECT_LEAD_SOURCE_CHANNEL,
  ProspectLeadConversionError
} from "./prospect-lead-conversion.js";
import type {
  ConvertProspectToLeadPersistedInput,
  ConvertProspectToLeadResult
} from "./prospect-lead-conversion.js";
import {
  loadProspectQualificationState
} from "./prospect-qualification-mysql.js";
import type { CrmStore } from "./store.js";
import type {
  Customer,
  CustomerAcquisitionSourceEvent,
  CustomerActivity,
  Lead,
  LeadActivity,
  LeadSourceEvent,
  ProspectCoverageEvent,
  ProspectRunShard,
  ProspectSearchRun,
  ProspectSourceRawHit,
  ProspectSourceRawRecord,
  TenantProspect
} from "./types.js";

const PERSISTENCE_SCHEMA_VERSION = "prospect-coverage-mysql-v1";
const CANONICAL_VERSION = "canonical-json-v1";
const HKDF_VERSION = "hkdf-sha256-v1";
const SCHEMA_LOCK = "goodjob_prospect_coverage_schema_v1";
const HKDF_SALT = Buffer.from("goodjob-prospect-coverage-v1", "utf8");
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const coverageCacheVersions =
  new WeakMap<CrmStore, Map<string, number>>();

type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;

type CoverageSecrets = {
  stateSecret: string;
  rowIntegrityKey: Buffer;
  metadataKey: Buffer;
};

export type ProspectCoverageState = {
  tenantProspects: TenantProspect[];
  prospectCoverageEvents: ProspectCoverageEvent[];
};

const EMPTY_STATE: ProspectCoverageState = {
  tenantProspects: [],
  prospectCoverageEvents: []
};

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS prospect_coverage_contract_metadata (
    id TINYINT PRIMARY KEY,
    contract_version VARCHAR(80) NOT NULL,
    persistence_schema_version VARCHAR(80) NOT NULL,
    canonical_version VARCHAR(40) NOT NULL,
    hash_algorithm VARCHAR(40) NOT NULL,
    hkdf_version VARCHAR(40) NOT NULL,
    key_fingerprint CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    metadata_mac CHAR(64) NOT NULL,
    CONSTRAINT chk_pc_metadata_singleton CHECK (id = 1),
    CONSTRAINT chk_pc_metadata_status CHECK (status = 'active')
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS prospect_coverage_team_guards (
    team_id VARCHAR(64) PRIMARY KEY,
    guard_version BIGINT NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT chk_pc_guard_version CHECK (guard_version >= 1)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS tenant_prospects (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    organization_id VARCHAR(90) NOT NULL,
    lifecycle_status VARCHAR(30) NOT NULL,
    last_classification VARCHAR(40) NOT NULL,
    queue_state VARCHAR(30) NOT NULL,
    queue_reason_code VARCHAR(200) NOT NULL,
    first_seen_at DATETIME(3) NOT NULL,
    last_seen_at DATETIME(3) NOT NULL,
    last_material_change_at DATETIME(3) NOT NULL,
    last_queued_at DATETIME(3) NULL,
    last_reviewed_at DATETIME(3) NULL,
    next_review_at DATETIME(3) NULL,
    hit_count BIGINT NOT NULL,
    source_count BIGINT NOT NULL,
    evidence_count BIGINT NOT NULL,
    source_key_hashes_json MEDIUMTEXT NOT NULL,
    material_evidence_key_hashes_json MEDIUMTEXT NOT NULL,
    exclusion_scope VARCHAR(30) NOT NULL,
    exclusion_mode VARCHAR(30) NOT NULL,
    exclusion_reason_code VARCHAR(200) NOT NULL,
    excluded_until DATETIME(3) NULL,
    lead_id VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    deal_id VARCHAR(64) NOT NULL,
    version_no BIGINT NOT NULL,
    event_count BIGINT NOT NULL,
    event_tail_hash CHAR(64) NOT NULL,
    prospect_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    UNIQUE KEY uk_pc_prospect_team_id(team_id, id),
    UNIQUE KEY uk_pc_prospect_team_organization(team_id, organization_id),
    CONSTRAINT fk_pc_prospect_organization
      FOREIGN KEY (team_id, organization_id)
      REFERENCES organizations(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_pc_prospect_status CHECK (
      lifecycle_status IN ('active','excluded','do_not_contact','converted')
    ),
    CONSTRAINT chk_pc_prospect_classification CHECK (
      last_classification IN (
        'net_new','new_intelligence','due_review','duplicate','excluded'
      )
    ),
    CONSTRAINT chk_pc_prospect_queue CHECK (
      queue_state IN ('none','pending','suppressed','converted')
    ),
    CONSTRAINT chk_pc_prospect_exclusion_scope CHECK (
      exclusion_scope IN ('none','organization','team')
    ),
    CONSTRAINT chk_pc_prospect_exclusion_mode CHECK (
      exclusion_mode IN ('none','temporary','permanent')
    ),
    CONSTRAINT chk_pc_prospect_counts CHECK (
      hit_count >= 1 AND source_count >= 1 AND evidence_count >= 0
      AND version_no >= 1 AND event_count >= 1
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS prospect_coverage_events (
    id VARCHAR(90) PRIMARY KEY,
    prospect_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    organization_id VARCHAR(90) NOT NULL,
    resolution_id VARCHAR(90) NULL,
    raw_record_id VARCHAR(90) NULL,
    source_hit_id VARCHAR(90) NULL,
    campaign_id VARCHAR(80) NULL,
    strategy_id VARCHAR(80) NULL,
    run_id VARCHAR(80) NULL,
    shard_id VARCHAR(90) NULL,
    sequence_no BIGINT NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    disposition_action VARCHAR(40) NOT NULL,
    classification VARCHAR(40) NOT NULL,
    queue_action VARCHAR(30) NOT NULL,
    reason_code VARCHAR(200) NOT NULL,
    processing_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    new_evidence_key_hashes_json MEDIUMTEXT NOT NULL,
    new_source_key_hashes_json MEDIUMTEXT NOT NULL,
    evidence_snapshot_hash CHAR(64) NOT NULL,
    source_snapshot_hash CHAR(64) NOT NULL,
    previous_event_hash CHAR(64) NOT NULL,
    event_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    UNIQUE KEY uk_pc_event_team_id(team_id, id),
    UNIQUE KEY uk_pc_event_processing(team_id, processing_key_hash),
    UNIQUE KEY uk_pc_event_prospect_sequence(
      team_id, prospect_id, sequence_no
    ),
    CONSTRAINT fk_pc_event_prospect
      FOREIGN KEY (team_id, prospect_id)
      REFERENCES tenant_prospects(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_pc_event_organization
      FOREIGN KEY (team_id, organization_id)
      REFERENCES organizations(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_pc_event_resolution
      FOREIGN KEY (team_id, owner_id, resolution_id)
      REFERENCES organization_identity_resolutions(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_pc_event_raw
      FOREIGN KEY (team_id, owner_id, raw_record_id)
      REFERENCES prospect_source_raw_records(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_pc_event_hit
      FOREIGN KEY (team_id, owner_id, source_hit_id)
      REFERENCES prospect_source_raw_hits(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_pc_event_sequence CHECK (sequence_no >= 1),
    CONSTRAINT chk_pc_event_type CHECK (
      event_type IN ('coverage_classified','disposition_changed')
    ),
    CONSTRAINT chk_pc_event_queue_action CHECK (
      queue_action IN ('enqueue','suppress','none')
    )
  ) ENGINE=InnoDB`
];

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") {
    integrityError("覆盖记忆事实无法 Canonical 化");
  }
  return result;
}

function hmac(key: Buffer | string, value: unknown) {
  return createHmac("sha256", key)
    .update(canonical(value))
    .digest("hex");
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function integrityError(message: string): never {
  throw new ProspectCoverageMemoryError(
    "PROSPECT_COVERAGE_DATA_INTEGRITY_VIOLATION",
    message
  );
}

function configurationError(message: string): never {
  throw new ProspectCoverageMemoryError(
    "PROSPECT_COVERAGE_CONFIGURATION_INVALID",
    message
  );
}

function requireSecret(name: string, value: string | undefined) {
  if (!value || Buffer.byteLength(value, "utf8") < 32) {
    configurationError(`${name} 必须至少包含 32 字节`);
  }
  return value;
}

function deriveKey(master: string, info: string) {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(master, "utf8"),
    HKDF_SALT,
    Buffer.from(info, "utf8"),
    32
  ));
}

function configuredSecrets(required: boolean): CoverageSecrets | null {
  const configured = process.env.PROSPECT_COVERAGE_MASTER_SECRET
    || process.env.ORGANIZATION_IDENTITY_MASTER_SECRET;
  if (!configured && !required) return null;
  const master = requireSecret(
    "PROSPECT_COVERAGE_MASTER_SECRET 或 "
      + "ORGANIZATION_IDENTITY_MASTER_SECRET",
    configured
  );
  return {
    stateSecret: deriveKey(
      master,
      "prospect-coverage-state-hmac-v1"
    ).toString("base64url"),
    rowIntegrityKey: deriveKey(
      master,
      "prospect-coverage-row-integrity-hmac-v1"
    ),
    metadataKey: deriveKey(
      master,
      "prospect-coverage-metadata-hmac-v1"
    )
  };
}

function keyFingerprint(secret: string) {
  return sha256({
    contract: "prospect-coverage-key-fingerprint-v1",
    keyVersion: "v1",
    secret
  });
}

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) {
    integrityError("覆盖记忆数据库时间字段无效");
  }
  return date.toISOString();
}

function optionalIso(value: unknown) {
  return value ? iso(value) : "";
}

async function queryRows<T>(
  source: QuerySource,
  sql: string,
  values: unknown[] = []
) {
  const [rows] = await source.query(sql, values);
  return rows as T[];
}

function rowMac(
  table: string,
  value: TenantProspect | ProspectCoverageEvent,
  secrets: CoverageSecrets
) {
  return hmac(secrets.rowIntegrityKey, {
    contract: PERSISTENCE_SCHEMA_VERSION,
    table,
    value
  });
}

function metadataBase(secrets: CoverageSecrets, createdAt: string) {
  return {
    id: 1,
    contract_version: PROSPECT_COVERAGE_MEMORY_CONTRACT,
    persistence_schema_version: PERSISTENCE_SCHEMA_VERSION,
    canonical_version: CANONICAL_VERSION,
    hash_algorithm: "sha256+hmac-sha256",
    hkdf_version: HKDF_VERSION,
    key_fingerprint: keyFingerprint(secrets.stateSecret),
    status: "active",
    created_at: createdAt
  };
}

function metadataMac(
  value: ReturnType<typeof metadataBase>,
  secrets: CoverageSecrets
) {
  return hmac(secrets.metadataKey, {
    contract: PERSISTENCE_SCHEMA_VERSION,
    row: "contract_metadata",
    ...value
  });
}

async function coverageFactCount(source: QuerySource) {
  const prospects = await queryRows<{ count: number | string }>(
    source,
    "SELECT COUNT(*) AS count FROM tenant_prospects"
  );
  const events = await queryRows<{ count: number | string }>(
    source,
    "SELECT COUNT(*) AS count FROM prospect_coverage_events"
  );
  return Number(prospects[0]?.count || 0)
    + Number(events[0]?.count || 0);
}

async function validateMetadata(
  source: QuerySource,
  secrets: CoverageSecrets | null,
  lockForUpdate = false
) {
  const rows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM prospect_coverage_contract_metadata
     WHERE id = 1${lockForUpdate ? " FOR UPDATE" : ""}`
  );
  if (!rows.length) {
    if (await coverageFactCount(source)) {
      integrityError("覆盖记忆事实存在但缺少 Contract Metadata");
    }
    return false;
  }
  if (rows.length !== 1) integrityError("覆盖记忆 Metadata 不唯一");
  if (!secrets) {
    configurationError("已有覆盖记忆数据，但服务端覆盖密钥未配置");
  }
  const row = rows[0]!;
  const createdAt = iso(row.created_at);
  const expected = metadataBase(secrets, createdAt);
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === "created_at" ? createdAt : row[key];
    if (String(actual ?? "") !== String(value)) {
      configurationError("覆盖记忆 Metadata 与当前合同或密钥不一致");
    }
  }
  if (String(row.metadata_mac || "")
    !== metadataMac(expected, secrets)) {
    integrityError("覆盖记忆 Metadata MAC 校验失败");
  }
  return true;
}

async function initializeMetadata(
  connection: mysql.PoolConnection,
  secrets: CoverageSecrets,
  createdAt: string
) {
  if (await validateMetadata(connection, secrets, true)) return;
  const expected = metadataBase(secrets, createdAt);
  await connection.query(
    `INSERT INTO prospect_coverage_contract_metadata (
       id,contract_version,persistence_schema_version,canonical_version,
       hash_algorithm,hkdf_version,key_fingerprint,status,created_at,
       metadata_mac
     ) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE id = VALUES(id)`,
    [
      expected.id,
      expected.contract_version,
      expected.persistence_schema_version,
      expected.canonical_version,
      expected.hash_algorithm,
      expected.hkdf_version,
      expected.key_fingerprint,
      expected.status,
      new Date(expected.created_at),
      metadataMac(expected, secrets)
    ]
  );
  if (!await validateMetadata(connection, secrets, true)) {
    integrityError("覆盖记忆 Metadata 初始化失败");
  }
}

async function ensureUniqueIndex(
  pool: mysql.Pool,
  table: string,
  index: string,
  columns: string[]
) {
  const rows = await queryRows<{
    columnName: string;
    nonUnique: number | string;
  }>(
    pool,
    `SELECT column_name AS columnName, non_unique AS nonUnique
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = ? AND index_name = ?
     ORDER BY seq_in_index`,
    [table, index]
  );
  const matches = rows.length === columns.length
    && rows.every((row, position) =>
      Number(row.nonUnique) === 0
      && row.columnName === columns[position]
    );
  if (matches) return;
  if (rows.length) {
    await pool.query(
      `ALTER TABLE \`${table}\` DROP INDEX \`${index}\``
    );
  }
  await pool.query(
    `ALTER TABLE \`${table}\`
     ADD UNIQUE KEY \`${index}\` (
       ${columns.map((column) => `\`${column}\``).join(",")}
     )`
  );
}

async function ensureOwnerForeignKey(
  pool: mysql.Pool,
  input: {
    constraint: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
  }
) {
  const rows = await queryRows<{
    columnName: string;
    referencedTable: string;
    referencedColumn: string;
  }>(
    pool,
    `SELECT column_name AS columnName,
            referenced_table_name AS referencedTable,
            referenced_column_name AS referencedColumn
     FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE()
       AND table_name = 'prospect_source_raw_hits'
       AND constraint_name = ?
     ORDER BY ordinal_position`,
    [input.constraint]
  );
  const matches = rows.length === input.columns.length
    && rows.every((row, position) =>
      row.columnName === input.columns[position]
      && row.referencedTable === input.referencedTable
      && row.referencedColumn === input.referencedColumns[position]
    );
  if (matches) return;
  if (rows.length) {
    await pool.query(
      `ALTER TABLE prospect_source_raw_hits
       DROP FOREIGN KEY \`${input.constraint}\``
    );
  }
  await pool.query(
    `ALTER TABLE prospect_source_raw_hits
     ADD CONSTRAINT \`${input.constraint}\`
     FOREIGN KEY (${input.columns.map((item) => `\`${item}\``).join(",")})
     REFERENCES \`${input.referencedTable}\` (
       ${input.referencedColumns.map((item) => `\`${item}\``).join(",")}
     )
     ON UPDATE RESTRICT ON DELETE RESTRICT`
  );
}

async function strengthenRawOwnerSchema(pool: mysql.Pool) {
  const mismatches = await queryRows<{ count: number | string }>(
    pool,
    `SELECT COUNT(*) AS count
     FROM prospect_source_raw_hits hit
     INNER JOIN prospect_source_raw_batches batch
       ON batch.team_id = hit.team_id AND batch.id = hit.batch_id
     INNER JOIN prospect_source_raw_records record
       ON record.team_id = hit.team_id AND record.id = hit.record_id
     WHERE hit.owner_id <> batch.owner_id
        OR hit.owner_id <> record.owner_id`
  );
  if (Number(mismatches[0]?.count || 0) > 0) {
    integrityError("Provider Raw Hit 已存在跨 Owner 引用，拒绝升级");
  }
  await ensureUniqueIndex(
    pool,
    "prospect_source_raw_batches",
    "uk_ps_raw_batch_team_owner_id",
    ["team_id", "owner_id", "id"]
  );
  await ensureUniqueIndex(
    pool,
    "prospect_source_raw_hits",
    "uk_ps_raw_hit_team_owner_id",
    ["team_id", "owner_id", "id"]
  );
  await ensureOwnerForeignKey(pool, {
    constraint: "fk_ps_raw_hit_batch",
    columns: ["team_id", "owner_id", "batch_id"],
    referencedTable: "prospect_source_raw_batches",
    referencedColumns: ["team_id", "owner_id", "id"]
  });
  await ensureOwnerForeignKey(pool, {
    constraint: "fk_ps_raw_hit_record",
    columns: ["team_id", "owner_id", "record_id"],
    referencedTable: "prospect_source_raw_records",
    referencedColumns: ["team_id", "owner_id", "id"]
  });
}

export async function ensureProspectCoverageSchema(pool: mysql.Pool) {
  const connection = await pool.getConnection();
  let acquired = false;
  try {
    const lock = await queryRows<{ acquired: number | string }>(
      connection,
      "SELECT GET_LOCK(?, 30) AS acquired",
      [SCHEMA_LOCK]
    );
    acquired = Number(lock[0]?.acquired || 0) === 1;
    if (!acquired) configurationError("无法获取覆盖记忆 Schema 锁");
    await strengthenRawOwnerSchema(pool);
    for (const sql of SCHEMA_SQL) await connection.query(sql);
    const engines = await queryRows<{
      tableName: string;
      engineName: string;
    }>(
      connection,
      `SELECT table_name AS tableName, engine AS engineName
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN (
           'prospect_coverage_contract_metadata',
           'prospect_coverage_team_guards',
           'tenant_prospects',
           'prospect_coverage_events'
         )`
    );
    if (engines.length !== 4
      || engines.some((row) =>
        String(row.engineName || "").toLowerCase() !== "innodb"
      )) {
      configurationError(
        "覆盖记忆 Schema 必须完整使用 InnoDB，当前为 "
          + canonical(engines)
      );
    }
  } finally {
    if (acquired) {
      await connection.query("SELECT RELEASE_LOCK(?)", [SCHEMA_LOCK]);
    }
    connection.release();
  }
}

function parseHashList(value: unknown, label: string) {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    integrityError(`${label} 不是有效 JSON`);
  }
  if (!Array.isArray(parsed)
    || parsed.some((item) =>
      typeof item !== "string" || !HASH_PATTERN.test(item)
    )) {
    integrityError(`${label} 包含无效摘要`);
  }
  const normalized = [...new Set(parsed)].sort();
  if (normalized.length !== parsed.length
    || normalized.some((item, index) => item !== parsed[index])) {
    integrityError(`${label} 必须排序且不可重复`);
  }
  return normalized;
}

function tenantProspectFromRow(
  row: Record<string, unknown>,
  secrets: CoverageSecrets
) {
  const prospect: TenantProspect = {
    id: String(row.id),
    teamId: String(row.team_id),
    organizationId: String(row.organization_id),
    status: String(row.lifecycle_status) as TenantProspect["status"],
    latestClassification: String(
      row.last_classification
    ) as TenantProspect["latestClassification"],
    queueState: String(row.queue_state) as TenantProspect["queueState"],
    queueReasonCode: String(row.queue_reason_code || ""),
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    lastMaterialChangeAt: iso(row.last_material_change_at),
    lastQueuedAt: optionalIso(row.last_queued_at),
    lastReviewedAt: optionalIso(row.last_reviewed_at),
    nextReviewAt: optionalIso(row.next_review_at),
    hitCount: Number(row.hit_count),
    sourceCount: Number(row.source_count),
    evidenceCount: Number(row.evidence_count),
    sourceKeyHashes: parseHashList(
      row.source_key_hashes_json,
      "来源摘要集合"
    ),
    materialEvidenceKeyHashes: parseHashList(
      row.material_evidence_key_hashes_json,
      "实质证据摘要集合"
    ),
    exclusionScope: String(
      row.exclusion_scope
    ) as TenantProspect["exclusionScope"],
    exclusionMode: String(
      row.exclusion_mode
    ) as TenantProspect["exclusionMode"],
    exclusionReasonCode: String(row.exclusion_reason_code || ""),
    excludedUntil: optionalIso(row.excluded_until),
    leadId: String(row.lead_id || ""),
    customerId: String(row.customer_id || ""),
    dealId: String(row.deal_id || ""),
    version: Number(row.version_no),
    eventCount: Number(row.event_count),
    eventTailHash: String(row.event_tail_hash),
    prospectHash: String(row.prospect_hash),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
  if (String(row.row_mac || "")
    !== rowMac("tenant_prospects", prospect, secrets)) {
    integrityError("团队候选 Row MAC 校验失败");
  }
  if (prospect.prospectHash
    !== tenantProspectFactHash(prospect, secrets.stateSecret)) {
    integrityError("团队候选事实摘要校验失败");
  }
  return prospect;
}

function coverageEventFromRow(
  row: Record<string, unknown>,
  secrets: CoverageSecrets
) {
  const event: ProspectCoverageEvent = {
    id: String(row.id),
    prospectId: String(row.prospect_id),
    teamId: String(row.team_id),
    ownerId: String(row.owner_id),
    organizationId: String(row.organization_id),
    resolutionId: String(row.resolution_id || ""),
    rawRecordId: String(row.raw_record_id || ""),
    sourceHitId: String(row.source_hit_id || ""),
    campaignId: String(row.campaign_id || ""),
    strategyId: String(row.strategy_id || ""),
    runId: String(row.run_id || ""),
    shardId: String(row.shard_id || ""),
    sequence: Number(row.sequence_no),
    eventType: String(row.event_type) as ProspectCoverageEvent["eventType"],
    dispositionAction: String(
      row.disposition_action || ""
    ) as ProspectCoverageEvent["dispositionAction"],
    classification: String(
      row.classification || ""
    ) as ProspectCoverageEvent["classification"],
    queueAction: String(
      row.queue_action
    ) as ProspectCoverageEvent["queueAction"],
    reasonCode: String(row.reason_code),
    processingKeyHash: String(row.processing_key_hash),
    requestHash: String(row.request_hash),
    newEvidenceKeyHashes: parseHashList(
      row.new_evidence_key_hashes_json,
      "事件新增证据摘要"
    ),
    newSourceKeyHashes: parseHashList(
      row.new_source_key_hashes_json,
      "事件新增来源摘要"
    ),
    evidenceSnapshotHash: String(row.evidence_snapshot_hash),
    sourceSnapshotHash: String(row.source_snapshot_hash),
    previousEventHash: String(row.previous_event_hash || ""),
    eventHash: String(row.event_hash),
    createdAt: iso(row.created_at)
  };
  if (String(row.row_mac || "")
    !== rowMac("prospect_coverage_events", event, secrets)) {
    integrityError("覆盖事件 Row MAC 校验失败");
  }
  if (event.eventHash
    !== prospectCoverageEventFactHash(event, secrets.stateSecret)) {
    integrityError("覆盖事件事实摘要校验失败");
  }
  return event;
}

function snapshotHash(
  type: "evidence" | "source",
  teamId: string,
  prospectId: string,
  keys: string[],
  secret: string
) {
  return hmac(secret, {
    version: type === "evidence"
      ? "coverage-evidence-snapshot-v1"
      : "coverage-source-snapshot-v1",
    teamId,
    prospectId,
    keys
  });
}

function validateState(
  state: ProspectCoverageState,
  secrets: CoverageSecrets
) {
  const prospectsByKey = new Map<string, TenantProspect>();
  for (const prospect of state.tenantProspects) {
    const key = `${prospect.teamId}\u0000${prospect.organizationId}`;
    if (prospectsByKey.has(key)) {
      integrityError("同一团队企业存在多个候选投影");
    }
    prospectsByKey.set(key, prospect);
  }
  const eventsByProspect = new Map<string, ProspectCoverageEvent[]>();
  for (const event of state.prospectCoverageEvents) {
    const key = `${event.teamId}\u0000${event.prospectId}`;
    const events = eventsByProspect.get(key) || [];
    events.push(event);
    eventsByProspect.set(key, events);
  }
  for (const prospect of state.tenantProspects) {
    const key = `${prospect.teamId}\u0000${prospect.id}`;
    const events = (eventsByProspect.get(key) || [])
      .sort((left, right) => left.sequence - right.sequence);
    const evidence = new Set<string>();
    const sources = new Set<string>();
    let previousHash = "";
    let coverageCount = 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.sequence !== index + 1
        || event.previousEventHash !== previousHash
        || event.organizationId !== prospect.organizationId) {
        integrityError("覆盖事件链序号、前序摘要或企业引用无效");
      }
      if (event.eventType === "coverage_classified") {
        coverageCount += 1;
        if (!event.resolutionId || !event.rawRecordId
          || !event.sourceHitId || !event.classification
          || event.dispositionAction) {
          integrityError("覆盖分类事件上下文不完整");
        }
      } else if (event.resolutionId || event.rawRecordId
        || event.sourceHitId || event.classification
        || !event.dispositionAction) {
        integrityError("候选处置事件混入了来源私有上下文");
      }
      for (const value of event.newEvidenceKeyHashes) evidence.add(value);
      for (const value of event.newSourceKeyHashes) sources.add(value);
      const evidenceKeys = [...evidence].sort();
      const sourceKeys = [...sources].sort();
      if (event.evidenceSnapshotHash !== snapshotHash(
        "evidence",
        prospect.teamId,
        prospect.id,
        evidenceKeys,
        secrets.stateSecret
      ) || event.sourceSnapshotHash !== snapshotHash(
        "source",
        prospect.teamId,
        prospect.id,
        sourceKeys,
        secrets.stateSecret
      )) {
        integrityError("覆盖事件证据或来源快照摘要无效");
      }
      previousHash = event.eventHash;
    }
    if (events.length !== prospect.eventCount
      || prospect.eventCount !== prospect.version
      || prospect.eventTailHash !== previousHash
      || coverageCount !== prospect.hitCount
      || prospect.sourceCount !== sources.size
      || prospect.evidenceCount !== evidence.size
      || canonical(prospect.sourceKeyHashes) !== canonical([...sources].sort())
      || canonical(prospect.materialEvidenceKeyHashes)
        !== canonical([...evidence].sort())) {
      integrityError("覆盖投影与不可变事件链不一致");
    }
    eventsByProspect.delete(key);
  }
  if ([...eventsByProspect.values()].some((events) => events.length)) {
    integrityError("覆盖事件引用了不存在的团队候选");
  }
}

export async function loadProspectCoverageState(
  source: QuerySource,
  teamId?: string
): Promise<ProspectCoverageState> {
  const secrets = configuredSecrets(false);
  const initialized = await validateMetadata(source, secrets);
  if (!initialized) return structuredClone(EMPTY_STATE);
  if (!secrets) configurationError("覆盖记忆密钥未初始化");
  const where = teamId ? " WHERE team_id = ?" : "";
  const values = teamId ? [teamId] : [];
  const prospectRows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM tenant_prospects${where}
     ORDER BY team_id, organization_id, id`,
    values
  );
  const eventRows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM prospect_coverage_events${where}
     ORDER BY team_id, prospect_id, sequence_no`,
    values
  );
  const state = {
    tenantProspects: prospectRows.map((row) =>
      tenantProspectFromRow(row, secrets)
    ),
    prospectCoverageEvents: eventRows.map((row) =>
      coverageEventFromRow(row, secrets)
    )
  };
  validateState(state, secrets);
  return state;
}

function dbDate(value: string) {
  return value ? new Date(value) : null;
}

async function persistProspectAndEvent(
  connection: mysql.PoolConnection,
  prospect: TenantProspect,
  event: ProspectCoverageEvent,
  secrets: CoverageSecrets
) {
  await connection.query(
    `INSERT INTO tenant_prospects (
       id,team_id,organization_id,lifecycle_status,last_classification,
       queue_state,queue_reason_code,first_seen_at,last_seen_at,
       last_material_change_at,last_queued_at,last_reviewed_at,
       next_review_at,hit_count,source_count,evidence_count,
       source_key_hashes_json,material_evidence_key_hashes_json,
       exclusion_scope,exclusion_mode,exclusion_reason_code,
       excluded_until,lead_id,customer_id,deal_id,version_no,
       event_count,event_tail_hash,prospect_hash,created_at,updated_at,row_mac
     ) VALUES (
       ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
     )
     ON DUPLICATE KEY UPDATE
       lifecycle_status=VALUES(lifecycle_status),
       last_classification=VALUES(last_classification),
       queue_state=VALUES(queue_state),
       queue_reason_code=VALUES(queue_reason_code),
       first_seen_at=VALUES(first_seen_at),
       last_seen_at=VALUES(last_seen_at),
       last_material_change_at=VALUES(last_material_change_at),
       last_queued_at=VALUES(last_queued_at),
       last_reviewed_at=VALUES(last_reviewed_at),
       next_review_at=VALUES(next_review_at),
       hit_count=VALUES(hit_count),
       source_count=VALUES(source_count),
       evidence_count=VALUES(evidence_count),
       source_key_hashes_json=VALUES(source_key_hashes_json),
       material_evidence_key_hashes_json=
         VALUES(material_evidence_key_hashes_json),
       exclusion_scope=VALUES(exclusion_scope),
       exclusion_mode=VALUES(exclusion_mode),
       exclusion_reason_code=VALUES(exclusion_reason_code),
       excluded_until=VALUES(excluded_until),
       lead_id=VALUES(lead_id),
       customer_id=VALUES(customer_id),
       deal_id=VALUES(deal_id),
       version_no=VALUES(version_no),
       event_count=VALUES(event_count),
       event_tail_hash=VALUES(event_tail_hash),
       prospect_hash=VALUES(prospect_hash),
       updated_at=VALUES(updated_at),
       row_mac=VALUES(row_mac)`,
    [
      prospect.id,
      prospect.teamId,
      prospect.organizationId,
      prospect.status,
      prospect.latestClassification,
      prospect.queueState,
      prospect.queueReasonCode,
      new Date(prospect.firstSeenAt),
      new Date(prospect.lastSeenAt),
      new Date(prospect.lastMaterialChangeAt),
      dbDate(prospect.lastQueuedAt),
      dbDate(prospect.lastReviewedAt),
      dbDate(prospect.nextReviewAt),
      prospect.hitCount,
      prospect.sourceCount,
      prospect.evidenceCount,
      canonical(prospect.sourceKeyHashes),
      canonical(prospect.materialEvidenceKeyHashes),
      prospect.exclusionScope,
      prospect.exclusionMode,
      prospect.exclusionReasonCode,
      dbDate(prospect.excludedUntil),
      prospect.leadId,
      prospect.customerId,
      prospect.dealId,
      prospect.version,
      prospect.eventCount,
      prospect.eventTailHash,
      prospect.prospectHash,
      new Date(prospect.createdAt),
      new Date(prospect.updatedAt),
      rowMac("tenant_prospects", prospect, secrets)
    ]
  );
  await connection.query(
    `INSERT INTO prospect_coverage_events (
       id,prospect_id,team_id,owner_id,organization_id,resolution_id,
       raw_record_id,source_hit_id,campaign_id,strategy_id,run_id,shard_id,
       sequence_no,event_type,disposition_action,classification,
       queue_action,reason_code,processing_key_hash,request_hash,
       new_evidence_key_hashes_json,new_source_key_hashes_json,
       evidence_snapshot_hash,source_snapshot_hash,previous_event_hash,
       event_hash,created_at,row_mac
     ) VALUES (
       ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
     )`,
    [
      event.id,
      event.prospectId,
      event.teamId,
      event.ownerId,
      event.organizationId,
      event.resolutionId || null,
      event.rawRecordId || null,
      event.sourceHitId || null,
      event.campaignId || null,
      event.strategyId || null,
      event.runId || null,
      event.shardId || null,
      event.sequence,
      event.eventType,
      event.dispositionAction,
      event.classification,
      event.queueAction,
      event.reasonCode,
      event.processingKeyHash,
      event.requestHash,
      canonical(event.newEvidenceKeyHashes),
      canonical(event.newSourceKeyHashes),
      event.evidenceSnapshotHash,
      event.sourceSnapshotHash,
      event.previousEventHash,
      event.eventHash,
      new Date(event.createdAt),
      rowMac("prospect_coverage_events", event, secrets)
    ]
  );
}

function replaceTeamState(
  store: CrmStore,
  teamId: string,
  state: ProspectCoverageState,
  version: number
) {
  const versions = coverageCacheVersions.get(store)
    || new Map<string, number>();
  const current = versions.get(teamId) || 0;
  if (version < current) return false;
  store.tenantProspects.splice(
    0,
    store.tenantProspects.length,
    ...store.tenantProspects.filter((item) => item.teamId !== teamId),
    ...structuredClone(state.tenantProspects)
  );
  store.prospectCoverageEvents.splice(
    0,
    store.prospectCoverageEvents.length,
    ...store.prospectCoverageEvents.filter((item) => item.teamId !== teamId),
    ...structuredClone(state.prospectCoverageEvents)
  );
  versions.set(teamId, version);
  coverageCacheVersions.set(store, versions);
  return true;
}

async function refreshTeamCache(
  pool: mysql.Pool,
  store: CrmStore,
  teamId: string
) {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  let destroyed = false;
  try {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
    await connection.beginTransaction();
    transactionStarted = true;
    const guards = await queryRows<{ guard_version: number | string }>(
      connection,
      `SELECT guard_version
       FROM prospect_coverage_team_guards
       WHERE team_id = ? FOR UPDATE`,
      [teamId]
    );
    if (guards.length !== 1) {
      integrityError("刷新覆盖记忆缓存时缺少团队 Guard");
    }
    const version = Number(guards[0]!.guard_version);
    const state = await loadProspectCoverageState(connection, teamId);
    await connection.commit();
    transactionStarted = false;
    replaceTeamState(store, teamId, state, version);
  } catch {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch {
        destroyed = true;
        connection.destroy();
      }
    }
    throw new ProspectCoverageMemoryError(
      "PROSPECT_COVERAGE_CACHE_UNAVAILABLE",
      "覆盖记忆已保存，但当前实例暂时无法刷新团队缓存，请重试"
    );
  } finally {
    if (!destroyed) connection.release();
  }
}

export async function ensureProspectCoverageTeamCache(
  pool: mysql.Pool,
  store: CrmStore,
  teamId: string
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await refreshTeamCache(pool, store, teamId);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function rawRecordFromRow(
  row: Record<string, unknown>
): ProspectSourceRawRecord {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    ownerId: String(row.owner_id),
    providerCode: String(row.provider_code),
    connectionId: String(row.connection_id),
    endpointCode: String(row.endpoint_code),
    sourceIdentityHash: String(row.source_identity_hash),
    artifactHash: String(row.artifact_hash),
    envelopeVersion: String(
      row.envelope_version
    ) as ProspectSourceRawRecord["envelopeVersion"],
    encryptedEnvelope: String(row.encrypted_envelope),
    envelopeHash: String(row.envelope_hash),
    firstObservedAt: iso(row.first_observed_at),
    recordHash: String(row.record_hash),
    createdAt: iso(row.created_at)
  };
}

function rawHitFromRow(
  row: Record<string, unknown>
): ProspectSourceRawHit {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    recordId: String(row.record_id),
    teamId: String(row.team_id),
    ownerId: String(row.owner_id),
    runId: String(row.run_id),
    shardId: String(row.shard_id),
    jobId: String(row.job_id),
    attemptId: String(row.attempt_id),
    ledgerId: String(row.ledger_id),
    pageId: String(row.page_id),
    ordinal: Number(row.ordinal),
    fetchedAt: iso(row.fetched_at),
    hitHash: String(row.hit_hash),
    createdAt: iso(row.created_at)
  };
}

async function lockCoverageContext(
  connection: mysql.PoolConnection,
  input: RecordProspectCoveragePersistedInput
) {
  const hits = await queryRows<Record<string, unknown>>(
    connection,
    `SELECT * FROM prospect_source_raw_hits
     WHERE team_id = ? AND owner_id = ? AND id = ? FOR UPDATE`,
    [input.teamId, input.ownerId, input.sourceHitId]
  );
  if (hits.length !== 1) {
    throw new ProspectCoverageMemoryError(
      "PROSPECT_COVERAGE_INVALID",
      "Provider 来源命中不存在或不属于当前业务员"
    );
  }
  const hit = rawHitFromRow(hits[0]!);
  const rawRows = await queryRows<Record<string, unknown>>(
    connection,
    `SELECT * FROM prospect_source_raw_records
     WHERE team_id = ? AND owner_id = ? AND id = ? FOR UPDATE`,
    [input.teamId, input.ownerId, hit.recordId]
  );
  const resolutionRows = await queryRows<{ id: string }>(
    connection,
    `SELECT id FROM organization_identity_resolutions
     WHERE team_id = ? AND owner_id = ? AND id = ? FOR UPDATE`,
    [input.teamId, input.ownerId, input.resolutionId]
  );
  const runRows = await queryRows<Record<string, unknown>>(
    connection,
    `SELECT id,team_id,owner_id,campaign_id,strategy_id
     FROM prospect_search_runs
     WHERE team_id = ? AND owner_id = ? AND id = ? FOR UPDATE`,
    [input.teamId, input.ownerId, hit.runId]
  );
  const shardRows = await queryRows<Record<string, unknown>>(
    connection,
    `SELECT id,team_id,run_id
     FROM prospect_run_shards
     WHERE team_id = ? AND run_id = ? AND id = ? FOR UPDATE`,
    [input.teamId, hit.runId, hit.shardId]
  );
  if (rawRows.length !== 1 || resolutionRows.length !== 1
    || runRows.length !== 1 || shardRows.length !== 1) {
    integrityError("覆盖记忆来源、身份或搜索运行上下文不完整");
  }
  return {
    rawRecord: rawRecordFromRow(rawRows[0]!),
    hit,
    run: {
      id: String(runRows[0]!.id),
      teamId: String(runRows[0]!.team_id),
      ownerId: String(runRows[0]!.owner_id),
      campaignId: String(runRows[0]!.campaign_id),
      strategyId: String(runRows[0]!.strategy_id)
    } as unknown as ProspectSearchRun,
    shard: {
      id: String(shardRows[0]!.id),
      teamId: String(shardRows[0]!.team_id),
      runId: String(shardRows[0]!.run_id)
    } as unknown as ProspectRunShard
  };
}

function transactionStore(
  store: CrmStore,
  coverageState: ProspectCoverageState,
  overrides: Partial<CrmStore> = {}
): CrmStore {
  return {
    ...store,
    ...overrides,
    mode: "memory",
    tenantProspects: structuredClone(coverageState.tenantProspects),
    prospectCoverageEvents:
      structuredClone(coverageState.prospectCoverageEvents),
    async persist() {
      // Dedicated transaction persists the generated event and projection.
    },
    async readBarrier() {
      // Transaction-local snapshot is already consistent.
    }
  };
}

async function lockTeamGuard(
  connection: mysql.PoolConnection,
  teamId: string,
  at: string
) {
  await connection.query(
    `INSERT INTO prospect_coverage_team_guards (
       team_id,guard_version,updated_at
     ) VALUES (?,1,?)
     ON DUPLICATE KEY UPDATE team_id = VALUES(team_id)`,
    [teamId, new Date(at)]
  );
  const rows = await queryRows<{ guard_version: number | string }>(
    connection,
    `SELECT guard_version FROM prospect_coverage_team_guards
     WHERE team_id = ? FOR UPDATE`,
    [teamId]
  );
  if (rows.length !== 1) integrityError("无法锁定团队覆盖记忆 Guard");
}

function mysqlErrorNumber(error: unknown) {
  if (!error || typeof error !== "object") return 0;
  const details = error as { errno?: number; code?: string };
  if (details.errno) return Number(details.errno);
  if (details.code === "ER_LOCK_DEADLOCK") return 1213;
  if (details.code === "ER_LOCK_WAIT_TIMEOUT") return 1205;
  return 0;
}

function normalizeRecordInput(
  input: RecordProspectCoveragePersistedInput
) {
  const normalized = structuredClone(input);
  normalized.coveredAt = iso(normalized.coveredAt);
  if (normalized.nextReviewAt) {
    normalized.nextReviewAt = iso(normalized.nextReviewAt);
  }
  normalized.evidence = normalized.evidence?.map((item) => ({
    ...item,
    observedAt: iso(item.observedAt),
    expiresAt: item.expiresAt ? iso(item.expiresAt) : undefined
  }));
  return normalized;
}

function normalizeDispositionInput(
  input: SetTenantProspectDispositionPersistedInput
) {
  const normalized = structuredClone(input);
  normalized.effectiveAt = iso(normalized.effectiveAt);
  if (normalized.excludedUntil) {
    normalized.excludedUntil = iso(normalized.excludedUntil);
  }
  if (normalized.nextReviewAt) {
    normalized.nextReviewAt = iso(normalized.nextReviewAt);
  }
  return normalized;
}

export async function recordProspectCoverageMysql(
  pool: mysql.Pool,
  store: CrmStore,
  rawInput: RecordProspectCoveragePersistedInput
): Promise<RecordProspectCoverageResult> {
  const input = normalizeRecordInput(rawInput);
  const secrets = configuredSecrets(true)!;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const connection = await pool.getConnection();
    let transactionStarted = false;
    let commitStarted = false;
    let destroyed = false;
    try {
      await connection.query(
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
      );
      await connection.beginTransaction();
      transactionStarted = true;
      await initializeMetadata(connection, secrets, input.coveredAt);
      await lockTeamGuard(connection, input.teamId, input.coveredAt);
      const context = await lockCoverageContext(connection, input);
      const coverageState = await loadProspectCoverageState(
        connection,
        input.teamId
      );
      const identityState = await loadOrganizationIdentityState(
        connection,
        undefined,
        input.teamId
      );
      const local = transactionStore(store, coverageState, {
        ...identityState,
        prospectSourceRawRecords: [context.rawRecord],
        prospectSourceRawHits: [context.hit],
        prospectSearchRuns: [context.run],
        prospectRunShards: [context.shard]
      });
      const result = recordProspectCoverage(local, {
        ...input,
        coverageSecret: secrets.stateSecret
      });
      if (!result.idempotent) {
        await persistProspectAndEvent(
          connection,
          result.prospect,
          result.event,
          secrets
        );
        await connection.query(
          `UPDATE prospect_coverage_team_guards
           SET guard_version = guard_version + 1, updated_at = ?
           WHERE team_id = ?`,
          [new Date(input.coveredAt), input.teamId]
        );
      }
      commitStarted = true;
      await connection.commit();
      transactionStarted = false;
      await ensureProspectCoverageTeamCache(pool, store, input.teamId);
      return result;
    } catch (error) {
      if (commitStarted) {
        destroyed = true;
        connection.destroy();
        if (attempt < 3) continue;
        throw new ProspectCoverageMemoryError(
          "PROSPECT_COVERAGE_COMMIT_OUTCOME_UNKNOWN",
          "覆盖记忆事务 COMMIT 结果无法确认"
        );
      }
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          destroyed = true;
          connection.destroy();
          integrityError("覆盖记忆事务回滚结果无法确认");
        }
      }
      if ([1205, 1213].includes(mysqlErrorNumber(error))) {
        if (attempt < 3) continue;
        throw new ProspectCoverageMemoryError(
          "PROSPECT_COVERAGE_CONCURRENCY_RETRY_EXHAUSTED",
          "覆盖记忆并发重试次数已耗尽"
        );
      }
      throw error;
    } finally {
      if (!destroyed) connection.release();
    }
  }
  integrityError("覆盖记忆事务未返回结果");
}

async function crmReferenceRows(
  connection: mysql.PoolConnection,
  input: SetTenantProspectDispositionPersistedInput
) {
  const load = async (
    table: "leads" | "customers" | "deals",
    id: string | undefined
  ) => {
    if (!id) return [];
    return await queryRows<{ id: string; team_id: string }>(
      connection,
      `SELECT id,team_id FROM \`${table}\`
       WHERE team_id = ? AND id = ? FOR UPDATE`,
      [input.teamId, id]
    );
  };
  const [leads, customers, deals] = await Promise.all([
    load("leads", input.leadId),
    load("customers", input.customerId),
    load("deals", input.dealId)
  ]);
  return {
    leads: leads.map((row) => ({
      id: row.id,
      teamId: row.team_id
    })) as CrmStore["leads"],
    customers: customers.map((row) => ({
      id: row.id,
      teamId: row.team_id
    })) as CrmStore["customers"],
    deals: deals.map((row) => ({
      id: row.id,
      teamId: row.team_id
    })) as CrmStore["deals"]
  };
}

function conversionLeadFromRow(row: Record<string, unknown>): Lead {
  return {
    id: String(row.id),
    company: String(row.company),
    contact: String(row.contact || ""),
    country: String(row.country || ""),
    email: String(row.email || ""),
    phone: String(row.phone || ""),
    wechat: String(row.wechat || ""),
    source: String(row.source || ""),
    intent: String(row.intent || "中"),
    stage: String(row.stage || "新线索"),
    status: String(row.status || "new") as Lead["status"],
    ownerId: String(row.owner_id),
    teamId: String(row.team_id),
    estimatedAmount: Number(row.estimated_amount || 0),
    nextFollowAt: String(row.next_follow_at || ""),
    lastActivityAt: String(row.last_activity_at || ""),
    remark: String(row.remark || ""),
    convertedCustomerId: String(row.converted_customer_id || ""),
    convertedDealId: String(row.converted_deal_id || ""),
    sourceType: String(row.source_type || "outbound") as Lead["sourceType"],
    sourceChannel: String(row.source_channel || "manual"),
    sourceCampaign: String(row.source_campaign || ""),
    externalId: String(row.external_id || ""),
    sourceUrl: String(row.source_url || ""),
    createdAt: iso(row.created_at),
    deletedAt: optionalIso(row.deleted_at),
    deletedReason: String(row.deleted_reason || ""),
    deletedBy: String(row.deleted_by || ""),
    purgeAt: optionalIso(row.purge_at),
    statusBeforeDelete: row.status_before_delete
      ? String(row.status_before_delete) as Lead["status"]
      : undefined
  };
}

function conversionSourceEventFromRow(
  row: Record<string, unknown>
): LeadSourceEvent {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    sourceType: String(
      row.source_type || "outbound"
    ) as LeadSourceEvent["sourceType"],
    channel: String(row.channel || ""),
    campaign: String(row.campaign || ""),
    externalId: String(row.external_id || ""),
    sourceUrl: String(row.source_url || ""),
    occurredAt: iso(row.occurred_at),
    receivedAt: iso(row.received_at),
    rawPayload: typeof row.raw_payload === "string"
      ? row.raw_payload
      : JSON.stringify(row.raw_payload || {}),
    ownerId: String(row.owner_id),
    teamId: String(row.team_id)
  };
}

function conversionActivityFromRow(
  row: Record<string, unknown>
): LeadActivity {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    type: String(row.type || "system") as LeadActivity["type"],
    content: String(row.content || ""),
    operatorId: String(row.operator_id || ""),
    nextFollowAt: String(row.next_follow_at || ""),
    createdAt: iso(row.created_at)
  };
}

async function lockProspectQualificationGuard(
  connection: mysql.PoolConnection,
  teamId: string,
  at: string
) {
  await connection.query(
    `INSERT INTO prospect_qualification_team_guards (
       team_id,guard_version,updated_at
     ) VALUES (?,1,?)
     ON DUPLICATE KEY UPDATE team_id = VALUES(team_id)`,
    [teamId, new Date(at)]
  );
  const rows = await queryRows<{ guard_version: number | string }>(
    connection,
    `SELECT guard_version FROM prospect_qualification_team_guards
     WHERE team_id = ? FOR UPDATE`,
    [teamId]
  );
  if (rows.length !== 1) {
    throw new ProspectLeadConversionError(
      "PROSPECT_LEAD_CONVERSION_DATA_INTEGRITY",
      "无法锁定候选资格团队 Guard",
      500
    );
  }
}

async function lockProspectLeadConversionRows(
  connection: mysql.PoolConnection,
  input: ConvertProspectToLeadPersistedInput,
  ids: ReturnType<typeof prospectLeadConversionIds>
) {
  const sourceRows = await queryRows<Record<string, unknown>>(
    connection,
    `SELECT * FROM lead_source_events
     WHERE id = ?
        OR (
          team_id = ? AND owner_id = ? AND channel = ? AND external_id = ?
        )
     FOR UPDATE`,
    [
      ids.sourceEventId,
      input.teamId,
      input.ownerId,
      PROSPECT_LEAD_SOURCE_CHANNEL,
      input.prospectId
    ]
  );
  const sourceEvents = sourceRows.map(conversionSourceEventFromRow);
  const leadIds = [...new Set([
    ids.leadId,
    input.existingLeadId,
    ...sourceEvents.map((item) => item.leadId)
  ].filter(Boolean))];
  const leadRows = leadIds.length
    ? await queryRows<Record<string, unknown>>(
        connection,
        `SELECT * FROM leads
         WHERE id IN (${leadIds.map(() => "?").join(",")})
         FOR UPDATE`,
        leadIds
      )
    : [];
  const activityRows = await queryRows<Record<string, unknown>>(
    connection,
    "SELECT * FROM lead_activities WHERE id = ? FOR UPDATE",
    [ids.activityId]
  );
  return {
    leads: leadRows.map(conversionLeadFromRow),
    leadSourceEvents: sourceEvents,
    leadActivities: activityRows.map(conversionActivityFromRow)
  };
}

async function insertConvertedLead(
  connection: mysql.PoolConnection,
  lead: Lead
) {
  await connection.query(
    `INSERT INTO leads (
       id,company,contact,country,email,phone,wechat,source,source_type,
       source_channel,source_campaign,external_id,source_url,intent,stage,
       status,owner_id,team_id,estimated_amount,next_follow_at,
       last_activity_at,remark,converted_customer_id,converted_deal_id,
       deleted_at,deleted_reason,deleted_by,purge_at,status_before_delete,
       created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      lead.id,
      lead.company,
      lead.contact,
      lead.country,
      lead.email,
      lead.phone,
      lead.wechat,
      lead.source,
      lead.sourceType,
      lead.sourceChannel,
      lead.sourceCampaign,
      lead.externalId,
      lead.sourceUrl,
      lead.intent,
      lead.stage,
      lead.status,
      lead.ownerId,
      lead.teamId,
      lead.estimatedAmount,
      lead.nextFollowAt,
      lead.lastActivityAt,
      lead.remark,
      lead.convertedCustomerId,
      lead.convertedDealId,
      lead.deletedAt ? new Date(lead.deletedAt) : null,
      lead.deletedReason || "",
      lead.deletedBy || "",
      lead.purgeAt ? new Date(lead.purgeAt) : null,
      lead.statusBeforeDelete || "",
      new Date(lead.createdAt)
    ]
  );
}

async function insertLeadConversionAudit(
  connection: mysql.PoolConnection,
  sourceEvent: LeadSourceEvent,
  activity: LeadActivity
) {
  await connection.query(
    `INSERT INTO lead_source_events (
       id,lead_id,source_type,channel,campaign,external_id,source_url,
       occurred_at,received_at,raw_payload,owner_id,team_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      sourceEvent.id,
      sourceEvent.leadId,
      sourceEvent.sourceType,
      sourceEvent.channel,
      sourceEvent.campaign,
      sourceEvent.externalId,
      sourceEvent.sourceUrl,
      new Date(sourceEvent.occurredAt),
      new Date(sourceEvent.receivedAt),
      sourceEvent.rawPayload,
      sourceEvent.ownerId,
      sourceEvent.teamId
    ]
  );
  await connection.query(
    `INSERT INTO lead_activities (
       id,lead_id,type,content,operator_id,next_follow_at,created_at
     ) VALUES (?,?,?,?,?,?,?)`,
    [
      activity.id,
      activity.leadId,
      activity.type,
      activity.content,
      activity.operatorId,
      activity.nextFollowAt,
      new Date(activity.createdAt)
    ]
  );
}

function conversionCustomerFromRow(
  row: Record<string, unknown>
): Customer {
  return {
    id: String(row.id),
    company: String(row.company || ""),
    country: String(row.country || ""),
    contact: String(row.contact || ""),
    ownerId: String(row.owner_id),
    teamId: String(row.team_id),
    stage: String(row.stage || ""),
    amount: Number(row.amount || 0),
    health: Number(row.health || 0),
    nextReminder: String(row.next_reminder || ""),
    wecomBound: Boolean(row.wecom_bound),
    billingName: String(row.billing_name || ""),
    billingAddress: String(row.billing_address || ""),
    documentContact: String(row.document_contact || ""),
    defaultPortDischarge: String(row.default_port_discharge || ""),
    defaultIncoterm: String(row.default_incoterm || ""),
    defaultPaymentTerm: String(row.default_payment_term || "")
  };
}

function conversionCustomerActivityFromRow(
  row: Record<string, unknown>
): CustomerActivity {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    type: String(row.type || "note") as CustomerActivity["type"],
    content: String(row.content || ""),
    operatorId: String(row.operator_id || ""),
    nextReminder: String(row.next_reminder || ""),
    createdAt: iso(row.created_at)
  };
}

function conversionCustomerSourceFromRow(
  row: Record<string, unknown>
): CustomerAcquisitionSourceEvent {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    ownerId: String(row.owner_id),
    customerId: String(row.customer_id),
    leadId: String(row.lead_id),
    leadSourceEventId: String(row.lead_source_event_id),
    prospectId: String(row.prospect_id),
    organizationId: String(row.organization_id),
    sourceChannel: String(row.source_channel || ""),
    sourceCampaign: String(row.source_campaign || ""),
    sourceUrl: String(row.source_url || ""),
    mode: String(
      row.conversion_mode
    ) as CustomerAcquisitionSourceEvent["mode"],
    processingKeyHash: String(row.processing_key_hash),
    requestHash: String(row.request_hash),
    createdAt: iso(row.created_at)
  };
}

async function lockProspectCustomerConversionRows(
  connection: mysql.PoolConnection,
  input: ConvertProspectToCustomerPersistedInput,
  ids: ReturnType<typeof prospectCustomerConversionIds>,
  organizationId: string
) {
  const sourceRows = await queryRows<Record<string, unknown>>(
    connection,
    `SELECT * FROM lead_source_events
     WHERE team_id = ? AND owner_id = ? AND lead_id = ?
       AND channel = ? AND external_id = ?
     FOR UPDATE`,
    [
      input.teamId,
      input.ownerId,
      input.leadId,
      PROSPECT_LEAD_SOURCE_CHANNEL,
      input.prospectId
    ]
  );
  const leadRows = await queryRows<Record<string, unknown>>(
    connection,
    "SELECT * FROM leads WHERE id = ? FOR UPDATE",
    [input.leadId]
  );
  const acquisitionRows = await queryRows<Record<string, unknown>>(
    connection,
    `SELECT * FROM customer_acquisition_source_events
     WHERE id = ?
        OR (
          team_id = ? AND owner_id = ? AND processing_key_hash = ?
        )
        OR (team_id = ? AND prospect_id = ?)
        OR (team_id = ? AND organization_id = ?)
        OR (team_id = ? AND owner_id = ? AND lead_id = ?)
     FOR UPDATE`,
    [
      ids.sourceEventId,
      input.teamId,
      input.ownerId,
      ids.processingKeyHash,
      input.teamId,
      input.prospectId,
      input.teamId,
      organizationId,
      input.teamId,
      input.ownerId,
      input.leadId
    ]
  );
  const acquisitionEvents = acquisitionRows.map(
    conversionCustomerSourceFromRow
  );
  const customerIds = [...new Set([
    ids.customerId,
    input.existingCustomerId,
    ...acquisitionEvents.map((item) => item.customerId)
  ].filter(Boolean))];
  const customerRows = customerIds.length
    ? await queryRows<Record<string, unknown>>(
        connection,
        `SELECT * FROM customers
         WHERE id IN (${customerIds.map(() => "?").join(",")})
         FOR UPDATE`,
        customerIds
      )
    : [];
  const customerActivityRows = await queryRows<Record<string, unknown>>(
    connection,
    "SELECT * FROM customer_activities WHERE id = ? FOR UPDATE",
    [ids.customerActivityId]
  );
  const leadActivityRows = await queryRows<Record<string, unknown>>(
    connection,
    "SELECT * FROM lead_activities WHERE id = ? FOR UPDATE",
    [ids.leadActivityId]
  );
  return {
    leads: leadRows.map(conversionLeadFromRow),
    leadSourceEvents: sourceRows.map(conversionSourceEventFromRow),
    customers: customerRows.map(conversionCustomerFromRow),
    customerActivities: customerActivityRows.map(
      conversionCustomerActivityFromRow
    ),
    customerAcquisitionSourceEvents: acquisitionEvents,
    leadActivities: leadActivityRows.map(conversionActivityFromRow)
  };
}

async function insertConvertedCustomer(
  connection: mysql.PoolConnection,
  customer: Customer
) {
  await connection.query(
    `INSERT INTO customers (
       id,company,country,contact,owner_id,team_id,stage,amount,health,
       next_reminder,wecom_bound,billing_name,billing_address,
       document_contact,default_port_discharge,default_incoterm,
       default_payment_term
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      customer.id,
      customer.company,
      customer.country,
      customer.contact,
      customer.ownerId,
      customer.teamId,
      customer.stage,
      customer.amount,
      customer.health,
      customer.nextReminder,
      customer.wecomBound,
      customer.billingName,
      customer.billingAddress,
      customer.documentContact,
      customer.defaultPortDischarge,
      customer.defaultIncoterm,
      customer.defaultPaymentTerm
    ]
  );
}

async function insertCustomerConversionAudit(
  connection: mysql.PoolConnection,
  sourceEvent: CustomerAcquisitionSourceEvent,
  customerActivity: CustomerActivity,
  leadActivity: LeadActivity
) {
  await connection.query(
    `INSERT INTO customer_acquisition_source_events (
       id,team_id,owner_id,customer_id,lead_id,lead_source_event_id,
       prospect_id,organization_id,source_channel,source_campaign,
       source_url,conversion_mode,processing_key_hash,request_hash,
       created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      sourceEvent.id,
      sourceEvent.teamId,
      sourceEvent.ownerId,
      sourceEvent.customerId,
      sourceEvent.leadId,
      sourceEvent.leadSourceEventId,
      sourceEvent.prospectId,
      sourceEvent.organizationId,
      sourceEvent.sourceChannel,
      sourceEvent.sourceCampaign,
      sourceEvent.sourceUrl,
      sourceEvent.mode,
      sourceEvent.processingKeyHash,
      sourceEvent.requestHash,
      new Date(sourceEvent.createdAt)
    ]
  );
  await connection.query(
    `INSERT INTO customer_activities (
       id,customer_id,type,content,operator_id,next_reminder,created_at
     ) VALUES (?,?,?,?,?,?,?)`,
    [
      customerActivity.id,
      customerActivity.customerId,
      customerActivity.type,
      customerActivity.content,
      customerActivity.operatorId,
      customerActivity.nextReminder,
      new Date(customerActivity.createdAt)
    ]
  );
  await connection.query(
    `INSERT INTO lead_activities (
       id,lead_id,type,content,operator_id,next_follow_at,created_at
     ) VALUES (?,?,?,?,?,?,?)`,
    [
      leadActivity.id,
      leadActivity.leadId,
      leadActivity.type,
      leadActivity.content,
      leadActivity.operatorId,
      leadActivity.nextFollowAt,
      new Date(leadActivity.createdAt)
    ]
  );
}

async function updateConvertedCustomerLead(
  connection: mysql.PoolConnection,
  lead: Lead,
  expectedOwnerId: string,
  expectedTeamId: string
) {
  const [result] = await connection.query(
    `UPDATE leads
     SET status = ?,stage = ?,converted_customer_id = ?,last_activity_at = ?
     WHERE id = ? AND team_id = ? AND owner_id = ?
       AND converted_customer_id = '' AND deleted_at IS NULL`,
    [
      lead.status,
      lead.stage,
      lead.convertedCustomerId,
      lead.lastActivityAt,
      lead.id,
      expectedTeamId,
      expectedOwnerId
    ]
  );
  if ((result as mysql.ResultSetHeader).affectedRows !== 1) {
    throw new ProspectCustomerConversionError(
      "PROSPECT_CUSTOMER_CONVERSION_CUSTOMER_BINDING_CONFLICT",
      "线索客户绑定已发生变化"
    );
  }
}

function upsertConversionCache<T extends { id: string }>(
  target: T[],
  value: T
) {
  const index = target.findIndex((item) => item.id === value.id);
  if (index >= 0) {
    target.splice(index, 1, structuredClone(value));
  } else {
    target.unshift(structuredClone(value));
  }
}

export async function convertProspectToLeadMysql(
  pool: mysql.Pool,
  store: CrmStore,
  rawInput: ConvertProspectToLeadPersistedInput
): Promise<ConvertProspectToLeadResult> {
  const conversionDate = new Date(rawInput.convertedAt);
  if (!Number.isFinite(conversionDate.getTime())) {
    throw new ProspectLeadConversionError(
      "PROSPECT_LEAD_CONVERSION_INVALID",
      "转换时间无效",
      400
    );
  }
  const input = {
    ...structuredClone(rawInput),
    convertedAt: conversionDate.toISOString()
  };
  const secrets = configuredSecrets(true)!;
  const securedInput = {
    ...input,
    coverageSecret: secrets.stateSecret
  };
  const ids = prospectLeadConversionIds(securedInput);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const connection = await pool.getConnection();
    let transactionStarted = false;
    let commitStarted = false;
    let destroyed = false;
    try {
      await connection.query(
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
      );
      await connection.beginTransaction();
      transactionStarted = true;
      await initializeMetadata(connection, secrets, input.convertedAt);
      await lockTeamGuard(connection, input.teamId, input.convertedAt);
      await lockProspectQualificationGuard(
        connection,
        input.teamId,
        input.convertedAt
      );
      const coverageState = await loadProspectCoverageState(
        connection,
        input.teamId
      );
      const qualificationState = await loadProspectQualificationState(
        connection,
        input.teamId
      );
      const identityState = await loadOrganizationIdentityState(
        connection,
        undefined,
        input.teamId
      );
      const crmState = await lockProspectLeadConversionRows(
        connection,
        input,
        ids
      );
      const local = transactionStore(store, coverageState, {
        ...identityState,
        ...qualificationState,
        ...crmState
      });
      const result = convertProspectToLead(local, securedInput);

      if (!result.replayed) {
        if (result.created) {
          await insertConvertedLead(connection, result.lead);
        }
        await insertLeadConversionAudit(
          connection,
          result.sourceEvent,
          result.activity
        );
        await persistProspectAndEvent(
          connection,
          result.prospect,
          result.coverageEvent,
          secrets
        );
        await connection.query(
          `UPDATE prospect_coverage_team_guards
           SET guard_version = guard_version + 1,updated_at = ?
           WHERE team_id = ?`,
          [new Date(input.convertedAt), input.teamId]
        );
      }

      commitStarted = true;
      await connection.commit();
      transactionStarted = false;
      upsertConversionCache(store.leads, result.lead);
      upsertConversionCache(store.leadSourceEvents, result.sourceEvent);
      upsertConversionCache(store.leadActivities, result.activity);
      await ensureProspectCoverageTeamCache(pool, store, input.teamId);
      return result;
    } catch (error) {
      if (commitStarted) {
        destroyed = true;
        connection.destroy();
        if (attempt < 3) continue;
        throw new ProspectLeadConversionError(
          "PROSPECT_LEAD_CONVERSION_COMMIT_OUTCOME_UNKNOWN",
          "候选转线索事务 COMMIT 结果无法确认",
          503
        );
      }
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          destroyed = true;
          connection.destroy();
          throw new ProspectLeadConversionError(
            "PROSPECT_LEAD_CONVERSION_DATA_INTEGRITY",
            "候选转线索事务回滚结果无法确认",
            500
          );
        }
      }
      if ([1205, 1213].includes(mysqlErrorNumber(error))) {
        if (attempt < 3) continue;
        throw new ProspectLeadConversionError(
          "PROSPECT_LEAD_CONVERSION_CONCURRENCY_RETRY_EXHAUSTED",
          "候选转线索并发重试次数已耗尽",
          503
        );
      }
      throw error;
    } finally {
      if (!destroyed) connection.release();
    }
  }
  throw new ProspectLeadConversionError(
    "PROSPECT_LEAD_CONVERSION_DATA_INTEGRITY",
    "候选转线索事务未返回结果",
    500
  );
}

export async function convertProspectToCustomerMysql(
  pool: mysql.Pool,
  store: CrmStore,
  rawInput: ConvertProspectToCustomerPersistedInput
): Promise<ConvertProspectToCustomerResult> {
  const conversionDate = new Date(rawInput.convertedAt);
  if (!Number.isFinite(conversionDate.getTime())) {
    throw new ProspectCustomerConversionError(
      "PROSPECT_CUSTOMER_CONVERSION_INVALID",
      "转换时间无效",
      400
    );
  }
  const input = {
    ...structuredClone(rawInput),
    convertedAt: conversionDate.toISOString()
  };
  const secrets = configuredSecrets(true)!;
  const securedInput = {
    ...input,
    coverageSecret: secrets.stateSecret
  };
  const ids = prospectCustomerConversionIds(securedInput);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const connection = await pool.getConnection();
    let transactionStarted = false;
    let commitStarted = false;
    let destroyed = false;
    try {
      await connection.query(
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
      );
      await connection.beginTransaction();
      transactionStarted = true;
      await initializeMetadata(connection, secrets, input.convertedAt);
      await lockTeamGuard(connection, input.teamId, input.convertedAt);
      const coverageState = await loadProspectCoverageState(
        connection,
        input.teamId
      );
      const prospect = coverageState.tenantProspects.find((item) =>
        item.id === input.prospectId
      );
      if (!prospect) {
        throw new ProspectCustomerConversionError(
          "PROSPECT_CUSTOMER_CONVERSION_NOT_FOUND",
          "候选客户不存在或无权访问",
          404
        );
      }
      const crmState = await lockProspectCustomerConversionRows(
        connection,
        input,
        ids,
        prospect.organizationId
      );
      const local = transactionStore(store, coverageState, crmState);
      const result = convertProspectToCustomer(local, securedInput);

      if (!result.replayed) {
        if (result.created) {
          await insertConvertedCustomer(connection, result.customer);
        }
        await insertCustomerConversionAudit(
          connection,
          result.sourceEvent,
          result.customerActivity,
          result.leadActivity
        );
        await updateConvertedCustomerLead(
          connection,
          result.lead,
          input.ownerId,
          input.teamId
        );
        await persistProspectAndEvent(
          connection,
          result.prospect,
          result.coverageEvent,
          secrets
        );
        await connection.query(
          `UPDATE prospect_coverage_team_guards
           SET guard_version = guard_version + 1,updated_at = ?
           WHERE team_id = ?`,
          [new Date(input.convertedAt), input.teamId]
        );
      }

      commitStarted = true;
      await connection.commit();
      transactionStarted = false;
      upsertConversionCache(store.customers, result.customer);
      upsertConversionCache(
        store.customerAcquisitionSourceEvents,
        result.sourceEvent
      );
      upsertConversionCache(
        store.customerActivities,
        result.customerActivity
      );
      upsertConversionCache(store.leads, result.lead);
      upsertConversionCache(store.leadActivities, result.leadActivity);
      await ensureProspectCoverageTeamCache(pool, store, input.teamId);
      return result;
    } catch (error) {
      if (commitStarted) {
        destroyed = true;
        connection.destroy();
        if (attempt < 3) continue;
        throw new ProspectCustomerConversionError(
          "PROSPECT_CUSTOMER_CONVERSION_COMMIT_OUTCOME_UNKNOWN",
          "候选转客户事务 COMMIT 结果无法确认",
          503
        );
      }
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          destroyed = true;
          connection.destroy();
          throw new ProspectCustomerConversionError(
            "PROSPECT_CUSTOMER_CONVERSION_DATA_INTEGRITY",
            "候选转客户事务回滚结果无法确认",
            500
          );
        }
      }
      if ([1205, 1213].includes(mysqlErrorNumber(error))) {
        if (attempt < 3) continue;
        throw new ProspectCustomerConversionError(
          "PROSPECT_CUSTOMER_CONVERSION_CONCURRENCY_RETRY_EXHAUSTED",
          "候选转客户并发重试次数已耗尽",
          503
        );
      }
      throw error;
    } finally {
      if (!destroyed) connection.release();
    }
  }
  throw new ProspectCustomerConversionError(
    "PROSPECT_CUSTOMER_CONVERSION_DATA_INTEGRITY",
    "候选转客户事务未返回结果",
    500
  );
}

export async function setTenantProspectDispositionMysql(
  pool: mysql.Pool,
  store: CrmStore,
  rawInput: SetTenantProspectDispositionPersistedInput
): Promise<SetTenantProspectDispositionResult> {
  const input = normalizeDispositionInput(rawInput);
  const secrets = configuredSecrets(true)!;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const connection = await pool.getConnection();
    let transactionStarted = false;
    let commitStarted = false;
    let destroyed = false;
    try {
      await connection.query(
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
      );
      await connection.beginTransaction();
      transactionStarted = true;
      await initializeMetadata(connection, secrets, input.effectiveAt);
      await lockTeamGuard(connection, input.teamId, input.effectiveAt);
      const coverageState = await loadProspectCoverageState(
        connection,
        input.teamId
      );
      const crm = await crmReferenceRows(connection, input);
      const local = transactionStore(store, coverageState, crm);
      const result = setTenantProspectDisposition(local, {
        ...input,
        coverageSecret: secrets.stateSecret
      });
      if (!result.idempotent) {
        await persistProspectAndEvent(
          connection,
          result.prospect,
          result.event,
          secrets
        );
        await connection.query(
          `UPDATE prospect_coverage_team_guards
           SET guard_version = guard_version + 1, updated_at = ?
           WHERE team_id = ?`,
          [new Date(input.effectiveAt), input.teamId]
        );
      }
      commitStarted = true;
      await connection.commit();
      transactionStarted = false;
      await ensureProspectCoverageTeamCache(pool, store, input.teamId);
      return result;
    } catch (error) {
      if (commitStarted) {
        destroyed = true;
        connection.destroy();
        if (attempt < 3) continue;
        throw new ProspectCoverageMemoryError(
          "PROSPECT_COVERAGE_COMMIT_OUTCOME_UNKNOWN",
          "候选处置事务 COMMIT 结果无法确认"
        );
      }
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          destroyed = true;
          connection.destroy();
          integrityError("候选处置事务回滚结果无法确认");
        }
      }
      if ([1205, 1213].includes(mysqlErrorNumber(error))) {
        if (attempt < 3) continue;
        throw new ProspectCoverageMemoryError(
          "PROSPECT_COVERAGE_CONCURRENCY_RETRY_EXHAUSTED",
          "候选处置并发重试次数已耗尽"
        );
      }
      throw error;
    } finally {
      if (!destroyed) connection.release();
    }
  }
  integrityError("候选处置事务未返回结果");
}
