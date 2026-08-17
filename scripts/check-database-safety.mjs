import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const projectRoot = resolve(import.meta.dirname, "..");
const allowedSchemaPath = "backend/schema.mysql.sql";
const forbiddenPath = /(?:^|\/)(?:\.env(?:\..+)?\.local|backups?|personal-data|\.wwebjs_auth|uploads|dist-packages)(?:\/|$)|\.(?:dump|db|sqlite|sql|sql\.gz)$/iu;

let status = "";
try {
  status = execFileSync("svn", ["status", "--no-ignore"], {
    cwd: projectRoot,
    encoding: "utf8"
  });
} catch {
  console.log("当前目录不是 SVN 工作副本，跳过 SVN 状态检查");
  process.exit(0);
}

const unsafe = status.split(/\r?\n/u).filter(Boolean).filter((line) => {
  const state = line[0];
  const path = line.slice(8).trim();
  return !["D", "I"].includes(state) && path !== allowedSchemaPath && forbiddenPath.test(path);
});
if (unsafe.length) {
  console.error(`发现禁止提交的数据库或环境文件：\n${unsafe.join("\n")}`);
  process.exit(1);
}

const schemaSql = readFileSync(
  resolve(projectRoot, allowedSchemaPath),
  "utf8"
);
if (!/CREATE TABLE(?: IF NOT EXISTS)?\b/iu.test(schemaSql)
  || /goodjob_crm_(?:personal|local)\b/u.test(schemaSql)) {
  console.error("backend/schema.mysql.sql 必须是无个人数据库引用的结构文件");
  process.exit(1);
}

console.log("SVN 数据库安全检查通过：未发现个人配置、数据库备份或私有运行数据");
