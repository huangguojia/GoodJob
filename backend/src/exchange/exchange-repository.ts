import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";

// ---------------------------------------------------------------------------
// 系统对接模块：对接方（endpoint）+ 报文日志（message）
// 对接方 = 一个外部系统的收发配置（URL / 鉴权 / 附加头）；
// 报文日志 = 每一次收发的完整请求与响应（含头与体），可追溯可排障。
// ---------------------------------------------------------------------------

export type ExchangeDirection = "outbound" | "inbound" | "both";
export type ExchangeAuthType = "none" | "bearer" | "header";

export interface ExchangeEndpoint {
  id: string;
  teamId: string;
  ownerId: string;
  name: string;
  direction: ExchangeDirection;
  baseUrl: string;
  authType: ExchangeAuthType;
  authName: string;
  authSecret: string;
  inboundKey: string;
  extraHeadersJson: string;
  description: string;
  /** 收到报文后的处理：log=仅记录；create_lead=解析公司名自动建线索 */
  onReceive: "log" | "create_lead";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExchangeMessage {
  id: string;
  teamId: string;
  endpointId: string;
  endpointName: string;
  direction: "outbound" | "inbound";
  topic: string;
  method: string;
  url: string;
  requestHeadersJson: string;
  requestBody: string;
  status: "ok" | "failed" | "received";
  httpStatus: number | null;
  responseHeadersJson: string;
  responseBody: string;
  durationMs: number | null;
  errorMessage: string;
  /** 自动建线索闭环：收到的报文若已生成/关联线索，这里记录线索 ID */
  leadId: string;
  createdAt: string;
}

interface EndpointRow extends RowDataPacket {
  id: string; team_id: string; owner_id: string; name: string; direction: string;
  base_url: string; auth_type: string; auth_name: string; auth_secret: string;
  inbound_key: string; extra_headers_json: string; description: string; on_receive: string;
  enabled: number; created_at: Date; updated_at: Date;
}

interface MessageRow extends RowDataPacket {
  id: string; team_id: string; endpoint_id: string; endpoint_name: string;
  direction: string; topic: string; method: string; url: string;
  request_headers_json: string; request_body: string; status: string;
  http_status: number | null; response_headers_json: string; response_body: string;
  duration_ms: number | null; error_message: string; lead_id: string; created_at: Date;
}

function iso(value: Date | string | null): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapEndpoint(row: EndpointRow): ExchangeEndpoint {
  return {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    name: row.name,
    direction: (row.direction || "outbound") as ExchangeDirection,
    baseUrl: row.base_url || "",
    authType: (row.auth_type || "none") as ExchangeAuthType,
    authName: row.auth_name || "",
    authSecret: row.auth_secret || "",
    inboundKey: row.inbound_key || "",
    extraHeadersJson: row.extra_headers_json || "{}",
    description: row.description || "",
    onReceive: row.on_receive === "create_lead" ? "create_lead" : "log",
    enabled: row.enabled === 1,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapMessage(row: MessageRow): ExchangeMessage {
  return {
    id: row.id,
    teamId: row.team_id,
    endpointId: row.endpoint_id,
    endpointName: row.endpoint_name || "",
    direction: (row.direction || "outbound") as "outbound" | "inbound",
    topic: row.topic || "",
    method: row.method || "",
    url: row.url || "",
    requestHeadersJson: row.request_headers_json || "{}",
    requestBody: row.request_body || "",
    status: (row.status || "ok") as ExchangeMessage["status"],
    httpStatus: row.http_status ?? null,
    responseHeadersJson: row.response_headers_json || "{}",
    responseBody: row.response_body || "",
    durationMs: row.duration_ms ?? null,
    errorMessage: row.error_message || "",
    leadId: row.lead_id || "",
    createdAt: iso(row.created_at)
  };
}

export interface ExchangeEndpointInput {
  teamId: string;
  ownerId: string;
  name: string;
  direction: ExchangeDirection;
  baseUrl: string;
  authType: ExchangeAuthType;
  authName: string;
  authSecret: string;
  extraHeadersJson: string;
  description: string;
  onReceive: "log" | "create_lead";
  enabled: boolean;
}

export interface ExchangeMessageInput {
  teamId: string;
  endpointId: string;
  endpointName: string;
  direction: "outbound" | "inbound";
  topic: string;
  method: string;
  url: string;
  requestHeadersJson: string;
  requestBody: string;
  status: "ok" | "failed" | "received";
  httpStatus: number | null;
  responseHeadersJson: string;
  responseBody: string;
  durationMs: number | null;
  errorMessage: string;
  leadId: string;
}

export async function ensureExchangeSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exchange_endpoints (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      name VARCHAR(120) NOT NULL,
      direction VARCHAR(16) NOT NULL DEFAULT 'outbound',
      base_url VARCHAR(500) NOT NULL DEFAULT '',
      auth_type VARCHAR(16) NOT NULL DEFAULT 'none',
      auth_name VARCHAR(120) NOT NULL DEFAULT '',
      auth_secret VARCHAR(500) NOT NULL DEFAULT '',
      inbound_key CHAR(32) NOT NULL,
      extra_headers_json JSON NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      on_receive VARCHAR(16) NOT NULL DEFAULT 'log',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_exchange_inbound_key (inbound_key),
      KEY idx_exchange_endpoint_team (team_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exchange_messages (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      endpoint_id VARCHAR(64) NOT NULL DEFAULT '',
      endpoint_name VARCHAR(120) NOT NULL DEFAULT '',
      direction VARCHAR(16) NOT NULL DEFAULT 'outbound',
      topic VARCHAR(120) NOT NULL DEFAULT '',
      method VARCHAR(10) NOT NULL DEFAULT 'POST',
      url VARCHAR(500) NOT NULL DEFAULT '',
      request_headers_json JSON NULL,
      request_body MEDIUMTEXT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'ok',
      http_status INT NULL,
      response_headers_json JSON NULL,
      response_body MEDIUMTEXT NULL,
      duration_ms INT NULL,
      error_message VARCHAR(1000) NOT NULL DEFAULT '',
      lead_id VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL,
      KEY idx_exchange_msg_team_time (team_id, created_at),
      KEY idx_exchange_msg_endpoint (endpoint_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // 已存在的旧表补列（CREATE IF NOT EXISTS 不会加列）
  const [endpointCols] = await pool.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exchange_endpoints' AND COLUMN_NAME = 'on_receive'"
  );
  if (!(endpointCols as unknown[]).length) {
    await pool.query("ALTER TABLE exchange_endpoints ADD COLUMN on_receive VARCHAR(16) NOT NULL DEFAULT 'log' AFTER description");
  }
  const [messageCols] = await pool.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exchange_messages' AND COLUMN_NAME = 'lead_id'"
  );
  if (!(messageCols as unknown[]).length) {
    await pool.query("ALTER TABLE exchange_messages ADD COLUMN lead_id VARCHAR(64) NOT NULL DEFAULT '' AFTER error_message");
  }
}

export class MysqlExchangeRepository {
  constructor(private readonly pool: Pool) {}

  async listEndpoints(teamId: string): Promise<ExchangeEndpoint[]> {
    const [rows] = await this.pool.query<EndpointRow[]>(
      "SELECT * FROM exchange_endpoints WHERE team_id = ? ORDER BY created_at DESC LIMIT 200",
      [teamId]
    );
    return rows.map(mapEndpoint);
  }

  async getEndpoint(id: string, teamId: string): Promise<ExchangeEndpoint | null> {
    const [rows] = await this.pool.query<EndpointRow[]>(
      "SELECT * FROM exchange_endpoints WHERE id = ? AND team_id = ? LIMIT 1",
      [id, teamId]
    );
    return rows[0] ? mapEndpoint(rows[0]) : null;
  }

  async getEndpointByInboundKey(inboundKey: string): Promise<ExchangeEndpoint | null> {
    const [rows] = await this.pool.query<EndpointRow[]>(
      "SELECT * FROM exchange_endpoints WHERE inbound_key = ? AND enabled = 1 LIMIT 1",
      [inboundKey]
    );
    return rows[0] ? mapEndpoint(rows[0]) : null;
  }

  async createEndpoint(input: ExchangeEndpointInput): Promise<ExchangeEndpoint> {
    const now = new Date();
    const endpoint: ExchangeEndpoint = {
      id: `exc_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      teamId: input.teamId,
      ownerId: input.ownerId,
      name: input.name,
      direction: input.direction,
      baseUrl: input.baseUrl,
      authType: input.authType,
      authName: input.authName,
      authSecret: input.authSecret,
      inboundKey: randomUUID().replaceAll("-", ""),
      extraHeadersJson: input.extraHeadersJson || "{}",
      description: input.description,
      onReceive: input.onReceive === "create_lead" ? "create_lead" : "log",
      enabled: input.enabled,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    await this.pool.query(
      `INSERT INTO exchange_endpoints
        (id, team_id, owner_id, name, direction, base_url, auth_type, auth_name, auth_secret, inbound_key, extra_headers_json, description, on_receive, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [endpoint.id, endpoint.teamId, endpoint.ownerId, endpoint.name, endpoint.direction, endpoint.baseUrl,
        endpoint.authType, endpoint.authName, endpoint.authSecret, endpoint.inboundKey, endpoint.extraHeadersJson,
        endpoint.description, endpoint.onReceive, endpoint.enabled ? 1 : 0, now, now]
    );
    return endpoint;
  }

  async updateEndpoint(id: string, teamId: string, patch: Partial<ExchangeEndpointInput>): Promise<ExchangeEndpoint | null> {
    const existing = await this.getEndpoint(id, teamId);
    if (!existing) return null;
    const next: ExchangeEndpoint = {
      ...existing,
      name: patch.name ?? existing.name,
      direction: patch.direction ?? existing.direction,
      baseUrl: patch.baseUrl ?? existing.baseUrl,
      authType: patch.authType ?? existing.authType,
      authName: patch.authName ?? existing.authName,
      authSecret: patch.authSecret !== undefined ? patch.authSecret : existing.authSecret,
      extraHeadersJson: patch.extraHeadersJson ?? existing.extraHeadersJson,
      description: patch.description ?? existing.description,
      onReceive: patch.onReceive ?? existing.onReceive,
      enabled: patch.enabled ?? existing.enabled,
      updatedAt: new Date().toISOString()
    };
    await this.pool.query(
      `UPDATE exchange_endpoints SET name=?, direction=?, base_url=?, auth_type=?, auth_name=?, auth_secret=?,
        extra_headers_json=?, description=?, on_receive=?, enabled=?, updated_at=? WHERE id=? AND team_id=?`,
      [next.name, next.direction, next.baseUrl, next.authType, next.authName, next.authSecret,
        next.extraHeadersJson, next.description, next.onReceive, next.enabled ? 1 : 0, new Date(), id, teamId]
    );
    return next;
  }

  async deleteEndpoint(id: string, teamId: string): Promise<boolean> {
    const [result] = await this.pool.query(
      "DELETE FROM exchange_endpoints WHERE id = ? AND team_id = ?",
      [id, teamId]
    );
    return (result as { affectedRows?: number }).affectedRows === 1;
  }

  async insertMessage(input: ExchangeMessageInput): Promise<ExchangeMessage> {
    const message: ExchangeMessage = {
      id: `exm_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      createdAt: new Date().toISOString(),
      ...input
    };
    await this.pool.query(
      `INSERT INTO exchange_messages
        (id, team_id, endpoint_id, endpoint_name, direction, topic, method, url, request_headers_json,
         request_body, status, http_status, response_headers_json, response_body, duration_ms, error_message, lead_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [message.id, message.teamId, message.endpointId, message.endpointName, message.direction, message.topic,
        message.method, message.url, message.requestHeadersJson, message.requestBody, message.status,
        message.httpStatus, message.responseHeadersJson, message.responseBody, message.durationMs,
        message.errorMessage, message.leadId, new Date(message.createdAt)]
    );
    return message;
  }

  /** 建线索闭环：把报文与生成的线索关联起来 */
  async updateMessageLead(id: string, leadId: string): Promise<void> {
    await this.pool.query("UPDATE exchange_messages SET lead_id = ? WHERE id = ?", [leadId, id]);
  }

  async listMessages(teamId: string, filter: { endpointId?: string; direction?: string; onlyFailed?: boolean; limit?: number } = {}): Promise<ExchangeMessage[]> {
    const conditions = ["team_id = ?"];
    const params: unknown[] = [teamId];
    if (filter.endpointId) { conditions.push("endpoint_id = ?"); params.push(filter.endpointId); }
    if (filter.direction) { conditions.push("direction = ?"); params.push(filter.direction); }
    if (filter.onlyFailed) conditions.push("status = 'failed'");
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const [rows] = await this.pool.query<MessageRow[]>(
      `SELECT * FROM exchange_messages WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
      params
    );
    return rows.map(mapMessage);
  }

  async getMessage(id: string, teamId: string): Promise<ExchangeMessage | null> {
    const [rows] = await this.pool.query<MessageRow[]>(
      "SELECT * FROM exchange_messages WHERE id = ? AND team_id = ? LIMIT 1",
      [id, teamId]
    );
    return rows[0] ? mapMessage(rows[0]) : null;
  }
}

let activeExchangeRepository: MysqlExchangeRepository | null = null;

export function setExchangeRepository(repository: MysqlExchangeRepository | null): void {
  activeExchangeRepository = repository;
}

export function getExchangeRepository(): MysqlExchangeRepository | null {
  return activeExchangeRepository;
}
