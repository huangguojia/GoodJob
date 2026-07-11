export type Role = "sales" | "manager" | "admin" | "super_admin";

export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
  role: Role;
  teamId: string;
  avatar: string;
  status: "active" | "disabled";
  outboundEmail?: string;
  emailSenderName?: string;
  emailSignature?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPassword?: string;
  hasSmtpPassword?: boolean;
  lastDevelopmentEmailAt?: string;
  lastDevelopmentEmailTo?: string;
  lastDevelopmentEmailSubject?: string;
}

export interface SessionUser {
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

export interface Customer {
  id: string;
  company: string;
  country: string;
  contact: string;
  ownerId: string;
  teamId: string;
  stage: string;
  amount: number;
  health: number;
  nextReminder: string;
  wecomBound: boolean;
  billingName: string;
  billingAddress: string;
  documentContact: string;
  defaultPortDischarge: string;
  defaultIncoterm: string;
  defaultPaymentTerm: string;
}

export type LeadStatus = "new" | "following" | "converted" | "invalid";
export type LeadActivityType = "call" | "wechat" | "whatsapp" | "linkedin" | "email" | "meeting" | "note" | "stage" | "system";
export type LeadSourceType = "outbound" | "inbound" | "offline" | "referral" | "import";

export interface Lead {
  id: string;
  company: string;
  contact: string;
  country: string;
  email: string;
  phone: string;
  wechat: string;
  source: string;
  intent: string;
  stage: string;
  status: LeadStatus;
  ownerId: string;
  teamId: string;
  estimatedAmount: number;
  nextFollowAt: string;
  lastActivityAt: string;
  remark: string;
  convertedCustomerId: string;
  convertedDealId: string;
  sourceType: LeadSourceType;
  sourceChannel: string;
  sourceCampaign: string;
  externalId: string;
  sourceUrl: string;
  createdAt: string;
  deletedAt?: string;
  deletedReason?: string;
}

export interface LeadSourceEvent {
  id: string;
  leadId: string;
  sourceType: LeadSourceType;
  channel: string;
  campaign: string;
  externalId: string;
  sourceUrl: string;
  occurredAt: string;
  receivedAt: string;
  rawPayload: string;
  ownerId: string;
  teamId: string;
}

export interface LeadActivity {
  id: string;
  leadId: string;
  type: LeadActivityType;
  content: string;
  operatorId: string;
  nextFollowAt: string;
  createdAt: string;
}

export interface Todo {
  id: string;
  title: string;
  type: "customer" | "knowledge" | "exam" | "ocr" | "other";
  priority: "high" | "medium" | "normal";
  status?: "pending" | "in_progress";
  pinState?: "top" | "bottom" | "";
  sortOrder?: number;
  dueAt: string;
  ownerId: string;
  teamId: string;
  related: string;
  done: boolean;
  impactAmount?: number;
  createdAt?: string;
  historyAt?: string;
}

export interface PlanTask {
  id: string;
  title: string;
  phase: string;
  category: string;
  priority: "high" | "medium" | "normal";
  status: "planned" | "active" | "done";
  dueAt: string;
  target: string;
  description: string;
  ownerId: string;
  teamId: string;
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
  ownerId: string;
  teamId: string;
  updatedAt: string;
}

export interface KnowledgeAsset {
  id: string;
  title: string;
  category: string;
  status: "published" | "draft" | "review";
  ownerId: string;
  version: string;
}

export interface Exam {
  id: string;
  title: string;
  category: string;
  status: "published" | "draft" | "scheduled";
  passRate: number;
  questionCount: number;
  durationMinutes?: number;
  passScore?: number;
  targetRole?: "all" | "sales" | "manager";
  updatedAt?: string;
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
  updatedAt?: string;
}

export interface ExamQuestionLink {
  examId: string;
  questionId: string;
  sortOrder: number;
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
  submittedAt: string;
}

export interface OcrJob {
  id: string;
  status: "recognized" | "synced";
  confidence: number;
  fields: Record<string, string>;
  ownerId: string;
  teamId: string;
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
  ownerId: string;
  teamId: string;
  status: "preview" | "synced";
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
}

export type LeadSourceTier = "free" | "byok_free" | "paid";

export interface LeadSourceConfig {
  id: string;
  provider: string;
  scope: "personal" | "team";
  apiKey: string;
  baseUrl?: string;
  enabled: boolean;
  lastTestAt?: string;
  lastTestStatus?: "untested" | "passed" | "failed";
  lastTestMessage?: string;
  usageJson?: string;
  ownerId: string;
  teamId: string;
  updatedAt: string;
}

export interface AiModelConfig {
  id: string;
  provider: string;
  protocol: "openai-compatible" | "anthropic" | "gemini";
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
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
  ownerId: string;
  teamId: string;
  updatedAt: string;
}

export interface Deal {
  id: string;
  customerId: string;
  title: string;
  stage: "询盘" | "已联系" | "已报价" | "样品" | "谈判" | "成交" | "丢单";
  product: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  ownerId: string;
  teamId: string;
  nextAction: string;
  archivedAt?: string;
}

export interface Reminder {
  id: string;
  title: string;
  rule: string;
  dueAt: string;
  ownerId: string;
  teamId: string;
  channel: "站内" | "邮件" | "企业微信";
  status: "pending" | "sent" | "done";
  ruleType?: "quote_no_reply" | "sample_feedback" | "inactive_customer" | "high_value_revisit" | "custom_due";
  targetStage?: string;
  days?: number;
  priority?: "high" | "medium" | "normal";
  enabled?: boolean;
  generatedCount?: number;
}

export interface ImportExportJob {
  id: string;
  name: string;
  type: "import" | "export";
  rows: number;
  status: "done" | "review" | "failed";
  operatorId: string;
  createdAt: string;
}

export interface TradeDocumentItem {
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

export interface TradeDocument {
  id: string;
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
  status: "draft" | "ready" | "exported";
  ownerId: string;
  teamId: string;
  updatedAt: string;
  items: TradeDocumentItem[];
}

export interface WecomMessage {
  id: string;
  customerId: string;
  summary: string;
  ownerId: string;
  teamId: string;
  status: "archived" | "pending";
}

export interface ProblemItem {
  id: string;
  title: string;
  category: string;
  severity: "high" | "medium" | "low";
  status: "open" | "solving" | "resolved";
  ownerId: string;
  teamId: string;
  relatedCustomer: string;
  rootCause: string;
  solution: string;
  nextAction: string;
  dueAt: string;
  createdAt: string;
}

export interface Memo {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string;
  ownerId: string;
  teamId: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
}

export interface Competitor {
  id: string;
  company: string;
  country: string;
  segment: string;
  threatLevel: "high" | "medium" | "low";
  website: string;
  strengths: string;
  weaknesses: string;
  competingProducts: string;
  ourStrategy: string;
  ownerId: string;
  teamId: string;
  updatedAt: string;
}

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
  status: "draft" | "published";
  ownerId: string;
  teamId: string;
  updatedAt: string;
}

export type CommissionRuleType = "rate" | "fixed" | "tier" | "gross_profit" | "none";
export type CommissionRecordStatus = "draft" | "confirmed" | "reviewed" | "locked";
export type CommissionCalculationStatus = "pending" | "calculated" | "reviewed" | "locked";

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
  ownerId: string;
  teamId: string;
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
  createdBy: string;
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
  settlementAmount: number;
  dealArchivedAt: string;
  sourceType: "deal" | "manual" | "adjusted";
  status: CommissionRecordStatus;
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
  operatorId: string;
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
  status: CommissionCalculationStatus;
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
  createdBy: string;
  createdAt: string;
}

export interface CommissionExport {
  id: string;
  month: string;
  scopeType: "self" | "team" | "all";
  scopeOwnerId: string;
  fileType: "xlsx" | "csv";
  rows: number;
  exportedBy: string;
  createdAt: string;
}
