import { spawn } from "node:child_process";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import path from "node:path";
import readline from "node:readline";

// ---------------------------------------------------------------------------
// CRM 后端直连本机 CodeBuddy CLI 的轻量通道（只服务「WhatsApp 跟进 AI 补全」这一个场景）。
//
// 为什么不用 Runner 重通道：Runner 的模型调用是为长任务设计的（事件流、任务记账、审批），
// 逐会话摘要用它既慢又绕（2026-10-15 用户拍板：跟进总结回归本机 CLI）。
// 这份实现是 whatsapp-plugin/src/server/services/cli-engine.ts 的精简移植——
// 那边踩过的环境坑（宿主注入变量劫持 CLI）是实测教训，清单必须逐字保留：
//  - spawn CLI 必须整族前缀剥 CODEBUDDY_/WORKBUDDY_/SERVER__/CLAUDE_，
//    黑名单剥不干净（残留 CODEBUDDY_CONFIG_DIR 就 error_during_execution）；
//  - CLI 未登录时退出码是 0，必须读 result 事件才发现失败；
//  - 提示词走 stdin，不走 argv（引号/换行/长度都会坏）。
// ---------------------------------------------------------------------------

/** WorkBuddy 桌面端内置 CLI（headless-only，无法 /login，只作兜底候选）。 */
const MAC_BUNDLED_BINARY = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";

/** WorkBuddy 托管 node 的全局 bin 目录（本机独立版 CLI 装在这里，launchd 受限 PATH 里没有它）。 */
function managedNodeCandidates(): string[] {
  try {
    const versionsRoot = path.join(homedir(), ".workbuddy", "binaries", "node", "versions");
    return readdirSync(versionsRoot)
      .sort()
      .reverse()
      .map((version) => path.join(versionsRoot, version, "bin", "codebuddy"));
  } catch {
    return [];
  }
}

/**
 * 解析 CLI 可执行文件。顺序：PATH（排除桌面内置版）> 托管 node bin > 桌面内置版 > 裸名字。
 * 独立版优先的原因与插件侧一致：桌面内置版 headless-only 且无法 /login。
 */
export function resolveCliBinary(extraPath = ""): string {
  const explicit = extraPath.trim();
  if (explicit && existsSync(explicit)) return explicit;
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "codebuddy");
    if (existsSync(candidate) && candidate !== MAC_BUNDLED_BINARY) return candidate;
  }
  for (const candidate of managedNodeCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  if (osPlatform() === "darwin" && existsSync(MAC_BUNDLED_BINARY)) return MAC_BUNDLED_BINARY;
  return "codebuddy";
}

/** 宿主注入的会话级工具链变量：整族前缀剔除。与插件 cli-engine.ts::STRIPPED_ENVIRONMENT_PREFIXES 同源。 */
const STRIPPED_ENVIRONMENT_PREFIXES = ["CODEBUDDY_", "WORKBUDDY_", "SERVER__", "CLAUDE_", "CLIENT_INFO_"];

/** 点名黑名单（整族之外还要剥的），与插件 cli-engine.ts::STRIPPED_ENVIRONMENT_KEYS 同源。 */
const STRIPPED_ENVIRONMENT_KEYS = [
  "NODE_OPTIONS", "BASH_ENV", "TRACEPARENT", "BAGGAGE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"
];

/**
 * CLI 子进程环境。**绝不**直接透传 process.env：launchd/宿主注入的一整族变量会把 CLI
 * 绑回宿主网关（--print 永久挂起）或劫持凭据目录（Authentication required）。
 */
export function cliProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const key of STRIPPED_ENVIRONMENT_KEYS) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (STRIPPED_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))) delete environment[key];
  }
  return { ...environment, NO_COLOR: "1", FORCE_COLOR: "0", NO_PROXY: "*", no_proxy: "*" };
}

/**
 * 出厂模型。deepseek-v4.1-flash 实测出稿最快（~9s）且稳，是插件时代沿用至今的默认档；
 * 账号默认（不传 --model）跨账号不一致，要稳定行为就显式指定。
 */
export const CLI_SUMMARY_MODEL = "deepseek-v4.1-flash";

/** 总结任务不需要任何工具；禁探索工具防 CLI 把自己当编码 Agent 去翻仓库（实测默认 178s/53 次调用）。 */
const CLI_DISALLOWED_TOOLS = ["Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"];

const MAX_RESULT_BYTES = 200_000;

export interface ParsedCliStream {
  text: string;
  model: string;
  failed: boolean;
  error: string;
}

/**
 * 把 stream-json 逐行事件解析成终态。语义与插件侧 parseCliStream 一致：
 * - result 是权威终态（subtype !== "success" 或 is_error 即失败，错误在 error/result/errors 三处兜底）；
 * - 没有 result 事件时退到 assistant 正文累积；
 * - 未登录的典型形态就是「退出码 0 + result.errors」。
 */
export function parseCliStream(lines: string[]): ParsedCliStream {
  let finalText = "";
  let accumulated = "";
  let model = "";
  let failed = false;
  let error = "";

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(event.type || "");
    if (type === "system") {
      const reported = String(event.model || "").trim();
      if (reported) model = reported;
      continue;
    }
    if (type === "result") {
      const isError = String(event.subtype || "") !== "success" || Boolean(event.is_error);
      const text = clip(event.result ?? event.text);
      if (text) finalText = text;
      if (isError) {
        failed = true;
        const errorList = Array.isArray(event.errors)
          ? event.errors.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
        error = clip(event.error || event.result || errorList[0] || "本机 CLI 返回失败", 2_000);
      }
      continue;
    }
    if (type === "assistant" || type === "message") {
      const text = contentText(event.content ?? recordOf(event.message).content);
      if (!text.trim()) continue;
      accumulated = accumulated ? `${accumulated}\n\n${text}` : text;
      continue;
    }
    if (type === "error") {
      failed = true;
      error = clip(event.error || event.message || "本机 CLI 返回错误", 2_000);
    }
  }

  return { text: finalText || accumulated, model, failed, error };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const value = recordOf(part);
      return typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function clip(value: unknown, maximum = MAX_RESULT_BYTES): string {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim().slice(0, maximum);
}

/** 空的专属工作目录：在仓库里跑 CLI 会让它去探索代码库（慢且不可预测）。 */
function ensureWorkspace(): string {
  const target = path.join(process.cwd(), ".data", "cli-workspace");
  try {
    mkdirSync(target, { recursive: true });
    return target;
  } catch {
    return process.cwd();
  }
}

export interface CliSummaryResult {
  text: string;
  model: string;
  durationMs: number;
}

/** 跑一次非交互 CLI 总结任务。失败抛错（含未登录这种「退出码 0」的隐性失败）。 */
export async function runCliSummary(prompt: string, options: { timeoutMs?: number; binary?: string } = {}): Promise<CliSummaryResult> {
  const binary = resolveCliBinary(options.binary ?? "");
  const timeoutMs = Math.max(10_000, options.timeoutMs ?? 120_000);
  if (binary.includes("/") && !existsSync(binary)) {
    throw new Error(`本机 CLI 不存在（${binary}）`);
  }
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--no-session-persistence",
    "--permission-mode", "plan",
    "--max-turns", "2",
    "--disallowedTools", CLI_DISALLOWED_TOOLS.join(","),
    "--model", CLI_SUMMARY_MODEL
  ];

  const started = Date.now();
  const child = spawn(binary, args, {
    cwd: ensureWorkspace(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: cliProcessEnvironment()
  });

  const lines: string[] = [];
  let stderr = "";
  const output = readline.createInterface({ input: child.stdout });
  output.on("line", (line) => {
    if (lines.length < 5_000) lines.push(line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 8_000);
  });

  let timedOut = false;
  const kill = (): void => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3_000);
    force.unref();
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  timeout.unref();

  child.stdin.on("error", () => undefined);
  child.stdin.end(prompt);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  output.close();

  if (timedOut) throw new Error(`本机 CLI 执行超过 ${Math.round(timeoutMs / 1_000)} 秒，已停止`);
  if (exit.error) throw new Error(`本机 CLI 无法启动（${binary}）：${exit.error.message}`);
  const parsed = parseCliStream(lines);
  if (parsed.failed) throw new Error(redact(parsed.error || stderr.trim() || `本机 CLI 退出码 ${exit.code ?? exit.signal ?? "未知"}`));
  if (!parsed.text.trim()) {
    throw new Error(redact(stderr.trim() || "本机 CLI 没有返回任何内容（常见原因：CLI 未登录）"));
  }
  return { text: parsed.text, model: parsed.model || CLI_SUMMARY_MODEL, durationMs: Date.now() - started };
}

function redact(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/\b(Bearer|Runner)\s+[A-Za-z0-9._-]{16,}\b/giu, "$1 [REDACTED]");
}
