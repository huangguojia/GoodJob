import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import type { CliEngineStatus } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

/** WorkBuddy 桌面端自带的 CLI（CodeBuddy Code）在 macOS 上的固定位置。 */
const MAC_BUNDLED_BINARY = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";

const MAX_RESULT_BYTES = 200_000;
const MAX_STDERR_BYTES = 8_000;

/**
 * ⚠️ 这份清单与 `goodjob-runner/src/workbuddy-adapter.ts::STRIPPED_ENVIRONMENT_KEYS` 是同一份知识，
 * 修改时必须两边一起改。它是本机跑 CLI 最容易踩的一坨坑，逐条原因见下：
 *
 * - NODE_OPTIONS：宿主预加载补丁脚本，会破坏 CLI 的全局 fetch。
 * - SERVER__HOST / SERVER__PORT（**最要命**）：宿主把这两个指向桌面网关的变量注入子 shell。
 *   带着它们时 CLI 不去云网关，而是连桌面端宿主网关，`--print` 非交互任务 **0 输出永久挂起**
 *   （最坏挂到 24 小时超时），表现为"任务卡住且什么都不返回"。
 * - CODEBUDDY_CONFIG_DIR：宿主注入 ~/.workbuddy（桌面端登录态，可能已过期）会劫持 CLI 凭据目录，
 *   报 Authentication required。剥掉后 CLI 回落默认的 ~/.codebuddy（终端 /login 写入）。
 * - CODEBUDDY_GATEWAY_* / CODEBUDDY_HOST / CODEBUDDY_API_KEY_HELPER_DISABLED / CODEBUDDY_INTERNET_ENVIRONMENT：
 *   同族，都是把 CLI 绑回宿主网关的开关，且带凭据泄漏风险。
 * - WORKBUDDY_PAC_RPC_SOCKET / WORKBUDDY_PAC_RPC_TOKEN：桌面会话级 PAC 代理 RPC，
 *   socket 随桌面会话存亡，桌面一重启旧 socket 即失效 → CLI 在 ProxyResolver 死等 / ENOENT。
 * - CODEBUDDY_IDE_PORT：在宿主内部启动时会把 CLI 的 IDE 端口顶掉（EADDRINUSE）。
 * - CODEBUDDY_SERVICE_PROXY_URL / CODEBUDDY_MCP_CONFIG：会把 CLI 劫持回宿主会话并把宿主会话级
 *   MCP Bearer 凭据暴露给任务。
 * - ELECTRON_RUN_AS_NODE / CODEBUDDY_FORCE_HEADLESS_BUNDLE / CODEBUDDY_FORCE_LITE_WB_BUNDLE：
 *   宿主进程形态标记，会让 Electron 以纯 Node 形态启动，改变 CLI 启动路径。
 * - BASH_ENV：宿主注入的 shell 前置脚本，会污染 CLI 自己拉起的 bash 子进程。
 */
export const STRIPPED_ENVIRONMENT_KEYS = [
  "NODE_OPTIONS",
  "CODEBUDDY_CONFIG_DIR",
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
  "BAGGAGE",
  // 桌面端「当前选中模型」。实测 `--print` 下 CLI 不会用它覆盖显式 `--model`（不传模型时
  // 报的是账号默认，不是这里的值），但它是同一族的会话状态变量：一旦某个版本开始认它，
  // 插件就会在用户毫不知情的情况下用上桌面端当前选的模型。剥掉更安全。
  "CODEBUDDY_CURRENT_MODEL_ID"
];

/** 宿主注入的会话级工具链变量：整族前缀剔除（带会话/进程 id）。 */
export const STRIPPED_ENVIRONMENT_PREFIXES = [
  // ⚠️ CODEBUDDY_* 必须整族剥：黑名单剥不干净——实测残留 `CODEBUDDY_CONFIG_DIR`（指向宿主
  // 桌面端的配置目录）就会让子 CLI `error_during_execution`（= 用户看到的「CLI 生成失败」），
  // 而宿主注入的该族变量有 70+ 个且随版本增减。子 CLI 需要的目录由我们显式下发
  // （CODEBUDDY_SESSION_SKILL_DIRS 在 childEnvironment() 里剥离**之后**再设），其余一概不需要。
  "CODEBUDDY_",
  "WORKBUDDY_",
  "SERVER__",
  "CLAUDE_",
  "CLIENT_INFO_"
];

/** 指向本机的代理变量：桌面端重启后端口即变，旧端口失联且报错为空，很难查。 */
export const LOCAL_PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/**
 * 构造 CLI 子进程环境。**不要**直接用 `process.env` 去 spawn CLI：
 * 从插件/宿主进程里 fork 出去的 CLI 会继承上面那一整族宿主注入变量。
 */
export function cliProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const key of STRIPPED_ENVIRONMENT_KEYS) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (STRIPPED_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))) delete environment[key];
  }
  for (const key of LOCAL_PROXY_KEYS) {
    const value = String(environment[key] || "");
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/iu.test(value)) delete environment[key];
  }
  // 系统代理兜底：macOS 可能残留死端口，本机直连可用时显式 NO_PROXY 让 CLI 直连。
  return { ...environment, NO_COLOR: "1", FORCE_COLOR: "0", NO_PROXY: "*", no_proxy: "*" };
}

/**
 * 解析 CodeBuddy CLI 可执行文件。
 * 顺序：显式配置 > PATH 里的 codebuddy（排除桌面内置版）> 桌面内置版 > 裸名字。
 * 独立版（npm 装、支持 /login 与完整 headless）必须优先：桌面内置版是 headless-only 且无法 /login，
 * 用它会导致所有任务 Authentication required。
 */
export function resolveCliBinary(configured = ""): string {
  const explicit = configured.trim();
  if (explicit) return explicit;
  const fromPath = findOnPath("codebuddy");
  if (fromPath && fromPath !== MAC_BUNDLED_BINARY) return fromPath;
  if (osPlatform() === "darwin" && existsSync(MAC_BUNDLED_BINARY)) return MAC_BUNDLED_BINARY;
  return "codebuddy";
}

function findOnPath(name: string): string {
  const separator = path.delimiter;
  for (const directory of String(process.env.PATH || "").split(separator)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

/** 模型白名单，与 Runner 的 `MODEL_IDS` 及 CLI `--help` 的 supported list 三处必须一致。 */
export const CLI_MODEL_IDS = [
  "fast-model",
  "balanced-model",
  "deep-model",
  "hy4-preview-f",
  "hy4-preview",
  "hy3",
  "hy3-x",
  "space-bunny",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "minimax-m3",
  "kimi-k3-1",
  "kimi-k2.8-preview",
  "kimi-k2.7",
  "kimi-k2.6"
];

export const CLI_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 出厂默认模型。留空代表「跟随 CLI 默认」，而 CLI 的默认模型由当前登录账号决定
 * （同一台机实测见过 fast-model 也见过 hy4-preview-f），所以跨账号不一致；
 * 要给团队稳定行为就显式指定。
 */
export const CLI_MODEL_DEFAULT = "deepseek-v4.1-flash";

/** 非法值一律回落成「跟随 CLI 默认」（空串），绝不把任意字符串透传给 CLI。 */
export function sanitizeCliModel(value: unknown): string {
  const candidate = String(value ?? "").trim();
  return CLI_MODEL_IDS.includes(candidate) ? candidate : "";
}

export function sanitizeCliEffort(value: unknown): string {
  const candidate = String(value ?? "").trim().toLowerCase();
  return CLI_EFFORT_LEVELS.includes(candidate) ? candidate : "";
}

/**
 * 自动回复依赖的技能名（目录名与 frontmatter `name` 必须逐字一致）。
 * 插件自带这个技能：`<插件>/skills/goodjob-auto-reply/SKILL.md`。
 */
export const AUTO_REPLY_SKILL = "goodjob-auto-reply";

/**
 * 资源挑选（资料推荐复排）依赖的技能名。同样自带：`<插件>/skills/goodjob-resource-scout/SKILL.md`。
 *
 * 与自动回复技能是**两个独立技能**：一个管「这句话怎么回」，一个管「这次该发哪几份资料」。
 * 合成一个技能会让提示词里塞两套方法论，反而两边都做不好。
 */
export const RESOURCE_SCOUT_SKILL = "goodjob-resource-scout";

/**
 * 提示词**首行**的技能点名。
 *
 * 技能装载不等于会被用上：CLI 需要在任务里被明确要求去加载它。这里刻意把「拿不到就按下面的
 * 说明继续」写进同一句——技能目录没装/没扫到的时候，任务必须照常完成（静默降档），
 * 而不是整条自动回复链因为一个 Markdown 文件缺失而失败。
 */
export function cliSkillDirective(skill: string = AUTO_REPLY_SKILL): string {
  return [
    `First load your skill "${skill}" with the Skill tool and follow it for this ${skill === RESOURCE_SCOUT_SKILL ? "resource-picking" : "reply-writing"} task.`,
    `If that skill is not available, ignore this line and continue with the instructions below; do not mention it.`
  ].join(" ");
}

/**
 * 技能扫描目录解析，顺序与 Runner 侧同名逻辑保持一致（`GOODJOB_SKILLS_DIRS` 优先）：
 * 1. 显式配置（环境变量 `GOODJOB_SKILLS_DIRS` / 构造参数）；
 * 2. 插件自带的 `skills/`（随包发布，**无需任何安装步骤**就能用上自动回复技能）；
 * 3. 工作区里的 `.workbuddy/skills`（与 Runner 共用同一份安装位置）。
 * 都找不到就返回空串——CLI 会正常跑，只是没有技能（由 status 上报，不让它静默）。
 */
export function resolveSkillsDirs(configured = ""): string {
  const explicit = configured.trim();
  if (explicit) return explicit;
  const bundled = path.resolve(process.cwd(), "skills");
  // 两个自带技能任一在，就认定插件自带的 skills/ 是有效的扫描目录。
  // （之前只看自动回复技能：万一它被单独删掉，插件的资源挑选技能也会跟着静默失效。）
  const bundledHasSkill = [AUTO_REPLY_SKILL, RESOURCE_SCOUT_SKILL].some((skill) =>
    existsSync(path.join(bundled, skill, "SKILL.md"))
  );
  if (bundledHasSkill) return bundled;
  const workspaceSkills = path.resolve(process.cwd(), ".workbuddy", "skills");
  if (existsSync(workspaceSkills)) return workspaceSkills;
  return "";
}

/** 扫出技能目录里实际装了哪些技能（有 SKILL.md 的子目录名）。 */
export function listInstalledSkills(skillsDirs: string): string[] {
  if (!skillsDirs) return [];
  try {
    return readdirSync(skillsDirs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(skillsDirs, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 只读探索工具禁用清单。默认档位放任不管时，CLI 会把自己当「仓库里的编码 Agent」，
 * 为了理解一句话去 Glob/Grep/WebFetch 翻整个工作目录（实测同一条提示词：默认 178 秒 / 53 次工具调用）。
 * 自动回复只需要「给一句客人的话 → 回一段话」，用不上任何探索工具。
 */
export const CLI_DISALLOWED_TOOLS = ["Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"];

/**
 * 状态类型只保留**一份**：定义在 `shared/types.ts`（界面也要用同一份）。
 * 这里再写一个本地 interface 曾经导致两边字段漂移——新增字段时后端编译得过、前端读不到。
 */
export type { CliEngineStatus };

export interface CliRunOptions {
  prompt: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  timeoutMs?: number;
  workspace?: string;
  signal?: AbortSignal;
}

export interface CliRunResult {
  text: string;
  /** CLI 在 system 事件里**自报**的模型。这是「模型到底生效没有」的唯一直接证据。 */
  model: string;
  sessionId: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ParsedCliStream {
  text: string;
  model: string;
  sessionId: string;
  failed: boolean;
  error: string;
}

interface CliEngineOptions {
  binary?: string;
  timeoutSeconds?: number;
  workspacePath?: string;
  /** 技能扫描目录；缺省按 `resolveSkillsDirs()` 自动解析（插件自带 skills/ 优先）。 */
  skillsDirs?: string;
  /** 探测结果缓存时长：成功后 5 分钟，失败后 20 秒（能力掉线要秒级自愈）。 */
  successTtlMs?: number;
  failureTtlMs?: number;
}

/**
 * 把 stream-json 的每一行解析成最终文本 / 自报模型 / 失败原因。
 *
 * 纯函数，便于脱离子进程回测。语义与 Runner 侧一致：
 * - `system` 事件带 `model`：CLI 自报实际使用的模型；
 * - `assistant` / `message` 事件：正文增量（多条用空行拼接）；
 * - `result` 事件：终态。`subtype !== "success"` 或 `is_error` 即失败；
 *   失败原因可能在 `error`（字符串）、`result`（文本）、`errors`（数组，未登录时只有它）三处，
 *   必须逐个兜底，否则会落到空文案（历史上排查了半天）。
 */
export function parseCliStream(lines: string[]): ParsedCliStream {
  let finalText = "";
  let accumulated = "";
  let model = "";
  let sessionId = "";
  let failed = false;
  let error = "";

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // 非 JSON 行（CLI 的告警、进度输出）不当作正文，避免污染回复内容。
      continue;
    }
    const type = String(event.type || "");
    const session = String(event.session_id || recordOf(event.message).session_id || "");
    if (session) sessionId = session;
    if (type === "system") {
      const reported = String(event.model || "").trim();
      if (reported) model = reported;
      continue;
    }
    if (type === "result") {
      const isError = String(event.subtype || "") !== "success" || Boolean(event.is_error);
      const text = clipped(event.result ?? event.text, MAX_RESULT_BYTES);
      if (text) finalText = text;
      if (isError) {
        failed = true;
        const errorList = Array.isArray(event.errors)
          ? event.errors.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
        error = clipped(event.error || event.result || errorList[0] || "WorkBuddy CLI 返回失败", 2_000);
      }
      continue;
    }
    const message = recordOf(event.message);
    const content = message.content ?? event.content;
    const text = textOf(content);
    if (type === "assistant" || type === "message") {
      if (!text.trim()) continue;
      accumulated = accumulated ? `${accumulated}\n\n${text}` : text;
      continue;
    }
    if (type === "error") {
      failed = true;
      error = clipped(event.error || event.message || "WorkBuddy CLI 返回错误", 2_000);
    }
  }

  // 有 result 就用 result（是 CLI 的权威终态），否则退到逐条累积的正文。
  // 无终态事件不算失败：部分 CLI 版本只发 assistant 事件，靠「文本为空」在调用方兜底。
  return { text: finalText || accumulated, model, sessionId, failed, error };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const value = recordOf(part);
      if (typeof value.text === "string") return value.text;
      if (typeof value.content === "string") return value.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function clipped(value: unknown, maximum: number): string {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim().slice(0, maximum);
}

function redact(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/\b(Bearer|Runner)\s+[A-Za-z0-9._-]{16,}\b/giu, "$1 [REDACTED]");
}

export class CliEngine {
  private cache?: { at: number; status: CliEngineStatus };
  private readonly options: CliEngineOptions;

  constructor(options: CliEngineOptions = {}) {
    this.options = {
      successTtlMs: 5 * 60_000,
      failureTtlMs: 20_000,
      ...options
    };
  }

  binary(): string {
    return resolveCliBinary(this.options.binary ?? "");
  }

  /** 技能扫描目录（本机 CLI 侧生效）。空串 = 没找到技能目录，技能会静默不生效。 */
  skillsDirs(): string {
    return resolveSkillsDirs(this.options.skillsDirs ?? "");
  }

  /**
   * 给 CLI 子进程的环境。
   *
   * `CODEBUDDY_SESSION_SKILL_DIRS` 必须由**我们**显式下发：技能装在插件自己的 `skills/` 里，
   * 而 CLI 的默认扫描位置里没有它。宿主当前并不注入这个变量（实测），但即使将来注入了，
   * 也要以插件解析出来的目录为准——技能装在哪，只有插件自己知道。
   */
  private childEnvironment(): NodeJS.ProcessEnv {
    const environment = cliProcessEnvironment();
    const skillsDirs = this.skillsDirs();
    if (skillsDirs) environment.CODEBUDDY_SESSION_SKILL_DIRS = skillsDirs;
    return environment;
  }

  /**
   * 探测 CLI 可用性并缓存。
   * 成功缓存 5 分钟；失败只缓存 20 秒——CLI 账号被外部工具切换、或二进制被升级替换后，
   * 能力必须能在一轮心跳内自愈，而不是让用户对着一个假失败等五分钟。
   */
  async status(force = false): Promise<CliEngineStatus> {
    const now = Date.now();
    if (!force && this.cache) {
      const ttl = this.cache.status.available ? this.options.successTtlMs! : this.options.failureTtlMs!;
      if (now - this.cache.at < ttl) return this.cache.status;
    }
    const status = await this.probe();
    this.cache = { at: now, status };
    return status;
  }

  private baseStatus(binary: string, reason: string, version = ""): CliEngineStatus {
    const skillsDirs = this.skillsDirs();
    return {
      available: false,
      binary,
      version,
      reason,
      defaultModel: CLI_MODEL_DEFAULT,
      models: CLI_MODEL_IDS,
      efforts: CLI_EFFORT_LEVELS,
      skillsDirs,
      skills: listInstalledSkills(skillsDirs),
      autoReplySkill: AUTO_REPLY_SKILL,
      resourceScoutSkill: RESOURCE_SCOUT_SKILL
    };
  }

  private async probe(): Promise<CliEngineStatus> {
    const binary = this.binary();
    if (binary.includes("/") && !existsSync(binary)) {
      return this.baseStatus(binary, `未找到可执行文件 ${binary}`);
    }
    try {
      const { stdout, stderr } = await execFileAsync(binary, ["--version"], {
        timeout: 20_000,
        env: this.childEnvironment(),
        encoding: "utf8"
      });
      // --version 之外可能混入远端配置告警，只取最后一行有效输出。
      const version = `${stdout}${stderr}`
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1)
        ?.slice(0, 80) ?? "";
      if (!version) return this.baseStatus(binary, `${binary} 已启动但没有输出版本号`);
      const skillsDirs = this.skillsDirs();
      return {
        available: true,
        binary,
        version,
        reason: "",
        defaultModel: CLI_MODEL_DEFAULT,
        models: CLI_MODEL_IDS,
        efforts: CLI_EFFORT_LEVELS,
        skillsDirs,
        skills: listInstalledSkills(skillsDirs),
        autoReplySkill: AUTO_REPLY_SKILL,
        resourceScoutSkill: RESOURCE_SCOUT_SKILL
      };
    } catch (error) {
      const failure = error as { killed?: boolean; signal?: string | null; stderr?: unknown; code?: unknown };
      if (failure?.killed || failure?.signal === "SIGTERM") {
        return this.baseStatus(binary, `${binary} 启动超时（20 秒未退出）`);
      }
      const stderr = String(failure?.stderr ?? "").replace(/\s+/gu, " ").trim().slice(0, 160);
      return this.baseStatus(
        binary,
        stderr ? `${binary} 启动失败：${stderr}` : `${binary} 启动失败（退出码 ${String(failure?.code ?? "未知")}）`
      );
    }
  }

  /** 探测结果只作展示与「能不能用」的判断，真正跑起来失败一样要能收敛（见 run 的失败语义）。 */
  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * 跑一次非交互 CLI 任务，把提示词写进 stdin（**不能**走命令行参数：正文里有引号/换行会被 shell 与
   * argv 长度限制破坏），读 stream-json 直到进程退出。
   */
  async run(input: CliRunOptions): Promise<CliRunResult> {
    const binary = this.binary();
    const timeoutMs = Math.max(5_000, input.timeoutMs ?? (this.options.timeoutSeconds ?? 90) * 1_000);
    const workspace = await this.ensureWorkspace(input.workspace);
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--no-session-persistence",
      "--permission-mode", "plan",
      "--max-turns", String(Math.max(1, Math.min(20, input.maxTurns ?? 3))),
      "--disallowedTools", CLI_DISALLOWED_TOOLS.join(",")
    ];
    const model = sanitizeCliModel(input.model);
    const effort = sanitizeCliEffort(input.effort);
    if (effort) args.push("--effort", effort);
    if (model) args.push("--model", model);

    const started = Date.now();
    const child = spawn(binary, args, {
      cwd: workspace,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.childEnvironment()
    });

    const lines: string[] = [];
    let stderr = "";
    const output = readline.createInterface({ input: child.stdout });
    output.on("line", (line) => {
      if (lines.length < 5_000) lines.push(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, MAX_STDERR_BYTES);
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
    const onAbort = (): void => kill();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) kill();

    child.stdin.on("error", () => undefined);
    child.stdin.end(input.prompt);

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
    output.close();

    const parsed = parseCliStream(lines);
    const durationMs = Date.now() - started;
    if (timedOut) {
      throw new Error(`本机 CLI 执行超过 ${Math.round(timeoutMs / 1_000)} 秒，已停止`);
    }
    if (exit.error) throw new Error(`本机 CLI 无法启动（${binary}）：${exit.error.message}`);
    if (parsed.failed) {
      throw new Error(redact(parsed.error || stderr.trim() || `本机 CLI 退出码 ${exit.code ?? exit.signal ?? "未知"}`));
    }
    if (!parsed.text.trim()) {
      // 退出码为 0 但没有任何结果文本：CLI 未登录时就会这样（退出码仍是 0，必须读 result 事件才发现）。
      throw new Error(redact(stderr.trim() || "本机 CLI 没有返回任何内容（常见原因：CLI 未登录）"));
    }
    return { text: parsed.text, model: parsed.model, sessionId: parsed.sessionId, durationMs, timedOut: false };
  }

  /**
   * CLI 的工作目录。刻意用一个空的专属目录，而不是插件/仓库根：
   * 在仓库里跑会让 CLI 觉得自己是「编码 Agent」去探索代码库（慢且不可预测），
   * 也避免它读到插件自己的技能与源码。目录不可写时退回系统临时目录，绝不因为建目录失败而拒绝服务。
   */
  private async ensureWorkspace(override?: string): Promise<string> {
    const target = override?.trim() || this.options.workspacePath || path.resolve(process.cwd(), ".data", "cli-workspace");
    try {
      await mkdir(target, { recursive: true });
      return target;
    } catch {
      return process.cwd();
    }
  }
}
