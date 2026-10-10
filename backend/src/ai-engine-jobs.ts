import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { AiEngineAdapter, EmailEngineSource, ResearchEngineSource } from "./ai-engine-settings.js";

// ---------------------------------------------------------------------------
// AI 引擎作业（ai_engine_jobs）
//
// 一笔「背调」或「开发信」走 CLI 时，实际执行时间取决于本机 Runner 什么时候领任务，
// 可能是 3 秒也可能是几分钟。为了让 HTTP 请求不阻塞、又让结果可追溯，这里把每次
// CLI 执行登记成一条作业：
//   - request_json 存「CRM 已经算好的骨架 + 实际发出的提示词」（无法回滚的事实快照）
//   - result_json  存「最终回给前端的完整 payload」
//   - cli_task_id  关联 integration_local_runner_tasks，便于追本机执行日志
//
// 作业是留档，不是状态机：status 只表示这次引擎调用是否已经产出结果。
// ---------------------------------------------------------------------------

export type AiEngineJobKind = "research" | "email" | "search" | "tender";
export type AiEngineJobStatus = "running" | "succeeded" | "failed";

export interface AiEngineJob {
  id: string;
  teamId: string;
  ownerId: string;
  createdBy: string;
  kind: AiEngineJobKind;
  entityType: string;
  entityId: string;
  source: ResearchEngineSource | EmailEngineSource;
  adapter: AiEngineAdapter | "";
  runnerId: string;
  cliTaskId: string;
  status: AiEngineJobStatus;
  engine: string;
  requestJson: string;
  resultJson: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string;
}

export async function ensureAiEngineSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_engine_jobs (
      id VARCHAR(80) NOT NULL PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL DEFAULT '',
      owner_id VARCHAR(64) NOT NULL DEFAULT '',
      created_by VARCHAR(64) NOT NULL DEFAULT '',
      kind VARCHAR(20) NOT NULL DEFAULT '',
      entity_type VARCHAR(30) NOT NULL DEFAULT '',
      entity_id VARCHAR(90) NOT NULL DEFAULT '',
      source VARCHAR(20) NOT NULL DEFAULT '',
      adapter VARCHAR(20) NOT NULL DEFAULT '',
      runner_id VARCHAR(80) NOT NULL DEFAULT '',
      cli_task_id VARCHAR(80) NOT NULL DEFAULT '',
      status VARCHAR(20) NOT NULL DEFAULT 'running',
      engine VARCHAR(200) NOT NULL DEFAULT '',
      request_json MEDIUMTEXT NULL,
      result_json MEDIUMTEXT NULL,
      error_message VARCHAR(1000) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      finished_at DATETIME(3) NULL,
      KEY idx_ai_engine_job_scope (team_id, owner_id, created_at),
      KEY idx_ai_engine_job_task (cli_task_id),
      KEY idx_ai_engine_job_pending (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

interface AiEngineJobRow extends RowDataPacket {
  id: string;
  team_id: string;
  owner_id: string;
  created_by: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  source: string;
  adapter: string;
  runner_id: string;
  cli_task_id: string;
  status: string;
  engine: string;
  request_json: string | null;
  result_json: string | null;
  error_message: string;
  created_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
}

function toIso(value: Date | string | null) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToJob(row: AiEngineJobRow): AiEngineJob {
  return {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    createdBy: row.created_by,
    kind: row.kind === "email" || row.kind === "search" || row.kind === "tender" ? row.kind : "research",
    entityType: row.entity_type,
    entityId: row.entity_id,
    source: row.source as AiEngineJob["source"],
    adapter: row.adapter === "workbuddy" || row.adapter === "codex" ? row.adapter : "",
    runnerId: row.runner_id,
    cliTaskId: row.cli_task_id,
    status: row.status === "succeeded" || row.status === "failed" ? row.status : "running",
    engine: row.engine,
    requestJson: row.request_json || "",
    resultJson: row.result_json || "",
    errorMessage: row.error_message,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    finishedAt: toIso(row.finished_at)
  };
}

export class MysqlAiEngineJobRepository {
  constructor(private readonly pool: Pool) {}

  async create(job: Omit<AiEngineJob, "createdAt" | "updatedAt" | "finishedAt"> & { id?: string }) {
    const id = job.id || `aej_${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO ai_engine_jobs
        (id, team_id, owner_id, created_by, kind, entity_type, entity_id, source, adapter,
         runner_id, cli_task_id, status, engine, request_json, result_json, error_message,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
      [
        id, job.teamId, job.ownerId, job.createdBy, job.kind, job.entityType, job.entityId,
        job.source, job.adapter, job.runnerId, job.cliTaskId, job.status, job.engine,
        job.requestJson, job.resultJson, job.errorMessage
      ]
    );
    return id;
  }

  async get(id: string) {
    const [rows] = await this.pool.query<AiEngineJobRow[]>(
      "SELECT * FROM ai_engine_jobs WHERE id = ? LIMIT 1",
      [id]
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  /** 还没产出结果的作业（服务重启后据此补收 CLI 结果） */
  async listRunning(limit = 50) {
    const [rows] = await this.pool.query<AiEngineJobRow[]>(
      `SELECT * FROM ai_engine_jobs
        WHERE status = 'running' AND cli_task_id <> ''
        ORDER BY created_at DESC LIMIT ?`,
      [Math.max(1, Math.min(200, limit))]
    );
    return rows.map(rowToJob);
  }

  async setCliTask(id: string, runnerId: string, cliTaskId: string, engine: string) {
    await this.pool.query(
      "UPDATE ai_engine_jobs SET runner_id = ?, cli_task_id = ?, engine = ?, updated_at = NOW(3) WHERE id = ?",
      [runnerId, cliTaskId, engine.slice(0, 200), id]
    );
  }

  async finish(id: string, status: AiEngineJobStatus, resultJson: string, errorMessage: string) {
    await this.pool.query(
      `UPDATE ai_engine_jobs
          SET status = ?, result_json = ?, error_message = ?, finished_at = NOW(3), updated_at = NOW(3)
        WHERE id = ?`,
      [status, resultJson, errorMessage.slice(0, 1000), id]
    );
  }

  async list(teamId: string, ownerId: string, kind: AiEngineJobKind, limit = 20) {
    const [rows] = await this.pool.query<AiEngineJobRow[]>(
      `SELECT * FROM ai_engine_jobs
        WHERE team_id = ? AND owner_id = ? AND kind = ?
        ORDER BY created_at DESC LIMIT ?`,
      [teamId, ownerId, kind, Math.max(1, Math.min(100, limit))]
    );
    return rows.map(rowToJob);
  }

  /**
   * 团队维度按 kind 取最近作业（不看 owner）。
   * 竞标日报是团队共享产物：谁先打开工作主页谁触发，全队都能看同一份。
   */
  async listTeamByKind(teamId: string, kind: AiEngineJobKind, limit = 20) {
    const [rows] = await this.pool.query<AiEngineJobRow[]>(
      `SELECT * FROM ai_engine_jobs
        WHERE team_id = ? AND kind = ?
        ORDER BY created_at DESC LIMIT ?`,
      [teamId, kind, Math.max(1, Math.min(100, limit))]
    );
    return rows.map(rowToJob);
  }

  /**
   * 团队维度正在执行作业的 entity_id 去重集合（列表页标「背调中」等进行中状态用）。
   * 只看最近 30 分钟内有过心跳的作业，避免进程异常退出留下的僵尸 running 永久亮灯。
   */
  async listRunningEntityIds(teamId: string, kind: AiEngineJobKind, limit = 300) {
    const [rows] = await this.pool.query<AiEngineJobRow[]>(
      `SELECT * FROM ai_engine_jobs
        WHERE team_id = ? AND kind = ? AND status = 'running'
          AND updated_at > NOW() - INTERVAL 30 MINUTE
        ORDER BY created_at DESC LIMIT ?`,
      [teamId, kind, Math.max(1, Math.min(500, limit))]
    );
    return Array.from(new Set(rows.map((row) => row.entity_id).filter(Boolean)));
  }
}

let aiEngineJobRepository: MysqlAiEngineJobRepository | null = null;

export function setAiEngineJobRepository(value: MysqlAiEngineJobRepository | null) {
  aiEngineJobRepository = value;
}

export function getAiEngineJobRepository() {
  return aiEngineJobRepository;
}
