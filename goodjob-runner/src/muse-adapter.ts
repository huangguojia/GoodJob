import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import readline from "node:readline";
import type { ClaimedTask, TaskEventInput } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_RESULT_BYTES = 200_000;
const MAX_EVENT_OUTPUT = 700;
/** 超过这个字节数的提示词一律走 --prompt-file：命令行参数在 macOS/Linux 上都有 ARG_MAX 上限 */
const MAX_INLINE_PROMPT_BYTES = 64 * 1024;

/**
 * Muse Code（Meta 的终端 Agent，命令 `muse`）适配器。
 *
 * 设计依据（2026-11-19 查证 Meta 官方文档与实测记录）：
 *   - headless 入口是 `muse exec "<prompt>"`，`--prompt-file` 可读文件里的提示词，
 *     `--json` 让 stdout 输出 JSONL 事件流（含每轮结束的 run.usage 行）；
 *   - 退出码：0 完成 / 1 失败或取消 / 2 用法错误 / 130 SIGINT / 143 SIGTERM；
 *   - 认证：`META_API_KEY` > `muse auth set` 存的 key > 浏览器登录态（存在 ~/.config/muse）；
 *   - 沙箱：默认开 OS 沙箱 + 审批；`--disable-approval` 关审批但保留沙箱，
 *     `--sandbox-network` 控制出网（proxy-only / restricted / unrestricted）。
 *
 * 与 WorkBuddy / Codex 的差异，以及这里的处理：
 *   1. **模型命名完全不同**（muse-spark-1.3 / muse-wonder-1.0），所以复用提示词首行的
 *      `[[gj-cli-options {...}]]` 标记，但只取 model —— Muse 没有与 effort 对应的档位参数，
 *      传了也会被忽略，不如不传。
 *   2. **参数集合随版本变化**（`--disable-approval` 与 `--approval-mode` 两代写法并存）。
 *      因此启动前探一次 `muse exec --help`，只传 help 里真实存在的参数；探不到就退化成
 *      最小参数集（exec --json --prompt-file），宁可少传也不让整条任务因为未知参数直接退出。
 *   3. **事件 schema 未完全公开**（官方只说 JSONL）。解析器按「已知形态优先、未知原样入流」
 *      处理，绝不因为一条陌生事件丢掉最终答案。
 *   4. **国内网络**：Meta 域名常常不可直连。保留 Runner 进程继承来的代理变量，
 *      并支持 GOODJOB_MUSE_PROXY 显式指定（企业代理/本地代理都行），
 *      与 WorkBuddy 适配器「剥离本机代理」的策略相反 —— 那是为了避开宿主注入的会话级代理，
 *      Muse 没有这个问题，反而真的需要代理才能出网。
 */

export interface MuseExecutionOptions {
  allowedWorkspaces: string[];
  signal: AbortSignal;
  onEvent(event: TaskEventInput): Promise<void>;
  museBinary?: string;
  /** 测试注入：直接提供 exec 支持的命令行开关集合，跳过 help 探测 */
  knownFlags?: Set<string>;
}

export interface MuseExecutionResult {
  status: "succeeded" | "failed" | "cancelled";
  resultText: string;
  errorMessage: string;
  outputTruncated: boolean;
  /** 复用 Codex 的会话字段：这里存 Muse 的 session id（事件里带就记，不带为空） */
  codexThreadId: string;
}

export const MUSE_DEFAULT_MODEL = "muse-spark-1.3";
const MUSE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/** 与 Codex 适配器同源的档位标记前缀 */
const MUSE_PROFILE_PREFIX = "[[gj-cli-options";

export interface MuseCliProfile {
  model: string;
}

/**
 * 解析提示词首行的 `[[gj-cli-options {"model":"..."}]]` 标记。
 * 只认 model；effort / maxTurns / disallowedTools 对 Muse 无意义，直接丢弃。
 * 标记行一定从正文里剥掉（只剥标记本身，同一行后面的正文保留）。
 */
export function parseMuseCliProfile(prompt: string): { prompt: string; profile: MuseCliProfile } {
  const profile: MuseCliProfile = { model: "" };
  if (!prompt.startsWith(MUSE_PROFILE_PREFIX)) return { prompt, profile };
  const lineEnd = prompt.indexOf("\n");
  const header = lineEnd === -1 ? prompt : prompt.slice(0, lineEnd);
  const rest = lineEnd === -1 ? "" : prompt.slice(lineEnd + 1);
  let cut = header.indexOf("]]");
  cut = cut === -1 ? header.lastIndexOf("}") + 1 : cut + 2;
  const remainder = cut <= 0 ? "" : header.slice(cut).trim();
  const body = [remainder, rest].filter(Boolean).join("\n");
  const start = header.indexOf("{");
  const end = header.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(header.slice(start, end + 1)) as unknown;
      const model = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? String((parsed as Record<string, unknown>).model || "").trim()
        : "";
      if (MUSE_MODEL_PATTERN.test(model)) profile.model = model;
    } catch {
      // 标记损坏：按没有标记处理，正文照常执行
    }
  }
  return { prompt: body, profile };
}

/**
 * 解析 `muse exec --help` 里出现的命令行开关（形如 `--json`、`--approval-mode <mode>`）。
 * 单独导出便于离线单测：不同版本的 help 文本差异就是这里要吸收的东西。
 */
export function parseMuseExecFlags(helpText: string): Set<string> {
  const flags = new Set<string>();
  for (const match of helpText.matchAll(/(^|[\s,(])--([a-z][a-z0-9-]{1,40})/giu)) {
    flags.add(`--${match[2]}`);
  }
  return flags;
}

/** 解析可执行文件：GOODJOB_MUSE_BIN > PATH 里的 muse > 安装脚本默认落点 */
export function resolveMuseBinary(configured = process.env.GOODJOB_MUSE_BIN || "") {
  if (configured) return configured;
  const candidates = [
    join(homedir(), ".local", "bin", "muse"),
    "/opt/homebrew/bin/muse",
    "/usr/local/bin/muse"
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "muse";
}

/**
 * 子进程环境：
 * - 默认把 Contributor mode 关掉（MUSE_CONTRIBUTOR_MODE=0）：客户资料不能进模型训练集；
 * - 保留调用方设置的一切代理变量；GOODJOB_MUSE_PROXY 可显式覆盖（国内访问 Meta 必需）；
 * - PATH 补上安装脚本默认目录，避免 Runner 以 launchd 启动时 PATH 太瘦找不到 muse。
 */
export function museProcessEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const path = String(process.env.PATH || "").split(delimiter).filter(Boolean);
  const withLocalBin = [...new Set([join(homedir(), ".local", "bin"), ...path])].join(delimiter);
  const proxy = String(process.env.GOODJOB_MUSE_PROXY || "").trim();
  const proxyEnv: Record<string, string> = proxy
    ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy }
    : {};
  return {
    ...process.env,
    ...proxyEnv,
    ...extra,
    PATH: withLocalBin,
    NO_COLOR: "1",
    MUSE_CONTRIBUTOR_MODE: process.env.MUSE_CONTRIBUTOR_MODE ?? "0"
  };
}

/** 探测一次 `muse exec --help` 支持的开关；带缓存，失败返回空集合（= 只传最小参数集） */
let museFlagCache: { binary: string; flags: Set<string>; at: number } | null = null;
const MUSE_FLAG_TTL_MS = 30 * 60_000;

export async function detectMuseExecFlags(binary = resolveMuseBinary(), ttlMs = MUSE_FLAG_TTL_MS) {
  const now = Date.now();
  if (museFlagCache && museFlagCache.binary === binary && now - museFlagCache.at < ttlMs) return museFlagCache.flags;
  try {
    const { stdout, stderr } = await execFileAsync(binary, ["exec", "--help"], {
      timeout: 15_000,
      env: museProcessEnvironment()
    });
    const flags = parseMuseExecFlags(`${stdout}${stderr}`);
    museFlagCache = { binary, flags, at: now };
    return flags;
  } catch {
    // help 探测失败不影响主线：调用方会按最小参数集继续，真正的失败原因由执行阶段给出
    return new Set<string>();
  }
}

export interface MuseExecArgsInput {
  profile: MuseCliProfile;
  flags: Set<string>;
  executionMode: "read_only" | "workspace_write";
  promptFile?: string;
  prompt?: string;
}

/**
 * 组装 `muse exec` 参数。
 * 顺序刻意保持「子命令 → 开关 → prompt」，并把 --json 放在最前面：
 * 后面的开关即便被旧版本忽略，也不会影响事件流格式。
 */
export function buildMuseExecArgs(input: MuseExecArgsInput): string[] {
  const { profile, flags } = input;
  const args: string[] = ["exec", "--json"];
  // 关审批但保留沙箱：headless 没有 TTY，留着审批会直接卡住整个任务
  if (flags.has("--disable-approval")) args.push("--disable-approval");
  else if (flags.has("--approval-mode")) args.push("--approval-mode", "never");
  // 调研类任务要出网（搜客户官网、招标公告）；写文件类任务不需要，保持默认 proxy-only
  if (input.executionMode === "read_only" && flags.has("--sandbox-network")) args.push("--sandbox-network", "unrestricted");
  if (profile.model && flags.has("--model")) args.push("--model", profile.model);
  if (input.promptFile && flags.has("--prompt-file")) {
    args.push("--prompt-file", input.promptFile);
  } else if (input.prompt !== undefined) {
    args.push(input.prompt);
  }
  return args;
}

function redact(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/\bmk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_MODEL_KEY]")
    .replace(/\b(Bearer|Runner)\s+[A-Za-z0-9._-]{16,}\b/giu, "$1 [REDACTED]")
    .replace(/\bgjr_lrr_[A-Za-z0-9._-]+\b/gu, "[REDACTED_RUNNER_TOKEN]");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clipped(value: unknown, maximum = 800) {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim().slice(0, maximum);
}

function oneLine(value: unknown, maximum = 500) {
  return clipped(value, maximum * 2).replace(/\s+/gu, " ").slice(0, maximum);
}

/** 事件里可能承载「助手最终文本」的字段形态（官方 schema 未公开，按已知 agents 惯例宽容匹配） */
function textOf(item: Record<string, unknown>): string {
  for (const key of ["text", "content", "message", "output_text", "result"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const delta = record(item.delta);
  if (typeof delta.text === "string" && delta.text.trim()) return delta.text;
  return "";
}

export interface MuseEventSummary {
  event?: TaskEventInput;
  /** 完整的助手文本（一条事件给全量时进这里） */
  text?: string;
  /** 增量文本（流式 delta） */
  delta?: string;
  sessionId?: string;
  usage?: Record<string, unknown>;
  failed?: string;
}

/**
 * 单行 JSONL 事件 → 任务事件。
 * 认不出的事件不丢：返回原始一行作为 output 事件，方便在集成中心看到 CLI 到底在干什么。
 */
export function parseMuseEvent(line: string): MuseEventSummary {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    payload = record(parsed);
  } catch {
    return { event: { eventType: "output", message: line.slice(0, 8000) } };
  }
  const type = String(payload.type || payload.event || payload.kind || "");
  const item = record(payload.item);
  const sessionId = String(payload.session_id || payload.sessionId || record(payload.session).id || "");

  // 轮次用量（文档提到 `run.usage` 行）
  if (/^(run\.)?usage$/iu.test(type) || payload.usage) {
    const usage = record(payload.usage || payload);
    const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
    const output = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
    const tokens = input || output ? ` · 输入 ${input.toLocaleString("zh-CN")} / 输出 ${output.toLocaleString("zh-CN")} tokens` : "";
    return {
      sessionId,
      usage,
      event: { eventType: "progress", message: `本轮处理完成${tokens}`, payload: { stage: "usage", status: "completed", usage } }
    };
  }

  // 显式失败
  if (/error|fail/iu.test(type)) {
    const message = clipped(payload.message || record(payload.error).message || payload.error || "Muse 返回错误", 2000);
    return { sessionId, failed: message, event: { eventType: "error", message, payload: { stage: "system", status: "failed" } } };
  }

  // 工具调用 / 命令执行 / 联网搜索 / 文件修改：尽量给出人能读的进度
  const toolName = String(item.tool || item.name || payload.tool || payload.name || "");
  const target = oneLine(item.title || record(item.arguments).query || record(item.arguments).command || item.command || payload.query || "");
  if (/tool.*(start|call|begin)/iu.test(type) || (item.type === "tool_call" && /start/iu.test(type))) {
    const isWeb = /web|search|browse|http|fetch|浏览器|搜索/iu.test(`${toolName} ${target}`);
    return {
      sessionId,
      event: {
        eventType: "progress",
        message: `正在${isWeb ? "联网检索" : "调用工具"}：${oneLine(toolName || "工具", 120)}${target ? ` · ${target}` : ""}`,
        payload: { stage: isWeb ? "search" : "tool", status: "running", tool: toolName }
      }
    };
  }
  if (/command.*(start|exec)/iu.test(type) || item.type === "command_execution") {
    return {
      sessionId,
      event: {
        eventType: "progress",
        message: `正在执行：${oneLine(item.command || payload.command || "本地命令")}`,
        payload: { stage: "command", status: "running" }
      }
    };
  }

  // 助手文本：全量 / 增量两种形态
  const deltaText = typeof record(payload.delta).text === "string" ? String(record(payload.delta).text) : "";
  if (deltaText && /delta|chunk|partial/iu.test(type)) return { sessionId, delta: deltaText };

  const assistantTypes = /assistant|message|agent_message|completion|final|result|response/iu.test(type);
  const text = textOf(payload) || textOf(item);
  if (assistantTypes && text.trim()) {
    return {
      sessionId,
      text,
      event: { eventType: "output", message: text.slice(0, 8000), payload: { stage: "message", status: "completed" } }
    };
  }

  // 推理摘要（有就展示，没有不影响结果）
  if (/reasoning|thinking/iu.test(type)) {
    const summary = clipped(payload.summary || item.summary || text, 1200);
    return summary
      ? { sessionId, event: { eventType: "progress", message: summary, payload: { stage: "analysis", status: "completed" } } }
      : { sessionId };
  }

  const progress = payload.message || payload.status || "";
  return {
    sessionId,
    event: progress
      ? { eventType: "progress", message: oneLine(progress, 300), payload: { stage: "system", status: "running" } }
      : undefined
  };
}

export async function executeMuseTask(task: ClaimedTask, options: MuseExecutionOptions): Promise<MuseExecutionResult> {
  if (task.adapter !== "muse") throw new Error("Runner 只允许执行 Muse 适配器任务");
  const workspace = await realpath(task.workspace);
  const allowed = await Promise.all(options.allowedWorkspaces.map((item) => realpath(item)));
  if (!allowed.includes(workspace)) throw new Error("任务工作目录不在本机 Runner 授权范围内");

  const binary = options.museBinary || resolveMuseBinary();
  const { prompt: taskBody, profile } = parseMuseCliProfile(task.prompt);
  const flags = options.knownFlags || await detectMuseExecFlags(binary);

  // 长提示词走临时文件：lfind / 背调的提示词动辄几十 KB，塞进 argv 有 ARG_MAX 风险
  const promptTooLong = Buffer.byteLength(taskBody, "utf8") > MAX_INLINE_PROMPT_BYTES;
  const usePromptFile = flags.has("--prompt-file") && (promptTooLong || taskBody.length > 8_000);
  let promptDir = "";
  let promptFile = "";
  if (usePromptFile) {
    promptDir = mkdtempSync(join(tmpdir(), "goodjob-muse-"));
    promptFile = join(promptDir, "prompt.txt");
    writeFileSync(promptFile, taskBody, { encoding: "utf8", mode: 0o600 });
  }

  const args = buildMuseExecArgs({
    profile,
    flags,
    executionMode: task.executionMode,
    promptFile: usePromptFile ? promptFile : undefined,
    prompt: usePromptFile ? undefined : taskBody
  });

  const child = spawn(binary, args, {
    cwd: workspace,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: museProcessEnvironment()
  });

  let finalText = "";
  let streamedText = "";
  let stderr = "";
  let fallbackOutput = "";
  let sessionId = "";
  let outputTruncated = false;
  let sawUsage = false;
  let eventQueue = Promise.resolve();
  const send = (event: TaskEventInput) => {
    eventQueue = eventQueue.then(() => options.onEvent({ ...event, message: redact(event.message) })).catch(() => undefined);
  };
  const append = (current: string, value: string) => {
    const next = `${current}${value}`;
    if (Buffer.byteLength(next, "utf8") <= MAX_RESULT_BYTES) return next;
    outputTruncated = true;
    return Buffer.from(next, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8");
  };

  const output = readline.createInterface({ input: child.stdout });
  output.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    fallbackOutput = append(fallbackOutput, `${line}\n`);
    const summary = parseMuseEvent(trimmed);
    if (summary.sessionId) sessionId = summary.sessionId;
    if (summary.delta) streamedText = append(streamedText, summary.delta);
    if (summary.text) finalText = summary.text;
    if (summary.usage) sawUsage = true;
    if (summary.event) send(summary.event);
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk.toString("utf8")); });

  let timedOut = false;
  let cancelled = options.signal.aborted;
  const kill = () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3_000);
    force.unref();
  };
  const stop = () => { cancelled = true; kill(); };
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  const timeout = setTimeout(() => { timedOut = true; kill(); }, Math.max(30, task.timeoutSeconds) * 1000);
  timeout.unref();

  send({
    eventType: "status",
    message: `Muse Code 执行档位：${profile.model || "跟随 Muse 账号默认"}${task.executionMode === "read_only" ? " · 只读" : " · 可写"}`,
    payload: { stage: "profile", status: "running" }
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  options.signal.removeEventListener("abort", stop);
  output.close();
  await eventQueue;
  if (promptDir) rmSync(promptDir, { recursive: true, force: true });

  const text = (finalText || streamedText || (exit.code === 0 ? fallbackOutput.trim() : "")).trim();
  const resultText = redact(text);
  const exitHint = exit.code === 2
    ? "Muse CLI 参数错误（--version / --help 自查）"
    : exit.code === 130 || exit.code === 143
      ? "Muse 进程被信号终止"
      : `Muse CLI 退出码：${exit.code ?? exit.signal ?? "unknown"}`;
  const authHint = /unauthorized|authentication|401|login|not signed in|api key/iu.test(stderr) && !sawUsage
    ? "（像是没登录或 key 失效：在 Runner 那台机器执行 muse auth set 或 muse login）"
    : "";
  const errorMessage = redact(
    timedOut
      ? `Muse 执行超过 ${task.timeoutSeconds} 秒，已停止`
      : exit.error?.message
        || (exit.code === 0 ? "" : `${oneLine(stderr || exitHint, 1200)}${authHint}`)
  );

  return {
    status: cancelled ? "cancelled" : exit.code === 0 && !timedOut ? "succeeded" : "failed",
    resultText,
    errorMessage,
    outputTruncated,
    codexThreadId: sessionId
  };
}
