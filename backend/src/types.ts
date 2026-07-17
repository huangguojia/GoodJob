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
  authVersion?: number;
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
  reportNote?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string;
  avatar: string;
  authVersion: number;
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

export type CustomerGrade = "A" | "B" | "C" | "D";

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
  grade?: CustomerGrade;
  nextReminder: string;
  wecomBound: boolean;
  billingName: string;
  billingAddress: string;
  documentContact: string;
  defaultPortDischarge: string;
  defaultIncoterm: string;
  defaultPaymentTerm: string;
  poolStatus?: "owned" | "public";
  previousOwnerId?: string;
  releasedBy?: string;
  releasedAt?: string;
  releaseReason?: string;
  claimedAt?: string;
  ownershipVersion?: number;
}

export interface CustomerOwnershipEvent {
  id: string;
  customerId: string;
  teamId: string;
  fromOwnerId: string;
  toOwnerId: string;
  action: "released" | "claimed";
  reason: string;
  operatorId: string;
  createdAt: string;
}

export interface CustomerOwnershipMutationInput {
  action: "release" | "claim";
  customerId: string;
  actorId: string;
  actorRole: Role;
  actorTeamId: string;
  reason?: string;
  expectedVersion?: number;
  occurredAt: string;
}

export interface CustomerOwnershipMutationResult {
  customer: Customer;
  event: CustomerOwnershipEvent;
  cancelledTodoIds: string[];
}

export type CustomerActivityType = "call" | "email" | "whatsapp" | "wechat" | "meeting" | "note";

export interface CustomerActivity {
  id: string;
  customerId: string;
  type: CustomerActivityType;
  content: string;
  operatorId: string;
  nextReminder: string;
  createdAt: string;
}

export interface CustomerAcquisitionSourceEvent {
  id: string;
  teamId: string;
  ownerId: string;
  customerId: string;
  leadId: string;
  leadSourceEventId: string;
  prospectId: string;
  organizationId: string;
  sourceChannel: string;
  sourceCampaign: string;
  sourceUrl: string;
  mode: "create_new" | "link_existing";
  processingKeyHash: string;
  requestHash: string;
  createdAt: string;
}

export type CustomerIntelligenceStatus =
  | "pending"
  | "accepted"
  | "rejected";

export type CustomerIntelligenceFieldKey =
  | "company"
  | "country"
  | "contact"
  | "documentContact";

export interface CustomerIntelligenceField {
  key: CustomerIntelligenceFieldKey;
  label: string;
  currentValue: string;
  suggestedValue: string;
  evidenceSummary: string;
}

export interface CustomerIntelligenceSuggestion {
  id: string;
  teamId: string;
  ownerId: string;
  customerId: string;
  prospectCandidateId: string;
  tenantProspectId?: string;
  organizationId?: string;
  leadId?: string;
  sourceEventId?: string;
  sourceLabel: string;
  sourceUrl: string;
  suggestedFields: CustomerIntelligenceField[];
  website: string;
  business: string;
  contactInfo: string;
  evidenceSummary: string;
  evidenceRefs: string[];
  payloadHash: string;
  status: CustomerIntelligenceStatus;
  acceptedFields: CustomerIntelligenceFieldKey[];
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  createdAt: string;
  updatedAt: string;
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
  deletedBy?: string;
  purgeAt?: string;
  statusBeforeDelete?: LeadStatus;
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
  bindingMode?: "web-scan" | "twilio-api" | "manual";  // 绑定模式
  userId?: string;  // 绑定此账号的用户ID（web-scan 模式用）
  sessionData?: string;  // WhatsApp Web 会话数据（web-scan 模式用）
  twilioPhoneNumber?: string;  // Twilio 分配的号码（twilio-api 模式用）
  connectionStatus?: "connected" | "disconnected" | "qr-pending" | "error";  // 连接状态
  lastConnectedAt?: string;  // 最后连接时间
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
  teamId?: string;
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
  ownerId?: string;
  teamId?: string;
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
  ownerId?: string;
  teamId?: string;
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

export type ProspectStatus = "preview" | "contactable" | "contacted" | "synced" | "excluded";

export type ProspectOutreachChannel = "email" | "whatsapp" | "call";

export type ProspectTouchpointDirection = "outbound" | "inbound";

export type ProspectReplyClassification =
  | "clear_demand"
  | "interested_nurture"
  | "referral"
  | "no_current_demand"
  | "rejected"
  | "unsubscribed"
  | "bounced"
  | "auto_unknown";

export type ProspectOutreachState =
  | "uncontacted"
  | "awaiting_reply"
  | "replied"
  | "suppressed"
  | "contact_invalid";

export interface ProspectTouchpoint {
  id: string;
  teamId: string;
  ownerId: string;
  prospectCandidateId: string;
  tenantProspectId?: string;
  organizationId?: string;
  leadId?: string;
  channel: ProspectOutreachChannel;
  direction: ProspectTouchpointDirection;
  contactValue: string;
  subject: string;
  content: string;
  replyClassification?: ProspectReplyClassification;
  requestId: string;
  occurredAt: string;
  createdAt: string;
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

export type ProcurementSignalStatus =
  | "needs_review"
  | "confirmed"
  | "dismissed"
  | "expired";

export interface ProcurementSignal {
  id: string;
  teamId: string;
  ownerId: string;
  prospectCandidateId: string;
  tenantProspectId?: string;
  organizationId?: string;
  leadId?: string;
  customerId?: string;
  sourceTouchpointId: string;
  sourceType: "buyer_reply" | "manual" | "provider";
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
  status: ProcurementSignalStatus;
  observedAt: string;
  validUntil: string;
  dismissedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type DealRecommendationStatus =
  | "generated"
  | "dismissed"
  | "linked_existing_deal"
  | "converted_by_user"
  | "expired";

export interface DealRecommendation {
  id: string;
  signalId: string;
  teamId: string;
  ownerId: string;
  prospectCandidateId: string;
  tenantProspectId?: string;
  organizationId?: string;
  leadId?: string;
  customerId?: string;
  suggestedTitle: string;
  suggestedProduct: string;
  suggestedQuantity: number;
  suggestedUnitPrice: number;
  suggestedAmount: number;
  currency: string;
  initialStage: "询盘";
  nextAction: string;
  nextActionAt: string;
  expectedCloseAt: string;
  reasonCodes: string[];
  missingFields: string[];
  evidenceRefs: string[];
  recommendationScore: number;
  duplicateDealIds: string[];
  status: DealRecommendationStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewReason?: string;
  linkedDealId?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export type AcquisitionOutcome = "won" | "lost";

export interface AcquisitionOutcomeFeedback {
  id: string;
  teamId: string;
  ownerId: string;
  dealId: string;
  customerId: string;
  leadId: string;
  prospectCandidateId: string;
  tenantProspectId: string;
  organizationId: string;
  campaignId: string;
  campaignVersion: number;
  strategyId: string;
  runId: string;
  providerCodes: string[];
  icpAssessmentId: string;
  icpPolicyId: string;
  outcome: AcquisitionOutcome;
  amount: number;
  currency: string;
  reasonCategory: string;
  reason: string;
  closedAt: string;
  attributionConfidence: number;
  attributionReasonCodes: string[];
  payloadHash: string;
  createdAt: string;
}

export type ProspectStrategySuggestionType =
  | "refine_targeting_keywords"
  | "increase_provider_priority"
  | "decrease_provider_priority"
  | "review_icp_exclusions"
  | "review_icp_weights";

export type ProspectStrategySuggestionStatus =
  | "pending"
  | "accepted"
  | "rejected";

export interface ProspectStrategySuggestion {
  id: string;
  teamId: string;
  ownerId: string;
  campaignId: string;
  campaignVersion: number;
  strategyId: string;
  suggestionType: ProspectStrategySuggestionType;
  sampleMetrics: Record<string, unknown>;
  proposedAdjustments: Record<string, unknown>;
  rationale: string;
  reasonCodes: string[];
  sampleFrom: string;
  sampleTo: string;
  payloadHash: string;
  status: ProspectStrategySuggestionStatus;
  reviewedBy: string;
  reviewedAt: string;
  reviewNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderEvidenceSnapshot {
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
  retentionPolicyRef: string;
}

export type ProspectVerificationCheckStatus =
  | "passed"
  | "partial"
  | "unverified"
  | "manual_required";

export interface ProspectVerificationCheck {
  code: string;
  label: string;
  status: ProspectVerificationCheckStatus;
  summary: string;
  source: string;
  checkedAt: string;
}

export interface ProspectVerificationReport {
  level: "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
  levelLabel: string;
  conclusion: string;
  generatedAt: string;
  crawlerFree: true;
  checks: ProspectVerificationCheck[];
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
  status: ProspectStatus;
  createdAt: string;
  customerId?: string;
  dealId?: string;
  leadId?: string;
  parseMode?: "rule" | "ai" | "fallback" | "reference";
  source?: string;
  sourceLabel?: string;
  sourceEvidence?: ProviderEvidenceSnapshot[];
  verificationReport?: ProspectVerificationReport;
  confidence?: number;
  lastDevelopmentEmailAt?: string;
  lastDevelopmentEmailSubject?: string;
  lastDevelopmentEmailTo?: string;
  verifiedAt?: string;
  statusChangedAt?: string;
  excludedReason?: string;
  tenantProspectId?: string;
  organizationId?: string;
  coverageClassification?: ProspectCoverageClassification;
  coverageQueueState?: TenantProspectQueueState;
  coverageReasonCode?: string;
  lastTouchpointAt?: string;
  lastTouchpointChannel?: ProspectOutreachChannel;
  lastReplyClassification?: ProspectReplyClassification;
  nextFollowAt?: string;
  outreachState?: ProspectOutreachState;
  invalidContactChannels?: ProspectOutreachChannel[];
}

export type LeadSourceTier = "free" | "byok_free" | "paid";

export type ProviderAccessMode = "api" | "bulk_file" | "website_controlled" | "manual_assisted" | "disabled";

export interface ProviderCatalogItem {
  id: string;
  code: string;
  name: string;
  category: string;
  sourceLevel: string;
  accessMode: ProviderAccessMode;
  baseUrl: string;
  officialDocsUrl: string;
  capabilities: string[];
  allowedFields: string[];
  licensePolicy: Record<string, unknown>;
  defaultRatePolicy: Record<string, unknown>;
  retentionPolicy: Record<string, unknown>;
  status: "active" | "review" | "disabled";
  version: string;
  reviewedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConnection {
  id: string;
  providerId: string;
  scope: "personal" | "team" | "platform";
  credentialRef: string;
  configurationEncrypted: string;
  status: "active" | "disabled" | "error";
  quotaPolicy: Record<string, unknown>;
  budgetPolicy: Record<string, unknown>;
  lastHealthAt: string;
  lastHealthStatus: "untested" | "passed" | "failed";
  lastErrorCode: string;
  lastHealthMessage: string;
  usage: string;
  ownerId: string;
  teamId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderResponseCache {
  id: string;
  providerId: string;
  providerVersion: string;
  requestFingerprint: string;
  payloadEncrypted: string;
  payloadHash: string;
  fetchedAt: string;
  expiresAt: string;
  licenseScope: string;
  status: "active" | "invalid";
}

export interface ProviderRequestLog {
  id: string;
  teamId: string;
  ownerId: string;
  providerId: string;
  connectionId: string;
  runId: string;
  runShardId: string;
  requestFingerprint: string;
  endpointCode: string;
  httpStatus: number;
  attempt: number;
  quotaUnits: number;
  costAmount: number;
  currency: string;
  durationMs: number;
  responseSize: number;
  errorCode: string;
  requestedAt: string;
}

export interface MarketTradeObservation {
  id: string;
  teamId: string;
  ownerId: string;
  campaignId: string;
  providerId: string;
  reporterCountry: string;
  partnerCountry: string;
  reporterCode: string;
  partnerCode: string;
  tradeFlow: "IMPORT" | "EXPORT";
  classification: string;
  commodityCode: string;
  commodityDescription: string;
  period: string;
  tradeValueUsd: number | null;
  netWeightKg: number | null;
  quantity: number | null;
  quantityUnit: string;
  isAggregate: boolean;
  suppressed: boolean;
  statusFlags: string[];
  rawRecordId: string;
  payloadHash: string;
  adapterVersion: string;
  sourceRevision: string;
  observedAt: string;
  createdAt: string;
}

export type ProspectCampaignStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "archived";

export interface ProspectCampaignVersionSnapshot {
  goal: string;
  products: string[];
  markets: string[];
  customerTypes: string[];
  applicationScenarios: string[];
  icpRules: string[];
  exclusionRules: string[];
  sourceProviderIds: string[];
}

export interface ProspectCampaign {
  id: string;
  teamId: string;
  ownerId: string;
  name: string;
  status: ProspectCampaignStatus;
  currentVersion: number;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string;
}

export interface ProspectCampaignVersion {
  id: string;
  teamId: string;
  campaignId: string;
  version: number;
  snapshot: ProspectCampaignVersionSnapshot;
  contentHash: string;
  changeSummary: string;
  createdBy: string;
  createdAt: string;
}

export type ProspectCampaignEventType =
  | "created"
  | "updated"
  | "owner_transferred"
  | "strategy_created"
  | "version_created"
  | "status_changed";

export interface ProspectCampaignEvent {
  id: string;
  teamId: string;
  campaignId: string;
  eventType: ProspectCampaignEventType;
  actorId: string;
  requestId: string;
  fromStatus: ProspectCampaignStatus | "";
  toStatus: ProspectCampaignStatus | "";
  fromOwnerId: string;
  toOwnerId: string;
  fromVersion: number;
  toVersion: number;
  revision: number;
  reason: string;
  createdAt: string;
}

export type ProspectStrategyStatus = "draft" | "approved" | "disabled";

export interface ProspectStrategyQuery {
  keywordMode: "campaign_products" | "specific";
  positiveKeywords: string[];
  synonyms: string[];
  industryTerms: string[];
  purchaseScenarioTerms: string[];
  countryMode: "campaign_markets" | "global" | "specific";
  countries: string[];
  languages: string[];
  customerTypeMode: "campaign_customer_types" | "all" | "specific";
  customerTypes: string[];
  exclusionKeywords: string[];
  exclusionDomains: string[];
  timeWindow: {
    mode: "all" | "fixed";
    from: string;
    to: string;
  };
}

export interface ProspectStrategyProviderPlanItem {
  providerId: string;
  priority: number;
  pageLimit: number;
  resultLimit: number;
  budgetLimit: number | null;
  currency: string;
}

export interface ProspectStrategy {
  id: string;
  teamId: string;
  campaignId: string;
  campaignVersion: number;
  name: string;
  status: ProspectStrategyStatus;
  revision: number;
  query: ProspectStrategyQuery;
  providerPlan: ProspectStrategyProviderPlanItem[];
  queryFingerprint: string;
  fingerprintVersion: "v1";
  ownerId: string;
  createdBy: string;
  approvedBy: string;
  approvedAt: string;
  disabledBy: string;
  disabledAt: string;
  disableReason: string;
  createdAt: string;
  updatedAt: string;
}

export type ProspectStrategyEventType =
  | "created"
  | "updated"
  | "approved"
  | "disabled"
  | "owner_transferred";

export interface ProspectStrategyEvent {
  id: string;
  teamId: string;
  campaignId: string;
  strategyId: string;
  eventType: ProspectStrategyEventType;
  actorId: string;
  requestId: string;
  fromStatus: ProspectStrategyStatus | "";
  toStatus: ProspectStrategyStatus;
  fromRevision: number;
  toRevision: number;
  reason: string;
  createdAt: string;
}

export type ProspectScheduleFrequency = "daily" | "weekly" | "monthly";
export type ProspectScheduleStatus = "active" | "paused";

export interface ProspectSchedule {
  id: string;
  teamId: string;
  ownerId: string;
  campaignId: string;
  campaignVersion: number;
  strategyId: string;
  frequency: ProspectScheduleFrequency;
  status: ProspectScheduleStatus;
  timezone: string;
  nextRunAt: string;
  lastRunAt: string;
  lastRunId: string;
  lastPlannedAt: string;
  lastFailureCode: string;
  lastFailureReason: string;
  recurringCostApproved: boolean;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ProspectSearchRunStatus =
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

export type ProspectRunShardStatus =
  | "queued"
  | "running"
  | "retry_scheduled"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "succeeded_empty"
  | "partial_success"
  | "failed";

export interface ProspectResolvedQuerySnapshot {
  positiveKeywords: string[];
  synonyms: string[];
  industryTerms: string[];
  purchaseScenarioTerms: string[];
  countries: string[];
  languages: string[];
  customerTypes: string[];
  exclusionKeywords: string[];
  exclusionDomains: string[];
  timeWindow: {
    mode: "all" | "fixed";
    from: string;
    to: string;
  };
}

export interface ProspectRunProviderSnapshot {
  providerCode: string;
  position: number;
  priority: number;
  pageLimit: number;
  resultLimit: number;
  budgetLimit: number | null;
  currency: string;
  adapterVersion: string;
  contractVersion: string;
  catalogVersion: string;
  capabilities: string[];
  accessMode: ProviderAccessMode;
}

export interface ProspectRunExecutionSnapshot {
  contractVersion: "search_run_control_plane_v1";
  campaign: {
    id: string;
    name: string;
    version: number;
    contentHash: string;
    snapshot: ProspectCampaignVersionSnapshot;
  };
  strategy: {
    id: string;
    name: string;
    revision: number;
    fingerprintVersion: "v1";
    queryFingerprint: string;
    query: ProspectStrategyQuery;
  };
  resolvedQuery: ProspectResolvedQuerySnapshot;
  providerPlan: ProspectRunProviderSnapshot[];
}

export interface ProspectSearchRun {
  id: string;
  teamId: string;
  campaignId: string;
  campaignVersion: number;
  strategyId: string;
  ownerId: string;
  status: ProspectSearchRunStatus;
  revision: number;
  executionEpoch: number;
  operationCode: "create_search_run_v1";
  idempotencyKeyHash: string;
  requestHash: string;
  queryFingerprint: string;
  executionSnapshot: ProspectRunExecutionSnapshot;
  executionSnapshotHash: string;
  queueBridgeVersion: "v1" | null;
  parentRunId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  pausedAt: string;
  cancelledAt: string;
}

export interface ProspectRunShard {
  id: string;
  teamId: string;
  runId: string;
  providerCode: string;
  position: number;
  status: ProspectRunShardStatus;
  pageLimit: number;
  resultLimit: number;
  budgetLimit: number | null;
  currency: string;
  adapterVersion: string;
  contractVersion: string;
  catalogVersion: string;
  capabilities: string[];
  accessMode: ProviderAccessMode;
  hasCursor: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProspectRunEventType =
  | "created"
  | "started"
  | "pause_requested"
  | "paused"
  | "resumed"
  | "cancel_requested"
  | "cancelled"
  | "completed"
  | "failed";

export interface ProspectRunEvent {
  id: string;
  teamId: string;
  runId: string;
  sequence: number;
  eventType: ProspectRunEventType;
  actorId: string;
  requestId: string;
  fromStatus: ProspectSearchRunStatus | "";
  toStatus: ProspectSearchRunStatus;
  fromRevision: number;
  toRevision: number;
  reason: string;
  createdAt: string;
}

export interface ProspectRunQueueParentBinding {
  id: string;
  teamId: string;
  runId: string;
  ownerId: string;
  jobId: string;
  jobType: "prospect.orchestrate";
  parentJobId: "";
  bridgeVersion: "v1";
  executionSnapshotHash: string;
  bindingHash: string;
  createdAt: string;
}

export interface ProspectRunQueueChildBinding {
  id: string;
  teamId: string;
  runId: string;
  shardId: string;
  ownerId: string;
  jobId: string;
  jobType: "prospect.provider.fetch";
  parentJobId: string;
  bridgeVersion: "v1";
  executionSnapshotHash: string;
  bindingHash: string;
  createdAt: string;
}

export type ProspectExecutionLeaseStatus =
  | "active"
  | "released"
  | "expired";

export type ProspectExecutionAttemptStatus =
  | "claimed"
  | "request_started"
  | "succeeded"
  | "failed"
  | "request_outcome_unknown"
  | "cancelled_late";

export type ProspectExecutionCostKind =
  | "actual"
  | "estimated"
  | "unknown";

export type ProspectExecutionEventType =
  | "kernel_started"
  | "lease_claimed"
  | "lease_heartbeat"
  | "request_started"
  | "page_accepted"
  | "retry_scheduled"
  | "pause_settled"
  | "cancel_settled"
  | "lease_recovered"
  | "shard_completed"
  | "run_completed";

export interface ProspectExecutionKernelState {
  id: "search_execution_kernel_v1";
  kernelEpoch: number;
  instanceId: string;
  startedAt: string;
  updatedAt: string;
}

export interface ProspectExecutionCheckpoint {
  id: string;
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  jobId: string;
  providerCode: string;
  runEpoch: number;
  checkpointNo: number;
  encryptedCursor: string;
  cursorHash: string;
  pageSequence: number;
  totalCallCount: number;
  checkpointCallCount: number;
  acceptedCount: number;
  rawCount: number;
  invalidCount: number;
  duplicateCount: number;
  retryAfterAt: string;
  lastErrorCode: string;
  lastErrorMessage: string;
  partial: boolean;
  completionReason: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ProspectStrategySourcePositionStatus =
  | "continuable"
  | "exhausted";

export interface ProspectStrategySourcePosition {
  id: string;
  identityHash: string;
  teamId: string;
  ownerId: string;
  campaignId: string;
  campaignVersion: number;
  strategyId: string;
  providerCode: string;
  queryFingerprint: string;
  connectionId: string;
  endpointCode: string;
  adapterVersion: string;
  contractVersion: string;
  catalogVersion: string;
  timeWindowMode: "all" | "fixed";
  timeWindowFrom: string;
  timeWindowTo: string;
  status: ProspectStrategySourcePositionStatus;
  encryptedCursor: string;
  cursorHash: string;
  sourceRunId: string;
  sourceShardId: string;
  sourcePageId: string;
  sourceCheckpointNo: number;
  sourcePageSequence: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProspectExecutionLease {
  id: string;
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  jobId: string;
  kernelEpoch: number;
  runEpoch: number;
  fenceToken: number;
  claimTokenHmac: string;
  workerId: string;
  status: ProspectExecutionLeaseStatus;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  deadlineAt: string;
  requestStartedAt: string;
  releasedAt: string;
  releaseReason: string;
  version: number;
}

export interface ProspectExecutionAttempt {
  id: string;
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  jobId: string;
  leaseId: string;
  providerCode: string;
  checkpointNo: number;
  checkpointCallNo: number;
  providerAttemptNo: number;
  status: ProspectExecutionAttemptStatus;
  requestHash: string;
  responseHash: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  retryAfterAt: string;
  usageJson: string;
  costKind: ProspectExecutionCostKind;
  costAmount: number | null;
  currency: string;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
  version: number;
}

export type ProspectProviderRequestStatus =
  | "prepared"
  | "dispatch_started"
  | "dispatch_confirmed"
  | "response_received"
  | "outcome_unknown"
  | "settled"
  | "cancelled_late";

export type ProspectProviderRequestSettlementKind =
  | ""
  | "success"
  | "failure"
  | "cancelled_before_dispatch"
  | "cancelled_late";

export type ProspectProviderRequestDispatchOperation =
  | "dispatch"
  | "query_by_idempotency_key"
  | "query_by_external_request_id";

export type ProspectProviderRequestDispatchStatus =
  | "started"
  | "confirmed"
  | "response_received"
  | "outcome_unknown"
  | "rejected";

export type ProspectProviderAccountingProvenance =
  | "unknown"
  | "estimated"
  | "provider_reported"
  | "portal_export"
  | "invoice_confirmed";

export interface ProspectProviderRequestLedger {
  id: string;
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  jobId: string;
  originAttemptId: string;
  checkpointNo: number;
  logicalRequestNo: number;
  providerCode: string;
  connectionId: string;
  connectionRevision: string;
  connectionConfigHash: string;
  endpointCode: string;
  adapterVersion: string;
  contractVersion: string;
  requestSchemaVersion: string;
  idempotencyKey: string;
  requestHash: string;
  encryptedRequestEnvelope: string;
  requestEvidenceRef: string;
  status: ProspectProviderRequestStatus;
  externalRequestId: string;
  dispatchConfirmationRef: string;
  encryptedResponseEnvelope: string;
  responseEvidenceRef: string;
  responseHash: string;
  rawResponseHash: string;
  normalizedResultHash: string;
  responseAccountingEvidenceHash: string;
  httpStatus: number | null;
  providerOutcomeCode: string;
  settlementKind: ProspectProviderRequestSettlementKind;
  settlementHash: string;
  unknownReason: string;
  errorCode: string;
  kernelEpochAtPrepare: number;
  runEpochAtPrepare: number;
  fenceTokenAtPrepare: number;
  leaseIdAtPrepare: string;
  preparedAt: string;
  dispatchStartedAt: string;
  dispatchConfirmedAt: string;
  responseReceivedAt: string;
  unknownAt: string;
  settledAt: string;
  cancelledLateAt: string;
  updatedAt: string;
  version: number;
}

export interface ProspectProviderRequestDispatch {
  id: string;
  ledgerId: string;
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  attemptId: string;
  dispatchNo: number;
  operation: ProspectProviderRequestDispatchOperation;
  status: ProspectProviderRequestDispatchStatus;
  idempotencyKey: string;
  requestHash: string;
  replayed: boolean;
  providerExecuted: boolean;
  externalRequestId: string;
  responseHash: string;
  errorCode: string;
  startedAt: string;
  confirmedAt: string;
  finishedAt: string;
  version: number;
}

export interface ProspectProviderRequestEvent {
  id: string;
  ledgerId: string;
  dispatchId: string;
  attemptId: string;
  teamId: string;
  ownerId: string;
  sequence: number;
  eventType: ProspectProviderRequestStatus;
  fromStatus: ProspectProviderRequestStatus | "";
  toStatus: ProspectProviderRequestStatus;
  detailHash: string;
  createdAt: string;
}

export interface ProspectProviderRequestAttemptBinding {
  id: string;
  ledgerId: string;
  attemptId: string;
  teamId: string;
  ownerId: string;
  bindingNo: number;
  createdAt: string;
}

export interface ProspectProviderRequestAccountingEvidence {
  id: string;
  ledgerId: string;
  teamId: string;
  ownerId: string;
  sequence: number;
  provenance: ProspectProviderAccountingProvenance;
  usageJson: string;
  costAmount: number | null;
  currency: string;
  evidenceRef: string;
  evidenceHash: string;
  estimationMethodVersion: string;
  createdAt: string;
}

export interface ProspectSourceRawBatch {
  id: string;
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  jobId: string;
  attemptId: string;
  ledgerId: string;
  pageId: string;
  providerCode: string;
  connectionId: string;
  endpointCode: string;
  adapterVersion: string;
  responseSchemaVersion: "fake-provider-source-records-v1";
  responseHash: string;
  settlementHash: string;
  rawArtifactHash: string;
  recordCount: number;
  licensePolicy: string;
  retentionPolicy: string;
  retentionDays: number;
  retentionUntil: string;
  batchHash: string;
  createdAt: string;
}

export interface ProspectSourceRawRecord {
  id: string;
  teamId: string;
  ownerId: string;
  providerCode: string;
  connectionId: string;
  endpointCode: string;
  sourceIdentityHash: string;
  artifactHash: string;
  envelopeVersion: "provider-raw-v1";
  encryptedEnvelope: string;
  envelopeHash: string;
  firstObservedAt: string;
  recordHash: string;
  createdAt: string;
}

export interface ProspectSourceRawHit {
  id: string;
  batchId: string;
  recordId: string;
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  jobId: string;
  attemptId: string;
  ledgerId: string;
  pageId: string;
  ordinal: number;
  fetchedAt: string;
  hitHash: string;
  createdAt: string;
}

export interface ProspectCandidateProcessingState {
  hitId: string;
  teamId: string;
  ownerId: string;
  runId: string;
  ledgerId: string;
  status: "completed" | "rejected";
  failureCode: string;
  candidateId?: string;
  processedAt: string;
  updatedAt: string;
}

export type OrganizationIdentityClaimKind =
  | "legal_name"
  | "official_domain"
  | "lei"
  | "registration_number"
  | "vat";

export type OrganizationStrongIdentifierKind =
  | "lei"
  | "registration_number"
  | "vat";

export type OrganizationIdentityEntityType =
  | "legal_entity"
  | "branch"
  | "establishment"
  | "vat_group"
  | "tax_representative"
  | "unknown";

export type OrganizationIdentityResolutionResult =
  | "new_entity"
  | "exact_match"
  | "insufficient_identity"
  | "conflict";

export interface Organization {
  id: string;
  teamId: string;
  scopeType: "team";
  scopeId: string;
  status: "active";
  legalName: string;
  normalizedName: string;
  organizationHash: string;
  createdAt: string;
}

export interface OrganizationIdentityClaim {
  id: string;
  resolutionId: string;
  teamId: string;
  ownerId: string;
  rawRecordId: string;
  ordinal: number;
  kind: OrganizationIdentityClaimKind;
  originalValue: string;
  normalizedValue: string;
  scheme: string;
  jurisdiction: string;
  entityType: OrganizationIdentityEntityType;
  subjectRef: string;
  classification:
    | "association_fact"
    | "strong_identifier_eligible"
    | "strong_identifier_unverified";
  normalizerVersion: string;
  validatorVersion: string;
  authorityProfileCode: string;
  observedAt: string;
  claimHash: string;
  claimFactHash: string;
  createdAt: string;
}

export interface OrganizationAcceptedIdentifier {
  id: string;
  organizationId: string;
  teamId: string;
  kind: OrganizationStrongIdentifierKind;
  scheme: string;
  jurisdiction: string;
  normalizedValue: string;
  normalizedValueHash: string;
  sourceClaimId: string;
  sourceRawRecordId: string;
  sourceOwnerId: string;
  authorityProfileCode: string;
  authorityProfileVersion: string;
  status: "active";
  identifierHash: string;
  createdAt: string;
}

export interface OrganizationIdentityResolution {
  id: string;
  teamId: string;
  ownerId: string;
  rawRecordId: string;
  rawArtifactHash: string;
  processingKeyHash: string;
  claimHash: string;
  resolverContractVersion: "organization-strong-identity-v1";
  parserVersion: string;
  normalizerVersion: string;
  authorityProfileCode: string;
  authorityProfileVersion: string;
  authorityProfileHash: string;
  result: OrganizationIdentityResolutionResult;
  decisionReasonCode: string;
  organizationId: string;
  bindingId: string;
  conflictId: string;
  matchedIdentifierIds: string[];
  acceptedIdentifierIds: string[];
  bindingRelationRole: "" | "reused_existing" | "created_new";
  relationHash: string;
  eventCount: number;
  eventTailHash: string;
  resolutionHash: string;
  createdAt: string;
}

export interface OrganizationSourceBinding {
  id: string;
  organizationId: string;
  resolutionId: string;
  teamId: string;
  ownerId: string;
  rawRecordId: string;
  status: "active";
  bindingHash: string;
  createdAt: string;
}

export type ProspectCoverageClassification =
  | "net_new"
  | "new_intelligence"
  | "due_review"
  | "duplicate"
  | "excluded";

export type TenantProspectStatus =
  | "active"
  | "excluded"
  | "do_not_contact"
  | "converted";

export type TenantProspectQueueState =
  | "none"
  | "pending"
  | "suppressed"
  | "converted";

export interface TenantProspect {
  id: string;
  teamId: string;
  organizationId: string;
  status: TenantProspectStatus;
  latestClassification: ProspectCoverageClassification;
  queueState: TenantProspectQueueState;
  queueReasonCode: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastMaterialChangeAt: string;
  lastQueuedAt: string;
  lastReviewedAt: string;
  nextReviewAt: string;
  hitCount: number;
  sourceCount: number;
  evidenceCount: number;
  sourceKeyHashes: string[];
  materialEvidenceKeyHashes: string[];
  exclusionScope: "none" | "organization" | "team";
  exclusionMode: "none" | "temporary" | "permanent";
  exclusionReasonCode: string;
  excludedUntil: string;
  leadId: string;
  customerId: string;
  dealId: string;
  version: number;
  eventCount: number;
  eventTailHash: string;
  prospectHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProspectCoverageEvent {
  id: string;
  prospectId: string;
  teamId: string;
  ownerId: string;
  organizationId: string;
  resolutionId: string;
  rawRecordId: string;
  sourceHitId: string;
  campaignId: string;
  strategyId: string;
  runId: string;
  shardId: string;
  sequence: number;
  eventType: "coverage_classified" | "disposition_changed";
  dispositionAction:
    | ""
    | "exclude_temporary"
    | "exclude_permanent"
    | "do_not_contact"
    | "resume"
    | "mark_reviewed"
    | "link_crm";
  classification: ProspectCoverageClassification | "";
  queueAction: "enqueue" | "suppress" | "none";
  reasonCode: string;
  processingKeyHash: string;
  requestHash: string;
  newEvidenceKeyHashes: string[];
  newSourceKeyHashes: string[];
  evidenceSnapshotHash: string;
  sourceSnapshotHash: string;
  previousEventHash: string;
  eventHash: string;
  createdAt: string;
}

export type ProspectEvidenceKind =
  | "company_verification"
  | "icp"
  | "contact";

export type ProspectEvidenceField =
  | "legal_name"
  | "registration_number"
  | "operating_status"
  | "jurisdiction"
  | "official_domain"
  | "product_match"
  | "customer_type"
  | "market_match"
  | "purchasing_capability"
  | "contact_source"
  | "freshness";

export type ProspectEvidenceSourceType =
  | "authoritative_registry"
  | "official_website"
  | "licensed_data"
  | "public_directory"
  | "manual_import"
  | "crm_manual";

export interface ProspectEvidence {
  id: string;
  teamId: string;
  ownerId: string;
  prospectId: string;
  organizationId: string;
  kind: ProspectEvidenceKind;
  field: ProspectEvidenceField;
  normalizedValue: string;
  valueHash: string;
  sourceType: ProspectEvidenceSourceType;
  providerCode: string;
  sourceRef: string;
  excerpt: string;
  authorityCode: string;
  observedAt: string;
  expiresAt: string;
  idempotencyKeyHash: string;
  requestHash: string;
  recordHash: string;
  createdAt: string;
}

export type CompanyVerificationStatus =
  | "verified_active"
  | "verified_inactive"
  | "partially_verified"
  | "conflicting"
  | "unverified";

export interface CompanyVerificationSnapshot {
  id: string;
  teamId: string;
  prospectId: string;
  organizationId: string;
  status: CompanyVerificationStatus;
  reasonCodes: string[];
  authorityCodes: string[];
  evidenceSnapshotHash: string;
  reviewStatus:
    | "not_required"
    | "pending_review"
    | "approved"
    | "rejected";
  reviewedBy: string;
  reviewedAt: string;
  validUntil: string;
  previousSnapshotId: string;
  contractVersion: string;
  idempotencyKeyHash: string;
  requestHash: string;
  recordHash: string;
  createdAt: string;
}

export type ProspectIcpDimension =
  | "productApplicationMatch"
  | "customerType"
  | "marketCountry"
  | "companyAuthenticity"
  | "purchasingChannelCapability"
  | "contactability"
  | "freshness";

export type ProspectIcpWeights = Record<ProspectIcpDimension, number>;
export type ProspectIcpDimensionScores =
  Record<ProspectIcpDimension, number>;

export interface ProspectIcpPolicySnapshot {
  id: string;
  teamId: string;
  ownerId: string;
  campaignId: string;
  campaignVersion: number;
  campaignContentHash: string;
  weights: ProspectIcpWeights;
  qualifiedThreshold: number;
  borderlineThreshold: number;
  productMinimum: number;
  hardExclusions: string[];
  scoringContractVersion: string;
  policyHash: string;
  idempotencyKeyHash: string;
  requestHash: string;
  recordHash: string;
  createdAt: string;
}

export type ProspectIcpResult =
  | "qualified"
  | "borderline"
  | "not_qualified"
  | "blocked";

export interface ProspectIcpAssessmentSnapshot {
  id: string;
  teamId: string;
  ownerId: string;
  prospectId: string;
  organizationId: string;
  policyId: string;
  campaignId: string;
  campaignVersion: number;
  dimensionScores: ProspectIcpDimensionScores;
  totalScore: number;
  result: ProspectIcpResult;
  hardGateReasonCodes: string[];
  evidenceIds: string[];
  evidenceSnapshotHash: string;
  reviewStatus: "pending_review" | "approved" | "rejected";
  reviewedBy: string;
  reviewedAt: string;
  previousAssessmentId: string;
  scoringContractVersion: string;
  idempotencyKeyHash: string;
  requestHash: string;
  recordHash: string;
  createdAt: string;
}

export type ProspectContactType =
  | "named_person"
  | "department"
  | "company_public";

export interface ProspectContact {
  id: string;
  teamId: string;
  ownerId: string;
  prospectId: string;
  organizationId: string;
  contactType: ProspectContactType;
  name: string;
  department: string;
  title: string;
  identityStatus: "unconfirmed" | "source_confirmed" | "human_confirmed";
  sourceEvidenceId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  recordHash: string;
  createdAt: string;
}

export type ProspectContactChannelType =
  | "email"
  | "phone"
  | "whatsapp"
  | "website_form";

export type ProspectContactVerificationStatus =
  | "discovered"
  | "syntax_valid"
  | "domain_valid"
  | "verified"
  | "bounced"
  | "opted_out"
  | "invalid";

export interface ProspectContactChannel {
  id: string;
  teamId: string;
  ownerId: string;
  prospectId: string;
  organizationId: string;
  contactId: string;
  channelType: ProspectContactChannelType;
  value: string;
  normalizedValueHash: string;
  sourceEvidenceId: string;
  acquiredAt: string;
  idempotencyKeyHash: string;
  requestHash: string;
  recordHash: string;
  createdAt: string;
}

export interface ProspectContactVerificationSnapshot {
  id: string;
  teamId: string;
  ownerId: string;
  prospectId: string;
  organizationId: string;
  contactId: string;
  channelId: string;
  status: ProspectContactVerificationStatus;
  providerCode: string;
  reasonCode: string;
  verifiedAt: string;
  expiresAt: string;
  previousVerificationId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  recordHash: string;
  createdAt: string;
}

export type ProspectSuppressionScope =
  | "contact_channel"
  | "contact_all"
  | "organization_channel"
  | "organization_all";

export interface ProspectSuppressionEvent {
  id: string;
  teamId: string;
  ownerId: string;
  prospectId: string;
  organizationId: string;
  contactId: string;
  channelId: string;
  channelType: ProspectContactChannelType | "";
  scope: ProspectSuppressionScope;
  scopeKeyHash: string;
  action: "imposed" | "revoked";
  reasonCode: string;
  reasonNote: string;
  effectiveAt: string;
  expiresAt: string;
  createdBy: string;
  idempotencyKeyHash: string;
  requestHash: string;
  recordHash: string;
  createdAt: string;
}

export type ProspectContactabilityStatus =
  | "blocked"
  | "review_required"
  | "eligible"
  | "approved_contactable"
  | "stale";

export interface ProspectContactabilityDecision {
  id: string;
  teamId: string;
  ownerId: string;
  prospectId: string;
  organizationId: string;
  campaignId: string;
  campaignVersion: number;
  channelId: string;
  status: ProspectContactabilityStatus;
  reasonCodes: string[];
  dependencyHash: string;
  approvedBy: string;
  approvedAt: string;
  previousDecisionId: string;
  contractVersion: string;
  idempotencyKeyHash: string;
  requestHash: string;
  recordHash: string;
  createdAt: string;
}

export interface OrganizationIdentityConflict {
  id: string;
  resolutionId: string;
  teamId: string;
  ownerId: string;
  rawRecordId: string;
  conflictType:
    | "identifier_split"
    | "identifier_slot_conflict"
    | "binding_conflict";
  organizationIds: string[];
  identifierKeys: string[];
  status: "open";
  relationHash: string;
  conflictHash: string;
  createdAt: string;
}

export interface OrganizationIdentityConflictReview {
  id: string;
  conflictId: string;
  teamId: string;
  action: "keep_separate" | "merge";
  canonicalOrganizationId: string;
  note: string;
  reviewedBy: string;
  reviewHash: string;
  createdAt: string;
}

export interface OrganizationCanonicalMapping {
  id: string;
  conflictId: string;
  teamId: string;
  sourceOrganizationId: string;
  canonicalOrganizationId: string;
  createdBy: string;
  mappingHash: string;
  createdAt: string;
}

export type OrganizationAliasType =
  | "legal_name"
  | "trading_name"
  | "brand"
  | "previous_name"
  | "localized_name";

export interface OrganizationAliasFact {
  id: string;
  teamId: string;
  organizationId: string;
  aliasType: OrganizationAliasType;
  aliasName: string;
  normalizedAlias: string;
  locale: string;
  jurisdiction: string;
  sourceLabel: string;
  sourceReference: string;
  evidenceSummary: string;
  verificationStatus: "reported" | "verified";
  observedAt: string;
  createdBy: string;
  factKeyHash: string;
  factHash: string;
  createdAt: string;
}

export type OrganizationRelationType =
  | "direct_parent"
  | "ultimate_parent"
  | "branch_of"
  | "brand_of"
  | "affiliate";

export interface OrganizationRelationFact {
  id: string;
  teamId: string;
  sourceOrganizationId: string;
  targetOrganizationId: string;
  relationType: OrganizationRelationType;
  sourceLabel: string;
  sourceReference: string;
  evidenceSummary: string;
  verificationStatus: "reported" | "verified";
  observedAt: string;
  createdBy: string;
  factKeyHash: string;
  factHash: string;
  createdAt: string;
}

export interface OrganizationIdentityEvent {
  id: string;
  resolutionId: string;
  teamId: string;
  ownerId: string;
  sequence: number;
  eventType:
    | "organization_created"
    | "organization_matched"
    | "identifier_accepted"
    | "source_bound"
    | "identity_insufficient"
    | "identity_conflict_recorded"
    | "resolution_recorded";
  organizationId: string;
  detailHash: string;
  previousEventHash: string;
  eventHash: string;
  createdAt: string;
}

export interface ProspectExecutionPage {
  id: string;
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  jobId: string;
  attemptId: string;
  providerCode: string;
  checkpointNo: number;
  pageSequence: number;
  payloadHash: string;
  acceptedCount: number;
  rawCount: number;
  invalidCount: number;
  duplicateCount: number;
  partial: boolean;
  createdAt: string;
}

export interface ProspectExecutionEvent {
  id: string;
  teamId: string;
  ownerId: string;
  runId: string;
  shardId: string;
  jobId: string;
  eventType: ProspectExecutionEventType;
  kernelEpoch: number;
  runEpoch: number;
  fenceToken: number;
  detailHash: string;
  createdAt: string;
}

export interface ProspectExecutionThrottleBucket {
  id: string;
  teamId: string;
  providerCode: string;
  connectionId: string;
  availableAt: string;
  version: number;
  updatedAt: string;
}

export type MarketOpportunityBatchStatus =
  | "metrics_ready"
  | "partial"
  | "insufficient_data";

export type MarketOpportunitySnapshotStatus =
  | "metrics_ready"
  | "insufficient_data";

export interface MarketOpportunityEvidence {
  observationId: string;
  payloadHash: string;
  providerId: string;
  adapterVersion: string;
  sourceRevision: string;
  period: string;
  reporterCountry: string;
  reporterCode: string;
  partnerCountry: string;
  partnerCode: string;
  tradeFlow: "IMPORT";
  classification: string;
  commodityCode: string;
  tradeValueUsd: number | null;
  suppressed: boolean;
  statusFlags: string[];
}

export interface MarketOpportunityValuePoint {
  period: string;
  tradeValueUsd: number;
  evidence: MarketOpportunityEvidence;
}

export interface MarketOpportunityRateChange {
  fromPeriod: string;
  toPeriod: string;
  value: number | null;
  reason: string;
}

export interface MarketOpportunityMetrics {
  metricVersion: "market_opportunity_facts_v1";
  reportedImportValueSeries: MarketOpportunityValuePoint[];
  yoyChanges: MarketOpportunityRateChange[];
  twoYearCagr: number | null;
  twoYearCagrReason: string;
  chinaMainlandSupplyShare: number | null;
  chinaMainlandSupplyShareReason: string;
  chinaMainlandEvidence: MarketOpportunityEvidence | null;
}

export interface MarketOpportunityBatch {
  id: string;
  teamId: string;
  ownerId: string;
  campaignId: string;
  providerId: "un_comtrade";
  datasetFingerprint: string;
  policyVersion: "market_opportunity_facts_v1";
  status: MarketOpportunityBatchStatus;
  emptyReason: string;
  candidateCount: number;
  readyCount: number;
  comparisonPeriods: string[];
  firstTriggerJobId: string;
  observationCutoffAt: string | null;
  createdAt: string;
}

export interface MarketOpportunitySnapshot {
  id: string;
  batchId: string;
  teamId: string;
  ownerId: string;
  campaignId: string;
  providerId: "un_comtrade";
  reporterCountry: string;
  reporterCode: string;
  classification: string;
  commodityCode: string;
  commodityDescription: string;
  comparisonPeriod: string;
  snapshotStatus: MarketOpportunitySnapshotStatus;
  insufficiencyReasons: string[];
  metrics: MarketOpportunityMetrics;
  marketScore: number | null;
  growthScore: number | null;
  chinaSupplyScore: number | null;
  createdAt: string;
}

export interface MarketOpportunityCalculationEvent {
  id: string;
  teamId: string;
  ownerId: string;
  campaignId: string;
  triggerJobId: string;
  batchId: string;
  datasetFingerprint: string;
  policyVersion: "market_opportunity_facts_v1";
  outcome: MarketOpportunityBatchStatus;
  reusedBatch: boolean;
  sequence: number;
  calculatedAt: string;
}

export type AgentJobStatus =
  | "queued"
  | "running"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "dead_letter";

export interface AgentJob {
  id: string;
  teamId: string;
  ownerId: string;
  jobType: string;
  aggregateType: string;
  aggregateId: string;
  parentJobId: string;
  status: AgentJobStatus;
  priority: number;
  idempotencyKey: string;
  policyVersion: string;
  inputJsonEncrypted: string;
  outputJsonEncrypted: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  errorCode: string;
  errorMessage: string;
  traceId: string;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
}

export interface AgentJobIdempotencyAlias {
  id: string;
  jobId: string;
  teamId: string;
  jobType: string;
  idempotencyKey: string;
  createdAt: string;
}

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
  currency: string;
  amountType: "estimate" | "quoted" | "won";
  ownerId: string;
  teamId: string;
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

export type DealEventType = "created" | "updated" | "stage" | "follow_up" | "quote" | "sample" | "negotiation" | "payment" | "document" | "won" | "lost" | "archived";

export interface DealEvent {
  id: string;
  dealId: string;
  type: DealEventType;
  content: string;
  operatorId: string;
  fromStage?: Deal["stage"];
  toStage?: Deal["stage"];
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
  ownerId: string;
  teamId: string;
  channel: "站内" | "邮件" | "企业微信";
  status: "enabled" | "disabled";
  ruleType?: "quote_no_reply" | "sample_feedback" | "inactive_customer" | "high_value_revisit" | "custom_due";
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
  // 报关资料相关扩展字段
  brand?: string;
  brandType?: string;
  exportBenefit?: string;
  inspectionCode?: string;
  productEnglish?: string;
}

export interface CustomsDocument {
  id: string;
  customerId: string;
  dealId: string;
  tradeDocumentId?: string;
  number: string;
  issueDate: string;
  // 发货人信息
  shipper: string;
  shipperAddress: string;
  shipperTaxNo: string;
  // 收货人信息
  consignee: string;
  consigneeAddress: string;
  // 生产销售单位
  manufacturer: string;
  manufacturerTaxNo: string;
  // 运输信息
  transportMode: string;
  vesselName: string;
  exitPort: string;
  exitDate: string;
  tradeMode: string;
  supervisionMode: string;
  // 贸易信息
  tradeCountry: string;
  destinationCountry: string;
  packageType: string;
  packageCount: number;
  grossWeight: number;
  netWeight: number;
  tradeMethod: string;
  contractNo: string;
  // 支付信息
  currency: string;
  incoterm: string;
  paymentTerm: string;
  // 其他信息
  notes: string;
  status: "draft" | "ready" | "exported";
  ownerId: string;
  teamId: string;
  updatedAt: string;
  items: TradeDocumentItem[];
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
  type: "PI" | "CI" | "CUSTOMS";
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
  ownerId: string;
  teamId: string;
  updatedAt: string;
  items: TradeDocumentItem[];
  // 报关资料特有字段
  customsData?: CustomsDocument;
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
  customerId: string;
  dealId: string;
  ownerId: string;
  teamId: string;
  pinned: boolean;
  archived: boolean;
  deletedAt: string;
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
  exchangeRateDate: string;
  exchangeRateSource: "pending" | "manual" | "finance";
  settlementCurrency: string;
  settlementAmount: number;
  basisType: "deal_amount" | "receipt";
  basisDate: string;
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
  relatedType: "daily_report" | "message" | "";
  relatedId: string;
  readAt: string;
  createdAt: string;
  updatedAt: string;
}
