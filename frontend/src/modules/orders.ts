/**
 * 订单履约。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, confirmAction, openModal, state } from "../prototype-api";
import { type Customer, type KnowledgeAsset } from "./models";
import { cookieValue, escapeHtml, qs, qsa } from "./shared";
import { api, setButtonPending, toast } from "./ui";
import { openArchivedDealInPipeline, refreshDealsData } from "./deals";
import { knowledgeAssetTypeText, knowledgeStatusText } from "./wecom";
import { SHIPMENT_STATUS_LABEL } from "./products";
import { openFileShareModal, openFileVersionsModal, ordAddNote, ordBackfill, ordUnlinkFile } from "./file-center";

/* ==========================================================================
 * 订单履约
 * --------------------------------------------------------------------------
 * 列表 / 详情 / 状态推进 / 发货回写 / 文件关联。
 * 三条约束：金额只读服务端汇总；已发货由发货单回写；绝不写客户跟进记录。
 * ========================================================================== */
export type OrdStatus =
  | "pending"
  | "confirmed"
  | "in_production"
  | "ready_to_ship"
  | "shipped"
  | "delivered"
  | "completed"
  | "cancelled";

interface OrdItem {
  id: string;
  lineNo: number;
  product: string;
  spec: string;
  qty: number;
  unit: string;
  unitPrice: number;
  amount: number;
  shippedQty: number;
  remark: string;
}

interface OrdDerived {
  shippingProgress: number;
  // 后端 deriveOrder 一并返回总量，详情页的「已发 N / M 件」直接用它，不再自己求和
  shippedQtyTotal?: number;
  qtyTotal?: number;
  isOverdue: boolean;
  overdueDays: number;
  docsReady: boolean;
  missingDocs: string[];
  nextAction: string;
  daysToShip: number | null;
}

interface OrdRow {
  id: string;
  /** CRM 系统编号，自动生成，只用于系统内定位。 */
  orderNo: string;
  /** 公司自己的订单号，业务员手工补录；可为空。 */
  companyOrderNo: string;
  dealId: string;
  customerId: string;
  customerName: string;
  ownerName?: string;
  dealTitle?: string;
  status: OrdStatus;
  currency: string;
  amount: number;
  incoterm: string;
  paymentTerm: string;
  portLoading: string;
  portDischarge: string;
  buyerPoNo: string;
  productionRequired: boolean;
  expectedShipAt: string;
  confirmedAt: string;
  shippedAt: string;
  deliveredAt: string;
  completedAt: string;
  cancelledAt: string;
  cancelReason: string;
  erpOrderNo: string;
  erpSyncStatus: string;
  source: "deal_auto" | "manual" | "backfill";
  ownerId: string;
  remark: string;
  createdAt: string;
  updatedAt: string;
  items: OrdItem[];
  derived: OrdDerived;
}

export interface OrdListResponse {
  orders: OrdRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: {
    all: number;
    pending: number;
    active: number;
    shipped: number;
    delivered: number;
    completed: number;
    cancelled: number;
    overdue: number;
  };
  missingOrders: Array<{
    dealId: string;
    title: string;
    customerName: string;
    amount: number;
    currency: string;
    closedAt: string;
  }>;
  missingOrderTotal: number;
}

interface OrdSummary {
  activeOrders: number;
  activeAmountByCurrency: Record<string, number>;
  overdueOrders: number;
  pendingConfirm: number;
  awaitingShipment: number;
  awaitingDelivery: number;
  completedThisMonth: number;
  wonThisMonth: number;
  wonThisMonthByCurrency: Record<string, number>;
}

interface OrdDetailResponse {
  order: OrdRow;
  items: OrdItem[];
  events: Array<{
    id: string;
    type: string;
    fromStatus?: OrdStatus;
    toStatus?: OrdStatus;
    content: string;
    operatorId: string;
    createdAt: string;
  }>;
  files: Array<{
    id: string;
    assetId: string;
    /** 新上传的真文件才有；有它就说明这份文件走的是 /api/files 而不是外链 */
    fileId?: string;
    kind: string;
    note: string;
    createdAt: string;
    assetName: string;
    assetMissing: boolean;
    assetRestricted: boolean;
    sourceUrl: string;
    fileType: string;
    shareCode?: string;
    sourceType?: string;
    assetCategory?: string;
    assetStatus?: string;
    createdByName?: string;
    size?: number;
    mime?: string;
    previewable?: boolean;
    deriveStatus?: "none" | "processing" | "ready" | "failed";
    deriveError?: string;
  }>;
  shipments: Array<{
    id: string;
    shipmentNo: string;
    courier: string;
    trackingCode: string;
    status: string;
    shippedAt: string;
    items: Array<{ productName: string; quantity: number }>;
  }>;
  documents: Array<{
    id: string;
    type: string;
    number: string;
    title: string;
    status: string;
    issueDate: string;
  }>;
  derived: OrdDerived;
  permissions: { manage: boolean; override: boolean };
}

export const ORD_STATUS_META: Record<OrdStatus, { label: string; tone: string }> = {
  pending: { label: "待确认", tone: "t-warn" },
  confirmed: { label: "已确认", tone: "t-info" },
  in_production: { label: "生产中", tone: "t-info" },
  ready_to_ship: { label: "待发货", tone: "t-warn" },
  // 「已发货」是进行中的正常态，原来给 t-accent（玫红）会被读成故障；
  // 玫红只留给「逾期」——全表唯一的红色警报。
  shipped: { label: "已发货", tone: "t-info" },
  delivered: { label: "已签收", tone: "t-ok" },
  completed: { label: "已完成", tone: "t-done" },
  cancelled: { label: "已取消", tone: "t-muted" }
};

const ORD_FLOW: OrdStatus[] = ["pending", "confirmed", "in_production", "ready_to_ship", "shipped", "delivered", "completed"];

const ORD_SOURCE_LABEL: Record<string, string> = {
  deal_auto: "商机成交自动生成",
  manual: "手工建单",
  backfill: "历史补建"
};

/**
 * 订单有两个号，界面上必须分清：
 * - `orderNo`：CRM 自动生成的系统编号（GJ-SO-YYMM-NNNN），只用于系统内定位；
 * - `companyOrderNo`：公司自己对外用的订单号（合同号/生产单号一类），业务员补录，可为空。
 * 一律以公司单号作主标识；没填时退回系统编号，并在副行说明「待补」——
 * 不能像以前那样把系统编号当公司单号展示，那会让人以为单号已经有了。
 */
export function ordIdentity(order: { orderNo: string; companyOrderNo?: string }) {
  const company = String(order.companyOrderNo || "").trim();
  return {
    primary: company || order.orderNo,
    company,
    system: order.orderNo,
    missing: !company
  };
}

/** 订单文件分类是受控枚举（后端 zod 校验），中文文案只在前端映射一次。 */
const ORD_FILE_KIND_LABEL: Record<string, string> = {
  contract: "合同",
  pi: "PI",
  ci: "CI",
  pl: "PL",
  inspection: "验货",
  other: "其他"
};
const ORD_FILE_KIND_ORDER = ["contract", "pi", "ci", "pl", "inspection", "other"];

/** 单据状态是后端枚举，界面上直接写 ready / draft 等于没翻译。 */
const ORD_DOC_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  ready: "已就绪",
  issued: "已开具",
  sent: "已发送客户",
  archived: "已归档",
  void: "已作废",
  cancelled: "已作废"
};
/** 草稿与作废不该显示成绿色「已完成」的样子，只有真正可用的单据才是绿的。 */
function ordDocStatusView(status?: string) {
  const key = String(status || "").trim();
  const label = ORD_DOC_STATUS_LABEL[key.toLowerCase()] || key || "已创建";
  const muted = ["draft", "void", "cancelled"].includes(key.toLowerCase());
  return { label, cls: muted ? "od-faint" : "od-state-ok" };
}

/** 订单里的文件来源：三者打开方式不同，不能都只说「打开」 */
function ordFileSourceText(sourceType?: string) {
  if (sourceType === "baidu_share") return "网盘";
  if (sourceType === "external_url") return "外链";
  if (sourceType === "upload") return "已上传";
  return "";
}

export function ordFileSize(bytes?: number) {
  const value = Number(bytes || 0);
  if (!value) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** 文件类型徽章只给 3~4 个字符，够认就行：ARCH/OTHE 这种缩写没有任何含义 */
function ordAssetTypeBadge(asset: { fileType?: string; sourceType?: string }) {
  if (asset.sourceType === "baidu_share") return "网盘";
  const codes: Record<string, string> = {
    pdf: "PDF", word: "DOC", excel: "XLS", image: "IMG",
    video: "VID", archive: "ZIP", link: "URL"
  };
  // 文件中心里多数资料只登记了链接，fileType 是空的：这时标「网盘/外链/链接」，
  // 比三行都写 FILE 有用 —— 它解释的是点「打开」会发生什么。
  if (asset.fileType && codes[asset.fileType]) return codes[asset.fileType];
  if (asset.sourceType === "external_url") return "外链";
  // legacy = 只登记了标题、还没填链接。徽章直接说清楚，免得行里写「链接」、打开却是死路。
  return "无链接";
}

/**
 * 按资料标题/类目/标签猜「这份资料是订单里的哪类文件」。
 * 关联时默认走它：外贸单里 90% 的资料标题就写着 PI/CI/PL/合同，让用户逐份去选下拉没意义。
 */
function ordInferFileKind(asset: { title?: string; category?: string; tags?: string[] }) {
  const text = [asset.title || "", asset.category || "", ...(asset.tags || [])].join(" ").toLowerCase();
  if (/(^|[^a-z])pi([^a-z]|$)|proforma|形式发票/.test(text)) return "pi";
  if (/(^|[^a-z])ci([^a-z]|$)|commercial invoice|商业发票/.test(text)) return "ci";
  if (/(^|[^a-z])pl([^a-z]|$)|packing list|装箱单/.test(text)) return "pl";
  if (/验货|inspection|inspect/.test(text)) return "inspection";
  if (/合同|contract|agreement|协议/.test(text)) return "contract";
  return "other";
}

const ORD_PAGE_SIZE = 20;
let ordFilter = { status: "all", q: "", page: 1 };
/** 请求序号：快速切 chips 时只认最后一次响应，避免旧结果盖掉新筛选。 */
let ordReqSeq = 0;
let ordSearchTimer: number | undefined;

function ordMoney(amount: number, currency: string, digits = 2) {
  const value = Number(amount) || 0;
  return `${currency || "USD"} ${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}`;
}

function ordMoneyText(map: Record<string, number> | undefined, digits = 0) {
  const entries = Object.entries(map || {}).filter(([, value]) => Number(value) > 0);
  if (!entries.length) return "—";
  return entries.map(([currency, value]) => ordMoney(value, currency, digits)).join(" · ");
}

export function ordDay(value?: string) {
  return value ? String(value).slice(0, 10) : "—";
}

export function ordBadge(status: OrdStatus) {
  const meta = ORD_STATUS_META[status];
  return `<span class="ord-badge ${meta.tone}">${meta.label}</span>`;
}

function ordInitial(name: string) {
  return (name || "?").trim().slice(0, 1).toUpperCase();
}

function ordChip(key: string, label: string, count: number, alert = false) {
  return `<button type="button" class="ord-chip${ordFilter.status === key ? " active" : ""}${alert ? " is-alert" : ""}" data-ord-chip="${key}">${label}<em>${count}</em></button>`;
}

function renderOrdKpis(summary: OrdSummary | null) {
  const host = qs<HTMLElement>("#ordKpis");
  if (!host) return;
  const data = summary || {
    activeOrders: 0,
    activeAmountByCurrency: {},
    overdueOrders: 0,
    pendingConfirm: 0,
    awaitingShipment: 0,
    awaitingDelivery: 0,
    completedThisMonth: 0,
    wonThisMonth: 0,
    wonThisMonthByCurrency: {}
  };
  // 逾期卡的副文案原本是「1 单等待发货」，和上面那个 1 重复；改成占执行中的比例，才是新信息。
  const overdueRatio = data.overdueOrders && data.activeOrders
    ? `占执行中 ${Math.round((data.overdueOrders / data.activeOrders) * 100)}%`
    : data.overdueOrders ? "需优先处理" : "全部按期";
  host.innerHTML = `
    <div class="ord-kpi">
      <div class="ord-kpi-label">执行中订单</div>
      <div class="ord-kpi-row">
        <div class="ord-kpi-value">${data.activeOrders}</div>
        <div class="ord-kpi-sub">${ordMoneyText(data.activeAmountByCurrency)}</div>
      </div>
    </div>
    <div class="ord-kpi ${data.overdueOrders ? "is-alert" : ""}">
      <div class="ord-kpi-label">逾期未发</div>
      <div class="ord-kpi-row">
        <div class="ord-kpi-value">${data.overdueOrders}</div>
        <div class="ord-kpi-sub">${overdueRatio}</div>
      </div>
    </div>
    <div class="ord-kpi ${data.pendingConfirm ? "is-amber" : ""}">
      <div class="ord-kpi-label">待确认条款</div>
      <div class="ord-kpi-row">
        <div class="ord-kpi-value">${data.pendingConfirm}</div>
        <div class="ord-kpi-sub">${data.pendingConfirm ? "补全 Incoterm / 付款条件" : "条款齐备"}</div>
      </div>
    </div>
    <div class="ord-kpi">
      <div class="ord-kpi-label">本月成交</div>
      <div class="ord-kpi-row">
        <div class="ord-kpi-value">${data.wonThisMonth}</div>
        <div class="ord-kpi-sub">${ordMoneyText(data.wonThisMonthByCurrency)}</div>
      </div>
    </div>`;
}

function renderOrdBanner(data: OrdListResponse) {
  const banner = qs<HTMLElement>("#ordBanner");
  if (!banner) return;
  if (!data.missingOrderTotal) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <span>有 <strong>${data.missingOrderTotal}</strong> 笔已成交商机还没有订单（成交已记录，补建不会修改商机阶段）。</span>
    <button type="button" class="ord-btn" data-ord-backfill>补建订单</button>`;
}

function renderOrdTable(data: OrdListResponse | null, error?: string) {
  const wrap = qs<HTMLElement>("#ordTableWrap");
  if (!wrap) return;
  if (error) {
    wrap.innerHTML = `<div class="ord-empty"><h3>订单加载失败</h3><p>${escapeHtml(error)}</p><button class="ord-btn" data-ord-reload>重试</button></div>`;
    qs<HTMLElement>("[data-ord-reload]")?.addEventListener("click", () => void loadOrders());
    return;
  }
  if (!data) {
    wrap.innerHTML = `<div class="ord-skeleton">${Array.from({ length: 6 }, () => "<span></span>").join("")}</div>`;
    return;
  }
  if (!data.orders.length) {
    wrap.innerHTML = `<div class="ord-empty">
      <h3>${ordFilter.q || ordFilter.status !== "all" ? "没有符合条件的订单" : "还没有订单"}</h3>
      <p>${ordFilter.q || ordFilter.status !== "all" ? "换个筛选条件，或清空搜索词。" : "商机成交后会自动生成订单；也可以手工建单先跑起来。"}</p>
      <button type="button" class="ord-btn primary" data-ord-new>＋ 手工建单</button>
    </div>`;
    qs<HTMLElement>("[data-ord-new]")?.addEventListener("click", () => void ordOpenCreateModal());
    return;
  }
  const totalPages = Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize)));
  wrap.innerHTML = `
    <table class="ord-table">
      <thead>
        <tr>
          <th>单号</th>
          <th>客户</th>
          <th>金额</th>
          <th>履约进度</th>
          <th>状态</th>
          <th>预计发货</th>
          <th>负责人</th>
          <th>下一步</th>
        </tr>
      </thead>
      <tbody>
        ${data.orders.map((order) => {
          // 取消/完成的单，后端 nextAction 会回吐状态名（「已取消」「已归档」），和状态列重复，
          // 而且「已取消」不是下一步动作；这种时候显示破折号更诚实。
          const statusLabel = ORD_STATUS_META[order.status].label || "";
          const nextAction = order.derived.nextAction && order.derived.nextAction !== statusLabel
            ? order.derived.nextAction
            : "—";
          const ident = ordIdentity(order);
          return `
          <tr class="ord-row${order.derived.isOverdue ? " is-overdue" : ""}" data-ord-open="${order.id}" tabindex="0" aria-label="打开订单 ${escapeHtml(ident.primary)}，客户 ${escapeHtml(order.customerName || "未知")}" title="打开详情（回车键）">
            <td>
              <div class="ord-no">${escapeHtml(ident.primary)}</div>
              <div class="ord-src${ident.missing ? " is-miss" : ""}" title="${escapeHtml(ORD_SOURCE_LABEL[order.source] || "订单")}">${ident.missing ? "系统号 · 待补公司单号" : `系统 ${escapeHtml(ident.system)}`}</div>
            </td>
            <td title="${escapeHtml(order.customerName || "")}"><div class="ord-customer">${escapeHtml(order.customerName || "—")}</div>
              ${order.buyerPoNo ? `<div class="ord-src">PO ${escapeHtml(order.buyerPoNo)}</div>` : ""}
            </td>
            <td><div class="ord-amount">${ordMoney(order.amount, order.currency)}</div></td>
            <td>
              ${order.derived.shippingProgress > 0
                ? `<div class="ord-progress">
                    <div class="ord-progress-track"><span class="${order.derived.shippingProgress >= 1 ? "is-full" : ""}" style="width:${Math.round(order.derived.shippingProgress * 100)}%"></span></div>
                    <em>${Math.round(order.derived.shippingProgress * 100)}%</em>
                  </div>`
                : `<div class="ord-progress is-empty">—</div>`}
            </td>
            <td>${ordBadge(order.status)}</td>
            <td>
              <div class="ord-date${order.derived.isOverdue ? " is-overdue" : ""}">
                ${ordDay(order.expectedShipAt)}
                ${order.derived.isOverdue ? `<small>逾期 ${order.derived.overdueDays} 天</small>` : ""}
              </div>
            </td>
            <td><div class="ord-owner"><span class="ord-avatar">${escapeHtml(ordInitial(order.ownerName || order.ownerId))}</span>${escapeHtml(order.ownerName || "—")}</div></td>
            <td class="ord-next" title="${escapeHtml(nextAction)}">${escapeHtml(nextAction)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    <div class="ord-pager">
      <span class="ord-pager-total">共 <b>${data.total}</b> 单${data.total > data.orders.length ? `，本页 ${data.orders.length} 单` : ""}</span>
      ${totalPages > 1 ? `<span class="ord-pager-nav">
        <button type="button" class="ord-page-btn" data-ord-page="prev" ${data.page <= 1 ? "disabled" : ""}>上一页</button>
        <span class="ord-page-now">${data.page} / ${totalPages}</span>
        <button type="button" class="ord-page-btn" data-ord-page="next" ${data.page >= totalPages ? "disabled" : ""}>下一页</button>
      </span>` : ""}
    </div>`;
}

export async function loadOrders() {
  const seq = ++ordReqSeq;
  renderOrdTable(null);
  try {
    const params = new URLSearchParams({
      status: ordFilter.status,
      q: ordFilter.q,
      page: String(ordFilter.page),
      pageSize: String(ORD_PAGE_SIZE)
    });
    const [list, summary] = await Promise.all([
      api<OrdListResponse>(`/api/orders?${params.toString()}`),
      api<OrdSummary>("/api/orders/summary").catch(() => null)
    ]);
    // 慢请求先发后到：只让最后一次点击的结果上屏
    if (seq !== ordReqSeq) return;
    // 删单 / 缩小筛选后页码可能越界，回到最后一页而不是显示空列表
    const totalPages = Math.max(1, Math.ceil(list.total / Math.max(1, list.pageSize)));
    if (ordFilter.page > totalPages) {
      ordFilter.page = totalPages;
      void loadOrders();
      return;
    }
    renderOrdKpis(summary);
    const chips = qs<HTMLElement>("#ordChips");
    if (chips) {
      chips.innerHTML = [
        ordChip("all", "全部", list.counts.all),
        ordChip("pending", "待确认", list.counts.pending),
        ordChip("active", "执行中", list.counts.active),
        ordChip("shipped", "已发货", list.counts.shipped),
        ordChip("delivered", "已签收", list.counts.delivered),
        ordChip("completed", "已完成", list.counts.completed),
        ordChip("overdue", "逾期", list.counts.overdue, true),
        ordChip("cancelled", "已取消", list.counts.cancelled)
      ].join("");
    }
    renderOrdBanner(list);
    renderOrdTable(list);
  } catch (error) {
    if (seq !== ordReqSeq) return;
    renderOrdTable(null, error instanceof Error ? error.message : "订单加载失败");
  }
}

export function ordWireList() {
  const root = qs<HTMLElement>("#orders");
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const chip = target.closest<HTMLElement>("[data-ord-chip]");
    if (chip) {
      ordFilter.status = chip.dataset.ordChip || "all";
      ordFilter.page = 1;
      void loadOrders();
      return;
    }
    const pageBtn = target.closest<HTMLElement>("[data-ord-page]");
    if (pageBtn) {
      const step = pageBtn.dataset.ordPage === "next" ? 1 : -1;
      ordFilter.page = Math.max(1, ordFilter.page + step);
      void loadOrders();
      return;
    }
    const row = target.closest<HTMLElement>("[data-ord-open]");
    if (row) {
      void openOrderDetail(row.dataset.ordOpen || "");
      return;
    }
    if (target.closest("[data-ord-backfill]")) {
      void ordBackfill();
      return;
    }
    if (target.closest("[data-ord-new]") || target.closest("#ordNewBtn")) {
      void ordOpenCreateModal();
      return;
    }
  });
  qs<HTMLElement>("#ordNewBtn")?.addEventListener("click", () => void ordOpenCreateModal());
  qs<HTMLElement>("#ordBackfillBtn")?.addEventListener("click", () => void ordBackfill());
  // 行是可聚焦的，键盘用户按回车/空格也能进详情
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-ord-open]");
    if (!row) return;
    event.preventDefault();
    void openOrderDetail(row.dataset.ordOpen || "");
  });
  qs<HTMLElement>("#ordSearch")?.addEventListener("input", (event) => {
    const value = (event.target as HTMLInputElement).value.trim();
    window.clearTimeout(ordSearchTimer);
    ordSearchTimer = window.setTimeout(() => {
      ordFilter.q = value;
      ordFilter.page = 1;
      void loadOrders();
    }, 280);
  });
}

export async function openOrderDetail(orderId: string) {
  if (!orderId) return;
  const host = qs<HTMLElement>("#order-detail");
  if (!host) return;
  // 换一张单才回到「概览」；同一张单改完状态重渲染后仍停在原页签，否则每次都被弹回概览
  if (ordDetailTabOrderId !== orderId) {
    ordDetailTab = "ov";
    ordDetailTabOrderId = orderId;
  }
  host.dataset.orderId = orderId;
  host.innerHTML = `<div class="od-body"><div class="ord-skeleton">${Array.from({ length: 5 }, () => "<span></span>").join("")}</div></div>`;
  activateNavView("order-detail");
  window.scrollTo({ top: 0, behavior: "auto" });
  try {
    const detail = await api<OrdDetailResponse>(`/api/orders/${orderId}`);
    host.dataset.status = detail.order.status;
    renderOrderDetail(detail, host);
  } catch (error) {
    host.innerHTML = `<div class="od-body"><div class="ord-empty"><h3>订单打不开</h3><p>${escapeHtml(error instanceof Error ? error.message : "订单加载失败")}</p><button class="ord-btn" data-ord-back>返回订单列表</button></div></div>`;
    qs<HTMLElement>("[data-ord-back]")?.addEventListener("click", () => activateNavView("orders"));
  }
}

function ordRail(order: OrdRow) {
  if (order.status === "cancelled") {
    return `<div class="od-cancelled-note">订单已取消：${escapeHtml(order.cancelReason || "未填写原因")} · ${ordDay(order.cancelledAt)}</div>`;
  }
  const currentIndex = ORD_FLOW.indexOf(order.status);
  const timestamps: Partial<Record<OrdStatus, string>> = {
    pending: order.createdAt,
    confirmed: order.confirmedAt,
    ready_to_ship: order.confirmedAt,
    shipped: order.shippedAt,
    delivered: order.deliveredAt,
    completed: order.completedAt
  };
  return `<div class="od-flow">${ORD_FLOW.map((status, index) => {
    const done = currentIndex >= 0 && index < currentIndex;
    const current = index === currentIndex;
    const stamp = timestamps[status];
    // 「生产中」这一步没有独立时间戳字段。只有在确定不需要生产时才能说「跳过」，
    // 否则乱写会把需要生产的单也说成跳过；其余缺时间戳的情况保持空白。
    const skipped = status === "in_production" && order.productionRequired === false;
    const showSkipped = skipped && (done || current);
    // 未走到的步骤原来逐格写「—」，一排破折号只是噪声；留空反而让有日期的那几步更醒目。
    const time = showSkipped ? "跳过" : stamp ? ordDay(stamp) : "";
    return `<div class="od-step${done ? " done" : ""}${current ? " current" : ""}${showSkipped ? " is-skipped" : ""}">
      <div class="od-step-label">${ORD_STATUS_META[status].label}</div>
      <div class="od-step-time">${time}</div>
    </div>`;
  }).join("")}</div>`;
}

type OrdTabKey = "ov" | "items" | "docs" | "ship" | "files" | "logs";

const ORD_TAB_LABEL: Record<OrdTabKey, string> = {
  ov: "概览",
  items: "商品明细",
  docs: "单证",
  ship: "发货",
  files: "文件",
  logs: "操作记录"
};

/**
 * 当前页签记在模块级：改完状态/条款会整页重渲染，如果每次都退回「概览」，
 * 用户会以为自己点错了地方。换一张单才重置。
 */
let ordDetailTab: OrdTabKey = "ov";
let ordDetailTabOrderId = "";

function ordShowTab(host: HTMLElement, tab: OrdTabKey) {
  ordDetailTab = tab;
  qsa<HTMLElement>("[data-od-tab]", host).forEach((node) => {
    const on = node.dataset.odTab === tab;
    node.classList.toggle("is-on", on);
    node.setAttribute("aria-selected", on ? "true" : "false");
  });
  qsa<HTMLElement>("[data-od-page]", host).forEach((node) => {
    node.classList.toggle("is-on", node.dataset.odPage === tab);
  });
}

/** 页头只放次级动作。主动作永远只有一个，在「下一步」里。 */
function ordStatusActions(order: OrdRow) {
  if (order.status === "completed" || order.status === "cancelled") {
    return `<button type="button" class="ord-btn" data-ord-documents>查看单证</button>`;
  }
  const actions: string[] = [];
  // 发货前都能改条款与明细（后端只锁 shipped 之后）；发货后的更正走状态回退 + 备注。
  if (["pending", "confirmed", "in_production", "ready_to_ship"].includes(order.status)) {
    actions.push(`<button type="button" class="ord-btn" data-ord-edit>编辑订单</button>`);
  }
  // 取消是破坏性动作，永远放最后，避免和主按钮贴在一起误点
  actions.push(`<button type="button" class="ord-btn danger" data-ord-cancel>取消订单</button>`);
  return actions.join("");
}

/** 推动这张单往前走的那一个动作：它只出现在「下一步」里，不在页头重复一遍。 */
function ordPrimaryAction(order: OrdRow, missingDocs: string[]) {
  switch (order.status) {
    case "pending":
      return { label: "确认订单", attr: `data-ord-status="confirmed"` };
    case "confirmed":
      return order.productionRequired
        ? { label: "开始生产", attr: `data-ord-status="in_production"` }
        : { label: "转待发货", attr: `data-ord-status="ready_to_ship"` };
    case "in_production":
      return { label: "转待发货", attr: `data-ord-status="ready_to_ship"` };
    case "ready_to_ship":
      return { label: "建发货单", attr: "data-ord-ship" };
    case "shipped":
      return { label: "登记签收", attr: `data-ord-status="delivered"` };
    case "delivered":
      return { label: `完成订单${missingDocs.length ? "（需豁免）" : ""}`, attr: `data-ord-status="completed"` };
    default:
      return null;
  }
}

function renderOrderDetail(detail: OrdDetailResponse, host: HTMLElement) {
  // 详情接口把 derived 放在顶层（order 是原始行），合并回来再渲染，避免两处口径。
  const order: OrdRow = { ...detail.order, derived: detail.derived };
  const { items, events, files, shipments, documents, derived, permissions } = detail;
  const docsByType = new Map(documents.map((doc) => [doc.type, doc]));
  const coreDocs = ["PI", "CI", "PL"] as const;
  const readyDocs = coreDocs.filter((type) => docsByType.has(type));
  const missingCore = coreDocs.filter((type) => !docsByType.has(type));
  const extraDocs = documents.filter((doc) => !coreDocs.includes(doc.type as (typeof coreDocs)[number]));
  const shipPct = Math.round(derived.shippingProgress * 100);
  const qtyTotal = derived.qtyTotal ?? items.reduce((sum, item) => sum + item.qty, 0);
  const shippedQtyTotal = derived.shippedQtyTotal ?? items.reduce((sum, item) => sum + item.shippedQty, 0);
  const locked = order.status === "completed" || order.status === "cancelled";
  // 空态文案必须和当前状态说得通：已取消的单提示「进入待发货后建单」是错误引导。
  const shipEmptyCopy = order.status === "cancelled"
    ? "订单已取消，不再建发货单。"
    : order.status === "ready_to_ship"
      ? "货备好后点「建发货单」，填运单号与数量，发出后自动回写履约进度。"
      : "订单进入「待发货」后才能建发货单。";
  const amountText = order.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const updatedText = order.updatedAt
    ? `${ordDay(order.updatedAt)} ${String(order.updatedAt).slice(11, 16)}`
    : "—";
  const shippedAlready = order.status === "shipped" || order.status === "delivered";

  /** 「卡在哪」只列真正卡住的事，每条给一个出口（跳到对应页签 / 打开编辑）。 */
  const blockers: Array<{ text: string; tone?: "alert"; goto?: OrdTabKey; edit?: boolean }> = [];
  if (derived.isOverdue && !shippedAlready && !locked) {
    blockers.push({ text: `已逾期 ${derived.overdueDays} 天`, tone: "alert", edit: true });
  }
  const missingTerms = [!order.incoterm && "Incoterm", !order.paymentTerm && "付款条件"].filter(Boolean) as string[];
  if (missingTerms.length && !locked) {
    blockers.push({ text: `条款缺 ${missingTerms.join(" / ")}`, edit: true });
  }
  if (!derived.docsReady && !locked) {
    blockers.push({ text: `单证缺 ${derived.missingDocs.join(" / ")}`, goto: "docs" });
  }
  if (!files.length) {
    blockers.push({ text: "还没挂任何文件", goto: "files" });
  }
  if (order.status === "ready_to_ship" && !shipments.length) {
    blockers.push({ text: "待建发货单", goto: "ship" });
  }
  const blockersHtml = blockers.map((item) => {
    const attr = item.edit ? "data-ord-edit" : `data-od-goto="${item.goto}"`;
    return `<button type="button" class="od-blocker${item.tone === "alert" ? " is-alert" : ""}" ${attr}>${escapeHtml(item.text)}</button>`;
  }).join("");

  const primary = ordPrimaryAction(order, derived.missingDocs);
  const focusTone = blockers.some((item) => item.tone === "alert")
    ? " is-alert"
    : locked || (!primary && !blockers.length)
      ? " is-done"
      : "";
  const focusTitle = order.status === "completed"
    ? `订单已完成归档 · ${ordDay(order.completedAt)}`
    : order.status === "cancelled"
      ? `订单已取消：${order.cancelReason || "未填写原因"}`
      : derived.nextAction;
  const focusOps = [
    primary ? `<button type="button" class="ord-btn primary" ${primary.attr}>${escapeHtml(primary.label)}</button>` : "",
    shipments.length && !locked ? `<button type="button" class="od-link" data-od-goto="ship">查看发货 →</button>` : ""
  ].filter(Boolean).join("");

  /* ---------- 各页签内容 ---------- */
  const eventTitle = (event: OrdDetailResponse["events"][number]) => event.type === "status"
    ? `${ORD_STATUS_META[event.fromStatus || "pending"].label} → ${ORD_STATUS_META[event.toStatus || "pending"].label}`
    : event.type === "created" ? "订单创建"
      : event.type === "shipment" ? "发货同步"
        : event.type === "file" ? "文件"
          // 单号变更写的是 note 事件（后端没有单独的事件类型），标题就要单独认出来，
          // 否则时间轴上只显示「备注」，看不出这行改的是单号。
          : /^(公司单号|客户 PO|ERP 单号)\s/u.test(String(event.content || "")) ? "更新单号" : "备注";
  /** 标题已经说清楚的事，正文里不再重复一遍。 */
  const eventDetail = (event: OrdDetailResponse["events"][number], title: string) => {
    const content = String(event.content || "").trim();
    if (!content || content === title) return "";
    return content;
  };

  const feedHtml = events.length
    ? `<div class="od-feed">${events.slice(0, 4).map((event) => {
      const title = eventTitle(event);
      const content = eventDetail(event, title);
      return `<div class="od-feed-item${event.type === "status" || event.type === "created" ? " is-key" : ""}">
          <span class="od-feed-dot"></span>
          <div>
            <div class="od-feed-t">${escapeHtml(title)}</div>
            <div class="od-feed-m">${escapeHtml(`${ordDay(event.createdAt)} ${String(event.createdAt).slice(11, 16)}`)}${content && content !== title ? ` · ${escapeHtml(content)}` : ""}</div>
          </div>
        </div>`;
    }).join("")}</div>`
    : `<div class="od-feed-empty">还没有事件记录</div>`;

  const termRow = (label: string, value: string, emptyHint = "待补全") =>
    `<div class="od-term"><span class="k">${escapeHtml(label)}</span><span class="v${value ? "" : " is-empty"}"${value ? ` title="${escapeHtml(value)}"` : ""}>${escapeHtml(value || emptyHint)}</span></div>`;
  const termsHtml = [
    termRow("Incoterm", order.incoterm || ""),
    termRow("付款条件", order.paymentTerm || ""),
    termRow("客户 PO", order.buyerPoNo || "", "—"),
    termRow("ERP 单号", order.erpOrderNo || "", "—"),
    termRow("装运港", order.portLoading || "", "—"),
    termRow("目的港", order.portDischarge || "", "—"),
    termRow("预计发运", order.expectedShipAt ? ordDay(order.expectedShipAt) : "", "未设置")
  ].join("");

  const itemsTable = items.length
    ? `<table class="od-table is-items">
        <thead><tr><th>品项</th><th class="od-num">数量</th><th class="od-num">已发</th><th class="od-num">单价</th><th class="od-num">金额</th></tr></thead>
        <tbody>${items.map((item) => {
      const percent = item.qty > 0 ? Math.min(100, Math.round((item.shippedQty / item.qty) * 100)) : 0;
      return `<tr>
            <td><div class="od-cell-main">${escapeHtml(item.product)}</div>${item.spec ? `<div class="od-cell-sub">${escapeHtml(item.spec)}</div>` : ""}</td>
            <td class="od-num">${item.qty}${item.unit ? ` ${escapeHtml(item.unit)}` : ""}</td>
            <td class="od-num"><span class="od-ship-qty${percent >= 100 ? " is-full" : ""}">${item.shippedQty}<i>/${item.qty}</i></span></td>
            <td class="od-num">${item.unitPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
            <td class="od-num">${item.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>`;
    }).join("")}</tbody>
      </table>
      <div class="od-items-total"><span>订单合计 · ${escapeHtml(order.currency)}</span><b>${amountText}</b></div>`
    : `<div class="od-blank"><h3>还没有商品明细</h3><p>成交时应当带过来；如果这张单是手工建的，用「编辑订单」补上品项与数量。</p></div>`;

  const docLabel: Record<string, string> = { PI: "形式发票", CI: "商业发票", PL: "装箱单" };
  const docPurpose: Record<string, string> = { PI: "客户预付 / 开证", CI: "随货报关", PL: "箱数 / 毛净重，报关必需" };
  const docTableRow = (type: string) => {
    const doc = docsByType.get(type);
    const label = docLabel[type] || type;
    const purpose = docPurpose[type] || "本单附随单据";
    if (!doc) {
      return `<tr>
          <td><span class="od-doc-kind is-miss">${escapeHtml(type)}</span></td>
          <td><div class="od-cell-main">${escapeHtml(label)}</div><div class="od-cell-sub">${escapeHtml(purpose)}</div></td>
          <td class="od-faint">未创建</td>
          <td class="od-faint">—</td>
          <td><span class="od-state-miss">缺失</span></td>
          <td>${locked ? "" : `<div class="od-row-ops"><button type="button" class="ord-btn is-sm" data-ord-documents>创建</button></div>`}</td>
        </tr>`;
    }
    const docStatus = ordDocStatusView(doc.status);
    return `<tr>
        <td><span class="od-doc-kind">${escapeHtml(type)}</span></td>
        <td><div class="od-cell-main">${escapeHtml(label)}</div><div class="od-cell-sub">${escapeHtml(purpose)}</div></td>
        <td>${escapeHtml(doc.number || doc.title || "—")}</td>
        <td>${ordDay(doc.issueDate)}</td>
        <td><span class="${docStatus.cls}">${escapeHtml(docStatus.label)}</span></td>
        <td><div class="od-row-ops"><button type="button" class="ord-btn is-sm" data-ord-documents>查看</button></div></td>
      </tr>`;
  };
  const extraDocRow = (doc: OrdDetailResponse["documents"][number]) => {
    const docStatus = ordDocStatusView(doc.status);
    return `<tr>
      <td><span class="od-doc-kind">${escapeHtml(doc.type)}</span></td>
      <td><div class="od-cell-main">${escapeHtml(doc.title || doc.type)}</div><div class="od-cell-sub">本单附随单据</div></td>
      <td>${escapeHtml(doc.number || "—")}</td>
      <td>${ordDay(doc.issueDate)}</td>
      <td><span class="${docStatus.cls}">${escapeHtml(docStatus.label)}</span></td>
      <td><div class="od-row-ops"><button type="button" class="ord-btn is-sm" data-ord-documents>查看</button></div></td>
    </tr>`;
  };

  const docsTable = `<table class="od-table is-docs">
      <thead><tr><th>类型</th><th>单据</th><th class="od-num">编号</th><th class="od-num">日期</th><th>状态</th><th></th></tr></thead>
      <tbody>
        ${coreDocs.map(docTableRow).join("")}
        ${extraDocs.map(extraDocRow).join("")}
      </tbody>
    </table>`;

  const shipHtml = shipments.length
    ? shipments.map((shipment) => {
      const shippedItems = shipment.items || [];
      return `<div class="od-ship">
          <div class="od-ship-head">
            <div>
              <div class="od-ship-no">${escapeHtml(shipment.shipmentNo || shipment.trackingCode || "未填单号")}</div>
              <div class="od-ship-meta">${[shipment.courier, shipment.trackingCode, shipment.shippedAt ? ordDay(shipment.shippedAt) : ""].filter(Boolean).map(escapeHtml).join(" · ") || "物流信息待补"}</div>
            </div>
            <span class="od-pill${shipment.status === "delivered" || shipment.status === "signed" ? " is-ok" : shipment.status === "draft" ? " is-off" : ""}">${escapeHtml(SHIPMENT_STATUS_LABEL[shipment.status] || shipment.status || "—")}</span>
          </div>
          <div class="od-ship-cells">
            <div class="od-ship-cell"><div class="k">已发总量</div><div class="v">${shippedQtyTotal} / ${qtyTotal} 件</div></div>
            <div class="od-ship-cell"><div class="k">承运商</div><div class="v">${escapeHtml(shipment.courier || "—")}</div></div>
            <div class="od-ship-cell"><div class="k">运单号</div><div class="v">${escapeHtml(shipment.trackingCode || "—")}</div></div>
            <div class="od-ship-cell"><div class="k">发出日期</div><div class="v">${ordDay(shipment.shippedAt)}</div></div>
          </div>
          ${shippedItems.length ? `<div class="od-ship-items">${shippedItems.map((item) => `<div class="od-ship-item"><b>${escapeHtml(item.productName || "—")}</b><span>${item.quantity} 件</span></div>`).join("")}</div>` : ""}
        </div>`;
    }).join("")
    : `<div class="od-blank">
        <h3>还没有发货单</h3>
        <p>${escapeHtml(shipEmptyCopy)}</p>
        ${order.status === "ready_to_ship" ? `<button type="button" class="ord-btn primary" data-ord-ship>＋ 新建发货单</button>` : ""}
      </div>`;

  const fileRow = (file: OrdDetailResponse["files"][number]) => {
    const canOpen = file.fileId && file.previewable;
    const name = file.assetMissing ? "文件已删除" : file.assetRestricted ? "无权查看" : file.assetName;
    const meta = [
      file.fileType && file.fileType !== "other" ? knowledgeAssetTypeText(file.fileType) : "",
      ordFileSourceText(file.sourceType),
      // 没有链接的「外链资料」点「打开」是死路：先说明它缺什么，就不给这个按钮。
      file.fileId || file.sourceUrl ? "" : "待补链接",
      // Office/HEIC 要转一次才能预览，把状态说清楚，别让用户点了预览干等
      file.deriveStatus === "processing" ? "转换中" : "",
      file.deriveStatus === "failed" ? "预览需转换" : "",
      file.createdByName ? `由 ${file.createdByName} 关联` : ""
    ].filter(Boolean).map(escapeHtml).join(" · ");
    return `<tr class="${file.assetMissing ? "od-file-broken" : ""}">
        <td><span class="od-file-kind">${escapeHtml(ORD_FILE_KIND_LABEL[file.kind] || "其他")}</span></td>
        <td>
          <div class="od-cell-main">${escapeHtml(name)}</div>
          <div class="od-cell-sub">${meta || "—"}</div>
          ${file.shareCode ? `<span class="od-file-code">提取码 ${escapeHtml(file.shareCode)}</span>` : ""}
        </td>
        <td class="od-num">${escapeHtml(ordFileSize(file.size) || "—")}</td>
        <td>${ordDay(file.createdAt)}</td>
        <td>
          <div class="od-row-ops">
            ${canOpen ? `<button type="button" class="od-link" data-ord-preview="${escapeHtml(file.fileId!)}">预览</button>` : ""}
            ${file.fileId
        ? `<button type="button" class="od-link" data-ord-download="${escapeHtml(file.fileId)}">下载</button>
                 ${permissions.manage ? `<button type="button" class="od-link" data-ord-share="${escapeHtml(file.fileId)}">分享</button>
                 <button type="button" class="od-link" data-ord-versions="${escapeHtml(file.fileId)}">版本</button>` : ""}`
        : (file.assetRestricted || file.assetMissing || !file.sourceUrl ? "" : `<button type="button" class="od-link" data-ord-open-file="${escapeHtml(file.assetId)}" title="${file.shareCode ? "打开链接并自动复制提取码" : "打开文件"}">打开</button>`)}
            ${permissions.manage && !file.assetMissing && !file.assetRestricted
        ? `<button type="button" class="od-link" data-ord-file-kind="${escapeHtml(file.id)}" title="修改分类">改分类</button>` : ""}
            ${permissions.manage ? `<button type="button" class="od-link danger" data-ord-unlink="${escapeHtml(file.id)}">移除</button>` : ""}
          </div>
        </td>
      </tr>`;
  };

  const filesTable = files.length
    ? `<table class="od-table is-files">
        <thead><tr><th>类型</th><th>文件名</th><th class="od-num">大小</th><th class="od-num">关联时间</th><th></th></tr></thead>
        <tbody>${files
      .slice()
      .sort((left, right) => ORD_FILE_KIND_ORDER.indexOf(left.kind) - ORD_FILE_KIND_ORDER.indexOf(right.kind))
      .map(fileRow).join("")}</tbody>
      </table>`
    : `<div class="od-blank"><h3>还没有挂文件</h3><p>合同、PI、CI、PL、验货报告都可以挂在这里：上传新文件，或关联资料维护里已有的资料。</p></div>`;

  let lastLogDay = "";
  const logsHtml = events.length
    ? `<div class="od-logs">${events.map((event) => {
      const day = ordDay(event.createdAt);
      const showDay = day !== lastLogDay;
      lastLogDay = day;
      const title = eventTitle(event);
      const detailText = eventDetail(event, title);
      return `<div class="od-log-row${event.type === "status" || event.type === "created" ? " is-key" : ""}">
          <div class="od-log-day">${showDay ? escapeHtml(day) : ""}</div>
          <div class="od-log-main">
            <span class="od-log-dot"></span>
            <div>
              <div class="od-log-t">${escapeHtml(title)}</div>
              <div class="od-log-m">${escapeHtml(String(event.createdAt).slice(11, 16))}${detailText ? ` · ${escapeHtml(detailText)}` : ""}</div>
            </div>
          </div>
        </div>`;
    }).join("")}</div>`
    : `<div class="od-blank"><h3>还没有操作记录</h3><p>状态变更、文件关联、备注都会按时间记在这里。</p></div>`;

  const noteBox = permissions.manage
    ? `<div class="od-note-box">
        <input id="ordNoteInput" maxlength="500" placeholder="记一条备注，例如「客户确认 11 月 5 日船期」" />
        <button type="button" class="ord-btn is-sm" id="ordNoteBtn">记录</button>
      </div>`
    : "";

  const tabButton = (key: OrdTabKey, count?: string, miss = false) => {
    const on = ordDetailTab === key;
    return `<button type="button" class="od-tab${on ? " is-on" : ""}" role="tab" aria-selected="${on}" data-od-tab="${key}">${ORD_TAB_LABEL[key]}${count ? `<em${miss ? ` class="is-miss"` : ""}>${count}</em>` : ""}</button>`;
  };

  const dealRef = order.dealId
    ? `<button type="button" class="od-link od-src-deal" data-ord-deal="${escapeHtml(order.dealId)}" title="查看来源商机：${escapeHtml(order.dealTitle || "")}">来源商机 · ${escapeHtml(order.dealTitle || "已成交")}</button>`
    : `<span>${escapeHtml(ORD_SOURCE_LABEL[order.source] || "订单")}</span>`;

  const dueTone = derived.isOverdue && !locked && !shippedAlready ? " is-alert" : "";
  const ident = ordIdentity(order);
  const dueSmall = order.status === "completed"
    ? `已于 ${ordDay(order.completedAt)} 完成`
    : order.status === "cancelled"
      ? `已于 ${ordDay(order.cancelledAt)} 取消`
      : shippedAlready
        ? `发运于 ${ordDay(order.shippedAt)}`
        : derived.isOverdue
          ? `逾期 ${derived.overdueDays} 天`
          : derived.daysToShip === null
            ? "补上发运日期可自动预警"
            : derived.daysToShip >= 0
              ? `剩 ${derived.daysToShip} 天`
              : "已过发运日";

  host.innerHTML = `
    <div class="od-page">
      <div class="od-crumbs">
        <button type="button" class="od-crumb-link" data-ord-back>订单履约</button>
        <span class="od-crumb-sep">/</span>
        <b>${escapeHtml(ident.primary)}</b>
      </div>

      <div class="od-head">
        <div>
          <h1>销售订单</h1>
          <p class="od-lead">条款、单证、发货与文件都挂在这张单上。公司单号对外用，系统编号只在系统内定位。</p>
        </div>
        <div class="od-head-actions">${ordStatusActions(order)}</div>
      </div>

      <section class="od-hero">
        <div class="od-hero-main">
          <div>
            <p class="od-kicker">Sales Order</p>
            <div class="od-hero-title">
              <h2>${escapeHtml(ident.primary)}${ident.missing ? `<span class="od-title-tag">系统编号</span>` : ""}</h2>
              ${ordBadge(order.status)}
            </div>
            <div class="od-hero-meta">
              <b>${escapeHtml(order.customerName || "—")}</b>
              ${ident.missing
                ? (permissions.manage ? `<span class="od-sep"></span><button type="button" class="od-link is-miss" data-ord-numbers>＋ 填公司单号</button>` : "")
                : `<span class="od-sep"></span><span class="od-sysno">系统编号 ${escapeHtml(ident.system)}</span>${permissions.manage ? `<button type="button" class="od-link" style="margin-left:6px" data-ord-numbers>改单号</button>` : ""}`}
              ${order.buyerPoNo ? `<span class="od-sep"></span><span>客户 PO ${escapeHtml(order.buyerPoNo)}</span>` : ""}
              <span class="od-sep"></span><span>负责人 ${escapeHtml(order.ownerName || "—")}</span>
              <span class="od-sep"></span><span>创建 ${ordDay(order.createdAt)}</span>
              <span class="od-sep"></span>${dealRef}
            </div>
          </div>
          <div class="od-hero-amount">
            <span>订单金额</span>
            <b>${escapeHtml(order.currency || "USD")} ${amountText}</b>
            <em>${escapeHtml([order.incoterm, order.portLoading].filter(Boolean).join(" ") || "条款待补全")}</em>
          </div>
        </div>
        <div class="od-facts">
          <div class="od-fact${shipPct >= 100 ? " is-ok" : ""}">
            <span>已发数量</span>
            <b>${shipPct}% <small>${shippedQtyTotal} / ${qtyTotal} 件</small></b>
          </div>
          <div class="od-fact${missingCore.length ? (locked ? "" : " is-warn") : " is-ok"}">
            <span>单证</span>
            <b>${readyDocs.length} / 3 <small>${missingCore.length ? `缺 ${missingCore.join(" / ")}` : "PI · CI · PL 已齐"}</small></b>
          </div>
          <div class="od-fact${dueTone.trim() ? " is-alert" : ""}">
            <span>预计发运</span>
            <b>${order.expectedShipAt ? ordDay(order.expectedShipAt) : "未设置"} <small>${escapeHtml(dueSmall)}</small></b>
          </div>
          <div class="od-fact">
            <span>明细</span>
            <b>${items.length} 行 <small>合计 ${qtyTotal} 件</small></b>
          </div>
        </div>
        ${ordRail(order)}
      </section>

      <div class="od-tabs-wrap">
        <nav class="od-tabs" role="tablist" aria-label="订单详情分页">
          ${tabButton("ov")}
          ${tabButton("items", String(items.length))}
          ${tabButton("docs", `${readyDocs.length}/3`, missingCore.length > 0)}
          ${tabButton("ship", String(shipments.length))}
          ${tabButton("files", String(files.length))}
          ${tabButton("logs", String(events.length))}
        </nav>
        <span class="od-tabs-aside">最近更新 <b>${escapeHtml(updatedText)}</b></span>
      </div>

      <section class="od-tabpage${ordDetailTab === "ov" ? " is-on" : ""}" data-od-page="ov" role="tabpanel">
        <div class="od-focus${focusTone}">
          <div class="od-focus-main">
            <div>
              <p class="od-kicker">下一步</p>
              <div class="od-focus-title">${escapeHtml(focusTitle)}</div>
            </div>
            ${focusOps ? `<div class="od-focus-ops">${focusOps}</div>` : ""}
          </div>
          ${blockers.length
      ? `<div class="od-focus-meta"><span>卡在哪</span>${blockersHtml}</div>`
      : (locked ? "" : `<div class="od-focus-ok">当前没有待处理项，按交期推进即可。</div>`)}
        </div>

        <div class="od-ov-grid">
          <div class="od-panel">
            <div class="od-panel-head">
              <h3>最近动态</h3>
              ${events.length > 4 ? `<button type="button" class="od-link" data-od-goto="logs">全部 ${events.length} 条 →</button>` : `<span class="od-note">${events.length} 条</span>`}
            </div>
            ${feedHtml}
          </div>
          <div class="od-panel">
            <div class="od-panel-head">
              <h3>履约条款</h3>
              <button type="button" class="od-link" data-od-goto="items">查看明细 →</button>
            </div>
            <div class="od-terms">${termsHtml}</div>
            ${order.remark ? `<p class="od-term-note">${escapeHtml(order.remark)}</p>` : ""}
          </div>
        </div>
      </section>

      <section class="od-tabpage${ordDetailTab === "items" ? " is-on" : ""}" data-od-page="items" role="tabpanel">
        <div class="od-panel">
          <div class="od-panel-head">
            <h3>商品明细</h3>
            <span class="od-note">${items.length} 个品项 · 合计 ${qtyTotal} 件</span>
          </div>
          ${itemsTable}
        </div>
        <div class="od-panel">
          <div class="od-panel-head">
            <h3>条款</h3>
            <span class="od-note">用于 PI / CI 预填</span>
          </div>
          <div class="od-terms is-pairs">${termsHtml}</div>
          ${order.remark ? `<p class="od-term-note">${escapeHtml(order.remark)}</p>` : ""}
        </div>
      </section>

      <section class="od-tabpage${ordDetailTab === "docs" ? " is-on" : ""}" data-od-page="docs" role="tabpanel">
        ${missingCore.length && !locked ? `<div class="od-notice">
          <span>还差 <b>${missingCore.length} 份（${missingCore.map(escapeHtml).join(" / ")}）</b>，报关与结汇都要用，建议发货前补齐。</span>
          <button type="button" class="ord-btn is-sm" data-ord-documents>去补单证</button>
        </div>` : ""}
        <div class="od-panel">
          <div class="od-panel-head">
            <h3>本单单据</h3>
            <span class="od-note">${readyDocs.length} 份已就绪${missingCore.length ? ` · ${missingCore.length} 份缺失` : ""}</span>
          </div>
          ${docsTable}
        </div>
      </section>

      <section class="od-tabpage${ordDetailTab === "ship" ? " is-on" : ""}" data-od-page="ship" role="tabpanel">
        <div class="od-panel">
          <div class="od-panel-head">
            <h3>发货单</h3>
            ${shipments.length && order.status === "ready_to_ship" ? `<button type="button" class="ord-btn is-sm" data-ord-ship>＋ 新建发货单</button>` : `<span class="od-note">${shipments.length} 张</span>`}
          </div>
          ${shipHtml}
        </div>
      </section>

      <section class="od-tabpage${ordDetailTab === "files" ? " is-on" : ""}" data-od-page="files" role="tabpanel">
        <div class="od-panel">
          <div class="od-panel-head">
            <h3>本单文件</h3>
            ${permissions.manage
      ? `<div class="od-panel-ops">
              <button type="button" class="ord-btn is-sm" data-ord-attach="assets">从资料维护关联</button>
              <button type="button" class="ord-btn is-sm primary" data-ord-attach="upload">＋ 上传文件</button>
            </div>`
      : `<span class="od-note">${files.length} 份</span>`}
          </div>
          ${filesTable}
        </div>
      </section>

      <section class="od-tabpage${ordDetailTab === "logs" ? " is-on" : ""}" data-od-page="logs" role="tabpanel">
        <div class="od-panel">
          <div class="od-panel-head">
            <h3>操作记录</h3>
            <span class="od-note">共 ${events.length} 条 · 全量保留</span>
          </div>
          ${noteBox}
          ${logsHtml}
        </div>
      </section>
    </div>`;

  ordWireDetail(detail, host);
  ordShowTab(host, ordDetailTab);
}

function ordWireDetail(detail: OrdDetailResponse, host: HTMLElement) {
  const orderId = detail.order.id;
  // 页签是纯展示切换：六个页面已经全部渲染好，切页不重新请求接口。
  qsa<HTMLElement>("[data-od-tab]", host).forEach((node) =>
    node.addEventListener("click", () => ordShowTab(host, (node.dataset.odTab || "ov") as OrdTabKey))
  );
  qsa<HTMLElement>("[data-od-goto]", host).forEach((node) =>
    node.addEventListener("click", () => ordShowTab(host, (node.dataset.odGoto || "ov") as OrdTabKey))
  );
  qs<HTMLElement>("[data-ord-back]", host)?.addEventListener("click", () => activateNavView("orders"));
  qs<HTMLElement>("[data-ord-deal]", host)?.addEventListener("click", () => {
    const dealId = detail.order.dealId;
    if (!dealId) return;
    // 商机抽屉在 pipeline 视图里；state.deals 为空时先补拉一次，否则抽屉会静默关掉。
    if (state.deals.some((deal) => deal.id === dealId)) {
      openArchivedDealInPipeline(dealId);
      return;
    }
    void refreshDealsData(false)
      .then(() => openArchivedDealInPipeline(dealId))
      .catch(() => toast("来源商机加载失败", "error"));
  });
  qsa<HTMLElement>("[data-ord-documents]", host).forEach((node) =>
    node.addEventListener("click", () => activateNavView("documents"))
  );
  qsa<HTMLElement>("[data-ord-preview]", host).forEach((node) =>
    node.addEventListener("click", () => ordPreviewFile(node.dataset.ordPreview || "")));
  qsa<HTMLElement>("[data-ord-download]", host).forEach((node) =>
    node.addEventListener("click", () => ordDownloadFile(node.dataset.ordDownload || "")));
  qsa<HTMLElement>("[data-ord-share]", host).forEach((node) =>
    node.addEventListener("click", () => void openFileShareModal(node.dataset.ordShare || "")));
  qsa<HTMLElement>("[data-ord-versions]", host).forEach((node) =>
    node.addEventListener("click", () => void openFileVersionsModal(node.dataset.ordVersions || "")));
  qsa<HTMLElement>("[data-ord-open-file]", host).forEach((node) =>
    node.addEventListener("click", () => void ordOpenAsset(node.dataset.ordOpenFile || ""))
  );
  qsa<HTMLElement>("[data-ord-file-kind]", host).forEach((node) =>
    node.addEventListener("click", () => ordEditFileKind(detail, node.dataset.ordFileKind || ""))
  );
  qsa<HTMLElement>("[data-ord-status]", host).forEach((node) =>
    node.addEventListener("click", () => void ordAdvance(orderId, detail.order, node.dataset.ordStatus as OrdStatus))
  );
  // 这些动作在「下一步」清单和卡片里可能各有一个入口，必须逐个绑定（qs 只会绑到第一个）
  qsa<HTMLElement>("[data-ord-cancel]", host).forEach((node) =>
    node.addEventListener("click", () => void ordCancel(detail))
  );
  qsa<HTMLElement>("[data-ord-ship]", host).forEach((node) =>
    node.addEventListener("click", () => ordShipmentModal(detail))
  );
  qsa<HTMLElement>("[data-ord-edit]", host).forEach((node) =>
    node.addEventListener("click", () => ordEditTermsModal(detail))
  );
  qsa<HTMLElement>("[data-ord-numbers]", host).forEach((node) =>
    node.addEventListener("click", () => ordNumbersModal(detail))
  );
  qsa<HTMLElement>("[data-ord-attach]", host).forEach((node) =>
    node.addEventListener("click", () => {
      // 文件页两个入口各自落到对应页签：从「从资料维护关联」进来却停在上传页是白费一次点击
      const initial = node.dataset.ordAttach;
      void ordFilePicker(detail, initial === "upload" || initial === "assets" ? initial : undefined);
    })
  );
  // 「下一步」里的出口复用同一批动作（data-od-goto / data-ord-edit），不再维护第二套语义
  qsa<HTMLElement>("[data-ord-unlink]", host).forEach((node) =>
    node.addEventListener("click", () => void ordUnlinkFile(orderId, node.dataset.ordUnlink || ""))
  );
  qs<HTMLElement>("#ordNoteBtn", host)?.addEventListener("click", () => void ordAddNote(orderId));
  qs<HTMLElement>("#ordNoteInput", host)?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void ordAddNote(orderId);
  });
}

/**
 * 订单里打开文件中心的资料，必须走 /access：百度网盘只给 URL 不给提取码，
 * 用户点开就是「请输入提取码」的死路（原来直接 window.open(sourceUrl) 就是这个毛病）。
 * 同时这一步会累计访问次数，和文件中心打开的统计口径保持一致。
 */
async function ordOpenAsset(assetId: string) {
  if (!assetId) return;
  const popup = window.open("", "_blank");
  if (popup) popup.opener = null;
  try {
    const result = await api<{ access: { url: string; shareCode: string } }>(
      `/api/knowledge/assets/${assetId}/access`,
      { method: "POST", body: "{}" }
    );
    if (result.access.shareCode && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(result.access.shareCode).catch(() => undefined);
      toast("已打开，提取码已复制");
    }
    if (popup) popup.location.href = result.access.url;
    else window.open(result.access.url, "_blank", "noopener,noreferrer");
  } catch (error) {
    popup?.close();
    toast(error instanceof Error ? error.message : "资料打开失败", "error");
  }
}

/** 关联时选错的分类要能改，否则详情页按类型找文件会漏。 */
function ordEditFileKind(detail: OrdDetailResponse, fileId: string) {
  const file = detail.files.find((item) => item.id === fileId);
  if (!file) return;
  openModal(
    "修改文件分类",
    `<p style="margin:0 0 12px;font-size:12.5px;color:#46546f">${escapeHtml(file.assetName || "文件")}</p>
     <label class="field-label">分类</label>
     <select id="ordFileKindEdit" style="width:100%;height:34px;border:1px solid #e6dfd1;border-radius:9px;padding:0 8px">
       ${ORD_FILE_KIND_ORDER.map((kind) => `<option value="${kind}" ${file.kind === kind ? "selected" : ""}>${escapeHtml(ORD_FILE_KIND_LABEL[kind])}</option>`).join("")}
     </select>
     <label class="field-label" style="margin-top:12px">备注</label>
     <input id="ordFileNoteEdit" value="${escapeHtml(file.note || "")}" maxlength="200" placeholder="例如：客户回签版" style="width:100%" />`,
    `<button type="button" class="ord-btn ghost" data-modal-close>取消</button>
     <button type="button" class="ord-btn primary" id="ordFileKindSave">保存</button>`
  );
  qs<HTMLElement>("#ordFileKindSave")?.addEventListener("click", async () => {
    try {
      await api(`/api/orders/${detail.order.id}/files/${fileId}`, {
        method: "PATCH",
        body: JSON.stringify({
          kind: qs<HTMLSelectElement>("#ordFileKindEdit")?.value || "other",
          note: qs<HTMLInputElement>("#ordFileNoteEdit")?.value.trim() || ""
        })
      });
      closeModal();
      toast("文件分类已更新");
      void openOrderDetail(detail.order.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败", "error");
    }
  });
}

async function ordAdvance(orderId: string, order: OrdRow, toStatus: OrdStatus) {
  if (toStatus === "completed") {
    const detail = await api<OrdDetailResponse>(`/api/orders/${orderId}`).catch(() => null);
    const missing = detail?.derived.missingDocs || [];
    if (missing.length) {
      ordCompleteWithWaiver(orderId, order, missing);
      return;
    }
  }
  const labels = ORD_STATUS_META[toStatus].label;
  const confirmed = await confirmAction({
    title: `推进到「${labels}」`,
    message: `确认订单 ${ordIdentity(order).primary} 进入「${labels}」？`,
    consequences: ["状态变更会写入履约时间轴", "已发货状态只能由发货单回写，不能手工设置"],
    confirmLabel: "确认推进"
  });
  if (!confirmed) return;
  try {
    await api(`/api/orders/${orderId}/status`, {
      method: "POST",
      body: JSON.stringify({ toStatus, expectedStatus: order.status })
    });
    toast(`已更新为${labels}`);
    void openOrderDetail(orderId);
  } catch (error) {
    toast(error instanceof Error ? error.message : "状态更新失败", "error");
  }
}

function ordCompleteWithWaiver(orderId: string, order: OrdRow, missing: string[]) {
  openModal(
    "单证不齐，是否豁免",
    `<p style="margin:0 0 10px;color:#46546f;font-size:13px;line-height:1.6">完成订单前应当有 ${missing.join(" / ")}。如果客户同意先归档，填写原因后可豁免。</p>
     <label class="field-label">豁免原因</label>
     <textarea id="ordWaiverReason" rows="3" style="width:100%;border:1px solid #e6dfd1;border-radius:9px;padding:10px;font-size:13px" placeholder="例如：客户同意电子归档，纸质件后补"></textarea>`,
    `<button type="button" class="ord-btn ghost" data-modal-close>取消</button>
     <button type="button" class="ord-btn primary" id="ordWaiverConfirm">豁免并完成</button>`
  );
  qs<HTMLElement>("#ordWaiverConfirm")?.addEventListener("click", async () => {
    const reason = qs<HTMLTextAreaElement>("#ordWaiverReason")?.value.trim() || "";
    if (!reason) {
      toast("请填写豁免原因", "error");
      return;
    }
    try {
      await api(`/api/orders/${orderId}/status`, {
        method: "POST",
        body: JSON.stringify({ toStatus: "completed", expectedStatus: order.status, docsWaiver: true, reason })
      });
      closeModal();
      toast("订单已完成");
      void openOrderDetail(orderId);
    } catch (error) {
      toast(error instanceof Error ? error.message : "完成失败", "error");
    }
  });
}

function ordCancel(detail: OrdDetailResponse) {
  const { order } = detail;
  const needsSecond = ["shipped", "delivered"].includes(order.status);
  openModal(
    "取消订单",
    `<p style="margin:0 0 10px;color:#46546f;font-size:13px;line-height:1.6">取消不会回滚商机阶段，也不会修改客户生命周期——成交是历史事实，取消是履约失败，两者分开记录。</p>
     ${needsSecond ? `<p style="margin:0 0 10px;color:#bb3b2c;font-size:12.5px">该订单已发货，取消需要主管权限并二次确认。</p>` : ""}
     <label class="field-label">取消原因</label>
     <textarea id="ordCancelReason" rows="3" style="width:100%;border:1px solid #e6dfd1;border-radius:9px;padding:10px;font-size:13px" placeholder="例如：客户资金问题，订单作废"></textarea>`,
    `<button type="button" class="ord-btn ghost" data-modal-close>返回</button>
     <button type="button" class="ord-btn danger" id="ordCancelConfirm">确认取消</button>`
  );
  qs<HTMLElement>("#ordCancelConfirm")?.addEventListener("click", async () => {
    const reason = qs<HTMLTextAreaElement>("#ordCancelReason")?.value.trim() || "";
    if (!reason) {
      toast("请填写取消原因", "error");
      return;
    }
    try {
      await api(`/api/orders/${order.id}/status`, {
        method: "POST",
        body: JSON.stringify({
          toStatus: "cancelled",
          expectedStatus: order.status,
          reason,
          secondConfirm: needsSecond
        })
      });
      closeModal();
      toast("订单已取消");
      void openOrderDetail(order.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : "取消失败", "error");
    }
  });
}

function ordEditTermsModal(detail: OrdDetailResponse) {
  const { order, items } = detail;
  // 后端也拦（有发货记录改数量会 409），前端先关掉入口，避免用户填完才被打回。
  const itemsLocked = items.some((item) => item.shippedQty > 0);
  const lineRow = (item?: OrdItem) => `<tr data-ord-line>
      <td><input data-line-product maxlength="200" placeholder="品名" value="${escapeHtml(item?.product || "")}" /></td>
      <td><input data-line-spec maxlength="200" placeholder="规格（选填）" value="${escapeHtml(item?.spec || "")}" /></td>
      <td class="num"><input data-line-qty type="number" min="0" step="any" value="${item ? item.qty : 1}" /></td>
      <td><input data-line-unit maxlength="20" placeholder="PCS" value="${escapeHtml(item?.unit || "")}" /></td>
      <td class="num"><input data-line-price type="number" min="0" step="any" value="${item ? item.unitPrice : 0}" /></td>
      <td><span class="ord-edit-sub" data-line-sub>0.00</span></td>
      <td><button type="button" class="ord-edit-line-remove" data-line-remove aria-label="删除该行">×</button></td>
    </tr>`;
  openModal(
    "编辑订单",
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div>
        <label class="field-label">公司单号 <span style="color:#98a1b3;font-weight:400">系统编号 ${escapeHtml(order.orderNo)} 不可改</span></label>
        <input id="ordEditCompanyNo" value="${escapeHtml(order.companyOrderNo || "")}" maxlength="80" style="width:100%" placeholder="合同号 / 生产单号，可留空" />
      </div>
      <div><label class="field-label">预计发货日</label><input id="ordEditShipDate" type="date" value="${escapeHtml(order.expectedShipAt)}" style="width:100%" /></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="field-label">Incoterm</label><input id="ordEditIncoterm" value="${escapeHtml(order.incoterm)}" style="width:100%" /></div>
      <div><label class="field-label">付款条件</label><input id="ordEditPayment" value="${escapeHtml(order.paymentTerm)}" style="width:100%" /></div>
      <div><label class="field-label">装运港</label><input id="ordEditPortLoading" value="${escapeHtml(order.portLoading)}" style="width:100%" /></div>
      <div><label class="field-label">目的港</label><input id="ordEditPortDischarge" value="${escapeHtml(order.portDischarge)}" style="width:100%" /></div>
      <div><label class="field-label">客户 PO</label><input id="ordEditPo" value="${escapeHtml(order.buyerPoNo)}" style="width:100%" /></div>
      <div><label class="field-label">ERP 单号</label><input id="ordEditErp" value="${escapeHtml(order.erpOrderNo || "")}" maxlength="80" style="width:100%" placeholder="选填" /></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12.5px;color:var(--text)">
      <input type="checkbox" id="ordEditProduction" ${order.productionRequired ? "checked" : ""}/> 需要生产（确认后先进「生产中」）
    </label>
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:16px 0 0">
      <b style="font-size:13px;color:var(--ink)">订单明细</b>
      <small style="font-size:11.5px;color:var(--muted)">${itemsLocked ? "已有发货记录，数量锁定；只能改条款" : "小计 = 数量 × 单价，保存后订单金额自动重算"}</small>
    </div>
    <table class="ord-edit-lines">
      <thead><tr><th>品名</th><th>规格</th><th class="num">数量</th><th>单位</th><th class="num">单价</th><th class="num">小计</th><th></th></tr></thead>
      <tbody id="ordEditLineBody">${items.map((item) => lineRow(item)).join("")}</tbody>
    </table>
    <div class="ord-edit-foot">
      <button type="button" class="ord-btn" id="ordEditAddLine" ${itemsLocked ? "disabled" : ""}>＋ 新增一行</button>
      <span class="ord-edit-total">合计 <b id="ordEditTotal">—</b></span>
    </div>`,
    `<button type="button" class="ord-btn ghost" data-modal-close>取消</button>
     <button type="button" class="ord-btn primary" id="ordEditSave">保存</button>`,
    { modalClass: "ord-edit-modal" }
  );

  const lineBody = qs<HTMLElement>("#ordEditLineBody");
  const recalc = () => {
    if (!lineBody) return;
    let total = 0;
    lineBody.querySelectorAll<HTMLElement>("tr[data-ord-line]").forEach((row) => {
      const qty = Number(row.querySelector<HTMLInputElement>("[data-line-qty]")?.value || 0);
      const price = Number(row.querySelector<HTMLInputElement>("[data-line-price]")?.value || 0);
      const amount = Math.round((Number.isFinite(qty) ? qty : 0) * (Number.isFinite(price) ? price : 0) * 100) / 100;
      total += amount;
      const sub = row.querySelector<HTMLElement>("[data-line-sub]");
      if (sub) sub.textContent = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    });
    const host = qs<HTMLElement>("#ordEditTotal");
    if (host) host.textContent = ordMoney(Math.round(total * 100) / 100, order.currency);
  };
  recalc();

  lineBody?.addEventListener("input", recalc);
  lineBody?.addEventListener("click", (event) => {
    const remove = (event.target as HTMLElement).closest("[data-line-remove]");
    if (!remove) return;
    const rows = lineBody.querySelectorAll("tr[data-ord-line]");
    if (rows.length <= 1) {
      toast("至少保留一行明细", "error");
      return;
    }
    remove.closest("tr")?.remove();
    recalc();
  });
  qs<HTMLElement>("#ordEditAddLine")?.addEventListener("click", () => {
    lineBody?.insertAdjacentHTML("beforeend", lineRow());
    recalc();
  });

  qs<HTMLElement>("#ordEditSave")?.addEventListener("click", async () => {
    const lines = [...(lineBody?.querySelectorAll<HTMLElement>("tr[data-ord-line]") || [])].map((row) => ({
      product: row.querySelector<HTMLInputElement>("[data-line-product]")?.value.trim() || "",
      spec: row.querySelector<HTMLInputElement>("[data-line-spec]")?.value.trim() || "",
      qty: Number(row.querySelector<HTMLInputElement>("[data-line-qty]")?.value || 0),
      unit: row.querySelector<HTMLInputElement>("[data-line-unit]")?.value.trim() || "",
      unitPrice: Number(row.querySelector<HTMLInputElement>("[data-line-price]")?.value || 0)
    }));
    if (!lines.length) {
      toast("订单至少要有一行明细", "error");
      return;
    }
    const blank = lines.findIndex((line) => !line.product);
    if (blank >= 0) {
      toast(`第 ${blank + 1} 行品名不能为空`, "error");
      return;
    }
    const invalid = lines.some((line) => !Number.isFinite(line.qty) || line.qty < 0 || !Number.isFinite(line.unitPrice) || line.unitPrice < 0);
    if (invalid) {
      toast("数量与单价必须是不小于 0 的数字", "error");
      return;
    }
    if (lines.every((line) => line.qty * line.unitPrice <= 0)) {
      toast("订单金额必须大于 0", "error");
      return;
    }
    try {
      await api(`/api/orders/${order.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          companyOrderNo: qs<HTMLInputElement>("#ordEditCompanyNo")?.value.trim() || "",
          incoterm: qs<HTMLInputElement>("#ordEditIncoterm")?.value.trim() || "",
          paymentTerm: qs<HTMLInputElement>("#ordEditPayment")?.value.trim() || "",
          portLoading: qs<HTMLInputElement>("#ordEditPortLoading")?.value.trim() || "",
          portDischarge: qs<HTMLInputElement>("#ordEditPortDischarge")?.value.trim() || "",
          buyerPoNo: qs<HTMLInputElement>("#ordEditPo")?.value.trim() || "",
          erpOrderNo: qs<HTMLInputElement>("#ordEditErp")?.value.trim() || "",
          expectedShipAt: qs<HTMLInputElement>("#ordEditShipDate")?.value || "",
          productionRequired: Boolean(qs<HTMLInputElement>("#ordEditProduction")?.checked),
          // 数量已锁定时不发 items，否则后端会整单 409，条款也一起保存不了
          ...(itemsLocked ? {} : { items: lines }),
          expectedUpdatedAt: order.updatedAt
        })
      });
      closeModal();
      toast("订单已保存，金额已按明细重算");
      void openOrderDetail(order.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败", "error");
    }
  });
}

/**
 * 单号弹窗：公司单号 / 客户 PO / ERP 单号。
 * 三个都是「标识」而不是「条款」——不改变金额、数量与单证内容，任何状态都必须能改，
 * 所以单独给一个入口，不进「编辑订单」的条款锁定范围。
 */
function ordNumbersModal(detail: OrdDetailResponse) {
  const order = detail.order;
  openModal(
    "订单单号",
    `<p style="margin:0 0 14px;color:#5b6577;font-size:12.5px;line-height:1.7">
       系统编号 <b style="color:#1d2534">${escapeHtml(order.orderNo)}</b> 由 CRM 自动生成，只用于系统内定位，不可修改。
     </p>
     <div style="display:grid;gap:12px">
       <div>
         <label class="field-label">公司单号 <span style="color:#98a1b3;font-weight:400">实际对外用的那个号</span></label>
         <input id="ordNumCompany" maxlength="80" value="${escapeHtml(order.companyOrderNo || "")}" style="width:100%" placeholder="合同号 / 生产单号 / 财务单号，例如 HT-2026-1028" />
       </div>
       <div>
         <label class="field-label">客户 PO <span style="color:#98a1b3;font-weight:400">客户下的采购单号</span></label>
         <input id="ordNumPo" maxlength="80" value="${escapeHtml(order.buyerPoNo || "")}" style="width:100%" placeholder="选填" />
       </div>
       <div>
         <label class="field-label">ERP 单号 <span style="color:#98a1b3;font-weight:400">ERP 还没接上时可先手工填</span></label>
         <input id="ordNumErp" maxlength="80" value="${escapeHtml(order.erpOrderNo || "")}" style="width:100%" placeholder="选填" />
       </div>
     </div>
     <p style="margin:10px 0 0;color:#98a1b3;font-size:11.5px">留空表示未填；三个号在任何订单状态下都能再改。</p>`,
    `<button type="button" class="ord-btn ghost" data-modal-close>取消</button>
     <button type="button" class="ord-btn primary" id="ordNumbersSave">保存</button>`
  );
  const save = qs<HTMLButtonElement>("#ordNumbersSave");
  save?.addEventListener("click", async () => {
    if (save.disabled) return;
    const company = qs<HTMLInputElement>("#ordNumCompany")?.value.trim() || "";
    const po = qs<HTMLInputElement>("#ordNumPo")?.value.trim() || "";
    const erp = qs<HTMLInputElement>("#ordNumErp")?.value.trim() || "";
    // 只发真正改过的字段：没动过的号不该在时间轴上留一行空变更。
    const body: Record<string, string> = {};
    if (company !== (order.companyOrderNo || "")) body.companyOrderNo = company;
    if (po !== (order.buyerPoNo || "")) body.buyerPoNo = po;
    if (erp !== (order.erpOrderNo || "")) body.erpOrderNo = erp;
    if (!Object.keys(body).length) {
      closeModal();
      return;
    }
    setButtonPending(save, true, "保存", "保存中…");
    try {
      await api(`/api/orders/${order.id}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      });
      closeModal();
      toast("订单单号已保存");
      void openOrderDetail(order.id);
    } catch (error) {
      setButtonPending(save, false, "保存", "保存");
      toast(error instanceof Error ? error.message : "保存失败", "error");
    }
  });
}

function ordShipmentModal(detail: OrdDetailResponse) {  const { order, items } = detail;
  const remaining = items.map((item) => ({
    ...item,
    remain: Math.max(0, item.qty - item.shippedQty)
  }));
  openModal(
    "建发货单",
    `<p style="margin:0 0 12px;color:#46546f;font-size:12.5px">发货数量覆盖全部明细后，订单会自动转为「已发货」；分批出货只更新进度，不会提前改状态。</p>
     <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
       <div><label class="field-label">发货单号</label><input id="ordShipNo" placeholder="可留空，稍后补" style="width:100%" /></div>
       <div><label class="field-label">承运商</label><input id="ordShipCourier" placeholder="DHL / 海运" style="width:100%" /></div>
       <div style="grid-column:1/-1"><label class="field-label">运单号</label><input id="ordShipTracking" placeholder="选填" style="width:100%" /></div>
     </div>
     <table class="od-items" style="margin-top:14px">
       <thead><tr><th>品名</th><th class="num">待发</th><th style="width:110px">本次发货</th></tr></thead>
       <tbody>
         ${remaining.map((item, index) => `<tr>
           <td>${escapeHtml(item.product)}${item.spec ? `<small style="color:#9b937f"> / ${escapeHtml(item.spec)}</small>` : ""}</td>
           <td class="num">${item.remain}</td>
           <td><input data-ord-ship-qty="${item.id}" type="number" min="0" max="${item.remain}" value="${item.remain}" style="width:100%;height:30px;border:1px solid #e6dfd1;border-radius:8px;padding:0 8px" /></td>
         </tr>`).join("")}
       </tbody>
     </table>`,
    `<button type="button" class="ord-btn ghost" data-modal-close>取消</button>
     <button type="button" class="ord-btn primary" id="ordShipSave">创建发货单</button>`
  );
  qs<HTMLElement>("#ordShipSave")?.addEventListener("click", async () => {
    const lines = remaining
      .map((item) => ({
        orderItemId: item.id,
        productName: item.product,
        model: item.spec,
        quantity: Number(qs<HTMLInputElement>(`[data-ord-ship-qty="${item.id}"]`)?.value || 0),
        unit: item.unit || "PCS"
      }))
      .filter((line) => line.quantity > 0);
    if (!lines.length) {
      toast("本次发货数量都是 0", "error");
      return;
    }
    try {
      await api("/api/tools/shipments", {
        method: "POST",
        body: JSON.stringify({
          orderId: order.id,
          dealId: order.dealId,
          customerName: order.customerName,
          shipmentNo: qs<HTMLInputElement>("#ordShipNo")?.value.trim() || "",
          courier: qs<HTMLInputElement>("#ordShipCourier")?.value.trim() || "",
          trackingCode: qs<HTMLInputElement>("#ordShipTracking")?.value.trim() || "",
          status: "shipped",
          shippedAt: new Date().toISOString().slice(0, 10),
          items: lines
        })
      });
      closeModal();
      toast("发货单已创建，进度已回写");
      void openOrderDetail(order.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : "创建发货单失败", "error");
    }
  });
}

async function ordFilePicker(detail: OrdDetailResponse, initial?: "assets" | "upload") {
  try {
    const { assets } = await api<{ assets: KnowledgeAsset[] }>("/api/knowledge/assets");
    const orderId = detail.order.id;
    // 已归档的不给关联：订单里挂一份归档资料，等于给了一个随时会消失的凭证。
    const selectable = assets.filter((asset) => asset.status !== "archived");
    const linked = new Set(detail.files.map((file) => file.assetId).filter(Boolean));
    const byId = new Map(selectable.map((asset) => [asset.id, asset]));
    const picked = new Set<string>();
    // 资料维护里一份资料都没有时，默认直接落在「上传新文件」：
    // 让用户先把东西传进来，而不是打开一个注定是空的列表再被支使去别的页面。
    let tab: "assets" | "upload" = selectable.length ? "assets" : "upload";
    // 从「上传文件」按钮进来的，直接落在上传页，不用再点一次页签
    if (initial) tab = initial;
    let uploadFiles: File[] = [];
    // 同一个文件的重试必须复用 clientToken，否则弱网下会传出两份一样的文件
    const uploadTokens = new Map<File, string>();
    // 每个文件的上传状态：进度/失败原因都要让用户当场看见，而不是只弹一句「上传失败」
    type OrdUploadState = { status: "idle" | "uploading" | "done" | "failed"; percent: number; note: string };
    const uploadState = new Map<File, OrdUploadState>();
    const setUploadState = (file: File, patch: Partial<OrdUploadState>) => {
      const current = uploadState.get(file) || { status: "idle" as const, percent: 0, note: "" };
      uploadState.set(file, { ...current, ...patch });
    };
    const tokenFor = (file: File) => {
      if (!uploadTokens.has(file)) uploadTokens.set(file, crypto.randomUUID());
      return uploadTokens.get(file)!;
    };

    const activeKind = () => qs<HTMLSelectElement>("#ordFileKind")?.value || "auto";
    const kindOf = (asset: KnowledgeAsset) => {
      const chosen = activeKind();
      return chosen === "auto" ? ordInferFileKind(asset) : chosen;
    };
    const kindForUpload = () => {
      const chosen = qs<HTMLSelectElement>("#ordUploadKind")?.value || "auto";
      return (name: string) => chosen === "auto" ? ordInferFileKind({ title: name }) : chosen;
    };

    const renderRows = (keyword: string) => {
      const needle = keyword.trim().toLowerCase();
      const matched = selectable.filter((asset) => {
        if (!needle) return true;
        return [asset.title, asset.category, knowledgeAssetTypeText(asset.fileType), ...(asset.tags || [])]
          .some((value) => String(value || "").toLowerCase().includes(needle));
      });
      const sorted = matched.slice().sort((left, right) => {
        const byLinked = Number(linked.has(left.id)) - Number(linked.has(right.id));
        if (byLinked) return byLinked;
        const byStatus = Number(right.status === "published") - Number(left.status === "published");
        if (byStatus) return byStatus;
        return String(left.title).localeCompare(String(right.title), "zh-Hans-CN");
      });
      if (!sorted.length) {
        return `<div class="od-pick-empty">${assets.length
          ? `没有匹配「${escapeHtml(keyword.trim())}」的资料`
          : "资料维护里还没有资料——切到「上传新文件」，传完会自动关联本单。"}</div>`;
      }
      return sorted.slice(0, 200).map((asset) => {
        const isLinked = linked.has(asset.id);
        return `<label class="od-pick-row${isLinked ? " is-linked" : ""}${picked.has(asset.id) ? " is-checked" : ""}">
          <input type="checkbox" class="od-pick-check" data-ord-pick="${escapeHtml(asset.id)}" ${isLinked ? "disabled" : ""} ${picked.has(asset.id) ? "checked" : ""} />
          <span class="od-pick-type">${escapeHtml(ordAssetTypeBadge(asset))}</span>
          <span class="od-pick-main">
            <b>${escapeHtml(asset.title)}</b>
            <small>${[
              asset.category || "未分类",
              knowledgeStatusText(asset.status),
              asset.shareCode ? "需提取码" : "",
              asset.linkedOrderCount ? `已用于 ${asset.linkedOrderCount} 单` : ""
            ].filter(Boolean).map(escapeHtml).join(" · ")}</small>
          </span>
          <span class="od-pick-side${!isLinked && picked.has(asset.id) ? " is-will" : ""}">${isLinked
            ? "已关联"
            : picked.has(asset.id) ? escapeHtml(`记为${ORD_FILE_KIND_LABEL[kindOf(asset)] || "其他"}`) : ""}</span>
        </label>`;
      }).join("");
    };

    const renderUploadRows = () => {
      if (!uploadFiles.length) {
        return `<div class="od-pick-empty">选择一个或多个文件；PDF、Word、Excel、图片（含 iPhone 的 HEIC）、ZIP 都支持，单个不超过 100MB。超过 8MB 会自动走分片续传，断网后点重试只补没传完的片。</div>`;
      }
      const kindFn = kindForUpload();
      return uploadFiles.map((file, index) => {
        const state = uploadState.get(file) || { status: "idle" as const, percent: 0, note: "" };
        const oversized = file.size > 100 * 1024 * 1024;
        const statusText = oversized
          ? "超过 100MB，无法上传"
          : state.status === "uploading"
            ? state.note || `上传中 ${state.percent}%`
            : state.status === "done"
              ? "已上传"
              : state.status === "failed"
                ? `失败：${state.note}`
                : "等待上传";
        return `<div class="od-upload-row is-${state.status}">
        <span class="od-pick-type">${escapeHtml(ORD_FILE_KIND_LABEL[kindFn(file.name)] || "其他")}</span>
        <span class="od-pick-main">
          <b>${escapeHtml(file.name)}</b>
          <small>${escapeHtml(ordFileSize(file.size) || "—")} · ${escapeHtml(statusText)}</small>
          ${state.status === "uploading" || state.status === "done"
            ? `<span class="od-upload-bar"><i style="width:${Math.max(2, Math.min(100, state.percent))}%"></i></span>`
            : ""}
        </span>
        ${state.status === "failed"
          ? `<button type="button" class="od-link" data-ord-upload-retry="${index}">重试</button>`
          : ""}
        <button type="button" class="od-link danger" data-ord-upload-remove="${index}" ${state.status === "uploading" ? "disabled" : ""}>移除</button>
      </div>`;
      }).join("");
    };

    const syncSummary = () => {
      const go = qs<HTMLButtonElement>("#ordAttachGo");
      const summary = qs<HTMLElement>("#ordPickSummary");
      if (tab === "assets") {
        const count = picked.size;
        if (go) {
          go.disabled = count === 0;
          go.textContent = count ? `关联 ${count} 份` : "关联";
        }
        if (summary) {
          const chosen = activeKind();
          const kinds = chosen === "auto"
            ? [...new Set([...picked].map((id) => ORD_FILE_KIND_LABEL[ordInferFileKind(byId.get(id) || {})] || "其他"))]
            : [ORD_FILE_KIND_LABEL[chosen] || "其他"];
          summary.textContent = count
            ? `已选 ${count} 份 · 分类：${kinds.join(" / ")}`
            : "勾选要关联的资料，可一次选多份。";
        }
        return;
      }
      const usable = uploadFiles.filter((file) => file.size <= 100 * 1024 * 1024).length;
      if (go) {
        go.disabled = usable === 0;
        go.textContent = usable ? `上传并关联 ${usable} 个` : "上传";
      }
      if (summary) {
        const oversized = uploadFiles.length - usable;
        summary.textContent = uploadFiles.length
          ? `待上传 ${usable} 个文件${oversized ? `，${oversized} 个超过 100MB 会被跳过` : ""}；上传后自动关联到本订单。`
          : "选择文件后点「上传并关联」，文件会存到本机存储目录。";
      }
    };

    const redraw = () => {
      const list = qs<HTMLElement>("#ordAssetList");
      if (list) list.innerHTML = renderRows(qs<HTMLInputElement>("#ordAssetSearch")?.value || "");
      const uploadList = qs<HTMLElement>("#ordUploadList");
      if (uploadList) uploadList.innerHTML = renderUploadRows();
      syncSummary();
    };

    const switchTab = (next: "assets" | "upload") => {
      tab = next;
      qsa<HTMLElement>("[data-ord-pick-tab]").forEach((node) =>
        node.classList.toggle("is-active", node.dataset.ordPickTab === next));
      const assetsPanel = qs<HTMLElement>("#ordAssetPanel");
      const uploadPanel = qs<HTMLElement>("#ordUploadPanel");
      // 直接切 style.display：hidden 属性会被任意 display 规则压住（项目里踩过多次）
      if (assetsPanel) assetsPanel.style.display = next === "assets" ? "" : "none";
      if (uploadPanel) uploadPanel.style.display = next === "upload" ? "" : "none";
      syncSummary();
    };

    openModal(
      "添加订单文件",
      `<div class="od-pick-tabs">
        <button type="button" class="od-pick-tab${tab === "assets" ? " is-active" : ""}" data-ord-pick-tab="assets">资料维护已有</button>
        <button type="button" class="od-pick-tab${tab === "upload" ? " is-active" : ""}" data-ord-pick-tab="upload">上传新文件</button>
      </div>
      <div id="ordAssetPanel"${tab === "assets" ? "" : ' style="display:none"'}>
        <div class="od-pick-bar">
          <input id="ordAssetSearch" class="od-pick-search" type="search" placeholder="搜索标题、类目或标签" autocomplete="off" />
          <select id="ordFileKind" class="od-pick-kind" title="关联后的文件分类">
            <option value="auto" selected>自动判断分类</option>
            ${ORD_FILE_KIND_ORDER.map((kind) => `<option value="${kind}">${escapeHtml(ORD_FILE_KIND_LABEL[kind])}</option>`).join("")}
          </select>
        </div>
        <div class="od-pick-list" id="ordAssetList">${renderRows("")}</div>
        <!-- 想补一份新资料进资料库，才需要离开订单；只挂本单文件走「上传新文件」即可 -->
        <div class="od-pick-more"><span>想新增一份可复用的资料？</span>
          <button type="button" class="od-link" data-ord-goto-knowledge>去资料维护添加 →</button></div>
      </div>
      <div id="ordUploadPanel"${tab === "upload" ? "" : ' style="display:none"'}>
        <div class="od-pick-bar">
          <input id="ordUploadInput" class="od-upload-input" type="file" multiple
            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.rtf,.odt,.ods,.odp,.wps,.wpt,.et,.ett,.dps,.dpt,.jpg,.jpeg,.png,.webp,.heic,.zip,.txt,.csv" />
          <select id="ordUploadKind" class="od-pick-kind" title="上传后的文件分类">
            <option value="auto" selected>自动判断分类</option>
            ${ORD_FILE_KIND_ORDER.map((kind) => `<option value="${kind}">${escapeHtml(ORD_FILE_KIND_LABEL[kind])}</option>`).join("")}
          </select>
        </div>
        <div class="od-pick-list" id="ordUploadList">${renderUploadRows()}</div>
      </div>
      <div class="od-pick-summary" id="ordPickSummary"></div>`,
      `<button type="button" class="ord-btn ghost" data-modal-close>取消</button>
       <button type="button" class="ord-btn primary" id="ordAttachGo" disabled>关联</button>`,
      {
        modalClass: "od-pick-modal",
        description: "上传的文件保存到本机存储目录并自动关联本订单；关联资料维护里已有的资料不会复制文件。"
      }
    );
    syncSummary();

    qsa<HTMLElement>("[data-ord-pick-tab]").forEach((node) =>
      node.addEventListener("click", () => switchTab(node.dataset.ordPickTab === "upload" ? "upload" : "assets")));

    qs<HTMLInputElement>("#ordAssetSearch")?.addEventListener("input", redraw);
    // 分类下拉会改变每一行的「记为 X」，必须整表重绘
    ["#ordFileKind", "#ordUploadKind"].forEach((selector) =>
      qs<HTMLSelectElement>(selector)?.addEventListener("change", redraw));

    qs<HTMLInputElement>("#ordUploadInput")?.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      uploadFiles = Array.from(input.files || []);
      uploadFiles.forEach((file) => {
        if (!uploadTokens.has(file)) uploadTokens.set(file, crypto.randomUUID());
      });
      redraw();
    });

    const useableState = (file: File) => uploadState.get(file) || { status: "idle" as const, percent: 0, note: "" };
    qs<HTMLElement>("#ordUploadList")?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const retry = target.closest<HTMLElement>("[data-ord-upload-retry]");
      if (retry) {
        const index = Number(retry.dataset.ordUploadRetry);
        const file = uploadFiles[index];
        if (file) {
          setUploadState(file, { status: "idle", percent: 0, note: "" });
          void runUploads([file]);
        }
        return;
      }
      const button = target.closest<HTMLElement>("[data-ord-upload-remove]");
      if (!button) return;
      const index = Number(button.dataset.ordUploadRemove);
      const file = uploadFiles[index];
      // 正在传的文件不许移除：会话还在跑，移掉会让「重试」找不到它
      if (file && useableState(file).status === "uploading") return;
      if (Number.isInteger(index) && index >= 0) uploadFiles.splice(index, 1);
      const input = qs<HTMLInputElement>("#ordUploadInput");
      // 清空 input：否则再次选同一个文件不会触发 change
      if (input) input.value = "";
      redraw();
    });

    // 列表会被搜索重绘，勾选只能走委托；且重绘后要按 picked 回填
    qs<HTMLElement>("#ordAssetList")?.addEventListener("change", (event) => {
      const node = event.target as HTMLInputElement;
      if (!node.matches?.(".od-pick-check")) return;
      const id = node.dataset.ordPick || "";
      if (node.checked) picked.add(id);
      else picked.delete(id);
      node.closest(".od-pick-row")?.classList.toggle("is-checked", node.checked);
      const side = node.closest(".od-pick-row")?.querySelector(".od-pick-side");
      if (side) {
        const asset = byId.get(id);
        side.textContent = node.checked && asset ? `记为${ORD_FILE_KIND_LABEL[kindOf(asset)] || "其他"}` : "";
        side.classList.toggle("is-will", node.checked);
      }
      syncSummary();
    });

    // 超过这个体积就走分片：直传一次 80MB，展会现场断一次就得从头再来
    const CHUNK_THRESHOLD = 8 * 1024 * 1024;

    const sha256Of = async (file: File) => {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };

    const uploadDirect = async (file: File, kind: string, token: string) => {
      const csrfToken = cookieValue("gj_csrf");
      const response = await fetch(
        `/api/files?contextType=order&contextId=${encodeURIComponent(orderId)}&kind=${encodeURIComponent(kind)}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
            "x-file-type": file.type || "application/octet-stream",
            "x-client-token": token,
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
          },
          body: file
        }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: "上传失败" }));
        throw new Error(body.message || `上传失败（HTTP ${response.status}）`);
      }
    };

    const uploadChunked = async (
      file: File,
      kind: string,
      token: string,
      onProgress: (percent: number, note: string) => void
    ) => {
      const csrfToken = cookieValue("gj_csrf");
      const headers = {
        "content-type": "application/json",
        ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
      };
      onProgress(1, "计算校验值…");
      const sha256 = await sha256Of(file);
      const startResponse = await fetch("/api/files/uploads", {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({
          fileName: file.name,
          size: file.size,
          sha256,
          clientToken: token,
          contextType: "order",
          contextId: orderId,
          kind
        })
      });
      const started = await startResponse.json().catch(() => ({}));
      if (!startResponse.ok) throw new Error(started.message || `创建上传会话失败（HTTP ${startResponse.status}）`);
      // 同一个 token 之前已经传完：服务端直接把文件还回来，不会重复落库
      if (started.file) return;

      const session = started.session as { id: string; chunkSize: number; totalChunks: number; received: number[] };
      const received = new Set(session.received || []);
      let sent = received.size;
      for (let index = 0; index < session.totalChunks; index += 1) {
        if (received.has(index)) continue;
        const begin = index * session.chunkSize;
        const blob = file.slice(begin, Math.min(file.size, begin + session.chunkSize));
        const chunkResponse = await fetch(`/api/files/uploads/${encodeURIComponent(session.id)}/chunks/${index}`, {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "content-type": "application/octet-stream",
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
          },
          body: blob
        });
        if (!chunkResponse.ok) {
          const body = await chunkResponse.json().catch(() => ({ message: "分片上传失败" }));
          throw new Error(body.message || `分片 ${index + 1} 上传失败（HTTP ${chunkResponse.status}）`);
        }
        sent += 1;
        onProgress(
          Math.round((sent / session.totalChunks) * 96),
          `断点续传 ${sent}/${session.totalChunks} 片（${Math.min(100, Math.round((sent / session.totalChunks) * 100))}%）`
        );
      }
      onProgress(98, "拼装校验中…");
      const completeResponse = await fetch(`/api/files/uploads/${encodeURIComponent(session.id)}/complete`, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: "{}"
      });
      if (!completeResponse.ok) {
        const body = await completeResponse.json().catch(() => ({ message: "拼装失败" }));
        throw new Error(body.message || `拼装失败（HTTP ${completeResponse.status}）`);
      }
    };

    let lastPaint = 0;
    const redrawThrottled = () => {
      const now = Date.now();
      if (now - lastPaint < 120) return;
      lastPaint = now;
      redraw();
    };

    /** 并发 3 上传：单个文件内部仍串行，避免同一会话的片次序乱掉 */
    const runUploads = async (targets: File[]) => {
      const usable = targets.filter((file) => file.size <= 100 * 1024 * 1024);
      if (!usable.length) return;
      const go = qs<HTMLButtonElement>("#ordAttachGo");
      if (go) {
        go.disabled = true;
        go.textContent = "上传中…";
      }
      usable.forEach((file) => setUploadState(file, { status: "uploading", percent: 0, note: "准备上传" }));
      redraw();

      let cursor = 0;
      const worker = async () => {
        while (cursor < usable.length) {
          const file = usable[cursor];
          cursor += 1;
          try {
            if (file.size > CHUNK_THRESHOLD) {
              await uploadChunked(file, kindForUpload()(file.name), tokenFor(file), (percent, note) => {
                setUploadState(file, { status: "uploading", percent, note });
                redrawThrottled();
              });
            } else {
              await uploadDirect(file, kindForUpload()(file.name), tokenFor(file));
            }
            setUploadState(file, { status: "done", percent: 100, note: "已上传" });
          } catch (error) {
            setUploadState(file, {
              status: "failed",
              note: error instanceof Error ? error.message : "上传失败"
            });
          }
          redraw();
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, usable.length) }, worker));

      const failed = usable.filter((file) => uploadState.get(file)?.status === "failed");
      const done = usable.length - failed.length;
      if (failed.length) {
        toast(`已上传 ${done} 个，${failed.length} 个失败；可点列表里的「重试」接着传`, "error");
        if (go) {
          go.disabled = false;
          go.textContent = `重试失败 ${failed.length} 个`;
        }
        syncSummary();
        return;
      }
      closeModal();
      toast(`已上传并关联 ${done} 个文件`);
      void openOrderDetail(orderId);
    };

    qs<HTMLButtonElement>("#ordAttachGo")?.addEventListener("click", async () => {
      const go = qs<HTMLButtonElement>("#ordAttachGo");
      if (go?.disabled) return;

      if (tab === "upload") {
        await runUploads(uploadFiles);
        return;
      }

      const ids = [...picked];
      if (!ids.length) return;
      if (go) {
        go.disabled = true;
        go.textContent = "关联中…";
      }
      let done = 0;
      const failures: string[] = [];
      // 逐条串行：后端一次只收一份，并发没有收益，还会让事件时间轴顺序乱掉。
      for (const id of ids) {
        const asset = byId.get(id);
        try {
          await api(`/api/orders/${orderId}/files`, {
            method: "POST",
            body: JSON.stringify({ assetId: id, kind: asset ? kindOf(asset) : "other" })
          });
          done += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : "关联失败";
          if (message.includes("已关联")) done += 1;
          else failures.push(`${asset?.title || id}（${message}）`);
        }
      }
      closeModal();
      if (failures.length) {
        toast(`已关联 ${done} 份，${failures.length} 份失败：${failures[0]}`, "error");
      } else {
        toast(`已关联 ${done} 份文件`);
      }
      void openOrderDetail(orderId);
    });

    qs<HTMLElement>("#appModal [data-ord-goto-knowledge]")?.addEventListener("click", () => {
      closeModal();
      activateNavView("knowledge");
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : "资料维护里的资料加载失败", "error");
  }
}

/** 预览：PDF/图片走 iframe，Office 没有派生件时提示下载 */
export function ordPreviewFile(fileId: string) {
  if (!fileId) return;
  const url = `/api/files/${encodeURIComponent(fileId)}/preview`;
  const rawUrl = `/api/files/${encodeURIComponent(fileId)}/raw`;
  openModal(
    "文件预览",
    `<div class="od-preview-frame" id="odPreviewHost"><div class="od-preview-state">正在加载…</div></div>`,
    `<a class="ord-btn ghost" href="${rawUrl}">下载</a>
     <button type="button" class="ord-btn primary" data-modal-close>关闭</button>`,
    { modalClass: "od-preview-modal", description: "预览不会修改文件；需要原始文件请点下载。" }
  );
  // 用外层容器当宿主：里面每画一次都会换内容，靠内层 id 会「画完就找不到自己」
  const host = qs<HTMLElement>("#odPreviewHost") || null;
  const alive = () => Boolean(host && document.body.contains(host));
  const paint = (html: string) => {
    if (alive()) host!.innerHTML = html;
  };
  const showIframe = () => paint(`<iframe src="${url}" title="文件预览"></iframe>`);
  const showTrouble = (message: string, canRetry: boolean) => {
    paint(`<div class="od-preview-state">
      <p>${escapeHtml(message)}</p>
      <div class="od-preview-actions">
        ${canRetry ? `<button type="button" class="ord-btn primary" id="odPreviewRetry">重试转换</button>` : ""}
        <a class="ord-btn ghost" href="${rawUrl}">下载原文件</a>
      </div>
    </div>`);
    qs<HTMLElement>("#odPreviewRetry")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      button.textContent = "已提交…";
      const csrfToken = cookieValue("gj_csrf");
      await fetch(`/api/files/${encodeURIComponent(fileId)}/derive`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
        body: "{}"
      }).catch(() => undefined);
      void poll(0);
    });
  };

  const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const poll = async (attempt: number) => {
    // Office/HEIC 第一次打开通常还在排队，用 HEAD 探状态：不浪费带宽把整份文件拉两遍
    for (let step = attempt; step < 45; step += 1) {
      if (!alive()) return;
      let probe: Response;
      try {
        // 带 Range 只取 1 字节：成功时不把整份 PDF 拉两遍，失败时又能拿到 JSON 里的真实原因
        probe = await fetch(url, { credentials: "same-origin", headers: { Range: "bytes=0-0" } });
      } catch {
        showTrouble("网络中断，请稍后重试", true);
        return;
      }
      if (probe.ok) {
        const contentType = (probe.headers.get("content-type") || "").toLowerCase();
        // Range 探针拿到的是 206，总大小只在 content-range 的 "/总数" 里
        const totalBytes =
          Number((probe.headers.get("content-range") || "").split("/")[1]) ||
          Number(probe.headers.get("content-length") || 0);
        void probe.body?.cancel();
        // text/* 不能交给 iframe：Chrome 对 text/csv 直接触发下载，「预览」会变成下载文件。
        // 自己拉全文渲染 <pre>，txt/csv 都能看，也不依赖浏览器猜编码。
        if (contentType.startsWith("text/")) {
          if (totalBytes > 3 * 1024 * 1024) {
            showTrouble("文本文件超过 3MB，请下载后查看", false);
            return;
          }
          try {
            const textResponse = await fetch(url, { credentials: "same-origin" });
            paint(`<pre class="od-preview-text">${escapeHtml(await textResponse.text())}</pre>`);
          } catch {
            showTrouble("读取文本内容失败，请下载后查看", false);
          }
          return;
        }
        showIframe();
        return;
      }
      const body = await probe.json().catch(() => ({}) as { message?: string; canRetry?: boolean });
      if (probe.status === 425) {
        paint(`<div class="od-preview-state"><p>正在转换为可预览格式…</p>
          <small>首次打开 Office 文档或 HEIC 照片需要转一次，之后会直接打开。</small></div>`);
        await sleep(1200);
        continue;
      }
      if (probe.status === 409) {
        showTrouble(body.message || "转换失败，可下载原文件查看", Boolean(body.canRetry));
        return;
      }
      if (probe.status === 415) {
        showTrouble(body.message || "该格式暂不支持在线预览，请下载后查看", false);
        return;
      }
      showTrouble(body.message || `预览失败（HTTP ${probe.status}）`, true);
      return;
    }
    showTrouble("转换时间较长，请稍后再试或直接下载原文件", true);
  };
  void poll(0);
}

export function ordDownloadFile(fileId: string) {
  if (!fileId) return;
  // 用隐藏链接触发，保留后端设置的 Content-Disposition 与中文文件名
  const link = document.createElement("a");
  link.href = `/api/files/${encodeURIComponent(fileId)}/raw`;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

async function ordOpenCreateModal() {
  try {
    let customers = state.customers;
    if (!customers.length) {
      const result = await api<{ customers: Customer[] }>("/api/customers");
      state.customers = result.customers;
      customers = result.customers;
    }
    const options = customers.slice(0, 300).map((customer) =>
      `<option value="${customer.id}">${escapeHtml(customer.company)}${customer.country ? ` · ${escapeHtml(customer.country)}` : ""}</option>`
    ).join("");
    if (!options) {
      toast("还没有客户，先建客户再下单", "error");
      return;
    }
    openModal(
      "手工建单",
      `<p style="margin:0 0 12px;color:#46546f;font-size:12.5px">手工单用于没有走商机的老客户复购。选择客户后填一行明细即可，条款可以稍后补。</p>
       <label class="field-label">客户</label>
       <select id="ordNewCustomer" style="width:100%;height:34px;border:1px solid #e6dfd1;border-radius:9px;padding:0 8px">${options}</select>
       <label class="field-label" style="margin-top:10px">公司单号 <span style="color:#98a1b3;font-weight:400">公司实际用的订单号，不是系统编号；可以先留空</span></label>
       <input id="ordNewCompanyNo" style="width:100%" maxlength="80" placeholder="例如 HT-2026-1028" />
       <div style="display:grid;grid-template-columns:1fr 100px 100px 100px;gap:10px;margin-top:12px">
         <div><label class="field-label">品名</label><input id="ordNewProduct" style="width:100%" placeholder="例如：空压机" /></div>
         <div><label class="field-label">数量</label><input id="ordNewQty" type="number" min="1" value="1" style="width:100%" /></div>
         <div><label class="field-label">单价</label><input id="ordNewPrice" type="number" min="0" value="0" style="width:100%" /></div>
         <div><label class="field-label">币种</label><input id="ordNewCurrency" value="USD" style="width:100%" /></div>
       </div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px">
         <div><label class="field-label">Incoterm</label><input id="ordNewIncoterm" placeholder="FOB" style="width:100%" /></div>
         <div><label class="field-label">付款条件</label><input id="ordNewPayment" placeholder="30% T/T" style="width:100%" /></div>
       </div>`,
      `<button type="button" class="ord-btn ghost" data-modal-close>取消</button>
       <button type="button" class="ord-btn primary" id="ordNewSave">创建订单</button>`
    );
    qs<HTMLElement>("#ordNewSave")?.addEventListener("click", async () => {
      const product = qs<HTMLInputElement>("#ordNewProduct")?.value.trim() || "";
      if (!product) {
        toast("请填写品名", "error");
        return;
      }
      try {
        const result = await api<{ order: OrdRow }>("/api/orders", {
          method: "POST",
          body: JSON.stringify({
            customerId: qs<HTMLSelectElement>("#ordNewCustomer")?.value,
            companyOrderNo: qs<HTMLInputElement>("#ordNewCompanyNo")?.value.trim() || "",
            currency: qs<HTMLInputElement>("#ordNewCurrency")?.value.trim() || "USD",
            incoterm: qs<HTMLInputElement>("#ordNewIncoterm")?.value.trim() || "",
            paymentTerm: qs<HTMLInputElement>("#ordNewPayment")?.value.trim() || "",
            items: [{
              product,
              qty: Number(qs<HTMLInputElement>("#ordNewQty")?.value || 1),
              unitPrice: Number(qs<HTMLInputElement>("#ordNewPrice")?.value || 0)
            }]
          })
        });
        closeModal();
        toast(`已创建 ${result.order.companyOrderNo || result.order.orderNo}（系统编号 ${result.order.orderNo}）`);
        void openOrderDetail(result.order.id);
      } catch (error) {
        toast(error instanceof Error ? error.message : "建单失败", "error");
      }
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : "客户加载失败", "error");
  }
}
