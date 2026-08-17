import { randomUUID } from "node:crypto";
import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { validateConnectorManifest, type ActiveConnectorManifest } from "@goodjob/integration-connector-sdk";
import type { DiscoveredToolSnapshot } from "./mcp/tool-schema.js";
import type { OAuthTransactionContext } from "./oauth/oauth-types.js";

export type WorkerConnectorManifest = ActiveConnectorManifest;

export interface WorkerAuthTransaction extends WorkerConnectionContext {
  transactionId: string;
  transactionStatus: string;
  encryptedContext: string;
  redirectUri: string;
  issuer: string;
  resourceUri: string;
  expiresAt: string;
}

export interface WorkerCredential extends WorkerConnectionContext {
  credentialId: string;
  credentialType: "oauth_token" | "api_token";
  encryptedValue: string;
  tokenFingerprint: string;
  expiresAt: string;
}

export interface WorkerConnectionContext {
  connectionId: string;
  connectorId: string;
  connectorCode?: string;
  teamId: string;
  ownerId: string;
  status: string;
  webhookPublicId?: string;
  manifest: WorkerConnectorManifest;
}

export interface WorkerWebhookSubscription {
  id: string;
  connectionId: string;
  teamId: string;
  provider: string;
  remoteSubscriptionId: string;
  resource: string;
  changeTypes: string;
  clientStateHash: string;
  status: string;
  expiresAt: string;
}

export interface ClaimedToolCall extends WorkerConnectionContext {
  callId: string;
  requestId: string;
  actorId: string;
  actorRole: string;
  actorAuthVersion: number;
  riskLevel: number;
  toolSnapshotId: string;
  remoteName: string;
  schemaHash: string;
  inputArtifactId: string;
  encryptedInput: string;
  reviewJson: string;
  createdAt: string;
}

export interface ClaimedWebhookEvent {
  eventId: string;
  connectionId: string;
  connectorCode: string;
  teamId: string;
  ownerId: string;
  eventType: string;
  externalEventId: string;
  payloadHash: string;
  artifactId: string;
  encryptedPayload: string;
  attemptCount: number;
  leaseId: string;
}

function parseManifest(value: unknown): WorkerConnectorManifest {
  const manifest = typeof value === "string" ? JSON.parse(value) : value;
  const validated = validateConnectorManifest(manifest, {
    environment: process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development"
  });
  if (validated.stage !== "available" || !validated.driver || !validated.endpoint || !validated.authentication) {
    throw new Error("INTEGRATION_CONNECTOR_MANIFEST_INVALID: 运行连接器不能使用 planned Manifest");
  }
  return validated as ActiveConnectorManifest;
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

export class IntegrationWorkerRepository {
  constructor(readonly pool: Pool) {}

  static create(databaseUrl: string) {
    return new IntegrationWorkerRepository(mysql.createPool({ uri: databaseUrl, connectionLimit: 6 }));
  }

  async close() { await this.pool.end(); }

  async claimWebhookEvent(eventId: string): Promise<ClaimedWebhookEvent> {
    return transaction(this.pool, async (connection) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const legacyStaleCutoff = new Date(now.getTime() - 120_000).toISOString();
      const leaseId = `iwl_${randomUUID()}`;
      const leaseExpiresAt = new Date(now.getTime() + 120_000).toISOString();
      const [rows] = await connection.query<Array<RowDataPacket & {
        event_id: string; connection_id: string; connector_code: string; team_id: string; owner_id: string;
        event_type: string; external_event_id: string; payload_hash: string; artifact_id: string;
        encrypted_payload: string; attempt_count: number; event_status: string; connection_status: string;
        processing_lease_expires_at: Date | null; updated_at: Date;
      }>>(
        `SELECT e.id AS event_id,e.connection_id,d.code AS connector_code,e.team_id,c.owner_id,
         e.event_type,e.external_event_id,e.payload_hash,e.artifact_id,a.encrypted_value AS encrypted_payload,
         e.attempt_count,e.event_status,e.processing_lease_expires_at,e.updated_at,c.connection_status
         FROM integration_events e
         JOIN integration_connections c ON c.id=e.connection_id AND c.team_id=e.team_id
         JOIN integration_connectors d ON d.id=c.connector_id AND d.connector_status='active'
         JOIN integration_artifacts a ON a.id=e.artifact_id AND a.connection_id=e.connection_id
          AND a.team_id=e.team_id AND a.artifact_type='webhook_raw'
         WHERE e.id=? LIMIT 1 FOR UPDATE`,
        [eventId]
      );
      const row = rows[0];
      if (!row) throw new Error("INTEGRATION_EVENT_NOT_FOUND: Webhook 事件不存在");
      if (!new Set(["active", "degraded"]).has(row.connection_status)) {
        throw new Error("INTEGRATION_CONNECTION_NOT_ACTIVE: Webhook 连接当前不可用");
      }
      const expiredLease = row.event_status === "processing" && (
        (row.processing_lease_expires_at && row.processing_lease_expires_at.getTime() <= now.getTime())
        || (!row.processing_lease_expires_at && row.updated_at.getTime() <= new Date(legacyStaleCutoff).getTime())
      );
      if (!new Set(["queued", "replayed"]).has(row.event_status) && !expiredLease) {
        throw new Error("INTEGRATION_EVENT_STATE_CONFLICT: Webhook 事件不能重复领取");
      }
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_events SET event_status='processing',attempt_count=attempt_count+1,
         next_attempt_at=NULL,last_error_code='',last_error_message='',processing_lease_id=?,
         processing_lease_expires_at=?,updated_at=?
         WHERE id=? AND (event_status IN ('queued','replayed') OR
          (event_status='processing' AND (processing_lease_expires_at<=? OR
           (processing_lease_expires_at IS NULL AND updated_at<=?))))`,
        [leaseId, leaseExpiresAt, nowIso, eventId, nowIso, legacyStaleCutoff]
      );
      if (updated.affectedRows !== 1) throw new Error("INTEGRATION_EVENT_STATE_CONFLICT: Webhook 事件领取冲突");
      return {
        eventId: row.event_id,
        connectionId: row.connection_id,
        connectorCode: row.connector_code,
        teamId: row.team_id,
        ownerId: row.owner_id,
        eventType: row.event_type,
        externalEventId: row.external_event_id,
        payloadHash: row.payload_hash,
        artifactId: row.artifact_id,
        encryptedPayload: row.encrypted_payload,
        attemptCount: Number(row.attempt_count) + 1,
        leaseId
      };
    });
  }

  async completeWebhookEvent(
    eventId: string,
    leaseId: string,
    result: Record<string, unknown>,
    output?: {
      writebackStatus: "not_applicable" | "pending";
      artifact?: {
        id: string;
        teamId: string;
        ownerId: string;
        connectionId: string;
        encryptedValue: string;
        contentHash: string;
        expiresAt: string;
      };
    }
  ) {
    const now = new Date().toISOString();
    await transaction(this.pool, async (connection) => {
      if (output?.artifact) {
        const artifact = output.artifact;
        await connection.execute(
          `INSERT INTO integration_artifacts
           (id,team_id,owner_id,connection_id,artifact_type,content_hash,encrypted_value,key_version,
            content_type,expires_at,created_at)
           VALUES (?,?,?,?, 'webhook_result', ?,?, 'v1', 'application/json', ?,?)`,
          [artifact.id, artifact.teamId, artifact.ownerId, artifact.connectionId,
            artifact.contentHash, artifact.encryptedValue, artifact.expiresAt, now]
        );
      }
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_events SET event_status='processed',result_json=?,result_artifact_id=?,
         writeback_status=?,last_error_code='',last_error_message='',processing_lease_id='',
         processing_lease_expires_at=NULL,processed_at=?,updated_at=?
         WHERE id=? AND event_status='processing' AND processing_lease_id=?`,
        [JSON.stringify(result), output?.artifact?.id || "", output?.writebackStatus || "not_applicable",
          now, now, eventId, leaseId]
      );
      if (updated.affectedRows !== 1) throw new Error("INTEGRATION_EVENT_STATE_CONFLICT: Webhook 完成状态冲突");
    });
  }

  async failWebhookEvent(eventId: string, leaseId: string, cause: unknown, deadLetter: boolean) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    const matched = raw.match(/^(INTEGRATION_[A-Z0-9_]+):\s*(.*)$/u);
    const code = matched?.[1] || "INTEGRATION_WEBHOOK_PROCESSING_FAILED";
    const message = (matched?.[2] || raw || "Webhook 事件处理失败").slice(0, 1_000);
    const now = new Date().toISOString();
    const nextAttemptAt = deadLetter ? null : new Date(Date.now() + 30_000).toISOString();
    await this.pool.execute(
      `UPDATE integration_events SET event_status=?,last_error_code=?,last_error_message=?,
       next_attempt_at=?,processing_lease_id='',processing_lease_expires_at=NULL,processed_at=?,updated_at=?
       WHERE id=? AND event_status='processing' AND processing_lease_id=?`,
      [deadLetter ? "dead_letter" : "queued", code, message, nextAttemptAt, deadLetter ? now : null, now, eventId, leaseId]
    );
  }

  async loadConnectionContext(connectionId: string): Promise<WorkerConnectionContext> {
    const [rows] = await this.pool.query<Array<RowDataPacket & {
      connection_id: string; connector_id: string; connector_code: string; team_id: string; owner_id: string;
      connection_status: string; webhook_public_id: string; connector_status: string; manifest_json: unknown;
    }>>(
      `SELECT c.id AS connection_id,c.connector_id,c.team_id,c.owner_id,c.connection_status,
       c.webhook_public_id,d.code AS connector_code,d.connector_status,d.manifest_json
       FROM integration_connections c JOIN integration_connectors d ON d.id=c.connector_id
       WHERE c.id=? LIMIT 1`,
      [connectionId]
    );
    const row = rows[0];
    if (!row || row.connector_status !== "active") throw new Error("INTEGRATION_CONNECTION_NOT_FOUND: 连接不存在或连接器未启用");
    return {
      connectionId: row.connection_id,
      connectorId: row.connector_id,
      connectorCode: row.connector_code,
      teamId: row.team_id,
      ownerId: row.owner_id,
      status: row.connection_status,
      webhookPublicId: row.webhook_public_id,
      manifest: parseManifest(row.manifest_json)
    };
  }

  async listHealthCheckConnectionIds(intervalMinutes = 15) {
    const cutoff = new Date(Date.now() - Math.max(1, Math.min(120, intervalMinutes)) * 60_000).toISOString();
    const [rows] = await this.pool.query<Array<RowDataPacket & { id: string }>>(
      `SELECT c.id FROM integration_connections c
       JOIN integration_connectors d ON d.id=c.connector_id AND d.connector_status='active'
       LEFT JOIN integration_circuit_states s ON s.subject_type='connection' AND s.subject_id=c.id
       WHERE c.connection_status IN ('active','degraded')
         AND (c.last_health_at IS NULL OR c.last_health_at<=?
           OR (s.circuit_state='open' AND (s.open_until IS NULL OR s.open_until<=NOW(3))))
       ORDER BY c.last_health_at ASC LIMIT 500`,
      [cutoff]
    );
    return rows.map((row) => row.id);
  }

  async recordHealthSuccess(connectionId: string, latencyMs: number) {
    const now = new Date().toISOString();
    return transaction(this.pool, async (connection) => {
      const [connectionRows] = await connection.query<Array<RowDataPacket & { team_id: string; connection_status: string }>>(
        "SELECT team_id,connection_status FROM integration_connections WHERE id=? LIMIT 1 FOR UPDATE",
        [connectionId]
      );
      const current = connectionRows[0];
      if (!current) throw new Error("INTEGRATION_CONNECTION_NOT_FOUND: 健康检查连接不存在");
      await connection.execute(
        `INSERT IGNORE INTO integration_circuit_states
         (subject_type,subject_id,team_id,connection_id,circuit_state,updated_at)
         VALUES ('connection',?,?,?,'closed',?)`,
        [connectionId, current.team_id, connectionId, now]
      );
      const [guards] = await connection.query<Array<RowDataPacket & {
        circuit_state: "closed" | "open" | "half_open"; consecutive_failures: number; consecutive_successes: number;
      }>>(
        `SELECT circuit_state,consecutive_failures,consecutive_successes FROM integration_circuit_states
         WHERE subject_type='connection' AND subject_id=? LIMIT 1 FOR UPDATE`,
        [connectionId]
      );
      const guard = guards[0]!;
      const recovering = current.connection_status === "degraded" || guard.circuit_state !== "closed";
      const successes = recovering ? Number(guard.consecutive_successes || 0) + 1 : 2;
      const recovered = !recovering || successes >= 2;
      await connection.execute(
        `UPDATE integration_circuit_states SET circuit_state=?,consecutive_failures=0,
         consecutive_successes=?,opened_at=NULL,open_until=NULL,last_checked_at=?,last_latency_ms=?,
         last_error_code='',last_error_message='',updated_at=?
         WHERE subject_type='connection' AND subject_id=?`,
        [recovered ? "closed" : "half_open", successes, now, Math.max(0, Math.round(latencyMs)), now, connectionId]
      );
      await connection.execute(
        `UPDATE integration_connections SET connection_status=IF(?='closed' AND connection_status='degraded','active',connection_status),
         last_health_at=?,last_health_latency_ms=?,last_error_code=IF(?='closed','',last_error_code),
         last_error_message=IF(?='closed','',last_error_message),warning_message=IF(?='closed','',CONCAT('健康检查恢复中（',?,'/2）')),
         updated_at=?,revision_no=revision_no+1 WHERE id=? AND connection_status IN ('active','degraded')`,
        [recovered ? "closed" : "half_open", now, Math.max(0, Math.round(latencyMs)),
          recovered ? "closed" : "half_open", recovered ? "closed" : "half_open", recovered ? "closed" : "half_open",
          successes, now, connectionId]
      );
      return { connectionId, status: recovered ? "active" : "degraded", consecutiveSuccesses: successes };
    });
  }

  async recordHealthFailure(connectionId: string, cause: unknown, latencyMs = 0) {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const raw = cause instanceof Error ? cause.message : String(cause);
    const matched = raw.match(/^(INTEGRATION_[A-Z0-9_]+):\s*(.*)$/u);
    const code = matched?.[1] || "INTEGRATION_REMOTE_UNAVAILABLE";
    const message = (matched?.[2] || raw || "健康检查失败").slice(0, 500);
    return transaction(this.pool, async (connection) => {
      const [connectionRows] = await connection.query<Array<RowDataPacket & { team_id: string; connection_status: string }>>(
        "SELECT team_id,connection_status FROM integration_connections WHERE id=? LIMIT 1 FOR UPDATE",
        [connectionId]
      );
      const current = connectionRows[0];
      if (!current) throw new Error("INTEGRATION_CONNECTION_NOT_FOUND: 健康检查连接不存在");
      await connection.execute(
        `INSERT IGNORE INTO integration_circuit_states
         (subject_type,subject_id,team_id,connection_id,circuit_state,updated_at)
         VALUES ('connection',?,?,?,'closed',?)`,
        [connectionId, current.team_id, connectionId, now]
      );
      const [guards] = await connection.query<Array<RowDataPacket & {
        circuit_state: "closed" | "open" | "half_open"; consecutive_failures: number;
      }>>(
        `SELECT circuit_state,consecutive_failures FROM integration_circuit_states
         WHERE subject_type='connection' AND subject_id=? LIMIT 1 FOR UPDATE`,
        [connectionId]
      );
      const guard = guards[0]!;
      const failures = Number(guard.consecutive_failures || 0) + 1;
      const immediateReauth = code === "INTEGRATION_REAUTH_REQUIRED";
      const open = immediateReauth || guard.circuit_state === "half_open" || failures >= 3;
      const openUntil = open ? new Date(nowDate.getTime() + (immediateReauth ? 60 * 60_000 : 5 * 60_000)).toISOString() : null;
      const nextState = open ? "open" : "closed";
      await connection.execute(
        `UPDATE integration_circuit_states SET circuit_state=?,consecutive_failures=?,consecutive_successes=0,
         opened_at=IF(?='open',COALESCE(opened_at,?),NULL),open_until=?,last_checked_at=?,last_latency_ms=?,
         last_error_code=?,last_error_message=?,updated_at=? WHERE subject_type='connection' AND subject_id=?`,
        [nextState, failures, nextState, now, openUntil, now, Math.max(0, Math.round(latencyMs)), code, message, now, connectionId]
      );
      const connectionStatus = immediateReauth ? "reauthorization_required" : current.connection_status === "paused" ? "paused" : open ? "degraded" : current.connection_status;
      await connection.execute(
        `UPDATE integration_connections SET connection_status=?,last_health_at=?,last_health_latency_ms=?,
         last_error_code=?,last_error_message=?,warning_message=?,updated_at=?,revision_no=revision_no+1
         WHERE id=? AND connection_status IN ('active','degraded','reauthorization_required')`,
        [connectionStatus, now, Math.max(0, Math.round(latencyMs)), code, message,
          open ? `连续 ${failures} 次健康检查失败，已暂时阻止新调用` : `健康检查失败（${failures}/3）`, now, connectionId]
      );
      return { connectionId, status: connectionStatus, consecutiveFailures: failures, circuitState: nextState };
    });
  }

  async withWebhookSubscriptionLease<T>(connectionId: string, work: () => Promise<T>) {
    const connection = await this.pool.getConnection();
    const lockName = `gj:webhook-sub:${connectionId}`.slice(0, 64);
    try {
      const [rows] = await connection.query<Array<RowDataPacket & { acquired: number }>>(
        "SELECT GET_LOCK(?, 0) AS acquired",
        [lockName]
      );
      if (Number(rows[0]?.acquired || 0) !== 1) return { acquired: false as const };
      try {
        return { acquired: true as const, value: await work() };
      } finally {
        await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
      }
    } finally {
      connection.release();
    }
  }

  async loadWebhookSubscription(connectionId: string, resource: string): Promise<WorkerWebhookSubscription | null> {
    const [rows] = await this.pool.query<Array<RowDataPacket & {
      id: string; connection_id: string; team_id: string; provider: string; remote_subscription_id: string;
      resource: string; change_types: string; client_state_hash: string; subscription_status: string;
      expires_at: Date | null;
    }>>(
      `SELECT * FROM integration_webhook_subscriptions
       WHERE connection_id=? AND resource=? LIMIT 1`,
      [connectionId, resource]
    );
    const row = rows[0];
    return row ? {
      id: row.id,
      connectionId: row.connection_id,
      teamId: row.team_id,
      provider: row.provider,
      remoteSubscriptionId: row.remote_subscription_id,
      resource: row.resource,
      changeTypes: row.change_types,
      clientStateHash: row.client_state_hash,
      status: row.subscription_status,
      expiresAt: row.expires_at?.toISOString() || ""
    } : null;
  }

  async upsertWebhookSubscription(input: {
    connectionId: string;
    teamId: string;
    provider: string;
    remoteSubscriptionId: string;
    resource: string;
    changeTypes: string;
    clientStateHash: string;
    expiresAt: string;
  }) {
    const now = new Date().toISOString();
    await this.pool.execute(
      `INSERT INTO integration_webhook_subscriptions
       (id,connection_id,team_id,provider,remote_subscription_id,resource,change_types,
        client_state_hash,subscription_status,expires_at,last_error_code,last_error_message,
        created_at,updated_at,deleted_at)
       VALUES (?,?,?,?,?,?,?,?,'active',?,'','',?,?,NULL)
       ON DUPLICATE KEY UPDATE provider=VALUES(provider),remote_subscription_id=VALUES(remote_subscription_id),
        change_types=VALUES(change_types),client_state_hash=VALUES(client_state_hash),
        subscription_status='active',expires_at=VALUES(expires_at),last_error_code='',
        last_error_message='',updated_at=VALUES(updated_at),deleted_at=NULL`,
      [`iws_${randomUUID()}`, input.connectionId, input.teamId, input.provider,
        input.remoteSubscriptionId, input.resource, input.changeTypes, input.clientStateHash,
        input.expiresAt, now, now]
    );
    await this.pool.execute(
      `UPDATE integration_connections SET connection_status='active',last_error_code='',
       last_error_message='',updated_at=?,revision_no=revision_no+1
       WHERE id=? AND connection_status='degraded'
       AND last_error_code='INTEGRATION_WEBHOOK_SUBSCRIPTION_FAILED'`,
      [now, input.connectionId]
    );
    return this.loadWebhookSubscription(input.connectionId, input.resource);
  }

  async recordWebhookSubscriptionFailure(input: {
    connectionId: string;
    teamId: string;
    provider: string;
    resource: string;
    cause: unknown;
  }) {
    const raw = input.cause instanceof Error ? input.cause.message : String(input.cause);
    const matched = raw.match(/^(INTEGRATION_[A-Z0-9_]+):\s*(.*)$/u);
    const code = matched?.[1] || "INTEGRATION_WEBHOOK_SUBSCRIPTION_FAILED";
    const message = (matched?.[2] || raw || "Webhook 订阅失败").slice(0, 1_000);
    const now = new Date().toISOString();
    await this.pool.execute(
      `INSERT INTO integration_webhook_subscriptions
       (id,connection_id,team_id,provider,remote_subscription_id,resource,change_types,
        client_state_hash,subscription_status,expires_at,last_error_code,last_error_message,
        created_at,updated_at,deleted_at)
       VALUES (?,?,?,?, '',?,'created','','failed',NULL,?,?,?, ?,NULL)
       ON DUPLICATE KEY UPDATE subscription_status='failed',expires_at=NULL,
        last_error_code=VALUES(last_error_code),last_error_message=VALUES(last_error_message),
        updated_at=VALUES(updated_at),deleted_at=NULL`,
      [`iws_${randomUUID()}`, input.connectionId, input.teamId, input.provider,
        input.resource, code, message, now, now]
    );
    await this.pool.execute(
      `UPDATE integration_connections SET connection_status=IF(connection_status='active','degraded',connection_status),
       last_error_code='INTEGRATION_WEBHOOK_SUBSCRIPTION_FAILED',last_error_message=?,
       updated_at=?,revision_no=revision_no+1 WHERE id=? AND connection_status IN ('active','degraded')`,
      [message.slice(0, 500), now, input.connectionId]
    );
  }

  async markWebhookSubscriptionDeleted(connectionId: string, resource: string) {
    const now = new Date().toISOString();
    await this.pool.execute(
      `UPDATE integration_webhook_subscriptions SET subscription_status='deleted',expires_at=NULL,
       last_error_code='',last_error_message='',updated_at=?,deleted_at=?
       WHERE connection_id=? AND resource=?`,
      [now, now, connectionId, resource]
    );
  }

  async markWebhookSubscriptionFailed(connectionId: string, resource: string, cause: unknown) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    const matched = raw.match(/^(INTEGRATION_[A-Z0-9_]+):\s*(.*)$/u);
    const now = new Date().toISOString();
    await this.pool.execute(
      `UPDATE integration_webhook_subscriptions SET subscription_status='failed',last_error_code=?,
       last_error_message=?,updated_at=? WHERE connection_id=? AND resource=?`,
      [matched?.[1] || "INTEGRATION_WEBHOOK_SUBSCRIPTION_FAILED",
        (matched?.[2] || raw || "Webhook 订阅失败").slice(0, 1_000), now, connectionId, resource]
    );
  }

  async listWebhookSubscriptionSyncConnectionIds(hours = 24) {
    const threshold = new Date(Date.now() + Math.max(1, Math.min(72, hours)) * 3_600_000).toISOString();
    const [rows] = await this.pool.query<Array<RowDataPacket & { id: string }>>(
      `SELECT c.id FROM integration_connections c
       JOIN integration_connectors d ON d.id=c.connector_id AND d.connector_status='active'
       LEFT JOIN integration_webhook_subscriptions s ON s.connection_id=c.id
        AND s.resource='me/mailFolders(''Inbox'')/messages'
       WHERE c.connection_status IN ('active','degraded')
       AND JSON_UNQUOTE(JSON_EXTRACT(d.manifest_json,'$.driver'))='microsoft_graph'
       AND (s.id IS NULL OR s.subscription_status<>'active' OR s.expires_at IS NULL OR s.expires_at<=?)
       ORDER BY COALESCE(s.expires_at,'1970-01-01') ASC LIMIT 500`,
      [threshold]
    );
    return rows.map((row) => row.id);
  }

  async loadAuthTransaction(transactionId: string): Promise<WorkerAuthTransaction> {
    const [rows] = await this.pool.query<Array<RowDataPacket & {
      transaction_id: string; transaction_status: string; encrypted_pkce_verifier: string;
      redirect_uri: string; issuer: string; resource_uri: string; expires_at: Date;
      connection_id: string; connector_id: string; team_id: string; owner_id: string;
      connection_status: string; connector_status: string; manifest_json: unknown;
    }>>(
      `SELECT a.id AS transaction_id,a.transaction_status,a.encrypted_pkce_verifier,a.redirect_uri,
       a.issuer,a.resource_uri,a.expires_at,c.id AS connection_id,c.connector_id,c.team_id,c.owner_id,
       c.connection_status,d.connector_status,d.manifest_json
       FROM integration_auth_transactions a
       JOIN integration_connections c ON c.id=a.connection_id
       JOIN integration_connectors d ON d.id=c.connector_id
       WHERE a.id=? LIMIT 1`,
      [transactionId]
    );
    const row = rows[0];
    if (!row || row.connector_status !== "active") throw new Error("INTEGRATION_AUTH_TRANSACTION_NOT_FOUND: 授权事务不存在");
    return {
      transactionId: row.transaction_id,
      transactionStatus: row.transaction_status,
      encryptedContext: row.encrypted_pkce_verifier,
      redirectUri: row.redirect_uri,
      issuer: row.issuer,
      resourceUri: row.resource_uri,
      expiresAt: row.expires_at.toISOString(),
      connectionId: row.connection_id,
      connectorId: row.connector_id,
      teamId: row.team_id,
      ownerId: row.owner_id,
      status: row.connection_status,
      manifest: parseManifest(row.manifest_json)
    };
  }

  async markAuthorizationReady(input: {
    transaction: WorkerAuthTransaction;
    encryptedContext: string;
    issuer: string;
    resourceUri: string;
  }) {
    const now = new Date().toISOString();
    const [updated] = await this.pool.execute<ResultSetHeader>(
      `UPDATE integration_auth_transactions SET transaction_status='authorize_url_ready',
       encrypted_pkce_verifier=?,issuer=?,resource_uri=?,updated_at=?
       WHERE id=? AND transaction_status='created' AND expires_at>?`,
      [input.encryptedContext, input.issuer, input.resourceUri, now, input.transaction.transactionId, now]
    );
    if (updated.affectedRows !== 1) throw new Error("INTEGRATION_OAUTH_STATE_INVALID: 授权事务已过期或状态冲突");
  }

  async completeAuthorization(input: {
    transaction: WorkerAuthTransaction;
    encryptedTransactionContext: string;
    encryptedCredential: string;
    tokenFingerprint: string;
    expiresAt: string | null;
    accountSummary: Record<string, unknown>;
  }) {
    const now = new Date().toISOString();
    return transaction(this.pool, async (connection) => {
      const [tx] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_auth_transactions SET transaction_status='completed',encrypted_pkce_verifier=?,updated_at=?
         WHERE id=? AND transaction_status='callback_received' AND expires_at>?`,
        [input.encryptedTransactionContext, now, input.transaction.transactionId, now]
      );
      if (tx.affectedRows !== 1) throw new Error("INTEGRATION_OAUTH_STATE_INVALID: 授权事务不能完成");
      await connection.execute(
        `INSERT INTO integration_credentials
         (id,connection_id,team_id,credential_type,encrypted_value,key_version,token_fingerprint,
          expires_at,refreshed_at,revoked_at,created_at,updated_at)
         VALUES (?,?,?,'oauth_token',?,'v1',?,?,?,NULL,?,?)
         ON DUPLICATE KEY UPDATE encrypted_value=VALUES(encrypted_value),key_version='v1',
          token_fingerprint=VALUES(token_fingerprint),expires_at=VALUES(expires_at),
          refreshed_at=VALUES(refreshed_at),revoked_at=NULL,updated_at=VALUES(updated_at)`,
        [`icr_${randomUUID()}`, input.transaction.connectionId, input.transaction.teamId,
          input.encryptedCredential, input.tokenFingerprint, input.expiresAt, now, now, now]
      );
      const [connectionUpdate] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_connections SET connection_status='pending_confirmation',server_info_json=?,
         last_error_code='',last_error_message='',updated_at=?,revision_no=revision_no+1
         WHERE id=? AND connection_status='authorizing'`,
        [JSON.stringify(input.accountSummary), now, input.transaction.connectionId]
      );
      if (connectionUpdate.affectedRows !== 1) throw new Error("INTEGRATION_CONNECTION_STATE_CONFLICT: 连接不能进入待确认状态");
    });
  }

  async markAuthorizationFailed(transactionId: string, error: unknown) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message.slice(0, 500) : "OAuth 授权失败";
    await transaction(this.pool, async (connection) => {
      await connection.execute(
        `UPDATE integration_auth_transactions SET transaction_status='failed',updated_at=?
         WHERE id=? AND transaction_status IN ('created','authorize_url_ready','callback_received')`,
        [now, transactionId]
      );
      await connection.execute(
        `UPDATE integration_connections c JOIN integration_auth_transactions a ON a.connection_id=c.id
         SET c.connection_status='failed',c.last_error_code='INTEGRATION_OAUTH_FAILED',
         c.last_error_message=?,c.updated_at=?,c.revision_no=c.revision_no+1
         WHERE a.id=? AND c.connection_status='authorizing'`,
        [message, now, transactionId]
      );
    });
  }

  async loadCredentialByConnection(connectionId: string): Promise<WorkerCredential | null> {
    const [rows] = await this.pool.query<Array<RowDataPacket & {
      credential_id: string; credential_type: "oauth_token" | "api_token"; encrypted_value: string; token_fingerprint: string; expires_at: Date | null;
      connection_id: string; connector_id: string; team_id: string; owner_id: string;
      connection_status: string; connector_status: string; manifest_json: unknown;
    }>>(
      `SELECT r.id AS credential_id,r.credential_type,r.encrypted_value,r.token_fingerprint,r.expires_at,
       c.id AS connection_id,c.connector_id,c.team_id,c.owner_id,c.connection_status,
       d.connector_status,d.manifest_json
       FROM integration_credentials r
       JOIN integration_connections c ON c.id=r.connection_id
       JOIN integration_connectors d ON d.id=c.connector_id
       WHERE r.connection_id=? AND r.credential_type IN ('oauth_token','api_token') AND r.revoked_at IS NULL
       ORDER BY r.credential_type='oauth_token' DESC LIMIT 1`,
      [connectionId]
    );
    const row = rows[0];
    if (!row || row.connector_status !== "active") return null;
    return {
      credentialId: row.credential_id,
      credentialType: row.credential_type,
      encryptedValue: row.encrypted_value,
      tokenFingerprint: row.token_fingerprint,
      expiresAt: row.expires_at?.toISOString() || "",
      connectionId: row.connection_id,
      connectorId: row.connector_id,
      teamId: row.team_id,
      ownerId: row.owner_id,
      status: row.connection_status,
      manifest: parseManifest(row.manifest_json)
    };
  }

  async loadCredentialById(credentialId: string) {
    const [rows] = await this.pool.query<Array<RowDataPacket & { connection_id: string }>>(
      "SELECT connection_id FROM integration_credentials WHERE id=? AND revoked_at IS NULL LIMIT 1",
      [credentialId]
    );
    return rows[0] ? this.loadCredentialByConnection(rows[0].connection_id) : null;
  }

  async listExpiringCredentialIds(hours = 24) {
    const threshold = new Date(Date.now() + Math.max(1, Math.min(168, hours)) * 3_600_000).toISOString();
    const [rows] = await this.pool.query<Array<RowDataPacket & { id: string }>>(
      `SELECT r.id FROM integration_credentials r JOIN integration_connections c ON c.id=r.connection_id
       WHERE r.credential_type='oauth_token' AND r.revoked_at IS NULL AND r.expires_at IS NOT NULL
       AND r.expires_at<=? AND c.connection_status IN ('active','degraded') ORDER BY r.expires_at ASC LIMIT 500`,
      [threshold]
    );
    return rows.map((row) => row.id);
  }

  async withCredentialRefreshLease<T>(credentialId: string, work: () => Promise<T>) {
    const connection = await this.pool.getConnection();
    const lockName = `gj:oauth-refresh:${credentialId}`.slice(0, 64);
    try {
      const [rows] = await connection.query<Array<RowDataPacket & { acquired: number }>>(
        "SELECT GET_LOCK(?, 0) AS acquired",
        [lockName]
      );
      if (Number(rows[0]?.acquired || 0) !== 1) return { acquired: false as const };
      try {
        return { acquired: true as const, value: await work() };
      } finally {
        await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
      }
    } finally {
      connection.release();
    }
  }

  async replaceCredential(input: { credential: WorkerCredential; encryptedValue: string; tokenFingerprint: string; expiresAt: string | null }) {
    const now = new Date().toISOString();
    const [updated] = await this.pool.execute<ResultSetHeader>(
      `UPDATE integration_credentials SET encrypted_value=?,token_fingerprint=?,expires_at=?,
       refreshed_at=?,updated_at=? WHERE id=? AND revoked_at IS NULL AND token_fingerprint=?`,
      [input.encryptedValue, input.tokenFingerprint, input.expiresAt, now, now,
        input.credential.credentialId, input.credential.tokenFingerprint]
    );
    if (updated.affectedRows !== 1) throw new Error("INTEGRATION_CREDENTIAL_STATE_CONFLICT: 凭据已被其它刷新任务更新");
  }

  async markCredentialReauthorizationRequired(credentialId: string, error: unknown) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message.slice(0, 500) : "OAuth refresh token 已失效";
    await this.pool.execute(
      `UPDATE integration_connections c JOIN integration_credentials r ON r.connection_id=c.id
       SET c.connection_status='reauthorization_required',c.last_error_code='INTEGRATION_REAUTH_REQUIRED',
       c.last_error_message=?,c.updated_at=?,c.revision_no=c.revision_no+1
       WHERE r.id=? AND c.connection_status IN ('active','degraded')`,
      [message, now, credentialId]
    );
  }

  async markCredentialRevoked(connectionId: string) {
    const now = new Date().toISOString();
    await this.pool.execute(
      `UPDATE integration_credentials SET revoked_at=?,updated_at=?
       WHERE connection_id=? AND credential_type IN ('oauth_token','api_token') AND revoked_at IS NULL`,
      [now, now, connectionId]
    );
  }

  async applyDiscovery(
    context: WorkerConnectionContext,
    discovery: { protocolVersion: string; serverName: string; serverVersion: string; capabilities: Record<string, unknown>; tools: DiscoveredToolSnapshot[] },
    mode: "initial" | "refresh"
  ) {
    const now = new Date().toISOString();
    return transaction(this.pool, async (connection) => {
      const [existingRows] = await connection.query<Array<RowDataPacket & {
        id: string; remote_name: string; schema_hash: string; tool_status: string;
      }>>(
        "SELECT id,remote_name,schema_hash,tool_status FROM integration_tool_snapshots WHERE connection_id=? FOR UPDATE",
        [context.connectionId]
      );
      const discoveredNames = new Set(discovery.tools.map((tool) => tool.remoteName));
      let created = 0;
      let quarantined = 0;

      for (const tool of discovery.tools) {
        const same = existingRows.find((row) => row.remote_name === tool.remoteName && row.schema_hash === tool.schemaHash);
        if (same) {
          await connection.execute(
            "UPDATE integration_tool_snapshots SET discovered_at=?,updated_at=? WHERE id=?",
            [now, now, same.id]
          );
          continue;
        }
        const changed = existingRows.filter((row) => row.remote_name === tool.remoteName && row.schema_hash !== tool.schemaHash && !["retired", "rejected"].includes(row.tool_status));
        for (const prior of changed) {
          const nextStatus = prior.tool_status === "active" ? "quarantined" : "retired";
          if (nextStatus === "quarantined") quarantined += 1;
          await connection.execute(
            "UPDATE integration_tool_snapshots SET tool_status=?,updated_at=?,revision_no=revision_no+1 WHERE id=?",
            [nextStatus, now, prior.id]
          );
          await connection.execute(
            "UPDATE integration_tool_grants SET grant_status='paused',updated_at=? WHERE tool_snapshot_id=? AND grant_status='active'",
            [now, prior.id]
          );
          await connection.execute(
            "UPDATE integration_approvals SET approval_status='cancelled',updated_at=? WHERE tool_snapshot_id=? AND approval_status IN ('pending','approved')",
            [now, prior.id]
          );
        }
        await connection.execute(
          `INSERT INTO integration_tool_snapshots
           (id,connection_id,team_id,remote_name,stable_alias,display_name,description,input_schema_json,
            output_schema_json,schema_hash,risk_level,tool_status,revision_no,discovered_at,reviewed_by,
            permission_code,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,? ,1,'pending_review',1,?,'','',?,?)`,
          [`its_${randomUUID()}`, context.connectionId, context.teamId, tool.remoteName, "",
            tool.displayName, tool.description, JSON.stringify(tool.inputSchema),
            tool.outputSchema ? JSON.stringify(tool.outputSchema) : null, tool.schemaHash, now, now, now]
        );
        created += 1;
      }

      for (const prior of existingRows.filter((row) => row.tool_status === "active" && !discoveredNames.has(row.remote_name))) {
        await connection.execute(
          "UPDATE integration_tool_snapshots SET tool_status='retired',updated_at=?,revision_no=revision_no+1 WHERE id=?",
          [now, prior.id]
        );
        await connection.execute(
          "UPDATE integration_tool_grants SET grant_status='paused',updated_at=? WHERE tool_snapshot_id=? AND grant_status='active'",
          [now, prior.id]
        );
      }

      const serverInfo = JSON.stringify({
        protocolVersion: discovery.protocolVersion,
        name: discovery.serverName,
        version: discovery.serverVersion,
        capabilities: discovery.capabilities
      });
      if (mode === "initial") {
        const [updated] = await connection.execute<ResultSetHeader>(
          `UPDATE integration_connections SET connection_status='pending_review',server_info_json=?,
           last_health_at=?,last_error_code='',last_error_message='',updated_at=?,revision_no=revision_no+1
           WHERE id=? AND connection_status='discovering'`,
          [serverInfo, now, now, context.connectionId]
        );
        if (updated.affectedRows !== 1) throw new Error("INTEGRATION_CONNECTION_STATE_CONFLICT: 发现结果不能写入当前连接状态");
      } else {
        await connection.execute(
          `UPDATE integration_connections SET server_info_json=?,last_health_at=?,last_error_code='',
           last_error_message='',updated_at=?,revision_no=revision_no+1 WHERE id=?`,
          [serverInfo, now, now, context.connectionId]
        );
      }
      return { created, quarantined, total: discovery.tools.length };
    });
  }

  async markDiscoveryFailed(connectionId: string, mode: "initial" | "refresh", error: unknown) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message.slice(0, 500) : "工具发现失败";
    if (mode === "initial") {
      await this.pool.execute(
        `UPDATE integration_connections SET connection_status='failed',last_error_code='INTEGRATION_REMOTE_UNAVAILABLE',
         last_error_message=?,updated_at=?,revision_no=revision_no+1 WHERE id=? AND connection_status='discovering'`,
        [message, now, connectionId]
      );
    } else {
      await this.pool.execute(
        `UPDATE integration_connections SET connection_status=IF(connection_status='active','degraded',connection_status),
         last_error_code='INTEGRATION_REMOTE_UNAVAILABLE',last_error_message=?,updated_at=?,revision_no=revision_no+1 WHERE id=?`,
        [message, now, connectionId]
      );
    }
  }

  async claimCall(callId: string): Promise<ClaimedToolCall> {
    return transaction(this.pool, async (connection) => {
      const now = new Date().toISOString();
      const [claim] = await connection.execute<ResultSetHeader>(
        "UPDATE integration_tool_calls SET call_status='running',started_at=?,updated_at=?,attempt_count=attempt_count+1 WHERE id=? AND call_status='queued'",
        [now, now, callId]
      );
      if (claim.affectedRows !== 1) throw new Error("INTEGRATION_CALL_STATE_CONFLICT: 调用已被领取或不可执行");
      const [rows] = await connection.query<Array<RowDataPacket & {
        call_id: string; request_id: string; team_id: string; owner_id: string; actor_id: string;
        actor_auth_version: number; risk_level: number; connection_id: string; connector_id: string; connection_status: string;
        connector_status: string; manifest_json: unknown; tool_snapshot_id: string; remote_name: string;
        schema_hash: string; tool_status: string; permission_code: string; input_artifact_id: string;
        encrypted_value: string; review_json: unknown; user_role: string; user_status: string; current_auth_version: number;
        grant_count: number; created_at: Date | string;
      }>>(
        `SELECT c.id AS call_id,c.request_id,c.team_id,c.owner_id,c.actor_id,c.actor_auth_version,c.risk_level,
         c.connection_id,cn.connector_id,cn.connection_status,d.connector_status,d.manifest_json,
         t.id AS tool_snapshot_id,t.remote_name,t.schema_hash,t.tool_status,t.permission_code,t.review_json,
         c.input_artifact_id,a.encrypted_value,c.created_at,u.role AS user_role,u.status AS user_status,
         u.auth_version AS current_auth_version,
         (SELECT COUNT(*) FROM integration_tool_grants g WHERE g.tool_snapshot_id=t.id
          AND g.team_id=c.team_id AND g.grant_status='active' AND g.permission_code=t.permission_code
          AND (g.expires_at IS NULL OR g.expires_at>NOW(3))
          AND ((g.subject_type='user' AND g.subject_id=c.actor_id)
            OR (g.subject_type='role' AND g.subject_id=u.role)
            OR (g.subject_type='team' AND g.subject_id=c.team_id))) AS grant_count
         FROM integration_tool_calls c
         JOIN integration_connections cn ON cn.id=c.connection_id
         JOIN integration_connectors d ON d.id=cn.connector_id
         JOIN integration_tool_snapshots t ON t.id=c.tool_snapshot_id
         JOIN integration_artifacts a ON a.id=c.input_artifact_id
         JOIN users u ON u.id=c.actor_id
         WHERE c.id=? FOR UPDATE`,
        [callId]
      );
      const row = rows[0];
      if (!row) throw new Error("INTEGRATION_CALL_NOT_FOUND: 调用上下文不完整");
      if (!new Set(["active", "degraded"]).has(row.connection_status)) {
        throw new Error("INTEGRATION_CONNECTION_PAUSED: 连接当前不可调用");
      }
      if (row.connector_status !== "active" || row.tool_status !== "active") throw new Error("INTEGRATION_TOOL_NOT_APPROVED: 工具未审核或已隔离");
      if (row.user_status !== "active" || Number(row.current_auth_version || 1) !== Number(row.actor_auth_version || 1)) {
        throw new Error("INTEGRATION_PERMISSION_DENIED: 调用人登录状态或权限版本已失效");
      }
      if (Number(row.grant_count || 0) < 1) throw new Error("INTEGRATION_TOOL_GRANT_DENIED: 当前账号没有工具授权");
      return {
        callId: row.call_id, requestId: row.request_id, teamId: row.team_id, ownerId: row.owner_id,
        actorId: row.actor_id, actorRole: row.user_role, actorAuthVersion: Number(row.actor_auth_version),
        riskLevel: Number(row.risk_level),
        connectionId: row.connection_id, connectorId: row.connector_id, status: row.connection_status,
        toolSnapshotId: row.tool_snapshot_id, remoteName: row.remote_name, schemaHash: row.schema_hash,
        inputArtifactId: row.input_artifact_id, encryptedInput: row.encrypted_value,
        reviewJson: JSON.stringify(row.review_json || {}),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        manifest: parseManifest(row.manifest_json)
      };
    });
  }

  async getCallInputHash(callId: string) {
    const [rows] = await this.pool.query<Array<RowDataPacket & { input_hash: string }>>(
      "SELECT input_hash FROM integration_tool_calls WHERE id=? LIMIT 1",
      [callId]
    );
    return rows[0]?.input_hash || "";
  }

  async completeCallSuccess(input: {
    call: ClaimedToolCall;
    outputHash: string;
    outputSummary: Record<string, unknown>;
    externalReceipt: string;
    evidence: Record<string, unknown>;
    outputBytes: number;
    artifact: { id: string; encryptedValue: string; contentHash: string; keyVersion: string; expiresAt: string };
  }) {
    const now = new Date().toISOString();
    await transaction(this.pool, async (connection) => {
      await connection.execute(
        `INSERT INTO integration_artifacts
         (id,team_id,owner_id,connection_id,artifact_type,content_hash,encrypted_value,key_version,content_type,expires_at,created_at)
         VALUES (?,?,?,?, 'tool_result', ?,?,?, 'application/json', ?,?)`,
        [input.artifact.id, input.call.teamId, input.call.ownerId, input.call.connectionId,
          input.artifact.contentHash, input.artifact.encryptedValue, input.artifact.keyVersion,
          input.artifact.expiresAt, now]
      );
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_tool_calls SET call_status='succeeded',output_hash=?,result_artifact_id=?,
         output_summary_json=?,external_receipt=?,evidence_json=?,finished_at=?,updated_at=?
         WHERE id=? AND call_status='running'`,
        [input.outputHash, input.artifact.id, JSON.stringify(input.outputSummary), input.externalReceipt,
          JSON.stringify(input.evidence), now, now, input.call.callId]
      );
      if (updated.affectedRows !== 1) throw new Error("INTEGRATION_CALL_STATE_CONFLICT: 调用完成状态冲突");
      await this.recordUsageOutcome(connection, input.call, "succeeded", input.outputBytes, now);
      await this.recordToolCircuitOutcome(connection, input.call, "succeeded", "", "", now);
      await connection.execute(
        `INSERT INTO integration_call_events
         (call_id,team_id,actor_id,event_type,from_status,to_status,request_id,input_hash,output_hash,summary_json,created_at)
         VALUES (?,?,?,'call_succeeded','running','succeeded',?,'',?,?,?)`,
        [input.call.callId, input.call.teamId, input.call.actorId, input.call.requestId,
          input.outputHash, JSON.stringify(input.evidence), now]
      );
    });
  }

  private async recordUsageOutcome(
    connection: PoolConnection,
    call: ClaimedToolCall,
    outcome: "succeeded" | "failed",
    outputBytes: number,
    updatedAt: string
  ) {
    const successCount = outcome === "succeeded" ? 1 : 0;
    const failureCount = outcome === "failed" ? 1 : 0;
    await connection.execute(
      `INSERT INTO integration_usage_daily
       (usage_date,team_id,connection_id,tool_snapshot_id,call_count,success_count,failure_count,
        input_bytes,output_bytes,estimated_cost,updated_at)
       VALUES (?,?,?,?,1,?,?,0,?,0,?)
       ON DUPLICATE KEY UPDATE success_count=success_count+VALUES(success_count),
        failure_count=failure_count+VALUES(failure_count),output_bytes=output_bytes+VALUES(output_bytes),
        updated_at=VALUES(updated_at)`,
      [call.createdAt.slice(0, 10), call.teamId, call.connectionId, call.toolSnapshotId,
        successCount, failureCount, Math.max(0, outputBytes), updatedAt]
    );
  }

  private async recordToolCircuitOutcome(
    connection: PoolConnection,
    call: ClaimedToolCall,
    outcome: "succeeded" | "failed",
    errorCode: string,
    errorMessage: string,
    updatedAt: string
  ) {
    await connection.execute(
      `INSERT IGNORE INTO integration_circuit_states
       (subject_type,subject_id,team_id,connection_id,circuit_state,updated_at)
       VALUES ('tool',?,?,?,'closed',?)`,
      [call.toolSnapshotId, call.teamId, call.connectionId, updatedAt]
    );
    const [rows] = await connection.query<Array<RowDataPacket & {
      circuit_state: "closed" | "open" | "half_open"; consecutive_failures: number;
    }>>(
      `SELECT circuit_state,consecutive_failures FROM integration_circuit_states
       WHERE subject_type='tool' AND subject_id=? LIMIT 1 FOR UPDATE`,
      [call.toolSnapshotId]
    );
    const current = rows[0]!;
    if (outcome === "succeeded") {
      await connection.execute(
        `UPDATE integration_circuit_states SET circuit_state='closed',consecutive_failures=0,
         consecutive_successes=consecutive_successes+1,open_until=NULL,last_checked_at=?,last_latency_ms=0,
         last_error_code='',last_error_message='',updated_at=? WHERE subject_type='tool' AND subject_id=?`,
        [updatedAt, updatedAt, call.toolSnapshotId]
      );
      return;
    }
    const countable = ["INTEGRATION_REMOTE_UNAVAILABLE", "INTEGRATION_RATE_LIMITED", "INTEGRATION_UNKNOWN_OUTCOME"]
      .includes(errorCode);
    if (!countable) return;
    const failures = Number(current.consecutive_failures || 0) + 1;
    const open = current.circuit_state === "half_open" || failures >= 3;
    await connection.execute(
      `UPDATE integration_circuit_states SET circuit_state=?,consecutive_failures=?,consecutive_successes=0,
       opened_at=IF(?='open',COALESCE(opened_at,?),NULL),open_until=?,last_checked_at=?,last_error_code=?,
       last_error_message=?,updated_at=? WHERE subject_type='tool' AND subject_id=?`,
      [open ? "open" : "closed", failures, open ? "open" : "closed", updatedAt,
        open ? new Date(Date.parse(updatedAt) + 5 * 60_000).toISOString() : null, updatedAt,
        errorCode, errorMessage.slice(0, 500), updatedAt, call.toolSnapshotId]
    );
  }

  async completeCallFailure(call: ClaimedToolCall, error: unknown) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message.slice(0, 1000) : "工具调用失败";
    const code = /^([A-Z0-9_]+):/u.exec(message)?.[1] || "INTEGRATION_REMOTE_UNAVAILABLE";
    await transaction(this.pool, async (connection) => {
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_tool_calls SET call_status='failed',error_code=?,error_message=?,finished_at=?,updated_at=?
         WHERE id=? AND call_status='running'`,
        [code, message, now, now, call.callId]
      );
      if (updated.affectedRows !== 1) return;
      await this.recordUsageOutcome(connection, call, "failed", 0, now);
      await this.recordToolCircuitOutcome(connection, call, "failed", code, message, now);
      await connection.execute(
        `INSERT INTO integration_call_events
         (call_id,team_id,actor_id,event_type,from_status,to_status,request_id,input_hash,output_hash,summary_json,created_at)
         SELECT id,team_id,actor_id,'call_failed','running','failed',request_id,input_hash,'',JSON_OBJECT('errorCode',?),?
         FROM integration_tool_calls WHERE id=?`,
        [code, now, call.callId]
      );
    });
  }

  async completeCallUnknownOutcome(call: ClaimedToolCall, error: unknown) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message.slice(0, 1000) : "外部写入结果未知";
    await transaction(this.pool, async (connection) => {
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_tool_calls SET call_status='unknown_outcome',error_code='INTEGRATION_UNKNOWN_OUTCOME',
         error_message=?,finished_at=?,updated_at=? WHERE id=? AND call_status='running'`,
        [message, now, now, call.callId]
      );
      if (updated.affectedRows !== 1) return;
      await this.recordUsageOutcome(connection, call, "failed", 0, now);
      await this.recordToolCircuitOutcome(connection, call, "failed", "INTEGRATION_UNKNOWN_OUTCOME", message, now);
      await connection.execute(
        `INSERT INTO integration_call_events
         (call_id,team_id,actor_id,event_type,from_status,to_status,request_id,input_hash,output_hash,summary_json,created_at)
         SELECT id,team_id,actor_id,'call_unknown_outcome','running','unknown_outcome',request_id,input_hash,'',
          JSON_OBJECT('errorCode','INTEGRATION_UNKNOWN_OUTCOME'),? FROM integration_tool_calls WHERE id=?`,
        [now, call.callId]
      );
    });
  }
}
