import { getAppSetting, setAppSetting } from "./app-settings.js";

// ---------------------------------------------------------------------------
// AI 执行来源（引擎）设置
//
// 设计目标（用户 2026-10-06 要求）：
// 「背调」「开发信」不再只有一条固定链路，而是可以选择由谁来干：
//   - crm / template：只用 CRM 自己的资料与规则模板（不联网、不调模型，永远可用）
//   - ai：调用用户在「AI 配置」里配好的模型 API（原有行为）
//   - cli：交给本机已配对的 Runner 上的 CLI（WorkBuddy CLI / Codex CLI）执行
//
// CRM 在这里的角色是「稳定框架」：它负责准备事实、冻结提示词、留档结果、
// 做质量自检与权限判定；具体是谁产出结论可以随时替换。
//
// 设置按团队存：app_settings 的 KV 表（key = ai_engine_settings:<teamId>），
// 不需要新增业务表，也不参与 persistAll 全表重写。
// ---------------------------------------------------------------------------

export type ResearchEngineSource = "crm" | "ai" | "cli";
export type EmailEngineSource = "template" | "ai" | "cli";
export type AiEngineAdapter = "workbuddy" | "codex";

// ---------------------------------------------------------------------------
// CLI 模型与思考档位
//
// 为什么需要它（2026-10-10 实测）：CLI 没配过模型时，会落到**它自己那档由账号决定的默认**
// （同一台机器上实测见过 fast-model，也见过 hy4-preview-f）——所有走 CLI 的背调 / 开发信 /
// 获客 / 资料识别都在用它，结果是「能用，但明显不如以前聪明」，且换账号后表现不可复现。
// 因此本文件既提供显式开关，也把**出厂默认**固定成 AI_ENGINE_CLI_MODEL_DEFAULT：
// 不配置的团队也会显式传 `--model`，不再受登录账号影响。
//
// 三处白名单必须一致：本文件 / CLI 的 `--help`（supported list）/ Runner 的 MODEL_IDS
// （goodjob-runner/src/workbuddy-adapter.ts）。Runner 侧对非法取值静默忽略，
// 所以这里也要挡一道，避免用户存下一个永远不生效的值。
// ---------------------------------------------------------------------------
export interface AiEngineCliModelOption {
  id: string;
  label: string;
  note: string;
}

export const AI_ENGINE_CLI_MODELS: AiEngineCliModelOption[] = [
  { id: "fast-model", label: "fast-model · 最快", note: "CLI 最轻的一档，响应最快、思考最少" },
  { id: "balanced-model", label: "balanced-model · 均衡", note: "速度与质量折中，日常任务够用" },
  { id: "deep-model", label: "deep-model · 深度", note: "思考最充分，适合背调、写开发信这类需要判断力的任务" },
  { id: "deepseek-v4-pro", label: "deepseek-v4-pro", note: "强推理，长文分析与结论归纳稳" },
  { id: "deepseek-v4.1-flash", label: "deepseek-v4.1-flash · 系统默认", note: "快而稳的通用档；系统的出厂默认模型，未配置时即用它" },
  { id: "hy4-preview", label: "hy4-preview（混元）", note: "混元最新预览版，中文理解好" },
  { id: "hy4-preview-f", label: "hy4-preview-f（混元快版）", note: "混元预览的快版本" },
  { id: "hy3", label: "hy3（混元 3）", note: "上一代混元，稳定" },
  { id: "hy3-x", label: "hy3-x（混元 3 加强）", note: "hy3 的加强档" },
  { id: "space-bunny", label: "space-bunny", note: "长上下文场景" },
  { id: "glm-5.3", label: "glm-5.3（智谱）", note: "智谱新一代，指令跟随好" },
  { id: "glm-5.3-flash", label: "glm-5.3-flash", note: "glm-5.3 的快版本" },
  { id: "glm-5.2", label: "glm-5.2", note: "智谱上一代" },
  { id: "glm-5.1", label: "glm-5.1", note: "智谱较早版本" },
  { id: "glm-5v-turbo", label: "glm-5v-turbo（视觉）", note: "带视觉能力，适合图片/扫描件识别" },
  { id: "minimax-m3", label: "minimax-m3", note: "长文本与结构化输出" },
  { id: "kimi-k3-1", label: "kimi-k3-1", note: "超长上下文，适合大文件" },
  { id: "kimi-k2.8-preview", label: "kimi-k2.8-preview", note: "Kimi 预览版" },
  { id: "kimi-k2.7", label: "kimi-k2.7", note: "Kimi 稳定版" },
  { id: "kimi-k2.6", label: "kimi-k2.6", note: "Kimi 较早版本" }
];

export const AI_ENGINE_CLI_MODEL_IDS = new Set(AI_ENGINE_CLI_MODELS.map((item) => item.id));

/**
 * 出厂默认模型（2026-10-10 用户指定）。
 * 未配置过 AI 执行设置的团队会直接用它，而不是落到 CLI 那档「随登录账号变化」的默认。
 * 必须落在 AI_ENGINE_CLI_MODEL_IDS 内，否则 sanitize 会把它当非法值回落成空串。
 */
export const AI_ENGINE_CLI_MODEL_DEFAULT = "deepseek-v4.1-flash";

/** 思考档位（与 Runner 的 EFFORT_LEVELS 一致）；留空 = 跟随 CLI 默认 */
export const AI_ENGINE_CLI_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const aiEngineCliEffortLabels: Record<string, string> = {
  minimal: "minimal · 几乎不思考（最快）",
  low: "low · 轻量",
  medium: "medium · 标准",
  high: "high · 深入",
  xhigh: "xhigh · 很深入",
  max: "max · 最深（最慢）"
};

export function aiEngineCliModelLabel(id: string) {
  return AI_ENGINE_CLI_MODELS.find((item) => item.id === id)?.label || id;
}

export interface TeamAiEngineSettings {
  teamId: string;
  /** 默认背调来源 */
  researchSource: ResearchEngineSource;
  /** 默认开发信撰写来源 */
  emailSource: EmailEngineSource;
  /** 走 CLI 时用哪个 CLI */
  cliAdapter: AiEngineAdapter;
  /**
   * 走 CLI 时用哪个模型。留空 = 不传 `--model`，由 CLI 按其**当前登录账号**的默认模型执行。
   * ⚠️ 不要假设默认值：实测同一台机器上会随 `workbuddy switch` 切账号而变（见过 fast-model、
   * 也见过 hy4-preview-f）。要让全团队行为稳定，就显式指定模型。
   */
  cliModel: string;
  /** 走 CLI 时的思考档位（minimal…max）。留空 = 跟随 CLI 默认 */
  cliEffort: string;
  /** 走 CLI 时在哪个工作目录里执行（必须是 Runner 已授权的目录） */
  cliWorkspace: string;
  /** 走 CLI 时的最长执行时间（秒） */
  cliTimeoutSeconds: number;
  /** 指定 Runner；留空表示自动挑选一台在线且带该 CLI 能力的 Runner */
  runnerId: string;
  updatedBy: string;
  updatedAt: string;
}

export const RESEARCH_ENGINE_SOURCES: ResearchEngineSource[] = ["crm", "ai", "cli"];
export const EMAIL_ENGINE_SOURCES: EmailEngineSource[] = ["template", "ai", "cli"];
export const AI_ENGINE_ADAPTERS: AiEngineAdapter[] = ["workbuddy", "codex"];

/** CLI 任务的默认与边界（秒）：默认 15 分钟，最长 24 小时，与 Runner 任务上限一致 */
export const AI_ENGINE_CLI_TIMEOUT_DEFAULT = 900;
export const AI_ENGINE_CLI_TIMEOUT_MAX = 86_400;
export const AI_ENGINE_CLI_TIMEOUT_MIN = 60;

export const aiEngineSourceLabels: Record<string, string> = {
  crm: "CRM 本地证据",
  ai: "AI API",
  cli: "本机 CLI",
  template: "规则模板"
};

export function aiEngineSourceLabel(source: string) {
  return aiEngineSourceLabels[source] || source;
}

export function aiEngineAdapterLabel(adapter: AiEngineAdapter) {
  return adapter === "codex" ? "Codex CLI" : "WorkBuddy CLI";
}

export function clampAiEngineTimeout(value: number) {
  if (!Number.isFinite(value)) return AI_ENGINE_CLI_TIMEOUT_DEFAULT;
  return Math.max(AI_ENGINE_CLI_TIMEOUT_MIN, Math.min(AI_ENGINE_CLI_TIMEOUT_MAX, Math.floor(value)));
}

export function defaultTeamAiEngineSettings(teamId: string): TeamAiEngineSettings {
  return {
    teamId,
    // 默认保持既有行为：背调走 AI（配好就用），开发信走规则模板 + AI（有 AI 就用 AI）
    researchSource: "ai",
    emailSource: "ai",
    cliAdapter: "workbuddy",
    // 出厂默认模型：显式指定，避免落到 CLI 那档随登录账号变化的默认（见文件头说明）
    cliModel: AI_ENGINE_CLI_MODEL_DEFAULT,
    cliEffort: "",
    cliWorkspace: "",
    cliTimeoutSeconds: AI_ENGINE_CLI_TIMEOUT_DEFAULT,
    runnerId: "",
    updatedBy: "",
    updatedAt: ""
  };
}

export function aiEngineSettingsKey(teamId: string) {
  return `ai_engine_settings:${teamId || "default"}`;
}

export function sanitizeTeamAiEngineSettings(
  teamId: string,
  input: (Partial<TeamAiEngineSettings> & Record<string, unknown>) | TeamAiEngineSettings | null | undefined,
  base?: TeamAiEngineSettings
): TeamAiEngineSettings {
  const fallback = base && base.teamId === teamId ? base : defaultTeamAiEngineSettings(teamId);
  const raw = (input || {}) as Record<string, unknown>;
  const researchSource = RESEARCH_ENGINE_SOURCES.includes(raw.researchSource as ResearchEngineSource)
    ? raw.researchSource as ResearchEngineSource
    : fallback.researchSource;
  const emailSource = EMAIL_ENGINE_SOURCES.includes(raw.emailSource as EmailEngineSource)
    ? raw.emailSource as EmailEngineSource
    : fallback.emailSource;
  const cliAdapter = AI_ENGINE_ADAPTERS.includes(raw.cliAdapter as AiEngineAdapter)
    ? raw.cliAdapter as AiEngineAdapter
    : fallback.cliAdapter;
  // 模型 / 档位：空串是合法值（= 跟随 CLI 默认）；非空必须在白名单内，否则回落到上一次的值。
  // 挡在这里的原因：Runner 对非法取值是「静默忽略」，存下去会变成一个永远不生效的假设置。
  const cliModelRaw = typeof raw.cliModel === "string" ? raw.cliModel.trim() : fallback.cliModel;
  const cliModel = !cliModelRaw || AI_ENGINE_CLI_MODEL_IDS.has(cliModelRaw) ? cliModelRaw : fallback.cliModel;
  const cliEffortRaw = typeof raw.cliEffort === "string" ? raw.cliEffort.trim().toLowerCase() : fallback.cliEffort;
  const cliEffort = !cliEffortRaw || (AI_ENGINE_CLI_EFFORTS as readonly string[]).includes(cliEffortRaw)
    ? cliEffortRaw
    : fallback.cliEffort;
  const cliWorkspace = typeof raw.cliWorkspace === "string"
    ? raw.cliWorkspace.trim().slice(0, 1000)
    : fallback.cliWorkspace;
  const runnerId = typeof raw.runnerId === "string" ? raw.runnerId.trim().slice(0, 80) : fallback.runnerId;
  const cliTimeoutSeconds = typeof raw.cliTimeoutSeconds === "number"
    ? clampAiEngineTimeout(raw.cliTimeoutSeconds)
    : fallback.cliTimeoutSeconds;
  return {
    teamId,
    researchSource,
    emailSource,
    cliAdapter,
    cliModel,
    cliEffort,
    cliWorkspace,
    cliTimeoutSeconds,
    runnerId,
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy.slice(0, 64) : fallback.updatedBy,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt.slice(0, 40) : fallback.updatedAt
  };
}

export async function readTeamAiEngineSettings(teamId: string): Promise<TeamAiEngineSettings> {
  const defaults = defaultTeamAiEngineSettings(teamId);
  const stored = await getAppSetting(aiEngineSettingsKey(teamId));
  if (!stored) return defaults;
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    return sanitizeTeamAiEngineSettings(teamId, parsed, defaults);
  } catch {
    // 存量数据损坏：按默认值处理，不阻断功能
    return defaults;
  }
}

export async function writeTeamAiEngineSettings(settings: TeamAiEngineSettings): Promise<TeamAiEngineSettings> {
  const sanitized = sanitizeTeamAiEngineSettings(settings.teamId, settings, defaultTeamAiEngineSettings(settings.teamId));
  await setAppSetting(aiEngineSettingsKey(sanitized.teamId), JSON.stringify(sanitized));
  return sanitized;
}

/**
 * 本次操作实际使用的来源：
 * 请求显式指定则用请求的；否则用团队默认。返回值始终落在允许集合内。
 */
export function resolveEngineSource<T extends string>(
  requested: unknown,
  fallback: T,
  allowed: readonly T[]
): T {
  return typeof requested === "string" && allowed.includes(requested as T) ? requested as T : fallback;
}
