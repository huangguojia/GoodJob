import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import {
  assertMysqlDataImportToken,
  beginMysqlDataImport,
  completeMysqlDataImport,
  importMysqlDataBatch,
  mysqlImportableSchema,
  MysqlDataImportError
} from "./mysql-data-import.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("mysql-data-import-test 需要 DATABASE_URL");
process.env.MYSQL_DATA_IMPORT_TOKEN ||= "goodjob-mysql-import-test-token-20260724";

assertMysqlDataImportToken(process.env.MYSQL_DATA_IMPORT_TOKEN);
assert.throws(
  () => assertMysqlDataImportToken("wrong-token"),
  (error) => error instanceof MysqlDataImportError && error.status === 403
);

const pool = mysql.createPool({ uri: url, connectionLimit: 1 });
await pool.query(`CREATE TABLE IF NOT EXISTS customers (
  id VARCHAR(64) PRIMARY KEY,
  company VARCHAR(255) NOT NULL,
  amount DECIMAL(18,2) NULL
) ENGINE=InnoDB`);

const schema = await mysqlImportableSchema();
assert.deepEqual(schema.customers.columns, ["id", "company", "amount"]);

const skipJob = await beginMysqlDataImport({
  actorId: "u_test",
  fileName: "old-goodjob.sql",
  fileSize: 1024,
  fileSha256: "a".repeat(64),
  conflictMode: "skip"
});
const first = await importMysqlDataBatch({
  jobId: skipJob.id,
  actorId: "u_test",
  table: "customers",
  columns: ["id", "company", "amount"],
  rows: [["c1", "Old Company", "10.50"]]
});
assert.deepEqual(first, { imported: 1, skipped: 0, failed: 0, unsupported: false });
const duplicate = await importMysqlDataBatch({
  jobId: skipJob.id,
  actorId: "u_test",
  table: "customers",
  columns: ["id", "company", "amount"],
  rows: [["c1", "Skipped Company", "99.00"]]
});
assert.equal(duplicate.imported, 0);
assert.equal(duplicate.skipped, 1);
const completedSkip = await completeMysqlDataImport(skipJob.id, "u_test");
assert.equal(completedSkip.importedRows, 1);
assert.equal(completedSkip.skippedRows, 1);

const overwriteJob = await beginMysqlDataImport({
  actorId: "u_test",
  fileName: "old-goodjob.sql",
  fileSize: 1024,
  fileSha256: "b".repeat(64),
  conflictMode: "overwrite"
});
const overwritten = await importMysqlDataBatch({
  jobId: overwriteJob.id,
  actorId: "u_test",
  table: "customers",
  columns: ["id", "company", "amount"],
  rows: [["c1", "New Company", "88.00"]]
});
assert.equal(overwritten.imported, 1);
await completeMysqlDataImport(overwriteJob.id, "u_test");

const [rows] = await pool.query("SELECT company, amount FROM customers WHERE id='c1'");
const customer = (rows as Array<Record<string, any>>)[0];
assert.equal(customer.company, "New Company");
assert.equal(Number(customer.amount), 88);

const [auditColumns] = await pool.query(
  "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='goodjob_data_import_jobs'"
);
assert.equal(
  (auditColumns as Array<{ COLUMN_NAME: string }>).some((row) => /content|sql|raw|data/i.test(row.COLUMN_NAME)),
  false
);

await pool.end();
console.log(JSON.stringify({ ok: true, skip: completedSkip, overwritten: overwritten.imported }));
