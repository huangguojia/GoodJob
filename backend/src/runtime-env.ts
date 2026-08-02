import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadLocalEnv() {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(currentDir, "../..");
  const requested = String(process.env.GOODJOB_ENV_FILE || "").trim();
  const candidates = requested
    ? [
        resolve(projectRoot, requested),
        resolve(process.cwd(), requested)
      ]
    : [
        resolve(projectRoot, ".env"),
        resolve(process.cwd(), ".env")
      ];
  const envPath = candidates.find((path) => existsSync(path));
  if (requested && !envPath) {
    throw new Error(`指定的环境配置不存在：${requested}`);
  }
  if (!envPath) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
  process.env.GOODJOB_ENV_FILE = envPath;
}
