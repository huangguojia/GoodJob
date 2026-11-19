import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { assertBinlogDisabled, readBinlogStatus } from "./mysql-binlog-guard.js";

// mysql2 的 pool.query 返回 [rows, fields]
const fakePool = (logBin: unknown, version = "8.4.6") => ({
  calls: [] as string[],
  async query(sql: string) {
    this.calls.push(sql);
    return [[{ log_bin: logBin, version }], []];
  }
});

// 读取：兼容 0/1、"0"/"1"、"ON"/"OFF"
assert.equal((await readBinlogStatus(fakePool(0))).logBin, false);
assert.equal((await readBinlogStatus(fakePool("0"))).logBin, false);
assert.equal((await readBinlogStatus(fakePool("OFF"))).logBin, false);
assert.equal((await readBinlogStatus(fakePool(1))).logBin, true);
assert.equal((await readBinlogStatus(fakePool("1"))).logBin, true);
assert.equal((await readBinlogStatus(fakePool("ON"))).logBin, true);

// 关闭时：任何环境都直接通过，不打警告
for (const NODE_ENV of ["production", "development", "test"]) {
  const warnings: string[] = [];
  const status = await assertBinlogDisabled(fakePool(0), { env: { NODE_ENV }, warn: (m) => warnings.push(m) });
  assert.equal(status.logBin, false);
  assert.equal(warnings.length, 0);
}

// 开启时：生产拒绝启动，错误信息带修复方法
await assert.rejects(
  assertBinlogDisabled(fakePool(1), { env: { NODE_ENV: "production" }, warn: () => undefined }),
  (error: unknown) => error instanceof Error && /binlog/.test(error.message) && /--disable-log-bin/.test(error.message)
);

// 开启时：非生产只警告
for (const NODE_ENV of ["development", "test", undefined]) {
  const warnings: string[] = [];
  const status = await assertBinlogDisabled(fakePool("ON"), { env: { NODE_ENV }, warn: (m) => warnings.push(m) });
  assert.equal(status.logBin, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /skip-log-bin/);
}

// 查询失败（拿不到行）必须报错，不能静默当作关闭
await assert.rejects(readBinlogStatus({ async query() { return [[], []]; } }), /@@log_bin/);

// 部署配置必须显式关闭 binlog（防止有人删掉启动参数）
const compose = readFileSync(new URL("../../deploy/docker-compose/compose.yml", import.meta.url), "utf8");
const mysqlService = compose.slice(compose.indexOf("  mysql:"), compose.indexOf("\n  postgres:"));
assert.match(mysqlService, /^\s+- --disable-log-bin\s*$/mu, "compose.yml 的 mysql 服务必须带 --disable-log-bin");
assert.doesNotMatch(compose, /--log-bin(?!-)|log_bin\s*=\s*(1|ON)/iu, "compose.yml 不允许开启 binlog");
const windowsStart = readFileSync(new URL("../../scripts/windows/Start-GoodJob.ps1", import.meta.url), "utf8");
assert.match(windowsStart, /^skip-log-bin$/mu, "Windows 便携版 MariaDB 配置必须带 skip-log-bin");
const installScript = readFileSync(new URL("../../deploy/docker-compose/install.sh", import.meta.url), "utf8");
assert.match(installScript, /^assert_mysql_binlog_disabled$/mu, "安装/升级脚本必须验收 binlog 已关闭");

console.log(JSON.stringify({ ok: true, checked: "mysql-binlog-guard" }, null, 2));
