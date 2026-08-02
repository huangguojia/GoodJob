import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const projectRoot = resolve(import.meta.dirname, "..");
const forbiddenPath = /(?:^|\/)(?:\.env(?:\..+)?\.local|backups?|personal-data|\.wwebjs_auth|uploads|dist-packages)(?:\/|$)|\.(?:dump|db|sqlite|sql\.gz)$/iu;

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
  return state !== "I" && forbiddenPath.test(path);
});
if (unsafe.length) {
  console.error(`发现禁止提交的数据库或环境文件：\n${unsafe.join("\n")}`);
  process.exit(1);
}

const legacySql = readFileSync(
  resolve(projectRoot, "backend/goodjob_crm.full.sql"),
  "utf8"
);
if (!/CREATE DATABASE goodjob_crm_dev\b/u.test(legacySql)
  || /goodjob_crm_(?:personal|local)\b/u.test(legacySql)) {
  console.error("goodjob_crm.full.sql 只能初始化 goodjob_crm_dev");
  process.exit(1);
}

console.log("SVN 数据库安全检查通过：未发现个人配置、数据库备份或私有运行数据");
