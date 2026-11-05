/**
 * 商机、商机推荐路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Response } from "express";
import { z } from "zod";
import { canSeeOwner, hasIamScope, requireAuth } from "../auth.js";
import { type Deal, type DealEvent, type SessionUser } from "../types.js";
import { getStore } from "../store.js";
import { generateCustomsDocumentFromDeal } from "../customs-export.js";
import { dismissDealRecommendation, linkRecommendationToDeal, resolveRecommendationCustomerId } from "../procurement-signals.js";
import { recordAcquisitionOutcomeFeedback } from "../prospect-outcome-feedback.js";
import { ensureOrderForWonDeal } from "../order-service.js";
import { asyncRoute, createDealEvent, customerWithPipeline, dealProductSummary, findWritableCustomer } from "../server-core.js";

function ensureDealCustomerWritable(
  user: SessionUser,
  deal: Deal,
  res: Response
) {
  return Boolean(findWritableCustomer(user, deal.customerId, res));
}

const dealStages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"] as const;

const dealItemSchema = z.object({
  id: z.string().trim().max(64).optional().default(""),
  productId: z.string().trim().max(64).optional().default(""),
  product: z.string().trim().min(1).max(500),
  model: z.string().trim().max(200).optional().default(""),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().nonnegative()
});

const dealBodySchema = z.object({
  customerId: z.string().trim().min(1),
  title: z.string().min(1),
  product: z.string().trim().min(1).max(200),
  quantity: z.coerce.number().int().nonnegative().default(0),
  unitPrice: z.coerce.number().nonnegative().default(0),
  items: z.array(dealItemSchema).min(1).max(50).optional(),
  amount: z.coerce.number().nonnegative().optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default("USD"),
  nextAction: z.string().trim().min(1),
  nextActionAt: z.string().trim().min(1),
  expectedCloseAt: z.string().trim().optional().default("")
});

const createDealBodySchema = dealBodySchema.extend({
  recommendationId: z.string().trim().max(90).optional().default("")
});

function normalizedDealItems(body: { product: string; quantity: number; unitPrice: number; items?: Array<{ id?: string; productId?: string; product: string; model?: string; quantity: number; unitPrice: number }> }) {
  const source = body.items?.length
    ? body.items
    : [{ id: "", productId: "", product: body.product, model: "", quantity: body.quantity, unitPrice: body.unitPrice }];
  return source.map((item, index) => ({
    id: item.id || `deal_item_${Date.now()}_${index + 1}`,
    productId: item.productId || "",
    product: item.product.trim(),
    model: item.model?.trim() || "",
    quantity: Number(item.quantity || 0),
    unitPrice: Number(item.unitPrice || 0)
  }));
}

function calculatedDealAmount(body: { amount?: number; quantity: number; unitPrice: number; items?: Array<{ quantity: number; unitPrice: number }> }) {
  if (body.items?.length) return Math.round(body.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) * 100) / 100;
  if (typeof body.amount === "number") return Math.round(body.amount * 100) / 100;
  return Math.round(body.quantity * body.unitPrice * 100) / 100;
}

function dealEventTypeForStage(stage: Deal["stage"]): DealEvent["type"] {
  if (stage === "已报价") return "quote";
  if (stage === "样品") return "sample";
  if (stage === "谈判") return "negotiation";
  if (stage === "成交") return "won";
  return "stage";
}

export function registerDealsRoutes(app: Express) {
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
    const items = normalizedDealItems(body);
    const deal: Deal = {
      id: `d_${Date.now()}`,
      customerId: customer.id,
      title: body.title,
      stage: "询盘",
      product: dealProductSummary(items),
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      unitPrice: items.length === 1 ? items[0].unitPrice : 0,
      items,
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
    const items = normalizedDealItems(body);
    deal.customerId = customer.id;
    deal.title = body.title;
    deal.product = dealProductSummary(items);
    deal.quantity = items.reduce((sum, item) => sum + item.quantity, 0);
    deal.unitPrice = items.length === 1 ? items[0].unitPrice : 0;
    deal.items = items;
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
    const canOverride = hasIamScope(req.user, "deal.stage.override", ["org_subtree", "tenant"]);
    if (distance === 0) {
      res.status(400).json({ message: "请选择不同的目标阶段" });
      return;
    }
    if (Math.abs(distance) > 1 && (!canOverride || !body.transitionReason)) {
      res.status(400).json({ message: "默认只能相邻推进；具备跨阶段权限的人员跳阶段必须填写原因" });
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
      const customer = store.customers.find((item) => item.id === deal.customerId && item.teamId === deal.teamId);
      if (customer) {
        customer.lifecycleStatus = "won";
        customer.wonAt ||= now;
        customer.wonByDealId ||= deal.id;
      }
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
      // 成交是事实，订单是派生事实：建单失败只记录，不回滚成交。
      try {
        ensureOrderForWonDeal({
          store,
          deal,
          customer: store.customers.find((item) => item.id === deal.customerId),
          operatorId: req.user!.id
        });
      } catch (error) {
        console.error("order auto-create failed:", deal.id, error);
      }
    }
    await store.persist();
    const customer = store.customers.find((item) => item.id === deal.customerId && item.teamId === deal.teamId);
    res.json({ deal, customer: customer ? customerWithPipeline(customer, req.user!) : null });
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
    void store.persist().catch((err) => console.error("deal event persist failed:", err));
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

  app.post("/api/deals/:id/restore", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const deal = store.deals.find((item) => item.id === req.params.id);
    if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
      res.status(404).json({ message: "商机不存在" });
      return;
    }
    if (!deal.archivedAt) {
      res.status(400).json({ message: "该商机不在归档状态" });
      return;
    }
    // 「拉回来」刻意只做一件事：取消归档标记。阶段保持不变（仍是成交/丢单），
    // 佣金同步、客户成交状态、报表口径等关联数据一律不动 —— 想重新跟进同款，
    // 用「复制商机」从询盘开一张新的。
    deal.archivedAt = undefined;
    createDealEvent({
      dealId: deal.id,
      type: "restored",
      content: "归档商机已恢复（仅取消归档，阶段与关联数据未变更）",
      operatorId: req.user!.id,
      fromStage: deal.stage,
      toStage: deal.stage,
      nextAction: deal.nextAction,
      nextActionAt: deal.nextActionAt
    });
    await store.persist();
    res.json({ deal });
  }));

  app.post("/api/deals/:id/duplicate", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const deal = store.deals.find((item) => item.id === req.params.id);
    if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
      res.status(404).json({ message: "商机不存在" });
      return;
    }
    if (deal.archivedAt) {
      res.status(400).json({ message: "已归档商机不能复制，请先在关闭商机列表恢复" });
      return;
    }
    if (!ensureDealCustomerWritable(req.user!, deal, res)) return;
    const now = new Date().toISOString();
    const sourceItems = deal.items?.length
      ? deal.items
      : [{ id: "", productId: "", product: deal.product, model: "", quantity: deal.quantity, unitPrice: deal.unitPrice }];
    // 明细全部重发新 id：两个商机的明细行必须是独立记录，不能共享主键。
    const items = sourceItems.map((item, index) => ({
      id: `deal_item_${Date.now()}_${index + 1}`,
      productId: item.productId || "",
      product: item.product,
      model: item.model || "",
      quantity: Number(item.quantity || 0),
      unitPrice: Number(item.unitPrice || 0)
    }));
    const copy: Deal = {
      ...structuredClone(deal),
      id: `d_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: `${deal.title}（副本）`.slice(0, 200),
      stage: "询盘",
      product: dealProductSummary(items),
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      unitPrice: items.length === 1 ? items[0].unitPrice : 0,
      items,
      amountType: "estimate",
      nextAction: deal.nextAction || "跟进商机",
      nextActionAt: deal.nextActionAt || now.slice(0, 10),
      stageChangedAt: now,
      closedAt: undefined,
      wonReason: undefined,
      lostReason: undefined,
      lostReasonCategory: undefined,
      revisitAt: undefined,
      archivedAt: undefined
    };
    store.deals.unshift(copy);
    createDealEvent({
      dealId: copy.id,
      type: "created",
      content: `复制自商机「${deal.title}」，从询盘重新开始；原商机的时间线与单据不随复制`,
      operatorId: req.user!.id,
      toStage: "询盘",
      nextAction: copy.nextAction,
      nextActionAt: copy.nextActionAt,
      createdAt: now
    });
    await store.persist();
    res.json({ deal: copy });
  }));

  app.delete("/api/deals/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const deal = store.deals.find((item) => item.id === req.params.id);
    if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
      res.status(404).json({ message: "商机不存在" });
      return;
    }
    const linkedDocuments = store.tradeDocuments.filter((document) => document.dealId === deal.id);
    if (linkedDocuments.length) {
      res.status(400).json({
        message: `该商机关联了 ${linkedDocuments.length} 份单据（${linkedDocuments.map((document) => `${document.type} ${document.number}`).slice(0, 3).join("、")}${linkedDocuments.length > 3 ? " 等" : ""}），请先处理关联单据再删除商机`
      });
      return;
    }
    const removedEvents = store.dealEvents.filter((event) => event.dealId === deal.id).length;
    const removedTodos = store.todos.filter((todo) => todo.dealId === deal.id).length;
    const removedQuotes = store.quoteHistory.filter((record) => record.dealId === deal.id).length;
    store.deals = store.deals.filter((item) => item.id !== deal.id);
    store.dealEvents = store.dealEvents.filter((event) => event.dealId !== deal.id);
    store.quoteHistory = store.quoteHistory.filter((record) => record.dealId !== deal.id);
    store.todos = store.todos.filter((todo) => todo.dealId !== deal.id);
    await store.persist();
    res.json({
      ok: true,
      removed: { events: removedEvents, todos: removedTodos, quoteHistory: removedQuotes }
    });
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

  app.get("/api/deals/:id/win-probability", requireAuth, (req, res) => {
    const store = getStore();
    const deal = store.deals.find((item) => item.id === req.params.id);
    if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
      res.status(404).json({ message: "商机不存在" });
      return;
    }

    const events = store.dealEvents
      .filter((event) => event.dealId === deal.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    // Factor 1: Stage progression
    const stageScores: Record<string, number> = { "询盘": 5, "已联系": 15, "已报价": 30, "样品": 50, "谈判": 75, "成交": 100, "丢单": 0 };
    const stageScore = stageScores[deal.stage] ?? 10;

    // Factor 2: Customer historical win rate
    const customerDeals = store.deals.filter((d) => d.customerId === deal.customerId && d.id !== deal.id);
    const wonCount = customerDeals.filter((d) => d.stage === "成交").length;
    const lostCount = customerDeals.filter((d) => d.stage === "丢单").length;
    const totalClosed = wonCount + lostCount;
    const customerWinRate = totalClosed > 0 ? Math.round((wonCount / totalClosed) * 100) : 50;
    const customerScore = totalClosed === 0 ? 50 : customerWinRate;

    // Factor 3: Follow-up frequency (last 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentEvents = events.filter((event) => new Date(event.createdAt).getTime() > sevenDaysAgo);
    const followUpScore = Math.min(100, recentEvents.length * 20);

    // Factor 4: Amount reasonableness (compare with avg won deal amount)
    const wonDeals = store.deals.filter((d) => d.stage === "成交" && d.currency === deal.currency);
    const avgWonAmount = wonDeals.length > 0 ? wonDeals.reduce((sum, d) => sum + d.amount, 0) / wonDeals.length : 0;
    let amountScore: number;
    if (avgWonAmount === 0) {
      amountScore = 50;
    } else {
      const ratio = deal.amount / avgWonAmount;
      if (ratio >= 0.5 && ratio <= 2.0) amountScore = 80;
      else if (ratio >= 0.3 && ratio <= 3.0) amountScore = 60;
      else amountScore = 30;
    }

    // Factor 5: Stage momentum (days in current stage — shorter = better)
    const stageChangedDate = new Date(deal.stageChangedAt).getTime();
    const daysInStage = Math.floor((Date.now() - stageChangedDate) / (24 * 60 * 60 * 1000));
    const momentumScore = Math.max(10, Math.min(100, 100 - daysInStage * 5));

    // Weighted overall probability
    const weights = { stage: 0.35, customer: 0.20, followUp: 0.20, amount: 0.10, momentum: 0.15 };
    const winProbability = Math.round(
      stageScore * weights.stage +
      customerScore * weights.customer +
      followUpScore * weights.followUp +
      amountScore * weights.amount +
      momentumScore * weights.momentum
    );

    // Generate advice text
    const adviceParts: string[] = [];
    if (stageScore >= 75) adviceParts.push("商机已进入谈判阶段，建议尽快确认合同条款并安排签约。");
    else if (stageScore >= 50) adviceParts.push("已进入样品阶段，建议在48小时内跟进客户反馈并准备报价确认。");
    else if (stageScore >= 30) adviceParts.push("已完成报价，建议主动跟进客户反馈，避免报价超期。");
    else adviceParts.push("商机处于早期阶段，建议尽快建立联系并了解客户需求。");

    if (followUpScore < 40) adviceParts.push("近期跟进频率偏低，建议本周至少完成2次有效跟进。");
    if (customerScore >= 70) adviceParts.push("该客户历史成交率高，建议加大投入力度。");
    else if (customerScore < 30 && totalClosed > 0) adviceParts.push("该客户历史成交率偏低，建议谨慎评估投入。");
    if (daysInStage > 14) adviceParts.push(`当前阶段已停留${daysInStage}天，建议推动进入下一阶段。`);

    const factors = [
      { name: "阶段进展", score: stageScore, description: `${deal.stage}阶段 · 基准${stageScore}%` },
      { name: "客户成交率", score: customerScore, description: totalClosed > 0 ? `${wonCount}胜${lostCount}负 · ${customerWinRate}%` : "无历史数据 · 50%" },
      { name: "跟进频率", score: followUpScore, description: `近7天${recentEvents.length}次跟进` },
      { name: "金额合理度", score: amountScore, description: avgWonAmount > 0 ? `${deal.currency} ${deal.amount.toLocaleString()} vs 均价 ${Math.round(avgWonAmount).toLocaleString()}` : "无参考数据" },
      { name: "阶段动能", score: momentumScore, description: `当前阶段停留${daysInStage}天` }
    ];

    res.json({
      winProbability: Math.min(99, Math.max(1, winProbability)),
      factors,
      advice: adviceParts.join(""),
      isClosed: deal.stage === "成交" || deal.stage === "丢单"
    });
  });

  app.get("/api/deals/closed", requireAuth, (req, res) => {
    const store = getStore();
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(50, Math.max(5, Number(req.query.pageSize || 20)));
    const keyword = String(req.query.keyword || "").trim().toLowerCase();
    const status = String(req.query.status || "all");
    const stage = String(req.query.stage || "");
    const month = String(req.query.month || "");
    const filtered = store.deals
      .filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId) && (deal.stage === "成交" || deal.stage === "丢单"))
      .filter((deal) => status === "all" || deal.stage === status || (status === "archived" && Boolean(deal.archivedAt)))
      .filter((deal) => !stage || stage === "all" || deal.stage === stage)
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
        revisit: filtered.filter((deal) => deal.stage === "丢单" && deal.revisitAt).length,
        archived: filtered.filter((deal) => deal.archivedAt).length
      }
    });
  });

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
}
