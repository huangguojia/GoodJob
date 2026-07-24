import assert from "node:assert/strict";
import { parseMysqlDump } from "./mysql-dump-import.js";

const dump = [
  "-- MySQL dump 10.13",
  "CREATE TABLE `customers` (",
  "  `id` varchar(64) NOT NULL,",
  "  `company` varchar(255) NOT NULL,",
  "  `amount` decimal(18,2) DEFAULT NULL,",
  "  `payload` blob,",
  "  PRIMARY KEY (`id`)",
  ") ENGINE=InnoDB;",
  "DROP TABLE IF EXISTS `customers`;",
  "ALTER TABLE `customers` ADD COLUMN `unsafe` text;",
  "INSERT INTO `customers` VALUES",
  "('c1','Acme\\'s',12.30,0x4142),",
  "('c2','Line\\nTwo',NULL,X'4344');",
  "INSERT IGNORE INTO `customers` (`id`,`company`,`amount`,`payload`)",
  "VALUES ('c3','Third',0,b'1');"
].join("\n");

const result = parseMysqlDump(dump, 2);
assert.equal(result.rowCount, 3);
assert.equal(result.tableRows.customers, 3);
assert.equal(result.batches.length, 2);
assert.equal(result.ignoredStatements, 2);
assert.deepEqual(result.batches[0].columns, ["id", "company", "amount", "payload"]);
assert.deepEqual(result.batches[0].rows[0], ["c1", "Acme's", "12.30", { hex: "4142" }]);
assert.deepEqual(result.batches[0].rows[1], ["c2", "Line\nTwo", null, { hex: "4344" }]);
assert.deepEqual(result.batches[1].rows[0], ["c3", "Third", "0", 1]);

assert.throws(
  () => parseMysqlDump("CREATE TABLE `x` (`id` int); INSERT INTO `x` VALUES (NOW());"),
  /不支持的 MySQL 数据表达式/
);

console.log(JSON.stringify({ ok: true, rows: result.rowCount, ignoredStatements: result.ignoredStatements }));
