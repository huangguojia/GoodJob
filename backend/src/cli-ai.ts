import { spawn } from "node:child_process";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  AI_ENGINE_CODEX_MODEL_DEFAULT,
  AI_ENGINE_MUSE_MODEL_DEFAULT,
  aiEngineFallbackAdapters,
  readTeamAiEngineSettings,
  type AiEngineAdapter
} from "./ai-engine-settings.js";

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

// ---------------------------------------------------------------------------
// Codex CLI 直连（2026-11-05：WorkBuddy 能做的 CLI 任务，Codex 也要能做）
//
// 与 Runner 的 codex-adapter 同一种调用：`codex exec --json`，只读沙箱、在专属空目录里跑，
// 提示词走 stdin（`-`）。事件流是 JSONL：最后一个 agent_message 是答案，
// turn.failed / error 是失败。Codex 没有 --max-turns / --disallowedTools，
// 只读沙箱 + 空工作目录已经保证它不会改文件、也没有代码可探索。
// ---------------------------------------------------------------------------

/** ChatGPT 桌面端自带的 Codex（与 Runner 的 CHATGPT_CODEX_BINARY 一致） */
const CHATGPT_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";

/** 解析 Codex 可执行文件：显式指定 > GOODJOB_CODEX_BIN > PATH 里的 codex > ChatGPT 桌面端自带 > 裸名字 */
export function resolveCodexCliBinary(extraPath = ""): string {
  const explicit = extraPath.trim() || String(process.env.GOODJOB_CODEX_BIN || "").trim();
  // 显式指定就以它为准：不存在时交给调用方如实报「CLI 不存在」，
  // 否则用户把路径写错会静默跑起另一台 codex，错误信息还指向别处（2026-11-19 修）
  if (explicit) return explicit;
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "codex");
    if (existsSync(candidate)) return candidate;
  }
  if (osPlatform() === "darwin" && existsSync(CHATGPT_CODEX_BINARY)) return CHATGPT_CODEX_BINARY;
  return "codex";
}

/** 解析 Muse Code 可执行文件：显式指定 > GOODJOB_MUSE_BIN > 安装脚本默认目录 > PATH > 裸名字 */
export function resolveMuseCliBinary(extraPath = ""): string {
  const explicit = extraPath.trim() || String(process.env.GOODJOB_MUSE_BIN || "").trim();
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of [
    path.join(homedir(), ".local", "bin", "muse"),
    "/opt/homebrew/bin/muse",
    "/usr/local/bin/muse"
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "muse");
    if (existsSync(candidate)) return candidate;
  }
  return "muse";
}

/**
 * Muse 子进程环境：保留代理（国内访问 api.meta.ai 必需）、关掉 Contributor mode（客户资料不进训练集）、
 * PATH 补 ~/.local/bin（launchd 启动的后端 PATH 很短）。
 */
function museCliEnvironment(): NodeJS.ProcessEnv {
  const proxy = String(process.env.GOODJOB_MUSE_PROXY || "").trim();
  return {
    ...process.env,
    ...(proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy } : {}),
    PATH: [...new Set([path.join(homedir(), ".local", "bin"), ...String(process.env.PATH || "").split(path.delimiter)])].join(path.delimiter),
    NO_COLOR: "1",
    MUSE_CONTRIBUTOR_MODE: process.env.MUSE_CONTRIBUTOR_MODE ?? "0"
  };
}

/** 这台机器上某个 CLI 是否装着（能解析到一个真实存在的可执行文件） */
export function directCliAvailable(adapter: AiEngineAdapter): boolean {
  const binary = adapter === "codex" ? resolveCodexCliBinary() : adapter === "muse" ? resolveMuseCliBinary() : resolveCliBinary();
  return binary.includes(path.sep) && existsSync(binary);
}

/**
 * 直连通道用哪个 CLI：团队首选的装着就用它；没装就按替补顺序找一个装着的；
 * 都没装按首选执行（随后会如实报「CLI 不存在」）。
 */
export function resolveDirectCliAdapter(
  preferred: AiEngineAdapter,
  available: (adapter: AiEngineAdapter) => boolean = directCliAvailable
): AiEngineAdapter {
  if (available(preferred)) return preferred;
  const fallback = aiEngineFallbackAdapters(preferred).find((item) => available(item));
  return fallback || preferred;
}

/** 把 `codex exec --json` 的 JSONL 事件解析成终态 */
export function parseCodexStream(lines: string[]): ParsedCliStream {
  let text = "";
  let failed = false;
  let error = "";
  let completed = false;
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
    const item = recordOf(event.item);
    if (type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      text = clip(item.text);
      continue;
    }
    if (type === "turn.completed") {
      completed = true;
      continue;
    }
    if (type === "turn.failed" || type === "error") {
      failed = true;
      const detail = recordOf(event.error);
      error = clip(detail.message || event.message || event.error || "Codex CLI 返回失败", 2_000);
    }
  }
  // 有答案且回合正常结束时，以答案为准（中途的可恢复错误事件不算失败）
  if (text && completed) failed = false;
  return { text, model: "", failed, error };
}

async function runCodexSummary(
  prompt: string,
  options: { timeoutMs: number; binary?: string; model?: string; effort?: string }
): Promise<CliSummaryResult> {
  const binary = resolveCodexCliBinary(options.binary ?? "");
  if (binary.includes("/") && !existsSync(binary)) {
    throw new Error(`本机 Codex CLI 不存在（${binary}）`);
  }
  const model = String(options.model || "").trim();
  const effortMap: Record<string, string> = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
  const effort = effortMap[String(options.effort || "").trim().toLowerCase()] || "";
  const workspace = ensureWorkspace();
  const args = [
    ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    "exec",
    ...(model && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(model) ? ["-m", model] : []),
    "-C", workspace,
    "--sandbox", "read-only",
    "--skip-git-repo-check", "--json", "--color", "never", "--ephemeral", "-"
  ];
  const started = Date.now();
  const child = spawn(binary, args, {
    cwd: workspace,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" }
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
  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3_000);
    force.unref();
  }, options.timeoutMs);
  timeout.unref();
  child.stdin.on("error", () => undefined);
  child.stdin.end(prompt);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  output.close();
  if (timedOut) throw new Error(`本机 Codex CLI 执行超过 ${Math.round(options.timeoutMs / 1_000)} 秒，已停止`);
  if (exit.error) {
    if ((exit.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`本机 Codex CLI 不存在（未找到可执行文件 ${binary}；请安装 Codex CLI，或用 GOODJOB_CODEX_BIN 指定路径）`);
    }
    throw new Error(`本机 Codex CLI 无法启动（${binary}）：${exit.error.message}`);
  }
  const parsed = parseCodexStream(lines);
  if (parsed.failed) throw new Error(redact(parsed.error || stderr.trim() || `本机 Codex CLI 退出码 ${exit.code ?? exit.signal ?? "未知"}`));
  if (!parsed.text.trim()) {
    throw new Error(redact(stderr.trim() || "本机 Codex CLI 没有返回任何内容（常见原因：未登录，可执行 codex login）"));
  }
  return { text: parsed.text, model: model || "Codex 默认模型", durationMs: Date.now() - started };
}

/**
 * 把 `muse exec --json` 的 JSONL 事件解析成终态。
 * Muse 的事件 schema 未完全公开：按「助手文本字段优先、未知事件忽略」的宽容策略解析，
 * 全都认不出时由调用方回落到原始输出。
 */
export function parseMuseStream(lines: string[]): ParsedCliStream {
  let text = "";
  let streamed = "";
  let failed = false;
  let error = "";
  let model = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      continue;
    }
    const type = String(payload.type || payload.event || payload.kind || "");
    if (payload.model) model = String(payload.model);
    if (/error|fail/iu.test(type)) {
      const message = payload.message || (payload.error as Record<string, unknown> | undefined)?.message || payload.error;
      if (message) { failed = true; error = String(message).slice(0, 2_000); }
    }
    const delta = payload.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.text === "string") streamed += delta.text;
    for (const source of [payload, (payload.item || {}) as Record<string, unknown>]) {
      for (const key of ["text", "content", "output_text", "result"]) {
        const value = source[key];
        if (typeof value === "string" && value.trim() && /assistant|message|completion|final|result|response/iu.test(type)) {
          text = value;
        }
      }
    }
  }
  return { text: text || streamed, model, failed, error };
}

/** Muse Code 版的轻量总结：`muse exec --json "<prompt>"`，一次一答，不走 Runner。 */
async function runMuseSummary(
  prompt: string,
  options: { timeoutMs: number; binary?: string; model?: string }
): Promise<CliSummaryResult> {
  const binary = resolveMuseCliBinary(options.binary ?? "");
  if (binary.includes(path.sep) && !existsSync(binary)) {
    throw new Error(`本机 Muse Code 不存在（${binary}；安装：curl -fsSL https://dev.meta.ai/install.sh | bash）`);
  }
  const model = String(options.model || "").trim();
  const args = ["exec", "--json"];
  if (model) args.push("--model", model);
  args.push(prompt);

  const started = Date.now();
  const child = spawn(binary, args, {
    cwd: ensureWorkspace(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: museCliEnvironment()
  });

  const lines: string[] = [];
  let stderr = "";
  const output = readline.createInterface({ input: child.stdout });
  output.on("line", (line) => { if (lines.length < 5_000) lines.push(line); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 8_000); });

  let timedOut = false;
  const kill = (): void => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3_000);
    force.unref();
  };
  const timeout = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
  timeout.unref();

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  output.close();

  if (timedOut) throw new Error(`本机 Muse Code 执行超过 ${Math.round(options.timeoutMs / 1_000)} 秒，已停止`);
  if (exit.error) {
    if ((exit.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`本机 Muse Code 不存在（未找到可执行文件 ${binary}；安装后执行 muse auth set 或 muse login）`);
    }
    throw new Error(`本机 Muse Code 无法启动（${binary}）：${exit.error.message}`);
  }
  const parsed = parseMuseStream(lines);
  if (parsed.failed) throw new Error(redact(parsed.error || stderr.trim() || `本机 Muse Code 执行失败（退出码 ${exit.code ?? "未知"}）`));
  if (exit.code !== 0) {
    throw new Error(redact(stderr.trim() || `本机 Muse Code 退出码 ${exit.code ?? exit.signal ?? "未知"}`));
  }
  if (!parsed.text.trim()) {
    throw new Error(redact(stderr.trim() || "本机 Muse Code 没有返回任何内容（常见原因：未登录或网络不通，先执行 muse auth set 并确认能访问 api.meta.ai）"));
  }
  return { text: parsed.text, model: parsed.model || model || "Muse 默认模型", durationMs: Date.now() - started };
}

export interface CliSummaryOptions {
  timeoutMs?: number;
  binary?: string;
  /**
   * 传团队 ID 时按团队「AI 执行设置」选 CLI（首选的没装就自动改用另一个），
   * Codex 用团队配置的 codexModel / codexEffort。不传时保持原行为：WorkBuddy CLI。
   */
  teamId?: string;
  /** 直接指定 CLI（优先于 teamId 的设置；测试与特殊场景用） */
  adapter?: AiEngineAdapter;
}

/** 跑一次非交互 CLI 总结任务。失败抛错（含未登录这种「退出码 0」的隐性失败）。 */
export async function runCliSummary(prompt: string, options: CliSummaryOptions = {}): Promise<CliSummaryResult> {
  const timeoutMs = Math.max(10_000, options.timeoutMs ?? 120_000);
  let adapter: AiEngineAdapter = options.adapter ?? "workbuddy";
  let codexModel = AI_ENGINE_CODEX_MODEL_DEFAULT;
  let codexEffort = "";
  let museModel = AI_ENGINE_MUSE_MODEL_DEFAULT;
  if (!options.adapter && options.teamId) {
    const settings = await readTeamAiEngineSettings(options.teamId);
    adapter = resolveDirectCliAdapter(settings.cliAdapter);
    codexModel = settings.codexModel ?? AI_ENGINE_CODEX_MODEL_DEFAULT;
    codexEffort = settings.codexEffort ?? "";
    museModel = settings.museModel ?? AI_ENGINE_MUSE_MODEL_DEFAULT;
  }
  if (adapter === "muse") {
    return runMuseSummary(prompt, { timeoutMs, binary: options.binary, model: museModel });
  }
  if (adapter === "codex") {
    // 总结类任务讲究快：没配思考档位时用 low
    return runCodexSummary(prompt, { timeoutMs, binary: options.binary, model: codexModel, effort: codexEffort || "low" });
  }
  const binary = resolveCliBinary(options.binary ?? "");
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
