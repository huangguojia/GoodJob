/**
 * 产品维护。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { confirmAction, openModal, productViewMode, state } from "../prototype-api";
import { type Product } from "./models";
import { escapeHtml, qs, qsa } from "./shared";
import { api, setButtonPending, toast } from "./ui";
import { uploadDocumentImage } from "./trade-documents";
import { recordLog } from "./logs";

// ===== 产品维护 =====
export let editingProductId: string | null = null;

function formatNumber(value: number): string {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatProductDate(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 可选数字回填：undefined / null 一律渲染成空串，别把 "undefined" 塞进输入框。 */
function numText(value?: number | null): string {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "" : String(value);
}

/** 「1.2×0.8×0.9 m³」这类体积只在三个外箱尺寸都齐时才算，缺一个就不猜。 */
function cartonVolumeM3(p: { packLength?: number; packWidth?: number; packHeight?: number }): number | null {
  const { packLength: l, packWidth: w, packHeight: h } = p;
  if (!l || !w || !h) return null;
  return (l * w * h) / 1_000_000;
}

/** 产品卡片上的规格摘要：型号 / 产品尺寸 / 颜色，只挑有值的显示。 */
function specSummaryHtml(p: Product): string {
  return [p.model, p.sizeSpec, p.color]
    .filter((v): v is string => Boolean(v))
    .map((v) => `<span class="pc-meta-item">${escapeHtml(v)}</span>`)
    .join("");
}

/**
 * 卡片上的包装摘要。塞进 meta 行会把型号和分类徽章挤掉，所以单独压成一行 10.5px 小字，
 * 放不下就省略号（`title` 里留全文），绝不换行 —— 否则三列布局下每张卡高度都会飘。
 */
function packLineHtml(p: Product): string {
  const bits: string[] = [];
  if (p.packWeight != null) bits.push(`G.W. ${numText(p.packWeight)}kg`);
  if (p.netWeight != null) bits.push(`N.W. ${numText(p.netWeight)}kg`);
  if (p.packLength && p.packWidth && p.packHeight) {
    bits.push(`${numText(p.packLength)}×${numText(p.packWidth)}×${numText(p.packHeight)}cm`);
  }
  if (p.unitsPerCarton != null) bits.push(`${numText(p.unitsPerCarton)}/ctn`);
  if (!bits.length) return "";
  const text = bits.join(" · ");
  return `<p class="pc-spec-line" title="${escapeHtml(text)}">${escapeHtml(text)}</p>`;
}

/**
 * 产品图占位。没有图时不再是一块写着「图」的小方块 —— 换成与卡片同高的
 * 品牌浅底 + 相框图标 + 「暂无图片」，看上去是「留白等图」而不是「坏了」。
 */
function thumbPlaceholderHtml(hidden = false): string {
  return `<div class="product-thumb-placeholder"${hidden ? ` style="display:none"` : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5"/></svg><span>暂无图片</span></div>`;
}

function productThumbHtml(imageUrl: string): string {
  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    return `<img class="product-thumb" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">${thumbPlaceholderHtml(true)}`;
  }
  return thumbPlaceholderHtml();
}

/** 有真图才给图片位描实边，没图时描虚线 —— 图位边框样式跟着数据走，不靠 :has。 */
function productHasImage(imageUrl: string): boolean {
  return /^https?:\/\//i.test(imageUrl || "");
}

export let currentProductVisibleIds: string[] = [];

let productCategoryFilterValue = "";

function productCategoryOptions() {
  const categories = new Map<string, string>();
  [...state.productCategories, ...state.products.map((product) => product.category)].forEach((value) => {
    const name = String(value || "").trim().replace(/\s+/g, " ");
    if (name) categories.set(name.toLocaleLowerCase(), name);
  });
  return [...categories.values()].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function renderProducts() {
  const all = state.products.slice();
  state.selectedProductIds = state.selectedProductIds.filter((id) => all.some((p) => p.id === id));
  const search = (qs<HTMLInputElement>("#productSearch")?.value || "").trim().toLowerCase();
  const curFilter = qs<HTMLSelectElement>("#productCurrencyFilter")?.value || "";

  const filtered = all.filter((p) => {
    if (productCategoryFilterValue && p.category !== productCategoryFilterValue) return false;
    if (curFilter && p.currency !== curFilter) return false;
    if (search) {
      const hay = `${p.nameZh} ${p.nameEn} ${p.model} ${p.hsCode} ${p.category} ${(p.tags || []).join(" ")}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const categories = productCategoryOptions();
  const rail = qs<HTMLElement>("#productCategoryRail");
  if (rail) {
    rail.innerHTML = `<button class="pc-cat ${productCategoryFilterValue === "" ? "is-active" : ""}" data-cat="">全部 <i>${all.length}</i></button>` +
      categories.map((c) => {
        const n = all.filter((p) => p.category === c).length;
        return `<button class="pc-cat ${productCategoryFilterValue === c ? "is-active" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)} <i>${n}</i></button>`;
      }).join("");
    rail.querySelectorAll<HTMLButtonElement>(".pc-cat").forEach((b) => {
      b.addEventListener("click", () => { productCategoryFilterValue = b.dataset.cat || ""; renderProducts(); });
    });
  }

  const currencies = Array.from(new Set(all.map((p) => p.currency).filter(Boolean))).sort();
  const curSelect = qs<HTMLSelectElement>("#productCurrencyFilter");
  if (curSelect) {
    const cur = curSelect.value;
    curSelect.innerHTML = `<option value="">全部币种</option>` + currencies.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    if (currencies.includes(cur)) curSelect.value = cur;
  }

  const catList = qs<HTMLElement>("#productCategoryList");
  if (catList) catList.innerHTML = categories.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");

  const countEl = qs<HTMLElement>("#productCount"); if (countEl) countEl.textContent = String(all.length);
  const catCountEl = qs<HTMLElement>("#productCategoryCount"); if (catCountEl) catCountEl.textContent = String(categories.length);
  const spreadEl = qs<HTMLElement>("#productCurrencySpread");
  if (spreadEl) spreadEl.textContent = currencies.length ? currencies.slice(0, 3).join(" / ") + (currencies.length > 3 ? " …" : "") : "—";
  const valueEl = qs<HTMLElement>("#productValueSum");
  if (valueEl) {
    // 以出现次数最多的币种为主币种，统计其货值合计（避免多币种时只统计到字典序首位的币种）
    const freq: Record<string, number> = {};
    for (const p of all) if (p.currency) freq[p.currency] = (freq[p.currency] || 0) + 1;
    const primary = currencies.slice().sort((a, b) => (freq[b] || 0) - (freq[a] || 0))[0] || "";
    const sum = all.filter((p) => p.currency === primary).reduce((a, p) => a + (Number(p.price) || 0), 0);
    valueEl.textContent = primary ? `${formatNumber(sum)} ${primary}` : "—";
  }

  const grid = qs<HTMLElement>("#productGrid");
  if (grid) {
    if (filtered.length) {
      grid.className = `pc-grid ${productViewMode === "list" ? "is-list" : ""}`;
      grid.innerHTML = filtered.map((p) => productCardHtml(p)).join("");
    } else if (all.length) {
      grid.className = "pc-grid";
      grid.innerHTML = `<div class="pc-noresult">未找到匹配的产品</div>`;
    } else {
      grid.innerHTML = "";
    }
  }

  const visibleIds = filtered.map((p) => p.id);
  currentProductVisibleIds = visibleIds;
  const selVisible = visibleIds.filter((id) => state.selectedProductIds.includes(id)).length;
  const selectAll = qs<HTMLInputElement>("#productSelectAll");
  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && selVisible === visibleIds.length;
    selectAll.indeterminate = selVisible > 0 && selVisible < visibleIds.length;
  }
  updateProductSelectionUI();

  if (grid) {
    qsa<HTMLInputElement>("[data-select-product]", grid).forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const id = checkbox.closest<HTMLElement>("[data-product-id]")?.dataset.productId || "";
        if (!id) return;
        state.selectedProductIds = checkbox.checked
          ? Array.from(new Set([...state.selectedProductIds, id]))
          : state.selectedProductIds.filter((selectedId) => selectedId !== id);
        updateProductSelectionUI();
        const vis = visibleIds.filter((vid) => state.selectedProductIds.includes(vid)).length;
        if (selectAll) {
          selectAll.checked = visibleIds.length > 0 && vis === visibleIds.length;
          selectAll.indeterminate = vis > 0 && vis < visibleIds.length;
        }
      });
    });
  }

  const empty = qs<HTMLElement>("#productEmpty");
  if (empty) empty.hidden = all.length > 0;
}

export function openProductCategoryManager() {
  const categories = productCategoryOptions();
  const rows = categories.map((category) => {
    const count = state.products.filter((product) => product.category.toLocaleLowerCase() === category.toLocaleLowerCase()).length;
    return `<div class="product-category-row">
      <input value="${escapeHtml(category)}" maxlength="80" data-product-category-input="${escapeHtml(category)}" aria-label="分类名称 ${escapeHtml(category)}">
      <small>${count} 个产品</small>
      <button class="btn btn-sm" type="button" data-product-category-save="${escapeHtml(category)}">保存</button>
      <button class="btn btn-sm danger" type="button" data-product-category-delete="${escapeHtml(category)}">删除</button>
    </div>`;
  }).join("");
  openModal("产品分类管理", `
    <div class="product-category-manager">
      <div class="product-category-create">
        <input id="productCategoryNewName" maxlength="80" placeholder="输入新分类名称" autocomplete="off">
        <button class="btn primary" id="productCategoryCreateButton" type="button">新增分类</button>
      </div>
      <div class="product-category-list">${rows || `<div class="product-category-empty">暂无分类，可在上方创建第一个分类</div>`}</div>
      <p class="product-category-note">重命名会同步更新该分类下的产品；删除分类只会清空产品的分类归属，不会删除产品。</p>
    </div>
  `, `<button class="btn primary" data-modal-close type="button">完成</button>`);
  qs<HTMLButtonElement>("#productCategoryCreateButton")?.addEventListener("click", (event) => void createProductCategory(event.currentTarget as HTMLButtonElement));
  qs<HTMLInputElement>("#productCategoryNewName")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void createProductCategory(qs<HTMLButtonElement>("#productCategoryCreateButton")!);
  });
  qsa<HTMLButtonElement>("[data-product-category-save]").forEach((button) => {
    button.addEventListener("click", () => void renameProductCategory(button));
  });
  qsa<HTMLButtonElement>("[data-product-category-delete]").forEach((button) => {
    button.addEventListener("click", () => void deleteProductCategory(button.dataset.productCategoryDelete || ""));
  });
}

async function createProductCategory(button: HTMLButtonElement) {
  const name = qs<HTMLInputElement>("#productCategoryNewName")?.value.trim() || "";
  if (!name) { toast("请输入分类名称", "error"); return; }
  setButtonPending(button, true, "新增分类", "新增中");
  try {
    const result = await api<{ categories: string[] }>("/api/tools/product-categories", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    state.productCategories = result.categories;
    renderProducts();
    openProductCategoryManager();
    toast(`已新增分类「${name}」`, "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "新增分类失败", "error");
    setButtonPending(button, false, "新增分类", "新增中");
  }
}

async function renameProductCategory(button: HTMLButtonElement) {
  const currentName = button.dataset.productCategorySave || "";
  const input = qsa<HTMLInputElement>("[data-product-category-input]")
    .find((item) => item.dataset.productCategoryInput === currentName);
  const name = input?.value.trim() || "";
  if (!name) { toast("分类名称不能为空", "error"); return; }
  if (name === currentName) { toast("分类名称没有变化"); return; }
  setButtonPending(button, true, "保存", "保存中");
  try {
    const result = await api<{ categories: string[]; products: Product[] }>("/api/tools/product-categories", {
      method: "PATCH",
      body: JSON.stringify({ currentName, name })
    });
    state.productCategories = result.categories;
    state.products = result.products;
    if (productCategoryFilterValue === currentName) productCategoryFilterValue = name;
    renderProducts();
    openProductCategoryManager();
    toast(`分类已重命名为「${name}」`, "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "重命名分类失败", "error");
    setButtonPending(button, false, "保存", "保存中");
  }
}

async function deleteProductCategory(name: string) {
  const count = state.products.filter((product) => product.category.toLocaleLowerCase() === name.toLocaleLowerCase()).length;
  const confirmed = await confirmAction({
    title: "删除产品分类",
    message: `确定删除分类「${name}」吗？`,
    consequences: [count ? `${count} 个产品将变为未分类` : "该分类将从分类列表移除", "产品资料不会被删除"],
    confirmLabel: "删除分类",
    tone: "warning"
  });
  if (!confirmed) { openProductCategoryManager(); return; }
  try {
    const result = await api<{ categories: string[]; products: Product[] }>(`/api/tools/product-categories/${encodeURIComponent(name)}`, { method: "DELETE" });
    state.productCategories = result.categories;
    state.products = result.products;
    if (productCategoryFilterValue.toLocaleLowerCase() === name.toLocaleLowerCase()) productCategoryFilterValue = "";
    renderProducts();
    openProductCategoryManager();
    toast(`已删除分类「${name}」`, "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除分类失败", "error");
    openProductCategoryManager();
  }
}

function productCardHtml(p: Product): string {
  const selected = state.selectedProductIds.includes(p.id);
  const tags = (p.tags || []).slice(0, 4).map((t) => `<span class="pc-tag">${escapeHtml(t)}</span>`).join("");
  return `
  <article class="pc-card" data-product-id="${escapeHtml(p.id)}">
    <label class="pc-check"><input type="checkbox" data-select-product ${selected ? "checked" : ""} aria-label="选择 ${escapeHtml(p.nameZh)}"><span></span></label>
    <div class="pc-thumb${productHasImage(p.imageUrl) ? "" : " is-empty"}">${productThumbHtml(p.imageUrl)}</div>
    <div class="pc-card-body">
      <h3 class="pc-name">${escapeHtml(p.nameZh)}</h3>
      ${p.nameEn ? `<p class="pc-name-en">${escapeHtml(p.nameEn)}</p>` : ""}
      <div class="pc-meta">
        ${specSummaryHtml(p)}
        ${p.category ? `<span class="pc-badge">${escapeHtml(p.category)}</span>` : ""}
        ${p.hsCode ? `<span class="pc-hs">HS ${escapeHtml(p.hsCode)}</span>` : ""}
      </div>
      ${packLineHtml(p)}
      ${tags ? `<div class="pc-tags">${tags}</div>` : ""}
    </div>
    <div class="pc-card-foot">
      <span class="pc-price">${formatNumber(p.price)}<small>${escapeHtml(p.currency)}</small></span>
      <time class="pc-time">${formatProductDate(p.updatedAt)}</time>
      <div class="pc-card-actions">
        <button class="pc-iconbtn" data-product-edit="${escapeHtml(p.id)}" type="button">编辑</button>
        <button class="pc-iconbtn ghost" data-product-duplicate="${escapeHtml(p.id)}" type="button">复制</button>
      </div>
    </div>
  </article>`;
}

export function openProductDrawer(p: Product) {
  const drawer = qs<HTMLElement>("#productDrawer");
  const inner = qs<HTMLElement>("#productDrawerInner");
  const scrim = qs<HTMLElement>("#productScrim");
  if (!drawer || !inner) return;
  const tags = (p.tags || []).map((t) => `<span class="pc-tag">${escapeHtml(t)}</span>`).join("") || `<span class="pc-dim">无</span>`;
  const vol = cartonVolumeM3(p);
  const cartonDim = p.packLength && p.packWidth && p.packHeight ? `${numText(p.packLength)}×${numText(p.packWidth)}×${numText(p.packHeight)} cm` : "";
  const nwGw = [p.netWeight != null ? `N.W. ${numText(p.netWeight)} kg` : "", p.packWeight != null ? `G.W. ${numText(p.packWeight)} kg` : ""].filter(Boolean).join(" · ");
  const ctn = [p.unitsPerCarton != null ? `${numText(p.unitsPerCarton)} pcs/ctn` : "", vol != null ? `${vol.toFixed(3)} m³/ctn` : ""].filter(Boolean).join(" · ");
  const hasSpec = Boolean(p.sku || p.material || p.color || p.sizeSpec || nwGw || cartonDim || ctn);
  const specRows = [
    p.sku ? `<div><dt>SKU / 货号</dt><dd class="pc-mono">${escapeHtml(p.sku)}</dd></div>` : "",
    p.material ? `<div><dt>材质</dt><dd>${escapeHtml(p.material)}</dd></div>` : "",
    p.color ? `<div><dt>颜色</dt><dd>${escapeHtml(p.color)}</dd></div>` : "",
    p.sizeSpec ? `<div><dt>产品尺寸</dt><dd>${escapeHtml(p.sizeSpec)}</dd></div>` : "",
    nwGw ? `<div><dt>净重 / 毛重</dt><dd class="pc-mono">${nwGw}</dd></div>` : "",
    cartonDim ? `<div><dt>外箱尺寸</dt><dd class="pc-mono">${cartonDim}</dd></div>` : "",
    ctn ? `<div><dt>装箱 / 体积</dt><dd class="pc-mono">${ctn}</dd></div>` : ""
  ].filter(Boolean).join("");
  inner.innerHTML = `
    <header class="pc-drawer-head">
      <div>
        <p class="pc-drawer-eyebrow">产品详情</p>
        <h2>${escapeHtml(p.nameZh)}</h2>
        ${p.nameEn ? `<p class="pc-drawer-en">${escapeHtml(p.nameEn)}</p>` : ""}
      </div>
      <button class="pc-drawer-close" id="productDrawerClose" type="button" aria-label="关闭">&times;</button>
    </header>
    <div class="pc-drawer-body">
      <div class="pc-drawer-thumb${productHasImage(p.imageUrl) ? "" : " is-empty"}">${productThumbHtml(p.imageUrl)}</div>
      <dl class="pc-def">
        <div><dt>型号 / 规格</dt><dd>${escapeHtml(p.model) || "—"}</dd></div>
        <div><dt>分类</dt><dd>${escapeHtml(p.category) || "—"}</dd></div>
        <div><dt>单位</dt><dd>${escapeHtml(p.unit) || "—"}</dd></div>
        <div><dt>单价</dt><dd class="pc-mono">${formatNumber(p.price)} ${escapeHtml(p.currency)}</dd></div>
        <div><dt>HS 编码</dt><dd class="pc-mono">${escapeHtml(p.hsCode) || "—"}</dd></div>
        <div><dt>更新时间</dt><dd>${formatProductDate(p.updatedAt)}</dd></div>
      </dl>
      ${hasSpec ? `<div class="pc-drawer-sec"><h4>规格与包装</h4><dl class="pc-def">${specRows}</dl></div>` : ""}
      <div class="pc-drawer-sec"><h4>标签</h4><div class="pc-tags">${tags}</div></div>
      ${p.descriptionZh ? `<div class="pc-drawer-sec"><h4>中文描述</h4><p class="pc-desc">${escapeHtml(p.descriptionZh)}</p></div>` : ""}
      ${p.descriptionEn ? `<div class="pc-drawer-sec"><h4>英文描述</h4><p class="pc-desc">${escapeHtml(p.descriptionEn)}</p></div>` : ""}
    </div>
    <footer class="pc-drawer-foot">
      <button class="btn btn-ghost danger" id="productDrawerDelete" type="button">删除</button>
      <span class="pc-foot-spacer"></span>
      <button class="btn btn-primary" id="productDrawerEdit" type="button">编辑产品</button>
    </footer>`;
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  if (scrim) scrim.hidden = false;
  qs<HTMLElement>("#productDrawerClose")?.addEventListener("click", closeProductDrawer);
  qs<HTMLElement>("#productDrawerEdit")?.addEventListener("click", () => { closeProductDrawer(); openProductModal(p); });
  qs<HTMLElement>("#productDrawerDelete")?.addEventListener("click", () => { closeProductDrawer(); if (p.id) void deleteProduct(p.id); });
  scrim?.addEventListener("click", closeProductDrawer, { once: true });
}

function closeProductDrawer() {
  const drawer = qs<HTMLElement>("#productDrawer");
  const scrim = qs<HTMLElement>("#productScrim");
  if (drawer) { drawer.classList.remove("is-open"); drawer.setAttribute("aria-hidden", "true"); }
  if (scrim) scrim.hidden = true;
}

function updateProductSelectionUI() {
  const count = state.selectedProductIds.length;
  const countEl = qs<HTMLElement>("#productSelCount");
  if (countEl) {
    countEl.textContent = `已选 ${count} 项`;
    countEl.hidden = count === 0;
  }
  const del = qs<HTMLButtonElement>("#productBulkDelete");
  if (del) del.disabled = count === 0;
}

export function openProductModal(product?: Product) {
  editingProductId = product?.id || null;
  const modal = qs<HTMLElement>("#productModal");
  const title = qs<HTMLElement>("#productModalTitle");
  if (title) title.textContent = product ? "编辑产品" : "新增产品";
  const set = (sel: string, val: string) => { const el = qs<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(sel); if (el) el.value = val || ""; };
  set("#productNameZh", product?.nameZh || "");
  set("#productNameEn", product?.nameEn || "");
  set("#productModel", product?.model || "");
  set("#productCategory", product?.category || "");
  set("#productUnit", product?.unit || "pcs");
  set("#productPrice", product ? String(product.price) : "");
  set("#productCurrency", product?.currency || "USD");
  set("#productHsCode", product?.hsCode || "");
  set("#productTags", (product?.tags || []).join(", "));
  set("#productSku", product?.sku || "");
  set("#productMaterial", product?.material || "");
  set("#productColor", product?.color || "");
  set("#productSizeSpec", product?.sizeSpec || "");
  set("#productNetWeight", numText(product?.netWeight));
  set("#productPackWeight", numText(product?.packWeight));
  set("#productPackLength", numText(product?.packLength));
  set("#productPackWidth", numText(product?.packWidth));
  set("#productPackHeight", numText(product?.packHeight));
  set("#productUnitsPerCarton", numText(product?.unitsPerCarton));
  set("#productImageUrl", product?.imageUrl || "");
  set("#productDescriptionZh", product?.descriptionZh || "");
  set("#productDescriptionEn", product?.descriptionEn || "");
  const del = qs<HTMLButtonElement>("#productDeleteButton");
  if (del) del.hidden = !product;
  if (modal) modal.classList.add("active");
  qs<HTMLInputElement>("#productNameZh")?.focus();
}

export function closeProductModal() {
  const modal = qs<HTMLElement>("#productModal");
  if (modal) modal.classList.remove("active");
  editingProductId = null;
}

export async function saveProduct() {
  const nameZh = (qs<HTMLInputElement>("#productNameZh")?.value || "").trim();
  if (!nameZh) { toast("请填写中文品名", "error"); return; }
  const priceRaw = (qs<HTMLInputElement>("#productPrice")?.value || "").trim();
  const price = priceRaw === "" ? 0 : Number(priceRaw);
  if (isNaN(price) || price < 0) { toast("单价需为非负数字", "error"); return; }
  const get = (sel: string) => (qs<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(sel)?.value || "").trim();
  const tags = get("#productTags").split(",").map((t) => t.trim()).filter(Boolean);
  // 重量 / 外箱尺寸 / 装箱数：空 → null（明确「清空」），非法 → 拦下。
  // 传 null 而不是不传，后端才知道是「用户清空了」而不是「这次没改这个字段」。
  const numFields: Array<[string, string, boolean]> = [
    ["#productNetWeight", "净重", false],
    ["#productPackWeight", "毛重", false],
    ["#productPackLength", "外箱长", false],
    ["#productPackWidth", "外箱宽", false],
    ["#productPackHeight", "外箱高", false],
    ["#productUnitsPerCarton", "每箱装箱数", true]
  ];
  const nums: Record<string, number | null> = {};
  for (const [sel, label, isInteger] of numFields) {
    const raw = get(sel);
    if (raw === "") { nums[sel] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) { toast(`${label}需为不小于 0 的数字`, "error"); return; }
    nums[sel] = isInteger ? Math.round(n) : n;
  }
  let imageUrl = get("#productImageUrl");
  const imageFile = qs<HTMLInputElement>("#productImageFile")?.files?.[0];
  if (imageFile) {
    try { imageUrl = (await uploadDocumentImage(imageFile, "product")).imageUrl; }
    catch (error) { toast(error instanceof Error ? error.message : "产品图片上传失败", "error"); return; }
  }
  const payload = {
    id: editingProductId || undefined,
    nameZh,
    nameEn: get("#productNameEn"),
    model: get("#productModel"),
    category: get("#productCategory"),
    unit: get("#productUnit") || "pcs",
    price,
    currency: get("#productCurrency") || "USD",
    hsCode: get("#productHsCode"),
    descriptionZh: get("#productDescriptionZh"),
    descriptionEn: get("#productDescriptionEn"),
    tags,
    sku: get("#productSku"),
    material: get("#productMaterial"),
    color: get("#productColor"),
    sizeSpec: get("#productSizeSpec"),
    netWeight: nums["#productNetWeight"],
    packWeight: nums["#productPackWeight"],
    packLength: nums["#productPackLength"],
    packWidth: nums["#productPackWidth"],
    packHeight: nums["#productPackHeight"],
    unitsPerCarton: nums["#productUnitsPerCarton"],
    imageUrl
  };
  const btn = qs<HTMLButtonElement>("#productSaveButton");
  const wasEditing = Boolean(editingProductId);
  if (btn) { btn.disabled = true; btn.textContent = "保存中…"; }
  try {
    const result = await api<{ product: Product; products: Product[]; categories: string[] }>("/api/tools/products", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.products = result.products || [];
    state.productCategories = result.categories || state.productCategories;
    closeProductModal();
    renderProducts();
    toast(wasEditing ? "已更新产品" : "已新增产品", "ok");
    void recordLog({
      level: "success", category: "product", action: wasEditing ? "update_product" : "create_product",
      message: `${wasEditing ? "更新" : "新增"}产品「${payload.nameZh}」`,
      meta: { id: result.product?.id, nameZh: payload.nameZh, category: payload.category }
    });
  } catch (err) {
    toast(err instanceof Error ? err.message : "保存失败", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "保存"; }
  }
}

export async function deleteProduct(id: string) {
  const product = state.products.find((p) => p.id === id);
  if (!await confirmAction({
    title: "删除产品",
    message: `将删除产品「${product?.nameZh || "未命名"}」。`,
    consequences: ["产品资料将从产品库移除", "此操作无法撤销"],
    confirmLabel: "删除产品"
  })) return;
  try {
    const result = await api<{ products: Product[]; categories: string[] }>(`/api/tools/products/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.products = result.products || state.products.filter((p) => p.id !== id);
    state.productCategories = result.categories || state.productCategories;
    closeProductModal();
    renderProducts();
    toast("已删除产品", "ok");
    void recordLog({ level: "warning", category: "product", action: "delete_product", message: `删除产品「${product?.nameZh || "未命名"}」`, meta: { id } });
  } catch (err) {
    toast(err instanceof Error ? err.message : "删除失败", "error");
  }
}

export async function bulkDeleteProducts() {
  const ids = state.selectedProductIds.filter((id) => state.products.some((p) => p.id === id));
  if (!ids.length) {
    toast("请先勾选要删除的产品", "error");
    return;
  }
  const names = state.products.filter((p) => ids.includes(p.id)).map((p) => p.nameZh);
  if (!await confirmAction({
    title: `批量删除 ${ids.length} 个产品`,
    message: "产品将从产品库中永久移除。",
    detail: `${names.slice(0, 6).join("、")}${names.length > 6 ? `等 ${ids.length} 个` : ""}`,
    consequences: ["选中的产品资料会被删除", "此操作无法撤销"],
    confirmLabel: `删除 ${ids.length} 个产品`,
    verificationText: String(ids.length)
  })) return;
  const button = qs<HTMLButtonElement>("#productBulkDelete");
  try {
    setButtonPending(button, true, "删除", `正在删除 ${ids.length} 个`);
    let products = state.products;
    for (const id of ids) {
      const result = await api<{ products: Product[]; categories: string[] }>(`/api/tools/products/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (result.products) products = result.products;
      if (result.categories) state.productCategories = result.categories;
    }
    state.products = products;
    state.selectedProductIds = [];
    renderProducts();
    toast(`已删除 ${ids.length} 个产品`, "ok");
    void recordLog({ level: "warning", category: "product", action: "bulk_delete_product", message: `批量删除 ${ids.length} 个产品`, meta: { count: ids.length } });
  } catch (err) {
    toast(err instanceof Error ? err.message : "批量删除失败", "error");
  } finally {
    setButtonPending(button, false, "删除", "删除中");
    if (button) button.disabled = state.selectedProductIds.length === 0;
  }
}

export const COURIER_MAP: Record<string, { label: string; url: string }> = {
  sf: { label: "顺丰 SF", url: "https://www.sf-express.com/we/ow/waybill?waybillNo={code}" },
  yto: { label: "圆通 YTO", url: "https://www.yto.net.cn/Query.aspx?WaybillNo={code}" },
  zto: { label: "中通 ZTO", url: "https://www.zto.com/express/query?code={code}" },
  sto: { label: "申通 STO", url: "https://www.sto.cn/query?num={code}" },
  yunda: { label: "韵达 Yunda", url: "https://www.yundaex.com/query?code={code}" },
  jd: { label: "京东物流 JD", url: "https://www.jd.com/order/track?waybillCode={code}" },
  ems: { label: "EMS 邮政", url: "https://www.ems.com.cn/query?mailNum={code}" },
  dhl: { label: "DHL", url: "https://www.dhl.com/cn-zh/home/tracking/tracking-parcel.html?tracking-id={code}" },
  fedex: { label: "FedEx", url: "https://www.fedex.com/fedextrack/?trknbr={code}" },
  ups: { label: "UPS", url: "https://www.ups.com/track?tracknum={code}" },
  tt: { label: "17TRACK 通用", url: "https://www.17track.net/zh-cn/track?nums={code}" }
};

export const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  shipped: "已发货",
  in_transit: "运输中",
  delivered: "已签收",
  exception: "异常"
};
