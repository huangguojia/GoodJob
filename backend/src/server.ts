import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { createHash, randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import QRCode from "qrcode";
import { z } from "zod";
import { once } from "node:events";
import { AUTH_COOKIE_NAME, CSRF_COOKIE_NAME, canManageAccount, canManageAccounts, canManageRole, canSeeOwner, canSeePersonalData, canSeeTeam, createCsrfToken, csrfCookieOptions, hashPassword, publicUser, requireAuth, sessionCookieOptions, signToken, validateAuthSecurity, verifyPassword } from "./auth.js";
import { assertAiBaseUrlAllowed } from "./ai-http-security.js";
import {
  callAiModel,
  extractJsonObject
} from "./ai-model-runtime.js";
import { createAiSearchProvider } from "./ai-search-provider.js";
import { compileAgentGoalSpec } from "./agent-goal.js";
import { resolveAgentMissionRoute } from "./agent-turn-decision.js";
import { validateAgentJobSecurity } from "./agent-job-security.js";
import {
  cancelAgentJob,
  isProspectRunBridgeJob,
  publicAgentJob,
  retryAgentJob
} from "./agent-jobs.js";
import {
  AgentBackgroundRunner,
  cancelAgentMission,
  agentCatalog,
  agentMissionContextSnapshots,
  createAgentPlan,
  executeAgentStep,
  getAgentRun,
  listAgentConversations,
  listAgentMissionCheckpoints,
  listAgentRuns,
  pauseAgentMission,
  resumeAgentMission,
  restoreAgentMissionCheckpoint,
  resolveAgentTurnDecision,
  steerAgentMission,
  type AgentExecutionRuntime,
  type AgentPlanningProgressHandler
} from "./ai-agent.js";
import {
  deleteAgentMemory,
  listAgentMemories,
  proposeAgentMemory,
  setAgentMemoryStatus,
  updateAgentMemory
} from "./agent-memory.js";
import {
  agentKnowledgeOverview,
  createAgentKnowledgeDraft,
  listAgentKnowledgeDocuments,
  retrieveAgentKnowledge,
  setAgentKnowledgeStatus,
  updateAgentKnowledgeDraft
} from "./agent-knowledge.js";
import {
  AgentTriggerRunner,
  createAgentTriggerRule,
  deleteAgentTriggerRule,
  listAgentTriggerEvents,
  listAgentTriggerRules,
  runAgentTriggerRule,
  setAgentTriggerRuleStatus,
  updateAgentTriggerRule
} from "./agent-triggers.js";
import { agentModelMetrics, runAgentEvaluationSuite } from "./agent-model-governance.js";
import {
  getAgentSkill,
  listAgentSkills,
  publicAgentSkill,
  rankAgentSkills,
  selectAgentSkills
} from "./agent-skills.js";
import {
  agentApiOperationContract,
  assertAgentCompletionEvidence,
  assertAgentOperationInput,
  type AgentOperationContract
} from "./agent-api-contracts.js";
import {
  activateSalesPlaybook,
  createSalesDistillation,
  listDistillationSources,
  listSalesDistillations,
  listSalesPlaybookActivations,
  pauseSalesPlaybook,
  publishSalesDistillation
} from "./sales-distillation.js";
import {
  SalesTrainingRunner,
  controlSalesTrainingRun,
  createSalesTrainingRun,
  getSalesTrainingRun,
  listSalesTrainingRuns,
  publishSalesTrainingRun,
  retrainSalesTrainingRun,
  updateSalesTrainingSample
} from "./sales-training.js";
import {
  OutreachSequenceRunner,
  controlOutreachSequence,
  createOutreachSequence,
  listOutreachSequences
} from "./outreach-sequences.js";
import type { OutreachSequence, OutreachSequenceStepSnapshot } from "./types.js";
import {
  CustomerMaintenanceRunner,
  controlCustomerMaintenanceWatch,
  createCustomerMaintenanceWatch,
  listCustomerMaintenanceWatches,
  previewCustomerMaintenance
} from "./customer-maintenance.js";
import { createCredentialRef, decryptProviderConfiguration, encryptProviderConfiguration, validateProviderCredentialSecurity } from "./credential-security.js";
import {
  createMarketAnalysisRun,
  MARKET_ANALYSIS_JOB_TYPE,
  marketAnalysisRunMetadata,
  MarketAnalysisRunProviderError,
  MarketAnalysisRunRequestError,
  retryMarketAnalysisJob
} from "./market-analysis-runs.js";
import { createMysqlStore } from "./mysql-store.js";
import {
  assertMysqlDataImportToken,
  beginMysqlDataImport,
  cancelMysqlDataImport,
  completeMysqlDataImport,
  failMysqlDataImport,
  getMysqlDataImport,
  importMysqlDataBatch,
  listMysqlDataImports,
  mysqlDataImportEnabled,
  mysqlImportableSchema,
  MysqlDataImportError
} from "./mysql-data-import.js";
import {
  beginDatabaseBackup,
  cancelDatabaseBackup,
  databaseBackupDownload,
  deleteDatabaseBackup,
  getDatabaseBackupJob,
  listDatabaseBackupJobs,
  mysqlLocalBackupConfig
} from "./database-backup.js";
import { getStore, setStore, type CrmStore } from "./store.js";
import {
  DEFAULT_LEAD_SEARCH_PROVIDER_IDS,
  LEAD_PROVIDERS,
  getProvider,
  providerMeta,
  type LeadProvider,
  type LeadQuery,
  type RawLead
} from "./lead-providers.js";
import { getTradeProvider } from "./trade-providers.js";
import { ProviderContractError, providerErrorFromUnknown, type ProviderErrorCode, type ProviderRecord } from "./provider-contract.js";
import { assertProviderBaseUrlAllowed } from "./provider-http-client.js";
import { providerRequestFingerprint } from "./provider-request-logging.js";
import {
  createProviderExecutionContext,
  executeProviderEnrich,
  executeProviderHealth,
  executeProviderPreflight,
  executeProviderSearch,
  providerRequiresKey
} from "./provider-runtime.js";
import { ProspectScheduler } from "./prospect-scheduler.js";
import {
  createProspectSuperSearch,
  createProspectSuperSearchSchema,
  listProspectSuperSearches,
  prospectSuperSearchActionSchema,
  prospectSuperSearchEtag,
  prospectSuperSearchPreview,
  prospectSuperSearchPreviewSchema,
  ProspectSuperSearchError,
  ProspectSuperSearchRunner,
  refreshProspectSuperSearchMissionResults,
  superSearchDetail,
  transitionProspectSuperSearch
} from "./prospect-super-search.js";
import { ProspectWorkerService } from "./prospect-worker-service.js";
import { loadLocalEnv } from "./runtime-env.js";
import { createOpenApiDocument, registerSwagger } from "./swagger.js";
import { agentApiRequestSchema, assertAgentApiToolRisk, classifyAgentApiRequest, deniedAgentApiReason, normalizeAgentApiPath, redactAgentApiData, routeTemplateMatches } from "./agent-api-policy.js";
import { requestAgentInternalApi } from "./agent-internal-http.js";
import { resolveBackendHost } from "./server-network.js";
import {
  listTradeObservations,
  parseTradeObservationListQuery,
  TradeObservationListRequestError,
  validateTradeObservationCursorSecurity
} from "./trade-observation-list.js";
import {
  listMarketOpportunities,
  MarketOpportunityListRequestError,
  parseMarketOpportunityListQuery,
  validateMarketOpportunityCursorSecurity
} from "./market-opportunity-list.js";
import {
  activateProspectCampaign,
  createProspectCampaign,
  createProspectCampaignSchema,
  createProspectCampaignVersion,
  createProspectCampaignVersionSchema,
  getProspectCampaign,
  listProspectCampaigns,
  prospectCampaignActionSchema,
  prospectCampaignEtag,
  prospectCampaignIdSchema,
  ProspectCampaignRequestError,
  resolveMarketCampaignReference,
  transitionProspectCampaign,
  updateProspectCampaign,
  updateProspectCampaignSchema
} from "./prospect-campaigns.js";
import {
  convertProspectToLeadBodySchema,
  PROSPECT_LEAD_SOURCE_CHANNEL,
  ProspectLeadConversionError
} from "./prospect-lead-conversion.js";
import {
  convertProspectToCustomerBodySchema,
  ProspectCustomerConversionError
} from "./prospect-customer-conversion.js";
import {
  acceptCustomerIntelligence,
  generateCustomerIntelligenceSuggestion,
  rejectCustomerIntelligence
} from "./customer-intelligence.js";
import {
  CustomerOwnershipError,
  isPublicCustomer
} from "./customer-public-pool.js";
import {
  ProspectCoverageMemoryError
} from "./prospect-coverage-memory.js";
import {
  syncProspectCandidateCoverage
} from "./prospect-candidate-actions.js";
import {
  approveProspectContactability,
  approveProspectIcpQualification,
  currentApprovedProspectDecision,
  evaluateProspectContactability,
  prospectChannelQualificationSchema,
  prospectCompanyQualificationSchema,
  prospectContactabilityEvaluationSchema,
  prospectIcpQualificationSchema,
  prospectQualificationApprovalSchema,
  prospectQualificationView,
  prospectSuppressionSchema,
  ProspectQualificationWorkflowError,
  recordProspectChannelQualification,
  recordProspectCompanyQualification,
  recordProspectIcpQualification,
  setProspectSuppression
} from "./prospect-qualification-workflow.js";
import {
  applyProspectQualificationCommand,
  prospectCandidateQualificationBasisHash,
  prospectCandidateQualificationChangedFields,
  ProspectQualificationError
} from "./prospect-qualification.js";
import {
  assertCrmOutreachEligible,
  assertProspectEmailOutreachEligible,
  ProspectOutreachEligibilityError
} from "./prospect-outreach-eligibility.js";
import {
  ensureProspectFollowUpTodo,
  migrateProspectFollowUpTodos,
  recordProspectTouchpoint
} from "./prospect-outreach.js";
import {
  queueWebsiteProbe,
  websiteProbeCapability,
  websiteProbeDetail,
  WebsiteProbeError
} from "./website-probe.js";
import {
  attachProspectIdentityBootstrapRun,
  beginProspectIdentityBootstrap,
  failProspectIdentityBootstrap,
  normalizeProspectIdentityRegistration,
  prospectIdentityBootstrapView,
  reconcileProspectIdentityBootstrap,
  ProspectIdentityBootstrapError
} from "./prospect-identity-bootstrap.js";
import {
  customsDocumentExportIssues,
  generateCustomsDocumentFromDeal,
  exportCustomsDocumentToExcel
} from "./customs-export.js";
import {
  dismissDealRecommendation,
  linkProcurementContextToCustomer,
  linkProcurementContextToLead,
  linkRecommendationToDeal,
  proposeDealRecommendation,
  recommendationReasonText,
  recordProcurementSignal,
  resolveRecommendationCustomerId
} from "./procurement-signals.js";
import {
  generateProspectStrategySuggestions,
  prospectPerformance,
  recordAcquisitionOutcomeFeedback,
  reviewProspectStrategySuggestion
} from "./prospect-outcome-feedback.js";
import {
  approveProspectStrategy,
  createProspectStrategy,
  createProspectStrategySchema,
  disableProspectStrategy,
  getProspectStrategy,
  listProspectStrategies,
  previewProspectStrategy,
  previewProspectStrategySchema,
  prospectStrategyActionSchema,
  prospectStrategyEtag,
  prospectStrategyIdSchema,
  ProspectStrategyRequestError,
  updateProspectStrategy,
  updateProspectStrategySchema
} from "./prospect-strategies.js";
import {
  createProspectRun,
  createProspectRunSchema,
  getProspectRun,
  listProspectRuns,
  parseProspectRunListQuery,
  prospectRunActionSchema,
  prospectRunEtag,
  prospectRunIdempotencyKeySchema,
  prospectRunIdSchema,
  ProspectRunRequestError,
  transitionProspectRun,
  validateProspectRunSecurity
} from "./prospect-runs.js";
import {
  type ProspectLiveEvent
} from "./prospect-live-events.js";
import {
  createProspectSchedule,
  createProspectScheduleSchema,
  deleteProspectSchedule,
  listProspectSchedules,
  prospectScheduleActionSchema,
  prospectScheduleEtag,
  prospectScheduleIdSchema,
  ProspectScheduleRequestError,
  transitionProspectSchedule
} from "./prospect-schedules.js";
import {
  canonicalOrganizationId,
  listOrganizationIdentityConflicts,
  organizationIdentityConflictListQuerySchema,
  organizationIdentityConflictReviewBodySchema,
  OrganizationIdentityConflictReviewError,
  reviewOrganizationIdentityConflict
} from "./organization-identity-conflict-review.js";
import {
  organizationAliasBodySchema,
  organizationIdentityProfile,
  OrganizationRelationError,
  organizationRelationBodySchema,
  recordOrganizationAlias,
  recordOrganizationRelation
} from "./organization-relations.js";
import { activeProspectRunsForOwner } from "./prospect-run-guards.js";
import {
  companyNameFromWebsiteReference,
  ensureProspectVerificationReport,
  normalizeWebsiteReference,
  withProspectVerificationReport
} from "./prospect-verification.js";
import { refreshProspectScorecard } from "./prospect-scorecard.js";
import type { AiModelConfig, CommissionCalculation, CommissionItem, CommissionProduct, CommissionRule, Customer, CustomerIntelligenceFieldKey, Deal, DealEvent, Exam, ExamAttempt, ExamQuestion, Lead, LeadSourceEvent, LeadSourceType, MonthlySalesRecord, OcrJob, PlanTask, PlanTemplate, ProspectIdentityBootstrapAttempt, ProspectOutreachChannel, ProviderCatalogItem, ProviderConnection, ProviderEvidenceSnapshot, SalesRecordAudit, SessionUser, Todo, TradeDocument, TradeDocumentAudit, TradeDocumentSendRecord, WebsiteOpportunity } from "./types.js";
import type { CompanyProfile } from "./types.js";

loadLocalEnv();

export const app = express();
let activeProspectWorkerService: ProspectWorkerService | null = null;

async function synchronizeProspectQueue() {
  try {
    await activeProspectWorkerService?.synchronize();
  } catch (error) {
    console.error("[prospect-queue]", {
      event: "coordination_sync_failed",
      code: typeof error === "object"
        && error !== null
        && "code" in error
        ? String(error.code || "UNCLASSIFIED")
        : "UNCLASSIFIED"
    });
  }
}

app.disable("x-powered-by");
app.set("trust proxy", "loopback");
const allowedOrigins = new Set((process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean));
function originAllowed(origin?: string) {
  return !origin || allowedOrigins.has(origin)
    || (process.env.NODE_ENV !== "production" && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin));
}
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use((req, res, next) => {
  if (!originAllowed(req.headers.origin)) {
    res.status(403).json({ message: "不允许的请求来源" });
    return;
  }
  next();
});
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    callback(null, originAllowed(origin));
  }
}));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: ["test", "e2e"].includes(process.env.NODE_ENV || "") ? 10_000 : 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "登录尝试过于频繁，请稍后再试" }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: ["test", "e2e"].includes(process.env.NODE_ENV || "") ? 100_000 : 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "请求过于频繁，请稍后再试" }
});
app.use("/api", apiLimiter);

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

async function persistCandidateChanges(
  store: CrmStore,
  candidates: WebsiteOpportunity[],
  persistOtherState = true
) {
  const scoredAt = new Date().toISOString();
  candidates.forEach((candidate) =>
    refreshProspectScorecard(store, candidate, scoredAt)
  );
  const candidateIds = [...new Set(candidates.map((item) => item.id))];
  if (store.persistProspectCandidates) {
    if (candidateIds.length) {
      await store.persistProspectCandidates(candidateIds);
    }
    if (persistOtherState) await store.persist();
    return;
  }
  await store.persist();
}

app.use(
  "/api/prospect-list",
  requireAuth,
  asyncRoute(async (_req, _res, next) => {
    await getStore().reloadProspectCandidates?.();
    next();
  })
);

function requestCorrelationId(req: Request) {
  const provided = String(req.header("X-Request-Id") || "").trim();
  return provided ? provided.slice(0, 100) : randomUUID();
}

function sendProspectCampaignError(
  res: Response,
  error: unknown
) {
  if (!(error instanceof ProspectCampaignRequestError)
    && !(error instanceof ProspectStrategyRequestError)
    && !(error instanceof ProspectRunRequestError)
    && !(error instanceof ProspectScheduleRequestError)
    && !(error instanceof ProspectSuperSearchError)) return false;
  res.status(error.status).json({
    message: error.message,
    errorCode: error.code,
    ...error.details
  });
  return true;
}

function sendProspectLeadConversionError(
  res: Response,
  error: unknown
) {
  if (error instanceof ProspectLeadConversionError) {
    res.status(error.status).json({
      message: error.message,
      errorCode: error.code
    });
    return true;
  }
  if (!(error instanceof ProspectCoverageMemoryError)) return false;
  const status = error.code === "PROSPECT_COVERAGE_INVALID"
    ? 400
    : [
        "PROSPECT_COVERAGE_CONCURRENCY_RETRY_EXHAUSTED",
        "PROSPECT_COVERAGE_CACHE_UNAVAILABLE",
        "PROSPECT_COVERAGE_COMMIT_OUTCOME_UNKNOWN"
      ].includes(error.code)
      ? 503
      : [
          "PROSPECT_COVERAGE_NOT_ELIGIBLE",
          "PROSPECT_COVERAGE_REPLAY_CONFLICT",
          "PROSPECT_COVERAGE_TEAM_BUSY"
        ].includes(error.code)
        ? 409
        : 500;
  res.status(status).json({
    message: error.message,
    errorCode: error.code
  });
  return true;
}

function sendProspectIdentityBootstrapError(
  res: Response,
  error: unknown
) {
  if (!(error instanceof ProspectIdentityBootstrapError)) return false;
  res.status(error.status).json({
    message: error.message,
    errorCode: error.code
  });
  return true;
}

function sendProspectQualificationError(
  res: Response,
  error: unknown
) {
  if (error instanceof ProspectQualificationWorkflowError
    || error instanceof ProspectOutreachEligibilityError) {
    res.status(error.status).json({
      message: error.message,
      errorCode: error.code
    });
    return true;
  }
  if (!(error instanceof ProspectQualificationError)) return false;
  const status = error.code.endsWith("_NOT_FOUND") ? 404
    : error.code.includes("STALE")
      || error.code.includes("CONFLICT")
      || error.code.includes("TRANSITION")
      ? 409
      : 400;
  res.status(status).json({
    message: error.message,
    errorCode: error.code
  });
  return true;
}

function sendWebsiteProbeError(res: Response, error: unknown) {
  if (!(error instanceof WebsiteProbeError)) return false;
  res.status(error.status).json({
    message: error.message,
    errorCode: error.code
  });
  return true;
}

function sendProspectCustomerConversionError(
  res: Response,
  error: unknown
) {
  if (error instanceof ProspectCustomerConversionError) {
    res.status(error.status).json({
      message: error.message,
      errorCode: error.code
    });
    return true;
  }
  return sendProspectLeadConversionError(res, error);
}

function sendOrganizationIdentityConflictReviewError(
  res: Response,
  error: unknown
) {
  if (!(error instanceof OrganizationIdentityConflictReviewError)) {
    return false;
  }
  res.status(error.status).json({
    message: error.message,
    errorCode: error.code
  });
  return true;
}

function sendOrganizationRelationError(
  res: Response,
  error: unknown
) {
  if (!(error instanceof OrganizationRelationError)) return false;
  res.status(error.status).json({
    message: error.message,
    errorCode: error.code
  });
  return true;
}

function setProspectRunEtag(
  res: Response,
  payload: { run: { id: string; revision: number } }
) {
  res.setHeader("ETag", prospectRunEtag(payload.run));
  res.setHeader("Cache-Control", "no-store");
}

function setProspectScheduleEtag(
  res: Response,
  payload: { schedule: { id: string; revision: number } }
) {
  res.setHeader("ETag", prospectScheduleEtag(payload.schedule));
  res.setHeader("Cache-Control", "no-store");
}

function setProspectStrategyEtag(
  res: Response,
  payload: { strategy: { id: string; revision: number } }
) {
  res.setHeader("ETag", prospectStrategyEtag(payload.strategy));
  res.setHeader("Cache-Control", "no-store");
}

function setProspectCampaignEtag(
  res: Response,
  payload: { campaign: { id: string; revision: number } }
) {
  res.setHeader("ETag", prospectCampaignEtag(payload.campaign));
  res.setHeader("Cache-Control", "no-store");
}

function accountUser(user: ReturnType<typeof getStore>["users"][number]) {
  return { ...publicUser(user), status: user.status };
}

function collaborationUser(userId: string) {
  const user = getStore().users.find((item) => item.id === userId);
  return user ? { id: user.id, name: user.name, avatar: user.avatar, role: user.role, teamId: user.teamId } : {
    id: userId,
    name: "已停用账号",
    avatar: "--",
    role: "sales" as const,
    teamId: ""
  };
}

function canViewDailyReport(user: SessionUser, report: ReturnType<typeof getStore>["dailyReports"][number]) {
  if (user.role === "super_admin") return true;
  if (user.role === "manager" || user.role === "admin") return report.teamId === user.teamId;
  return report.ownerId === user.id;
}

function publicDailyReport(report: ReturnType<typeof getStore>["dailyReports"][number]) {
  return {
    ...report,
    owner: collaborationUser(report.ownerId),
    commentCount: getStore().dailyReportComments.filter((item) => item.reportId === report.id).length
  };
}

function publicDailyReportComment(comment: ReturnType<typeof getStore>["dailyReportComments"][number]) {
  return { ...comment, author: collaborationUser(comment.authorId) };
}

function publicInternalMessage(message: ReturnType<typeof getStore>["internalMessages"][number]) {
  return {
    ...message,
    sender: collaborationUser(message.senderId),
    recipient: collaborationUser(message.recipientId)
  };
}

function createInternalNotification(input: {
  senderId: string;
  recipientId: string;
  teamId: string;
  subject: string;
  content: string;
  relatedType?: "daily_report" | "message" | "";
  relatedId?: string;
  threadId?: string;
}) {
  if (input.senderId === input.recipientId) return null;
  const now = new Date().toISOString();
  const message = {
    id: `msg_${randomUUID()}`,
    threadId: input.threadId || `thread_${randomUUID()}`,
    senderId: input.senderId,
    recipientId: input.recipientId,
    teamId: input.teamId,
    type: "system" as const,
    subject: input.subject,
    content: input.content,
    relatedType: input.relatedType || "" as const,
    relatedId: input.relatedId || "",
    readAt: "",
    createdAt: now,
    updatedAt: now
  };
  getStore().internalMessages.unshift(message);
  return message;
}

function canManageTraining(user?: SessionUser) {
  return user?.role === "manager" || user?.role === "admin" || user?.role === "super_admin";
}

function canApproveTradeDocuments(user?: SessionUser) {
  return user?.role === "manager" || user?.role === "admin" || user?.role === "super_admin";
}

function canSeeKnowledgeAsset(user: SessionUser, asset: ReturnType<typeof getStore>["knowledgeAssets"][number]) {
  const owner = getStore().users.find((item) => item.id === asset.ownerId);
  const teamId = asset.teamId || owner?.teamId || "all";
  if (user.role === "super_admin") return true;
  if (teamId !== user.teamId) return false;
  if (asset.status === "published") return true;
  if (user.role === "admin" || user.role === "manager") return true;
  return asset.ownerId === user.id;
}

function canAccessExam(user: SessionUser, exam: Exam) {
  if (user.role === "super_admin") return true;
  if (exam.teamId && exam.teamId !== "all" && exam.teamId !== user.teamId) return false;
  if (canManageTraining(user)) return true;
  if (exam.status !== "published") return false;
  return exam.targetRole === "all" || exam.targetRole === user.role;
}

function canManageExam(user: SessionUser, exam: Exam) {
  return user.role === "super_admin" || exam.teamId === user.teamId;
}

function canUseExamQuestion(user: SessionUser, question: ExamQuestion) {
  return user.role === "super_admin" || !question.teamId || question.teamId === "all" || question.teamId === user.teamId;
}

function canManageExamQuestion(user: SessionUser, question: ExamQuestion) {
  return user.role === "super_admin" || question.teamId === user.teamId;
}

function requireTrainingManager(req: Request, res: Response) {
  if (canManageTraining(req.user)) return true;
  res.status(403).json({ message: "只有主管、管理员和超级管理员可以维护题库和考试" });
  return false;
}

function userCurrentOcrId(user: SessionUser) {
  return `ocr_${user.id}`;
}

function defaultOcrFields() {
  return {
    company: "",
    contact: "",
    title: "",
    email: "",
    whatsapp: "",
    wechat: "",
    phone: "",
    country: "",
    city: ""
  };
}

function resolveOcrJob(user: SessionUser, requestedId: string, createIfMissing = false): OcrJob | null {
  const store = getStore();
  const personalId = userCurrentOcrId(user);
  const direct = store.ocrJobs.find((job) => job.id === requestedId && canSeePersonalData(user, job.ownerId));
  if (direct) return direct;
  if (!["ocr1", "current", personalId].includes(requestedId)) return null;
  const existingPersonal = store.ocrJobs.find((job) => job.id === personalId && canSeePersonalData(user, job.ownerId));
  if (existingPersonal) return existingPersonal;
  if (!createIfMissing) return null;
  const job: OcrJob = {
    id: personalId,
    status: "recognized",
    confidence: 0,
    fields: defaultOcrFields(),
    ownerId: user.id,
    teamId: user.teamId
  };
  store.ocrJobs.unshift(job);
  return job;
}

type OutboundEmailDispatchObservation = {
  userId: string;
  to: string;
  subject: string;
};

let outboundEmailDispatchObserver:
  ((event: OutboundEmailDispatchObservation) => void) | null = null;

export function setOutboundEmailDispatchObserverForTest(
  observer: ((event: OutboundEmailDispatchObservation) => void) | null
) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("邮件派发观察器只能在测试环境使用");
  }
  outboundEmailDispatchObserver = observer;
}

async function sendOutboundEmail(user: ReturnType<typeof getStore>["users"][number], payload: { to: string; subject: string; body: string; messageId?: string }) {
  outboundEmailDispatchObserver?.({
    userId: user.id,
    to: payload.to,
    subject: payload.subject
  });
  if (!user.outboundEmail || !user.smtpHost || !user.smtpUser || !user.smtpPassword) {
    throw new Error("请先在个人信息页完整配置发件邮箱、SMTP服务器、账号和授权码");
  }
  const smtpPort = Number(user.smtpPort || 465);
  const smtpSecure = user.smtpSecure ?? true;
  if (smtpPort === 587 && smtpSecure) {
    throw new Error("SMTP配置不匹配：端口 587 通常应选择 STARTTLS/普通；如果要使用 SSL/TLS，请把端口改为 465。");
  }
  if (smtpPort === 465 && !smtpSecure) {
    throw new Error("SMTP配置不匹配：端口 465 通常应选择 SSL/TLS；如果要使用 STARTTLS/普通，请把端口改为 587。");
  }
  const transport = ["test", "e2e"].includes(process.env.NODE_ENV || "")
    ? nodemailer.createTransport({ streamTransport: true, newline: "unix", buffer: true })
    : nodemailer.createTransport({
      host: user.smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: user.smtpUser,
        pass: user.smtpPassword
      }
    });
  return transport.sendMail({
    ...(payload.messageId ? { messageId: payload.messageId } : {}),
    from: `"${user.emailSenderName || user.name}" <${user.outboundEmail}>`,
    to: payload.to,
    subject: payload.subject,
    text: payload.body
  });
}

function outboundEmailError(error: unknown, user: ReturnType<typeof getStore>["users"][number]) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.startsWith("请先") || message.startsWith("SMTP配置不匹配")) return message;
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code || "") : "";
  const response = typeof error === "object" && error && "response" in error ? String((error as { response?: unknown }).response || "") : "";
  const raw = `${message} ${response}`.trim();
  const lower = raw.toLowerCase();
  if (code === "EAUTH" || raw.includes("535") || lower.includes("invalid login") || lower.includes("authentication")) {
    return "SMTP认证失败：请确认 SMTP账号 是完整邮箱，授权码不是网页登录密码，并且邮箱后台已开启 SMTP 服务。QQ邮箱请使用“授权码/客户端专用密码”。";
  }
  if (code === "ESOCKET" || code === "ECONNECTION" || code === "ETIMEDOUT" || lower.includes("wrong version number") || lower.includes("ssl")) {
    return `SMTP连接失败：请检查服务器、端口和加密方式。当前配置为 ${user.smtpHost}:${user.smtpPort || 465}，${user.smtpSecure ?? true ? "SSL/TLS" : "STARTTLS/普通"}。`;
  }
  if (raw.includes("550") || lower.includes("sender")) {
    return "SMTP发件人被拒绝：请确认发件邮箱、SMTP账号属于同一个邮箱账号，且服务商允许该账号外发。";
  }
  return `邮件发送失败：${message || "SMTP服务未返回明确原因"}`;
}

function hasProspectContactInfo(item: WebsiteOpportunity) {
  const value = `${item.contactInfo || ""} ${item.contact || ""}`.trim();
  if (!value || /^(待维护|待补齐|未知|暂无)$/i.test(value)) return false;
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
    || /\+?\d[\d\s().-]{6,}\d/.test(value)
    || /(whatsapp|wechat|微信)/i.test(value);
}

function canManageProspectAssignments(user?: SessionUser) {
  return user?.role === "manager" || user?.role === "admin" || user?.role === "super_admin";
}

function prospectAssigneesFor(user: SessionUser) {
  return getStore().users
    .filter((item) => item.status === "active" && item.role === "sales")
    .filter((item) => user.role === "super_admin" || item.teamId === user.teamId)
    .map((item) => ({ id: item.id, name: item.name, role: item.role, teamId: item.teamId }));
}

function examQuestionsFor(examId: string, user?: SessionUser) {
  const store = getStore();
  const linkedIds = store.examQuestionLinks
    .filter((link) => link.examId === examId)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((link) => link.questionId);
  const linked = linkedIds
    .map((questionId) => store.examQuestions.find((question) => question.id === questionId))
    .filter(Boolean) as ExamQuestion[];
  const questions = linked.length ? linked : store.examQuestions.filter((question) => question.examId === examId);
  return user ? questions.filter((question) => canUseExamQuestion(user, question)) : questions;
}

function bankQuestions(user?: SessionUser) {
  const store = getStore();
  return store.examQuestions
    .filter((question) => question.examId === "bank" || !question.examId || !store.exams.some((exam) => exam.id === question.examId))
    .filter((question) => !user || canUseExamQuestion(user, question))
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

function examWithRuntimeStats(exam: Exam, user?: SessionUser) {
  const store = getStore();
  const questions = examQuestionsFor(exam.id, user);
  const attempts = store.examAttempts.filter((attempt) => {
    if (attempt.examId !== exam.id) return false;
    if (!user || user.role === "super_admin") return true;
    if (!canManageTraining(user)) return attempt.userId === user.id;
    return store.users.find((item) => item.id === attempt.userId)?.teamId === user.teamId;
  });
  const passRate = attempts.length
    ? Math.round((attempts.filter((attempt) => attempt.passed).length / attempts.length) * 100)
    : canManageTraining(user) || !user ? exam.passRate : 0;
  return {
    ...exam,
    questionCount: questions.length || exam.questionCount,
    passRate
  };
}

function examReport(user?: SessionUser) {
  const store = getStore();
  const visibleExams = user ? store.exams.filter((exam) => canAccessExam(user, exam)) : store.exams;
  const visibleExamIds = new Set(visibleExams.map((exam) => exam.id));
  const attempts = store.examAttempts.filter((attempt) => {
    if (!visibleExamIds.has(attempt.examId)) return false;
    if (!user || user.role === "super_admin") return true;
    if (!canManageTraining(user)) return attempt.userId === user.id;
    return store.users.find((item) => item.id === attempt.userId)?.teamId === user.teamId;
  });
  const totalAttempts = attempts.length;
  const passedAttempts = attempts.filter((attempt) => attempt.passed).length;
  const averageScore = totalAttempts ? Math.round(attempts.reduce((sum, attempt) => sum + attempt.score, 0) / totalAttempts) : 0;
  const retakeAttempts = attempts.filter((attempt) => !attempt.passed).length;
  const questionCount = canManageTraining(user) || !user ? bankQuestions(user).length : visibleExams.reduce((sum, exam) => sum + examQuestionsFor(exam.id, user).length, 0);
  const difficultyRows = ["easy", "medium", "hard"].map((difficulty) => {
    const questions = canManageTraining(user) || !user ? bankQuestions(user) : visibleExams.flatMap((exam) => examQuestionsFor(exam.id, user));
    const count = questions.filter((question) => question.difficulty === difficulty).length;
    return {
      difficulty,
      label: difficulty === "easy" ? "基础题" : difficulty === "hard" ? "高阶题" : "应用题",
      count,
      ratio: questionCount ? Math.round((count / questionCount) * 100) : 0
    };
  });
  const categoryRows = visibleExams.map((exam) => {
    const examAttempts = attempts.filter((attempt) => attempt.examId === exam.id);
    const participants = new Set(examAttempts.map((attempt) => attempt.userId)).size;
    const passRate = examAttempts.length ? Math.round((examAttempts.filter((attempt) => attempt.passed).length / examAttempts.length) * 100) : canManageTraining(user) || !user ? exam.passRate : 0;
    const avgScore = examAttempts.length ? Math.round(examAttempts.reduce((sum, attempt) => sum + attempt.score, 0) / examAttempts.length) : 0;
    return { examId: exam.id, title: exam.title, category: exam.category, participants, passRate, avgScore };
  });
  const latestAttempts = attempts.slice(0, 6).map((attempt) => {
    const exam = store.exams.find((item) => item.id === attempt.examId);
    const user = store.users.find((item) => item.id === attempt.userId);
    return {
      ...attempt,
      examTitle: exam?.title || "未知考试",
      category: exam?.category || "未分类",
      userName: user?.name || "未知用户"
    };
  });
  return {
    totalAttempts,
    passedAttempts,
    retakeAttempts,
    averageScore,
    questionCount,
    categoryRows,
    difficultyRows,
    latestAttempts
  };
}

function refreshExamStats(exam: Exam) {
  const store = getStore();
  const attempts = store.examAttempts.filter((attempt) => attempt.examId === exam.id);
  const questionCount = examQuestionsFor(exam.id).length;
  exam.questionCount = questionCount || exam.questionCount;
  exam.passRate = attempts.length ? Math.round((attempts.filter((attempt) => attempt.passed).length / attempts.length) * 100) : exam.passRate;
  exam.updatedAt = new Date().toISOString();
}

const examQuestionSchema = z.object({
  stem: z.string().min(1),
  category: z.string().min(1).default("产品知识"),
  options: z.array(z.string().min(1)).min(2).max(6),
  answerIndex: z.number().int().nonnegative().optional(),
  answerIndexes: z.array(z.number().int().nonnegative()).optional(),
  questionType: z.enum(["single", "multiple"]).optional(),
  tags: z.array(z.string()).optional().default([]),
  explanation: z.string().min(1).default("请在题库维护中补充解析。"),
  difficulty: z.enum(["easy", "medium", "hard"]).default("medium")
});

function uniqueSortedIndexes(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function correctIndexesFor(question: ExamQuestion) {
  return uniqueSortedIndexes(question.answerIndexes?.length ? question.answerIndexes : [question.answerIndex]);
}

function indexesEqual(left: number[], right: number[]) {
  const a = uniqueSortedIndexes(left);
  const b = uniqueSortedIndexes(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function buildExamQuestion(body: z.infer<typeof examQuestionSchema>, index = 0): ExamQuestion {
  const answerIndexes = uniqueSortedIndexes(body.answerIndexes?.length ? body.answerIndexes : [body.answerIndex ?? 0]);
  if (answerIndexes.some((answerIndex) => answerIndex >= body.options.length)) {
    throw new Error("正确答案序号超出选项数量");
  }
  return {
    id: `q_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
    examId: "bank",
    category: body.category,
    stem: body.stem,
    options: body.options,
    answerIndex: answerIndexes[0],
    answerIndexes,
    questionType: body.questionType || (answerIndexes.length > 1 ? "multiple" : "single"),
    tags: body.tags || [],
    explanation: body.explanation,
    difficulty: body.difficulty,
    updatedAt: new Date().toISOString()
  };
}

app.get("/api/health", (_req, res) => {
  const workerStatus = activeProspectWorkerService?.status();
  const queueStatus = workerStatus?.queue;
  res.json({
    ok: true,
    store: getStore().mode,
    prospectQueue: queueStatus
      ? {
          mode: queueStatus.mode,
          running: queueStatus.running,
          degraded: queueStatus.degraded
        }
      : {
          mode: "mysql_polling",
          running: false,
          degraded: false
        }
  });
});

const loginSchema = z.object({
  email: z.string().trim().email().max(180).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128)
});

app.post("/api/auth/login", loginLimiter, asyncRoute(async (req, res) => {
  const body = loginSchema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.email.toLowerCase() === body.email && item.status === "active");
  const passwordCheck = user ? await verifyPassword(user.password, body.password) : { valid: false, needsUpgrade: false };
  if (!user || !passwordCheck.valid) {
    res.status(401).json({ message: "账号或密码错误" });
    return;
  }
  if (passwordCheck.needsUpgrade) {
    user.password = await hashPassword(body.password);
    user.authVersion = user.authVersion || 1;
    await store.persist();
  }
  const sessionUser = publicUser(user);
  const token = signToken(sessionUser);
  const csrfToken = createCsrfToken();
  res.cookie(AUTH_COOKIE_NAME, token, sessionCookieOptions());
  res.cookie(CSRF_COOKIE_NAME, csrfToken, csrfCookieOptions());
  res.setHeader("Cache-Control", "no-store");
  res.json({ token, csrfToken, user: sessionUser });
}));

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, { ...sessionCookieOptions(), maxAge: undefined });
  res.clearCookie(CSRF_COOKIE_NAME, { ...csrfCookieOptions(), maxAge: undefined });
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ user: req.user });
});

app.get("/api/profile", requireAuth, (req, res) => {
  const user = getStore().users.find((item) => item.id === req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  res.json({ user: accountUser(user) });
});

app.patch("/api/profile/email-binding", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    outboundEmail: z.string().max(180).default(""),
    emailSenderName: z.string().max(80).default(""),
    emailSignature: z.string().max(800).default(""),
    smtpHost: z.string().max(180).default(""),
    smtpPort: z.number().int().min(1).max(65535).default(465),
    smtpSecure: z.boolean().default(true),
    smtpUser: z.string().max(180).default(""),
    smtpPassword: z.string().max(300).optional().default(""),
    clearSmtpPassword: z.boolean().optional().default(false)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  user.outboundEmail = body.outboundEmail;
  user.emailSenderName = body.emailSenderName;
  user.emailSignature = body.emailSignature;
  user.smtpHost = body.smtpHost;
  user.smtpPort = body.smtpPort;
  user.smtpSecure = body.smtpSecure;
  user.smtpUser = body.smtpUser;
  if (body.clearSmtpPassword) {
    user.smtpPassword = "";
  } else if (body.smtpPassword) {
    user.smtpPassword = body.smtpPassword;
  }
  await store.persist();
  res.json({ user: accountUser(user) });
}));

app.post("/api/profile/test-email", requireAuth, asyncRoute(async (_req, res) => {
  const schema = z.object({
    to: z.string().email().optional().or(z.literal(""))
  });
  const body = schema.parse(_req.body || {});
  const store = getStore();
  const user = store.users.find((item) => item.id === _req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (!user.outboundEmail) {
    res.status(400).json({ message: "请先保存发件邮箱" });
    return;
  }
  const testTo = body.to?.trim() || user.outboundEmail;
  try {
    const info = await sendOutboundEmail(user, {
      to: testTo,
      subject: "GoodJob CRM SMTP 测试邮件",
      body: `这是一封来自 GoodJob CRM 的 SMTP 测试邮件。\n\n账号：${user.email}\n时间：${new Date().toISOString()}`
    });
    res.json({ ok: true, to: testTo, messageId: info.messageId, simulated: process.env.NODE_ENV === "test" });
  } catch (error) {
    res.status(400).json({ message: outboundEmailError(error, user) });
  }
}));

app.post("/api/profile/send-development-email", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    to: z.string().email(),
    company: z.string().min(1).max(120),
    subject: z.string().min(1).max(160),
    body: z.string().min(10).max(3000)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  let mailInfo: Awaited<ReturnType<typeof sendOutboundEmail>>;
  try {
    mailInfo = await sendOutboundEmail(user, { to: body.to, subject: body.subject, body: body.body });
  } catch (error) {
    res.status(400).json({ message: outboundEmailError(error, user) });
    return;
  }
  const sentAt = new Date().toISOString();
  user.lastDevelopmentEmailAt = sentAt;
  user.lastDevelopmentEmailTo = body.to;
  user.lastDevelopmentEmailSubject = body.subject;
  await store.persist();
  res.json({
    sent: {
      id: `mail_${Date.now()}`,
      status: "sent",
      simulated: process.env.NODE_ENV === "test",
      messageId: mailInfo.messageId,
      from: user.outboundEmail,
      senderName: user.emailSenderName || user.name,
      to: body.to,
      company: body.company,
      subject: body.subject,
      body: body.body,
      sentAt
    },
    user: accountUser(user)
  });
}));

app.post("/api/prospect-list/:id/send-development-email", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(160),
    body: z.string().min(10).max(3000),
    requestId: z.string().min(1).max(120).optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  const opportunity = store.websiteOpportunities.find((item) => item.id === req.params.id && canSeeOwner(req.user!, item.ownerId, item.teamId));
  if (!opportunity) {
    res.status(404).json({ message: "搜客线索不存在或无权访问" });
    return;
  }
  if (opportunity.ownerId !== req.user!.id) {
    res.status(403).json({ message: "只有候选归属业务员可以发送开发信" });
    return;
  }
  const requestId = body.requestId || requestCorrelationId(req);
  const existingTouchpoint = store.prospectTouchpoints.find((item) =>
    item.ownerId === req.user!.id
    && item.prospectCandidateId === opportunity.id
    && item.requestId === requestId
  );
  if (existingTouchpoint) {
    if (existingTouchpoint.contactValue.trim().toLocaleLowerCase("en-US")
        !== body.to.trim().toLocaleLowerCase("en-US")
      || existingTouchpoint.subject !== body.subject
      || existingTouchpoint.content !== body.body) {
      res.status(409).json({
        message: "该 requestId 已用于不同的开发信内容",
        errorCode: "PROSPECT_OUTREACH_IDEMPOTENCY_CONFLICT"
      });
      return;
    }
    res.json({
      sent: {
        id: existingTouchpoint.id,
        status: "sent",
        simulated: process.env.NODE_ENV === "test",
        replayed: true,
        to: existingTouchpoint.contactValue,
        company: opportunity.company,
        subject: existingTouchpoint.subject,
        body: existingTouchpoint.content,
        sentAt: existingTouchpoint.occurredAt
      },
      opportunity,
      user: accountUser(user)
    });
    return;
  }
  let eligibility;
  try {
    await store.reloadProspectQualificationTeam?.(req.user!.teamId);
    eligibility = assertProspectEmailOutreachEligible(
      store,
      opportunity,
      body.to,
      new Date().toISOString()
    );
  } catch (error) {
    if (sendProspectQualificationError(res, error)) return;
    throw error;
  }
  let mailInfo: Awaited<ReturnType<typeof sendOutboundEmail>>;
  try {
    mailInfo = await sendOutboundEmail(user, {
      to: eligibility.recipient,
      subject: body.subject,
      body: body.body
    });
  } catch (error) {
    res.status(400).json({ message: outboundEmailError(error, user) });
    return;
  }
  const sentAt = new Date().toISOString();
  user.lastDevelopmentEmailAt = sentAt;
  user.lastDevelopmentEmailTo = eligibility.recipient;
  user.lastDevelopmentEmailSubject = body.subject;
  opportunity.lastDevelopmentEmailAt = sentAt;
  opportunity.lastDevelopmentEmailTo = eligibility.recipient;
  opportunity.lastDevelopmentEmailSubject = body.subject;
  const outreach = await recordProspectTouchpoint(store, {
    candidate: opportunity,
    actorId: req.user!.id,
    channel: "email",
    direction: "outbound",
    contactValue: eligibility.recipient,
    subject: body.subject,
    content: body.body,
    requestId,
    occurredAt: sentAt
  });
  await persistCandidateChanges(store, [opportunity]);
  res.json({
    sent: {
      id: `mail_${Date.now()}`,
      status: "sent",
      simulated: process.env.NODE_ENV === "test",
      messageId: mailInfo.messageId,
      from: user.outboundEmail,
      senderName: user.emailSenderName || user.name,
      to: eligibility.recipient,
      company: opportunity.company,
      subject: body.subject,
      body: body.body,
      sentAt,
      replayed: false
    },
    touchpoint: outreach.touchpoint,
    todo: outreach.todo,
    opportunity,
    user: accountUser(user)
  });
}));

const prospectOutreachChannelSchema = z.enum(["email", "whatsapp", "call"]);
const prospectReplyClassificationSchema = z.enum([
  "clear_demand",
  "interested_nurture",
  "referral",
  "no_current_demand",
  "rejected",
  "unsubscribed",
  "bounced",
  "auto_unknown"
]);
const procurementEvidenceTypeSchema = z.enum([
  "quote_request",
  "product_requirement",
  "quantity",
  "sample_request",
  "purchase_timeline",
  "target_price",
  "certification",
  "delivery",
  "project_tender",
  "manual_confirmation"
]);

function procurementContextForCandidate(candidate: WebsiteOpportunity) {
  const store = getStore();
  const signals = store.procurementSignals
    .filter((item) =>
      item.teamId === candidate.teamId
      && item.ownerId === candidate.ownerId
      && item.prospectCandidateId === candidate.id
    )
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  const recommendations = store.dealRecommendations
    .filter((item) =>
      item.teamId === candidate.teamId
      && item.ownerId === candidate.ownerId
      && item.prospectCandidateId === candidate.id
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((recommendation) => {
      const duplicateIds = new Set(recommendation.duplicateDealIds);
      const duplicateDeals = store.deals
        .filter((deal) =>
          duplicateIds.has(deal.id)
          && deal.teamId === candidate.teamId
          && deal.ownerId === candidate.ownerId
          && !deal.archivedAt
        )
        .map((deal) => ({
          id: deal.id,
          title: deal.title,
          product: deal.product,
          stage: deal.stage,
          amount: deal.amount,
          currency: deal.currency
        }));
      return {
        ...recommendation,
        reasonTexts: recommendationReasonText(recommendation),
        duplicateDeals
      };
    });
  return { signals, recommendations };
}

function resolveVisibleProspectCandidate(
  req: Request,
  candidateId: string
) {
  return getStore().websiteOpportunities.find((item) =>
    item.id === candidateId
    && canSeeOwner(req.user!, item.ownerId, item.teamId)
  );
}

function requireOwnedProspectCandidate(
  req: Request,
  res: Response
) {
  const candidate = resolveVisibleProspectCandidate(req, req.params.id);
  if (!candidate) {
    res.status(404).json({ message: "搜客线索不存在或无权访问" });
    return null;
  }
  if (candidate.ownerId !== req.user!.id) {
    res.status(403).json({ message: "只有候选归属业务员可以记录触达和生成跟进待办" });
    return null;
  }
  return candidate;
}

app.get("/api/prospect-list/:id/touchpoints", requireAuth, (req, res) => {
  const candidate = resolveVisibleProspectCandidate(req, req.params.id);
  if (!candidate) {
    res.status(404).json({ message: "搜客线索不存在或无权访问" });
    return;
  }
  const touchpoints = getStore().prospectTouchpoints
    .filter((item) =>
      item.teamId === candidate.teamId
      && item.ownerId === candidate.ownerId
      && item.prospectCandidateId === candidate.id
    )
    .sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt)
    );
  res.setHeader("Cache-Control", "no-store");
  res.json({ touchpoints, opportunity: candidate });
});

app.get("/api/prospect-list/:id/procurement-context", requireAuth, (req, res) => {
  const candidate = resolveVisibleProspectCandidate(req, req.params.id);
  if (!candidate) {
    res.status(404).json({ message: "搜客线索不存在或无权访问" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    opportunity: candidate,
    ...procurementContextForCandidate(candidate)
  });
});

app.post("/api/prospect-list/:id/touchpoints", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    recordMode: z.literal("historical"),
    channel: prospectOutreachChannelSchema,
    contactValue: z.string().max(255).optional().default(""),
    subject: z.string().max(255).optional().default(""),
    content: z.string().max(5000).optional().default(""),
    occurredAt: z.string().datetime().optional(),
    nextFollowAt: z.string().max(40).optional(),
    requestId: z.string().min(1).max(120)
  });
  const body = schema.parse(req.body);
  const candidate = requireOwnedProspectCandidate(req, res);
  if (!candidate) return;
  const store = getStore();
  const result = await recordProspectTouchpoint(store, {
    candidate,
    actorId: req.user!.id,
    recordMode: body.recordMode,
    channel: body.channel,
    direction: "outbound",
    contactValue: body.contactValue,
    subject: body.subject,
    content: body.content,
    occurredAt: body.occurredAt,
    nextFollowAt: body.nextFollowAt,
    requestId: body.requestId
  });
  await store.persist();
  res.status(result.replayed ? 200 : 201).json({
    ...result,
    opportunity: candidate
  });
}));

app.post("/api/prospect-list/:id/replies", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    channel: prospectOutreachChannelSchema,
    classification: prospectReplyClassificationSchema,
    contactValue: z.string().max(255).optional().default(""),
    subject: z.string().max(255).optional().default(""),
    content: z.string().max(5000).optional().default(""),
    occurredAt: z.string().datetime().optional(),
    requestId: z.string().min(1).max(120),
    procurement: z.object({
      evidenceSummary: z.string().max(2000).optional().default(""),
      evidenceTypes: z.array(procurementEvidenceTypeSchema)
        .max(10)
        .optional()
        .default([]),
      product: z.string().max(200).optional().default(""),
      specification: z.string().max(1000).optional().default(""),
      quantity: z.coerce.number().int().nonnegative().optional().default(0),
      quantityType: z.enum([
        "unknown",
        "sample",
        "trial",
        "forecast",
        "order"
      ]).optional().default("unknown"),
      targetPrice: z.coerce.number().nonnegative().optional().default(0),
      currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional().default("USD"),
      priceBasis: z.string().max(80).optional().default(""),
      deliveryRequirement: z.string().max(500).optional().default(""),
      certificationRequirement: z.string().max(500).optional().default(""),
      purchaseTimeline: z.string().max(500).optional().default(""),
      projectName: z.string().max(500).optional().default(""),
      buyerRole: z.string().max(100).optional().default(""),
      nextAction: z.string().max(200).optional().default(""),
      confidence: z.coerce.number().min(0).max(100).optional().default(85)
    }).optional()
  });
  const body = schema.parse(req.body);
  const candidate = requireOwnedProspectCandidate(req, res);
  if (!candidate) return;
  const store = getStore();
  const result = await recordProspectTouchpoint(store, {
    candidate,
    actorId: req.user!.id,
    channel: body.channel,
    direction: "inbound",
    contactValue: body.contactValue,
    subject: body.subject,
    content: body.content,
    replyClassification: body.classification,
    occurredAt: body.occurredAt,
    requestId: body.requestId
  });
  let procurement;
  if (body.classification === "clear_demand") {
    const signalResult = recordProcurementSignal(store, {
      candidate,
      touchpoint: result.touchpoint,
      actorId: req.user!.id,
      ...(body.procurement || {})
    });
    const recommendationResult = proposeDealRecommendation(
      store,
      signalResult.signal
    );
    procurement = {
      signal: signalResult.signal,
      assessment: recommendationResult.assessment,
      recommendation: recommendationResult.recommendation,
      signalReplayed: signalResult.replayed,
      recommendationCreated: recommendationResult.created
    };
  }
  await persistCandidateChanges(store, [candidate]);
  res.status(result.replayed ? 200 : 201).json({
    ...result,
    procurement,
    opportunity: candidate
  });
}));

app.post("/api/deal-recommendations/:id/dismiss", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    reason: z.string().trim().max(500).optional().default("")
  }).parse(req.body || {});
  const store = getStore();
  const recommendation = store.dealRecommendations.find((item) =>
    item.id === req.params.id
    && item.teamId === req.user!.teamId
    && item.ownerId === req.user!.id
  );
  if (!recommendation) {
    res.status(404).json({ message: "商机建议不存在或无权访问" });
    return;
  }
  try {
    dismissDealRecommendation(recommendation, req.user!.id, body.reason);
  } catch (error) {
    res.status(409).json({
      message: error instanceof Error ? error.message : "当前建议不能忽略"
    });
    return;
  }
  await store.persist();
  res.json({ recommendation });
}));

app.post("/api/deal-recommendations/:id/link-deal", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    dealId: z.string().trim().min(1)
  }).parse(req.body);
  const store = getStore();
  const recommendation = store.dealRecommendations.find((item) =>
    item.id === req.params.id
    && item.teamId === req.user!.teamId
    && item.ownerId === req.user!.id
  );
  const deal = store.deals.find((item) =>
    item.id === body.dealId
    && item.teamId === req.user!.teamId
    && item.ownerId === req.user!.id
  );
  if (!recommendation || !deal) {
    res.status(404).json({ message: "商机建议或商机不存在" });
    return;
  }
  if (recommendation.status !== "generated") {
    res.status(409).json({ message: "当前建议已经处理" });
    return;
  }
  try {
    linkRecommendationToDeal(
      store,
      recommendation,
      deal,
      req.user!.id,
      "linked_existing_deal"
    );
  } catch (error) {
    res.status(409).json({
      message: error instanceof Error ? error.message : "商机关联失败"
    });
    return;
  }
  await store.persist();
  res.json({ recommendation, deal });
}));

app.post("/api/prospect-list/:id/follow-up", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    channel: prospectOutreachChannelSchema.default("email"),
    dueAt: z.string().max(40).optional().default(""),
    priority: z.enum(["high", "medium", "normal"]).optional().default("medium")
  });
  const body = schema.parse(req.body || {});
  const candidate = requireOwnedProspectCandidate(req, res);
  if (!candidate) return;
  const store = getStore();
  const result = ensureProspectFollowUpTodo(store, {
    candidate,
    channel: body.channel as ProspectOutreachChannel,
    dueAt: body.dueAt || undefined,
    priority: body.priority,
    reason: "人工安排跟进"
  });
  candidate.nextFollowAt = result.todo.dueAt;
  await persistCandidateChanges(store, [candidate]);
  res.status(result.created ? 201 : 200).json({
    ...result,
    opportunity: candidate
  });
}));

const dailyReportBodySchema = z.object({
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日报日期格式不正确"),
  completedWork: z.string().trim().min(1, "请填写今日完成工作").max(5000),
  customerProgress: z.string().trim().max(5000).default(""),
  results: z.string().trim().max(5000).default(""),
  risks: z.string().trim().max(5000).default(""),
  nextPlan: z.string().trim().max(5000).default(""),
  supportNeeded: z.string().trim().max(5000).default("")
});

app.get("/api/daily-reports", requireAuth, (req, res) => {
  const query = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ownerId: z.string().max(64).optional()
  }).parse(req.query);
  const store = getStore();
  const reports = store.dailyReports
    .filter((item) => canViewDailyReport(req.user!, item))
    .filter((item) => !query.from || item.reportDate >= query.from)
    .filter((item) => !query.to || item.reportDate <= query.to)
    .filter((item) => !query.ownerId || item.ownerId === query.ownerId)
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate) || right.updatedAt.localeCompare(left.updatedAt))
    .map(publicDailyReport);
  const visibleOwners = store.users
    .filter((item) => item.status === "active")
    .filter((item) => req.user!.role === "super_admin" || item.teamId === req.user!.teamId)
    .filter((item) => req.user!.role !== "sales" || item.id === req.user!.id)
    .map((item) => collaborationUser(item.id));
  res.json({
    reports,
    owners: visibleOwners,
    canViewTeam: req.user!.role !== "sales"
  });
});

app.post("/api/daily-reports", requireAuth, asyncRoute(async (req, res) => {
  const body = dailyReportBodySchema.parse(req.body);
  const store = getStore();
  const now = new Date().toISOString();
  let report = store.dailyReports.find((item) => item.ownerId === req.user!.id && item.reportDate === body.reportDate);
  const created = !report;
  if (report) {
    Object.assign(report, body, {
      status: "submitted" as const,
      submittedAt: now,
      updatedAt: now
    });
  } else {
    report = {
      id: `report_${randomUUID()}`,
      ...body,
      status: "submitted",
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      submittedAt: now,
      createdAt: now,
      updatedAt: now
    };
    store.dailyReports.unshift(report);
  }
  const recipients = store.users.filter((item) =>
    item.status === "active"
    && item.teamId === req.user!.teamId
    && (item.role === "manager" || item.role === "admin")
  );
  recipients.forEach((recipient) => createInternalNotification({
    senderId: req.user!.id,
    recipientId: recipient.id,
    teamId: recipient.teamId,
    subject: `${req.user!.name}${created ? "提交" : "更新"}了 ${body.reportDate} 日报`,
    content: body.completedWork.slice(0, 240),
    relatedType: "daily_report",
    relatedId: report!.id
  }));
  await store.persist();
  res.status(created ? 201 : 200).json({ report: publicDailyReport(report), created });
}));

app.get("/api/daily-reports/:id", requireAuth, (req, res) => {
  const report = getStore().dailyReports.find((item) => item.id === req.params.id);
  if (!report || !canViewDailyReport(req.user!, report)) {
    res.status(404).json({ message: "日报不存在或无权查看" });
    return;
  }
  const comments = getStore().dailyReportComments
    .filter((item) => item.reportId === report.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map(publicDailyReportComment);
  res.json({ report: publicDailyReport(report), comments });
});

app.post("/api/daily-reports/:id/comments", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    content: z.string().trim().min(1, "评论内容不能为空").max(2000),
    parentId: z.string().max(64).optional().default("")
  }).parse(req.body);
  const store = getStore();
  const report = store.dailyReports.find((item) => item.id === req.params.id);
  if (!report || !canViewDailyReport(req.user!, report)) {
    res.status(404).json({ message: "日报不存在或无权评论" });
    return;
  }
  const parent = body.parentId
    ? store.dailyReportComments.find((item) => item.id === body.parentId && item.reportId === report.id)
    : null;
  if (body.parentId && !parent) {
    res.status(400).json({ message: "回复的评论不存在" });
    return;
  }
  const now = new Date().toISOString();
  const comment = {
    id: `comment_${randomUUID()}`,
    reportId: report.id,
    parentId: parent?.id || "",
    content: body.content,
    authorId: req.user!.id,
    teamId: report.teamId,
    createdAt: now,
    updatedAt: now
  };
  store.dailyReportComments.push(comment);
  const recipientIds = new Set<string>([report.ownerId]);
  if (parent) recipientIds.add(parent.authorId);
  recipientIds.delete(req.user!.id);
  recipientIds.forEach((recipientId) => {
    const recipient = store.users.find((item) => item.id === recipientId && item.status === "active");
    if (!recipient) return;
    createInternalNotification({
      senderId: req.user!.id,
      recipientId,
      teamId: recipient.teamId,
      subject: parent ? `${req.user!.name}回复了你的日报评论` : `${req.user!.name}评论了你的日报`,
      content: body.content.slice(0, 240),
      relatedType: "daily_report",
      relatedId: report.id,
      threadId: `daily_report_${report.id}`
    });
  });
  await store.persist();
  res.status(201).json({ comment: publicDailyReportComment(comment) });
}));

app.get("/api/internal-messages/recipients", requireAuth, (req, res) => {
  const recipients = getStore().users
    .filter((item) => item.status === "active" && item.id !== req.user!.id)
    .filter((item) => req.user!.role === "super_admin" || item.teamId === req.user!.teamId)
    .map((item) => collaborationUser(item.id));
  res.json({ recipients });
});

app.get("/api/internal-messages", requireAuth, (req, res) => {
  const box = z.enum(["inbox", "sent"]).catch("inbox").parse(req.query.box);
  const store = getStore();
  const messages = store.internalMessages
    .filter((item) => box === "sent" ? item.senderId === req.user!.id : item.recipientId === req.user!.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 300)
    .map(publicInternalMessage);
  res.json({
    messages,
    unreadCount: store.internalMessages.filter((item) => item.recipientId === req.user!.id && !item.readAt).length
  });
});

app.post("/api/internal-messages", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    recipientId: z.string().min(1).max(64),
    subject: z.string().trim().min(1, "请填写主题").max(180),
    content: z.string().trim().min(1, "请填写消息内容").max(5000),
    threadId: z.string().max(64).optional().default("")
  }).parse(req.body);
  const store = getStore();
  const recipient = store.users.find((item) => item.id === body.recipientId && item.status === "active");
  if (!recipient || recipient.id === req.user!.id) {
    res.status(400).json({ message: "收件人不可用" });
    return;
  }
  if (req.user!.role !== "super_admin" && recipient.teamId !== req.user!.teamId) {
    res.status(403).json({ message: "不能向其他团队发送站内信" });
    return;
  }
  const now = new Date().toISOString();
  const message = {
    id: `msg_${randomUUID()}`,
    threadId: body.threadId || `thread_${randomUUID()}`,
    senderId: req.user!.id,
    recipientId: recipient.id,
    teamId: recipient.teamId,
    type: "manual" as const,
    subject: body.subject,
    content: body.content,
    relatedType: "message" as const,
    relatedId: "",
    readAt: "",
    createdAt: now,
    updatedAt: now
  };
  store.internalMessages.unshift(message);
  await store.persist();
  res.status(201).json({ message: publicInternalMessage(message) });
}));

app.post("/api/internal-messages/:id/read", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const message = store.internalMessages.find((item) => item.id === req.params.id && item.recipientId === req.user!.id);
  if (!message) {
    res.status(404).json({ message: "站内信不存在" });
    return;
  }
  if (!message.readAt) {
    message.readAt = new Date().toISOString();
    message.updatedAt = message.readAt;
    await store.persist();
  }
  res.json({ message: publicInternalMessage(message) });
}));

app.get("/api/accounts", requireAuth, (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const { users } = getStore();
  const accounts = req.user!.role === "super_admin"
    ? users
    : users.filter((user) => user.id === req.user!.id || (
      user.teamId === req.user!.teamId && (user.role === "sales" || user.role === "manager")
    ));
  res.json({ accounts: accounts.map(accountUser) });
});

const mysqlImportValueSchema = z.union([
  z.string().max(1_000_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.object({ hex: z.string().regex(/^[0-9A-Fa-f]*$/).max(2_000_000) }).strict()
]);

function assertDatabaseImportAccess(req: Request) {
  if (!req.user || !canManageAccounts(req.user)) {
    throw new MysqlDataImportError(403, "只有管理员可以执行数据库迁移");
  }
  if (getStore().mode !== "mysql") {
    throw new MysqlDataImportError(409, "当前不是 MySQL 持久化模式");
  }
  assertMysqlDataImportToken(req.header("x-database-import-token"));
}

app.get("/api/system/database-import/status", requireAuth, (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "只有管理员可以查看数据库迁移" });
    return;
  }
  res.json({
    enabled: mysqlDataImportEnabled(),
    store: getStore().mode,
    acceptedExtensions: [".sql", ".sql.gz"],
    maxBatchRows: 100
  });
});

app.get("/api/system/database-maintenance/status", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "只有管理员可以查看数据库维护" });
    return;
  }
  const backup = mysqlLocalBackupConfig();
  const [imports, backups] = getStore().mode === "mysql"
    ? await Promise.all([listMysqlDataImports(1), listDatabaseBackupJobs(1)])
    : [[], []];
  const latest = [...imports.map((job) => ({ ...job, type: "migration" as const })), ...backups.map((job) => ({ ...job, type: "backup" as const }))]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  res.json({
    store: getStore().mode,
    migration: {
      enabled: mysqlDataImportEnabled() && getStore().mode === "mysql",
      sourceStoredOnServer: false,
      acceptedExtensions: [".sql", ".sql.gz"],
      maxFileSize: 500 * 1024 * 1024,
      maxBatchRows: 100
    },
    backup: {
      enabled: backup.enabled && getStore().mode === "mysql",
      retentionDays: backup.retentionDays,
      reason: backup.enabled ? "" : "服务器已禁止本地备份"
    },
    latest: latest || null
  });
}));

app.get("/api/system/database-maintenance/jobs", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "只有管理员可以查看数据库维护任务" });
    return;
  }
  if (getStore().mode !== "mysql") {
    res.json({ jobs: [] });
    return;
  }
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
  const [imports, backups] = await Promise.all([listMysqlDataImports(limit), listDatabaseBackupJobs(limit)]);
  const jobs = [
    ...imports.map((job) => ({ ...job, type: "migration" as const })),
    ...backups.map((job) => ({ ...job, type: "backup" as const }))
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit);
  res.json({ jobs });
}));

app.get("/api/system/database-import/schema", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  res.json({ tables: await mysqlImportableSchema() });
}));

app.post("/api/system/database-import/jobs", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  const body = z.object({
    fileName: z.string().trim().min(1).max(255),
    fileSize: z.number().int().min(1).max(500 * 1024 * 1024),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
    conflictMode: z.enum(["skip", "overwrite"]).default("skip"),
    tableRows: z.record(z.number().int().min(0).max(100_000_000)).refine((value) => Object.keys(value).length <= 500).optional(),
    ignoredStatements: z.number().int().min(0).max(10_000_000).optional()
  }).parse(req.body);
  const job = await beginMysqlDataImport({ ...body, actorId: req.user!.id });
  res.status(201).json({ job });
}));

app.get("/api/system/database-import/jobs/:id", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  res.json({ job: await getMysqlDataImport(req.params.id, req.user!.id) });
}));

app.post("/api/system/database-import/jobs/:id/batches", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  const body = z.object({
    table: z.string().regex(/^[A-Za-z0-9_]+$/).max(128),
    columns: z.array(z.string().regex(/^[A-Za-z0-9_]+$/).max(128)).min(1).max(300),
    rows: z.array(z.array(mysqlImportValueSchema).min(1).max(300)).min(1).max(100),
    tableComplete: z.boolean().optional().default(false)
  }).parse(req.body);
  const result = await importMysqlDataBatch({
    jobId: req.params.id,
    actorId: req.user!.id,
    ...body
  });
  res.json({ result, job: await getMysqlDataImport(req.params.id, req.user!.id) });
}));

app.post("/api/system/database-import/jobs/:id/fail", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  const body = z.object({ message: z.string().trim().min(1).max(500) }).parse(req.body);
  await failMysqlDataImport(req.params.id, req.user!.id, body.message);
  res.json({ ok: true });
}));

app.post("/api/system/database-import/jobs/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  res.json({ job: await cancelMysqlDataImport(req.params.id, req.user!.id) });
}));

app.post("/api/system/database-import/jobs/:id/complete", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  const job = await completeMysqlDataImport(req.params.id, req.user!.id);
  const restartScheduled = process.env.NODE_ENV === "production";
  res.json({ job, restartScheduled });
  if (restartScheduled) {
    res.once("finish", () => {
      const timer = setTimeout(() => process.exit(75), 750);
      timer.unref();
    });
  }
}));

app.post("/api/system/database-backups/jobs", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  const job = await beginDatabaseBackup({ actorId: req.user!.id });
  res.status(201).json({ job });
}));

app.get("/api/system/database-backups/jobs/:id", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  res.json({ job: await getDatabaseBackupJob(req.params.id) });
}));

app.post("/api/system/database-backups/jobs/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  res.json({ job: await cancelDatabaseBackup(req.params.id) });
}));

app.get("/api/system/database-backups/jobs/:id/download", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  const { job, path } = await databaseBackupDownload(req.params.id);
  res.download(path, job.fileName);
}));

app.delete("/api/system/database-backups/jobs/:id", requireAuth, asyncRoute(async (req, res) => {
  assertDatabaseImportAccess(req);
  res.json(await deleteDatabaseBackup(req.params.id));
}));

app.post("/api/accounts", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8).max(128),
    role: z.enum(["sales", "manager", "admin", "super_admin"]).default("sales"),
    teamId: z.string().min(1).optional()
  });
  const body = schema.parse(req.body);
  if (!canManageRole(req.user!, body.role)) {
    res.status(403).json({ message: "无权创建该角色账号" });
    return;
  }
  const store = getStore();
  if (store.users.some((user) => user.email === body.email)) {
    res.status(409).json({ message: "账号邮箱已存在" });
    return;
  }
  const teamId = req.user!.role === "super_admin"
    ? (body.role === "super_admin" ? "all" : body.teamId || "")
    : req.user!.teamId;
  if (!teamId) {
    res.status(400).json({ message: "超级管理员创建账号时必须指定团队编号" });
    return;
  }
  if (body.role === "admin" && store.users.some((user) => user.role === "admin" && user.teamId === teamId)) {
    res.status(409).json({ message: "该团队已存在管理员，每个公测团队只允许一名管理员" });
    return;
  }
  const user = {
    id: `u_${Date.now()}`,
    name: body.name,
    email: body.email,
    password: await hashPassword(body.password),
    role: body.role,
    teamId,
    avatar: body.name.slice(0, 2).toUpperCase(),
    status: "active" as const
  };
  store.users.unshift(user);
  await store.persist();
  res.json({ account: accountUser(user) });
}));

app.patch("/api/accounts/:id/password", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const schema = z.object({ password: z.string().min(8).max(128) });
  const body = schema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.params.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (!canManageAccount(req.user!, publicUser(user))) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  user.password = await hashPassword(body.password);
  user.authVersion = (user.authVersion || 1) + 1;
  await store.persist();
  res.json({ account: accountUser(user) });
}));

app.patch("/api/accounts/:id/disable", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const store = getStore();
  const user = store.users.find((item) => item.id === req.params.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (user.id === req.user!.id) {
    res.status(400).json({ message: "不能停用当前登录账号" });
    return;
  }
  if (!canManageAccount(req.user!, publicUser(user))) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  user.status = "disabled";
  user.authVersion = (user.authVersion || 1) + 1;
  await store.persist();
  res.json({ account: accountUser(user) });
}));

app.delete("/api/accounts/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const store = getStore();
  const index = store.users.findIndex((item) => item.id === req.params.id);
  const user = index >= 0 ? store.users[index] : null;
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (user.id === req.user!.id) {
    res.status(400).json({ message: "不能删除当前登录账号" });
    return;
  }
  if (!canManageAccount(req.user!, publicUser(user))) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (store.prospectCampaigns.some((item) => item.ownerId === user.id)) {
    res.status(409).json({ message: "该账号仍负责获客项目，请先转交项目后再删除" });
    return;
  }
  if (activeProspectRunsForOwner(store, user.teamId, user.id).length) {
    res.status(409).json({
      message: "该账号仍有活动搜索运行，请先取消运行后再删除"
    });
    return;
  }
  store.users.splice(index, 1);
  await store.persist();
  res.json({ ok: true, id: req.params.id });
}));

function publicPoolCustomersFor(user: SessionUser) {
  if (user.role === "super_admin") return [];
  return getStore().customers.filter((customer) =>
    customer.teamId === user.teamId && isPublicCustomer(customer)
  );
}

function ownedCustomersFor(user: SessionUser, scope: "mine" | "team" = "mine") {
  return getStore().customers.filter((customer) => {
    if (isPublicCustomer(customer)) return false;
    if (scope === "team") {
      return user.role !== "super_admin" && customer.teamId === user.teamId;
    }
    return canSeeOwner(user, customer.ownerId, customer.teamId);
  });
}

function customerPoolCounts(user: SessionUser) {
  return {
    mineCount: ownedCustomersFor(user).length,
    publicCount: publicPoolCustomersFor(user).length
  };
}

function findWritableCustomer(
  user: SessionUser,
  customerId: string,
  res: Response
) {
  const customer = getStore().customers.find((item) => item.id === customerId);
  if (!customer) {
    res.status(404).json({ message: "客户不存在" });
    return null;
  }
  if (isPublicCustomer(customer)) {
    if (user.role !== "super_admin" && customer.teamId === user.teamId) {
      res.status(409).json({ message: "公池客户为只读，请先领取后再操作" });
    } else {
      res.status(404).json({ message: "客户不存在" });
    }
    return null;
  }
  if (!canSeeOwner(user, customer.ownerId, customer.teamId)) {
    res.status(404).json({ message: "客户不存在" });
    return null;
  }
  return customer;
}

function ensureDealCustomerWritable(
  user: SessionUser,
  deal: Deal,
  res: Response
) {
  return Boolean(findWritableCustomer(user, deal.customerId, res));
}

function sendCustomerOwnershipError(res: Response, error: unknown) {
  if (error instanceof CustomerOwnershipError) {
    res.status(error.status).json({ message: error.message, errorCode: error.code });
    return true;
  }
  return false;
}

app.get("/api/customers", requireAuth, (req, res) => {
  const parsedScope = z.enum(["mine", "public", "team"]).safeParse(req.query.scope || "mine");
  if (!parsedScope.success) {
    res.status(400).json({ message: "客户范围参数无效" });
    return;
  }
  const scoped = parsedScope.data === "public"
    ? publicPoolCustomersFor(req.user!)
    : ownedCustomersFor(req.user!, parsedScope.data);
  res.json({
    customers: scoped.map((customer) => customerWithPipeline(customer, req.user!)),
    ...customerPoolCounts(req.user!)
  });
});

app.post("/api/customers", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1),
    country: z.string().min(1).default("未知"),
    contact: z.string().min(1).default("待维护"),
    whatsapp: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "WhatsApp 号码须包含国家码").or(z.literal("")).optional().default(""),
    stage: z.string().min(1).default("询盘"),
    amount: z.number().int().nonnegative().default(0),
    health: z.number().int().min(0).max(100).optional().default(72),
    grade: z.enum(["A", "B", "C", "D"]).optional().default("C"),
    billingName: z.string().optional().default(""),
    billingAddress: z.string().optional().default(""),
    documentContact: z.string().optional().default(""),
    defaultPortDischarge: z.string().optional().default(""),
    defaultIncoterm: z.string().optional().default(""),
    defaultPaymentTerm: z.string().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const customer = {
    id: `c_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    nextReminder: "明天 10:00",
    wecomBound: false,
    ...body
  };
  store.customers.unshift(customer);
  await store.persist();
  res.json({ customer: customerWithPipeline(customer, req.user!) });
}));

app.patch("/api/customers/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
    contact: z.string().min(1).optional(),
    whatsapp: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "WhatsApp 号码须包含国家码").or(z.literal("")).optional(),
    stage: z.string().min(1).optional(),
    amount: z.number().int().nonnegative().optional(),
    health: z.number().int().min(0).max(100).optional(),
    grade: z.enum(["A", "B", "C", "D"]).optional(),
    nextReminder: z.string().min(1).optional(),
    wecomBound: z.boolean().optional(),
    billingName: z.string().optional(),
    billingAddress: z.string().optional(),
    documentContact: z.string().optional(),
    defaultPortDischarge: z.string().optional(),
    defaultIncoterm: z.string().optional(),
    defaultPaymentTerm: z.string().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const customer = findWritableCustomer(req.user!, req.params.id, res);
  if (!customer) return;
  Object.assign(customer, body);
  await store.persist();
  res.json({ customer: customerWithPipeline(customer, req.user!) });
}));

app.post("/api/customers/:id/release", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    reason: z.string().trim().min(2).max(500),
    expectedVersion: z.number().int().nonnegative().optional()
  }).parse(req.body);
  const store = getStore();
  if (!store.mutateCustomerOwnership) {
    res.status(503).json({ message: "客户公池服务暂不可用" });
    return;
  }
  try {
    const result = await store.mutateCustomerOwnership({
      action: "release",
      customerId: req.params.id,
      actorId: req.user!.id,
      actorRole: req.user!.role,
      actorTeamId: req.user!.teamId,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      occurredAt: new Date().toISOString()
    });
    res.json({
      customer: customerWithPipeline(result.customer, req.user!),
      event: result.event,
      cancelledTodoCount: result.cancelledTodoIds.length,
      ...customerPoolCounts(req.user!)
    });
  } catch (error) {
    if (!sendCustomerOwnershipError(res, error)) throw error;
  }
}));

app.post("/api/customers/:id/claim", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    expectedVersion: z.number().int().nonnegative().optional()
  }).parse(req.body || {});
  const store = getStore();
  if (!store.mutateCustomerOwnership) {
    res.status(503).json({ message: "客户公池服务暂不可用" });
    return;
  }
  try {
    const result = await store.mutateCustomerOwnership({
      action: "claim",
      customerId: req.params.id,
      actorId: req.user!.id,
      actorRole: req.user!.role,
      actorTeamId: req.user!.teamId,
      expectedVersion: body.expectedVersion,
      occurredAt: new Date().toISOString()
    });
    res.json({
      customer: customerWithPipeline(result.customer, req.user!),
      event: result.event,
      ...customerPoolCounts(req.user!)
    });
  } catch (error) {
    if (!sendCustomerOwnershipError(res, error)) throw error;
  }
}));

app.post("/api/customers/bulk-delete", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ ids: z.array(z.string()).min(1).max(200) });
  const body = schema.parse(req.body);
  const store = getStore();
  const ids = [...new Set(body.ids)];
  const deleted = store.customers.filter((customer) =>
    ids.includes(customer.id)
    && !isPublicCustomer(customer)
    && canSeeOwner(req.user!, customer.ownerId, customer.teamId)
  );
  if (!deleted.length) {
    res.status(404).json({ message: "未找到可删除的客户" });
    return;
  }
  const deletedIds = new Set(deleted.map((customer) => customer.id));
  const deletedNames = deleted.map((customer) => customer.company);
  store.customers = store.customers.filter((customer) => !deletedIds.has(customer.id));
  store.customerActivities = store.customerActivities.filter((activity) => !deletedIds.has(activity.customerId));
  store.customerIntelligenceSuggestions =
    store.customerIntelligenceSuggestions.filter(
      (suggestion) => !deletedIds.has(suggestion.customerId)
    );
  const deletedDealIds = new Set(store.deals.filter((deal) => deletedIds.has(deal.customerId)).map((deal) => deal.id));
  store.deals = store.deals.filter((deal) => !deletedIds.has(deal.customerId));
  store.dealEvents = store.dealEvents.filter((event) => !deletedDealIds.has(event.dealId));
  store.todos = store.todos.filter((todo) => {
    const currentUserTodo = canSeePersonalData(req.user!, todo.ownerId);
    const relatedToDeletedCustomer = deletedNames.some((name) => todo.related.includes(name) || todo.title.includes(name));
    return !currentUserTodo || !relatedToDeletedCustomer;
  });
  await store.persist();
  const customers = ownedCustomersFor(req.user!);
  res.json({ deleted, customers });
}));

// ---------------------------------------------------------------------------
// Leads (线索管理) — unified intake, follow-up and qualified conversion
// ---------------------------------------------------------------------------
const leadSourceTypes = ["outbound", "inbound", "offline", "referral", "import"] as const;
const leadWritableSchema = z.object({
  company: z.string().min(1),
  contact: z.string().optional().default(""),
  country: z.string().optional().default(""),
  email: z.string().optional().default(""),
  phone: z.string().optional().default(""),
  wechat: z.string().optional().default(""),
  source: z.string().optional().default("手动录入"),
  intent: z.enum(["高", "中", "低"]).optional().default("中"),
  stage: z.string().optional().default("新线索"),
  estimatedAmount: z.number().nonnegative().optional().default(0),
  nextFollowAt: z.string().optional().default(""),
  remark: z.string().optional().default(""),
  sourceType: z.enum(leadSourceTypes).optional().default("outbound"),
  sourceChannel: z.string().max(80).optional().default("manual"),
  sourceCampaign: z.string().max(120).optional().default(""),
  externalId: z.string().max(180).optional().default(""),
  sourceUrl: z.string().max(500).optional().default("")
});

type LeadIntake = z.infer<typeof leadWritableSchema> & {
  occurredAt?: string;
  rawPayload?: unknown;
};

function createLeadFromSource(user: SessionUser, input: LeadIntake) {
  const store = getStore();
  const sourceChannel = input.sourceChannel.trim() || "manual";
  const externalId = input.externalId.trim();
  if (externalId) {
    const priorEvent = store.leadSourceEvents.find((event) =>
      event.ownerId === user.id && event.channel === sourceChannel && event.externalId === externalId
    );
    const priorLead = priorEvent ? store.leads.find((lead) => lead.id === priorEvent.leadId) : undefined;
    if (priorEvent && priorLead) return { lead: priorLead, sourceEvent: priorEvent, duplicate: true };
  }

  const receivedAt = new Date().toISOString();
  const uniquePart = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lead: Lead = {
    id: `lead_${uniquePart}`,
    company: input.company,
    contact: input.contact,
    country: input.country,
    email: input.email,
    phone: input.phone,
    wechat: input.wechat,
    source: input.source,
    sourceType: input.sourceType,
    sourceChannel,
    sourceCampaign: input.sourceCampaign,
    externalId,
    sourceUrl: input.sourceUrl,
    intent: input.intent,
    stage: input.stage,
    status: "new",
    ownerId: user.id,
    teamId: user.teamId,
    estimatedAmount: input.estimatedAmount,
    nextFollowAt: input.nextFollowAt,
    lastActivityAt: "刚刚",
    remark: input.remark,
    convertedCustomerId: "",
    convertedDealId: "",
    createdAt: receivedAt
  };
  const sourceEvent: LeadSourceEvent = {
    id: `lse_${uniquePart}`,
    leadId: lead.id,
    sourceType: input.sourceType,
    channel: sourceChannel,
    campaign: input.sourceCampaign,
    externalId: externalId || lead.id,
    sourceUrl: input.sourceUrl,
    occurredAt: input.occurredAt || receivedAt,
    receivedAt,
    rawPayload: JSON.stringify(input.rawPayload ?? input),
    ownerId: user.id,
    teamId: user.teamId
  };
  store.leads.unshift(lead);
  store.leadSourceEvents.unshift(sourceEvent);
  store.leadActivities.unshift({
    id: `la_${uniquePart}`,
    leadId: lead.id,
    type: "system",
    content: `线索创建（来源：${lead.source} / ${sourceChannel}）`,
    operatorId: user.id,
    nextFollowAt: lead.nextFollowAt,
    createdAt: receivedAt
  });
  return { lead, sourceEvent, duplicate: false };
}

function normalizedMatchText(value: string) {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function emailDomain(value: string) {
  return value.trim().toLowerCase().split("@")[1] || "";
}

function findCustomerMatches(user: SessionUser, lead: Lead) {
  const store = getStore();
  const leadCompany = normalizedMatchText(lead.company);
  const leadEmail = lead.email.trim().toLowerCase();
  const leadDomain = emailDomain(leadEmail);
  return store.customers
    .filter((customer) =>
      !isPublicCustomer(customer)
      && canSeeOwner(user, customer.ownerId, customer.teamId)
    )
    .map((customer) => {
      let score = 0;
      const reasons: string[] = [];
      const documentContact = customer.documentContact.toLowerCase();
      if (leadCompany && normalizedMatchText(customer.company) === leadCompany) {
        score += 80;
        reasons.push("公司名称一致");
      }
      if (leadEmail && documentContact.includes(leadEmail)) {
        score += 100;
        reasons.push("联系邮箱一致");
      } else if (leadDomain && documentContact.includes(`@${leadDomain}`)) {
        score += 50;
        reasons.push("邮箱域名一致");
      }
      const activeDeals = store.deals.filter((deal) => deal.customerId === customer.id && !deal.archivedAt && deal.stage !== "丢单" && deal.stage !== "成交");
      return { customer, score, reasons, activeDealCount: activeDeals.length };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score);
}

const pipelineStageRank: Record<string, number> = { "询盘": 1, "已联系": 2, "已报价": 3, "样品": 4, "谈判": 5, "成交": 6 };

function customerGradeFromHealth(health: number) {
  if (health >= 85) return "A" as const;
  if (health >= 70) return "B" as const;
  if (health >= 55) return "C" as const;
  return "D" as const;
}

function customerWithPipeline(customer: Customer, viewer?: SessionUser) {
  const store = getStore();
  const activeDeals = store.deals.filter((deal) => deal.customerId === customer.id && !deal.archivedAt && deal.stage !== "丢单" && deal.stage !== "成交");
  const wonDeals = store.deals.filter((deal) => deal.customerId === customer.id && deal.stage === "成交");
  const activities = store.customerActivities
    .filter((activity) => activity.customerId === customer.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const pipelineStage = activeDeals.reduce((best, deal) =>
    (pipelineStageRank[deal.stage] || 0) > (pipelineStageRank[best] || 0) ? deal.stage : best, ""
  );
  const pendingIntelligence = store.customerIntelligenceSuggestions
    .filter((item) =>
      item.teamId === customer.teamId
      && item.ownerId === customer.ownerId
      && item.customerId === customer.id
      && item.status === "pending"
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const response = {
    ...customer,
    whatsappPhone: customer.whatsapp || store.whatsappBindings.find((binding) => binding.customerId === customer.id)?.phoneNumber || "",
    ownerName: store.users.find((user) => user.id === customer.ownerId)?.name || "未分配",
    previousOwnerName: store.users.find((user) => user.id === customer.previousOwnerId)?.name || "",
    releasedByName: store.users.find((user) => user.id === customer.releasedBy)?.name || "",
    activities: activities.map((activity) => ({
      ...activity,
      operatorName: store.users.find((user) => user.id === activity.operatorId)?.name || "未知操作人"
    })),
    lastActivityAt: activities[0]?.createdAt || "",
    grade: customer.grade || customerGradeFromHealth(customer.health),
    hasWonDeal: wonDeals.length > 0,
    wonDealCount: wonDeals.length,
    wonDealAmount: wonDeals.reduce((sum, deal) => sum + deal.amount, 0),
    lastWonAt: wonDeals
      .map((deal) => deal.closedAt || deal.stageChangedAt || "")
      .filter(Boolean)
      .sort((left, right) => right.localeCompare(left))[0] || "",
    pipelineStage: pipelineStage || "暂无活跃商机",
    pipelineAmount: activeDeals.reduce((sum, deal) => sum + deal.amount, 0),
    activeDealCount: activeDeals.length,
    pendingIntelligence,
    pendingIntelligenceCount: pendingIntelligence.length
  };
  // WhatsApp 号码和绑定状态属于个人账号数据，不随团队客户列表暴露给管理员或同事。
  if (!viewer || viewer.id !== customer.ownerId) {
    delete (response as Partial<typeof response>).whatsapp;
    delete (response as Partial<typeof response>).whatsappPhone;
  }
  return response;
}

type BackgroundResearchEntity = "lead" | "customer";

interface BackgroundResearchSource {
  title: string;
  url: string;
  observedAt: string;
}

function backgroundResearchSources(
  candidates: WebsiteOpportunity[],
  sourceEvents: LeadSourceEvent[],
  extra: BackgroundResearchSource[] = []
) {
  const rows: BackgroundResearchSource[] = [...extra];
  sourceEvents.forEach((event) => rows.push({
    title: event.channel || "线索来源",
    url: event.sourceUrl || "",
    observedAt: event.receivedAt || event.occurredAt || ""
  }));
  candidates.forEach((candidate) => {
    if (candidate.website) rows.push({
      title: candidate.sourceLabel || "企业官网",
      url: candidate.website,
      observedAt: candidate.verifiedAt || candidate.createdAt
    });
    (candidate.sourceEvidence || []).forEach((evidence) => rows.push({
      title: evidence.evidenceSummary || candidate.sourceLabel || "公开来源",
      url: evidence.sourceUrl || evidence.officialWebsite || "",
      observedAt: evidence.fetchedAt || candidate.createdAt
    }));
  });
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.title}|${row.url}`;
    if ((!row.title && !row.url) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function backgroundResearchRisk(level: "high" | "medium" | "low", title: string, detail: string) {
  return { level, title, detail };
}

function researchText(value: unknown, fallback = "待核实") {
  const text = String(value || "").trim();
  return text && !["未知", "待维护", "待确认", "—"].includes(text) ? text : fallback;
}

const backgroundResearchRequestSchema = z.object({
  entityType: z.enum(["lead", "customer"]),
  entityId: z.string().trim().min(1).max(120)
});

async function buildBackgroundResearch(user: SessionUser, body: z.infer<typeof backgroundResearchRequestSchema>) {
  const store = getStore();
  const entityType = body.entityType as BackgroundResearchEntity;
  const lead = entityType === "lead"
    ? store.leads.find((item) => item.id === body.entityId && canSeeOwner(user, item.ownerId, item.teamId))
    : undefined;
  const customer = entityType === "customer"
    ? store.customers.find((item) => item.id === body.entityId && canSeeOwner(user, item.ownerId, item.teamId))
    : undefined;
  if (!lead && !customer) return null;

  const ownerId = lead?.ownerId || customer!.ownerId;
  const teamId = lead?.teamId || customer!.teamId;
  const linkedLeads = lead ? [lead] : store.leads.filter((item) => item.convertedCustomerId === customer!.id);
  const sourceEvents = store.leadSourceEvents.filter((event) =>
    linkedLeads.some((item) => item.id === event.leadId)
    && event.ownerId === ownerId
    && event.teamId === teamId
  );
  const candidates = store.websiteOpportunities.filter((item) =>
    item.ownerId === ownerId
    && item.teamId === teamId
    && (lead ? item.leadId === lead.id : item.customerId === customer!.id || linkedLeads.some((linked) => linked.id === item.leadId))
  );
  const deals = customer ? store.deals.filter((deal) => deal.customerId === customer.id) : [];
  const activities = lead
    ? store.leadActivities.filter((item) => item.leadId === lead.id)
    : store.customerActivities.filter((item) => item.customerId === customer!.id);
  const suggestions = customer
    ? store.customerIntelligenceSuggestions.filter((item) => item.customerId === customer.id && item.teamId === teamId && item.ownerId === ownerId)
    : [];
  const sources = backgroundResearchSources(candidates, sourceEvents, suggestions.flatMap((item) =>
    [item.sourceUrl, ...item.evidenceRefs].filter(Boolean).map((url) => ({
      title: item.sourceLabel || "客户情报",
      url,
      observedAt: item.updatedAt || item.createdAt
    }))
  ));
  const company = lead?.company || customer!.company;
  const country = researchText(lead?.country || customer!.country);
  const contactRows = lead
    ? [
        { channel: "联系人", value: researchText(lead.contact) },
        { channel: "邮箱", value: researchText(lead.email) },
        { channel: "电话", value: researchText(lead.phone) }
      ]
    : [
        { channel: "联系人", value: researchText(customer!.contact) },
        { channel: "联系资料", value: researchText(customer!.documentContact) }
      ];
  const usefulContacts = contactRows.filter((item) => item.value !== "待核实");
  const candidate = candidates[0];
  const business = researchText(candidate?.business || lead?.remark || deals[0]?.product, "尚无明确业务资料");
  const facts = lead
    ? [
        { label: "主体", value: company },
        { label: "国家 / 地区", value: country },
        { label: "业务", value: business },
        { label: "来源", value: researchText(lead.source || lead.sourceChannel) },
        { label: "采购意向", value: researchText(lead.intent) },
        { label: "预估金额", value: lead.estimatedAmount > 0 ? `${lead.estimatedAmount.toLocaleString("en-US")} USD` : "待核实" }
      ]
    : [
        { label: "主体", value: company },
        { label: "国家 / 地区", value: country },
        { label: "业务", value: business },
        { label: "客户分级", value: customer!.grade || customerGradeFromHealth(customer!.health) },
        { label: "关联商机", value: `${deals.length} 个` },
        { label: "成交记录", value: deals.some((deal) => deal.stage === "成交") ? "有" : "无" }
      ];
  const risks = [] as Array<ReturnType<typeof backgroundResearchRisk>>;
  if (!sources.some((item) => /^https?:\/\//i.test(item.url))) {
    risks.push(backgroundResearchRisk("high", "企业身份", "缺少可访问的公开来源"));
  }
  if (!usefulContacts.some((item) => ["邮箱", "电话", "联系资料"].includes(item.channel))) {
    risks.push(backgroundResearchRisk("medium", "联系方式", "尚无可直接触达的联系方式"));
  }
  if (!activities.length) risks.push(backgroundResearchRisk("medium", "互动记录", "尚未形成有效互动记录"));
  if (customer && customer.health < 60) risks.push(backgroundResearchRisk("medium", "客户健康度", `当前人工评分 ${customer.health}`));
  if (!risks.length) risks.push(backgroundResearchRisk("low", "当前风险", "现有资料未发现明显冲突"));

  const score = Math.max(35, Math.min(94,
    35
    + Math.min(24, sources.length * 6)
    + Math.min(15, usefulContacts.length * 5)
    + (business === "尚无明确业务资料" ? 0 : 10)
    + (activities.length ? 8 : 0)
  ));
  let summary = `${company} 位于${country}，当前资料显示其业务与${business}相关。`;
  let verdict = score >= 78 ? "可优先推进" : score >= 60 ? "建议核实后推进" : "暂缓关键交易动作";
  let opportunities = [
    customer && deals.length ? `围绕现有 ${deals[0]!.product || "商机"} 继续确认采购节奏` : `确认 ${business} 的具体采购需求`,
    usefulContacts.length ? `通过${usefulContacts[0]!.channel}建立首次有效沟通` : "补齐采购联系人与直接联系方式"
  ];
  let nextAction = risks[0]?.level === "high" ? "先完成企业主体与官网核验" : "安排一次需求确认并记录采购时间表";
  let engine = "CRM 证据分析";

  const config = getAiConfig(user, "scoring");
  if (config?.enabled && config.apiKey) {
    const prompt = [
      "根据以下 CRM 事实与来源证据生成企业背调结论。只使用提供的数据，不得补充或猜测外部事实。",
      "只返回 JSON：{\"summary\":\"\",\"verdict\":\"\",\"opportunities\":[\"\"],\"risks\":[{\"level\":\"high|medium|low\",\"title\":\"\",\"detail\":\"\"}],\"nextAction\":\"\"}",
      JSON.stringify({ entityType, company, country, facts, contacts: usefulContacts, sources, activities: activities.slice(0, 6), deals: deals.slice(0, 5) })
    ].join("\n");
    try {
      const parsed = extractJsonObject(await callAiModel(config, prompt, 10000)) as Record<string, unknown>;
      if (typeof parsed.summary === "string" && parsed.summary.trim()) summary = parsed.summary.trim().slice(0, 600);
      if (typeof parsed.verdict === "string" && parsed.verdict.trim()) verdict = parsed.verdict.trim().slice(0, 80);
      if (Array.isArray(parsed.opportunities)) opportunities = parsed.opportunities.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 4);
      if (typeof parsed.nextAction === "string" && parsed.nextAction.trim()) nextAction = parsed.nextAction.trim().slice(0, 300);
      if (Array.isArray(parsed.risks)) {
        const aiRisks = parsed.risks.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const raw = item as Record<string, unknown>;
          const level = ["high", "medium", "low"].includes(String(raw.level)) ? String(raw.level) as "high" | "medium" | "low" : "medium";
          if (typeof raw.title !== "string" || typeof raw.detail !== "string") return [];
          return [backgroundResearchRisk(level, raw.title.slice(0, 80), raw.detail.slice(0, 300))];
        }).slice(0, 5);
        if (aiRisks.length) risks.splice(0, risks.length, ...aiRisks);
      }
      engine = config.name || config.model;
    } catch {
      engine = "CRM 证据分析";
    }
  }

  return {
    research: {
      id: `abr_${entityType}_${body.entityId}_${Date.now()}`,
      entityType,
      entityId: body.entityId,
      company,
      country,
      score,
      verdict,
      summary,
      facts,
      opportunities,
      risks,
      contacts: usefulContacts,
      sources,
      nextAction,
      engine,
      completedAt: new Date().toISOString()
    }
  };
}

app.post("/api/ai-background-research", requireAuth, asyncRoute(async (req, res) => {
  const body = backgroundResearchRequestSchema.parse(req.body);
  const result = await buildBackgroundResearch(req.user!, body);
  if (!result) {
    res.status(404).json({ message: body.entityType === "lead" ? "线索不存在或无权访问" : "客户不存在或无权访问" });
    return;
  }
  res.json(result);
}));

function blankCompanyProfile(teamId: string): CompanyProfile {
  return {
    teamId,
    companyName: "",
    website: "",
    productSummary: "",
    address: "",
    phone: "",
    email: "",
    updatedBy: "",
    updatedAt: ""
  };
}

function companyProfileForTeam(teamId: string) {
  return getStore().companyProfiles.find((item) => item.teamId === teamId)
    || blankCompanyProfile(teamId);
}

function canManageCompanyProfile(user: SessionUser) {
  return user.role === "admin" || user.role === "super_admin";
}

app.get("/api/company-profile", requireAuth, (req, res) => {
  res.json({
    profile: companyProfileForTeam(req.user!.teamId),
    canManage: canManageCompanyProfile(req.user!)
  });
});

app.put("/api/company-profile", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageCompanyProfile(req.user!)) {
    res.status(403).json({ message: "只有管理员可以维护公司资料" });
    return;
  }
  const body = z.object({
    companyName: z.string().trim().max(200).default(""),
    website: z.string().trim().max(300).default(""),
    productSummary: z.string().trim().max(2000).default(""),
    address: z.string().trim().max(1000).default(""),
    phone: z.string().trim().max(100).default(""),
    email: z.string().trim().max(180).default("")
  }).parse(req.body);
  const store = getStore();
  const current = store.companyProfiles.find((item) => item.teamId === req.user!.teamId);
  const profile: CompanyProfile = {
    teamId: req.user!.teamId,
    ...body,
    updatedBy: req.user!.id,
    updatedAt: new Date().toISOString()
  };
  if (current) Object.assign(current, profile);
  else store.companyProfiles.push(profile);
  await store.persist();
  res.json({ profile, canManage: true });
}));

function developmentEmailEntity(user: SessionUser, entityType: BackgroundResearchEntity, entityId: string) {
  const store = getStore();
  if (entityType === "lead") {
    const lead = store.leads.find((item) => item.id === entityId && canSeeOwner(user, item.ownerId, item.teamId));
    if (!lead) return null;
    return {
      entityType,
      lead,
      customer: undefined,
      company: lead.company,
      contactName: lead.contact || "there",
      email: lead.email || "",
      country: lead.country || "",
      context: lead.remark || `${lead.intent || ""} intent · ${lead.source || "CRM lead"}`
    };
  }
  const customer = store.customers.find((item) => item.id === entityId && canSeeOwner(user, item.ownerId, item.teamId));
  if (!customer) return null;
  const email = `${customer.documentContact || ""} ${customer.contact || ""}`.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const deals = store.deals.filter((deal) => deal.customerId === customer.id);
  return {
    entityType,
    lead: undefined,
    customer,
    company: customer.company,
    contactName: customer.contact || "there",
    email,
    country: customer.country || "",
    context: deals[0]?.product || customer.defaultIncoterm || "existing business relationship"
  };
}

function developmentEmailReadiness(user: ReturnType<typeof getStore>["users"][number], profile: CompanyProfile) {
  const personalMissing = [
    !user.outboundEmail ? "发件邮箱" : "",
    !user.emailSenderName ? "发件人名称" : "",
    !user.emailSignature ? "邮件签名" : "",
    !user.smtpHost ? "SMTP服务器" : "",
    !user.smtpUser ? "SMTP账号" : "",
    !user.smtpPassword ? "SMTP授权码" : ""
  ].filter(Boolean);
  const companyMissing = [
    !profile.companyName ? "公司名称" : "",
    !profile.productSummary ? "主营产品" : "",
    !profile.website ? "公司官网" : ""
  ].filter(Boolean);
  return {
    personalReady: personalMissing.length === 0,
    companyReady: companyMissing.length === 0,
    personalMissing,
    companyMissing
  };
}

function developmentEmailEnglishContext(value: string) {
  const text = value.trim();
  return text && !/[\u3400-\u9fff]/u.test(text)
    ? text
    : "your sourcing and product development needs";
}

function developmentEmailMarket(value: string) {
  const markets: Record<string, string> = {
    中国: "China", 德国: "Germany", 瑞典: "Sweden", 美国: "the United States",
    日本: "Japan", 阿联酋: "the UAE", 法国: "France", 英国: "the United Kingdom"
  };
  return markets[value] || (value && !/[\u3400-\u9fff]/u.test(value) ? value : "your market");
}

app.post("/api/development-email/draft", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    entityType: z.enum(["lead", "customer"]),
    entityId: z.string().trim().min(1).max(120),
    tone: z.enum(["professional", "concise", "warm"]).default("professional"),
    requireAi: z.boolean().default(false)
  }).parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  const entity = developmentEmailEntity(req.user!, body.entityType, body.entityId);
  if (!user || !entity) {
    res.status(404).json({ message: "收件对象不存在或无权访问" });
    return;
  }
  const companyProfile = companyProfileForTeam(req.user!.teamId);
  const readiness = developmentEmailReadiness(user, companyProfile);
  const config = getAiConfig(req.user!, "emailDraft");
  const aiReady = Boolean(config?.enabled && config.apiKey);
  if (body.requireAi && !aiReady) {
    res.status(400).json({ message: "请先在 AI 配置中启用开发信模型并填写 API Key" });
    return;
  }
  const senderName = user.emailSenderName || user.name;
  const senderCompany = companyProfile.companyName || "[Company name]";
  const productSummary = companyProfile.productSummary || "[Products and services]";
  const websiteLine = companyProfile.website ? `\nWebsite: ${companyProfile.website}` : "";
  const signature = user.emailSignature?.trim() || `Best regards,\n${senderName}`;
  const outreachContext = developmentEmailEnglishContext(entity.context);
  const outreachMarket = developmentEmailMarket(entity.country);
  let subject = `Potential cooperation with ${entity.company}`;
  let content = [
    `Dear ${entity.contactName},`,
    "",
    `I am ${senderName} from ${senderCompany}. We specialize in ${productSummary}.`,
    "",
    `I am reaching out to ${entity.company} regarding ${outreachContext}. I would like to explore whether our products could support your current sourcing plans in ${outreachMarket}.`,
    "",
    "Would you be available for a brief conversation this week?",
    "",
    signature + websiteLine
  ].join("\n");
  let engine = "基础模板";
  let aiGenerated = false;
  let aiError = "";
  if (aiReady && config) {
    const prompt = [
      "Write one concise B2B cold outreach email in English using only the supplied facts.",
      "Do not invent certifications, customers, prices, capabilities or contact history.",
      "Return JSON only: {\"subject\":\"\",\"body\":\"\"}.",
      JSON.stringify({
        tone: body.tone,
        recipient: { company: entity.company, contact: entity.contactName, country: entity.country, context: entity.context },
        sender: { name: senderName, company: companyProfile.companyName, products: companyProfile.productSummary, website: companyProfile.website },
        signature
      })
    ].join("\n");
    try {
      const parsed = extractJsonObject(await callAiModel(config, prompt, 10000)) as Record<string, unknown>;
      if (typeof parsed.subject === "string" && parsed.subject.trim()) subject = parsed.subject.trim().slice(0, 160);
      if (typeof parsed.body === "string" && parsed.body.trim()) content = parsed.body.trim().slice(0, 6000);
      engine = config.name || config.model;
      aiGenerated = true;
    } catch (error) {
      aiError = error instanceof Error ? error.message : "AI 撰写失败";
      if (body.requireAi) {
        res.status(400).json({ message: aiError });
        return;
      }
    }
  }
  res.json({
    draft: {
      entityType: body.entityType,
      entityId: body.entityId,
      recipientCompany: entity.company,
      recipientName: entity.contactName,
      to: entity.email,
      subject,
      body: content,
      from: user.outboundEmail || "",
      senderName,
      engine
    },
    readiness: {
      ...readiness,
      aiReady,
      aiGenerated,
      aiConfigName: config?.name || config?.model || "",
      aiError
    },
    companyProfile
  });
}));

app.post("/api/development-email/send", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    entityType: z.enum(["lead", "customer"]),
    entityId: z.string().trim().min(1).max(120),
    to: z.string().trim().email(),
    subject: z.string().trim().min(1).max(160),
    body: z.string().trim().min(10).max(6000),
    nextFollowAt: z.string().trim().max(100).default("")
  }).parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  const entity = developmentEmailEntity(req.user!, body.entityType, body.entityId);
  if (!user || !entity) {
    res.status(404).json({ message: "收件对象不存在或无权访问" });
    return;
  }
  const readiness = developmentEmailReadiness(user, companyProfileForTeam(req.user!.teamId));
  if (!readiness.companyReady) {
    res.status(400).json({ message: "公司资料未完整，请联系管理员维护公司名称、主营产品和官网" });
    return;
  }
  let outreachEligibility;
  try {
    await store.reloadProspectQualificationTeam?.(req.user!.teamId);
    outreachEligibility = assertCrmOutreachEligible(store, {
      target: entity.lead
        ? { entityType: "lead", entity: entity.lead }
        : { entityType: "customer", entity: entity.customer! },
      actorId: req.user!.id,
      channel: "email",
      recipient: body.to
    });
  } catch (error) {
    if (sendProspectQualificationError(res, error)) return;
    throw error;
  }
  let mailInfo: Awaited<ReturnType<typeof sendOutboundEmail>>;
  try {
    mailInfo = await sendOutboundEmail(user, { to: outreachEligibility.recipient, subject: body.subject, body: body.body });
  } catch (error) {
    res.status(400).json({ message: outboundEmailError(error, user) });
    return;
  }
  const sentAt = new Date().toISOString();
  user.lastDevelopmentEmailAt = sentAt;
  user.lastDevelopmentEmailTo = outreachEligibility.recipient;
  user.lastDevelopmentEmailSubject = body.subject;
  if (entity.lead) {
    store.leadActivities.unshift({
      id: `la_${Date.now()}`,
      leadId: entity.lead.id,
      type: "email",
      content: `开发信发送：${body.subject}`,
      operatorId: req.user!.id,
      nextFollowAt: body.nextFollowAt,
      createdAt: sentAt
    });
    entity.lead.lastActivityAt = "刚刚";
    if (body.nextFollowAt) entity.lead.nextFollowAt = body.nextFollowAt;
  } else if (entity.customer) {
    store.customerActivities.unshift({
      id: `ca_${Date.now()}`,
      customerId: entity.customer.id,
      type: "email",
      content: `开发信发送：${body.subject}`,
      operatorId: req.user!.id,
      nextReminder: body.nextFollowAt,
      createdAt: sentAt
    });
    if (body.nextFollowAt) entity.customer.nextReminder = body.nextFollowAt;
  }
  await store.persist();
  res.json({
    sent: { to: outreachEligibility.recipient, subject: body.subject, sentAt, messageId: mailInfo.messageId, simulated: ["test", "e2e"].includes(process.env.NODE_ENV || "") },
    user: accountUser(user)
  });
}));

app.post("/api/customers/:id/activities", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    type: z.enum(["call", "email", "whatsapp", "wechat", "meeting", "note"]),
    content: z.string().trim().min(1).max(2000),
    nextReminder: z.string().trim().max(100).optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const customer = findWritableCustomer(req.user!, req.params.id, res);
  if (!customer) return;
  const activity = {
    id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    customerId: customer.id,
    type: body.type,
    content: body.content,
    operatorId: req.user!.id,
    nextReminder: body.nextReminder,
    createdAt: new Date().toISOString()
  };
  store.customerActivities.unshift(activity);
  if (body.nextReminder) customer.nextReminder = body.nextReminder;
  await store.persist();
  res.json({ activity, customer: customerWithPipeline(customer, req.user!) });
}));

app.get("/api/customers/:id/intelligence", requireAuth, (req, res) => {
  const store = getStore();
  const customer = store.customers.find((item) =>
    item.id === req.params.id
    && canSeeOwner(req.user!, item.ownerId, item.teamId)
  );
  if (!customer) {
    res.status(404).json({ message: "客户不存在或无权访问" });
    return;
  }
  const suggestions = store.customerIntelligenceSuggestions
    .filter((item) =>
      item.teamId === customer.teamId
      && item.ownerId === customer.ownerId
      && item.customerId === customer.id
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  res.json({ suggestions });
});

app.post("/api/customer-intelligence/:id/accept", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    selectedFields: z.array(z.enum([
      "company",
      "country",
      "contact",
      "documentContact"
    ])).max(4).default([])
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const suggestion = store.customerIntelligenceSuggestions.find((item) =>
    item.id === req.params.id
    && item.teamId === req.user!.teamId
  );
  if (suggestion && !findWritableCustomer(req.user!, suggestion.customerId, res)) return;
  try {
    const result = acceptCustomerIntelligence(store, {
      suggestionId: req.params.id,
      teamId: req.user!.teamId,
      ownerId: req.user!.id,
      selectedFields: body.selectedFields as CustomerIntelligenceFieldKey[]
    });
    await store.persist();
    res.json({
      suggestion: result.suggestion,
      customer: customerWithPipeline(result.customer, req.user!)
    });
  } catch (error) {
    res.status(400).json({
      message: error instanceof Error ? error.message : "采纳客户情报失败"
    });
  }
}));

app.post("/api/customer-intelligence/:id/reject", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    reason: z.string().trim().max(500).optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const suggestion = store.customerIntelligenceSuggestions.find((item) =>
    item.id === req.params.id
    && item.teamId === req.user!.teamId
  );
  if (suggestion && !findWritableCustomer(req.user!, suggestion.customerId, res)) return;
  try {
    const result = rejectCustomerIntelligence(store, {
      suggestionId: req.params.id,
      teamId: req.user!.teamId,
      ownerId: req.user!.id,
      reason: body.reason
    });
    await store.persist();
    res.json({
      suggestion: result.suggestion,
      customer: customerWithPipeline(result.customer, req.user!)
    });
  } catch (error) {
    res.status(400).json({
      message: error instanceof Error ? error.message : "忽略客户情报失败"
    });
  }
}));

app.get("/api/leads", requireAuth, (req, res) => {
  const { leads } = getStore();
  const trash = req.query.trash === "true";
  const scoped = leads.filter((lead) => canSeeOwner(req.user!, lead.ownerId, lead.teamId) && (trash ? Boolean(lead.deletedAt) : !lead.deletedAt));
  res.json({ leads: scoped });
});

app.get("/api/leads/:id", requireAuth, (req, res) => {
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  const activities = store.leadActivities
    .filter((activity) => activity.leadId === lead.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const sourceEvents = store.leadSourceEvents
    .filter((event) => event.leadId === lead.id && canSeeOwner(req.user!, event.ownerId, event.teamId))
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  const candidate = store.websiteOpportunities.find((item) =>
    item.leadId === lead.id
    && item.teamId === lead.teamId
    && item.ownerId === lead.ownerId
  );
  res.json({
    lead,
    activities,
    sourceEvents,
    procurement: candidate
      ? {
        prospectCandidateId: candidate.id,
        ...procurementContextForCandidate(candidate)
      }
      : { signals: [], recommendations: [] }
  });
});

app.post("/api/leads", requireAuth, asyncRoute(async (req, res) => {
  const body = leadWritableSchema.parse(req.body);
  const store = getStore();
  const { lead, sourceEvent, duplicate } = createLeadFromSource(req.user!, body);
  await store.persist();
  res.json({ lead, sourceEvent, duplicate });
}));

app.post("/api/leads/ingest", requireAuth, asyncRoute(async (req, res) => {
  const schema = leadWritableSchema.extend({
    occurredAt: z.string().datetime().optional(),
    rawPayload: z.unknown().optional()
  });
  const body = schema.parse(req.body);
  const result = createLeadFromSource(req.user!, body);
  await getStore().persist();
  res.status(result.duplicate ? 200 : 201).json(result);
}));

app.patch("/api/leads/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = leadWritableSchema.partial().extend({
    status: z.enum(["new", "following", "converted", "invalid"]).optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  const previousStage = lead.stage;
  Object.assign(lead, body);
  lead.lastActivityAt = "刚刚";
  if (body.stage && body.stage !== previousStage) {
    store.leadActivities.unshift({
      id: `la_${Date.now()}`,
      leadId: lead.id,
      type: "stage",
      content: `阶段变更：${previousStage} → ${body.stage}`,
      operatorId: req.user!.id,
      nextFollowAt: "",
      createdAt: new Date().toISOString()
    });
  }
  await store.persist();
  res.json({ lead });
}));

app.delete("/api/leads/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ reason: z.string().optional().default("") });
  const body = schema.parse(req.body || {});
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  if (lead.convertedCustomerId) {
    res.status(400).json({ message: "已转客户的线索必须保留来源追溯，不能移入垃圾箱" });
    return;
  }
  if (lead.deletedAt) {
    res.status(400).json({ message: "线索已在垃圾箱中" });
    return;
  }
  const now = new Date().toISOString();
  const purgeAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  lead.statusBeforeDelete = lead.status;
  lead.deletedAt = now;
  lead.deletedReason = body.reason || "暂时无效或不适合继续跟进";
  lead.deletedBy = req.user!.id;
  lead.purgeAt = purgeAt;
  lead.status = "invalid";
  lead.lastActivityAt = "刚刚";
  store.leadActivities.unshift({
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: "system",
    content: `移入垃圾箱：${lead.deletedReason}`,
    operatorId: req.user!.id,
    nextFollowAt: "",
    createdAt: now
  });
  await store.persist();
  res.json({ lead });
}));

app.post("/api/leads/:id/restore", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  if (!lead.deletedAt) {
    res.status(400).json({ message: "线索不在垃圾箱中" });
    return;
  }
  const now = new Date().toISOString();
  lead.deletedAt = "";
  lead.deletedReason = "";
  lead.deletedBy = "";
  lead.purgeAt = "";
  lead.status = lead.statusBeforeDelete || "following";
  lead.statusBeforeDelete = undefined;
  lead.lastActivityAt = "刚刚";
  store.leadActivities.unshift({
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: "system",
    content: "从垃圾箱恢复线索",
    operatorId: req.user!.id,
    nextFollowAt: "",
    createdAt: now
  });
  await store.persist();
  res.json({ lead });
}));

app.delete("/api/leads/:id/permanent", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  if (!lead.deletedAt) {
    res.status(400).json({ message: "只有垃圾箱中的线索可以永久删除" });
    return;
  }
  if (lead.convertedCustomerId) {
    res.status(400).json({ message: "已转客户的线索必须保留来源追溯，不能永久删除" });
    return;
  }
  const sourceEventsDeleted = store.leadSourceEvents.filter((item) => item.leadId === lead.id).length;
  store.leads = store.leads.filter((item) => item.id !== lead.id);
  store.leadActivities = store.leadActivities.filter((item) => item.leadId !== lead.id);
  store.leadSourceEvents = store.leadSourceEvents.filter((item) => item.leadId !== lead.id);
  await store.persist();
  res.json({ ok: true, id: lead.id, sourceEventsDeleted });
}));

app.post("/api/leads/:id/activities", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    type: z.enum(["call", "wechat", "whatsapp", "linkedin", "email", "meeting", "note"]).default("note"),
    content: z.string().min(1),
    nextFollowAt: z.string().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  const now = new Date().toISOString();
  const activity = {
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: body.type,
    content: body.content,
    operatorId: req.user!.id,
    nextFollowAt: body.nextFollowAt,
    createdAt: now
  };
  store.leadActivities.unshift(activity);
  lead.lastActivityAt = "刚刚";
  if (body.nextFollowAt) lead.nextFollowAt = body.nextFollowAt;
  if (lead.status === "new") lead.status = "following";
  await store.persist();
  res.json({ activity, lead });
}));

app.post("/api/leads/:id/social-touch", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    channel: z.enum(["call", "wechat", "whatsapp", "linkedin"]),
    message: z.string().min(1).max(1200),
    nextFollowAt: z.string().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId) || lead.deletedAt) {
    res.status(404).json({ message: "线索不存在、已删除或无权访问" });
    return;
  }
  const channelText: Record<typeof body.channel, string> = { call: "电话", wechat: "微信", whatsapp: "WhatsApp", linkedin: "LinkedIn" };
  const now = new Date().toISOString();
  const activity = {
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: body.channel,
    content: `${channelText[body.channel]}触达：${body.message}`,
    operatorId: req.user!.id,
    nextFollowAt: body.nextFollowAt,
    createdAt: now
  };
  store.leadActivities.unshift(activity);
  lead.lastActivityAt = "刚刚";
  if (body.nextFollowAt) lead.nextFollowAt = body.nextFollowAt;
  if (lead.status === "new") lead.status = "following";
  await store.persist();
  res.json({ activity, lead });
}));

app.post("/api/leads/:id/send-email", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(160),
    body: z.string().min(10).max(3000),
    nextFollowAt: z.string().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId) || lead.deletedAt) {
    res.status(404).json({ message: "线索不存在、已删除或无权访问" });
    return;
  }
  let outreachEligibility;
  try {
    await store.reloadProspectQualificationTeam?.(req.user!.teamId);
    outreachEligibility = assertCrmOutreachEligible(store, {
      target: { entityType: "lead", entity: lead },
      actorId: req.user!.id,
      channel: "email",
      recipient: body.to
    });
  } catch (error) {
    if (sendProspectQualificationError(res, error)) return;
    throw error;
  }
  let mailInfo: Awaited<ReturnType<typeof sendOutboundEmail>>;
  try {
    mailInfo = await sendOutboundEmail(user, { to: outreachEligibility.recipient, subject: body.subject, body: body.body });
  } catch (error) {
    res.status(400).json({ message: outboundEmailError(error, user) });
    return;
  }
  const sentAt = new Date().toISOString();
  user.lastDevelopmentEmailAt = sentAt;
  user.lastDevelopmentEmailTo = outreachEligibility.recipient;
  user.lastDevelopmentEmailSubject = body.subject;
  const activity = {
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: "email" as const,
    content: `邮件发送：${body.subject}`,
    operatorId: req.user!.id,
    nextFollowAt: body.nextFollowAt,
    createdAt: sentAt
  };
  store.leadActivities.unshift(activity);
  lead.lastActivityAt = "刚刚";
  if (body.nextFollowAt) lead.nextFollowAt = body.nextFollowAt;
  if (lead.status === "new") lead.status = "following";
  await store.persist();
  res.json({
    sent: {
      id: `mail_${Date.now()}`,
      status: "sent",
      simulated: process.env.NODE_ENV === "test",
      messageId: mailInfo.messageId,
      from: user.outboundEmail,
      senderName: user.emailSenderName || user.name,
      to: outreachEligibility.recipient,
      company: lead.company,
      subject: body.subject,
      sentAt
    },
    activity,
    lead,
    user: accountUser(user)
  });
}));

app.get("/api/leads/:id/conversion-preview", requireAuth, (req, res) => {
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId) || lead.deletedAt) {
    res.status(404).json({ message: "线索不存在、已删除或无权访问" });
    return;
  }
  res.json({ lead, customerMatches: findCustomerMatches(req.user!, lead) });
});

app.post("/api/leads/:id/convert", requireAuth, asyncRoute(async (req, res) => {
  const conversionSchema = z.object({
    customerMode: z.enum(["create", "existing"]).optional().default("create"),
    customerId: z.string().optional().default(""),
    createDeal: z.boolean().optional().default(false),
    deal: z.object({
      title: z.string().max(200).optional().default(""),
      product: z.string().max(200).optional().default(""),
      amount: z.coerce.number().nonnegative().optional(),
      quantity: z.coerce.number().int().nonnegative().optional().default(0),
      unitPrice: z.coerce.number().nonnegative().optional().default(0),
      nextAction: z.string().max(200).optional().default("")
    }).optional().default({})
  });
  const body = conversionSchema.parse(req.body || {});
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId) || lead.deletedAt) {
    res.status(404).json({ message: "线索不存在、已删除或无权访问" });
    return;
  }
  const acquisitionSource = store.leadSourceEvents.find((item) =>
    item.leadId === lead.id
    && item.teamId === lead.teamId
    && item.ownerId === lead.ownerId
    && item.channel === PROSPECT_LEAD_SOURCE_CHANNEL
    && item.externalId
  );
  if (lead.sourceChannel === PROSPECT_LEAD_SOURCE_CHANNEL
    || acquisitionSource) {
    res.status(409).json({
      message: "智能获客线索必须通过候选客户转客户接口确认入库",
      errorCode: "PROSPECT_CUSTOMER_CONVERSION_REQUIRED"
    });
    return;
  }
  if (lead.convertedCustomerId) {
    const customer = store.customers.find((item) => item.id === lead.convertedCustomerId);
    const deal = lead.convertedDealId ? store.deals.find((item) => item.id === lead.convertedDealId) : undefined;
    res.json({ lead, customer: customer ? customerWithPipeline(customer, req.user!) : null, deal, duplicate: true });
    return;
  }
  const now = new Date().toISOString();
  let customer: Customer | undefined;
  if (body.customerMode === "existing") {
    customer = findWritableCustomer(req.user!, body.customerId, res) || undefined;
    if (!customer) return;
  } else {
    customer = {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      company: lead.company,
      country: lead.country || "未知",
      contact: lead.contact || "待维护",
      ownerId: lead.ownerId,
      teamId: lead.teamId,
      stage: "询盘",
      amount: 0,
      health: 72,
      grade: "C",
      nextReminder: lead.nextFollowAt || "明天 10:00",
      wecomBound: false,
      billingName: lead.company,
      billingAddress: "",
      documentContact: lead.email ? `${lead.contact || "待维护"} / ${lead.email}` : lead.contact || "",
      defaultPortDischarge: "",
      defaultIncoterm: "",
      defaultPaymentTerm: ""
    };
    store.customers.unshift(customer);
  }

  let deal: Deal | undefined;
  if (body.createDeal) {
    const nowIso = new Date().toISOString();
    const nextActionAt = /^\d{4}-\d{2}-\d{2}/.test(lead.nextFollowAt) ? lead.nextFollowAt.slice(0, 10) : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    deal = {
      id: `d_lead_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      customerId: customer.id,
      title: body.deal.title.trim() || `${lead.company} 采购需求`,
      stage: "询盘",
      product: body.deal.product.trim(),
      quantity: body.deal.quantity,
      unitPrice: body.deal.unitPrice,
      amount: typeof body.deal.amount === "number" ? body.deal.amount : (lead.estimatedAmount || body.deal.quantity * body.deal.unitPrice),
      currency: "USD",
      amountType: "estimate",
      ownerId: customer.ownerId,
      teamId: customer.teamId,
      nextAction: body.deal.nextAction.trim() || "确认产品、数量与报价要求",
      nextActionAt,
      expectedCloseAt: "",
      stageChangedAt: nowIso
    };
    store.deals.unshift(deal);
    createDealEvent({
      dealId: deal.id,
      type: "created",
      content: `由线索 ${lead.company} 确认入客户并创建商机`,
      operatorId: req.user!.id,
      toStage: "询盘",
      nextAction: deal.nextAction,
      nextActionAt: deal.nextActionAt,
      createdAt: nowIso
    });
  }
  lead.status = "converted";
  lead.stage = "已转化";
  lead.convertedCustomerId = customer.id;
  lead.convertedDealId = deal?.id || "";
  lead.lastActivityAt = "刚刚";
  store.leadActivities.unshift({
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: "system",
    content: deal ? `确认并入库：关联客户 ${customer.company}，创建商机 ${deal.title}` : `确认并入库：关联客户 ${customer.company}`,
    operatorId: req.user!.id,
    nextFollowAt: "",
    createdAt: now
  });
  await store.persist();
  res.json({ lead, customer: customerWithPipeline(customer, req.user!), deal, duplicate: false });
}));

// ---------------------------------------------------------------------------
// WhatsApp (阶段0:手动录入对话 + 手动翻译)。仅官方合规路径,不接非官方库。
// ---------------------------------------------------------------------------
function findWhatsAppCustomer(user: SessionUser, customerId: string) {
  const store = getStore();
  const customer = store.customers.find((item) => item.id === customerId);
  if (!customer
    || isPublicCustomer(customer)
    || customer.ownerId !== user.id) return null;
  return customer;
}

function canManageWhatsAppBinding(user: SessionUser, customer: Customer) {
  return customer.ownerId === user.id;
}

function publicWhatsAppBinding(binding: ReturnType<typeof getStore>["whatsappBindings"][number] | null) {
  if (!binding) return null;
  return {
    id: binding.id,
    customerId: binding.customerId,
    phoneNumber: binding.phoneNumber,
    waProfileName: binding.waProfileName,
    lastMessageAt: binding.lastMessageAt,
    unreadCount: binding.unreadCount,
    createdAt: binding.createdAt,
    bindingMode: binding.bindingMode,
    twilioPhoneNumber: binding.twilioPhoneNumber,
    connectionStatus: binding.connectionStatus,
    lastConnectedAt: binding.lastConnectedAt
  };
}

/** 简易中文检测:含 CJK 字符即视为中文，无需翻译。 */
function isChineseText(text: string) {
  return /[一-鿿]/.test(text);
}

async function translateToChinese(user: SessionUser, text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || isChineseText(trimmed)) return "";
  const config = getAiConfig(user);
  if (!config?.enabled || !config.apiKey) {
    // 无可用模型时返回空，前端会提示“未配置翻译模型”，不阻断录入。
    return "";
  }
  const prompt = `你是专业外贸翻译。请把下面这段客户消息翻译成简体中文，只返回译文本身，不要解释、不要引号：\n\n${trimmed}`;
  try {
    const result = await callAiModel(config, prompt, 4000);
    return result.trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

// 聊天中心:所有有绑定/消息的客户会话概览
app.get("/api/whatsapp/threads", requireAuth, (req, res) => {
  const store = getStore();
  const scopedCustomerIds = new Set(
    getStore().customers.filter((c) => !isPublicCustomer(c) && c.ownerId === req.user!.id).map((c) => c.id)
  );
  const threads = store.customers
    .filter((c) => scopedCustomerIds.has(c.id))
    .map((customer) => {
      const binding = store.whatsappBindings.find((b) => b.customerId === customer.id);
      const messages = store.whatsappMessages.filter((m) => m.customerId === customer.id);
      const last = messages[messages.length - 1];
      if (!binding && messages.length === 0) return null;
      return {
        customerId: customer.id,
        company: customer.company,
        country: customer.country,
        contact: customer.contact,
        phoneNumber: binding?.phoneNumber || "",
        waProfileName: binding?.waProfileName || "",
        unreadCount: binding?.unreadCount || 0,
        lastMessage: last ? (last.content || "") : "",
        lastMessageAt: last ? last.createdAt : (binding?.lastMessageAt || ""),
        messageCount: messages.length,
        bindingMode: binding?.bindingMode || "manual",
        connectionStatus: binding?.connectionStatus || "disconnected",
        canManage: canManageWhatsAppBinding(req.user!, customer)
      };
    })
    .filter(Boolean)
    .sort((a, b) => (String((b as any).lastMessageAt) < String((a as any).lastMessageAt) ? -1 : 1));
  res.json({ threads });
});

// 某客户的对话记录 + 绑定信息
app.get("/api/whatsapp/customers/:customerId/messages", requireAuth, (req, res) => {
  const customer = findWhatsAppCustomer(req.user!, req.params.customerId);
  if (!customer) {
    res.status(404).json({ message: "客户不存在或无权访问" });
    return;
  }
  const store = getStore();
  const binding = store.whatsappBindings.find((b) => b.customerId === customer.id) || null;
  const messages = store.whatsappMessages
    .filter((m) => m.customerId === customer.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  res.json({
    binding: publicWhatsAppBinding(binding),
    messages,
    canManage: canManageWhatsAppBinding(req.user!, customer),
    customer: { id: customer.id, company: customer.company, country: customer.country, contact: customer.contact }
  });
});

// 绑定/更新 WhatsApp 手机号
app.post("/api/whatsapp/customers/:customerId/binding", requireAuth, asyncRoute(async (req, res) => {
  const customer = findWhatsAppCustomer(req.user!, req.params.customerId);
  if (!customer) {
    res.status(404).json({ message: "客户不存在或无权访问" });
    return;
  }
  if (!canManageWhatsAppBinding(req.user!, customer)) {
    res.status(403).json({ message: "只有客户负责人可以修改 WhatsApp 绑定" });
    return;
  }
  const schema = z.object({
    phoneNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "请输入包含国家码的 E.164 号码"),
    waProfileName: z.string().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const now = new Date().toISOString();
  let binding = store.whatsappBindings.find((b) => b.customerId === customer.id);
  if (binding) {
    binding.phoneNumber = body.phoneNumber;
    binding.waProfileName = body.waProfileName || binding.waProfileName;
    binding.bindingMode = "manual";
    binding.connectionStatus = "disconnected";
  } else {
    binding = {
      id: `wab_${Date.now()}`,
      customerId: customer.id,
      phoneNumber: body.phoneNumber,
      waProfileName: body.waProfileName || "",
      lastMessageAt: "",
      unreadCount: 0,
      createdAt: now,
      bindingMode: "manual",
      connectionStatus: "disconnected"
    };
    store.whatsappBindings.push(binding);
  }
  customer.whatsapp = body.phoneNumber;
  await store.persist();
  res.json({ binding: publicWhatsAppBinding(binding) });
}));

// 手动录入一条对话(收/发),非中文自动翻译
app.post("/api/whatsapp/customers/:customerId/messages", requireAuth, asyncRoute(async (req, res) => {
  const customer = findWhatsAppCustomer(req.user!, req.params.customerId);
  if (!customer) {
    res.status(404).json({ message: "客户不存在或无权访问" });
    return;
  }
  if (!canManageWhatsAppBinding(req.user!, customer)) {
    res.status(403).json({ message: "只有客户负责人可以发起 WhatsApp 绑定" });
    return;
  }
  const schema = z.object({
    direction: z.enum(["inbound", "outbound"]),
    content: z.string().min(1).max(4000),
    mediaUrl: z.string().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const now = new Date().toISOString();
  const binding = store.whatsappBindings.find((b) => b.customerId === customer.id);
  let status = body.direction === "outbound" ? "recorded" : "read";
  let deliveryMode: "manual" | "web-scan" | "twilio-api" = binding?.bindingMode || "manual";
  let delivered = deliveryMode === "manual";

  if (body.direction === "outbound" && deliveryMode !== "manual") {
    try {
      await store.reloadProspectQualificationTeam?.(req.user!.teamId);
      assertCrmOutreachEligible(store, {
        target: { entityType: "customer", entity: customer },
        actorId: req.user!.id,
        channel: "whatsapp",
        recipient: binding?.phoneNumber || customer.whatsapp || ""
      });
    } catch (error) {
      if (sendProspectQualificationError(res, error)) return;
      throw error;
    }
  }

  if (body.direction === "outbound" && binding?.bindingMode === "twilio-api") {
    try {
      delivered = Boolean(binding.twilioPhoneNumber && binding.phoneNumber)
        && await twilioManager.sendMessage(binding.twilioPhoneNumber || "", binding.phoneNumber, body.content);
    } catch {
      delivered = false;
    }
    status = delivered ? "sent" : "failed";
  } else if (body.direction === "outbound" && binding?.bindingMode === "web-scan") {
    try {
      delivered = binding.connectionStatus === "connected" && Boolean(binding.sessionData && binding.phoneNumber)
        && await whatsappWebManager.sendMessage(binding.sessionData || "", binding.phoneNumber, body.content);
    } catch {
      delivered = false;
    }
    status = delivered ? "sent" : "failed";
  }

  const contentTranslated = await translateToChinese(req.user!, body.content);
  const message = {
    id: `wam_${Date.now()}`,
    customerId: customer.id,
    direction: body.direction,
    content: body.content,
    contentTranslated,
    mediaUrl: body.mediaUrl || "",
    status,
    waMessageId: "",
    createdAt: now
  };
  store.whatsappMessages.push(message);
  // 同步绑定的最近时间
  if (binding) binding.lastMessageAt = now;
  await store.persist();
  res.json({ message, delivery: { mode: deliveryMode, delivered } });
}));

app.post("/api/whatsapp/customers/:customerId/read", requireAuth, asyncRoute(async (req, res) => {
  const customer = findWhatsAppCustomer(req.user!, req.params.customerId);
  if (!customer) {
    res.status(404).json({ message: "客户不存在或无权访问" });
    return;
  }
  const binding = getStore().whatsappBindings.find((item) => item.customerId === customer.id);
  if (binding?.unreadCount) {
    binding.unreadCount = 0;
    await getStore().persist();
  }
  res.json({ ok: true });
}));

// 对已有消息重新翻译(用户点击“翻译”按钮)
app.post("/api/whatsapp/messages/:id/translate", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const message = store.whatsappMessages.find((m) => m.id === req.params.id);
  if (!message) {
    res.status(404).json({ message: "消息不存在" });
    return;
  }
  const customer = findWhatsAppCustomer(req.user!, message.customerId);
  if (!customer) {
    res.status(403).json({ message: "无权访问该消息" });
    return;
  }
  if (isChineseText(message.content)) {
    res.json({ message, skipped: true, reason: "中文无需翻译" });
    return;
  }
  const translated = await translateToChinese(req.user!, message.content);
  if (!translated) {
    res.status(400).json({ message: "翻译失败，请检查是否已配置并启用 AI 模型" });
    return;
  }
  message.contentTranslated = translated;
  await store.persist();
  res.json({ message });
}));

// 删除一条对话记录
app.delete("/api/whatsapp/messages/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const message = store.whatsappMessages.find((m) => m.id === req.params.id);
  if (!message) {
    res.status(404).json({ message: "消息不存在" });
    return;
  }
  const customer = findWhatsAppCustomer(req.user!, message.customerId);
  if (!customer) {
    res.status(403).json({ message: "无权访问该消息" });
    return;
  }
  store.whatsappMessages = store.whatsappMessages.filter((m) => m.id !== message.id);
  await store.persist();
  res.json({ ok: true, id: message.id });
}));

// ---------------------------------------------------------------------------
// WhatsApp 绑定模式扩展 (Web扫码 + Twilio API)
// ---------------------------------------------------------------------------
import { whatsappWebManager, twilioManager } from "./whatsapp-service.js";

// 初始化 Twilio (从环境变量读取配置)
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || "";
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || "";
const twilioWebhookUrl = process.env.TWILIO_WEBHOOK_URL || "";
const webScanEnabled = process.env.NODE_ENV !== "production" && process.env.WHATSAPP_ENABLE_WEB_SCAN === "true";

if (twilioAccountSid && twilioAuthToken) {
  twilioManager.initialize(twilioAccountSid, twilioAuthToken, twilioWebhookUrl);
  console.log("✅ Twilio WhatsApp initialized");
}

// 获取可用的绑定模式
app.get("/api/whatsapp/binding-modes", requireAuth, (req, res) => {
  const modes = {
    webScan: { available: webScanEnabled, name: "测试扫码", risk: "仅限非生产测试" },
    twilioApi: { available: twilioManager.isInitialized(), name: "WhatsApp Business API", risk: "官方通道" },
    manual: { available: true, name: "人工同步", risk: "不调用外部接口" }
  };
  res.json({ modes });
});

// 开始 Web 扫码绑定流程
app.post("/api/whatsapp/binding/web-scan/start", requireAuth, asyncRoute(async (req, res) => {
  if (!webScanEnabled) {
    res.status(403).json({ message: "测试扫码通道未启用" });
    return;
  }
  const schema = z.object({
    customerId: z.string()
  });
  const body = schema.parse(req.body);
  const customer = findWhatsAppCustomer(req.user!, body.customerId);
  if (!customer) {
    res.status(404).json({ message: "客户不存在或无权访问" });
    return;
  }
  if (!canManageWhatsAppBinding(req.user!, customer)) {
    res.status(403).json({ message: "只有客户负责人可以修改 WhatsApp 绑定" });
    return;
  }

  try {
    // 创建新的 WhatsApp Web 客户端
    const clientId = await whatsappWebManager.createClient(req.user!.id);

    // 存储绑定信息（状态为 qr-pending）
    const store = getStore();
    let binding = store.whatsappBindings.find((b) => b.customerId === customer.id);

    if (!binding) {
      binding = {
        id: `wab_${Date.now()}`,
        customerId: customer.id,
        phoneNumber: "",
        waProfileName: "",
        lastMessageAt: "",
        unreadCount: 0,
        createdAt: new Date().toISOString(),
        bindingMode: "web-scan",
        userId: req.user!.id,
        sessionData: clientId,
        connectionStatus: "qr-pending",
        lastConnectedAt: ""
      };
      store.whatsappBindings.push(binding);
    } else {
      binding.bindingMode = "web-scan";
      binding.userId = req.user!.id;
      binding.sessionData = clientId;
      binding.connectionStatus = "qr-pending";
    }

    await store.persist();

    whatsappWebManager.onMessage(clientId, async (message) => {
      const currentStore = getStore();
      if (currentStore.whatsappMessages.some((item) => item.waMessageId === message.waMessageId)) return;
      const currentBinding = currentStore.whatsappBindings.find((item) =>
        item.customerId === customer.id && item.sessionData === clientId
      );
      if (!currentBinding) return;
      message.customerId = customer.id;
      message.contentTranslated = await translateToChinese(req.user!, message.content);
      currentStore.whatsappMessages.push(message);
      currentBinding.lastMessageAt = message.createdAt;
      currentBinding.unreadCount = (currentBinding.unreadCount || 0) + 1;
      await currentStore.persist();
    });

    res.json({ clientId, bindingId: binding.id, status: "qr-pending" });
  } catch (error: any) {
    res.status(500).json({ message: "启动扫码失败: " + error.message });
  }
}));

// 获取二维码（通过 SSE 推送）
app.get("/api/whatsapp/binding/web-scan/qr/:clientId", requireAuth, (req, res) => {
  const { clientId } = req.params;
  const binding = getStore().whatsappBindings.find((item) =>
    item.sessionData === clientId && item.userId === req.user!.id
  );
  if (!binding) {
    res.status(404).json({ message: "扫码会话不存在或无权访问" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const unsubscribe = whatsappWebManager.onQR(clientId, async (qr) => {
    const qrDataUrl = await QRCode.toDataURL(qr, { width: 220, margin: 1 });
    res.write(`data: ${JSON.stringify({ qrDataUrl })}\n\n`);
  });

  // 30秒超时
  const timer = setTimeout(() => {
    res.write(`data: ${JSON.stringify({ timeout: true })}\n\n`);
    res.end();
  }, 30000);

  req.on("close", () => {
    clearTimeout(timer);
    unsubscribe();
    res.end();
  });
});

// 检查 Web 扫码状态
app.get("/api/whatsapp/binding/web-scan/status/:clientId", requireAuth, (req, res) => {
  const { clientId } = req.params;
  const binding = getStore().whatsappBindings.find((item) =>
    item.sessionData === clientId && item.userId === req.user!.id
  );
  if (!binding) {
    res.status(404).json({ message: "扫码会话不存在或无权访问" });
    return;
  }
  const status = whatsappWebManager.getClientStatus(clientId);
  if (binding.connectionStatus !== status) {
    binding.connectionStatus = status;
    if (status === "connected") binding.lastConnectedAt = new Date().toISOString();
    void getStore().persist();
  }
  res.json({ status });
});

// 断开 Web 扫码连接
app.post("/api/whatsapp/binding/web-scan/disconnect", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    customerId: z.string()
  });
  const body = schema.parse(req.body);
  const customer = findWhatsAppCustomer(req.user!, body.customerId);
  if (!customer) {
    res.status(404).json({ message: "客户不存在或无权访问" });
    return;
  }
  if (!canManageWhatsAppBinding(req.user!, customer)) {
    res.status(403).json({ message: "只有客户负责人可以断开 WhatsApp 绑定" });
    return;
  }

  const store = getStore();
  const binding = store.whatsappBindings.find((b) => b.customerId === customer.id);

  if (binding && binding.sessionData) {
    await whatsappWebManager.disconnectClient(binding.sessionData);
    binding.connectionStatus = "disconnected";
    await store.persist();
  }

  res.json({ ok: true });
}));

// 开始 Twilio API 绑定
app.post("/api/whatsapp/binding/twilio/start", requireAuth, asyncRoute(async (req, res) => {
  if (!twilioManager.isInitialized()) {
    res.status(400).json({ message: "Twilio 未配置，请联系管理员" });
    return;
  }

  const schema = z.object({
    customerId: z.string(),
    phoneNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "请输入包含国家码的客户号码"),
    twilioPhoneNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "请输入包含国家码的企业发信号码")
  });
  const body = schema.parse(req.body);
  const customer = findWhatsAppCustomer(req.user!, body.customerId);
  if (!customer) {
    res.status(404).json({ message: "客户不存在或无权访问" });
    return;
  }
  if (!canManageWhatsAppBinding(req.user!, customer)) {
    res.status(403).json({ message: "只有客户负责人可以修改 WhatsApp 绑定" });
    return;
  }

  const store = getStore();
  let binding = store.whatsappBindings.find((b) => b.customerId === customer.id);

  if (!binding) {
    binding = {
      id: `wab_${Date.now()}`,
      customerId: customer.id,
      phoneNumber: body.phoneNumber,
      waProfileName: "",
      lastMessageAt: "",
      unreadCount: 0,
      createdAt: new Date().toISOString(),
      bindingMode: "twilio-api",
      twilioPhoneNumber: body.twilioPhoneNumber,
      userId: req.user!.id,
      connectionStatus: "connected",
      lastConnectedAt: new Date().toISOString()
    };
    store.whatsappBindings.push(binding);
  } else {
    binding.bindingMode = "twilio-api";
    binding.phoneNumber = body.phoneNumber;
    binding.twilioPhoneNumber = body.twilioPhoneNumber;
    binding.userId = req.user!.id;
    binding.connectionStatus = "connected";
    binding.lastConnectedAt = new Date().toISOString();
  }

  await store.persist();
  res.json({ binding: publicWhatsAppBinding(binding) });
}));

// Twilio Webhook 接收消息
app.post("/api/whatsapp/webhook/twilio", asyncRoute(async (req, res) => {
  const signature = String(req.headers["x-twilio-signature"] || "");
  const url = twilioWebhookUrl || `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  if (!signature || !twilioManager.validateWebhook(signature, url, req.body)) {
    res.status(403).json({ message: "Invalid signature" });
    return;
  }

  const { From, To, Body, MessageSid } = z.object({
    From: z.string().min(5).max(40),
    To: z.string().min(5).max(40),
    Body: z.string().max(4000).default(""),
    MessageSid: z.string().min(8).max(80)
  }).parse(req.body);

  // 去掉 whatsapp: 前缀
  const fromNumber = From.replace("whatsapp:", "");
  const toNumber = To.replace("whatsapp:", "");

  const store = getStore();
  if (store.whatsappMessages.some((message) => message.waMessageId === MessageSid)) {
    res.type("text/xml");
    res.send("<Response></Response>");
    return;
  }

  // 目标通道和客户号码必须同时匹配，避免共享通道时串客户。
  const binding = store.whatsappBindings.find((b) =>
    b.bindingMode === "twilio-api"
    && b.twilioPhoneNumber === toNumber
    && b.phoneNumber === fromNumber
  );

  if (binding) {
    const message = {
      id: `wam_${Date.now()}`,
      customerId: binding.customerId,
      direction: "inbound" as const,
      content: Body,
      contentTranslated: "",
      mediaUrl: "",
      status: "received",
      waMessageId: MessageSid,
      createdAt: new Date().toISOString()
    };

    store.whatsappMessages.push(message);
    binding.lastMessageAt = message.createdAt;
    binding.unreadCount = (binding.unreadCount || 0) + 1;

    await store.persist();
  }

  // Twilio 需要 TwiML 响应
  res.type("text/xml");
  res.send("<Response></Response>");
}));

app.get("/api/todos", requireAuth, (req, res) => {
  const store = getStore();
  const archived = archiveExpiredTodos(store.todos, new Date());
  if (archived.length) void store.persist();
  const { todos } = store;
  const scoped = todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
  res.json({ todos: scoped });
});

app.post("/api/todos", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    type: z.enum(["customer", "knowledge", "exam", "ocr", "other"]).default("other"),
    priority: z.enum(["high", "medium", "normal"]).default("normal"),
    dueAt: z.string().default(""),
    related: z.string().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const todo = {
    id: `t_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    done: false,
    status: "pending" as const,
    pinState: "" as const,
    sortOrder: nextTodoSortOrder(store.todos, req.user!.id),
    createdAt: new Date().toISOString(),
    historyAt: "",
    ...body
  };
  if (shouldArchiveTodo(todo)) {
    todo.historyAt = new Date().toISOString();
    todo.status = "pending" as const;
  }
  store.todos.unshift(todo);
  await store.persist();
  res.json({ todo });
}));

const planTaskDueAtSchema = z.string().refine(
  (value) => !value || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value),
  "计划时间格式无效"
);

const planTaskSchema = z.object({
  title: z.string().min(1),
  phase: z.string().min(1).default("计划任务"),
  category: z.string().min(1).default("客户开发"),
  priority: z.enum(["high", "medium", "normal"]).default("normal"),
  status: z.enum(["planned", "active"]).default("planned"),
  dueAt: planTaskDueAtSchema.default(""),
  target: z.string().default(""),
  description: z.string().default(""),
  customerId: z.string().default(""),
  leadId: z.string().default(""),
  dealId: z.string().default("")
});

function sortPlanTasks(tasks: PlanTask[]) {
  const statusWeight: Record<PlanTask["status"], number> = { active: 0, planned: 1, done: 2, cancelled: 3 };
  const priorityWeight: Record<PlanTask["priority"], number> = { high: 0, medium: 1, normal: 2 };
  return [...tasks].sort((left, right) => {
    return statusWeight[left.status] - statusWeight[right.status]
      || priorityWeight[left.priority] - priorityWeight[right.priority]
      || String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  });
}

function validatePlanTaskBusinessRefs(user: SessionUser, refs: Pick<PlanTask, "customerId" | "leadId" | "dealId">) {
  const store = getStore();
  const customerId = refs.customerId || "";
  const leadId = refs.leadId || "";
  const dealId = refs.dealId || "";
  if (leadId && (customerId || dealId)) return "线索不能与客户或商机同时关联";
  if (leadId) {
    const lead = store.leads.find((item) => item.id === leadId && !item.deletedAt && canSeeOwner(user, item.ownerId, item.teamId));
    return lead ? "" : "关联线索不存在或无权访问";
  }
  if (dealId) {
    const deal = store.deals.find((item) => item.id === dealId && canSeeOwner(user, item.ownerId, item.teamId));
    if (!deal) return "关联商机不存在或无权访问";
    if (customerId && customerId !== deal.customerId) return "商机与客户不匹配";
    const customer = store.customers.find((item) => item.id === deal.customerId && canSeeOwner(user, item.ownerId, item.teamId));
    if (!customer) return "商机所属客户不存在或无权访问";
    return isPublicCustomer(customer) ? "公池客户请先领取后再创建计划任务" : "";
  }
  if (customerId) {
    const customer = store.customers.find((item) => item.id === customerId && canSeeOwner(user, item.ownerId, item.teamId));
    if (!customer) return "关联客户不存在或无权访问";
    return isPublicCustomer(customer) ? "公池客户请先领取后再创建计划任务" : "";
  }
  return "";
}

function normalizedPlanTaskRefs(user: SessionUser, refs: Pick<PlanTask, "customerId" | "leadId" | "dealId">) {
  if (!refs.dealId) return refs;
  const deal = getStore().deals.find((item) => item.id === refs.dealId && canSeeOwner(user, item.ownerId, item.teamId));
  return { ...refs, customerId: deal?.customerId || refs.customerId || "" };
}

const defaultPlanTemplateDrafts: Array<Omit<PlanTemplate, "id" | "ownerId" | "teamId" | "updatedAt">> = [
  { section: "knowledge", title: "产品分类地图", summary: "按产品线整理核心品类、典型型号、目标市场和应用场景。", output: "输出物：1页分类卡", badge: "必会", badgeTone: "green", phase: "前置知识", category: "产品知识", priority: "high", target: "完成核心产品分类卡和典型应用说明", description: "整理核心产品的型号、卖点、应用行业、常见客户问题和风险边界。", sortOrder: 10 },
  { section: "knowledge", title: "需求追问表", summary: "用途、规格、数量、预算、交期、认证、包装和贸易条款；必须能向客户追问。", output: "输出物：需求确认模板", badge: "必会", badgeTone: "green", phase: "前置知识", category: "需求训练", priority: "high", target: "形成可复制的英文需求确认表", description: "把用途、规格、数量、预算、交期、认证、包装和贸易条款整理成询盘追问模板。", sortOrder: 20 },
  { section: "knowledge", title: "证书与资料包", summary: "按产品归档目录、规格书、测试报告、认证文件、包装资料和常见问答。", output: "输出物：资料索引", badge: "资料化", badgeTone: "amber", phase: "前置知识", category: "资料维护", priority: "medium", target: "完成对外资料索引并标注适用产品", description: "按产品类型整理目录、规格书、认证和测试资料，避免客户索要资料时临时翻找。", sortOrder: 30 },
  { section: "knowledge", title: "行业应用场景", summary: "按目标市场整理终端用户、经销渠道、工程项目和 OEM 客户的采购场景。", output: "输出物：行业话术", badge: "场景", badgeTone: "", phase: "前置知识", category: "场景训练", priority: "medium", target: "每类客户写出1条切入话术和1个典型应用", description: "围绕目标国家和主要客户类型整理采购痛点、决策角色和首触达理由。", sortOrder: 40 },
  { section: "knowledge", title: "竞品替代口径", summary: "整理主要竞品的价格带、交期、渠道、卖点和替代边界。", output: "输出物：竞品对照表", badge: "谈判", badgeTone: "red", phase: "前置知识", category: "竞品研究", priority: "medium", target: "完成至少5个竞品品牌的替代切入点", description: "整理竞品主打产品、客户关注点、我方可替代卖点和风险边界。", sortOrder: 50 },
  { section: "persona", title: "进口商与经销商", summary: "关注稳定供货、利润空间、资料齐全、区域支持和快速响应。", output: "关键词：product distributor / importer / wholesaler / country\n首触达：目录、渠道政策、认证资料、热销型号", badge: "高匹配", badgeTone: "green", phase: "客户画像", category: "客户开发", priority: "high", target: "筛选30家高匹配经销商并完成首触达", description: "使用产品词加 distributor、importer、wholesaler 等关键词，按国家筛选官网、联系人、产品线和代理品牌。", sortOrder: 110 },
  { section: "persona", title: "项目采购商", summary: "关注规格匹配、交期、项目文件、质量保障和协同响应。", output: "关键词：project procurement / solution provider / country\n首触达：询问应用场景、采购清单、规格与交付要求", badge: "项目型", badgeTone: "aqua", phase: "客户画像", category: "客户开发", priority: "high", target: "筛选20家项目客户并确认采购场景", description: "围绕项目采购和解决方案关键词查找客户，首封邮件重点询问用途、规格、数量、交期和认证需求。", sortOrder: 120 },
  { section: "persona", title: "OEM 制造商", summary: "关注批量一致性、定制能力、长期价格、包装和交付稳定性。", output: "关键词：manufacturer / OEM supplier / private label\n首触达：发需求确认表、询问年用量和定制要求", badge: "批量型", badgeTone: "amber", phase: "客户画像", category: "客户开发", priority: "medium", target: "建立20家OEM客户名单并完成需求确认", description: "按产品和应用类型筛选OEM客户，重点记录年用量、现用产品、定制要求、包装和目标价。", sortOrder: 130 },
  { section: "persona", title: "工程承包商", summary: "关注认证、项目清单、交付风险、技术文件和投标资料。", output: "关键词：EPC contractor / project procurement\n首触达：索要 RFQ、项目清单、证书和交付要求", badge: "高价值", badgeTone: "red", phase: "客户画像", category: "客户开发", priority: "medium", target: "筛选15家工程客户并记录项目机会", description: "按目标行业筛选工程客户，邮件重点强调资料完整性、交付能力和项目配合经验。", sortOrder: 140 },
  { section: "execution", title: "第 1 天", summary: "整理产品分类与卖点卡；建立客户搜索关键词库 10 组。", output: "整理产品分类与卖点卡。\n建立客户搜索关键词库 10 组。", badge: "启动", badgeTone: "green", phase: "首周执行", category: "产品知识", priority: "high", target: "完成分类卡和10组关键词库", description: "先把产品分类、卖点卡和客户搜索关键词准备好，避免盲目找客户。", sortOrder: 210 },
  { section: "execution", title: "第 2 天", summary: "整理证书、报价资料和应用案例；新增 30 家目标客户到 CRM。", output: "整理证书、报价资料和应用案例。\n新增 30 家目标客户到 CRM。", badge: "资料", badgeTone: "aqua", phase: "首周执行", category: "资料维护", priority: "high", target: "完成资料包并新增30家客户", description: "把资料准备和客户池新增绑定，新增客户必须带国家、官网、产品匹配点和下一步动作。", sortOrder: 220 },
  { section: "execution", title: "第 3 天", summary: "完成角色-痛点-话术表；首触达 20 家高匹配客户。", output: "完成角色-痛点-话术表。\n首触达 20 家高匹配客户。", badge: "触达", badgeTone: "amber", phase: "首周执行", category: "客户开发", priority: "high", target: "完成20家首触达并记录结果", description: "按客户角色使用不同邮件标题、开场和参数追问，不要所有客户发同一套内容。", sortOrder: 230 },
  { section: "execution", title: "第 4 天", summary: "整理竞品替代切入点 5 条；跟进昨日未回复客户 10 家。", output: "整理竞品替代切入点 5 条。\n跟进昨日未回复客户 10 家。", badge: "跟进", badgeTone: "amber", phase: "首周执行", category: "竞品研究", priority: "medium", target: "完成10家二次跟进和5条竞品切入点", description: "二次跟进要补充资料或新问题，不能只是重复问客户是否收到邮件。", sortOrder: 240 },
  { section: "execution", title: "第 5 天", summary: "制作参数确认表模板；深挖 3 家 A 类客户并写入 CRM。", output: "制作参数确认表模板。\n深挖 3 家 A 类客户并写入 CRM。", badge: "深挖", badgeTone: "red", phase: "首周执行", category: "客户开发", priority: "medium", target: "完成3家A类客户深挖", description: "深挖官网、联系人、产品线、可能项目、竞品品牌和下一步触达理由。", sortOrder: 250 },
  { section: "execution", title: "第 6-7 天", summary: "完成第一周开发周报；复盘并优化 ICP 与话术。", output: "完成第一周开发周报。\n复盘并优化 ICP 与话术。", badge: "复盘", badgeTone: "green", phase: "首周执行", category: "周报复盘", priority: "normal", target: "输出可汇报的首周复盘", description: "复盘新增客户、有效触达、有效回复、问题、资料缺口和下周优化动作。", sortOrder: 260 }
];

function sortPlanTemplates(templates: PlanTemplate[]) {
  return [...templates].sort((left, right) => left.sortOrder - right.sortOrder || String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")));
}

async function ensurePlanTemplatesForUser(user: SessionUser) {
  const store = getStore();
  const existing = store.planTemplates.filter((template) => canSeePersonalData(user, template.ownerId));
  if (existing.length && existing.some((template) => template.section === "execution")) return sortPlanTemplates(existing);
  const now = new Date().toISOString();
  const drafts = existing.length ? defaultPlanTemplateDrafts.filter((template) => template.section === "execution") : defaultPlanTemplateDrafts;
  const created = drafts.map((template, index) => ({
    id: `ptpl_${user.id}_${Date.now()}_${index}`,
    ownerId: user.id,
    teamId: user.teamId,
    updatedAt: now,
    ...template
  }));
  store.planTemplates.push(...created);
  await store.persist();
  return sortPlanTemplates([...existing, ...created]);
}

app.get("/api/plan-tasks", requireAuth, (req, res) => {
  const { planTasks } = getStore();
  const scoped = planTasks.filter((task) => canSeePersonalData(req.user!, task.ownerId));
  res.json({ tasks: sortPlanTasks(scoped) });
});

app.post("/api/plan-tasks", requireAuth, asyncRoute(async (req, res) => {
  const parsed = planTaskSchema.parse(req.body);
  const explicitRefError = validatePlanTaskBusinessRefs(req.user!, parsed);
  if (explicitRefError) {
    res.status(400).json({ message: explicitRefError });
    return;
  }
  const refs = normalizedPlanTaskRefs(req.user!, parsed);
  const refError = validatePlanTaskBusinessRefs(req.user!, refs);
  if (refError) {
    res.status(400).json({ message: refError });
    return;
  }
  const body = { ...parsed, ...refs };
  const now = new Date().toISOString();
  const store = getStore();
  const task: PlanTask = {
    id: `pt_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    createdAt: now,
    updatedAt: now,
    ...body
  };
  store.planTasks.unshift(task);
  await store.persist();
  res.json({ task });
}));

app.patch("/api/plan-tasks/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = planTaskSchema.partial().parse(req.body);
  const store = getStore();
  const task = store.planTasks.find((item) => item.id === req.params.id);
  if (!task || !canSeePersonalData(req.user!, task.ownerId)) {
    res.status(404).json({ message: "计划任务不存在" });
    return;
  }
  const requestedRefs = {
    customerId: body.customerId ?? task.customerId,
    leadId: body.leadId ?? task.leadId,
    dealId: body.dealId ?? task.dealId
  };
  const explicitRefError = validatePlanTaskBusinessRefs(req.user!, requestedRefs);
  if (explicitRefError) {
    res.status(400).json({ message: explicitRefError });
    return;
  }
  const refs = normalizedPlanTaskRefs(req.user!, requestedRefs);
  const refError = validatePlanTaskBusinessRefs(req.user!, refs);
  if (refError) {
    res.status(400).json({ message: refError });
    return;
  }
  Object.assign(task, body, refs, { updatedAt: new Date().toISOString() });
  await store.persist();
  res.json({ task });
}));

app.post("/api/plan-tasks/:id/complete", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ result: z.string().trim().min(1).max(2000) }).parse(req.body);
  const store = getStore();
  const task = store.planTasks.find((item) => item.id === req.params.id);
  if (!task || !canSeePersonalData(req.user!, task.ownerId)) {
    res.status(404).json({ message: "计划任务不存在" });
    return;
  }
  if (task.status === "cancelled") {
    res.status(409).json({ message: "已取消任务不能标记完成" });
    return;
  }
  const now = new Date().toISOString();
  Object.assign(task, {
    status: "done" as const,
    completionResult: body.result,
    completedAt: now,
    cancellationReason: "",
    cancelledAt: "",
    updatedAt: now
  });
  await store.persist();
  res.json({ task });
}));

app.post("/api/plan-tasks/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(req.body);
  const store = getStore();
  const task = store.planTasks.find((item) => item.id === req.params.id);
  if (!task || !canSeePersonalData(req.user!, task.ownerId)) {
    res.status(404).json({ message: "计划任务不存在" });
    return;
  }
  if (task.status === "done") {
    res.status(409).json({ message: "已完成任务不能取消" });
    return;
  }
  const now = new Date().toISOString();
  Object.assign(task, {
    status: "cancelled" as const,
    cancellationReason: body.reason,
    cancelledAt: now,
    completionResult: "",
    completedAt: "",
    updatedAt: now
  });
  await store.persist();
  res.json({ task });
}));

app.post("/api/plan-tasks/:id/reschedule", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    dueAt: planTaskDueAtSchema.refine(Boolean, "请选择新的计划时间"),
    reason: z.string().trim().max(500).default("")
  }).parse(req.body);
  const store = getStore();
  const task = store.planTasks.find((item) => item.id === req.params.id);
  if (!task || !canSeePersonalData(req.user!, task.ownerId)) {
    res.status(404).json({ message: "计划任务不存在" });
    return;
  }
  if (task.status === "done" || task.status === "cancelled") {
    res.status(409).json({ message: "已结束任务不能改期" });
    return;
  }
  const now = new Date().toISOString();
  Object.assign(task, {
    rescheduledFrom: task.dueAt || "",
    dueAt: body.dueAt,
    rescheduledAt: now,
    rescheduleReason: body.reason,
    updatedAt: now
  });
  await store.persist();
  res.json({ task });
}));

app.delete("/api/plan-tasks/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.planTasks.findIndex((item) => item.id === req.params.id);
  const task = index >= 0 ? store.planTasks[index] : null;
  if (!task || !canSeePersonalData(req.user!, task.ownerId)) {
    res.status(404).json({ message: "计划任务不存在" });
    return;
  }
  store.planTasks.splice(index, 1);
  await store.persist();
  res.json({ ok: true, id: req.params.id });
}));

const planTemplateSchema = z.object({
  section: z.enum(["knowledge", "persona", "execution"]).default("knowledge"),
  title: z.string().min(1),
  summary: z.string().default(""),
  output: z.string().default(""),
  badge: z.string().default(""),
  badgeTone: z.string().default(""),
  phase: z.string().min(1).default("计划任务"),
  category: z.string().min(1).default("客户开发"),
  priority: z.enum(["high", "medium", "normal"]).default("normal"),
  target: z.string().default(""),
  description: z.string().default(""),
  sortOrder: z.coerce.number().int().default(0)
});

app.get("/api/plan-templates", requireAuth, asyncRoute(async (req, res) => {
  const templates = await ensurePlanTemplatesForUser(req.user!);
  res.json({ templates });
}));

app.post("/api/plan-templates", requireAuth, asyncRoute(async (req, res) => {
  const body = planTemplateSchema.parse(req.body);
  const store = getStore();
  const template: PlanTemplate = {
    id: `ptpl_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString(),
    ...body
  };
  store.planTemplates.push(template);
  await store.persist();
  res.json({ template });
}));

app.patch("/api/plan-templates/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = planTemplateSchema.partial().parse(req.body);
  const store = getStore();
  const template = store.planTemplates.find((item) => item.id === req.params.id);
  if (!template || !canSeePersonalData(req.user!, template.ownerId)) {
    res.status(404).json({ message: "模板不存在" });
    return;
  }
  Object.assign(template, body, { updatedAt: new Date().toISOString() });
  await store.persist();
  res.json({ template });
}));

app.delete("/api/plan-templates/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.planTemplates.findIndex((item) => item.id === req.params.id);
  const template = index >= 0 ? store.planTemplates[index] : null;
  if (!template || !canSeePersonalData(req.user!, template.ownerId)) {
    res.status(404).json({ message: "模板不存在" });
    return;
  }
  store.planTemplates.splice(index, 1);
  await store.persist();
  res.json({ ok: true, id: req.params.id });
}));

app.get("/api/deals", requireAuth, (req, res) => {
  const { deals, dealEvents, users } = getStore();
  const scoped = deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId));
  const ids = new Set(scoped.map((deal) => deal.id));
  const events = dealEvents
    .filter((event) => ids.has(event.dealId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((event) => ({ ...event, operatorName: users.find((user) => user.id === event.operatorId)?.name || "未知操作人" }));
  res.json({ deals: scoped, events });
});

const dealStages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"] as const;
const dealBodySchema = z.object({
  customerId: z.string().trim().min(1),
  title: z.string().min(1),
  product: z.string().trim().min(1).max(200),
  quantity: z.coerce.number().int().nonnegative().default(0),
  unitPrice: z.coerce.number().nonnegative().default(0),
  amount: z.coerce.number().nonnegative().optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default("USD"),
  nextAction: z.string().trim().min(1),
  nextActionAt: z.string().trim().min(1),
  expectedCloseAt: z.string().trim().optional().default("")
});
const createDealBodySchema = dealBodySchema.extend({
  recommendationId: z.string().trim().max(90).optional().default("")
});

function calculatedDealAmount(body: { amount?: number; quantity: number; unitPrice: number }) {
  if (typeof body.amount === "number") return Math.round(body.amount * 100) / 100;
  return Math.round(body.quantity * body.unitPrice * 100) / 100;
}

function createDealEvent(input: Omit<DealEvent, "id" | "createdAt"> & { createdAt?: string }) {
  const store = getStore();
  const event: DealEvent = {
    ...input,
    id: `de_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: input.createdAt || new Date().toISOString()
  };
  store.dealEvents.unshift(event);
  return event;
}

function dealEventTypeForStage(stage: Deal["stage"]): DealEvent["type"] {
  if (stage === "已报价") return "quote";
  if (stage === "样品") return "sample";
  if (stage === "谈判") return "negotiation";
  if (stage === "成交") return "won";
  return "stage";
}

app.post("/api/deals", requireAuth, asyncRoute(async (req, res) => {
  const body = createDealBodySchema.parse(req.body);
  const store = getStore();
  const customer = findWritableCustomer(req.user!, body.customerId, res);
  if (!customer) return;
  const recommendation = body.recommendationId
    ? store.dealRecommendations.find((item) =>
      item.id === body.recommendationId
      && item.teamId === req.user!.teamId
      && item.ownerId === req.user!.id
    )
    : undefined;
  if (body.recommendationId && !recommendation) {
    res.status(404).json({ message: "商机建议不存在或无权访问" });
    return;
  }
  if (recommendation) {
    if (recommendation.status !== "generated") {
      res.status(409).json({ message: "当前商机建议已经处理" });
      return;
    }
    const recommendationCustomerId = resolveRecommendationCustomerId(
      store,
      recommendation
    );
    if (!recommendationCustomerId) {
      res.status(409).json({ message: "请先将候选确认到客户，再使用商机建议" });
      return;
    }
    if (recommendationCustomerId !== customer.id) {
      res.status(409).json({ message: "商机建议与所选客户不一致" });
      return;
    }
  }
  const now = new Date().toISOString();
  const deal: Deal = {
    id: `d_${Date.now()}`,
    customerId: customer.id,
    title: body.title,
    stage: "询盘",
    product: body.product,
    quantity: body.quantity,
    unitPrice: body.unitPrice,
    amount: calculatedDealAmount(body),
    currency: body.currency,
    amountType: "estimate",
    ownerId: customer.ownerId,
    teamId: customer.teamId,
    nextAction: body.nextAction,
    nextActionAt: body.nextActionAt,
    expectedCloseAt: body.expectedCloseAt,
    stageChangedAt: now,
    archivedAt: undefined
  };
  store.deals.unshift(deal);
  createDealEvent({
    dealId: deal.id,
    type: "created",
    content: `创建商机并关联客户 ${customer.company}`,
    operatorId: req.user!.id,
    toStage: "询盘",
    nextAction: deal.nextAction,
    nextActionAt: deal.nextActionAt,
    createdAt: now
  });
  if (recommendation) {
    linkRecommendationToDeal(
      store,
      recommendation,
      deal,
      req.user!.id,
      "converted_by_user"
    );
  }
  await store.persist();
  res.json({ deal, recommendation });
}));

app.patch("/api/deals/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = dealBodySchema.parse(req.body);
  const store = getStore();
  const deal = store.deals.find((item) => item.id === req.params.id);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }
  if (deal.archivedAt) {
    res.status(400).json({ message: "已归档商机不能编辑" });
    return;
  }
  if (!ensureDealCustomerWritable(req.user!, deal, res)) return;
  const customer = findWritableCustomer(req.user!, body.customerId, res);
  if (!customer) return;
  const before = {
    customerId: deal.customerId,
    amount: deal.amount,
    currency: deal.currency,
    nextAction: deal.nextAction,
    nextActionAt: deal.nextActionAt
  };
  deal.customerId = customer.id;
  deal.title = body.title;
  deal.product = body.product;
  deal.quantity = body.quantity;
  deal.unitPrice = body.unitPrice;
  deal.amount = calculatedDealAmount(body);
  deal.currency = body.currency;
  deal.ownerId = customer.ownerId;
  deal.teamId = customer.teamId;
  deal.nextAction = body.nextAction;
  deal.nextActionAt = body.nextActionAt;
  deal.expectedCloseAt = body.expectedCloseAt;
  const changes = [
    before.customerId !== deal.customerId ? `客户改为 ${customer.company}` : "",
    before.amount !== deal.amount || before.currency !== deal.currency ? `金额更新为 ${deal.currency} ${deal.amount}` : "",
    before.nextAction !== deal.nextAction || before.nextActionAt !== deal.nextActionAt ? `下一动作更新为“${deal.nextAction}”（${deal.nextActionAt}）` : ""
  ].filter(Boolean);
  if (changes.length) {
    createDealEvent({
      dealId: deal.id,
      type: "updated",
      content: changes.join("；"),
      operatorId: req.user!.id,
      nextAction: deal.nextAction,
      nextActionAt: deal.nextActionAt
    });
  }
  await store.persist();
  res.json({ deal });
}));

app.patch("/api/deals/:id/stage", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    stage: z.enum(dealStages),
    result: z.string().trim().min(1).max(2000),
    nextAction: z.string().trim().min(1).max(200),
    nextActionAt: z.string().trim().min(1),
    expectedCloseAt: z.string().trim().optional().default(""),
    transitionReason: z.string().trim().optional().default(""),
    wonReason: z.string().trim().optional().default("")
  });
  const store = getStore();
  const body = schema.parse(req.body);
  const deal = store.deals.find((item) => item.id === req.params.id);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }
  if (!ensureDealCustomerWritable(req.user!, deal, res)) return;
  if (deal.archivedAt) {
    res.status(400).json({ message: "已归档商机不能推进阶段" });
    return;
  }
  if (deal.stage === "成交" || deal.stage === "丢单" || body.stage === "丢单") {
    res.status(400).json({ message: "关闭商机不能继续推进；丢单请使用丢单复盘" });
    return;
  }
  const activeStages = dealStages.slice(0, 6);
  const fromIndex = activeStages.indexOf(deal.stage);
  const toIndex = activeStages.indexOf(body.stage);
  const distance = toIndex - fromIndex;
  const canOverride = req.user!.role === "manager" || req.user!.role === "admin" || req.user!.role === "super_admin";
  if (distance === 0) {
    res.status(400).json({ message: "请选择不同的目标阶段" });
    return;
  }
  if (Math.abs(distance) > 1 && (!canOverride || !body.transitionReason)) {
    res.status(400).json({ message: "默认只能相邻推进；主管跳阶段必须填写原因" });
    return;
  }
  if (distance < 0 && !body.transitionReason) {
    res.status(400).json({ message: "阶段回退必须填写原因" });
    return;
  }
  if (toIndex >= 2 && !body.expectedCloseAt) {
    res.status(400).json({ message: "进入已报价及后续阶段必须填写预计成交日期" });
    return;
  }
  if (body.stage === "成交" && !body.wonReason) {
    res.status(400).json({ message: "确认成交必须填写客户确认依据" });
    return;
  }
  const fromStage = deal.stage;
  const now = new Date().toISOString();
  deal.stage = body.stage;
  deal.stageChangedAt = now;
  deal.nextAction = body.nextAction;
  deal.nextActionAt = body.nextActionAt;
  if (body.expectedCloseAt) deal.expectedCloseAt = body.expectedCloseAt;
  if (toIndex >= 2) deal.amountType = "quoted";
  if (body.stage === "成交") {
    deal.amountType = "won";
    deal.closedAt = now;
    deal.wonReason = body.wonReason;
  }
  createDealEvent({
    dealId: deal.id,
    type: dealEventTypeForStage(body.stage),
    content: `${body.result}${body.transitionReason ? `；变更原因：${body.transitionReason}` : ""}${body.wonReason ? `；成交依据：${body.wonReason}` : ""}`,
    operatorId: req.user!.id,
    fromStage,
    toStage: body.stage,
    nextAction: body.nextAction,
    nextActionAt: body.nextActionAt,
    createdAt: now
  });
  if (body.stage === "成交") {
    recordAcquisitionOutcomeFeedback(store, {
      deal,
      outcome: "won",
      reason: body.wonReason,
      closedAt: now
    });
  }
  await store.persist();
  res.json({ deal });
}));

app.post("/api/deals/:id/events", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    type: z.enum(["follow_up", "quote", "sample", "negotiation", "payment"]),
    content: z.string().trim().min(1).max(2000),
    nextAction: z.string().trim().min(1).max(200),
    nextActionAt: z.string().trim().min(1)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const deal = store.deals.find((item) => item.id === req.params.id);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }
  if (!ensureDealCustomerWritable(req.user!, deal, res)) return;
  if (deal.archivedAt) {
    res.status(400).json({ message: "已归档商机不能记录新进展" });
    return;
  }
  deal.nextAction = body.nextAction;
  deal.nextActionAt = body.nextActionAt;
  const content = body.type === "payment" ? `${body.content}（销售记录，未经财务核销）` : body.content;
  const event = createDealEvent({
    dealId: deal.id,
    type: body.type,
    content,
    operatorId: req.user!.id,
    fromStage: deal.stage,
    toStage: deal.stage,
    nextAction: body.nextAction,
    nextActionAt: body.nextActionAt
  });
  await store.persist();
  res.json({ deal, event });
}));

app.post("/api/deals/:id/archive", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const deal = store.deals.find((item) => item.id === req.params.id);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }
  if (deal.stage !== "成交") {
    res.status(400).json({ message: "只有成交商机可以归档" });
    return;
  }
  deal.archivedAt = new Date().toISOString();
  createDealEvent({
    dealId: deal.id,
    type: "archived",
    content: "成交商机已归档",
    operatorId: req.user!.id,
    fromStage: deal.stage,
    toStage: deal.stage,
    nextAction: deal.nextAction,
    nextActionAt: deal.nextActionAt,
    createdAt: deal.archivedAt
  });
  await store.persist();
  res.json({ deal });
}));

app.post("/api/deals/:id/lost", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    category: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(1).max(2000),
    revisitAt: z.string().trim().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const deal = store.deals.find((item) => item.id === req.params.id);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }
  if (deal.archivedAt) {
    res.status(400).json({ message: "已归档商机不能重复丢单" });
    return;
  }
  if (deal.stage === "成交") {
    res.status(400).json({ message: "成交商机请归档，不能标记丢单" });
    return;
  }
  const fromStage = deal.stage;
  const now = new Date().toISOString();
  deal.stage = "丢单";
  deal.stageChangedAt = now;
  deal.closedAt = now;
  deal.lostReasonCategory = body.category;
  deal.lostReason = body.reason;
  deal.revisitAt = body.revisitAt || undefined;
  deal.nextAction = body.revisitAt ? "按复访日期重新评估需求" : "完成丢单复盘";
  deal.nextActionAt = body.revisitAt;
  createDealEvent({
    dealId: deal.id,
    type: "lost",
    content: `${body.category}：${body.reason}${body.revisitAt ? `；计划 ${body.revisitAt} 复访` : ""}`,
    operatorId: req.user!.id,
    fromStage,
    toStage: "丢单",
    nextAction: deal.nextAction,
    nextActionAt: deal.nextActionAt,
    createdAt: now
  });
  recordAcquisitionOutcomeFeedback(store, {
    deal,
    outcome: "lost",
    reasonCategory: body.category,
    reason: body.reason,
    closedAt: now
  });
  await store.persist();
  res.json({ deal });
}));

app.get("/api/deals/closed", requireAuth, (req, res) => {
  const store = getStore();
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(50, Math.max(5, Number(req.query.pageSize || 20)));
  const keyword = String(req.query.keyword || "").trim().toLowerCase();
  const status = String(req.query.status || "all");
  const month = String(req.query.month || "");
  const filtered = store.deals
    .filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId) && (deal.stage === "成交" || deal.stage === "丢单"))
    .filter((deal) => status === "all" || deal.stage === status)
    .filter((deal) => {
      const customer = store.customers.find((item) => item.id === deal.customerId);
      const text = `${deal.title} ${deal.product} ${customer?.company || ""} ${customer?.country || ""} ${deal.lostReasonCategory || ""}`.toLowerCase();
      return !keyword || text.includes(keyword);
    })
    .filter((deal) => !month || String(deal.closedAt || deal.archivedAt || "").slice(0, 7) === month)
    .sort((left, right) => String(right.closedAt || right.archivedAt || "").localeCompare(String(left.closedAt || left.archivedAt || "")));
  const start = (page - 1) * pageSize;
  const deals = filtered.slice(start, start + pageSize);
  res.json({
    deals,
    total: filtered.length,
    page,
    pageSize,
    counts: {
      won: filtered.filter((deal) => deal.stage === "成交").length,
      lost: filtered.filter((deal) => deal.stage === "丢单").length,
      revisit: filtered.filter((deal) => deal.stage === "丢单" && deal.revisitAt).length
    }
  });
});

function canManageCommissionRules(user?: SessionUser) {
  return user?.role === "admin" || user?.role === "super_admin";
}

function canReviewCommission(user?: SessionUser) {
  return user?.role === "admin" || user?.role === "super_admin";
}

function currentMonthValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function roundMoneyValue(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function commissionOwnersFor(user: SessionUser) {
  const store = getStore();
  if (canReviewCommission(user)) {
    return store.users
      .filter((item) => item.status === "active" && (item.role === "sales" || item.role === "manager"))
      .filter((item) => user.role === "super_admin" || item.teamId === user.teamId)
      .map((item) => ({ id: item.id, name: item.name, email: item.email, role: item.role, teamId: item.teamId }));
  }
  return [{ id: user.id, name: user.name, email: user.email, role: user.role, teamId: user.teamId }];
}

function resolveCommissionOwnerId(user: SessionUser, requestedOwnerId?: string) {
  const requested = requestedOwnerId?.trim();
  if (canReviewCommission(user)) {
    if (!requested || requested === "all") return "";
    return commissionOwnersFor(user).some((item) => item.id === requested) ? requested : null;
  }
  if (!requested || requested === user.id) return user.id;
  return null;
}

function canAccessCommissionOwner(user: SessionUser, ownerId: string) {
  if (user.role === "super_admin") return true;
  if (canReviewCommission(user)) {
    return getStore().users.some((item) => item.id === ownerId && item.teamId === user.teamId);
  }
  return ownerId === user.id;
}

function visibleSalesRecords(user: SessionUser, month?: string, ownerId?: string) {
  const scopedOwnerId = resolveCommissionOwnerId(user, ownerId);
  if (scopedOwnerId === null) return null;
  const allowedOwners = new Set(commissionOwnersFor(user).map((item) => item.id));
  return getStore().monthlySalesRecords.filter((record) => {
    if (month && record.month !== month) return false;
    if (scopedOwnerId && record.ownerId !== scopedOwnerId) return false;
    if (!scopedOwnerId && canReviewCommission(user) && !allowedOwners.has(record.ownerId)) return false;
    return canAccessCommissionOwner(user, record.ownerId);
  });
}

function visibleCommissionProducts(user: SessionUser) {
  return getStore().commissionProducts.filter((product) =>
    user.role === "super_admin" || product.teamId === "all" || product.teamId === user.teamId
  );
}

function canManageCommissionProduct(user: SessionUser, product: CommissionProduct) {
  return user.role === "super_admin" || product.teamId === user.teamId;
}

function findCommissionProduct(productName = "", user?: SessionUser) {
  const normalized = productName.trim().toLowerCase();
  if (!normalized) return undefined;
  const products = user ? visibleCommissionProducts(user) : getStore().commissionProducts;
  return products.find((product) => product.status === "active" && (
    product.name.toLowerCase() === normalized ||
    product.model.toLowerCase() === normalized ||
    normalized.includes(product.name.toLowerCase()) ||
    (product.model && normalized.includes(product.model.toLowerCase()))
  ));
}

function activeCommissionRule(productId: string, month: string) {
  return getStore().commissionRules
    .filter((rule) => rule.productId === productId && rule.enabled)
    .filter((rule) => (!rule.effectiveFrom || rule.effectiveFrom <= month) && (!rule.effectiveTo || rule.effectiveTo >= month))
    .sort((left, right) => (right.effectiveFrom || "").localeCompare(left.effectiveFrom || "") || right.createdAt.localeCompare(left.createdAt))[0];
}

function calculateCommissionAmount(record: MonthlySalesRecord, product?: CommissionProduct, rule?: CommissionRule) {
  const sales = Number(record.settlementAmount || record.salesAmount || 0);
  const inputSnapshot = {
    recordId: record.id,
    originalAmount: record.salesAmount,
    originalCurrency: record.currency,
    exchangeRate: record.exchangeRate,
    exchangeRateDate: record.exchangeRateDate,
    exchangeRateSource: record.exchangeRateSource,
    settlementCurrency: record.settlementCurrency,
    settlementAmount: sales,
    basisType: record.basisType,
    basisDate: record.basisDate
  };
  if (!rule || rule.ruleType === "none") return { amount: 0, snapshot: { input: inputSnapshot, rule: rule || null, formula: "未匹配启用规则", reason: "无启用规则" } };
  if (rule.ruleType === "rate") {
    const amount = roundMoneyValue(sales * Number(rule.rate || 0));
    return { amount, snapshot: { input: inputSnapshot, rule, formula: `${sales} × ${Number(rule.rate || 0) * 100}% = ${amount}` } };
  }
  if (rule.ruleType === "fixed") {
    const amount = roundMoneyValue(Number(rule.fixedAmount || 0) * Number(record.quantity || 1));
    return { amount, snapshot: { input: inputSnapshot, rule, formula: `${record.quantity} × ${Number(rule.fixedAmount || 0)} = ${amount}` } };
  }
  if (rule.ruleType === "gross_profit") {
    const cost = Number(product?.costPrice || 0) * Number(record.quantity || 0);
    const amount = roundMoneyValue(Math.max(0, sales - cost) * Number(rule.grossProfitRate || 0));
    return { amount, snapshot: { input: inputSnapshot, rule, cost, formula: `max(0, ${sales} - ${cost}) × ${Number(rule.grossProfitRate || 0) * 100}% = ${amount}` } };
  }
  if (rule.ruleType === "tier") {
    let rate = 0;
    try {
      const tiers = JSON.parse(rule.tierJson || "[]") as Array<{ from?: number; to?: number; rate?: number }>;
      const matched = tiers.find((tier) => sales >= Number(tier.from || 0) && sales < Number(tier.to || Number.MAX_SAFE_INTEGER));
      rate = Number(matched?.rate || 0);
    } catch {
      rate = 0;
    }
    const amount = roundMoneyValue(sales * rate);
    return { amount, snapshot: { input: inputSnapshot, rule, appliedRate: rate, formula: `${sales} × ${rate * 100}% = ${amount}` } };
  }
  return { amount: 0, snapshot: { input: inputSnapshot, rule, formula: "不计提" } };
}

function rebuildCalculationTotals(calculation: CommissionCalculation) {
  const store = getStore();
  const items = store.commissionItems.filter((item) => item.calculationId === calculation.id);
  calculation.salesAmount = roundMoneyValue(items.reduce((sum, item) => sum + Number(item.salesAmount || 0), 0));
  calculation.autoCommission = roundMoneyValue(items.reduce((sum, item) => sum + Number(item.autoAmount || 0), 0));
  calculation.manualAdjustment = roundMoneyValue(items.reduce((sum, item) => sum + Number(item.manualAmount || 0), 0));
  calculation.finalCommission = roundMoneyValue(items.reduce((sum, item) => sum + Number(item.finalAmount || 0), 0));
  calculation.calculatedAt = new Date().toISOString();
  calculation.status = calculation.status === "locked" || calculation.status === "reviewed" ? calculation.status : "calculated";
}

function ensureCalculation(month: string, ownerId: string, teamId: string) {
  const store = getStore();
  let calculation = store.commissionCalculations.find((item) => item.month === month && item.ownerId === ownerId && item.isCurrent !== false);
  if (!calculation) {
    const version = Math.max(0, ...store.commissionCalculations.filter((item) => item.month === month && item.ownerId === ownerId).map((item) => item.version || 1)) + 1;
    calculation = {
      id: `cc_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`,
      month,
      ownerId,
      teamId,
      salesAmount: 0,
      autoCommission: 0,
      manualAdjustment: 0,
      finalCommission: 0,
      status: "pending",
      version,
      isCurrent: true,
      calculatedAt: "",
      reviewedBy: "",
      reviewedAt: "",
      lockedBy: "",
      lockedAt: "",
      unlockReason: ""
    };
    store.commissionCalculations.unshift(calculation);
  }
  return calculation;
}

const commissionProductSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional().default(""),
  model: z.string().optional().default(""),
  currency: z.string().optional().default("USD"),
  defaultPrice: z.coerce.number().nonnegative().default(0),
  costPrice: z.coerce.number().nonnegative().default(0),
  status: z.enum(["active", "disabled"]).default("active"),
  remark: z.string().optional().default("")
});

function validateCommissionTiers(tierJson: string, context: z.RefinementCtx) {
  try {
    const tiers = JSON.parse(tierJson || "[]") as Array<{ from?: number; to?: number; rate?: number }>;
    if (!Array.isArray(tiers) || !tiers.length || tiers.some((tier) => Number(tier.rate) < 0 || Number(tier.rate) > 1)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tierJson"], message: "阶梯费率必须在 0% 到 100% 之间" });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["tierJson"], message: "阶梯规则格式不正确" });
  }
}

const commissionRuleBaseSchema = z.object({
  ruleType: z.enum(["rate", "fixed", "tier", "gross_profit", "none"]),
  rate: z.coerce.number().min(0).max(1).default(0),
  fixedAmount: z.coerce.number().nonnegative().default(0),
  tierJson: z.string().optional().default(""),
  grossProfitRate: z.coerce.number().min(0).max(1).default(0),
  effectiveFrom: z.string().optional().default(currentMonthValue()),
  effectiveTo: z.string().optional().default(""),
  enabled: z.coerce.boolean().default(true),
  remark: z.string().optional().default("")
});
const commissionRuleSchema = commissionRuleBaseSchema.superRefine((value, context) => {
  if (value.ruleType === "tier") validateCommissionTiers(value.tierJson, context);
});
const commissionRulePatchSchema = commissionRuleBaseSchema.partial().superRefine((value, context) => {
  if (value.ruleType === "tier") validateCommissionTiers(value.tierJson || "", context);
});

const salesRecordSchema = z.object({
  ownerId: z.string().optional().default(""),
  month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthValue()),
  customerId: z.string().optional().default(""),
  customerName: z.string().min(1),
  productId: z.string().optional().default(""),
  productName: z.string().min(1),
  quantity: z.coerce.number().nonnegative().default(1),
  unitPrice: z.coerce.number().nonnegative().default(0),
  salesAmount: z.coerce.number().nonnegative().optional(),
  currency: z.string().optional().default("USD"),
  exchangeRate: z.coerce.number().positive().default(1),
  exchangeRateDate: z.string().optional().default(""),
  exchangeRateSource: z.enum(["pending", "manual", "finance"]).default("manual"),
  settlementCurrency: z.literal("CNY").default("CNY"),
  basisType: z.enum(["deal_amount", "receipt"]).default("receipt"),
  basisDate: z.string().optional().default(""),
  status: z.enum(["draft", "confirmed"]).default("draft"),
  editNote: z.string().optional().default("")
});

app.get("/api/commission/products", requireAuth, (req, res) => {
  const store = getStore();
  const products = visibleCommissionProducts(req.user!);
  const productIds = new Set(products.map((product) => product.id));
  res.json({
    products,
    rules: store.commissionRules.filter((rule) => productIds.has(rule.productId)),
    canManage: canManageCommissionRules(req.user),
    canSelectOwner: canReviewCommission(req.user),
    owners: commissionOwnersFor(req.user!)
  });
});

app.post("/api/commission/products", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageCommissionRules(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以维护提成产品" });
    return;
  }
  const body = commissionProductSchema.parse(req.body);
  const store = getStore();
  const product: CommissionProduct = {
    id: `cp_${Date.now()}`,
    ...body,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString()
  };
  store.commissionProducts.unshift(product);
  await store.persist();
  res.json({ product });
}));

app.patch("/api/commission/products/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageCommissionRules(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以维护提成产品" });
    return;
  }
  const body = commissionProductSchema.partial().parse(req.body);
  const store = getStore();
  const product = store.commissionProducts.find((item) => item.id === req.params.id);
  if (!product || !canManageCommissionProduct(req.user!, product)) {
    res.status(404).json({ message: "产品不存在" });
    return;
  }
  Object.assign(product, body, { updatedAt: new Date().toISOString() });
  await store.persist();
  res.json({ product });
}));

app.post("/api/commission/products/:id/rules", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageCommissionRules(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以维护提成规则" });
    return;
  }
  const store = getStore();
  const product = store.commissionProducts.find((item) => item.id === req.params.id);
  if (!product || !canManageCommissionProduct(req.user!, product)) {
    res.status(404).json({ message: "产品不存在" });
    return;
  }
  const body = commissionRuleSchema.parse(req.body);
  const rule: CommissionRule = {
    id: `cr_${Date.now()}`,
    productId: product.id,
    ...body,
    createdBy: req.user!.id,
    createdAt: new Date().toISOString()
  };
  if (rule.enabled) {
    store.commissionRules.filter((item) => item.productId === product.id && item.enabled).forEach((item) => { item.enabled = false; });
  }
  store.commissionRules.unshift(rule);
  await store.persist();
  res.json({ rule });
}));

app.patch("/api/commission/rules/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageCommissionRules(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以维护提成规则" });
    return;
  }
  const body = commissionRulePatchSchema.parse(req.body);
  const store = getStore();
  const rule = store.commissionRules.find((item) => item.id === req.params.id);
  const product = rule ? store.commissionProducts.find((item) => item.id === rule.productId) : undefined;
  if (!rule || !product || !canManageCommissionProduct(req.user!, product)) {
    res.status(404).json({ message: "提成规则不存在" });
    return;
  }
  const alreadyUsed = store.commissionItems.some((item) => item.productId === rule.productId && item.ruleSnapshotJson.includes(`"id":"${rule.id}"`));
  if (alreadyUsed && Object.keys(body).some((key) => key !== "enabled")) {
    rule.enabled = false;
    const nextRule: CommissionRule = {
      ...rule,
      ...body,
      id: `cr_${Date.now()}`,
      createdBy: req.user!.id,
      createdAt: new Date().toISOString()
    };
    if (nextRule.enabled) {
      store.commissionRules.filter((item) => item.productId === rule.productId && item.id !== rule.id).forEach((item) => { item.enabled = false; });
    }
    store.commissionRules.unshift(nextRule);
    await store.persist();
    res.json({ rule: nextRule, replacedRuleId: rule.id });
    return;
  }
  if (body.enabled) {
    store.commissionRules.filter((item) => item.productId === rule.productId && item.id !== rule.id).forEach((item) => { item.enabled = false; });
  }
  Object.assign(rule, body);
  await store.persist();
  res.json({ rule });
}));

app.get("/api/commission/sales-records", requireAuth, (req, res) => {
  const month = typeof req.query.month === "string" ? req.query.month : currentMonthValue();
  const ownerId = typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const records = visibleSalesRecords(req.user!, month, ownerId);
  if (!records) {
    res.status(403).json({ message: "无权查看该人员的提成数据" });
    return;
  }
  res.json({ records, owners: commissionOwnersFor(req.user!), canSelectOwner: canReviewCommission(req.user), selectedOwnerId: resolveCommissionOwnerId(req.user!, ownerId) || "all" });
});

app.post("/api/commission/sales-records/sync-from-deals", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthValue()), ownerId: z.string().optional().default("") }).parse(req.body);
  const ownerId = resolveCommissionOwnerId(req.user!, body.ownerId);
  if (ownerId === null) {
    res.status(403).json({ message: "无权同步该人员的提成数据" });
    return;
  }
  const month = body.month;
  const store = getStore();
  const archivedWonDeals = store.deals.filter((deal) => {
    if (deal.stage !== "成交" || !deal.archivedAt) return false;
    if (ownerId && deal.ownerId !== ownerId) return false;
    if (!canAccessCommissionOwner(req.user!, deal.ownerId)) return false;
    return deal.archivedAt.slice(0, 7) === month;
  });
  const created: MonthlySalesRecord[] = [];
  for (const deal of archivedWonDeals) {
    if (store.monthlySalesRecords.some((record) => record.dealId === deal.id)) continue;
    const customer = store.customers.find((item) => item.id === deal.customerId);
    const product = findCommissionProduct(deal.product, req.user!);
    const salesAmount = roundMoneyValue(Number(deal.amount || deal.quantity * deal.unitPrice || 0));
    const record: MonthlySalesRecord = {
      id: `msr_${Date.now()}_${created.length}`,
      month,
      ownerId: deal.ownerId,
      teamId: deal.teamId,
      customerId: customer?.id || "",
      customerName: customer?.company || "未关联客户",
      dealId: deal.id,
      productId: product?.id || "",
      productName: product?.name || deal.product || deal.title,
      quantity: Number(deal.quantity || 0),
      unitPrice: Number(deal.unitPrice || 0),
      salesAmount,
      currency: deal.currency || product?.currency || "USD",
      exchangeRate: deal.currency === "CNY" ? 1 : 1,
      exchangeRateDate: "",
      exchangeRateSource: deal.currency === "CNY" ? "finance" : "pending",
      settlementCurrency: "CNY",
      settlementAmount: salesAmount,
      basisType: "deal_amount",
      basisDate: deal.archivedAt?.slice(0, 10) || "",
      dealArchivedAt: deal.archivedAt || "",
      sourceType: "deal",
      status: "draft",
      edited: false,
      editNote: "",
      lastEditedBy: "",
      lastEditedAt: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.monthlySalesRecords.unshift(record);
    created.push(record);
  }
  await store.persist();
  res.json({ created, records: visibleSalesRecords(req.user!, month, body.ownerId) || [] });
}));

app.post("/api/commission/sales-records", requireAuth, asyncRoute(async (req, res) => {
  const body = salesRecordSchema.parse(req.body);
  const targetOwnerId = resolveCommissionOwnerId(req.user!, body.ownerId);
  if (targetOwnerId === null || targetOwnerId === "") {
    res.status(403).json({ message: "请先选择一个具体人员，再新增销售记录" });
    return;
  }
  const targetUser = getStore().users.find((user) => user.id === targetOwnerId);
  if (!targetUser) {
    res.status(404).json({ message: "人员不存在" });
    return;
  }
  const salesAmount = roundMoneyValue(body.salesAmount ?? body.quantity * body.unitPrice);
  const record: MonthlySalesRecord = {
    id: `msr_${Date.now()}`,
    month: body.month,
    ownerId: targetUser.id,
    teamId: targetUser.teamId,
    customerId: body.customerId,
    customerName: body.customerName,
    dealId: "",
    productId: body.productId,
    productName: body.productName,
    quantity: body.quantity,
    unitPrice: body.unitPrice,
    salesAmount,
    currency: body.currency,
    exchangeRate: body.exchangeRate,
    exchangeRateDate: body.exchangeRateDate,
    exchangeRateSource: body.exchangeRateSource,
    settlementCurrency: body.settlementCurrency,
    settlementAmount: roundMoneyValue(salesAmount * body.exchangeRate),
    basisType: body.basisType,
    basisDate: body.basisDate,
    dealArchivedAt: "",
    sourceType: "manual",
    status: body.status,
    edited: false,
    editNote: body.editNote,
    lastEditedBy: "",
    lastEditedAt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const store = getStore();
  store.monthlySalesRecords.unshift(record);
  await store.persist();
  res.json({ record });
}));

app.patch("/api/commission/sales-records/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = salesRecordSchema.partial().extend({ editNote: z.string().min(2) }).parse(req.body);
  const store = getStore();
  const record = store.monthlySalesRecords.find((item) => item.id === req.params.id);
  if (!record || !canAccessCommissionOwner(req.user!, record.ownerId)) {
    res.status(404).json({ message: "销售记录不存在" });
    return;
  }
  if (record.status === "locked" || store.commissionCalculations.some((item) => item.month === record.month && item.ownerId === record.ownerId && item.isCurrent !== false && item.status === "locked")) {
    res.status(400).json({ message: "已锁定记录不能编辑" });
    return;
  }
  const updates: Partial<MonthlySalesRecord> = {};
  const auditFields: Array<keyof MonthlySalesRecord> = ["customerName", "productName", "quantity", "unitPrice", "salesAmount", "currency", "exchangeRate", "exchangeRateDate", "exchangeRateSource", "basisType", "basisDate", "status", "productId", "customerId"];
  for (const field of auditFields) {
    if (body[field as keyof typeof body] !== undefined) {
      const nextValue = body[field as keyof typeof body] as never;
      if (String(record[field] ?? "") !== String(nextValue ?? "")) {
        (updates as Record<string, unknown>)[field] = nextValue;
        const audit: SalesRecordAudit = {
          id: `sra_${Date.now()}_${field}`,
          recordId: record.id,
          fieldName: String(field),
          oldValue: String(record[field] ?? ""),
          newValue: String(nextValue ?? ""),
          reason: body.editNote,
          operatorId: req.user!.id,
          operatorName: req.user!.name,
          createdAt: new Date().toISOString()
        };
        store.salesRecordAudits.unshift(audit);
      }
    }
  }
  Object.assign(record, updates);
  if (body.quantity !== undefined || body.unitPrice !== undefined || body.salesAmount !== undefined || body.exchangeRate !== undefined) {
    record.salesAmount = body.salesAmount !== undefined
      ? roundMoneyValue(body.salesAmount)
      : roundMoneyValue(record.quantity * record.unitPrice);
    record.settlementAmount = roundMoneyValue(record.salesAmount * record.exchangeRate);
  }
  record.edited = true;
  record.sourceType = record.sourceType === "manual" ? "manual" : "adjusted";
  record.editNote = body.editNote;
  record.lastEditedBy = req.user!.id;
  record.lastEditedAt = new Date().toISOString();
  record.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ record, audits: store.salesRecordAudits.filter((audit) => audit.recordId === record.id) });
}));

app.post("/api/commission/sales-records/:id/confirm", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const record = store.monthlySalesRecords.find((item) => item.id === req.params.id);
  if (!record || !canAccessCommissionOwner(req.user!, record.ownerId)) {
    res.status(404).json({ message: "销售记录不存在" });
    return;
  }
  if (record.status === "locked") {
    res.status(400).json({ message: "已锁定记录不能重复确认" });
    return;
  }
  if (store.commissionCalculations.some((item) =>
    item.month === record.month
    && item.ownerId === record.ownerId
    && item.isCurrent !== false
    && item.status === "locked"
  )) {
    res.status(400).json({ message: "本月提成单已锁定，请先解锁后再确认新记录" });
    return;
  }
  if (record.currency !== "CNY" && (record.exchangeRateSource === "pending" || !record.exchangeRateDate)) {
    res.status(400).json({ message: "外币记录确认前必须填写汇率日期，并将汇率来源标记为手工或财务" });
    return;
  }
  if (!record.basisDate) {
    res.status(400).json({ message: "确认前必须填写计提依据日期" });
    return;
  }
  record.status = "confirmed";
  record.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ record });
}));

app.get("/api/commission/sales-records/:id/audits", requireAuth, (req, res) => {
  const store = getStore();
  const record = store.monthlySalesRecords.find((item) => item.id === req.params.id);
  if (!record || !canAccessCommissionOwner(req.user!, record.ownerId)) {
    res.status(404).json({ message: "销售记录不存在" });
    return;
  }
  res.json({ audits: store.salesRecordAudits.filter((audit) => audit.recordId === record.id) });
});

app.get("/api/commission/calculations", requireAuth, (req, res) => {
  const month = typeof req.query.month === "string" ? req.query.month : currentMonthValue();
  const ownerId = typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const scopedOwnerId = resolveCommissionOwnerId(req.user!, ownerId);
  if (scopedOwnerId === null) {
    res.status(403).json({ message: "无权查看该人员的提成计算单" });
    return;
  }
  const allowedOwners = new Set(commissionOwnersFor(req.user!).map((item) => item.id));
  const allCalculations = getStore().commissionCalculations.filter((calculation) => {
    if (calculation.month !== month) return false;
    if (scopedOwnerId && calculation.ownerId !== scopedOwnerId) return false;
    if (!scopedOwnerId && canReviewCommission(req.user) && !allowedOwners.has(calculation.ownerId)) return false;
    return canAccessCommissionOwner(req.user!, calculation.ownerId);
  });
  const calculations = allCalculations.filter((calculation) => calculation.isCurrent !== false);
  const ids = new Set(calculations.map((item) => item.id));
  res.json({
    calculations,
    historyCalculations: allCalculations.filter((calculation) => calculation.isCurrent === false),
    items: getStore().commissionItems.filter((item) => ids.has(item.calculationId)),
    canReview: canReviewCommission(req.user),
    canSelectOwner: canReviewCommission(req.user),
    owners: commissionOwnersFor(req.user!),
    selectedOwnerId: scopedOwnerId || "all"
  });
});

app.post("/api/commission/calculations/recalculate", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthValue()), ownerId: z.string().optional().default("") }).parse(req.body);
  const ownerId = resolveCommissionOwnerId(req.user!, body.ownerId);
  if (ownerId === null) {
    res.status(403).json({ message: "无权计算该人员的提成数据" });
    return;
  }
  const month = body.month;
  const store = getStore();
  const visibleRecords = visibleSalesRecords(req.user!, month, body.ownerId);
  if (!visibleRecords) {
    res.status(403).json({ message: "无权计算该人员的提成数据" });
    return;
  }
  const records = visibleRecords.filter((record) => record.status === "confirmed" || record.status === "reviewed" || record.status === "locked");
  const byOwner = new Map<string, MonthlySalesRecord[]>();
  records.forEach((record) => byOwner.set(record.ownerId, [...(byOwner.get(record.ownerId) || []), record]));
  const changedCalculations: CommissionCalculation[] = [];
  for (const [ownerId, ownerRecords] of byOwner.entries()) {
    const calculation = ensureCalculation(month, ownerId, ownerRecords[0].teamId);
    if (calculation.status === "locked" || calculation.status === "reviewed") {
      res.status(409).json({ message: "已复核或已锁定的提成单不能覆盖重算；如需修正，请先解锁生成新版本" });
      return;
    }
    store.commissionItems = store.commissionItems.filter((item) => item.calculationId !== calculation.id || item.sourceType !== "auto");
    ownerRecords.forEach((record, index) => {
      const product = visibleCommissionProducts(req.user!).find((item) => item.id === record.productId) || findCommissionProduct(record.productName, req.user!);
      const rule = product ? activeCommissionRule(product.id, month) : undefined;
      const computed = calculateCommissionAmount(record, product, rule);
      const item: CommissionItem = {
        id: `ci_${Date.now()}_${index}_${Math.random().toString(16).slice(2, 6)}`,
        calculationId: calculation.id,
        recordId: record.id,
        productId: product?.id || record.productId || "",
        itemType: "auto",
        sourceType: "auto",
        ruleSnapshotJson: JSON.stringify(computed.snapshot),
        salesAmount: record.settlementAmount,
        autoAmount: computed.amount,
        manualAmount: 0,
        finalAmount: computed.amount,
        remark: rule ? rule.remark || "自动按规则计算" : "未匹配启用规则，金额为0",
        createdBy: req.user!.id,
        createdAt: new Date().toISOString()
      };
      store.commissionItems.unshift(item);
    });
    rebuildCalculationTotals(calculation);
    changedCalculations.push(calculation);
  }
  await store.persist();
  const allowedOwners = new Set(commissionOwnersFor(req.user!).map((item) => item.id));
  const calculations = store.commissionCalculations.filter((calculation) => {
    if (calculation.month !== month) return false;
    if (ownerId && calculation.ownerId !== ownerId) return false;
    if (!ownerId && canReviewCommission(req.user) && !allowedOwners.has(calculation.ownerId)) return false;
    return canAccessCommissionOwner(req.user!, calculation.ownerId);
  });
  const ids = new Set(calculations.map((item) => item.id));
  res.json({ calculations, items: store.commissionItems.filter((item) => ids.has(item.calculationId)), changedCalculations });
}));

app.post("/api/commission/calculations/:id/manual-item", requireAuth, asyncRoute(async (req, res) => {
  if (!canReviewCommission(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以调整提成金额" });
    return;
  }
  const body = z.object({
    itemType: z.enum(["bonus", "deduction", "subsidy", "refund", "special", "other"]).default("other"),
    manualAmount: z.coerce.number().default(0),
    recordId: z.string().optional().default(""),
    remark: z.string().trim().min(2)
  }).parse(req.body);
  const store = getStore();
  const calculation = store.commissionCalculations.find((item) => item.id === req.params.id);
  if (!calculation || !canAccessCommissionOwner(req.user!, calculation.ownerId)) {
    res.status(404).json({ message: "提成计算单不存在" });
    return;
  }
  if (calculation.status === "locked") {
    res.status(400).json({ message: "已锁定计算单不能调整" });
    return;
  }
  if (body.itemType === "deduction" || body.itemType === "refund") {
    body.manualAmount = -Math.abs(body.manualAmount);
  }
  const item: CommissionItem = {
    id: `ci_manual_${Date.now()}`,
    calculationId: calculation.id,
    recordId: body.recordId,
    productId: "",
    itemType: body.itemType,
    sourceType: "manual",
    ruleSnapshotJson: "",
    salesAmount: 0,
    autoAmount: 0,
    manualAmount: roundMoneyValue(body.manualAmount),
    finalAmount: roundMoneyValue(body.manualAmount),
    remark: body.remark,
    createdBy: req.user!.id,
    createdAt: new Date().toISOString()
  };
  store.commissionItems.unshift(item);
  rebuildCalculationTotals(calculation);
  await store.persist();
  res.json({ calculation, item });
}));

app.post("/api/commission/calculations/:id/review", requireAuth, asyncRoute(async (req, res) => {
  if (!canReviewCommission(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以复核提成单" });
    return;
  }
  const store = getStore();
  const calculation = store.commissionCalculations.find((item) => item.id === req.params.id && item.isCurrent !== false);
  if (!calculation || !canAccessCommissionOwner(req.user!, calculation.ownerId)) {
    res.status(404).json({ message: "提成计算单不存在" });
    return;
  }
  if (calculation.status !== "calculated") {
    res.status(400).json({ message: "只有已计算的提成单可以复核" });
    return;
  }
  calculation.status = "reviewed";
  calculation.reviewedBy = req.user!.id;
  calculation.reviewedAt = new Date().toISOString();
  store.monthlySalesRecords
    .filter((record) => record.month === calculation.month && record.ownerId === calculation.ownerId && record.status === "confirmed")
    .forEach((record) => { record.status = "reviewed"; record.updatedAt = new Date().toISOString(); });
  await store.persist();
  res.json({ calculation });
}));

app.post("/api/commission/calculations/:id/lock", requireAuth, asyncRoute(async (req, res) => {
  if (!canReviewCommission(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以锁定提成单" });
    return;
  }
  const store = getStore();
  const calculation = store.commissionCalculations.find((item) => item.id === req.params.id && item.isCurrent !== false);
  if (!calculation || !canAccessCommissionOwner(req.user!, calculation.ownerId)) {
    res.status(404).json({ message: "提成计算单不存在" });
    return;
  }
  if (calculation.status !== "reviewed") {
    res.status(400).json({ message: "提成单必须先复核再锁定" });
    return;
  }
  calculation.status = "locked";
  calculation.lockedBy = req.user!.id;
  calculation.lockedAt = new Date().toISOString();
  store.monthlySalesRecords
    .filter((record) => record.month === calculation.month && record.ownerId === calculation.ownerId && record.status === "reviewed")
    .forEach((record) => { record.status = "locked"; record.updatedAt = new Date().toISOString(); });
  await store.persist();
  res.json({ calculation });
}));

app.post("/api/commission/calculations/:id/unlock", requireAuth, asyncRoute(async (req, res) => {
  if (!canReviewCommission(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以解锁提成单" });
    return;
  }
  const body = z.object({ reason: z.string().trim().min(4) }).parse(req.body);
  const store = getStore();
  const calculation = store.commissionCalculations.find((item) => item.id === req.params.id && item.isCurrent !== false);
  if (!calculation || !canAccessCommissionOwner(req.user!, calculation.ownerId)) {
    res.status(404).json({ message: "提成计算单不存在" });
    return;
  }
  if (calculation.status !== "locked") {
    res.status(400).json({ message: "只有已锁定提成单可以解锁" });
    return;
  }
  calculation.isCurrent = false;
  calculation.unlockReason = `${body.reason}；操作人：${req.user!.name}；时间：${new Date().toISOString()}`;
  const nextCalculation = ensureCalculation(calculation.month, calculation.ownerId, calculation.teamId);
  store.monthlySalesRecords
    .filter((record) => record.month === calculation.month && record.ownerId === calculation.ownerId && record.status === "locked")
    .forEach((record) => { record.status = "confirmed"; record.updatedAt = new Date().toISOString(); });
  await store.persist();
  res.json({ calculation: nextCalculation, historyCalculation: calculation });
}));

app.post("/api/commission/export", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthValue()),
    scopeType: z.enum(["self", "team", "all"]).default("self"),
    ownerId: z.string().optional().default(""),
    fileType: z.enum(["xlsx", "csv"]).default("xlsx")
  }).parse(req.body);
  const store = getStore();
  const ownerId = body.scopeType === "all" && canReviewCommission(req.user) ? "" : body.ownerId;
  const records = visibleSalesRecords(req.user!, body.month, ownerId);
  if (!records) {
    res.status(403).json({ message: "无权导出该人员的提成数据" });
    return;
  }
  const calculationByOwner = new Map(store.commissionCalculations.filter((item) => item.month === body.month).map((item) => [item.ownerId, item]));
  const itemByRecord = new Map(store.commissionItems.filter((item) => item.recordId).map((item) => [item.recordId, item]));
  const rows = records.map((record) => {
    const calculation = calculationByOwner.get(record.ownerId);
    const commissionItem = itemByRecord.get(record.id);
    const owner = store.users.find((item) => item.id === record.ownerId);
    return {
      month: record.month,
      ownerName: owner?.name || record.ownerId,
      customerName: record.customerName,
      productName: record.productName,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      currency: record.currency,
      salesAmount: record.salesAmount,
      exchangeRate: record.exchangeRate,
      exchangeRateDate: record.exchangeRateDate,
      exchangeRateSource: record.exchangeRateSource,
      settlementCurrency: record.settlementCurrency,
      settlementAmount: record.settlementAmount,
      basisType: record.basisType,
      basisDate: record.basisDate,
      status: record.status,
      edited: record.edited,
      recordCommission: commissionItem?.finalAmount || 0,
      calculationStatus: calculation?.status || "pending",
      editNote: record.editNote
    };
  });
  const summaryRows = [...new Set(records.map((record) => record.ownerId))].map((recordOwnerId) => {
    const calculation = calculationByOwner.get(recordOwnerId);
    const owner = store.users.find((item) => item.id === recordOwnerId);
    return {
      month: body.month,
      ownerName: owner?.name || recordOwnerId,
      settlementCurrency: "CNY",
      salesAmount: calculation?.salesAmount || 0,
      autoCommission: calculation?.autoCommission || 0,
      manualAdjustment: calculation?.manualAdjustment || 0,
      finalCommission: calculation?.finalCommission || 0,
      status: calculation?.status || "pending",
      version: calculation?.version || 1
    };
  });
  const exportJob = {
    id: `ce_${Date.now()}`,
    month: body.month,
    scopeType: canReviewCommission(req.user) ? body.scopeType : "self",
    scopeOwnerId: ownerId || (canReviewCommission(req.user) ? "all" : req.user!.id),
    fileType: body.fileType,
    rows: rows.length,
    exportedBy: req.user!.id,
    createdAt: new Date().toISOString()
  };
  store.commissionExports.unshift(exportJob);
  await store.persist();
  res.json({ exportJob, rows, summaryRows });
}));

app.post("/api/todos/:id/complete", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ completionResult: z.string().trim().max(255).optional() });
  const body = schema.parse(req.body || {});
  const store = getStore();
  const todo = store.todos.find((item) => item.id === req.params.id);
  if (!todo || !canSeePersonalData(req.user!, todo.ownerId)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  if (todo.reminderRuleId && !body.completionResult) {
    res.status(400).json({ message: "请填写本次跟进处理结果" });
    return;
  }
  todo.done = true;
  todo.status = "pending";
  todo.completedAt = new Date().toISOString();
  todo.completedBy = req.user!.id;
  todo.completionResult = body.completionResult || todo.completionResult;
  await store.persist();
  res.json({ todo });
}));

app.post("/api/todos/archive-due", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const scoped = store.todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
  const archived = archiveExpiredTodos(scoped, new Date());
  if (archived.length) await store.persist();
  res.json({ archived });
}));

app.post("/api/todos/:id/restore", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const todo = store.todos.find((item) => item.id === req.params.id);
  if (!todo || !canSeePersonalData(req.user!, todo.ownerId)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  if (todo.cancelledAt) {
    res.status(409).json({
      message: todo.cancellationReason
        ? `该待办已取消：${todo.cancellationReason}`
        : "该待办已取消，不能恢复"
    });
    return;
  }
  todo.historyAt = "";
  todo.dueAt = currentMinuteText();
  todo.sortOrder = nextTodoSortOrder(store.todos, todo.ownerId);
  todo.pinState = "";
  if (todo.status === "in_progress" && todo.done) todo.status = "pending";
  await store.persist();
  res.json({ todo });
}));

app.patch("/api/todos/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1).optional(),
    type: z.enum(["customer", "knowledge", "exam", "ocr", "other"]).optional(),
    priority: z.enum(["high", "medium", "normal"]).optional(),
    dueAt: z.string().optional(),
    related: z.string().optional(),
    done: z.boolean().optional(),
    status: z.enum(["pending", "in_progress"]).optional(),
    pinState: z.enum(["top", "bottom", ""]).optional(),
    sortOrder: z.number().optional(),
    historyAt: z.string().optional()
    ,
    snoozeReason: z.string().trim().max(255).optional(),
    completionResult: z.string().trim().max(255).optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const todo = store.todos.find((item) => item.id === req.params.id);
  if (!todo || !canSeePersonalData(req.user!, todo.ownerId)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  if (todo.cancelledAt
    && (body.done === false || body.historyAt === "")) {
    res.status(409).json({
      message: todo.cancellationReason
        ? `该待办已取消：${todo.cancellationReason}`
        : "该待办已取消，不能重新启用"
    });
    return;
  }
  if (typeof body.done === "boolean") {
    if (body.done && todo.reminderRuleId && !body.completionResult) {
      res.status(400).json({ message: "请填写本次跟进处理结果" });
      return;
    }
    todo.done = body.done;
    if (body.done) {
      todo.status = "pending";
      todo.completedAt = new Date().toISOString();
      todo.completedBy = req.user!.id;
      todo.completionResult = body.completionResult || "";
    } else {
      todo.completedAt = "";
      todo.completedBy = "";
      todo.completionResult = "";
    }
  }
  if (body.status) {
    todo.status = todo.done ? "pending" : body.status;
  }
  if (body.title) todo.title = body.title;
  if (body.type) todo.type = body.type;
  if (body.priority) todo.priority = body.priority;
  if (body.dueAt !== undefined) {
    if (todo.reminderRuleId && body.dueAt !== todo.dueAt) {
      if (!body.snoozeReason) {
        res.status(400).json({ message: "延期提醒请填写原因" });
        return;
      }
      todo.snoozedFrom = todo.dueAt;
      todo.snoozeReason = body.snoozeReason;
      todo.snoozeCount = (todo.snoozeCount || 0) + 1;
      todo.snoozedBy = req.user!.id;
    }
    todo.dueAt = body.dueAt;
  }
  if (body.related !== undefined) todo.related = body.related;
  if (body.pinState !== undefined) {
    todo.pinState = body.pinState;
  }
  if (typeof body.sortOrder === "number") {
    todo.sortOrder = body.sortOrder;
  }
  if (body.historyAt !== undefined) {
    todo.historyAt = body.historyAt;
  }
  if (body.historyAt === undefined && shouldArchiveTodo(todo)) {
    todo.historyAt = new Date().toISOString();
    todo.status = "pending";
    todo.pinState = "";
  }
  await store.persist();
  res.json({ todo });
}));

app.post("/api/todos/reorder", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    ids: z.array(z.string()).min(1),
    mode: z.enum(["manual", "top", "bottom"]).default("manual"),
    targetId: z.string().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const visibleTodos = store.todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
  const selected = body.ids.map((id) => visibleTodos.find((todo) => todo.id === id));
  if (selected.some((todo) => !todo)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  selected.forEach((todo, index) => {
    if (!todo) return;
    todo.sortOrder = index + 1;
    if (body.mode === "manual") {
      todo.pinState = "";
    } else if (todo.id === body.targetId) {
      todo.pinState = body.mode;
    }
  });
  await store.persist();
  res.json({ todos: selected.filter(Boolean) });
}));

app.delete("/api/todos/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.todos.findIndex((item) => item.id === req.params.id);
  const todo = index >= 0 ? store.todos[index] : null;
  if (!todo || !canSeePersonalData(req.user!, todo.ownerId)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  if (todo.reminderRuleId) {
    res.status(400).json({ message: "跟进提醒需完成或标记无需处理，不能直接删除" });
    return;
  }
  store.todos.splice(index, 1);
  await store.persist();
  res.json({ ok: true, id: req.params.id });
}));

app.get("/api/problems", requireAuth, (req, res) => {
  const { problems } = getStore();
  const scoped = problems.filter((problem) => canSeeOwner(req.user!, problem.ownerId, problem.teamId));
  res.json({ problems: scoped });
});

app.post("/api/problems", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    category: z.string().min(1).default("客户问题"),
    severity: z.enum(["high", "medium", "low"]).default("medium"),
    status: z.enum(["open", "solving", "resolved"]).default("open"),
    relatedCustomer: z.string().default(""),
    rootCause: z.string().default(""),
    solution: z.string().default(""),
    nextAction: z.string().default(""),
    dueAt: z.string().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const problem = {
    id: `p_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    createdAt: new Date().toISOString(),
    ...body
  };
  store.problems.unshift(problem);
  await store.persist();
  res.json({ problem });
}));

app.patch("/api/problems/:id/status", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ status: z.enum(["open", "solving", "resolved"]) });
  const body = schema.parse(req.body);
  const store = getStore();
  const problem = store.problems.find((item) => item.id === req.params.id);
  if (!problem || !canSeeOwner(req.user!, problem.ownerId, problem.teamId)) {
    res.status(404).json({ message: "问题不存在" });
    return;
  }
  problem.status = body.status;
  await store.persist();
  res.json({ problem });
}));

app.get("/api/memos", requireAuth, (req, res) => {
  const { memos } = getStore();
  const trash = req.query.trash === "true";
  const scoped = memos.filter((memo) => canSeePersonalData(req.user!, memo.ownerId) && (trash ? Boolean(memo.deletedAt) : !memo.deletedAt));
  res.json({ memos: scoped });
});

app.post("/api/memos", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    content: z.string().default(""),
    category: z.string().min(1).default("客户备忘"),
    tags: z.string().default(""),
    customerId: z.string().trim().default(""),
    dealId: z.string().trim().default(""),
    pinned: z.boolean().default(false)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  let customerId = body.customerId;
  if (body.dealId) {
    const deal = store.deals.find((item) => item.id === body.dealId && canSeeOwner(req.user!, item.ownerId, item.teamId));
    if (!deal) {
      res.status(400).json({ message: "关联商机不存在或无权访问" });
      return;
    }
    if (customerId && customerId !== deal.customerId) {
      res.status(400).json({ message: "关联客户与商机不一致" });
      return;
    }
    customerId = deal.customerId;
  }
  if (customerId && !store.customers.some((item) => item.id === customerId && canSeeOwner(req.user!, item.ownerId, item.teamId))) {
    res.status(400).json({ message: "关联客户不存在或无权访问" });
    return;
  }
  const memo = {
    id: `m_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    archived: false,
    deletedAt: "",
    updatedAt: new Date().toISOString(),
    ...body,
    customerId
  };
  store.memos.unshift(memo);
  await store.persist();
  res.json({ memo });
}));

app.patch("/api/memos/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1).optional(),
    content: z.string().optional(),
    category: z.string().min(1).optional(),
    tags: z.string().optional(),
    customerId: z.string().trim().optional(),
    dealId: z.string().trim().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const memo = store.memos.find((item) => item.id === req.params.id);
  if (!memo || !canSeePersonalData(req.user!, memo.ownerId) || memo.deletedAt) {
    res.status(404).json({ message: "备忘录不存在" });
    return;
  }
  const hasCustomerId = Object.prototype.hasOwnProperty.call(body, "customerId");
  const hasDealId = Object.prototype.hasOwnProperty.call(body, "dealId");
  let customerId = hasCustomerId ? body.customerId || "" : memo.customerId;
  const dealId = hasDealId ? body.dealId || "" : memo.dealId;
  if (dealId) {
    const deal = store.deals.find((item) => item.id === dealId && canSeeOwner(req.user!, item.ownerId, item.teamId));
    if (!deal) {
      res.status(400).json({ message: "关联商机不存在或无权访问" });
      return;
    }
    if (customerId && customerId !== deal.customerId) {
      res.status(400).json({ message: "关联客户与商机不一致" });
      return;
    }
    customerId = deal.customerId;
  }
  if (customerId && !store.customers.some((item) => item.id === customerId && canSeeOwner(req.user!, item.ownerId, item.teamId))) {
    res.status(400).json({ message: "关联客户不存在或无权访问" });
    return;
  }
  if (typeof body.title === "string") memo.title = body.title;
  if (typeof body.content === "string") memo.content = body.content;
  if (typeof body.category === "string") memo.category = body.category;
  if (typeof body.tags === "string") memo.tags = body.tags;
  if (hasCustomerId || hasDealId) memo.customerId = customerId;
  if (hasDealId) memo.dealId = dealId;
  if (typeof body.pinned === "boolean") memo.pinned = body.pinned;
  if (typeof body.archived === "boolean") memo.archived = body.archived;
  memo.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ memo });
}));

app.delete("/api/memos/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const memo = store.memos.find((item) => item.id === req.params.id);
  if (!memo || !canSeePersonalData(req.user!, memo.ownerId)) {
    res.status(404).json({ message: "备忘录不存在" });
    return;
  }
  if (!memo.deletedAt) {
    memo.deletedAt = new Date().toISOString();
    memo.updatedAt = memo.deletedAt;
  }
  await store.persist();
  res.json({ ok: true, memo });
}));

app.post("/api/memos/:id/restore", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const memo = store.memos.find((item) => item.id === req.params.id);
  if (!memo || !canSeePersonalData(req.user!, memo.ownerId) || !memo.deletedAt) {
    res.status(404).json({ message: "已删除备忘录不存在" });
    return;
  }
  memo.deletedAt = "";
  memo.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ memo });
}));

app.delete("/api/memos/:id/permanent", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.memos.findIndex((item) => item.id === req.params.id);
  const memo = index >= 0 ? store.memos[index] : null;
  if (!memo || !canSeePersonalData(req.user!, memo.ownerId) || !memo.deletedAt) {
    res.status(404).json({ message: "已删除备忘录不存在" });
    return;
  }
  store.memos.splice(index, 1);
  await store.persist();
  res.json({ ok: true, id: req.params.id });
}));

app.get("/api/competitors", requireAuth, (req, res) => {
  const { competitors } = getStore();
  const scoped = competitors.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId));
  res.json({ competitors: scoped });
});

app.post("/api/competitors", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1),
    country: z.string().default(""),
    segment: z.string().default(""),
    threatLevel: z.enum(["high", "medium", "low"]).default("medium"),
    website: z.string().default(""),
    strengths: z.string().default(""),
    weaknesses: z.string().default(""),
    competingProducts: z.string().default(""),
    ourStrategy: z.string().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const competitor = {
    id: `cp_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString(),
    ...body
  };
  store.competitors.unshift(competitor);
  await store.persist();
  res.json({ competitor });
}));

app.patch("/api/competitors/:id/threat", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ threatLevel: z.enum(["high", "medium", "low"]) });
  const body = schema.parse(req.body);
  const store = getStore();
  const competitor = store.competitors.find((item) => item.id === req.params.id);
  if (!competitor || !canSeeOwner(req.user!, competitor.ownerId, competitor.teamId)) {
    res.status(404).json({ message: "竞争公司不存在" });
    return;
  }
  competitor.threatLevel = body.threatLevel;
  competitor.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ competitor });
}));

app.get("/api/case-studies", requireAuth, (req, res) => {
  const { caseStudies } = getStore();
  const scoped = caseStudies.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId));
  res.json({ caseStudies: scoped });
});

app.post("/api/case-studies", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    customer: z.string().default(""),
    country: z.string().default(""),
    product: z.string().default(""),
    industry: z.string().default(""),
    result: z.string().default(""),
    story: z.string().default(""),
    reusablePoints: z.string().default(""),
    status: z.enum(["draft", "published"]).default("draft")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const caseStudy = {
    id: `cs_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString(),
    ...body
  };
  store.caseStudies.unshift(caseStudy);
  await store.persist();
  res.json({ caseStudy });
}));

app.patch("/api/case-studies/:id/publish", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const caseStudy = store.caseStudies.find((item) => item.id === req.params.id);
  if (!caseStudy || !canSeeOwner(req.user!, caseStudy.ownerId, caseStudy.teamId)) {
    res.status(404).json({ message: "成功案例不存在" });
    return;
  }
  caseStudy.status = "published";
  caseStudy.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ caseStudy });
}));

app.get("/api/knowledge/assets", requireAuth, (_req, res) => {
  const { knowledgeAssets } = getStore();
  res.json({ assets: knowledgeAssets.filter((asset) => canSeeKnowledgeAsset(_req.user!, asset)) });
});

app.post("/api/knowledge/assets", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    category: z.string().min(1).default("产品知识"),
    version: z.string().min(1).default("v1")
  });
  const store = getStore();
  const body = schema.parse(req.body);
  const asset = {
    id: `k_${Date.now()}`,
    status: req.user?.role === "sales" ? "review" as const : "published" as const,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    ...body
  };
  store.knowledgeAssets.unshift(asset);
  await store.persist();
  res.json({ asset });
}));

app.patch("/api/knowledge/assets/:id/publish", requireAuth, asyncRoute(async (req, res) => {
  if (req.user?.role === "sales") {
    res.status(403).json({ message: "无发布资料权限" });
    return;
  }
  const store = getStore();
  const asset = store.knowledgeAssets.find((item) => item.id === req.params.id);
  if (!asset || !canSeeKnowledgeAsset(req.user!, asset)) {
    res.status(404).json({ message: "资料不存在" });
    return;
  }
  asset.status = "published";
  await store.persist();
  res.json({ asset });
}));

app.get("/api/exam-questions", requireAuth, (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const category = String(req.query.category || "").trim();
  const tag = String(req.query.tag || "").trim();
  const type = String(req.query.type || "").trim();
  let questions = bankQuestions(req.user!);
  if (category) questions = questions.filter((question) => question.category === category);
  if (tag) questions = questions.filter((question) => (question.tags || []).includes(tag));
  if (type) questions = questions.filter((question) => (question.questionType || (correctIndexesFor(question).length > 1 ? "multiple" : "single")) === type);
  res.json({ questions, report: examReport(req.user!) });
});

app.get("/api/exam-questions/export", requireAuth, (_req, res) => {
  if (!requireTrainingManager(_req, res)) return;
  res.json({ questions: bankQuestions(_req.user!) });
});

app.post("/api/exam-questions", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const store = getStore();
  const body = examQuestionSchema.parse(req.body);
  let question: ExamQuestion;
  try {
    question = { ...buildExamQuestion(body), ownerId: req.user!.id, teamId: req.user!.teamId };
  } catch (error) {
    res.status(400).json({ message: "正确答案序号超出选项数量" });
    return;
  }
  store.examQuestions.unshift(question);
  await store.persist();
  res.json({ question, report: examReport(req.user!) });
}));

app.post("/api/exam-questions/import", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const store = getStore();
  const schema = z.object({ questions: z.array(examQuestionSchema).min(1).max(500) });
  const body = schema.parse(req.body);
  const imported: ExamQuestion[] = [];
  for (const [index, item] of body.questions.entries()) {
    try {
      imported.push({ ...buildExamQuestion(item, index), ownerId: req.user!.id, teamId: req.user!.teamId });
    } catch (error) {
      res.status(400).json({ message: `第 ${index + 1} 行正确答案序号超出选项数量` });
      return;
    }
  }
  store.examQuestions.unshift(...imported);
  await store.persist();
  res.json({ importedCount: imported.length, questions: imported, report: examReport(req.user!) });
}));

app.patch("/api/exam-questions/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const store = getStore();
  const index = store.examQuestions.findIndex((question) => question.id === req.params.id && canManageExamQuestion(req.user!, question));
  if (index < 0) {
    res.status(404).json({ message: "题目不存在" });
    return;
  }
  const body = examQuestionSchema.parse(req.body);
  let question: ExamQuestion;
  try {
    question = {
      ...buildExamQuestion(body),
      id: store.examQuestions[index].id,
      examId: store.examQuestions[index].examId || "bank",
      ownerId: store.examQuestions[index].ownerId,
      teamId: store.examQuestions[index].teamId
    };
  } catch (error) {
    res.status(400).json({ message: "正确答案序号超出选项数量" });
    return;
  }
  store.examQuestions[index] = question;
  store.exams.forEach(refreshExamStats);
  await store.persist();
  res.json({ question, report: examReport(req.user!) });
}));

app.delete("/api/exam-questions/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const store = getStore();
  const index = store.examQuestions.findIndex((question) => question.id === req.params.id && canManageExamQuestion(req.user!, question));
  if (index < 0) {
    res.status(404).json({ message: "题目不存在" });
    return;
  }
  const [question] = store.examQuestions.splice(index, 1);
  store.examQuestionLinks = store.examQuestionLinks.filter((link) => link.questionId !== question.id);
  store.exams.forEach(refreshExamStats);
  await store.persist();
  res.json({ question, report: examReport(req.user!) });
}));

app.get("/api/exams", requireAuth, (_req, res) => {
  const { exams } = getStore();
  const scoped = exams.filter((exam) => canAccessExam(_req.user!, exam));
  res.json({ exams: scoped.map((exam) => examWithRuntimeStats(exam, _req.user!)), report: examReport(_req.user!) });
});

app.get("/api/exams/:id/detail", requireAuth, (req, res) => {
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id);
  if (!exam || !canAccessExam(req.user!, exam)) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const questions = examQuestionsFor(exam.id, req.user!).map((question) => canManageTraining(req.user)
    ? question
    : { ...question, answerIndex: -1, answerIndexes: [], explanation: "" });
  const attempts = store.examAttempts.filter((item) => item.examId === exam.id);
  const latestAttempt = attempts.find((item) => item.userId === req.user!.id) || null;
  res.json({ exam: examWithRuntimeStats(exam, req.user!), questions, latestAttempt, report: examReport(req.user!) });
});

app.post("/api/exams", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const store = getStore();
  const schema = z.object({
    title: z.string().min(1),
    category: z.string().min(1),
    questionIds: z.array(z.string()).min(1, "请至少选择 1 道题目"),
    durationMinutes: z.number().int().positive().default(20),
    passScore: z.number().int().min(1).max(100).default(80),
    targetRole: z.enum(["all", "sales", "manager"]).default("sales")
  });
  const body = schema.parse(req.body);
  const uniqueQuestionIds = [...new Set(body.questionIds)];
  const selectedQuestions = uniqueQuestionIds.map((id) => store.examQuestions.find((question) => question.id === id && canUseExamQuestion(req.user!, question)));
  if (selectedQuestions.some((question) => !question)) {
    res.status(400).json({ message: "包含不存在的题目，请刷新题库后重试" });
    return;
  }
  const now = new Date().toISOString();
  const exam: Exam = {
    id: `e_${Date.now()}`,
    title: body.title,
    category: body.category,
    status: "scheduled",
    passRate: 0,
    questionCount: uniqueQuestionIds.length,
    durationMinutes: body.durationMinutes,
    passScore: body.passScore,
    targetRole: body.targetRole,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: now
  };
  store.exams.unshift(exam);
  store.examQuestionLinks.unshift(...uniqueQuestionIds.map((questionId, index) => ({ examId: exam.id, questionId, sortOrder: index + 1 })));
  refreshExamStats(exam);
  await store.persist();
  res.json({ exam: examWithRuntimeStats(exam, req.user!), questions: examQuestionsFor(exam.id, req.user!), report: examReport(req.user!) });
}));

app.post("/api/exams/:id/questions", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id && canManageExam(req.user!, item));
  if (!exam) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const body = examQuestionSchema.parse({ ...req.body, category: req.body?.category || exam.category });
  let question: ExamQuestion;
  try {
    question = { ...buildExamQuestion(body), ownerId: req.user!.id, teamId: req.user!.teamId };
  } catch (error) {
    res.status(400).json({ message: "正确答案序号超出选项数量" });
    return;
  }
  store.examQuestions.unshift(question);
  store.examQuestionLinks.push({ examId: exam.id, questionId: question.id, sortOrder: examQuestionsFor(exam.id, req.user!).length + 1 });
  refreshExamStats(exam);
  await store.persist();
  res.json({ question, exam: examWithRuntimeStats(exam, req.user!), report: examReport(req.user!) });
}));

app.post("/api/exams/:id/questions/import", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id && canManageExam(req.user!, item));
  if (!exam) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const schema = z.object({ questions: z.array(examQuestionSchema).min(1).max(300) });
  const body = schema.parse(req.body);
  const imported: ExamQuestion[] = [];
  for (const [index, item] of body.questions.entries()) {
    try {
      imported.push({ ...buildExamQuestion({ ...item, category: item.category || exam.category }, index), ownerId: req.user!.id, teamId: req.user!.teamId });
    } catch (error) {
      res.status(400).json({ message: `第 ${index + 1} 行正确答案序号超出选项数量` });
      return;
    }
  }
  store.examQuestions.unshift(...imported);
  store.examQuestionLinks.push(...imported.map((question, index) => ({ examId: exam.id, questionId: question.id, sortOrder: examQuestionsFor(exam.id, req.user!).length + index + 1 })));
  refreshExamStats(exam);
  await store.persist();
  res.json({ importedCount: imported.length, questions: imported, exam: examWithRuntimeStats(exam, req.user!), report: examReport(req.user!) });
}));

app.patch("/api/exams/:id/publish", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id && canManageExam(req.user!, item));
  if (!exam) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  if (!examQuestionsFor(exam.id, req.user!).length) {
    res.status(400).json({ message: "请先勾选至少 1 道题目组卷" });
    return;
  }
  exam.status = "published";
  refreshExamStats(exam);
  await store.persist();
  res.json({ exam: examWithRuntimeStats(exam, req.user!), report: examReport(req.user!) });
}));

app.post("/api/exams/bulk-delete", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const store = getStore();
  const schema = z.object({ ids: z.array(z.string()).min(1).max(100) });
  const body = schema.parse(req.body);
  const ids = [...new Set(body.ids)];
  const deleted = store.exams.filter((exam) => ids.includes(exam.id) && canManageExam(req.user!, exam));
  if (!deleted.length) {
    res.status(404).json({ message: "未找到可删除的考试" });
    return;
  }
  const deletedIds = new Set(deleted.map((exam) => exam.id));
  store.exams = store.exams.filter((exam) => !deletedIds.has(exam.id));
  store.examQuestionLinks = store.examQuestionLinks.filter((link) => !deletedIds.has(link.examId));
  store.examAttempts = store.examAttempts.filter((attempt) => !deletedIds.has(attempt.examId));
  store.exams.forEach(refreshExamStats);
  await store.persist();
  const scoped = store.exams.filter((exam) => canAccessExam(req.user!, exam));
  res.json({ deleted, exams: scoped.map((exam) => examWithRuntimeStats(exam, req.user!)), report: examReport(req.user!) });
}));

app.delete("/api/exams/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
  const store = getStore();
  const index = store.exams.findIndex((item) => item.id === req.params.id && canManageExam(req.user!, item));
  if (index < 0) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const [exam] = store.exams.splice(index, 1);
  store.examQuestionLinks = store.examQuestionLinks.filter((link) => link.examId !== exam.id);
  store.examAttempts = store.examAttempts.filter((attempt) => attempt.examId !== exam.id);
  store.exams.forEach(refreshExamStats);
  await store.persist();
  const scoped = store.exams.filter((item) => canAccessExam(req.user!, item));
  res.json({ exam, exams: scoped.map((item) => examWithRuntimeStats(item, req.user!)), report: examReport(req.user!) });
}));

app.post("/api/exams/:id/submit", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id);
  if (!exam || !canAccessExam(req.user!, exam)) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const schema = z.object({
    answers: z.record(z.string(), z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative())])).default({})
  });
  const body = schema.parse(req.body);
  const questions = examQuestionsFor(exam.id, req.user!);
  if (!questions.length) {
    res.status(400).json({ message: "当前考试暂无题目" });
    return;
  }
  const answers = body.answers;
  const correctCount = questions.filter((question) => {
    const rawAnswer = answers[question.id];
    const selectedIndexes = Array.isArray(rawAnswer) ? rawAnswer : rawAnswer == null ? [] : [rawAnswer];
    return indexesEqual(selectedIndexes, correctIndexesFor(question));
  }).length;
  const score = Math.round((correctCount / questions.length) * 100);
  const attempt: ExamAttempt = {
    id: `attempt_${exam.id}_${req.user!.id}_${Date.now()}`,
    examId: exam.id,
    userId: req.user!.id,
    score,
    passed: score >= (exam.passScore || 80),
    answers,
    correctCount,
    totalQuestions: questions.length,
    submittedAt: new Date().toISOString()
  };
  store.examAttempts.unshift(attempt);
  refreshExamStats(exam);
  await store.persist();
  res.json({ attempt, exam: examWithRuntimeStats(exam, req.user!), questions, report: examReport(req.user!) });
}));

app.get("/api/reminders", requireAuth, (req, res) => {
  const { reminders } = getStore();
  const scoped = reminders.filter((reminder) => canSeeOwner(req.user!, reminder.ownerId, reminder.teamId));
  res.json({ reminders: scoped });
});

app.post("/api/reminders", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1).optional(),
    rule: z.string().min(1).optional(),
    dueAt: z.string().min(1).default("今天 17:00"),
    channel: z.literal("站内").default("站内"),
    ruleType: z.enum(["quote_no_reply", "sample_feedback", "inactive_customer", "high_value_revisit", "custom_due"]).default("quote_no_reply"),
    targetStage: z.string().default("已报价"),
    days: z.number().int().min(0).max(90).default(3),
    priority: z.enum(["high", "medium", "normal"]).default("medium"),
    enabled: z.boolean().default(true),
    targetOwnerId: z.string().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const targetOwnerId = resolveReminderTargetOwner(req.user!, body.targetOwnerId);
  if (!targetOwnerId) {
    res.status(400).json({ message: "提醒规则目标负责人无效" });
    return;
  }
  const generatedCount = matchReminderRule(targetOwnerId, body).length;
  const reminder = {
    id: `r_${Date.now()}`,
    title: body.title || reminderRuleTitle(body.ruleType),
    rule: body.rule || reminderRuleText(body),
    dueAt: body.dueAt,
    channel: body.channel,
    ruleType: body.ruleType,
    targetStage: body.targetStage,
    days: body.days,
    priority: body.priority,
    enabled: body.enabled,
    generatedCount,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    targetOwnerId,
    status: body.enabled ? "enabled" as const : "disabled" as const
  };
  store.reminders.unshift(reminder);
  await store.persist();
  res.json({ reminder });
}));

app.patch("/api/reminders/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1).optional(),
    rule: z.string().min(1).optional(),
    dueAt: z.string().min(1).optional(),
    ruleType: z.enum(["quote_no_reply", "sample_feedback", "inactive_customer", "high_value_revisit", "custom_due"]).optional(),
    targetStage: z.string().optional(),
    days: z.number().int().min(0).max(90).optional(),
    priority: z.enum(["high", "medium", "normal"]).optional(),
    enabled: z.boolean().optional(),
    targetOwnerId: z.string().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const reminder = store.reminders.find((item) => item.id === req.params.id);
  if (!reminder || !canSeeOwner(req.user!, reminder.ownerId, reminder.teamId)) {
    res.status(404).json({ message: "提醒规则不存在" });
    return;
  }
  if (reminder.ownerId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
    res.status(403).json({ message: "只有规则创建人或管理员可以修改提醒规则" });
    return;
  }
  const targetOwnerId = body.targetOwnerId === undefined ? (reminder.targetOwnerId || reminder.ownerId) : resolveReminderTargetOwner(req.user!, body.targetOwnerId);
  if (!targetOwnerId) {
    res.status(400).json({ message: "提醒规则目标负责人无效" });
    return;
  }
  Object.assign(reminder, body, { targetOwnerId, channel: "站内", status: body.enabled === false || (body.enabled === undefined && reminder.enabled === false) ? "disabled" : "enabled" });
  reminder.generatedCount = matchReminderRule(targetOwnerId, reminder).length;
  await store.persist();
  res.json({ reminder });
}));

app.get("/api/reminders/:id/preview", requireAuth, (req, res) => {
  const store = getStore();
  const reminder = store.reminders.find((item) => item.id === req.params.id);
  if (!reminder || !canSeeOwner(req.user!, reminder.ownerId, reminder.teamId)) {
    res.status(404).json({ message: "提醒规则不存在" });
    return;
  }
  if (reminder.ownerId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
    res.status(403).json({ message: "只有规则创建人或管理员可以预览提醒规则" });
    return;
  }
  const matched = matchReminderRule(reminder.targetOwnerId || reminder.ownerId, reminder);
  const existingKeys = new Set(store.todos.filter((todo) => todo.reminderRuleId === reminder.id).map((todo) => todo.triggerKey));
  const preview = matched.slice(0, 5).map((item) => ({ customerId: item.customer.id, customer: item.customer.company, dealId: item.deal?.id || "", deal: item.deal?.title || "", dueAt: item.dueAt }));
  const skippedCount = matched.filter((item) => existingKeys.has(`${reminder.id}:${item.triggerKey}`)).length;
  res.json({ matchedCount: matched.length, creatableCount: matched.length - skippedCount, skippedCount, preview });
});

app.post("/api/reminders/:id/run", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const reminder = store.reminders.find((item) => item.id === req.params.id);
  if (!reminder || !canSeeOwner(req.user!, reminder.ownerId, reminder.teamId)) {
    res.status(404).json({ message: "提醒规则不存在" });
    return;
  }
  if (reminder.ownerId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
    res.status(403).json({ message: "只有规则创建人或管理员可以执行提醒规则" });
    return;
  }
  if (reminder.enabled === false) {
    res.status(400).json({ message: "提醒规则已停用" });
    return;
  }
  const matched = matchReminderRule(reminder.targetOwnerId || reminder.ownerId, reminder);
  const created: Todo[] = [];
  let skippedCount = 0;
  let failedCount = 0;
  let lastError = "";
  for (const match of matched) {
    const triggerKey = `${reminder.id}:${match.triggerKey}`;
    const exists = store.todos.some((todo) => todo.triggerKey === triggerKey);
    if (exists) {
      skippedCount += 1;
      continue;
    }
    const customer = match.customer;
    if (!customer.ownerId) {
      failedCount += 1;
      lastError = `${customer.company} 未分配负责人`;
      continue;
    }
    created.push({
      id: `t_reminder_${reminder.id}_${customer.id}_${Date.now()}`,
      title: `${reminder.title}：${customer.company}`,
      type: "customer",
      priority: reminder.priority || "medium",
      status: "pending",
      pinState: "",
      sortOrder: nextTodoSortOrder(store.todos, req.user!.id),
      dueAt: match.dueAt,
      ownerId: customer.ownerId,
      teamId: customer.teamId,
      related: customer.company,
      done: false,
      impactAmount: customer.amount,
      createdAt: new Date().toISOString(),
      customerId: customer.id,
      dealId: match.deal?.id,
      reminderRuleId: reminder.id,
      triggerKey
    });
  }
  store.todos.unshift(...created);
  reminder.generatedCount = matched.length;
  reminder.lastRunBy = req.user!.id;
  reminder.lastRunAt = new Date().toISOString();
  reminder.lastMatchedCount = matched.length;
  reminder.lastCreatedCount = created.length;
  reminder.lastSkippedCount = skippedCount;
  reminder.lastFailedCount = failedCount;
  reminder.lastError = lastError;
  reminder.status = "enabled";
  await store.persist();
  res.json({ reminder, createdCount: created.length, matchedCount: matched.length, skippedCount, failedCount, todos: created });
}));

app.post("/api/reminders/:id/toggle", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const reminder = store.reminders.find((item) => item.id === req.params.id);
  if (!reminder || !canSeeOwner(req.user!, reminder.ownerId, reminder.teamId)) {
    res.status(404).json({ message: "提醒不存在" });
    return;
  }
  if (reminder.ownerId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
    res.status(403).json({ message: "只有规则创建人或管理员可以启停提醒规则" });
    return;
  }
  reminder.enabled = reminder.enabled === false;
  reminder.status = reminder.enabled ? "enabled" : "disabled";
  await store.persist();
  res.json({ reminder });
}));

app.get("/api/import-export/jobs", requireAuth, (req, res) => {
  const { importExportJobs } = getStore();
  const visibleOperatorIds = new Set(getStore().users
    .filter((user) => canSeeOwner(req.user!, user.id, user.teamId))
    .map((user) => user.id));
  const scoped = importExportJobs.filter((job) => visibleOperatorIds.has(job.operatorId));
  res.json({ jobs: scoped });
});

app.post("/api/import-export/jobs", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ name: z.string().min(1), type: z.enum(["import", "export"]), rows: z.number().int().nonnegative() });
  const store = getStore();
  const body = schema.parse(req.body);
  const job = { id: `io_${Date.now()}`, status: body.type === "export" ? "review" as const : "done" as const, operatorId: req.user!.id, createdAt: "刚刚", ...body };
  store.importExportJobs.unshift(job);
  await store.persist();
  res.json({ job });
}));

app.post("/api/import-export/customers/import", requireAuth, asyncRoute(async (req, res) => {
  const rowSchema = z.object({
    company: z.string().trim().min(1),
    country: z.string().trim().optional().default("未知"),
    contact: z.string().trim().optional().default("待维护"),
    whatsapp: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "WhatsApp 号码须包含国家码").or(z.literal("")).optional().default(""),
    stage: z.string().trim().optional().default("询盘"),
    amount: z.number().nonnegative().optional().default(0),
    health: z.number().int().min(0).max(100).optional().default(70),
    grade: z.enum(["A", "B", "C", "D"]).optional(),
    nextReminder: z.string().trim().optional().default("待跟进"),
    wecomBound: z.boolean().optional().default(false),
    billingName: z.string().trim().optional().default(""),
    billingAddress: z.string().trim().optional().default(""),
    documentContact: z.string().trim().optional().default(""),
    defaultPortDischarge: z.string().trim().optional().default(""),
    defaultIncoterm: z.string().trim().optional().default(""),
    defaultPaymentTerm: z.string().trim().optional().default("")
  });
  const schema = z.object({ rows: z.array(rowSchema).min(1).max(2000), fileName: z.string().optional().default("客户导入") });
  const body = schema.parse(req.body);
  const store = getStore();
  const scopedCustomers = store.customers.filter((customer) => customer.ownerId === req.user!.id);
  let created = 0;
  let updated = 0;
  const imported: Customer[] = [];
  for (const row of body.rows) {
    const existing = scopedCustomers.find((customer) => customer.company.trim().toLowerCase() === row.company.trim().toLowerCase());
    if (existing) {
      Object.assign(existing, {
        country: row.country || existing.country,
        contact: row.contact || existing.contact,
        whatsapp: row.whatsapp || existing.whatsapp || "",
        stage: row.stage || existing.stage,
        amount: row.amount,
        health: row.health,
        grade: row.grade || existing.grade || customerGradeFromHealth(row.health),
        nextReminder: row.nextReminder || existing.nextReminder,
        wecomBound: row.wecomBound,
        billingName: row.billingName || existing.billingName || row.company,
        billingAddress: row.billingAddress || existing.billingAddress || "",
        documentContact: row.documentContact || existing.documentContact || row.contact,
        defaultPortDischarge: row.defaultPortDischarge || existing.defaultPortDischarge || "",
        defaultIncoterm: row.defaultIncoterm || existing.defaultIncoterm || "",
        defaultPaymentTerm: row.defaultPaymentTerm || existing.defaultPaymentTerm || ""
      });
      imported.push(existing);
      updated += 1;
    } else {
      const customer: Customer = {
        id: `c_import_${Date.now()}_${created}_${Math.random().toString(16).slice(2, 8)}`,
        company: row.company,
        country: row.country || "未知",
        contact: row.contact || "待维护",
        whatsapp: row.whatsapp || "",
        ownerId: req.user!.id,
        teamId: req.user!.teamId,
        stage: row.stage || "询盘",
        amount: row.amount,
        health: row.health,
        grade: row.grade || customerGradeFromHealth(row.health),
        nextReminder: row.nextReminder || "待跟进",
        wecomBound: row.wecomBound,
        billingName: row.billingName || row.company,
        billingAddress: row.billingAddress || "",
        documentContact: row.documentContact || row.contact || "待维护",
        defaultPortDischarge: row.defaultPortDischarge || "",
        defaultIncoterm: row.defaultIncoterm || "",
        defaultPaymentTerm: row.defaultPaymentTerm || ""
      };
      store.customers.unshift(customer);
      scopedCustomers.push(customer);
      imported.push(customer);
      created += 1;
    }
  }
  const job = {
    id: `io_customer_import_${Date.now()}`,
    name: `客户导入：${body.fileName}`,
    type: "import" as const,
    rows: body.rows.length,
    status: "done" as const,
    operatorId: req.user!.id,
    createdAt: currentMinuteText()
  };
  store.importExportJobs.unshift(job);
  await store.persist();
  const customers = store.customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  res.json({ result: { created, updated, skipped: 0, total: body.rows.length }, job, customers, imported });
}));

app.post("/api/import-export/customers/export", requireAuth, asyncRoute(async (_req, res) => {
  const store = getStore();
  const customers = store.customers.filter((customer) => canSeeOwner(_req.user!, customer.ownerId, customer.teamId));
  const job = {
    id: `io_customer_export_${Date.now()}`,
    name: "客户清单导出",
    type: "export" as const,
    rows: customers.length,
    status: "done" as const,
    operatorId: _req.user!.id,
    createdAt: currentMinuteText()
  };
  store.importExportJobs.unshift(job);
  await store.persist();
  res.json({ customers, job });
}));

const documentItemSchema = z.object({
  id: z.string().max(64).optional().default(""),
  product: z.string().min(1).max(500),
  model: z.string().max(200).optional().default(""),
  hsCode: z.string().max(40).optional().default(""),
  quantity: z.number().nonnegative().default(1),
  unit: z.string().max(40).optional().default("PCS"),
  unitPrice: z.number().nonnegative().default(0),
  originCountry: z.string().max(80).optional().default(""),
  weightKg: z.number().nonnegative().default(0),
  packageCount: z.number().int().nonnegative().default(0)
});

const documentBodySchema = z.object({
  customerId: z.string().trim().max(64).optional().default(""),
  dealId: z.string().trim().max(64).optional().default(""),
  revision: z.coerce.number().int().positive().optional(),
  type: z.enum(["PI", "CI"]).default("PI"),
  title: z.string().min(1).max(255),
  number: z.string().min(1).max(80),
  issueDate: z.string().min(1).max(40),
  buyer: z.string().max(200).optional().default(""),
  buyerAddress: z.string().max(4_000).optional().default(""),
  buyerContact: z.string().max(200).optional().default(""),
  seller: z.string().min(1).max(200),
  sellerAddress: z.string().max(4_000).optional().default(""),
  currency: z.string().min(1).max(12).default("USD"),
  incoterm: z.string().min(1).max(80).default("FOB"),
  paymentTerm: z.string().max(255).optional().default(""),
  shippingMethod: z.string().max(120).optional().default("Sea freight"),
  portLoading: z.string().max(120).optional().default(""),
  portDischarge: z.string().max(120).optional().default(""),
  validityDate: z.string().max(40).optional().default(""),
  bankInfo: z.string().max(8_000).optional().default(""),
  notes: z.string().max(8_000).optional().default(""),
  templateStyle: z.enum(["executive", "classic", "compact"]).default("executive"),
  status: z.enum(["draft", "ready", "pending_approval", "approved", "rejected", "exported"]).optional().default("draft"),
  approvalNote: z.string().max(2_000).optional().default(""),
  approvedAt: z.string().max(100).optional(),
  approvedBy: z.string().max(64).optional(),
  audits: z.array(z.any()).optional().default([]),
  sendRecords: z.array(z.any()).optional().default([]),
  items: z.array(documentItemSchema).min(1).max(80)
});

function normalizeDocument(body: z.infer<typeof documentBodySchema>, user: SessionUser, existing?: TradeDocument): TradeDocument {
  const status = existing
    ? (["draft", "ready", "rejected"].includes(existing.status) && ["draft", "ready"].includes(body.status) ? body.status : existing.status)
    : (body.status === "ready" ? "ready" : "draft");
  return {
    ...body,
    id: existing?.id || `td_${Date.now()}`,
    customerId: body.customerId || existing?.customerId || "",
    dealId: body.dealId || existing?.dealId || "",
    revision: body.revision || existing?.revision || 1,
    ownerId: existing?.ownerId || user.id,
    teamId: existing?.teamId || user.teamId,
    status,
    approvalNote: existing?.approvalNote || "",
    approvedAt: existing?.approvedAt,
    approvedBy: existing?.approvedBy,
    audits: existing?.audits || [],
    sendRecords: existing?.sendRecords || [],
    updatedAt: new Date().toISOString(),
    items: body.items.map((item, index) => ({ ...item, id: item.id || `tdi_${Date.now()}_${index}` }))
  };
}

function appendDocumentAudit(document: TradeDocument, field: string, oldValue: unknown, newValue: unknown, user: SessionUser) {
  if (String(oldValue ?? "") === String(newValue ?? "")) return;
  document.audits = [...(document.audits || []), {
    id: `tda_${Date.now()}_${document.audits?.length || 0}`,
    field,
    oldValue: String(oldValue ?? ""),
    newValue: String(newValue ?? ""),
    operatorId: user.id,
    operatorName: user.name,
    createdAt: new Date().toISOString()
  }];
}

function documentBusinessDefaults(customer?: Customer) {
  if (!customer) return {};
  return {
    buyer: customer.billingName || customer.company,
    buyerAddress: customer.billingAddress || "",
    buyerContact: customer.documentContact || customer.contact,
    incoterm: customer.defaultIncoterm || "FOB",
    paymentTerm: customer.defaultPaymentTerm || "",
    portDischarge: customer.defaultPortDischarge || ""
  };
}

app.get("/api/trade-documents", requireAuth, (req, res) => {
  const { tradeDocuments } = getStore();
  const documents = tradeDocuments.filter((document) => canSeeOwner(req.user!, document.ownerId, document.teamId));
  res.json({ documents });
});

app.post("/api/trade-documents", requireAuth, asyncRoute(async (req, res) => {
  const body = documentBodySchema.parse(req.body);
  const store = getStore();
  const deal = body.dealId ? store.deals.find((item) => item.id === body.dealId && canSeeOwner(req.user!, item.ownerId, item.teamId)) : undefined;
  if (body.dealId && !deal) {
    res.status(404).json({ message: "关联商机不存在" });
    return;
  }
  const customerId = body.customerId || deal?.customerId || "";
  const customer = customerId ? store.customers.find((item) => item.id === customerId && canSeeOwner(req.user!, item.ownerId, item.teamId)) : undefined;
  if (customerId && !customer) {
    res.status(404).json({ message: "关联客户不存在" });
    return;
  }
  if (deal && body.customerId && deal.customerId !== body.customerId) {
    res.status(400).json({ message: "单据客户与商机关联客户不一致" });
    return;
  }
  const defaults = documentBusinessDefaults(customer);
  const completedBody = {
    ...body,
    customerId,
    buyer: body.buyer || defaults.buyer || "",
    buyerAddress: body.buyerAddress || defaults.buyerAddress || "",
    buyerContact: body.buyerContact || defaults.buyerContact || "",
    incoterm: body.incoterm || defaults.incoterm || "FOB",
    paymentTerm: body.paymentTerm || defaults.paymentTerm || "",
    portDischarge: body.portDischarge || defaults.portDischarge || ""
  };
  const revision = body.revision || (body.dealId
    ? Math.max(0, ...store.tradeDocuments.filter((item) => item.dealId === body.dealId && item.type === body.type).map((item) => item.revision || 1)) + 1
    : 1);
  const document = normalizeDocument({ ...completedBody, revision }, req.user!);
  store.tradeDocuments.unshift(document);
  if (deal) {
    createDealEvent({
      dealId: deal.id,
      type: "document",
      content: `${document.type} ${document.number} v${document.revision} 已创建`,
      operatorId: req.user!.id,
      fromStage: deal.stage,
      toStage: deal.stage,
      nextAction: deal.nextAction,
      nextActionAt: deal.nextActionAt,
      relatedDocumentId: document.id
    });
  }
  await store.persist();
  res.json({ document });
}));

app.patch("/api/trade-documents/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = documentBodySchema.parse(req.body);
  const store = getStore();
  const index = store.tradeDocuments.findIndex((document) => document.id === req.params.id);
  const existing = index >= 0 ? store.tradeDocuments[index] : undefined;
  if (!existing || !canSeeOwner(req.user!, existing.ownerId, existing.teamId)) {
    res.status(404).json({ message: "单据不存在" });
    return;
  }
  if (existing.ownerId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
    res.status(403).json({ message: "只有单据创建人或管理员可以修改单据内容" });
    return;
  }
  if (existing.status === "approved" || existing.status === "exported") {
    res.status(409).json({ message: "已审批或已导出的单据不能直接覆盖，请先另存新版本" });
    return;
  }
  if (body.dealId && body.dealId !== existing.dealId) {
    res.status(400).json({ message: "单据创建后不能更换关联商机" });
    return;
  }
  const document = normalizeDocument({
    ...body,
    customerId: existing.customerId,
    dealId: existing.dealId,
    revision: existing.revision
  }, req.user!, existing);
  const auditFields = [
    "title", "number", "issueDate", "buyer", "buyerAddress", "buyerContact", "seller",
    "sellerAddress", "currency", "incoterm", "paymentTerm", "shippingMethod",
    "portLoading", "portDischarge", "validityDate", "bankInfo", "notes", "templateStyle", "status"
  ] as const;
  auditFields.forEach((field) => appendDocumentAudit(document, field, existing[field], document[field], req.user!));
  store.tradeDocuments[index] = document;
  await store.persist();
  res.json({ document });
}));

app.post("/api/trade-documents/:id/revision", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const source = store.tradeDocuments.find((item) => item.id === req.params.id);
  if (!source || !canSeeOwner(req.user!, source.ownerId, source.teamId)) {
    res.status(404).json({ message: "单据不存在" });
    return;
  }
  const revision = Math.max(0, ...store.tradeDocuments
    .filter((item) => item.number.split("-R")[0] === source.number.split("-R")[0] && item.type === source.type)
    .map((item) => item.revision || 1)) + 1;
  const baseNumber = source.number.replace(/-R\d+$/, "");
  const document: TradeDocument = {
    ...source,
    id: `td_${Date.now()}`,
    number: `${baseNumber}-R${revision}`,
    title: `${source.title.replace(/\s+v\d+$/, "")} v${revision}`,
    revision,
    status: "draft",
    approvalNote: "",
    approvedAt: undefined,
    approvedBy: undefined,
    audits: [],
    sendRecords: [],
    updatedAt: new Date().toISOString(),
    items: source.items.map((item, index) => ({ ...item, id: `tdi_${Date.now()}_${index}` }))
  };
  store.tradeDocuments.unshift(document);
  await store.persist();
  res.json({ document });
}));

app.post("/api/trade-documents/:id/submit-approval", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const document = store.tradeDocuments.find((item) => item.id === req.params.id);
  if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
    res.status(404).json({ message: "单据不存在" });
    return;
  }
  if (document.ownerId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
    res.status(403).json({ message: "只有单据创建人或管理员可以提交审批" });
    return;
  }
  if (!["draft", "ready", "rejected"].includes(document.status)) {
    res.status(400).json({ message: "当前单据状态不能提交审批" });
    return;
  }
  const oldStatus = document.status;
  document.status = "pending_approval";
  document.approvalNote = String(req.body?.note || "");
  document.updatedAt = new Date().toISOString();
  appendDocumentAudit(document, "status", oldStatus, document.status, req.user!);
  await store.persist();
  res.json({ document });
}));

app.post("/api/trade-documents/:id/approve", requireAuth, asyncRoute(async (req, res) => {
  if (!canApproveTradeDocuments(req.user)) {
    res.status(403).json({ message: "只有主管和管理员可以审批单据" });
    return;
  }
  const store = getStore();
  const document = store.tradeDocuments.find((item) => item.id === req.params.id);
  if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
    res.status(404).json({ message: "单据不存在" });
    return;
  }
  if (document.status !== "pending_approval") {
    res.status(400).json({ message: "只有待审批单据可以审批通过" });
    return;
  }
  const oldStatus = document.status;
  document.status = "approved";
  document.approvalNote = String(req.body?.note || document.approvalNote || "");
  document.approvedAt = new Date().toISOString();
  document.approvedBy = req.user!.name;
  document.updatedAt = new Date().toISOString();
  appendDocumentAudit(document, "status", oldStatus, document.status, req.user!);
  await store.persist();
  res.json({ document });
}));

app.post("/api/trade-documents/:id/reject", requireAuth, asyncRoute(async (req, res) => {
  if (!canApproveTradeDocuments(req.user)) {
    res.status(403).json({ message: "只有主管和管理员可以驳回单据" });
    return;
  }
  const note = String(req.body?.note || "").trim();
  if (!note) {
    res.status(400).json({ message: "驳回必须填写原因" });
    return;
  }
  const store = getStore();
  const document = store.tradeDocuments.find((item) => item.id === req.params.id);
  if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
    res.status(404).json({ message: "单据不存在" });
    return;
  }
  if (document.status !== "pending_approval") {
    res.status(400).json({ message: "只有待审批单据可以驳回" });
    return;
  }
  const oldStatus = document.status;
  document.status = "rejected";
  document.approvalNote = note;
  document.updatedAt = new Date().toISOString();
  appendDocumentAudit(document, "status", oldStatus, document.status, req.user!);
  appendDocumentAudit(document, "approvalNote", "", note, req.user!);
  await store.persist();
  res.json({ document });
}));

app.post("/api/trade-documents/:id/send", requireAuth, asyncRoute(async (req, res) => {
  const channel = ["email", "whatsapp", "wechat", "manual"].includes(req.body?.channel) ? req.body.channel : "manual";
  const recipient = String(req.body?.recipient || "").trim();
  if (!recipient) {
    res.status(400).json({ message: "请填写发送对象" });
    return;
  }
  const store = getStore();
  const document = store.tradeDocuments.find((item) => item.id === req.params.id);
  if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
    res.status(404).json({ message: "单据不存在" });
    return;
  }
  if (!["approved", "exported"].includes(document.status)) {
    res.status(409).json({ message: "单据审批通过后才能记录发送" });
    return;
  }
  if (document.ownerId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
    res.status(403).json({ message: "只有单据创建人或管理员可以发送单据" });
    return;
  }
  const record: TradeDocumentSendRecord = {
    id: `tds_${Date.now()}`,
    channel,
    recipient,
    message: String(req.body?.message || ""),
    operatorId: req.user!.id,
    operatorName: req.user!.name,
    createdAt: new Date().toISOString()
  };
  document.sendRecords = [...(document.sendRecords || []), record];
  document.updatedAt = new Date().toISOString();
  appendDocumentAudit(document, "send", "", `${channel}:${recipient}`, req.user!);
  await store.persist();
  res.json({ document, record });
}));

app.post("/api/trade-documents/:id/export", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const document = store.tradeDocuments.find((item) => item.id === req.params.id);
  if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
    res.status(404).json({ message: "单据不存在" });
    return;
  }
  if (!["approved", "exported"].includes(document.status)) {
    res.status(409).json({ message: "单据审批通过后才能导出正式 PDF" });
    return;
  }
  if (document.ownerId !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "super_admin") {
    res.status(403).json({ message: "只有单据创建人或管理员可以导出单据" });
    return;
  }
  const oldStatus = document.status;
  document.status = "exported";
  document.updatedAt = new Date().toISOString();
  appendDocumentAudit(document, "status", oldStatus, document.status, req.user!);
  const job = {
    id: `io_document_export_${Date.now()}`,
    name: `${document.type} 单据 PDF 导出：${document.number}`,
    type: "export" as const,
    rows: document.items.length,
    status: "done" as const,
    operatorId: req.user!.id,
    createdAt: currentMinuteText()
  };
  store.importExportJobs.unshift(job);
  await store.persist();
  res.json({ document, job, fileName: `${document.number}-${document.type}.pdf` });
}));

// 报关资料生成API
app.post("/api/deals/:dealId/generate-customs", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const deal = store.deals.find((item) => item.id === req.params.dealId);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }

  const customer = store.customers.find((item) => item.id === deal.customerId);
  if (!customer) {
    res.status(404).json({ message: "请先关联客户" });
    return;
  }

  // 查找关联的PI/CI单据
  const tradeDocument = store.tradeDocuments
    .filter((doc) => doc.dealId === deal.id && ["PI", "CI"].includes(doc.type))
    .sort((left, right) => {
      const leftApproved = ["approved", "exported"].includes(left.status) ? 1 : 0;
      const rightApproved = ["approved", "exported"].includes(right.status) ? 1 : 0;
      return rightApproved - leftApproved || right.updatedAt.localeCompare(left.updatedAt);
    })[0];

  const customsDoc = generateCustomsDocumentFromDeal(deal, customer, tradeDocument);

  res.json({
    customsDocument: customsDoc,
    customer,
    deal,
    source: tradeDocument
      ? { type: "trade_document", label: `${tradeDocument.type} · ${tradeDocument.number}` }
      : { type: "deal", label: "商机资料（未找到关联 PI/CI）" }
  });
}));

app.post("/api/customs-documents/export", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const { customsDocument } = req.body;

  if (!customsDocument || !customsDocument.dealId) {
    res.status(400).json({ message: "报关资料数据不完整" });
    return;
  }

  const deal = store.deals.find((item) => item.id === customsDocument.dealId);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }

  const customer = store.customers.find((item) =>
    item.id === customsDocument.customerId
    && item.id === deal.customerId
    && canSeeOwner(req.user!, item.ownerId, item.teamId)
  );
  if (!customer) {
    res.status(404).json({ message: "客户不存在" });
    return;
  }

  const exportIssues = customsDocumentExportIssues(customsDocument);
  if (exportIssues.length) {
    res.status(422).json({
      message: `请先补齐：${exportIssues.slice(0, 4).join("、")}${exportIssues.length > 4 ? ` 等${exportIssues.length}项` : ""}`,
      missingFields: exportIssues
    });
    return;
  }

  try {
    const excelBuffer = exportCustomsDocumentToExcel(customsDocument, customer, deal);

    // 创建导出任务记录
    const job = {
      id: `io_customs_export_${Date.now()}`,
      name: `报关资料导出：${customer.company}`,
      type: "export" as const,
      rows: customsDocument.items.length,
      status: "done" as const,
      operatorId: req.user!.id,
      createdAt: currentMinuteText()
    };
    store.importExportJobs.unshift(job);
    await store.persist();

    // 设置响应头
    const downloadName = `${customer.company}-报关资料-${customsDocument.issueDate}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="customs-${customsDocument.issueDate}.xlsx"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    );
    res.send(excelBuffer);
  } catch (error) {
    console.error("报关资料导出失败:", error);
    res.status(500).json({ message: "导出失败" });
  }
}));

app.get("/api/wecom/messages", requireAuth, (req, res) => {
  const { wecomMessages } = getStore();
  const scoped = wecomMessages.filter((message) => canSeeOwner(req.user!, message.ownerId, message.teamId));
  res.json({ messages: scoped });
});

app.post("/api/wecom/messages/:id/archive", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const message = store.wecomMessages.find((item) => item.id === req.params.id);
  if (!message || !canSeeOwner(req.user!, message.ownerId, message.teamId)) {
    res.status(404).json({ message: "企微摘要不存在" });
    return;
  }
  message.status = "archived";
  await store.persist();
  res.json({ message });
}));

app.get("/api/tools/ocr/jobs/:id", requireAuth, (req, res) => {
  const job = resolveOcrJob(req.user!, req.params.id, true);
  if (!job) {
    res.status(404).json({ message: "OCR 任务不存在" });
    return;
  }
  res.json({ job });
});

app.post("/api/tools/ocr/jobs/:id/recognize", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    confidence: z.coerce.number().min(0).max(100).optional(),
    company: z.string().trim().max(200).optional(),
    contact: z.string().trim().max(120).optional(),
    title: z.string().trim().max(120).optional(),
    email: z.string().trim().max(254).optional(),
    whatsapp: z.string().trim().max(60).optional(),
    wechat: z.string().trim().max(80).optional(),
    phone: z.string().trim().max(60).optional(),
    country: z.string().trim().max(80).optional(),
    city: z.string().trim().max(120).optional()
  }).parse(req.body);
  const store = getStore();
  const job = resolveOcrJob(req.user!, req.params.id, true);
  if (!job) {
    res.status(404).json({ message: "OCR 任务不存在" });
    return;
  }
  job.status = "recognized";
  job.confidence = body.confidence ?? job.confidence;
  job.fields = {
    ...job.fields,
    company: body.company ?? job.fields.company,
    contact: body.contact ?? job.fields.contact,
    title: body.title ?? job.fields.title,
    email: body.email ?? job.fields.email,
    whatsapp: body.whatsapp ?? job.fields.whatsapp,
    wechat: body.wechat ?? job.fields.wechat,
    phone: body.phone ?? job.fields.phone,
    country: body.country ?? job.fields.country,
    city: body.city ?? job.fields.city
  };
  await store.persist();
  res.json({ job });
}));

app.post("/api/tools/ocr/jobs/:id/sync-lead", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const job = resolveOcrJob(req.user!, req.params.id, false);
  if (!job) {
    res.status(404).json({ message: "OCR 任务不存在" });
    return;
  }
  const result = createLeadFromSource(req.user!, {
    company: job.fields.company || "待维护公司",
    contact: job.fields.contact || "",
    country: job.fields.country || "",
    email: job.fields.email || "",
    phone: job.fields.phone || job.fields.whatsapp || "",
    wechat: job.fields.wechat || "",
    source: "名片 OCR",
    sourceType: "offline",
    sourceChannel: "ocr",
    sourceCampaign: "",
    externalId: job.id,
    sourceUrl: "",
    intent: "中",
    stage: "新线索",
    estimatedAmount: 0,
    nextFollowAt: "",
    remark: job.fields.title ? `名片职位：${job.fields.title}` : "OCR 名片识别",
    rawPayload: job.fields
  });
  job.status = "synced";
  await store.persist();
  res.json(result);
}));

app.get("/api/organization-identity-conflicts", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  try {
    const query = organizationIdentityConflictListQuerySchema.parse(req.query);
    await store.reloadOrganizationIdentityConflictReviewTeam?.(
      req.user!.teamId
    );
    const conflicts = listOrganizationIdentityConflicts(
      store,
      req.user!,
      query.status
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ conflicts });
  } catch (error) {
    if (sendOrganizationIdentityConflictReviewError(res, error)) return;
    throw error;
  }
}));

app.post("/api/organization-identity-conflicts/:id/review", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  try {
    const body = organizationIdentityConflictReviewBodySchema.parse(req.body);
    const result = await reviewOrganizationIdentityConflict(store, {
      user: req.user!,
      conflictId: req.params.id,
      ifMatch: req.header("If-Match") || "",
      body
    });
    res.setHeader("ETag", result.etag);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    if (sendOrganizationIdentityConflictReviewError(res, error)) return;
    throw error;
  }
}));

app.get("/api/organizations/:id/identity-profile", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  try {
    await store.reloadOrganizationIdentityTeam?.(req.user!.teamId);
    await store.reloadOrganizationIdentityConflictReviewTeam?.(
      req.user!.teamId
    );
    await store.reloadOrganizationRelationsTeam?.(req.user!.teamId);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      profile: organizationIdentityProfile(
        store,
        req.user!,
        req.params.id
      )
    });
  } catch (error) {
    if (sendOrganizationRelationError(res, error)) return;
    throw error;
  }
}));

app.post("/api/organizations/:id/aliases", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  try {
    const body = organizationAliasBodySchema.parse(req.body);
    const result = await recordOrganizationAlias(store, {
      user: req.user!,
      organizationId: req.params.id,
      body
    });
    res.setHeader(
      "Idempotency-Replayed",
      result.replayed ? "true" : "false"
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    if (sendOrganizationRelationError(res, error)) return;
    throw error;
  }
}));

app.post("/api/organization-relations", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  try {
    const body = organizationRelationBodySchema.parse(req.body);
    const result = await recordOrganizationRelation(store, {
      user: req.user!,
      body
    });
    res.setHeader(
      "Idempotency-Replayed",
      result.replayed ? "true" : "false"
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    if (sendOrganizationRelationError(res, error)) return;
    throw error;
  }
}));

app.get("/api/tools/website-opportunities", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  await store.reloadProspectCandidates?.();
  const scoped = store.websiteOpportunities
    .filter((item) =>
      canSeeOwner(req.user!, item.ownerId, item.teamId)
    )
    .map((item) => {
      const scored = refreshProspectScorecard(store, { ...item });
      return {
      ...scored,
      verificationReport: ensureProspectVerificationReport(scored).verificationReport,
      organizationId: scored.organizationId
        ? canonicalOrganizationId(
            store,
            scored.teamId,
            scored.organizationId
          )
        : scored.organizationId
      };
    });
  res.json({ opportunities: scoped });
}));

app.get("/api/prospect-list/assignees", requireAuth, (req, res) => {
  if (!canManageProspectAssignments(req.user)) {
    res.json({ assignees: [] });
    return;
  }
  res.json({ assignees: prospectAssigneesFor(req.user!) });
});

function candidateForQualificationRequest(
  store: CrmStore,
  req: Request,
  res: Response,
  requireOwner = false
) {
  const candidate = store.websiteOpportunities.find((item) =>
    item.id === req.params.id
    && canSeeOwner(req.user!, item.ownerId, item.teamId)
  );
  if (!candidate) {
    res.status(404).json({ message: "搜客候选不存在或无权访问" });
    return null;
  }
  if (requireOwner && candidate.ownerId !== req.user!.id) {
    res.status(403).json({
      message: "只有候选归属业务员可以提交或批准资格事实"
    });
    return null;
  }
  return candidate;
}

async function prepareProspectQualificationRequest(
  store: CrmStore,
  candidate: WebsiteOpportunity
) {
  await store.reloadProspectQualificationTeam?.(candidate.teamId);
}

async function finishProspectQualificationRequest(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  qualification: ReturnType<typeof prospectQualificationView>
) {
  await persistCandidateChanges(store, [candidate], false);
  return { qualification, opportunity: candidate };
}

app.get("/api/prospect-list/:id/qualification", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const candidate = candidateForQualificationRequest(store, req, res);
  if (!candidate) return;
  try {
    await prepareProspectQualificationRequest(store, candidate);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      qualification: prospectQualificationView(store, candidate),
      opportunity: candidate
    });
  } catch (error) {
    if (sendProspectQualificationError(res, error)) return;
    throw error;
  }
}));

app.get("/api/prospect-list/website-probe/capability", requireAuth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(websiteProbeCapability());
});

const prospectIdentityBootstrapBodySchema = z.object({
  providerId: z.enum([
    "gleif",
    "companies_house",
    "sec_edgar",
    "fr_company_search"
  ]),
  registrationNumber: z.string().trim().min(1).max(80),
  requestId: z.string().trim().min(8).max(120)
}).strict();

function prospectIdentityBootstrapPayload(
  user: SessionUser,
  candidateId: string,
  attempt: ProspectIdentityBootstrapAttempt
) {
  const provider = allProviderStatuses(user).find((item) =>
    item.id === attempt.providerId
  );
  return {
    taskStatus: attempt.taskStatus,
    taskStatusLabel: attempt.taskStatus === "ended" ? "已结束" : "进行中",
    attempt,
    provider: provider || null,
    candidateId
  };
}

app.get("/api/prospect-list/:id/identity-bootstrap", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  await Promise.all([
    store.reloadOrganizationIdentityTeam?.(req.user!.teamId),
    store.reloadProspectCoverageTeam?.(req.user!.teamId),
    store.reloadProspectQualificationTeam?.(req.user!.teamId)
  ]);
  try {
    const view = prospectIdentityBootstrapView(
      store,
      req.user!,
      String(req.params.id)
    );
    const statuses = new Map(
      allProviderStatuses(req.user!).map((item) => [item.id, item])
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ...view,
      providers: view.providers.map((provider) => ({
        ...provider,
        runtime: statuses.get(provider.id) || null
      }))
    });
  } catch (error) {
    if (sendProspectIdentityBootstrapError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-list/:id/identity-bootstrap", requireAuth, asyncRoute(async (req, res) => {
  const body = prospectIdentityBootstrapBodySchema.parse(req.body);
  const store = getStore();
  let normalized;
  try {
    normalized = normalizeProspectIdentityRegistration(
      body.providerId,
      body.registrationNumber
    );
  } catch (error) {
    if (sendProspectIdentityBootstrapError(res, error)) return;
    throw error;
  }
  const provider = allProviderStatuses(req.user!).find((item) =>
    item.id === body.providerId
  );
  if (!provider || !provider.enabled || !provider.ready
    || provider.accessMode !== "api") {
    res.status(409).json({
      message: provider?.requiresKey && !provider.hasApiKey
        ? provider.id === "sec_edgar"
          ? "请先配置 SEC Fair Access User-Agent（系统名 联系邮箱），无需申请 API Key"
          : `请先注册并配置 ${provider.name} API`
        : `${provider?.name || normalized.guide.name} 当前不可执行`,
      errorCode: "IDENTITY_AUTHORITY_PROVIDER_NOT_READY",
      provider: provider || null,
      registrationRequired: Boolean(provider?.requiresKey && !provider.hasApiKey),
      docsUrl: provider?.docsUrl || ""
    });
    return;
  }
  const requestIdHash = createHash("sha256")
    .update(JSON.stringify({
      version: "prospect-identity-bootstrap-request-v1",
      teamId: req.user!.teamId,
      ownerId: req.user!.id,
      candidateId: req.params.id,
      requestId: body.requestId
    }))
    .digest("hex");
  const now = new Date().toISOString();
  const attemptId = `pib_${createHash("sha256")
    .update(JSON.stringify({
      version: "prospect-identity-bootstrap-attempt-id-v1",
      requestIdHash
    }))
    .digest("hex").slice(0, 40)}`;
  const attempt: ProspectIdentityBootstrapAttempt = {
    id: attemptId,
    version: "prospect-identity-bootstrap-v1",
    requestIdHash,
    providerId: body.providerId,
    registrationNumber: normalized.registrationNumber,
    normalizedIdentifier: normalized.normalizedIdentifier,
    taskStatus: "running",
    outcome: "pending",
    campaignId: "",
    campaignVersion: 0,
    strategyId: "",
    runId: "",
    sourceCandidateId: "",
    sourceRawRecordId: "",
    sourceHitId: "",
    resolutionId: "",
    conflictId: "",
    organizationId: "",
    tenantProspectId: "",
    errorCode: "",
    errorMessage: "",
    events: [{
      id: `${attemptId}:event:1`,
      sequence: 1,
      stage: "validation",
      status: "completed",
      label: "权威注册号已校验",
      detail: `${normalized.guide.name} · ${normalized.registrationNumber}`,
      createdAt: now
    }],
    createdBy: req.user!.id,
    createdAt: now,
    updatedAt: now,
    endedAt: ""
  };
  let started;
  try {
    started = await beginProspectIdentityBootstrap({
      store,
      user: req.user!,
      candidateId: String(req.params.id),
      attempt
    });
  } catch (error) {
    if (sendProspectIdentityBootstrapError(res, error)) return;
    throw error;
  }
  if (started.attempt.runId || started.attempt.taskStatus === "ended") {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      replayed: true,
      ...prospectIdentityBootstrapPayload(
        req.user!,
        String(req.params.id),
        started.attempt
      )
    });
    return;
  }
  try {
    const search = await startAgentProspectSearch(
      { id: req.user!.id },
      {
        title: `${normalized.guide.identifierLabel} 身份核验 · ${normalized.registrationNumber}`,
        goal: `仅通过 ${normalized.guide.name} 核验企业注册号 ${normalized.registrationNumber}`,
        products: [normalized.registrationNumber],
        markets: [normalized.guide.market],
        customerTypes: ["企业身份核验"],
        industries: ["企业注册身份"],
        exclusions: [],
        providerIds: [body.providerId],
        limit: 5
      },
      `identity-bootstrap:${attemptId}`
    );
    const campaign = store.prospectCampaigns.find((item) =>
      item.id === search.campaignId
    );
    const attached = await attachProspectIdentityBootstrapRun({
      store,
      user: req.user!,
      candidateId: String(req.params.id),
      attemptId,
      campaignId: search.campaignId,
      campaignVersion: campaign?.currentVersion || 1,
      strategyId: search.strategyId,
      runId: search.runId,
      at: new Date().toISOString()
    });
    res.location(
      `/api/prospect-list/${encodeURIComponent(String(req.params.id))}`
      + `/identity-bootstrap/${encodeURIComponent(attemptId)}`
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(started.replayed ? 200 : 201).json({
      replayed: started.replayed,
      ...prospectIdentityBootstrapPayload(
        req.user!,
        String(req.params.id),
        attached.attempt
      )
    });
  } catch (error) {
    const failed = await failProspectIdentityBootstrap({
      store,
      user: req.user!,
      candidateId: String(req.params.id),
      attemptId,
      errorCode: typeof error === "object" && error && "code" in error
        ? String(error.code || "IDENTITY_PROVIDER_START_FAILED")
        : "IDENTITY_PROVIDER_START_FAILED",
      errorMessage: error instanceof Error
        ? error.message
        : "权威来源搜索启动失败",
      at: new Date().toISOString()
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      replayed: started.replayed,
      ...prospectIdentityBootstrapPayload(
        req.user!,
        String(req.params.id),
        failed.attempt
      )
    });
  }
}));

app.get("/api/prospect-list/:id/identity-bootstrap/:attemptId", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  await store.readBarrier();
  const view = prospectIdentityBootstrapView(
    store,
    req.user!,
    String(req.params.id)
  );
  const attempt = view.attempts.find((item) =>
    item.id === String(req.params.attemptId)
  );
  if (!attempt) {
    res.status(404).json({ message: "身份引导任务不存在" });
    return;
  }
  let progress = null;
  if (attempt.runId) {
    try {
      progress = await getAgentProspectSearchProgress(
        { id: req.user!.id },
        { runId: attempt.runId }
      );
    } catch {
      progress = null;
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ...prospectIdentityBootstrapPayload(
      req.user!,
      String(req.params.id),
      attempt
    ),
    progress
  });
}));

app.post("/api/prospect-list/:id/identity-bootstrap/:attemptId/reconcile", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  await store.readBarrier();
  await Promise.all([
    store.reloadProspectCandidates?.(),
    store.reloadOrganizationIdentityTeam?.(req.user!.teamId),
    store.reloadProspectCoverageTeam?.(req.user!.teamId),
    store.reloadProspectQualificationTeam?.(req.user!.teamId)
  ]);
  try {
    const result = await reconcileProspectIdentityBootstrap({
      store,
      user: req.user!,
      candidateId: String(req.params.id),
      attemptId: String(req.params.attemptId),
      at: new Date().toISOString()
    });
    let progress = null;
    if (result.attempt.runId) {
      try {
        progress = await getAgentProspectSearchProgress(
          { id: req.user!.id },
          { runId: result.attempt.runId }
        );
      } catch {
        progress = null;
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      changed: result.changed,
      candidate: result.candidate,
      ...prospectIdentityBootstrapPayload(
        req.user!,
        String(req.params.id),
        result.attempt
      ),
      progress
    });
  } catch (error) {
    if (sendProspectIdentityBootstrapError(res, error)
      || sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-list/:id/website-probe", requireAuth, asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.body || {});
  const store = getStore();
  const candidate = candidateForQualificationRequest(store, req, res, true);
  if (!candidate) return;
  try {
    const result = await queueWebsiteProbe(
      store,
      candidate,
      req.user!.id,
      async (current) => {
        await persistCandidateChanges(store, [current], false);
      }
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(result.replayed ? 200 : 202).json({
      ...result,
      opportunity: store.websiteOpportunities.find((item) =>
        item.id === candidate.id
      ) || candidate
    });
  } catch (error) {
    if (sendWebsiteProbeError(res, error)) return;
    throw error;
  }
}));

app.get("/api/prospect-list/:id/website-probe/:attemptId", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const candidate = candidateForQualificationRequest(store, req, res);
  if (!candidate) return;
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ...websiteProbeDetail(candidate, String(req.params.attemptId)),
      opportunity: candidate
    });
  } catch (error) {
    if (sendWebsiteProbeError(res, error)) return;
    throw error;
  }
}));

app.get("/api/prospect-list/:id/website-probe/:attemptId/events", requireAuth, (req, res) => {
  const store = getStore();
  const initial = candidateForQualificationRequest(store, req, res);
  if (!initial) return;
  const attemptId = String(req.params.attemptId);
  const after = Math.max(0, Number(req.query.after || 0));
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  let lastSequence = after;
  let closed = false;
  const send = () => {
    if (closed) return;
    const candidate = store.websiteOpportunities.find((item) =>
      item.id === initial.id
      && item.teamId === initial.teamId
      && canSeeOwner(req.user!, item.ownerId, item.teamId)
    );
    if (!candidate) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: "候选已不可见" })}\n\n`);
      res.end();
      return;
    }
    try {
      const detail = websiteProbeDetail(candidate, attemptId);
      for (const event of detail.attempt.events.filter((item) =>
        item.sequence > lastSequence
      )) {
        lastSequence = event.sequence;
        res.write(`id: ${event.sequence}\nevent: probe_event\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (detail.terminal) {
        res.write(`event: done\ndata: ${JSON.stringify({
          attemptId,
          status: detail.attempt.status,
          outcome: detail.attempt.outcome,
          lastSequence
        })}\n\n`);
        res.end();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "官网验证事件不可用";
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      res.end();
    }
  };
  const timer = setInterval(send, 400);
  req.on("close", () => {
    closed = true;
    clearInterval(timer);
  });
  send();
});

app.post("/api/prospect-list/:id/qualification/company", requireAuth, asyncRoute(async (req, res) => {
  const body = prospectCompanyQualificationSchema.parse(req.body);
  const store = getStore();
  const candidate = candidateForQualificationRequest(store, req, res, true);
  if (!candidate) return;
  try {
    await prepareProspectQualificationRequest(store, candidate);
    const qualification = await recordProspectCompanyQualification(
      store,
      candidate,
      req.user!.id,
      body
    );
    res.json(await finishProspectQualificationRequest(
      store,
      candidate,
      qualification
    ));
  } catch (error) {
    if (sendProspectQualificationError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-list/:id/qualification/icp", requireAuth, asyncRoute(async (req, res) => {
  const body = prospectIcpQualificationSchema.parse(req.body);
  const store = getStore();
  const candidate = candidateForQualificationRequest(store, req, res, true);
  if (!candidate) return;
  try {
    await prepareProspectQualificationRequest(store, candidate);
    const qualification = await recordProspectIcpQualification(
      store,
      candidate,
      req.user!.id,
      body
    );
    res.json(await finishProspectQualificationRequest(
      store,
      candidate,
      qualification
    ));
  } catch (error) {
    if (sendProspectQualificationError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-list/:id/qualification/icp/:assessmentId/approve", requireAuth, asyncRoute(async (req, res) => {
  const body = prospectQualificationApprovalSchema.parse(req.body);
  const store = getStore();
  const candidate = candidateForQualificationRequest(store, req, res, true);
  if (!candidate) return;
  try {
    await prepareProspectQualificationRequest(store, candidate);
    const qualification = await approveProspectIcpQualification(
      store,
      candidate,
      req.user!.id,
      req.params.assessmentId,
      body
    );
    res.json(await finishProspectQualificationRequest(
      store,
      candidate,
      qualification
    ));
  } catch (error) {
    if (sendProspectQualificationError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-list/:id/qualification/channel", requireAuth, asyncRoute(async (req, res) => {
  const body = prospectChannelQualificationSchema.parse(req.body);
  const store = getStore();
  const candidate = candidateForQualificationRequest(store, req, res, true);
  if (!candidate) return;
  try {
    await prepareProspectQualificationRequest(store, candidate);
    const qualification = await recordProspectChannelQualification(
      store,
      candidate,
      req.user!.id,
      body
    );
    res.json(await finishProspectQualificationRequest(
      store,
      candidate,
      qualification
    ));
  } catch (error) {
    if (sendProspectQualificationError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-list/:id/qualification/contactability/evaluate", requireAuth, asyncRoute(async (req, res) => {
  const body = prospectContactabilityEvaluationSchema.parse(req.body);
  const store = getStore();
  const candidate = candidateForQualificationRequest(store, req, res, true);
  if (!candidate) return;
  try {
    await prepareProspectQualificationRequest(store, candidate);
    const qualification = await evaluateProspectContactability(
      store,
      candidate,
      req.user!.id,
      body
    );
    res.json(await finishProspectQualificationRequest(
      store,
      candidate,
      qualification
    ));
  } catch (error) {
    if (sendProspectQualificationError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-list/:id/qualification/contactability/:decisionId/approve", requireAuth, asyncRoute(async (req, res) => {
  const body = prospectQualificationApprovalSchema.parse(req.body);
  const store = getStore();
  const candidate = candidateForQualificationRequest(store, req, res, true);
  if (!candidate) return;
  try {
    await prepareProspectQualificationRequest(store, candidate);
    const qualification = await approveProspectContactability(
      store,
      candidate,
      req.user!.id,
      req.params.decisionId,
      body
    );
    res.json(await finishProspectQualificationRequest(
      store,
      candidate,
      qualification
    ));
  } catch (error) {
    if (sendProspectQualificationError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-list/:id/qualification/suppress", requireAuth, asyncRoute(async (req, res) => {
  const body = prospectSuppressionSchema.parse(req.body);
  const store = getStore();
  const candidate = candidateForQualificationRequest(store, req, res, true);
  if (!candidate) return;
  try {
    await prepareProspectQualificationRequest(store, candidate);
    const qualification = await setProspectSuppression(
      store,
      candidate,
      req.user!.id,
      body
    );
    res.json(await finishProspectQualificationRequest(
      store,
      candidate,
      qualification
    ));
  } catch (error) {
    if (sendProspectQualificationError(res, error)
      || sendProspectLeadConversionError(res, error)) return;
    throw error;
  }
}));

app.patch("/api/prospect-list/:id/details", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1).max(200),
    business: z.string().max(255).default(""),
    country: z.string().max(80).default(""),
    website: z.string().min(3).max(255),
    contact: z.string().max(120).default(""),
    contactInfo: z.string().max(255).default(""),
    description: z.string().max(1000).default(""),
    requestId: z.string().min(8).max(120).optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const opportunity = store.websiteOpportunities.find((item) => item.id === req.params.id && canSeeOwner(req.user!, item.ownerId, item.teamId));
  if (!opportunity) {
    res.status(404).json({ message: "搜客线索不存在或无权访问" });
    return;
  }
  if (opportunity.status === "synced") {
    res.status(400).json({ message: "已入线索的数据请在线索中心维护" });
    return;
  }
  if (opportunity.ownerId !== req.user!.id) {
    res.status(403).json({ message: "只有候选归属业务员可以修改资格资料" });
    return;
  }
  const changedAt = new Date().toISOString();
  const nextDetails = {
    company: body.company,
    business: body.business,
    country: body.country,
    website: normalizeWebsiteReference(body.website),
    contact: body.contact,
    contactInfo: body.contactInfo,
    description: body.description
  };
  const changedFields = prospectCandidateQualificationChangedFields(
    opportunity,
    nextDetails
  );
  if (changedFields.length && opportunity.tenantProspectId) {
    const command = {
      kind: "amend_candidate_qualification_basis" as const,
      teamId: opportunity.teamId,
      ownerId: opportunity.ownerId,
      actorId: req.user!.id,
      prospectId: opportunity.tenantProspectId,
      idempotencyKey: body.requestId
        || `candidate-details:${requestCorrelationId(req)}`,
      candidateId: opportunity.id,
      changedFields,
      beforeBasisHash: prospectCandidateQualificationBasisHash(opportunity),
      afterBasisHash: prospectCandidateQualificationBasisHash(nextDetails),
      createdAt: changedAt
    };
    if (store.applyProspectQualification) {
      await store.applyProspectQualification(command);
    } else {
      applyProspectQualificationCommand(store, command);
    }
  }
  Object.assign(opportunity, nextDetails, { statusChangedAt: changedAt });
  withProspectVerificationReport(opportunity);
  await persistCandidateChanges(store, [opportunity], false);
  res.json({
    opportunity,
    qualification: opportunity.tenantProspectId
      ? prospectQualificationView(store, opportunity)
      : null,
    qualificationInvalidated: changedFields.length > 0,
    changedFields
  });
}));

app.patch("/api/prospect-list/batch", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    ids: z.array(z.string().min(1)).min(1).max(100),
    action: z.enum(["mark-contactable", "exclude", "restore", "assign"]),
    ownerId: z.string().min(1).optional(),
    reason: z.string().max(255).optional().default(""),
    requestId: z.string().min(1).max(120).optional(),
    effectiveAt: z.string().datetime().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  if (body.action === "mark-contactable") {
    res.status(409).json({
      message: "“标记可联系”已停用，请完成企业、ICP、渠道和可联系门禁四步资格审查",
      errorCode: "PROSPECT_QUALIFICATION_REQUIRED"
    });
    return;
  }
  const ids = [...new Set(body.ids)];
  const opportunities = ids
    .map((id) => store.websiteOpportunities.find((item) => item.id === id && canSeeOwner(req.user!, item.ownerId, item.teamId)))
    .filter(Boolean) as WebsiteOpportunity[];
  if (opportunities.length !== ids.length) {
    res.status(404).json({ message: "部分搜客线索不存在或无权访问" });
    return;
  }
  if (body.action === "assign" && !canManageProspectAssignments(req.user)) {
    res.status(403).json({ message: "只有主管和管理员可以分配搜客线索" });
    return;
  }
  const assignee = body.action === "assign"
    ? prospectAssigneesFor(req.user!).find((item) => item.id === body.ownerId)
    : undefined;
  if (body.action === "assign" && !assignee) {
    res.status(400).json({ message: "目标业务员不存在、不在当前团队或账号已停用" });
    return;
  }
  if (opportunities.some((item) => item.status === "synced") && ["exclude", "assign"].includes(body.action)) {
    res.status(400).json({ message: "已入线索的数据不能排除或重新分配，请在线索中心处理" });
    return;
  }
  if (body.action === "restore" && opportunities.some((item) => item.status !== "excluded")) {
    res.status(400).json({ message: "只有已排除的数据可以恢复为待核验" });
    return;
  }
  const serverNow = Date.now();
  if (body.effectiveAt
    && Math.abs(new Date(body.effectiveAt).getTime() - serverNow)
      > 5 * 60 * 1000) {
    res.status(400).json({ message: "候选处理时间与服务器时间偏差过大，请刷新后重试" });
    return;
  }
  const changedAt = body.effectiveAt || new Date(serverNow).toISOString();
  const requestId = body.requestId || requestCorrelationId(req);
  try {
    for (const item of opportunities) {
      let coverageResult = null;
      if (body.action !== "assign") {
        coverageResult = await syncProspectCandidateCoverage({
          store,
          candidate: item,
          actorId: req.user!.id,
          action: body.action,
          requestId: `prospect-batch:${requestId}:${item.id}:${body.action}`,
          effectiveAt: changedAt
        });
      }
      if (body.action === "exclude") {
        if (!coverageResult) item.status = "excluded";
        item.excludedReason = body.reason.trim() || "人工核验后排除";
      } else if (body.action === "restore") {
        if (!coverageResult) item.status = "preview";
        item.excludedReason = "";
      } else if (assignee) {
        item.ownerId = assignee.id;
        item.teamId = assignee.teamId;
      }
      item.statusChangedAt = changedAt;
      withProspectVerificationReport(item, changedAt);
    }
  } catch (error) {
    if (sendProspectLeadConversionError(res, error)) return;
    throw error;
  }
  await persistCandidateChanges(store, opportunities, false);
  res.json({ opportunities });
}));

function agentInputText(input: Record<string, unknown>, key: string, fallback = "") {
  const value = input[key];
  return typeof value === "string" ? value.trim() : fallback;
}

function agentInputList(input: Record<string, unknown>, key: string) {
  const value = input[key];
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/,|，|、|\n/u)
      : [];
  return [...new Set(items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function agentSessionUser(actor: { id: string }) {
  const stored = getStore().users.find((item) => item.id === actor.id && item.status === "active");
  if (!stored) throw new Error("Agent 执行账号不存在或已停用");
  return { stored, session: publicUser(stored) };
}

async function buildAgentDevelopmentEmail(actor: { id: string }, input: Record<string, unknown>) {
  const { stored, session } = agentSessionUser(actor);
  const entityType = agentInputText(input, "entityType") === "lead" ? "lead" : "customer";
  const entityId = agentInputText(input, "entityId");
  const entity = developmentEmailEntity(session, entityType, entityId);
  if (!entity) throw new Error("开发信对象不存在或当前账号无权访问");
  const profile = companyProfileForTeam(session.teamId);
  const readiness = developmentEmailReadiness(stored, profile);
  const senderName = stored.emailSenderName || stored.name;
  const signature = stored.emailSignature?.trim() || `Best regards,\n${senderName}`;
  const requestedSubject = agentInputText(input, "subject");
  const requestedBody = agentInputText(input, "body");
  const requestedTo = agentInputText(input, "to");
  let subject = requestedSubject || `Potential cooperation with ${entity.company}`;
  let body = requestedBody || [
    `Dear ${entity.contactName},`,
    "",
    `I am ${senderName} from ${profile.companyName || "our company"}. We specialize in ${profile.productSummary || "products for international buyers"}.`,
    "",
    `I am reaching out to ${entity.company} regarding ${developmentEmailEnglishContext(entity.context)}. Would you be available for a brief conversation this week?`,
    "",
    signature,
    profile.website ? `Website: ${profile.website}` : ""
  ].filter(Boolean).join("\n");
  const config = getAiConfig(session, "emailDraft");
  if (!requestedSubject && !requestedBody && config?.enabled && config.apiKey) {
    try {
      const prompt = [
        "Write one concise B2B cold outreach email in English using only the supplied facts.",
        "Do not invent certifications, customers, prices, capabilities or contact history.",
        "Return JSON only: {\"subject\":\"\",\"body\":\"\"}.",
        JSON.stringify({
          instruction: agentInputText(input, "instruction"),
          tone: agentInputText(input, "tone", "professional"),
          recipient: { company: entity.company, contact: entity.contactName, country: entity.country, context: entity.context },
          sender: { name: senderName, company: profile.companyName, products: profile.productSummary, website: profile.website },
          signature
        })
      ].join("\n");
      const parsed = extractJsonObject(await callAiModel(config, prompt, 12_000)) as Record<string, unknown>;
      if (typeof parsed.subject === "string" && parsed.subject.trim()) subject = parsed.subject.trim().slice(0, 160);
      if (typeof parsed.body === "string" && parsed.body.trim()) body = parsed.body.trim().slice(0, 6_000);
    } catch {
      // 模型不可用时保留基于真实 CRM 数据生成的安全模板。
    }
  }
  return {
    stored,
    session,
    entity,
    readiness,
    draft: {
      entityType,
      entityId,
      recipientCompany: entity.company,
      recipientName: entity.contactName,
      to: requestedTo || entity.email,
      subject,
      body,
      from: stored.outboundEmail || "",
      senderName,
      engine: config?.enabled && config.apiKey ? (config.name || config.model) : "安全模板"
    }
  };
}

async function communicationRequest<T>(session: SessionUser, path: string, init: RequestInit = {}): Promise<T> {
  const port = Number(process.env.WHATSAPP_PLUGIN_PORT || 3100);
  const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${signToken(session)}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error?: unknown }).error || "")
      : typeof payload === "object" && payload && "message" in payload
        ? String((payload as { message?: unknown }).message || "")
        : String(payload || `HTTP ${response.status}`);
    throw new Error(`Communication 发送失败：${message}`);
  }
  return payload as T;
}

async function startAgentProspectSearch(
  actor: { id: string },
  input: Record<string, unknown>,
  executionId: string
) {
  const { session } = agentSessionUser(actor);
  const products = agentInputList(input, "products").slice(0, 20);
  const markets = agentInputList(input, "markets").slice(0, 20);
  const customerTypes = agentInputList(input, "customerTypes").slice(0, 20);
  const industries = agentInputList(input, "industries").slice(0, 30);
  const exclusions = agentInputList(input, "exclusions").slice(0, 30);
  if (!products.length) throw new Error("启动搜客前需要明确产品关键词，请补充 products");
  if (!markets.length) throw new Error("启动搜客前需要明确目标国家或地区，请补充 markets");
  const resolvedCustomerTypes = customerTypes.length ? customerTypes : ["进口商/经销商"];
  const resolvedIndustries = industries.length ? industries : [...resolvedCustomerTypes];
  const providerStatuses = allProviderStatuses(session);
  const requestedProviderIds = agentInputList(input, "providerIds")
    .map((item) => item.toLocaleLowerCase("en-US"));
  const recommendedFreeProviders = providerStatuses
    .filter((item) => item.recommended && item.enabled && item.ready && item.accessMode === "api" && item.tier !== "paid" && item.id !== "ai_search")
    .map((item) => item.id);
  const providerIds = requestedProviderIds.length
    ? requestedProviderIds
    : (recommendedFreeProviders.length ? recommendedFreeProviders : providerStatuses
      .filter((item) => item.enabled && item.ready && item.accessMode === "api" && item.tier !== "paid" && item.id !== "ai_search")
      .map((item) => item.id).slice(0, 6));
  const unavailableProviders = providerIds.filter((providerId) => {
    const status = providerStatuses.find((item) => item.id === providerId);
    return !status || !status.enabled || !status.ready || status.accessMode !== "api";
  });
  if (unavailableProviders.length) throw new Error(`以下数据源尚未配置或不可自动执行：${unavailableProviders.join("、")}`);
  if (!providerIds.length) throw new Error("当前账号没有可执行的数据源，请先在自动获客中启用至少一个来源");
  const limitValue = Number(input.limit || 20);
  const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(1_000, Math.round(limitValue))) : 20;
  const goal = agentInputText(
    input,
    "goal",
    `开发${markets.join("、")}市场的${products.join("、")}${resolvedCustomerTypes.join("、")}`
  ).slice(0, 1_000);
  const title = agentInputText(
    input,
    "title",
    `${markets[0]} · ${products[0]} · ${resolvedCustomerTypes[0]}`
  ).slice(0, 160);
  const store = getStore();
  const requestPrefix = `agent-search:${executionId}`;
  const existingCampaignEvent = store.prospectCampaignEvents.find((item) =>
    item.eventType === "created"
    && item.actorId === session.id
    && item.teamId === session.teamId
    && item.requestId === `${requestPrefix}:campaign`
  );
  let campaignDetail = existingCampaignEvent
    ? getProspectCampaign(store, session, existingCampaignEvent.campaignId)
    : await createProspectCampaign({
      store,
      user: session,
      body: {
        name: title,
        snapshot: {
          goal,
          products,
          markets,
          customerTypes: resolvedCustomerTypes,
          applicationScenarios: resolvedIndustries,
          icpRules: [],
          exclusionRules: exclusions,
          sourceProviderIds: providerIds
        }
      },
      requestId: `${requestPrefix}:campaign`
    });
  let strategy = listProspectStrategies(store, session, campaignDetail.campaign.id, false).strategies
    .find((item) => item.campaignVersion === campaignDetail.campaign.currentVersion && item.status === "approved")
    || listProspectStrategies(store, session, campaignDetail.campaign.id, false).strategies
      .find((item) => item.campaignVersion === campaignDetail.campaign.currentVersion && item.status === "draft");
  if (!strategy) throw new Error("系统未能为获客项目生成可用策略");
  if (strategy.status === "draft") {
    const updated = await updateProspectStrategy({
      store,
      user: session,
      strategyId: strategy.id,
      ifMatch: prospectStrategyEtag(strategy),
      body: {
        name: `${title} · Agent 策略`,
        query: {
          keywordMode: "campaign_products",
          positiveKeywords: [],
          synonyms: [],
          industryTerms: resolvedIndustries,
          purchaseScenarioTerms: resolvedIndustries,
          countryMode: "campaign_markets",
          countries: [],
          languages: [],
          customerTypeMode: "campaign_customer_types",
          customerTypes: [],
          exclusionKeywords: exclusions,
          exclusionDomains: [],
          timeWindow: { mode: "all", from: "", to: "" }
        },
        providerPlan: providerIds.map((providerId, index) => ({
          providerId,
          priority: index + 1,
          pageLimit: 1,
          resultLimit: limit,
          budgetLimit: null,
          currency: ""
        })),
        reason: "由 AI Agent 在用户确认后生成"
      },
      requestId: `${requestPrefix}:strategy`
    });
    const approved = await approveProspectStrategy({
      store,
      user: session,
      strategyId: updated.strategy.id,
      ifMatch: prospectStrategyEtag(updated.strategy),
      reason: "用户已在 AI Agent 审批搜客条件",
      requestId: `${requestPrefix}:approve`
    });
    strategy = approved.strategy;
  }
  campaignDetail = getProspectCampaign(store, session, campaignDetail.campaign.id);
  if (campaignDetail.campaign.status === "draft" || campaignDetail.campaign.status === "paused") {
    campaignDetail = await activateProspectCampaign({
      store,
      user: session,
      campaignId: campaignDetail.campaign.id,
      ifMatch: prospectCampaignEtag(campaignDetail.campaign),
      requestId: `${requestPrefix}:activate`
    });
  }
  const existingRunEvent = store.prospectRunEvents.find((item) =>
    item.eventType === "created"
    && item.actorId === session.id
    && item.teamId === session.teamId
    && item.requestId === `${requestPrefix}:run`
  );
  const runDetail = existingRunEvent
    ? getProspectRun(store, session, existingRunEvent.runId)
    : await createProspectRun({
      store,
      user: session,
      strategyId: strategy.id,
      ifMatch: prospectStrategyEtag(strategy),
      idempotencyKey: requestPrefix,
      body: { reason: "AI Agent 用户确认后立即运行" },
      requestId: `${requestPrefix}:run`
    });
  await synchronizeProspectQueue();
  return {
    message: `搜客任务已进入后台队列，共 ${runDetail.shards.length} 个数据源`,
    runId: runDetail.run.id,
    campaignId: campaignDetail.campaign.id,
    strategyId: strategy.id,
    status: runDetail.run.status,
    providerCount: runDetail.shards.length,
    providerIds,
    replayed: Boolean(existingRunEvent || ("idempotencyReplayed" in runDetail && runDetail.idempotencyReplayed))
  };
}

async function getAgentProspectSearchProgress(actor: { id: string }, input: Record<string, unknown>) {
  const { session } = agentSessionUser(actor);
  const runId = agentInputText(input, "runId");
  if (!runId) throw new Error("缺少搜客任务 runId");
  const store = getStore();
  await store.readBarrier();
  const detail = getProspectRun(store, session, runId);
  const terminalStatuses = new Set(["succeeded", "succeeded_empty", "partial_success", "failed", "cancelled"]);
  const settledStatuses = new Set(["succeeded", "succeeded_empty", "partial_success", "failed", "cancelled"]);
  const settledSources = detail.shards.filter((item) => settledStatuses.has(item.status)).length;
  const progressUnits = detail.shards.reduce((total, shard) => {
    if (settledStatuses.has(shard.status)) return total + 1;
    if (["running", "pause_requested", "cancel_requested"].includes(shard.status)) return total + 0.5;
    return total;
  }, 0);
  const progress = detail.shards.length
    ? Math.round(progressUnits / detail.shards.length * 100)
    : terminalStatuses.has(detail.run.status) ? 100 : 0;
  const processingStates = (store.prospectCandidateProcessingStates || []).filter((item) =>
    item.teamId === session.teamId && item.ownerId === detail.run.ownerId && item.runId === runId
  );
  const candidateIds = [...new Set(processingStates
    .filter((item) => item.status === "completed" && item.candidateId)
    .map((item) => item.candidateId!))];
  const candidates = candidateIds
    .map((candidateId) => store.websiteOpportunities.find((item) => item.id === candidateId))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const verifiedCount = candidates.filter((item) => item.verificationReport && item.verificationReport.level !== "L0").length;
  const contactableCount = candidates.filter((item) => ["contactable", "contacted", "synced"].includes(item.status)).length;
  const filteredCount = processingStates.filter((item) => item.status === "rejected").length
    + candidates.filter((item) => item.status === "excluded").length;
  const terminal = terminalStatuses.has(detail.run.status);
  const currentAction = terminal
    ? "搜客任务已经结束，正在核对候选与清洗结果"
    : `搜客任务后台运行中，${settledSources}/${detail.shards.length} 个来源已结束`;
  return {
    message: terminal
      ? `搜客结束：候选 ${candidates.length} 家，已复核 ${verifiedCount} 家，清洗淘汰 ${filteredCount} 家`
      : `搜客进行中：${settledSources}/${detail.shards.length} 个来源已结束，当前候选 ${candidates.length} 家`,
    runId,
    status: detail.run.status,
    terminal,
    progress,
    currentAction,
    sourceCount: detail.shards.length,
    settledSources,
    candidateCount: candidates.length,
    verifiedCount,
    contactableCount,
    filteredCount,
    nextCheckAt: terminal ? "" : new Date(Date.now() + 4_000).toISOString(),
    candidates: candidates.slice(0, 12).map((item) => ({
      id: item.id,
      company: item.company,
      country: item.country,
      website: item.website,
      status: item.status,
      verificationLevel: item.verificationReport?.level || "L0"
    })),
    sources: detail.shards.map((item) => ({ providerId: item.providerCode, status: item.status }))
  };
}

async function listAgentProspectCandidates(actor: { id: string }, input: Record<string, unknown>) {
  const { session } = agentSessionUser(actor);
  const store = getStore();
  await store.readBarrier();
  const runId = agentInputText(input, "runId");
  let candidateIds: string[] = [];
  if (runId) {
    getProspectRun(store, session, runId);
    candidateIds = [...new Set((store.prospectCandidateProcessingStates || [])
      .filter((item) => item.teamId === session.teamId && item.ownerId === session.id && item.runId === runId && item.status === "completed" && item.candidateId)
      .map((item) => item.candidateId!))];
  }
  const limitValue = Number(input.limit || 20);
  const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(50, Math.round(limitValue))) : 20;
  const candidates = store.websiteOpportunities
    .filter((item) => item.teamId === session.teamId && item.ownerId === session.id)
    .filter((item) => !runId || candidateIds.includes(item.id))
    .filter((item) => item.status !== "excluded")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
    .map((item) => {
      const approvedDecision = item.tenantProspectId
        ? store.prospectContactabilityDecisions
          .filter((decision) =>
            decision.teamId === session.teamId
            && decision.ownerId === session.id
            && decision.prospectId === item.tenantProspectId
            && decision.status === "approved_contactable"
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        : undefined;
      return {
        candidateId: item.id,
        tenantProspectId: item.tenantProspectId || "",
        company: item.company,
        country: item.country,
        business: item.business,
        website: item.website,
        contact: item.contact,
        contactInfo: item.contactInfo,
        confidence: item.confidence || 0,
        verificationLevel: item.verificationReport?.level || "L0",
        verificationConclusion: item.verificationReport?.conclusion || "尚未形成企业复核结论",
        contactabilityApproved: Boolean(approvedDecision),
        decisionId: approvedDecision?.id || "",
        leadId: item.leadId || "",
        customerId: item.customerId || "",
        status: item.status
      };
    });
  return {
    message: `已读取 ${candidates.length} 家候选，其中 ${candidates.filter((item) => item.contactabilityApproved).length} 家已有人工可联系审批`,
    runId,
    count: candidates.length,
    approvedCount: candidates.filter((item) => item.contactabilityApproved).length,
    candidates
  };
}

async function convertAgentProspectToLead(
  actor: { id: string },
  input: Record<string, unknown>,
  executionId: string
) {
  const { session } = agentSessionUser(actor);
  const store = getStore();
  const candidateId = agentInputText(input, "candidateId");
  const candidate = store.websiteOpportunities.find((item) =>
    item.id === candidateId && item.teamId === session.teamId && item.ownerId === session.id
  );
  if (!candidate) throw new Error("候选不存在或不属于当前账号");
  if (!candidate.tenantProspectId) throw new Error("候选尚未进入正式企业覆盖池，不能转为线索");
  if (!store.convertProspectToLead) throw new Error("候选转线索服务暂不可用");
  const approvedDecision = store.prospectContactabilityDecisions
    .filter((decision) =>
      decision.teamId === session.teamId
      && decision.ownerId === session.id
      && decision.prospectId === candidate.tenantProspectId
      && decision.status === "approved_contactable"
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const decisionId = agentInputText(input, "decisionId") || approvedDecision?.id || "";
  if (!decisionId) throw new Error("候选尚未完成人工可联系审批，请先在搜客清单完成复核");
  const intentValue = agentInputText(input, "intent", "中");
  const intent = intentValue === "高" || intentValue === "低" ? intentValue : "中";
  const amountValue = Number(input.estimatedAmount || 0);
  const result = await store.convertProspectToLead({
    operationCode: "convert_prospect_to_lead_v1",
    decisionId,
    mode: "create_new",
    existingLeadId: "",
    company: candidate.company,
    contact: candidate.contact,
    country: candidate.country,
    intent,
    estimatedAmount: Number.isFinite(amountValue) ? Math.max(0, amountValue) : 0,
    nextFollowAt: agentInputText(input, "nextFollowAt"),
    remark: agentInputText(input, "remark", "由 AI Agent 在用户确认后转为线索").slice(0, 2_000),
    teamId: session.teamId,
    ownerId: session.id,
    prospectId: candidate.tenantProspectId,
    idempotencyKey: `agent-lead:${executionId}`,
    convertedAt: new Date().toISOString()
  });
  await store.reloadProspectCandidates?.();
  const linkedCandidates = store.websiteOpportunities.filter((item) =>
    item.teamId === session.teamId && item.ownerId === session.id && item.tenantProspectId === candidate.tenantProspectId
  );
  linkedCandidates.forEach((item) => {
    migrateProspectFollowUpTodos(store, item, result.lead.id);
    linkProcurementContextToLead(store, item, result.lead.id);
  });
  if (linkedCandidates.length) await persistCandidateChanges(store, linkedCandidates, true);
  return {
    message: `${candidate.company} 已${result.created ? "新建" : "关联"}线索`,
    converted: true,
    replayed: result.replayed,
    candidateId,
    leadId: result.lead.id,
    company: result.lead.company,
    uiAction: { type: "open_lead", leadId: result.lead.id }
  };
}

async function convertAgentProspectToCustomer(
  actor: { id: string },
  input: Record<string, unknown>,
  executionId: string
) {
  const { session } = agentSessionUser(actor);
  const store = getStore();
  const candidateId = agentInputText(input, "candidateId");
  const candidate = store.websiteOpportunities.find((item) =>
    item.id === candidateId && item.teamId === session.teamId && item.ownerId === session.id
  );
  if (!candidate) throw new Error("候选不存在或不属于当前账号");
  if (!candidate.tenantProspectId) throw new Error("候选尚未进入正式企业覆盖池，不能转为客户");
  if (!store.convertProspectToCustomer) throw new Error("候选转客户服务暂不可用");
  const leadId = agentInputText(input, "leadId") || candidate.leadId || "";
  const lead = store.leads.find((item) => item.id === leadId && item.teamId === session.teamId && item.ownerId === session.id);
  if (!lead) throw new Error("候选必须先转为当前账号的线索，才能继续转为客户");
  const result = await store.convertProspectToCustomer({
    operationCode: "convert_prospect_to_customer_v1",
    leadId,
    mode: "create_new",
    existingCustomerId: "",
    company: candidate.company,
    contact: candidate.contact,
    country: candidate.country,
    nextReminder: agentInputText(input, "nextReminder") || lead.nextFollowAt,
    teamId: session.teamId,
    ownerId: session.id,
    prospectId: candidate.tenantProspectId,
    idempotencyKey: `agent-customer:${executionId}`,
    convertedAt: new Date().toISOString()
  });
  await store.reloadProspectCandidates?.();
  const linkedCandidates = store.websiteOpportunities.filter((item) =>
    item.teamId === session.teamId && item.ownerId === session.id && item.tenantProspectId === candidate.tenantProspectId
  );
  linkedCandidates.forEach((item) => { item.customerId = result.customer.id; });
  linkProcurementContextToCustomer(store, {
    teamId: session.teamId,
    ownerId: session.id,
    leadId: result.lead.id,
    tenantProspectId: candidate.tenantProspectId,
    prospectCandidateIds: linkedCandidates.map((item) => item.id)
  }, result.customer.id);
  if (linkedCandidates.length) await persistCandidateChanges(store, linkedCandidates, true);
  return {
    message: `${candidate.company} 已${result.created ? "新建" : "关联"}客户`,
    converted: true,
    replayed: result.replayed,
    candidateId,
    leadId: result.lead.id,
    customerId: result.customer.id,
    company: result.customer.company,
    uiAction: { type: "open_customer", customerId: result.customer.id }
  };
}

async function agentOutreachSequenceStopReason(sequence: OutreachSequence) {
  const store = getStore();
  const lead = sequence.entityType === "lead" ? store.leads.find((item) => item.id === sequence.entityId) : undefined;
  const customer = sequence.entityType === "customer" ? store.customers.find((item) => item.id === sequence.entityId) : undefined;
  if (!lead && !customer) return "触达对象已不存在";
  try {
    await store.reloadProspectQualificationTeam?.(sequence.teamId);
    assertCrmOutreachEligible(store, {
      target: lead
        ? { entityType: "lead", entity: lead }
        : { entityType: "customer", entity: customer! },
      actorId: sequence.ownerId,
      channel: sequence.channel === "email" ? "email" : "whatsapp",
      recipient: sequence.recipient
    });
  } catch (error) {
    if (error instanceof ProspectOutreachEligibilityError) {
      return error.message;
    }
    throw error;
  }
  if (lead?.convertedCustomerId || lead?.status === "converted") return "线索已转化为客户";
  const candidates = store.websiteOpportunities.filter((item) =>
    item.ownerId === sequence.ownerId
    && (item.leadId === sequence.entityId || item.customerId === sequence.entityId)
  );
  const blocked = candidates.find((item) => item.outreachState === "suppressed"
    || item.outreachState === "contact_invalid"
    || item.outreachState === "replied"
    || item.lastReplyClassification === "unsubscribed"
    || item.lastReplyClassification === "rejected"
    || item.lastReplyClassification === "bounced");
  if (blocked) {
    if (blocked.lastReplyClassification === "unsubscribed") return "联系人已退订";
    if (blocked.lastReplyClassification === "rejected") return "联系人已明确拒绝";
    if (blocked.lastReplyClassification === "bounced" || blocked.outreachState === "contact_invalid") return "联系方式已失效或退信";
    return "已检测到客户回复";
  }
  const since = new Date(sequence.lastSentAt || sequence.approvedAt).getTime();
  const activities = customer
    ? store.customerActivities.filter((item) => item.customerId === customer.id)
    : store.leadActivities.filter((item) => item.leadId === lead!.id);
  if (activities.some((item) => new Date(item.createdAt).getTime() > since
    && !item.content.includes("[Agent:")
    && /(客户回复|收到回复|客户来信|inbound|replied|退订|退信|拒绝)/iu.test(item.content))) {
    return "CRM 已记录客户回复或拒绝信号";
  }
  if (sequence.channel !== "communication" || !customer) return "";
  try {
    const { session } = agentSessionUser({ id: sequence.ownerId });
    type Account = { id: string; status: string };
    type Conversation = { id: string; accountId: string; contactPhone: string };
    type Message = { direction: "inbound" | "outbound"; occurredAt: string; createdAt: string };
    const accounts = await communicationRequest<Account[]>(session, "/accounts");
    const connected = accounts.filter((item) => item.status === "connected" && (!sequence.accountId || item.id === sequence.accountId));
    const phone = (customer.whatsapp || "").replace(/[\s()-]/g, "");
    for (const account of connected) {
      const conversations = await communicationRequest<Conversation[]>(session, `/conversations?accountId=${encodeURIComponent(account.id)}`);
      const conversation = conversations.find((item) => item.contactPhone.replace(/[\s()-]/g, "") === phone);
      if (!conversation) continue;
      const messages = await communicationRequest<Message[]>(session, `/conversations/${encodeURIComponent(conversation.id)}/messages`);
      if (messages.some((item) => item.direction === "inbound" && new Date(item.occurredAt || item.createdAt).getTime() > since)) {
        return "Communication 已收到客户回复";
      }
    }
  } catch {
    // 通讯服务暂不可用时不误判回复，发送阶段仍会做连接校验。
  }
  return "";
}

interface AgentApiCatalogRow {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  risk: "read" | "write" | "external";
  operationId: string;
  parameters: unknown[];
  requestSchema: Record<string, unknown> | null;
  guidance: string;
  authorizationPolicy: AgentOperationContract["authorizationPolicy"];
  completionEvidence: AgentOperationContract["completionEvidence"];
  refreshView: string;
  schemaSource: AgentOperationContract["schemaSource"];
  executable: boolean;
  contract: AgentOperationContract;
}

function agentApiCatalogRows(): AgentApiCatalogRow[] {
  const document = createOpenApiDocument(app) as { paths?: Record<string, Record<string, any>> };
  const rows: AgentApiCatalogRow[] = [];
  for (const [path, operations] of Object.entries(document.paths || {})) {
    if (deniedAgentApiReason(path)) continue;
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation = operations[method];
      if (!operation) continue;
      const upperMethod = method.toUpperCase() as AgentApiCatalogRow["method"];
      let risk: AgentApiCatalogRow["risk"];
      try {
        const classified = classifyAgentApiRequest(upperMethod, path);
        if (classified === "draft") continue;
        risk = classified;
      } catch {
        continue;
      }
      const openApiSchema = operation.requestBody?.content?.["application/json"]?.schema || null;
      const contract = agentApiOperationContract(upperMethod, path, openApiSchema, risk);
      rows.push({
        method: upperMethod,
        path,
        risk,
        operationId: String(operation.operationId || ""),
        parameters: Array.isArray(operation.parameters) ? operation.parameters.slice(0, 20) : [],
        requestSchema: contract.requestSchema,
        guidance: contract.guidance,
        authorizationPolicy: contract.authorizationPolicy,
        completionEvidence: contract.completionEvidence,
        refreshView: contract.refreshView,
        schemaSource: contract.schemaSource,
        executable: contract.executable,
        contract
      });
    }
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
}

function findAgentApiRoute(method: string, path: string) {
  return agentApiCatalogRows().find((item) => item.method === method && routeTemplateMatches(item.path, path));
}

function appendAgentApiQuery(url: URL, query: Record<string, string | number | boolean | Array<string | number | boolean>>) {
  for (const [key, rawValue] of Object.entries(query)) {
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) url.searchParams.append(key, String(value));
  }
}

const agentExecutionRuntime: AgentExecutionRuntime = {
  async listCrmApiCatalog(_actor, input) {
    const query = String(input.query || "").trim().toLowerCase();
    const terms = query.split(/\s+/u).filter((item) => item.length > 1);
    const method = String(input.method || "").trim().toUpperCase();
    const offset = Math.max(0, Math.min(10_000, Number(input.offset || 0)));
    const limit = Math.max(1, Math.min(100, Number(input.limit || 30)));
    const all = agentApiCatalogRows();
    const matched = all.filter((item) => (!method || item.method === method)
      && (!terms.length || terms.some((term) => `${item.path} ${item.operationId}`.toLowerCase().includes(term))));
    const routes = matched.slice(offset, offset + limit).map(({ contract: _contract, ...route }) => route);
    const executable = all.filter((item) => item.executable).length;
    return {
      count: routes.length,
      total: matched.length,
      offset,
      hasMore: offset + routes.length < matched.length,
      coverage: { total: all.length, executable, blocked: all.length - executable, percent: all.length ? Math.round(executable / all.length * 1000) / 10 : 100 },
      excluded: "账号、登录、个人资料、密钥、个人 Communication 绑定和 Agent 控制面",
      routes
    };
  },
  async requestCrmApi(actor, rawInput, tool, executionId) {
    const parsed = agentApiRequestSchema.parse(rawInput);
    const path = normalizeAgentApiPath(parsed.path);
    assertAgentApiToolRisk(tool, parsed.method, path);
    const route = findAgentApiRoute(parsed.method, path);
    if (!route) throw new Error("接口不在当前可用业务目录中，请先通过 api.catalog 获取真实 method 和 path");
    assertAgentOperationInput(route.contract, parsed.body);
    const { session } = agentSessionUser(actor);
    const port = Number(process.env.PORT || 4188);
    const url = new URL(`http://127.0.0.1:${port}${path}`);
    appendAgentApiQuery(url, parsed.query);
    const serializedBody = parsed.body === undefined || parsed.method === "GET"
      ? undefined
      : JSON.stringify(parsed.body);
    let response: Awaited<ReturnType<typeof requestAgentInternalApi>>;
    try {
      response = await requestAgentInternalApi({
        url,
        method: parsed.method,
        headers: {
          authorization: `Bearer ${signToken(session)}`,
          "x-agent-execution-id": executionId,
          ...parsed.headers,
          ...(parsed.body === undefined ? {} : { "content-type": "application/json" })
        },
        body: serializedBody,
        timeoutMs: 60_000
      });
    } catch (error) {
      const cause = error && typeof error === "object" && "cause" in error
        ? (error as { cause?: unknown }).cause
        : undefined;
      const causeCode = cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code?: unknown }).code || "")
        : "";
      const causeMessage = cause && typeof cause === "object" && "message" in cause
        ? String((cause as { message?: unknown }).message || "")
        : "";
      const detail = [
        error instanceof Error ? error.message : String(error),
        causeCode,
        causeMessage
      ].filter((item, index, values) => item && values.indexOf(item) === index).join("; ");
      throw new Error(`CRM 内部接口连接失败（${parsed.method} ${path}）：${detail || "未知网络错误"}`);
    }
    const contentType = String(response.headers["content-type"] || "");
    let payload: unknown;
    if (contentType.includes("json")) {
      const text = response.body.toString("utf8");
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text.slice(0, 20_000) }; }
    } else {
      const size = response.body.length;
      payload = { contentType, size, message: "接口已执行；非 JSON 文件内容未注入 Agent 上下文" };
    }
    const safePayload = redactAgentApiData(payload);
    if (response.status < 200 || response.status >= 300) {
      const message = typeof safePayload === "object" && safePayload && "message" in safePayload
        ? String((safePayload as { message?: unknown }).message || "")
        : `HTTP ${response.status}`;
      throw new Error(`CRM 接口调用失败（${response.status}）：${message}`);
    }
    assertAgentCompletionEvidence(route.contract, safePayload);
    return {
      status: response.status,
      method: parsed.method,
      path,
      data: safePayload,
      route: { template: route.path, operationId: route.operationId, contractVersion: route.contract.version },
      completionEvidence: route.completionEvidence,
      uiAction: parsed.method === "GET" || !route.refreshView ? undefined : { type: "refresh", view: route.refreshView }
    };
  },
  async draftDevelopmentEmail(actor, input) {
    const prepared = await buildAgentDevelopmentEmail(actor, input);
    return {
      draft: prepared.draft,
      readiness: prepared.readiness,
      uiAction: { type: "open_development_email", entityType: prepared.draft.entityType, entityId: prepared.draft.entityId }
    };
  },
  async sendDevelopmentEmail(actor, input, executionId) {
    const prepared = await buildAgentDevelopmentEmail(actor, input);
    const { stored, entity, readiness, draft } = prepared;
    if (!readiness.personalReady) throw new Error(`个人发件配置不完整：${readiness.personalMissing.join("、")}`);
    if (!readiness.companyReady) throw new Error(`公司资料不完整，请管理员维护：${readiness.companyMissing.join("、")}`);
    if (!draft.to) throw new Error("客户或线索没有可用邮箱，请先补齐邮箱");
    const marker = `[Agent:${executionId}]`;
    const replayedActivity = entity.lead
      ? getStore().leadActivities.find((item) => item.leadId === entity.lead!.id && item.content.includes(marker))
      : getStore().customerActivities.find((item) => item.customerId === entity.customer!.id && item.content.includes(marker));
    if (replayedActivity) {
      return { sent: true, replayed: true, activityId: replayedActivity.id, to: draft.to, subject: draft.subject, uiAction: { type: "open_development_email", entityType: draft.entityType, entityId: draft.entityId } };
    }
    await getStore().reloadProspectQualificationTeam?.(actor.teamId);
    const outreachEligibility = assertCrmOutreachEligible(getStore(), {
      target: entity.lead
        ? { entityType: "lead", entity: entity.lead }
        : { entityType: "customer", entity: entity.customer! },
      actorId: actor.id,
      channel: "email",
      recipient: draft.to
    });
    const domain = (stored.outboundEmail || "").split("@")[1] || "goodjob.local";
    const mailInfo = await sendOutboundEmail(stored, {
      to: outreachEligibility.recipient,
      subject: draft.subject,
      body: draft.body,
      messageId: `<${executionId}@${domain}>`
    });
    const sentAt = new Date().toISOString();
    const nextFollowAt = agentInputText(input, "nextFollowAt") || new Date(Date.now() + 3 * 86_400_000).toISOString();
    stored.lastDevelopmentEmailAt = sentAt;
    stored.lastDevelopmentEmailTo = outreachEligibility.recipient;
    stored.lastDevelopmentEmailSubject = draft.subject;
    let activityId = "";
    if (entity.lead) {
      const activity = { id: `la_agent_${randomUUID()}`, leadId: entity.lead.id, type: "email" as const, content: `开发信已由 AI Agent 后台发送：${draft.subject} ${marker}`, operatorId: actor.id, nextFollowAt, createdAt: sentAt };
      getStore().leadActivities.unshift(activity);
      activityId = activity.id;
      entity.lead.lastActivityAt = "刚刚";
      entity.lead.nextFollowAt = nextFollowAt;
    } else if (entity.customer) {
      const activity = { id: `ca_agent_${randomUUID()}`, customerId: entity.customer.id, type: "email" as const, content: `开发信已由 AI Agent 后台发送：${draft.subject} ${marker}`, operatorId: actor.id, nextReminder: nextFollowAt, createdAt: sentAt };
      getStore().customerActivities.unshift(activity);
      activityId = activity.id;
      entity.customer.nextReminder = nextFollowAt;
    }
    getStore().todos.unshift({
      id: `t_agent_${randomUUID()}`, title: `跟进开发信回复：${entity.company}`, type: "customer", priority: "high", status: "pending", pinState: "", sortOrder: 0,
      dueAt: nextFollowAt, ownerId: actor.id, teamId: actor.teamId, related: entity.company, done: false, createdAt: sentAt, historyAt: "", customerId: entity.customer?.id || ""
    });
    await getStore().persist();
    return { sent: true, replayed: false, messageId: mailInfo.messageId, activityId, to: outreachEligibility.recipient, subject: draft.subject, sentAt, followUpCreated: true, uiAction: { type: "open_development_email", entityType: draft.entityType, entityId: draft.entityId } };
  },
  async sendWhatsApp(actor, input, executionId) {
    const { session } = agentSessionUser(actor);
    const customerId = agentInputText(input, "customerId");
    const customer = getStore().customers.find((item) => item.id === customerId && canSeeOwner(session, item.ownerId, item.teamId));
    if (!customer || (customer.ownerId !== actor.id && !["admin", "super_admin"].includes(actor.role))) throw new Error("客户不存在，或只有客户负责人和管理员可以发送 Communication 消息");
    const phone = (customer.whatsapp || "").replace(/[\s()-]/g, "");
    if (!/^\+[1-9]\d{6,14}$/u.test(phone)) throw new Error("客户没有有效的 WhatsApp 国际号码");
    const marker = `[Agent:${executionId}]`;
    const replayedActivity = getStore().customerActivities.find((item) =>
      item.customerId === customer.id && item.content.includes(marker)
    );
    if (replayedActivity) {
      return {
        sent: true,
        replayed: true,
        activityId: replayedActivity.id,
        phone,
        uiAction: { type: "open_communication", customerId: customer.id }
      };
    }
    await getStore().reloadProspectQualificationTeam?.(actor.teamId);
    assertCrmOutreachEligible(getStore(), {
      target: { entityType: "customer", entity: customer },
      actorId: actor.id,
      channel: "whatsapp",
      recipient: phone
    });
    let body = agentInputText(input, "body");
    if (!body) {
      const profile = companyProfileForTeam(actor.teamId);
      body = `Hello ${customer.contact || "there"}, this is ${session.name} from ${profile.companyName || "our company"}. I would like to follow up regarding potential cooperation with ${customer.company}.`;
    }
    if (body.length > 4_000) throw new Error("Communication 消息不能超过 4000 字符");
    type Account = { id: string; status: string; name: string };
    type Contact = { id: string; accountId: string; phone: string };
    type Conversation = { id: string; accountId: string };
    type Message = { id: string; status: string; createdAt: string };
    const accounts = await communicationRequest<Account[]>(session, "/accounts");
    const requestedAccountId = agentInputText(input, "accountId");
    const account = accounts.find((item) => item.status === "connected" && (!requestedAccountId || item.id === requestedAccountId));
    if (!account) throw new Error("当前账号没有已连接的 Communication 发送账号，请先扫码或配置 Meta 账号");
    const contacts = await communicationRequest<Contact[]>(session, `/contacts?accountId=${encodeURIComponent(account.id)}`);
    let contact = contacts.find((item) => item.phone.replace(/[\s()-]/g, "") === phone);
    if (!contact) {
      contact = await communicationRequest<Contact>(session, "/contacts", { method: "POST", body: JSON.stringify({ accountId: account.id, displayName: customer.contact || customer.company, phone, createCrmContact: false }) });
    }
    const conversation = await communicationRequest<Conversation>(session, `/contacts/${encodeURIComponent(contact.id)}/conversation`, { method: "POST" });
    const message = await communicationRequest<Message>(session, `/conversations/${encodeURIComponent(conversation.id)}/messages`, { method: "POST", body: JSON.stringify({ accountId: account.id, clientMessageId: executionId, body }) });
    let activity = getStore().customerActivities.find((item) => item.customerId === customer.id && item.content.includes(marker));
    if (!activity) {
      activity = { id: `ca_agent_${randomUUID()}`, customerId: customer.id, type: "whatsapp", content: `Communication 已由 AI Agent 后台发送：${body.slice(0, 500)} ${marker}`, operatorId: actor.id, nextReminder: agentInputText(input, "nextReminder"), createdAt: new Date().toISOString() };
      getStore().customerActivities.unshift(activity);
      await getStore().persist();
    }
    return { sent: true, accountId: account.id, accountName: account.name, conversationId: conversation.id, messageId: message.id, activityId: activity.id, status: message.status, phone, uiAction: { type: "open_communication", customerId: customer.id } };
  },
  async startProspectSearch(actor, input, executionId) {
    return await startAgentProspectSearch(actor, input, executionId);
  },
  async getProspectSearchProgress(actor, input) {
    return await getAgentProspectSearchProgress(actor, input);
  },
  async listProspectCandidates(actor, input) {
    return await listAgentProspectCandidates(actor, input);
  },
  async convertProspectToLead(actor, input, executionId) {
    return await convertAgentProspectToLead(actor, input, executionId);
  },
  async convertProspectToCustomer(actor, input, executionId) {
    return await convertAgentProspectToCustomer(actor, input, executionId);
  },
  async createOutreachSequence(actor, input, executionId, missionRunId) {
    const sequence = await createOutreachSequence(getStore(), actor, input, missionRunId, executionId);
    void activeOutreachSequenceRunner?.synchronize();
    return {
      sequenceId: sequence.id,
      status: sequence.status,
      channel: sequence.channel,
      entityName: sequence.entityName,
      currentStep: sequence.currentStep,
      maxSends: sequence.maxSends,
      nextExecutionAt: sequence.nextExecutionAt,
      stopReason: sequence.stopReason
    };
  },
  async getOutreachSequenceProgress(actor, input) {
    const sequenceId = agentInputText(input, "sequenceId");
    const sequences = listOutreachSequences(getStore(), actor, 20)
      .filter((item) => !sequenceId || item.id === sequenceId);
    if (!sequenceId) return { count: sequences.length, sequences };
    const sequence = sequences[0];
    if (!sequence) throw new Error("触达序列不存在或当前账号无权查看");
    const terminal = ["completed", "stopped", "cancelled", "failed"].includes(sequence.status);
    const due = new Date(sequence.nextExecutionAt).getTime();
    const nextCheckAt = terminal
      ? ""
      : Number.isFinite(due) && due > Date.now()
        ? sequence.nextExecutionAt
        : new Date(Date.now() + 5_000).toISOString();
    return {
      sequenceId: sequence.id,
      status: sequence.status,
      terminal,
      progress: Math.round((sequence.currentStep / Math.max(1, sequence.maxSends)) * 100),
      currentStep: sequence.currentStep,
      maxSends: sequence.maxSends,
      nextExecutionAt: sequence.nextExecutionAt,
      nextCheckAt,
      stopReason: sequence.stopReason,
      currentAction: terminal ? (sequence.stopReason || "自动触达已结束") : `等待第 ${sequence.currentStep + 1}/${sequence.maxSends} 次触达`
    };
  },
  async controlOutreachSequence(actor, input, action) {
    const sequence = await controlOutreachSequence(getStore(), actor, agentInputText(input, "sequenceId"), action);
    void activeOutreachSequenceRunner?.synchronize();
    return { sequenceId: sequence.id, status: sequence.status, currentStep: sequence.currentStep, maxSends: sequence.maxSends, nextExecutionAt: sequence.nextExecutionAt, stopReason: sequence.stopReason };
  },
  async previewCustomerMaintenance(actor, input) {
    return previewCustomerMaintenance(getStore(), actor, input);
  },
  async createCustomerMaintenanceWatch(actor, input, executionId, missionRunId) {
    const watch = await createCustomerMaintenanceWatch(getStore(), actor, input, missionRunId, executionId);
    void activeCustomerMaintenanceRunner?.synchronize();
    return {
      watchId: watch.id,
      status: watch.status,
      name: watch.name,
      nextRunAt: watch.nextRunAt,
      intervalHours: watch.rules.intervalHours,
      maxTodosPerRun: watch.rules.maxTodosPerRun
    };
  },
  async getCustomerMaintenanceProgress(actor, input) {
    const watchId = agentInputText(input, "watchId");
    const watches = listCustomerMaintenanceWatches(getStore(), actor, 20).filter((item) => !watchId || item.id === watchId);
    return { count: watches.length, watches };
  },
  async controlCustomerMaintenanceWatch(actor, input, action) {
    const watch = await controlCustomerMaintenanceWatch(getStore(), actor, agentInputText(input, "watchId"), action);
    void activeCustomerMaintenanceRunner?.synchronize();
    return { watchId: watch.id, status: watch.status, nextRunAt: watch.nextRunAt, totalCreatedCount: watch.totalCreatedCount, lastError: watch.lastError };
  },
  async runBackgroundResearch(actor, input) {
    const { session } = agentSessionUser(actor);
    const entityType = agentInputText(input, "entityType") === "lead" ? "lead" : "customer";
    const entityId = agentInputText(input, "entityId");
    if (!entityId) throw new Error("AI 背调需要明确客户或线索编号");
    const payload = await buildBackgroundResearch(session, { entityType, entityId });
    if (!payload) throw new Error(entityType === "lead" ? "线索不存在或当前账号无权访问" : "客户不存在或当前账号无权访问");
    const research = payload.research as unknown as Record<string, unknown>;
    return {
      research,
      score: research.score,
      verdict: research.verdict,
      riskCount: Array.isArray(research.risks) ? research.risks.length : 0,
      opportunityCount: Array.isArray(research.opportunities) ? research.opportunities.length : 0,
      uiAction: { type: "open_research", entityType, entityId }
    };
  },
  async getCommunicationInbox(actor, input) {
    const { session } = agentSessionUser(actor);
    type Account = { id: string; status: string; name: string };
    type Conversation = { id: string; accountId: string; contactName: string; contactPhone: string; unreadCount: number; lastMessage: string | null; lastMessageAt: string | null };
    const limit = Math.max(1, Math.min(50, Number(input.limit || 20)));
    const accounts = (await communicationRequest<Account[]>(session, "/accounts")).filter((item) => item.status === "connected");
    const rows: Array<Record<string, unknown>> = [];
    for (const account of accounts) {
      const conversations = await communicationRequest<Conversation[]>(session, `/conversations?accountId=${encodeURIComponent(account.id)}`);
      for (const conversation of conversations.filter((item) => item.unreadCount > 0)) {
        const phone = conversation.contactPhone.replace(/[\s()-]/g, "");
        const customer = getStore().customers.find((item) => item.ownerId === actor.id && (item.whatsapp || "").replace(/[\s()-]/g, "") === phone);
        rows.push({
          accountId: account.id,
          accountName: account.name,
          conversationId: conversation.id,
          contactName: conversation.contactName,
          phone,
          unreadCount: conversation.unreadCount,
          lastMessage: conversation.lastMessage || "",
          lastMessageAt: conversation.lastMessageAt || "",
          customerId: customer?.id || "",
          customerCompany: customer?.company || "未关联 CRM 客户",
          uiAction: customer ? { type: "open_communication", customerId: customer.id } : undefined
        });
      }
    }
    rows.sort((left, right) => String(right.lastMessageAt).localeCompare(String(left.lastMessageAt)));
    const conversations = rows.slice(0, limit);
    return {
      count: conversations.length,
      totalUnread: conversations.reduce((sum, item) => sum + Number(item.unreadCount || 0), 0),
      connectedAccountCount: accounts.length,
      conversations
    };
  }
};

let activeAgentBackgroundRunner: AgentBackgroundRunner | null = null;
let activeOutreachSequenceRunner: OutreachSequenceRunner | null = null;
let activeCustomerMaintenanceRunner: CustomerMaintenanceRunner | null = null;
let activeAgentTriggerRunner: AgentTriggerRunner | null = null;
let activeSalesTrainingRunner: SalesTrainingRunner | null = null;

app.get("/api/agent/catalog", requireAuth, (_req, res) => {
  res.json({ tools: agentCatalog() });
});

app.get("/api/agent/outreach-sequences", requireAuth, (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
  res.json({ sequences: listOutreachSequences(getStore(), req.user!, limit) });
});

app.post("/api/agent/outreach-sequences/:id/:action", requireAuth, asyncRoute(async (req, res) => {
  const action = z.enum(["pause", "resume", "cancel"]).parse(req.params.action);
  const sequence = await controlOutreachSequence(getStore(), req.user!, req.params.id, action);
  void activeOutreachSequenceRunner?.synchronize();
  res.json({ sequence });
}));

app.get("/api/agent/customer-maintenance", requireAuth, (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
  res.json({ watches: listCustomerMaintenanceWatches(getStore(), req.user!, limit) });
});

app.post("/api/agent/customer-maintenance/:id/:action", requireAuth, asyncRoute(async (req, res) => {
  const action = z.enum(["pause", "resume", "cancel"]).parse(req.params.action);
  const watch = await controlCustomerMaintenanceWatch(getStore(), req.user!, req.params.id, action);
  void activeCustomerMaintenanceRunner?.synchronize();
  res.json({ watch });
}));

app.get("/api/agent/sales-distillation/sources", requireAuth, (req, res) => {
  res.json({ sources: listDistillationSources(getStore(), req.user!) });
});

app.get("/api/agent/sales-training", requireAuth, (req, res) => {
  res.json({ runs: listSalesTrainingRuns(getStore(), req.user!) });
});

app.get("/api/agent/sales-training/:id", requireAuth, (req, res) => {
  res.json({ run: getSalesTrainingRun(getStore(), req.user!, req.params.id) });
});

app.post("/api/agent/sales-training", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ sourceUserId: z.string().min(1).max(100), periodDays: z.coerce.number().int().min(7).max(365).optional().default(90) }).parse(req.body || {});
  const run = await createSalesTrainingRun(getStore(), req.user!, body.sourceUserId, body.periodDays);
  void activeSalesTrainingRunner?.synchronize();
  res.status(201).json({ run });
}));

app.post("/api/agent/sales-training/:id/:action", requireAuth, asyncRoute(async (req, res, next) => {
  const parsed = z.enum(["pause", "resume", "cancel", "retrain", "publish"]).safeParse(req.params.action);
  if (!parsed.success) return next();
  try {
    if (parsed.data === "retrain") {
      const run = await retrainSalesTrainingRun(getStore(), req.user!, req.params.id);
      void activeSalesTrainingRunner?.synchronize();
      res.status(201).json({ run });
      return;
    }
    if (parsed.data === "publish") {
      const result = await publishSalesTrainingRun(getStore(), req.user!, req.params.id);
      res.json(result);
      return;
    }
    const run = await controlSalesTrainingRun(getStore(), req.user!, req.params.id, parsed.data);
    if (parsed.data === "resume") void activeSalesTrainingRunner?.synchronize();
    res.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "销售训练操作失败";
    res.status(/无权|主管|管理员/u.test(message) ? 403 : 400).json({ message });
  }
}));

app.patch("/api/agent/sales-training/:id/samples/:sampleId", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ label: z.enum(["positive", "negative", "neutral"]).optional(), included: z.boolean().optional(), managerNote: z.string().max(500).optional() }).parse(req.body || {});
  const run = await updateSalesTrainingSample(getStore(), req.user!, req.params.id, req.params.sampleId, body);
  res.json({ run });
}));

app.get("/api/agent/sales-distillation", requireAuth, (req, res) => {
  res.json({
    distillations: listSalesDistillations(getStore(), req.user!),
    activations: listSalesPlaybookActivations(getStore(), req.user!)
  });
});

app.post("/api/agent/sales-distillation", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    sourceUserId: z.string().min(1).max(100),
    periodDays: z.coerce.number().int().min(7).max(365).optional().default(90)
  }).parse(req.body || {});
  const distillation = await createSalesDistillation(getStore(), req.user!, body.sourceUserId, body.periodDays);
  res.status(201).json({ distillation });
}));

app.post("/api/agent/sales-distillation/:id/publish", requireAuth, asyncRoute(async (req, res) => {
  try {
    const distillation = await publishSalesDistillation(getStore(), req.user!, req.params.id);
    res.json({ distillation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "发布蒸馏打法失败";
    res.status(/无权|需要主管|不存在/u.test(message) ? 403 : 400).json({ message });
  }
}));

app.post("/api/agent/sales-distillation/:id/activate", requireAuth, asyncRoute(async (req, res) => {
  const activation = await activateSalesPlaybook(getStore(), req.user!, req.params.id);
  res.json({ activation, activations: listSalesPlaybookActivations(getStore(), req.user!) });
}));

app.post("/api/agent/sales-distillation/activations/:id/pause", requireAuth, asyncRoute(async (req, res) => {
  const activation = await pauseSalesPlaybook(getStore(), req.user!, req.params.id);
  res.json({ activation, activations: listSalesPlaybookActivations(getStore(), req.user!) });
}));

const agentPlanRequestSchema = z.object({
  goal: z.string().trim().min(2).max(2_000),
  context: z.record(z.unknown()).optional().default({})
});

async function resolveAgentPlanRequest(
  user: NonNullable<Request["user"]>,
  body: z.infer<typeof agentPlanRequestSchema>,
  onProgress?: AgentPlanningProgressHandler
) {
  const conversationId = typeof body.context.conversationId === "string" ? body.context.conversationId : "";
  const conversationRuns = conversationId ? listAgentRuns(getStore(), user, 20, conversationId) : [];
  const missionSnapshots = agentMissionContextSnapshots(conversationRuns);
  const turnDecision = await resolveAgentTurnDecision(getStore(), user, body.goal, missionSnapshots);
  const relatedMission = turnDecision.missionId
    ? conversationRuns.find((item) => item.id === turnDecision.missionId)
    : missionSnapshots[0]
      ? conversationRuns.find((item) => item.id === missionSnapshots[0]!.id)
      : undefined;
  const missionRoute = resolveAgentMissionRoute(turnDecision, relatedMission);
  const context = {
    conversationId: typeof body.context.conversationId === "string" ? body.context.conversationId : undefined,
    activeView: typeof body.context.activeView === "string" ? body.context.activeView : undefined,
    selectedCustomerId: typeof body.context.selectedCustomerId === "string" ? body.context.selectedCustomerId : undefined,
    selectedLeadId: typeof body.context.selectedLeadId === "string" ? body.context.selectedLeadId : undefined,
    selectedCustomerIds: Array.isArray(body.context.selectedCustomerIds)
      ? body.context.selectedCustomerIds.filter((item): item is string => typeof item === "string")
      : undefined,
    turnDecision,
    missionSnapshots
  };
  if (turnDecision.relationToMission !== "independent" && relatedMission) {
    onProgress?.({
      phase: "understanding",
      requestKind: turnDecision.speechAct === "query_data" ? "query" : "execute",
      message: "正在理解这条新指令与当前任务的关系",
      detail: `已识别为 ${turnDecision.relationToMission}，目标任务 ${relatedMission.id}`
    });
    onProgress?.({
      phase: "intent",
      requestKind: "execute",
      message: turnDecision.relationToMission === "answer"
        ? "已确认：这是对当前任务缺失信息的回答"
        : turnDecision.relationToMission === "continue"
          ? "已确认：继续当前任务"
          : turnDecision.relationToMission === "cancel"
            ? "已确认：停止当前任务"
            : "已确认：这是对当前任务的修正",
      detail: `${turnDecision.reason}（置信度 ${Math.round(turnDecision.missionRelationConfidence * 100)}%）`
    });
  }
  if (relatedMission && missionRoute === "cancel") {
    return await cancelAgentMission(getStore(), user, relatedMission.id);
  }
  if (relatedMission && missionRoute === "resume") {
    return await resumeAgentMission(getStore(), user, relatedMission.id, body.goal, turnDecision);
  }
  if (relatedMission && missionRoute === "keep_running") {
    return relatedMission;
  }
  if (relatedMission && missionRoute === "steer") {
    return await steerAgentMission(getStore(), user, relatedMission.id, body.goal, turnDecision);
  }
  return await createAgentPlan(getStore(), user, body.goal, context, onProgress);
}

app.post("/api/agent/plan", requireAuth, asyncRoute(async (req, res) => {
  const body = agentPlanRequestSchema.parse(req.body || {});
  const run = await resolveAgentPlanRequest(req.user!, body);
  void activeAgentBackgroundRunner?.synchronize();
  res.status(201).json({ run, context: body.context });
}));

app.post("/api/agent/plan/stream", requireAuth, asyncRoute(async (req, res) => {
  const body = agentPlanRequestSchema.parse(req.body || {});
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (eventName: string, payload: unknown) => {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    (res as Response & { flush?: () => void }).flush?.();
  };
  try {
    const run = await resolveAgentPlanRequest(req.user!, body, (progress) => send("progress", progress));
    void activeAgentBackgroundRunner?.synchronize();
    send("complete", { run, context: body.context });
  } catch (error) {
    send("error", { message: error instanceof Error ? error.message : "Agent 任务理解失败" });
  } finally {
    res.end();
  }
}));

app.get("/api/agent/runs", requireAuth, (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
  const conversationId = z.string().trim().max(100).catch("").parse(req.query.conversationId);
  res.json({ runs: listAgentRuns(getStore(), req.user!, limit, conversationId) });
});

app.get("/api/agent/conversations", requireAuth, (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).catch(30).parse(req.query.limit);
  res.json({ conversations: listAgentConversations(getStore(), req.user!, limit) });
});

app.get("/api/agent/skills", requireAuth, (req, res) => {
  const query = z.string().trim().max(500).catch("").parse(req.query.query);
  const activeView = z.string().trim().max(80).catch("").parse(req.query.activeView);
  const all = listAgentSkills({ includeInactive: true });
  const matched = query
    ? new Set(selectAgentSkills(query, { activeView, limit: 4 }).map((skill) => skill.id))
    : new Set<string>();
  res.json({
    directory: process.env.AGENT_SKILLS_DIR || "agent-skills",
    skills: all.map((skill) => ({
      ...publicAgentSkill(skill),
      matched: matched.has(skill.id)
    }))
  });
});

app.get("/api/agent/skills/:id", requireAuth, (req, res) => {
  const id = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/u).parse(req.params.id);
  const skill = getAgentSkill(id);
  if (!skill) {
    res.status(404).json({ message: "Skill 不存在" });
    return;
  }
  res.json({ skill: publicAgentSkill(skill, true) });
});

app.post("/api/agent/tuning/inspect", requireAuth, (req, res) => {
  const body = z.object({
    goal: z.string().trim().min(2).max(2_000),
    context: z.object({
      activeView: z.string().trim().max(80).optional(),
      selectedCustomerId: z.string().trim().max(120).optional(),
      selectedDealId: z.string().trim().max(120).optional(),
      selectedLeadId: z.string().trim().max(120).optional()
    }).strict().optional().default({})
  }).parse(req.body || {});
  const goalSpec = compileAgentGoalSpec(body.goal, body.context);
  const skillMatches = rankAgentSkills(body.goal, {
    activeView: body.context.activeView,
    goalSpec,
    limit: 4
  });
  const knowledgeHits = retrieveAgentKnowledge(getStore(), req.user!, body.goal, {
    activeView: body.context.activeView,
    limit: 6,
    trackUsage: false
  });
  const toolRefs = [...new Set(skillMatches.flatMap((item) => item.skill.toolRefs))];
  res.json({
    goalSpec,
    skills: skillMatches.map((item) => ({
      id: item.skill.id,
      name: item.skill.name,
      version: item.skill.version,
      score: Math.round(item.score),
      reasons: item.reasons,
      toolRefs: item.skill.toolRefs
    })),
    knowledge: knowledgeHits.map((item) => ({
      id: item.document.id,
      title: item.document.title,
      module: item.document.module,
      version: item.document.version,
      score: Number(item.score.toFixed(2)),
      reasons: item.reasons
    })),
    toolRefs,
    authorization: goalSpec.authorization
  });
});

app.get("/api/agent/memories", requireAuth, (req, res) => {
  const query = z.object({
    status: z.enum(["proposed", "active", "archived", "all"]).catch("all"),
    type: z.enum(["user_preference", "company_knowledge", "customer_memory", "team_playbook", "all"]).catch("all"),
    subjectId: z.string().trim().max(120).catch(""),
    query: z.string().trim().max(200).catch("")
  }).parse(req.query);
  res.json({ memories: listAgentMemories(getStore(), req.user!, query) });
});

app.post("/api/agent/memories", requireAuth, asyncRoute(async (req, res) => {
  const memory = await proposeAgentMemory(getStore(), req.user!, req.body || {});
  res.status(201).json({ memory });
}));

app.patch("/api/agent/memories/:id", requireAuth, asyncRoute(async (req, res) => {
  const memory = await updateAgentMemory(getStore(), req.user!, req.params.id, req.body || {});
  res.json({ memory });
}));

app.post("/api/agent/memories/:id/activate", requireAuth, asyncRoute(async (req, res) => {
  const memory = await setAgentMemoryStatus(getStore(), req.user!, req.params.id, "active");
  res.json({ memory });
}));

app.post("/api/agent/memories/:id/archive", requireAuth, asyncRoute(async (req, res) => {
  const memory = await setAgentMemoryStatus(getStore(), req.user!, req.params.id, "archived");
  res.json({ memory });
}));

app.delete("/api/agent/memories/:id", requireAuth, asyncRoute(async (req, res) => {
  const memory = await deleteAgentMemory(getStore(), req.user!, req.params.id);
  res.json({ deleted: memory.id });
}));

app.get("/api/agent/knowledge/overview", requireAuth, (req, res) => {
  res.json(agentKnowledgeOverview(getStore(), req.user!));
});

app.get("/api/agent/knowledge/documents", requireAuth, (req, res) => {
  const query = z.object({
    status: z.enum(["draft", "review", "published", "archived", "all"]).catch("all"),
    kind: z.enum(["system", "module", "workflow", "policy", "field", "playbook", "failure_case", "all"]).catch("all"),
    module: z.string().trim().max(80).catch(""),
    query: z.string().trim().max(200).catch("")
  }).parse(req.query);
  const actor = req.user!;
  const documents = listAgentKnowledgeDocuments(getStore(), actor, query).map((document) => ({
    ...document,
    canEdit: document.sourceType !== "system_file"
      && (actor.role === "super_admin" || (document.teamId === actor.teamId && (document.ownerId === actor.id || ["manager", "admin"].includes(actor.role))))
  }));
  res.json({ documents });
});

app.get("/api/agent/knowledge/search", requireAuth, (req, res) => {
  const query = z.object({
    query: z.string().trim().min(1).max(500),
    activeView: z.string().trim().max(80).catch(""),
    limit: z.coerce.number().int().min(1).max(12).catch(8)
  }).parse(req.query);
  const hits = retrieveAgentKnowledge(getStore(), req.user!, query.query, {
    activeView: query.activeView,
    limit: query.limit,
    trackUsage: false
  });
  res.json({ hits: hits.map((hit) => ({ document: hit.document, score: hit.score, reasons: hit.reasons })) });
});

app.post("/api/agent/knowledge/documents", requireAuth, asyncRoute(async (req, res) => {
  const document = await createAgentKnowledgeDraft(getStore(), req.user!, req.body || {});
  res.status(201).json({ document });
}));

app.patch("/api/agent/knowledge/documents/:id", requireAuth, asyncRoute(async (req, res) => {
  const document = await updateAgentKnowledgeDraft(getStore(), req.user!, req.params.id, req.body || {});
  res.json({ document });
}));

app.post("/api/agent/knowledge/documents/:id/:action", requireAuth, asyncRoute(async (req, res) => {
  const action = z.enum(["submit", "publish", "archive"]).parse(req.params.action);
  const document = await setAgentKnowledgeStatus(getStore(), req.user!, req.params.id, action);
  res.json({ document });
}));

app.get("/api/agent/triggers", requireAuth, (req, res) => {
  const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(req.query.limit);
  res.json({ rules: listAgentTriggerRules(getStore(), req.user!), events: listAgentTriggerEvents(getStore(), req.user!, limit) });
});

app.post("/api/agent/triggers", requireAuth, asyncRoute(async (req, res) => {
  const rule = await createAgentTriggerRule(getStore(), req.user!, req.body || {});
  void activeAgentTriggerRunner?.synchronize();
  res.status(201).json({ rule });
}));

app.patch("/api/agent/triggers/:id", requireAuth, asyncRoute(async (req, res) => {
  const rule = await updateAgentTriggerRule(getStore(), req.user!, req.params.id, req.body || {});
  res.json({ rule });
}));

app.post("/api/agent/triggers/:id/:action", requireAuth, asyncRoute(async (req, res) => {
  const action = z.enum(["pause", "resume", "run"]).parse(req.params.action);
  const store = getStore();
  const rule = listAgentTriggerRules(store, req.user!).find((item) => item.id === req.params.id);
  if (!rule) throw new Error("自动触发规则不存在或无权访问");
  if (action === "run") {
    const result = await runAgentTriggerRule(store, req.user!, rule, (actor, goal, context) => createAgentPlan(store, actor, goal, context));
    void activeAgentBackgroundRunner?.synchronize();
    res.json({ result, rules: listAgentTriggerRules(store, req.user!), events: listAgentTriggerEvents(store, req.user!, 50) });
    return;
  }
  const updated = await setAgentTriggerRuleStatus(store, req.user!, rule.id, action === "pause" ? "paused" : "active");
  if (action === "resume") void activeAgentTriggerRunner?.synchronize();
  res.json({ rule: updated });
}));

app.delete("/api/agent/triggers/:id", requireAuth, asyncRoute(async (req, res) => {
  const rule = await deleteAgentTriggerRule(getStore(), req.user!, req.params.id);
  res.json({ deleted: rule.id });
}));

app.get("/api/agent/governance", requireAuth, (req, res) => {
  res.json(agentModelMetrics(getStore(), req.user!));
});

app.post("/api/agent/evaluations/run", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const evaluation = await runAgentEvaluationSuite(store, req.user!, (goal, context) => createAgentPlan(store, req.user!, goal, context));
  res.json({ evaluation, metrics: agentModelMetrics(store, req.user!) });
}));

app.post("/api/agent/missions/:id/resume", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ message: z.string().trim().max(2_000).default("继续执行，保持原目标和完成标准") }).parse(req.body || {});
  const run = await resumeAgentMission(getStore(), req.user!, req.params.id, body.message);
  void activeAgentBackgroundRunner?.synchronize();
  res.json({ run });
}));

app.post("/api/agent/missions/:id/steer", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ message: z.string().trim().min(2).max(2_000) }).parse(req.body || {});
  const run = await steerAgentMission(getStore(), req.user!, req.params.id, body.message);
  void activeAgentBackgroundRunner?.synchronize();
  res.json({ run });
}));

app.get("/api/agent/missions/:id/checkpoints", requireAuth, (req, res) => {
  const limit = z.coerce.number().int().min(1).max(80).catch(30).parse(req.query.limit);
  res.json({ checkpoints: listAgentMissionCheckpoints(getStore(), req.user!, req.params.id, limit) });
});

app.post("/api/agent/missions/:id/checkpoints/:checkpointId/restore", requireAuth, asyncRoute(async (req, res) => {
  const run = await restoreAgentMissionCheckpoint(getStore(), req.user!, req.params.id, req.params.checkpointId);
  void activeAgentBackgroundRunner?.synchronize();
  res.json({ run, checkpoints: listAgentMissionCheckpoints(getStore(), req.user!, req.params.id, 30) });
}));

app.post("/api/agent/missions/:id/pause", requireAuth, asyncRoute(async (req, res) => {
  const run = await pauseAgentMission(getStore(), req.user!, req.params.id);
  res.json({ run });
}));

app.post("/api/agent/missions/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
  const run = await cancelAgentMission(getStore(), req.user!, req.params.id);
  res.json({ run });
}));

app.get("/api/agent/runs/:id", requireAuth, (req, res) => {
  try {
    res.json({ run: getAgentRun(getStore(), req.params.id, req.user!) });
  } catch (error) {
    res.status(404).json({ message: error instanceof Error ? error.message : "Agent 运行不存在" });
  }
});

app.post("/api/agent/execute", requireAuth, async (req, res, next) => {
  try {
    const body = z.object({
      runId: z.string().min(1).max(100),
      stepId: z.string().min(1).max(100),
      signature: z.string().min(1).max(200),
      approved: z.boolean().default(false)
    }).parse(req.body || {});
    const run = await executeAgentStep(
      getStore(),
      req.user!,
      body.runId,
      body.stepId,
      body.signature,
      body.approved,
      agentExecutionRuntime
    );
    void activeAgentBackgroundRunner?.synchronize();
    res.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent 动作执行失败";
    if (/Agent (运行不存在|运行已过期|步骤不存在|步骤签名无效|步骤已被新指令替代)|需要确认|Mission 已停止/u.test(message)) {
      res.status(400).json({ message });
      return;
    }
    next(error);
  }
});

app.get("/api/tools/ai-config", requireAuth, (req, res) => {
  const configs = getAiConfigs(req.user!);
  const config = getAiConfig(req.user!);
  res.json({ config: config ? publicAiConfig(config) : null, configs: configs.map(publicAiConfig) });
});

app.post("/api/tools/ai-config", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    id: z.string().min(1).max(64).optional(),
    provider: z.string().min(1).max(40).default("openai"),
    protocol: z.enum(["openai-compatible", "anthropic", "gemini"]).default("openai-compatible"),
    name: z.string().min(1).default("AI业务模型配置"),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKey: z.string().optional().default(""),
    enabled: z.boolean().default(false),
    temperature: z.number().min(0).max(2).default(0.1),
    useLeadFinder: z.boolean().default(true),
    useWebsiteParse: z.boolean().default(true),
    useScoring: z.boolean().default(true),
    useEmailDraft: z.boolean().default(true),
    useExam: z.boolean().default(false)
  });
  const body = schema.parse(req.body);
  let baseUrl = "";
  try {
    baseUrl = assertAiBaseUrlAllowed(body.baseUrl);
  } catch {
    res.status(400).json({ message: "AI Base URL 必须是公网 HTTPS 标准端口地址，且不能包含账号、查询参数或片段" });
    return;
  }
  const store = getStore();
  const existing = body.id ? store.aiModelConfigs.find((item) => item.id === body.id && item.ownerId === req.user!.id) : undefined;
  const apiKey = body.apiKey && !body.apiKey.includes("****") ? body.apiKey : existing?.apiKey || "";
  if (body.enabled && !apiKey) {
    res.status(400).json({ message: "启用配置前必须填写 API Key" });
    return;
  }
  const config: AiModelConfig = {
    id: existing?.id || body.id || `ai_${req.user!.id}_${Date.now()}`,
    provider: body.provider,
    protocol: body.protocol,
    name: body.name,
    baseUrl,
    model: body.model,
    apiKey,
    enabled: body.enabled,
    temperature: body.temperature,
    useLeadFinder: body.useLeadFinder,
    useWebsiteParse: body.useWebsiteParse,
    useScoring: body.useScoring,
    useEmailDraft: body.useEmailDraft,
    useExam: body.useExam,
    lastTestAt: existing?.lastTestAt,
    lastTestStatus: existing?.lastTestStatus || "untested",
    lastTestMessage: existing?.lastTestMessage || "",
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString()
  };
  if (existing) Object.assign(existing, config);
  else store.aiModelConfigs.unshift(config);
  await store.persist();
  res.json({ config: publicAiConfig(config), configs: getAiConfigs(req.user!).map(publicAiConfig) });
}));

app.delete("/api/tools/ai-config/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.aiModelConfigs.findIndex((item) => item.id === req.params.id && item.ownerId === req.user!.id);
  if (index < 0) {
    res.status(404).json({ message: "配置不存在或无权删除" });
    return;
  }
  store.aiModelConfigs.splice(index, 1);
  await store.persist();
  const config = getAiConfig(req.user!);
  res.json({ config: config ? publicAiConfig(config) : null, configs: getAiConfigs(req.user!).map(publicAiConfig) });
}));

app.post("/api/tools/ai-config/test", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ id: z.string().min(1).max(64).optional() });
  const body = schema.parse(req.body || {});
  const config = body.id
    ? getStore().aiModelConfigs.find((item) => item.id === body.id && item.ownerId === req.user!.id) || null
    : getAiConfig(req.user!);
  if (!config || !config.baseUrl || !config.model) {
    res.status(400).json({ message: "请先保存模型地址和模型名称" });
    return;
  }
  if (!config.apiKey) {
    res.status(400).json({ message: "请先填写 API Key；系统不会在页面明文回显密钥" });
    return;
  }
  const result = await testAiConfig(config);
  config.lastTestAt = new Date().toISOString();
  config.lastTestStatus = result.ok ? "passed" : "failed";
  config.lastTestMessage = result.message;
  config.updatedAt = new Date().toISOString();
  await getStore().persist();
  res.json({ ok: result.ok, message: result.message, config: publicAiConfig(config), configs: getAiConfigs(req.user!).map(publicAiConfig) });
}));

const leadFinderSearchSchema = z.object({
  productKeywords: z.string().default(""),
  countries: z.string().default(""),
  industry: z.string().default(""),
  customerType: z.string().default(""),
  goal: z.string().default(""),
  limit: z.number().min(1).max(30).default(10)
});

app.post("/api/lead-finder/free-search", requireAuth, asyncRoute(async (req, res) => {
  const body = leadFinderSearchSchema.parse(req.body);
  const store = getStore();
  const user = req.user!;
  const limit = Math.min(body.limit, 12);
  const runId = `prun_free_${randomUUID()}`;
  const query: LeadQuery = {
    ...body,
    excludeKeywords: "",
    limit: Math.ceil(limit / 2)
  };
  const providerIds = [
    "gleif",
    "wikidata",
    "eu_ted",
    "world_bank_procurement",
    "uk_contracts_finder"
  ];
  const sourceStats: Array<{
    id: string;
    name: string;
    count: number;
    status: string;
    error?: string;
    errorCode?: string;
    retryable?: boolean;
    retryAfterAt?: string | null;
  }> = [];
  const pages = await Promise.all(providerIds.map(async (providerId) => {
    const provider = getProvider(providerId);
    const catalog = providerCatalogByCode(providerId);
    if (!provider || !catalog) {
      recordProviderPreflightFailure(user, runId, providerId, "PROVIDER_CATALOG_MISSING", "free_search");
      sourceStats.push({
        id: providerId,
        name: provider?.name || providerId,
        count: 0,
        status: "failed",
        error: "数据源目录缺失",
        errorCode: "PROVIDER_CATALOG_MISSING",
        retryable: false,
        retryAfterAt: null
      });
      return { providerId, records: [] as ProviderRecord[] };
    }
    try {
      const page = await executeProviderSearch({
        provider,
        catalog,
        context: createProviderExecutionContext({
          teamId: user.teamId,
          ownerId: user.id,
          runId,
          providerId,
          operation: "search",
          purpose: "legacy_free_search"
        }),
        credential: { apiKey: "", baseUrl: "" },
        query,
        onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
      });
      sourceStats.push({
        id: providerId,
        name: catalog.name || provider.name,
        count: page.records.length,
        status: page.status
      });
      return { providerId, records: page.records };
    } catch (error) {
      const failure = providerErrorFromUnknown(error, "search");
      sourceStats.push({
        id: providerId,
        name: catalog.name || provider.name,
        count: 0,
        status: "failed",
        error: failure.publicMessage,
        errorCode: failure.code,
        retryable: failure.retryable,
        retryAfterAt: failure.retryAfterAt
      });
      return { providerId, records: [] as ProviderRecord[] };
    }
  }));
  const mergedRecords: Array<ProviderRecord & { source: string; sourceEvidence: ProviderEvidenceSnapshot[] }> = [];
  const mergedByKey = new Map<string, (typeof mergedRecords)[number]>();
  for (const page of pages) {
    for (const record of page.records) {
      const domain = websiteDomainKey(record.officialWebsite || record.website || "");
      const strongKey = record.providerRecordId
        ? `${page.providerId}:id:${record.providerRecordId}`
        : record.payloadHash
          ? `${page.providerId}:hash:${record.payloadHash}`
          : "";
      const domainKey = domain ? `domain:${domain}` : "";
      const existing = [strongKey, domainKey]
        .filter(Boolean)
        .map((key) => mergedByKey.get(key))
        .find(Boolean);
      const evidence = providerEvidenceSnapshot(page.providerId, record);
      if (existing) {
        existing.sourceEvidence = mergeProviderEvidence(existing.sourceEvidence, [evidence]);
        if (!existing.officialWebsite && record.officialWebsite) {
          existing.officialWebsite = record.officialWebsite;
          existing.website = record.officialWebsite;
        }
        if (!existing.contactInfo && record.contactInfo) existing.contactInfo = record.contactInfo;
        if ((!existing.contact || existing.contact === "待维护") && record.contact) existing.contact = record.contact;
        existing.confidence = Math.max(existing.confidence || 0, record.confidence || 0);
        if (strongKey) mergedByKey.set(strongKey, existing);
        if (domainKey) mergedByKey.set(domainKey, existing);
        continue;
      }
      const mergedRecord = {
        ...record,
        source: page.providerId,
        sourceEvidence: [evidence]
      };
      mergedRecords.push(mergedRecord);
      if (strongKey) mergedByKey.set(strongKey, mergedRecord);
      if (domainKey) mergedByKey.set(domainKey, mergedRecord);
    }
  }
  const merged: WebsiteOpportunity[] = mergedRecords.slice(0, limit).map((record) =>
    withProspectVerificationReport({
      id: `lf_${record.source}_${randomUUID()}`,
      company: record.company,
      business: record.business || "待维护",
      country: record.country || "未知",
      website: normalizeWebsite(record.officialWebsite || record.website || ""),
      contact: record.contact || "待维护",
      contactInfo: record.contactInfo || "",
      description: record.description || record.evidenceSummary || "公开来源候选，待核实。",
      ownerId: user.id,
      teamId: user.teamId,
      status: "preview",
      createdAt: new Date().toISOString(),
      parseMode: "rule",
      source: record.source,
      sourceLabel: getProvider(record.source)?.name || record.source,
      sourceEvidence: record.sourceEvidence,
      confidence: record.confidence
    })
  );
  await store.reloadProspectCandidates?.();
  const persistence = persistProviderOpportunities(merged, {
    rawCount: pages.reduce((sum, page) => sum + page.records.length, 0),
    deduplicatedCount: Math.max(0, pages.reduce((sum, page) => sum + page.records.length, 0) - mergedRecords.length)
  });
  await persistCandidateChanges(
    store,
    persistence.opportunities,
    true
  );
  res.json({
    opportunities: persistence.opportunities,
    sources: Object.fromEntries(sourceStats.map((item) => [item.id, item.count])),
    sourceStats,
    incrementalStats: persistence.incrementalStats,
    runId
  });
}));

// ---------------------------------------------------------------------------
// 自动获客 · 数据源中心（Provider 注册表 + 用户 Key 配置 + 统一搜索）
// ---------------------------------------------------------------------------

function getProviderConnection(user: SessionUser, providerId: string): ProviderConnection | undefined {
  return getStore().providerConnections.find((item) =>
    item.providerId === providerId
    && item.ownerId === user.id
    && item.teamId === user.teamId
    && item.scope === "personal"
  );
}

function providerEvidenceSnapshot(providerId: string, record: ProviderRecord): ProviderEvidenceSnapshot {
  const catalog = providerCatalogByCode(providerId);
  return {
    providerId,
    providerRecordId: record.providerRecordId,
    officialWebsite: record.officialWebsite,
    sourceUrl: record.sourceUrl,
    recordType: record.recordType,
    fetchedAt: record.fetchedAt,
    payloadHash: record.payloadHash,
    evidenceSummary: record.evidenceSummary,
    matchedFields: [...record.matchedFields],
    adapterVersion: record.adapterVersion,
    catalogPolicyVersion: record.catalogPolicyVersion,
    sourceLevel: record.sourceLevel,
    fieldAuthority: Object.fromEntries(
      [...new Set([
        ...record.matchedFields,
        ...(record.providerRecordId ? ["providerRecordId"] : []),
        ...(record.officialWebsite ? ["officialWebsite"] : [])
      ])].map((field) => [
        field,
        catalog?.fieldAuthority?.[field] || "discovery"
      ])
    ),
    retentionPolicyRef: record.retentionPolicyRef
  };
}

function mergeProviderEvidence(
  current: ProviderEvidenceSnapshot[] = [],
  incoming: ProviderEvidenceSnapshot[] = []
) {
  const merged = new Map<string, ProviderEvidenceSnapshot>();
  for (const evidence of [...current, ...incoming]) {
    const key = `${evidence.providerId}:${evidence.providerRecordId || evidence.payloadHash}:${evidence.payloadHash}`;
    merged.set(key, evidence);
  }
  return [...merged.values()];
}

function providerEvidenceRecordKeys(evidence: ProviderEvidenceSnapshot[] = []) {
  return new Set(evidence
    .filter((item) => item.providerId && item.providerRecordId)
    .map((item) => `${item.providerId}:${item.providerRecordId}`));
}

const providerCountryAliases: Record<string, string> = {
  at: "AT",
  austria: "AT",
  奥地利: "AT",
  au: "AU",
  australia: "AU",
  澳大利亚: "AU",
  be: "BE",
  belgium: "BE",
  比利时: "BE",
  br: "BR",
  brazil: "BR",
  巴西: "BR",
  ca: "CA",
  canada: "CA",
  加拿大: "CA",
  ch: "CH",
  switzerland: "CH",
  瑞士: "CH",
  cn: "CN",
  china: "CN",
  中国: "CN",
  de: "DE",
  germany: "DE",
  deutschland: "DE",
  德国: "DE",
  es: "ES",
  spain: "ES",
  西班牙: "ES",
  fr: "FR",
  france: "FR",
  法国: "FR",
  gb: "GB",
  uk: "GB",
  unitedkingdom: "GB",
  greatbritain: "GB",
  英国: "GB",
  id: "ID",
  indonesia: "ID",
  印度尼西亚: "ID",
  in: "IN",
  india: "IN",
  印度: "IN",
  it: "IT",
  italy: "IT",
  意大利: "IT",
  jp: "JP",
  japan: "JP",
  日本: "JP",
  kr: "KR",
  southkorea: "KR",
  korea: "KR",
  韩国: "KR",
  mx: "MX",
  mexico: "MX",
  墨西哥: "MX",
  my: "MY",
  malaysia: "MY",
  马来西亚: "MY",
  nl: "NL",
  netherlands: "NL",
  holland: "NL",
  荷兰: "NL",
  pl: "PL",
  poland: "PL",
  波兰: "PL",
  ru: "RU",
  russia: "RU",
  俄罗斯: "RU",
  sg: "SG",
  singapore: "SG",
  新加坡: "SG",
  tr: "TR",
  turkey: "TR",
  türkiye: "TR",
  土耳其: "TR",
  tw: "TW",
  taiwan: "TW",
  中国台湾: "TW",
  us: "US",
  usa: "US",
  unitedstates: "US",
  unitedstatesofamerica: "US",
  美国: "US",
  vn: "VN",
  vietnam: "VN",
  越南: "VN"
};

function normalizeProviderCountry(country: string) {
  const normalized = country
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[.\s_()-]+/g, "");
  if (!normalized || ["unknown", "未知", "待维护", "n/a", "na"].includes(normalized)) return "";
  return providerCountryAliases[normalized] || normalized;
}

function isSameProviderOpportunity(existing: WebsiteOpportunity, incoming: WebsiteOpportunity) {
  if (existing.ownerId !== incoming.ownerId || existing.teamId !== incoming.teamId) return false;
  const incomingRecordKeys = providerEvidenceRecordKeys(incoming.sourceEvidence);
  if (incomingRecordKeys.size > 0
    && [...providerEvidenceRecordKeys(existing.sourceEvidence)].some((key) => incomingRecordKeys.has(key))) {
    return true;
  }
  const existingDomain = websiteDomainKey(existing.website);
  const incomingDomain = websiteDomainKey(incoming.website);
  const existingCountry = normalizeProviderCountry(existing.country);
  const incomingCountry = normalizeProviderCountry(incoming.country);
  return Boolean(
    existingDomain
    && incomingDomain
    && existingDomain === incomingDomain
    && existingCountry
    && incomingCountry
    && existingCountry === incomingCountry
  );
}

function recordProviderPreflightFailure(
  user: SessionUser,
  runId: string,
  providerId: string,
  errorCode: ProviderErrorCode,
  endpointCode: string
) {
  const requestedAt = new Date().toISOString();
  const normalizedProviderId = providerId.trim().slice(0, 64) || "unknown";
  getStore().providerRequestLogs.unshift({
    id: `prl_${randomUUID()}`,
    teamId: user.teamId,
    ownerId: user.id,
    providerId: normalizedProviderId,
    connectionId: "",
    runId,
    runShardId: `${runId}_${normalizedProviderId}`,
    requestFingerprint: providerRequestFingerprint({ providerId: normalizedProviderId, endpointCode, errorCode }),
    endpointCode,
    httpStatus: 0,
    attempt: 1,
    quotaUnits: 0,
    costAmount: 0,
    currency: "",
    durationMs: 0,
    responseSize: 0,
    errorCode: errorCode.toLocaleLowerCase(),
    requestedAt
  });
}

function hasManualProspectState(opportunity: WebsiteOpportunity) {
  return Boolean(
    opportunity.statusChangedAt
    || opportunity.verifiedAt
    || opportunity.status !== "preview"
    || opportunity.customerId
    || opportunity.dealId
    || opportunity.leadId
  );
}

interface LeadFinderIncrementalStats {
  rawCount: number;
  returnedCount: number;
  deduplicatedCount: number;
  newCount: number;
  evidenceUpdatedCount: number;
  multiSourceMergedCount: number;
  unchangedCount: number;
  excludedCount: number;
}

function providerEvidenceKeys(evidence: ProviderEvidenceSnapshot[] = []) {
  return new Set(evidence.map((item) =>
    `${item.providerId}:${item.providerRecordId || item.payloadHash}:${item.payloadHash}`
  ));
}

function providerEvidenceSources(evidence: ProviderEvidenceSnapshot[] = []) {
  return new Set(evidence.map((item) => item.providerId).filter(Boolean));
}

function providerOpportunityDetailsChanged(
  existing: WebsiteOpportunity,
  incoming: WebsiteOpportunity
) {
  return [
    "company",
    "business",
    "country",
    "website",
    "contact",
    "contactInfo",
    "description"
  ].some((key) =>
    String(existing[key as keyof WebsiteOpportunity] || "").trim()
      !== String(incoming[key as keyof WebsiteOpportunity] || "").trim()
  );
}

function persistProviderOpportunities(
  opportunities: WebsiteOpportunity[],
  inputStats: Pick<LeadFinderIncrementalStats, "rawCount" | "deduplicatedCount">
) {
  const store = getStore();
  const incrementalStats: LeadFinderIncrementalStats = {
    ...inputStats,
    returnedCount: opportunities.length,
    newCount: 0,
    evidenceUpdatedCount: 0,
    multiSourceMergedCount: 0,
    unchangedCount: 0,
    excludedCount: 0
  };
  const persistedOpportunities = opportunities.map((item) => {
    withProspectVerificationReport(item);
    const existing = store.websiteOpportunities.find((row) => isSameProviderOpportunity(row, item));
    if (!existing) {
      store.websiteOpportunities.unshift(item);
      incrementalStats.newCount += 1;
      if (providerEvidenceSources(item.sourceEvidence).size > 1) {
        incrementalStats.multiSourceMergedCount += 1;
      }
      return item;
    }
    if (existing.status === "excluded") {
      incrementalStats.excludedCount += 1;
    }
    const existingEvidenceKeys = providerEvidenceKeys(existing.sourceEvidence);
    const existingEvidenceSources = providerEvidenceSources(existing.sourceEvidence);
    const sourceEvidence = mergeProviderEvidence(existing.sourceEvidence, item.sourceEvidence);
    const mergedEvidenceKeys = providerEvidenceKeys(sourceEvidence);
    const mergedEvidenceSources = providerEvidenceSources(sourceEvidence);
    const evidenceUpdated = mergedEvidenceKeys.size > existingEvidenceKeys.size;
    const detailsUpdated = providerOpportunityDetailsChanged(existing, item);
    if (evidenceUpdated) incrementalStats.evidenceUpdatedCount += 1;
    else if (existing.status !== "excluded") incrementalStats.unchangedCount += 1;
    if (mergedEvidenceSources.size > existingEvidenceSources.size) {
      incrementalStats.multiSourceMergedCount += 1;
    }
    const confidence = Math.max(existing.confidence || 0, item.confidence || 0);
    const manualState = hasManualProspectState(existing);
    const reportNeedsRefresh = evidenceUpdated
      || (!manualState && detailsUpdated)
      || !existing.verificationReport;
    const existingVerificationReport = existing.verificationReport;
    if (existing.customerId && (evidenceUpdated || detailsUpdated)) {
      const customer = store.customers.find((row) =>
        row.id === existing.customerId
        && row.teamId === existing.teamId
        && row.ownerId === existing.ownerId
      );
      if (customer) {
        generateCustomerIntelligenceSuggestion(store, {
          customer,
          candidate: {
            ...existing,
            ...item,
            id: existing.id,
            teamId: existing.teamId,
            ownerId: existing.ownerId,
            customerId: existing.customerId,
            leadId: existing.leadId,
            dealId: existing.dealId,
            tenantProspectId:
              existing.tenantProspectId || item.tenantProspectId,
            organizationId:
              existing.organizationId || item.organizationId,
            sourceEvidence
          },
          sourceEventId: sourceEvidence.at(-1)?.payloadHash,
          observedAt: new Date().toISOString()
        });
      }
    }
    if (manualState) {
      existing.sourceEvidence = sourceEvidence;
      existing.confidence = confidence;
      if (reportNeedsRefresh) withProspectVerificationReport(existing);
      return existing;
    }
    Object.assign(existing, item, {
      id: existing.id,
      status: existing.status,
      customerId: existing.customerId,
      dealId: existing.dealId,
      leadId: existing.leadId,
      createdAt: existing.createdAt,
      sourceEvidence,
      confidence,
      verificationReport: existingVerificationReport
    });
    if (reportNeedsRefresh) withProspectVerificationReport(existing);
    return existing;
  });
  return { opportunities: persistedOpportunities, incrementalStats };
}

function readProviderConnectionConfiguration(connection?: ProviderConnection) {
  if (!connection) {
    return {
      configuration: { apiKey: "", baseUrl: "" },
      readable: true
    };
  }
  try {
    return {
      configuration: decryptProviderConfiguration(connection, connection.configurationEncrypted),
      readable: true
    };
  } catch {
    return {
      configuration: { apiKey: "", baseUrl: "" },
      readable: false
    };
  }
}

function providerConnectionConfiguration(connection?: ProviderConnection) {
  return readProviderConnectionConfiguration(connection).configuration;
}

function publicLeadSourceConfig(connection: ProviderConnection) {
  const connectionRead = readProviderConnectionConfiguration(connection);
  const configuration = connectionRead.configuration;
  return {
    id: connection.id,
    provider: connection.providerId,
    scope: connection.scope,
    apiKey: configuration.apiKey ? `****${configuration.apiKey.slice(-4)}` : "",
    hasApiKey: Boolean(configuration.apiKey),
    baseUrl: configuration.baseUrl,
    enabled: connection.status === "active" && connectionRead.readable,
    lastTestAt: connection.lastHealthAt,
    lastTestStatus: connectionRead.readable ? connection.lastHealthStatus : "failed",
    lastTestMessage: connectionRead.readable ? connection.lastHealthMessage : "连接凭据不可读取，请重新保存",
    usage: connection.usage,
    updatedAt: connection.updatedAt
  };
}

function publicProviderCatalogItem(item: ProviderCatalogItem) {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    category: item.category,
    sourceLevel: item.sourceLevel,
    accessMode: item.accessMode,
    baseUrl: item.baseUrl,
    officialDocsUrl: item.officialDocsUrl,
    capabilities: item.capabilities,
    allowedFields: item.allowedFields,
    fieldAuthority: item.fieldAuthority || {},
    licensePolicy: item.licensePolicy,
    defaultRatePolicy: item.defaultRatePolicy,
    retentionPolicy: item.retentionPolicy,
    status: item.status,
    version: item.version,
    reviewedAt: item.reviewedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function providerCatalogByCode(code: string) {
  return getStore().providerCatalog.find((item) => item.code === code);
}

function catalogProviderMeta(provider: LeadProvider) {
  const catalog = providerCatalogByCode(provider.id);
  const licensePolicy = catalog?.licensePolicy || {};
  return {
    ...providerMeta(provider),
    name: catalog?.name || provider.name,
    category: catalog?.category || provider.category,
    capabilities: catalog?.capabilities || provider.capabilities,
    docsUrl: catalog?.officialDocsUrl || provider.docsUrl,
    defaultBaseUrl: catalog?.baseUrl || provider.defaultBaseUrl || "",
    accessMode: catalog?.accessMode || provider.accessMode,
    tier: licensePolicy.tier === "free" || licensePolicy.tier === "byok_free" || licensePolicy.tier === "paid"
      ? licensePolicy.tier
      : provider.tier,
    requiresKey: providerRequiresKey(provider, catalog),
    keyHint: typeof licensePolicy.keyHint === "string" ? licensePolicy.keyHint : provider.keyHint,
    costNote: typeof licensePolicy.costNote === "string" ? licensePolicy.costNote : provider.costNote
  };
}

function providerStatusFor(user: SessionUser, provider: LeadProvider) {
  const connection = getProviderConnection(user, provider.id);
  const connectionRead = readProviderConnectionConfiguration(connection);
  const configuration = connectionRead.configuration;
  const meta = catalogProviderMeta(provider);
  const catalogEnabled = providerCatalogByCode(provider.id)?.status === "active";
  const automated = meta.accessMode === "api";
  const hasKey = !meta.requiresKey || Boolean(configuration.apiKey);
  const connectionEnabled = !automated
    ? true
    : meta.requiresKey
    ? Boolean(connectionRead.readable && connection?.status === "active" && configuration.apiKey)
    : connection ? connectionRead.readable && connection.status === "active" : true;
  return {
    ...meta,
    hasApiKey: Boolean(configuration.apiKey),
    ready: automated ? hasKey : true,
    enabled: catalogEnabled && connectionEnabled,
    lastTestStatus: connection && !connectionRead.readable
      ? "failed"
      : connection?.lastHealthStatus || (!automated || !meta.requiresKey ? "passed" : "untested"),
    lastTestMessage: connection && !connectionRead.readable
      ? "连接凭据不可读取，请重新保存"
      : connection?.lastHealthMessage || (!automated ? "请使用官方入口核实后返回解析结果链接" : ""),
    lastTestAt: connection?.lastHealthAt || "",
    usage: connection?.usage || ""
  };
}

// AI 搜索作为一种数据源：不需要独立 API Key，直接复用「AI 模型配置」里已启用且勾选自动获客的模型
function aiSearchStatus(user: SessionUser) {
  const configured = getAiConfigs(user).find((item) =>
    item.enabled && Boolean(item.apiKey)
  );
  const config = getAiConfig(user, "leadFinder");
  const ready = Boolean(config?.enabled && config?.apiKey && config?.useLeadFinder);
  const catalog = providerCatalogByCode("ai_search");
  const enabled = ready && catalog?.status === "active";
  const licensePolicy = catalog?.licensePolicy || {};
  return {
    id: "ai_search",
    name: catalog?.name || "AI 搜索",
    tier: "ai" as const,
    category: (catalog?.category || "ai") as "ai",
    accessMode: "api" as const,
    recommended: false,
    requiresKey: false,
    capabilities: catalog?.capabilities || ["ai", "company"],
    docsUrl: catalog?.officialDocsUrl || "",
    keyHint: typeof licensePolicy.keyHint === "string"
      ? licensePolicy.keyHint
      : "使用「AI 模型配置」中已启用并勾选自动获客的模型，无需在此另填 Key。",
    defaultBaseUrl: catalog?.baseUrl || "",
    costNote: typeof licensePolicy.costNote === "string"
      ? licensePolicy.costNote
      : "调用你配置的 AI 模型直接生成候选公司，结果需人工核实。",
    hasApiKey: Boolean(configured),
    ready,
    enabled,
    lastTestStatus: ready ? "passed" : "untested",
    lastTestMessage: ready
      ? `当前模型：${config?.model || "已配置"}`
      : configured
        ? `模型已配置：${configured.model || configured.name}，请启用“自动获客”用途`
        : "请先在「AI 模型配置」保存并启用模型",
    lastTestAt: config?.lastTestAt || "",
    usage: ""
  };
}

function allProviderStatuses(user: SessionUser) {
  return [aiSearchStatus(user), ...LEAD_PROVIDERS.map((provider) => providerStatusFor(user, provider))];
}

function getConfigurableProvider(id: string) {
  return getProvider(id) || getTradeProvider(id);
}

app.get("/api/lead-finder/providers", requireAuth, (req, res) => {
  res.json({ providers: allProviderStatuses(req.user!) });
});

app.get("/api/lead-finder/provider-catalog", requireAuth, (_req, res) => {
  const providers = getStore().providerCatalog
    .filter((item) => item.status !== "disabled")
    .map(publicProviderCatalogItem);
  res.json({ providers });
});

app.get("/api/lead-finder/provider-request-logs", requireAuth, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const providerId = String(req.query.provider || "").trim();
  const runId = String(req.query.runId || "").trim();
  const visible = getStore().providerRequestLogs
    .filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId))
    .filter((item) => !providerId || item.providerId === providerId)
    .filter((item) => !runId || item.runId === runId)
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  res.json({ logs: visible.slice(0, limit), total: visible.length });
});

app.get("/api/prospect-agent-jobs", requireAuth, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const status = String(req.query.status || "").trim();
  const jobType = String(req.query.jobType || "").trim();
  const aggregateId = String(req.query.aggregateId || "").trim();
  const visible = getStore().agentJobs
    .filter((item) => !isProspectRunBridgeJob(item))
    .filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId))
    .filter((item) => !status || item.status === status)
    .filter((item) => !jobType || item.jobType === jobType)
    .filter((item) => !aggregateId || item.aggregateId === aggregateId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  res.json({ jobs: visible.slice(0, limit).map(publicAgentJob), total: visible.length });
});

app.get("/api/prospect-agent-jobs/:id", requireAuth, (req, res) => {
  const job = getStore().agentJobs.find((item) =>
    item.id === req.params.id
    && !isProspectRunBridgeJob(item)
    && canSeeOwner(req.user!, item.ownerId, item.teamId)
  );
  if (!job) {
    res.status(404).json({ message: "任务不存在或无权查看" });
    return;
  }
  const childJobs = getStore().agentJobs
    .filter((item) =>
      item.parentJobId === job.id
      && !isProspectRunBridgeJob(item)
      && canSeeOwner(req.user!, item.ownerId, item.teamId)
    )
    .map(publicAgentJob);
  res.json({ job: publicAgentJob(job), childJobs });
});

app.post("/api/prospect-agent-jobs/:id/retry", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const job = store.agentJobs.find((item) =>
    item.id === req.params.id
    && !isProspectRunBridgeJob(item)
    && (item.jobType === MARKET_ANALYSIS_JOB_TYPE
      ? item.ownerId === req.user!.id && item.teamId === req.user!.teamId
      : canSeeOwner(req.user!, item.ownerId, item.teamId))
  );
  if (!job) {
    res.status(404).json({ message: "任务不存在或无权重试" });
    return;
  }
  if (job.jobType === MARKET_ANALYSIS_JOB_TYPE) {
    try {
      const result = await retryMarketAnalysisJob(store, req.user!, job);
      res.location(`/api/prospect-agent-jobs/${job.id}`);
      res.json(result);
    } catch (error) {
      if (error instanceof MarketAnalysisRunRequestError) {
        res.status(error.status).json({
          message: error.message,
          errorCode: error.code,
          ...marketAnalysisRunMetadata()
        });
        return;
      }
      if (error instanceof MarketAnalysisRunProviderError) {
        res.location(`/api/prospect-agent-jobs/${error.job.id}`);
        res.status(error.status).json({
          message: error.failure.publicMessage,
          errorCode: error.failure.code,
          retryable: error.failure.retryable,
          retryAfterAt: error.failure.retryAfterAt,
          ...marketAnalysisRunMetadata(),
          job: publicAgentJob(error.job)
        });
        return;
      }
      throw error;
    }
    return;
  }
  try {
    retryAgentJob(job);
  } catch (error) {
    res.status(409).json({ message: error instanceof Error ? error.message : "当前任务不能重试" });
    return;
  }
  await store.persist();
  res.json({ job: publicAgentJob(job) });
}));

app.post("/api/prospect-agent-jobs/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const job = store.agentJobs.find((item) =>
    item.id === req.params.id
    && !isProspectRunBridgeJob(item)
    && canSeeOwner(req.user!, item.ownerId, item.teamId)
  );
  if (!job) {
    res.status(404).json({ message: "任务不存在或无权取消" });
    return;
  }
  if (job.jobType === MARKET_ANALYSIS_JOB_TYPE && job.status === "running") {
    res.status(409).json({
      message: "市场分析正在当前请求内同步执行，运行中不能中断",
      errorCode: "INLINE_EXECUTION_NOT_CANCELLABLE",
      ...marketAnalysisRunMetadata(),
      job: publicAgentJob(job)
    });
    return;
  }
  try {
    cancelAgentJob(job);
  } catch (error) {
    res.status(409).json({ message: error instanceof Error ? error.message : "当前任务不能取消" });
    return;
  }
  await store.persist();
  res.json({ job: publicAgentJob(job) });
}));

app.post("/api/prospects/:id/convert-to-lead", requireAuth, asyncRoute(async (req, res) => {
  const body = convertProspectToLeadBodySchema.parse(req.body);
  const idempotencyKey = String(
    req.header("Idempotency-Key") || ""
  ).trim();
  if (!idempotencyKey) {
    res.status(400).json({
      message: "必须提供 Idempotency-Key 请求头",
      errorCode: "IDEMPOTENCY_KEY_REQUIRED"
    });
    return;
  }
  const store = getStore();
  if (!store.convertProspectToLead) {
    res.status(503).json({
      message: "候选转线索服务暂不可用",
      errorCode: "PROSPECT_LEAD_CONVERSION_UNAVAILABLE"
    });
    return;
  }
  try {
    const result = await store.convertProspectToLead({
      ...body,
      teamId: req.user!.teamId,
      ownerId: req.user!.id,
      prospectId: req.params.id,
      idempotencyKey,
      convertedAt: new Date().toISOString()
    });
    await store.reloadProspectCandidates?.();
    const linkedCandidates = store.websiteOpportunities.filter((item) =>
      item.teamId === req.user!.teamId
      && item.ownerId === req.user!.id
      && item.tenantProspectId === req.params.id
    );
    linkedCandidates.forEach((candidate) => {
      migrateProspectFollowUpTodos(store, candidate, result.lead.id)
      linkProcurementContextToLead(store, candidate, result.lead.id);
    });
    if (linkedCandidates.length) {
      await persistCandidateChanges(store, linkedCandidates, true);
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Idempotency-Replayed",
      result.replayed ? "true" : "false"
    );
    res.status(result.replayed ? 200 : 201).json({
      replayed: result.replayed,
      created: result.created,
      lead: result.lead,
      sourceEvent: result.sourceEvent,
      activity: result.activity,
      prospect: result.prospect
    });
  } catch (error) {
    if (sendProspectLeadConversionError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospects/:id/convert-to-customer", requireAuth, asyncRoute(async (req, res) => {
  const body = convertProspectToCustomerBodySchema.parse(req.body);
  const idempotencyKey = String(
    req.header("Idempotency-Key") || ""
  ).trim();
  if (!idempotencyKey) {
    res.status(400).json({
      message: "必须提供 Idempotency-Key 请求头",
      errorCode: "IDEMPOTENCY_KEY_REQUIRED"
    });
    return;
  }
  const store = getStore();
  if (!store.convertProspectToCustomer) {
    res.status(503).json({
      message: "候选转客户服务暂不可用",
      errorCode: "PROSPECT_CUSTOMER_CONVERSION_UNAVAILABLE"
    });
    return;
  }
  try {
    const result = await store.convertProspectToCustomer({
      ...body,
      teamId: req.user!.teamId,
      ownerId: req.user!.id,
      prospectId: req.params.id,
      idempotencyKey,
      convertedAt: new Date().toISOString()
    });
    await store.reloadProspectCandidates?.();
    const linkedCandidates = store.websiteOpportunities.filter((item) =>
      item.teamId === req.user!.teamId
      && item.ownerId === req.user!.id
      && item.tenantProspectId === req.params.id
    );
    const intelligenceSuggestions = linkedCandidates.flatMap((candidate) => {
      candidate.customerId = result.customer.id;
      if (result.created) return [];
      const generated = generateCustomerIntelligenceSuggestion(store, {
        customer: result.customer,
        candidate,
        leadId: result.lead.id,
        sourceEventId: result.sourceEvent.id,
        observedAt: result.sourceEvent.createdAt
      });
      return generated.suggestion ? [generated.suggestion] : [];
    });
    linkProcurementContextToCustomer(store, {
      teamId: req.user!.teamId,
      ownerId: req.user!.id,
      leadId: result.lead.id,
      tenantProspectId: req.params.id,
      prospectCandidateIds: linkedCandidates.map((item) => item.id)
    }, result.customer.id);
    if (linkedCandidates.length) {
      await persistCandidateChanges(store, linkedCandidates, true);
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Idempotency-Replayed",
      result.replayed ? "true" : "false"
    );
    res.status(result.replayed ? 200 : 201).json({
      replayed: result.replayed,
      created: result.created,
      customer: result.customer,
      lead: result.lead,
      sourceEvent: result.sourceEvent,
      customerActivity: result.customerActivity,
      leadActivity: result.leadActivity,
      prospect: result.prospect,
      intelligenceSuggestions
    });
  } catch (error) {
    if (sendProspectCustomerConversionError(res, error)) return;
    throw error;
  }
}));

app.get("/api/prospect-performance", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const scope = {
    teamId: req.user!.teamId,
    ownerId: req.user!.id
  };
  const created = generateProspectStrategySuggestions(store, scope);
  if (created.length) await store.persist();
  res.json({
    performance: prospectPerformance(store, scope),
    generatedSuggestionCount: created.length
  });
}));

app.get("/api/prospect-strategy-suggestions", requireAuth, (req, res) => {
  const status = String(req.query.status || "all");
  const allowedStatuses = new Set(["all", "pending", "accepted", "rejected"]);
  if (!allowedStatuses.has(status)) {
    res.status(400).json({ message: "策略建议状态参数无效" });
    return;
  }
  const suggestions = getStore().prospectStrategySuggestions
    .filter((item) =>
      item.teamId === req.user!.teamId
      && item.ownerId === req.user!.id
      && (status === "all" || item.status === status)
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  res.json({ suggestions });
});

app.post("/api/prospect-strategy-suggestions/:id/accept", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    note: z.string().trim().max(500).optional().default("")
  }).parse(req.body || {});
  const store = getStore();
  const suggestion = store.prospectStrategySuggestions.find((item) =>
    item.id === req.params.id
    && item.teamId === req.user!.teamId
    && item.ownerId === req.user!.id
  );
  if (!suggestion) {
    res.status(404).json({ message: "获客策略建议不存在" });
    return;
  }
  if (suggestion.status !== "pending") {
    res.status(400).json({ message: "该获客策略建议已经处理" });
    return;
  }
  reviewProspectStrategySuggestion(store, {
    teamId: req.user!.teamId,
    ownerId: req.user!.id,
    suggestionId: suggestion.id,
    status: "accepted",
    note: body.note
  });
  await store.persist();
  res.json({ suggestion });
}));

app.post("/api/prospect-strategy-suggestions/:id/reject", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    note: z.string().trim().max(500).optional().default("")
  }).parse(req.body || {});
  const store = getStore();
  const suggestion = store.prospectStrategySuggestions.find((item) =>
    item.id === req.params.id
    && item.teamId === req.user!.teamId
    && item.ownerId === req.user!.id
  );
  if (!suggestion) {
    res.status(404).json({ message: "获客策略建议不存在" });
    return;
  }
  if (suggestion.status !== "pending") {
    res.status(400).json({ message: "该获客策略建议已经处理" });
    return;
  }
  reviewProspectStrategySuggestion(store, {
    teamId: req.user!.teamId,
    ownerId: req.user!.id,
    suggestionId: suggestion.id,
    status: "rejected",
    note: body.note
  });
  await store.persist();
  res.json({ suggestion });
}));

app.get("/api/prospect-campaigns", requireAuth, asyncRoute(async (req, res) => {
  const includeArchived = z.enum(["true", "false"])
    .default("false")
    .parse(req.query.includeArchived) === "true";
  const store = getStore();
  await store.readBarrier();
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(listProspectCampaigns(store, req.user!, includeArchived));
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-campaigns", requireAuth, asyncRoute(async (req, res) => {
  const body = createProspectCampaignSchema.parse(req.body);
  try {
    const result = await createProspectCampaign({
      store: getStore(),
      user: req.user!,
      body,
      requestId: requestCorrelationId(req)
    });
    setProspectCampaignEtag(res, result);
    res.location(`/api/prospect-campaigns/${result.campaign.id}`);
    res.status(201).json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.get("/api/prospect-campaigns/:id", requireAuth, asyncRoute(async (req, res) => {
  const campaignId = prospectCampaignIdSchema.parse(req.params.id);
  const store = getStore();
  await store.readBarrier();
  try {
    const result = getProspectCampaign(store, req.user!, campaignId);
    setProspectCampaignEtag(res, result);
    res.json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.patch("/api/prospect-campaigns/:id", requireAuth, asyncRoute(async (req, res) => {
  const campaignId = prospectCampaignIdSchema.parse(req.params.id);
  const body = updateProspectCampaignSchema.parse(req.body);
  try {
    const result = await updateProspectCampaign({
      store: getStore(),
      user: req.user!,
      campaignId,
      ifMatch: req.header("If-Match"),
      body,
      requestId: requestCorrelationId(req)
    });
    setProspectCampaignEtag(res, result);
    res.json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-campaigns/:id/versions", requireAuth, asyncRoute(async (req, res) => {
  const campaignId = prospectCampaignIdSchema.parse(req.params.id);
  const body = createProspectCampaignVersionSchema.parse(req.body);
  try {
    const result = await createProspectCampaignVersion({
      store: getStore(),
      user: req.user!,
      campaignId,
      ifMatch: req.header("If-Match"),
      body,
      requestId: requestCorrelationId(req)
    });
    setProspectCampaignEtag(res, result);
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.get("/api/prospect-campaigns/:id/strategies", requireAuth, asyncRoute(async (req, res) => {
  const campaignId = prospectCampaignIdSchema.parse(req.params.id);
  const includeDisabled = z.enum(["true", "false"])
    .default("false")
    .parse(req.query.includeDisabled) === "true";
  const store = getStore();
  await store.readBarrier();
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(listProspectStrategies(
      store,
      req.user!,
      campaignId,
      includeDisabled
    ));
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-campaigns/:id/strategies", requireAuth, asyncRoute(async (req, res) => {
  const campaignId = prospectCampaignIdSchema.parse(req.params.id);
  const body = createProspectStrategySchema.parse(req.body);
  try {
    const result = await createProspectStrategy({
      store: getStore(),
      user: req.user!,
      campaignId,
      ifMatch: req.header("If-Match"),
      body,
      requestId: requestCorrelationId(req)
    });
    setProspectStrategyEtag(res, result);
    res.setHeader(
      "X-Campaign-ETag",
      `"${result.campaign.id}:${result.campaign.revision}"`
    );
    res.location(`/api/prospect-strategies/${result.strategy.id}`);
    res.status(201).json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-campaigns/:id/activate", requireAuth, asyncRoute(async (req, res) => {
  const campaignId = prospectCampaignIdSchema.parse(req.params.id);
  prospectCampaignActionSchema.parse(req.body);
  try {
    const result = await activateProspectCampaign({
      store: getStore(),
      user: req.user!,
      campaignId,
      ifMatch: req.header("If-Match"),
      requestId: requestCorrelationId(req)
    });
    setProspectCampaignEtag(res, result);
    res.json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

for (const action of [
  ["pause", "paused"],
  ["complete", "completed"],
  ["archive", "archived"]
] as const) {
  app.post(`/api/prospect-campaigns/:id/${action[0]}`, requireAuth, asyncRoute(async (req, res) => {
    const campaignId = prospectCampaignIdSchema.parse(req.params.id);
    const body = prospectCampaignActionSchema.parse(req.body);
    try {
      const result = await transitionProspectCampaign({
        store: getStore(),
        user: req.user!,
        campaignId,
        ifMatch: req.header("If-Match"),
        targetStatus: action[1],
        reason: body.reason,
        requestId: requestCorrelationId(req)
      });
      setProspectCampaignEtag(res, result);
      res.json(result);
    } catch (error) {
      if (sendProspectCampaignError(res, error)) return;
      throw error;
    }
  }));
}

app.get("/api/prospect-strategies/:id", requireAuth, asyncRoute(async (req, res) => {
  const strategyId = prospectStrategyIdSchema.parse(req.params.id);
  const store = getStore();
  await store.readBarrier();
  try {
    const result = getProspectStrategy(store, req.user!, strategyId);
    setProspectStrategyEtag(res, result);
    res.json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.patch("/api/prospect-strategies/:id", requireAuth, asyncRoute(async (req, res) => {
  const strategyId = prospectStrategyIdSchema.parse(req.params.id);
  const body = updateProspectStrategySchema.parse(req.body);
  try {
    const result = await updateProspectStrategy({
      store: getStore(),
      user: req.user!,
      strategyId,
      ifMatch: req.header("If-Match"),
      body,
      requestId: requestCorrelationId(req)
    });
    setProspectStrategyEtag(res, result);
    res.json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-strategies/:id/preview", requireAuth, asyncRoute(async (req, res) => {
  const strategyId = prospectStrategyIdSchema.parse(req.params.id);
  const body = previewProspectStrategySchema.parse(req.body);
  const store = getStore();
  await store.readBarrier();
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(previewProspectStrategy({
      store,
      user: req.user!,
      strategyId,
      body
    }));
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-strategies/:id/approve", requireAuth, asyncRoute(async (req, res) => {
  const strategyId = prospectStrategyIdSchema.parse(req.params.id);
  const body = prospectStrategyActionSchema.parse(req.body);
  try {
    const result = await approveProspectStrategy({
      store: getStore(),
      user: req.user!,
      strategyId,
      ifMatch: req.header("If-Match"),
      reason: body.reason,
      requestId: requestCorrelationId(req)
    });
    setProspectStrategyEtag(res, result);
    res.json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-strategies/:id/disable", requireAuth, asyncRoute(async (req, res) => {
  const strategyId = prospectStrategyIdSchema.parse(req.params.id);
  const body = prospectStrategyActionSchema.parse(req.body);
  try {
    const result = await disableProspectStrategy({
      store: getStore(),
      user: req.user!,
      strategyId,
      ifMatch: req.header("If-Match"),
      reason: body.reason,
      requestId: requestCorrelationId(req)
    });
    setProspectStrategyEtag(res, result);
    res.json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-strategies/:id/runs", requireAuth, asyncRoute(async (req, res) => {
  const strategyId = prospectStrategyIdSchema.parse(req.params.id);
  const body = createProspectRunSchema.parse(req.body);
  const rawIdempotencyKey = req.header("Idempotency-Key");
  if (!rawIdempotencyKey) {
    res.status(400).json({
      message: "必须提供 Idempotency-Key 请求头",
      errorCode: "IDEMPOTENCY_KEY_REQUIRED"
    });
    return;
  }
  const idempotencyKey = prospectRunIdempotencyKeySchema.parse(
    rawIdempotencyKey
  );
  try {
    const result = await createProspectRun({
      store: getStore(),
      user: req.user!,
      strategyId,
      ifMatch: req.header("If-Match"),
      idempotencyKey,
      body,
      requestId: requestCorrelationId(req)
    });
    await synchronizeProspectQueue();
    setProspectRunEtag(res, result);
    res.setHeader(
      "Idempotency-Replayed",
      result.idempotencyReplayed ? "true" : "false"
    );
    res.location(`/api/prospect-runs/${result.run.id}`);
    res.status(result.idempotencyReplayed ? 200 : 201).json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-strategies/:id/schedules", requireAuth, asyncRoute(async (req, res) => {
  const strategyId = prospectStrategyIdSchema.parse(req.params.id);
  const body = createProspectScheduleSchema.parse(req.body);
  try {
    const result = await createProspectSchedule({
      store: getStore(),
      user: req.user!,
      strategyId,
      ifMatch: req.header("If-Match"),
      body
    });
    setProspectScheduleEtag(res, result);
    res.location(`/api/prospect-schedules/${result.schedule.id}`);
    res.status(201).json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.get("/api/prospect-schedules", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  await store.readBarrier();
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(listProspectSchedules(store, req.user!));
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

for (const action of ["pause", "resume"] as const) {
  app.post(`/api/prospect-schedules/:id/${action}`, requireAuth, asyncRoute(async (req, res) => {
    const scheduleId = prospectScheduleIdSchema.parse(req.params.id);
    prospectScheduleActionSchema.parse(req.body);
    try {
      const result = await transitionProspectSchedule({
        store: getStore(),
        user: req.user!,
        scheduleId,
        ifMatch: req.header("If-Match"),
        action
      });
      setProspectScheduleEtag(res, result);
      res.json(result);
    } catch (error) {
      if (sendProspectCampaignError(res, error)) return;
      throw error;
    }
  }));
}

app.delete("/api/prospect-schedules/:id", requireAuth, asyncRoute(async (req, res) => {
  const scheduleId = prospectScheduleIdSchema.parse(req.params.id);
  try {
    const result = await deleteProspectSchedule({
      store: getStore(),
      user: req.user!,
      scheduleId,
      ifMatch: req.header("If-Match")
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.get("/api/prospect-runs", requireAuth, asyncRoute(async (req, res) => {
  const query = parseProspectRunListQuery(req.query);
  const store = getStore();
  await store.readBarrier();
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(listProspectRuns({ store, user: req.user!, query }));
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-super-search/preview", requireAuth, asyncRoute(async (req, res) => {
  const body = prospectSuperSearchPreviewSchema.parse(req.body);
  res.setHeader("Cache-Control", "no-store");
  res.json({ preview: prospectSuperSearchPreview(body) });
}));

app.post("/api/prospect-super-search", requireAuth, asyncRoute(async (req, res) => {
  const body = createProspectSuperSearchSchema.parse(req.body);
  try {
    const result = await createProspectSuperSearch({
      store: getStore(),
      user: req.user!,
      body,
      onRunCreated: synchronizeProspectQueue
    });
    res.setHeader("ETag", prospectSuperSearchEtag(result.mission));
    res.location(`/api/prospect-super-search/${result.mission.id}`);
    res.status(201).json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.get("/api/prospect-super-search", requireAuth, asyncRoute(async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).default(30).parse(req.query.limit);
  const store = getStore();
  await store.readBarrier();
  res.setHeader("Cache-Control", "no-store");
  res.json(listProspectSuperSearches(store, req.user!, limit));
}));

app.get("/api/prospect-super-search/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  await store.readBarrier();
  try {
    const result = superSearchDetail(store, req.user!, String(req.params.id));
    res.setHeader("ETag", prospectSuperSearchEtag(result.mission));
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

const prospectLiveStreamQuerySchema = z.object({
  once: z.enum(["0", "1"]).optional().default("0")
}).passthrough();

async function writeProspectLiveEvent(res: Response, event: ProspectLiveEvent) {
  const payload = `id: ${event.id}\nevent: prospect\ndata: ${JSON.stringify(event)}\n\n`;
  if (res.writableLength > 1_048_576) return false;
  if (res.write(payload)) return true;
  await Promise.race([
    once(res, "drain"),
    once(res, "close")
  ]);
  return !res.writableEnded && !res.destroyed;
}

app.get("/api/prospect-runs/:id/events/stream", requireAuth, asyncRoute(async (req, res) => {
  const runId = prospectRunIdSchema.parse(req.params.id);
  const query = prospectLiveStreamQuerySchema.parse(req.query);
  const store = getStore();
  await store.readBarrier();
  try {
    getProspectRun(store, req.user!, runId);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  const suppliedCursor = String(req.header("Last-Event-ID") || req.query.lastEventId || "0")
    .trim()
    .slice(0, 32);
  if (!/^\d+$/u.test(suppliedCursor)) {
    res.end();
    return;
  }
  let cursor = suppliedCursor;
  let closed = false;
  let pumping = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let poller: NodeJS.Timeout | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (poller) clearTimeout(poller);
    if (!res.writableEnded) res.end();
  };
  const pump = async () => {
    if (closed || pumping) return;
    pumping = true;
    try {
      const feed = await store.readProspectRunFeed?.({
        teamId: req.user!.teamId,
        runId,
        after: cursor,
        limit: 200
      });
      if (!feed) {
        close();
        return;
      }
      for (const event of feed.events) {
        if (closed || res.writableEnded) break;
        if (!await writeProspectLiveEvent(res, event)) {
          close();
          return;
        }
        cursor = event.id;
      }
      if (query.once === "1") {
        close();
        return;
      }
      if (feed.terminal && feed.events.length === 0) {
        close();
        return;
      }
    } catch {
      close();
    } finally {
      pumping = false;
      if (!closed) {
        poller = setTimeout(() => void pump(), 750);
      }
    }
  };

  req.on("close", close);
  heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, 15_000);
  await pump();
}));

for (const action of ["pause", "resume", "cancel"] as const) {
  app.post(`/api/prospect-super-search/:id/${action}`, requireAuth, asyncRoute(async (req, res) => {
    const body = prospectSuperSearchActionSchema.parse(req.body);
    try {
      const result = await transitionProspectSuperSearch({
        store: getStore(),
        user: req.user!,
        missionId: String(req.params.id),
        ifMatch: req.header("If-Match"),
        action,
        reason: body.reason,
        onRunChanged: synchronizeProspectQueue
      });
      res.setHeader("ETag", prospectSuperSearchEtag(result.mission));
      res.json(result);
    } catch (error) {
      if (sendProspectCampaignError(res, error)) return;
      throw error;
    }
  }));
}

app.get("/api/prospect-runs/:id", requireAuth, asyncRoute(async (req, res) => {
  const runId = prospectRunIdSchema.parse(req.params.id);
  const store = getStore();
  await store.readBarrier();
  try {
    const result = getProspectRun(store, req.user!, runId);
    setProspectRunEtag(res, result);
    res.json(result);
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

const prospectPendingSelectionSchema = z.object({
  hitIds: z.array(
    z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/)
  ).min(1).max(200)
}).strict();

app.get("/api/prospect-runs/:id/pending-candidates", requireAuth, asyncRoute(async (req, res) => {
  const runId = prospectRunIdSchema.parse(req.params.id);
  const store = getStore();
  await store.readBarrier();
  try {
    const detail = getProspectRun(store, req.user!, runId);
    if (!activeProspectWorkerService) {
      res.status(503).json({
        errorCode: "PROSPECT_WORKER_UNAVAILABLE",
        message: "候选处理服务未启动，暂时无法读取待清洗结果"
      });
      return;
    }
    const candidates = activeProspectWorkerService.pendingCandidates({
      teamId: req.user!.teamId,
      ownerId: detail.run.ownerId,
      runId
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ candidates: candidates || [] });
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-runs/:id/import-pending", requireAuth, asyncRoute(async (req, res) => {
  const runId = prospectRunIdSchema.parse(req.params.id);
  const body = prospectPendingSelectionSchema.parse(req.body);
  const store = getStore();
  await store.readBarrier();
  try {
    const detail = getProspectRun(store, req.user!, runId);
    if (!["succeeded", "succeeded_empty", "partial_success", "failed", "cancelled"].includes(detail.run.status)) {
      throw new ProspectRunRequestError(
        409,
        "RUN_STILL_ACTIVE",
        "任务仍在执行，结束后才能手动导入未处理结果"
      );
    }
    if (!detail.diagnostics.cleaningReport.summary.pendingCount) {
      res.setHeader("Cache-Control", "no-store");
      res.json({
        result: { attempted: 0, processed: 0, created: 0, updated: 0, suppressed: 0, skipped: 0, failures: [] },
        detail
      });
      return;
    }
    if (!activeProspectWorkerService) {
      res.status(503).json({
        errorCode: "PROSPECT_WORKER_UNAVAILABLE",
        message: "候选处理服务未启动，暂时无法手动导入"
      });
      return;
    }
    const selected = activeProspectWorkerService.pendingCandidates({
      teamId: req.user!.teamId,
      ownerId: detail.run.ownerId,
      runId,
      hitIds: body.hitIds
    }) || [];
    if (new Set(selected.map((item) => item.hitId)).size !== new Set(body.hitIds).size) {
      throw new ProspectRunRequestError(
        409,
        "PENDING_SELECTION_CHANGED",
        "部分待清洗记录已处理或不属于当前任务，请刷新后重新选择"
      );
    }
    const result = await activeProspectWorkerService.processPendingCandidates({
      teamId: req.user!.teamId,
      ownerId: detail.run.ownerId,
      runId,
      hitIds: body.hitIds
    });
    if (!result) {
      res.status(503).json({
        errorCode: "CANDIDATE_PIPELINE_UNAVAILABLE",
        message: "候选处理管线暂时不可用，请稍后重试"
      });
      return;
    }
    await store.readBarrier();
    const updated = getProspectRun(store, req.user!, runId);
    setProspectRunEtag(res, updated);
    res.setHeader("Cache-Control", "no-store");
    res.json({ result, detail: updated });
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.get("/api/prospect-super-search/:id/pending-candidates", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  await store.readBarrier();
  try {
    const detail = superSearchDetail(store, req.user!, String(req.params.id));
    if (!activeProspectWorkerService) {
      res.status(503).json({
        errorCode: "PROSPECT_WORKER_UNAVAILABLE",
        message: "候选处理服务未启动，暂时无法读取待清洗结果"
      });
      return;
    }
    const candidates = detail.rounds
      .flatMap((round) => activeProspectWorkerService!.pendingCandidates({
        teamId: req.user!.teamId,
        ownerId: detail.mission.ownerId,
        runId: round.runId
      }) || [])
      .sort((left, right) => left.fetchedAt.localeCompare(right.fetchedAt))
      .slice(0, 200);
    res.setHeader("Cache-Control", "no-store");
    res.json({ candidates });
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

app.post("/api/prospect-super-search/:id/import-pending", requireAuth, asyncRoute(async (req, res) => {
  const body = prospectPendingSelectionSchema.parse(req.body);
  const store = getStore();
  await store.readBarrier();
  try {
    const detail = superSearchDetail(store, req.user!, String(req.params.id));
    if (["queued", "running", "paused"].includes(detail.mission.status)) {
      throw new ProspectRunRequestError(
        409,
        "RUN_STILL_ACTIVE",
        "超级搜索仍在执行，结束后才能手动导入待清洗结果"
      );
    }
    if (!activeProspectWorkerService) {
      res.status(503).json({
        errorCode: "PROSPECT_WORKER_UNAVAILABLE",
        message: "候选处理服务未启动，暂时无法手动导入"
      });
      return;
    }
    const runIds = new Set(detail.rounds.map((item) => item.runId));
    const selected = activeProspectWorkerService.pendingCandidates({
      teamId: req.user!.teamId,
      ownerId: detail.mission.ownerId,
      hitIds: body.hitIds
    })?.filter((item) => runIds.has(item.runId)) || [];
    if (new Set(selected.map((item) => item.hitId)).size !== new Set(body.hitIds).size) {
      throw new ProspectRunRequestError(
        409,
        "PENDING_SELECTION_CHANGED",
        "部分待清洗记录已处理或不属于当前超级搜索，请刷新后重新选择"
      );
    }
    const totals = {
      attempted: 0,
      processed: 0,
      created: 0,
      updated: 0,
      suppressed: 0,
      skipped: 0,
      failures: [] as Array<{ hitId: string; runId: string; ledgerId: string; code: string }>
    };
    for (const runId of [...new Set(selected.map((item) => item.runId))]) {
      const hitIds = selected.filter((item) => item.runId === runId).map((item) => item.hitId);
      const result = await activeProspectWorkerService.processPendingCandidates({
        teamId: req.user!.teamId,
        ownerId: detail.mission.ownerId,
        runId,
        hitIds
      });
      if (!result) continue;
      totals.attempted += result.attempted;
      totals.processed += result.processed;
      totals.created += result.created;
      totals.updated += result.updated;
      totals.suppressed += result.suppressed;
      totals.skipped += result.skipped;
      totals.failures.push(...result.failures);
    }
    refreshProspectSuperSearchMissionResults(store, detail.mission.id);
    await store.persist();
    await store.readBarrier();
    res.setHeader("Cache-Control", "no-store");
    res.json({ result: totals, detail: superSearchDetail(store, req.user!, String(req.params.id)) });
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
}));

for (const action of ["pause", "resume", "cancel"] as const) {
  app.post(`/api/prospect-runs/:id/${action}`, requireAuth, asyncRoute(async (req, res) => {
    const runId = prospectRunIdSchema.parse(req.params.id);
    const body = prospectRunActionSchema.parse(req.body);
    try {
      const result = await transitionProspectRun({
        store: getStore(),
        user: req.user!,
        runId,
        ifMatch: req.header("If-Match"),
        action,
        body,
        requestId: requestCorrelationId(req)
      });
      await synchronizeProspectQueue();
      setProspectRunEtag(res, result);
      res.json(result);
    } catch (error) {
      if (sendProspectCampaignError(res, error)) return;
      throw error;
    }
  }));
}

app.post("/api/prospect-campaigns/:id/market-analysis-runs", requireAuth, asyncRoute(async (req, res) => {
  const campaignId = z.string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .parse(req.params.id);
  const store = getStore();
  await store.readBarrier();
  try {
    resolveMarketCampaignReference({
      store,
      user: req.user!,
      campaignId,
      requireActive: true
    });
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    throw error;
  }
  const rawIdempotencyKey = req.header("Idempotency-Key");
  if (!rawIdempotencyKey) {
    res.status(400).json({
      message: "必须提供 Idempotency-Key 请求头",
      errorCode: "IDEMPOTENCY_KEY_REQUIRED"
    });
    return;
  }
  const idempotencyKey = z.string()
    .trim()
    .min(8)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .parse(rawIdempotencyKey);
  const body = z.object({
    providerId: z.string().trim().min(1).max(40).default("un_comtrade"),
    reporterCodes: z.array(z.string()).min(1).max(20),
    partnerCodes: z.array(z.string()).min(1).max(20),
    flow: z.enum(["import", "export"]),
    hsVersion: z.enum(["HS", "HS2017", "HS2022"]),
    commodityCodes: z.array(z.string()).min(1).max(50),
    periods: z.array(z.string()).min(1).max(36),
    frequency: z.enum(["annual", "monthly"]),
    limit: z.number().int().min(1).max(500).default(500)
  }).strict().parse(req.body);

  try {
    const result = await createMarketAnalysisRun({
      store,
      user: req.user!,
      campaignId,
      providerId: body.providerId,
      idempotencyKey,
      query: body
    });
    res.location(`/api/prospect-agent-jobs/${result.job.id}`);
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    if (error instanceof MarketAnalysisRunRequestError) {
      res.status(error.status).json({ message: error.message, errorCode: error.code });
      return;
    }
    if (error instanceof MarketAnalysisRunProviderError) {
      res.location(`/api/prospect-agent-jobs/${error.job.id}`);
      res.status(error.status).json({
        message: error.failure.publicMessage,
        errorCode: error.failure.code,
        retryable: error.failure.retryable,
        retryAfterAt: error.failure.retryAfterAt,
        ...marketAnalysisRunMetadata(),
        job: publicAgentJob(error.job)
      });
      return;
    }
    throw error;
  }
}));

app.get("/api/prospect-campaigns/:id/trade-observations", requireAuth, asyncRoute(async (req, res) => {
  const campaignId = z.string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .parse(req.params.id);
  const query = parseTradeObservationListQuery(req.query);
  const store = getStore();
  await store.readBarrier();
  try {
    const reference = resolveMarketCampaignReference({
      store,
      user: req.user!,
      campaignId
    });
    res.json(listTradeObservations({
      store,
      user: req.user!,
      campaignId,
      campaignContractMode: reference.campaignContractMode,
      query
    }));
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    if (error instanceof TradeObservationListRequestError) {
      res.status(error.status).json({
        message: error.message,
        errorCode: error.code
      });
      return;
    }
    throw error;
  }
}));

app.get("/api/prospect-campaigns/:id/market-opportunities", requireAuth, asyncRoute(async (req, res) => {
  const campaignId = z.string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .parse(req.params.id);
  const query = parseMarketOpportunityListQuery(req.query);
  const store = getStore();
  await store.readBarrier();
  try {
    const reference = resolveMarketCampaignReference({
      store,
      user: req.user!,
      campaignId
    });
    res.json(listMarketOpportunities({
      store,
      user: req.user!,
      campaignId,
      campaignContractMode: reference.campaignContractMode,
      query
    }));
  } catch (error) {
    if (sendProspectCampaignError(res, error)) return;
    if (error instanceof MarketOpportunityListRequestError) {
      res.status(error.status).json({
        message: error.message,
        errorCode: error.code
      });
      return;
    }
    throw error;
  }
}));

app.post("/api/lead-finder/source-config", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    provider: z.string().min(1).max(40),
    apiKey: z.string().max(400).optional().default(""),
    baseUrl: z.string().max(255).optional().default(""),
    enabled: z.boolean().optional().default(false)
  });
  const body = schema.parse(req.body);
  const provider = getConfigurableProvider(body.provider);
  if (!provider) {
    res.status(404).json({
      message: "未知数据源",
      errorCode: "PROVIDER_NOT_REGISTERED",
      retryable: false,
      retryAfterAt: null
    });
    return;
  }
  const catalog = providerCatalogByCode(provider.id);
  if (!catalog) {
    res.status(409).json({ message: "数据源目录缺失，暂不能保存连接" });
    return;
  }
  if (catalog.accessMode !== "api" || provider.accessMode !== "api") {
    res.status(400).json({
      message: "该来源用于官方入口人工核验；取得企业页或结果页链接后，可返回获客页面解析，无需保存 API 连接",
      errorCode: "PROVIDER_POLICY_BLOCKED",
      retryable: false,
      retryAfterAt: null
    });
    return;
  }
  if (provider.id === "us_census_trade" && body.baseUrl.trim()) {
    res.status(400).json({ message: "美国 Census 数据源使用固定官方地址，不允许自定义基础地址" });
    return;
  }
  if (body.baseUrl) assertProviderBaseUrlAllowed(body.baseUrl, provider.networkPolicy);
  const store = getStore();
  const existing = getProviderConnection(req.user!, body.provider);
  const existingConfiguration = providerConnectionConfiguration(existing);
  const apiKey = body.apiKey && !body.apiKey.includes("****") ? body.apiKey : existingConfiguration.apiKey;
  const baseUrl = provider.id === "us_census_trade"
    ? ""
    : body.baseUrl || existingConfiguration.baseUrl;
  if (providerRequiresKey(provider, catalog) && body.enabled && !apiKey) {
    res.status(400).json({
      message: provider.id === "sec_edgar"
        ? "启用前请填写 SEC Fair Access User-Agent（系统名 联系邮箱）"
        : "启用前请先填写该数据源的 API Key"
    });
    return;
  }
  const now = new Date().toISOString();
  const id = existing?.id || `pc_${provider.id}_${req.user!.id}_${Date.now()}`;
  const context = { id, providerId: provider.id, ownerId: req.user!.id, teamId: req.user!.teamId };
  const connection: ProviderConnection = {
    ...context,
    scope: "personal",
    credentialRef: existing?.credentialRef || createCredentialRef(),
    configurationEncrypted: encryptProviderConfiguration(context, { apiKey, baseUrl }),
    status: body.enabled ? "active" : "disabled",
    quotaPolicy: existing?.quotaPolicy || {},
    budgetPolicy: existing?.budgetPolicy || {},
    lastHealthAt: existing?.lastHealthAt || "",
    lastHealthStatus: existing?.lastHealthStatus || "untested",
    lastErrorCode: existing?.lastErrorCode || "",
    lastHealthMessage: existing?.lastHealthMessage || "",
    usage: existing?.usage || "",
    createdBy: existing?.createdBy || req.user!.id,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  if (existing) Object.assign(existing, connection);
  else store.providerConnections.unshift(connection);
  await store.persist();
  res.json({ config: publicLeadSourceConfig(connection), providers: allProviderStatuses(req.user!) });
}));

app.post("/api/lead-finder/source-config/test", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ provider: z.string().min(1).max(40) });
  const body = schema.parse(req.body);
  const provider = getConfigurableProvider(body.provider);
  if (!provider) {
    res.status(404).json({ message: "未知数据源" });
    return;
  }
  const store = getStore();
  const catalog = providerCatalogByCode(provider.id);
  if (!catalog) {
    res.status(409).json({
      message: "数据源目录缺失，暂不能测试连接",
      errorCode: "PROVIDER_CATALOG_MISSING",
      retryable: false,
      retryAfterAt: null
    });
    return;
  }
  if (catalog.accessMode !== "api" || provider.accessMode !== "api") {
    res.status(400).json({
      message: "该来源不是自动 API，请通过官方入口检索或下载后导入",
      errorCode: "PROVIDER_POLICY_BLOCKED",
      retryable: false,
      retryAfterAt: null
    });
    return;
  }
  const connection = getProviderConnection(req.user!, provider.id);
  const connectionRead = readProviderConnectionConfiguration(connection);
  const configuration = connectionRead.configuration;
  if (connection && !connectionRead.readable) {
    res.status(409).json({
      message: "连接凭据不可读取，请重新保存后再测试",
      errorCode: "PROVIDER_CONNECTION_INVALID",
      retryable: false,
      retryAfterAt: null
    });
    return;
  }
  if (providerRequiresKey(provider, catalog) && !configuration.apiKey) {
    res.status(400).json({
      message: provider.id === "sec_edgar"
        ? "请先保存 SEC Fair Access User-Agent，再测试连接"
        : "请先保存该数据源的 API Key，再测试连接",
      errorCode: "PROVIDER_CONNECTION_INVALID",
      retryable: false,
      retryAfterAt: null
    });
    return;
  }
  const runId = `prun_test_${randomUUID()}`;
  let result: Awaited<ReturnType<typeof executeProviderHealth>>;
  let failure: ProviderContractError | null = null;
  try {
    result = await executeProviderHealth({
      provider,
      catalog,
      context: createProviderExecutionContext({
        teamId: req.user!.teamId,
        ownerId: req.user!.id,
        runId,
        providerId: provider.id,
        operation: "health",
        purpose: "provider_connection_test"
      }),
      connection,
      credential: connection ? undefined : configuration,
      allowDisabledConnectionForHealth: true,
      onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
    });
  } catch (error) {
    failure = providerErrorFromUnknown(error, "health");
    result = { ok: false, message: `连接异常：${failure.publicMessage}` };
  }
  const errorCode = result.ok ? "" : failure?.code || "PROVIDER_UNAVAILABLE";
  const retryable = result.ok ? false : failure?.retryable || false;
  const retryAfterAt = result.ok ? null : failure?.retryAfterAt || null;
  if (connection) {
    connection.lastHealthAt = new Date().toISOString();
    connection.lastHealthStatus = result.ok ? "passed" : "failed";
    connection.lastErrorCode = errorCode.toLocaleLowerCase();
    connection.lastHealthMessage = result.message;
    if (result.usage?.display) connection.usage = result.usage.display;
    connection.updatedAt = new Date().toISOString();
  }
  await store.persist();
  res.json({
    ok: result.ok,
    message: result.message,
    usage: result.usage?.display || "",
    errorCode,
    retryable,
    retryAfterAt,
    providers: allProviderStatuses(req.user!)
  });
}));

app.delete("/api/lead-finder/source-config/:provider", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.providerConnections.findIndex((item) =>
    item.providerId === req.params.provider
    && item.ownerId === req.user!.id
    && item.teamId === req.user!.teamId
  );
  if (index < 0) {
    res.status(404).json({ message: "配置不存在或无权删除" });
    return;
  }
  store.providerConnections.splice(index, 1);
  await store.persist();
  res.json({ providers: allProviderStatuses(req.user!) });
}));

const leadSearchSchema = z.object({
  goal: z.string().default(""),
  productKeywords: z.string().default(""),
  countries: z.string().default(""),
  industry: z.string().default(""),
  customerType: z.string().default(""),
  excludeKeywords: z.string().default(""),
  sources: z.array(z.string().trim().min(1).max(64).regex(/^[a-z0-9_]+$/i)).max(64).default([]),
  useAi: z.boolean().default(false),
  limit: z.number().min(1).max(30).default(12)
});

app.post("/api/lead-finder/search", requireAuth, asyncRoute(async (req, res) => {
  const body = leadSearchSchema.parse(req.body);
  const store = getStore();
  const user = req.user!;
  const runId = `prun_search_${randomUUID()}`;
  const query: LeadQuery = {
    goal: body.goal,
    productKeywords: body.productKeywords,
    countries: body.countries,
    industry: body.industry,
    customerType: body.customerType,
    excludeKeywords: body.excludeKeywords,
    limit: Math.min(body.limit, 15)
  };

  // 是否需要 Key 统一以持久化 Catalog 策略为准，实际可执行性由 Runtime 校验并记录审计。
  const chosen = body.sources.length
    ? LEAD_PROVIDERS.filter((provider) => body.sources.includes(provider.id))
    : LEAD_PROVIDERS.filter((provider) =>
        DEFAULT_LEAD_SEARCH_PROVIDER_IDS.includes(
          provider.id as (typeof DEFAULT_LEAD_SEARCH_PROVIDER_IDS)[number]
        )
      );
  const activeProviders = chosen.filter((provider) =>
    provider.accessMode === "api"
    && providerCatalogByCode(provider.id)?.accessMode === "api"
  );
  const unknownSourceIds = [...new Set(body.sources.filter((id) =>
    id !== "ai_search" && !LEAD_PROVIDERS.some((provider) => provider.id === id)
  ))];
  const skipped: string[] = [];
  const wantsAiSearch = body.sources.includes("ai_search");

  const searchProviders = activeProviders.filter((provider) => provider.category !== "email");
  const emailProviders = activeProviders.filter((provider) => provider.category === "email" && provider.enrich);

  const sourceStats: Array<{
    id: string;
    name: string;
    count: number;
    status?: string;
    error?: string;
    errorCode?: string;
    retryable?: boolean;
    retryAfterAt?: string | null;
    nextCursor?: string | null;
    usage?: string;
  }> = [];
  for (const providerId of unknownSourceIds) {
    recordProviderPreflightFailure(user, runId, providerId, "PROVIDER_NOT_REGISTERED", "search_preflight");
    sourceStats.push({
      id: providerId,
      name: providerId,
      count: 0,
      status: "failed",
      error: "未知数据源",
      errorCode: "PROVIDER_NOT_REGISTERED",
      retryable: false,
      retryAfterAt: null
    });
  }
  type CollectedLead = RawLead & {
    source: string;
    sourceLabel: string;
    payloadHash?: string;
    sourceEvidence: ProviderEvidenceSnapshot[];
  };
  const collected: CollectedLead[] = [];

  await Promise.all(searchProviders.map(async (provider) => {
    const connection = getProviderConnection(user, provider.id);
    const catalog = providerCatalogByCode(provider.id);
    if (!catalog) {
      recordProviderPreflightFailure(user, runId, provider.id, "PROVIDER_CATALOG_MISSING", "search_preflight");
      sourceStats.push({
        id: provider.id,
        name: provider.name,
        count: 0,
        status: "failed",
        error: "数据源目录缺失",
        errorCode: "PROVIDER_CATALOG_MISSING",
        retryable: false,
        retryAfterAt: null
      });
      return;
    }
    try {
      const result = await executeProviderSearch({
        provider,
        catalog,
        context: createProviderExecutionContext({
          teamId: user.teamId,
          ownerId: user.id,
          runId,
          providerId: provider.id,
          operation: "search",
          purpose: "lead_finder_search"
        }),
        connection,
        credential: connection ? undefined : { apiKey: "", baseUrl: "" },
        query,
        onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
      });
      for (const lead of result.records) {
        if (!lead.company) continue;
        collected.push({
          ...lead,
          source: provider.id,
          sourceLabel: provider.name,
          sourceEvidence: [providerEvidenceSnapshot(provider.id, lead)]
        });
      }
      sourceStats.push({
        id: provider.id,
        name: provider.name,
        count: result.records.length,
        status: result.status,
        nextCursor: result.nextCursor,
        usage: result.usage.display
      });
    } catch (error) {
      const failure = providerErrorFromUnknown(error, "search");
      sourceStats.push({
        id: provider.id,
        name: provider.name,
        count: 0,
        status: "failed",
        error: failure.publicMessage,
        errorCode: failure.code,
        retryable: failure.retryable,
        retryAfterAt: failure.retryAfterAt
      });
    }
  }));

  // AI 搜索：用「AI 模型配置」里已启用并勾选自动获客的模型直接生成候选公司
  if (wantsAiSearch) {
    const aiSearchConfig = getAiConfig(user, "leadFinder");
    const catalog = providerCatalogByCode("ai_search");
    if (!catalog) {
      recordProviderPreflightFailure(user, runId, "ai_search", "PROVIDER_CATALOG_MISSING", "search_preflight");
      sourceStats.push({
        id: "ai_search",
        name: "AI 搜索",
        count: 0,
        status: "failed",
        error: "AI 搜索目录缺失",
        errorCode: "PROVIDER_CATALOG_MISSING",
        retryable: false,
        retryAfterAt: null
      });
    } else if (aiSearchConfig?.enabled && aiSearchConfig.apiKey && aiSearchConfig.useLeadFinder) {
      try {
        const provider = createAiSearchProvider(aiSearchConfig);
        const result = await executeProviderSearch({
          provider,
          catalog,
          context: createProviderExecutionContext({
            teamId: user.teamId,
            ownerId: user.id,
            runId,
            providerId: provider.id,
            operation: "search",
            purpose: "lead_finder_ai_search"
          }),
          credential: {
            apiKey: aiSearchConfig.apiKey,
            baseUrl: aiSearchConfig.baseUrl
          },
          query,
          onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
        });
        for (const lead of result.records) {
          if (!lead.company) continue;
          collected.push({
            ...lead,
            source: "ai_search",
            sourceLabel: "AI 搜索",
            sourceEvidence: [providerEvidenceSnapshot("ai_search", lead)]
          });
        }
        sourceStats.push({
          id: "ai_search",
          name: "AI 搜索",
          count: result.records.length,
          status: result.status,
          nextCursor: result.nextCursor,
          usage: result.usage.display
        });
      } catch (error) {
        const failure = providerErrorFromUnknown(error, "search");
        sourceStats.push({
          id: "ai_search",
          name: "AI 搜索",
          count: 0,
          status: "failed",
          error: failure.publicMessage,
          errorCode: failure.code,
          retryable: failure.retryable,
          retryAfterAt: failure.retryAfterAt
        });
      }
    } else {
      recordProviderPreflightFailure(user, runId, "ai_search", "PROVIDER_CONNECTION_INVALID", "search_preflight");
      sourceStats.push({
        id: "ai_search",
        name: catalog.name || "AI 搜索",
        count: 0,
        status: "failed",
        error: "请先启用可用于自动获客的 AI 模型",
        errorCode: "PROVIDER_CONNECTION_INVALID",
        retryable: false,
        retryAfterAt: null
      });
      skipped.push("AI 搜索（未启用模型）");
    }
  }

  // 同批次只按强标识或“官网域名 + 国家”合并；同名公司不再直接视为同一主体。
  const deduped: CollectedLead[] = [];
  for (const lead of collected) {
    const domain = websiteDomainKey(lead.officialWebsite || lead.website || "");
    const country = (lead.country || "").trim().toLocaleLowerCase();
    const existing = deduped.find((row) => {
      const sameProviderRecord = Boolean(
        lead.providerRecordId
        && row.providerRecordId
        && lead.source === row.source
        && lead.providerRecordId === row.providerRecordId
      );
      const samePayload = Boolean(
        lead.payloadHash
        && row.payloadHash
        && lead.source === row.source
        && lead.payloadHash === row.payloadHash
      );
      const rowDomain = websiteDomainKey(row.officialWebsite || row.website || "");
      const sameDomainCountry = Boolean(
        domain
        && rowDomain === domain
        && (row.country || "").trim().toLocaleLowerCase() === country
      );
      return sameProviderRecord || samePayload || sameDomainCountry;
    });
    if (existing) {
      existing.sourceEvidence = mergeProviderEvidence(existing.sourceEvidence, lead.sourceEvidence);
      if (!existing.officialWebsite && lead.officialWebsite) {
        existing.officialWebsite = lead.officialWebsite;
        existing.website = lead.officialWebsite;
      }
      if (!existing.contactInfo && lead.contactInfo) existing.contactInfo = lead.contactInfo;
      if ((!existing.contact || existing.contact === "待维护") && lead.contact) existing.contact = lead.contact;
      existing.confidence = Math.max(existing.confidence || 0, lead.confidence || 0);
      continue;
    }
    deduped.push(lead);
  }

  // 邮箱源补全（Hunter 等）：对缺联系方式且有域名的候选补邮箱
  for (const provider of emailProviders) {
    const connection = getProviderConnection(user, provider.id);
    const catalog = providerCatalogByCode(provider.id);
    if (!catalog) {
      recordProviderPreflightFailure(user, runId, provider.id, "PROVIDER_CATALOG_MISSING", "enrich_preflight");
      sourceStats.push({
        id: provider.id,
        name: provider.name,
        count: 0,
        status: "failed",
        error: "数据源目录缺失",
        errorCode: "PROVIDER_CATALOG_MISSING",
        retryable: false,
        retryAfterAt: null
      });
      continue;
    }
    const targets = deduped.filter((lead) => !lead.contactInfo && websiteDomainKey(lead.website || "")).slice(0, 8);
    if (!targets.length) {
      try {
        await executeProviderPreflight({
          provider,
          catalog,
          context: createProviderExecutionContext({
            teamId: user.teamId,
            ownerId: user.id,
            runId,
            providerId: provider.id,
            operation: "enrich",
            purpose: "lead_finder_contact_enrichment_preflight"
          }),
          connection,
          credential: connection ? undefined : { apiKey: "", baseUrl: "" },
          onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
        });
      } catch (error) {
        const failure = providerErrorFromUnknown(error, "enrich");
        sourceStats.push({
          id: provider.id,
          name: provider.name,
          count: 0,
          status: "failed",
          error: failure.publicMessage,
          errorCode: failure.code,
          retryable: failure.retryable,
          retryAfterAt: failure.retryAfterAt
        });
        continue;
      }
    }
    let filled = 0;
    let enrichError: ProviderContractError | null = null;
    for (const [targetIndex, lead] of targets.entries()) {
      try {
        const enriched = await executeProviderEnrich({
          provider,
          catalog,
          context: createProviderExecutionContext({
            teamId: user.teamId,
            ownerId: user.id,
            runId,
            providerId: provider.id,
            operation: "enrich",
            purpose: "lead_finder_contact_enrichment",
            suffix: String(targetIndex)
          }),
          connection,
          credential: connection ? undefined : { apiKey: "", baseUrl: "" },
          domain: websiteDomainKey(lead.website || ""),
          onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
        });
        if (enriched?.contactInfo) {
          lead.contactInfo = enriched.contactInfo;
          if (enriched.contact) lead.contact = enriched.contact;
          lead.sourceEvidence = mergeProviderEvidence(lead.sourceEvidence, [
            providerEvidenceSnapshot(provider.id, enriched.evidence)
          ]);
          if (typeof enriched.confidence === "number") {
            lead.confidence = Math.max(lead.confidence || 0, enriched.confidence);
          }
          filled += 1;
        }
      } catch (error) {
        enrichError = providerErrorFromUnknown(error, "enrich");
        continue;
      }
    }
    sourceStats.push({
      id: provider.id,
      name: provider.name,
      count: filled,
      status: enrichError ? (filled ? "partial_success" : "failed") : (filled ? "success" : "success_empty"),
      error: enrichError?.publicMessage,
      errorCode: enrichError?.code,
      retryable: enrichError?.retryable,
      retryAfterAt: enrichError?.retryAfterAt
    });
  }

  // 落库为 WebsiteOpportunity
  const opportunities: WebsiteOpportunity[] = deduped.slice(0, query.limit * 2).map((lead) =>
    withProspectVerificationReport({
      id: `lf_${lead.source}_${randomUUID()}`,
      company: lead.company,
      business: lead.business || "待维护",
      country: lead.country || "未知",
      website: normalizeWebsite(lead.website || ""),
      contact: lead.contact || "待维护",
      contactInfo: lead.contactInfo || "",
      description: lead.description || "自动获客候选，待核实。",
      ownerId: user.id,
      teamId: user.teamId,
      status: "preview",
      createdAt: new Date().toISOString(),
      parseMode: lead.source === "ai_search" ? "ai" : "rule",
      source: lead.source,
      sourceLabel: lead.sourceLabel,
      sourceEvidence: lead.sourceEvidence,
      confidence: lead.confidence
    })
  );

  await store.reloadProspectCandidates?.();
  const persistence = persistProviderOpportunities(opportunities, {
    rawCount: collected.length,
    deduplicatedCount: Math.max(0, collected.length - deduped.length)
  });
  await persistCandidateChanges(
    store,
    persistence.opportunities,
    true
  );

  // 自动官网探测（翻官网挖联系人/邮箱）：对 Top N 家带 https 官网的候选做受控单页探测。
  // 复用 queueWebsiteProbe，自带 robots 合规检查、域名限流队列、首页 64KB 上限与去噪。
  // 总开关 AUTO_WEBSITE_PROBE_ENABLED=false 可关闭；WEBSITE_PROBE_ENABLED=false 时同样不生效。
  // 用 Promise.allSettled + 吞错，不阻塞搜客响应，也不影响其余候选。
  const autoProbeOn =
    process.env.WEBSITE_PROBE_ENABLED !== "false"
    && process.env.AUTO_WEBSITE_PROBE_ENABLED !== "false";
  if (autoProbeOn) {
    const autoProbeLimit = Math.max(1, Number(process.env.AUTO_WEBSITE_PROBE_LIMIT) || 5);
    const probeTargets = persistence.opportunities
      .filter((opp) => opp.website && /^https:\/\//i.test(opp.website))
      .slice(0, autoProbeLimit);
    // 不阻塞搜客响应：受控探测在后台进行，前端每 5s 轮询 website-opportunities 自动回填 contactInfo。
    // 单个探测有独立超时与 24h 缓存，失败不影响其余候选与本次搜索返回。
    void Promise.allSettled(
      probeTargets.map((opp) =>
        queueWebsiteProbe(store, opp, user.id, async (current) => {
          await persistCandidateChanges(store, [current], false);
        }).then(() => undefined).catch(() => undefined)
      )
    );
  }

  res.json({
    opportunities: persistence.opportunities,
    sourceStats,
    incrementalStats: persistence.incrementalStats,
    skipped,
    providersUsed: activeProviders.map((provider) => provider.id),
    runId
  });
}));

function websiteDomainKey(raw: string) {
  if (!raw) return "";
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
  }
}

app.post("/api/tools/website-scrape/preview", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    urls: z.array(z.string().min(3)).min(1).max(12),
    useAi: z.boolean().optional()
  });
  const body = schema.parse(req.body);
  if (body.useAi) {
    res.status(400).json({
      message: "官网链接登记不支持 AI 网页解析；系统只保存链接，不访问企业网页"
    });
    return;
  }
  const store = getStore();
  const parsed = body.urls.map((url, index) =>
    parseWebsiteOpportunity(url, index, req.user!)
  );
  await store.reloadProspectCandidates?.();
  const persistence = persistProviderOpportunities(parsed, {
    rawCount: parsed.length,
    deduplicatedCount: 0
  });
  await persistCandidateChanges(
    store,
    persistence.opportunities,
    true
  );
  res.json({
    opportunities: persistence.opportunities,
    incrementalStats: persistence.incrementalStats
  });
}));

app.post("/api/tools/website-scrape/sync-opportunities", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    requestId: z.string().trim().min(8).max(120),
    opportunities: z.array(z.object({
      id: z.string().min(1),
      company: z.string().min(1),
      business: z.string().default("待维护"),
      country: z.string().default("未知"),
      website: z.string().min(3),
      contact: z.string().default("待维护"),
      contactInfo: z.string().default(""),
      description: z.string().default(""),
      source: z.string().max(40).optional().default(""),
      sourceLabel: z.string().max(80).optional().default("")
    })).min(1).max(100)
  }).superRefine((value, context) => {
    const seen = new Set<string>();
    value.opportunities.forEach((item, index) => {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        return;
      }
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["opportunities", index, "id"],
        message: "同一批次不能重复提交相同候选"
      });
    });
  });
  const body = schema.parse(req.body);
  const store = getStore();
  await store.reloadProspectCandidates?.();
  await store.reloadProspectQualificationTeam?.(req.user!.teamId);
  if (!store.convertProspectToLead) {
    res.status(503).json({
      message: "候选转线索服务暂不可用",
      errorCode: "PROSPECT_LEAD_CONVERSION_UNAVAILABLE"
    });
    return;
  }
  type SyncResult = {
    lead: Lead;
    sourceEvent: LeadSourceEvent;
    opportunity: WebsiteOpportunity;
    duplicate: boolean;
  };
  const sources: Array<{
    source: typeof body.opportunities[number];
    stored: WebsiteOpportunity;
    approval: NonNullable<ReturnType<
      typeof currentApprovedProspectDecision
    >>;
  }> = [];
  const resultByCandidateId = new Map<string, SyncResult>();
  for (const source of body.opportunities) {
    const stored = store.websiteOpportunities.find((item) =>
      item.id === source.id
      && canSeeOwner(req.user!, item.ownerId, item.teamId)
    );
    if (!stored) {
      res.status(404).json({ message: "搜客线索不存在或无权访问" });
      return;
    }
    if (stored.ownerId !== req.user!.id) {
      res.status(403).json({ message: "候选归属其他业务员，请先分配后再加入线索" });
      return;
    }
    refreshProspectScorecard(store, stored);
    if (!stored.tenantProspectId || !stored.organizationId) {
      res.status(409).json({
        message: `${stored.company} 尚未完成正式企业身份归一`,
        errorCode: "CANDIDATE_FORMAL_IDENTITY_MISSING"
      });
      return;
    }
    if (!stored.scorecard?.vqa.qualified) {
      res.status(409).json({
        message: `${stored.company} 未通过 VQA：${
          stored.scorecard?.vqa.reasonCodes.join(", ") || "资格不完整"
        }`,
        errorCode: "PROSPECT_LEAD_CONVERSION_NOT_VQA"
      });
      return;
    }
    const approval = currentApprovedProspectDecision(store, stored);
    if (!approval) {
      res.status(409).json({
        message: `${stored.company} 没有当前有效的人工可联系批准记录`,
        errorCode: "PROSPECT_LEAD_CONVERSION_NOT_APPROVED"
      });
      return;
    }
    sources.push({ source, stored, approval });
  }
  const conversionRequestId = body.requestId;
  sources.sort((left, right) => {
    const leftConverted = left.stored.status === "synced"
      || Boolean(left.stored.leadId);
    const rightConverted = right.stored.status === "synced"
      || Boolean(right.stored.leadId);
    return Number(rightConverted) - Number(leftConverted);
  });
  try {
    for (const item of sources) {
      const result = await store.convertProspectToLead({
        operationCode: "convert_prospect_to_lead_v1",
        decisionId: item.approval.decision.id,
        mode: "create_new",
        existingLeadId: "",
        company: item.stored.company,
        contact: item.stored.contact,
        country: item.stored.country,
        intent: "中",
        estimatedAmount: 0,
        nextFollowAt: "",
        remark: [item.stored.business, item.stored.description]
          .filter(Boolean).join("；"),
        teamId: req.user!.teamId,
        ownerId: req.user!.id,
        prospectId: item.stored.tenantProspectId!,
        sourceEvidence: structuredClone(item.stored.sourceEvidence || []),
        idempotencyKey:
          `website-opportunity:${conversionRequestId}:${item.stored.id}`,
        convertedAt: new Date().toISOString()
      });
      Object.assign(item.stored, {
        status: "synced",
        leadId: result.lead.id,
        statusChangedAt: result.sourceEvent.occurredAt,
        excludedReason: ""
      });
      migrateProspectFollowUpTodos(
        store,
        item.stored,
        result.lead.id
      );
      linkProcurementContextToLead(
        store,
        item.stored,
        result.lead.id
      );
      resultByCandidateId.set(item.stored.id, {
        lead: result.lead,
        sourceEvent: result.sourceEvent,
        opportunity: item.stored,
        duplicate: result.replayed || !result.created
      });
    }
  } catch (error) {
    if (sendProspectLeadConversionError(res, error)) return;
    throw error;
  }
  if (sources.length) {
    await persistCandidateChanges(
      store,
      sources.map((item) => item.stored),
      true
    );
  }
  const created = body.opportunities.map((item) =>
    resultByCandidateId.get(item.id)
  ).filter(Boolean) as SyncResult[];
  res.json({ created });
}));

app.get("/api/dashboard/summary", requireAuth, (req, res) => {
  const store = getStore();
  const archived = archiveExpiredTodos(store.todos, new Date());
  if (archived.length) void store.persist();
  const { customers, todos, deals, reminders, knowledgeAssets, exams, wecomMessages, leads } = store;
  const scopedCustomers = customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  const scopedLeads = leads.filter((lead) => canSeeOwner(req.user!, lead.ownerId, lead.teamId));
  const activeLeads = scopedLeads.filter((lead) => !lead.deletedAt && lead.status !== "invalid");
  const filteredLeads = scopedLeads.filter((lead) => Boolean(lead.deletedAt) || lead.status === "invalid");
  const pendingCleanLeads = activeLeads.filter((lead) => lead.status === "new");
  const validLeads = activeLeads.filter((lead) => lead.status === "following" || lead.status === "converted");
  const customerLeads = activeLeads.filter((lead) => Boolean(lead.convertedCustomerId));
  const dealLeads = activeLeads.filter((lead) => Boolean(lead.convertedDealId));
  const chinaDateKey = (value: string | Date) => new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const todayKey = chinaDateKey(new Date());
  const todayLeadCount = activeLeads.filter((lead) => chinaDateKey(lead.createdAt) === todayKey).length;
  const leadFunnelCounts = [
    { key: "entered", label: "进入系统", count: activeLeads.length },
    { key: "pending", label: "待清洗", count: pendingCleanLeads.length },
    { key: "valid", label: "有效线索", count: validLeads.length },
    { key: "customer", label: "已转客户", count: customerLeads.length },
    { key: "deal", label: "已建商机", count: dealLeads.length }
  ];
  const scopedTodos = todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
  const scopedDeals = deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId) && !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单");
  const scopedReminders = reminders.filter((reminder) => canSeeOwner(req.user!, reminder.ownerId, reminder.teamId));
  const scopedKnowledge = knowledgeAssets.filter((asset) => canSeeKnowledgeAsset(req.user!, asset));
  const scopedMessages = wecomMessages.filter((message) => canSeeOwner(req.user!, message.ownerId, message.teamId));
  const scopedExams = exams.filter((exam) => canAccessExam(req.user!, exam));
  const scopedExamReport = examReport(req.user!);
  const addDateKeyDays = (dateKey: string, days: number) => {
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return date.toISOString().slice(0, 10);
  };
  const [todayYear, todayMonth] = todayKey.split("-").map(Number);
  const todayWeekday = new Date(`${todayKey}T12:00:00+08:00`).getUTCDay();
  const weekStartKey = addDateKeyDays(todayKey, -(todayWeekday === 0 ? 6 : todayWeekday - 1));
  const weekEndKey = addDateKeyDays(weekStartKey, 6);
  const monthStartKey = `${todayKey.slice(0, 7)}-01`;
  const monthEndKey = new Date(Date.UTC(todayYear, todayMonth, 0)).toISOString().slice(0, 10);
  const activeTodos = scopedTodos.filter((todo) => !isHistoricalTodo(todo));
  const pendingTodos = activeTodos.filter((todo) => !todo.done);
  const overdueTodos = pendingTodos.filter((todo) => todo.priority === "high");
  const historyTodos = scopedTodos.filter(isHistoricalTodo);
  const riskCustomers = scopedCustomers.filter((customer) => customer.nextReminder.includes("逾期") || customer.health < 60);
  const riskAmount = riskCustomers.reduce((sum, customer) => sum + customer.amount, 0);
  const forecastAmount = scopedDeals.reduce((sum, deal) => sum + deal.amount, 0);
  const wecomBound = scopedCustomers.filter((customer) => customer.wecomBound).length;
  const pendingKnowledge = scopedKnowledge.filter((asset) => asset.status !== "published");
  const publishedExams = scopedExams.filter((exam) => exam.status === "published");
  const averagePassRate = scopedExamReport.totalAttempts ? Math.round((scopedExamReport.passedAttempts / scopedExamReport.totalAttempts) * 100) : 0;
  const pendingMessages = scopedMessages.filter((message) => message.status === "pending");
  const readyDeals = scopedDeals.filter((deal) => ["已报价", "样品", "谈判"].includes(deal.stage));
  const topTodos = [...pendingTodos].sort((a, b) => (b.impactAmount || 0) - (a.impactAmount || 0) || priorityWeight(b.priority) - priorityWeight(a.priority)).slice(0, 3);
  const priorityTasks = buildPriorityTasks(scopedDeals, scopedCustomers, pendingTodos);
  const topDeals = priorityTasks.map((task) => task.deal);
  const pipelineHealth = buildPipelineHealth(scopedDeals, scopedCustomers);
  const todoDueDateKey = (dueAt: string) => {
    const value = dueAt.trim();
    const explicitDate = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (explicitDate) return explicitDate[1];
    if (value.includes("后天")) return addDateKeyDays(todayKey, 2);
    if (value.includes("明天")) return addDateKeyDays(todayKey, 1);
    if (value.includes("今天") || /^\d{1,2}:\d{2}$/.test(value)) return todayKey;
    const weekDay = value.match(/本周([一二三四五六日天])/);
    if (weekDay) {
      const dayIndex = "一二三四五六日天".indexOf(weekDay[1]);
      return addDateKeyDays(weekStartKey, Math.min(dayIndex, 6));
    }
    return "";
  };
  const periodMoneyText = (rows: Array<{ currency: string; amount: number }>) => rows.length
    ? rows.map((row) => `${row.currency} ${Math.round(row.amount).toLocaleString("en-US")}`).join("、")
    : "暂无预计成交金额";
  const buildPeriodSummary = (label: string, start: string, end: string) => {
    const expectedDeals = scopedDeals.filter((deal) => {
      if (!deal.expectedCloseAt) return false;
      const expectedDateKey = chinaDateKey(deal.expectedCloseAt);
      return expectedDateKey >= start && expectedDateKey <= end;
    });
    const periodTodos = pendingTodos.filter((todo) => {
      const dueDateKey = todoDueDateKey(todo.dueAt);
      return dueDateKey >= start && dueDateKey <= end;
    });
    const highPriorityTodos = periodTodos.filter((todo) => todo.priority === "high");
    const newLeads = activeLeads.filter((lead) => {
      const createdDateKey = chinaDateKey(lead.createdAt);
      return createdDateKey >= start && createdDateKey <= end;
    });
    const expectedAmounts = reportMoneyRows(expectedDeals);
    const topExpectedDeal = [...expectedDeals].sort((left, right) => right.amount - left.amount)[0];
    const title = highPriorityTodos.length
      ? `${label}最该优先处理 ${highPriorityTodos.length} 个高优先级待办，并跟进 ${expectedDeals.length} 个预计成交商机。`
      : expectedDeals.length
        ? `${label}有 ${expectedDeals.length} 个预计成交商机，建议围绕成交节点集中推进。`
        : `${label}暂无预计成交商机，建议优先补充线索、推进报价并校准成交日期。`;
    const description = topExpectedDeal
      ? `金额最高的是“${topExpectedDeal.title}”，预计成交金额为 ${topExpectedDeal.currency} ${Math.round(topExpectedDeal.amount).toLocaleString("en-US")}。`
      : newLeads.length
        ? `${label}新增 ${newLeads.length} 条线索，可优先完成清洗并转入客户或商机。`
        : `${label}暂未形成新的成交节点，建议检查活跃商机是否缺少预计成交日期。`;
    const action = highPriorityTodos.length
      ? `建议动作：先完成 ${highPriorityTodos.length} 个高优先级待办，再逐一确认预计成交商机的决策人、付款条件和下一步。`
      : expectedDeals.length
        ? `建议动作：逐一核对 ${expectedDeals.length} 个预计成交商机的关键人、报价反馈和下一步时间。`
        : `建议动作：清洗新增线索、推进有效报价，并为活跃商机补全预计成交日期。`;
    return {
      label,
      start,
      end,
      expectedDeals: expectedDeals.length,
      expectedAmounts,
      pendingTodos: periodTodos.length,
      highPriorityTodos: highPriorityTodos.length,
      newLeads: newLeads.length,
      briefing: {
        title,
        description,
        basis: `依据：${periodTodos.length} 个周期待办、${highPriorityTodos.length} 个高优先级待办、${newLeads.length} 条新增线索、${expectedDeals.length} 个预计成交商机。`,
        action,
        impact: expectedDeals.length
          ? `业务影响：${label}预计成交 ${periodMoneyText(expectedAmounts)}，应优先降低成交日期延误风险。`
          : `业务影响：${label}暂无预计成交金额，补齐商机日期和推进动作后才能形成可靠预测。`
      }
    };
  };
  const periods = {
    today: buildPeriodSummary("今日", todayKey, todayKey),
    week: buildPeriodSummary("本周", weekStartKey, weekEndKey),
    month: buildPeriodSummary("本月", monthStartKey, monthEndKey)
  };
  const typeRows = ["customer", "knowledge", "exam", "ocr", "other"].map((type) => {
    const items = pendingTodos.filter((todo) => todo.type === type);
    return {
      type,
      label: todoTypeLabel(type),
      count: items.length,
      risk: items.some((todo) => todo.priority === "high") ? "高" : items.some((todo) => todo.priority === "medium") ? "中" : "普通"
    };
  }).filter((row) => row.count > 0);
  const weekLoad = ["一", "二", "三", "四", "五", "六", "日"].map((day, index) => ({
    day,
    count: pendingTodos.filter((_, todoIndex) => todoIndex % 7 === index).length + (index < Math.min(pendingTodos.length, 7) ? 1 : 0)
  }));
  const topRiskNames = riskCustomers.slice(0, 3).map((customer) => customer.company).join("、") || topDeals.slice(0, 2).map((deal) => deal.title).join("、") || "暂无高风险客户";
  const businessScopeLabel = req.user?.role === "sales" ? "本人业务" : req.user?.role === "super_admin" ? "全局业务" : "本团队业务";
  res.json({
    scope: req.user?.role === "sales" ? "仅本人业务与本人待办" : req.user?.role === "super_admin" ? "全局业务数据，本人待办" : "本团队业务数据，本人待办",
    scopeLabels: {
      business: businessScopeLabel,
      todos: "本人待办"
    },
    updatedAt: new Date().toISOString(),
    periods,
    briefing: {
      title: pendingTodos.length
        ? `今天最该处理的是 ${pendingTodos.length} 个待办，其中 ${overdueTodos.length} 个属于高优先级。`
        : "今天暂无未完成待办，可以复盘客户资料和销售知识库。",
      description: riskCustomers.length
        ? `系统根据客户金额、健康度、阶段和提醒状态计算，建议优先处理 ${topRiskNames}。`
        : `当前客户风险较低，建议推进 ${topDeals[0]?.title || "高金额商机"} 并保持企微记录归档。`,
      basis: `依据：${pendingTodos.length} 个未完成待办、${riskCustomers.length} 个风险客户、${readyDeals.length} 个可推进商机、${pendingMessages.length} 条企微待归档。`,
      action: overdueTodos.length
        ? `建议动作：先处理 ${overdueTodos.length} 个高优先级待办，再跟进金额最高的商机。`
        : `建议动作：按今日节奏完成待办，并把可成交商机推进到下一阶段。`,
      impact: riskAmount
        ? `影响范围：${moneyText(riskAmount)} 风险金额，处理后可降低逾期和报价流失。`
        : `影响范围：${moneyText(readyDeals.reduce((sum, deal) => sum + deal.amount, 0))} 可推进金额，适合用于晨会安排。`,
      riskAmount,
      riskLabel: req.user?.role === "sales" ? "本人名下风险" : req.user?.role === "super_admin" ? "全局风险金额" : "团队风险金额",
      closableDeals: readyDeals.length,
      closableAmount: readyDeals.reduce((sum, deal) => sum + deal.amount, 0),
      unreadWecom: pendingMessages.length
    },
    metrics: {
      customers: scopedCustomers.length,
      riskCustomers: riskCustomers.length,
      todos: pendingTodos.length,
      overdueTodos: overdueTodos.length,
      forecastAmount,
      wecomBoundRate: scopedCustomers.length ? Math.round((wecomBound / scopedCustomers.length) * 100) : 0,
      pendingKnowledge: pendingKnowledge.length,
      examPassRate: averagePassRate,
      unfinishedExams: canManageTraining(req.user) ? scopedExams.filter((exam) => exam.status !== "published").length : scopedExams.filter((exam) => exam.status === "published" && !store.examAttempts.some((attempt) => attempt.examId === exam.id && attempt.userId === req.user!.id && attempt.passed)).length,
      customerCompleteness: scopedCustomers.length ? Math.round(scopedCustomers.reduce((sum, customer) => sum + (customer.contact ? 25 : 0) + (customer.country ? 25 : 0) + (customer.stage ? 25 : 0) + (customer.nextReminder ? 25 : 0), 0) / scopedCustomers.length) : 0
    },
    schedule: topTodos.map((todo) => ({
      time: todo.dueAt || "待定",
      title: todo.title,
      subtitle: todo.related || todoTypeLabel(todo.type),
      tone: todo.priority === "high" ? "red" : todo.priority === "medium" ? "amber" : "green"
    })),
    quality: {
      followHealth: scopedCustomers.length ? Math.round(scopedCustomers.reduce((sum, customer) => sum + customer.health, 0) / scopedCustomers.length) : 0,
      overdueRate: pendingTodos.length ? Math.round((overdueTodos.length / pendingTodos.length) * 100) : 0,
      avgResponseHours: Number((Math.max(1, pendingMessages.length + scopedReminders.filter((reminder) => reminder.enabled !== false).length) * 1.6).toFixed(1))
    },
    leadFunnel: {
      stages: leadFunnelCounts.map((stage, index) => ({
        ...stage,
        conversionRate: index === 0
          ? 100
          : leadFunnelCounts[0].count
            ? Math.round((stage.count / leadFunnelCounts[0].count) * 100)
            : 0
      })),
      todayAdded: todayLeadCount,
      filteredOut: filteredLeads.length,
      dealConversionRate: activeLeads.length ? Math.round((dealLeads.length / activeLeads.length) * 100) : 0
    },
    pipelineHealth,
    todoInsights: {
      total: pendingTodos.length,
      overdue: overdueTodos.length,
      completionRate: activeTodos.length ? Math.round((activeTodos.filter((todo) => todo.done).length / activeTodos.length) * 100) : 0,
      impactAmount: pendingTodos.reduce((sum, todo) => sum + (todo.impactAmount || 0), 0),
      typeRows,
      weekLoad,
      historyCount: historyTodos.length,
      historyAmount: historyTodos.reduce((sum, todo) => sum + (todo.impactAmount || 0), 0)
    },
    priorityTasks: priorityTasks.map(({ deal, customer, score, reason, action, tone }) => ({
      id: deal.id,
      customerId: customer?.id || deal.customerId,
      title: deal.title,
      subtitle: `${customer?.country || "未知国家"} · ${deal.stage} · ${moneyText(deal.amount)} · ${deal.nextAction}`,
      score,
      reason,
      action,
      tone,
      badge: customer?.nextReminder.includes("逾期") ? "逾期" : deal.stage
    }))
  });
});

app.post("/api/dashboard/priority-tasks/batch-process", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const scopedCustomers = store.customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  const scopedDeals = store.deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId) && !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单");
  const scopedTodos = store.todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
  const pendingTodos = scopedTodos.filter((todo) => !todo.done && !isHistoricalTodo(todo));
  const priorityTasks = buildPriorityTasks(scopedDeals, scopedCustomers, pendingTodos).slice(0, 3);
  const created: Todo[] = [];
  for (const task of priorityTasks) {
    const exists = store.todos.some((todo) => todo.ownerId === req.user!.id && !todo.done && todo.related === task.deal.title && todo.title.includes("跟进优先级"));
    if (exists) continue;
    const todo: Todo = {
      id: `t_priority_${task.deal.id}_${Date.now()}_${created.length}`,
      title: `跟进优先级：${task.action}`,
      type: "customer",
      priority: task.score >= 80 ? "high" : task.score >= 60 ? "medium" : "normal",
      dueAt: currentMinuteText(),
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      related: task.deal.title,
      done: false,
      impactAmount: task.deal.amount,
      createdAt: new Date().toISOString()
    };
    store.todos.unshift(todo);
    created.push(todo);
  }
  await store.persist();
  res.json({ created, processed: priorityTasks.length, skipped: priorityTasks.length - created.length });
}));

function isHistoricalTodo(todo: Todo) {
  return Boolean(todo.historyAt);
}

function shouldArchiveTodo(todo: Todo, now = new Date()) {
  if (todo.historyAt) return false;
  if (todo.reminderRuleId && !todo.done) return false;
  const parsed = parseDueDate(todo.dueAt, todo.createdAt);
  if (!parsed) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return parsed < today;
}

function archiveExpiredTodos(todos: Todo[], now = new Date()) {
  const archiveTime = now.toISOString();
  const archived = todos.filter((todo) => shouldArchiveTodo(todo, now));
  archived.forEach((todo) => {
    todo.historyAt = archiveTime;
    todo.status = "pending";
    todo.pinState = "";
  });
  return archived;
}

function parseDueDate(value: string, fallbackCreatedAt?: string) {
  const text = value.trim();
  const exact = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (exact) return new Date(Number(exact[1]), Number(exact[2]) - 1, Number(exact[3]));
  const now = fallbackCreatedAt ? new Date(fallbackCreatedAt) : new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (text.includes("昨天")) return new Date(today.getTime() - 86400000);
  if (text.includes("前天")) return new Date(today.getTime() - 86400000 * 2);
  if (!text) return today;
  if (text.includes("今天") || /^(\d{1,2}):(\d{2})$/.test(text)) return today;
  if (text.includes("明天")) return new Date(today.getTime() + 86400000);
  return fallbackCreatedAt ? today : null;
}

function scheduleMidnightTodoArchive() {
  const run = async () => {
    const store = getStore();
    const archived = archiveExpiredTodos(store.todos, new Date());
    if (archived.length) {
      await store.persist();
      console.log(`GoodJob CRM archived ${archived.length} todos into history`);
    }
    schedule();
  };
  const schedule = () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 3);
    const delay = Math.max(1000, next.getTime() - now.getTime());
    windowlessSetTimeout(() => void run(), delay);
  };
  schedule();
}

function windowlessSetTimeout(callback: () => void, delay: number) {
  setTimeout(callback, delay);
}

function priorityWeight(priority: string) {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function nextTodoSortOrder(todos: Todo[], ownerId: string) {
  const scoped = todos.filter((todo) => todo.ownerId === ownerId);
  return Math.min(0, ...scoped.map((todo) => typeof todo.sortOrder === "number" ? todo.sortOrder : 0)) - 1;
}

function buildPriorityTasks(deals: Deal[], customers: Customer[], todos: Todo[]) {
  const maxAmount = Math.max(...deals.map((deal) => deal.amount), 1);
  return deals
    .filter((deal) => !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单")
    .map((deal) => {
      const customer = customers.find((item) => item.id === deal.customerId);
      const amountScore = Math.round((deal.amount / maxAmount) * 35);
      const stageScore = stagePriorityScore(deal.stage);
      const riskScore = customer?.nextReminder.includes("逾期") ? 25 : (customer?.health ?? 100) < 60 ? 18 : 0;
      const todoScore = todos.some((todo) => todo.related.includes(customer?.company || deal.title) || todo.related.includes(deal.title)) ? 10 : 0;
      const score = Math.min(100, amountScore + stageScore + riskScore + todoScore);
      const reasons = [
        `金额权重 ${amountScore}`,
        `阶段权重 ${stageScore}`,
        riskScore ? `风险权重 ${riskScore}` : "风险权重 0",
        todoScore ? "已有待办推动" : "暂无关联待办"
      ];
      const action = nextPriorityAction(deal, customer);
      const tone = score >= 80 ? "red" : score >= 60 ? "amber" : "brand";
      return { deal, customer, score, reason: reasons.join(" · "), action, tone };
    })
    .sort((left, right) => right.score - left.score || right.deal.amount - left.deal.amount)
    .slice(0, 3);
}

function buildPipelineHealth(deals: Deal[], customers: Customer[]) {
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判"];
  const activeDeals = deals.filter((deal) => !deal.archivedAt && deal.stage !== "丢单" && deal.stage !== "成交");
  const maxCount = Math.max(...stages.map((stage) => activeDeals.filter((deal) => deal.stage === stage).length), 1);
  return stages.map((stage) => {
    const stageDeals = activeDeals.filter((deal) => deal.stage === stage);
    const amount = stageDeals.reduce((sum, deal) => sum + deal.amount, 0);
    const riskCount = stageDeals.filter((deal) => {
      const customer = customers.find((item) => item.id === deal.customerId);
      return Boolean(customer?.nextReminder.includes("逾期")) || (customer?.health ?? 100) < 60;
    }).length;
    return {
      stage,
      count: stageDeals.length,
      amount,
      riskCount,
      width: stageDeals.length ? Math.max(8, Math.round((stageDeals.length / maxCount) * 100)) : 0,
      tone: riskCount ? "amber" : "aqua"
    };
  });
}

function stagePriorityScore(stage: string) {
  const map: Record<string, number> = {
    谈判: 30,
    样品: 24,
    已报价: 20,
    已联系: 12,
    询盘: 8
  };
  return map[stage] || 6;
}

function nextPriorityAction(deal: Deal, customer?: Customer) {
  if (customer?.nextReminder.includes("逾期")) return `二次跟进 ${customer.company} 并确认 ${deal.nextAction}`;
  if ((customer?.health ?? 100) < 60) return `补齐 ${customer?.company || deal.title} 的风险资料并同步主管`;
  if (deal.stage === "谈判") return `确认 ${deal.title} 的价格、账期和成交条件`;
  if (deal.stage === "样品") return `确认 ${deal.title} 的样品反馈和复购时间`;
  if (deal.stage === "已报价") return `发送 ${deal.title} 的报价二次确认`;
  return `推进 ${deal.title} 的下一步：${deal.nextAction}`;
}

function reminderRuleTitle(ruleType = "quote_no_reply") {
  const map: Record<string, string> = {
    quote_no_reply: "报价阶段停滞提醒",
    sample_feedback: "样品阶段待确认",
    inactive_customer: "长期未联系提醒",
    high_value_revisit: "高价值客户复访",
    custom_due: "商机下一动作到期提醒"
  };
  return map[ruleType] || "自定义跟进提醒";
}

function reminderRuleText(rule: { ruleType?: string; targetStage?: string; days?: number; channel?: string; priority?: string }) {
  const days = rule.days ?? 3;
  const stage = rule.targetStage || "已报价";
  if (rule.ruleType === "sample_feedback") return `进入样品阶段 ${days} 天未更新时生成站内任务`;
  if (rule.ruleType === "inactive_customer") return `距离最后一次客户活动超过 ${days} 天时生成站内任务`;
  if (rule.ruleType === "high_value_revisit") return `高价值或低健康度客户超过 ${days} 天未活动时生成站内任务`;
  if (rule.ruleType === "custom_due") return `${stage}阶段商机下一动作到期后生成站内任务`;
  return `进入${stage}阶段 ${days} 天未更新时生成站内任务`;
}

function resolveReminderTargetOwner(user: SessionUser, requestedOwnerId?: string) {
  const store = getStore();
  const targetOwnerId = requestedOwnerId || user.id;
  if (targetOwnerId !== user.id) return "";
  const target = store.users.find((item) => item.id === targetOwnerId);
  if (!target || !canSeeOwner(user, target.id, target.teamId)) return "";
  return target.id;
}

function matchReminderRule(targetOwnerId: string, rule: { ruleType?: string; targetStage?: string; days?: number; priority?: string }) {
  const store = getStore();
  const scopedCustomers = store.customers.filter((customer) => customer.ownerId === targetOwnerId);
  const customerMap = new Map(scopedCustomers.map((customer) => [customer.id, customer]));
  const scopedDeals = store.deals.filter((deal) => deal.ownerId === targetOwnerId && customerMap.has(deal.customerId) && !deal.archivedAt);
  const stage = rule.targetStage || "已报价";
  const ruleType = rule.ruleType || "quote_no_reply";
  const days = rule.days ?? 3;
  const now = new Date();
  const result: Array<{ customer: Customer; deal?: Deal; dueAt: string; triggerKey: string }> = [];
  const addDealMatches = (deals: Deal[], dateValue: (deal: Deal) => string) => {
    deals.forEach((deal) => {
      const customer = customerMap.get(deal.customerId);
      const baseText = dateValue(deal);
      const base = new Date(baseText);
      if (!customer || !baseText || Number.isNaN(base.getTime())) return;
      const due = new Date(base.getTime() + days * 86400000);
      if (due > now) return;
      result.push({ customer, deal, dueAt: localMinuteText(due), triggerKey: `${deal.id}:${baseText}:${days}` });
    });
  };
  if (ruleType === "sample_feedback") {
    addDealMatches(scopedDeals.filter((deal) => deal.stage === "样品"), (deal) => deal.stageChangedAt);
    return result;
  }
  if (ruleType === "custom_due") {
    addDealMatches(scopedDeals.filter((deal) => deal.stage === stage && Boolean(deal.nextActionAt)), (deal) => deal.nextActionAt);
    return result;
  }
  if (ruleType === "quote_no_reply") {
    addDealMatches(scopedDeals.filter((deal) => deal.stage === "已报价" || deal.stage === stage), (deal) => deal.stageChangedAt);
    return result;
  }
  scopedCustomers.forEach((customer) => {
    if (ruleType === "high_value_revisit" && customer.amount < 30000 && customer.health >= 65) return;
    const activities = store.customerActivities
      .filter((activity) => activity.customerId === customer.id)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    const baseText = activities[0]?.createdAt;
    if (!baseText) return;
    const due = new Date(new Date(baseText).getTime() + days * 86400000);
    if (Number.isNaN(due.getTime()) || due > now) return;
    result.push({ customer, dueAt: localMinuteText(due), triggerKey: `${customer.id}:${baseText}:${days}` });
  });
  return result;
}

function todoTypeLabel(type: string) {
  const map: Record<string, string> = {
    customer: "客户跟进",
    knowledge: "资料维护",
    exam: "在线考试",
    ocr: "OCR 线索",
    other: "其它"
  };
  return map[type] || "其它";
}

function moneyText(value: number) {
  return `$${Math.round(value / 1000)}k`;
}

function currentMinuteText() {
  return localMinuteText(new Date());
}

function localMinuteText(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type AiUseCase = "leadFinder" | "websiteParse" | "scoring" | "emailDraft" | "exam";

function getAiConfigs(user: SessionUser) {
  return getStore().aiModelConfigs
    .filter((item) => item.ownerId === user.id)
    .sort((left, right) => Number(right.enabled) - Number(left.enabled) || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function configSupportsUseCase(config: AiModelConfig, useCase?: AiUseCase) {
  if (!useCase) return true;
  const map: Record<AiUseCase, keyof AiModelConfig> = {
    leadFinder: "useLeadFinder",
    websiteParse: "useWebsiteParse",
    scoring: "useScoring",
    emailDraft: "useEmailDraft",
    exam: "useExam"
  };
  return Boolean(config[map[useCase]]);
}

function getAiConfig(user: SessionUser, useCase?: AiUseCase) {
  const configs = getAiConfigs(user);
  return configs.find((item) => item.enabled && item.apiKey && configSupportsUseCase(item, useCase))
    || configs.find((item) => configSupportsUseCase(item, useCase))
    || configs[0]
    || null;
}

function publicAiConfig(config: AiModelConfig) {
  return {
    id: config.id,
    provider: config.provider,
    protocol: config.protocol || "openai-compatible",
    name: config.name,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey ? `****${config.apiKey.slice(-4)}` : "",
    hasApiKey: Boolean(config.apiKey),
    enabled: config.enabled,
    temperature: config.temperature ?? 0.1,
    useLeadFinder: config.useLeadFinder ?? true,
    useWebsiteParse: config.useWebsiteParse ?? true,
    useScoring: config.useScoring ?? true,
    useEmailDraft: config.useEmailDraft ?? true,
    useExam: config.useExam ?? false,
    lastTestAt: config.lastTestAt || "",
    lastTestStatus: config.lastTestStatus || "untested",
    lastTestMessage: config.lastTestMessage || "",
    ownerId: config.ownerId,
    teamId: config.teamId,
    updatedAt: config.updatedAt
  };
}

async function testAiConfig(config: AiModelConfig) {
  try {
    const content = await callAiModel(config, "只返回 JSON：{\"ok\":true}", 1200);
    const ok = /ok|true/i.test(content);
    return {
      ok,
      message: ok ? `${providerLabel(config.provider)} 连接测试通过` : "模型已响应，但返回内容不符合测试格式"
    };
  } catch (error) {
    const failure = providerErrorFromUnknown(error, "search");
    return {
      ok: false,
      message: `AI 连接失败：${failure.publicMessage}`
    };
  }
}

function providerLabel(provider: string) {
  const labels: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Claude",
    gemini: "Gemini",
    deepseek: "DeepSeek",
    qwen: "通义千问",
    moonshot: "Kimi",
    zhipu: "智谱GLM",
    baidu: "百度千帆",
    volcengine: "豆包",
    mistral: "Mistral",
    groq: "Groq",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    custom: "自定义模型"
  };
  return labels[provider] || provider || "AI模型";
}

function normalizeWebsite(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function parseWebsiteOpportunity(
  rawUrl: string,
  index: number,
  user: SessionUser
): WebsiteOpportunity {
  const website = normalizeWebsiteReference(rawUrl);
  const createdAt = new Date().toISOString();
  return withProspectVerificationReport({
    id: `web_${Date.now()}_${index}`,
    company: companyNameFromWebsiteReference(website),
    business: "待人工核实",
    country: "待人工核实",
    website,
    contact: "待人工核实",
    contactInfo: "",
    description: "仅登记链接，系统未访问网页。",
    ownerId: user.id,
    teamId: user.teamId,
    status: "preview",
    createdAt,
    parseMode: "reference",
    source: "website-reference",
    sourceLabel: "官网链接登记",
    sourceEvidence: []
  }, createdAt);
}

const reportStageWeights: Record<string, number> = {
  询盘: 0.05,
  已联系: 0.1,
  已报价: 0.3,
  样品: 0.5,
  谈判: 0.7
};

function reportDate(value: Date) {
  const pad = (item: number) => String(item).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function reportMoneyRows(deals: Deal[], amountFor: (deal: Deal) => number = (deal) => deal.amount) {
  const totals = new Map<string, number>();
  deals.forEach((deal) => {
    const currency = deal.currency || "未设置";
    totals.set(currency, roundMoneyValue((totals.get(currency) || 0) + amountFor(deal)));
  });
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((left, right) => right.amount - left.amount || left.currency.localeCompare(right.currency));
}

function reportRegion(country: string) {
  const value = country.toLowerCase();
  if (["瑞典", "德国", "法国", "英国", "意大利", "西班牙", "荷兰", "波兰", "欧洲", "sweden", "germany", "france", "united kingdom", "italy", "spain", "netherlands", "poland"].some((item) => value.includes(item))) return "欧洲";
  if (["美国", "加拿大", "墨西哥", "usa", "united states", "canada", "mexico"].some((item) => value.includes(item))) return "北美";
  if (["阿联酋", "沙特", "卡塔尔", "科威特", "以色列", "土耳其", "中东", "uae", "saudi", "qatar", "kuwait", "israel", "turkey"].some((item) => value.includes(item))) return "中东";
  if (["中国", "日本", "韩国", "新加坡", "印度", "泰国", "越南", "马来西亚", "亚洲", "china", "japan", "korea", "singapore", "india", "thailand", "vietnam", "malaysia"].some((item) => value.includes(item))) return "亚洲";
  return "其他";
}

app.get("/api/reports/executive", requireAuth, (req, res) => {
  const store = getStore();
  const reportOwner = store.users.find((user) => user.id === req.user!.id);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const periodStart = reportDate(monthStart);
  const periodEnd = reportDate(monthEnd);
  const asOfDate = reportDate(now);
  const scopedCustomers = store.customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  const scopedCustomerIds = new Set(scopedCustomers.map((customer) => customer.id));
  const scopedDeals = store.deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId) && scopedCustomerIds.has(deal.customerId));
  const activeDeals = scopedDeals.filter((deal) => !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单");
  const periodClosedDeals = scopedDeals.filter((deal) => {
    if (deal.stage !== "成交" && deal.stage !== "丢单") return false;
    const closedDate = (deal.closedAt || deal.stageChangedAt || "").slice(0, 10);
    return closedDate >= periodStart && closedDate <= asOfDate;
  });
  const wonDeals = periodClosedDeals.filter((deal) => deal.stage === "成交");
  const lostDeals = periodClosedDeals.filter((deal) => deal.stage === "丢单");
  const expectedThisMonth = activeDeals.filter((deal) => deal.expectedCloseAt >= periodStart && deal.expectedCloseAt <= periodEnd);
  const customerMap = new Map(scopedCustomers.map((customer) => [customer.id, customer]));
  const userMap = new Map(store.users.map((user) => [user.id, user]));
  const riskRows = activeDeals.map((deal) => {
    const customer = customerMap.get(deal.customerId);
    const reasons = [
      customer?.nextReminder.includes("逾期") ? "跟进已逾期" : "",
      (customer?.health ?? 100) < 60 ? "客户健康度偏低" : "",
      deal.expectedCloseAt && deal.expectedCloseAt < asOfDate ? "预计成交日已过" : "",
      !deal.nextAction.trim() ? "缺少下一动作" : "",
      !deal.nextActionAt.trim() ? "缺少动作日期" : ""
    ].filter(Boolean);
    return reasons.length ? {
      id: deal.id,
      customerId: deal.customerId,
      title: deal.title,
      customer: customer?.company || "客户待确认",
      owner: userMap.get(deal.ownerId)?.name || deal.ownerId,
      stage: deal.stage,
      amount: deal.amount,
      currency: deal.currency,
      riskReasons: reasons,
      nextAction: deal.nextAction,
      expectedCloseAt: deal.expectedCloseAt
    } : null;
  }).filter((row): row is NonNullable<typeof row> => Boolean(row));
  const riskDealIds = new Set(riskRows.map((row) => row.id));
  const riskDeals = activeDeals.filter((deal) => riskDealIds.has(deal.id));
  const stageRows = ["询盘", "已联系", "已报价", "样品", "谈判"].map((stage) => {
    const deals = activeDeals.filter((deal) => deal.stage === stage);
    return {
      stage,
      count: deals.length,
      amounts: reportMoneyRows(deals),
      riskCount: deals.filter((deal) => riskDealIds.has(deal.id)).length,
      weight: reportStageWeights[stage] || 0
    };
  });
  const maxStageCount = Math.max(...stageRows.map((row) => row.count), 1);
  const funnel = [
    ...stageRows.map((row) => ({ ...row, width: row.count ? Math.max(8, Math.round((row.count / maxStageCount) * 100)) : 0 })),
    {
      stage: "本月成交",
      count: wonDeals.length,
      amounts: reportMoneyRows(wonDeals),
      riskCount: 0,
      weight: 1,
      width: wonDeals.length ? Math.max(8, Math.round((wonDeals.length / maxStageCount) * 100)) : 0
    }
  ];
  const marketGroups = new Map<string, Deal[]>();
  activeDeals.forEach((deal) => {
    const region = reportRegion(customerMap.get(deal.customerId)?.country || "其他");
    marketGroups.set(region, [...(marketGroups.get(region) || []), deal]);
  });
  const market = [...marketGroups.entries()]
    .map(([region, deals]) => ({
      region,
      count: deals.length,
      share: activeDeals.length ? Math.round((deals.length / activeDeals.length) * 100) : 0,
      amounts: reportMoneyRows(deals),
      riskCount: deals.filter((deal) => riskDealIds.has(deal.id)).length
    }))
    .sort((left, right) => right.count - left.count || left.region.localeCompare(right.region));
  const visibleOwnerIds = new Set([...scopedCustomers.map((customer) => customer.ownerId), ...scopedDeals.map((deal) => deal.ownerId)]);
  const performance = [...visibleOwnerIds].map((ownerId) => {
    const ownerCustomers = scopedCustomers.filter((customer) => customer.ownerId === ownerId);
    const ownerCustomerIds = new Set(ownerCustomers.map((customer) => customer.id));
    const ownerActiveDeals = activeDeals.filter((deal) => deal.ownerId === ownerId);
    const ownerRiskDeals = ownerActiveDeals.filter((deal) => riskDealIds.has(deal.id));
    const followUps = store.customerActivities.filter((activity) => ownerCustomerIds.has(activity.customerId) && activity.createdAt.slice(0, 10) >= periodStart && activity.createdAt.slice(0, 10) <= asOfDate);
    return {
      ownerId,
      owner: userMap.get(ownerId)?.name || ownerId,
      customerCount: ownerCustomers.length,
      followUpCount: followUps.length,
      activeDealCount: ownerActiveDeals.length,
      forecastAmounts: reportMoneyRows(ownerActiveDeals, (deal) => deal.amount * (reportStageWeights[deal.stage] || 0)),
      riskCount: ownerRiskDeals.length,
      riskLabel: ownerRiskDeals.length ? `${ownerRiskDeals.length} 个风险商机` : "当前健康"
    };
  }).sort((left, right) => right.activeDealCount - left.activeDealCount || right.followUpCount - left.followUpCount);
  const busiestStage = [...stageRows].sort((left, right) => right.count - left.count)[0];
  const topMarket = market[0];
  const winRate = periodClosedDeals.length ? Math.round((wonDeals.length / periodClosedDeals.length) * 100) : null;
  const scopeLabel = req.user!.role === "sales" ? "本人业务" : req.user!.role === "manager" ? "本团队业务" : "全公司业务";
  const currencySet = new Set(activeDeals.map((deal) => deal.currency || "未设置"));
  const dataStatus = activeDeals.length || periodClosedDeals.length ? "实时数据" : "数据不足";
  const conclusions = [
    {
      title: expectedThisMonth.length ? `本月有 ${expectedThisMonth.length} 个商机预计成交` : "本月暂无明确预计成交商机",
      detail: expectedThisMonth.length ? "预测基于商机预计成交日期，并按原币分别展示。" : "建议补齐商机预计成交日期，避免预测遗漏。"
    },
    {
      title: riskRows.length ? `${riskRows.length} 个风险商机需要处理` : "当前未识别到风险商机",
      detail: riskRows.length ? riskRows.slice(0, 2).map((row) => `${row.customer}：${row.riskReasons.join("、")}`).join("；") : "风险规则包含逾期、低健康度、预计成交日已过和动作缺失。"
    },
    {
      title: busiestStage?.count ? `${busiestStage.stage}阶段商机最多` : "当前漏斗暂无活跃商机",
      detail: busiestStage?.count ? `${busiestStage.count} 个商机处于该阶段，建议优先检查停留时间和下一动作。` : "新增或同步商机后，系统将自动生成漏斗快照。"
    },
    {
      title: winRate === null ? "本月暂无可计算的赢单率" : `本月商机赢单率 ${winRate}%`,
      detail: winRate === null ? "赢单率仅按本月已关闭的成交与丢单商机计算。" : `${wonDeals.length} 个成交，${lostDeals.length} 个丢单，分母为本月已关闭商机。`
    }
  ];
  const actions = riskRows.length
    ? riskRows.slice(0, 3).map((row) => ({
        dealId: row.id,
        customerId: row.customerId,
        title: `${row.customer} · ${row.stage}`,
        detail: `${row.riskReasons.join("、")}；下一动作：${row.nextAction || "待补充"}`
      }))
    : expectedThisMonth.slice(0, 3).map((deal) => ({
        dealId: deal.id,
        customerId: deal.customerId,
        title: `${customerMap.get(deal.customerId)?.company || deal.title} · ${deal.stage}`,
        detail: `预计 ${deal.expectedCloseAt} 成交；下一动作：${deal.nextAction || "待补充"}`
      }));
  res.json({
    title: "外贸销售实时经营快照",
    scope: {
      key: req.user!.role === "sales" ? "self" : req.user!.role === "manager" ? "team" : "global",
      label: scopeLabel
    },
    period: {
      label: `${now.getFullYear()} 年 ${now.getMonth() + 1} 月（截至 ${asOfDate}）`,
      start: periodStart,
      end: asOfDate,
      forecastEnd: periodEnd,
      asOf: now.toISOString(),
      timezone: "服务器本地时区"
    },
    amountBasis: {
      label: currencySet.size > 1 ? "多币种原币分列，不跨币种合计" : `${[...currencySet][0] || "无金额"} 原币口径`,
      currencies: [...currencySet].sort(),
      exchangeRateApplied: false
    },
    dataStatus,
    headline: expectedThisMonth.length
      ? `本月共有 ${expectedThisMonth.length} 个商机进入预计成交窗口，当前识别 ${riskRows.length} 个风险商机。`
      : `当前有 ${activeDeals.length} 个活跃商机，本月尚无商机进入明确预计成交窗口。`,
    note: "活跃漏斗为当前快照；本月成交、丢单和跟进按自然月统计；预计成交按预计成交日期判断。",
    reportNote: reportOwner?.reportNote || "",
    metrics: {
      activeDealCount: activeDeals.length,
      activePipeline: reportMoneyRows(activeDeals),
      weightedForecast: reportMoneyRows(activeDeals, (deal) => deal.amount * (reportStageWeights[deal.stage] || 0)),
      expectedThisMonth: reportMoneyRows(expectedThisMonth),
      wonThisMonth: reportMoneyRows(wonDeals),
      riskAmounts: reportMoneyRows(riskDeals),
      riskDealCount: riskRows.length,
      winRate,
      closedCount: periodClosedDeals.length
    },
    conclusions,
    funnel,
    market,
    forecastByStage: stageRows.map((row) => ({
      stage: row.stage,
      count: row.count,
      weight: row.weight,
      weightedAmounts: reportMoneyRows(activeDeals.filter((deal) => deal.stage === row.stage), (deal) => deal.amount * row.weight)
    })),
    performanceTitle: req.user!.role === "sales" ? "个人经营效率" : "成员经营对比",
    performance,
    riskRows,
    actions,
    definitions: [
      "活跃管道：未成交、未丢单且未归档的当前商机。",
      "阶段加权预测：询盘 5%、已联系 10%、已报价 30%、样品 50%、谈判 70%。",
      "本月赢单率：本月成交数 ÷ 本月已关闭商机数。",
      "风险商机：跟进逾期、客户健康度低于 60、预计成交日已过或下一动作信息缺失。",
      "金额未应用汇率，所有金额按原币分别展示。"
    ]
  });
});

app.patch("/api/reports/executive/note", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    note: z.string().max(1000).default("")
  }).parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  user.reportNote = body.note.trim();
  await store.persist();
  res.json({ note: user.reportNote });
}));

registerSwagger(app);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof MysqlDataImportError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ message: "参数格式错误", issues: error.issues });
    return;
  }
  if (typeof error === "object" && error && "type" in error && error.type === "entity.too.large") {
    res.status(413).json({ message: "请求内容过大" });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ message: "JSON 格式不正确" });
    return;
  }
  if (process.env.NODE_ENV !== "test") console.error(error);
  res.status(500).json({ message: "服务器处理请求失败" });
});

async function startServer() {
  const mysqlRequested = process.env.CRM_STORE === "mysql"
    || (process.env.CRM_STORE !== "memory" && Boolean(process.env.DATABASE_URL || process.env.MYSQL_URL));
  let host = "127.0.0.1";
  try {
    validateAuthSecurity();
    validateProviderCredentialSecurity();
    validateAgentJobSecurity();
    validateTradeObservationCursorSecurity();
    validateMarketOpportunityCursorSecurity();
    validateProspectRunSecurity();
    host = resolveBackendHost();
    if (process.env.NODE_ENV === "production" && !mysqlRequested) {
      throw new Error("生产环境必须配置 MySQL 持久化，禁止使用内存存储");
    }
  } catch (error) {
    console.error(`GoodJob CRM security validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }
  const port = Number(process.env.PORT || 4188);
  if (mysqlRequested) {
    try {
      const store = await createMysqlStore({ processRole: "api" });
      setStore(store);
      console.log("GoodJob CRM using MySQL persistence");
    } catch (error) {
      console.error(`GoodJob CRM MySQL unavailable, startup aborted: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
  const store = getStore();
  const agentBackgroundRunner = new AgentBackgroundRunner(
    store,
    agentExecutionRuntime,
    Number(process.env.AGENT_RUNNER_POLL_MS || 1_000)
  );
  try {
    await agentBackgroundRunner.start();
    activeAgentBackgroundRunner = agentBackgroundRunner;
  } catch (error) {
    console.error(`GoodJob CRM Agent runner startup failed: ${error instanceof Error ? error.message : String(error)}`);
    await store.close?.();
    process.exit(1);
    return;
  }
  const prospectQueueRequired =
    process.env.PROSPECT_QUEUE_REQUIRED === "true";
  const prospectWorkerService =
    process.env.PROSPECT_WORKER_ENABLED === "false"
    ? null
    : new ProspectWorkerService({ store });
  if (!prospectWorkerService && prospectQueueRequired) {
    console.error(
      "GoodJob CRM prospect queue startup failed: "
      + "启用强制队列时不能关闭 PROSPECT_WORKER_ENABLED"
    );
    activeAgentBackgroundRunner = null;
    await agentBackgroundRunner.stop();
    await store.close?.();
    process.exit(1);
    return;
  }
  try {
    await prospectWorkerService?.start();
    activeProspectWorkerService = prospectWorkerService;
  } catch (error) {
    console.error(`GoodJob CRM prospect worker startup failed: ${error instanceof Error ? error.message : String(error)}`);
    activeAgentBackgroundRunner = null;
    await agentBackgroundRunner.stop();
    await store.close?.();
    process.exit(1);
    return;
  }
  const prospectScheduler = process.env.PROSPECT_SCHEDULER_ENABLED === "false"
    ? null
    : new ProspectScheduler({
        store,
        pollMs: Number(process.env.PROSPECT_SCHEDULER_POLL_MS || 15_000),
        onRunCreated: () => prospectWorkerService?.synchronize()
      });
  try {
    await prospectScheduler?.start();
  } catch (error) {
    activeProspectWorkerService = null;
    await prospectWorkerService?.stop();
    activeAgentBackgroundRunner = null;
    await agentBackgroundRunner.stop();
    await store.close?.();
    console.error(`GoodJob CRM prospect scheduler startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }
  const superSearchRunner = new ProspectSuperSearchRunner(store, {
    pollMs: Number(process.env.PROSPECT_SUPER_SEARCH_POLL_MS || 5_000),
    onRunCreated: () => prospectWorkerService?.synchronize()
  });
  try {
    await superSearchRunner.start();
  } catch (error) {
    await prospectScheduler?.stop();
    activeProspectWorkerService = null;
    await prospectWorkerService?.stop();
    activeAgentBackgroundRunner = null;
    await agentBackgroundRunner.stop();
    await store.close?.();
    console.error(`GoodJob CRM super search runner startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }
  const outreachSequenceRunner = new OutreachSequenceRunner(store, {
    async send(sequence, step: OutreachSequenceStepSnapshot, executionId) {
      const owner = store.users.find((item) => item.id === sequence.ownerId && item.status === "active");
      if (!owner) throw new Error("触达序列所属账号不存在或已停用");
      const input = sequence.channel === "email"
        ? { entityType: sequence.entityType, entityId: sequence.entityId, subject: step.subject, body: step.body, nextFollowAt: sequence.steps.find((item) => item.status === "pending" && item.index > step.index)?.scheduledAt || "" }
        : { customerId: sequence.entityId, body: step.body, accountId: sequence.accountId, nextReminder: sequence.steps.find((item) => item.status === "pending" && item.index > step.index)?.scheduledAt || "" };
      const result = sequence.channel === "email"
        ? await agentExecutionRuntime.sendDevelopmentEmail!(owner, input, executionId)
        : await agentExecutionRuntime.sendWhatsApp!(owner, input, executionId);
      if (typeof result.accountId === "string" && result.accountId) sequence.accountId = result.accountId;
      return result;
    },
    stopReason: agentOutreachSequenceStopReason
  }, Number(process.env.OUTREACH_SEQUENCE_POLL_MS || 5_000));
  try {
    await outreachSequenceRunner.start();
    activeOutreachSequenceRunner = outreachSequenceRunner;
  } catch (error) {
    superSearchRunner.stop();
    await prospectScheduler?.stop();
    activeProspectWorkerService = null;
    await prospectWorkerService?.stop();
    activeAgentBackgroundRunner = null;
    await agentBackgroundRunner.stop();
    await store.close?.();
    console.error(`GoodJob CRM outreach sequence runner startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }
  const customerMaintenanceRunner = new CustomerMaintenanceRunner(
    store,
    Number(process.env.CUSTOMER_MAINTENANCE_POLL_MS || 30_000)
  );
  try {
    await customerMaintenanceRunner.start();
    activeCustomerMaintenanceRunner = customerMaintenanceRunner;
  } catch (error) {
    activeOutreachSequenceRunner = null;
    await outreachSequenceRunner.stop();
    superSearchRunner.stop();
    await prospectScheduler?.stop();
    activeProspectWorkerService = null;
    await prospectWorkerService?.stop();
    activeAgentBackgroundRunner = null;
    await agentBackgroundRunner.stop();
    await store.close?.();
    console.error(`GoodJob CRM customer maintenance runner startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }
  const agentTriggerRunner = new AgentTriggerRunner(
    store,
    (actor, goal, context) => createAgentPlan(store, actor, goal, context),
    Number(process.env.AGENT_TRIGGER_POLL_MS || 60_000)
  );
  try {
    await agentTriggerRunner.start();
    activeAgentTriggerRunner = agentTriggerRunner;
  } catch (error) {
    activeCustomerMaintenanceRunner = null;
    await customerMaintenanceRunner.stop();
    activeOutreachSequenceRunner = null;
    await outreachSequenceRunner.stop();
    superSearchRunner.stop();
    await prospectScheduler?.stop();
    activeProspectWorkerService = null;
    await prospectWorkerService?.stop();
    activeAgentBackgroundRunner = null;
    await agentBackgroundRunner.stop();
    await store.close?.();
    console.error(`GoodJob CRM Agent trigger runner startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }
  const salesTrainingRunner = new SalesTrainingRunner(store, Number(process.env.SALES_TRAINING_POLL_MS || 1_200));
  try {
    await salesTrainingRunner.start();
    activeSalesTrainingRunner = salesTrainingRunner;
  } catch (error) {
    activeAgentTriggerRunner = null;
    await agentTriggerRunner.stop();
    activeCustomerMaintenanceRunner = null;
    await customerMaintenanceRunner.stop();
    activeOutreachSequenceRunner = null;
    await outreachSequenceRunner.stop();
    superSearchRunner.stop();
    await prospectScheduler?.stop();
    activeProspectWorkerService = null;
    await prospectWorkerService?.stop();
    activeAgentBackgroundRunner = null;
    await agentBackgroundRunner.stop();
    await store.close?.();
    console.error(`GoodJob CRM sales training runner startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }
  const httpServer = app.listen(port, host, () => {
    console.log(`GoodJob CRM API listening on http://${host}:${port}`);
  });
  scheduleMidnightTodoArchive();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`GoodJob CRM received ${signal}, shutting down`);
    try {
      activeSalesTrainingRunner = null;
      salesTrainingRunner.stop();
      activeAgentTriggerRunner = null;
      await agentTriggerRunner.stop();
      activeCustomerMaintenanceRunner = null;
      await customerMaintenanceRunner.stop();
      activeOutreachSequenceRunner = null;
      await outreachSequenceRunner.stop();
      superSearchRunner.stop();
      await prospectScheduler?.stop();
      activeProspectWorkerService = null;
      await prospectWorkerService?.stop();
      activeAgentBackgroundRunner = null;
      await agentBackgroundRunner.stop();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await store.close?.();
      process.exit(0);
    } catch (error) {
      console.error(`GoodJob CRM shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

if (process.env.NODE_ENV !== "test") {
  void startServer();
}
