import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import mysql from "mysql2/promise";

const projectRoot = resolve(import.meta.dirname, "..");

function parseEnv(path) {
  const result = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    result[trimmed.slice(0, index).trim()] = trimmed
      .slice(index + 1).trim().replace(/^["']|["']$/gu, "");
  }
  return result;
}

const results = [];
for (const [profile, file] of [
  ["personal", ".env.personal.local"],
  ["development", ".env.development.local"]
]) {
  const path = resolve(projectRoot, file);
  if (!existsSync(path)) {
    results.push({ profile, ok: false, error: `${file} 不存在` });
    continue;
  }
  const env = parseEnv(path);
  try {
    const connection = await mysql.createConnection(env.DATABASE_URL);
    const [[summary]] = await connection.query(`
      SELECT DATABASE() AS databaseName,
        (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_schema=DATABASE()) AS tableCount,
        (SELECT COUNT(*) FROM users) AS userCount
    `);
    await connection.end();
    results.push({
      profile,
      ok: true,
      database: summary.databaseName,
      tables: Number(summary.tableCount),
      users: Number(summary.userCount),
      seedDevelopmentData: env.CRM_SEED_DEVELOPMENT_DATA === "true"
    });
  } catch (error) {
    results.push({
      profile,
      ok: false,
      error: error instanceof Error ? error.message : "连接失败"
    });
  }
}

console.log(JSON.stringify({ ok: results.every((item) => item.ok), profiles: results }, null, 2));
if (results.some((item) => !item.ok)) process.exitCode = 1;

