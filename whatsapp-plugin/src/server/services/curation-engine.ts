/**
 * 「整理」用的模型通道 —— **三档唯一来源**。
 *
 * 之前每处「把对话变成内容」的地方各写一套三元式（跟进同步是 `cli ? cli : rules`，
 * 训练档案是 `useAi ? ai : rules`），结果同一个插件里同一个问题有三种答案。
 * 从现在起一律走这里解析：**CLI 托管 → 配置的 AI 模型 → 都没有**。
 *
 * - `cli`：本机 WorkBuddy CLI 托管（已登录即可用，零 API Key、零额外费用）
 * - `ai` ：插件里配置过且启用的 AI Provider
 * - `none`：两者都没有 —— 降级成一句「当天有跟进」占位，**绝不退到抄客户原话**
 */
export type CurationEngine = "cli" | "ai" | "none";

/**
 * 没有模型通道时写进 CRM 的正文（用户 2026-10-14 指定口径，逐字不改）。
 *
 * 为什么必须留一句占位，而不是留空、也不是抄原文：
 * - 留空 → 跟进历史看不出「这天到底联系过没有」，而「哪天有联系」本身就是业务信息；
 * - 抄客户原话 → 报价、折扣、交期一旦沉淀进 `customerActivities`，就会被当成既定承诺，
 *   而且那张表同时是业绩考核 `followUpCount` 的数据源，写进去的东西撤不干净。
 */
export const CURATION_PLACEHOLDER = "当天有跟进（未配置AI，未整理具体内容）";

/** 记录与站内信里给「为什么没整理」的说明。 */
export const CURATION_UNAVAILABLE_REASON = "未配置 CLI，也没有可用的 AI 模型";

/**
 * 解析当前该走哪条通道。**纯函数**：调用方自己把「CLI 是否可用」「有没有 Provider」查好传进来，
 * 这样这条策略可以被单测直接钉住，不用起子进程、不用连库。
 */
export function resolveCurationEngine(input: {
  cliAvailable: boolean;
  providerId?: string | null;
  aiAvailable: boolean;
}): CurationEngine {
  if (input.cliAvailable) return "cli";
  if (input.aiAvailable && input.providerId) return "ai";
  return "none";
}

/**
 * 挑一个 AI Provider。**优先级是刻意的**，不是「随便挑一个」：
 *
 * 1. `candidates` 里第一个**确实存在且启用**的 —— 调用方按「离这次任务最近的显式配置」排好序
 *    （自动化里的深度分析 Provider → 自动回复里选的 Provider）。
 * 2. 都没有显式配置时，退到一个**启用**的 Provider —— 真正测通过的优先。
 *    用户「配了 AI 模型」通常就是配在这里，不该因为没选过下拉框就判成「未配置」。
 * 3. 一个都没有 → `null`（= 没配）。
 *
 * 已被停用 / 已删除的 id 一律不认，否则会出现「配置指向一个不存在的 Provider、
 * 整条链静默降级成占位」这种最难查的状态。
 */
export function pickCurationProviderId(input: {
  candidates: Array<string | null | undefined>;
  profiles: Array<{ id: string; enabled: boolean; lastTestStatus?: string }>;
}): string | null {
  const usable = input.profiles.filter((profile) => profile.enabled);
  for (const candidate of input.candidates) {
    if (candidate && usable.some((profile) => profile.id === candidate)) return candidate;
  }
  return (usable.find((profile) => profile.lastTestStatus === "success") ?? usable[0])?.id ?? null;
}

/** 通道在界面 / 记录里的名字。`model` 只在 AI 通道下有意义。 */
export function curationEngineLabel(engine: CurationEngine, model?: string | null): string {
  if (engine === "cli") return "本机 CLI 托管";
  if (engine === "ai") return model ? `AI 模型 · ${model}` : "AI 模型";
  return "未配置模型";
}
