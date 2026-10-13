import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AutoChatDraft,
  AutoChatDraftEngine,
  AutoChatDraftStatus,
  AutoChatEngine,
  AutoChatMode,
  AutoChatRunSummary,
  AutoChatSettings,
  ChatMessage,
  CliEngineStatus,
  TrainingLibraryMatchResult,
  TrainingProfile
} from "../../shared/types.js";
import { Repository } from "../db/repository.js";
import { DomainError } from "../errors.js";
import { ProviderManager } from "../providers/provider-manager.js";
import { RealtimeHub } from "../realtime.js";
import { CLI_MODEL_DEFAULT, CliEngine, AUTO_REPLY_SKILL, RESOURCE_SCOUT_SKILL, cliSkillDirective, sanitizeCliEffort, sanitizeCliModel } from "./cli-engine.js";
import type { CrmClient } from "./crm-client.js";
import { normalizePhone } from "./crm-client.js";
import { buildCrmContext, crmContextPayload, crmContextSystemLines, type CrmContext } from "./crm-context.js";
import { extractJsonObject } from "./json-extract.js";
import { TrainingLibraryService } from "./training-library-service.js";
import { TranslationService } from "./translation.js";
import { DEFAULT_GUARDRAILS } from "./training-service.js";
import { coverage, containsPhrase, expandTokens, tokenize } from "./text-match.js";

const DEFAULT_ESCALATE_KEYWORDS = [
  "投诉", "退款", "律师", "法务", "起诉", "假冒", "假货", "骗子",
  "complaint", "refund", "lawyer", "lawsuit", "legal", "fraud", "scam"
];

/** 只在最近这段时间内的未回复消息上工作，避免开启功能后突然翻旧账。 */
const CANDIDATE_WINDOW_HOURS = 48;
const MAX_DRAFTS_PER_RUN = 10;
const MAX_CONTEXT_MESSAGES = 12;
/**
 * 现场对话（扩展读实时 DOM 传上来的）可以给多一点：库里那 12 条是「落库过的那部分」，
 * 而现场对话是完整的，客户半小时前说过什么就在里面。上限仍然压着——聊天记录越长越贵，
 * 而且真正决定怎么回的是最后几条。
 */
const MAX_INLINE_CONTEXT_MESSAGES = 20;
/** 单条现场消息的截断长度：客户发来的可能是整份规格书，全量喂进去只会把提示词撑爆。 */
const MAX_INLINE_MESSAGE_CHARS = 2_000;

/**
 * 话术检索的最低门槛：至少要两个共同特征词。
 * 只重合一个词（例如两边都有 the / 的）不代表是同一个问法。
 */
const MIN_RULE_MATCHED_TOKENS = 2;
/**
 * 模板话术的置信度上限。刻意低于 1：模板是「历史原话复用」，
 * 把门槛设在 0.9 以上就等于关掉模板自动回复。
 */
const MAX_RULE_CONFIDENCE = 0.9;

/** 中文/日文/韩文没有词边界，必须按字切分，否则整句会变成一个 token。 */
const aiReplySchema = z.object({
  reply: z.string().trim().min(1).max(1_200),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().max(300).default(""),
  language: z.string().trim().max(32).default("")
});

export interface AutoChatSettingsInput {
  enabled: boolean;
  mode: AutoChatMode;
  engine?: AutoChatEngine;
  accountId?: string | null;
  profileId?: string | null;
  providerId?: string | null;
  cliModel?: string;
  cliEffort?: string;
  language?: string;
  tone?: string;
  dailyLimit?: number;
  minIntervalMinutes?: number;
  activeHoursStart?: number;
  activeHoursEnd?: number;
  timezone?: string;
  escalateKeywords?: string[];
  guardrails?: string[];
  confidenceThreshold?: number;
}

/** 现场对话里的一条消息（由浏览器扩展从 WhatsApp 页面上读出来，不落库）。 */
export interface ComposeMessage {
  direction: "inbound" | "outbound";
  body: string;
  occurredAt: string;
}

export interface ComposeInput {
  messages: ComposeMessage[];
  contact: { phone?: string; name?: string };
  accountId?: string | null;
  /** 覆盖项：现场生成允许临时换模型/引擎，不动库里的全局设置。 */
  engine?: AutoChatEngine;
  model?: string;
  effort?: string;
  language?: string;
  tone?: string;
}

export interface ComposeResult {
  action: "reply" | "skip";
  reply: string;
  confidence: number;
  reason: string;
  /** 模型**实际**用的语言（模型自报），不是要求它用的那个。 */
  language: string;
  /** 实际生效的通道，不是设置里选的那个。 */
  engine: AutoChatDraftEngine;
  model: string | null;
  blocked: boolean;
  evidence: ReplyEvidence | null;
}

interface Candidate {
  conversationId: string;
  accountId: string;
  accountName: string;
  contactName: string;
  contactPhone: string;
  inboundMessageId: string;
  inboundBody: string;
  /**
   * 检索用的合并来文：客户常**连发几句**（先问 MOQ 再问交期），而最后一条往往只是
   * 「and the lead time?」这种半句——只拿它去查训练库，前面的正题永远打不中。
   * 取最近（去重后）≤3 条来信按原顺序合并，仅供库/档案检索；`inboundBody` 保持
   * 「最后一条」语义不动（升级关键词、媒体占位判断仍看它）。单消息路径不设此字段。
   */
  retrievalBody?: string;
  inboundAt: string;
  /**
   * 现场对话：有它就不去库里读会话历史。
   *
   * 存在的理由是「扩展看到的是**实时 DOM**，而库里只有导入过的那部分」——
   * 用户当前正在聊的这个会话，插件往往一条消息都还没有。
   */
  transcript?: ComposeMessage[];
}

/**
 * 「这条回复用了哪些依据」的徽章枚举。
 *
 * 刻意做成扁平枚举，而不是让界面从下面三个对象里自己推断：界面要的是「有 / 没有」，
 * 让每个渲染点各写一遍 `crm.activities.length > 0` 这种判定，早晚有一处写错，
 * 然后就会出现「有 CRM 依据但界面上没显示」这种查不动的问题。
 */
export type ReplySource = "profile" | "library" | "crm_followup" | "crm_quote" | "knowledge" | "resource";

/**
 * 这条回复"依据来自哪"。刻意做成结构化字段而不是拼进 reason 的散文：
 * 界面上要能一眼看出「有 CRM 历史 / 命中了知识 / 用的是 CLI」，
 * 否则「智能回复」和瞎编在用户眼里没有区别。
 */
export interface ReplyEvidence {
  profile: { id: string; name: string; examples: number } | null;
  library: { qa: number; snippets: number; policies: number; forbidden: number } | null;
  crm: {
    matchedBy: CrmContext["matchedBy"];
    customer: string;
    followUps: number;
    quotes: number;
    knowledge: Array<{ title: string; module: string; score: number }>;
    errors: string[];
  } | null;
  /** 面板渲染成一排来源徽章。`resource` 由「回复 + 资料」那条链路补上（compose 本身不推资料）。 */
  sources: ReplySource[];
}

/** 一次生成的结果。engine 是**实际生效**的通道，不是设置里选的那个。 */
interface GeneratedReply {
  reply: string;
  confidence: number;
  reason: string;
  engine: AutoChatDraftEngine;
  model: string | null;
  blocked: boolean;
  /** 模型自报的语言（`aiReplySchema.language`）。回给扩展显示，不参与决策。 */
  language?: string;
  evidence?: ReplyEvidence;
}

export class AutoChatService {
  private readonly running = new Set<string>();
  constructor(
    private readonly repository: Repository,
    private readonly providers: ProviderManager,
    private readonly realtime: RealtimeHub,
    private readonly translation?: TranslationService,
    private readonly clock: () => Date = () => new Date(),
    /** 本机 WorkBuddy CLI 引擎。缺省只影响 engine=cli 这一条通道，其余照常工作。 */
    private readonly cli?: CliEngine,
    /** 训练库（专门的自动回复语料库）。缺省时退化成「只用训练档案样本」的老行为。 */
    private readonly library?: TrainingLibraryService,
    /**
     * CRM 只读通道。接上之后，提示词里才会有「这个客户的跟进/报价历史」与「知识检索命中」；
     * 不接或连不上时只是没有这块依据（`errors` 里如实记一笔），回复照常生成。
     */
    private readonly crm?: CrmClient
  ) {}

  /** 本机 CLI 能力（界面用）。探测结果自带缓存，失败会快速重探。 */
  async cliStatus(force = false): Promise<CliEngineStatus> {
    if (!this.cli) {
      return {
        available: false,
        binary: "",
        version: "",
        reason: "插件未接入本机 CLI 引擎",
        defaultModel: CLI_MODEL_DEFAULT,
        models: [],
        efforts: [],
        skillsDirs: "",
        skills: [],
        autoReplySkill: AUTO_REPLY_SKILL,
        resourceScoutSkill: RESOURCE_SCOUT_SKILL
      };
    }
    return this.cli.status(force);
  }

  /**
   * 读取「实际生效」的设置：库里存的空数组代表「用出厂默认」，必须在这里补齐。
   *
   * 所有决策点（展示、入站触发、手动运行）都必须走这个方法。曾经只有展示层补默认值，
   * 结果出厂自带的升级关键词和护栏在真正判断时全是空的——投诉关键词根本拦不住。
   */
  private async resolveSettings(ownerUserId: string, accountId?: string): Promise<AutoChatSettings> {
    const settings = await this.repository.getAutoChatSettings(ownerUserId, accountId);
    return {
      ...settings,
      guardrails: settings.guardrails.length ? settings.guardrails : DEFAULT_GUARDRAILS,
      escalateKeywords: settings.escalateKeywords.length ? settings.escalateKeywords : DEFAULT_ESCALATE_KEYWORDS
    };
  }

  async getSettings(ownerUserId: string, accountId?: string): Promise<AutoChatSettings> {
    return this.resolveSettings(ownerUserId, accountId);
  }

  async updateSettings(ownerUserId: string, input: AutoChatSettingsInput): Promise<AutoChatSettings> {
    const current = await this.repository.getAutoChatSettings(ownerUserId, input.accountId ?? undefined);
    if (input.profileId) {
      const profile = await this.repository.getTrainingProfile(input.profileId, ownerUserId);
      if (!profile) throw new DomainError("TRAINING_PROFILE_NOT_FOUND", 404, "训练档案不存在");
      if (profile.status !== "ready") {
        throw new DomainError("TRAINING_PROFILE_EMPTY", 409, "该训练档案还没有可用的话术样本，请重新训练");
      }
    }
    if (input.providerId && !(await this.repository.getAiProfile(input.providerId, ownerUserId))) {
      throw new DomainError("AI_PROVIDER_NOT_FOUND", 404, "AI Provider 不存在或已停用");
    }
    if (input.mode && input.mode !== "off" && !(input.profileId ?? current.profileId)) {
      throw new DomainError("TRAINING_PROFILE_REQUIRED", 409, "开启自动聊前需要先选择一份训练档案");
    }
    if (input.accountId !== undefined && input.accountId !== null && !(await this.repository.getAccount(input.accountId, ownerUserId))) {
      throw new DomainError("ACCOUNT_NOT_FOUND", 404, "账号不存在");
    }
    const nextEngine = input.engine ?? current.engine;
    const nextProviderId = input.providerId === undefined ? current.providerId : input.providerId;
    if (nextEngine === "ai" && !nextProviderId && input.enabled && input.mode !== "off") {
      throw new DomainError("AI_PROVIDER_REQUIRED", 409, "引擎选择「AI Provider」时必须先选一个 Provider");
    }
    // 只在「显式切到 CLI」时校验可用性：给用户即时的失败反馈，而不是存下去之后静默降级。
    // 不校验其它情形，否则 CLI 一掉线连改个每日上限都改不了。
    if (input.engine === "cli" && input.engine !== current.engine) {
      const status = await this.cliStatus();
      if (!status.available) {
        throw new DomainError("CLI_ENGINE_UNAVAILABLE", 409, `本机 CLI 当前不可用：${status.reason || "探测未通过"}`);
      }
    }
    // 模型/档位非法值回落到上一次的值；显式传空串才是「回到跟随 CLI 默认」。
    const nextCliModel = input.cliModel === undefined
      ? current.cliModel
      : input.cliModel.trim()
        ? sanitizeCliModel(input.cliModel) || current.cliModel
        : "";
    const nextCliEffort = input.cliEffort === undefined
      ? current.cliEffort
      : input.cliEffort.trim()
        ? sanitizeCliEffort(input.cliEffort) || current.cliEffort
        : "";
    return this.repository.saveAutoChatSettings({
      ...current,
      // 全局行与账号行是两条记录：把全局配置写入某个账号时必须换一个新的 id，
      // 否则新行会带着全局行的主键插入，直接撞主键。
      id: current.accountId === (input.accountId ?? null) ? current.id : randomUUID(),
      accountId: input.accountId === undefined ? current.accountId : input.accountId,
      enabled: input.enabled,
      mode: input.enabled ? input.mode : "off",
      engine: nextEngine,
      profileId: input.profileId === undefined ? current.profileId : input.profileId,
      providerId: nextProviderId,
      cliModel: nextCliModel,
      cliEffort: nextCliEffort,
      language: input.language ?? current.language,
      tone: input.tone ?? current.tone,
      dailyLimit: input.dailyLimit ?? current.dailyLimit,
      minIntervalMinutes: input.minIntervalMinutes ?? current.minIntervalMinutes,
      activeHoursStart: input.activeHoursStart ?? current.activeHoursStart,
      activeHoursEnd: input.activeHoursEnd ?? current.activeHoursEnd,
      timezone: input.timezone ?? current.timezone,
      escalateKeywords: input.escalateKeywords ?? current.escalateKeywords,
      guardrails: input.guardrails ?? current.guardrails,
      confidenceThreshold: input.confidenceThreshold ?? current.confidenceThreshold
    });
  }

  async listDrafts(ownerUserId: string, options: { statuses?: AutoChatDraftStatus[]; limit?: number } = {}): Promise<AutoChatDraft[]> {
    return this.repository.listAutoChatDrafts(ownerUserId, options);
  }

  /** 入站消息落库后调用：命中策略就生成草稿，auto 模式且置信度达标时直接发出。 */
  async handleInbound(message: ChatMessage): Promise<AutoChatDraft | null> {
    if (message.direction !== "inbound") return null;
    const conversation = await this.repository.getConversation(message.conversationId);
    const account = conversation ? await this.repository.getAccount(conversation.accountId) : null;
    const ownerUserId = account?.ownerUserId;
    if (!conversation || !account || !ownerUserId) return null;
    return this.processCandidate(ownerUserId, {
      conversationId: conversation.id,
      accountId: account.id,
      accountName: account.name,
      contactName: conversation.contactName,
      contactPhone: conversation.contactPhone,
      inboundMessageId: message.id,
      inboundBody: message.body,
      inboundAt: message.occurredAt
    }, { settings: await this.resolveSettings(ownerUserId, account.id), force: false });
  }

  /** 手动运行一轮：补跑最近窗口内「客户发了、我方还没回」的消息。 */
  async runNow(ownerUserId: string, options: { accountId?: string; quiet?: boolean } = {}): Promise<AutoChatRunSummary> {
    if (this.running.has(ownerUserId)) {
      if (options.quiet) return { scanned: 0, drafted: 0, sent: 0, skipped: 0, failed: 0, reasons: ["自动聊正在运行"] };
      throw new DomainError("AUTO_CHAT_BUSY", 409, "自动聊正在运行，请稍后再试");
    }
    this.running.add(ownerUserId);
    const summary: AutoChatRunSummary = { scanned: 0, drafted: 0, sent: 0, skipped: 0, failed: 0, reasons: [] };
    try {
      const settings = await this.resolveSettings(ownerUserId, options.accountId);
      if (!settings.enabled || settings.mode === "off") {
        summary.reasons.push("自动聊未启用");
        return summary;
      }
      const sinceIso = new Date(this.clock().getTime() - CANDIDATE_WINDOW_HOURS * 3_600_000).toISOString();
      const candidates = await this.repository.listAutoChatCandidates(ownerUserId, {
        accountId: options.accountId,
        sinceIso,
        limit: MAX_DRAFTS_PER_RUN
      });
      summary.scanned = candidates.length;
      for (const candidate of candidates) {
        const draft = await this.processCandidate(ownerUserId, candidate, { settings, force: true });
        if (!draft) {
          summary.skipped += 1;
          continue;
        }
        summary.reasons.push(`${candidate.contactName}：${draft.reason || draft.status}`);
        if (draft.status === "sent") summary.sent += 1;
        else if (draft.status === "pending") summary.drafted += 1;
        else if (draft.status === "failed") summary.failed += 1;
        else summary.skipped += 1;
      }
      // 记录在「实际生效的那一行」上：账号没有自己的设置时会回落到全局行。
      // 兜底扫描（quiet）只在真的有候选时才留痕，否则每分钟一条审计会把日志淹掉。
      if (!options.quiet || summary.scanned > 0) {
        await this.repository.touchAutoChatSettings(ownerUserId, settings.accountId ?? undefined);
      }
      if (!options.quiet) {
        await this.repository.audit("auto_chat.run", "auto_chat", ownerUserId, "success", { ...summary });
      }
      return summary;
    } finally {
      this.running.delete(ownerUserId);
    }
  }

  /**
   * 定时兜底扫描：入站钩子可能丢（进程重启、事件早于业务落库），所以每分钟补扫一次。
   *
   * 只扫「已开启且不是 off」的设置行；有候选才真正跑一轮，没有就安静返回。
   * 这是「自动回复」在没人点按钮时也能持续工作的保证。
   */
  async sweepOwner(ownerUserId: string): Promise<void> {
    if (this.running.has(ownerUserId)) return;
    const rows = await this.repository.listEnabledAutoChatSettings(ownerUserId);
    if (!rows.length) return;
    const sinceIso = new Date(this.clock().getTime() - CANDIDATE_WINDOW_HOURS * 3_600_000).toISOString();
    for (const row of rows) {
      const accountId = row.accountId ?? undefined;
      const effective = await this.resolveSettings(ownerUserId, accountId);
      if (!effective.enabled || effective.mode === "off" || !effective.profileId) continue;
      const candidates = await this.repository.listAutoChatCandidates(ownerUserId, { accountId, sinceIso, limit: 1 });
      if (!candidates.length) continue;
      await this.runNow(ownerUserId, { accountId, quiet: true });
    }
  }

  async sendDraft(ownerUserId: string, draftId: string, override?: { body?: string }): Promise<AutoChatDraft> {
    const draft = await this.repository.getAutoChatDraft(draftId, ownerUserId);
    if (!draft) throw new DomainError("AUTO_CHAT_DRAFT_NOT_FOUND", 404, "草稿不存在");
    if (draft.status === "sent") return draft;
    if (draft.status === "sending") throw new DomainError("AUTO_CHAT_DRAFT_BUSY", 409, "草稿正在发送中");
    const body = (override?.body ?? draft.body).trim();
    if (!body) throw new DomainError("AUTO_CHAT_DRAFT_EMPTY", 400, "草稿内容不能为空");
    const edited = override?.body !== undefined && override.body.trim() !== draft.body;
    const claimed = await this.repository.updateAutoChatDraft(draft.id, {
      body,
      edited: draft.edited || edited,
      status: "sending",
      error: null
    });
    if (!claimed) throw new DomainError("AUTO_CHAT_DRAFT_NOT_FOUND", 404, "草稿不存在");
    try {
      const message = await this.providers.sendMessage({
        accountId: draft.accountId,
        conversationId: draft.conversationId,
        clientMessageId: `autochat-${draft.id}`,
        body
      });
      const sent = await this.repository.updateAutoChatDraft(draft.id, {
        status: "sent",
        messageId: message.id,
        sentAt: this.clock().toISOString(),
        error: null
      });
      this.realtime.publish("auto.chat.draft.sent", draft.accountId, sent);
      await this.repository.audit("auto_chat.draft.sent", "auto_chat_draft", draft.id, "success", {
        conversationId: draft.conversationId
      });
      return sent ?? draft;
    } catch (error) {
      const message = error instanceof Error ? error.message : "发送失败";
      const failed = await this.repository.updateAutoChatDraft(draft.id, { status: "failed", error: message });
      this.realtime.publish("auto.chat.draft.failed", draft.accountId, failed);
      throw error;
    }
  }

  async dismissDraft(ownerUserId: string, draftId: string): Promise<AutoChatDraft> {
    const draft = await this.repository.getAutoChatDraft(draftId, ownerUserId);
    if (!draft) throw new DomainError("AUTO_CHAT_DRAFT_NOT_FOUND", 404, "草稿不存在");
    const updated = await this.repository.updateAutoChatDraft(draft.id, { status: "dismissed" });
    this.realtime.publish("auto.chat.draft.dismissed", draft.accountId, updated);
    return updated ?? draft;
  }

  /* ------------------------------------------------- 现场对话生成（浏览器扩展） */

  /**
   * 拿一段**现场对话**换一条草稿。
   *
   * 与 `runNow` 的区别只有一句话：**不落库、不认会话**。浏览器扩展看的是 WhatsApp 页面的
   * 实时 DOM，而库里只有导入过的那部分消息 —— 用户正在聊的这个会话，插件里往往一条都没有。
   * 所以入参是转写本身，出参是草稿与依据，中间不写任何业务表。
   *
   * 三件刻意不做的事：
   * - **不套日限额/频控**：那两道闸门管的是"自动发出去多少条"，而这里一条都不会自己发出去。
   * - **不套活跃时段**：用户点了就是要现在要，不是后台定时。
   * - **不自动发送**：无论全局配的是 `auto` 还是 `draft`，现场生成的都只回草稿给人看。
   */
  async compose(ownerUserId: string, input: ComposeInput): Promise<ComposeResult> {
    const messages = (input.messages ?? [])
      .map((message) => ({
        direction: message.direction === "outbound" ? ("outbound" as const) : ("inbound" as const),
        body: String(message.body ?? "").replace(/\s+$/u, "").slice(0, MAX_INLINE_MESSAGE_CHARS),
        occurredAt: String(message.occurredAt ?? "") || this.clock().toISOString()
      }))
      .filter((message) => message.body.trim())
      .slice(-MAX_INLINE_CONTEXT_MESSAGES);
    const skip = (reason: string, extra: Partial<ComposeResult> = {}): ComposeResult => ({
      action: "skip",
      reply: "",
      confidence: 0,
      reason,
      language: "",
      engine: "rules",
      model: null,
      blocked: false,
      evidence: null,
      ...extra
    });

    if (!messages.length) return skip("没有可用的对话内容（页面上没读到消息）");

    const settings = await this.resolveSettings(ownerUserId, input.accountId ?? undefined);
    const effective: AutoChatSettings = {
      ...settings,
      enabled: true,
      mode: "draft",
      ...(input.engine ? { engine: input.engine } : {}),
      // 非法模型名一律回落成"跟随 CLI 默认"，绝不把任意字符串透传给子进程（同 cli-engine 的约定）。
      ...(input.model !== undefined ? { cliModel: sanitizeCliModel(input.model) } : {}),
      ...(input.effort !== undefined ? { cliEffort: sanitizeCliEffort(input.effort) } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {})
    };

    const latestInbound = [...messages].reverse().find((message) => message.direction === "inbound");
    if (!latestInbound) return skip("这段对话里没有客户消息（全是自己发的），没什么可回的");
    if (/^\[[^\]]{1,20}\]$/u.test(latestInbound.body.trim())) return skip("客户最后一条是媒体占位，没有可回复的文字");

    // 检索合并文：最近 ≤3 条来信按序合并去重。客户连发几句是常态，
    // 只拿最后一条去查训练库，前面问过的正题（MOQ/价格）就永远打不中。
    const inboundBodies = messages
      .filter((message) => message.direction === "inbound")
      .map((message) => message.body.trim())
      .filter(Boolean);
    const retrievalBody = [...new Set(inboundBodies)].slice(-3).join("\n");

    const escalate = effective.escalateKeywords.find((keyword) =>
      latestInbound.body.toLowerCase().includes(keyword.toLowerCase())
    );
    if (escalate) return skip(`命中升级关键词「${escalate}」，已交给人工处理`);

    const profile = settings.profileId ? await this.repository.getTrainingProfile(settings.profileId, ownerUserId) : null;
    const candidate: Candidate = {
      // 这两个 id 只是给 `Candidate` 填形，不会被写进库，也不会被拿去查消息（有 transcript 就不查库）。
      conversationId: `compose:${ownerUserId}`,
      accountId: input.accountId ?? "",
      accountName: "",
      contactName: String(input.contact?.name ?? "").trim().slice(0, 180),
      contactPhone: normalizePhone(input.contact?.phone),
      inboundMessageId: `compose:${this.clock().toISOString()}`,
      inboundBody: latestInbound.body,
      retrievalBody,
      inboundAt: latestInbound.occurredAt,
      transcript: messages
    };

    const library = await this.loadLibrary(ownerUserId, candidate);
    if (library?.forbidden.length) {
      const scene = library.forbidden[0].entry;
      return skip(`训练库禁用场景「${scene.question}」命中，已转人工处理`, { blocked: true });
    }

    const engine = await this.resolveEngine(effective);
    let generated: GeneratedReply;
    if (engine === "cli") {
      try {
        generated = await this.generateWithCli(ownerUserId, candidate, effective, profile, library);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "未知错误";
        // 与后台通道同一条纪律：降级成话术库，但**标记 blocked** —— 引擎不可用时的模板命中，
        // 置信度是没有意义的，不能让人以为"这就是智能回复"。
        generated = {
          ...this.generateWithRules(ownerUserId, candidate, effective, profile, library),
          reason: `本机 CLI 生成失败已降级为话术库（${detail}）`,
          blocked: true
        };
      }
    } else if (engine === "ai") {
      try {
        generated = await this.generateWithAi(ownerUserId, candidate, effective, profile, effective.providerId!, library);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "未知错误";
        generated = {
          ...this.generateWithRules(ownerUserId, candidate, effective, profile, library),
          reason: `AI 生成失败已降级为话术库（${detail}）`,
          blocked: true
        };
      }
    } else {
      generated = this.generateWithRules(ownerUserId, candidate, effective, profile, library);
    }

    return {
      action: generated.reply ? "reply" : "skip",
      reply: generated.reply,
      confidence: generated.confidence,
      reason: generated.reason,
      language: generated.language ?? (effective.language === "auto" ? "" : effective.language),
      engine: generated.engine,
      model: generated.model,
      blocked: generated.blocked,
      evidence: generated.evidence ?? null
    };
  }

  // -------------------------------------------------------------------------

  private async processCandidate(
    ownerUserId: string,
    candidate: Candidate,
    context: { settings: AutoChatSettings; force: boolean }
  ): Promise<AutoChatDraft | null> {
    const { settings } = context;
    if (!settings.enabled || settings.mode === "off") return null;

    const existing = await this.repository.findAutoChatDraftByInbound(candidate.conversationId, candidate.inboundMessageId);
    // 已发出的、或正在发送的草稿不再重复处理；「已跳过 / 失败」允许在下一轮重试。
    if (existing && existing.status !== "failed" && existing.status !== "skipped") return null;

    const skip = async (reason: string): Promise<AutoChatDraft> => this.repository.createAutoChatDraft({
      ownerUserId,
      accountId: candidate.accountId,
      conversationId: candidate.conversationId,
      inboundMessageId: candidate.inboundMessageId,
      inboundBody: candidate.inboundBody,
      body: "",
      status: "skipped",
      mode: settings.mode,
      confidence: 0,
      reason,
      engine: "rules",
      model: null,
      profileId: settings.profileId,
      runDate: this.localDate(settings.timezone)
    });

    const inboundText = candidate.inboundBody.trim();
    if (!inboundText) return null;
    if (/^\[[^\]]{1,20}\]$/u.test(inboundText)) return null;

    const escalate = settings.escalateKeywords.find((keyword) => inboundText.toLowerCase().includes(keyword.toLowerCase()));
    if (escalate) return skip(`命中升级关键词「${escalate}」，已交给人工处理`);

    if (!this.withinActiveHours(settings)) {
      return skip(`不在活跃时段（${settings.activeHoursStart}:00-${settings.activeHoursEnd}:00 ${settings.timezone}）`);
    }
    if (settings.dailyLimit > 0) {
      const sentToday = await this.repository.countAutoChatSendsSince(ownerUserId, this.startOfLocalDay(settings.timezone));
      if (sentToday >= settings.dailyLimit) return skip(`已达今日自动发送上限 ${settings.dailyLimit} 条`);
    }
    if (settings.minIntervalMinutes > 0) {
      const lastSentAt = await this.repository.getLastAutoChatSentAt(ownerUserId);
      if (lastSentAt) {
        const elapsed = this.clock().getTime() - new Date(lastSentAt).getTime();
        if (elapsed < settings.minIntervalMinutes * 60_000) {
          return skip(`距上一条自动回复不足 ${settings.minIntervalMinutes} 分钟`);
        }
      }
    }

    const profile = settings.profileId ? await this.repository.getTrainingProfile(settings.profileId, ownerUserId) : null;
    if (!profile) return skip("尚未选择训练档案，无法生成回复");
    if (profile.status !== "ready") return skip("训练档案还没有可用话术样本，请先重新训练");

    const generated = await this.generateReply(ownerUserId, candidate, settings, profile);
    const threshold = settings.mode === "auto" ? settings.confidenceThreshold : 0;
    const shouldAutoSend = settings.mode === "auto" && generated.confidence >= threshold && !generated.blocked;
    const reason = generated.blocked
      ? generated.reason
      : shouldAutoSend
        ? generated.reason || "自动发送"
        : settings.mode === "auto"
          ? `${generated.reason}（置信度 ${generated.confidence.toFixed(2)} / 门槛 ${threshold.toFixed(2)}，未达门槛只留草稿）`
          : `${generated.reason}（置信度 ${generated.confidence.toFixed(2)}，draft 模式只生成草稿）`;

    const draft = await this.repository.createAutoChatDraft({
      ownerUserId,
      accountId: candidate.accountId,
      conversationId: candidate.conversationId,
      inboundMessageId: candidate.inboundMessageId,
      inboundBody: candidate.inboundBody,
      body: generated.reply,
      status: "pending",
      mode: settings.mode,
      confidence: generated.confidence,
      reason,
      engine: generated.engine,
      model: generated.model,
      profileId: profile.id,
      runDate: this.localDate(settings.timezone),
      error: generated.blocked ? generated.reason : null
    });
    this.realtime.publish("auto.chat.draft.created", candidate.accountId, draft);
    if (!shouldAutoSend) return draft;

    try {
      return await this.sendDraft(ownerUserId, draft.id);
    } catch {
      return this.repository.getAutoChatDraft(draft.id, ownerUserId);
    }
  }

  /**
   * 解析「这一轮到底用哪个引擎」。
   *
   * `auto` 的顺序刻意是「显式配的东西优先」：配了 AI Provider 就用它，否则本机 CLI 可用就用 CLI
   * （项目约定默认执行通道是 CLI），都不行才退到训练话术库。这样存量配置升级后不会突然变差，
   * 也不会因为没配 Provider 就永远不回复。
   */
  private async resolveEngine(settings: AutoChatSettings): Promise<AutoChatDraftEngine> {
    if (settings.engine === "rules") return "rules";
    if (settings.engine === "cli") return this.cli ? "cli" : "rules";
    if (settings.engine === "ai") return settings.providerId && this.translation ? "ai" : "rules";
    if (settings.providerId && this.translation) return "ai";
    if (this.cli && (await this.cli.status()).available) return "cli";
    return "rules";
  }

  private async generateReply(
    ownerUserId: string,
    candidate: Candidate,
    settings: AutoChatSettings,
    profile: TrainingProfile
  ): Promise<GeneratedReply> {
    const engine = await this.resolveEngine(settings);
    // 训练库只取一次，三条通道共用：查询一次、四处用（问答检索 / 口径 / 政策 / 禁用词）。
    const library = await this.loadLibrary(ownerUserId, candidate);
    // 命中计数：只用来让用户看出「哪几条建了从来没被用过」（界面与导出都会显示）。
    // 刻意 fire-and-forget——计数少一次不影响任何功能，绝不允许它拖慢回复或把异常带进主流程。
    if (this.library && library?.hits.length) {
      const hits = library.hits.map((hit) => hit.entry.id);
      void this.library.recordHits(hits).catch(() => undefined);
    }
    // 客户这句话踩中禁用场景 → 不生成、不自动发，直接留一条空白草稿让人工接手。
    // 这与「话术库无相近问法」是同一种收口方式：确定性拦下，而不是让模型自由发挥。
    if (library?.forbidden.length) {
      const scene = library.forbidden[0].entry;
      return {
        reply: "",
        confidence: 0,
        reason: `训练库禁用场景「${scene.question}」命中，已转人工处理`,
        engine: "rules",
        model: null,
        blocked: true
      };
    }
    if (engine === "cli") {
      try {
        return await this.generateWithCli(ownerUserId, candidate, settings, profile, library);
      } catch (error) {
        // 与 AI 失败同一条纪律：降级成话术库草稿，但**不允许自动发送**——
        // 引擎不可用时的模板命中，置信度是没有意义的。
        const fallback = this.generateWithRules(ownerUserId, candidate, settings, profile, library);
        return {
          ...fallback,
          reason: `本机 CLI 生成失败已降级为话术库（${error instanceof Error ? error.message : "未知错误"}）`,
          blocked: true
        };
      }
    }
    if (engine === "ai") {
      try {
        return await this.generateWithAi(ownerUserId, candidate, settings, profile, settings.providerId!, library);
      } catch (error) {
        const fallback = this.generateWithRules(ownerUserId, candidate, settings, profile, library);
        return {
          ...fallback,
          reason: `AI 生成失败已降级为模板回复（${error instanceof Error ? error.message : "未知错误"}）`,
          blocked: true
        };
      }
    }
    // 话术库不是「不能用」：用训练库/训练样本检索同样能自动回复，
    // 能不能真发由模式与置信度门槛决定，这里不再无条件拦下。
    const rules = this.generateWithRules(ownerUserId, candidate, settings, profile, library);
    // 选的不是「只用话术库」却落到话术库，必须说清为什么：真实困惑是「这条怎么一点不像 AI 写的」，
    // 让人能一眼看出是模型通道没配好，而不是去怀疑功能坏了。
    const modelChannelUnusable = settings.engine !== "rules" && !rules.blocked;
    return modelChannelUnusable
      ? { ...rules, reason: `${rules.reason}（未配置 AI Provider 或本机 CLI 不可用，本次使用话术库）` }
      : rules;
  }

  /** 训练库没接入（或查询失败）时返回 null，让自动回复退化成老行为，而不是整条链失败。 */
  private async loadLibrary(ownerUserId: string, candidate: Candidate): Promise<TrainingLibraryMatchResult | null> {
    if (!this.library) return null;
    try {
      return await this.library.resolve(ownerUserId, candidate.retrievalBody || candidate.inboundBody, candidate.accountId);
    } catch {
      return null;
    }
  }

  /**
   * 话术库检索：找与客户这句话最接近的一问一答。
   *
   * **训练库优先、训练档案兜底**：库里的条目是确认过的口径，比从聊天记录里自动抽的样本可信；
   * 库里没有相近问法时才用档案样本，这样升级不会让已有配置突然回不了。
   * 置信度由相似度换算，交给「模式 + 门槛」决定是否自动发送；
   * 只有「压根没有相近问法」才强制拦下——绝不用空回复或瞎猜的回复去自动发送。
   */
  private generateWithRules(
    ownerUserId: string,
    candidate: Candidate,
    settings: AutoChatSettings,
    profile: TrainingProfile | null,
    library?: TrainingLibraryMatchResult | null,
    evidence?: ReplyEvidence
  ): GeneratedReply {
    const libraryHit = library?.hits[0];
    // 与训练库同口径：用合并来文查档案，别让「最后一条是半句」丢掉正题。
    const profileHit = profile ? this.bestProfileExample(candidate.retrievalBody || candidate.inboundBody, profile) : null;
    const useLibrary = Boolean(libraryHit && (!profileHit || libraryHit.similarity >= profileHit.similarity));
    const similarity = useLibrary ? libraryHit!.similarity : profileHit?.similarity ?? 0;
    const matched = useLibrary ? libraryHit!.matched : profileHit?.matched ?? 0;
    const reply = useLibrary ? libraryHit!.entry.answer : profileHit?.reply ?? "";
    const source = useLibrary ? "训练库" : "训练档案话术库";

    if (!reply) {
      return {
        reply: "",
        confidence: 0.1,
        reason: "训练库与训练话术库里都没有相近问法，请人工回复；把这条问答补进训练库后下次就能自动回",
        engine: "rules",
        model: null,
        blocked: true,
        evidence
      };
    }
    const confidence = Math.min(MAX_RULE_CONFIDENCE, Math.round((0.25 + 0.65 * similarity) * 100) / 100);
    // 模板是「历史原话/库里口径复用」，照样要过同一道闸门：
    // 客户以前问价、我们回过报价，那条回复现在被复用出去一样是违规的。
    const gate = this.applyGuardrails(reply, this.mergedGuardrails(settings, library), library?.forbiddenPhrases ?? []);
    if (gate.blocked) {
      return { reply, confidence, reason: gate.reason, engine: "rules", model: null, blocked: true, evidence };
    }
    return {
      reply,
      confidence,
      reason: `与${source}匹配（相似度 ${similarity.toFixed(2)}，${matched} 个共同特征）`,
      engine: "rules",
      model: null,
      blocked: false,
      evidence
    };
  }

  /** 档案样本里的最佳匹配（老通道，保留为兜底）。口径与训练库 rankQa 一致：查询侧做词典扩展、同权计分。 */
  private bestProfileExample(inboundBody: string, profile: TrainingProfile): { similarity: number; matched: number; reply: string } | null {
    const inboundTokens = tokenize(inboundBody);
    if (!inboundTokens.length) return null;
    const { expanded } = expandTokens(inboundTokens, inboundBody);
    const querySet = new Set([...inboundTokens, ...expanded]);
    const querySize = inboundTokens.length + expanded.length;
    let best: { similarity: number; matched: number; reply: string } | null = null;
    for (const example of profile.examples) {
      const exampleTokens = tokenize(example.inbound);
      const matched = exampleTokens.filter((token) => querySet.has(token)).length;
      if (matched < MIN_RULE_MATCHED_TOKENS) continue;
      const similarity = coverage(matched, querySize, exampleTokens.length);
      if (!best || similarity > best.similarity) best = { similarity, matched, reply: example.reply };
    }
    return best;
  }

  /** 拼「给模型看」的请求。AI 与 CLI 两条通道共用同一份，避免两边提示词漂移。 */
  private async buildReplyRequest(
    ownerUserId: string,
    candidate: Candidate,
    settings: AutoChatSettings,
    profile: TrainingProfile | null,
    library?: TrainingLibraryMatchResult | null
  ): Promise<{ system: string; user: string; guardrails: string[]; evidence: ReplyEvidence }> {
    // 现场对话（扩展传上来的）优先；库里那 12 条只在没有现场对话时兜底。
    const context = candidate.transcript?.length
      ? candidate.transcript.slice(-MAX_INLINE_CONTEXT_MESSAGES).map((message) => ({
          role: message.direction === "inbound" ? "customer" : "agent",
          at: message.occurredAt,
          content: message.body
        }))
      : (await this.repository.listMessages(candidate.conversationId, ownerUserId)).slice(-MAX_CONTEXT_MESSAGES).map((message) => ({
          role: message.direction === "inbound" ? "customer" : "agent",
          at: message.occurredAt,
          content: message.body
        }));
    // CRM 依据（客户往来历史 + 知识检索命中）。**取不到不算失败**：这里永远拿到一个对象，
    // 拿不到的东西在 `errors` 里，提示词里干脆不提，而不是编一段。
    const crm = await buildCrmContext(this.crm, ownerUserId, {
      phone: candidate.contactPhone,
      displayName: candidate.contactName,
      query: candidate.inboundBody
    });
    // 训练库的政策条目与设置里的护栏是同一层东西（都是硬约束），合并后一起去重。
    const guardrails = this.mergedGuardrails(settings, library);
    const system = [
      "You are the WhatsApp reply assistant for a B2B export sales team.",
      "Write the next reply to the customer using the team's own trained style. Return one valid JSON object only.",
      `Reply language rule: ${settings.language === "auto" ? "match the customer's latest message language" : `always reply in ${settings.language}`}.`,
      settings.tone ? `Preferred tone: ${settings.tone}.` : "",
      `Follow this schema exactly: {"reply":string,"confidence":0_to_1,"reason":string,"language":string}.`,
      "confidence must reflect how certain you are that this reply is correct and safe to send unattended.",
      ...crmContextSystemLines(crm),
      "Writing guidelines:",
      ...(profile?.guidelines ?? []).map((guideline) => `- ${guideline}`),
      "Hard rules (never break them):",
      ...guardrails.map((rule) => `- ${rule}`),
      ...(library?.forbiddenPhrases.length
        ? ["Never write any of these phrases in your reply:", ...library.forbiddenPhrases.map((phrase) => `- ${phrase}`)]
        : [])
    ].filter(Boolean).join("\n");
    // 训练库命中的问答对排在最前：它是「这一句该怎么答」最直接的依据；
    // 档案样本是语感参考，排后面。两者都带，模型才有得挑。
    const librarySamples = (library?.hits ?? []).map((hit) => ({
      customer: hit.entry.question,
      agent: hit.entry.answer,
      matchedFrom: "training-library",
      similarity: Number(hit.similarity.toFixed(2))
    }));
    const user = JSON.stringify({
      customer: { name: candidate.contactName, phone: candidate.contactPhone },
      latestCustomerMessage: candidate.inboundBody,
      recentConversation: context,
      // CRM 侧的真实往来：客户档案、最近的跟进、报过价的历史。
      // 与 styleSamples 是两种东西 —— 这是**事实**，不是语感参考，提示词里已明确不许把历史报价当新报价用。
      crmContext: crmContextPayload(crm),
      styleSamples: [
        ...librarySamples,
        ...(profile?.examples ?? []).slice(0, 12).map((example) => ({ customer: example.inbound, agent: example.reply }))
      ],
      // 口径片段是「固定说法」，不是问答对：要按客户语言改写，不能直接抄。
      approvedWording: library?.snippets.map((entry) => (entry.question ? `${entry.question}：${entry.answer}` : entry.answer)) ?? []
    });
    return {
      system,
      user,
      guardrails,
      evidence: {
        profile: profile ? { id: profile.id, name: profile.name, examples: profile.examples.length } : null,
        library: library
          ? {
              qa: library.hits.length,
              snippets: library.snippets.length,
              policies: library.policies.length,
              forbidden: library.forbidden.length
            }
          : null,
        crm: {
          matchedBy: crm.matchedBy,
          customer: crm.customer?.company ?? "",
          followUps: crm.activities.length,
          quotes: crm.quotes.length,
          knowledge: crm.knowledge.map((item) => ({ title: item.title, module: item.module, score: item.score })),
          errors: crm.errors
        },
        sources: [
          ...(profile ? (["profile"] as const) : []),
          ...(library ? (["library"] as const) : []),
          ...(crm.activities.length ? (["crm_followup"] as const) : []),
          ...(crm.quotes.length ? (["crm_quote"] as const) : []),
          ...(crm.knowledge.length ? (["knowledge"] as const) : [])
        ]
      }
    };
  }

  private effectiveGuardrails(settings: AutoChatSettings): string[] {
    return settings.guardrails.length ? settings.guardrails : DEFAULT_GUARDRAILS;
  }

  private async generateWithAi(
    ownerUserId: string,
    candidate: Candidate,
    settings: AutoChatSettings,
    profile: TrainingProfile | null,
    providerId: string,
    library?: TrainingLibraryMatchResult | null
  ): Promise<GeneratedReply> {
    const { system, user, guardrails, evidence } = await this.buildReplyRequest(ownerUserId, candidate, settings, profile, library);
    const completion = await this.translation!.completeStructuredJson(providerId, ownerUserId, system, user);
    const parsed = aiReplySchema.parse(JSON.parse(extractJsonObject(completion.content)));
    const gate = this.applyGuardrails(parsed.reply, guardrails, library?.forbiddenPhrases ?? []);
    return {
      reply: parsed.reply,
      confidence: parsed.confidence,
      reason: gate.reason || parsed.reason || "AI 生成",
      engine: "ai",
      model: completion.model,
      blocked: gate.blocked,
      language: parsed.language,
      evidence
    };
  }

  /**
   * 生成之后的统一闸门：三条通道（rules / ai / cli）都必须过。
   *
   * 只拦**机器能判定**的硬约束——护栏里提到价格/折扣/交期/库存时，回复里出现任何
   * 金额字样就拦；以及训练库里写死的禁用短语。其余（语气、是否夸大）交给提示词与人工复核，
   * 不做模糊猜测：误拦比漏拦更容易让用户直接关掉整个功能。
   */
  private applyGuardrails(reply: string, guardrails: string[], forbiddenPhrases: string[]): { blocked: boolean; reason: string } {
    const violations = guardrails.filter((rule) => this.violatesGuardrail(reply, rule));
    if (violations.length) return { blocked: true, reason: `可能触碰护栏：${violations[0]}` };
    const forbidden = forbiddenPhrases.filter((phrase) => containsPhrase(reply, phrase));
    if (forbidden.length) return { blocked: true, reason: `回复含训练库禁用语「${forbidden[0]}」` };
    return { blocked: false, reason: "" };
  }

  /** 设置里的护栏 + 训练库的政策条目：都是硬约束，合并去重后一起用。 */
  private mergedGuardrails(settings: AutoChatSettings, library?: TrainingLibraryMatchResult | null): string[] {
    const policies = (library?.policies ?? []).map((entry) => (entry.question ? `${entry.question}：${entry.answer}` : entry.answer));
    return [...new Set([...this.effectiveGuardrails(settings), ...policies])];
  }

  /**
   * 本机 WorkBuddy CLI 通道。
   *
   * 与 AI 通道的区别：CLI 只吃一段提示词（没有 system/user 分离），且必须自己兜住
   * 「输出里夹了寒暄、包了 ```json 围栏」这类脏输出——CLI 是个 Agent，不是补全接口。
   *
   * 提示词的**第一行**是技能点名：插件自带的 `goodjob-auto-reply` 技能里写的是
   * 「怎么用训练库、什么情况必须转人工」这套方法论。技能没装时任务照常继续（静默降档），
   * 所以点名句里明确写了「拿不到技能就按下面的说明做」，不让一次缺装变成整条链失败。
   */
  private async generateWithCli(
    ownerUserId: string,
    candidate: Candidate,
    settings: AutoChatSettings,
    profile: TrainingProfile | null,
    library?: TrainingLibraryMatchResult | null
  ): Promise<GeneratedReply> {
    if (!this.cli) throw new Error("本机 CLI 引擎未接入");
    const { system, user, guardrails, evidence } = await this.buildReplyRequest(ownerUserId, candidate, settings, profile, library);
    const prompt = [
      cliSkillDirective(AUTO_REPLY_SKILL),
      "",
      system,
      "",
      "Do not call any tool, do not search the workspace, do not explain. Answer with the JSON object alone.",
      "",
      user
    ].join("\n");
    const result = await this.cli.run({
      prompt,
      model: settings.cliModel,
      effort: settings.cliEffort,
      // 单次生成不需要多轮：给 2 轮余量（有的模型会先输出一句话再给 JSON），
      // 超时按 60 秒封顶，避免把每分钟的兜底扫描拖住。
      maxTurns: 2,
      timeoutMs: 60_000
    });
    const parsed = aiReplySchema.parse(JSON.parse(extractJsonObject(result.text)));
    const gate = this.applyGuardrails(parsed.reply, guardrails, library?.forbiddenPhrases ?? []);
    // 把 CLI **自报**的模型写进草稿：这是「系统里配的模型到底生效没有」的唯一直接证据。
    const model = result.model || sanitizeCliModel(settings.cliModel) || CLI_MODEL_DEFAULT;
    const elapsed = `${(result.durationMs / 1_000).toFixed(1)} 秒`;
    return {
      reply: parsed.reply,
      confidence: parsed.confidence,
      reason: gate.reason || `本机 CLI 生成（实际使用模型：${model}，耗时 ${elapsed}）${parsed.reason ? ` · ${parsed.reason}` : ""}`,
      engine: "cli",
      model,
      blocked: gate.blocked,
      language: parsed.language,
      evidence
    };
  }

  /** 只覆盖能被机器判定的两类硬约束；其余靠提示词约束。 */
  private violatesGuardrail(reply: string, rule: string): boolean {
    if (!/价格|折扣|交期|库存/u.test(rule)) return false;
    return /(?:USD|EUR|CNY|RMB|\$|￥|€)\s?\d/iu.test(reply);
  }

  /**
   * 特征词切分与相似度已抽到 `./text-match.js`：训练库检索与话术库检索必须用同一套口径，
   * 两处各写一份必然越改越不一致。
   */

  private withinActiveHours(settings: AutoChatSettings): boolean {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: settings.timezone, hour: "2-digit", hour12: false }).format(this.clock()));
    const { activeHoursStart: start, activeHoursEnd: end } = settings;
    if (start === end) return true;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  private localDate(timezone: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(this.clock());
  }

  private startOfLocalDay(timezone: string): string {
    const date = this.localDate(timezone);
    const utcMidnight = new Date(`${date}T00:00:00.000Z`);
    // 用「本地日期 + 时区偏移」反推 UTC 零点，避免引入额外依赖。
    const offsetMinutes = this.timezoneOffsetMinutes(timezone);
    return new Date(utcMidnight.getTime() - offsetMinutes * 60_000).toISOString();
  }

  private timezoneOffsetMinutes(timezone: string): number {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const parts = Object.fromEntries(formatter.formatToParts(this.clock()).map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    );
    return Math.round((asUtc - this.clock().getTime()) / 60_000);
  }
}

export { DEFAULT_ESCALATE_KEYWORDS, MAX_RULE_CONFIDENCE };
