import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import mysql from "mysql2/promise";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceEnvPath = resolve(projectRoot, ".env");
const personalDatabase = "goodjob_crm_personal";
const developmentDatabase = "goodjob_crm_dev";
const adminUrl = "mysql://root@127.0.0.1:3306/mysql";

if (!existsSync(sourceEnvPath)) throw new Error("缺少现有 .env，无法识别待迁移数据库");

function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    result[trimmed.slice(0, index).trim()] = trimmed
      .slice(index + 1).trim().replace(/^["']|["']$/gu, "");
  }
  return result;
}

function encodeEnv(env) {
  return `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function mysqlUrl(user, password, database = "") {
  const url = new URL("mysql://127.0.0.1:3306/");
  url.username = user;
  url.password = password;
  url.pathname = database ? `/${database}` : "/";
  return url.toString();
}

function randomPassword() {
  return randomBytes(30).toString("base64url");
}

async function waitForExit(child, label) {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_000);
  });
  await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`${label}失败：${stderr.trim() || `退出码 ${code}`}`));
    });
  });
}

function dumpProcess(sourceUrl) {
  const url = new URL(sourceUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const child = spawn("/opt/homebrew/bin/mysqldump", [
    "--protocol=TCP",
    `--host=${url.hostname}`,
    `--port=${url.port || 3306}`,
    `--user=${decodeURIComponent(url.username)}`,
    "--single-transaction",
    "--routines",
    "--triggers",
    "--events",
    "--hex-blob",
    "--set-gtid-purged=OFF",
    database
  ], {
    env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return child;
}

async function backupDatabase(sourceUrl, backupPath) {
  const dump = dumpProcess(sourceUrl);
  await Promise.all([
    pipeline(dump.stdout, createGzip({ level: 9 }), createWriteStream(backupPath, { mode: 0o600 })),
    waitForExit(dump, "数据库备份")
  ]);
}

async function cloneDatabase(sourceUrl, targetDatabase) {
  const dump = dumpProcess(sourceUrl);
  const restore = spawn("/opt/homebrew/bin/mysql", [
    "--protocol=TCP",
    "--host=127.0.0.1",
    "--port=3306",
    "--user=root",
    `--database=${targetDatabase}`
  ], { stdio: ["pipe", "ignore", "pipe"] });
  dump.stdout.pipe(restore.stdin);
  await Promise.all([
    waitForExit(dump, "数据库复制导出"),
    waitForExit(restore, "数据库复制导入")
  ]);
}

const current = parseEnv(readFileSync(sourceEnvPath, "utf8"));
const sourceUrl = current.DATABASE_URL || current.MYSQL_URL;
if (!sourceUrl) throw new Error("现有 .env 没有 DATABASE_URL 或 MYSQL_URL");
const sourceDatabase = decodeURIComponent(new URL(sourceUrl).pathname.replace(/^\//u, ""));
if (!sourceDatabase || [personalDatabase, developmentDatabase].includes(sourceDatabase)) {
  throw new Error("源数据库必须是尚未拆分的现有数据库");
}

const admin = await mysql.createConnection(adminUrl);
const [existingRows] = await admin.query(
  "SELECT SCHEMA_NAME AS name FROM information_schema.schemata WHERE SCHEMA_NAME IN (?, ?)",
  [personalDatabase, developmentDatabase]
);
if (existingRows.length) {
  await admin.end();
  throw new Error(`目标数据库已存在，已停止：${existingRows.map((item) => item.name).join(", ")}`);
}
const localUsers = ["goodjob_personal", "goodjob_dev", "goodjob_test"];
const [existingUsers] = await admin.query(
  "SELECT User AS name FROM mysql.user WHERE User IN (?, ?, ?)",
  localUsers
);
if (existingUsers.length) {
  await admin.end();
  throw new Error(`目标数据库账号已存在，已停止：${existingUsers.map((item) => item.name).join(", ")}`);
}

const backupDir = resolve(projectRoot, "../../GoodJob_private/database-backups");
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const backupPath = resolve(backupDir, `${sourceDatabase}-${stamp}.sql.gz`);
console.log(`正在备份原始数据库 ${sourceDatabase}`);
await backupDatabase(sourceUrl, backupPath);
const backupHash = createHash("sha256").update(readFileSync(backupPath)).digest("hex");

const personalPassword = randomPassword();
const developmentPassword = randomPassword();
const testPassword = randomPassword();

await admin.query(
  `CREATE DATABASE \`${personalDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
);
console.log(`正在复制 ${sourceDatabase} 到 ${personalDatabase}`);
await cloneDatabase(sourceUrl, personalDatabase);

await admin.query(
  `CREATE DATABASE \`${developmentDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
);
const schema = readFileSync(resolve(projectRoot, "backend/schema.mysql.sql"), "utf8");
const schemaConnection = await mysql.createConnection({
  uri: adminUrl.replace(/\/mysql$/u, `/${developmentDatabase}`),
  multipleStatements: true
});
await schemaConnection.query(schema);
await schemaConnection.end();

for (const [user, password] of [
  ["goodjob_personal", personalPassword],
  ["goodjob_dev", developmentPassword],
  ["goodjob_test", testPassword]
]) {
  await admin.query(
    `CREATE USER '${user}'@'127.0.0.1' IDENTIFIED BY ?`,
    [password]
  );
}
await admin.query(
  `GRANT ALL PRIVILEGES ON \`${personalDatabase}\`.* TO 'goodjob_personal'@'127.0.0.1'`
);
await admin.query(
  `GRANT ALL PRIVILEGES ON \`${developmentDatabase}\`.* TO 'goodjob_dev'@'127.0.0.1'`
);
await admin.end();

const personalEnv = {
  ...current,
  APP_DATABASE_PROFILE: "personal",
  CRM_STORE: "mysql",
  CRM_SEED_DEVELOPMENT_DATA: "false",
  DATABASE_URL: mysqlUrl("goodjob_personal", personalPassword, personalDatabase),
  PORT: "4188",
  VITE_API_TARGET: "http://127.0.0.1:4188"
};
delete personalEnv.MYSQL_URL;

const developmentEnv = {
  ...current,
  APP_DATABASE_PROFILE: "development",
  CRM_STORE: "mysql",
  CRM_SEED_DEVELOPMENT_DATA: "true",
  DATABASE_URL: mysqlUrl("goodjob_dev", developmentPassword, developmentDatabase),
  PORT: "4190",
  VITE_API_TARGET: "http://127.0.0.1:4190"
};
delete developmentEnv.MYSQL_URL;

const testEnv = {
  ...current,
  APP_DATABASE_PROFILE: "test",
  CRM_STORE: "mysql",
  CRM_SEED_DEVELOPMENT_DATA: "true",
  MYSQL_TEST_ADMIN_URL: adminUrl,
  MYSQL_TEST_APP_URL: mysqlUrl("goodjob_test", testPassword)
};
delete testEnv.DATABASE_URL;
delete testEnv.MYSQL_URL;
delete testEnv.INITIAL_ADMIN_EMAIL;
delete testEnv.INITIAL_ADMIN_PASSWORD;
delete testEnv.INITIAL_ADMIN_NAME;

for (const [name, env] of [
  [".env.personal.local", personalEnv],
  [".env.development.local", developmentEnv],
  [".env.test.local", testEnv]
]) {
  const path = resolve(projectRoot, name);
  writeFileSync(path, encodeEnv(env), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

const sourceConnection = await mysql.createConnection(sourceUrl);
const personalConnection = await mysql.createConnection(personalEnv.DATABASE_URL);
const tables = ["users", "customers", "leads", "website_opportunities"];
const counts = {};
for (const table of tables) {
  const [[sourceCount]] = await sourceConnection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
  const [[personalCount]] = await personalConnection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
  counts[table] = {
    source: Number(sourceCount.count),
    personal: Number(personalCount.count)
  };
  if (counts[table].source !== counts[table].personal) {
    throw new Error(`${table} 复制后行数不一致`);
  }
}
await sourceConnection.end();
await personalConnection.end();

console.log(JSON.stringify({
  ok: true,
  sourceDatabase,
  personalDatabase,
  developmentDatabase,
  backupPath,
  backupSha256: backupHash,
  verifiedCounts: counts
}, null, 2));
