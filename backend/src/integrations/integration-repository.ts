import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { DataScope } from "../authorization.js";
import { connectionStateConflict, integrationNotFound } from "./integration-errors.js";
import {
  assertConnectionScopeInvariant,
  assertConnectionTransition,
  type ConnectionStatus,
  type IntegrationConnection
} from "./integration-types.js";

export interface CreateConnectionInput extends Omit<IntegrationConnection, "revision" | "lastHealthAt" | "lastErrorCode" | "lastErrorMessage" | "serverInfoJson" | "warningMessage" | "createdAt" | "updatedAt" | "disconnectedAt"> {
  createdAt?: string;
}

export interface IntegrationRepository {
  createConnection(input: CreateConnectionInput): Promise<IntegrationConnection>;
  getConnection(id: string, scope: DataScope): Promise<IntegrationConnection | null>;
  listConnections(scope: DataScope, options?: { status?: ConnectionStatus; limit?: number; offset?: number }): Promise<IntegrationConnection[]>;
  transitionConnection(id: string, scope: DataScope, expectedStatus: ConnectionStatus, nextStatus: ConnectionStatus): Promise<IntegrationConnection>;
}

interface ConnectionRow extends RowDataPacket {
  id: string;
  connector_id: string;
  team_id: string;
  owner_id: string;
  connection_scope: IntegrationConnection["scope"];
  scope_id: string;
  connection_status: ConnectionStatus;
  display_name: string;
  webhook_public_id: string;
  revision_no: number;
  last_health_at: Date | null;
  last_health_latency_ms: number;
  last_error_code: string;
  last_error_message: string;
  server_info_json: unknown;
  warning_message: string;
  created_at: Date;
  updated_at: Date;
  disconnected_at: Date | null;
}

function iso(value: Date | string | null) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapConnection(row: ConnectionRow): IntegrationConnection {
  return {
    id: row.id,
    connectorId: row.connector_id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    scope: row.connection_scope,
    scopeId: row.scope_id,
    status: row.connection_status,
    displayName: row.display_name,
    webhookPublicId: row.webhook_public_id,
    revision: Number(row.revision_no),
    lastHealthAt: iso(row.last_health_at),
    lastHealthLatencyMs: Number(row.last_health_latency_ms || 0),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    serverInfoJson: JSON.stringify(row.server_info_json || {}),
    warningMessage: row.warning_message || "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    disconnectedAt: iso(row.disconnected_at)
  };
}

function scopeClause(scope: DataScope, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  if (scope.type === "platform") return { sql: "1=1", values: [] as Array<string | number | null> };
  if (scope.type === "team") {
    if (!scope.teamId) throw new Error("团队数据范围缺少 teamId");
    const ownerIds = [...new Set(scope.ownerIds || [])];
    return ownerIds.length
      ? { sql: `${prefix}team_id = ? AND ${prefix}owner_id IN (${ownerIds.map(() => "?").join(",")})`, values: [scope.teamId, ...ownerIds] }
      : { sql: `${prefix}team_id = ?`, values: [scope.teamId] };
  }
  if (!scope.teamId || !scope.ownerId) throw new Error("个人数据范围缺少 teamId 或 ownerId");
  return {
    sql: `${prefix}team_id = ? AND ${prefix}owner_id = ?`,
    values: [scope.teamId, scope.ownerId]
  };
}

async function withTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
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

export class MysqlIntegrationRepository implements IntegrationRepository {
  constructor(private readonly pool: Pool) {}

  async createConnection(input: CreateConnectionInput): Promise<IntegrationConnection> {
    assertConnectionScopeInvariant(input);
    const now = input.createdAt || new Date().toISOString();
    const webhookPublicId = input.webhookPublicId || `iwp_${randomUUID().replaceAll("-", "")}`;
    await withTransaction(this.pool, async (connection) => {
      await connection.execute(
        `INSERT INTO integration_connections
          (id, connector_id, team_id, owner_id, connection_scope, scope_id,
           connection_status, display_name, webhook_public_id, revision_no, last_error_code,
           last_error_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '', '', ?, ?)`,
        [
          input.id, input.connectorId, input.teamId, input.ownerId, input.scope,
          input.scopeId, input.status, input.displayName, webhookPublicId, now, now
        ]
      );
    });
    const scope: DataScope = input.scope === "platform"
      ? { type: "platform" }
      : input.scope === "team"
        ? { type: "team", teamId: input.teamId }
        : { type: "personal", teamId: input.teamId, ownerId: input.ownerId };
    const created = await this.getConnection(input.id, scope);
    if (!created) throw integrationNotFound("连接已创建但无法按当前范围读取");
    return created;
  }

  async getConnection(id: string, scope: DataScope): Promise<IntegrationConnection | null> {
    const scoped = scopeClause(scope);
    const [rows] = await this.pool.query<ConnectionRow[]>(
      `SELECT * FROM integration_connections WHERE id = ? AND ${scoped.sql} LIMIT 1`,
      [id, ...scoped.values]
    );
    return rows[0] ? mapConnection(rows[0]) : null;
  }

  async listConnections(
    scope: DataScope,
    options: { status?: ConnectionStatus; limit?: number; offset?: number } = {}
  ): Promise<IntegrationConnection[]> {
    const scoped = scopeClause(scope);
    const limit = Math.max(1, Math.min(100, Number(options.limit || 50)));
    const offset = Math.max(0, Number(options.offset || 0));
    const statusSql = options.status ? " AND connection_status = ?" : "";
    const values = [...scoped.values, ...(options.status ? [options.status] : []), limit, offset];
    const [rows] = await this.pool.query<ConnectionRow[]>(
      `SELECT * FROM integration_connections
       WHERE ${scoped.sql}${statusSql}
       ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      values
    );
    return rows.map(mapConnection);
  }

  async transitionConnection(
    id: string,
    scope: DataScope,
    expectedStatus: ConnectionStatus,
    nextStatus: ConnectionStatus
  ): Promise<IntegrationConnection> {
    assertConnectionTransition(expectedStatus, nextStatus);
    const scoped = scopeClause(scope);
    const now = new Date().toISOString();
    const disconnectedAt = nextStatus === "disconnected" ? now : null;
    const updated = await withTransaction(this.pool, async (connection) => {
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_connections
         SET connection_status = ?, revision_no = revision_no + 1,
             updated_at = ?, disconnected_at = COALESCE(?, disconnected_at)
         WHERE id = ? AND connection_status = ? AND ${scoped.sql}`,
        [nextStatus, now, disconnectedAt, id, expectedStatus, ...scoped.values]
      );
      return result.affectedRows;
    });
    if (updated !== 1) throw connectionStateConflict();
    const connection = await this.getConnection(id, scope);
    if (!connection) throw integrationNotFound();
    return connection;
  }
}
