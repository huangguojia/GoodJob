import { getLocalRunnerService } from "./integrations/integration-runtime.js";
import type { AiEngineAdapter, TeamAiEngineSettings } from "./ai-engine-settings.js";
import { aiEngineAdapterLabel } from "./ai-engine-settings.js";
import type { SessionUser } from "./types.js";

// ---------------------------------------------------------------------------
// AI 引擎 · CLI 执行通道
//
// 把「CRM 里的一次背调/一次开发信」翻译成「本机 Runner 上的一次 CLI 任务」，
// 并负责挑机器、挑工作目录、等结果。
//
// 关键约束（不要改）：
//   - 只使用已配对、在线、且具备目标 CLI 能力的 Runner；
//   - 工作目录必须是该 Runner 已授权的绝对路径，绝不由请求方随意指定；
//   - 一律以 read_only 执行——背调和写信都不需要写权限。
// ---------------------------------------------------------------------------

export interface EngineRunnerChoice {
  runnerId: string;
  displayName: string;
  adapter: AiEngineAdapter;
  workspace: string;
  workspaceFallback: boolean;
  cliVersion: string;
  /**
   * 该 Runner 上报的最近一次故障说明（CLI 探测失败 / 浏览器能力缺失）。
   * 账号切换、CLI 重装、符号链接悬空都会让 Runner 暂时探不到 CLI，界面要能解释"为什么少了能力"。
   */
  cliIssue: string;
}

export class EngineUnavailableError extends Error {
  code: string;
  /**
   * 回给前端的状态码。默认 409：请求本身没问题，是「本机执行环境此刻不满足」，
   * 用户换来源 / 把 Runner 起起来就能继续，属于可恢复冲突，不该报成 500。
   * 档位层面缺能力（没有持久化、没有 Runner 服务）才是 503。
   */
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function cliVersionOf(runner: { workbuddyVersion: string; codexVersion: string }, adapter: AiEngineAdapter) {
  return adapter === "workbuddy" ? runner.workbuddyVersion : runner.codexVersion;
}

/**
 * 挑选执行机器：
 *   1) 设置里指定了 runnerId → 必须命中且在线且具备该能力（否则报错，不静默换机器）
 *   2) 没指定 → 优先本人在线的 Runner，其次团队内任意在线的 Runner
 *
 * 2026-10-10：Runner「在线但没有该 CLI 能力」不再笼统报"未检测到 CLI"。
 * CLI 账号可以随时在外部切换（workbuddy switch 之类），切换瞬间 Runner 会短暂探不到 CLI，
 * 随后按 10 秒级节奏自动重探恢复——所以这里要区分"等一下就好"与"需要动手修"，
 * 并把 Runner 上报的探测原因原样带出来。CRM 只要求"这台机器的 CLI 能用"，不绑定任何账号。
 */
export async function pickEngineRunner(
  actor: SessionUser,
  settings: TeamAiEngineSettings
): Promise<EngineRunnerChoice> {
  const service = getLocalRunnerService();
  if (!service) {
    throw new EngineUnavailableError("AI_ENGINE_RUNNER_UNAVAILABLE", "本地 Runner 需要 MySQL 持久化后才能使用 CLI 执行", 503);
  }
  const adapter = settings.cliAdapter;
  const label = aiEngineAdapterLabel(adapter);
  const runners = await service.runners(actor);
  const online = runners.filter((runner) => runner.online);
  const usable = online.filter((runner) => runner.capabilities.includes(adapter));
  if (settings.runnerId) {
    const pinnedUsable = usable.find((runner) => runner.id === settings.runnerId);
    if (pinnedUsable) return runnerChoice(pinnedUsable, actor, adapter, settings);
    const pinnedOnline = online.find((runner) => runner.id === settings.runnerId);
    if (pinnedOnline) throw engineCliMissingError(pinnedOnline, adapter);
    // 指定的 Runner 离线：不静默换机器（把客户资料发到另一台机器是用户的决定），
    // 但要在报错里说清"还有哪台能用"，否则用户只会看到"不可用"。
    const alternative = usable[0];
    throw new EngineUnavailableError(
      "AI_ENGINE_RUNNER_OFFLINE",
      `设置里指定的 Runner 当前不可用，${alternative
        ? `另有在线可用的 Runner：${alternative.displayName || alternative.id}（可在「AI 引擎设置」里改用它）`
        : `且没有其它在线的 Runner 提供 ${label}`}`
    );
  }
  const preferred = usable.find((runner) => runner.ownerId === actor.id) || usable[0];
  if (preferred) return runnerChoice(preferred, actor, adapter, settings);
  const broken = online[0];
  if (broken) throw engineCliMissingError(broken, adapter);
  throw new EngineUnavailableError(
    "AI_ENGINE_RUNNER_MISSING",
    `没有在线的本地 Runner 提供 ${label}；请先在「集成中心 · 本地 Runner」完成配对`
  );
}

/**
 * Runner 在线、但当前没有该适配器能力。
 * 这不等于"没装 CLI"：账号切换、CLI 重新登录、homebrew 升级把符号链接搞悬空，
 * 都会让 Runner 暂时探不到 CLI，通常几秒到十几秒内自动恢复。
 */
function engineCliMissingError(
  runner: { id: string; displayName: string; lastError: string },
  adapter: AiEngineAdapter
) {
  const label = aiEngineAdapterLabel(adapter);
  const reason = String(runner.lastError || "").trim().slice(0, 300);
  return new EngineUnavailableError(
    "AI_ENGINE_CLI_MISSING",
    `这台 Runner（${runner.displayName || runner.id}）暂时用不了 ${label}${reason ? `：${reason}` : "（CLI 探测失败）"}`
  );
}

function runnerChoice(
  runner: { id: string; ownerId: string; displayName: string; workspaces: string[]; workbuddyVersion: string; codexVersion: string; lastError?: string },
  actor: SessionUser,
  adapter: AiEngineAdapter,
  settings: TeamAiEngineSettings
): EngineRunnerChoice {
  const workspaces = runner.workspaces.filter(Boolean);
  if (!workspaces.length) {
    throw new EngineUnavailableError("AI_ENGINE_WORKSPACE_MISSING", "该 Runner 没有授权任何工作目录");
  }
  const configured = settings.cliWorkspace.trim();
  const matched = configured ? workspaces.find((item) => item === configured) : "";
  const workspace = matched || workspaces[0]!;
  return {
    runnerId: runner.id,
    displayName: runner.displayName || runner.id,
    adapter,
    workspace,
    workspaceFallback: Boolean(configured) && !matched,
    cliVersion: cliVersionOf(runner, adapter),
    cliIssue: String(runner.lastError || "").trim().slice(0, 300)
  };
}

export interface EngineRunnerSummary {
  id: string;
  displayName: string;
  ownerId: string;
  online: boolean;
  capabilities: string[];
  workspaces: string[];
  workbuddyVersion: string;
  codexVersion: string;
}

/** 供设置页展示：当前可用（已配对）的本机 Runner 清单 */
export async function listEngineRunners(actor: SessionUser): Promise<EngineRunnerSummary[]> {
  const service = getLocalRunnerService();
  if (!service) return [];
  const runners = await service.runners(actor);
  return runners.map((runner) => ({
    id: runner.id,
    displayName: runner.displayName,
    ownerId: runner.ownerId,
    online: runner.online,
    capabilities: runner.capabilities,
    workspaces: runner.workspaces,
    workbuddyVersion: runner.workbuddyVersion,
    codexVersion: runner.codexVersion
  }));
}

export interface EngineCliTaskSnapshot {
  id: string;
  status: string;
  resultText: string;
  errorMessage: string;
  outputTruncated: boolean;
  engine: string;
  /** 任务事件流（最多 300 条）：获客作业用它做增量入池（@@FOUND@@ 标记行） */
  events: Array<{ eventType: string; message: string }>;
  /** 排队/执行时间戳：前端用来区分「在排队」还是「CLI 正在跑」 */
  runnerId: string;
  queuedAt: string;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// CLI 故障分类
//
// 本机 CLI 的失败几乎只有四类，而每一类的处理动作完全不同（重新登录 / 修代理 /
// 起 Runner / 调超时）。把「报错原文」翻译成「结论 + 可执行命令」放在这里，
// 所有走 CLI 通道的模块（搜客、背调、写信、资料识别）都能复用同一套话术。
// ---------------------------------------------------------------------------
export type EngineCliIssueCode =
  | "cli_auth_required"
  | "cli_network"
  | "cli_timeout"
  | "cli_output_invalid"
  | "cli_failed";

export interface EngineCliIssue {
  code: EngineCliIssueCode;
  title: string;
  detail: string;
  /** 给用户的手动修复动作（终端命令或检查项） */
  command: string;
}

const CLI_AUTH_SIGNATURE = /authentication required|unauthorized|\/login|not logged in|未登录|重新登录|凭据/iu;
const CLI_NETWORK_SIGNATURE = /fetch failed|enotfound|econnrefused|econnreset|etimedout|socket hang up|network error|无法联网|网络|代理/iu;
const CLI_TIMEOUT_SIGNATURE = /执行超过|已停止|超时|timed out|timeout/iu;

export function classifyEngineCliIssue(message: string): EngineCliIssue {
  const text = String(message || "").trim();
  if (CLI_AUTH_SIGNATURE.test(text)) {
    return {
      code: "cli_auth_required",
      title: "本机 CLI 当前登录态不可用",
      detail: `CLI 报「${text.slice(0, 160)}」。独立版 CLI 的凭据在 ~/.codebuddy；如果你刚用 workbuddy switch 之类的工具切过账号，注意它对已启动的进程不会立即生效。CRM 只要求这台机器的 CLI 能用，不绑定具体账号。`,
      command: "① 终端执行 /opt/homebrew/bin/codebuddy --version 确认 CLI 本身可用　② 需要登录时运行 /opt/homebrew/bin/codebuddy 后输入 /login　③ 用 CLI 账号切换工具的话，切完稍等十几秒再重试（Runner 会自动重新探测）"
    };
  }
  if (CLI_NETWORK_SIGNATURE.test(text)) {
    return {
      code: "cli_network",
      title: "本机 CLI 联网失败",
      detail: `CLI 连不上云端（${text.slice(0, 160)}）。最常见原因是 macOS 系统代理指向了已经退出的 VPN 端口。`,
      command: "检查系统代理：scutil --proxy；确认 V2BOX / LetsVPN 等代理工具是否在运行，或直接在系统设置里关掉失效代理"
    };
  }
  if (CLI_TIMEOUT_SIGNATURE.test(text)) {
    return {
      code: "cli_timeout",
      title: "CLI 执行超时",
      detail: `${text.slice(0, 160)}。文件过大或模型排队时会出现。`,
      command: "在「AI 引擎设置」里调大 CLI 超时秒数，或换更小的文件重试"
    };
  }
  return {
    code: "cli_failed",
    title: "本机 CLI 执行失败",
    detail: text ? text.slice(0, 200) : "CLI 没有返回可用的错误信息。",
    command: "可先在终端单独运行 /opt/homebrew/bin/codebuddy 确认 CLI 本身可用，再重试"
  };
}

/** Runner 不在线 / 未配对时给用户的动作（比「没有在线的本地 Runner」有用得多） */
export function engineRunnerOfflineIssue(hint: string, code = ""): EngineCliIssue {
  if (code === "AI_ENGINE_CLI_MISSING") {
    return {
      code: "cli_failed",
      title: "这台 Runner 上暂时用不了本机 CLI",
      detail: hint || "Runner 在线，但当前探测不到可用的本机 CLI。",
      command: "① 终端执行 /opt/homebrew/bin/codebuddy --version 确认 CLI 可用（用哪个账号都行）　② 刚切换过 CLI 账号就等十几秒，Runner 会自动重新探测并恢复　③ 仍不行则重启 Runner：launchctl kickstart -k gui/$(id -u)/com.goodjob.local-runner"
    };
  }
  const title = code === "AI_ENGINE_RUNNER_OFFLINE" ? "设置里指定的 Runner 当前不可用"
    : code === "AI_ENGINE_WORKSPACE_MISSING" ? "本机 Runner 没有授权工作目录"
      : code === "AI_ENGINE_RUNNER_UNAVAILABLE" ? "本地 Runner 暂时不可用（缺少 MySQL 持久化）"
        : "本机 Runner 没有运行";
  return {
    code: "cli_failed",
    title,
    detail: hint || "CRM 里没有在线的本地 Runner，任务无法派给本机 CLI。",
    command: "cd ~/Desktop/GoodJob_private/goodjob-runner && node dist/cli.js start（或在系统里重新启动 com.goodjob.local-runner 服务）"
  };
}

export interface RunnableEngineCliTask {
  taskId: string;
  runnerId: string;
  runnerName: string;
  adapter: AiEngineAdapter;
  workspace: string;
  engine: string;
}

/**
 * 把「模型 / 思考档位」合并进任务提示词首行的执行档位标记。
 *
 * 标记协议由 Runner 解析（goodjob-runner/src/workbuddy-adapter.ts）：
 *   [[gj-cli-options {"model":"deep-model","effort":"high","maxTurns":6,"disallowedTools":[...]}]]
 *
 * 两种情形：
 *   1) 提示词本来没有标记 → 在前面补一行；
 *   2) 本来有（如客户资料识别的快速档）→ **只覆盖 model / effort**，maxTurns 与
 *      disallowedTools 原样保留。那些是「别去探索仓库」的硬约束，跟模型强弱无关。
 *
 * 两个值都为空时原样返回，不产生多余标记（Runner 侧也就不用解析）。
 */
export function applyCliProfileToPrompt(prompt: string, patch: { model?: string; effort?: string }) {
  const model = String(patch.model || "").trim();
  const effort = String(patch.effort || "").trim();
  if (!model && !effort) return prompt;
  const prefix = "[[gj-cli-options ";
  if (!prompt.startsWith(prefix)) {
    const payload: Record<string, string> = {};
    if (model) payload.model = model;
    if (effort) payload.effort = effort;
    return `${prefix}${JSON.stringify(payload)}]]\n${prompt}`;
  }
  const lineEnd = prompt.indexOf("\n");
  const header = lineEnd === -1 ? prompt : prompt.slice(0, lineEnd);
  const rest = lineEnd === -1 ? "" : prompt.slice(lineEnd + 1);
  const start = header.indexOf("{");
  const end = header.lastIndexOf("}");
  let payload: Record<string, unknown> = {};
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(header.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      // 标记本身坏了也不必救：重新序列化一份干净的即可
      payload = {};
    }
  }
  if (model) payload.model = model;
  if (effort) payload.effort = effort;
  return `${prefix}${JSON.stringify(payload)}]]${rest ? `\n${rest}` : ""}`;
}

/** 建一次 CLI 任务（只排队，不等结果） */
export async function enqueueEngineCliTask(
  actor: SessionUser,
  choice: EngineRunnerChoice,
  prompt: string,
  timeoutSeconds: number,
  /**
   * 任务级模型 / 思考档位。由调用方从团队 AI 引擎设置里取，统一在这里注入，
   * 避免每个调用点各自拼标记（漏一处就悄悄用回了 fast-model）。
   * 只对 WorkBuddy CLI 生效：模型 ID 是 WorkBuddy 侧的命名，Codex 不认。
   */
  profile: { model?: string; effort?: string } = {}
): Promise<RunnableEngineCliTask> {
  const service = getLocalRunnerService();
  if (!service) {
    throw new EngineUnavailableError("AI_ENGINE_RUNNER_UNAVAILABLE", "本地 Runner 需要 MySQL 持久化后才能使用 CLI 执行", 503);
  }
  const task = await service.createTask(actor, {
    runnerId: choice.runnerId,
    adapter: choice.adapter,
    prompt: applyCliProfileToPrompt(prompt, choice.adapter === "workbuddy" ? profile : {}),
    workspace: choice.workspace,
    executionMode: "read_only",
    timeoutSeconds
  });
  return {
    taskId: task.id,
    runnerId: choice.runnerId,
    runnerName: choice.displayName,
    adapter: choice.adapter,
    workspace: choice.workspace,
    engine: `${aiEngineAdapterLabel(choice.adapter)}${choice.cliVersion ? ` ${choice.cliVersion}` : ""}`
  };
}

const TERMINAL_TASK_STATUSES = ["succeeded", "failed", "cancelled"];

export function cliTaskDone(status: string) {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** 读一次 CLI 任务状态 */
export async function readEngineCliTask(
  actor: SessionUser,
  taskId: string
): Promise<EngineCliTaskSnapshot | null> {
  const service = getLocalRunnerService();
  if (!service) return null;
  try {
    const detail = await service.task(actor, taskId);
    return {
      id: detail.task.id,
      status: detail.task.status,
      resultText: detail.task.resultText || "",
      errorMessage: detail.task.errorMessage || "",
      outputTruncated: Boolean(detail.task.outputTruncated),
      engine: "",
      events: (detail.events || []).map((event) => ({ eventType: event.eventType, message: event.message || "" })),
      runnerId: detail.task.runnerId,
      queuedAt: detail.task.queuedAt,
      startedAt: detail.task.startedAt
    };
  } catch {
    return null;
  }
}

/**
 * 排队实况：Runner 同时只执行一个任务，所以「排在别人后面」是 CLI 任务变慢的头号原因
 * （2026-10-10 实测：任务在队列里等了 107 秒，CLI 真正执行只用了 21 秒）。
 * 前端据此把「正在排队，前面有任务在跑」讲清楚，而不是让用户干等。
 */
export async function engineRunnerQueueState(actor: SessionUser, snapshot: EngineCliTaskSnapshot) {
  const service = getLocalRunnerService();
  if (!service || !snapshot.runnerId) return { runnerOnline: false, busy: false, activeTasks: 0 };
  try {
    const runners = await service.runners(actor);
    const runner = runners.find((item) => item.id === snapshot.runnerId);
    const activeTasks = await service.activeTaskCount(actor, snapshot.runnerId);
    return { runnerOnline: Boolean(runner?.online), busy: activeTasks > 0, activeTasks };
  } catch {
    return { runnerOnline: false, busy: false, activeTasks: 0 };
  }
}

/**
 * 等 CLI 任务到终态。
 * waitMs = 0 表示只探一次（用于轮询接口）。
 * 超时不抛错，返回最后一次看到的快照，由调用方决定是继续排队还是报错。
 * onTick：每轮探到快照都会回调（含第一次），获客作业用它做 @@FOUND@@ 增量入池。
 */
export async function waitForEngineCliTask(
  actor: SessionUser,
  taskId: string,
  waitMs: number,
  intervalMs = 2_000,
  onTick?: (snapshot: EngineCliTaskSnapshot) => void
): Promise<EngineCliTaskSnapshot | null> {
  const deadline = Date.now() + Math.max(0, waitMs);
  let snapshot = await readEngineCliTask(actor, taskId);
  onTick?.(snapshot!);
  while (snapshot && !cliTaskDone(snapshot.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(250, deadline - Date.now()))));
    snapshot = await readEngineCliTask(actor, taskId);
    onTick?.(snapshot!);
  }
  return snapshot;
}

/**
 * 引擎等待窗口：HTTP 请求内最多等多久就交给前端轮询。
 * 默认 75 秒——足够覆盖一次本机 CLI 背调（实测 20-60 秒），又不至于把请求拖到网关超时。
 */
export function engineInlineWaitMilliseconds() {
  const configured = Number(process.env.AI_ENGINE_INLINE_WAIT_MS || 75_000);
  if (!Number.isFinite(configured)) return 75_000;
  return Math.max(0, Math.min(600_000, Math.floor(configured)));
}
