/**
 * 订单（履约主档）业务规则
 * ---------------------------------------------------------------------------
 * 这一层只放纯规则：单号、金额、状态迁移、进度派生、发货回写。
 * 不碰 HTTP、不碰持久化，方便单测与未来替换成 ERP 适配器。
 *
 * 三条硬边界（与设计方案 v2 一致）：
 * 1. 不含税、不含汇率、不含库存、不含成本——CRM 订单是客户侧履约视图。
 * 2. 金额只做合同口径，由明细汇总，不接受外部覆盖。
 * 3. 订单模块不得写客户跟进记录（那是业绩考核的数据源，写入不可逆）。
 */
import type { CrmStore } from "./store.js";
import type {
  Customer,
  Deal,
  Order,
  OrderEvent,
  OrderItem,
  OrderStatus,
  Shipment,
  TradeDocument
} from "./types.js";

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "待确认",
  confirmed: "已确认",
  in_production: "生产中",
  ready_to_ship: "待发货",
  shipped: "已发货",
  delivered: "已签收",
  completed: "已完成",
  cancelled: "已取消"
};

/** 详情页状态条按这个顺序画；cancelled 是终态，不占段位。 */
export const ORDER_STATUS_FLOW: OrderStatus[] = [
  "pending",
  "confirmed",
  "in_production",
  "ready_to_ship",
  "shipped",
  "delivered",
  "completed"
];

export type OrderTone = "warn" | "info" | "accent" | "ok" | "done" | "muted";

/** 允许的迁移：仅相邻前进；回退另由权限 + 原因控制。 */
export const ORDER_NEXT_STATUS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["in_production", "ready_to_ship", "cancelled"],
  in_production: ["ready_to_ship", "cancelled"],
  ready_to_ship: ["shipped", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: ["completed", "cancelled"],
  completed: [],
  cancelled: []
};

const TERMINAL: OrderStatus[] = ["completed", "cancelled"];

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL.includes(status);
}

export function isPreShipmentStatus(status: OrderStatus): boolean {
  return ["pending", "confirmed", "in_production", "ready_to_ship"].includes(status);
}

export function isBackwardTransition(from: OrderStatus, to: OrderStatus): boolean {
  const fromIndex = ORDER_STATUS_FLOW.indexOf(from);
  const toIndex = ORDER_STATUS_FLOW.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return false;
  return toIndex < fromIndex;
}

/* ------------------------------- 金额 ------------------------------- */

/** 统一保留 2 位小数（四舍五入），避免 0.1+0.2 的浮点尾差进入 SQL。 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function lineAmount(qty: number, unitPrice: number): number {
  const quantity = Number.isFinite(qty) ? qty : 0;
  const price = Number.isFinite(unitPrice) ? unitPrice : 0;
  return roundMoney(quantity * price);
}

export function sumOrderItems(items: Array<Pick<OrderItem, "amount">>): number {
  return roundMoney(items.reduce((total, item) => total + (Number(item.amount) || 0), 0));
}

/* ------------------------------- 单号 ------------------------------- */

/**
 * `GJ-SO-YYMM-NNNN`。
 * 在内存数组里同步取号（Node 单线程，中间无 await 即不会重号）；
 * MySQL 唯一索引是最后一道兜底，撞号时由调用方重试。
 */
export function nextOrderNo(store: Pick<CrmStore, "orders">, now = new Date()): string {
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `GJ-SO-${year}${month}-`;
  let max = 0;
  for (const order of store.orders) {
    if (!order.orderNo.startsWith(prefix)) continue;
    const seq = Number(order.orderNo.slice(prefix.length));
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

export function nextSplitSeq(store: Pick<CrmStore, "orders">, dealId: string): number {
  if (!dealId) return 1;
  let max = 0;
  for (const order of store.orders) {
    if (order.dealId !== dealId) continue;
    if (order.splitSeq > max) max = order.splitSeq;
  }
  return max + 1;
}

/* --------------------------- 成交 → 订单 --------------------------- */

export interface EnsureOrderResult {
  order: Order;
  items: OrderItem[];
  created: boolean;
}

export function buildOrderItemsFromDeal(
  orderId: string,
  deal: Deal,
  now: string
): OrderItem[] {
  const source = Array.isArray(deal.items) && deal.items.length
    ? deal.items
    : [{
        id: `deal_item_${deal.id}`,
        product: deal.product || deal.title,
        model: "",
        quantity: deal.quantity || 1,
        unitPrice: deal.unitPrice || 0
      }];
  return source.map((item, index) => {
    const qty = Number(item.quantity) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    return {
      id: `ordi_${orderId}_${index + 1}`,
      orderId,
      lineNo: (index + 1) * 10,
      product: item.product || "",
      spec: item.model || "",
      qty,
      unit: "",
      unitPrice,
      amount: lineAmount(qty, unitPrice),
      shippedQty: 0,
      remark: ""
    } satisfies OrderItem;
  });
}

/**
 * 成交自动建单：幂等（同商机 + splitSeq=1 只会有一张）。
 * 调用方负责 try/catch —— 建单失败不能回滚成交。
 */
export function ensureOrderForWonDeal(input: {
  store: CrmStore;
  deal: Deal;
  customer?: Customer;
  operatorId: string;
  now?: Date;
}): EnsureOrderResult {
  const { store, deal, customer, operatorId } = input;
  const nowDate = input.now || new Date();
  const now = nowDate.toISOString();

  const existing = store.orders.find(
    (order) => order.dealId === deal.id && order.splitSeq === 1
  );
  if (existing) {
    const items = store.orderItems.filter((item) => item.orderId === existing.id);
    return { order: existing, items, created: false };
  }

  const orderId = `ord_${nowDate.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
  const items = buildOrderItemsFromDeal(orderId, deal, now);
  const order: Order = {
    id: orderId,
    orderNo: nextOrderNo(store, nowDate),
    dealId: deal.id,
    splitSeq: 1,
    customerId: deal.customerId,
    customerName: customer?.company || deal.title || "",
    status: "pending",
    currency: deal.currency || "USD",
    amount: sumOrderItems(items),
    incoterm: customer?.defaultIncoterm || "",
    paymentTerm: customer?.defaultPaymentTerm || "",
    portLoading: "",
    portDischarge: customer?.defaultPortDischarge || "",
    buyerPoNo: "",
    // 公司自己的订单号只能人工录入：成交那一刻还没有，留空等业务员补。
    companyOrderNo: "",
    productionRequired: false,
    expectedShipAt: "",
    confirmedAt: "",
    shippedAt: "",
    deliveredAt: "",
    completedAt: "",
    cancelledAt: "",
    cancelReason: "",
    erpOrderNo: "",
    erpSyncStatus: "none",
    source: "deal_auto",
    ownerId: deal.ownerId,
    teamId: deal.teamId,
    remark: "",
    createdBy: operatorId,
    createdAt: now,
    updatedAt: now
  };

  store.orders.push(order);
  store.orderItems.push(...items);
  store.orderEvents.push({
    id: `orde_${orderId}_created`,
    orderId,
    type: "created",
    content: `由商机《${deal.title}》成交自动生成`,
    operatorId,
    refType: "deal",
    refId: deal.id,
    createdAt: now
  });
  deal.orderId = order.id;
  return { order, items, created: true };
}

/* --------------------------- 发货 → 进度 --------------------------- */

function normalizeText(value: string): string {
  return String(value || "").trim().toLowerCase();
}

/**
 * 按发货单重算 `shipped_qty`（替换式，不是累加差值）：
 * 同一张发货单反复保存不会把数量翻倍，删除发货单也能自动回退。
 *
 * 明细匹配优先级：orderItemId > 品名 + 规格。匹配不上就跳过，不猜。
 */
export function recalcShippedQty(store: CrmStore, orderId: string): {
  items: OrderItem[];
  changed: boolean;
  allShipped: boolean;
} {
  const items = store.orderItems.filter((item) => item.orderId === orderId);
  if (!items.length) return { items, changed: false, allShipped: false };

  const shipments = store.shipments.filter(
    (shipment) => shipment.orderId === orderId && shipment.status !== "draft"
  );
  const sums = new Map<string, number>();
  items.forEach((item) => sums.set(item.id, 0));

  for (const shipment of shipments) {
    for (const line of shipment.items || []) {
      const byId = line.orderItemId
        ? items.find((item) => item.id === line.orderItemId)
        : undefined;
      const fallback = byId || items.find(
        (item) => normalizeText(item.product) === normalizeText(line.productName)
          && (!line.model || normalizeText(item.spec) === normalizeText(line.model))
      );
      if (!fallback) continue;
      sums.set(fallback.id, (sums.get(fallback.id) || 0) + (Number(line.quantity) || 0));
    }
  }

  let changed = false;
  for (const item of items) {
    const next = sums.get(item.id) || 0;
    if (item.shippedQty !== next) {
      item.shippedQty = next;
      changed = true;
    }
  }
  const allShipped = items.every((item) => item.qty <= 0 || item.shippedQty >= item.qty);
  return { items, changed, allShipped };
}

/**
 * 发货单创建 / 修改 / 删除后同步订单状态。
 * 只允许「待发货 → 已发货」与「已发货 → 待发货」两种由事实驱动的迁移；
 * 人工推进仍走 API，避免事实与状态互相覆盖。
 */
export function syncOrderFulfillment(input: {
  store: CrmStore;
  orderId: string;
  operatorId: string;
  now?: Date;
}): { order?: Order; changed: boolean; event?: OrderEvent } {
  const { store, orderId, operatorId } = input;
  const order = store.orders.find((item) => item.id === orderId);
  if (!order) return { changed: false };
  const now = (input.now || new Date()).toISOString();
  const { allShipped, changed } = recalcShippedQty(store, orderId);
  const hasShipment = store.shipments.some(
    (shipment) => shipment.orderId === orderId && shipment.status !== "draft"
  );

  let nextStatus: OrderStatus | null = null;
  if (allShipped && hasShipment && ["confirmed", "in_production", "ready_to_ship"].includes(order.status)) {
    nextStatus = "shipped";
  } else if (!allShipped && order.status === "shipped") {
    nextStatus = "ready_to_ship";
  } else if (hasShipment && ["confirmed", "in_production"].includes(order.status)) {
    nextStatus = "ready_to_ship";
  } else if (!hasShipment && order.status === "ready_to_ship") {
    // 发货单被删光：退回上一可执行态，但不动已确认的订单
    nextStatus = order.productionRequired ? "in_production" : "confirmed";
  }

  if (!nextStatus) {
    if (changed) order.updatedAt = now;
    return { order, changed };
  }

  const fromStatus = order.status;
  order.status = nextStatus;
  order.updatedAt = now;
  if (nextStatus === "shipped") {
    order.shippedAt = order.shippedAt || now;
  } else if (fromStatus === "shipped" && nextStatus === "ready_to_ship") {
    order.shippedAt = "";
  }
  const event: OrderEvent = {
    id: `orde_${orderId}_${Date.now()}_ship`,
    orderId,
    type: "shipment",
    fromStatus,
    toStatus: nextStatus,
    content: nextStatus === "shipped"
      ? "发货数量已覆盖全部明细，自动转为已发货"
      : `发货单变更，状态回到${ORDER_STATUS_LABELS[nextStatus]}`,
    operatorId,
    createdAt: now
  };
  store.orderEvents.push(event);
  return { order, changed: true, event };
}

/* --------------------------- 派生字段 --------------------------- */

export interface OrderDerived {
  shippingProgress: number;
  shippedQtyTotal: number;
  qtyTotal: number;
  isOverdue: boolean;
  overdueDays: number;
  docsReady: boolean;
  missingDocs: string[];
  nextAction: string;
  daysToShip: number | null;
}

export function deriveOrder(
  order: Order,
  items: OrderItem[],
  documents: TradeDocument[],
  today = new Date()
): OrderDerived {
  const qtyTotal = items.reduce((total, item) => total + (Number(item.qty) || 0), 0);
  const shippedQtyTotal = items.reduce(
    (total, item) => total + Math.min(Number(item.shippedQty) || 0, Number(item.qty) || 0),
    0
  );
  const shippingProgress = qtyTotal > 0 ? Math.min(1, shippedQtyTotal / qtyTotal) : 0;

  const docTypes = new Set(
    documents.filter((doc) => doc.status !== "rejected").map((doc) => doc.type)
  );
  const missingDocs: string[] = [];
  if (!docTypes.has("CI")) missingDocs.push("CI");
  if (!docTypes.has("PL")) missingDocs.push("PL");
  const docsReady = missingDocs.length === 0;

  let overdueDays = 0;
  let daysToShip: number | null = null;
  if (order.expectedShipAt) {
    const expected = new Date(`${order.expectedShipAt}T00:00:00`);
    if (!Number.isNaN(expected.getTime())) {
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const diff = Math.floor((expected.getTime() - todayStart.getTime()) / 86400000);
      daysToShip = diff;
      if (diff < 0 && isPreShipmentStatus(order.status)) overdueDays = Math.abs(diff);
    }
  }

  return {
    shippingProgress,
    shippedQtyTotal,
    qtyTotal,
    isOverdue: overdueDays > 0,
    overdueDays,
    docsReady,
    missingDocs,
    nextAction: nextActionFor(order, missingDocs),
    daysToShip
  };
}

export function nextActionFor(order: Order, missingDocs: string[] = []): string {
  switch (order.status) {
    case "pending":
      return "补全 Incoterm / 付款条件后确认";
    case "confirmed":
      return order.productionRequired ? "安排生产" : "备货，完成后建发货单";
    case "in_production":
      return "生产完成后转「待发货」";
    case "ready_to_ship":
      return "创建发货单并出运";
    case "shipped":
      return "跟踪物流，客户签收后登记";
    case "delivered":
      return missingDocs.length ? `补齐 ${missingDocs.join(" / ")} 后完成` : "归档并完成订单";
    case "completed":
      return "已归档";
    case "cancelled":
      return "已取消";
    default:
      return "";
  }
}

/* --------------------------- 状态校验 --------------------------- */

export interface TransitionCheck {
  ok: boolean;
  status?: number;
  message?: string;
  /** 需要 order.status.override 权限（回退 / 已发货后取消 / 跳级）。 */
  needsOverride?: boolean;
  /** 需要二次确认（已发货后取消）。 */
  needsSecondConfirm?: boolean;
}

export function checkOrderTransition(input: {
  order: Order;
  toStatus: OrderStatus;
  items: OrderItem[];
  reason: string;
  documents: TradeDocument[];
  docsWaiver: boolean;
  secondConfirm: boolean;
}): TransitionCheck {
  const { order, toStatus, items, reason, documents, docsWaiver, secondConfirm } = input;
  if (order.status === toStatus) {
    return { ok: false, status: 409, message: "订单已处于该状态" };
  }
  if (isTerminalOrderStatus(order.status)) {
    return { ok: false, status: 409, message: "终态订单不能再变更状态" };
  }
  if (toStatus === "shipped") {
    return { ok: false, status: 400, message: "「已发货」由发货单回写，不能手工设置；请先创建发货单" };
  }

  const allowed = ORDER_NEXT_STATUS[order.status] || [];
  const adjacent = allowed.includes(toStatus);
  const backward = isBackwardTransition(order.status, toStatus);
  if (!adjacent && !backward) {
    return { ok: false, status: 409, message: `不能从「${ORDER_STATUS_LABELS[order.status]}」直接变为「${ORDER_STATUS_LABELS[toStatus]}」` };
  }
  if (backward && !reason.trim()) {
    return { ok: false, status: 400, message: "状态回退必须填写原因", needsOverride: true };
  }
  if (toStatus === "cancelled") {
    if (!reason.trim()) return { ok: false, status: 400, message: "取消订单必须填写原因" };
    if (["shipped", "delivered"].includes(order.status)) {
      if (!secondConfirm) {
        return { ok: false, status: 409, message: "已发货订单取消需要二次确认", needsOverride: true, needsSecondConfirm: true };
      }
      return { ok: true, needsOverride: true };
    }
    return { ok: true };
  }
  if (toStatus === "confirmed") {
    if (!order.incoterm.trim() || !order.paymentTerm.trim()) {
      return { ok: false, status: 400, message: "确认前必须补全 Incoterm 与付款条件" };
    }
    if (!items.length) return { ok: false, status: 400, message: "订单没有明细，不能确认" };
    if (sumOrderItems(items) <= 0) return { ok: false, status: 400, message: "订单金额必须大于 0" };
  }
  if (toStatus === "in_production" && !order.productionRequired) {
    return { ok: false, status: 400, message: "该订单未标记需要生产，无需进入生产中" };
  }
  if (toStatus === "completed") {
    const types = new Set(documents.filter((doc) => doc.status !== "rejected").map((doc) => doc.type));
    const missing = ["CI", "PL"].filter((type) => !types.has(type as TradeDocument["type"]));
    if (missing.length && !docsWaiver) {
      return { ok: false, status: 422, message: `完成前需补齐 ${missing.join(" / ")}，或填写豁免原因` };
    }
    if (missing.length && docsWaiver && !reason.trim()) {
      return { ok: false, status: 400, message: "豁免单证必须填写原因" };
    }
  }
  if (backward) return { ok: true, needsOverride: true };
  return { ok: true };
}

/** 各阶段落库的时间字段；cancelled 不占段位，单独处理。 */
const ORDER_STAGE_TIMESTAMPS: Array<{
  status: OrderStatus;
  field: "confirmedAt" | "shippedAt" | "deliveredAt" | "completedAt";
}> = [
  { status: "confirmed", field: "confirmedAt" },
  { status: "shipped", field: "shippedAt" },
  { status: "delivered", field: "deliveredAt" },
  { status: "completed", field: "completedAt" }
];

/**
 * 状态回退/跳级时，把目标阶段之后的「已发生时间」清空。
 * 不清会出现自相矛盾的详情页：delivered → shipped 回退后状态条还挂着签收时间，
 * 和「已发货」并排显示，用户无法判断到底签没签。
 * cancelled 不在主流程里，保留历史时间不清理。
 */
export function clearForwardTimestamps(order: Order, toStatus: OrderStatus): void {
  const targetIndex = ORDER_STATUS_FLOW.indexOf(toStatus);
  if (targetIndex < 0) return;
  ORDER_STAGE_TIMESTAMPS.forEach((stage) => {
    if (ORDER_STATUS_FLOW.indexOf(stage.status) > targetIndex) {
      order[stage.field] = "";
    }
  });
}

export function orderShipments(store: Pick<CrmStore, "shipments">, orderId: string): Shipment[] {
  return store.shipments
    .filter((shipment) => shipment.orderId === orderId)
    .sort((left, right) => String(right.shippedAt || right.updatedAt).localeCompare(String(left.shippedAt || left.updatedAt)));
}
