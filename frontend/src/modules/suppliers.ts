/**
 * 供应商与供应商文件。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { closeModal, confirmAction, openModal, state } from "../prototype-api";
import {
  SUPPLIER_GRADE_LABEL, SUPPLIER_PAGE_SIZE_OPTIONS, SUPPLIER_STATUS_META, SUPPLIER_STATUS_VALUES, type Supplier,
  type SupplierGrade, type SupplierStatus
} from "./models";
import { formatFileSize } from "./exams";
import { badge, cookieValue, escapeHtml, qs, qsa } from "./shared";
import { countryFlag } from "./customer-detail";
import { api, setButtonPending, toast } from "./ui";
import { hasIamCapability } from "./auth";
import { formatLeadDate } from "./leads";
import { ordDownloadFile, ordPreviewFile } from "./orders";

// ---------------------------------------------------------------------------
// 供应商管理（仿「客户管理」：列表 + 筛选 + 分页 + 详情抽屉 + 新增/编辑/删除）
//
// 与客户的差别只在「归属」：供应商是团队共享资产，后端按 teamId 返回，
// 前端不做「我的 / 公池」那套切换。
// ---------------------------------------------------------------------------

export async function loadSuppliers(force = false) {
  if (state.suppliersLoaded && !force) return;
  const result = await api<{ suppliers: Supplier[] }>("/api/suppliers");
  state.suppliers = result.suppliers;
  state.suppliersLoaded = true;
}

function supplierStatusBadge(supplier: Supplier) {
  const meta = SUPPLIER_STATUS_META[supplier.status] || SUPPLIER_STATUS_META.active;
  return badge(meta.label, meta.tone);
}

const SUPPLIER_GRADE_SHORT: Record<SupplierGrade, string> = {
  A: "核心", B: "重点", C: "常规", D: "备选"
};

/**
 * 分级方块：直接复用客户管理「客户价值」那套 .customer-grade 元件（38×36 圆角方块 + 大字母 + 小标签）。
 * 之前用 badge 渲染成一颗横向大药丸，和右边状态药丸并排时两块形状打架，是列表显廉价的主因。
 */
function supplierGradeChip(supplier: Supplier) {
  const grade = (supplier.grade || "C") as SupplierGrade;
  return `<span class="customer-grade customer-grade-${grade.toLowerCase()}" title="${escapeHtml(SUPPLIER_GRADE_LABEL[grade])}"><b>${escapeHtml(grade)}</b><small>${SUPPLIER_GRADE_SHORT[grade]}</small></span>`;
}

/**
 * 联系方式固定两行：第一行邮箱（或没有邮箱时退回电话），第二行其余要素。
 * 之前是一串 a 标签用 · 连接，窄列里会折成三行且每行长度不一，把行高从 73 拉到 83。
 */
function supplierContactCell(supplier: Supplier) {
  const primary = supplier.email
    ? `<a class="sup-contact-primary" href="mailto:${escapeHtml(supplier.email)}" title="发邮件给 ${escapeHtml(supplier.contact || supplier.company)}">${escapeHtml(supplier.email)}</a>`
    : supplier.phone
      ? `<a class="sup-contact-primary" href="tel:${escapeHtml(supplier.phone.replace(/\s+/gu, ""))}" title="打电话">${escapeHtml(supplier.phone)}</a>`
      : `<span class="sup-contact-empty">联系方式待补充</span>`;
  const rest: string[] = [];
  if (supplier.email && supplier.phone) {
    rest.push(`<a href="tel:${escapeHtml(supplier.phone.replace(/\s+/gu, ""))}" title="打电话">${escapeHtml(supplier.phone)}</a>`);
  }
  if (supplier.wechat) rest.push(`<span title="微信 / WhatsApp">${escapeHtml(supplier.wechat)}</span>`);
  if (supplier.website) {
    const url = /^https?:\/\//iu.test(supplier.website) ? supplier.website : `https://${supplier.website.replace(/^\/+/u, "")}`;
    const host = url.replace(/^https?:\/\//iu, "").replace(/\/.*$/u, "");
    rest.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="打开官网">${escapeHtml(host)}</a>`);
  }
  return `<div class="sup-contact-lines">${primary}${rest.length ? `<span class="sup-contact-secondary">${rest.join(`<i>·</i>`)}</span>` : ""}</div>`;
}

/** 最近更新：主行只放更新时间（MM/DD HH:mm），副行说清「建档多久」，不再把同一个时间戳原样重复两遍 */
function supplierUpdatedCell(supplier: Supplier) {
  const updatedAt = supplier.updatedAt || supplier.createdAt;
  const created = new Date(supplier.createdAt);
  const now = new Date();
  const fmt = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || "—";
    return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Number.isNaN(created.getTime()) ? -1 : Math.max(0, Math.floor((now.getTime() - created.getTime()) / dayMs));
  const createdText = days === 0 ? "今天建档" : days > 0 && days <= 30 ? `${days} 天前建档` : `${formatLeadDate(supplier.createdAt)} 建档`;
  return `<div class="customer-follow-cell"><b>${escapeHtml(fmt(updatedAt))}</b><span>${escapeHtml(createdText)}</span></div>`;
}

export function filteredSuppliers() {
  const query = state.supplierSearch.trim().toLowerCase();
  return state.suppliers.filter((supplier) => {
    const matchStatus = state.supplierStatusFilter === "all" || supplier.status === state.supplierStatusFilter;
    const haystack = [
      supplier.code, supplier.company, supplier.companyFullName, supplier.country, supplier.category,
      supplier.contact, supplier.phone, supplier.email, supplier.wechat, supplier.website,
      supplier.address, supplier.paymentTerm, supplier.source, supplier.remark
    ].filter(Boolean).join(" ").toLowerCase();
    return matchStatus && (!query || haystack.includes(query));
  });
}

/** 最近更新在前——和客户列表同一个默认口径，不提供额外排序控件 */
export function sortedSuppliers(suppliers: Supplier[]): Supplier[] {
  return [...suppliers].sort((a, b) => {
    const left = new Date(a.updatedAt || a.createdAt).getTime() || 0;
    const right = new Date(b.updatedAt || b.createdAt).getTime() || 0;
    return right - left;
  });
}

function supplierPageRows(suppliers: Supplier[]) {
  const pageCount = Math.max(1, Math.ceil(suppliers.length / state.supplierPageSize));
  state.supplierPage = Math.min(Math.max(1, state.supplierPage), pageCount);
  const start = (state.supplierPage - 1) * state.supplierPageSize;
  return { pageCount, start, rows: suppliers.slice(start, start + state.supplierPageSize) };
}

function renderSupplierPagination(total: number, pageCount: number, start: number) {
  const summary = qs<HTMLElement>("#supplierPageSummary");
  const number = qs<HTMLElement>("#supplierPageNumber");
  const prev = qs<HTMLButtonElement>("#supplierPrevPage");
  const next = qs<HTMLButtonElement>("#supplierNextPage");
  const size = qs<HTMLSelectElement>("#supplierPageSize");
  if (summary) {
    summary.textContent = total
      ? `共 ${total} 条，当前 ${start + 1}-${Math.min(start + state.supplierPageSize, total)} 条`
      : "共 0 条";
  }
  if (number) number.textContent = `${state.supplierPage} / ${pageCount}`;
  if (prev) prev.disabled = state.supplierPage <= 1;
  if (next) next.disabled = state.supplierPage >= pageCount;
  if (size && SUPPLIER_PAGE_SIZE_OPTIONS.includes(state.supplierPageSize)) size.value = String(state.supplierPageSize);
}

export function resetSupplierFilters() {
  state.supplierSearch = "";
  state.supplierStatusFilter = "all";
  state.supplierPage = 1;
  [["#supplierSearchInput", ""], ["#supplierStatusFilter", "all"]]
    .forEach(([selector, value]) => {
      const node = qs<HTMLInputElement | HTMLSelectElement>(selector);
      if (node) node.value = value;
    });
  syncSupplierStatusNav();
  renderSuppliers();
}

/** 侧边栏「全部 / 合作中 / 考察中 / 已停用」四个入口与筛选器是同一份状态，两边要互相同步 */
function syncSupplierStatusNav() {
  const title = qs<HTMLElement>("#supplierPageTitle");
  if (title) {
    title.textContent = state.supplierStatusFilter === "all"
      ? "全部供应商"
      : SUPPLIER_STATUS_META[state.supplierStatusFilter].label;
  }
  qsa<HTMLButtonElement>('.sidebar button[data-view="suppliers"]').forEach((button) => {
    button.classList.toggle("active", (button.dataset.supplierStatus || "all") === state.supplierStatusFilter);
  });
  const select = qs<HTMLSelectElement>("#supplierStatusFilter");
  if (select && select.value !== state.supplierStatusFilter) select.value = state.supplierStatusFilter;
}

/** 批量工具条：与客户管理同一条（全选 / 已选计数 / 批量删除 / 导出），只是筛选项换成供应商口径 */
function renderSupplierBulkToolbar(visible: Supplier[] = filteredSuppliers()) {
  const bar = qs<HTMLElement>("#supplierBulkToolbar");
  if (!bar) return;
  const selectedCount = state.selectedSupplierIds.length;
  const allSelected = visible.length > 0 && visible.every((item) => state.selectedSupplierIds.includes(item.id));
  const statusLabel = state.supplierStatusFilter === "all" ? "全部" : SUPPLIER_STATUS_META[state.supplierStatusFilter].label;
  bar.innerHTML = `
    <label class="customer-select-all"><input type="checkbox" data-select-all-suppliers ${allSelected ? "checked" : ""}>全选</label>
    <span class="filter">已选 ${selectedCount} 个供应商</span>
    <span class="filter">状态：${escapeHtml(statusLabel)}</span>
    <button class="btn danger" data-supplier-bulk-delete ${selectedCount && supplierCanDelete() ? "" : "disabled"}>批量删除</button>
    <button class="btn" data-supplier-export>批量导出</button>
  `;
  qs<HTMLInputElement>("[data-select-all-suppliers]", bar)?.addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    const ids = visible.map((item) => item.id);
    state.selectedSupplierIds = checked
      ? Array.from(new Set([...state.selectedSupplierIds, ...ids]))
      : state.selectedSupplierIds.filter((id) => !ids.includes(id));
    renderSuppliers();
  });
  qs<HTMLButtonElement>("[data-supplier-bulk-delete]", bar)?.addEventListener("click", () => void deleteSuppliers(state.selectedSupplierIds));
  qs<HTMLButtonElement>("[data-supplier-export]", bar)?.addEventListener("click", () => exportSuppliers(visible));
}

/** 导出当前筛选结果；表格里能看到的列才导出，地址/备注这种长文本放最后 */
export function exportSuppliers(rows: Supplier[]) {
  if (!rows.length) {
    toast("当前筛选下没有可导出的供应商", "error");
    return;
  }
  const header = ["供应商编码", "供应商名称", "公司全名", "国家", "供应品类", "分级", "状态", "联系人", "邮箱", "电话", "微信", "官网", "交期(天)", "付款条款", "来源", "地址", "备注", "建档时间"];
  const escapeCsv = (value: unknown) => `"${String(value ?? "").replace(/"/gu, '""')}"`;
  const lines = [header.map(escapeCsv).join(",")].concat(rows.map((item) => [
    item.code, item.company, item.companyFullName, item.country, item.category, item.grade,
    SUPPLIER_STATUS_META[item.status]?.label || item.status, item.contact, item.email, item.phone,
    item.wechat, item.website, item.leadTimeDays, item.paymentTerm, item.source, item.address,
    item.remark, formatLeadDate(item.createdAt)
  ].map(escapeCsv).join(",")));
  // 带 BOM，否则 Excel 打开中文全是乱码
  const blob = new Blob([`\ufeff${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `供应商清单-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${rows.length} 个供应商`);
}

export function renderSuppliers() {
  const tbody = qs<HTMLElement>("#suppliersTableBody");
  if (!tbody) return;
  const visible = sortedSuppliers(filteredSuppliers());
  const { pageCount, start, rows } = supplierPageRows(visible);
  renderSupplierPagination(visible.length, pageCount, start);
  syncSupplierStatusNav();

  const categoryText = (supplier: Supplier, limit: number) => {
    if (!supplier.category) return "";
    return supplier.category.length > limit ? `${supplier.category.slice(0, limit)}…` : supplier.category;
  };

  tbody.innerHTML = rows.length ? rows.map((supplier) => `<tr data-supplier-id="${escapeHtml(supplier.id)}" class="${supplier.id === state.selectedSupplierId ? "selected" : ""}">
    <td><input type="checkbox" class="supplier-row-check" data-supplier-check="${escapeHtml(supplier.id)}" aria-label="选择 ${escapeHtml(supplier.company)}"${state.selectedSupplierIds.includes(supplier.id) ? " checked" : ""} /></td>
    <td><div class="company">${countryFlag(supplier.country)}<div><button type="button" class="customer-name" data-open-supplier="${escapeHtml(supplier.id)}" title="查看供应商详情">${escapeHtml(supplier.company)}</button><span>${supplier.code ? `<b class="sup-code">${escapeHtml(supplier.code)}</b> · ` : ""}${escapeHtml(supplier.country || "国家待补充")} · ${escapeHtml(supplier.contact || "联系人待补充")}</span></div></div></td>
    <td><div class="sup-category-cell" title="${escapeHtml(supplier.category || "供应品类待补充")}">${escapeHtml(categoryText(supplier, 18) || "品类待补充")}</div></td>
    <td><div class="customer-value-cell">${supplierGradeChip(supplier)}${supplierStatusBadge(supplier)}</div></td>
    <td>${supplierContactCell(supplier)}</td>
    <td><div class="customer-follow-cell"><b>${supplier.leadTimeDays ? `${supplier.leadTimeDays} 天` : "未登记"}</b><span>${escapeHtml(supplier.paymentTerm || "付款条款待补充")}</span></div></td>
    <td>${supplierUpdatedCell(supplier)}</td>
    <td><div class="customer-row-actions"><button class="btn" type="button" data-supplier-action="view" data-supplier-row-id="${escapeHtml(supplier.id)}">详情</button><button class="btn" type="button" data-supplier-action="edit" data-supplier-row-id="${escapeHtml(supplier.id)}">编辑</button>${supplierCanDelete() ? `<button class="btn sup-action-delete" type="button" data-supplier-action="delete" data-supplier-row-id="${escapeHtml(supplier.id)}">删除</button>` : ""}</div></td>
  </tr>`).join("") : (state.suppliers.length
    ? `<tr><td colspan="8" class="empty-cell">没有符合筛选条件的供应商。<button class="btn tiny" id="supplierEmptyReset" type="button">清空筛选</button></td></tr>`
    : `<tr><td colspan="8" class="empty-cell">${state.suppliersLoaded ? "暂无供应商，点右上角「新增供应商」开始建档。" : "供应商数据加载中…"}</td></tr>`);

  const mobile = qs<HTMLElement>("#supplierMobileList");
  if (mobile) {
    mobile.innerHTML = rows.length ? rows.map((supplier) => `
    <article class="customer-mobile-card" data-supplier-mobile-id="${escapeHtml(supplier.id)}">
      <span class="customer-mobile-top"><span class="customer-mobile-company">${countryFlag(supplier.country)}<button type="button" class="customer-name" data-open-supplier="${escapeHtml(supplier.id)}">${escapeHtml(supplier.company)}</button></span>${supplierStatusBadge(supplier)}</span>
      <span>${escapeHtml(supplier.country || "国家待补充")} · ${escapeHtml(supplier.contact || "联系人待补充")}</span>
      <span class="customer-mobile-meta">${supplier.code ? `<i class="sup-code">${escapeHtml(supplier.code)}</i>` : ""}<i>${escapeHtml((supplier.grade || "C") + " 级 · " + SUPPLIER_GRADE_SHORT[(supplier.grade || "C") as SupplierGrade])}</i><i>${escapeHtml(categoryText(supplier, 20) || "品类待补充")}</i><i>${supplier.leadTimeDays ? `交期 ${supplier.leadTimeDays} 天` : "交期待登记"}</i></span>
      ${supplierContactCell(supplier)}
      <div class="customer-row-actions"><button class="btn" type="button" data-supplier-action="view" data-supplier-row-id="${escapeHtml(supplier.id)}">详情</button><button class="btn" type="button" data-supplier-action="edit" data-supplier-row-id="${escapeHtml(supplier.id)}">编辑</button>${supplierCanDelete() ? `<button class="btn sup-action-delete" type="button" data-supplier-action="delete" data-supplier-row-id="${escapeHtml(supplier.id)}">删除</button>` : ""}</div>
    </article>`).join("") : `<div class="empty-cell">${state.suppliers.length ? "没有符合筛选条件的供应商。" : "暂无供应商。"}</div>`;
  }

  renderSupplierBulkToolbar(visible);

  const scope = qs<HTMLElement>("#suppliers");
  if (scope) {
    qsa<HTMLInputElement>("[data-supplier-check]", scope).forEach((box) => box.addEventListener("change", () => {
      const id = box.dataset.supplierCheck || "";
      if (!id) return;
      state.selectedSupplierIds = box.checked
        ? Array.from(new Set([...state.selectedSupplierIds, id]))
        : state.selectedSupplierIds.filter((item) => item !== id);
      // 只重画工具条：整表重绘会让用户刚点的勾选框失焦
      renderSupplierBulkToolbar(visible);
    }));
    qsa<HTMLButtonElement>("[data-open-supplier]", scope).forEach((button) => button.addEventListener("click", () => {
      const supplier = state.suppliers.find((item) => item.id === button.dataset.openSupplier);
      if (!supplier) return;
      state.selectedSupplierId = supplier.id;
      renderSupplierDrawer(supplier);
      openSupplierDrawer();
      qsa<HTMLElement>("tr[data-supplier-id]", tbody).forEach((row) => row.classList.toggle("selected", row.dataset.supplierId === supplier.id));
    }));
    qsa<HTMLButtonElement>("[data-supplier-action]", scope).forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const supplier = state.suppliers.find((item) => item.id === button.dataset.supplierRowId);
      if (!supplier) return;
      if (button.dataset.supplierAction === "view") {
        state.selectedSupplierId = supplier.id;
        renderSupplierDrawer(supplier);
        openSupplierDrawer();
      }
      if (button.dataset.supplierAction === "edit") openSupplierModal(supplier);
      if (button.dataset.supplierAction === "delete") void deleteSuppliers([supplier.id]);
    }));
  }
  qs<HTMLButtonElement>("#supplierEmptyReset")?.addEventListener("click", resetSupplierFilters);

  const selected = state.suppliers.find((item) => item.id === state.selectedSupplierId);
  if (selected && qs("#supplierDrawer")?.classList.contains("open")) renderSupplierDrawer(selected);
}

function supplierCanDelete() {
  return !state.iamCapabilities || hasIamCapability("supplier.delete");
}

// ---------------------------------------------------------------------------
// 供应商文件（走文件中心：file_references.entity_type = "supplier"）
//
// 为什么复用 /api/files 而不是在供应商表里存一份附件列表：
// 文件本体、版本、回收站、预览派生、审计都已在文件中心，供应商只需要一条引用。
// 移除 = 进回收站（不物理删），避免「点错一下附件永久没了」。
// ---------------------------------------------------------------------------

interface SupplierFileItem {
  id: string;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
  status?: string;
  deriveStatus?: string;
  previewable?: boolean;
  ownerName?: string;
}

const supplierFileCache = new Map<string, SupplierFileItem[]>();
/** 分片阈值：与订单附件保持一致，超过就分片，断点续传 */
const SUPPLIER_FILE_CHUNK_THRESHOLD = 8 * 1024 * 1024;

function supplierFileExt(name: string) {
  const matched = /\.([A-Za-z0-9]{1,6})$/u.exec(name || "");
  return matched ? matched[1].toUpperCase() : "FILE";
}

function bindSupplierFileEvents(supplierId: string) {
  const upload = qs<HTMLButtonElement>("#supplierFileUploadButton");
  const input = qs<HTMLInputElement>("#supplierFileInput");
  if (!upload || !input) return;
  // 用 onclick/onchange 而不是 addEventListener：抽屉会重复渲染，监听器叠起来会一次传好几遍
  upload.onclick = () => input.click();
  input.onchange = () => {
    const files = Array.from(input.files || []);
    input.value = "";
    if (files.length) void uploadSupplierFiles(supplierId, files);
  };
}

async function loadSupplierFiles(supplierId: string) {
  const host = qs<HTMLElement>("#supplierFileList");
  if (!host || host.dataset.supplierFiles !== supplierId) return;
  try {
    const result = await api<{ items: SupplierFileItem[] }>(
      `/api/files?entityType=supplier&entityId=${encodeURIComponent(supplierId)}&limit=100`
    );
    supplierFileCache.set(supplierId, (result.items || []).filter((item) => item.status !== "recycled"));
  } catch (error) {
    const current = qs<HTMLElement>("#supplierFileList");
    if (current && current.dataset.supplierFiles === supplierId) {
      current.innerHTML = `<div class="sup-file-empty">文件加载失败：${escapeHtml(error instanceof Error ? error.message : "请稍后重试")}</div>`;
    }
    return;
  }
  renderSupplierFiles(supplierId);
}

function renderSupplierFiles(supplierId: string) {
  const host = qs<HTMLElement>("#supplierFileList");
  if (!host || host.dataset.supplierFiles !== supplierId) return;
  const items = supplierFileCache.get(supplierId) || [];
  const count = qs<HTMLElement>("#supplierFileCount");
  if (count) count.textContent = items.length ? String(items.length) : "";
  if (!items.length) {
    host.innerHTML = `<div class="sup-file-empty">还没有文件。报价单、图纸、验厂报告、质检证书都可以传到这里。</div>`;
    return;
  }
  host.innerHTML = items.map((file) => `<div class="sup-file-row">
    <span class="sup-file-ext">${escapeHtml(supplierFileExt(file.name))}</span>
    <div class="sup-file-main">
      <b title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</b>
      <span>${escapeHtml(formatFileSize(file.size))} · ${escapeHtml(formatLeadDate(file.createdAt))}${file.ownerName ? ` · ${escapeHtml(file.ownerName)}` : ""}${file.deriveStatus === "processing" ? " · 转换中" : ""}</span>
    </div>
    <div class="sup-file-ops">
      <button type="button" class="btn tiny" data-sup-file-preview="${escapeHtml(file.id)}"${file.previewable ? "" : ` disabled title="该格式不支持在线预览，可下载查看"`}>预览</button>
      <button type="button" class="btn tiny" data-sup-file-download="${escapeHtml(file.id)}">下载</button>
      <button type="button" class="btn tiny sup-file-remove" data-sup-file-remove="${escapeHtml(file.id)}" data-sup-file-name="${escapeHtml(file.name)}">移除</button>
    </div>
  </div>`).join("");
  qsa<HTMLButtonElement>("[data-sup-file-preview]", host).forEach((button) => {
    button.addEventListener("click", () => ordPreviewFile(button.dataset.supFilePreview || ""));
  });
  qsa<HTMLButtonElement>("[data-sup-file-download]", host).forEach((button) => {
    button.addEventListener("click", () => ordDownloadFile(button.dataset.supFileDownload || ""));
  });
  qsa<HTMLButtonElement>("[data-sup-file-remove]", host).forEach((button) => {
    button.addEventListener("click", () => void recycleSupplierFile(supplierId, button));
  });
}

async function uploadSupplierFiles(supplierId: string, files: File[]) {
  const usable = files.filter((file) => file.size <= 100 * 1024 * 1024);
  if (!usable.length) {
    toast("单个文件不能超过 100MB", "error");
    return;
  }
  const button = qs<HTMLButtonElement>("#supplierFileUploadButton");
  if (button) {
    button.disabled = true;
    button.textContent = "上传中…";
  }
  let done = 0;
  const failures: string[] = [];
  for (const [index, file] of usable.entries()) {
    if (button) button.textContent = `上传中 ${index + 1}/${usable.length}`;
    try {
      await uploadSupplierFile(supplierId, file);
      done += 1;
    } catch (error) {
      failures.push(`${file.name}：${error instanceof Error ? error.message : "上传失败"}`);
    }
  }
  if (button) {
    button.disabled = false;
    button.textContent = "上传文件";
  }
  if (failures.length) toast(`已上传 ${done} 个，${failures.length} 个失败：${failures[0]}`, "error");
  else toast(`已上传 ${done} 个文件`);
  await loadSupplierFiles(supplierId);
}

async function uploadSupplierFile(supplierId: string, file: File) {
  const csrfToken = cookieValue("gj_csrf");
  const headers: Record<string, string> = csrfToken ? { "x-csrf-token": csrfToken } : {};
  const token = `sup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`.slice(0, 64);
  if (file.size <= SUPPLIER_FILE_CHUNK_THRESHOLD) {
    const response = await fetch(
      `/api/files?contextType=supplier&contextId=${encodeURIComponent(supplierId)}&kind=supplier-doc`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-file-type": file.type || "application/octet-stream",
          "x-client-token": token,
          ...headers
        },
        body: file
      }
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: "上传失败" }));
      throw new Error(body.message || `上传失败（HTTP ${response.status}）`);
    }
    return;
  }

  // 大文件走分片：同一个 clientToken 重试不会产生第二份
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const jsonHeaders: Record<string, string> = { "content-type": "application/json", ...headers };
  const startResponse = await fetch("/api/files/uploads", {
    method: "POST",
    credentials: "same-origin",
    headers: jsonHeaders,
    body: JSON.stringify({
      fileName: file.name,
      size: file.size,
      sha256,
      clientToken: token,
      contextType: "supplier",
      contextId: supplierId,
      kind: "supplier-doc"
    })
  });
  const started = await startResponse.json().catch(() => ({}));
  if (!startResponse.ok) throw new Error(started.message || `创建上传会话失败（HTTP ${startResponse.status}）`);
  if (started.file) return;
  const session = started.session as { id: string; chunkSize: number; totalChunks: number; received: number[] };
  const received = new Set(session.received || []);
  for (let index = 0; index < session.totalChunks; index += 1) {
    if (received.has(index)) continue;
    const begin = index * session.chunkSize;
    const blob = file.slice(begin, Math.min(file.size, begin + session.chunkSize));
    const chunkResponse = await fetch(`/api/files/uploads/${encodeURIComponent(session.id)}/chunks/${index}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/octet-stream", ...headers },
      body: blob
    });
    if (!chunkResponse.ok) {
      const body = await chunkResponse.json().catch(() => ({ message: "分片上传失败" }));
      throw new Error(body.message || `分片 ${index + 1} 上传失败（HTTP ${chunkResponse.status}）`);
    }
  }
  const completeResponse = await fetch(`/api/files/uploads/${encodeURIComponent(session.id)}/complete`, {
    method: "POST",
    credentials: "same-origin",
    headers: jsonHeaders,
    body: "{}"
  });
  if (!completeResponse.ok) {
    const body = await completeResponse.json().catch(() => ({ message: "拼装失败" }));
    throw new Error(body.message || `拼装失败（HTTP ${completeResponse.status}）`);
  }
}

async function recycleSupplierFile(supplierId: string, button: HTMLButtonElement) {
  const fileId = button.dataset.supFileRemove || "";
  const name = button.dataset.supFileName || "该文件";
  if (!fileId) return;
  const confirmed = await confirmAction({
    title: "移除供应商文件",
    message: `把《${name}》移入回收站？`,
    consequences: ["文件会从这家供应商下面消失", "文件本体不会被物理删除，可在文件中心回收站恢复"],
    detail: name,
    detailLabel: "本次移除",
    confirmLabel: "移入回收站"
  });
  if (!confirmed) return;
  button.disabled = true;
  try {
    await api(`/api/files/${encodeURIComponent(fileId)}/recycle`, {
      method: "POST",
      body: JSON.stringify({ reason: "供应商附件移除" })
    });
    toast("文件已移入回收站");
    await loadSupplierFiles(supplierId);
  } catch (error) {
    button.disabled = false;
    toast(error instanceof Error ? error.message : "移除失败", "error");
  }
}

/** 供应商详情抽屉：与客户/同行同一个右侧抽屉形态，只读展示 + 编辑/删除入口 */
function renderSupplierDrawer(supplier?: Supplier) {
  const drawer = qs<HTMLElement>("#supplierDrawer");
  if (!drawer || !supplier) return;
  // 上传/删除文件要拿供应商 id；写在 DOM 上比再存一份 state 更不容易过期
  drawer.dataset.supplierId = supplier.id;
  const websiteUrl = supplier.website
    ? (/^https?:\/\//iu.test(supplier.website) ? supplier.website : `https://${supplier.website.replace(/^\/+/u, "")}`)
    : "";
  drawer.innerHTML = `
    <div class="drawer-head">
      <div>
        <h2>${escapeHtml(supplier.company)}</h2>
        <p>${escapeHtml(supplier.country || "国家待补充")} · ${escapeHtml(supplier.category || "品类待补充")} · ${escapeHtml(SUPPLIER_GRADE_LABEL[supplier.grade] || "未分级")}</p>
      </div>
      <div class="inline-actions">${supplierStatusBadge(supplier)}<button class="btn icon-only" id="supplierDrawerClose" type="button" title="关闭" aria-label="关闭供应商详情">×</button></div>
    </div>
    <div class="info-grid">
      <div class="info"><span>供应商编码</span><b class="sup-code sup-code-lg">${escapeHtml(supplier.code || "未编码")}</b></div>
      <div class="info"><span>公司全名</span><b>${escapeHtml(supplier.companyFullName || supplier.company)}</b></div>
      <div class="info"><span>联系人</span><b>${escapeHtml(supplier.contact || "待补充")}</b></div>
      <div class="info"><span>邮箱</span><b>${supplier.email ? `<a href="mailto:${escapeHtml(supplier.email)}">${escapeHtml(supplier.email)}</a>` : "待补充"}</b></div>
      <div class="info"><span>电话</span><b>${supplier.phone ? `<a href="tel:${escapeHtml(supplier.phone.replace(/\s+/gu, ""))}">${escapeHtml(supplier.phone)}</a>` : "待补充"}</b></div>
      <div class="info"><span>微信 / WhatsApp</span><b>${escapeHtml(supplier.wechat || "待补充")}</b></div>
      <div class="info"><span>官网</span><b>${websiteUrl ? `<a href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(websiteUrl.replace(/^https?:\/\//iu, ""))}</a>` : "待补充"}</b></div>
      <div class="info"><span>付款条款</span><b>${escapeHtml(supplier.paymentTerm || "待补充")}</b></div>
      <div class="info"><span>交货周期</span><b>${supplier.leadTimeDays ? `${supplier.leadTimeDays} 天` : "待登记"}</b></div>
      <div class="info"><span>来源</span><b>${escapeHtml(supplier.source || "未登记")}</b></div>
      <div class="info"><span>建档时间</span><b>${escapeHtml(formatLeadDate(supplier.createdAt))}</b></div>
    </div>
    <div class="sup-drawer-block">
      <h3>地址</h3>
      <p class="sup-drawer-text">${escapeHtml(supplier.address || "尚未登记地址")}</p>
    </div>
    <div class="sup-drawer-block">
      <h3>备注</h3>
      <p class="sup-drawer-text">${escapeHtml(supplier.remark || "暂无备注")}</p>
    </div>
    <div class="sup-drawer-block sup-files-block">
      <div class="sup-files-head">
        <h3>文件<span class="sup-files-count" id="supplierFileCount"></span></h3>
        <div class="sup-files-ops">
          <input type="file" id="supplierFileInput" multiple hidden />
          <button class="btn tiny" id="supplierFileUploadButton" type="button">上传文件</button>
        </div>
      </div>
      <div class="sup-file-list" id="supplierFileList" data-supplier-files="${escapeHtml(supplier.id)}">
        <div class="sup-file-empty">文件加载中…</div>
      </div>
    </div>
    <div class="customer-row-actions sup-drawer-actions">
      <button class="btn primary" type="button" data-supplier-drawer-edit>编辑供应商</button>
      ${supplierCanDelete() ? `<button class="btn danger" type="button" data-supplier-drawer-delete>删除</button>` : ""}
    </div>`;
  qs<HTMLButtonElement>("#supplierDrawerClose")?.addEventListener("click", closeSupplierDrawer);
  qs<HTMLButtonElement>("[data-supplier-drawer-edit]", drawer)?.addEventListener("click", () => openSupplierModal(supplier));
  qs<HTMLButtonElement>("[data-supplier-drawer-delete]", drawer)?.addEventListener("click", () => void deleteSuppliers([supplier.id]));
  bindSupplierFileEvents(supplier.id);
  void loadSupplierFiles(supplier.id);
}

function openSupplierDrawer() {
  qs("#supplierDrawer")?.classList.add("open");
  qs("#supplierDrawerBackdrop")?.classList.add("active");
  document.body.classList.add("customer-drawer-open");
}

export function closeSupplierDrawer() {
  qs("#supplierDrawer")?.classList.remove("open");
  qs("#supplierDrawerBackdrop")?.classList.remove("active");
  if (!qs("#customerDrawer")?.classList.contains("open") && !qs("#peerDrawer")?.classList.contains("open")) {
    document.body.classList.remove("customer-drawer-open");
  }
}

export function openSupplierModal(supplier?: Supplier) {
  const editing = Boolean(supplier);
  const gradeOptions = (Object.keys(SUPPLIER_GRADE_LABEL) as SupplierGrade[])
    .map((grade) => `<option value="${grade}" ${(supplier?.grade || "C") === grade ? "selected" : ""}>${SUPPLIER_GRADE_LABEL[grade]}</option>`)
    .join("");
  const statusOptions = SUPPLIER_STATUS_VALUES
    .map((status) => `<option value="${status}" ${(supplier?.status || "active") === status ? "selected" : ""}>${SUPPLIER_STATUS_META[status].label}</option>`)
    .join("");
  openModal(editing ? "编辑供应商" : "新增供应商", `
    <div class="form-grid">
      <div class="form-field full"><label>供应商编码</label><input id="supplierCodeInput" maxlength="40" value="${escapeHtml(supplier?.code || "")}" placeholder="留空自动生成，例如 SUP-0001"><small class="form-hint">团队内唯一，只能使用字母、数字、点、下划线、连字符；留空保存时按顺序生成</small></div>
      <div class="form-field full"><label>供应商名称 *</label><input id="supplierCompanyInput" maxlength="200" value="${escapeHtml(supplier?.company || "")}" placeholder="例如：Acme Sensors GmbH"><small class="form-hint">列表与工作台使用这个短名称</small></div>
      <div class="form-field full"><label>公司全名（单据 / 资料）</label><input id="supplierCompanyFullNameInput" maxlength="200" value="${escapeHtml(supplier?.companyFullName || "")}" placeholder="留空则沿用上面的名称"><small class="form-hint">采购合同、报关资料优先使用此名称</small></div>
      <div class="form-field"><label>国家 / 地区</label><input id="supplierCountryInput" maxlength="80" value="${escapeHtml(supplier?.country || "")}" placeholder="例如：德国"></div>
      <div class="form-field"><label>供应品类</label><input id="supplierCategoryInput" maxlength="300" value="${escapeHtml(supplier?.category || "")}" placeholder="例如：称重传感器 / 仪表"></div>
      <div class="form-field"><label>联系人</label><input id="supplierContactInput" maxlength="120" value="${escapeHtml(supplier?.contact || "")}"></div>
      <div class="form-field"><label>电话</label><input id="supplierPhoneInput" maxlength="80" inputmode="tel" value="${escapeHtml(supplier?.phone || "")}"></div>
      <div class="form-field"><label>邮箱</label><input id="supplierEmailInput" type="email" maxlength="160" value="${escapeHtml(supplier?.email || "")}"></div>
      <div class="form-field"><label>微信 / WhatsApp</label><input id="supplierWechatInput" maxlength="80" value="${escapeHtml(supplier?.wechat || "")}"></div>
      <div class="form-field full"><label>官网</label><input id="supplierWebsiteInput" maxlength="255" value="${escapeHtml(supplier?.website || "")}" placeholder="例如 https://example.com"></div>
      <div class="form-field full"><label>地址</label><input id="supplierAddressInput" maxlength="500" value="${escapeHtml(supplier?.address || "")}" placeholder="国家、城市、街道"></div>
      <div class="form-field"><label>付款条款</label><input id="supplierPaymentTermInput" maxlength="200" value="${escapeHtml(supplier?.paymentTerm || "")}" placeholder="例如 T/T 30% deposit"></div>
      <div class="form-field"><label>交货周期（天）</label><input id="supplierLeadTimeInput" type="number" min="0" max="3650" step="1" value="${supplier?.leadTimeDays || 0}"></div>
      <div class="form-field"><label>供应分级</label><select id="supplierGradeInput">${gradeOptions}</select></div>
      <div class="form-field"><label>合作状态</label><select id="supplierStatusInput">${statusOptions}</select></div>
      <div class="form-field"><label>来源</label><input id="supplierSourceInput" maxlength="120" value="${escapeHtml(supplier?.source || (editing ? "" : "手动新增"))}" placeholder="展会、官网、转介绍等"></div>
      <div class="form-field full"><label>备注</label><textarea id="supplierRemarkInput" rows="3" maxlength="2000" placeholder="合作历史、质量表现、注意事项等">${escapeHtml(supplier?.remark || "")}</textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveSupplierButton" data-editing-id="${escapeHtml(supplier?.id || "")}">${editing ? "保存修改" : "保存供应商"}</button>`, { closeOnBackdrop: false, modalClass: "supplier-editor-modal" });
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveSupplierButton")?.addEventListener("click", () => void saveSupplier());
  qs<HTMLInputElement>("#supplierCompanyInput")?.focus();
}

async function saveSupplier() {
  const company = qs<HTMLInputElement>("#supplierCompanyInput")?.value.trim() || "";
  if (!company) {
    toast("请填写供应商名称", "error");
    qs<HTMLInputElement>("#supplierCompanyInput")?.focus();
    return;
  }
  const saveButton = qs<HTMLButtonElement>("#saveSupplierButton");
  const editingId = saveButton?.dataset.editingId || "";
  const payload = {
    code: qs<HTMLInputElement>("#supplierCodeInput")?.value.trim() || "",
    company,
    companyFullName: qs<HTMLInputElement>("#supplierCompanyFullNameInput")?.value.trim() || "",
    country: qs<HTMLInputElement>("#supplierCountryInput")?.value.trim() || "",
    category: qs<HTMLInputElement>("#supplierCategoryInput")?.value.trim() || "",
    contact: qs<HTMLInputElement>("#supplierContactInput")?.value.trim() || "",
    phone: qs<HTMLInputElement>("#supplierPhoneInput")?.value.trim() || "",
    email: qs<HTMLInputElement>("#supplierEmailInput")?.value.trim() || "",
    wechat: qs<HTMLInputElement>("#supplierWechatInput")?.value.trim() || "",
    website: qs<HTMLInputElement>("#supplierWebsiteInput")?.value.trim() || "",
    address: qs<HTMLInputElement>("#supplierAddressInput")?.value.trim() || "",
    paymentTerm: qs<HTMLInputElement>("#supplierPaymentTermInput")?.value.trim() || "",
    leadTimeDays: Math.max(0, Math.min(3650, Math.floor(Number(qs<HTMLInputElement>("#supplierLeadTimeInput")?.value || 0)) || 0)),
    grade: (qs<HTMLSelectElement>("#supplierGradeInput")?.value || "C") as SupplierGrade,
    status: (qs<HTMLSelectElement>("#supplierStatusInput")?.value || "active") as SupplierStatus,
    source: qs<HTMLInputElement>("#supplierSourceInput")?.value.trim() || (editingId ? "" : "手动新增"),
    remark: qs<HTMLTextAreaElement>("#supplierRemarkInput")?.value.trim() || ""
  };
  if (saveButton) setButtonPending(saveButton, true, editingId ? "保存修改" : "保存供应商", "保存中…");
  try {
    if (editingId) {
      const result = await api<{ supplier: Supplier }>(`/api/suppliers/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
      state.suppliers = state.suppliers.map((item) => item.id === result.supplier.id ? result.supplier : item);
      toast("供应商已保存");
    } else {
      const result = await api<{ supplier: Supplier }>("/api/suppliers", { method: "POST", body: JSON.stringify(payload) });
      state.suppliers = [result.supplier, ...state.suppliers];
      state.supplierPage = 1;
      toast("供应商已新增");
    }
    closeModal();
    renderSuppliers();
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
    if (saveButton) setButtonPending(saveButton, false, editingId ? "保存修改" : "保存供应商", editingId ? "保存修改" : "保存供应商");
  }
}

async function deleteSuppliers(ids: string[]) {
  const targets = state.suppliers.filter((item) => ids.includes(item.id));
  if (!targets.length) return;
  const ok = await confirmAction({
    title: targets.length > 1 ? `删除 ${targets.length} 个供应商` : "删除供应商",
    message: targets.length > 1 ? "以下供应商档案会被永久删除。" : `确定删除供应商「${targets[0].company}」吗？`,
    detail: targets.slice(0, 6).map((item) => item.company).join("、"),
    consequences: ["供应商的联系方式、付款条款、交期等资料会一并删除", "已生成的采购单据不受影响", "删除后不可恢复"],
    confirmLabel: "删除",
    tone: "danger"
  });
  if (!ok) return;
  try {
    const result = await api<{ deleted: string[]; suppliers: Supplier[] }>("/api/suppliers/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
    state.suppliers = result.suppliers;
    // 删掉的 id 必须从选中集里摘掉，否则工具条会一直显示「已选 2 个」但表格已经空了
    const deleted = new Set(result.deleted);
    state.selectedSupplierIds = state.selectedSupplierIds.filter((id) => !deleted.has(id));
    if (state.selectedSupplierId && ids.includes(state.selectedSupplierId)) {
      state.selectedSupplierId = null;
      closeSupplierDrawer();
    }
    toast(`已删除 ${result.deleted.length} 个供应商`);
    renderSuppliers();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败", "error");
  }
}
