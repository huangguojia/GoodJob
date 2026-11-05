/**
 * 发货。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { closeShipmentModal, confirmAction, editingShipmentId, openShipmentModal, pendingTrackingImageUrl, state } from "../prototype-api";
import { type Shipment, type ShipmentItem, type ShipmentStatus, type TradeDocument, type TradeDocumentHistoryResponse } from "./models";
import { escapeHtml, qs, qsa } from "./shared";
import { api, setButtonPending, toast } from "./ui";
import { COURIER_MAP, SHIPMENT_STATUS_LABEL } from "./products";
import { type ShipIconName, copyToClipboard, formatShipmentDate, renderGlobalMap, shIcon } from "./insights";
import { courierBadge, recordLog, stepperNodesHtml } from "./logs";
import { openContainerLoadForShipment } from "./container-load";

export let currentShipmentVisibleIds: string[] = [];

let shipmentStatusFilterValue = "";

export function renderShipments() {
  const all = state.shipments.slice();
  state.selectedShipmentIds = state.selectedShipmentIds.filter((id) => all.some((s) => s.id === id));
  const search = (qs<HTMLInputElement>("#shipmentSearch")?.value || "").trim().toLowerCase();

  const filtered = all.filter((s) => {
    if (shipmentStatusFilterValue && s.status !== shipmentStatusFilterValue) return false;
    if (search) {
      const hay = `${s.shipmentNo} ${s.trackingCode} ${s.customerName} ${s.dealTitle} ${COURIER_MAP[s.courier]?.label || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const chips = qs<HTMLElement>("#shipmentStatusChips");
  if (chips) {
    const order: ShipmentStatus[] = ["draft", "shipped", "in_transit", "delivered", "exception"];
    const counts: Record<string, number> = { all: all.length };
    order.forEach((st) => { counts[st] = all.filter((s) => s.status === st).length; });
    chips.innerHTML = `<button class="sh-chip ${shipmentStatusFilterValue === "" ? "is-active" : ""}" data-status="">全部 <i>${counts.all}</i></button>` +
      order.map((st) => `<button class="sh-chip sh-chip-${st} ${shipmentStatusFilterValue === st ? "is-active" : ""}" data-status="${st}">${shIcon(st as ShipIconName)}<span>${SHIPMENT_STATUS_LABEL[st]}</span> <i>${counts[st]}</i></button>`).join("");
    chips.querySelectorAll<HTMLButtonElement>(".sh-chip").forEach((b) => {
      b.addEventListener("click", () => { shipmentStatusFilterValue = b.dataset.status || ""; renderShipments(); });
    });
  }

  const setCount = (id: string, v: number) => { const el = qs<HTMLElement>(id); if (el) el.textContent = String(v); };
  setCount("#shipmentCount", all.length);
  setCount("#shipmentInTransit", all.filter((s) => s.status === "shipped" || s.status === "in_transit").length);
  setCount("#shipmentDelivered", all.filter((s) => s.status === "delivered").length);
  setCount("#shipmentException", all.filter((s) => s.status === "exception").length);

  const board = qs<HTMLElement>("#shipmentBoard");
  if (board) {
    if (filtered.length) {
      board.innerHTML = filtered.map((s) => shipmentRowHtml(s)).join("");
    } else if (all.length) {
      board.innerHTML = `<div class="sh-noresult">未找到匹配的发货单</div>`;
    } else {
      board.innerHTML = "";
    }
  }

  const visibleIds = filtered.map((s) => s.id);
  currentShipmentVisibleIds = visibleIds;
  const selVisible = visibleIds.filter((id) => state.selectedShipmentIds.includes(id)).length;
  const selectAll = qs<HTMLInputElement>("#shipmentSelectAll");
  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && selVisible === visibleIds.length;
    selectAll.indeterminate = selVisible > 0 && selVisible < visibleIds.length;
  }
  updateShipmentSelectionUI();

  if (board) {
    qsa<HTMLInputElement>("[data-select-shipment]", board).forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const id = checkbox.closest<HTMLElement>("[data-shipment-id]")?.dataset.shipmentId || "";
        if (!id) return;
        state.selectedShipmentIds = checkbox.checked
          ? Array.from(new Set([...state.selectedShipmentIds, id]))
          : state.selectedShipmentIds.filter((selectedId) => selectedId !== id);
        updateShipmentSelectionUI();
        const vis = visibleIds.filter((vid) => state.selectedShipmentIds.includes(vid)).length;
        if (selectAll) {
          selectAll.checked = visibleIds.length > 0 && vis === visibleIds.length;
          selectAll.indeterminate = vis > 0 && vis < visibleIds.length;
        }
      });
    });
  }

  const empty = qs<HTMLElement>("#shipmentEmpty");
  if (empty) empty.hidden = all.length > 0;
}

function shipmentRowHtml(s: Shipment): string {
  const courier = COURIER_MAP[s.courier];
  // 17TRACK can auto-detect the carrier from the tracking number.
  const canTrack = !!s.trackingCode?.trim();
  const dealText = [s.dealTitle, s.customerName].filter(Boolean).join(" · ") || "—";
  const stepper = stepperNodesHtml(s);
  const eta = s.estimatedArrival ? shipmentCountdown(s.estimatedArrival) : "—";
  const itemCount = (s.items || []).length;
  const latestEvent = [...(s.trackingEvents || [])].sort((a, b) => (a.time < b.time ? 1 : -1))[0];
  return `
  <article class="sh-row" data-shipment-id="${escapeHtml(s.id)}">
    <label class="sh-check"><input type="checkbox" data-select-shipment ${state.selectedShipmentIds.includes(s.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(s.shipmentNo || "发货单")}"><span></span></label>
    <div class="sh-row-main">
      <div class="sh-row-head">
        <b class="sh-no">${escapeHtml(s.shipmentNo || "—")}</b>
        <span class="sh-status sh-status-${s.status}">${shIcon(s.status as ShipIconName)}<span>${SHIPMENT_STATUS_LABEL[s.status] || s.status}</span></span>
        <span class="sh-deal">${escapeHtml(dealText)}</span>
      </div>
      <div class="sh-stepper">${stepper}</div>
      <div class="sh-row-meta">
        ${courier ? courierBadge(s.courier) : ""}
        ${s.trackingCode ? `<span class="sh-track">${escapeHtml(s.trackingCode)}</span>` : `<span class="sh-dim">未填运单号</span>`}
        ${itemCount ? `<span class="sh-items">${shIcon("copy")}<span>${itemCount} 项货物</span></span>` : ""}
        ${latestEvent?.location ? `<span class="sh-location">${shIcon("track")}<span>最新位置 ${escapeHtml(latestEvent.location)}</span></span>` : ""}
        ${s.syncError ? `<span class="sh-sync-error" title="${escapeHtml(s.syncError)}">${shIcon("warning")}<span>${escapeHtml(s.syncError)}</span></span>` : ""}
        <span class="sh-eta">${shIcon("arrow")}<span>预计到达 ${eta}</span></span>
      </div>
    </div>
    <div class="sh-row-actions">
      ${s.orderId ? `<button class="sh-btn ghost" data-shipment-order="${escapeHtml(s.orderId)}" type="button"><span>订单</span></button>` : ""}
      <button class="sh-btn" data-shipment-edit="${escapeHtml(s.id)}" type="button">${shIcon("edit")}<span>编辑</span></button>
      <button class="sh-btn ghost ${canTrack ? "sh-track-btn" : ""}" data-shipment-track="${escapeHtml(s.id)}" type="button" ${canTrack ? "" : "disabled title=\"需先填写运单号\""}>${shIcon("track")}<span>真实查询</span></button>
      <button class="sh-btn ghost" data-shipment-delete="${escapeHtml(s.id)}" type="button">${shIcon("trash")}<span>删除</span></button>
    </div>
  </article>`;
}

function shipmentCountdown(eta: string): string {
  const d = new Date(eta);
  if (isNaN(d.getTime())) return eta;
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return "已到达";
  const days = Math.ceil(diff / 86400000);
  return days <= 0 ? "今天" : `${days} 天后`;
}

function advanceButtonsHtml(s: Shipment): string {
  const nextMap: Record<string, ShipmentStatus> = { draft: "shipped", shipped: "in_transit", in_transit: "delivered" };
  const labels: Record<string, string> = { shipped: "标记已发货", in_transit: "标记运输中", delivered: "标记已签收" };
  const btns: string[] = [];
  const next = nextMap[s.status];
  if (next) btns.push(`<button class="sh-advance-btn" data-advance="${next}" type="button">${shIcon(next as ShipIconName)}<span>${labels[next]}</span></button>`);
  if (s.status !== "exception") btns.push(`<button class="sh-advance-btn danger" data-advance="exception" type="button">${shIcon("exception")}<span>标记异常</span></button>`);
  if (s.status === "exception") btns.push(`<button class="sh-advance-btn" data-advance="in_transit" type="button">${shIcon("in_transit")}<span>恢复运输中</span></button>`);
  return btns.join("");
}

function statusSourceBadge(s: Shipment): string {
  if (s.statusSource === "carrier") return `<span class="sh-src-badge sh-src-carrier">承运商数据</span>`;
  if (s.status === "draft") return `<span class="sh-src-badge">手动录入</span>`;
  return `<span class="sh-src-badge">手动状态</span>`;
}

function trackingTimelineHtml(s: Shipment): string {
  const events = s.trackingEvents || [];
  if (!events.length) {
    const hint = s.trackingCode ? "，点击「查询真实轨迹」获取承运商数据" : "，请先录入运单号";
    return `<div class="sh-drawer-sec"><h4>物流轨迹</h4><p class="pc-desc sh-dim">暂无承运商轨迹${hint}。</p></div>`;
  }
  const items = [...events]
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .map((e) => `
      <li class="sh-tl-item sh-tl-${e.status}">
        <span class="sh-tl-dot"></span>
        <div class="sh-tl-body">
          <p class="sh-tl-desc">${escapeHtml(e.description)}</p>
          <p class="sh-tl-meta"><span>${escapeHtml(e.location)}</span><span>${formatSyncTime(e.time)}</span></p>
        </div>
      </li>`).join("");
  const last = formatSyncTime(s.lastSyncedAt);
  return `<div class="sh-drawer-sec"><h4>物流轨迹 <span class="sh-tl-src">· 承运商数据 ${last}</span></h4><ul class="sh-timeline">${items}</ul></div>`;
}

export function openShipmentDrawer(s: Shipment) {
  const drawer = qs<HTMLElement>("#shipmentDrawer");
  const inner = qs<HTMLElement>("#shipmentDrawerInner");
  const scrim = qs<HTMLElement>("#shipmentScrim");
  if (!drawer || !inner) return;
  const courier = COURIER_MAP[s.courier];
  const canTrack = !!s.trackingCode?.trim();
  const latestEvent = [...(s.trackingEvents || [])].sort((a, b) => (a.time < b.time ? 1 : -1))[0];
  const stepper = stepperNodesHtml(s);
  const items = (s.items || []).map((it) => `<tr><td>${escapeHtml(it.productName || "—")}</td><td>${escapeHtml(it.model || "—")}</td><td>${escapeHtml(it.hsCode || "—")}</td><td>${it.quantity || 0} ${escapeHtml(it.unit || "")}</td><td>${it.netWeight || 0}/${it.grossWeight || 0}kg</td></tr>`).join("") || `<tr><td colspan="5" class="sh-dim">无货物明细</td></tr>`;
  inner.innerHTML = `
    <header class="sh-drawer-head">
      <div>
        <p class="sh-drawer-eyebrow">发货单详情</p>
        <h2>${escapeHtml(s.shipmentNo || "发货单")}</h2>
        <span class="sh-status sh-status-${s.status}">${shIcon(s.status as ShipIconName)}<span>${SHIPMENT_STATUS_LABEL[s.status] || s.status}</span></span>
        ${statusSourceBadge(s)}
      </div>
      <button class="sh-drawer-close" id="shipmentDrawerClose" type="button" aria-label="关闭">&times;</button>
    </header>
    <div class="sh-drawer-body">
      <div class="sh-stepper sh-stepper-lg">${stepper}</div>
      <dl class="sh-def">
        <div><dt>关联商机</dt><dd>${escapeHtml(s.dealTitle || "—")}</dd></div>
        <div><dt>客户</dt><dd>${escapeHtml(s.customerName || "—")}</dd></div>
        <div><dt>目的国家</dt><dd>${escapeHtml(s.destinationCountry || "—")}</dd></div>
        <div><dt>目的港</dt><dd>${escapeHtml(s.destinationPort || "—")}</dd></div>
        <div><dt>快递公司</dt><dd>${courier ? courierBadge(s.courier) : "—"}</dd></div>
        <div><dt>运单号</dt><dd class="pc-mono">${escapeHtml(s.trackingCode || "—")}</dd></div>
        <div><dt>发货日期</dt><dd>${formatShipmentDate(s.shippedAt)}</dd></div>
        <div><dt>预计到达</dt><dd>${formatShipmentDate(s.estimatedArrival)}</dd></div>
      </dl>
      ${s.destinationAddress ? `<div class="sh-drawer-sec"><h4>收货地址</h4><p class="pc-desc">${escapeHtml(s.destinationAddress)}</p></div>` : ""}
      ${latestEvent?.location ? `<div class="sh-drawer-sec sh-current-location"><h4>最新扫描位置</h4><p class="pc-desc"><b>${escapeHtml(latestEvent.location)}</b><br><span>${escapeHtml(latestEvent.description)}</span><small>数据时间：${formatSyncTime(latestEvent.time)}</small></p></div>` : ""}
      ${s.syncError ? `<div class="sh-drawer-sec sh-sync-error-panel"><h4>最近一次查询未完成</h4><p class="pc-desc">${escapeHtml(s.syncError)}</p></div>` : ""}
      ${s.trackingImageUrl ? `<div class="sh-drawer-sec"><h4>运单图片</h4><img class="sh-track-img" src="${s.trackingImageUrl.startsWith("http") ? s.trackingImageUrl : location.origin + s.trackingImageUrl}" alt="运单号图片"></div>` : ""}
      <div class="sh-drawer-sec"><h4>货物明细</h4>
        <table class="sh-items-table"><thead><tr><th>品名</th><th>型号</th><th>HS</th><th>数量</th><th>净重/毛重</th></tr></thead><tbody>${items}</tbody></table>
      </div>
      ${trackingTimelineHtml(s)}
      ${s.note ? `<div class="sh-drawer-sec"><h4>备注</h4><p class="pc-desc">${escapeHtml(s.note)}</p></div>` : ""}
    </div>
    <footer class="sh-drawer-foot">
      <div class="sh-advance">${advanceButtonsHtml(s)}</div>
      <span class="sh-foot-spacer"></span>
      ${courier && s.trackingCode ? `<button class="btn" id="shipmentDrawerSite" type="button">${shIcon("track")}<span>官网查询</span></button>` : ""}
      ${s.trackingCode?.trim() ? `<button class="btn btn-primary" id="shipmentDrawerTrack" type="button">${shIcon("refresh")}<span>查询真实轨迹</span></button>` : `<button class="btn btn-primary" id="shipmentDrawerTrack" type="button" disabled title="需先填写运单号">${shIcon("refresh")}<span>查询真实轨迹</span></button>`}
      <button class="btn" id="shipmentDrawerLoad" type="button" title="将本单货物清单载入装箱计算">${shIcon("shipped")}<span>计算装柜</span></button>
      <button class="btn" id="shipmentDrawerEdit" type="button">${shIcon("edit")}<span>编辑</span></button>
    </footer>`;
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  if (scrim) scrim.hidden = false;
  qs<HTMLElement>("#shipmentDrawerClose")?.addEventListener("click", closeShipmentDrawer);
  qs<HTMLElement>("#shipmentDrawerEdit")?.addEventListener("click", () => { closeShipmentDrawer(); openShipmentModal(s); });
  qs<HTMLElement>("#shipmentDrawerTrack")?.addEventListener("click", () => void syncShipmentNow(s));
  qs<HTMLElement>("#shipmentDrawerSite")?.addEventListener("click", () => openCarrierSite(s));
  qs<HTMLElement>("#shipmentDrawerLoad")?.addEventListener("click", () => { closeShipmentDrawer(); void openContainerLoadForShipment(s); });
  inner.querySelectorAll<HTMLButtonElement>("[data-advance]").forEach((b) => {
    b.addEventListener("click", () => { const st = b.dataset.advance as ShipmentStatus; void updateShipmentStatus(s.id, st); });
  });
  scrim?.addEventListener("click", closeShipmentDrawer, { once: true });
}

function closeShipmentDrawer() {
  const drawer = qs<HTMLElement>("#shipmentDrawer");
  const scrim = qs<HTMLElement>("#shipmentScrim");
  if (drawer) { drawer.classList.remove("is-open"); drawer.setAttribute("aria-hidden", "true"); }
  if (scrim) scrim.hidden = true;
}

async function updateShipmentStatus(id: string, status: ShipmentStatus) {
  const s = state.shipments.find((x) => x.id === id);
  if (!s) return;
  const payload = { ...s, id, status };
  try {
    const result = await api<{ shipment: Shipment; shipments: Shipment[] }>("/api/tools/shipments", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.shipments = result.shipments || state.shipments;
    renderShipments();
    const cur = state.shipments.find((x) => x.id === id);
    if (cur && qs<HTMLElement>("#shipmentDrawer")?.classList.contains("is-open")) openShipmentDrawer(cur);
    toast("状态已更新", "ok");
    void recordLog({
      level: "success", category: "shipment", action: "change_status",
      message: `发货单「${s.shipmentNo || s.dealTitle}」状态变更为「${SHIPMENT_STATUS_LABEL[status]}」`,
      meta: { id: s.id, status }
    });
  } catch (err) {
    toast(err instanceof Error ? err.message : "更新失败", "error");
  }
}

function updateShipmentSelectionUI() {
  const count = state.selectedShipmentIds.length;
  const countEl = qs<HTMLElement>("#shipmentSelCount");
  if (countEl) {
    countEl.textContent = `已选 ${count} 项`;
    countEl.hidden = count === 0;
  }
  const del = qs<HTMLButtonElement>("#shipmentBulkDelete");
  if (del) del.disabled = count === 0;
}

export function addShipmentItemRow(item?: Partial<ShipmentItem>) {
  const tbody = qs<HTMLElement>("#shipmentItemBody");
  if (!tbody) return;
  const id = item?.id || `si_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const val = (k: keyof ShipmentItem, fallback = "") => (item && item[k] != null ? String(item[k]) : fallback);
  const tr = document.createElement("tr");
  tr.dataset.itemId = id;
  tr.innerHTML = `
    <td><input type="text" data-field="productName" value="${escapeHtml(val("productName"))}" placeholder="品名" maxlength="200"></td>
    <td><input type="text" data-field="model" value="${escapeHtml(val("model"))}" placeholder="型号" maxlength="200"></td>
    <td><input type="text" data-field="hsCode" value="${escapeHtml(val("hsCode"))}" placeholder="HS" maxlength="40"></td>
    <td><input type="number" data-field="quantity" value="${escapeHtml(val("quantity", "1"))}" min="0" step="1"></td>
    <td><input type="text" data-field="unit" value="${escapeHtml(val("unit", "pcs"))}" maxlength="20"></td>
    <td><input type="number" data-field="netWeight" value="${escapeHtml(val("netWeight"))}" min="0" step="0.001"></td>
    <td><input type="number" data-field="grossWeight" value="${escapeHtml(val("grossWeight"))}" min="0" step="0.001"></td>
    <td><input type="number" data-field="length" value="${escapeHtml(val("length"))}" min="0" step="0.1"></td>
    <td><input type="number" data-field="width" value="${escapeHtml(val("width"))}" min="0" step="0.1"></td>
    <td><input type="number" data-field="height" value="${escapeHtml(val("height"))}" min="0" step="0.1"></td>
    <td><input type="number" data-field="volume" value="${escapeHtml(val("volume"))}" min="0" step="0.001"></td>
    <td class="item-del"><button class="btn btn-ghost" data-item-remove type="button">×</button></td>`;
  tbody.appendChild(tr);
  tr.querySelector<HTMLButtonElement>("[data-item-remove]")?.addEventListener("click", () => tr.remove());
}

function collectShipmentItems(): ShipmentItem[] {
  const tbody = qs<HTMLElement>("#shipmentItemBody");
  if (!tbody) return [];
  return Array.from(tbody.querySelectorAll("tr")).map((tr) => {
    const get = (k: string) => (tr.querySelector<HTMLInputElement>(`[data-field="${k}"]`)?.value || "").trim();
    const num = (k: string) => { const n = Number(get(k)); return Number.isFinite(n) ? n : 0; };
    return {
      id: tr.dataset.itemId || `si_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      productName: get("productName"),
      model: get("model"),
      hsCode: get("hsCode"),
      quantity: num("quantity"),
      unit: get("unit") || "pcs",
      netWeight: num("netWeight"),
      grossWeight: num("grossWeight"),
      length: num("length"),
      width: num("width"),
      height: num("height"),
      volume: num("volume"),
      note: ""
    };
  });
}
export async function searchDeals(keyword: string) {
  const results = qs<HTMLElement>("#shipmentDealResults");
  if (!results) return;
  const kw = keyword.trim();
  if (!kw) { results.hidden = true; results.innerHTML = ""; return; }
  try {
    const data = await api<{ deals: Array<{ id: string; title: string; product: string; customerId: string }> }>(
      `/api/deals/closed?status=${encodeURIComponent("成交")}&keyword=${encodeURIComponent(kw)}&pageSize=8`
    );
    const deals = data.deals || [];
    if (!deals.length) {
      results.innerHTML = `<div class="deal-result"><small>未找到成交商机</small></div>`;
      results.hidden = false;
      return;
    }
    results.innerHTML = deals.map((d) => `
      <div class="deal-result" data-deal-id="${escapeHtml(d.id)}" data-deal-title="${escapeHtml(d.title)}">
        <b>${escapeHtml(d.title)}</b>
        <small>${escapeHtml(d.product || "")}</small>
      </div>`).join("");
    results.hidden = false;
    results.querySelectorAll<HTMLElement>(".deal-result[data-deal-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.dealId || "";
        const title = el.dataset.dealTitle || "";
        selectDeal(id, title);
      });
    });
  } catch {
    results.hidden = true;
  }
}

export function shipmentDestinationDefaults(dealId: string, customerName: string) {
  const deal = dealId ? state.deals.find((item) => item.id === dealId) : undefined;
  const customer = state.customers.find((item) =>
    (deal?.customerId && item.id === deal.customerId)
    || (customerName && item.company.trim().toLocaleLowerCase() === customerName.trim().toLocaleLowerCase())
  );
  const documents = Array.from(new Map(
    [...(state.tradeDocuments || []), ...(state.globalRouteDocuments || [])].map((document) => [document.id, document])
  ).values());
  const related = documents.filter((document) =>
    (dealId && document.dealId === dealId)
    || (customer?.id && document.customerId === customer.id)
    || (customerName && document.buyer.trim().toLocaleLowerCase() === customerName.trim().toLocaleLowerCase())
  ).sort((left, right) => {
    const priorities: Partial<Record<TradeDocument["type"], number>> = { SHIPPING: 0, PL: 1, CI: 2, CUSTOMS: 3 };
    const priority = (document: TradeDocument) => priorities[document.type] ?? 9;
    return priority(left) - priority(right) || (right.updatedAt || "").localeCompare(left.updatedAt || "");
  });
  const document = related.find((item) => item.portDischarge || item.buyerAddress);
  return {
    country: customer?.country === "未知" ? "" : customer?.country || "",
    port: document?.portDischarge || customer?.defaultPortDischarge || "",
    address: document?.buyerAddress || customer?.billingAddress || ""
  };
}

function fillShipmentDestinationDefaults(dealId: string, customerName: string, overwrite = false) {
  const defaults = shipmentDestinationDefaults(dealId, customerName);
  const set = (selector: string, value: string) => {
    const input = qs<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (input && value && (overwrite || !input.value.trim())) input.value = value;
  };
  set("#shipmentDestinationCountry", defaults.country);
  set("#shipmentDestinationPort", defaults.port);
  set("#shipmentDestinationAddress", defaults.address);
}

function selectDeal(id: string, title: string) {
  const idEl = qs<HTMLInputElement>("#shipmentDealId");
  const titleEl = qs<HTMLInputElement>("#shipmentDealSearch");
  const hint = qs<HTMLElement>("#shipmentDealHint");
  const customerEl = qs<HTMLInputElement>("#shipmentCustomerName");
  if (idEl) idEl.value = id;
  if (titleEl) titleEl.value = title;
  if (hint) { hint.textContent = `已关联：${title}`; hint.style.color = "var(--ink)"; }
  // 反查客户名（用于列表展示，若后端未回传）
  const deal = state.deals?.find((d) => d.id === id);
  if (customerEl && deal?.customerId) {
    const customer = state.customers?.find((c) => c.id === deal.customerId);
    if (customer) customerEl.value = customer.company || "";
  }
  fillShipmentDestinationDefaults(id, customerEl?.value || "", true);
  const results = qs<HTMLElement>("#shipmentDealResults");
  if (results) results.hidden = true;
}

/** 打开承运商官网查询页（保留原「查询」能力，作为二次核对入口） */
function openCarrierSite(shipment: Shipment) {
  const courier = COURIER_MAP[shipment.courier];
  if (!courier || !shipment.trackingCode) {
    toast("请先填写快递公司与运单号", "error");
    return;
  }
  void copyToClipboard(shipment.trackingCode);
  const url = courier.url.replace("{code}", encodeURIComponent(shipment.trackingCode));
  window.open(url, "_blank");
  toast(`已复制运单号并打开${courier.label}官网查询页`, "ok");
}

/** 单条真实查询：以承运商 API 返回的轨迹为准，回写状态与轨迹节点 */
export async function syncShipmentNow(shipment: Shipment) {
  if (!shipment.trackingCode?.trim()) {
    toast("该单未录入运单号，无法同步官网", "error");
    return;
  }
  try {
    const result = await api<{ shipment: Shipment; shipments: Shipment[]; synced: boolean; reason?: string }>(
      `/api/tools/shipments/${encodeURIComponent(shipment.id)}/sync`,
      { method: "POST", body: "{}" }
    );
    state.shipments = result.shipments || state.shipments;
    renderShipments();
    const cur = state.shipments.find((x) => x.id === shipment.id);
    if (cur && qs<HTMLElement>("#shipmentDrawer")?.classList.contains("is-open")) openShipmentDrawer(cur);
    if (result.synced) {
      const ev = (cur?.trackingEvents || []).length;
      toast(`已获取承运商真实轨迹：${SHIPMENT_STATUS_LABEL[cur?.status || "draft"]}（${ev} 个轨迹节点）`, "ok");
      void recordLog({
        level: "success", category: "shipment", action: "sync_tracking",
        message: `发货单「${cur?.shipmentNo || cur?.dealTitle}」已获取承运商真实轨迹，状态「${SHIPMENT_STATUS_LABEL[cur?.status || "draft"]}」`,
        meta: { id: cur?.id, status: cur?.status }
      });
    } else {
      toast(result.reason || "无需同步", "info");
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : "同步失败", "error");
  }
}

/** 批量同步当前用户在途发货单（视图打开时自动调用） */
export async function syncAllShipments() {
  try {
    const result = await api<{ updated: number; total: number; shipments: Shipment[] }>(
      "/api/tools/shipments/sync-all",
      { method: "POST", body: "{}" }
    );
    if (result.shipments && result.shipments.length) state.shipments = result.shipments;
    const active = qs<HTMLElement>(".view.active")?.id;
    if (active === "shipments") renderShipments();
    if (active === "global-map") renderGlobalMap();
    if (result.updated > 0) {
      toast(`已获取 ${result.updated} 张发货单的承运商真实轨迹`, "ok");
    }
  } catch (err) {
    // 同步失败不应阻断页面；静默
    console.warn("syncAllShipments failed:", err);
  }
}

export async function syncGlobalRouteDocuments(): Promise<void> {
  try {
    const result = await api<TradeDocumentHistoryResponse>("/api/trade-documents/history?page=1&pageSize=50");
    state.globalRouteDocuments = result.documents || [];
    if (qs<HTMLElement>("#global-map.active")) renderGlobalMap();
  } catch (err) {
    // 历史单据读取失败时仍保留发货记录路线，不能阻断地图使用。
    console.warn("syncGlobalRouteDocuments failed:", err);
  }
}

function formatSyncTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function saveShipment() {
  const trackingCode = (qs<HTMLInputElement>("#shipmentTrackingCode")?.value || "").trim();
  if (!trackingCode) { toast("请填写运单号（可上传图片 AI 识别）", "error"); return; }
  const get = (sel: string) => (qs<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(sel)?.value || "").trim();
  const dealId = qs<HTMLInputElement>("#shipmentDealId")?.value || "";
  const dealSearchValue = qs<HTMLInputElement>("#shipmentDealSearch")?.value || "";
  // 只有真正选中了成交商机，才将搜索框内容作为商机标题；否则清空，避免搜索过程中的临时文本被保存
  const dealTitle = dealId ? dealSearchValue : "";
  const customerName = qs<HTMLInputElement>("#shipmentCustomerName")?.value || "";
  const payload = {
    id: editingShipmentId || undefined,
    shipmentNo: get("#shipmentNo"),
    dealId,
    dealTitle,
    customerName,
    destinationCountry: get("#shipmentDestinationCountry"),
    destinationPort: get("#shipmentDestinationPort"),
    destinationAddress: get("#shipmentDestinationAddress"),
    courier: get("#shipmentCourier"),
    trackingCode,
    trackingImageUrl: pendingTrackingImageUrl,
    status: get("#shipmentStatus") || "draft",
    shippedAt: get("#shipmentShippedAt"),
    estimatedArrival: get("#shipmentEta"),
    note: get("#shipmentNote"),
    items: collectShipmentItems()
  };
  const btn = qs<HTMLButtonElement>("#shipmentSaveButton");
  if (btn) { btn.disabled = true; btn.textContent = "保存中…"; }
  const wasEditing = !!editingShipmentId;
  try {
    const result = await api<{ shipment: Shipment; shipments: Shipment[] }>("/api/tools/shipments", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.shipments = result.shipments || [];
    closeShipmentModal();
    renderShipments();
    toast(wasEditing ? "已更新发货单" : "已新增发货单", "ok");
    void recordLog({
      level: "success", category: "shipment", action: wasEditing ? "update_shipment" : "create_shipment",
      message: `${wasEditing ? "更新" : "新增"}发货单「${payload.shipmentNo || payload.dealTitle}」`,
      meta: { id: result.shipment?.id, shipmentNo: payload.shipmentNo, status: payload.status }
    });
  } catch (err) {
    toast(err instanceof Error ? err.message : "保存失败", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "保存"; }
  }
}

export async function deleteShipment(id: string) {
  const shipment = state.shipments.find((s) => s.id === id);
  if (!await confirmAction({
    title: "删除发货单",
    message: `将删除发货单「${shipment?.shipmentNo || shipment?.dealTitle || "未命名"}」。`,
    consequences: ["发货状态和物流记录会被移除", "此操作无法撤销"],
    confirmLabel: "删除发货单"
  })) return;
  try {
    const result = await api<{ shipments: Shipment[] }>(`/api/tools/shipments/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.shipments = result.shipments || state.shipments.filter((s) => s.id !== id);
    closeShipmentModal();
    renderShipments();
    toast("已删除发货单", "ok");
    void recordLog({ level: "warning", category: "shipment", action: "delete_shipment", message: `删除发货单「${shipment?.shipmentNo || shipment?.dealTitle || "未命名"}」`, meta: { id } });
  } catch (err) {
    toast(err instanceof Error ? err.message : "删除失败", "error");
  }
}

export async function bulkDeleteShipments() {
  const ids = state.selectedShipmentIds.filter((id) => state.shipments.some((s) => s.id === id));
  if (!ids.length) {
    toast("请先勾选要删除的发货单", "error");
    return;
  }
  const names = state.shipments.filter((s) => ids.includes(s.id)).map((s) => s.shipmentNo || s.dealTitle);
  if (!await confirmAction({
    title: `批量删除 ${ids.length} 张发货单`,
    message: "发货单及其物流记录将被永久移除。",
    detail: `${names.slice(0, 6).join("、")}${names.length > 6 ? `等 ${ids.length} 张` : ""}`,
    consequences: ["选中的发货状态与物流信息会被删除", "此操作无法撤销"],
    confirmLabel: `删除 ${ids.length} 张发货单`,
    verificationText: String(ids.length)
  })) return;
  const button = qs<HTMLButtonElement>("#shipmentBulkDelete");
  try {
    setButtonPending(button, true, "删除", `正在删除 ${ids.length} 张`);
    let shipments = state.shipments;
    for (const id of ids) {
      const result = await api<{ shipments: Shipment[] }>(`/api/tools/shipments/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (result.shipments) shipments = result.shipments;
    }
    state.shipments = shipments;
    state.selectedShipmentIds = [];
    renderShipments();
    toast(`已删除 ${ids.length} 张发货单`, "ok");
  } catch (err) {
    toast(err instanceof Error ? err.message : "批量删除失败", "error");
  } finally {
    setButtonPending(button, false, "删除", "删除中");
    if (button) button.disabled = state.selectedShipmentIds.length === 0;
  }
}
