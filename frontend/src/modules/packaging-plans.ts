/**
 * 包装方案管理（业务中心 → 包装方案）
 *
 * 业务来源：外贸单据要按「这一票货怎么装」算件数、净重毛重、外尺寸与体积。
 * 一个方案 = 一组包装件，两种形态：
 *   - 通用方案（general）：不绑物料，任何单据都能直接用
 *   - 物料方案（product）：绑定某个产品/物料，带出它的名称与型号
 *
 * 这里是唯一的数据入口：单据平台与商机都通过 ensurePackagingPlansLoaded /
 * openPackagingPlanPicker 复用它，不各自再拉一遍接口。
 */
import { closeModal, confirmAction, openModal, state } from "../prototype-api";
import {
  PACKAGING_SCOPE_META, packagingItemVolumeCbm, packagingPlanSummary,
  type PackagingPlan, type PackagingPlanItem, type PackagingPlanScope, type Product
} from "./models";
import { badge, escapeHtml, qs, qsa } from "./shared";
import { api, setButtonPending, toast } from "./ui";
import { hasIamCapability } from "./auth";
import { formatLeadDate } from "./leads";

// ---------------------------------------------------------------------------
// 数据
// ---------------------------------------------------------------------------

export async function loadPackagingPlans(force = false) {
  if (state.packagingPlansLoaded && !force) return state.packagingPlans;
  const result = await api<{ plans: PackagingPlan[] }>("/api/packaging-plans");
  state.packagingPlans = result.plans || [];
  state.packagingPlansLoaded = true;
  return state.packagingPlans;
}

/** 单据/商机用：确保方案已加载但不阻塞渲染；失败静默（选择器会给出口） */
export async function ensurePackagingPlansLoaded() {
  try {
    return await loadPackagingPlans();
  } catch {
    return state.packagingPlans;
  }
}

export function packagingPlanById(id?: string) {
  if (!id) return undefined;
  return state.packagingPlans.find((plan) => plan.id === id);
}

function packagingPlanName(plan: PackagingPlan) {
  return plan.name || plan.code || "未命名包装方案";
}

function packagingScopeBadge(plan: PackagingPlan) {
  const meta = PACKAGING_SCOPE_META[plan.scope] || PACKAGING_SCOPE_META.general;
  return badge(meta.label, meta.tone);
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

export function filteredPackagingPlans() {
  const query = state.packagingPlanSearch.trim().toLowerCase();
  return state.packagingPlans.filter((plan) => {
    const matchScope = state.packagingPlanScopeFilter === "all" || plan.scope === state.packagingPlanScopeFilter;
    const haystack = [
      plan.code, plan.name, plan.productName, plan.productModel, plan.summary, plan.remark
    ].filter(Boolean).join(" ").toLowerCase();
    return matchScope && (!query || haystack.includes(query));
  });
}

export function sortedPackagingPlans(plans: PackagingPlan[]) {
  return [...plans].sort((a, b) => {
    const left = new Date(a.updatedAt || a.createdAt).getTime() || 0;
    const right = new Date(b.updatedAt || b.createdAt).getTime() || 0;
    return right - left;
  });
}

function packagingPageRows(plans: PackagingPlan[]) {
  const pageCount = Math.max(1, Math.ceil(plans.length / state.packagingPlanPageSize));
  state.packagingPlanPage = Math.min(Math.max(1, state.packagingPlanPage), pageCount);
  const start = (state.packagingPlanPage - 1) * state.packagingPlanPageSize;
  return { pageCount, start, rows: plans.slice(start, start + state.packagingPlanPageSize) };
}

function renderPackagingPagination(total: number, pageCount: number, start: number) {
  const summary = qs<HTMLElement>("#packagingPlanPageSummary");
  if (summary) {
    summary.textContent = total
      ? `共 ${total} 个方案，当前 ${start + 1}-${Math.min(start + state.packagingPlanPageSize, total)} 个`
      : "共 0 个方案";
  }
  const number = qs<HTMLElement>("#packagingPlanPageNumber");
  if (number) number.textContent = `${state.packagingPlanPage} / ${pageCount}`;
  const prev = qs<HTMLButtonElement>("#packagingPlanPrevPage");
  if (prev) prev.disabled = state.packagingPlanPage <= 1;
  const next = qs<HTMLButtonElement>("#packagingPlanNextPage");
  if (next) next.disabled = state.packagingPlanPage >= pageCount;
  const size = qs<HTMLSelectElement>("#packagingPlanPageSize");
  if (size) size.value = String(state.packagingPlanPageSize);
}

export function resetPackagingPlanFilters() {
  state.packagingPlanSearch = "";
  state.packagingPlanScopeFilter = "all";
  state.packagingPlanPage = 1;
  [["#packagingPlanSearchInput", ""], ["#packagingPlanScopeFilter", "all"]]
    .forEach(([selector, value]) => {
      const node = qs<HTMLInputElement | HTMLSelectElement>(selector);
      if (node) node.value = value;
    });
  renderPackagingPlans();
}

function packagingCanDelete() {
  return !state.iamCapabilities || hasIamCapability("packaging.delete");
}

function renderPackagingBulkToolbar(visible: PackagingPlan[] = filteredPackagingPlans()) {
  const bar = qs<HTMLElement>("#packagingPlanBulkToolbar");
  if (!bar) return;
  const selectedCount = state.selectedPackagingPlanIds.length;
  const allSelected = visible.length > 0 && visible.every((plan) => state.selectedPackagingPlanIds.includes(plan.id));
  bar.innerHTML = `
    <label class="customer-select-all"><input type="checkbox" data-select-all-packaging-plans ${allSelected ? "checked" : ""}>全选</label>
    <span class="filter">已选 ${selectedCount} 个方案</span>
    <button class="btn danger" data-packaging-bulk-delete ${selectedCount && packagingCanDelete() ? "" : "disabled"}>批量删除</button>
  `;
  qs<HTMLInputElement>("[data-select-all-packaging-plans]", bar)?.addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    const ids = visible.map((plan) => plan.id);
    state.selectedPackagingPlanIds = checked
      ? Array.from(new Set([...state.selectedPackagingPlanIds, ...ids]))
      : state.selectedPackagingPlanIds.filter((id) => !ids.includes(id));
    renderPackagingPlans();
  });
  qs<HTMLButtonElement>("[data-packaging-bulk-delete]", bar)?.addEventListener("click", () => void deletePackagingPlans(state.selectedPackagingPlanIds));
}

/** 方案概览行：件数 / 毛重 / 体积三件套，列表与选择器共用 */
export function packagingPlanStatLine(plan: PackagingPlan) {
  const stats = packagingPlanSummary(plan);
  const parts = [`${stats.packages} 件`];
  if (stats.grossWeightKg > 0) parts.push(`毛重 ${stats.grossWeightKg} kg`);
  if (stats.volumeCbm > 0) parts.push(`${stats.volumeCbm} m³`);
  return parts.join(" · ");
}

export function renderPackagingPlans() {
  const tbody = qs<HTMLElement>("#packagingPlansTableBody");
  if (!tbody) return;
  const visible = sortedPackagingPlans(filteredPackagingPlans());
  const { pageCount, start, rows } = packagingPageRows(visible);
  renderPackagingPagination(visible.length, pageCount, start);

  tbody.innerHTML = rows.length ? rows.map((plan) => {
    const stats = packagingPlanSummary(plan);
    return `<tr data-packaging-plan-id="${escapeHtml(plan.id)}">
      <td><input type="checkbox" class="packaging-row-check" data-packaging-check="${escapeHtml(plan.id)}" aria-label="选择 ${escapeHtml(packagingPlanName(plan))}"${state.selectedPackagingPlanIds.includes(plan.id) ? " checked" : ""} /></td>
      <td><div class="company"><div><button type="button" class="customer-name" data-packaging-open="${escapeHtml(plan.id)}">${escapeHtml(packagingPlanName(plan))}</button><span>${plan.code ? `<b class="sup-code">${escapeHtml(plan.code)}</b> · ` : ""}${escapeHtml(plan.summary || "未填写说明")}</span></div></div></td>
      <td><div class="pkg-scope-cell">${packagingScopeBadge(plan)}${plan.scope === "product" ? `<span class="pkg-product-ref" title="${escapeHtml(plan.productName || "物料待补")}">${escapeHtml(plan.productName || "物料待补")}${plan.productModel ? ` · ${escapeHtml(plan.productModel)}` : ""}</span>` : `<span class="pkg-product-ref">任何单据可用</span>`}</div></td>
      <td><div class="customer-follow-cell"><b>${stats.packages} 件</b><span>${stats.netWeightKg > 0 ? `净重 ${stats.netWeightKg} kg` : "净重待补"}</span></div></td>
      <td><div class="customer-follow-cell"><b>${stats.grossWeightKg > 0 ? `${stats.grossWeightKg} kg` : "待补"}</b><span>${stats.volumeCbm > 0 ? `${stats.volumeCbm} m³` : "体积待补"}</span></div></td>
      <td><div class="customer-follow-cell"><b>${escapeHtml(formatLeadDate(plan.updatedAt || plan.createdAt))}</b><span>${escapeHtml(plan.ownerId ? "团队共享" : "")}</span></div></td>
      <td><div class="customer-row-actions"><button class="btn" type="button" data-packaging-action="edit" data-packaging-row-id="${escapeHtml(plan.id)}">编辑</button>${packagingCanDelete() ? `<button class="btn sup-action-delete" type="button" data-packaging-action="delete" data-packaging-row-id="${escapeHtml(plan.id)}">删除</button>` : ""}</div></td>
    </tr>`;
  }).join("") : (state.packagingPlans.length
    ? `<tr><td colspan="7" class="empty-cell">没有符合筛选条件的包装方案。<button class="btn tiny" id="packagingPlanEmptyReset" type="button">清空筛选</button></td></tr>`
    : `<tr><td colspan="7" class="empty-cell">${state.packagingPlansLoaded ? "还没有包装方案。点右上角「新增包装方案」，把常用的一套装箱方式存下来。" : "包装方案加载中…"}</td></tr>`);

  renderPackagingBulkToolbar(visible);

  const scope = qs<HTMLElement>("#packaging-plans");
  if (scope) {
    qsa<HTMLInputElement>("[data-packaging-check]", scope).forEach((box) => box.addEventListener("change", () => {
      const id = box.dataset.packagingCheck || "";
      if (!id) return;
      state.selectedPackagingPlanIds = box.checked
        ? Array.from(new Set([...state.selectedPackagingPlanIds, id]))
        : state.selectedPackagingPlanIds.filter((item) => item !== id);
      renderPackagingBulkToolbar(visible);
    }));
    qsa<HTMLButtonElement>("[data-packaging-open]", scope).forEach((button) => button.addEventListener("click", () => {
      const plan = packagingPlanById(button.dataset.packagingOpen);
      if (plan) openPackagingPlanModal(plan);
    }));
    qsa<HTMLButtonElement>("[data-packaging-action]", scope).forEach((button) => button.addEventListener("click", () => {
      const plan = packagingPlanById(button.dataset.packagingRowId);
      if (!plan) return;
      if (button.dataset.packagingAction === "edit") openPackagingPlanModal(plan);
      if (button.dataset.packagingAction === "delete") void deletePackagingPlans([plan.id]);
    }));
  }
  qs<HTMLButtonElement>("#packagingPlanEmptyReset")?.addEventListener("click", resetPackagingPlanFilters);
}

// ---------------------------------------------------------------------------
// 包装件编辑器（弹窗内）
// ---------------------------------------------------------------------------

function packagingItemRow(item: PackagingPlanItem, index: number, total: number) {
  return `<div class="pkg-row" data-pkg-row data-pkg-id="${escapeHtml(item.id)}">
    <b class="pkg-seq">${index + 1}/${total}</b>
    <div class="pkg-name-cell">
      <input data-pkg="label" maxlength="120" value="${escapeHtml(item.label)}" placeholder="包装类型，例如 加固出口木箱" aria-label="包装类型" />
      <input data-pkg="model" maxlength="120" value="${escapeHtml(item.model)}" placeholder="归属设备 / 货号" aria-label="归属设备" />
    </div>
    <textarea data-pkg="contents" rows="2" maxlength="300" placeholder="箱内物品，例如 主机框架 / Main frame" aria-label="箱内物品">${escapeHtml(item.contents)}</textarea>
    <div class="pkg-dims">
      <input data-pkg="lengthCm" type="number" min="0" max="1000" step="0.1" value="${item.lengthCm || ""}" placeholder="长" aria-label="长 cm" /><i>×</i>
      <input data-pkg="widthCm" type="number" min="0" max="1000" step="0.1" value="${item.widthCm || ""}" placeholder="宽" aria-label="宽 cm" /><i>×</i>
      <input data-pkg="heightCm" type="number" min="0" max="1000" step="0.1" value="${item.heightCm || ""}" placeholder="高" aria-label="高 cm" />
    </div>
    <div class="pkg-dims">
      <input data-pkg="netWeightKg" type="number" min="0" max="100000" step="0.01" value="${item.netWeightKg || ""}" placeholder="净重" aria-label="净重 kg" /><i>/</i>
      <input data-pkg="grossWeightKg" type="number" min="0" max="100000" step="0.01" value="${item.grossWeightKg || ""}" placeholder="毛重" aria-label="毛重 kg" />
    </div>
    <b class="pkg-volume" data-pkg-volume>${packagingItemVolumeCbm(item).toFixed(3)} m³</b>
    <div class="pkg-row-ops"><button class="btn tiny" type="button" data-pkg-copy>复制</button><button class="btn tiny" type="button" data-pkg-remove>删除</button></div>
  </div>`;
}

function emptyPackagingItem(): PackagingPlanItem {
  return {
    id: `pkg_item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    label: "", contents: "", model: "",
    lengthCm: 0, widthCm: 0, heightCm: 0, netWeightKg: 0, grossWeightKg: 0
  };
}

function refreshPackagingEditor() {
  const host = qs<HTMLElement>("#packagingPlanItemsEditor");
  if (!host) return;
  const rows = qsa<HTMLElement>("[data-pkg-row]", host);
  rows.forEach((row, index) => {
    const seq = qs<HTMLElement>(".pkg-seq", row);
    if (seq) seq.textContent = `${index + 1}/${rows.length}`;
    const volume = qs<HTMLElement>("[data-pkg-volume]", row);
    if (volume) {
      const read = (name: string) => Number(qs<HTMLInputElement>(`[data-pkg="${name}"]`, row)?.value || 0) || 0;
      volume.textContent = `${packagingItemVolumeCbm({
        lengthCm: read("lengthCm"), widthCm: read("widthCm"), heightCm: read("heightCm")
      }).toFixed(3)} m³`;
    }
  });
  const count = qs<HTMLElement>("#packagingPlanItemCount");
  if (count) count.textContent = `${rows.length} 件`;
  bindPackagingRowEvents();
}

function bindPackagingRowEvents() {
  const host = qs<HTMLElement>("#packagingPlanItemsEditor");
  if (!host) return;
  qsa<HTMLButtonElement>("[data-pkg-remove]", host).forEach((button) => {
    button.onclick = () => {
      button.closest("[data-pkg-row]")?.remove();
      refreshPackagingEditor();
    };
  });
  qsa<HTMLButtonElement>("[data-pkg-copy]", host).forEach((button) => {
    button.onclick = () => {
      const row = button.closest<HTMLElement>("[data-pkg-row]");
      if (!row) return;
      const item = readPackagingRow(row);
      const copy = { ...item, id: emptyPackagingItem().id };
      host.insertAdjacentHTML("beforeend", packagingItemRow(copy, qsa("[data-pkg-row]", host).length, qsa("[data-pkg-row]", host).length + 1));
      refreshPackagingEditor();
      // 复制出来后滚动到新行，否则长方案里看不出发生了什么
      host.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
  });
  qsa<HTMLInputElement>("[data-pkg]", host).forEach((input) => {
    input.oninput = () => {
      const row = input.closest("[data-pkg-row]");
      if (!row) return;
      const volume = qs<HTMLElement>("[data-pkg-volume]", row);
      if (volume && ["lengthCm", "widthCm", "heightCm"].includes(input.dataset.pkg || "")) {
        const read = (name: string) => Number(qs<HTMLInputElement>(`[data-pkg="${name}"]`, row)?.value || 0) || 0;
        volume.textContent = `${packagingItemVolumeCbm({
          lengthCm: read("lengthCm"), widthCm: read("widthCm"), heightCm: read("heightCm")
        }).toFixed(3)} m³`;
      }
      // 底部汇总跟着输入实时变（不复用 document 级监听，避免每开一次弹窗叠一个）
      updatePackagingEditorStats();
    };
  });
}

function readPackagingRow(row: HTMLElement): PackagingPlanItem {
  const value = (name: string) => qs<HTMLInputElement>(`[data-pkg="${name}"]`, row)?.value.trim() || "";
  const num = (name: string) => Number(qs<HTMLInputElement>(`[data-pkg="${name}"]`, row)?.value || 0) || 0;
  return {
    id: row.dataset.pkgId || emptyPackagingItem().id,
    label: value("label"),
    contents: qs<HTMLTextAreaElement>('[data-pkg="contents"]', row)?.value.trim() || "",
    model: value("model"),
    lengthCm: num("lengthCm"),
    widthCm: num("widthCm"),
    heightCm: num("heightCm"),
    netWeightKg: num("netWeightKg"),
    grossWeightKg: num("grossWeightKg")
  };
}

/** 收集编辑器里的包装件；全空行不写进库（编辑器永远留一行空壳） */
export function collectPackagingPlanItems(): PackagingPlanItem[] {
  return qsa<HTMLElement>("#packagingPlanItemsEditor [data-pkg-row]")
    .map(readPackagingRow)
    .filter((item) => Boolean(item.label || item.contents || item.model)
      || item.lengthCm > 0 || item.widthCm > 0 || item.heightCm > 0
      || item.netWeightKg > 0 || item.grossWeightKg > 0);
}

// ---------------------------------------------------------------------------
// 新增 / 编辑弹窗
// ---------------------------------------------------------------------------

function productOptions(selectedId: string) {
  const products = (state.products || []) as Product[];
  return `<option value="">选择物料（可留空）</option>` + products.map((product) => {
    const name = product.nameZh || product.nameEn || product.model || "未命名物料";
    return `<option value="${escapeHtml(product.id)}" data-product-name="${escapeHtml(name)}" data-product-model="${escapeHtml(product.model || "")}" ${product.id === selectedId ? "selected" : ""}>${escapeHtml(name)}${product.model ? ` · ${escapeHtml(product.model)}` : ""}</option>`;
  }).join("");
}

export function openPackagingPlanModal(plan?: PackagingPlan) {
  const editing = Boolean(plan);
  const items = plan?.items?.length ? plan.items : [emptyPackagingItem()];
  openModal(editing ? "编辑包装方案" : "新增包装方案", `
    <div class="pkg-editor">
      <div class="form-grid pkg-editor-head">
        <div class="form-field"><label>方案编码</label><input id="packagingPlanCodeInput" maxlength="40" value="${escapeHtml(plan?.code || "")}" placeholder="留空自动生成，例如 PKG-0001"><small class="form-hint">团队内唯一，留空保存时按顺序生成</small></div>
        <div class="form-field"><label>方案名称 *</label><input id="packagingPlanNameInput" maxlength="200" value="${escapeHtml(plan?.name || "")}" placeholder="例如 JW-T7 PRO 标准出口包装"></div>
        <div class="form-field"><label>方案类型</label><select id="packagingPlanScopeInput"><option value="general" ${(plan?.scope || "general") === "general" ? "selected" : ""}>通用方案（不绑物料）</option><option value="product" ${plan?.scope === "product" ? "selected" : ""}>物料方案（关联产品）</option></select></div>
        <div class="form-field"><label>关联物料</label><select id="packagingPlanProductInput" ${(plan?.scope || "general") === "product" ? "" : "disabled"}>${productOptions(plan?.productId || "")}</select><small class="form-hint" id="packagingPlanProductHint">通用方案会出现在所有单据的选择列表里</small></div>
        <div class="form-field full"><label>一句话说明</label><input id="packagingPlanSummaryInput" maxlength="300" value="${escapeHtml(plan?.summary || "")}" placeholder="例如 5 件木箱，整柜出运，适合整机"></div>
        <div class="form-field full"><label>备注</label><textarea id="packagingPlanRemarkInput" rows="2" maxlength="2000" placeholder="打包要求、加固方式、注意事项等">${escapeHtml(plan?.remark || "")}</textarea></div>
      </div>

      <div class="pkg-items-head">
        <div><b>包装件</b><span id="packagingPlanItemCount">${items.length} 件</span><small>每行一件；外尺寸填 cm，单箱体积按长×宽×高自动算</small></div>
        <div class="inline-actions"><button class="btn" id="packagingPlanAddItemButton" type="button">＋ 新增包装件</button></div>
      </div>
      <div class="pkg-items-head-row">
        <span>序号</span><span>包装类型 / 归属设备</span><span>箱内物品</span><span>外尺寸 cm</span><span>净重 / 毛重 kg</span><span>单箱体积</span><span></span>
      </div>
      <div class="pkg-items" id="packagingPlanItemsEditor">
        ${items.map((item, index) => packagingItemRow(item, index, items.length)).join("")}
      </div>
      <div class="pkg-editor-foot" id="packagingPlanEditorStats"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="savePackagingPlanButton" data-editing-id="${escapeHtml(plan?.id || "")}">${editing ? "保存修改" : "保存方案"}</button>`, { closeOnBackdrop: false, modalClass: "packaging-plan-modal" });

  // 方案类型切换：选物料才启用物料下拉（禁用态比隐藏更直观，用户能看到这项存在）
  const scopeSelect = qs<HTMLSelectElement>("#packagingPlanScopeInput");
  const productSelect = qs<HTMLSelectElement>("#packagingPlanProductInput");
  const productHint = qs<HTMLElement>("#packagingPlanProductHint");
  scopeSelect?.addEventListener("change", () => {
    const isProduct = scopeSelect.value === "product";
    if (productSelect) {
      productSelect.disabled = !isProduct;
      if (!isProduct) productSelect.value = "";
    }
    if (productHint) productHint.textContent = isProduct ? "方案会带上物料的名称与型号，选择列表里可看到" : "通用方案会出现在所有单据的选择列表里";
  });

  qs<HTMLButtonElement>("#packagingPlanAddItemButton")?.addEventListener("click", () => {
    const host = qs<HTMLElement>("#packagingPlanItemsEditor");
    if (!host) return;
    const total = qsa("[data-pkg-row]", host).length;
    host.insertAdjacentHTML("beforeend", packagingItemRow(emptyPackagingItem(), total, total + 1));
    refreshPackagingEditor();
    const last = host.lastElementChild;
    last?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    qs<HTMLInputElement>('[data-pkg="label"]', last as HTMLElement)?.focus();
  });

  qs<HTMLButtonElement>("#savePackagingPlanButton")?.addEventListener("click", () => void savePackagingPlan());

  refreshPackagingEditor();
  updatePackagingEditorStats();
  qs<HTMLInputElement>("#packagingPlanNameInput")?.focus();
}

function updatePackagingEditorStats() {
  const host = qs<HTMLElement>("#packagingPlanEditorStats");
  if (!host) return;
  const items = collectPackagingPlanItems();
  const stats = packagingPlanSummary({ items });
  if (!stats.packages) {
    host.innerHTML = `<span>还没有包装件：点上方「新增包装件」开始，第一行也可以直接填。</span>`;
    return;
  }
  host.innerHTML = `<span><b>${stats.packages}</b> 件</span><span>净重 <b>${stats.netWeightKg}</b> kg</span><span>毛重 <b>${stats.grossWeightKg}</b> kg</span><span>总体积 <b>${stats.volumeCbm}</b> m³</span>`;
}

async function savePackagingPlan() {
  const name = qs<HTMLInputElement>("#packagingPlanNameInput")?.value.trim() || "";
  if (!name) {
    toast("请填写方案名称", "error");
    qs<HTMLInputElement>("#packagingPlanNameInput")?.focus();
    return;
  }
  const saveButton = qs<HTMLButtonElement>("#savePackagingPlanButton");
  const editingId = saveButton?.dataset.editingId || "";
  const scope = (qs<HTMLSelectElement>("#packagingPlanScopeInput")?.value || "general") as PackagingPlanScope;
  const productSelect = qs<HTMLSelectElement>("#packagingPlanProductInput");
  const selectedOption = productSelect?.selectedOptions?.[0];
  const payload = {
    code: qs<HTMLInputElement>("#packagingPlanCodeInput")?.value.trim() || "",
    name,
    scope,
    productId: scope === "product" ? productSelect?.value || "" : "",
    productName: scope === "product" ? selectedOption?.dataset.productName || "" : "",
    productModel: scope === "product" ? selectedOption?.dataset.productModel || "" : "",
    summary: qs<HTMLInputElement>("#packagingPlanSummaryInput")?.value.trim() || "",
    remark: qs<HTMLTextAreaElement>("#packagingPlanRemarkInput")?.value.trim() || "",
    items: collectPackagingPlanItems()
  };
  if (scope === "product" && !payload.productId) {
    toast("选择了物料方案，但还没有选具体物料", "error");
    productSelect?.focus();
    return;
  }
  if (saveButton) setButtonPending(saveButton, true, editingId ? "保存修改" : "保存方案", "保存中…");
  try {
    if (editingId) {
      const result = await api<{ plan: PackagingPlan }>(`/api/packaging-plans/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
      state.packagingPlans = state.packagingPlans.map((item) => item.id === result.plan.id ? result.plan : item);
      toast("包装方案已保存");
    } else {
      const result = await api<{ plan: PackagingPlan }>("/api/packaging-plans", { method: "POST", body: JSON.stringify(payload) });
      state.packagingPlans = [result.plan, ...state.packagingPlans];
      state.packagingPlanPage = 1;
      toast("包装方案已新增");
    }
    closeModal();
    renderPackagingPlans();
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
    if (saveButton) setButtonPending(saveButton, false, editingId ? "保存修改" : "保存方案", editingId ? "保存修改" : "保存方案");
  }
}

async function deletePackagingPlans(ids: string[]) {
  const targets = state.packagingPlans.filter((plan) => ids.includes(plan.id));
  if (!targets.length) return;
  const ok = await confirmAction({
    title: targets.length > 1 ? `删除 ${targets.length} 个包装方案` : "删除包装方案",
    message: targets.length > 1 ? "以下包装方案会被永久删除。" : `确定删除方案「${packagingPlanName(targets[0])}」吗？`,
    detail: targets.slice(0, 6).map((plan) => packagingPlanName(plan)).join("、"),
    consequences: ["方案的包装件明细会一并删除", "已引用该方案的单据保留自己的包装件快照", "删除后不可恢复"],
    confirmLabel: "删除",
    tone: "danger"
  });
  if (!ok) return;
  try {
    const result = await api<{ deleted: string[]; plans: PackagingPlan[] }>("/api/packaging-plans/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
    state.packagingPlans = result.plans;
    const deleted = new Set(result.deleted);
    state.selectedPackagingPlanIds = state.selectedPackagingPlanIds.filter((id) => !deleted.has(id));
    toast(`已删除 ${result.deleted.length} 个包装方案`);
    renderPackagingPlans();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败", "error");
  }
}

// ---------------------------------------------------------------------------
// 供单据 / 商机复用：选择器 + 悬浮明细
// ---------------------------------------------------------------------------

/**
 * 选择包装方案（弹窗）。单据平台与商机共用。
 * onSelect(null) = 明确选择「不使用方案」，与「点关闭」区分开。
 */
export function openPackagingPlanPicker(options: {
  selectedId?: string;
  title?: string;
  onSelect: (plan: PackagingPlan | null) => void;
}) {
  const render = () => {
    const plans = sortedPackagingPlans(state.packagingPlans);
    const host = qs<HTMLElement>("#packagingPickerList");
    if (!host) return;
    host.innerHTML = plans.length ? plans.map((plan) => {
      const stats = packagingPlanSummary(plan);
      return `<button type="button" class="pkg-pick${plan.id === options.selectedId ? " is-active" : ""}" data-pkg-pick="${escapeHtml(plan.id)}">
        <span class="pkg-pick-main"><b>${escapeHtml(packagingPlanName(plan))}</b><small>${plan.code ? `${escapeHtml(plan.code)} · ` : ""}${escapeHtml(plan.scope === "product" ? (plan.productName || "物料方案") : "通用方案")}${plan.summary ? ` · ${escapeHtml(plan.summary)}` : ""}</small></span>
        <span class="pkg-pick-side"><em>${stats.packages} 件</em>${stats.grossWeightKg > 0 ? `<i>毛重 ${stats.grossWeightKg} kg</i>` : ""}${stats.volumeCbm > 0 ? `<i>${stats.volumeCbm} m³</i>` : ""}</span>
      </button>`;
    }).join("") : `<div class="empty-cell">还没有包装方案。先去「业务工具 → 包装方案」建一套。</div>`;
    qsa<HTMLButtonElement>("[data-pkg-pick]", host).forEach((button) => button.addEventListener("click", () => {
      const plan = packagingPlanById(button.dataset.pkgPick);
      if (!plan) return;
      closeModal();
      options.onSelect(plan);
    }));
  };

  void ensurePackagingPlansLoaded().then(render);
  openModal(options.title || "选择包装方案", `
    <div class="pkg-picker">
      <div class="pkg-picker-tip">选中的方案会把包装件明细带进当前单据；带进来之后仍可逐件修改。</div>
      <div class="pkg-picker-list" id="packagingPickerList"><div class="empty-cell">加载中…</div></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn" id="packagingPickerClear">不使用包装方案</button>`, { closeOnBackdrop: true, modalClass: "packaging-picker-modal" });
  qs<HTMLButtonElement>("#packagingPickerClear")?.addEventListener("click", () => {
    closeModal();
    options.onSelect(null);
  });
}

/** 悬浮/内嵌明细：按参考件的包装件表口径渲染（只读） */
export function packagingPlanItemsTable(plan: PackagingPlan, options: { compact?: boolean } = {}) {
  const items = plan.items || [];
  if (!items.length) return `<div class="pkg-hover-empty">这个方案还没有包装件</div>`;
  // 外层包一层横向滚动：商机抽屉只有 ~480px，六列表格直接放会被裁掉后三列
  return `<div class="pkg-table-scroll"><table class="pkg-hover-table${options.compact ? " is-compact" : ""}">
    <thead><tr><th>#</th><th>包装类型 / 归属设备</th><th>箱内物品</th><th>外尺寸 cm</th><th>净重 / 毛重 kg</th><th>体积</th></tr></thead>
    <tbody>${items.map((item, index) => `<tr>
      <td>${index + 1}</td>
      <td><b>${escapeHtml(item.label || "—")}</b>${item.model ? `<small>${escapeHtml(item.model)}</small>` : ""}</td>
      <td>${escapeHtml(item.contents || "—")}</td>
      <td>${item.lengthCm && item.widthCm && item.heightCm ? `${item.lengthCm}×${item.widthCm}×${item.heightCm}` : "—"}</td>
      <td>${item.netWeightKg || 0} / ${item.grossWeightKg || 0}</td>
      <td>${packagingItemVolumeCbm(item).toFixed(3)} m³</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

/**
 * 商机卡片上的方案标签 + 悬浮层。
 * 纯 CSS 悬停（.pkg-hover 内 .pkg-hover-card 用 opacity/visibility 切换），
 * 不引入 JS tooltip：卡片本身可点击进详情，任何 JS 层都可能挡住点击。
 */
export function packagingPlanHoverBadge(planId?: string) {
  const plan = packagingPlanById(planId);
  if (!plan) return "";
  const stats = packagingPlanSummary(plan);
  return `<span class="pkg-hover">
    <span class="pkg-hover-tag" tabindex="0">包装 · ${stats.packages} 件<span class="pkg-hover-more">明细</span></span>
    <span class="pkg-hover-card" role="tooltip">
      <span class="pkg-hover-head"><b>${escapeHtml(plan.name)}</b><small>${plan.code ? `${escapeHtml(plan.code)} · ` : ""}${stats.packages} 件 · 毛重 ${stats.grossWeightKg} kg · ${stats.volumeCbm} m³</small></span>
      ${packagingPlanItemsTable(plan, { compact: true })}
    </span>
  </span>`;
}
