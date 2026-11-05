/**
 * 订单履约路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { z } from "zod";
import { canSeeOwner, hasIamPermission, requireAuth } from "../auth.js";
import { getFileRepository, isPreviewable } from "../file-storage.js";
import { isHeicFile, isOfficeFile } from "../file-derive.js";
import { type Order, type OrderFile, type OrderItem, type OrderStatus, type TradeDocument } from "../types.js";
import { getStore } from "../store.js";
import { checkOrderTransition, clearForwardTimestamps, deriveOrder, ensureOrderForWonDeal, nextOrderNo, nextSplitSeq, ORDER_STATUS_LABELS, orderShipments, recalcShippedQty, sumOrderItems, syncOrderFulfillment } from "../order-service.js";
import { asyncRoute, fileIsAdmin, loadAccessibleFile, orderVisible } from "../server-core.js";

/* ==========================================================================
 * 订单（履约主档）
 * --------------------------------------------------------------------------
 * 定位：成交之后客户侧的履约视图，归集条款 / 状态 / 时间轴 / 文件，
 * 接收发货与单证的回写。不做税、汇率、库存、成本，也不写客户跟进记录。
 * ========================================================================== */
const orderItemInputSchema = z.object({
  id: z.string().trim().max(64).optional(),
  lineNo: z.coerce.number().int().positive().optional(),
  product: z.string().trim().min(1).max(200),
  spec: z.string().trim().max(200).default(""),
  qty: z.coerce.number().min(0).max(1000000),
  unit: z.string().trim().max(20).default(""),
  unitPrice: z.coerce.number().min(0).max(100000000),
  remark: z.string().trim().max(500).default("")
});

function orderDocumentsOf(store: ReturnType<typeof getStore>, order: Order): TradeDocument[] {
  return store.tradeDocuments.filter((doc) =>
    doc.orderId
      ? doc.orderId === order.id
      : Boolean(order.dealId) && doc.dealId === order.dealId
  );
}

function orderView(store: ReturnType<typeof getStore>, order: Order, now = new Date()) {
  const items = store.orderItems.filter((item) => item.orderId === order.id);
  const documents = orderDocumentsOf(store, order);
  // 前端要能从订单跳回来源商机：只带 dealId 的话界面上只有一个裸 id。
  const deal = order.dealId ? store.deals.find((item) => item.id === order.dealId) : undefined;
  return {
    ...order,
    dealTitle: deal?.title || "",
    ownerName: store.users.find((user) => user.id === order.ownerId)?.name || "",
    items,
    derived: deriveOrder(order, items, documents, now)
  };
}

function normalizeOrderItems(
  orderId: string,
  input: Array<z.infer<typeof orderItemInputSchema>>
): OrderItem[] {
  return input.map((item, index) => ({
    id: item.id || `ordi_${orderId}_${index + 1}_${Math.random().toString(36).slice(2, 6)}`,
    orderId,
    lineNo: item.lineNo || (index + 1) * 10,
    product: item.product,
    spec: item.spec,
    qty: item.qty,
    unit: item.unit,
    unitPrice: item.unitPrice,
    amount: Math.round(item.qty * item.unitPrice * 100) / 100,
    shippedQty: 0,
    remark: item.remark
  }));
}

export function registerOrdersRoutes(app: Express) {
  app.get("/api/orders/summary", requireAuth, (req, res) => {
    const store = getStore();
    const visible = store.orders.filter((order) => orderVisible(req.user!, order));
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const activeStatuses: OrderStatus[] = ["pending", "confirmed", "in_production", "ready_to_ship"];
    const active = visible.filter((order) => activeStatuses.includes(order.status));

    const amountByCurrency = <T extends { amount: number; currency: string }>(rows: T[]) => {
      const result: Record<string, number> = {};
      rows.forEach((row) => {
        const key = row.currency || "USD";
        result[key] = Math.round(((result[key] || 0) + (Number(row.amount) || 0)) * 100) / 100;
      });
      return result;
    };

    const overdue = visible.filter((order) => {
      const view = orderView(store, order, now);
      return view.derived.isOverdue;
    });

    res.json({
      activeOrders: active.length,
      activeAmountByCurrency: amountByCurrency(active),
      overdueOrders: overdue.length,
      pendingConfirm: visible.filter((order) => order.status === "pending").length,
      awaitingShipment: visible.filter((order) => order.status === "ready_to_ship").length,
      awaitingDelivery: visible.filter((order) => order.status === "shipped").length,
      completedThisMonth: visible.filter((order) => (order.completedAt || "").slice(0, 7) === monthKey).length,
      wonThisMonth: store.deals.filter((deal) =>
        deal.stage === "成交"
        && canSeeOwner(req.user!, deal.ownerId, deal.teamId)
        && String(deal.closedAt || "").slice(0, 7) === monthKey
      ).length,
      wonThisMonthByCurrency: amountByCurrency(
        store.deals.filter((deal) =>
          deal.stage === "成交"
          && canSeeOwner(req.user!, deal.ownerId, deal.teamId)
          && String(deal.closedAt || "").slice(0, 7) === monthKey
        )
      )
    });
  });

  app.get("/api/orders", requireAuth, (req, res) => {
    const store = getStore();
    const now = new Date();
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize || 20)));
    const status = String(req.query.status || "all");
    const keyword = String(req.query.q || "").trim().toLowerCase();
    const customerId = String(req.query.customerId || "");
    const dealId = String(req.query.dealId || "");
    const overdueOnly = String(req.query.overdue || "") === "1";

    const groupOf = (value: OrderStatus): string => {
      if (["pending", "confirmed", "in_production", "ready_to_ship"].includes(value)) return "active";
      return value;
    };

    const visible = store.orders.filter((order) => orderVisible(req.user!, order));
    const withView = visible.map((order) => orderView(store, order, now));

    const counts = {
      all: withView.length,
      pending: withView.filter((row) => row.status === "pending").length,
      active: withView.filter((row) => groupOf(row.status) === "active").length,
      shipped: withView.filter((row) => row.status === "shipped").length,
      delivered: withView.filter((row) => row.status === "delivered").length,
      completed: withView.filter((row) => row.status === "completed").length,
      cancelled: withView.filter((row) => row.status === "cancelled").length,
      overdue: withView.filter((row) => row.derived.isOverdue).length
    };

    const filtered = withView
      .filter((row) => {
        if (status === "all") return true;
        if (status === "overdue") return row.derived.isOverdue;
        if (status === "active") return groupOf(row.status) === "active";
        return row.status === status;
      })
      .filter((row) => !customerId || row.customerId === customerId)
      .filter((row) => !dealId || row.dealId === dealId)
      .filter((row) => !overdueOnly || row.derived.isOverdue)
      .filter((row) => {
        if (!keyword) return true;
        const text = `${row.companyOrderNo} ${row.orderNo} ${row.customerName} ${row.buyerPoNo} ${row.erpOrderNo} ${row.incoterm}`.toLowerCase();
        return text.includes(keyword);
      })
      .sort((left, right) => {
        if (left.derived.isOverdue !== right.derived.isOverdue) return left.derived.isOverdue ? -1 : 1;
        if (left.expectedShipAt && right.expectedShipAt && left.expectedShipAt !== right.expectedShipAt) {
          return left.expectedShipAt < right.expectedShipAt ? -1 : 1;
        }
        if (!left.expectedShipAt && right.expectedShipAt) return 1;
        if (left.expectedShipAt && !right.expectedShipAt) return -1;
        return String(right.createdAt).localeCompare(String(left.createdAt));
      });

    const start = (page - 1) * pageSize;

    // 成交未建单：deal.orderId 为空且 orders 里也没有对应单（补偿锚点）
    const missingOrders = store.deals
      .filter((deal) => deal.stage === "成交" && canSeeOwner(req.user!, deal.ownerId, deal.teamId))
      .filter((deal) => !store.orders.some((order) => order.dealId === deal.id))
      .sort((left, right) => String(right.closedAt || "").localeCompare(String(left.closedAt || "")))
      .slice(0, 20)
      .map((deal) => ({
        dealId: deal.id,
        title: deal.title,
        customerName: store.customers.find((customer) => customer.id === deal.customerId)?.company || deal.title,
        amount: deal.amount,
        currency: deal.currency,
        closedAt: deal.closedAt || ""
      }));

    res.json({
      orders: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize,
      counts,
      missingOrders,
      missingOrderTotal: store.deals.filter((deal) =>
        deal.stage === "成交"
        && canSeeOwner(req.user!, deal.ownerId, deal.teamId)
        && !store.orders.some((order) => order.dealId === deal.id)
      ).length
    });
  });

  app.get("/api/orders/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const order = store.orders.find((item) => item.id === req.params.id);
    if (!order || !orderVisible(req.user!, order)) {
      res.status(404).json({ message: "订单不存在或无权查看" });
      return;
    }
    const items = store.orderItems.filter((item) => item.orderId === order.id);
    const documents = orderDocumentsOf(store, order);
    const legacyFiles = store.orderFiles
      // 已收编到文件中心的旧行不再参与双读：否则同一份单证会在订单里出现两次
      .filter((file) => file.orderId === order.id && !file.supersededByFileId)
      .map((file) => {
        const asset = store.knowledgeAssets.find((item) => item.id === file.assetId);
        const visible = Boolean(asset) && canSeeOwner(req.user!, asset!.ownerId, asset!.teamId || "");
        return {
          ...file,
          assetName: visible ? asset!.title : "",
          assetMissing: !asset,
          assetRestricted: Boolean(asset) && !visible,
          sourceUrl: visible ? asset!.sourceUrl || "" : "",
          fileType: visible ? asset!.fileType || "" : "",
          // 百度网盘靠提取码才能打开：订单里只给链接等于给了一把没钥匙的锁。
          shareCode: visible ? asset!.shareCode || "" : "",
          // 订单里要区分「本地资料 / 百度网盘 / 外部链接」：三者打开方式不同，
          // 只有网盘需要提取码，界面不能一律说「打开」。
          sourceType: visible ? asset!.sourceType || "" : "",
          assetCategory: visible ? asset!.category || "" : "",
          assetStatus: visible ? asset!.status || "" : "",
          createdByName: store.users.find((user) => user.id === file.createdBy)?.name || ""
        };
      });

    // 双读：旧的 order_files（外链资料）+ 新的 file_references（真文件）。
    // 两套数据并存是过渡期的既定方案：旧表唯一键 (order_id, asset_id) 加不了 file_id，
    // 破坏性迁移风险更大，收编留到 M6。
    const fileRepository = getFileRepository();
    const uploaded = fileRepository
      ? (await fileRepository.referencesForEntity("order", order.id)).map(({ reference, file }) => ({
        id: reference.id,
        orderId: order.id,
        // 旧结构要求 assetId 是字符串；新文件没有资产 id，留空并由 fileId 区分
        assetId: "",
        fileId: file.id,
        kind: (["contract", "pi", "ci", "pl", "inspection", "other"].includes(reference.kind) ? reference.kind : "other") as OrderFile["kind"],
        note: "",
        createdBy: reference.createdBy,
        createdAt: reference.createdAt,
        assetName: file.originalName,
        assetMissing: false,
        assetRestricted: false,
        sourceUrl: "",
        fileType: "",
        shareCode: "",
        sourceType: "upload",
        assetCategory: "",
        assetStatus: "",
        size: file.size,
        mime: file.mime,
        // Office / HEIC 浏览器不能直接打开，但走派生件可以预览，所以也算「可预览」
        previewable: isPreviewable(file.mime) || isOfficeFile(file.mime, file.originalName) || isHeicFile(file.mime, file.originalName),
        deriveStatus: file.deriveStatus,
        deriveError: file.deriveError,
        createdByName: store.users.find((user) => user.id === reference.createdBy)?.name || ""
      }))
      : [];
    const files = [...legacyFiles, ...uploaded];

    res.json({
      order: orderView(store, order),
      items,
      events: store.orderEvents
        .filter((event) => event.orderId === order.id)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
      files,
      shipments: orderShipments(store, order.id),
      documents,
      derived: deriveOrder(order, items, documents),
      missingOrders: [],
      permissions: {
        manage: hasIamPermission(req.user, "order.manage"),
        override: hasIamPermission(req.user, "order.status.override")
      }
    });
  }));

  app.post("/api/orders", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      customerId: z.string().trim().min(1).max(64),
      dealId: z.string().trim().max(64).optional().default(""),
      /** 公司自己的订单号。CRM 的 orderNo 是系统流水号，不等同于它，所以可空、手工填。 */
      companyOrderNo: z.string().trim().max(80).optional().default(""),
      currency: z.string().trim().max(12).optional().default("USD"),
      incoterm: z.string().trim().max(80).optional().default(""),
      paymentTerm: z.string().trim().max(255).optional().default(""),
      portLoading: z.string().trim().max(120).optional().default(""),
      portDischarge: z.string().trim().max(120).optional().default(""),
      buyerPoNo: z.string().trim().max(80).optional().default(""),
      productionRequired: z.boolean().optional().default(false),
      expectedShipAt: z.string().trim().max(20).optional().default(""),
      remark: z.string().trim().max(2000).optional().default(""),
      items: z.array(orderItemInputSchema).min(1).max(100)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "订单参数不合法", issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const store = getStore();
    const customer = store.customers.find((item) => item.id === body.customerId && canSeeOwner(req.user!, item.ownerId, item.teamId));
    if (!customer) {
      res.status(404).json({ message: "客户不存在或无权访问" });
      return;
    }
    const deal = body.dealId
      ? store.deals.find((item) => item.id === body.dealId && canSeeOwner(req.user!, item.ownerId, item.teamId))
      : undefined;
    const now = new Date();
    const nowIso = now.toISOString();
    const orderId = `ord_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
    const items = normalizeOrderItems(orderId, body.items);
    const order: Order = {
      id: orderId,
      orderNo: nextOrderNo(store, now),
      companyOrderNo: body.companyOrderNo,
      dealId: body.dealId,
      splitSeq: body.dealId ? nextSplitSeq(store, body.dealId) : 1,
      customerId: customer.id,
      customerName: customer.company,
      status: "pending",
      currency: body.currency || "USD",
      amount: sumOrderItems(items),
      incoterm: body.incoterm,
      paymentTerm: body.paymentTerm,
      portLoading: body.portLoading,
      portDischarge: body.portDischarge,
      buyerPoNo: body.buyerPoNo,
      productionRequired: body.productionRequired,
      expectedShipAt: body.expectedShipAt,
      confirmedAt: "",
      shippedAt: "",
      deliveredAt: "",
      completedAt: "",
      cancelledAt: "",
      cancelReason: "",
      erpOrderNo: "",
      erpSyncStatus: "none",
      source: "manual",
      ownerId: deal?.ownerId || customer.ownerId || req.user!.id,
      teamId: customer.teamId || req.user!.teamId,
      remark: body.remark,
      createdBy: req.user!.id,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    if (store.orders.some((item) => item.orderNo === order.orderNo)) {
      res.status(409).json({ message: "单号冲突，请重试" });
      return;
    }
    store.orders.push(order);
    store.orderItems.push(...items);
    store.orderEvents.push({
      id: `orde_${orderId}_created`,
      orderId,
      type: "created",
      content: deal ? `手工建单，关联商机《${deal.title}》` : "手工建单",
      operatorId: req.user!.id,
      refType: deal ? "deal" : undefined,
      refId: deal?.id,
      createdAt: nowIso
    });
    if (deal) deal.orderId = order.id;
    await store.persist();
    res.status(201).json({ order: orderView(store, order) });
  }));

  app.patch("/api/orders/:id", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      incoterm: z.string().trim().max(80).optional(),
      paymentTerm: z.string().trim().max(255).optional(),
      portLoading: z.string().trim().max(120).optional(),
      portDischarge: z.string().trim().max(120).optional(),
      buyerPoNo: z.string().trim().max(80).optional(),
      /** 公司单号补录：任何状态都允许改（发货后财务/生产才给号是常态）。 */
      companyOrderNo: z.string().trim().max(80).optional(),
      /** ERP 单号：ERP 还没接上时先手工填，接上后由同步回写。 */
      erpOrderNo: z.string().trim().max(80).optional(),
      productionRequired: z.boolean().optional(),
      expectedShipAt: z.string().trim().max(20).optional(),
      currency: z.string().trim().max(12).optional(),
      remark: z.string().trim().max(2000).optional(),
      items: z.array(orderItemInputSchema).min(1).max(100).optional(),
      expectedUpdatedAt: z.string().trim().max(40).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "订单参数不合法", issues: parsed.error.issues });
      return;
    }
    const store = getStore();
    const order = store.orders.find((item) => item.id === req.params.id);
    if (!order || !orderVisible(req.user!, order)) {
      res.status(404).json({ message: "订单不存在或无权查看" });
      return;
    }
    const body = parsed.data;
    if (body.expectedUpdatedAt && body.expectedUpdatedAt !== order.updatedAt) {
      res.status(409).json({ message: "订单已被他人修改，请刷新后重试" });
      return;
    }
    const lockedStatuses: OrderStatus[] = ["shipped", "delivered", "completed", "cancelled"];
    /**
     * 发货后锁定的是「会改变单证与结算的实质内容」：金额、数量、Incoterm、付款条件、港口、币种。
     * 单号类字段（公司单号 / 客户 PO / ERP 单号）只是标识与引用，不改交易内容，
     * 而且经常是发货后财务或生产才给过来 —— 跟着条款锁死，用户就永远补不上。
     */
    const editableFields = ["incoterm", "paymentTerm", "portLoading", "portDischarge", "productionRequired", "expectedShipAt", "currency", "items"];
    if (lockedStatuses.includes(order.status) && editableFields.some((field) => field in body)) {
      res.status(409).json({ message: "已发货及之后的订单只能修改单号与备注" });
      return;
    }
    const now = new Date().toISOString();
    const prevCompanyOrderNo = order.companyOrderNo || "";
    const prevBuyerPoNo = order.buyerPoNo || "";
    const prevErpOrderNo = order.erpOrderNo || "";
    if (body.incoterm !== undefined) order.incoterm = body.incoterm;
    if (body.paymentTerm !== undefined) order.paymentTerm = body.paymentTerm;
    if (body.portLoading !== undefined) order.portLoading = body.portLoading;
    if (body.portDischarge !== undefined) order.portDischarge = body.portDischarge;
    if (body.buyerPoNo !== undefined) order.buyerPoNo = body.buyerPoNo;
    // 公司单号 / ERP 单号同样不参与「已发货后锁定」：它们是标识，不是交易条款。
    if (body.companyOrderNo !== undefined) order.companyOrderNo = body.companyOrderNo;
    if (body.erpOrderNo !== undefined) order.erpOrderNo = body.erpOrderNo;
    if (body.productionRequired !== undefined) order.productionRequired = body.productionRequired;
    if (body.expectedShipAt !== undefined) order.expectedShipAt = body.expectedShipAt;
    if (body.currency !== undefined && order.status === "pending") order.currency = body.currency;
    if (body.remark !== undefined) order.remark = body.remark;

    if (body.items) {
      const existing = store.orderItems.filter((item) => item.orderId === order.id);
      if (existing.some((item) => item.shippedQty > 0)) {
        res.status(409).json({ message: "已有发货记录，不能修改明细数量" });
        return;
      }
      for (let index = store.orderItems.length - 1; index >= 0; index -= 1) {
        if (store.orderItems[index].orderId === order.id) store.orderItems.splice(index, 1);
      }
      const nextItems = normalizeOrderItems(order.id, body.items);
      store.orderItems.push(...nextItems);
      order.amount = sumOrderItems(nextItems);
    }
    order.updatedAt = now;
    // 三类号各写一句，时间轴上才算得清「谁在什么时候把哪个号改了」。
    const numberChanges: string[] = [];
    if (body.companyOrderNo !== undefined && body.companyOrderNo !== prevCompanyOrderNo) {
      numberChanges.push(`公司单号 ${prevCompanyOrderNo || "（未填）"} → ${order.companyOrderNo || "（清空）"}`);
    }
    if (body.buyerPoNo !== undefined && body.buyerPoNo !== prevBuyerPoNo) {
      numberChanges.push(`客户 PO ${prevBuyerPoNo || "（未填）"} → ${order.buyerPoNo || "（清空）"}`);
    }
    if (body.erpOrderNo !== undefined && body.erpOrderNo !== prevErpOrderNo) {
      numberChanges.push(`ERP 单号 ${prevErpOrderNo || "（未填）"} → ${order.erpOrderNo || "（清空）"}`);
    }
    store.orderEvents.push({
      id: `orde_${order.id}_${Date.now()}_edit`,
      orderId: order.id,
      type: "note",
      content: numberChanges.length ? numberChanges.join("；") : "更新订单条款/明细",
      operatorId: req.user!.id,
      createdAt: now
    });
    await store.persist();
    res.json({ order: orderView(store, order) });
  }));

  app.post("/api/orders/:id/status", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      toStatus: z.enum(["pending", "confirmed", "in_production", "ready_to_ship", "shipped", "delivered", "completed", "cancelled"]),
      expectedStatus: z.enum(["pending", "confirmed", "in_production", "ready_to_ship", "shipped", "delivered", "completed", "cancelled"]).optional(),
      reason: z.string().trim().max(500).optional().default(""),
      deliveredAt: z.string().trim().max(40).optional(),
      docsWaiver: z.boolean().optional().default(false),
      secondConfirm: z.boolean().optional().default(false)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "状态参数不合法", issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const store = getStore();
    const order = store.orders.find((item) => item.id === req.params.id);
    if (!order || !orderVisible(req.user!, order)) {
      res.status(404).json({ message: "订单不存在或无权查看" });
      return;
    }
    if (body.expectedStatus && body.expectedStatus !== order.status) {
      res.status(409).json({ message: `订单状态已变为「${ORDER_STATUS_LABELS[order.status]}」，请刷新后重试` });
      return;
    }
    const items = store.orderItems.filter((item) => item.orderId === order.id);
    const documents = orderDocumentsOf(store, order);
    const check = checkOrderTransition({
      order,
      toStatus: body.toStatus,
      items,
      reason: body.reason,
      documents,
      docsWaiver: body.docsWaiver,
      secondConfirm: body.secondConfirm
    });
    if (!check.ok) {
      res.status(check.status || 400).json({
        message: check.message || "状态变更被拒绝",
        needsOverride: check.needsOverride || false,
        needsSecondConfirm: check.needsSecondConfirm || false
      });
      return;
    }
    if (check.needsOverride && !hasIamPermission(req.user, "order.status.override")) {
      res.status(403).json({ message: "该操作需要主管权限（订单状态回退/强推）" });
      return;
    }
    const fromStatus = order.status;
    const now = new Date().toISOString();
    order.status = body.toStatus;
    order.updatedAt = now;
    // 回退/跳级先清掉目标阶段之后的已发生时间，再写本次落点的时间。
    clearForwardTimestamps(order, body.toStatus);
    if (body.toStatus === "confirmed") order.confirmedAt = now;
    if (body.toStatus === "delivered") order.deliveredAt = body.deliveredAt || now;
    if (body.toStatus === "completed") order.completedAt = now;
    if (body.toStatus === "cancelled") {
      order.cancelledAt = now;
      order.cancelReason = body.reason;
    }
    store.orderEvents.push({
      id: `orde_${order.id}_${Date.now()}_status`,
      orderId: order.id,
      type: "status",
      fromStatus,
      toStatus: body.toStatus,
      content: `${ORDER_STATUS_LABELS[fromStatus]} → ${ORDER_STATUS_LABELS[body.toStatus]}${body.reason ? `；原因：${body.reason}` : ""}${body.docsWaiver ? "；单证豁免" : ""}`,
      operatorId: req.user!.id,
      createdAt: now
    });
    await store.persist();
    res.json({ order: orderView(store, order) });
  }));

  app.post("/api/orders/:id/notes", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({ content: z.string().trim().min(1).max(2000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "备注内容不能为空" });
      return;
    }
    const store = getStore();
    const order = store.orders.find((item) => item.id === req.params.id);
    if (!order || !orderVisible(req.user!, order)) {
      res.status(404).json({ message: "订单不存在或无权查看" });
      return;
    }
    const now = new Date().toISOString();
    const event = {
      id: `orde_${order.id}_${Date.now()}_note`,
      orderId: order.id,
      type: "note" as const,
      content: parsed.data.content,
      operatorId: req.user!.id,
      createdAt: now
    };
    store.orderEvents.push(event);
    order.updatedAt = now;
    await store.persist();
    res.status(201).json({ event });
  }));

  // ---------------------------------------------------------------------------
  // M6：旧资产收编（order_files → files）
  // ---------------------------------------------------------------------------

  app.get("/api/orders/legacy-files/audit", asyncRoute(async (req, res) => {
    if (!fileIsAdmin(req.user!)) {
      res.status(403).json({ message: "只有管理员能查看旧文件收编清单" });
      return;
    }
    const store = getStore();
    const repository = getFileRepository();
    const items = store.orderFiles
      .filter((file) => !file.supersededByFileId)
      .map((file) => {
        const asset = store.knowledgeAssets.find((item) => item.id === file.assetId);
        const order = store.orders.find((item) => item.id === file.orderId);
        return {
          id: file.id,
          orderId: file.orderId,
          orderNo: order?.orderNo || "",
          kind: file.kind,
          createdAt: file.createdAt,
          assetId: file.assetId,
          assetName: asset?.title || "",
          // 三种状态要分开说：资产还在（有链接=外链 / 无链接=本地）/ 资产被删
          assetState: !asset ? "missing" : asset.sourceUrl ? "external" : "local",
          sourceUrl: asset?.sourceUrl || "",
          adoptable: Boolean(asset),
          // 旧资产没有字节，只能靠新上传一份来收编；这里给出提示而不是假装能一键搬
          hint: !asset
            ? "资产已被删除，只能重新上传"
            : asset.sourceUrl
              ? "外链资料无法自动下载，请上传原件后再收编"
              : "资产在本机资料库，可收编为文件中心资产"
        };
      });
    res.json({ total: items.length, items, repositoryReady: Boolean(repository) });
  }));

  app.post("/api/orders/legacy-files/adopt", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    if (!fileIsAdmin(req.user!)) {
      res.status(403).json({ message: "只有管理员能执行收编" });
      return;
    }
    const parsed = z.object({
      items: z.array(z.object({
        orderFileId: z.string().trim().min(1).max(64),
        fileId: z.string().trim().min(1).max(64)
      })).min(1).max(50)
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: "收编参数不合法（一次最多 50 条）" });
      return;
    }
    const store = getStore();
    const results: Array<{ orderFileId: string; ok: boolean; message: string }> = [];
    for (const item of parsed.data.items) {
      const legacy = store.orderFiles.find((row) => row.id === item.orderFileId);
      if (!legacy) {
        results.push({ orderFileId: item.orderFileId, ok: false, message: "旧记录不存在" });
        continue;
      }
      if (legacy.supersededByFileId) {
        results.push({ orderFileId: item.orderFileId, ok: false, message: "已经收编过了" });
        continue;
      }
      const file = await repository.findFile(item.fileId);
      if (!file) {
        results.push({ orderFileId: item.orderFileId, ok: false, message: "目标文件不存在" });
        continue;
      }
      if (file.ownerId !== legacy.createdBy && !fileIsAdmin(req.user!)) {
        results.push({ orderFileId: item.orderFileId, ok: false, message: "目标文件不属于这条记录的创建人" });
        continue;
      }
      await repository.addReference({
        fileId: file.id,
        entityType: "order",
        entityId: legacy.orderId,
        kind: legacy.kind || "other",
        createdBy: req.user!.id
      });
      legacy.supersededByFileId = file.id;
      results.push({ orderFileId: legacy.id, ok: true, message: "" });
    }
    const changed = results.filter((item) => item.ok).length;
    if (changed) await store.persist();
    res.json({ changed, results });
  }));

  app.post("/api/orders/:id/files", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      assetId: z.string().trim().min(1).max(64).optional(),
      fileId: z.string().trim().min(1).max(64).optional(),
      kind: z.enum(["contract", "pi", "ci", "pl", "inspection", "other"]).default("other"),
      note: z.string().trim().max(200).optional().default("")
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success || (!parsed.data.assetId && !parsed.data.fileId)) {
      res.status(400).json({ message: "文件关联参数不合法" });
      return;
    }
    const store = getStore();
    const order = store.orders.find((item) => item.id === req.params.id);
    if (!order || !orderVisible(req.user!, order)) {
      res.status(404).json({ message: "订单不存在或无权查看" });
      return;
    }

    // 新上传的真文件：建引用即可，文件本体不动
    if (parsed.data.fileId) {
      const repository = getFileRepository();
      if (!repository) {
        res.status(503).json({ message: "文件存储未就绪" });
        return;
      }
      const loaded = await loadAccessibleFile(req.user!, parsed.data.fileId, "raw");
      if (!loaded.ok) {
        res.status(loaded.error.status).json({ message: loaded.error.message });
        return;
      }
      const existing = (await repository.referencesForEntity("order", order.id))
        .find((item) => item.file.id === loaded.file.id);
      if (existing) {
        res.status(409).json({ message: "该文件已关联到本订单" });
        return;
      }
      const reference = await repository.addReference({
        fileId: loaded.file.id,
        entityType: "order",
        entityId: order.id,
        kind: parsed.data.kind,
        createdBy: req.user!.id
      });
      const now = new Date().toISOString();
      store.orderEvents.push({
        id: `orde_${order.id}_${Date.now()}_file`,
        orderId: order.id,
        type: "file",
        content: `关联文件《${loaded.file.originalName}》`,
        operatorId: req.user!.id,
        refType: "file",
        refId: loaded.file.id,
        createdAt: now
      });
      order.updatedAt = now;
      await store.persist();
      res.status(201).json({ file: { id: reference.id, fileId: loaded.file.id, kind: parsed.data.kind } });
      return;
    }

    const asset = store.knowledgeAssets.find((item) => item.id === parsed.data.assetId);
    if (!asset) {
      res.status(404).json({ message: "文件不存在" });
      return;
    }
    if (!canSeeOwner(req.user!, asset.ownerId, asset.teamId || "")) {
      res.status(403).json({ message: "无权关联该文件" });
      return;
    }
    if (store.orderFiles.some((file) => file.orderId === order.id && file.assetId === asset.id)) {
      res.status(409).json({ message: "该文件已关联到本订单" });
      return;
    }
    const now = new Date().toISOString();
    // 一次关联多份时会连续 POST：只用 Date.now() 会让同一毫秒的两条撞主键。
    const uniquePart = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const file: OrderFile = {
      id: `ordf_${order.id}_${uniquePart()}`,
      orderId: order.id,
      assetId: asset.id,
      kind: parsed.data.kind,
      note: parsed.data.note,
      createdBy: req.user!.id,
      createdAt: now
    };
    store.orderFiles.push(file);
    store.orderEvents.push({
      id: `orde_${order.id}_${uniquePart()}_file`,
      orderId: order.id,
      type: "file",
      content: `关联文件《${asset.title}》`,
      operatorId: req.user!.id,
      refType: "knowledge_asset",
      refId: asset.id,
      createdAt: now
    });
    order.updatedAt = now;
    await store.persist();
    res.status(201).json({ file });
  }));

  app.patch("/api/orders/:id/files/:fileId", requireAuth, asyncRoute(async (req, res) => {
    // 分类只能在关联时选一次，是这版最容易出错的地方：合同点成「其他」之后，
    // 详情页按类型筛选就再也找不回来。给一个只改分类/备注的入口，不动关联本身。
    const ORDER_FILE_KIND_LABELS: Record<OrderFile["kind"], string> = {
      contract: "合同", pi: "PI", ci: "CI", pl: "PL", inspection: "验货报告", other: "其他"
    };
    const schema = z.object({
      kind: z.enum(["contract", "pi", "ci", "pl", "inspection", "other"]).optional(),
      note: z.string().trim().max(200).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "文件参数不合法" });
      return;
    }
    const store = getStore();
    const order = store.orders.find((item) => item.id === req.params.id);
    if (!order || !orderVisible(req.user!, order)) {
      res.status(404).json({ message: "订单不存在或无权查看" });
      return;
    }
    if (req.params.fileId.startsWith("fref_")) {
      const repository = getFileRepository();
      if (!repository) {
        res.status(503).json({ message: "文件存储未就绪" });
        return;
      }
      const target = (await repository.referencesForEntity("order", order.id))
        .find((item) => item.reference.id === req.params.fileId);
      if (!target) {
        res.status(404).json({ message: "文件关联不存在" });
        return;
      }
      if (parsed.data.kind) {
        await repository.updateReferenceKind(target.reference.id, parsed.data.kind);
        store.orderEvents.push({
          id: `orde_${order.id}_${Date.now()}_filekind`,
          orderId: order.id,
          type: "file",
          content: `文件《${target.file.originalName}》分类改为 ${ORDER_FILE_KIND_LABELS[parsed.data.kind] || parsed.data.kind}`,
          operatorId: req.user!.id,
          refType: "file",
          refId: target.file.id,
          createdAt: new Date().toISOString()
        });
        order.updatedAt = new Date().toISOString();
        await store.persist();
      }
      res.json({ file: { id: target.reference.id, fileId: target.file.id, kind: parsed.data.kind || target.reference.kind } });
      return;
    }
    const file = store.orderFiles.find(
      (item) => item.id === req.params.fileId && item.orderId === order.id
    );
    if (!file) {
      res.status(404).json({ message: "文件关联不存在" });
      return;
    }
    const beforeKind = file.kind;
    if (parsed.data.kind) file.kind = parsed.data.kind;
    if (parsed.data.note !== undefined) file.note = parsed.data.note;
    const now = new Date().toISOString();
    if (parsed.data.kind && parsed.data.kind !== beforeKind) {
      const asset = store.knowledgeAssets.find((item) => item.id === file.assetId);
      store.orderEvents.push({
        id: `orde_${order.id}_${Date.now()}_filekind`,
        orderId: order.id,
        type: "file",
        content: `文件《${asset?.title || file.assetId}》分类改为 ${ORDER_FILE_KIND_LABELS[parsed.data.kind] || parsed.data.kind}`,
        operatorId: req.user!.id,
        refType: "knowledge_asset",
        refId: file.assetId,
        createdAt: now
      });
      order.updatedAt = now;
    }
    await store.persist();
    res.json({ file });
  }));

  app.delete("/api/orders/:id/files/:fileId", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const order = store.orders.find((item) => item.id === req.params.id);
    if (!order || !orderVisible(req.user!, order)) {
      res.status(404).json({ message: "订单不存在或无权查看" });
      return;
    }
    if (req.params.fileId.startsWith("fref_")) {
      const repository = getFileRepository();
      if (!repository) {
        res.status(503).json({ message: "文件存储未就绪" });
        return;
      }
      // 必须按「本订单的引用」删，不能直接按 id 删：否则知道 fref_ 就能解掉别人订单的关联
      const target = (await repository.referencesForEntity("order", order.id))
        .find((item) => item.reference.id === req.params.fileId);
      if (!target) {
        res.status(404).json({ message: "文件关联不存在" });
        return;
      }
      await repository.removeReference(target.reference.id);
      store.orderEvents.push({
        id: `orde_${order.id}_${Date.now()}_unfile`,
        orderId: order.id,
        type: "file",
        content: `取消文件关联《${target.file.originalName}》`,
        operatorId: req.user!.id,
        refType: "file",
        refId: target.file.id,
        createdAt: new Date().toISOString()
      });
      order.updatedAt = new Date().toISOString();
      await store.persist();
      res.json({ ok: true });
      return;
    }
    const index = store.orderFiles.findIndex(
      (file) => file.id === req.params.fileId && file.orderId === order.id
    );
    if (index < 0) {
      res.status(404).json({ message: "文件关联不存在" });
      return;
    }
    store.orderFiles.splice(index, 1);
    const now = new Date().toISOString();
    store.orderEvents.push({
      id: `orde_${order.id}_${Date.now()}_unfile`,
      orderId: order.id,
      type: "file",
      content: "取消文件关联",
      operatorId: req.user!.id,
      createdAt: now
    });
    order.updatedAt = now;
    await store.persist();
    res.json({ ok: true });
  }));

  app.post("/api/orders/:id/recalc", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const order = store.orders.find((item) => item.id === req.params.id);
    if (!order || !orderVisible(req.user!, order)) {
      res.status(404).json({ message: "订单不存在或无权查看" });
      return;
    }
    const before = store.orderItems.filter((item) => item.orderId === order.id).map((item) => item.shippedQty);
    const recalculated = recalcShippedQty(store, order.id);
    const synced = syncOrderFulfillment({ store, orderId: order.id, operatorId: req.user!.id });
    const after = recalculated.items.map((item) => item.shippedQty);
    if (recalculated.changed || synced.changed) {
      order.updatedAt = new Date().toISOString();
      await store.persist();
    }
    res.json({
      order: orderView(store, order),
      changed: recalculated.changed || synced.changed,
      before,
      after
    });
  }));

  app.post("/api/orders/backfill", requireAuth, asyncRoute(async (req, res) => {
    const dryRun = req.body?.dryRun !== false;
    const store = getStore();
    const pendingDeals = store.deals
      .filter((deal) => deal.stage === "成交" && canSeeOwner(req.user!, deal.ownerId, deal.teamId))
      .filter((deal) => !store.orders.some((order) => order.dealId === deal.id))
      .sort((left, right) => String(left.closedAt || "").localeCompare(String(right.closedAt || "")));

    const preview = pendingDeals.slice(0, 50).map((deal) => {
      const customer = store.customers.find((item) => item.id === deal.customerId);
      return {
        dealId: deal.id,
        title: deal.title,
        customerName: customer?.company || deal.title,
        amount: deal.amount,
        currency: deal.currency,
        closedAt: deal.closedAt || ""
      };
    });

    if (dryRun) {
      res.json({ dryRun: true, total: pendingDeals.length, preview });
      return;
    }
    let created = 0;
    for (const deal of pendingDeals) {
      try {
        const customer = store.customers.find((item) => item.id === deal.customerId);
        const result = ensureOrderForWonDeal({
          store,
          deal,
          customer,
          operatorId: req.user!.id
        });
        if (result.created) {
          result.order.source = "backfill";
          created += 1;
        }
      } catch (error) {
        console.error("order backfill failed:", deal.id, error);
      }
    }
    await store.persist();
    res.json({ dryRun: false, total: pendingDeals.length, created, skipped: pendingDeals.length - created });
  }));
}
