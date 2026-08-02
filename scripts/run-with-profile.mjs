import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const profile = String(process.argv[2] || "").trim();
const command = process.argv.slice(3);
const profileFiles = {
  personal: ".env.personal.local",
  development: ".env.development.local",
  test: ".env.test.local"
};

if (!(profile in profileFiles) || !command.length) {
  console.error(
    "用法：node scripts/run-with-profile.mjs "
    + "<personal|development|test> <command...>"
  );
  process.exit(2);
}

const projectRoot = resolve(import.meta.dirname, "..");
const envPath = resolve(projectRoot, profileFiles[profile]);
if (!existsSync(envPath)) {
  console.error(`缺少本地配置 ${profileFiles[profile]}，请先运行 npm run db:profiles:provision`);
  process.exit(2);
}

function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/gu, "");
    if (key) result[key] = value;
  }
  return result;
}

const profileEnv = parseEnv(readFileSync(envPath, "utf8"));
if (profileEnv.APP_DATABASE_PROFILE !== profile) {
  console.error(`${profileFiles[profile]} 的 APP_DATABASE_PROFILE 与启动档位不一致`);
  process.exit(2);
}

const childEnv = { ...process.env };
delete childEnv.DATABASE_URL;
delete childEnv.MYSQL_URL;
Object.assign(childEnv, profileEnv, {
  GOODJOB_ENV_FILE: envPath
});

const selectedDatabase = (() => {
  try {
    const rawUrl = profileEnv.DATABASE_URL || profileEnv.MYSQL_URL;
    return rawUrl ? decodeURIComponent(new URL(rawUrl).pathname.slice(1)) : "临时测试库";
  } catch {
    return "配置无效";
  }
})();
console.log(`GoodJob CRM 启动档位：${profile}；数据库：${selectedDatabase}`);

const child = spawn(command[0], command.slice(1), {
  cwd: projectRoot,
  env: childEnv,
  stdio: "inherit"
});
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

