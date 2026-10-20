export type ProviderKind = "demo" | "baileys" | "meta";

export type IntegrationStrategy = "free_first" | "official_first" | "hybrid";

export interface IntegrationPreference {
  strategy: IntegrationStrategy;
  defaultProvider: "baileys" | "meta";
  updatedAt: string;
}

export interface MetaAppConfig {
  id: string;
  name: string;
  appId: string;
  appSecretMask: string;
  verifyTokenMask: string;
  webhookKey: string;
  webhookPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface MetaAccountConfiguration {
  accountId: string;
  appConfigId: string;
  appName: string;
  wabaId: string;
  phoneNumberId: string;
  accessTokenMask: string;
  graphApiVersion: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  lastVerifiedAt: string | null;
  lastWebhookAt: string | null;
  updatedAt: string;
}

export interface ContactSyncResult {
  count: number;
  note?: string;
}

export type ContactOrigin = "whatsapp_sync" | "inbound_message" | "manual" | "crm_import" | "history_import";

export const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/u;

export function isE164PhoneNumber(value: string): boolean {
  return E164_PHONE_PATTERN.test(value);
}

export type AccountStatus =
  | "unconfigured"
  | "waiting_qr"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "logged_out"
  | "credential_invalid"
  | "degraded";

export interface ChannelAccount {
  id: string;
  ownerUserId: string | null;
  name: string;
  provider: ProviderKind;
  phone: string | null;
  avatarUrl: string | null;
  status: AccountStatus;
  purposeLabel: string;
  leadTypes: string[];
  region: string;
  priority: number;
  riskAccepted: boolean;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  qrDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  accountId: string;
  providerContactId: string;
  displayName: string;
  phone: string;
  avatarUrl: string | null;
  source: ProviderKind;
  origin: ContactOrigin;
  lastSeenAt: string | null;
  crmContactId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  accountId: string;
  contactId: string;
  providerConversationId: string;
  contactName: string;
  contactPhone: string;
  contactAvatarUrl: string | null;
  unreadCount: number;
  lastMessage: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTrait {
  key: string;
  label: string;
  value: string;
  confidence: number;
  evidenceMessageIds: string[];
}

export interface ConversationTraitFeedback {
  id: string;
  conversationId: string;
  traitKey: string;
  traitLabel: string;
  verdict: "confirmed" | "rejected";
  correctionText: string | null;
  actorUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationAnalysis {
  id: string;
  conversationId: string;
  status: "ready" | "failed";
  summary: string;
  keyPoints: string[];
  traits: ConversationTrait[];
  buyingIntent: "high" | "medium" | "low";
  riskLevel: "high" | "medium" | "low";
  nextAction: string;
  sourceMessageCount: number;
  engine: "rules" | "ai";
  model: string | null;
  promptVersion: string;
  generatedAt: string;
  updatedAt: string;
  error: string | null;
}

export interface ConversationFollowUp {
  id: string;
  conversationId: string;
  analysisId: string;
  sourceKey: string;
  title: string;
  reason: string;
  priority: "high" | "medium" | "normal";
  dueAt: string;
  status: "pending" | "completed" | "dismissed";
  evidenceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AutomationSettings {
  analysisIntervalHours: number;
  intelligenceMode: "rules" | "ai";
  intelligenceProviderId: string | null;
  dailyTodoHour: number;
  dailyTodoMinute: number;
  timezone: string;
  enabled: boolean;
  lastAnalysisAt: string | null;
  nextAnalysisAt: string | null;
  lastDailyTodoAt: string | null;
  nextDailyTodoAt: string | null;
  /**
   * WhatsApp 对话 → CRM 客户跟进自动同步（docs/WHATSAPP-FOLLOWUP-SYNC-DESIGN.md）。
   *
   * **默认关闭**：这条链会往 CRM 的 `customerActivities` 写数据，而那张表同时是
   * 业绩考核里 `followUpCount` 的数据源。默认打开等于替用户改了考核数据。
   * 必须由用户显式开启，并且知道自己在开什么。
   */
  followupSyncEnabled: boolean;
  followupSyncHour: number;
  followupSyncMinute: number;
  lastFollowupSyncAt: string | null;
  nextFollowupSyncAt: string | null;
  lastRunStatus: "idle" | "running" | "success" | "failed";
  lastRunSummary: string;
  updatedAt: string;
}

export type ReadinessStatus = "pass" | "warning" | "blocking";

export interface CommercialReadinessCheck {
  key: string;
  label: string;
  detail: string;
  status: ReadinessStatus;
  actionView: "accounts" | "access" | "ai" | "automation" | "diagnostics" | null;
}

export interface CommercialReadiness {
  readyForMetaRegistration: boolean;
  readyForCommercialUse: boolean;
  checkedAt: string;
  checks: CommercialReadinessCheck[];
}

export type AutomationRunStatus = "running" | "success" | "failed";

export interface AutomationRun {
  id: string;
  ownerUserId: string | null;
  trigger: "scheduled" | "manual";
  status: AutomationRunStatus;
  totalConversations: number;
  processedConversations: number;
  analysisUpdated: number;
  todosCreated: number;
  notificationsSent: number;
  skipped: number;
  currentConversation: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

export interface AutomationRunResult {
  analysisScanned: number;
  analysisUpdated: number;
  todosCreated: number;
  notificationsSent: number;
  skipped: number;
  ranAt: string;
}

export interface AutomationDelivery {
  id: string;
  followupId: string;
  runDate: string;
  deliveryType: "todo" | "notification";
  status: "pending" | "success" | "failed";
  attempts: number;
  externalId: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------- 跟进同步 ----

/** 一条同步明细最终变成了什么。`skipped` 是「有对话但不该写」（纯寒暄 / 已在其他天写过）。 */
export type FollowupSyncItemKind = "customer" | "lead" | "skipped";
export type FollowupSyncItemStatus = "written" | "existing" | "skipped" | "failed";
export type FollowupSyncRunStatus = "running" | "success" | "partial" | "failed";
/**
 * 这一轮的跟进内容由谁补全（2026-10-15 两段式：同步请求只写基础信息，AI 总结走 CRM 后台）：
 * `cli` = 本机 WorkBuddy CLI 后台补全（优先档）；`ai` = CRM 配置的 AI 模型（降级档）；
 * `none` = 本轮没有需要补全的会话（全寒暄走轻互动模板，或空批次）。
 *
 * 历史上还有过 `rules`（把客户最后几条原话拼成摘要）—— 已取消：那等于把客户原话
 * 抄进 CRM，报价与交期会被当成既定承诺。读到旧值一律归成 `none`。
 */
export type FollowupSyncEngine = "cli" | "ai" | "none";

/**
 * 一次同步的运行记录（用户明确要的「同步记录文档」）。
 *
 * 每次同步一行，`UNIQUE(owner_user_id, run_date)` —— 同一天手动重跑是**更新**这一行，
 * 不是新增。否则用户点多两次「立即同步」就会出现三条当天记录，看不出哪条算数。
 */
export interface FollowupSyncRun {
  id: string;
  ownerUserId: string | null;
  runDate: string;
  trigger: "scheduled" | "manual";
  status: FollowupSyncRunStatus;
  timezone: string;
  conversationsScanned: number;
  messageCount: number;
  customersMatched: number;
  activitiesWritten: number;
  leadsCreated: number;
  leadsExisting: number;
  skipped: number;
  ambiguous: number;
  engine: FollowupSyncEngine;
  model: string | null;
  notificationSent: boolean;
  error: string | null;
  summary: string;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

/** 同步明细：每条被处理的会话一行，界面点进记录就看它。 */
export interface FollowupSyncItem {
  id: string;
  runId: string;
  ownerUserId: string | null;
  conversationKey: string;
  contactName: string;
  contactPhone: string;
  kind: FollowupSyncItemKind;
  status: FollowupSyncItemStatus;
  customerId: string | null;
  leadId: string | null;
  activityId: string | null;
  messageCount: number;
  summary: string;
  error: string | null;
  createdAt: string;
}

/** 立即同步 / 定时同步的返回。界面拿它做 toast，也拿它判断要不要刷新记录列表。 */
export interface FollowupSyncRunResult {
  runId: string;
  runDate: string;
  status: FollowupSyncRunStatus;
  conversationsScanned: number;
  messageCount: number;
  customersMatched: number;
  activitiesWritten: number;
  leadsCreated: number;
  leadsExisting: number;
  skipped: number;
  ambiguous: number;
  engine: FollowupSyncEngine;
  notificationSent: boolean;
  summary: string;
  ranAt: string;
}

export type MessageStatus =
  | "queued"
  | "sending"
  | "accepted"
  | "delivered"
  | "read"
  | "failed"
  | "unknown";

export interface Translation {
  id: string;
  messageId: string;
  sourceLanguage: string | null;
  targetLanguage: string;
  profileId: string;
  model: string;
  trigger: "automatic" | "manual";
  status: "pending" | "translated" | "failed";
  translatedText: string | null;
  error: string | null;
  tokenUsage: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  accountId: string;
  conversationId: string;
  providerMessageId: string | null;
  clientMessageId: string | null;
  direction: "inbound" | "outbound";
  messageType: "text" | "image" | "video" | "file" | "audio" | "system";
  body: string;
  status: MessageStatus;
  sourceLanguage: string | null;
  occurredAt: string;
  createdAt: string;
  revokedAt?: string | null;
  media?: MessageMedia | null;
  translations: Translation[];
}

export interface MessageMedia {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  available: boolean;
  expiresAt: string | null;
}

export interface MediaRetentionPolicy {
  mode: "immediate" | "days";
  days: number;
  updatedAt: string;
}

export interface TranslationPreference {
  autoTranslate: boolean;
  targetLanguage: string;
  providerId: string | null;
  crmAutoCreate: boolean;
}

export interface AiProviderProfile {
  id: string;
  name: string;
  kind: "mock" | "openai";
  baseUrl: string | null;
  apiKeyMask: string | null;
  model: string;
  enabled: boolean;
  lastTestStatus: "untested" | "success" | "failed";
  lastTestError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingRule {
  id: string;
  name: string;
  leadType: string;
  region: string;
  preferredAccountId: string;
  fallbackAccountId: string | null;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingResolution {
  rule: RoutingRule | null;
  preferred: ChannelAccount | null;
  fallback: ChannelAccount | null;
  account: ChannelAccount | null;
  selectionReason: "preferred_online" | "fallback_online" | "no_online_account" | null;
}

export interface CrmSandboxContact {
  id: string;
  phone: string;
  name: string;
  source: string;
  sourceContactId: string;
  createdAt: string;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  database: "pglite" | "postgres" | "mysql";
  activeConnections: number;
  timestamp: string;
}

export interface RealtimeEvent<T = unknown> {
  eventId: string;
  eventType: string;
  accountId: string | null;
  occurredAt: string;
  data: T;
}

// ---------------------------------------------------------------------------
// 聊天记录训练（Training）
// ---------------------------------------------------------------------------

export type TrainingExportFormat = "jsonl" | "json" | "txt";

export interface TrainingExportMessage {
  occurredAt: string;
  direction: "inbound" | "outbound";
  body: string;
  messageType: ChatMessage["messageType"];
  /** 训练语言统计要用的来源语言；没有翻译记录时为 null（由检测兜底）。 */
  sourceLanguage: string | null;
}

export interface TrainingExportRecord {
  conversationId: string;
  accountId: string;
  accountName: string;
  contactName: string;
  contactPhone: string;
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messages: TrainingExportMessage[];
}

export interface TrainingExportPreview {
  format: TrainingExportFormat;
  conversationCount: number;
  messageCount: number;
  /** 训练真正用得上的「客户问 → 我方答」配对数量。 */
  exchangeCount: number;
  characters: number;
  fileName: string;
  records: TrainingExportRecord[];
  /** 命中时间/会话过滤前被跳过的会话数，便于用户理解范围。 */
  skippedConversations: number;
}

export interface TrainingStyleSample {
  inbound: string;
  reply: string;
  conversationId: string;
  occurredAt: string;
}

export interface TrainingProfile {
  id: string;
  ownerUserId: string;
  accountId: string | null;
  accountName: string | null;
  name: string;
  status: "ready" | "empty";
  /**
   * `web-import` = 浏览器扩展「归档并学习 → 推送到 CRM」产出的档案。
   * 它的样本来自 WhatsApp Web 页面（不在插件库里），所以单独一个来源标记，
   * 界面与 upsert 逻辑（同名覆盖）都靠它区分。
   *
   * 生成链与跟进同步同一口径（见 curation-engine.ts）：**CLI 托管 → 配置的 AI 模型 →
   * 规则提炼**。`rules` 不是降级失败，是永远可用的确定性兜底（只做统计，不调模型）。
   */
  engine: "rules" | "ai" | "cli" | "web-import";
  model: string | null;
  sampleCount: number;
  exchangeCount: number;
  conversationCount: number;
  messageCount: number;
  languages: string[];
  tone: string;
  summary: string;
  guidelines: string[];
  signaturePhrases: string[];
  guardrails: string[];
  examples: TrainingStyleSample[];
  sourceFrom: string | null;
  sourceTo: string | null;
  error: string | null;
  trainedAt: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 使用回流：自动聊**真正用这份档案生成出回复**的次数（跳过/失败的草稿不计）。
   * 没有它，「CLI 提炼的档案比规则的好不好」只能靠感觉。
   */
  hitCount: number;
  lastHitAt: string | null;
  /** 训练输入指纹：同 owner + 同名 + 同指纹 → 复用上次结果，不再跑模型。 */
  inputFingerprint?: string | null;
}

// ---------------------------------------------------------------------------
// 训练库（Training library）
// ---------------------------------------------------------------------------

/**
 * 训练库条目类型。刻意只做四类——再多就会让「什么情况下用哪条」变得含糊，
 * 而自动回复最怕的就是含糊：
 * - `qa`：标准问答对。规则通道拿它做检索，模型通道把它当参考样本；
 * - `snippet`：口径片段（公司介绍 / MOQ / 交期这类固定说法）。原文进提示词，由模型按客户语言改写；
 * - `policy`：必须遵守的政策，与自动回复护栏合并；
 * - `forbidden`：禁用语 / 红线，命中即拦下、不自动发送。
 */
export type TrainingLibraryKind = "qa" | "snippet" | "policy" | "forbidden";

/** 条目来源：手工录入 / 从训练档案导入 / 从聊天记录导入。 */
export type TrainingLibrarySource = "manual" | "profile" | "conversation";

/**
 * 条目生命周期：
 * - `candidate`：机器导入的候选，**不进提示词**，等人工在训练页确认；
 * - `active`：已确认，参与检索与提示词；
 * - `archived`：已废弃（人工丢弃或清理），保留行以留痕。
 *
 * 存量条目（迁移前就有的 45 条）一律 `active` —— 否则自动回复当晚就没语料了。
 */
export type TrainingLibraryStatus = "candidate" | "active" | "archived";

export interface TrainingLibraryEntry {
  id: string;
  ownerUserId: string;
  /** null = 全部账号通用。 */
  accountId: string | null;
  accountName: string | null;
  /**
   * 归属知识库（CRM 的 `kb_knowledge_bases.id`）。
   *
   * 空串 = **历史条目**（本次改动之前导入的，或 CRM 老批次发布的）：它们没有库的概念，
   * 仍然只对 owner 自己生效，行为与改动前完全一致 —— 不能因为加了这一层就让老语料失效。
   *
   * 有值时，这条语料会出现在「所有把该库放进自己默认清单的账号」的出稿里，
   * 而不只是 owner 自己。这就是「训练成果可以分享给其它账号」的落点。
   */
  kbId: string;
  kind: TrainingLibraryKind;
  question: string;
  answer: string;
  tags: string[];
  languages: string[];
  /** 数字越大越优先（同分时用它打破平局）。 */
  priority: number;
  enabled: boolean;
  status: TrainingLibraryStatus;
  source: TrainingLibrarySource;
  /**
   * 人工校订过：人工录入，或候选池里被人工确认过（`confirm`）。
   *
   * 与 `status==='active'` 的区别很关键：导入后自动变 active 的路径**不存在**，
   * 但「人工确认过的导入条目」与「人工写的条目」在检索层不该同权（P3 分层加权 ×1.0 / ×0.4）。
   * 单靠 status 分不出来，所以必须有这一列。
   */
  verified: boolean;
  hitCount: number;
  /** 历史累计「被采纳」（草稿发出去了）次数。命中≠有用，这个才是功劳簿。 */
  adoptedCount: number;
  /** 最后一次命中时刻（NULL = 从未命中）。用来做「90 天 0 命中」退役判定。 */
  lastHitAt: string | null;
  /** 最后一次被采纳时刻。 */
  lastAdoptedAt: string | null;
  /**
   * 出处三件套（2026-10-16 v21）：发布这条语料时它来自**哪个文件、哪一段、来源说明**。
   * 只服务「人看的出处展示」（引用卡片 / 训练端试问），**不进提示词** —— 描述不是知识内容。
   * 空串 = 历史条目或人工录入，没有这个信息；展示层按空处理。
   */
  sourceTitle: string;
  sourceAnchor: string;
  sourceNote: string;
  createdAt: string;
  updatedAt: string;
}

/** 一句客户消息在训练库里的命中结果。 */
export interface TrainingLibraryMatch {
  entry: TrainingLibraryEntry;
  similarity: number;
  /** 共同特征数：查询侧词典扩展的等价词与原词同权计入（见 text-match.ts 的 expandTokens）。 */
  matched: number;
  /**
   * 具体命中了哪些特征词。**这是「为什么是它」的唯一可核验证据** ——
   * 没有它，界面只能给一个分数，用户无法判断这条命中是词对上了还是纯属运气。
   */
  matchedTerms: string[];
  /** 扩展词命中的条数；>0 说明这条命中含词典等价匹配（verdict 与界面据此说明依据）。 */
  expandedHits?: number;
}

/**
 * 一条「可展开的出处」（citations）。
 *
 * 结构对齐 `docs/KNOWLEDGE-TRAINING-DESIGN.md §6`，但**只实现训练库这一种 sourceType**：
 * 文件 / 会话 / 产品三种来源要等 CRM 训练工作台（P1/P2）把 `source_ref_json` 打通之后才会有。
 * 提前把 union 铺开而实际只有一种，只会让消费方写一堆永不到的分支。
 *
 * 为什么单独一个结构而不是直接把 entry 丢出去：
 * 1. 界面要的是「三层展开」（条目 → 出处 → 原文），不是整个条目对象；
 * 2. `refId` 是**引用校验的锚**（P3 的 `KB_CITE_ENFORCE` 要求草稿回引的 id ⊆ 本次 citations）——
 *    校验必须对着一个稳定字段做，不能依赖某个展示字段恰好没被改写。
 */
export interface TrainingCitation {
  sourceType: "training_library";
  /** 训练库条目 id（回指锚点）。 */
  refId: string;
  kind: TrainingLibraryKind;
  /** 展示标题：问答对用问法，其余用答案首句。 */
  title: string;
  /** 支撑那句话的最小片段（≤200 字）。 */
  snippet: string;
  /** 出处锚点：政策 / 口径片段的章节名（来自 question），问答对为空串。 */
  anchor: string;
  /** 相关度 0–1（问答对用 similarity；口径片段用「命中特征占查询特征的比例」；政策/禁用固定 1）。 */
  score: number;
  /** 命中的词（「为什么是它」）。政策与禁用短语是全量注入，没有命中词，给空数组。 */
  hitTerms: string[];
  /** 人工校订过（人工录入 或 候选池里被确认）——P3 分层加权用它，不是展示字段。 */
  verified: boolean;
  /** 该条历史累计被采纳次数（回流数据；>0 说明这条的回复真被发出去过）。 */
  adopted: boolean;
  /** 该条历史累计命中次数。 */
  hitCount: number;
  /**
   * 训练来源三件套（2026-10-16 v21，可选 = 老条目没有）：推荐/引用时注明「哪个文件、哪一段」。
   * 有 sourceTitle 时展示层应优先给出「《文件》§段落」—— 用户认文件比认答案首句容易。
   */
  sourceTitle?: string;
  sourceAnchor?: string;
  sourceNote?: string;
}

export interface TrainingLibraryMatchResult {
  query: string;
  /** 命中的问答对，按相似度倒序。 */
  hits: TrainingLibraryMatch[];
  /** 会一并进提示词的口径片段。 */
  snippets: TrainingLibraryEntry[];
  /** 会并入护栏的政策条目。 */
  policies: TrainingLibraryEntry[];
  /** 命中的禁用语条目（**客户这句话**踩到禁用语场景，命中就该转人工）。 */
  forbidden: TrainingLibraryMatch[];
  /** 全部启用中的禁用短语：用来检查「生成的回复里有没有出现禁用语」。 */
  forbiddenPhrases: string[];
  /**
   * 本次检索的**全部出处**（四类合一），按「是不是主依据 → 分数」倒序。
   * 界面点「来源」看到的就是它；P3 的引用校验也以它的 `refId` 集合为准。
   */
  citations: TrainingCitation[];
  /** 结论文案，界面直接展示。 */
  verdict: string;
  /** 口径片段被相关度筛选 / 政策超上限等提示（无问题时不返回）。 */
  warnings?: string[];
  /**
   * 知识库清单对本次检索的影响。
   *
   * 为什么必须返回：用户「明明有这个知识库却没命中」时，唯一能解释的就是这里 ——
   * 是被清单挡掉的，还是根本没进语料。没有它，停用/启用知识库的效果只能靠猜。
   */
  kbScope?: {
    /** 该账号是否配置过启用清单。false = 从未配置 → 按「自己的语料全用」的兼容口径走。 */
    configured: boolean;
    /** 本次生效的知识库 id（未配置时为空，但历史与自有语料仍生效）。 */
    enabledKbIds: string[];
    /** 实际参与本次检索的语料条数。 */
    considered: number;
    /** 因不在启用清单里而被挡掉的条数；>0 必须让用户看见。 */
    skippedByScope: number;
  };
}

export interface TrainingLibraryImportResult {
  created: number;
  skipped: number;
  total: number;
  /**
   * 本次导入新建的候选条目 id。
   * 导入 = 进候选池（`candidate`，不进提示词），前端拿这批 id 直接跳到「候选确认」区，
   * 让「机器做减法、人做加法」这条闸门有个明确的下一步。
   */
  candidateIds: string[];
}

// ---------------------------------------------------------------------------
// 自动聊（Auto chat）
// ---------------------------------------------------------------------------

export type AutoChatMode = "off" | "draft" | "auto";

/**
 * 自动回复的生成引擎。
 * - `auto`：有配置 AI Provider 就用它，否则本机 CLI 可用就用 CLI，都不行退到训练话术库；
 * - `rules`：只用训练话术库检索，不调用任何模型；
 * - `ai`：调用已配置的 OpenAI 兼容 Provider；
 * - `cli`：调用本机 WorkBuddy CLI（CodeBuddy），不需要任何 API Key。
 */
export type AutoChatEngine = "auto" | "rules" | "ai" | "cli";

/** 真正落到某条草稿上的引擎（`auto` 会被解析成这三者之一）。 */
export type AutoChatDraftEngine = "rules" | "ai" | "cli";

export interface AutoChatSettings {
  id: string;
  ownerUserId: string;
  accountId: string | null;
  enabled: boolean;
  mode: AutoChatMode;
  engine: AutoChatEngine;
  profileId: string | null;
  providerId: string | null;
  /** CLI 引擎的模型；空串 = 跟随 CLI 默认（由当前登录账号决定，跨账号不一致）。 */
  cliModel: string;
  /** CLI 引擎的思考档位；空串 = 跟随 CLI 默认。 */
  cliEffort: string;
  language: string;
  tone: string;
  dailyLimit: number;
  minIntervalMinutes: number;
  activeHoursStart: number;
  activeHoursEnd: number;
  timezone: string;
  escalateKeywords: string[];
  guardrails: string[];
  /** 自动发送前的置信度门槛（0-1），仅 auto 模式生效。 */
  confidenceThreshold: number;
  lastRunAt: string | null;
  updatedAt: string;
}

export type AutoChatDraftStatus = "pending" | "sending" | "sent" | "dismissed" | "failed" | "skipped";

export interface AutoChatDraft {
  id: string;
  ownerUserId: string;
  accountId: string;
  conversationId: string;
  contactName: string;
  contactPhone: string;
  inboundMessageId: string | null;
  inboundBody: string;
  body: string;
  edited: boolean;
  status: AutoChatDraftStatus;
  mode: AutoChatMode;
  confidence: number;
  reason: string;
  engine: AutoChatDraftEngine;
  model: string | null;
  profileId: string | null;
  messageId: string | null;
  error: string | null;
  /**
   * 生成这条草稿时用到的训练库条目 id（不超过 20 个）。
   *
   * 为什么要存在草稿行上：**「采纳」这个信号只在这一行发出时才知道**，
   * 而那时早就离开了生成现场。不存下来，`adopted_count` 就永远没有数据来源
   * （历史上 `hit_count` 一直偏低就是这个原因）。
   */
  libraryEntryIds: string[];
  createdAt: string;
  sentAt: string | null;
  updatedAt: string;
}

export interface AutoChatRunSummary {
  scanned: number;
  drafted: number;
  sent: number;
  skipped: number;
  failed: number;
  reasons: string[];
}

/**
 * 本机 CLI 引擎的健康状态（只读，由插件探测得到）。
 * `reason` 区分「本机没装」（安静）与「装了起不来」（故障，必须让用户看见）。
 */
export interface CliEngineStatus {
  available: boolean;
  binary: string;
  version: string;
  reason: string;
  defaultModel: string;
  models: string[];
  efforts: string[];
  /** 传给 CLI 的技能扫描目录；空串表示没找到任何技能目录（技能会静默不生效）。 */
  skillsDirs: string;
  /** 该目录里实际扫到的技能名（目录名），用于界面上确认技能真的装上了。 */
  skills: string[];
  /** 自动回复依赖的技能名；不在 `skills` 里就说明当前是「降级运行」。 */
  autoReplySkill: string;
  /** 资料挑选（资源推荐复排）依赖的技能名；同样不在 `skills` 里就是降级运行。 */
  resourceScoutSkill: string;
}
