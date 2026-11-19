/**
 * 智能获客：Agent 任务、项目、策略、计划、运行、超级搜索、绩效路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Response } from "express";
import { z } from "zod";
import { once } from "node:events";
import { canSeeOwner, requireAuth } from "../auth.js";
import { cancelAgentJob, isProspectRunBridgeJob, publicAgentJob, retryAgentJob } from "../agent-jobs.js";
import { createMarketAnalysisRun, MARKET_ANALYSIS_JOB_TYPE, marketAnalysisRunMetadata, MarketAnalysisRunProviderError, MarketAnalysisRunRequestError, retryMarketAnalysisJob } from "../market-analysis-runs.js";
import { getStore } from "../store.js";
import { createProspectSuperSearch, createProspectSuperSearchSchema, listProspectSuperSearches, prospectSuperSearchActionSchema, prospectSuperSearchEtag, prospectSuperSearchPreview, prospectSuperSearchPreviewSchema, refreshProspectSuperSearchMissionResults, superSearchDetail, transitionProspectSuperSearch } from "../prospect-super-search.js";
import { listTradeObservations, parseTradeObservationListQuery, TradeObservationListRequestError } from "../trade-observation-list.js";
import { listMarketOpportunities, MarketOpportunityListRequestError, parseMarketOpportunityListQuery } from "../market-opportunity-list.js";
import { activateProspectCampaign, createProspectCampaign, createProspectCampaignSchema, createProspectCampaignVersion, createProspectCampaignVersionSchema, getProspectCampaign, listProspectCampaigns, prospectCampaignActionSchema, prospectCampaignEtag, prospectCampaignIdSchema, resolveMarketCampaignReference, transitionProspectCampaign, updateProspectCampaign, updateProspectCampaignSchema } from "../prospect-campaigns.js";
import { convertProspectToLeadBodySchema } from "../prospect-lead-conversion.js";
import { convertProspectToCustomerBodySchema, ProspectCustomerConversionError } from "../prospect-customer-conversion.js";
import { generateCustomerIntelligenceSuggestion } from "../customer-intelligence.js";
import { migrateProspectFollowUpTodos } from "../prospect-outreach.js";
import { linkProcurementContextToCustomer, linkProcurementContextToLead } from "../procurement-signals.js";
import { generateProspectStrategySuggestions, prospectPerformance, reviewProspectStrategySuggestion } from "../prospect-outcome-feedback.js";
import { approveProspectStrategy, createProspectStrategy, createProspectStrategySchema, disableProspectStrategy, getProspectStrategy, listProspectStrategies, previewProspectStrategy, previewProspectStrategySchema, prospectStrategyActionSchema, prospectStrategyEtag, prospectStrategyIdSchema, updateProspectStrategy, updateProspectStrategySchema } from "../prospect-strategies.js";
import { createProspectRun, createProspectRunSchema, getProspectRun, listProspectRuns, parseProspectRunListQuery, prospectRunActionSchema, prospectRunIdempotencyKeySchema, prospectRunIdSchema, ProspectRunRequestError, transitionProspectRun } from "../prospect-runs.js";
import { type ProspectLiveEvent } from "../prospect-live-events.js";
import { createProspectSchedule, createProspectScheduleSchema, deleteProspectSchedule, listProspectSchedules, prospectScheduleActionSchema, prospectScheduleEtag, prospectScheduleIdSchema, transitionProspectSchedule } from "../prospect-schedules.js";
import {
  activeProspectWorkerService,
  asyncRoute,
  notifyNewLead,
  persistCandidateChanges,
  requestCorrelationId,
  sendProspectCampaignError,
  sendProspectLeadConversionError,
  setProspectRunEtag,
  synchronizeProspectQueue
} from "../server-core.js";

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

const prospectPendingSelectionSchema = z.object({
  hitIds: z.array(
    z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/)
  ).min(1).max(200)
}).strict();

export function registerProspectingRoutes(app: Express) {
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
      if (result.created && !result.replayed) {
        notifyNewLead(result.lead);
        await store.persist();
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
}
