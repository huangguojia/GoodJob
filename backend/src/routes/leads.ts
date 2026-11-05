/**
 * 线索、官网询盘接入路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Request } from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canSeeOwner, hasIamPermission, publicUser, requireAuth } from "../auth.js";
import { type Customer, type Deal, type Lead, type SessionUser } from "../types.js";
import { getStore } from "../store.js";
import { readWebsiteLeadIngressSettings } from "../website-lead-ingress-settings.js";
import { PROSPECT_LEAD_SOURCE_CHANNEL } from "../prospect-lead-conversion.js";
import { isPublicCustomer } from "../customer-public-pool.js";
import { assertCrmOutreachEligible } from "../prospect-outreach-eligibility.js";
import { recordCrmEmailTouchpoint } from "../email-touchpoints.js";
import {
  accountUser,
  asyncRoute,
  createDealEvent,
  createLeadFromSource,
  customerWithPipeline,
  dispatchOutboundEmail,
  findDuplicateLead,
  findWritableCustomer,
  leadWritableSchema,
  procurementContextForCandidate,
  requestCorrelationId,
  sendOutboundEmailFailure,
  sendProspectQualificationError,
  websiteLeadLimiter
} from "../server-core.js";

const WEBSITE_LEAD_SIGNATURE_WINDOW_SECONDS = 5 * 60;

const WEBSITE_LEAD_REPLAY_CACHE_LIMIT = 5_000;

const websiteLeadReplayCache = new Map<string, number>();

type WebsiteLeadSignatureStatus = "ok" | "invalid" | "expired" | "replay" | "unconfigured";

function websiteLeadSigningKeys() {
  const settings = readWebsiteLeadIngressSettings();
  if (!settings.enabled) return [];
  return [settings.current, settings.previous].filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function pruneWebsiteLeadReplayCache(nowSeconds: number) {
  for (const [key, expiresAt] of websiteLeadReplayCache) {
    if (expiresAt <= nowSeconds) websiteLeadReplayCache.delete(key);
  }
  while (websiteLeadReplayCache.size >= WEBSITE_LEAD_REPLAY_CACHE_LIMIT) {
    const oldest = websiteLeadReplayCache.keys().next().value as string | undefined;
    if (!oldest) break;
    websiteLeadReplayCache.delete(oldest);
  }
}

function websiteLeadSignatureStatus(req: Request): WebsiteLeadSignatureStatus {
  const keys = websiteLeadSigningKeys();
  if (!keys.length) return "unconfigured";
  const keyId = String(req.headers["x-goodjob-key-id"] || "").trim();
  const timestampText = String(req.headers["x-goodjob-timestamp"] || "").trim();
  const nonce = String(req.headers["x-goodjob-nonce"] || "").trim();
  const signatureHeader = String(req.headers["x-goodjob-signature"] || "").trim();
  if (!/^[A-Za-z0-9_-]{2,80}$/u.test(keyId)
    || !/^\d{10}$/u.test(timestampText)
    || !/^[A-Za-z0-9_-]{20,64}$/u.test(nonce)
    || !/^v1=[a-f0-9]{64}$/u.test(signatureHeader)) return "invalid";
  const key = keys.find((item) => item.id === keyId);
  if (!key) return "invalid";
  const timestamp = Number(timestampText);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > WEBSITE_LEAD_SIGNATURE_WINDOW_SECONDS) return "expired";
  const rawBody = (req as Request & { websiteLeadRawBody?: Buffer }).websiteLeadRawBody;
  if (!rawBody) return "invalid";
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const pathName = String(req.originalUrl || req.url).split("?")[0];
  const canonical = ["v1", keyId, req.method.toUpperCase(), pathName, timestampText, nonce, bodyHash].join("\n");
  const expected = createHmac("sha256", key.secret).update(canonical).digest();
  const supplied = Buffer.from(signatureHeader.slice("v1=".length), "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return "invalid";
  pruneWebsiteLeadReplayCache(nowSeconds);
  const replayKey = `${keyId}:${nonce}`;
  if ((websiteLeadReplayCache.get(replayKey) || 0) > nowSeconds) return "replay";
  websiteLeadReplayCache.set(replayKey, nowSeconds + WEBSITE_LEAD_SIGNATURE_WINDOW_SECONDS);
  return "ok";
}

function websiteLeadOwner() {
  const ownerId = readWebsiteLeadIngressSettings().ownerId;
  if (!ownerId) return null;
  const user = getStore().users.find((item) => item.id === ownerId && item.status === "active");
  if (!user) return null;
  const publicOwner = publicUser(user);
  return hasIamPermission(publicOwner, "lead.create") ? publicOwner : null;
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

export function registerLeadsRoutes(app: Express) {
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

  /**
   * Server-to-server website intake. This endpoint deliberately exposes only
   * lead creation and returns a minimal receipt. It does not accept cookies,
   * user passwords, owner IDs, or arbitrary CRM operations.
   */
  app.post("/api/website-leads", websiteLeadLimiter, asyncRoute(async (req, res) => {
    const signatureStatus = websiteLeadSignatureStatus(req);
    if (signatureStatus === "unconfigured") {
      res.status(503).json({ message: "网站询盘接收尚未配置签名密钥" });
      return;
    }
    if (signatureStatus === "replay") {
      res.status(409).json({ message: "重复的网站询盘请求" });
      return;
    }
    if (signatureStatus !== "ok") {
      res.status(401).json({ message: "网站询盘签名无效或已过期" });
      return;
    }
    const owner = websiteLeadOwner();
    if (!owner) {
      res.status(503).json({ message: "网站询盘接收尚未配置负责人" });
      return;
    }
    const body = leadWritableSchema.parse(req.body);
    const result = createLeadFromSource(owner, {
      ...body,
      sourceType: "inbound",
      sourceChannel: "website",
      source: body.source || "官网询盘"
    });
    await getStore().persist();
    res.status(result.duplicate ? 200 : 201).json({
      received: true,
      duplicate: result.duplicate,
      leadId: result.lead.id
    });
  }));

  app.post("/api/leads", requireAuth, asyncRoute(async (req, res) => {
    const body = leadWritableSchema.parse(req.body);
    const store = getStore();
    const duplicate = findDuplicateLead(store, req.user!.teamId, body.company, body.country);
    if (duplicate) {
      res.status(409).json({
        message: `线索已存在：「${duplicate.company}」（${duplicate.country || "国家未知"}）已在线索列表中，不能重复添加`,
        errorCode: "LEAD_DUPLICATE",
        existingId: duplicate.id
      });
      return;
    }
    const { lead, sourceEvent, duplicate: sourceDuplicate } = createLeadFromSource(req.user!, body);
    await store.persist();
    res.json({ lead, sourceEvent, duplicate: sourceDuplicate });
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
      content: `移入垃圾箱：${lead.deletedReason}${lead.convertedCustomerId ? "（已生成的客户和商机继续保留）" : ""}`,
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
    void store.persist().catch((err) => console.error("lead activity persist failed:", err));
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
    void store.persist().catch((err) => console.error("lead social-touch persist failed:", err));
    res.json({ activity, lead });
  }));

  app.post("/api/leads/:id/send-email", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      to: z.string().email(),
      subject: z.string().min(1).max(160),
      body: z.string().min(10).max(3000),
      nextFollowAt: z.string().optional().default(""),
      requestId: z.string().trim().min(1).max(120).optional()
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
    const requestId = body.requestId || requestCorrelationId(req);
    let dispatch: Awaited<ReturnType<typeof dispatchOutboundEmail>>;
    try {
      dispatch = await dispatchOutboundEmail(store, user, {
        requestId,
        entityType: "lead",
        entityId: lead.id,
        to: outreachEligibility.recipient,
        subject: body.subject,
        body: body.body,
        source: "lead_send"
      });
    } catch (error) {
      sendOutboundEmailFailure(res, error, user);
      return;
    }
    const sentAt = dispatch.log.sentAt;
    user.lastDevelopmentEmailAt = sentAt;
    user.lastDevelopmentEmailTo = outreachEligibility.recipient;
    user.lastDevelopmentEmailSubject = body.subject;
    const touchpointRequestId = `send:${requestId}`;
    const replayedTouchpoint = store.prospectTouchpoints.some((item) =>
      item.ownerId === user.id && item.requestId === touchpointRequestId
    );
    recordCrmEmailTouchpoint(store, dispatch.log, {
      eventType: "send",
      direction: "outbound",
      occurredAt: sentAt,
      subject: body.subject,
      content: body.body,
      requestId: touchpointRequestId
    });
    const activity = {
      id: `la_${Date.now()}`,
      leadId: lead.id,
      type: "email" as const,
      content: `邮件发送：${body.subject}`,
      operatorId: req.user!.id,
      nextFollowAt: body.nextFollowAt,
      createdAt: sentAt
    };
    if (!replayedTouchpoint) store.leadActivities.unshift(activity);
    lead.lastActivityAt = "刚刚";
    if (body.nextFollowAt) lead.nextFollowAt = body.nextFollowAt;
    if (lead.status === "new") lead.status = "following";
    await store.persist();
    res.json({
      sent: {
        id: `mail_${Date.now()}`,
        status: "sent",
        simulated: process.env.NODE_ENV === "test",
        messageId: dispatch.log.messageId,
        replayed: dispatch.replayed,
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
        source: lead.source || lead.sourceChannel || "线索转化",
        grade: "C",
        nextReminder: lead.nextFollowAt || "明天 10:00",
        wecomBound: false,
        billingName: lead.company,
        companyFullName: lead.company,
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
}
