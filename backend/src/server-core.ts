/**
 * GoodJob CRM API 共享内核：应用实例、全局中间件与权限闸、跨模块共享的辅助函数与运行时状态。
 * 各业务路由在 routes/*.ts，由 server.ts 按原顺序注册。
 */
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import httpProxy from "http-proxy";
import "node:crypto"; // 保持模块加载顺序与拆分前一致
import { createHash, randomUUID } from "node:crypto";
import "node:fs/promises"; // 保持模块加载顺序与拆分前一致
import { existsSync } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import "qrcode"; // 保持模块加载顺序与拆分前一致
import { z } from "zod";
import "./advanced-document-templates.js"; // 保持模块加载顺序与拆分前一致
import "./excel-preview.js"; // 保持模块加载顺序与拆分前一致
import "./trade-document-import.js"; // 保持模块加载顺序与拆分前一致
import "./trade-document-recognition-template.js"; // 保持模块加载顺序与拆分前一致
import "node:events"; // 保持模块加载顺序与拆分前一致
import { resolveTxt } from "node:dns/promises";
import "./auth.js"; // 保持模块加载顺序与拆分前一致
import { canSeeOwner, hasIamPermission, isPlatformIdentity, publicUser, requireAuth, signToken, userExpired, validateAuthSecurity } from "./auth.js";
import "./access-control-overview.js"; // 保持模块加载顺序与拆分前一致
import "./ai-http-security.js"; // 保持模块加载顺序与拆分前一致
import {
  recognizeBusinessCard,
  type BusinessCardRecognition
} from "./business-card-ocr.js";
import "./trade-document-ocr.js"; // 保持模块加载顺序与拆分前一致
import { type TradeDocumentOcrProviderConfig } from "./trade-document-ocr.js";
import "./tracking-provider.js"; // 保持模块加载顺序与拆分前一致
import {
  callAiModel,
  callAiModelWithWebSearch,
  extractJsonObject
} from "./ai-model-runtime.js";
import "./customer-intake-parse.js"; // 保持模块加载顺序与拆分前一致
import "./whatsapp-followup-sync.js"; // 保持模块加载顺序与拆分前一致
import "./office-document-text.js"; // 保持模块加载顺序与拆分前一致
import {
  aiLeadFinderReadiness,
  aiWebSearchPolicy,
  webSearchFailureSuggestion
} from "./ai-web-search-policy.js";
import {
  extractWebsitePublicContactsWithAi,
  type WebsiteContactAiExtractor
} from "./website-contact-ai.js";
import "./ai-search-provider.js"; // 保持模块加载顺序与拆分前一致
import { aiSearchTimeoutMs } from "./ai-search-provider.js";
import { aiWebsiteCitationsToProviderRecords } from "./prospect-ai-website-discovery.js";
import "./agent-goal.js"; // 保持模块加载顺序与拆分前一致
import "./agent-turn-decision.js"; // 保持模块加载顺序与拆分前一致
import { validateAgentJobSecurity } from "./agent-job-security.js";
import "./agent-jobs.js"; // 保持模块加载顺序与拆分前一致
import "./ai-agent.js"; // 保持模块加载顺序与拆分前一致
import { AgentBackgroundRunner, type AgentExecutionRuntime, createAgentPlan } from "./ai-agent.js";
import "./agent-memory.js"; // 保持模块加载顺序与拆分前一致
import "./agent-knowledge.js"; // 保持模块加载顺序与拆分前一致
import "./resource-hub.js"; // 保持模块加载顺序与拆分前一致
import { getResourceHubRepository, knowledgeAssetTeamId, RESOURCE_RETENTION_DAYS, type ResourceEventInput } from "./resource-hub.js";
import "./knowledge-governance.js"; // 保持模块加载顺序与拆分前一致
import "./agent-triggers.js"; // 保持模块加载顺序与拆分前一致
import { AgentTriggerRunner } from "./agent-triggers.js";
import "./agent-model-governance.js"; // 保持模块加载顺序与拆分前一致
import "./agent-skills.js"; // 保持模块加载顺序与拆分前一致
import {
  agentApiOperationContract,
  assertAgentCompletionEvidence,
  assertAgentOperationInput,
  type AgentOperationContract
} from "./agent-api-contracts.js";
import "./sales-distillation.js"; // 保持模块加载顺序与拆分前一致
import "./sales-training.js"; // 保持模块加载顺序与拆分前一致
import { SalesTrainingRunner } from "./sales-training.js";
import {
  OutreachSequenceRunner,
  controlOutreachSequence,
  createOutreachSequence,
  listOutreachSequences
} from "./outreach-sequences.js";
import "./prospect-outreach-batch.js"; // 保持模块加载顺序与拆分前一致
import { type OutreachWritingRuntime, type OutreachWritingTarget, ProspectOutreachBatchRunner, type ProspectOutreachBatchRuntime, toBatchSteps, writingTargetForItem } from "./prospect-outreach-batch.js";
import "./prospect-outreach-plan.js"; // 保持模块加载顺序与拆分前一致
import { ProspectOutreachPlanRunner } from "./prospect-outreach-plan.js";
import "./outreach-journey.js"; // 保持模块加载顺序与拆分前一致
import { buildOutreachJourney, getBackgroundResearchRepository, type OutreachJourneyEntityType } from "./outreach-journey.js";
import "./development-email-skill.js"; // 保持模块加载顺序与拆分前一致
import { assembleDevelopmentEmailBrief, buildDevelopmentEmailFallback, buildDevelopmentEmailPrompt, checkDevelopmentEmailDraft, type DevelopmentEmailBrief, developmentEmailSignature, ensureDevelopmentEmailSignature, finalizePersonalization } from "./development-email-skill.js";
import {
  buildStageAwareSequence,
  OUTREACH_SEQUENCE_DEFAULT_STEPS,
  type OutreachWritingRecipient,
  type OutreachWritingResearch,
  type OutreachWritingSender
} from "./outreach-email-sequencer.js";
import "./ai-engine-settings.js"; // 保持模块加载顺序与拆分前一致
import { aiEngineAdapterLabel, clampAiEngineTimeout, engineCliProfile, readTeamAiEngineSettings, RESEARCH_ENGINE_SOURCES, resolveEngineSource } from "./ai-engine-settings.js";
import "./ai-engine-prompts.js"; // 保持模块加载顺序与拆分前一致
import { acquisitionExtractedContacts, acquisitionPrimaryContact, applyResearchEnginePatch, buildEmailCliPrompt, buildResearchCliPrompt, type EngineAcquisitionCompany, extractAcquisitionFindings, extractEngineJson, normalizeAcquisitionCompanies, normalizeEmailPatch, normalizeTenderReport, type TenderDailyReport } from "./ai-engine-prompts.js";
import { getAiEngineJobRepository, type AiEngineJob } from "./ai-engine-jobs.js";
import "./ai-engine-service.js"; // 保持模块加载顺序与拆分前一致
import { cliTaskDone, engineInlineWaitMilliseconds, EngineUnavailableError, enqueueEngineCliTask, pickEngineRunner, readEngineCliTask, waitForEngineCliTask } from "./ai-engine-service.js";
import { archiveMessageToSentFolder } from "./sent-folder-archive.js";
import "./sender-mailbox.js"; // 保持模块加载顺序与拆分前一致
import { getSenderMailboxRepository, pickSenderMailbox, senderMailboxOverrides } from "./sender-mailbox.js";
import "./supplier-repository.js"; // 保持模块加载顺序与拆分前一致
import { getSupplierRepository } from "./supplier-repository.js";
import "./mail-center.js"; // 保持模块加载顺序与拆分前一致
import { getMailCenterSyncService } from "./mail-center.js";
import "./file-storage.js"; // 保持模块加载顺序与拆分前一致
import { evaluateFileAccess, getFileRepository } from "./file-storage.js";
import "./file-derive.js"; // 保持模块加载顺序与拆分前一致
import { deriveQueue, startDerivePipeline } from "./file-derive.js";
import "./file-share.js"; // 保持模块加载顺序与拆分前一致
import "./file-bundle.js"; // 保持模块加载顺序与拆分前一致
import "./cli-ai.js"; // 保持模块加载顺序与拆分前一致
import type { BackgroundResearchRecord } from "./outreach-journey.js";
import { type OutboundEmailLog, type OutreachSequence, type OutreachSequenceStepSnapshot, type OutreachStageKey, type ProspectOutreachBatch, type ProspectOutreachBatchItem, type ProspectOutreachBatchPolicy } from "./types.js";
import "./customer-maintenance.js"; // 保持模块加载顺序与拆分前一致
import { controlCustomerMaintenanceWatch, createCustomerMaintenanceWatch, CustomerMaintenanceRunner, listCustomerMaintenanceWatches, previewCustomerMaintenance } from "./customer-maintenance.js";
import "./credential-security.js"; // 保持模块加载顺序与拆分前一致
import { decryptProviderConfiguration, validateProviderCredentialSecurity } from "./credential-security.js";
import "./market-analysis-runs.js"; // 保持模块加载顺序与拆分前一致
import { createMysqlStore } from "./mysql-store.js";
import { validateIntegrationControlPlaneConfig } from "./integrations/integration-runtime-config.js";
import { integrationHttpRouter } from "./integrations/integration-http-routes.js";
import "./exchange/exchange-repository.js"; // 保持模块加载顺序与拆分前一致
import "./kb-training/kb-training-repository.js"; // 保持模块加载顺序与拆分前一致
import "./kb-training/kb-training-service.js"; // 保持模块加载顺序与拆分前一致
import "./kb-training/kb-training-prompt.js"; // 保持模块加载顺序与拆分前一致
import "./kb-training/kb-source-extract.js"; // 保持模块加载顺序与拆分前一致
import "./kb-training/kb-knowledge-base-service.js"; // 保持模块加载顺序与拆分前一致
import { BullMqIntegrationQueueDispatcher } from "./integrations/integration-queue.js";
import { syncSystemConnectorCatalog } from "./integrations/connector-catalog.js";
import { IntegrationControlPlaneService } from "./integrations/integration-service.js";
import {
  getIntegrationControlPlaneService,
  getIntegrationRepository,
  getLocalRunnerService,
  setIntegrationControlPlaneService
} from "./integrations/integration-runtime.js";
import "./integrations/integration-credential-vault.js"; // 保持模块加载顺序与拆分前一致
import "./wecom-command-gateway.js"; // 保持模块加载顺序与拆分前一致
import "./mysql-data-import.js"; // 保持模块加载顺序与拆分前一致
import "./database-backup.js"; // 保持模块加载顺序与拆分前一致
import { getStore, setStore, type CrmStore } from "./store.js";
import "./lead-providers.js"; // 保持模块加载顺序与拆分前一致
import { defaultSearchProviderIdsFor, LEAD_PROVIDERS, type LeadProvider, providerMeta } from "./lead-providers.js";
import "./trade-providers.js"; // 保持模块加载顺序与拆分前一致
import "./provider-contract.js"; // 保持模块加载顺序与拆分前一致
import { ProviderContractError, providerErrorFromUnknown, type ProviderRecord } from "./provider-contract.js";
import "./provider-http-client.js"; // 保持模块加载顺序与拆分前一致
import "./provider-request-logging.js"; // 保持模块加载顺序与拆分前一致
import "./lead-finder-launch.js"; // 保持模块加载顺序与拆分前一致
import "./provider-runtime.js"; // 保持模块加载顺序与拆分前一致
import { createProviderExecutionContext, executeProviderEnrich, providerRequiresKey } from "./provider-runtime.js";
import { ProspectScheduler } from "./prospect-scheduler.js";
import "./prospect-super-search.js"; // 保持模块加载顺序与拆分前一致
import { ProspectSuperSearchError, ProspectSuperSearchRunner } from "./prospect-super-search.js";
import { ProspectWorkerService } from "./prospect-worker-service.js";
import "./prospect-contact-enrichment.js"; // 保持模块加载顺序与拆分前一致
import { contactChannelsFromText, contactEnrichmentSource, createContactEnrichmentAttempt, mergeProspectContactEvidence, mergeWebsiteProbeCandidateProgress, providerContactEvidence, refreshContactEnrichmentAttempt } from "./prospect-contact-enrichment.js";
import { discoverProspectWebsite } from "./prospect-website-discovery.js";
import { loadLocalEnv } from "./runtime-env.js";
import "./swagger.js"; // 保持模块加载顺序与拆分前一致
import { createOpenApiDocument } from "./swagger.js";
import { agentApiRequestSchema, assertAgentApiToolRisk, classifyAgentApiRequest, deniedAgentApiReason, normalizeAgentApiPath, redactAgentApiData, routeTemplateMatches } from "./agent-api-policy.js";
import { requestAgentInternalApi } from "./agent-internal-http.js";
import { resolveBackendHost } from "./server-network.js";
import "./website-lead-ingress-settings.js"; // 保持模块加载顺序与拆分前一致
import { validateWebsiteLeadIngressSettings } from "./website-lead-ingress-settings.js";
import "./trade-observation-list.js"; // 保持模块加载顺序与拆分前一致
import { validateTradeObservationCursorSecurity } from "./trade-observation-list.js";
import "./market-opportunity-list.js"; // 保持模块加载顺序与拆分前一致
import { validateMarketOpportunityCursorSecurity } from "./market-opportunity-list.js";
import "./prospect-campaigns.js"; // 保持模块加载顺序与拆分前一致
import { activateProspectCampaign, createProspectCampaign, getProspectCampaign, prospectCampaignEtag, ProspectCampaignRequestError } from "./prospect-campaigns.js";
import "./prospect-lead-conversion.js"; // 保持模块加载顺序与拆分前一致
import { PROSPECT_LEAD_SOURCE_CHANNEL, ProspectLeadConversionError } from "./prospect-lead-conversion.js";
import "./prospect-customer-conversion.js"; // 保持模块加载顺序与拆分前一致
import "./customer-intelligence.js"; // 保持模块加载顺序与拆分前一致
import { generateCustomerIntelligenceSuggestion } from "./customer-intelligence.js";
import "./customer-public-pool.js"; // 保持模块加载顺序与拆分前一致
import { isPublicCustomer } from "./customer-public-pool.js";
import {
  ProspectCoverageMemoryError
} from "./prospect-coverage-memory.js";
import "./prospect-candidate-actions.js"; // 保持模块加载顺序与拆分前一致
import "./prospect-qualification-workflow.js"; // 保持模块加载顺序与拆分前一致
import { ProspectQualificationWorkflowError } from "./prospect-qualification-workflow.js";
import "./prospect-qualification.js"; // 保持模块加载顺序与拆分前一致
import { ProspectQualificationError } from "./prospect-qualification.js";
import "./prospect-outreach-eligibility.js"; // 保持模块加载顺序与拆分前一致
import { assertCrmOutreachEligible, assertProspectEmailOutreachEligible, ProspectOutreachEligibilityError } from "./prospect-outreach-eligibility.js";
import "./prospect-outreach.js"; // 保持模块加载顺序与拆分前一致
import { migrateProspectFollowUpTodos, recordProspectTouchpoint } from "./prospect-outreach.js";
import "./email-tracking.js"; // 保持模块加载顺序与拆分前一致
import { buildOutboundMessageId, buildTrackedEmailHtml, buildTrackedHtmlBody, normalizeMessageIdValue, setEmailTrackingRuntimeBaseUrl, validateEmailTrackingSecurity } from "./email-tracking.js";
import "./app-settings.js"; // 保持模块加载顺序与拆分前一致
import { EMAIL_TRACKING_BASE_URL_KEY, getAppSetting } from "./app-settings.js";
import { loadDeploySecrets } from "./deploy-config.js";
import { InboundMailWatcher } from "./inbound-mail-watcher.js";
import { recordCrmEmailTouchpoint } from "./email-touchpoints.js";
import "./website-probe.js"; // 保持模块加载顺序与拆分前一致
import { expireStaleWebsiteProbeAttempts, queueWebsiteProbe, WebsiteProbeError } from "./website-probe.js";
import "./prospect-identity-bootstrap.js"; // 保持模块加载顺序与拆分前一致
import "./customs-export.js"; // 保持模块加载顺序与拆分前一致
import "./procurement-signals.js"; // 保持模块加载顺序与拆分前一致
import { linkProcurementContextToCustomer, linkProcurementContextToLead, recommendationReasonText } from "./procurement-signals.js";
import "./prospect-outcome-feedback.js"; // 保持模块加载顺序与拆分前一致
import "./prospect-strategies.js"; // 保持模块加载顺序与拆分前一致
import { approveProspectStrategy, listProspectStrategies, prospectStrategyEtag, ProspectStrategyRequestError, updateProspectStrategy } from "./prospect-strategies.js";
import "./prospect-runs.js"; // 保持模块加载顺序与拆分前一致
import { createProspectRun, getProspectRun, prospectRunEtag, ProspectRunRequestError, validateProspectRunSecurity } from "./prospect-runs.js";
import "./prospect-schedules.js"; // 保持模块加载顺序与拆分前一致
import { ProspectScheduleRequestError } from "./prospect-schedules.js";
import "./organization-identity-conflict-review.js"; // 保持模块加载顺序与拆分前一致
import "./organization-relations.js"; // 保持模块加载顺序与拆分前一致
import "./prospect-run-guards.js"; // 保持模块加载顺序与拆分前一致
import "./prospect-verification.js"; // 保持模块加载顺序与拆分前一致
import { withProspectVerificationReport } from "./prospect-verification.js";
import { refreshProspectScorecard } from "./prospect-scorecard.js";
import "./types.js"; // 保持模块加载顺序与拆分前一致
import { type AiModelConfig, type Customer, type Deal, type DealEvent, type Exam, type ExamAttempt, type ExamQuestion, type ExtractedWebsiteContact, type Lead, type LeadSourceEvent, type ProviderConnection, type ProviderEvidenceSnapshot, type Reminder, type SessionUser, type Todo, type WebsiteOpportunity } from "./types.js";
import { type CompanyProfile, type TeamSystemSettings } from "./types.js";
import { type Order } from "./types.js";
import "./order-service.js"; // 保持模块加载顺序与拆分前一致
import type { ReminderSkipReason, ReminderSkipReasonBucket } from "./types.js";
import "./shipment-ocr.js"; // 保持模块加载顺序与拆分前一致
import "./exchange-rates.js"; // 保持模块加载顺序与拆分前一致
import "./auto-updater.js"; // 保持模块加载顺序与拆分前一致
import "./whatsapp-service.js"; // 保持模块加载顺序与拆分前一致
import { twilioManager } from "./whatsapp-service.js";

loadLocalEnv();

export const app = express();
export let activeProspectWorkerService: ProspectWorkerService | null = null;
let activeIntegrationControlPlane: IntegrationControlPlaneService | null = null;
const communicationTarget = process.env.COMMUNICATION_API_ORIGIN?.trim() || "http://127.0.0.1:3100";
const communicationProxy = httpProxy.createProxyServer({
  target: communicationTarget,
  changeOrigin: false,
  ws: true
});
communicationProxy.on("error", (error, _request, response) => {
  console.error(`Communication proxy failed: ${error.message}`);
  if (response && "writeHead" in response && !response.headersSent) {
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
  }
  if (response && "end" in response) response.end(JSON.stringify({ message: "Communication 服务暂不可用" }));
});

export async function synchronizeWhatsAppFollowup(todo: Todo, user: SessionUser, status: "pending" | "completed"): Promise<void> {
  const match = todo.triggerKey?.match(/^whatsapp-insight:[^:]+:([^:]+)$/u);
  if (!match) return;
  try {
    const response = await fetch(`${communicationTarget}/api/v1/followups/${encodeURIComponent(match[1])}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${signToken(user)}` },
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok && response.status !== 404) {
      console.error("[communication-followup-sync]", { event: "followup_sync_failed", todoId: todo.id, status, httpStatus: response.status });
    }
  } catch (error) {
    console.error("[communication-followup-sync]", {
      event: "followup_sync_failed",
      todoId: todo.id,
      status,
      error: error instanceof Error ? error.message : "unknown error"
    });
  }
}

export async function synchronizeProspectQueue() {
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
app.set("trust proxy", process.env.TRUST_PROXY_HOPS === "1" ? 1 : "loopback");
const allowedOrigins = new Set((process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean));
function originAllowed(origin?: string) {
  if (!origin || allowedOrigins.has(origin)) return true;
  if (process.env.NODE_ENV === "production") return false;
  // 本机工具来源：网页页面走 http://127.0.0.1|localhost:<port>；
  // 浏览器扩展（MV3 service worker 的 fetch 固定带 chrome-extension://<32位id>）同属本机工具，
  // 不放行的话扩展侧「登录 CRM」会被 403「不允许的请求来源」卡死。id 只可能是 a-p 的小写字母。
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)
    || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
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
app.use("/whatsapp-plugin/api", (req, res) => {
  req.url = `/api${req.url}`;
  communicationProxy.web(req, res);
});
app.use(express.json({
  limit: process.env.JSON_BODY_LIMIT || "3mb",
  verify(req, _res, buffer) {
    if (String(req.url || "").startsWith("/api/integrations/webhooks/")) {
      (req as typeof req & { integrationRawBody?: Buffer }).integrationRawBody = Buffer.from(buffer);
    }
    if (String(req.url || "").split("?")[0] === "/api/website-leads") {
      (req as typeof req & { websiteLeadRawBody?: Buffer }).websiteLeadRawBody = Buffer.from(buffer);
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));

export const loginLimiter = rateLimit({
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

// Public website intake is authenticated separately from human CRM sessions.
// The credential is a scoped machine secret, never a CRM user password.
export const websiteLeadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 10_000 : 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "网站询盘请求过于频繁" }
});
app.use("/api/integrations", integrationHttpRouter);

function iamBusinessPermission(req: Request) {
  const pathName = req.originalUrl.split("?")[0];
  const method = req.method.toUpperCase();
  if (pathName.startsWith("/api/customers")) {
    if (pathName.includes("/bulk-delete")) return "customer.delete";
    if (pathName.includes("/export")) return "customer.export";
    if (pathName.includes("/claim")) return "customer.pool.claim";
    if (pathName.includes("/release")) return "customer.pool.release";
    if (method === "GET") return "customer.read";
    if (method === "DELETE") return "customer.delete";
    if (method === "POST" && /^\/api\/customers\/?$/u.test(pathName)) return "customer.create";
    return "customer.update";
  }
  if (pathName.startsWith("/api/suppliers")) {
    if (pathName.includes("/bulk-delete")) return "supplier.delete";
    if (method === "GET") return "supplier.read";
    if (method === "DELETE") return "supplier.delete";
    if (method === "POST" && /^\/api\/suppliers\/?$/u.test(pathName)) return "supplier.create";
    return "supplier.update";
  }
  if (pathName.startsWith("/api/leads")) {
    if (pathName.includes("/export")) return "lead.export";
    if (method === "GET") return "lead.read";
    if (method === "DELETE") return "lead.delete";
    if (method === "POST" && /^\/api\/leads\/?$/u.test(pathName)) return "lead.create";
    return "lead.update";
  }
  if (pathName.startsWith("/api/deals")) {
    if (pathName.includes("/generate-customs")) return "deal.quote.create";
    if (pathName.includes("/stage") || pathName.includes("/advance")) return "deal.stage.advance";
    if (pathName.includes("/quote") || pathName.includes("/pi")) return "deal.quote.create";
    if (method === "GET") return "deal.read";
    if (method === "DELETE") return "deal.delete";
    if (method === "POST" && /^\/api\/deals\/?$/u.test(pathName)) return "deal.create";
    return "deal.update";
  }
  return "";
}

export async function enforceIamTenantPermission(req: Request, res: Response, next: NextFunction, permissionCode: string) {
  if (isPlatformIdentity(req.user)) {
    res.status(403).json({ message: "平台运维身份不能直接访问公司业务数据，请使用租户支持流程", permissionCode });
    return;
  }
  if (!hasIamPermission(req.user, permissionCode)) {
    res.status(403).json({ message: "当前账号没有执行该业务操作的权限", permissionCode });
    return;
  }
  if (getStore().resolveIamDataScope) {
    req.user!.iamDataScope = {
      permissionCode,
      ...await getStore().resolveIamDataScope!(req.user!, permissionCode)
    };
  } else {
    const scopes = req.user!.iamPermissions?.[permissionCode] || [];
    const organizationWide = scopes.includes("org_unit") || scopes.includes("org_subtree");
    req.user!.iamDataScope = {
      permissionCode,
      tenantWide: scopes.includes("tenant"),
      ownerIds: organizationWide
        ? getStore().users.filter((user) => user.teamId === req.user!.teamId && user.status === "active").map((user) => user.id)
        : scopes.includes("self") ? [req.user!.id] : []
    };
  }
  res.setHeader("X-Authorization-Source", "iam");
  next();
}

app.use(["/api/customers", "/api/leads", "/api/deals", "/api/suppliers"], requireAuth, asyncRoute(async (req, res, next) => {
  const permissionCode = iamBusinessPermission(req);
  if (!permissionCode) { next(); return; }
  await enforceIamTenantPermission(req, res, next, permissionCode);
}));

app.use("/api/ai-background-research", requireAuth, asyncRoute(async (req, res, next) => {
  const entityType = z.enum(["lead", "customer", "prospect"]).safeParse(req.body?.entityType);
  if (!entityType.success) { next(); return; }
  await enforceIamTenantPermission(
    req,
    res,
    next,
    entityType.data === "lead" ? "lead.read" : entityType.data === "customer" ? "customer.read" : "prospect.read"
  );
}));

app.use("/api/daily-reports", requireAuth, asyncRoute(async (req, res, next) => {
  const permission = req.path.includes("/comments") ? "daily_report.comment" : req.method === "GET" ? "daily_report.read" : "daily_report.create";
  await enforceIamTenantPermission(req, res, next, permission);
}));
app.use("/api/reports", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.path.includes("export") ? "report.export" : "report.read");
}));
app.use("/api/dashboard", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, "workspace.dashboard.read");
}));
app.use(["/api/problems", "/api/competitors", "/api/case-studies", "/api/memos", "/api/plan-tasks", "/api/plan-templates"], requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "workspace.dashboard.read" : "workspace.dashboard.manage");
}));
app.use(["/api/trade-documents", "/api/trade-document-imports", "/api/trade-document-templates", "/api/trade-document-recognition-templates", "/api/document-assets", "/api/document-defaults", "/api/quote-history"], requireAuth, asyncRoute(async (req, res, next) => {
  const previewOnly = req.method === "POST" && req.path.endsWith("/preview-xlsx");
  const managingAssets = req.originalUrl.startsWith("/api/document-assets") && req.method !== "GET";
  const managingDefaults = req.originalUrl.startsWith("/api/document-defaults") && req.method !== "GET";
  const uploadingProductImage = req.originalUrl.startsWith("/api/document-assets/upload") && req.body?.kind === "product";
  await enforceIamTenantPermission(req, res, next, uploadingProductImage ? "product.manage" : managingAssets || managingDefaults ? "system.settings.manage" : req.method === "GET" || previewOnly ? "document.read" : "document.manage");
}));
app.use(["/api/tools/products", "/api/tools/product-categories"], requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "product.read" : "product.manage");
}));
app.use("/api/reminders", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "reminder.read" : "reminder.manage");
}));
app.use("/api/commission", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "commission.read" : "commission.manage");
}));
app.use("/api/internal-messages", requireAuth, asyncRoute(async (req, res, next) => {
  const isReadAction = req.method === "GET" || req.path === "/read-all" || req.path.endsWith("/read");
  const permission = isReadAction ? "message.read" : "message.send";
  await enforceIamTenantPermission(req, res, next, permission);
}));
app.use("/api/accounts", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "member.read" : "member.manage");
}));
app.use(["/api/prospect-list", "/api/prospect-runs", "/api/prospect-super-search", "/api/prospect-schedules", "/api/prospect-campaigns", "/api/prospect-strategies"], requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "prospect.read" : "prospect.execute");
}));
app.use(["/api/prospect-agent-jobs", "/api/prospects", "/api/prospect-performance", "/api/prospect-strategy-suggestions"], requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, ["GET", "HEAD"].includes(req.method) ? "prospect.read" : "prospect.execute");
}));
app.use("/api/lead-finder", requireAuth, asyncRoute(async (req, res, next) => {
  const readOnly = req.method === "GET" || req.path === "/parse-goal";
  await enforceIamTenantPermission(req, res, next, readOnly ? "prospect.read" : "prospect.execute");
}));
app.use(["/api/tools/website-scrape", "/api/tools/website-opportunities", "/api/organization-relations", "/api/organization-identity-conflicts"], requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "prospect.read" : "prospect.execute");
}));
app.use(["/api/whatsapp", "/api/wecom"], requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "communication.read" : "communication.send");
}));
app.use(["/api/development-email", "/api/outbound-emails"], requireAuth, asyncRoute(async (req, res, next) => {
  const readOnly = req.method === "GET" || req.path.endsWith("/draft");
  await enforceIamTenantPermission(req, res, next, readOnly ? "communication.read" : "communication.send");
}));
// ⚠️ 邮件中心必须挂在这道闸上：canSeeOwner 在 IAM 账号下若无 iamDataScope 会直接返回 false
// （auth.ts:321-322），而 iamDataScope 只由 enforceIamTenantPermission 填充。漏了这道闸，
// 客户速查永远 total 0、旅程/单客户一律 404「客户不存在或无权访问」，且不报任何错误。
app.use("/api/mail-center", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "communication.read" : "communication.send");
}));
app.use([
  "/api/profile/send-development-email",
  "/api/profile/test-email",
  "/api/profile/inbound-mail/sync",
  "/api/profile/inbound-mail/test",
  /^\/api\/leads\/[^/]+\/send-email$/u,
  /^\/api\/prospect-list\/[^/]+\/send-development-email$/u
], requireAuth, asyncRoute(async (req, res, next) => {
  const readOnly = req.path.includes("/inbound-mail/");
  await enforceIamTenantPermission(req, res, next, readOnly ? "communication.read" : "communication.send");
}));
app.use("/api/agent", requireAuth, asyncRoute(async (req, res, next) => {
  if (req.path.includes("sales-training") || req.path.includes("sales-distillation")) {
    const personalPlaybookAction = req.path.endsWith("/activate") || req.path.includes("/activations/");
    await enforceIamTenantPermission(req, res, next, req.method === "GET" || personalPlaybookAction ? "training.read" : "training.manage");
    return;
  }
  const manage = req.method !== "GET" && (req.path.includes("knowledge") || req.path.includes("triggers") || req.path.includes("governance"));
  await enforceIamTenantPermission(req, res, next, manage ? "agent.manage" : "agent.use");
}));
app.use(["/api/knowledge", "/api/exams", "/api/exam-questions", "/api/exam-attempts"], requireAuth, asyncRoute(async (req, res, next) => {
  const knowledgeAssetSelfService = req.originalUrl.startsWith("/api/knowledge/assets")
    && !req.path.endsWith("/publish")
    && !req.path.endsWith("/archive")
    && !req.path.endsWith("/batch");
  const readLikeAction = req.method === "GET"
    || knowledgeAssetSelfService
    || req.path.endsWith("/submit")
    || req.path.endsWith("/detail")
    || req.path.endsWith("/start")
    || req.originalUrl.startsWith("/api/exam-attempts/");
  await enforceIamTenantPermission(req, res, next, readLikeAction ? "training.read" : "training.manage");
}));
/**
 * 知识库训练工作台：读用 training.read、写用 training.manage。
 * 与文件中心同权限位 —— 训练库的上游就是文件中心，权限口径不该分叉。
 */
app.use("/api/kb", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "training.read" : "training.manage");
}));
app.use("/api/products", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "product.read" : "product.manage");
}));
app.use("/api/shipments", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "shipment.read" : "shipment.manage");
}));
app.use("/api/orders", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "order.read" : "order.manage");
}));
// 文件存储层：读用 training.read（业务员默认有），写用 document.manage。
// 必须走 enforceIamTenantPermission —— 它会填充 iamDataScope，而 canSeeOwner 在 IAM 账号下
// 只认 iamDataScope（漏了这道闸，所有文件的可见性判定会一律 false 且不报错）。
app.use("/api/files", requireAuth, asyncRoute(async (req, res, next) => {
  const readLike = req.method === "GET" || req.method === "HEAD";
  await enforceIamTenantPermission(req, res, next, readLike ? "training.read" : "document.manage");
}));
app.use("/api/storage", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "training.read" : "system.settings.manage");
}));
app.use("/api/import-export", requireAuth, asyncRoute(async (req, res, next) => {
  const permission = req.path.includes("/customers/import") ? "customer.create"
    : req.path.includes("/customers/export") ? "customer.export"
      : req.method === "GET" ? "report.read" : "report.export";
  await enforceIamTenantPermission(req, res, next, permission);
}));
app.use("/api/customs-documents", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, "deal.quote.create");
}));
app.use("/api/tools/ocr", requireAuth, asyncRoute(async (req, res, next) => {
  await enforceIamTenantPermission(req, res, next, req.method === "GET" ? "document.read" : "document.manage");
}));
app.use(["/api/v1/approval-workflows", "/api/v1/approval-instances", "/api/v1/approval-tasks"], requireAuth, asyncRoute(async (req, res, next) => {
  const pathName = req.originalUrl.split("?")[0];
  const permission = pathName.startsWith("/api/v1/approval-workflows")
    ? (req.method === "GET" || pathName.endsWith("/resolve") ? "approval.read" : "approval.workflow.manage")
    : pathName.startsWith("/api/v1/approval-tasks") && req.method !== "GET"
      ? "approval.task.act"
      : "approval.read";
  await enforceIamTenantPermission(req, res, next, permission);
}));

export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

export async function persistCandidateChanges(
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

export function requestCorrelationId(req: Request) {
  const provided = String(req.header("X-Request-Id") || "").trim();
  return provided ? provided.slice(0, 100) : randomUUID();
}

export function sendProspectCampaignError(
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

export function sendProspectLeadConversionError(
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

export function sendProspectQualificationError(
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

export function setProspectRunEtag(
  res: Response,
  payload: { run: { id: string; revision: number } }
) {
  res.setHeader("ETag", prospectRunEtag(payload.run));
  res.setHeader("Cache-Control", "no-store");
}

export function accountUser(user: ReturnType<typeof getStore>["users"][number]) {
  const expired = userExpired(user);
  const raw = (user.expiresAt || "").trim();
  const ts = raw ? Date.parse(raw) : NaN;
  const daysLeft = Number.isFinite(ts) ? Math.ceil((ts - Date.now()) / 86_400_000) : null;
  return { ...publicUser(user), status: user.status, expiresAt: raw, expired, daysLeft };
}

export function createInternalNotification(input: {
  senderId: string;
  recipientId: string;
  teamId: string;
  subject: string;
  content: string;
  relatedType?: "daily_report" | "message" | "lead" | "quote_history" | "";
  relatedId?: string;
  threadId?: string;
  idempotencyKey?: string;
}) {
  if (input.senderId === input.recipientId) return null;
  if (input.idempotencyKey && getStore().internalMessages.some((item) =>
    item.recipientId === input.recipientId && item.idempotencyKey === input.idempotencyKey
  )) {
    return null;
  }
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
    idempotencyKey: input.idempotencyKey,
    readAt: "",
    createdAt: now,
    updatedAt: now
  };
  getStore().internalMessages.unshift(message);
  return message;
}

export function notifyNewLead(lead: Pick<Lead, "id" | "company" | "contact" | "source" | "ownerId" | "teamId">) {
  const store = getStore();
  const recipients = store.users.filter((user) =>
    user.status === "active"
    && user.teamId === lead.teamId
    && (user.id === lead.ownerId || user.role === "manager" || user.role === "admin")
  );
  const content = `${lead.company || "新线索"}${lead.contact ? ` · ${lead.contact}` : ""} 已进入线索管理${lead.source ? `，来源：${lead.source}` : ""}。`;
  return recipients
    .map((recipient) => createInternalNotification({
      senderId: "system",
      recipientId: recipient.id,
      teamId: recipient.teamId,
      subject: "新线索提醒",
      content,
      relatedType: "lead",
      relatedId: lead.id,
      idempotencyKey: `lead-notification:${lead.id}:${recipient.id}`
    }))
    .filter((message): message is NonNullable<typeof message> => Boolean(message));
}

export function canManageTraining(user?: SessionUser) {
  return hasIamPermission(user, "training.manage");
}

export function canSeeKnowledgeAsset(user: SessionUser, asset: ReturnType<typeof getStore>["knowledgeAssets"][number]) {
  const teamId = knowledgeAssetTeamId(getStore(), asset);
  if (teamId !== user.teamId || isPlatformIdentity(user)) return false;
  if (asset.status === "published") return true;
  return canSeeOwner(user, asset.ownerId, teamId);
}

export function normalizeKnowledgeSource(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("请输入有效的资料 URL");
  }
  if (parsed.protocol !== "https:") throw new Error("资料链接必须使用 HTTPS");
  if (parsed.username || parsed.password) throw new Error("资料链接不能包含账号或密码");
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const blockedHost = hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "0.0.0.0"
    || hostname === "::1"
    || /^127\./u.test(hostname)
    || /^10\./u.test(hostname)
    || /^192\.168\./u.test(hostname)
    || /^169\.254\./u.test(hostname)
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname);
  if (!hostname || blockedHost) throw new Error("资料链接不能指向本机或内网地址");
  const isBaidu = hostname === "pan.baidu.com" || hostname === "yun.baidu.com";
  return {
    sourceUrl: parsed.toString(),
    sourceType: isBaidu ? "baidu_share" as const : "external_url" as const
  };
}

/**
 * 质量四项（入库闸的「结构化必填」软校验）。
 *
 * 不做硬拦截 —— 标题=文件名、无说明、无标签、无链接的资料仍然可以入库（那是现实），
 * 但要**可见**：发布时作为 qualityFlags 返回，列表页显示「待补」徽章，让治理有抓手。
 * 硬拦截只会把资料逼到别处去，拦不住脏，只是拦住了可见性。
 */
/**
 * 「这份资料点了能不能拿到东西」。
 *
 * 抽成独立函数、而不是继续内联在 `knowledgeQualityFlags` 里：面向插件的目录快照
 * 要把这件事单独透出去（`hasExternalLink`），写两遍必然分叉 —— 而两套口径下
 * 「缺链接 12 份」与「12 份点了没反应」对不上账，治理面板就没人信了。
 * 与 `resource-hub.ts::resourceReachable` 对 file 源的判定保持一致。
 */
export function knowledgeAssetHasLink(asset: { sourceUrl?: string; sourceType?: string }) {
  return Boolean(asset.sourceUrl) && asset.sourceType !== "legacy";
}

export function knowledgeQualityFlags(asset: {
  title?: string;
  description?: string;
  tags?: string[];
  sourceUrl?: string;
  sourceType?: string;
}) {
  const flags: string[] = [];
  if (String(asset.title || "").trim().length < 6) flags.push("标题过短");
  if (!String(asset.description || "").trim()) flags.push("缺少说明");
  if (!Array.isArray(asset.tags) || !asset.tags.length) flags.push("缺少标签");
  if (!knowledgeAssetHasLink(asset)) flags.push("缺少链接");
  return flags;
}

export function canAccessExam(user: SessionUser, exam: Exam) {
  if (exam.teamId && exam.teamId !== "all" && exam.teamId !== user.teamId) return false;
  if (canManageTraining(user)) return true;
  if (exam.status !== "published") return false;
  const assignments = getStore().examAssignments.filter((item) => item.examId === exam.id);
  if (assignments.length) return assignments.some((item) => item.userId === user.id && item.teamId === user.teamId);
  if (user.iamPermissions) return hasIamPermission(user, "training.read");
  return exam.targetRole === "all" || exam.targetRole === user.role;
}

export function canUseExamQuestion(user: SessionUser, question: ExamQuestion) {
  return !question.teamId || question.teamId === "all" || question.teamId === user.teamId;
}

type BusinessCardRecognizer = (
  dataUrl: string,
  mime: "image/png" | "image/jpeg" | "image/webp",
  config: AiModelConfig
) => Promise<BusinessCardRecognition>;

export let businessCardRecognizer: BusinessCardRecognizer = recognizeBusinessCard;

export function setBusinessCardRecognizerForTest(recognizer: BusinessCardRecognizer | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("名片识别测试替身只能在测试环境使用");
  }
  businessCardRecognizer = recognizer || recognizeBusinessCard;
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

function validateOutboundEmailConfiguration(user: ReturnType<typeof getStore>["users"][number]) {
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
  return { smtpPort, smtpSecure };
}

export async function sendOutboundEmail(user: ReturnType<typeof getStore>["users"][number], payload: { to: string; cc?: string; bcc?: string; subject: string; body: string; html?: string; attachments?: Array<{ filename: string; content: Buffer; contentType?: string; cid?: string }>; messageId?: string; inReplyTo?: string; references?: string; appendOptOut?: boolean; htmlAlways?: boolean }) {
  outboundEmailDispatchObserver?.({
    userId: user.id,
    to: payload.to,
    subject: payload.subject
  });
  const { smtpPort, smtpSecure } = validateOutboundEmailConfiguration(user);
  const streamTransport = ["test", "e2e"].includes(process.env.NODE_ENV || "");
  const transport = streamTransport
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
  const messageId = payload.messageId || buildOutboundMessageId();
  // 退订提示是「营销群发」的合规尾缀；邮件中心手工写信走 appendOptOut:false，别给客户添堵。
  const appendOptOut = payload.appendOptOut !== false && process.env.OUTBOUND_EMAIL_APPEND_OPTOUT !== "false";
  const optOutBody = appendOptOut
    ? `${payload.body.trim()}\n\nIf you prefer not to receive further emails, reply with "unsubscribe".`
    : payload.body;
  // htmlAlways（邮件中心手工写信）：没开追踪也要带 HTML 版式，所见即所得；
  // 群发管线维持原样（开了追踪才有 HTML），避免影响投递习惯。
  // 富文本正文（payload.html）走 buildTrackedHtmlBody：同样的链接改写 + 像素 + 版式包装。
  const tracked = payload.html
    ? buildTrackedHtmlBody(payload.html, messageId, { trackingOptional: payload.htmlAlways === true })
    : buildTrackedEmailHtml(optOutBody, messageId, { trackingOptional: payload.htmlAlways === true });
  const mailOptions = {
    messageId,
    from: `"${user.emailSenderName || user.name}" <${user.outboundEmail}>`,
    replyTo: user.outboundEmail,
    to: payload.to,
    ...(payload.cc ? { cc: payload.cc } : {}),
    ...(payload.bcc ? { bcc: payload.bcc } : {}),
    subject: payload.subject,
    text: optOutBody,
    // 会话线程头：回复/转发时带上，邮件客户端才能把这封信归进原会话
    ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
    ...(payload.references ? { references: payload.references } : {}),
    ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
    headers: {
      "List-Unsubscribe": `<mailto:${user.outboundEmail}?subject=unsubscribe>`
    },
    ...(tracked ? { html: tracked.html } : {})
  };
  /**
   * 自己编译原始 MIME 再投递，有两个原因：
   * 1) 归档到「已发送」需要**完整原文**，而 SMTP 模式下发完就取不到了；
   * 2) 保证「投出去的」与「留在已发送里的」是逐字节同一封。
   * （用内存流 transport 编译：这是 nodemailer 的公开 API，不必去碰它的内部子路径。）
   */
  const raw = streamTransport
    ? null
    : await compileOutboundRawMessage(mailOptions);
  const info = raw
    ? await transport.sendMail({
      envelope: { from: user.outboundEmail, to: [payload.to, payload.cc, payload.bcc].filter(Boolean).join(",") },
      raw
    })
    : await transport.sendMail(mailOptions);
  /**
   * 把副本写进发件账号的「已发送」。
   * 腾讯企业邮等在网页端未勾选「保存已发送至服务器」时，SMTP 投递的邮件不会出现在
   * 用户邮箱的「已发送」里（用户会以为信没发出去）。这里由 CRM 补上这一步。
   * best-effort：失败只记一行日志，**绝不改变「信已发出」这个既成事实**。
   */
  if (raw) {
    const archive = await archiveMessageToSentFolder(user, raw, { date: new Date() });
    if (!archive.ok && !archive.skipped) {
      console.warn(`[outbound-email] 归档到已发送失败（不影响本次发送）：${archive.error || "未知原因"}`);
    }
  }
  return { ...info, messageId: info?.messageId || messageId };
}

/** 用内存流 transport 把一封邮件编译成原始 MIME（不产生任何网络请求）。 */
async function compileOutboundRawMessage(mailOptions: nodemailer.SendMailOptions) {
  const compiler = nodemailer.createTransport({ streamTransport: true, newline: "unix", buffer: true });
  const compiled = await compiler.sendMail(mailOptions);
  if (!Buffer.isBuffer(compiled.message)) throw new Error("编译邮件原文失败");
  return compiled.message;
}

export function recordOutboundEmailLog(
  store: ReturnType<typeof getStore>,
  input: {
    messageId: unknown;
    teamId: string;
    ownerId: string;
    entityType: OutboundEmailLog["entityType"];
    entityId: string;
    to: string;
    subject: string;
    source: string;
    sequenceId?: string;
    executionId?: string;
    requestId?: string;
    payloadHash?: string;
    dispatchStatus?: OutboundEmailLog["dispatchStatus"];
    dispatchError?: string;
    sentAt: string;
  }
) {
  const messageId = normalizeMessageIdValue(String(input.messageId || ""));
  if (!messageId) return undefined;
  const existing = store.outboundEmailLogs.find((item) => item.messageId === messageId);
  if (existing) return existing;
  const log: OutboundEmailLog = {
    id: `oel_${randomUUID()}`,
    teamId: input.teamId,
    ownerId: input.ownerId,
    messageId,
    entityType: input.entityType,
    entityId: input.entityId || "",
    to: input.to || "",
    subject: input.subject || "",
    source: input.source || "",
    sequenceId: input.sequenceId || undefined,
    executionId: input.executionId || undefined,
    requestId: input.requestId || undefined,
    payloadHash: input.payloadHash || undefined,
    dispatchStatus: input.dispatchStatus || "sent",
    dispatchError: input.dispatchError || "",
    sentAt: input.sentAt,
    openCount: 0,
    clickCount: 0,
    createdAt: new Date().toISOString()
  };
  store.outboundEmailLogs.unshift(log);
  if (store.outboundEmailLogs.length > 20000) {
    store.outboundEmailLogs.length = 20000;
  }
  return log;
}

function positiveEnvironmentNumber(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export async function emailDomainAuthentication(user: ReturnType<typeof getStore>["users"][number]) {
  const domain = (user.outboundEmail || "").trim().toLowerCase().split("@")[1] || "";
  if (!domain) throw new Error("请先填写有效的发件邮箱");
  const txt = async (name: string) => {
    try {
      return (await resolveTxt(name)).map((parts) => parts.join(""));
    } catch {
      return [] as string[];
    }
  };
  const configuredSelectors = (process.env.EMAIL_DKIM_SELECTORS || "")
    .split(",").map((item) => item.trim()).filter(Boolean);
  const selectors = configuredSelectors.length
    ? configuredSelectors
    : ["default", "selector1", "selector2", "google", "s1", "mail"];
  const [rootRecords, dmarcRecords, ...dkimRecords] = await Promise.all([
    txt(domain),
    txt(`_dmarc.${domain}`),
    ...selectors.map((selector) => txt(`${selector}._domainkey.${domain}`))
  ]);
  const spfRecord = rootRecords.find((record) => /^v=spf1\b/i.test(record)) || "";
  const dmarcRecord = dmarcRecords.find((record) => /^v=dmarc1\b/i.test(record)) || "";
  const dkimIndex = dkimRecords.findIndex((records) =>
    records.some((record) => /^v=dkim1\b/i.test(record) || /\bp=/i.test(record))
  );
  return {
    domain,
    ready: Boolean(spfRecord && dmarcRecord && dkimIndex >= 0),
    spf: { ok: Boolean(spfRecord), record: spfRecord },
    dmarc: { ok: Boolean(dmarcRecord), record: dmarcRecord },
    dkim: {
      ok: dkimIndex >= 0,
      selector: dkimIndex >= 0 ? selectors[dkimIndex] : "",
      checkedSelectors: selectors,
      definitive: configuredSelectors.length > 0
    }
  };
}

function assertOutboundEmailRiskPolicy(
  store: ReturnType<typeof getStore>,
  user: ReturnType<typeof getStore>["users"][number],
  recipient: string
) {
  const now = Date.now();
  const sentLogs = store.outboundEmailLogs.filter((item) =>
    item.ownerId === user.id
    && (item.dispatchStatus || "sent") === "sent"
  );
  const dailyLimit = positiveEnvironmentNumber(
    "OUTBOUND_EMAIL_DAILY_LIMIT",
    ["test", "e2e"].includes(process.env.NODE_ENV || "") ? 10_000 : 50
  );
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  if (sentLogs.filter((item) => new Date(item.sentAt).getTime() >= dayStart.getTime()).length >= dailyLimit) {
    throw new Error(`发信保护：今天已达到每邮箱 ${dailyLimit} 封上限`);
  }
  const domain = recipient.trim().toLowerCase().split("@")[1] || "";
  const domainWindowMinutes = positiveEnvironmentNumber("OUTBOUND_EMAIL_DOMAIN_WINDOW_MINUTES", 10);
  const domainLimit = positiveEnvironmentNumber("OUTBOUND_EMAIL_DOMAIN_WINDOW_LIMIT", 5);
  const domainSince = now - domainWindowMinutes * 60_000;
  const domainCount = sentLogs.filter((item) =>
    item.to.toLowerCase().endsWith(`@${domain}`)
    && new Date(item.sentAt).getTime() >= domainSince
  ).length;
  if (domain && domainCount >= domainLimit) {
    throw new Error(`发信保护：同一收件域名 ${domainWindowMinutes} 分钟内最多发送 ${domainLimit} 封`);
  }
  const bounceWindowDays = positiveEnvironmentNumber("OUTBOUND_EMAIL_BOUNCE_WINDOW_DAYS", 7);
  const recent = sentLogs.filter((item) => new Date(item.sentAt).getTime() >= now - bounceWindowDays * 86_400_000);
  const minSample = positiveEnvironmentNumber("OUTBOUND_EMAIL_BOUNCE_MIN_SAMPLE", 20);
  const maxBouncePercent = positiveEnvironmentNumber("OUTBOUND_EMAIL_MAX_BOUNCE_PERCENT", 10);
  if (recent.length >= minSample) {
    const bouncePercent = recent.filter((item) => item.bouncedAt).length * 100 / recent.length;
    if (bouncePercent >= maxBouncePercent) {
      throw new Error(`发信保护：近 ${bounceWindowDays} 天退信率 ${bouncePercent.toFixed(1)}%，已暂停外发`);
    }
  }
}

class OutboundEmailDispatchError extends Error {
  constructor(message: string, readonly errorCode: string, readonly statusCode = 409) {
    super(message);
  }
}

export async function dispatchOutboundEmail(
  store: ReturnType<typeof getStore>,
  user: ReturnType<typeof getStore>["users"][number],
  input: {
    requestId: string;
    entityType: OutboundEmailLog["entityType"];
    entityId: string;
    to: string;
    subject: string;
    body: string;
    source: string;
    sequenceId?: string;
    executionId?: string;
    messageId?: string;
  }
) {
  validateOutboundEmailConfiguration(user);
  const requestId = input.requestId.trim();
  if (!requestId) throw new OutboundEmailDispatchError("缺少发信请求编号", "OUTBOUND_EMAIL_REQUEST_ID_REQUIRED", 400);
  const payloadHash = createHash("sha256").update(JSON.stringify({
    entityType: input.entityType,
    entityId: input.entityId,
    to: input.to.trim().toLowerCase(),
    subject: input.subject,
    body: input.body
  })).digest("hex");
  const existing = store.outboundEmailLogs.find((item) =>
    item.ownerId === user.id && item.requestId === requestId
  );
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new OutboundEmailDispatchError("该 requestId 已用于不同邮件内容", "OUTBOUND_EMAIL_IDEMPOTENCY_CONFLICT");
    }
    if ((existing.dispatchStatus || "sent") === "sent") {
      return { log: existing, replayed: true };
    }
    throw new OutboundEmailDispatchError(
      "上一请求的 SMTP 结果尚不能安全确认，系统已阻止重复发送；请先到已发送邮箱核对",
      "OUTBOUND_EMAIL_DISPATCH_UNCERTAIN"
    );
  }
  if (process.env.OUTBOUND_EMAIL_REQUIRE_DNS_AUTH === "true"
    && !["test", "e2e"].includes(process.env.NODE_ENV || "")) {
    const authentication = await emailDomainAuthentication(user);
    if (!authentication.spf.ok || !authentication.dmarc.ok
      || (authentication.dkim.definitive && !authentication.dkim.ok)) {
      throw new Error("发信保护：发件域名未通过 SPF、DMARC 或已配置 DKIM selector 检查");
    }
  }
  assertOutboundEmailRiskPolicy(store, user, input.to);
  const createdAt = new Date().toISOString();
  const log = recordOutboundEmailLog(store, {
    messageId: input.messageId || buildOutboundMessageId(),
    teamId: user.teamId,
    ownerId: user.id,
    entityType: input.entityType,
    entityId: input.entityId,
    to: input.to,
    subject: input.subject,
    source: input.source,
    sequenceId: input.sequenceId,
    executionId: input.executionId,
    requestId,
    payloadHash,
    dispatchStatus: "pending",
    sentAt: createdAt
  })!;
  await store.persist();
  try {
    await sendOutboundEmail(user, {
      to: input.to,
      subject: input.subject,
      body: input.body,
      messageId: `<${log.messageId}>`
    });
    log.dispatchStatus = "sent";
    log.dispatchError = "";
    log.sentAt = new Date().toISOString();
    await store.persist();
    return { log, replayed: false };
  } catch (error) {
    log.dispatchStatus = "uncertain";
    log.dispatchError = outboundEmailError(error, user).slice(0, 1000);
    await store.persist().catch(() => undefined);
    throw error;
  }
}

export function outboundEmailError(error: unknown, user: ReturnType<typeof getStore>["users"][number]) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.startsWith("请先") || message.startsWith("SMTP配置不匹配") || message.startsWith("发信保护")) return message;
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

export function sendOutboundEmailFailure(
  res: Response,
  error: unknown,
  user: ReturnType<typeof getStore>["users"][number]
) {
  if (error instanceof OutboundEmailDispatchError) {
    res.status(error.statusCode).json({ message: error.message, errorCode: error.errorCode });
    return;
  }
  res.status(400).json({ message: outboundEmailError(error, user) });
}

export function examQuestionsFor(examId: string, user?: SessionUser) {
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

export function bankQuestions(user?: SessionUser) {
  const store = getStore();
  return store.examQuestions
    .filter((question) => question.examId === "bank" || !question.examId || !store.exams.some((exam) => exam.id === question.examId))
    .filter((question) => !user || canUseExamQuestion(user, question))
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

export function isSubmittedExamAttempt(attempt: ExamAttempt) {
  return (attempt.status || "submitted") !== "in_progress";
}

export function examReport(user?: SessionUser) {
  const store = getStore();
  const visibleExams = user ? store.exams.filter((exam) => canAccessExam(user, exam)) : store.exams;
  const visibleExamIds = new Set(visibleExams.map((exam) => exam.id));
  const attempts = store.examAttempts.filter((attempt) => {
    if (!isSubmittedExamAttempt(attempt)) return false;
    if (!visibleExamIds.has(attempt.examId)) return false;
    if (!user) return true;
    if (!canManageTraining(user)) return attempt.userId === user.id;
    const owner = store.users.find((item) => item.id === attempt.userId);
    return Boolean(owner && canSeeOwner(user, owner.id, owner.teamId));
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

// ── 邮件中心：多账号收件同步 / 客户邮件速查 / 交互旅程 ───────────────────────
export let activeMailCenterSync: ReturnType<typeof getMailCenterSyncService> = null;

// ---------------------------------------------------------------------------
// W4 · 发信批次：冻结放行 + 受控投递通道
// ---------------------------------------------------------------------------

/** 批次投递 runtime 用的候选单发：资格复核 → 投递 → 触点登记 → 候选字段更新 */
export async function sendProspectBatchEmail(
  store: ReturnType<typeof getStore>,
  owner: ReturnType<typeof getStore>["users"][number],
  candidate: WebsiteOpportunity,
  recipient: string,
  subject: string,
  body: string,
  requestId: string
) {
  await store.reloadProspectQualificationTeam?.(owner.teamId);
  const eligibility = assertProspectEmailOutreachEligible(store, candidate, recipient, new Date().toISOString());
  const dispatch = await dispatchOutboundEmail(store, owner, {
    requestId,
    entityType: "prospect_candidate",
    entityId: candidate.id,
    to: eligibility.recipient,
    subject,
    body,
    source: "prospect_batch_send"
  });
  const sentAt = dispatch.log.sentAt;
  owner.lastDevelopmentEmailAt = sentAt;
  owner.lastDevelopmentEmailTo = eligibility.recipient;
  owner.lastDevelopmentEmailSubject = subject;
  candidate.lastDevelopmentEmailAt = sentAt;
  candidate.lastDevelopmentEmailTo = eligibility.recipient;
  candidate.lastDevelopmentEmailSubject = subject;
  await recordProspectTouchpoint(store, {
    candidate,
    actorId: owner.id,
    channel: "email",
    direction: "outbound",
    contactValue: eligibility.recipient,
    subject,
    content: body,
    requestId,
    occurredAt: sentAt,
    messageId: dispatch.log.messageId
  });
  await persistCandidateChanges(store, [candidate]);
  return { recipient: eligibility.recipient, sentAt, messageId: dispatch.log.messageId };
}

/** 批次发送成功的候选自动转线索（资格审核链已移除，直接建线索并保留搜客血缘） */
async function convertBatchCandidateToLead(
  store: ReturnType<typeof getStore>,
  owner: ReturnType<typeof getStore>["users"][number],
  candidate: WebsiteOpportunity,
  requestIdPrefix: string
) {
  if (candidate.status === "synced" && candidate.leadId) return candidate.leadId;
  const convertedAt = new Date().toISOString();
  const candidateEmail = (candidate.contactInfo || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0]
    || (candidate.extractedContacts || []).flatMap((item) => item.emails || [])[0]
    || candidate.lastDevelopmentEmailTo
    || "";
  const conversion = createLeadFromSource({
    ...owner,
    authVersion: owner.authVersion ?? 1
  } as SessionUser, {
    company: candidate.company,
    contact: candidate.contact,
    country: candidate.country,
    email: candidateEmail,
    phone: "",
    wechat: "",
    source: "智能获客人工确认",
    intent: "中",
    stage: "新线索",
    estimatedAmount: 0,
    nextFollowAt: "",
    remark: [candidate.business, candidate.description].filter(Boolean).join("；"),
    inquiryContent: "",
    sourceType: "outbound",
    sourceChannel: PROSPECT_LEAD_SOURCE_CHANNEL,
    sourceCampaign: (candidate.sourceLabel || "").slice(0, 120),
    externalId: candidate.id,
    sourceUrl: (candidate.website || "").slice(0, 500),
    occurredAt: convertedAt,
    rawPayload: {
      candidateId: candidate.id,
      tenantProspectId: candidate.tenantProspectId || "",
      organizationId: candidate.organizationId || "",
      convertedAt,
      via: requestIdPrefix,
      sourceEvidence: structuredClone(candidate.sourceEvidence || [])
    }
  });
  Object.assign(candidate, {
    status: "synced",
    leadId: conversion.lead.id,
    statusChangedAt: convertedAt,
    excludedReason: ""
  });
  migrateProspectFollowUpTodos(store, candidate, conversion.lead.id);
  await persistCandidateChanges(store, [candidate]);
  return conversion.lead.id;
}

function batchOwnerFor(batch: ProspectOutreachBatch) {
  const owner = getStore().users.find((item) => item.id === batch.ownerId && item.status === "active");
  if (!owner) throw new Error("批次所属账号不存在或已停用");
  return owner;
}

export function procurementContextForCandidate(candidate: WebsiteOpportunity) {
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

export function ownedCustomersFor(user: SessionUser, scope: "mine" | "team" = "mine") {
  return getStore().customers.filter((customer) => {
    if (isPublicCustomer(customer)) return false;
    return canSeeOwner(user, customer.ownerId, customer.teamId);
  });
}

export function findWritableCustomer(
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
    if (!isPlatformIdentity(user) && customer.teamId === user.teamId) {
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

// ---------------------------------------------------------------------------
// Leads (线索管理) — unified intake, follow-up and qualified conversion
// ---------------------------------------------------------------------------
const leadSourceTypes = ["outbound", "inbound", "offline", "referral", "import"] as const;

/** 归一化「公司名 + 国家」重复判定键：去首尾空格、压平空白、统一小写 */
export function entityDuplicateKey(company: string, country: string) {
  const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  return `${normalize(company)}|${normalize(country)}`;
}

export function findDuplicateLead(store: ReturnType<typeof getStore>, teamId: string, company: string, country: string, excludeId = "") {
  const key = entityDuplicateKey(company, country);
  return store.leads.find((item) =>
    item.id !== excludeId
    && item.teamId === teamId
    && entityDuplicateKey(item.company, item.country) === key
  );
}

export const leadWritableSchema = z.object({
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
  inquiryContent: z.string().max(20_000).optional().default(""),
  sourceType: z.enum(leadSourceTypes).optional().default("outbound"),
  sourceChannel: z.string().max(80).optional().default("manual"),
  sourceCampaign: z.string().max(120).optional().default(""),
  externalId: z.string().max(180).optional().default(""),
  sourceUrl: z.string().max(500).optional().default("")
});

export type LeadIntake = z.infer<typeof leadWritableSchema> & {
  occurredAt?: string;
  rawPayload?: unknown;
};

export function createLeadFromSource(user: SessionUser, input: LeadIntake) {
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
    inquiryContent: input.inquiryContent,
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
  notifyNewLead(lead);
  return { lead, sourceEvent, duplicate: false };
}

const pipelineStageRank: Record<string, number> = { "询盘": 1, "已联系": 2, "已报价": 3, "样品": 4, "谈判": 5, "成交": 6 };

export function customerGradeFromHealth(health: number) {
  if (health >= 85) return "A" as const;
  if (health >= 70) return "B" as const;
  if (health >= 55) return "C" as const;
  return "D" as const;
}

export function customerWithPipeline(customer: Customer, viewer?: SessionUser) {
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
    hasWonDeal: customer.lifecycleStatus === "won",
    lifecycleStatus: customer.lifecycleStatus || "open",
    wonDealCount: wonDeals.length,
    wonDealAmount: wonDeals.reduce((sum, deal) => sum + deal.amount, 0),
    lastWonAt: customer.wonAt || wonDeals
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

type BackgroundResearchEntity = "lead" | "customer" | "prospect";

const PROSPECT_STATUS_LABELS: Record<string, string> = {
  preview: "待核验预览",
  contactable: "可联系（已批准）",
  contacted: "已触达",
  synced: "已转线索/客户",
  excluded: "已排除"
};

interface BackgroundResearchSource {
  title: string;
  url: string;
  observedAt: string;
  detail?: string;
  authority?: string;
}

interface BackgroundResearchProviderCheck {
  providerId: string;
  providerName: string;
  status: "matched" | "empty" | "failed" | "skipped";
  matchCount: number;
  message: string;
}

interface BackgroundResearchFact {
  label: string;
  value: string;
  group?: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

interface BackgroundResearchAngleResult {
  angleId: string;
  angleName: string;
  facts: BackgroundResearchFact[];
  notes: string;
  sources: BackgroundResearchSource[];
  check: BackgroundResearchProviderCheck;
}

const BACKGROUND_RESEARCH_ANGLES: Array<{ id: string; name: string; focus: string }> = [
  {
    id: "identity",
    name: "主体识别",
    focus: "企业官网、注册主体与成立时间、总部地点、员工规模、主营业务。可搜索 \"<company> <country> official website\"、\"<company> company profile\" 等。"
  },
  {
    id: "business",
    name: "业务与产品",
    focus: "主要产品线与品牌、服务的行业与市场、B2B 平台与社媒足迹（阿里巴巴、Made-in-China、LinkedIn 公司页等）、经销与代理网络。"
  },
  {
    id: "trade",
    name: "贸易信号",
    focus: "进出口活动与海关贸易数据记录、从中国或第三方采购的线索、参展记录（广交会/行业展）、海外仓或采购办公室。"
  },
  {
    id: "risk",
    name: "风险与信用",
    focus: "诉讼与制裁合规名单、拖欠货款或贸易纠纷投诉、负面新闻、经营异常或破产信息。"
  }
];

interface BackgroundResearchAngleContext {
  entityType: string;
  company: string;
  country: string;
  business: string;
  products: string;
  grade: string;
  dealCount: number;
  website: string;
  knownContacts: string[];
}

function backgroundResearchAnglePrompt(angle: { id: string; name: string; focus: string }, context: BackgroundResearchAngleContext) {
  return [
    `联网调研目标企业（调研角度：${angle.name}）：${context.company}`,
    `已知国家或地区：${context.country}`,
    context.website ? `已知官网：${context.website}` : "",
    `我方业务背景：${context.business}${context.products && context.products !== "待核实" ? `；主推产品：${context.products}` : ""}${context.grade ? `；客户分级：${context.grade}` : ""}${context.dealCount ? `；历史商机 ${context.dealCount} 个` : ""}`,
    context.knownContacts.length ? `已掌握的联系方式（仅供消歧，勿重复调研）：${context.knownContacts.join("、")}` : "",
    `本角度调研重点：${angle.focus}`,
    "先判断搜索结果里的企业是否与目标企业为同一家（结合国家、业务背景判断）；同名但主体不符时不要采信其资料，并在 notes 里说明冲突。",
    "禁止引用 .cn、.hk、.mo、.tw 及中国境内网站。",
    "只返回一个 JSON 对象：{\"facts\":[{\"label\":\"\",\"value\":\"\",\"source\":\"\"}],\"notes\":\"\"}；facts 给 2~6 条，每条 value 控制在一句话以内且必须来自本次 Web Search 的引用，source 填该条事实对应引用的 URL；本角度确实查不到时返回空数组并在 notes 说明原因。"
  ].filter(Boolean).join("\n");
}

async function runNativeBackgroundResearchAngle(
  config: AiModelConfig,
  angle: { id: string; name: string; focus: string },
  context: BackgroundResearchAngleContext,
  timeoutMs: number
): Promise<BackgroundResearchAngleResult> {
  const emptyCheck = (status: BackgroundResearchProviderCheck["status"], message: string): BackgroundResearchAngleResult => ({
    angleId: angle.id,
    angleName: angle.name,
    facts: [],
    notes: "",
    sources: [],
    check: { providerId: `angle:${angle.id}`, providerName: angle.name, status, matchCount: 0, message }
  });
  try {
    const result = await callAiModelWithWebSearch(config, backgroundResearchAnglePrompt(angle, context), 10_000, undefined, timeoutMs);
    const citations = result.citations.filter((item) => nativeResearchCitationAllowed(item.url));
    if (!result.usedSearch || !citations.length) {
      return emptyCheck("failed", result.usedSearch ? "执行了联网搜索但没有返回合规引用" : "该角度未触发联网搜索");
    }
    const parsed = extractJsonObject(result.content) as Record<string, unknown>;
    const sourceByUrl = new Map(citations.map((item) => [item.url, item]));
    const facts: BackgroundResearchFact[] = Array.isArray(parsed.facts)
      ? (parsed.facts as unknown[]).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const row = item as Record<string, unknown>;
          if (typeof row.label !== "string" || typeof row.value !== "string") return [];
          const value = researchText(row.value, "");
          if (!value || value === "待核实") return [];
          const sourceUrl = typeof row.source === "string" && sourceByUrl.has(row.source) ? row.source : "";
          const citation = sourceUrl ? sourceByUrl.get(sourceUrl) : undefined;
          return [{
            label: row.label.slice(0, 60),
            value: value.slice(0, 300),
            group: angle.name,
            sourceUrl: sourceUrl || undefined,
            sourceTitle: citation ? citation.title || new URL(citation.url).hostname : undefined
          }];
        }).slice(0, 6)
      : [];
    const usedUrls = new Set(facts.map((fact) => fact.sourceUrl).filter(Boolean) as string[]);
    const sources = citations.map((citation) => ({
      title: citation.title || new URL(citation.url).hostname,
      url: citation.url,
      observedAt: new Date().toISOString(),
      detail: `${angle.name}角度来源`,
      authority: `angle:${angle.id}`
    }));
    return {
      angleId: angle.id,
      angleName: angle.name,
      facts,
      notes: typeof parsed.notes === "string" ? parsed.notes.trim().slice(0, 200) : "",
      sources,
      check: {
        providerId: `angle:${angle.id}`,
        providerName: angle.name,
        status: facts.length ? "matched" : sources.length ? "empty" : "failed",
        matchCount: facts.length,
        message: facts.length ? `${angle.name}命中 ${facts.length} 条事实、${sources.length} 个来源` : sources.length ? "有来源但没有提炼出可用事实" : "该角度未触发联网搜索"
      }
    };
  } catch (error) {
    const failure = providerErrorFromUnknown(error, "search");
    return emptyCheck("failed", failure.publicMessage);
  }
}

async function runNativeBackgroundResearchAngles(
  config: AiModelConfig | null,
  context: BackgroundResearchAngleContext
): Promise<{ angles: BackgroundResearchAngleResult[]; sources: BackgroundResearchSource[]; facts: BackgroundResearchFact[] }> {
  const providerName = config?.name || "模型原生 Web Search";
  if (!config?.enabled || !config.apiKey) {
    return {
      angles: BACKGROUND_RESEARCH_ANGLES.map((angle) => ({
        angleId: angle.id,
        angleName: angle.name,
        facts: [],
        notes: "",
        sources: [],
        check: {
          providerId: `angle:${angle.id}`,
          providerName: angle.name,
          status: "skipped" as const,
          matchCount: 0,
          message: "未配置可用 AI 模型"
        }
      })),
      sources: [],
      facts: []
    };
  }
  if (nativeResearchCountryBlocked(context.country)) {
    const skipped = BACKGROUND_RESEARCH_ANGLES.map((angle) => ({
      angleId: angle.id,
      angleName: angle.name,
      facts: [],
      notes: "",
      sources: [],
      check: {
        providerId: `angle:${angle.id}`,
        providerName: angle.name,
        status: "skipped" as const,
        matchCount: 0,
        message: "按合规策略，中国及相关地区不执行自动网页联网背调"
      }
    }));
    return { angles: skipped, sources: [], facts: [] };
  }
  const timeoutMs = aiSearchTimeoutMs();
  const angles = await Promise.all(
    BACKGROUND_RESEARCH_ANGLES.map((angle) => runNativeBackgroundResearchAngle(config, angle, context, timeoutMs))
  );
  const seenUrls = new Set<string>();
  const sources: BackgroundResearchSource[] = [];
  for (const angle of angles) {
    for (const source of angle.sources) {
      if (seenUrls.has(source.url)) continue;
      seenUrls.add(source.url);
      sources.push(source);
    }
  }
  const facts = angles.flatMap((angle) => angle.facts);
  return { angles, sources: sources.slice(0, 20), facts };
}

async function synthesizeBackgroundResearch(
  config: AiModelConfig,
  context: BackgroundResearchAngleContext,
  angles: BackgroundResearchAngleResult[],
  sources: BackgroundResearchSource[],
  crmFacts: Array<{ label: string; value: string }>
): Promise<Record<string, unknown> | null> {
  const prompt = [
    "你是外贸企业尽调分析师。基于以下多角度联网调研结果与 CRM 内部资料，输出一份高信息密度的综合背调结论。",
    "硬性要求：summary 3~5 句，必须综合多个来源写出这个公司具体是做什么的、规模与贸易活跃度，不得写空话；verdict 一句话；score 为 0~100 整数，依据证据数量、质量与风险给出并说明理由；opportunities 2~4 条，结合我方业务背景写具体的生意机会；talkTracks 2~4 条首聊切入点，必须落到对方的具体业务细节上，禁止'请问您需要什么'式客套；risks 按证据写，没有就给一条 low；nextAction 一条可执行动作。",
    "所有判断只能基于提供的事实、来源与 CRM 资料，不得编造。",
    "只返回一个 JSON 对象：{\"summary\":\"\",\"verdict\":\"\",\"score\":0,\"scoreReason\":\"\",\"opportunities\":[\"\"],\"talkTracks\":[\"\"],\"risks\":[{\"level\":\"high|medium|low\",\"title\":\"\",\"detail\":\"\"}],\"nextAction\":\"\"}",
    JSON.stringify({
      target: { company: context.company, country: context.country, website: context.website },
      crmFacts,
      angles: angles.map((angle) => ({
        angle: angle.angleName,
        status: angle.check.status,
        facts: angle.facts.map((fact) => ({ label: fact.label, value: fact.value })),
        notes: angle.notes
      })),
      sources: sources.map((source) => ({ title: source.title, url: source.url }))
    })
  ].join("\n");
  try {
    const parsed = extractJsonObject(await callAiModel(config, prompt, 16_000)) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
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
    (candidate.websiteProbeAttempts || []).filter((attempt) => attempt.evidence).slice(0, 1).forEach((attempt) => rows.push({
      title: "官网公开资料核验",
      url: attempt.evidence!.sourceUrl || attempt.sourceUrl,
      observedAt: attempt.evidence!.observedAt || attempt.completedAt,
      detail: [
        attempt.evidence!.legalName || attempt.evidence!.organizationName || attempt.evidence!.pageTitle,
        attempt.evidence!.businessCategory,
        attempt.evidence!.addressCountry
      ].filter(Boolean).join("；") || "官网公开信息验证",
      authority: "controlled_website"
    }));
  });
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.title}|${row.url}`;
    if ((!row.title && !row.url) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function nativeResearchCountryBlocked(country: string) {
  return /^(?:cn|china|中国|中国大陆|中华人民共和国|hk|hong kong|香港|mo|macau|澳门|tw|taiwan|台湾)$/iu.test(country.trim());
}

function nativeResearchCitationAllowed(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLocaleLowerCase("en-US").replace(/\.$/u, "");
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && ![".cn", ".hk", ".mo", ".tw", ".中国", ".公司", ".网络"].some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

async function ensureBackgroundResearchWebsiteProbe(
  user: SessionUser,
  candidates: WebsiteOpportunity[]
): Promise<BackgroundResearchProviderCheck | null> {
  const candidate = candidates.find((item) =>
    item.ownerId === user.id && /^https:\/\//iu.test(item.website || "")
  );
  if (!candidate) return null;
  const latest = candidate.websiteProbeAttempts?.[0];
  if (latest?.evidence) {
    return {
      providerId: "controlled_website",
      providerName: "官网公开资料核验",
      status: "matched",
      matchCount: 1,
      message: "已复用官网公开信息验证结果"
    };
  }
  if (latest && ["queued", "running"].includes(latest.status)) {
    return {
      providerId: "controlled_website",
      providerName: "官网公开资料核验",
      status: "skipped",
      matchCount: 0,
      message: "官网验证正在后台执行"
    };
  }
  if (["test", "e2e"].includes(process.env.NODE_ENV || "")) return null;
  try {
    await queueWebsiteProbe(getStore(), candidate, user.id, async (current) => {
      await persistCandidateChanges(getStore(), [current], false);
    }, { extractPublicContacts: websiteContactAiExtractor(user) });
    return {
      providerId: "controlled_website",
      providerName: "官网公开资料核验",
      status: "skipped",
      matchCount: 0,
      message: "已进入官网公开资料核验队列，完成后重新背调即可复用结果"
    };
  } catch (error) {
    return {
      providerId: "controlled_website",
      providerName: "官网公开资料核验",
      status: error instanceof WebsiteProbeError && error.code === "WEBSITE_PROBE_COUNTRY_BLOCKED" ? "skipped" : "failed",
      matchCount: 0,
      message: error instanceof Error ? error.message : "官网验证未能启动"
    };
  }
}

function backgroundResearchRisk(level: "high" | "medium" | "low", title: string, detail: string) {
  return { level, title, detail };
}

function researchText(value: unknown, fallback = "待核实") {
  const text = String(value || "").trim();
  return text && !["未知", "待维护", "待确认", "—"].includes(text) ? text : fallback;
}

export const backgroundResearchRequestSchema = z.object({
  entityType: z.enum(["lead", "customer", "prospect"]),
  entityId: z.string().trim().min(1).max(120),
  /** 本次背调由谁执行；省略则用团队「默认背调来源」 */
  source: z.enum(["crm", "ai", "cli"]).optional(),
  /** 走 CLI 时指定 Runner；省略则自动挑一台在线的 */
  runnerId: z.string().trim().max(80).optional()
});

/** 背调结论的完整载荷；CLI 通道会在骨架之上回填引擎产出的字段 */
interface BackgroundResearchPayload {
  id: string;
  entityType: BackgroundResearchEntity;
  entityId: string;
  company: string;
  country: string;
  score: number;
  verdict: string;
  summary: string;
  facts: BackgroundResearchFact[];
  opportunities: string[];
  risks: Array<{ level: "high" | "medium" | "low"; title: string; detail: string }>;
  contacts: Array<{ channel: string; value: string }>;
  sources: BackgroundResearchSource[];
  sourceChecks: BackgroundResearchProviderCheck[];
  nextAction: string;
  engine: string;
  talkTracks: string[];
  scoreReason: string;
  crmOnly: boolean;
  completedAt: string;
}

type BackgroundResearchOutcome =
  | { kind: "research"; research: BackgroundResearchPayload }
  | { kind: "cli"; skeleton: BackgroundResearchPayload; prompt: string }
  | null;

export async function buildBackgroundResearch(
  user: SessionUser,
  body: z.infer<typeof backgroundResearchRequestSchema>
): Promise<BackgroundResearchOutcome> {
  const store = getStore();
  const entityType = body.entityType as BackgroundResearchEntity;
  const lead = entityType === "lead"
    ? store.leads.find((item) => item.id === body.entityId && canSeeOwner(user, item.ownerId, item.teamId))
    : undefined;
  const customer = entityType === "customer"
    ? store.customers.find((item) => item.id === body.entityId && canSeeOwner(user, item.ownerId, item.teamId))
    : undefined;
  const prospect = entityType === "prospect"
    ? store.websiteOpportunities.find((item) => item.id === body.entityId && canSeeOwner(user, item.ownerId, item.teamId))
    : undefined;
  if (!lead && !customer && !prospect) return null;

  const ownerId = lead?.ownerId || customer?.ownerId || prospect!.ownerId;
  const teamId = lead?.teamId || customer?.teamId || prospect!.teamId;
  const linkedLeads = lead
    ? [lead]
    : prospect
      ? (prospect.leadId ? store.leads.filter((item) => item.id === prospect.leadId) : [])
      : store.leads.filter((item) => item.convertedCustomerId === customer!.id);
  const sourceEvents = store.leadSourceEvents.filter((event) =>
    linkedLeads.some((item) => item.id === event.leadId)
    && event.ownerId === ownerId
    && event.teamId === teamId
  );
  const candidates = prospect
    ? [prospect]
    : store.websiteOpportunities.filter((item) =>
      item.ownerId === ownerId
      && item.teamId === teamId
      && (lead ? item.leadId === lead.id : item.customerId === customer!.id || linkedLeads.some((linked) => linked.id === item.leadId))
    );
  const deals = customer ? store.deals.filter((deal) => deal.customerId === customer.id) : [];
  const activities = lead
    ? store.leadActivities.filter((item) => item.leadId === lead.id)
    : customer
      ? store.customerActivities.filter((item) => item.customerId === customer.id)
      : store.prospectTouchpoints.filter((item) => item.prospectCandidateId === prospect!.id);
  const suggestions = customer
    ? store.customerIntelligenceSuggestions.filter((item) => item.customerId === customer.id && item.teamId === teamId && item.ownerId === ownerId)
    : [];
  const company = lead?.company || customer?.company || prospect!.company;
  const country = researchText(lead?.country || customer?.country || prospect?.country);
  const config = getAiConfig(user, "scoring");
  const candidate = candidates[0];
  const business = researchText(candidate?.business || lead?.remark || deals[0]?.product, "尚无明确业务资料");
  const products = [
    ...deals.map((deal) => deal.product).filter(Boolean),
    researchText(prospect?.business, "")
  ].filter(Boolean).slice(0, 5).join("、");
  const researchContext: BackgroundResearchAngleContext = {
    entityType,
    company,
    country,
    business,
    products,
    grade: customer ? String(customer.grade || customerGradeFromHealth(customer.health)) : "",
    dealCount: deals.length,
    website: researchText(customer?.website || prospect?.website || candidate?.website, ""),
    knownContacts: [lead?.email, lead?.phone, customer?.email, customer?.phone].filter(Boolean).map(String).slice(0, 4)
  };
  const engineSettings = await readTeamAiEngineSettings(user.teamId);
  const researchSource = resolveEngineSource(body.source, engineSettings.researchSource, RESEARCH_ENGINE_SOURCES);
  // CLI 路径不在请求内做四路联网预检索与官网探针（2026-10-07 实测预检索 45s+，
  // 把「10 秒返回 202」的异步化形同虚设）：research skill 本来就要求 CLI 自己联网
  // 核查公开来源，CRM 只冻结 CRM 事实与硬约束进提示词，避免双重检索。
  const cliPresearch = researchSource === "cli";
  const anglesResult = cliPresearch
    ? { angles: [], sources: [] as BackgroundResearchSource[], facts: [] as BackgroundResearchFact[] }
    : await runNativeBackgroundResearchAngles(config, researchContext);
  const nativeSearchSucceeded = anglesResult.sources.length > 0 || anglesResult.facts.length > 0;
  const sourceChecks: BackgroundResearchProviderCheck[] = anglesResult.angles.map((angle) => angle.check);
  const websiteProbeCheck = cliPresearch ? null : await ensureBackgroundResearchWebsiteProbe(user, candidates);
  if (websiteProbeCheck) sourceChecks.push(websiteProbeCheck);
  const externalSources = anglesResult.sources;
  const sources = backgroundResearchSources(candidates, sourceEvents, [
    ...externalSources,
    ...suggestions.flatMap((item) =>
    [item.sourceUrl, ...item.evidenceRefs].filter(Boolean).map((url) => ({
      title: item.sourceLabel || "客户情报",
      url,
      observedAt: item.updatedAt || item.createdAt
    }))
  )]);
  const contactRows = lead
    ? [
        { channel: "联系人", value: researchText(lead.contact) },
        { channel: "邮箱", value: researchText(lead.email) },
        { channel: "电话", value: researchText(lead.phone) }
      ]
    : customer
      ? [
          { channel: "联系人", value: researchText(customer.contact) },
          { channel: "联系资料", value: researchText(customer.documentContact) }
        ]
      : [
          { channel: "联系人", value: researchText(prospect!.contact) },
          { channel: "公开联系方式", value: researchText(prospect!.contactInfo) },
          { channel: "官网邮箱", value: researchText((prospect!.extractedContacts || []).flatMap((item) => item.emails || []).join(" ")) }
        ];
  const nativeContacts = anglesResult.facts
    .filter((fact) => /邮箱|电话|联系|email|phone|whatsapp/iu.test(fact.label) || /@/.test(fact.value))
    .map((fact) => ({ channel: fact.label.slice(0, 40), value: fact.value.slice(0, 240) }))
    .slice(0, 5);
  const candidateContacts = candidates.flatMap((item) => [
    { channel: "公开联系人", value: researchText(item.contact) },
    { channel: "公开联系方式", value: researchText(item.contactInfo) }
  ]);
  const seenContacts = new Set<string>();
  const usefulContacts = [...contactRows, ...candidateContacts, ...nativeContacts]
    .filter((item) => item.value !== "待核实")
    .filter((item) => {
      const key = `${item.channel}|${item.value.toLocaleLowerCase("en-US")}`;
      if (seenContacts.has(key)) return false;
      seenContacts.add(key);
      return true;
    })
    .slice(0, 8);
  const nativeFacts = anglesResult.facts;
  const facts = (lead
    ? [
        { label: "主体", value: company },
        { label: "国家 / 地区", value: country },
        { label: "业务", value: business },
        { label: "来源", value: researchText(lead.source || lead.sourceChannel) },
        { label: "采购意向", value: researchText(lead.intent) },
        { label: "预估金额", value: lead.estimatedAmount > 0 ? `${lead.estimatedAmount.toLocaleString("en-US")} USD` : "待核实" }
      ]
    : customer
      ? [
          { label: "主体", value: company },
          { label: "国家 / 地区", value: country },
          { label: "业务", value: business },
          { label: "客户分级", value: customer.grade || customerGradeFromHealth(customer.health) },
          { label: "关联商机", value: `${deals.length} 个` },
          { label: "成交记录", value: deals.some((deal) => deal.stage === "成交") ? "有" : "无" }
        ]
      : [
          { label: "主体", value: company },
          { label: "国家 / 地区", value: country },
          { label: "业务", value: business },
          { label: "官网 / 域名", value: researchText(prospect!.website) },
          { label: "资格状态", value: PROSPECT_STATUS_LABELS[prospect!.status] || prospect!.status },
          { label: "匹配度", value: prospect!.confidence && prospect!.confidence > 0 ? `${prospect!.confidence}%` : "待核实" }
        ]).concat(nativeFacts).slice(0, 18) as BackgroundResearchFact[];
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

  // CLI 路径的结论由引擎回填（applyResearchEnginePatch 拿到来源会把 crmOnly 翻回 false），
  // 这里不把「跳过预检索」当成「没有公开网络证据」，避免前端误亮降级警告。
  const crmOnly = researchSource === "cli" ? false : !nativeSearchSucceeded;
  let score = Math.max(35, Math.min(94,
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
  let talkTracks: string[] = [];
  let scoreReason = "";
  let nextAction = risks[0]?.level === "high" ? "先完成企业主体与官网核验" : "安排一次需求确认并记录采购时间表";
  const onlineEvidenceCount = anglesResult.sources.length;
  const fallbackEngine = onlineEvidenceCount ? "CRM + 联网公开证据" : "CRM 证据分析（未联网）";
  let engine = fallbackEngine;

  const applyResearchResult = (parsed: Record<string, unknown>) => {
    if (typeof parsed.summary === "string" && parsed.summary.trim()) summary = parsed.summary.trim().slice(0, 900);
    if (typeof parsed.verdict === "string" && parsed.verdict.trim()) verdict = parsed.verdict.trim().slice(0, 80);
    if (Array.isArray(parsed.opportunities)) opportunities = parsed.opportunities.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 4);
    if (Array.isArray(parsed.talkTracks)) talkTracks = parsed.talkTracks.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 4);
    if (typeof parsed.scoreReason === "string" && parsed.scoreReason.trim()) scoreReason = parsed.scoreReason.trim().slice(0, 300);
    if (typeof parsed.score === "number" && Number.isFinite(parsed.score)) score = Math.max(30, Math.min(97, Math.round(parsed.score)));
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
  };

  if (researchSource === "ai" && nativeSearchSucceeded && config?.enabled && config.apiKey) {
    const synthesized = await synthesizeBackgroundResearch(
      config,
      researchContext,
      anglesResult.angles,
      anglesResult.sources,
      facts.filter((fact) => !fact.group).map((fact) => ({ label: fact.label, value: fact.value }))
    );
    if (synthesized) {
      applyResearchResult(synthesized);
      const matchedAngles = anglesResult.angles.filter((angle) => angle.check.status === "matched").length;
      engine = `${config.name || config.model} · 四路联网深挖（${matchedAngles}/${anglesResult.angles.length} 角度命中）`;
    } else {
      engine = fallbackEngine;
    }
  } else if (researchSource === "ai" && config?.enabled && config.apiKey) {
    const prompt = [
      "根据以下 CRM 事实与来源证据生成企业背调结论。只使用提供的数据，不得补充或猜测外部事实。",
      "只返回 JSON：{\"summary\":\"\",\"verdict\":\"\",\"opportunities\":[\"\"],\"risks\":[{\"level\":\"high|medium|low\",\"title\":\"\",\"detail\":\"\"}],\"nextAction\":\"\"}",
      JSON.stringify({ entityType, company, country, facts, contacts: usefulContacts, sources, activities: activities.slice(0, 6), deals: deals.slice(0, 5) })
    ].join("\n");
    try {
      const parsed = extractJsonObject(await callAiModel(config, prompt, 10000)) as Record<string, unknown>;
      applyResearchResult(parsed);
      engine = config.name || config.model;
    } catch {
      engine = fallbackEngine;
    }
  } else if (researchSource === "crm") {
    // 只用 CRM 自己的资料与规则，不调用任何模型：证照/来源核验慢或没额度时的保底通道
    engine = onlineEvidenceCount ? "CRM 本地证据 + 联网公开来源" : "CRM 本地证据分析（未联网、未调用模型）";
  }

  if (sourceChecks.length) {
    store.logs.unshift({
      id: `log_abr_${user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      level: onlineEvidenceCount ? "success" : "warning",
      category: "system",
      action: "ai_background_research",
      message: crmOnly
        ? `${company} 背调完成：未获取到公开网络证据，仅基于 CRM 资料分析`
        : `${company} 联网背调完成：${onlineEvidenceCount} 条同主体证据（四路角度）`,
      actorId: user.id,
      actorName: user.name,
      meta: {
        entityType,
        entityId: body.entityId,
        searchedAt: new Date().toISOString(),
        checks: sourceChecks,
        sources: externalSources.map((item) => ({ title: item.title, url: item.url, observedAt: item.observedAt, authority: item.authority }))
      },
      createdAt: new Date().toISOString(),
      ownerId: user.id,
      teamId: user.teamId
    });
    await store.persist().catch((error) => console.error("background research audit persist failed:", error));
  }

  const skeleton: BackgroundResearchPayload = {
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
    sourceChecks,
    nextAction,
    engine,
    talkTracks,
    scoreReason,
    crmOnly,
    completedAt: new Date().toISOString()
  };

  if (researchSource === "cli") {
    // 交给本机 CLI：CRM 这里只负责把事实与硬约束冻结成提示词，结论由引擎回填
    return {
      kind: "cli",
      skeleton,
      prompt: buildResearchCliPrompt({
        entityType,
        company,
        country,
        business,
        grade: researchContext.grade,
        website: researchContext.website,
        facts: facts.filter((fact) => !fact.group).map((fact) => ({ label: fact.label, value: fact.value })),
        contacts: usefulContacts,
        sources: externalSources
          .filter((item) => /^https?:\/\//iu.test(item.url))
          .map((item) => ({ title: item.title, url: item.url })),
        context: [
          ...activities.slice(0, 4).map((item) => `${String((item as { type?: unknown }).type || "互动")}：${String(item.content || "").slice(0, 120)}`),
          ...deals.slice(0, 3).map((deal) => `商机：${deal.product || "未填写产品"} / ${deal.stage || "未填写阶段"}`)
        ]
      })
    };
  }

  return { kind: "research", research: skeleton };
}


/**
 * 背调留档：每次背调都写一条 background_research_records。
 * 开发信档案页据此展示「这家客户历次背调」，也作为「留档」要求的落点。
 * 写库失败不影响背调结果返回（背调本身是只读分析）。
 */
export async function persistBackgroundResearchRecord(user: SessionUser, research: unknown) {
  const repository = getBackgroundResearchRepository();
  if (!repository) return;
  const data = (research || {}) as Record<string, unknown>;
  const entityId = String(data.entityId || "");
  const entityType = String(data.entityType || "");
  if (!entityId || !entityType) return;
  try {
    await repository.save({
      teamId: user.teamId,
      ownerId: user.id,
      entityType,
      entityId,
      company: String(data.company || ""),
      country: String(data.country || ""),
      score: Number(data.score || 0),
      verdict: String(data.verdict || ""),
      summary: String(data.summary || ""),
      engine: String(data.engine || ""),
      crmOnly: Boolean(data.crmOnly),
      payloadJson: JSON.stringify(data),
      createdBy: user.id
    });
  } catch (error) {
    console.error("background research record persist failed:", error);
  }
}

// ─────────────────────────────────────────────────────────────
// AI 执行引擎：把「背调 / 开发信」派给本机 CLI，并把结果收回 CRM
// ─────────────────────────────────────────────────────────────

export function publicEngineJob(job: AiEngineJob) {
  return {
    id: job.id,
    kind: job.kind,
    entityType: job.entityType,
    entityId: job.entityId,
    source: job.source,
    adapter: job.adapter,
    adapterLabel: job.adapter ? aiEngineAdapterLabel(job.adapter) : "",
    runnerId: job.runnerId,
    cliTaskId: job.cliTaskId,
    status: job.status,
    engine: job.engine,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  };
}

export function engineJobRepositoryOrNull() {
  return getAiEngineJobRepository();
}

type EngineCliOutcome =
  | { pending: false; payload: Record<string, unknown> }
  | { pending: true; engineJob: ReturnType<typeof publicEngineJob>; cliTaskId: string; runnerName: string; engine: string };

/**
 * 派一次 CLI 引擎任务。
 * 先建作业留档，再入队 CLI 任务，然后在同一个 HTTP 请求内等一小段时间：
 *   - 等到了：直接回结果（本机 CLI 实测 20-60 秒，多数情况能等到）
 *   - 没等到：回 202 + 作业号，前端轮询 /api/ai-engine/jobs/:id
 */
export async function runEngineCliJob(user: SessionUser, input: {
  kind: "research" | "email" | "search" | "tender";
  entityType: string;
  entityId: string;
  request: Record<string, unknown>;
  prompt: string;
  runnerId?: string;
  /**
   * 请求内的等待窗口；缺省用 engineInlineWaitMilliseconds()（HTTP 请求场景，75 秒）。
   * 后台补写工序会传更大的值——它不在 HTTP 请求里，等久一点比"没等到就降级"更划算。
   */
  waitMs?: number;
}): Promise<EngineCliOutcome> {
  const repository = engineJobRepositoryOrNull();
  if (!repository) {
    throw new EngineUnavailableError("AI_ENGINE_REPOSITORY_UNAVAILABLE", "背调/开发信走 CLI 需要 MySQL 持久化档位", 503);
  }
  const settings = await readTeamAiEngineSettings(user.teamId);
  const choice = await pickEngineRunner(user, { ...settings, runnerId: input.runnerId?.trim() || settings.runnerId });
  const jobId = await repository.create({
    id: "",
    teamId: user.teamId,
    ownerId: user.id,
    createdBy: user.id,
    kind: input.kind,
    entityType: input.entityType,
    entityId: input.entityId,
    source: "cli",
    adapter: choice.adapter,
    runnerId: choice.runnerId,
    cliTaskId: "",
    status: "running",
    engine: choice.cliVersion ? `${aiEngineAdapterLabel(choice.adapter)} ${choice.cliVersion}` : aiEngineAdapterLabel(choice.adapter),
    requestJson: JSON.stringify(input.request),
    resultJson: "",
    errorMessage: ""
  });
  const enqueued = await enqueueEngineCliTask(user, choice, input.prompt, clampAiEngineTimeout(settings.cliTimeoutSeconds),
    // 按实际派给的 CLI 取模型 / 档位（首选不可用时 choice.adapter 可能是另一个 CLI）
    engineCliProfile(settings, choice.adapter));
  await repository.setCliTask(jobId, enqueued.runnerId, enqueued.taskId, enqueued.engine);
  const job = await repository.get(jobId);
  if (!job) throw new EngineUnavailableError("AI_ENGINE_JOB_MISSING", "引擎作业创建失败", 500);

  const snapshot = await waitForEngineCliTask(user, enqueued.taskId, input.waitMs ?? engineInlineWaitMilliseconds(), 2_000,
    // 获客作业：请求内等待窗口也做增量入池——搜到一家就同步一家，不等任务结束。
    // 终态快照不同步（收尾函数会全量同步），避免两条路径竞争。
    (tick) => {
      if (input.kind === "search" && tick && !["succeeded", "failed", "cancelled"].includes(tick.status)) {
        void syncAcquisitionFindingsFromEvents(job, [...tick.events.map((event) => event.message), tick.resultText || ""])
          .catch(() => undefined);
      }
    });
  if (snapshot && snapshot.status !== "queued" && snapshot.status !== "claimed" && snapshot.status !== "running") {
    const payload = await finalizeEngineCliJob(user, job, snapshot);
    if (payload) return { pending: false, payload };
  }
  return {
    pending: true,
    engineJob: publicEngineJob(job),
    cliTaskId: enqueued.taskId,
    runnerName: enqueued.runnerName,
    engine: enqueued.engine
  };
}

/**
 * 降级收尾：CLI 正常跑完，但结果抠不出结构化 JSON。
 *
 * 以前这里一律判 failed（"本机 CLI 没有返回可解析的 JSON 结果，请查看集成中心的执行日志"），
 * 实际后果是：**CLI 已经产出的东西被整单作废**，用户除了"失败"什么都看不到。
 * 而真实原因通常只是输出被截断、原文写成了 Markdown 表格、或任务在收尾阶段被打断——
 * 这些情况下 `resultText` 里其实有可读内容，不该丢。
 *
 * 现在按 kind 分别处理（思路与 engine-output.ts 的 L4「诚实降级」一致）：
 *   - search：@@FOUND@@ 流式增量与最终 JSON 是**两条独立通道**。先把流式里已出现的公司收干净，
 *     再如实报入池数量——否则会出现「候选清单里明明有公司，界面却说任务失败」这种自相矛盾；
 *   - research：背调骨架本身就是 CRM 侧已核实的证据，引擎补丁读不到不代表这次背调没有价值；
 *   - tender：给一版带归因说明的空报告（宁空勿假），而不是让整天的日报显示不出来；
 *   - email：模板兜底的那份草稿仍然可用，标明「需人工润色」即可。
 */
async function finalizeEngineCliJobWithoutJson(
  user: SessionUser,
  job: AiEngineJob,
  snapshot: {
    resultText: string;
    outputTruncated?: boolean;
    events?: Array<{ eventType: string; message: string }>;
  }
): Promise<Record<string, unknown> | null> {
  const repository = engineJobRepositoryOrNull();
  if (!repository) return null;
  const finishedAt = new Date().toISOString();
  const context = (() => {
    try {
      return JSON.parse(job.requestJson || "{}") as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  // 原文摘要：即使结构读不出来，也要让用户能看到 CLI 到底说了什么
  const rawPreview = String(snapshot.resultText || "").replace(/\s+/gu, " ").trim().slice(0, 600);
  const cause = snapshot.outputTruncated
    ? "CLI 输出太长被截断，没能拿到完整 JSON"
    : rawPreview
      ? "CLI 返回的内容不是结构化 JSON（可能是 Markdown 表格或说明文字）"
      : "CLI 结束时没有返回任何内容";

  if (job.kind === "search") {
    const query = (context.query || {}) as Record<string, unknown>;
    await syncAcquisitionFindingsFromEvents(job, [
      ...(snapshot.events || []).map((event) => event.message),
      snapshot.resultText || ""
    ]);
    const since = String(job.createdAt || "");
    const rescued = getStore().websiteOpportunities.filter((item) =>
      item.ownerId === job.ownerId
      && item.source === "cli_acquisition"
      && (!since || item.createdAt >= since)
    ).length;
    const message = rescued > 0
      ? `${cause}；但执行过程中的流式输出里已有 ${rescued} 家企业入池，可在候选清单查看`
      : `${cause}，本次没有可用的获客结果，建议重新查询`;
    const succeeded = rescued > 0;
    const payload = {
      acquisition: { rawCount: rescued, created: rescued, evidenceUpdated: 0, unchanged: 0, excluded: 0, query },
      engineJob: publicEngineJob({ ...job, status: succeeded ? "succeeded" : "failed", finishedAt, errorMessage: succeeded ? "" : message }),
      degraded: true,
      rawPreview,
      message,
      pending: false
    };
    await repository.finish(job.id, succeeded ? "succeeded" : "failed", succeeded ? JSON.stringify(payload) : "", succeeded ? "" : message);
    return payload;
  }

  if (job.kind === "research") {
    const skeleton = context.skeleton as BackgroundResearchPayload | undefined;
    if (skeleton) {
      const research: BackgroundResearchPayload = {
        ...skeleton,
        engine: job.engine || skeleton.engine,
        completedAt: finishedAt,
        summary: skeleton.summary || `本机 CLI 未返回可解析的结论（${cause}），以下为 CRM 侧已核实的证据。`
      };
      await persistBackgroundResearchRecord(user, research);
      const payload = {
        research,
        applied: [],
        degraded: true,
        rawPreview,
        message: `背调已按 CRM 侧证据落档；${cause}`,
        engineJob: publicEngineJob({ ...job, status: "succeeded", finishedAt, errorMessage: "" }),
        pending: false
      };
      await repository.finish(job.id, "succeeded", JSON.stringify(payload), "");
      return payload;
    }
  }

  if (job.kind === "tender") {
    const report: TenderDailyReport = normalizeTenderReport(null, {
      engine: job.engine || "本机 CLI",
      completedAt: finishedAt,
      reportDate: typeof context.reportDate === "string" ? context.reportDate : finishedAt.slice(0, 10)
    });
    report.notes = [`${cause}${rawPreview ? `；返回内容摘要：${rawPreview.slice(0, 200)}` : ""}`];
    const payload = {
      report,
      degraded: true,
      rawPreview,
      message: cause,
      engineJob: publicEngineJob({ ...job, status: "succeeded", finishedAt, errorMessage: "" }),
      pending: false
    };
    await repository.finish(job.id, "succeeded", JSON.stringify(payload), "");
    return payload;
  }

  // 开发信：模板兜底的那份草稿仍然可用，用户要的是「有信可改」而不是「任务失败」
  const template = (context.response || {}) as Record<string, unknown>;
  const draft = { ...((template.draft || {}) as Record<string, unknown>) };
  const fallbackBody = String(draft.body || "");
  const brief = context.brief as DevelopmentEmailBrief | undefined;
  const message = `${cause}，已改用基础模板草稿，请人工润色后发送`;
  if (!fallbackBody) {
    await repository.finish(job.id, "failed", "", message);
    return {
      pending: false,
      failed: true,
      engineJob: publicEngineJob({ ...job, status: "failed", finishedAt, errorMessage: message }),
      message,
      rawPreview
    };
  }
  const finalSubject = String(draft.subject || "").slice(0, 160);
  const finalBody = ensureDevelopmentEmailSignature(fallbackBody.slice(0, 5600), String(context.signatureText || "")).slice(0, 6000);
  const payload: Record<string, unknown> = recalibrateDevelopmentEmailPayload({
    ...template,
    draft: { ...draft, subject: finalSubject, body: finalBody },
    quality: brief ? checkDevelopmentEmailDraft({ subject: finalSubject, body: finalBody }, brief) : null,
    degraded: true,
    rawPreview,
    message,
    engineJob: publicEngineJob({ ...job, status: "succeeded", finishedAt, errorMessage: "" }),
    pending: false
  }, brief, finalSubject, finalBody);
  await repository.finish(job.id, "succeeded", JSON.stringify(payload), "");
  return payload;
}

/**
 * 用 CLI **实际写出来的**正文重算「依据 + 为什么这么写」。
 *
 * 为什么必须重算：走 CLI 时响应体在提交作业前就已经冻结了（那时用的是模板草稿），
 * CLI 回来的是另一封信。不重算的话，面板上的「为什么这么写」描述的是一封
 * 根本没发出去的信 —— 这是"依据面板说假话"的另一个入口。
 */
function recalibrateDevelopmentEmailPayload(
  payload: Record<string, unknown>,
  brief: DevelopmentEmailBrief | undefined,
  subject: string,
  body: string
): Record<string, unknown> {
  if (!brief) return payload;
  const current = payload.brief;
  if (!current || typeof current !== "object") return payload;
  const calibrated = finalizePersonalization(brief.personalization, { subject, body }, brief);
  return {
    ...payload,
    brief: {
      ...(current as Record<string, unknown>),
      personalization: {
        hook: calibrated.hook,
        relevance: calibrated.relevance,
        subjectAngle: calibrated.subjectAngle,
        ask: calibrated.ask,
        factsUsed: calibrated.factsUsed,
        angles: calibrated.angles,
        trace: calibrated.trace,
        difference: calibrated.difference,
        reasons: calibrated.reasons,
        personalized: calibrated.personalized
      }
    }
  };
}

/**
 * 收尾：把 CLI 的文本结果解析成 CRM 结构，落档，并生成与直接调用完全一致的响应体。
 * 同一作业只会成功收尾一次（成功后 status 变为 succeeded，轮询接口直接返回留档结果）。
 */
export async function finalizeEngineCliJob(
  user: SessionUser,
  job: AiEngineJob,
  snapshot: {
    status: string;
    resultText: string;
    errorMessage: string;
    outputTruncated?: boolean;
    events?: Array<{ eventType: string; message: string }>;
  }
): Promise<Record<string, unknown> | null> {
  const repository = engineJobRepositoryOrNull();
  if (!repository) return null;
  const context = (() => {
    try {
      return JSON.parse(job.requestJson || "{}") as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();

  if (snapshot.status !== "succeeded") {
    const reason = snapshot.status === "cancelled"
      ? "本机 CLI 任务已被取消"
      : snapshot.errorMessage || "本机 CLI 执行失败";
    await repository.finish(job.id, "failed", "", reason);
    return {
      pending: false,
      failed: true,
      engineJob: publicEngineJob({ ...job, status: "failed", errorMessage: reason, finishedAt: new Date().toISOString() }),
      message: reason
    };
  }

  const parsed = extractEngineJson(snapshot.resultText);
  if (!parsed) {
    // 抠不出 JSON ≠ 挖不到东西。见 finalizeEngineCliJobWithoutJson 的说明。
    return finalizeEngineCliJobWithoutJson(user, job, snapshot);
  }

  const finishedAt = new Date().toISOString();
  const doneJob = { ...job, status: "succeeded" as const, finishedAt };
  if (job.kind === "search") {
    // 获客作业收尾：把 CLI 找到的公司直接同步进候选清单（website_opportunities）。
    // 无论用户还在不在页面上，这一步都必须发生——补收工序也会走这里。
    const query = (context.query || {}) as Record<string, unknown>;
    const companies = normalizeAcquisitionCompanies(parsed);
    const acquisition = await syncAcquisitionCandidates(user, query, companies);
    const payload = { acquisition: { ...acquisition, query }, engineJob: publicEngineJob(doneJob), pending: false };
    await repository.finish(job.id, "succeeded", JSON.stringify(payload), "");
    return payload;
  }
  if (job.kind === "research") {
    const skeleton = context.skeleton as BackgroundResearchPayload | undefined;
    if (!skeleton) {
      const reason = "引擎作业缺少背调骨架，无法回填结果";
      await repository.finish(job.id, "failed", "", reason);
      return { pending: false, failed: true, engineJob: publicEngineJob({ ...job, status: "failed", errorMessage: reason, finishedAt }), message: reason };
    }
    const { research, applied } = applyResearchEnginePatch(skeleton, parsed);
    research.engine = job.engine || research.engine;
    research.completedAt = finishedAt;
    await persistBackgroundResearchRecord(user, research);
    const payload = { research, engineJob: publicEngineJob(doneJob), applied, pending: false };
    await repository.finish(job.id, "succeeded", JSON.stringify(payload), "");
    return payload;
  }
  if (job.kind === "tender") {
    // 海外竞标日报收尾：规范化 CLI 的 JSON 结果并落档（ai_engine_jobs 即留档，
    // 不另建表）；空清单是合法结果——「宁空勿假」契约，前端会渲染空态。
    const report: TenderDailyReport = normalizeTenderReport(parsed, {
      engine: job.engine || "本机 CLI",
      completedAt: finishedAt,
      reportDate: typeof context.reportDate === "string" ? context.reportDate : finishedAt.slice(0, 10)
    });
    const payload = { report, engineJob: publicEngineJob(doneJob), pending: false };
    await repository.finish(job.id, "succeeded", JSON.stringify(payload), "");
    return payload;
  }

  const template = (context.response || {}) as Record<string, unknown>;
  const brief = context.brief as DevelopmentEmailBrief | undefined;
  const patch = normalizeEmailPatch(parsed);
  const draft = { ...((template.draft || {}) as Record<string, unknown>) };
  const fallbackBody = String(draft.body || "");
  if (!patch.body && !fallbackBody) {
    const reason = "引擎返回的开发信缺少正文，已丢弃";
    await repository.finish(job.id, "failed", "", reason);
    return { pending: false, failed: true, engineJob: publicEngineJob({ ...job, status: "failed", errorMessage: reason, finishedAt }), message: reason };
  }
  // 模型 / CLI 整段省略落款是实测发生过的，落款属于「按我的身份写信」的一部分 → 硬兜底补上
  const signatureText = String(context.signatureText || "");
  const finalSubject = (patch.subject || String(draft.subject || "")).slice(0, 160);
  const finalBody = ensureDevelopmentEmailSignature((patch.body || fallbackBody).slice(0, 5600), signatureText).slice(0, 6000);
  const finalDraft = { ...draft, subject: finalSubject, body: finalBody, engine: job.engine || String(draft.engine || "") };
  const payload: Record<string, unknown> = recalibrateDevelopmentEmailPayload({
    ...template,
    draft: finalDraft,
    quality: brief ? checkDevelopmentEmailDraft({ subject: finalSubject, body: finalBody }, brief) : null,
    engineJob: publicEngineJob(doneJob),
    pending: false
  }, brief, finalSubject, finalBody);
  const readiness = payload.readiness as Record<string, unknown> | undefined;
  if (readiness && typeof readiness === "object") {
    readiness.aiGenerated = true;
    readiness.aiConfigName = job.engine || (job.adapter ? aiEngineAdapterLabel(job.adapter) : "本机 CLI");
    readiness.aiError = "";
  }
  await repository.finish(job.id, "succeeded", JSON.stringify(payload), "");
  return payload;
}

let aiEngineRecoveryTimer: NodeJS.Timeout | null = null;
let aiEngineRecoveryBusy = false;

/**
 * 收尾「没人认领」的 CLI 引擎作业。
 *
 * 背景：走 CLI 时前端会一直轮询 /api/ai-engine/jobs/:id 直到出结果。但用户完全可能
 * 关掉页面/断网——这时作业会永远停在 running，result_json 空着，留档链就断了。
 * 所以这里做一次兜底：把已经跑完（或失败）但没人收尾的作业补记进档案。
 *
 * 只处理「建了超过 2 分钟」的作业：刚建的作业还在请求内的等待窗口里，不抢。
 */
async function recoverEngineCliJobs(reason: string) {
  const repository = engineJobRepositoryOrNull();
  if (!repository || aiEngineRecoveryBusy) return;
  aiEngineRecoveryBusy = true;
  try {
    const running = await repository.listRunning(50);
    let recovered = 0;
    for (const job of running) {
      const age = Date.now() - new Date(job.createdAt).getTime();
      if (!Number.isFinite(age) || age < 120_000) continue;
      const owner = getStore().users.find((item) => item.id === job.ownerId);
      if (!owner) {
        await repository.finish(job.id, "failed", "", "作业归属账号已不存在，无法收尾");
        recovered += 1;
        continue;
      }
      // 用「作业归属人」的身份读任务，避免越权；读不到（任务被清理）就留给人工核查。
      const snapshot = await readEngineCliTask(publicUser(owner), job.cliTaskId);
      // 关页面也不丢实时性：清扫器顺路把事件流里的 @@FOUND@@ 发现补同步进候选清单
      if (job.kind === "search" && snapshot) {
        void syncAcquisitionFindingsFromEvents(job, [
          ...snapshot.events.map((event) => event.message),
          snapshot.resultText || ""
        ]).catch(() => undefined);
      }
      if (!snapshot || !cliTaskDone(snapshot.status)) continue;
      await finalizeEngineCliJob(publicUser(owner), job, snapshot);
      recovered += 1;
    }
    if (recovered) console.log(`GoodJob CRM recovered ${recovered} unfinished AI engine job(s) (${reason})`);
  } catch (error) {
    console.error("AI engine job recovery failed", error);
  } finally {
    aiEngineRecoveryBusy = false;
  }
}

function startAiEngineRecoveryScheduler() {
  if (process.env.AI_ENGINE_RECOVERY === "false") {
    console.log("GoodJob CRM AI engine job recovery disabled (AI_ENGINE_RECOVERY=false)");
    return;
  }
  const pollMs = Math.max(60_000, Number(process.env.AI_ENGINE_RECOVERY_POLL_MS || 300_000) || 300_000);
  aiEngineRecoveryTimer = setInterval(() => void recoverEngineCliJobs("scheduled"), pollMs);
  void recoverEngineCliJobs("startup");
}

function stopAiEngineRecoveryScheduler() {
  if (aiEngineRecoveryTimer) clearInterval(aiEngineRecoveryTimer);
  aiEngineRecoveryTimer = null;
}

// ── CLI 获客（引擎 kind=search）─────────────────────────────────────────────
//
// 获客走「本机 CLI + 获客技能」的口径：提示词里内嵌 prospecting skill 的硬约束
// （只用公开来源、先核实再产出、禁止编造），CLI 返回公司清单后，CRM 直接把结果
// 同步进候选清单（website_opportunities），与数据源搜索结果共用同一套
// 去重/合并/验证报告逻辑（persistProviderOpportunities）。
// 作业留档在 ai_engine_jobs（kind=search），result_json 存「找到几家、新增几条、
// 合并几条」，随时候可查；用户中途关页面也不会丢——补收工序同样走 finalize 收尾同步。

/** CLI 引擎任务（获客/背调/写信）在 HTTP 请求内的等待窗口 */
export function engineRequestWaitMs() {
  // CLI 任务动辄 1-5 分钟：内联等待只用来「给任务创建 + 前几秒执行留时间」，
  // 到点一律返回 202+jobId 交给前端轮询。以前默认等 75~180 秒——HTTP 请求挂死、
  // 界面像同步阻塞，等待动画要等响应回来才出现（2026-10-07 用户复盘：获客先改，
  // 背调/写信入口同日跟进）。需要旧行为可用环境变量调回（ACQUIRE 为兼容旧名保留）。
  const configured = Number(process.env.AI_ENGINE_REQUEST_WAIT_MS || process.env.AI_ENGINE_ACQUIRE_WAIT_MS || 10_000);
  if (!Number.isFinite(configured)) return 10_000;
  return Math.max(5_000, Math.min(600_000, Math.floor(configured)));
}

function acquisitionEvidenceSnapshot(
  record: EngineAcquisitionCompany,
  ownerId: string,
  observedAt: string
): ProviderEvidenceSnapshot {
  const payload = JSON.stringify({ ...record, ownerId });
  return {
    providerId: "cli_acquisition",
    providerRecordId: createHash("sha256").update(`${record.company}|${record.website || ""}`).digest("hex").slice(0, 32),
    officialWebsite: record.website,
    sourceUrl: record.sourceUrl || record.website,
    recordType: "company",
    fetchedAt: observedAt,
    payloadHash: createHash("sha256").update(payload).digest("hex"),
    evidenceSummary: record.description || record.business || record.company,
    matchedFields: ["company"],
    adapterVersion: "cli-acquisition-v1",
    catalogPolicyVersion: "1",
    sourceLevel: "public_web",
    retentionPolicyRef: "default"
  };
}

/** 把 CLI 找到的公司同步进候选清单；返回写进作业留档的汇总 */
async function syncAcquisitionCandidates(
  owner: SessionUser,
  query: Record<string, unknown>,
  companies: EngineAcquisitionCompany[]
) {
  const store = getStore();
  const observedAt = new Date().toISOString();
  // 用户口径：CLI 获客只要「决策人或采购人邮箱」。没有这种联系人的公司一律不入池，
  // 但要如实回报被挡掉多少家——否则用户只看到「返回 12 家、新增 3 条」会以为程序漏数据。
  const accepted = companies.filter((record) => record.qualified);
  const rejected = companies.length - accepted.length;
  const opportunities: WebsiteOpportunity[] = accepted.map((record) => {
    const primary = acquisitionPrimaryContact(record);
    return {
      id: `web_cli_${randomUUID()}`,
      company: record.company,
      business: record.business || "待维护",
      country: record.country || "未知",
      website: record.website,
      contact: primary.contact,
      contactInfo: primary.contactInfo,
      description: record.description || "本机 CLI 获客候选，待业务员核实。",
      ownerId: owner.id,
      teamId: owner.teamId,
      status: "preview" as const,
      createdAt: observedAt,
      parseMode: "rule" as const,
      source: "cli_acquisition",
      sourceLabel: "本机 CLI 获客",
      sourceEvidence: [acquisitionEvidenceSnapshot(record, owner.id, observedAt)],
      confidence: record.confidence ?? undefined,
      // extracted_contacts_json 是候选池既有的结构化联系人字段（网页抽取也写这里），
      // CLI 找到的人写同一处：候选详情、角色徽章、发信收件人都能直接读到，无需新表新列。
      extractedContacts: acquisitionExtractedContacts(record, observedAt)
    };
  });
  const { opportunities: touched, incrementalStats } = persistProviderOpportunities(opportunities, {
    rawCount: accepted.length,
    deduplicatedCount: 0
  });
  // 候选清单接口每次读取都会 reloadProspectCandidates() 把内存打回 MySQL 状态，
  // 全量 persist 又要几分钟才轮到——内存态新插入会被 reload 抹掉（2026-10-06 实锤）。
  // 所以这里必须走 persistProspectCandidates 定向立即写库，保证增量结果「搜到即落库」。
  await persistCandidateChanges(store, touched, false);
  return {
    rawCount: companies.length,
    qualifiedCount: accepted.length,
    rejected,
    created: incrementalStats.newCount,
    evidenceUpdated: incrementalStats.evidenceUpdatedCount,
    unchanged: incrementalStats.unchangedCount,
    excluded: incrementalStats.excludedCount,
    query
  };
}

// ── 获客作业增量入池：CLI 每核实一家就输出一行 @@FOUND@@ {...} ─────────────────
// 提示词（buildAcquisitionCliPrompt）要求 CLI 边搜边打标记行；这里从任务事件流
// （assistant 文本，Runner 实时推给 CRM 存档）里逐行抠出来、去重后立刻入池，
// 不再等整个任务结束。搜到多少返回多少，用户在候选清单里实时可见。
/** 每个作业已同步过的发现签名（company|website），避免轮询重复触发；进程重启后丢失也只是多跑一次幂等同步 */
const acquisitionFindingsSeen = new Map<string, Set<string>>();

function acquisitionFindingKey(record: EngineAcquisitionCompany) {
  return `${record.company.trim().toLowerCase()}|${record.website.trim().toLowerCase()}`;
}

/** 把作业事件流里还没同步过的发现同步进候选清单；返回该作业累计已同步数（供前端实时展示） */
export async function syncAcquisitionFindingsFromEvents(job: AiEngineJob, texts: string[]): Promise<number> {
  if (job.kind !== "search") return 0;
  const findings = extractAcquisitionFindings(texts.join("\n"));
  // 增量入池同样按「决策人/采购人邮箱」准入：没有合格联系人的公司不落库，
  // 但留在 findings 里被 dedupe 记一次，避免同一家被反复重试。
  const qualified = findings.filter((record) => record.qualified);
  let seen = acquisitionFindingsSeen.get(job.id);
  if (!seen) {
    seen = new Set();
    acquisitionFindingsSeen.set(job.id, seen);
  }
  // 只对「已入池」的公司记签名：未被准入的记录下一拍还能重试（模型可能后补联系人），
  // 不会被这一拍的 seen 永久封死。
  const fresh = qualified.filter((record) => {
    const key = acquisitionFindingKey(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (fresh.length) {
    // 候选归属必须是作业创建人（管理员代查时也不能算到管理员头上）
    const owner = getStore().users.find((item) => item.id === job.ownerId);
    if (owner) {
      const context = (() => {
        try {
          return JSON.parse(job.requestJson || "{}") as Record<string, unknown>;
        } catch {
          return {} as Record<string, unknown>;
        }
      })();
      await syncAcquisitionCandidates(publicUser(owner), (context.query || {}) as Record<string, unknown>, fresh);
    }
  }
  return seen.size;
}

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

export function companyProfileForTeam(teamId: string) {
  const explicit = getStore().companyProfiles.find((item) => item.teamId === teamId);
  const base = explicit || blankCompanyProfile(teamId);
  // 公司资料为空时，用本团队「默认抬头」补齐发件身份。
  // 原因：业务员通常已经维护过单证抬头，却不会再去填一份重复的公司资料
  // → 开发信里只能自称 "our company"、官网/地址全缺（实测困扰，信的说服力大打折扣）。
  // 严格只补空缺字段，绝不覆盖已填写的公司资料。
  const letterhead = (getStore().documentLetterheads || [])
    .filter((item) => item.teamId === teamId && item.enabled !== false && Boolean(item.companyName))
    .sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)))[0];
  if (!letterhead) return base;
  return {
    ...base,
    companyName: base.companyName || letterhead.companyName,
    website: base.website || letterhead.website || "",
    address: base.address || letterhead.address || "",
    phone: base.phone || letterhead.phone || "",
    email: base.email || letterhead.email || ""
  };
}

function defaultTeamSystemSettings(teamId: string): TeamSystemSettings {
  return {
    teamId,
    requireDocumentExcelApproval: false,
    productCategories: [],
    ocrProviderConfigEncrypted: "",
    updatedBy: "",
    updatedAt: ""
  };
}

export function teamSystemSettingsForTeam(teamId: string) {
  const settings = getStore().teamSystemSettings.find((item) => item.teamId === teamId)
    || defaultTeamSystemSettings(teamId);
  settings.productCategories ||= [];
  return settings;
}

export function ocrProviderCredentialContext(teamId: string) {
  return { id: `ocr_team_${teamId}`, providerId: "trade-document-ocr", ownerId: teamId, teamId };
}

function defaultTradeDocumentOcrProvider(): TradeDocumentOcrProviderConfig {
  return { provider: "none", enabled: false, apiKey: "", secretKey: "", model: "", baseUrl: "" };
}

export function tradeDocumentOcrProviderForTeam(teamId: string) {
  const settings = teamSystemSettingsForTeam(teamId);
  if (!settings.ocrProviderConfigEncrypted) return defaultTradeDocumentOcrProvider();
  try {
    const decrypted = decryptProviderConfiguration(ocrProviderCredentialContext(teamId), settings.ocrProviderConfigEncrypted);
    const value = JSON.parse(decrypted.apiKey) as Partial<TradeDocumentOcrProviderConfig>;
    const provider = value.provider === "baidu" || value.provider === "siliconflow" ? value.provider : "none";
    return {
      provider,
      enabled: Boolean(value.enabled) && provider !== "none",
      apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
      secretKey: typeof value.secretKey === "string" ? value.secretKey : "",
      model: typeof value.model === "string" ? value.model : "",
      baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : ""
    } satisfies TradeDocumentOcrProviderConfig;
  } catch {
    return defaultTradeDocumentOcrProvider();
  }
}

export function developmentEmailEntity(user: SessionUser, entityType: BackgroundResearchEntity, entityId: string) {
  const store = getStore();
  if (entityType === "lead") {
    const lead = store.leads.find((item) => item.id === entityId && canSeeOwner(user, item.ownerId, item.teamId));
    if (!lead) return null;
    return {
      entityType,
      lead,
      customer: undefined,
      prospect: undefined,
      company: lead.company,
      companyFullName: lead.company,
      contactName: lead.contact || "there",
      email: lead.email || "",
      country: lead.country || "",
      context: lead.remark || `${lead.intent || ""} intent · ${lead.source || "CRM lead"}`
    };
  }
  if (entityType === "prospect") {
    const candidate = store.websiteOpportunities.find((item) => item.id === entityId && canSeeOwner(user, item.ownerId, item.teamId));
    if (!candidate) return null;
    const extractedEmails = (candidate.extractedContacts || []).flatMap((item) => item.emails || []).join(" ");
    const email = `${candidate.contactInfo} ${candidate.contact} ${extractedEmails}`
      .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
    return {
      entityType,
      lead: undefined,
      customer: undefined,
      prospect: candidate,
      company: candidate.company,
      companyFullName: candidate.company,
      contactName: candidate.contact || "there",
      email,
      country: candidate.country || "",
      context: candidate.business || candidate.description.slice(0, 200) || "product sourcing prospect"
    };
  }
  const customer = store.customers.find((item) => item.id === entityId && canSeeOwner(user, item.ownerId, item.teamId));
  if (!customer) return null;
  // 客户记录有独立的 email 列，且实测 17/17 有邮箱的客户其 contact 文本里并不含邮箱。
  // 只从文本正则抓 → 这些客户在开发信工作区会全部显示"缺收件邮箱"、发不出去（踩过）。
  const contactTextEmail = `${customer.documentContact || ""} ${customer.contact || ""}`.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const emailColumn = (customer.email || "").trim();
  const email = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(emailColumn) ? emailColumn : contactTextEmail;
  const deals = store.deals.filter((deal) => deal.customerId === customer.id);
  return {
    entityType,
    lead: undefined,
    customer,
    prospect: undefined,
    company: customer.company,
    contactName: customer.contact || "there",
    email,
    country: customer.country || "",
    context: deals[0]?.product || customer.defaultIncoterm || "existing business relationship"
  };
}

export function developmentEmailReadiness(user: ReturnType<typeof getStore>["users"][number], profile: CompanyProfile) {
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

export function developmentEmailEnglishContext(value: string) {
  const text = value.trim();
  return text && !/[\u3400-\u9fff]/u.test(text)
    ? text
    : "your sourcing and product development needs";
}

/**
 * 取这家客户最近一次背调留档；没有仓库或查询失败时返回 null，绝不阻断写信流程。
 * ⚠️ entityType 必须用开发信口径（lead / customer / prospect）——背调留档是按请求口径存的，
 * 而 journey 内部用的是 prospect_candidate，两者不能混（混了会静默查不到背调）。
 */
export async function latestBackgroundResearch(
  user: SessionUser,
  entityType: "lead" | "customer" | "prospect",
  entityId: string
): Promise<BackgroundResearchRecord | null> {
  const repository = getBackgroundResearchRepository();
  if (!repository) return null;
  try {
    const records = await repository.list(user.teamId, entityType, entityId, 1);
    return records[0] || null;
  } catch (error) {
    console.error("background research read failed:", error);
    return null;
  }
}

/** 把背调留档还原成开发信蓝图需要的结构化输入（事实 / 机会 / 话术线索 / 风险） */
export function developmentEmailResearchInput(record: BackgroundResearchRecord | null) {
  if (!record) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(record.payloadJson || "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const strList = (value: unknown, limit: number) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, limit)
      : [];
  const facts = Array.isArray(payload.facts)
    ? payload.facts.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      const label = typeof raw.label === "string" ? raw.label : "";
      const value = typeof raw.value === "string" ? raw.value : "";
      return label || value ? [{ label, value }] : [];
    }).slice(0, 18)
    : [];
  const risks = Array.isArray(payload.risks)
    ? payload.risks.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      return [{
        level: typeof raw.level === "string" ? raw.level : "",
        title: typeof raw.title === "string" ? raw.title : "",
        detail: typeof raw.detail === "string" ? raw.detail : ""
      }];
    }).slice(0, 4)
    : [];
  return {
    verdict: record.verdict,
    summary: record.summary,
    score: record.score,
    engine: record.engine,
    nextAction: typeof payload.nextAction === "string" ? payload.nextAction : "",
    facts,
    opportunities: strList(payload.opportunities, 4),
    talkTracks: strList(payload.talkTracks, 4),
    risks
  };
}

// ─────────────────────────────────────────────────────────────
// 阶段感知写信：批次 / 自动方案的「按背调 + 按阶段自动写开发信」
//
// 分工（这是「CRM 是稳定框架」的落点）：
//   · 创建批次/方案时只做**只读**查询（阶段 + 已有背调），保证 HTTP 请求不被拖慢；
//   · 重活（补跑背调、交给 AI/CLI 重写正文）全部交给后台补写工序，逐条限流推进；
//   · 补写没完成前，发送端会跳过这些目标，不会把半成品发出去（并有超时兜底）。
// ─────────────────────────────────────────────────────────────

/** 批次的收件对象叫 candidate，背调留档的口径叫 prospect；混了会静默查不到背调 */
function outreachResearchEntityType(entityType: "candidate" | "lead" | "customer"): "lead" | "customer" | "prospect" {
  return entityType === "candidate" ? "prospect" : entityType;
}

/** 我方写信身份（公司资料 + 业务员签名）：单封工坊与批量补写共用同一份口径 */
function outreachWritingSenderFor(user: SessionUser): OutreachWritingSender {
  const profile = companyProfileForTeam(user.teamId);
  const name = user.emailSenderName || user.name || "";
  return {
    name,
    company: profile.companyName,
    products: profile.productSummary,
    website: profile.website,
    signature: user.emailSignature?.trim() || `Best regards,\n${name || "Sales team"}`
  };
}

function outreachLetterEnrichmentEnabled() {
  return process.env.OUTREACH_LETTER_ENRICH !== "false";
}

/**
 * 后台工序在引擎上最多等多久。
 * 它不在 HTTP 请求里，所以等久一点（默认 2 分钟）比「没等到就降级成模板」更划算。
 */
function outreachLetterEngineWaitMs() {
  const configured = Number(process.env.OUTREACH_LETTER_ENGINE_WAIT_MS || 120_000);
  if (!Number.isFinite(configured)) return 120_000;
  return Math.max(10_000, Math.min(600_000, Math.floor(configured)));
}

/** 每个待补写目标最多试几次；超过就保留现有正文并标记 failed，不再反复重试 */
const OUTREACH_LETTER_MAX_ATTEMPTS = 3;

/**
 * 用指定来源写「一封」开发信。
 * 复用单封工坊同一条链路（同一份提示词、同一份蓝图、同一套引擎作业留档），
 * 所以批量写出来的信与手工写的信在口径上完全一致。
 * 返回 null 表示这个来源此刻不可用；调用方保留阶段模板版正文继续（不阻断发送）。
 */
async function writeOutreachLetter(options: {
  owner: SessionUser;
  source: "ai" | "cli";
  stageKey: OutreachStageKey;
  sender: OutreachWritingSender;
  recipient: OutreachWritingRecipient;
  research: OutreachWritingResearch;
  entityType: "lead" | "customer" | "prospect";
  entityId: string;
}): Promise<{ subject: string; body: string; engine: string } | null> {
  const brief = assembleDevelopmentEmailBrief({
    stageKey: options.stageKey,
    sender: options.sender,
    recipient: {
      company: options.recipient.company,
      contactName: options.recipient.contactName,
      email: options.recipient.email,
      country: options.recipient.country,
      market: options.recipient.market || "",
      context: options.recipient.context
    },
    research: options.research || null
  });
  const signatureText = developmentEmailSignature(brief);
  const fallback = buildDevelopmentEmailFallback(brief);

  if (options.source === "cli") {
    const result = await runEngineCliJob(options.owner, {
      kind: "email",
      entityType: options.entityType,
      entityId: options.entityId,
      request: {
        response: {
          draft: {
            entityType: options.entityType,
            entityId: options.entityId,
            recipientCompany: options.recipient.company,
            recipientName: options.recipient.contactName,
            to: options.recipient.email,
            subject: fallback.subject,
            body: fallback.body,
            from: options.owner.outboundEmail || "",
            senderName: options.sender.name,
            engine: fallback.basis
          }
        },
        brief,
        signatureText
      },
      prompt: buildEmailCliPrompt(buildDevelopmentEmailPrompt(brief)),
      waitMs: outreachLetterEngineWaitMs()
    });
    if (result.pending) return null;
    const draft = (result.payload as { draft?: { subject?: string; body?: string; engine?: string } }).draft;
    if (!draft?.body) return null;
    return {
      subject: (draft.subject || fallback.subject).slice(0, 160),
      body: draft.body.slice(0, 6000),
      engine: draft.engine || "本机 CLI"
    };
  }

  const config = getAiConfig(options.owner, "emailDraft");
  if (!config?.enabled || !config.apiKey) return null;
  try {
    const parsed = extractJsonObject(await callAiModel(config, buildDevelopmentEmailPrompt(brief), 12000)) as Record<string, unknown>;
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!body) return null;
    return {
      subject: (typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim() : fallback.subject).slice(0, 160),
      // 与单封工坊同一套落款兜底：模型整段省略签名是实测发生过的
      body: ensureDevelopmentEmailSignature(body.slice(0, 5600), signatureText).slice(0, 6000),
      engine: config.name || config.model || "AI API"
    };
  } catch {
    return null;
  }
}

/**
 * 缺背调时补跑一次并留档。
 * 走同一个背调管线（含团队「默认背调来源」），所以补跑结果与用户手动点一次完全一致。
 * 返回 null = 这次没拿到（引擎还在跑 / 失败），由调用方下次再试。
 */
async function ensureOutreachResearch(owner: SessionUser, target: OutreachWritingTarget): Promise<BackgroundResearchRecord | null> {
  const entityType = outreachResearchEntityType(target.entityType);
  const existing = await latestBackgroundResearch(owner, entityType, target.entityId);
  if (existing) return existing;
  const outcome = await buildBackgroundResearch(owner, { entityType, entityId: target.entityId });
  if (!outcome) return null;
  if (outcome.kind === "research") {
    await persistBackgroundResearchRecord(owner, outcome.research);
    return latestBackgroundResearch(owner, entityType, target.entityId);
  }
  const result = await runEngineCliJob(owner, {
    kind: "research",
    entityType,
    entityId: target.entityId,
    request: { skeleton: outcome.skeleton },
    prompt: outcome.prompt,
    waitMs: outreachLetterEngineWaitMs()
  });
  if (result.pending) return null;
  // finalizeEngineCliJob 的 research 分支内部已经落档
  return latestBackgroundResearch(owner, entityType, target.entityId);
}

/**
 * 写信运行时：批次 / 自动方案模块通过它拿到「阶段 / 背调 / 我方身份」。
 * 这里刻意只做只读查询——创建批次是个 HTTP 请求，一个 50 人的批次在这里同步跑
 * 50 次背调会把请求挂死。重活交给下面的后台补写工序。
 */
export function createOutreachWritingRuntime(actor: { id: string; teamId: string }): OutreachWritingRuntime {
  const store = getStore();
  const owner = store.users.find((item) => item.id === actor.id);
  const session = owner ? publicUser(owner) : null;
  const profile = companyProfileForTeam(actor.teamId);
  const sender: OutreachWritingSender = session
    ? outreachWritingSenderFor(session)
    : { name: "", company: profile.companyName, products: profile.productSummary, website: profile.website, signature: "" };
  /** 团队默认开发信来源只读一次，避免一条目标一次设置查询 */
  let emailSource: string | null = null;

  return {
    sender: () => sender,
    async resolve(_actor, target) {
      const journeyType: OutreachJourneyEntityType = target.entityType === "candidate" ? "prospect_candidate" : target.entityType;
      const journey = session
        ? await buildOutreachJourney(store, journeyType, target.entityId).catch(() => undefined)
        : undefined;
      const record = session
        ? await latestBackgroundResearch(session, outreachResearchEntityType(target.entityType), target.entityId)
        : null;
      if (emailSource === null) {
        emailSource = await readTeamAiEngineSettings(actor.teamId).then((settings) => settings.emailSource).catch(() => "template");
      }
      return {
        stageKey: journey?.stage.key || "not_contacted",
        stageSource: "derived" as const,
        research: developmentEmailResearchInput(record),
        researchId: record?.id || "",
        researchScore: record?.score || 0,
        needsResearch: !record,
        engineWrites: emailSource === "ai" || emailSource === "cli",
        enrichmentEnabled: outreachLetterEnrichmentEnabled(),
        maxSteps: OUTREACH_SEQUENCE_DEFAULT_STEPS
      };
    }
  };
}

/** 后台补写工序处理的对象：草稿批次或运行中的自动方案（结构上只要这几项） */
interface OutreachLetterHost {
  ownerId: string;
  teamId: string;
  policy: ProspectOutreachBatchPolicy;
  items: ProspectOutreachBatchItem[];
  label: string;
}

let outreachLetterEnrichBusy = false;

/**
 * 后台补写工序。
 *
 * 逐条把「阶段感知但还没引用背调 / 还没用引擎写」的目标补成最终形态：
 *   ① 缺背调 → 按团队默认背调来源补跑一次并留档（用户 2026-10-06 选的口径）
 *   ② 用拿到的背调重写整条序列（阶段口径不变，只把依据补上）
 *   ③ 团队默认开发信来源是 AI / CLI 时，逐封交给引擎写
 * 任何一步失败都只降级、不阻断：正文保留阶段模板版，发送端照常可以发。
 */
async function enrichOutreachDraftLetters(reason: string) {
  if (!outreachLetterEnrichmentEnabled() || outreachLetterEnrichBusy) return;
  outreachLetterEnrichBusy = true;
  try {
    const store = getStore();
    const maxPerPass = Math.max(1, Math.min(20, Number(process.env.OUTREACH_LETTER_ENRICH_MAX || 2) || 2));
    const hosts: OutreachLetterHost[] = [
      // 只有草稿批次能改正文：放行后就冻结了（frozenPayload 已是最终内容）
      ...store.prospectOutreachBatches
        .filter((batch) => batch.status === "draft")
        .map((batch) => ({ ownerId: batch.ownerId, teamId: batch.teamId, policy: batch.policy, items: batch.items, label: "发信批次" })),
      // 自动方案：运行中/暂停中还有未投递的步骤，仍可以补写
      ...store.prospectOutreachPlans
        .filter((plan) => plan.status === "running" || plan.status === "paused")
        .map((plan) => ({ ownerId: plan.ownerId, teamId: plan.teamId, policy: plan.policy, items: plan.items, label: "自动方案" }))
    ];

    let processed = 0;
    for (const host of hosts) {
      if (processed >= maxPerPass) break;
      const pending = host.items.filter((item) => item.status === "ready" && item.letterStatus === "pending");
      if (!pending.length) continue;

      const owner = store.users.find((item) => item.id === host.ownerId);
      if (!owner) {
        pending.forEach((item) => {
          item.letterStatus = "failed";
          item.letterNote = "归属账号已不存在，无法补写正文，保留现有阶段模板版";
        });
        await store.persist();
        continue;
      }
      const session = publicUser(owner);
      const emailSource = await readTeamAiEngineSettings(host.teamId)
        .then((settings) => (settings.emailSource === "ai" || settings.emailSource === "cli" ? settings.emailSource : ""))
        .catch(() => "");

      for (const item of pending) {
        if (processed >= maxPerPass) break;
        const target = writingTargetForItem(store, item);
        if (!target) {
          item.letterStatus = "failed";
          item.letterNote = "目标已不存在或已被删除，保留现有阶段模板版";
          continue;
        }
        const attempts = (item.letterAttempts || 0) + 1;
        item.letterAttempts = attempts;

        // ① 背调：缺就补跑一次（同一个背调管线），这次没拿到就下次再试
        let record: BackgroundResearchRecord | null = item.researchId
          ? await latestBackgroundResearch(session, outreachResearchEntityType(target.entityType), target.entityId)
          : null;
        if (!record && host.policy.autoResearch !== false) {
          record = await ensureOutreachResearch(session, target);
          if (!record) {
            if (attempts >= OUTREACH_LETTER_MAX_ATTEMPTS) {
              item.letterStatus = "failed";
              item.letterNote = `补跑背调失败（已试 ${attempts} 次），先用阶段蓝图成稿继续发送。`;
            } else {
              item.letterNote = `正在补跑背调（第 ${attempts} 次）…`;
            }
            processed += 1;
            continue;
          }
        }

        const research = developmentEmailResearchInput(record);
        const sender = outreachWritingSenderFor(session);
        const recipient: OutreachWritingRecipient = {
          company: target.company,
          contactName: target.contactName,
          email: item.recipient || target.email,
          country: target.country,
          context: target.context
        };

        // ② 用拿到的背调重写整条序列
        const sequence = buildStageAwareSequence({
          stageKey: item.stageKey,
          maxSteps: item.steps.length || OUTREACH_SEQUENCE_DEFAULT_STEPS,
          stepIntervalHours: host.policy.stepIntervalHours || 72,
          sender,
          recipient,
          research,
          coldOnly: true
        });
        if (sequence.blockedReason) {
          item.steps = [];
          item.letterStatus = "failed";
          item.letterNote = sequence.blockedReason;
          processed += 1;
          continue;
        }
        const rebuilt = toBatchSteps({ steps: sequence.steps, meta: {}, blockedReason: "" }, Date.now(), true);
        // 已投递/在投递的步骤不能被覆盖（自动方案会在入场后立刻发第 1 封）
        item.steps = rebuilt.map((step, index) => {
          const previous = item.steps[index];
          return previous && previous.status !== "pending" ? previous : step;
        });

        // ③ 引擎重写：团队默认开发信来源是 AI / CLI 时逐封交给引擎
        let engineWrote = 0;
        let engineFailed = 0;
        if (emailSource === "ai" || emailSource === "cli") {
          for (let index = 0; index < item.steps.length; index += 1) {
            const step = item.steps[index]!;
            if (step.status !== "pending") continue;
            const written = await writeOutreachLetter({
              owner: session,
              source: emailSource,
              stageKey: sequence.steps[index]?.stageKey || item.stageKey || "not_contacted",
              sender,
              recipient,
              research,
              entityType: outreachResearchEntityType(target.entityType),
              entityId: target.entityId
            });
            if (written) {
              step.subject = written.subject;
              step.body = written.body;
              engineWrote += 1;
            } else {
              engineFailed += 1;
            }
          }
        }

        item.researchId = record?.id || item.researchId || "";
        item.researchScore = record?.score ?? item.researchScore ?? 0;
        item.letterBasis = sequence.steps[0]?.basis || item.letterBasis || "";
        item.letterStatus = engineFailed && !engineWrote ? "failed" : "ready";
        item.letterPendingAt = "";
        item.letterEngine = engineWrote
          ? (emailSource === "cli" ? "本机 CLI" : "AI API")
          : "固定模板（阶段蓝图 + 背调）";
        item.letterNote = !record
          ? "本公司暂无背调留档，按阶段蓝图成稿。"
          : engineFailed
            ? `其中 ${engineFailed} 封引擎没写成，已保留阶段模板版。`
            : "";
        processed += 1;
      }
      await store.persist();
      console.log(`GoodJob CRM enriched outreach letters for ${host.label} (${reason})`);
    }
    if (processed) console.log(`GoodJob CRM enriched ${processed} outreach letter target(s) (${reason})`);
  } catch (error) {
    console.error("outreach letter enrichment failed", error);
  } finally {
    outreachLetterEnrichBusy = false;
  }
}

let outreachLetterEnrichTimer: NodeJS.Timeout | null = null;

function startOutreachLetterEnrichmentScheduler() {
  if (!outreachLetterEnrichmentEnabled()) {
    console.log("GoodJob CRM outreach letter enrichment disabled (OUTREACH_LETTER_ENRICH=false)");
    return;
  }
  const pollMs = Math.max(10_000, Number(process.env.OUTREACH_LETTER_ENRICH_POLL_MS || 30_000) || 30_000);
  outreachLetterEnrichTimer = setInterval(() => void enrichOutreachDraftLetters("scheduled"), pollMs);
  void enrichOutreachDraftLetters("startup");
}

function stopOutreachLetterEnrichmentScheduler() {
  if (outreachLetterEnrichTimer) clearInterval(outreachLetterEnrichTimer);
  outreachLetterEnrichTimer = null;
}

// ---------------------------------------------------------------------------
// WhatsApp 绑定模式扩展 (Web扫码 + Twilio API)
// ---------------------------------------------------------------------------

// 初始化 Twilio (从环境变量读取配置)
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || "";
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || "";
export const twilioWebhookUrl = process.env.TWILIO_WEBHOOK_URL || "";

if (twilioAccountSid && twilioAuthToken) {
  twilioManager.initialize(twilioAccountSid, twilioAuthToken, twilioWebhookUrl);
  console.log("✅ Twilio WhatsApp initialized");
}

export function dealProductSummary(items: Array<{ product: string }>) {
  const names = [...new Set(items.map((item) => item.product.trim()).filter(Boolean))];
  if (names.length <= 2) return names.join("、").slice(0, 200);
  return `${names.slice(0, 2).join("、")} 等 ${names.length} 项`.slice(0, 200);
}

export function createDealEvent(input: Omit<DealEvent, "id" | "createdAt"> & { createdAt?: string }) {
  const store = getStore();
  const event: DealEvent = {
    ...input,
    id: `de_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: input.createdAt || new Date().toISOString()
  };
  store.dealEvents.unshift(event);
  return event;
}

export function roundMoneyValue(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

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

function agentSessionUser(actor: { id: string } & Partial<SessionUser>) {
  const stored = getStore().users.find((item) => item.id === actor.id && item.status === "active");
  if (!stored) throw new Error("Agent 执行账号不存在或已停用");
  const session = publicUser(stored);
  session.iamPermissions = actor.iamPermissions;
  session.iamRoleNames = actor.iamRoleNames;
  session.iamSource = actor.iamSource;
  session.iamDataScope = actor.iamDataScope;
  return { stored, session };
}

async function buildAgentDevelopmentEmail(actor: { id: string }, input: Record<string, unknown>) {
  const { stored, session } = agentSessionUser(actor);
  const entityTypeInput = agentInputText(input, "entityType");
  const entityType = entityTypeInput === "lead" ? "lead" : entityTypeInput === "prospect" ? "prospect" : "customer";
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
  const configuredBaseUrl = String(process.env.WHATSAPP_PLUGIN_INTERNAL_URL || "").trim();
  const baseUrl = configuredBaseUrl || `http://127.0.0.1:${port}`;
  let internalUrl: URL;
  try {
    internalUrl = new URL(baseUrl);
  } catch {
    throw new Error("Communication 内部服务地址格式不正确");
  }
  if (!["http:", "https:"].includes(internalUrl.protocol)
    || internalUrl.username
    || internalUrl.password
    || internalUrl.search
    || internalUrl.hash) {
    throw new Error("Communication 内部服务地址必须是不含凭据、查询参数和片段的 HTTP(S) URL");
  }
  const response = await fetch(new URL(`/api/v1${path}`, `${internalUrl.toString().replace(/\/+$/u, "")}/`), {
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

export async function startAgentProspectSearch(
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
  // 默认搜索链：免费推荐源 + 已配置凭据的"联系方式源"（Apollo / PDL / Hunter 等）。
  // 取代旧的"一刀切排除 tier=paid"——那会把所有真正能拿到邮箱的源永久挡在门外。
  // 安全性由 enabled/ready 保证：未配置 Key 的付费源 ready=false，天然进不来。
  const autoProviders = defaultSearchProviderIdsFor(providerStatuses);
  const providerIds = requestedProviderIds.length
    ? requestedProviderIds
    : (autoProviders.length ? autoProviders : providerStatuses
      .filter((item) => item.enabled && item.ready && item.accessMode === "api" && item.id !== "ai_search")
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

export async function getAgentProspectSearchProgress(actor: { id: string }, input: Record<string, unknown>) {
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
  if (result.created && !result.replayed) {
    notifyNewLead(result.lead);
    await store.persist();
  }
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

export const agentExecutionRuntime: AgentExecutionRuntime = {
  async listIntegrationTools(actor) {
    const service = getIntegrationControlPlaneService();
    if (!service) return { enabled: false, count: 0, tools: [], message: "外部工具集成服务当前未启用" };
    const { session } = agentSessionUser(actor);
    const tools = await service.agentToolCatalog(session);
    return { enabled: true, count: tools.length, tools };
  },
  async requestIntegrationRead(actor, input, executionId) {
    const service = getIntegrationControlPlaneService();
    if (!service) throw new Error("外部工具集成服务当前未启用");
    const stableAlias = String(input.stableAlias || "").trim();
    const toolInput = input.input && typeof input.input === "object" && !Array.isArray(input.input)
      ? input.input as Record<string, unknown>
      : {};
    const { session } = agentSessionUser(actor);
    const call = await service.createReadOnlyCall(session, stableAlias, toolInput, `agent_${executionId}`.slice(0, 100));
    if (!call) throw new Error("外部工具调用未能创建");
    const configuredTimeout = Number(process.env.INTEGRATION_AGENT_CALL_TIMEOUT_MS || 30_000);
    return service.waitForReadOnlyCall(session, call.id, configuredTimeout);
  },
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
    const dispatch = await dispatchOutboundEmail(getStore(), stored, {
      requestId: `agent:${executionId}`,
      entityType: draft.entityType === "lead" ? "lead" : "customer",
      entityId: draft.entityId,
      to: outreachEligibility.recipient,
      subject: draft.subject,
      body: draft.body,
      messageId: `<${executionId}@${domain}>`,
      source: "agent_send",
      executionId
    });
    const sentAt = dispatch.log.sentAt;
    const nextFollowAt = agentInputText(input, "nextFollowAt") || new Date(Date.now() + 3 * 86_400_000).toISOString();
    recordCrmEmailTouchpoint(getStore(), dispatch.log, {
      eventType: "send",
      direction: "outbound",
      occurredAt: sentAt,
      subject: draft.subject,
      content: draft.body,
      requestId: `send:agent:${executionId}`
    });
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
    return { sent: true, replayed: dispatch.replayed, messageId: dispatch.log.messageId, activityId, to: outreachEligibility.recipient, subject: draft.subject, sentAt, followUpCreated: true, uiAction: { type: "open_development_email", entityType: draft.entityType, entityId: draft.entityId } };
  },
  async sendWhatsApp(actor, input, executionId) {
    const { session } = agentSessionUser(actor);
    const customerId = agentInputText(input, "customerId");
    const customer = getStore().customers.find((item) => item.id === customerId && canSeeOwner(session, item.ownerId, item.teamId));
    if (!customer || !hasIamPermission(session, "communication.send")) throw new Error("客户不存在，或当前账号没有发送客户消息的权限");
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
    const entityTypeInput = agentInputText(input, "entityType");
    const entityType = entityTypeInput === "lead" ? "lead" : entityTypeInput === "prospect" ? "prospect" : "customer";
    const entityId = agentInputText(input, "entityId");
    if (!entityId) throw new Error("AI 背调需要明确客户、线索或候选编号");
    // Agent 通道必须同步返回：固定走 AI/CRM 通道，不在这里派本机 CLI 任务
    const payload = await buildBackgroundResearch(session, { entityType, entityId, source: "ai" });
    if (!payload) throw new Error(entityType === "lead" ? "线索不存在或当前账号无权访问" : entityType === "prospect" ? "搜客候选不存在或当前账号无权访问" : "客户不存在或当前账号无权访问");
    if (payload.kind === "cli") throw new Error("背调来源被设置为本机 CLI，Agent 通道无法同步执行；请在背调页选择来源");
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

export let activeAgentBackgroundRunner: AgentBackgroundRunner | null = null;
export let activeOutreachSequenceRunner: OutreachSequenceRunner | null = null;
export let activeCustomerMaintenanceRunner: CustomerMaintenanceRunner | null = null;
export let activeAgentTriggerRunner: AgentTriggerRunner | null = null;
export let activeSalesTrainingRunner: SalesTrainingRunner | null = null;
export let activeInboundMailWatcher: InboundMailWatcher | null = null;

/**
 * 埋点是**旁路**：仓库不可用或写失败都不许影响主流程（与「背调留档写库失败不拖垮返回」同口径）。
 */
export async function recordResourceHubEvents(items: ResourceEventInput[]): Promise<number> {
  const repository = getResourceHubRepository();
  if (!repository || !items.length) return 0;
  try {
    return await repository.recordEvents(items);
  } catch {
    return 0;
  }
}

export const uploadsDir = path.resolve(process.env.GOODJOB_UPLOADS_DIR?.trim() || path.resolve(process.cwd(), "uploads"));

export function documentAssetUrlForLocalFile(value: string) {
  const normalized = String(value || "").trim();
  if (!/^\/uploads\/[A-Za-z0-9._-]+\.(?:png|jpe?g)$/i.test(normalized)) return "";
  return normalized;
}

export function orderVisible(user: SessionUser, order: Order): boolean {
  return canSeeOwner(user, order.ownerId, order.teamId);
}

export function fileIsAdmin(user: SessionUser) {
  return user.role === "super_admin" || user.role === "admin" || hasIamPermission(user, "system.settings.manage");
}

/** 引用 → 业务对象归属；解析不到的引用直接忽略（业务对象已删除） */
async function fileReferenceOwners(
  store: ReturnType<typeof getStore>,
  references: Array<{ entityType: string; entityId: string }>
) {
  const owners: Array<{ ownerId: string; teamId: string; label: string }> = [];
  for (const reference of references) {
    if (reference.entityType === "order") {
      const order = store.orders.find((item) => item.id === reference.entityId);
      if (order) owners.push({ ownerId: order.ownerId, teamId: order.teamId, label: `订单 ${order.orderNo || order.id}` });
      continue;
    }
    if (reference.entityType === "customer") {
      const customer = store.customers.find((item) => item.id === reference.entityId);
      if (customer) owners.push({ ownerId: customer.ownerId, teamId: customer.teamId, label: customer.company });
      continue;
    }
    if (reference.entityType === "lead") {
      const lead = store.leads.find((item) => item.id === reference.entityId);
      if (lead) owners.push({ ownerId: lead.ownerId, teamId: lead.teamId, label: lead.company });
      continue;
    }
    if (reference.entityType === "supplier") {
      // 供应商在独立表里，只能异步查；查不到（已删除）就按「没有关联业务」处理
      const supplier = await getSupplierRepository()?.findAnyById(reference.entityId);
      if (supplier) owners.push({ ownerId: supplier.ownerId, teamId: supplier.teamId, label: `供应商 ${supplier.code || supplier.company}` });
      continue;
    }
    if (reference.entityType === "kb") {
      const asset = store.knowledgeAssets.find((item) => item.id === reference.entityId);
      if (asset) owners.push({ ownerId: asset.ownerId, teamId: asset.teamId || "", label: asset.title });
    }
  }
  return owners;
}

export async function loadAccessibleFile(user: SessionUser, fileId: string, action: "preview" | "raw" | "manage") {
  const repository = getFileRepository();
  if (!repository) return { ok: false as const, error: { status: 503, message: "文件存储未就绪" } };
  const file = await repository.findFile(fileId);
  if (!file) return { ok: false as const, error: { status: 404, message: "文件不存在" } };
  const references = await repository.listReferences(file.id);
  const store = getStore();
  const decision = evaluateFileAccess(user, file, await fileReferenceOwners(store, references), {
    isAdmin: fileIsAdmin(user),
    canSee: (ownerId, teamId) => canSeeOwner(user, ownerId, teamId),
    // 目前没有独立的 file.manage 权限码；管理动作限定为「本人 + 管理员」，
    // 订单侧移除关联仍走 order.manage，两条口子互不放大。
    hasManagePermission: false,
    action
  });
  if (!decision.ok) return { ok: false as const, error: { status: decision.code || 403, message: decision.reason } };
  return { ok: true as const, repository, file, decision, references };
}

// ---------------------------------------------------------------------------
// 自动获客 · 数据源中心（Provider 注册表 + 用户 Key 配置 + 统一搜索）
// ---------------------------------------------------------------------------

export function getProviderConnection(user: SessionUser, providerId: string): ProviderConnection | undefined {
  return getStore().providerConnections.find((item) =>
    item.providerId === providerId
    && item.ownerId === user.id
    && item.teamId === user.teamId
    && item.scope === "personal"
  );
}

const contactResearchResultSchema = z.object({
  contacts: z.array(z.object({
    name: z.string().trim().max(160).optional().default(""),
    title: z.string().trim().max(160).optional().default(""),
    channel: z.string().trim().max(40).optional().default(""),
    value: z.string().trim().max(320),
    sourceUrl: z.string().trim().url().max(1200),
    sourceQuote: z.string().trim().max(1200)
  }).passthrough()).max(20).default([]),
  noResultReason: z.string().trim().max(1000).optional().default("")
}).passthrough();

function normalizedResearchUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return "";
  }
}

function contactValueInEvidence(value: string, quote: string) {
  if (value.includes("@")) return quote.toLocaleLowerCase("en-US").includes(value.toLocaleLowerCase("en-US"));
  const valueDigits = value.replace(/\D/gu, "");
  const quoteDigits = quote.replace(/\D/gu, "");
  return valueDigits.length >= 7 && quoteDigits.includes(valueDigits);
}

function researchContactEvidence(input: {
  company: string;
  payload: unknown;
  sourceId: string;
  sourceLabel: string;
  sourceKind: "web_search" | "local_runner";
  allowedUrls?: string[];
}) {
  const parsed = contactResearchResultSchema.parse(input.payload);
  const allowedUrls = input.allowedUrls?.map(normalizedResearchUrl).filter(Boolean);
  const contacts: ExtractedWebsiteContact[] = [];
  for (const item of parsed.contacts) {
    const sourceUrl = normalizedResearchUrl(item.sourceUrl);
    if (!sourceUrl || !nativeResearchCitationAllowed(sourceUrl)) continue;
    if (allowedUrls?.length && !allowedUrls.includes(sourceUrl)) continue;
    if (!contactValueInEvidence(item.value, item.sourceQuote)) continue;
    const channels = contactChannelsFromText(item.value);
    const whatsapp = /whatsapp/iu.test(item.channel) ? channels.phones : [];
    const phones = whatsapp.length ? [] : channels.phones;
    if (!channels.emails.length && !phones.length && !whatsapp.length) continue;
    contacts.push({
      kind: item.name ? "person" : "company",
      name: item.name || input.company,
      title: item.title || (item.name ? "公开联系人" : "公司公开联系"),
      emails: channels.emails,
      phones,
      whatsapp,
      source: input.sourceId,
      sourceLabel: input.sourceLabel,
      sourceKind: input.sourceKind,
      confidence: input.sourceKind === "web_search" ? 72 : 64,
      verificationStatus: "syntax_valid",
      observedAt: new Date().toISOString(),
      reasonCodes: [input.sourceKind === "web_search"
        ? "CONTACT_NATIVE_WEB_SEARCH_CITED"
        : "CONTACT_RUNNER_RESEARCH_CITED"],
      evidenceExcerpt: item.sourceQuote,
      corroboratedSources: [{
        sourceId: input.sourceId,
        sourceLabel: input.sourceLabel,
        evidenceUrl: sourceUrl
      }],
      evidenceUrl: sourceUrl
    });
  }
  return { contacts, noResultReason: parsed.noResultReason };
}

function contactResearchPrompt(candidate: WebsiteOpportunity) {
  return [
    `Research public business contact details for: ${candidate.company}`,
    `Country or region: ${candidate.country || "unknown"}`,
    `Known official website: ${candidate.website || "not confirmed"}`,
    `Business: ${candidate.business || "unknown"}`,
    "Use public web search and cite the exact HTTPS page where every email, telephone or WhatsApp number appears.",
    "Only research companies outside China, Hong Kong, Macau and Taiwan. Do not use .cn, .hk, .mo or .tw websites.",
    "Do not log in, bypass CAPTCHA, automatically collect content from social networks, download files or invent likely email patterns.",
    "Prefer the official company website, official business directory API results and regulator or chamber pages.",
    "Return only one JSON object with this shape:",
    '{"contacts":[{"name":"","title":"","channel":"email|phone|whatsapp","value":"","sourceUrl":"https://...","sourceQuote":"exact text containing the contact value"}],"noResultReason":""}',
    "If no contact value has an exact source quote and URL, return an empty contacts array and explain why."
  ].join("\n");
}

function contactSearchAdjustment(errorCode = "", message = "") {
  const value = `${errorCode} ${message}`;
  if (/401|403|auth|key|认证|密钥/iu.test(value)) return "请在 AI 配置中检查 API Key、账号权限和 Base URL 后重新测试连接。";
  if (/429|quota|rate|额度|限流/iu.test(value)) return "请检查模型额度或稍后重试；批量查询时建议减少单次客户数量。";
  if (/timeout|timed|超时|network|fetch|连接/iu.test(value)) return "请检查网络和模型服务状态，适当降低批量数量后重试。";
  if (/web search|工具|tool/iu.test(value)) return "当前模型可能不支持 Web Search，请改用支持 Responses API 联网工具的 OpenAI 模型。";
  return "请检查 AI 模型配置和联网能力；失败不会阻塞官网及 Runner 继续补漏。";
}

async function contactRunnerPlan(user: SessionUser) {
  const service = getLocalRunnerService();
  if (!service) return {
    configured: false,
    message: "当前数据库运行模式未启用本地 Runner 服务",
    suggestion: "部署 MySQL 版集成服务后，在集成中心配对 Good Job Runner。",
    service: null,
    runner: null
  };
  try {
    const runners = await service.runners(user);
    const runner = runners.find((item) =>
      item.online
      && item.capabilities.includes("codex")
      && item.capabilities.includes("browser")
      && item.workspaces.length
    ) || null;
    return runner ? {
      configured: true,
      message: `等待 ${runner.displayName} 执行深度补漏`,
      suggestion: "",
      service,
      runner
    } : {
      configured: false,
      message: "没有同时具备 Codex 与独立浏览器能力的在线 Runner",
      suggestion: "请在集成中心启动并配对 Good Job Runner，确认 Codex CLI 和独立浏览器均显示在线。",
      service,
      runner: null
    };
  } catch (error) {
    return {
      configured: false,
      message: error instanceof Error ? `Runner 状态读取失败：${error.message}` : "Runner 状态读取失败",
      suggestion: "请检查集成中心和 Runner 服务连接。",
      service,
      runner: null
    };
  }
}

const activeContactEnrichmentRuns = new Map<string, Promise<void>>();

function contactEnrichmentProviders(user: SessionUser) {
  // 只要"能补出邮箱"（capabilities 含 email）且实现了 enrich，就进入补全通道；
  // 不再硬卡 category === "email"——Apollo / PDL 的 category 是 company，但同样能补联系人。
  return LEAD_PROVIDERS.filter((provider) =>
    provider.capabilities.includes("email") && Boolean(provider.enrich)
  ).flatMap((provider) => {
    const catalog = providerCatalogByCode(provider.id);
    if (!catalog || catalog.status !== "active" || catalog.accessMode !== "api") return [];
    const connection = getProviderConnection(user, provider.id);
    return [{
      provider,
      catalog,
      connection,
      configured: !providerRequiresKey(provider, catalog)
        || Boolean(connection?.status === "active")
    }];
  });
}

function websiteContactSourceProgress(
  candidate: WebsiteOpportunity,
  attemptId: string
) {
  const attempt = candidate.contactEnrichmentAttempts?.find((item) =>
    item.id === attemptId
  );
  const source = attempt && contactEnrichmentSource(attempt, "website_probe");
  const probe = candidate.websiteProbeAttempts?.[0];
  if (!attempt || !source || !probe) return;
  source.startedAt ||= probe.startedAt || probe.createdAt;
  const websiteContacts = (candidate.extractedContacts || []).filter((contact) =>
    contact.source === "website_probe"
    && (contact.emails.length || contact.phones.length || contact.whatsapp.length)
  );
  source.contactCount = websiteContacts.length;
  if (probe.status === "queued" || probe.status === "running") {
    source.status = probe.status;
    source.outcome = "pending";
    source.message = probe.events.at(-1)?.message || "正在核验境外官网公开资料";
  } else {
    source.completedAt = probe.completedAt || new Date().toISOString();
    if (["policy_blocked", "robots_denied"].includes(probe.outcome)) {
      source.status = "blocked";
      source.outcome = "policy_blocked";
    } else if (probe.outcome === "interrupted") {
      source.status = "failed";
      source.outcome = "timed_out";
      source.suggestion = "后台任务已中断，可点击继续查找联系人重新执行；这不代表官网不可访问。";
    } else if (["unreachable", "rate_limited", "circuit_open"].includes(probe.outcome)) {
      source.status = "failed";
      source.outcome = "provider_failed";
    } else {
      source.status = "completed";
      source.outcome = websiteContacts.length ? "contact_found" : "no_contact";
    }
    source.message = websiteContacts.length
      ? `境外官网取得 ${websiteContacts.length} 条公开联系方式`
      : probe.failureMessage || (probe.outcome === "no_evidence"
        ? "官网已验证，但公开页面未提供可用联系方式"
        : "官网验证结束，未取得可用联系方式");
  }
  refreshContactEnrichmentAttempt(candidate, attempt);
}

function contactAttemptContext(candidateId: string, attemptId: string) {
  const store = getStore();
  const candidate = store.websiteOpportunities.find((item) => item.id === candidateId);
  const attempt = candidate?.contactEnrichmentAttempts?.find((item) => item.id === attemptId);
  return candidate && attempt ? { store, candidate, attempt } : null;
}

async function persistContactAttempt(candidate: WebsiteOpportunity, attempt: NonNullable<WebsiteOpportunity["contactEnrichmentAttempts"]>[number]) {
  refreshContactEnrichmentAttempt(candidate, attempt);
  await persistCandidateChanges(getStore(), [candidate], false);
}

async function executeNativeContactResearch(
  user: SessionUser,
  candidateId: string,
  attemptId: string,
  config: AiModelConfig
) {
  let context = contactAttemptContext(candidateId, attemptId);
  let source = context && contactEnrichmentSource(context.attempt, "native_web_search");
  if (!context || !source || source.status === "skipped") return;
  const startedAt = new Date().toISOString();
  source.status = "running";
  source.startedAt = startedAt;
  source.message = "正在通过模型原生 Web Search 查询公开联系方式和引用页面";
  await persistContactAttempt(context.candidate, context.attempt);
  try {
    const current = contactAttemptContext(candidateId, attemptId);
    if (!current) return;
    const result = await callAiModelWithWebSearch(
      config,
      contactResearchPrompt(current.candidate),
      10_000,
      undefined,
      50_000
    );
    context = contactAttemptContext(candidateId, attemptId);
    source = context && contactEnrichmentSource(context.attempt, "native_web_search");
    if (!context || !source) return;
    source.completedAt = new Date().toISOString();
    source.evidenceUrls = result.citations
      .map((item) => item.url)
      .filter(nativeResearchCitationAllowed)
      .slice(0, 10);
    if (!result.usedSearch) {
      source.status = "failed";
      source.outcome = "provider_failed";
      source.errorCode = "WEB_SEARCH_TOOL_NOT_USED";
      source.message = "模型返回了文本，但没有执行 Web Search 工具，结果未采信";
      source.suggestion = "请改用支持 OpenAI Responses API Web Search 的模型，并在 AI 配置中重新测试。";
    } else if (!source.evidenceUrls.length) {
      source.status = "completed";
      source.outcome = "no_contact";
      source.message = "联网搜索已完成，但没有返回符合境外策略的 HTTPS 引用";
      source.suggestion = "请确认公司名称、国家和官网是否准确，或启用 Runner 深度补漏。";
    } else {
      const parsed = researchContactEvidence({
        company: context.candidate.company,
        payload: extractJsonObject(result.content),
        sourceId: "native_web_search",
        sourceLabel: config.name || "AI 联网搜索",
        sourceKind: "web_search",
        allowedUrls: source.evidenceUrls
      });
      context.candidate.extractedContacts = mergeProspectContactEvidence(
        context.candidate.extractedContacts || [],
        parsed.contacts
      );
      const preferred = parsed.contacts[0];
      if (preferred && !context.candidate.contactInfo) {
        context.candidate.contactInfo = preferred.emails[0] || preferred.whatsapp[0] || preferred.phones[0] || "";
      }
      if (preferred?.kind === "person" && (!context.candidate.contact || context.candidate.contact === "待维护")) {
        context.candidate.contact = preferred.name;
      }
      source.status = "completed";
      source.outcome = parsed.contacts.length ? "contact_found" : "no_contact";
      source.contactCount = parsed.contacts.length;
      source.message = parsed.contacts.length
        ? `联网搜索取得 ${parsed.contacts.length} 条带引用的联系方式`
        : parsed.noResultReason || "联网搜索有引用，但没有联系方式同时具备原文和来源网址";
      source.suggestion = parsed.contacts.length
        ? ""
        : "请核对公司名称和国家；系统将继续验证官网，并在可用时交给 Runner 深度补漏。";
    }
    await persistContactAttempt(context.candidate, context.attempt);
  } catch (error) {
    context = contactAttemptContext(candidateId, attemptId);
    source = context && contactEnrichmentSource(context.attempt, "native_web_search");
    if (!context || !source) return;
    const failure = providerErrorFromUnknown(error, "search");
    source.status = "failed";
    source.outcome = /timeout|abort/iu.test(`${failure.code} ${failure.publicMessage}`) ? "timed_out" : "provider_failed";
    source.completedAt = new Date().toISOString();
    source.errorCode = failure.code;
    source.retryable = failure.retryable;
    source.retryAfterAt = failure.retryAfterAt;
    source.message = failure.publicMessage;
    source.suggestion = contactSearchAdjustment(failure.code, failure.publicMessage);
    await persistContactAttempt(context.candidate, context.attempt);
  }
}

async function ensureContactResearchWebsite(
  user: SessionUser,
  candidateId: string,
  attemptId: string,
  config: AiModelConfig | null
) {
  let context = contactAttemptContext(candidateId, attemptId);
  if (!context || /^https:\/\//iu.test(context.candidate.website || "")) return;
  const source = contactEnrichmentSource(context.attempt, "website_probe");
  if (source) {
    source.status = "running";
    source.startedAt ||= new Date().toISOString();
    source.message = config
      ? "候选缺少可信官网，正在通过联网搜索确认官网"
      : "候选缺少可信官网，且没有配置可用的联网搜索模型";
    await persistContactAttempt(context.candidate, context.attempt);
  }
  context = contactAttemptContext(candidateId, attemptId);
  if (!context) return;
  await discoverProspectWebsite({
    candidate: context.candidate,
    runId: `${context.attempt.runId}:contact-website`,
    search: config ? async ({ candidate, runId }) => {
      try {
        const result = await callAiModelWithWebSearch(config, [
          `Find the official website for ${candidate.company}.`,
          `Country or region: ${candidate.country || "unknown"}.`,
          "Cite only the company's own official HTTPS website. Do not cite directories, social networks or marketplaces.",
          "Do not use China, Hong Kong, Macau or Taiwan websites. If uncertain, return no website."
        ].join("\n"), 4_000, undefined, 40_000);
        return {
          providerId: "openai_web_search",
          records: result.usedSearch
            ? aiWebsiteCitationsToProviderRecords(candidate, result.citations.filter((item) => nativeResearchCitationAllowed(item.url)))
            : [],
          ...(!result.usedSearch ? {
            errorCode: "WEBSITE_WEB_SEARCH_TOOL_NOT_USED",
            errorMessage: "模型未执行 Web Search 工具"
          } : {})
        };
      } catch (error) {
        const failure = providerErrorFromUnknown(error, "search");
        return { providerId: "openai_web_search", records: [], errorCode: failure.code, errorMessage: failure.publicMessage };
      }
    } : undefined,
    persist: async (candidate) => persistCandidateChanges(getStore(), [candidate], false)
  });
}

async function executeRunnerContactResearch(
  user: SessionUser,
  candidateId: string,
  attemptId: string,
  plan: Awaited<ReturnType<typeof contactRunnerPlan>>
) {
  let context = contactAttemptContext(candidateId, attemptId);
  let source = context && contactEnrichmentSource(context.attempt, "codex_runner");
  if (!context || !source || !plan.configured || !plan.service || !plan.runner) return;
  refreshContactEnrichmentAttempt(context.candidate, context.attempt);
  if (context.attempt.recommendedContact) {
    source.status = "skipped";
    source.outcome = "not_needed";
    source.completedAt = new Date().toISOString();
    source.message = "前序来源已取得可用联系方式，无需启动 Runner";
    source.suggestion = "";
    await persistContactAttempt(context.candidate, context.attempt);
    return;
  }
  source.status = "running";
  source.startedAt = new Date().toISOString();
  source.message = `正在由 ${plan.runner.displayName} 调用 Codex CLI 深度查询`;
  await persistContactAttempt(context.candidate, context.attempt);
  try {
    context = contactAttemptContext(candidateId, attemptId);
    if (!context) return;
    const task = await plan.service.createTask(user, {
      runnerId: plan.runner.id,
      prompt: contactResearchPrompt(context.candidate),
      workspace: plan.runner.workspaces[0],
      executionMode: "read_only",
      timeoutSeconds: 75
    });
    context = contactAttemptContext(candidateId, attemptId);
    source = context && contactEnrichmentSource(context.attempt, "codex_runner");
    if (!context || !source) return;
    source.taskId = task.id;
    source.message = `Runner 任务 ${task.id} 已排队，等待 Codex CLI 返回带来源的联系方式`;
    await persistContactAttempt(context.candidate, context.attempt);
    const deadline = Math.min(
      Date.now() + 80_000,
      Date.parse(context.attempt.deadlineAt || new Date(Date.now() + 80_000).toISOString())
    );
    let completed: Awaited<ReturnType<typeof plan.service.task>> | null = null;
    while (Date.now() < deadline) {
      const current = await plan.service.task(user, task.id);
      if (["succeeded", "failed", "cancelled"].includes(current.task.status)) {
        completed = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    if (!completed) {
      await plan.service.cancel(user, task.id).catch(() => undefined);
      context = contactAttemptContext(candidateId, attemptId);
      source = context && contactEnrichmentSource(context.attempt, "codex_runner");
      if (!context || !source) return;
      source.status = "failed";
      source.outcome = "timed_out";
      source.completedAt = new Date().toISOString();
      source.errorCode = "CODEX_RUNNER_TIMEOUT";
      source.retryable = true;
      source.message = "Codex Runner 超过 80 秒仍未返回，系统已停止等待";
      source.suggestion = "请在集成中心检查 Runner 执行记录、Codex 登录状态和浏览器连接，恢复后再继续查询。";
      await persistContactAttempt(context.candidate, context.attempt);
      return;
    }
    context = contactAttemptContext(candidateId, attemptId);
    source = context && contactEnrichmentSource(context.attempt, "codex_runner");
    if (!context || !source) return;
    source.completedAt = new Date().toISOString();
    if (completed.task.status !== "succeeded") {
      source.status = "failed";
      source.outcome = "provider_failed";
      source.errorCode = completed.task.status === "cancelled" ? "CODEX_RUNNER_CANCELLED" : "CODEX_RUNNER_FAILED";
      source.message = completed.task.errorMessage || `Runner 任务${completed.task.status === "cancelled" ? "已取消" : "执行失败"}`;
      source.suggestion = "请在集成中心查看任务过程；检查 Codex CLI、网络和独立浏览器后重试。";
    } else {
      const parsed = researchContactEvidence({
        company: context.candidate.company,
        payload: extractJsonObject(completed.task.resultText),
        sourceId: "codex_runner",
        sourceLabel: `Codex Runner · ${plan.runner.displayName}`,
        sourceKind: "local_runner"
      });
      context.candidate.extractedContacts = mergeProspectContactEvidence(
        context.candidate.extractedContacts || [],
        parsed.contacts
      );
      const preferred = parsed.contacts[0];
      if (preferred && !context.candidate.contactInfo) {
        context.candidate.contactInfo = preferred.emails[0] || preferred.whatsapp[0] || preferred.phones[0] || "";
      }
      if (preferred?.kind === "person" && (!context.candidate.contact || context.candidate.contact === "待维护")) {
        context.candidate.contact = preferred.name;
      }
      source.status = "completed";
      source.outcome = parsed.contacts.length ? "contact_found" : "no_contact";
      source.contactCount = parsed.contacts.length;
      source.evidenceUrls = [...new Set(parsed.contacts.map((item) => item.evidenceUrl))];
      source.message = parsed.contacts.length
        ? `Codex Runner 取得 ${parsed.contacts.length} 条带原文证据的联系方式`
        : parsed.noResultReason || "Runner 已完成检索，但没有找到同时具备原文和来源网址的联系方式";
      source.suggestion = parsed.contacts.length
        ? ""
        : "请核对企业名称、国家和官网；也可以配置联系人 API 后重新查询。";
    }
    await persistContactAttempt(context.candidate, context.attempt);
  } catch (error) {
    context = contactAttemptContext(candidateId, attemptId);
    source = context && contactEnrichmentSource(context.attempt, "codex_runner");
    if (!context || !source) return;
    source.status = "failed";
    source.outcome = "provider_failed";
    source.completedAt = new Date().toISOString();
    source.errorCode = "CODEX_RUNNER_RESULT_INVALID";
    source.message = error instanceof Error ? error.message : "Runner 返回结果无法解析";
    source.suggestion = "请在集成中心检查 Runner 最终回复是否为规定 JSON，并确认每条联系方式都包含来源网址和原文。";
    await persistContactAttempt(context.candidate, context.attempt);
  }
}

async function executeContactEnrichment(
  user: SessionUser,
  candidateId: string,
  runId: string,
  force = false
) {
  const store = getStore();
  const candidate = store.websiteOpportunities.find((item) =>
    item.id === candidateId
    && item.teamId === user.teamId
    && item.ownerId === user.id
  );
  if (!candidate) return;
  const current = candidate.contactEnrichmentAttempts?.[0];
  if (!force && current && ["queued", "running"].includes(current.status)) return;
  const providers = contactEnrichmentProviders(user);
  const webSearchConfig = getAiConfig(user, "leadFinder");
  const webSearchPolicy = webSearchConfig ? aiWebSearchPolicy(webSearchConfig) : null;
  const webSearchReady = Boolean(
    webSearchConfig?.enabled
    && webSearchConfig.apiKey
    && webSearchConfig.useLeadFinder
    && webSearchPolicy?.ready
  );
  const countryBlocked = nativeResearchCountryBlocked(candidate.country || "");
  const attempt = createContactEnrichmentAttempt({
    candidate,
    runId,
    providerSources: providers.map((item) => ({
      id: item.provider.id,
      label: item.provider.name,
      configured: item.configured
    })),
    includeWebsite: true,
    webSearch: {
      configured: webSearchReady && !countryBlocked,
      label: webSearchConfig?.name || "AI 联网搜索",
      message: countryBlocked
        ? "按合规策略，中国及相关地区不执行自动联网联系人查询"
        : webSearchReady
          ? "等待模型原生 Web Search 查询公开联系方式"
          : webSearchPolicy?.message || "未配置支持 Web Search 的 OpenAI 模型",
      suggestion: countryBlocked
        ? "中国及相关地区请使用已授权的正式数据接口或人工录入。"
        : webSearchReady
          ? ""
          : webSearchPolicy
            ? webSearchFailureSuggestion(webSearchPolicy)
            : "请在 AI 配置中保存并测试支持 Responses API Web Search 的 OpenAI 模型。"
    },
    runner: {
      configured: !countryBlocked,
      label: "Codex Runner 深度补漏",
      message: countryBlocked ? "按合规策略不执行 Runner 联网研究" : "正在检查在线 Runner 与 Codex CLI 能力",
      suggestion: countryBlocked
        ? "中国及相关地区不使用自动网页研究，请改用正式授权接口。"
        : "若未检测到在线设备，系统会给出明确配置入口且不会阻塞其他来源。"
    },
    deadlineMs: 3 * 60_000
  });
  if (countryBlocked) {
    for (const sourceId of ["native_web_search", "website_probe", "codex_runner"]) {
      const source = contactEnrichmentSource(attempt, sourceId);
      if (!source) continue;
      source.status = "blocked";
      source.outcome = "policy_blocked";
      source.completedAt = new Date().toISOString();
      source.errorCode = "CONTACT_RESEARCH_REGION_BLOCKED";
      source.message = "按合规策略，中国及相关地区不执行自动网页联系人研究";
      source.suggestion = "请使用已授权的正式联系人接口或人工录入，并保留数据来源。";
    }
  }
  attempt.status = "running";
  attempt.startedAt = new Date().toISOString();
  for (const source of attempt.sources) {
    if (source.status === "queued" && source.sourceKind === "contact_provider") {
      source.status = "running";
      source.startedAt = attempt.startedAt;
    }
  }
  await persistCandidateChanges(store, [candidate], false);

  const runnerPlan = await contactRunnerPlan(user);
  const runnerContext = contactAttemptContext(candidateId, attempt.id);
  const runnerSource = runnerContext
    ? contactEnrichmentSource(runnerContext.attempt, "codex_runner")
    : null;
  if (runnerContext && runnerSource && !countryBlocked) {
    runnerSource.sourceLabel = runnerPlan.runner
      ? `Codex Runner · ${runnerPlan.runner.displayName}`
      : "Codex Runner 深度补漏";
    runnerSource.message = runnerPlan.message;
    runnerSource.suggestion = runnerPlan.suggestion;
    if (!runnerPlan.configured) {
      runnerSource.status = "skipped";
      runnerSource.outcome = "not_configured";
      runnerSource.completedAt = new Date().toISOString();
    }
    await persistContactAttempt(runnerContext.candidate, runnerContext.attempt);
  }

  const configuredProviders = providers.filter((item) => item.configured);
  const providerResults = await Promise.all(configuredProviders.map(async (item, index) => {
    try {
      const enriched = await executeProviderEnrich({
        provider: item.provider,
        catalog: item.catalog,
        context: createProviderExecutionContext({
          teamId: candidate.teamId,
          ownerId: candidate.ownerId,
          runId,
          providerId: item.provider.id,
          operation: "enrich",
          purpose: "prospect_multi_source_contact_enrichment",
          suffix: `${candidate.id.slice(-10)}-${index}`
        }),
        connection: item.connection,
        credential: item.connection ? undefined : { apiKey: "", baseUrl: "" },
        domain: websiteDomainKey(candidate.website || ""),
        onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
      });
      return { item, enriched, error: null };
    } catch (error) {
      return { item, enriched: null, error: providerErrorFromUnknown(error, "enrich") };
    }
  }));

  const latestCandidate = store.websiteOpportunities.find((item) =>
    item.id === candidateId && item.teamId === user.teamId && item.ownerId === user.id
  );
  const latestAttempt = latestCandidate?.contactEnrichmentAttempts?.find((item) =>
    item.id === attempt.id
  );
  if (!latestCandidate || !latestAttempt) return;
  for (const result of providerResults) {
    const source = contactEnrichmentSource(latestAttempt, result.item.provider.id);
    if (!source) continue;
    source.completedAt = new Date().toISOString();
    if (result.error) {
      source.status = "failed";
      source.outcome = /timeout|abort/iu.test(`${result.error.code} ${result.error.publicMessage}`)
        ? "timed_out"
        : "provider_failed";
      source.message = result.error.publicMessage;
      source.errorCode = result.error.code;
      source.retryable = result.error.retryable;
      source.retryAfterAt = result.error.retryAfterAt;
      source.suggestion = contactSearchAdjustment(result.error.code, result.error.publicMessage);
      continue;
    }
    const enriched = result.enriched;
    const contacts = enriched ? providerContactEvidence({
      company: latestCandidate.company,
      contact: enriched.contact,
      contactInfo: enriched.contactInfo,
      sourceId: result.item.provider.id,
      sourceLabel: result.item.provider.name,
      sourceUrl: enriched.evidence.sourceUrl,
      confidence: enriched.confidence,
      observedAt: enriched.evidence.fetchedAt
    }) : [];
    latestCandidate.extractedContacts = mergeProspectContactEvidence(
      latestCandidate.extractedContacts || [],
      contacts
    );
    if (enriched) {
      latestCandidate.sourceEvidence = mergeProviderEvidence(
        latestCandidate.sourceEvidence,
        [providerEvidenceSnapshot(result.item.provider.id, enriched.evidence)]
      );
      if (!latestCandidate.contactInfo && enriched.contactInfo) {
        latestCandidate.contactInfo = enriched.contactInfo;
      }
      if ((!latestCandidate.contact || latestCandidate.contact === "待维护") && enriched.contact) {
        latestCandidate.contact = enriched.contact;
      }
    }
    source.status = "completed";
    source.outcome = contacts.length ? "contact_found" : "no_contact";
    source.contactCount = contacts.length;
    source.message = contacts.length
      ? `联系人接口取得 ${contacts.length} 条结果`
      : "联系人接口未返回可用联系方式";
    source.suggestion = contacts.length
      ? ""
      : "请检查候选官网域名是否准确，或在集成中心增加其他联系人接口。";
  }
  refreshContactEnrichmentAttempt(latestCandidate, latestAttempt);
  await persistCandidateChanges(store, [latestCandidate], false);

  if (webSearchReady && webSearchConfig && !countryBlocked) {
    await executeNativeContactResearch(user, candidateId, attempt.id, webSearchConfig);
  }
  if (!countryBlocked) {
    await ensureContactResearchWebsite(
      user,
      candidateId,
      attempt.id,
      webSearchReady ? webSearchConfig : null
    );
  }

  // MySQL 持久化会用权威快照替换内存对象；进入官网队列前必须重新取当前引用。
  const websiteCandidate = store.websiteOpportunities.find((item) =>
    item.id === candidateId && item.teamId === user.teamId && item.ownerId === user.id
  );
  const websiteAttempt = websiteCandidate?.contactEnrichmentAttempts?.find((item) =>
    item.id === attempt.id
  );
  const websiteSource = websiteAttempt
    ? contactEnrichmentSource(websiteAttempt, "website_probe")
    : undefined;
  if (!websiteCandidate || !websiteAttempt || !websiteSource) return;
  if (countryBlocked) {
    refreshContactEnrichmentAttempt(websiteCandidate, websiteAttempt);
    await persistCandidateChanges(store, [websiteCandidate], false);
    return;
  }
  if (!/^https:\/\//iu.test(websiteCandidate.website || "")) {
    const discovery = websiteCandidate.websiteDiscoveryAttempts?.[0];
    websiteSource.status = "blocked";
    websiteSource.outcome = "policy_blocked";
    websiteSource.completedAt = new Date().toISOString();
    websiteSource.errorCode = discovery?.reasonCode || "CONTACT_WEBSITE_MISSING";
    websiteSource.message = discovery?.reason || "没有可信官网，无法继续核验公开联系方式";
    websiteSource.suggestion = webSearchReady
      ? "请核对企业名称和国家；当前官网候选未通过名称与域名校验。"
      : "请配置支持 Web Search 的模型或正式搜索 API，也可以人工补充可信官网后继续查询。";
    await persistContactAttempt(websiteCandidate, websiteAttempt);
    await executeRunnerContactResearch(user, candidateId, attempt.id, runnerPlan);
    return;
  }
  websiteSource.status = "running";
  websiteSource.startedAt = new Date().toISOString();
  websiteSource.message = "正在进入境外官网公开资料核验队列";
  refreshContactEnrichmentAttempt(websiteCandidate, websiteAttempt);
  await persistCandidateChanges(store, [websiteCandidate], false);
  const queuedCandidate = store.websiteOpportunities.find((item) =>
    item.id === candidateId && item.teamId === user.teamId && item.ownerId === user.id
  );
  if (!queuedCandidate) return;
  try {
    const queued = await queueWebsiteProbe(
      store,
      queuedCandidate,
      user.id,
      async (changedCandidate) => {
        const latestCandidate = store.websiteOpportunities.find((item) =>
          item.id === candidateId && item.teamId === user.teamId && item.ownerId === user.id
        );
        if (!latestCandidate) return;
        mergeWebsiteProbeCandidateProgress(latestCandidate, changedCandidate);
        websiteContactSourceProgress(latestCandidate, websiteAttempt.id);
        await persistCandidateChanges(store, [latestCandidate], false);
      },
      { extractPublicContacts: websiteContactAiExtractor(user) }
    );
    if (["completed", "failed"].includes(queued.attempt.status)) {
      const completedCandidate = store.websiteOpportunities.find((item) =>
        item.id === candidateId && item.teamId === user.teamId && item.ownerId === user.id
      );
      if (completedCandidate) {
        websiteContactSourceProgress(completedCandidate, websiteAttempt.id);
        await persistCandidateChanges(store, [completedCandidate], false);
      }
    }
  } catch (error) {
    const failedCandidate = store.websiteOpportunities.find((item) =>
      item.id === candidateId && item.teamId === user.teamId && item.ownerId === user.id
    );
    const failedAttempt = failedCandidate?.contactEnrichmentAttempts?.find((item) =>
      item.id === websiteAttempt.id
    );
    const failedSource = failedAttempt
      ? contactEnrichmentSource(failedAttempt, "website_probe")
      : undefined;
    if (!failedCandidate || !failedAttempt || !failedSource) return;
    failedSource.status = error instanceof WebsiteProbeError ? "blocked" : "failed";
    failedSource.outcome = error instanceof WebsiteProbeError
      ? "policy_blocked"
      : "provider_failed";
    failedSource.completedAt = new Date().toISOString();
    failedSource.message = error instanceof Error
      ? error.message
      : "境外官网验证未能启动";
    failedSource.errorCode = error instanceof WebsiteProbeError
      ? error.code
      : "CONTACT_WEBSITE_PROBE_FAILED";
    failedSource.suggestion = error instanceof WebsiteProbeError
      ? "请检查官网是否属于境外 HTTPS 站点并允许公开资料核验；系统不会处理受限内容。"
      : "请检查网络、官网地址和后台验证服务后重试。";
    refreshContactEnrichmentAttempt(failedCandidate, failedAttempt);
    await persistCandidateChanges(store, [failedCandidate], false);
  }

  for (let index = 0; index < 10; index += 1) {
    const currentContext = contactAttemptContext(candidateId, attempt.id);
    const currentWebsiteSource = currentContext
      ? contactEnrichmentSource(currentContext.attempt, "website_probe")
      : null;
    if (!currentContext
      || currentContext.attempt.recommendedContact
      || !currentWebsiteSource
      || !["queued", "running"].includes(currentWebsiteSource.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  await executeRunnerContactResearch(user, candidateId, attempt.id, runnerPlan);
}

export function scheduleContactEnrichment(
  user: SessionUser,
  candidateId: string,
  runId: string,
  force = false
) {
  const key = `${user.teamId}:${user.id}:${candidateId}`;
  const active = activeContactEnrichmentRuns.get(key);
  if (active) return active;
  const task = executeContactEnrichment(user, candidateId, runId, force)
    .catch((error) => {
      console.info("[lead-finder] contact enrichment stopped", {
        runId,
        candidateId,
        code: error instanceof ProviderContractError
          ? error.code
          : error instanceof WebsiteProbeError
            ? error.code
            : "UNCLASSIFIED"
      });
    })
    .finally(() => {
      if (activeContactEnrichmentRuns.get(key) === task) {
        activeContactEnrichmentRuns.delete(key);
      }
    });
  activeContactEnrichmentRuns.set(key, task);
  return task;
}

export function providerEvidenceSnapshot(providerId: string, record: ProviderRecord): ProviderEvidenceSnapshot {
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

export function mergeProviderEvidence(
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

export function normalizeProviderCountry(country: string) {
  const normalized = country
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[.\s_()-]+/g, "");
  if (!normalized || ["unknown", "未知", "待维护", "n/a", "na"].includes(normalized)) return "";
  return providerCountryAliases[normalized] || normalized;
}

export function normalizeCrmCompanyName(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/&/gu, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/gu)
    .filter(Boolean)
    .filter((token) => ![
      "co", "company", "corp", "corporation", "inc", "incorporated",
      "ltd", "limited", "llc", "gmbh", "ag", "bv", "srl", "sa",
      "spa", "pte", "plc", "kg", "oy", "ab", "sas", "sarl",
      "tnhh", "sdn", "bhd", "jsc", "kk", "kabushiki", "kaisha", "pvt", "pty"
    ].includes(token))
    .join(" ")
    .trim();
}

export function isSameProviderOpportunity(existing: WebsiteOpportunity, incoming: WebsiteOpportunity) {
  if (existing.ownerId !== incoming.ownerId || existing.teamId !== incoming.teamId) return false;
  const existingRecordKeys = providerEvidenceRecordKeys(existing.sourceEvidence);
  const incomingRecordKeys = providerEvidenceRecordKeys(incoming.sourceEvidence);
  if (incomingRecordKeys.size > 0
    && [...existingRecordKeys].some((key) => incomingRecordKeys.has(key))) {
    return true;
  }
  const existingDomain = websiteDomainKey(existing.website);
  const incomingDomain = websiteDomainKey(incoming.website);
  const existingCountry = normalizeProviderCountry(existing.country);
  const incomingCountry = normalizeProviderCountry(incoming.country);
  if (Boolean(
    existingDomain
    && incomingDomain
    && existingDomain === incomingDomain
    && existingCountry
    && incomingCountry
    && existingCountry === incomingCountry
  )) {
    return true;
  }
  // 第三优先级：归一化公司名 + 国家一致（同一实体换了域名/多渠道报告的场景，
  // 如同一家泰国公司先后报出 kansaipaint.co.th 与 kansai.co.th）。
  // 仅当**双方都没有独立来源记录键**时生效：免费法人源（GLEIF/Wikidata 等）同名
  // 但携带各自 providerRecordId 的记录是独立证据，必须保留（见 self-test 契约）。
  // 名字键过短（<4 字符）不参与，避免误并「3M」之类的短名牌。
  if (existingRecordKeys.size > 0 || incomingRecordKeys.size > 0) return false;
  const existingNameKey = normalizeCrmCompanyName(existing.company || "");
  const incomingNameKey = normalizeCrmCompanyName(incoming.company || "");
  return Boolean(
    existingNameKey.length >= 4
    && existingNameKey === incomingNameKey
    && existingCountry
    && incomingCountry
    && existingCountry === incomingCountry
  );
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
  existingFilteredCount: number;
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

export function persistProviderOpportunities(
  opportunities: WebsiteOpportunity[],
  inputStats: Pick<LeadFinderIncrementalStats, "rawCount" | "deduplicatedCount"> & {
    existingFilteredCount?: number;
  }
) {
  const store = getStore();
  const incrementalStats: LeadFinderIncrementalStats = {
    existingFilteredCount: 0,
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
      // 人工改过的候选不整体覆盖，但**空着的联系方式要补**：否则老候选会永远停在
      // 「待维护」，CLI 再次找到决策人/采购人邮箱也写不进去（用户会以为获客没生效）。
      if (!existing.contactInfo && item.contactInfo) existing.contactInfo = item.contactInfo;
      if ((!existing.contact || existing.contact === "待维护") && item.contact) existing.contact = item.contact;
      if (!existing.extractedContacts?.length && item.extractedContacts?.length) existing.extractedContacts = item.extractedContacts;
      existing.sourceEvidence = sourceEvidence;
      existing.confidence = confidence;
      existing.searchReport = item.searchReport || prospectSearchReport({
        ...existing,
        sourceEvidence
      });
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

export function readProviderConnectionConfiguration(connection?: ProviderConnection) {
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

export function providerCatalogByCode(code: string) {
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
    optionalKey: Boolean(provider.optionalKey || licensePolicy.optionalKey),
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
export function aiSearchStatus(user: SessionUser) {
  const configured = getAiConfigs(user).find((item) =>
    item.enabled && Boolean(item.apiKey)
  );
  const config = getAiConfig(user, "leadFinder");
  const externalWebsiteProviders = LEAD_PROVIDERS
    .filter((provider) => ["brave", "serper", "serpapi", "google_places"].includes(provider.id))
    .map((provider) => providerStatusFor(user, provider))
    .filter((status) => status.ready && status.enabled);
  const readiness = config
    ? aiLeadFinderReadiness(config, externalWebsiteProviders.length > 0)
    : null;
  const ready = Boolean(readiness?.ready);
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
    lastTestStatus: ready ? "passed" : config?.lastTestStatus || "untested",
    lastTestMessage: readiness?.message
      || (configured
        ? `模型已配置：${configured.model || configured.name}，请启用“自动获客”用途`
        : "请先在「AI 模型配置」保存并启用模型"),
    lastTestAt: config?.webSearchTestAt || config?.lastTestAt || "",
    usage: ""
  };
}

export function allProviderStatuses(user: SessionUser) {
  return [aiSearchStatus(user), ...LEAD_PROVIDERS.map((provider) => providerStatusFor(user, provider))];
}

export function prospectSearchReport(
  opportunity: WebsiteOpportunity
): NonNullable<WebsiteOpportunity["searchReport"]> {
  if (opportunity.searchReport) return opportunity.searchReport;
  const evidence = opportunity.sourceEvidence || [];
  const contactSources = (opportunity.extractedContacts || [])
    .flatMap((contact) => contact.corroboratedSources || [])
    .map((source) => source.evidenceUrl)
    .filter(Boolean);
  const verifiedFields = [...new Set(evidence.flatMap((item) => item.matchedFields || []))];
  const checkedSources = evidence.slice(0, 20).map((item) => ({
    url: normalizeWebsite(item.sourceUrl || item.officialWebsite || ""),
    title: item.providerId || opportunity.sourceLabel || "公开来源",
    authenticity: item.sourceLevel === "official"
      ? "official" as const
      : item.sourceLevel === "corroborated"
        ? "reputable_directory" as const
        : "search_result" as const,
    verifiedFields: item.matchedFields || [],
    finding: item.evidenceSummary || "公开来源记录"
  }));
  const sourceAuthenticity = checkedSources.some((source) => source.authenticity === "official")
    ? "official_confirmed"
    : checkedSources.length >= 2
      ? "multi_source_supported"
      : checkedSources.length === 1
        ? "single_source_supported"
        : "unknown";
  const hasContact = Boolean(opportunity.contactInfo?.trim() && contactSources.length);
  return {
    summary: [
      checkedSources.length ? `已核验 ${checkedSources.length} 个来源` : "来源待补全",
      verifiedFields.length ? `字段：${verifiedFields.join("、")}` : "",
      hasContact ? "联系方式有来源" : "联系方式待补"
    ].filter(Boolean).join("；"),
    sourceAuthenticity,
    verifiedFields,
    checkedSources,
    contactFinding: {
      status: hasContact ? "source_confirmed" : "missing",
      value: hasContact ? opportunity.contactInfo : "",
      sourceUrl: contactSources[0] || ""
    },
    nextAction: hasContact ? "复核来源后可加入搜客清单" : "优先补充公开联系方式"
  };
}

export function websiteDomainKey(raw: string) {
  if (!raw) return "";
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
  }
}

export function shouldArchiveTodo(todo: Todo, now = new Date()) {
  if (todo.historyAt) return false;
  if (todo.reminderRuleId && !todo.done) return false;
  const parsed = parseDueDate(todo.dueAt, todo.createdAt);
  if (!parsed) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return parsed < today;
}

export function archiveExpiredTodos(todos: Todo[], now = new Date()) {
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

export function nextTodoSortOrder(todos: Todo[], ownerId: string) {
  const scoped = todos.filter((todo) => todo.ownerId === ownerId);
  return Math.min(0, ...scoped.map((todo) => typeof todo.sortOrder === "number" ? todo.sortOrder : 0)) - 1;
}

/** 提醒规则阈值 → 毫秒（单一来源，判定与去重冷却共用）。 */
function reminderRuleDurationMs(rule: { days?: number; timeUnit?: string }) {
  const unitMs = rule.timeUnit === "minute" ? 60_000 : rule.timeUnit === "hour" ? 3_600_000 : rule.timeUnit === "week" ? 604_800_000 : 86_400_000;
  return (rule.days ?? 3) * unitMs;
}

export function matchReminderRule(targetOwnerId: string, rule: { ruleType?: string; targetStage?: string; days?: number; timeUnit?: string; targetCustomerIds?: string[]; priority?: string }) {
  const store = getStore();
  const targetIdSet = rule.targetCustomerIds && rule.targetCustomerIds.length ? new Set(rule.targetCustomerIds) : null;
  const scopedCustomers = store.customers.filter((customer) => customer.ownerId === targetOwnerId && (!targetIdSet || targetIdSet.has(customer.id)));
  const customerMap = new Map(scopedCustomers.map((customer) => [customer.id, customer]));
  const scopedDeals = store.deals.filter((deal) => deal.ownerId === targetOwnerId && customerMap.has(deal.customerId) && !deal.archivedAt);
  const stage = rule.targetStage || "已报价";
  const ruleType = rule.ruleType || "quote_no_reply";
  const durationMs = reminderRuleDurationMs(rule);
  const unitKey = `${rule.days ?? 3}${rule.timeUnit || "day"}`;
  const now = new Date();
  const result: Array<{ customer: Customer; deal?: Deal; dueAt: string; triggerKey: string }> = [];
  const addDealMatches = (deals: Deal[], dateValue: (deal: Deal) => string) => {
    deals.forEach((deal) => {
      const customer = customerMap.get(deal.customerId);
      const baseText = dateValue(deal);
      const base = new Date(baseText);
      if (!customer || !baseText || Number.isNaN(base.getTime())) return;
      const due = new Date(base.getTime() + durationMs);
      if (due > now) return;
      result.push({ customer, deal, dueAt: localMinuteText(due), triggerKey: `${deal.id}:${baseText}:${unitKey}` });
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
    if (!baseText) {
      // 从未跟进过的客户（没有任何活动记录）：视为已逾期，立即生成提醒；固定触发标识避免每次运行重复生成
      result.push({ customer, dueAt: currentMinuteText(), triggerKey: `${customer.id}:never:${unitKey}` });
      return;
    }
    const due = new Date(new Date(baseText).getTime() + durationMs);
    if (Number.isNaN(due.getTime()) || due > now) return;
    result.push({ customer, dueAt: localMinuteText(due), triggerKey: `${customer.id}:${baseText}:${unitKey}` });
  });
  return result;
}

type ReminderRuleRunOptions = {
  /**
   * 手工运行（用户点「手工运行」）需要把 lastRunAt 一并落库，所以即使没新建也要持久化；
   * 定时调度每分钟都跑，空转时持久化等于每分钟做一次全表重写，所以默认不写。
   */
  persistWhenNoChanges?: boolean;
};

type ReminderRuleRunResult = {
  reminder: Reminder;
  matchedCount: number;
  createdCount: number;
  skippedCount: number;
  failedCount: number;
  todos: Todo[];
};

/**
 * 判断某条匹配结果是否应当跳过（即不建待办）。
 *
 * 判定口径（2026-09-24 起，取代原来的"同键存在就跳过"）：
 *   ⓪ 规则未勾选「生成待办中心任务」（`generateTodo === false`）→ 跳过；规则只做匹配统计；
 *   ① 同键待办里存在「活的」（未完成、未归档、未取消）→ 跳过，避免重复催办；
 *   ② 同键待办全部已完结 → 从最后一次完结时刻起**重新计时**，距该时刻还没到规则阈值 → 仍跳过；
 *   ③ 已过阈值 → 不跳过（会重新建一条）。
 *
 * 语义：把「完成待办」视为"本次已处理"，之后按阈值节奏再次提醒，
 * 而不是像旧逻辑那样一旦建过就永远不再提醒（即使客户一直没有新活动）。
 */
export function reminderSkipReason(reminder: Reminder, triggerKey: string, now = Date.now()): ReminderSkipReason | "" {
  // ⓪ 未勾选「生成待办中心任务」→ 一律不建待办（规则仍跑，只更新命中/跳过统计）。
  //    放在最前面，让手工运行接口与 preview 预检接口对同一件事给出同一答案。
  if (reminder.generateTodo === false) return "generate-disabled";
  const store = getStore();
  const sameKey = store.todos.filter((todo) => todo.triggerKey === triggerKey);
  if (!sameKey.length) return "";
  const active = sameKey.find((todo) => !todo.done && !todo.historyAt && !todo.cancelledAt);
  if (active) return "active-todo";
  const lastClosedAt = sameKey.reduce((latest, todo) => {
    const raw = todo.completedAt || todo.historyAt || todo.createdAt;
    const ts = raw ? new Date(raw).getTime() : 0;
    return Number.isFinite(ts) && ts > latest ? ts : latest;
  }, 0);
  if (!lastClosedAt) return "";
  return now - lastClosedAt < reminderRuleDurationMs(reminder) ? "cooldown" : "";
}

/**
 * 执行一次提醒规则：匹配 → 去重 → 建站内待办。
 * 手工运行接口与定时调度共用这一份逻辑，保证「自动」与「手动」行为完全一致。
 * 去重键仍是 `${reminder.id}:${match.triggerKey}`，是否跳过由 shouldSkipReminderMatch() 决定：
 * 同一客户同一次活动在待办「活着」期间只建一条，待办完结后按阈值重新计时再提醒。
 */
export async function runReminderRuleNow(
  reminder: Reminder,
  actorId: string,
  options: ReminderRuleRunOptions = {}
): Promise<ReminderRuleRunResult> {
  const store = getStore();
  const matched = matchReminderRule(reminder.targetOwnerId || reminder.ownerId, reminder);
  const created: Todo[] = [];
  const skipBuckets = new Map<ReminderSkipReason, ReminderSkipReasonBucket>();
  let skippedCount = 0;
  let failedCount = 0;
  let lastError = "";
  for (const match of matched) {
    const triggerKey = `${reminder.id}:${match.triggerKey}`;
    const skipReason = reminderSkipReason(reminder, triggerKey);
    if (skipReason) {
      // 记下「为什么没生成」，界面直接显示原因，而不是只给一个"跳过 1"的数字。
      skippedCount += 1;
      const bucket = skipBuckets.get(skipReason) || { reason: skipReason, count: 0, customers: [] as string[] };
      bucket.count += 1;
      const company = match.customer.company;
      if (company && bucket.customers!.length < 3 && !bucket.customers!.includes(company)) bucket.customers!.push(company);
      skipBuckets.set(skipReason, bucket);
      continue;
    }
    const customer = match.customer;
    if (!customer.ownerId) {
      failedCount += 1;
      lastError = `${customer.company} 未分配负责人`;
      continue;
    }
    created.push({
      id: `t_rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: `${reminder.title}：${customer.company}`,
      type: "customer",
      priority: reminder.priority || "medium",
      status: "pending",
      pinState: "",
      sortOrder: nextTodoSortOrder(store.todos, customer.ownerId),
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
  if (created.length) store.todos.unshift(...created);
  reminder.generatedCount = matched.length;
  reminder.lastRunBy = actorId;
  reminder.lastRunAt = new Date().toISOString();
  reminder.lastMatchedCount = matched.length;
  reminder.lastCreatedCount = created.length;
  reminder.lastSkippedCount = skippedCount;
  reminder.lastFailedCount = failedCount;
  reminder.lastError = lastError;
  reminder.lastSkipReasons = [...skipBuckets.values()];
  reminder.status = "enabled";
  if (created.length || options.persistWhenNoChanges) await store.persist();
  return { reminder, matchedCount: matched.length, createdCount: created.length, skippedCount, failedCount, todos: created };
}

const REMINDER_RULE_MIN_POLL_MS = 5_000;
let reminderRuleSchedulerTimer: NodeJS.Timeout | null = null;
let reminderRuleSchedulerBusy = false;

function enabledReminderRules() {
  return getStore().reminders.filter((item) => item.enabled !== false && item.status === "enabled");
}

async function tickReminderRules(reason: string) {
  if (reminderRuleSchedulerBusy) return;
  reminderRuleSchedulerBusy = true;
  try {
    for (const rule of enabledReminderRules()) {
      try {
        const result = await runReminderRuleNow(rule, rule.targetOwnerId || rule.ownerId, { persistWhenNoChanges: false });
        if (result.createdCount) {
          console.log(`GoodJob CRM reminder rule「${rule.title}」created ${result.createdCount} todo(s) [${reason}] matched=${result.matchedCount} skipped=${result.skippedCount} failed=${result.failedCount}`);
        }
      } catch (error) {
        console.error(`GoodJob CRM reminder rule「${rule.title}」failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    reminderRuleSchedulerBusy = false;
  }
}

/**
 * 提醒规则调度器：按固定间隔扫描所有已启用规则并自动建待办。
 * 关闭方式：REMINDER_RULE_SCHEDULER=false；间隔：REMINDER_RULE_POLL_MS（默认 30s，下限 5s）。
 */
function startReminderRuleScheduler() {
  if (process.env.REMINDER_RULE_SCHEDULER === "false") {
    console.log("GoodJob CRM reminder rule scheduler disabled (REMINDER_RULE_SCHEDULER=false)");
    return;
  }
  const pollMs = Math.max(REMINDER_RULE_MIN_POLL_MS, Number(process.env.REMINDER_RULE_POLL_MS || 30_000) || 30_000);
  reminderRuleSchedulerTimer = setInterval(() => void tickReminderRules("scheduled"), pollMs);
  console.log(`GoodJob CRM reminder rule scheduler enabled (poll ${pollMs}ms, ${enabledReminderRules().length} enabled rule(s))`);
  void tickReminderRules("startup");
}

async function stopReminderRuleScheduler() {
  if (reminderRuleSchedulerTimer) clearInterval(reminderRuleSchedulerTimer);
  reminderRuleSchedulerTimer = null;
  while (reminderRuleSchedulerBusy) await new Promise((resolve) => setTimeout(resolve, 25));
}

/* ---------------------------------------------------------------------------
 * 资源埋点清理调度器（G14）
 * `pruneEvents` 早就实现了，但此前全项目没有调用方 —— 90 天保留期是空头支票，
 * resource_retrieval_events 只增不减，eventStats 的全表 GROUP BY 会越来越慢。
 * 这里按天触发一次，照 reminderRuleScheduler 的模式写（busy 互斥 / 可关 / 可随进程清理）。
 * --------------------------------------------------------------------------- */

const RESOURCE_EVENT_PRUNE_MIN_INTERVAL_MS = 3_600_000; // 下限 1 小时，防止配错把库打崩
let resourceEventPruneTimer: NodeJS.Timeout | null = null;

async function tickPruneResourceEvents(reason: string) {
  try {
    const removed = await getResourceHubRepository().pruneEvents(RESOURCE_RETENTION_DAYS);
    if (removed > 0) {
      console.log(`GoodJob CRM resource retrieval events pruned ${removed} row(s) [${reason}] (retention ${RESOURCE_RETENTION_DAYS}d)`);
    }
  } catch (error) {
    // 清理失败只记日志：它是保洁工序，不能反过来把主流程带下水
    console.error(`GoodJob CRM resource event prune failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 关闭方式：RESOURCE_EVENT_PRUNE=false；间隔：RESOURCE_EVENT_PRUNE_MS（默认 24h，下限 1h）。 */
function startResourceEventPruneScheduler() {
  if (process.env.RESOURCE_EVENT_PRUNE === "false") {
    console.log("GoodJob CRM resource event prune scheduler disabled (RESOURCE_EVENT_PRUNE=false)");
    return;
  }
  const intervalMs = Math.max(
    RESOURCE_EVENT_PRUNE_MIN_INTERVAL_MS,
    Number(process.env.RESOURCE_EVENT_PRUNE_MS || 86_400_000) || 86_400_000
  );
  resourceEventPruneTimer = setInterval(() => void tickPruneResourceEvents("scheduled"), intervalMs);
  console.log(`GoodJob CRM resource event prune scheduler enabled (every ${intervalMs}ms, retention ${RESOURCE_RETENTION_DAYS}d)`);
  void tickPruneResourceEvents("startup");
}

async function stopResourceEventPruneScheduler() {
  if (resourceEventPruneTimer) clearInterval(resourceEventPruneTimer);
  resourceEventPruneTimer = null;
}

export function currentMinuteText() {
  return localMinuteText(new Date());
}

function localMinuteText(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type AiUseCase = "leadFinder" | "websiteParse" | "scoring" | "emailDraft" | "exam";

export function getAiConfigs(user: SessionUser) {
  return getStore().aiModelConfigs
    .filter((item) => item.ownerId === user.id)
    .sort((left, right) => Number(right.enabled) - Number(left.enabled) || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export function configSupportsUseCase(config: AiModelConfig, useCase?: AiUseCase) {
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

export function getAiConfig(user: SessionUser, useCase?: AiUseCase) {
  const configs = getAiConfigs(user);
  return configs.find((item) => item.enabled && item.apiKey && configSupportsUseCase(item, useCase))
    || configs.find((item) => configSupportsUseCase(item, useCase))
    || configs[0]
    || null;
}

export function websiteContactAiExtractor(user: SessionUser): WebsiteContactAiExtractor | undefined {
  const config = getAiConfig(user, "websiteParse");
  if (!config?.enabled || !config.apiKey || !config.baseUrl || !config.model) return undefined;
  return (input) => extractWebsitePublicContactsWithAi(config, input);
}

export function normalizeWebsite(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function validateWebsiteLeadIngressSecurity() {
  validateWebsiteLeadIngressSettings(process.env.NODE_ENV === "production");
}

export async function startServer() {
  // 部署密钥文件：deploy-secrets.json 里填好的值在此补进 env（已设置的环境变量优先）
  const deploySecrets = loadDeploySecrets();
  if (deploySecrets.appliedKeys.length) {
    console.log(`GoodJob CRM deploy-secrets applied from ${deploySecrets.path}: ${deploySecrets.appliedKeys.join(", ")}`);
  }
  const mysqlRequested = process.env.CRM_STORE === "mysql"
    || (process.env.CRM_STORE !== "memory" && Boolean(process.env.DATABASE_URL || process.env.MYSQL_URL));
  let host = "127.0.0.1";
  let integrationEnabled = false;
  let integrationOAuthCallbackBaseUrl = "";
  let integrationOAuthSuccessRedirectUrl = "";
  try {
    validateAuthSecurity();
    validateWebsiteLeadIngressSecurity();
    validateProviderCredentialSecurity();
    // 追踪公网地址支持「设置页运行时配置」优先于 env（app_settings 持久化）
    setEmailTrackingRuntimeBaseUrl(await getAppSetting(EMAIL_TRACKING_BASE_URL_KEY));
    validateEmailTrackingSecurity();
    validateAgentJobSecurity();
    validateTradeObservationCursorSecurity();
    validateMarketOpportunityCursorSecurity();
    validateProspectRunSecurity();
    const integrationConfig = validateIntegrationControlPlaneConfig(process.env, mysqlRequested);
    integrationEnabled = integrationConfig.enabled;
    integrationOAuthCallbackBaseUrl = integrationConfig.oauthCallbackBaseUrl;
    integrationOAuthSuccessRedirectUrl = integrationConfig.oauthSuccessRedirectUrl;
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
  if (integrationEnabled) {
    try {
      const repository = getIntegrationRepository();
      if (!repository) throw new Error("Integration Repository 未初始化");
      const dispatcher = new BullMqIntegrationQueueDispatcher(String(process.env.REDIS_URL));
      await dispatcher.ready();
      await syncSystemConnectorCatalog(repository);
      activeIntegrationControlPlane = new IntegrationControlPlaneService(
        repository,
        dispatcher,
        String(process.env.INTEGRATION_CREDENTIAL_KEY),
        integrationOAuthCallbackBaseUrl,
        integrationOAuthSuccessRedirectUrl
      );
      activeIntegrationControlPlane.startMaintenance();
      setIntegrationControlPlaneService(activeIntegrationControlPlane);
      console.log("GoodJob CRM integration control plane enabled");
    } catch (error) {
      console.error(`GoodJob CRM integration startup failed: ${error instanceof Error ? error.message : String(error)}`);
      await getStore().close?.();
      process.exit(1);
      return;
    }
  }
  const store = getStore();
  const interruptedWebsiteCandidates = store.websiteOpportunities.filter((candidate) =>
    expireStaleWebsiteProbeAttempts(candidate)
  );
  if (interruptedWebsiteCandidates.length) {
    const ids = interruptedWebsiteCandidates.map((candidate) => candidate.id);
    if (store.persistProspectCandidates) await store.persistProspectCandidates(ids);
    else await store.persist();
    console.log(`GoodJob CRM recovered ${ids.length} interrupted website probe tasks`);
  }
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
    onRunCreated: () => prospectWorkerService?.synchronize(),
    onRunStalled: async (runId) => {
      if (!prospectWorkerService) {
        throw new Error("搜客执行服务未启动，无法回收超时任务");
      }
      await prospectWorkerService.requestCancel(runId);
    }
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
  /**
   * 发件邮箱轮换：policy.rotateMailboxEvery > 0 时，按「本批次/方案已发出的封数」
   * 分组轮流使用发件邮箱池里的邮箱（每 N 封换下一个）。池子为空/未启用时回落主发件邮箱。
   * 派发失败或读取池子出错都不阻断发送——回落主邮箱并发警告日志。
   */
  async function senderUserForBatch(
    owner: ReturnType<typeof getStore>["users"][number],
    batch: ProspectOutreachBatch
  ) {
    const every = Math.max(0, Math.floor(Number(batch.policy?.rotateMailboxEvery || 0)));
    if (!every) return owner;
    try {
      const repository = getSenderMailboxRepository();
      if (!repository) return owner;
      const mailboxes = await repository.list(owner.id, owner.teamId);
      const sentSteps = batch.items.reduce((sum, item) =>
        sum + item.steps.filter((step) => step.status === "sent").length, 0);
      const mailbox = pickSenderMailbox(mailboxes, sentSteps, every);
      if (!mailbox) return owner;
      return { ...owner, ...senderMailboxOverrides(mailbox) };
    } catch (error) {
      console.warn(`[outbound-email] 发件邮箱轮换失败，回落主发件邮箱：${error instanceof Error ? error.message : String(error)}`);
      return owner;
    }
  }

  const prospectOutreachBatchRuntime: ProspectOutreachBatchRuntime = {
    async send(batch, item, step, executionId) {
      const baseOwner = batchOwnerFor(batch);
      const owner = await senderUserForBatch(baseOwner, batch);
      // 条目级来源：方案手动名单可为 candidate/lead/customer；批次仍走 targetType
      const entityKind = item.entityType || (batch.targetType === "lead" ? "lead" : "candidate");
      if (entityKind === "lead") {
        const lead = store.leads.find((row) => row.id === (item.leadId || item.candidateId));
        if (!lead || lead.deletedAt) throw new Error("线索不存在或已被删除");
        if ((lead.email || "").trim() !== item.recipient && !item.recipient) throw new Error("线索邮箱缺失");
        const dispatch = await dispatchOutboundEmail(store, owner, {
          requestId: executionId,
          entityType: "lead",
          entityId: lead.id,
          to: item.recipient,
          subject: step.subject,
          body: step.body,
          source: "lead_batch_send"
        });
        recordCrmEmailTouchpoint(store, dispatch.log, {
          eventType: "send",
          direction: "outbound",
          occurredAt: dispatch.log.sentAt,
          subject: step.subject,
          content: step.body,
          contactValue: item.recipient,
          requestId: `batch:${executionId}`
        });
        store.leadActivities.unshift({
          id: `la_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          leadId: lead.id,
          type: "email",
          content: `发信批次发送：${step.subject}`,
          operatorId: owner.id,
          nextFollowAt: "",
          createdAt: dispatch.log.sentAt
        });
        return { recipient: dispatch.log.to || item.recipient, sentAt: dispatch.log.sentAt, messageId: dispatch.log.messageId };
      }
      if (entityKind === "customer") {
        const customer = store.customers.find((row) => row.id === item.candidateId);
        if (!customer) throw new Error("客户不存在或已被删除");
        const dispatch = await dispatchOutboundEmail(store, owner, {
          requestId: executionId,
          entityType: "customer",
          entityId: customer.id,
          to: item.recipient,
          subject: step.subject,
          body: step.body,
          source: "development_email_send"
        });
        recordCrmEmailTouchpoint(store, dispatch.log, {
          eventType: "send",
          direction: "outbound",
          occurredAt: dispatch.log.sentAt,
          subject: step.subject,
          content: step.body,
          contactValue: item.recipient,
          requestId: `batch:${executionId}`
        });
        store.customerActivities.unshift({
          id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          customerId: customer.id,
          type: "email",
          content: `自动发信方案发送：${step.subject}`,
          operatorId: owner.id,
          nextReminder: "",
          createdAt: dispatch.log.sentAt
        });
        return { recipient: dispatch.log.to || item.recipient, sentAt: dispatch.log.sentAt, messageId: dispatch.log.messageId };
      }
      const candidate = store.websiteOpportunities.find((row) => row.id === item.candidateId);
      if (!candidate) throw new Error("候选不存在或已被删除");
      return sendProspectBatchEmail(store, owner, candidate, item.recipient, step.subject, step.body, executionId);
    },
    async convertToLead(batch, item) {
      // 名单里的线索/客户不需要回流：线索已是线索，客户已在 CRM 内
      if (batch.targetType === "lead" || item.entityType === "lead") return item.entityType === "lead" ? item.candidateId : "";
      if (item.entityType === "customer") return "";
      const owner = batchOwnerFor(batch);
      const candidate = store.websiteOpportunities.find((row) => row.id === item.candidateId);
      if (!candidate) throw new Error("候选不存在或已被删除");
      return convertBatchCandidateToLead(store, owner, candidate, `prospect-batch:${batch.id}`);
    },
    async sentCountToday(batch) {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      return store.outboundEmailLogs.filter((log) =>
        log.ownerId === batch.ownerId
        && (log.sentAt || "") >= dayStart.toISOString()
        && ["prospect_batch_send", "prospect_send", "development_email_send", "agent_send", "lead_batch_send", "lead_send"].includes(log.source || "")
      ).length;
    },
    async bouncedCountForBatch(batch) {
      // 条目级统计：方案手动名单可能混有 candidate/lead/customer，各自按台账的 entityType 归集
      let bounced = 0;
      for (const item of batch.items) {
        const kind = item.entityType || (batch.targetType === "lead" ? "lead" : "candidate");
        const logEntityType = kind === "customer" ? "customer" : kind === "lead" ? "lead" : "prospect_candidate";
        const entityId = kind === "lead" ? (item.leadId || item.candidateId) : item.candidateId;
        bounced += store.outboundEmailLogs.filter((log) =>
          log.entityType === logEntityType
          && log.entityId === entityId
          && Boolean(log.bouncedAt)
        ).length;
      }
      return bounced;
    }
  };
  const prospectOutreachBatchRunner = new ProspectOutreachBatchRunner(store, prospectOutreachBatchRuntime, Number(process.env.PROSPECT_OUTREACH_BATCH_POLL_MS || 10_000));
  prospectOutreachBatchRunner.start();
  // 自动发送方案后台线程：复用同一套发送 runtime，按方案配置持续取人投递。
  // 第四个参数是「阶段感知成稿」运行时——方案入场时按目标自己的阶段 + 背调写信。
  // 方案可以属于任何业务员，所以运行时按 owner 缓存（同一 owner 复用同一份身份与来源缓存）。
  const planWritingRuntimes = new Map<string, OutreachWritingRuntime>();
  const writingRuntimeForOwner = (actor: { id: string; teamId: string }) => {
    const cached = planWritingRuntimes.get(actor.id);
    if (cached) return cached;
    const created = createOutreachWritingRuntime(actor);
    planWritingRuntimes.set(actor.id, created);
    return created;
  };
  const prospectOutreachPlanRunner = new ProspectOutreachPlanRunner(
    store,
    prospectOutreachBatchRuntime,
    Number(process.env.PROSPECT_OUTREACH_PLAN_POLL_MS || 15_000),
    {
      sender: (actor) => writingRuntimeForOwner(actor).sender(actor),
      resolve: (actor, target) => writingRuntimeForOwner(actor).resolve(actor, target)
    }
  );
  prospectOutreachPlanRunner.start();
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
  // ── 开发信回流感知：IMAP 轮询监听回信/退信（按开关启用）────────────
  if (process.env.INBOUND_MAIL_ENABLED === "true") {
    const inboundMailWatcher = new InboundMailWatcher(store, {
      pollMs: Number(process.env.INBOUND_MAIL_POLL_MS || 120_000),
      lookbackDays: Number(process.env.INBOUND_MAIL_LOOKBACK_DAYS || 7),
      maxMessagesPerPoll: Number(process.env.INBOUND_MAIL_MAX_MESSAGES_PER_POLL || 100),
      maxSourceBytes: Number(process.env.INBOUND_MAIL_MAX_SOURCE_BYTES || 2 * 1024 * 1024)
    });
    activeInboundMailWatcher = inboundMailWatcher;
    inboundMailWatcher.start();
    console.log(`GoodJob CRM inbound mail watcher enabled (poll ${Number(process.env.INBOUND_MAIL_POLL_MS || 120_000)}ms, lookback ${Number(process.env.INBOUND_MAIL_LOOKBACK_DAYS || 7)}d)`);
  }
  // ── 邮件中心：多账号收件同步（每个邮箱按自己的频率；MAIL_CENTER_SYNC=false 关闭）──
  if (process.env.MAIL_CENTER_SYNC !== "false") {
    const mailCenterSync = getMailCenterSyncService();
    if (mailCenterSync) {
      activeMailCenterSync = mailCenterSync;
      mailCenterSync.start();
      console.log("[mail-center] 收件同步已启用（账号级频率，最小 5 分钟，tick "
        + `${Number(process.env.MAIL_CENTER_SYNC_TICK_MS || 60_000)}ms）`);
    }
  }
  // ── 生产模式：后端直接 serve 前端静态文件（单端口模式）────────────
  const frontendDist = process.env.FRONTEND_DIST
    || path.resolve(process.cwd(), "../frontend/dist")
    || path.resolve(process.cwd(), "frontend/dist");
  const communicationFrontendDist = process.env.COMMUNICATION_FRONTEND_DIST?.trim();
  if (communicationFrontendDist && existsSync(communicationFrontendDist)) {
    app.use("/whatsapp-plugin", express.static(communicationFrontendDist, {
      index: false,
      maxAge: "7d",
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
      }
    }));
    app.get("/whatsapp-plugin/*", (_req, res) => {
      res.sendFile(path.resolve(communicationFrontendDist, "index.html"));
    });
    console.log(`GoodJob CRM serving Communication frontend from ${communicationFrontendDist}`);
  }
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist, {
      index: false,
      maxAge: "7d",
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store");
        }
      }
    }));
    // SPA 回退：所有非 /api、非 /uploads 的 GET 请求返回 index.html
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/")) {
        return next();
      }
      res.sendFile(path.resolve(frontendDist, "index.html"));
    });
    console.log(`GoodJob CRM serving frontend from ${frontendDist}`);
  }

  const httpServer = app.listen(port, host, () => {
    console.log(`GoodJob CRM API listening on http://${host}:${port}`);
  });
  httpServer.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/whatsapp-plugin/socket.io")) return;
    request.url = request.url.replace(/^\/whatsapp-plugin\/socket\.io/u, "/socket.io");
    communicationProxy.ws(request, socket, head);
  });
  scheduleMidnightTodoArchive();
  startReminderRuleScheduler();
  startResourceEventPruneScheduler();
  startAiEngineRecoveryScheduler();
  // 批量/方案的「按背调 + 按阶段」正文补写工序（缺背调补跑 → 引擎重写）
  startOutreachLetterEnrichmentScheduler();
  // 文件派生队列：先把上次进程留下的 processing 落成 failed 再重排，顺手清过期分片
  void startDerivePipeline()
    .then((result) => {
      if (result.reset || result.requeued || result.pruned) {
        console.log(`GoodJob CRM file derive recovered: reset=${result.reset} requeued=${result.requeued} pruned=${result.pruned}`);
      }
    })
    .catch((error) => {
      console.error("GoodJob CRM file derive pipeline failed to start:", error);
    });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`GoodJob CRM received ${signal}, shutting down`);
    try {
      activeInboundMailWatcher?.stop();
      activeInboundMailWatcher = null;
      activeMailCenterSync?.stop();
      activeMailCenterSync = null;
      await stopReminderRuleScheduler();
      await stopResourceEventPruneScheduler();
      stopAiEngineRecoveryScheduler();
      stopOutreachLetterEnrichmentScheduler();
      // 队列停了就行：正在跑的 soffice 进程有 60s 超时兜底，下次启动会把它落成 failed 重排
      deriveQueue.stop();
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
      setIntegrationControlPlaneService(null);
      await activeIntegrationControlPlane?.close();
      activeIntegrationControlPlane = null;
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
