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
import { asyncRoute, createOutreachWritingRuntime, dispatchOutboundEmail, sendOutreachSummaryForBatch, sendProspectBatchEmail } from "../server-core.js";
import { readOutreachSummarySettings, readOutreachSummaryState } from "../outreach-send-summary.js";
import { emitCrmEvent } from "../crm-events.js";
import { readWecomLog, readWecomSettings } from "../wecom-push.js";
import { readJsonSetting, writeJsonSetting } from "../json-settings.js";
import { randomUUID } from "node:crypto";

/**
 * 批次响应统一带上「正文补写进度」。
 * 界面上的「还有 N 条在补背调/重写」必须与后端同一口径 —— 两边各算一份迟早会漂移，
 * 而这条数字直接决定用户要不要现在点「确认发送」。
 */
function prospectBatchSummary(batch: ProspectOutreachBatch) {
  return { ...batch, letterProgress: batchLetterProgress(batch) };
}

/**
 * 发信效果口径（打开 / 点击 / 回复 / 退信）。
 *
 * 归集靠台账的 request_id 前缀，这是唯一稳定的关联：人工批次写 `batch:<批次id>:<条目id>:<第几步>`，
 * 自动发送方案写 `plan:<方案id>:<条目id>:<第几步>`（planAsBatch 把方案当批次跑）。
 * 打开/点击来自像素与链接追踪，回复/退信来自回信监听 —— 四者都落在同一行台账上，不用再跨表拼。
 */
export interface OutreachEngagement {
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  /** 打开率（%，保留一位小数）：按"送达封数"算，未打开的也算分母 */
  openRate: number;
}

const EMPTY_ENGAGEMENT: OutreachEngagement = { sent: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, openRate: 0 };

function outreachEngagementFor(
  store: ReturnType<typeof getStore>,
  user: { id: string; role: string; teamId: string },
  prefix: string
): OutreachEngagement {
  const result = { ...EMPTY_ENGAGEMENT };
  for (const log of store.outboundEmailLogs) {
    if (!log.requestId || !log.requestId.startsWith(prefix)) continue;
    // 可见范围与「发信明细」同口径（outreachJourneyAccessible）：同团队 + 本人或管理岗。
    // 这里直接展开判断，是因为拿到的是库里的 User（authVersion 可选），与 SessionUser 不是同一类型。
    if (log.teamId !== user.teamId) continue;
    const visible = log.ownerId === user.id || user.role === "admin" || user.role === "super_admin" || user.role === "manager";
    if (!visible) continue;
    // 只认真出去的：pending / uncertain / failed 不能算进"已发"，否则打开率会被拉低
    if ((log.dispatchStatus || "sent") !== "sent") continue;
    result.sent += 1;
    if ((log.openCount || 0) > 0) result.opened += 1;
    if ((log.clickCount || 0) > 0) result.clicked += 1;
    if (log.repliedAt) result.replied += 1;
    if (log.bouncedAt) result.bounced += 1;
  }
  result.openRate = result.sent ? Math.round((result.opened / result.sent) * 1000) / 10 : 0;
  return result;
}

/**
 * 获客任务归档：自动流跑完一轮就落一条。
 *
 * 打开 / 点击 / 回复不存快照，而是按 `batch:<批次id>:` 前缀去发件台账实时统计 ——
 * 回信是跑完之后几天才来的，存快照等于永远停在 0。批次 id 来自 complete-send 的返回值。
 */
interface AutoFlowRunCounts {
  candidates: number;
  researched: number;
  drafts: number;
  sent: number;
}

interface AutoFlowRunArchive {
  id: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  targetCount: number;
  counts: AutoFlowRunCounts;
  batchId: string;
  senderEmail?: string;
  status: "sent" | "draft_only" | "partial";
}

function sumEngagement(list: OutreachEngagement[]): OutreachEngagement {
  const total = { ...EMPTY_ENGAGEMENT };
  for (const item of list) {
    total.sent += item.sent;
    total.opened += item.opened;
    total.clicked += item.clicked;
    total.replied += item.replied;
    total.bounced += item.bounced;
  }
  total.openRate = total.sent ? Math.round((total.opened / total.sent) * 1000) / 10 : 0;
  return total;
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
    const store = getStore();
    // 用库里的账号对象做可见范围判定：req.user 是会话快照，teamId 不一定在
    const actor = store.users.find((item) => item.id === req.user!.id) || req.user!;
    const plans = listProspectOutreachPlans(store, req.user!, limit).map((plan) => ({
      ...prospectPlanSummary(plan),
      engagement: outreachEngagementFor(store, actor, `plan:${plan.id}:`)
    }));
    res.json({ plans, summary: sumEngagement(plans.map((plan) => plan.engagement)) });
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
    const store = getStore();
    const actor = store.users.find((item) => item.id === req.user!.id) || req.user!;
    const batches = listProspectOutreachBatches(store, req.user!, limit).map((batch) => ({
      ...prospectBatchSummary(batch),
      engagement: outreachEngagementFor(store, actor, `batch:${batch.id}:`)
    }));
    res.json({ batches, summary: sumEngagement(batches.map((batch) => batch.engagement)) });
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

  /**
   * 手动生成并发送本批次的总结（每个发件邮箱各一份 Excel）。
   * 默认跳过已成功发过的邮箱；?force=1 重新生成并重发（邮件内容有改动时用）。
   * 注意：必须注册在 `/:id/:action` 之前，否则会被当成 pause/resume/cancel 拦下。
   */
  app.post("/api/prospect-outreach-batches/:id/summary", requireAuth, asyncRoute(async (req, res) => {
    try {
      const batch = getProspectOutreachBatch(getStore(), req.user!, req.params.id);
      const force = req.query.force === "1" || (req.body || {}).force === true;
      const result = await sendOutreachSummaryForBatch(batch, { force });
      res.json(result);
    } catch (error) {
      if (error instanceof Error && /不存在或无权访问/.test(error.message)) {
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

  app.get("/api/prospect-outreach-batches/:id/summary", requireAuth, asyncRoute(async (req, res) => {
    try {
      const batch = getProspectOutreachBatch(getStore(), req.user!, req.params.id);
      const state = await readOutreachSummaryState(batch.teamId, batch.id);
      res.json({ batchId: batch.id, deliveries: state.deliveries, updatedAt: state.updatedAt });
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

  // -------------------------------------------------------------------------
  // 获客自动流：状态云端同步 + 发信完成归档为标准发信批次（打通总结邮件与企微推送）
  // -------------------------------------------------------------------------
  const autoFlowStateKey = (userId: string) => `auto.flow.state:${userId}`;

  app.get("/api/auto-flow/state", requireAuth, asyncRoute(async (req, res) => {
    const stored = await readJsonSetting<{ updatedAt?: number; state?: unknown; schedule?: unknown } | null>(
      autoFlowStateKey(req.user!.id),
      null
    );
    res.json({ data: stored });
  }));

  app.put("/api/auto-flow/state", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      updatedAt: z.number().finite().nonnegative(),
      state: z.record(z.unknown()).optional(),
      schedule: z.record(z.unknown()).optional()
    }).parse(req.body);
    // 严格限制单条设置体积 <= 48KB，避免超出 MySQL app_settings TEXT(64KB) 限制
    const payload = { updatedAt: body.updatedAt, state: body.state, schedule: body.schedule };
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 48_000) {
      res.status(413).json({ message: "自动流同步快照超出体积限制" });
      return;
    }
    await writeJsonSetting(autoFlowStateKey(req.user!.id), payload);
    res.json({ ok: true, updatedAt: body.updatedAt });
  }));

  app.post("/api/auto-flow/complete-send", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      /**
       * 客户端预生成的批次号：第一次归档失败后重试时带同一个号，
       * 服务端按 id 覆盖而不是再插一条，归档里不会出现两条空批次。
       */
      batchId: z.string().trim().max(80).optional(),
      items: z.array(z.object({
        prospectId: z.string().trim().min(1).max(120),
        company: z.string().trim().max(240).default(""),
        to: z.string().trim().email(),
        subject: z.string().trim().min(1).max(300),
        body: z.string().trim().min(1).max(20000),
        sentAt: z.string().trim().max(64).default(""),
        requestId: z.string().trim().max(160).default("")
      })).min(1).max(200),
      /** 这一轮发送失败的封数（只用于企业微信「本轮已发完」的通知文案） */
      failed: z.coerce.number().int().min(0).max(200).default(0)
    }).parse(req.body);

    const store = getStore();
    const now = new Date().toISOString();
    // 客户端带了合法批次号就用它（重试幂等），否则服务端生成
    const requestedBatchId = (body.batchId || "").trim();
    const batchId = /^afb_[0-9a-fA-F-]{8,}$/.test(requestedBatchId)
      ? requestedBatchId
      : `afb_${randomUUID()}`;
    const batchItems = body.items.map((item, idx) => {
      const itemId = `afi_${idx + 1}_${randomUUID().slice(0, 8)}`;
      const sentAt = item.sentAt || now;
      if (item.requestId) {
        const log = store.outboundEmailLogs.find((row) =>
          row.teamId === req.user!.teamId
          && row.ownerId === req.user!.id
          && row.requestId === item.requestId
        );
        if (log) log.requestId = `batch:${batchId}:${itemId}:0`;
      }
      return {
        id: itemId,
        candidateId: item.prospectId,
        entityType: "candidate" as const,
        company: item.company || item.to,
        recipient: item.to,
        status: "sent" as const,
        skipReason: "",
        stageKey: "first_touch_sent" as const,
        stageLabel: "自动流首触",
        stageSource: "derived" as const,
        researchId: "",
        researchScore: 0,
        letterStatus: "ready" as const,
        letterEngine: "auto_flow",
        letterBasis: "",
        letterNote: "",
        steps: [{
          index: 0,
          delayHours: 0,
          scheduledAt: sentAt,
          subject: item.subject,
          body: item.body,
          status: "sent" as const,
          sentAt,
          error: "",
          stageKey: "first_touch_sent" as const,
          stageLabel: "自动流首触"
        }],
        sentAt,
        error: "",
        convertedLeadId: ""
      };
    });

    // 同一个批次号重试：先摘掉上一次那条，再按本次明细重建（幂等，不产生重复批次）
    store.prospectOutreachBatches = store.prospectOutreachBatches.filter((batch) => batch.id !== batchId);
    store.prospectOutreachBatches.unshift({
      id: batchId,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      status: "completed",
      targetType: "candidate",
      policy: {
        dailyLimit: 200,
        stepIntervalHours: 72,
        sendWindowStartHour: 0,
        sendWindowEndHour: 24,
        stopOnReply: true,
        rotateMailboxEvery: 0,
        autoResearch: false
      },
      items: batchItems,
      counts: { total: batchItems.length, frozen: batchItems.length, skipped: 0 },
      frozenPayload: null,
      frozenHash: "",
      approvedBy: req.user!.id,
      approvedAt: now,
      pauseReason: "",
      nextSendAt: "",
      createdAt: now,
      updatedAt: now
    });
    await store.persist();
    // 本轮真的发完了：先推一条企业微信「发完了」，不依赖稍后总结邮件是否寄出。
    // 打开 / 回复不在这里报 —— 它们是跑完之后几天才发生的事，交给自动流页的统一监控去刷新。
    const senders = new Set(
      store.outboundEmailLogs
        .filter((log) => (log.requestId || "").startsWith(`batch:${batchId}:`))
        .map((log) => log.senderEmail || "")
        .filter(Boolean)
    ).size;
    emitCrmEvent({
      type: "outreach.round",
      teamId: req.user!.teamId,
      ownerId: req.user!.id,
      batchId,
      batchLabel: `自动流批次 ${batchId.slice(-8)}`,
      sent: batchItems.length,
      failed: body.failed,
      customers: new Set(batchItems.map((item) => item.company)).size,
      senders,
      occurredAt: now
    });
    res.json({ ok: true, batchId, count: batchItems.length, failed: body.failed });
  }));

  // -------------------------------------------------------------------------
  // 获客任务归档：每跑完一轮存一条，可切换不同任务看打开 / 回复
  // -------------------------------------------------------------------------
  const AUTO_FLOW_RUNS_LIMIT = 30;
  const autoFlowRunsKey = (userId: string) => `auto.flow.runs:${userId}`;

  async function readAutoFlowRuns(userId: string): Promise<AutoFlowRunArchive[]> {
    const stored = await readJsonSetting<{ runs?: AutoFlowRunArchive[] }>(autoFlowRunsKey(userId), { runs: [] });
    return Array.isArray(stored?.runs) ? stored.runs : [];
  }

  app.get("/api/auto-flow/runs", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const actor = store.users.find((item) => item.id === req.user!.id) || req.user!;
    const runs = (await readAutoFlowRuns(req.user!.id)).slice(0, AUTO_FLOW_RUNS_LIMIT).map((run) => ({
      ...run,
      engagement: run.batchId ? outreachEngagementFor(store, actor, `batch:${run.batchId}:`) : EMPTY_ENGAGEMENT
    }));
    res.json({ runs });
  }));

  app.post("/api/auto-flow/runs", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      id: z.string().trim().min(1).max(80),
      command: z.string().trim().max(500).default(""),
      startedAt: z.string().trim().max(64).default(""),
      finishedAt: z.string().trim().max(64).default(""),
      targetCount: z.coerce.number().int().min(0).max(500).default(0),
      counts: z.object({
        candidates: z.coerce.number().int().min(0).max(5000).default(0),
        researched: z.coerce.number().int().min(0).max(5000).default(0),
        drafts: z.coerce.number().int().min(0).max(5000).default(0),
        sent: z.coerce.number().int().min(0).max(5000).default(0)
      }).default({ candidates: 0, researched: 0, drafts: 0, sent: 0 }),
      batchId: z.string().trim().max(120).default(""),
      senderEmail: z.string().trim().max(160).default(""),
      status: z.enum(["sent", "draft_only", "partial"]).default("sent")
    }).parse(req.body);

    const runs = await readAutoFlowRuns(req.user!.id);
    const index = runs.findIndex((item) => item.id === body.id);
    const existing = index >= 0 ? runs[index] : null;
    // 重复归档（同 runId）只补新值：缺省字段沿用已有记录，不能把开跑时间/目标/批次号清成空
    const run: AutoFlowRunArchive = {
      id: body.id,
      command: body.command || existing?.command || "",
      startedAt: body.startedAt || existing?.startedAt || "",
      finishedAt: body.finishedAt || new Date().toISOString(),
      targetCount: body.targetCount || existing?.targetCount || 0,
      counts: body.counts,
      batchId: body.batchId || existing?.batchId || "",
      senderEmail: body.senderEmail || existing?.senderEmail || "",
      status: body.status
    };
    if (index >= 0) runs[index] = run;
    else runs.unshift(run);
    // 只保留最近 30 轮：归档是给「切换任务看效果」用的，不是全量历史仓
    await writeJsonSetting(autoFlowRunsKey(req.user!.id), { runs: runs.slice(0, AUTO_FLOW_RUNS_LIMIT) });
    res.json({ ok: true, run });
  }));

  app.get("/api/auto-flow/runs/:id", requireAuth, asyncRoute(async (req, res) => {
    const runs = await readAutoFlowRuns(req.user!.id);
    const run = runs.find((item) => item.id === req.params.id);
    if (!run) {
      res.status(404).json({ message: "这条任务归档不存在，可能已被更新的一轮挤掉" });
      return;
    }
    const store = getStore();
    const actor = store.users.find((item) => item.id === req.user!.id) || req.user!;
    const prefix = run.batchId ? `batch:${run.batchId}:` : "";
    const canSee = (log: OutboundEmailLog) =>
      log.teamId === req.user!.teamId
      && (log.ownerId === req.user!.id || ["admin", "super_admin", "manager"].includes(req.user!.role));
    const rows = prefix
      ? store.outboundEmailLogs
        .filter((log) => (log.requestId || "").startsWith(prefix) && canSee(log))
        .map((log) => ({
          to: log.to || "",
          subject: log.subject || "",
          sentAt: log.sentAt || "",
          dispatchStatus: log.dispatchStatus || "sent",
          openCount: log.openCount || 0,
          clickCount: log.clickCount || 0,
          firstOpenedAt: log.firstOpenedAt || "",
          lastOpenedAt: log.lastOpenedAt || "",
          repliedAt: log.repliedAt || "",
          bouncedAt: log.bouncedAt || ""
        }))
        .sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))
        .slice(0, 200)
      : [];
    /**
     * 回复 / 退信能不能被抓到，取决于「发这批信的那个邮箱」有没有被 IMAP 监听：
     * 回信与 DSN 退信都是靠 inbound-mail-watcher 轮询收件箱才写回台账的。
     * 没配 IMAP 的邮箱，这一批的回复与退信就永远是 0 —— 界面必须说清楚是"没数据"还是"没接通"，
     * 否则监控面板会让人误以为客户都不回。
     */
    const watchedSenders = new Set(
      store.users
        .filter((user) => user.status === "active"
          && user.inboundSyncEnabled
          && !!user.imapHost && !!user.imapUser && !!user.imapPassword)
        .map((user) => (user.outboundEmail || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const batchLogs = prefix
      ? store.outboundEmailLogs.filter((log) => (log.requestId || "").startsWith(prefix) && canSee(log))
      : [];
    const senders = [...new Set(
      batchLogs.map((log) => (log.senderEmail || "").trim().toLowerCase()).filter(Boolean)
    )];
    const replyCoverage = {
      watchers: watchedSenders.size,
      senders,
      /** 这批用过、但没有收件同步的邮箱：它们的回信 / 退信抓不到 */
      uncovered: senders.filter((email) => !watchedSenders.has(email)),
      /** 台账里没记发件邮箱的老数据：无法判断是否被覆盖 */
      unknownSender: batchLogs.filter((log) => !(log.senderEmail || "").trim()).length
    };
    res.json({
      run: { ...run, engagement: prefix ? outreachEngagementFor(store, actor, prefix) : EMPTY_ENGAGEMENT },
      rows,
      replyCoverage
    });
  }));

  /**
   * 这一轮的通知结果：企业微信「发完了」推没推、发送总结寄到了哪几个发件邮箱。
   * 只读聚合，不主动发任何东西；自动流页的统一监控定时调它（一个线程覆盖所有任务）。
   */
  app.get("/api/auto-flow/runs/:id/notify", requireAuth, asyncRoute(async (req, res) => {
    const runs = await readAutoFlowRuns(req.user!.id);
    const run = runs.find((item) => item.id === req.params.id);
    if (!run) {
      res.status(404).json({ message: "这条任务归档不存在，可能已被更新的一轮挤掉" });
      return;
    }
    const teamId = req.user!.teamId;
    const [wecomSettings, wecomLog, summarySettings] = await Promise.all([
      readWecomSettings(teamId),
      readWecomLog(teamId),
      readOutreachSummarySettings(teamId)
    ]);
    // `round:` 是本轮发完的推送；`summary:` 是总结 Excel 寄出后的推送（老数据只有这一条）
    const keys = run.batchId ? [`round:${run.batchId}`, `summary:${run.batchId}`] : [];
    const entries = keys.length
      ? wecomLog.filter((item) => keys.includes(item.key))
      : [];
    // 推成功优先：同一条链路失败重试成功后，面板应该显示「已推送」，而不是那条历史失败
    const wecomEntry = entries.find((item) => item.status === "sent") || entries[0] || null;
    const summary = run.batchId
      ? await readOutreachSummaryState(teamId, run.batchId)
      : { batchId: "", updatedAt: "", deliveries: [] };
    res.json({
      runId: run.id,
      batchId: run.batchId,
      senderEmail: run.senderEmail || "",
      wecom: {
        configured: Boolean(wecomSettings.updatedAt),
        enabled: wecomSettings.enabled,
        mode: wecomSettings.mode,
        recipients: wecomSettings.mode === "robot" ? ["群机器人"] : wecomSettings.recipients,
        ruleOn: Boolean(wecomSettings.rules.outreachRound),
        entry: wecomEntry
      },
      email: {
        autoSend: summarySettings.autoSend,
        updatedAt: summary.updatedAt || "",
        deliveries: summary.deliveries,
        sent: summary.deliveries.filter((row) => row.status === "sent").length,
        failed: summary.deliveries.filter((row) => row.status === "failed").length
      }
    });
  }));
}
