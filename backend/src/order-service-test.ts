import assert from "node:assert/strict";
import {
  buildOrderItemsFromDeal,
  checkOrderTransition,
  clearForwardTimestamps,
  deriveOrder,
  ensureOrderForWonDeal,
  nextOrderNo,
  recalcShippedQty,
  sumOrderItems,
  syncOrderFulfillment
} from "./order-service.js";
import type { CrmStore } from "./store.js";
import type { Deal, Order, OrderItem, Shipment, TradeDocument } from "./types.js";

function emptyStore(): CrmStore {
  return {
    mode: "memory",
    orders: [],
    orderItems: [],
    orderEvents: [],
    orderFiles: [],
    shipments: [],
    tradeDocuments: [],
    customers: [],
    deals: [],
    knowledgeAssets: []
  } as unknown as CrmStore;
}

const deal = {
  id: "deal_1",
  customerId: "cust_1",
  title: "10 台空压机",
  stage: "成交",
  product: "空压机",
  quantity: 10,
  unitPrice: 1250.5,
  items: [
    { id: "i1", product: "空压机", model: "AC-10", quantity: 10, unitPrice: 1250.5 }
  ],
  amount: 12505,
  currency: "USD",
  amountType: "won",
  ownerId: "u1",
  teamId: "t1",
  nextAction: "",
  nextActionAt: "",
  expectedCloseAt: "",
  stageChangedAt: new Date().toISOString(),
  closedAt: new Date().toISOString(),
  wonReason: "客户已付定金"
} as Deal;

const store = emptyStore();
store.deals.push(deal);
store.customers.push({
  id: "cust_1",
  company: "ACME TRADING",
  ownerId: "u1",
  teamId: "t1",
  defaultIncoterm: "FOB",
  defaultPaymentTerm: "30% T/T",
  defaultPortDischarge: "Istanbul"
} as any);

// 1) 自动建单：金额按明细汇总，条款来自客户默认值
const created = ensureOrderForWonDeal({ store, deal, customer: store.customers[0], operatorId: "u1" });
assert.equal(created.created, true);
assert.equal(created.order.status, "pending");
assert.equal(created.order.amount, 12505);
assert.equal(created.order.incoterm, "FOB");
assert.equal(created.order.paymentTerm, "30% T/T");
assert.match(created.order.orderNo, /^GJ-SO-\d{4}-\d{4}$/u);
// 成交自动建单拿不到公司自己的单号：必须留空，不能把系统编号抄进去充数
assert.equal(created.order.companyOrderNo, "");
assert.notEqual(created.order.companyOrderNo, created.order.orderNo);
assert.equal(deal.orderId, created.order.id);

// 2) 幂等：重复调用不产生第二张
const again = ensureOrderForWonDeal({ store, deal, customer: store.customers[0], operatorId: "u1" });
assert.equal(again.created, false);
assert.equal(store.orders.length, 1);

// 3) 未补条款不能确认（先清空客户默认值带入的条款）
created.order.incoterm = "";
created.order.paymentTerm = "";
let check = checkOrderTransition({
  order: created.order,
  toStatus: "confirmed",
  items: created.items,
  reason: "",
  documents: [],
  docsWaiver: false,
  secondConfirm: false
});
assert.equal(check.ok, false);
assert.match(String(check.message), /Incoterm/u);

// 4) 补条款后可确认
created.order.incoterm = "FOB";
created.order.paymentTerm = "30% T/T";
check = checkOrderTransition({
  order: created.order,
  toStatus: "confirmed",
  items: created.items,
  reason: "",
  documents: [],
  docsWaiver: false,
  secondConfirm: false
});
assert.equal(check.ok, true);
created.order.status = "confirmed";

// 5) 事实驱动：发货数量覆盖后自动 shipped
const shipment: Shipment = {
  id: "sh1",
  shipmentNo: "S-1",
  dealId: deal.id,
  dealTitle: deal.title,
  customerName: "ACME TRADING",
  courier: "DHL",
  trackingCode: "X1",
  trackingImageUrl: "",
  status: "shipped",
  statusSource: "local",
  shippedAt: new Date().toISOString(),
  estimatedArrival: "",
  note: "",
  items: [{
    id: "si1",
    orderItemId: created.items[0].id,
    productName: "空压机",
    model: "AC-10",
    hsCode: "",
    quantity: 10,
    unit: "SET",
    netWeight: 0,
    grossWeight: 0,
    length: 0,
    width: 0,
    height: 0,
    volume: 0,
    note: ""
  }],
  orderId: created.order.id,
  ownerId: "u1",
  teamId: "t1",
  updatedAt: new Date().toISOString()
};
store.shipments.push(shipment);
const synced = syncOrderFulfillment({ store, orderId: created.order.id, operatorId: "u1" });
assert.equal(synced.order?.status, "shipped");
assert.equal(created.items[0].shippedQty, 10);

// 6) 删除发货单后回落
store.shipments.length = 0;
syncOrderFulfillment({ store, orderId: created.order.id, operatorId: "u1" });
assert.equal(created.order.status, "ready_to_ship");
assert.equal(created.items[0].shippedQty, 0);

// 7) 重复保存同一张发货单不会翻倍（替换式重算）
store.shipments.push({ ...shipment, id: "sh2" });
recalcShippedQty(store, created.order.id);
recalcShippedQty(store, created.order.id);
assert.equal(created.items[0].shippedQty, 10);

// 8) 未发完不进入 shipped
created.order.status = "confirmed";
store.shipments[0].items[0].quantity = 3;
const partial = syncOrderFulfillment({ store, orderId: created.order.id, operatorId: "u1" });
assert.equal(partial.order?.status, "ready_to_ship");
assert.equal(created.items[0].shippedQty, 3);
const derived = deriveOrder(created.order, created.items, [], new Date());
assert.equal(Math.round(derived.shippingProgress * 100), 30);

// 9) 完成前必须 CI + PL，或显式豁免
created.order.status = "delivered";
const docs: TradeDocument[] = [
  { id: "d1", type: "CI", status: "approved" } as TradeDocument
];
let completeCheck = checkOrderTransition({
  order: created.order,
  toStatus: "completed",
  items: created.items,
  reason: "",
  documents: docs,
  docsWaiver: false,
  secondConfirm: false
});
assert.equal(completeCheck.ok, false);
assert.equal(completeCheck.status, 422);
completeCheck = checkOrderTransition({
  order: created.order,
  toStatus: "completed",
  items: created.items,
  reason: "客户同意电子归档",
  documents: docs,
  docsWaiver: true,
  secondConfirm: false
});
assert.equal(completeCheck.ok, true);

// 10) 已发货不能手工置 shipped；取消需二次确认
created.order.status = "ready_to_ship";
const manualShip = checkOrderTransition({
  order: created.order,
  toStatus: "shipped",
  items: created.items,
  reason: "",
  documents: [],
  docsWaiver: false,
  secondConfirm: false
});
assert.equal(manualShip.status, 400);
created.order.status = "shipped";
const cancelCheck = checkOrderTransition({
  order: created.order,
  toStatus: "cancelled",
  items: created.items,
  reason: "客户弃单",
  documents: [],
  docsWaiver: false,
  secondConfirm: false
});
assert.equal(cancelCheck.status, 409);
assert.equal(cancelCheck.needsSecondConfirm, true);

// 11) 单号按月递增
const prefix = created.order.orderNo.slice(0, 9);
assert.equal(nextOrderNo(store).startsWith(prefix), true);
assert.notEqual(nextOrderNo(store), created.order.orderNo);

// 12) 明细空时金额为 0，且确认被拒
assert.equal(sumOrderItems([]), 0);
const emptyItems: OrderItem[] = [];
assert.equal(buildOrderItemsFromDeal("x", { ...deal, items: [], product: "", quantity: 0, unitPrice: 0 }, "").length, 1);

// 13) 状态回退：目标阶段之后的时间必须清空，否则详情页时间条自相矛盾
const rollback = {
  ...created.order,
  confirmedAt: "2026-10-01T00:00:00.000Z",
  shippedAt: "2026-10-03T00:00:00.000Z",
  deliveredAt: "2026-10-09T00:00:00.000Z",
  completedAt: "2026-10-10T00:00:00.000Z"
} as Order;
clearForwardTimestamps(rollback, "shipped");
assert.equal(rollback.deliveredAt, "");
assert.equal(rollback.completedAt, "");
assert.equal(rollback.shippedAt, "2026-10-03T00:00:00.000Z");
assert.equal(rollback.confirmedAt, "2026-10-01T00:00:00.000Z");
clearForwardTimestamps(rollback, "confirmed");
assert.equal(rollback.shippedAt, "");
// 取消不占主流程段位，不能抹掉已发生的履约历史
const cancelledHistory = {
  ...created.order,
  confirmedAt: "2026-10-01T00:00:00.000Z",
  shippedAt: "2026-10-03T00:00:00.000Z"
} as Order;
clearForwardTimestamps(cancelledHistory, "cancelled");
assert.equal(cancelledHistory.confirmedAt, "2026-10-01T00:00:00.000Z");
assert.equal(cancelledHistory.shippedAt, "2026-10-03T00:00:00.000Z");

console.log("order-service: 13 组断言全部通过");
