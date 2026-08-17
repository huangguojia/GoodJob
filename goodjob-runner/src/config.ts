import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./types.js";

export function runnerConfigPath() {
  return process.env.GOODJOB_RUNNER_CONFIG || path.join(homedir(), ".goodjob", "runner.json");
}

export function normalizeServerUrl(raw: string) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("CRM 地址必须是有效的 HTTP 或 HTTPS 地址");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export async function normalizeWorkspace(raw: string) {
  const absolute = path.resolve(raw);
  const resolved = await realpath(absolute);
  return resolved.replace(/\/$/u, "") || "/";
}

export async function saveConfig(config: RunnerConfig) {
  const target = runnerConfigPath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function loadConfig() {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(runnerConfigPath(), "utf8"));
  } catch {
    throw new Error("尚未配对，请先在 CRM 创建配对码并执行 goodjob-runner pair");
  }
  const value = parsed as Partial<RunnerConfig>;
  if (!value.serverUrl || !value.runnerId || !value.token || !Array.isArray(value.workspaces) || !value.workspaces.length) {
    throw new Error("Runner 配置不完整，请重新配对");
  }
  return value as RunnerConfig;
}
