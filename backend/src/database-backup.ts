import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, stat, unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { createGzip } from "node:zlib";
import mysql, { type Pool } from "mysql2/promise";
import { MysqlDataImportError } from "./mysql-data-import.js";

export type DatabaseBackupStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";

export interface DatabaseMaintenanceEvent {
  id: string;
  at: string;
  level: "info" | "success" | "warning" | "error";
  stage: string;
  table: string;
  message: string;
}

export interface DatabaseBackupTableStat {
  status: "pending" | "running" | "completed" | "failed";
  rows: number;
  bytes: number;
}

export interface DatabaseBackupJob {
  id: string;
  actorId: string;
  status: DatabaseBackupStatus;
  phase: string;
  currentTable: string;
  totalTables: number;
  processedTables: number;
  estimatedRows: number;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  errorMessage: string;
  tableStats: Record<string, DatabaseBackupTableStat>;
  events: DatabaseMaintenanceEvent[];
  createdAt: string;
  completedAt: string;
}

const INTERNAL_TABLES = new Set([
  "goodjob_data_import_jobs",
  "goodjob_database_backup_jobs",
  "goodjob_schema_migrations"
]);
const activeBackups = new Map<string, { cancelled: boolean; child?: ChildProcess }>();

function booleanEnv(value: string | undefined, fallback = false) {
  if (value === undefined || value.trim() === "") return fallback;
  return /^(?:1|true|yes|on)$/iu.test(value.trim());
}

function integerEnv(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function mysqlLocalBackupConfig() {
  const enabled = booleanEnv(process.env.MYSQL_LOCAL_BACKUP_ENABLED, false);
  const directory = resolve(process.cwd(), process.env.MYSQL_LOCAL_BACKUP_DIR?.trim() || "../backups/database");
  const retentionDays = integerEnv(process.env.MYSQL_LOCAL_BACKUP_RETENTION_DAYS, 7, 0, 3650);
  return { enabled, directory, retentionDays };
}

function databaseUrl() {
  const value = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (!value) throw new MysqlDataImportError(503, "当前服务未配置 MySQL 数据库");
  return value;
}

function connectionConfig() {
  const url = new URL(databaseUrl());
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!database || !/^[A-Za-z0-9_$-]+$/u.test(database)) throw new Error("DATABASE_URL 缺少有效数据库名称");
  return {
    host: url.hostname || "127.0.0.1",
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database
  };
}

function createPool() {
  return mysql.createPool({ uri: databaseUrl(), connectionLimit: 2 });
}

async function ensureBackupSchema(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS goodjob_database_backup_jobs (
    id VARCHAR(64) PRIMARY KEY,
    actor_id VARCHAR(64) NOT NULL,
    backup_status VARCHAR(20) NOT NULL,
    phase VARCHAR(40) NOT NULL,
    current_table VARCHAR(128) NOT NULL DEFAULT '',
    total_tables INT UNSIGNED NOT NULL DEFAULT 0,
    processed_tables INT UNSIGNED NOT NULL DEFAULT 0,
    estimated_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
    file_name VARCHAR(255) NOT NULL DEFAULT '',
    file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
    file_sha256 CHAR(64) NOT NULL DEFAULT '',
    error_message VARCHAR(1000) NOT NULL DEFAULT '',
    table_stats_json JSON NULL,
    events_json JSON NULL,
    created_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NULL,
    INDEX idx_goodjob_backup_created(created_at),
    INDEX idx_goodjob_backup_status(backup_status)
  ) ENGINE=InnoDB`);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    if (typeof value === "string") return JSON.parse(value) as T;
    if (value && typeof value === "object") return value as T;
  } catch {
    // Corrupt task metadata must not prevent listing other jobs.
  }
  return fallback;
}

function rowToJob(row: Record<string, unknown>): DatabaseBackupJob {
  return {
    id: String(row.id || ""),
    actorId: String(row.actor_id || ""),
    status: ["queued", "running", "completed", "failed", "cancelled", "expired"].includes(String(row.backup_status))
      ? String(row.backup_status) as DatabaseBackupStatus
      : "failed",
    phase: String(row.phase || ""),
    currentTable: String(row.current_table || ""),
    totalTables: Number(row.total_tables || 0),
    processedTables: Number(row.processed_tables || 0),
    estimatedRows: Number(row.estimated_rows || 0),
    fileName: String(row.file_name || ""),
    fileSize: Number(row.file_size || 0),
    fileSha256: String(row.file_sha256 || ""),
    errorMessage: String(row.error_message || ""),
    tableStats: parseJson(row.table_stats_json, {}),
    events: parseJson(row.events_json, []),
    createdAt: new Date(String(row.created_at)).toISOString(),
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : ""
  };
}

async function getJobRow(pool: Pool, id: string) {
  await ensureBackupSchema(pool);
  const [rows] = await pool.query("SELECT * FROM goodjob_database_backup_jobs WHERE id=? LIMIT 1", [id]);
  const row = (rows as Array<Record<string, unknown>>)[0];
  if (!row) throw new MysqlDataImportError(404, "数据库备份任务不存在");
  return row;
}

export async function getDatabaseBackupJob(id: string) {
  const pool = createPool();
  try {
    return rowToJob(await getJobRow(pool, id));
  } finally {
    await pool.end();
  }
}

export async function listDatabaseBackupJobs(limit = 30) {
  const pool = createPool();
  try {
    await ensureBackupSchema(pool);
    const [rows] = await pool.query(
      "SELECT * FROM goodjob_database_backup_jobs ORDER BY created_at DESC LIMIT ?",
      [Math.max(1, Math.min(100, limit))]
    );
    return (rows as Array<Record<string, unknown>>).map(rowToJob);
  } finally {
    await pool.end();
  }
}

function maintenanceEvent(stage: string, message: string, input: Partial<DatabaseMaintenanceEvent> = {}): DatabaseMaintenanceEvent {
  return {
    id: `dbe_${randomUUID()}`,
    at: new Date().toISOString(),
    level: input.level || "info",
    stage,
    table: input.table || "",
    message
  };
}

async function updateJob(pool: Pool, id: string, patch: Partial<DatabaseBackupJob>, event?: DatabaseMaintenanceEvent) {
  const current = rowToJob(await getJobRow(pool, id));
  const events = event ? [...current.events, event].slice(-500) : current.events;
  const tableStats = patch.tableStats || current.tableStats;
  await pool.query(
    `UPDATE goodjob_database_backup_jobs SET
      backup_status=?, phase=?, current_table=?, total_tables=?, processed_tables=?, estimated_rows=?,
      file_name=?, file_size=?, file_sha256=?, error_message=?, table_stats_json=?, events_json=?,
      completed_at=? WHERE id=?`,
    [
      patch.status || current.status,
      patch.phase ?? current.phase,
      patch.currentTable ?? current.currentTable,
      patch.totalTables ?? current.totalTables,
      patch.processedTables ?? current.processedTables,
      patch.estimatedRows ?? current.estimatedRows,
      patch.fileName ?? current.fileName,
      patch.fileSize ?? current.fileSize,
      patch.fileSha256 ?? current.fileSha256,
      patch.errorMessage ?? current.errorMessage,
      JSON.stringify(tableStats),
      JSON.stringify(events),
      patch.completedAt ? new Date(patch.completedAt) : current.completedAt ? new Date(current.completedAt) : null,
      id
    ]
  );
}

async function dumpBinary() {
  const configured = process.env.MYSQLDUMP_BIN?.trim();
  const candidates = [configured, "/www/server/mysql/bin/mysqldump", "/usr/bin/mysqldump", "/usr/bin/mariadb-dump", "/opt/homebrew/bin/mysqldump"]
    .filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue with the next known installation path.
    }
  }
  return configured || "mysqldump";
}

async function writeStream(stream: NodeJS.WritableStream, value: string | Buffer) {
  if (stream.write(value)) return;
  await new Promise<void>((resolveWrite, rejectWrite) => {
    stream.once("drain", resolveWrite);
    stream.once("error", rejectWrite);
  });
}

async function runDump(
  jobId: string,
  binary: string,
  args: string[],
  password: string,
  output: NodeJS.WritableStream
) {
  const control = activeBackups.get(jobId);
  if (!control || control.cancelled) throw new MysqlDataImportError(409, "数据库备份已取消");
  const child = spawn(binary, args, {
    env: { ...process.env, MYSQL_PWD: password },
    stdio: ["ignore", "pipe", "pipe"]
  });
  control.child = child;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(stderr.trim() || `mysqldump 退出码 ${code ?? "-"}${signal ? `，信号 ${signal}` : ""}`));
    });
  });
  for await (const chunk of child.stdout) {
    if (control.cancelled) {
      child.kill("SIGTERM");
      throw new MysqlDataImportError(409, "数据库备份已取消");
    }
    await writeStream(output, chunk as Buffer);
  }
  await exited;
  control.child = undefined;
}

async function tableInventory(pool: Pool, allowedTables?: string[]) {
  const [rows] = await pool.query(`
    SELECT TABLE_NAME AS table_name, COALESCE(TABLE_ROWS, 0) AS table_rows
    FROM information_schema.tables
    WHERE table_schema=DATABASE() AND TABLE_TYPE='BASE TABLE'
    ORDER BY TABLE_NAME
  `);
  const allowed = allowedTables?.length ? new Set(allowedTables) : undefined;
  return (rows as Array<{ table_name: string; table_rows: number }>)
    .map((row) => ({ table: String(row.table_name), rows: Number(row.table_rows || 0) }))
    .filter((item) => /^[A-Za-z0-9_]+$/u.test(item.table) && !INTERNAL_TABLES.has(item.table) && (!allowed || allowed.has(item.table)));
}

async function sha256Path(path: string) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function cleanupExpiredBackups(pool: Pool) {
  const config = mysqlLocalBackupConfig();
  if (!config.retentionDays) return;
  const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000);
  const [rows] = await pool.query(
    "SELECT * FROM goodjob_database_backup_jobs WHERE backup_status='completed' AND completed_at < ?",
    [cutoff]
  );
  for (const row of rows as Array<Record<string, unknown>>) {
    const job = rowToJob(row);
    const path = resolve(config.directory, job.fileName);
    if (path.startsWith(`${config.directory}${sep}`)) await rm(path, { force: true });
    await updateJob(pool, job.id, { status: "expired", phase: "expired", fileSize: 0 }, maintenanceEvent("expired", "备份已按保留策略清理", { level: "warning" }));
  }
}

async function executeDatabaseBackup(jobId: string, allowedTables?: string[]) {
  const config = mysqlLocalBackupConfig();
  const pool = createPool();
  const partialPath = resolve(config.directory, `${jobId}.sql.gz.partial`);
  let finalPath = "";
  let gzip: ReturnType<typeof createGzip> | undefined;
  let file: ReturnType<typeof createWriteStream> | undefined;
  try {
    if (!config.enabled) throw new MysqlDataImportError(403, "服务器已禁止本地备份");
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    const connection = connectionConfig();
    const tables = await tableInventory(pool, allowedTables);
    if (!tables.length) throw new Error("当前数据库没有可备份的业务数据表");
    const timestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    const fileName = `goodjob-${connection.database}-${timestamp}.sql.gz`;
    finalPath = resolve(config.directory, fileName);
    const tableStats: Record<string, DatabaseBackupTableStat> = Object.fromEntries(
      tables.map((item) => [item.table, { status: "pending", rows: item.rows, bytes: 0 }])
    );
    await updateJob(pool, jobId, {
      status: "running",
      phase: "inventory",
      totalTables: tables.length,
      estimatedRows: tables.reduce((sum, item) => sum + item.rows, 0),
      fileName,
      tableStats
    }, maintenanceEvent("inventory", `已识别 ${tables.length} 张业务数据表`, { level: "success" }));

    gzip = createGzip({ level: 6 });
    file = createWriteStream(partialPath, { mode: 0o600 });
    gzip.pipe(file);
    const fileFinished = finished(file);
    await writeStream(gzip, `-- GoodJob CRM database backup\n-- Created at ${new Date().toISOString()}\nSET FOREIGN_KEY_CHECKS=0;\n`);
    const binary = await dumpBinary();
    const common = [
      `--host=${connection.host}`,
      `--port=${connection.port}`,
      `--user=${connection.user}`,
      "--protocol=tcp",
      "--default-character-set=utf8mb4",
      "--single-transaction",
      "--quick",
      "--skip-lock-tables",
      "--hex-blob",
      "--no-tablespaces",
      "--skip-comments"
    ];

    await updateJob(pool, jobId, { phase: "schema" }, maintenanceEvent("schema", "正在导出数据库结构"));
    await runDump(jobId, binary, [...common, "--no-data", connection.database, ...tables.map((item) => item.table)], connection.password, gzip);
    await updateJob(pool, jobId, { phase: "data" }, maintenanceEvent("schema", "数据库结构导出完成", { level: "success" }));

    for (let index = 0; index < tables.length; index += 1) {
      const control = activeBackups.get(jobId);
      if (!control || control.cancelled) throw new MysqlDataImportError(409, "数据库备份已取消");
      const item = tables[index]!;
      const before = await stat(partialPath).catch(() => ({ size: 0 }));
      tableStats[item.table] = { ...tableStats[item.table]!, status: "running" };
      await updateJob(pool, jobId, { phase: "data", currentTable: item.table, tableStats }, maintenanceEvent("table", `开始备份 ${item.table}`, { table: item.table }));
      await writeStream(gzip, `\n-- GoodJob table: ${item.table}\n`);
      await runDump(jobId, binary, [...common, "--no-create-info", "--skip-triggers", connection.database, item.table], connection.password, gzip);
      const after = await stat(partialPath).catch(() => ({ size: before.size }));
      tableStats[item.table] = { ...tableStats[item.table]!, status: "completed", bytes: Math.max(0, after.size - before.size) };
      await updateJob(pool, jobId, { processedTables: index + 1, currentTable: item.table, tableStats }, maintenanceEvent("table", `${item.table} 备份完成`, { table: item.table, level: "success" }));
    }
    await writeStream(gzip, "\nSET FOREIGN_KEY_CHECKS=1;\n");
    gzip.end();
    await fileFinished;
    await rename(partialPath, finalPath);
    const fileInfo = await stat(finalPath);
    const fileSha256 = await sha256Path(finalPath);
    await updateJob(pool, jobId, {
      status: "completed",
      phase: "completed",
      currentTable: "",
      processedTables: tables.length,
      fileSize: fileInfo.size,
      fileSha256,
      tableStats,
      completedAt: new Date().toISOString()
    }, maintenanceEvent("completed", `备份完成，文件大小 ${fileInfo.size} 字节`, { level: "success" }));
    await cleanupExpiredBackups(pool);
  } catch (error) {
    gzip?.destroy();
    file?.destroy();
    await rm(partialPath, { force: true }).catch(() => undefined);
    if (finalPath) await rm(finalPath, { force: true }).catch(() => undefined);
    const cancelled = error instanceof MysqlDataImportError && error.message.includes("取消");
    const message = error instanceof Error ? error.message : "数据库备份失败";
    await updateJob(pool, jobId, {
      status: cancelled ? "cancelled" : "failed",
      phase: cancelled ? "cancelled" : "failed",
      errorMessage: message,
      completedAt: new Date().toISOString()
    }, maintenanceEvent(cancelled ? "cancelled" : "failed", message, { level: cancelled ? "warning" : "error" })).catch(() => undefined);
  } finally {
    activeBackups.delete(jobId);
    await pool.end();
  }
}

export async function beginDatabaseBackup(input: { actorId: string; allowedTables?: string[] }) {
  const config = mysqlLocalBackupConfig();
  if (!config.enabled) throw new MysqlDataImportError(403, "服务器已禁止本地备份；部署者可通过 MYSQL_LOCAL_BACKUP_ENABLED=true 开启");
  const pool = createPool();
  try {
    await ensureBackupSchema(pool);
    const id = `dbb_${randomUUID()}`;
    const events = [maintenanceEvent("queued", "备份任务已进入队列")];
    await pool.query(
      `INSERT INTO goodjob_database_backup_jobs
       (id,actor_id,backup_status,phase,table_stats_json,events_json,created_at)
       VALUES (?,?,'queued','queued',JSON_OBJECT(),?,NOW(3))`,
      [id, input.actorId, JSON.stringify(events)]
    );
    activeBackups.set(id, { cancelled: false });
    void executeDatabaseBackup(id, input.allowedTables);
    return rowToJob(await getJobRow(pool, id));
  } finally {
    await pool.end();
  }
}

export async function cancelDatabaseBackup(id: string) {
  const pool = createPool();
  try {
    const job = rowToJob(await getJobRow(pool, id));
    if (!new Set<DatabaseBackupStatus>(["queued", "running"]).has(job.status)) return job;
    const control = activeBackups.get(id);
    if (control) {
      control.cancelled = true;
      control.child?.kill("SIGTERM");
    }
    await updateJob(pool, id, { status: "cancelled", phase: "cancelled", completedAt: new Date().toISOString() }, maintenanceEvent("cancelled", "管理员已取消备份", { level: "warning" }));
    return rowToJob(await getJobRow(pool, id));
  } finally {
    await pool.end();
  }
}

export async function databaseBackupDownload(id: string) {
  const config = mysqlLocalBackupConfig();
  if (!config.enabled) throw new MysqlDataImportError(403, "服务器已禁止本地备份下载");
  const job = await getDatabaseBackupJob(id);
  if (job.status !== "completed" || !job.fileName) throw new MysqlDataImportError(409, "备份文件尚未生成");
  const path = resolve(config.directory, job.fileName);
  if (!path.startsWith(`${config.directory}${sep}`)) throw new MysqlDataImportError(400, "备份文件路径无效");
  await access(path);
  return { job, path };
}

export async function deleteDatabaseBackup(id: string) {
  const config = mysqlLocalBackupConfig();
  if (!config.enabled) throw new MysqlDataImportError(403, "服务器已禁止本地备份管理");
  const pool = createPool();
  try {
    const job = rowToJob(await getJobRow(pool, id));
    if (["queued", "running"].includes(job.status)) throw new MysqlDataImportError(409, "运行中的备份不能删除，请先取消");
    if (job.fileName) {
      const path = resolve(config.directory, job.fileName);
      if (path.startsWith(`${config.directory}${sep}`)) await unlink(path).catch(() => undefined);
    }
    await pool.query("DELETE FROM goodjob_database_backup_jobs WHERE id=?", [id]);
    return { deleted: true };
  } finally {
    await pool.end();
  }
}
