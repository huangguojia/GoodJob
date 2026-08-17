import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChatMessage, ConversationAnalysis, ConversationFollowUp, ConversationTrait, ConversationTraitFeedback } from "../../shared/types.js";
import { Repository } from "../db/repository.js";
import { RealtimeHub } from "../realtime.js";
import { TranslationService } from "./translation.js";

type Intent = "quote" | "sample" | "quantity" | "delivery" | "payment" | "complaint";
const AI_PROMPT_VERSION = "customer-intelligence-v1";

const intentRules: Array<{ key: Intent; label: string; pattern: RegExp; title: string; reason: string; priority: ConversationFollowUp["priority"] }> = [
  { key: "quote", label: "价格敏感", pattern: /\b(quote|quotation|price|cost|报价|价格|多少钱|报价单)\b/iu, title: "准备并发送报价", reason: "客户在对话中询问价格或报价", priority: "high" },
  { key: "sample", label: "样品意向", pattern: /\b(sample|samples|catalog|catalogue|样品|目录|试样)\b/iu, title: "确认样品或目录需求", reason: "客户表现出样品、目录或试用意向", priority: "high" },
  { key: "quantity", label: "有明确采购量", pattern: /\b\d[\d,.]*\s*(units?|pcs?|pieces?|sets?|箱|件|台|吨)\b/iu, title: "确认数量与规格", reason: "客户提到明确数量，需要核对规格和可供数量", priority: "high" },
  { key: "delivery", label: "关注交期", pattern: /\b(lead\s*time|delivery|ship(ping)?|交期|交货|发货|多久)\b/iu, title: "确认交期与物流方案", reason: "客户询问交期、发货或运输安排", priority: "medium" },
  { key: "payment", label: "关注交易条款", pattern: /\b(payment|terms?|FOB|CIF|EXW|付款|条款|账期)\b/iu, title: "确认付款与贸易条款", reason: "客户涉及付款方式或贸易条款", priority: "medium" },
  { key: "complaint", label: "存在风险信号", pattern: /\b(complaint|problem|late|refund|issue|投诉|问题|延迟|退款|不满意)\b/iu, title: "优先处理客户风险", reason: "对话包含投诉、延误或不满意信号", priority: "high" }
];

function clean(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function buildSummary(messages: ChatMessage[], intents: Intent[]): string {
  const inbound = messages.filter((message) => message.direction === "inbound");
  if (!inbound.length) return "当前没有客户入站消息，暂时无法形成客户判断。";
  const latest = clean(inbound.at(-1)?.body ?? "").slice(0, 120);
  const labels = intents.map((intent) => intentRules.find((rule) => rule.key === intent)?.label).filter(Boolean);
  return labels.length
    ? `客户最近消息：“${latest}”。已识别：${labels.join("、")}。结论基于 ${inbound.length} 条客户消息。`
    : `客户最近消息：“${latest}”。暂未识别明确采购意向，建议通过问题确认需求。`;
}

type AnalysisResult = {
  summary: string;
  keyPoints: string[];
  traits: ConversationTrait[];
  buyingIntent: ConversationAnalysis["buyingIntent"];
  riskLevel: ConversationAnalysis["riskLevel"];
  nextAction: string;
  followups: Array<{
    sourceKey: string;
    title: string;
    reason: string;
    priority: ConversationFollowUp["priority"];
    dueAt: string;
    evidenceMessageIds: string[];
  }>;
};

const aiAnalysisSchema = z.object({
  summary: z.string().trim().min(1).max(800),
  keyPoints: z.array(z.string().trim().min(1).max(300)).max(12),
  traits: z.array(z.object({
    key: z.string().trim().regex(/^[a-z0-9_-]{1,60}$/i),
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(300),
    confidence: z.number().min(0).max(1),
    evidenceMessageIds: z.array(z.string().min(1)).max(30)
  })).max(16),
  buyingIntent: z.enum(["high", "medium", "low"]),
  riskLevel: z.enum(["high", "medium", "low"]),
  nextAction: z.string().trim().min(1).max(300),
  followups: z.array(z.object({
    intentKey: z.string().trim().regex(/^[a-z0-9_-]{1,60}$/i),
    title: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(300),
    priority: z.enum(["high", "medium", "normal"]),
    dueInHours: z.number().int().min(1).max(24 * 90),
    evidenceMessageIds: z.array(z.string().min(1)).max(30)
  })).max(12)
});

function analyzeMessages(messages: ChatMessage[]): AnalysisResult {
  const inbound = messages.filter((message) => message.direction === "inbound");
  const intents = intentRules
    .filter((rule) => inbound.some((message) => rule.pattern.test(message.body)))
    .map((rule) => rule.key);
  const evidence = (rule: { pattern: RegExp }): string[] => inbound.filter((message) => rule.pattern.test(message.body)).map((message) => message.id);
  const traits: ConversationTrait[] = intents.map((intent) => {
    const rule = intentRules.find((item) => item.key === intent)!;
    return { key: intent, label: rule.label, value: "已从对话识别", confidence: intent === "complaint" ? 0.93 : 0.84, evidenceMessageIds: evidence(rule) };
  });
  const languages = new Map<string, number>();
  for (const message of inbound) {
    const language = message.sourceLanguage || "unknown";
    languages.set(language, (languages.get(language) ?? 0) + 1);
  }
  const language = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (language && language !== "unknown") {
    traits.push({ key: "language", label: "主要沟通语言", value: language, confidence: 0.9, evidenceMessageIds: inbound.map((message) => message.id) });
  }
  const complaint = intents.includes("complaint");
  const strongIntent = intents.some((intent) => ["quote", "sample", "quantity"].includes(intent));
  const buyingIntent = strongIntent ? "high" : intents.length ? "medium" : "low";
  const riskLevel = complaint ? "high" : intents.includes("delivery") || intents.includes("payment") ? "medium" : "low";
  const nextAction = complaint
    ? "在 24 小时内确认问题、责任人和补救方案"
    : strongIntent
      ? "根据客户明确需求补齐规格、数量和报价，并确认下一步"
      : "发送一个澄清问题，确认客户产品、数量和时间需求";
  const dueBase = Date.now() + (complaint ? 4 : strongIntent ? 24 : 48) * 60 * 60 * 1_000;
  const followups = (intents.length ? intents : ["qualification" as Intent]).map((intent) => {
    const rule = intentRules.find((item) => item.key === intent);
    const title = rule?.title ?? "澄清客户采购需求";
    const reason = rule?.reason ?? "当前没有足够证据判断客户需求，需要主动提问确认";
    return {
      sourceKey: `${intent}:${hash(inbound.map((message) => message.id).join(","))}`,
      title,
      reason,
      priority: rule?.priority ?? "medium",
      dueAt: new Date(dueBase).toISOString(),
      evidenceMessageIds: rule ? evidence(rule) : inbound.slice(-3).map((message) => message.id)
    };
  });
  return {
    summary: buildSummary(messages, intents),
    keyPoints: intents.map((intent) => intentRules.find((rule) => rule.key === intent)?.reason ?? "").filter(Boolean),
    traits,
    buyingIntent,
    riskLevel,
    nextAction,
    followups
  };
}

function unwrapJson(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return fenced?.[1] ?? trimmed;
}

async function analyzeMessagesWithAi(messages: ChatMessage[], ownerUserId: string, providerId: string, translation: TranslationService): Promise<{ result: AnalysisResult; model: string }> {
  const source = messages.slice(-80);
  const validMessageIds = new Set(source.map((message) => message.id));
  const completion = await translation.completeStructuredJson(
    providerId,
    ownerUserId,
    `You analyze B2B sales conversations for a CRM. Return one valid JSON object only. Use Chinese for summary, labels, values, reasons and actions. Never invent facts. Every trait and follow-up must cite message IDs from the supplied data. Extract commercial intent, customer characteristics, objections, commitments, meeting arrangements and concrete next steps. Dates without a year should remain descriptive unless the message timestamp makes the date unambiguous. Follow this schema exactly: {"summary":string,"keyPoints":string[],"traits":[{"key":lowercase_ascii_key,"label":string,"value":string,"confidence":0_to_1,"evidenceMessageIds":string[]}],"buyingIntent":"high|medium|low","riskLevel":"high|medium|low","nextAction":string,"followups":[{"intentKey":lowercase_ascii_key,"title":string,"reason":string,"priority":"high|medium|normal","dueInHours":integer,"evidenceMessageIds":string[]}]}.`,
    JSON.stringify(source.map((message) => ({ id: message.id, direction: message.direction, occurredAt: message.occurredAt, body: message.body })))
  );
  const parsed = aiAnalysisSchema.parse(JSON.parse(unwrapJson(completion.content)));
  const evidenceIds = (ids: string[]) => [...new Set(ids.filter((id) => validMessageIds.has(id)))];
  const traits = parsed.traits.map((trait) => ({ ...trait, evidenceMessageIds: evidenceIds(trait.evidenceMessageIds) })).filter((trait) => trait.evidenceMessageIds.length > 0);
  const followups = parsed.followups.map((followup) => {
    const evidenceMessageIds = evidenceIds(followup.evidenceMessageIds);
    return {
      sourceKey: `${followup.intentKey}:${hash(`${followup.title}:${evidenceMessageIds.join(",")}`)}`,
      title: followup.title,
      reason: followup.reason,
      priority: followup.priority,
      dueAt: new Date(Date.now() + followup.dueInHours * 3_600_000).toISOString(),
      evidenceMessageIds
    };
  }).filter((followup) => followup.evidenceMessageIds.length > 0);
  return { result: { ...parsed, traits, followups }, model: completion.model };
}

function applyTraitFeedback(messages: ChatMessage[], result: AnalysisResult, feedback: ConversationTraitFeedback[]): AnalysisResult {
  const rejected = new Set(feedback.filter((item) => item.verdict === "rejected").map((item) => item.traitKey));
  const confirmed = new Map(feedback.filter((item) => item.verdict === "confirmed").map((item) => [item.traitKey, item]));
  const traits = result.traits
    .filter((trait) => !rejected.has(trait.key))
    .map((trait) => {
      const item = confirmed.get(trait.key);
      return item ? { ...trait, confidence: 0.98, value: item.correctionText || trait.value } : trait;
    });
  const activeIntents = traits.map((trait) => trait.key).filter((key): key is Intent => intentRules.some((rule) => rule.key === key));
  const complaint = activeIntents.includes("complaint");
  const strongIntent = activeIntents.some((intent) => ["quote", "sample", "quantity"].includes(intent));
  return {
    ...result,
    summary: buildSummary(messages, activeIntents),
    traits,
    keyPoints: activeIntents.map((intent) => intentRules.find((rule) => rule.key === intent)?.reason ?? "").filter(Boolean),
    buyingIntent: strongIntent ? "high" : activeIntents.length ? "medium" : "low",
    riskLevel: complaint ? "high" : activeIntents.includes("delivery") || activeIntents.includes("payment") ? "medium" : "low",
    nextAction: complaint ? "在 24 小时内确认问题、责任人和补救方案" : strongIntent ? "根据客户明确需求补齐规格、数量和报价，并确认下一步" : "发送一个澄清问题，确认客户产品、数量和时间需求",
    followups: result.followups.filter((followup) => !rejected.has(followup.sourceKey.split(":", 1)[0]))
  };
}

export class ConversationIntelligenceService {
  constructor(private readonly repository: Repository, private readonly realtime: RealtimeHub, private readonly translation?: TranslationService) {}

  async analyzeConversation(conversationId: string): Promise<{ analysis: ConversationAnalysis; followups: ConversationFollowUp[] }> {
    const conversation = await this.repository.getConversation(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    const messages = await this.repository.listMessages(conversationId);
    const account = await this.repository.getAccount(conversation.accountId);
    const ownerUserId = account?.ownerUserId ?? undefined;
    const settings = await this.repository.getAutomationSettings(ownerUserId);
    let rawResult = analyzeMessages(messages);
    let engine: ConversationAnalysis["engine"] = "rules";
    let model: string | null = null;
    let analysisWarning: string | null = null;
    if (settings.intelligenceMode === "ai" && settings.intelligenceProviderId && ownerUserId && this.translation) {
      try {
        const ai = await analyzeMessagesWithAi(messages, ownerUserId, settings.intelligenceProviderId, this.translation);
        rawResult = ai.result;
        engine = "ai";
        model = ai.model;
      } catch (error) {
        analysisWarning = `AI 深度分析失败，已使用规则结果：${error instanceof Error ? error.message : "未知错误"}`;
      }
    }
    const result = applyTraitFeedback(messages, rawResult, await this.repository.listConversationTraitFeedback(conversationId));
    const saved = await this.repository.saveConversationAnalysis({
      id: `cia_${hash(`${conversationId}:${messages.map((message) => message.id).join(",")}`)}`,
      conversationId,
      accountId: conversation.accountId,
      status: "ready",
      ...result,
      sourceMessageCount: messages.length,
      engine,
      model,
      promptVersion: engine === "ai" ? AI_PROMPT_VERSION : "rules-v1",
      error: analysisWarning
    });
    this.realtime.publish("conversation.analysis.completed", conversation.accountId, saved);
    return saved;
  }

  async getConversationIntelligence(conversationId: string, ownerUserId?: string) {
    return {
      analysis: await this.repository.getConversationAnalysis(conversationId, ownerUserId),
      followups: await this.repository.listConversationFollowups(conversationId, ownerUserId),
      feedback: await this.repository.listConversationTraitFeedback(conversationId, ownerUserId)
    };
  }
}
