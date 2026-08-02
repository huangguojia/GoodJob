import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";

export type MysqlImportConflictMode = "skip" | "overwrite";
export type MysqlImportValue = string | number | boolean | null | { hex: string };

export interface MysqlImportJobSummary {
  id: string;
  actorId: string;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  conflictMode: MysqlImportConflictMode;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: string;
  currentTable: string;
  totalTables: number;
  processedTables: number;
  totalRows: number;
  processedRows: number;
  importedRows: number;
  skippedRows: number;
  failedRows: number;
  tableStats: Record<string, { total: number; imported: number; skipped: number; failed: number }>;
  errorMessage: string;
  events: MysqlImportEvent[];
  createdAt: string;
  completedAt: string;
}

export interface MysqlImportEvent {
  id: string;
  at: string;
  level: "info" | "success" | "warning" | "error";
  stage: string;
  table: string;
  message: string;
}

const IMPORT_LOCK_NAME = "goodjob_mysql_data_import";
const INTERNAL_TABLES = new Set(["goodjob_data_import_jobs", "goodjob_schema_migrations"]);

function databaseUrl() {
  const value = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (!value) throw new Error("当前服务未配置 MySQL 数据库");
  return value;
}

function createImportPool() {
  return mysql.createPool({ uri: databaseUrl(), connectionLimit: 2 });
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

export function mysqlDataImportEnabled() {
  return Boolean(process.env.MYSQL_DATA_IMPORT_TOKEN?.trim());
}

export function assertMysqlDataImportToken(value: string | undefined) {
  const expected = process.env.MYSQL_DATA_IMPORT_TOKEN?.trim() || "";
  const supplied = value?.trim() || "";
  if (!expected || expected.length < 16) {
    throw new MysqlDataImportError(503, "数据库迁移尚未启用");
  }
  if (!supplied || !timingSafeEqual(digest(expected), digest(supplied))) {
    throw new MysqlDataImportError(403, "数据库迁移授权码不正确");
  }
}

export class MysqlDataImportError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function ensureImportSchema(pool: Pool | PoolConnection) {
  await pool.query(`CREATE TABLE IF NOT EXISTS goodjob_data_import_jobs (
    id VARCHAR(64) PRIMARY KEY,
    actor_id VARCHAR(64) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT UNSIGNED NOT NULL,
    file_sha256 CHAR(64) NOT NULL,
    conflict_mode VARCHAR(20) NOT NULL,
    import_status VARCHAR(20) NOT NULL,
    imported_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
    skipped_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
    failed_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
    table_stats_json JSON NULL,
    error_message VARCHAR(500) NULL,
    created_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NULL,
    INDEX idx_goodjob_import_actor_created(actor_id, created_at)
  ) ENGINE=InnoDB`);
  const additions: Array<[string, string]> = [
    ["phase", "VARCHAR(40) NOT NULL DEFAULT 'running'"],
    ["current_table", "VARCHAR(128) NOT NULL DEFAULT ''"],
    ["total_tables", "INT UNSIGNED NOT NULL DEFAULT 0"],
    ["processed_tables", "INT UNSIGNED NOT NULL DEFAULT 0"],
    ["total_rows", "BIGINT UNSIGNED NOT NULL DEFAULT 0"],
    ["processed_rows", "BIGINT UNSIGNED NOT NULL DEFAULT 0"],
    ["events_json", "JSON NULL"]
  ];
  const [columnRows] = await pool.query(
    "SELECT COLUMN_NAME AS column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='goodjob_data_import_jobs'"
  );
  const existing = new Set((columnRows as Array<{ column_name: string }>).map((row) => String(row.column_name)));
  for (const [column, definition] of additions) {
    if (!existing.has(column)) {
      try {
        await pool.query(`ALTER TABLE goodjob_data_import_jobs ADD COLUMN \`${column}\` ${definition}`);
      } catch (err: any) {
        // Ignore "Duplicate column name" errors (ER_DUP_FIELDNAME / errno 1060)
        // Can happen due to concurrent calls or information_schema caching
        if (err?.errno !== 1060 && err?.code !== 'ER_DUP_FIELDNAME') throw err;
      }
    }
  }
}

function importEvent(stage: string, message: string, input: Partial<MysqlImportEvent> = {}): MysqlImportEvent {
  return {
    id: `dbie_${randomUUID()}`,
    at: new Date().toISOString(),
    level: input.level || "info",
    stage,
    table: input.table || "",
    message
  };
}

function rowToSummary(row: Record<string, any>): MysqlImportJobSummary {
  let tableStats: MysqlImportJobSummary["tableStats"] = {};
  try {
    tableStats = typeof row.table_stats_json === "string"
      ? JSON.parse(row.table_stats_json)
      : row.table_stats_json || {};
  } catch {
    tableStats = {};
  }
  return {
    id: String(row.id),
    actorId: String(row.actor_id || ""),
    fileName: String(row.file_name),
    fileSize: Number(row.file_size || 0),
    fileSha256: String(row.file_sha256),
    conflictMode: row.conflict_mode === "overwrite" ? "overwrite" : "skip",
    status: row.import_status === "completed" ? "completed" : row.import_status === "failed" ? "failed" : row.import_status === "cancelled" ? "cancelled" : "running",
    phase: String(row.phase || row.import_status || "running"),
    currentTable: String(row.current_table || ""),
    totalTables: Number(row.total_tables || 0),
    processedTables: Number(row.processed_tables || 0),
    totalRows: Number(row.total_rows || 0),
    processedRows: Number(row.processed_rows || 0),
    importedRows: Number(row.imported_rows || 0),
    skippedRows: Number(row.skipped_rows || 0),
    failedRows: Number(row.failed_rows || 0),
    tableStats,
    errorMessage: String(row.error_message || ""),
    events: (() => {
      try {
        return typeof row.events_json === "string" ? JSON.parse(row.events_json) : row.events_json || [];
      } catch {
        return [];
      }
    })(),
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : ""
  };
}

export async function mysqlImportableSchema() {
  const pool = createImportPool();
  try {
    const [rows] = await pool.query(`
      SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
             EXTRA AS extra, COLUMN_KEY AS column_key, ORDINAL_POSITION AS ordinal_position
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `);
    const tables: Record<string, { columns: string[]; primaryKeys: string[] }> = {};
    for (const row of rows as Array<Record<string, any>>) {
      const table = String(row.table_name);
      if (INTERNAL_TABLES.has(table) || !/^[A-Za-z0-9_]+$/.test(table)) continue;
      const extra = String(row.extra || "").toLowerCase();
      if (extra.includes("generated")) continue;
      tables[table] ||= { columns: [], primaryKeys: [] };
      tables[table].columns.push(String(row.column_name));
      if (String(row.column_key) === "PRI") tables[table].primaryKeys.push(String(row.column_name));
    }
    return tables;
  } finally {
    await pool.end();
  }
}

export async function beginMysqlDataImport(input: {
  actorId: string;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  conflictMode: MysqlImportConflictMode;
  tableRows?: Record<string, number>;
  ignoredStatements?: number;
}) {
  const pool = createImportPool();
  try {
    await ensureImportSchema(pool);
    const id = `dbi_${randomUUID()}`;
    const tableRows = Object.fromEntries(Object.entries(input.tableRows || {})
      .filter(([table, rows]) => /^[A-Za-z0-9_]+$/u.test(table) && Number.isInteger(rows) && rows >= 0)
      .slice(0, 500));
    const tableStats = Object.fromEntries(Object.entries(tableRows).map(([table, total]) => [table, { total, imported: 0, skipped: 0, failed: 0 }]));
    const totalRows = Object.values(tableRows).reduce((sum, value) => sum + Number(value || 0), 0);
    const events = [importEvent("queued", `迁移任务已建立，共 ${Object.keys(tableRows).length} 张表、${totalRows} 条记录${input.ignoredStatements ? `，忽略 ${input.ignoredStatements} 条非数据语句` : ""}`)];
    await pool.query(
      `INSERT INTO goodjob_data_import_jobs
       (id, actor_id, file_name, file_size, file_sha256, conflict_mode, import_status,
        phase,current_table,total_tables,processed_tables,total_rows,processed_rows,
        imported_rows, skipped_rows, failed_rows, table_stats_json, events_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running','schema','',?,0,?,0,0,0,0,?,?,NOW(3))`,
      [
        id, input.actorId, input.fileName.slice(0, 255), input.fileSize, input.fileSha256, input.conflictMode,
        Object.keys(tableRows).length, totalRows, JSON.stringify(tableStats), JSON.stringify(events)
      ]
    );
    return getMysqlDataImport(id, input.actorId);
  } finally {
    await pool.end();
  }
}

export async function listMysqlDataImports(limit = 30) {
  const pool = createImportPool();
  try {
    await ensureImportSchema(pool);
    const [rows] = await pool.query("SELECT * FROM goodjob_data_import_jobs ORDER BY created_at DESC LIMIT ?", [Math.max(1, Math.min(100, limit))]);
    return (rows as Array<Record<string, any>>).map(rowToSummary);
  } finally {
    await pool.end();
  }
}

export async function getMysqlDataImport(id: string, actorId: string) {
  const pool = createImportPool();
  try {
    await ensureImportSchema(pool);
    const [rows] = await pool.query(
      "SELECT * FROM goodjob_data_import_jobs WHERE id = ? AND actor_id = ? LIMIT 1",
      [id, actorId]
    );
    const row = (rows as Array<Record<string, any>>)[0];
    if (!row) throw new MysqlDataImportError(404, "数据库迁移任务不存在");
    return rowToSummary(row);
  } finally {
    await pool.end();
  }
}

function decodeValue(value: MysqlImportValue) {
  if (value && typeof value === "object" && "hex" in value) {
    const hex = String(value.hex);
    if (!/^[0-9A-Fa-f]*$/.test(hex) || hex.length % 2 !== 0) {
      throw new MysqlDataImportError(400, "SQL 文件包含无效十六进制数据");
    }
    return Buffer.from(hex, "hex");
  }
  return value;
}

async function currentTableSchema(connection: PoolConnection, table: string) {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME AS column_name, EXTRA AS extra, COLUMN_KEY AS column_key
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?
     ORDER BY ORDINAL_POSITION`,
    [table]
  );
  const columns = new Map<string, { primary: boolean }>();
  for (const row of rows as Array<Record<string, any>>) {
    if (String(row.extra || "").toLowerCase().includes("generated")) continue;
    columns.set(String(row.column_name), { primary: String(row.column_key) === "PRI" });
  }
  return columns;
}

function mergeTableStats(
  current: MysqlImportJobSummary["tableStats"],
  table: string,
  imported: number,
  skipped: number,
  failed: number
) {
  const existing = current[table] || { total: 0, imported: 0, skipped: 0, failed: 0 };
  return {
    ...current,
    [table]: {
      imported: existing.imported + imported,
      skipped: existing.skipped + skipped,
      failed: existing.failed + failed,
      total: existing.total || 0
    }
  };
}

export async function importMysqlDataBatch(input: {
  jobId: string;
  actorId: string;
  table: string;
  columns: string[];
  rows: MysqlImportValue[][];
  tableComplete?: boolean;
}) {
  if (!/^[A-Za-z0-9_]+$/.test(input.table) || INTERNAL_TABLES.has(input.table)) {
    throw new MysqlDataImportError(400, "SQL 文件包含不允许导入的数据表");
  }
  if (!input.rows.length || input.rows.length > 100) {
    throw new MysqlDataImportError(400, "每个迁移批次必须包含 1 到 100 行数据");
  }
  if (!input.columns.length || input.columns.length > 300 || new Set(input.columns).size !== input.columns.length) {
    throw new MysqlDataImportError(400, "迁移字段列表无效");
  }
  const pool = createImportPool();
  const connection = await pool.getConnection();
  let lockAcquired = false;
  try {
    await ensureImportSchema(connection);
    const [lockRows] = await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [IMPORT_LOCK_NAME]);
    lockAcquired = Number((lockRows as Array<{ acquired: number }>)[0]?.acquired || 0) === 1;
    if (!lockAcquired) throw new MysqlDataImportError(409, "另一个数据库迁移任务正在执行");
    const [jobRows] = await connection.query(
      "SELECT * FROM goodjob_data_import_jobs WHERE id = ? AND actor_id = ? FOR UPDATE",
      [input.jobId, input.actorId]
    );
    const jobRow = (jobRows as Array<Record<string, any>>)[0];
    if (!jobRow || jobRow.import_status !== "running") {
      throw new MysqlDataImportError(409, "数据库迁移任务当前不可写入");
    }
    const schema = await currentTableSchema(connection, input.table);
    const summary = rowToSummary(jobRow);
    const startingTable = summary.currentTable !== input.table;
    const events = [...summary.events];
    if (startingTable) events.push(importEvent("table", `开始迁移 ${input.table}`, { table: input.table }));
    if (!schema.size) {
      const skipped = input.rows.length;
      const stats = mergeTableStats(summary.tableStats, input.table, 0, skipped, 0);
      if (input.tableComplete) events.push(importEvent("table", `${input.table} 在当前版本不存在，已跳过`, { table: input.table, level: "warning" }));
      await connection.query(
        `UPDATE goodjob_data_import_jobs SET skipped_rows=skipped_rows+?, processed_rows=processed_rows+?,
         processed_tables=processed_tables+?, phase='data', current_table=?, table_stats_json=?, events_json=? WHERE id=?`,
        [skipped, input.rows.length, input.tableComplete ? 1 : 0, input.table, JSON.stringify(stats), JSON.stringify(events.slice(-500)), input.jobId]
      );
      return { imported: 0, skipped, failed: 0, unsupported: true };
    }
    for (const column of input.columns) {
      if (!/^[A-Za-z0-9_]+$/.test(column) || !schema.has(column)) {
        throw new MysqlDataImportError(400, `数据表 ${input.table} 包含当前版本不存在的字段 ${column}`);
      }
    }
    for (const row of input.rows) {
      if (row.length !== input.columns.length) {
        throw new MysqlDataImportError(400, `数据表 ${input.table} 的字段与数据数量不一致`);
      }
    }
    const quotedColumns = input.columns.map((column) => `\`${column}\``).join(",");
    const valueGroup = `(${input.columns.map(() => "?").join(",")})`;
    const values = input.rows.flatMap((row) => row.map(decodeValue));
    const mode: MysqlImportConflictMode = jobRow.conflict_mode === "overwrite" ? "overwrite" : "skip";
    let sql = `${mode === "skip" ? "INSERT IGNORE" : "INSERT"} INTO \`${input.table}\` (${quotedColumns}) VALUES ${input.rows.map(() => valueGroup).join(",")}`;
    if (mode === "overwrite") {
      const updateColumns = input.columns.filter((column) => !schema.get(column)?.primary);
      if (updateColumns.length) {
        sql += ` ON DUPLICATE KEY UPDATE ${updateColumns.map((column) => `\`${column}\`=VALUES(\`${column}\`)`).join(",")}`;
      } else {
        sql = sql.replace(/^INSERT /, "INSERT IGNORE ");
      }
    }
    await connection.beginTransaction();
    await connection.query("SET FOREIGN_KEY_CHECKS=0");
    const [result] = await connection.query(sql, values);
    const affected = Number((result as ResultSetHeader).affectedRows || 0);
    const imported = mode === "skip" ? Math.min(input.rows.length, affected) : input.rows.length;
    const skipped = mode === "skip" ? Math.max(0, input.rows.length - imported) : 0;
    const stats = mergeTableStats(summary.tableStats, input.table, imported, skipped, 0);
    if (input.tableComplete) events.push(importEvent("table", `${input.table} 迁移完成：写入 ${stats[input.table]!.imported}，跳过 ${stats[input.table]!.skipped}`, { table: input.table, level: "success" }));
    await connection.query(
      `UPDATE goodjob_data_import_jobs
       SET imported_rows=imported_rows+?, skipped_rows=skipped_rows+?, processed_rows=processed_rows+?,
           processed_tables=processed_tables+?, phase='data', current_table=?, table_stats_json=?, events_json=?
       WHERE id=?`,
      [imported, skipped, input.rows.length, input.tableComplete ? 1 : 0, input.table, JSON.stringify(stats), JSON.stringify(events.slice(-500)), input.jobId]
    );
    await connection.commit();
    return { imported, skipped, failed: 0, unsupported: false };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // The original import error is more useful.
    }
    if (!(error instanceof MysqlDataImportError && error.status === 409)) {
      try {
        const [rows] = await connection.query(
          "SELECT * FROM goodjob_data_import_jobs WHERE id=? AND actor_id=? AND import_status='running' LIMIT 1",
          [input.jobId, input.actorId]
        );
        const row = (rows as Array<Record<string, any>>)[0];
        if (row) {
          const summary = rowToSummary(row);
          const stats = mergeTableStats(summary.tableStats, input.table, 0, 0, input.rows.length);
          const message = error instanceof Error ? error.message : "数据批次迁移失败";
          const events = [...summary.events, importEvent("table", message, { table: input.table, level: "error" })].slice(-500);
          await connection.query(
            `UPDATE goodjob_data_import_jobs SET failed_rows=failed_rows+?, processed_rows=processed_rows+?,
             current_table=?, table_stats_json=?, events_json=? WHERE id=?`,
            [input.rows.length, input.rows.length, input.table, JSON.stringify(stats), JSON.stringify(events), input.jobId]
          );
        }
      } catch {
        // Preserve the original batch failure even if audit persistence also fails.
      }
    }
    throw error;
  } finally {
    try {
      await connection.query("SET FOREIGN_KEY_CHECKS=1");
      if (lockAcquired) await connection.query("SELECT RELEASE_LOCK(?)", [IMPORT_LOCK_NAME]);
    } catch {
      // Releasing the connection also releases the advisory lock.
    }
    connection.release();
    await pool.end();
  }
}

export async function completeMysqlDataImport(jobId: string, actorId: string) {
  const pool = createImportPool();
  try {
    await ensureImportSchema(pool);
    const current = await getMysqlDataImport(jobId, actorId);
    const events = [...current.events, importEvent("completed", `迁移完成：写入 ${current.importedRows}，跳过 ${current.skippedRows}`, { level: "success" })].slice(-500);
    await pool.query(
      `UPDATE goodjob_data_import_jobs
       SET import_status='completed', phase='completed', current_table='', events_json=?, completed_at=NOW(3)
       WHERE id=? AND actor_id=? AND import_status='running'`,
      [JSON.stringify(events), jobId, actorId]
    );
    return getMysqlDataImport(jobId, actorId);
  } finally {
    await pool.end();
  }
}

export async function failMysqlDataImport(jobId: string, actorId: string, message: string) {
  const pool = createImportPool();
  try {
    await ensureImportSchema(pool);
    const current = await getMysqlDataImport(jobId, actorId);
    const events = [...current.events, importEvent("failed", message, { table: current.currentTable, level: "error" })].slice(-500);
    await pool.query(
      `UPDATE goodjob_data_import_jobs
       SET import_status='failed', phase='failed', error_message=?, events_json=?, completed_at=NOW(3)
       WHERE id=? AND actor_id=? AND import_status='running'`,
      [message.slice(0, 500), JSON.stringify(events), jobId, actorId]
    );
  } finally {
    await pool.end();
  }
}

export async function cancelMysqlDataImport(jobId: string, actorId: string) {
  const pool = createImportPool();
  try {
    await ensureImportSchema(pool);
    const current = await getMysqlDataImport(jobId, actorId);
    if (current.status !== "running") return current;
    const events = [...current.events, importEvent("cancelled", "管理员已取消迁移", { level: "warning" })].slice(-500);
    await pool.query(
      `UPDATE goodjob_data_import_jobs SET import_status='cancelled', phase='cancelled', events_json=?, completed_at=NOW(3)
       WHERE id=? AND actor_id=? AND import_status='running'`,
      [JSON.stringify(events), jobId, actorId]
    );
    return getMysqlDataImport(jobId, actorId);
  } finally {
    await pool.end();
  }
}
