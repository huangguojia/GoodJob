import {
  acquisitionOutcomeFeedback,
  agentJobIdempotencyAliases,
  agentJobs,
  aiModelConfigs,
  caseStudies,
  commissionCalculations,
  commissionExports,
  commissionItems,
  commissionProducts,
  commissionRules,
  competitors,
  customerActivities,
  customers,
  dailyReportComments,
  dailyReports,
  dealEvents,
  deals,
  examAttempts,
  examQuestionLinks,
  examQuestions,
  exams,
  importExportJobs,
  internalMessages,
  knowledgeAssets,
  leadActivities,
  leadSourceConfigs,
  leadSourceEvents,
  leads,
  memos,
  monthlySalesRecords,
  ocrJobs,
  planTemplates,
  planTasks,
  problems,
  providerCatalog,
  providerConnections,
  providerRequestLogs,
  providerResponseCache,
  prospectCampaignEvents,
  prospectCampaigns,
  prospectCampaignVersions,
  prospectExecutionAttempts,
  prospectExecutionCheckpoints,
  prospectExecutionEvents,
  prospectExecutionKernelStates,
  prospectExecutionLeases,
  prospectExecutionPages,
  prospectExecutionThrottleBuckets,
  prospectStrategySourcePositions,
  prospectProviderRequestAccountingEvidence,
  prospectProviderRequestAttemptBindings,
  prospectProviderRequestDispatches,
  prospectProviderRequestEvents,
  prospectProviderRequestLedgers,
  prospectSourceRawBatches,
  prospectSourceRawHits,
  prospectSourceRawRecords,
  organizations,
  organizationAcceptedIdentifiers,
  organizationIdentityClaims,
  organizationIdentityConflicts,
  organizationIdentityConflictReviews,
  organizationIdentityEvents,
  organizationIdentityResolutions,
  organizationAliasFacts,
  organizationCanonicalMappings,
  organizationRelationFacts,
  organizationSourceBindings,
  companyVerificationSnapshots,
  prospectContactChannels,
  prospectContactVerificationSnapshots,
  prospectContactabilityDecisions,
  prospectContacts,
  prospectCoverageEvents,
  prospectEvidence,
  prospectIcpAssessmentSnapshots,
  prospectIcpPolicySnapshots,
  prospectSuppressionEvents,
  prospectTouchpoints,
  procurementSignals,
  dealRecommendations,
  customerIntelligenceSuggestions,
  tenantProspects,
  prospectRunEvents,
  prospectRunQueueChildBindings,
  prospectRunQueueParentBindings,
  prospectRunShards,
  prospectSearchRuns,
  prospectSchedules,
  prospectStrategies,
  prospectStrategyEvents,
  prospectStrategySuggestions,
  marketTradeObservations,
  marketOpportunityBatches,
  marketOpportunitySnapshots,
  marketOpportunityCalculationEvents,
  reminders,
  salesRecordAudits,
  todos,
  tradeDocuments,
  users,
  wecomMessages,
  websiteOpportunities,
  whatsappBindings,
  whatsappMessages
} from "./data.js";
import type {
  ResolveOrganizationStrongIdentityPersistedInput,
  ResolveOrganizationStrongIdentityResult
} from "./organization-strong-identity.js";
import type {
  ReviewOrganizationIdentityConflictInput,
  ReviewOrganizationIdentityConflictResult
} from "./organization-identity-conflict-review.js";
import type {
  RecordOrganizationAliasInput,
  RecordOrganizationAliasResult,
  RecordOrganizationRelationInput,
  RecordOrganizationRelationResult
} from "./organization-relations.js";
import type {
  RecordProspectCoveragePersistedInput,
  RecordProspectCoverageResult,
  SetTenantProspectDispositionPersistedInput,
  SetTenantProspectDispositionResult
} from "./prospect-coverage-memory.js";
import {
  convertProspectToCustomer
} from "./prospect-customer-conversion.js";
import type {
  ConvertProspectToCustomerPersistedInput,
  ConvertProspectToCustomerResult
} from "./prospect-customer-conversion.js";
import {
  convertProspectToLead
} from "./prospect-lead-conversion.js";
import type {
  ConvertProspectToLeadPersistedInput,
  ConvertProspectToLeadResult
} from "./prospect-lead-conversion.js";
import {
  applyProspectQualificationCommand
} from "./prospect-qualification.js";
import {
  ensureProspectVerificationReport
} from "./prospect-verification.js";
import type {
  ProspectQualificationCommand,
  ProspectQualificationCommandResult
} from "./prospect-qualification.js";
import type { AcquisitionOutcomeFeedback, AgentJob, AgentJobIdempotencyAlias, AiModelConfig, CaseStudy, CommissionCalculation, CommissionExport, CommissionItem, CommissionProduct, CommissionRule, Competitor, Customer, CustomerAcquisitionSourceEvent, CustomerActivity, CustomerIntelligenceSuggestion, CustomerOwnershipEvent, CustomerOwnershipMutationInput, CustomerOwnershipMutationResult, DailyReport, DailyReportComment, Deal, DealEvent, DealRecommendation, Exam, ExamAttempt, ExamQuestion, ExamQuestionLink, ImportExportJob, InternalMessage, KnowledgeAsset, Lead, LeadActivity, LeadSourceConfig, LeadSourceEvent, MarketOpportunityBatch, MarketOpportunityCalculationEvent, MarketOpportunitySnapshot, MarketTradeObservation, Memo, MonthlySalesRecord, OcrJob, Organization, OrganizationAcceptedIdentifier, OrganizationAliasFact, OrganizationCanonicalMapping, OrganizationIdentityClaim, OrganizationIdentityConflict, OrganizationIdentityConflictReview, OrganizationIdentityEvent, OrganizationIdentityResolution, OrganizationRelationFact, OrganizationSourceBinding, PlanTask, PlanTemplate, ProblemItem, ProcurementSignal, ProspectCampaign, ProspectCampaignEvent, ProspectCampaignVersion, ProspectCandidateProcessingState, ProspectCoverageEvent, ProspectExecutionAttempt, ProspectExecutionCheckpoint, ProspectExecutionEvent, ProspectExecutionKernelState, ProspectExecutionLease, ProspectExecutionPage, ProspectExecutionThrottleBucket, ProspectProviderRequestAccountingEvidence, ProspectProviderRequestAttemptBinding, ProspectProviderRequestDispatch, ProspectProviderRequestEvent, ProspectProviderRequestLedger, ProspectRunEvent, ProspectRunQueueChildBinding, ProspectRunQueueParentBinding, ProspectRunShard, ProspectSchedule, ProspectSearchRun, ProspectSourceRawBatch, ProspectSourceRawHit, ProspectSourceRawRecord, ProspectStrategy, ProspectStrategyEvent, ProspectStrategySourcePosition, ProspectStrategySuggestion, ProspectTouchpoint, ProviderCatalogItem, ProviderConnection, ProviderRequestLog, ProviderResponseCache, Reminder, SalesRecordAudit, TenantProspect, Todo, TradeDocument, User, WecomMessage, WebsiteOpportunity, WhatsAppMessage, WhatsAppBinding } from "./types.js";
import { mutateCustomerOwnershipMemory } from "./customer-public-pool.js";
import type {
  CompanyVerificationSnapshot,
  ProspectContact,
  ProspectContactChannel,
  ProspectContactVerificationSnapshot,
  ProspectContactabilityDecision,
  ProspectEvidence,
  ProspectIcpAssessmentSnapshot,
  ProspectIcpPolicySnapshot,
  ProspectSuppressionEvent
} from "./types.js";

export interface PersistedStoreMutation<T> {
  value: T;
  rollback(): void;
}

export interface CrmStore {
  mode: "memory" | "mysql";
  users: User[];
  dailyReports: DailyReport[];
  dailyReportComments: DailyReportComment[];
  internalMessages: InternalMessage[];
  customers: Customer[];
  customerOwnershipEvents: CustomerOwnershipEvent[];
  customerActivities: CustomerActivity[];
  customerAcquisitionSourceEvents: CustomerAcquisitionSourceEvent[];
  customerIntelligenceSuggestions: CustomerIntelligenceSuggestion[];
  leads: Lead[];
  leadActivities: LeadActivity[];
  leadSourceEvents: LeadSourceEvent[];
  todos: Todo[];
  deals: Deal[];
  dealEvents: DealEvent[];
  reminders: Reminder[];
  knowledgeAssets: KnowledgeAsset[];
  exams: Exam[];
  examQuestions: ExamQuestion[];
  examQuestionLinks: ExamQuestionLink[];
  examAttempts: ExamAttempt[];
  importExportJobs: ImportExportJob[];
  tradeDocuments: TradeDocument[];
  wecomMessages: WecomMessage[];
  ocrJobs: OcrJob[];
  websiteOpportunities: WebsiteOpportunity[];
  aiModelConfigs: AiModelConfig[];
  providerCatalog: ProviderCatalogItem[];
  providerConnections: ProviderConnection[];
  providerRequestLogs: ProviderRequestLog[];
  providerResponseCache: ProviderResponseCache[];
  marketTradeObservations: MarketTradeObservation[];
  marketOpportunityBatches: MarketOpportunityBatch[];
  marketOpportunitySnapshots: MarketOpportunitySnapshot[];
  marketOpportunityCalculationEvents: MarketOpportunityCalculationEvent[];
  agentJobs: AgentJob[];
  agentJobIdempotencyAliases: AgentJobIdempotencyAlias[];
  prospectCampaigns: ProspectCampaign[];
  prospectCampaignVersions: ProspectCampaignVersion[];
  prospectCampaignEvents: ProspectCampaignEvent[];
  prospectStrategies: ProspectStrategy[];
  prospectStrategyEvents: ProspectStrategyEvent[];
  prospectSchedules: ProspectSchedule[];
  prospectSearchRuns: ProspectSearchRun[];
  prospectRunShards: ProspectRunShard[];
  prospectRunEvents: ProspectRunEvent[];
  prospectRunQueueParentBindings: ProspectRunQueueParentBinding[];
  prospectRunQueueChildBindings: ProspectRunQueueChildBinding[];
  prospectExecutionKernelStates: ProspectExecutionKernelState[];
  prospectExecutionCheckpoints: ProspectExecutionCheckpoint[];
  prospectStrategySourcePositions: ProspectStrategySourcePosition[];
  prospectExecutionLeases: ProspectExecutionLease[];
  prospectExecutionAttempts: ProspectExecutionAttempt[];
  prospectProviderRequestLedgers: ProspectProviderRequestLedger[];
  prospectProviderRequestDispatches: ProspectProviderRequestDispatch[];
  prospectProviderRequestEvents: ProspectProviderRequestEvent[];
  prospectProviderRequestAttemptBindings: ProspectProviderRequestAttemptBinding[];
  prospectProviderRequestAccountingEvidence: ProspectProviderRequestAccountingEvidence[];
  prospectSourceRawBatches: ProspectSourceRawBatch[];
  prospectSourceRawRecords: ProspectSourceRawRecord[];
  prospectSourceRawHits: ProspectSourceRawHit[];
  prospectCandidateProcessingStates?: ProspectCandidateProcessingState[];
  organizations: Organization[];
  organizationIdentityClaims: OrganizationIdentityClaim[];
  organizationAcceptedIdentifiers: OrganizationAcceptedIdentifier[];
  organizationIdentityResolutions: OrganizationIdentityResolution[];
  organizationSourceBindings: OrganizationSourceBinding[];
  organizationIdentityConflicts: OrganizationIdentityConflict[];
  organizationIdentityConflictReviews: OrganizationIdentityConflictReview[];
  organizationCanonicalMappings: OrganizationCanonicalMapping[];
  organizationAliasFacts: OrganizationAliasFact[];
  organizationRelationFacts: OrganizationRelationFact[];
  organizationIdentityEvents: OrganizationIdentityEvent[];
  tenantProspects: TenantProspect[];
  prospectCoverageEvents: ProspectCoverageEvent[];
  prospectEvidence: ProspectEvidence[];
  companyVerificationSnapshots: CompanyVerificationSnapshot[];
  prospectIcpPolicySnapshots: ProspectIcpPolicySnapshot[];
  prospectIcpAssessmentSnapshots: ProspectIcpAssessmentSnapshot[];
  prospectContacts: ProspectContact[];
  prospectContactChannels: ProspectContactChannel[];
  prospectContactVerificationSnapshots:
    ProspectContactVerificationSnapshot[];
  prospectSuppressionEvents: ProspectSuppressionEvent[];
  prospectContactabilityDecisions: ProspectContactabilityDecision[];
  prospectTouchpoints: ProspectTouchpoint[];
  procurementSignals: ProcurementSignal[];
  dealRecommendations: DealRecommendation[];
  acquisitionOutcomeFeedback: AcquisitionOutcomeFeedback[];
  prospectStrategySuggestions: ProspectStrategySuggestion[];
  prospectExecutionPages: ProspectExecutionPage[];
  prospectExecutionEvents: ProspectExecutionEvent[];
  prospectExecutionThrottleBuckets: ProspectExecutionThrottleBucket[];
  leadSourceConfigs: LeadSourceConfig[];
  planTasks: PlanTask[];
  planTemplates: PlanTemplate[];
  problems: ProblemItem[];
  memos: Memo[];
  competitors: Competitor[];
  caseStudies: CaseStudy[];
  whatsappMessages: WhatsAppMessage[];
  whatsappBindings: WhatsAppBinding[];
  commissionProducts: CommissionProduct[];
  commissionRules: CommissionRule[];
  monthlySalesRecords: MonthlySalesRecord[];
  salesRecordAudits: SalesRecordAudit[];
  commissionCalculations: CommissionCalculation[];
  commissionItems: CommissionItem[];
  commissionExports: CommissionExport[];
  persist(): Promise<void>;
  persistMutation?<T>(
    mutation: () => PersistedStoreMutation<T>
  ): Promise<T>;
  persistProspectExecutionMutation?<T>(
    mutation: () => PersistedStoreMutation<T>
  ): Promise<T>;
  persistProspectCandidateMutation?<T>(
    mutation: () => PersistedStoreMutation<T>
  ): Promise<T>;
  persistProspectCandidates?(candidateIds: string[]): Promise<void>;
  mutateCustomerOwnership?(
    input: CustomerOwnershipMutationInput
  ): Promise<CustomerOwnershipMutationResult>;
  reloadProspectCandidates?(): Promise<void>;
  reloadProspectRuns?(): Promise<void>;
  resolveOrganizationStrongIdentity?(
    input: ResolveOrganizationStrongIdentityPersistedInput
  ): Promise<ResolveOrganizationStrongIdentityResult>;
  reloadOrganizationIdentityTeam?(teamId: string): Promise<void>;
  reviewOrganizationIdentityConflict?(
    input: ReviewOrganizationIdentityConflictInput
  ): Promise<ReviewOrganizationIdentityConflictResult>;
  reloadOrganizationIdentityConflictReviewTeam?(teamId: string): Promise<void>;
  recordOrganizationAlias?(
    input: RecordOrganizationAliasInput
  ): Promise<RecordOrganizationAliasResult>;
  recordOrganizationRelation?(
    input: RecordOrganizationRelationInput
  ): Promise<RecordOrganizationRelationResult>;
  reloadOrganizationRelationsTeam?(teamId: string): Promise<void>;
  recordProspectCoverage?(
    input: RecordProspectCoveragePersistedInput
  ): Promise<RecordProspectCoverageResult>;
  setTenantProspectDisposition?(
    input: SetTenantProspectDispositionPersistedInput
  ): Promise<SetTenantProspectDispositionResult>;
  convertProspectToLead?(
    input: ConvertProspectToLeadPersistedInput
  ): Promise<ConvertProspectToLeadResult>;
  convertProspectToCustomer?(
    input: ConvertProspectToCustomerPersistedInput
  ): Promise<ConvertProspectToCustomerResult>;
  reloadProspectCoverageTeam?(teamId: string): Promise<void>;
  applyProspectQualification?(
    input: ProspectQualificationCommand
  ): Promise<ProspectQualificationCommandResult>;
  reloadProspectQualificationTeam?(teamId: string): Promise<void>;
  readBarrier(): Promise<void>;
  close?(): Promise<void>;
}

export const memoryStore: CrmStore = {
  mode: "memory",
  users,
  dailyReports,
  dailyReportComments,
  internalMessages,
  customers,
  customerOwnershipEvents: [],
  customerActivities,
  customerAcquisitionSourceEvents: [],
  customerIntelligenceSuggestions,
  leads,
  leadActivities,
  leadSourceEvents,
  todos,
  deals,
  dealEvents,
  reminders,
  knowledgeAssets,
  exams,
  examQuestions,
  examQuestionLinks,
  examAttempts,
  importExportJobs,
  tradeDocuments,
  wecomMessages,
  ocrJobs,
  websiteOpportunities: websiteOpportunities.map((item) =>
    ensureProspectVerificationReport(item)
  ),
  aiModelConfigs,
  providerCatalog,
  providerConnections,
  providerRequestLogs,
  providerResponseCache,
  marketTradeObservations,
  marketOpportunityBatches,
  marketOpportunitySnapshots,
  marketOpportunityCalculationEvents,
  agentJobs,
  agentJobIdempotencyAliases,
    prospectCampaigns,
    prospectCampaignVersions,
    prospectCampaignEvents,
    prospectStrategies,
    prospectStrategyEvents,
    prospectSchedules,
    prospectSearchRuns,
    prospectRunShards,
    prospectRunEvents,
    prospectRunQueueParentBindings,
    prospectRunQueueChildBindings,
    prospectExecutionKernelStates,
    prospectExecutionCheckpoints,
    prospectStrategySourcePositions,
    prospectExecutionLeases,
    prospectExecutionAttempts,
    prospectProviderRequestLedgers,
    prospectProviderRequestDispatches,
    prospectProviderRequestEvents,
    prospectProviderRequestAttemptBindings,
    prospectProviderRequestAccountingEvidence,
    prospectSourceRawBatches,
    prospectSourceRawRecords,
    prospectSourceRawHits,
    prospectCandidateProcessingStates: [],
    organizations,
    organizationIdentityClaims,
    organizationAcceptedIdentifiers,
    organizationIdentityResolutions,
    organizationSourceBindings,
    organizationIdentityConflicts,
    organizationIdentityConflictReviews,
    organizationCanonicalMappings,
    organizationAliasFacts,
    organizationRelationFacts,
    organizationIdentityEvents,
    tenantProspects,
    prospectCoverageEvents,
    prospectEvidence,
    companyVerificationSnapshots,
    prospectIcpPolicySnapshots,
    prospectIcpAssessmentSnapshots,
    prospectContacts,
    prospectContactChannels,
    prospectContactVerificationSnapshots,
    prospectSuppressionEvents,
    prospectContactabilityDecisions,
    prospectTouchpoints,
    procurementSignals,
    dealRecommendations,
    acquisitionOutcomeFeedback,
    prospectStrategySuggestions,
    prospectExecutionPages,
    prospectExecutionEvents,
    prospectExecutionThrottleBuckets,
  leadSourceConfigs,
  planTasks,
  planTemplates,
  problems,
  memos,
  competitors,
  caseStudies,
  whatsappMessages,
  whatsappBindings,
  commissionProducts,
  commissionRules,
  monthlySalesRecords,
  salesRecordAudits,
  commissionCalculations,
  commissionItems,
  commissionExports,
  async persist() {
    // Memory mode intentionally keeps current in-process state only.
  },
  async mutateCustomerOwnership(input) {
    return mutateCustomerOwnershipMemory(memoryStore, input);
  },
  async reloadOrganizationIdentityTeam() {
    // Memory mode already reads the current in-process identity state.
  },
  async reloadOrganizationIdentityConflictReviewTeam() {
    // Memory mode already reads the current in-process review state.
  },
  async reloadOrganizationRelationsTeam() {
    // Memory mode already reads the current in-process organization facts.
  },
  async reloadProspectCoverageTeam() {
    // Memory mode already reads the current in-process coverage state.
  },
  async convertProspectToLead(input) {
    const coverageSecret =
      process.env.PROSPECT_COVERAGE_MASTER_SECRET
      || process.env.ORGANIZATION_IDENTITY_MASTER_SECRET
      || "";
    return convertProspectToLead(memoryStore, {
      ...input,
      coverageSecret
    });
  },
  async convertProspectToCustomer(input) {
    const coverageSecret =
      process.env.PROSPECT_COVERAGE_MASTER_SECRET
      || process.env.ORGANIZATION_IDENTITY_MASTER_SECRET
      || "";
    return convertProspectToCustomer(memoryStore, {
      ...input,
      coverageSecret
    });
  },
  async applyProspectQualification(input) {
    return applyProspectQualificationCommand(memoryStore, input);
  },
  async reloadProspectQualificationTeam() {
    // Memory mode already reads the current in-process qualification state.
  },
  async readBarrier() {
    // Memory mode has no asynchronous persistence queue.
  },
  async close() {
    // Memory mode has no external resources.
  }
};

let activeStore: CrmStore = memoryStore;

export function getStore() {
  return activeStore;
}

export function setStore(store: CrmStore) {
  activeStore = store;
}
