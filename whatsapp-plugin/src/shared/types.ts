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
   * 界面与 upsert 逻辑（同名覆盖）都靠它区分，不与 rules/ai 混淆。
   */
  engine: "rules" | "ai" | "web-import";
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

export interface TrainingLibraryEntry {
  id: string;
  ownerUserId: string;
  /** null = 全部账号通用。 */
  accountId: string | null;
  accountName: string | null;
  kind: TrainingLibraryKind;
  question: string;
  answer: string;
  tags: string[];
  languages: string[];
  /** 数字越大越优先（同分时用它打破平局）。 */
  priority: number;
  enabled: boolean;
  source: TrainingLibrarySource;
  hitCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 一句客户消息在训练库里的命中结果。 */
export interface TrainingLibraryMatch {
  entry: TrainingLibraryEntry;
  similarity: number;
  /** 共同特征数：查询侧词典扩展的等价词与原词同权计入（见 text-match.ts 的 expandTokens）。 */
  matched: number;
  /** 扩展词命中的条数；>0 说明这条命中含词典等价匹配（verdict 与界面据此说明依据）。 */
  expandedHits?: number;
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
  /** 结论文案，界面直接展示。 */
  verdict: string;
}

export interface TrainingLibraryImportResult {
  created: number;
  skipped: number;
  total: number;
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
