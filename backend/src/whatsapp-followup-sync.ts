import { z } from "zod";
import { randomUUID } from "node:crypto";
import { callAiModel, extractJsonObject } from "./ai-model-runtime.js";
import { CLI_SUMMARY_MODEL, runCliSummary } from "./cli-ai.js";
import { getStore } from "./store.js";
import type { AiModelConfig, SessionUser } from "./types.js";

// ---------------------------------------------------------------------------
// WhatsApp 跟进同步 · CRM 侧「大脑」（2026-10-15 从 whatsapp-plugin 搬入）。
//
// 用户拍板「结论在 CRM 做」：插件只保留会话库与触发（定时 tick / 扩展按钮），
// 把当天消息打包 POST 到 /api/whatsapp/followup-sync；这里完成
// 客户匹配 → 直写跟进/线索 → 站内信 → 逐会话明细。
//
// 2026-10-15 二次改版（用户拍板「先接进来，CLI 总结后再补全」）：
//  **两段式写入**。同步请求里**只做零延迟的基础写入**（统计性内容：条数/收发/最后互动），
//  跟进与客户旅程立即可见；AI 进展总结全部走**后台补全**——本机 CLI 优先
//  （cli-ai.ts，deepseek-v4.1-flash），失败退 CRM 配置的 AI 模型，再失败保留基础内容
//  （绝不用干瘪占位句覆盖统计内容）。这样既有即时性，又能被 AI 补足，
//  外部模型挂了（实测 52token key 401）也不再拖累同步。
//
// 插件时代的硬约束原样保留（docs/WHATSAPP-FOLLOWUP-SYNC-DESIGN.md）：
//  1. **只写整理过的内容，绝不写原文。** 原文只在请求体里路过，不落 CRM 库；
//     基础内容是纯统计（条数/收发/时间），同样没有原文。
//  2. **匹配不上就不猜。** 号码命中 0 个客户 → 建线索；命中 2 个以上 → 什么都不写，
//     只报警。绝不「取第一个」——写错客户的跟进比不写严重得多。
//  3. **每个自动写入都带可识别前缀** `[WhatsApp 自动同步 YYYY-MM-DD]`。
//  4. **同一天重跑是「改写」不是「再写一条」。** 插件把 priorActivityId 带回来，
//     重跑走改写；线索按 `(owner, channel, externalId)` 幂等。
//  5. **后台总结是 best-effort**：CLI/模型都失败时保留基础内容并在服务端日志留痕，
//     绝不把「当天有跟进」这种干瘪占位写进跟进历史。
//  6. **只读绝不发送。** 这条链不向 WhatsApp 发任何东西。
//  7. **单个会话失败不拖垮整轮**，每个会话都有一条明细（含跳过）。
// ---------------------------------------------------------------------------

/** 进跟进历史的正文前缀。用户按它区分「机器写的」与「人写的」，撤销也按它筛。 */
export const FOLLOWUP_MARKER_PREFIX = "WhatsApp 自动同步";
/** 线索来源名。 */
export const FOLLOWUP_LEAD_SOURCE = "WhatsApp 自动同步";
/** 线索渠道，同时是线索幂等键的一半：`(owner, channel, externalId)`。 */
export const FOLLOWUP_LEAD_CHANNEL = "whatsapp";

/** `customerActivities.content` 的上限（与 POST /api/customers/{id}/activities 一致）。 */
const MAX_ACTIVITY_CHARS = 2_000;
/** 站内信 content 上限。 */
const MAX_NOTIFICATION_CHARS = 5_000;
/** 单次请求最多处理多少个会话（插件侧会分批，这里再兜一道）。 */
const MAX_CONVERSATIONS_PER_BATCH = 30;
/** 喂给模型的对话上限（取最后 N 条）。 */
const MAX_MESSAGES_PER_CONVERSATION = 40;
/** 单条消息进提示词的字符上限。 */
const MAX_MESSAGE_CHARS = 500;
/** 单次摘要的模型超时。逐会话调用，不能让它拖住整批。 */
const SUMMARY_TIMEOUT_MS = 45_000;

/** `[WhatsApp 自动同步 2026-10-15]` */
export function followupMarker(runDate: string): string {
  return `[${FOLLOWUP_MARKER_PREFIX} ${runDate}]`;
}

/** 跟进记录正文：marker + 摘要。marker 必须打头，批量识别才靠得住。 */
export function buildActivityContent(runDate: string, summary: string): string {
  const marker = followupMarker(runDate);
  const body = summary.trim().slice(0, MAX_ACTIVITY_CHARS - marker.length - 1);
  return `${marker} ${body}`.trim().slice(0, MAX_ACTIVITY_CHARS);
}

/**
 * 线索的幂等键。**刻意不带日期**：线索描述「这个人是谁」，一个号码只该有一条。
 * 把 `+49…` 与 `0049…` 两种写法归一，同一个人的两种形态落到同一条线索。
 */
export function leadExternalId(phone: string): string {
  const digits = `+${String(phone ?? "").replace(/\D/gu, "")}`.replace(/^\+0+/u, "+");
  return `${FOLLOWUP_LEAD_CHANNEL}:${digits}`;
}

/** CRM 库里的号码统一成 `+数字`；空号返回空串。 */
export function normalizePhone(value: string | null | undefined): string {
  const digits = String(value ?? "").replace(/\D/gu, "");
  return digits ? `+${digits}` : "";
}

/** 没有模型通道时写进跟进历史的正文（沿用插件时代用户指定的口径，逐字不改）。 */
export const CURATION_PLACEHOLDER = "当天有跟进（未配置AI，未整理具体内容）";
/** 记录与站内信里给「为什么没整理」的说明。 */
export const CURATION_UNAVAILABLE_REASON = "CRM 没有已启用的 AI 模型配置";
/** 基础跟进的收尾说明：告诉看的人这条会被 AI 自动补全。 */
export const BASIC_PENDING_NOTE = "AI 进展总结生成中，完成后自动补全本条";

/**
 * 两段式的第一段：**零延迟基础跟进**。纯统计（条数/收发/最后互动），不调任何模型、
 * 不含消息原文 —— 它保证「接进来」的瞬间跟进与客户旅程就有内容可看。
 */
export function basicFollowupSummary(conversation: FollowupSyncConversationInput): string {
  if (!hasRecordableContent(conversation.messages)) {
    return greetingTouchSummary(conversation.messages);
  }
  const inbound = conversation.messages.filter((message) => message.direction === "inbound").length;
  const outbound = conversation.messages.length - inbound;
  const times = conversation.messages
    .map((message) => message.occurredAt)
    .map((raw) => {
      const match = /(\d{1,2}:\d{2})/.exec(String(raw ?? ""));
      return match ? match[1] : "";
    })
    .filter(Boolean)
    .sort();
  const last = times.at(-1) ?? "";
  const parts = [
    `当日互动 ${conversation.messages.length} 条（接收 ${inbound} · 发出 ${outbound}）`,
    last ? `最后互动 ${last}` : ""
  ].filter(Boolean);
  return `${parts.join("，")}；${BASIC_PENDING_NOTE}`;
}

/**
 * 寒暄日的轻互动记录（2026-10-15 用户拍板：问好也算维护旅程）。
 * 固定模板：只报条数，不生成任何业务内容——它不是摘要，没有编造空间。
 */
export function greetingTouchSummary(messages: Array<{ body: string }>): string {
  return `当日仅寒暄类互动（${messages.length} 条），无具体业务内容，保持联系中`;
}

const GREETING_PATTERN = /^(?:(?:hi+|hello+|hey+|okay|ok|k|thanks|thank you|thx|ty|good (?:morning|afternoon|evening|night)|noted|got it|well received|收到|好的|好|嗯|哦|噢|你好|您好|哈喽|嗨|谢谢|多谢|感谢|在吗|在么|稍等|可以|没问题|明白|了解)[\s!！。．.,，~～👍🙏😊😀]*)+$/iu;

export function isGreetingLike(body: string): boolean {
  const text = String(body ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return true;
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  return GREETING_PATTERN.test(text);
}

/** 当天有没有值得记录的对话（模型不在时的规则判据）。 */
export function hasRecordableContent(messages: Array<{ body: string }>): boolean {
  return messages.some((message) => !isGreetingLike(message.body));
}

const summarySchema = z.object({
  summary: z.string().max(600).optional().default(""),
  /** 模型自评：这条对话值不值得进跟进历史（系统通知/撤回的日子 → false）。 */
  worthRecording: z.boolean().optional()
});

/**
 * 摘要提示词。**一整段**（CRM 的 `callAiModel` 把整段当 user 消息发，系统提示是它自己拼的），
 * 与插件时代 `SUMMARY_PROMPT_SYSTEM + user JSON` 逐字同源，只换了拼法。
 * 禁令不是洁癖：摘要会写进业绩报表旁边的跟进历史，一句被模型擅自复述的
 * 「客户同意 30% 预付」就足以变成一次错误的商务承诺。
 */
export function buildSummaryPrompt(input: {
  contactName: string;
  contactPhone: string;
  day: string;
  messages: Array<{ direction: "inbound" | "outbound"; occurredAt: string; body: string }>;
}): string {
  const transcript = input.messages.slice(-MAX_MESSAGES_PER_CONVERSATION).map((message) => ({
    who: message.direction === "inbound" ? "customer" : "us",
    at: message.occurredAt,
    text: String(message.body ?? "").replace(/\r\n?/gu, "\n").slice(0, MAX_MESSAGE_CHARS)
  }));
  return [
    "Task: write ONE short Chinese follow-up note for a CRM record, from a day of WhatsApp messages.",
    'Return one JSON object only, exactly this shape: {"summary":string,"worthRecording":boolean}',
    "- `summary`: 1-2 sentences in Chinese: what the customer wants, what is still open, what the next step is. Max 120 characters. Write it as a note a salesperson would file.",
    "- A greeting or short small talk still counts as a lightweight touch (the relationship is alive): set `worthRecording` true and write e.g. 客户今日寒暄互动，暂无具体业务内容，保持联系中.",
    "- `worthRecording`: false only when there was no real interaction at all (system notices only, or messages the customer then deleted). Then `summary` must be \"\".",
    "- NEVER repeat prices, discounts, payment percentages, lead times or stock numbers. If the customer raised commercial terms, write only: 客户提到商务条件，需人工确认。",
    "- Do not invent facts that are not in the messages. Do not mention the channel, the phone number, or that this note is automated.",
    "- Do not call any tool. Do not search the workspace. Do not explain. Output JSON only.",
    "",
    JSON.stringify({ customer: input.contactName, customerPhone: input.contactPhone, day: input.day, messages: transcript })
  ].join("\n");
}

/** 模型有时会把数字顺手复述出来。守不住「不复述商务条件」这条，宁可整条不要。 */
export function sanitizeSummary(value: string): string {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return "";
  const risky = /(\d+(?:\.\d+)?\s*%|\d[\d,]{2,}\s*(?:件|台|个|美元|美金|欧元|元|usd|eur)|预付|折扣|交期|账期|单价|报价)/iu;
  return risky.test(text) ? "客户提到商务条件，需人工确认。" : text.slice(0, 300);
}

export interface FollowupSyncConversationInput {
  conversationId: string;
  contactName: string;
  contactPhone: string;
  /** 上一次写入的跟进记录 id：带着它重跑就是改写，不带就是新建。 */
  priorActivityId?: string;
  messages: Array<{ direction: "inbound" | "outbound"; occurredAt: string; body: string }>;
}

export interface FollowupSyncPayload {
  runId: string;
  runDate: string;
  timezone: string;
  conversations: FollowupSyncConversationInput[];
}

export const followupSyncPayloadSchema = z.object({
  runId: z.string().min(1).max(128),
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "runDate 必须是 YYYY-MM-DD"),
  timezone: z.string().min(1).max(64),
  conversations: z.array(z.object({
    conversationId: z.string().min(1).max(180),
    contactName: z.string().max(180).default(""),
    contactPhone: z.string().max(40).default(""),
    priorActivityId: z.string().max(180).optional(),
    messages: z.array(z.object({
      direction: z.enum(["inbound", "outbound"]),
      occurredAt: z.string().min(1).max(40),
      body: z.string().max(8_000).default("")
    })).max(500).default([])
  })).max(MAX_CONVERSATIONS_PER_BATCH).default([])
});

export interface FollowupSyncOutcome {
  conversationId: string;
  contactName: string;
  contactPhone: string;
  messageCount: number;
  kind: "customer" | "lead" | "skipped";
  status: "written" | "existing" | "failed" | "skipped";
  customerId: string | null;
  leadId: string | null;
  activityId: string | null;
  /** 写进跟进的内容（基础统计，或补全已完成的 AI 摘要）。 */
  summary: string;
  error: string | null;
  /** 号码命中了几个客户；>1 = 歧义未写入。 */
  ambiguousWith: number;
  /** true = 基础跟进已写入、AI 总结在后台补全中（两段式的第一段完成）。 */
  pending: boolean;
  /** 兼容旧字段：语义并入 pending（基础内容不算「未整理」，它有统计价值）。恒 false。 */
  uncurated: boolean;
}

export interface FollowupSyncDispatchResult {
  /** 本轮基础写入使用的引擎标识；后台补全由 CLI（优先）或 CRM 配置模型接手。 */
  engine: "cli" | "ai" | "none";
  /** 后台补全将使用的模型（CLI 档即 CLI_SUMMARY_MODEL）。 */
  model: string;
  /** 整轮级失败原因（只有基础写入失败这类硬故障），插件据此把整轮标 partial。 */
  failures: string[];
  /** 语义并入 pending：恒 0，保留字段兼容插件旧展示。 */
  uncurated: number;
  curationReason: string;
  notificationSent: boolean;
  /** 本轮进入后台补全队列的会话数。 */
  refineQueued: number;
  outcomes: FollowupSyncOutcome[];
}

export interface FollowupSyncDeps {
  /** 「我的」客户列表（与 GET /api/customers scope=mine 同口径，由 server.ts 注入 ownedCustomersFor）。 */
  customersOf: (user: SessionUser) => Array<{ id: string; whatsapp?: string; whatsappPhone?: string }>;
  /** 该用户启用的 AI 模型配置（server.ts 注入 getAiConfig(user)），null = 没配。后台补全的降级档。 */
  aiConfig: (user: SessionUser) => AiModelConfig | null;
  /** 线索创建（server.ts 注入 createLeadFromSource 的包装，保持幂等语义）。 */
  createLead: (user: SessionUser, input: Record<string, unknown>) => { lead: { id: string }; duplicate: boolean };
  /** 本机 CLI 调用（默认 cli-ai.ts::runCliSummary；回测注入假实现，可直接回字符串）。 */
  cliRun?: (prompt: string) => Promise<string | { text: string }>;
  /** CRM 配置模型调用（回测注入点）。 */
  aiCall?: typeof callAiModel;
  /** 后台补全调度（默认内存队列异步跑；回测传同步执行器以便断言终态）。 */
  enqueueRefine?: (task: RefineTask) => void;
  clock?: () => Date;
}

/** 一条后台补全任务：基础跟进已写入，等 AI 摘要回来改写同一条记录。 */
export interface RefineTask {
  user: SessionUser;
  runDate: string;
  conversation: FollowupSyncConversationInput;
  /** 改写目标：customer → customerActivities[recordId]；lead → leads[recordId].inquiryContent。 */
  kind: "customer" | "lead";
  recordId: string;
  config: AiModelConfig | null;
}

interface Refinement {
  summary: string;
  /** "cli" | "ai"：哪个引擎出了这份摘要；失败保留基础内容时不改写。 */
  engine: "cli" | "ai";
  model: string;
}

function recordOfPromptError(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

/** 解析模型/CLI 返回的 JSON 摘要；worthRecording=false 或空摘要返回 null（保留基础内容）。 */
function parseRefinement(raw: string): Refinement | null {
  const parsed = summarySchema.parse(extractJsonObject(raw));
  const summary = sanitizeSummary(parsed.summary);
  if (parsed.worthRecording === false || !summary) return null;
  return { summary, engine: "ai", model: "" };
}

/**
 * 后台补全的单次尝试：**本机 CLI 优先**，失败退 CRM 配置的 AI 模型。
 * 两个引擎吃同一份提示词（buildSummaryPrompt 的 JSON 约定）。
 * 返回 null = 引擎判断无需补全（保留基础内容）；抛错 = 两个引擎都没出摘要。
 */
async function refineOnce(task: RefineTask, deps: FollowupSyncDeps): Promise<Refinement | null> {
  const prompt = buildSummaryPrompt({
    contactName: task.conversation.contactName,
    contactPhone: task.conversation.contactPhone,
    day: task.runDate,
    messages: task.conversation.messages
  });
  let cliFailure: unknown = null;
  try {
    const output = await (deps.cliRun ?? runCliSummary)(prompt);
    const parsed = parseRefinement(typeof output === "string" ? output : output.text);
    return parsed ? { ...parsed, engine: "cli", model: CLI_SUMMARY_MODEL } : null;
  } catch (error) {
    cliFailure = error;
  }
  const aiReady = Boolean(task.config?.enabled && task.config.apiKey && task.config.baseUrl && task.config.model);
  if (!aiReady || !task.config) {
    throw cliFailure instanceof Error ? cliFailure : new Error(String(cliFailure));
  }
  const raw = await (deps.aiCall ?? callAiModel)(task.config, prompt, 12_000, undefined, SUMMARY_TIMEOUT_MS);
  const parsed = parseRefinement(raw);
  return parsed ? { ...parsed, engine: "ai", model: task.config.model } : null;
}

/** 同一条基础跟进只允许一个补全在跑（重跑同步会复用 priorActivityId）。 */
const inFlightRefines = new Set<string>();

/**
 * 执行一条补全任务并**改写原记录**（跟进 content / 线索 inquiryContent）。
 * 失败只落日志：基础内容已经可用，绝不让后台故障倒灌同步结果。
 * 导出供回测同步驱动（生产路径走 defaultEnqueueRefine）。
 */
export async function executeRefineTask(task: RefineTask, deps: FollowupSyncDeps): Promise<void> {
  if (inFlightRefines.has(task.recordId)) return;
  inFlightRefines.add(task.recordId);
  try {
    const refinement = await refineOnce(task, deps);
    if (!refinement) {
      console.log(`[followup-refine] ${task.recordId} 引擎判断无需补全，保留基础内容`);
      return;
    }
    const store = getStore();
    const content = buildActivityContent(task.runDate, refinement.summary);
    if (task.kind === "customer") {
      const activity = store.customerActivities.find((item) => item.id === task.recordId);
      if (!activity) return;
      activity.content = content;
      activity.updatedAt = new Date().toISOString();
      activity.editedBy = task.user.id;
    } else {
      const lead = store.leads.find((item) => item.id === task.recordId);
      if (!lead) return;
      lead.inquiryContent = content;
    }
    await store.persist().catch((error) => console.error("whatsapp followup refine persist failed:", error));
    console.log(`[followup-refine] ${task.recordId} 补全完成（${refinement.engine} ${refinement.model}，${refinement.summary.length} 字）`);
  } catch (error) {
    // 保留基础内容：跟进历史里已有统计信息，AI 失败只是「没有更漂亮的总结」，不是数据事故。
    console.error(`[followup-refine] ${task.recordId} 补全失败，保留基础内容：`, recordOfPromptError(error));
  } finally {
    inFlightRefines.delete(task.recordId);
  }
}

/**
 * 默认的补全调度：内存队列，逐条串行（CLI 单次 ~10s，一批 5 个会话一分钟内跑完）。
 * 队列在进程内存里——进程重启丢掉的是「补全」，不是「跟进」：基础内容已经落库。
 */
const refineQueue: RefineTask[] = [];
let refineDraining = false;

function defaultEnqueueRefine(task: RefineTask, deps: FollowupSyncDeps): void {
  refineQueue.push(task);
  if (refineDraining) return;
  refineDraining = true;
  setImmediate(() => {
    void (async () => {
      try {
        while (refineQueue.length) {
          const next = refineQueue.shift();
          if (!next) break;
          await executeRefineTask(next, deps);
        }
      } finally {
        refineDraining = false;
      }
    })();
  });
}

function emptyOutcome(conversation: FollowupSyncConversationInput): FollowupSyncOutcome {
  return {
    conversationId: conversation.conversationId,
    contactName: conversation.contactName,
    contactPhone: conversation.contactPhone,
    messageCount: conversation.messages.length,
    kind: "skipped",
    status: "skipped",
    customerId: null,
    leadId: null,
    activityId: null,
    summary: "",
    error: null,
    ambiguousWith: 0,
    pending: false,
    uncurated: false
  };
}

function writeActivity(
  user: SessionUser,
  customerId: string,
  runDate: string,
  summary: string,
  priorActivityId: string | undefined
): { ok: boolean; activityId: string | null; error: string | null } {
  const store = getStore();
  const customer = store.customers.find((item) => item.id === customerId);
  if (!customer) return { ok: false, activityId: null, error: "客户不存在" };
  const content = buildActivityContent(runDate, summary);
  if (priorActivityId) {
    const activity = store.customerActivities.find(
      (item) => item.id === priorActivityId && item.customerId === customer.id
    );
    if (activity) {
      activity.content = content;
      activity.updatedAt = new Date().toISOString();
      activity.editedBy = user.id;
      return { ok: true, activityId: activity.id, error: null };
    }
    // 记录可能已被人工撤销：退回新建，而不是把这一天的内容丢掉。
  }
  const activity = {
    id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    customerId: customer.id,
    type: "whatsapp" as const,
    content,
    operatorId: user.id,
    nextReminder: "",
    createdAt: new Date().toISOString()
  };
  store.customerActivities.unshift(activity);
  return { ok: true, activityId: activity.id, error: null };
}

/**
 * 未匹配到客户的号码 → 线索。幂等交给 `createLeadFromSource`（按 owner+channel+externalId）。
 * `externalId` 不带日期 —— 线索是「这个人是谁」，一个号码只该有一条。
 */
function leadInput(conversation: FollowupSyncConversationInput, runDate: string, summary: string): Record<string, unknown> {
  const phone = normalizePhone(conversation.contactPhone);
  return {
    company: conversation.contactName?.trim() || phone || "WhatsApp 未知联系人",
    contact: conversation.contactName?.trim() || "",
    phone: phone || conversation.contactPhone,
    source: FOLLOWUP_LEAD_SOURCE,
    sourceType: "inbound",
    sourceChannel: FOLLOWUP_LEAD_CHANNEL,
    externalId: leadExternalId(conversation.contactPhone),
    inquiryContent: `${followupMarker(runDate)} ${summary}`.slice(0, 20_000),
    occurredAt: new Date(`${runDate}T00:00:00.000Z`).toISOString(),
    remark: `WhatsApp 自动同步生成，来源号码 ${phone || conversation.contactPhone}`
  };
}

/** 站内信（与 POST /api/internal-messages/system 同库同幂等键规则，直写省一次 HTTP）。 */
function notify(
  user: SessionUser,
  payload: FollowupSyncPayload,
  result: { outcomes: FollowupSyncOutcome[]; refineQueued: number; curationReason: string },
  clock: () => Date
): boolean {
  const store = getStore();
  const idempotencyKey = `whatsapp-followup-sync:${payload.runDate}`;
  if (store.internalMessages.some((item) => item.recipientId === user.id && item.idempotencyKey === idempotencyKey)) {
    return true;
  }
  const written = result.outcomes.filter((outcome) => outcome.status === "written" || outcome.status === "existing");
  const customers = written.filter((outcome) => outcome.kind === "customer");
  const newLeads = written.filter((outcome) => outcome.kind === "lead" && outcome.status === "written");
  const warnings = result.outcomes.filter((outcome) => outcome.ambiguousWith > 1 || outcome.status === "failed");
  const pendingLines = result.outcomes.filter((outcome) => outcome.pending).slice(0, 20)
    .map((outcome) => ` · ${outcome.contactName || "（无联系人名）"}（${outcome.contactPhone || "号码未知"}） ${outcome.messageCount} 条消息`);

  const content = [
    `同步时间：${payload.runDate}（${payload.timezone}）`,
    `扫描会话 ${result.outcomes.length} 个，共 ${result.outcomes.reduce((total, outcome) => total + outcome.messageCount, 0)} 条消息`,
    "",
    `已写入客户跟进（${customers.length}）`,
    ...(customers.slice(0, 20).map((outcome) => ` · ${outcome.contactName || "（无联系人名）"}（${outcome.contactPhone || "号码未知"}） ${outcome.messageCount} 条消息\n   ${outcome.summary}`)),
    "",
    `新建线索（${newLeads.length}）—— CRM 里没有对应客户，请认领或补充资料`,
    ...(newLeads.slice(0, 20).map((outcome) => ` · ${outcome.contactPhone || "号码未知"}（联系人 "${outcome.contactName || "无"}"） ${outcome.messageCount} 条消息\n   ${outcome.summary}`)),
    ...(result.refineQueued
      ? ["", `AI 进展总结后台补全中（${result.refineQueued}）—— ${result.curationReason}，完成后自动更新对应跟进/线索`, ...pendingLines]
      : []),
    ...(warnings.length
      ? ["", `需要注意（${warnings.length}）`, ...warnings.slice(0, 20).map((outcome) => outcome.ambiguousWith > 1
        ? ` · ${outcome.contactPhone} 同时匹配到 ${outcome.ambiguousWith} 个客户，已跳过未写入，请先合并 CRM 里的重复客户`
        : ` · ${outcome.contactName || outcome.contactPhone}：${outcome.error}`)]
      : [])
  ].join("\n").slice(0, MAX_NOTIFICATION_CHARS);

  const subject = result.refineQueued
    ? `WhatsApp 同步：${customers.length} 个客户已更新跟进（AI 总结补全中），${newLeads.length} 个新线索待认领`
    : `WhatsApp 同步：${customers.length} 个客户已更新跟进，${newLeads.length} 个新线索待认领`;

  const now = clock().toISOString();
  const message = {
    id: `msg_${randomUUID()}`,
    threadId: `communication_${randomUUID()}`,
    senderId: user.id,
    recipientId: user.id,
    teamId: user.teamId,
    type: "system" as const,
    subject: subject.slice(0, 180),
    content,
    relatedType: "message" as const,
    relatedId: "",
    idempotencyKey,
    readAt: "",
    createdAt: now,
    updatedAt: now
  };
  store.internalMessages.unshift(message);
  return true;
}

/**
 * 跑一批同步。**永不因为单个会话失败而整轮失败**；调用方（插件）负责 runs/items 记账。
 * 本函数只做零延迟的基础写入，AI 摘要交给后台补全队列——这是 2026-10-15 用户拍板的
 * 「先接进来（即时可见），CLI 总结后再补全」两段式体验。
 */
export async function runWhatsappFollowupSync(
  user: SessionUser,
  payload: FollowupSyncPayload,
  deps: FollowupSyncDeps
): Promise<FollowupSyncDispatchResult> {
  const clock = deps.clock ?? (() => new Date());
  const store = getStore();
  const customersByPhone = new Map<string, Array<{ id: string }>>();
  for (const customer of deps.customersOf(user)) {
    for (const raw of [customer.whatsappPhone, customer.whatsapp]) {
      const key = normalizePhone(raw);
      if (!key) continue;
      const bucket = customersByPhone.get(key) ?? [];
      if (!bucket.some((item) => item.id === customer.id)) bucket.push(customer);
      customersByPhone.set(key, bucket);
    }
  }

  const config = deps.aiConfig(user);
  const outcomes: FollowupSyncOutcome[] = [];
  const failures: string[] = [];
  let refineQueued = 0;

  for (const conversation of payload.conversations.slice(0, MAX_CONVERSATIONS_PER_BATCH)) {
    const outcome = emptyOutcome(conversation);
    try {
      const matched = customersByPhone.get(normalizePhone(conversation.contactPhone)) ?? [];
      if (matched.length > 1) {
        // 多命中是数据质量问题：暴露它而不是猜一个。
        outcome.ambiguousWith = matched.length;
        outcome.kind = "skipped";
        outcome.status = "skipped";
        outcome.error = `CRM 里有 ${matched.length} 个客户使用了这个号码，请先合并重复客户`;
      } else if (matched.length === 1) {
        // 第一段：零延迟基础写入（统计内容，不含原文、不调模型）。
        const basic = basicFollowupSummary(conversation);
        const written = writeActivity(user, matched[0].id, payload.runDate, basic, conversation.priorActivityId);
        outcome.kind = "customer";
        outcome.customerId = matched[0].id;
        outcome.activityId = written.activityId;
        outcome.status = written.ok ? "written" : "failed";
        outcome.summary = basic;
        if (!written.ok) outcome.error = written.error;
        // 第二段：有业务内容才进后台补全（寒暄的轻互动模板已是终态，没有编造空间）。
        if (written.ok && hasRecordableContent(conversation.messages) && written.activityId) {
          const task: RefineTask = {
            user, runDate: payload.runDate, conversation,
            kind: "customer", recordId: written.activityId, config
          };
          (deps.enqueueRefine ?? ((t: RefineTask) => defaultEnqueueRefine(t, deps)))(task);
          refineQueued += 1;
          outcome.pending = true;
        }
      } else {
        const basic = basicFollowupSummary(conversation);
        const ingested = deps.createLead(user, leadInput(conversation, payload.runDate, basic));
        outcome.kind = "lead";
        outcome.leadId = ingested.lead?.id ?? null;
        outcome.status = ingested.duplicate ? "existing" : "written";
        outcome.summary = basic;
        if (ingested.lead?.id && hasRecordableContent(conversation.messages)) {
          const task: RefineTask = {
            user, runDate: payload.runDate, conversation,
            kind: "lead", recordId: ingested.lead.id, config
          };
          (deps.enqueueRefine ?? ((t: RefineTask) => defaultEnqueueRefine(t, deps)))(task);
          refineQueued += 1;
          outcome.pending = true;
        }
      }
    } catch (error) {
      outcome.status = "failed";
      outcome.error = error instanceof Error ? error.message : "处理失败";
    }
    if (outcome.status === "failed" && outcome.error) {
      failures.push(`${conversation.contactName || conversation.contactPhone}：${outcome.error}`);
    }
    outcomes.push(outcome);
  }

  void store.persist().catch((error) => console.error("whatsapp followup sync persist failed:", error));
  const curationReason = refineQueued
    ? "AI 进展总结后台补全中（本机 CLI 优先，失败退 CRM 配置模型）"
    : "";
  const notificationSent = outcomes.length
    ? notify(user, payload, { outcomes, refineQueued, curationReason }, clock)
    : false;
  return {
    engine: refineQueued ? "cli" : "none",
    model: refineQueued ? CLI_SUMMARY_MODEL : "",
    failures,
    uncurated: 0,
    curationReason,
    notificationSent,
    refineQueued,
    outcomes
  };
}
