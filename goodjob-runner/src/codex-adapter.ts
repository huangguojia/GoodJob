import { spawn } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import readline from "node:readline";
import type { ClaimedTask, TaskEventInput } from "./types.js";

const MAX_RESULT_BYTES = 200_000;
const MAX_EVENT_OUTPUT = 700;
const CHATGPT_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";

export interface CodexExecutionOptions {
  allowedWorkspaces: string[];
  signal: AbortSignal;
  onEvent(event: TaskEventInput): Promise<void>;
  codexBinary?: string;
  codexArgumentPrefix?: string[];
  browserMcpUrl?: string;
}

export interface CodexExecutionResult {
  status: "succeeded" | "failed" | "cancelled";
  resultText: string;
  errorMessage: string;
  outputTruncated: boolean;
  codexThreadId: string;
}

function redact(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_API_KEY]")
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

function executionEnvironment() {
  const candidates = [
    process.env.GOODJOB_CODE_MODE_HOST_DIR || "",
    "/Applications/ChatGPT.app/Contents/Resources",
    join(homedir(), ".codex", "plugins", ".plugin-appserver")
  ].filter((directory) => directory && existsSync(join(directory, "codex-code-mode-host")));
  const current = String(process.env.PATH || "").split(delimiter).filter(Boolean);
  const localHosts = "127.0.0.1,localhost";
  const noProxy = [localHosts, process.env.NO_PROXY || "", process.env.no_proxy || ""].filter(Boolean).join(",");
  return {
    ...process.env,
    PATH: [...new Set([...candidates, ...current])].join(delimiter),
    NO_COLOR: "1",
    NO_PROXY: noProxy,
    no_proxy: noProxy
  };
}

export function codexCodeModeHost(binary: string) {
  try {
    const host = join(dirname(realpathSync(binary)), "codex-code-mode-host");
    return existsSync(host) ? host : "";
  } catch {
    return "";
  }
}

export function resolveCodexBinary(configured = process.env.GOODJOB_CODEX_BIN || "codex") {
  if (codexCodeModeHost(configured)) return configured;
  if (process.platform === "darwin" && existsSync(CHATGPT_CODEX_BINARY) && codexCodeModeHost(CHATGPT_CODEX_BINARY)) {
    return CHATGPT_CODEX_BINARY;
  }
  return configured;
}

function mcpTitle(item: Record<string, unknown>) {
  const args = record(item.arguments);
  return oneLine(args.title || item.tool || item.name || "MCP 工具", 160);
}

function mcpStage(item: Record<string, unknown>) {
  const value = `${String(item.server || "")} ${String(item.tool || item.name || "")} ${mcpTitle(item)}`;
  return /goodjob_browser|playwright|browser|chrome|google|浏览器|网页|页面|搜索|标签页/iu.test(value) ? "browser" : "tool";
}

function taskPrompt(prompt: string, browserMcpUrl = "") {
  if (!browserMcpUrl) return prompt;
  return `本次任务已连接 GoodJob 独立受控浏览器 MCP，服务名为 goodjob_browser。
遇到打开网页、搜索、点击、输入、读取页面或保持页面打开等浏览器任务时，必须使用 goodjob_browser 提供的 Playwright 工具完成实际操作。
不要改用 browser@openai-bundled、chrome@openai-bundled、node_repl 或浏览器扩展。用户所说的“打开 Chrome/浏览器”默认指这个独立受控浏览器，除非用户明确要求操作其个人浏览器。
非浏览器任务不需要调用该工具。任务完成后不要主动关闭用户要求保留的页面。

用户任务：
${prompt}`;
}

function changedFileSummary(item: Record<string, unknown>) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths = changes.map((change) => oneLine(record(change).path || record(change).file || "", 180)).filter(Boolean);
  if (!paths.length) return "已生成文件修改";
  return `已修改 ${paths.length} 个文件：${paths.slice(0, 4).join("、")}${paths.length > 4 ? " 等" : ""}`;
}

function eventSummary(event: Record<string, unknown>): (TaskEventInput & { threadId?: string }) | null {
  const type = String(event.type || "");
  const item = record(event.item);
  if (type === "thread.started") return { eventType: "status", message: "Codex 会话已建立", payload: { stage: "session", status: "completed" }, threadId: String(event.thread_id || "") };
  if (type === "turn.started") return { eventType: "progress", message: "开始理解任务并规划执行步骤", payload: { stage: "analysis", status: "running" } };
  if (type === "turn.completed") {
    const usage = record(event.usage);
    const input = Number(usage.input_tokens || 0);
    const output = Number(usage.output_tokens || 0);
    const tokens = input || output ? ` · 输入 ${input.toLocaleString("zh-CN")} / 输出 ${output.toLocaleString("zh-CN")} tokens` : "";
    return { eventType: "progress", message: `本轮处理完成${tokens}`, payload: { stage: "usage", status: "completed", usage } };
  }
  if (type === "turn.failed") return { eventType: "error", message: clipped(record(event.error).message || "Codex 本轮执行失败", 2000), payload: { stage: "analysis", status: "failed" } };
  if (type === "item.started") {
    if (item.type === "command_execution") return { eventType: "progress", message: `正在执行：${oneLine(item.command || "本地命令")}`, payload: { stage: "command", status: "running", itemId: item.id } };
    if (item.type === "mcp_tool_call") {
      const stage = mcpStage(item);
      return { eventType: "progress", message: `正在${stage === "browser" ? "操作浏览器" : "调用工具"}：${mcpTitle(item)}`, payload: { stage, status: "running", server: item.server, tool: item.tool || item.name, itemId: item.id } };
    }
    if (item.type === "web_search") return { eventType: "progress", message: `正在联网搜索：${oneLine(item.query || item.text || "相关资料")}`, payload: { stage: "search", status: "running", itemId: item.id } };
    if (item.type === "file_change") return { eventType: "progress", message: "正在应用文件修改", payload: { stage: "file", status: "running", itemId: item.id } };
    return null;
  }
  if (type === "item.completed") {
    if (item.type === "command_execution") {
      const exitCode = String(item.exit_code ?? "-");
      const output = clipped(item.aggregated_output, MAX_EVENT_OUTPUT);
      return { eventType: exitCode === "0" ? "progress" : "warning", message: `命令执行完成（退出码 ${exitCode}）${output ? `\n${output}` : ""}`, payload: { stage: "command", status: exitCode === "0" ? "completed" : "failed", exitCode, itemId: item.id } };
    }
    if (item.type === "file_change") return { eventType: "progress", message: changedFileSummary(item), payload: { stage: "file", status: "completed", itemId: item.id } };
    if (item.type === "mcp_tool_call") {
      const stage = mcpStage(item);
      const failed = String(item.status || "") === "failed" || Boolean(item.error);
      const failure = clipped(record(item.error).message || item.error, 800);
      return { eventType: failed ? "error" : "progress", message: `${stage === "browser" ? "浏览器操作" : "工具调用"}${failed ? "失败" : "完成"}：${mcpTitle(item)}${failure ? `\n${failure}` : ""}`, payload: { stage, status: failed ? "failed" : "completed", server: item.server, tool: item.tool || item.name, itemId: item.id } };
    }
    if (item.type === "web_search") return { eventType: "progress", message: `联网搜索完成：${oneLine(item.query || item.text || "相关资料")}`, payload: { stage: "search", status: "completed", itemId: item.id } };
    if (item.type === "reasoning") {
      const summary = clipped(item.summary || item.text, 1200);
      return summary ? { eventType: "progress", message: summary, payload: { stage: "analysis", status: "completed", itemId: item.id } } : null;
    }
  }
  if (type === "error") return { eventType: "error", message: clipped(event.message || "Codex 返回错误", 2000), payload: { stage: "system", status: "failed" } };
  return null;
}

export async function executeCodexTask(task: ClaimedTask, options: CodexExecutionOptions): Promise<CodexExecutionResult> {
  if (task.adapter !== "codex") throw new Error("Runner 只允许执行 Codex 适配器任务");
  const workspace = await realpath(task.workspace);
  const allowed = await Promise.all(options.allowedWorkspaces.map((item) => realpath(item)));
  if (!allowed.includes(workspace)) throw new Error("任务工作目录不在本机 Runner 授权范围内");

  const binary = options.codexBinary || resolveCodexBinary();
  const args = [
    ...(options.codexArgumentPrefix || []),
    ...(options.browserMcpUrl ? ["-c", `mcp_servers.goodjob_browser.url=${JSON.stringify(options.browserMcpUrl)}`] : []),
    "--approve-for-me",
    "exec", "-C", workspace,
    "--sandbox", task.executionMode === "workspace_write" ? "workspace-write" : "read-only",
    "--skip-git-repo-check", "--json", "--color", "never", "--ephemeral", "-"
  ];
  const child = spawn(binary, args, {
    cwd: workspace,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: executionEnvironment()
  });

  let finalText = "";
  let stderr = "";
  let fallbackOutput = "";
  let codexThreadId = "";
  let outputTruncated = false;
  let turnCompleted = false;
  let completionStop: NodeJS.Timeout | null = null;
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
    fallbackOutput = append(fallbackOutput, `${line}\n`);
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started") codexThreadId = String(event.thread_id || "");
      if (event.type === "turn.completed") {
        turnCompleted = true;
        completionStop = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGTERM");
        }, 750);
        completionStop.unref();
      }
      const item = record(event.item);
      if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
        finalText = append("", item.text);
        send({ eventType: "output", message: item.text.slice(0, 8000), payload: { stage: "message", status: "completed", itemId: item.id } });
      } else {
        const summary = eventSummary(event);
        if (summary) send({ eventType: summary.eventType, message: summary.message, payload: summary.payload });
      }
    } catch {
      send({ eventType: "output", message: line.slice(0, 8000) });
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk.toString("utf8")); });

  let timedOut = false;
  let cancelled = options.signal.aborted;
  const stop = () => {
    cancelled = true;
    if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3_000);
    force.unref();
  };
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3_000);
    force.unref();
  }, Math.max(30, task.timeoutSeconds) * 1000);
  timeout.unref();

  child.stdin.end(taskPrompt(task.prompt, options.browserMcpUrl));
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  if (completionStop) clearTimeout(completionStop);
  options.signal.removeEventListener("abort", stop);
  output.close();
  await eventQueue;

  const resultText = redact(finalText || (exit.code === 0 ? fallbackOutput.trim() : ""));
  const errorMessage = redact(timedOut
    ? `Codex 执行超过 ${task.timeoutSeconds} 秒，已停止`
    : exit.error?.message || (exit.code === 0 || turnCompleted ? "" : stderr.trim() || `Codex CLI 退出码：${exit.code ?? exit.signal ?? "unknown"}`));
  return {
    status: cancelled ? "cancelled" : (exit.code === 0 || turnCompleted) && !timedOut ? "succeeded" : "failed",
    resultText,
    errorMessage,
    outputTruncated,
    codexThreadId
  };
}
