import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import type { ClaimedTask, TaskEventInput } from "./types.js";

const MAX_RESULT_BYTES = 200_000;
const MAX_EVENT_OUTPUT = 700;

/** WorkBuddy 桌面端自带的 CLI（CodeBuddy Code）在 macOS 上的固定位置 */
const MAC_BUNDLED_BINARY = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";

export interface WorkBuddyExecutionOptions {
  allowedWorkspaces: string[];
  signal: AbortSignal;
  onEvent(event: TaskEventInput): Promise<void>;
  workbuddyBinary?: string;
}

export interface WorkBuddyExecutionResult {
  status: "succeeded" | "failed" | "cancelled";
  resultText: string;
  errorMessage: string;
  outputTruncated: boolean;
  /** 复用 Codex 的会话字段：这里存 WorkBuddy CLI 的 session id */
  codexThreadId: string;
}

/**
 * 解析 WorkBuddy CLI 可执行文件：
 * 1) GOODJOB_WORKBUDDY_BIN 显式指定；
 * 2) macOS 上 WorkBuddy.app 自带的 codebuddy；
 * 3) 回退到 PATH 里的 codebuddy（未安装时版本探测会返回空，能力自动关闭）。
 */
export function resolveWorkbuddyBinary(configured = process.env.GOODJOB_WORKBUDDY_BIN || "") {
  if (configured) return configured;
  // 独立版 CLI（npm 安装，支持 /login 与完整 headless）优先；
  // 桌面端内置 CLI 是 headless-only 且无法 /login（2026-10-06 实锤：
  // 带着它会导致所有任务 Authentication required），只作最终兜底。
  try {
    const fromPath = execFileSync("which", ["codebuddy"], { encoding: "utf8" }).trim();
    if (fromPath && existsSync(fromPath) && fromPath !== MAC_BUNDLED_BINARY) return fromPath;
  } catch {
    // PATH 里没有 codebuddy，继续走桌面端内置兜底
  }
  if (osPlatform() === "darwin" && existsSync(MAC_BUNDLED_BINARY)) return MAC_BUNDLED_BINARY;
  return "codebuddy";
}

/**
 * 必须从子进程环境剔除的变量：
 * - NODE_OPTIONS：宿主会预加载补丁脚本，破坏全局 fetch；
 * - CODEBUDDY_IDE_PORT：在 WorkBuddy 内部启动时会把 CLI 的 IDE 端口顶掉（EADDRINUSE）；
 * - CODEBUDDY_SERVICE_PROXY_URL / CODEBUDDY_MCP_CONFIG：从 WorkBuddy 终端里启动 Runner 时，
 *   这两项会把 CLI 劫持回宿主的会话（挂起不返回），并把宿主会话级 MCP 及其 Bearer 凭据
 *   暴露给任务；Runner 必须是独立会话，一律清除。
 * - 会话标识类：同理，任务不应继承宿主的会话/追踪标识。
 * - SERVER__HOST / SERVER__PORT（根因，实测定位）：宿主会把这两个指向宿主网关的变量
 *   注入到子shell。带上它们时，CLI 不再走云端（apiKeySource=www.workbuddy.cn），
 *   而是去连桌面端宿主的网关；`--print` 非交互任务因此 **0 输出永久挂起**，
 *   直到任务超时（最坏 24 小时）。只删这两个变量即可恢复正常，属必修项。
 * - CODEBUDDY_HOST / CODEBUDDY_GATEWAY_* / CODEBUDDY_API_KEY_HELPER_DISABLED /
 *   CODEBUDDY_INTERNET_ENVIRONMENT：与上一条同族，都是把 CLI 绑到桌面端宿主网关的开关。
 * - ELECTRON_RUN_AS_NODE / CODEBUDDY_FORCE_HEADLESS_BUNDLE：宿主进程形态标记，
 *   会让 Electron 以纯 Node 形态启动，改变 CLI 的启动路径。
 * - BASH_ENV：宿主注入的 shell 前置脚本，会污染 CLI 自己拉起的 bash 子进程。
 */
const STRIPPED_ENVIRONMENT_KEYS = [
  "NODE_OPTIONS",
  // CLI 凭据目录：宿主会注入 CODEBUDDY_CONFIG_DIR=~/.workbuddy（桌面端集成登录态，
  // 可能已过期）。独立版 CLI 的登录凭据在默认 ~/.codebuddy（终端 /login 写入），
  // 必须剥掉宿主注入值让 CLI 回落默认目录，否则报 Authentication required。
  "CODEBUDDY_CONFIG_DIR",
  // 桌面端 PAC 代理 RPC：socket 按桌面会话生命周期存亡（workbuddy-pac-<PID>-*.sock）。
  // 桌面一重启旧 socket 即失效，CLI 子进程读到它会在 ProxyResolver L0 死等/ENOENT
  // （2026-10-06 实锤：400 connect ENOENT workbuddy-pac-82669-*.sock）。
  // 剥掉后 CLI 直连云网关，与终端独立运行行为一致。
  "WORKBUDDY_PAC_RPC_SOCKET",
  "WORKBUDDY_PAC_RPC_TOKEN",
  "CODEBUDDY_IDE_PORT",
  "CODEBUDDY_SERVICE_PROXY_URL",
  "CODEBUDDY_MCP_CONFIG",
  "CODEBUDDY_SESSION_ID",
  "CODEBUDDY_TOOL_CALL_ID",
  "CODEBUDDY_CONVERSATION_REQUEST_ID",
  "CODEBUDDY_CONVERSATION_MESSAGE_ID",
  "CODEBUDDY_ROOT_REQUEST_ID",
  "CLAUDE_SESSION_ID",
  "SERVER__HOST",
  "SERVER__PORT",
  "CODEBUDDY_HOST",
  "CODEBUDDY_GATEWAY_AUTH",
  "CODEBUDDY_GATEWAY_PASSWORD",
  "CODEBUDDY_API_KEY_HELPER_DISABLED",
  "CODEBUDDY_INTERNET_ENVIRONMENT",
  "ELECTRON_RUN_AS_NODE",
  "CODEBUDDY_FORCE_HEADLESS_BUNDLE",
  "CODEBUDDY_FORCE_LITE_WB_BUNDLE",
  "CODEBUDDY_ARTIFACTS",
  "BASH_ENV",
  "TRACEPARENT",
  "BAGGAGE"
];

/**
 * 指向本机的代理变量（HTTP_PROXY/HTTPS_PROXY/... 值为 127.0.0.1|localhost）。
 * 桌面端宿主会把**会话级**本地代理注入子 shell；Runner 是常驻服务，桌面端一重启
 * 代理端口就变，旧端口直接失联——CLI 的云流量走它必然失败，且报错为空、难以排查
 * （2026-10-06 实锤：CLI 返回 error result 但 error 字段为空，只落到兜底文案）。
 * 只剥「本机代理」：企业级远程代理（真正的出网代理）保留不动。
 */
const LOCAL_PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/**
 * 宿主注入的会话级工具链变量（安全删除代理、沙箱 broker、宿主客户端指纹）。
 * 这些只对宿主自身有意义，且带会话/进程 id，前缀匹配整族剔除。
 */
const STRIPPED_ENVIRONMENT_PREFIXES = [
  "CODEBUDDY_SAFE_DELETE_",
  "CODEBUDDY_SANDBOX_",
  "CODEBUDDY_BROKERED_",
  "CLIENT_INFO_"
];
export { STRIPPED_ENVIRONMENT_PREFIXES };

export function workbuddyProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED_ENVIRONMENT_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (STRIPPED_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key];
  }
  // 本机会话代理：桌面端重启后端口即失效，常驻 Runner 不继承
  for (const key of LOCAL_PROXY_KEYS) {
    const value = String(env[key] || "");
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/iu.test(value)) delete env[key];
  }
  // 系统代理兜底：macOS「系统设置 → 代理」可能残留已死端口（如 VPN 工具退出后没清理，
  // 2026-10-07 实锤：系统代理 127.0.0.1:29290 无进程监听，CLI 的 SystemProxyDetection
  // 跟着走导致 WebSearch/WebFetch 全部 fetch failed，获客诚实返回 0 家）。本机直连本就
  // 可用，显式 NO_PROXY 让 CLI 直连，不被死代理拖死；真需要远程代理时再由该代理工具自己恢复。
  return { ...env, NO_COLOR: "1", FORCE_COLOR: "0", NO_PROXY: "*", no_proxy: "*" };
}

/**
 * 把 CRM 的领域技能包（`.workbuddy/skills/`）注入 CLI 的技能扫描路径。
 *
 * 根因（2026-10-10 实测定位）：CLI（CodeBuddy Code）自己只扫描
 * `<cwd>/.codebuddy/skills/`、`~/.codebuddy/skills/` 与 connector 目录，
 * **不认 WorkBuddy 桌面版约定的 `.workbuddy/skills/`**。同仓对照实验：
 * 同时放 `.codebuddy/skills/goodjob-alpha` 与 `.workbuddy/skills/goodjob-beta`，
 * CLI 自报 alpha 已注册、beta MISSING。也就是说四个 goodjob 技能包虽然
 * 放在仓库里并进了版本控制，**在 CLI 任务中从未被加载过**（此前所有
 * 「技能评分/重写」都作用不到真实任务上）。
 *
 * CLI 提供 `CODEBUDDY_SESSION_SKILL_DIRS` 环境变量（值按 path.delimiter 分隔）
 * 用于显式追加技能目录，实测注入后四个技能全部注册成功。这里保持
 * `.workbuddy/skills/` 作为唯一来源：与桌面版共用同一份，由 Runner 在启动 CLI 时
 * 把路径喂过去。（技能内容自 2026-10-10 r42 起**不进版本库**，改为独立成品包
 * 分发——本函数只关心「目录在哪」，不关心它从哪来。）
 *
 * 覆盖顺序：`GOODJOB_SKILLS_DIRS`（部署方显式指定，支持多目录）> `<workspace>/.workbuddy/skills`。
 * 目录不存在时返回空串，不注入——让 CLI 保持默认行为，不因为一个空路径报错。
 */
export function workbuddySkillDirs(workspace: string): string {
  const configured = String(process.env.GOODJOB_SKILLS_DIRS || "").trim();
  if (configured) return configured;
  const local = join(workspace, ".workbuddy", "skills");
  return existsSync(local) ? local : "";
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

/** 从 content（字符串或分片数组）中抽取文本 */
function textOf(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const value = record(part);
      if (typeof value.text === "string") return value.text;
      if (typeof value.content === "string") return value.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 把 content 里的工具调用抽成进度事件 */
function toolEvents(content: unknown): TaskEventInput[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const value = record(part);
    if (value.type !== "tool_use") return [];
    const name = oneLine(value.name || "工具", 80);
    const input = record(value.input);
    const detail = oneLine(input.command || input.file_path || input.path || input.pattern || input.query || "", 160);
    return [{
      eventType: "progress" as const,
      message: `正在调用工具：${name}${detail ? `（${detail}）` : ""}`,
      payload: { stage: /bash|shell|command/iu.test(name) ? "command" : "tool", tool: name }
    }];
  });
}

/**
 * 任务级 CLI 快速模式。
 *
 * 背景（2026-10-10 实测）：LLM 抽取类任务（如新增客户的资料识别）如果放任默认参数，
 * CLI 会把自己当成「仓库里的编码 Agent」——为了理解字段含义去 Grep/Glob/Agent/WebFetch
 * 探索整个工作目录。同一条提示词实测：默认参数 178 秒 / 53 次工具调用，加 --effort low 后
 * 19.6 秒 / 3 次工具调用，加 --max-turns 6 后最短 7.8 秒，字段质量完全一致。
 *
 * 因此允许任务在提示词**首行**声明一个执行档位标记，Runner 会把它翻译成 CLI 参数、
 * 并把标记行从真正喂给 CLI 的提示词里剥掉：
 *
 *   [[gj-cli-options {"effort":"low","maxTurns":6,"disallowedTools":["Write","Edit","Glob","Grep","WebFetch","WebSearch","Agent"]}]]
 *   你是外贸 CRM 的客户资料录入助手……
 *
 * 标记行必须以 `[[gj-cli-options` 开头（紧跟换行）。取值一律走白名单：非法取值静默忽略，
 * 不会把任意字符串透传给 CLI。这是「强约束」而非「开权限」——只做减法（更省、更少工具）。
 */
export interface WorkbuddyCliProfile {
  effort: string;
  model: string;
  maxTurns: number;
  disallowedTools: string[];
}

const CLI_PROFILE_PREFIX = "[[gj-cli-options";
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_IDS = new Set([
  "fast-model", "balanced-model", "deep-model",
  "hy4-preview-f", "hy4-preview", "hy3", "hy3-x", "space-bunny",
  "deepseek-v4.1-flash", "deepseek-v4-pro",
  "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo",
  "minimax-m3", "kimi-k3-1", "kimi-k2.8-preview", "kimi-k2.7", "kimi-k2.6"
]);
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;

/** 解析提示词首行的执行档位标记，返回剥离后的提示词与（白名单过滤后的）档位 */
/**
 * 剥掉协议头，返回真正的提示词。
 * ⚠️ 只剥标记本身，**不能把整行吞掉**：标记和正文写在同一行时（`[[gj-cli-options {...}]] 正文`），
 * 整行剥离会把真正的提示词变成空串，CLI 拿到空提示 29ms 就"成功"返回空结果——
 * 表现为"任务成功但什么都没做"，极其难查（2026-10-10 实测踩到）。
 */
function stripCliProfileMarker(prompt: string) {
  const lineEnd = prompt.indexOf("\n");
  const header = lineEnd === -1 ? prompt : prompt.slice(0, lineEnd);
  const rest = lineEnd === -1 ? "" : prompt.slice(lineEnd + 1);
  // JSON 写坏（没有 `]]`）时退到"最后一个右花括号之后"，仍然只剥标记、不吞正文
  let cut = header.indexOf("]]");
  cut = cut === -1 ? header.lastIndexOf("}") + 1 : cut + 2;
  const remainder = cut <= 0 ? "" : header.slice(cut).trim();
  return [remainder, rest].filter(Boolean).join("\n");
}

export function parseWorkbuddyCliProfile(prompt: string): { prompt: string; profile: WorkbuddyCliProfile } {
  const profile: WorkbuddyCliProfile = { effort: "", model: "", maxTurns: 0, disallowedTools: [] };
  if (!prompt.startsWith(CLI_PROFILE_PREFIX)) return { prompt, profile };
  const lineEnd = prompt.indexOf("\n");
  const header = lineEnd === -1 ? prompt : prompt.slice(0, lineEnd);
  const body = stripCliProfileMarker(prompt);
  let payload: Record<string, unknown> = {};
  const start = header.indexOf("{");
  const end = header.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(header.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  const effort = String(payload.effort || "").trim().toLowerCase();
  if (EFFORT_LEVELS.has(effort)) profile.effort = effort;
  const model = String(payload.model || "").trim();
  if (MODEL_IDS.has(model)) profile.model = model;
  const maxTurns = Number(payload.maxTurns);
  if (Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 40) profile.maxTurns = maxTurns;
  if (Array.isArray(payload.disallowedTools)) {
    profile.disallowedTools = payload.disallowedTools
      .filter((item): item is string => typeof item === "string" && TOOL_NAME_PATTERN.test(item))
      .slice(0, 24);
  }
  return { prompt: body, profile };
}

/** 把档位翻译成 CLI 参数（全部为可选追加项，空档位返回空数组） */
export function workbuddyProfileArgs(profile: WorkbuddyCliProfile): string[] {
  const args: string[] = [];
  if (profile.effort) args.push("--effort", profile.effort);
  if (profile.model) args.push("--model", profile.model);
  if (profile.maxTurns) args.push("--max-turns", String(profile.maxTurns));
  if (profile.disallowedTools.length) args.push("--disallowedTools", profile.disallowedTools.join(","));
  return args;
}

export function workbuddyProfileLabel(profile: WorkbuddyCliProfile): string {
  const parts: string[] = [];
  if (profile.effort) parts.push(`思考档位 ${profile.effort}`);
  if (profile.model) parts.push(`模型 ${profile.model}`);
  if (profile.maxTurns) parts.push(`最多 ${profile.maxTurns} 轮工具调用`);
  if (profile.disallowedTools.length) parts.push(`已禁用 ${profile.disallowedTools.join(" / ")}`);
  return parts.join(" · ");
}

export async function executeWorkbuddyTask(task: ClaimedTask, options: WorkBuddyExecutionOptions): Promise<WorkBuddyExecutionResult> {
  if (task.adapter !== "workbuddy") throw new Error("Runner 只允许执行 WorkBuddy 适配器任务");
  const workspace = await realpath(task.workspace);
  const allowed = await Promise.all(options.allowedWorkspaces.map((item) => realpath(item)));
  if (!allowed.includes(workspace)) throw new Error("任务工作目录不在本机 Runner 授权范围内");

  const binary = options.workbuddyBinary || resolveWorkbuddyBinary();
  const requested = parseWorkbuddyCliProfile(task.prompt);
  const profileArgs = workbuddyProfileArgs(requested.profile);
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--no-session-persistence",
    "--permission-mode", task.executionMode === "workspace_write" ? "acceptEdits" : "plan",
    ...profileArgs
  ];
  const skillDirs = workbuddySkillDirs(workspace);
  const childEnv = workbuddyProcessEnvironment();
  if (skillDirs) childEnv.CODEBUDDY_SESSION_SKILL_DIRS = skillDirs;
  const child = spawn(binary, args, {
    cwd: workspace,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv
  });

  let finalText = "";
  let stderr = "";
  let fallbackOutput = "";
  let sessionId = "";
  let outputTruncated = false;
  let sawResult = false;
  let resultFailed = false;
  /** CLI 以结构化事件报出的失败原因；优先于 stderr 与退出码展示给用户 */
  let failureReason = "";
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
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      send({ eventType: "output", message: line.slice(0, 8000) });
      return;
    }
    const type = String(event.type || "");
    const session = String(event.session_id || record(event.message).session_id || "");
    if (session) sessionId = session;
    if (type === "system") {
      // CLI 在会话建立事件里会自报它**实际使用**的模型。必须记下来：
      // 提示词里的 `model` 标记只能证明「我们要求了什么」，只有这条能证明「CLI 接受了什么」。
      // 排查「系统里配的模型到底有没有生效」时，这就是唯一的直接证据（2026-10-10 加）。
      const selfReportedModel = String(event.model || "").trim();
      send({
        eventType: "status",
        message: selfReportedModel
          ? `WorkBuddy CLI 会话已建立（实际使用模型：${selfReportedModel}）`
          : "WorkBuddy CLI 会话已建立",
        payload: {
          stage: "session",
          status: "completed",
          ...(selfReportedModel ? { model: selfReportedModel } : {})
        }
      });
      return;
    }
    if (type === "result") {
      sawResult = true;
      const isError = String(event.subtype || "") !== "success" || Boolean(event.is_error);
      resultFailed = isError;
      const text = clipped(event.result || event.text, MAX_RESULT_BYTES);
      if (text) {
        finalText = append("", text);
        send({ eventType: "output", message: text.slice(0, 8000), payload: { stage: "message", status: "completed" } });
      }
      if (isError) {
        // CLI 的错误原因可能在三个位置：error（字符串）、result（文本）、errors（数组，如未登录时
        // 只有 errors: ["Authentication required. Please use /login ..."]）。逐个兜底，避免落到空文案。
        const errorList = Array.isArray(event.errors) ? event.errors.filter((item) => typeof item === "string" && item.trim()) : [];
        failureReason = clipped(event.error || event.result || errorList[0] || "WorkBuddy CLI 返回失败", 2000);
        send({ eventType: "error", message: failureReason, payload: { stage: "system", status: "failed" } });
      }
      return;
    }
    const message = record(event.message);
    const content = message.content ?? event.content;
    for (const toolEvent of toolEvents(content)) send(toolEvent);
    const text = textOf(content);
    if (type === "assistant" || type === "message") {
      if (!text.trim()) return;
      finalText = append(finalText, finalText ? `\n\n${text}` : text);
      send({ eventType: "output", message: text.slice(0, 8000), payload: { stage: "message", status: "completed" } });
      return;
    }
    if (type === "error") {
      resultFailed = true;
      failureReason = clipped(event.error || event.message || "WorkBuddy CLI 返回错误", 2000);
      send({ eventType: "error", message: failureReason, payload: { stage: "system", status: "failed" } });
      return;
    }
    if (text.trim()) send({ eventType: "progress", message: text.slice(0, MAX_EVENT_OUTPUT), payload: { stage: "system", status: "running" } });
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

  child.stdin.end(requested.prompt);
  if (profileArgs.length) {
    send({
      eventType: "status",
      message: `已应用 CLI 执行参数（${workbuddyProfileLabel(requested.profile)}）`,
      payload: { stage: "profile", status: "completed" }
    });
  }
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  options.signal.removeEventListener("abort", stop);
  output.close();
  await eventQueue;

  const succeeded = !timedOut && !resultFailed && (exit.code === 0 || sawResult);
  const resultText = redact(finalText || (succeeded ? fallbackOutput.trim() : ""));
  const errorMessage = redact(timedOut
    ? `WorkBuddy CLI 执行超过 ${task.timeoutSeconds} 秒，已停止`
    : exit.error?.message || (succeeded ? "" : failureReason || stderr.trim() || `WorkBuddy CLI 退出码：${exit.code ?? exit.signal ?? "unknown"}`));
  return {
    status: cancelled ? "cancelled" : succeeded ? "succeeded" : "failed",
    resultText,
    errorMessage,
    outputTruncated,
    codexThreadId: sessionId
  };
}
