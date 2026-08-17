import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  LocalRunner,
  LocalRunnerPairing,
  LocalRunnerStatus,
  LocalRunnerTask,
  LocalRunnerTaskEvent,
  LocalRunnerTaskStatus
} from "./local-runner-types.js";

export interface LocalRunnerVisibility {
  teamId: string;
  ownerIds?: string[];
}

export interface ConsumePairingInput {
  codeHash: string;
  runner: LocalRunner;
}

export interface CompleteLocalRunnerTaskInput {
  taskId: string;
  runnerId: string;
  leaseHash: string;
  status: "succeeded" | "failed" | "cancelled";
  resultText: string;
  errorMessage: string;
  outputTruncated: boolean;
  codexThreadId: string;
}

export interface LocalRunnerRepository {
  createPairing(pairing: LocalRunnerPairing): Promise<void>;
  consumePairing(input: ConsumePairingInput): Promise<LocalRunnerPairing | null>;
  getRunner(id: string): Promise<LocalRunner | null>;
  listRunners(visibility: LocalRunnerVisibility): Promise<LocalRunner[]>;
  touchRunner(id: string, input: Partial<Pick<LocalRunner, "hostname" | "platform" | "runnerVersion" | "codexVersion" | "capabilities" | "workspaces" | "lastError">>): Promise<boolean>;
  revokeRunner(id: string): Promise<boolean>;
  createTask(task: LocalRunnerTask): Promise<void>;
  getTask(id: string): Promise<LocalRunnerTask | null>;
  listTasks(visibility: LocalRunnerVisibility, runnerId?: string, limit?: number): Promise<LocalRunnerTask[]>;
  claimTask(runnerId: string, leaseHash: string, leaseExpiresAt: string): Promise<LocalRunnerTask | null>;
  heartbeatTask(taskId: string, runnerId: string, leaseHash: string, leaseExpiresAt: string): Promise<{ ok: boolean; cancelRequested: boolean }>;
  completeTask(input: CompleteLocalRunnerTaskInput): Promise<boolean>;
  cancelTask(id: string): Promise<LocalRunnerTask | null>;
  appendEvent(event: Omit<LocalRunnerTaskEvent, "id">): Promise<void>;
  appendEvents(events: Array<Omit<LocalRunnerTaskEvent, "id">>): Promise<void>;
  listTaskEvents(taskId: string, limit?: number): Promise<LocalRunnerTaskEvent[]>;
  recoverStaleTasks(runnerId?: string): Promise<void>;
}

interface PairingRow extends RowDataPacket {
  id: string; code_hash: string; team_id: string; owner_id: string; created_by: string;
  device_name: string; expires_at: Date; consumed_at: Date | null; runner_id: string; created_at: Date;
}

interface RunnerRow extends RowDataPacket {
  id: string; team_id: string; owner_id: string; display_name: string; runner_status: LocalRunnerStatus;
  token_hash: string; token_fingerprint: string; hostname: string; platform_name: string;
  runner_version: string; codex_version: string; capabilities_json: unknown; workspaces_json: unknown;
  last_seen_at: Date | null; last_error: string; created_at: Date; updated_at: Date; revoked_at: Date | null;
}

interface TaskRow extends RowDataPacket {
  id: string; runner_id: string; team_id: string; owner_id: string; created_by: string; adapter: "codex";
  prompt_text: string; workspace_path: string; execution_mode: LocalRunnerTask["executionMode"];
  timeout_seconds: number; task_status: LocalRunnerTaskStatus; attempt_count: number; lease_hash: string;
  lease_expires_at: Date | null; cancel_requested_at: Date | null; result_text: string | null;
  error_message: string; output_truncated: number; codex_thread_id: string;
  created_at: Date; queued_at: Date; started_at: Date | null; finished_at: Date | null; updated_at: Date;
}

interface EventRow extends RowDataPacket {
  id: number; task_id: string; runner_id: string; team_id: string; owner_id: string;
  event_type: LocalRunnerTaskEvent["eventType"]; message: string; payload_json: unknown; created_at: Date;
}

const iso = (value: Date | string | null) => value ? new Date(value).toISOString() : "";
const mysqlDate = (value: string) => new Date(value);
const jsonArray = (value: unknown) => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
};
const jsonObject = (value: unknown) => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};

function mapPairing(row: PairingRow): LocalRunnerPairing {
  return {
    id: row.id, codeHash: row.code_hash, teamId: row.team_id, ownerId: row.owner_id,
    createdBy: row.created_by, deviceName: row.device_name, expiresAt: iso(row.expires_at),
    consumedAt: iso(row.consumed_at), runnerId: row.runner_id, createdAt: iso(row.created_at)
  };
}

function mapRunner(row: RunnerRow): LocalRunner {
  return {
    id: row.id, teamId: row.team_id, ownerId: row.owner_id, displayName: row.display_name,
    status: row.runner_status, tokenHash: row.token_hash, tokenFingerprint: row.token_fingerprint,
    hostname: row.hostname, platform: row.platform_name, runnerVersion: row.runner_version,
    codexVersion: row.codex_version, capabilities: jsonArray(row.capabilities_json),
    workspaces: jsonArray(row.workspaces_json), lastSeenAt: iso(row.last_seen_at),
    lastError: row.last_error, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    revokedAt: iso(row.revoked_at)
  };
}

function mapTask(row: TaskRow): LocalRunnerTask {
  return {
    id: row.id, runnerId: row.runner_id, teamId: row.team_id, ownerId: row.owner_id,
    createdBy: row.created_by, adapter: row.adapter, prompt: row.prompt_text,
    workspace: row.workspace_path, executionMode: row.execution_mode,
    timeoutSeconds: Number(row.timeout_seconds), status: row.task_status,
    attemptCount: Number(row.attempt_count), leaseHash: row.lease_hash,
    leaseExpiresAt: iso(row.lease_expires_at), cancelRequestedAt: iso(row.cancel_requested_at),
    resultText: row.result_text || "", errorMessage: row.error_message || "",
    outputTruncated: Boolean(row.output_truncated), codexThreadId: row.codex_thread_id || "",
    createdAt: iso(row.created_at), queuedAt: iso(row.queued_at), startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at), updatedAt: iso(row.updated_at)
  };
}

function mapEvent(row: EventRow): LocalRunnerTaskEvent {
  return {
    id: Number(row.id), taskId: row.task_id, runnerId: row.runner_id, teamId: row.team_id,
    ownerId: row.owner_id, eventType: row.event_type, message: row.message,
    payload: jsonObject(row.payload_json), createdAt: iso(row.created_at)
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

function visibilitySql(visibility: LocalRunnerVisibility, field = "owner_id") {
  const ownerIds = visibility.ownerIds?.filter(Boolean) || [];
  return ownerIds.length
    ? { sql: `team_id=? AND ${field} IN (${ownerIds.map(() => "?").join(",")})`, params: [visibility.teamId, ...ownerIds] }
    : { sql: "team_id=?", params: [visibility.teamId] };
}

export class MysqlLocalRunnerRepository implements LocalRunnerRepository {
  constructor(private readonly pool: Pool) {}

  async createPairing(pairing: LocalRunnerPairing) {
    await this.pool.execute(
      `INSERT INTO integration_local_runner_pairings
       (id,code_hash,team_id,owner_id,created_by,device_name,expires_at,consumed_at,runner_id,created_at)
       VALUES (?,?,?,?,?,?,?,NULL,'',?)`,
      [pairing.id, pairing.codeHash, pairing.teamId, pairing.ownerId, pairing.createdBy,
        pairing.deviceName, mysqlDate(pairing.expiresAt), mysqlDate(pairing.createdAt)]
    );
  }

  async consumePairing(input: ConsumePairingInput) {
    return transaction(this.pool, async (connection) => {
      const [rows] = await connection.query<PairingRow[]>(
        `SELECT * FROM integration_local_runner_pairings
         WHERE code_hash=? AND consumed_at IS NULL AND expires_at>NOW(3) LIMIT 1 FOR UPDATE`,
        [input.codeHash]
      );
      const pairing = rows[0];
      if (!pairing) return null;
      const runner = input.runner;
      await connection.execute(
        `INSERT INTO integration_local_runners
         (id,team_id,owner_id,display_name,runner_status,token_hash,token_fingerprint,hostname,
          platform_name,runner_version,codex_version,capabilities_json,workspaces_json,last_seen_at,
          last_error,created_at,updated_at,revoked_at)
         VALUES (?,?,?,?,'active',?,?,?,?,?,?,?,?,NOW(3),'',?,?,NULL)`,
        [runner.id, pairing.team_id, pairing.owner_id, runner.displayName, runner.tokenHash,
          runner.tokenFingerprint, runner.hostname, runner.platform, runner.runnerVersion,
          runner.codexVersion, JSON.stringify(runner.capabilities), JSON.stringify(runner.workspaces),
          mysqlDate(runner.createdAt), mysqlDate(runner.updatedAt)]
      );
      await connection.execute(
        `UPDATE integration_local_runner_pairings SET consumed_at=NOW(3),runner_id=? WHERE id=?`,
        [runner.id, pairing.id]
      );
      return mapPairing({ ...pairing, consumed_at: new Date(), runner_id: runner.id });
    });
  }

  async getRunner(id: string) {
    const [rows] = await this.pool.query<RunnerRow[]>("SELECT * FROM integration_local_runners WHERE id=? LIMIT 1", [id]);
    return rows[0] ? mapRunner(rows[0]) : null;
  }

  async listRunners(visibility: LocalRunnerVisibility) {
    const scoped = visibilitySql(visibility);
    const [rows] = await this.pool.query<RunnerRow[]>(
      `SELECT * FROM integration_local_runners WHERE ${scoped.sql} ORDER BY updated_at DESC LIMIT 100`, scoped.params
    );
    return rows.map(mapRunner);
  }

  async touchRunner(id: string, input: Partial<Pick<LocalRunner, "hostname" | "platform" | "runnerVersion" | "codexVersion" | "capabilities" | "workspaces" | "lastError">>) {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE integration_local_runners SET hostname=COALESCE(?,hostname),platform_name=COALESCE(?,platform_name),
       runner_version=COALESCE(?,runner_version),codex_version=COALESCE(?,codex_version),
       capabilities_json=COALESCE(?,capabilities_json),workspaces_json=COALESCE(?,workspaces_json),
       last_error=COALESCE(?,last_error),last_seen_at=NOW(3),updated_at=NOW(3)
       WHERE id=? AND runner_status='active'`,
      [input.hostname ?? null, input.platform ?? null, input.runnerVersion ?? null,
        input.codexVersion ?? null, input.capabilities ? JSON.stringify(input.capabilities) : null,
        input.workspaces ? JSON.stringify(input.workspaces) : null, input.lastError ?? null, id]
    );
    return result.affectedRows === 1;
  }

  async revokeRunner(id: string) {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE integration_local_runners SET runner_status='revoked',revoked_at=NOW(3),updated_at=NOW(3)
       WHERE id=? AND runner_status='active'`, [id]
    );
    if (result.affectedRows) {
      await this.pool.execute(
        `UPDATE integration_local_runner_tasks SET task_status='cancelled',finished_at=NOW(3),updated_at=NOW(3),
         error_message='Runner 已解除配对' WHERE runner_id=? AND task_status IN ('queued','running','cancelling')`, [id]
      );
    }
    return result.affectedRows === 1;
  }

  async createTask(task: LocalRunnerTask) {
    await this.pool.execute(
      `INSERT INTO integration_local_runner_tasks
       (id,runner_id,team_id,owner_id,created_by,adapter,prompt_text,workspace_path,execution_mode,
        timeout_seconds,task_status,attempt_count,lease_hash,lease_expires_at,cancel_requested_at,
        result_text,error_message,output_truncated,codex_thread_id,created_at,queued_at,started_at,finished_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'queued',0,'',NULL,NULL,'','',0,'',?,?,NULL,NULL,?)`,
      [task.id, task.runnerId, task.teamId, task.ownerId, task.createdBy, task.adapter,
        task.prompt, task.workspace, task.executionMode, task.timeoutSeconds,
        mysqlDate(task.createdAt), mysqlDate(task.queuedAt), mysqlDate(task.updatedAt)]
    );
  }

  async getTask(id: string) {
    const [rows] = await this.pool.query<TaskRow[]>("SELECT * FROM integration_local_runner_tasks WHERE id=? LIMIT 1", [id]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async listTasks(visibility: LocalRunnerVisibility, runnerId = "", limit = 100) {
    const scoped = visibilitySql(visibility);
    const [rows] = await this.pool.query<TaskRow[]>(
      `SELECT * FROM integration_local_runner_tasks WHERE ${scoped.sql}${runnerId ? " AND runner_id=?" : ""}
       ORDER BY created_at DESC LIMIT ?`,
      [...scoped.params, ...(runnerId ? [runnerId] : []), Math.max(1, Math.min(200, limit))]
    );
    return rows.map(mapTask);
  }

  async recoverStaleTasks(runnerId = "") {
    await this.pool.execute(
      `UPDATE integration_local_runner_tasks
       SET task_status=IF(attempt_count<2,'queued','failed'),
           error_message=IF(attempt_count<2,'','Runner 心跳超时，任务未能完成'),
           lease_hash='',lease_expires_at=NULL,
           queued_at=IF(attempt_count<2,NOW(3),queued_at),
           finished_at=IF(attempt_count<2,NULL,NOW(3)),updated_at=NOW(3)
       WHERE task_status IN ('running','cancelling') AND lease_expires_at<NOW(3)${runnerId ? " AND runner_id=?" : ""}`,
      runnerId ? [runnerId] : []
    );
  }

  async claimTask(runnerId: string, leaseHash: string, leaseExpiresAt: string) {
    return transaction(this.pool, async (connection) => {
      const [runnerRows] = await connection.query<RowDataPacket[]>(
        "SELECT id FROM integration_local_runners WHERE id=? AND runner_status='active' LIMIT 1 FOR UPDATE", [runnerId]
      );
      if (!runnerRows[0]) return null;
      const [activeRows] = await connection.query<Array<RowDataPacket & { count: number }>>(
        "SELECT COUNT(*) AS count FROM integration_local_runner_tasks WHERE runner_id=? AND task_status IN ('running','cancelling')", [runnerId]
      );
      if (Number(activeRows[0]?.count || 0) > 0) return null;
      const [rows] = await connection.query<TaskRow[]>(
        `SELECT * FROM integration_local_runner_tasks
         WHERE runner_id=? AND task_status='queued' ORDER BY queued_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [runnerId]
      );
      if (!rows[0]) return null;
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE integration_local_runner_tasks SET task_status='running',attempt_count=attempt_count+1,
         lease_hash=?,lease_expires_at=?,started_at=COALESCE(started_at,NOW(3)),updated_at=NOW(3)
         WHERE id=? AND task_status='queued'`,
        [leaseHash, mysqlDate(leaseExpiresAt), rows[0].id]
      );
      if (result.affectedRows !== 1) return null;
      const [claimed] = await connection.query<TaskRow[]>("SELECT * FROM integration_local_runner_tasks WHERE id=? LIMIT 1", [rows[0].id]);
      return claimed[0] ? mapTask(claimed[0]) : null;
    });
  }

  async heartbeatTask(taskId: string, runnerId: string, leaseHash: string, leaseExpiresAt: string) {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE integration_local_runner_tasks SET lease_expires_at=?,updated_at=NOW(3)
       WHERE id=? AND runner_id=? AND lease_hash=? AND task_status IN ('running','cancelling')`,
      [mysqlDate(leaseExpiresAt), taskId, runnerId, leaseHash]
    );
    if (result.affectedRows !== 1) return { ok: false, cancelRequested: false };
    const [rows] = await this.pool.query<Array<RowDataPacket & { task_status: LocalRunnerTaskStatus; cancel_requested_at: Date | null }>>(
      "SELECT task_status,cancel_requested_at FROM integration_local_runner_tasks WHERE id=? LIMIT 1", [taskId]
    );
    return { ok: true, cancelRequested: rows[0]?.task_status === "cancelling" || Boolean(rows[0]?.cancel_requested_at) };
  }

  async completeTask(input: CompleteLocalRunnerTaskInput) {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE integration_local_runner_tasks SET task_status=?,result_text=?,error_message=?,output_truncated=?,
       codex_thread_id=?,lease_hash='',lease_expires_at=NULL,finished_at=NOW(3),updated_at=NOW(3)
       WHERE id=? AND runner_id=? AND lease_hash=? AND task_status IN ('running','cancelling')`,
      [input.status, input.resultText, input.errorMessage, input.outputTruncated ? 1 : 0,
        input.codexThreadId, input.taskId, input.runnerId, input.leaseHash]
    );
    return result.affectedRows === 1;
  }

  async cancelTask(id: string) {
    await this.pool.execute(
      `UPDATE integration_local_runner_tasks
       SET finished_at=IF(task_status='queued',NOW(3),finished_at),
           task_status=IF(task_status='queued','cancelled','cancelling'),cancel_requested_at=NOW(3),updated_at=NOW(3)
       WHERE id=? AND task_status IN ('queued','running')`, [id]
    );
    return this.getTask(id);
  }

  async appendEvent(event: Omit<LocalRunnerTaskEvent, "id">) {
    await this.appendEvents([event]);
  }

  async appendEvents(events: Array<Omit<LocalRunnerTaskEvent, "id">>) {
    if (!events.length) return;
    const rows = events.slice(0, 50);
    await this.pool.execute(
      `INSERT INTO integration_local_runner_task_events
       (task_id,runner_id,team_id,owner_id,event_type,message,payload_json,created_at)
       VALUES ${rows.map(() => "(?,?,?,?,?,?,?,?)").join(",")}`,
      rows.flatMap((event) => [event.taskId, event.runnerId, event.teamId, event.ownerId, event.eventType,
        event.message, JSON.stringify(event.payload), mysqlDate(event.createdAt)])
    );
  }

  async listTaskEvents(taskId: string, limit = 200) {
    const [rows] = await this.pool.query<EventRow[]>(
      `SELECT * FROM integration_local_runner_task_events WHERE task_id=? ORDER BY id ASC LIMIT ?`,
      [taskId, Math.max(1, Math.min(500, limit))]
    );
    return rows.map(mapEvent);
  }
}
