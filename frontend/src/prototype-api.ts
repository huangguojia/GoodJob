type Role = "sales" | "manager" | "admin" | "super_admin";
type DashboardPeriod = "today" | "week" | "month";

import * as XLSX from "xlsx";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([LineChart, GridComponent, TooltipComponent, SVGRenderer]);

let dashboardLeadFunnelChart: ReturnType<typeof echarts.init> | null = null;
let dashboardLeadFunnelResizeObserver: ResizeObserver | null = null;

interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
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
  lastDevelopmentEmailAt?: string;
  lastDevelopmentEmailTo?: string;
  lastDevelopmentEmailSubject?: string;
}

interface Customer {
  id: string;
  company: string;
  country: string;
  contact: string;
  stage: string;
  amount: number;
  health: number;
  nextReminder: string;
  wecomBound: boolean;
  billingName?: string;
  billingAddress?: string;
  documentContact?: string;
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

interface Todo {
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
}

interface Deal {
  id: string;
  customerId: string;
  title: string;
  stage: string;
  product?: string;
  quantity?: number;
  unitPrice?: number;
  amount: number;
  currency: string;
  amountType: "estimate" | "quoted" | "won";
  nextAction: string;
  nextActionAt: string;
  expectedCloseAt: string;
  stageChangedAt: string;
  closedAt?: string;
  wonReason?: string;
  lostReason?: string;
  lostReasonCategory?: string;
  revisitAt?: string;
  archivedAt?: string;
}

interface DealEvent {
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

interface Reminder {
  id: string;
  title: string;
  rule: string;
  dueAt: string;
  channel: string;
  status: string;
  ruleType?: string;
  targetStage?: string;
  days?: number;
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

interface ImportExportJob {
  id: string;
  name: string;
  type: string;
  rows: number;
  status: string;
  createdAt: string;
}

interface TradeDocumentItem {
  id: string;
  product: string;
  model: string;
  hsCode: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  originCountry: string;
  weightKg: number;
  packageCount: number;
}

interface TradeDocumentAudit {
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  operatorId: string;
  operatorName: string;
  createdAt: string;
}

interface TradeDocumentSendRecord {
  id: string;
  channel: "email" | "whatsapp" | "wechat" | "manual";
  recipient: string;
  message: string;
  operatorId: string;
  operatorName: string;
  createdAt: string;
}

interface TradeDocument {
  id: string;
  customerId: string;
  dealId: string;
  revision: number;
  type: "PI" | "CI";
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
  templateStyle: "executive" | "classic" | "compact";
  status: "draft" | "ready" | "pending_approval" | "approved" | "rejected" | "exported";
  approvalNote?: string;
  approvedAt?: string;
  approvedBy?: string;
  audits: TradeDocumentAudit[];
  sendRecords: TradeDocumentSendRecord[];
  updatedAt: string;
  items: TradeDocumentItem[];
}

type CommissionRuleType = "rate" | "fixed" | "tier" | "gross_profit" | "none";

interface CommissionProduct {
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

interface CommissionRule {
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

interface MonthlySalesRecord {
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

interface SalesRecordAudit {
  id: string;
  recordId: string;
  fieldName: string;
  oldValue: string;
  newValue: string;
  reason: string;
  operatorName: string;
  createdAt: string;
}

interface CommissionCalculation {
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

interface CommissionItem {
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

interface CommissionOwner {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string;
}

interface CustomerImportRow {
  company: string;
  country: string;
  contact: string;
  stage: string;
  amount: number;
  health: number;
  nextReminder: string;
  wecomBound: boolean;
}

interface KnowledgeAsset {
  id: string;
  title: string;
  category: string;
  status: string;
  ownerId: string;
  version: string;
}

interface Exam {
  id: string;
  title: string;
  category: string;
  status: string;
  passRate: number;
  questionCount: number;
  durationMinutes?: number;
  passScore?: number;
  targetRole?: "all" | "sales" | "manager";
  updatedAt?: string;
}

interface ExamQuestion {
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

interface ExamAttempt {
  id: string;
  examId: string;
  userId: string;
  score: number;
  passed: boolean;
  answers: Record<string, number | number[]>;
  correctCount: number;
  totalQuestions: number;
  submittedAt: string;
  examTitle?: string;
  category?: string;
  userName?: string;
}

interface ExamReport {
  totalAttempts: number;
  passedAttempts: number;
  retakeAttempts: number;
  averageScore: number;
  questionCount: number;
  categoryRows: Array<{ examId: string; title: string; category: string; participants: number; passRate: number; avgScore: number }>;
  difficultyRows: Array<{ difficulty: string; label: string; count: number; ratio: number }>;
  latestAttempts: ExamAttempt[];
}

interface ExamImportQuestion {
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

interface WecomMessage {
  id: string;
  summary: string;
  status: string;
}

interface OcrJob {
  id: string;
  status: string;
  confidence: number;
  fields: Record<string, string>;
  ownerId: string;
  teamId: string;
}

interface WebsiteOpportunity {
  id: string;
  company: string;
  business: string;
  country: string;
  website: string;
  contact: string;
  contactInfo: string;
  description: string;
  status: "preview" | "contactable" | "contacted" | "synced" | "excluded";
  createdAt: string;
  customerId?: string;
  dealId?: string;
  leadId?: string;
  parseMode?: "rule" | "ai" | "fallback";
  source?: string;
  sourceLabel?: string;
  confidence?: number;
  lastDevelopmentEmailAt?: string;
  lastDevelopmentEmailSubject?: string;
  lastDevelopmentEmailTo?: string;
  verifiedAt?: string;
  statusChangedAt?: string;
  excludedReason?: string;
  selected?: boolean;
  ownerId?: string;
  teamId?: string;
}

interface ProspectAssignee {
  id: string;
  name: string;
  role: string;
  teamId: string;
}

interface LeadProviderStatus {
  id: string;
  name: string;
  tier: "free" | "byok_free" | "paid" | "ai";
  category: "web" | "company" | "email" | "ai";
  requiresKey: boolean;
  capabilities: string[];
  docsUrl: string;
  keyHint: string;
  defaultBaseUrl: string;
  costNote: string;
  hasApiKey: boolean;
  ready: boolean;
  enabled: boolean;
  lastTestStatus: "untested" | "passed" | "failed";
  lastTestMessage: string;
  lastTestAt: string;
  usage: string;
}

interface LeadFinderJob {
  id: string;
  title: string;
  subtitle: string;
  status: "ready" | "running" | "done" | "needs_input";
  resultCount: number;
  channelCount: number;
  elapsedText: string;
  progress: number;
  steps: string[];
  createdAt: string;
  expanded?: boolean;
  resultIds?: string[];
  detailLines?: string[];
}

interface AiModelConfig {
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
  updatedAt: string;
}

interface ProblemItem {
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
}

interface Memo {
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

interface MemoDraft {
  title: string;
  content: string;
  category: string;
  tags: string;
  customerId: string;
  dealId: string;
  serverUpdatedAt: string;
  draftAt: string;
}

interface PlanTask {
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

interface PlanTemplate {
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

interface Competitor {
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

interface CaseStudy {
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

interface DashboardSummary {
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

interface Lead {
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
  convertedCustomerId: string;
  convertedDealId?: string;
  createdAt: string;
  deletedAt?: string;
  deletedReason?: string;
  deletedBy?: string;
  purgeAt?: string;
  statusBeforeDelete?: "new" | "following" | "converted" | "invalid";
}

interface LeadSourceEvent {
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

interface LeadConversionMatch {
  customer: Customer;
  score: number;
  reasons: string[];
  activeDealCount: number;
}

interface LeadSyncResult {
  lead: Lead;
  sourceEvent: unknown;
  opportunity: WebsiteOpportunity;
  duplicate: boolean;
}

interface LeadActivity {
  id: string;
  leadId: string;
  type: string;
  content: string;
  operatorId: string;
  nextFollowAt: string;
  createdAt: string;
}

interface WhatsAppMessage {
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

interface WhatsAppBinding {
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

interface WhatsAppThread {
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
}

interface ReportMoneyRow {
  currency: string;
  amount: number;
}

interface ExecutiveReport {
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

interface AppState {
  user: User | null;
  summary: DashboardSummary | null;
  customers: Customer[];
  leads: Lead[];
  leadTrash: Lead[];
  leadActivities: LeadActivity[];
  selectedLeadId: string | null;
  leadView: "active" | "trash";
  leadStageFilter: string;
  leadIntentFilter: string;
  leadSourceFilter: string;
  leadFollowFilter: string;
  leadSearch: string;
  leadPage: number;
  whatsappThreads: WhatsAppThread[];
  whatsappMessages: WhatsAppMessage[];
  whatsappBinding: WhatsAppBinding | null;
  selectedWaCustomerId: string | null;
  waThreadSearch: string;
  todos: Todo[];
  deals: Deal[];
  dealEvents: DealEvent[];
  closedDeals: Deal[];
  closedDealTotal: number;
  closedDealCounts: { won: number; lost: number; revisit: number };
  closedDealPage: number;
  closedDealKeyword: string;
  closedDealStatus: string;
  closedDealMonth: string;
  selectedDealId: string | null;
  pipelineStageFilter: string;
  pipelineSearch: string;
  pipelineDueFilter: string;
  reminders: Reminder[];
  reminderView: "tasks" | "rules";
  reminderFilter: "pending" | "overdue" | "today" | "future" | "snoozed" | "done";
  jobs: ImportExportJob[];
  tradeDocuments: TradeDocument[];
  wecomMessages: WecomMessage[];
  knowledgeAssets: KnowledgeAsset[];
  exams: Exam[];
  examQuestions: ExamQuestion[];
  examReport: ExamReport | null;
  ocrJob: OcrJob | null;
  websiteOpportunities: WebsiteOpportunity[];
  aiConfig: AiModelConfig | null;
  aiConfigs: AiModelConfig[];
  selectedAiConfigId: string | null;
  aiDraftMode: boolean;
  pendingAiDeleteId: string | null;
  problems: ProblemItem[];
  memos: Memo[];
  deletedMemos: Memo[];
  memoStatus: "active" | "archived" | "deleted";
  memoSearch: string;
  memoPinnedOnly: boolean;
  planTasks: PlanTask[];
  planTemplates: PlanTemplate[];
  selectedPlanTaskIds: string[];
  planTaskView: "today" | "week" | "templates";
  planTaskStatusFilter: "open" | "done" | "cancelled" | "all";
  competitors: Competitor[];
  caseStudies: CaseStudy[];
  commissionProducts: CommissionProduct[];
  commissionRules: CommissionRule[];
  commissionRecords: MonthlySalesRecord[];
  commissionCalculations: CommissionCalculation[];
  commissionItems: CommissionItem[];
  commissionCanManage: boolean;
  commissionCanReview: boolean;
  commissionCanSelectOwner: boolean;
  commissionOwners: CommissionOwner[];
  selectedCommissionOwnerId: string;
  commissionMonth: string;
  commissionFilter: "all" | "draft" | "confirmed";
  selectedCommissionRecordId: string | null;
  selectedCommissionCalculationId: string | null;
  accounts: User[];
  executiveReport: ExecutiveReport | null;
  reportNote: string;
  dashboardPeriod: DashboardPeriod;
  morningView: boolean;
  todoFilter: "all" | "today" | "overdue" | "mine" | "customer" | "history";
  openTodoMenuId: string | null;
  draggingTodoId: string | null;
  selectedCustomerId: string | null;
  selectedCustomerIds: string[];
  customerSearch: string;
  customerQueueFilter: "all" | "overdue" | "no-activity" | "no-deal";
  selectedProblemId: string | null;
  selectedMemoId: string | null;
  selectedPlanTemplateId: string | null;
  selectedCompetitorId: string | null;
  selectedCaseId: string | null;
  selectedExamId: string | null;
  selectedExamIds: string[];
  selectedQuestionId: string | null;
  selectedDocumentId: string | null;
  selectedLeadFinderId: string | null;
  leadFinderFilter: "all" | "pending" | "high" | "duplicate" | "synced";
  leadFinderPage: number;
  selectedProspectId: string | null;
  selectedProspectIds: string[];
  prospectFilter: "all" | "preview" | "contactable" | "contacted" | "synced" | "excluded";
  prospectPage: number;
  prospectAssignees: ProspectAssignee[];
  leadProviders: LeadProviderStatus[];
  selectedLeadSources: string[];
  leadSourceSelectionTouched: boolean;
}

const state: AppState = {
  user: null,
  summary: null,
  customers: [],
  leads: [],
  leadTrash: [],
  leadActivities: [],
  selectedLeadId: null,
  leadView: "active",
  leadStageFilter: "all",
  leadIntentFilter: "all",
  leadSourceFilter: "all",
  leadFollowFilter: "all",
  leadSearch: "",
  leadPage: 1,
  whatsappThreads: [],
  whatsappMessages: [],
  whatsappBinding: null,
  selectedWaCustomerId: null,
  waThreadSearch: "",
  todos: [],
  deals: [],
  dealEvents: [],
  closedDeals: [],
  closedDealTotal: 0,
  closedDealCounts: { won: 0, lost: 0, revisit: 0 },
  closedDealPage: 1,
  closedDealKeyword: "",
  closedDealStatus: "all",
  closedDealMonth: "",
  selectedDealId: null,
  pipelineStageFilter: "询盘",
  pipelineSearch: "",
  pipelineDueFilter: "all",
  reminders: [],
  reminderView: "tasks",
  reminderFilter: "pending",
  jobs: [],
  tradeDocuments: [],
  wecomMessages: [],
  knowledgeAssets: [],
  exams: [],
  examQuestions: [],
  examReport: null,
  ocrJob: null,
  websiteOpportunities: [],
  aiConfig: null,
  aiConfigs: [],
  selectedAiConfigId: null,
  aiDraftMode: false,
  pendingAiDeleteId: null,
  problems: [],
  memos: [],
  deletedMemos: [],
  memoStatus: "active",
  memoSearch: "",
  memoPinnedOnly: false,
  planTasks: [],
  planTemplates: [],
  selectedPlanTaskIds: [],
  planTaskView: "today",
  planTaskStatusFilter: "open",
  competitors: [],
  caseStudies: [],
  commissionProducts: [],
  commissionRules: [],
  commissionRecords: [],
  commissionCalculations: [],
  commissionItems: [],
  commissionCanManage: false,
  commissionCanReview: false,
  commissionCanSelectOwner: false,
  commissionOwners: [],
  selectedCommissionOwnerId: "",
  commissionMonth: new Date().toISOString().slice(0, 7),
  commissionFilter: "all",
  selectedCommissionRecordId: null,
  selectedCommissionCalculationId: null,
  accounts: [],
  executiveReport: null,
  reportNote: "",
  dashboardPeriod: "today",
  morningView: false,
  todoFilter: "all",
  openTodoMenuId: null,
  draggingTodoId: null,
  selectedCustomerId: null,
  selectedCustomerIds: [],
  customerSearch: "",
  customerQueueFilter: "all",
  selectedProblemId: null,
  selectedMemoId: null,
  selectedPlanTemplateId: null,
  selectedCompetitorId: null,
  selectedCaseId: null,
  selectedExamId: null,
  selectedExamIds: [],
  selectedQuestionId: null,
  selectedDocumentId: null,
  selectedLeadFinderId: null,
  leadFinderFilter: "all",
  leadFinderPage: 1,
  selectedProspectId: null,
  selectedProspectIds: [],
  prospectFilter: "all",
  prospectPage: 1,
  prospectAssignees: [],
  leadProviders: [],
  selectedLeadSources: [],
  leadSourceSelectionTouched: false
};

let memoDirty = false;
let memoSaving = false;
let memoSavePromise: Promise<void> | null = null;
let memoSaveTimer = 0;
let memoEditRevision = 0;
let memoMobileDetailOpen = false;
let memoDeleteBusy = false;
const resolvedMemoDrafts = new Set<string>();
let leadFinderJobs: LeadFinderJob[] = [];
let customerClockTimer = 0;
let openWorkspaceTabs = ["dashboard"];
let workspaceTabHistory = ["dashboard"];

const viewLabels: Record<string, string> = {
  dashboard: "工作台",
  "lead-finder": "自动获客",
  "prospect-list": "搜客清单",
  customers: "客户",
  pipeline: "商机",
  reminders: "跟进提醒",
  "instrument-growth": "计划任务",
  documents: "单据平台",
  commission: "提成对账",
  reports: "报表",
  knowledge: "资料维护",
  exam: "在线考试",
  "question-bank": "题库维护",
  wecom: "企业微信",
  tools: "小工具",
  competitors: "竞争公司",
  cases: "成功案例",
  problems: "问题清单",
  memos: "备忘录",
  imports: "导入导出",
  "ai-config": "AI配置",
  settings: "系统设置",
  profile: "个人设置"
};

const aiProviderPresets: Record<string, {
  label: string;
  protocol: AiModelConfig["protocol"];
  baseUrl: string;
  model: string;
  name: string;
}> = {
  openai: { label: "OpenAI", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", name: "OpenAI 业务模型" },
  anthropic: { label: "Claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet-latest", name: "Claude 长文本模型" },
  gemini: { label: "Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-1.5-flash", name: "Gemini 国际化模型" },
  deepseek: { label: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", name: "DeepSeek 搜客解析模型" },
  qwen: { label: "通义千问", protocol: "openai-compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", name: "通义千问业务模型" },
  moonshot: { label: "Kimi", protocol: "openai-compatible", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", name: "Kimi 业务模型" },
  zhipu: { label: "智谱GLM", protocol: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", name: "智谱GLM业务模型" },
  baidu: { label: "百度千帆", protocol: "openai-compatible", baseUrl: "https://qianfan.baidubce.com/v2", model: "ernie-4.0-turbo-8k", name: "百度千帆业务模型" },
  volcengine: { label: "豆包", protocol: "openai-compatible", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-pro-32k", name: "豆包业务模型" },
  mistral: { label: "Mistral", protocol: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest", name: "Mistral 业务模型" },
  groq: { label: "Groq", protocol: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.1-70b-versatile", name: "Groq 高速模型" },
  openrouter: { label: "OpenRouter", protocol: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", name: "OpenRouter 聚合模型" },
  ollama: { label: "Ollama", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", name: "本地 Ollama 模型" },
  custom: { label: "自定义", protocol: "openai-compatible", baseUrl: "https://example.com/v1", model: "your-model-name", name: "自定义兼容模型" }
};

const roleLabel: Record<Role, string> = {
  sales: "业务员",
  manager: "销售主管",
  admin: "管理员",
  super_admin: "超级管理员"
};

const storage = {
  user: "gj_user",
  dashboardCache: "gj_dashboard_cache"
};

function cookieValue(name: string) {
  return document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

function qs<T extends Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector(selector) as T | null;
}

function qsa<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll(selector)] as T[];
}

function setFieldValue(selector: string, value: string) {
  const input = qs<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
  if (input) input.value = value;
}

function money(value: number) {
  return `$${Math.round(value / 1000)}k`;
}

function amount(value: number) {
  return `$${value.toLocaleString("en-US")}`;
}

function currencyAmount(value: number, currency = "CNY") {
  return `${escapeHtml(currency)} ${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function currentDateTimeText() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function todayStart() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseTodoDate(value: string) {
  const text = value.trim();
  const exact = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/);
  if (exact) {
    const [, year, month, day, hour = "0", minute = "0"] = exact;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  }
  const base = todayStart();
  if (/^(\d{1,2}):(\d{2})$/.test(text) || text.includes("今天")) return base;
  if (text.includes("昨天")) return new Date(base.getTime() - 86400000);
  if (text.includes("前天")) return new Date(base.getTime() - 86400000 * 2);
  if (text.includes("明天")) return new Date(base.getTime() + 86400000);
  return null;
}

function isHistoricalTodo(todo: Todo) {
  return Boolean(todo.historyAt);
}

function todoCreatedTime(todo: Todo, fallbackIndex = 0) {
  if (todo.createdAt) {
    const parsed = new Date(todo.createdAt).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  const idTime = todo.id.match(/^t_(\d{10,})$/);
  if (idTime) return Number(idTime[1]);
  const due = parseTodoDate(todo.dueAt)?.getTime();
  if (due && Number.isFinite(due)) return due;
  return -fallbackIndex;
}

function sortTodos(todos: Todo[]) {
  return todos
    .map((todo, index) => ({ todo, index }))
    .sort((left, right) => {
      if (left.todo.done !== right.todo.done) return left.todo.done ? 1 : -1;
      const leftOrder = typeof left.todo.sortOrder === "number" ? left.todo.sortOrder : 0;
      const rightOrder = typeof right.todo.sortOrder === "number" ? right.todo.sortOrder : 0;
      if (leftOrder || rightOrder) return leftOrder - rightOrder || todoCreatedTime(right.todo, right.index) - todoCreatedTime(left.todo, left.index);
      return todoCreatedTime(right.todo, right.index) - todoCreatedTime(left.todo, left.index);
    })
    .map((item) => item.todo);
}

function activeTodos(todos: Todo[]) {
  return sortTodos(todos.filter((todo) => !isHistoricalTodo(todo)));
}

function historyTodos(todos: Todo[]) {
  return sortTodos(todos.filter(isHistoricalTodo));
}

function badge(text: string, tone = "") {
  return `<span class="badge ${tone}">${text}</span>`;
}

function todoTypeText(type: string) {
  const map: Record<string, string> = {
    customer: "客户跟进",
    knowledge: "资料维护",
    exam: "在线考试",
    ocr: "OCR 线索",
    other: "其它"
  };
  return map[type] || "其它";
}

function escapeHtml(value: string | number | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function ensureUiLayer() {
  if (!qs(".toast-stack")) {
    document.body.insertAdjacentHTML("beforeend", `<div class="toast-stack" aria-live="polite"></div>`);
  }
  if (!qs("#appModal")) {
    document.body.insertAdjacentHTML("beforeend", `
      <div class="modal-backdrop" id="appModal" role="dialog" aria-modal="true">
        <div class="modal">
          <div class="modal-head"><h2 id="modalTitle">操作</h2><button class="btn icon-only" data-modal-close title="关闭">×</button></div>
          <div class="modal-body" id="modalBody"></div>
          <div class="modal-foot" id="modalFoot"></div>
        </div>
      </div>
    `);
    qs("[data-modal-close]")?.addEventListener("click", closeModal);
  }
}

function toast(message: string, type: "ok" | "error" = "ok") {
  ensureUiLayer();
  const stack = qs<HTMLElement>(".toast-stack")!;
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  stack.appendChild(item);
  window.setTimeout(() => item.remove(), 2600);
}

function openModal(title: string, body: string, foot: string) {
  ensureUiLayer();
  qs("#modalTitle")!.textContent = title;
  qs("#modalBody")!.innerHTML = body;
  qs("#modalFoot")!.innerHTML = foot;
  qsa("[data-modal-close]", qs("#appModal")!).forEach((node) => node.addEventListener("click", closeModal));
  qs("#appModal")!.classList.add("active");
}

function closeModal() {
  qs("#appModal")?.classList.remove("active");
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || "GET").toUpperCase();
  const csrfToken = cookieValue("gj_csrf");
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: "请求失败" }));
    if (response.status === 401 && path !== "/api/auth/login") {
      localStorage.removeItem(storage.user);
      state.user = null;
      document.body.classList.remove("is-authenticated");
    }
    throw new Error(body.message || "请求失败");
  }
  return response.json() as Promise<T>;
}

async function loginWithPassword(email: string, password: string) {
  const result = await api<{ user: User }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  localStorage.setItem(storage.user, JSON.stringify(result.user));
  state.user = result.user;
  applyAuthedUser(result.user);
  document.body.classList.add("is-authenticated");
  await refreshAll(result.user);
  toast(`已登录：${result.user.name}`);
}

function applyAuthedUser(user: User) {
  const profileName = `${user.name} / ${roleLabel[user.role]}`;
  document.body.dataset.role = user.role;
  qs("#scopeUser")!.textContent = profileName;
  qs("#scopeText")!.textContent = user.role === "sales" ? "仅本人业务与本人待办" : user.role === "manager" ? "团队业务数据，本人待办私有" : user.role === "admin" ? "全局业务数据、账号管理，本人待办私有" : "全局业务数据、最高账号权限，本人待办私有";
  qs("#currentAvatar")!.textContent = user.avatar;
  const topUserName = qs<HTMLElement>("#topUserName");
  const topUserRole = qs<HTMLElement>("#topUserRole");
  if (topUserName) topUserName.textContent = user.name;
  if (topUserRole) topUserRole.textContent = roleLabel[user.role];
  syncTrainingManagementUi(user);
  renderProfile(user);
}

function canManageTrainingUi(user = state.user) {
  return user?.role === "manager" || user?.role === "admin" || user?.role === "super_admin";
}

function syncTrainingManagementUi(user = state.user) {
  const canManage = canManageTrainingUi(user);
  qsa<HTMLElement>("#exam .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("发布考试") || button.textContent?.includes("题库维护") || button.textContent?.includes("分类目考试维护")) {
      button.classList.toggle("is-hidden", !canManage);
    }
  });
}

function roleScopeText(user: User) {
  if (user.role === "sales") return "仅本人业务与本人待办";
  if (user.role === "manager") return "团队业务数据，本人待办私有";
  if (user.role === "admin") return "全局业务数据、账号管理，本人待办私有";
  return "全局业务数据、最高账号权限，本人待办私有";
}

function updateProfileSmtpHints(user = state.user) {
  const passwordInput = qs<HTMLInputElement>("#profileSmtpPassword");
  const passwordHint = qs<HTMLElement>("#profileSmtpPasswordHint");
  const configHint = qs<HTMLElement>("#profileSmtpConfigHint");
  const port = Number(qs<HTMLInputElement>("#profileSmtpPort")?.value || user?.smtpPort || 465);
  const secure = qs<HTMLSelectElement>("#profileSmtpSecure")?.value !== "false";
  if (passwordInput) {
    passwordInput.placeholder = user?.hasSmtpPassword ? "已保存授权码；输入新授权码可覆盖" : "输入授权码后保存";
  }
  if (passwordHint) {
    passwordHint.className = user?.hasSmtpPassword ? "ok" : "";
    passwordHint.textContent = user?.hasSmtpPassword ? "授权码已保存到数据库，出于安全不会明文回显；留空保存会保留原授权码。" : "授权码保存后不会明文回显；QQ/企业邮箱通常需要专用授权码，不是网页登录密码。";
  }
  if (configHint) {
    if (port === 587 && secure) {
      configHint.className = "warn";
      configHint.textContent = "当前是 587 + SSL/TLS，通常会连接失败；请改为 STARTTLS/普通，或把端口改成 465。";
    } else if (port === 465 && !secure) {
      configHint.className = "warn";
      configHint.textContent = "当前是 465 + STARTTLS/普通，通常会连接失败；请改为 SSL/TLS，或把端口改成 587。";
    } else {
      configHint.className = "ok";
      configHint.textContent = port === 587 ? "587 建议使用 STARTTLS/普通；配置组合看起来正常。" : port === 465 ? "465 建议使用 SSL/TLS；配置组合看起来正常。" : "非标准端口，请确认服务商要求的加密方式。";
    }
  }
}

function renderProfile(user = state.user) {
  if (!user) return;
  const avatar = qs<HTMLElement>("#profileAvatarLarge");
  const name = qs<HTMLElement>("#profileNameTitle");
  const role = qs<HTMLElement>("#profileRoleText");
  const status = qs<HTMLElement>("#profileEmailStatus");
  const signatureStatus = qs<HTMLElement>("#profileSignatureStatus");
  const teamText = user.teamId === "all" ? "全局团队" : `${user.teamId} 组`;
  const mailReady = Boolean(user.outboundEmail);
  if (avatar) avatar.textContent = user.avatar;
  if (name) name.textContent = user.name;
  if (role) role.textContent = `${roleLabel[user.role]} · ${roleScopeText(user)}`;
  qs<HTMLElement>("#profileStatusBadge")!.textContent = "账号正常";
  qs<HTMLElement>("#profileTeamBadge")!.textContent = teamText;
  const emailBadge = qs<HTMLElement>("#profileEmailBadge");
  if (emailBadge) {
    emailBadge.className = `badge ${mailReady ? "green" : "amber"}`;
    emailBadge.textContent = mailReady ? "发件邮箱已绑定" : "发件邮箱待绑定";
  }
  qs<HTMLElement>("#profileScopeMetric")!.textContent = user.role === "sales" ? "本人业务" : user.role === "manager" ? "团队业务" : "全局业务";
  qs<HTMLElement>("#profileRoleMetric")!.textContent = roleLabel[user.role];
  qs<HTMLElement>("#profileMailMetric")!.textContent = mailReady && user.smtpHost && user.hasSmtpPassword ? "可真实发信" : mailReady ? "待配SMTP" : "未绑定";
  qs<HTMLElement>("#profileLoginEmailText")!.textContent = user.email;
  qs<HTMLElement>("#profileIdText")!.textContent = user.id;
  qs<HTMLElement>("#profileScopeText")!.textContent = roleScopeText(user);
  setFieldValue("#profileLoginEmail", user.email);
  setFieldValue("#profileOutboundEmail", user.outboundEmail || "");
  setFieldValue("#profileSenderName", user.emailSenderName || "");
  setFieldValue("#profileEmailSignature", user.emailSignature || "");
  setFieldValue("#profileSmtpHost", user.smtpHost || "");
  setFieldValue("#profileSmtpPort", String(user.smtpPort || 465));
  setFieldValue("#profileSmtpUser", user.smtpUser || "");
  setFieldValue("#profileSmtpPassword", "");
  setFieldValue("#profileTestEmailTo", "");
  const smtpSecure = qs<HTMLSelectElement>("#profileSmtpSecure");
  if (smtpSecure) smtpSecure.value = String(user.smtpSecure ?? true);
  if (status) status.innerHTML = user.outboundEmail ? `${badge("已绑定", "green")} ${escapeHtml(user.outboundEmail)}` : `${badge("未绑定", "amber")} 请先绑定发件邮箱`;
  if (signatureStatus) signatureStatus.innerHTML = user.emailSignature?.trim() ? `${badge("已设置", "green")} ${escapeHtml((user.emailSignature.split("\n")[0] || "签名已维护").slice(0, 36))}` : `${badge("待完善", "amber")} 建议补充英文签名`;
  const smtpStatus = qs<HTMLElement>("#profileSmtpStatus");
  if (smtpStatus) smtpStatus.innerHTML = user.smtpHost && user.smtpUser && user.hasSmtpPassword ? `${badge("已配置", "green")} ${escapeHtml(user.smtpHost)}` : `${badge("未完整", "amber")} 填写SMTP后才能真实发信`;
  updateProfileSmtpHints(user);
}

function collectDevelopmentEmailDraft() {
  const sender = qs<HTMLInputElement>("#profileSenderName")?.value.trim() || state.user?.name || "GoodJob Sales";
  const from = qs<HTMLInputElement>("#profileOutboundEmail")?.value.trim() || state.user?.outboundEmail || "";
  const signature = qs<HTMLTextAreaElement>("#profileEmailSignature")?.value.trim() || "";
  return {
    to: qs<HTMLInputElement>("#devEmailTo")?.value.trim() || "",
    company: qs<HTMLInputElement>("#devEmailCompany")?.value.trim() || "",
    subject: qs<HTMLInputElement>("#devEmailSubject")?.value.trim() || "",
    body: qs<HTMLTextAreaElement>("#devEmailBody")?.value.trim() || "",
    sender,
    from,
    signature
  };
}

function generateDevelopmentEmailDraft() {
  const company = qs<HTMLInputElement>("#devEmailCompany")?.value.trim() || "your company";
  const sender = qs<HTMLInputElement>("#profileSenderName")?.value.trim() || state.user?.name || "GoodJob Sales";
  const signature = qs<HTMLTextAreaElement>("#profileEmailSignature")?.value.trim() || `Best regards,\n${sender}`;
  const body = [
    `Dear ${company} team,`,
    "",
    "We supply pressure, temperature, flow and level instruments for distributors, system integrators and industrial projects.",
    "If you are evaluating instrumentation suppliers for your local market, we can support product selection, certificates, technical datasheets and quotation for your project requirements.",
    "",
    "Could you share the main product categories you are currently sourcing and the applications you are focused on?",
    "",
    signature
  ].join("\n");
  const input = qs<HTMLTextAreaElement>("#devEmailBody");
  if (input) input.value = body;
  renderDevelopmentEmailPreview();
}

function renderDevelopmentEmailPreview() {
  const draft = collectDevelopmentEmailDraft();
  const preview = qs<HTMLElement>("#devEmailPreview");
  if (!preview) return;
  preview.textContent = [
    `From: ${draft.sender}${draft.from ? ` <${draft.from}>` : " <未绑定>"}`,
    `To: ${draft.to || "未填写"}`,
    `Subject: ${draft.subject || "未填写"}`,
    "",
    draft.body || "填写内容后可预览开发信。"
  ].join("\n");
}

function updateStoredUser(user: User) {
  state.user = user;
  localStorage.setItem(storage.user, JSON.stringify(user));
  applyAuthedUser(user);
}

async function saveProfileEmailBinding(button?: HTMLButtonElement, clearSmtpPassword = false) {
  const outboundEmail = qs<HTMLInputElement>("#profileOutboundEmail")?.value.trim() || "";
  const emailSenderName = qs<HTMLInputElement>("#profileSenderName")?.value.trim() || "";
  const emailSignature = qs<HTMLTextAreaElement>("#profileEmailSignature")?.value.trim() || "";
  const smtpHost = qs<HTMLInputElement>("#profileSmtpHost")?.value.trim() || "";
  const smtpPort = Number(qs<HTMLInputElement>("#profileSmtpPort")?.value || 465);
  const smtpSecure = qs<HTMLSelectElement>("#profileSmtpSecure")?.value !== "false";
  const smtpUser = qs<HTMLInputElement>("#profileSmtpUser")?.value.trim() || "";
  const smtpPassword = qs<HTMLInputElement>("#profileSmtpPassword")?.value || "";
  const idleText = clearSmtpPassword ? "清空邮箱绑定" : "保存个人资料";
  if (button) {
    button.disabled = true;
    button.textContent = clearSmtpPassword ? "清空中" : "保存中";
  }
  try {
    const result = await api<{ user: User }>("/api/profile/email-binding", {
      method: "PATCH",
      body: JSON.stringify({ outboundEmail, emailSenderName, emailSignature, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, clearSmtpPassword })
    });
    updateStoredUser(result.user);
    toast(outboundEmail ? "个人邮箱配置已保存" : "个人邮箱配置已清空");
  } catch (error) {
    toast(error instanceof Error ? error.message : "个人邮箱配置保存失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = idleText;
    }
  }
}

async function clearProfileEmailBinding(button?: HTMLButtonElement) {
  if (!window.confirm("确认清空发件邮箱、SMTP配置、授权码和邮件签名？")) return;
  setFieldValue("#profileOutboundEmail", "");
  setFieldValue("#profileSenderName", "");
  setFieldValue("#profileEmailSignature", "");
  setFieldValue("#profileSmtpHost", "");
  setFieldValue("#profileSmtpPort", "465");
  setFieldValue("#profileSmtpUser", "");
  setFieldValue("#profileSmtpPassword", "");
  setFieldValue("#profileTestEmailTo", "");
  await saveProfileEmailBinding(button, true);
}

async function sendProfileTestEmail(button?: HTMLButtonElement) {
  const to = qs<HTMLInputElement>("#profileTestEmailTo")?.value.trim() || "";
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ ok: boolean; simulated: boolean; messageId?: string; to?: string }>("/api/profile/test-email", {
      method: "POST",
      body: JSON.stringify({ to })
    });
    toast(result.simulated ? "测试邮件已生成（测试环境未外发）" : "测试邮件已发送，请检查发件邮箱收件箱");
  } catch (error) {
    toast(error instanceof Error ? error.message : "测试邮件发送失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "发送测试邮件";
    }
  }
}

async function sendDevelopmentEmail(button?: HTMLButtonElement) {
  const draft = collectDevelopmentEmailDraft();
  if (!draft.from) {
    toast("请先绑定发件邮箱", "error");
    return;
  }
  if (!draft.to || !draft.company || !draft.subject || draft.body.length < 10) {
    toast("请补齐收件邮箱、目标公司、主题和正文", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ sent: { simulated: boolean }; user: User }>("/api/profile/send-development-email", {
      method: "POST",
      body: JSON.stringify({ to: draft.to, company: draft.company, subject: draft.subject, body: draft.body })
    });
    updateStoredUser(result.user);
    toast(result.sent.simulated ? "开发信已发送（系统模拟记录）" : "开发信已发送");
  } catch (error) {
    toast(error instanceof Error ? error.message : "开发信发送失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "发送开发信";
    }
  }
}

async function refreshAll(user: User) {
  renderDashboardCache(user);
  const [summary, customers, leadsResp, leadTrashResp, todos, deals, reminders, jobs, tradeDocs, wecom, knowledge, exams, ocr, websiteOps, prospectAssignees, aiConfig, problems, memos, deletedMemos, planTasks, planTemplates, competitors, caseStudies, commissionProducts, commissionRecords, commissionCalculations] = await Promise.all([
    api<DashboardSummary>("/api/dashboard/summary"),
    api<{ customers: Customer[] }>("/api/customers"),
    api<{ leads: Lead[] }>("/api/leads"),
    api<{ leads: Lead[] }>("/api/leads?trash=true"),
    api<{ todos: Todo[] }>("/api/todos"),
    api<{ deals: Deal[]; events: DealEvent[] }>("/api/deals"),
    api<{ reminders: Reminder[] }>("/api/reminders"),
    api<{ jobs: ImportExportJob[] }>("/api/import-export/jobs"),
    api<{ documents: TradeDocument[] }>("/api/trade-documents"),
    api<{ messages: WecomMessage[] }>("/api/wecom/messages"),
    api<{ assets: KnowledgeAsset[] }>("/api/knowledge/assets"),
    api<{ exams: Exam[]; report: ExamReport }>("/api/exams"),
    api<{ job: OcrJob }>("/api/tools/ocr/jobs/ocr1"),
    api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-opportunities"),
    api<{ assignees: ProspectAssignee[] }>("/api/prospect-list/assignees"),
    api<{ config: AiModelConfig | null; configs?: AiModelConfig[] }>("/api/tools/ai-config"),
    api<{ problems: ProblemItem[] }>("/api/problems"),
    api<{ memos: Memo[] }>("/api/memos"),
    api<{ memos: Memo[] }>("/api/memos?trash=true"),
    api<{ tasks: PlanTask[] }>("/api/plan-tasks"),
    api<{ templates: PlanTemplate[] }>("/api/plan-templates"),
    api<{ competitors: Competitor[] }>("/api/competitors"),
    api<{ caseStudies: CaseStudy[] }>("/api/case-studies"),
    api<{ products: CommissionProduct[]; rules: CommissionRule[]; canManage: boolean; canSelectOwner: boolean; owners: CommissionOwner[] }>("/api/commission/products"),
    api<{ records: MonthlySalesRecord[]; owners?: CommissionOwner[]; canSelectOwner?: boolean; selectedOwnerId?: string }>(`/api/commission/sales-records?month=${encodeURIComponent(state.commissionMonth)}&ownerId=${encodeURIComponent(state.selectedCommissionOwnerId || "")}`),
    api<{ calculations: CommissionCalculation[]; items: CommissionItem[]; canReview: boolean; canSelectOwner?: boolean; owners?: CommissionOwner[]; selectedOwnerId?: string }>(`/api/commission/calculations?month=${encodeURIComponent(state.commissionMonth)}&ownerId=${encodeURIComponent(state.selectedCommissionOwnerId || "")}`)
  ]);
  state.user = user;
  state.summary = summary;
  state.customers = customers.customers;
  state.leads = leadsResp.leads;
  state.leadTrash = leadTrashResp.leads;
  state.todos = todos.todos;
  state.deals = deals.deals;
  state.dealEvents = deals.events;
  state.reminders = reminders.reminders;
  state.jobs = jobs.jobs;
  state.tradeDocuments = tradeDocs.documents;
  state.wecomMessages = wecom.messages;
  state.knowledgeAssets = knowledge.assets;
  state.exams = exams.exams;
  state.examReport = exams.report;
  state.ocrJob = ocr.job;
  state.websiteOpportunities = websiteOps.opportunities;
  state.prospectAssignees = prospectAssignees.assignees;
  state.aiConfig = aiConfig.config;
  state.aiConfigs = aiConfig.configs || (aiConfig.config ? [aiConfig.config] : []);
  state.selectedAiConfigId = state.selectedAiConfigId && state.aiConfigs.some((item) => item.id === state.selectedAiConfigId)
    ? state.selectedAiConfigId
    : state.aiConfig?.id || state.aiConfigs[0]?.id || null;
  state.problems = problems.problems;
  state.memos = memos.memos;
  state.deletedMemos = deletedMemos.memos;
  state.planTasks = planTasks.tasks;
  state.planTemplates = planTemplates.templates;
  state.competitors = competitors.competitors;
  state.caseStudies = caseStudies.caseStudies;
  state.commissionProducts = commissionProducts.products;
  state.commissionRules = commissionProducts.rules;
  state.commissionCanManage = commissionProducts.canManage;
  state.commissionCanSelectOwner = commissionProducts.canSelectOwner;
  state.commissionOwners = commissionProducts.owners || commissionRecords.owners || commissionCalculations.owners || [];
  state.selectedCommissionOwnerId = state.commissionCanSelectOwner
    ? (commissionRecords.selectedOwnerId || commissionCalculations.selectedOwnerId || state.selectedCommissionOwnerId || "all")
    : (state.user?.id || "");
  state.commissionRecords = commissionRecords.records;
  state.commissionCalculations = commissionCalculations.calculations;
  state.commissionItems = commissionCalculations.items;
  state.commissionCanReview = commissionCalculations.canReview;
  state.selectedCustomerId = state.selectedCustomerId || customers.customers[0]?.id || null;
  state.selectedProblemId = state.selectedProblemId || problems.problems[0]?.id || null;
  state.selectedMemoId = state.selectedMemoId || memos.memos[0]?.id || null;
  state.selectedCompetitorId = state.selectedCompetitorId || competitors.competitors[0]?.id || null;
  state.selectedCaseId = state.selectedCaseId || caseStudies.caseStudies[0]?.id || null;
  state.selectedExamId = state.selectedExamId || exams.exams[0]?.id || null;
  state.selectedDocumentId = state.selectedDocumentId || tradeDocs.documents[0]?.id || null;
  writeDashboardCache(user, summary, todos.todos, customers.customers);
  renderDashboard(summary, todos.todos, customers.customers);
  renderCustomers(customers.customers);
  renderLeads();
  renderPipeline(deals.deals);
  void refreshClosedDeals();
  renderReminders(reminders.reminders);
  renderJobs(jobs.jobs);
  renderTradeDocuments(tradeDocs.documents);
  renderWecom(wecom.messages);
  renderKnowledge(knowledge.assets);
  renderExams(exams.exams);
  renderDashboardKnowledgePanels(knowledge.assets, exams.exams);
  renderProblems(problems.problems);
  renderMemos();
  renderPlanTasks(planTasks.tasks);
  renderPlanTemplates(planTemplates.templates);
  renderCompetitors(competitors.competitors);
  renderCaseStudies(caseStudies.caseStudies);
  renderCommission();
  await renderAccounts(user);
  renderOcr(ocr.job);
  renderAiConfig(state.aiConfig);
  renderWebsiteOpportunities(state.websiteOpportunities);
  renderLeadFinder(state.websiteOpportunities);
  renderProspectList();
  renderTopbarStats();
  void loadLeadProviders();
  void reloadWhatsAppThreads();
}

async function loadLeadProviders() {
  try {
    const result = await api<{ providers: LeadProviderStatus[] }>("/api/lead-finder/providers");
    state.leadProviders = result.providers || [];
    if (!state.leadSourceSelectionTouched) {
      // 默认选中：所有免费源 + 已配置启用的源
      // AI 搜索按 token 计费，默认不自动勾选，由用户按需开启
    state.selectedLeadSources = state.leadProviders.filter((item) => item.ready && item.enabled && item.id !== "ai_search").map((item) => item.id);
    }
    renderLeadSourceChips();
  } catch {
    // 数据源加载失败时保留兜底提示，不影响主流程
  }
}

function dashboardCacheKey(user: User) {
  return `${user.id}:${user.role}:${user.teamId}`;
}

function readDashboardCache(user: User) {
  try {
    const raw = localStorage.getItem(storage.dashboardCache);
    if (!raw) return null;
    const cache = JSON.parse(raw) as Record<string, { summary: DashboardSummary; todos: Todo[]; customers: Customer[]; cachedAt: string }>;
    const item = cache[dashboardCacheKey(user)];
    if (!item) return null;
    const age = Date.now() - new Date(item.cachedAt).getTime();
    return age < 5 * 60 * 1000 ? item : null;
  } catch {
    return null;
  }
}

function writeDashboardCache(user: User, summary: DashboardSummary, todos: Todo[], customers: Customer[]) {
  try {
    const raw = localStorage.getItem(storage.dashboardCache);
    const cache = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    cache[dashboardCacheKey(user)] = { summary, todos, customers, cachedAt: new Date().toISOString() };
    localStorage.setItem(storage.dashboardCache, JSON.stringify(cache));
  } catch {
    // Cache is an optimization; rendering must not depend on it.
  }
}

function renderDashboardCache(user: User) {
  const cached = readDashboardCache(user);
  if (!cached) return;
  state.summary = cached.summary;
  state.todos = cached.todos;
  state.customers = cached.customers;
  renderDashboard(cached.summary, cached.todos, cached.customers, true);
  renderTopbarStats();
}

async function refreshDashboardOnly() {
  if (!state.user) return;
  const [summary, todos, customers] = await Promise.all([
    api<DashboardSummary>("/api/dashboard/summary"),
    api<{ todos: Todo[] }>("/api/todos"),
    api<{ customers: Customer[] }>("/api/customers")
  ]);
  state.summary = summary;
  state.todos = todos.todos;
  state.customers = customers.customers;
  writeDashboardCache(state.user, summary, todos.todos, customers.customers);
  renderDashboard(summary, todos.todos, customers.customers);
  renderTopbarStats();
}

function renderDashboard(summary: DashboardSummary, todos: Todo[], customers: Customer[], fromCache = false) {
  const roleBusinessScope = state.user?.role === "manager" ? "团队业务" : state.user && ["admin", "super_admin"].includes(state.user.role) ? "全局业务" : "本人业务";
  const scopeLabels = summary.scopeLabels || {
    business: roleBusinessScope,
    todos: "本人待办"
  };
  qs("#scopeText")!.textContent = summary.scope;
  qs<HTMLElement>("#businessScopeTag")!.textContent = scopeLabels.business;
  qs<HTMLElement>("#todoScopeTag")!.textContent = scopeLabels.todos;
  qsa<HTMLElement>("[data-business-scope]").forEach((node) => {
    node.textContent = scopeLabels.business;
  });
  const period = summary.periods?.[state.dashboardPeriod] || {
    label: "今日",
    start: summary.updatedAt.slice(0, 10),
    end: summary.updatedAt.slice(0, 10),
    expectedDeals: summary.briefing.closableDeals,
    expectedAmounts: [{ currency: "USD", amount: summary.briefing.closableAmount }],
    pendingTodos: summary.metrics.todos,
    highPriorityTodos: summary.metrics.overdueTodos,
    newLeads: summary.leadFunnel.todayAdded,
    briefing: {
      title: summary.briefing.title,
      description: summary.briefing.description,
      basis: summary.briefing.basis,
      action: summary.briefing.action,
      impact: summary.briefing.impact
    }
  };
  qsa<HTMLButtonElement>("[data-dashboard-period]").forEach((button) => {
    const active = button.dataset.dashboardPeriod === state.dashboardPeriod;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  qs<HTMLElement>("#dashboardUpdatedAt")!.textContent = fromCache ? "缓存数据 · 后台刷新中" : `${formatTime(summary.updatedAt)} 已更新`;
  qs<HTMLElement>(".focus-title h2")!.textContent = period.briefing.title;
  qs<HTMLElement>(".focus-title p")!.textContent = period.briefing.description;
  const basis = qs<HTMLElement>("#briefingBasis");
  const action = qs<HTMLElement>("#briefingAction");
  const impact = qs<HTMLElement>("#briefingImpact");
  if (basis) basis.textContent = period.briefing.basis;
  if (action) action.textContent = period.briefing.action;
  if (impact) impact.textContent = period.briefing.impact;
  const focusMetrics = qsa<HTMLElement>(".focus-metric");
  if (focusMetrics[0]) focusMetrics[0].innerHTML = `<span>当前高风险金额 · ${escapeHtml(scopeLabels.business)}</span><b>${money(summary.briefing.riskAmount)}</b><small>${escapeHtml(summary.briefing.riskLabel)} · 实时快照</small>`;
  if (focusMetrics[1]) focusMetrics[1].innerHTML = `<span>${escapeHtml(period.label)}高优先级待办 · ${escapeHtml(scopeLabels.todos)}</span><b>${period.highPriorityTodos} 项</b><small>${period.pendingTodos} 个周期待办</small>`;
  if (focusMetrics[2]) focusMetrics[2].innerHTML = `<span>${escapeHtml(period.label)}预计成交金额 · ${escapeHtml(scopeLabels.business)}</span><b>${escapeHtml(dashboardMoneyText(period.expectedAmounts))}</b><small>${period.expectedDeals} 个预计成交商机 · ${escapeHtml(periodDateText(period.start, period.end))}</small>`;
  if (focusMetrics[3]) focusMetrics[3].innerHTML = `<span>${escapeHtml(period.label)}新增线索 · ${escapeHtml(scopeLabels.business)}</span><b>${period.newLeads} 条</b><small>当前另有 ${summary.briefing.unreadWecom} 条客户消息待处理</small>`;
  renderLeadFunnel(summary);
  renderPipelineHealth(summary);
  renderTodoInsights(summary);
  renderPriorityTasks(summary);
  renderTodos(todos);
  updateTodoChips(todos);
  renderDashboardControls();
  renderMorningPanel(summary);
}

function dashboardMoneyText(rows: Array<{ currency: string; amount: number }>) {
  if (!rows.length) return "$0";
  return rows.map((row) => {
    const symbol = row.currency === "USD" ? "$" : row.currency === "CNY" ? "¥" : row.currency === "EUR" ? "€" : `${row.currency} `;
    const amount = Math.abs(row.amount) >= 1000
      ? `${Number((row.amount / 1000).toFixed(row.amount % 1000 === 0 ? 0 : 1))}k`
      : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(row.amount);
    return `${symbol}${amount}`;
  }).join(" / ");
}

function periodDateText(start: string, end: string) {
  const shortDate = (value: string) => {
    const [, month, day] = value.split("-");
    return `${Number(month)}月${Number(day)}日`;
  };
  return start === end ? shortDate(start) : `${shortDate(start)}-${shortDate(end)}`;
}

function renderDashboardControls() {
  const morningButton = qs<HTMLButtonElement>("#morningViewButton");
  if (morningButton) {
    morningButton.classList.toggle("primary", state.morningView);
    morningButton.textContent = state.morningView ? "退出晨会视图" : "晨会视图";
  }
}

function renderMorningPanel(summary: DashboardSummary) {
  const panel = qs<HTMLElement>("#morningPanel");
  panel?.classList.toggle("active", state.morningView);
  if (!panel) return;
  const subtitle = qs<HTMLElement>("#morningSubtitle");
  const conclusion = qs<HTMLElement>("#morningConclusion");
  const risk = qs<HTMLElement>("#morningRisk");
  const collab = qs<HTMLElement>("#morningCollab");
  const action = qs<HTMLElement>("#morningAction");
  if (subtitle) subtitle.textContent = "今日晨会同步：风险、成交、协同和下一步动作。";
  if (conclusion) conclusion.textContent = "先抢救逾期报价";
  if (risk) risk.textContent = money(summary.briefing.riskAmount);
  if (collab) collab.textContent = `${summary.metrics.overdueTodos} 项`;
  if (action) action.textContent = `${summary.priorityTasks.length || summary.metrics.todos} 条`;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatTodoTime(value = ""): string {
  const text = value.trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isFinite(date.getTime())) {
    const pad = (item: number) => String(item).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  const idTime = text.match(/^t_(\d{10,}).*/);
  if (idTime) {
    const stampDate = new Date(Number(idTime[1]));
    if (Number.isFinite(stampDate.getTime())) return formatTodoTime(stampDate.toISOString());
  }
  return text;
}

function renderLeadFunnel(summary: DashboardSummary) {
  const funnel = qs<HTMLElement>("#dashboardLeadFunnel");
  if (!funnel) return;
  dashboardLeadFunnelResizeObserver?.disconnect();
  dashboardLeadFunnelResizeObserver = null;
  dashboardLeadFunnelChart?.dispose();
  dashboardLeadFunnelChart = null;
  const data = summary.leadFunnel;
  if (!data?.stages?.length) {
    funnel.innerHTML = `<div class="todo-history-empty">线索漏斗数据更新中</div>`;
    return;
  }
  const colors: Record<string, string> = {
    entered: "#3157d5",
    pending: "#d58a12",
    valid: "#168f86",
    customer: "#2f8f67",
    deal: "#237451"
  };
  funnel.innerHTML = `
    <div class="lead-funnel-chart-wrap">
      <div class="lead-funnel-chart" data-lead-funnel-chart role="img" aria-label="线索从进入系统、清洗到转为客户和商机的真实转化曲线"></div>
      <span class="lead-funnel-travel-light" data-lead-funnel-light aria-hidden="true"></span>
    </div>
    <div class="lead-funnel-stage-list" aria-label="线索漏斗阶段">
      ${data.stages.map((stage, index) => `
        <button type="button" class="lead-funnel-stage-row" data-lead-funnel-key="${escapeHtml(stage.key)}" aria-label="${escapeHtml(stage.label)} ${stage.count} 条，占进入系统 ${stage.conversionRate}%">
          <span class="lead-funnel-stage-dot" style="--stage-color:${colors[stage.key] || "#3157d5"}" aria-hidden="true"></span>
          <span>${escapeHtml(stage.label)}</span>
          <small>${index === 0 ? "总量" : `${stage.conversionRate}%`}</small>
        </button>
      `).join("")}
    </div>
    <div class="lead-funnel-filtered" aria-label="已过滤 ${data.filteredOut} 条无效或重复线索">
      <span class="lead-funnel-filter-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16l-6.4 7.1v5.2l-3.2 1.7v-6.9L4 5Z"/></svg></span>
      <span>清洗已过滤 <b>${data.filteredOut}</b> 条无效 / 重复线索</span>
    </div>
    <div class="lead-funnel-summary">
      <div><span>今日新增</span><b>${data.todayAdded}</b></div>
      <div><span>待清洗</span><b>${data.stages.find((stage) => stage.key === "pending")?.count || 0}</b></div>
      <div><span>转商机率</span><b>${data.dealConversionRate}%</b></div>
    </div>`;

  const chartHost = qs<HTMLElement>("[data-lead-funnel-chart]", funnel);
  if (chartHost) {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const maxCount = Math.max(1, ...data.stages.map((stage) => stage.count));
    const chart = echarts.init(chartHost, undefined, { renderer: "svg" });
    dashboardLeadFunnelChart = chart;
    chart.setOption({
      animation: !prefersReducedMotion,
      animationDuration: 720,
      animationDurationUpdate: 350,
      animationEasing: "cubicOut",
      grid: {
        left: 22,
        right: 22,
        top: 28,
        bottom: 8,
        containLabel: false
      },
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: "#172033",
        borderWidth: 0,
        padding: [8, 10],
        textStyle: { color: "#ffffff", fontSize: 12 },
        formatter: (params: { data: { label: string; value: number; conversionRate: number } }) =>
          `${escapeHtml(params.data.label)}<br/><b>${params.data.value} 条</b> · 占进入 ${params.data.conversionRate}%`
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: data.stages.map((stage) => stage.label),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false }
      },
      yAxis: {
        type: "value",
        min: 0,
        max: Math.max(2, Math.ceil(maxCount * 1.28)),
        show: false
      },
      series: [{
        type: "line",
        smooth: 0.34,
        smoothMonotone: "x",
        symbol: "circle",
        symbolSize: 8,
        showSymbol: true,
        connectNulls: true,
        lineStyle: {
          width: 2,
          color: "#8197c8",
          cap: "round",
          shadowBlur: 3,
          shadowColor: "rgba(64, 88, 145, .11)"
        },
        areaStyle: {
          opacity: 1,
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(81, 106, 170, .075)" },
            { offset: 0.72, color: "rgba(81, 106, 170, .018)" },
            { offset: 1, color: "rgba(49, 87, 213, 0)" }
          ])
        },
        label: {
          show: true,
          position: "top",
          distance: 7,
          color: "#172033",
          fontSize: 13,
          fontWeight: 700,
          formatter: (params: { value: number }) => String(params.value)
        },
        emphasis: {
          scale: 1.45,
          focus: "self",
          itemStyle: {
            borderWidth: 3,
            borderColor: "#ffffff",
            shadowBlur: 12,
            shadowColor: "rgba(23, 32, 51, .22)"
          }
        },
        data: data.stages.map((stage) => ({
          value: stage.count,
          name: stage.label,
          key: stage.key,
          label: stage.label,
          conversionRate: stage.conversionRate,
          itemStyle: {
            color: colors[stage.key] || "#3157d5",
            borderWidth: 2,
            borderColor: "#ffffff",
            shadowBlur: stage.key === "pending" ? 8 : 4,
            shadowColor: `${colors[stage.key] || "#3157d5"}55`
          }
        }))
      }]
    });
    chart.on("click", (params) => {
      const stage = params.data as { key?: string } | undefined;
      openLeadFunnelStage(stage?.key || "entered");
    });
    const travelLight = qs<HTMLElement>("[data-lead-funnel-light]", funnel);
    const positionTravelLight = () => {
      chart.resize();
      if (!travelLight || prefersReducedMotion) return;
      travelLight.style.offsetPath = buildLeadFlowMotionPath(
        chartHost.clientWidth,
        chartHost.clientHeight,
        data.stages.map((stage) => stage.count),
        Math.max(2, Math.ceil(maxCount * 1.28))
      );
    };
    positionTravelLight();
    dashboardLeadFunnelResizeObserver = new ResizeObserver(positionTravelLight);
    dashboardLeadFunnelResizeObserver.observe(chartHost);
  }

  qsa<HTMLButtonElement>("[data-lead-funnel-key]", funnel).forEach((button) => {
    button.addEventListener("click", () => {
      openLeadFunnelStage(button.dataset.leadFunnelKey || "entered");
    });
  });
}

function buildLeadFlowMotionPath(width: number, height: number, values: number[], maxValue: number) {
  const left = 22;
  const right = 22;
  const top = 28;
  const bottom = 8;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const points = values.map((value, index) => ({
    x: left + (values.length === 1 ? plotWidth / 2 : (index * plotWidth) / (values.length - 1)),
    y: top + (1 - value / maxValue) * plotHeight
  }));
  if (!points.length) return "none";
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] || points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] || next;
    const control1X = current.x + (next.x - previous.x) / 10;
    const control1Y = current.y + (next.y - previous.y) / 10;
    const control2X = next.x - (after.x - current.x) / 10;
    const control2Y = next.y - (after.y - current.y) / 10;
    path += ` C ${control1X.toFixed(2)} ${control1Y.toFixed(2)}, ${control2X.toFixed(2)} ${control2Y.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }
  return `path("${path}")`;
}

function openLeadFunnelStage(key: string) {
  resetLeadFilters();
  if (key === "pending") state.leadStageFilter = "新线索";
  if (key === "customer" || key === "deal") state.leadStageFilter = "已转化";
  activateNavView("leads", renderLeads);
}

function renderPipelineHealth(summary: DashboardSummary) {
  const box = qs<HTMLElement>("#dashboard .bars");
  if (!box) return;
  box.innerHTML = summary.pipelineHealth.length ? summary.pipelineHealth.map((item) => {
    const toneClass = item.tone === "green" ? "green" : item.tone === "amber" ? "amber" : item.tone === "red" ? "red" : "aqua";
    const risk = item.riskCount ? ` · ${item.riskCount} 风险` : "";
    return `<div class="bar-row" data-stage="${escapeHtml(item.stage)}" data-count="${item.count}"><span>${escapeHtml(item.stage)}</span><div class="track" aria-label="${escapeHtml(item.stage)} ${item.count} 单"><div class="fill ${toneClass}" style="width:${item.width}%"></div></div><b>${item.count} 单 · ${money(item.amount)}${risk}</b></div>`;
  }).join("") : `<div class="todo-history-empty">暂无商机管道数据</div>`;
}

function renderDashboardDense(summary: DashboardSummary) {
  const cards = qsa<HTMLElement>("#dashboard > .dense-grid .dense-card");
  const values = [
    { label: "资料待更新", value: String(summary.metrics.pendingKnowledge), note: "来自资料库" },
    { label: "产品知识考试通过率", value: `${summary.metrics.examPassRate}%`, note: "已发布考试均值" },
    { label: "未发布考试", value: String(summary.metrics.unfinishedExams), note: "待维护" },
    { label: "客户资料完整度", value: `${summary.metrics.customerCompleteness}%`, note: "按关键字段计算" }
  ];
  cards.forEach((card, index) => {
    const item = values[index];
    if (!item) return;
    card.innerHTML = `<span>${item.label}</span><b>${item.value}</b><small>${item.note}</small>`;
  });
}

function renderDashboardKnowledgePanels(assets = state.knowledgeAssets, exams = state.exams) {
  const assetBody = qs<HTMLElement>("#dashboard-knowledge-panel tbody");
  if (assetBody) {
    assetBody.innerHTML = assets.length ? assets.slice(0, 4).map((asset) => {
      const statusText = asset.status === "published" ? "已发布" : asset.status === "review" ? "待审" : "草稿";
      const tone = asset.status === "published" ? "green" : asset.status === "review" ? "amber" : "";
      return `<tr><td>${escapeHtml(asset.title)}</td><td>${escapeHtml(asset.category)}</td><td>${badge(statusText, tone)}</td><td>${escapeHtml(ownerName(asset.ownerId))}</td></tr>`;
    }).join("") : `<tr><td colspan="4">暂无资料数据</td></tr>`;
  }

  const examBody = qs<HTMLElement>("#dashboard-exam-panel tbody");
  if (examBody) {
    examBody.innerHTML = exams.length ? exams.slice(0, 4).map((exam) => `<tr><td>${escapeHtml(exam.title)}</td><td>${exam.questionCount}</td><td>${exam.passRate}%</td></tr>`).join("") : `<tr><td colspan="3">暂无考试数据</td></tr>`;
  }

  const gapBody = qs<HTMLElement>("#dashboard-gap-panel tbody");
  if (!gapBody) return;
  const grouped = exams.reduce<Record<string, { total: number; count: number }>>((acc, exam) => {
    acc[exam.category] ||= { total: 0, count: 0 };
    acc[exam.category].total += exam.passRate;
    acc[exam.category].count += 1;
    return acc;
  }, {});
  const rows = Object.entries(grouped)
    .map(([category, item]) => ({ category, passRate: Math.round(item.total / Math.max(item.count, 1)) }))
    .sort((left, right) => left.passRate - right.passRate);
  gapBody.innerHTML = rows.length ? rows.slice(0, 4).map((row) => {
    const action = row.passRate < 70 ? "补考" : row.passRate < 85 ? "复训" : "达标";
    const tone = row.passRate < 70 ? "red" : row.passRate < 85 ? "amber" : "green";
    return `<tr><td>${escapeHtml(row.category)}</td><td>${row.passRate}%</td><td>${badge(action, tone)}</td></tr>`;
  }).join("") : `<tr><td colspan="3">暂无考试类目数据</td></tr>`;
}

function ownerName(ownerId: string) {
  const map: Record<string, string> = {
    u_sales_shirley: "Shirley",
    u_sales_mia: "Mia",
    u_manager_alex: "Alex",
    u_admin: "Admin",
    u_super_admin: "Super Admin"
  };
  return map[ownerId] || "当前账号";
}

function renderTodoInsights(summary: DashboardSummary) {
  const scoreCards = qsa<HTMLElement>(".todo-score-card b");
  if (scoreCards[0]) scoreCards[0].textContent = String(summary.todoInsights.total);
  if (scoreCards[1]) scoreCards[1].textContent = String(summary.todoInsights.overdue);
  if (scoreCards[2]) scoreCards[2].textContent = `${summary.todoInsights.completionRate}%`;
  if (scoreCards[3]) scoreCards[3].textContent = money(summary.todoInsights.impactAmount);
  const table = qs<HTMLElement>("#dashboard .todo-insights .mini-table tbody");
  if (table) {
    table.innerHTML = summary.todoInsights.typeRows.length ? summary.todoInsights.typeRows.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${row.count}</td><td>${badge(row.risk, row.risk === "高" ? "red" : row.risk === "中" ? "amber" : "")}</td></tr>`).join("") : `<tr><td>暂无待办</td><td>0</td><td>${badge("安全", "green")}</td></tr>`;
  }
  const calendar = qs<HTMLElement>("#dashboard .todo-calendar");
  if (calendar) {
    calendar.innerHTML = summary.todoInsights.weekLoad.map((item) => `<div class="todo-day ${item.count >= 4 ? "hot" : item.count <= 1 ? "ok" : ""}">${escapeHtml(item.day)}<br>${item.count}</div>`).join("");
  }
}

function renderPriorityTasks(summary: DashboardSummary) {
  const list = qs<HTMLElement>("#dashboard .task-list");
  if (!list) return;
  list.innerHTML = summary.priorityTasks.length ? summary.priorityTasks.map((task) => `<article class="task" data-priority-task-id="${escapeHtml(task.id)}" style="--accent: var(--${task.tone === "red" ? "rose" : task.tone})">
    <i class="task-line"></i>
    <div><h3>${escapeHtml(task.action)}</h3><p>${escapeHtml(task.subtitle)}</p><div class="priority-task-meta"><span>${escapeHtml(task.reason)}</span></div></div>
    <div class="priority-score">${task.score}<br>分</div>
    ${badge(task.badge, task.tone === "red" ? "red" : task.tone === "amber" ? "amber" : "")}
  </article>`).join("") : `<div class="todo-history-empty">暂无高优先级跟进任务</div>`;
}

async function batchProcessPriorityTasks(button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "生成中";
  }
  try {
    const result = await api<{ created: Todo[]; processed: number; skipped: number }>("/api/dashboard/priority-tasks/batch-process", { method: "POST" });
    if (result.created.length) {
      state.todos.unshift(...result.created);
      renderTodos(state.todos);
      updateTodoChips(state.todos);
    }
    await refreshDashboardOnly();
    toast(result.created.length ? `已生成 ${result.created.length} 条跟进待办` : "推荐项已有待办，无需重复生成");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "批量生成跟进待办";
    }
  }
}

function renderTodos(todos: Todo[]) {
  const list = qs<HTMLElement>("#dashboard .todo-list");
  if (!list) return;
  renderTopbarStats();
  const currentTodos = activeTodos(todos);
  const archivedTodos = historyTodos(todos);
  const isHistoryView = state.todoFilter === "history";
  const visibleTodos = isHistoryView ? archivedTodos : filterTodos(currentTodos);
  if (!visibleTodos.length) {
    list.innerHTML = `<div class="todo-history-empty">${isHistoryView ? "暂无隔天历史待办" : "暂无当前清单待办，使用上方快速新增开始安排。"}</div>`;
  } else {
    list.innerHTML = visibleTodos.map((todo) => {
    const tone = todo.priority === "high" ? "red" : todo.priority === "medium" ? "amber" : "green";
    const optionalMeta = [formatTodoTime(todo.dueAt), todo.related].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join("");
    const isRunning = todo.status === "in_progress" && !todo.done;
    const pinBadge = todo.pinState === "top" ? badge("置顶", "aqua") : todo.pinState === "bottom" ? badge("沉底", "gray") : "";
    const statusBadge = isHistoryView ? badge(todo.done ? "历史完成" : "历史归档", todo.done ? "green" : tone) : todo.done ? badge("已完成", "green") : isRunning ? badge("进行中", "aqua") : badge(todoTypeText(todo.type), tone);
    const runIcon = isRunning ? `<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>` : `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
    const menuOpen = state.openTodoMenuId === todo.id;
    return `<article class="todo-row ${todo.priority === "high" ? "urgent" : ""} ${isRunning ? "in-progress" : ""} ${todo.done ? "done" : ""} ${state.draggingTodoId === todo.id ? "dragging" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <i class="todo-check" title="${todo.done ? "撤回未完成" : "完成待办"}"></i>
      <div class="todo-main"><h3>${escapeHtml(todo.title)}</h3><div class="todo-meta"><i class="priority-dot" style="--color:var(--${tone === "red" ? "rose" : tone})"></i><span>${escapeHtml(priorityText(todo.priority))}</span>${optionalMeta}${pinBadge}${statusBadge}</div></div>
      <div class="todo-side"><div class="todo-actions"><div class="assignee-stack"><span class="mini-avatar">我</span></div>${isHistoryView ? `<button class="btn" data-todo-restore>回到今日</button>` : todo.done ? "" : `<button class="todo-run ${isRunning ? "active" : ""}" title="${isRunning ? "停止执行" : "开始执行"}" aria-label="${isRunning ? "停止执行" : "开始执行"}">${runIcon}</button>`}<button class="todo-more ${menuOpen ? "active" : ""}" title="更多操作" aria-label="更多操作"><span></span><span></span><span></span></button>${menuOpen ? `<div class="todo-menu">${isHistoryView ? "" : `<button data-todo-action="edit">编辑</button><button data-todo-action="top">置顶</button><button data-todo-action="bottom">沉底</button>`}<button class="danger" data-todo-action="delete">删除</button></div>` : ""}</div><div class="subtask-bar ${isRunning ? "running" : ""}"><i style="--p:${todo.done ? "100%" : isRunning ? "74%" : "55%"}"></i></div></div>
    </article>`;
    }).join("");
  }
  qsa<HTMLElement>(".todo-row [data-todo-restore]", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      if (row?.dataset.todoId) await restoreTodoFromHistory(row.dataset.todoId);
    });
  });
  qsa<HTMLElement>(".todo-row .todo-run", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      if (row?.dataset.todoId) await toggleTodoExecution(row.dataset.todoId);
    });
  });
  qsa<HTMLElement>(".todo-row .todo-more", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      state.openTodoMenuId = state.openTodoMenuId === row?.dataset.todoId ? null : row?.dataset.todoId || null;
      renderTodos(state.todos);
    });
  });
  qsa<HTMLElement>(".todo-row .todo-menu button", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      const action = node.dataset.todoAction;
      if (!row?.dataset.todoId || !action) return;
      state.openTodoMenuId = null;
      if (action === "edit") {
        const todo = state.todos.find((item) => item.id === row.dataset.todoId);
        if (todo) openTodoModal("", todo);
        return;
      }
      if (action === "delete") {
        await deleteTodo(row.dataset.todoId);
        return;
      }
      if (isHistoryView) return;
      await pinTodo(row.dataset.todoId, action as "top" | "bottom");
    });
  });
  qsa<HTMLElement>(".todo-row .todo-check", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      if (!row?.dataset.todoId) return;
      const todo = state.todos.find((item) => item.id === row.dataset.todoId);
      if (!todo) return;
      const nextDone = !todo.done;
      const result = await api<{ todo: Todo }>(`/api/todos/${todo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ done: nextDone })
      });
      Object.assign(todo, result.todo);
      renderTodos(state.todos);
      updateTodoChips(state.todos);
      void refreshDashboardOnly();
      toast(todo.done ? "待办已完成" : "已撤回未完成");
    });
  });
  bindTodoDrag(list, visibleTodos, isHistoryView);
  const total = visibleTodos.length;
  const overdue = visibleTodos.filter((todo) => todo.priority === "high" && !todo.done).length;
  const done = visibleTodos.filter((todo) => todo.done).length;
  const scoreCards = qsa<HTMLElement>(".todo-score-card b");
  if (scoreCards[0]) scoreCards[0].textContent = String(total);
  if (scoreCards[1]) scoreCards[1].textContent = String(overdue);
  if (scoreCards[2]) scoreCards[2].textContent = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
  if (scoreCards[3]) scoreCards[3].textContent = money(visibleTodos.reduce((sum, todo) => sum + (todo.impactAmount || 0), 0));
  renderTodoHistory(archivedTodos);
}

function visibleTodoIds(todos: Todo[]) {
  return todos.map((todo) => todo.id);
}

async function persistTodoOrder(ids: string[], mode: "manual" | "top" | "bottom", targetId?: string) {
  const result = await api<{ todos: Todo[] }>("/api/todos/reorder", {
    method: "POST",
    body: JSON.stringify({ ids, mode, targetId })
  });
  result.todos.forEach((updated) => {
    const todo = state.todos.find((item) => item.id === updated.id);
    if (todo) Object.assign(todo, updated);
  });
  renderTodos(state.todos);
  updateTodoChips(state.todos);
}

async function pinTodo(id: string, mode: "top" | "bottom") {
  const current = filterTodos(activeTodos(state.todos));
  const sameGroup = current.filter((todo) => todo.done === state.todos.find((item) => item.id === id)?.done);
  const rest = sameGroup.filter((todo) => todo.id !== id).map((todo) => todo.id);
  const ids = mode === "top" ? [id, ...rest] : [...rest, id];
  await persistTodoOrder(ids, mode, id);
  toast(mode === "top" ? "已置顶" : "已沉底");
}

function bindTodoDrag(list: HTMLElement, visibleTodos: Todo[], isHistoryView: boolean) {
  if (isHistoryView) return;
  let holdTimer = 0;
  let dragId = "";
  let pointerId = 0;
  let lastDropId = "";
  const clearHold = () => {
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = 0;
  };
  const markDropTarget = (clientX: number, clientY: number) => {
    const targetRow = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".todo-row");
    if (!targetRow || targetRow.dataset.todoId === dragId || targetRow.closest("#dashboard .todo-list") !== list) return;
    lastDropId = targetRow.dataset.todoId || "";
    qsa<HTMLElement>(".todo-row.drop-target", list).forEach((item) => item.classList.remove("drop-target"));
    targetRow.classList.add("drop-target");
  };
  const documentMove = (event: PointerEvent) => {
    if (!dragId) return;
    markDropTarget(event.clientX, event.clientY);
  };
  const documentUp = (event: PointerEvent) => {
    void finishDrag(event.clientX, event.clientY);
  };
  const removeDocumentDragEvents = () => {
    document.removeEventListener("pointermove", documentMove);
    document.removeEventListener("pointerup", documentUp);
    document.removeEventListener("pointercancel", cancelDrag);
  };
  const finishDrag = async (clientX: number, clientY: number) => {
    clearHold();
    if (!dragId) return;
    removeDocumentDragEvents();
    const dropRow = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".todo-row");
    const dragged = visibleTodos.find((todo) => todo.id === dragId);
    const targetId = dropRow?.dataset.todoId && dropRow.closest("#dashboard .todo-list") === list ? dropRow.dataset.todoId : lastDropId;
    const target = visibleTodos.find((todo) => todo.id === targetId);
    const draggedId = dragId;
    dragId = "";
    lastDropId = "";
    state.draggingTodoId = null;
    qsa<HTMLElement>(".todo-row.dragging, .todo-row.drop-target", list).forEach((item) => item.classList.remove("dragging", "drop-target"));
    if (!dragged || !target || dragged.id === target.id || dragged.done !== target.done) {
      renderTodos(state.todos);
      return;
    }
    const group = visibleTodos.filter((todo) => todo.done === dragged.done);
    const ids = visibleTodoIds(group).filter((id) => id !== draggedId);
    ids.splice(ids.indexOf(target.id), 0, draggedId);
    await persistTodoOrder(ids, "manual", draggedId);
    toast("已按拖拽顺序保存");
  };
  const cancelDrag = () => {
    clearHold();
    removeDocumentDragEvents();
    dragId = "";
    lastDropId = "";
    state.draggingTodoId = null;
    renderTodos(state.todos);
  };
  qsa<HTMLElement>(".todo-row", list).forEach((row) => {
    row.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("button") || target.closest(".todo-check") || target.closest(".todo-menu")) return;
      const id = row.dataset.todoId;
      if (!id) return;
      pointerId = event.pointerId;
      holdTimer = window.setTimeout(() => {
        dragId = id;
        state.draggingTodoId = id;
        state.openTodoMenuId = null;
        row.classList.add("dragging");
        row.setPointerCapture(pointerId);
        document.addEventListener("pointermove", documentMove);
        document.addEventListener("pointerup", documentUp);
        document.addEventListener("pointercancel", cancelDrag);
        toast("拖动到目标位置后松手排序");
      }, 280);
    });
    row.addEventListener("pointermove", (event) => {
      if (!dragId || state.draggingTodoId !== dragId) return;
      markDropTarget(event.clientX, event.clientY);
    });
    row.addEventListener("pointerup", (event) => void finishDrag(event.clientX, event.clientY));
    row.addEventListener("pointercancel", cancelDrag);
    row.addEventListener("pointerleave", clearHold);
  });
  list.addEventListener("pointermove", (event) => {
    if (!dragId) return;
    markDropTarget(event.clientX, event.clientY);
  });
  list.addEventListener("pointerup", (event) => void finishDrag(event.clientX, event.clientY));
  list.addEventListener("pointercancel", cancelDrag);
}

async function toggleTodoExecution(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo || todo.done) return;
  const nextStatus = todo.status === "in_progress" ? "pending" : "in_progress";
  const result = await api<{ todo: Todo }>(`/api/todos/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: nextStatus })
  });
  Object.assign(todo, result.todo);
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  toast(nextStatus === "in_progress" ? "已开始执行" : "已停止执行");
}

function renderTodoHistory(todos: Todo[]) {
  const list = qs<HTMLElement>("#dashboard .todo-history-list");
  const count = qs<HTMLElement>("#dashboard #todo-history-count");
  const amountNode = qs<HTMLElement>("#dashboard #todo-history-amount");
  if (count) count.textContent = `${todos.length} 条`;
  if (amountNode) amountNode.textContent = money(todos.reduce((sum, todo) => sum + (todo.impactAmount || 0), 0));
  if (!list) return;
  const recent = todos.slice(0, 5);
  list.innerHTML = recent.length ? recent.map((todo) => {
    const tone = todo.priority === "high" ? "red" : todo.priority === "medium" ? "amber" : "green";
    const meta = [formatTodoTime(todo.dueAt), todo.related, todo.historyAt ? `归档 ${formatTodoTime(todo.historyAt)}` : ""].filter(Boolean).join(" · ") || "未设置上下文";
    const menuOpen = state.openTodoMenuId === todo.id;
    return `<article class="todo-history-row ${todo.done ? "done" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <span class="history-dot ${tone}"></span>
      <div><b>${escapeHtml(todo.title)}</b><span>${escapeHtml(meta)}</span></div>
      <div class="todo-actions">${badge(todo.done ? "历史完成" : "历史归档", todo.done ? "green" : tone)}<button class="btn" data-todo-restore>回到今日</button><button class="todo-more ${menuOpen ? "active" : ""}" title="更多操作" aria-label="更多操作"><span></span><span></span><span></span></button>${menuOpen ? `<div class="todo-menu"><button class="danger" data-todo-action="delete">删除</button></div>` : ""}</div>
    </article>`;
  }).join("") : `<div class="todo-history-empty">暂无隔天历史待办</div>`;
  qsa<HTMLElement>(".todo-history-row [data-todo-restore]", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-history-row");
      if (row?.dataset.todoId) await restoreTodoFromHistory(row.dataset.todoId);
    });
  });
  qsa<HTMLElement>(".todo-history-row .todo-more", list).forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-history-row");
      state.openTodoMenuId = state.openTodoMenuId === row?.dataset.todoId ? null : row?.dataset.todoId || null;
      renderTodoHistory(todos);
    });
  });
  qsa<HTMLElement>(".todo-history-row .todo-menu button", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-history-row");
      state.openTodoMenuId = null;
      if (row?.dataset.todoId) await deleteTodo(row.dataset.todoId);
    });
  });
  qsa<HTMLElement>(".todo-history-row", list).forEach((row) => {
    row.addEventListener("click", () => {
      const todo = state.todos.find((item) => item.id === row.dataset.todoId);
      if (todo) toast(["历史清单", todo.related, todo.dueAt].filter(Boolean).join(" · "));
    });
  });
}

async function deleteTodo(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) {
    toast("待办不存在", "error");
    return;
  }
  await api<{ ok: boolean; id: string }>(`/api/todos/${id}`, { method: "DELETE" });
  state.todos = state.todos.filter((item) => item.id !== id);
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  toast("待办已删除");
}

async function restoreTodoFromHistory(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) {
    toast("待办不存在", "error");
    return;
  }
  const result = await api<{ todo: Todo }>(`/api/todos/${id}/restore`, { method: "POST" });
  Object.assign(todo, result.todo);
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  toast("已恢复到今日清单");
}

function filterTodos(todos: Todo[]) {
  if (state.todoFilter === "overdue") return todos.filter((todo) => todo.priority === "high" && !todo.done);
  if (state.todoFilter === "customer") return todos.filter((todo) => todo.type === "customer");
  return todos;
}

function updateTodoChips(todos: Todo[]) {
  const chips = qsa<HTMLElement>("#dashboard .todo-chip");
  const currentTodos = activeTodos(todos);
  const values = [
    `今天 ${currentTodos.filter((todo) => !todo.done).length}`,
    `逾期 ${currentTodos.filter((todo) => todo.priority === "high" && !todo.done).length}`,
    `我负责 ${currentTodos.length}`,
    "客户跟进",
    `历史清单 ${historyTodos(todos).length}`
  ];
  chips.forEach((chip, index) => {
    chip.textContent = values[index] || chip.textContent || "";
    const filters: AppState["todoFilter"][] = ["today", "overdue", "mine", "customer", "history"];
    chip.dataset.todoFilter = filters[index] || "all";
    chip.classList.toggle("active", state.todoFilter === chip.dataset.todoFilter || (state.todoFilter === "all" && index === 0));
  });
}

function priorityText(priority: string) {
  if (priority === "high") return "高优先级";
  if (priority === "medium") return "中优先级";
  return "普通";
}

function severityText(severity: string) {
  if (severity === "high") return "高";
  if (severity === "medium") return "中";
  return "低";
}

function severityTone(severity: string) {
  if (severity === "high") return "red";
  if (severity === "medium") return "amber";
  return "green";
}

function problemStatusText(status: string) {
  if (status === "resolved") return "已解决";
  if (status === "solving") return "解决中";
  return "未解决";
}

function problemStatusTone(status: string) {
  if (status === "resolved") return "green";
  if (status === "solving") return "amber";
  return "red";
}

function threatText(level: string) {
  if (level === "high") return "高威胁";
  if (level === "medium") return "中威胁";
  return "低威胁";
}

function caseStatusText(status: string) {
  return status === "published" ? "已发布" : "草稿";
}

const LEAD_STAGES = ["新线索", "已联系", "已建联", "已报价", "已转化", "已放弃"];
const LEAD_STATUS_LABEL: Record<string, string> = { new: "待跟进", following: "跟进中", converted: "已转化", invalid: "无效" };
const LEAD_STATUS_TONE: Record<string, string> = { new: "gray", following: "amber", converted: "green", invalid: "red" };
const LEAD_ACTIVITY_LABEL: Record<string, string> = { call: "电话", wechat: "微信", whatsapp: "WhatsApp", linkedin: "LinkedIn", email: "邮件", meeting: "会面", note: "备注", stage: "阶段", system: "系统" };
const LEAD_PAGE_SIZE = 10;

function leadStageTone(stage: string) {
  if (stage === "已转化") return "green";
  if (stage === "已报价" || stage === "已建联") return "amber";
  if (stage === "已放弃") return "red";
  return "";
}

function leadFollowState(lead: Lead) {
  if (!lead.nextFollowAt) return "unset";
  const date = parseTodoDate(lead.nextFollowAt);
  if (!date) return "planned";
  return date.getTime() < Date.now() ? "overdue" : "planned";
}

function leadSourceLabel(lead: Lead) {
  return lead.sourceChannel || lead.source || "未标注";
}

function resetLeadFilters() {
  state.leadStageFilter = "all";
  state.leadIntentFilter = "all";
  state.leadSourceFilter = "all";
  state.leadFollowFilter = "all";
  state.leadSearch = "";
  state.leadPage = 1;
  setFieldValue("#leadSearchInput", "");
  setFieldValue("#leadIntentFilter", "all");
  setFieldValue("#leadSourceFilter", "all");
  setFieldValue("#leadFollowFilter", "all");
  renderLeads();
}

// ===================== WhatsApp 聊天中心 =====================
function waInitials(name: string) {
  const s = (name || "?").trim();
  return s ? s.slice(0, 2).toUpperCase() : "?";
}

function waFormatTime(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 号码 → wa.me 深链(仅保留数字，去掉+/空格/横线)。空号码返回空串。 */
function waMeLink(phone: string) {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  return digits.length >= 6 ? `https://wa.me/${digits}` : "";
}

function renderWhatsAppThreads() {
  const listEl = qs<HTMLElement>("#waThreadList");
  if (!listEl) return;
  const q = state.waThreadSearch.trim().toLowerCase();
  const threads = state.whatsappThreads.filter((t) =>
    !q || t.company.toLowerCase().includes(q) || (t.country || "").toLowerCase().includes(q) || (t.contact || "").toLowerCase().includes(q)
  );
  if (!threads.length) {
    listEl.innerHTML = `<div class="wa-empty" style="height:auto;padding:24px">${state.whatsappThreads.length ? "无匹配客户" : "暂无 WhatsApp 会话，去客户/线索页发起对话"}</div>`;
    return;
  }
  listEl.innerHTML = threads.map((t) => `
    <div class="wa-thread ${t.customerId === state.selectedWaCustomerId ? "active" : ""}" data-wa-customer="${t.customerId}">
      <span class="wa-avatar">${waInitials(t.company)}</span>
      <div class="wa-thread-main">
        <b>${escapeHtml(t.company)}</b>
        <span>${escapeHtml(t.lastMessage || t.phoneNumber || "—")}</span>
      </div>
      ${t.unreadCount > 0 ? `<span class="wa-unread">${t.unreadCount}</span>` : ""}
    </div>`).join("");
  qsa<HTMLElement>(".wa-thread", listEl).forEach((el) => {
    el.addEventListener("click", () => void openWhatsAppThread(el.dataset.waCustomer || ""));
  });
}

async function openWhatsAppThread(customerId: string) {
  if (!customerId) return;
  state.selectedWaCustomerId = customerId;
  renderWhatsAppThreads();
  const chatCol = qs<HTMLElement>("#waChatCol");
  if (chatCol) chatCol.innerHTML = `<div class="wa-empty">加载中…</div>`;
  try {
    const data = await api<{ binding: WhatsAppBinding | null; messages: WhatsAppMessage[]; customer: { id: string; company: string; country: string; contact: string } }>(`/api/whatsapp/customers/${customerId}/messages`);
    state.whatsappMessages = data.messages;
    state.whatsappBinding = data.binding;
    renderWhatsAppChat(data.customer, data.binding, data.messages);
    renderWhatsAppInfo(data.customer, data.binding);
  } catch (error) {
    if (chatCol) chatCol.innerHTML = `<div class="wa-empty">加载失败：${escapeHtml(error instanceof Error ? error.message : "")}</div>`;
  }
}

function renderWhatsAppChat(customer: { id: string; company: string; country: string; contact: string }, binding: WhatsAppBinding | null, messages: WhatsAppMessage[]) {
  const chatCol = qs<HTMLElement>("#waChatCol");
  if (!chatCol) return;
  const bubbles = messages.map((m) => {
    const isCn = /[一-鿿]/.test(m.content);
    const translated = m.contentTranslated
      ? `<span class="wa-translated">${escapeHtml(m.contentTranslated)}</span>`
      : (!isCn && m.direction === "inbound" ? `<button class="wa-translate-btn" data-wa-translate="${m.id}">翻译成中文</button>` : "");
    return `<div class="wa-msg ${m.direction === "inbound" ? "in" : "out"}" data-wa-msg="${m.id}">
      ${escapeHtml(m.content)}
      ${translated}
      <span class="wa-time">${waFormatTime(m.createdAt)}${m.direction === "outbound" ? " · " + (m.status === "read" ? "已读" : m.status === "delivered" ? "已送达" : "已发送") : ""}</span>
    </div>`;
  }).join("");

  const waLink = waMeLink(binding?.phoneNumber || "");
  chatCol.innerHTML = `
    <div class="wa-chat-head">
      <span class="wa-avatar" style="width:36px;height:36px">${waInitials(customer.company)}</span>
      <div><b>${escapeHtml(customer.company)}</b> <span>${escapeHtml(binding?.phoneNumber || "未绑定号码")}</span></div>
      ${waLink ? `<a class="btn wa-open-link" href="${waLink}" target="_blank" rel="noopener" title="在 WhatsApp 中打开对话">在 WhatsApp 打开</a>` : ""}
    </div>
    <div class="wa-messages" id="waMessages">${bubbles || `<div class="wa-empty">暂无对话记录，在下方录入第一条</div>`}</div>
    <div class="wa-compose">
      <select id="waDirection"><option value="inbound">客户发来</option><option value="outbound">我方发送</option></select>
      <input id="waContentInput" placeholder="录入一条对话内容(非中文将自动翻译)" />
      <button class="btn primary" id="waSendButton">录入</button>
    </div>`;

  const msgBox = qs<HTMLElement>("#waMessages");
  if (msgBox) msgBox.scrollTop = msgBox.scrollHeight;

  qsa<HTMLButtonElement>("[data-wa-translate]", chatCol).forEach((btn) => {
    btn.addEventListener("click", () => void translateWhatsAppMessage(btn.dataset.waTranslate || "", customer.id));
  });
  qs<HTMLButtonElement>("#waSendButton", chatCol)?.addEventListener("click", () => void addWhatsAppMessage(customer.id));
  qs<HTMLInputElement>("#waContentInput", chatCol)?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") void addWhatsAppMessage(customer.id);
  });
}

function renderWhatsAppInfo(customer: { id: string; company: string; country: string; contact: string }, binding: WhatsAppBinding | null) {
  const infoCol = qs<HTMLElement>("#waInfoCol");
  if (!infoCol) return;

  const bindingMode = binding?.bindingMode || "manual";
  const connectionStatus = binding?.connectionStatus || "disconnected";

  const modeLabels: Record<string, string> = {
    "manual": "手动录入",
    "web-scan": "扫码登录 (WhatsApp Web)",
    "twilio-api": "官方API (Twilio)"
  };

  const statusLabels: Record<string, string> = {
    "connected": "✅ 已连接",
    "disconnected": "⚪ 未连接",
    "qr-pending": "⏳ 等待扫码",
    "error": "❌ 连接错误"
  };

  infoCol.innerHTML = `
    <h3>${escapeHtml(customer.company)}</h3>
    <p class="wa-info-sub">${escapeHtml(customer.country || "—")} · ${escapeHtml(customer.contact || "—")}</p>

    <div class="wa-bind-box" style="padding:12px;background:#f9f9f9;border-radius:8px;margin-bottom:12px">
      <div class="info"><span>绑定模式</span><b>${modeLabels[bindingMode]}</b></div>
      ${bindingMode !== "manual" ? `<div class="info"><span>连接状态</span><b>${statusLabels[connectionStatus]}</b></div>` : ""}
      <div class="info"><span>WhatsApp 号码</span><b>${escapeHtml(binding?.phoneNumber || "未绑定")}</b></div>
      <div class="info"><span>WhatsApp 昵称</span><b>${escapeHtml(binding?.waProfileName || "—")}</b></div>
    </div>

    <div id="waBindingPanel">
      ${renderBindingModeSelector(customer.id, binding)}
    </div>

    ${waMeLink(binding?.phoneNumber || "") ? `<a class="btn primary wa-open-link" href="${waMeLink(binding?.phoneNumber || "")}" target="_blank" rel="noopener" style="display:block;text-align:center;margin-top:10px">📲 在 WhatsApp 中打开对话</a>` : ""}
  `;

  setupBindingModeListeners(customer.id, binding);
}

function renderBindingModeSelector(customerId: string, binding: WhatsAppBinding | null): string {
  const selectedMode = binding?.bindingMode || "manual";

  return `
    <div style="margin-bottom:12px">
      <label style="display:block;margin-bottom:4px;font-weight:500">选择绑定方式：</label>
      <select id="waBindingModeSelect" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px">
        <option value="manual" ${selectedMode === "manual" ? "selected" : ""}>手动录入 (零风险)</option>
        <option value="web-scan" ${selectedMode === "web-scan" ? "selected" : ""}>扫码登录 (有封号风险)</option>
        <option value="twilio-api" ${selectedMode === "twilio-api" ? "selected" : ""}>官方API (需配置)</option>
      </select>
    </div>

    <div id="waBindingModeContent">
      ${renderBindingModeContent(selectedMode, binding)}
    </div>
  `;
}

function renderBindingModeContent(mode: string, binding: WhatsAppBinding | null): string {
  switch (mode) {
    case "manual":
      return `
        <div class="wa-bind-box" style="padding:0">
          <input id="waBindPhone" placeholder="+8613800138000" value="${escapeHtml(binding?.phoneNumber || "")}" />
          <input id="waBindName" placeholder="WhatsApp 昵称(选填)" value="${escapeHtml(binding?.waProfileName || "")}" />
          <button class="btn" id="waBindButton" style="width:100%">${binding ? "更新绑定" : "绑定号码"}</button>
        </div>
        <div class="wa-safety">⚠️ 风控提示：手动录入模式，不接入任何非官方接口，零封号风险。</div>
      `;

    case "web-scan":
      const isScanning = binding?.connectionStatus === "qr-pending";
      const isConnected = binding?.connectionStatus === "connected";

      return `
        <div style="text-align:center;padding:16px;background:#fff;border:1px solid #ddd;border-radius:8px">
          ${isConnected ? `
            <p style="color:#22c55e;font-weight:500;margin-bottom:12px">✅ 已连接</p>
            <button class="btn" id="waDisconnectButton" style="width:100%">断开连接</button>
          ` : isScanning ? `
            <p style="margin-bottom:12px">请使用 WhatsApp 扫描下方二维码</p>
            <div id="waQrCodeContainer" style="min-height:200px;display:flex;align-items:center;justify-content:center">
              <div>⏳ 正在生成二维码...</div>
            </div>
          ` : `
            <p style="margin-bottom:12px">扫码绑定您的个人 WhatsApp 账号</p>
            <button class="btn primary" id="waStartScanButton" style="width:100%">开始扫码绑定</button>
          `}
        </div>
        <div class="wa-safety" style="background:#fef3c7;color:#92400e;padding:12px;border-radius:6px;margin-top:12px">
          ⚠️ <strong>封号风险警告</strong>：此方式使用非官方协议，可能导致账号被封禁。建议仅用于测试，正式环境请使用官方API。
        </div>
      `;

    case "twilio-api":
      return `
        <div class="wa-bind-box" style="padding:12px">
          <input id="waTwilioPhone" placeholder="Twilio WhatsApp 号码" value="${escapeHtml(binding?.twilioPhoneNumber || "")}" />
          <button class="btn primary" id="waTwilioBindButton" style="width:100%;margin-top:8px">配置 Twilio</button>
        </div>
        <div class="wa-safety" style="background:#e0f2fe;color:#0c4a6e">
          ✅ 官方合规方案，零封号风险。需要先在 Twilio 申请 WhatsApp Business API。
        </div>
      `;

    default:
      return "";
  }
}

function setupBindingModeListeners(customerId: string, binding: WhatsAppBinding | null) {
  const modeSelect = qs<HTMLSelectElement>("#waBindingModeSelect");
  const contentDiv = qs<HTMLElement>("#waBindingModeContent");

  if (modeSelect && contentDiv) {
    modeSelect.addEventListener("change", () => {
      contentDiv.innerHTML = renderBindingModeContent(modeSelect.value, binding);
      setupBindingActions(customerId, modeSelect.value, binding);
    });
  }

  setupBindingActions(customerId, binding?.bindingMode || "manual", binding);
}

function setupBindingActions(customerId: string, mode: string, binding: WhatsAppBinding | null) {
  if (mode === "manual") {
    qs<HTMLButtonElement>("#waBindButton")?.addEventListener("click", () => void bindWhatsAppManual(customerId));
  } else if (mode === "web-scan") {
    qs<HTMLButtonElement>("#waStartScanButton")?.addEventListener("click", () => void startWebScanBinding(customerId));
    qs<HTMLButtonElement>("#waDisconnectButton")?.addEventListener("click", () => void disconnectWebScan(customerId));

    // 如果正在等待扫码，启动轮询获取二维码
    if (binding?.connectionStatus === "qr-pending" && binding?.sessionData) {
      void pollQrCode(binding.sessionData);
    }
  } else if (mode === "twilio-api") {
    qs<HTMLButtonElement>("#waTwilioBindButton")?.addEventListener("click", () => void bindWhatsAppTwilio(customerId));
  }
}

async function bindWhatsAppManual(customerId: string) {
  const phoneNumber = qs<HTMLInputElement>("#waBindPhone")?.value.trim() || "";
  const waProfileName = qs<HTMLInputElement>("#waBindName")?.value.trim() || "";
  if (phoneNumber.length < 5) { toast("请输入有效号码", "error"); return; }
  try {
    await api(`/api/whatsapp/customers/${customerId}/binding`, { method: "POST", body: JSON.stringify({ phoneNumber, waProfileName }) });
    await reloadWhatsAppThreads();
    await openWhatsAppThread(customerId);
    toast("绑定已保存");
  } catch (error) {
    toast(error instanceof Error ? error.message : "绑定失败", "error");
  }
}

async function startWebScanBinding(customerId: string) {
  try {
    toast("正在启动扫码...");
    const result = await api<{ clientId: string; bindingId: string; status: string }>(`/api/whatsapp/binding/web-scan/start`, {
      method: "POST",
      body: JSON.stringify({ customerId })
    });

    await openWhatsAppThread(customerId);
    toast("请扫描二维码");

    // 开始轮询获取二维码
    void pollQrCode(result.clientId);
  } catch (error) {
    toast(error instanceof Error ? error.message : "启动失败", "error");
  }
}

async function pollQrCode(clientId: string) {
  const qrContainer = qs<HTMLElement>("#waQrCodeContainer");
  if (!qrContainer) return;

  try {
    const eventSource = new EventSource(`/api/whatsapp/binding/web-scan/qr/${clientId}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.qr) {
        // 显示二维码（使用 canvas 或者外部库渲染）
        qrContainer.innerHTML = `
          <div style="padding:12px;background:#fff">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data.qr)}" alt="QR Code" style="display:block;margin:0 auto" />
            <p style="text-align:center;margin-top:8px;color:#666;font-size:12px">请在 1 分钟内扫码</p>
          </div>
        `;
      }

      if (data.timeout) {
        eventSource.close();
        qrContainer.innerHTML = `<p style="color:#ef4444">二维码已过期，请重新开始</p>`;
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      qrContainer.innerHTML = `<p style="color:#ef4444">连接失败</p>`;
    };
  } catch (error) {
    qrContainer.innerHTML = `<p style="color:#ef4444">加载二维码失败</p>`;
  }
}

async function disconnectWebScan(customerId: string) {
  try {
    await api(`/api/whatsapp/binding/web-scan/disconnect`, {
      method: "POST",
      body: JSON.stringify({ customerId })
    });
    await openWhatsAppThread(customerId);
    toast("已断开连接");
  } catch (error) {
    toast(error instanceof Error ? error.message : "断开失败", "error");
  }
}

async function bindWhatsAppTwilio(customerId: string) {
  const twilioPhoneNumber = qs<HTMLInputElement>("#waTwilioPhone")?.value.trim() || "";
  if (!twilioPhoneNumber) { toast("请输入 Twilio 号码", "error"); return; }
  try {
    await api(`/api/whatsapp/binding/twilio/start`, {
      method: "POST",
      body: JSON.stringify({ customerId, twilioPhoneNumber })
    });
    await reloadWhatsAppThreads();
    await openWhatsAppThread(customerId);
    toast("Twilio 已配置");
  } catch (error) {
    toast(error instanceof Error ? error.message : "配置失败", "error");
  }
}

async function reloadWhatsAppThreads() {
  const data = await api<{ threads: WhatsAppThread[] }>("/api/whatsapp/threads");
  state.whatsappThreads = data.threads;
  renderWhatsAppThreads();
}

function renderWhatsApp() {
  renderWhatsAppThreads();
  if (state.selectedWaCustomerId && state.whatsappThreads.some((t) => t.customerId === state.selectedWaCustomerId)) {
    void openWhatsAppThread(state.selectedWaCustomerId);
  }
}

async function addWhatsAppMessage(customerId: string) {
  const direction = (qs<HTMLSelectElement>("#waDirection")?.value || "inbound") as "inbound" | "outbound";
  const content = qs<HTMLInputElement>("#waContentInput")?.value.trim() || "";
  if (!content) { toast("请输入对话内容", "error"); return; }
  try {
    await api(`/api/whatsapp/customers/${customerId}/messages`, { method: "POST", body: JSON.stringify({ direction, content }) });
    await reloadWhatsAppThreads();
    await openWhatsAppThread(customerId);
    toast("已录入");
  } catch (error) {
    toast(error instanceof Error ? error.message : "录入失败", "error");
  }
}

async function translateWhatsAppMessage(messageId: string, customerId: string) {
  if (!messageId) return;
  try {
    const result = await api<{ skipped?: boolean }>(`/api/whatsapp/messages/${messageId}/translate`, { method: "POST" });
    if (result.skipped) { toast("中文无需翻译"); return; }
    await openWhatsAppThread(customerId);
    toast("翻译完成");
  } catch (error) {
    toast(error instanceof Error ? error.message : "翻译失败，请先配置 AI 模型", "error");
  }
}

function renderLeads() {
  const tbody = qs<HTMLElement>("#leadsTableBody");
  const cards = qs<HTMLElement>("#leadMobileList");
  if (!tbody || !cards) return;
  const chipsWrap = qs<HTMLElement>("#leadStageChips");
  const activeLeads = state.leadView === "trash" ? state.leadTrash : state.leads;
  const q = state.leadSearch.trim().toLowerCase();
  const sourceOptions = [...new Set(activeLeads.map(leadSourceLabel))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const sourceSelect = qs<HTMLSelectElement>("#leadSourceFilter");
  if (sourceSelect) {
    const selected = sourceOptions.includes(state.leadSourceFilter) ? state.leadSourceFilter : "all";
    state.leadSourceFilter = selected;
    sourceSelect.innerHTML = `<option value="all">全部来源</option>${sourceOptions.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`).join("")}`;
    sourceSelect.value = selected;
  }
  const filtered = activeLeads.filter((lead) => {
    const matchStage = state.leadStageFilter === "all" || lead.stage === state.leadStageFilter;
    const matchIntent = state.leadIntentFilter === "all" || lead.intent === state.leadIntentFilter;
    const matchSource = state.leadSourceFilter === "all" || leadSourceLabel(lead) === state.leadSourceFilter;
    const matchFollow = state.leadFollowFilter === "all" || leadFollowState(lead) === state.leadFollowFilter;
    const haystack = [lead.company, lead.contact, lead.country, lead.email, lead.phone, lead.source, lead.sourceChannel, lead.externalId]
      .filter(Boolean).join(" ").toLowerCase();
    return matchStage && matchIntent && matchSource && matchFollow && (!q || haystack.includes(q));
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / LEAD_PAGE_SIZE));
  state.leadPage = Math.min(state.leadPage, totalPages);
  const pageRows = filtered.slice((state.leadPage - 1) * LEAD_PAGE_SIZE, state.leadPage * LEAD_PAGE_SIZE);

  if (chipsWrap) {
    const counts = LEAD_STAGES.map((stage) => [stage, activeLeads.filter((lead) => lead.stage === stage).length] as const);
    chipsWrap.innerHTML = `<button class="filter lead-chip ${state.leadStageFilter === "all" ? "active" : ""}" data-lead-stage="all">全部 ${activeLeads.length}</button>` +
      counts.filter(([, count]) => count > 0).map(([stage, count]) => `<button class="filter lead-chip ${state.leadStageFilter === stage ? "active" : ""}" data-lead-stage="${escapeHtml(stage)}">${escapeHtml(stage)} ${count}</button>`).join("");
    qsa<HTMLElement>(".lead-chip", chipsWrap).forEach((chip) => {
      chip.addEventListener("click", () => {
        state.leadStageFilter = chip.dataset.leadStage || "all";
        state.leadPage = 1;
        renderLeads();
      });
    });
  }

  tbody.innerHTML = pageRows.length ? pageRows.map((lead) => `<tr data-lead-id="${lead.id}" class="${lead.id === state.selectedLeadId ? "selected" : ""}">
    <td><div class="company"><span class="flag">${countryFlag(lead.country)}</span><div><button class="lead-name" data-open-lead="${lead.id}">${escapeHtml(lead.company)}</button><span>${escapeHtml(lead.contact || "联系人待补充")} · ${escapeHtml(lead.country || "国家待补充")}</span></div></div></td>
    <td><div class="lead-decision-cell">${badge("意向" + lead.intent, lead.intent === "高" ? "red" : lead.intent === "中" ? "amber" : "gray")}${badge(lead.stage, leadStageTone(lead.stage))}</div></td>
    <td><div class="lead-follow-cell"><b>${escapeHtml(lead.nextFollowAt || "未安排")}</b><span>${leadFollowState(lead) === "overdue" ? "已逾期" : leadFollowState(lead) === "unset" ? "待安排" : "已计划"}</span></div></td>
    <td><div class="lead-source-cell"><b>${escapeHtml(leadSourceLabel(lead))}</b><span>${escapeHtml(lead.sourceCampaign || lead.externalId || "无活动编号")}</span></div></td>
    <td>${badge(state.leadView === "trash" ? "垃圾箱" : (LEAD_STATUS_LABEL[lead.status] || lead.status), state.leadView === "trash" ? "red" : (LEAD_STATUS_TONE[lead.status] || ""))}</td>
  </tr>`).join("") : `<tr><td colspan="5" class="empty-cell">${state.leadView === "trash" ? "垃圾箱中没有符合条件的线索" : "暂无符合条件的线索"}</td></tr>`;

  cards.innerHTML = pageRows.length ? pageRows.map((lead) => `
    <article class="lead-mobile-card ${lead.id === state.selectedLeadId ? "selected" : ""}" data-lead-id="${lead.id}">
      <span class="lead-mobile-top"><button class="lead-name" data-open-lead="${lead.id}">${escapeHtml(lead.company)}</button>${badge("意向" + lead.intent, lead.intent === "高" ? "red" : lead.intent === "中" ? "amber" : "gray")}</span>
      <span>${escapeHtml(lead.contact || "联系人待补充")} · ${escapeHtml(lead.country || "国家待补充")}</span>
      <span class="lead-mobile-meta"><i>${escapeHtml(lead.stage)}</i><i>${escapeHtml(leadSourceLabel(lead))}</i><i>${escapeHtml(lead.nextFollowAt || "待安排跟进")}</i></span>
    </article>`).join("") : `<div class="empty-cell">${state.leadView === "trash" ? "垃圾箱中没有符合条件的线索" : "暂无符合条件的线索"}</div>`;

  qsa<HTMLButtonElement>("[data-open-lead]", qs("#leads")!).forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.openLead || "";
    if (id) void openLead(id);
  }));

  const pagination = qs<HTMLElement>("#leadPagination");
  if (pagination) {
    pagination.innerHTML = `<span>共 ${filtered.length} 条 · 第 ${state.leadPage}/${totalPages} 页</span><div><button class="btn tiny" id="leadPrevPage" ${state.leadPage <= 1 ? "disabled" : ""}>上一页</button><button class="btn tiny" id="leadNextPage" ${state.leadPage >= totalPages ? "disabled" : ""}>下一页</button></div>`;
    qs<HTMLButtonElement>("#leadPrevPage", pagination)?.addEventListener("click", () => { state.leadPage -= 1; renderLeads(); });
    qs<HTMLButtonElement>("#leadNextPage", pagination)?.addEventListener("click", () => { state.leadPage += 1; renderLeads(); });
  }

  qs("#leadActiveTab")?.classList.toggle("active", state.leadView === "active");
  qs("#leadTrashTab")?.classList.toggle("active", state.leadView === "trash");
  const activeCount = qs("#leadActiveCount");
  const trashCount = qs("#leadTrashCount");
  if (activeCount) activeCount.textContent = String(state.leads.length);
  if (trashCount) trashCount.textContent = String(state.leadTrash.length);
}

async function openLead(id: string) {
  state.selectedLeadId = id;
  qsa<HTMLElement>("#leadsTableBody tr[data-lead-id]").forEach((row) => row.classList.toggle("selected", row.dataset.leadId === id));
  const drawer = qs<HTMLElement>("#leadDrawer");
  if (!drawer) return;
  drawer.classList.add("open");
  qs("#leadDrawerBackdrop")?.classList.add("active");
  document.body.classList.add("lead-drawer-open");
  drawer.innerHTML = `<div class="drawer-head"><div><h2>加载中…</h2></div></div>`;
  try {
    const data = await api<{ lead: Lead; activities: LeadActivity[]; sourceEvents: LeadSourceEvent[] }>(`/api/leads/${id}`);
    renderLeadDrawer(data.lead, data.activities, data.sourceEvents || []);
  } catch (error) {
    drawer.innerHTML = `<div class="drawer-head"><div><h2>加载失败</h2><p>${escapeHtml(error instanceof Error ? error.message : "")}</p></div><button class="btn icon-only" id="leadDrawerClose" title="关闭">×</button></div>`;
    qs("#leadDrawerClose", drawer)?.addEventListener("click", closeLeadDrawer);
  }
}

function closeLeadDrawer() {
  qs("#leadDrawer")?.classList.remove("open");
  qs("#leadDrawerBackdrop")?.classList.remove("active");
  document.body.classList.remove("lead-drawer-open");
}

function formatLeadDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function sourceTypeText(value?: string) {
  const labels: Record<string, string> = { outbound: "主动开发", inbound: "主动询盘", offline: "线下活动", referral: "转介绍", import: "批量导入" };
  return labels[value || ""] || value || "未标注";
}

function renderLeadDrawer(lead: Lead, activities: LeadActivity[], sourceEvents: LeadSourceEvent[]) {
  const drawer = qs<HTMLElement>("#leadDrawer");
  if (!drawer) return;
  const sourceProspect = state.websiteOpportunities.find((item) => item.leadId === lead.id);
  const inTrash = Boolean(lead.deletedAt);
  const sourceEvent = sourceEvents[0];
  const fields: Array<[string, string]> = [
    ["联系人", lead.contact || "—"], ["国家/地区", lead.country || "—"], ["邮箱", lead.email || "—"],
    ["电话", lead.phone || "—"], ["微信", lead.wechat || "—"], ["预估金额", amount(lead.estimatedAmount || 0)]
  ];
  const sourceFields: Array<[string, string]> = [
    ["来源类型", sourceTypeText(sourceEvent?.sourceType || lead.sourceType)],
    ["来源渠道", sourceEvent?.channel || lead.sourceChannel || lead.source || "—"],
    ["来源活动", sourceEvent?.campaign || lead.sourceCampaign || "—"],
    ["外部编号", sourceEvent?.externalId || lead.externalId || "—"],
    ["来源地址", sourceEvent?.sourceUrl || lead.sourceUrl || "—"],
    ["平台发生时间", formatLeadDate(sourceEvent?.occurredAt)],
    ["系统接收时间", formatLeadDate(sourceEvent?.receivedAt || lead.createdAt)]
  ];
  const dedupeBasis = sourceEvent?.externalId
    ? `按业务员 + ${sourceEvent.channel} + ${sourceEvent.externalId} 去重`
    : "未提供平台外部编号，本次以系统线索编号留档";
  drawer.innerHTML = `
    <div class="drawer-head">
      <div><h2>${escapeHtml(lead.company)}</h2><p>${escapeHtml(lead.country || "—")} · ${escapeHtml(lead.contact || "—")}</p></div>
      <div class="lead-drawer-head-actions">${badge(inTrash ? "垃圾箱" : (LEAD_STATUS_LABEL[lead.status] || lead.status), inTrash ? "red" : (LEAD_STATUS_TONE[lead.status] || ""))}<button class="btn icon-only" id="leadDrawerClose" title="关闭">×</button></div>
    </div>
    ${lead.remark ? `<p class="lead-remark">${escapeHtml(lead.remark)}</p>` : ""}
    ${inTrash ? `
      <div class="lead-delete-audit">
        <div><span>删除原因</span><b>${escapeHtml(lead.deletedReason || "未填写")}</b></div>
        <div><span>删除时间</span><b>${escapeHtml(formatLeadDate(lead.deletedAt))}</b></div>
        <div><span>操作账号</span><b>${escapeHtml(lead.deletedBy || "—")}</b></div>
        <div><span>计划清理</span><b>${escapeHtml(formatLeadDate(lead.purgeAt))}</b></div>
      </div>
      <div class="lead-drawer-actions"><button class="btn primary" id="leadRestoreButton">恢复线索</button><button class="btn danger" id="leadPermanentButton">永久删除</button></div>
    ` : `
      <div class="lead-compose">
        <select id="leadNoteType"><option value="call">电话</option><option value="wechat">微信</option><option value="whatsapp">WhatsApp</option><option value="linkedin">LinkedIn</option><option value="email">邮件</option><option value="meeting">会面</option><option value="note">备注</option></select>
        <input id="leadNoteInput" placeholder="填写本次跟进内容" />
        <input id="leadNoteNext" placeholder="下次跟进时间（可选）" />
        <button class="btn primary" id="leadNoteButton">记录跟进</button>
      </div>
      <div class="lead-drawer-actions">
        <label>阶段<select id="leadStageSelect">${LEAD_STAGES.map((stage) => `<option ${stage === lead.stage ? "selected" : ""}>${stage}</option>`).join("")}</select></label>
        <div>
          ${lead.convertedCustomerId
            ? `${badge("已转客户", "green")}${lead.convertedDealId ? badge("已建商机", "green") : ""}`
            : `<button class="btn primary" id="leadConvertButton">转为客户</button><button class="btn danger subtle" id="leadTrashButton">移入垃圾箱</button>`}
          ${sourceProspect ? `<button class="btn" id="leadBackToProspectButton">返回来源候选</button>` : ""}
        </div>
      </div>
    `}
    <section class="lead-detail-section"><h3>联系与需求</h3><div class="info-grid">${fields.map(([label, value]) => `<div class="info"><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join("")}</div></section>
    <section class="lead-detail-section">
      <h3>来源证据</h3>
      <div class="info-grid">${sourceFields.map(([label, value]) => `<div class="info"><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join("")}</div>
      <div class="lead-dedupe"><span>去重依据</span><b>${escapeHtml(dedupeBasis)}</b><small>同一业务员、同一平台渠道和同一外部编号会复用原线索；不同业务员数据相互隔离。</small></div>
      ${sourceEvent?.rawPayload ? `<details class="lead-raw-payload"><summary>查看平台原始载荷</summary><pre>${escapeHtml(sourceEvent.rawPayload)}</pre></details>` : ""}
    </section>
    <section class="lead-detail-section"><h3>跟进记录</h3>
    <div class="timeline">
      ${activities.length ? activities.map((activity) => `<div class="timeline-item"><b>${LEAD_ACTIVITY_LABEL[activity.type] || activity.type}</b><span>${escapeHtml(activity.content)}</span><small>${new Date(activity.createdAt).toLocaleString("zh-CN")}${activity.nextFollowAt ? " · 下次：" + escapeHtml(activity.nextFollowAt) : ""}</small></div>`).join("") : `<div class="timeline-item"><span>暂无跟进记录</span></div>`}
    </div></section>`;

  qs("#leadDrawerClose", drawer)?.addEventListener("click", closeLeadDrawer);
  qs<HTMLSelectElement>("#leadStageSelect", drawer)?.addEventListener("change", (event) => {
    void changeLeadStage(lead.id, (event.target as HTMLSelectElement).value);
  });
  qs<HTMLButtonElement>("#leadConvertButton", drawer)?.addEventListener("click", () => void openLeadConversion(lead.id));
  qs<HTMLButtonElement>("#leadNoteButton", drawer)?.addEventListener("click", () => void addLeadActivity(lead.id));
  qs<HTMLButtonElement>("#leadTrashButton", drawer)?.addEventListener("click", () => openLeadTrashModal(lead));
  qs<HTMLButtonElement>("#leadRestoreButton", drawer)?.addEventListener("click", () => void restoreLead(lead.id));
  qs<HTMLButtonElement>("#leadPermanentButton", drawer)?.addEventListener("click", () => openLeadPermanentModal(lead));
  qs<HTMLButtonElement>("#leadBackToProspectButton", drawer)?.addEventListener("click", () => {
    if (!sourceProspect) return;
    state.selectedProspectId = sourceProspect.id;
    state.prospectFilter = "all";
    const index = prospectFilteredRows().findIndex((item) => item.id === sourceProspect.id);
    state.prospectPage = index >= 0 ? Math.floor(index / PROSPECT_PAGE_SIZE) + 1 : 1;
    activateNavView("prospect-list", renderProspectList);
  });
}

async function reloadLeads() {
  const [active, trash] = await Promise.all([
    api<{ leads: Lead[] }>("/api/leads"),
    api<{ leads: Lead[] }>("/api/leads?trash=true")
  ]);
  state.leads = active.leads;
  state.leadTrash = trash.leads;
  renderLeads();
}

function openLeadTrashModal(lead: Lead) {
  openModal("移入垃圾箱", `
    <p class="modal-note">线索将退出日常跟进列表，并保留 30 天来源与删除审计。已转客户线索不能删除。</p>
    <div class="form-field full"><label>删除原因</label><textarea id="leadDeleteReason" rows="3" placeholder="例如：联系方式无效、非目标市场、重复询盘"></textarea></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn danger" id="confirmLeadTrashButton">确认移入</button>`);
  qs<HTMLButtonElement>("#confirmLeadTrashButton")?.addEventListener("click", () => void trashLead(lead.id));
}

async function trashLead(id: string) {
  const reason = qs<HTMLTextAreaElement>("#leadDeleteReason")?.value.trim() || "";
  if (!reason) { toast("请填写删除原因", "error"); return; }
  try {
    await api(`/api/leads/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    closeModal();
    closeLeadDrawer();
    state.selectedLeadId = null;
    await reloadLeads();
    toast("线索已移入垃圾箱");
  } catch (error) {
    toast(error instanceof Error ? error.message : "移入垃圾箱失败", "error");
  }
}

async function restoreLead(id: string) {
  try {
    await api(`/api/leads/${id}/restore`, { method: "POST" });
    closeLeadDrawer();
    state.selectedLeadId = null;
    await reloadLeads();
    toast("线索已恢复到处理中");
  } catch (error) {
    toast(error instanceof Error ? error.message : "恢复失败", "error");
  }
}

function openLeadPermanentModal(lead: Lead) {
  openModal("永久删除线索", `
    <div class="delete-warning"><b>${escapeHtml(lead.company)}</b><span>此操作会同时删除来源事件和全部跟进记录，且无法恢复。</span></div>
    <div class="form-field full"><label>输入“永久删除”进行二次确认</label><input id="leadPermanentConfirmInput" autocomplete="off"></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn danger" id="confirmLeadPermanentButton">永久删除</button>`);
  qs<HTMLButtonElement>("#confirmLeadPermanentButton")?.addEventListener("click", () => void permanentlyDeleteLead(lead.id));
}

async function permanentlyDeleteLead(id: string) {
  if (qs<HTMLInputElement>("#leadPermanentConfirmInput")?.value.trim() !== "永久删除") {
    toast("请输入“永久删除”完成二次确认", "error");
    return;
  }
  try {
    await api(`/api/leads/${id}/permanent`, { method: "DELETE" });
    closeModal();
    closeLeadDrawer();
    state.selectedLeadId = null;
    await reloadLeads();
    toast("线索及来源记录已永久删除");
  } catch (error) {
    toast(error instanceof Error ? error.message : "永久删除失败", "error");
  }
}

async function changeLeadStage(id: string, stage: string) {
  try {
    await api(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify({ stage }) });
    await reloadLeads();
    await openLead(id);
    toast("阶段已更新");
  } catch (error) {
    toast(error instanceof Error ? error.message : "更新失败", "error");
  }
}

async function addLeadActivity(id: string) {
  const type = qs<HTMLSelectElement>("#leadNoteType")?.value || "note";
  const content = qs<HTMLInputElement>("#leadNoteInput")?.value.trim() || "";
  const nextFollowAt = qs<HTMLInputElement>("#leadNoteNext")?.value.trim() || "";
  if (!content) { toast("请填写跟进内容", "error"); return; }
  try {
    await api(`/api/leads/${id}/activities`, { method: "POST", body: JSON.stringify({ type, content, nextFollowAt }) });
    await reloadLeads();
    await openLead(id);
    toast("跟进已记录");
  } catch (error) {
    toast(error instanceof Error ? error.message : "记录失败", "error");
  }
}

function renderLeadConversionDealFields(visible: boolean) {
  const fields = qs<HTMLElement>("#leadConversionDealFields");
  if (fields) fields.classList.toggle("is-hidden", !visible);
}

async function openLeadConversion(id: string) {
  try {
    const preview = await api<{ lead: Lead; customerMatches: LeadConversionMatch[] }>(`/api/leads/${id}/conversion-preview`);
    const { lead, customerMatches } = preview;
    const matchRows = customerMatches.map((match, index) => `
      <label class="conversion-customer-option">
        <input type="radio" name="leadCustomerMode" value="existing:${escapeHtml(match.customer.id)}" ${index === 0 ? "checked" : ""}>
        <span><b>${escapeHtml(match.customer.company)}</b><small>${escapeHtml(match.customer.country)} · ${escapeHtml(match.customer.contact)} · ${match.activeDealCount} 个活跃商机</small><em>${escapeHtml(match.reasons.join("、"))} · 匹配 ${match.score} 分</em></span>
      </label>
    `).join("");
    openModal("转为客户", `
      <div class="conversion-lead-summary">
        <b>${escapeHtml(lead.company)}</b>
        <span>${escapeHtml(lead.contact || "联系人待补充")} · ${escapeHtml(lead.country || "国家待补充")} · ${escapeHtml(lead.sourceChannel || lead.source || "来源待确认")}</span>
      </div>
      <div class="form-field full">
        <label>客户归属</label>
        <div class="conversion-customer-list" id="leadConversionCustomerList">
          ${matchRows || `<div class="conversion-no-match">未发现明显重复客户，可新建客户。</div>`}
          <label class="conversion-customer-option">
            <input type="radio" name="leadCustomerMode" value="create" ${customerMatches.length ? "" : "checked"}>
            <span><b>新建客户</b><small>以当前线索资料建立一条客户档案</small></span>
          </label>
        </div>
      </div>
      <label class="conversion-deal-toggle"><input id="leadCreateDealInput" type="checkbox">同时创建商机</label>
      <div class="form-grid is-hidden" id="leadConversionDealFields">
        <div class="form-field full"><label>商机标题</label><input id="leadDealTitleInput" value="${escapeHtml(`${lead.company} 采购需求`)}"></div>
        <div class="form-field"><label>产品/需求</label><input id="leadDealProductInput" placeholder="例如：压力变送器"></div>
        <div class="form-field"><label>预计金额</label><input id="leadDealAmountInput" type="number" min="0" value="${lead.estimatedAmount || 0}"></div>
        <div class="form-field full"><label>下一步动作</label><input id="leadDealNextActionInput" value="${escapeHtml(lead.nextFollowAt || "确认产品、数量与报价要求")}"></div>
      </div>
    `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmLeadConversionButton" data-lead-id="${escapeHtml(id)}">确认转为客户</button>`);
    qs<HTMLInputElement>("#leadCreateDealInput")?.addEventListener("change", (event) => {
      renderLeadConversionDealFields((event.currentTarget as HTMLInputElement).checked);
    });
    qs<HTMLButtonElement>("#confirmLeadConversionButton")?.addEventListener("click", () => void confirmLeadConversion(id));
  } catch (error) {
    toast(error instanceof Error ? error.message : "加载入库信息失败", "error");
  }
}

async function confirmLeadConversion(id: string) {
  const selected = qs<HTMLInputElement>('input[name="leadCustomerMode"]:checked')?.value || "create";
  const createDeal = Boolean(qs<HTMLInputElement>("#leadCreateDealInput")?.checked);
  const button = qs<HTMLButtonElement>("#confirmLeadConversionButton");
  const customerMode = selected.startsWith("existing:") ? "existing" : "create";
  const payload = {
    customerMode,
    customerId: customerMode === "existing" ? selected.slice("existing:".length) : "",
    createDeal,
    deal: createDeal ? {
      title: qs<HTMLInputElement>("#leadDealTitleInput")?.value.trim() || "",
      product: qs<HTMLInputElement>("#leadDealProductInput")?.value.trim() || "",
      amount: Number(qs<HTMLInputElement>("#leadDealAmountInput")?.value || 0),
      nextAction: qs<HTMLInputElement>("#leadDealNextActionInput")?.value.trim() || ""
    } : undefined
  };
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "入库中";
    }
    const result = await api<{ customer: Customer; deal?: Deal }>(`/api/leads/${id}/convert`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const [leads, customers, deals] = await Promise.all([
      api<{ leads: Lead[] }>("/api/leads"),
      api<{ customers: Customer[] }>("/api/customers"),
      api<{ deals: Deal[] }>("/api/deals")
    ]);
    state.leads = leads.leads;
    state.customers = customers.customers;
    state.deals = deals.deals;
    renderLeads();
    renderCustomers(state.customers);
    renderPipeline(state.deals);
    closeModal();
    await openLead(id);
    void refreshDashboardOnly();
    toast(result.deal ? `已入客户并创建商机：${result.customer.company}` : `已入客户：${result.customer.company}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "入库失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "确认转为客户";
    }
  }
}

async function createLead(form: HTMLFormElement) {
  const data = new FormData(form);
  const company = String(data.get("company") || "").trim();
  if (!company) { toast("请填写客户/公司名", "error"); return; }
  const payload = {
    company,
    contact: String(data.get("contact") || ""),
    country: String(data.get("country") || ""),
    email: String(data.get("email") || ""),
    phone: String(data.get("phone") || ""),
    wechat: String(data.get("wechat") || ""),
    source: String(data.get("source") || "手动录入"),
    sourceType: String(data.get("sourceType") || "outbound"),
    sourceChannel: String(data.get("sourceChannel") || "manual"),
    sourceCampaign: String(data.get("sourceCampaign") || ""),
    externalId: String(data.get("externalId") || ""),
    sourceUrl: String(data.get("sourceUrl") || ""),
    intent: String(data.get("intent") || "中"),
    estimatedAmount: Number(data.get("estimatedAmount") || 0),
    nextFollowAt: String(data.get("nextFollowAt") || ""),
    remark: String(data.get("remark") || "")
  };
  try {
    await api<{ lead: Lead }>("/api/leads", { method: "POST", body: JSON.stringify(payload) });
    form.reset();
    qs<HTMLElement>("#leadCreateForm")?.classList.add("is-hidden");
    state.selectedLeadId = null;
    closeLeadDrawer();
    await reloadLeads();
    toast("线索已创建");
  } catch (error) {
    toast(error instanceof Error ? error.message : "创建失败", "error");
  }
}

function renderCustomers(customers: Customer[]) {
  const tbody = qs<HTMLElement>("#customers tbody");
  if (!tbody) return;
  const query = state.customerSearch.trim().toLowerCase();
  const visibleCustomers = customers.filter((customer) => {
    const matchesQuery = !query || [customer.company, customer.contact, customer.country, customer.ownerName].some((value) => (value || "").toLowerCase().includes(query));
    const matchesQueue = state.customerQueueFilter === "all"
      || (state.customerQueueFilter === "overdue" && customer.nextReminder.includes("逾期"))
      || (state.customerQueueFilter === "no-activity" && !customer.lastActivityAt)
      || (state.customerQueueFilter === "no-deal" && !customer.activeDealCount);
    return matchesQuery && matchesQueue;
  });
  state.selectedCustomerIds = state.selectedCustomerIds.filter((id) => customers.some((customer) => customer.id === id));
  renderCustomerBulkBar(visibleCustomers);
  tbody.innerHTML = visibleCustomers.length ? visibleCustomers.map((customer) => {
    const checked = state.selectedCustomerIds.includes(customer.id);
    const reminder = customer.nextReminder.includes("逾期") ? badge(customer.nextReminder, "red") : escapeHtml(customer.nextReminder);
    const pipelineStage = customer.pipelineStage || "暂无活跃商机";
    const activeDealCount = customer.activeDealCount || 0;
    return `<tr class="${customer.id === state.selectedCustomerId ? "selected" : ""} ${checked ? "checked" : ""}">
    <td><input type="checkbox" data-select-customer ${checked ? "checked" : ""}></td>
    <td><div class="company"><span class="flag">${countryFlag(customer.country)}</span><div><button type="button" class="customer-name ${activeDealCount > 0 ? "has-active-deal" : ""}" data-open-customer="${escapeHtml(customer.id)}">${escapeHtml(customer.company)}</button><span>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact)} · ${escapeHtml(customer.ownerName || "未分配")}</span></div></div></td>
    <td><div class="customer-follow-cell">${badge(pipelineStage, pipelineStage === "成交" || pipelineStage === "谈判" ? "green" : pipelineStage === "已报价" ? "amber" : "")}<span>${activeDealCount} 个活跃商机</span></div></td>
    <td><div class="customer-health-cell">${health(customer.health)}<span>${customer.health}%</span></div></td>
    <td><div class="customer-follow-cell"><span>${customer.lastActivityAt ? `最近 ${escapeHtml(formatDateTime(customer.lastActivityAt))}` : "暂无跟进"}</span><b>${reminder}</b></div></td>
    <td>${badge(customer.wecomBound ? "已绑定" : "未绑定", customer.wecomBound ? "green" : "gray")}</td>
    <td><button class="btn" data-edit-customer>编辑</button></td>
  </tr>`;
  }).join("") : `<tr><td colspan="7" class="empty-cell">当前筛选下暂无客户。</td></tr>`;
  const mobile = qs<HTMLElement>("#customerMobileList");
  if (mobile) mobile.innerHTML = visibleCustomers.length ? visibleCustomers.map((customer) => `
    <article class="customer-mobile-card" data-customer-mobile-id="${escapeHtml(customer.id)}">
      <span class="customer-mobile-top"><button type="button" class="customer-name ${(customer.activeDealCount || 0) > 0 ? "has-active-deal" : ""}" data-open-customer="${escapeHtml(customer.id)}">${escapeHtml(customer.company)}</button>${badge(customer.pipelineStage || "暂无商机", customer.pipelineStage === "谈判" || customer.pipelineStage === "成交" ? "green" : customer.pipelineStage === "已报价" ? "amber" : "gray")}</span>
      <span>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact)} · ${escapeHtml(customer.ownerName || "未分配")}</span>
      <span class="customer-mobile-meta"><i>${customer.activeDealCount || 0} 个活跃商机</i><i>${escapeHtml(customer.nextReminder || "待安排")}</i><i>${customer.lastActivityAt ? `最近 ${escapeHtml(formatDateTime(customer.lastActivityAt))}` : "暂无跟进"}</i></span>
    </article>`).join("") : `<div class="empty-cell">当前筛选下暂无客户。</div>`;
  qsa<HTMLElement>("tr", tbody).forEach((row, index) => {
    const customer = visibleCustomers[index];
    if (!customer) return;
    row.dataset.customerId = customer.id;
    row.classList.toggle("selected", customer.id === (state.selectedCustomerId || customers[0]?.id));
  });
  qsa<HTMLButtonElement>("[data-open-customer]", qs("#customers")!).forEach((button) => button.addEventListener("click", () => {
    const customer = customers.find((item) => item.id === button.dataset.openCustomer);
    if (!customer) return;
    state.selectedCustomerId = customer.id;
    renderCustomerDrawer(customer);
    openCustomerDrawer();
    qsa<HTMLElement>("tr", tbody).forEach((item) => item.classList.toggle("selected", item.dataset.customerId === customer.id));
  }));
  qsa<HTMLInputElement>("[data-select-customer]", tbody).forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      const id = checkbox.closest<HTMLElement>("tr")?.dataset.customerId || "";
      if (!id) return;
      state.selectedCustomerIds = checkbox.checked
        ? Array.from(new Set([...state.selectedCustomerIds, id]))
        : state.selectedCustomerIds.filter((selectedId) => selectedId !== id);
      renderCustomers(state.customers);
    });
  });
  qsa<HTMLButtonElement>("[data-edit-customer]", tbody).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const customer = state.customers.find((item) => item.id === button.closest<HTMLElement>("tr")?.dataset.customerId);
      if (customer) openCustomerModal(customer);
    });
  });
  const selected = customers.find((item) => item.id === state.selectedCustomerId);
  if (selected && qs("#customerDrawer")?.classList.contains("open")) renderCustomerDrawer(selected);
}

function renderCustomerBulkBar(customers: Customer[]) {
  const toolbar = qs<HTMLElement>("#customerBulkToolbar");
  if (!toolbar) return;
  const selectedCount = state.selectedCustomerIds.length;
  const allSelected = customers.length > 0 && selectedCount === customers.length;
  toolbar.innerHTML = `
    <label class="customer-select-all"><input type="checkbox" data-select-all-customers ${allSelected ? "checked" : ""}>全选</label>
    <span class="filter">已选 ${selectedCount} 个客户</span>
    <span class="filter">国家：全部</span><span class="filter">商机阶段：全部</span><span class="filter">最近跟进：30 天</span>
    <button class="btn danger" data-bulk-delete-customers ${selectedCount ? "" : "disabled"}>批量删除</button>
    <button class="btn">批量导出</button>
  `;
  qs<HTMLInputElement>("[data-select-all-customers]", toolbar)?.addEventListener("change", (event) => {
    state.selectedCustomerIds = (event.currentTarget as HTMLInputElement).checked ? customers.map((customer) => customer.id) : [];
    renderCustomers(state.customers);
  });
  qs<HTMLButtonElement>("[data-bulk-delete-customers]", toolbar)?.addEventListener("click", () => void bulkDeleteCustomers());
}

function customerRelatedDeals(customer: Customer) {
  return state.deals
    .filter((deal) => deal.customerId === customer.id)
    .sort((left, right) => Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)) || right.amount - left.amount);
}

function dealTone(deal: Deal) {
  if (deal.stage === "丢单") return "red";
  if (deal.stage === "成交") return "green";
  if (deal.archivedAt) return "gray";
  if (deal.stage === "已报价") return "amber";
  return "";
}

function renderCustomerDealProgress(customer: Customer) {
  const deals = customerRelatedDeals(customer);
  if (!deals.length) {
    return `
      <section class="customer-deals">
        <div class="customer-deals-head"><h3>相关商机进展</h3><button class="btn" data-view-related-deals>查看商机管道</button></div>
        <div class="customer-deal-empty">暂无关联商机。新增商机时选择该客户后，会自动显示在这里。</div>
      </section>
    `;
  }
  return `
    <section class="customer-deals">
      <div class="customer-deals-head"><h3>相关商机进展</h3><button class="btn" data-view-related-deals>查看商机管道</button></div>
      <div class="customer-deal-list">
        ${deals.map((deal) => `
          <article class="customer-deal-row">
            <div>
              <b>${escapeHtml(deal.title)}</b>
              <span>${escapeHtml(deal.nextAction)}${deal.archivedAt ? ` · ${escapeHtml(formatDateTime(deal.archivedAt))}` : ""}</span>
            </div>
            <div class="customer-deal-meta">
              ${badge(deal.archivedAt && deal.stage !== "丢单" ? "已归档" : deal.stage, dealTone(deal))}
              <strong>${money(deal.amount)}</strong>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function customerTimeZone(country = "") {
  const normalized = country.trim().toLowerCase();
  const zones: Record<string, string> = {
    中国: "Asia/Shanghai",
    china: "Asia/Shanghai",
    瑞典: "Europe/Stockholm",
    sweden: "Europe/Stockholm",
    美国: "America/New_York",
    usa: "America/New_York",
    "united states": "America/New_York",
    日本: "Asia/Tokyo",
    japan: "Asia/Tokyo",
    阿联酋: "Asia/Dubai",
    uae: "Asia/Dubai",
    德国: "Europe/Berlin",
    germany: "Europe/Berlin",
    法国: "Europe/Paris",
    france: "Europe/Paris",
    意大利: "Europe/Rome",
    italy: "Europe/Rome",
    西班牙: "Europe/Madrid",
    spain: "Europe/Madrid",
    荷兰: "Europe/Amsterdam",
    netherlands: "Europe/Amsterdam",
    英国: "Europe/London",
    uk: "Europe/London",
    印度: "Asia/Kolkata",
    india: "Asia/Kolkata",
    澳大利亚: "Australia/Sydney",
    australia: "Australia/Sydney",
    土耳其: "Europe/Istanbul",
    turkey: "Europe/Istanbul",
    智利: "America/Santiago",
    chile: "America/Santiago"
  };
  return zones[normalized] || zones[country.trim()] || "UTC";
}

function customerWorldTimeParts(country: string) {
  const timeZone = customerTimeZone(country);
  const now = new Date();
  try {
    const time = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
    const date = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      weekday: "short",
      month: "2-digit",
      day: "2-digit"
    }).format(now);
    const hourText = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(now);
    const hour = Number(hourText);
    const dayPart = hour >= 6 && hour < 12 ? "上午" : hour >= 12 && hour < 18 ? "下午" : hour >= 18 && hour < 22 ? "晚上" : "深夜";
    const contactHint = hour >= 8 && hour < 18 ? "适合联系" : hour >= 18 && hour < 22 ? "谨慎联系" : "建议预约";
    return { time, date, timeZone, dayPart, contactHint };
  } catch {
    return { time: now.toLocaleTimeString("zh-CN"), date: now.toLocaleDateString("zh-CN"), timeZone: "UTC", dayPart: "未知", contactHint: "待确认" };
  }
}

function renderCustomerWorldClock(customer: Customer) {
  const clock = qs<HTMLElement>("#customerWorldClock");
  const date = qs<HTMLElement>("#customerWorldDate");
  const zone = qs<HTMLElement>("#customerWorldZone");
  const status = qs<HTMLElement>("#customerWorldStatus");
  if (!clock || !date || !zone || !status) return;
  const parts = customerWorldTimeParts(customer.country);
  clock.textContent = parts.time;
  date.textContent = `${customer.country}当地 · ${parts.date}`;
  zone.textContent = parts.timeZone;
  status.textContent = `${parts.dayPart} · ${parts.contactHint}`;
}

function renderCustomerDrawer(customer?: Customer) {
  const drawer = qs<HTMLElement>("#customerDrawer");
  if (!drawer || !customer) return;
  const billingName = customer.billingName || customer.company;
  const billingAddress = customer.billingAddress || `${customer.country} / 地址待维护`;
  const documentContact = customer.documentContact || customer.contact;
  const portDischarge = customer.defaultPortDischarge || "待确认";
  const incoterm = customer.defaultIncoterm || "FOB Tianjin";
  const paymentTerm = customer.defaultPaymentTerm || "30% T/T deposit, 70% before shipment";
  const pipelineStage = customer.pipelineStage || "暂无活跃商机";
  const pipelineAmount = customer.pipelineAmount || 0;
  const activeDealCount = customer.activeDealCount || 0;
  drawer.innerHTML = `
    <div class="drawer-head">
      <div><h2>${escapeHtml(customer.company)}</h2><p>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact)} · ${escapeHtml(customer.ownerName || "未分配")} · ${escapeHtml(pipelineStage)}</p></div>
      <div class="inline-actions">${customer.nextReminder.includes("逾期") ? badge("报价未回复", "red") : badge("跟进中", "green")}<button class="btn icon-only" id="customerDrawerClose" title="关闭" aria-label="关闭客户详情">×</button></div>
    </div>
    <section class="customer-time-card" aria-label="客户世界时间">
      <div>
        <span>客户世界时间</span>
        <strong id="customerWorldClock">--:--:--</strong>
        <small id="customerWorldDate">当地日期加载中</small>
      </div>
      <div class="customer-time-side">
        <b id="customerWorldStatus">待确认</b>
        <em id="customerWorldZone">UTC</em>
      </div>
    </section>
    <div class="score-card">
      <div class="score-ring"><span>${customer.health}</span></div>
      <div><b>跟进评分：${customer.health >= 80 ? "健康" : customer.health >= 60 ? "需保持" : "需抢救"}</b><p>系统按阶段、健康度、企微状态和下一提醒生成跟进优先级。</p></div>
    </div>
    <div class="info-grid">
      <div class="info"><span>健康度</span><b>${customer.health}%</b></div>
      <div class="info"><span>最高活跃阶段</span><b>${escapeHtml(pipelineStage)}</b></div>
      <div class="info"><span>活跃商机数</span><b>${activeDealCount}</b></div>
      <div class="info"><span>在手商机额</span><b>${money(pipelineAmount)}</b></div>
      <div class="info"><span>下一提醒</span><b>${escapeHtml(customer.nextReminder)}</b></div>
      <div class="info"><span>企微状态</span><b>${customer.wecomBound ? "已绑定" : "未绑定"}</b></div>
    </div>
    <div class="inline-actions"><button class="btn primary" data-add-follow>新增跟进记录</button><button class="btn" data-edit-customer-drawer>编辑客户</button></div>
    <section class="customer-doc-info">
      <div class="customer-deals-head"><h3>单据基础信息</h3><button class="btn" data-edit-customer-document-info>维护信息</button></div>
      <div class="info-grid">
        <div class="info"><span>单据抬头</span><b>${escapeHtml(billingName)}</b></div>
        <div class="info"><span>单据联系人</span><b>${escapeHtml(documentContact)}</b></div>
        <div class="info"><span>目的港</span><b>${escapeHtml(portDischarge)}</b></div>
        <div class="info"><span>贸易条款</span><b>${escapeHtml(incoterm)}</b></div>
      </div>
      <div class="timeline-item"><b>账单地址</b><span>${escapeHtml(billingAddress)}</span></div>
      <div class="timeline-item"><b>付款条款</b><span>${escapeHtml(paymentTerm)}</span></div>
    </section>
    <div class="timeline">
      ${(customer.activities || []).length ? (customer.activities || []).map((activity) => `<div class="timeline-item"><b>${escapeHtml(customerActivityLabel(activity.type))}</b><span>${escapeHtml(activity.content)}</span><small>${escapeHtml(activity.operatorName || "未知操作人")} · ${escapeHtml(formatDateTime(activity.createdAt))}${activity.nextReminder ? ` · 下次：${escapeHtml(activity.nextReminder)}` : ""}</small></div>`).join("") : `<div class="timeline-item"><b>暂无跟进记录</b><span>新增首条电话、邮件或社媒跟进后，将在这里形成连续时间线。</span></div>`}
    </div>
    ${renderCustomerDealProgress(customer)}
  `;
  if (customerClockTimer) window.clearInterval(customerClockTimer);
  renderCustomerWorldClock(customer);
  customerClockTimer = window.setInterval(() => renderCustomerWorldClock(customer), 1000);
  qs("#customerDrawerClose", drawer)?.addEventListener("click", closeCustomerDrawer);
  qs<HTMLButtonElement>("[data-add-follow]", drawer)?.addEventListener("click", () => addFollowRecord(customer));
  qsa<HTMLButtonElement>("[data-edit-customer-drawer]", drawer).forEach((button) => {
    button.addEventListener("click", () => openCustomerModal(customer));
  });
  qsa<HTMLButtonElement>("[data-edit-customer-document-info]", drawer).forEach((button) => {
    button.addEventListener("click", () => openCustomerModal(customer));
  });
  qs<HTMLButtonElement>("[data-view-related-deals]", drawer)?.addEventListener("click", () => activateNavView("pipeline"));
}

function customerActivityLabel(type: string) {
  const labels: Record<string, string> = { call: "电话", email: "邮件", whatsapp: "WhatsApp", wechat: "微信", meeting: "会议", note: "备注" };
  return labels[type] || "跟进";
}

function openCustomerDrawer() {
  qs("#customerDrawer")?.classList.add("open");
  qs("#customerDrawerBackdrop")?.classList.add("active");
  document.body.classList.add("customer-drawer-open");
}

function closeCustomerDrawer() {
  qs("#customerDrawer")?.classList.remove("open");
  qs("#customerDrawerBackdrop")?.classList.remove("active");
  document.body.classList.remove("customer-drawer-open");
  if (customerClockTimer) window.clearInterval(customerClockTimer);
}

function countryFlag(country: string) {
  const flags: Record<string, string> = { 瑞典: "SE", 美国: "US", 日本: "JP", 阿联酋: "AE", 德国: "DE" };
  return flags[country] || "GL";
}

function health(value: number) {
  const active = Math.max(1, Math.round(value / 20));
  return `<span class="health ${value < 60 ? "bad" : value < 75 ? "warn" : ""}">${[1, 2, 3, 4, 5].map((item) => `<i class="${item <= active ? "on" : ""}"></i>`).join("")}</span>`;
}

function renderPipeline(deals: Deal[]) {
  const strip = qs<HTMLElement>("#pipeline .pipeline-strip");
  if (!strip) return;
  const activeDeals = deals.filter((deal) => !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单");
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判"];
  if (!stages.includes(state.pipelineStageFilter)) state.pipelineStageFilter = stages[0];
  const today = todayDateInput();
  const filtered = activeDeals.filter((deal) => {
    const customer = state.customers.find((item) => item.id === deal.customerId);
    const haystack = `${deal.title} ${deal.product || ""} ${customer?.company || ""}`.toLowerCase();
    if (state.pipelineSearch && !haystack.includes(state.pipelineSearch.toLowerCase())) return false;
    if (state.pipelineDueFilter === "overdue") return Boolean(deal.nextActionAt && deal.nextActionAt < today);
    if (state.pipelineDueFilter === "today") return deal.nextActionAt === today;
    if (state.pipelineDueFilter === "future") return Boolean(deal.nextActionAt && deal.nextActionAt > today);
    return true;
  });
  renderPipelineSummary(activeDeals);
  renderPipelineStageTabs(stages, filtered);
  strip.innerHTML = stages.map((stage) => {
    const stageDeals = filtered.filter((deal) => deal.stage === stage);
    const stageAmount = stageDeals.reduce((sum, deal) => sum + deal.amount, 0);
    const overdue = stageDeals.filter((deal) => deal.nextActionAt && deal.nextActionAt < today).length;
    return `<section class="stage ${stage === state.pipelineStageFilter ? "mobile-active" : ""}" data-pipeline-stage="${stage}" aria-label="${stage}阶段">
      <div class="stage-head"><span class="stage-head-main"><b>${stage}</b><small>${stageDeals.length} 个 · ${dealMoney(stageAmount, stageDeals[0]?.currency || "USD")}${overdue ? ` · ${overdue} 个逾期` : ""}</small></span><b>${stageDeals.length}</b></div>
      ${stageDeals.map((deal) => {
      const product = deal.product?.trim() || "产品待维护";
      const quantity = Number(deal.quantity || 0);
      const unitPrice = Number(deal.unitPrice || 0);
      const customer = state.customers.find((item) => item.id === deal.customerId);
      const isOverdue = Boolean(deal.nextActionAt && deal.nextActionAt < today);
      const hasDocument = state.tradeDocuments.some((document) => document.dealId === deal.id);
      return `<article class="deal" data-deal-id="${escapeHtml(deal.id)}" tabindex="0">
        <b>${escapeHtml(deal.title)}</b>
        <span class="deal-customer">${escapeHtml(customer?.company || "客户待确认")} · ${escapeHtml(customer?.country || "未知国家")}</span>
        <span class="deal-product">${escapeHtml(product)} · ${quantity || "-"} 件 × ${dealMoney(unitPrice, deal.currency)}</span>
        <span>${escapeHtml(deal.nextAction)}</span>
        <span class="deal-date ${isOverdue ? "overdue" : ""}">${isOverdue ? "已逾期" : "下一动作"} · ${escapeHtml(deal.nextActionAt || "待安排")}</span>
        <span class="deal-doc-status">${hasDocument ? "已关联单据" : "未关联单据"} · 预计成交 ${escapeHtml(deal.expectedCloseAt || "待评估")}</span>
        <div class="deal-foot"><span>${dealMoney(deal.amount, deal.currency)}</span>${badge(deal.stage, deal.stage === "已报价" ? "amber" : "")}</div>
        <div class="deal-actions">
          <button class="btn primary deal-primary-action" data-move-deal>${dealPrimaryAction(deal.stage)}</button>
          <div class="deal-secondary-actions">
            <button type="button" class="btn" data-record-deal>记录进展</button>
            ${["已报价", "样品", "谈判"].includes(deal.stage) ? `<button type="button" class="btn" data-print-deal-document>生成 PI</button>` : ""}
            <button type="button" class="btn danger" data-lost-deal>标记丢单</button>
          </div>
        </div>
      </article>`;
    }).join("") || `<div class="deal-empty">当前阶段暂无匹配商机</div>`}
    </section>`;
  }).join("");
  qsa<HTMLElement>(".deal[data-deal-id]", strip).forEach((card) => {
    const open = () => openDealDrawer(card.dataset.dealId || "");
    card.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button, summary, details")) return;
      open();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
  });
  qsa<HTMLButtonElement>("[data-record-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => openDealEventModal(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  qsa<HTMLButtonElement>("[data-print-deal-document]", strip).forEach((button) => {
    button.addEventListener("click", () => void printDealDocument(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  qsa<HTMLButtonElement>("[data-move-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => openDealStageModal(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  qsa<HTMLButtonElement>("[data-lost-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => void markDealLost(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
}

function dealMoney(value: number, currency = "USD") {
  return `${escapeHtml(currency || "USD")} ${Math.round(Number(value || 0)).toLocaleString("en-US")}`;
}

function dealPrimaryAction(stage: string) {
  return stage === "谈判" ? "确认成交" : "推进阶段";
}

function renderPipelineSummary(activeDeals: Deal[]) {
  const box = qs<HTMLElement>("#pipelineSummary");
  if (!box) return;
  const today = todayDateInput();
  const overdue = activeDeals.filter((deal) => deal.nextActionAt && deal.nextActionAt < today).length;
  const todayCount = activeDeals.filter((deal) => deal.nextActionAt === today).length;
  const missing = activeDeals.filter((deal) => !deal.nextActionAt || !deal.expectedCloseAt).length;
  const currencies = [...new Set(activeDeals.map((deal) => deal.currency || "USD"))];
  const amountLabel = currencies.length === 1
    ? dealMoney(activeDeals.reduce((sum, deal) => sum + deal.amount, 0), currencies[0])
    : `${currencies.length} 种币种，分币种查看`;
  box.innerHTML = [
    ["活跃商机", `${activeDeals.length} 个`, "仅含待推进五阶段"],
    ["动作逾期", `${overdue} 个`, overdue ? "优先处理已过期承诺" : "暂无逾期动作"],
    ["今天到期", `${todayCount} 个`, "今天应完成的下一动作"],
    ["在手金额", amountLabel, missing ? `${missing} 个日期待补齐` : "日期完整"]
  ].map(([label, value, note]) => `<div class="pipeline-summary-item"><span>${label}</span><b>${value}</b><small>${note}</small></div>`).join("");
}

function renderPipelineStageTabs(stages: string[], deals: Deal[]) {
  const box = qs<HTMLElement>("#pipelineStageTabs");
  if (!box) return;
  box.innerHTML = stages.map((stage) => `<button type="button" class="${stage === state.pipelineStageFilter ? "active" : ""}" data-pipeline-stage-tab="${stage}">${stage} ${deals.filter((deal) => deal.stage === stage).length}</button>`).join("");
  qsa<HTMLButtonElement>("[data-pipeline-stage-tab]", box).forEach((button) => {
    button.addEventListener("click", () => {
      state.pipelineStageFilter = button.dataset.pipelineStageTab || stages[0];
      renderPipeline(state.deals);
    });
  });
}

function tradeDocumentFromDeal(deal: Deal, customer: Customer): TradeDocument {
  const type: "PI" | "CI" = deal.stage === "成交" ? "CI" : "PI";
  const date = todayDateInput();
  const quantity = Math.max(1, Math.round(Number(deal.quantity || 0)));
  const unitPrice = Number(deal.unitPrice || 0) || Number(deal.amount || 0) / quantity;
  const product = deal.product?.trim() || deal.title;
  return {
    id: "__new__",
    customerId: customer.id,
    dealId: deal.id,
    revision: Math.max(0, ...state.tradeDocuments.filter((document) => document.dealId === deal.id && document.type === type).map((document) => document.revision || 1)) + 1,
    type,
    title: `${customer.company} ${product} ${type}`,
    number: `${type}-${date.replace(/-/g, "")}-${Math.floor(Date.now() / 1000).toString().slice(-4)}`,
    issueDate: date,
    buyer: customer.billingName?.trim() || customer.company,
    buyerAddress: customer.billingAddress?.trim() || `${customer.country} / address to be confirmed`,
    buyerContact: customer.documentContact?.trim() || customer.contact,
    seller: "GoodJob Instrument Co., Ltd.",
    sellerAddress: "Tianjin, China",
    currency: deal.currency || "USD",
    incoterm: customer.defaultIncoterm?.trim() || "FOB Tianjin",
    paymentTerm: customer.defaultPaymentTerm?.trim() || "30% T/T deposit, 70% before shipment",
    shippingMethod: "Sea freight",
    portLoading: "Tianjin, China",
    portDischarge: customer.defaultPortDischarge?.trim() || "",
    validityDate: "",
    bankInfo: "Beneficiary: GoodJob Instrument Co., Ltd. / Bank: Bank of China Tianjin Branch / SWIFT: BKCHCNBJ",
    notes: `Generated from deal: ${deal.title}. ${deal.nextAction}`,
    templateStyle: "executive",
    status: "ready",
    audits: [],
    sendRecords: [],
    updatedAt: new Date().toISOString(),
    items: [{
      id: `deal_item_${deal.id}`,
      product,
      model: "",
      hsCode: "",
      quantity,
      unit: "PCS",
      unitPrice: Math.round(unitPrice * 100) / 100,
      originCountry: "China",
      weightKg: 0,
      packageCount: 0
    }]
  };
}

async function printDealDocument(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const customer = state.customers.find((item) => item.id === deal.customerId);
  if (!customer) {
    toast("请先给商机关联客户，再一键打印", "error");
    return;
  }
  const draft = tradeDocumentFromDeal(deal, customer);
  const created = await api<{ document: TradeDocument }>("/api/trade-documents", {
    method: "POST",
    body: JSON.stringify(draft)
  });
  state.tradeDocuments = [created.document, ...state.tradeDocuments.filter((document) => document.id !== created.document.id)];
  await refreshDealsData(false);
  state.selectedDocumentId = created.document.id;
  activateNavView("documents");
  renderTradeDocuments(state.tradeDocuments);
  toast("已按客户资料生成并打印 PI 草稿；审批通过后可正式导出");
  printDocumentPreview();
}

function openDealStageModal(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交"] as const;
  const nextStage = stages[Math.min(stages.indexOf(deal.stage as typeof stages[number]) + 1, stages.length - 1)];
  const resultLabel: Record<string, string> = {
    "已联系": "本次联系结果",
    "已报价": "报价依据或发送结果",
    "样品": "样品安排与反馈计划",
    "谈判": "客户异议与当前谈判条件",
    "成交": "客户确认结果"
  };
  openModal(`${deal.stage} → ${nextStage}`, `
    <div class="form-grid">
      <div class="form-field full"><label>${resultLabel[nextStage] || "本次推进结果"}</label><textarea id="dealStageResultInput" rows="4" placeholder="记录本次推进的事实依据"></textarea></div>
      <div class="form-field full"><label>下一步动作</label><input id="dealStageNextActionInput" value="${escapeHtml(nextDealAction(nextStage))}"></div>
      <div class="form-field"><label>下一动作日期</label><input id="dealStageNextActionAtInput" type="date" value="${escapeHtml(defaultFutureDate(2))}"></div>
      <div class="form-field"><label>预计成交日期${["已报价", "样品", "谈判", "成交"].includes(nextStage) ? "（必填）" : ""}</label><input id="dealStageExpectedCloseAtInput" type="date" value="${escapeHtml(deal.expectedCloseAt || defaultFutureDate(21))}"></div>
      ${nextStage === "成交" ? `<div class="form-field full"><label>成交依据</label><textarea id="dealWonReasonInput" rows="3" placeholder="例如：客户已确认 PI、金额、付款条件与订单日期"></textarea></div>` : ""}
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmDealStageButton">确认进入${nextStage}</button>`);
  qs("#confirmDealStageButton")?.addEventListener("click", () => void moveDeal(id, nextStage));
}

function nextDealAction(stage: string) {
  const map: Record<string, string> = {
    "已联系": "确认产品、数量与报价要求",
    "已报价": "跟进报价反馈并确认异议",
    "样品": "确认样品寄出与反馈日期",
    "谈判": "确认价格、账期、交期和贸易条款",
    "成交": "确认定金与订单交付"
  };
  return map[stage] || "安排下一步跟进";
}

function defaultFutureDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function moveDeal(id: string, nextStage: string) {
  const resultText = qs<HTMLTextAreaElement>("#dealStageResultInput")?.value.trim() || "";
  const nextAction = qs<HTMLInputElement>("#dealStageNextActionInput")?.value.trim() || "";
  const nextActionAt = qs<HTMLInputElement>("#dealStageNextActionAtInput")?.value || "";
  const expectedCloseAt = qs<HTMLInputElement>("#dealStageExpectedCloseAtInput")?.value || "";
  const wonReason = qs<HTMLTextAreaElement>("#dealWonReasonInput")?.value.trim() || "";
  if (!resultText || !nextAction || !nextActionAt) {
    toast("请填写推进结果、下一动作和日期", "error");
    return;
  }
  if (["已报价", "样品", "谈判", "成交"].includes(nextStage) && !expectedCloseAt) {
    toast("进入该阶段前请填写预计成交日期", "error");
    return;
  }
  if (nextStage === "成交" && !wonReason) {
    toast("请填写客户确认成交的依据", "error");
    return;
  }
  const result = await api<{ deal: Deal }>(`/api/deals/${id}/stage`, {
    method: "PATCH",
    body: JSON.stringify({ stage: nextStage, result: resultText, nextAction, nextActionAt, expectedCloseAt, wonReason })
  });
  closeModal();
  await refreshDealsData();
  void refreshDashboardOnly();
  toast(`商机已推进到：${nextStage}`);
}

async function archiveDeal(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const result = await api<{ deal: Deal }>(`/api/deals/${id}/archive`, { method: "POST" });
  Object.assign(deal, result.deal);
  if (state.selectedDealId === id) closeDealDrawer();
  await refreshDealsData();
  void refreshDashboardOnly();
  toast("成交商机已归档");
}

function markDealLost(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  openModal("丢单复盘", `
    <div class="form-grid">
      <div class="form-field"><label>丢单原因分类</label><select id="dealLostCategoryInput"><option>价格原因</option><option>产品不匹配</option><option>交期原因</option><option>付款条件</option><option>客户项目取消</option><option>竞争对手</option><option>其他</option></select></div>
      <div class="form-field"><label>复访日期（可选）</label><input id="dealRevisitAtInput" type="date"></div>
      <div class="form-field full"><label>具体原因</label><textarea id="dealLostReasonInput" rows="4" placeholder="记录客户反馈、竞争情况和后续可能性"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn danger" id="confirmDealLostButton">确认丢单</button>`);
  qs("#confirmDealLostButton")?.addEventListener("click", () => void submitDealLost(id));
}

async function submitDealLost(id: string) {
  const category = qs<HTMLSelectElement>("#dealLostCategoryInput")?.value || "";
  const reason = qs<HTMLTextAreaElement>("#dealLostReasonInput")?.value.trim() || "";
  const revisitAt = qs<HTMLInputElement>("#dealRevisitAtInput")?.value || "";
  if (!reason) {
    toast("请填写具体丢单原因", "error");
    return;
  }
  const result = await api<{ deal: Deal }>(`/api/deals/${id}/lost`, {
    method: "POST",
    body: JSON.stringify({ category, reason, revisitAt })
  });
  Object.assign(state.deals.find((item) => item.id === id) || {}, result.deal);
  closeModal();
  await refreshDealsData();
  void refreshDashboardOnly();
  toast("商机已标记丢单，可在关闭区复盘");
}

function formatDateTime(value?: string) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function refreshClosedDeals() {
  const params = new URLSearchParams({
    page: String(state.closedDealPage),
    pageSize: "10",
    keyword: state.closedDealKeyword,
    status: state.closedDealStatus,
    month: state.closedDealMonth
  });
  const result = await api<{ deals: Deal[]; total: number; page: number; pageSize: number; counts: { won: number; lost: number; revisit: number } }>(`/api/deals/closed?${params.toString()}`);
  state.closedDeals = result.deals;
  state.closedDealTotal = result.total;
  state.closedDealCounts = result.counts;
  renderArchivedDeals(result.deals, result.total, result.page, result.pageSize);
}

function renderArchivedDeals(deals: Deal[], total: number, page: number, pageSize: number) {
  const box = qs<HTMLElement>("#pipeline-archived-deals");
  if (!box) return;
  const summary = qs<HTMLElement>("#pipelineClosedSummary");
  if (summary) summary.textContent = `已成交 ${state.closedDealCounts.won} · 已丢单 ${state.closedDealCounts.lost} · 待复访 ${state.closedDealCounts.revisit}`;
  box.innerHTML = deals.length ? deals.map((deal) => {
    const customer = state.customers.find((item) => item.id === deal.customerId);
    const product = `${deal.product?.trim() || "产品待维护"} · ${Number(deal.quantity || 0) || "-"} 件 × ${money(Number(deal.unitPrice || 0))}`;
    const review = deal.stage === "丢单"
      ? `${deal.lostReasonCategory || "未分类"}：${deal.lostReason || "待补充复盘"}${deal.revisitAt ? ` · ${deal.revisitAt} 复访` : ""}`
      : `${deal.wonReason || "已成交"}${deal.archivedAt ? " · 已归档" : " · 待归档"}`;
    return `<tr data-closed-deal-id="${escapeHtml(deal.id)}"><td><b>${escapeHtml(deal.title)}</b><span>${escapeHtml(customer?.company || "客户待确认")} · ${escapeHtml(product)}</span></td><td>${dealMoney(deal.amount, deal.currency)}</td><td>${badge(deal.stage, deal.stage === "丢单" ? "red" : "green")}</td><td>${escapeHtml(formatDateTime(deal.closedAt || deal.archivedAt))}</td><td>${escapeHtml(review)}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="empty-cell">当前筛选下暂无关闭商机。</td></tr>`;
  qsa<HTMLElement>("[data-closed-deal-id]", box).forEach((row) => row.addEventListener("click", () => openDealDrawer(row.dataset.closedDealId || "")));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageLabel = qs<HTMLElement>("#pipelineClosedPage");
  if (pageLabel) pageLabel.textContent = `第 ${page} / ${totalPages} 页 · ${total} 条`;
  const prev = qs<HTMLButtonElement>("#pipelineClosedPrev");
  const next = qs<HTMLButtonElement>("#pipelineClosedNext");
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page >= totalPages;
}

async function refreshDealsData(render = true) {
  const result = await api<{ deals: Deal[]; events: DealEvent[] }>("/api/deals");
  state.deals = result.deals;
  state.dealEvents = result.events;
  if (render) renderPipeline(state.deals);
  await refreshClosedDeals();
  if (state.selectedDealId) renderDealDrawer(state.selectedDealId);
}

function dealEventLabel(type: string) {
  const labels: Record<string, string> = {
    created: "创建商机",
    updated: "关键信息更新",
    stage: "阶段变化",
    follow_up: "跟进记录",
    quote: "报价记录",
    sample: "样品记录",
    negotiation: "谈判记录",
    payment: "回款记录",
    document: "单据记录",
    won: "确认成交",
    lost: "丢单复盘",
    archived: "归档"
  };
  return labels[type] || type;
}

function openDealDrawer(id: string) {
  if (!id) return;
  state.selectedDealId = id;
  renderDealDrawer(id);
  qs("#dealDrawer")?.classList.add("open");
  qs("#dealDrawerBackdrop")?.classList.add("open");
}

function closeDealDrawer() {
  state.selectedDealId = null;
  qs("#dealDrawer")?.classList.remove("open");
  qs("#dealDrawerBackdrop")?.classList.remove("open");
}

function renderDealDrawer(id: string) {
  const drawer = qs<HTMLElement>("#dealDrawer");
  if (!drawer) return;
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) {
    closeDealDrawer();
    return;
  }
  const customer = state.customers.find((item) => item.id === deal.customerId);
  const events = state.dealEvents.filter((event) => event.dealId === deal.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const documents = state.tradeDocuments.filter((document) => document.dealId === deal.id).sort((left, right) => right.revision - left.revision);
  const closed = deal.stage === "成交" || deal.stage === "丢单";
  drawer.innerHTML = `
    <div class="deal-detail-head">
      <div><h2>${escapeHtml(deal.title)}</h2><p>${escapeHtml(customer?.company || "客户待确认")} · ${escapeHtml(deal.product || "产品待维护")}</p></div>
      <button class="btn" id="closeDealDrawerButton">关闭</button>
    </div>
    <div class="deal-detail-grid">
      <div class="info"><span>当前阶段</span><b>${escapeHtml(deal.stage)} · 进入于 ${escapeHtml(formatDateTime(deal.stageChangedAt))}</b></div>
      <div class="info"><span>金额口径</span><b>${dealMoney(deal.amount, deal.currency)} · ${deal.amountType === "won" ? "成交额" : deal.amountType === "quoted" ? "报价额" : "估算额"}</b></div>
      <div class="info"><span>下一动作</span><b>${escapeHtml(deal.nextAction)} · ${escapeHtml(deal.nextActionAt || "待安排")}</b></div>
      <div class="info"><span>预计成交</span><b>${escapeHtml(deal.expectedCloseAt || "待评估")}</b></div>
      <div class="info"><span>关联单据</span><b>${documents.length ? documents.map((document) => `${document.type} ${escapeHtml(document.number)} v${document.revision}`).join(" · ") : "暂未关联 PI/CI"}</b></div>
      <div class="info"><span>${deal.stage === "丢单" ? "丢单复盘" : "关闭状态"}</span><b>${deal.stage === "丢单" ? `${escapeHtml(deal.lostReasonCategory || "未分类")}：${escapeHtml(deal.lostReason || "待补充")}` : deal.stage === "成交" ? escapeHtml(deal.wonReason || "已确认成交") : "活跃推进中"}</b></div>
    </div>
    <div class="deal-detail-actions">
      ${closed ? "" : `<button class="btn primary" id="drawerAdvanceDealButton">${dealPrimaryAction(deal.stage)}</button><button class="btn" id="drawerRecordDealButton">记录进展</button><button class="btn" id="drawerEditDealButton">编辑</button>`}
      ${["已报价", "样品", "谈判", "成交"].includes(deal.stage) ? `<button class="btn" id="drawerPrintDealButton">${deal.stage === "成交" ? "生成 CI" : "生成 PI"}</button>` : ""}
      ${deal.stage === "成交" && !deal.archivedAt ? `<button class="btn" id="drawerArchiveDealButton">归档成交</button>` : ""}
    </div>
    <div class="section-head" style="margin-top:16px"><div><h3>商机时间线</h3><span class="subline">阶段、报价、样品、谈判、回款与关闭记录</span></div></div>
    <div class="deal-timeline">${events.length ? events.map((event) => `
      <div class="deal-event ${["follow_up", "quote", "sample", "negotiation", "payment"].includes(event.type) ? "manual" : ""}">
        <b>${escapeHtml(dealEventLabel(event.type))}${event.fromStage && event.toStage && event.fromStage !== event.toStage ? ` · ${escapeHtml(event.fromStage)} → ${escapeHtml(event.toStage)}` : ""}</b>
        <p>${escapeHtml(event.content)}</p>
        <span>${escapeHtml(event.operatorName || "未知操作人")} · ${escapeHtml(formatDateTime(event.createdAt))}${event.nextAction ? ` · 下一步：${escapeHtml(event.nextAction)} ${escapeHtml(event.nextActionAt || "")}` : ""}</span>
      </div>`).join("") : `<div class="deal-empty">暂无时间线记录</div>`}</div>
  `;
  qs("#closeDealDrawerButton", drawer)?.addEventListener("click", closeDealDrawer);
  qs("#drawerAdvanceDealButton", drawer)?.addEventListener("click", () => openDealStageModal(deal.id));
  qs("#drawerRecordDealButton", drawer)?.addEventListener("click", () => openDealEventModal(deal.id));
  qs("#drawerEditDealButton", drawer)?.addEventListener("click", () => openDealModal(deal));
  qs("#drawerPrintDealButton", drawer)?.addEventListener("click", () => void printDealDocument(deal.id));
  qs("#drawerArchiveDealButton", drawer)?.addEventListener("click", () => void archiveDeal(deal.id));
}

function openDealEventModal(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const defaultType = deal.stage === "已报价" ? "quote" : deal.stage === "样品" ? "sample" : deal.stage === "谈判" ? "negotiation" : "follow_up";
  openModal("记录商机进展", `
    <div class="form-grid">
      <div class="form-field"><label>记录类型</label><select id="dealEventTypeInput">
        <option value="follow_up" ${defaultType === "follow_up" ? "selected" : ""}>跟进</option>
        <option value="quote" ${defaultType === "quote" ? "selected" : ""}>报价</option>
        <option value="sample" ${defaultType === "sample" ? "selected" : ""}>样品</option>
        <option value="negotiation" ${defaultType === "negotiation" ? "selected" : ""}>谈判</option>
        <option value="payment">回款节点（销售记录）</option>
      </select></div>
      <div class="form-field"><label>下一动作日期</label><input id="dealEventNextActionAtInput" type="date" value="${escapeHtml(deal.nextActionAt || defaultFutureDate(2))}"></div>
      <div class="form-field full"><label>本次进展</label><textarea id="dealEventContentInput" rows="4" placeholder="记录客户反馈、报价结果、样品状态或谈判结论"></textarea></div>
      <div class="form-field full"><label>下一步动作</label><input id="dealEventNextActionInput" value="${escapeHtml(deal.nextAction)}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveDealEventButton">保存进展</button>`);
  qs("#saveDealEventButton")?.addEventListener("click", () => void saveDealEvent(id));
}

async function saveDealEvent(id: string) {
  const type = qs<HTMLSelectElement>("#dealEventTypeInput")?.value || "follow_up";
  const content = qs<HTMLTextAreaElement>("#dealEventContentInput")?.value.trim() || "";
  const nextAction = qs<HTMLInputElement>("#dealEventNextActionInput")?.value.trim() || "";
  const nextActionAt = qs<HTMLInputElement>("#dealEventNextActionAtInput")?.value || "";
  if (!content || !nextAction || !nextActionAt) {
    toast("请填写本次进展、下一动作和日期", "error");
    return;
  }
  await api(`/api/deals/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type, content, nextAction, nextActionAt })
  });
  closeModal();
  await refreshDealsData();
  toast("商机进展已记录");
}

function openDealModal(editing?: Deal) {
  const defaultCustomer = editing?.customerId ? state.customers.find((item) => item.id === editing.customerId) : undefined;
  const title = editing?.title || "";
  const storedQuantity = Number(editing?.quantity || 0);
  const storedUnitPrice = Number(editing?.unitPrice || 0);
  const quantity = editing && !storedQuantity && !storedUnitPrice && editing.amount ? 1 : storedQuantity;
  const unitPrice = editing && !storedQuantity && !storedUnitPrice && editing.amount ? Number(editing.amount) : storedUnitPrice;
  const computedAmount = editing ? Number(editing.amount || quantity * unitPrice) : 18000;
  openModal(editing ? "编辑商机" : "新增商机", `
    <div class="form-grid">
      <input id="dealIdInput" type="hidden" value="${escapeHtml(editing?.id || "")}">
      <div class="form-field full"><label>商机名称</label><input id="dealTitleInput" value="${escapeHtml(title)}" placeholder="例如：Nordic Tools 年度压力仪表采购"></div>
      <div class="form-field deal-customer-field">
        <label>关联客户（必选）</label>
        <input id="dealCustomerInput" value="${escapeHtml(defaultCustomer?.company || "")}" placeholder="输入客户名称并从列表选择" autocomplete="off">
        <input id="dealCustomerIdInput" type="hidden" value="${escapeHtml(defaultCustomer?.id || "")}">
        <button class="deal-customer-clear" id="clearDealCustomerButton" type="button" title="清空关联客户">×</button>
        <div class="deal-customer-options" id="dealCustomerOptions"></div>
      </div>
      <div class="form-field"><label>币种</label><select id="dealCurrencyInput">${["USD", "EUR", "GBP", "CNY", "JPY", "AED"].map((currency) => `<option ${currency === (editing?.currency || "USD") ? "selected" : ""}>${currency}</option>`).join("")}</select></div>
      <div class="form-field full"><label>产品 / 采购需求（必填）</label><input id="dealProductInput" value="${escapeHtml(editing?.product || "")}" placeholder="例如：压力变送器 PT-2088 / 60 件"></div>
      <div class="form-field"><label>数量</label><input id="dealQuantityInput" type="number" min="0" step="1" value="${quantity || 30}"></div>
      <div class="form-field"><label>单价</label><input id="dealUnitPriceInput" type="number" min="0" step="0.01" value="${unitPrice || 600}"></div>
      <div class="form-field"><label>金额</label><input id="dealAmountInput" type="number" value="${computedAmount}" readonly></div>
      <div class="form-field"><label>下一动作日期</label><input id="dealNextActionAtInput" type="date" value="${escapeHtml(editing?.nextActionAt || defaultFutureDate(2))}"></div>
      <div class="form-field"><label>预计成交日期</label><input id="dealExpectedCloseAtInput" type="date" value="${escapeHtml(editing?.expectedCloseAt || defaultFutureDate(21))}"></div>
      <div class="form-field full"><label>下一步动作</label><input id="dealNextActionInput" value="${escapeHtml(editing?.nextAction || "确认采购清单并安排报价")}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveDealButton">${editing ? "保存修改" : "保存商机"}</button>`);
  bindDealCustomerPicker();
  bindDealAmountCalculator();
  qs("#saveDealButton")?.addEventListener("click", () => void saveDeal());
}

function bindDealAmountCalculator() {
  const quantity = qs<HTMLInputElement>("#dealQuantityInput");
  const unitPrice = qs<HTMLInputElement>("#dealUnitPriceInput");
  const amount = qs<HTMLInputElement>("#dealAmountInput");
  const update = () => {
    if (!amount) return;
    const next = Number(quantity?.value || 0) * Number(unitPrice?.value || 0);
    amount.value = String(Math.round(next * 100) / 100);
  };
  quantity?.addEventListener("input", update);
  unitPrice?.addEventListener("input", update);
  update();
}

function filteredDealCustomers(keyword: string) {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return state.customers.slice(0, 8);
  return state.customers
    .filter((customer) => `${customer.company} ${customer.contact} ${customer.country}`.toLowerCase().includes(normalized))
    .slice(0, 8);
}

function renderDealCustomerOptions(keyword = "") {
  const box = qs<HTMLElement>("#dealCustomerOptions");
  if (!box) return;
  const customers = filteredDealCustomers(keyword);
  box.innerHTML = customers.length ? customers.map((customer) => `
    <button type="button" data-deal-customer-id="${escapeHtml(customer.id)}">
      <b>${escapeHtml(customer.company)}</b>
      <span>${escapeHtml(customer.contact || "待维护")} · ${escapeHtml(customer.country || "未知国家")}</span>
    </button>
  `).join("") : `<div class="deal-customer-empty">没有匹配客户，请先到客户管理创建客户</div>`;
  qsa<HTMLButtonElement>("[data-deal-customer-id]", box).forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const customer = state.customers.find((item) => item.id === button.dataset.dealCustomerId);
      if (!customer) return;
      const input = qs<HTMLInputElement>("#dealCustomerInput");
      const idInput = qs<HTMLInputElement>("#dealCustomerIdInput");
      if (input) input.value = customer.company;
      if (idInput) idInput.value = customer.id;
      box.classList.remove("active");
    });
  });
}

function bindDealCustomerPicker() {
  const input = qs<HTMLInputElement>("#dealCustomerInput");
  const idInput = qs<HTMLInputElement>("#dealCustomerIdInput");
  const box = qs<HTMLElement>("#dealCustomerOptions");
  const clear = qs<HTMLButtonElement>("#clearDealCustomerButton");
  if (!input || !idInput || !box) return;
  renderDealCustomerOptions(input.value);
  input.addEventListener("focus", () => {
    renderDealCustomerOptions(input.value);
    box.classList.add("active");
  });
  input.addEventListener("input", () => {
    const exact = state.customers.find((customer) => customer.company.toLowerCase() === input.value.trim().toLowerCase());
    idInput.value = exact?.id || "";
    renderDealCustomerOptions(input.value);
    box.classList.add("active");
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const first = qs<HTMLButtonElement>("[data-deal-customer-id]", box);
      if (first && box.classList.contains("active")) {
        event.preventDefault();
        first.click();
      }
    }
    if (event.key === "Escape") box.classList.remove("active");
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => box.classList.remove("active"), 120);
  });
  clear?.addEventListener("click", () => {
    input.value = "";
    idInput.value = "";
    renderDealCustomerOptions("");
    box.classList.remove("active");
    input.focus();
  });
}

async function saveDeal() {
  const dealId = qs<HTMLInputElement>("#dealIdInput")?.value.trim() || "";
  const title = qs<HTMLInputElement>("#dealTitleInput")?.value.trim() || "";
  const product = qs<HTMLInputElement>("#dealProductInput")?.value.trim() || "";
  const customerText = qs<HTMLInputElement>("#dealCustomerInput")?.value.trim() || "";
  const customerId = qs<HTMLInputElement>("#dealCustomerIdInput")?.value.trim() || "";
  if (!title) {
    toast("请填写商机名称", "error");
    return;
  }
  if (!product) {
    toast("请填写产品或采购需求", "error");
    return;
  }
  if (!customerText || !customerId) {
    toast("请从下拉列表选择关联客户", "error");
    return;
  }
  const nextAction = qs<HTMLInputElement>("#dealNextActionInput")?.value.trim() || "";
  const nextActionAt = qs<HTMLInputElement>("#dealNextActionAtInput")?.value || "";
  if (!nextAction || !nextActionAt) {
    toast("请填写下一动作和日期", "error");
    return;
  }
  const quantity = Number(qs<HTMLInputElement>("#dealQuantityInput")?.value || 0);
  const unitPrice = Number(qs<HTMLInputElement>("#dealUnitPriceInput")?.value || 0);
  const result = await api<{ deal: Deal }>(dealId ? `/api/deals/${dealId}` : "/api/deals", {
    method: dealId ? "PATCH" : "POST",
    body: JSON.stringify({
      title,
      customerId,
      product,
      quantity,
      unitPrice,
      amount: Math.round(quantity * unitPrice * 100) / 100,
      currency: qs<HTMLSelectElement>("#dealCurrencyInput")?.value || "USD",
      nextAction,
      nextActionAt,
      expectedCloseAt: qs<HTMLInputElement>("#dealExpectedCloseAtInput")?.value || ""
    })
  });
  closeModal();
  await refreshDealsData();
  void refreshDashboardOnly();
  toast(dealId ? "商机已更新" : "商机已新增");
}

function commissionStatusLabel(status: string) {
  const map: Record<string, string> = { draft: "待确认", confirmed: "已确认", reviewed: "已复核", locked: "已锁定", pending: "待计算", calculated: "已计算" };
  return map[status] || status;
}

function commissionStatusTone(status: string) {
  if (status === "locked" || status === "reviewed" || status === "confirmed" || status === "calculated") return "green";
  if (status === "draft" || status === "pending") return "amber";
  return "gray";
}

function commissionRuleLabel(rule?: CommissionRule) {
  if (!rule) return "未配置";
  if (rule.ruleType === "rate") return `销售额 ${(rule.rate * 100).toFixed(2)}%`;
  if (rule.ruleType === "fixed") return `固定 ${currencyAmount(rule.fixedAmount)} / 件`;
  if (rule.ruleType === "gross_profit") return `毛利 ${(rule.grossProfitRate * 100).toFixed(2)}%`;
  if (rule.ruleType === "tier") return "阶梯计提";
  return "不计提";
}

function commissionExchangeSourceLabel(source?: string) {
  if (source === "finance") return "财务汇率";
  if (source === "manual") return "手工汇率";
  return "待核汇率";
}

function findCommissionProductForRecord(record: MonthlySalesRecord) {
  const normalized = record.productName.trim().toLowerCase();
  return state.commissionProducts.find((product) => product.id === record.productId)
    || state.commissionProducts.find((product) => product.status === "active" && (
      product.name.toLowerCase() === normalized ||
      product.model.toLowerCase() === normalized ||
      normalized.includes(product.name.toLowerCase()) ||
      (product.model && normalized.includes(product.model.toLowerCase()))
    ));
}

function activeRuleForProduct(productId = "") {
  return state.commissionRules
    .filter((rule) => rule.productId === productId && rule.enabled)
    .filter((rule) => (!rule.effectiveFrom || rule.effectiveFrom <= state.commissionMonth) && (!rule.effectiveTo || rule.effectiveTo >= state.commissionMonth))
    .sort((left, right) => (right.effectiveFrom || "").localeCompare(left.effectiveFrom || "") || right.createdAt.localeCompare(left.createdAt))[0];
}

function estimateCommissionForRecord(record: MonthlySalesRecord) {
  const product = findCommissionProductForRecord(record);
  const rule = activeRuleForProduct(product?.id || record.productId);
  const sales = Number(record.settlementAmount || record.salesAmount || 0);
  if (!rule || rule.ruleType === "none") return 0;
  if (rule.ruleType === "rate") return sales * Number(rule.rate || 0);
  if (rule.ruleType === "fixed") return Number(record.quantity || 1) * Number(rule.fixedAmount || 0);
  if (rule.ruleType === "gross_profit") {
    const cost = Number(product?.costPrice || 0) * Number(record.quantity || 0);
    return Math.max(0, sales - cost) * Number(rule.grossProfitRate || 0);
  }
  if (rule.ruleType === "tier") {
    try {
      const tiers = JSON.parse(rule.tierJson || "[]") as Array<{ from?: number; to?: number; rate?: number }>;
      const matched = tiers.find((tier) => sales >= Number(tier.from || 0) && sales < Number(tier.to || Number.MAX_SAFE_INTEGER));
      return sales * Number(matched?.rate || 0);
    } catch {
      return 0;
    }
  }
  return 0;
}

async function refreshCommissionData() {
  const [products, records, calculations] = await Promise.all([
    api<{ products: CommissionProduct[]; rules: CommissionRule[]; canManage: boolean; canSelectOwner: boolean; owners: CommissionOwner[] }>("/api/commission/products"),
    api<{ records: MonthlySalesRecord[]; owners?: CommissionOwner[]; canSelectOwner?: boolean; selectedOwnerId?: string }>(`/api/commission/sales-records?month=${encodeURIComponent(state.commissionMonth)}&ownerId=${encodeURIComponent(state.selectedCommissionOwnerId || "")}`),
    api<{ calculations: CommissionCalculation[]; items: CommissionItem[]; canReview: boolean; canSelectOwner?: boolean; owners?: CommissionOwner[]; selectedOwnerId?: string }>(`/api/commission/calculations?month=${encodeURIComponent(state.commissionMonth)}&ownerId=${encodeURIComponent(state.selectedCommissionOwnerId || "")}`)
  ]);
  state.commissionProducts = products.products;
  state.commissionRules = products.rules;
  state.commissionCanManage = products.canManage;
  state.commissionCanSelectOwner = products.canSelectOwner;
  state.commissionOwners = products.owners || records.owners || calculations.owners || [];
  state.selectedCommissionOwnerId = state.commissionCanSelectOwner
    ? (records.selectedOwnerId || calculations.selectedOwnerId || state.selectedCommissionOwnerId || "all")
    : (state.user?.id || "");
  state.commissionRecords = records.records;
  state.commissionCalculations = calculations.calculations;
  state.commissionItems = calculations.items;
  state.commissionCanReview = calculations.canReview;
  renderCommission();
}

function renderCommission() {
  const root = qs<HTMLElement>("#commission");
  if (!root) return;
  const monthInput = qs<HTMLInputElement>("#commissionMonthInput");
  if (monthInput) {
    monthInput.value = state.commissionMonth;
    monthInput.onchange = () => {
      state.commissionMonth = monthInput.value || new Date().toISOString().slice(0, 7);
      void refreshCommissionData();
    };
  }
  renderCommissionOwnerSelector();
  const syncButton = qs<HTMLButtonElement>("#commissionSyncDealsButton");
  const addRecordButton = qs<HTMLButtonElement>("#commissionAddRecordButton");
  const productButton = qs<HTMLButtonElement>("#commissionProductButton");
  const recalculateButton = qs<HTMLButtonElement>("#commissionRecalculateButton");
  const exportButton = qs<HTMLButtonElement>("#commissionExportButton");
  const manualButton = qs<HTMLButtonElement>("#commissionAddManualItemButton");
  if (syncButton) syncButton.onclick = () => void syncCommissionDeals();
  if (addRecordButton) addRecordButton.onclick = () => openCommissionRecordModal();
  if (productButton) productButton.onclick = () => openCommissionProductModal();
  if (recalculateButton) recalculateButton.onclick = () => void recalculateCommission();
  if (exportButton) exportButton.onclick = () => void exportCommission();
  if (manualButton) manualButton.onclick = () => openCommissionManualItemModal();
  if (manualButton) {
    manualButton.disabled = !state.commissionCanReview;
    manualButton.title = state.commissionCanReview ? "新增奖金、扣减、补贴等调整项" : "只有管理员和超级管理员可以调整提成金额";
  }
  qsa<HTMLButtonElement>("[data-commission-filter]", root).forEach((button) => {
    button.classList.toggle("active", button.dataset.commissionFilter === state.commissionFilter);
    button.onclick = () => {
      state.commissionFilter = (button.dataset.commissionFilter as AppState["commissionFilter"]) || "all";
      renderCommission();
    };
  });
  renderCommissionKpis();
  renderCommissionRecords();
  renderCommissionCalculations();
  renderCommissionRules();
}

function renderCommissionOwnerSelector() {
  const select = qs<HTMLSelectElement>("#commissionOwnerInput");
  if (!select) return;
  if (!state.commissionCanSelectOwner) {
    select.innerHTML = `<option value="${escapeHtml(state.user?.id || "")}">${escapeHtml(state.user?.name || "本人")} · 仅本人</option>`;
    select.disabled = true;
    return;
  }
  const owners = state.commissionOwners.length ? state.commissionOwners : [];
  select.disabled = false;
  select.innerHTML = `<option value="all">全部人员</option>${owners.map((owner) => `<option value="${escapeHtml(owner.id)}">${escapeHtml(owner.name)} · ${escapeHtml(roleLabel[owner.role] || owner.role)}</option>`).join("")}`;
  select.value = state.selectedCommissionOwnerId || "all";
  select.onchange = () => {
    state.selectedCommissionOwnerId = select.value || "all";
    state.selectedCommissionCalculationId = null;
    void refreshCommissionData();
  };
}

function renderCommissionKpis() {
  const box = qs<HTMLElement>("#commissionKpis");
  if (!box) return;
  const confirmedRecords = state.commissionRecords.filter((item) => item.status !== "draft");
  const totalSales = confirmedRecords.reduce((sum, item) => sum + Number(item.settlementAmount || 0), 0);
  const calculatedCommission = state.commissionCalculations.reduce((sum, item) => sum + Number(item.finalCommission || 0), 0);
  const estimatedCommission = confirmedRecords.reduce((sum, item) => sum + estimateCommissionForRecord(item), 0);
  const finalCommission = calculatedCommission || estimatedCommission;
  const pendingRate = state.commissionRecords.filter((item) => item.currency !== "CNY" && ((item.exchangeRateSource || "pending") === "pending" || !item.exchangeRateDate)).length;
  const unmatched = confirmedRecords.filter((item) => !activeRuleForProduct(findCommissionProductForRecord(item)?.id || item.productId)).length;
  box.innerHTML = [
    ["可计提基数 · CNY", currencyAmount(totalSales)],
    [calculatedCommission ? "当前提成 · CNY" : "试算提成 · CNY", currencyAmount(finalCommission)],
    ["待确认记录", `${state.commissionRecords.filter((item) => item.status === "draft").length} 条`],
    ["数据异常", `${pendingRate + unmatched} 条`]
  ].map(([label, value]) => `<div class="commission-kpi"><span>${label}</span><b>${value}</b></div>`).join("");
}

function commissionRecordMissingFields(record: MonthlySalesRecord) {
  const fields: string[] = [];
  if (!record.basisDate) fields.push("计提日期");
  if (record.currency !== "CNY" && !record.exchangeRateDate) fields.push("汇率日期");
  if (record.currency !== "CNY" && record.exchangeRateSource === "pending") fields.push("汇率来源");
  return fields;
}

function commissionRecordCalculationLocked(record: MonthlySalesRecord) {
  return state.commissionCalculations.some((calculation) =>
    calculation.isCurrent !== false
    && calculation.month === record.month
    && calculation.ownerId === record.ownerId
    && calculation.status === "locked"
  );
}

function commissionAmountForRecord(record: MonthlySalesRecord) {
  const items = state.commissionItems.filter((item) => item.recordId === record.id);
  if (items.length) {
    return {
      amount: items.reduce((sum, item) => sum + Number(item.finalAmount || 0), 0),
      label: items.some((item) => item.sourceType === "manual") ? "已计算 · 含调整" : "已计算"
    };
  }
  const product = findCommissionProductForRecord(record);
  const rule = activeRuleForProduct(product?.id || record.productId);
  return {
    amount: estimateCommissionForRecord(record),
    label: rule && rule.ruleType !== "none"
      ? (record.status === "draft" ? "试算 · 待确认" : "试算 · 待计算")
      : "未匹配规则"
  };
}

function commissionRecordActions(record: MonthlySalesRecord) {
  if (record.status !== "draft") {
    return `<button class="btn" data-view-commission-detail>查看明细</button>`;
  }
  if (commissionRecordCalculationLocked(record)) {
    return `<button class="btn" data-view-commission-detail>查看明细</button><button class="btn" disabled title="请先解锁右侧提成单">本月已锁定</button>`;
  }
  const missingFields = commissionRecordMissingFields(record);
  if (missingFields.length) {
    return `<button class="btn" data-view-commission-detail>查看明细</button><button class="btn primary" data-complete-commission-record title="缺少：${escapeHtml(missingFields.join("、"))}">补齐资料</button>`;
  }
  return `<button class="btn" data-view-commission-detail>查看明细</button><button class="btn" data-edit-commission-record>编辑</button><button class="btn primary" data-confirm-commission-record>确认</button>`;
}

function renderCommissionRecords() {
  const tbody = qs<HTMLElement>("#commissionRecordRows");
  const cardList = qs<HTMLElement>("#commissionRecordCards");
  if (!tbody || !cardList) return;
  const rows = state.commissionRecords
    .filter((record) => state.commissionFilter === "all" || record.status === state.commissionFilter)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  tbody.innerHTML = rows.length ? rows.map((record) => {
    const commission = commissionAmountForRecord(record);
    return `
    <tr data-commission-record-id="${escapeHtml(record.id)}">
      <td><div class="commission-title-cell"><b>${escapeHtml(record.customerName)}</b><span>${escapeHtml(record.productName)} · ${Number(record.quantity || 0).toLocaleString("en-US")} × ${currencyAmount(record.unitPrice, record.currency)}${record.edited ? " · 已编辑" : ""}</span></div></td>
      <td><div class="commission-money-cell"><b>${currencyAmount(record.salesAmount, record.currency)}</b><span>汇率 ${Number(record.exchangeRate || 0).toLocaleString("en-US")} · ${commissionExchangeSourceLabel(record.exchangeRateSource)}</span></div></td>
      <td><div class="commission-money-cell"><b>${currencyAmount(record.settlementAmount, "CNY")}</b><span>${record.basisType === "receipt" ? "实际回款" : "成交金额待核对"} · ${escapeHtml(record.basisDate || "未填日期")}</span></div></td>
      <td><div class="commission-money-cell"><b>${currencyAmount(commission.amount, "CNY")}</b><span>${escapeHtml(commission.label)}</span></div></td>
      <td><div class="commission-status-stack">${badge(commissionStatusLabel(record.status), commissionStatusTone(record.status))}${badge(record.sourceType === "deal" ? "归档商机" : record.sourceType === "manual" ? "手工录入" : "人工修正", record.sourceType === "adjusted" ? "amber" : "gray")}</div></td>
      <td><div class="commission-row-actions">${commissionRecordActions(record)}</div></td>
    </tr>
  `;
  }).join("") : `<tr><td colspan="6" class="empty-cell">暂无销售记录。可以先同步本月已归档成交商机，或手工新增一条计提记录。</td></tr>`;
  cardList.innerHTML = rows.length ? rows.map((record) => {
    const commission = commissionAmountForRecord(record);
    return `
    <article class="commission-record-card" data-commission-record-id="${escapeHtml(record.id)}">
      <div class="commission-record-card-head"><div><b>${escapeHtml(record.customerName)}</b><span>${escapeHtml(record.productName)}</span></div>${badge(commissionStatusLabel(record.status), commissionStatusTone(record.status))}</div>
      <div class="commission-record-card-money"><span>原币金额<strong>${currencyAmount(record.salesAmount, record.currency)}</strong></span><span>结算金额<strong>${currencyAmount(record.settlementAmount, "CNY")}</strong></span><span class="commission-record-card-commission">提成额 · ${escapeHtml(commission.label)}<strong>${currencyAmount(commission.amount, "CNY")}</strong></span></div>
      <p>${record.basisType === "receipt" ? "实际回款" : "成交金额待核对"} · ${escapeHtml(record.basisDate || "未填日期")} · ${commissionExchangeSourceLabel(record.exchangeRateSource)}${record.exchangeRateSource !== "pending" ? ` · ${Number(record.exchangeRate || 0).toLocaleString("en-US")}` : ""}</p>
      <div class="commission-row-actions">${commissionRecordActions(record)}</div>
    </article>
  `;
  }).join("") : `<div class="commission-empty">暂无销售记录。</div>`;
  const actionRoot = qs<HTMLElement>("#commission") || document.body;
  qsa<HTMLButtonElement>("[data-edit-commission-record]", actionRoot).forEach((button) => {
    button.addEventListener("click", () => {
      const record = state.commissionRecords.find((item) => item.id === button.closest<HTMLElement>("[data-commission-record-id]")?.dataset.commissionRecordId);
      if (record) openCommissionRecordModal(record);
    });
  });
  qsa<HTMLButtonElement>("[data-complete-commission-record]", actionRoot).forEach((button) => {
    button.addEventListener("click", () => {
      const record = state.commissionRecords.find((item) => item.id === button.closest<HTMLElement>("[data-commission-record-id]")?.dataset.commissionRecordId);
      if (!record) {
        toast("未找到这条计提记录，请刷新后重试", "error");
        return;
      }
      const missingFields = commissionRecordMissingFields(record);
      toast(`请补齐：${missingFields.join("、")}`, "error");
      openCommissionRecordModal(record);
    });
  });
  qsa<HTMLButtonElement>("[data-confirm-commission-record]", actionRoot).forEach((button) => {
    button.addEventListener("click", () => void confirmCommissionRecord(
      button.closest<HTMLElement>("[data-commission-record-id]")?.dataset.commissionRecordId || "",
      button
    ));
  });
  qsa<HTMLButtonElement>("[data-view-commission-detail]", actionRoot).forEach((button) => {
    button.addEventListener("click", () => void openCommissionRecordDetailModal(button.closest<HTMLElement>("[data-commission-record-id]")?.dataset.commissionRecordId || ""));
  });
}

function renderCommissionCalculations() {
  const box = qs<HTMLElement>("#commissionCalculationRows");
  if (!box) return;
  box.innerHTML = state.commissionCalculations.length ? state.commissionCalculations.map((calculation) => {
    const owner = state.commissionOwners.find((item) => item.id === calculation.ownerId)?.name || (calculation.ownerId === state.user?.id ? state.user.name : calculation.ownerId);
    return `<article class="commission-calc-row" data-commission-calculation-id="${escapeHtml(calculation.id)}">
      <div class="commission-calc-top"><b>${escapeHtml(owner)} · ${escapeHtml(calculation.month)} · V${calculation.version || 1}</b>${badge(commissionStatusLabel(calculation.status), commissionStatusTone(calculation.status))}</div>
      <div class="commission-calc-metrics"><span>计提基数<strong>${currencyAmount(calculation.salesAmount)}</strong></span><span>自动提成<strong>${currencyAmount(calculation.autoCommission)}</strong></span><span>最终提成<strong>${currencyAmount(calculation.finalCommission)}</strong></span></div>
      <div class="commission-row-actions">
        <button class="btn" data-view-commission-calc>查看明细</button>
        ${state.commissionCanReview && calculation.status === "calculated" ? `<button class="btn" data-select-commission-calc>提成调整</button><button class="btn primary" data-review-commission-calc>复核</button>` : ""}
        ${state.commissionCanReview && calculation.status === "reviewed" ? `<button class="btn primary" data-lock-commission-calc>锁定</button>` : ""}
        ${state.commissionCanReview && calculation.status === "locked" ? `<button class="btn" data-unlock-commission-calc>解锁修正</button>` : ""}
      </div>
    </article>`;
  }).join("") : `<div class="commission-empty">暂无计算结果。先确认销售记录，再点击“重新计算”。</div>`;
  qsa<HTMLButtonElement>("[data-select-commission-calc]", box).forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCommissionCalculationId = button.closest<HTMLElement>(".commission-calc-row")?.dataset.commissionCalculationId || null;
      openCommissionManualItemModal();
    });
  });
  qsa<HTMLButtonElement>("[data-view-commission-calc]", box).forEach((button) => {
    button.addEventListener("click", () => openCommissionCalculationDetailModal(button.closest<HTMLElement>(".commission-calc-row")?.dataset.commissionCalculationId || ""));
  });
  qsa<HTMLButtonElement>("[data-review-commission-calc]", box).forEach((button) => {
    button.addEventListener("click", () => void reviewCommissionCalculation(button.closest<HTMLElement>(".commission-calc-row")?.dataset.commissionCalculationId || ""));
  });
  qsa<HTMLButtonElement>("[data-lock-commission-calc]", box).forEach((button) => {
    button.addEventListener("click", () => void lockCommissionCalculation(button.closest<HTMLElement>(".commission-calc-row")?.dataset.commissionCalculationId || ""));
  });
  qsa<HTMLButtonElement>("[data-unlock-commission-calc]", box).forEach((button) => {
    button.addEventListener("click", () => openCommissionUnlockModal(button.closest<HTMLElement>(".commission-calc-row")?.dataset.commissionCalculationId || ""));
  });
}

function renderCommissionRules() {
  const box = qs<HTMLElement>("#commissionRuleRows");
  if (!box) return;
  box.innerHTML = state.commissionProducts.length ? state.commissionProducts.map((product) => {
    const productRules = state.commissionRules
      .filter((item) => item.productId === product.id)
      .sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.createdAt.localeCompare(left.createdAt));
    const rule = productRules.find((item) => item.enabled) || productRules[0];
    return `<article class="commission-rule-row">
      <div class="commission-rule-top"><b>${escapeHtml(product.name)}</b>${badge(product.status === "active" ? "产品启用" : "产品停用", product.status === "active" ? "green" : "gray")}</div>
      <p>${escapeHtml(product.category || "未分类")} · ${escapeHtml(product.model || "无型号")} · 成本 ${currencyAmount(product.costPrice, product.currency)} · ${rule ? commissionRuleLabel(rule) : "未配置规则"}${rule && !rule.enabled ? " · 规则停用" : ""}</p>
      ${state.commissionCanManage ? `<div class="commission-row-actions">
        <button class="btn" data-edit-commission-product="${escapeHtml(product.id)}">编辑产品</button>
        <button class="btn" data-edit-commission-rule="${escapeHtml(product.id)}">${rule ? "编辑规则" : "新增规则"}</button>
        ${rule ? `<button class="btn" data-toggle-commission-rule="${escapeHtml(rule.id)}">${rule.enabled ? "停用规则" : "启用规则"}</button>` : ""}
      </div>` : ""}
    </article>`;
  }).join("") : `<div class="commission-empty">暂无产品规则。管理员可点击“产品维护”新增。</div>`;
  qsa<HTMLButtonElement>("[data-edit-commission-product]", box).forEach((button) => {
    button.addEventListener("click", () => {
      const product = state.commissionProducts.find((item) => item.id === button.dataset.editCommissionProduct);
      if (product) openCommissionProductModal(product);
    });
  });
  qsa<HTMLButtonElement>("[data-edit-commission-rule]", box).forEach((button) => {
    button.addEventListener("click", () => {
      const product = state.commissionProducts.find((item) => item.id === button.dataset.editCommissionRule);
      if (!product) return;
      const rule = state.commissionRules
        .filter((item) => item.productId === product.id)
        .sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.createdAt.localeCompare(left.createdAt))[0];
      openCommissionRuleModal(product, rule);
    });
  });
  qsa<HTMLButtonElement>("[data-toggle-commission-rule]", box).forEach((button) => {
    button.addEventListener("click", () => void toggleCommissionRule(button.dataset.toggleCommissionRule || ""));
  });
}

async function syncCommissionDeals() {
  const button = qs<HTMLButtonElement>("#commissionSyncDealsButton");
  if (button) button.disabled = true;
  try {
    const result = await api<{ created: MonthlySalesRecord[]; records: MonthlySalesRecord[] }>("/api/commission/sales-records/sync-from-deals", {
      method: "POST",
      body: JSON.stringify({ month: state.commissionMonth, ownerId: state.selectedCommissionOwnerId })
    });
    state.commissionRecords = result.records;
    renderCommission();
    toast(result.created.length ? `已同步 ${result.created.length} 条归档成交` : "本月暂无可同步的新归档成交");
  } finally {
    if (button) button.disabled = false;
  }
}

function openCommissionRecordModal(record?: MonthlySalesRecord) {
  if (!record && state.commissionCanSelectOwner && (!state.selectedCommissionOwnerId || state.selectedCommissionOwnerId === "all")) {
    toast("请先在查看人员中选择具体业务员，再新增销售记录", "error");
    return;
  }
  const products = state.commissionProducts.filter((item) => item.status === "active");
  openModal(record ? "编辑售卖记录" : "新增售卖记录", `
    <div class="form-grid">
      <div class="form-field"><label>月份</label><input id="commissionRecordMonthInput" type="month" value="${escapeHtml(record?.month || state.commissionMonth)}"></div>
      <div class="form-field"><label>客户</label><input id="commissionRecordCustomerInput" value="${escapeHtml(record?.customerName || "")}" placeholder="客户公司"></div>
      <div class="form-field full"><label>产品</label><select id="commissionRecordProductInput"><option value="">手工填写产品</option>${products.map((product) => `<option value="${escapeHtml(product.id)}" ${product.id === record?.productId ? "selected" : ""}>${escapeHtml(product.name)}</option>`).join("")}</select></div>
      <div class="form-field full"><label>产品名称</label><input id="commissionRecordProductNameInput" value="${escapeHtml(record?.productName || products[0]?.name || "")}"></div>
      <div class="form-field"><label>数量</label><input id="commissionRecordQuantityInput" type="number" step="1" min="0" value="${record?.quantity ?? 1}"></div>
      <div class="form-field"><label>单价</label><input id="commissionRecordUnitPriceInput" type="number" step="0.01" min="0" value="${record?.unitPrice ?? products[0]?.defaultPrice ?? 0}"></div>
      <div class="form-field"><label>原币币种</label><select id="commissionRecordCurrencyInput">${["USD", "EUR", "CNY", "GBP"].map((currency) => `<option ${currency === (record?.currency || "USD") ? "selected" : ""}>${currency}</option>`).join("")}</select></div>
      <div class="form-field"><label>计提依据</label><select id="commissionRecordBasisTypeInput"><option value="receipt" ${record?.basisType !== "deal_amount" ? "selected" : ""}>实际回款</option><option value="deal_amount" ${record?.basisType === "deal_amount" ? "selected" : ""}>成交金额待核对</option></select></div>
      <div class="form-field"><label>依据日期</label><input id="commissionRecordBasisDateInput" type="date" value="${escapeHtml(record?.basisDate || "")}"></div>
      <div class="form-field"><label>兑 CNY 汇率</label><input id="commissionRecordExchangeInput" type="number" step="0.0001" min="0" value="${record?.exchangeRate ?? 1}"></div>
      <div class="form-field"><label>汇率日期</label><input id="commissionRecordExchangeDateInput" type="date" value="${escapeHtml(record?.exchangeRateDate || "")}"></div>
      <div class="form-field"><label>汇率来源</label><select id="commissionRecordExchangeSourceInput"><option value="pending" ${record?.exchangeRateSource === "pending" ? "selected" : ""}>待核对</option><option value="manual" ${record?.exchangeRateSource === "manual" ? "selected" : ""}>手工录入</option><option value="finance" ${record?.exchangeRateSource === "finance" ? "selected" : ""}>财务确认</option></select></div>
      <div class="form-field"><label>状态</label><select id="commissionRecordStatusInput"><option value="draft" ${record?.status === "draft" ? "selected" : ""}>待确认</option><option value="confirmed" ${record?.status === "confirmed" ? "selected" : ""}>已确认</option></select></div>
      ${record ? `<div class="form-field full"><label>修改原因</label><input id="commissionRecordEditNoteInput" placeholder="必须填写，例如：实际结算数量调整" value="${escapeHtml(record.editNote || "")}"></div>` : ""}
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCommissionRecordButton">保存</button>`);
  qs<HTMLSelectElement>("#commissionRecordProductInput")?.addEventListener("change", (event) => {
    const product = state.commissionProducts.find((item) => item.id === (event.currentTarget as HTMLSelectElement).value);
    if (!product) return;
    const name = qs<HTMLInputElement>("#commissionRecordProductNameInput");
    const price = qs<HTMLInputElement>("#commissionRecordUnitPriceInput");
    if (name) name.value = product.name;
    if (price && !Number(price.value)) price.value = String(product.defaultPrice || 0);
  });
  qs("#saveCommissionRecordButton")?.addEventListener("click", () => void saveCommissionRecord(record?.id || ""));
}

async function saveCommissionRecord(id = "") {
  const button = qs<HTMLButtonElement>("#saveCommissionRecordButton");
  const productId = qs<HTMLSelectElement>("#commissionRecordProductInput")?.value || "";
  const quantity = Number(qs<HTMLInputElement>("#commissionRecordQuantityInput")?.value || 0);
  const unitPrice = Number(qs<HTMLInputElement>("#commissionRecordUnitPriceInput")?.value || 0);
  const payload = {
    ownerId: id ? "" : state.selectedCommissionOwnerId,
    month: qs<HTMLInputElement>("#commissionRecordMonthInput")?.value || state.commissionMonth,
    customerName: qs<HTMLInputElement>("#commissionRecordCustomerInput")?.value.trim() || "未填写客户",
    productId,
    productName: qs<HTMLInputElement>("#commissionRecordProductNameInput")?.value.trim() || state.commissionProducts.find((item) => item.id === productId)?.name || "未填写产品",
    quantity,
    unitPrice,
    salesAmount: Math.round(quantity * unitPrice * 100) / 100,
    currency: qs<HTMLSelectElement>("#commissionRecordCurrencyInput")?.value || "USD",
    exchangeRate: Number(qs<HTMLInputElement>("#commissionRecordExchangeInput")?.value || 1),
    exchangeRateDate: qs<HTMLInputElement>("#commissionRecordExchangeDateInput")?.value || "",
    exchangeRateSource: qs<HTMLSelectElement>("#commissionRecordExchangeSourceInput")?.value || "pending",
    settlementCurrency: "CNY",
    basisType: qs<HTMLSelectElement>("#commissionRecordBasisTypeInput")?.value || "receipt",
    basisDate: qs<HTMLInputElement>("#commissionRecordBasisDateInput")?.value || "",
    status: qs<HTMLSelectElement>("#commissionRecordStatusInput")?.value || "draft",
    editNote: qs<HTMLInputElement>("#commissionRecordEditNoteInput")?.value.trim() || ""
  };
  if (id && !payload.editNote) {
    toast("编辑销售记录必须填写修改原因", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "保存中...";
  }
  try {
    const result = await api<{ record: MonthlySalesRecord }>(id ? `/api/commission/sales-records/${id}` : "/api/commission/sales-records", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    if (id) state.commissionRecords = state.commissionRecords.map((item) => item.id === id ? result.record : item);
    else state.commissionRecords.unshift(result.record);
    state.commissionMonth = result.record.month;
    closeModal();
    renderCommission();
    toast(id ? "售卖记录已更新并留痕" : "售卖记录已新增");
  } catch (error) {
    toast(error instanceof Error ? error.message : "销售记录保存失败", "error");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "保存";
    }
  }
}

async function confirmCommissionRecord(id: string, button?: HTMLButtonElement) {
  const record = state.commissionRecords.find((item) => item.id === id);
  if (!record) {
    toast("未找到这条计提记录，请刷新后重试", "error");
    return;
  }
  const originalLabel = button?.textContent || "确认";
  if (button) {
    button.disabled = true;
    button.textContent = "确认中...";
  }
  try {
    const result = await api<{ record: MonthlySalesRecord }>(`/api/commission/sales-records/${id}/confirm`, { method: "POST" });
    state.commissionRecords = state.commissionRecords.map((item) => item.id === id ? result.record : item);
    renderCommission();
    toast("销售记录已确认，可参与提成计算");
  } catch (error) {
    const message = error instanceof Error ? error.message : "销售记录确认失败";
    toast(message, "error");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

async function openCommissionAuditModal(id: string) {
  const result = await api<{ audits: SalesRecordAudit[] }>(`/api/commission/sales-records/${id}/audits`);
  openModal("销售记录编辑留痕", `
    <div class="table-wrap"><table><thead><tr><th>字段</th><th>原值</th><th>新值</th><th>原因</th><th>操作人</th></tr></thead><tbody>
      ${result.audits.map((audit) => `<tr><td>${escapeHtml(audit.fieldName)}</td><td>${escapeHtml(audit.oldValue)}</td><td>${escapeHtml(audit.newValue)}</td><td>${escapeHtml(audit.reason)}</td><td>${escapeHtml(audit.operatorName)} · ${escapeHtml(formatDateTime(audit.createdAt))}</td></tr>`).join("") || `<tr><td colspan="5" class="empty-cell">暂无留痕</td></tr>`}
    </tbody></table></div>
  `, `<button class="btn primary" data-modal-close>知道了</button>`);
}

async function openCommissionRecordDetailModal(id: string) {
  const record = state.commissionRecords.find((item) => item.id === id);
  if (!record) return;
  const items = state.commissionItems.filter((entry) => entry.recordId === record.id);
  const item = items.find((entry) => entry.sourceType === "auto") || items[0];
  const commission = commissionAmountForRecord(record);
  let snapshot: { formula?: string; reason?: string } = {};
  try {
    snapshot = JSON.parse(item?.ruleSnapshotJson || "{}") as typeof snapshot;
  } catch {
    snapshot = {};
  }
  openModal("提成记录明细", `
    <div class="commission-detail-grid">
      <div><span>客户 / 产品</span><b>${escapeHtml(record.customerName)} · ${escapeHtml(record.productName)}</b></div>
      <div><span>计提依据</span><b>${record.basisType === "receipt" ? "实际回款" : "成交金额待核对"} · ${escapeHtml(record.basisDate || "未填日期")}</b></div>
      <div><span>原币金额</span><b>${currencyAmount(record.salesAmount, record.currency)}</b></div>
      <div><span>汇率</span><b>${Number(record.exchangeRate || 0).toLocaleString("en-US")} · ${commissionExchangeSourceLabel(record.exchangeRateSource)} · ${escapeHtml(record.exchangeRateDate || "未填日期")}</b></div>
      <div><span>结算金额</span><b>${currencyAmount(record.settlementAmount, "CNY")}</b></div>
      <div><span>提成额</span><b>${currencyAmount(commission.amount, "CNY")} · ${escapeHtml(commission.label)}</b></div>
      <div class="full"><span>计算公式</span><b>${escapeHtml(snapshot.formula || item?.remark || "尚未计算")}</b></div>
      <div class="full"><span>状态与来源</span><b>${commissionStatusLabel(record.status)} · ${record.sourceType === "deal" ? "归档商机同步" : record.sourceType === "manual" ? "手工录入" : "人工修正"}</b></div>
    </div>
  `, `<button class="btn" id="commissionDetailAuditButton">${record.edited ? "查看编辑留痕" : "暂无编辑留痕"}</button><button class="btn primary" data-modal-close>关闭</button>`);
  const auditButton = qs<HTMLButtonElement>("#commissionDetailAuditButton");
  if (auditButton) {
    auditButton.disabled = !record.edited;
    auditButton.onclick = () => void openCommissionAuditModal(record.id);
  }
}

function openCommissionCalculationDetailModal(id: string) {
  const calculation = state.commissionCalculations.find((item) => item.id === id);
  if (!calculation) return;
  const items = state.commissionItems.filter((item) => item.calculationId === calculation.id);
  openModal(`提成计算明细 · V${calculation.version || 1}`, `
    <div class="commission-detail-summary">
      <span>计提基数<strong>${currencyAmount(calculation.salesAmount)}</strong></span>
      <span>自动提成<strong>${currencyAmount(calculation.autoCommission)}</strong></span>
      <span>人工调整<strong>${currencyAmount(calculation.manualAdjustment)}</strong></span>
      <span>最终提成<strong>${currencyAmount(calculation.finalCommission)}</strong></span>
    </div>
    <div class="commission-detail-list">${items.map((item) => {
      const record = state.commissionRecords.find((entry) => entry.id === item.recordId);
      let formula = item.remark;
      try {
        formula = (JSON.parse(item.ruleSnapshotJson || "{}") as { formula?: string }).formula || formula;
      } catch {
        formula = item.remark;
      }
      return `<article><div><b>${escapeHtml(record ? `${record.customerName} · ${record.productName}` : item.remark)}</b><span>${item.sourceType === "auto" ? escapeHtml(formula) : `人工调整 · ${escapeHtml(item.remark)}`}</span></div><strong>${currencyAmount(item.finalAmount)}</strong></article>`;
    }).join("") || `<div class="commission-empty">暂无计算明细。</div>`}</div>
    <p class="commission-detail-meta">状态：${commissionStatusLabel(calculation.status)} · 计算时间：${escapeHtml(calculation.calculatedAt ? formatDateTime(calculation.calculatedAt) : "尚未计算")}</p>
  `, `<button class="btn primary" data-modal-close>关闭</button>`);
}

async function reviewCommissionCalculation(id: string) {
  const result = await api<{ calculation: CommissionCalculation }>(`/api/commission/calculations/${id}/review`, { method: "POST" });
  state.commissionCalculations = state.commissionCalculations.map((item) => item.id === id ? result.calculation : item);
  await refreshCommissionData();
  toast("提成单已复核，下一步可锁定");
}

async function lockCommissionCalculation(id: string) {
  const result = await api<{ calculation: CommissionCalculation }>(`/api/commission/calculations/${id}/lock`, { method: "POST" });
  state.commissionCalculations = state.commissionCalculations.map((item) => item.id === id ? result.calculation : item);
  await refreshCommissionData();
  toast("提成单已锁定，记录和金额不可再直接修改");
}

function openCommissionUnlockModal(id: string) {
  openModal("解锁提成单", `
    <div class="form-grid"><div class="form-field full"><label>解锁原因</label><textarea id="commissionUnlockReasonInput" rows="4" placeholder="说明为什么需要修正，以及准备调整的内容"></textarea></div></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmCommissionUnlockButton">确认解锁并生成新版本</button>`);
  qs("#confirmCommissionUnlockButton")?.addEventListener("click", () => void unlockCommissionCalculation(id));
}

async function unlockCommissionCalculation(id: string) {
  const reason = qs<HTMLTextAreaElement>("#commissionUnlockReasonInput")?.value.trim() || "";
  if (reason.length < 4) {
    toast("请填写至少 4 个字的解锁原因", "error");
    return;
  }
  await api(`/api/commission/calculations/${id}/unlock`, { method: "POST", body: JSON.stringify({ reason }) });
  closeModal();
  await refreshCommissionData();
  toast("已保留锁定版本，并生成待重算的新版本");
}

async function recalculateCommission() {
  const result = await api<{ calculations: CommissionCalculation[]; items: CommissionItem[] }>("/api/commission/calculations/recalculate", {
    method: "POST",
    body: JSON.stringify({ month: state.commissionMonth, ownerId: state.selectedCommissionOwnerId })
  });
  state.commissionCalculations = result.calculations;
  state.commissionItems = result.items;
  renderCommission();
  toast("提成已按当前确认记录重新计算");
}

function openCommissionManualItemModal() {
  if (!state.commissionCanReview) {
    toast("只有管理员和超级管理员可以调整提成金额", "error");
    return;
  }
  if (!state.commissionCalculations.length) {
    toast("请先重新计算生成提成单", "error");
    return;
  }
  const selected = state.selectedCommissionCalculationId || state.commissionCalculations[0].id;
  openModal("新增提成调整项", `
    <div class="form-grid">
      <div class="form-field full"><label>提成单</label><select id="commissionManualCalcInput">${state.commissionCalculations.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.month)} · ${escapeHtml(item.ownerId)} · ${amount(item.finalCommission)}</option>`).join("")}</select></div>
      <div class="form-field full"><label>关联记录</label><select id="commissionManualRecordInput"><option value="">月度公共调整</option>${state.commissionRecords.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.customerName)} · ${escapeHtml(item.productName)}</option>`).join("")}</select></div>
      <div class="form-field"><label>类型</label><select id="commissionManualTypeInput"><option value="bonus">奖金</option><option value="deduction">扣减</option><option value="subsidy">补贴</option><option value="refund">退款扣回</option><option value="special">特殊项</option><option value="other">其它</option></select></div>
      <div class="form-field"><label>金额</label><input id="commissionManualAmountInput" type="number" step="0.01" value="0"></div>
      <div class="form-field full"><label>说明</label><input id="commissionManualRemarkInput" placeholder="例如：大客户首单专项奖励"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCommissionManualButton">保存调整</button>`);
  qs("#saveCommissionManualButton")?.addEventListener("click", () => void saveCommissionManualItem());
}

async function saveCommissionManualItem() {
  const calculationId = qs<HTMLSelectElement>("#commissionManualCalcInput")?.value || "";
  const result = await api<{ calculation: CommissionCalculation; item: CommissionItem }>(`/api/commission/calculations/${calculationId}/manual-item`, {
    method: "POST",
    body: JSON.stringify({
      itemType: qs<HTMLSelectElement>("#commissionManualTypeInput")?.value || "other",
      manualAmount: Number(qs<HTMLInputElement>("#commissionManualAmountInput")?.value || 0),
      recordId: qs<HTMLSelectElement>("#commissionManualRecordInput")?.value || "",
      remark: qs<HTMLInputElement>("#commissionManualRemarkInput")?.value.trim() || ""
    })
  });
  state.commissionCalculations = state.commissionCalculations.map((item) => item.id === result.calculation.id ? result.calculation : item);
  state.commissionItems.unshift(result.item);
  closeModal();
  renderCommission();
  toast("提成调整项已保存");
}

function openCommissionProductModal(editing?: CommissionProduct) {
  if (!state.commissionCanManage) {
    toast("当前账号只能查看产品规则，维护需管理员权限", "error");
    return;
  }
  openModal(editing ? "编辑提成产品" : "新增提成产品", `
    <div class="form-grid">
      <div class="form-field full"><label>产品名称</label><input id="commissionProductNameInput" value="${escapeHtml(editing?.name || "")}" placeholder="例如：核心产品 / 型号 X100"></div>
      <div class="form-field"><label>分类</label><input id="commissionProductCategoryInput" value="${escapeHtml(editing?.category || "")}" placeholder="产品分类"></div>
      <div class="form-field"><label>型号</label><input id="commissionProductModelInput" value="${escapeHtml(editing?.model || "")}" placeholder="X100"></div>
      <div class="form-field"><label>币种</label><select id="commissionProductCurrencyInput">${["USD", "EUR", "CNY", "GBP"].map((currency) => `<option ${currency === (editing?.currency || "USD") ? "selected" : ""}>${currency}</option>`).join("")}</select></div>
      <div class="form-field"><label>状态</label><select id="commissionProductStatusInput"><option value="active" ${editing?.status !== "disabled" ? "selected" : ""}>启用</option><option value="disabled" ${editing?.status === "disabled" ? "selected" : ""}>停用</option></select></div>
      <div class="form-field"><label>默认单价</label><input id="commissionProductPriceInput" type="number" step="0.01" value="${editing?.defaultPrice ?? 0}"></div>
      <div class="form-field"><label>成本价</label><input id="commissionProductCostInput" type="number" step="0.01" value="${editing?.costPrice ?? 0}"></div>
      <div class="form-field full"><label>备注</label><input id="commissionProductRemarkInput" value="${escapeHtml(editing?.remark || "")}" placeholder="产品适用说明"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCommissionProductButton">${editing ? "保存产品" : "新增产品"}</button>`);
  qs("#saveCommissionProductButton")?.addEventListener("click", () => void saveCommissionProduct(editing?.id || ""));
}

async function saveCommissionProduct(id = "") {
  const result = await api<{ product: CommissionProduct }>(id ? `/api/commission/products/${id}` : "/api/commission/products", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify({
      name: qs<HTMLInputElement>("#commissionProductNameInput")?.value.trim() || "",
      category: qs<HTMLInputElement>("#commissionProductCategoryInput")?.value.trim() || "",
      model: qs<HTMLInputElement>("#commissionProductModelInput")?.value.trim() || "",
      currency: qs<HTMLSelectElement>("#commissionProductCurrencyInput")?.value || "USD",
      status: qs<HTMLSelectElement>("#commissionProductStatusInput")?.value || "active",
      defaultPrice: Number(qs<HTMLInputElement>("#commissionProductPriceInput")?.value || 0),
      costPrice: Number(qs<HTMLInputElement>("#commissionProductCostInput")?.value || 0),
      remark: qs<HTMLInputElement>("#commissionProductRemarkInput")?.value.trim() || ""
    })
  });
  state.commissionProducts = id
    ? state.commissionProducts.map((product) => product.id === result.product.id ? result.product : product)
    : [result.product, ...state.commissionProducts];
  closeModal();
  renderCommission();
  toast(id ? "提成产品已保存" : "提成产品已新增");
}

function ruleValueFor(rule?: CommissionRule) {
  if (!rule) return "";
  if (rule.ruleType === "rate") return String((rule.rate || 0) * 100);
  if (rule.ruleType === "fixed") return String(rule.fixedAmount || 0);
  if (rule.ruleType === "gross_profit") return String((rule.grossProfitRate || 0) * 100);
  return "";
}

function openCommissionRuleModal(product: CommissionProduct, rule?: CommissionRule) {
  if (!state.commissionCanManage) {
    toast("当前账号只能查看产品规则，维护需管理员权限", "error");
    return;
  }
  openModal(rule ? "编辑提成规则" : "新增提成规则", `
    <div class="form-grid">
      <div class="form-field full"><label>适用产品</label><input value="${escapeHtml(product.name)}" readonly></div>
      <div class="form-field"><label>规则类型</label><select id="commissionRuleTypeInput">
        <option value="rate" ${rule?.ruleType === "rate" ? "selected" : ""}>销售额比例</option>
        <option value="gross_profit" ${rule?.ruleType === "gross_profit" ? "selected" : ""}>毛利比例</option>
        <option value="tier" ${rule?.ruleType === "tier" ? "selected" : ""}>阶梯比例</option>
        <option value="fixed" ${rule?.ruleType === "fixed" ? "selected" : ""}>固定金额</option>
        <option value="none" ${rule?.ruleType === "none" ? "selected" : ""}>不计提</option>
      </select></div>
      <div class="form-field"><label>比例（%）/ 固定金额</label><input id="commissionRuleValueInput" type="number" step="0.01" min="0" value="${escapeHtml(ruleValueFor(rule))}" placeholder="比例填 3 表示 3%，固定规则填写金额"></div>
      <div class="form-field"><label>生效月份</label><input id="commissionRuleFromInput" type="month" value="${escapeHtml(rule?.effectiveFrom || state.commissionMonth)}"></div>
      <div class="form-field"><label>失效月份</label><input id="commissionRuleToInput" type="month" value="${escapeHtml(rule?.effectiveTo || "")}"></div>
      <div class="form-field"><label>状态</label><select id="commissionRuleEnabledInput"><option value="true" ${rule?.enabled !== false ? "selected" : ""}>启用</option><option value="false" ${rule?.enabled === false ? "selected" : ""}>停用</option></select></div>
      <div class="form-field full"><label>阶梯JSON</label><input id="commissionRuleTierInput" value="${escapeHtml(rule?.tierJson || "")}" placeholder='[{"from":0,"to":30000,"rate":0.02}]'></div>
      <div class="form-field full"><label>规则说明</label><input id="commissionRuleRemarkInput" value="${escapeHtml(rule?.remark || "")}" placeholder="例如：标准销售额 3%"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCommissionRuleButton">${rule ? "保存规则" : "新增规则"}</button>`);
  qs("#saveCommissionRuleButton")?.addEventListener("click", () => void saveCommissionRule(product.id, rule?.id || ""));
}

async function saveCommissionRule(productId: string, ruleId = "") {
  const ruleType = (qs<HTMLSelectElement>("#commissionRuleTypeInput")?.value || "rate") as CommissionRuleType;
  const value = Number(qs<HTMLInputElement>("#commissionRuleValueInput")?.value || 0);
  const tierJson = qs<HTMLInputElement>("#commissionRuleTierInput")?.value.trim() || "";
  const remark = qs<HTMLInputElement>("#commissionRuleRemarkInput")?.value.trim() || "";
  const normalizedRate = value / 100;
  if ((ruleType === "rate" || ruleType === "gross_profit") && (value < 0 || value > 100)) {
    toast("提成比例必须在 0% 到 100% 之间", "error");
    return;
  }
  const result = await api<{ rule: CommissionRule; replacedRuleId?: string }>(ruleId ? `/api/commission/rules/${ruleId}` : `/api/commission/products/${productId}/rules`, {
    method: ruleId ? "PATCH" : "POST",
    body: JSON.stringify({
      ruleType,
      rate: ruleType === "rate" ? normalizedRate : 0,
      fixedAmount: ruleType === "fixed" ? value : 0,
      grossProfitRate: ruleType === "gross_profit" ? normalizedRate : 0,
      tierJson: ruleType === "tier" ? tierJson : "",
      effectiveFrom: qs<HTMLInputElement>("#commissionRuleFromInput")?.value || state.commissionMonth,
      effectiveTo: qs<HTMLInputElement>("#commissionRuleToInput")?.value || "",
      enabled: qs<HTMLSelectElement>("#commissionRuleEnabledInput")?.value !== "false",
      remark: remark || (ruleType === "tier" ? "阶梯提成" : "")
    })
  });
  state.commissionRules = ruleId
    ? [result.rule, ...state.commissionRules.filter((rule) => rule.id !== result.rule.id && rule.id !== result.replacedRuleId)]
    : [result.rule, ...state.commissionRules];
  closeModal();
  renderCommission();
  toast(ruleId ? "提成规则已保存" : "提成规则已新增");
}

async function toggleCommissionRule(id: string) {
  const rule = state.commissionRules.find((item) => item.id === id);
  if (!rule) return;
  const result = await api<{ rule: CommissionRule }>(`/api/commission/rules/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: !rule.enabled })
  });
  state.commissionRules = state.commissionRules.map((item) => item.id === id ? result.rule : item);
  renderCommission();
  toast(result.rule.enabled ? "提成规则已启用" : "提成规则已停用");
}

async function exportCommission() {
  const result = await api<{ exportJob: { id: string; rows: number }; rows: Record<string, unknown>[]; summaryRows: Record<string, unknown>[] }>("/api/commission/export", {
    method: "POST",
    body: JSON.stringify({
      month: state.commissionMonth,
      ownerId: state.selectedCommissionOwnerId,
      scopeType: state.commissionCanReview && state.selectedCommissionOwnerId === "all" ? "all" : "self",
      fileType: "xlsx"
    })
  });
  const sheet = XLSX.utils.json_to_sheet(result.rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(result.summaryRows), "人员月度汇总");
  XLSX.utils.book_append_sheet(workbook, sheet, "逐笔计提明细");
  XLSX.writeFile(workbook, `GoodJob-提成对账-${state.commissionMonth}.xlsx`);
  toast(`已导出 ${result.exportJob.rows} 行提成对账数据`);
}

function renderReminders(reminders: Reminder[]) {
  const list = qs<HTMLElement>("#reminders .task-list");
  renderTopbarStats();
  if (!list) return;
  qsa<HTMLButtonElement>("[data-reminder-view]", qs("#reminders") || undefined).forEach((button) => {
    button.classList.toggle("active", button.dataset.reminderView === state.reminderView);
    button.onclick = () => {
      state.reminderView = button.dataset.reminderView === "rules" ? "rules" : "tasks";
      renderReminders(state.reminders);
    };
  });
  const filters = qs<HTMLElement>("#reminderTaskFilters");
  if (filters) filters.hidden = state.reminderView !== "tasks";
  qsa<HTMLButtonElement>("[data-reminder-filter]", filters || undefined).forEach((button) => {
    button.classList.toggle("active", button.dataset.reminderFilter === state.reminderFilter);
    button.onclick = () => {
      state.reminderFilter = (button.dataset.reminderFilter as AppState["reminderFilter"]) || "pending";
      renderReminders(state.reminders);
    };
  });
  if (state.reminderView === "tasks") {
    renderReminderTasks(list);
    return;
  }
  list.innerHTML = reminders.length ? reminders.map((reminder) => {
    const priorityTone = reminder.priority === "high" ? "red" : reminder.priority === "medium" ? "amber" : "";
    const enabled = reminder.enabled !== false;
    const accent = enabled ? reminder.priority === "high" ? "rose" : "brand" : "gray";
    const runSummary = reminder.lastRunAt
      ? `最近手工运行 ${escapeHtml(formatDateTime(reminder.lastRunAt))}｜匹配 ${reminder.lastMatchedCount || 0}｜新建 ${reminder.lastCreatedCount || 0}｜跳过 ${reminder.lastSkippedCount || 0}｜失败 ${reminder.lastFailedCount || 0}`
      : "尚未手工运行";
    return `<article class="task reminder-rule-card" data-reminder-id="${escapeHtml(reminder.id)}" style="--accent: var(--${accent})">
      <i class="task-line"></i>
      <div>
        <div class="reminder-rule-heading"><div><h3>${escapeHtml(reminder.title)}</h3><p>${escapeHtml(reminder.rule)}</p></div>${badge(enabled ? "已启用" : "已停用", enabled ? "green" : "gray")}</div>
        <div class="reminder-rule-meta">
          ${badge(reminderRuleTypeText(reminder.ruleType), "")}
          ${badge(reminder.targetStage || "不限阶段", "")}
          ${badge(`${reminder.days ?? 3} 天`, "")}
          ${badge(reminder.priority === "high" ? "高优先级" : reminder.priority === "medium" ? "中优先级" : "普通", priorityTone)}
          ${badge("站内任务", "gray")}
        </div>
        <div class="reminder-run-summary">${runSummary}${reminder.lastError ? `｜${escapeHtml(reminder.lastError)}` : ""}</div>
      </div>
      <div class="reminder-rule-actions">
        <button class="btn" data-run-reminder ${enabled ? "" : "disabled"}>手工运行</button>
        <button class="btn" data-edit-reminder aria-label="编辑规则">编辑</button>
        <button class="btn" data-toggle-reminder>${enabled ? "停用" : "启用"}</button>
      </div>
    </article>`;
  }).join("") : `<div class="reminder-empty">暂无个人提醒规则，可从右上角开始设置。</div>`;
  qsa<HTMLButtonElement>("[data-toggle-reminder]", list).forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest<HTMLElement>(".task");
      if (!row?.dataset.reminderId) return;
      const result = await api<{ reminder: Reminder }>(`/api/reminders/${row.dataset.reminderId}/toggle`, { method: "POST" });
      state.reminders = state.reminders.map((item) => item.id === result.reminder.id ? result.reminder : item);
      renderReminders(state.reminders);
      toast(result.reminder.enabled === false ? "规则已停用" : "规则已启用");
    });
  });
  qsa<HTMLButtonElement>("[data-run-reminder]", list).forEach((button) => {
    button.addEventListener("click", () => void runReminderRule(button.closest<HTMLElement>(".task")?.dataset.reminderId || "", button));
  });
  qsa<HTMLButtonElement>("[data-edit-reminder]", list).forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.closest<HTMLElement>(".task")?.dataset.reminderId;
      const reminder = state.reminders.find((item) => item.id === id);
      if (reminder) openReminderModal(reminder);
    });
  });
}

function reminderDueDate(todo: Todo) {
  const parsed = new Date(todo.dueAt.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function reminderTaskBucket(todo: Todo) {
  if (todo.done) return "done";
  const due = reminderDueDate(todo);
  if (!due) return "future";
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(start.getTime() + 86400000);
  if (due < start) return "overdue";
  if (due < tomorrow) return "today";
  if (todo.snoozeCount) return "snoozed";
  return "future";
}

function renderReminderTasks(list: HTMLElement) {
  const tasks = state.todos
    .filter((todo) => todo.reminderRuleId)
    .filter((todo) => state.reminderFilter === "pending" ? !todo.done : reminderTaskBucket(todo) === state.reminderFilter)
    .sort((left, right) => (reminderDueDate(left)?.getTime() || Number.MAX_SAFE_INTEGER) - (reminderDueDate(right)?.getTime() || Number.MAX_SAFE_INTEGER));
  list.innerHTML = tasks.length ? tasks.map((todo) => {
    const customer = state.customers.find((item) => item.id === todo.customerId);
    const deal = state.deals.find((item) => item.id === todo.dealId);
    const bucket = reminderTaskBucket(todo);
    const status = bucket === "overdue" ? badge("逾期", "red") : bucket === "today" ? badge("今天", "amber") : bucket === "snoozed" ? badge(`已延期 ${todo.snoozeCount || 1} 次`, "") : bucket === "done" ? badge("已完成", "green") : badge("未来", "gray");
    return `<article class="task reminder-task-card" data-reminder-task-id="${escapeHtml(todo.id)}" style="--accent: var(--${bucket === "overdue" ? "rose" : bucket === "done" ? "green" : "brand"})">
      <i class="task-line"></i>
      <div>
        <div class="reminder-task-heading"><div><h3><button data-open-reminder-customer>${escapeHtml(customer?.company || todo.related)}</button></h3><p>${deal ? `${escapeHtml(deal.title)} · ` : ""}${escapeHtml(todo.title)}</p></div>${status}</div>
        <div class="reminder-run-summary">计划 ${escapeHtml(todo.dueAt)}${todo.snoozeReason ? `｜延期原因：${escapeHtml(todo.snoozeReason)}` : ""}${todo.completionResult ? `｜处理结果：${escapeHtml(todo.completionResult)}` : ""}</div>
      </div>
      <div class="reminder-task-actions">
        ${todo.done ? `<button class="btn" disabled>已完成</button>` : `<button class="btn primary" data-complete-reminder-task>记录结果</button><button class="btn" data-snooze-reminder-task aria-label="延期">延期</button>`}
      </div>
    </article>`;
  }).join("") : `<div class="reminder-empty">${state.reminderFilter === "pending" ? "当前没有待处理提醒。" : "当前筛选下没有提醒。"}</div>`;
  qsa<HTMLButtonElement>("[data-open-reminder-customer]", list).forEach((button) => {
    button.addEventListener("click", () => {
      const todo = state.todos.find((item) => item.id === button.closest<HTMLElement>(".task")?.dataset.reminderTaskId);
      const customer = state.customers.find((item) => item.id === todo?.customerId);
      if (!customer) return;
      activateNavView("customers", () => {
        state.selectedCustomerId = customer.id;
        renderCustomers(state.customers);
        renderCustomerDrawer(customer);
        openCustomerDrawer();
      });
    });
  });
  qsa<HTMLButtonElement>("[data-complete-reminder-task]", list).forEach((button) => {
    button.addEventListener("click", () => openReminderTaskResult(button.closest<HTMLElement>(".task")?.dataset.reminderTaskId || ""));
  });
  qsa<HTMLButtonElement>("[data-snooze-reminder-task]", list).forEach((button) => {
    button.addEventListener("click", () => openReminderTaskSnooze(button.closest<HTMLElement>(".task")?.dataset.reminderTaskId || ""));
  });
}

function openReminderTaskResult(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) return;
  openModal("记录跟进结果", `
    <div class="form-grid">
      <div class="form-field full"><label>处理结果</label><select id="reminderResultType"><option>已联系客户，等待回复</option><option>客户已回复</option><option>已更新报价或方案</option><option>已记录样品反馈</option><option>无需继续跟进</option></select></div>
      <div class="form-field full"><label>补充说明</label><textarea id="reminderResultNote" rows="3" placeholder="例如：客户周五前确认采购数量"></textarea></div>
    </div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReminderResult">保存并完成</button>`);
  qs("#saveReminderResult")?.addEventListener("click", async () => {
    const result = `${qs<HTMLSelectElement>("#reminderResultType")?.value || "已处理"}${qs<HTMLTextAreaElement>("#reminderResultNote")?.value.trim() ? `：${qs<HTMLTextAreaElement>("#reminderResultNote")?.value.trim()}` : ""}`;
    const response = await api<{ todo: Todo }>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ done: true, completionResult: result }) });
    state.todos = state.todos.map((item) => item.id === id ? response.todo : item);
    renderReminders(state.reminders);
    closeModal();
    toast("跟进结果已记录");
  });
}

function openReminderTaskSnooze(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) return;
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  const localDateTime = [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, "0"),
    String(next.getDate()).padStart(2, "0")
  ].join("-") + `T${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  openModal("延期提醒", `
    <div class="form-grid">
      <div class="form-field full"><label>新的跟进时间</label><input id="reminderSnoozeAt" type="datetime-local" value="${escapeHtml(localDateTime)}"></div>
      <div class="form-field full"><label>延期原因</label><input id="reminderSnoozeReason" placeholder="例如：客户要求下周再联系"></div>
    </div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReminderSnooze">确认延期</button>`);
  qs("#saveReminderSnooze")?.addEventListener("click", async () => {
    const dueAt = qs<HTMLInputElement>("#reminderSnoozeAt")?.value.replace("T", " ") || "";
    const snoozeReason = qs<HTMLInputElement>("#reminderSnoozeReason")?.value.trim() || "";
    if (!dueAt || !snoozeReason) {
      toast("请选择时间并填写延期原因", "error");
      return;
    }
    const response = await api<{ todo: Todo }>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ dueAt, snoozeReason }) });
    state.todos = state.todos.map((item) => item.id === id ? response.todo : item);
    renderReminders(state.reminders);
    closeModal();
    toast("提醒已延期并保留记录");
  });
}

function reminderRuleTypeText(ruleType = "quote_no_reply") {
  const map: Record<string, string> = {
    quote_no_reply: "已报价阶段停滞",
    sample_feedback: "样品阶段待确认",
    inactive_customer: "长期未产生客户活动",
    high_value_revisit: "高价值复访",
    custom_due: "商机下一动作到期"
  };
  return map[ruleType] || "自定义规则";
}

function renderProblems(problems: ProblemItem[]) {
  const sorted = [...problems].sort((a, b) => {
    const statusWeight = (item: ProblemItem) => item.status === "resolved" ? 2 : item.status === "solving" ? 1 : 0;
    const severityWeight = (item: ProblemItem) => item.severity === "high" ? 0 : item.severity === "medium" ? 1 : 2;
    return statusWeight(a) - statusWeight(b) || severityWeight(a) - severityWeight(b) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const list = qs<HTMLElement>("#problems .problem-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((problem) => `<article class="problem-card ${state.selectedProblemId === problem.id ? "selected" : ""}" data-problem-id="${escapeHtml(problem.id)}">
      <div class="problem-top"><h3>${escapeHtml(problem.title)}</h3>${badge(severityText(problem.severity), severityTone(problem.severity))}</div>
      <div class="problem-meta"><span>${escapeHtml(problem.category)}</span><span>${escapeHtml(problemStatusText(problem.status))}</span><span>${escapeHtml(problem.dueAt || "未设截止")}</span><span>${escapeHtml(problem.relatedCustomer || "未关联客户")}</span></div>
      <p>${escapeHtml(problem.rootCause || "暂未填写原因")}</p>
    </article>`).join("") : `<div class="todo-history-empty">暂无问题，点击“新增问题”建立解决闭环</div>`;
    qsa<HTMLElement>(".problem-card", list).forEach((card) => {
      card.addEventListener("click", () => {
        state.selectedProblemId = card.dataset.problemId || null;
        renderProblems(state.problems);
      });
    });
  }
  const open = problems.filter((item) => item.status === "open").length;
  const solving = problems.filter((item) => item.status === "solving").length;
  const resolved = problems.filter((item) => item.status === "resolved").length;
  const high = problems.filter((item) => item.severity === "high" && item.status !== "resolved").length;
  qs("#problem-open-count")!.textContent = String(open);
  qs("#problem-solving-count")!.textContent = String(solving);
  qs("#problem-resolved-count")!.textContent = String(resolved);
  qs("#problem-high-count")!.textContent = String(high);
  renderProblemDetail(sorted.find((item) => item.id === state.selectedProblemId) || sorted[0]);
}

function renderProblemDetail(problem?: ProblemItem) {
  if (!problem) {
    qs("#problem-detail-title")!.textContent = "问题解决方案";
    qs("#problem-detail-meta")!.textContent = "选择左侧问题查看闭环";
    qs("#problem-root-cause")!.textContent = "暂无问题";
    qs("#problem-solution")!.textContent = "暂无解决方案";
    qs("#problem-next-action")!.textContent = "暂无下一动作";
    return;
  }
  state.selectedProblemId = problem.id;
  qs("#problem-detail-title")!.textContent = problem.title;
  qs("#problem-detail-meta")!.textContent = `${problem.category} · ${problemStatusText(problem.status)} · ${problem.relatedCustomer || "未关联客户"}`;
  qs("#problem-root-cause")!.textContent = problem.rootCause || "暂未填写原因";
  qs("#problem-solution")!.textContent = problem.solution || "暂未填写解决方案";
  qs("#problem-next-action")!.textContent = problem.nextAction || "暂未填写下一动作";
  const button = qs<HTMLButtonElement>("#problemStatusButton");
  if (button) button.textContent = problem.status === "resolved" ? "重新打开" : problem.status === "open" ? "开始解决" : "标记解决";
  const groups = state.problems.reduce<Record<string, { count: number; high: boolean }>>((acc, item) => {
    acc[item.category] = acc[item.category] || { count: 0, high: false };
    acc[item.category].count += 1;
    acc[item.category].high = acc[item.category].high || item.severity === "high";
    return acc;
  }, {});
  const tbody = qs<HTMLElement>("#problem-category-table");
  if (tbody) tbody.innerHTML = Object.entries(groups).map(([category, item]) => `<tr><td>${escapeHtml(category)}</td><td>${item.count}</td><td>${badge(item.high ? "高" : "可控", item.high ? "red" : "green")}</td></tr>`).join("");
}

function visibleMemos() {
  const source = state.memoStatus === "deleted"
    ? state.deletedMemos
    : state.memos.filter((memo) => state.memoStatus === "archived" ? memo.archived : !memo.archived);
  const keyword = state.memoSearch.trim().toLocaleLowerCase();
  return source
    .filter((memo) => !state.memoPinnedOnly || memo.pinned)
    .filter((memo) => !keyword || [memo.title, memo.content, memo.tags].some((value) => value.toLocaleLowerCase().includes(keyword)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function memoRelationText(memo: Memo) {
  const deal = memo.dealId ? state.deals.find((item) => item.id === memo.dealId) : undefined;
  const customer = memo.customerId ? state.customers.find((item) => item.id === memo.customerId) : undefined;
  if (deal) return `商机：${deal.title}`;
  if (customer) return `客户：${customer.company}`;
  if (memo.dealId || memo.customerId) return "关联对象不可访问";
  return "";
}

function renderMemos(_memos?: Memo[]) {
  const sorted = visibleMemos();
  if (state.selectedMemoId && !sorted.some((item) => item.id === state.selectedMemoId)) state.selectedMemoId = sorted[0]?.id || null;
  const list = qs<HTMLElement>("#memos .memo-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((memo) => `<article class="memo-card ${state.selectedMemoId === memo.id ? "selected" : ""} ${memo.archived ? "archived" : ""}" data-memo-id="${escapeHtml(memo.id)}">
      <div class="memo-top"><h3>${escapeHtml(memo.title)}</h3>${badge(memo.deletedAt ? "已删除" : memo.archived ? "归档" : memo.pinned ? "置顶" : memo.category, memo.deletedAt || memo.archived ? "" : memo.pinned ? "green" : "amber")}</div>
      <div class="memo-meta"><span>${escapeHtml(memo.category)}</span><span>${escapeHtml(memo.tags || "无标签")}</span><span>${escapeHtml(formatDateTime(memo.updatedAt))}</span></div>
      <p>${escapeHtml(memo.content.slice(0, 82) || "空白备忘")}</p>
      ${memoRelationText(memo) ? `<div class="memo-relation">${escapeHtml(memoRelationText(memo))}</div>` : ""}
    </article>`).join("") : `<div class="todo-history-empty">暂无备忘，点击“新增备忘”开始记录</div>`;
    qsa<HTMLElement>(".memo-card", list).forEach((card) => {
      card.addEventListener("click", async () => {
        await saveCurrentMemoDraft();
        state.selectedMemoId = card.dataset.memoId || null;
        memoMobileDetailOpen = true;
        renderMemos();
      });
    });
  }
  qsa<HTMLButtonElement>("[data-memo-status]").forEach((button) => button.classList.toggle("active", button.dataset.memoStatus === state.memoStatus));
  const pinnedOnly = qs<HTMLInputElement>("#memoPinnedOnly");
  if (pinnedOnly) pinnedOnly.checked = state.memoPinnedOnly;
  qs("#memoGrid")?.classList.toggle("detail-open", memoMobileDetailOpen);
  renderMemoDetail(sorted.find((item) => item.id === state.selectedMemoId) || sorted[0]);
}

function renderMemoDetail(memo?: Memo) {
  if (!memo) {
    qs("#memo-detail-title")!.textContent = "备忘详情";
    qs("#memo-detail-meta")!.textContent = "选择左侧备忘查看内容";
    const titleEditor = qs<HTMLInputElement>("#memoTitleEditor");
    const tagsEditor = qs<HTMLInputElement>("#memoTagsEditor");
    const contentEditor = qs<HTMLTextAreaElement>("#memoContentEditor");
    if (titleEditor) titleEditor.value = "暂无备忘";
    if (tagsEditor) tagsEditor.value = "";
    if (contentEditor) contentEditor.value = "点击“新增备忘”记录客户偏好、报价复盘或临时事项。";
    qs<HTMLButtonElement>("#memoPinButton")?.setAttribute("disabled", "true");
    qs<HTMLButtonElement>("#memoArchiveButton")?.setAttribute("disabled", "true");
    qs<HTMLButtonElement>("#memoDeleteButton")?.setAttribute("disabled", "true");
    return;
  }
  state.selectedMemoId = memo.id;
  const deleted = Boolean(memo.deletedAt);
  qs("#memo-detail-title")!.textContent = deleted ? "已删除备忘" : "备忘编辑";
  qs("#memo-detail-meta")!.textContent = deleted ? "恢复后可继续编辑" : `${memo.archived ? "已归档" : "个人私有"} · 输入停止后自动保存`;
  const titleEditor = qs<HTMLInputElement>("#memoTitleEditor");
  const categoryEditor = qs<HTMLSelectElement>("#memoCategoryEditor");
  const tagsEditor = qs<HTMLInputElement>("#memoTagsEditor");
  const customerEditor = qs<HTMLSelectElement>("#memoCustomerEditor");
  const dealEditor = qs<HTMLSelectElement>("#memoDealEditor");
  const contentEditor = qs<HTMLTextAreaElement>("#memoContentEditor");
  let editorValue = {
    title: memo.title,
    category: memo.category,
    tags: memo.tags,
    customerId: memo.customerId,
    dealId: memo.dealId,
    content: memo.content || ""
  };
  const draft = readMemoDraft(memo);
  let restoredDraft = false;
  if (!deleted && draft && !resolvedMemoDrafts.has(memo.id)) {
    resolvedMemoDrafts.add(memo.id);
    const conflict = draft.serverUpdatedAt !== memo.updatedAt;
    const restore = window.confirm(conflict
      ? `发现「${memo.title}」的本机草稿，但服务器内容已更新。是否仍恢复本机草稿？`
      : `发现「${memo.title}」尚未同步的本机草稿，是否恢复？`);
    if (restore) {
      editorValue = draft;
      restoredDraft = true;
      memoEditRevision += 1;
    } else {
      clearMemoDraft(memo.id);
    }
  }
  if (titleEditor) titleEditor.value = editorValue.title;
  if (categoryEditor) categoryEditor.value = editorValue.category;
  if (tagsEditor) tagsEditor.value = editorValue.tags;
  renderMemoRelationOptions(editorValue.customerId, editorValue.dealId);
  if (customerEditor) customerEditor.value = editorValue.customerId;
  if (dealEditor) dealEditor.value = editorValue.dealId;
  if (contentEditor) contentEditor.value = editorValue.content;
  memoDirty = restoredDraft;
  setMemoSaveState(deleted ? "只读" : restoredDraft ? "仅保存在本机，点击重试" : "已保存到服务器", restoredDraft);
  const pinButton = qs<HTMLButtonElement>("#memoPinButton");
  const archiveButton = qs<HTMLButtonElement>("#memoArchiveButton");
  const deleteButton = qs<HTMLButtonElement>("#memoDeleteButton");
  if (pinButton) pinButton.textContent = memo.pinned ? "取消置顶" : "置顶";
  if (archiveButton) archiveButton.textContent = deleted ? "恢复备忘" : memo.archived ? "恢复使用" : "归档";
  if (deleteButton) deleteButton.textContent = deleted ? "永久删除" : "删除";
  if (pinButton) pinButton.disabled = deleted;
  if (archiveButton) archiveButton.disabled = false;
  if (deleteButton) deleteButton.disabled = false;
  [titleEditor, categoryEditor, tagsEditor, customerEditor, dealEditor, contentEditor].forEach((input) => {
    if (input) input.disabled = deleted;
  });
  if (!deleted) bindMemoEditorEvents();
}

function memoDraftKey(id: string) {
  return `goodjob:memo-draft:${state.user?.id || "anonymous"}:${id}`;
}

function collectMemoEditorDraft(memo: Memo): MemoDraft {
  return {
    title: qs<HTMLInputElement>("#memoTitleEditor")?.value.trim() || memo.title,
    category: qs<HTMLSelectElement>("#memoCategoryEditor")?.value || memo.category,
    tags: qs<HTMLInputElement>("#memoTagsEditor")?.value.trim() || "",
    customerId: qs<HTMLSelectElement>("#memoCustomerEditor")?.value || "",
    dealId: qs<HTMLSelectElement>("#memoDealEditor")?.value || "",
    content: qs<HTMLTextAreaElement>("#memoContentEditor")?.value || "",
    serverUpdatedAt: memo.updatedAt,
    draftAt: new Date().toISOString()
  };
}

function writeMemoDraft(memo: Memo) {
  localStorage.setItem(memoDraftKey(memo.id), JSON.stringify(collectMemoEditorDraft(memo)));
}

function readMemoDraft(memo: Memo): MemoDraft | null {
  try {
    const raw = localStorage.getItem(memoDraftKey(memo.id));
    if (!raw) return null;
    return JSON.parse(raw) as MemoDraft;
  } catch {
    clearMemoDraft(memo.id);
    return null;
  }
}

function clearMemoDraft(id: string) {
  localStorage.removeItem(memoDraftKey(id));
}

function clearCurrentUserMemoDrafts() {
  const prefix = `goodjob:memo-draft:${state.user?.id || "anonymous"}:`;
  Object.keys(localStorage).filter((key) => key.startsWith(prefix)).forEach((key) => localStorage.removeItem(key));
}

function renderMemoRelationOptions(customerId: string, dealId: string) {
  const customerEditor = qs<HTMLSelectElement>("#memoCustomerEditor");
  const dealEditor = qs<HTMLSelectElement>("#memoDealEditor");
  if (customerEditor) {
    const inaccessible = customerId && !state.customers.some((item) => item.id === customerId);
    customerEditor.innerHTML = `<option value="">不关联客户</option>${inaccessible ? `<option value="${escapeHtml(customerId)}">关联对象不可访问</option>` : ""}${state.customers.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.company)}</option>`).join("")}`;
    customerEditor.value = customerId;
  }
  if (dealEditor) {
    const available = state.deals.filter((item) => !customerId || item.customerId === customerId);
    const inaccessible = dealId && !available.some((item) => item.id === dealId);
    dealEditor.innerHTML = `<option value="">不关联商机</option>${inaccessible ? `<option value="${escapeHtml(dealId)}">关联对象不可访问</option>` : ""}${available.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}`;
    dealEditor.value = dealId;
  }
}

function renderCompetitors(competitors: Competitor[]) {
  const sorted = [...competitors].sort((a, b) => {
    const weight = (item: Competitor) => item.threatLevel === "high" ? 0 : item.threatLevel === "medium" ? 1 : 2;
    return weight(a) - weight(b) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const list = qs<HTMLElement>("#competitors .intel-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((item) => `<article class="intel-card ${state.selectedCompetitorId === item.id ? "selected" : ""}" data-competitor-id="${escapeHtml(item.id)}">
      <div class="intel-top"><h3>${escapeHtml(item.company)}</h3>${badge(threatText(item.threatLevel), severityTone(item.threatLevel))}</div>
      <div class="intel-meta"><span>${escapeHtml(item.country || "未知国家")}</span><span>${escapeHtml(item.segment || "未分类")}</span><span>${escapeHtml(item.competingProducts || "未维护产品")}</span></div>
      <p>${escapeHtml(item.strengths || "暂未维护竞争优势")}</p>
    </article>`).join("") : `<div class="todo-history-empty">暂无竞争公司，点击“新增竞争公司”建立情报库</div>`;
    qsa<HTMLElement>(".intel-card", list).forEach((card) => {
      card.addEventListener("click", () => {
        state.selectedCompetitorId = card.dataset.competitorId || null;
        renderCompetitors(state.competitors);
      });
    });
  }
  qs("#competitor-total-count")!.textContent = String(competitors.length);
  qs("#competitor-high-count")!.textContent = String(competitors.filter((item) => item.threatLevel === "high").length);
  qs("#competitor-segment-count")!.textContent = String(new Set(competitors.map((item) => item.segment).filter(Boolean)).size);
  qs("#competitor-strategy-count")!.textContent = String(competitors.filter((item) => item.ourStrategy).length);
  renderCompetitorDetail(sorted.find((item) => item.id === state.selectedCompetitorId) || sorted[0]);
}

function renderCompetitorDetail(competitor?: Competitor) {
  if (!competitor) return;
  state.selectedCompetitorId = competitor.id;
  qs("#competitor-detail-title")!.textContent = competitor.company;
  qs("#competitor-detail-meta")!.textContent = `${competitor.country || "未知国家"} · ${competitor.segment || "未分类"} · ${threatText(competitor.threatLevel)}`;
  qs("#competitor-products")!.textContent = competitor.competingProducts || "暂未维护";
  qs("#competitor-strengths")!.textContent = competitor.strengths || "暂未维护";
  qs("#competitor-weaknesses")!.textContent = competitor.weaknesses || "暂未维护";
  qs("#competitor-strategy")!.textContent = competitor.ourStrategy || "暂未维护";
  const button = qs<HTMLButtonElement>("#competitorThreatButton");
  if (button) button.textContent = competitor.threatLevel === "high" ? "降为中威胁" : "设为高威胁";
}

function renderCaseStudies(caseStudies: CaseStudy[]) {
  const sorted = [...caseStudies].sort((a, b) => Number(b.status === "published") - Number(a.status === "published") || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const list = qs<HTMLElement>("#cases .case-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((item) => `<article class="case-card ${state.selectedCaseId === item.id ? "selected" : ""}" data-case-id="${escapeHtml(item.id)}">
      <div class="case-top"><h3>${escapeHtml(item.title)}</h3>${badge(caseStatusText(item.status), item.status === "published" ? "green" : "amber")}</div>
      <div class="case-meta"><span>${escapeHtml(item.customer || "未关联客户")}</span><span>${escapeHtml(item.product || "未维护产品")}</span><span>${escapeHtml(item.country || "未知国家")}</span></div>
      <p>${escapeHtml(item.result || "暂未填写成果")}</p>
    </article>`).join("") : `<div class="todo-history-empty">暂无成功案例，点击“新增成功案例”沉淀销售素材</div>`;
    qsa<HTMLElement>(".case-card", list).forEach((card) => {
      card.addEventListener("click", () => {
        state.selectedCaseId = card.dataset.caseId || null;
        renderCaseStudies(state.caseStudies);
      });
    });
  }
  qs("#case-total-count")!.textContent = String(caseStudies.length);
  qs("#case-published-count")!.textContent = String(caseStudies.filter((item) => item.status === "published").length);
  qs("#case-product-count")!.textContent = String(new Set(caseStudies.map((item) => item.product).filter(Boolean)).size);
  qs("#case-draft-count")!.textContent = String(caseStudies.filter((item) => item.status !== "published").length);
  renderCaseDetail(sorted.find((item) => item.id === state.selectedCaseId) || sorted[0]);
}

function renderCaseDetail(caseStudy?: CaseStudy) {
  if (!caseStudy) return;
  state.selectedCaseId = caseStudy.id;
  qs("#case-detail-title")!.textContent = caseStudy.title;
  qs("#case-detail-meta")!.textContent = `${caseStudy.customer || "未关联客户"} · ${caseStudy.country || "未知国家"} · ${caseStatusText(caseStudy.status)}`;
  qs("#case-product")!.textContent = caseStudy.product || "暂未维护";
  qs("#case-result")!.textContent = caseStudy.result || "暂未维护";
  qs("#case-industry")!.textContent = caseStudy.industry || "暂未维护";
  qs("#case-story")!.textContent = caseStudy.story || "暂未维护";
  qs("#case-reusable")!.textContent = caseStudy.reusablePoints || "暂未维护";
  const button = qs<HTMLButtonElement>("#casePublishButton");
  if (button) button.textContent = caseStudy.status === "published" ? "已发布" : "发布案例";
}

function bindMemoEditorEvents() {
  qsa<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#memoTitleEditor, #memoCategoryEditor, #memoTagsEditor, #memoCustomerEditor, #memoDealEditor, #memoContentEditor").forEach((input) => {
    if (input.dataset.memoBound === "true") return;
    input.dataset.memoBound = "true";
    input.addEventListener("input", () => {
      memoDirty = true;
      memoEditRevision += 1;
      const memo = state.memos.find((item) => item.id === state.selectedMemoId);
      if (memo) writeMemoDraft(memo);
      setMemoSaveState("仅保存在本机");
      window.clearTimeout(memoSaveTimer);
      memoSaveTimer = window.setTimeout(() => void saveCurrentMemoDraft(), 700);
    });
    input.addEventListener("change", () => {
      if (input.id === "memoCustomerEditor") {
        const customerId = (input as HTMLSelectElement).value;
        const dealEditor = qs<HTMLSelectElement>("#memoDealEditor");
        const currentDeal = state.deals.find((item) => item.id === dealEditor?.value);
        renderMemoRelationOptions(customerId, currentDeal?.customerId === customerId ? currentDeal.id : "");
      }
      if (input.id === "memoDealEditor") {
        const deal = state.deals.find((item) => item.id === (input as HTMLSelectElement).value);
        if (deal) renderMemoRelationOptions(deal.customerId, deal.id);
      }
      input.dispatchEvent(new Event("input"));
    });
    input.addEventListener("blur", () => {
      if (memoDirty) void saveCurrentMemoDraft();
    });
  });
}

function setMemoSaveState(text: string, retry = false) {
  const node = qs<HTMLButtonElement>("#memoSaveState");
  if (node) {
    node.textContent = text;
    node.classList.toggle("needs-retry", retry);
    node.disabled = !retry;
  }
}

function openReminderModal(reminder?: Reminder) {
  const type = reminder?.ruleType || "quote_no_reply";
  const stage = reminder?.targetStage || "已报价";
  const days = reminder?.days ?? 3;
  openModal(reminder ? "编辑提醒规则" : "设置提醒规则", `
    <div class="form-grid">
      <div class="form-field full"><label>规则模板</label><select id="reminderRuleTypeInput"><option value="quote_no_reply" ${type === "quote_no_reply" ? "selected" : ""}>已报价阶段停滞</option><option value="sample_feedback" ${type === "sample_feedback" ? "selected" : ""}>进入样品阶段后待确认</option><option value="inactive_customer" ${type === "inactive_customer" ? "selected" : ""}>长期未产生客户活动</option><option value="high_value_revisit" ${type === "high_value_revisit" ? "selected" : ""}>高价值客户复访</option><option value="custom_due" ${type === "custom_due" ? "selected" : ""}>商机下一动作到期</option></select></div>
      <div class="form-field full"><label>提醒名称</label><input id="reminderTitleInput" data-auto-title="${reminder ? "false" : "true"}" value="${escapeHtml(reminder?.title || "报价阶段停滞提醒")}"></div>
      <div class="form-field"><label>适用阶段</label><select id="reminderStageInput">${["已报价", "样品", "谈判", "询盘", "已联系", "成交", "丢单"].map((item) => `<option ${item === stage ? "selected" : ""}>${item}</option>`).join("")}</select></div>
      <div class="form-field"><label>触发天数</label><input id="reminderDaysInput" type="number" min="0" max="90" value="${days}"></div>
      <div class="form-field"><label>任务时间说明</label><input id="reminderDueInput" value="${escapeHtml(reminder?.dueAt || "按触发日期生成")}"></div>
      <div class="form-field"><label>生成方式</label><input value="站内任务" disabled></div>
      <div class="form-field"><label>优先级</label><select id="reminderPriorityInput"><option value="high">高优先级</option><option value="medium" selected>中优先级</option><option value="normal">普通</option></select></div>
      <label class="form-field"><span>规则状态</span><select id="reminderEnabledInput"><option value="true">启用</option><option value="false">停用</option></select></label>
      <div class="form-field full"><label>规则说明</label><input id="reminderRuleInput" value="${escapeHtml(reminder?.rule || "进入已报价阶段 3 天未更新时生成站内任务")}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReminderButton">${reminder ? "保存修改" : "保存规则"}</button>`);
  const priority = qs<HTMLSelectElement>("#reminderPriorityInput");
  if (priority) priority.value = reminder?.priority || "medium";
  const enabled = qs<HTMLSelectElement>("#reminderEnabledInput");
  if (enabled) enabled.value = reminder?.enabled === false ? "false" : "true";
  bindReminderRulePreset();
  if (reminder) reminderRuleDraft(false);
  qs("#saveReminderButton")?.addEventListener("click", () => void saveReminder(reminder?.id));
}

function reminderRulePreset(type: string) {
  if (type === "sample_feedback") {
    return { title: "样品阶段待确认", stage: "样品", days: "3" };
  }
  if (type === "inactive_customer") {
    return { title: "长期未联系提醒", days: "14" };
  }
  if (type === "high_value_revisit") {
    return { title: "高价值客户复访", days: "7" };
  }
  if (type === "custom_due") {
    return { title: "商机下一动作到期提醒" };
  }
  return { title: "报价阶段停滞提醒", stage: "已报价", days: "3" };
}

function reminderRuleDraft(applyPreset = false) {
  const type = qs<HTMLSelectElement>("#reminderRuleTypeInput")?.value || "quote_no_reply";
  const stageInput = qs<HTMLSelectElement>("#reminderStageInput");
  const daysInput = qs<HTMLInputElement>("#reminderDaysInput");
  const titleInput = qs<HTMLInputElement>("#reminderTitleInput");
  const preset = reminderRulePreset(type);
  if (applyPreset) {
    if (stageInput && preset.stage) stageInput.value = preset.stage;
    if (daysInput && preset.days) daysInput.value = preset.days;
    if (titleInput && titleInput.dataset.autoTitle !== "false") {
      titleInput.value = preset.title;
      titleInput.dataset.autoTitle = "true";
    }
  }
  const ruleInput = qs<HTMLInputElement>("#reminderRuleInput");
  const stage = qs<HTMLSelectElement>("#reminderStageInput")?.value || "已报价";
  const days = qs<HTMLInputElement>("#reminderDaysInput")?.value || "3";
  if (ruleInput) ruleInput.value = `${stage}阶段 ${days} 天未更新时生成站内任务`;
}

function bindReminderRulePreset() {
  qs<HTMLInputElement>("#reminderTitleInput")?.addEventListener("input", (event) => {
    (event.currentTarget as HTMLInputElement).dataset.autoTitle = "false";
  });
  qs<HTMLElement>("#reminderRuleTypeInput")?.addEventListener("change", () => reminderRuleDraft(true));
  ["#reminderStageInput", "#reminderDaysInput"].forEach((selector) => {
    qs<HTMLElement>(selector)?.addEventListener("change", () => reminderRuleDraft());
    qs<HTMLElement>(selector)?.addEventListener("input", () => reminderRuleDraft());
  });
  reminderRuleDraft(true);
}

async function saveReminder(id?: string) {
  const title = qs<HTMLInputElement>("#reminderTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写提醒名称", "error");
    return;
  }
  const result = await api<{ reminder: Reminder }>(id ? `/api/reminders/${id}` : "/api/reminders", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify({
      title,
      rule: qs<HTMLInputElement>("#reminderRuleInput")?.value || "已报价阶段超过设定天数未更新",
      dueAt: qs<HTMLInputElement>("#reminderDueInput")?.value || "今天",
      channel: "站内",
      ruleType: qs<HTMLSelectElement>("#reminderRuleTypeInput")?.value || "quote_no_reply",
      targetStage: qs<HTMLSelectElement>("#reminderStageInput")?.value || "已报价",
      days: Number(qs<HTMLInputElement>("#reminderDaysInput")?.value || 3),
      priority: qs<HTMLSelectElement>("#reminderPriorityInput")?.value || "medium",
      enabled: qs<HTMLSelectElement>("#reminderEnabledInput")?.value !== "false"
    })
  });
  state.reminders = id
    ? state.reminders.map((item) => item.id === id ? result.reminder : item)
    : [result.reminder, ...state.reminders];
  state.reminderView = "rules";
  renderReminders(state.reminders);
  closeModal();
  toast(id ? "提醒规则已更新" : "提醒规则已保存，可先预览再手工运行");
}

async function runReminderRule(id: string, button?: HTMLButtonElement) {
  if (!id) return;
  try {
    const preview = await api<{ matchedCount: number; creatableCount: number; skippedCount: number; preview: Array<{ customer: string; deal: string }> }>(`/api/reminders/${id}/preview`);
    const sample = preview.preview.map((item) => `${item.customer}${item.deal ? ` / ${item.deal}` : ""}`).join("、") || "无";
    if (!window.confirm(`预计命中 ${preview.matchedCount} 条，可新建 ${preview.creatableCount} 条，跳过 ${preview.skippedCount} 条。\n示例：${sample}\n\n确认手工运行？`)) return;
    if (button) {
      button.disabled = true;
      button.textContent = "运行中";
    }
    const result = await api<{ reminder: Reminder; createdCount: number; matchedCount: number; skippedCount: number; failedCount: number }>(`/api/reminders/${id}/run`, { method: "POST" });
    state.reminders = state.reminders.map((reminder) => reminder.id === result.reminder.id ? result.reminder : reminder);
    const todos = await api<{ todos: Todo[] }>("/api/todos");
    state.todos = todos.todos;
    renderReminders(state.reminders);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    renderTopbarStats();
    toast(`手工运行完成：匹配 ${result.matchedCount}，新建 ${result.createdCount}，跳过 ${result.skippedCount}，失败 ${result.failedCount}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "执行提醒规则失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "手工运行";
    }
  }
}

function openProblemModal() {
  openModal("新增问题", `
    <div class="form-grid">
      <div class="form-field full"><label>问题标题</label><input id="problemTitleInput" placeholder="例如：客户报价后超过 5 天未回复"></div>
      <div class="form-field"><label>类别</label><select id="problemCategoryInput"><option>报价跟进</option><option>资料维护</option><option>工具/OCR</option><option>客户服务</option><option>团队执行</option></select></div>
      <div class="form-field"><label>严重程度</label><select id="problemSeverityInput"><option value="medium">中</option><option value="high">高</option><option value="low">低</option></select></div>
      <div class="form-field"><label>关联客户</label><input id="problemCustomerInput" placeholder="可选：客户或线索名称"></div>
      <div class="form-field"><label>截止时间</label><input id="problemDueInput" placeholder="例如：今天 18:00"></div>
      <div class="form-field full"><label>问题原因</label><textarea id="problemRootInput" placeholder="描述问题产生原因"></textarea></div>
      <div class="form-field full"><label>解决方案</label><textarea id="problemSolutionInput" placeholder="写清楚解决路径、标准和注意事项"></textarea></div>
      <div class="form-field full"><label>下一动作</label><input id="problemNextInput" placeholder="例如：今天发送补充资料，明天企微确认"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveProblemButton">保存问题</button>`);
  qs("#saveProblemButton")?.addEventListener("click", () => void saveProblem());
  qs<HTMLInputElement>("#problemTitleInput")?.focus();
}

async function saveProblem() {
  const title = qs<HTMLInputElement>("#problemTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写问题标题", "error");
    return;
  }
  const result = await api<{ problem: ProblemItem }>("/api/problems", {
    method: "POST",
    body: JSON.stringify({
      title,
      category: qs<HTMLSelectElement>("#problemCategoryInput")?.value || "客户问题",
      severity: qs<HTMLSelectElement>("#problemSeverityInput")?.value || "medium",
      relatedCustomer: qs<HTMLInputElement>("#problemCustomerInput")?.value.trim() || "",
      rootCause: qs<HTMLTextAreaElement>("#problemRootInput")?.value.trim() || "",
      solution: qs<HTMLTextAreaElement>("#problemSolutionInput")?.value.trim() || "",
      nextAction: qs<HTMLInputElement>("#problemNextInput")?.value.trim() || "",
      dueAt: qs<HTMLInputElement>("#problemDueInput")?.value.trim() || ""
    })
  });
  state.problems.unshift(result.problem);
  state.selectedProblemId = result.problem.id;
  renderProblems(state.problems);
  closeModal();
  toast("问题已新增");
}

async function advanceProblemStatus() {
  const problem = state.problems.find((item) => item.id === state.selectedProblemId);
  if (!problem) return;
  const nextStatus = problem.status === "open" ? "solving" : problem.status === "solving" ? "resolved" : "open";
  const result = await api<{ problem: ProblemItem }>(`/api/problems/${problem.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: nextStatus })
  });
  Object.assign(problem, result.problem);
  renderProblems(state.problems);
  toast(`问题状态已更新：${problemStatusText(problem.status)}`);
}

function openMemoModal() {
  openModal("新增备忘", `
    <div class="form-grid">
      <div class="form-field full"><label>标题</label><input id="memoTitleInput" placeholder="例如：某客户报价偏好"></div>
      <div class="form-field full"><label>内容</label><textarea id="memoContentInput" placeholder="记录关键信息、背景、下一步或复盘结论"></textarea></div>
      <details class="form-field full memo-create-options">
        <summary>关联与分类（可选）</summary>
        <div class="form-grid">
          <div class="form-field"><label>分类</label><select id="memoCategoryInput"><option>客户备忘</option><option>销售话术</option><option>产品知识</option><option>报价复盘</option><option>个人记录</option></select></div>
          <div class="form-field"><label>标签</label><input id="memoTagsInput" placeholder="多个标签用逗号分隔"></div>
          <div class="form-field"><label>关联客户</label><select id="memoCustomerInput"><option value="">不关联客户</option>${state.customers.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.company)}</option>`).join("")}</select></div>
          <div class="form-field"><label>关联商机</label><select id="memoDealInput"><option value="">不关联商机</option>${state.deals.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}</select></div>
        </div>
      </details>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveMemoButton">保存备忘</button>`);
  qs("#saveMemoButton")?.addEventListener("click", () => void saveMemo());
  qs<HTMLSelectElement>("#memoCustomerInput")?.addEventListener("change", (event) => {
    const customerId = (event.currentTarget as HTMLSelectElement).value;
    const dealInput = qs<HTMLSelectElement>("#memoDealInput");
    if (!dealInput) return;
    dealInput.innerHTML = `<option value="">不关联商机</option>${state.deals.filter((item) => !customerId || item.customerId === customerId).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}`;
  });
  qs<HTMLSelectElement>("#memoDealInput")?.addEventListener("change", (event) => {
    const deal = state.deals.find((item) => item.id === (event.currentTarget as HTMLSelectElement).value);
    if (deal) {
      const customerInput = qs<HTMLSelectElement>("#memoCustomerInput");
      if (customerInput) customerInput.value = deal.customerId;
    }
  });
  qs<HTMLInputElement>("#memoTitleInput")?.focus();
}

async function saveMemo() {
  const title = qs<HTMLInputElement>("#memoTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写备忘标题", "error");
    return;
  }
  const result = await api<{ memo: Memo }>("/api/memos", {
    method: "POST",
    body: JSON.stringify({
      title,
      category: qs<HTMLSelectElement>("#memoCategoryInput")?.value || "客户备忘",
      tags: qs<HTMLInputElement>("#memoTagsInput")?.value.trim() || "",
      content: qs<HTMLTextAreaElement>("#memoContentInput")?.value.trim() || "",
      customerId: qs<HTMLSelectElement>("#memoCustomerInput")?.value || "",
      dealId: qs<HTMLSelectElement>("#memoDealInput")?.value || ""
    })
  });
  state.memos.unshift(result.memo);
  state.selectedMemoId = result.memo.id;
  state.memoStatus = "active";
  memoMobileDetailOpen = true;
  renderMemos();
  closeModal();
  toast("备忘已保存");
}

async function saveCurrentMemoDraft() {
  window.clearTimeout(memoSaveTimer);
  if (memoSavePromise) {
    await memoSavePromise;
    if (memoDirty) return saveCurrentMemoDraft();
    return;
  }
  if (!memoDirty) return;
  const memo = state.memos.find((item) => item.id === state.selectedMemoId);
  if (!memo) return;
  const revision = memoEditRevision;
  const draft = collectMemoEditorDraft(memo);
  memoSaving = true;
  setMemoSaveState("保存中");
  memoSavePromise = (async () => {
    try {
      const result = await api<{ memo: Memo }>(`/api/memos/${memo.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: draft.title,
          category: draft.category,
          tags: draft.tags,
          customerId: draft.customerId,
          dealId: draft.dealId,
          content: draft.content
        })
      });
      Object.assign(memo, result.memo);
      if (memoEditRevision === revision) {
        memoDirty = false;
        clearMemoDraft(memo.id);
        setMemoSaveState("已保存到服务器");
        renderMemos();
      } else {
        memoDirty = true;
        writeMemoDraft(memo);
        setMemoSaveState("仅保存在本机");
        memoSaveTimer = window.setTimeout(() => void saveCurrentMemoDraft(), 700);
      }
    } catch (error) {
      memoDirty = true;
      writeMemoDraft(memo);
      setMemoSaveState("保存失败，点击重试", true);
      throw error;
    }
  })();
  try {
    await memoSavePromise;
  } catch (error) {
    toast(error instanceof Error ? error.message : "备忘保存失败", "error");
  } finally {
    memoSaving = false;
    memoSavePromise = null;
  }
}

async function patchSelectedMemo(payload: Partial<Pick<Memo, "title" | "content" | "category" | "tags" | "pinned" | "archived">>) {
  await saveCurrentMemoDraft();
  const memo = state.memos.find((item) => item.id === state.selectedMemoId);
  if (!memo) return;
  const result = await api<{ memo: Memo }>(`/api/memos/${memo.id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  Object.assign(memo, result.memo);
  if (typeof payload.archived === "boolean") state.memoStatus = payload.archived ? "archived" : "active";
  renderMemos();
  toast(memo.archived ? "备忘已归档" : memo.pinned ? "备忘已置顶" : "备忘已更新");
}

async function deleteSelectedMemo() {
  if (memoDeleteBusy) return;
  const memo = [...state.memos, ...state.deletedMemos].find((item) => item.id === state.selectedMemoId);
  if (!memo) {
    toast("请选择要删除的备忘", "error");
    return;
  }
  if (memo.deletedAt) {
    if (!window.confirm(`确认永久删除「${memo.title}」？此操作不可恢复。`)) return;
    memoDeleteBusy = true;
    qs<HTMLButtonElement>("#memoDeleteButton")?.setAttribute("disabled", "true");
    try {
      await api<{ ok: boolean; id: string }>(`/api/memos/${memo.id}/permanent`, { method: "DELETE" });
      state.deletedMemos = state.deletedMemos.filter((item) => item.id !== memo.id);
      clearMemoDraft(memo.id);
      state.selectedMemoId = state.deletedMemos[0]?.id || null;
      memoMobileDetailOpen = Boolean(state.selectedMemoId);
      renderMemos();
      toast("备忘已永久删除");
    } finally {
      memoDeleteBusy = false;
      qs<HTMLButtonElement>("#memoDeleteButton")?.removeAttribute("disabled");
    }
    return;
  }
  if (!window.confirm(`确认删除「${memo.title}」？删除后可在“已删除”中恢复。`)) return;
  memoDeleteBusy = true;
  qs<HTMLButtonElement>("#memoDeleteButton")?.setAttribute("disabled", "true");
  try {
    await saveCurrentMemoDraft();
    const result = await api<{ ok: boolean; memo: Memo }>(`/api/memos/${memo.id}`, { method: "DELETE" });
    state.memos = state.memos.filter((item) => item.id !== memo.id);
    state.deletedMemos = [result.memo, ...state.deletedMemos.filter((item) => item.id !== result.memo.id)];
    clearMemoDraft(memo.id);
    state.memoStatus = "deleted";
    state.selectedMemoId = result.memo.id;
    memoDirty = false;
    memoMobileDetailOpen = true;
    renderMemos();
    toast("备忘已移至已删除");
  } finally {
    memoDeleteBusy = false;
    qs<HTMLButtonElement>("#memoDeleteButton")?.removeAttribute("disabled");
  }
}

async function restoreSelectedMemo() {
  const memo = state.deletedMemos.find((item) => item.id === state.selectedMemoId);
  if (!memo) return;
  const result = await api<{ memo: Memo }>(`/api/memos/${memo.id}/restore`, { method: "POST" });
  state.deletedMemos = state.deletedMemos.filter((item) => item.id !== memo.id);
  state.memos.unshift(result.memo);
  state.memoStatus = result.memo.archived ? "archived" : "active";
  state.selectedMemoId = result.memo.id;
  renderMemos();
  toast(result.memo.archived ? "备忘已恢复到归档" : "备忘已恢复");
}

function openCompetitorModal() {
  openModal("新增竞争公司", `
    <div class="form-grid">
      <div class="form-field full"><label>公司名称</label><input id="competitorCompanyInput" placeholder="例如：EuroLift Tools GmbH"></div>
      <div class="form-field"><label>国家</label><input id="competitorCountryInput" value="德国"></div>
      <div class="form-field"><label>品类/赛道</label><input id="competitorSegmentInput" value="电动工具"></div>
      <div class="form-field"><label>威胁等级</label><select id="competitorThreatInput"><option value="medium">中威胁</option><option value="high">高威胁</option><option value="low">低威胁</option></select></div>
      <div class="form-field"><label>官网</label><input id="competitorWebsiteInput" placeholder="可选"></div>
      <div class="form-field full"><label>竞争产品</label><input id="competitorProductsInput" placeholder="例如：18V 无刷电钻、角磨机"></div>
      <div class="form-field full"><label>优势</label><textarea id="competitorStrengthsInput" placeholder="对方强在哪里"></textarea></div>
      <div class="form-field full"><label>弱点</label><textarea id="competitorWeaknessesInput" placeholder="我们可以突破的地方"></textarea></div>
      <div class="form-field full"><label>应对策略</label><textarea id="competitorStrategyInput" placeholder="报价、资料、谈判、交付策略"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCompetitorButton">保存竞争公司</button>`);
  qs("#saveCompetitorButton")?.addEventListener("click", () => void saveCompetitor());
  qs<HTMLInputElement>("#competitorCompanyInput")?.focus();
}

async function saveCompetitor() {
  const company = qs<HTMLInputElement>("#competitorCompanyInput")?.value.trim() || "";
  if (!company) {
    toast("请填写竞争公司名称", "error");
    return;
  }
  const result = await api<{ competitor: Competitor }>("/api/competitors", {
    method: "POST",
    body: JSON.stringify({
      company,
      country: qs<HTMLInputElement>("#competitorCountryInput")?.value.trim() || "",
      segment: qs<HTMLInputElement>("#competitorSegmentInput")?.value.trim() || "",
      threatLevel: qs<HTMLSelectElement>("#competitorThreatInput")?.value || "medium",
      website: qs<HTMLInputElement>("#competitorWebsiteInput")?.value.trim() || "",
      competingProducts: qs<HTMLInputElement>("#competitorProductsInput")?.value.trim() || "",
      strengths: qs<HTMLTextAreaElement>("#competitorStrengthsInput")?.value.trim() || "",
      weaknesses: qs<HTMLTextAreaElement>("#competitorWeaknessesInput")?.value.trim() || "",
      ourStrategy: qs<HTMLTextAreaElement>("#competitorStrategyInput")?.value.trim() || ""
    })
  });
  state.competitors.unshift(result.competitor);
  state.selectedCompetitorId = result.competitor.id;
  renderCompetitors(state.competitors);
  closeModal();
  toast("竞争公司已新增");
}

async function toggleCompetitorThreat() {
  const competitor = state.competitors.find((item) => item.id === state.selectedCompetitorId);
  if (!competitor) return;
  const nextThreat = competitor.threatLevel === "high" ? "medium" : "high";
  const result = await api<{ competitor: Competitor }>(`/api/competitors/${competitor.id}/threat`, {
    method: "PATCH",
    body: JSON.stringify({ threatLevel: nextThreat })
  });
  Object.assign(competitor, result.competitor);
  renderCompetitors(state.competitors);
  toast(`威胁等级已更新：${threatText(competitor.threatLevel)}`);
}

function openCaseModal() {
  openModal("新增成功案例", `
    <div class="form-grid">
      <div class="form-field full"><label>案例标题</label><input id="caseTitleInput" placeholder="例如：重点客户年度订单复购"></div>
      <div class="form-field"><label>客户</label><input id="caseCustomerInput" value="${escapeHtml(state.customers[0]?.company || "")}"></div>
      <div class="form-field"><label>国家</label><input id="caseCountryInput" value="${escapeHtml(state.customers[0]?.country || "")}"></div>
      <div class="form-field"><label>产品</label><input id="caseProductInput" placeholder="例如：18V 无刷电钻套装"></div>
      <div class="form-field"><label>行业</label><input id="caseIndustryInput" placeholder="例如：工具批发"></div>
      <div class="form-field full"><label>成果</label><input id="caseResultInput" placeholder="例如：拿下 $36,000 首单"></div>
      <div class="form-field full"><label>成交故事</label><textarea id="caseStoryInput" placeholder="客户背景、阻力、关键动作和成交过程"></textarea></div>
      <div class="form-field full"><label>可复用打法</label><textarea id="caseReusableInput" placeholder="可复制到其他客户的步骤和话术"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCaseButton">保存案例</button>`);
  qs("#saveCaseButton")?.addEventListener("click", () => void saveCaseStudy());
  qs<HTMLInputElement>("#caseTitleInput")?.focus();
}

async function saveCaseStudy() {
  const title = qs<HTMLInputElement>("#caseTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写案例标题", "error");
    return;
  }
  const result = await api<{ caseStudy: CaseStudy }>("/api/case-studies", {
    method: "POST",
    body: JSON.stringify({
      title,
      customer: qs<HTMLInputElement>("#caseCustomerInput")?.value.trim() || "",
      country: qs<HTMLInputElement>("#caseCountryInput")?.value.trim() || "",
      product: qs<HTMLInputElement>("#caseProductInput")?.value.trim() || "",
      industry: qs<HTMLInputElement>("#caseIndustryInput")?.value.trim() || "",
      result: qs<HTMLInputElement>("#caseResultInput")?.value.trim() || "",
      story: qs<HTMLTextAreaElement>("#caseStoryInput")?.value.trim() || "",
      reusablePoints: qs<HTMLTextAreaElement>("#caseReusableInput")?.value.trim() || ""
    })
  });
  state.caseStudies.unshift(result.caseStudy);
  state.selectedCaseId = result.caseStudy.id;
  renderCaseStudies(state.caseStudies);
  closeModal();
  toast("成功案例已新增");
}

async function publishSelectedCase() {
  const caseStudy = state.caseStudies.find((item) => item.id === state.selectedCaseId);
  if (!caseStudy || caseStudy.status === "published") return;
  const result = await api<{ caseStudy: CaseStudy }>(`/api/case-studies/${caseStudy.id}/publish`, { method: "PATCH" });
  Object.assign(caseStudy, result.caseStudy);
  renderCaseStudies(state.caseStudies);
  toast("成功案例已发布");
}

function renderJobs(jobs: ImportExportJob[]) {
  const tbody = qs<HTMLElement>("#imports tbody");
  if (!tbody) return;
  tbody.innerHTML = jobs.length ? jobs.map((job) => `<tr><td>${escapeHtml(job.name)}</td><td>${job.type === "import" ? "导入" : "导出"}</td><td>${job.rows.toLocaleString("en-US")} 行</td><td>${badge(job.status === "done" ? "完成" : job.status === "failed" ? "失败" : "待审批", job.status === "done" ? "green" : job.status === "failed" ? "red" : "amber")}</td><td>当前账号</td><td>${escapeHtml(job.createdAt)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty-cell">暂无导入导出任务</td></tr>`;
}

function documentStatusText(status: string) {
  const map: Record<string, string> = {
    draft: "草稿",
    ready: "已配置",
    pending_approval: "待审批",
    approved: "已审批",
    rejected: "已驳回",
    exported: "已导出"
  };
  return map[status] || "草稿";
}

function documentTotal(document: TradeDocument) {
  return document.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
}

function formatDocumentMoney(value: number, currency = "USD") {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDocumentTableMoney(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayDateInput() {
  return new Date().toISOString().slice(0, 10);
}

function defaultTradeDocument(type: "PI" | "CI" = "PI"): TradeDocument {
  const date = todayDateInput();
  return {
    id: "__new__",
    customerId: "",
    dealId: "",
    revision: 1,
    type,
    title: type === "PI" ? "新建形式发票 PI" : "新建商业发票 CI",
    number: `${type}-${date.replace(/-/g, "")}-${Math.floor(Date.now() / 1000).toString().slice(-4)}`,
    issueDate: date,
    buyer: state.customers[0]?.company || "Buyer Company",
    buyerAddress: state.customers[0] ? `${state.customers[0].country} / address to be confirmed` : "",
    buyerContact: state.customers[0]?.contact || "",
    seller: "GoodJob Instrument Co., Ltd.",
    sellerAddress: "Tianjin, China",
    currency: "USD",
    incoterm: "FOB Tianjin",
    paymentTerm: "30% T/T deposit, 70% before shipment",
    shippingMethod: "Sea freight",
    portLoading: "Tianjin, China",
    portDischarge: "",
    validityDate: "",
    bankInfo: "Beneficiary: GoodJob Instrument Co., Ltd. / Bank: Bank of China Tianjin Branch / SWIFT: BKCHCNBJ",
    notes: type === "PI" ? "Lead time starts after deposit and technical confirmation." : "The goods are of China origin and packed for export shipment.",
    templateStyle: "executive",
    status: "draft",
    audits: [],
    sendRecords: [],
    updatedAt: new Date().toISOString(),
    items: [
      { id: "new_item_1", product: "Smart Pressure Transmitter", model: "GJ-PT3051", hsCode: "902620", quantity: 10, unit: "PCS", unitPrice: 185, originCountry: "China", weightKg: 16, packageCount: 1 }
    ]
  };
}

function activeTradeDocument() {
  return state.tradeDocuments.find((document) => document.id === state.selectedDocumentId) || state.tradeDocuments[0] || defaultTradeDocument();
}

function renderTradeDocuments(documents: TradeDocument[]) {
  const list = qs<HTMLElement>("#documentList");
  if (!list) return;
  const active = documents.find((document) => document.id === state.selectedDocumentId) || documents[0] || defaultTradeDocument();
  state.selectedDocumentId = active.id;
  list.innerHTML = `
    <div class="section-title"><h2>单据列表</h2><span>${documents.length} 份</span></div>
    ${documents.length ? documents.map((document) => `
      <article class="doc-list-card ${document.id === active.id ? "active" : ""}" data-document-id="${escapeHtml(document.id)}">
        <b>${escapeHtml(document.title)}</b>
        <span>${escapeHtml(document.number)} · ${document.type}</span>
        <small>${documentStatusText(document.status)} · ${formatDocumentMoney(documentTotal(document), document.currency)}</small>
      </article>
    `).join("") : `<div class="empty-cell">暂无单据，点击新建单据开始。</div>`}
  `;
  qsa<HTMLElement>("[data-document-id]", list).forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedDocumentId = card.dataset.documentId || null;
      renderTradeDocuments(state.tradeDocuments);
    });
  });
  fillDocumentEditor(active);
}

function fillDocumentEditor(document: TradeDocument) {
  setDocumentType(document.type);
  renderDocumentWorkflow(document);
  const values: Record<string, string> = {
    docTitleInput: document.title,
    docNumberInput: document.number,
    docIssueDateInput: document.issueDate,
    docTemplateInput: document.templateStyle,
    docBuyerInput: document.buyer,
    docBuyerContactInput: document.buyerContact,
    docBuyerAddressInput: document.buyerAddress,
    docSellerInput: document.seller,
    docCurrencyInput: document.currency,
    docSellerAddressInput: document.sellerAddress,
    docIncotermInput: document.incoterm,
    docShippingInput: document.shippingMethod,
    docPortLoadingInput: document.portLoading,
    docPortDischargeInput: document.portDischarge,
    docValidityInput: document.validityDate,
    docPaymentInput: document.paymentTerm,
    docBankInput: document.bankInfo,
    docNotesInput: document.notes
  };
  Object.entries(values).forEach(([id, value]) => {
    const input = qs<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`);
    if (input) input.value = value || "";
  });
  renderDocumentItems(document.items);
  renderDocumentPreview(collectDocumentDraft());
}

function renderDocumentWorkflow(document: TradeDocument) {
  const customerSelect = qs<HTMLSelectElement>("#docCustomerInput");
  const dealSelect = qs<HTMLSelectElement>("#docDealInput");
  if (customerSelect) {
    customerSelect.innerHTML = `<option value="">未关联客户</option>${state.customers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.company)}${customer.country ? ` · ${escapeHtml(customer.country)}` : ""}</option>`).join("")}`;
    customerSelect.value = document.customerId || "";
  }
  if (dealSelect) {
    const visibleDeals = state.deals.filter((deal) => !document.customerId || deal.customerId === document.customerId);
    dealSelect.innerHTML = `<option value="">未关联商机</option>${visibleDeals.map((deal) => `<option value="${escapeHtml(deal.id)}">${escapeHtml(deal.title)} · ${escapeHtml(deal.stage)}</option>`).join("")}`;
    dealSelect.value = document.dealId || "";
  }
  const status = qs<HTMLElement>("#docStatusBadge");
  if (status) status.textContent = `${documentStatusText(document.status)} · v${document.revision || 1}`;
  const locked = document.status === "approved" || document.status === "exported";
  const pending = document.status === "pending_approval";
  const buttonState: Record<string, boolean> = {
    documentSubmitApprovalButton: locked || pending,
    documentApproveButton: !pending,
    documentRejectButton: !pending,
    documentSendButton: document.id === "__new__",
    documentNewRevisionButton: !locked
  };
  Object.entries(buttonState).forEach(([id, disabled]) => {
    const button = qs<HTMLButtonElement>(`#${id}`);
    if (button) button.disabled = disabled;
  });
  const history = qs<HTMLElement>("#documentHistory");
  if (history) {
    const rows = [
      ...(document.audits || []).slice(-12).reverse().map((audit) => `<div class="doc-history-item"><span><b>${escapeHtml(audit.field)}</b>：${escapeHtml(audit.oldValue || "空")} → ${escapeHtml(audit.newValue || "空")}</span><small>${escapeHtml(audit.operatorName)} · ${escapeHtml(audit.createdAt.slice(0, 16).replace("T", " "))}</small></div>`),
      ...(document.sendRecords || []).slice(-8).reverse().map((record) => `<div class="doc-history-item"><span><b>发送</b>：${escapeHtml(record.channel)} · ${escapeHtml(record.recipient)}</span><small>${escapeHtml(record.operatorName)} · ${escapeHtml(record.createdAt.slice(0, 16).replace("T", " "))}</small></div>`)
    ];
    history.innerHTML = rows.length ? `<div class="doc-history-list">${rows.join("")}</div>` : `<p>暂无记录</p>`;
  }
}

function applyDocumentCustomerDefaults(customerId: string) {
  const customer = state.customers.find((item) => item.id === customerId);
  if (!customer) return;
  const values: Record<string, string> = {
    docBuyerInput: customer.billingName?.trim() || customer.company,
    docBuyerAddressInput: customer.billingAddress?.trim() || `${customer.country} / address to be confirmed`,
    docBuyerContactInput: customer.documentContact?.trim() || customer.contact,
    docIncotermInput: customer.defaultIncoterm?.trim() || "FOB Tianjin",
    docPaymentInput: customer.defaultPaymentTerm?.trim() || "30% T/T deposit, 70% before shipment",
    docPortDischargeInput: customer.defaultPortDischarge?.trim() || ""
  };
  Object.entries(values).forEach(([id, value]) => {
    const input = qs<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    if (input) input.value = value;
  });
  renderDocumentPreview(collectDocumentDraft());
}

function updateActiveDocument(document: TradeDocument) {
  state.tradeDocuments = state.tradeDocuments.map((item) => item.id === document.id ? document : item);
  state.selectedDocumentId = document.id;
  renderTradeDocuments(state.tradeDocuments);
}

async function submitDocumentApproval() {
  const document = activeTradeDocument();
  if (!document.id || document.id === "__new__") {
    toast("请先保存单据，再提交审批", "error");
    return;
  }
  const note = window.prompt("审批说明（可选）", "请确认客户、付款条款和交期") || "";
  const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${document.id}/submit-approval`, { method: "POST", body: JSON.stringify({ note }) });
  updateActiveDocument(result.document);
  toast("单据已提交审批");
}

async function approveActiveDocument() {
  const document = activeTradeDocument();
  if (!document.id || document.status !== "pending_approval") return;
  const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${document.id}/approve`, { method: "POST", body: JSON.stringify({}) });
  updateActiveDocument(result.document);
  toast("单据已审批通过");
}

async function rejectActiveDocument() {
  const document = activeTradeDocument();
  if (!document.id || document.status !== "pending_approval") return;
  const note = window.prompt("请填写驳回原因", "请补充或确认付款条款")?.trim() || "";
  if (!note) {
    toast("驳回必须填写原因", "error");
    return;
  }
  const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${document.id}/reject`, { method: "POST", body: JSON.stringify({ note }) });
  updateActiveDocument(result.document);
  toast("单据已驳回，业务员可修改后重新提交");
}

async function sendActiveDocument() {
  const document = activeTradeDocument();
  if (!document.id || document.id === "__new__") {
    toast("请先保存单据，再记录发送", "error");
    return;
  }
  openModal("记录发送单据", `
    <div class="form-grid">
      <div class="form-field"><label>发送渠道</label><select id="documentSendChannelInput"><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="wechat">微信</option><option value="manual">人工发送</option></select></div>
      <div class="form-field"><label>发送对象</label><input id="documentSendRecipientInput" value="${escapeHtml(document.buyerContact || document.buyer)}" placeholder="邮箱、手机号或联系人"></div>
      <div class="form-field full"><label>发送说明</label><textarea id="documentSendMessageInput" placeholder="例如：Please review the attached PI."></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmDocumentSendButton">保存发送记录</button>`);
  qs("#confirmDocumentSendButton")?.addEventListener("click", async () => {
    const recipient = qs<HTMLInputElement>("#documentSendRecipientInput")?.value.trim() || "";
    const channel = qs<HTMLSelectElement>("#documentSendChannelInput")?.value || "manual";
    const message = qs<HTMLTextAreaElement>("#documentSendMessageInput")?.value.trim() || "";
    if (!recipient) {
      toast("请填写发送对象", "error");
      return;
    }
    const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${document.id}/send`, { method: "POST", body: JSON.stringify({ channel, recipient, message }) });
    closeModal();
    updateActiveDocument(result.document);
    toast("发送记录已保存");
  });
}

async function createDocumentRevision() {
  const document = activeTradeDocument();
  if (!document.id || document.id === "__new__") {
    toast("请先保存单据，再另存新版本", "error");
    return;
  }
  const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${document.id}/revision`, { method: "POST", body: JSON.stringify({}) });
  state.tradeDocuments = [result.document, ...state.tradeDocuments];
  state.selectedDocumentId = result.document.id;
  renderTradeDocuments(state.tradeDocuments);
  toast(`已创建 v${result.document.revision} 新版本`);
}

function setDocumentType(type: "PI" | "CI") {
  qsa<HTMLButtonElement>("#documentTypeTabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.docType === type);
  });
}

function currentDocumentType(): "PI" | "CI" {
  return qs<HTMLButtonElement>("#documentTypeTabs button.active")?.dataset.docType === "CI" ? "CI" : "PI";
}

function renderDocumentItems(items: TradeDocumentItem[]) {
  const box = qs<HTMLElement>("#documentItemsEditor");
  if (!box) return;
  box.innerHTML = items.map((item, index) => `
    <div class="doc-item-grid" data-doc-item="${escapeHtml(item.id || `item_${index}`)}">
      <label data-doc-size="name"><span>品名</span><input data-doc-field="product" value="${escapeHtml(item.product)}"></label>
      <label><span>型号</span><input data-doc-field="model" value="${escapeHtml(item.model)}"></label>
      <label><span>HS Code</span><input data-doc-field="hsCode" value="${escapeHtml(item.hsCode)}"></label>
      <label data-doc-size="short"><span>数量</span><input data-doc-field="quantity" type="number" min="0" value="${item.quantity}"></label>
      <label data-doc-size="short"><span>单位</span><input data-doc-field="unit" value="${escapeHtml(item.unit)}"></label>
      <label data-doc-size="price"><span>单价</span><input data-doc-field="unitPrice" type="number" min="0" step="0.01" value="${item.unitPrice}"></label>
      <label><span>原产国</span><input data-doc-field="originCountry" value="${escapeHtml(item.originCountry)}"></label>
      <label data-doc-size="short"><span>重量kg</span><input data-doc-field="weightKg" type="number" min="0" step="0.01" value="${item.weightKg}"></label>
      <label data-doc-size="short"><span>包装</span><input data-doc-field="packageCount" type="number" min="0" value="${item.packageCount}"></label>
      <button class="doc-item-remove" type="button" title="删除明细">×</button>
    </div>
  `).join("");
  qsa<HTMLInputElement>("[data-doc-field]", box).forEach((input) => input.addEventListener("input", () => renderDocumentPreview(collectDocumentDraft())));
  qsa<HTMLButtonElement>(".doc-item-remove", box).forEach((button) => {
    button.addEventListener("click", () => {
      button.closest(".doc-item-grid")?.remove();
      if (!qsa(".doc-item-grid", box).length) addDocumentItem();
      renderDocumentPreview(collectDocumentDraft());
    });
  });
}

function collectDocumentItems(): TradeDocumentItem[] {
  return qsa<HTMLElement>("#documentItemsEditor .doc-item-grid").map((row, index) => {
    const field = (name: string) => row.querySelector<HTMLInputElement>(`[data-doc-field="${name}"]`)?.value.trim() || "";
    const numberField = (name: string) => Number(row.querySelector<HTMLInputElement>(`[data-doc-field="${name}"]`)?.value || 0);
    return {
      id: row.dataset.docItem || `item_${index}`,
      product: field("product") || "Product",
      model: field("model"),
      hsCode: field("hsCode"),
      quantity: numberField("quantity"),
      unit: field("unit") || "PCS",
      unitPrice: numberField("unitPrice"),
      originCountry: field("originCountry") || "China",
      weightKg: numberField("weightKg"),
      packageCount: Math.round(numberField("packageCount"))
    };
  });
}

function collectDocumentDraft(): TradeDocument {
  const existing = state.tradeDocuments.find((document) => document.id === state.selectedDocumentId);
  return {
    id: existing?.id || state.selectedDocumentId || "__new__",
    customerId: qs<HTMLSelectElement>("#docCustomerInput")?.value || existing?.customerId || "",
    dealId: qs<HTMLSelectElement>("#docDealInput")?.value || existing?.dealId || "",
    revision: existing?.revision || 1,
    type: currentDocumentType(),
    title: qs<HTMLInputElement>("#docTitleInput")?.value.trim() || "未命名单据",
    number: qs<HTMLInputElement>("#docNumberInput")?.value.trim() || `DOC-${Date.now()}`,
    issueDate: qs<HTMLInputElement>("#docIssueDateInput")?.value || todayDateInput(),
    buyer: qs<HTMLInputElement>("#docBuyerInput")?.value.trim() || "Buyer Company",
    buyerAddress: qs<HTMLInputElement>("#docBuyerAddressInput")?.value.trim() || "",
    buyerContact: qs<HTMLInputElement>("#docBuyerContactInput")?.value.trim() || "",
    seller: qs<HTMLInputElement>("#docSellerInput")?.value.trim() || "GoodJob Instrument Co., Ltd.",
    sellerAddress: qs<HTMLInputElement>("#docSellerAddressInput")?.value.trim() || "",
    currency: qs<HTMLSelectElement>("#docCurrencyInput")?.value || "USD",
    incoterm: qs<HTMLSelectElement>("#docIncotermInput")?.value || "FOB Tianjin",
    paymentTerm: qs<HTMLInputElement>("#docPaymentInput")?.value.trim() || "",
    shippingMethod: qs<HTMLSelectElement>("#docShippingInput")?.value || "Sea freight",
    portLoading: qs<HTMLInputElement>("#docPortLoadingInput")?.value.trim() || "",
    portDischarge: qs<HTMLInputElement>("#docPortDischargeInput")?.value.trim() || "",
    validityDate: qs<HTMLInputElement>("#docValidityInput")?.value || "",
    bankInfo: qs<HTMLTextAreaElement>("#docBankInput")?.value.trim() || "",
    notes: qs<HTMLTextAreaElement>("#docNotesInput")?.value.trim() || "",
    templateStyle: (qs<HTMLSelectElement>("#docTemplateInput")?.value as TradeDocument["templateStyle"]) || "executive",
    status: existing?.status || "draft",
    audits: existing?.audits || [],
    sendRecords: existing?.sendRecords || [],
    updatedAt: new Date().toISOString(),
    items: collectDocumentItems()
  };
}

function renderDocumentPreview(document: TradeDocument) {
  const preview = qs<HTMLElement>("#documentPreview");
  if (!preview) return;
  const total = documentTotal(document);
  const title = document.type === "PI" ? "PROFORMA INVOICE" : "COMMERCIAL INVOICE";
  const status = document.type === "PI" ? "Quotation confirmation" : "Customs / shipment document";
  preview.className = `doc-paper ${document.templateStyle}`;
  preview.innerHTML = `
    <div class="doc-print-head">
      <div class="doc-letterhead">
        <div class="doc-logo-mark">GJ</div>
        <div>
          <b>${escapeHtml(document.seller)}</b>
          <small>${escapeHtml(document.sellerAddress || "Tianjin, China")}<br>Export Documentation Center</small>
        </div>
      </div>
      <div class="doc-number-box">
        <p><b>No.</b> ${escapeHtml(document.number)}</p>
        <p><b>Date</b> ${escapeHtml(document.issueDate)}</p>
        <p><b>Currency</b> ${escapeHtml(document.currency)}</p>
      </div>
    </div>
    <div class="doc-title-band">
      <h2>${title}</h2>
      <p>${escapeHtml(status)} · ${escapeHtml(document.title)}</p>
    </div>
    <div class="doc-print-grid">
      <div class="doc-block"><h3>Seller</h3><p><b>${escapeHtml(document.seller)}</b></p><p>${escapeHtml(document.sellerAddress)}</p></div>
      <div class="doc-block"><h3>Buyer</h3><p><b>${escapeHtml(document.buyer)}</b></p><p>${escapeHtml(document.buyerAddress)}</p><p>${escapeHtml(document.buyerContact)}</p></div>
    </div>
    <div class="doc-terms">
      <div class="doc-term"><span>Incoterm</span><b>${escapeHtml(document.incoterm)}</b></div>
      <div class="doc-term"><span>Payment</span><b>${escapeHtml(document.paymentTerm)}</b></div>
      <div class="doc-term"><span>Shipment</span><b>${escapeHtml(document.shippingMethod)}</b></div>
      <div class="doc-term"><span>Validity</span><b>${escapeHtml(document.validityDate || "To be confirmed")}</b></div>
      <div class="doc-term"><span>Port of Loading</span><b>${escapeHtml(document.portLoading)}</b></div>
      <div class="doc-term"><span>Port of Discharge</span><b>${escapeHtml(document.portDischarge || "To be confirmed")}</b></div>
      <div class="doc-term"><span>Document Type</span><b>${document.type}</b></div>
      <div class="doc-term"><span>Status</span><b>${documentStatusText(document.status)}</b></div>
    </div>
    <table class="doc-items-table ${document.type === "CI" ? "ci" : "pi"}">
      <thead><tr><th>#</th><th>Description</th><th>Model</th><th>HS Code</th><th>Qty</th><th>Unit Price</th><th>Amount</th>${document.type === "CI" ? "<th>Origin</th><th>Weight</th><th>Pkgs</th>" : ""}</tr></thead>
      <tbody>${document.items.map((item, index) => `
        <tr>
          <td class="doc-num">${index + 1}</td>
          <td class="doc-desc">${escapeHtml(item.product)}</td>
          <td>${escapeHtml(item.model)}</td>
          <td>${escapeHtml(item.hsCode)}</td>
          <td class="doc-qty">${item.quantity} ${escapeHtml(item.unit)}</td>
          <td class="doc-money">${formatDocumentTableMoney(item.unitPrice)}</td>
          <td class="doc-money">${formatDocumentTableMoney(item.quantity * item.unitPrice)}</td>
          ${document.type === "CI" ? `<td class="doc-origin">${escapeHtml(item.originCountry)}</td><td class="doc-weight">${item.weightKg} kg</td><td class="doc-pkgs">${item.packageCount}</td>` : ""}
        </tr>
      `).join("")}</tbody>
    </table>
    <div class="doc-total"><span>Total Amount</span><b>${formatDocumentMoney(total, document.currency)}</b></div>
    <div class="doc-sign">
      <div class="doc-block"><h3>Bank / Notes</h3><p>${escapeHtml(document.bankInfo)}</p><p>${escapeHtml(document.notes)}</p></div>
      <div class="doc-stamp">AUTHORIZED</div>
    </div>
  `;
  const meta = qs<HTMLElement>("#docPreviewMeta");
  if (meta) meta.textContent = `${document.type} · ${document.number} · ${formatDocumentMoney(total, document.currency)}`;
}

function addDocumentItem() {
  const draft = collectDocumentDraft();
  draft.items.push({ id: `item_${Date.now()}`, product: "", model: "", hsCode: "", quantity: 1, unit: "PCS", unitPrice: 0, originCountry: "China", weightKg: 0, packageCount: 0 });
  renderDocumentItems(draft.items);
  renderDocumentPreview(draft);
}

function openNewDocument() {
  state.selectedDocumentId = "__new__";
  fillDocumentEditor(defaultTradeDocument());
  qsa<HTMLElement>(".doc-list-card").forEach((card) => card.classList.remove("active"));
  toast("已创建单据草稿，保存后写入数据库");
}

async function saveTradeDocument() {
  const draft = collectDocumentDraft();
  if (!draft.items.length) {
    toast("请至少保留一条商品明细", "error");
    return null;
  }
  const existing = state.tradeDocuments.find((document) => document.id === state.selectedDocumentId);
  let result: { document: TradeDocument };
  try {
    result = await api<{ document: TradeDocument }>(existing ? `/api/trade-documents/${existing.id}` : "/api/trade-documents", {
      method: existing ? "PATCH" : "POST",
      body: JSON.stringify({ ...draft, status: "ready" })
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : "单据保存失败", "error");
    return null;
  }
  state.tradeDocuments = existing
    ? state.tradeDocuments.map((document) => document.id === result.document.id ? result.document : document)
    : [result.document, ...state.tradeDocuments];
  state.selectedDocumentId = result.document.id;
  renderTradeDocuments(state.tradeDocuments);
  toast("单据配置已保存到数据库");
  return result.document;
}

async function exportTradeDocumentPdf() {
  const current = activeTradeDocument();
  const saved = current.id !== "__new__" && (current.status === "approved" || current.status === "exported")
    ? current
    : await saveTradeDocument();
  if (!saved) return;
  if (saved.status !== "approved" && saved.status !== "exported") {
    toast("已打印单据草稿；审批通过后会生成正式导出记录");
    printDocumentPreview();
    return;
  }
  const result = await api<{ document: TradeDocument; job: ImportExportJob; fileName: string }>(`/api/trade-documents/${saved.id}/export`, { method: "POST" });
  state.tradeDocuments = state.tradeDocuments.map((document) => document.id === result.document.id ? result.document : document);
  state.jobs.unshift(result.job);
  renderTradeDocuments(state.tradeDocuments);
  renderJobs(state.jobs);
  toast(`已生成 PDF 导出任务：${result.fileName}`);
  printDocumentPreview();
}

function printDocumentPreview() {
  const preview = qs<HTMLElement>("#documentPreview");
  if (!preview) {
    window.print();
    return;
  }
  qs<HTMLElement>(".print-only-document")?.remove();
  const clone = preview.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.className = `${preview.className} print-only-document`;
  document.body.appendChild(clone);
  const cleanup = () => {
    clone.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
  window.setTimeout(cleanup, 30000);
}

function parseNumberCell(value: unknown, fallback = 0) {
  const text = String(value ?? "").replace(/[,$￥¥\s]/g, "");
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function parseBooleanCell(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "y", "是", "已绑定", "绑定"].includes(text);
}

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMPORT_EXTENSIONS = new Set(["xlsx", "xls", "csv"]);

function assertImportFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED_IMPORT_EXTENSIONS.has(extension)) {
    throw new Error("仅支持 XLSX、XLS 或 CSV 文件");
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error("导入文件不能超过 5 MB");
  }
}

async function parseCustomerImportFile(file: File): Promise<CustomerImportRow[]> {
  assertImportFile(file);
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", dense: true, sheetRows: 2002 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (rows.length > 2000) throw new Error("客户导入单次最多支持 2000 行");
  return rows.map((row) => {
    const company = String(rowValue(row, ["公司名", "客户", "客户名称", "公司", "客户公司", "company", "Company"])).trim();
    return {
      company,
      country: String(rowValue(row, ["国家", "市场", "country", "Country"]) || "未知").trim(),
      contact: String(rowValue(row, ["联系人", "联系人姓名", "contact", "Contact"]) || "待维护").trim(),
      stage: String(rowValue(row, ["阶段", "客户阶段", "stage", "Stage"]) || "询盘").trim(),
      amount: parseNumberCell(rowValue(row, ["预计金额", "金额", "商机金额", "amount", "Amount"])),
      health: Math.max(0, Math.min(100, Math.round(parseNumberCell(rowValue(row, ["健康度", "评分", "health", "Health"]), 70)))),
      nextReminder: String(rowValue(row, ["下一提醒", "提醒", "下次跟进", "nextReminder", "Next Reminder"]) || "待跟进").trim(),
      wecomBound: parseBooleanCell(rowValue(row, ["企微绑定", "企业微信", "企微", "wecomBound", "WeCom"]))
    };
  }).filter((row) => row.company);
}

async function importCustomersFromFile(button?: HTMLButtonElement) {
  const input = qs<HTMLInputElement>("#customerImportInput");
  const file = input?.files?.[0];
  if (!file) {
    toast("请先选择 Excel 或 CSV 客户文件", "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "导入中";
    }
    const rows = await parseCustomerImportFile(file);
    if (!rows.length) {
      toast("未识别到有效客户，请检查公司名表头", "error");
      return;
    }
    const result = await api<{ result: { created: number; updated: number; skipped: number; total: number }; job: ImportExportJob; customers: Customer[] }>("/api/import-export/customers/import", {
      method: "POST",
      body: JSON.stringify({ fileName: file.name, rows })
    });
    state.customers = result.customers;
    state.jobs.unshift(result.job);
    state.selectedCustomerId = result.customers[0]?.id || state.selectedCustomerId;
    renderCustomers(state.customers);
    renderJobs(state.jobs);
    renderTopbarStats();
    void refreshDashboardOnly();
    toast(`导入完成：新增 ${result.result.created}，更新 ${result.result.updated}，共 ${result.result.total} 行`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "客户导入失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "导入客户";
    }
  }
}

async function exportCustomers() {
  try {
    const result = await api<{ customers: Customer[]; job: ImportExportJob }>("/api/import-export/customers/export", { method: "POST" });
    const rows = result.customers.map((customer) => ({
      公司名: customer.company,
      国家: customer.country,
      联系人: customer.contact,
      最高活跃商机阶段: customer.pipelineStage || "暂无活跃商机",
      活跃商机数: customer.activeDealCount || 0,
      在手商机额: customer.pipelineAmount || 0,
      健康度: customer.health,
      下一提醒: customer.nextReminder,
      企微绑定: customer.wecomBound ? "已绑定" : "未绑定"
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "客户清单");
    XLSX.writeFile(workbook, `GoodJob客户清单-${Date.now()}.xlsx`);
    state.jobs.unshift(result.job);
    renderJobs(state.jobs);
    toast(`客户已导出：${rows.length} 行`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "客户导出失败", "error");
  }
}

function downloadCustomerTemplate() {
  const worksheet = XLSX.utils.json_to_sheet([
    { 公司名: "Demo Instrument Trading Co., Ltd.", 国家: "德国", 联系人: "Demo Contact", 阶段: "询盘", 预计金额: 12000, 健康度: 70, 下一提醒: "明天 10:00", 企微绑定: "未绑定" }
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "客户导入模板");
  XLSX.writeFile(workbook, "GoodJob客户导入模板.xlsx");
  toast("客户导入模板已下载");
}

function renderWecom(messages: WecomMessage[]) {
  const chat = qs<HTMLElement>("#wecom .chat");
  if (!chat) return;
  chat.innerHTML = messages.map((message, index) => `<div class="bubble ${index % 2 ? "me" : ""}">${escapeHtml(message.summary)} ${message.status === "archived" ? "已归档" : "待归档"}</div>`).join("");
}

async function syncWecomMessages() {
  const pending = state.wecomMessages.filter((message) => message.status !== "archived");
  for (const message of pending) {
    const result = await api<{ message: WecomMessage }>(`/api/wecom/messages/${message.id}/archive`, { method: "POST" });
    Object.assign(message, result.message);
  }
  renderWecom(state.wecomMessages);
  toast(pending.length ? `已同步 ${pending.length} 条企微摘要` : "企微摘要已是最新");
}

function renderKnowledge(assets: KnowledgeAsset[]) {
  const grid = qs<HTMLElement>("#knowledge .file-grid");
  if (!grid) return;
  grid.innerHTML = assets.map((asset) => `<div class="file-card" data-asset-id="${escapeHtml(asset.id)}"><div class="file-icon">${escapeHtml(assetIcon(asset.category))}</div><b>${escapeHtml(asset.title)}</b><span>${escapeHtml(asset.category)} · ${asset.status === "published" ? "已发布" : "待审核"} · ${escapeHtml(asset.version)}</span><button class="btn" data-publish-asset>${asset.status === "published" ? "已发布" : "发布"}</button></div>`).join("");
  const total = qsa<HTMLElement>("#knowledge .dense-card b");
  if (total[0]) total[0].textContent = String(assets.length);
  if (total[1]) total[1].textContent = String(assets.filter((item) => item.status !== "published").length);
  qsa<HTMLButtonElement>("[data-publish-asset]", grid).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void publishAsset(button.closest<HTMLElement>(".file-card")?.dataset.assetId || "");
    });
  });
}

async function publishAsset(id: string) {
  const asset = state.knowledgeAssets.find((item) => item.id === id);
  if (!asset || asset.status === "published") {
    toast("资料已经是发布状态");
    return;
  }
  try {
    const result = await api<{ asset: KnowledgeAsset }>(`/api/knowledge/assets/${id}/publish`, { method: "PATCH" });
    Object.assign(asset, result.asset);
    renderKnowledge(state.knowledgeAssets);
    renderDashboardKnowledgePanels();
    toast("资料已发布");
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布失败", "error");
  }
}

function openKnowledgeModal() {
  openModal("上传资料", `
    <div class="form-grid">
      <div class="form-field full"><label>资料标题</label><input id="assetTitleInput" value="新品参数说明"></div>
      <div class="form-field"><label>资料类目</label><select id="assetCategoryInput"><option>产品知识</option><option>认证资料</option><option>报价规则</option><option>销售 SOP</option></select></div>
      <div class="form-field"><label>版本</label><input id="assetVersionInput" value="v1"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveAssetButton">上传资料</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveAssetButton")?.addEventListener("click", () => void saveAsset());
}

async function saveAsset() {
  const title = qs<HTMLInputElement>("#assetTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写资料标题", "error");
    return;
  }
  const result = await api<{ asset: KnowledgeAsset }>("/api/knowledge/assets", {
    method: "POST",
    body: JSON.stringify({
      title,
      category: qs<HTMLSelectElement>("#assetCategoryInput")?.value || "产品知识",
      version: qs<HTMLInputElement>("#assetVersionInput")?.value || "v1"
    })
  });
  state.knowledgeAssets.unshift(result.asset);
  renderKnowledge(state.knowledgeAssets);
  renderDashboardKnowledgePanels();
  closeModal();
  toast("资料已上传");
}

function assetIcon(category: string) {
  if (category.includes("报价")) return "XLS";
  if (category.includes("认证")) return "DOC";
  return "PDF";
}

function examStatusText(status: string) {
  if (status === "published") return "发布";
  if (status === "draft") return "草稿";
  return "排期";
}

function examStatusTone(status: string) {
  if (status === "published") return "green";
  if (status === "draft") return "amber";
  return "";
}

function examTargetText(targetRole?: string) {
  if (targetRole === "manager") return "主管必考";
  if (targetRole === "all") return "全员必考";
  return "销售必考";
}

function difficultyTone(difficulty: string) {
  if (difficulty === "hard") return "red";
  if (difficulty === "easy") return "green";
  return "amber";
}

function correctIndexesForQuestion(question: ExamQuestion) {
  return [...new Set(question.answerIndexes?.length ? question.answerIndexes : [question.answerIndex])].sort((left, right) => left - right);
}

function questionTypeText(question: ExamQuestion) {
  return question.questionType === "multiple" || correctIndexesForQuestion(question).length > 1 ? "多选" : "单选";
}

function renderExams(exams: Exam[]) {
  const list = qs<HTMLElement>("#exam .exam-sidebar .category-list");
  if (!list) return;
  syncTrainingManagementUi();
  const canManage = canManageTrainingUi();
  const report = state.examReport;
  const activeExam = exams.find((item) => item.id === state.selectedExamId) || exams[0];
  state.selectedExamId = activeExam?.id || null;
  state.selectedExamIds = state.selectedExamIds.filter((id) => exams.some((exam) => exam.id === id));
  const selectedCount = state.selectedExamIds.length;
  const allSelected = exams.length > 0 && selectedCount === exams.length;
  list.innerHTML = exams.length ? `
    ${canManage ? `<div class="exam-bulk-bar">
      <label class="exam-select-all"><input type="checkbox" data-select-all-exams ${allSelected ? "checked" : ""}>全选</label>
      <span>已选 ${selectedCount} 场</span>
      <button class="btn danger" data-bulk-delete-exams ${selectedCount ? "" : "disabled"}>批量删除</button>
    </div>` : ""}
    ${exams.map((exam) => {
      const checked = state.selectedExamIds.includes(exam.id);
      return `
        <div class="category-item exam-row ${exam.id === state.selectedExamId ? "selected" : ""} ${checked ? "checked" : ""}" data-exam-id="${escapeHtml(exam.id)}">
          ${canManage ? `<label class="exam-row-check" title="选择考试"><input type="checkbox" data-select-exam ${checked ? "checked" : ""}></label>` : ""}
          <div class="exam-row-main"><b>${escapeHtml(exam.title)}</b><span>${exam.questionCount} 题 · ${exam.passScore || 80} 分及格 · ${escapeHtml(exam.category)} · ${examTargetText(exam.targetRole)}</span></div>
          <div class="exam-actions">${badge(examStatusText(exam.status), examStatusTone(exam.status))}<button class="btn" data-start-exam>考试</button>${canManage ? `<button class="btn" data-question-bank>题库</button><button class="btn" data-publish-exam>发布</button><button class="btn danger" data-delete-exam>删除</button>` : ""}</div>
        </div>`;
    }).join("")}` : `<div class="empty-state"><b>暂无考试</b><span>点击发布考试或分类目考试维护创建第一套题。</span></div>`;
  const cards = qsa<HTMLElement>("#exam .dense-card");
  const values = [
    { label: "进行中考试", value: String(exams.filter((item) => item.status !== "draft").length), note: `${exams.filter((item) => item.status === "published").length} 场已发布` },
    { label: "题库总量", value: String(report?.questionCount || exams.reduce((sum, item) => sum + item.questionCount, 0)), note: "来自真实题库" },
    { label: "平均通过率", value: `${Math.round(exams.reduce((sum, item) => sum + item.passRate, 0) / Math.max(exams.length, 1))}%`, note: `均分 ${report?.averageScore || 0}` },
    { label: "需补考人数", value: String(report?.retakeAttempts || 0), note: "按未通过记录" }
  ];
  cards.forEach((card, index) => {
    const item = values[index];
    if (item) card.innerHTML = `<span>${item.label}</span><b>${item.value}</b><small>${item.note}</small>`;
  });
  renderExamPreview(activeExam);
  renderExamReport();
  qsa<HTMLElement>(".category-item", list).forEach((row) => {
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button,input,label")) return;
      state.selectedExamId = row.dataset.examId || null;
      renderExams(state.exams);
    });
  });
  if (canManage) {
    qs<HTMLInputElement>("[data-select-all-exams]", list)?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      state.selectedExamIds = checked ? state.exams.map((exam) => exam.id) : [];
      renderExams(state.exams);
    });
    qsa<HTMLInputElement>("[data-select-exam]", list).forEach((checkbox) => {
      checkbox.addEventListener("change", (event) => {
        event.stopPropagation();
        const id = checkbox.closest<HTMLElement>(".category-item")?.dataset.examId || "";
        if (!id) return;
        state.selectedExamIds = checkbox.checked
          ? Array.from(new Set([...state.selectedExamIds, id]))
          : state.selectedExamIds.filter((selectedId) => selectedId !== id);
        renderExams(state.exams);
      });
    });
    qs<HTMLButtonElement>("[data-bulk-delete-exams]", list)?.addEventListener("click", (event) => {
      event.stopPropagation();
      void bulkDeleteExams();
    });
  }
  qsa<HTMLButtonElement>("[data-start-exam]", list).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void openExamModal(button.closest<HTMLElement>(".category-item")?.dataset.examId || "");
    });
  });
  qsa<HTMLButtonElement>("[data-question-bank]", list).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void openQuestionBankPage(button.closest<HTMLElement>(".category-item")?.dataset.examId || "");
    });
  });
  qsa<HTMLButtonElement>("[data-publish-exam]", list).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void publishExam(button.closest<HTMLElement>(".category-item")?.dataset.examId || "");
    });
  });
  qsa<HTMLButtonElement>("[data-delete-exam]", list).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteExam(button.closest<HTMLElement>(".category-item")?.dataset.examId || "");
    });
  });
}

async function renderExamPreview(exam?: Exam) {
  const paper = qs<HTMLElement>("#exam .exam-grid > .panel .exam-paper");
  const headBadge = qs<HTMLElement>("#exam .exam-grid > .panel .section-head .badge");
  const progressPanel = qs<HTMLElement>("#exam .exam-sidebar .panel:first-child");
  if (!paper) return;
  if (!exam) {
    paper.innerHTML = `<div class="empty-state"><b>暂无考试预览</b><span>创建考试后这里会展示真实题目。</span></div>`;
    return;
  }
  try {
    const detail = await api<{ exam: Exam; questions: ExamQuestion[]; latestAttempt: ExamAttempt | null; report: ExamReport }>(`/api/exams/${exam.id}/detail`);
    Object.assign(exam, detail.exam);
    state.examReport = detail.report;
    const answered = detail.latestAttempt?.totalQuestions || 0;
    const correct = detail.latestAttempt?.correctCount || 0;
    if (headBadge) headBadge.textContent = `${detail.exam.durationMinutes || 20} 分钟 · ${detail.exam.passScore || 80} 分及格`;
    paper.innerHTML = detail.questions.length ? detail.questions.slice(0, 4).map((question, index) => `
      <div class="question-card" data-preview-question="${escapeHtml(question.id)}">
        <div class="question-meta"><span>${escapeHtml(question.category)} · ${questionTypeText(question)}</span>${badge(question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用", difficultyTone(question.difficulty))}</div>
        <h3>${index + 1}. ${escapeHtml(question.stem)}</h3>
        <div class="option-row">${question.options.map((option, optionIndex) => `<span class="${correctIndexesForQuestion(question).includes(optionIndex) ? "active" : ""}">${String.fromCharCode(65 + optionIndex)}. ${escapeHtml(option)}</span>`).join("")}</div>
      </div>`).join("") : `<div class="empty-state"><b>题库为空</b><span>点击题库维护添加产品知识题。</span></div>`;
    if (progressPanel) {
      progressPanel.innerHTML = `
        <div class="progress-ring" style="background:conic-gradient(var(--brand) 0 ${detail.exam.passRate}%, #e7edf6 ${detail.exam.passRate}% 100%)"><b>${detail.exam.passRate}%</b></div>
        <div class="section-head"><div class="section-title"><div><h2>考试进度</h2><span>${escapeHtml(detail.exam.title)}</span></div></div>${badge(`${detail.exam.questionCount} 题`, "")}</div>
        <table class="mini-table"><tbody><tr><td>最近已答</td><td>${answered}/${detail.exam.questionCount}</td></tr><tr><td>最近正确</td><td>${correct}</td></tr><tr><td>及格线</td><td>${detail.exam.passScore || 80} 分</td></tr><tr><td>最近成绩</td><td>${detail.latestAttempt ? `${detail.latestAttempt.score} 分` : "未参加"}</td></tr></tbody></table>`;
    }
  } catch (error) {
    paper.innerHTML = `<div class="empty-state"><b>考试预览加载失败</b><span>${escapeHtml(error instanceof Error ? error.message : "请稍后重试")}</span></div>`;
  }
}

function renderExamReport() {
  const report = state.examReport;
  const sections = qsa<HTMLElement>("#exam .matrix-grid .panel");
  if (!report || sections.length < 3) return;
  const [stats, retakes, types] = sections;
  const statBody = qs<HTMLElement>("tbody", stats);
  if (statBody) {
    statBody.innerHTML = report.categoryRows.length ? report.categoryRows.slice(0, 5).map((row) => `<tr><td>${escapeHtml(row.title)}</td><td>${row.participants}</td><td>${row.passRate}%</td><td>${row.avgScore}</td></tr>`).join("") : `<tr><td colspan="4">暂无成绩记录</td></tr>`;
  }
  const retakeBody = qs<HTMLElement>("tbody", retakes);
  if (retakeBody) {
    const rows = report.latestAttempts.filter((item) => !item.passed).slice(0, 5);
    retakeBody.innerHTML = rows.length ? rows.map((attempt) => `<tr><td>${escapeHtml(attempt.userName || "未知")}</td><td>${escapeHtml(attempt.category || "未分类")}</td><td>${badge(`${attempt.score} 分 · 待补考`, "red")}</td></tr>`).join("") : `<tr><td colspan="3">暂无补考人员</td></tr>`;
  }
  const typeBody = qs<HTMLElement>("tbody", types);
  if (typeBody) {
    typeBody.innerHTML = report.difficultyRows.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${row.count}</td><td>${row.ratio}%</td></tr>`).join("");
  }
}

async function openExamModal(id: string) {
  const exam = state.exams.find((item) => item.id === id) || state.exams[0];
  if (!exam) return;
  const detail = await api<{ exam: Exam; questions: ExamQuestion[]; latestAttempt: ExamAttempt | null; report: ExamReport }>(`/api/exams/${exam.id}/detail`);
  state.examReport = detail.report;
  openModal(`${detail.exam.title} · 在线考试`, `
    <div class="exam-modal-summary">
      <span>${escapeHtml(detail.exam.category)}</span><span>${detail.exam.questionCount} 题</span><span>${detail.exam.durationMinutes || 20} 分钟</span><span>${detail.exam.passScore || 80} 分及格</span>
    </div>
    <div class="exam-paper exam-paper-live">
      ${detail.questions.map((question, index) => `
        <div class="question-card" data-question="${escapeHtml(question.id)}">
          <div class="question-meta"><span>${escapeHtml(question.category)} · ${questionTypeText(question)}</span>${badge(question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用", difficultyTone(question.difficulty))}</div>
          <h3>${index + 1}. ${escapeHtml(question.stem)}</h3>
          <div class="option-row" data-question-type="${question.questionType || (correctIndexesForQuestion(question).length > 1 ? "multiple" : "single")}">${question.options.map((option, optionIndex) => `<span data-option-index="${optionIndex}" ${correctIndexesForQuestion(question).includes(optionIndex) ? "data-correct=\"true\"" : ""}>${String.fromCharCode(65 + optionIndex)}. ${escapeHtml(option)}</span>`).join("")}</div>
          <small class="question-explain">解析：${escapeHtml(question.explanation)}</small>
        </div>`).join("")}
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="submitExamButton">交卷判分</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qsa<HTMLElement>("#appModal [data-question] .option-row span").forEach((option) => {
    option.addEventListener("click", () => {
      const row = option.parentElement!;
      if ((row as HTMLElement).dataset.questionType === "multiple") {
        option.classList.toggle("active");
        return;
      }
      qsa<HTMLElement>("span", row).forEach((item) => item.classList.remove("active"));
      option.classList.add("active");
    });
  });
  qs("#submitExamButton")?.addEventListener("click", () => void submitExam(exam.id));
}

async function submitExam(id: string) {
  const answers: Record<string, number | number[]> = {};
  qsa<HTMLElement>("#appModal [data-question]").forEach((question) => {
    const optionRow = qs<HTMLElement>(".option-row", question);
    const active = qsa<HTMLElement>(".option-row span.active", question);
    if (!active.length) return;
    const selected = active.map((item) => Number(item.dataset.optionIndex || 0));
    answers[question.dataset.question || ""] = optionRow?.dataset.questionType === "multiple" ? selected : selected[0];
  });
  const total = qsa<HTMLElement>("#appModal [data-question]").length;
  if (Object.keys(answers).length < total) {
    toast("还有题目未作答", "error");
    return;
  }
  const result = await api<{ attempt: ExamAttempt; exam: Exam; report: ExamReport }>(`/api/exams/${id}/submit`, {
    method: "POST",
    body: JSON.stringify({ answers })
  });
  const exam = state.exams.find((item) => item.id === id);
  if (exam) Object.assign(exam, result.exam);
  state.examReport = result.report;
  renderExams(state.exams);
  closeModal();
  toast(`交卷成功：${result.attempt.score} 分，${result.attempt.passed ? "已通过" : "需补考"}`);
}

async function publishExam(id: string) {
  const exam = state.exams.find((item) => item.id === id);
  if (!exam) return;
  if (exam.status === "published" && !window.confirm("该考试已经发布，是否重新发布并刷新状态？")) return;
  if (exam.status !== "published" && !window.confirm(`确认发布「${exam.title}」？发布后销售即可参加考试。`)) return;
  const publishButton = qs<HTMLButtonElement>(`#exam [data-exam-id="${CSS.escape(id)}"] [data-publish-exam]`);
  try {
    if (publishButton) {
      publishButton.disabled = true;
      publishButton.textContent = "发布中";
    }
    const result = await api<{ exam: Exam; report: ExamReport }>(`/api/exams/${id}/publish`, { method: "PATCH" });
    Object.assign(exam, result.exam);
    state.examReport = result.report;
    renderExams(state.exams);
    renderDashboardKnowledgePanels();
    toast("考试已发布");
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布失败", "error");
  } finally {
    if (publishButton) {
      publishButton.disabled = false;
      publishButton.textContent = "发布";
    }
  }
}

async function deleteExam(id: string) {
  const exam = state.exams.find((item) => item.id === id);
  if (!exam) return;
  if (!window.confirm(`确认删除「${exam.title}」？删除后会同步清理组卷关系和考试成绩记录。`)) return;
  const deleteButton = qs<HTMLButtonElement>(`#exam [data-exam-id="${CSS.escape(id)}"] [data-delete-exam]`);
  try {
    if (deleteButton) {
      deleteButton.disabled = true;
      deleteButton.textContent = "删除中";
    }
    const result = await api<{ exam: Exam; exams: Exam[]; report: ExamReport }>(`/api/exams/${id}`, { method: "DELETE" });
    state.exams = result.exams;
    state.examReport = result.report;
    state.selectedExamIds = state.selectedExamIds.filter((selectedId) => selectedId !== id);
    state.selectedExamId = state.exams[0]?.id || null;
    renderExams(state.exams);
    renderDashboardKnowledgePanels();
    toast(`考试已删除：${result.exam.title}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除考试失败", "error");
  } finally {
    if (deleteButton) {
      deleteButton.disabled = false;
      deleteButton.textContent = "删除";
    }
  }
}

async function bulkDeleteExams() {
  const ids = state.selectedExamIds.filter((id) => state.exams.some((exam) => exam.id === id));
  if (!ids.length) {
    toast("请先勾选要删除的考试", "error");
    return;
  }
  const titles = state.exams.filter((exam) => ids.includes(exam.id)).map((exam) => exam.title);
  if (!window.confirm(`确认批量删除 ${ids.length} 场考试？\n${titles.slice(0, 5).join("、")}${titles.length > 5 ? "等" : ""}\n删除后会同步清理组卷关系和考试成绩记录。`)) return;
  const button = qs<HTMLButtonElement>("#exam [data-bulk-delete-exams]");
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "删除中";
    }
    const result = await api<{ deleted: Exam[]; exams: Exam[]; report: ExamReport }>("/api/exams/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
    state.exams = result.exams;
    state.examReport = result.report;
    state.selectedExamIds = [];
    state.selectedExamId = state.exams.find((exam) => exam.id === state.selectedExamId)?.id || state.exams[0]?.id || null;
    renderExams(state.exams);
    renderDashboardKnowledgePanels();
    toast(`已批量删除 ${result.deleted.length} 场考试`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "批量删除考试失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "批量删除";
    }
  }
}

function questionTagsText(question: ExamQuestion) {
  return (question.tags || []).join("、") || "未打标签";
}

function selectedQuestionIdsFromModal() {
  return qsa<HTMLInputElement>("#examQuestionPicker input[data-question-id]:checked").map((input) => input.dataset.questionId || "").filter(Boolean);
}

function updateExamCreateSelectionSummary() {
  const summary = qs<HTMLElement>("#examCreateSelectionSummary");
  if (!summary) return;
  const ids = selectedQuestionIdsFromModal();
  const selected = state.examQuestions.filter((question) => ids.includes(question.id));
  const multiple = selected.filter((question) => questionTypeText(question) === "多选").length;
  const hard = selected.filter((question) => question.difficulty === "hard").length;
  summary.innerHTML = `已选 <b>${selected.length}</b> 题 · 多选 ${multiple} 题 · 高阶 ${hard} 题`;
}

function renderExamQuestionPicker(filterCategory = "") {
  const picker = qs<HTMLElement>("#examQuestionPicker");
  if (!picker) return;
  const questions = filterCategory ? state.examQuestions.filter((question) => question.category === filterCategory) : state.examQuestions;
  picker.innerHTML = questions.length ? questions.map((question) => `
    <label class="exam-bank-row">
      <input type="checkbox" data-question-id="${escapeHtml(question.id)}">
      <span><b>${escapeHtml(question.stem)}</b><small>${escapeHtml(question.category)} · ${questionTypeText(question)} · ${escapeHtml(questionTagsText(question))}</small></span>
      ${badge(question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用", difficultyTone(question.difficulty))}
    </label>`).join("") : `<div class="empty-state"><b>当前筛选下没有题目</b><span>请先在基础题库维护中新增或导入题目。</span></div>`;
  qsa<HTMLInputElement>("input[data-question-id]", picker).forEach((input) => input.addEventListener("change", updateExamCreateSelectionSummary));
  updateExamCreateSelectionSummary();
}

async function ensureExamQuestionsLoaded() {
  const result = await api<{ questions: ExamQuestion[]; report: ExamReport }>("/api/exam-questions");
  state.examQuestions = result.questions;
  state.examReport = result.report;
  return result.questions;
}

async function openExamCreateModal(category = "产品知识") {
  await ensureExamQuestionsLoaded();
  const categories = Array.from(new Set([...state.examQuestions.map((question) => question.category), category, "产品知识", "认证资料", "报价规则", "仪表产品"]));
  openModal("发布考试 · 勾选题目组卷", `
    <div class="form-grid exam-create-grid">
      <div class="form-field full"><label>考试名称</label><input id="examTitleInput" value="${escapeHtml(category)}新品知识抽考"></div>
      <div class="form-field"><label>类目</label><select id="examCategoryInput">${categories.map((item) => `<option ${item === category ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></div>
      <div class="form-field"><label>考试时长</label><input id="examDurationInput" type="number" value="20" min="5" max="180"></div>
      <div class="form-field"><label>及格分</label><input id="examPassInput" type="number" value="80" min="1" max="100"></div>
      <div class="form-field"><label>适用对象</label><select id="examRoleInput"><option value="sales">销售必考</option><option value="manager">主管必考</option><option value="all">全员必考</option></select></div>
      <div class="form-field full"><label>从基础题库勾选试题</label><div class="exam-bank-toolbar"><span id="examCreateSelectionSummary">已选 0 题</span><button class="btn" type="button" id="selectCategoryQuestionsButton">选中当前类目</button></div><div class="exam-bank-list" id="examQuestionPicker"></div></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveExamButton">创建考试</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  renderExamQuestionPicker(category);
  qs<HTMLSelectElement>("#examCategoryInput")?.addEventListener("change", (event) => renderExamQuestionPicker((event.currentTarget as HTMLSelectElement).value));
  qs<HTMLButtonElement>("#selectCategoryQuestionsButton")?.addEventListener("click", () => {
    qsa<HTMLInputElement>("#examQuestionPicker input[data-question-id]").forEach((input) => { input.checked = true; });
    updateExamCreateSelectionSummary();
  });
  qs("#saveExamButton")?.addEventListener("click", (event) => void saveExam(event.currentTarget as HTMLButtonElement));
}

async function saveExam(button?: HTMLButtonElement) {
  const title = qs<HTMLInputElement>("#examTitleInput")?.value.trim() || "";
  const questionIds = selectedQuestionIdsFromModal();
  if (!title) {
    toast("请填写考试名称", "error");
    return;
  }
  if (!questionIds.length) {
    toast("请至少勾选 1 道题目", "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "创建中";
    }
    const result = await api<{ exam: Exam; questions: ExamQuestion[]; report: ExamReport }>("/api/exams", {
      method: "POST",
      body: JSON.stringify({
        title,
        category: qs<HTMLSelectElement>("#examCategoryInput")?.value || "产品知识",
        questionIds,
        durationMinutes: Number(qs<HTMLInputElement>("#examDurationInput")?.value || 20),
        passScore: Number(qs<HTMLInputElement>("#examPassInput")?.value || 80),
        targetRole: qs<HTMLSelectElement>("#examRoleInput")?.value || "sales"
      })
    });
    state.exams.unshift(result.exam);
    state.selectedExamId = result.exam.id;
    state.examReport = result.report;
    await refreshExamData();
    closeModal();
    toast(`考试已创建，已组卷 ${result.questions.length} 道题`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "创建考试失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "创建考试";
    }
  }
}

function questionBankCategories() {
  return Array.from(new Set([...state.examQuestions.map((question) => question.category), "产品知识", "认证资料", "报价规则", "仪表产品"])).filter(Boolean);
}

function refreshQuestionBankCategoryOptions() {
  const categories = questionBankCategories();
  const filter = qs<HTMLSelectElement>("#questionBankCategoryFilter");
  const editor = qs<HTMLSelectElement>("#questionCategoryInput");
  const currentFilter = filter?.value || "";
  const currentEditor = editor?.value || "";
  if (filter) {
    filter.innerHTML = `<option value="">全部类目</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`;
    filter.value = categories.includes(currentFilter) ? currentFilter : "";
  }
  if (editor) {
    editor.innerHTML = categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
    editor.value = categories.includes(currentEditor) ? currentEditor : categories[0] || "产品知识";
  }
}

function filteredQuestionBankRows() {
  const category = qs<HTMLSelectElement>("#questionBankCategoryFilter")?.value || "";
  const type = qs<HTMLSelectElement>("#questionBankTypeFilter")?.value || "";
  const keyword = qs<HTMLInputElement>("#questionBankSearchInput")?.value.trim().toLowerCase() || "";
  return state.examQuestions.filter((question) => {
    const matchesCategory = !category || question.category === category;
    const matchesType = !type || (question.questionType || (correctIndexesForQuestion(question).length > 1 ? "multiple" : "single")) === type;
    const haystack = `${question.stem} ${question.category} ${questionTagsText(question)} ${question.options.join(" ")}`.toLowerCase();
    return matchesCategory && matchesType && (!keyword || haystack.includes(keyword));
  });
}

function renderQuestionBankStats() {
  const total = state.examQuestions.length;
  const multi = state.examQuestions.filter((question) => questionTypeText(question) === "多选").length;
  const categories = questionBankCategories().filter((category) => state.examQuestions.some((question) => question.category === category));
  const selected = state.examQuestions.find((question) => question.id === state.selectedQuestionId);
  const totalCard = qs<HTMLElement>("#questionBankTotalCard");
  const multiCard = qs<HTMLElement>("#questionBankMultiCard");
  const categoryCard = qs<HTMLElement>("#questionBankCategoryCard");
  const selectedCard = qs<HTMLElement>("#questionBankSelectedCard");
  if (totalCard) totalCard.innerHTML = `<span>题库总量</span><b>${total}</b><small>真实基础题库</small>`;
  if (multiCard) multiCard.innerHTML = `<span>多选题</span><b>${multi}</b><small>${Math.round((multi / Math.max(total, 1)) * 100)}% 占比</small>`;
  if (categoryCard) categoryCard.innerHTML = `<span>类目数</span><b>${categories.length}</b><small>产品知识分类</small>`;
  if (selectedCard) selectedCard.innerHTML = `<span>当前题目</span><b>${selected ? questionTypeText(selected) : "未选择"}</b><small>${selected ? escapeHtml(selected.category) : "点击列表编辑"}</small>`;
}

function renderQuestionBankRows(_questions = state.examQuestions) {
  const list = qs<HTMLElement>("#questionBankList");
  if (!list) return;
  refreshQuestionBankCategoryOptions();
  if (!state.selectedQuestionId && state.examQuestions.length) state.selectedQuestionId = state.examQuestions[0].id;
  const filtered = filteredQuestionBankRows();
  if (state.selectedQuestionId !== "__new__" && !filtered.some((question) => question.id === state.selectedQuestionId) && filtered[0]) state.selectedQuestionId = filtered[0].id;
  list.innerHTML = filtered.length ? filtered.map((question, index) => `
    <article class="question-bank-row ${question.id === state.selectedQuestionId ? "active" : ""}" data-bank-question="${escapeHtml(question.id)}">
      <div class="question-bank-row-meta"><span>#${index + 1}</span>${badge(questionTypeText(question), questionTypeText(question) === "多选" ? "amber" : "")}${badge(question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用", difficultyTone(question.difficulty))}</div>
      <h3>${escapeHtml(question.stem)}</h3>
      <div class="question-bank-row-foot"><span>${escapeHtml(question.category)}</span><span>${escapeHtml(questionTagsText(question))}</span><span>${question.options.length} 个选项</span></div>
    </article>`).join("") : `<div class="empty-state"><b>暂无匹配题目</b><span>可以调整筛选条件，或点击新增题目。</span></div>`;
  qsa<HTMLElement>("[data-bank-question]", list).forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedQuestionId = row.dataset.bankQuestion || null;
      renderQuestionBankRows(state.examQuestions);
      fillQuestionEditor(state.examQuestions.find((question) => question.id === state.selectedQuestionId));
    });
  });
  renderQuestionBankStats();
  fillQuestionEditor(state.selectedQuestionId === "__new__" ? undefined : state.examQuestions.find((question) => question.id === state.selectedQuestionId));
}

function emptyQuestionDraft(): ExamQuestion {
  return {
    id: "",
    examId: "bank",
    stem: "客户询问仪表量程时，销售应优先确认哪些参数？",
    category: "仪表产品",
    options: ["量程、精度、接口、工况", "客户公司规模", "包装颜色", "输出信号、供电和防护等级"],
    answerIndex: 0,
    answerIndexes: [0, 3],
    questionType: "multiple",
    tags: ["仪表", "技术参数"],
    explanation: "仪表类产品报价必须先确认量程、精度、接口和实际工况，避免型号匹配错误。",
    difficulty: "medium"
  };
}

function fillQuestionEditor(question?: ExamQuestion) {
  const draft = question || emptyQuestionDraft();
  const hint = qs<HTMLElement>("#questionEditorHint");
  if (hint) hint.textContent = question ? `正在编辑：${draft.category} · ${questionTypeText(draft)}` : "新增题目，保存后进入基础题库";
  const stem = qs<HTMLTextAreaElement>("#questionStemInput");
  if (stem) stem.value = draft.stem;
  refreshQuestionBankCategoryOptions();
  const category = qs<HTMLSelectElement>("#questionCategoryInput");
  if (category) category.value = draft.category;
  const type = qs<HTMLSelectElement>("#questionTypeInput");
  if (type) type.value = draft.questionType || (correctIndexesForQuestion(draft).length > 1 ? "multiple" : "single");
  qsa<HTMLInputElement>(".question-option-input").forEach((input, index) => { input.value = draft.options[index] || ""; });
  const answer = qs<HTMLInputElement>("#questionAnswerInput");
  if (answer) answer.value = correctIndexesForQuestion(draft).map((index) => String.fromCharCode(65 + index)).join(",");
  const difficulty = qs<HTMLSelectElement>("#questionDifficultyInput");
  if (difficulty) difficulty.value = draft.difficulty || "medium";
  const tags = qs<HTMLInputElement>("#questionTagsInput");
  if (tags) tags.value = questionTagsText(draft) === "未打标签" ? "" : questionTagsText(draft);
  const explain = qs<HTMLTextAreaElement>("#questionExplainInput");
  if (explain) explain.value = draft.explanation || "";
  const deleteButton = qs<HTMLButtonElement>("#deleteQuestionButton");
  if (deleteButton) deleteButton.disabled = !question;
  renderQuestionBankStats();
}

async function openQuestionBankPage(id = "") {
  await ensureExamQuestionsLoaded();
  const exam = state.exams.find((item) => item.id === id);
  const preferred = exam ? state.examQuestions.find((question) => question.category === exam.category) : null;
  state.selectedQuestionId = preferred?.id || state.selectedQuestionId || state.examQuestions[0]?.id || null;
  activateNavView("question-bank");
  renderQuestionBankRows(state.examQuestions);
}

function newQuestionDraft() {
  state.selectedQuestionId = "__new__";
  fillQuestionEditor(undefined);
  renderQuestionBankRows(state.examQuestions);
  qs<HTMLTextAreaElement>("#questionStemInput")?.focus();
}

function parseTags(value: string) {
  return value.split(/[，,、\s]+/).map((item) => item.trim()).filter(Boolean);
}

async function saveQuestion(button?: HTMLButtonElement) {
  const stem = qs<HTMLTextAreaElement>("#questionStemInput")?.value.trim() || qs<HTMLInputElement>("#questionStemInput")?.value.trim() || "";
  const options = qsa<HTMLInputElement>(".question-option-input").map((input) => input.value.trim()).filter(Boolean);
  const answerIndexes = normalizeAnswerIndexes(qs<HTMLInputElement>("#questionAnswerInput")?.value || "A");
  const questionType = qs<HTMLSelectElement>("#questionTypeInput")?.value === "multiple" || answerIndexes.length > 1 ? "multiple" : "single";
  const editingId = state.selectedQuestionId && state.selectedQuestionId !== "__new__" ? state.selectedQuestionId : "";
  if (!stem || options.length < 2) {
    toast("请填写题干和至少两个选项", "error");
    return;
  }
  if (!answerIndexes.length || answerIndexes.some((answerIndex) => answerIndex >= options.length)) {
    toast("正确答案超出选项范围", "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "保存中";
    }
    const result = await api<{ question: ExamQuestion; report: ExamReport }>(editingId ? `/api/exam-questions/${editingId}` : "/api/exam-questions", {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify({
        stem,
        category: qs<HTMLSelectElement>("#questionCategoryInput")?.value || "产品知识",
        options,
        answerIndex: answerIndexes[0],
        answerIndexes,
        questionType,
        tags: parseTags(qs<HTMLInputElement>("#questionTagsInput")?.value || ""),
        explanation: qs<HTMLTextAreaElement>("#questionExplainInput")?.value.trim() || qs<HTMLInputElement>("#questionExplainInput")?.value.trim() || "请补充解析",
        difficulty: qs<HTMLSelectElement>("#questionDifficultyInput")?.value || "medium"
      })
    });
    if (editingId) {
      state.examQuestions = state.examQuestions.map((question) => question.id === result.question.id ? result.question : question);
    } else {
      state.examQuestions.unshift(result.question);
    }
    state.selectedQuestionId = result.question.id;
    state.examReport = result.report;
    renderQuestionBankRows(state.examQuestions);
    renderExams(state.exams);
    toast(editingId ? "题目已保存" : "题目已加入基础题库");
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存题目失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "保存题目";
    }
  }
}

function normalizeAnswerIndexes(value: unknown) {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return [0];
  const tokens = text.includes(",") || text.includes("，") || text.includes("/") || /\s/.test(text)
    ? text.split(/[,\s，/、]+/).filter(Boolean)
    : /^[A-F]{2,}$/.test(text) ? text.split("") : [text];
  const indexes = tokens.map((token) => {
    if (/^[A-F]$/.test(token)) return token.charCodeAt(0) - 65;
    const numeric = Number(token);
    return Number.isFinite(numeric) ? Math.max(0, numeric - 1) : 0;
  });
  return [...new Set(indexes)].sort((left, right) => left - right);
}

function normalizeQuestionType(value: unknown, answerIndexes: number[]): "single" | "multiple" {
  const text = String(value ?? "").trim().toLowerCase();
  if (["multiple", "multi", "多选", "多选题"].includes(text)) return "multiple";
  if (["single", "单选", "单选题"].includes(text)) return "single";
  return answerIndexes.length > 1 ? "multiple" : "single";
}

function normalizeDifficulty(value: unknown): "easy" | "medium" | "hard" {
  const text = String(value ?? "").trim().toLowerCase();
  if (["easy", "基础", "简单"].includes(text)) return "easy";
  if (["hard", "困难", "高阶"].includes(text)) return "hard";
  return "medium";
}

function rowValue(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim()) return row[key];
  }
  return "";
}

async function parseQuestionFile(file: File): Promise<ExamImportQuestion[]> {
  assertImportFile(file);
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", dense: true, sheetRows: 502 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (rows.length > 500) throw new Error("题库导入单次最多支持 500 行");
  return rows.map((row) => {
    const options = [
      rowValue(row, ["选项A", "选项 A", "A", "optionA", "Option A"]),
      rowValue(row, ["选项B", "选项 B", "B", "optionB", "Option B"]),
      rowValue(row, ["选项C", "选项 C", "C", "optionC", "Option C"]),
      rowValue(row, ["选项D", "选项 D", "D", "optionD", "Option D"])
    ].map((item) => String(item).trim()).filter(Boolean);
    const answerIndexes = normalizeAnswerIndexes(rowValue(row, ["正确答案", "答案", "answer", "Answer"]));
    return {
      stem: String(rowValue(row, ["题干", "题目", "问题", "stem", "question"])).trim(),
      category: String(rowValue(row, ["类目", "分类", "category", "Category"]) || "产品知识").trim(),
      options,
      answerIndex: answerIndexes[0] ?? 0,
      answerIndexes,
      questionType: normalizeQuestionType(rowValue(row, ["题型", "类型", "questionType", "type"]), answerIndexes),
      tags: parseTags(String(rowValue(row, ["标签", "tags", "Tags"]) || "")),
      explanation: String(rowValue(row, ["解析", "说明", "explanation", "Explanation"]) || "Excel题库导入题目，请补充解析。").trim(),
      difficulty: normalizeDifficulty(rowValue(row, ["难度", "difficulty", "Difficulty"]))
    };
  }).filter((item) => item.stem && item.options.length >= 2);
}

async function importQuestionBank(button?: HTMLButtonElement) {
  const file = qs<HTMLInputElement>("#questionImportInput")?.files?.[0];
  if (!file) {
    toast("请选择 Excel 或 CSV 题库文件", "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "导入中";
    }
    const questions = await parseQuestionFile(file);
    if (!questions.length) {
      toast("未识别到有效题目，请检查表头和选项", "error");
      return;
    }
    const result = await api<{ importedCount: number; questions: ExamQuestion[]; report: ExamReport }>("/api/exam-questions/import", {
      method: "POST",
      body: JSON.stringify({ questions })
    });
    state.examQuestions.unshift(...result.questions);
    state.examReport = result.report;
    renderQuestionBankRows(state.examQuestions);
    renderExams(state.exams);
    toast(`题库导入成功：${result.importedCount} 道题`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "题库导入失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "导入";
    }
  }
}

async function exportQuestionBank() {
  try {
    const result = await api<{ questions: ExamQuestion[] }>("/api/exam-questions/export");
    const rows = result.questions.map((question) => ({
      题干: question.stem,
      类目: question.category,
      题型: questionTypeText(question),
      标签: questionTagsText(question),
      选项A: question.options[0] || "",
      选项B: question.options[1] || "",
      选项C: question.options[2] || "",
      选项D: question.options[3] || "",
      正确答案: correctIndexesForQuestion(question).map((index) => String.fromCharCode(65 + index)).join(","),
      难度: question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用",
      解析: question.explanation
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "基础题库");
    XLSX.writeFile(workbook, `GoodJob基础题库-${Date.now()}.xlsx`);
    toast(`题库已导出：${rows.length} 道题`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "题库导出失败", "error");
  }
}

async function deleteBankQuestion(id: string) {
  if (!id) return;
  if (!window.confirm("确认删除这道题？相关考试中的引用也会同步移除。")) return;
  try {
    const result = await api<{ question: ExamQuestion; report: ExamReport }>(`/api/exam-questions/${id}`, { method: "DELETE" });
    state.examQuestions = state.examQuestions.filter((question) => question.id !== result.question.id);
    state.examReport = result.report;
    renderQuestionBankRows(state.examQuestions);
    await refreshExamData();
    toast("题目已删除");
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除题目失败", "error");
  }
}

function openExamCategoryModal() {
  const categories = Array.from(new Set([...state.exams.map((exam) => exam.category), "仪表产品", "认证资料", "报价规则"]));
  openModal("分类目考试维护", `
    <div class="form-grid">
      <div class="form-field full"><label>选择类目</label><select id="categoryExamInput">${categories.map((category) => `<option>${escapeHtml(category)}</option>`).join("")}</select></div>
      <div class="form-field"><label>默认题量</label><input id="categoryExamCountInput" type="number" value="3" min="1"></div>
      <div class="form-field"><label>及格分</label><input id="categoryExamPassInput" type="number" value="80" min="1" max="100"></div>
      <div class="form-field full"><label>命名规则</label><input id="categoryExamTitleInput" value="类目专项考试"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="createCategoryExamButton">生成分类考试</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#createCategoryExamButton")?.addEventListener("click", async () => {
    const category = qs<HTMLSelectElement>("#categoryExamInput")?.value || "产品知识";
    const titleRule = qs<HTMLInputElement>("#categoryExamTitleInput")?.value.trim() || "专项考试";
    const passValue = qs<HTMLInputElement>("#categoryExamPassInput")?.value || "80";
    closeModal();
    await openExamCreateModal(category);
    const title = qs<HTMLInputElement>("#examTitleInput");
    const pass = qs<HTMLInputElement>("#examPassInput");
    if (title) title.value = `${category}${titleRule}`;
    if (pass) pass.value = passValue;
    qsa<HTMLInputElement>("#examQuestionPicker input[data-question-id]").forEach((input) => { input.checked = true; });
    updateExamCreateSelectionSummary();
  });
}

async function refreshExamData() {
  const result = await api<{ exams: Exam[]; report: ExamReport }>("/api/exams");
  state.exams = result.exams;
  state.examReport = result.report;
  state.selectedExamId = state.selectedExamId || result.exams[0]?.id || null;
  renderExams(state.exams);
  renderDashboardKnowledgePanels();
}

async function renderAccounts(user: User) {
  const tbody = qs<HTMLElement>("#settings tbody");
  if (!tbody) return;
  const canManage = user.role === "admin" || user.role === "super_admin";
  const addButton = qsa<HTMLButtonElement>("#settings .page-head .btn").find((button) => button.textContent?.includes("新增账号"));
  if (addButton) {
    addButton.disabled = !canManage;
    addButton.title = canManage ? "新增系统账号" : "只有管理员和超级管理员可以管理账号";
  }
  if (!canManage) {
    state.accounts = [user];
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>账号管理仅管理员可用</b><span>当前账号可查看授权范围说明；账号新增、停用和角色调整由管理员或超级管理员处理。</span></div></td></tr>`;
    return;
  }
  const accounts = (await api<{ accounts: User[] }>("/api/accounts")).accounts;
  state.accounts = accounts;
  tbody.innerHTML = accounts.map((account) => {
    const status = (account as User & { status?: string }).status === "disabled" ? "停用" : "启用";
    const disableAllowed = account.id !== user.id && (user.role === "super_admin" || account.role !== "super_admin");
    return `<tr data-account-id="${escapeHtml(account.id)}"><td><div class="company"><span class="avatar">${escapeHtml(account.avatar)}</span><div><b>${escapeHtml(account.name)}</b><span>${escapeHtml(account.email)}</span></div></div></td><td>${badge(roleLabel[account.role], account.role === "super_admin" ? "red" : account.role === "admin" ? "amber" : account.role === "manager" ? "green" : "")}</td><td>${accountBusinessScope(account.role)}</td><td>${accountPersonalScope(account.role)}</td><td>${badge(status, status === "停用" ? "gray" : "green")}</td><td><div class="inline-actions"><button class="btn" data-password-account ${canManageRoleInUi(account) ? "" : "disabled"}>设密码</button><button class="btn" data-disable-account ${disableAllowed ? "" : "disabled"}>${account.id === user.id ? "当前账号" : disableAllowed ? "停用" : "受保护"}</button><button class="btn danger" data-delete-account ${disableAllowed ? "" : "disabled"}>删除</button></div></td></tr>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-password-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => openPasswordModal(button.closest<HTMLElement>("tr")?.dataset.accountId || ""));
  });
  qsa<HTMLButtonElement>("[data-disable-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => void disableAccount(button.closest<HTMLElement>("tr")?.dataset.accountId || ""));
  });
  qsa<HTMLButtonElement>("[data-delete-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => void deleteAccount(button.closest<HTMLElement>("tr")?.dataset.accountId || ""));
  });
}

function canManageRoleInUi(account: User) {
  return state.user?.role === "super_admin" || account.role !== "super_admin";
}

function accountBusinessScope(role: Role) {
  if (role === "sales") return "本人业务数据";
  if (role === "manager") return "本团队业务数据";
  if (role === "admin") return "全局业务数据";
  return "全局业务数据 + 最高权限";
}

function accountPersonalScope(_role: Role) {
  return "待办/备忘仅本人";
}

function openAccountModal() {
  if (!state.user || (state.user.role !== "admin" && state.user.role !== "super_admin")) {
    toast("只有管理员和超级管理员可以新增账号", "error");
    return;
  }
  const roleOptions = [
    `<option value="sales">业务员</option>`,
    `<option value="manager">销售主管</option>`,
    `<option value="admin">管理员</option>`,
    state.user.role === "super_admin" ? `<option value="super_admin">超级管理员</option>` : ""
  ].join("");
  openModal("新增账号", `
    <div class="form-grid">
      <div class="form-field"><label>姓名</label><input id="accountNameInput" value="New Sales"></div>
      <div class="form-field"><label>角色</label><select id="accountRoleInput">${roleOptions}</select></div>
      <div class="form-field full"><label>邮箱</label><input id="accountEmailInput" value="new.sales.${Date.now()}@goodjob.com"></div>
      <div class="form-field full"><label>初始密码</label><input id="accountPasswordInput" type="password" value="goodjob123" autocomplete="new-password"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveAccountButton">保存账号</button>`);
  qs("#saveAccountButton")?.addEventListener("click", () => void saveAccount());
}

async function saveAccount() {
  if (!state.user || (state.user.role !== "admin" && state.user.role !== "super_admin")) {
    toast("无账号管理权限", "error");
    return;
  }
  const name = qs<HTMLInputElement>("#accountNameInput")?.value.trim() || "";
  const email = qs<HTMLInputElement>("#accountEmailInput")?.value.trim() || "";
  const password = qs<HTMLInputElement>("#accountPasswordInput")?.value || "";
  if (!name || !email || password.length < 6) {
    toast("请填写账号姓名、邮箱和至少 6 位密码", "error");
    return;
  }
  const result = await api<{ account: User }>("/api/accounts", {
    method: "POST",
    body: JSON.stringify({
      name,
      email,
      password,
      role: qs<HTMLSelectElement>("#accountRoleInput")?.value || "sales"
    })
  });
  state.accounts.unshift(result.account);
  await renderAccounts(state.user!);
  closeModal();
  toast("账号已新增");
}

function openPasswordModal(id: string) {
  const account = state.accounts.find((item) => item.id === id);
  if (!account) {
    toast("账号不存在", "error");
    return;
  }
  if (!canManageRoleInUi(account)) {
    toast("无权设置该账号密码", "error");
    return;
  }
  openModal("设置账号密码", `
    <div class="form-grid">
      <div class="form-field full"><label>账号</label><input value="${escapeHtml(account.email)}" disabled></div>
      <div class="form-field full"><label>新密码</label><input id="accountNewPasswordInput" type="password" value="" autocomplete="new-password" placeholder="至少 6 位"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="savePasswordButton">保存密码</button>`);
  qs("#savePasswordButton")?.addEventListener("click", () => void saveAccountPassword(id));
}

async function saveAccountPassword(id: string) {
  const password = qs<HTMLInputElement>("#accountNewPasswordInput")?.value || "";
  if (password.length < 6) {
    toast("密码至少 6 位", "error");
    return;
  }
  await api(`/api/accounts/${id}/password`, {
    method: "PATCH",
    body: JSON.stringify({ password })
  });
  closeModal();
  toast("密码已更新");
}

async function disableAccount(id: string) {
  if (!id || id === state.user?.id) {
    toast("当前登录账号不能停用", "error");
    return;
  }
  const account = state.accounts.find((item) => item.id === id);
  if (state.user?.role === "admin" && account?.role === "super_admin") {
    toast("管理员不能停用超级管理员", "error");
    return;
  }
  await api(`/api/accounts/${id}/disable`, { method: "PATCH" });
  await renderAccounts(state.user!);
  toast("账号已停用");
}

async function deleteAccount(id: string) {
  if (!id || id === state.user?.id) {
    toast("当前登录账号不能删除", "error");
    return;
  }
  const account = state.accounts.find((item) => item.id === id);
  if (!account || !canManageRoleInUi(account)) {
    toast("无权删除该账号", "error");
    return;
  }
  await api(`/api/accounts/${id}`, { method: "DELETE" });
  state.accounts = state.accounts.filter((item) => item.id !== id);
  await renderAccounts(state.user!);
  toast("账号已删除");
}

function renderOcr(job: OcrJob) {
  const fields = job.fields;
  const mapping: Record<string, string> = {
    company: "公司名",
    contact: "联系人",
    title: "职位",
    email: "邮箱",
    whatsapp: "WhatsApp",
    wechat: "微信",
    phone: "电话",
    country: "国家",
    city: "城市"
  };
  const cards = qs<HTMLElement>("#tools .ocr-fields");
  if (!cards) return;
  cards.innerHTML = Object.entries(mapping).map(([key, label]) => `<div class="field-card"><input type="checkbox" checked data-ocr-field="${escapeHtml(key)}"><div><label>${label}</label><input type="text" value="${escapeHtml(fields[key])}"></div></div>`).join("") +
    `<div class="field-card"><input type="checkbox"><div><label>标签</label><input type="text" value="LED灯具 / 欧洲进口商"></div></div>`;
  const statusRows = qsa<HTMLElement>("#tools .sync-row");
  if (statusRows[0]) statusRows[0].innerHTML = `<span>识别状态</span><b>${job.status === "synced" ? "已同步" : "完成"}</b>${badge(`${job.confidence}% 置信度`, "green")}`;
  const cardTitle = qs<HTMLElement>("#tools .business-card h2");
  if (cardTitle) cardTitle.textContent = fields.company;
  const card = qs<HTMLElement>("#tools .business-card");
  if (card) {
    card.innerHTML = `<h2>${escapeHtml(fields.company)}</h2><p>Import & Distribution</p><strong>${escapeHtml(fields.contact)}</strong><span>${escapeHtml(fields.title)}</span><span>${escapeHtml(fields.email)}</span><span>WhatsApp ${escapeHtml(fields.whatsapp)}</span><span>WeChat ${escapeHtml(fields.wechat)}</span><span>${escapeHtml(fields.city)}, ${escapeHtml(fields.country)}</span>`;
  }
}

async function recognizeOcr(overrides: Partial<Record<string, string>> = {}) {
  const result = await api<{ job: OcrJob }>("/api/tools/ocr/jobs/ocr1/recognize", {
    method: "POST",
    body: JSON.stringify({ confidence: 96, ...overrides })
  });
  state.ocrJob = result.job;
  renderOcr(result.job);
  toast("名片已识别");
}

function collectOcrFields() {
  const fields: Record<string, string> = {};
  qsa<HTMLInputElement>("#tools .field-card input[data-ocr-field]").forEach((checkbox) => {
    if (!checkbox.checked) return;
    const key = checkbox.dataset.ocrField;
    const input = checkbox.parentElement?.querySelector<HTMLInputElement>("input[type='text']");
    if (key && input) fields[key] = input.value;
  });
  return fields;
}

function renderAiConfig(config: AiModelConfig | null) {
  const selected = state.aiDraftMode ? null : (state.aiConfigs.find((item) => item.id === state.selectedAiConfigId) || config || state.aiConfigs[0] || null);
  config = selected;
  if (!state.aiDraftMode) {
    state.selectedAiConfigId = selected?.id || null;
    if (selected) state.aiConfig = selected;
  }
  const name = qs<HTMLInputElement>("#aiConfigName");
  const baseUrl = qs<HTMLInputElement>("#aiBaseUrlInput");
  const model = qs<HTMLInputElement>("#aiModelInput");
  const apiKey = qs<HTMLInputElement>("#aiApiKeyInput");
  const enabled = qs<HTMLInputElement>("#aiEnabledInput");
  const useAi = qs<HTMLInputElement>("#websiteUseAiInput");
  const badgeNode = qs<HTMLElement>("#aiConfigBadge");
  const gptName = qs<HTMLInputElement>("#gptConfigName");
  const gptBaseUrl = qs<HTMLInputElement>("#gptBaseUrlInput");
  const gptModel = qs<HTMLInputElement>("#gptModelInput");
  const gptApiKey = qs<HTMLInputElement>("#gptApiKeyInput");
  const gptEnabled = qs<HTMLSelectElement>("#gptEnabledSelect");
  const providerSelect = qs<HTMLSelectElement>("#gptProviderSelect");
  const protocolSelect = qs<HTMLSelectElement>("#gptProtocolSelect");
  const temperatureInput = qs<HTMLInputElement>("#gptTemperatureInput");
  const gptBadge = qs<HTMLElement>("#gptConfigBadge");
  const gptConnectionBadge = qs<HTMLElement>("#gptConnectionBadge");
  const gptConnectionTitle = qs<HTMLElement>("#gptConnectionTitle");
  const gptConnectionText = qs<HTMLElement>("#gptConnectionText");
  const gptState = qs<HTMLElement>("#gptConfigState");
  const gptSub = qs<HTMLElement>("#gptConfigSub");
  const gptModelState = qs<HTMLElement>("#gptModelState");
  const providerState = qs<HTMLElement>("#gptProviderState");
  const protocolState = qs<HTMLElement>("#gptProtocolState");
  const useState = qs<HTMLElement>("#gptUseState");
  const countText = qs<HTMLElement>("#aiConfigCountText");
  const list = qs<HTMLElement>("#aiConfigList");
  const modeAlert = qs<HTMLElement>("#aiConfigModeAlert");
  const deleteButton = qs<HTMLButtonElement>("#aiDeleteConfigButton");
  const toggleButton = qs<HTMLButtonElement>("#aiToggleEnabledButton");
  const draftMode = state.aiDraftMode;
  const defaultName = "";
  const defaultBaseUrl = "";
  const defaultModel = "";
  const provider = draftMode ? (providerSelect?.value || "openai") : (config?.provider || "openai");
  const preset = aiProviderPresets[provider] || aiProviderPresets.openai;
  const protocol = draftMode ? ((protocolSelect?.value as AiModelConfig["protocol"]) || preset.protocol) : (config?.protocol || preset.protocol);
  const ready = Boolean(config?.enabled && config?.hasApiKey);
  const tested = config?.lastTestStatus === "passed";
  const failed = config?.lastTestStatus === "failed";
  const useFlags = {
    leadFinder: config?.useLeadFinder ?? true,
    websiteParse: config?.useWebsiteParse ?? true,
    scoring: config?.useScoring ?? true,
    emailDraft: config?.useEmailDraft ?? true,
    exam: config?.useExam ?? false
  };
  const useCount = Object.values(useFlags).filter(Boolean).length;
  if (countText) countText.textContent = `${state.aiConfigs.length} 个配置实例`;
  if (list) {
    const draftRow = state.aiDraftMode ? `
      <button class="ai-instance-row active is-draft" type="button" data-ai-draft-row>
        <span><b>未保存的新配置</b><small>填写参数后点击保存，系统会创建独立实例</small></span>
        <em>${badge("新增", "amber")}</em>
      </button>
    ` : "";
    const savedRows = state.aiConfigs.map((item) => {
      const itemPreset = aiProviderPresets[item.provider] || aiProviderPresets.custom;
      const itemUseCount = [item.useLeadFinder, item.useWebsiteParse, item.useScoring, item.useEmailDraft, item.useExam].filter(Boolean).length;
      const active = !state.aiDraftMode && item.id === state.selectedAiConfigId;
      return `
        <button class="ai-instance-row ${active ? "active" : ""}" type="button" data-ai-config-id="${escapeHtml(item.id)}">
          <span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(itemPreset.label)} · ${escapeHtml(item.model)} · ${itemUseCount} 个用途</small></span>
          <em>${badge(item.enabled ? "启用" : "停用", item.enabled ? "green" : "gray")}${badge(item.hasApiKey ? "有Key" : "缺Key", item.hasApiKey ? "green" : "amber")}</em>
        </button>
      `;
    }).join("");
    list.innerHTML = draftRow || savedRows ? `${draftRow}${savedRows}` : `<div class="empty-cell">暂无配置，点击“新增配置”。</div>`;
    qsa<HTMLButtonElement>("#aiConfigList [data-ai-config-id]").forEach((button) => {
      button.addEventListener("click", () => {
        state.aiDraftMode = false;
        state.pendingAiDeleteId = null;
        state.selectedAiConfigId = button.dataset.aiConfigId || null;
        renderAiConfig(state.aiConfigs.find((item) => item.id === state.selectedAiConfigId) || null);
      });
    });
  }
  if (modeAlert) {
    modeAlert.innerHTML = state.pendingAiDeleteId && state.pendingAiDeleteId === config?.id
      ? `<b>确认删除</b><span>将删除“${escapeHtml(config.name)}”，再次点击“确认删除”才会执行。</span>`
      : state.aiDraftMode
      ? `<b>新增配置</b><span>当前内容尚未保存，不会影响已有配置；保存后生成独立实例。</span>`
      : config
        ? `<b>编辑配置</b><span>${escapeHtml(config.name)} · 修改后点击保存，应用范围和启用状态会持久化。</span>`
        : `<b>暂无配置</b><span>点击“新增配置”创建第一套模型参数。</span>`;
  }
  if (deleteButton) {
    deleteButton.disabled = state.aiDraftMode || !config;
    deleteButton.textContent = state.pendingAiDeleteId && state.pendingAiDeleteId === config?.id ? "确认删除" : "删除当前";
  }
  if (toggleButton) {
    toggleButton.disabled = state.aiDraftMode || !config;
    toggleButton.textContent = config?.enabled ? "停用当前" : "启用当前";
  }
  if (name && !draftMode) name.value = config?.name || defaultName;
  if (baseUrl && !draftMode) baseUrl.value = config?.baseUrl || defaultBaseUrl;
  if (model && !draftMode) model.value = config?.model || defaultModel;
  if (apiKey && !draftMode) {
    apiKey.value = config?.apiKey || "";
    apiKey.placeholder = config?.hasApiKey ? "已保存，重新填写可覆盖" : "保存后仅后端持久化";
  }
  if (enabled && !draftMode) enabled.checked = Boolean(config?.enabled);
  if (useAi) useAi.checked = Boolean(config?.enabled && config?.hasApiKey && useFlags.websiteParse);
  if (badgeNode) {
    badgeNode.className = `badge ${ready ? "green" : config?.enabled ? "amber" : ""}`;
    badgeNode.textContent = ready ? `AI已启用 · ${config?.model}` : config?.enabled ? "规则解析 · 缺少API Key" : "规则解析";
  }
  if (gptName && !draftMode) gptName.value = config?.name || defaultName;
  if (gptBaseUrl && !draftMode) gptBaseUrl.value = config?.baseUrl || defaultBaseUrl;
  if (gptModel && !draftMode) gptModel.value = config?.model || defaultModel;
  if (providerSelect && !draftMode) providerSelect.value = provider;
  if (protocolSelect && !draftMode) protocolSelect.value = protocol;
  if (temperatureInput && !draftMode) temperatureInput.value = String(config?.temperature ?? 0.1);
  if (gptApiKey && !draftMode) {
    gptApiKey.value = config?.apiKey || "";
    gptApiKey.placeholder = config?.hasApiKey ? "已保存，重新填写可覆盖" : "保存后仅显示末四位";
  }
  if (gptEnabled && !draftMode) gptEnabled.value = config?.enabled === false ? "false" : "true";
  if (gptBadge) {
    gptBadge.className = `badge ${ready ? "green" : config?.enabled ? "amber" : ""}`;
    gptBadge.textContent = ready ? "当前" : config?.enabled ? "缺Key" : "当前";
  }
  qsa<HTMLElement>("[data-ai-provider]").forEach((card) => {
    const active = card.dataset.aiProvider === provider;
    card.classList.toggle("active", active);
    const badgeNodeInCard = card.querySelector<HTMLElement>(".badge");
    if (badgeNodeInCard) {
      badgeNodeInCard.className = `badge ${active ? "green" : "gray"}`;
      badgeNodeInCard.textContent = active ? "当前" : (card.dataset.aiProvider === "anthropic" || card.dataset.aiProvider === "gemini" ? "原生" : "兼容");
    }
  });
  if (gptConnectionBadge) {
    gptConnectionBadge.className = `badge ${tested ? "green" : failed ? "red" : ready ? "amber" : ""}`;
    gptConnectionBadge.textContent = tested ? "连接通过" : failed ? "连接失败" : ready ? "待测试" : "未启用";
  }
  if (gptConnectionTitle) gptConnectionTitle.textContent = tested ? "AI 连接测试通过" : failed ? "AI 连接测试失败" : ready ? "已保存，建议立即测试" : config?.enabled ? "还需要填写 API Key" : "等待启用 AI";
  if (gptConnectionText) gptConnectionText.textContent = config?.lastTestMessage || (ready ? `当前模型：${config?.model}。已勾选 ${useCount} 个业务模块。` : "配置完成后，自动获客、官网解析、线索评分、开发信草稿和考试资料可以按需调用。");
  if (gptState) gptState.textContent = ready ? "已启用" : config?.enabled ? "待补Key" : "未启用";
  if (gptSub) gptSub.textContent = tested ? "最近测试通过" : ready ? "可测试连接和调用" : "等待 API Key";
  if (gptModelState) gptModelState.textContent = config?.model || defaultModel;
  if (providerState) providerState.textContent = preset.label;
  if (protocolState) protocolState.textContent = protocol === "anthropic" ? "Anthropic Messages" : protocol === "gemini" ? "Gemini generateContent" : "OpenAI兼容协议";
  if (useState) useState.textContent = `${useCount} 个模块`;
  [
    ["#aiUseLeadFinder", useFlags.leadFinder],
    ["#aiUseWebsiteParse", useFlags.websiteParse],
    ["#aiUseScoring", useFlags.scoring],
    ["#aiUseEmailDraft", useFlags.emailDraft],
    ["#aiUseExam", useFlags.exam]
  ].forEach(([selector, checked]) => {
    const input = qs<HTMLInputElement>(String(selector));
    if (input && !draftMode) input.checked = Boolean(checked);
  });
  Object.entries(useFlags).forEach(([key, on]) => {
    const row = qs<HTMLElement>(`[data-ai-use-row="${key}"]`);
    const stateBadge = row?.querySelector<HTMLElement>(".badge");
    if (stateBadge) {
      stateBadge.className = `badge ${ready && on ? "green" : on ? "amber" : "gray"}`;
      stateBadge.textContent = ready && on ? "已启用" : on ? "待Key" : "关闭";
    }
  });
}

function collectAiConfigPayload() {
  const activeView = qs<HTMLElement>(".view.active")?.id;
  const useGptPage = activeView === "ai-config" || Boolean(qs<HTMLInputElement>("#gptConfigName")?.matches(":focus"));
  if (useGptPage) {
    return {
      id: state.selectedAiConfigId || undefined,
      provider: qs<HTMLSelectElement>("#gptProviderSelect")?.value || "openai",
      protocol: qs<HTMLSelectElement>("#gptProtocolSelect")?.value || "openai-compatible",
      name: qs<HTMLInputElement>("#gptConfigName")?.value.trim() || "",
      baseUrl: qs<HTMLInputElement>("#gptBaseUrlInput")?.value.trim() || "",
      model: qs<HTMLInputElement>("#gptModelInput")?.value.trim() || "",
      apiKey: qs<HTMLInputElement>("#gptApiKeyInput")?.value.trim() || "",
      enabled: qs<HTMLSelectElement>("#gptEnabledSelect")?.value !== "false",
      temperature: Number(qs<HTMLInputElement>("#gptTemperatureInput")?.value || 0.1),
      useLeadFinder: Boolean(qs<HTMLInputElement>("#aiUseLeadFinder")?.checked),
      useWebsiteParse: Boolean(qs<HTMLInputElement>("#aiUseWebsiteParse")?.checked),
      useScoring: Boolean(qs<HTMLInputElement>("#aiUseScoring")?.checked),
      useEmailDraft: Boolean(qs<HTMLInputElement>("#aiUseEmailDraft")?.checked),
      useExam: Boolean(qs<HTMLInputElement>("#aiUseExam")?.checked)
    };
  }
  return {
    id: state.selectedAiConfigId || state.aiConfig?.id || undefined,
    provider: state.aiConfig?.provider || "openai",
    protocol: state.aiConfig?.protocol || "openai-compatible",
    name: qs<HTMLInputElement>("#aiConfigName")?.value.trim() || "官网线索解析模型",
    baseUrl: qs<HTMLInputElement>("#aiBaseUrlInput")?.value.trim() || "https://api.openai.com/v1",
    model: qs<HTMLInputElement>("#aiModelInput")?.value.trim() || "gpt-4o-mini",
    apiKey: qs<HTMLInputElement>("#aiApiKeyInput")?.value.trim() || "",
    enabled: Boolean(qs<HTMLInputElement>("#aiEnabledInput")?.checked),
    temperature: state.aiConfig?.temperature ?? 0.1,
    useLeadFinder: state.aiConfig?.useLeadFinder ?? true,
    useWebsiteParse: state.aiConfig?.useWebsiteParse ?? true,
    useScoring: state.aiConfig?.useScoring ?? true,
    useEmailDraft: state.aiConfig?.useEmailDraft ?? true,
    useExam: state.aiConfig?.useExam ?? false
  };
}

function applyAiProviderPreset(provider: string) {
  const preset = aiProviderPresets[provider] || aiProviderPresets.custom;
  const providerSelect = qs<HTMLSelectElement>("#gptProviderSelect");
  const protocolSelect = qs<HTMLSelectElement>("#gptProtocolSelect");
  const nameInput = qs<HTMLInputElement>("#gptConfigName");
  const baseInput = qs<HTMLInputElement>("#gptBaseUrlInput");
  const modelInput = qs<HTMLInputElement>("#gptModelInput");
  if (providerSelect) providerSelect.value = provider in aiProviderPresets ? provider : "custom";
  if (protocolSelect) protocolSelect.value = preset.protocol;
  if (nameInput) nameInput.value = state.aiDraftMode ? "" : preset.name;
  if (baseInput) baseInput.value = preset.baseUrl;
  if (modelInput) modelInput.value = state.aiDraftMode ? "" : preset.model;
  qsa<HTMLElement>("[data-ai-provider]").forEach((card) => card.classList.toggle("active", card.dataset.aiProvider === provider));
}

function newAiConfigDraft(provider = "openai") {
  const preset = aiProviderPresets[provider] || aiProviderPresets.openai;
  state.aiDraftMode = true;
  state.selectedAiConfigId = null;
  state.pendingAiDeleteId = null;
  const nameInput = qs<HTMLInputElement>("#gptConfigName");
  const apiKeyInput = qs<HTMLInputElement>("#gptApiKeyInput");
  const enabledSelect = qs<HTMLSelectElement>("#gptEnabledSelect");
  const tempInput = qs<HTMLInputElement>("#gptTemperatureInput");
  const providerSelect = qs<HTMLSelectElement>("#gptProviderSelect");
  const protocolSelect = qs<HTMLSelectElement>("#gptProtocolSelect");
  const baseInput = qs<HTMLInputElement>("#gptBaseUrlInput");
  const modelInput = qs<HTMLInputElement>("#gptModelInput");
  if (providerSelect) providerSelect.value = provider in aiProviderPresets ? provider : "custom";
  if (protocolSelect) protocolSelect.value = preset.protocol;
  if (nameInput) nameInput.value = "";
  if (baseInput) baseInput.value = preset.baseUrl;
  if (modelInput) modelInput.value = "";
  if (apiKeyInput) {
    apiKeyInput.value = "";
    apiKeyInput.placeholder = "新配置请填写 API Key";
  }
  if (enabledSelect) enabledSelect.value = "false";
  if (tempInput) tempInput.value = "0.1";
  ["#aiUseLeadFinder", "#aiUseWebsiteParse", "#aiUseScoring", "#aiUseEmailDraft"].forEach((selector) => {
    const input = qs<HTMLInputElement>(selector);
    if (input) input.checked = false;
  });
  const exam = qs<HTMLInputElement>("#aiUseExam");
  if (exam) exam.checked = false;
  renderAiConfig(null);
}

async function deleteAiConfig(button?: HTMLButtonElement) {
  if (!state.selectedAiConfigId) {
    toast("请先选择要删除的配置", "error");
    return;
  }
  const current = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  if (!current) return;
  if (state.pendingAiDeleteId !== current.id) {
    state.pendingAiDeleteId = current.id;
    renderAiConfig(current);
    return;
  }
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "删除中";
  }
  try {
    const result = await api<{ config: AiModelConfig | null; configs: AiModelConfig[] }>(`/api/tools/ai-config/${encodeURIComponent(current.id)}`, { method: "DELETE" });
    state.aiConfigs = result.configs || [];
    state.aiConfig = result.config;
    state.aiDraftMode = false;
    state.pendingAiDeleteId = null;
    state.selectedAiConfigId = result.config?.id || state.aiConfigs[0]?.id || null;
    renderAiConfig(state.aiConfig);
    renderLeadFinder(state.websiteOpportunities);
    toast(`已删除：${current.name}`);
  } finally {
    if (button) {
      const selected = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
      button.disabled = state.aiDraftMode || !selected;
      button.textContent = selected && state.pendingAiDeleteId === selected.id ? "确认删除" : (originalText === "确认删除" ? "删除当前" : originalText || "删除当前");
    }
  }
}

async function toggleAiConfigEnabled(button?: HTMLButtonElement) {
  if (state.aiDraftMode || !state.selectedAiConfigId) {
    toast("请先保存或选择一个配置", "error");
    return;
  }
  const current = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  if (!current) return;
  const enabledSelect = qs<HTMLSelectElement>("#gptEnabledSelect");
  if (enabledSelect) enabledSelect.value = current.enabled ? "false" : "true";
  await saveAiConfig(button);
}

async function saveAiConfig(button?: HTMLButtonElement, options: { silent?: boolean } = {}) {
  const originalText = button?.textContent || "";
  const payload = collectAiConfigPayload();
  const selected = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  const hasSubmittedKey = typeof payload.apiKey === "string" && payload.apiKey.length > 0 && !payload.apiKey.includes("****");
  if (!payload.name || !payload.baseUrl || !payload.model) {
    toast("请填写配置名称、Base URL 和模型名称", "error");
    return;
  }
  if (payload.enabled && !hasSubmittedKey && !selected?.hasApiKey) {
    toast("请先填写 API Key，再启用该配置", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "保存中";
  }
  try {
    const result = await api<{ config: AiModelConfig; configs?: AiModelConfig[] }>("/api/tools/ai-config", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.aiConfig = result.config;
    state.aiConfigs = result.configs || state.aiConfigs.filter((item) => item.id !== result.config.id).concat(result.config);
    state.selectedAiConfigId = result.config.id;
    state.aiDraftMode = false;
    state.pendingAiDeleteId = null;
    renderAiConfig(result.config);
    renderLeadFinder(state.websiteOpportunities);
    if (!options.silent) toast(result.config.enabled ? `已保存并启用：${result.config.name}` : `已保存：${result.config.name}`);
  } finally {
    if (button) {
      button.disabled = false;
      if (button.id === "aiToggleEnabledButton") {
        button.textContent = state.aiConfig?.enabled ? "停用当前" : "启用当前";
      } else {
        button.textContent = originalText || "保存AI配置";
      }
    }
  }
}

async function testAiConfig(button?: HTMLButtonElement) {
  await saveAiConfig(undefined, { silent: true });
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "测试中";
  }
  try {
    const result = await api<{ ok: boolean; message: string; config?: AiModelConfig; configs?: AiModelConfig[] }>("/api/tools/ai-config/test", {
      method: "POST",
      body: JSON.stringify({ id: state.selectedAiConfigId || undefined })
    });
    if (result.config) {
      state.aiConfig = result.config;
      state.aiConfigs = result.configs || state.aiConfigs.map((item) => item.id === result.config?.id ? result.config : item);
      state.selectedAiConfigId = result.config.id;
      renderAiConfig(result.config);
      renderLeadFinder(state.websiteOpportunities);
    }
    const gptConnectionBadge = qs<HTMLElement>("#gptConnectionBadge");
    const gptConnectionTitle = qs<HTMLElement>("#gptConnectionTitle");
    const gptConnectionText = qs<HTMLElement>("#gptConnectionText");
    if (gptConnectionBadge) {
      gptConnectionBadge.className = `badge ${result.ok ? "green" : "red"}`;
      gptConnectionBadge.textContent = result.ok ? "连接通过" : "连接失败";
    }
    if (gptConnectionTitle) gptConnectionTitle.textContent = result.ok ? "AI 连接测试通过" : "AI 连接测试失败";
    if (gptConnectionText) gptConnectionText.textContent = result.message;
    toast(result.message, result.ok ? "ok" : "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || "测试连接";
    }
  }
}

function renderWebsiteOpportunities(opportunities: WebsiteOpportunity[]) {
  const tbody = qs<HTMLElement>("#websiteOpportunityRows");
  const count = qs<HTMLElement>("#websiteOpportunityCount");
  const status = qs<HTMLElement>("#websiteScrapeStatus");
  const modeText = (mode?: WebsiteOpportunity["parseMode"]) => mode === "ai" ? "AI解析" : mode === "fallback" ? "AI回退" : "规则解析";
  const modeTone = (mode?: WebsiteOpportunity["parseMode"]) => mode === "ai" ? "green" : mode === "fallback" ? "amber" : "";
  if (count) count.textContent = `${opportunities.length} 条`;
  if (status && opportunities.length) {
    const synced = opportunities.filter((item) => item.status === "synced").length;
    const aiCount = opportunities.filter((item) => item.parseMode === "ai").length;
    status.innerHTML = `<b>${opportunities.length}</b><span>已解析官网</span>${badge(`${synced} 条已同步`, synced ? "green" : "")}${badge(aiCount ? `${aiCount} 条AI` : "规则/回退", aiCount ? "green" : "")}`;
  }
  if (!tbody) return;
  tbody.innerHTML = opportunities.length ? opportunities.map((item) => `
    <tr data-website-opportunity-id="${escapeHtml(item.id)}">
      <td><input type="checkbox" ${item.selected ?? item.status !== "synced" ? "checked" : ""} data-website-select></td>
      <td><input value="${escapeHtml(item.company)}" data-website-field="company"></td>
      <td><input value="${escapeHtml(item.business)}" data-website-field="business"></td>
      <td><input value="${escapeHtml(item.country)}" data-website-field="country"></td>
      <td><input value="${escapeHtml(item.website)}" data-website-field="website"></td>
      <td><input value="${escapeHtml(item.contact)}" data-website-field="contact"></td>
      <td><input value="${escapeHtml(item.contactInfo)}" data-website-field="contactInfo"></td>
      <td><textarea data-website-field="description">${escapeHtml(item.description)}</textarea></td>
      <td>${badge(item.status === "synced" ? "已同步" : "待同步", item.status === "synced" ? "green" : "amber")}${badge(modeText(item.parseMode), modeTone(item.parseMode))}</td>
    </tr>
  `).join("") : `<tr><td colspan="9" class="empty-cell">粘贴官网后点击解析，系统会抓取产品、联系方式和国家线索。</td></tr>`;
}

function collectWebsiteRows() {
  return qsa<HTMLTableRowElement>("#websiteOpportunityRows tr[data-website-opportunity-id]")
    .filter((row) => row.querySelector<HTMLInputElement>("[data-website-select]")?.checked)
    .map((row) => {
      const value = (field: string) => {
        const node = row.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-website-field="${field}"]`);
        return node?.value.trim() || "";
      };
      return {
        id: row.dataset.websiteOpportunityId || "",
        company: value("company"),
        business: value("business"),
        country: value("country"),
        website: value("website"),
        contact: value("contact"),
        contactInfo: value("contactInfo"),
        description: value("description")
      };
    }).filter((item) => item.company && item.website);
}

function websiteDomain(value: string) {
  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  }
}

function normalizeWebsiteLink(value: string) {
  const trimmed = (value || "").trim();
  if (!trimmed) return "#";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function leadFinderScore(item: WebsiteOpportunity) {
  let score = 42;
  if (item.company && !/unknown|待维护/i.test(item.company)) score += 12;
  if (item.business && !item.business.includes("待维护")) score += 12;
  if (item.country && item.country !== "未知") score += 8;
  if (item.contact && !item.contact.includes("待维护")) score += 8;
  if (item.contactInfo) score += 10;
  if (item.description && item.description.length > 30) score += 8;
  if (item.parseMode === "ai") score += 6;
  if (item.status === "synced") score += 4;
  return Math.max(35, Math.min(score, 96));
}

function leadFinderDuplicateState(item: WebsiteOpportunity) {
  const domain = websiteDomain(item.website);
  const duplicatedCustomer = state.customers.find((customer) => {
    const sameCompany = customer.company.trim().toLowerCase() === item.company.trim().toLowerCase();
    const docText = `${customer.billingName || ""} ${customer.documentContact || ""}`.toLowerCase();
    return sameCompany || (domain && docText.includes(domain));
  });
  if (item.customerId || duplicatedCustomer) return { text: "已有客户", tone: "amber" };
  if (item.leadId || item.status === "synced") return { text: "已入线索", tone: "green" };
  return { text: "新候选", tone: "green" };
}

function leadFinderFilteredRows(opportunities: WebsiteOpportunity[]) {
  return opportunities.filter((item) => {
    const duplicate = leadFinderDuplicateState(item);
    const score = leadFinderScore(item);
    if (state.leadFinderFilter === "pending") return item.status !== "synced";
    if (state.leadFinderFilter === "high") return score >= 76;
    if (state.leadFinderFilter === "duplicate") return duplicate.text === "已有客户";
    if (state.leadFinderFilter === "synced") return item.status === "synced";
    return true;
  });
}

function contactEmail(value: string) {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
}

const PROSPECT_PAGE_SIZE = 10;

const PROSPECT_STATUS_META: Record<WebsiteOpportunity["status"], { label: string; tone: string; action: string }> = {
  preview: { label: "待核验", tone: "amber", action: "核验联系人与联系方式" },
  contactable: { label: "可联系", tone: "green", action: "发送开发信或加入线索" },
  contacted: { label: "已联系", tone: "green", action: "等待回复，必要时加入线索跟进" },
  synced: { label: "已入线索", tone: "green", action: "在线索中心继续跟进" },
  excluded: { label: "已排除", tone: "gray", action: "确认原因，必要时恢复核验" }
};

function prospectStatusMeta(item: WebsiteOpportunity) {
  return PROSPECT_STATUS_META[item.status] || PROSPECT_STATUS_META.preview;
}

function prospectFilteredRows() {
  const keyword = qs<HTMLInputElement>("#prospectSearchInput")?.value.trim().toLowerCase() || "";
  const statusWeight: Record<WebsiteOpportunity["status"], number> = {
    contactable: 0,
    preview: 1,
    contacted: 2,
    synced: 3,
    excluded: 4
  };
  return [...state.websiteOpportunities]
    .filter((item) => {
      const haystack = `${item.company} ${item.business} ${item.country} ${item.website} ${item.contact} ${item.contactInfo} ${item.description}`.toLowerCase();
      if (keyword && !haystack.includes(keyword)) return false;
      if (state.prospectFilter !== "all") return item.status === state.prospectFilter;
      return true;
    })
    .sort((left, right) => {
      if (left.status !== right.status) return statusWeight[left.status] - statusWeight[right.status];
      const scoreDifference = leadFinderScore(right) - leadFinderScore(left);
      if (scoreDifference) return scoreDifference;
      return String(right.statusChangedAt || right.createdAt).localeCompare(String(left.statusChangedAt || left.createdAt));
    });
}

function selectedProspect() {
  return state.websiteOpportunities.find((item) => item.id === state.selectedProspectId) || null;
}

function renderProspectMailPreview() {
  const preview = qs<HTMLElement>("#prospectMailPreview");
  const item = selectedProspect();
  if (!preview) return;
  const sender = state.user?.emailSenderName || state.user?.name || "GoodJob Sales";
  const from = state.user?.outboundEmail || "";
  preview.textContent = [
    `From: ${sender}${from ? ` <${from}>` : " <未绑定发件邮箱>"}`,
    `To: ${qs<HTMLInputElement>("#prospectMailTo")?.value.trim() || "未填写"}`,
    `Subject: ${qs<HTMLInputElement>("#prospectMailSubject")?.value.trim() || "未填写"}`,
    "",
    qs<HTMLTextAreaElement>("#prospectMailBody")?.value.trim() || (item ? "点击“生成正文”创建开发信。" : "选择一条线索后，可生成并预览开发信。")
  ].join("\n");
}

function generateProspectMailDraft() {
  const item = selectedProspect();
  if (!item) {
    toast("请先选择一条搜客线索", "error");
    return;
  }
  const sender = state.user?.emailSenderName || state.user?.name || "GoodJob Sales";
  const signature = state.user?.emailSignature?.trim() || `Best regards,\n${sender}\nGoodJob Instrument Sales`;
  const mailTo = qs<HTMLInputElement>("#prospectMailTo");
  const subject = qs<HTMLInputElement>("#prospectMailSubject");
  const body = qs<HTMLTextAreaElement>("#prospectMailBody");
  if (mailTo && !mailTo.value.trim()) mailTo.value = contactEmail(item.contactInfo) || contactEmail(item.contact) || "";
  if (subject && !subject.value.trim()) subject.value = `${item.business || "Instrumentation"} supplier support for ${item.company}`;
  if (body) {
    body.value = [
      `Dear ${item.company} team,`,
      "",
      `I noticed your company is active in ${item.business || "industrial instrumentation related business"}${item.country ? ` in ${item.country}` : ""}.`,
      "GoodJob supplies pressure, temperature, flow and level instruments for distributors, system integrators and industrial projects.",
      "We can support product selection, datasheets, certificates, quotation and sample coordination for your local projects.",
      "",
      "May I know which instrumentation categories you are currently sourcing, and whether you have any upcoming project requirements?",
      "",
      signature
    ].join("\n");
  }
  renderProspectMailPreview();
}

function renderProspectDetail(item?: WebsiteOpportunity | null) {
  const box = qs<HTMLElement>("#prospectDetail");
  const sender = qs<HTMLElement>("#prospectSenderStatus");
  if (sender) {
    sender.innerHTML = state.user?.outboundEmail
      ? `当前发件人：${escapeHtml(state.user.emailSenderName || state.user.name)} &lt;${escapeHtml(state.user.outboundEmail)}&gt;`
      : `请先到个人主页绑定发件邮箱，再发送开发信。`;
  }
  if (!box) return;
  if (!item) {
    box.innerHTML = `<div class="empty-cell">点击左侧线索查看详情。</div>`;
    renderProspectMailPreview();
    return;
  }
  const score = leadFinderScore(item);
  const duplicate = leadFinderDuplicateState(item);
  const status = prospectStatusMeta(item);
  const owner = state.prospectAssignees.find((assignee) => assignee.id === item.ownerId);
  const canContact = ["contactable", "contacted", "synced"].includes(item.status);
  const readonly = item.status === "synced" ? "disabled" : "";
  box.innerHTML = `
    <div class="prospect-detail-hero">
      ${badge(status.label, status.tone)} ${badge(`${score}分`, score >= 76 ? "green" : score >= 60 ? "amber" : "gray")} ${badge(duplicate.text, duplicate.tone)}
      <h2>${escapeHtml(item.company)}</h2>
      <p>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(item.business || "业务待维护")} · ${escapeHtml(websiteDomain(item.website || ""))}</p>
    </div>
    <div class="prospect-field-grid">
      <div class="form-field"><label>公司</label><input id="prospectEditCompany" value="${escapeHtml(item.company)}" ${readonly}></div>
      <div class="form-field"><label>官网</label><input id="prospectEditWebsite" value="${escapeHtml(item.website)}" ${readonly}></div>
      <div class="form-field"><label>业务方向</label><input id="prospectEditBusiness" value="${escapeHtml(item.business)}" ${readonly}></div>
      <div class="form-field"><label>国家/地区</label><input id="prospectEditCountry" value="${escapeHtml(item.country)}" ${readonly}></div>
      <div class="form-field"><label>联系人</label><input id="prospectEditContact" value="${escapeHtml(item.contact)}" ${readonly}></div>
      <div class="form-field"><label>联系方式</label><input id="prospectEditContactInfo" value="${escapeHtml(item.contactInfo)}" ${readonly}></div>
      <div class="prospect-field"><span>归属业务员</span><b>${escapeHtml(owner?.name || (item.ownerId === state.user?.id ? state.user?.name || "本人" : item.ownerId || "待分配"))}</b></div>
      <div class="prospect-field"><span>来源</span><b>${escapeHtml(item.sourceLabel || item.source || "自动获客")}</b></div>
      <div class="prospect-field"><span>最近开发信</span><b>${item.lastDevelopmentEmailAt ? `${formatTime(item.lastDevelopmentEmailAt)} · ${escapeHtml(item.lastDevelopmentEmailSubject || "开发信")}` : "尚未发送"}</b></div>
      <div class="form-field" style="grid-column:1/-1"><label>核验说明</label><textarea id="prospectEditDescription" ${readonly}>${escapeHtml(item.description || "")}</textarea></div>
      ${item.excludedReason ? `<div class="prospect-field" style="grid-column:1/-1"><span>排除原因</span><b>${escapeHtml(item.excludedReason)}</b></div>` : ""}
    </div>
    <div class="inline-alert"><b>下一步</b><span>${escapeHtml(status.action)}</span></div>
    <div class="prospect-action-row">
      ${item.status !== "synced" ? `<button class="btn" id="prospectSaveButton">保存核验资料</button>` : ""}
      ${item.status === "preview" ? `<button class="btn" id="prospectDetailMarkButton">标记可联系</button>` : ""}
      ${item.status === "excluded" ? `<button class="btn" id="prospectRestoreButton">恢复待核验</button>` : ""}
      ${["contactable", "contacted"].includes(item.status) ? `<button class="btn primary" id="prospectDetailSyncButton">加入线索</button>` : ""}
      ${item.status === "synced" && item.leadId ? `<button class="btn primary" id="prospectViewLeadButton">查看线索</button><button class="btn" id="prospectTodoButton">生成待办</button>` : ""}
    </div>
  `;
  qs<HTMLButtonElement>("#prospectSaveButton", box)?.addEventListener("click", (event) => void saveProspectVerification(item, event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectDetailMarkButton", box)?.addEventListener("click", (event) => void updateProspectBatch("mark-contactable", [item.id], event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectRestoreButton", box)?.addEventListener("click", (event) => void updateProspectBatch("restore", [item.id], event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectDetailSyncButton", box)?.addEventListener("click", (event) => void syncProspects([item.id], event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectViewLeadButton", box)?.addEventListener("click", () => void openProspectLead(item));
  qs<HTMLButtonElement>("#prospectTodoButton", box)?.addEventListener("click", (event) => void createSelectedProspectTodo(event.currentTarget as HTMLButtonElement));
  const mailWorkspace = qs<HTMLDetailsElement>("#prospectMailWorkspace");
  if (mailWorkspace) mailWorkspace.open = canContact && Boolean(item.lastDevelopmentEmailAt);
  renderProspectMailPreview();
}

async function saveProspectVerification(item: WebsiteOpportunity, button?: HTMLButtonElement) {
  const value = (selector: string) => qs<HTMLInputElement | HTMLTextAreaElement>(selector)?.value.trim() || "";
  const payload = {
    company: value("#prospectEditCompany"),
    website: value("#prospectEditWebsite"),
    business: value("#prospectEditBusiness"),
    country: value("#prospectEditCountry"),
    contact: value("#prospectEditContact"),
    contactInfo: value("#prospectEditContactInfo"),
    description: value("#prospectEditDescription")
  };
  if (!payload.company || !payload.website) {
    toast("公司和官网不能为空", "error");
    return;
  }
  if (button) button.disabled = true;
  try {
    const result = await api<{ opportunity: WebsiteOpportunity }>(`/api/prospect-list/${encodeURIComponent(item.id)}/details`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    Object.assign(item, result.opportunity);
    renderProspectList();
    toast("核验资料已保存");
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存核验资料失败", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function renderProspectList() {
  const rows = qs<HTMLElement>("#prospectListRows");
  const total = qs<HTMLElement>("#prospectTotalCount");
  const preview = qs<HTMLElement>("#prospectPreviewCount");
  const contactable = qs<HTMLElement>("#prospectContactableCount");
  const contacted = qs<HTMLElement>("#prospectContactedCount");
  const synced = qs<HTMLElement>("#prospectSyncedCount");
  const excluded = qs<HTMLElement>("#prospectExcludedCount");
  const all = state.websiteOpportunities;
  const filtered = prospectFilteredRows();
  const pageCount = Math.max(1, Math.ceil(filtered.length / PROSPECT_PAGE_SIZE));
  state.prospectPage = Math.min(Math.max(1, state.prospectPage), pageCount);
  const pageRows = filtered.slice((state.prospectPage - 1) * PROSPECT_PAGE_SIZE, state.prospectPage * PROSPECT_PAGE_SIZE);
  state.selectedProspectIds = state.selectedProspectIds.filter((id) => all.some((item) => item.id === id));
  if (!state.selectedProspectId || !all.some((item) => item.id === state.selectedProspectId)) state.selectedProspectId = pageRows[0]?.id || filtered[0]?.id || all[0]?.id || null;
  if (total) total.textContent = `${all.length} 条候选`;
  if (preview) preview.textContent = String(all.filter((item) => item.status === "preview").length);
  if (contactable) contactable.textContent = String(all.filter((item) => item.status === "contactable").length);
  if (contacted) contacted.textContent = String(all.filter((item) => item.status === "contacted").length);
  if (synced) synced.textContent = String(all.filter((item) => item.status === "synced").length);
  if (excluded) excluded.textContent = String(all.filter((item) => item.status === "excluded").length);
  const selectedCount = qs<HTMLElement>("#prospectSelectedCount");
  if (selectedCount) selectedCount.textContent = `已选 ${state.selectedProspectIds.length} 条`;
  const pageSelect = qs<HTMLInputElement>("#prospectSelectPage");
  if (pageSelect) {
    pageSelect.checked = Boolean(pageRows.length) && pageRows.every((item) => state.selectedProspectIds.includes(item.id));
    pageSelect.indeterminate = pageRows.some((item) => state.selectedProspectIds.includes(item.id)) && !pageSelect.checked;
  }
  const pageSummary = qs<HTMLElement>("#prospectPageSummary");
  const pageNumber = qs<HTMLElement>("#prospectPageNumber");
  if (pageSummary) pageSummary.textContent = filtered.length ? `第 ${(state.prospectPage - 1) * PROSPECT_PAGE_SIZE + 1}-${Math.min(state.prospectPage * PROSPECT_PAGE_SIZE, filtered.length)} 条，共 ${filtered.length} 条` : "0 条结果";
  if (pageNumber) pageNumber.textContent = `${state.prospectPage} / ${pageCount}`;
  const prev = qs<HTMLButtonElement>("#prospectPrevPage");
  const next = qs<HTMLButtonElement>("#prospectNextPage");
  if (prev) prev.disabled = state.prospectPage <= 1;
  if (next) next.disabled = state.prospectPage >= pageCount;
  const assigneeSelect = qs<HTMLSelectElement>("#prospectAssigneeSelect");
  const assignButton = qs<HTMLButtonElement>("#prospectAssignButton");
  const canAssign = state.prospectAssignees.length > 0;
  if (assigneeSelect) {
    assigneeSelect.hidden = !canAssign;
    assigneeSelect.innerHTML = `<option value="">选择业务员</option>${state.prospectAssignees.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}`;
  }
  if (assignButton) assignButton.hidden = !canAssign;
  qsa<HTMLButtonElement>("[data-prospect-filter]").forEach((button) => button.classList.toggle("active", button.dataset.prospectFilter === state.prospectFilter));
  if (rows) {
    rows.innerHTML = pageRows.length ? pageRows.map((item) => {
      const score = leadFinderScore(item);
      const status = prospectStatusMeta(item);
      return `
        <article class="prospect-item ${item.id === state.selectedProspectId ? "active" : ""}" data-prospect-id="${escapeHtml(item.id)}">
          <input type="checkbox" data-prospect-select="${escapeHtml(item.id)}" ${state.selectedProspectIds.includes(item.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(item.company)}">
          <div class="prospect-item-main" data-prospect-open="${escapeHtml(item.id)}" role="button" tabindex="0">
            <div class="prospect-item-top"><h3>${escapeHtml(item.company)}</h3><span class="prospect-score">${score}</span></div>
            <p>${escapeHtml(item.business || "业务待维护")}</p>
            <small>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(websiteDomain(item.website || ""))}</small>
            <div class="prospect-meta-row">${badge(status.label, status.tone)}${item.lastDevelopmentEmailAt ? badge("已发开发信", "green") : ""}</div>
            <span class="prospect-next-action">下一步：${escapeHtml(status.action)}</span>
          </div>
        </article>
      `;
    }).join("") : `<div class="empty-cell">暂无匹配线索。请调整筛选，或去自动获客生成新结果。</div>`;
    qsa<HTMLInputElement>("[data-prospect-select]", rows).forEach((input) => {
      input.addEventListener("change", () => {
        const id = input.dataset.prospectSelect || "";
        state.selectedProspectIds = input.checked ? [...new Set([...state.selectedProspectIds, id])] : state.selectedProspectIds.filter((item) => item !== id);
        renderProspectList();
      });
    });
    qsa<HTMLElement>("[data-prospect-open]", rows).forEach((button) => {
      const select = () => {
        state.selectedProspectId = button.dataset.prospectOpen || null;
        qs<HTMLInputElement>("#prospectMailTo")!.value = "";
        qs<HTMLInputElement>("#prospectMailSubject")!.value = "";
        qs<HTMLTextAreaElement>("#prospectMailBody")!.value = "";
        renderProspectList();
      };
      button.addEventListener("click", select);
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") select();
      });
    });
  }
  renderProspectDetail(selectedProspect());
}

function prospectsAsSyncRows(ids: string[]) {
  return state.websiteOpportunities.filter((item) => ids.includes(item.id)).map((item) => ({
    id: item.id,
    company: item.company,
    business: item.business,
    country: item.country,
    website: item.website,
    contact: item.contact,
    contactInfo: item.contactInfo,
    description: item.description,
    source: item.source || "",
    sourceLabel: item.sourceLabel || ""
  }));
}

async function syncProspects(ids: string[], button?: HTMLButtonElement) {
  const opportunities = prospectsAsSyncRows(ids);
  const originalButtonText = button?.textContent || "";
  if (!opportunities.length) {
    toast("请先选择要入线索的候选", "error");
    return;
  }
  const invalid = state.websiteOpportunities.filter((item) => ids.includes(item.id) && !["contactable", "contacted"].includes(item.status));
  if (invalid.length) {
    toast("只有“可联系”或“已联系”的候选可以入线索", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "加入中";
  }
  try {
    const result = await api<{ created: LeadSyncResult[] }>("/api/tools/website-scrape/sync-opportunities", {
      method: "POST",
      body: JSON.stringify({ opportunities })
    });
    result.created.forEach((item) => {
      if (!state.leads.some((lead) => lead.id === item.lead.id)) state.leads.unshift(item.lead);
      const existing = state.websiteOpportunities.find((row) => row.id === item.opportunity.id || row.website === item.opportunity.website);
      if (existing) Object.assign(existing, item.opportunity);
      else state.websiteOpportunities.unshift(item.opportunity);
      state.selectedProspectId = item.opportunity.id;
    });
    state.selectedProspectIds = state.selectedProspectIds.filter((id) => !ids.includes(id));
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    renderLeads();
    toast(`已加入 ${result.created.length} 条线索`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalButtonText;
    }
  }
}

async function syncSelectedProspects(button?: HTMLButtonElement) {
  await syncProspects(state.selectedProspectIds, button);
}

function requestProspectExclusion(ids: string[], button?: HTMLButtonElement) {
  if (!ids.length) {
    toast("请先选择候选", "error");
    return;
  }
  openModal(
    "排除候选",
    `<div class="form-field"><label>排除原因</label><textarea id="prospectExcludeReasonInput" placeholder="例如：非目标行业、官网失效、联系方式无效"></textarea></div>`,
    `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmProspectExcludeButton">确认排除</button>`
  );
  qs<HTMLButtonElement>("#confirmProspectExcludeButton")?.addEventListener("click", async (event) => {
    const reason = qs<HTMLTextAreaElement>("#prospectExcludeReasonInput")?.value.trim() || "";
    closeModal();
    await updateProspectBatch("exclude", ids, button || event.currentTarget as HTMLButtonElement, reason);
  });
}

async function updateProspectBatch(
  action: "mark-contactable" | "exclude" | "restore" | "assign",
  ids: string[],
  button?: HTMLButtonElement,
  reason = ""
) {
  if (!ids.length) {
    toast("请先选择候选", "error");
    return;
  }
  const ownerId = action === "assign" ? qs<HTMLSelectElement>("#prospectAssigneeSelect")?.value || "" : "";
  if (action === "assign" && !ownerId) {
    toast("请选择目标业务员", "error");
    return;
  }
  if (button) button.disabled = true;
  try {
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/prospect-list/batch", {
      method: "PATCH",
      body: JSON.stringify({ ids, action, ownerId: ownerId || undefined, reason })
    });
    result.opportunities.forEach((updated) => {
      const existing = state.websiteOpportunities.find((item) => item.id === updated.id);
      if (existing) Object.assign(existing, updated);
    });
    state.selectedProspectIds = state.selectedProspectIds.filter((id) => !ids.includes(id));
    renderProspectList();
    toast(action === "mark-contactable" ? "已标记为可联系" : action === "exclude" ? "已排除所选候选" : action === "restore" ? "已恢复为待核验" : "已完成分配");
  } catch (error) {
    toast(error instanceof Error ? error.message : "批量处理失败", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function openProspectLead(item: WebsiteOpportunity) {
  if (!item.leadId) {
    toast("该候选尚未生成线索", "error");
    return;
  }
  activateNavView("leads");
  await openLead(item.leadId);
}

async function createSelectedProspectTodo(button?: HTMLButtonElement) {
  const item = selectedProspect();
  if (!item) {
    toast("请先选择一条搜客线索", "error");
    return;
  }
  if (item.status !== "synced" || !item.leadId) {
    toast("请先加入线索中心，再创建关联待办", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "生成中";
  }
  try {
    const result = await api<{ todo: Todo }>("/api/todos", {
      method: "POST",
      body: JSON.stringify({
        title: `跟进搜客线索：${item.company}`,
        type: "customer",
        priority: leadFinderScore(item) >= 76 ? "high" : "medium",
        dueAt: currentDateTimeText(),
        related: `${item.company} · 线索 ${item.leadId}`
      })
    });
    state.todos.unshift(result.todo);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    renderTopbarStats();
    toast("已生成搜客跟进待办");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "生成待办";
    }
  }
}

async function sendProspectDevelopmentEmail(button?: HTMLButtonElement) {
  const item = selectedProspect();
  if (!item) {
    toast("请先选择一条搜客线索", "error");
    return;
  }
  if (!["contactable", "contacted", "synced"].includes(item.status)) {
    toast("请先核验联系方式并标记为可联系", "error");
    return;
  }
  if (!state.user?.outboundEmail) {
    toast("请先在个人主页绑定发件邮箱", "error");
    return;
  }
  const to = qs<HTMLInputElement>("#prospectMailTo")?.value.trim() || "";
  const subject = qs<HTMLInputElement>("#prospectMailSubject")?.value.trim() || "";
  const body = qs<HTMLTextAreaElement>("#prospectMailBody")?.value.trim() || "";
  if (!to || !subject || body.length < 10) {
    toast("请补齐收件邮箱、主题和正文", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ sent: { simulated: boolean }; opportunity: WebsiteOpportunity; user: User }>(`/api/prospect-list/${encodeURIComponent(item.id)}/send-development-email`, {
      method: "POST",
      body: JSON.stringify({ to, subject, body })
    });
    updateStoredUser(result.user);
    const existing = state.websiteOpportunities.find((row) => row.id === result.opportunity.id);
    if (existing) Object.assign(existing, result.opportunity);
    renderProspectList();
    renderLeadFinder(state.websiteOpportunities);
    toast(result.sent.simulated ? "开发信已发送（测试模拟记录）" : "开发信已发送");
  } catch (error) {
    toast(error instanceof Error ? error.message : "开发信发送失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "发送开发信";
    }
  }
}

function currentLeadFinderTitle() {
  const product = qs<HTMLInputElement>("#leadProductKeywords")?.value.trim().split(/,|，/)[0]?.trim() || "产品";
  const country = qs<HTMLInputElement>("#leadCountries")?.value.trim().split(/,|，/)[0]?.trim() || "目标市场";
  const type = qs<HTMLSelectElement>("#leadCustomerTypes")?.value.split("/")[0]?.trim() || "客户";
  return `${country} · ${product} · ${type}`;
}

function currentLeadFinderSubtitle() {
  const industry = qs<HTMLInputElement>("#leadIndustryInput")?.value.trim().split(/,|，/)[0]?.trim() || "行业待补充";
  const limit = qs<HTMLSelectElement>("#leadLimit")?.value || "20";
  return `${industry} · 目标 ${limit} 条 · 人工核验后入线索`;
}

function currentLeadFinderSources() {
  return qsa<HTMLInputElement>("[data-lead-source]")
    .filter((item) => item.checked)
    .map((item) => item.closest("label")?.querySelector("b")?.textContent?.trim() || item.dataset.leadSource || "搜索源")
    .filter(Boolean);
}

function buildLeadFinderJobDetails(resultIds: string[] = []) {
  const product = qs<HTMLInputElement>("#leadProductKeywords")?.value.trim() || "未填写产品";
  const countries = qs<HTMLInputElement>("#leadCountries")?.value.trim() || "未填写市场";
  const industry = qs<HTMLInputElement>("#leadIndustryInput")?.value.trim() || "未填写行业";
  const customerType = qs<HTMLSelectElement>("#leadCustomerTypes")?.value || "未选择客户类型";
  const sourceText = currentLeadFinderSources().join("、") || "默认公开源";
  const lines = [
    `产品：${product}`,
    `市场：${countries}`,
    `行业：${industry}`,
    `客户类型：${customerType}`,
    `渠道：${sourceText}`
  ];
  if (resultIds.length) lines.unshift(`本次已搜到 ${resultIds.length} 条候选，展开可查看公司、国家和官网。`);
  return lines;
}

function leadFinderJobStatusText(job: LeadFinderJob) {
  if (job.status === "done") return "已完成";
  if (job.status === "needs_input") return "待导入";
  if (job.status === "ready") return "待运行";
  return "进行中";
}

function leadFinderJobStatusTone(job: LeadFinderJob) {
  if (job.status === "done") return "green";
  if (job.status === "needs_input") return "amber";
  if (job.status === "running") return "blue";
  return "";
}

function renderLeadFinderJobDetails(job: LeadFinderJob) {
  const found = (job.resultIds || [])
    .map((id) => state.websiteOpportunities.find((item) => item.id === id))
    .filter(Boolean) as WebsiteOpportunity[];
  const foundHtml = found.length ? `
    <div class="lead-job-found-head"><b>本次候选公司</b><span>${found.length} 条，可滚动查看</span></div>
    <div class="lead-job-found-list">
      ${found.map((item) => `
        <button type="button" data-lead-job-pick="${escapeHtml(item.id)}">
          <b>${escapeHtml(item.company || "公司待确认")}</b>
          <span>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(websiteDomain(item.website || ""))}</span>
          <em>${leadFinderScore(item)}分</em>
        </button>
      `).join("")}
    </div>
  ` : `<div class="lead-job-loading">${job.status === "running" ? "正在检索公开API、生成平台搜索入口并等待候选结果..." : "本次任务暂无候选结果，可导入官网/平台链接继续解析。"}</div>`;
  return `
    <div class="lead-job-detail" ${job.expanded ? "" : "hidden"}>
      <div class="lead-job-detail-lines">${(job.detailLines || buildLeadFinderJobDetails(job.resultIds)).map((line) => `<span>${escapeHtml(line)}</span>`).join("")}</div>
      ${foundHtml}
    </div>
  `;
}

function renderLeadFinderJobs() {
  const box = qs<HTMLElement>("#leadFinderJobList");
  if (!box) return;
  if (!leadFinderJobs.length) {
    box.innerHTML = `<div class="empty-cell">还没有搜客任务。填写条件后点击“生成并运行任务”。</div>`;
    return;
  }
  box.innerHTML = leadFinderJobs.map((job) => `
    <article class="lead-job-card" data-lead-job-id="${escapeHtml(job.id)}">
      <div class="lead-job-top">
        <button class="lead-job-toggle" type="button" data-lead-job-toggle aria-label="${job.expanded ? "收起任务详情" : "展开任务详情"}">${job.expanded ? "▾" : "▸"}</button>
        <div><h3>${escapeHtml(job.title)}</h3><p>${escapeHtml(job.subtitle)}</p></div>
        ${badge(leadFinderJobStatusText(job), leadFinderJobStatusTone(job))}
      </div>
      <div class="lead-job-metrics">
        <div><span>线索进度</span><b>${job.resultCount}/目标</b></div>
        <div><span>已耗时</span><b>${escapeHtml(job.elapsedText)}</b></div>
        <div><span>启用渠道</span><b>${job.channelCount} 个</b></div>
        <div><span>预计进度</span><b>${job.progress}%</b></div>
      </div>
      <div class="lead-job-progress"><i style="--p:${job.progress}%"></i></div>
      <div class="lead-job-steps">${job.steps.map((step, index) => `<span>${index + 1} ${escapeHtml(step)}</span>`).join("")}</div>
      ${renderLeadFinderJobDetails(job)}
      <div class="lead-job-actions"><button class="btn" data-lead-job-import>导入结果链接</button><button class="btn primary" data-lead-job-sync>同步选中结果</button></div>
    </article>
  `).join("");
  qsa<HTMLButtonElement>("[data-lead-job-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.closest<HTMLElement>("[data-lead-job-id]")?.dataset.leadJobId;
      const job = leadFinderJobs.find((item) => item.id === id);
      if (!job) return;
      job.expanded = !job.expanded;
      renderLeadFinderJobs();
    });
  });
  qsa<HTMLButtonElement>("[data-lead-job-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedLeadFinderId = button.dataset.leadJobPick || null;
      renderLeadFinder(state.websiteOpportunities);
    });
  });
  qsa<HTMLButtonElement>("[data-lead-job-import]").forEach((button) => {
    button.addEventListener("click", () => {
      qs<HTMLDetailsElement>(".lead-advanced-settings")?.setAttribute("open", "true");
      qs<HTMLTextAreaElement>("#leadFinderUrlInput")?.focus();
    });
  });
  qsa<HTMLButtonElement>("[data-lead-job-sync]").forEach((button) => {
    button.addEventListener("click", (event) => void syncLeadFinderRows(event.currentTarget as HTMLButtonElement));
  });
}

function createLeadFinderJob(status: LeadFinderJob["status"] = "running") {
  const enabledSources = currentLeadFinderSources().length || 1;
  const job: LeadFinderJob = {
    id: `lf_${Date.now()}`,
    title: currentLeadFinderTitle(),
    subtitle: currentLeadFinderSubtitle(),
    status,
    resultCount: 0,
    channelCount: enabledSources,
    elapsedText: status === "running" ? "刚刚开始" : "待导入",
    progress: status === "running" ? 18 : 35,
    steps: status === "running" ? ["生成搜索语法", "检索公开API", "等待返回结果"] : ["生成搜索语法", "打开平台入口", "导入官网/询盘链接"],
    createdAt: new Date().toISOString(),
    expanded: false,
    resultIds: [],
    detailLines: buildLeadFinderJobDetails()
  };
  leadFinderJobs = [job, ...leadFinderJobs].slice(0, 6);
  renderLeadFinderJobs();
  return job;
}

function updateLeadFinderJob(jobId: string, resultIds: string[], status: LeadFinderJob["status"]) {
  const job = leadFinderJobs.find((item) => item.id === jobId);
  if (!job) return;
  job.status = status;
  job.resultCount = resultIds.length;
  job.elapsedText = status === "done" ? "已完成" : "待导入";
  job.progress = status === "done" ? 100 : 52;
  job.steps = status === "done" ? ["生成搜索语法", "检索公开API", "提取公司资料", "等待同步"] : ["生成搜索语法", "打开平台入口", "导入官网/询盘链接"];
  job.resultIds = resultIds;
  job.detailLines = buildLeadFinderJobDetails(resultIds);
  renderLeadFinderJobs();
}

function renderLeadFinderSearchLinks() {
  const box = qs<HTMLElement>("#leadFinderSearchLinks");
  if (!box) return;
  const goal = qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.value.trim() || "";
  const keywords = qs<HTMLInputElement>("#leadProductKeywords")?.value.trim() || "pressure transmitter";
  const countries = (qs<HTMLInputElement>("#leadCountries")?.value.trim() || "Germany").split(/,|，/).map((item) => item.trim()).filter(Boolean).slice(0, 3);
  const industries = (qs<HTMLInputElement>("#leadIndustryInput")?.value.trim() || "").split(/,|，/).map((item) => item.trim()).filter(Boolean).slice(0, 2);
  const customerType = qs<HTMLSelectElement>("#leadCustomerTypes")?.value.split("/")[1]?.trim() || qs<HTMLSelectElement>("#leadCustomerTypes")?.value || "distributor";
  const exclude = (qs<HTMLInputElement>("#leadExcludeKeywords")?.value.trim() || "").split(/,|，/).map((item) => item.trim()).filter(Boolean).map((item) => `-${item}`).join(" ");
  // 免费搜索入口：读取用户勾选的平台开关
  const enabledSources = qsa<HTMLButtonElement>(".lead-entry-chip.active").map((item) => item.dataset.leadEntry || "google");
  const activeSources = enabledSources.length ? enabledSources : ["google"];
  const countryList = countries.length ? countries : ["Germany", "UK", "Turkey"];
  const industryText = industries.length ? industries.join(" ") : "";
  const sourceTemplates: Record<string, { label: string; query: (country: string) => string }> = {
    google: { label: "Google/Web", query: (country) => `${goal} ${keywords} ${industryText} ${customerType} ${country} company website ${exclude}` },
    alibaba: { label: "Alibaba询盘", query: (country) => `site:alibaba.com/rfq ${goal} ${keywords} ${industryText} ${country} buyer inquiry ${exclude}` },
    madein: { label: "Made-in-China询盘", query: (country) => `site:made-in-china.com ${goal} ${keywords} ${industryText} ${country} sourcing request buyer ${exclude}` },
    globalsources: { label: "Global Sources", query: (country) => `site:globalsources.com ${goal} ${keywords} ${industryText} ${country} buyer request ${exclude}` },
    europages: { label: "Europages", query: (country) => `site:europages.com ${goal} ${keywords} ${industryText} ${customerType} ${country} ${exclude}` }
  };
  const rows = countryList.flatMap((country) => activeSources.map((source) => {
    const template = sourceTemplates[source] || sourceTemplates.google;
    const query = template.query(country).replace(/\s+/g, " ").trim();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    return `<a href="${url}" target="_blank" rel="noreferrer"><b>${escapeHtml(template.label)}</b><span>${escapeHtml(query)}</span></a>`;
  })).slice(0, 6);
  box.innerHTML = rows.length ? rows.join("") : `<span class="empty-inline">勾选上方“免费搜索入口”后生成检索链接。</span>`;
}

function collectLeadFinderRows() {
  qsa<HTMLTableRowElement>("#leadFinderResultRows tr[data-lead-id]").forEach(syncLeadRowFields);
  return state.websiteOpportunities
    .filter((item) => item.selected)
    .map((item) => ({
      id: item.id,
      company: item.company,
      business: item.business,
      country: item.country,
      website: item.website,
      contact: item.contact,
      contactInfo: item.contactInfo,
      description: item.description,
      source: item.source,
      sourceLabel: item.sourceLabel
    }))
    .filter((item) => item.company && item.website);
}

function renderLeadFinderDetail(item?: WebsiteOpportunity) {
  const box = qs<HTMLElement>("#leadFinderDetail");
  if (!box) return;
  if (!item) {
    box.innerHTML = `<span>未选择</span><b>点击候选列表中的公司行查看详情。</b>`;
    return;
  }
  const score = leadFinderScore(item);
  const duplicate = leadFinderDuplicateState(item);
  const domain = websiteDomain(item.website);
  const owner = item.ownerId ? ownerName(item.ownerId) : (state.user?.name || "当前账号");
  const externalId = item.id || `website_${domain}`;
  box.innerHTML = `
    <div class="lead-profile-head">
      <div><h3>${escapeHtml(item.company)}</h3><p>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(domain)} · ${escapeHtml(item.business || "业务待维护")}</p></div>
      <div class="lead-profile-score">${score}</div>
    </div>
    <div class="lead-detail-stack">
      <div class="lead-detail-card"><span>ICP 判断</span><b>${score >= 76 ? "高匹配，建议优先核实采购/工程联系人。" : score >= 60 ? "中匹配，需要补齐联系人和产品证据。" : "信息不足，先确认官网和业务范围。"}</b></div>
      <div class="lead-detail-card"><span>联系方式</span><b>${escapeHtml(item.contactInfo || item.contact || "待补齐")}</b></div>
      <div class="lead-detail-card"><span>来源与外部编号</span><b>${escapeHtml(item.sourceLabel || item.source || "官网导入")} · ${escapeHtml(externalId)}</b></div>
      <div class="lead-detail-card"><span>重复与归属</span><b>${badge(duplicate.text, duplicate.tone)} ${escapeHtml(owner)}</b></div>
      <div class="lead-detail-card"><span>资料完整度</span><b>${badge(item.parseMode === "ai" ? "AI解析" : "规则解析", item.parseMode === "ai" ? "green" : "")} ${badge(`${score}分`, score >= 76 ? "green" : score >= 60 ? "amber" : "gray")} · 分数仅表示资料完整度，不代表采购意向</b></div>
      <div class="lead-detail-card"><span>下一步建议</span><b>${escapeHtml(item.status === "synced" ? "已进入线索中心，可创建首个正式跟进待办。" : "先核实官网、业务匹配和可用联系方式，再确认加入线索。")}</b></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// 数据源中心 / 获客来源选择
// ---------------------------------------------------------------------------

function leadTierText(tier: string) {
  return tier === "free" ? "免费" : tier === "byok_free" ? "自带Key·免费额度" : tier === "ai" ? "AI 模型" : "付费·自带Key";
}

function leadCategoryText(category: string) {
  return category === "web" ? "Web搜索" : category === "company" ? "公司库" : category === "ai" ? "AI 生成" : "邮箱发现";
}

function renderLeadSourceChips() {
  const box = qs<HTMLElement>("#leadSourceChips");
  if (!box) return;
  if (!state.leadProviders.length) {
    box.innerHTML = `<span class="empty-inline">暂无数据源，点击“数据源中心”配置。</span>`;
    return;
  }
  box.innerHTML = state.leadProviders.map((provider) => {
    const selected = state.selectedLeadSources.includes(provider.id);
    const isAi = provider.tier === "ai";
    const cls = `${provider.ready ? (selected ? "ready active" : "ready") : "needkey"}${isAi ? " ai" : ""}`;
    const stateText = isAi
      ? (provider.ready ? "已启用" : "未启用")
      : provider.ready ? (provider.requiresKey ? "已连接" : "内置") : "未配置";
    return `<button type="button" class="lead-source-chip ${cls}" data-lead-provider="${escapeHtml(provider.id)}"><span class="dot"></span><span class="ls-chip-name">${escapeHtml(provider.name)}</span><small>${stateText}</small></button>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-lead-provider]", box).forEach((chip) => {
    chip.addEventListener("click", () => {
      const id = chip.dataset.leadProvider || "";
      const provider = state.leadProviders.find((item) => item.id === id);
      if (!provider) return;
      if (!provider.ready) {
        if (id === "ai_search") {
          activateNavView("ai-config", () => {
            qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
            toast("在此启用模型并勾选“自动获客”，即可把 AI 搜索作为获客来源");
          });
        } else {
          openLeadSourceCenter(id);
        }
        return;
      }
      state.leadSourceSelectionTouched = true;
      if (state.selectedLeadSources.includes(id)) state.selectedLeadSources = state.selectedLeadSources.filter((item) => item !== id);
      else state.selectedLeadSources = [...state.selectedLeadSources, id];
      renderLeadSourceChips();
    });
  });
}

function leadSourceCardsHtml(focusId?: string) {
  const cards = state.leadProviders.map((provider) => {
    const statusCls = !provider.ready ? "warn" : provider.lastTestStatus === "failed" ? "fail" : provider.lastTestStatus === "passed" ? "ok" : "ok";
    const isAi = provider.id === "ai_search";
    const statusText = isAi
      ? (provider.ready ? (provider.lastTestMessage || "已启用，可作为获客来源") : "未启用，去「AI 模型配置」开启")
      : !provider.requiresKey
        ? "内置免费源，无需配置"
        : provider.ready
          ? (provider.lastTestStatus === "passed" ? "已连接并通过测试" : provider.lastTestStatus === "failed" ? `测试失败：${provider.lastTestMessage || "请检查 Key"}` : "已保存 Key，建议点测试连接")
          : "未配置 API Key";
    const caps = provider.capabilities.map((cap) => `<span class="ls-cap">${escapeHtml(cap)}</span>`).join("");
    const form = isAi ? `
      <div class="ls-usage">${escapeHtml(provider.costNote)}</div>
      <div class="ls-form-actions"><button class="btn" type="button" data-ls-ai-config>去 AI 模型配置</button></div>` : provider.requiresKey ? `
      <div class="ls-form">
        <input type="password" data-ls-key="${escapeHtml(provider.id)}" placeholder="${provider.hasApiKey ? "已保存（留空不修改）" : "粘贴 API Key"}" autocomplete="off">
        <div class="ls-form-actions">
          <button class="btn primary" type="button" data-ls-save="${escapeHtml(provider.id)}">保存并启用</button>
          <button class="btn" type="button" data-ls-test="${escapeHtml(provider.id)}">测试连接</button>
          ${provider.hasApiKey ? `<button class="btn" type="button" data-ls-delete="${escapeHtml(provider.id)}">清除</button>` : ""}
        </div>
        ${provider.usage ? `<div class="ls-usage">${escapeHtml(provider.usage)}</div>` : ""}
        <div class="ls-usage">${escapeHtml(provider.keyHint)}</div>
      </div>` : `<div class="ls-usage">${escapeHtml(provider.costNote)}</div>`;
    return `
      <div class="ls-card ${provider.ready && provider.requiresKey ? "is-ready" : ""} ${focusId === provider.id ? "is-open" : ""}">
        <div class="ls-card-top">
          <div><h4>${escapeHtml(provider.name)}</h4><p>${leadCategoryText(provider.category)} · ${escapeHtml(provider.costNote)}</p></div>
          <span class="ls-tier ${provider.tier}">${leadTierText(provider.tier)}</span>
        </div>
        <div class="ls-caps">${caps}</div>
        <div class="ls-status ${statusCls}"><span class="dot"></span>${escapeHtml(statusText)}</div>
        ${form}
        ${provider.docsUrl ? `<a class="ls-docs" href="${escapeHtml(provider.docsUrl)}" target="_blank" rel="noreferrer">查看官方文档 ↗</a>` : ""}
      </div>`;
  }).join("");
  return `<p class="ls-center-intro">免费源无需配置即可使用；付费/自带 Key 源在此粘贴 API Key、测试连接后即可在搜客中启用。Key 仅本人可见，页面不回显明文。</p><div class="ls-grid">${cards}</div>`;
}

function bindLeadSourceCards() {
  const modal = qs<HTMLElement>("#appModal");
  if (!modal) return;
  qsa<HTMLButtonElement>("[data-ls-save]", modal).forEach((button) => button.addEventListener("click", () => void saveLeadSourceConfig(button.dataset.lsSave || "", button)));
  qsa<HTMLButtonElement>("[data-ls-test]", modal).forEach((button) => button.addEventListener("click", () => void testLeadSourceConfig(button.dataset.lsTest || "", button)));
  qsa<HTMLButtonElement>("[data-ls-delete]", modal).forEach((button) => button.addEventListener("click", () => void deleteLeadSourceConfig(button.dataset.lsDelete || "", button)));
  qs<HTMLButtonElement>("[data-ls-ai-config]", modal)?.addEventListener("click", () => {
    closeModal();
    activateNavView("ai-config", () => {
      qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
      toast("启用模型并勾选“自动获客”后，AI 搜索即可用");
    });
  });
}

function openLeadSourceCenter(focusId?: string) {
  openModal("数据源中心", leadSourceCardsHtml(focusId), `<button class="btn" data-modal-close>关闭</button>`);
  bindLeadSourceCards();
}

function refreshLeadSourceCenter(providers?: LeadProviderStatus[]) {
  if (providers) state.leadProviders = providers;
  if (!state.leadSourceSelectionTouched) {
    // AI 搜索按 token 计费，默认不自动勾选，由用户按需开启
    state.selectedLeadSources = state.leadProviders.filter((item) => item.ready && item.enabled && item.id !== "ai_search").map((item) => item.id);
  }
  renderLeadSourceChips();
  const modal = qs<HTMLElement>("#appModal");
  if (modal?.classList.contains("active")) {
    const body = qs<HTMLElement>("#modalBody");
    if (body) {
      body.innerHTML = leadSourceCardsHtml();
      bindLeadSourceCards();
    }
  }
}

async function saveLeadSourceConfig(providerId: string, button?: HTMLButtonElement) {
  if (!providerId) return;
  const input = qs<HTMLInputElement>(`[data-ls-key="${providerId}"]`);
  const key = input?.value.trim() || "";
  const provider = state.leadProviders.find((item) => item.id === providerId);
  if (provider?.requiresKey && !key && !provider.hasApiKey) {
    toast("请先粘贴该数据源的 API Key", "error");
    return;
  }
  const original = button?.textContent || "";
  if (button) { button.disabled = true; button.textContent = "保存中"; }
  try {
    const result = await api<{ providers: LeadProviderStatus[] }>("/api/lead-finder/source-config", {
      method: "POST",
      body: JSON.stringify({ provider: providerId, apiKey: key, enabled: true })
    });
    state.leadSourceSelectionTouched = true;
    if (!state.selectedLeadSources.includes(providerId)) state.selectedLeadSources = [...state.selectedLeadSources, providerId];
    refreshLeadSourceCenter(result.providers);
    toast(`已保存并启用：${provider?.name || providerId}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = original || "保存并启用"; }
  }
}

async function testLeadSourceConfig(providerId: string, button?: HTMLButtonElement) {
  if (!providerId) return;
  const input = qs<HTMLInputElement>(`[data-ls-key="${providerId}"]`);
  const key = input?.value.trim() || "";
  const provider = state.leadProviders.find((item) => item.id === providerId);
  const original = button?.textContent || "";
  if (button) { button.disabled = true; button.textContent = "测试中"; }
  try {
    // 若填了新 key，先静默保存再测试，保证“填上 key 就能测通”
    if (provider?.requiresKey && key) {
      await api("/api/lead-finder/source-config", { method: "POST", body: JSON.stringify({ provider: providerId, apiKey: key, enabled: true }) });
    }
    const result = await api<{ ok: boolean; message: string; usage: string; providers: LeadProviderStatus[] }>("/api/lead-finder/source-config/test", {
      method: "POST",
      body: JSON.stringify({ provider: providerId })
    });
    refreshLeadSourceCenter(result.providers);
    toast(result.message + (result.usage ? ` · ${result.usage}` : ""), result.ok ? "ok" : "error");
  } catch (error) {
    toast(error instanceof Error ? error.message : "测试失败", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = original || "测试连接"; }
  }
}

async function deleteLeadSourceConfig(providerId: string, button?: HTMLButtonElement) {
  if (!providerId) return;
  if (button) { button.disabled = true; button.textContent = "清除中"; }
  try {
    const result = await api<{ providers: LeadProviderStatus[] }>(`/api/lead-finder/source-config/${encodeURIComponent(providerId)}`, { method: "DELETE" });
    state.selectedLeadSources = state.selectedLeadSources.filter((item) => item !== providerId);
    refreshLeadSourceCenter(result.providers);
    toast("已清除该数据源的 API Key");
  } catch (error) {
    toast(error instanceof Error ? error.message : "清除失败", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = "清除"; }
  }
}

function syncLeadRowFields(row: HTMLElement) {
  const id = row.dataset.leadId;
  const item = state.websiteOpportunities.find((o) => o.id === id);
  if (!item) return;
  const read = (field: string) => row.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-lead-field="${field}"]`)?.value.trim();
  const company = read("company");
  if (company) item.company = company;
  const business = read("business"); if (business !== undefined) item.business = business;
  const country = read("country"); if (country !== undefined) item.country = country;
  const website = read("website"); if (website) item.website = website;
  const contact = read("contact"); if (contact !== undefined) item.contact = contact;
  const contactInfo = read("contactInfo"); if (contactInfo !== undefined) item.contactInfo = contactInfo;
  const description = read("description"); if (description !== undefined) item.description = description;
}

function leadSourceTag(item: WebsiteOpportunity) {
  if (!item.source && !item.sourceLabel) return `<span class="lead-src-tag">导入</span>`;
  const provider = state.leadProviders.find((p) => p.id === item.source);
  const tier = provider?.tier || "byok_free";
  const label = item.sourceLabel || provider?.name || item.source || "来源";
  return `<span class="lead-src-tag ${tier}">${escapeHtml(label)}</span>`;
}

const leadFinderPageSize = 10;

function updateLeadFinderSelectionCount() {
  const count = state.websiteOpportunities.filter((item) => item.selected).length;
  const label = qs<HTMLElement>("#leadFinderSelectedCount");
  const bar = qs<HTMLElement>("#leadFinderBulkbar");
  if (label) label.textContent = `已选 ${count} 条`;
  bar?.classList.toggle("is-empty", count === 0);
}

function setLeadFinderSelected(id: string, selected: boolean) {
  const item = state.websiteOpportunities.find((row) => row.id === id);
  if (!item || item.status === "synced" || leadFinderDuplicateState(item).text === "已有客户") return;
  item.selected = selected;
  qsa<HTMLInputElement>(`[data-lead-select][data-lead-select-id="${CSS.escape(id)}"]`).forEach((input) => {
    input.checked = selected;
  });
  updateLeadFinderSelectionCount();
}

function leadFinderMobileCard(item: WebsiteOpportunity) {
  const score = leadFinderScore(item);
  const duplicate = leadFinderDuplicateState(item);
  const disabled = item.status === "synced" || duplicate.text === "已有客户";
  return `
    <article class="lead-mobile-card ${state.selectedLeadFinderId === item.id ? "selected" : ""}" data-lead-mobile-id="${escapeHtml(item.id)}">
      <div class="lead-mobile-card-head">
        <input type="checkbox" data-lead-select data-lead-select-id="${escapeHtml(item.id)}" ${item.selected ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="选择 ${escapeHtml(item.company)}">
        <div><h3>${escapeHtml(item.company)}</h3><p>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(websiteDomain(item.website) || "官网待补")}</p></div>
        <span class="lead-mobile-score">${score}</span>
      </div>
      <div class="lead-mobile-meta">${leadSourceTag(item)}${badge(item.status === "synced" ? "已同步" : "待确认", item.status === "synced" ? "green" : "amber")}${badge(duplicate.text, duplicate.tone)}</div>
      <div class="lead-mobile-contact">${escapeHtml(item.business || "业务待维护")}<br>${escapeHtml(item.contactInfo || item.contact || "联系方式待补齐")}</div>
      <button class="btn lead-mobile-open" type="button" data-lead-mobile-open="${escapeHtml(item.id)}">查看核验信息</button>
    </article>
  `;
}

function renderLeadFinder(opportunities = state.websiteOpportunities) {
  const rows = qs<HTMLElement>("#leadFinderResultRows");
  const mobileRows = qs<HTMLElement>("#leadFinderMobileRows");
  const total = qs<HTMLElement>("#leadFinderTotalCount");
  const pending = qs<HTMLElement>("#leadFinderPendingCount");
  const synced = qs<HTMLElement>("#leadFinderSyncedCount");
  const aiState = qs<HTMLElement>("#leadFinderAiState");
  const aiSub = qs<HTMLElement>("#leadFinderAiSub");
  const aiBadge = qs<HTMLElement>("#leadFinderAiBadge");
  const sourceAiBadge = qs<HTMLElement>("#leadFinderSourceAiBadge");
  const ready = Boolean(state.aiConfig?.enabled && state.aiConfig?.hasApiKey && state.aiConfig?.useLeadFinder);
  const sortedAll = [...opportunities].sort((a, b) => {
    // 本轮搜客/勾选的新结果置顶，避免被历史高分种子埋没
    const aSel = a.selected ? 1 : 0;
    const bSel = b.selected ? 1 : 0;
    if (aSel !== bSel) return bSel - aSel;
    if (a.status !== b.status) return a.status === "synced" ? 1 : -1;
    const createdDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
    return leadFinderScore(b) - leadFinderScore(a);
  });
  const sorted = leadFinderFilteredRows(sortedAll);
  const pageCount = Math.max(1, Math.ceil(sorted.length / leadFinderPageSize));
  state.leadFinderPage = Math.min(Math.max(1, state.leadFinderPage), pageCount);
  const pageStart = (state.leadFinderPage - 1) * leadFinderPageSize;
  const pageRows = sorted.slice(pageStart, pageStart + leadFinderPageSize);
  if (!state.selectedLeadFinderId || !sortedAll.some((item) => item.id === state.selectedLeadFinderId)) {
    state.selectedLeadFinderId = sortedAll[0]?.id || null;
  }
  if (total) total.textContent = String(sortedAll.length);
  if (pending) pending.textContent = String(sortedAll.filter((item) => item.status !== "synced").length);
  if (synced) synced.textContent = String(sortedAll.filter((item) => item.status === "synced").length);
  if (aiState) aiState.textContent = ready ? "AI" : "规则";
  if (aiSub) aiSub.textContent = ready ? `${state.aiConfig?.model || "已配置"} 可用于解析` : "未启用或未授权自动获客时使用规则解析";
  [aiBadge, sourceAiBadge].forEach((node) => {
    if (!node) return;
    node.className = `badge ${ready ? "green" : ""}`;
    node.textContent = ready ? "AI已配置" : "规则解析";
  });
  const useAi = qs<HTMLInputElement>("#leadFinderUseAiInput");
  if (useAi) useAi.disabled = !ready;
  if (!rows) return;
  qsa<HTMLButtonElement>("[data-lead-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.leadFilter === state.leadFinderFilter);
  });
  rows.innerHTML = pageRows.length ? pageRows.map((item) => {
    const score = leadFinderScore(item);
    const duplicate = leadFinderDuplicateState(item);
    const selected = state.selectedLeadFinderId === item.id;
    const disabled = item.status === "synced" || duplicate.text === "已有客户";
    return `
      <tr data-lead-id="${escapeHtml(item.id)}" class="${selected ? "selected" : ""}">
        <td><input type="checkbox" data-lead-select data-lead-select-id="${escapeHtml(item.id)}" ${item.selected ? "checked" : ""} ${disabled ? "disabled" : ""}></td>
        <td class="lead-company-cell" data-lead-pick><div class="lead-cell-title"><input data-lead-field="company" value="${escapeHtml(item.company)}"><a href="${escapeHtml(normalizeWebsiteLink(item.website))}" target="_blank" rel="noreferrer" class="lead-cell-domain">${escapeHtml(websiteDomain(item.website) || "官网待补")}</a></div><input type="hidden" data-lead-field="website" value="${escapeHtml(item.website)}"><input type="hidden" data-lead-field="description" value="${escapeHtml(item.description)}"></td>
        <td>${leadSourceTag(item)}</td>
        <td><input data-lead-field="business" value="${escapeHtml(item.business)}"></td>
        <td><input data-lead-field="country" value="${escapeHtml(item.country)}"></td>
        <td><input data-lead-field="contact" value="${escapeHtml(item.contact)}"></td>
        <td><input data-lead-field="contactInfo" value="${escapeHtml(item.contactInfo)}"></td>
        <td><div class="lead-score"><b>${score}</b><i style="--p:${score}%"></i></div></td>
        <td class="lead-status-cell">${badge(item.status === "synced" ? "已同步" : "待确认", item.status === "synced" ? "green" : "amber")}${badge(duplicate.text, duplicate.tone)}${badge(item.parseMode === "ai" ? "AI" : "规则", item.parseMode === "ai" ? "green" : "")}</td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="9" class="empty-cell">暂无候选客户。填写画像、选好数据源后点击“生成并运行任务”。</td></tr>`;
  if (mobileRows) mobileRows.innerHTML = pageRows.length ? pageRows.map(leadFinderMobileCard).join("") : `<div class="empty-cell">暂无匹配候选。</div>`;
  const pageSummary = qs<HTMLElement>("#leadFinderPageSummary");
  const pageNumber = qs<HTMLElement>("#leadFinderPageNumber");
  const prev = qs<HTMLButtonElement>("#leadFinderPrevPage");
  const next = qs<HTMLButtonElement>("#leadFinderNextPage");
  if (pageSummary) pageSummary.textContent = sorted.length ? `显示 ${pageStart + 1}-${Math.min(pageStart + leadFinderPageSize, sorted.length)}，共 ${sorted.length} 条` : "0 条结果";
  if (pageNumber) pageNumber.textContent = `${state.leadFinderPage} / ${pageCount}`;
  if (prev) prev.disabled = state.leadFinderPage <= 1;
  if (next) next.disabled = state.leadFinderPage >= pageCount;
  qsa<HTMLElement>("#leadFinderResultRows tr[data-lead-id]").forEach((row) => {
    // 行内编辑即时同步到 state，保证重渲染与详情面板反映最新编辑
    qsa<HTMLInputElement | HTMLTextAreaElement>("[data-lead-field]", row).forEach((field) => {
      field.addEventListener("input", () => syncLeadRowFields(row));
    });
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).matches("input, textarea")) return;
      syncLeadRowFields(row);
      state.selectedLeadFinderId = row.dataset.leadId || null;
      renderLeadFinder(state.websiteOpportunities);
    });
  });
  qsa<HTMLInputElement>("[data-lead-select]").forEach((input) => {
    input.addEventListener("change", () => setLeadFinderSelected(input.dataset.leadSelectId || "", input.checked));
  });
  qsa<HTMLButtonElement>("[data-lead-mobile-open]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedLeadFinderId = button.dataset.leadMobileOpen || null;
      qs<HTMLDetailsElement>(".lead-inline-detail")?.setAttribute("open", "true");
      renderLeadFinder(state.websiteOpportunities);
    });
  });
  updateLeadFinderSelectionCount();
  renderLeadFinderDetail(sortedAll.find((item) => item.id === state.selectedLeadFinderId));
  renderLeadFinderSearchLinks();
  renderLeadFinderJobs();
}

async function runLeadFinder(button?: HTMLButtonElement) {
  const originalText = button?.textContent || "生成并运行任务";
  const input = qs<HTMLTextAreaElement>("#leadFinderUrlInput");
  const urls = (input?.value || "").split(/\n|,|，/).map((item) => item.trim()).filter(Boolean).slice(0, Number(qs<HTMLSelectElement>("#leadLimit")?.value || 20));
  const useAi = Boolean(qs<HTMLInputElement>("#leadFinderUseAiInput")?.checked);
  renderLeadFinderSearchLinks();
  if (useAi && (!state.aiConfig?.enabled || !state.aiConfig?.hasApiKey || !state.aiConfig?.useLeadFinder)) {
    toast("请先配置并启用 AI 模型，或关闭 AI 解析", "error");
    return;
  }
  // 选中且已就绪的数据源；未选时用免费源兜底
  const readySelected = state.selectedLeadSources.filter((id) => state.leadProviders.find((p) => p.id === id)?.ready);
  const sources = readySelected.length ? readySelected : state.leadProviders.filter((p) => p.ready && !p.requiresKey).map((p) => p.id);
  const limit = Number(qs<HTMLSelectElement>("#leadLimit")?.value || 12);

  // 计费源成本护栏：付费 API 与 AI 搜索都会产生费用，搜索前确认
  if (!urls.length) {
    const billed = sources.map((id) => state.leadProviders.find((p) => p.id === id)).filter((p): p is LeadProviderStatus => Boolean(p && (p.tier === "paid" || p.tier === "ai")));
    if (billed.length) {
      const lines = billed.map((p) => p.tier === "ai"
        ? `· ${p.name}：消耗你配置的 AI 模型 token`
        : `· ${p.name}：约 ${Math.min(limit, 15)} 次调用${p.usage ? `（${p.usage}）` : ""}`).join("\n");
      if (!window.confirm(`本次将使用计费数据源：\n${lines}\n\n确认开始搜客吗？`)) return;
    }
  }

  const job = createLeadFinderJob("running");
  if (button) {
    button.disabled = true;
    button.classList.add("is-running");
    button.textContent = useAi ? "AI搜客中" : "搜客任务运行中";
  }
  try {
    if (!urls.length) {
      const result = await api<{ opportunities: WebsiteOpportunity[]; sourceStats: Array<{ id: string; name: string; count: number; error?: string; usage?: string }>; skipped: string[] }>("/api/lead-finder/search", {
        method: "POST",
        body: JSON.stringify({
          goal: qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.value.trim() || "",
          productKeywords: qs<HTMLInputElement>("#leadProductKeywords")?.value.trim() || "",
          countries: qs<HTMLInputElement>("#leadCountries")?.value.trim() || "",
          industry: qs<HTMLInputElement>("#leadIndustryInput")?.value.trim() || "",
          customerType: qs<HTMLSelectElement>("#leadCustomerTypes")?.value || "",
          excludeKeywords: qs<HTMLInputElement>("#leadExcludeKeywords")?.value.trim() || "",
          sources,
          useAi,
          limit
        })
      });
      const existing = state.websiteOpportunities
        .filter((item) => !result.opportunities.some((next) => next.website === item.website || next.company === item.company))
        .map((item) => ({ ...item, selected: false }));
      state.websiteOpportunities = [...result.opportunities.map((item) => ({ ...item, selected: false })), ...existing];
      state.leadFinderPage = 1;
      state.selectedLeadFinderId = result.opportunities[0]?.id || state.selectedLeadFinderId;
      updateLeadFinderJob(job.id, result.opportunities.map((item) => item.id), result.opportunities.length ? "done" : "needs_input");
      renderLeadFinder(state.websiteOpportunities);
      renderProspectList();
      const statLine = result.sourceStats.filter((item) => item.count || item.error).map((item) => `${item.name} ${item.error ? "✕" : item.count}`).join(" · ");
      toast(result.opportunities.length ? `已找到 ${result.opportunities.length} 条候选（${statLine || "多源合并"}）` : `本次未命中${result.skipped.length ? `；未配置：${result.skipped.join("、")}` : "，可放宽条件或增加数据源"}`, result.opportunities.length ? "ok" : "error");
      return;
    }
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-scrape/preview", {
      method: "POST",
      body: JSON.stringify({ urls, useAi })
    });
    const existing = state.websiteOpportunities
      .filter((item) => !result.opportunities.some((next) => next.website === item.website))
      .map((item) => ({ ...item, selected: false }));
    state.websiteOpportunities = [...result.opportunities.map((item) => ({ ...item, selected: false })), ...existing];
    state.leadFinderPage = 1;
    state.selectedLeadFinderId = result.opportunities[0]?.id || state.selectedLeadFinderId;
    updateLeadFinderJob(job.id, result.opportunities.map((item) => item.id), "done");
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    toast(`已生成 ${result.opportunities.length} 条候选客户`);
  } catch (error) {
    updateLeadFinderJob(job.id, [], "needs_input");
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("is-running");
      button.textContent = originalText;
    }
  }
}

async function syncLeadFinderRows(button?: HTMLButtonElement) {
  const opportunities = collectLeadFinderRows();
  if (!opportunities.length) {
    toast("请至少勾选一条候选客户", "error");
    return;
  }
  const selectedItems = state.websiteOpportunities.filter((item) => opportunities.some((row) => row.id === item.id));
  const duplicates = selectedItems.filter((item) => leadFinderDuplicateState(item).text !== "新候选");
  const missingContact = selectedItems.filter((item) => !item.contactInfo.trim()).length;
  if (duplicates.length) {
    toast("所选候选包含已有客户或已入线索记录，请先取消选择", "error");
    return;
  }
  const owner = state.user?.name || "当前账号";
  const sourceSummary = [...new Set(selectedItems.map((item) => item.sourceLabel || item.source || "官网导入"))].join("、");
  if (!window.confirm([
    `确认将 ${opportunities.length} 条候选加入线索中心？`,
    `来源：${sourceSummary}`,
    `归属人：${owner}`,
    `重复预检：未发现已知客户或已入线索记录`,
    `缺少联系方式：${missingContact} 条`,
    "加入后再创建首个正式跟进待办。"
  ].join("\n"))) return;
  if (button) {
    button.disabled = true;
    button.textContent = "加入中";
  }
  try {
    const result = await api<{ created: LeadSyncResult[] }>("/api/tools/website-scrape/sync-opportunities", {
      method: "POST",
      body: JSON.stringify({ opportunities })
    });
    result.created.forEach((item) => {
      if (!state.leads.some((lead) => lead.id === item.lead.id)) state.leads.unshift(item.lead);
      const existing = state.websiteOpportunities.find((row) => row.id === item.opportunity.id || row.website === item.opportunity.website);
      if (existing) Object.assign(existing, item.opportunity);
      else state.websiteOpportunities.unshift(item.opportunity);
    });
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    renderLeads();
    const duplicateCount = result.created.filter((item) => item.duplicate).length;
    const createdCount = result.created.length - duplicateCount;
    toast(`线索处理完成：新建 ${createdCount} 条，重复 ${duplicateCount} 条`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "加入线索中心";
    }
  }
}

async function createLeadFinderTodos(button?: HTMLButtonElement) {
  const opportunities = collectLeadFinderRows();
  if (!opportunities.length) {
    toast("请先勾选需要跟进的候选客户", "error");
    return;
  }
  const unsynced = opportunities.filter((item) => state.websiteOpportunities.find((row) => row.id === item.id)?.status !== "synced");
  if (unsynced.length) {
    toast("请先确认并加入线索，再创建首个正式待办", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "生成中";
  }
  try {
    const created: Todo[] = [];
    for (const item of opportunities) {
      const synced = state.websiteOpportunities.find((row) => row.id === item.id);
      const result = await api<{ todo: Todo }>("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          title: `首次跟进线索：${item.company}`,
          type: "customer",
          priority: "medium",
          dueAt: currentDateTimeText(),
          related: `${synced?.leadId || item.id} · ${item.company}`
        })
      });
      created.push(result.todo);
    }
    state.todos.unshift(...created);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    renderTopbarStats();
    toast(`已生成 ${created.length} 条首个跟进待办`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "生成待办";
    }
  }
}

function exportLeadFinderRows() {
  const rows = collectLeadFinderRows();
  const source = rows.length ? rows : state.websiteOpportunities;
  if (!source.length) {
    toast("暂无搜客结果可导出", "error");
    return;
  }
  const worksheet = XLSX.utils.json_to_sheet(source.map((item) => ({
    "公司名": item.company,
    "业务": item.business,
    "国家": item.country,
    "官网": item.website,
    "联系人": item.contact,
    "联系方式": item.contactInfo,
    "说明": item.description,
    "评分": "status" in item ? leadFinderScore(item as WebsiteOpportunity) : "",
    "状态": "status" in item ? ((item as WebsiteOpportunity).status === "synced" ? "已同步" : "待确认") : "待确认"
  })));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "智能搜客结果");
  XLSX.writeFile(workbook, `GoodJob智能搜客结果-${Date.now()}.xlsx`);
  toast("搜客结果已导出");
}

async function parseWebsiteOpportunities(button?: HTMLButtonElement) {
  const input = qs<HTMLTextAreaElement>("#websiteUrlInput");
  const urls = (input?.value || "").split(/\n|,|，/).map((item) => item.trim()).filter(Boolean);
  const useAi = Boolean(qs<HTMLInputElement>("#websiteUseAiInput")?.checked);
  if (!urls.length) {
    toast("请先粘贴官网地址", "error");
    return;
  }
  if (useAi && (!state.aiConfig?.enabled || !state.aiConfig?.hasApiKey || !state.aiConfig?.useWebsiteParse)) {
    toast("请先保存并启用 AI 配置，或关闭本次 AI 解析", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = useAi ? "AI解析中" : "解析中";
  }
  try {
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-scrape/preview", {
      method: "POST",
      body: JSON.stringify({ urls, useAi })
    });
    const existing = state.websiteOpportunities
      .filter((item) => !result.opportunities.some((next) => next.website === item.website))
      .map((item) => ({ ...item, selected: false }));
    state.websiteOpportunities = [...result.opportunities.map((item) => ({ ...item, selected: true })), ...existing];
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    toast(`${useAi ? "AI增强" : "规则"}已解析 ${result.opportunities.length} 个官网`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "解析官网";
    }
  }
}

async function syncWebsiteOpportunities(button?: HTMLButtonElement) {
  const opportunities = collectWebsiteRows();
  if (!opportunities.length) {
    toast("请至少勾选一条官网线索候选", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "加入中";
  }
  try {
    const result = await api<{ created: LeadSyncResult[] }>("/api/tools/website-scrape/sync-opportunities", {
      method: "POST",
      body: JSON.stringify({ opportunities })
    });
    result.created.forEach((item) => {
      if (!state.leads.some((lead) => lead.id === item.lead.id)) state.leads.unshift(item.lead);
      const existing = state.websiteOpportunities.find((row) => row.id === item.opportunity.id || row.website === item.opportunity.website);
      if (existing) Object.assign(existing, item.opportunity);
      else state.websiteOpportunities.unshift(item.opportunity);
    });
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    renderLeads();
    toast(`已加入 ${result.created.length} 条线索`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "加入线索中心";
    }
  }
}

function openTodoModal(prefill = "", editing?: Todo) {
  const titleValue = editing?.title || prefill;
  openModal(editing ? "编辑待办" : "新增待办", `
    <div class="form-grid">
      <div class="form-field full"><label>待办内容</label><input id="todoTitleInput" value="${escapeHtml(titleValue)}" placeholder="例如：明天 10 点跟进重点客户报价"></div>
      <div class="form-field"><label>类型</label><select id="todoTypeInput"><option value="other">其它</option><option value="customer">客户跟进</option><option value="knowledge">资料维护</option><option value="exam">在线考试</option><option value="ocr">OCR 线索</option></select></div>
      <div class="form-field"><label>优先级</label><select id="todoPriorityInput"><option value="normal">普通</option><option value="medium">中优先级</option><option value="high">高优先级</option></select></div>
      <div class="form-field"><label>目标完成时间</label><input id="todoDueInput" value="${escapeHtml(editing?.dueAt || "")}" placeholder="例如：2026-06-27 18:00"></div>
      <div class="form-field"><label>关联对象</label><input id="todoRelatedInput" value="${escapeHtml(editing?.related || "")}" placeholder="可选：客户、商机、资料或考试名称"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveTodoButton">${editing ? "保存修改" : "保存待办"}</button>`);
  qs<HTMLSelectElement>("#todoTypeInput")!.value = editing?.type || "other";
  qs<HTMLSelectElement>("#todoPriorityInput")!.value = editing?.priority || "normal";
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveTodoButton")?.addEventListener("click", () => void saveTodo(editing?.id));
  qsa<HTMLInputElement | HTMLSelectElement>("#todoTitleInput, #todoTypeInput, #todoPriorityInput, #todoDueInput, #todoRelatedInput").forEach((node) => {
    node.addEventListener("keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== "Enter" || keyboardEvent.isComposing) return;
      event.preventDefault();
      void saveTodo(editing?.id);
    });
  });
  qs<HTMLInputElement>("#todoTitleInput")?.focus();
}

async function saveTodo(id?: string) {
  const title = qs<HTMLInputElement>("#todoTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写待办内容", "error");
    return;
  }
  const payload = {
    title,
    type: qs<HTMLSelectElement>("#todoTypeInput")?.value || "other",
    priority: qs<HTMLSelectElement>("#todoPriorityInput")?.value || "normal",
    dueAt: qs<HTMLInputElement>("#todoDueInput")?.value.trim() || "",
    related: qs<HTMLInputElement>("#todoRelatedInput")?.value.trim() || ""
  };
  const result = await api<{ todo: Todo }>(id ? `/api/todos/${id}` : "/api/todos", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(payload)
  });
  if (id) {
    const todo = state.todos.find((item) => item.id === id);
    if (todo) Object.assign(todo, result.todo);
  } else {
    state.todos.unshift(result.todo);
  }
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  closeModal();
  toast(id ? "待办已更新" : "待办已新增");
}

async function createQuickTodo(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return;
  const result = await api<{ todo: Todo }>("/api/todos", {
    method: "POST",
    body: JSON.stringify({
      title: trimmed,
      type: "other",
      priority: "normal",
      dueAt: "",
      related: ""
    })
  });
  state.todos.unshift(result.todo);
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  toast("待办已新增");
}

function planTaskPriorityText(priority: PlanTask["priority"]) {
  return priority === "high" ? "高优先级" : priority === "medium" ? "中优先级" : "普通";
}

function planTaskStatusText(status: PlanTask["status"]) {
  return status === "active" ? "进行中" : status === "done" ? "已完成" : status === "cancelled" ? "已取消" : "计划中";
}

function parsePlanTaskDate(value: string) {
  const matched = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!matched) return null;
  const [, year, month, day, hour, minute] = matched;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (
    date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)
    || date.getHours() !== Number(hour)
    || date.getMinutes() !== Number(minute)
  ) return null;
  return date;
}

function planTaskWeekRange(reference = new Date()) {
  const start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const offset = start.getDay() === 0 ? 6 : start.getDay() - 1;
  start.setDate(start.getDate() - offset);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

function sameLocalDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function planTaskTimeState(task: PlanTask, now = new Date()) {
  const due = parsePlanTaskDate(task.dueAt);
  if (!due) return "unplanned" as const;
  if (sameLocalDay(due, now)) return "today" as const;
  if (due.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) return "overdue" as const;
  const week = planTaskWeekRange(now);
  if (due >= week.start && due < week.end) return "week" as const;
  return "future" as const;
}

function formatPlanTaskTime(value?: string) {
  if (!value) return "未排期";
  const date = parsePlanTaskDate(value) || new Date(value);
  if (!Number.isFinite(date.getTime())) return "未排期";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function localDateTimeValue(date = new Date(Date.now() + 60 * 60 * 1000)) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function planTaskRelationLabel(task: PlanTask) {
  if (task.leadId) {
    const lead = state.leads.find((item) => item.id === task.leadId);
    return lead ? `线索 · ${lead.company}` : "线索 · 已不可见";
  }
  const customer = state.customers.find((item) => item.id === task.customerId);
  const deal = state.deals.find((item) => item.id === task.dealId);
  if (deal) return `${customer?.company || "客户"} · ${deal.title}`;
  if (customer) return `客户 · ${customer.company}`;
  return "未关联业务";
}

function planTaskStatusTone(status: PlanTask["status"]) {
  return status === "done" ? "green" : status === "cancelled" ? "red" : status === "active" ? "amber" : "";
}

const instrumentWeekTodos = [
  "第1天：整理仪表产品分类与参数卡",
  "第1天：建立仪表客户搜索关键词库10组",
  "第2天：整理公司证书与报价资料清单",
  "第2天：新增30家仪表目标客户到客户池",
  "第3天：完成客户角色-痛点-话术表",
  "第3天：首触达20家高匹配客户",
  "第4天：整理竞品替代切入点5条",
  "第4天：跟进昨日未回复客户10家",
  "第5天：制作参数确认表模板",
  "第5天：深挖3家A类客户并写入CRM",
  "第6天：完成第一周开发周报",
  "第7天：复盘并优化ICP规则"
];

const instrumentMemoTitle = "计划任务执行方案";

function instrumentPlanMemoContent() {
  return [
    "90天总目标：600+目标客户池，900+有效触达，60个有效回复，20个深度沟通，8个RFQ/样品/会议机会。",
    "",
    "每日最低动作：新增客户30家，首触达20家，二次跟进10家，深挖3家A类客户，CRM更新30条，15分钟复盘。",
    "",
    "前置知识：压力/温度/流量/液位/分析仪表/记录仪；量程、精度、介质、温压、连接方式、输出信号、供电、防护等级、材质；CE、RoHS、EMC、ATEX/IECEx、防爆、SIL、校准证书、ISO、材质报告。",
    "",
    "客户画像：工业自动化经销商、系统集成商、OEM设备厂、EPC/工程承包商、MRO维修服务商、终端工厂采购/工程师。",
    "",
    "周报结构：新增客户池、有效触达、有效回复、深度沟通、RFQ/样品/会议机会、问题与改进、下周计划。"
  ].join("\n");
}

function planTemplatePlanTitle(template: PlanTemplate) {
  return `${template.section === "knowledge" ? "训练" : template.section === "execution" ? "首周执行" : "客户画像"}：${template.title}`;
}

function renderPlanTemplates(templates = state.planTemplates) {
  const knowledge = qs<HTMLElement>("#knowledgeTemplateList");
  const persona = qs<HTMLElement>("#personaTemplateList");
  const execution = qs<HTMLElement>("#executionTemplateList");
  if (!knowledge || !persona || !execution) return;
  const sorted = [...templates].sort((left, right) => left.sortOrder - right.sortOrder);
  const knowledgeItems = sorted.filter((item) => item.section === "knowledge");
  const personaItems = sorted.filter((item) => item.section === "persona");
  const executionItems = sorted.filter((item) => item.section === "execution");
  knowledge.innerHTML = knowledgeItems.length ? knowledgeItems.map((item, index) => `
    <div class="knowledge-row" data-plan-template-id="${escapeHtml(item.id)}">
      <strong>${String(index + 1).padStart(2, "0")}</strong>
      <div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.summary)}</span></div>
      <em>${escapeHtml(item.output || "输出物：待维护")}</em>
      <div class="template-actions">
        <button class="btn compact" data-plan-template-add="${escapeHtml(item.id)}">加入计划</button>
        <button class="btn compact" data-plan-template-edit="${escapeHtml(item.id)}">编辑</button>
        <button class="btn compact danger" data-plan-template-delete="${escapeHtml(item.id)}">删除</button>
      </div>
    </div>
  `).join("") : `<div class="empty-state"><b>暂无前置知识训练项</b><span>可在后续版本中新增模板，当前先使用计划任务手动维护。</span></div>`;
  persona.innerHTML = personaItems.length ? personaItems.map((item) => {
    const [keyword = "", action = ""] = item.output.split("\n");
    return `
      <article class="persona-card" data-plan-template-id="${escapeHtml(item.id)}">
        <div class="persona-head"><b>${escapeHtml(item.title)}</b><span class="badge ${escapeHtml(item.badgeTone)}">${escapeHtml(item.badge || "画像")}</span></div>
        <p>${escapeHtml(item.summary)}</p>
        <dl><dt>关键词</dt><dd>${escapeHtml(keyword.replace(/^关键词[:：]\s*/, "") || "待维护")}</dd><dt>首触达</dt><dd>${escapeHtml(action.replace(/^首触达[:：]\s*/, "") || "待维护")}</dd></dl>
        <div class="template-actions"><button class="btn compact" data-plan-template-add="${escapeHtml(item.id)}">加入计划</button><button class="btn compact" data-plan-template-edit="${escapeHtml(item.id)}">编辑</button><button class="btn compact danger" data-plan-template-delete="${escapeHtml(item.id)}">删除</button></div>
      </article>
    `;
  }).join("") : `<div class="empty-state"><b>暂无客户画像</b><span>可在后续版本中新增模板，当前先使用计划任务手动维护。</span></div>`;
  execution.innerHTML = executionItems.length ? executionItems.map((item) => `
    <div class="execution-day" data-plan-template-id="${escapeHtml(item.id)}">
      <div class="execution-title-row"><h3>${escapeHtml(item.title)}</h3><span class="badge ${escapeHtml(item.badgeTone)}">${escapeHtml(item.badge || "执行")}</span></div>
      <ul>${(item.output || item.summary).split("\n").filter(Boolean).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      <div class="template-actions"><button class="btn compact" data-plan-template-add="${escapeHtml(item.id)}">加入计划</button><button class="btn compact" data-plan-template-edit="${escapeHtml(item.id)}">编辑</button></div>
    </div>
  `).join("") : `<div class="empty-state"><b>暂无首周执行拆解</b><span>可编辑模板恢复首周节奏。</span></div>`;
  qsa<HTMLButtonElement>("[data-plan-template-add]").forEach((button) => button.addEventListener("click", () => void createPlanTaskFromTemplate(button.dataset.planTemplateAdd || "", button)));
  qsa<HTMLButtonElement>("[data-plan-template-edit]").forEach((button) => button.addEventListener("click", () => openPlanTemplateModal(state.planTemplates.find((item) => item.id === button.dataset.planTemplateEdit))));
  qsa<HTMLButtonElement>("[data-plan-template-delete]").forEach((button) => button.addEventListener("click", () => void deletePlanTemplate(button.dataset.planTemplateDelete || "")));
}

function renderPlanTasks(tasks = state.planTasks) {
  const container = qs<HTMLElement>("#planTaskList");
  if (!container) return;
  const sorted = [...tasks].sort((left, right) => {
    const statusWeight = { active: 0, planned: 1, done: 2, cancelled: 3 } as Record<PlanTask["status"], number>;
    const priorityWeight = { high: 0, medium: 1, normal: 2 } as Record<PlanTask["priority"], number>;
    const leftDue = parsePlanTaskDate(left.dueAt)?.getTime() || Number.MAX_SAFE_INTEGER;
    const rightDue = parsePlanTaskDate(right.dueAt)?.getTime() || Number.MAX_SAFE_INTEGER;
    return statusWeight[left.status] - statusWeight[right.status]
      || priorityWeight[left.priority] - priorityWeight[right.priority]
      || leftDue - rightDue
      || String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  });
  const stats = qs<HTMLElement>("#planTaskStats");
  if (stats) {
    const active = tasks.filter((task) => task.status === "active").length;
    const done = tasks.filter((task) => task.status === "done").length;
    stats.innerHTML = `
      <div><span>任务总数</span><b>${tasks.length}</b></div>
      <div><span>进行中</span><b>${active}</b></div>
      <div><span>已完成</span><b>${done}</b></div>
      <div><span>可推待办</span><b>${tasks.filter((task) => task.status === "planned" || task.status === "active").length}</b></div>
    `;
  }
  container.innerHTML = sorted.length ? `
    <table class="plan-task-table">
      <thead><tr><th><input id="planTaskSelectAll" type="checkbox" aria-label="全选计划任务"></th><th>任务</th><th>阶段/分类</th><th>业务关联</th><th>目标/结果</th><th>状态/时间</th><th>操作</th></tr></thead>
      <tbody>
        ${sorted.map((task) => {
    const result = task.status === "done"
      ? task.completionResult || "未记录完成结果"
      : task.status === "cancelled"
        ? task.cancellationReason || "未记录取消原因"
        : task.target || task.description || "未填写验收目标";
    const open = task.status === "planned" || task.status === "active";
    return `
          <tr data-plan-task-id="${escapeHtml(task.id)}">
            <td><input type="checkbox" data-plan-task-check="${escapeHtml(task.id)}" ${state.selectedPlanTaskIds.includes(task.id) ? "checked" : ""} aria-label="选择${escapeHtml(task.title)}"></td>
            <td class="plan-title-cell"><b>${escapeHtml(task.title)}</b><small>${escapeHtml(task.description || "暂无执行说明")}</small></td>
            <td><span class="badge aqua">${escapeHtml(task.phase)}</span><small>${escapeHtml(task.category)}</small></td>
            <td><b>${escapeHtml(planTaskRelationLabel(task))}</b><small>${task.rescheduleReason ? `最近改期：${escapeHtml(task.rescheduleReason)}` : "仅本人可见"}</small></td>
            <td><b>${escapeHtml(result)}</b><small>${task.status === "done" && task.completedAt ? `完成于 ${escapeHtml(formatDateTime(task.completedAt))}` : task.status === "cancelled" && task.cancelledAt ? `取消于 ${escapeHtml(formatDateTime(task.cancelledAt))}` : "完成时记录真实结果"}</small></td>
            <td><span class="badge ${planTaskStatusTone(task.status)}">${planTaskStatusText(task.status)}</span><small>${planTaskPriorityText(task.priority)} · ${escapeHtml(formatPlanTaskTime(task.dueAt))}</small></td>
            <td class="row-actions">
              ${open ? `<button class="btn compact" data-plan-push="${escapeHtml(task.id)}">推待办</button><button class="btn compact primary" data-plan-complete="${escapeHtml(task.id)}">完成</button><button class="btn compact" data-plan-reschedule="${escapeHtml(task.id)}">改期</button><button class="btn compact" data-plan-edit="${escapeHtml(task.id)}">编辑</button><button class="btn compact" data-plan-cancel="${escapeHtml(task.id)}">取消</button>` : ""}
              <button class="btn compact danger" data-plan-delete="${escapeHtml(task.id)}">删除</button>
            </td>
          </tr>
    `;
  }).join("")}
      </tbody>
    </table>
  ` : `<div class="empty-state"><b>还没有计划任务</b><span>先新增一条开拓任务，再推送到待办执行。</span><button class="btn primary plan-empty-action" data-plan-empty-new>新增任务</button></div>`;
  qs<HTMLInputElement>("#planTaskSelectAll")?.addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    state.selectedPlanTaskIds = checked ? sorted.map((task) => task.id) : [];
    renderPlanTasks(state.planTasks);
  });
  qsa<HTMLInputElement>("[data-plan-task-check]", container).forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.dataset.planTaskCheck || "";
      state.selectedPlanTaskIds = input.checked
        ? Array.from(new Set([...state.selectedPlanTaskIds, id]))
        : state.selectedPlanTaskIds.filter((item) => item !== id);
    });
  });
  qsa<HTMLButtonElement>("[data-plan-edit]", container).forEach((button) => button.addEventListener("click", () => openPlanTaskModal(state.planTasks.find((task) => task.id === button.dataset.planEdit))));
  qsa<HTMLButtonElement>("[data-plan-delete]", container).forEach((button) => button.addEventListener("click", () => void deletePlanTask(button.dataset.planDelete || "")));
  qsa<HTMLButtonElement>("[data-plan-complete]", container).forEach((button) => button.addEventListener("click", () => openPlanTaskCompleteModal(button.dataset.planComplete || "")));
  qsa<HTMLButtonElement>("[data-plan-cancel]", container).forEach((button) => button.addEventListener("click", () => openPlanTaskCancelModal(button.dataset.planCancel || "")));
  qsa<HTMLButtonElement>("[data-plan-reschedule]", container).forEach((button) => button.addEventListener("click", () => openPlanTaskRescheduleModal(button.dataset.planReschedule || "")));
  qsa<HTMLButtonElement>("[data-plan-push]", container).forEach((button) => button.addEventListener("click", () => void pushPlanTasksToTodos([button.dataset.planPush || ""], button)));
  qs<HTMLButtonElement>("[data-plan-empty-new]", container)?.addEventListener("click", () => openPlanTaskModal());
}

function openPlanTaskModal(task?: PlanTask) {
  const editing = Boolean(task);
  if (task && (task.status === "done" || task.status === "cancelled")) {
    toast("已结束任务只保留结果记录，不能再编辑", "error");
    return;
  }
  const relationType = task?.leadId ? "lead" : task?.dealId ? "deal" : task?.customerId ? "customer" : "none";
  const leadOptions = state.leads
    .filter((lead) => !lead.deletedAt && lead.status !== "converted")
    .map((lead) => `<option value="${escapeHtml(lead.id)}" ${task?.leadId === lead.id ? "selected" : ""}>${escapeHtml(lead.company)} · ${escapeHtml(lead.contact || "待维护")}</option>`)
    .join("");
  const customerOptions = state.customers
    .map((customer) => `<option value="${escapeHtml(customer.id)}" ${task?.customerId === customer.id ? "selected" : ""}>${escapeHtml(customer.company)}</option>`)
    .join("");
  openModal(editing ? "编辑计划任务" : "新增计划任务", `
    <div class="form-grid">
      <div class="form-field full"><label>任务标题</label><input id="planTaskTitleInput" value="${escapeHtml(task?.title || "")}" placeholder="例如：跟进 Nordic Tools 报价反馈"></div>
      <div class="form-field full"><label>计划时间</label><input id="planTaskDueInput" type="datetime-local" value="${escapeHtml(task?.dueAt || localDateTimeValue())}"></div>
    </div>
    <details class="modal-advanced">
      <summary>更多设置</summary>
      <div class="form-grid" style="margin-top:12px">
        <div class="form-field"><label>关联类型</label><select id="planTaskRelationType"><option value="none" ${relationType === "none" ? "selected" : ""}>不关联</option><option value="lead" ${relationType === "lead" ? "selected" : ""}>线索</option><option value="customer" ${relationType === "customer" ? "selected" : ""}>客户</option><option value="deal" ${relationType === "deal" ? "selected" : ""}>客户 + 商机</option></select></div>
        <div class="form-field"><label>优先级</label><select id="planTaskPriorityInput"><option value="high" ${task?.priority === "high" ? "selected" : ""}>高</option><option value="medium" ${task?.priority === "medium" ? "selected" : ""}>中</option><option value="normal" ${!task || task.priority === "normal" ? "selected" : ""}>普通</option></select></div>
        <div class="form-field full" id="planTaskLeadField"><label>关联线索</label><select id="planTaskLeadInput"><option value="">请选择线索</option>${leadOptions}</select></div>
        <div class="form-field" id="planTaskCustomerField"><label>关联客户</label><select id="planTaskCustomerInput"><option value="">请选择客户</option>${customerOptions}</select></div>
        <div class="form-field" id="planTaskDealField"><label>关联商机</label><select id="planTaskDealInput"></select></div>
        <div class="form-field"><label>执行状态</label><select id="planTaskStatusInput"><option value="planned" ${!task || task.status === "planned" ? "selected" : ""}>计划中</option><option value="active" ${task?.status === "active" ? "selected" : ""}>进行中</option></select></div>
        <div class="form-field full"><label>验收目标</label><input id="planTaskTargetInput" value="${escapeHtml(task?.target || "")}" placeholder="做到什么程度才算完成"></div>
        <div class="form-field full"><label>执行说明</label><textarea id="planTaskDescriptionInput" rows="4" placeholder="可选：关键口径、资料要求或注意事项">${escapeHtml(task?.description || "")}</textarea></div>
      </div>
    </details>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="savePlanTaskButton" data-editing-id="${escapeHtml(task?.id || "")}">${editing ? "保存修改" : "保存任务"}</button>`);
  const relationSelect = qs<HTMLSelectElement>("#planTaskRelationType");
  const customerSelect = qs<HTMLSelectElement>("#planTaskCustomerInput");
  const dealSelect = qs<HTMLSelectElement>("#planTaskDealInput");
  const updateDealOptions = () => {
    if (!dealSelect || !customerSelect) return;
    const deals = state.deals.filter((deal) => !customerSelect.value || deal.customerId === customerSelect.value);
    dealSelect.innerHTML = `<option value="">请选择商机</option>${deals.map((deal) => `<option value="${escapeHtml(deal.id)}" ${task?.dealId === deal.id ? "selected" : ""}>${escapeHtml(deal.title)}</option>`).join("")}`;
  };
  const updateRelationFields = () => {
    const value = relationSelect?.value || "none";
    const leadField = qs<HTMLElement>("#planTaskLeadField");
    const customerField = qs<HTMLElement>("#planTaskCustomerField");
    const dealField = qs<HTMLElement>("#planTaskDealField");
    if (leadField) leadField.hidden = value !== "lead";
    if (customerField) customerField.hidden = value !== "customer" && value !== "deal";
    if (dealField) dealField.hidden = value !== "deal";
    if (value === "deal") updateDealOptions();
  };
  relationSelect?.addEventListener("change", updateRelationFields);
  customerSelect?.addEventListener("change", updateDealOptions);
  dealSelect?.addEventListener("change", () => {
    const deal = state.deals.find((item) => item.id === dealSelect.value);
    if (deal && customerSelect) {
      customerSelect.value = deal.customerId;
      updateDealOptions();
      dealSelect.value = deal.id;
    }
  });
  updateRelationFields();
  qs("#savePlanTaskButton")?.addEventListener("click", () => void savePlanTask());
  qs<HTMLInputElement>("#planTaskTitleInput")?.focus();
}

async function savePlanTask() {
  const title = qs<HTMLInputElement>("#planTaskTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写任务标题", "error");
    return;
  }
  const saveButton = qs<HTMLButtonElement>("#savePlanTaskButton");
  const editingId = saveButton?.dataset.editingId || "";
  const relationType = qs<HTMLSelectElement>("#planTaskRelationType")?.value || "none";
  const leadId = relationType === "lead" ? qs<HTMLSelectElement>("#planTaskLeadInput")?.value || "" : "";
  const customerId = relationType === "customer" || relationType === "deal" ? qs<HTMLSelectElement>("#planTaskCustomerInput")?.value || "" : "";
  const dealId = relationType === "deal" ? qs<HTMLSelectElement>("#planTaskDealInput")?.value || "" : "";
  if (relationType === "lead" && !leadId) {
    toast("请选择关联线索", "error");
    return;
  }
  if ((relationType === "customer" || relationType === "deal") && !customerId) {
    toast("请选择关联客户", "error");
    return;
  }
  if (relationType === "deal" && !dealId) {
    toast("请选择关联商机", "error");
    return;
  }
  const payload = {
    title,
    phase: "计划任务",
    category: "客户开发",
    priority: (qs<HTMLSelectElement>("#planTaskPriorityInput")?.value || "normal") as PlanTask["priority"],
    status: (qs<HTMLSelectElement>("#planTaskStatusInput")?.value || "planned") as PlanTask["status"],
    dueAt: qs<HTMLInputElement>("#planTaskDueInput")?.value.trim() || "",
    target: qs<HTMLInputElement>("#planTaskTargetInput")?.value.trim() || "",
    description: qs<HTMLTextAreaElement>("#planTaskDescriptionInput")?.value.trim() || "",
    leadId,
    customerId,
    dealId
  };
  if (saveButton) saveButton.disabled = true;
  try {
    const result = await api<{ task: PlanTask }>(editingId ? `/api/plan-tasks/${editingId}` : "/api/plan-tasks", {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    state.planTasks = editingId ? state.planTasks.map((task) => task.id === result.task.id ? result.task : task) : [result.task, ...state.planTasks];
    renderPlanTasks(state.planTasks);
    closeModal();
    toast(editingId ? "计划任务已保存" : "计划任务已新增");
  } catch (error) {
    toast(error instanceof Error ? error.message : "计划任务保存失败", "error");
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

function replacePlanTask(updated: PlanTask) {
  state.planTasks = state.planTasks.map((task) => task.id === updated.id ? updated : task);
  renderPlanTasks(state.planTasks);
}

function openPlanTaskCompleteModal(id: string) {
  const task = state.planTasks.find((item) => item.id === id);
  if (!task) return;
  openModal("完成并记录结果", `
    <div class="form-grid">
      <div class="form-field full"><label>任务</label><input value="${escapeHtml(task.title)}" disabled></div>
      <div class="form-field full"><label>完成结果</label><textarea id="planTaskCompleteResult" rows="5" placeholder="例如：客户确认参数，已发送新版报价，预计周五回复"></textarea></div>
    </div>
    <div class="template-actions" style="justify-content:flex-start;margin-top:10px">
      <button class="btn compact" type="button" data-plan-result-preset="已完成触达，等待客户回复。">已触达</button>
      <button class="btn compact" type="button" data-plan-result-preset="客户已回复，需求与关键参数已记录。">已回复</button>
      <button class="btn compact" type="button" data-plan-result-preset="已完成报价或资料发送，并约定下一步。">已报价/发资料</button>
    </div>
  `, `<button class="btn" data-modal-close>暂不完成</button><button class="btn primary" id="confirmPlanTaskComplete">确认完成</button>`);
  qsa<HTMLButtonElement>("[data-plan-result-preset]").forEach((button) => button.addEventListener("click", () => {
    const input = qs<HTMLTextAreaElement>("#planTaskCompleteResult");
    if (input) {
      input.value = button.dataset.planResultPreset || "";
      input.focus();
    }
  }));
  qs<HTMLButtonElement>("#confirmPlanTaskComplete")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const result = qs<HTMLTextAreaElement>("#planTaskCompleteResult")?.value.trim() || "";
    if (!result) {
      toast("请记录完成结果", "error");
      return;
    }
    button.disabled = true;
    try {
      const response = await api<{ task: PlanTask }>(`/api/plan-tasks/${id}/complete`, {
        method: "POST",
        body: JSON.stringify({ result })
      });
      replacePlanTask(response.task);
      closeModal();
      toast("任务已完成，结果已记录");
    } catch (error) {
      toast(error instanceof Error ? error.message : "任务完成失败", "error");
      button.disabled = false;
    }
  });
  qs<HTMLTextAreaElement>("#planTaskCompleteResult")?.focus();
}

function openPlanTaskCancelModal(id: string) {
  const task = state.planTasks.find((item) => item.id === id);
  if (!task) return;
  openModal("取消计划任务", `
    <div class="form-grid">
      <div class="form-field full"><label>任务</label><input value="${escapeHtml(task.title)}" disabled></div>
      <div class="form-field full"><label>取消原因</label><textarea id="planTaskCancelReason" rows="4" placeholder="说明为什么不再执行，便于后续复盘"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>返回</button><button class="btn danger" id="confirmPlanTaskCancel">确认取消</button>`);
  qs<HTMLButtonElement>("#confirmPlanTaskCancel")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const reason = qs<HTMLTextAreaElement>("#planTaskCancelReason")?.value.trim() || "";
    if (!reason) {
      toast("请填写取消原因", "error");
      return;
    }
    button.disabled = true;
    try {
      const response = await api<{ task: PlanTask }>(`/api/plan-tasks/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason })
      });
      replacePlanTask(response.task);
      closeModal();
      toast("任务已取消，原因已记录");
    } catch (error) {
      toast(error instanceof Error ? error.message : "任务取消失败", "error");
      button.disabled = false;
    }
  });
  qs<HTMLTextAreaElement>("#planTaskCancelReason")?.focus();
}

function openPlanTaskRescheduleModal(id: string) {
  const task = state.planTasks.find((item) => item.id === id);
  if (!task) return;
  const overdue = planTaskTimeState(task) === "overdue";
  openModal("调整计划时间", `
    <div class="form-grid">
      <div class="form-field full"><label>任务</label><input value="${escapeHtml(task.title)}" disabled></div>
      <div class="form-field full"><label>新的计划时间</label><input id="planTaskRescheduleDue" type="datetime-local" value="${escapeHtml(task.dueAt || localDateTimeValue())}"></div>
      <div class="form-field full"><label>改期原因${overdue ? "（逾期任务必填）" : "（选填）"}</label><textarea id="planTaskRescheduleReason" rows="3" placeholder="例如：等待客户补充技术参数"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>返回</button><button class="btn primary" id="confirmPlanTaskReschedule">确认改期</button>`);
  qs<HTMLButtonElement>("#confirmPlanTaskReschedule")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const dueAt = qs<HTMLInputElement>("#planTaskRescheduleDue")?.value || "";
    const reason = qs<HTMLTextAreaElement>("#planTaskRescheduleReason")?.value.trim() || "";
    if (!dueAt) {
      toast("请选择新的计划时间", "error");
      return;
    }
    if (overdue && !reason) {
      toast("逾期任务请填写改期原因", "error");
      return;
    }
    button.disabled = true;
    try {
      const response = await api<{ task: PlanTask }>(`/api/plan-tasks/${id}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ dueAt, reason })
      });
      replacePlanTask(response.task);
      closeModal();
      toast("计划时间已调整");
    } catch (error) {
      toast(error instanceof Error ? error.message : "任务改期失败", "error");
      button.disabled = false;
    }
  });
}

function openPlanTemplateModal(template?: PlanTemplate) {
  if (!template) return;
  openModal("编辑模板", `
    <div class="form-grid">
      <div class="form-field"><label>模块</label><select id="planTemplateSectionInput"><option value="knowledge" ${template.section === "knowledge" ? "selected" : ""}>前置知识</option><option value="persona" ${template.section === "persona" ? "selected" : ""}>客户画像</option><option value="execution" ${template.section === "execution" ? "selected" : ""}>首周执行</option></select></div>
      <div class="form-field"><label>排序</label><input id="planTemplateSortInput" type="number" value="${template.sortOrder}"></div>
      <div class="form-field full"><label>标题</label><input id="planTemplateTitleInput" value="${escapeHtml(template.title)}"></div>
      <div class="form-field full"><label>说明</label><textarea id="planTemplateSummaryInput" rows="4">${escapeHtml(template.summary)}</textarea></div>
      <div class="form-field full"><label>输出物 / 关键词与首触达</label><textarea id="planTemplateOutputInput" rows="3" placeholder="客户画像可写两行：关键词：... / 首触达：...">${escapeHtml(template.output)}</textarea></div>
      <div class="form-field"><label>标签</label><input id="planTemplateBadgeInput" value="${escapeHtml(template.badge)}"></div>
      <div class="form-field"><label>标签颜色</label><select id="planTemplateToneInput"><option value="" ${!template.badgeTone ? "selected" : ""}>默认</option><option value="green" ${template.badgeTone === "green" ? "selected" : ""}>绿色</option><option value="aqua" ${template.badgeTone === "aqua" ? "selected" : ""}>蓝绿</option><option value="amber" ${template.badgeTone === "amber" ? "selected" : ""}>橙色</option><option value="red" ${template.badgeTone === "red" ? "selected" : ""}>红色</option></select></div>
      <div class="form-field"><label>计划阶段</label><input id="planTemplatePhaseInput" value="${escapeHtml(template.phase)}"></div>
      <div class="form-field"><label>计划分类</label><input id="planTemplateCategoryInput" value="${escapeHtml(template.category)}"></div>
      <div class="form-field"><label>优先级</label><select id="planTemplatePriorityInput"><option value="high" ${template.priority === "high" ? "selected" : ""}>高</option><option value="medium" ${template.priority === "medium" ? "selected" : ""}>中</option><option value="normal" ${template.priority === "normal" ? "selected" : ""}>普通</option></select></div>
      <div class="form-field full"><label>加入计划后的验收目标</label><input id="planTemplateTargetInput" value="${escapeHtml(template.target)}"></div>
      <div class="form-field full"><label>加入计划后的执行说明</label><textarea id="planTemplateDescriptionInput" rows="4">${escapeHtml(template.description)}</textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="savePlanTemplateButton" data-template-id="${escapeHtml(template.id)}">保存模板</button>`);
  qs("#savePlanTemplateButton")?.addEventListener("click", () => void savePlanTemplate());
  qs<HTMLInputElement>("#planTemplateTitleInput")?.focus();
}

async function savePlanTemplate() {
  const saveButton = qs<HTMLButtonElement>("#savePlanTemplateButton");
  const id = saveButton?.dataset.templateId || "";
  const title = qs<HTMLInputElement>("#planTemplateTitleInput")?.value.trim() || "";
  if (!id || !title) {
    toast("请填写模板标题", "error");
    return;
  }
  const payload = {
    section: (qs<HTMLSelectElement>("#planTemplateSectionInput")?.value || "knowledge") as PlanTemplate["section"],
    title,
    summary: qs<HTMLTextAreaElement>("#planTemplateSummaryInput")?.value.trim() || "",
    output: qs<HTMLTextAreaElement>("#planTemplateOutputInput")?.value.trim() || "",
    badge: qs<HTMLInputElement>("#planTemplateBadgeInput")?.value.trim() || "",
    badgeTone: qs<HTMLSelectElement>("#planTemplateToneInput")?.value || "",
    phase: qs<HTMLInputElement>("#planTemplatePhaseInput")?.value.trim() || "计划任务",
    category: qs<HTMLInputElement>("#planTemplateCategoryInput")?.value.trim() || "客户开发",
    priority: (qs<HTMLSelectElement>("#planTemplatePriorityInput")?.value || "normal") as PlanTemplate["priority"],
    target: qs<HTMLInputElement>("#planTemplateTargetInput")?.value.trim() || "",
    description: qs<HTMLTextAreaElement>("#planTemplateDescriptionInput")?.value.trim() || "",
    sortOrder: Number(qs<HTMLInputElement>("#planTemplateSortInput")?.value || 0)
  };
  const result = await api<{ template: PlanTemplate }>(`/api/plan-templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  state.planTemplates = state.planTemplates.map((item) => item.id === result.template.id ? result.template : item);
  renderPlanTemplates(state.planTemplates);
  closeModal();
  toast("模板已保存");
}

async function deletePlanTemplate(id: string) {
  if (!id || !window.confirm("确认删除这条模板？已生成的计划任务不会被删除。")) return;
  await api(`/api/plan-templates/${id}`, { method: "DELETE" });
  state.planTemplates = state.planTemplates.filter((item) => item.id !== id);
  renderPlanTemplates(state.planTemplates);
  toast("模板已删除");
}

async function createPlanTaskFromTemplate(id: string, button?: HTMLButtonElement) {
  const template = state.planTemplates.find((item) => item.id === id);
  if (!template) return;
  const title = planTemplatePlanTitle(template);
  if (state.planTasks.some((task) => task.title === title)) {
    renderPlanTasks(state.planTasks);
    toast("这条训练任务已在计划中");
    return;
  }
  if (button) button.disabled = true;
  try {
    const result = await api<{ task: PlanTask }>("/api/plan-tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        phase: template.phase || "计划任务",
        category: template.category || "客户开发",
        priority: template.priority || "normal",
        status: "planned",
        dueAt: "",
        target: template.target || "",
        description: template.description || template.summary || ""
      })
    });
    state.planTasks = [result.task, ...state.planTasks];
    state.selectedPlanTaskIds = Array.from(new Set([...state.selectedPlanTaskIds, result.task.id]));
    renderPlanTasks(state.planTasks);
    toast("已加入计划任务");
  } finally {
    if (button) button.disabled = false;
  }
}

async function deletePlanTask(id: string) {
  if (!id || !window.confirm("确认删除这条计划任务？")) return;
  await api(`/api/plan-tasks/${id}`, { method: "DELETE" });
  state.planTasks = state.planTasks.filter((task) => task.id !== id);
  state.selectedPlanTaskIds = state.selectedPlanTaskIds.filter((taskId) => taskId !== id);
  renderPlanTasks(state.planTasks);
  toast("计划任务已删除");
}

async function pushPlanTasksToTodos(ids: string[], button?: HTMLButtonElement) {
  const tasks = ids.map((id) => state.planTasks.find((task) => task.id === id)).filter(Boolean) as PlanTask[];
  const pending = tasks.filter((task) => task.status === "planned" || task.status === "active");
  if (!pending.length) {
    toast("请选择未完成的计划任务", "error");
    return;
  }
  const existingTitles = new Set(state.todos.filter((todo) => !todo.done).map((todo) => todo.title));
  const missing = pending.filter((task) => !existingTitles.has(task.title));
  if (!missing.length) {
    toast("所选计划任务已在待办中");
    return;
  }
  if (button) button.disabled = true;
  try {
    const created: Todo[] = [];
    for (const task of missing) {
      const result = await api<{ todo: Todo }>("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          title: task.title,
          type: "other",
          priority: task.priority,
          dueAt: task.dueAt,
          related: planTaskRelationLabel(task) === "未关联业务" ? `计划任务 / ${task.phase}` : planTaskRelationLabel(task)
        })
      });
      created.push(result.todo);
    }
    state.todos.unshift(...created);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    void refreshDashboardOnly();
    toast(`已推送 ${created.length} 条计划任务到待办`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveInstrumentPlanMemo(button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "写入中";
  }
  try {
    const existing = state.memos.find((memo) => memo.title === instrumentMemoTitle);
    const taskLines = state.planTasks.length
      ? state.planTasks.map((task, index) => `${index + 1}. [${planTaskStatusText(task.status)}][${planTaskPriorityText(task.priority)}] ${task.title} - ${task.completionResult || task.cancellationReason || task.target || task.description || "待补充目标"}`).join("\n")
      : instrumentWeekTodos.map((title, index) => `${index + 1}. ${title}`).join("\n");
    const payload = {
      title: instrumentMemoTitle,
      category: "计划任务",
      tags: "计划任务,外贸开拓,执行计划",
      content: `${instrumentPlanMemoContent()}\n\n当前计划任务：\n${taskLines}`,
      pinned: true
    };
    if (existing) {
      const result = await api<{ memo: Memo }>(`/api/memos/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      Object.assign(existing, result.memo);
      state.selectedMemoId = existing.id;
      toast("计划任务备忘已更新");
    } else {
      const result = await api<{ memo: Memo }>("/api/memos", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      state.memos.unshift(result.memo);
      state.selectedMemoId = result.memo.id;
      toast("计划任务已写入备忘");
    }
    renderMemos(state.memos);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "写入备忘";
    }
  }
}

function exportInstrumentPlanCsv() {
  const taskRows = state.planTasks.map((task) => [
    task.title,
    planTaskPriorityText(task.priority),
    planTaskStatusText(task.status),
    task.dueAt || "",
    planTaskRelationLabel(task),
    task.target || "",
    task.description || "",
    task.completionResult || "",
    task.completedAt || "",
    task.cancellationReason || "",
    task.cancelledAt || "",
    task.rescheduledFrom || "",
    task.rescheduleReason || "",
    task.phase,
    task.category
  ]);
  const rows = [
    ["任务", "优先级", "状态", "计划时间", "业务关联", "验收目标", "执行说明", "完成结果", "完成时间", "取消原因", "取消时间", "改期前时间", "改期原因", "历史阶段", "历史分类"],
    ...taskRows
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "计划任务执行表.csv";
  link.click();
  URL.revokeObjectURL(link.href);
  toast("计划任务执行表已导出");
}

function openCustomerModal(customer?: Customer) {
  const editing = Boolean(customer);
  openModal(editing ? "编辑客户" : "新增客户", `
    <div class="form-grid">
      <div class="form-field full"><label>公司名</label><input id="customerCompanyInput" placeholder="例如：示例进出口有限公司" value="${escapeHtml(customer?.company || "")}"></div>
      <div class="form-field"><label>联系人</label><input id="customerContactInput" value="${escapeHtml(customer?.contact || "待维护")}"></div>
      <div class="form-field"><label>国家</label><input id="customerCountryInput" value="${escapeHtml(customer?.country || "中国")}"></div>
      <div class="form-field"><label>下一提醒</label><input id="customerReminderInput" value="${escapeHtml(customer?.nextReminder || "明天 10:00")}"></div>
      <label class="form-field"><span>企微绑定</span><select id="customerWecomInput"><option value="false" ${customer?.wecomBound ? "" : "selected"}>未绑定</option><option value="true" ${customer?.wecomBound ? "selected" : ""}>已绑定</option></select></label>
      <div class="form-field full"><label>单据抬头</label><input id="customerBillingNameInput" value="${escapeHtml(customer?.billingName || customer?.company || "")}" placeholder="用于对外单据的英文/正式公司名"></div>
      <div class="form-field full"><label>账单地址</label><input id="customerBillingAddressInput" value="${escapeHtml(customer?.billingAddress || "")}" placeholder="公司地址、城市、国家"></div>
      <div class="form-field full"><label>单据联系人</label><input id="customerDocumentContactInput" value="${escapeHtml(customer?.documentContact || customer?.contact || "")}" placeholder="联系人 / 邮箱 / 电话"></div>
      <div class="form-field"><label>默认目的港</label><input id="customerPortDischargeInput" value="${escapeHtml(customer?.defaultPortDischarge || "")}" placeholder="例如 Hamburg"></div>
      <div class="form-field"><label>默认贸易条款</label><input id="customerIncotermInput" value="${escapeHtml(customer?.defaultIncoterm || "FOB Tianjin")}"></div>
      <div class="form-field full"><label>默认付款条款</label><input id="customerPaymentTermInput" value="${escapeHtml(customer?.defaultPaymentTerm || "30% T/T deposit, 70% before shipment")}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCustomerButton" data-editing-id="${escapeHtml(customer?.id || "")}">${editing ? "保存修改" : "保存客户"}</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveCustomerButton")?.addEventListener("click", () => void saveCustomer());
  qs<HTMLInputElement>("#customerCompanyInput")?.focus();
}

async function saveCustomer() {
  const company = qs<HTMLInputElement>("#customerCompanyInput")?.value.trim() || "";
  if (!company) {
    toast("请填写公司名", "error");
    return;
  }
  const saveButton = qs<HTMLButtonElement>("#saveCustomerButton");
  const editingId = saveButton?.dataset.editingId || "";
  const payload = {
    company,
    contact: qs<HTMLInputElement>("#customerContactInput")?.value || "待维护",
    country: qs<HTMLInputElement>("#customerCountryInput")?.value || "未知",
    nextReminder: qs<HTMLInputElement>("#customerReminderInput")?.value || "明天 10:00",
    wecomBound: qs<HTMLSelectElement>("#customerWecomInput")?.value === "true",
    billingName: qs<HTMLInputElement>("#customerBillingNameInput")?.value.trim() || company,
    billingAddress: qs<HTMLInputElement>("#customerBillingAddressInput")?.value.trim() || "",
    documentContact: qs<HTMLInputElement>("#customerDocumentContactInput")?.value.trim() || qs<HTMLInputElement>("#customerContactInput")?.value || "待维护",
    defaultPortDischarge: qs<HTMLInputElement>("#customerPortDischargeInput")?.value.trim() || "",
    defaultIncoterm: qs<HTMLInputElement>("#customerIncotermInput")?.value.trim() || "FOB Tianjin",
    defaultPaymentTerm: qs<HTMLInputElement>("#customerPaymentTermInput")?.value.trim() || "30% T/T deposit, 70% before shipment"
  };
  const result = await api<{ customer: Customer }>(editingId ? `/api/customers/${editingId}` : "/api/customers", {
    method: editingId ? "PATCH" : "POST",
    body: JSON.stringify(payload)
  });
  if (editingId) {
    state.customers = state.customers.map((customer) => customer.id === result.customer.id ? result.customer : customer);
  } else {
    state.customers.unshift(result.customer);
  }
  state.selectedCustomerId = result.customer.id;
  renderCustomers(state.customers);
  if (editingId) {
    renderCustomerDrawer(result.customer);
    openCustomerDrawer();
  }
  void refreshDashboardOnly();
  closeModal();
  toast(editingId ? "客户已保存" : "客户已新增");
}

async function bulkDeleteCustomers() {
  const ids = state.selectedCustomerIds.filter((id) => state.customers.some((customer) => customer.id === id));
  if (!ids.length) {
    toast("请先勾选要删除的客户", "error");
    return;
  }
  const names = state.customers.filter((customer) => ids.includes(customer.id)).map((customer) => customer.company);
  if (!window.confirm(`确认批量删除 ${ids.length} 个客户？\n${names.slice(0, 6).join("、")}${names.length > 6 ? "等" : ""}\n关联商机和待办会同步清理。`)) return;
  const button = qs<HTMLButtonElement>("#customers [data-bulk-delete-customers]");
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "删除中";
    }
    const result = await api<{ deleted: Customer[]; customers: Customer[] }>("/api/customers/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
    state.customers = result.customers;
    state.selectedCustomerIds = [];
    state.selectedCustomerId = state.customers.find((customer) => customer.id === state.selectedCustomerId)?.id || state.customers[0]?.id || null;
    renderCustomers(state.customers);
    void refreshDashboardOnly();
    toast(`已批量删除 ${result.deleted.length} 个客户`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "批量删除客户失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "批量删除";
    }
  }
}

function addFollowRecord(customer: Customer) {
  openModal(`新增跟进 · ${customer.company}`, `
    <div class="form-grid">
      <label class="form-field"><span>跟进方式</span><select id="customerFollowType"><option value="call">电话</option><option value="email">邮件</option><option value="whatsapp">WhatsApp</option><option value="wechat">微信</option><option value="meeting">会议</option><option value="note">备注</option></select></label>
      <div class="form-field"><label>下次提醒</label><input id="customerFollowNext" value="${escapeHtml(customer.nextReminder || "明天 10:00")}"></div>
      <div class="form-field full"><label>沟通结果与下一步</label><textarea id="customerFollowContent" placeholder="记录客户反馈、关键需求、承诺事项与下一动作"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCustomerFollowButton">保存跟进</button>`);
  qs("#saveCustomerFollowButton")?.addEventListener("click", () => void saveCustomerFollow(customer.id));
  qs<HTMLTextAreaElement>("#customerFollowContent")?.focus();
}

async function saveCustomerFollow(customerId: string) {
  const content = qs<HTMLTextAreaElement>("#customerFollowContent")?.value.trim() || "";
  if (!content) {
    toast("请填写本次沟通结果", "error");
    return;
  }
  const button = qs<HTMLButtonElement>("#saveCustomerFollowButton");
  try {
    if (button) { button.disabled = true; button.textContent = "保存中"; }
    const result = await api<{ customer: Customer }>(`/api/customers/${customerId}/activities`, {
      method: "POST",
      body: JSON.stringify({
        type: qs<HTMLSelectElement>("#customerFollowType")?.value || "note",
        content,
        nextReminder: qs<HTMLInputElement>("#customerFollowNext")?.value.trim() || ""
      })
    });
    state.customers = state.customers.map((customer) => customer.id === customerId ? result.customer : customer);
    renderCustomers(state.customers);
    renderCustomerDrawer(result.customer);
    closeModal();
    toast(`已记录 ${result.customer.company} 的跟进动作`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存跟进失败", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = "保存跟进"; }
  }
}

async function syncOcrLead(button: HTMLButtonElement) {
  button.disabled = true;
  button.textContent = "同步中";
  try {
    await api("/api/tools/ocr/jobs/ocr1/recognize", {
      method: "POST",
      body: JSON.stringify(collectOcrFields())
    });
    await api("/api/tools/ocr/jobs/ocr1/sync-lead", { method: "POST" });
    button.textContent = "已同步";
    qsa<HTMLElement>("#tools .sync-row").at(2)!.innerHTML = `<span>目标模块</span><b>线索池 / 欧洲组</b>${badge("已同步", "green")}`;
    toast("OCR 线索已同步");
  } catch (error) {
    button.disabled = false;
    button.textContent = error instanceof Error ? error.message : "同步失败";
  }
}

function reportMoneyText(rows: ReportMoneyRow[]) {
  return rows.length
    ? rows.map((row) => `${row.currency} ${Number(row.amount || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`).join(" / ")
    : "暂无金额";
}

function reportMoneyHtml(rows: ReportMoneyRow[], tag = "b") {
  return rows.length
    ? rows.map((row) => `<${tag}>${escapeHtml(row.currency)} ${Number(row.amount || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}</${tag}>`).join("")
    : `<span class="report-empty">暂无金额</span>`;
}

function renderExecutiveReport(report: ExecutiveReport) {
  state.executiveReport = report;
  const generatedAt = new Date(report.period.asOf);
  const generatedText = Number.isFinite(generatedAt.getTime())
    ? generatedAt.toLocaleString("zh-CN", { hour12: false })
    : report.period.asOf;
  const setText = (selector: string, value: string) => {
    const node = qs<HTMLElement>(selector);
    if (node) node.textContent = value;
  };
  const setHtml = (selector: string, value: string) => {
    const node = qs<HTMLElement>(selector);
    if (node) node.innerHTML = value;
  };
  setText("#reportPeriod", `${report.title} · ${report.period.label}`);
  setText("#reportGeneratedAt", `GoodJob CRM · 生成于 ${generatedText}`);
  setText("#reportHeadline", report.headline);
  setText("#reportHeroNote", state.reportNote || report.note);
  setText("#reportScope", `范围：${report.scope.label}`);
  setText("#reportAmountBasis", `金额口径：${report.amountBasis.label}`);
  setText("#reportDataStatus", `数据状态：${report.dataStatus}`);
  setHtml("#reportWeightedForecast", reportMoneyHtml(report.metrics.weightedForecast));
  setHtml("#reportExpectedAmount", reportMoneyHtml(report.metrics.expectedThisMonth));
  setHtml("#reportRiskAmount", reportMoneyHtml(report.metrics.riskAmounts));
  setHtml("#reportWinRate", `<b>${report.metrics.winRate === null ? "暂无可计算数据" : `${report.metrics.winRate}%`}</b><span>${report.metrics.closedCount} 个本月已关闭商机</span>`);
  setHtml("#reportConclusions", report.conclusions.map((item, index) => `
    <div class="summary-card"><strong>结论 ${index + 1}：${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div>
  `).join(""));
  setHtml("#reportFunnel", report.funnel.map((row) => `
    <div class="funnel-step">
      <b>${escapeHtml(row.stage)}</b>
      <div class="bar" style="--w:${Math.max(0, Math.min(100, row.width))}%"></div>
      <span>${row.count} 单</span>
      <strong title="${escapeHtml(reportMoneyText(row.amounts))}">${escapeHtml(reportMoneyText(row.amounts))}${row.riskCount ? ` · 风险 ${row.riskCount}` : ""}</strong>
    </div>
  `).join(""));
  setHtml("#reportActions", report.actions.length ? report.actions.map((item, index) => `
    <div class="insight-item"><i>${index + 1}</i><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.detail)}</span></div></div>
  `).join("") : `<div class="insight-item"><i>✓</i><div><b>暂无紧急行动项</b><span>当前范围未识别到风险商机或本月预计成交商机。</span></div></div>`);
  const marketColors = ["var(--brand)", "var(--green)", "var(--amber)", "var(--violet)", "var(--rose)"];
  setHtml("#reportMarket", report.market.length ? report.market.map((row, index) => `
    <span><i style="--color:${marketColors[index % marketColors.length]}"></i>${escapeHtml(row.region)} ${row.share}% · ${row.count} 单 · ${escapeHtml(reportMoneyText(row.amounts))}${row.riskCount ? ` · 风险 ${row.riskCount}` : ""}</span>
  `).join("") : `<span class="report-empty">暂无市场数据</span>`);
  const donut = qs<HTMLElement>("#reports .donut");
  if (donut) {
    let cursor = 0;
    const segments = report.market.map((row, index) => {
      const start = cursor;
      cursor += row.share;
      return `${marketColors[index % marketColors.length]} ${start}% ${cursor}%`;
    });
    donut.style.background = segments.length ? `conic-gradient(${segments.join(",")})` : "#e8edf5";
  }
  const maxForecastCount = Math.max(...report.forecastByStage.map((row) => row.count), 1);
  setHtml("#reportForecast", report.forecastByStage.map((row, index) => `
    <div><i style="--h:${row.count ? Math.max(18, Math.round((row.count / maxForecastCount) * 150)) : 4}px; --c:${marketColors[index % marketColors.length]}"></i>
    <span>${escapeHtml(row.stage)} ${Math.round(row.weight * 100)}%<br>${escapeHtml(reportMoneyText(row.weightedAmounts))}</span></div>
  `).join(""));
  setText("#reportPerformanceTitle", report.performanceTitle);
  setHtml("#reportPerformanceRows", report.performance.length ? report.performance.map((row) => `
    <tr><td>${escapeHtml(row.owner)}</td><td>${row.customerCount}</td><td>${row.followUpCount}</td><td>${row.activeDealCount}</td><td>${escapeHtml(reportMoneyText(row.forecastAmounts))}</td><td>${badge(row.riskLabel, row.riskCount ? "amber" : "green")}</td></tr>
  `).join("") : `<tr><td colspan="6">暂无可展示人员数据</td></tr>`);
  setHtml("#reportPerformanceCards", report.performance.length ? report.performance.map((row) => `
    <article class="report-performance-card">
      <header><b>${escapeHtml(row.owner)}</b>${badge(row.riskLabel, row.riskCount ? "amber" : "green")}</header>
      <dl>
        <div><dt>客户</dt><dd>${row.customerCount}</dd></div>
        <div><dt>本月跟进</dt><dd>${row.followUpCount}</dd></div>
        <div><dt>活跃商机</dt><dd>${row.activeDealCount}</dd></div>
        <div><dt>加权预测</dt><dd>${escapeHtml(reportMoneyText(row.forecastAmounts))}</dd></div>
      </dl>
    </article>
  `).join("") : `<div class="report-empty">暂无可展示人员数据</div>`);
  setHtml("#reportDefinitions", report.definitions.map((item) => `<li>${escapeHtml(item)}</li>`).join(""));
  const riskButton = qs<HTMLButtonElement>("#reportRiskDetailButton");
  if (riskButton) {
    riskButton.textContent = `查看风险明细（${report.riskRows.length}）`;
    riskButton.disabled = report.riskRows.length === 0;
  }
}

async function refreshExecutiveReport(showToast = false) {
  const button = qs<HTMLButtonElement>("#reportRefreshButton");
  try {
    if (button) { button.disabled = true; button.textContent = "刷新中"; }
    const report = await api<ExecutiveReport>("/api/reports/executive");
    renderExecutiveReport(report);
    if (showToast) toast("经营快照已刷新");
  } catch (error) {
    toast(error instanceof Error ? error.message : "经营快照加载失败", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = "刷新数据"; }
  }
}

function openReportRiskModal() {
  const rows = state.executiveReport?.riskRows || [];
  if (!rows.length) {
    toast("当前范围暂无风险商机");
    return;
  }
  openModal("风险商机明细", `
    <div class="insight-list">${rows.map((row, index) => `
      <div class="insight-item">
        <i>${index + 1}</i>
        <div><b>${escapeHtml(row.customer)} · ${escapeHtml(row.stage)} · ${escapeHtml(row.currency)} ${Number(row.amount).toLocaleString("en-US")}</b>
        <span>${escapeHtml(row.owner)} · ${escapeHtml(row.riskReasons.join("、"))}<br>下一动作：${escapeHtml(row.nextAction || "待补充")} · 预计成交：${escapeHtml(row.expectedCloseAt || "待补充")}</span></div>
      </div>
    `).join("")}</div>
  `, `<button class="btn primary" data-modal-close>关闭</button>`);
}

async function exportReport() {
  const report = state.executiveReport || await api<ExecutiveReport>("/api/reports/executive");
  if (!state.executiveReport) renderExecutiveReport(report);
  const content = [
    report.title,
    `统计范围：${report.scope.label}`,
    `统计期间：${report.period.label}`,
    `生成时间：${report.period.asOf}`,
    `金额口径：${report.amountBasis.label}`,
    `数据状态：${report.dataStatus}`,
    "",
    report.headline,
    state.reportNote || report.note,
    "",
    `活跃管道：${reportMoneyText(report.metrics.activePipeline)}`,
    `阶段加权预测：${reportMoneyText(report.metrics.weightedForecast)}`,
    `本月预计成交：${reportMoneyText(report.metrics.expectedThisMonth)}`,
    `本月已成交：${reportMoneyText(report.metrics.wonThisMonth)}`,
    `风险商机：${report.metrics.riskDealCount} 个，${reportMoneyText(report.metrics.riskAmounts)}`,
    `本月赢单率：${report.metrics.winRate === null ? "暂无可计算数据" : `${report.metrics.winRate}%`}`,
    "",
    "经营结论",
    ...report.conclusions.map((item, index) => `${index + 1}. ${item.title}：${item.detail}`),
    "",
    "管理动作",
    ...(report.actions.length ? report.actions.map((item, index) => `${index + 1}. ${item.title}：${item.detail}`) : ["暂无紧急行动项"]),
    "",
    "统计定义",
    ...report.definitions.map((item, index) => `${index + 1}. ${item}`)
  ].join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "GoodJob-CRM-经营汇报.txt";
  link.click();
  URL.revokeObjectURL(link.href);
  toast("汇报已生成下载");
}

function openReportNoteModal() {
  openModal("汇报备注", `<div class="form-field full"><label>备注</label><input id="reportNoteInput" value="${escapeHtml(state.reportNote)}" placeholder="补充本周管理重点，不会覆盖系统统计结论"></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReportNoteButton">保存备注</button>`);
  qs("#saveReportNoteButton")?.addEventListener("click", saveReportNote);
}

function saveReportNote() {
  state.reportNote = qs<HTMLInputElement>("#reportNoteInput")?.value.trim() || "";
  if (state.user) localStorage.setItem(`gj_report_note_${state.user.id}`, state.reportNote);
  const hero = qs<HTMLElement>("#reportHeroNote");
  if (hero) hero.textContent = state.reportNote || state.executiveReport?.note || "";
  closeModal();
  toast("汇报备注已保存");
}

function installEvents() {
  ensureUiLayer();
  window.addEventListener("pagehide", () => {
    const memo = state.memos.find((item) => item.id === state.selectedMemoId);
    if (memo && memoDirty) writeMemoDraft(memo);
  });
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest(".todo-actions")) return;
    if (!state.openTodoMenuId) return;
    state.openTodoMenuId = null;
    renderTodos(state.todos);
  }, true);
  qs<HTMLButtonElement>("#loginButton")?.addEventListener("click", (event) => {
    event.stopImmediatePropagation();
    const email = qs<HTMLInputElement>("#loginEmail")?.value.trim() || "";
    const password = qs<HTMLInputElement>("#loginPassword")?.value || "";
    void loginWithPassword(email, password).catch((error) => toast(error instanceof Error ? error.message : "登录失败", "error"));
  }, true);
  qs<HTMLButtonElement>("#logoutButton")?.addEventListener("click", async () => {
    if (memoDirty && !window.confirm("当前备忘仍仅保存在本机。退出将清除此账号的本机草稿，确认退出？")) return;
    clearCurrentUserMemoDrafts();
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    localStorage.removeItem(storage.user);
    state.user = null;
    document.body.classList.remove("is-authenticated");
    toast("已退出登录");
  });
  qs<HTMLButtonElement>("#profileEntryButton")?.addEventListener("click", () => activateNavView("profile", () => renderProfile()));
  qs<HTMLButtonElement>("#profileSaveButton")?.addEventListener("click", (event) => void saveProfileEmailBinding(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#profileTestSmtpButton")?.addEventListener("click", (event) => void sendProfileTestEmail(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#profileClearEmailButton")?.addEventListener("click", (event) => void clearProfileEmailBinding(event.currentTarget as HTMLButtonElement));
  qs<HTMLInputElement>("#profileSmtpPort")?.addEventListener("input", () => updateProfileSmtpHints());
  qs<HTMLSelectElement>("#profileSmtpSecure")?.addEventListener("change", () => updateProfileSmtpHints());
  qs<HTMLButtonElement>("#profileRefreshButton")?.addEventListener("click", async () => {
    const result = await api<{ user: User }>("/api/profile");
    updateStoredUser(result.user);
    toast("个人资料已刷新");
  });
  qs<HTMLButtonElement>("#profileOpenProspectsButton")?.addEventListener("click", () => activateNavView("prospect-list", renderProspectList));
  qs<HTMLButtonElement>("#profileOpenWhatsAppButton")?.addEventListener("click", () => activateNavView("whatsapp", renderWhatsApp));
  qs<HTMLButtonElement>("#profileOpenSettingsButton")?.addEventListener("click", () => {
    if (state.user && ["admin", "super_admin"].includes(state.user.role)) activateNavView("settings");
    else toast("账号管理仅管理员和超级管理员可进入", "error");
  });
  qsa<HTMLElement>(".todo-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.todoFilter = (chip.dataset.todoFilter || "today") as AppState["todoFilter"];
      renderTodos(state.todos);
      updateTodoChips(state.todos);
    });
  });
  qs<HTMLInputElement>(".quick-add input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = event.currentTarget as HTMLInputElement;
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    void createQuickTodo(title);
  });
  qs<HTMLButtonElement>("#morningViewButton")?.addEventListener("click", () => {
    state.morningView = !state.morningView;
    if (state.summary) renderDashboard(state.summary, state.todos, state.customers);
    toast(state.morningView ? "晨会视图已打开" : "晨会视图已关闭");
  });
  qsa<HTMLButtonElement>("[data-dashboard-period]").forEach((button) => {
    button.addEventListener("click", () => {
      state.dashboardPeriod = (button.dataset.dashboardPeriod || "today") as DashboardPeriod;
      if (state.summary) renderDashboard(state.summary, state.todos, state.customers);
    });
  });
  qsa<HTMLButtonElement>("#dashboard .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增待办")) button.addEventListener("click", () => openTodoModal());
    if (button.textContent?.includes("批量完成")) button.addEventListener("click", async () => {
      const pending = filterTodos(activeTodos(state.todos)).filter((todo) => !todo.done).slice(0, 5);
      await Promise.all(pending.map((todo) => api(`/api/todos/${todo.id}/complete`, { method: "POST" })));
      pending.forEach((todo) => { todo.done = true; });
      renderTodos(state.todos);
      updateTodoChips(state.todos);
      void refreshDashboardOnly();
      toast(`已完成 ${pending.length} 条待办`);
    });
  });
  qs<HTMLButtonElement>("#planTaskNewButton")?.addEventListener("click", () => openPlanTaskModal());
  qs<HTMLButtonElement>("#planTaskNewButtonInline")?.addEventListener("click", () => openPlanTaskModal());
  qs<HTMLButtonElement>("#planTaskPushSelectedButton")?.addEventListener("click", (event) => void pushPlanTasksToTodos(state.selectedPlanTaskIds, event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#instrumentMemoButton")?.addEventListener("click", (event) => void saveInstrumentPlanMemo(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#instrumentExportButton")?.addEventListener("click", exportInstrumentPlanCsv);
  qs<HTMLButtonElement>("#batchPriorityButton")?.addEventListener("click", (event) => void batchProcessPriorityTasks(event.currentTarget as HTMLButtonElement));
  qsa<HTMLButtonElement>("#customers .page-head .btn.primary").forEach((button) => {
    if (button.textContent?.includes("新增客户")) button.addEventListener("click", () => openCustomerModal());
  });
  qs<HTMLInputElement>("#customerSearchInput")?.addEventListener("input", (event) => {
    state.customerSearch = (event.currentTarget as HTMLInputElement).value;
    renderCustomers(state.customers);
  });
  qs<HTMLSelectElement>("#customerQueueFilter")?.addEventListener("change", (event) => {
    state.customerQueueFilter = (event.currentTarget as HTMLSelectElement).value as AppState["customerQueueFilter"];
    renderCustomers(state.customers);
  });
  qs<HTMLButtonElement>("#customerFilterReset")?.addEventListener("click", () => {
    state.customerSearch = "";
    state.customerQueueFilter = "all";
    const search = qs<HTMLInputElement>("#customerSearchInput");
    const filter = qs<HTMLSelectElement>("#customerQueueFilter");
    if (search) search.value = "";
    if (filter) filter.value = "all";
    renderCustomers(state.customers);
  });
  qs("#customerDrawerBackdrop")?.addEventListener("click", closeCustomerDrawer);
  qs<HTMLButtonElement>("#pipeline .page-head .btn.primary")?.addEventListener("click", () => openDealModal());
  qs("#dealDrawerBackdrop")?.addEventListener("click", closeDealDrawer);
  qs<HTMLInputElement>("#pipelineSearchInput")?.addEventListener("input", (event) => {
    state.pipelineSearch = (event.currentTarget as HTMLInputElement).value.trim();
    renderPipeline(state.deals);
  });
  qs<HTMLSelectElement>("#pipelineDueFilter")?.addEventListener("change", (event) => {
    state.pipelineDueFilter = (event.currentTarget as HTMLSelectElement).value;
    renderPipeline(state.deals);
  });
  qs<HTMLButtonElement>("#pipelineFilterReset")?.addEventListener("click", () => {
    state.pipelineSearch = "";
    state.pipelineDueFilter = "all";
    setFieldValue("#pipelineSearchInput", "");
    setFieldValue("#pipelineDueFilter", "all");
    renderPipeline(state.deals);
  });
  qs<HTMLInputElement>("#pipelineClosedSearch")?.addEventListener("change", (event) => {
    state.closedDealKeyword = (event.currentTarget as HTMLInputElement).value.trim();
    state.closedDealPage = 1;
    void refreshClosedDeals();
  });
  qs<HTMLSelectElement>("#pipelineClosedStatus")?.addEventListener("change", (event) => {
    state.closedDealStatus = (event.currentTarget as HTMLSelectElement).value;
    state.closedDealPage = 1;
    void refreshClosedDeals();
  });
  qs<HTMLInputElement>("#pipelineClosedMonth")?.addEventListener("change", (event) => {
    state.closedDealMonth = (event.currentTarget as HTMLInputElement).value;
    state.closedDealPage = 1;
    void refreshClosedDeals();
  });
  qs<HTMLButtonElement>("#pipelineClosedPrev")?.addEventListener("click", () => {
    state.closedDealPage = Math.max(1, state.closedDealPage - 1);
    void refreshClosedDeals();
  });
  qs<HTMLButtonElement>("#pipelineClosedNext")?.addEventListener("click", () => {
    state.closedDealPage += 1;
    void refreshClosedDeals();
  });
  qs<HTMLButtonElement>("#reminders .page-head .btn.primary")?.addEventListener("click", () => openReminderModal());
  qs<HTMLButtonElement>("#chooseCustomerImportButton")?.addEventListener("click", () => qs<HTMLInputElement>("#customerImportInput")?.click());
  qs<HTMLInputElement>("#customerImportInput")?.addEventListener("change", (event) => {
    const fileName = (event.currentTarget as HTMLInputElement).files?.[0]?.name || "未选择文件";
    const label = qs<HTMLElement>("#customerImportFileName");
    if (label) label.textContent = fileName;
  });
  qs<HTMLButtonElement>("#runCustomerImportButton")?.addEventListener("click", (event) => void importCustomersFromFile(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#downloadCustomerTemplateButton")?.addEventListener("click", downloadCustomerTemplate);
  qs<HTMLButtonElement>("#exportCustomersButton")?.addEventListener("click", () => void exportCustomers());
  qs<HTMLButtonElement>("#reportExportButton")?.addEventListener("click", () => void exportReport());
  qs<HTMLButtonElement>("#reportRefreshButton")?.addEventListener("click", () => void refreshExecutiveReport(true));
  qs<HTMLButtonElement>("#reportNoteButton")?.addEventListener("click", openReportNoteModal);
  qs<HTMLButtonElement>("#reportRiskDetailButton")?.addEventListener("click", openReportRiskModal);
  qsa<HTMLButtonElement>("#knowledge .page-head .btn, #knowledge .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("上传资料")) button.addEventListener("click", openKnowledgeModal);
    if (button.textContent?.includes("新建类目")) button.addEventListener("click", () => toast("资料类目已新增：新品资料"));
    if (button.textContent?.includes("批量发布")) button.addEventListener("click", async () => {
      const pending = state.knowledgeAssets.filter((asset) => asset.status !== "published");
      for (const asset of pending) await publishAsset(asset.id);
      if (!pending.length) toast("没有待发布资料");
    });
    if (button.textContent?.includes("调整排序")) button.addEventListener("click", () => toast("资料类目排序已保存"));
  });
  qsa<HTMLButtonElement>("#exam .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("发布考试")) button.addEventListener("click", () => openExamCreateModal());
    if (button.textContent?.includes("题库维护")) button.addEventListener("click", () => void openQuestionBankPage());
    if (button.textContent?.includes("分类目考试维护")) button.addEventListener("click", openExamCategoryModal);
  });
  qs<HTMLButtonElement>("#backToExamButton")?.addEventListener("click", () => activateNavView("exam"));
  qs<HTMLButtonElement>("#newQuestionButton")?.addEventListener("click", newQuestionDraft);
  qsa<HTMLButtonElement>("#saveQuestionButton, #saveQuestionButtonBottom").forEach((button) => {
    button.addEventListener("click", (event) => void saveQuestion(event.currentTarget as HTMLButtonElement));
  });
  qs<HTMLButtonElement>("#deleteQuestionButton")?.addEventListener("click", () => void deleteBankQuestion(state.selectedQuestionId || ""));
  qs<HTMLButtonElement>("#importQuestionButton")?.addEventListener("click", (event) => void importQuestionBank(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#exportQuestionButton")?.addEventListener("click", () => void exportQuestionBank());
  qs<HTMLInputElement>("#questionImportInput")?.addEventListener("change", (event) => {
    const fileName = (event.currentTarget as HTMLInputElement).files?.[0]?.name || "支持 .xlsx / .xls / .csv 题库";
    const label = qs<HTMLElement>("#questionImportFileName");
    if (label) label.textContent = fileName;
  });
  ["#questionBankCategoryFilter", "#questionBankTypeFilter", "#questionBankSearchInput"].forEach((selector) => {
    qs<HTMLElement>(selector)?.addEventListener("input", () => renderQuestionBankRows(state.examQuestions));
    qs<HTMLElement>(selector)?.addEventListener("change", () => renderQuestionBankRows(state.examQuestions));
  });
  qs<HTMLButtonElement>("#wecom .page-head .btn.primary")?.addEventListener("click", () => void syncWecomMessages());
  qs<HTMLButtonElement>("#aiSaveButton")?.addEventListener("click", (event) => void saveAiConfig(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#aiTestButton")?.addEventListener("click", (event) => void testAiConfig(event.currentTarget as HTMLButtonElement));
  qs<HTMLInputElement>("#aiEnabledInput")?.addEventListener("change", () => {
    const useAi = qs<HTMLInputElement>("#websiteUseAiInput");
    if (useAi) useAi.checked = Boolean(qs<HTMLInputElement>("#aiEnabledInput")?.checked && state.aiConfig?.hasApiKey);
  });
  qs<HTMLButtonElement>("#topPrimaryAction")?.addEventListener("click", () => {
    const view = qs<HTMLElement>(".view.active")?.id;
    if (view === "customers") openCustomerModal();
  });
  qs<HTMLButtonElement>("#topImportButton")?.addEventListener("click", () => {
    const view = qs<HTMLElement>(".view.active")?.id;
    if (view === "customers") activateNavView("imports", () => qs<HTMLInputElement>("#customerImportInput")?.click());
  });
  qs<HTMLButtonElement>("#topExportButton")?.addEventListener("click", () => {
    const view = qs<HTMLElement>(".view.active")?.id;
    if (view === "customers") activateNavView("imports", () => void exportCustomers());
  });
  qsa<HTMLButtonElement>("[data-top-view]").forEach((button) => {
    button.addEventListener("click", () => activateNavView(button.dataset.topView || "dashboard"));
  });
  qsa<HTMLButtonElement>(".sidebar button[data-view]").forEach((button) => {
    button.addEventListener("click", () => activateNavView(button.dataset.view || "dashboard"));
  });
  qs<HTMLButtonElement>("#leadNewButton")?.addEventListener("click", () => {
    qs<HTMLElement>("#leadCreateForm")?.classList.toggle("is-hidden");
  });
  qs<HTMLButtonElement>("#leadCreateCancel")?.addEventListener("click", () => {
    qs<HTMLElement>("#leadCreateForm")?.classList.add("is-hidden");
  });
  qs<HTMLFormElement>("#leadCreateForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void createLead(event.currentTarget as HTMLFormElement);
  });
  qs<HTMLInputElement>("#leadSearchInput")?.addEventListener("input", (event) => {
    state.leadSearch = (event.target as HTMLInputElement).value;
    state.leadPage = 1;
    renderLeads();
  });
  qs<HTMLInputElement>("#waThreadSearch")?.addEventListener("input", (event) => {
    state.waThreadSearch = (event.target as HTMLInputElement).value;
    renderWhatsAppThreads();
  });
  qs<HTMLButtonElement>("#leadActiveTab")?.addEventListener("click", () => {
    state.leadView = "active";
    state.leadPage = 1;
    state.leadStageFilter = "all";
    closeLeadDrawer();
    renderLeads();
  });
  qs<HTMLButtonElement>("#leadTrashTab")?.addEventListener("click", () => {
    state.leadView = "trash";
    state.leadPage = 1;
    state.leadStageFilter = "all";
    closeLeadDrawer();
    renderLeads();
  });
  qs<HTMLSelectElement>("#leadIntentFilter")?.addEventListener("change", (event) => {
    state.leadIntentFilter = (event.target as HTMLSelectElement).value;
    state.leadPage = 1;
    renderLeads();
  });
  qs<HTMLSelectElement>("#leadSourceFilter")?.addEventListener("change", (event) => {
    state.leadSourceFilter = (event.target as HTMLSelectElement).value;
    state.leadPage = 1;
    renderLeads();
  });
  qs<HTMLSelectElement>("#leadFollowFilter")?.addEventListener("change", (event) => {
    state.leadFollowFilter = (event.target as HTMLSelectElement).value;
    state.leadPage = 1;
    renderLeads();
  });
  qs<HTMLButtonElement>("#leadFilterReset")?.addEventListener("click", resetLeadFilters);
  qs("#leadDrawerBackdrop")?.addEventListener("click", closeLeadDrawer);
  ["#leadFinderGoalInput", "#leadProductKeywords", "#leadCountries", "#leadIndustryInput", "#leadCustomerTypes", "#leadExcludeKeywords"].forEach((selector) => {
    qs<HTMLElement>(selector)?.addEventListener("input", renderLeadFinderSearchLinks);
    qs<HTMLElement>(selector)?.addEventListener("change", renderLeadFinderSearchLinks);
  });
  qsa<HTMLButtonElement>(".lead-entry-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      chip.classList.toggle("active");
      renderLeadFinderSearchLinks();
    });
  });
  qs<HTMLButtonElement>("#leadSourceCenterButton")?.addEventListener("click", () => openLeadSourceCenter());
  qs<HTMLButtonElement>("#leadSourceManageInline")?.addEventListener("click", () => openLeadSourceCenter());
  qs<HTMLButtonElement>("#leadFinderStartButton")?.addEventListener("click", (event) => void runLeadFinder(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderStartButtonInline")?.addEventListener("click", (event) => void runLeadFinder(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderSyncButton")?.addEventListener("click", (event) => void syncLeadFinderRows(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderTodoButton")?.addEventListener("click", (event) => void createLeadFinderTodos(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderExportButton")?.addEventListener("click", exportLeadFinderRows);
  qs<HTMLButtonElement>("#leadFinderExportButtonQueue")?.addEventListener("click", exportLeadFinderRows);
  qs<HTMLButtonElement>("#leadFinderSyncButtonSide")?.addEventListener("click", (event) => void syncLeadFinderRows(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderTodoButtonSide")?.addEventListener("click", (event) => void createLeadFinderTodos(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderExportButtonSide")?.addEventListener("click", exportLeadFinderRows);
  qs<HTMLButtonElement>("#leadFinderAiConfigButtonSide")?.addEventListener("click", () => activateNavView("ai-config", () => {
    qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
    toast("已打开 AI 模型配置");
  }));
  qsa<HTMLButtonElement>("[data-lead-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.leadFinderFilter = (button.dataset.leadFilter || "all") as AppState["leadFinderFilter"];
      state.leadFinderPage = 1;
      renderLeadFinder(state.websiteOpportunities);
    });
  });
  qs<HTMLButtonElement>("#leadFinderPrevPage")?.addEventListener("click", () => {
    state.leadFinderPage = Math.max(1, state.leadFinderPage - 1);
    renderLeadFinder(state.websiteOpportunities);
  });
  qs<HTMLButtonElement>("#leadFinderNextPage")?.addEventListener("click", () => {
    state.leadFinderPage += 1;
    renderLeadFinder(state.websiteOpportunities);
  });
  qs<HTMLButtonElement>("#leadFinderAiConfigButton")?.addEventListener("click", () => activateNavView("ai-config", () => {
    qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
    toast("已打开 AI 模型配置，保存后回到智能搜客即可启用 AI 解析");
  }));
  qs<HTMLInputElement>("#prospectSearchInput")?.addEventListener("input", () => {
    state.prospectPage = 1;
    renderProspectList();
  });
  qs<HTMLButtonElement>("#prospectOpenFinderButton")?.addEventListener("click", () => activateNavView("lead-finder", () => renderLeadFinder(state.websiteOpportunities)));
  qs<HTMLButtonElement>("#prospectRefreshButton")?.addEventListener("click", async () => {
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-opportunities");
    state.websiteOpportunities = result.opportunities;
    renderProspectList();
    renderLeadFinder(state.websiteOpportunities);
    toast("搜客清单已刷新");
  });
  qs<HTMLButtonElement>("#prospectGenerateMailButton")?.addEventListener("click", generateProspectMailDraft);
  qs<HTMLButtonElement>("#prospectPreviewMailButton")?.addEventListener("click", renderProspectMailPreview);
  qs<HTMLButtonElement>("#prospectSendMailButton")?.addEventListener("click", (event) => void sendProspectDevelopmentEmail(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectSyncButton")?.addEventListener("click", (event) => void syncSelectedProspects(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectMarkContactableButton")?.addEventListener("click", (event) => void updateProspectBatch("mark-contactable", state.selectedProspectIds, event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectExcludeButton")?.addEventListener("click", (event) => requestProspectExclusion(state.selectedProspectIds, event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectAssignButton")?.addEventListener("click", (event) => void updateProspectBatch("assign", state.selectedProspectIds, event.currentTarget as HTMLButtonElement));
  qs<HTMLInputElement>("#prospectSelectPage")?.addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    const pageRows = prospectFilteredRows().slice((state.prospectPage - 1) * PROSPECT_PAGE_SIZE, state.prospectPage * PROSPECT_PAGE_SIZE);
    const pageIds = pageRows.map((item) => item.id);
    state.selectedProspectIds = checked
      ? [...new Set([...state.selectedProspectIds, ...pageIds])]
      : state.selectedProspectIds.filter((id) => !pageIds.includes(id));
    renderProspectList();
  });
  qs<HTMLButtonElement>("#prospectPrevPage")?.addEventListener("click", () => {
    state.prospectPage = Math.max(1, state.prospectPage - 1);
    renderProspectList();
  });
  qs<HTMLButtonElement>("#prospectNextPage")?.addEventListener("click", () => {
    state.prospectPage += 1;
    renderProspectList();
  });
  ["#prospectMailTo", "#prospectMailSubject", "#prospectMailBody"].forEach((selector) => {
    qs<HTMLInputElement | HTMLTextAreaElement>(selector)?.addEventListener("input", renderProspectMailPreview);
  });
  qsa<HTMLButtonElement>("[data-prospect-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.prospectFilter = (button.dataset.prospectFilter || "all") as AppState["prospectFilter"];
      state.prospectPage = 1;
      renderProspectList();
    });
  });
  qsa<HTMLButtonElement>("#gptSaveButton, #gptSaveButtonTop").forEach((button) => {
    button.addEventListener("click", (event) => void saveAiConfig(event.currentTarget as HTMLButtonElement));
  });
  qsa<HTMLButtonElement>("#gptTestButton, #gptTestButtonTop").forEach((button) => {
    button.addEventListener("click", (event) => void testAiConfig(event.currentTarget as HTMLButtonElement));
  });
  qs<HTMLButtonElement>("#aiNewConfigButton")?.addEventListener("click", () => newAiConfigDraft(qs<HTMLSelectElement>("#gptProviderSelect")?.value || "openai"));
  qs<HTMLButtonElement>("#aiToggleEnabledButton")?.addEventListener("click", (event) => void toggleAiConfigEnabled(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#aiDeleteConfigButton")?.addEventListener("click", (event) => void deleteAiConfig(event.currentTarget as HTMLButtonElement));
  qsa<HTMLElement>("[data-ai-provider]").forEach((button) => {
    button.addEventListener("click", () => applyAiProviderPreset(button.dataset.aiProvider || "custom"));
  });
  qs<HTMLSelectElement>("#gptProviderSelect")?.addEventListener("change", (event) => {
    applyAiProviderPreset((event.currentTarget as HTMLSelectElement).value);
  });
  qs<HTMLButtonElement>("#gptRevealKeyButton")?.addEventListener("click", (event) => {
    const input = qs<HTMLInputElement>("#gptApiKeyInput");
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
    (event.currentTarget as HTMLButtonElement).textContent = input.type === "password" ? "显示" : "隐藏";
  });
  qs<HTMLInputElement>("#topSearchInput")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = event.currentTarget as HTMLInputElement;
    const nextView = resolveTopbarSearchView(input.value);
    if (!nextView) {
      toast("没有匹配到模块，可搜索：客户、商机、考试、资料、报表、备忘", "error");
      return;
    }
    activateNavView(nextView);
    input.value = "";
  });
  qsa<HTMLButtonElement>("#tools .page-head .btn, #tools .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("加载名片")) button.addEventListener("click", () => void recognizeOcr({ company: "Demo Instrument Trading Co., Ltd.", contact: "Demo Contact", email: "sales@example.com", country: "中国" }));
    if (button.textContent?.includes("重新识别")) button.addEventListener("click", () => void recognizeOcr());
    if (button.textContent?.includes("工具配置")) button.addEventListener("click", () => toast("OCR 字段映射配置已保存"));
    if (button.textContent?.includes("解析官网")) button.addEventListener("click", (event) => void parseWebsiteOpportunities(event.currentTarget as HTMLButtonElement));
  });
  qs<HTMLButtonElement>("#newDocumentButton")?.addEventListener("click", openNewDocument);
  qs<HTMLButtonElement>("#saveDocumentButton")?.addEventListener("click", () => void saveTradeDocument());
  qs<HTMLButtonElement>("#exportDocumentPdfButton")?.addEventListener("click", () => void exportTradeDocumentPdf());
  qs<HTMLButtonElement>("#documentSubmitApprovalButton")?.addEventListener("click", () => void submitDocumentApproval());
  qs<HTMLButtonElement>("#documentApproveButton")?.addEventListener("click", () => void approveActiveDocument());
  qs<HTMLButtonElement>("#documentRejectButton")?.addEventListener("click", () => void rejectActiveDocument());
  qs<HTMLButtonElement>("#documentSendButton")?.addEventListener("click", () => void sendActiveDocument());
  qs<HTMLButtonElement>("#documentNewRevisionButton")?.addEventListener("click", () => void createDocumentRevision());
  qs<HTMLSelectElement>("#docCustomerInput")?.addEventListener("change", (event) => {
    const customerId = (event.currentTarget as HTMLSelectElement).value;
    const dealSelect = qs<HTMLSelectElement>("#docDealInput");
    if (dealSelect) {
      const deals = state.deals.filter((deal) => !customerId || deal.customerId === customerId);
      dealSelect.innerHTML = `<option value="">未关联商机</option>${deals.map((deal) => `<option value="${escapeHtml(deal.id)}">${escapeHtml(deal.title)} · ${escapeHtml(deal.stage)}</option>`).join("")}`;
      dealSelect.value = "";
    }
    applyDocumentCustomerDefaults(customerId);
  });
  qs<HTMLSelectElement>("#docDealInput")?.addEventListener("change", (event) => {
    const dealId = (event.currentTarget as HTMLSelectElement).value;
    const deal = state.deals.find((item) => item.id === dealId);
    if (!deal) return;
    const customerSelect = qs<HTMLSelectElement>("#docCustomerInput");
    if (customerSelect) customerSelect.value = deal.customerId || "";
    applyDocumentCustomerDefaults(deal.customerId || "");
    const currency = qs<HTMLSelectElement>("#docCurrencyInput");
    if (currency && deal.currency) currency.value = deal.currency;
  });
  qs<HTMLButtonElement>("#addDocumentItemButton")?.addEventListener("click", addDocumentItem);
  qs<HTMLButtonElement>("#refreshDocumentPreviewButton")?.addEventListener("click", () => renderDocumentPreview(collectDocumentDraft()));
  qsa<HTMLButtonElement>("#documentTypeTabs button").forEach((button) => {
    button.addEventListener("click", () => {
      setDocumentType(button.dataset.docType === "CI" ? "CI" : "PI");
      const title = qs<HTMLInputElement>("#docTitleInput");
      if (title && (!title.value || title.value.includes("形式发票") || title.value.includes("商业发票"))) title.value = currentDocumentType() === "PI" ? "新建形式发票 PI" : "新建商业发票 CI";
      renderDocumentPreview(collectDocumentDraft());
    });
  });
  qsa<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("#documents input, #documents select, #documents textarea").forEach((input) => {
    input.addEventListener("input", () => renderDocumentPreview(collectDocumentDraft()));
    input.addEventListener("change", () => renderDocumentPreview(collectDocumentDraft()));
  });
  qsa<HTMLButtonElement>("#tools .btn.primary").forEach((button) => {
    if (button.textContent?.includes("加入线索中心")) button.addEventListener("click", (event) => void syncWebsiteOpportunities(event.currentTarget as HTMLButtonElement));
    else if (button.textContent?.includes("同步")) button.addEventListener("click", () => void syncOcrLead(button));
  });
  qsa<HTMLButtonElement>("#competitors .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增竞争公司")) button.addEventListener("click", openCompetitorModal);
    if (button.textContent?.includes("导出情报")) button.addEventListener("click", () => toast("竞争情报已加入导出任务"));
  });
  qs<HTMLButtonElement>("#competitorThreatButton")?.addEventListener("click", () => void toggleCompetitorThreat());
  qsa<HTMLButtonElement>("#cases .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增成功案例")) button.addEventListener("click", openCaseModal);
    if (button.textContent?.includes("导出案例集")) button.addEventListener("click", () => toast("成功案例集已加入导出任务"));
  });
  qs<HTMLButtonElement>("#casePublishButton")?.addEventListener("click", () => void publishSelectedCase());
  qsa<HTMLButtonElement>("#problems .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增问题")) button.addEventListener("click", openProblemModal);
    if (button.textContent?.includes("导出复盘")) button.addEventListener("click", () => toast("问题复盘已生成导出任务"));
  });
  qs<HTMLButtonElement>("#problemStatusButton")?.addEventListener("click", () => void advanceProblemStatus());
  qs<HTMLButtonElement>("#memoNewButton")?.addEventListener("click", openMemoModal);
  qs<HTMLInputElement>("#memoSearchInput")?.addEventListener("input", (event) => {
    state.memoSearch = (event.currentTarget as HTMLInputElement).value;
    memoMobileDetailOpen = false;
    renderMemos();
  });
  qsa<HTMLButtonElement>("[data-memo-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      await saveCurrentMemoDraft();
      state.memoStatus = (button.dataset.memoStatus as AppState["memoStatus"]) || "active";
      state.memoPinnedOnly = state.memoStatus === "deleted" ? false : state.memoPinnedOnly;
      state.selectedMemoId = null;
      memoMobileDetailOpen = false;
      renderMemos();
    });
  });
  qs<HTMLInputElement>("#memoPinnedOnly")?.addEventListener("change", (event) => {
    state.memoPinnedOnly = (event.currentTarget as HTMLInputElement).checked;
    state.selectedMemoId = null;
    memoMobileDetailOpen = false;
    renderMemos();
  });
  qs<HTMLButtonElement>("#memoBackButton")?.addEventListener("click", async () => {
    await saveCurrentMemoDraft();
    memoMobileDetailOpen = false;
    renderMemos();
  });
  qs<HTMLButtonElement>("#memoSaveState")?.addEventListener("click", () => {
    if (memoDirty) void saveCurrentMemoDraft();
  });
  qs<HTMLButtonElement>("#memoPinButton")?.addEventListener("click", () => {
    const memo = state.memos.find((item) => item.id === state.selectedMemoId);
    if (memo) void patchSelectedMemo({ pinned: !memo.pinned });
  });
  qs<HTMLButtonElement>("#memoArchiveButton")?.addEventListener("click", () => {
    const deletedMemo = state.deletedMemos.find((item) => item.id === state.selectedMemoId);
    if (deletedMemo) {
      void restoreSelectedMemo();
      return;
    }
    const memo = state.memos.find((item) => item.id === state.selectedMemoId);
    if (memo) void patchSelectedMemo({ archived: !memo.archived });
  });
  qs<HTMLButtonElement>("#memoDeleteButton")?.addEventListener("click", () => void deleteSelectedMemo());
  qsa<HTMLButtonElement>("#settings .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增账号")) button.addEventListener("click", openAccountModal);
    if (button.textContent?.includes("权限模板")) button.addEventListener("click", () => toast("权限模板已应用"));
    if (button.textContent?.includes("保存设置")) button.addEventListener("click", () => toast("账号与权限设置已保存"));
  });
}

function rememberWorkspaceTab(view: string) {
  if (!qs<HTMLElement>(`#${CSS.escape(view)}`)) view = "dashboard";
  if (!openWorkspaceTabs.includes(view)) openWorkspaceTabs.push(view);
  workspaceTabHistory = [view, ...workspaceTabHistory.filter((item) => item !== view && openWorkspaceTabs.includes(item))];
}

function closeWorkspaceTab(view: string) {
  if (view === "dashboard") return;
  openWorkspaceTabs = openWorkspaceTabs.filter((item) => item !== view);
  workspaceTabHistory = workspaceTabHistory.filter((item) => item !== view && openWorkspaceTabs.includes(item));
  const activeView = qs<HTMLElement>(".view.active")?.id || "dashboard";
  if (activeView === view) activateNavView(workspaceTabHistory[0] || "dashboard");
  else renderOpenWorkspaceTabs(activeView);
}

function renderOpenWorkspaceTabs(activeView: string) {
  const wrap = qs<HTMLElement>("#topOpenTabs");
  if (!wrap) return;
  if (!openWorkspaceTabs.includes("dashboard")) openWorkspaceTabs.unshift("dashboard");
  wrap.innerHTML = openWorkspaceTabs.map((view) => {
    const label = viewLabels[view] || view;
    const active = view === activeView ? " active" : "";
    const close = view === "dashboard" ? "" : `<span class="top-tab-close" data-close-tab="${view}" aria-label="关闭${label}">×</span>`;
    return `<button type="button" class="top-tab${active}" data-tab-view="${view}" title="${label}"><span class="top-tab-label">${label}</span>${close}</button>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-tab-view]", wrap).forEach((button) => {
    button.addEventListener("click", () => activateNavView(button.dataset.tabView || "dashboard"));
  });
  qsa<HTMLElement>("[data-close-tab]", wrap).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeWorkspaceTab(button.dataset.closeTab || "dashboard");
    });
  });
  qs<HTMLElement>(".top-tab.active", wrap)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function openSecondaryDropdownForView(view: string) {
  const activeButton = qs<HTMLButtonElement>(`.sidebar button[data-view="${CSS.escape(view)}"]`);
  const section = activeButton?.closest<HTMLDetailsElement>(".nav-section");
  if (section) section.open = true;
}

function activateNavView(view: string, after?: () => void) {
  if (!qs<HTMLElement>(`#${CSS.escape(view)}`)) view = "dashboard";
  const activeView = qs<HTMLElement>(".view.active")?.id;
  if (activeView === "memos" && view !== "memos" && memoDirty) void saveCurrentMemoDraft();
  if (view !== "leads") closeLeadDrawer();
  if (view !== "customers") closeCustomerDrawer();
  if (view !== "pipeline") closeDealDrawer();
  rememberWorkspaceTab(view);
  qsa<HTMLElement>(".sidebar button[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  openSecondaryDropdownForView(view);
  qsa<HTMLElement>(".view").forEach((node) => node.classList.toggle("active", node.id === view));
  renderTopbarForView(view);
  if (view === "whatsapp") renderWhatsApp();
  if (view === "reports") {
    if (state.user) state.reportNote = localStorage.getItem(`gj_report_note_${state.user.id}`) || "";
    void refreshExecutiveReport();
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
  after?.();
}

function renderTopbarForView(view: string) {
  const searchWrap = qs<HTMLElement>("#topSearchWrap");
  const searchInput = qs<HTMLInputElement>("#topSearchInput");
  const context = qs<HTMLElement>("#topActionContext");
  const importButton = qs<HTMLButtonElement>("#topImportButton");
  const exportButton = qs<HTMLButtonElement>("#topExportButton");
  const primaryButton = qs<HTMLButtonElement>("#topPrimaryAction");
  const primaryText = primaryButton?.querySelector("span");
  const isCustomerView = view === "customers";

  searchWrap?.classList.remove("is-hidden");
  context?.classList.toggle("is-hidden", !isCustomerView);
  if (searchInput) {
    searchInput.placeholder = isCustomerView ? "搜索客户、联系人、国家或产品" : "全局搜索 / 输入模块名后回车跳转";
  }
  if (importButton) importButton.hidden = !isCustomerView;
  if (exportButton) exportButton.hidden = !isCustomerView;
  if (primaryButton) primaryButton.hidden = !isCustomerView;
  if (primaryText && isCustomerView) primaryText.textContent = "新增客户";
  renderOpenWorkspaceTabs(view);
  renderTopbarStats();
}

function renderTopbarStats() {
  const todoCount = activeTodos(state.todos).filter((todo) => !todo.done).length;
  const reminderCount = state.todos.filter((todo) => todo.reminderRuleId && !todo.done).length;
  const todoNode = qs<HTMLElement>("#topTodoCount");
  const reminderNode = qs<HTMLElement>("#topReminderCount");
  if (todoNode) todoNode.textContent = String(todoCount);
  if (reminderNode) reminderNode.textContent = String(reminderCount);
}

function resolveTopbarSearchView(rawValue: string) {
  const value = rawValue.trim().toLowerCase();
  if (!value) return null;
  const candidates: Array<[string, string]> = [
    ["工作台", "dashboard"],
    ["待办", "dashboard"],
    ["todo", "dashboard"],
    ["搜客清单", "prospect-list"],
    ["开发信", "prospect-list"],
    ["清单", "prospect-list"],
    ["搜客", "lead-finder"],
    ["获客", "lead-finder"],
    ["线索搜索", "lead-finder"],
    ["lead", "lead-finder"],
    ["prospect", "prospect-list"],
    ["ai", "ai-config"],
    ["gpt", "ai-config"],
    ["模型", "ai-config"],
    ["apikey", "ai-config"],
    ["api key", "ai-config"],
    ["AI配置", "ai-config"],
    ["个人", "profile"],
    ["个人主页", "profile"],
    ["个人设置", "profile"],
    ["邮箱", "profile"],
    ["profile", "profile"],
    ["客户", "customers"],
    ["customer", "customers"],
    ["商机", "pipeline"],
    ["pipeline", "pipeline"],
    ["提醒", "reminders"],
    ["reminder", "reminders"],
    ["导入", "imports"],
    ["导出", "imports"],
    ["import", "imports"],
    ["单据", "documents"],
    ["发票", "documents"],
    ["pi", "documents"],
    ["ci", "documents"],
    ["invoice", "documents"],
    ["document", "documents"],
    ["提成", "commission"],
    ["对账", "commission"],
    ["commission", "commission"],
    ["报表", "reports"],
    ["report", "reports"],
    ["企业微信", "wecom"],
    ["微信", "wecom"],
    ["资料", "knowledge"],
    ["knowledge", "knowledge"],
    ["考试", "exam"],
    ["exam", "exam"],
    ["工具", "tools"],
    ["ocr", "tools"],
    ["竞争", "competitors"],
    ["competitor", "competitors"],
    ["案例", "cases"],
    ["case", "cases"],
    ["问题", "problems"],
    ["problem", "problems"],
    ["备忘", "memos"],
    ["memo", "memos"],
    ["设置", "settings"],
    ["account", "settings"]
  ];
  return candidates.find(([keyword]) => value.includes(keyword))?.[1] || null;
}

async function restoreSession() {
  const rawUser = localStorage.getItem(storage.user);
  localStorage.removeItem("gj_token");
  if (!rawUser) return;
  let user: User;
  try {
    ({ user } = await api<{ user: User }>("/api/auth/me"));
  } catch {
    localStorage.removeItem(storage.user);
    return;
  }
  localStorage.setItem(storage.user, JSON.stringify(user));
  state.user = user;
  applyAuthedUser(user);
  document.body.classList.add("is-authenticated");
  try {
    await refreshAll(user);
  } catch (error) {
    toast(error instanceof Error ? `数据加载失败：${error.message}` : "数据加载失败，请稍后重试", "error");
  }
}

installEvents();
renderTopbarForView(qs<HTMLElement>(".view.active")?.id || "dashboard");
void restoreSession();
