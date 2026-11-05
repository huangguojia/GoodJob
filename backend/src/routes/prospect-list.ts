/**
 * 搜客清单路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canSeeOwner, hasIamPermission, requireAuth } from "../auth.js";
import { getBackgroundResearchRepository } from "../outreach-journey.js";
import { type ProspectIdentityBootstrapAttempt, type ProspectOutreachChannel, type SessionUser, type WebsiteOpportunity } from "../types.js";
import { type CrmStore, getStore } from "../store.js";
import { getProvider } from "../lead-providers.js";
import { providerErrorFromUnknown } from "../provider-contract.js";
import { createProviderExecutionContext, executeProviderSearch } from "../provider-runtime.js";
import { expireContactEnrichmentAttempt } from "../prospect-contact-enrichment.js";
import { syncProspectCandidateCoverage } from "../prospect-candidate-actions.js";
import { approveProspectContactability, approveProspectIcpQualification, evaluateProspectContactability, prospectChannelQualificationSchema, prospectCompanyQualificationSchema, prospectContactabilityEvaluationSchema, prospectIcpQualificationSchema, prospectQualificationApprovalSchema, prospectQualificationView, prospectSuppressionSchema, recordProspectChannelQualification, recordProspectCompanyQualification, recordProspectIcpQualification, setProspectSuppression } from "../prospect-qualification-workflow.js";
import { applyProspectQualificationCommand, prospectCandidateQualificationBasisHash, prospectCandidateQualificationChangedFields } from "../prospect-qualification.js";
import { assertProspectEmailOutreachEligible } from "../prospect-outreach-eligibility.js";
import { ensureProspectFollowUpTodo, recordProspectTouchpoint } from "../prospect-outreach.js";
import { queueWebsiteProbe, websiteProbeCapability, websiteProbeDetail, WebsiteProbeError } from "../website-probe.js";
import { attachProspectIdentityBootstrapRun, beginProspectIdentityBootstrap, failProspectIdentityBootstrap, normalizeProspectIdentityRegistration, ProspectIdentityBootstrapError, prospectIdentityBootstrapView, reconcileProspectIdentityBootstrap } from "../prospect-identity-bootstrap.js";
import { proposeDealRecommendation, recordProcurementSignal } from "../procurement-signals.js";
import { normalizeWebsiteReference, withProspectVerificationReport } from "../prospect-verification.js";
import {
  accountUser,
  allProviderStatuses,
  asyncRoute,
  dispatchOutboundEmail,
  getAgentProspectSearchProgress,
  getProviderConnection,
  persistCandidateChanges,
  procurementContextForCandidate,
  prospectSearchReport,
  providerCatalogByCode,
  requestCorrelationId,
  scheduleContactEnrichment,
  sendOutboundEmailFailure,
  sendProspectCampaignError,
  sendProspectLeadConversionError,
  sendProspectQualificationError,
  startAgentProspectSearch,
  websiteContactAiExtractor
} from "../server-core.js";

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

function sendWebsiteProbeError(res: Response, error: unknown) {
  if (!(error instanceof WebsiteProbeError)) return false;
  res.status(error.status).json({
    message: error.message,
    errorCode: error.code
  });
  return true;
}

function canManageProspectAssignments(user?: SessionUser) {
  return hasIamPermission(user, "lead.assign");
}

function prospectAssigneesFor(user: SessionUser) {
  return getStore().users
    .filter((item) => item.status === "active" && item.teamId === user.teamId)
    .map((item) => ({ id: item.id, name: item.name, role: item.role, teamId: item.teamId }));
}

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
  candidate.searchReport = prospectSearchReport(candidate);
  await persistCandidateChanges(store, [candidate], false);
  return { qualification, opportunity: candidate };
}

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

export function registerProspectListRoutes(app: Express) {
  app.use(
    "/api/prospect-list",
    requireAuth,
    asyncRoute(async (_req, _res, next) => {
      await getStore().reloadProspectCandidates?.();
      next();
    })
  );

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
    let dispatch: Awaited<ReturnType<typeof dispatchOutboundEmail>>;
    try {
      dispatch = await dispatchOutboundEmail(store, user, {
        requestId,
        entityType: "prospect_candidate",
        entityId: opportunity.id,
        to: eligibility.recipient,
        subject: body.subject,
        body: body.body,
        source: "prospect_send"
      });
    } catch (error) {
      sendOutboundEmailFailure(res, error, user);
      return;
    }
    const sentAt = dispatch.log.sentAt;
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
      occurredAt: sentAt,
      messageId: dispatch.log.messageId
    });
    await persistCandidateChanges(store, [opportunity]);
    res.json({
      sent: {
        id: `mail_${Date.now()}`,
        status: "sent",
        simulated: process.env.NODE_ENV === "test",
        messageId: dispatch.log.messageId,
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

  app.get("/api/prospect-list/assignees", requireAuth, (req, res) => {
    if (!canManageProspectAssignments(req.user)) {
      res.json({ assignees: [] });
      return;
    }
    res.json({ assignees: prospectAssigneesFor(req.user!) });
  });

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

  /**
   * 候选最近一次背调记录：详情面板 / 校验抽屉打开时回填「AI 背调」区块。
   * 背调本身只写 background_research_records 留档；没有这个读口，结果只能在
   * 当次执行的页面里看到，重开详情就"消失"（2026-10-07 用户反馈）。
   */
  app.get("/api/prospect-list/:id/background-research", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const candidate = store.websiteOpportunities.find((item) =>
      item.id === req.params.id && canSeeOwner(req.user!, item.ownerId, item.teamId)
    );
    if (!candidate) {
      res.status(404).json({ message: "搜客候选不存在或无权访问" });
      return;
    }
    const repository = getBackgroundResearchRepository();
    const records = repository
      ? await repository.list(req.user!.teamId, "prospect", candidate.id, 1).catch(() => [])
      : [];
    const record = records[0] || null;
    let research: unknown = null;
    if (record) {
      try {
        const payload = JSON.parse(record.payloadJson || "null") as Record<string, unknown> | null;
        // 留档 payload 就是 research 内层对象（persistBackgroundResearchRecord 直存 research）
        research = (payload?.research as unknown) ?? payload;
      } catch {
        research = null;
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      research,
      completedAt: record?.createdAt || null,
      engine: record?.engine || ""
    });
  }));

  app.get("/api/prospect-list/:id/contact-enrichment", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const candidate = store.websiteOpportunities.find((item) =>
      item.id === req.params.id && canSeeOwner(req.user!, item.ownerId, item.teamId)
    );
    if (!candidate) {
      res.status(404).json({ message: "搜客候选不存在或无权访问" });
      return;
    }
    const latestAttempt = candidate.contactEnrichmentAttempts?.[0];
    if (latestAttempt && expireContactEnrichmentAttempt(candidate, latestAttempt)) {
      await persistCandidateChanges(store, [candidate], false);
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      attempt: candidate.contactEnrichmentAttempts?.[0] || null,
      contacts: candidate.extractedContacts || [],
      opportunity: candidate
    });
  }));

  app.post("/api/prospect-list/:id/contact-enrichment", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      force: z.boolean().optional().default(false)
    }).parse(req.body || {});
    const store = getStore();
    const candidate = store.websiteOpportunities.find((item) =>
      item.id === req.params.id
      && item.teamId === req.user!.teamId
      && item.ownerId === req.user!.id
    );
    if (!candidate) {
      res.status(404).json({ message: "搜客候选不存在，或仅候选归属业务员可以查找联系人" });
      return;
    }
    const active = candidate.contactEnrichmentAttempts?.find((item) =>
      item.status === "queued" || item.status === "running"
    );
    if (active && !body.force) {
      res.status(202).json({ attempt: active, opportunity: candidate, replayed: true });
      return;
    }
    const runId = `contact_${randomUUID()}`;
    void scheduleContactEnrichment(req.user!, candidate.id, runId, body.force);
    res.status(202).json({
      attempt: candidate.contactEnrichmentAttempts?.[0] || null,
      opportunity: candidate,
      replayed: false
    });
  }));

  app.get("/api/prospect-list/:id/identity-bootstrap", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const refreshResults = await Promise.allSettled([
      store.reloadOrganizationIdentityTeam?.(req.user!.teamId),
      store.reloadProspectCoverageTeam?.(req.user!.teamId),
      store.reloadProspectQualificationTeam?.(req.user!.teamId)
    ]);
    const refreshFailure = refreshResults.find((result) =>
      result.status === "rejected"
    );
    if (refreshFailure?.status === "rejected") {
      console.warn(
        "Prospect identity bootstrap cache refresh degraded to current team snapshot:",
        refreshFailure.reason instanceof Error
          ? refreshFailure.reason.message
          : String(refreshFailure.reason)
      );
    }
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

  app.post("/api/prospect-list/:id/identity-bootstrap/discover", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      providerId: z.enum(["gleif", "companies_house", "sec_edgar", "fr_company_search"])
    }).strict().parse(req.body);
    const store = getStore();
    let candidate: WebsiteOpportunity;
    try {
      prospectIdentityBootstrapView(store, req.user!, String(req.params.id));
      candidate = store.websiteOpportunities.find((item) =>
        item.id === req.params.id
        && item.teamId === req.user!.teamId
        && item.ownerId === req.user!.id
      )!;
    } catch (error) {
      if (sendProspectIdentityBootstrapError(res, error)) return;
      throw error;
    }
    const provider = getProvider(body.providerId);
    const catalog = providerCatalogByCode(body.providerId);
    const status = allProviderStatuses(req.user!).find((item) =>
      item.id === body.providerId
    );
    if (!provider?.search || !catalog || !status?.ready || !status.enabled) {
      res.status(409).json({
        message: `${status?.name || body.providerId} 当前不可用，请先在数据源中心完成配置`,
        errorCode: "IDENTITY_AUTHORITY_PROVIDER_NOT_READY"
      });
      return;
    }
    const runId = `identity_discovery_${randomUUID()}`;
    try {
      const connection = getProviderConnection(req.user!, body.providerId);
      const result = await executeProviderSearch({
        provider,
        catalog,
        context: createProviderExecutionContext({
          teamId: req.user!.teamId,
          ownerId: req.user!.id,
          runId,
          providerId: body.providerId,
          operation: "search",
          purpose: "identity_registration_discovery"
        }),
        connection,
        credential: connection ? undefined : { apiKey: "", baseUrl: "" },
        query: {
          goal: candidate.company,
          productKeywords: candidate.company,
          countries: candidate.country,
          industry: "",
          customerType: "",
          excludeKeywords: "",
          limit: 8
        },
        onLogs: (logs) => store.providerRequestLogs.unshift(...logs)
      });
      const candidates = result.records.flatMap((record) => {
        try {
          const normalized = normalizeProspectIdentityRegistration(
            body.providerId,
            record.providerRecordId
          );
          return [{
            company: record.company,
            country: record.country,
            registrationNumber: normalized.registrationNumber,
            sourceUrl: record.sourceUrl,
            evidenceSummary: record.evidenceSummary
          }];
        } catch {
          return [];
        }
      }).slice(0, 6);
      res.setHeader("Cache-Control", "no-store");
      res.json({ candidates, provider: status.name, query: candidate.company });
    } catch (error) {
      const failure = providerErrorFromUnknown(error, "search");
      res.status(failure.httpStatus || 502).json({
        message: failure.publicMessage,
        errorCode: failure.code
      });
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
        },
        { extractPublicContacts: websiteContactAiExtractor(req.user!) }
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
    opportunity.searchReport = prospectSearchReport(opportunity);
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
      action: z.enum(["shortlist", "mark-contactable", "exclude", "restore", "assign"]),
      ownerId: z.string().min(1).optional(),
      reason: z.string().max(255).optional().default(""),
      sourceRunId: z.string().trim().min(1).max(120).optional(),
      requestId: z.string().min(1).max(120).optional(),
      effectiveAt: z.string().datetime().optional()
    });
    const body = schema.parse(req.body);
    const store = getStore();
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
    if (opportunities.some((item) => item.status === "synced") && ["exclude", "assign", "mark-contactable"].includes(body.action)) {
      res.status(400).json({ message: "已入线索的数据不能排除、重新分配或重复标记，请在线索中心处理" });
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
        if (body.action === "exclude" || body.action === "restore") {
          coverageResult = await syncProspectCandidateCoverage({
            store,
            candidate: item,
            actorId: req.user!.id,
            action: body.action,
            requestId: `prospect-batch:${requestId}:${item.id}:${body.action}`,
            effectiveAt: changedAt
          });
        }
        if (body.action === "shortlist") {
          item.shortlistedAt ||= changedAt;
          item.shortlistedBy ||= req.user!.id;
          item.shortlistSourceRunId ||= body.sourceRunId;
        } else if (body.action === "mark-contactable") {
          item.status = "contactable";
        } else if (body.action === "exclude") {
          if (!coverageResult) item.status = "excluded";
          item.excludedReason = body.reason.trim() || "人工核验后排除";
        } else if (body.action === "restore") {
          if (!coverageResult) item.status = "preview";
          item.excludedReason = "";
        } else if (assignee) {
          item.ownerId = assignee.id;
          item.teamId = assignee.teamId;
        }
        if (body.action !== "shortlist") {
          item.statusChangedAt = changedAt;
          withProspectVerificationReport(item, changedAt);
        }
      }
    } catch (error) {
      if (sendProspectLeadConversionError(res, error)) return;
      throw error;
    }
    await persistCandidateChanges(store, opportunities, false);
    if (body.action === "shortlist") {
      for (const item of opportunities.filter((candidate) => candidate.ownerId === req.user!.id)) {
        const activeAttempt = item.contactEnrichmentAttempts?.some((attempt) =>
          attempt.status === "queued" || attempt.status === "running"
        );
        if (!activeAttempt) {
          void scheduleContactEnrichment(
            req.user!,
            item.id,
            `contact_auto_shortlist_${randomUUID()}`,
            false
          );
        }
      }
    }
    res.json({ opportunities });
  }));
}
