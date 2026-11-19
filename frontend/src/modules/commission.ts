/**
 * 提成。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import * as XLSX from "xlsx";
import { closeModal, openModal, state } from "../prototype-api";
import {
  type CommissionCalculation, type CommissionItem, type CommissionProduct, type CommissionRule,
  type CommissionRuleType, type MonthlySalesRecord, type Reminder, type SalesRecordAudit
} from "./models";
import { type AppState, amount, badge, currencyAmount, escapeHtml, qs, qsa, roleLabel } from "./shared";
import { api, toast } from "./ui";
import {
  activeRuleForProduct, commissionExchangeSourceLabel, commissionRuleLabel, commissionStatusLabel,
  commissionStatusTone, estimateCommissionForRecord, findCommissionProductForRecord, formatDateTime,
  refreshCommissionData
} from "./deals";
import { reminderTimeUnitText } from "./workspace";

export function renderCommission() {
  const root = qs<HTMLElement>("#commission");
  if (!root) return;
  const monthInput = qs<HTMLInputElement>("#commissionMonthInput");
  if (monthInput) {
    monthInput.value = state.commissionMonth;
    monthInput.onchange = () => {
      state.commissionMonth = monthInput.value || new Date().toISOString().slice(0, 7);
      void refreshCommissionData();
    };
  }
  renderCommissionOwnerSelector();
  const syncButton = qs<HTMLButtonElement>("#commissionSyncDealsButton");
  const addRecordButton = qs<HTMLButtonElement>("#commissionAddRecordButton");
  const productButton = qs<HTMLButtonElement>("#commissionProductButton");
  const recalculateButton = qs<HTMLButtonElement>("#commissionRecalculateButton");
  const exportButton = qs<HTMLButtonElement>("#commissionExportButton");
  const manualButton = qs<HTMLButtonElement>("#commissionAddManualItemButton");
  if (syncButton) syncButton.onclick = () => void syncCommissionDeals();
  if (addRecordButton) addRecordButton.onclick = () => openCommissionRecordModal();
  if (productButton) productButton.onclick = () => openCommissionProductModal();
  if (recalculateButton) recalculateButton.onclick = () => void recalculateCommission();
  if (exportButton) exportButton.onclick = () => void exportCommission();
  if (manualButton) manualButton.onclick = () => openCommissionManualItemModal();
  if (manualButton) {
    manualButton.disabled = !state.commissionCanReview;
    manualButton.title = state.commissionCanReview ? "新增奖金、扣减、补贴等调整项" : "只有管理员和超级管理员可以调整提成金额";
  }
  qsa<HTMLButtonElement>("[data-commission-filter]", root).forEach((button) => {
    button.classList.toggle("active", button.dataset.commissionFilter === state.commissionFilter);
    button.onclick = () => {
      state.commissionFilter = (button.dataset.commissionFilter as AppState["commissionFilter"]) || "all";
      renderCommission();
    };
  });
  renderCommissionKpis();
  renderCommissionRecords();
  renderCommissionCalculations();
  renderCommissionRules();
}

function renderCommissionOwnerSelector() {
  const select = qs<HTMLSelectElement>("#commissionOwnerInput");
  if (!select) return;
  if (!state.commissionCanSelectOwner) {
    select.innerHTML = `<option value="${escapeHtml(state.user?.id || "")}">${escapeHtml(state.user?.name || "本人")} · 仅本人</option>`;
    select.disabled = true;
    return;
  }
  const owners = state.commissionOwners.length ? state.commissionOwners : [];
  select.disabled = false;
  select.innerHTML = `<option value="all">全部人员</option>${owners.map((owner) => `<option value="${escapeHtml(owner.id)}">${escapeHtml(owner.name)} · ${escapeHtml(roleLabel[owner.role] || owner.role)}</option>`).join("")}`;
  select.value = state.selectedCommissionOwnerId || "all";
  select.onchange = () => {
    state.selectedCommissionOwnerId = select.value || "all";
    state.selectedCommissionCalculationId = null;
    void refreshCommissionData();
  };
}

function renderCommissionKpis() {
  const box = qs<HTMLElement>("#commissionKpis");
  if (!box) return;
  const confirmedRecords = state.commissionRecords.filter((item) => item.status !== "draft");
  const totalSales = confirmedRecords.reduce((sum, item) => sum + Number(item.settlementAmount || 0), 0);
  const calculatedCommission = state.commissionCalculations.reduce((sum, item) => sum + Number(item.finalCommission || 0), 0);
  const estimatedCommission = confirmedRecords.reduce((sum, item) => sum + estimateCommissionForRecord(item), 0);
  const finalCommission = calculatedCommission || estimatedCommission;
  const pendingRate = state.commissionRecords.filter((item) => item.currency !== "CNY" && ((item.exchangeRateSource || "pending") === "pending" || !item.exchangeRateDate)).length;
  const unmatched = confirmedRecords.filter((item) => !activeRuleForProduct(findCommissionProductForRecord(item)?.id || item.productId)).length;
  box.innerHTML = [
    ["可计提基数 · CNY", currencyAmount(totalSales)],
    [calculatedCommission ? "当前提成 · CNY" : "试算提成 · CNY", currencyAmount(finalCommission)],
    ["待确认记录", `${state.commissionRecords.filter((item) => item.status === "draft").length} 条`],
    ["数据异常", `${pendingRate + unmatched} 条`]
  ].map(([label, value]) => `<div class="commission-kpi"><span>${label}</span><b>${value}</b></div>`).join("");
}

function commissionRecordMissingFields(record: MonthlySalesRecord) {
  const fields: string[] = [];
  if (!record.basisDate) fields.push("计提日期");
  if (record.currency !== "CNY" && !record.exchangeRateDate) fields.push("汇率日期");
  if (record.currency !== "CNY" && record.exchangeRateSource === "pending") fields.push("汇率来源");
  return fields;
}

function commissionRecordCalculationLocked(record: MonthlySalesRecord) {
  return state.commissionCalculations.some((calculation) =>
    calculation.isCurrent !== false
    && calculation.month === record.month
    && calculation.ownerId === record.ownerId
    && calculation.status === "locked"
  );
}

function commissionAmountForRecord(record: MonthlySalesRecord) {
  const items = state.commissionItems.filter((item) => item.recordId === record.id);
  if (items.length) {
    return {
      amount: items.reduce((sum, item) => sum + Number(item.finalAmount || 0), 0),
      label: items.some((item) => item.sourceType === "manual") ? "已计算 · 含调整" : "已计算"
    };
  }
  const product = findCommissionProductForRecord(record);
  const rule = activeRuleForProduct(product?.id || record.productId);
  return {
    amount: estimateCommissionForRecord(record),
    label: rule && rule.ruleType !== "none"
      ? (record.status === "draft" ? "试算 · 待确认" : "试算 · 待计算")
      : "未匹配规则"
  };
}

function commissionRecordActions(record: MonthlySalesRecord) {
  if (record.status !== "draft") {
    return `<button class="btn" data-view-commission-detail>查看明细</button>`;
  }
  if (commissionRecordCalculationLocked(record)) {
    return `<button class="btn" data-view-commission-detail>查看明细</button><button class="btn" disabled title="请先解锁右侧提成单">本月已锁定</button>`;
  }
  const missingFields = commissionRecordMissingFields(record);
  if (missingFields.length) {
    return `<button class="btn" data-view-commission-detail>查看明细</button><button class="btn primary" data-complete-commission-record title="缺少：${escapeHtml(missingFields.join("、"))}">补齐资料</button>`;
  }
  return `<button class="btn" data-view-commission-detail>查看明细</button><button class="btn" data-edit-commission-record>编辑</button><button class="btn primary" data-confirm-commission-record>确认</button>`;
}

function renderCommissionRecords() {
  const tbody = qs<HTMLElement>("#commissionRecordRows");
  const cardList = qs<HTMLElement>("#commissionRecordCards");
  if (!tbody || !cardList) return;
  const rows = state.commissionRecords
    .filter((record) => state.commissionFilter === "all" || record.status === state.commissionFilter)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  tbody.innerHTML = rows.length ? rows.map((record) => {
    const commission = commissionAmountForRecord(record);
    return `
    <tr data-commission-record-id="${escapeHtml(record.id)}">
      <td><div class="commission-title-cell"><b>${escapeHtml(record.customerName)}</b><span>${escapeHtml(record.productName)} · ${Number(record.quantity || 0).toLocaleString("en-US")} × ${currencyAmount(record.unitPrice, record.currency)}${record.edited ? " · 已编辑" : ""}</span></div></td>
      <td><div class="commission-money-cell"><b>${currencyAmount(record.salesAmount, record.currency)}</b><span>汇率 ${Number(record.exchangeRate || 0).toLocaleString("en-US")} · ${commissionExchangeSourceLabel(record.exchangeRateSource)}</span></div></td>
      <td><div class="commission-money-cell"><b>${currencyAmount(record.settlementAmount, "CNY")}</b><span>${record.basisType === "receipt" ? "实际回款" : "成交金额待核对"} · ${escapeHtml(record.basisDate || "未填日期")}</span></div></td>
      <td><div class="commission-money-cell"><b>${currencyAmount(commission.amount, "CNY")}</b><span>${escapeHtml(commission.label)}</span></div></td>
      <td><div class="commission-status-stack">${badge(commissionStatusLabel(record.status), commissionStatusTone(record.status))}${badge(record.sourceType === "deal" ? "归档商机" : record.sourceType === "manual" ? "手工录入" : "人工修正", record.sourceType === "adjusted" ? "amber" : "gray")}</div></td>
      <td><div class="commission-row-actions">${commissionRecordActions(record)}</div></td>
    </tr>
  `;
  }).join("") : `<tr><td colspan="6" class="empty-cell">暂无销售记录</td></tr>`;
  cardList.innerHTML = rows.length ? rows.map((record) => {
    const commission = commissionAmountForRecord(record);
    return `
    <article class="commission-record-card" data-commission-record-id="${escapeHtml(record.id)}">
      <div class="commission-record-card-head"><div><b>${escapeHtml(record.customerName)}</b><span>${escapeHtml(record.productName)}</span></div>${badge(commissionStatusLabel(record.status), commissionStatusTone(record.status))}</div>
      <div class="commission-record-card-money"><span>原币金额<strong>${currencyAmount(record.salesAmount, record.currency)}</strong></span><span>结算金额<strong>${currencyAmount(record.settlementAmount, "CNY")}</strong></span><span class="commission-record-card-commission">提成额 · ${escapeHtml(commission.label)}<strong>${currencyAmount(commission.amount, "CNY")}</strong></span></div>
      <p>${record.basisType === "receipt" ? "实际回款" : "成交金额待核对"} · ${escapeHtml(record.basisDate || "未填日期")} · ${commissionExchangeSourceLabel(record.exchangeRateSource)}${record.exchangeRateSource !== "pending" ? ` · ${Number(record.exchangeRate || 0).toLocaleString("en-US")}` : ""}</p>
      <div class="commission-row-actions">${commissionRecordActions(record)}</div>
    </article>
  `;
  }).join("") : `<div class="commission-empty">暂无销售记录。</div>`;
  const actionRoot = qs<HTMLElement>("#commission") || document.body;
  qsa<HTMLButtonElement>("[data-edit-commission-record]", actionRoot).forEach((button) => {
    button.addEventListener("click", () => {
      const record = state.commissionRecords.find((item) => item.id === button.closest<HTMLElement>("[data-commission-record-id]")?.dataset.commissionRecordId);
      if (record) openCommissionRecordModal(record);
    });
  });
  qsa<HTMLButtonElement>("[data-complete-commission-record]", actionRoot).forEach((button) => {
    button.addEventListener("click", () => {
      const record = state.commissionRecords.find((item) => item.id === button.closest<HTMLElement>("[data-commission-record-id]")?.dataset.commissionRecordId);
      if (!record) {
        toast("未找到这条计提记录，请刷新后重试", "error");
        return;
      }
      const missingFields = commissionRecordMissingFields(record);
      toast(`请补齐：${missingFields.join("、")}`, "error");
      openCommissionRecordModal(record);
    });
  });
  qsa<HTMLButtonElement>("[data-confirm-commission-record]", actionRoot).forEach((button) => {
    button.addEventListener("click", () => void confirmCommissionRecord(
      button.closest<HTMLElement>("[data-commission-record-id]")?.dataset.commissionRecordId || "",
      button
    ));
  });
  qsa<HTMLButtonElement>("[data-view-commission-detail]", actionRoot).forEach((button) => {
    button.addEventListener("click", () => void openCommissionRecordDetailModal(button.closest<HTMLElement>("[data-commission-record-id]")?.dataset.commissionRecordId || ""));
  });
}

function renderCommissionCalculations() {
  const box = qs<HTMLElement>("#commissionCalculationRows");
  if (!box) return;
  box.innerHTML = state.commissionCalculations.length ? state.commissionCalculations.map((calculation) => {
    const owner = state.commissionOwners.find((item) => item.id === calculation.ownerId)?.name || (calculation.ownerId === state.user?.id ? state.user.name : calculation.ownerId);
    return `<article class="commission-calc-row" data-commission-calculation-id="${escapeHtml(calculation.id)}">
      <div class="commission-calc-top"><b>${escapeHtml(owner)} · ${escapeHtml(calculation.month)} · V${calculation.version || 1}</b>${badge(commissionStatusLabel(calculation.status), commissionStatusTone(calculation.status))}</div>
      <div class="commission-calc-metrics"><span>计提基数<strong>${currencyAmount(calculation.salesAmount)}</strong></span><span>自动提成<strong>${currencyAmount(calculation.autoCommission)}</strong></span><span>最终提成<strong>${currencyAmount(calculation.finalCommission)}</strong></span></div>
      <div class="commission-row-actions">
        <button class="btn" data-view-commission-calc>查看明细</button>
        ${state.commissionCanReview && calculation.status === "calculated" ? `<button class="btn" data-select-commission-calc>提成调整</button><button class="btn primary" data-review-commission-calc>复核</button>` : ""}
        ${state.commissionCanReview && calculation.status === "reviewed" ? `<button class="btn primary" data-lock-commission-calc>锁定</button>` : ""}
        ${state.commissionCanReview && calculation.status === "locked" ? `<button class="btn" data-unlock-commission-calc>解锁修正</button>` : ""}
      </div>
    </article>`;
  }).join("") : `<div class="commission-empty">暂无计算结果</div>`;
  qsa<HTMLButtonElement>("[data-select-commission-calc]", box).forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCommissionCalculationId = button.closest<HTMLElement>(".commission-calc-row")?.dataset.commissionCalculationId || null;
      openCommissionManualItemModal();
    });
  });
  qsa<HTMLButtonElement>("[data-view-commission-calc]", box).forEach((button) => {
    button.addEventListener("click", () => openCommissionCalculationDetailModal(button.closest<HTMLElement>(".commission-calc-row")?.dataset.commissionCalculationId || ""));
  });
  qsa<HTMLButtonElement>("[data-review-commission-calc]", box).forEach((button) => {
    button.addEventListener("click", () => void reviewCommissionCalculation(button.closest<HTMLElement>(".commission-calc-row")?.dataset.commissionCalculationId || ""));
  });
  qsa<HTMLButtonElement>("[data-lock-commission-calc]", box).forEach((button) => {
    button.addEventListener("click", () => void lockCommissionCalculation(button.closest<HTMLElement>(".commission-calc-row")?.dataset.commissionCalculationId || ""));
  });
  qsa<HTMLButtonElement>("[data-unlock-commission-calc]", box).forEach((button) => {
    button.addEventListener("click", () => openCommissionUnlockModal(button.closest<HTMLElement>(".commission-calc-row")?.dataset.commissionCalculationId || ""));
  });
}

function renderCommissionRules() {
  const box = qs<HTMLElement>("#commissionRuleRows");
  if (!box) return;
  box.innerHTML = state.commissionProducts.length ? state.commissionProducts.map((product) => {
    const productRules = state.commissionRules
      .filter((item) => item.productId === product.id)
      .sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.createdAt.localeCompare(left.createdAt));
    const rule = productRules.find((item) => item.enabled) || productRules[0];
    return `<article class="commission-rule-row">
      <div class="commission-rule-top"><b>${escapeHtml(product.name)}</b>${badge(product.status === "active" ? "产品启用" : "产品停用", product.status === "active" ? "green" : "gray")}</div>
      <p>${escapeHtml(product.category || "未分类")} · ${escapeHtml(product.model || "无型号")} · 成本 ${currencyAmount(product.costPrice, product.currency)} · ${rule ? commissionRuleLabel(rule) : "未配置规则"}${rule && !rule.enabled ? " · 规则停用" : ""}</p>
      ${state.commissionCanManage ? `<div class="commission-row-actions">
        <button class="btn" data-edit-commission-product="${escapeHtml(product.id)}">编辑产品</button>
        <button class="btn" data-edit-commission-rule="${escapeHtml(product.id)}">${rule ? "编辑规则" : "新增规则"}</button>
        ${rule ? `<button class="btn" data-toggle-commission-rule="${escapeHtml(rule.id)}">${rule.enabled ? "停用规则" : "启用规则"}</button>` : ""}
      </div>` : ""}
    </article>`;
  }).join("") : `<div class="commission-empty">暂无产品规则</div>`;
  qsa<HTMLButtonElement>("[data-edit-commission-product]", box).forEach((button) => {
    button.addEventListener("click", () => {
      const product = state.commissionProducts.find((item) => item.id === button.dataset.editCommissionProduct);
      if (product) openCommissionProductModal(product);
    });
  });
  qsa<HTMLButtonElement>("[data-edit-commission-rule]", box).forEach((button) => {
    button.addEventListener("click", () => {
      const product = state.commissionProducts.find((item) => item.id === button.dataset.editCommissionRule);
      if (!product) return;
      const rule = state.commissionRules
        .filter((item) => item.productId === product.id)
        .sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.createdAt.localeCompare(left.createdAt))[0];
      openCommissionRuleModal(product, rule);
    });
  });
  qsa<HTMLButtonElement>("[data-toggle-commission-rule]", box).forEach((button) => {
    button.addEventListener("click", () => void toggleCommissionRule(button.dataset.toggleCommissionRule || ""));
  });
}

async function syncCommissionDeals() {
  const button = qs<HTMLButtonElement>("#commissionSyncDealsButton");
  if (button) button.disabled = true;
  try {
    const result = await api<{ created: MonthlySalesRecord[]; records: MonthlySalesRecord[] }>("/api/commission/sales-records/sync-from-deals", {
      method: "POST",
      body: JSON.stringify({ month: state.commissionMonth, ownerId: state.selectedCommissionOwnerId })
    });
    state.commissionRecords = result.records;
    renderCommission();
    toast(result.created.length ? `已同步 ${result.created.length} 条归档成交` : "本月暂无可同步的新归档成交");
  } finally {
    if (button) button.disabled = false;
  }
}

function openCommissionRecordModal(record?: MonthlySalesRecord) {
  if (!record && state.commissionCanSelectOwner && (!state.selectedCommissionOwnerId || state.selectedCommissionOwnerId === "all")) {
    toast("请先在查看人员中选择具体业务员，再新增销售记录", "error");
    return;
  }
  const products = state.commissionProducts.filter((item) => item.status === "active");
  openModal(record ? "编辑售卖记录" : "新增售卖记录", `
    <div class="form-grid">
      <div class="form-field"><label>月份</label><input id="commissionRecordMonthInput" type="month" value="${escapeHtml(record?.month || state.commissionMonth)}"></div>
      <div class="form-field"><label>客户</label><input id="commissionRecordCustomerInput" value="${escapeHtml(record?.customerName || "")}" placeholder="客户公司"></div>
      <div class="form-field full"><label>产品</label><select id="commissionRecordProductInput"><option value="">手工填写产品</option>${products.map((product) => `<option value="${escapeHtml(product.id)}" ${product.id === record?.productId ? "selected" : ""}>${escapeHtml(product.name)}</option>`).join("")}</select></div>
      <div class="form-field full"><label>产品名称</label><input id="commissionRecordProductNameInput" value="${escapeHtml(record?.productName || products[0]?.name || "")}"></div>
      <div class="form-field"><label>数量</label><input id="commissionRecordQuantityInput" type="number" step="1" min="0" value="${record?.quantity ?? 1}"></div>
      <div class="form-field"><label>单价</label><input id="commissionRecordUnitPriceInput" type="number" step="0.01" min="0" value="${record?.unitPrice ?? products[0]?.defaultPrice ?? 0}"></div>
      <div class="form-field"><label>原币币种</label><select id="commissionRecordCurrencyInput">${["USD", "EUR", "CNY", "GBP"].map((currency) => `<option ${currency === (record?.currency || "USD") ? "selected" : ""}>${currency}</option>`).join("")}</select></div>
      <div class="form-field"><label>计提依据</label><select id="commissionRecordBasisTypeInput"><option value="receipt" ${record?.basisType !== "deal_amount" ? "selected" : ""}>实际回款</option><option value="deal_amount" ${record?.basisType === "deal_amount" ? "selected" : ""}>成交金额待核对</option></select></div>
      <div class="form-field"><label>依据日期</label><input id="commissionRecordBasisDateInput" type="date" value="${escapeHtml(record?.basisDate || "")}"></div>
      <div class="form-field"><label>兑 CNY 汇率</label><input id="commissionRecordExchangeInput" type="number" step="0.0001" min="0" value="${record?.exchangeRate ?? 1}"></div>
      <div class="form-field"><label>汇率日期</label><input id="commissionRecordExchangeDateInput" type="date" value="${escapeHtml(record?.exchangeRateDate || "")}"></div>
      <div class="form-field"><label>汇率来源</label><select id="commissionRecordExchangeSourceInput"><option value="pending" ${record?.exchangeRateSource === "pending" ? "selected" : ""}>待核对</option><option value="manual" ${record?.exchangeRateSource === "manual" ? "selected" : ""}>手工录入</option><option value="finance" ${record?.exchangeRateSource === "finance" ? "selected" : ""}>财务确认</option></select></div>
      <div class="form-field"><label>状态</label><select id="commissionRecordStatusInput"><option value="draft" ${record?.status === "draft" ? "selected" : ""}>待确认</option><option value="confirmed" ${record?.status === "confirmed" ? "selected" : ""}>已确认</option></select></div>
      ${record ? `<div class="form-field full"><label>修改原因</label><input id="commissionRecordEditNoteInput" placeholder="必须填写，例如：实际结算数量调整" value="${escapeHtml(record.editNote || "")}"></div>` : ""}
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCommissionRecordButton">保存</button>`);
  qs<HTMLSelectElement>("#commissionRecordProductInput")?.addEventListener("change", (event) => {
    const product = state.commissionProducts.find((item) => item.id === (event.currentTarget as HTMLSelectElement).value);
    if (!product) return;
    const name = qs<HTMLInputElement>("#commissionRecordProductNameInput");
    const price = qs<HTMLInputElement>("#commissionRecordUnitPriceInput");
    if (name) name.value = product.name;
    if (price && !Number(price.value)) price.value = String(product.defaultPrice || 0);
  });
  qs("#saveCommissionRecordButton")?.addEventListener("click", () => void saveCommissionRecord(record?.id || ""));
}

async function saveCommissionRecord(id = "") {
  const button = qs<HTMLButtonElement>("#saveCommissionRecordButton");
  const productId = qs<HTMLSelectElement>("#commissionRecordProductInput")?.value || "";
  const quantity = Number(qs<HTMLInputElement>("#commissionRecordQuantityInput")?.value || 0);
  const unitPrice = Number(qs<HTMLInputElement>("#commissionRecordUnitPriceInput")?.value || 0);
  const payload = {
    ownerId: id ? "" : state.selectedCommissionOwnerId,
    month: qs<HTMLInputElement>("#commissionRecordMonthInput")?.value || state.commissionMonth,
    customerName: qs<HTMLInputElement>("#commissionRecordCustomerInput")?.value.trim() || "未填写客户",
    productId,
    productName: qs<HTMLInputElement>("#commissionRecordProductNameInput")?.value.trim() || state.commissionProducts.find((item) => item.id === productId)?.name || "未填写产品",
    quantity,
    unitPrice,
    salesAmount: Math.round(quantity * unitPrice * 100) / 100,
    currency: qs<HTMLSelectElement>("#commissionRecordCurrencyInput")?.value || "USD",
    exchangeRate: Number(qs<HTMLInputElement>("#commissionRecordExchangeInput")?.value || 1),
    exchangeRateDate: qs<HTMLInputElement>("#commissionRecordExchangeDateInput")?.value || "",
    exchangeRateSource: qs<HTMLSelectElement>("#commissionRecordExchangeSourceInput")?.value || "pending",
    settlementCurrency: "CNY",
    basisType: qs<HTMLSelectElement>("#commissionRecordBasisTypeInput")?.value || "receipt",
    basisDate: qs<HTMLInputElement>("#commissionRecordBasisDateInput")?.value || "",
    status: qs<HTMLSelectElement>("#commissionRecordStatusInput")?.value || "draft",
    editNote: qs<HTMLInputElement>("#commissionRecordEditNoteInput")?.value.trim() || ""
  };
  if (id && !payload.editNote) {
    toast("编辑销售记录必须填写修改原因", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "保存中...";
  }
  try {
    const result = await api<{ record: MonthlySalesRecord }>(id ? `/api/commission/sales-records/${id}` : "/api/commission/sales-records", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    if (id) state.commissionRecords = state.commissionRecords.map((item) => item.id === id ? result.record : item);
    else state.commissionRecords.unshift(result.record);
    state.commissionMonth = result.record.month;
    closeModal();
    renderCommission();
    toast(id ? "售卖记录已更新并留痕" : "售卖记录已新增");
  } catch (error) {
    toast(error instanceof Error ? error.message : "销售记录保存失败", "error");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "保存";
    }
  }
}

async function confirmCommissionRecord(id: string, button?: HTMLButtonElement) {
  const record = state.commissionRecords.find((item) => item.id === id);
  if (!record) {
    toast("未找到这条计提记录，请刷新后重试", "error");
    return;
  }
  const originalLabel = button?.textContent || "确认";
  if (button) {
    button.disabled = true;
    button.textContent = "确认中...";
  }
  try {
    const result = await api<{ record: MonthlySalesRecord }>(`/api/commission/sales-records/${id}/confirm`, { method: "POST" });
    state.commissionRecords = state.commissionRecords.map((item) => item.id === id ? result.record : item);
    renderCommission();
    toast("销售记录已确认，可参与提成计算");
  } catch (error) {
    const message = error instanceof Error ? error.message : "销售记录确认失败";
    toast(message, "error");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

async function openCommissionAuditModal(id: string) {
  const result = await api<{ audits: SalesRecordAudit[] }>(`/api/commission/sales-records/${id}/audits`);
  openModal("销售记录编辑留痕", `
    <div class="table-wrap"><table><thead><tr><th>字段</th><th>原值</th><th>新值</th><th>原因</th><th>操作人</th></tr></thead><tbody>
      ${result.audits.map((audit) => `<tr><td>${escapeHtml(audit.fieldName)}</td><td>${escapeHtml(audit.oldValue)}</td><td>${escapeHtml(audit.newValue)}</td><td>${escapeHtml(audit.reason)}</td><td>${escapeHtml(audit.operatorName)} · ${escapeHtml(formatDateTime(audit.createdAt))}</td></tr>`).join("") || `<tr><td colspan="5" class="empty-cell">暂无留痕</td></tr>`}
    </tbody></table></div>
  `, `<button class="btn primary" data-modal-close>知道了</button>`);
}

async function openCommissionRecordDetailModal(id: string) {
  const record = state.commissionRecords.find((item) => item.id === id);
  if (!record) return;
  const items = state.commissionItems.filter((entry) => entry.recordId === record.id);
  const item = items.find((entry) => entry.sourceType === "auto") || items[0];
  const commission = commissionAmountForRecord(record);
  let snapshot: { formula?: string; reason?: string } = {};
  try {
    snapshot = JSON.parse(item?.ruleSnapshotJson || "{}") as typeof snapshot;
  } catch {
    snapshot = {};
  }
  openModal("提成记录明细", `
    <div class="commission-detail-grid">
      <div><span>客户 / 产品</span><b>${escapeHtml(record.customerName)} · ${escapeHtml(record.productName)}</b></div>
      <div><span>计提依据</span><b>${record.basisType === "receipt" ? "实际回款" : "成交金额待核对"} · ${escapeHtml(record.basisDate || "未填日期")}</b></div>
      <div><span>原币金额</span><b>${currencyAmount(record.salesAmount, record.currency)}</b></div>
      <div><span>汇率</span><b>${Number(record.exchangeRate || 0).toLocaleString("en-US")} · ${commissionExchangeSourceLabel(record.exchangeRateSource)} · ${escapeHtml(record.exchangeRateDate || "未填日期")}</b></div>
      <div><span>结算金额</span><b>${currencyAmount(record.settlementAmount, "CNY")}</b></div>
      <div><span>提成额</span><b>${currencyAmount(commission.amount, "CNY")} · ${escapeHtml(commission.label)}</b></div>
      <div class="full"><span>计算公式</span><b>${escapeHtml(snapshot.formula || item?.remark || "尚未计算")}</b></div>
      <div class="full"><span>状态与来源</span><b>${commissionStatusLabel(record.status)} · ${record.sourceType === "deal" ? "归档商机同步" : record.sourceType === "manual" ? "手工录入" : "人工修正"}</b></div>
    </div>
  `, `<button class="btn" id="commissionDetailAuditButton">${record.edited ? "查看编辑留痕" : "暂无编辑留痕"}</button><button class="btn primary" data-modal-close>关闭</button>`);
  const auditButton = qs<HTMLButtonElement>("#commissionDetailAuditButton");
  if (auditButton) {
    auditButton.disabled = !record.edited;
    auditButton.onclick = () => void openCommissionAuditModal(record.id);
  }
}

function openCommissionCalculationDetailModal(id: string) {
  const calculation = state.commissionCalculations.find((item) => item.id === id);
  if (!calculation) return;
  const items = state.commissionItems.filter((item) => item.calculationId === calculation.id);
  openModal(`提成计算明细 · V${calculation.version || 1}`, `
    <div class="commission-detail-summary">
      <span>计提基数<strong>${currencyAmount(calculation.salesAmount)}</strong></span>
      <span>自动提成<strong>${currencyAmount(calculation.autoCommission)}</strong></span>
      <span>人工调整<strong>${currencyAmount(calculation.manualAdjustment)}</strong></span>
      <span>最终提成<strong>${currencyAmount(calculation.finalCommission)}</strong></span>
    </div>
    <div class="commission-detail-list">${items.map((item) => {
      const record = state.commissionRecords.find((entry) => entry.id === item.recordId);
      let formula = item.remark;
      try {
        formula = (JSON.parse(item.ruleSnapshotJson || "{}") as { formula?: string }).formula || formula;
      } catch {
        formula = item.remark;
      }
      return `<article><div><b>${escapeHtml(record ? `${record.customerName} · ${record.productName}` : item.remark)}</b><span>${item.sourceType === "auto" ? escapeHtml(formula) : `人工调整 · ${escapeHtml(item.remark)}`}</span></div><strong>${currencyAmount(item.finalAmount)}</strong></article>`;
    }).join("") || `<div class="commission-empty">暂无计算明细。</div>`}</div>
    <p class="commission-detail-meta">状态：${commissionStatusLabel(calculation.status)} · 计算时间：${escapeHtml(calculation.calculatedAt ? formatDateTime(calculation.calculatedAt) : "尚未计算")}</p>
  `, `<button class="btn primary" data-modal-close>关闭</button>`);
}

async function reviewCommissionCalculation(id: string) {
  const result = await api<{ calculation: CommissionCalculation }>(`/api/commission/calculations/${id}/review`, { method: "POST" });
  state.commissionCalculations = state.commissionCalculations.map((item) => item.id === id ? result.calculation : item);
  await refreshCommissionData();
  toast("提成单已复核，下一步可锁定");
}

async function lockCommissionCalculation(id: string) {
  const result = await api<{ calculation: CommissionCalculation }>(`/api/commission/calculations/${id}/lock`, { method: "POST" });
  state.commissionCalculations = state.commissionCalculations.map((item) => item.id === id ? result.calculation : item);
  await refreshCommissionData();
  toast("提成单已锁定，记录和金额不可再直接修改");
}

function openCommissionUnlockModal(id: string) {
  openModal("解锁提成单", `
    <div class="form-grid"><div class="form-field full"><label>解锁原因</label><textarea id="commissionUnlockReasonInput" rows="4" placeholder="说明为什么需要修正，以及准备调整的内容"></textarea></div></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmCommissionUnlockButton">确认解锁并生成新版本</button>`);
  qs("#confirmCommissionUnlockButton")?.addEventListener("click", () => void unlockCommissionCalculation(id));
}

async function unlockCommissionCalculation(id: string) {
  const reason = qs<HTMLTextAreaElement>("#commissionUnlockReasonInput")?.value.trim() || "";
  if (reason.length < 4) {
    toast("请填写至少 4 个字的解锁原因", "error");
    return;
  }
  await api(`/api/commission/calculations/${id}/unlock`, { method: "POST", body: JSON.stringify({ reason }) });
  closeModal();
  await refreshCommissionData();
  toast("已保留锁定版本，并生成待重算的新版本");
}

async function recalculateCommission() {
  const result = await api<{ calculations: CommissionCalculation[]; items: CommissionItem[] }>("/api/commission/calculations/recalculate", {
    method: "POST",
    body: JSON.stringify({ month: state.commissionMonth, ownerId: state.selectedCommissionOwnerId })
  });
  state.commissionCalculations = result.calculations;
  state.commissionItems = result.items;
  renderCommission();
  toast("提成已按当前确认记录重新计算");
}

function openCommissionManualItemModal() {
  if (!state.commissionCanReview) {
    toast("只有管理员和超级管理员可以调整提成金额", "error");
    return;
  }
  if (!state.commissionCalculations.length) {
    toast("请先重新计算生成提成单", "error");
    return;
  }
  const selected = state.selectedCommissionCalculationId || state.commissionCalculations[0].id;
  openModal("新增提成调整项", `
    <div class="form-grid">
      <div class="form-field full"><label>提成单</label><select id="commissionManualCalcInput">${state.commissionCalculations.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.month)} · ${escapeHtml(item.ownerId)} · ${amount(item.finalCommission)}</option>`).join("")}</select></div>
      <div class="form-field full"><label>关联记录</label><select id="commissionManualRecordInput"><option value="">月度公共调整</option>${state.commissionRecords.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.customerName)} · ${escapeHtml(item.productName)}</option>`).join("")}</select></div>
      <div class="form-field"><label>类型</label><select id="commissionManualTypeInput"><option value="bonus">奖金</option><option value="deduction">扣减</option><option value="subsidy">补贴</option><option value="refund">退款扣回</option><option value="special">特殊项</option><option value="other">其它</option></select></div>
      <div class="form-field"><label>金额</label><input id="commissionManualAmountInput" type="number" step="0.01" value="0"></div>
      <div class="form-field full"><label>说明</label><input id="commissionManualRemarkInput" placeholder="例如：大客户首单专项奖励"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCommissionManualButton">保存调整</button>`);
  qs("#saveCommissionManualButton")?.addEventListener("click", () => void saveCommissionManualItem());
}

async function saveCommissionManualItem() {
  const calculationId = qs<HTMLSelectElement>("#commissionManualCalcInput")?.value || "";
  const result = await api<{ calculation: CommissionCalculation; item: CommissionItem }>(`/api/commission/calculations/${calculationId}/manual-item`, {
    method: "POST",
    body: JSON.stringify({
      itemType: qs<HTMLSelectElement>("#commissionManualTypeInput")?.value || "other",
      manualAmount: Number(qs<HTMLInputElement>("#commissionManualAmountInput")?.value || 0),
      recordId: qs<HTMLSelectElement>("#commissionManualRecordInput")?.value || "",
      remark: qs<HTMLInputElement>("#commissionManualRemarkInput")?.value.trim() || ""
    })
  });
  state.commissionCalculations = state.commissionCalculations.map((item) => item.id === result.calculation.id ? result.calculation : item);
  state.commissionItems.unshift(result.item);
  closeModal();
  renderCommission();
  toast("提成调整项已保存");
}

function openCommissionProductModal(editing?: CommissionProduct) {
  if (!state.commissionCanManage) {
    toast("当前账号只能查看产品规则，维护需管理员权限", "error");
    return;
  }
  openModal(editing ? "编辑提成产品" : "新增提成产品", `
    <div class="form-grid">
      <div class="form-field full"><label>产品名称</label><input id="commissionProductNameInput" value="${escapeHtml(editing?.name || "")}" placeholder="例如：核心产品 / 型号 X100"></div>
      <div class="form-field"><label>分类</label><input id="commissionProductCategoryInput" value="${escapeHtml(editing?.category || "")}" placeholder="产品分类"></div>
      <div class="form-field"><label>型号</label><input id="commissionProductModelInput" value="${escapeHtml(editing?.model || "")}" placeholder="X100"></div>
      <div class="form-field"><label>币种</label><select id="commissionProductCurrencyInput">${["USD", "EUR", "CNY", "GBP"].map((currency) => `<option ${currency === (editing?.currency || "USD") ? "selected" : ""}>${currency}</option>`).join("")}</select></div>
      <div class="form-field"><label>状态</label><select id="commissionProductStatusInput"><option value="active" ${editing?.status !== "disabled" ? "selected" : ""}>启用</option><option value="disabled" ${editing?.status === "disabled" ? "selected" : ""}>停用</option></select></div>
      <div class="form-field"><label>默认单价</label><input id="commissionProductPriceInput" type="number" step="0.01" value="${editing?.defaultPrice ?? 0}"></div>
      <div class="form-field"><label>成本价</label><input id="commissionProductCostInput" type="number" step="0.01" value="${editing?.costPrice ?? 0}"></div>
      <div class="form-field full"><label>备注</label><input id="commissionProductRemarkInput" value="${escapeHtml(editing?.remark || "")}" placeholder="产品适用说明"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCommissionProductButton">${editing ? "保存产品" : "新增产品"}</button>`);
  qs("#saveCommissionProductButton")?.addEventListener("click", () => void saveCommissionProduct(editing?.id || ""));
}

async function saveCommissionProduct(id = "") {
  const result = await api<{ product: CommissionProduct }>(id ? `/api/commission/products/${id}` : "/api/commission/products", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify({
      name: qs<HTMLInputElement>("#commissionProductNameInput")?.value.trim() || "",
      category: qs<HTMLInputElement>("#commissionProductCategoryInput")?.value.trim() || "",
      model: qs<HTMLInputElement>("#commissionProductModelInput")?.value.trim() || "",
      currency: qs<HTMLSelectElement>("#commissionProductCurrencyInput")?.value || "USD",
      status: qs<HTMLSelectElement>("#commissionProductStatusInput")?.value || "active",
      defaultPrice: Number(qs<HTMLInputElement>("#commissionProductPriceInput")?.value || 0),
      costPrice: Number(qs<HTMLInputElement>("#commissionProductCostInput")?.value || 0),
      remark: qs<HTMLInputElement>("#commissionProductRemarkInput")?.value.trim() || ""
    })
  });
  state.commissionProducts = id
    ? state.commissionProducts.map((product) => product.id === result.product.id ? result.product : product)
    : [result.product, ...state.commissionProducts];
  closeModal();
  renderCommission();
  toast(id ? "提成产品已保存" : "提成产品已新增");
}

function ruleValueFor(rule?: CommissionRule) {
  if (!rule) return "";
  if (rule.ruleType === "rate") return String((rule.rate || 0) * 100);
  if (rule.ruleType === "fixed") return String(rule.fixedAmount || 0);
  if (rule.ruleType === "gross_profit") return String((rule.grossProfitRate || 0) * 100);
  return "";
}

function openCommissionRuleModal(product: CommissionProduct, rule?: CommissionRule) {
  if (!state.commissionCanManage) {
    toast("当前账号只能查看产品规则，维护需管理员权限", "error");
    return;
  }
  openModal(rule ? "编辑提成规则" : "新增提成规则", `
    <div class="form-grid">
      <div class="form-field full"><label>适用产品</label><input value="${escapeHtml(product.name)}" readonly></div>
      <div class="form-field"><label>规则类型</label><select id="commissionRuleTypeInput">
        <option value="rate" ${rule?.ruleType === "rate" ? "selected" : ""}>销售额比例</option>
        <option value="gross_profit" ${rule?.ruleType === "gross_profit" ? "selected" : ""}>毛利比例</option>
        <option value="tier" ${rule?.ruleType === "tier" ? "selected" : ""}>阶梯比例</option>
        <option value="fixed" ${rule?.ruleType === "fixed" ? "selected" : ""}>固定金额</option>
        <option value="none" ${rule?.ruleType === "none" ? "selected" : ""}>不计提</option>
      </select></div>
      <div class="form-field"><label>比例（%）/ 固定金额</label><input id="commissionRuleValueInput" type="number" step="0.01" min="0" value="${escapeHtml(ruleValueFor(rule))}" placeholder="比例填 3 表示 3%，固定规则填写金额"></div>
      <div class="form-field"><label>生效月份</label><input id="commissionRuleFromInput" type="month" value="${escapeHtml(rule?.effectiveFrom || state.commissionMonth)}"></div>
      <div class="form-field"><label>失效月份</label><input id="commissionRuleToInput" type="month" value="${escapeHtml(rule?.effectiveTo || "")}"></div>
      <div class="form-field"><label>状态</label><select id="commissionRuleEnabledInput"><option value="true" ${rule?.enabled !== false ? "selected" : ""}>启用</option><option value="false" ${rule?.enabled === false ? "selected" : ""}>停用</option></select></div>
      <div class="form-field full"><label>阶梯JSON</label><input id="commissionRuleTierInput" value="${escapeHtml(rule?.tierJson || "")}" placeholder='[{"from":0,"to":30000,"rate":0.02}]'></div>
      <div class="form-field full"><label>规则说明</label><input id="commissionRuleRemarkInput" value="${escapeHtml(rule?.remark || "")}" placeholder="例如：标准销售额 3%"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCommissionRuleButton">${rule ? "保存规则" : "新增规则"}</button>`);
  qs("#saveCommissionRuleButton")?.addEventListener("click", () => void saveCommissionRule(product.id, rule?.id || ""));
}

async function saveCommissionRule(productId: string, ruleId = "") {
  const ruleType = (qs<HTMLSelectElement>("#commissionRuleTypeInput")?.value || "rate") as CommissionRuleType;
  const value = Number(qs<HTMLInputElement>("#commissionRuleValueInput")?.value || 0);
  const tierJson = qs<HTMLInputElement>("#commissionRuleTierInput")?.value.trim() || "";
  const remark = qs<HTMLInputElement>("#commissionRuleRemarkInput")?.value.trim() || "";
  const normalizedRate = value / 100;
  if ((ruleType === "rate" || ruleType === "gross_profit") && (value < 0 || value > 100)) {
    toast("提成比例必须在 0% 到 100% 之间", "error");
    return;
  }
  const result = await api<{ rule: CommissionRule; replacedRuleId?: string }>(ruleId ? `/api/commission/rules/${ruleId}` : `/api/commission/products/${productId}/rules`, {
    method: ruleId ? "PATCH" : "POST",
    body: JSON.stringify({
      ruleType,
      rate: ruleType === "rate" ? normalizedRate : 0,
      fixedAmount: ruleType === "fixed" ? value : 0,
      grossProfitRate: ruleType === "gross_profit" ? normalizedRate : 0,
      tierJson: ruleType === "tier" ? tierJson : "",
      effectiveFrom: qs<HTMLInputElement>("#commissionRuleFromInput")?.value || state.commissionMonth,
      effectiveTo: qs<HTMLInputElement>("#commissionRuleToInput")?.value || "",
      enabled: qs<HTMLSelectElement>("#commissionRuleEnabledInput")?.value !== "false",
      remark: remark || (ruleType === "tier" ? "阶梯提成" : "")
    })
  });
  state.commissionRules = ruleId
    ? [result.rule, ...state.commissionRules.filter((rule) => rule.id !== result.rule.id && rule.id !== result.replacedRuleId)]
    : [result.rule, ...state.commissionRules];
  closeModal();
  renderCommission();
  toast(ruleId ? "提成规则已保存" : "提成规则已新增");
}

async function toggleCommissionRule(id: string) {
  const rule = state.commissionRules.find((item) => item.id === id);
  if (!rule) return;
  const result = await api<{ rule: CommissionRule }>(`/api/commission/rules/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: !rule.enabled })
  });
  state.commissionRules = state.commissionRules.map((item) => item.id === id ? result.rule : item);
  renderCommission();
  toast(result.rule.enabled ? "提成规则已启用" : "提成规则已停用");
}

async function exportCommission() {
  const result = await api<{ exportJob: { id: string; rows: number }; rows: Record<string, unknown>[]; summaryRows: Record<string, unknown>[] }>("/api/commission/export", {
    method: "POST",
    body: JSON.stringify({
      month: state.commissionMonth,
      ownerId: state.selectedCommissionOwnerId,
      scopeType: state.commissionCanReview && state.selectedCommissionOwnerId === "all" ? "all" : "self",
      fileType: "xlsx"
    })
  });
  const detailColumns = [
    ["month", "计提月份"],
    ["ownerName", "业务员"],
    ["customerName", "客户名称"],
    ["productName", "产品名称"],
    ["quantity", "数量"],
    ["unitPrice", "单价"],
    ["currency", "原币币种"],
    ["salesAmount", "原币金额"],
    ["exchangeRate", "结算汇率"],
    ["exchangeRateDate", "汇率日期"],
    ["exchangeRateSource", "汇率来源"],
    ["settlementCurrency", "结算币种"],
    ["settlementAmount", "计提基数"],
    ["basisType", "计提依据"],
    ["basisDate", "计提日期"],
    ["status", "记录状态"],
    ["edited", "是否修正"],
    ["recordCommission", "提成额"],
    ["calculationStatus", "提成单状态"],
    ["editNote", "修正说明"]
  ] as const;
  const summaryColumns = [
    ["month", "计提月份"],
    ["ownerName", "业务员"],
    ["settlementCurrency", "结算币种"],
    ["salesAmount", "计提基数"],
    ["autoCommission", "自动提成"],
    ["manualAdjustment", "人工调整"],
    ["finalCommission", "最终提成"],
    ["status", "提成单状态"],
    ["version", "版本"]
  ] as const;
  const translateExportValue = (key: string, value: unknown) => {
    const labels: Record<string, Record<string, string>> = {
      exchangeRateSource: { pending: "待确认", finance: "财务汇率", manual: "手工录入" },
      basisType: { receipt: "实际回款", deal_amount: "成交金额" },
      status: { draft: "待确认", confirmed: "已确认", reviewed: "已复核", locked: "已锁定", calculated: "已计算", pending: "待计算" },
      calculationStatus: { draft: "草稿", calculated: "已计算", reviewed: "已复核", locked: "已锁定", pending: "待计算" },
      edited: { true: "是", false: "否" }
    };
    return labels[key]?.[String(value)] ?? value ?? "";
  };
  const toChineseRows = (rows: Record<string, unknown>[], columns: readonly (readonly [string, string])[]) =>
    rows.map((row) => Object.fromEntries(columns.map(([key, label]) => [label, translateExportValue(key, row[key])])));
  const detailSheet = XLSX.utils.json_to_sheet(toChineseRows(result.rows, detailColumns));
  const summarySheet = XLSX.utils.json_to_sheet(toChineseRows(result.summaryRows, summaryColumns));
  detailSheet["!cols"] = detailColumns.map(([, label]) => ({ wch: Math.max(label.length * 2 + 2, 12) }));
  summarySheet["!cols"] = summaryColumns.map(([, label]) => ({ wch: Math.max(label.length * 2 + 2, 12) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, summarySheet, "人员月度汇总");
  XLSX.utils.book_append_sheet(workbook, detailSheet, "逐笔计提明细");
  XLSX.writeFile(workbook, `GoodJob-提成对账-${state.commissionMonth}.xlsx`);
  toast(`已导出 ${result.exportJob.rows} 行提成对账数据`);
}

/**
 * 规则卡片第二行的文案：**这一次运行到底为什么没生成待办**。
 * 数据来自后端 `lastSkipReasons`（每次运行重算并落库），不是写死的模板 ——
 * 只有真跑过一轮才知道是"客户已有未完成待办"还是"刚完成、还在重新计时"。
 */
export function reminderRunNote(reminder: Reminder, liveTodos: number): { text: string; tone: "muted" | "amber" } {
  const generates = reminder.generateTodo !== false;
  const unit = `${reminder.days ?? 3} ${reminderTimeUnitText(reminder.timeUnit)}`;
  if (!reminder.lastRunAt) {
    if (!generates) return { tone: "amber", text: "未勾选「生成待办中心任务」：只记录命中统计，不产生待办" };
    return liveTodos
      ? { tone: "amber", text: `当前已存在 ${liveTodos} 条未完成待办 → 本次不会重复生成，完成后按 ${unit} 重新计时` }
      : { tone: "muted", text: "尚未运行；命中且该客户没有未完成待办时会生成待办" };
  }
  const whom = (customers?: string[]) => {
    const names = (customers || []).slice(0, 2).join("、");
    if (!names) return "";
    return (customers || []).length > 2 ? `（${names} 等）` : `（${names}）`;
  };
  const parts = (reminder.lastSkipReasons || [])
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => {
      if (bucket.reason === "generate-disabled") return `${bucket.count} 条命中未生成：规则未勾选「生成待办中心任务」，只统计`;
      if (bucket.reason === "active-todo") return `${bucket.count} 条命中跳过${whom(bucket.customers)}：该客户已有未完成待办，完成后按 ${unit} 重新计时`;
      if (bucket.reason === "cooldown") return `${bucket.count} 条命中跳过${whom(bucket.customers)}：待办刚完成，还在按 ${unit} 重新计时`;
      return `${bucket.count} 条命中跳过`;
    });
  const created = reminder.lastCreatedCount || 0;
  if (created) parts.unshift(`已生成 ${created} 条待办`);
  if (!parts.length) {
    const matched = reminder.lastMatchedCount || 0;
    return matched
      ? { tone: "muted", text: `命中 ${matched} 条，本次无需新建（已有待办覆盖）` }
      : { tone: "muted", text: "本次没有命中记录" };
  }
  return { tone: created && (reminder.lastSkippedCount || 0) === 0 ? "muted" : "amber", text: parts.join("；") };
}
