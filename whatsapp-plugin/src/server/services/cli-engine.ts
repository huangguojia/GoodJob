import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import path from "node:path";
import readline, { type Interface } from "node:readline";
import { promisify } from "node:util";
import type { CliEngineStatus } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

/** WorkBuddy 桌面端自带的 CLI（CodeBuddy Code）在 macOS 上的固定位置。 */
const MAC_BUNDLED_BINARY = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";

const MAX_RESULT_BYTES = 200_000;
const MAX_STDERR_BYTES = 8_000;
/** 常驻进程每轮保留的行数上限：只用于解析这一轮的终态，不需要无限攒。 */
const MAX_WARM_LINES = 4_000;
/** 预热池默认容量。2 = 「回复」与「资料复排」各占一个，是唯一会同时出现的并发。 */
const WARM_TARGET_DEFAULT = 2;
/** 预热进程闲置多久后回收。CLI 空闲几乎不吃 CPU，但没必要无限占内存。 */
const WARM_IDLE_MS = 30 * 60_000;
/**
 * 进程 spawned 之后多久才算「加载完成」。
 *
 * CLI 不会在就绪时输出任何信号（实测空转 3 秒 stdout 一行都没有），只能按时间判断。
 * 实测（串行、单进程）：spawn 后立刻发请求，总耗时 ≈ 4.2 秒；空转 2.5 秒以上再发，
 * 请求本身只要 ≈ 1.9~2.6 秒。所以这 2.5 秒就是「Node 加载 + 拉配置 + 鉴权 + 组装
 * system prompt」的那一坨，提前付掉就没有了。
 */
const WARM_READY_MS = 2_500;

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
  /**
   * 常驻预热池。默认关闭：只有真正跑 CLI 的进程（app.ts）才开，回测里的假 CLI
   * 是「读 stdin 到 EOF」的老形态，开了反而要把假 CLI 也改成流式输入。
   */
  warm?: boolean;
  /** 池容量。默认 2（回复 + 资料复排）。 */
  warmTarget?: number;
  /** 进程启动后多久算就绪（毫秒）。回测里假 CLI 是瞬时的，会调小。 */
  warmReadyMs?: number;
}

/**
 * 一个**干净的**常驻 CLI 进程：冷启动已经付过，还没接过任何请求。
 *
 * 为什么是「用完即弃」而不是「复用会话」：实测同一个 `--print --input-format stream-json`
 * 进程的第二轮会记得第一轮的内容（问它上一轮说过的暗号，它能原样答出来）。
 * 换句话说，复用进程就是让 A 客户的报价出现在 B 客户的上下文里。
 * `/clear` 在 `--print` 下不生效（实测第三轮仍记得暗号），所以只能靠「一轮一进程」隔离。
 *
 * 池子里**只放干净进程**：`takeWarm()` 取走后立刻从池里摘掉，用完 kill，再后台补一个。
 */
interface WarmWorker {
  child: ChildProcessWithoutNullStreams;
  reader: Interface;
  key: string;
  lines: string[];
  stderr: string;
  createdAt: number;
  lastUsedAt: number;
  closed: boolean;
  /** 当前轮的行回调；`null` = 这个进程还干净，没在跑任务。 */
  onLine: ((line: string) => void) | null;
  /** 进程意外退出的回调（当前轮需要立刻失败，而不是等到超时）。 */
  onExit: (() => void) | null;
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
  /** key = `${model}|${effort}`。池里只存**干净**进程（没接过任何任务）。 */
  private readonly warm = new Map<string, WarmWorker[]>();
  /** 正在后台补位的数量，避免一批请求同时各补一个把进程数打爆。 */
  private warming = 0;
  /** 已 spawn 但还没就绪的进程：dispose 时也要能收掉，否则会漏。 */
  private readonly booting = new Set<WarmWorker>();
  private warmTimer: NodeJS.Timeout | null = null;

  constructor(options: CliEngineOptions = {}) {
    this.options = {
      successTtlMs: 5 * 60_000,
      failureTtlMs: 20_000,
      warmTarget: WARM_TARGET_DEFAULT,
      ...options
    };
    if (this.options.warm) {
      this.warmTimer = setInterval(() => this.reapIdle(), 60_000);
      this.warmTimer.unref?.();
    }
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
  /**
   * 预热。插件启动后调一次即可（不阻塞启动流程）。
   *
   * 为什么值得：实测一次 `--print` 冷启动 ≈ 4.2 秒（Node 启动 + 拉配置 + 鉴权 + 组装
   * 20k token 的 system prompt），而模型本身生成一句话只要 1~2 秒。
   * 也就是说「点开面板等 8 秒」里有五六秒是在等一个空进程把架子搭起来。
   * 预热把这几秒挪到没人等的时刻，第一次请求就只剩生成时间。
   */
  async warmup(model = "", effort = ""): Promise<void> {
    if (!this.options.warm) return;
    /**
     * 预热两组参数：
     * - 空 = 跟随账号默认（设置里没选模型时请求就是这么发的）；
     * - 出厂默认 `deepseek-v4.1-flash`（用户在设置里选了它，这是最常见的一档）。
     *
     * 池容量按 2 算，正好各一个。用户选了别的模型时第一次仍要现场启动，
     * 但那次请求结束后会按真实参数补位，第二次起就命中。
     */
    const plans = model || effort ? [{ model, effort }] : [{ model: "", effort: "" }, { model: CLI_MODEL_DEFAULT, effort: "" }];
    // 并行预热：两个进程各自要等 2.5 秒就绪，串起来就是 5 秒，而它们互不依赖。
    await Promise.all(plans.map((plan) => this.ensureWarm(plan.model, plan.effort)));
  }

  /** 关停：把池里的进程全部收掉（测试 / 进程退出时用）。 */
  dispose(): void {
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = null;
    for (const worker of this.booting) this.kill(worker);
    this.booting.clear();
    for (const list of this.warm.values()) for (const worker of list) this.kill(worker);
    this.warm.clear();
  }

  private warmCount(): number {
    let total = 0;
    for (const list of this.warm.values()) total += list.length;
    return total;
  }

  /** 后台补一个干净进程。失败静默：真实请求自己会把错误报出来。 */
  private async ensureWarm(model: string, effort: string): Promise<void> {
    if (!this.options.warm) return;
    const target = Math.max(1, this.options.warmTarget ?? WARM_TARGET_DEFAULT);
    if (this.warmCount() + this.warming >= target) return;
    this.warming += 1;
    let worker: WarmWorker | null = null;
    try {
      worker = await this.spawnWarm(model, effort);
      this.booting.add(worker);
      /**
       * 等它真正加载完再入池。进程刚 spawn 时写进去的请求，仍然要陪它把
       * 「Node 加载 + 拉配置 + 鉴权」走完（实测总耗时恒定在 4.2 秒左右）；
       * 空转 2.5 秒后再发，请求本身才只要 2 秒。
       */
      const readyMs = Math.max(0, this.options.warmReadyMs ?? WARM_READY_MS);
      if (readyMs) await new Promise((resolve) => setTimeout(resolve, readyMs));
      if (worker.closed) return;
      const list = this.warm.get(worker.key) ?? [];
      list.push(worker);
      this.warm.set(worker.key, list);
    } catch {
      // 预热失败不影响功能：下一次请求会退回现场启动并如实报错。
    } finally {
      if (worker) this.booting.delete(worker);
      this.warming -= 1;
    }
  }

  /** 取一个干净的预热进程。取走即从池中摘掉（它马上就不再干净了）。 */
  private takeWarm(model: string, effort: string): WarmWorker | null {
    const key = `${model}|${effort}`;
    const list = this.warm.get(key);
    if (!list?.length) return null;
    const worker = list.shift()!;
    if (!list.length) this.warm.delete(key);
    if (worker.closed) return this.takeWarm(model, effort);
    worker.lastUsedAt = Date.now();
    return worker;
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [key, list] of this.warm) {
      const keep: WarmWorker[] = [];
      for (const worker of list) {
        if (worker.closed) continue;
        if (now - worker.lastUsedAt > WARM_IDLE_MS) {
          this.kill(worker);
          continue;
        }
        keep.push(worker);
      }
      if (keep.length) this.warm.set(key, keep);
      else this.warm.delete(key);
    }
  }

  private kill(worker: WarmWorker): void {
    if (worker.closed) return;
    worker.closed = true;
    worker.onLine = null;
    worker.onExit = null;
    try {
      worker.reader.close();
    } catch {
      /* 已经关了 */
    }
    try {
      worker.child.stdin.end();
    } catch {
      /* 已经断了 */
    }
    /**
     * 先让 stdin 的关闭落地，再发信号。`--print --input-format stream-json` 收到 EOF 会
     * 自己退出；立刻 SIGTERM 会让它连收尾都来不及（实测连 stdin 的 end 事件都处理不到）。
     * 300ms 后还没退就强推。
     */
    const term = setTimeout(() => {
      try {
        worker.child.kill("SIGTERM");
      } catch {
        /* 已经退了 */
      }
    }, 300);
    term.unref?.();
    const force = setTimeout(() => {
      try {
        worker.child.kill("SIGKILL");
      } catch {
        /* 已经退了 */
      }
    }, 3_000);
    force.unref?.();
  }

  private destroyWorker(worker: WarmWorker): void {
    this.kill(worker);
  }

  /** 起一个常驻进程。参数与 `runCold` 完全一致，只多一个流式输入。 */
  private async spawnWarm(model: string, effort: string): Promise<WarmWorker> {
    const workspace = await this.ensureWorkspace();
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--no-session-persistence",
      "--permission-mode", "plan",
      /**
       * 给 2 轮，与一次性进程（`runCold` 里 auto-chat 传的 `maxTurns: 2`）一致。
       * 提示词第一行要求模型先用 Skill 工具加载技能，那是第 1 轮；第 2 轮才产出 JSON。
       * 写成 1 会让技能静默不生效 —— 回复还是能出来，但降档成"没读过方法论"。
       */
      "--max-turns", "2",
      "--disallowedTools", CLI_DISALLOWED_TOOLS.join(",")
    ];
    if (effort) args.push("--effort", effort);
    if (model) args.push("--model", model);

    const child = spawn(this.binary(), args, {
      cwd: workspace,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.childEnvironment()
    }) as ChildProcessWithoutNullStreams;

    const worker: WarmWorker = {
      child,
      reader: readline.createInterface({ input: child.stdout }),
      key: `${model}|${effort}`,
      lines: [],
      stderr: "",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      closed: false,
      onLine: null,
      onExit: null
    };
    child.stderr.on("data", (chunk: Buffer) => {
      worker.stderr = `${worker.stderr}${chunk.toString("utf8")}`.slice(0, MAX_STDERR_BYTES);
    });
    worker.reader.on("line", (line) => {
      worker.onLine?.(line);
    });
    const onGone = (): void => {
      if (worker.closed) return;
      worker.closed = true;
      worker.onExit?.();
    };
    worker.reader.on("close", onGone);
    child.on("error", onGone);
    child.stdin.on("error", () => undefined);
    return worker;
  }

  /**
   * 在一个常驻进程上跑**一轮**。
   *
   * 输入是 stream-json 的一行 user 消息，输出读到 `result` 事件即收口 ——
   * 不必等进程退出（老路径要等 close，白等一段收尾）。
   */
  private runOnWorker(worker: WarmWorker, input: CliRunOptions): Promise<CliRunResult> {
    const timeoutMs = Math.max(5_000, input.timeoutMs ?? (this.options.timeoutSeconds ?? 90) * 1_000);
    return new Promise<CliRunResult>((resolve, reject) => {
      const started = Date.now();
      worker.lines = [];
      worker.stderr = "";
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        worker.onLine = null;
        worker.onExit = null;
      };
      const done = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        finish();
      };
      const fail = (message: string): void => {
        done(() => reject(new Error(redact(message))));
      };

      const timer = setTimeout(() => {
        try {
          worker.child.kill("SIGKILL");
        } catch {
          /* 已经退了 */
        }
        done(() => reject(new Error(`本机 CLI 执行超过 ${Math.round(timeoutMs / 1_000)} 秒，已停止`)));
      }, timeoutMs);
      timer.unref?.();

      const onAbort = (): void => {
        try {
          worker.child.kill("SIGTERM");
        } catch {
          /* 已经退了 */
        }
        done(() => reject(new Error("本机 CLI 任务已取消")));
      };
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      input.signal?.addEventListener("abort", onAbort, { once: true });

      worker.onExit = () => {
        fail(worker.stderr.trim() || "本机 CLI 进程提前退出（常见原因：CLI 未登录）");
      };
      worker.onLine = (line) => {
        if (worker.lines.length < MAX_WARM_LINES) worker.lines.push(line);
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.trim()) as Record<string, unknown>;
        } catch {
          return;
        }
        if (String(event.type || "") !== "result") return;
        const parsed = parseCliStream(worker.lines);
        if (parsed.failed) {
          fail(parsed.error || worker.stderr.trim() || "本机 CLI 返回失败");
          return;
        }
        if (!parsed.text.trim()) {
          // 退出码 0 但没有任何内容：CLI 未登录时就是这样（必须读 result 事件才发现）。
          fail(worker.stderr.trim() || "本机 CLI 没有返回任何内容（常见原因：CLI 未登录）");
          return;
        }
        done(() =>
          resolve({
            text: parsed.text,
            model: parsed.model,
            sessionId: parsed.sessionId,
            durationMs: Date.now() - started,
            timedOut: false
          })
        );
      };

      try {
        const message = { type: "user", message: { role: "user", content: [{ type: "text", text: input.prompt }] } };
        worker.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        fail(`本机 CLI 无法写入：${error instanceof Error ? error.message : "未知错误"}`);
      }
    });
  }

  /**
   * 跑一次 CLI 任务。
   *
   * `warm` 打开时优先用预热好的干净进程（省掉约 4 秒冷启动），用完即弃并后台补位；
   * 池空则现场起一个（等价于老行为，第一次请求不会更慢）。
   */
  async run(input: CliRunOptions): Promise<CliRunResult> {
    if (!this.options.warm) return this.runCold(input);
    const model = sanitizeCliModel(input.model);
    const effort = sanitizeCliEffort(input.effort);
    const worker = this.takeWarm(model, effort) ?? (await this.spawnWarm(model, effort));
    try {
      return await this.runOnWorker(worker, input);
    } finally {
      this.destroyWorker(worker);
      void this.ensureWarm(model, effort);
    }
  }

  /** 一次性进程：老路径，保留给 `warm:false`（回测里的假 CLI 就是这种形态）。 */
  private async runCold(input: CliRunOptions): Promise<CliRunResult> {
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
