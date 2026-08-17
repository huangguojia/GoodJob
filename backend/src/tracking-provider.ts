import { randomUUID } from "node:crypto";
import type { ShipmentStatus } from "./types.js";

/**
 * 物流轨迹同步适配层。
 *
 * 设计立场（高级产品经理视角）：
 * - 发货单在「草稿 / 已发货(交运)」阶段由我方(CRM)本地掌控，statusSource = "local"。
 * - 一旦交运并录入运单号，单据进入承运商生命周期，状态必须以来源方(官网/Open API/聚合平台)为准，
 *   statusSource = "carrier"。CRM 不应再用手填状态覆盖在途状态。
 * - 真实生产环境这里应接入承运商 Open API 或 快递100 / AfterShip / 17TRACK 等聚合平台；
 *   原型阶段用 MockCarrierGateway 确定性地模拟官网轨迹语义，接口形态与真实 API 一致，
 *   上线只需把 getTrackingProvider 指向真实 provider 即可，业务层无感。
 */

export interface TrackingEvent {
  id: string;
  time: string; // ISO
  status: ShipmentStatus;
  location: string;
  description: string;
}

export interface TrackingSnapshot {
  status: ShipmentStatus;
  events: TrackingEvent[];
  estimatedArrival?: string;
  source: "carrier" | "local";
  provider: string;
  syncedAt: string;
  error?: string;
}

export interface TrackingQueryInput {
  courier: string;
  trackingCode: string;
  shippedAt?: string;
  origin?: string;
  destination?: string;
}

export interface TrackingProvider {
  name: string;
  /** 该 provider 是否可处理此承运商 */
  supports(courier: string): boolean;
  query(input: TrackingQueryInput): Promise<TrackingSnapshot>;
}

/** 由运单号派生稳定指纹，用于决定该单是否会走「清关异常」剧情（约 1/7） */
function codeHash(code: string): number {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const HUB_BY_COURIER: Record<string, { origin: string; transit: string; dest: string }> = {
  dhl: { origin: "上海揽收中心", transit: "莱比锡国际转运中心", dest: "目的国派送站" },
  fedex: { origin: "上海浦东操作站", transit: "孟菲斯国际枢纽", dest: "目的国派送站" },
  ups: { origin: "上海操作中心", transit: "科隆欧洲枢纽", dest: "目的国派送站" },
  sf: { origin: "深圳集散中心", transit: "武汉转运中心", dest: "目的城市分拨" },
  yto: { origin: "上海转运中心", transit: "南京转运中心", dest: "目的城市分拨" },
  zto: { origin: "上海转运中心", transit: "合肥转运中心", dest: "目的城市分拨" },
  sto: { origin: "上海转运中心", transit: "杭州转运中心", dest: "目的城市分拨" },
  yunda: { origin: "上海转运中心", transit: "苏州转运中心", dest: "目的城市分拨" },
  jd: { origin: "上海亚洲一号", transit: "武汉亚一", dest: "目的城市营业部" },
  ems: { origin: "上海邮政处理中心", transit: "北京邮件枢纽", dest: "目的城市邮政" },
  tt: { origin: "始发国揽收点", transit: "国际中转口岸", dest: "目的国派送网络" }
};

function hub(courier: string) {
  return HUB_BY_COURIER[courier] || { origin: "始发地揽收中心", transit: "国际中转口岸", dest: "目的国派送站" };
}

/** 里程碑（发货后小时数） */
const M = { pickup: 0, depart: 6, transit: 24, customs: 48, outForDelivery: 72, delivered: 96 };

/**
 * 模拟承运商官网轨迹。纯时间驱动 + 运单号指纹决定异常剧情，
 * 保证同一运单号每次查询结果确定、可复现，便于演示与自测。
 */
class MockCarrierGateway implements TrackingProvider {
  name = "mock-carrier";
  supports(): boolean {
    return true; // 默认兜底 provider，覆盖所有承运商
  }
  async query(input: TrackingQueryInput): Promise<TrackingSnapshot> {
    const syncedAt = new Date().toISOString();
    const { courier, trackingCode, shippedAt } = input;
    const h = hub(courier);
    const hazard = codeHash(trackingCode) % 7 === 0; // ~1/7 走清关异常
    const shipped = shippedAt ? new Date(shippedAt) : new Date();
    const elapsedH = Math.max(0, (Date.now() - shipped.getTime()) / 3600000);
    const events: TrackingEvent[] = [];
    const at = (hAfter: number) => new Date(shipped.getTime() + hAfter * 3600000);
    const ev = (status: ShipmentStatus, time: Date, location: string, description: string) =>
      events.push({ id: randomUUID(), time: time.toISOString(), status, location, description });

    ev("shipped", at(M.pickup), h.origin, `快件已揽收（运单号 ${trackingCode}）`);
    if (elapsedH >= M.depart) ev("in_transit", at(M.depart), h.origin, "已发出，离开揽收中心");
    if (elapsedH >= M.transit) ev("in_transit", at(M.transit), h.transit, "到达国际转运中心，分拣中转");
    if (hazard && elapsedH >= M.customs) {
      ev("exception", at(M.customs + 2), h.transit, "清关异常：随附单据不全，海关暂扣，待补充资料");
      return { status: "exception", events, source: "carrier", provider: `mock:${courier}`, syncedAt };
    }
    if (elapsedH >= M.customs) ev("in_transit", at(M.customs), h.dest, "完成清关，进入目的国派送网络");
    if (elapsedH >= M.outForDelivery) ev("in_transit", at(M.outForDelivery), h.dest, "快件已出库，派送中");
    if (elapsedH >= M.delivered) ev("delivered", at(M.delivered), h.dest, "快件已签收");

    let status: ShipmentStatus = "shipped";
    if (elapsedH >= M.delivered) status = "delivered";
    else if (elapsedH >= M.depart) status = "in_transit";
    // 未录入发货时间(刚建单)保持已发货
    if (!shippedAt) status = "shipped";

    return { status, events, source: "carrier", provider: `mock:${courier}`, syncedAt };
  }
}

const PROVIDERS: TrackingProvider[] = [new MockCarrierGateway()];

export function getTrackingProvider(courier: string): TrackingProvider {
  return PROVIDERS.find((p) => p.supports(courier)) || PROVIDERS[0];
}

/** 判断某发货单是否需要/可以被同步：在途状态且有运单号 */
export function isSyncable(status: ShipmentStatus, trackingCode?: string): boolean {
  if (!trackingCode) return false;
  return status === "shipped" || status === "in_transit" || status === "exception";
}

/** 根据官网快照计算要写回发货单的字段 */
export function buildTrackingUpdate(
  current: { estimatedArrival?: string },
  snapshot: TrackingSnapshot
): {
  status: ShipmentStatus;
  statusSource: "carrier";
  trackingEvents: TrackingEvent[];
  lastSyncedAt: string;
  syncError: string;
  estimatedArrival: string;
} {
  return {
    status: snapshot.status,
    statusSource: "carrier",
    trackingEvents: snapshot.events,
    lastSyncedAt: snapshot.syncedAt,
    syncError: snapshot.error || "",
    estimatedArrival: snapshot.estimatedArrival || current.estimatedArrival || ""
  };
}
