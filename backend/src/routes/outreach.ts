/**
 * 外联方案、发信批次、外联旅程路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { z } from "zod";
import { hasIamPermission, requireAuth } from "../auth.js";
import { approveProspectOutreachBatch, batchLetterProgress, controlProspectOutreachBatch, createProspectOutreachBatch, deleteProspectOutreachBatch, getProspectOutreachBatch, listProspectOutreachBatches, updateProspectOutreachBatchItem } from "../prospect-outreach-batch.js";
import { controlProspectOutreachPlan, createProspectOutreachPlan, deleteProspectOutreachPlan, getProspectOutreachPlan, listProspectOutreachPlans, planCandidateMatches, planProgress } from "../prospect-outreach-plan.js";
import { buildOutreachJourney, buildOutreachJourneyDraft, listOutreachJourneyOverview, outreachSourceLabel, resolveOutreachJourneyEntity } from "../outreach-journey.js";
import { type OutboundEmailLog, type ProspectOutreachBatch, type SessionUser } from "../types.js";
import { getStore } from "../store.js";
import { recordCrmEmailTouchpoint } from "../email-touchpoints.js";
import { asyncRoute, createOutreachWritingRuntime, dispatchOutboundEmail, sendProspectBatchEmail } from "../server-core.js";

/**
 * 批次响应统一带上「正文补写进度」。
 * 界面上的「还有 N 条在补背调/重写」必须与后端同一口径 —— 两边各算一份迟早会漂移，
 * 而这条数字直接决定用户要不要现在点「确认发送」。
 */
function prospectBatchSummary(batch: ProspectOutreachBatch) {
  return { ...batch, letterProgress: batchLetterProgress(batch) };
}

// ---------------------------------------------------------------------------
// 自动发送方案（后台任务）：配置目标与频率，线程持续取人投递，可启停可观察
// ---------------------------------------------------------------------------

function prospectPlanSummary(plan: ReturnType<typeof getProspectOutreachPlan>) {
  const { items, ...rest } = plan;
  return {
    ...rest,
    progress: planProgress(plan),
    recentItems: items.slice(-5).reverse().map((item) => ({
      id: item.id,
      candidateId: item.candidateId,
      entityType: item.entityType || "candidate",
      company: item.company,
      recipient: item.recipient,
      status: item.status,
      skipReason: item.skipReason,
      sentAt: item.sentAt,
      convertedLeadId: item.convertedLeadId,
      // 阶段 + 成稿依据：前端据此显示「这条为什么是这封信」
      stageKey: item.stageKey,
      stageLabel: item.stageLabel,
      stageSource: item.stageSource,
      researchId: item.researchId,
      researchScore: item.researchScore,
      letterStatus: item.letterStatus,
      letterEngine: item.letterEngine,
      letterBasis: item.letterBasis,
      letterNote: item.letterNote,
      stepStatuses: item.steps.map((step) => ({
        index: step.index,
        status: step.status,
        sentAt: step.sentAt,
        stageKey: step.stageKey,
        stageLabel: step.stageLabel
      }))
    }))
  };
}

// ---------------------------------------------------------------------------
// 开发信档案（客户维度）
//
// 「发信明细」= 跨批次 / 方案把每个收件人聚合成一行，标出客户当前所处的开发阶段；
// 「开发信档案」= 单个客户的完整过程（发送历史 / 回复情况 / AI 背调 / 按阶段发下一封）。
// 聚合只读；发信仍复用既有 dispatchOutboundEmail 通道，并要求前端先冻结载荷再人工确认。
// ---------------------------------------------------------------------------

const outreachJourneyEntityTypeSchema = z.enum(["customer", "lead", "prospect_candidate"]);

/** 业务员只看自己名下；管理角色可切到「团队」视角 */
function outreachJourneyScopeFor(user: SessionUser, scope: string) {
  const canSeeTeam = user.role === "admin" || user.role === "super_admin" || user.role === "manager";
  return scope === "team" && canSeeTeam
    ? { ownerId: "", teamId: user.teamId }
    : { ownerId: user.id, teamId: "" };
}

function outreachJourneyAccessible(user: SessionUser, ownerId: string) {
  if (!ownerId) return true;
  if (ownerId === user.id) return true;
  return user.role === "admin" || user.role === "super_admin" || user.role === "manager";
}

const outreachJourneySendSchema = z.object({
  entityType: outreachJourneyEntityTypeSchema,
  entityId: z.string().trim().min(1).max(120),
  requestId: z.string().trim().min(1).max(120),
  to: z.string().trim().email().max(255),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20000)
});

export function registerOutreachRoutes(app: Express) {
  app.get("/api/outreach-plans", requireAuth, asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit || 50);
    res.json({ plans: listProspectOutreachPlans(getStore(), req.user!, limit).map(prospectPlanSummary) });
  }));

  app.post("/api/outreach-plans", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user!, "prospect.execute")) {
      res.status(403).json({ message: "当前账号没有创建发送方案的权限", permissionCode: "prospect.execute" });
      return;
    }
    try {
      const plan = await createProspectOutreachPlan(getStore(), req.user!, (req.body || {}) as Record<string, unknown>);
      res.json({ plan });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: error.issues[0]?.message || "方案参数不合法" });
        return;
      }
      throw error;
    }
  }));

  /** 创建前预览：当前筛选条件下候选池命中数与样例 */
  app.post("/api/outreach-plans/preview", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      countries: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
      keyword: z.string().trim().max(120).default("")
    });
    const input = schema.parse(req.body || {});
    const matched = planCandidateMatches(getStore(), req.user!, { countries: input.countries, keyword: input.keyword, maxTargets: 9999 });
    res.json({
      matched: matched.length,
      sample: matched.slice(0, 5).map((candidate) => ({
        id: candidate.id,
        company: candidate.company,
        country: candidate.country,
        hasEmail: Boolean((candidate.contactInfo || "").match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))
      }))
    });
  }));

  app.get("/api/outreach-plans/:id", requireAuth, asyncRoute(async (req, res) => {
    const plan = getProspectOutreachPlan(getStore(), req.user!, req.params.id);
    res.json({ plan, progress: planProgress(plan) });
  }));

  app.post("/api/outreach-plans/:id/control", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({ action: z.enum(["pause", "resume", "stop"]) });
    const input = schema.parse(req.body || {});
    try {
      const plan = await controlProspectOutreachPlan(getStore(), req.user!, req.params.id, input.action);
      res.json({ plan: prospectPlanSummary(plan) });
    } catch (error) {
      if (error && typeof error === "object" && "statusCode" in error) {
        res.status((error as { statusCode: number }).statusCode).json({ message: (error as unknown as Error).message });
        return;
      }
      throw error;
    }
  }));

  app.delete("/api/outreach-plans/:id", requireAuth, asyncRoute(async (req, res) => {
    try {
      await deleteProspectOutreachPlan(getStore(), req.user!, req.params.id);
      res.json({ deleted: req.params.id });
    } catch (error) {
      if (error && typeof error === "object" && "statusCode" in error) {
        res.status((error as { statusCode: number }).statusCode).json({ message: (error as unknown as Error).message });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/prospect-outreach-batches", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user!, "prospect.execute")) {
      res.status(403).json({ message: "当前账号没有创建发信批次的权限", permissionCode: "prospect.execute" });
      return;
    }
    try {
      // 传写信运行时：每个目标按**自己**的开发阶段 + 最近背调成稿，而不是全体共用一套固定模板
      const batch = await createProspectOutreachBatch(
        getStore(),
        req.user!,
        (req.body || {}) as Record<string, unknown>,
        createOutreachWritingRuntime(req.user!)
      );
      res.json({ batch: prospectBatchSummary(batch) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: error.issues[0]?.message || "批次参数不合法" });
        return;
      }
      throw error;
    }
  }));

  app.get("/api/prospect-outreach-batches", requireAuth, asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit || 20);
    res.json({ batches: listProspectOutreachBatches(getStore(), req.user!, limit).map(prospectBatchSummary) });
  }));

  app.post("/api/prospect-outreach-batches/:id/approve", requireAuth, asyncRoute(async (req, res) => {
    try {
      const batch = await approveProspectOutreachBatch(getStore(), req.user!, req.params.id);
      res.json({ batch: prospectBatchSummary(batch) });
    } catch (error) {
      if (typeof (error as { statusCode?: number }).statusCode === "number") {
        res.status((error as { statusCode: number }).statusCode).json({ message: (error as unknown as Error).message });
        return;
      }
      if (error instanceof Error && /不存在或无权访问/.test(error.message)) {
        res.status(404).json({ message: error.message });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/prospect-outreach-batches/:id/items/:itemId", requireAuth, asyncRoute(async (req, res) => {
    const rawBody = (req.body || {}) as Record<string, unknown>;
    const action = z.enum(["remove", "restore", "edit", "stage"]).parse(rawBody.action);
    const payload = action === "edit"
      ? z.object({
        stepIndex: z.coerce.number().int().min(0).max(9),
        subject: z.string().trim().min(1).max(160),
        body: z.string().trim().min(10).max(6000)
      }).parse({ stepIndex: rawBody.stepIndex, subject: rawBody.subject, body: rawBody.body })
      : action === "stage"
        // stageKey 允许为空串 = 撤销人工覆盖、回到系统推导
        ? z.object({ stageKey: z.string().trim().max(40) })
          .parse({ stageKey: rawBody.stageKey ?? "" })
        : undefined;
    try {
      // stage 动作要按新阶段重排这一条的信，所以同样需要写信运行时
      const result = await updateProspectOutreachBatchItem(
        getStore(),
        req.user!,
        req.params.id,
        req.params.itemId,
        action,
        payload,
        createOutreachWritingRuntime(req.user!)
      );
      res.json({ batch: prospectBatchSummary(result.batch), item: result.item });
    } catch (error) {
      if (typeof (error as { statusCode?: number }).statusCode === "number") {
        res.status((error as { statusCode: number }).statusCode).json({ message: (error as unknown as Error).message });
        return;
      }
      if (error instanceof Error && (/不存在/.test(error.message))) {
        res.status(404).json({ message: error.message });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/prospect-outreach-batches/:id/:action", requireAuth, asyncRoute(async (req, res) => {
    const action = z.enum(["pause", "resume", "cancel"]).parse(req.params.action);
    try {
      const batch = await controlProspectOutreachBatch(getStore(), req.user!, req.params.id, action);
      res.json({ batch: prospectBatchSummary(batch) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "不支持的动作" });
        return;
      }
      if (error instanceof Error && (/不存在或无权访问/.test(error.message) || /不能/.test(error.message))) {
        res.status(409).json({ message: error.message });
        return;
      }
      throw error;
    }
  }));

  app.get("/api/prospect-outreach-batches/:id", requireAuth, asyncRoute(async (req, res) => {
    try {
      const batch = getProspectOutreachBatch(getStore(), req.user!, req.params.id);
      res.json({ batch: prospectBatchSummary(batch) });
    } catch (error) {
      if (error instanceof Error && /不存在或无权访问/.test(error.message)) {
        res.status(404).json({ message: error.message });
        return;
      }
      throw error;
    }
  }));

  app.delete("/api/prospect-outreach-batches/:id", requireAuth, asyncRoute(async (req, res) => {
    try {
      const batch = await deleteProspectOutreachBatch(getStore(), req.user!, req.params.id);
      res.json({ deleted: batch.id });
    } catch (error) {
      if (error instanceof Error && /不存在或无权访问/.test(error.message)) {
        res.status(404).json({ message: error.message });
        return;
      }
      if (error instanceof Error && (error as { statusCode?: number }).statusCode === 409) {
        res.status(409).json({ message: error.message });
        return;
      }
      throw error;
    }
  }));

  app.get("/api/outreach-journey/overview", requireAuth, asyncRoute(async (req, res) => {
    const scope = String(req.query.scope || "self");
    const overview = await listOutreachJourneyOverview(getStore(), outreachJourneyScopeFor(req.user!, scope));
    res.json(overview);
  }));

  app.get("/api/outreach-journey/draft", requireAuth, asyncRoute(async (req, res) => {
    const entityType = outreachJourneyEntityTypeSchema.parse(String(req.query.entityType || ""));
    const entityId = String(req.query.entityId || "");
    const store = getStore();
    const entity = resolveOutreachJourneyEntity(store, entityType, entityId);
    if (!entity) {
      res.status(404).json({ message: "对象不存在或无权访问" });
      return;
    }
    if (!outreachJourneyAccessible(req.user!, entity.ownerId)) {
      res.status(403).json({ message: "只能查看自己名下客户的开发信过程" });
      return;
    }
    const view = await buildOutreachJourney(store, entityType, entityId);
    if (!view) {
      res.status(404).json({ message: "对象不存在或无权访问" });
      return;
    }
    res.json({
      draft: buildOutreachJourneyDraft(view.entity, view.stage, view.emails),
      stage: view.stage,
      entity: view.entity,
      recipient: view.entity.email,
      sourceLabel: outreachSourceLabel("journey_stage_send")
    });
  }));

  app.get("/api/outreach-journey", requireAuth, asyncRoute(async (req, res) => {
    const entityType = outreachJourneyEntityTypeSchema.parse(String(req.query.entityType || ""));
    const entityId = String(req.query.entityId || "");
    const store = getStore();
    const entity = resolveOutreachJourneyEntity(store, entityType, entityId);
    if (!entity) {
      res.status(404).json({ message: "对象不存在或无权访问" });
      return;
    }
    if (!outreachJourneyAccessible(req.user!, entity.ownerId)) {
      res.status(403).json({ message: "只能查看自己名下客户的开发信过程" });
      return;
    }
    const view = await buildOutreachJourney(store, entityType, entityId);
    if (!view) {
      res.status(404).json({ message: "对象不存在或无权访问" });
      return;
    }
    res.json(view);
  }));

  app.post("/api/outreach-journey/send", requireAuth, asyncRoute(async (req, res) => {
    const body = outreachJourneySendSchema.parse(req.body);
    const store = getStore();
    const user = req.user!;
    const entity = resolveOutreachJourneyEntity(store, body.entityType, body.entityId);
    if (!entity) {
      res.status(404).json({ message: "对象不存在或无权访问" });
      return;
    }
    if (!outreachJourneyAccessible(user, entity.ownerId)) {
      res.status(403).json({ message: "只能给自己名下客户的发开发信" });
      return;
    }
    const view = await buildOutreachJourney(store, body.entityType, body.entityId);
    if (view && !view.stage.canSend) {
      res.status(409).json({
        message: view.stage.blockReason || `当前阶段「${view.stage.label}」不建议继续发送开发信`,
        stage: view.stage.key
      });
      return;
    }
    const owner = store.users.find((item) => item.id === entity.ownerId && item.status === "active")
      || store.users.find((item) => item.id === user.id && item.status === "active");
    if (!owner) {
      res.status(409).json({ message: "发件账号不可用：该客户负责人账号已停用，请先指派或启用账号" });
      return;
    }

    if (body.entityType === "prospect_candidate") {
      const candidate = store.websiteOpportunities.find((item) => item.id === body.entityId);
      if (!candidate) {
        res.status(404).json({ message: "搜客候选不存在" });
        return;
      }
      const result = await sendProspectBatchEmail(store, owner, candidate, body.to, body.subject, body.body, body.requestId);
      await store.persist().catch(() => undefined);
      res.json({
        sent: { ...result, simulated: ["test", "e2e"].includes(process.env.NODE_ENV || "") },
        journey: await buildOutreachJourney(store, body.entityType, body.entityId)
      });
      return;
    }

    const logEntityType: OutboundEmailLog["entityType"] = body.entityType === "lead" ? "lead" : "customer";
    const dispatch = await dispatchOutboundEmail(store, owner, {
      requestId: body.requestId,
      entityType: logEntityType,
      entityId: body.entityId,
      to: body.to,
      subject: body.subject,
      body: body.body,
      source: "journey_stage_send"
    });
    const sentAt = dispatch.log.sentAt;
    recordCrmEmailTouchpoint(store, dispatch.log, {
      eventType: "send",
      direction: "outbound",
      occurredAt: sentAt,
      subject: body.subject,
      content: body.body,
      contactValue: body.to,
      requestId: `journey:${body.requestId}`
    });
    if (logEntityType === "lead") {
      store.leadActivities.unshift({
        id: `la_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        leadId: body.entityId,
        type: "email",
        content: `开发信档案 · 按阶段发送：${body.subject}`,
        operatorId: owner.id,
        nextFollowAt: "",
        createdAt: sentAt
      });
    } else {
      store.customerActivities.unshift({
        id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        customerId: body.entityId,
        type: "email",
        content: `开发信档案 · 按阶段发送：${body.subject}`,
        operatorId: owner.id,
        nextReminder: "",
        createdAt: sentAt
      });
    }
    owner.lastDevelopmentEmailAt = sentAt;
    owner.lastDevelopmentEmailTo = body.to;
    owner.lastDevelopmentEmailSubject = body.subject;
    await store.persist().catch(() => undefined);
    res.json({
      sent: {
        recipient: body.to,
        sentAt,
        messageId: dispatch.log.messageId,
        replayed: dispatch.replayed,
        simulated: ["test", "e2e"].includes(process.env.NODE_ENV || "")
      },
      journey: await buildOutreachJourney(store, body.entityType, body.entityId)
    });
  }));
}
