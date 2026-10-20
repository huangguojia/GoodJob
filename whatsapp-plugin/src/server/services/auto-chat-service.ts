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
  TrainingCitation,
  TrainingLibraryMatch,
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
import { coverage, containsPhrase, expandTokens, isDomainTerm, isStopTerm, tokenize } from "./text-match.js";

const DEFAULT_ESCALATE_KEYWORDS = [
  "投诉", "退款", "律师", "法务", "起诉", "假冒", "假货", "骗子",
  "complaint", "refund", "lawyer", "lawsuit", "legal", "fraud", "scam"
];

/**
 * 从文本里抠出金额数字（只留数字，币种/千分位/单位都不参与比较）。
 *
 * 中文「元 / 人民币 / 块」必须一起认：旧判定只认前缀币种，于是 `RMB 1,650` 被拦、
 * `1650 元` 放行 —— 同一笔钱换个写法得出相反结论。
 */
function amountsIn(text: string): string[] {
  const matches = String(text ?? "").matchAll(
    /(?:USD|EUR|CNY|RMB|\$|￥|€)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:元|人民币|块)/giu
  );
  return [...matches]
    .map((match) => match[0].replace(/[^\d.]/gu, "").replace(/\.$/u, ""))
    .filter((digits) => digits.length > 0 && digits !== "0");
}

/** 只在最近这段时间内的未回复消息上工作，避免开启功能后突然翻旧账。 */
const CANDIDATE_WINDOW_HOURS = 48;
const MAX_DRAFTS_PER_RUN = 10;
/**
 * 「精确命中直通」的相似度门槛。
 *
 * 库里已经有一条几乎逐字对应的问答时，回复就是那条原话 —— CLI 拿不到新信息，只能换个说法，
 * 却要多花 20 秒（实测：CLI 22.3s vs 规则通道 20~50ms）。0.9 是刻意留的余量：
 * 只有问法高度一致才直通，措辞差得多的仍然交给模型结合上下文改写。
 */
const FAST_PATH_SIMILARITY = 0.9;
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
  /**
   * 同一段回复的中文写法，**只给业务员看，永远不发给客户**。
   *
   * 右列是「业务员复核稿子的地方」：草稿发给客户是英语/俄语，人要先确认自己到底
   * 答应了什么。这一格必须由**同一次生成**给出，不能事后拿译文接口回译 ——
   * 回译会把「没承诺」译成「承诺了」，而那正是复核要看的东西。
   *
   * 缺省空串：老提示词、规则通道、或模型漏了这个字段时都能解析，界面退化成单格。
   */
  replyZh: z.string().trim().max(1_200).default(""),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().max(300).default(""),
  language: z.string().trim().max(32).default("")
});

/**
 * 通话里的一次「给三条」。
 *
 * 与 `aiReplySchema` 刻意分开：那条是"一段可以发出去的稿"，这条是"三个候选"。
 * 每条必须带 `reasonZh`——**中文说明为什么建议这么回**，界面把它放在英文原话上面。
 * 理由由同一次生成给出，不做事后回译：回译会把"没承诺"写成"承诺了"。
 */
const callSuggestOptionSchema = z.object({
  /**
   * 中文说明。**缺省允许空串**：模型漏一个字段就整条报错、三条建议全部拿不到，
   * 代价远大于"少一句理由"。空了由界面/收口层补一句通用说明，绝不编造事实。
   */
  reasonZh: z.string().trim().max(300).default(""),
  reply: z.string().trim().min(1).max(1_200),
  replyZh: z.string().trim().max(1_200).default("")
});

const callSuggestResultSchema = z.object({
  options: z.array(callSuggestOptionSchema).min(1).max(3)
});

export type CallSuggestOption = z.infer<typeof callSuggestOptionSchema>;

/** 只给测试用：验证"模型吐脏数据"时的收口口径。 */
export { callSuggestResultSchema };

/**
 * 三条候选的收口：去空、去重、过闸、截到三条。
 *
 * 抽成纯函数是为了能单测 —— 这段判断错起来是**静默**的：多一条少一条都不报错，
 * 界面只是"看起来少了一个建议"。`isBlocked` 由调用方注入护栏判定。
 */
export function finalizeCallSuggestOptions(
  options: CallSuggestOption[],
  isBlocked: (reply: string) => boolean = () => false
): { options: CallSuggestOption[]; dropped: number } {
  const seen = new Set<string>();
  const kept: CallSuggestOption[] = [];
  let dropped = 0;
  for (const option of options) {
    const reply = String(option.reply ?? "").trim();
    if (!reply) {
      dropped += 1;
      continue;
    }
    // 三条一模一样（只差标点/大小写）等于只给了一条，界面会被读成"重复渲染"。
    const key = reply.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (seen.has(key) || isBlocked(reply)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    const replyZh = String(option.replyZh ?? "").trim();
    kept.push({
      reasonZh: String(option.reasonZh ?? "").trim() || "按上下文给的建议",
      reply,
      // 中文与正文一字不差时按「没有中文版」处理：上下两格同一段话，会让人以为要发两条。
      replyZh: replyZh === reply ? "" : replyZh
    });
    if (kept.length === 3) break;
  }
  return { options: kept, dropped };
}

/**
 * 快稿 → 一条能立刻显示的候选（`engine: "rules"` 通道）。
 *
 * 与三条的关系不是"质量低一档"，而是**用途不同**：它只回答"这句话照库里现成的说法怎么讲"，
 * 不做上下文改写。所以理由里必须写明来源与相似度 —— 业务员据此判断这是"可以直接念的原话"
 * 还是"要自己顺一下"。
 *
 * 返回 null 表示库里没命中、或这条被护栏挡下：界面该继续等三条，**不要**拿一句通用话术充数
 * （"好的，我确认后回复您"这种稿子看起来能用，实际是把客户的提问糊过去）。
 */
export function quickCallOption(draft: {
  reply?: string;
  reason?: string;
  blocked?: boolean;
}): CallSuggestOption | null {
  const reply = String(draft?.reply ?? "").trim();
  if (!reply || draft?.blocked) return null;
  const reason = String(draft?.reason ?? "").trim();
  return {
    reply,
    // schema 的 reasonZh 上限 300：超了整条会被 zod 丢掉。宁可截断，也不让快稿消失。
    reasonZh: (reason ? `快速草稿 · ${reason}` : "快速草稿 · 训练库里的现成说法").slice(0, 300),
    replyZh: ""
  };
}

/** 通话建议的返回。`ok:false` 时带 `reason`，界面直接显示，不吞成"未知错误"。 */export interface CallSuggestResult {
  ok: boolean;
  options: CallSuggestOption[];
  engine?: AutoChatDraftEngine;
  model?: string | null;
  reason?: string;
  /**
   * 这是「快稿」（`engine: "rules"`）：一条能立刻显示的现成说法，
   * 不是最终的三条。界面据此先垫一句、等正式结果回来再整体替换。
   */
  quick?: boolean;
  /** 被护栏挡下的条数（金额无出处、含禁用词等），界面据此说明"为什么不是三条"。 */
  dropped?: number;
  elapsedMs?: number;
}

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
  /**
   * 这条消息的**中文译文**（扩展左侧已经算好的那份）。
   *
   * 只用于**检索**，绝不进提示词、也不冒充原文：客户说俄语时，训练库是中文写的，
   * 拿俄语原文去 `rankQa` 是纯词法比对，交集恒为 0 → 命中 0 条，训练库等于没参与。
   * 译文是扩展本来就要给用户看的，顺流带上来不增加任何模型调用。
   * 没有译文（未翻译/翻译失败）时回退原文，行为与本字段不存在时完全一致。
   */
  zh?: string;
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
  /**
   * `reply` 的中文版（同一段话，只给业务员复核）。空串 = 这一轮拿不到中文版
   * （规则通道直接复用中文库答案、或模型没按 schema 给），右列会退化成单格。
   */
  replyZh: string;
  confidence: number;
  reason: string;
  /**
   * `reply` 实际用的语言代码（`en` / `ru` / `zh-CN` …）。
   * 模型通道取模型自报的 `language`，缺省时按文本现判 —— 右列那一格的标签靠它。
   */
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
  /**
   * 命中统计 + **可展开的出处**。
   *
   * `citations` 是「来源证明」的载体（P0 新增）：扩展点开「来源」看到的就是它。
   * 只有计数没有出处的时代，用户无法验证「这条回复凭什么这么说」——
   * 那正是"智能回复"和"瞎编"在用户眼里没有区别的根源。
   */
  library: {
    qa: number;
    snippets: number;
    policies: number;
    forbidden: number;
    citations: TrainingCitation[];
  } | null;
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
  /** 同一段回复的中文版（见 `aiReplySchema.replyZh`）。规则通道为空。 */
  replyZh?: string;
  confidence: number;
  reason: string;
  engine: AutoChatDraftEngine;
  model: string | null;
  blocked: boolean;
  /** 模型自报的语言（`aiReplySchema.language`）。回给扩展显示，不参与决策。 */
  language?: string;
  evidence?: ReplyEvidence;
  /**
   * 这一轮真正用到的训练库条目 id（四类合一）。
   * 会落到草稿行上，草稿「真发出去」时才能把采纳回流记回那几条 —— 不存就等于没有回流。
   */
  libraryEntryIds?: string[];
}

/**
 * 这一轮真正用到的训练库条目 id：**直接取 citations 的 refId**。
 *
 * 刻意不另算一份（比如把 hits/snippets/policies/forbidden 再拼一遍）：
 * 界面展示的出处与实际计数的条目必须是同一个集合，两处各算一次迟早会漂移，
 * 那时会出现「界面上有这条，但它的 hit_count 没涨」这种查不清的账。
 */
function libraryEntryIds(library: TrainingLibraryMatchResult | null): string[] {
  if (!library) return [];
  return [...new Set(library.citations.map((citation) => citation.refId))].slice(0, 20);
}

/**
 * 只由「训练档案 + 训练库」构成的依据（规则通道与两条降级路径用）。
 *
 * 为什么规则通道也必须给依据：**它恰恰是最需要来源证明的一条** ——
 * 回复内容就是从库里那条问答原样拿的，用户点开来源能直接看到"这句就是这条训练条目的答案"。
 * 旧版只有模型通道（`buildReplyRequest`）才带 evidence，于是"用了哪条库内容"在
 * 最直接的那条链路里反而看不见。
 *
 * `crm: null` 是如实说明：规则通道不读 CRM 上下文，不能凭空造一个。
 */
function libraryEvidence(profile: TrainingProfile | null, library: TrainingLibraryMatchResult | null): ReplyEvidence | undefined {
  if (!profile && !library) return undefined;
  return {
    profile: profile ? { id: profile.id, name: profile.name, examples: profile.examples.length } : null,
    library: library
      ? {
          qa: library.hits.length,
          snippets: library.snippets.length,
          policies: library.policies.length,
          forbidden: library.forbidden.length,
          citations: library.citations
        }
      : null,
    crm: null,
    sources: [
      ...(profile ? (["profile"] as const) : []),
      ...(library ? (["library"] as const) : [])
    ]
  };
}

/**
 * 三条候选的提示词。与单条回复共用上下文，只换任务说明与输出 schema。
 *
 * 导出是为了能单测：这几句一旦被改松（例如去掉"Simplified Chinese"），模型会拿英文
 * 写理由，而界面按中文排版 —— 看起来像"理由乱码"，实际是提示词退化了。
 */
export function callSuggestPromptOverrides(): { intro: string[]; schemaLine: string } {
  return {
    intro: [
      "You are the live-call assistant for a B2B export sales team.",
      "The salesperson is on a voice/video call right now. Based on the conversation so far and the customer's latest question, propose exactly 3 DIFFERENT replies the salesperson can say next.",
      "Return one valid JSON object only."
    ],
    schemaLine: [
      'Follow this schema exactly: {"options":[{"reasonZh":string,"reply":string}]} with exactly 3 items.',
      '"reasonZh" MUST be Simplified Chinese, at most 30 characters: one short sentence telling the salesperson WHY this option fits — what the customer wants and what to do about it (e.g. "客户在问交期，先给确定天数，再反问数量").',
      '"reply" is the exact sentence the salesperson should say, in the customer\'s language. ONE short sentence, at most 25 words, speakable on a call.',
      "Do not add replyZh or any other field: the three replies must fit in one short JSON object, this runs during a live call.",
      "Make the three options genuinely different in approach (direct answer / answer plus next-step / clarifying question). Never invent prices, lead times or specs that are not in the provided context, and never promise a deadline ('today', 'tomorrow', 'within 24 hours') that the context does not support."
    ].join(" ")
  };
}

export class AutoChatService {
  private readonly running = new Set<string>();
  /**
   * 「同一句客户消息」的成品缓存。
   *
   * 面板每次打开、每次切走再切回都会重新打一次 `/auto-chat/suggest`，而客户那句话
   * 一个字都没变 —— 为同一句话再等一次生成纯属白等。
   *
   * 只缓存**可用且有正文**的结果（`action=reply` 且没过护栏）；skip / blocked 一律不缓存：
   * 那两种状态很可能是因为设置或训练库刚改过，缓存下来会让人以为改的设置没生效。
   *
   * TTL 刻意只有 2 分钟：训练库/档案改了应当很快反映出来。
   */
  private readonly composeCache = new Map<string, { at: number; value: ComposeResult }>();
  private static readonly COMPOSE_CACHE_TTL_MS = 120_000;
  private static readonly COMPOSE_CACHE_MAX = 48;
  /**
   * 缓存开关。生产默认开；测试与「同一进程里换着 mock 外部依赖」的场景必须关掉
   * （否则上一个用例的结果会喂给下一个用例）。
   */
  composeCacheEnabled = true;
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
      // 采纳回流：草稿真的发出去了，才说明那几条库内容是**帮上忙的**。
      // 命中（进提示词）与采纳（用户认了这稿）分开记，界面才回答得了「哪条是我建着玩的」。
      // 自动发送也算采纳：模式设成 auto 就是用户对这库内容的整体授权。
      this.recordLibraryHits(draft.libraryEntryIds, { adopted: true });
      await this.repository.audit("auto_chat.draft.sent", "auto_chat_draft", draft.id, "success", {
        conversationId: draft.conversationId,
        libraryEntries: draft.libraryEntryIds.length
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
  /**
   * 页面送上来的对话 → 内部形状。
   *
   * 聊天列与通话列**共用这一份**：`compose` 与 `suggestForCall` 各写一份的话，
   * 加字段时必然漏一边（`zh` 就踩过：只加进了 suggest，另一路被 zod 静默 strip）。
   */
  private inlineMessages(input: ComposeInput) {
    return (input.messages ?? [])
      .map((message) => {
        const direction = message.direction === "outbound" ? ("outbound" as const) : ("inbound" as const);
        // 译文只带来信，且与正文同一个上限：它也是页面文本，不给更宽的口子。
        const zh = direction === "inbound" ? String(message.zh ?? "").trim().slice(0, MAX_INLINE_MESSAGE_CHARS) : "";
        return {
          direction,
          body: String(message.body ?? "").replace(/\s+$/u, "").slice(0, MAX_INLINE_MESSAGE_CHARS),
          occurredAt: String(message.occurredAt ?? "") || this.clock().toISOString(),
          ...(zh ? { zh } : {})
        };
      })
      .filter((message) => message.body.trim())
      .slice(-MAX_INLINE_CONTEXT_MESSAGES);
  }

  async compose(ownerUserId: string, input: ComposeInput): Promise<ComposeResult> {
    const messages = this.inlineMessages(input);
    const skip = (reason: string, extra: Partial<ComposeResult> = {}): ComposeResult => ({
      action: "skip",
      reply: "",
      replyZh: "",
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
    //
    // ⚠️ 原文与译文**绝不拼在一起**：混拼会让 `tokenize` 多切出一堆俄语/西语词，
    // `querySize` 被撑大、相似度分母跟着变大 —— 明明是同一个问题，命中反而更难。
    //
    // ⚠️ 顺序是「**原文优先、译文兜底**」（10/20 自测后改，旧版只要有译文就只用译文）：
    // 译文会改写专有名词与问法，实测 `How long is the lead time for production` 的译文
    // 被写成「生产周期是多久？」，与「质保期是多久？」共享「是多/多久」两个 bigram，
    // 于是命中了**质保**条目，而库里明明有一条英文原句可以 1.00 命中。
    // 原文是客户自己说的话，型号/术语最准，先拿它查；原文一条都没命中时才用译文 ——
    // 那正是小语种（俄语/西语/阿语）唯一的桥，不能丢。
    const inboundMessages = messages.filter((message) => message.direction === "inbound");
    const originalBody = inboundMessages
      .map((message) => message.body.trim())
      .filter(Boolean)
      .slice(-3)
      .join("\n");
    const translatedBody = [...new Set(
      inboundMessages.map((message) => String(message.zh ?? "").trim()).filter(Boolean)
    )]
      .slice(-3)
      .join("\n");
    const retrievalBody = originalBody || translatedBody;

    const escalate = effective.escalateKeywords.find((keyword) =>
      latestInbound.body.toLowerCase().includes(keyword.toLowerCase())
    );
    if (escalate) return skip(`命中升级关键词「${escalate}」，已交给人工处理`);

    /**
     * 同一句客户消息 + 同一套设置 = 同一个答案。面板反复打开时直接给成品，
     * 不必再让模型把同一段话重新写一遍。
     */
    const cacheKey = this.composeCacheEnabled ? this.composeCacheKey(ownerUserId, input, effective, retrievalBody) : "";
    const cached = cacheKey ? this.readComposeCache(cacheKey) : null;
    if (cached) return cached;

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

    let library = await this.loadLibrary(ownerUserId, candidate);
    /**
     * 原文没命中时的译文兜底。只在**原文一条 qa 都没命中**时才补这一次检索 ——
     * 原文有命中就说明客户的语言本身能对上库里的写法，此时再拿译文查一遍只会
     * 引入第二套说法、把排序搅乱。`candidate.retrievalBody` 一并换成命中那版：
     * 后面的档案检索与提示词用的是同一个口径，不能一个查原文、一个讲译文。
     */
    if (translatedBody && translatedBody !== originalBody && !library?.hits?.length) {
      const retry = await this.loadLibrary(ownerUserId, { ...candidate, retrievalBody: translatedBody });
      if (retry?.hits?.length) {
        library = retry;
        candidate.retrievalBody = translatedBody;
      }
    }
    // 命中计数（G13③）：与 handleInbound 那条路径同款 fire-and-forget，**四类全计**。
    // compose() 是「推荐回复」通道 —— 正是业务员天天点的那条，此前只计 qa 命中，
    // 于是口径与政策天天进提示词、hit_count 却永远是 0，死条目清理清单判不准。
    this.recordLibraryHits(libraryEntryIds(library));
    if (library?.forbidden.length) {
      const scene = library.forbidden[0].entry;
      return skip(`训练库禁用场景「${scene.question}」命中，已转人工处理`, { blocked: true });
    }

    const engine = await this.resolveEngine(effective);
    let generated: GeneratedReply;
    // 先看能不能直通：精确命中时不值得为同一句话等 20 秒。
    const fast = this.fastPathReply(
      ownerUserId,
      candidate,
      effective,
      profile,
      library,
      libraryEvidence(profile, library)
    );
    if (fast) {
      generated = fast;
    } else if (engine === "cli") {
      try {
        generated = await this.generateWithCli(ownerUserId, candidate, effective, profile, library);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "未知错误";
        // 与后台通道同一条纪律：降级成话术库，但**标记 blocked** —— 引擎不可用时的模板命中，
        // 置信度是没有意义的，不能让人以为"这就是智能回复"。
        generated = {
          ...this.generateWithRules(ownerUserId, candidate, effective, profile, library, libraryEvidence(profile, library)),
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
          ...this.generateWithRules(ownerUserId, candidate, effective, profile, library, libraryEvidence(profile, library)),
          reason: `AI 生成失败已降级为话术库（${detail}）`,
          blocked: true
        };
      }
    } else {
      // 规则通道也要给依据：这段回复就是从库里那条问答原样拿的，
      // 用户点开「来源」应当能直接看到"这句就是这条训练条目的答案"。
      generated = this.generateWithRules(ownerUserId, candidate, effective, profile, library, libraryEvidence(profile, library));
    }

    if (generated.reply) this.countProfileHit(profile);
    const reply = generated.reply;
    const replyZh = String(generated.replyZh ?? "").trim();
    const result: ComposeResult = {
      action: reply ? "reply" : "skip",
      reply,
      // 中文版与正文一字不差时按「没有中文版」处理（库里的答案本来就是中文就是这种情况）：
      // 上下两格显示同一段话，会让人以为要发两条。
      replyZh: replyZh === reply.trim() ? "" : replyZh,
      confidence: generated.confidence,
      reason: generated.reason,
      language: generated.language ?? (effective.language === "auto" ? "" : effective.language),
      engine: generated.engine,
      model: generated.model,
      blocked: generated.blocked,
      evidence: generated.evidence ?? null
    };
    this.writeComposeCache(cacheKey, result);
    return result;
  }

  /** 缓存 key：用户 + 账号 + 所有会影响答案的设置 + 客户实际说的那几句。 */
  private composeCacheKey(
    ownerUserId: string,
    input: ComposeInput,
    effective: AutoChatSettings,
    retrievalBody: string
  ): string {
    return [
      ownerUserId,
      String(input.accountId ?? ""),
      String(effective.engine ?? ""),
      sanitizeCliModel(effective.cliModel),
      sanitizeCliEffort(effective.cliEffort),
      String(effective.language ?? ""),
      String(effective.tone ?? ""),
      String(effective.profileId ?? ""),
      String(effective.mode ?? ""),
      retrievalBody
    ].join("\u0000");
  }

  private readComposeCache(key: string): ComposeResult | null {
    const hit = this.composeCache.get(key);
    if (!hit) return null;
    if (this.clock().getTime() - hit.at > AutoChatService.COMPOSE_CACHE_TTL_MS) {
      this.composeCache.delete(key);
      return null;
    }
    // 返回副本：调用方会往 `evidence.sources` 里补 "resource"，共享引用会把缓存改脏。
    return structuredClone(hit.value);
  }

  private writeComposeCache(key: string, value: ComposeResult): void {
    if (!key || !this.composeCacheEnabled) return;
    // 只缓存「能直接用」的成品。skip / blocked 很可能是因为刚改过设置或训练库，
    // 缓存下来会让人以为改动没生效。
    if (value.action !== "reply" || !value.reply || value.blocked) return;
    if (this.composeCache.size >= AutoChatService.COMPOSE_CACHE_MAX) {
      const oldest = this.composeCache.keys().next().value;
      if (oldest) this.composeCache.delete(oldest);
    }
    this.composeCache.set(key, { at: this.clock().getTime(), value: structuredClone(value) });
  }

  /**
   * 通话里的「按前面的对话 + 客户最后那句话，给三条回复」。
   *
   * 与 `compose` 的三点不同：
   *   1. 出**三个候选**而不是一条，每条带中文理由（`reasonZh`）——通话时业务员要的是
   *      "这一句怎么接"，看到理由才敢照着说；
   *   2. 不走规则/话术库直通：库里的历史原话给不出三个真正不同的说法，硬凑就是换标点；
   *   3. **绝不发送**。返回的只是文本，复制与粘贴都由用户自己做。
   *
   * 沿用 `compose` 的口径：不落库、不套日限额与活跃时段、不写任何业务表。
   */
  async suggestForCall(ownerUserId: string, input: ComposeInput): Promise<CallSuggestResult> {
    const startedAt = this.clock().getTime();
    const messages = this.inlineMessages(input);
    if (!messages.length) return { ok: false, options: [], reason: "这段通话里还没有可用的一句话" };
    const latestInbound = [...messages].reverse().find((message) => message.direction === "inbound");
    // 只有我方说过话时没必要推荐：没有"要回答的那句"。
    if (!latestInbound) return { ok: false, options: [], reason: "客户还没开口，先等他问出来" };

    const settings = await this.resolveSettings(ownerUserId, input.accountId ?? undefined);
    const effective: AutoChatSettings = {
      ...settings,
      enabled: true,
      mode: "draft",
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.model !== undefined ? { cliModel: sanitizeCliModel(input.model) } : {}),
      ...(input.effort !== undefined ? { cliEffort: sanitizeCliEffort(input.effort) } : {}),
      ...(input.language ? { language: input.language } : {})
    };

    const inboundMessages = messages.filter((message) => message.direction === "inbound");
    const originalBody = inboundMessages.map((message) => message.body.trim()).filter(Boolean).slice(-3).join("\n");
    const translatedBody = [...new Set(
      inboundMessages.map((message) => String(message.zh ?? "").trim()).filter(Boolean)
    )].slice(-3).join("\n");

    const profile = settings.profileId ? await this.repository.getTrainingProfile(settings.profileId, ownerUserId) : null;
    const candidate: Candidate = {
      conversationId: `call:${ownerUserId}`,
      accountId: input.accountId ?? "",
      accountName: "",
      contactName: String(input.contact?.name ?? "").trim().slice(0, 180),
      contactPhone: normalizePhone(input.contact?.phone),
      inboundMessageId: `call:${this.clock().toISOString()}`,
      inboundBody: latestInbound.body,
      retrievalBody: originalBody || translatedBody,
      inboundAt: latestInbound.occurredAt,
      transcript: messages
    };

    let library = await this.loadLibrary(ownerUserId, candidate);
    // 与 compose 同一条兜底：原文一条都没命中时才用译文查（小语种唯一的桥）。
    if (translatedBody && translatedBody !== originalBody && !library?.hits?.length) {
      const retry = await this.loadLibrary(ownerUserId, { ...candidate, retrievalBody: translatedBody });
      if (retry?.hits?.length) {
        library = retry;
        candidate.retrievalBody = translatedBody;
      }
    }
    this.recordLibraryHits(libraryEntryIds(library));
    if (library?.forbidden.length) {
      const scene = library.forbidden[0].entry;
      return { ok: false, options: [], reason: `训练库禁用场景「${scene.question}」命中，已转人工处理` };
    }

    /**
     * 快稿：`engine: "rules"` 只给**一条**，训练库命中时几十毫秒就能显示。
     *
     * 为什么要这条通道：通话里模型要 5~9 秒，而这 5~9 秒客户正在等下一句。库里命中的
     * 原话本来就能直接照着说，没有理由让人陪模型跑完 —— 先把这条垫上去，三条回来再整体替换。
     *
     * 只有**显式**传 `engine: "rules"` 才走这里：用户设置里选 rules 是"聊天自动回复只用规则"，
     * 不等于通话推荐要退化成一条，那种情况下仍然如实报"需要 CLI"。
     */
    if (input.engine === "rules") {
      const draft = this.generateWithRules(ownerUserId, candidate, effective, profile, library);
      const quick = quickCallOption(draft);
      const elapsedMs = this.clock().getTime() - startedAt;
      return quick
        ? { ok: true, quick: true, engine: "rules", model: null, dropped: 0, options: [quick], elapsedMs }
        : {
            ok: false,
            quick: true,
            options: [],
            reason: draft.reason || "训练库没有命中可直接用的说法",
            elapsedMs
          };
    }

    // ⚠️ 曝光记账只记正式通道：快稿是垫话，用户真正采用的是三条里的一条。
    // 两路都记会让 hit_count 随"客户说了几句"翻倍，排序被自己的请求量带偏。
    this.recordLibraryHits(libraryEntryIds(library));

    const engine = await this.resolveEngine(effective);
    /**
     * 通道选择。规则库不参与：它只会把库里那条原话原样给三遍，凑不出三个"不同说法"。
     * `auto` 时按 cli → ai 的顺序退；用户显式选了哪条就只走哪条 —— 选了 rules 却没生成器，
     * 如实报"给不出三个候选"，而不是偷偷换个引擎。
     */
    let channel: "cli" | "ai" | null = null;
    if (engine === "ai") channel = this.translation && effective.providerId ? "ai" : null;
    else if (engine === "cli") channel = this.cli ? "cli" : null;
    else if (effective.engine === "auto" || effective.engine === undefined) {
      channel = this.cli ? "cli" : this.translation && effective.providerId ? "ai" : null;
    }
    if (!channel) {
      return {
        ok: false,
        options: [],
        reason: "通话推荐需要本机 CLI 或已配置的 AI Provider —— 规则库给不出三个真正不同的候选"
      };
    }
    try {
      const result =
        channel === "ai"
          ? await this.generateCallSuggestionsWithAi(ownerUserId, candidate, effective, profile, library)
          : await this.generateCallSuggestionsWithCli(ownerUserId, candidate, effective, profile, library);
      return { ...result, ok: true, elapsedMs: this.clock().getTime() - startedAt };
    } catch (error) {
      // 真实原因必须回给界面：CLI 没登录、模型名不认识、插件没起，看起来都是"没建议"，
      // 但补救办法完全不同（登录 CLI / 改设置 / 重启插件）。
      return {
        ok: false,
        options: [],
        reason: error instanceof Error ? error.message : String(error || "未知错误"),
        elapsedMs: this.clock().getTime() - startedAt
      };
    }
  }

  /** 见模块级的 `callSuggestPromptOverrides()`（放外面是为了能单测提示词本身）。 */
  private callSuggestPromptOverrides(): { intro: string[]; schemaLine: string } {
    return callSuggestPromptOverrides();
  }

  private async generateCallSuggestionsWithCli(
    ownerUserId: string,
    candidate: Candidate,
    settings: AutoChatSettings,
    profile: TrainingProfile | null,
    library?: TrainingLibraryMatchResult | null
  ): Promise<{ options: CallSuggestOption[]; engine: AutoChatDraftEngine; model: string | null; dropped: number }> {
    if (!this.cli) throw new Error("本机 CLI 引擎未接入");
    const { system, user } = await this.buildReplyRequest(
      ownerUserId,
      candidate,
      settings,
      profile,
      library,
      this.callSuggestPromptOverrides()
    );
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
      /**
       * ⚠️ 用户没指定模型时**显式钉成 flash**，这里不跟 CLI 自己的默认走。
       *
       * 实测（2026-10-20，同一段通话记录、同一份提示词）：
       *   CLI 默认 `hy4-preview-f` → 18.9 秒，紧接着一次直接 60 秒超时；
       *   `deepseek-v4.1-flash`     → 7.5 秒，稳定出三条。
       * 通话里等 20 秒和等 7 秒是两个产品 —— 前者业务员已经接不上话了。
       * 用户自己配了模型时仍然尊重配置（只在留空时兜底）。
       */
      model: settings.cliModel || CLI_MODEL_DEFAULT,
      effort: settings.cliEffort,
      maxTurns: 2,
      // 75 秒：flash 实测 7.5 秒，但机器忙时会有长尾；超过这个数对通话已经没意义。
      timeoutMs: 75_000
    });
    const parsed = callSuggestResultSchema.parse(JSON.parse(extractJsonObject(result.text)));
    return this.finalizeCallSuggestions(
      parsed.options,
      { engine: "cli", model: result.model || sanitizeCliModel(settings.cliModel) || CLI_MODEL_DEFAULT },
      settings,
      library
    );
  }

  private async generateCallSuggestionsWithAi(
    ownerUserId: string,
    candidate: Candidate,
    settings: AutoChatSettings,
    profile: TrainingProfile | null,
    library?: TrainingLibraryMatchResult | null
  ): Promise<{ options: CallSuggestOption[]; engine: AutoChatDraftEngine; model: string | null; dropped: number }> {
    if (!this.translation) throw new Error("AI Provider 通道未接入");
    const { system, user } = await this.buildReplyRequest(
      ownerUserId,
      candidate,
      settings,
      profile,
      library,
      this.callSuggestPromptOverrides()
    );
    const completion = await this.translation.completeStructuredJson(settings.providerId!, ownerUserId, system, user);
    const parsed = callSuggestResultSchema.parse(JSON.parse(extractJsonObject(completion.content)));
    return this.finalizeCallSuggestions(
      parsed.options,
      { engine: "ai", model: completion.model || null },
      settings,
      library
    );
  }

  /**
   * 三审：去重、过护栏、截到三条。
   *
   * 护栏必须**逐条**过 —— 三条里有一条报了没出处的金额，不能因为它排第二就放行。
   * 被拦下的条目直接丢弃并在 `dropped` 里计数：界面据此说明"为什么只给了两条"，
   * 而不是静默少给（用户会以为模型坏了）。
   */
  private finalizeCallSuggestions(
    options: CallSuggestOption[],
    meta: { engine: AutoChatDraftEngine; model: string | null },
    settings: AutoChatSettings,
    library?: TrainingLibraryMatchResult | null
  ): { options: CallSuggestOption[]; engine: AutoChatDraftEngine; model: string | null; dropped: number } {
    const guardrails = this.mergedGuardrails(settings, library);
    // 护栏必须**逐条**过 —— 三条里有一条报了没出处的金额，不能因为它排第二就放行。
    const result = finalizeCallSuggestOptions(options, (reply) =>
      this.applyGuardrails(reply, guardrails, library?.forbiddenPhrases ?? [], this.sourcedAmountText(library)).blocked
    );
    return { ...result, engine: meta.engine, model: meta.model };
  }

  /**
   * 档案使用回流（G13④ 同款纪律）：**真正用档案生成出回复**才计数 —— 推荐回复通道
   * 与后台草稿通道各计一次；跳过/失败/被禁用的草稿不算（档案没帮上忙就不能记功）。
   * fire-and-forget：计数挂了绝不拖慢回复，也绝不把异常带进主流程。
   */
  private countProfileHit(profile: TrainingProfile | null | undefined): void {
    if (!profile) return;
    void this.repository.recordTrainingProfileHit(profile.id, profile.ownerUserId).catch(() => undefined);
  }

  /**
   * 训练库命中计数（四类合一，见 `libraryEntryIds()`）。
   *
   * 语义是「**这一轮检索命中了这些条目**」——只要 resolve 把它们交了出来就计数，
   * 因为从那一刻起它们就已经进了决策（规则通道直接采用、模型通道进提示词）。
   * 与「采纳」是两件事：采纳看草稿有没有真发出去（`sendDraft` 里补记）。
   *
   * 刻意 fire-and-forget——计数少一次不影响任何功能，绝不允许它拖慢回复或把异常带进主流程。
   */
  private recordLibraryHits(ids: string[], options: { adopted?: boolean } = {}): void {
    if (!this.library || !ids.length) return;
    void this.library.recordHits(ids, options).catch(() => undefined);
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
      error: generated.blocked ? generated.reason : null,
      // 把用到的库条目记在草稿行上：草稿真发出去时才能回流「采纳」。
      libraryEntryIds: generated.libraryEntryIds ?? []
    });
    this.realtime.publish("auto.chat.draft.created", candidate.accountId, draft);
    this.countProfileHit(profile);
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
    // 训练库只取一次，三条通道共用：查询一次、四处用（问答检索 / 口径 / 政策 / 禁用词）。
    const library = await this.loadLibrary(ownerUserId, candidate);
    // 四类命中全计（旧版只计 qa，导致天天进提示词的政策/口径 hit_count 永远是 0）。
    this.recordLibraryHits(libraryEntryIds(library));
    const generated = await this.generateReplyWith(ownerUserId, candidate, settings, profile, library);
    const ids = libraryEntryIds(library);
    return ids.length ? { ...generated, libraryEntryIds: ids } : generated;
  }

  private async generateReplyWith(
    ownerUserId: string,
    candidate: Candidate,
    settings: AutoChatSettings,
    profile: TrainingProfile,
    library: TrainingLibraryMatchResult | null
  ): Promise<GeneratedReply> {
    const engine = await this.resolveEngine(settings);
    // 规则通道与两条降级路径都要带依据：它们用的就是库里的原话，用户最该能核验「用了哪条」。
    const evidence = libraryEvidence(profile, library);
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
        blocked: true,
        evidence
      };
    }
    // 先看能不能直通：精确命中时不值得为同一句话等 20 秒。
    const fast = this.fastPathReply(ownerUserId, candidate, settings, profile, library, evidence);
    if (fast) return fast;
    if (engine === "cli") {
      try {
        return await this.generateWithCli(ownerUserId, candidate, settings, profile, library);
      } catch (error) {
        // 与 AI 失败同一条纪律：降级成话术库草稿，但**不允许自动发送**——
        // 引擎不可用时的模板命中，置信度是没有意义的。
        const fallback = this.generateWithRules(ownerUserId, candidate, settings, profile, library, evidence);
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
        const fallback = this.generateWithRules(ownerUserId, candidate, settings, profile, library, evidence);
        return {
          ...fallback,
          reason: `AI 生成失败已降级为模板回复（${error instanceof Error ? error.message : "未知错误"}）`,
          blocked: true
        };
      }
    }
    // 话术库不是「不能用」：用训练库/训练样本检索同样能自动回复，
    // 能不能真发由模式与置信度门槛决定，这里不再无条件拦下。
    const rules = this.generateWithRules(ownerUserId, candidate, settings, profile, library, evidence);
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
    const baseConfidence = Math.min(MAX_RULE_CONFIDENCE, Math.round((0.25 + 0.65 * similarity) * 100) / 100);
    /**
     * 跨语言命中：客户说外语、命中的是中文条目（或反过来）。
     *
     * 规则通道是**原样复用 answer**，不会翻译 —— 于是会出现「客户说西语，面板给一段中文」
     * 这种内容其实对、但根本发不出去的结果。它的相似度可以很高（译文精确命中），
     * 按公式算出来是 0.9 的"高置信"，正好把最需要人动手的那条标成了最可信的一条。
     * 所以折价并写明原因：口径仍然有用（业务员照着译），但不能被当成可以直接点的稿。
     */
    const entryIsZh = libraryHit
      ? libraryHit.entry.languages.includes("zh") || /[\u4e00-\u9fff]/u.test(libraryHit.entry.question)
      : false;
    const customerIsZh = /[\u4e00-\u9fff]/u.test(candidate.inboundBody);
    const languageMismatch = useLibrary && entryIsZh !== customerIsZh;
    const confidence = languageMismatch
      ? Math.min(MAX_RULE_CONFIDENCE, Math.round(baseConfidence * 0.6 * 100) / 100)
      : baseConfidence;
    // 模板是「历史原话/库里口径复用」，照样要过同一道闸门：
    // 客户以前问价、我们回过报价，那条回复现在被复用出去一样是违规的。
    const gate = this.applyGuardrails(
      reply,
      this.mergedGuardrails(settings, library),
      library?.forbiddenPhrases ?? [],
      this.sourcedAmountText(library)
    );
    if (gate.blocked) {
      return { reply, confidence, reason: gate.reason, engine: "rules", model: null, blocked: true, evidence };
    }
    return {
      reply,
      confidence,
      reason: `与${source}匹配（相似度 ${similarity.toFixed(2)}，${matched} 个共同特征）${
        languageMismatch ? "；命中条目为中文，规则通道不翻译 —— 发送前请按客户语言改写" : ""
      }`,
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
    library?: TrainingLibraryMatchResult | null,
    /**
     * 通话建议用同一套上下文，只换掉"任务说明"与"输出 schema"两行。
     * 之所以让它可覆盖而不是另写一份提示词：档案语感、训练库命中、CRM 事实、护栏
     * 这四块是同一套口径，复制一份出去必然越改越不一致（`zh` 那次就是这么丢的）。
     */
    overrides: { intro?: string[]; schemaLine?: string } = {}
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
      ...(overrides.intro ?? [
        "You are the WhatsApp reply assistant for a B2B export sales team.",
        "Write the next reply to the customer using the team's own trained style. Return one valid JSON object only."
      ]),
      `Reply language rule: ${settings.language === "auto" ? "match the customer's latest message language" : `always reply in ${settings.language}`}.`,
      settings.tone ? `Preferred tone: ${settings.tone}.` : "",
      overrides.schemaLine ??
        `Follow this schema exactly: {"reply":string,"replyZh":string,"confidence":0_to_1,"reason":string,"language":string}.`,
      overrides.schemaLine
        ? ""
        : `"reply" is the text that gets sent to the customer, written in the reply language. "replyZh" is the SAME message written in Simplified Chinese for the salesperson to review before sending — same meaning, same facts, same promises, nothing extra. When the reply language is Chinese, set replyZh to exactly the same text.`,
      // 通话建议里没有 confidence 字段，留着这句只会让模型多写一个被 strip 掉的数字。
      overrides.schemaLine ? "" : "confidence must reflect how certain you are that this reply is correct and safe to send unattended.",
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
              forbidden: library.forbidden.length,
              citations: library.citations
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
    const gate = this.applyGuardrails(
      parsed.reply,
      guardrails,
      library?.forbiddenPhrases ?? [],
      this.sourcedAmountText(library)
    );
    return {
      reply: parsed.reply,
      replyZh: parsed.replyZh,
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
   * 训练库**精确命中直通**：库里已有一条几乎逐字对应的问答时，回复就是那条原话。
   *
   * 为什么值得单独开一条路：CLI 在这条路上拿不到任何新信息（语料就那一条），
   * 只能换个说法，却要多花 20 秒（实测 CLI 22.3s vs 规则通道 20~50ms）。
   * 客户每说一句就要等 20 秒，推荐回复就从"助手"变成了"负担"。
   *
   * 三个边界，缺一不可：
   * 1. **只对 `engine=auto` 生效** —— 用户显式选了 cli/ai，就不能背着他绕过；
   * 2. **相似度 ≥ 0.9** —— 措辞差得多的仍然交给模型结合上下文改写；
   * 3. **被护栏拦住时不直通** —— 那条原话本身不能直接发，交回模型改写才有意义。
   */
  private fastPathReply(
    ownerUserId: string,
    candidate: Candidate,
    settings: AutoChatSettings,
    profile: TrainingProfile | null,
    library?: TrainingLibraryMatchResult | null,
    evidence?: ReplyEvidence
  ): GeneratedReply | null {
    if (settings.engine !== "auto") return null;
    const top = library?.hits[0];
    if (!top) return null;
    if (!this.fastPathEligible(library, top)) return null;
    const quick = this.generateWithRules(ownerUserId, candidate, settings, profile, library, evidence);
    if (!quick.reply || quick.blocked) return null;
    return { ...quick, reason: `${quick.reason}（训练库命中，跳过 CLI 省时）` };
  }

  /**
   * 哪些命中值得直通。
   *
   * 两条路：
   * 1. **相似度 ≥0.9** —— 问法几乎逐字一致；
   * 2. **短问法命中实体词** —— `price?` / `moq?` / `how much per unit?` 这类客户真实打法，
   *    只有一个实义词，相似度天然只有 0.2~0.4（分母是查询长度），按相似度永远够不到门槛。
   *    但它们命中的是贸易域实体词、条目本身也是一句短问法 —— 这就是训练库能给出的最好答案，
   *    没有理由为它等 20 秒（实测这类问法走 CLI 会跑满 60 秒超时，然后降级成一条带"先别发"
   *    标记的草稿，等于既慢又不能用）。
   */
  private fastPathEligible(library: TrainingLibraryMatchResult | null | undefined, top: TrainingLibraryMatch): boolean {
    // **语言必须对得上**：规则通道是原样复用 answer，不会翻译。
    // 英文问法命中一条中文问答时直通，等于把中文报价直接发给英文客户。
    // 这种命中交给 CLI 改写（它会把答案译成客户语言）。
    const queryIsZh = /[\u4e00-\u9fff]/u.test(library?.query ?? "");
    const entryIsZh = top.entry.languages.includes("zh") || /[\u4e00-\u9fff]/u.test(top.entry.question);
    if (queryIsZh !== entryIsZh) return false;
    if (top.similarity >= FAST_PATH_SIMILARITY) return true;
    const meaningful = tokenize(library?.query ?? "").filter((token) => !isStopTerm(token)).length;
    if (meaningful > 1) return false;
    if (top.entry.question.trim().length > 80) return false;
    return top.matchedTerms.some((token) => isDomainTerm(token));
  }

  /**
   * 生成之后的统一闸门：三条通道（rules / ai / cli）都必须过。
   *
   * 只拦**机器能判定**的硬约束——护栏里提到价格/折扣/交期/库存时，回复里出现任何
   * 金额字样就拦；以及训练库里写死的禁用短语。其余（语气、是否夸大）交给提示词与人工复核，
   * 不做模糊猜测：误拦比漏拦更容易让用户直接关掉整个功能。
   *
   * `sourcedText` 是**本轮命中的语料正文**。护栏规则原文写的是「除非训练样本或 CRM 数据里
   * 有明确依据」，这里就是落实那条例外：金额能在语料里找到同样的数字，就不是模型编的价。
   */
  private applyGuardrails(
    reply: string,
    guardrails: string[],
    forbiddenPhrases: string[],
    sourcedText = ""
  ): { blocked: boolean; reason: string } {
    const violations = guardrails.filter((rule) => this.violatesGuardrail(reply, rule, sourcedText));
    if (violations.length) return { blocked: true, reason: `可能触碰护栏：${violations[0]}` };
    const forbidden = forbiddenPhrases.filter((phrase) => containsPhrase(reply, phrase));
    if (forbidden.length) return { blocked: true, reason: `回复含训练库禁用语「${forbidden[0]}」` };
    return { blocked: false, reason: "" };
  }

  /** 本轮命中语料的正文（只用来核对金额出处，不进提示词）。 */
  private sourcedAmountText(library?: TrainingLibraryMatchResult | null): string {
    if (!library) return "";
    const texts = [
      ...library.hits.map((hit) => `${hit.entry.question} ${hit.entry.answer}`),
      ...library.snippets.map((entry) => `${entry.question} ${entry.answer}`),
      ...library.policies.map((entry) => `${entry.question} ${entry.answer}`)
    ];
    return texts.join("\n");
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
    const gate = this.applyGuardrails(
      parsed.reply,
      guardrails,
      library?.forbiddenPhrases ?? [],
      this.sourcedAmountText(library)
    );
    // 把 CLI **自报**的模型写进草稿：这是「系统里配的模型到底生效没有」的唯一直接证据。
    const model = result.model || sanitizeCliModel(settings.cliModel) || CLI_MODEL_DEFAULT;
    const elapsed = `${(result.durationMs / 1_000).toFixed(1)} 秒`;
    return {
      reply: parsed.reply,
      replyZh: parsed.replyZh,
      confidence: parsed.confidence,
      reason: gate.reason || `本机 CLI 生成（实际使用模型：${model}，耗时 ${elapsed}）${parsed.reason ? ` · ${parsed.reason}` : ""}`,
      engine: "cli",
      model,
      blocked: gate.blocked,
      language: parsed.language,
      evidence
    };
  }

  /**
   * 只覆盖能被机器判定的两类硬约束；其余靠提示词约束。
   *
   * 金额识别必须**中英同口径**：旧正则只认前缀币种，于是 `RMB 1,650` 被拦、`1650 元` 放行——
   * 同一句报价换个语言就得出相反的结论，这比不拦更危险（用户会以为「中文写法是安全的」）。
   */
  private violatesGuardrail(reply: string, rule: string, sourcedText = ""): boolean {
    if (!/价格|折扣|交期|库存/u.test(rule)) return false;
    const replyAmounts = amountsIn(reply);
    if (!replyAmounts.length) return false;
    const sourced = new Set(amountsIn(sourcedText));
    // 全部金额都能在语料里找到 → 有出处，放行；只要有一个对不上就拦。
    return replyAmounts.some((amount) => !sourced.has(amount));
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
