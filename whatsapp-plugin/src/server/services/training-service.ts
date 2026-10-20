import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ChannelAccount,
  ChatMessage,
  Conversation,
  TrainingExportFormat,
  TrainingExportPreview,
  TrainingExportRecord,
  TrainingProfile,
  TrainingStyleSample
} from "../../shared/types.js";
import { Repository } from "../db/repository.js";
import { DomainError } from "../errors.js";
import { sanitizeCliEffort, sanitizeCliModel, type CliEngine } from "./cli-engine.js";
import { extractJsonObject } from "./json-extract.js";
import { TranslationService, detectLanguage } from "./translation.js";

/** 单次训练最多读取的会话数，避免一次点击扫全库。 */
const MAX_TRAINING_CONVERSATIONS = 200;
/** 风格样本上限：够模型学会语感，又不会把提示词撑爆。 */
const MAX_STYLE_EXAMPLES = 40;
const MAX_EXAMPLE_CHARS = 600;
const AI_PROMPT_VERSION = "reply-training-v1";
/** CLI 提炼一次档案的时限。档案提炼比单条摘要重（样本最多 40 组），给足 3 分钟。 */
const REFINE_TIMEOUT_MS = 180_000;

const DEFAULT_GUARDRAILS = [
  "不承诺价格、折扣、交期或库存，除非训练样本或 CRM 数据里有明确依据",
  "不编造公司资质、认证、证书、客户名单或成功案例",
  "不发送合同、付款账户、银行信息或任何敏感财务信息",
  "客户要求转人工、投诉、退款或涉及法律问题时，立即停止自动回复并提醒人工介入",
  "回复保持与训练档案一致的语言和语气，一次不超过 2 条短消息"
];

const PLACEHOLDER_PATTERN = /^\[[^\]]{1,20}\]$/u;
const MEDIA_TYPE_LABELS: Record<string, string> = {
  image: "[图片]",
  video: "[视频]",
  audio: "[语音]",
  file: "[文件]",
  system: "[系统消息]"
};

const aiStyleSchema = z.object({
  summary: z.string().trim().min(1).max(1_200),
  tone: z.string().trim().min(1).max(80),
  guidelines: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  signaturePhrases: z.array(z.string().trim().min(1).max(120)).max(12),
  guardrails: z.array(z.string().trim().min(1).max(300)).max(12)
});

/**
 * 浏览器扩展「归档并学习 → 推送到 CRM」的入参（见 docs/TRAINING-UPLOAD-DESIGN.md）。
 *
 * 上限刻意与扩展侧 trainer.js 的产出对齐：档案样本 ≤200 组（扩展 MAX_EXAMPLES 量级）、
 * 单条 ≤2000 字符（扩展截断在 600，这里放宽是为了不拦合法长样本）。
 * `stats`/`source` 是展示信息，全部可选——服务端只消费样本与风格字段。
 */
export const trainingImportSchema = z.object({
  name: z.string().trim().min(1).max(120),
  tone: z.string().trim().max(80).optional(),
  summary: z.string().trim().max(1_200).optional(),
  guidelines: z.array(z.string().trim().min(1).max(300)).max(12).optional(),
  signaturePhrases: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  guardrails: z.array(z.string().trim().min(1).max(300)).max(12).optional(),
  languages: z.array(z.string().trim().min(1).max(16)).max(8).optional(),
  examples: z
    .array(
      z.object({
        inbound: z.string().trim().min(1).max(2_000),
        reply: z.string().trim().min(1).max(2_000),
        occurredAt: z.string().trim().max(40).optional(),
        conversationId: z.string().trim().max(120).optional(),
        score: z.number().min(0).max(1).optional()
      })
    )
    .max(200),
  stats: z
    .object({
      conversations: z.number().int().min(0).max(100_000).optional(),
      messages: z.number().int().min(0).max(1_000_000).optional(),
      exchanges: z.number().int().min(0).max(100_000).optional(),
      samples: z.number().int().min(0).max(100_000).optional()
    })
    .optional(),
  source: z
    .object({
      from: z.string().trim().max(40).nullable().optional(),
      to: z.string().trim().max(40).nullable().optional()
    })
    .optional()
});

export type TrainingImportInput = z.infer<typeof trainingImportSchema>;

export interface TrainingExportInput {
  accountId?: string;
  conversationIds?: string[];
  from?: string;
  to?: string;
  format?: TrainingExportFormat;
}

export interface TrainingTrainInput extends TrainingExportInput {
  name: string;
  useAi?: boolean;
  providerId?: string;
}

interface Exchange {
  inbound: string;
  reply: string;
  conversationId: string;
  occurredAt: string;
  score: number;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * 媒体消息在库里只有占位正文，训练时要还原成可读的占位符而不是丢掉上下文。
 * **幂等**：导出预览已经处理过一遍的消息再进来，不得把媒体前缀叠成「[图片] [图片] xxx」
 * （`train()` 现在直接复用 preview 的消息，这条是防双写的闸）。
 */
function readableBody(message: Pick<ChatMessage, "body" | "messageType">): string {
  const body = cleanText(message.body);
  if (message.messageType !== "text") {
    const label = MEDIA_TYPE_LABELS[message.messageType] ?? `[${message.messageType}]`;
    if (!body || PLACEHOLDER_PATTERN.test(body)) return label;
    return body.startsWith(`${label} `) ? body : `${label} ${body}`;
  }
  return body;
}

function isTrainable(message: Pick<ChatMessage, "messageType" | "body">): boolean {
  if (message.messageType === "system") return false;
  const body = cleanText(message.body);
  if (!body) return false;
  if (PLACEHOLDER_PATTERN.test(body)) return false;
  return true;
}

function toTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function normalizeDateBoundary(value: string | undefined, endOfDay: boolean): number | null {
  if (!value) return null;
  const raw = value.trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(raw)
    ? new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`).getTime()
    : new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** 还原 WhatsApp 导出文本格式，便于人工阅读或喂给第三方工具。 */
function renderWhatsAppText(record: TrainingExportRecord): string {
  const lines = [`# ${record.contactName} (${record.contactPhone})`, `# 会话 ${record.conversationId}`, ""];
  for (const message of record.messages) {
    const stamp = new Date(message.occurredAt);
    const date = `${String(stamp.getUTCDate()).padStart(2, "0")}/${String(stamp.getUTCMonth() + 1).padStart(2, "0")}/${stamp.getUTCFullYear()}`;
    const time = `${String(stamp.getUTCHours()).padStart(2, "0")}:${String(stamp.getUTCMinutes()).padStart(2, "0")}`;
    lines.push(`[${date}, ${time}] ${message.direction === "inbound" ? record.contactName : "我方"}: ${message.body}`);
  }
  return lines.join("\n");
}

export function renderTrainingExport(preview: TrainingExportPreview): string {
  if (preview.format === "json") {
    return JSON.stringify({ generatedAt: new Date().toISOString(), records: preview.records }, null, 2);
  }
  if (preview.format === "txt") {
    return preview.records.map(renderWhatsAppText).join("\n\n");
  }
  return preview.records
    .map((record) => JSON.stringify({
      conversationId: record.conversationId,
      accountId: record.accountId,
      accountName: record.accountName,
      contactName: record.contactName,
      contactPhone: record.contactPhone,
      messageCount: record.messageCount,
      messages: record.messages.map((message) => ({
        role: message.direction === "inbound" ? "customer" : "agent",
        at: message.occurredAt,
        type: message.messageType,
        content: message.body
      }))
    }))
    .join("\n");
}

/**
 * 把连续消息还原成「客户问 → 我方答」的问答对。
 * 连续多条我方消息会被合并成一次回复，贴近真实对话的节奏。
 *
 * 入参只要求真正用到的四个字段：既吃 `ChatMessage`，也吃导出预览里的
 * `TrainingExportMessage` —— `train()` 复用 preview 已查好的消息，不用再查一遍库。
 */
type TrainableMessage = Pick<ChatMessage, "body" | "direction" | "messageType" | "occurredAt">;

function buildExchanges(conversationId: string, messages: ReadonlyArray<TrainableMessage>): Exchange[] {
  const exchanges: Exchange[] = [];
  let pendingInbound: string[] = [];
  let pendingInboundAt = "";
  let openExchange: Exchange | null = null;

  for (const message of messages) {
    if (message.direction === "inbound") {
      if (!isTrainable(message)) continue;
      if (openExchange) {
        exchanges.push(openExchange);
        openExchange = null;
      }
      const body = readableBody(message);
      pendingInbound.push(body);
      if (!pendingInboundAt) pendingInboundAt = message.occurredAt;
      continue;
    }
    if (!isTrainable(message)) continue;
    const reply = readableBody(message);
    if (!pendingInbound.length) {
      if (openExchange) openExchange.reply = `${openExchange.reply}\n${reply}`.trim();
      continue;
    }
    openExchange = {
      conversationId,
      inbound: pendingInbound.join("\n"),
      reply,
      occurredAt: pendingInboundAt || message.occurredAt,
      score: 0
    };
    pendingInbound = [];
    pendingInboundAt = "";
  }
  if (openExchange) exchanges.push(openExchange);

  for (const exchange of exchanges) {
    // 太短的对答学不到东西，太长的多半是报价单/合同原文，两者都降权。
    const replyLength = exchange.reply.length;
    const lengthScore = replyLength < 12 ? -30 : replyLength <= 420 ? 30 : 6;
    const asksQuestion = /[?？]/u.test(exchange.reply) ? 8 : 0;
    const concrete = /\d/u.test(exchange.reply) ? 6 : 0;
    const hasUrl = /https?:\/\//iu.test(exchange.reply) ? -4 : 0;
    const inboundRich = exchange.inbound.length >= 6 ? 6 : -6;
    const multiline = exchange.reply.split("\n").length <= 3 ? 4 : -4;
    exchange.score = lengthScore + asksQuestion + concrete + hasUrl + inboundRich + multiline;
  }
  return exchanges;
}

interface StyleStats {
  tone: string;
  guidelines: string[];
  signaturePhrases: string[];
  languages: string[];
  averageLength: number;
  emojiRate: number;
}

function analyzeStyle(outbound: string[], inbound: string[]): StyleStats {
  const languageCounts = new Map<string, number>();
  for (const text of [...inbound, ...outbound]) {
    const language = detectLanguage(text);
    if (!language || language === "unknown") continue;
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const languages = [...languageCounts.entries()].sort((a, b) => b[1] - a[1]).map(([language]) => language).slice(0, 4);

  const nonEmpty = outbound.filter((text) => text.length > 0);
  const averageLength = nonEmpty.length
    ? Math.round(nonEmpty.reduce((total, text) => total + text.length, 0) / nonEmpty.length)
    : 0;
  const emojiCount = nonEmpty.filter((text) => /\p{Extended_Pictographic}/u.test(text)).length;
  const emojiRate = nonEmpty.length ? emojiCount / nonEmpty.length : 0;
  const greetingCount = nonEmpty.filter((text) => /^(hi|hello|hey|dear|greetings|good (morning|afternoon|evening)|你好|您好|亲爱的)/iu.test(text)).length;
  const closingCount = nonEmpty.filter((text) => /(best regards|kind regards|regards|sincerely|thanks|thank you|此致|祝好|谢谢|感谢)/iu.test(text)).length;
  const questionCount = nonEmpty.filter((text) => /[?？]/u.test(text)).length;

  const tone = (() => {
    if (averageLength <= 60 && emojiRate >= 0.15) return "简短热情，带少量表情";
    if (averageLength <= 60) return "简短直接";
    if (emojiRate >= 0.15) return "友好详细，带少量表情";
    if (averageLength >= 220) return "正式详尽，偏商务书面";
    return "专业友好，以信息为主";
  })();

  const phrases = new Map<string, number>();
  for (const text of nonEmpty.slice(0, 200)) {
    const opening = cleanText(text).slice(0, 48).replace(/[，。,.!！:：]/gu, " ").trim();
    const tokens = opening.split(" ").filter(Boolean).slice(0, 5).join(" ");
    if (tokens.length < 6) continue;
    phrases.set(tokens, (phrases.get(tokens) ?? 0) + 1);
  }
  const signaturePhrases = [...phrases.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([phrase]) => phrase);

  const guidelines = [
    `回复长度参考训练样本，平均约 ${averageLength || 40} 字，避免长篇大论`,
    greetingCount > nonEmpty.length * 0.3 ? "开头保留固定的问候语习惯" : "直接进入正题，不额外寒暄",
    closingCount > nonEmpty.length * 0.2 ? "结尾保留固定的收尾与署名习惯" : "结尾简短，不重复客套",
    questionCount > nonEmpty.length * 0.3 ? "每条回复以一个明确的下一步问题收尾" : "给出明确结论后再补充必要信息",
    languages.length ? `客户主要使用 ${languages.join(" / ")}，沿用同一语言回复` : "按客户来信语言回复"
  ];
  if (signaturePhrases.length) {
    guidelines.push(`优先复用训练样本中的高频表达，例如「${signaturePhrases[0]}」`);
  }

  return { tone, guidelines, signaturePhrases, languages, averageLength, emojiRate };
}

function unwrapJson(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return fenced?.[1] ?? trimmed;
}

/** 档案提炼的输入。CLI 与 AI 两条通道共用同一份，不允许各自拼提示词。 */
export interface RefinePromptPayload {
  accountId: string | null;
  accountName: string | null;
  style: StyleStats;
  examples: TrainingStyleSample[];
  stats: { conversations: number; messages: number; exchanges: number };
}

/**
 * 出境脱敏：真实样本会原样进提示词，而 AI Provider 通道是真·外呼（CLI 是本机无所谓，
 * 但提示词必须两通道逐字同源 —— 所以**统一都在这里洗**，不按通道分叉）。
 * 学语气不需要知道具体是 5000 件还是 8000 美元：长数字/价格/电话/邮箱/链接换成占位符，
 * 结构和语感原样保留。
 */
function scrubSample(value: string): string {
  return value
    .replace(/https?:\/\/\S+/giu, "[链接]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gu, "[邮箱]")
    .replace(/\+?\d[\d\s-]{6,}\d/gu, "[号码]")
    .replace(/\d+(?:\.\d+)?\s*%/gu, "[百分比]")
    .replace(/\d{3,}/gu, "[数字]");
}

/**
 * 档案提炼提示词的唯一来源（CLI 与 AI 逐字同源，只差喂法 —— 与 followup-sync 的
 * `buildSummaryPromptParts` 同一模式）。测试可以直接 import 做两条通道的 parity 断言。
 */
export function buildRefinePromptParts(payload: RefinePromptPayload): { system: string; user: string } {
  const system = [
    "You build a reusable reply-style profile for a B2B export sales team from their own WhatsApp history.",
    "Return one valid JSON object only, written in Chinese.",
    "Never invent facts about the company, its products, certifications or prices.",
    `Follow this schema exactly: {"summary":string,"tone":string,"guidelines":string[],"signaturePhrases":string[],"guardrails":string[]}.`,
    "guidelines must be actionable writing rules (length, structure, language, follow-up question style).",
    "signaturePhrases must be short verbatim phrases that actually appear in the samples.",
    "guardrails must state what the assistant must never do.",
    `Profile version: ${AI_PROMPT_VERSION}.`
  ].join(" ");
  const user = JSON.stringify({
    account: { id: payload.accountId, name: payload.accountName },
    statistics: payload.stats,
    observedStyle: {
      tone: payload.style.tone,
      averageReplyLength: payload.style.averageLength,
      emojiRate: Number(payload.style.emojiRate.toFixed(2)),
      languages: payload.style.languages
    },
    sampleExchanges: payload.examples.slice(0, 20).map((example) => ({
      ...example,
      inbound: scrubSample(example.inbound),
      reply: scrubSample(example.reply)
    }))
  });
  return { system, user };
}

export class TrainingService {
  constructor(
    private readonly repository: Repository,
    private readonly translation?: TranslationService,
    /** 本机 WorkBuddy CLI。给定时档案提炼优先走 CLI 托管，其次才是配置的 AI 模型。 */
    private readonly cli?: CliEngine
  ) {}

  private async selectConversations(ownerUserId: string, input: TrainingExportInput): Promise<{
    conversations: Conversation[];
    accountNames: Map<string, string>;
    skipped: number;
  }> {
    if (input.accountId && !(await this.repository.getAccount(input.accountId, ownerUserId))) {
      throw new DomainError("ACCOUNT_NOT_FOUND", 404, "账号不存在或不属于当前用户");
    }
    const all = await this.repository.listConversations(input.accountId, ownerUserId);
    const requested = input.conversationIds?.length ? new Set(input.conversationIds) : null;
    const candidates = (requested ? all.filter((conversation) => requested.has(conversation.id)) : all)
      .slice(0, MAX_TRAINING_CONVERSATIONS);
    if (requested) {
      const found = new Set(candidates.map((conversation) => conversation.id));
      const missing = [...requested].filter((id) => !found.has(id));
      if (missing.length === requested.size) {
        throw new DomainError("CONVERSATION_NOT_FOUND", 404, "选择的会话不存在或不属于当前用户");
      }
    }
    const accounts: ChannelAccount[] = await this.repository.listAccounts(ownerUserId);
    const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
    return { conversations: candidates, accountNames, skipped: Math.max(0, all.length - candidates.length) };
  }

  private filterMessages(messages: ChatMessage[], from: number | null, to: number | null): ChatMessage[] {
    return messages.filter((message) => {
      const at = toTimestamp(message.occurredAt);
      if (!Number.isFinite(at)) return false;
      if (from !== null && at < from) return false;
      if (to !== null && at > to) return false;
      return true;
    });
  }

  async previewExport(ownerUserId: string, input: TrainingExportInput): Promise<TrainingExportPreview> {
    const format: TrainingExportFormat = input.format ?? "jsonl";
    const from = normalizeDateBoundary(input.from, false);
    const to = normalizeDateBoundary(input.to, true);
    if (from !== null && to !== null && from > to) {
      throw new DomainError("TRAINING_RANGE_INVALID", 400, "开始时间不能晚于结束时间");
    }
    const { conversations, accountNames, skipped } = await this.selectConversations(ownerUserId, input);

    const records: TrainingExportRecord[] = [];
    let messageCount = 0;
    let exchangeCount = 0;
    let characters = 0;
    let skippedConversations = skipped;

    for (const conversation of conversations) {
      const messages = this.filterMessages(await this.repository.listMessages(conversation.id, ownerUserId), from, to);
      if (!messages.length) {
        skippedConversations += 1;
        continue;
      }
      const exported = messages.map((message) => ({
        occurredAt: message.occurredAt,
        direction: message.direction,
        body: readableBody(message),
        messageType: message.messageType,
        sourceLanguage: message.sourceLanguage
      }));
      const inboundCount = exported.filter((message) => message.direction === "inbound").length;
      const outboundCount = exported.length - inboundCount;
      messageCount += exported.length;
      characters += exported.reduce((total, message) => total + message.body.length, 0);
      exchangeCount += buildExchanges(conversation.id, messages).length;
      records.push({
        conversationId: conversation.id,
        accountId: conversation.accountId,
        accountName: accountNames.get(conversation.accountId) ?? "",
        contactName: conversation.contactName,
        contactPhone: conversation.contactPhone,
        messageCount: exported.length,
        inboundCount,
        outboundCount,
        firstMessageAt: exported[0]?.occurredAt ?? null,
        lastMessageAt: exported.at(-1)?.occurredAt ?? null,
        messages: exported
      });
    }

    if (!records.length) {
      throw new DomainError("TRAINING_NO_DATA", 422, "所选范围内没有可用于训练的聊天记录");
    }

    const stamp = new Date();
    const suffix = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, "0")}${String(stamp.getDate()).padStart(2, "0")}-${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}`;
    const extension = format === "txt" ? "txt" : format === "json" ? "json" : "jsonl";
    return {
      format,
      conversationCount: records.length,
      messageCount,
      exchangeCount,
      characters,
      fileName: `goodjob-whatsapp-训练数据-${suffix}.${extension}`,
      records,
      skippedConversations
    };
  }

  async renderExport(ownerUserId: string, input: TrainingExportInput): Promise<{ fileName: string; content: string }> {
    const preview = await this.previewExport(ownerUserId, input);
    return { fileName: preview.fileName, content: renderTrainingExport(preview) };
  }

  /**
   * 面向浏览器的导出结果：统计 + 少量样例 + 完整文件内容。
   * 由前端拼成 Blob 下载，避免依赖 CRM 反向代理的文件流。
   */
  async exportForClient(ownerUserId: string, input: TrainingExportInput): Promise<{
    format: TrainingExportFormat;
    fileName: string;
    conversationCount: number;
    messageCount: number;
    exchangeCount: number;
    characters: number;
    skippedConversations: number;
    sample: Array<{ conversationId: string; contactName: string; at: string; role: "customer" | "agent"; body: string }>;
    content: string;
  }> {
    const preview = await this.previewExport(ownerUserId, input);
    const sample = preview.records
      .flatMap((record) => record.messages.slice(-8).map((message) => ({
        conversationId: record.conversationId,
        contactName: record.contactName,
        at: message.occurredAt,
        role: (message.direction === "inbound" ? "customer" : "agent") as "customer" | "agent",
        body: message.body
      })))
      .slice(0, 12);
    return {
      format: preview.format,
      fileName: preview.fileName,
      conversationCount: preview.conversationCount,
      messageCount: preview.messageCount,
      exchangeCount: preview.exchangeCount,
      characters: preview.characters,
      skippedConversations: preview.skippedConversations,
      sample,
      content: renderTrainingExport(preview)
    };
  }

  /**
   * 训练一份回复风格档案。
   *
   * 返回 `reused=true` 表示**输入指纹与同名档案完全一致**：直接复用上次结果，不再跑
   * 模型（点两次「开始训练」不该花两次 CLI/模型的钱）。要强制重训就换个名字或改范围。
   */
  async train(ownerUserId: string, input: TrainingTrainInput): Promise<{ profile: TrainingProfile; reused: boolean }> {
    const name = input.name.trim();
    if (name.length < 1) throw new DomainError("TRAINING_NAME_REQUIRED", 400, "请给训练档案起一个名字");

    const preview = await this.previewExport(ownerUserId, { ...input, format: "json" });

    // 输入指纹：范围 + 数据内容 + 提示词版本。数据一个字没变就别再花钱跑模型 ——
    // 与 web-import 的内容指纹幂等同一思路；想强制重训，换个名字或改时间范围即可。
    const inputFingerprint = createHash("sha256").update(JSON.stringify({
      promptVersion: AI_PROMPT_VERSION,
      useAi: Boolean(input.useAi),
      providerId: input.useAi ? input.providerId ?? null : null,
      scope: { accountId: input.accountId ?? null, conversationIds: input.conversationIds ?? null, from: input.from ?? null, to: input.to ?? null },
      data: preview.records.map((record) => [record.conversationId, record.messages.map((message) => [message.occurredAt, message.direction, message.body])])
    })).digest("hex");
    const existingProfiles = await this.repository.listTrainingProfiles(ownerUserId);
    const reusedProfile = existingProfiles.find((profile) =>
      profile.name === name && profile.engine !== "web-import" && profile.inputFingerprint === inputFingerprint
    );
    if (reusedProfile) return { profile: reusedProfile, reused: true };

    const exchanges: Exchange[] = [];
    let outbound: string[] = [];
    let inbound: string[] = [];
    const languages = new Set<string>();
    let messageCount = 0;

    // preview.records 里的消息已经是「按范围过滤 + readableBody 处理」后的成品，
    // 直接复用，不再逐会话重查 listMessages（以前这里把 DB 读取量整整翻了一倍）。
    for (const record of preview.records) {
      exchanges.push(...buildExchanges(record.conversationId, record.messages));
      for (const message of record.messages) {
        if (!isTrainable(message)) continue;
        const body = readableBody(message);
        messageCount += 1;
        if (message.direction === "inbound") inbound.push(body);
        else outbound.push(body);
        const language = message.sourceLanguage || detectLanguage(body);
        if (language && language !== "unknown") languages.add(language);
      }
    }

    const style = analyzeStyle(outbound, inbound);
    const ranked = exchanges.slice().sort((a, b) => b.score - a.score || a.occurredAt.localeCompare(b.occurredAt));
    const examples: TrainingStyleSample[] = ranked.slice(0, MAX_STYLE_EXAMPLES).map((exchange) => ({
      conversationId: exchange.conversationId,
      occurredAt: exchange.occurredAt,
      inbound: exchange.inbound.slice(0, MAX_EXAMPLE_CHARS),
      reply: exchange.reply.slice(0, MAX_EXAMPLE_CHARS)
    }));

    let engine: TrainingProfile["engine"] = "rules";
    let model: string | null = null;
    let summary = this.buildRuleSummary(preview, style, examples.length);
    let tone = style.tone;
    let guidelines = style.guidelines;
    let signaturePhrases = style.signaturePhrases;
    let guardrails = DEFAULT_GUARDRAILS;

    const accountIds = new Set(preview.records.map((record) => record.accountId));
    const accountId = input.accountId ?? (accountIds.size === 1 ? [...accountIds][0] : null);

    /**
     * 提炼链与跟进同步同一口径（curation-engine.ts 在跟进侧的对应物）：
     * **CLI 托管 → 配置的 AI 模型 → 规则提炼**。
     * `rules` 不是失败态 —— 它是永远可用的确定性兜底（只做统计，不调模型），
     * 所以这里没有「占位档案」一说；但 CLI / AI 调用失败要如实写进 `error`，不许静默。
     */
    const refinePayload = {
      accountId,
      accountName: accountId ? preview.records.find((record) => record.accountId === accountId)?.accountName ?? null : null,
      style,
      examples,
      stats: {
        conversations: preview.conversationCount,
        messages: messageCount,
        exchanges: exchanges.length
      }
    };
    const warnings: string[] = [];
    const applyRefined = (
      refined: { summary: string; tone: string; guidelines: string[]; signaturePhrases: string[]; guardrails: string[]; model: string },
      refinedEngine: TrainingProfile["engine"]
    ): void => {
      summary = refined.summary;
      tone = refined.tone;
      guidelines = refined.guidelines;
      signaturePhrases = refined.signaturePhrases.length ? refined.signaturePhrases : signaturePhrases;
      guardrails = refined.guardrails.length ? refined.guardrails : DEFAULT_GUARDRAILS;
      model = refined.model;
      engine = refinedEngine;
    };

    let refined = false;
    if (this.cli && (await this.cli.status()).available) {
      try {
        applyRefined(await this.refineWithCli(refinePayload), "cli");
        refined = true;
      } catch (error) {
        warnings.push(`CLI 提炼失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
    }
    if (!refined && input.useAi && input.providerId && this.translation) {
      try {
        applyRefined(await this.refineWithAi(ownerUserId, input.providerId, refinePayload), "ai");
        refined = true;
      } catch (error) {
        warnings.push(`AI 提炼失败，已使用规则结果：${error instanceof Error ? error.message : "未知错误"}`);
      }
    }
    const warning = warnings.length ? warnings.join("；") : null;

    const timestamps = preview.records.flatMap((record) => [record.firstMessageAt, record.lastMessageAt]).filter((value): value is string => Boolean(value));
    const now = new Date().toISOString();
    const profile = await this.repository.saveTrainingProfile({
      id: `trn_${hash(`${ownerUserId}:${name}:${now}`)}`,
      ownerUserId,
      accountId,
      accountName: accountId ? preview.records.find((record) => record.accountId === accountId)?.accountName ?? null : null,
      name,
      status: examples.length && outbound.length ? "ready" : "empty",
      engine,
      model,
      sampleCount: examples.length,
      exchangeCount: exchanges.length,
      conversationCount: preview.conversationCount,
      messageCount,
      languages: [...new Set([...style.languages, ...languages])].slice(0, 6),
      tone,
      summary,
      guidelines,
      signaturePhrases,
      guardrails,
      examples,
      sourceFrom: timestamps.length ? timestamps.slice().sort()[0] : null,
      sourceTo: timestamps.length ? timestamps.slice().sort().at(-1)! : null,
      error: warning,
      trainedAt: now,
      createdAt: now,
      updatedAt: now,
      hitCount: 0,
      lastHitAt: null,
      inputFingerprint
    });
    return { profile, reused: false };
  }

  /** 内容指纹：同一条语料反复推送不该反复建档/刷新时间戳。 */
  private importFingerprint(input: TrainingImportInput): string {
    return hash(
      [
        input.name,
        ...input.examples.map((example) => `${example.inbound}\u0001${example.reply}`),
        ...(input.guardrails ?? [])
      ].join("\u0000")
    );
  }

  /**
   * 浏览器扩展推送训练档案（`POST /api/v1/training/profiles/import`）。
   *
   * upsert 语义，见 docs/TRAINING-UPLOAD-DESIGN.md：
   * - 同 owner + `engine="web-import"` + 同名档案已存在且**内容指纹一致** → 直接返回，不写库；
   * - 存在但内容变了 → 原位覆盖（id 不变，trained_at 刷新）；
   * - 不存在 → 新建。
   * 问答样本与护栏进训练库这一步由路由在保存后调 `trainingLibrary.importFromProfile` 完成，
   * 那边自带 fingerprint 幂等 —— 整条链路「推多少次都只落一份」。
   */
  async importFromClient(ownerUserId: string, input: TrainingImportInput): Promise<{ profile: TrainingProfile; updated: boolean }> {
    const name = input.name.trim();
    const fingerprint = this.importFingerprint(input);

    const existing = (await this.repository.listTrainingProfiles(ownerUserId)).find(
      (profile) => profile.engine === "web-import" && profile.name === name
    );
    if (existing) {
      const existingFingerprint = hash([
        existing.name,
        ...existing.examples.map((example) => `${example.inbound}\u0001${example.reply}`),
        ...existing.guardrails
      ].join("\u0000"));
      if (existingFingerprint === fingerprint) return { profile: existing, updated: false };
    }

    const now = new Date().toISOString();
    const examples: TrainingStyleSample[] = input.examples.map((example) => ({
      conversationId: example.conversationId ?? "",
      occurredAt: example.occurredAt ?? "",
      inbound: example.inbound,
      reply: example.reply,
      score: example.score ?? 0.5
    }));
    const profile = await this.repository.saveTrainingProfile({
      id: existing?.id ?? `trn_${hash(`${ownerUserId}:web-import:${name}:${now}`)}`,
      ownerUserId,
      accountId: existing?.accountId ?? null,
      accountName: existing?.accountName ?? null,
      name,
      status: examples.length ? "ready" : "empty",
      engine: "web-import",
      model: null,
      sampleCount: examples.length,
      exchangeCount: input.stats?.exchanges ?? examples.length,
      conversationCount: input.stats?.conversations ?? 0,
      messageCount: input.stats?.messages ?? 0,
      languages: (input.languages ?? []).slice(0, 6),
      tone: input.tone ?? "",
      summary: input.summary ?? "",
      guidelines: input.guidelines ?? [],
      signaturePhrases: input.signaturePhrases ?? [],
      guardrails: input.guardrails ?? [],
      examples,
      sourceFrom: input.source?.from ?? null,
      sourceTo: input.source?.to ?? null,
      error: null,
      // web-import 覆盖已有档案时必须原样带回 hit 计数：这是自动聊的使用回流，重存不能清零。
      hitCount: existing?.hitCount ?? 0,
      lastHitAt: existing?.lastHitAt ?? null,
      trainedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    return { profile, updated: true };
  }

  private buildRuleSummary(preview: TrainingExportPreview, style: StyleStats, exampleCount: number): string {
    return [
      `基于 ${preview.conversationCount} 个会话、${preview.messageCount} 条消息、${preview.exchangeCount} 组问答提炼。`,
      `语气判定：${style.tone}；我方回复平均 ${style.averageLength} 字。`,
      exampleCount
        ? `已选出 ${exampleCount} 组高质量问答作为话术样板。`
        : "暂时没有足够完整的一问一答，建议先补充我方已回复的聊天记录。"
    ].join("");
  }

  /** CLI 通道。提示词与 AI 通道**逐字同源**（同一份 system + user，只差喂法）。 */
  private async refineWithCli(
    payload: RefinePromptPayload
  ): Promise<{ summary: string; tone: string; guidelines: string[]; signaturePhrases: string[]; guardrails: string[]; model: string }> {
    const parts = buildRefinePromptParts(payload);
    const run = await this.cli!.run({
      prompt: `${parts.system}\n\n${parts.user}`,
      model: sanitizeCliModel(""),
      effort: sanitizeCliEffort(""),
      maxTurns: 2,
      timeoutMs: REFINE_TIMEOUT_MS
    });
    const parsed = aiStyleSchema.parse(JSON.parse(unwrapJson(extractJsonObject(run.text))));
    return { ...parsed, model: run.model };
  }

  /** AI Provider 通道。 */
  private async refineWithAi(
    ownerUserId: string,
    providerId: string,
    payload: RefinePromptPayload
  ): Promise<{ summary: string; tone: string; guidelines: string[]; signaturePhrases: string[]; guardrails: string[]; model: string }> {
    const parts = buildRefinePromptParts(payload);
    const completion = await this.translation!.completeStructuredJson(providerId, ownerUserId, parts.system, parts.user);
    const parsed = aiStyleSchema.parse(JSON.parse(unwrapJson(completion.content)));
    return { ...parsed, model: completion.model };
  }

  async list(ownerUserId: string): Promise<TrainingProfile[]> {
    return this.repository.listTrainingProfiles(ownerUserId);
  }

  async get(id: string, ownerUserId: string): Promise<TrainingProfile> {
    const profile = await this.repository.getTrainingProfile(id, ownerUserId);
    if (!profile) throw new DomainError("TRAINING_PROFILE_NOT_FOUND", 404, "训练档案不存在");
    return profile;
  }

  async remove(id: string, ownerUserId: string): Promise<void> {
    await this.repository.clearAutoChatProfileReference(id);
    const deleted = await this.repository.deleteTrainingProfile(id, ownerUserId);
    if (!deleted) throw new DomainError("TRAINING_PROFILE_NOT_FOUND", 404, "训练档案不存在");
  }
}

export { DEFAULT_GUARDRAILS, buildExchanges, analyzeStyle };
