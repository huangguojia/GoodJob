import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import mysql from "mysql2/promise";
import { parseMysqlDump } from "../../frontend/src/mysql-dump-import.js";
import {
  beginDatabaseBackup,
  deleteDatabaseBackup,
  getDatabaseBackupJob
} from "./database-backup.js";
import {
  beginMysqlDataImport,
  completeMysqlDataImport,
  failMysqlDataImport,
  getMysqlDataImport,
  importMysqlDataBatch,
  MysqlDataImportError
} from "./mysql-data-import.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("database-maintenance-mysql-test 需要 DATABASE_URL");

const originalEnabled = process.env.MYSQL_LOCAL_BACKUP_ENABLED;
const originalDirectory = process.env.MYSQL_LOCAL_BACKUP_DIR;
const originalRetention = process.env.MYSQL_LOCAL_BACKUP_RETENTION_DAYS;
const backupDirectory = await mkdtemp(join(tmpdir(), "goodjob-database-maintenance-"));
const table = `gj_maintenance_${Date.now().toString(36)}`;
const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 1 });
let backupId = "";
let importId = "";
let failureImportId = "";

try {
  process.env.MYSQL_LOCAL_BACKUP_ENABLED = "true";
  process.env.MYSQL_LOCAL_BACKUP_DIR = backupDirectory;
  process.env.MYSQL_LOCAL_BACKUP_RETENTION_DAYS = "1";

  await pool.query(`CREATE TABLE \`${table}\` (
    id VARCHAR(64) PRIMARY KEY,
    company VARCHAR(255) NOT NULL,
    amount DECIMAL(18,2) NOT NULL
  ) ENGINE=InnoDB`);
  await pool.query(
    `INSERT INTO \`${table}\` (id,company,amount) VALUES (?,?,?),(?,?,?),(?,?,?)`,
    ["m1", "Northwind Test", 12.5, "m2", "Atlas Test", 88, "m3", "Kanto Test", 305.75]
  );

  const started = await beginDatabaseBackup({ actorId: "u_database_maintenance_test", allowedTables: [table] });
  backupId = started.id;
  let backup = started;
  for (let attempt = 0; attempt < 300 && ["queued", "running"].includes(backup.status); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    backup = await getDatabaseBackupJob(backup.id);
  }
  assert.equal(backup.status, "completed", JSON.stringify(backup));
  assert.equal(backup.totalTables, 1);
  assert.equal(backup.processedTables, 1);
  assert.equal(backup.tableStats[table]?.status, "completed");
  assert.match(backup.fileName, /\.sql\.gz$/u);
  assert.match(backup.fileSha256, /^[0-9a-f]{64}$/u);
  const dump = gunzipSync(await readFile(join(backupDirectory, backup.fileName))).toString("utf8");
  assert.ok(dump.includes(`CREATE TABLE \`${table}\``));
  assert.match(dump, /Northwind Test/u);

  const plan = parseMysqlDump(dump, 2);
  assert.equal(plan.tableRows[table], 3);
  await pool.query(`TRUNCATE TABLE \`${table}\``);
  const importJob = await beginMysqlDataImport({
    actorId: "u_database_maintenance_test",
    fileName: backup.fileName,
    fileSize: backup.fileSize,
    fileSha256: backup.fileSha256,
    conflictMode: "overwrite",
    tableRows: plan.tableRows,
    ignoredStatements: plan.ignoredStatements
  });
  importId = importJob.id;
  const tableBatches = plan.batches.filter((batch) => batch.table === table);
  for (let index = 0; index < tableBatches.length; index += 1) {
    const batch = tableBatches[index]!;
    await importMysqlDataBatch({
      jobId: importJob.id,
      actorId: "u_database_maintenance_test",
      table: batch.table,
      columns: batch.columns,
      rows: batch.rows,
      tableComplete: index === tableBatches.length - 1
    });
  }
  const completed = await completeMysqlDataImport(importJob.id, "u_database_maintenance_test");
  assert.equal(completed.status, "completed");
  assert.equal(completed.processedRows, 3);
  assert.equal(completed.processedTables, 1);
  assert.equal(completed.importedRows, 3);
  assert.ok(completed.events.some((event) => event.stage === "completed"));

  const [rows] = await pool.query(`SELECT id,company,amount FROM \`${table}\` ORDER BY id`);
  assert.deepEqual((rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    company: String(row.company),
    amount: Number(row.amount)
  })), [
    { id: "m1", company: "Northwind Test", amount: 12.5 },
    { id: "m2", company: "Atlas Test", amount: 88 },
    { id: "m3", company: "Kanto Test", amount: 305.75 }
  ]);

  const failureJob = await beginMysqlDataImport({
    actorId: "u_database_maintenance_test",
    fileName: "invalid-columns.sql",
    fileSize: 128,
    fileSha256: "f".repeat(64),
    conflictMode: "skip",
    tableRows: { [table]: 1 }
  });
  failureImportId = failureJob.id;
  await assert.rejects(() => importMysqlDataBatch({
    jobId: failureJob.id,
    actorId: "u_database_maintenance_test",
    table,
    columns: ["id", "missing_column"],
    rows: [["invalid", "value"]],
    tableComplete: true
  }), /不存在的字段/u);
  await failMysqlDataImport(failureJob.id, "u_database_maintenance_test", "测试字段不兼容");
  const failedJob = await getMysqlDataImport(failureJob.id, "u_database_maintenance_test");
  assert.equal(failedJob.status, "failed");
  assert.equal(failedJob.failedRows, 1);
  assert.equal(failedJob.tableStats[table]?.failed, 1);
  assert.ok(failedJob.events.some((event) => event.level === "error" && event.table === table));

  process.env.MYSQL_LOCAL_BACKUP_ENABLED = "false";
  await assert.rejects(
    () => beginDatabaseBackup({ actorId: "u_database_maintenance_test", allowedTables: [table] }),
    (error) => error instanceof MysqlDataImportError && error.status === 403
  );
  process.env.MYSQL_LOCAL_BACKUP_ENABLED = "true";
  await deleteDatabaseBackup(backup.id);
  backupId = "";

  console.log(JSON.stringify({
    ok: true,
    realMysql: true,
    backedUpTables: 1,
    migratedRows: completed.importedRows,
    perTableEvents: completed.events.filter((event) => event.table === table).length,
    failureReasonPersisted: true,
    backupPolicyBlocked: true
  }));
} finally {
  await pool.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => undefined);
  if (importId) await pool.query("DELETE FROM goodjob_data_import_jobs WHERE id=?", [importId]).catch(() => undefined);
  if (failureImportId) await pool.query("DELETE FROM goodjob_data_import_jobs WHERE id=?", [failureImportId]).catch(() => undefined);
  if (backupId) {
    process.env.MYSQL_LOCAL_BACKUP_ENABLED = "true";
    await deleteDatabaseBackup(backupId).catch(() => undefined);
  }
  await pool.end();
  await rm(backupDirectory, { recursive: true, force: true });
  if (originalEnabled === undefined) delete process.env.MYSQL_LOCAL_BACKUP_ENABLED;
  else process.env.MYSQL_LOCAL_BACKUP_ENABLED = originalEnabled;
  if (originalDirectory === undefined) delete process.env.MYSQL_LOCAL_BACKUP_DIR;
  else process.env.MYSQL_LOCAL_BACKUP_DIR = originalDirectory;
  if (originalRetention === undefined) delete process.env.MYSQL_LOCAL_BACKUP_RETENTION_DAYS;
  else process.env.MYSQL_LOCAL_BACKUP_RETENTION_DAYS = originalRetention;
}
