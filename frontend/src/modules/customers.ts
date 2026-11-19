/**
 * 客户列表、客户公池、客户地图、客户订单。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { type CustomerMapController, type CustomerMapRegion } from "../customer-map";
import { closeModal, openModal, state } from "../prototype-api";
import { type Customer, type Deal } from "./models";
import { badge, escapeHtml, money, qs, qsa } from "./shared";
import {
  closeCustomerDrawer, contactDockElement, countryFlag, customerContactDockSubject, hideContactDock,
  isContactDockRowAction, openCustomerDetailPage, openCustomerDrawer, poolCustomerContactDockSubject,
  refreshContactDock, renderCustomerDrawer, selectCustomerForContact, selectPoolCustomerForContact
} from "./customer-detail";
import { openWhatsAppForContact } from "./development-email";
import { whatsAppEntryAttrs, whatsAppEntryClass } from "./whatsapp";
import { api, toast } from "./ui";
import { customerGradeHtml, customerGradeLabel, customerGradeValue, filteredCustomers } from "./leads";
import { formatDateTime } from "./deals";
import { bulkDeleteCustomers, openCustomerModal } from "./customer-intake";
import { type OrdListResponse, openOrderDetail, ordBadge, ordDay, ordIdentity } from "./orders";

export let customerMapController: CustomerMapController | null = null;
let customerMapRegion: CustomerMapRegion | null = null;
let customerMapLoading = false;

function customerOutcomeLabel() {
  return state.customerOutcomeFilter === "won" ? "已成交客户" : "未成交客户";
}

export function customerWonLabel(customer: Customer) {
  if (!customer.hasWonDeal) return "未成交";
  return customer.wonDealCount ? `已成交 ${customer.wonDealCount} 次` : "已成交客户";
}

function customerPageRows(customers: Customer[]) {
  const pageCount = Math.max(1, Math.ceil(customers.length / state.customerPageSize));
  state.customerPage = Math.min(Math.max(1, state.customerPage), pageCount);
  const start = (state.customerPage - 1) * state.customerPageSize;
  return {
    pageCount,
    start,
    rows: customers.slice(start, start + state.customerPageSize)
  };
}

function renderCustomerPagination(total: number, pageCount: number, start: number) {
  const summary = qs<HTMLElement>("#customerPageSummary");
  const number = qs<HTMLElement>("#customerPageNumber");
  const prev = qs<HTMLButtonElement>("#customerPrevPage");
  const next = qs<HTMLButtonElement>("#customerNextPage");
  const size = qs<HTMLSelectElement>("#customerPageSize");
  if (summary) summary.textContent = total
    ? `共 ${total} 条，当前 ${start + 1}-${Math.min(start + state.customerPageSize, total)} 条`
    : "共 0 条";
  if (number) number.textContent = `${state.customerPage} / ${pageCount}`;
  if (prev) prev.disabled = state.customerPage <= 1;
  if (next) next.disabled = state.customerPage >= pageCount;
  if (size) size.value = String(state.customerPageSize);
}

function boardSearchMatch(customer: Customer) {
  const query = state.customerSearch.trim().toLowerCase();
  if (!query) return true;
  return [customer.company, customer.contact, customer.country, customer.ownerName, customer.whatsapp]
    .some((value) => (value || "").toLowerCase().includes(query));
}

function customerBoardCardHtml(customer: Customer, key: string) {
  const flag = countryFlag(customer.country);
  const reminder = customer.nextReminder.includes("逾期") ? badge(customer.nextReminder, "red") : escapeHtml(customer.nextReminder);
  const wonBadge = badge(customerWonLabel(customer), customer.hasWonDeal ? "green" : "gray");
  const pipelineStage = customer.pipelineStage || "暂无活跃商机";
  const pipelineBadge = badge(pipelineStage, pipelineStage === "成交" || pipelineStage === "谈判" ? "green" : pipelineStage === "已报价" ? "amber" : "");
  const grade = customerGradeValue(customer);
  const owner = key === "pool" ? (customer.previousOwnerName ? `原 ${customer.previousOwnerName}` : "公池") : (customer.ownerName || "未分配");
  return `<article class="customer-board-card" data-open-customer="${escapeHtml(customer.id)}">
    <div class="customer-board-card-top">
      <span class="company"><span class="flag">${flag}</span>${escapeHtml(customer.company)}</span>
      ${customerGradeHtml(customer)}
    </div>
    <div class="meta"><b>${escapeHtml(customer.country)}</b> · ${escapeHtml(customer.contact)} · ${escapeHtml(owner)}</div>
    <div class="badge-row">${wonBadge}${pipelineBadge}</div>
    <div class="customer-board-card-row"><span class="label">在手商机</span><b>${customer.activeDealCount || 0} 个</b></div>
    <div class="customer-board-card-row"><span class="label">下一提醒</span><b>${reminder}</b></div>
    <div class="standard-row"><span class="label">标准</span><span class="value">${grade} · ${customerGradeLabel(grade)}</span></div>
  </article>`;
}

function renderCustomerBoard() {
  const board = qs<HTMLElement>("#customerBoardWorkspace");
  if (!board) return;
  const owned = filteredCustomers(state.customers);
  const won = owned.filter((customer) => customer.hasWonDeal);
  const intent = owned.filter((customer) => !customer.hasWonDeal);
  const pool = (state.publicCustomers || []).filter(boardSearchMatch);
  const columns: Array<{ key: string; title: string; list: Customer[] }> = [
    { key: "won", title: "已成交客户", list: won },
    { key: "intent", title: "意向客户", list: intent },
    { key: "pool", title: "公池客户", list: pool }
  ];
  board.innerHTML = columns.map((col) => `
    <section class="customer-board-col customer-board-col--${col.key}">
      <div class="customer-board-col-head">
        <span class="col-title"><i class="col-dot"></i>${col.title}</span>
        <span class="col-count">${col.list.length}</span>
      </div>
      <div class="customer-board-col-body">
        ${col.list.length ? col.list.map((customer) => customerBoardCardHtml(customer, col.key)).join("") : `<div class="customer-board-empty">暂无客户</div>`}
      </div>
    </section>
  `).join("");
  qsa<HTMLElement>("[data-open-customer]", board).forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.openCustomer || "";
      const customer = state.customers.find((item) => item.id === id) || (state.publicCustomers || []).find((item) => item.id === id);
      if (!customer) return;
      state.selectedCustomerId = id;
      renderCustomerDrawer(customer);
      openCustomerDrawer();
    });
  });
}

export function renderCustomers(customers: Customer[]) {
  const tbody = qs<HTMLElement>("#customers tbody");
  if (!tbody) return;
  const pageTitle = qs<HTMLElement>("#customerPageTitle");
  if (pageTitle) pageTitle.textContent = customerOutcomeLabel();
  const mode = state.customerViewMode;
  const listActive = mode === "list";
  const mapActive = mode === "map";
  const boardActive = mode === "board";
  qs<HTMLElement>("#customerListWorkspace")?.classList.toggle("is-hidden", !listActive);
  qs<HTMLElement>("#customerMapWorkspace")?.classList.toggle("is-hidden", !mapActive);
  qs<HTMLElement>("#customerBoardWorkspace")?.classList.toggle("is-hidden", !boardActive);
  const modeSelect = qs<HTMLSelectElement>("#customerViewModeSelect");
  if (modeSelect) modeSelect.value = mode;
  customerMapController?.setActive(mapActive);
  // 看板视图里的卡片不参与「点行出联系条」，切过去就等于把这条状态收掉（切回来也要重新点）。
  if (boardActive) { hideContactDock("customers"); renderCustomerBoard(); return; }
  const visibleCustomers = filteredCustomers(customers);
  const { pageCount, start, rows: pageCustomers } = customerPageRows(visibleCustomers);
  renderCustomerPagination(visibleCustomers.length, pageCount, start);
  state.selectedCustomerIds = state.selectedCustomerIds.filter((id) => customers.some((customer) => customer.id === id));
  renderCustomerBulkBar(pageCustomers);
  tbody.innerHTML = pageCustomers.length ? pageCustomers.map((customer) => {
    const checked = state.selectedCustomerIds.includes(customer.id);
    const reminder = customer.nextReminder.includes("逾期") ? badge(customer.nextReminder, "red") : escapeHtml(customer.nextReminder);
    const pipelineStage = customer.pipelineStage || "暂无活跃商机";
    const activeDealCount = customer.activeDealCount || 0;
    const customerWhatsapp = customerContactDetails(customer).whatsapp;
    return `<tr class="${customer.id === state.selectedCustomerId ? "selected" : ""} ${checked ? "checked" : ""}">
    <td><input type="checkbox" data-select-customer ${checked ? "checked" : ""}></td>
    <td><div class="company">${countryFlag(customer.country)}<div><button type="button" class="customer-name ${activeDealCount > 0 ? "has-active-deal" : ""}" data-open-customer="${escapeHtml(customer.id)}">${escapeHtml(customer.company)}</button><span>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact)} · ${escapeHtml(customer.ownerName || "未分配")}</span></div></div></td>
    <td><div class="customer-follow-cell">${badge(pipelineStage, pipelineStage === "成交" || pipelineStage === "谈判" ? "green" : pipelineStage === "已报价" ? "amber" : "")}<span>${activeDealCount} 个活跃商机</span></div></td>
    <td><div class="customer-follow-cell"><b>${escapeHtml(customer.source || "未登记")}</b><span>获客渠道</span></div></td>
    <td><div class="customer-value-cell">${customerGradeHtml(customer)}${badge(customerWonLabel(customer), customer.hasWonDeal ? "green" : "gray")}</div></td>
    <td><div class="customer-follow-cell"><span>${customer.lastActivityAt ? `最近 ${escapeHtml(formatDateTime(customer.lastActivityAt))}` : "暂无跟进"}</span><b>${reminder}</b></div></td>
    <td><button class="${whatsAppEntryClass(customerWhatsapp)}" type="button" data-customer-whatsapp ${whatsAppEntryAttrs(customerWhatsapp)}>WhatsApp</button></td>
    <td><div class="customer-row-actions"><button class="btn" data-open-customer-page>全景</button><button class="btn" data-edit-customer>编辑</button><button class="btn" data-release-customer>放入公池</button></div></td>
  </tr>`;
  }).join("") : `<tr><td colspan="8" class="empty-cell">当前${customerOutcomeLabel()}筛选下暂无客户。</td></tr>`;
  const mobile = qs<HTMLElement>("#customerMobileList");
  if (mobile) mobile.innerHTML = pageCustomers.length ? pageCustomers.map((customer) => `
    <article class="customer-mobile-card" data-customer-mobile-id="${escapeHtml(customer.id)}">
      <span class="customer-mobile-top"><span class="customer-mobile-company">${countryFlag(customer.country)}<button type="button" class="customer-name ${(customer.activeDealCount || 0) > 0 ? "has-active-deal" : ""}" data-open-customer="${escapeHtml(customer.id)}">${escapeHtml(customer.company)}</button></span>${badge(customer.pipelineStage || "暂无商机", customer.pipelineStage === "谈判" || customer.pipelineStage === "成交" ? "green" : customer.pipelineStage === "已报价" ? "amber" : "gray")}</span>
      <span>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact)} · ${escapeHtml(customer.ownerName || "未分配")}</span>
      <span class="customer-mobile-meta"><i>来源 · ${escapeHtml(customer.source || "未登记")}</i><i>${customerGradeValue(customer)}级 · ${customerGradeLabel(customerGradeValue(customer))}</i><i>${customerWonLabel(customer)}</i><i>${customer.activeDealCount || 0} 个活跃商机</i><i>${escapeHtml(customer.nextReminder || "待安排")}</i><i>${customer.lastActivityAt ? `最近 ${escapeHtml(formatDateTime(customer.lastActivityAt))}` : "暂无跟进"}</i></span>
      <div class="customer-row-actions"><button class="${whatsAppEntryClass(customerContactDetails(customer).whatsapp)}" type="button" data-customer-mobile-whatsapp ${whatsAppEntryAttrs(customerContactDetails(customer).whatsapp)}>WhatsApp</button><button class="btn" type="button" data-customer-mobile-pool>放入公池</button></div>
    </article>`).join("") : `<div class="empty-cell">当前${customerOutcomeLabel()}筛选下暂无客户。</div>`;
  qsa<HTMLElement>("tr", tbody).forEach((row, index) => {
    const customer = pageCustomers[index];
    if (!customer) return;
    row.dataset.customerId = customer.id;
    row.classList.toggle("selected", customer.id === (state.selectedCustomerId || customers[0]?.id));
    row.addEventListener("click", (event) => {
      if (isContactDockRowAction(event.target)) return;
      selectCustomerForContact(customer);
    });
  });
  refreshContactDock("customers", (id) => {
    const customer = state.customers.find((item) => item.id === id);
    return customer ? customerContactDockSubject(customer) : null;
  });
  qsa<HTMLButtonElement>("[data-open-customer]", qs("#customers")!).forEach((button) => button.addEventListener("click", () => {
    const customer = customers.find((item) => item.id === button.dataset.openCustomer);
    if (!customer) return;
    state.selectedCustomerId = customer.id;
    renderCustomerDrawer(customer);
    openCustomerDrawer();
    qsa<HTMLElement>("tr", tbody).forEach((item) => item.classList.toggle("selected", item.dataset.customerId === customer.id));
  }));
  qsa<HTMLInputElement>("[data-select-customer]", tbody).forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      const id = checkbox.closest<HTMLElement>("tr")?.dataset.customerId || "";
      if (!id) return;
      state.selectedCustomerIds = checkbox.checked
        ? Array.from(new Set([...state.selectedCustomerIds, id]))
        : state.selectedCustomerIds.filter((selectedId) => selectedId !== id);
      renderCustomers(state.customers);
    });
  });
  qsa<HTMLButtonElement>("[data-edit-customer]", tbody).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const customer = state.customers.find((item) => item.id === button.closest<HTMLElement>("tr")?.dataset.customerId);
      if (customer) openCustomerModal(customer);
    });
  });
  qsa<HTMLButtonElement>("[data-open-customer-page]", tbody).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const customer = state.customers.find((item) => item.id === button.closest<HTMLElement>("tr")?.dataset.customerId);
      if (customer) openCustomerDetailPage(customer);
    });
  });
  qsa<HTMLButtonElement>("[data-customer-whatsapp]", tbody).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const customer = state.customers.find((item) => item.id === button.closest<HTMLElement>("tr")?.dataset.customerId);
      if (customer) void openWhatsAppForContact({ phone: customerContactDetails(customer).whatsapp, displayName: customer.contact || customer.company });
    });
  });
  qsa<HTMLButtonElement>("[data-release-customer]", tbody).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const customer = state.customers.find((item) => item.id === button.closest<HTMLElement>("tr")?.dataset.customerId);
      if (customer) openCustomerReleaseModal(customer);
    });
  });
  qsa<HTMLElement>("[data-customer-mobile-id]", qs("#customerMobileList")!).forEach((card) => {
    const customer = state.customers.find((item) => item.id === card.dataset.customerMobileId);
    if (!customer) return;
    card.addEventListener("click", (event) => {
      if (isContactDockRowAction(event.target)) return;
      selectCustomerForContact(customer);
    });
    qs<HTMLButtonElement>("[data-customer-mobile-whatsapp]", card)?.addEventListener("click", () => {
      void openWhatsAppForContact({ phone: customerContactDetails(customer).whatsapp, displayName: customer.contact || customer.company });
    });
    qs<HTMLButtonElement>("[data-customer-mobile-pool]", card)?.addEventListener("click", () => openCustomerReleaseModal(customer));
  });
  const selected = customers.find((item) => item.id === state.selectedCustomerId);
  if (selected && qs("#customerDrawer")?.classList.contains("open")) renderCustomerDrawer(selected);
  if (mapActive) void renderCustomerMap(visibleCustomers);
}

function filteredPublicCustomers() {
  const query = state.customerPoolSearch.trim().toLowerCase();
  return state.publicCustomers.filter((customer) => {
    const matchesQuery = !query || [
      customer.company,
      customer.contact,
      customer.country,
      customer.previousOwnerName || "",
      customer.releaseReason || ""
    ].some((value) => value.toLowerCase().includes(query));
    const matchesGrade = state.customerPoolGradeFilter === "all"
      || customerGradeValue(customer) === state.customerPoolGradeFilter;
    return matchesQuery && matchesGrade;
  });
}

export function renderCustomerPool() {
  const summary = qs<HTMLElement>("#customerPoolSummary");
  const tbody = qs<HTMLElement>("#customerPoolTableBody");
  const mobile = qs<HTMLElement>("#customerPoolMobileList");
  const navCount = qs<HTMLElement>("#customerPoolNavCount");
  if (!summary || !tbody || !mobile) return;
  const customers = filteredPublicCustomers();
  const wonCount = state.publicCustomers.filter((customer) => customer.hasWonDeal).length;
  summary.innerHTML = `
    <div><span>我的客户</span><b>${state.customerPoolCounts.mineCount}</b><small>当前负责</small></div>
    <div><span>公池客户</span><b>${state.customerPoolCounts.publicCount}</b><small>同团队可领取</small></div>
    <div><span>成交客户</span><b>${wonCount}</b><small>公池历史成交</small></div>`;
  if (navCount) navCount.textContent = String(state.customerPoolCounts.publicCount);
  const empty = `<tr><td colspan="5" class="empty-cell">当前筛选下暂无公池客户。</td></tr>`;
  tbody.innerHTML = customers.length ? customers.map((customer) => `
    <tr data-pool-customer-id="${escapeHtml(customer.id)}">
      <td><div class="customer-pool-company"><b>${escapeHtml(customer.company)}</b><span>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact || "联系人待维护")}</span></div></td>
      <td>${customerGradeHtml(customer)}</td>
      <td><div class="customer-pool-company"><b>${escapeHtml(customer.previousOwnerName || "原负责人未记录")}</b><span>${escapeHtml(customer.releasedByName || "团队成员")} · ${escapeHtml(formatDateTime(customer.releasedAt || ""))}</span><span class="customer-pool-reason">${escapeHtml(customer.releaseReason || "未填写释放原因")}</span></div></td>
      <td>${badge(customerWonLabel(customer), customer.hasWonDeal ? "green" : "gray")}</td>
      <td><div class="customer-pool-actions"><button class="${whatsAppEntryClass(customerContactDetails(customer).whatsapp)}" type="button" data-pool-whatsapp ${whatsAppEntryAttrs(customerContactDetails(customer).whatsapp)}>WhatsApp</button><button class="btn customer-pool-claim" type="button" data-pool-claim>领取客户</button></div></td>
    </tr>`).join("") : empty;
  mobile.innerHTML = customers.length ? customers.map((customer) => `
    <article class="customer-pool-card" data-pool-customer-id="${escapeHtml(customer.id)}">
      <div class="customer-pool-company"><b>${escapeHtml(customer.company)}</b><span>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact || "联系人待维护")}</span></div>
      <div>${customerGradeHtml(customer)} ${badge(customerWonLabel(customer), customer.hasWonDeal ? "green" : "gray")}</div>
      <span>${escapeHtml(customer.previousOwnerName || "原负责人未记录")} · ${escapeHtml(formatDateTime(customer.releasedAt || ""))}</span>
      <div class="customer-pool-reason">${escapeHtml(customer.releaseReason || "未填写释放原因")}</div>
      <div class="customer-pool-actions"><button class="${whatsAppEntryClass(customerContactDetails(customer).whatsapp)}" type="button" data-pool-whatsapp ${whatsAppEntryAttrs(customerContactDetails(customer).whatsapp)}>WhatsApp</button><button class="btn customer-pool-claim" type="button" data-pool-claim>领取客户</button></div>
    </article>`).join("") : `<div class="empty-cell">当前筛选下暂无公池客户。</div>`;
  qsa<HTMLElement>("[data-pool-customer-id]", qs("#customer-pool")!).forEach((row) => {
    const customer = state.publicCustomers.find((item) => item.id === row.dataset.poolCustomerId);
    if (!customer) return;
    row.addEventListener("click", (event) => {
      if (isContactDockRowAction(event.target)) return;
      selectPoolCustomerForContact(customer);
    });
    qs<HTMLButtonElement>("[data-pool-whatsapp]", row)?.addEventListener("click", () => {
      void openWhatsAppForContact({ phone: customerContactDetails(customer).whatsapp, displayName: customer.contact || customer.company });
    });
    qs<HTMLButtonElement>("[data-pool-claim]", row)?.addEventListener("click", (event) => {
      void claimCustomerFromPool(customer.id, event.currentTarget as HTMLButtonElement);
    });
  });
  refreshContactDock("customer-pool", (id) => {
    const customer = state.publicCustomers.find((item) => item.id === id);
    return customer ? poolCustomerContactDockSubject(customer) : null;
  });
}

export async function reloadCustomerScopes() {
  const [owned, publicPool] = await Promise.all([
    api<{ customers: Customer[]; mineCount: number; publicCount: number }>("/api/customers"),
    api<{ customers: Customer[]; mineCount: number; publicCount: number }>("/api/customers?scope=public")
  ]);
  state.customers = owned.customers;
  state.publicCustomers = publicPool.customers;
  state.customerPoolCounts = { mineCount: owned.mineCount, publicCount: publicPool.publicCount };
  state.selectedCustomerIds = state.selectedCustomerIds.filter((id) => state.customers.some((customer) => customer.id === id));
  renderCustomers(state.customers);
  renderCustomerPool();
}

export function openCustomerReleaseModal(customer: Customer) {
  openModal("放入客户公池", `
    <div class="delete-warning"><b>${escapeHtml(customer.company)}</b><span>释放后同团队成员可立即领取，未完成的客户待办将停止。</span></div>
    <div class="form-field full"><label>释放原因</label><textarea id="customerReleaseReason" rows="4" maxlength="500" placeholder="例如：近期无精力持续跟进，希望由团队其他成员接手"></textarea></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmCustomerReleaseButton">确认放入公池</button>`);
  qs<HTMLButtonElement>("#confirmCustomerReleaseButton")?.addEventListener("click", (event) => {
    void releaseCustomerToPool(customer.id, event.currentTarget as HTMLButtonElement);
  });
}

async function releaseCustomerToPool(customerId: string, button?: HTMLButtonElement) {
  const customer = state.customers.find((item) => item.id === customerId);
  const reason = qs<HTMLTextAreaElement>("#customerReleaseReason")?.value.trim() || "";
  if (!customer) return;
  if (reason.length < 2) {
    toast("请填写释放原因", "error");
    return;
  }
  if (button) { button.disabled = true; button.textContent = "处理中"; }
  try {
    await api(`/api/customers/${encodeURIComponent(customerId)}/release`, {
      method: "POST",
      body: JSON.stringify({ reason, expectedVersion: customer.ownershipVersion || 0 })
    });
    closeModal();
    closeCustomerDrawer();
    if (state.selectedCustomerId === customerId) state.selectedCustomerId = null;
    await reloadCustomerScopes();
    toast("客户已放入团队公池");
  } catch (error) {
    toast(error instanceof Error ? error.message : "放入公池失败", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = "确认放入公池"; }
  }
}

async function claimCustomerFromPool(customerId: string, button?: HTMLButtonElement) {
  const customer = state.publicCustomers.find((item) => item.id === customerId);
  if (!customer) return;
  if (button) { button.disabled = true; button.textContent = "领取中"; }
  try {
    await api(`/api/customers/${encodeURIComponent(customerId)}/claim`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: customer.ownershipVersion || 0 })
    });
    await reloadCustomerScopes();
    toast("客户已领取到我的客户");
  } catch (error) {
    toast(error instanceof Error ? error.message : "领取客户失败", "error");
    await reloadCustomerScopes().catch(() => undefined);
  } finally {
    if (button) { button.disabled = false; button.textContent = "领取客户"; }
  }
}

function renderCustomerBulkBar(customers: Customer[]) {
  const toolbar = qs<HTMLElement>("#customerBulkToolbar");
  if (!toolbar) return;
  const selectedCount = state.selectedCustomerIds.length;
  const allSelected = customers.length > 0 && customers.every((customer) => state.selectedCustomerIds.includes(customer.id));
  // 联系条挂在这条工具条的右端，内容由 renderCustomers 末尾的 refreshContactDock 负责重绘。
  // 这里整块重写 innerHTML 会把它一起冲掉 —— 先摘下来、写完再放回去，避免每次列重渲染都重建节点（会闪）。
  const dock = contactDockElement("customers");
  toolbar.innerHTML = `
    <label class="customer-select-all"><input type="checkbox" data-select-all-customers ${allSelected ? "checked" : ""}>全选</label>
    <span class="filter">已选 ${selectedCount} 个客户</span>
    <span class="filter">国家：全部</span><span class="filter">商机阶段：全部</span><span class="filter">最近跟进：30 天</span>
    <button class="btn danger" data-bulk-delete-customers ${selectedCount ? "" : "disabled"}>批量删除</button>
    <button class="btn">批量导出</button>
  `;
  if (dock) toolbar.appendChild(dock);
  qs<HTMLInputElement>("[data-select-all-customers]", toolbar)?.addEventListener("change", (event) => {
    const pageIds = new Set(customers.map((customer) => customer.id));
    state.selectedCustomerIds = (event.currentTarget as HTMLInputElement).checked
      ? Array.from(new Set([...state.selectedCustomerIds, ...pageIds]))
      : state.selectedCustomerIds.filter((id) => !pageIds.has(id));
    renderCustomers(state.customers);
  });
  qs<HTMLButtonElement>("[data-bulk-delete-customers]", toolbar)?.addEventListener("click", () => void bulkDeleteCustomers());
}

function customerMapMetrics(customers: Customer[]) {
  return {
    markets: new Set(customers.map((customer) => customerMapCountryLabel(customer.country)).filter(Boolean)).size,
    won: customers.filter((customer) => customer.hasWonDeal).length,
    pipeline: customers.reduce((total, customer) => total + Number(customer.pipelineAmount || 0), 0)
  };
}

export function customerMapCountryLabel(country: string) {
  const value = country.trim();
  const code = value.toUpperCase();
  return value === "台湾" || value === "中国台湾" || code === "TW" || code === "TWN"
    ? "中国"
    : value;
}

function renderCustomerMapSummary(customers: Customer[]) {
  const summary = qs<HTMLElement>("#customerMapSummary");
  if (!summary) return;
  const metrics = customerMapMetrics(customers);
  summary.innerHTML = `
    <span><small>客户</small><b>${customers.length}</b></span>
    <span><small>市场</small><b>${metrics.markets}</b></span>
    <span><small>已成交</small><b>${metrics.won}</b></span>
  `;
}

function renderCustomerMapRegion(region: CustomerMapRegion | null, customers: Customer[]) {
  const panel = qs<HTMLElement>("#customerMapRegion");
  if (!panel) return;
  customerMapRegion = region;
  if (!region) {
    const metrics = customerMapMetrics(customers);
    const markets = Array.from(customers.reduce((groups, customer) => {
      const country = customerMapCountryLabel(customer.country) || "未知";
      groups.set(country, (groups.get(country) || 0) + 1);
      return groups;
    }, new Map<string, number>()).entries()).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN")).slice(0, 6);
    panel.innerHTML = `
      <div class="customer-map-region-head">
        <div><span>GLOBAL PORTFOLIO</span><h2>全球客户</h2></div>
      </div>
      <div class="customer-map-overview">
        <strong>${metrics.markets}</strong><span>个客户市场</span>
        <dl>
          <div><dt>客户总数</dt><dd>${customers.length}</dd></div>
          <div><dt>成交客户</dt><dd>${metrics.won}</dd></div>
          <div><dt>在手商机</dt><dd>${money(metrics.pipeline)}</dd></div>
        </dl>
        <div class="customer-map-market-list">
          ${markets.map(([country, count]) => `<button type="button" data-map-market-country="${escapeHtml(country)}"><span>${escapeHtml(country)}</span><b>${count}</b></button>`).join("")}
        </div>
      </div>
    `;
    qsa<HTMLButtonElement>("[data-map-market-country]", panel).forEach((button) => {
      button.addEventListener("click", () => customerMapController?.focusCountry(button.dataset.mapMarketCountry || ""));
    });
    return;
  }
  const regionCustomers = region.customers
    .map((item) => state.customers.find((customer) => customer.id === item.id))
    .filter((item): item is Customer => Boolean(item));
  const displayName = region.id === "156" ? "中国" : customerMapCountryLabel(regionCustomers[0]?.country || region.name);
  const total = regionCustomers.reduce((sum, customer) => sum + Number(customer.pipelineAmount || customer.amount || 0), 0);
  panel.innerHTML = `
    <div class="customer-map-region-head">
      <div><span>REGIONAL CUSTOMERS</span><h2>${escapeHtml(displayName)}</h2></div>
      <button type="button" class="customer-map-reset" data-customer-map-reset title="返回全球" aria-label="返回全球">↺</button>
    </div>
    <div class="customer-map-region-summary"><b>${regionCustomers.length} 家客户</b><span>${money(total)}</span></div>
    <div class="customer-map-customer-list">
      ${regionCustomers.length ? regionCustomers.map((customer) => {
        const grade = customerGradeValue(customer);
        return `<button type="button" data-map-customer-id="${escapeHtml(customer.id)}">
          <i class="grade-${grade.toLowerCase()}">${grade}</i>
          <span><b>${escapeHtml(customer.company)}</b><small>${escapeHtml(customer.contact || "联系人待维护")} · ${escapeHtml(customer.ownerName || "未分配")}</small></span>
          <strong>${escapeHtml(customer.pipelineStage || customer.stage || "待跟进")}<small>${customer.hasWonDeal ? customerWonLabel(customer) : `${customer.activeDealCount || 0} 个商机`}</small></strong>
        </button>`;
      }).join("") : `<div class="customer-map-region-empty"><b>暂无客户</b><span>${escapeHtml(displayName)}</span></div>`}
    </div>
  `;
  qs<HTMLButtonElement>("[data-customer-map-reset]", panel)?.addEventListener("click", () => customerMapController?.reset());
  qsa<HTMLButtonElement>("[data-map-customer-id]", panel).forEach((button) => {
    button.addEventListener("click", () => {
      const customer = state.customers.find((item) => item.id === button.dataset.mapCustomerId);
      if (customer) openCustomerDetailPage(customer);
    });
  });
}

async function renderCustomerMap(customers: Customer[]) {
  renderCustomerMapSummary(customers);
  if (customerMapController) {
    customerMapController.update(customers);
    customerMapController.setActive(true);
    renderCustomerMapRegion(customerMapRegion, customers);
    return;
  }
  if (customerMapLoading) return;
  const host = qs<HTMLElement>("#customerGlobe");
  if (!host) return;
  customerMapLoading = true;
  host.innerHTML = `<div class="customer-map-loading"><i></i><b>正在加载全球客户</b></div>`;
  try {
    const { createCustomerMap } = await import("../customer-map");
    host.innerHTML = "";
    customerMapController = createCustomerMap({
      host,
      customers,
      onRegionSelect: (region) => renderCustomerMapRegion(region, filteredCustomers(state.customers))
    });
    customerMapController.setActive(state.customerViewMode === "map");
    renderCustomerMapRegion(null, customers);
  } catch (error) {
    host.innerHTML = `<div class="customer-map-error"><b>地图加载失败</b><span>${escapeHtml(error instanceof Error ? error.message : "浏览器暂不支持 WebGL")}</span></div>`;
  } finally {
    customerMapLoading = false;
  }
}

export function customerRelatedDeals(customer: Customer) {
  return state.deals
    .filter((deal) => deal.customerId === customer.id)
    .sort((left, right) => Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)) || right.amount - left.amount);
}

export function dealTone(deal: Deal) {
  if (deal.stage === "丢单") return "red";
  if (deal.stage === "成交") return "green";
  if (deal.archivedAt) return "gray";
  if (deal.stage === "已报价") return "amber";
  return "";
}

/**
 * 客户抽屉里的「订单履约」：订单是这个客户成交之后的执行面，
 * 只看商机进展看不到货有没有发、单证齐不齐。
 */
export function renderCustomerOrders(customer: Customer) {
  return `
    <section class="customer-deals customer-orders">
      <div class="customer-deals-head"><h3>订单履约</h3><button class="btn" data-customer-orders-all>全部订单</button></div>
      <div id="customerOrderList"><div class="customer-deal-empty">加载中…</div></div>
    </section>
  `;
}

export async function loadCustomerOrders(customer: Customer) {
  const box = qs<HTMLElement>("#customerOrderList");
  if (!box) return;
  try {
    const data = await api<OrdListResponse>(
      `/api/orders?customerId=${encodeURIComponent(customer.id)}&status=all&pageSize=6`
    );
    // 抽屉可能已经关了或换人了：容器没了就别再写。
    const live = qs<HTMLElement>("#customerOrderList");
    if (!live) return;
    if (!data.orders.length) {
      live.innerHTML = `<div class="customer-deal-empty">还没有订单。商机成交后会自动建单。</div>`;
      return;
    }
    live.innerHTML = data.orders.map((order) => {
      // 副标题不能和右边的状态徽章说同一句话（已取消 + 已取消）。
      const subtitle = order.status === "cancelled"
        ? escapeHtml(order.cancelReason || "订单已取消")
        : order.status === "completed"
          ? `签收 ${ordDay(order.deliveredAt)}`
          : `${escapeHtml(order.derived.nextAction || "")}${order.derived.isOverdue ? ` · 逾期 ${order.derived.overdueDays} 天` : ""}`;
      return `
      <button type="button" class="customer-deal-row customer-order-row" data-customer-order="${escapeHtml(order.id)}">
        <div>
          <b>${escapeHtml(ordIdentity(order).primary)}</b>
          <span>${subtitle}</span>
        </div>
        <div class="customer-deal-meta">
          ${ordBadge(order.status)}
          <strong>${Math.round(order.derived.shippingProgress * 100)}%</strong>
        </div>
      </button>`;
    }).join("");
    qsa<HTMLElement>("[data-customer-order]", live).forEach((node) =>
      node.addEventListener("click", () => {
        const orderId = node.dataset.customerOrder || "";
        closeCustomerDrawer();
        if (orderId) void openOrderDetail(orderId);
      })
    );
  } catch {
    const live = qs<HTMLElement>("#customerOrderList");
    if (live) live.innerHTML = `<div class="customer-deal-empty">订单加载失败</div>`;
  }
}

export function renderCustomerDealProgress(customer: Customer) {
  const deals = customerRelatedDeals(customer);
  if (!deals.length) {
    return `
      <section class="customer-deals">
        <div class="customer-deals-head"><h3>相关商机进展</h3><button class="btn" data-view-related-deals>查看商机管道</button></div>
        <div class="customer-deal-empty">暂无关联商机</div>
      </section>
    `;
  }
  return `
    <section class="customer-deals">
      <div class="customer-deals-head"><h3>相关商机进展</h3><button class="btn" data-view-related-deals>查看商机管道</button></div>
      <div class="customer-deal-list">
        ${deals.map((deal) => `
          <article class="customer-deal-row">
            <div>
              <b>${escapeHtml(deal.title)}</b>
              <span>${escapeHtml(deal.nextAction)}${deal.archivedAt ? ` · ${escapeHtml(formatDateTime(deal.archivedAt))}` : ""}</span>
            </div>
            <div class="customer-deal-meta">
              ${badge(deal.archivedAt && deal.stage !== "丢单" ? "已归档" : deal.stage, dealTone(deal))}
              <strong>${money(deal.amount)}</strong>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

export function customerContactDetails(customer: Customer) {
  const source = [customer.contact, customer.documentContact || "", customer.contactRemark || ""].join(" ");
  const email = customer.email || source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const phone = customer.phone || source.match(/(?:\+?\d[\d\s()\-]{6,}\d)/)?.[0]?.trim() || "";
  const whatsapp = normalizeWhatsAppPhone(customer.whatsapp || customer.whatsappPhone || "");
  const wechat = customer.wechat || "";
  return { email, phone, whatsapp, wechat };
}

export interface WhatsAppPluginConversation {
  id: string;
  accountId: string;
  contactPhone: string;
  contactName?: string;
  lastMessage?: string | null;
  lastMessageAt?: string | null;
}

export interface WhatsAppConversationInsight {
  analysis: {
    summary: string;
    keyPoints: string[];
    traits: Array<{ key: string; label: string; value: string; confidence: number; evidenceMessageIds: string[] }>;
    buyingIntent: "high" | "medium" | "low";
    riskLevel: "high" | "medium" | "low";
    nextAction: string;
    sourceMessageCount: number;
    generatedAt: string;
  } | null;
  followups: Array<{ id: string; title: string; reason: string; priority: "high" | "medium" | "normal"; dueAt: string; status: "pending" | "completed" | "dismissed" }>;
}

export function normalizeWhatsAppPhone(value: string) {
  const digits = String(value || "").replace(/\D/gu, "");
  if (!digits) return "";
  const phone = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/u.test(phone) ? phone : "";
}

export async function whatsappPluginRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/whatsapp-plugin/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `WhatsApp 服务请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

// 即刻沟通是 iframe，而 CSS 自定义属性不会穿过 iframe 边界：宿主换肤后必须把品牌令牌
// 显式送进去，否则外层换了主题、iframe 里仍然停在插件自带的默认色，同屏两种主色。
// 送的是宿主**算好的最终取值**（getComputedStyle 读的就是级联结果），所以 15 套预设
// 与「自定义取色」（applyTheme 把令牌写成 <html> 的行内样式）走的是同一条路，
// 不需要在插件里再维护一份预设表。
// 与插件侧同名常量：whatsapp-plugin/src/web/theme.ts
const WHATSAPP_THEME_MESSAGE = "goodjob:theme";

function readHostThemeTokens(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement);
  const pick = (name: string) => computed.getPropertyValue(name).trim();
  return {
    brand: pick("--brand"),
    brandStrong: pick("--brand-strong"),
    brandTint: pick("--brand-tint"),
    brandRing: pick("--brand-ring")
  };
}

export function appendHostThemeParams(params: URLSearchParams): void {
  for (const [key, value] of Object.entries(readHostThemeTokens())) {
    if (value) params.set(key, value);
  }
}

export function syncWhatsAppFrameTheme(): void {
  const frame = qs<HTMLIFrameElement>("#whatsapp .whatsapp-plugin-frame");
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage(
    { type: WHATSAPP_THEME_MESSAGE, tokens: readHostThemeTokens() },
    window.location.origin
  );
}

export function setInstantCommunicationState(mode: "loading" | "error", title: string, message: string, retry: boolean) {
  const stateNode = qs<HTMLElement>("#instantCommunicationState");
  const titleNode = qs<HTMLElement>("#instantCommunicationStateTitle");
  const messageNode = qs<HTMLElement>("#instantCommunicationStateMessage");
  const actionsNode = qs<HTMLElement>("#instantCommunicationStateActions");
  if (!stateNode || !titleNode || !messageNode || !actionsNode) return;
  stateNode.hidden = false;
  stateNode.classList.toggle("is-loading", mode === "loading");
  stateNode.classList.toggle("is-error", mode === "error");
  titleNode.textContent = title;
  messageNode.textContent = message;
  actionsNode.hidden = !retry;
}

export function markInstantCommunicationReady() {
  const stateNode = qs<HTMLElement>("#instantCommunicationState");
  const frame = qs<HTMLIFrameElement>("#whatsapp .whatsapp-plugin-frame");
  if (stateNode) stateNode.hidden = true;
  if (frame) {
    frame.hidden = false;
    frame.dataset.ready = "true";
  }
}
