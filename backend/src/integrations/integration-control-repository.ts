import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { DataScope } from "../authorization.js";
import type { SessionUser } from "../types.js";
import { integrationNotFound } from "./integration-errors.js";
import { MysqlIntegrationRepository } from "./integration-repository.js";
import type {
  AuthTransactionStatus,
  ConnectionStatus,
  ConnectorDefinition,
  IntegrationApproval,
  IntegrationAuthTransaction,
  IntegrationConnectorReview,
  IntegrationEvent,
  IntegrationToolCall,
  ToolGrant,
  ToolSnapshot
} from "./integration-types.js";

export interface ToolReviewInput {
  status: "active" | "rejected";
  stableAlias: string;
  riskLevel: number;
  permissionCode: string;
  review: Record<string, unknown>;
  reviewerId: string;
}

export interface GrantInput {
  subjectType: ToolGrant["subjectType"];
  subjectId: string;
  permissionCode: string;
  constraints: Record<string, unknown>;
}

export interface CreateReadCallInput {
  id: string;
  requestId: string;
  teamId: string;
  ownerId: string;
  actorId: string;
  actorAuthVersion: number;
  connectionId: string;
  toolSnapshotId: string;
  riskLevel: number;
  inputHash: string;
  inputSummary: Record<string, unknown>;
  dailyCallLimit: number;
  inputBytes: number;
  idempotencyKeyHash: string;
  artifact: {
    id: string;
    encryptedValue: string;
    contentHash: string;
    keyVersion: string;
    expiresAt: string;
  };
  createdAt: string;
  businessLink?: {
    id: string;
    objectType: "customer";
    objectId: string;
    operation: "mail_send" | "calendar_create" | "calendar_update";
    externalThreadId: string;
    nextActionAt: string;
    metadata: Record<string, unknown>;
  };
}

export interface CreateApprovalCallInput extends CreateReadCallInput {
  approval: {
    id: string;
    singleUseNonceHash: string;
    expiresAt: string;
  };
}

export interface ReconcileCallInput {
  callId: string;
  actorId: string;
  outcome: "succeeded" | "failed";
  note: string;
  externalReceipt: string;
  outputHash: string;
  evidence: Record<string, unknown>;
  artifact?: {
    id: string;
    encryptedValue: string;
    contentHash: string;
    keyVersion: string;
    expiresAt: string;
  };
}

export interface IntegrationBusinessLink {
  id: string;
  callId: string;
  teamId: string;
  ownerId: string;
  objectType: "customer";
  objectId: string;
  operation: "mail_send" | "calendar_create" | "calendar_update";
  externalObjectId: string;
  externalThreadId: string;
  writebackStatus: "pending" | "completed" | "failed";
  nextActionAt: string;
  metadata: Record<string, unknown>;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEndpointContext {
  connectionId: string;
  connectorCode: string;
  teamId: string;
  ownerId: string;
  webhookPublicId: string;
  status: ConnectionStatus;
}

export interface CreateWebhookEventInput {
  id: string;
  connectionId: string;
  teamId: string;
  ownerId: string;
  externalEventId: string;
  eventType: string;
  payloadHash: string;
  artifact: {
    id: string;
    encryptedValue: string;
    contentHash: string;
    expiresAt: string;
  };
  receivedAt: string;
}

export interface PendingWebhookWriteback {
  eventId: string;
  connectionId: string;
  teamId: string;
  ownerId: string;
  eventType: string;
  externalEventId: string;
  resultArtifactId: string;
  linkedObjectId: string;
  encryptedValue: string;
  contentHash: string;
}

interface ConnectorRow extends RowDataPacket {
  id: string; code: string; version: string; connector_type: ConnectorDefinition["type"];
  trust_level: ConnectorDefinition["trust"]; connector_status: ConnectorDefinition["status"];
  team_id: string; name: string; description: string; manifest_json: unknown;
  manifest_hash: string; created_by: string; created_at: Date; updated_at: Date;
}

interface ConnectorReviewRow extends RowDataPacket {
  id: string; connector_id: string; team_id: string;
  review_status: IntegrationConnectorReview["status"]; manifest_hash: string;
  submitted_by: string; reviewed_by: string; review_note: string;
  created_at: Date; updated_at: Date;
}

interface ToolRow extends RowDataPacket {
  id: string; connection_id: string; team_id: string; remote_name: string; stable_alias: string;
  display_name: string; description: string; input_schema_json: unknown; output_schema_json: unknown;
  schema_hash: string; risk_level: number; tool_status: ToolSnapshot["status"]; revision_no: number;
  discovered_at: Date; reviewed_at: Date | null; reviewed_by: string; permission_code: string;
  review_json: unknown; created_at: Date; updated_at: Date;
}

interface GrantRow extends RowDataPacket {
  id: string; tool_snapshot_id: string; connection_id: string; team_id: string;
  subject_type: ToolGrant["subjectType"]; subject_id: string; permission_code: string;
  grant_status: ToolGrant["status"]; constraints_json: unknown; granted_by: string;
  expires_at: Date | null; revoked_at: Date | null; created_at: Date; updated_at: Date;
}

interface CallRow extends RowDataPacket {
  id: string; request_id: string; team_id: string; owner_id: string; actor_id: string;
  actor_auth_version: number;
  connection_id: string; tool_snapshot_id: string; approval_id: string;
  call_status: IntegrationToolCall["status"]; risk_level: number; input_hash: string;
  input_artifact_id: string; input_summary_json: unknown; output_hash: string;
  result_artifact_id: string; output_summary_json: unknown; idempotency_key_hash: string;
  external_receipt: string; evidence_json: unknown; error_code: string; error_message: string;
  attempt_count: number; created_at: Date; queued_at: Date | null; started_at: Date | null;
  finished_at: Date | null; updated_at: Date;
}

interface AuthTransactionRow extends RowDataPacket {
  id: string; connection_id: string; team_id: string; owner_id: string;
  transaction_status: AuthTransactionStatus; state_hash: string; nonce_hash: string;
  encrypted_pkce_verifier: string | null; redirect_uri: string; issuer: string;
  resource_uri: string; expires_at: Date; consumed_at: Date | null;
  created_at: Date; updated_at: Date;
}

interface ApprovalRow extends RowDataPacket {
  id: string; team_id: string; owner_id: string; connection_id: string;
  tool_snapshot_id: string; call_id: string; approval_status: IntegrationApproval["status"];
  risk_level: number; frozen_input_hash: string; single_use_nonce_hash: string;
  requested_by: string; decided_by: string; decision_note: string; expires_at: Date;
  decided_at: Date | null; consumed_at: Date | null; created_at: Date; updated_at: Date;
}

interface ApprovalDetailRow extends ApprovalRow {
  detail_request_id: string;
  detail_actor_auth_version: number;
  detail_call_status: IntegrationToolCall["status"];
  detail_input_summary_json: unknown;
  detail_encrypted_input: string;
  detail_tool_remote_name: string;
  detail_tool_display_name: string;
  detail_tool_stable_alias: string;
  detail_tool_schema_hash: string;
  detail_tool_review_json: unknown;
  detail_connection_display_name: string;
}

interface IntegrationEventRow extends RowDataPacket {
  id: string;
  connection_id: string;
  team_id: string;
  external_event_id: string;
  event_type: string;
  event_status: IntegrationEvent["status"];
  payload_hash: string;
  artifact_id: string;
  result_artifact_id: string;
  attempt_count: number;
  result_json: unknown;
  writeback_status: IntegrationEvent["writebackStatus"];
  linked_object_id: string;
  last_error_code: string;
  last_error_message: string;
  next_attempt_at: Date | null;
  received_at: Date;
  processed_at: Date | null;
  business_written_at: Date | null;
  updated_at: Date;
}

export interface ApprovalDetail {
  approval: IntegrationApproval;
  requestId: string;
  actorAuthVersion: number;
  callStatus: IntegrationToolCall["status"];
  inputSummaryJson: string;
  encryptedInput: string;
  toolRemoteName: string;
  toolDisplayName: string;
  toolStableAlias: string;
  toolSchemaHash: string;
  toolReviewJson: string;
  connectionDisplayName: string;
}

const iso = (value: Date | null) => value ? value.toISOString() : "";
const json = (value: unknown) => JSON.stringify(value || {});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function mapConnector(row: ConnectorRow): ConnectorDefinition {
  return {
    id: row.id, code: row.code, version: row.version, type: row.connector_type,
    trust: row.trust_level, status: row.connector_status, teamId: row.team_id,
    name: row.name, description: row.description, manifestJson: json(row.manifest_json),
    manifestHash: row.manifest_hash, createdBy: row.created_by,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function mapConnectorReview(row: ConnectorReviewRow): IntegrationConnectorReview {
  return {
    id: row.id,
    connectorId: row.connector_id,
    teamId: row.team_id,
    status: row.review_status,
    manifestHash: row.manifest_hash,
    submittedBy: row.submitted_by,
    reviewedBy: row.reviewed_by,
    reviewNote: row.review_note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapTool(row: ToolRow): ToolSnapshot {
  return {
    id: row.id, connectionId: row.connection_id, teamId: row.team_id,
    remoteName: row.remote_name, stableAlias: row.stable_alias,
    displayName: row.display_name, description: row.description,
    inputSchemaJson: json(row.input_schema_json), outputSchemaJson: row.output_schema_json ? json(row.output_schema_json) : "",
    schemaHash: row.schema_hash, riskLevel: Number(row.risk_level), status: row.tool_status,
    revision: Number(row.revision_no), discoveredAt: iso(row.discovered_at), reviewedAt: iso(row.reviewed_at),
    reviewedBy: row.reviewed_by, permissionCode: row.permission_code,
    reviewJson: json(row.review_json), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function mapGrant(row: GrantRow): ToolGrant {
  return {
    id: row.id, toolSnapshotId: row.tool_snapshot_id, connectionId: row.connection_id,
    teamId: row.team_id, subjectType: row.subject_type, subjectId: row.subject_id,
    permissionCode: row.permission_code, status: row.grant_status,
    constraintsJson: json(row.constraints_json), grantedBy: row.granted_by,
    expiresAt: iso(row.expires_at), revokedAt: iso(row.revoked_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function mapCall(row: CallRow): IntegrationToolCall {
  return {
    id: row.id, requestId: row.request_id, teamId: row.team_id, ownerId: row.owner_id,
    actorId: row.actor_id, actorAuthVersion: Number(row.actor_auth_version || 1), connectionId: row.connection_id, toolSnapshotId: row.tool_snapshot_id,
    approvalId: row.approval_id, status: row.call_status, riskLevel: Number(row.risk_level),
    inputHash: row.input_hash, inputArtifactId: row.input_artifact_id,
    inputSummaryJson: json(row.input_summary_json), outputHash: row.output_hash,
    resultArtifactId: row.result_artifact_id, outputSummaryJson: json(row.output_summary_json),
    idempotencyKeyHash: row.idempotency_key_hash, externalReceipt: row.external_receipt,
    evidenceJson: json(row.evidence_json), errorCode: row.error_code, errorMessage: row.error_message,
    attemptCount: Number(row.attempt_count), createdAt: iso(row.created_at), queuedAt: iso(row.queued_at),
    startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), updatedAt: iso(row.updated_at)
  };
}

function mapAuthTransaction(row: AuthTransactionRow): IntegrationAuthTransaction {
  return {
    id: row.id, connectionId: row.connection_id, teamId: row.team_id, ownerId: row.owner_id,
    status: row.transaction_status, stateHash: row.state_hash, nonceHash: row.nonce_hash,
    encryptedContext: row.encrypted_pkce_verifier || "", redirectUri: row.redirect_uri,
    issuer: row.issuer, resourceUri: row.resource_uri, expiresAt: iso(row.expires_at),
    consumedAt: iso(row.consumed_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function mapApproval(row: ApprovalRow): IntegrationApproval {
  return {
    id: row.id, teamId: row.team_id, ownerId: row.owner_id, connectionId: row.connection_id,
    toolSnapshotId: row.tool_snapshot_id, callId: row.call_id, status: row.approval_status,
    riskLevel: Number(row.risk_level), frozenInputHash: row.frozen_input_hash,
    singleUseNonceHash: row.single_use_nonce_hash, requestedBy: row.requested_by,
    decidedBy: row.decided_by, decisionNote: row.decision_note, expiresAt: iso(row.expires_at),
    decidedAt: iso(row.decided_at), consumedAt: iso(row.consumed_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function mapApprovalDetail(row: ApprovalDetailRow): ApprovalDetail {
  return {
    approval: mapApproval(row), requestId: row.detail_request_id,
    actorAuthVersion: Number(row.detail_actor_auth_version), callStatus: row.detail_call_status,
    inputSummaryJson: json(row.detail_input_summary_json), encryptedInput: row.detail_encrypted_input,
    toolRemoteName: row.detail_tool_remote_name, toolDisplayName: row.detail_tool_display_name,
    toolStableAlias: row.detail_tool_stable_alias, toolSchemaHash: row.detail_tool_schema_hash,
    toolReviewJson: json(row.detail_tool_review_json), connectionDisplayName: row.detail_connection_display_name
  };
}

function mapIntegrationEvent(row: IntegrationEventRow): IntegrationEvent {
  return {
    id: row.id,
    connectionId: row.connection_id,
    teamId: row.team_id,
    externalEventId: row.external_event_id,
    eventType: row.event_type,
    status: row.event_status,
    payloadHash: row.payload_hash,
    artifactId: row.artifact_id,
    resultArtifactId: row.result_artifact_id,
    attemptCount: Number(row.attempt_count),
    resultJson: json(row.result_json),
    writebackStatus: row.writeback_status,
    linkedObjectId: row.linked_object_id,
    errorCode: row.last_error_code,
    errorMessage: row.last_error_message,
    nextAttemptAt: iso(row.next_attempt_at),
    receivedAt: iso(row.received_at),
    processedAt: iso(row.processed_at),
    businessWrittenAt: iso(row.business_written_at),
    updatedAt: iso(row.updated_at)
  };
}

function scopeSql(scope: DataScope, alias: string) {
  if (scope.type === "platform") return { sql: "1=1", values: [] as string[] };
  if (!scope.teamId) throw new Error("数据范围缺少 teamId");
  if (scope.type === "team") {
    const ownerIds = [...new Set(scope.ownerIds || [])];
    return ownerIds.length
      ? { sql: `${alias}.team_id = ? AND ${alias}.owner_id IN (${ownerIds.map(() => "?").join(",")})`, values: [scope.teamId, ...ownerIds] }
      : { sql: `${alias}.team_id = ?`, values: [scope.teamId] };
  }
  if (!scope.ownerId) throw new Error("个人数据范围缺少 ownerId");
  return { sql: `${alias}.team_id = ? AND ${alias}.owner_id = ?`, values: [scope.teamId, scope.ownerId] };
}

function connectionAccessSql(scope: DataScope, alias: string) {
  if (scope.type === "platform") return scopeSql(scope, alias);
  if (scope.type === "team") {
    if (!scope.teamId) throw new Error("团队连接访问范围缺少 teamId");
    const ownerIds = [...new Set(scope.ownerIds || [])];
    return ownerIds.length
      ? {
        sql: `${alias}.team_id = ? AND (${alias}.connection_scope='team' OR ${alias}.owner_id IN (${ownerIds.map(() => "?").join(",")}))`,
        values: [scope.teamId, ...ownerIds]
      }
      : scopeSql(scope, alias);
  }
  if (!scope.teamId || !scope.ownerId) throw new Error("个人连接访问范围缺少 teamId 或 ownerId");
  return {
    sql: `${alias}.team_id = ? AND ((${alias}.connection_scope='personal' AND ${alias}.owner_id=?) OR ${alias}.connection_scope='team')`,
    values: [scope.teamId, scope.ownerId]
  };
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export class MysqlIntegrationControlRepository extends MysqlIntegrationRepository {
  constructor(private readonly controlPool: Pool) { super(controlPool); }

  async upsertConnector(connector: ConnectorDefinition) {
    await this.controlPool.execute(
      `INSERT INTO integration_connectors
       (id,code,version,connector_type,trust_level,connector_status,team_id,name,description,
        manifest_json,manifest_hash,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE connector_type=VALUES(connector_type), trust_level=VALUES(trust_level),
        connector_status=VALUES(connector_status), name=VALUES(name), description=VALUES(description),
        manifest_json=VALUES(manifest_json), manifest_hash=VALUES(manifest_hash), updated_at=VALUES(updated_at)`,
      [connector.id, connector.code, connector.version, connector.type, connector.trust, connector.status,
        connector.teamId, connector.name, connector.description, connector.manifestJson,
        connector.manifestHash, connector.createdBy, connector.createdAt, connector.updatedAt]
    );
  }

  async saveApiCredential(input: {
    connectionId: string;
    teamId: string;
    encryptedValue: string;
    fingerprint: string;
  }) {
    const now = new Date().toISOString();
    await transaction(this.controlPool, async (connection) => {
      const [rows] = await connection.query<Array<RowDataPacket & { team_id: string; connection_status: string }>>(
        "SELECT team_id,connection_status FROM integration_connections WHERE id=? LIMIT 1 FOR UPDATE",
        [input.connectionId]
      );
      const current = rows[0];
      if (!current || current.team_id !== input.teamId || current.connection_status !== "authorizing") {
        throw Object.assign(new Error("连接不存在、跨团队或不处于凭据配置状态"), {
          code: "INTEGRATION_CONNECTION_STATE_CONFLICT", status: 409
        });
      }
      await connection.execute(
        `INSERT INTO integration_credentials
         (id,connection_id,team_id,credential_type,encrypted_value,key_version,token_fingerprint,
          expires_at,refreshed_at,revoked_at,created_at,updated_at)
         VALUES (?,?,?,'api_token',?,'v1',?,NULL,?,NULL,?,?)
         ON DUPLICATE KEY UPDATE encrypted_value=VALUES(encrypted_value),key_version='v1',
          token_fingerprint=VALUES(token_fingerprint),expires_at=NULL,refreshed_at=VALUES(refreshed_at),
          revoked_at=NULL,updated_at=VALUES(updated_at)`,
        [`icr_${randomUUID()}`, input.connectionId, input.teamId, input.encryptedValue,
          input.fingerprint, now, now, now]
      );
    });
  }

  async listCatalog(teamId: string, options: { includeReview?: boolean; platform?: boolean } = {}) {
    const where = options.platform
      ? "1=1"
      : options.includeReview
        ? "((team_id = '' AND connector_status IN ('active','draft')) OR (team_id = ? AND connector_status IN ('active','review','disabled')))"
        : "(team_id = '' OR team_id = ?) AND connector_status IN ('active','draft')";
    const [rows] = await this.controlPool.query<ConnectorRow[]>(
      `SELECT * FROM integration_connectors
       WHERE ${where}
       ORDER BY connector_status='active' DESC, name ASC`,
      options.platform ? [] : [teamId]
    );
    return rows.map(mapConnector);
  }

  async findTeamConnectorByCode(teamId: string, code: string) {
    const [rows] = await this.controlPool.query<ConnectorRow[]>(
      "SELECT * FROM integration_connectors WHERE team_id=? AND code=? LIMIT 1",
      [teamId, code]
    );
    return rows[0] ? mapConnector(rows[0]) : null;
  }

  async createPrivateConnectorReview(connector: ConnectorDefinition, review: IntegrationConnectorReview) {
    return transaction(this.controlPool, async (connection) => {
      await connection.execute(
        `INSERT INTO integration_connectors
         (id,code,version,connector_type,trust_level,connector_status,team_id,name,description,
          manifest_json,manifest_hash,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [connector.id, connector.code, connector.version, connector.type, connector.trust, connector.status,
          connector.teamId, connector.name, connector.description, connector.manifestJson,
          connector.manifestHash, connector.createdBy, connector.createdAt, connector.updatedAt]
      );
      await connection.execute(
        `INSERT INTO integration_connector_reviews
         (id,connector_id,team_id,review_status,manifest_hash,submitted_by,reviewed_by,review_note,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [review.id, review.connectorId, review.teamId, review.status, review.manifestHash,
          review.submittedBy, review.reviewedBy, review.reviewNote, review.createdAt, review.updatedAt]
      );
      return { connector, review };
    });
  }

  async listConnectorReviews(status = "", teamId = "") {
    const [rows] = await this.controlPool.query<ConnectorReviewRow[]>(
      `SELECT * FROM integration_connector_reviews
       WHERE 1=1${status ? " AND review_status=?" : ""}${teamId ? " AND team_id=?" : ""}
       ORDER BY updated_at DESC,id DESC LIMIT 200`,
      [...(status ? [status] : []), ...(teamId ? [teamId] : [])]
    );
    return rows.map(mapConnectorReview);
  }

  async decideConnectorReview(
    connectorId: string,
    reviewerId: string,
    decision: "approved" | "rejected",
    note: string
  ) {
    return transaction(this.controlPool, async (connection) => {
      const [reviewRows] = await connection.query<ConnectorReviewRow[]>(
        "SELECT * FROM integration_connector_reviews WHERE connector_id=? FOR UPDATE",
        [connectorId]
      );
      const current = reviewRows[0];
      if (!current) throw integrationNotFound("连接器审核记录不存在");
      if (current.review_status !== "pending") {
        throw Object.assign(new Error("连接器审核已处理，请刷新后查看"), {
          code: "INTEGRATION_CONNECTOR_REVIEW_CONFLICT", status: 409
        });
      }
      const now = new Date().toISOString();
      await connection.execute(
        `UPDATE integration_connector_reviews
         SET review_status=?,reviewed_by=?,review_note=?,updated_at=?
         WHERE connector_id=? AND review_status='pending'`,
        [decision, reviewerId, note.slice(0, 1000), now, connectorId]
      );
      await connection.execute(
        `UPDATE integration_connectors SET connector_status=?,trust_level=?,updated_at=?
         WHERE id=? AND connector_status='review' AND trust_level='private'`,
        [decision === "approved" ? "active" : "disabled",
          decision === "approved" ? "certified" : "quarantined", now, connectorId]
      );
      const [connectorRows] = await connection.query<ConnectorRow[]>(
        "SELECT * FROM integration_connectors WHERE id=? LIMIT 1",
        [connectorId]
      );
      if (!connectorRows[0]) throw integrationNotFound("连接器不存在");
      return {
        connector: mapConnector(connectorRows[0]),
        review: mapConnectorReview({ ...current, review_status: decision, reviewed_by: reviewerId, review_note: note.slice(0, 1000), updated_at: new Date(now) })
      };
    });
  }

  async getConnector(id: string, teamId: string, platform = false) {
    const [rows] = await this.controlPool.query<ConnectorRow[]>(
      `SELECT * FROM integration_connectors WHERE id = ? AND ${platform ? "1=1" : "(team_id = '' OR team_id = ?)"} LIMIT 1`,
      platform ? [id] : [id, teamId]
    );
    return rows[0] ? mapConnector(rows[0]) : null;
  }

  async getWebhookEndpoint(connectorCode: string, webhookPublicId: string): Promise<WebhookEndpointContext | null> {
    const [rows] = await this.controlPool.query<Array<RowDataPacket & {
      connection_id: string; connector_code: string; team_id: string; owner_id: string;
      webhook_public_id: string; connection_status: ConnectionStatus;
    }>>(
      `SELECT c.id AS connection_id,d.code AS connector_code,c.team_id,c.owner_id,
       c.webhook_public_id,c.connection_status
       FROM integration_connections c
       JOIN integration_connectors d ON d.id=c.connector_id
       WHERE d.code=? AND c.webhook_public_id=? AND d.connector_status='active'
       AND c.connection_status IN ('active','degraded') LIMIT 1`,
      [connectorCode, webhookPublicId]
    );
    const row = rows[0];
    return row ? {
      connectionId: row.connection_id,
      connectorCode: row.connector_code,
      teamId: row.team_id,
      ownerId: row.owner_id,
      webhookPublicId: row.webhook_public_id,
      status: row.connection_status
    } : null;
  }

  async getWebhookEvent(id: string) {
    const [rows] = await this.controlPool.query<IntegrationEventRow[]>(
      "SELECT * FROM integration_events WHERE id=? LIMIT 1",
      [id]
    );
    return rows[0] ? mapIntegrationEvent(rows[0]) : null;
  }

  async listWebhookEvents(scope: DataScope, status = "", limit = 100) {
    const scoped = connectionAccessSql(scope, "c");
    const [rows] = await this.controlPool.query<IntegrationEventRow[]>(
      `SELECT e.* FROM integration_events e
       JOIN integration_connections c ON c.id=e.connection_id
       WHERE ${scoped.sql}${status ? " AND e.event_status=?" : ""}
       ORDER BY e.received_at DESC,e.id DESC LIMIT ?`,
      [...scoped.values, ...(status ? [status] : []), Math.max(1, Math.min(200, limit))]
    );
    return rows.map(mapIntegrationEvent);
  }

  async replayWebhookEvent(id: string, scope: DataScope) {
    const scoped = connectionAccessSql(scope, "c");
    const now = new Date().toISOString();
    const [updated] = await this.controlPool.execute<ResultSetHeader>(
      `UPDATE integration_events e JOIN integration_connections c ON c.id=e.connection_id
       SET e.event_status='replayed',e.next_attempt_at=NULL,e.last_error_code='',e.last_error_message='',
       e.processing_lease_id='',e.processing_lease_expires_at=NULL,e.processed_at=NULL,e.updated_at=?
       WHERE e.id=? AND e.event_status='dead_letter' AND ${scoped.sql}`,
      [now, id, ...scoped.values]
    );
    if (updated.affectedRows !== 1) {
      throw Object.assign(new Error("事件不存在、无权访问或当前状态不能回放"), {
        code: "INTEGRATION_EVENT_STATE_CONFLICT", status: 409
      });
    }
    return (await this.getWebhookEvent(id))!;
  }

  async linkWebhookEventCustomer(id: string, scope: DataScope, customerId: string) {
    const access = scope.type === "platform"
      ? { sql: "1=1", values: [] as string[] }
      : scope.type === "team"
        ? scope.ownerIds?.length
          ? { sql: `c.team_id=? AND (c.connection_scope='team' OR c.owner_id IN (${scope.ownerIds.map(() => "?").join(",")}))`, values: [String(scope.teamId || ""), ...scope.ownerIds] }
          : { sql: "c.team_id=?", values: [String(scope.teamId || "")] }
        : { sql: "c.team_id=? AND c.owner_id=?", values: [String(scope.teamId || ""), String(scope.ownerId || "")] };
    const now = new Date().toISOString();
    const [updated] = await this.controlPool.execute<ResultSetHeader>(
      `UPDATE integration_events e JOIN integration_connections c ON c.id=e.connection_id
       SET e.linked_object_id=?,e.writeback_status='pending',e.business_written_at=NULL,
       e.last_error_code='',e.last_error_message='',e.updated_at=?
       WHERE e.id=? AND e.event_status='processed' AND e.writeback_status IN ('needs_match','failed')
       AND ${access.sql}`,
      [customerId, now, id, ...access.values]
    );
    if (updated.affectedRows !== 1) {
      throw Object.assign(new Error("事件不存在、无权访问或当前不需要关联客户"), {
        code: "INTEGRATION_EVENT_STATE_CONFLICT", status: 409
      });
    }
    return (await this.getWebhookEvent(id))!;
  }

  async createWebhookEvent(input: CreateWebhookEventInput) {
    try {
      await transaction(this.controlPool, async (connection) => {
        await connection.execute(
          `INSERT INTO integration_artifacts
           (id,team_id,owner_id,connection_id,artifact_type,content_hash,encrypted_value,key_version,content_type,expires_at,created_at)
           VALUES (?,?,?,?, 'webhook_raw', ?,?, 'v1', 'application/json', ?,?)`,
          [input.artifact.id, input.teamId, input.ownerId, input.connectionId, input.artifact.contentHash,
            input.artifact.encryptedValue, input.artifact.expiresAt, input.receivedAt]
        );
        await connection.execute(
          `INSERT INTO integration_events
           (id,connection_id,team_id,external_event_id,event_type,event_status,payload_hash,artifact_id,
            attempt_count,result_json,last_error_code,last_error_message,next_attempt_at,processing_lease_id,
            processing_lease_expires_at,received_at,processed_at,updated_at)
           VALUES (?,?,?,?,?,'queued',?,?,0,NULL,'','',NULL,'',NULL,?,NULL,?)`,
          [input.id, input.connectionId, input.teamId, input.externalEventId, input.eventType,
            input.payloadHash, input.artifact.id, input.receivedAt, input.receivedAt]
        );
      });
      return { event: (await this.getWebhookEvent(input.id))!, duplicate: false };
    } catch (cause) {
      const mysqlError = cause as { code?: string };
      if (mysqlError.code !== "ER_DUP_ENTRY") throw cause;
      const [rows] = await this.controlPool.query<IntegrationEventRow[]>(
        "SELECT * FROM integration_events WHERE connection_id=? AND external_event_id=? LIMIT 1",
        [input.connectionId, input.externalEventId]
      );
      if (!rows[0]) throw cause;
      return { event: mapIntegrationEvent(rows[0]), duplicate: true };
    }
  }

  async listPendingWebhookWritebacks(limit = 100): Promise<PendingWebhookWriteback[]> {
    const [rows] = await this.controlPool.query<Array<RowDataPacket & {
      event_id: string; connection_id: string; team_id: string; owner_id: string;
      event_type: string; external_event_id: string; result_artifact_id: string;
      linked_object_id: string; encrypted_value: string; content_hash: string;
    }>>(
      `SELECT e.id AS event_id,e.connection_id,e.team_id,c.owner_id,e.event_type,e.external_event_id,
       e.result_artifact_id,e.linked_object_id,a.encrypted_value,a.content_hash
       FROM integration_events e
       JOIN integration_connections c ON c.id=e.connection_id AND c.team_id=e.team_id
       JOIN integration_artifacts a ON a.id=e.result_artifact_id AND a.connection_id=e.connection_id
        AND a.team_id=e.team_id AND a.artifact_type='webhook_result'
       WHERE e.event_status='processed' AND e.writeback_status='pending'
       ORDER BY e.processed_at ASC,e.id ASC LIMIT ?`,
      [Math.max(1, Math.min(500, limit))]
    );
    return rows.map((row) => ({
      eventId: row.event_id,
      connectionId: row.connection_id,
      teamId: row.team_id,
      ownerId: row.owner_id,
      eventType: row.event_type,
      externalEventId: row.external_event_id,
      resultArtifactId: row.result_artifact_id,
      linkedObjectId: row.linked_object_id,
      encryptedValue: row.encrypted_value,
      contentHash: row.content_hash
    }));
  }

  async completeWebhookWriteback(eventId: string, status: "completed" | "needs_match", linkedObjectId = "") {
    const now = new Date().toISOString();
    const [updated] = await this.controlPool.execute<ResultSetHeader>(
      `UPDATE integration_events SET writeback_status=?,linked_object_id=?,business_written_at=?,updated_at=?
       WHERE id=? AND event_status='processed' AND writeback_status='pending'`,
      [status, linkedObjectId.slice(0, 64), now, now, eventId]
    );
    return updated.affectedRows === 1;
  }

  async failWebhookWriteback(eventId: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await this.controlPool.execute(
      `UPDATE integration_events SET writeback_status='failed',last_error_code='INTEGRATION_WEBHOOK_WRITEBACK_FAILED',
       last_error_message=?,business_written_at=?,updated_at=?
       WHERE id=? AND event_status='processed' AND writeback_status='pending'`,
      [message.slice(0, 1_000), new Date().toISOString(), new Date().toISOString(), eventId]
    );
  }

  async createAuthTransaction(input: IntegrationAuthTransaction) {
    await this.controlPool.execute(
      `INSERT INTO integration_auth_transactions
       (id,connection_id,team_id,owner_id,transaction_status,state_hash,nonce_hash,
        encrypted_pkce_verifier,redirect_uri,issuer,resource_uri,expires_at,consumed_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
      [input.id, input.connectionId, input.teamId, input.ownerId, input.status, input.stateHash,
        input.nonceHash, input.encryptedContext, input.redirectUri, input.issuer,
        input.resourceUri, input.expiresAt, input.createdAt, input.updatedAt]
    );
    return input;
  }

  async getAuthTransaction(id: string, scope: DataScope) {
    const scoped = connectionAccessSql(scope, "c");
    const [rows] = await this.controlPool.query<AuthTransactionRow[]>(
      `SELECT a.* FROM integration_auth_transactions a
       JOIN integration_connections c ON c.id=a.connection_id
       WHERE a.id=? AND ${scoped.sql} LIMIT 1`,
      [id, ...scoped.values]
    );
    return rows[0] ? mapAuthTransaction(rows[0]) : null;
  }

  async latestAuthTransaction(connectionId: string, scope: DataScope) {
    const scoped = connectionAccessSql(scope, "c");
    const [rows] = await this.controlPool.query<AuthTransactionRow[]>(
      `SELECT a.* FROM integration_auth_transactions a
       JOIN integration_connections c ON c.id=a.connection_id
       WHERE a.connection_id=? AND ${scoped.sql}
       ORDER BY a.created_at DESC,a.id DESC LIMIT 1`,
      [connectionId, ...scoped.values]
    );
    return rows[0] ? mapAuthTransaction(rows[0]) : null;
  }

  async findAuthTransactionForCallback(stateHash: string, connectorCode: string) {
    const [rows] = await this.controlPool.query<AuthTransactionRow[]>(
      `SELECT a.* FROM integration_auth_transactions a
       JOIN integration_connections c ON c.id=a.connection_id
       JOIN integration_connectors d ON d.id=c.connector_id
       WHERE a.state_hash=? AND d.code=? LIMIT 1`,
      [stateHash, connectorCode]
    );
    return rows[0] ? mapAuthTransaction(rows[0]) : null;
  }

  async markAuthCallbackReceived(id: string, encryptedContext: string) {
    const now = new Date().toISOString();
    const [result] = await this.controlPool.execute<ResultSetHeader>(
      `UPDATE integration_auth_transactions
       SET transaction_status='callback_received',encrypted_pkce_verifier=?,updated_at=?
       WHERE id=? AND transaction_status='authorize_url_ready' AND expires_at>?`,
      [encryptedContext, now, id, now]
    );
    if (result.affectedRows !== 1) {
      throw Object.assign(new Error("授权回调已处理、已过期或状态不匹配"), { code: "INTEGRATION_OAUTH_STATE_INVALID", status: 409 });
    }
  }

  async consumeAuthTransaction(id: string, connectionId: string) {
    const now = new Date().toISOString();
    const [result] = await this.controlPool.execute<ResultSetHeader>(
      `UPDATE integration_auth_transactions SET transaction_status='consumed',consumed_at=?,updated_at=?
       WHERE id=? AND connection_id=? AND transaction_status='completed' AND expires_at>?`,
      [now, now, id, connectionId, now]
    );
    if (result.affectedRows !== 1) {
      throw Object.assign(new Error("授权事务尚未完成或已被消费"), { code: "INTEGRATION_OAUTH_STATE_INVALID", status: 409 });
    }
  }

  async failAuthTransaction(id: string) {
    const now = new Date().toISOString();
    await this.controlPool.execute(
      `UPDATE integration_auth_transactions SET transaction_status='failed',updated_at=?
       WHERE id=? AND transaction_status IN ('created','authorize_url_ready','callback_received')`,
      [now, id]
    );
  }

  async listTools(scope: DataScope, connectionId = "") {
    const scoped = connectionAccessSql(scope, "c");
    const [rows] = await this.controlPool.query<ToolRow[]>(
      `SELECT t.* FROM integration_tool_snapshots t
       JOIN integration_connections c ON c.id=t.connection_id
       WHERE ${scoped.sql}${connectionId ? " AND t.connection_id = ?" : ""}
       ORDER BY t.updated_at DESC`,
      [...scoped.values, ...(connectionId ? [connectionId] : [])]
    );
    return rows.map(mapTool);
  }

  async getTool(id: string, scope: DataScope) {
    const scoped = connectionAccessSql(scope, "c");
    const [rows] = await this.controlPool.query<ToolRow[]>(
      `SELECT t.* FROM integration_tool_snapshots t
       JOIN integration_connections c ON c.id=t.connection_id
       WHERE t.id=? AND ${scoped.sql} LIMIT 1`,
      [id, ...scoped.values]
    );
    return rows[0] ? mapTool(rows[0]) : null;
  }

  async findActiveToolByAlias(stableAlias: string, scope: DataScope) {
    const scoped = connectionAccessSql(scope, "c");
    const [rows] = await this.controlPool.query<ToolRow[]>(
      `SELECT t.* FROM integration_tool_snapshots t
       JOIN integration_connections c ON c.id=t.connection_id
       WHERE t.stable_alias=? AND t.tool_status='active' AND c.connection_status IN ('active','degraded')
       AND ${scoped.sql} ORDER BY t.updated_at DESC LIMIT 1`,
      [stableAlias, ...scoped.values]
    );
    return rows[0] ? mapTool(rows[0]) : null;
  }

  async findActivePersonalToolByRemoteName(remoteName: string, actor: SessionUser, connectorCode: string) {
    const [rows] = await this.controlPool.query<ToolRow[]>(
      `SELECT t.* FROM integration_tool_snapshots t
       JOIN integration_connections c ON c.id=t.connection_id
       JOIN integration_connectors d ON d.id=c.connector_id
       WHERE t.remote_name=? AND t.tool_status='active' AND c.connection_status IN ('active','degraded')
       AND c.connection_scope='personal' AND c.owner_id=? AND c.team_id=?
       AND d.code=? AND d.connector_status='active'
       ORDER BY t.updated_at DESC LIMIT 1`,
      [remoteName, actor.id, actor.teamId, connectorCode]
    );
    return rows[0] ? mapTool(rows[0]) : null;
  }

  async createBusinessLink(input: Omit<IntegrationBusinessLink, "externalObjectId" | "writebackStatus" | "lastError" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    await this.controlPool.execute(
      `INSERT INTO integration_business_links
       (id,call_id,team_id,owner_id,object_type,object_id,operation,external_object_id,
        external_thread_id,writeback_status,next_action_at,metadata_json,last_error,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'',?,'pending',?,?,'',?,?)`,
      [input.id, input.callId, input.teamId, input.ownerId, input.objectType, input.objectId,
        input.operation, input.externalThreadId, input.nextActionAt, JSON.stringify(input.metadata), now, now]
    );
  }

  private mapBusinessLink(row: RowDataPacket & Record<string, unknown>): IntegrationBusinessLink {
    const metadata = typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json || {};
    return {
      id: String(row.id), callId: String(row.call_id), teamId: String(row.team_id), ownerId: String(row.owner_id),
      objectType: "customer", objectId: String(row.object_id),
      operation: String(row.operation) as IntegrationBusinessLink["operation"],
      externalObjectId: String(row.external_object_id || ""), externalThreadId: String(row.external_thread_id || ""),
      writebackStatus: String(row.writeback_status) as IntegrationBusinessLink["writebackStatus"],
      nextActionAt: String(row.next_action_at || ""), metadata: metadata as Record<string, unknown>,
      lastError: String(row.last_error || ""),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || "")
    };
  }

  async getBusinessLinkByCall(callId: string, scope: DataScope) {
    const scoped = scopeSql(scope, "b");
    const [rows] = await this.controlPool.query<Array<RowDataPacket & Record<string, unknown>>>(
      `SELECT b.* FROM integration_business_links b WHERE b.call_id=? AND ${scoped.sql} LIMIT 1`,
      [callId, ...scoped.values]
    );
    return rows[0] ? this.mapBusinessLink(rows[0]) : null;
  }

  async listBusinessThreadLinks(teamId: string, ownerId: string, externalThreadIds: string[]) {
    const ids = [...new Set(externalThreadIds.filter(Boolean))].slice(0, 100);
    if (!ids.length) return [];
    const [rows] = await this.controlPool.query<Array<RowDataPacket & Record<string, unknown>>>(
      `SELECT b.* FROM integration_business_links b
       WHERE b.team_id=? AND b.owner_id=? AND b.external_thread_id IN (${ids.map(() => "?").join(",")})
       AND b.writeback_status='completed' ORDER BY b.updated_at DESC`,
      [teamId, ownerId, ...ids]
    );
    return rows.map((row) => this.mapBusinessLink(row));
  }

  async listPendingBusinessWritebacks(limit = 100) {
    const [rows] = await this.controlPool.query<Array<RowDataPacket & Record<string, unknown>>>(
      `SELECT b.* FROM integration_business_links b
       JOIN integration_tool_calls c ON c.id=b.call_id
       WHERE b.writeback_status='pending' AND c.call_status='succeeded'
       ORDER BY b.created_at ASC LIMIT ?`,
      [Math.max(1, Math.min(500, limit))]
    );
    return rows.map((row) => this.mapBusinessLink(row));
  }

  async completeBusinessWriteback(id: string, externalObjectId: string, externalThreadId: string) {
    const now = new Date().toISOString();
    const [result] = await this.controlPool.execute<ResultSetHeader>(
      `UPDATE integration_business_links SET writeback_status='completed',external_object_id=?,
       external_thread_id=?,last_error='',updated_at=? WHERE id=? AND writeback_status='pending'`,
      [externalObjectId.slice(0, 500), externalThreadId.slice(0, 500), now, id]
    );
    return result.affectedRows === 1;
  }

  async failBusinessWriteback(id: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await this.controlPool.execute(
      `UPDATE integration_business_links SET writeback_status='failed',last_error=?,updated_at=?
       WHERE id=? AND writeback_status='pending'`,
      [message.slice(0, 500), new Date().toISOString(), id]
    );
  }

  async reviewTool(id: string, scope: DataScope, input: ToolReviewInput) {
    const tool = await this.getTool(id, scope);
    if (!tool) throw integrationNotFound("工具不存在或无权访问");
    if (!new Set(["pending_review", "quarantined", "rejected"]).has(tool.status)) {
      throw Object.assign(new Error("工具当前状态不能审核"), { code: "INTEGRATION_TOOL_STATE_CONFLICT", status: 409 });
    }
    const now = new Date().toISOString();
    const [result] = await this.controlPool.execute<ResultSetHeader>(
      `UPDATE integration_tool_snapshots SET tool_status=?,stable_alias=?,risk_level=?,permission_code=?,
       review_json=?,reviewed_by=?,reviewed_at=?,updated_at=?,revision_no=revision_no+1
       WHERE id=? AND tool_status=?`,
      [input.status, input.stableAlias, input.riskLevel, input.permissionCode, JSON.stringify(input.review),
        input.reviewerId, now, now, id, tool.status]
    );
    if (result.affectedRows !== 1) throw Object.assign(new Error("工具审核状态已变化"), { status: 409 });
    return (await this.getTool(id, scope))!;
  }

  async replaceGrants(tool: ToolSnapshot, actorId: string, grants: GrantInput[]) {
    const now = new Date().toISOString();
    await transaction(this.controlPool, async (connection) => {
      await connection.execute(
        "UPDATE integration_tool_grants SET grant_status='revoked',revoked_at=?,updated_at=? WHERE tool_snapshot_id=? AND grant_status='active'",
        [now, now, tool.id]
      );
      for (const grant of grants) {
        const id = `igr_${tool.id}_${grant.subjectType}_${grant.subjectId}_${grant.permissionCode}`.slice(0, 64);
        await connection.execute(
          `INSERT INTO integration_tool_grants
           (id,tool_snapshot_id,connection_id,team_id,subject_type,subject_id,permission_code,
            grant_status,constraints_json,granted_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,'active',?,?,?,?)
           ON DUPLICATE KEY UPDATE grant_status='active',constraints_json=VALUES(constraints_json),
            granted_by=VALUES(granted_by),revoked_at=NULL,updated_at=VALUES(updated_at)`,
          [id, tool.id, tool.connectionId, tool.teamId, grant.subjectType, grant.subjectId,
            grant.permissionCode, JSON.stringify(grant.constraints), actorId, now, now]
        );
      }
    });
    return this.listGrants(tool.id, tool.teamId);
  }

  async listGrants(toolId: string, teamId: string) {
    const [rows] = await this.controlPool.query<GrantRow[]>(
      "SELECT * FROM integration_tool_grants WHERE tool_snapshot_id=? AND team_id=? ORDER BY subject_type,subject_id",
      [toolId, teamId]
    );
    return rows.map(mapGrant);
  }

  async hasActiveGrant(tool: ToolSnapshot, actor: SessionUser) {
    const [rows] = await this.controlPool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count FROM integration_tool_grants
       WHERE tool_snapshot_id=? AND team_id=? AND grant_status='active'
       AND permission_code=? AND (expires_at IS NULL OR expires_at>NOW(3))
       AND ((subject_type='user' AND subject_id=?) OR (subject_type='team' AND subject_id=?))`,
      [tool.id, actor.teamId, tool.permissionCode, actor.id, actor.teamId]
    );
    return Number(rows[0]?.count || 0) > 0;
  }

  private async reserveDailyCallQuota(connection: PoolConnection, input: CreateReadCallInput) {
    const usageDate = input.createdAt.slice(0, 10);
    await connection.execute(
      `INSERT IGNORE INTO integration_usage_daily
       (usage_date,team_id,connection_id,tool_snapshot_id,call_count,success_count,failure_count,
        input_bytes,output_bytes,estimated_cost,updated_at)
       VALUES (?,?,?,?,0,0,0,0,0,0,?)`,
      [usageDate, input.teamId, input.connectionId, input.toolSnapshotId, input.createdAt]
    );
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE integration_usage_daily SET call_count=call_count+1,input_bytes=input_bytes+?,updated_at=?
       WHERE usage_date=? AND team_id=? AND connection_id=? AND tool_snapshot_id=? AND call_count<?`,
      [Math.max(0, input.inputBytes), input.createdAt, usageDate, input.teamId,
        input.connectionId, input.toolSnapshotId, input.dailyCallLimit]
    );
    if (updated.affectedRows === 1) return;
    const [rows] = await connection.query<Array<RowDataPacket & { call_count: number }>>(
      `SELECT call_count FROM integration_usage_daily
       WHERE usage_date=? AND team_id=? AND connection_id=? AND tool_snapshot_id=? LIMIT 1`,
      [usageDate, input.teamId, input.connectionId, input.toolSnapshotId]
    );
    throw Object.assign(new Error(`今日调用次数已达到上限（${Number(rows[0]?.call_count || 0)}/${input.dailyCallLimit}）`), {
      code: "INTEGRATION_DAILY_QUOTA_EXCEEDED",
      status: 429,
      current: Number(rows[0]?.call_count || 0),
      limit: input.dailyCallLimit
    });
  }

  private async assertCallCircuitAvailable(connection: PoolConnection, input: CreateReadCallInput) {
    await connection.execute(
      `INSERT IGNORE INTO integration_circuit_states
       (subject_type,subject_id,team_id,connection_id,circuit_state,consecutive_failures,
        consecutive_successes,last_latency_ms,last_error_code,last_error_message,updated_at)
       VALUES ('connection',?,?,?,'closed',0,0,0,'','',?),('tool',?,?,?,'closed',0,0,0,'','',?)`,
      [input.connectionId, input.teamId, input.connectionId, input.createdAt,
        input.toolSnapshotId, input.teamId, input.connectionId, input.createdAt]
    );
    const [rows] = await connection.query<Array<RowDataPacket & {
      subject_type: "connection" | "tool"; subject_id: string; circuit_state: "closed" | "open" | "half_open";
      open_until: Date | null; updated_at: Date;
    }>>(
      `SELECT subject_type,subject_id,circuit_state,open_until,updated_at FROM integration_circuit_states
       WHERE (subject_type='connection' AND subject_id=?) OR (subject_type='tool' AND subject_id=?) FOR UPDATE`,
      [input.connectionId, input.toolSnapshotId]
    );
    const connectionGuard = rows.find((row) => row.subject_type === "connection");
    if (connectionGuard && connectionGuard.circuit_state !== "closed") {
      throw Object.assign(new Error("外部连接正在自动恢复，健康检查通过后会恢复调用"), {
        code: "INTEGRATION_CIRCUIT_OPEN", status: 503, recoverable: true
      });
    }
    const toolGuard = rows.find((row) => row.subject_type === "tool");
    if (!toolGuard || toolGuard.circuit_state === "closed") return;
    const now = new Date(input.createdAt);
    const staleHalfOpen = toolGuard.circuit_state === "half_open"
      && new Date(toolGuard.updated_at).getTime() <= now.getTime() - 15 * 60_000;
    const probeAllowed = toolGuard.circuit_state === "open"
      && (!toolGuard.open_until || new Date(toolGuard.open_until).getTime() <= now.getTime());
    if (probeAllowed || staleHalfOpen) {
      await connection.execute(
        `UPDATE integration_circuit_states SET circuit_state='half_open',updated_at=?
         WHERE subject_type='tool' AND subject_id=?`,
        [input.createdAt, input.toolSnapshotId]
      );
      return;
    }
    throw Object.assign(new Error("外部工具暂时熔断，请稍后重试"), {
      code: "INTEGRATION_CIRCUIT_OPEN", status: 503, recoverable: true
    });
  }

  async createApprovalCall(input: CreateApprovalCallInput) {
    await transaction(this.controlPool, async (connection) => {
      await this.assertCallCircuitAvailable(connection, input);
      await this.reserveDailyCallQuota(connection, input);
      await connection.execute(
        `INSERT INTO integration_artifacts
         (id,team_id,owner_id,connection_id,artifact_type,content_hash,encrypted_value,key_version,content_type,expires_at,created_at)
         VALUES (?,?,?,?, 'tool_input', ?,?,?, 'application/json', ?,?)`,
        [input.artifact.id, input.teamId, input.ownerId, input.connectionId, input.artifact.contentHash,
          input.artifact.encryptedValue, input.artifact.keyVersion, input.artifact.expiresAt, input.createdAt]
      );
      await connection.execute(
        `INSERT INTO integration_tool_calls
         (id,request_id,team_id,owner_id,actor_id,actor_auth_version,connection_id,tool_snapshot_id,approval_id,
          call_status,risk_level,input_hash,input_artifact_id,input_summary_json,output_hash,
          result_artifact_id,output_summary_json,idempotency_key_hash,external_receipt,evidence_json,
          error_code,error_message,attempt_count,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'awaiting_approval',?,?,?,?, '','',NULL,?,'',NULL,'','',0,?,?)`,
        [input.id, input.requestId, input.teamId, input.ownerId, input.actorId, input.actorAuthVersion,
          input.connectionId, input.toolSnapshotId, input.approval.id, input.riskLevel, input.inputHash,
          input.artifact.id, JSON.stringify(input.inputSummary), input.idempotencyKeyHash,
          input.createdAt, input.createdAt]
      );
      await connection.execute(
        `INSERT INTO integration_approvals
         (id,team_id,owner_id,connection_id,tool_snapshot_id,call_id,approval_status,risk_level,
          frozen_input_hash,single_use_nonce_hash,requested_by,decided_by,decision_note,expires_at,
          created_at,updated_at)
         VALUES (?,?,?,?,?,?,'pending',?,?,?,?,'','',?,?,?)`,
        [input.approval.id, input.teamId, input.ownerId, input.connectionId, input.toolSnapshotId,
          input.id, input.riskLevel, input.inputHash, input.approval.singleUseNonceHash,
          input.actorId, input.approval.expiresAt, input.createdAt, input.createdAt]
      );
      await connection.execute(
        `INSERT INTO integration_call_events
         (call_id,team_id,actor_id,event_type,from_status,to_status,request_id,input_hash,output_hash,summary_json,created_at)
         VALUES (?,?,?,'approval_requested','created','awaiting_approval',?,?,'',?,?)`,
        [input.id, input.teamId, input.actorId, input.requestId, input.inputHash,
          JSON.stringify({ approvalId: input.approval.id, riskLevel: input.riskLevel }), input.createdAt]
      );
      if (input.businessLink) {
        await connection.execute(
          `INSERT INTO integration_business_links
           (id,call_id,team_id,owner_id,object_type,object_id,operation,external_object_id,
            external_thread_id,writeback_status,next_action_at,metadata_json,last_error,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,'',?,'pending',?,?,'',?,?)`,
          [input.businessLink.id, input.id, input.teamId, input.ownerId, input.businessLink.objectType,
            input.businessLink.objectId, input.businessLink.operation, input.businessLink.externalThreadId,
            input.businessLink.nextActionAt, JSON.stringify(input.businessLink.metadata), input.createdAt, input.createdAt]
        );
      }
    });
    return this.getApprovalDetail(input.approval.id, { type: "personal", teamId: input.teamId, ownerId: input.ownerId });
  }

  private approvalDetailSql(where: string) {
    return `SELECT a.*,c.request_id AS detail_request_id,c.actor_auth_version AS detail_actor_auth_version,
      c.call_status AS detail_call_status,c.input_summary_json AS detail_input_summary_json,
      ar.encrypted_value AS detail_encrypted_input,t.remote_name AS detail_tool_remote_name,
      t.display_name AS detail_tool_display_name,t.stable_alias AS detail_tool_stable_alias,
      t.schema_hash AS detail_tool_schema_hash,t.review_json AS detail_tool_review_json,
      cn.display_name AS detail_connection_display_name
      FROM integration_approvals a
      JOIN integration_tool_calls c ON c.id=a.call_id
      JOIN integration_artifacts ar ON ar.id=c.input_artifact_id AND ar.artifact_type='tool_input'
      JOIN integration_tool_snapshots t ON t.id=a.tool_snapshot_id
      JOIN integration_connections cn ON cn.id=a.connection_id
      WHERE ${where}`;
  }

  async getApprovalDetail(id: string, scope: DataScope) {
    const scoped = scopeSql(scope, "a");
    const [rows] = await this.controlPool.query<ApprovalDetailRow[]>(
      `${this.approvalDetailSql(`a.id=? AND ${scoped.sql}`)} LIMIT 1`,
      [id, ...scoped.values]
    );
    return rows[0] ? mapApprovalDetail(rows[0]) : null;
  }

  async listApprovalDetails(scope: DataScope, status = "", limit = 100) {
    const scoped = scopeSql(scope, "a");
    const [rows] = await this.controlPool.query<ApprovalDetailRow[]>(
      `${this.approvalDetailSql(`${scoped.sql}${status ? " AND a.approval_status=?" : ""}`)}
       ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
      [...scoped.values, ...(status ? [status] : []), Math.max(1, Math.min(200, limit))]
    );
    return rows.map(mapApprovalDetail);
  }

  async consumeApproval(id: string, scope: DataScope, approverId: string) {
    const scoped = scopeSql(scope, "a");
    const outcome = await transaction(this.controlPool, async (connection) => {
      const [rows] = await connection.query<Array<RowDataPacket & {
        approval_status: IntegrationApproval["status"]; expires_at: Date; frozen_input_hash: string;
        call_id: string; call_status: IntegrationToolCall["status"]; input_hash: string;
        input_summary_json: unknown; request_id: string; actor_id: string; actor_auth_version: number;
        team_id: string; connection_status: string; tool_status: string; review_json: unknown;
        user_status: string; current_auth_version: number; grant_count: number;
      }>>(
        `SELECT a.approval_status,a.expires_at,a.frozen_input_hash,a.call_id,c.call_status,c.input_hash,
         c.input_summary_json,c.request_id,c.actor_id,c.actor_auth_version,c.team_id,
         cn.connection_status,t.tool_status,t.review_json,u.status AS user_status,
         u.auth_version AS current_auth_version,
         (SELECT COUNT(*) FROM integration_tool_grants g WHERE g.tool_snapshot_id=t.id
          AND g.team_id=c.team_id AND g.grant_status='active' AND g.permission_code=t.permission_code
          AND (g.expires_at IS NULL OR g.expires_at>NOW(3))
          AND ((g.subject_type='user' AND g.subject_id=c.actor_id)
            OR (g.subject_type='team' AND g.subject_id=c.team_id))) AS grant_count
         FROM integration_approvals a
         JOIN integration_tool_calls c ON c.id=a.call_id
         JOIN integration_connections cn ON cn.id=a.connection_id
         JOIN integration_tool_snapshots t ON t.id=a.tool_snapshot_id
         JOIN users u ON u.id=c.actor_id
         WHERE a.id=? AND ${scoped.sql} FOR UPDATE`,
        [id, ...scoped.values]
      );
      const row = rows[0];
      if (!row) return { kind: "not_found" as const };
      if (row.approval_status !== "pending" || row.call_status !== "awaiting_approval") return { kind: "state" as const };
      const now = new Date().toISOString();
      if (row.expires_at.getTime() <= Date.now()) {
        await connection.execute("UPDATE integration_approvals SET approval_status='expired',updated_at=? WHERE id=?", [now, id]);
        await connection.execute("UPDATE integration_tool_calls SET call_status='cancelled',finished_at=?,updated_at=? WHERE id=?", [now, now, row.call_id]);
        return { kind: "expired" as const };
      }
      const summary = (typeof row.input_summary_json === "string" ? JSON.parse(row.input_summary_json) : row.input_summary_json || {}) as Record<string, unknown>;
      const approvalSnapshot = (summary.approval || {}) as Record<string, unknown>;
      const policyHash = hash(canonicalJson(row.review_json || {}));
      const changed = row.frozen_input_hash !== row.input_hash
        || String(approvalSnapshot.policyHash || "") !== policyHash
        || row.connection_status !== "active" || row.tool_status !== "active"
        || row.user_status !== "active"
        || Number(row.current_auth_version || 1) !== Number(row.actor_auth_version || 1)
        || Number(row.grant_count || 0) < 1;
      if (changed) {
        await connection.execute("UPDATE integration_approvals SET approval_status='cancelled',decision_note='审批上下文已变化',updated_at=? WHERE id=?", [now, id]);
        await connection.execute("UPDATE integration_tool_calls SET call_status='cancelled',error_code='INTEGRATION_APPROVAL_CHANGED',error_message='审批上下文已变化',finished_at=?,updated_at=? WHERE id=?", [now, now, row.call_id]);
        return { kind: "changed" as const };
      }
      const [approvalUpdate] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_approvals SET approval_status='consumed',decided_by=?,decided_at=?,consumed_at=?,updated_at=?
         WHERE id=? AND approval_status='pending'`,
        [approverId, now, now, now, id]
      );
      const [callUpdate] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_tool_calls SET call_status='queued',queued_at=?,updated_at=?
         WHERE id=? AND call_status='awaiting_approval'`,
        [now, now, row.call_id]
      );
      if (approvalUpdate.affectedRows !== 1 || callUpdate.affectedRows !== 1) return { kind: "state" as const };
      await connection.execute(
        `INSERT INTO integration_call_events
         (call_id,team_id,actor_id,event_type,from_status,to_status,request_id,input_hash,output_hash,summary_json,created_at)
         VALUES (?,?,?,'approval_consumed','awaiting_approval','queued',?,?,'',?,?)`,
        [row.call_id, row.team_id, row.actor_id, row.request_id, row.input_hash,
          JSON.stringify({ approvalId: id, approverId }), now]
      );
      return { kind: "queued" as const, callId: row.call_id };
    });
    if (outcome.kind === "not_found") throw integrationNotFound("审批不存在或无权访问");
    if (outcome.kind === "state") throw Object.assign(new Error("审批已处理，不能重复批准"), { code: "INTEGRATION_APPROVAL_STATE_CONFLICT", status: 409 });
    if (outcome.kind === "expired") throw Object.assign(new Error("审批已过期，请重新发起"), { code: "INTEGRATION_APPROVAL_EXPIRED", status: 409 });
    if (outcome.kind === "changed") throw Object.assign(new Error("参数、权限或工具状态已变化，请重新发起审批"), { code: "INTEGRATION_APPROVAL_CHANGED", status: 409 });
    return this.getCall(outcome.callId, scope);
  }

  async rejectApproval(id: string, scope: DataScope, approverId: string, note: string) {
    const scoped = scopeSql(scope, "a");
    const outcome = await transaction(this.controlPool, async (connection) => {
      const [rows] = await connection.query<Array<RowDataPacket & { call_id: string; team_id: string; actor_id: string; request_id: string; input_hash: string }>>(
        `SELECT a.call_id,c.team_id,c.actor_id,c.request_id,c.input_hash FROM integration_approvals a
         JOIN integration_tool_calls c ON c.id=a.call_id
         WHERE a.id=? AND a.approval_status='pending' AND c.call_status='awaiting_approval' AND ${scoped.sql} FOR UPDATE`,
        [id, ...scoped.values]
      );
      const row = rows[0];
      if (!row) return null;
      const now = new Date().toISOString();
      await connection.execute(
        `UPDATE integration_approvals SET approval_status='rejected',decided_by=?,decision_note=?,decided_at=?,updated_at=? WHERE id=?`,
        [approverId, note.slice(0, 1000), now, now, id]
      );
      await connection.execute(
        `UPDATE integration_tool_calls SET call_status='cancelled',error_code='INTEGRATION_APPROVAL_REJECTED',
         error_message=?,finished_at=?,updated_at=? WHERE id=?`,
        [note.slice(0, 1000) || "审批已拒绝", now, now, row.call_id]
      );
      await connection.execute(
        `INSERT INTO integration_call_events
         (call_id,team_id,actor_id,event_type,from_status,to_status,request_id,input_hash,output_hash,summary_json,created_at)
         VALUES (?,?,?,'approval_rejected','awaiting_approval','cancelled',?,?,'',?,?)`,
        [row.call_id, row.team_id, row.actor_id, row.request_id, row.input_hash, JSON.stringify({ approvalId: id, approverId }), now]
      );
      return row.call_id;
    });
    if (!outcome) throw Object.assign(new Error("审批不存在、无权访问或已处理"), { code: "INTEGRATION_APPROVAL_STATE_CONFLICT", status: 409 });
    return this.getApprovalDetail(id, scope);
  }

  async expireApprovals() {
    return transaction(this.controlPool, async (connection) => {
      const [rows] = await connection.query<Array<RowDataPacket & { id: string; call_id: string; owner_id: string; team_id: string }>>(
        "SELECT id,call_id,owner_id,team_id FROM integration_approvals WHERE approval_status='pending' AND expires_at<=NOW(3) LIMIT 500 FOR UPDATE"
      );
      if (!rows.length) return [];
      const ids = rows.map((row) => row.id);
      const callIds = rows.map((row) => row.call_id);
      const now = new Date().toISOString();
      await connection.query(`UPDATE integration_approvals SET approval_status='expired',updated_at=? WHERE id IN (${ids.map(() => "?").join(",")})`, [now, ...ids]);
      await connection.query(`UPDATE integration_tool_calls SET call_status='cancelled',error_code='INTEGRATION_APPROVAL_EXPIRED',error_message='审批已过期',finished_at=?,updated_at=? WHERE id IN (${callIds.map(() => "?").join(",")}) AND call_status='awaiting_approval'`, [now, now, ...callIds]);
      return rows.map((row) => ({ approvalId: row.id, ownerId: row.owner_id, teamId: row.team_id }));
    });
  }

  async recoverStaleRunningCalls(staleMinutes = 5) {
    const cutoff = new Date(Date.now() - Math.max(1, Math.min(60, staleMinutes)) * 60_000).toISOString();
    return transaction(this.controlPool, async (connection) => {
      const [rows] = await connection.query<Array<RowDataPacket & {
        id: string; team_id: string; actor_id: string; request_id: string; input_hash: string; risk_level: number;
      }>>(
        `SELECT id,team_id,actor_id,request_id,input_hash,risk_level FROM integration_tool_calls
         WHERE call_status='running' AND started_at<=? LIMIT 500 FOR UPDATE`,
        [cutoff]
      );
      if (!rows.length) return [];
      const now = new Date().toISOString();
      for (const row of rows) {
        const write = Number(row.risk_level) >= 3;
        const nextStatus = write ? "unknown_outcome" : "failed";
        const errorCode = write ? "INTEGRATION_UNKNOWN_OUTCOME" : "INTEGRATION_WORKER_INTERRUPTED";
        const message = write ? "Worker 中断，外部写入结果需要人工回查" : "Worker 中断，只读调用已停止";
        await connection.execute(
          `UPDATE integration_tool_calls SET call_status=?,error_code=?,error_message=?,finished_at=?,updated_at=?
           WHERE id=? AND call_status='running'`,
          [nextStatus, errorCode, message, now, now, row.id]
        );
        await connection.execute(
          `INSERT INTO integration_call_events
           (call_id,team_id,actor_id,event_type,from_status,to_status,request_id,input_hash,output_hash,summary_json,created_at)
           VALUES (?,?,?,'stale_call_recovered','running',?,?,?,'',?,?)`,
          [row.id, row.team_id, row.actor_id, nextStatus, row.request_id, row.input_hash,
            JSON.stringify({ errorCode }), now]
        );
      }
      return rows.map((row) => ({ callId: row.id, riskLevel: Number(row.risk_level) }));
    });
  }

  async cancelConnectionApprovals(connectionId: string, reason: string) {
    const now = new Date().toISOString();
    await transaction(this.controlPool, async (connection) => {
      await connection.execute(
        `UPDATE integration_tool_calls c JOIN integration_approvals a ON a.call_id=c.id
         SET c.call_status='cancelled',c.error_code='INTEGRATION_APPROVAL_CANCELLED',c.error_message=?,c.finished_at=?,c.updated_at=?
         WHERE a.connection_id=? AND a.approval_status='pending' AND c.call_status='awaiting_approval'`,
        [reason.slice(0, 500), now, now, connectionId]
      );
      await connection.execute(
        `UPDATE integration_approvals SET approval_status='cancelled',decision_note=?,updated_at=?
         WHERE connection_id=? AND approval_status='pending'`,
        [reason.slice(0, 500), now, connectionId]
      );
    });
  }

  async createReadCall(input: CreateReadCallInput) {
    await transaction(this.controlPool, async (connection) => {
      await this.assertCallCircuitAvailable(connection, input);
      await this.reserveDailyCallQuota(connection, input);
      await connection.execute(
        `INSERT INTO integration_artifacts
         (id,team_id,owner_id,connection_id,artifact_type,content_hash,encrypted_value,key_version,content_type,expires_at,created_at)
         VALUES (?,?,?,?, 'tool_input', ?,?,?, 'application/json', ?,?)`,
        [input.artifact.id, input.teamId, input.ownerId, input.connectionId, input.artifact.contentHash,
          input.artifact.encryptedValue, input.artifact.keyVersion, input.artifact.expiresAt, input.createdAt]
      );
      await connection.execute(
        `INSERT INTO integration_tool_calls
         (id,request_id,team_id,owner_id,actor_id,actor_auth_version,connection_id,tool_snapshot_id,approval_id,
          call_status,risk_level,input_hash,input_artifact_id,input_summary_json,output_hash,
          result_artifact_id,output_summary_json,idempotency_key_hash,external_receipt,evidence_json,
          error_code,error_message,attempt_count,created_at,queued_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,'','queued',?,?,?,?, '','',NULL,?,'',NULL,'','',0,?,?,?)`,
        [input.id, input.requestId, input.teamId, input.ownerId, input.actorId, input.actorAuthVersion, input.connectionId,
          input.toolSnapshotId, input.riskLevel, input.inputHash, input.artifact.id,
          JSON.stringify(input.inputSummary), input.idempotencyKeyHash, input.createdAt,
          input.createdAt, input.createdAt]
      );
      await connection.execute(
        `INSERT INTO integration_call_events
         (call_id,team_id,actor_id,event_type,from_status,to_status,request_id,input_hash,output_hash,summary_json,created_at)
         VALUES (?,?,?,'call_queued','created','queued',?,?,'',?,?)`,
        [input.id, input.teamId, input.actorId, input.requestId, input.inputHash,
          JSON.stringify({ riskLevel: input.riskLevel }), input.createdAt]
      );
      if (input.businessLink) {
        await connection.execute(
          `INSERT INTO integration_business_links
           (id,call_id,team_id,owner_id,object_type,object_id,operation,external_object_id,
            external_thread_id,writeback_status,next_action_at,metadata_json,last_error,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,'',?,'pending',?,?,'',?,?)`,
          [input.businessLink.id, input.id, input.teamId, input.ownerId, input.businessLink.objectType,
            input.businessLink.objectId, input.businessLink.operation, input.businessLink.externalThreadId,
            input.businessLink.nextActionAt, JSON.stringify(input.businessLink.metadata), input.createdAt, input.createdAt]
        );
      }
    });
    return this.getCall(input.id, { type: "personal", teamId: input.teamId, ownerId: input.ownerId });
  }

  async getCall(id: string, scope: DataScope) {
    const scoped = scopeSql(scope, "c");
    const [rows] = await this.controlPool.query<CallRow[]>(
      `SELECT c.* FROM integration_tool_calls c WHERE c.id=? AND ${scoped.sql} LIMIT 1`,
      [id, ...scoped.values]
    );
    return rows[0] ? mapCall(rows[0]) : null;
  }

  async getCallByRequestId(requestId: string, scope: DataScope) {
    const scoped = scopeSql(scope, "c");
    const [rows] = await this.controlPool.query<CallRow[]>(
      `SELECT c.* FROM integration_tool_calls c WHERE c.request_id=? AND ${scoped.sql} LIMIT 1`,
      [requestId, ...scoped.values]
    );
    return rows[0] ? mapCall(rows[0]) : null;
  }

  async listDailyUsage(scope: DataScope, usageDate: string) {
    const scoped = connectionAccessSql(scope, "c");
    const [rows] = await this.controlPool.query<Array<RowDataPacket & {
      usage_date: Date | string; team_id: string; connection_id: string; tool_snapshot_id: string;
      call_count: number; success_count: number; failure_count: number; input_bytes: number;
      output_bytes: number; estimated_cost: string | number; updated_at: Date;
    }>>(
      `SELECT u.* FROM integration_usage_daily u
       JOIN integration_connections c ON c.id=u.connection_id
       WHERE u.usage_date=? AND ${scoped.sql}
       ORDER BY u.call_count DESC,u.tool_snapshot_id ASC LIMIT 500`,
      [usageDate, ...scoped.values]
    );
    return rows.map((row) => ({
      usageDate: typeof row.usage_date === "string" ? row.usage_date.slice(0, 10) : row.usage_date.toISOString().slice(0, 10),
      teamId: row.team_id,
      connectionId: row.connection_id,
      toolSnapshotId: row.tool_snapshot_id,
      callCount: Number(row.call_count),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
      inputBytes: Number(row.input_bytes),
      outputBytes: Number(row.output_bytes),
      estimatedCost: Number(row.estimated_cost),
      updatedAt: iso(row.updated_at)
    }));
  }

  async reconcileCall(input: ReconcileCallInput, scope: DataScope) {
    const scoped = scopeSql(scope, "c");
    const outcome = await transaction(this.controlPool, async (connection) => {
      const [rows] = await connection.query<Array<RowDataPacket & {
        id: string; team_id: string; owner_id: string; connection_id: string; actor_id: string;
        request_id: string; input_hash: string; call_status: IntegrationToolCall["status"];
      }>>(
        `SELECT c.id,c.team_id,c.owner_id,c.connection_id,c.actor_id,c.request_id,c.input_hash,c.call_status
         FROM integration_tool_calls c WHERE c.id=? AND ${scoped.sql} FOR UPDATE`,
        [input.callId, ...scoped.values]
      );
      const row = rows[0];
      if (!row) return "not_found" as const;
      if (!new Set(["unknown_outcome", "reconciliation_required"]).has(row.call_status)) return "state" as const;
      const now = new Date().toISOString();
      if (row.call_status === "unknown_outcome") {
        await connection.execute(
          "UPDATE integration_tool_calls SET call_status='reconciliation_required',updated_at=? WHERE id=? AND call_status='unknown_outcome'",
          [now, input.callId]
        );
        await connection.execute(
          `INSERT INTO integration_call_events
           (call_id,team_id,actor_id,event_type,from_status,to_status,request_id,input_hash,output_hash,summary_json,created_at)
           VALUES (?,?,?,'reconciliation_started','unknown_outcome','reconciliation_required',?,?,'',?,?)`,
          [input.callId, row.team_id, input.actorId, row.request_id, row.input_hash, JSON.stringify({ note: input.note.slice(0, 500) }), now]
        );
      }
      if (input.outcome === "succeeded") {
        if (!input.artifact) throw new Error("对账成功结果缺少证据 Artifact");
        await connection.execute(
          `INSERT INTO integration_artifacts
           (id,team_id,owner_id,connection_id,artifact_type,content_hash,encrypted_value,key_version,content_type,expires_at,created_at)
           VALUES (?,?,?,?, 'tool_result', ?,?,?, 'application/json', ?,?)`,
          [input.artifact.id, row.team_id, row.owner_id, row.connection_id, input.artifact.contentHash,
            input.artifact.encryptedValue, input.artifact.keyVersion, input.artifact.expiresAt, now]
        );
        await connection.execute(
          `UPDATE integration_tool_calls SET call_status='succeeded',output_hash=?,result_artifact_id=?,
           output_summary_json=?,external_receipt=?,evidence_json=?,error_code='',error_message='',finished_at=?,updated_at=?
           WHERE id=? AND call_status='reconciliation_required'`,
          [input.outputHash, input.artifact.id, JSON.stringify({ reconciled: true }), input.externalReceipt,
            JSON.stringify(input.evidence), now, now, input.callId]
        );
      } else {
        await connection.execute(
          `UPDATE integration_tool_calls SET call_status='failed',error_code='INTEGRATION_RECONCILED_NOT_EXECUTED',
           error_message=?,evidence_json=?,finished_at=?,updated_at=?
           WHERE id=? AND call_status='reconciliation_required'`,
          [input.note.slice(0, 1000) || "人工回查确认未执行", JSON.stringify(input.evidence), now, now, input.callId]
        );
      }
      await connection.execute(
        `INSERT INTO integration_call_events
         (call_id,team_id,actor_id,event_type,from_status,to_status,request_id,input_hash,output_hash,summary_json,created_at)
         VALUES (?,?,?,'reconciliation_completed','reconciliation_required',?,?,?, ?,?,?)`,
        [input.callId, row.team_id, input.actorId, input.outcome, row.request_id, row.input_hash,
          input.outcome === "succeeded" ? input.outputHash : "", JSON.stringify(input.evidence), now]
      );
      return "updated" as const;
    });
    if (outcome === "not_found") throw integrationNotFound("调用不存在或无权访问");
    if (outcome === "state") throw Object.assign(new Error("只有结果未知的调用可以对账"), { code: "INTEGRATION_RECONCILIATION_STATE_CONFLICT", status: 409 });
    return this.getCall(input.callId, scope);
  }

  async getCallResultArtifact(id: string, scope: DataScope) {
    const scoped = scopeSql(scope, "c");
    const [rows] = await this.controlPool.query<Array<RowDataPacket & {
      encrypted_value: string;
      team_id: string;
      owner_id: string;
      connection_id: string;
    }>>(
      `SELECT a.encrypted_value,c.team_id,c.owner_id,c.connection_id
       FROM integration_tool_calls c
       JOIN integration_artifacts a ON a.id=c.result_artifact_id AND a.artifact_type='tool_result'
       WHERE c.id=? AND c.call_status='succeeded' AND ${scoped.sql} LIMIT 1`,
      [id, ...scoped.values]
    );
    const row = rows[0];
    return row ? {
      encryptedValue: row.encrypted_value,
      teamId: row.team_id,
      ownerId: row.owner_id,
      connectionId: row.connection_id
    } : null;
  }

  async listCalls(scope: DataScope, limit = 50, offset = 0) {
    const scoped = scopeSql(scope, "c");
    const [rows] = await this.controlPool.query<CallRow[]>(
      `SELECT c.* FROM integration_tool_calls c WHERE ${scoped.sql}
       ORDER BY c.created_at DESC,c.id DESC LIMIT ? OFFSET ?`,
      [...scoped.values, Math.max(1, Math.min(100, limit)), Math.max(0, offset)]
    );
    return rows.map(mapCall);
  }

  async countActiveTools(connectionId: string) {
    const [rows] = await this.controlPool.query<Array<RowDataPacket & { count: number }>>(
      "SELECT COUNT(*) AS count FROM integration_tool_snapshots WHERE connection_id=? AND tool_status='active'",
      [connectionId]
    );
    return Number(rows[0]?.count || 0);
  }

  async countPendingReviewTools(connectionId: string) {
    const [rows] = await this.controlPool.query<Array<RowDataPacket & { count: number }>>(
      "SELECT COUNT(*) AS count FROM integration_tool_snapshots WHERE connection_id=? AND tool_status='pending_review'",
      [connectionId]
    );
    return Number(rows[0]?.count || 0);
  }

  async connectionStatuses(connectionId: string) {
    const [rows] = await this.controlPool.query<Array<RowDataPacket & { connection_status: ConnectionStatus }>>(
      "SELECT connection_status FROM integration_connections WHERE id=? LIMIT 1",
      [connectionId]
    );
    return rows[0]?.connection_status || null;
  }
}
