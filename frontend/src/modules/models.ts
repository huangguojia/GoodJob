/**
 * 接口与类型定义。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */

export type Role = "sales" | "manager" | "admin" | "super_admin";
export type DashboardPeriod = "today" | "week" | "month";
// 工作台后台自动刷新间隔。每次刷新拉取汇总、待办和完整客户列表，打开工作台的人越多后端压力越大；
// 回到工作台、窗口重新获得焦点或标签页重新可见时会立即刷新（见 prototype-api.ts），所以放宽到 30 秒不影响看到的新鲜度。
export const DASHBOARD_LIVE_REFRESH_MS = 30_000;
export const EXCHANGE_RATE_REFRESH_MS = 15 * 60 * 1000;

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  expiresAt?: string;
  expired?: boolean;
  daysLeft?: number | null;
  iamRoleNames?: string[];
  iamSource?: "iam" | "legacy_compatibility" | "platform";
  iamPermissions?: Record<string, string[]>;
  teamId: string;
  avatar: string;
  outboundEmail?: string;
  emailSenderName?: string;
  emailSignature?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  hasSmtpPassword?: boolean;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  imapUser?: string;
  hasImapPassword?: boolean;
  inboundSyncEnabled?: boolean;
  lastInboundSyncAt?: string;
  lastInboundSyncStatus?: "ok" | "error" | "";
  lastInboundSyncError?: string;
  lastDevelopmentEmailAt?: string;
  lastDevelopmentEmailTo?: string;
  lastDevelopmentEmailSubject?: string;
  theme?: string;
}

interface ExchangeRateItem {
  pair: string;
  value: number;
  decimals: number;
}

export interface TodayExchangeRates {
  date: string;
  rates: ExchangeRateItem[];
  source: string;
  fetchedAt: string;
}

export type AccessControlPage = "members" | "organization" | "roles" | "ui" | "authorization" | "audit";
export type AccessControlScope = "none" | "self" | "org_unit" | "org_subtree" | "tenant" | "public_pool" | "platform";

export interface AccessControlOverview {
  foundation: {
    schemaVersion: string;
    mode: "legacy_compatibility" | "iam";
    permissionCount: number;
  };
  companies: Array<{ id: string; name: string; memberCount: number }>;
  company: { id: string; name: string } | null;
  metrics: {
    memberCount: number;
    activeMemberCount: number;
    roleCount: number;
    organizationUnitCount: number;
    unassignedMemberCount: number;
  } | null;
  organizationUnits: Array<{
    id: string;
    parentId: string;
    name: string;
    type: "company" | "department" | "team" | "unassigned";
    memberCount: number;
    status?: "active" | "disabled";
    code?: string;
  }>;
  roles: Array<{
    id: string;
    code: string;
    name: string;
    summary?: string;
    description?: string;
    memberCount: number;
    permissionCount: number;
    moduleCount: number;
    source: string;
    status?: "draft" | "active" | "disabled";
    is_protected?: boolean;
  }>;
  permissions: Array<{
    code: string;
    module: string;
    name: string;
    riskLevel: "normal" | "sensitive" | "high" | "critical";
    scopeModes?: AccessControlScope[];
    introducedVersion?: string;
    grants: Record<string, AccessControlScope>;
    protectedScopes?: Record<string, AccessControlScope>;
  }>;
  members: Array<{
    id: string;
    membershipId?: string;
    name: string;
    email: string;
    avatar: string;
    status: "active" | "disabled";
    roleId: string;
    roleCode: string;
    roleName: string;
    employeeNo?: string;
    title?: string;
    organizationUnitId: string;
    organizationUnitName: string;
    roleIds?: string[];
    temporaryGrants?: Array<{ id: string; permissionCode: string; scopeMode: AccessControlScope; validUntil: string; reason: string }>;
  }>;
}

export interface AccessAuditEvent {
  id: string;
  actorIdentityId: string;
  targetType: string;
  targetId: string;
  actionCode: string;
  impactSummary: string;
  resultStatus: string;
  createdAt: string;
}

export interface IamCapabilitySnapshot {
  schemaVersion: string;
  tenantId: string;
  membershipId: string;
  revision: string;
  source: "iam" | "legacy_compatibility" | "platform";
  permissions: Record<string, Array<"self" | "org_unit" | "org_subtree" | "tenant" | "public_pool">>;
  roleNames: string[];
  generatedAt: string;
}

export interface PlatformTenant {
  id: string;
  code: string;
  name: string;
  status: "trial" | "active" | "suspended" | "closed";
  planCode: string;
  seatLimit: number;
  memberCount: number;
  activeMemberCount: number;
  authorizationRevision: number;
  trialExpiresAt: string;
  createdAt: string;
}

export interface PlatformSupportRequest {
  id: string;
  tenantId: string;
  tenantName: string;
  ticketNo: string;
  reason: string;
  permissionCodes: string[];
  requestedMinutes: number;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  requestedByUserId: string;
  reviewedByUserId: string;
  reviewNote: string;
  createdAt: string;
  expiresAt: string;
  session: null | { id: string; status: "active" | "expired" | "terminated"; accessCount: number; startedAt: string; expiresAt: string };
}

export interface PlatformOperator {
  id: string;
  userId: string;
  name: string;
  email: string;
  status: string;
  mfaRequired: boolean;
  roleNames: string;
  updatedAt: string;
}

export interface PlatformAuditEvent {
  id: string;
  actionCode: string;
  targetType: string;
  targetId: string;
  tenantId: string;
  resultStatus: string;
  reason: string;
  requestId: string;
  actorName: string;
  createdAt: string;
}

export interface ApprovalWorkflow {
  id: string;
  code: string;
  name: string;
  businessType: string;
  status: "draft" | "active" | "disabled";
  currentVersionId: string;
  draftVersionId?: string;
  versionNo: number;
  allowParallel: boolean;
  priority?: number;
  isDefault?: boolean;
  triggerConfig?: Record<string, unknown>;
  formSchema?: Record<string, unknown>;
  nodeCount?: number;
  createdAt: string;
  updatedAt: string;
  nodes?: ApprovalWorkflowNode[];
  edges?: ApprovalWorkflowEdge[];
}

export type ApprovalWorkflowNodeType = "start" | "approval" | "condition" | "cc" | "automation" | "end";
export interface ApprovalWorkflowNode {
  id: string;
  type: ApprovalWorkflowNodeType;
  name: string;
  position: { x: number; y: number };
  approverStrategy: "specific_member" | "role_in_tenant" | "requester_manager" | "permission_holder";
  approverConfig: Record<string, unknown>;
  approvalMode: "single" | "all" | "any";
  config: Record<string, unknown>;
  sortOrder: number;
}
export interface ApprovalWorkflowEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  priority: number;
  condition?: { field: string; operator: "equals" | "not_equals" | "greater_than" | "greater_or_equal" | "less_than" | "less_or_equal" | "contains" | "in" | "exists"; value?: unknown };
}

export interface ApprovalInstance {
  id: string;
  workflowId: string;
  workflowName: string;
  businessType: string;
  businessId: string;
  title: string;
  summary: string;
  status: "draft" | "running" | "approved" | "rejected" | "withdrawn" | "cancelled" | "failed";
  version: number;
  applicantName: string;
  applicantMembershipId: string;
  submittedAt: string;
  completedAt: string;
  updatedAt: string;
}

export interface ApprovalTask {
  id: string;
  instance_id?: string;
  instanceId?: string;
  node_name?: string;
  title: string;
  summary: string;
  business_type?: string;
  business_id?: string;
  applicant_name?: string;
  status: string;
  version_no?: number;
  submitted_at?: string;
}

export interface ApprovalAction {
  id: string;
  action_type: string;
  actor_name: string;
  comment_text: string;
  created_at: string;
}

export interface Customer {
  id: string;
  company: string;
  companyFullName?: string;
  country: string;
  contact: string;
  whatsapp?: string;
  wechat?: string;
  otherNotes?: string;
  stage: string;
  amount: number;
  health: number;
  source?: string;
  grade?: "A" | "B" | "C" | "D";
  nextReminder: string;
  wecomBound: boolean;
  billingName?: string;
  billingAddress?: string;
  documentContact?: string;
  contactRemark?: string;
  phone?: string;
  email?: string;
  website?: string;
  defaultPortDischarge?: string;
  defaultIncoterm?: string;
  defaultPaymentTerm?: string;
  pipelineStage?: string;
  pipelineAmount?: number;
  activeDealCount?: number;
  ownerId?: string;
  ownerName?: string;
  activities?: CustomerActivity[];
  lastActivityAt?: string;
  pendingIntelligence?: CustomerIntelligenceSuggestion[];
  pendingIntelligenceCount?: number;
  hasWonDeal?: boolean;
  lifecycleStatus?: "open" | "won";
  wonDealCount?: number;
  wonDealAmount?: number;
  lastWonAt?: string;
  whatsappPhone?: string;
  poolStatus?: "owned" | "public";
  previousOwnerName?: string;
  releasedByName?: string;
  releasedAt?: string;
  releaseReason?: string;
  claimedAt?: string;
  ownershipVersion?: number;
}

export type CustomerIntelligenceFieldKey =
  | "company"
  | "country"
  | "contact"
  | "documentContact";

interface CustomerIntelligenceField {
  key: CustomerIntelligenceFieldKey;
  label: string;
  currentValue: string;
  suggestedValue: string;
  evidenceSummary: string;
}

interface CustomerIntelligenceSuggestion {
  id: string;
  sourceLabel: string;
  sourceUrl: string;
  suggestedFields: CustomerIntelligenceField[];
  website: string;
  business: string;
  contactInfo: string;
  evidenceSummary: string;
  evidenceRefs: string[];
  createdAt: string;
}

export type BackgroundResearchEntity = "lead" | "customer";

export interface BackgroundResearch {
  id: string;
  entityType: BackgroundResearchEntity;
  entityId: string;
  company: string;
  country: string;
  score: number;
  verdict: string;
  summary: string;
  facts: Array<{ label: string; value: string; group?: string; sourceUrl?: string; sourceTitle?: string }>;
  opportunities: string[];
  talkTracks?: string[];
  risks: Array<{ level: "high" | "medium" | "low"; title: string; detail: string }>;
  contacts: Array<{ channel: string; value: string }>;
  sources: Array<{ title: string; url: string; observedAt: string; detail?: string; authority?: string }>;
  sourceChecks?: Array<{ providerId: string; providerName: string; status: "matched" | "empty" | "failed" | "skipped"; matchCount: number; message: string }>;
  nextAction: string;
  engine: string;
  scoreReason?: string;
  crmOnly?: boolean;
  completedAt: string;
}

export interface SalesDistillationMetrics {
  customerCount: number;
  leadCount: number;
  activeDealCount: number;
  wonDealCount: number;
  wonAmount: number;
  followupCount: number;
  completedTodoCount: number;
  reportCount: number;
}

export interface SalesDistillation {
  id: string;
  sourceUserId: string;
  sourceUserName: string;
  teamId: string;
  periodDays: number;
  metrics: SalesDistillationMetrics;
  patterns: string[];
  playbook: Array<{ stage: string; action: string; evidence: string }>;
  coachingActions: string[];
  modelLabel: string;
  status: "draft" | "published";
  createdBy: string;
  createdAt: string;
  publishedBy?: string;
  publishedAt?: string;
  trainingRunId?: string;
  version?: number;
  maturity?: SalesTrainingMaturity;
  evaluationScore?: number;
  sampleCount?: number;
}

export type SalesTrainingStatus = "queued" | "collecting" | "cleaning" | "labeling" | "training" | "evaluating" | "awaiting_review" | "published" | "paused" | "failed" | "cancelled";
export type SalesTrainingMaturity = "observation" | "trial" | "production" | "stable";
export type SalesTrainingSampleLabel = "positive" | "negative" | "neutral";
export interface SalesTrainingRun {
  id: string;
  sourceUserId: string;
  sourceUserName: string;
  teamId: string;
  createdBy: string;
  parentRunId: string;
  version: number;
  periodDays: number;
  status: SalesTrainingStatus;
  resumeStatus: SalesTrainingStatus;
  progress: number;
  currentAction: string;
  maturity: SalesTrainingMaturity;
  metrics: SalesDistillationMetrics;
  sampleStats: { source: number; valid: number; rejected: number; positive: number; negative: number; neutral: number; holdout: number };
  samples: Array<{ id: string; entityType: "customer" | "lead" | "deal"; entityId: string; title: string; market: string; stage: string; outcome: string; label: SalesTrainingSampleLabel; included: boolean; activityCount: number; todoCount: number; evidenceIds: string[]; summary: string; managerNote: string }>;
  rounds: Array<{ id: string; index: number; name: string; status: "pending" | "running" | "completed" | "failed"; summary: string; startedAt: string; completedAt: string }>;
  events: Array<{ id: string; stage: SalesTrainingStatus; message: string; createdAt: string }>;
  patterns: string[];
  playbook: Array<{ stage: string; action: string; evidence: string }>;
  coachingActions: string[];
  evaluation: { coverage: number; balance: number; traceability: number; strategy: number; safety: number; overall: number; passed: boolean; blockers: string[] };
  modelLabel: string;
  candidateDistillationId: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  publishedAt: string;
}

export interface SalesPlaybookActivation {
  id: string;
  distillationId: string;
  ownerId: string;
  teamId: string;
  status: "active" | "paused";
  applicationCount: number;
  taskCount: number;
  lastUsedAt: string;
  activatedAt: string;
  updatedAt: string;
}

export interface SalesDistillationSource {
  id: string;
  name: string;
  role: Role;
  teamId: string;
}

export interface CompanyProfile {
  teamId: string;
  companyName: string;
  website: string;
  productSummary: string;
  address: string;
  phone: string;
  email: string;
  updatedBy: string;
  updatedAt: string;
}

export interface TeamSystemSettings {
  teamId: string;
  requireDocumentExcelApproval: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface TradeDocumentOcrProviderConfig {
  provider: "none" | "baidu" | "siliconflow";
  enabled: boolean;
  hasApiKey: boolean;
  hasSecretKey: boolean;
  model: string;
  baseUrl: string;
}

/**
 * AI 执行来源（引擎）：背调 / 开发信都可以选「谁来干」。
 * CRM 在这里只是稳定框架——准备事实、冻结提示词、留档结果、做质量自检。
 */
export type ResearchEngineSource = "crm" | "ai" | "cli";
export type EmailEngineSource = "template" | "ai" | "cli";
type AiEngineAdapter = "workbuddy" | "codex";

export interface TeamAiEngineSettings {
  teamId: string;
  researchSource: ResearchEngineSource;
  emailSource: EmailEngineSource;
  cliAdapter: AiEngineAdapter;
  /** 走 CLI 时用的模型；留空 = 跟随 CLI 默认（由 CLI 当前登录账号决定，会随账号变化） */
  cliModel: string;
  /** 走 CLI 时的思考档位；留空 = 跟随 CLI 默认 */
  cliEffort: string;
  /** 选用 Codex CLI 时的模型（Codex 自己的命名，出厂默认 gpt-5.6-sol；留空 = 跟随本机 ~/.codex/config.toml） */
  codexModel?: string;
  /** 选用 Codex CLI 时的思考档位（minimal / low / medium / high；留空 = 跟随 Codex 默认） */
  codexEffort?: string;
  cliWorkspace: string;
  cliTimeoutSeconds: number;
  runnerId: string;
  updatedBy: string;
  updatedAt: string;
}

/** 后端给的 CLI 模型清单（单一真源，前端不再硬编码） */
export interface AiEngineCliModelOption {
  id: string;
  label: string;
  note: string;
}

export interface AiEngineRunnerSummary {
  id: string;
  displayName: string;
  ownerId: string;
  online: boolean;
  capabilities: string[];
  workspaces: string[];
  workbuddyVersion: string;
  codexVersion: string;
}

export interface AiEngineJobView {
  id: string;
  kind: "research" | "email";
  entityType: string;
  entityId: string;
  source: string;
  adapter: AiEngineAdapter | "";
  adapterLabel: string;
  runnerId: string;
  cliTaskId: string;
  status: "running" | "succeeded" | "failed";
  engine: string;
  errorMessage: string;
  createdAt: string;
  finishedAt: string;
}

export interface DevelopmentEmailDraft {
  entityType: BackgroundResearchEntity;
  entityId: string;
  recipientCompany: string;
  recipientName: string;
  to: string;
  subject: string;
  body: string;
  from: string;
  senderName: string;
  engine: string;
}

export type DevelopmentEmailScenario = "first_touch" | "daily_contact" | "holiday_greeting" | "new_product" | "custom_goal";

export interface DevelopmentEmailReadiness {
  personalReady: boolean;
  companyReady: boolean;
  personalMissing: string[];
  companyMissing: string[];
  aiReady: boolean;
  aiGenerated: boolean;
  aiConfigName: string;
  aiError: string;
}

/** 开发信技能：这封信当前阶段的写作策略（后端推导，不落库） */
export interface DevelopmentEmailStageInfo {
  key: string;
  label: string;
  objective: string;
  angle: string;
  cta: string;
  maxWords: number;
  /** 这一阶段按设计要不要用背调；老后端没有这个字段 → 按"要用"处理 */
  personalizes?: boolean;
  nextStepLabel: string;
  canSend: boolean;
  blockReason: string;
}

/** 一条「为什么这么写」的依据（后端按最终正文校准后给出） */
interface DevelopmentEmailReasonInfo {
  part: string;
  /** 这一段的实际写法（主题原文 / 正文摘录；空串 = 这封没有这一段） */
  text: string;
  why: string;
  /** true = 这不是"依据"，而是"这封没写好"的如实说明 */
  weak?: boolean;
}

/** 开发信技能：这封信的依据（背调 / 收件人角色 / 缺什么） */
interface DevelopmentEmailPersonalizationInfo {
  hook: string;
  relevance: string;
  subjectAngle: string;
  ask: string;
  factsUsed: Array<{ label: string; value: string }>;
  angles: string[];
  trace: string[];
  difference: string;
  /** 逐段说明「为什么这么写」；老后端可能没有这个字段 */
  reasons?: DevelopmentEmailReasonInfo[];
  personalized: boolean;
}

export interface DevelopmentEmailBriefInfo {
  role: { key: string; label: string; authority: string; emphasis: string };
  evidence: string[];
  missing: string[];
  angles: Array<{ keyword: string; angle: string; short?: string }>;
  /** 个性化依据（逐条「为什么这么写」）；老后端可能没有这个字段，渲染时按可空处理 */
  personalization?: DevelopmentEmailPersonalizationInfo;
  researchUsed: boolean;
  researchId: string;
  researchScore: number | null;
  researchCreatedAt: string;
  researchEngine: string;
  researchVerdict: string;
}

export interface DevelopmentEmailQuality {
  ok: boolean;
  issues: string[];
  /** 正文是否真的引用了背调（后端判定，不靠猜） */
  researchUsed?: boolean;
  researchSignals?: string[];
}

interface CustomerActivity {
  id: string;
  customerId: string;
  type: string;
  content: string;
  operatorId: string;
  operatorName?: string;
  nextReminder: string;
  createdAt: string;
}

export interface Todo {
  id: string;
  title: string;
  type: string;
  priority: string;
  status?: string;
  pinState?: string;
  sortOrder?: number;
  dueAt: string;
  related: string;
  done: boolean;
  impactAmount?: number;
  createdAt?: string;
  historyAt?: string;
  customerId?: string;
  dealId?: string;
  reminderRuleId?: string;
  triggerKey?: string;
  snoozedFrom?: string;
  snoozeReason?: string;
  snoozeCount?: number;
  snoozedBy?: string;
  completedAt?: string;
  completedBy?: string;
  completionResult?: string;
  leadId?: string;
  prospectCandidateId?: string;
  tenantProspectId?: string;
  outreachChannel?: ProspectOutreachChannel;
  touchpointId?: string;
  cancelledAt?: string;
  cancellationReason?: string;
}

export interface DealItem {
  id: string;
  productId?: string;
  product: string;
  model?: string;
  quantity: number;
  unitPrice: number;
}

export interface Deal {
  id: string;
  customerId: string;
  title: string;
  stage: string;
  product?: string;
  quantity?: number;
  unitPrice?: number;
  items?: DealItem[];
  amount: number;
  currency: string;
  amountType: "estimate" | "quoted" | "won";
  nextAction: string;
  nextActionAt: string;
  expectedCloseAt: string;
  stageChangedAt: string;
  closedAt?: string;
  /** 成交自动建单后回写的订单 id：商机详情据此提供「查看订单」入口。 */
  orderId?: string;
  wonReason?: string;
  lostReason?: string;
  lostReasonCategory?: string;
  revisitAt?: string;
  archivedAt?: string;
}

export interface DealEvent {
  id: string;
  dealId: string;
  type: string;
  content: string;
  operatorId: string;
  operatorName?: string;
  fromStage?: string;
  toStage?: string;
  nextAction?: string;
  nextActionAt?: string;
  relatedDocumentId?: string;
  createdAt: string;
}

export interface Reminder {
  id: string;
  title: string;
  rule: string;
  dueAt: string;
  channel: string;
  status: string;
  ruleType?: string;
  targetStage?: string;
  days?: number;
  timeUnit?: "minute" | "day" | "hour" | "week";
  targetCustomerIds?: string[];
  /** 是否在待办中心生成待办（表单里的「生成待办中心任务」勾选项）。不勾 = 只匹配统计，不产生待办。 */
  generateTodo?: boolean;
  /** 最近一次运行「为什么没生成」的原因聚合（后端 lastSkipReasons），用于在卡片上直接说明跳过原因。 */
  lastSkipReasons?: Array<{ reason: "generate-disabled" | "active-todo" | "cooldown"; count: number; customers?: string[] }>;
  priority?: "high" | "medium" | "normal";
  enabled?: boolean;
  generatedCount?: number;
  targetOwnerId?: string;
  lastRunBy?: string;
  lastRunAt?: string;
  lastMatchedCount?: number;
  lastCreatedCount?: number;
  lastSkippedCount?: number;
  lastFailedCount?: number;
  lastError?: string;
}

export interface ImportExportJob {
  id: string;
  name: string;
  type: string;
  rows: number;
  status: string;
  createdAt: string;
}

export interface TradeDocumentItem {
  id: string;
  lineType?: "product" | "shipping_cost";
  productId?: string;
  imageUrl?: string;
  product: string;
  model: string;
  material?: string;
  finish?: string;
  hsCode: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  originCountry: string;
  weightKg: number;
  packageCount: number;
  brand?: string;
  brandType?: string;
  exportBenefit?: string;
  inspectionCode?: string;
  productEnglish?: string;
}

interface TradeDocumentImportEvidence {
  field: string;
  value: string;
  source: string;
  confidence: number;
}

export interface TradeDocumentImportDraft {
  customerId: string;
  dealId: string;
  type: TradeDocument["type"];
  title: string;
  number: string;
  issueDate: string;
  buyer: string;
  buyerAddress: string;
  buyerContact: string;
  seller: string;
  sellerAddress: string;
  currency: string;
  incoterm: string;
  paymentTerm: string;
  shippingMethod: string;
  portLoading: string;
  portDischarge: string;
  validityDate: string;
  bankInfo: string;
  notes: string;
  language: TradeDocument["language"];
  templateStyle: TradeDocument["templateStyle"];
  items: TradeDocumentItem[];
}

export interface TradeDocumentImportAnalysis {
  id: string;
  sourceFileName: string;
  sourceMime: string;
  sourceSha256: string;
  sourceSize: number;
  status: "needs_review" | "confirmed" | "failed";
  detectedType: TradeDocument["type"];
  confidence: number;
  extractedDocument: TradeDocumentImportDraft;
  fieldEvidence: TradeDocumentImportEvidence[];
  warnings: string[];
  sourcePreview: string[];
  calculatedTotal: number;
  declaredTotal?: number;
  totalDifference?: number;
  recognitionSource?: "import" | "ocr";
  recognitionTemplate?: {
    templateId: string;
    familyId: string;
    name: string;
    version: number;
    matchScore: number;
    matchedAt: string;
  };
  createdDocumentId?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TradeDocumentRecognitionTemplate {
  id: string;
  familyId: string;
  version: number;
  name: string;
  documentType: TradeDocument["type"];
  sourceKind: "import" | "ocr";
  status: "active" | "archived";
  createdBy: string;
  createdAt: string;
  archivedAt?: string;
}

export interface CustomsDocument {
  id: string;
  customerId: string;
  dealId: string;
  tradeDocumentId?: string;
  number: string;
  issueDate: string;
  shipper: string;
  shipperAddress: string;
  shipperTaxNo: string;
  consignee: string;
  consigneeAddress: string;
  manufacturer: string;
  manufacturerTaxNo: string;
  transportMode: string;
  vesselName: string;
  exitPort: string;
  exitDate: string;
  tradeMode: string;
  supervisionMode: string;
  tradeCountry: string;
  destinationCountry: string;
  packageType: string;
  packageCount: number;
  grossWeight: number;
  netWeight: number;
  tradeMethod: string;
  contractNo: string;
  currency: string;
  incoterm: string;
  paymentTerm: string;
  notes: string;
  status: "draft" | "ready" | "exported";
  ownerId: string;
  teamId: string;
  updatedAt: string;
  items: TradeDocumentItem[];
}

export interface CustomsGenerationSource {
  type: "trade_document" | "deal";
  label: string;
}

export interface TradeDocumentAudit {
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  operatorId: string;
  operatorName: string;
  createdAt: string;
}

export interface TradeDocumentSendRecord {
  id: string;
  channel: "email" | "whatsapp" | "wechat" | "manual";
  recipient: string;
  message: string;
  operatorId: string;
  operatorName: string;
  createdAt: string;
}

export interface TradeDocument {
  id: string;
  customerId: string;
  dealId: string;
  revision: number;
  derivedFromDocumentId?: string;
  derivedFromType?: TradeDocument["type"];
  importAnalysisId?: string;
  importSourceFileName?: string;
  importSourceSha256?: string;
  type: "PI" | "CI" | "PO" | "CUSTOMS" | "PL" | "CONTRACT" | "QUOTATION" | "COO" | "SHIPPING";
  title: string;
  number: string;
  issueDate: string;
  buyer: string;
  buyerAddress: string;
  buyerContact: string;
  seller: string;
  brandMarkText?: string;
  sellerAddress: string;
  sellerContact?: string;
  sellerPhone?: string;
  sellerEmail?: string;
  sellerWebsite?: string;
  sellerTaxNo?: string;
  currency: string;
  incoterm: string;
  paymentTerm: string;
  shippingMethod: string;
  portLoading: string;
  portDischarge: string;
  validityDate: string;
  bankInfo: string;
  notes: string;
  language: "EN" | "ES" | "RU" | "AR" | "ZH";
  templateStyle: "executive" | "classic" | "compact" | "indigo" | "emerald" | "rose" | "slate" | "amber" | "longtec" | "custom-b";
  status: "draft" | "ready" | "pending_approval" | "approved" | "rejected" | "exported";
  approvalNote?: string;
  approvedAt?: string;
  approvedBy?: string;
  audits: TradeDocumentAudit[];
  sendRecords: TradeDocumentSendRecord[];
  letterheadId?: string;
  stampId?: string;
  signatureId?: string;
  includeProductImages?: boolean;
  letterheadSnapshot?: DocumentLetterheadSnapshot;
  stampSnapshot?: DocumentStampSnapshot;
  signatureSnapshot?: DocumentSignatureSnapshot;
  ownerId?: string;
  teamId?: string;
  updatedAt: string;
  items: TradeDocumentItem[];
}

export interface DocumentLetterheadSnapshot {
  name: string;
  companyName: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  bankInfo: string;
  contact: string;
  taxNo: string;
  logoUrl: string;
  logoPlacement?: DocumentAssetPlacement;
  /** 按「模板风格:单据类型」分开记的 Logo 位置与大小（如 custom-b:PI） */
  logoPlacements?: DocumentLogoPlacements;
}

interface DocumentStampSnapshot {
  name: string;
  imageUrl: string;
  placement?: DocumentAssetPlacement;
}

export interface DocumentAssetPlacement {
  horizontal: "template" | "left" | "center" | "right";
  vertical: "template" | "top" | "middle" | "bottom";
  offsetX: number;
  offsetY: number;
  scale: number;
}

/** 键是「模板风格:单据类型」，如 custom-b:PI、custom-b:PO */
export type DocumentLogoPlacements = Record<string, DocumentAssetPlacement>;

/** 卖方公司 Logo 调节器里可单独记一套位置与大小的模板（第一个是默认打开的页签） */
export const DOCUMENT_LOGO_TEMPLATE_SLOTS: Array<{ key: string; label: string; hint: string; excel?: boolean }> = [
  { key: "custom-b:PI", label: "定制B · PI", hint: "定制B 的 PI 版式：Logo 在右上角，位移以右上角为原点", excel: false },
  { key: "custom-b:PO", label: "定制B · PO", hint: "定制B 的 PO 版式：Logo 在左上角，位移以左上角为原点", excel: false },
  { key: "", label: "通用（Excel 导出）", hint: "九宫格锚点 + 位移/缩放，作用于 Excel 模板导出", excel: true }
];

export function documentLogoPlacementKey(templateStyle: string | undefined, documentType: string) {
  return `${templateStyle || "rose"}:${documentType}`;
}

interface DocumentSignatureSnapshot {
  name: string;
  signerName: string;
  signerTitle: string;
  imageUrl: string;
}

export interface DocumentLetterhead extends DocumentLetterheadSnapshot {
  id: string;
  teamId: string;
  matchCountries: string[];
  matchCurrencies: string[];
  matchDocumentTypes: TradeDocument["type"][];
  matchPriority: number;
  stampId: string;
  signatureId: string;
  isDefault: boolean;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface DocumentStamp extends DocumentStampSnapshot {
  id: string;
  teamId: string;
  isDefault: boolean;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface DocumentSignature extends DocumentSignatureSnapshot {
  id: string;
  teamId: string;
  isDefault: boolean;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface DocumentDefaultProfile {
  teamId: string;
  seller: string;
  brandMarkText: string;
  sellerAddress: string;
  sellerContact: string;
  sellerPhone: string;
  sellerEmail: string;
  sellerWebsite: string;
  sellerTaxNo: string;
  bankInfo: string;
  currency: string;
  incoterm: string;
  paymentTerm: string;
  shippingMethod: string;
  portLoading: string;
  validityDays: number;
  notes: string;
  language: TradeDocument["language"];
  templateStyle: TradeDocument["templateStyle"];
  letterheadId: string;
  stampId: string;
  signatureId: string;
  includeProductImages: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface DocumentAssetsResponse {
  letterheads: DocumentLetterhead[];
  stamps: DocumentStamp[];
  signatures: DocumentSignature[];
  canManage: boolean;
}

export interface TradeDocumentHistoryResponse {
  documents: TradeDocument[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface QuoteHistoryItem {
  productId: string;
  product: string;
  model: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
}

export interface QuoteHistoryRecord {
  id: string;
  dealId: string;
  customerId: string;
  documentId: string;
  documentType: "PI" | "QUOTATION";
  documentNumber: string;
  documentRevision: number;
  issueDate: string;
  customerName: string;
  dealTitle: string;
  dealStage: string;
  currency: string;
  totalAmount: number;
  items: QuoteHistoryItem[];
  changes: string[];
  operatorId: string;
  operatorName: string;
  quotedAt: string;
  exportedAt?: string;
}

export interface QuoteHistoryResponse {
  records: QuoteHistoryRecord[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  summary: {
    recordCount: number;
    customerCount: number;
    dealCount: number;
    productCount: number;
    totals: Record<string, number>;
  };
  productAnalysis?: {
    rows: QuoteProductAnalysisRow[];
    overall: QuoteProductRangeRow[];
    countryRanges: QuoteProductRangeRow[];
    detailRecords: QuoteHistoryRecord[];
    totalRecords: number;
  };
}

interface QuoteProductRangeRow {
  country: string;
  currency: string;
  quoteCount: number;
  countryCount: number;
  minUnitPrice: number;
  maxUnitPrice: number;
  averageUnitPrice: number;
  latestUnitPrice: number;
  latestQuotedAt: string;
}

export interface QuoteProductAnalysisRow {
  productId: string;
  product: string;
  model: string;
  country: string;
  currency: string;
  quoteCount: number;
  minUnitPrice: number;
  maxUnitPrice: number;
  averageUnitPrice: number;
  latestUnitPrice: number;
  latestQuotedAt: string;
  latestCustomerName: string;
  latestDocumentNumber: string;
  recordIds: string[];
}

export type CommissionRuleType = "rate" | "fixed" | "tier" | "gross_profit" | "none";

export interface CommissionProduct {
  id: string;
  name: string;
  category: string;
  model: string;
  currency: string;
  defaultPrice: number;
  costPrice: number;
  status: "active" | "disabled";
  remark: string;
  updatedAt: string;
}

export interface CommissionRule {
  id: string;
  productId: string;
  ruleType: CommissionRuleType;
  rate: number;
  fixedAmount: number;
  tierJson: string;
  grossProfitRate: number;
  effectiveFrom: string;
  effectiveTo: string;
  enabled: boolean;
  remark: string;
  createdAt: string;
}

export interface MonthlySalesRecord {
  id: string;
  month: string;
  ownerId: string;
  teamId: string;
  customerId: string;
  customerName: string;
  dealId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  salesAmount: number;
  currency: string;
  exchangeRate: number;
  exchangeRateDate: string;
  exchangeRateSource: "pending" | "manual" | "finance";
  settlementCurrency: string;
  settlementAmount: number;
  basisType: "deal_amount" | "receipt";
  basisDate: string;
  dealArchivedAt: string;
  sourceType: "deal" | "manual" | "adjusted";
  status: "draft" | "confirmed" | "reviewed" | "locked";
  edited: boolean;
  editNote: string;
  lastEditedBy: string;
  lastEditedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SalesRecordAudit {
  id: string;
  recordId: string;
  fieldName: string;
  oldValue: string;
  newValue: string;
  reason: string;
  operatorName: string;
  createdAt: string;
}

export interface CommissionCalculation {
  id: string;
  month: string;
  ownerId: string;
  teamId: string;
  salesAmount: number;
  autoCommission: number;
  manualAdjustment: number;
  finalCommission: number;
  status: "pending" | "calculated" | "reviewed" | "locked";
  version: number;
  isCurrent: boolean;
  calculatedAt: string;
  reviewedBy: string;
  reviewedAt: string;
  lockedBy: string;
  lockedAt: string;
  unlockReason: string;
}

export interface CommissionItem {
  id: string;
  calculationId: string;
  recordId: string;
  productId: string;
  itemType: "auto" | "bonus" | "deduction" | "subsidy" | "refund" | "special" | "other";
  sourceType: "auto" | "manual";
  ruleSnapshotJson: string;
  salesAmount: number;
  autoAmount: number;
  manualAmount: number;
  finalAmount: number;
  remark: string;
  createdAt: string;
}

export interface CommissionOwner {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string;
}

export interface CustomerImportRow {
  customerId: string;
  company: string;
  companyFullName: string;
  country: string;
  contact: string;
  whatsapp: string;
  stage: string;
  amount: number;
  health: number;
  source: string;
  lifecycleStatus?: "open" | "won";
  nextReminder: string;
  phone: string;
  email: string;
  contactRemark: string;
  website: string;
  wecomBound: boolean;
}

export interface KnowledgeAsset {
  id: string;
  title: string;
  category: string;
  status: string;
  ownerId: string;
  version: string;
  teamId?: string;
  sourceType?: "external_url" | "baidu_share" | "legacy";
  sourceUrl?: string;
  shareCode?: string;
  fileType?: "pdf" | "word" | "excel" | "image" | "video" | "archive" | "link" | "other";
  description?: string;
  tags?: string[];
  accessCount?: number;
  lastAccessedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 反向索引：这份资料被哪些订单引用（服务端按订单可见性过滤）。 */
  linkedOrders?: Array<{ id: string; orderNo: string; companyOrderNo?: string; status: string; kind: string }>;
  linkedOrderCount?: number;
}

export interface Exam {
  id: string;
  title: string;
  category: string;
  status: string;
  passRate: number;
  questionCount: number;
  durationMinutes?: number;
  passScore?: number;
  targetRole?: "all" | "sales" | "manager";
  instructions?: string;
  startAt?: string;
  endAt?: string;
  maxAttempts?: number;
  allowReview?: boolean;
  publishedAt?: string;
  closedAt?: string;
  runtimeStatus?: "draft" | "upcoming" | "open" | "expired" | "closed";
  assignedCount?: number;
  completedCount?: number;
  attemptsUsed?: number;
  bestScore?: number;
  inProgressAttemptId?: string;
  assignment?: ExamAssignment | null;
  updatedAt?: string;
}

export interface ExamAssignment {
  id: string;
  examId: string;
  userId: string;
  assignedById: string;
  teamId: string;
  status: "pending" | "in_progress" | "submitted" | "passed" | "failed";
  attemptCount: number;
  bestScore: number;
  latestAttemptId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExamCandidate {
  id: string;
  name: string;
  role: Role;
  avatar: string;
}

export interface ExamQuestion {
  id: string;
  examId?: string;
  category: string;
  stem: string;
  options: string[];
  answerIndex: number;
  answerIndexes?: number[];
  questionType?: "single" | "multiple";
  tags?: string[];
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
}

export interface ExamAttempt {
  id: string;
  examId: string;
  userId: string;
  score: number;
  passed: boolean;
  answers: Record<string, number | number[]>;
  correctCount: number;
  totalQuestions: number;
  status?: "in_progress" | "submitted" | "auto_submitted";
  startedAt?: string;
  expiresAt?: string;
  updatedAt?: string;
  submittedAt: string;
  examTitle?: string;
  category?: string;
  userName?: string;
}

export interface ExamReport {
  totalAttempts: number;
  passedAttempts: number;
  retakeAttempts: number;
  averageScore: number;
  questionCount: number;
  categoryRows: Array<{ examId: string; title: string; category: string; participants: number; passRate: number; avgScore: number }>;
  difficultyRows: Array<{ difficulty: string; label: string; count: number; ratio: number }>;
  latestAttempts: ExamAttempt[];
}

export interface ExamImportQuestion {
  stem: string;
  category: string;
  options: string[];
  answerIndex: number;
  answerIndexes: number[];
  questionType: "single" | "multiple";
  tags: string[];
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
}

export interface WecomMessage {
  id: string;
  summary: string;
  status: string;
}

export interface CollaborationUser {
  id: string;
  name: string;
  avatar: string;
  role: Role;
  teamId: string;
}

export interface DailyReport {
  id: string;
  reportDate: string;
  completedWork: string;
  customerProgress: string;
  results: string;
  risks: string;
  nextPlan: string;
  supportNeeded: string;
  status: "submitted";
  ownerId: string;
  teamId: string;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
  owner: CollaborationUser;
  commentCount: number;
}

export interface DailyReportComment {
  id: string;
  reportId: string;
  parentId: string;
  content: string;
  authorId: string;
  teamId: string;
  createdAt: string;
  updatedAt: string;
  author: CollaborationUser;
}

export interface InternalMessage {
  id: string;
  threadId: string;
  senderId: string;
  recipientId: string;
  teamId: string;
  type: "system" | "manual";
  subject: string;
  content: string;
  relatedType: "daily_report" | "message" | "lead" | "email_return" | "quote_history" | "integration_approval" | "integration_call" | "integration_connection" | "integration_event" | "integration_connector" | "";
  relatedId: string;
  readAt: string;
  createdAt: string;
  updatedAt: string;
  sender: CollaborationUser;
  recipient: CollaborationUser;
}

export interface OcrJob {
  id: string;
  status: string;
  confidence: number;
  fields: Record<string, string>;
  batchId?: string;
  sourceFileName?: string;
  errorMessage?: string;
  createdAt?: string;
  ownerId: string;
  teamId: string;
  hasImage?: boolean;
  imageUrl?: string;
}

export type ProspectOutreachChannel = "email" | "whatsapp" | "call";
export type ProspectReplyClassification =
  | "clear_demand"
  | "interested_nurture"
  | "referral"
  | "no_current_demand"
  | "rejected"
  | "unsubscribed"
  | "bounced"
  | "auto_unknown";

export interface ProspectTouchpoint {
  id: string;
  channel: ProspectOutreachChannel;
  direction: "outbound" | "inbound";
  contactValue: string;
  subject: string;
  content: string;
  replyClassification?: ProspectReplyClassification;
  occurredAt: string;
}

export type ProcurementEvidenceType =
  | "quote_request"
  | "product_requirement"
  | "quantity"
  | "sample_request"
  | "purchase_timeline"
  | "target_price"
  | "certification"
  | "delivery"
  | "project_tender"
  | "manual_confirmation";

export interface ProcurementSignal {
  id: string;
  evidenceTypes: ProcurementEvidenceType[];
  evidenceSummary: string;
  product: string;
  specification: string;
  quantity: number;
  quantityType: "unknown" | "sample" | "trial" | "forecast" | "order";
  targetPrice: number;
  currency: string;
  priceBasis: string;
  deliveryRequirement: string;
  certificationRequirement: string;
  purchaseTimeline: string;
  projectName: string;
  buyerRole: string;
  nextAction: string;
  confidence: number;
  status: "needs_review" | "confirmed" | "dismissed" | "expired";
  observedAt: string;
  validUntil: string;
}

export interface DealRecommendation {
  id: string;
  customerId?: string;
  suggestedTitle: string;
  suggestedProduct: string;
  suggestedQuantity: number;
  suggestedUnitPrice: number;
  suggestedAmount: number;
  currency: string;
  nextAction: string;
  nextActionAt: string;
  expectedCloseAt: string;
  reasonTexts: string[];
  missingFields: string[];
  recommendationScore: number;
  status: "generated" | "dismissed" | "linked_existing_deal" | "converted_by_user" | "expired";
  linkedDealId?: string;
  duplicateDeals: Array<Pick<Deal, "id" | "title" | "product" | "stage" | "amount" | "currency">>;
}

export interface ProcurementContext {
  prospectCandidateId?: string;
  signals: ProcurementSignal[];
  recommendations: DealRecommendation[];
}

export interface ProspectPerformance {
  scope: {
    teamId: string;
    ownerId: string;
  };
  metrics: {
    candidates: number;
    contacted: number;
    validReplies: number;
    validReplyRate: number;
    leads: number;
    customers: number;
    deals: number;
    won: number;
    lost: number;
    wonRevenue: Array<{ currency: string; amount: number }>;
    pendingSuggestions: number;
  };
}

export type ProspectStrategySuggestionType =
  | "refine_targeting_keywords"
  | "increase_provider_priority"
  | "decrease_provider_priority"
  | "review_icp_exclusions"
  | "review_icp_weights";

export interface ProspectStrategySuggestion {
  id: string;
  campaignId: string;
  campaignVersion: number;
  strategyId: string;
  suggestionType: ProspectStrategySuggestionType;
  sampleMetrics: Record<string, unknown>;
  proposedAdjustments: Record<string, unknown>;
  rationale: string;
  status: "pending" | "accepted" | "rejected";
  sampleFrom: string;
  sampleTo: string;
  createdAt: string;
}

export type WebsiteProbeStage = "queued" | "dns" | "robots" | "head" | "body" | "contact_page" | "ai_extract" | "evidence" | "completed" | "failed";

export interface WebsiteProbeEvent {
  id: string;
  sequence: number;
  stage: WebsiteProbeStage;
  status: "started" | "completed" | "skipped" | "failed";
  message: string;
  metrics: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface WebsiteProbeAttempt {
  id: string;
  candidateId: string;
  domain: string;
  sourceUrl: string;
  purpose: "company_evidence_enrichment";
  accessMode: "controlled_probe";
  policyVersion: "website-probe-policy-v1" | "website-probe-policy-v2" | "website-probe-policy-v3" | "website-probe-policy-v4-foreign-only";
  status: "queued" | "running" | "completed" | "failed";
  outcome: "pending" | "evidence_found" | "no_evidence" | "robots_denied" | "unreachable" | "policy_blocked" | "rate_limited" | "circuit_open" | "interrupted";
  robotsDecision: "pending" | "allowed" | "denied" | "unavailable";
  httpStatus: number;
  responseBytes: number;
  redirected: boolean;
  evidence: null | {
    canonicalDomain: string;
    pageTitle: string;
    language: string;
    organizationName: string;
    legalName: string;
    addressCountry: string;
    businessCategory: string;
    publicContactEmail?: string;
    publicContactPhones?: string[];
    publicContactNames?: Array<{ name: string; title: string }>;
    sourceUrl: string;
    payloadHash: string;
    observedAt: string;
  };
  events: WebsiteProbeEvent[];
  failureCode: string;
  failureMessage: string;
  startedAt: string;
  completedAt: string;
  createdAt: string;
}

export type ProspectIdentityAuthorityProvider = "gleif" | "companies_house" | "sec_edgar" | "fr_company_search";

interface ProspectIdentityBootstrapEvent {
  id: string;
  sequence: number;
  stage: "validation" | "campaign" | "provider" | "identity" | "coverage" | "binding";
  status: "completed" | "failed";
  label: string;
  detail: string;
  createdAt: string;
}

export interface ProspectIdentityBootstrapAttempt {
  id: string;
  version: "prospect-identity-bootstrap-v1";
  requestIdHash: string;
  providerId: ProspectIdentityAuthorityProvider;
  registrationNumber: string;
  normalizedIdentifier: string;
  taskStatus: "running" | "ended";
  outcome: "pending" | "linked" | "not_found" | "identity_conflict" | "failed";
  campaignId: string;
  campaignVersion: number;
  strategyId: string;
  runId: string;
  sourceCandidateId: string;
  sourceRawRecordId: string;
  sourceHitId: string;
  resolutionId: string;
  conflictId: string;
  organizationId: string;
  tenantProspectId: string;
  errorCode: string;
  errorMessage: string;
  events: ProspectIdentityBootstrapEvent[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string;
}

export interface ProspectIdentityBootstrapProviderGuide {
  id: ProspectIdentityAuthorityProvider;
  name: string;
  jurisdiction: string;
  market: string;
  identifierLabel: string;
  example: string;
  profileCode: string;
  scheme: string;
  requiresKey: boolean;
  credentialKind: "none" | "api_key" | "fair_access_user_agent";
  setupNote: string;
  catalogStatus: string;
  docsUrl: string;
  runtime: LeadProviderStatus | null;
}

export interface ProspectIdentityBootstrapView {
  candidateId: string;
  formallyResolved: boolean;
  providers: ProspectIdentityBootstrapProviderGuide[];
  attempts: ProspectIdentityBootstrapAttempt[];
}

export interface ProspectIdentityBootstrapProgress {
  status: string;
  terminal: boolean;
  progress: number;
  currentAction: string;
  sourceCount: number;
  settledSources: number;
  candidateCount: number;
  verifiedCount: number;
  filteredCount: number;
  candidates: Array<{
    id: string;
    company: string;
    country: string;
    website: string;
    source: string;
    verificationLevel: string;
  }>;
}

export interface WebsiteOpportunity {
  id: string;
  company: string;
  business: string;
  country: string;
  website: string;
  contact: string;
  contactInfo: string;
  description: string;
  status: "preview" | "contactable" | "contacted" | "synced" | "excluded";
  researchRunning?: boolean;
  createdAt: string;
  customerId?: string;
  dealId?: string;
  leadId?: string;
  parseMode?: "rule" | "ai" | "fallback" | "reference";
  source?: string;
  sourceLabel?: string;
  sourceEvidence?: Array<{
    providerId: string;
    providerRecordId: string;
    officialWebsite: string;
    sourceUrl: string;
    recordType: string;
    fetchedAt: string;
    payloadHash: string;
    evidenceSummary: string;
    matchedFields: string[];
    adapterVersion: string;
    catalogPolicyVersion: string;
    sourceLevel: string;
    fieldAuthority?: Record<string, "official" | "corroborated" | "discovery" | "assisted">;
    retentionPolicyRef: string;
  }>;
  searchReport?: {
    summary: string;
    sourceAuthenticity: "official_confirmed" | "multi_source_supported" | "single_source_supported" | "weak" | "unknown";
    verifiedFields: string[];
    checkedSources: Array<{
      url: string;
      title: string;
      authenticity: "official" | "registry" | "reputable_directory" | "search_result" | "weak";
      verifiedFields: string[];
      finding: string;
    }>;
    contactFinding: {
      status: "source_confirmed" | "missing" | "conflicting" | "unverified";
      value: string;
      sourceUrl: string;
    };
    nextAction: string;
  };
  verificationReport?: {
    level: "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
    levelLabel: string;
    conclusion: string;
    generatedAt: string;
    crawlerFree: boolean;
    accessMode: "reference_only" | "controlled_probe";
    checks: Array<{
      code: string;
      label: string;
      status: "passed" | "partial" | "unverified" | "manual_required";
      summary: string;
      source: string;
      checkedAt: string;
    }>;
  };
  scorecard?: {
    version: "prospect-scorecard-v1";
    generatedAt: string;
    enterpriseConfidence: ProspectScoreComponentApi;
    icpMatch: ProspectScoreComponentApi;
    contactReadiness: ProspectScoreComponentApi;
    actionPriority: ProspectScoreComponentApi;
    vqa: { qualified: boolean; reasonCodes: string[] };
  };
  confidence?: number;
  lastDevelopmentEmailAt?: string;
  lastDevelopmentEmailSubject?: string;
  lastDevelopmentEmailTo?: string;
  verifiedAt?: string;
  statusChangedAt?: string;
  excludedReason?: string;
  shortlistedAt?: string;
  shortlistedBy?: string;
  shortlistSourceRunId?: string;
  tenantProspectId?: string;
  organizationId?: string;
  coverageClassification?: string;
  coverageQueueState?: string;
  coverageReasonCode?: string;
  lastTouchpointAt?: string;
  lastTouchpointChannel?: ProspectOutreachChannel;
  lastReplyClassification?: ProspectReplyClassification;
  nextFollowAt?: string;
  outreachState?: "uncontacted" | "awaiting_reply" | "replied" | "suppressed" | "contact_invalid";
  invalidContactChannels?: ProspectOutreachChannel[];
  websiteProbeAttempts?: WebsiteProbeAttempt[];
  websiteDiscoveryAttempts?: Array<{
    id: string;
    runId: string;
    providerId: string;
    status: "completed" | "failed";
    outcome: "source_provided" | "discovered" | "not_found" | "provider_unavailable" | "provider_failed";
    selectedWebsite: string;
    reasonCode: string;
    reason: string;
    candidates: Array<{ website: string; title: string; score: number; reasons: string[] }>;
    events: Array<{ id: string; stage: string; status: string; message: string; createdAt: string }>;
    createdAt: string;
    completedAt: string;
  }>;
  identityBootstrapAttempts?: ProspectIdentityBootstrapAttempt[];
  extractedContacts?: Array<{
    kind: "company" | "person";
    name: string;
    title: string;
    emails: string[];
    phones: string[];
    whatsapp: string[];
    source: string;
    sourceLabel?: string;
    sourceKind?: "source_record" | "contact_provider" | "web_search" | "official_website" | "local_runner" | "manual";
    confidence?: number;
    verificationStatus?: "verified" | "source_confirmed" | "syntax_valid" | "unverified";
    observedAt?: string;
    reasonCodes?: string[];
    evidenceExcerpt?: string;
    corroboratedSources?: Array<{ sourceId: string; sourceLabel: string; evidenceUrl: string }>;
    evidenceUrl: string;
  }>;
  contactEnrichmentAttempts?: Array<{
    id: string;
    runId: string;
    status: "queued" | "running" | "completed" | "partial" | "failed";
    sources: Array<{
      id: string;
      sourceId: string;
      sourceLabel: string;
      sourceKind: "source_record" | "contact_provider" | "web_search" | "official_website" | "local_runner" | "manual";
      status: "queued" | "running" | "completed" | "failed" | "blocked" | "skipped";
      outcome: "pending" | "contact_found" | "no_contact" | "not_needed" | "not_configured" | "policy_blocked" | "timed_out" | "provider_failed";
      contactCount: number;
      message: string;
      errorCode?: string;
      retryable?: boolean;
      retryAfterAt?: string | null;
      suggestion?: string;
      taskId?: string;
      evidenceUrls?: string[];
      startedAt: string;
      completedAt: string;
    }>;
    recommendedContact: null | {
      contactName: string;
      contactTitle: string;
      channelType: "email" | "phone" | "whatsapp";
      channelValue: string;
      sourceId: string;
      sourceLabel: string;
      confidence: number;
      verificationStatus: "verified" | "source_confirmed" | "syntax_valid" | "unverified";
      reason: string;
    };
    contactCount: number;
    summary: string;
    deadlineAt?: string;
    lastProgressAt?: string;
    createdAt: string;
    startedAt: string;
    completedAt: string;
  }>;
  /** 发信资格灯：可发信 / 缺邮箱 / 已抑制（附原始原因码）。由 /api/tools/website-opportunities 下发。 */
  emailEligibility?: {
    ready: boolean;
    state: "ready" | "missing_email" | "blocked";
    label: string;
    code: string;
    message: string;
    recipient: string;
  };
  selected?: boolean;
  ownerId?: string;
  teamId?: string;
}

export interface ProspectQualificationViewApi {
  candidateId: string;
  prospectId: string;
  organizationId: string;
  campaign: null | {
    runId: string;
    campaignId: string;
    campaignVersion: number;
    campaignName: string;
    campaignSnapshot: {
      goal: string;
      products: string[];
      markets: string[];
      customerTypes: string[];
      applicationScenarios: string[];
      icpRules: string[];
      exclusionRules: string[];
      sourceProviderIds: string[];
    };
  };
  blockers: string[];
  qualification: null | {
    evidence: Array<{ id: string; field: string; sourceType: string; providerCode: string; sourceRef: string; observedAt: string; expiresAt: string }>;
    companyVerification: null | { id: string; status: string; reviewStatus: string; reasonCodes: string[]; validUntil: string; createdAt: string };
    icpPolicies: Array<{ id: string; campaignId: string; campaignVersion: number }>;
    icpAssessments: Array<{ id: string; totalScore: number; result: string; reviewStatus: string; hardGateReasonCodes: string[]; createdAt: string }>;
    contacts: Array<{ id: string; contactType: string; name: string; department: string; title: string }>;
    channels: Array<{ id: string; contactId: string; channelType: "email" | "phone" | "whatsapp" | "website_form"; value: string; sourceEvidenceId: string; createdAt: string }>;
    contactVerifications: Array<{ id: string; channelId: string; status: string; providerCode: string; reasonCode: string; verifiedAt: string; expiresAt: string; createdAt: string }>;
    suppressions: Array<{ id: string; scope: string; action: string; reasonCode: string; effectiveAt: string; expiresAt: string }>;
    contactabilityDecisions: Array<{ id: string; channelId: string; status: string; reasonCodes: string[]; approvedAt: string; createdAt: string }>;
  };
  approvedDecision: null | { id: string; channelId: string; status: string; approvedAt: string };
  approvedChannel: null | { id: string; channelType: "email" | "phone" | "whatsapp" | "website_form"; value: string };
  scorecard?: WebsiteOpportunity["scorecard"];
  stageCurrency: {
    company: boolean;
    icp: boolean;
    channel: boolean;
    contactability: boolean;
  };
  vqaQualified: boolean;
  nextStep: "resolve_identity" | "resolve_campaign" | "verify_company" | "assess_icp" | "approve_icp" | "verify_channel" | "evaluate_contactability" | "approve_contactability" | "ready";
}

export interface ProspectScoreComponentApi {
  score: number;
  status: "verified" | "partial" | "unverified" | "blocked";
  reasonCodes: string[];
  evidenceRefs: string[];
}

export interface OrganizationIdentityConflictItem {
  id: string;
  conflictType:
    | "identifier_split"
    | "identifier_slot_conflict"
    | "binding_conflict";
  createdAt: string;
  effectiveStatus: "open" | "resolved";
  revision: number;
  etag: string;
  identifierCount: number;
  candidateCount: number;
  organizations: Array<{
    id: string;
    name: string;
    canonicalOrganizationId: string;
  }>;
  review: {
    action: "keep_separate" | "merge";
    canonicalOrganizationId: string;
    note: string;
    reviewedBy: string;
    reviewedByName: string;
    createdAt: string;
  } | null;
}

export interface ProspectAssignee {
  id: string;
  name: string;
  role: string;
  teamId: string;
}

export interface LeadProviderStatus {
  id: string;
  name: string;
  tier: "free" | "byok_free" | "paid" | "ai";
  category: "web" | "company" | "email" | "ai";
  requiresKey: boolean;
  optionalKey?: boolean;
  capabilities: string[];
  docsUrl: string;
  keyHint: string;
  defaultBaseUrl: string;
  costNote: string;
  accessMode: "api" | "bulk_file" | "website_controlled" | "manual_assisted" | "disabled";
  recommended: boolean;
  hasApiKey: boolean;
  ready: boolean;
  enabled: boolean;
  lastTestStatus: "untested" | "passed" | "failed";
  lastTestMessage: string;
  lastTestAt: string;
  usage: string;
}

export interface LeadFinderJob {
  id: string;
  title: string;
  subtitle: string;
  status: "ready" | "running" | "done" | "partial" | "failed" | "needs_input" | "paused" | "cancelled";
  resultCount: number;
  channelCount: number;
  elapsedText: string;
  progress: number;
  steps: string[];
  createdAt: string;
  expanded?: boolean;
  resultIds?: string[];
  detailLines?: string[];
  incrementalStats?: LeadFinderIncrementalStats;
  sourceStats?: LeadFinderSourceStat[];
  backendRunId?: string;
  backendRunRevision?: number;
  backendRunStatus?: ProspectRunApiStatus;
  /** CLI 获客对应的引擎作业 id：历史重建 / 去重 / 防重复跟踪的锚点 */
  cliEngineJobId?: string;
  metricLabel?: string;
  metricValue?: string;
  progressLabel?: string;
  progressValue?: string;
  runEvents?: ProspectRunEventApiRecord[];
  processPhases?: ProspectRunProcessPhase[];
  cleaningReport?: ProspectRunCleaningReport;
  superSearchMissionId?: string;
  superSearchRevision?: number;
  superSearchStatus?: ProspectSuperSearchMissionApi["status"];
  superSearchRound?: number;
  superSearchMaxRounds?: number;
  superSearchTarget?: number;
  superSearchRounds?: ProspectSuperSearchRoundApi[];
  pendingCandidates?: ProspectPendingCandidatePreview[];
  selectedPendingHitIds?: string[];
  pendingCandidatesLoaded?: boolean;
  selectedResultIds?: string[];
  liveEvents?: ProspectLiveEventApiRecord[];
  acceptance?: ProspectAcceptanceApi;
  deepMining?: ProspectDeepMiningApi;
  lfindTaskId?: string;
  lfindEvents?: LfindTaskEvent[];
  lfindSynced?: boolean;
  lfindSkipped?: Array<{ company: string; reason: string }>;
  lfindFailures?: Array<{ stage: string; reason: string; suggestion: string }>;
}

export interface ProspectPendingCandidatePreview {
  hitId: string;
  runId: string;
  providerCode: string;
  company: string;
  country: string;
  business: string;
  website: string;
  contact: string;
  contactInfo: string;
  evidenceSummary: string;
  sourceUrl: string;
  fetchedAt: string;
  previewError: string;
}

export interface ProspectRunProcessPhase {
  id: string;
  name: string;
  status: "pending" | "running" | "succeeded" | "partial" | "failed" | "blocked";
  result: string;
}

interface ProspectRunFailureReport {
  stage: string;
  errorCode: string;
  errorMessage: string;
  httpStatus: number | null;
  providerOutcomeCode: string;
  retryable: boolean;
  retryAfterAt: string;
  occurredAt: string;
}

export interface ProspectRunCleaningReport {
  summary: {
    providerRawCount: number;
    providerInvalidCount: number;
    providerDuplicateCount: number;
    pipelineHitCount: number;
    processedCount: number;
    pendingCount: number;
    rejectedCount: number;
    suppressedCount: number;
    mergedCount: number;
    candidateCount: number;
    websiteResolvedCount?: number;
    websiteDiscoveredCount?: number;
    websiteDiscoveryFailedCount?: number;
    websiteDiscoveryPendingCount?: number;
  };
  stages: Array<{
    id: string;
    name: string;
    input: number;
    output: number;
    removed: number;
    result: string;
  }>;
  reasons: Array<{ code: string; label: string; count: number }>;
  sources: Array<{
    providerCode: string;
    rawCount: number;
    invalidCount: number;
    duplicateCount: number;
    processedCount: number;
    rejectedCount: number;
    candidateCount: number;
  }>;
  records: Array<{
    hitId: string;
    providerCode: string;
    sourceRecordId?: string;
    sourceCompany?: string;
    sourceCountry?: string;
    sourceDomain?: string;
    outcome: "pending" | "accepted" | "merged" | "suppressed" | "rejected";
    reasonCode: string;
    reason: string;
    candidateId: string;
    candidateName: string;
    website?: string;
    websiteOutcome?: string;
    websiteReasonCode?: string;
    websiteReason?: string;
    websiteProvider?: string;
    processedAt: string;
  }>;
}

export interface LeadFinderSourceStat {
  id: string;
  name: string;
  count?: number;
  rawCount?: number;
  invalidCount?: number;
  duplicateCount?: number;
  processedCount?: number;
  rejectedCount?: number;
  candidateCount?: number;
  status?: string;
  statusLabel?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  retryAfterAt?: string | null;
  usage?: string;
  createdAt?: string;
  updatedAt?: string;
  failure?: ProspectRunFailureReport | null;
  job?: Record<string, unknown> | null;
  checkpoint?: Record<string, unknown> | null;
  attempts?: Array<Record<string, unknown>>;
  requests?: Array<Record<string, unknown>>;
}

export interface LeadFinderIncrementalStats {
  rawCount: number;
  returnedCount: number;
  deduplicatedCount: number;
  existingFilteredCount?: number;
  newCount: number;
  evidenceUpdatedCount: number;
  multiSourceMergedCount: number;
  unchangedCount: number;
  excludedCount: number;
}

interface LfindTaskEvent {
  id: number;
  eventType: "status" | "progress" | "output" | "warning" | "error";
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LfindTask {
  id: string;
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  errorMessage: string;
  resultText: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
}

export interface LfindTaskResponse {
  task: LfindTask;
  events?: LfindTaskEvent[];
  synced?: boolean;
  opportunities?: WebsiteOpportunity[];
  incrementalStats?: LeadFinderIncrementalStats | null;
  skipped?: Array<{ company: string; reason: string }>;
  lfind?: {
    summary?: {
      target?: string;
      rawFound?: number;
      accepted?: number;
      skipped?: number;
      noResultReason?: string;
    };
    failures?: Array<{ stage: string; reason: string; suggestion: string }>;
  } | null;
}

export interface LeadTaskStreamLog {
  key: string;
  at: string;
  source: string;
  title: string;
  detail: string;
  result: string;
  tone: string;
  live?: boolean;
  phases?: string[];
}

export interface ProspectLiveEventApiRecord {
  id: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  type: string;
  stage: string;
  entityType: string;
  entityId: string;
  status: string;
  progress: number | null;
  metrics: Record<string, number | string | boolean | null>;
  failureCode: string;
  retryable: boolean;
  message: string;
}

interface ProspectCampaignApiRecord {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "completed" | "archived";
  currentVersion: number;
  revision: number;
}

interface ProspectStrategyApiRecord {
  id: string;
  campaignId: string;
  campaignVersion: number;
  name: string;
  status: "draft" | "approved" | "disabled";
  revision: number;
}

export type ProspectRunApiStatus =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "succeeded_empty"
  | "partial_success"
  | "failed";

export interface ProspectRunApiRecord {
  id: string;
  campaignId: string;
  campaignVersion: number;
  strategyId: string;
  ownerId: string;
  status: ProspectRunApiStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  executionSnapshot?: {
    campaign: {
      id: string;
      name: string;
      version: number;
      snapshot: {
        goal: string;
        products: string[];
        markets: string[];
        customerTypes: string[];
        applicationScenarios: string[];
        exclusionRules: string[];
        sourceProviderIds: string[];
      };
    };
    resolvedQuery: {
      positiveKeywords: string[];
      industryTerms: string[];
      countries: string[];
      customerTypes: string[];
      exclusionKeywords: string[];
    };
  };
}

export interface ProspectRunShardApiRecord {
  id: string;
  providerCode: string;
  status: ProspectRunApiStatus | "retry_scheduled";
  createdAt: string;
  updatedAt: string;
}

export interface ProspectRunEventApiRecord {
  id: string;
  sequence: number;
  eventType: "created" | "started" | "pause_requested" | "paused" | "resumed" | "cancel_requested" | "cancelled" | "completed" | "failed";
  actorId: string;
  fromStatus: ProspectRunApiStatus | "";
  toStatus: ProspectRunApiStatus;
  reason: string;
  createdAt: string;
}

export interface ProspectAcceptanceApi {
  outcome: "running" | "success" | "partial_success" | "failed" | "empty" | "cancelled";
  sourceReturnedCount?: number;
  candidateCount: number;
  reviewReadyCount?: number;
  vqaCount: number;
  targetVqaCount?: number;
  targetReviewReadyCount?: number;
  targetCandidateCount?: number;
  researchReadyCount?: number;
  deepMiningStatus?: string;
  sourceSuccessCount: number;
  sourceFailureCount: number;
  sourceSkippedCount: number;
  costs?: Array<{ currency: string; amount: number }>;
  totalCost?: number;
  currency?: string;
  costUnknownCount?: number;
  costIntegrityStatus?: "complete" | "unknown" | "currency_mismatch";
  stopReason: string;
  recommendedNextAction: string;
  failedSources?: Array<{ providerId: string; errorCode: string; errorMessage: string }>;
}

export interface ProspectRunDetailApiResponse {
  run: ProspectRunApiRecord;
  shards: ProspectRunShardApiRecord[];
  events: ProspectRunEventApiRecord[];
  diagnostics?: {
    phases: ProspectRunProcessPhase[];
    sources: Array<{
      shardId: string;
      providerCode: string;
      status: string;
      failure: ProspectRunFailureReport | null;
      job: Record<string, unknown> | null;
      checkpoint: Record<string, unknown> | null;
      attempts: Array<Record<string, unknown>>;
      requests: Array<Record<string, unknown>>;
    }>;
    cleaningReport: ProspectRunCleaningReport;
    summary: { rawHits: number; pages: number; accepted: number; rejected: number; succeededSources: number; failedSources: number; candidateIds: string[] };
    acceptance: ProspectAcceptanceApi;
  };
}

interface ProspectSuperSearchRoundApi {
  id: string;
  missionId: string;
  roundNo: number;
  runId: string;
  roundKind?: "discovery" | "deep_mining";
  focusCandidateId?: string;
  focusNodeId?: string;
  miningDepth?: number;
  queryPlanSnapshot?: {
    positiveKeywords: string[];
    synonyms: string[];
    industryTerms: string[];
    purchaseScenarioTerms: string[];
    countries: string[];
    languages: string[];
    customerTypes: string[];
  };
  plannerVersion?: string;
  planningMode?: "rules" | "ai_enhanced";
  queryTheme?: string;
  queryPlanFingerprint?: string;
  coverageGaps?: string[];
  queryCells?: Array<{
    market: string;
    language: string;
    customerType: string;
    queryTheme: string;
    providerId: string;
    queryText: string;
    fingerprint: string;
    status: "planned" | "succeeded" | "succeeded_empty" | "partial_success" | "failed" | "cancelled";
    rawCount?: number;
    invalidCount?: number;
    duplicateCount?: number;
    candidateCount?: number;
    errorCode?: string;
    errorMessage?: string;
    completedAt?: string;
  }>;
  rawCount: number;
  uniqueCount: number;
  candidateCount: number;
  reviewReadyCount?: number;
  vqaCount?: number;
  duplicateCount: number;
  filteredCount: number;
  pendingCount: number;
  duplicateRate: number;
  yieldRate: number;
  decision: "pending" | "continue" | "converged" | "limit_reached" | "manual_stop" | "failed";
  decisionReason: string;
  createdAt: string;
  completedAt: string;
}

export interface ProspectDeepMiningApi {
  version: "prospect-deep-mining-v1";
  status: "queued" | "searching" | "verifying" | "completed" | "failed";
  maxDepth: number;
  maxRootCandidates: number;
  maxQueries: number;
  maxWebsiteProbes: number;
  queriesUsed: number;
  websiteProbesUsed: number;
  activeTaskId: string;
  tasks: Array<{
    id: string;
    rootCandidateId: string;
    candidateId: string;
    nodeId: string;
    parentNodeId: string;
    depth: number;
    status: "queued" | "searching" | "verifying" | "completed" | "failed" | "stopped";
    runId: string;
    roundNo: number;
    websiteProbeAttemptId: string;
    queryText: string;
    newNodeCount: number;
    evidenceCount: number;
    duplicateCount: number;
    stopReason: string;
    createdAt: string;
    startedAt: string;
    completedAt: string;
  }>;
  nodes: Array<{
    id: string;
    rootCandidateId: string;
    candidateId: string;
    parentNodeId: string;
    company: string;
    country: string;
    website: string;
    depth: number;
    evidenceIds: string[];
    enterpriseVerificationScore: number;
    contactReadinessScore: number;
    actionPriorityScore: number;
    verificationStatus: "unverified" | "partial" | "verified" | "blocked";
    conflict: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  edges: Array<{
    id: string;
    rootCandidateId: string;
    fromNodeId: string;
    toNodeId: string;
    relationType: string;
    confidence: number;
    evidenceIds: string[];
    sourceUrls: string[];
    verified: boolean;
    conflict: boolean;
    createdAt: string;
  }>;
  evidence: Array<{
    id: string;
    nodeId: string;
    candidateId: string;
    providerId: string;
    sourceUrl: string;
    summary: string;
    queryText: string;
    authority: "official" | "corroborated" | "discovery" | "assisted";
    observedAt: string;
    payloadHash: string;
  }>;
  summary: {
    rootCandidateCount: number;
    researchedCandidateCount: number;
    relationCount: number;
    evidenceCount: number;
    verifiedCompanyCount: number;
    contactReadyCount: number;
    researchReadyCount: number;
    stoppedTaskCount: number;
  };
  stopReason: string;
  startedAt: string;
  endedAt: string;
}

export interface ProspectSuperSearchMissionApi {
  id: string;
  campaignId: string;
  strategyId: string;
  ownerId: string;
  status: "queued" | "running" | "paused" | "cancelled" | "succeeded" | "partial_success" | "failed";
  targetCandidateCount: number;
  maxDurationMinutes: number;
  depth: "balanced" | "deep" | "extreme";
  maxRounds: number;
  costLimit: number;
  currency: string;
  currentRound: number;
  currentRunId: string;
  totalCost: number;
  rawCount: number;
  uniqueCount: number;
  candidateCount: number;
  reviewReadyCount: number;
  vqaCount: number;
  pendingCount: number;
  filteredCount: number;
  revision: number;
  deadlineAt: string;
  stopReason: string;
  webSearchMode?: "off" | "api";
  webProviderIds?: string[];
  mapSearchMode?: "off" | "google_places";
  mapProviderIds?: string[];
  aiDiscoveryMode?: "off" | "model";
  aiDiscoveryProviderIds?: string[];
  candidateIds?: string[];
  createdAt: string;
  updatedAt: string;
  deepMining?: ProspectDeepMiningApi;
  rounds: ProspectSuperSearchRoundApi[];
  acceptance?: ProspectAcceptanceApi;
}

export interface ProspectScheduleApiRecord {
  id: string;
  ownerId: string;
  campaignId: string;
  campaignVersion: number;
  strategyId: string;
  frequency: "daily" | "weekly" | "monthly";
  status: "active" | "paused";
  timezone: string;
  nextRunAt: string;
  lastRunAt: string;
  lastRunId: string;
  lastPlannedAt: string;
  lastFailureCode: string;
  lastFailureReason: string;
  recurringCostApproved: boolean;
  orchestrationMode?: "campaign_rotation_v1";
  approvedStrategyCount?: number;
  rotatableStrategyCount?: number;
  lastStrategyId?: string;
  dueReviewCount?: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeadFinderLaunchResult extends ProspectRunDetailApiResponse {
  schedule?: ProspectScheduleApiRecord;
  scheduleError?: string;
  superSearch?: ProspectSuperSearchMissionApi;
  launchReplayed?: boolean;
  launchTimings?: {
    campaignMs: number;
    strategyMs: number;
    approvalMs: number;
    activationMs: number;
    runMs: number;
    scheduleMs: number;
    queueMs: number;
    totalMs: number;
  };
}

export interface AiModelConfig {
  id: string;
  provider: string;
  protocol: "openai-compatible" | "anthropic" | "gemini";
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
  enabled: boolean;
  temperature: number;
  useLeadFinder: boolean;
  useWebsiteParse: boolean;
  useScoring: boolean;
  useEmailDraft: boolean;
  useExam: boolean;
  lastTestAt?: string;
  lastTestStatus?: "untested" | "passed" | "failed";
  lastTestMessage?: string;
  webSearchStatus?: "untested" | "passed" | "failed" | "unsupported";
  webSearchTestAt?: string;
  webSearchTestMessage?: string;
  webSearchCitationCount?: number;
  updatedAt: string;
}

export interface Product {
  id: string;
  nameZh: string;
  nameEn: string;
  model: string;
  category: string;
  unit: string;
  price: number;
  currency: string;
  hsCode: string;
  descriptionZh: string;
  descriptionEn: string;
  tags: string[];
  imageUrl: string;
  packWeight?: number;
  ownerId: string;
  teamId: string;
  updatedAt: string;
}

export type ShipmentStatus = "draft" | "shipped" | "in_transit" | "delivered" | "exception";

export interface ShipmentItem {
  id: string;
  productName: string;
  model: string;
  hsCode: string;
  quantity: number;
  unit: string;
  netWeight: number;
  grossWeight: number;
  length: number;
  width: number;
  height: number;
  volume: number;
  note: string;
}

export interface Shipment {
  id: string;
  shipmentNo: string;
  dealId: string;
  dealTitle: string;
  /** 关联订单：有它才能从发货单跳回履约主档。 */
  orderId?: string;
  customerName: string;
  destinationCountry?: string;
  destinationPort?: string;
  destinationAddress?: string;
  courier: string;
  trackingCode: string;
  trackingImageUrl: string;
  status: ShipmentStatus;
  statusSource: "local" | "carrier";
  lastSyncedAt?: string;
  syncError?: string;
  trackingEvents?: TrackingEvent[];
  shippedAt: string;
  estimatedArrival: string;
  note: string;
  items: ShipmentItem[];
  ownerId: string;
  teamId: string;
  updatedAt: string;
}

interface TrackingEvent {
  id: string;
  time: string;
  status: ShipmentStatus;
  location: string;
  description: string;
}

export interface ProblemItem {
  id: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  relatedCustomer: string;
  rootCause: string;
  solution: string;
  nextAction: string;
  dueAt: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface Memo {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string;
  customerId: string;
  dealId: string;
  pinned: boolean;
  archived: boolean;
  deletedAt: string;
  updatedAt: string;
}

export interface MemoDraft {
  title: string;
  content: string;
  category: string;
  tags: string;
  customerId: string;
  dealId: string;
  serverUpdatedAt: string;
  draftAt: string;
}

export interface PlanTask {
  id: string;
  title: string;
  phase: string;
  category: string;
  priority: "high" | "medium" | "normal";
  status: "planned" | "active" | "done" | "cancelled";
  dueAt: string;
  target: string;
  description: string;
  customerId?: string;
  leadId?: string;
  dealId?: string;
  completionResult?: string;
  completedAt?: string;
  cancellationReason?: string;
  cancelledAt?: string;
  rescheduledFrom?: string;
  rescheduledAt?: string;
  rescheduleReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanTemplate {
  id: string;
  section: "knowledge" | "persona" | "execution";
  title: string;
  summary: string;
  output: string;
  badge: string;
  badgeTone: string;
  phase: string;
  category: string;
  priority: "high" | "medium" | "normal";
  target: string;
  description: string;
  sortOrder: number;
  updatedAt: string;
}

export interface Competitor {
  id: string;
  company: string;
  country: string;
  segment: string;
  threatLevel: string;
  website: string;
  strengths: string;
  weaknesses: string;
  competingProducts: string;
  ourStrategy: string;
  updatedAt: string;
}

export type PeerRelation = "互补" | "竞争" | "互相推荐";

export interface Peer {
  id: string;
  company: string;
  country: string;
  industry: string;
  relations: PeerRelation[];
  contact: string;
  phone: string;
  email: string;
  wechat: string;
  website: string;
  remark: string;
  source: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

/** 供应商：与后端 supplier-repository.ts 的 Supplier 一一对应 */
export type SupplierStatus = "active" | "evaluating" | "paused";
export type SupplierGrade = "A" | "B" | "C" | "D";

export interface Supplier {
  id: string;
  ownerId: string;
  teamId: string;
  /** 团队内唯一的供应商编码（SUP-0001 形式，可人工改写） */
  code: string;
  company: string;
  companyFullName: string;
  country: string;
  category: string;
  contact: string;
  phone: string;
  email: string;
  wechat: string;
  website: string;
  address: string;
  paymentTerm: string;
  leadTimeDays: number;
  grade: SupplierGrade;
  status: SupplierStatus;
  source: string;
  remark: string;
  createdAt: string;
  updatedAt: string;
}

export const SUPPLIER_STATUS_META: Record<SupplierStatus, { label: string; tone: string }> = {
  active: { label: "合作中", tone: "green" },
  evaluating: { label: "考察中", tone: "amber" },
  paused: { label: "已停用", tone: "gray" }
};

export const SUPPLIER_GRADE_LABEL: Record<SupplierGrade, string> = {
  A: "A · 核心供应",
  B: "B · 重点供应",
  C: "C · 常规供应",
  D: "D · 备选"
};

export const SUPPLIER_STATUS_VALUES: SupplierStatus[] = ["active", "evaluating", "paused"];
export const SUPPLIER_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export interface CaseStudy {
  id: string;
  title: string;
  customer: string;
  country: string;
  product: string;
  industry: string;
  result: string;
  story: string;
  reusablePoints: string;
  status: string;
  updatedAt: string;
}

export interface DashboardSummary {
  scope: string;
  scopeLabels: {
    business: string;
    todos: string;
  };
  updatedAt: string;
  periods: Record<DashboardPeriod, {
    label: string;
    start: string;
    end: string;
    expectedDeals: number;
    expectedAmounts: Array<{ currency: string; amount: number }>;
    pendingTodos: number;
    highPriorityTodos: number;
    newLeads: number;
    briefing: {
      title: string;
      description: string;
      basis: string;
      action: string;
      impact: string;
    };
  }>;
  briefing: {
    title: string;
    description: string;
    basis: string;
    action: string;
    impact: string;
    riskAmount: number;
    riskLabel: string;
    closableDeals: number;
    closableAmount: number;
    unreadWecom: number;
  };
  metrics: {
    customers: number;
    riskCustomers: number;
    todos: number;
    overdueTodos: number;
    forecastAmount: number;
    wecomBoundRate: number;
    pendingKnowledge: number;
    examPassRate: number;
    unfinishedExams: number;
    customerCompleteness: number;
  };
  schedule: Array<{ time: string; title: string; subtitle: string; tone: string }>;
  quality: {
    followHealth: number;
    overdueRate: number;
    avgResponseHours: number;
  };
  leadFunnel: {
    stages: Array<{ key: string; label: string; count: number; conversionRate: number }>;
    todayAdded: number;
    filteredOut: number;
    dealConversionRate: number;
  };
  pipelineHealth: Array<{ stage: string; count: number; amount: number; riskCount: number; width: number; tone: string }>;
  todoInsights: {
    total: number;
    overdue: number;
    completionRate: number;
    impactAmount: number;
    typeRows: Array<{ type: string; label: string; count: number; risk: string }>;
    weekLoad: Array<{ day: string; count: number }>;
    historyCount: number;
    historyAmount: number;
  };
  priorityTasks: Array<{ id: string; customerId: string; title: string; subtitle: string; score: number; reason: string; action: string; tone: string; badge: string }>;
}

export interface Lead {
  id: string;
  company: string;
  contact: string;
  country: string;
  email: string;
  phone: string;
  wechat: string;
  source: string;
  sourceType?: string;
  sourceChannel?: string;
  sourceCampaign?: string;
  externalId?: string;
  sourceUrl?: string;
  intent: string;
  stage: string;
  status: "new" | "following" | "converted" | "invalid";
  ownerId: string;
  teamId: string;
  estimatedAmount: number;
  nextFollowAt: string;
  lastActivityAt: string;
  remark: string;
  inquiryContent?: string;
  /** 客户最近一次邮件回复时间（IMAP 监听自动写入；有值显示绿色邮箱图标） */
  lastEmailReplyAt?: string;
  convertedCustomerId: string;
  convertedDealId?: string;
  createdAt: string;
  deletedAt?: string;
  deletedReason?: string;
  deletedBy?: string;
  purgeAt?: string;
  statusBeforeDelete?: "new" | "following" | "converted" | "invalid";
}

export interface LeadSourceEvent {
  id: string;
  leadId: string;
  sourceType: string;
  channel: string;
  campaign: string;
  externalId: string;
  sourceUrl: string;
  occurredAt: string;
  receivedAt: string;
  rawPayload: string;
}

export interface LeadConversionMatch {
  customer: Customer;
  score: number;
  reasons: string[];
  activeDealCount: number;
}

export interface LeadSyncResult {
  lead: Lead;
  sourceEvent: unknown;
  opportunity: WebsiteOpportunity;
  duplicate: boolean;
}

export interface LeadActivity {
  id: string;
  leadId: string;
  type: string;
  content: string;
  operatorId: string;
  nextFollowAt: string;
  createdAt: string;
}

export type AgentRisk = "read" | "draft" | "write" | "external";
export type AgentStepStatus = "ready" | "needs_confirmation" | "queued" | "running" | "done" | "failed" | "skipped";
export interface AgentStep {
  id: string;
  key: string;
  dependsOn: string[];
  tool: string;
  risk: AgentRisk;
  status: AgentStepStatus;
  title: string;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  signature: string;
}
export interface AgentRun {
  id: string;
  conversationId: string;
  ownerId: string;
  teamId: string;
  goal: string;
  goalSpec?: {
    primaryAction: "navigate" | "read" | "analyze" | "create" | "update" | "record" | "search" | "draft" | "export" | "send" | "manage" | "unknown";
    primaryDomain: string;
    subject: string;
    objectives: Array<{ id: string; action: string; domain: string; description: string; completionCriteria: string[] }>;
    constraints: string[];
    completionCriteria: string[];
    compiledBy: "rules" | "model+rules";
  };
  summary: string;
  status: "planning" | "awaiting_confirmation" | "running" | "paused" | "waiting_user" | "completed" | "failed" | "cancelled";
  iteration: number;
  maxIterations: number;
  progress: number;
  currentAction: string;
  stopReason: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  steps: AgentStep[];
  events: Array<{ id: string; type: "plan" | "step" | "approval" | "result" | "error" | "assistant"; message: string; createdAt: string }>;
}

export interface AgentPlanningProgress {
  phase: "understanding" | "intent" | "planning" | "ready";
  requestKind: "execute" | "query" | "conversation";
  message: string;
  detail: string;
}

export interface AgentConversation {
  id: string;
  title: string;
  updatedAt: string;
  status: AgentRun["status"];
  turnCount: number;
}

export interface AgentMissionCheckpoint {
  id: string;
  runId: string;
  iteration: number;
  status: AgentRun["status"];
  reason: string;
  stateHash: string;
  createdAt: string;
  stepCount: number;
}

export type AgentMemoryStatus = "proposed" | "active" | "archived";
export interface AgentMemory {
  id: string;
  ownerId: string;
  teamId: string;
  type: "user_preference" | "company_knowledge" | "customer_memory" | "team_playbook";
  scope: "personal" | "team" | "customer" | "company";
  subjectId: string;
  title: string;
  content: string;
  sourceType: "crm" | "manual" | "agent" | "playbook";
  sourceId: string;
  status: AgentMemoryStatus;
  confidence: number;
  expiresAt: string;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentKnowledgeStatus = "draft" | "review" | "published" | "archived";
export type AgentKnowledgeKind = "system" | "module" | "workflow" | "policy" | "field" | "playbook" | "failure_case";
export interface AgentKnowledgeDocument {
  id: string;
  ownerId: string;
  teamId: string;
  kind: AgentKnowledgeKind;
  scope: "system" | "team" | "company";
  module: string;
  title: string;
  summary: string;
  content: string;
  keywords: string[];
  roles: Array<"sales" | "manager" | "admin" | "super_admin">;
  permissionCodes: string[];
  toolRefs: string[];
  successCriteria: string[];
  failureCases: string[];
  sourceType: "system_file" | "manual" | "agent_feedback" | "distillation";
  sourceId: string;
  status: AgentKnowledgeStatus;
  trustLevel: "system" | "reviewed" | "candidate";
  version: string;
  revision: number;
  checksum: string;
  publishedBy: string;
  publishedAt: string;
  usageCount: number;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
  canEdit?: boolean;
}

export interface AgentKnowledgeOverview {
  systemCount: number;
  managedCount: number;
  publishedCount: number;
  reviewCount: number;
  distillationCount: number;
  modules: string[];
  loadedAt: string;
  directory: string;
  errors: string[];
  retrievalMode: string;
  vectorEnabled: boolean;
  canPublish: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  version: string;
  category: string;
  description: string;
  status: "active" | "published" | "draft" | "archived";
  priority: number;
  triggers: string[];
  keywords: string[];
  modules: string[];
  toolRefs: string[];
  sourceType: "builtin" | "download" | "repository" | "marketplace" | "manual";
  acquisitionMethod: string;
  downloadUrl: string;
  extractionCode: string;
  installCommand: string;
  acquisitionInstructions: string;
  homepageUrl: string;
  author: string;
  license: string;
  directory: string;
  instructions?: string;
  matched?: boolean;
  resourceKind?: "system" | "download";
  usageGuide?: string;
  trainingGuide?: string;
  optimizationAdvice?: string;
  accessCount?: number;
  ownerId?: string;
  teamId?: string;
  createdAt?: string;
  updatedAt?: string;
  downloadAvailable?: boolean;
}

export interface AgentTuningInspection {
  goalSpec: {
    primaryAction: string;
    primaryDomain: string;
    subject: string;
    completionCriteria: string[];
    authorization: {
      readOnly: boolean;
      directExecution: boolean;
      delegatedFieldSynthesis: boolean;
      externalConfirmationRequired: boolean;
      destructiveConfirmationRequired: boolean;
    };
  };
  skills: Array<{ id: string; name: string; version: string; score: number; reasons: string[]; toolRefs: string[] }>;
  knowledge: Array<{ id: string; title: string; module: string; version: string; score: number; reasons: string[] }>;
  toolRefs: string[];
}

export type AgentTriggerEventType = "lead_overdue" | "customer_reply" | "stalled_deal" | "next_action_due" | "health_decline" | "communication_unread" | "prospect_completed";
export interface AgentTriggerRule {
  id: string;
  name: string;
  eventType: AgentTriggerEventType;
  mode: "notify" | "internal" | "approval";
  status: "active" | "paused";
  intervalMinutes: number;
  thresholdDays: number;
  healthBelow: number;
  maxPerScan: number;
  lastScanAt: string;
  lastTriggeredAt: string;
  nextScanAt: string;
}
export interface AgentTriggerEvent {
  id: string;
  ruleId: string;
  title: string;
  message: string;
  missionRunId: string;
  status: "mission_created" | "skipped" | "failed";
  createdAt: string;
}
export interface AgentGovernance {
  last24Hours: { calls: number; successes: number; failures: number; fallbackCalls: number; successRate: number; averageLatencyMs: number; totalTokens: number; estimatedCostUsd: number };
  budgets: { dailyUsd: number; missionUsd: number };
  routes: { planning: string; evaluation: string; fallbackEnabled: boolean };
  recentCalls: Array<{ id: string; purpose: "planning" | "evaluation"; provider: string; model: string; routeIndex: number; success: boolean; inputTokens: number; outputTokens: number; estimatedCostUsd: number; latencyMs: number; error: string; createdAt: string }>;
  evaluations: Array<{ id: string; version: string; passed: number; total: number; results: Array<{ id: string; name: string; passed: boolean; detail: string }>; createdAt: string }>;
}

interface OutreachSequenceStep {
  index: number;
  delayHours: number;
  subject: string;
  body: string;
  status: "pending" | "sending" | "sent" | "skipped" | "failed";
  scheduledAt: string;
  sentAt: string;
  error: string;
}

export interface OutreachSequence {
  id: string;
  missionRunId: string;
  entityName: string;
  recipient: string;
  channel: "email" | "communication";
  status: "active" | "paused" | "completed" | "stopped" | "cancelled" | "failed";
  currentStep: number;
  maxSends: number;
  steps: OutreachSequenceStep[];
  nextExecutionAt: string;
  lastSentAt: string;
  stopReason: string;
  createdAt: string;
}

export interface CustomerMaintenanceFinding {
  customerId: string;
  customerName: string;
  dealId: string;
  reasonCodes: string[];
  reason: string;
  priority: "high" | "medium" | "normal";
  triggerKey?: string;
  playbookActivationId?: string;
  playbookName?: string;
  playbookAction?: string;
}

interface CustomerMaintenanceTodoRef {
  id: string;
  title: string;
  customerId: string;
  dealId: string;
  priority: "high" | "medium" | "normal";
  done: boolean;
  dueAt: string;
  related: string;
  createdAt: string;
  triggerKey: string;
}

export interface CustomerMaintenanceFindingsView {
  watchId: string;
  name: string;
  status: "active" | "paused" | "cancelled" | "error";
  lastRunAt: string;
  lastMatchedCount: number;
  lastCreatedCount: number;
  lastSkippedCount: number;
  totalCreatedCount: number;
  findings: CustomerMaintenanceFinding[];
  todos: CustomerMaintenanceTodoRef[];
}

export interface CustomerMaintenancePreview {
  matchedCount: number;
  creatableCount: number;
  findings: CustomerMaintenanceFinding[];
  rules: CustomerMaintenanceWatch["rules"];
}

export interface CustomerMaintenanceWatch {
  id: string;
  missionRunId: string;
  name: string;
  status: "active" | "paused" | "cancelled" | "error";
  rules: {
    intervalHours: number;
    inactivityDays: number;
    healthBelow: number;
    includeOverdueReminder: boolean;
    includeMissingNextAction: boolean;
    grades: Array<"A" | "B" | "C" | "D">;
    maxTodosPerRun: number;
  };
  nextRunAt: string;
  lastRunAt: string;
  lastMatchedCount: number;
  lastCreatedCount: number;
  lastSkippedCount: number;
  totalCreatedCount: number;
  lastFindings: CustomerMaintenanceFinding[];
  lastError: string;
  createdAt: string;
}

export interface AgentUiAction {
  type: "navigate" | "open_customer" | "open_lead" | "open_development_email" | "open_communication" | "open_research" | "refresh";
  view?: string;
  customerId?: string;
  leadId?: string;
  entityType?: "customer" | "lead";
  entityId?: string;
}

export interface WhatsAppMessage {
  id: string;
  customerId: string;
  direction: "inbound" | "outbound";
  content: string;
  contentTranslated: string;
  mediaUrl: string;
  status: string;
  waMessageId: string;
  createdAt: string;
}

export interface WhatsAppBinding {
  id: string;
  customerId: string;
  phoneNumber: string;
  waProfileName: string;
  lastMessageAt: string;
  unreadCount: number;
  createdAt: string;
  bindingMode?: "web-scan" | "twilio-api" | "manual";
  userId?: string;
  sessionData?: string;
  twilioPhoneNumber?: string;
  connectionStatus?: "connected" | "disconnected" | "qr-pending" | "error";
  lastConnectedAt?: string;
}

export interface WhatsAppThread {
  customerId: string;
  company: string;
  country: string;
  contact: string;
  phoneNumber: string;
  waProfileName: string;
  unreadCount: number;
  lastMessage: string;
  lastMessageAt: string;
  messageCount: number;
  bindingMode: "web-scan" | "twilio-api" | "manual";
  connectionStatus: "connected" | "disconnected" | "qr-pending" | "error";
  canManage: boolean;
}

export interface WhatsAppModes {
  manual: { available: boolean; name: string; risk: string };
  webScan: { available: boolean; name: string; risk: string };
  twilioApi: { available: boolean; name: string; risk: string };
}

export interface ReportMoneyRow {
  currency: string;
  amount: number;
}

export interface ExecutiveReport {
  title: string;
  scope: { key: "self" | "team" | "global"; label: string };
  period: {
    label: string;
    start: string;
    end: string;
    forecastEnd: string;
    asOf: string;
    timezone: string;
  };
  amountBasis: {
    label: string;
    currencies: string[];
    exchangeRateApplied: boolean;
  };
  dataStatus: string;
  headline: string;
  note: string;
  reportNote: string;
  metrics: {
    activeDealCount: number;
    activePipeline: ReportMoneyRow[];
    weightedForecast: ReportMoneyRow[];
    expectedThisMonth: ReportMoneyRow[];
    wonThisMonth: ReportMoneyRow[];
    riskAmounts: ReportMoneyRow[];
    riskDealCount: number;
    winRate: number | null;
    closedCount: number;
  };
  conclusions: Array<{ title: string; detail: string }>;
  funnel: Array<{
    stage: string;
    count: number;
    amounts: ReportMoneyRow[];
    riskCount: number;
    weight: number;
    width: number;
  }>;
  market: Array<{
    region: string;
    count: number;
    share: number;
    amounts: ReportMoneyRow[];
    riskCount: number;
  }>;
  forecastByStage: Array<{
    stage: string;
    count: number;
    weight: number;
    weightedAmounts: ReportMoneyRow[];
  }>;
  performanceTitle: string;
  performance: Array<{
    ownerId: string;
    owner: string;
    customerCount: number;
    followUpCount: number;
    activeDealCount: number;
    forecastAmounts: ReportMoneyRow[];
    riskCount: number;
    riskLabel: string;
  }>;
  riskRows: Array<{
    id: string;
    customerId: string;
    title: string;
    customer: string;
    owner: string;
    stage: string;
    amount: number;
    currency: string;
    riskReasons: string[];
    nextAction: string;
    expectedCloseAt: string;
  }>;
  actions: Array<{ dealId: string; customerId: string; title: string; detail: string }>;
  definitions: string[];
}
