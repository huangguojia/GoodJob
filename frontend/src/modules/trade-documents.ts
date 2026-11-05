/**
 * 外贸单证：PI/CI、导入识别、文档素材、报价历史、预览导出。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import * as XLSX from "xlsx";
import {
  DOCUMENT_LOGO_INLINE_KEYS, activateNavView, closeModal, openModal, saveTradeDocument, state,
  tradeDocumentOcrProvider
} from "../prototype-api";
import {
  type Customer, type CustomerImportRow, DOCUMENT_LOGO_TEMPLATE_SLOTS, type Deal, type DocumentAssetPlacement,
  type DocumentAssetsResponse, type DocumentDefaultProfile, type DocumentLetterhead, type DocumentLetterheadSnapshot,
  type DocumentLogoPlacements, type DocumentSignature, type DocumentStamp, type ImportExportJob, type Product,
  type QuoteHistoryItem, type QuoteHistoryRecord, type QuoteHistoryResponse, type QuoteProductAnalysisRow,
  type TradeDocument, type TradeDocumentAudit, type TradeDocumentHistoryResponse, type TradeDocumentImportAnalysis,
  type TradeDocumentImportDraft, type TradeDocumentItem, type TradeDocumentRecognitionTemplate,
  type TradeDocumentSendRecord, documentLogoPlacementKey
} from "./models";
import { refreshDashboardOnly } from "./dashboard";
import { normalizeWhatsAppPhone, renderCustomers } from "./customers";
import { rowValue } from "./exams";
import { badge, cookieValue, escapeHtml, qs, qsa } from "./shared";
import { api, setButtonPending, toast } from "./ui";
import { customerDocumentName } from "./leads";
import {
  closeDealDrawer, controlledDocumentImageUrl, formatDateTime, matchedSellerProfile, refreshDealsData,
  sellerProfileMatchReason
} from "./deals";
import { renderTopbarStats } from "./navigation";

export function renderJobs(jobs: ImportExportJob[]) {
  const tbody = qs<HTMLElement>("#imports tbody");
  if (!tbody) return;
  tbody.innerHTML = jobs.length ? jobs.map((job) => `<tr><td>${escapeHtml(job.name)}</td><td>${job.type === "import" ? "导入" : "导出"}</td><td>${job.rows.toLocaleString("en-US")} 行</td><td>${badge(job.status === "done" ? "完成" : job.status === "failed" ? "失败" : "待审批", job.status === "done" ? "green" : job.status === "failed" ? "red" : "amber")}</td><td>当前账号</td><td>${escapeHtml(job.createdAt)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty-cell">暂无导入导出任务</td></tr>`;
}

function documentStatusText(status: string) {
  const map: Record<string, string> = {
    draft: "草稿",
    ready: "已配置",
    pending_approval: "待审批",
    approved: "已审批",
    rejected: "已驳回",
    exported: "已导出"
  };
  return map[status] || "草稿";
}

function documentTotal(document: TradeDocument) {
  return document.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
}

export function formatDocumentMoney(value: number, currency = "USD") {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDocumentTableMoney(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function todayDateInput() {
  return new Date().toISOString().slice(0, 10);
}

export function defaultTradeDocument(type: "PI" | "CI" | "PO" | "CUSTOMS" | "PL" | "CONTRACT" | "QUOTATION" | "COO" | "SHIPPING" = "PI"): TradeDocument {
  const date = todayDateInput();
  const docTypeNames: Record<string, string> = {
    PI: "新建形式发票 PI", CI: "新建商业发票 CI", PO: "新建采购订单 Purchase Order", CUSTOMS: "新建报关资料",
    PL: "新建装箱单 Packing List", CONTRACT: "新建销售合同 Sales Contract",
    QUOTATION: "新建报价单 Quotation", COO: "新建原产地证 Certificate of Origin",
    SHIPPING: "新建装运通知 Shipping Advice"
  };
  const profile = state.documentDefaultProfile;
  const sellerProfile = matchedSellerProfile(undefined, profile?.currency || "USD", type);
  const validityDate = profile?.validityDays ? new Date(Date.now() + profile.validityDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : "";
  const baseDoc = {
    id: "__new__",
    customerId: "",
    dealId: "",
    revision: 1,
    type,
    issueDate: date,
    buyer: "",
    buyerAddress: "",
    buyerContact: "",
    seller: sellerProfile?.companyName || profile?.seller || "",
    brandMarkText: profile?.brandMarkText || "",
    sellerAddress: sellerProfile?.address || profile?.sellerAddress || "",
    sellerContact: sellerProfile?.contact || profile?.sellerContact || "",
    sellerPhone: sellerProfile?.phone || profile?.sellerPhone || "",
    sellerEmail: sellerProfile?.email || profile?.sellerEmail || "",
    sellerWebsite: sellerProfile?.website || profile?.sellerWebsite || "",
    sellerTaxNo: sellerProfile?.taxNo || profile?.sellerTaxNo || "",
    currency: profile?.currency || "USD",
    incoterm: profile?.incoterm || "DAP",
    paymentTerm: profile?.paymentTerm || "T/T 100% in advance",
    shippingMethod: profile?.shippingMethod || "Sea freight",
    portLoading: profile?.portLoading || "",
    portDischarge: "",
    validityDate,
    bankInfo: sellerProfile?.bankInfo || profile?.bankInfo || "",
    notes: profile?.notes || "",
    language: profile?.language || "EN" as const,
    templateStyle: profile?.templateStyle || "rose" as const,
    status: "draft" as const,
    audits: [] as TradeDocumentAudit[],
    sendRecords: [] as TradeDocumentSendRecord[],
    letterheadId: sellerProfile?.id || profile?.letterheadId || "",
    stampId: sellerProfile?.stampId || profile?.stampId || "",
    signatureId: sellerProfile?.signatureId || profile?.signatureId || "",
    includeProductImages: profile?.includeProductImages || false,
    updatedAt: new Date().toISOString(),
    items: [
      { id: "new_item_1", product: "", model: "", hsCode: "", quantity: 1, unit: "PCS", unitPrice: 0, originCountry: "", weightKg: 0, packageCount: 0 }
    ]
  };
  return {
    ...baseDoc,
    title: docTypeNames[type] || "新建单据",
    number: `${type}-${date.replace(/-/g, "")}-${Math.floor(Date.now() / 1000).toString().slice(-4)}`,
    ...(type === "QUOTATION" ? {
      validityDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      incoterm: "EXW",
      // 报价单默认全款预付。30% 定金那条只适合量产订单，报价阶段写上去会让客户
      // 以为要压款，谈的时候还得回头改；真需要分期的客户在客户资料里配 defaultPaymentTerm。
      paymentTerm: "T/T 100% in advance",
    } : {}),
  };
}

export function activeTradeDocument() {
  return state.tradeDocuments.find((document) => document.id === state.selectedDocumentId) || state.tradeDocuments[0] || defaultTradeDocument();
}

export function renderTradeDocuments(documents: TradeDocument[]) {
  const list = qs<HTMLElement>("#documentList");
  if (!list) return;
  const active = documents.find((document) => document.id === state.selectedDocumentId) || documents[0] || defaultTradeDocument();
  state.selectedDocumentId = active.id;
  list.innerHTML = `
    <div class="section-title"><h2>最近单据</h2><span>最多显示 9 份</span></div>
    ${documents.length ? documents.map((document) => `
      <article class="doc-list-card ${document.id === active.id ? "active" : ""}" data-document-id="${escapeHtml(document.id)}">
        <b>${escapeHtml(document.title)}</b>
        <span>${escapeHtml(document.number)} · ${document.type}</span>
        <small>${documentStatusText(document.status)}${["PL","COO","SHIPPING","CUSTOMS"].includes(document.type) ? "" : " · " + formatDocumentMoney(documentTotal(document), document.currency)}</small>
      </article>
    `).join("") : `<div class="empty-cell">暂无单据</div>`}
  `;
  qsa<HTMLElement>("[data-document-id]", list).forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedDocumentId = card.dataset.documentId || null;
      renderTradeDocuments(state.tradeDocuments);
    });
  });
  fillDocumentEditor(active);
}

export function documentTypeLabel(type: string) {
  return ({ PI: "形式发票", CI: "商业发票", PO: "采购订单", CUSTOMS: "报关资料", PL: "装箱单", CONTRACT: "销售合同", QUOTATION: "报价单", COO: "原产地证", SHIPPING: "装运通知" } as Record<string, string>)[type] || type;
}

export interface AdvancedDocumentTemplate {
  id: string;
  name: string;
  category: "sales" | "shipping" | "procurement";
  description: string;
  fileName: string;
  recommendedTypes: TradeDocument["type"][];
  maxItems: number;
  dynamicItems?: boolean;
  compatibility: "full" | "partial";
  warnings: string[];
  assetCapabilities: Array<"letterhead" | "productImages" | "stamp" | "signature">;
}

export const advancedDocumentCategoryLabels: Record<AdvancedDocumentTemplate["category"], string> = {
  sales: "销售单据",
  shipping: "物流单据",
  procurement: "采购协同"
};

export async function uploadDocumentImage(file: File, kind: "letterhead-logo" | "stamp" | "signature" | "product") {
  if (!["image/png", "image/jpeg"].includes(file.type)) throw new Error("只支持 PNG 或 JPEG 图片");
  if (file.size > 2 * 1024 * 1024) throw new Error("图片不能超过 2 MB");
  const image = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
  return api<{ imageUrl: string }>("/api/document-assets/upload", {
    method: "POST",
    body: JSON.stringify({ image, mime: file.type, kind })
  });
}

function documentAssetPlacementValue(placement?: DocumentAssetPlacement): DocumentAssetPlacement {
  return {
    horizontal: placement?.horizontal || "template",
    vertical: placement?.vertical || "template",
    offsetX: Math.max(-200, Math.min(200, Number(placement?.offsetX) || 0)),
    offsetY: Math.max(-200, Math.min(200, Number(placement?.offsetY) || 0)),
    scale: Math.max(50, Math.min(150, Number(placement?.scale) || 100))
  };
}

/**
 * 把卖方公司档案里保存的 Logo 微调值转成内联 transform。
 * HTML 版模板（定制B 的 PI / PO）用它把 Logo 挪到用户在「卖方公司」里调好的位置：
 * 位移以 px 计、缩放以 % 计。
 * 缩放锚点固定取模板自身的角（PI 右上、PO 左上）——九宫格锚点是给 Excel 导出用的，
 * 那套坐标跟 A4 纸张无关，直接套到 HTML 上会把 Logo 甩到标题上。
 * 没调过（全 0 / 100%）时返回空串，保证默认版式与参考件逐像素一致。
 */
function documentLogoPlacementStyle(placement: DocumentAssetPlacement | undefined, anchor: "left" | "right") {
  const value = documentAssetPlacementValue(placement);
  if (!value.offsetX && !value.offsetY && value.scale === 100) return "";
  return ` style="transform:translate(${value.offsetX}px, ${value.offsetY}px) scale(${value.scale / 100});transform-origin:${anchor} top"`;
}

/**
 * 取「这张单据用的模板」对应的 Logo 位置与大小。
 * 先在 logoPlacements 里找该模板自己的一套；没单独调过就沿用通用值（logoPlacement，Excel 导出也用它）。
 * 选了卖方档案时只认档案自己的值，与 Logo 取数口径保持一致（不跨档案串味）。
 */
function documentLogoPlacementFor(
  letterhead: DocumentLetterhead | undefined,
  snapshot: DocumentLetterheadSnapshot | undefined,
  documentType: string
) {
  const source: DocumentLetterhead | DocumentLetterheadSnapshot | undefined = letterhead || snapshot;
  if (!source) return undefined;
  const key = documentLogoPlacementKey("custom-b", documentType);
  return source.logoPlacements?.[key] || source.logoPlacement;
}

let docLogoInlineSaveTimer = 0;

function documentLogoInlineContext(document: TradeDocument) {
  const letterheadId = qs<HTMLSelectElement>("#docSellerProfileInput")?.value || "";
  const letterhead = state.documentAssets.letterheads.find((item) => item.id === letterheadId);
  const key = documentLogoPlacementKey(document.templateStyle, document.type);
  return { letterhead, key, active: Boolean(letterhead) && DOCUMENT_LOGO_INLINE_KEYS.has(key) };
}

/** 单据编辑页的一行 Logo 调节器：随预览刷新同步可见性与数值（预览怎么画，这里就显示哪套值） */
function syncDocumentLogoInline(document: TradeDocument) {
  const row = qs<HTMLElement>("#docLogoInline");
  if (!row) return;
  const { letterhead, key, active } = documentLogoInlineContext(document);
  if (!active || !letterhead) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  const slot = DOCUMENT_LOGO_TEMPLATE_SLOTS.find((item) => item.key === key);
  const slotText = qs<HTMLElement>("#docLogoInlineSlot");
  if (slotText) slotText.textContent = slot?.label || key;
  const value = documentAssetPlacementValue(letterhead.logoPlacements?.[key] || letterhead.logoPlacement);
  const offset = qs<HTMLElement>("#docLogoInlineOffset");
  const scale = qs<HTMLElement>("#docLogoInlineScale");
  if (offset) offset.textContent = `X ${value.offsetX} · Y ${value.offsetY}`;
  if (scale) scale.textContent = `${value.scale}%`;
}

/** 调节结果先写进档案状态并立即反映到预览；停手 700ms 后静默存回卖方公司档案 */
function applyDocumentLogoInlineChange(document: TradeDocument, mutate: (value: DocumentAssetPlacement) => void) {
  const { letterhead, key, active } = documentLogoInlineContext(document);
  if (!active || !letterhead) return;
  const value = documentAssetPlacementValue(letterhead.logoPlacements?.[key] || letterhead.logoPlacement);
  mutate(value);
  letterhead.logoPlacements = { ...(letterhead.logoPlacements || {}), [key]: value };
  renderDocumentPreview(collectDocumentDraft());
  window.clearTimeout(docLogoInlineSaveTimer);
  docLogoInlineSaveTimer = window.setTimeout(() => { void saveDocumentLogoInline(letterhead.id); }, 700);
}

async function saveDocumentLogoInline(letterheadId: string) {
  const asset = state.documentAssets.letterheads.find((item) => item.id === letterheadId);
  if (!asset) return;
  try {
    await api("/api/document-assets/letterheads", { method: "POST", body: JSON.stringify({
      id: asset.id, name: asset.name, companyName: asset.companyName, address: asset.address,
      contact: asset.contact || "", taxNo: asset.taxNo || "", phone: asset.phone, email: asset.email,
      website: asset.website || "", bankInfo: asset.bankInfo || "", logoUrl: asset.logoUrl || "",
      logoPlacement: documentAssetPlacementValue(asset.logoPlacement), logoPlacements: asset.logoPlacements || {},
      matchCountries: asset.matchCountries || [], matchCurrencies: asset.matchCurrencies || [],
      matchDocumentTypes: asset.matchDocumentTypes || [], matchPriority: asset.matchPriority || 0,
      stampId: asset.stampId || "", signatureId: asset.signatureId || "",
      isDefault: Boolean(asset.isDefault), enabled: asset.enabled !== false
    }) });
    state.documentAssets = await api<DocumentAssetsResponse>("/api/document-assets");
  } catch (error) { toast(error instanceof Error ? error.message : "Logo 位置保存失败", "error"); }
}

/** 一行调节器的交互：单击 2px / Shift 10px，按住连续移动；缩放每档 5%（与卖方公司弹窗里的手感一致） */
export function bindDocumentLogoInline() {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  qsa<HTMLButtonElement>("[data-doc-logo-dir]").forEach((button) => {
    const [dx, dy] = String(button.dataset.docLogoDir || "0|0").split("|").map((part) => Number(part) || 0);
    let holdTimer = 0;
    let repeatTimer = 0;
    let held = false;
    const stop = () => { window.clearTimeout(holdTimer); window.clearInterval(repeatTimer); };
    const step = (size: number) => applyDocumentLogoInlineChange(collectDocumentDraft(), (value) => {
      value.offsetX = clamp(value.offsetX + dx * size, -200, 200);
      value.offsetY = clamp(value.offsetY + dy * size, -200, 200);
    });
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      held = false;
      holdTimer = window.setTimeout(() => {
        held = true;
        step(2);
        repeatTimer = window.setInterval(() => step(2), 90);
      }, 420);
    });
    button.addEventListener("click", (event) => {
      if (held) { held = false; return; }
      step(event.shiftKey ? 10 : 2);
    });
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointerleave", stop);
    button.addEventListener("pointercancel", stop);
  });
  qsa<HTMLButtonElement>("[data-doc-logo-zoom]").forEach((button) => {
    button.addEventListener("click", () => applyDocumentLogoInlineChange(collectDocumentDraft(), (value) => {
      value.scale = clamp(value.scale + Number(button.dataset.docLogoZoom || 0), 50, 150);
    }));
  });
}

interface DocumentLogoPlacementSlot {
  key: string;
  label: string;
  hint: string;
  excel?: boolean;
  placement?: DocumentAssetPlacement;
}

function documentAssetPlacementFields(prefix: string, title: string, placement?: DocumentAssetPlacement, imageUrl = "", hint = "九宫格锚点用于 Excel 导出；下面两行调整位置与大小", slots?: DocumentLogoPlacementSlot[]) {
  const value = documentAssetPlacementValue(placement);
  const selectedKey = value.horizontal === "template" || value.vertical === "template" ? "template" : `${value.horizontal}-${value.vertical}`;
  const positions = [
    ["left-top", "左上"], ["center-top", "上中"], ["right-top", "右上"],
    ["left-middle", "左中"], ["center-middle", "居中"], ["right-middle", "右中"],
    ["left-bottom", "左下"], ["center-bottom", "下中"], ["right-bottom", "右下"]
  ];
  // 分模板调节：每个模板各存一套位置与大小，切页签时把当前值存进隐藏的 JSON，保存时一并回传
  const slotList = slots || [];
  const activeSlot = slotList[0];
  const slotsJson = slotList.length
    ? JSON.stringify(Object.fromEntries(slotList.map((slot) => [slot.key, documentAssetPlacementValue(slot.placement)])))
    : "";
  const tabsHtml = slotList.length
    ? `<div class="document-placement-tabs" role="tablist" aria-label="选择要调节的模板">${slotList.map((slot, index) => `<button type="button" class="document-placement-tab ${index === 0 ? "active" : ""}" role="tab" aria-selected="${index === 0 ? "true" : "false"}" data-placement-tab="${prefix}" data-placement-tab-key="${escapeHtml(slot.key)}" data-placement-tab-excel="${slot.excel ? "1" : "0"}" data-placement-tab-hint="${escapeHtml(slot.hint)}">${escapeHtml(slot.label)}</button>`).join("")}</div><small class="document-placement-tab-hint" data-placement-tab-hint-text="${prefix}">${escapeHtml(activeSlot?.hint || "")}</small>`
    : "";
  return `<div class="document-asset-placement" data-placement-root="${prefix}">
    <div class="document-asset-placement-head"><div><b>${escapeHtml(title)}位置与大小</b><small>${escapeHtml(hint)}</small></div><button type="button" class="btn" data-placement-reset="${prefix}">恢复本模板默认</button></div>
    ${tabsHtml}
    <div class="document-asset-placement-body">
      <div class="document-asset-placement-preview" data-placement-preview="${prefix}"><span>模板放置区</span>${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" data-placement-preview-image="${prefix}">` : `<i>未上传图片</i>`}</div>
      <div class="document-asset-placement-controls">
        <input type="hidden" id="${prefix}PlacementHorizontal" value="${escapeHtml(value.horizontal)}">
        <input type="hidden" id="${prefix}PlacementVertical" value="${escapeHtml(value.vertical)}">
        ${slotList.length ? `<input type="hidden" id="${prefix}Placements" value="${escapeHtml(slotsJson)}">` : ""}
        <div class="document-placement-anchor" data-placement-anchor="${prefix}">
          <div class="document-placement-grid" role="group" aria-label="选择图片位置">${positions.map(([key, label]) => `<button type="button" class="document-placement-cell ${selectedKey === key ? "active" : ""}" data-placement-position="${prefix}" data-placement-key="${key}" title="${label}">${label}</button>`).join("")}</div>
          <button type="button" class="document-placement-template ${selectedKey === "template" ? "active" : ""}" data-placement-template="${prefix}">跟随模板</button>
        </div>
        <input type="hidden" id="${prefix}PlacementOffsetX" value="${value.offsetX}"><input type="hidden" id="${prefix}PlacementOffsetY" value="${value.offsetY}"><input type="hidden" id="${prefix}PlacementScale" value="${value.scale}">
        <div class="document-logo-nudge" data-placement-nudge="${prefix}" role="group" aria-label="Logo 位置与大小">
          <div class="document-logo-nudge-row">
            <span class="document-logo-nudge-label">位置</span>
            <button type="button" class="document-logo-nudge-key" data-placement-nudge-dir="${prefix}" data-nudge-x="0" data-nudge-y="-1" title="上移（按住连续移动，Shift 加速）" aria-label="上移">↑</button>
            <button type="button" class="document-logo-nudge-key" data-placement-nudge-dir="${prefix}" data-nudge-x="0" data-nudge-y="1" title="下移（按住连续移动，Shift 加速）" aria-label="下移">↓</button>
            <button type="button" class="document-logo-nudge-key" data-placement-nudge-dir="${prefix}" data-nudge-x="-1" data-nudge-y="0" title="左移（按住连续移动，Shift 加速）" aria-label="左移">←</button>
            <button type="button" class="document-logo-nudge-key" data-placement-nudge-dir="${prefix}" data-nudge-x="1" data-nudge-y="0" title="右移（按住连续移动，Shift 加速）" aria-label="右移">→</button>
            <output class="document-logo-nudge-value" data-placement-offset-value="${prefix}">X ${value.offsetX} · Y ${value.offsetY}</output>
          </div>
          <div class="document-logo-nudge-row is-zoom">
            <span class="document-logo-nudge-label">大小</span>
            <button type="button" class="document-logo-nudge-key" data-placement-zoom="${prefix}" data-zoom="-5" title="缩小" aria-label="缩小">−</button>
            <output class="document-logo-nudge-value" data-placement-scale-value="${prefix}">${value.scale}%</output>
            <button type="button" class="document-logo-nudge-key" data-placement-zoom="${prefix}" data-zoom="5" title="放大" aria-label="放大">＋</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function readDocumentAssetPlacement(prefix: string): DocumentAssetPlacement {
  const horizontal = qs<HTMLInputElement>(`#${prefix}PlacementHorizontal`)?.value as DocumentAssetPlacement["horizontal"] || "template";
  const vertical = qs<HTMLInputElement>(`#${prefix}PlacementVertical`)?.value as DocumentAssetPlacement["vertical"] || "template";
  return documentAssetPlacementValue({
    horizontal,
    vertical,
    offsetX: Number(qs<HTMLInputElement>(`#${prefix}PlacementOffsetX`)?.value || 0),
    offsetY: Number(qs<HTMLInputElement>(`#${prefix}PlacementOffsetY`)?.value || 0),
    scale: Number(qs<HTMLInputElement>(`#${prefix}PlacementScale`)?.value || 100)
  });
}

/**
 * 读出该卖方公司的「通用值 + 各模板自己的一套」。
 * 隐藏输入里是调节过程中一直同步的 JSON（切页签、点方向键都会更新），
 * 空键 "" 就是 Excel 导出用的 logoPlacement。
 */
function readDocumentLetterheadLogoPlacements(prefix: string): { logoPlacement: DocumentAssetPlacement; logoPlacements: DocumentLogoPlacements } {
  let map: Record<string, DocumentAssetPlacement> = {};
  try {
    map = JSON.parse(qs<HTMLInputElement>(`#${prefix}Placements`)?.value || "{}") as Record<string, DocumentAssetPlacement>;
  } catch { map = {}; }
  const logoPlacements: DocumentLogoPlacements = {};
  Object.entries(map || {}).forEach(([key, placement]) => {
    if (!key) return;
    logoPlacements[key] = documentAssetPlacementValue(placement);
  });
  return { logoPlacement: documentAssetPlacementValue(map[""]), logoPlacements };
}

function bindDocumentAssetPlacement(prefix: string, fileInputSelector: string) {
  // 分模板调节：drafts 里按模板键各存一套，隐藏输入 #${prefix}Placements 是唯一的保存出口
  const slotsInput = qs<HTMLInputElement>(`#${prefix}Placements`);
  let drafts: Record<string, DocumentAssetPlacement> = {};
  if (slotsInput) {
    try {
      const parsed = JSON.parse(slotsInput.value || "{}") as Record<string, DocumentAssetPlacement>;
      Object.entries(parsed || {}).forEach(([key, placement]) => { drafts[key] = documentAssetPlacementValue(placement); });
    } catch { drafts = {}; }
  }
  const tabButtons = qsa<HTMLButtonElement>(`[data-placement-tab="${prefix}"]`);
  const activeTabKey = () => tabButtons.find((button) => button.classList.contains("active"))?.dataset.placementTabKey ?? tabButtons[0]?.dataset.placementTabKey ?? "";
  let currentKey = activeTabKey();
  const persistDraft = () => {
    if (!slotsInput) return;
    drafts[currentKey] = readDocumentAssetPlacement(prefix);
    slotsInput.value = JSON.stringify(drafts);
  };
  const update = () => {
    const value = readDocumentAssetPlacement(prefix);
    const image = qs<HTMLImageElement>(`[data-placement-preview-image="${prefix}"]`);
    const scale = qs<HTMLElement>(`[data-placement-scale-value="${prefix}"]`);
    const offset = qs<HTMLElement>(`[data-placement-offset-value="${prefix}"]`);
    if (scale) scale.textContent = `${value.scale}%`;
    if (offset) offset.textContent = `X ${value.offsetX} · Y ${value.offsetY}`;
    if (image) {
      image.style.justifySelf = value.horizontal === "right" ? "end" : value.horizontal === "center" || value.horizontal === "template" ? "center" : "start";
      image.style.alignSelf = value.vertical === "bottom" ? "end" : value.vertical === "middle" || value.vertical === "template" ? "center" : "start";
      image.style.transform = `translate(${value.offsetX / 2}px, ${value.offsetY / 2}px) scale(${value.scale / 100})`;
      image.style.transformOrigin = `${value.horizontal === "right" ? "right" : value.horizontal === "center" ? "center" : "left"} ${value.vertical === "bottom" ? "bottom" : value.vertical === "middle" ? "center" : "top"}`;
    }
    persistDraft();
  };
  // 切模板：先把当前这套存进 drafts，再载入目标模板自己的值
  const activateTab = (key: string) => {
    if (!tabButtons.length) return;
    if (key === currentKey) return;
    persistDraft();
    currentKey = key;
    const draft = drafts[key] ? documentAssetPlacementValue(drafts[key]) : documentAssetPlacementValue();
    const x = qs<HTMLInputElement>(`#${prefix}PlacementOffsetX`);
    const y = qs<HTMLInputElement>(`#${prefix}PlacementOffsetY`);
    const scale = qs<HTMLInputElement>(`#${prefix}PlacementScale`);
    const h = qs<HTMLInputElement>(`#${prefix}PlacementHorizontal`);
    const v = qs<HTMLInputElement>(`#${prefix}PlacementVertical`);
    if (x) x.value = String(draft.offsetX);
    if (y) y.value = String(draft.offsetY);
    if (scale) scale.value = String(draft.scale);
    if (h) h.value = draft.horizontal;
    if (v) v.value = draft.vertical;
    tabButtons.forEach((button) => {
      const active = button.dataset.placementTabKey === key;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    const excel = tabButtons.find((button) => button.dataset.placementTabKey === key)?.dataset.placementTabExcel === "1";
    // 九宫格是 Excel 模板的坐标系，定制B 的锚点固定在模板角上，对它没有意义
    const anchor = qs<HTMLElement>(`[data-placement-anchor="${prefix}"]`);
    if (anchor) anchor.hidden = !excel;
    const hint = qs<HTMLElement>(`[data-placement-tab-hint-text="${prefix}"]`);
    const hintText = tabButtons.find((button) => button.dataset.placementTabKey === key)?.dataset.placementTabHint;
    if (hint && hintText) hint.textContent = hintText;
    update();
  };
  // 两行调节器：第一行上下左右（单击 2px，Shift 10px，按住连续移动），第二行缩小/放大（5%）。
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const nudge = (dx: number, dy: number, step: number) => {
    const x = qs<HTMLInputElement>(`#${prefix}PlacementOffsetX`);
    const y = qs<HTMLInputElement>(`#${prefix}PlacementOffsetY`);
    if (x) x.value = String(clamp((Number(x.value) || 0) + dx * step, -200, 200));
    if (y) y.value = String(clamp((Number(y.value) || 0) + dy * step, -200, 200));
    update();
  };
  const zoom = (delta: number) => {
    const scale = qs<HTMLInputElement>(`#${prefix}PlacementScale`);
    if (scale) scale.value = String(clamp((Number(scale.value) || 100) + delta, 50, 150));
    update();
  };
  qsa<HTMLButtonElement>(`[data-placement-nudge-dir="${prefix}"]`).forEach((button) => {
    const dx = Number(button.dataset.nudgeX || 0);
    const dy = Number(button.dataset.nudgeY || 0);
    let holdTimer = 0;
    let repeatTimer = 0;
    let held = false;
    const stop = () => {
      window.clearTimeout(holdTimer);
      window.clearInterval(repeatTimer);
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      held = false;
      holdTimer = window.setTimeout(() => {
        held = true;
        nudge(dx, dy, 2);
        repeatTimer = window.setInterval(() => nudge(dx, dy, 2), 90);
      }, 420);
    });
    button.addEventListener("click", (event) => {
      if (held) { held = false; return; }
      nudge(dx, dy, event.shiftKey ? 10 : 2);
    });
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointerleave", stop);
    button.addEventListener("pointercancel", stop);
  });
  qsa<HTMLButtonElement>(`[data-placement-zoom="${prefix}"]`).forEach((button) => {
    button.addEventListener("click", () => zoom(Number(button.dataset.zoom || 0)));
  });
  qsa<HTMLButtonElement>(`[data-placement-position="${prefix}"]`).forEach((button) => button.addEventListener("click", () => {
    const [horizontal, vertical] = String(button.dataset.placementKey || "left-top").split("-");
    const h = qs<HTMLInputElement>(`#${prefix}PlacementHorizontal`);
    const v = qs<HTMLInputElement>(`#${prefix}PlacementVertical`);
    if (h) h.value = horizontal;
    if (v) v.value = vertical;
    qsa<HTMLButtonElement>(`[data-placement-position="${prefix}"], [data-placement-template="${prefix}"]`).forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    update();
  }));
  qsa<HTMLButtonElement>(`[data-placement-template="${prefix}"]`).forEach((button) => button.addEventListener("click", () => {
    const h = qs<HTMLInputElement>(`#${prefix}PlacementHorizontal`);
    const v = qs<HTMLInputElement>(`#${prefix}PlacementVertical`);
    if (h) h.value = "template";
    if (v) v.value = "template";
    qsa<HTMLButtonElement>(`[data-placement-position="${prefix}"], [data-placement-template="${prefix}"]`).forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    update();
  }));
  qs<HTMLButtonElement>(`[data-placement-reset="${prefix}"]`)?.addEventListener("click", () => {
    const h = qs<HTMLInputElement>(`#${prefix}PlacementHorizontal`);
    const v = qs<HTMLInputElement>(`#${prefix}PlacementVertical`);
    const x = qs<HTMLInputElement>(`#${prefix}PlacementOffsetX`);
    const y = qs<HTMLInputElement>(`#${prefix}PlacementOffsetY`);
    const scale = qs<HTMLInputElement>(`#${prefix}PlacementScale`);
    if (h) h.value = "template";
    if (v) v.value = "template";
    if (x) x.value = "0";
    if (y) y.value = "0";
    if (scale) scale.value = "100";
    qsa<HTMLButtonElement>(`[data-placement-position="${prefix}"], [data-placement-template="${prefix}"]`).forEach((item) => item.classList.remove("active"));
    qs<HTMLButtonElement>(`[data-placement-template="${prefix}"]`)?.classList.add("active");
    update();
  });
  qsa<HTMLInputElement>(`#${prefix}PlacementOffsetX, #${prefix}PlacementOffsetY, #${prefix}PlacementScale`).forEach((input) => input.addEventListener("input", update));
  tabButtons.forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.placementTabKey || "")));
  // 初始页签是第一个模板：定制B 走九宫格以外的坐标，先把锚点区收起来
  if (tabButtons.length) {
    const first = tabButtons[0];
    const anchor = qs<HTMLElement>(`[data-placement-anchor="${prefix}"]`);
    if (anchor) anchor.hidden = first.dataset.placementTabExcel !== "1";
  }
  qs<HTMLInputElement>(fileInputSelector)?.addEventListener("change", (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    const preview = qs<HTMLElement>(`[data-placement-preview="${prefix}"]`);
    if (!file || !preview) return;
    let image = qs<HTMLImageElement>(`[data-placement-preview-image="${prefix}"]`);
    if (!image) {
      image = document.createElement("img");
      image.dataset.placementPreviewImage = prefix;
      image.alt = "";
      preview.querySelector("i")?.remove();
      preview.append(image);
    }
    const reader = new FileReader();
    reader.onload = () => { if (image) { image.src = String(reader.result || ""); update(); } };
    reader.readAsDataURL(file);
  });
  update();
}

function sellerProfileRuleText(profile: DocumentLetterhead) {
  const parts = [
    profile.matchCountries?.length ? `国家：${profile.matchCountries.join("、")}` : "",
    profile.matchCurrencies?.length ? `币种：${profile.matchCurrencies.join("、")}` : "",
    profile.matchDocumentTypes?.length ? `单据：${profile.matchDocumentTypes.map(documentTypeLabel).join("、")}` : ""
  ].filter(Boolean);
  return parts.join(" · ") || "通用规则";
}

function sellerRuleList(value: string, upperCase = false) {
  return [...new Set(value.split(/[,，;；\n]/u).map((item) => upperCase ? item.trim().toUpperCase() : item.trim()).filter(Boolean))];
}

function documentAssetChips(item: { isDefault?: boolean; enabled?: boolean }) {
  return [
    item.isDefault ? `<span class="da-chip is-default">默认</span>` : "",
    item.enabled === false ? `<span class="da-chip is-off">已停用</span>` : ""
  ].filter(Boolean).join("");
}

function documentAssetCard(input: { thumbHtml: string; name: string; chips: string; lines: string[]; editAttr: string; editId: string }) {
  const lines = input.lines.filter(Boolean)
    .map((line, index) => `<p class="${index === 0 ? "da-sub" : "da-rule"}" title="${escapeHtml(line)}">${escapeHtml(line)}</p>`)
    .join("");
  return `<article class="da-card">
    <div class="da-thumb">${input.thumbHtml}</div>
    <div class="da-info"><div class="da-title"><b>${escapeHtml(input.name)}</b>${input.chips}</div>${lines}</div>
    <button class="da-edit" type="button" data-${input.editAttr}="${escapeHtml(input.editId)}">编辑</button>
  </article>`;
}

function documentAssetPanel(input: { mark: string; title: string; count: number; addId: string; addLabel: string; emptyTitle: string; emptyHint: string; cards: string }) {
  return `<section class="da-panel">
    <header class="da-panel-head">
      <span class="da-panel-mark" aria-hidden="true">${input.mark}</span>
      <h3>${input.title}</h3>
      <span class="da-panel-count">${input.count}</span>
      <button class="da-add" type="button" id="${input.addId}">＋ ${input.addLabel}</button>
    </header>
    <div class="da-list">${input.cards || `<div class="da-empty"><i>＋</i><b>${input.emptyTitle}</b><small>${input.emptyHint}</small></div>`}</div>
  </section>`;
}

function documentAssetList(assets: DocumentAssetsResponse) {
  return `<div class="da-board">
    ${documentAssetPanel({
      mark: "卖", title: "卖方公司", count: assets.letterheads.length, addId: "documentAssetAddLetterhead", addLabel: "新增卖方公司",
      emptyTitle: "尚未维护卖方公司", emptyHint: "新增签约主体后，开单时可按国家、币种自动套用抬头与银行资料",
      cards: assets.letterheads.map((item) => documentAssetCard({
        thumbHtml: item.logoUrl ? `<img src="${escapeHtml(item.logoUrl)}" alt="">` : `<span>卖方</span>`,
        name: item.name, chips: documentAssetChips(item), lines: [item.companyName, sellerProfileRuleText(item)],
        editAttr: "edit-letterhead", editId: item.id
      })).join("")
    })}
    ${documentAssetPanel({
      mark: "章", title: "印章", count: assets.stamps.length, addId: "documentAssetAddStamp", addLabel: "新增印章",
      emptyTitle: "尚未维护印章", emptyHint: "上传透明 PNG 印章后，可在单据上指定盖章位置",
      cards: assets.stamps.map((item) => documentAssetCard({
        thumbHtml: `<img src="${escapeHtml(item.imageUrl)}" alt="">`,
        name: item.name, chips: documentAssetChips(item), lines: [item.isDefault ? "默认用于新单据" : "可选印章"],
        editAttr: "edit-stamp", editId: item.id
      })).join("")
    })}
    ${documentAssetPanel({
      mark: "签", title: "签名", count: assets.signatures.length, addId: "documentAssetAddSignature", addLabel: "新增签名",
      emptyTitle: "尚未维护签名", emptyHint: "上传手写签名图后，可在单据签署栏自动落位",
      cards: assets.signatures.map((item) => documentAssetCard({
        thumbHtml: `<img src="${escapeHtml(item.imageUrl)}" alt="">`,
        name: item.name, chips: documentAssetChips(item), lines: [[item.signerName, item.signerTitle].filter(Boolean).join(" · ")],
        editAttr: "edit-signature", editId: item.id
      })).join("")
    })}
  </div>`;
}

export function openDocumentAssetManager(assets: DocumentAssetsResponse) {
  openModal("卖方公司与单据资产", documentAssetList(assets), `<button class="btn" data-modal-close>关闭</button>`, { modalClass: "document-asset-manager-modal" });
  const description = qs<HTMLElement>("#modalDescription");
  if (description) description.textContent = "维护卖方签约主体、印章与签名，开单时按客户国家与币种自动匹配";
  const refresh = async () => {
    const next = await api<DocumentAssetsResponse>("/api/document-assets");
    state.documentAssets = next;
    renderSellerProfilesInDefaults(next);
    openDocumentAssetManager(next);
  };
  const openLetterhead = (asset?: DocumentLetterhead) => {
    const documentTypes: TradeDocument["type"][] = ["PI", "CI", "PO", "PL", "CONTRACT", "QUOTATION", "COO", "SHIPPING", "CUSTOMS"];
    // 每个模板各记一套 Logo 位置与大小：没单独调过的模板先沿用通用值（打开就与现在看到的一致）
    const logoTemplateSlots: DocumentLogoPlacementSlot[] = DOCUMENT_LOGO_TEMPLATE_SLOTS.map((slot) => ({
      ...slot,
      placement: slot.key ? (asset?.logoPlacements?.[slot.key] || asset?.logoPlacement) : asset?.logoPlacement
    }));
    openModal(asset ? "编辑卖方公司" : "新增卖方公司", `<div class="form-grid document-asset-form">
      <div class="form-field"><label>档案名称</label><input id="assetLetterheadName" value="${escapeHtml(asset?.name || "")}" placeholder="如：香港签约主体"></div>
      <div class="form-field"><label>公司英文全称</label><input id="assetLetterheadCompany" value="${escapeHtml(asset?.companyName || "")}"></div>
      <div class="form-field"><label>卖方联系人</label><input id="assetLetterheadContact" value="${escapeHtml(asset?.contact || "")}"></div>
      <div class="form-field"><label>税号 / 注册号</label><input id="assetLetterheadTaxNo" value="${escapeHtml(asset?.taxNo || "")}"></div>
      <div class="form-field full"><label>英文地址</label><textarea id="assetLetterheadAddress">${escapeHtml(asset?.address || "")}</textarea></div>
      <div class="form-field"><label>电话</label><input id="assetLetterheadPhone" value="${escapeHtml(asset?.phone || "")}"></div>
      <div class="form-field"><label>邮箱</label><input id="assetLetterheadEmail" value="${escapeHtml(asset?.email || "")}"></div>
      <div class="form-field"><label>网站</label><input id="assetLetterheadWebsite" value="${escapeHtml(asset?.website || "")}"></div>
      <div class="form-field"><label>Logo</label><input id="assetLetterheadLogo" type="file" accept="image/png,image/jpeg"><input id="assetLetterheadLogoUrl" type="hidden" value="${escapeHtml(asset?.logoUrl || "")}"></div>
      <div class="form-field full">${documentAssetPlacementFields("assetLetterhead", "Logo ", logoTemplateSlots[0]?.placement, asset?.logoUrl, "同一张 Logo 在 PI / PO 里各记一套位置与大小，切换上方模板分别调节", logoTemplateSlots)}</div>
      <div class="form-field full"><label>银行资料</label><textarea id="assetLetterheadBank">${escapeHtml(asset?.bankInfo || "")}</textarea></div>
      <div class="form-field full seller-match-rules"><label><span>适用客户国家</span><input id="assetLetterheadCountries" value="${escapeHtml((asset?.matchCountries || []).join(", "))}" placeholder="美国, 德国；留空表示不限"></label><label><span>适用币种</span><input id="assetLetterheadCurrencies" value="${escapeHtml((asset?.matchCurrencies || []).join(", "))}" placeholder="USD, EUR；留空表示不限"></label><label><span>匹配优先级</span><input id="assetLetterheadPriority" type="number" min="0" max="100" value="${asset?.matchPriority || 0}"></label></div>
      <div class="form-field full"><label>适用单据类型</label><div class="seller-document-types">${documentTypes.map((type) => `<label><input type="checkbox" data-seller-document-type="${type}" ${(asset?.matchDocumentTypes || []).includes(type) ? "checked" : ""}>${escapeHtml(documentTypeLabel(type))}</label>`).join("")}</div><small>全部不选表示适用于所有单据</small></div>
      <div class="form-field"><label>该公司默认印章</label><select id="assetLetterheadStamp"><option value="">不指定</option>${assets.stamps.filter((item) => item.enabled).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === asset?.stampId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></div>
      <div class="form-field"><label>该公司默认签名</label><select id="assetLetterheadSignature"><option value="">不指定</option>${assets.signatures.filter((item) => item.enabled).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === asset?.signatureId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></div>
      <label class="check-row"><input id="assetLetterheadDefault" type="checkbox" ${asset?.isDefault ? "checked" : ""}>设为默认卖方公司</label>
      <label class="check-row"><input id="assetLetterheadEnabled" type="checkbox" ${asset?.enabled === false ? "" : "checked"}>启用</label>
    </div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveDocumentLetterhead">保存卖方公司</button>`);
    qs<HTMLElement>("#appModal .modal")?.classList.add("document-asset-editor-modal");
    qs<HTMLButtonElement>("#saveDocumentLetterhead")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      setButtonPending(button, true, "保存卖方公司", "保存中");
      try {
        const file = qs<HTMLInputElement>("#assetLetterheadLogo")?.files?.[0];
        const logoUrl = file ? (await uploadDocumentImage(file, "letterhead-logo")).imageUrl : qs<HTMLInputElement>("#assetLetterheadLogoUrl")?.value || "";
        await api("/api/document-assets/letterheads", { method: "POST", body: JSON.stringify({
          id: asset?.id, name: qs<HTMLInputElement>("#assetLetterheadName")?.value.trim(), companyName: qs<HTMLInputElement>("#assetLetterheadCompany")?.value.trim(),
          address: qs<HTMLTextAreaElement>("#assetLetterheadAddress")?.value.trim(), contact: qs<HTMLInputElement>("#assetLetterheadContact")?.value.trim(), taxNo: qs<HTMLInputElement>("#assetLetterheadTaxNo")?.value.trim(), phone: qs<HTMLInputElement>("#assetLetterheadPhone")?.value.trim(), email: qs<HTMLInputElement>("#assetLetterheadEmail")?.value.trim(), website: qs<HTMLInputElement>("#assetLetterheadWebsite")?.value.trim(), bankInfo: qs<HTMLTextAreaElement>("#assetLetterheadBank")?.value.trim(), logoUrl, ...readDocumentLetterheadLogoPlacements("assetLetterhead"),
          matchCountries: sellerRuleList(qs<HTMLInputElement>("#assetLetterheadCountries")?.value || ""), matchCurrencies: sellerRuleList(qs<HTMLInputElement>("#assetLetterheadCurrencies")?.value || "", true), matchDocumentTypes: qsa<HTMLInputElement>("[data-seller-document-type]:checked").map((input) => input.dataset.sellerDocumentType).filter((type): type is TradeDocument["type"] => Boolean(type)), matchPriority: Number(qs<HTMLInputElement>("#assetLetterheadPriority")?.value || 0), stampId: qs<HTMLSelectElement>("#assetLetterheadStamp")?.value || "", signatureId: qs<HTMLSelectElement>("#assetLetterheadSignature")?.value || "",
          isDefault: Boolean(qs<HTMLInputElement>("#assetLetterheadDefault")?.checked), enabled: Boolean(qs<HTMLInputElement>("#assetLetterheadEnabled")?.checked)
        }) });
        await refresh();
      } catch (error) { toast(error instanceof Error ? error.message : "卖方公司保存失败", "error"); setButtonPending(button, false, "保存卖方公司", "保存中"); }
    });
    bindDocumentAssetPlacement("assetLetterhead", "#assetLetterheadLogo");
  };
  const openStamp = (asset?: DocumentStamp) => {
    openModal(asset ? "编辑印章" : "新增印章", `<div class="form-grid document-asset-form"><div class="form-field"><label>印章名称</label><input id="assetStampName" value="${escapeHtml(asset?.name || "")}" placeholder="如：英文合同章"></div><div class="form-field"><label>透明 PNG 印章</label><input id="assetStampImage" type="file" accept="image/png,image/jpeg"><input id="assetStampImageUrl" type="hidden" value="${escapeHtml(asset?.imageUrl || "")}"></div><div class="form-field full">${documentAssetPlacementFields("assetStamp", "公章 ", asset?.placement, asset?.imageUrl)}</div><label class="check-row"><input id="assetStampDefault" type="checkbox" ${asset?.isDefault ? "checked" : ""}>设为默认印章</label><label class="check-row"><input id="assetStampEnabled" type="checkbox" ${asset?.enabled === false ? "" : "checked"}>启用</label></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveDocumentStamp">保存印章</button>`);
    qs<HTMLElement>("#appModal .modal")?.classList.add("document-asset-editor-modal");
    qs<HTMLButtonElement>("#saveDocumentStamp")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      setButtonPending(button, true, "保存印章", "保存中");
      try {
        const file = qs<HTMLInputElement>("#assetStampImage")?.files?.[0];
        const imageUrl = file ? (await uploadDocumentImage(file, "stamp")).imageUrl : qs<HTMLInputElement>("#assetStampImageUrl")?.value || "";
        await api("/api/document-assets/stamps", { method: "POST", body: JSON.stringify({ id: asset?.id, name: qs<HTMLInputElement>("#assetStampName")?.value.trim(), imageUrl, placement: readDocumentAssetPlacement("assetStamp"), isDefault: Boolean(qs<HTMLInputElement>("#assetStampDefault")?.checked), enabled: Boolean(qs<HTMLInputElement>("#assetStampEnabled")?.checked) }) });
        await refresh();
      } catch (error) { toast(error instanceof Error ? error.message : "印章保存失败", "error"); setButtonPending(button, false, "保存印章", "保存中"); }
    });
    bindDocumentAssetPlacement("assetStamp", "#assetStampImage");
  };
  const openSignature = (asset?: DocumentSignature) => {
    openModal(asset ? "编辑签名" : "新增签名", `<div class="form-grid document-asset-form"><div class="form-field"><label>资产名称</label><input id="assetSignatureName" value="${escapeHtml(asset?.name || "")}" placeholder="如：销售总监英文签名"></div><div class="form-field"><label>签署人</label><input id="assetSignatureSigner" value="${escapeHtml(asset?.signerName || "")}"></div><div class="form-field"><label>职务</label><input id="assetSignatureTitle" value="${escapeHtml(asset?.signerTitle || "")}"></div><div class="form-field"><label>透明 PNG / JPEG</label><input id="assetSignatureImage" type="file" accept="image/png,image/jpeg"><input id="assetSignatureImageUrl" type="hidden" value="${escapeHtml(asset?.imageUrl || "")}"></div><label class="check-row"><input id="assetSignatureDefault" type="checkbox" ${asset?.isDefault ? "checked" : ""}>设为默认签名</label><label class="check-row"><input id="assetSignatureEnabled" type="checkbox" ${asset?.enabled === false ? "" : "checked"}>启用</label></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveDocumentSignature">保存签名</button>`);
    qs<HTMLButtonElement>("#saveDocumentSignature")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      setButtonPending(button, true, "保存签名", "保存中");
      try {
        const file = qs<HTMLInputElement>("#assetSignatureImage")?.files?.[0];
        const imageUrl = file ? (await uploadDocumentImage(file, "signature")).imageUrl : qs<HTMLInputElement>("#assetSignatureImageUrl")?.value || "";
        await api("/api/document-assets/signatures", { method: "POST", body: JSON.stringify({ id: asset?.id, name: qs<HTMLInputElement>("#assetSignatureName")?.value.trim(), signerName: qs<HTMLInputElement>("#assetSignatureSigner")?.value.trim(), signerTitle: qs<HTMLInputElement>("#assetSignatureTitle")?.value.trim(), imageUrl, isDefault: Boolean(qs<HTMLInputElement>("#assetSignatureDefault")?.checked), enabled: Boolean(qs<HTMLInputElement>("#assetSignatureEnabled")?.checked) }) });
        await refresh();
      } catch (error) { toast(error instanceof Error ? error.message : "签名保存失败", "error"); setButtonPending(button, false, "保存签名", "保存中"); }
    });
  };
  qs<HTMLButtonElement>("#documentAssetAddLetterhead")?.addEventListener("click", () => openLetterhead());
  qs<HTMLButtonElement>("#documentAssetAddStamp")?.addEventListener("click", () => openStamp());
  qs<HTMLButtonElement>("#documentAssetAddSignature")?.addEventListener("click", () => openSignature());
  qsa<HTMLButtonElement>("[data-edit-letterhead]").forEach((button) => button.addEventListener("click", () => openLetterhead(assets.letterheads.find((item) => item.id === button.dataset.editLetterhead))));
  qsa<HTMLButtonElement>("[data-edit-stamp]").forEach((button) => button.addEventListener("click", () => openStamp(assets.stamps.find((item) => item.id === button.dataset.editStamp))));
  qsa<HTMLButtonElement>("[data-edit-signature]").forEach((button) => button.addEventListener("click", () => openSignature(assets.signatures.find((item) => item.id === button.dataset.editSignature))));
}

export async function downloadAdvancedExcel(tradeDocument: TradeDocument, templateId: string, button: HTMLButtonElement) {
  if (!templateId) return;
  setButtonPending(button, true, "导出 Excel", "生成中");
  try {
    const response = await fetch(`/api/trade-documents/${encodeURIComponent(tradeDocument.id)}/export-xlsx`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(cookieValue("gj_csrf") ? { "x-csrf-token": cookieValue("gj_csrf") } : {}) },
      body: JSON.stringify({ templateId })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: "Excel 导出失败" }));
      throw new Error(body.message || "Excel 导出失败");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const fileName = encoded ? decodeURIComponent(encoded) : `${tradeDocument.number}.xlsx`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    closeModal();
    toast("高级 Excel 已下载", "success");
  } catch (error) {
    setButtonPending(button, false, "导出 Excel", "生成中");
    toast(error instanceof Error ? error.message : "高级 Excel 导出失败", "error");
  }
}

function documentConversionTargets(type: TradeDocument["type"]) {
  const map: Record<TradeDocument["type"], TradeDocument["type"][]> = {
    QUOTATION: ["PI", "CONTRACT"],
    PI: ["CI", "PL", "CONTRACT", "CUSTOMS"],
    CI: ["PL", "CUSTOMS", "SHIPPING"],
    // 采购订单（PO）是我方对供应商下的单，与销售侧单据不是同一条链路，
    // 不做自动转换，避免把供应商单据混进客户单据流。
    PO: [],
    CONTRACT: ["PI", "CI"],
    PL: ["CI", "CUSTOMS"],
    CUSTOMS: ["CI", "PL"],
    COO: ["CUSTOMS"],
    SHIPPING: ["CI", "CUSTOMS"]
  };
  return map[type] || [];
}

const tradeDocumentImportFieldLabels: Record<string, string> = {
  type: "单据类型", title: "单据标题", number: "单据编号", issueDate: "签发日期", buyer: "买方公司", buyerAddress: "买方地址", buyerContact: "买方联系人", seller: "卖方公司", sellerAddress: "卖方地址", currency: "币种", incoterm: "贸易条款", paymentTerm: "付款条款", shippingMethod: "运输方式", portLoading: "装运港", portDischarge: "目的港", validityDate: "有效期", bankInfo: "银行信息", notes: "备注"
};

function tradeDocumentImportPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function importDocumentFieldValue(id: string) {
  return qs<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`)?.value || "";
}

function importDocumentDraftFromReview(analysis: TradeDocumentImportAnalysis): TradeDocumentImportDraft {
  const draft = structuredClone(analysis.extractedDocument);
  draft.customerId = importDocumentFieldValue("tradeImportCustomer");
  draft.dealId = importDocumentFieldValue("tradeImportDeal");
  const mapping: Array<[keyof TradeDocumentImportDraft, string]> = [
    ["type", "tradeImportType"], ["title", "tradeImportTitle"], ["number", "tradeImportNumber"], ["issueDate", "tradeImportIssueDate"], ["buyer", "tradeImportBuyer"], ["buyerAddress", "tradeImportBuyerAddress"], ["buyerContact", "tradeImportBuyerContact"], ["seller", "tradeImportSeller"], ["sellerAddress", "tradeImportSellerAddress"], ["currency", "tradeImportCurrency"], ["incoterm", "tradeImportIncoterm"], ["paymentTerm", "tradeImportPayment"], ["shippingMethod", "tradeImportShipping"], ["portLoading", "tradeImportPortLoading"], ["portDischarge", "tradeImportPortDischarge"], ["validityDate", "tradeImportValidity"], ["bankInfo", "tradeImportBank"], ["notes", "tradeImportNotes"]
  ];
  mapping.forEach(([field, id]) => { (draft as unknown as Record<string, unknown>)[field] = importDocumentFieldValue(id); });
  draft.items = qsa<HTMLElement>("[data-trade-import-item]").map((row) => ({
    id: row.dataset.tradeImportItem || `import_item_${Date.now()}`,
    imageUrl: row.dataset.importImageUrl || "",
    product: qs<HTMLInputElement>("[data-import-field='product']", row)?.value.trim() || "",
    model: qs<HTMLInputElement>("[data-import-field='model']", row)?.value.trim() || "",
    material: qs<HTMLInputElement>("[data-import-field='material']", row)?.value.trim() || "",
    finish: qs<HTMLInputElement>("[data-import-field='finish']", row)?.value.trim() || "",
    hsCode: qs<HTMLInputElement>("[data-import-field='hsCode']", row)?.value.trim() || "",
    quantity: Number(qs<HTMLInputElement>("[data-import-field='quantity']", row)?.value || 0) || 0,
    unit: qs<HTMLInputElement>("[data-import-field='unit']", row)?.value.trim() || "PCS",
    unitPrice: Number(qs<HTMLInputElement>("[data-import-field='unitPrice']", row)?.value || 0) || 0,
    originCountry: qs<HTMLInputElement>("[data-import-field='originCountry']", row)?.value.trim() || "",
    weightKg: Number(qs<HTMLInputElement>("[data-import-field='weightKg']", row)?.value || 0) || 0,
    packageCount: Math.round(Number(qs<HTMLInputElement>("[data-import-field='packageCount']", row)?.value || 0) || 0)
  }));
  return draft;
}

function renderTradeDocumentImportItem(item: TradeDocumentItem, index: number) {
  const imageUrl = item.imageUrl || "";
  return `<div class="trade-document-import-item" data-trade-import-item="${escapeHtml(item.id || `import_item_${index + 1}`)}" data-import-image-url="${escapeHtml(imageUrl)}">
    <div class="trade-document-import-item-image">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(item.product || `商品 ${index + 1}`)}">` : `<span>无图片</span>`}</div>
    <label data-import-size="product"><span>品名</span><input data-import-field="product" value="${escapeHtml(item.product)}" placeholder="必须填写"></label>
    <label><span>型号</span><input data-import-field="model" value="${escapeHtml(item.model)}"></label>
    <label><span>材质 Material</span><input data-import-field="material" value="${escapeHtml(item.material || "")}"></label>
    <label><span>后处理 Finish</span><input data-import-field="finish" value="${escapeHtml(item.finish || "")}"></label>
    <label><span>HS Code</span><input data-import-field="hsCode" value="${escapeHtml(item.hsCode)}"></label>
    <label data-import-size="small"><span>数量</span><input type="number" min="0" step="any" data-import-field="quantity" value="${String(item.quantity || 0)}"></label>
    <label data-import-size="small"><span>单位</span><input data-import-field="unit" value="${escapeHtml(item.unit || "PCS")}"></label>
    <label><span>单价</span><input type="number" min="0" step="any" data-import-field="unitPrice" value="${String(item.unitPrice || 0)}"></label>
    <label data-import-size="origin"><span>原产地</span><input data-import-field="originCountry" value="${escapeHtml(item.originCountry)}"></label>
    <label><span>重量 kg</span><input type="number" min="0" step="any" data-import-field="weightKg" value="${String(item.weightKg || 0)}"></label>
    <label><span>箱数</span><input type="number" min="0" step="1" data-import-field="packageCount" value="${String(item.packageCount || 0)}"></label>
    <button type="button" data-trade-import-remove title="删除明细">×</button>
  </div>`;
}

async function renderTradeDocumentRecognitionTemplateLibrary() {
  const target = qs<HTMLElement>("#tradeRecognitionTemplateLibrary");
  if (!target) return;
  target.hidden = false;
  target.innerHTML = `<span class="trade-recognition-template-loading">正在读取本团队模板...</span>`;
  try {
    const result = await api<{ templates: TradeDocumentRecognitionTemplate[] }>("/api/trade-document-recognition-templates?includeArchived=true");
    const active = result.templates.filter((item) => item.status === "active");
    const archived = result.templates.filter((item) => item.status === "archived");
    const row = (item: TradeDocumentRecognitionTemplate) => `<div class="trade-recognition-template-row">
      <div><b>${escapeHtml(item.name)} <small>V${item.version}</small></b><span>${documentTypeLabel(item.documentType)} · ${item.sourceKind === "ocr" ? "图片 OCR" : "文件导入"} · ${item.status === "active" ? "当前启用" : "历史归档"}</span></div>
      <button class="btn" type="button" data-recognition-template-action="${item.status === "active" ? "archive" : "restore"}" data-recognition-template-id="${escapeHtml(item.id)}">${item.status === "active" ? "归档" : "恢复为新版本"}</button>
    </div>`;
    target.innerHTML = `<div class="trade-recognition-template-library-head"><div><b>识别模板库</b><span>识别时只读取启用版本，归档版本仅供审计和恢复。</span></div><button type="button" title="收起模板库" data-close-recognition-library>×</button></div>
      <div class="trade-recognition-template-group"><h4>启用中 <span>${active.length}</span></h4>${active.length ? active.map(row).join("") : "<p>暂无启用模板，当前识别继续使用通用规则。</p>"}</div>
      <details class="trade-recognition-template-group"><summary>历史归档 <span>${archived.length}</span></summary>${archived.length ? archived.map(row).join("") : "<p>暂无归档版本。</p>"}</details>`;
    qs<HTMLButtonElement>("[data-close-recognition-library]", target)?.addEventListener("click", () => { target.hidden = true; });
    qsa<HTMLButtonElement>("[data-recognition-template-action]", target).forEach((button) => button.addEventListener("click", async () => {
      const action = button.dataset.recognitionTemplateAction || "archive";
      setButtonPending(button, true, action === "archive" ? "归档" : "恢复为新版本", "处理中");
      try {
        await api(`/api/trade-document-recognition-templates/${encodeURIComponent(button.dataset.recognitionTemplateId || "")}/${action}`, { method: "POST" });
        toast(action === "archive" ? "模板已归档，后续识别不再匹配该版本" : "已恢复为新的启用版本", "success");
        await renderTradeDocumentRecognitionTemplateLibrary();
      } catch (error) {
        toast(error instanceof Error ? error.message : "模板操作失败", "error");
        setButtonPending(button, false, action === "archive" ? "归档" : "恢复为新版本", "处理中");
      }
    }));
  } catch (error) {
    target.innerHTML = `<span class="trade-recognition-template-loading is-error">${escapeHtml(error instanceof Error ? error.message : "模板库读取失败")}</span>`;
  }
}

function renderTradeDocumentImportReview(analysis: TradeDocumentImportAnalysis) {
  const draft = analysis.extractedDocument;
  const evidence = analysis.fieldEvidence || [];
  const warningHtml = analysis.warnings.length
    ? analysis.warnings.map((warning) => `<div class="trade-document-import-warning">${escapeHtml(warning)}</div>`).join("")
    : `<div class="trade-document-import-warning" style="border-color:#3b8c75;color:#28634f;background:#effaf5;">暂未发现结构性问题，确认前仍请核对原文件。</div>`;
  const field = (id: string, label: string, value: string, type = "text", cls = "") => `<label class="${cls}"><span>${label}</span><input id="${id}" type="${type}" value="${escapeHtml(value || "")}"></label>`;
  const textarea = (id: string, label: string, value: string, cls = "") => `<label class="${cls}"><span>${label}</span><textarea id="${id}">${escapeHtml(value || "")}</textarea></label>`;
  const evidenceHtml = evidence.length
    ? evidence.map((item) => `<div><span>${escapeHtml(tradeDocumentImportFieldLabels[item.field] || item.field)}</span><span>${escapeHtml(item.value)}</span><span>${tradeDocumentImportPercent(item.confidence)}</span></div>`).join("")
    : `<p>没有逐字段证据，建议按原文件逐项核对。</p>`;
  const typeOptions = ["PI", "CI", "PO", "PL", "CONTRACT", "QUOTATION", "COO", "SHIPPING", "CUSTOMS"].map((type) => `<option value="${type}" ${draft.type === type ? "selected" : ""}>${type} · ${documentTypeLabel(type)}</option>`).join("");
  const customerOptions = `<option value="">暂不关联客户</option>${state.customers.map((customer) => `<option value="${escapeHtml(customer.id)}" ${customer.id === draft.customerId ? "selected" : ""}>${escapeHtml(customerDocumentName(customer))}</option>`).join("")}`;
  const availableDeals = state.deals.filter((deal) => !draft.customerId || deal.customerId === draft.customerId);
  const dealOptions = `<option value="">暂不关联商机</option>${availableDeals.map((deal) => `<option value="${escapeHtml(deal.id)}" ${deal.id === draft.dealId ? "selected" : ""}>${escapeHtml(deal.title)} · ${escapeHtml(deal.stage)}</option>`).join("")}`;
  const recognitionLabel = analysis.recognitionTemplate ? `${analysis.recognitionTemplate.name} V${analysis.recognitionTemplate.version}` : "通用识别";
  const suggestedTemplateName = `${draft.seller || draft.buyer || analysis.sourceFileName.replace(/\.[^.]+$/u, "")} ${documentTypeLabel(draft.type)}`.trim().slice(0, 120);
  openModal("导入分析 · 审核后生成单据", `<div class="trade-document-import-shell">
    <div class="trade-document-import-summary"><div><b>${escapeHtml(analysis.sourceFileName)}</b><span>识别类型：${escapeHtml(draft.type)} · ${documentTypeLabel(draft.type)} · ${(analysis.sourceSize / 1024).toFixed(1)} KB</span></div><div class="trade-document-import-score"><span>识别可信度 ${tradeDocumentImportPercent(analysis.confidence)}</span><i style="--score:${tradeDocumentImportPercent(analysis.confidence)}"></i></div><span class="doc-status-badge">${analysis.status === "confirmed" ? "已生成" : "待审核"}</span></div>
    <div class="trade-document-import-layout">
      <aside class="trade-document-import-source"><div><h3>原文件与风险</h3><p>左侧只展示本团队受控存储的原文摘要；右侧修改的是待生成草稿。</p></div><div class="trade-document-import-warnings">${warningHtml}</div><div class="trade-document-import-evidence"><h3 style="margin-bottom:6px;">识别证据</h3>${evidenceHtml}<details style="margin-top:10px;"><summary style="cursor:pointer;color:var(--muted);font-size:10px;">查看原文摘要</summary><pre style="max-height:180px;overflow:auto;white-space:pre-wrap;color:var(--muted);font:10px/1.5 ui-monospace,monospace;">${escapeHtml(analysis.sourcePreview.join("\n"))}</pre></details></div></aside>
      <section class="trade-document-import-review"><div class="trade-document-import-review-head"><div><h3>确认导入内容</h3><p style="margin:4px 0 0;color:var(--muted);font-size:10px;">修改后确认，将创建一份草稿单据；不会自动审批或覆盖原单据。</p></div><button class="btn" id="tradeImportOpenSourceButton" type="button">打开原文件</button></div>
        <div class="trade-recognition-template-bar"><div><span>本次规则</span><b id="tradeRecognitionTemplateState">${escapeHtml(recognitionLabel)}</b><small>${analysis.recognitionTemplate ? `匹配度 ${tradeDocumentImportPercent(analysis.recognitionTemplate.matchScore)}，历史单据不会重新识别` : "未命中模板，继续使用现有通用识别"}</small></div><label><span>模板名称</span><input id="tradeRecognitionTemplateName" value="${escapeHtml(analysis.recognitionTemplate?.name || suggestedTemplateName)}" maxlength="120"></label><button class="btn" type="button" id="tradeRecognitionTemplateSave">${analysis.recognitionTemplate ? "更新模板" : "保存为模板"}</button><button class="btn" type="button" id="tradeRecognitionTemplateLibraryButton">模板库</button></div>
        <div class="trade-recognition-template-library" id="tradeRecognitionTemplateLibrary" hidden></div>
        <div class="trade-document-import-form"><label class="wide"><span>关联客户</span><select id="tradeImportCustomer">${customerOptions}</select></label><label class="wide"><span>关联商机</span><select id="tradeImportDeal">${dealOptions}</select></label><label><span>单据类型</span><select id="tradeImportType">${typeOptions}</select></label>${field("tradeImportTitle", "单据标题", draft.title, "text", "wide")}${field("tradeImportNumber", "单据编号", draft.number)}${field("tradeImportIssueDate", "签发日期", draft.issueDate, "date")}${field("tradeImportBuyer", "买方公司", draft.buyer)}${field("tradeImportBuyerContact", "买方联系人", draft.buyerContact)}${field("tradeImportSeller", "卖方公司", draft.seller)}${field("tradeImportCurrency", "币种", draft.currency)}${field("tradeImportIncoterm", "贸易条款", draft.incoterm)}${field("tradeImportShipping", "运输方式", draft.shippingMethod)}${field("tradeImportPortLoading", "装运港", draft.portLoading)}${field("tradeImportPortDischarge", "目的港", draft.portDischarge)}${field("tradeImportValidity", "有效期", draft.validityDate, "date")}${textarea("tradeImportBuyerAddress", "买方地址", draft.buyerAddress, "wide")}${textarea("tradeImportSellerAddress", "卖方地址", draft.sellerAddress, "wide")}${textarea("tradeImportPayment", "付款条款", draft.paymentTerm, "wide")}${textarea("tradeImportBank", "银行信息", draft.bankInfo, "wide")}${textarea("tradeImportNotes", "备注", draft.notes, "full")}</div>
        <div class="trade-document-import-items-head"><h3>商品明细</h3><button class="btn" type="button" id="tradeImportAddItem">增加明细</button></div><div class="trade-document-import-items" id="tradeImportItems">${draft.items.map(renderTradeDocumentImportItem).join("")}</div><div class="trade-document-import-total"><span>明细计算合计</span><b id="tradeImportTotal">${formatDocumentMoney(draft.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0), draft.currency)}</b>${analysis.declaredTotal === undefined ? "" : `<span>原单合计 ${formatDocumentMoney(analysis.declaredTotal, draft.currency)}</span>`}</div>
      </section>
    </div>
  </div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="tradeImportConfirmButton">确认并生成草稿单据</button>`, { closeOnBackdrop: false });
  qs<HTMLElement>("#appModal .modal")?.classList.add("trade-document-import-modal");
  qs<HTMLSelectElement>("#tradeImportCustomer")?.addEventListener("change", (event) => {
    const customerId = (event.currentTarget as HTMLSelectElement).value;
    const dealSelect = qs<HTMLSelectElement>("#tradeImportDeal");
    if (dealSelect) dealSelect.innerHTML = `<option value="">暂不关联商机</option>${state.deals.filter((deal) => !customerId || deal.customerId === customerId).map((deal) => `<option value="${escapeHtml(deal.id)}">${escapeHtml(deal.title)} · ${escapeHtml(deal.stage)}</option>`).join("")}`;
  });
  const total = () => {
    const items = qsa<HTMLElement>("[data-trade-import-item]");
    const amount = items.reduce((sum, row) => sum + (Number(qs<HTMLInputElement>("[data-import-field='quantity']", row)?.value || 0) || 0) * (Number(qs<HTMLInputElement>("[data-import-field='unitPrice']", row)?.value || 0) || 0), 0);
    const target = qs<HTMLElement>("#tradeImportTotal");
    if (target) target.textContent = formatDocumentMoney(amount, importDocumentFieldValue("tradeImportCurrency") || "USD");
  };
  qsa<HTMLInputElement>("#tradeImportItems input").forEach((input) => input.addEventListener("input", total));
  qsa<HTMLButtonElement>("[data-trade-import-remove]").forEach((button) => button.addEventListener("click", () => { button.closest<HTMLElement>("[data-trade-import-item]")?.remove(); total(); }));
  qs<HTMLButtonElement>("#tradeImportAddItem")?.addEventListener("click", () => {
    const box = qs<HTMLElement>("#tradeImportItems");
    if (!box) return;
    box.insertAdjacentHTML("beforeend", renderTradeDocumentImportItem({ id: `import_item_${Date.now()}`, product: "", model: "", hsCode: "", quantity: 1, unit: "PCS", unitPrice: 0, originCountry: "", weightKg: 0, packageCount: 0 }, box.children.length));
    const row = box.lastElementChild;
    qsa<HTMLInputElement>("input", row as HTMLElement).forEach((input) => input.addEventListener("input", total));
    qs<HTMLButtonElement>("[data-trade-import-remove]", row as HTMLElement)?.addEventListener("click", (event) => { (event.currentTarget as HTMLButtonElement).closest<HTMLElement>("[data-trade-import-item]")?.remove(); total(); });
  });
  qs<HTMLButtonElement>("#tradeImportOpenSourceButton")?.addEventListener("click", () => window.open(`/api/trade-document-imports/${encodeURIComponent(analysis.id)}/source`, "_blank", "noopener,noreferrer"));
  qs<HTMLButtonElement>("#tradeRecognitionTemplateLibraryButton")?.addEventListener("click", () => { void renderTradeDocumentRecognitionTemplateLibrary(); });
  qs<HTMLButtonElement>("#tradeRecognitionTemplateSave")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const name = qs<HTMLInputElement>("#tradeRecognitionTemplateName")?.value.trim() || "";
    if (!name) { toast("请填写模板名称", "error"); qs<HTMLInputElement>("#tradeRecognitionTemplateName")?.focus(); return; }
    setButtonPending(button, true, analysis.recognitionTemplate ? "更新模板" : "保存为模板", "保存中");
    try {
      const result = await api<{ template: TradeDocumentRecognitionTemplate }>(`/api/trade-document-imports/${encodeURIComponent(analysis.id)}/recognition-template`, {
        method: "POST",
        body: JSON.stringify({ name, familyId: analysis.recognitionTemplate?.familyId, document: importDocumentDraftFromReview(analysis) })
      });
      analysis.recognitionTemplate = { templateId: result.template.id, familyId: result.template.familyId, name: result.template.name, version: result.template.version, matchScore: 1, matchedAt: new Date().toISOString() };
      const stateLabel = qs<HTMLElement>("#tradeRecognitionTemplateState");
      if (stateLabel) stateLabel.textContent = `${result.template.name} V${result.template.version}`;
      button.textContent = "更新模板";
      button.disabled = false;
      toast(`识别模板已保存为 V${result.template.version}，旧版本已自动归档`, "success");
      if (!qs<HTMLElement>("#tradeRecognitionTemplateLibrary")?.hidden) await renderTradeDocumentRecognitionTemplateLibrary();
    } catch (error) {
      toast(error instanceof Error ? error.message : "识别模板保存失败", "error");
      setButtonPending(button, false, analysis.recognitionTemplate ? "更新模板" : "保存为模板", "保存中");
    }
  });
  qs<HTMLButtonElement>("#tradeImportConfirmButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const next = importDocumentDraftFromReview(analysis);
    const requiredFields: Array<[string, string, string]> = [
      ["tradeImportTitle", "单据标题", next.title], ["tradeImportNumber", "单据编号", next.number], ["tradeImportIssueDate", "签发日期", next.issueDate],
      ["tradeImportSeller", "卖方公司", next.seller]
    ];
    qsa<HTMLElement>("#tradeImportTitle, #tradeImportNumber, #tradeImportIssueDate, #tradeImportSeller, [data-import-field='product']").forEach((field) => field.style.borderColor = "");
    const missing = requiredFields.find(([, , value]) => !value.trim());
    if (missing) {
      const field = qs<HTMLInputElement>(`#${missing[0]}`);
      if (field) { field.style.borderColor = "#c94b4b"; field.focus(); }
      toast(`${missing[1]}不能为空`, "error");
      return;
    }
    if (!next.items.length) { toast("请至少保留一条商品明细", "error"); return; }
    const invalidItemIndex = next.items.findIndex((item) => !item.product.trim());
    if (invalidItemIndex >= 0) {
      const field = qsa<HTMLInputElement>("[data-import-field='product']")[invalidItemIndex];
      if (field) { field.style.borderColor = "#c94b4b"; field.focus(); }
      toast(`第 ${invalidItemIndex + 1} 条商品名称不能为空`, "error");
      return;
    }
    setButtonPending(button, true, "确认并生成草稿单据", "生成中");
    try {
      const result = await api<{ analysis: TradeDocumentImportAnalysis; document: TradeDocument }>(`/api/trade-document-imports/${encodeURIComponent(analysis.id)}/confirm`, { method: "POST", body: JSON.stringify({ document: next }) });
      closeModal();
      state.tradeDocuments = [result.document, ...state.tradeDocuments].slice(0, 9);
      state.selectedDocumentId = result.document.id;
      renderTradeDocuments(state.tradeDocuments);
      toast("已生成草稿单据，可继续预览、打印或生成其它单据", "success");
    } catch (error) { toast(error instanceof Error ? error.message : "导入确认失败", "error"); setButtonPending(button, false, "确认并生成草稿单据", "生成中"); }
  });
}

export function openTradeDocumentImport() {
  openModal("导入单据并分析", `<div class="trade-document-import-upload"><div style="padding:22px;border:1px dashed #b8d2cc;border-radius:8px;background:#f7fbfa;text-align:center;"><h3 style="margin:0;color:var(--ink);font-size:16px;">选择一份已有单据</h3><p style="margin:7px 0 14px;color:var(--muted);font-size:11px;line-height:1.6;">支持 XLSX、XLS、CSV 和可提取文本的 PDF，单文件不超过 8 MB。扫描图片 PDF 会明确提示，不会猜测内容。</p><input id="tradeDocumentImportFile" type="file" accept=".xlsx,.xls,.csv,.pdf,application/pdf,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><div id="tradeDocumentImportFileMeta" style="margin-top:10px;color:var(--muted);font-size:10px;"></div></div><div style="display:grid;gap:7px;margin-top:12px;"><b style="font-size:12px;color:var(--ink);">闭环</b><span style="font-size:10px;color:var(--muted);">上传分析 → 人工校正 → 生成单据草稿 → 现有预览 / 打印 / 转单</span></div><div id="tradeDocumentRecentImports" style="display:grid;gap:6px;margin-top:10px;"><span style="color:var(--muted);font-size:10px;">正在读取最近分析...</span></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="tradeDocumentAnalyzeButton" disabled>开始分析</button>`);
  const input = qs<HTMLInputElement>("#tradeDocumentImportFile");
  const button = qs<HTMLButtonElement>("#tradeDocumentAnalyzeButton");
  const meta = qs<HTMLElement>("#tradeDocumentImportFileMeta");
  input?.addEventListener("change", () => { const file = input.files?.[0]; if (!file) return; if (file.size > 8 * 1024 * 1024) { toast("单据文件不能超过 8 MB", "error"); input.value = ""; return; } if (meta) meta.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`; if (button) button.disabled = false; });
  button?.addEventListener("click", async () => {
    const file = input?.files?.[0];
    if (!file) return;
    setButtonPending(button, true, "开始分析", "解析中");
    try {
      const response = await fetch("/api/trade-document-imports/analyze", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name), "x-file-type": file.type || "application/octet-stream", ...(cookieValue("gj_csrf") ? { "x-csrf-token": cookieValue("gj_csrf") } : {}) }, body: await file.arrayBuffer() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || "单据分析失败");
      closeModal();
      renderTradeDocumentImportReview(body.analysis);
    } catch (error) { toast(error instanceof Error ? error.message : "单据分析失败", "error"); setButtonPending(button, false, "开始分析", "解析中"); }
  });
  void api<{ analyses: TradeDocumentImportAnalysis[] }>("/api/trade-document-imports").then(({ analyses }) => {
    const box = qs<HTMLElement>("#tradeDocumentRecentImports");
    if (!box) return;
    box.innerHTML = analyses.length ? `<b style="font-size:11px;color:var(--ink);">最近分析</b>${analyses.slice(0, 5).map((item) => `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;"><button class="btn" type="button" data-reopen-trade-import="${escapeHtml(item.id)}" style="display:flex;justify-content:space-between;min-width:0;"><span style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.sourceFileName)}</span><small>${item.status === "confirmed" ? "已生成" : "待审核"}</small></button>${item.status === "needs_review" ? `<button class="btn" type="button" data-delete-trade-import="${escapeHtml(item.id)}" title="删除待审核分析">删除</button>` : ""}</div>`).join("")}` : `<span style="color:var(--muted);font-size:10px;">暂无分析记录</span>`;
    qsa<HTMLButtonElement>("[data-reopen-trade-import]", box).forEach((recentButton) => recentButton.addEventListener("click", async () => {
      try {
        const result = await api<{ analysis: TradeDocumentImportAnalysis }>(`/api/trade-document-imports/${encodeURIComponent(recentButton.dataset.reopenTradeImport || "")}`);
        closeModal();
        renderTradeDocumentImportReview(result.analysis);
      } catch (error) { toast(error instanceof Error ? error.message : "分析记录读取失败", "error"); }
    }));
    qsa<HTMLButtonElement>("[data-delete-trade-import]", box).forEach((deleteButton) => deleteButton.addEventListener("click", async () => {
      try {
        await api(`/api/trade-document-imports/${encodeURIComponent(deleteButton.dataset.deleteTradeImport || "")}`, { method: "DELETE" });
        deleteButton.closest("div")?.remove();
        toast("待审核分析已删除", "success");
      } catch (error) { toast(error instanceof Error ? error.message : "分析删除失败", "error"); }
    }));
  }).catch(() => { const box = qs<HTMLElement>("#tradeDocumentRecentImports"); if (box) box.innerHTML = `<span style="color:var(--muted);font-size:10px;">最近分析暂时无法读取</span>`; });
}

async function tradeDocumentOcrDataUrl(file: File) {
  const supported = ["image/png", "image/jpeg", "image/webp"];
  if (!supported.includes(file.type)) throw new Error("请选择 PNG、JPG/JPEG 或 WEBP 图片");
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
  if (raw.length <= 2_700_000) return { dataUrl: raw, mime: file.type };
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("图片无法解码，请换用常见格式的原图"));
    element.src = raw;
  });
  const maxSide = 2_200;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法处理图片，请更换浏览器后重试");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const compressed = canvas.toDataURL("image/jpeg", 0.82);
  if (compressed.length > 2_900_000) throw new Error("图片压缩后仍过大，请裁剪到单据主体后重试");
  return { dataUrl: compressed, mime: "image/jpeg" };
}

export function openTradeDocumentOcr() {
  const providerHint = tradeDocumentOcrProvider.enabled
    ? (tradeDocumentOcrProvider.provider === "baidu" ? "已配置百度 OCR 优先识别，结构不足时自动由 AI 复核" : "已配置硅基流动视觉模型优先识别")
    : "当前使用已启用的 AI 视觉模型";
  openModal("OCR识别单据", `<div class="trade-document-ocr-upload"><div style="padding:24px 20px;border:1px dashed #b8d2cc;border-radius:10px;background:#f7fbfa;text-align:center;"><div style="display:grid;place-items:center;width:44px;height:44px;margin:0 auto 10px;border-radius:12px;color:#0f766e;background:#e4f5ef;font-size:20px;">◎</div><h3 style="margin:0;color:var(--ink);font-size:16px;">上传单据照片</h3><p style="margin:8px auto 15px;max-width:440px;color:var(--muted);font-size:11px;line-height:1.7;">适用于清晰、正向的 PI、报价单、商业发票、装箱单等图片。识别结果只生成待审核草稿，不会直接覆盖或提交正式单据。</p><input id="tradeDocumentOcrFile" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"><div id="tradeDocumentOcrMeta" style="min-height:18px;margin-top:10px;color:var(--muted);font-size:10px;"></div></div><div style="display:grid;gap:7px;margin-top:14px;padding:11px 12px;border:1px solid #e2ece9;border-radius:8px;background:#fbfdfc;"><b style="font-size:11px;color:var(--ink);">识别链路</b><span style="font-size:10px;color:var(--muted);line-height:1.6;">图片质量检查 → OCR/视觉识别 → 字段置信度与风险提示 → 人工审核 → 生成单据草稿</span><span style="font-size:10px;color:#8b641f;line-height:1.6;">${providerHint}；图片中的模糊、遮挡、反光和手写内容可能需要人工修正。</span></div><button class="btn" type="button" id="tradeDocumentOcrConfigButton" style="margin-top:12px;">配置 OCR 来源</button></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="tradeDocumentOcrStartButton" disabled>开始识别</button>`, { closeOnBackdrop: false });
  const input = qs<HTMLInputElement>("#tradeDocumentOcrFile");
  const start = qs<HTMLButtonElement>("#tradeDocumentOcrStartButton");
  const meta = qs<HTMLElement>("#tradeDocumentOcrMeta");
  input?.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!/^image\/(?:png|jpeg|webp)$/u.test(file.type)) { toast("请选择 PNG、JPG/JPEG 或 WEBP 图片", "error"); input.value = ""; return; }
    if (meta) meta.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB（过大图片会在浏览器内压缩）`;
    if (start) start.disabled = false;
  });
  qs<HTMLButtonElement>("#tradeDocumentOcrConfigButton")?.addEventListener("click", () => { closeModal(); activateNavView("ai-config"); });
  start?.addEventListener("click", async () => {
    const file = input?.files?.[0];
    if (!file) return;
    setButtonPending(start, true, "开始识别", "正在识别");
    if (meta) meta.textContent = "正在检查图片并提交视觉模型，请保持页面打开…";
    try {
      const prepared = await tradeDocumentOcrDataUrl(file);
      const result = await api<{ analysis: TradeDocumentImportAnalysis; duplicate: boolean }>("/api/trade-document-imports/analyze-ocr", { method: "POST", body: JSON.stringify({ image: prepared.dataUrl, mime: prepared.mime, fileName: file.name }) });
      closeModal();
      renderTradeDocumentImportReview(result.analysis);
    } catch (error) {
      toast(error instanceof Error ? error.message : "单据图片识别失败", "error");
      if (meta) meta.textContent = "识别未完成，请根据提示调整图片或 AI 配置后重试。";
      setButtonPending(start, false, "开始识别", "正在识别");
    }
  });
}

export function openDocumentConversion() {
  const source = activeTradeDocument();
  if (!source.id || source.id === "__new__") {
    toast("请先保存当前单据，再生成其它单据", "error");
    return;
  }
  const targets = documentConversionTargets(source.type);
  if (!targets.length) {
    toast("当前单据没有可转换的类型", "error");
    return;
  }
  openModal("由当前单据生成", `<div class="document-convert-modal"><p>将复制客户、商机、条款和商品明细，生成一份独立草稿。原单据不会被修改。</p><div class="document-convert-options">${targets.map((type) => `<button class="document-convert-option" type="button" data-document-convert-type="${type}"><b>${type}</b><span>${documentTypeLabel(type)}</span></button>`).join("")}</div></div>`, `<button class="btn" data-modal-close>取消</button>`);
  qsa<HTMLButtonElement>("[data-document-convert-type]").forEach((button) => button.addEventListener("click", async () => {
    const targetType = button.dataset.documentConvertType || "";
    button.disabled = true;
    try {
      const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${source.id}/convert`, { method: "POST", body: JSON.stringify({ targetType }) });
      closeModal();
      state.tradeDocuments = [result.document, ...state.tradeDocuments].slice(0, 9);
      state.selectedDocumentId = result.document.id;
      renderTradeDocuments(state.tradeDocuments);
      toast(`${documentTypeLabel(targetType)}草稿已生成`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "单据转换失败", "error");
      button.disabled = false;
    }
  }));
}

export function openProductPicker() {
  const products = state.products || [];
  if (!products.length) {
    toast("产品库暂无可选产品，请先维护产品", "error");
    return;
  }
  const selected = new Set<string>(collectDocumentItems().map((item) => item.productId).filter((id): id is string => Boolean(id)));
  openModal("选择产品明细", `<div class="document-product-picker"><input id="documentProductSearch" placeholder="搜索产品名称、型号或 HS Code"><div id="documentProductChoices">${renderDocumentProductChoices(products, selected)}</div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="documentProductApply">加入已选明细</button>`);
  const bindChoices = () => {
    qsa<HTMLInputElement>("#documentProductChoices input[type=checkbox]").forEach((input) => input.addEventListener("change", () => {
      if (input.checked) selected.add(input.value);
      else selected.delete(input.value);
    }));
  };
  bindChoices();
  const search = qs<HTMLInputElement>("#documentProductSearch");
  search?.addEventListener("input", () => {
    const keyword = search.value.trim().toLowerCase();
    const filtered = products.filter((product) => `${product.nameZh} ${product.nameEn} ${product.model} ${product.hsCode}`.toLowerCase().includes(keyword));
    const box = qs<HTMLElement>("#documentProductChoices");
    if (box) {
      box.innerHTML = renderDocumentProductChoices(filtered, selected);
      bindChoices();
    }
  });
  qs<HTMLButtonElement>("#documentProductApply")?.addEventListener("click", () => {
    const items = collectDocumentItems().filter((item) => item.product.trim() || item.productId);
    const existingIds = new Set(items.map((item) => item.productId).filter(Boolean));
    products.filter((product) => selected.has(product.id) && !existingIds.has(product.id)).forEach((product) => items.push({
      id: `item_${Date.now()}_${product.id}`,
      productId: product.id,
      imageUrl: controlledDocumentImageUrl(product.imageUrl),
      product: product.nameEn || product.nameZh,
      model: product.model || "",
      hsCode: product.hsCode || "",
      quantity: 1,
      unit: product.unit || "PCS",
      unitPrice: product.price || 0,
      originCountry: "China",
      weightKg: product.packWeight || 0,
      packageCount: 0
    }));
    renderDocumentItems(items);
    renderDocumentPreview(collectDocumentDraft());
    closeModal();
    toast(`已加入 ${selected.size} 项产品`);
  });
}

function renderDocumentProductChoices(products: Product[], selected: Set<string>) {
  return products.length ? products.map((product) => `<label class="document-product-choice"><input type="checkbox" value="${escapeHtml(product.id)}" ${selected.has(product.id) ? "checked" : ""}><span><b>${escapeHtml(product.nameEn || product.nameZh)}</b><small>${escapeHtml([product.nameZh, product.model, product.hsCode, `${product.price || 0} ${product.currency || "USD"}`].filter(Boolean).join(" · "))}</small></span></label>`).join("") : `<p class="empty-cell">没有匹配产品</p>`;
}

export function setDocumentWorkspaceMode(mode: "studio" | "history" | "quote-history" | "defaults") {
  const studio = qs<HTMLElement>("#documentStudioWorkspace");
  const history = qs<HTMLElement>("#documentHistoryWorkspace");
  const quoteHistory = qs<HTMLElement>("#quoteHistoryWorkspace");
  const defaults = qs<HTMLElement>("#documentDefaultsWorkspace");
  if (studio) studio.hidden = mode !== "studio";
  if (history) history.hidden = mode !== "history";
  if (quoteHistory) quoteHistory.hidden = mode !== "quote-history";
  if (defaults) defaults.hidden = mode !== "defaults";
  if (mode === "history") {
    populateDocumentHistoryFilters();
    void loadDocumentHistory();
  }
  if (mode === "quote-history") {
    populateQuoteHistoryFilters();
    void loadQuoteHistory();
  }
  if (mode === "defaults") void loadDocumentDefaultsWorkspace();
}

function documentDefaultValue(id: string) {
  return qs<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`)?.value.trim() || "";
}

function collectDocumentDefaultProfile(): DocumentDefaultProfile {
  const current = state.documentDefaultProfile;
  return {
    teamId: current?.teamId || "",
    seller: documentDefaultValue("documentDefaultSeller"),
    brandMarkText: documentDefaultValue("documentDefaultBrandMarkText"),
    sellerAddress: documentDefaultValue("documentDefaultSellerAddress"),
    sellerContact: documentDefaultValue("documentDefaultSellerContact"),
    sellerPhone: documentDefaultValue("documentDefaultSellerPhone"),
    sellerEmail: documentDefaultValue("documentDefaultSellerEmail"),
    sellerWebsite: documentDefaultValue("documentDefaultSellerWebsite"),
    sellerTaxNo: documentDefaultValue("documentDefaultSellerTaxNo"),
    bankInfo: documentDefaultValue("documentDefaultBankInfo"),
    currency: documentDefaultValue("documentDefaultCurrency") || "USD",
    incoterm: documentDefaultValue("documentDefaultIncoterm") || "DAP",
    paymentTerm: documentDefaultValue("documentDefaultPaymentTerm") || "T/T 100% in advance",
    shippingMethod: documentDefaultValue("documentDefaultShippingMethod") || "Sea freight",
    portLoading: documentDefaultValue("documentDefaultPortLoading"),
    validityDays: Number(documentDefaultValue("documentDefaultValidityDays") || 0),
    notes: documentDefaultValue("documentDefaultNotes"),
    language: (documentDefaultValue("documentDefaultLanguage") || "EN") as TradeDocument["language"],
    templateStyle: (documentDefaultValue("documentDefaultTemplateStyle") || "rose") as TradeDocument["templateStyle"],
    letterheadId: documentDefaultValue("documentDefaultLetterhead"),
    stampId: documentDefaultValue("documentDefaultStamp"),
    signatureId: documentDefaultValue("documentDefaultSignature"),
    includeProductImages: Boolean(qs<HTMLInputElement>("#documentDefaultProductImages")?.checked),
    updatedBy: current?.updatedBy || "",
    updatedAt: current?.updatedAt || ""
  };
}

function renderDocumentDefaultsPreview(profile = collectDocumentDefaultProfile()) {
  const box = qs<HTMLElement>("#documentDefaultsPreview");
  if (!box) return;
  const letterhead = state.documentAssets.letterheads.find((item) => item.id === profile.letterheadId);
  const stamp = state.documentAssets.stamps.find((item) => item.id === profile.stampId);
  const signature = state.documentAssets.signatures.find((item) => item.id === profile.signatureId);
  const contact = [profile.sellerContact, profile.sellerPhone, profile.sellerEmail].filter(Boolean).join(" · ");
  const fallbackMark = [...(profile.seller || letterhead?.companyName || "GJ").trim()].slice(0, 2).join("").toUpperCase() || "GJ";
  const mark = [...(profile.brandMarkText || "").trim()].slice(0, 8).join("").toUpperCase() || fallbackMark;
  box.innerHTML = `<div class="document-default-preview-sheet"><header><div class="document-default-preview-brand"><span class="document-default-preview-mark">${escapeHtml(mark)}</span><div>${letterhead?.logoUrl ? `<img src="${escapeHtml(letterhead.logoUrl)}" alt="" style="width:74px;height:30px;object-fit:contain;object-position:left center;">` : ""}<b>${escapeHtml(profile.seller || letterhead?.companyName || "未配置公司名称")}</b><span>${escapeHtml(profile.sellerAddress || letterhead?.address || "公司地址将在此显示")}</span></div></div><small>${escapeHtml(profile.language)} · ${escapeHtml(profile.templateStyle)}</small></header><p>${escapeHtml(contact || "联系人、电话、邮箱")}${profile.sellerWebsite ? `<br>${escapeHtml(profile.sellerWebsite)}` : ""}${profile.sellerTaxNo ? `<br>Tax No. ${escapeHtml(profile.sellerTaxNo)}` : ""}</p><dl><div><dt>Currency</dt><dd>${escapeHtml(profile.currency)}</dd></div><div><dt>Incoterm</dt><dd>${escapeHtml(profile.incoterm)}</dd></div><div><dt>Shipping</dt><dd>${escapeHtml(profile.shippingMethod)}</dd></div><div><dt>Port</dt><dd>${escapeHtml(profile.portLoading || "-")}</dd></div></dl><p>${escapeHtml(profile.paymentTerm || "付款条款未配置")}</p><p>${escapeHtml(profile.bankInfo ? `Bank: ${profile.bankInfo}` : "银行资料未配置")}</p><div class="document-default-preview-assets">${stamp ? `<img src="${escapeHtml(stamp.imageUrl)}" alt="印章">` : ""}${signature ? `<img data-signature src="${escapeHtml(signature.imageUrl)}" alt="签名">` : ""}${!stamp && !signature ? `<small>当前未选择印章与签名</small>` : ""}</div></div>`;
}

function renderSellerProfilesInDefaults(assets = state.documentAssets) {
  const box = qs<HTMLElement>("#documentSellerProfilesList");
  if (!box) return;
  const editable = state.documentDefaultsCanManage;
  const profiles = [...assets.letterheads].sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || Number(right.enabled) - Number(left.enabled) || (right.matchPriority || 0) - (left.matchPriority || 0));
  box.innerHTML = profiles.length ? profiles.map((profile) => {
    const stamp = assets.stamps.find((item) => item.id === profile.stampId);
    const signature = assets.signatures.find((item) => item.id === profile.signatureId);
    const assetsText = [stamp ? `印章：${stamp.name}` : "", signature ? `签名：${signature.name}` : ""].filter(Boolean).join(" · ");
    const bankConfigured = Boolean((profile.bankInfo || "").trim());
    return `<article class="document-seller-profile-card${profile.enabled ? "" : " is-disabled"}">
      <header><div><b>${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.companyName)}</small></div>${profile.isDefault ? `<em>默认公司</em>` : profile.enabled ? `<em>已启用</em>` : `<em>已停用</em>`}</header>
      <small>${escapeHtml(sellerProfileRuleText(profile))}</small>
      <small>${escapeHtml(assetsText || "使用团队默认印章与签名")} · 优先级 ${profile.matchPriority || 0}</small>
      <label class="document-seller-bank"><span>银行资料 <em class="${bankConfigured ? "is-set" : "is-empty"}">${bankConfigured ? "已配置" : "未配置"}</em><small>选中该卖方公司时自动带入单据</small></span><textarea rows="3" data-seller-bank-input="${escapeHtml(profile.id)}" ${editable ? "" : "disabled"} placeholder="如：Beneficiary / Bank name / Account No. / SWIFT / Address">${escapeHtml(profile.bankInfo || "")}</textarea></label>
      ${editable ? `<div class="document-seller-bank-actions"><button class="btn" type="button" data-save-seller-bank="${escapeHtml(profile.id)}">保存银行资料</button></div>` : ""}
    </article>`;
  }).join("") : `<p class="empty-cell">尚未配置卖方公司。新建单据将使用下方兜底资料。</p>`;
  qsa<HTMLButtonElement>("[data-save-seller-bank]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.saveSellerBank || "";
      const profile = state.documentAssets.letterheads.find((item) => item.id === id);
      const input = qs<HTMLTextAreaElement>(`[data-seller-bank-input="${id}"]`);
      if (!profile || !input) return;
      setButtonPending(button, true, "保存银行资料", "保存中");
      try {
        await api("/api/document-assets/letterheads", { method: "POST", body: JSON.stringify({ ...profile, bankInfo: input.value.trim() }) });
        state.documentAssets = await api<DocumentAssetsResponse>("/api/document-assets");
        renderSellerProfilesInDefaults(state.documentAssets);
        toast(`${profile.name} 银行资料已保存`);
      } catch (error) {
        toast(error instanceof Error ? error.message : "银行资料保存失败", "error");
        setButtonPending(button, false, "保存银行资料", "保存中");
      }
    });
  });
}

function fillDocumentDefaultsWorkspace(profile: DocumentDefaultProfile, assets: DocumentAssetsResponse) {
  const values: Record<string, string> = {
    documentDefaultSeller: profile.seller, documentDefaultBrandMarkText: profile.brandMarkText || "", documentDefaultSellerAddress: profile.sellerAddress, documentDefaultSellerContact: profile.sellerContact,
    documentDefaultSellerPhone: profile.sellerPhone, documentDefaultSellerEmail: profile.sellerEmail, documentDefaultSellerWebsite: profile.sellerWebsite,
    documentDefaultSellerTaxNo: profile.sellerTaxNo, documentDefaultBankInfo: profile.bankInfo, documentDefaultCurrency: profile.currency,
    documentDefaultIncoterm: profile.incoterm || "DAP", documentDefaultPaymentTerm: profile.paymentTerm || "T/T 100% in advance", documentDefaultShippingMethod: profile.shippingMethod,
    documentDefaultPortLoading: profile.portLoading, documentDefaultValidityDays: String(profile.validityDays || 0), documentDefaultNotes: profile.notes,
    documentDefaultLanguage: profile.language, documentDefaultTemplateStyle: profile.templateStyle
  };
  Object.entries(values).forEach(([id, value]) => { const input = qs<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`); if (input) input.value = value || ""; });
  const options = <T extends { id: string; name: string; enabled: boolean }>(items: T[], selected: string, empty: string) => `<option value="">${empty}</option>${items.filter((item) => item.enabled).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}`;
  const letterhead = qs<HTMLSelectElement>("#documentDefaultLetterhead"); if (letterhead) letterhead.innerHTML = options(assets.letterheads, profile.letterheadId, "使用单据卖方资料");
  const stamp = qs<HTMLSelectElement>("#documentDefaultStamp"); if (stamp) stamp.innerHTML = options(assets.stamps, profile.stampId, "默认不盖章");
  const signature = qs<HTMLSelectElement>("#documentDefaultSignature"); if (signature) signature.innerHTML = options(assets.signatures, profile.signatureId, "默认不签名");
  const productImages = qs<HTMLInputElement>("#documentDefaultProductImages"); if (productImages) productImages.checked = profile.includeProductImages;
  const editable = state.documentDefaultsCanManage;
  qsa<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("#documentDefaultsWorkspace input, #documentDefaultsWorkspace select, #documentDefaultsWorkspace textarea").forEach((field) => { field.disabled = !editable; });
  const save = qs<HTMLButtonElement>("#documentDefaultsSaveButton"); if (save) save.hidden = !editable;
  const manage = qs<HTMLButtonElement>("#documentDefaultsManageAssets"); if (manage) manage.hidden = !editable;
  const manageSellers = qs<HTMLButtonElement>("#documentSellerProfilesManage"); if (manageSellers) manageSellers.hidden = !editable;
  qsa<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("#documentDefaultsWorkspace input, #documentDefaultsWorkspace select, #documentDefaultsWorkspace textarea").forEach((field) => { field.oninput = () => renderDocumentDefaultsPreview(); field.onchange = () => renderDocumentDefaultsPreview(); });
  renderSellerProfilesInDefaults(assets);
  renderDocumentDefaultsPreview(profile);
}

async function loadDocumentDefaultsWorkspace() {
  try {
    const [defaults, assets] = await Promise.all([api<{ profile: DocumentDefaultProfile; canManage: boolean }>("/api/document-defaults"), api<DocumentAssetsResponse>("/api/document-assets")]);
    state.documentDefaultProfile = defaults.profile;
    state.documentDefaultsCanManage = defaults.canManage;
    state.documentAssets = assets;
    fillDocumentDefaultsWorkspace(defaults.profile, assets);
  } catch (error) { toast(error instanceof Error ? error.message : "默认配置加载失败", "error"); }
}

export async function saveDocumentDefaults() {
  const button = qs<HTMLButtonElement>("#documentDefaultsSaveButton");
  if (!button || !state.documentDefaultsCanManage) return;
  setButtonPending(button, true, "保存团队配置", "保存中");
  try {
    const profile = collectDocumentDefaultProfile();
    const result = await api<{ profile: DocumentDefaultProfile }>("/api/document-defaults", { method: "PUT", body: JSON.stringify(profile) });
    state.documentDefaultProfile = result.profile;
    fillDocumentDefaultsWorkspace(result.profile, state.documentAssets);
    toast("团队单据默认配置已保存");
  } catch (error) { toast(error instanceof Error ? error.message : "默认配置保存失败", "error"); }
  finally { setButtonPending(button, false, "保存团队配置", "保存中"); }
}

function populateDocumentHistoryFilters() {
  const customer = qs<HTMLSelectElement>("#documentHistoryCustomer");
  const deal = qs<HTMLSelectElement>("#documentHistoryDeal");
  if (customer) {
    const current = customer.value;
    customer.innerHTML = `<option value="">全部客户</option>${state.customers.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.company)}</option>`).join("")}`;
    customer.value = current;
  }
  if (deal) {
    const current = deal.value;
    deal.innerHTML = `<option value="">全部商机</option>${state.deals.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}`;
    deal.value = current;
  }
}

function documentHistoryParams() {
  const params = new URLSearchParams({ page: String(state.documentHistoryPage), pageSize: "20" });
  const fields: Array<[string, string]> = [
    ["q", qs<HTMLInputElement>("#documentHistoryKeyword")?.value.trim() || ""],
    ["type", qs<HTMLSelectElement>("#documentHistoryType")?.value || ""],
    ["status", qs<HTMLSelectElement>("#documentHistoryStatus")?.value || ""],
    ["customerId", qs<HTMLSelectElement>("#documentHistoryCustomer")?.value || ""],
    ["dealId", qs<HTMLSelectElement>("#documentHistoryDeal")?.value || ""],
    ["from", qs<HTMLInputElement>("#documentHistoryFrom")?.value || ""],
    ["to", qs<HTMLInputElement>("#documentHistoryTo")?.value || ""]
  ];
  fields.forEach(([key, value]) => { if (value) params.set(key, value); });
  return params;
}

export async function loadDocumentHistory() {
  const rows = qs<HTMLElement>("#documentHistoryRows");
  if (rows) rows.innerHTML = `<tr><td colspan="8" class="empty-cell">正在查询历史单据</td></tr>`;
  try {
    const result = await api<TradeDocumentHistoryResponse>(`/api/trade-documents/history?${documentHistoryParams().toString()}`);
    state.documentHistoryPage = result.page;
    state.documentHistoryPageCount = result.pageCount;
    state.documentHistoryTotal = result.total;
    renderDocumentHistory(result.documents);
  } catch (error) {
    if (rows) rows.innerHTML = `<tr><td colspan="8" class="empty-cell">${escapeHtml(error instanceof Error ? error.message : "历史单据加载失败")}</td></tr>`;
  }
}

function renderDocumentHistory(documents: TradeDocument[]) {
  const rows = qs<HTMLElement>("#documentHistoryRows");
  const summary = qs<HTMLElement>("#documentHistorySummary");
  const page = qs<HTMLElement>("#documentHistoryPageText");
  const prev = qs<HTMLButtonElement>("#documentHistoryPrevButton");
  const next = qs<HTMLButtonElement>("#documentHistoryNextButton");
  if (summary) summary.textContent = `共 ${state.documentHistoryTotal} 份历史单据`;
  if (page) page.textContent = `第 ${state.documentHistoryPage} / ${state.documentHistoryPageCount} 页`;
  if (prev) prev.disabled = state.documentHistoryPage <= 1;
  if (next) next.disabled = state.documentHistoryPage >= state.documentHistoryPageCount;
  if (!rows) return;
  rows.innerHTML = documents.length ? documents.map((document) => {
    const customer = state.customers.find((item) => item.id === document.customerId);
    const deal = state.deals.find((item) => item.id === document.dealId);
    const amountText = ["PL", "COO", "SHIPPING", "CUSTOMS"].includes(document.type) ? "-" : formatDocumentMoney(documentTotal(document), document.currency);
    return `<tr><td><div class="document-history-title"><b>${escapeHtml(document.title)}</b><span>${escapeHtml(document.number)} · v${document.revision || 1}</span>${document.derivedFromDocumentId ? `<small>由 ${escapeHtml(document.derivedFromType || "源单据")} 转换</small>` : ""}</div></td><td><div class="document-history-title"><b>${escapeHtml(customer?.company || document.buyer || "未关联客户")}</b><span>${escapeHtml(deal?.title || "未关联商机")}</span></div></td><td>${escapeHtml(documentTypeLabel(document.type))}</td><td>${escapeHtml(amountText)}</td><td>${badge(documentStatusText(document.status), document.status === "approved" || document.status === "exported" ? "green" : document.status === "rejected" ? "red" : document.status === "pending_approval" ? "amber" : "blue")}</td><td>${escapeHtml(document.issueDate || "-")}</td><td>${escapeHtml(formatDateTime(document.updatedAt))}</td><td><button class="btn" type="button" data-document-history-open="${escapeHtml(document.id)}">打开</button></td></tr>`;
  }).join("") : `<tr><td colspan="8" class="empty-cell">没有符合条件的历史单据</td></tr>`;
  qsa<HTMLButtonElement>("[data-document-history-open]", rows).forEach((button) => button.addEventListener("click", () => {
    const document = documents.find((item) => item.id === button.dataset.documentHistoryOpen);
    if (!document) return;
    state.tradeDocuments = [document, ...state.tradeDocuments.filter((item) => item.id !== document.id)].slice(0, 9);
    state.selectedDocumentId = document.id;
    setDocumentWorkspaceMode("studio");
    renderTradeDocuments(state.tradeDocuments);
  }));
}

export function resetDocumentHistoryFilters() {
  ["documentHistoryKeyword", "documentHistoryFrom", "documentHistoryTo"].forEach((id) => { const input = qs<HTMLInputElement>(`#${id}`); if (input) input.value = ""; });
  ["documentHistoryType", "documentHistoryStatus", "documentHistoryCustomer", "documentHistoryDeal"].forEach((id) => { const select = qs<HTMLSelectElement>(`#${id}`); if (select) select.value = ""; });
  state.documentHistoryPage = 1;
  void loadDocumentHistory();
}

function populateQuoteHistoryFilters() {
  const customerOptions = qs<HTMLDataListElement>("#quoteHistoryCustomerOptions");
  const dealOptions = qs<HTMLDataListElement>("#quoteHistoryDealOptions");
  const countryOptions = qs<HTMLDataListElement>("#quoteHistoryCountryOptions");
  if (customerOptions) customerOptions.innerHTML = state.customers.map((item) => `<option value="${escapeHtml(quoteHistoryCustomerLabel(item))}">${escapeHtml(item.company)}</option>`).join("");
  if (dealOptions) dealOptions.innerHTML = quoteHistoryDeals().map((item) => `<option value="${escapeHtml(quoteHistoryDealLabel(item))}">${escapeHtml(item.title)}</option>`).join("");
  if (countryOptions) {
    const countries = [...new Set(state.customers.map((item) => item.country.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    countryOptions.innerHTML = countries.map((item) => `<option value="${escapeHtml(item)}"></option>`).join("");
  }
}

function quoteHistoryDeals() {
  return [...state.deals, ...state.closedDeals].filter((item, index, list) => list.findIndex((entry) => entry.id === item.id) === index);
}

function quoteHistoryCustomerLabel(customer: Customer) {
  return [customer.company, customer.country].filter(Boolean).join(" · ");
}

function quoteHistoryDealLabel(deal: Deal) {
  const customer = state.customers.find((item) => item.id === deal.customerId);
  return [deal.title, customer?.company].filter(Boolean).join(" · ");
}

function quoteHistoryParams() {
  const params = new URLSearchParams({ page: String(state.quoteHistoryPage), pageSize: "20", mode: state.quoteHistoryMode });
  const customerText = qs<HTMLInputElement>("#quoteHistoryCustomer")?.value.trim() || "";
  const dealText = qs<HTMLInputElement>("#quoteHistoryDeal")?.value.trim() || "";
  const customer = state.customers.find((item) => quoteHistoryCustomerLabel(item) === customerText || item.company === customerText);
  const deal = quoteHistoryDeals().find((item) => quoteHistoryDealLabel(item) === dealText || item.title === dealText);
  const fields: Array<[string, string]> = [
    ["q", qs<HTMLInputElement>("#quoteHistoryKeyword")?.value.trim() || ""],
    ["customerId", customer?.id || ""],
    ["customerSearch", customer ? "" : customerText],
    ["dealId", deal?.id || ""],
    ["dealSearch", deal ? "" : dealText],
    ["country", qs<HTMLInputElement>("#quoteHistoryCountry")?.value.trim() || ""],
    ["product", qs<HTMLInputElement>("#quoteHistoryProduct")?.value.trim() || ""],
    ["documentType", qs<HTMLSelectElement>("#quoteHistoryDocumentType")?.value || ""],
    ["currency", qs<HTMLSelectElement>("#quoteHistoryCurrency")?.value || ""],
    ["from", qs<HTMLInputElement>("#quoteHistoryFrom")?.value || ""],
    ["to", qs<HTMLInputElement>("#quoteHistoryTo")?.value || ""],
    ["recordId", state.quoteHistoryFocusId]
  ];
  fields.forEach(([key, value]) => { if (value) params.set(key, value); });
  return params;
}

export function setQuoteHistoryMode(mode: "records" | "product", reload = true) {
  state.quoteHistoryMode = mode;
  const recordsButton = qs<HTMLButtonElement>("#quoteHistoryRecordsModeButton");
  const productButton = qs<HTMLButtonElement>("#quoteHistoryProductModeButton");
  if (recordsButton) {
    recordsButton.classList.toggle("active", mode === "records");
    recordsButton.setAttribute("aria-selected", String(mode === "records"));
  }
  if (productButton) {
    productButton.classList.toggle("active", mode === "product");
    productButton.setAttribute("aria-selected", String(mode === "product"));
  }
  const label = qs<HTMLElement>("#quoteHistoryProductLabel");
  if (label) label.textContent = mode === "product" ? "单款产品 / 型号" : "产品 / 型号";
  const input = qs<HTMLInputElement>("#quoteHistoryProduct");
  if (input) input.placeholder = mode === "product" ? "输入产品名或型号，查看报价范围" : "产品或型号";
  if (reload) {
    state.quoteHistoryPage = 1;
    void loadQuoteHistory();
  }
}

function quoteHistoryProductSummary(record: QuoteHistoryRecord) {
  const names = record.items.slice(0, 2).map((item) => [item.product, item.model].filter(Boolean).join(" / "));
  return `${names.join("、")}${record.items.length > 2 ? ` 等 ${record.items.length} 项` : ""}`;
}

function openQuoteHistoryDetail(record: QuoteHistoryRecord) {
  openModal("报价变化详情", `
    <div class="quote-history-detail-head">
      <div><span>${record.documentType === "PI" ? "PI" : "报价单"} · ${escapeHtml(record.documentNumber)} · v${record.documentRevision}</span><h2>${escapeHtml(record.customerName)}</h2><p>${escapeHtml(record.dealTitle)} · ${escapeHtml(formatDateTime(record.quotedAt))} · ${escapeHtml(record.operatorName)}</p></div>
      <strong>${escapeHtml(formatDocumentMoney(record.totalAmount, record.currency))}</strong>
    </div>
    <div class="quote-history-change-list">${record.changes.map((change) => `<div><i></i><span>${escapeHtml(change)}</span></div>`).join("")}</div>
    <div class="table-wrap quote-history-detail-table"><table><thead><tr><th>产品</th><th>型号</th><th>数量</th><th>单价</th><th>小计</th></tr></thead><tbody>${record.items.map((item) => `<tr><td>${escapeHtml(item.product)}</td><td>${escapeHtml(item.model || "-")}</td><td>${item.quantity} ${escapeHtml(item.unit)}</td><td>${escapeHtml(formatDocumentMoney(item.unitPrice, record.currency))}</td><td><b>${escapeHtml(formatDocumentMoney(item.lineTotal, record.currency))}</b></td></tr>`).join("")}</tbody></table></div>
    <div class="quote-history-detail-foot"><span>${record.exportedAt ? `已于 ${escapeHtml(formatDateTime(record.exportedAt))} 正式导出` : "尚未正式导出"}</span><span>成交后仍永久保留此报价快照</span></div>
  `, `<button class="btn" id="quoteHistoryOpenDocument">打开原单据</button><button class="btn primary" data-modal-close>关闭</button>`);
  qs<HTMLButtonElement>("#quoteHistoryOpenDocument")?.addEventListener("click", () => {
    closeModal();
    const existing = state.tradeDocuments.find((item) => item.id === record.documentId);
    if (existing) {
      state.selectedDocumentId = existing.id;
      setDocumentWorkspaceMode("studio");
      renderTradeDocuments(state.tradeDocuments);
      return;
    }
    toast("原单据不在最近列表，可在历史单据中按编号查询");
    const keyword = qs<HTMLInputElement>("#documentHistoryKeyword");
    if (keyword) keyword.value = record.documentNumber;
    setDocumentWorkspaceMode("history");
  });
}

function openQuoteProductAnalysisDetail(row: QuoteProductAnalysisRow) {
  const records = (state.quoteProductAnalysis?.detailRecords || []).filter((record) => row.recordIds.includes(record.id));
  const itemMatches = (item: QuoteHistoryItem) => row.productId
    ? item.productId === row.productId
    : item.product.trim().toLowerCase() === row.product.trim().toLowerCase() && item.model.trim().toLowerCase() === row.model.trim().toLowerCase();
  openModal("单款产品报价明细", `
    <div class="quote-history-detail-head">
      <div><span>产品分析 · ${escapeHtml(row.country)} · ${escapeHtml(row.currency)}</span><h2>${escapeHtml([row.product, row.model].filter(Boolean).join(" / "))}</h2><p>共 ${row.quoteCount} 次报价 · 最近客户 ${escapeHtml(row.latestCustomerName || "未填写")}</p></div>
      <strong>${escapeHtml(formatDocumentMoney(row.minUnitPrice, row.currency))} - ${escapeHtml(formatDocumentMoney(row.maxUnitPrice, row.currency))}</strong>
    </div>
    <div class="quote-history-change-list"><div><i></i><span>平均单价：${escapeHtml(formatDocumentMoney(row.averageUnitPrice, row.currency))} · 最近单价：${escapeHtml(formatDocumentMoney(row.latestUnitPrice, row.currency))}</span></div><div><i></i><span>报价范围按 ${escapeHtml(row.country)} / ${escapeHtml(row.currency)} 单独统计，未混合不同国家或币种。</span></div></div>
    <div class="table-wrap quote-history-detail-table"><table><thead><tr><th>报价时间</th><th>客户 / 商机</th><th>单据</th><th>数量</th><th>单价</th><th>小计</th><th></th></tr></thead><tbody>${records.length ? records.map((record) => {
      const item = record.items.find(itemMatches);
      if (!item) return "";
      return `<tr><td>${escapeHtml(formatDateTime(record.quotedAt))}</td><td><div class="document-history-title"><b>${escapeHtml(record.customerName)}</b><span>${escapeHtml(record.dealTitle)}</span></div></td><td>${escapeHtml(record.documentNumber)}</td><td>${item.quantity} ${escapeHtml(item.unit)}</td><td>${escapeHtml(formatDocumentMoney(item.unitPrice, record.currency))}</td><td>${escapeHtml(formatDocumentMoney(item.lineTotal, record.currency))}</td><td><button class="btn" type="button" data-product-analysis-record="${escapeHtml(record.id)}">查看</button></td></tr>`;
    }).join("") : `<tr><td colspan="7" class="empty-cell">暂无可展开的报价明细</td></tr>`}</tbody></table></div>
    <div class="quote-history-detail-foot"><span>最近报价：${escapeHtml(row.latestQuotedAt ? formatDateTime(row.latestQuotedAt) : "-")}</span><span>单据号：${escapeHtml(row.latestDocumentNumber || "-")}</span></div>
  `, `<button class="btn primary" data-modal-close>关闭</button>`);
  qsa<HTMLButtonElement>("[data-product-analysis-record]").forEach((button) => button.addEventListener("click", () => {
    const record = records.find((item) => item.id === button.dataset.productAnalysisRecord);
    if (!record) return;
    closeModal();
    openQuoteHistoryDetail(record);
  }));
}

export async function loadQuoteHistory() {
  const rows = qs<HTMLElement>("#quoteHistoryRows");
  const productRows = qs<HTMLElement>("#quoteHistoryProductRows");
  if (rows) rows.innerHTML = `<tr><td colspan="8" class="empty-cell">正在查询报价历史</td></tr>`;
  if (productRows) productRows.innerHTML = `<tr><td colspan="9" class="empty-cell">正在分析单款产品报价</td></tr>`;
  try {
    const result = await api<QuoteHistoryResponse>(`/api/quote-history?${quoteHistoryParams().toString()}`);
    state.quoteHistoryPage = result.page;
    state.quoteHistoryPageCount = result.pageCount;
    state.quoteHistoryTotal = result.total;
    state.quoteProductAnalysis = result.productAnalysis;
    renderQuoteHistory(result);
    if (state.quoteHistoryFocusId && result.records[0]) {
      const record = result.records[0];
      state.quoteHistoryFocusId = "";
      openQuoteHistoryDetail(record);
    }
  } catch (error) {
    const message = escapeHtml(error instanceof Error ? error.message : "报价历史加载失败");
    if (rows) rows.innerHTML = `<tr><td colspan="8" class="empty-cell">${message}</td></tr>`;
    if (productRows) productRows.innerHTML = `<tr><td colspan="9" class="empty-cell">${message}</td></tr>`;
  }
}

function renderQuoteHistory(result: QuoteHistoryResponse) {
  const recordsPanel = qs<HTMLElement>("#quoteHistoryRecordsPanel");
  const productPanel = qs<HTMLElement>("#quoteHistoryProductPanel");
  if (recordsPanel) recordsPanel.hidden = state.quoteHistoryMode !== "records";
  if (productPanel) productPanel.hidden = state.quoteHistoryMode !== "product";
  if (state.quoteHistoryMode === "product") {
    renderQuoteProductAnalysis(result.productAnalysis);
    return;
  }
  const rows = qs<HTMLElement>("#quoteHistoryRows");
  const summary = qs<HTMLElement>("#quoteHistorySummary");
  const page = qs<HTMLElement>("#quoteHistoryPageText");
  const prev = qs<HTMLButtonElement>("#quoteHistoryPrevButton");
  const next = qs<HTMLButtonElement>("#quoteHistoryNextButton");
  const totals = Object.entries(result.summary.totals).map(([currency, amount]) => formatDocumentMoney(amount, currency)).join(" · ");
  if (summary) summary.innerHTML = `<b>${result.summary.recordCount}</b> 次报价 · ${result.summary.customerCount} 个客户 · ${result.summary.dealCount} 个商机 · ${result.summary.productCount} 个产品${totals ? `<span>历史报价累计（含版本）${escapeHtml(totals)}</span>` : ""}`;
  if (page) page.textContent = `第 ${state.quoteHistoryPage} / ${state.quoteHistoryPageCount} 页`;
  if (prev) prev.disabled = state.quoteHistoryPage <= 1;
  if (next) next.disabled = state.quoteHistoryPage >= state.quoteHistoryPageCount;
  if (!rows) return;
  rows.innerHTML = result.records.length ? result.records.map((record) => `<tr>
    <td><div class="document-history-title"><b>${escapeHtml(formatDateTime(record.quotedAt))}</b><span>${record.exportedAt ? "已正式导出" : "已保存"}</span></div></td>
    <td><div class="document-history-title"><b>${escapeHtml(record.customerName)}</b><span>${escapeHtml(record.dealTitle)}</span></div></td>
    <td><div class="document-history-title"><b>${record.documentType === "PI" ? "PI" : "报价单"}</b><span>${escapeHtml(record.documentNumber)} · v${record.documentRevision}</span></div></td>
    <td><div class="quote-history-product"><b>${escapeHtml(quoteHistoryProductSummary(record))}</b><span>${record.items.length} 项产品</span></div></td>
    <td><strong>${escapeHtml(formatDocumentMoney(record.totalAmount, record.currency))}</strong></td>
    <td>${escapeHtml(record.operatorName)}</td>
    <td><div class="quote-history-change"><b>${escapeHtml(record.changes[0] || "报价明细已同步")}</b>${record.changes.length > 1 ? `<span>另有 ${record.changes.length - 1} 项变化</span>` : ""}</div></td>
    <td><button class="btn" type="button" data-quote-history-open="${escapeHtml(record.id)}">详情</button></td>
  </tr>`).join("") : `<tr><td colspan="8" class="empty-cell">没有符合条件的报价记录</td></tr>`;
  qsa<HTMLButtonElement>("[data-quote-history-open]", rows).forEach((button) => button.addEventListener("click", () => {
    const record = result.records.find((item) => item.id === button.dataset.quoteHistoryOpen);
    if (record) openQuoteHistoryDetail(record);
  }));
}

function renderQuoteProductAnalysis(analysis: QuoteHistoryResponse["productAnalysis"]) {
  const summary = qs<HTMLElement>("#quoteHistoryProductSummary");
  const overview = qs<HTMLElement>("#quoteHistoryProductOverview");
  const rows = qs<HTMLElement>("#quoteHistoryProductRows");
  const items = analysis?.rows || [];
  if (summary) summary.innerHTML = `<b>${items.length}</b> 个产品 / 国家 / 币种组合 · ${analysis?.totalRecords || 0} 次报价<span>最低、最高、平均和最近单价均按币种独立统计</span>`;
  if (overview) {
    const overall = analysis?.overall || [];
    const countryRanges = analysis?.countryRanges || [];
    overview.innerHTML = `<div class="quote-analysis-overall"><span>当前筛选结果 · 整体报价范围</span>${overall.length ? overall.map((range) => `<div><b>${escapeHtml(formatDocumentMoney(range.minUnitPrice, range.currency))} - ${escapeHtml(formatDocumentMoney(range.maxUnitPrice, range.currency))}</b><small>${escapeHtml(range.currency)} · ${range.quoteCount} 次报价 · 覆盖 ${range.countryCount} 个国家 · 平均 ${escapeHtml(formatDocumentMoney(range.averageUnitPrice, range.currency))}</small></div>`).join("") : `<strong>暂无整体报价范围</strong>`}</div><div class="quote-analysis-countries"><span>不同国家报价范围</span>${countryRanges.length ? countryRanges.map((range) => `<div><b>${escapeHtml(range.country || "未填写国家")}</b><strong>${escapeHtml(formatDocumentMoney(range.minUnitPrice, range.currency))} - ${escapeHtml(formatDocumentMoney(range.maxUnitPrice, range.currency))}</strong><small>${escapeHtml(range.currency)} · ${range.quoteCount} 次 · 平均 ${escapeHtml(formatDocumentMoney(range.averageUnitPrice, range.currency))}</small></div>`).join("") : `<strong>暂无国家报价范围</strong>`}</div>`;
  }
  if (!rows) return;
  rows.innerHTML = items.length ? items.map((row, index) => `<tr>
    <td><div class="quote-history-product"><b>${escapeHtml([row.product, row.model].filter(Boolean).join(" / "))}</b><span>${row.quoteCount} 次历史报价</span></div></td>
    <td>${escapeHtml(row.country)}</td>
    <td>${escapeHtml(row.currency)}</td>
    <td>${row.quoteCount}</td>
    <td><strong>${escapeHtml(formatDocumentMoney(row.minUnitPrice, row.currency))}</strong></td>
    <td><strong>${escapeHtml(formatDocumentMoney(row.maxUnitPrice, row.currency))}</strong></td>
    <td>${escapeHtml(formatDocumentMoney(row.averageUnitPrice, row.currency))}</td>
    <td><div class="quote-history-product"><b>${escapeHtml(formatDocumentMoney(row.latestUnitPrice, row.currency))}</b><span>${escapeHtml(row.latestQuotedAt ? formatDateTime(row.latestQuotedAt) : "-")}</span></div></td>
    <td><button class="btn" type="button" data-quote-product-analysis-open="${index}">明细</button></td>
  </tr>`).join("") : `<tr><td colspan="9" class="empty-cell">请输入产品名或型号，再查询单款产品的历史报价范围</td></tr>`;
  qsa<HTMLButtonElement>("[data-quote-product-analysis-open]", rows).forEach((button) => button.addEventListener("click", () => {
    const row = items[Number(button.dataset.quoteProductAnalysisOpen)];
    if (row) openQuoteProductAnalysisDetail(row);
  }));
}

export function resetQuoteHistoryFilters() {
  ["quoteHistoryKeyword", "quoteHistoryProduct", "quoteHistoryFrom", "quoteHistoryTo", "quoteHistoryCustomer", "quoteHistoryDeal", "quoteHistoryCountry"].forEach((id) => { const input = qs<HTMLInputElement>(`#${id}`); if (input) input.value = ""; });
  ["quoteHistoryDocumentType", "quoteHistoryCurrency"].forEach((id) => { const select = qs<HTMLSelectElement>(`#${id}`); if (select) select.value = ""; });
  state.quoteHistoryFocusId = "";
  state.quoteHistoryPage = 1;
  void loadQuoteHistory();
}

export function openQuoteHistoryForDeal(dealId: string) {
  closeDealDrawer();
  activateNavView("documents");
  populateQuoteHistoryFilters();
  const deal = qs<HTMLInputElement>("#quoteHistoryDeal");
  const selectedDeal = quoteHistoryDeals().find((item) => item.id === dealId);
  if (deal) deal.value = selectedDeal ? quoteHistoryDealLabel(selectedDeal) : "";
  setQuoteHistoryMode("records", false);
  state.quoteHistoryPage = 1;
  state.quoteHistoryFocusId = "";
  setDocumentWorkspaceMode("quote-history");
}

export function fillDocumentEditor(document: TradeDocument) {
  setDocumentType(document.type);
  renderDocumentWorkflow(document);
  const values: Record<string, string> = {
    docTitleInput: document.title,
    docNumberInput: document.number,
    docIssueDateInput: document.issueDate,
    docTemplateInput: document.templateStyle,
    docLanguageInput: document.language || "EN",
    docThemeInput: DOC_PINNED_TEMPLATE_STYLES.has(document.templateStyle) ? "rose" : (document.templateStyle || "rose"),
    docBuyerInput: document.buyer,
    docBuyerContactInput: document.buyerContact,
    docBuyerAddressInput: document.buyerAddress,
    docSellerInput: document.seller,
    docBrandMarkTextInput: document.brandMarkText || "",
    docSellerContactInput: document.sellerContact || "",
    docSellerPhoneInput: document.sellerPhone || "",
    docSellerEmailInput: document.sellerEmail || "",
    docSellerWebsiteInput: document.sellerWebsite || "",
    docSellerTaxNoInput: document.sellerTaxNo || "",
    docCurrencyInput: document.currency,
    docSellerAddressInput: document.sellerAddress,
    docIncotermInput: document.incoterm,
    docShippingInput: document.shippingMethod,
    docPortLoadingInput: document.portLoading,
    docPortDischargeInput: document.portDischarge,
    docValidityInput: document.validityDate,
    docPaymentInput: document.paymentTerm,
    docBankInput: document.bankInfo,
    docNotesInput: document.notes
  };
  const shippingCost = document.items.find((item) => item.lineType === "shipping_cost")?.unitPrice || 0;
  values.docShippingCostInput = shippingCost ? String(shippingCost) : "";
  Object.entries(values).forEach(([id, value]) => {
    const input = qs<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`);
    if (input) input.value = value || "";
  });
  renderDocumentItems(document.items);
  syncShippingCostLabel();
  renderDocThemeSwatches(document.templateStyle);
  renderDocumentPreview(collectDocumentDraft());
}

function applySellerProfileToEditor(profile: DocumentLetterhead, reason: string) {
  // PO（采购订单）里的公司档案代表「我方抬头」：Logo / 公司名 / 印章 / 签字；
  // 而 seller 字段是 Vendor（供应商）。PO 下切档案不能把供应商名字覆盖成我方资料。
  if (currentDocumentType() === "PO") {
    const select = qs<HTMLSelectElement>("#docSellerProfileInput");
    if (select) select.value = profile.id;
    const stamp = qs<HTMLInputElement>("#docStampIdInput");
    if (stamp) stamp.value = profile.stampId || "";
    const signature = qs<HTMLInputElement>("#docSignatureIdInput");
    if (signature) signature.value = profile.signatureId || "";
    const hint = qs<HTMLElement>("#docSellerMatchHint");
    if (hint) hint.textContent = `${reason} · PO 只用它取抬头 Logo 与签章`;
    renderDocumentPreview(collectDocumentDraft());
    return;
  }
  const values: Record<string, string> = {
    docSellerInput: profile.companyName,
    docSellerAddressInput: profile.address,
    docSellerContactInput: profile.contact || "",
    docSellerPhoneInput: profile.phone,
    docSellerEmailInput: profile.email,
    docSellerWebsiteInput: profile.website,
    docSellerTaxNoInput: profile.taxNo || "",
    docBankInput: profile.bankInfo || state.documentDefaultProfile?.bankInfo || "",
    docStampIdInput: profile.stampId || "",
    docSignatureIdInput: profile.signatureId || ""
  };
  Object.entries(values).forEach(([id, value]) => {
    const input = qs<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    if (input) input.value = value;
  });
  const select = qs<HTMLSelectElement>("#docSellerProfileInput");
  if (select) select.value = profile.id;
  const hint = qs<HTMLElement>("#docSellerMatchHint");
  if (hint) hint.textContent = reason;
  renderDocumentPreview(collectDocumentDraft());
}

function applyFallbackSellerToEditor(reason = "使用团队兜底卖方资料") {
  // 同 applySellerProfileToEditor：PO 下 Vendor 是供应商，不能被兜底资料覆盖。
  if (currentDocumentType() === "PO") {
    const select = qs<HTMLSelectElement>("#docSellerProfileInput");
    if (select) select.value = "";
    const brandMark = qs<HTMLInputElement>("#docBrandMarkTextInput");
    if (brandMark) brandMark.value = state.documentDefaultProfile?.brandMarkText || "";
    const hint = qs<HTMLElement>("#docSellerMatchHint");
    if (hint) hint.textContent = `${reason} · PO 只用兜底资料取抬头 Logo 与签章`;
    renderDocumentPreview(collectDocumentDraft());
    return;
  }
  const profile = state.documentDefaultProfile;
  const values: Record<string, string> = {
    docSellerInput: profile?.seller || "",
    docBrandMarkTextInput: profile?.brandMarkText || "",
    docSellerAddressInput: profile?.sellerAddress || "",
    docSellerContactInput: profile?.sellerContact || "",
    docSellerPhoneInput: profile?.sellerPhone || "",
    docSellerEmailInput: profile?.sellerEmail || "",
    docSellerWebsiteInput: profile?.sellerWebsite || "",
    docSellerTaxNoInput: profile?.sellerTaxNo || "",
    docBankInput: profile?.bankInfo || "",
    docStampIdInput: profile?.stampId || "",
    docSignatureIdInput: profile?.signatureId || ""
  };
  Object.entries(values).forEach(([id, value]) => {
    const input = qs<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    if (input) input.value = value;
  });
  const select = qs<HTMLSelectElement>("#docSellerProfileInput");
  if (select) select.value = "";
  const hint = qs<HTMLElement>("#docSellerMatchHint");
  if (hint) hint.textContent = reason;
  renderDocumentPreview(collectDocumentDraft());
}

export function applyMatchedSellerToEditor(customer?: Customer, deal?: Deal, type = currentDocumentType()) {
  const currency = qs<HTMLSelectElement>("#docCurrencyInput")?.value || deal?.currency || state.documentDefaultProfile?.currency || "USD";
  const profile = matchedSellerProfile(customer, currency, type);
  if (!profile) {
    applyFallbackSellerToEditor("未命中卖方公司规则，已使用兜底卖方资料");
    return;
  }
  applySellerProfileToEditor(profile, `已自动匹配 · ${sellerProfileMatchReason(profile, customer, currency, type)}`);
}

function renderDocumentWorkflow(document: TradeDocument) {
  const customerSelect = qs<HTMLSelectElement>("#docCustomerInput");
  const dealSelect = qs<HTMLSelectElement>("#docDealInput");
  const sellerSelect = qs<HTMLSelectElement>("#docSellerProfileInput");
  if (customerSelect) {
    customerSelect.innerHTML = `<option value="">未关联客户</option>${state.customers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.company)}${customer.country ? ` · ${escapeHtml(customer.country)}` : ""}</option>`).join("")}`;
    customerSelect.value = document.customerId || "";
  }
  if (dealSelect) {
    const visibleDeals = state.deals.filter((deal) => !document.customerId || deal.customerId === document.customerId);
    dealSelect.innerHTML = `<option value="">未关联商机</option>${visibleDeals.map((deal) => `<option value="${escapeHtml(deal.id)}">${escapeHtml(deal.title)} · ${escapeHtml(deal.stage)}</option>`).join("")}`;
    dealSelect.value = document.dealId || "";
  }
  if (sellerSelect) {
    const selected = state.documentAssets.letterheads.find((item) => item.id === document.letterheadId);
    sellerSelect.innerHTML = `<option value="">使用兜底卖方资料</option>${selected && !selected.enabled ? `<option value="${escapeHtml(selected.id)}">${escapeHtml(selected.name)} · 已停用历史档案</option>` : ""}${state.documentAssets.letterheads.filter((item) => item.enabled).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.companyName)}</option>`).join("")}`;
    sellerSelect.value = document.letterheadId || "";
    sellerSelect.onchange = () => {
      const profile = state.documentAssets.letterheads.find((item) => item.id === sellerSelect.value && item.enabled);
      if (profile) applySellerProfileToEditor(profile, "已人工选择卖方公司");
      else applyFallbackSellerToEditor();
    };
  }
  const stampInput = qs<HTMLInputElement>("#docStampIdInput");
  const signatureInput = qs<HTMLInputElement>("#docSignatureIdInput");
  if (stampInput) stampInput.value = document.stampId || "";
  if (signatureInput) signatureInput.value = document.signatureId || "";
  const selectedProfile = state.documentAssets.letterheads.find((item) => item.id === document.letterheadId);
  const matchHint = qs<HTMLElement>("#docSellerMatchHint");
  if (matchHint) matchHint.textContent = selectedProfile ? `当前卖方 · ${selectedProfile.name}` : "使用团队兜底卖方资料";
  const status = qs<HTMLElement>("#docStatusBadge");
  if (status) status.textContent = `${documentStatusText(document.status)} · v${document.revision || 1}`;
  const locked = document.status === "approved" || document.status === "exported";
  const pending = document.status === "pending_approval";
  const buttonState: Record<string, boolean> = {
    documentSubmitApprovalButton: locked || pending,
    documentApproveButton: !pending,
    documentRejectButton: !pending,
    documentSendButton: document.id === "__new__",
    documentNewRevisionButton: !locked
  };
  Object.entries(buttonState).forEach(([id, disabled]) => {
    const button = qs<HTMLButtonElement>(`#${id}`);
    if (button) button.disabled = disabled;
  });
  const history = qs<HTMLElement>("#documentHistory");
  if (history) {
    const rows = [
      ...(document.audits || []).slice(-12).reverse().map((audit) => `<div class="doc-history-item"><span><b>${escapeHtml(audit.field)}</b>：${escapeHtml(audit.oldValue || "空")} → ${escapeHtml(audit.newValue || "空")}</span><small>${escapeHtml(audit.operatorName)} · ${escapeHtml(audit.createdAt.slice(0, 16).replace("T", " "))}</small></div>`),
      ...(document.sendRecords || []).slice(-8).reverse().map((record) => `<div class="doc-history-item"><span><b>发送</b>：${escapeHtml(record.channel)} · ${escapeHtml(record.recipient)}</span><small>${escapeHtml(record.operatorName)} · ${escapeHtml(record.createdAt.slice(0, 16).replace("T", " "))}</small></div>`)
    ];
    history.innerHTML = rows.length ? `<div class="doc-history-list">${rows.join("")}</div>` : `<p>暂无记录</p>`;
  }
}

export function applyDocumentCustomerDefaults(customerId: string, deal?: Deal) {
  const customer = state.customers.find((item) => item.id === customerId);
  if (!customer) {
    applyMatchedSellerToEditor(undefined, deal);
    return;
  }
  const values: Record<string, string> = {
    docBuyerInput: customerDocumentName(customer),
    docBuyerAddressInput: customer.billingAddress?.trim() || "",
    docBuyerContactInput: customer.documentContact?.trim() || customer.contact,
    docIncotermInput: customer.defaultIncoterm?.trim() || "DAP",
    docPaymentInput: customer.defaultPaymentTerm?.trim() || "T/T 100% in advance",
    docPortDischargeInput: customer.defaultPortDischarge?.trim() || ""
  };
  Object.entries(values).forEach(([id, value]) => {
    const input = qs<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    if (input) input.value = value;
  });
  applyMatchedSellerToEditor(customer, deal);
  renderDocumentPreview(collectDocumentDraft());
}

export function updateActiveDocument(document: TradeDocument) {
  state.tradeDocuments = state.tradeDocuments.map((item) => item.id === document.id ? document : item);
  state.selectedDocumentId = document.id;
  renderTradeDocuments(state.tradeDocuments);
}

export function submitDocumentApproval() {
  const document = activeTradeDocument();
  if (!document.id || document.id === "__new__") {
    toast("请先保存单据，再提交审批", "error");
    return;
  }
  openModal("提交单据审批", `
    <div class="form-field full"><label>审批说明</label><textarea id="documentApprovalSubmitNote" rows="4">请确认客户、付款条款和交期</textarea><small>说明将随单据版本进入审批记录。</small></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmDocumentApprovalSubmitButton">提交审批</button>`);
  qs<HTMLButtonElement>("#confirmDocumentApprovalSubmitButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const note = qs<HTMLTextAreaElement>("#documentApprovalSubmitNote")?.value.trim() || "";
    setButtonPending(button, true, "提交审批", "提交中");
    try {
      const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${document.id}/submit-approval`, { method: "POST", body: JSON.stringify({ note }) });
      closeModal();
      updateActiveDocument(result.document);
      toast("单据已提交审批");
    } catch (error) {
      setButtonPending(button, false, "提交审批", "提交中");
      toast(error instanceof Error ? error.message : "提交审批失败", "error");
    }
  });
}

export async function approveActiveDocument() {
  const document = activeTradeDocument();
  if (!document.id || document.status !== "pending_approval") return;
  const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${document.id}/approve`, { method: "POST", body: JSON.stringify({}) });
  updateActiveDocument(result.document);
  toast("单据已审批通过");
}

export function rejectActiveDocument() {
  const document = activeTradeDocument();
  if (!document.id || document.status !== "pending_approval") return;
  openModal("驳回单据审批", `
    <div class="form-field full"><label>驳回原因</label><textarea id="documentApprovalRejectNote" rows="4" placeholder="例如：请补充付款条款并确认交期"></textarea><small>业务员修改单据后可以重新提交审批。</small></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn danger" id="confirmDocumentApprovalRejectButton">确认驳回</button>`);
  qs<HTMLButtonElement>("#confirmDocumentApprovalRejectButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const note = qs<HTMLTextAreaElement>("#documentApprovalRejectNote")?.value.trim() || "";
    if (!note) {
      toast("驳回必须填写原因", "error");
      qs<HTMLTextAreaElement>("#documentApprovalRejectNote")?.focus();
      return;
    }
    setButtonPending(button, true, "确认驳回", "处理中");
    try {
      const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${document.id}/reject`, { method: "POST", body: JSON.stringify({ note }) });
      closeModal();
      updateActiveDocument(result.document);
      toast("单据已驳回，业务员可修改后重新提交");
    } catch (error) {
      setButtonPending(button, false, "确认驳回", "处理中");
      toast(error instanceof Error ? error.message : "驳回审批失败", "error");
    }
  });
}

export async function sendActiveDocument() {
  const document = activeTradeDocument();
  if (!document.id || document.id === "__new__") {
    toast("请先保存单据，再记录发送", "error");
    return;
  }
  openModal("记录发送单据", `
    <div class="form-grid">
      <div class="form-field"><label>发送渠道</label><select id="documentSendChannelInput"><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="wechat">微信</option><option value="manual">人工发送</option></select></div>
      <div class="form-field"><label>发送对象</label><input id="documentSendRecipientInput" value="${escapeHtml(document.buyerContact || document.buyer)}" placeholder="邮箱、手机号或联系人"></div>
      <div class="form-field full"><label>发送说明</label><textarea id="documentSendMessageInput" placeholder="例如：Please review the attached PI."></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmDocumentSendButton">保存发送记录</button>`);
  qs("#confirmDocumentSendButton")?.addEventListener("click", async () => {
    const recipient = qs<HTMLInputElement>("#documentSendRecipientInput")?.value.trim() || "";
    const channel = qs<HTMLSelectElement>("#documentSendChannelInput")?.value || "manual";
    const message = qs<HTMLTextAreaElement>("#documentSendMessageInput")?.value.trim() || "";
    if (!recipient) {
      toast("请填写发送对象", "error");
      return;
    }
    const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${document.id}/send`, { method: "POST", body: JSON.stringify({ channel, recipient, message }) });
    closeModal();
    updateActiveDocument(result.document);
    toast("发送记录已保存");
  });
}

export async function createDocumentRevision() {
  const document = activeTradeDocument();
  if (!document.id || document.id === "__new__") {
    toast("请先保存单据，再另存新版本", "error");
    return;
  }
  const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${document.id}/revision`, { method: "POST", body: JSON.stringify({}) });
  state.tradeDocuments = [result.document, ...state.tradeDocuments];
  state.selectedDocumentId = result.document.id;
  renderTradeDocuments(state.tradeDocuments);
  toast(`已创建 v${result.document.revision} 新版本`);
}

export function setDocumentType(type: "PI" | "CI" | "PO" | "CUSTOMS" | "PL" | "CONTRACT" | "QUOTATION" | "COO" | "SHIPPING") {
  qsa<HTMLButtonElement>("#documentTypeTabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.docType === type);
  });
}

export function currentDocumentType(): "PI" | "CI" | "PO" | "CUSTOMS" | "PL" | "CONTRACT" | "QUOTATION" | "COO" | "SHIPPING" {
  const activeButton = qs<HTMLButtonElement>("#documentTypeTabs button.active");
  const docType = activeButton?.dataset.docType as "PI" | "CI" | "PO" | "CUSTOMS" | "PL" | "CONTRACT" | "QUOTATION" | "COO" | "SHIPPING" | undefined;
  return docType || "PI";
}

function renderDocumentItems(items: TradeDocumentItem[]) {
  const box = qs<HTMLElement>("#documentItemsEditor");
  if (!box) return;
  items = items.filter((item) => item.lineType !== "shipping_cost");
  const productOptions = (selectedId = "") => `<option value="">手工填写</option>${state.products.map((product) => `<option value="${escapeHtml(product.id)}" ${product.id === selectedId ? "selected" : ""}>${escapeHtml(product.nameEn || product.nameZh)}${product.model ? ` · ${escapeHtml(product.model)}` : ""}</option>`).join("")}`;
  box.innerHTML = items.map((item, index) => {
    const imageUrl = controlledDocumentImageUrl(item.imageUrl);
    return `
    <div class="doc-item-grid" data-doc-item="${escapeHtml(item.id || `item_${index}`)}" data-product-id="${escapeHtml(item.productId || "")}" data-image-url="${escapeHtml(imageUrl)}">
      <div class="doc-item-image">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(item.product || `商品 ${index + 1}`)}">` : `<span>无图</span>`}</div>
      <label data-doc-size="product-select"><span>产品库</span><select data-doc-product-select>${productOptions(item.productId || "")}</select></label>
      <label data-doc-size="name"><span>品名</span><input data-doc-field="product" value="${escapeHtml(item.product)}"></label>
      <label data-doc-size="model"><span>型号</span><input data-doc-field="model" value="${escapeHtml(item.model)}"></label>
      <label data-doc-size="material"><span>材质 Material</span><input data-doc-field="material" value="${escapeHtml(item.material || "")}"></label>
      <label data-doc-size="finish"><span>后处理 Finish</span><input data-doc-field="finish" value="${escapeHtml(item.finish || "")}"></label>
      <label data-doc-size="code"><span>HS Code</span><input data-doc-field="hsCode" value="${escapeHtml(item.hsCode)}"></label>
      <label data-doc-size="short"><span>数量</span><input data-doc-field="quantity" type="number" min="0" value="${item.quantity}"></label>
      <label data-doc-size="short"><span>单位</span><input data-doc-field="unit" value="${escapeHtml(item.unit)}"></label>
      <label data-doc-size="price"><span>单价</span><input data-doc-field="unitPrice" type="number" min="0" step="0.01" value="${item.unitPrice}"></label>
      <label data-doc-size="country"><span>原产国</span><input data-doc-field="originCountry" value="${escapeHtml(item.originCountry)}"></label>
      <label data-doc-size="short"><span>重量kg</span><input data-doc-field="weightKg" type="number" min="0" step="0.01" value="${item.weightKg}"></label>
      <label data-doc-size="short"><span>包装</span><input data-doc-field="packageCount" type="number" min="0" value="${item.packageCount}"></label>
      <button class="doc-item-remove" type="button" title="删除明细">×</button>
    </div>`;
  }).join("");
  qsa<HTMLSelectElement>("[data-doc-product-select]", box).forEach((select) => select.addEventListener("change", () => {
    const row = select.closest<HTMLElement>(".doc-item-grid");
    const product = state.products.find((item) => item.id === select.value);
    if (!row) return;
    row.dataset.productId = product?.id || "";
    const imageUrl = controlledDocumentImageUrl(product?.imageUrl);
    row.dataset.imageUrl = imageUrl;
    const image = row.querySelector<HTMLElement>(".doc-item-image");
    if (image) image.innerHTML = imageUrl
      ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(product?.nameEn || product?.nameZh || "商品")}">`
      : `<span>无图</span>`;
    if (product) {
      const set = (name: string, value: string | number) => {
        const input = row.querySelector<HTMLInputElement>(`[data-doc-field="${name}"]`);
        if (input) input.value = String(value ?? "");
      };
      set("product", product.nameEn || product.nameZh);
      set("model", product.model || "");
      set("hsCode", product.hsCode || "");
      set("unit", product.unit || "PCS");
      set("unitPrice", product.price || 0);
      set("weightKg", product.packWeight || 0);
    }
    renderDocumentPreview(collectDocumentDraft());
  }));
  qsa<HTMLInputElement>("[data-doc-field]", box).forEach((input) => input.addEventListener("input", () => renderDocumentPreview(collectDocumentDraft())));
  qsa<HTMLButtonElement>(".doc-item-remove", box).forEach((button) => {
    button.addEventListener("click", () => {
      button.closest(".doc-item-grid")?.remove();
      if (!qsa(".doc-item-grid", box).length) addDocumentItem();
      renderDocumentPreview(collectDocumentDraft());
    });
  });
}

function collectDocumentItems(): TradeDocumentItem[] {
  return qsa<HTMLElement>("#documentItemsEditor .doc-item-grid").map((row, index) => {
    const field = (name: string) => row.querySelector<HTMLInputElement>(`[data-doc-field="${name}"]`)?.value.trim() || "";
    const numberField = (name: string) => Number(row.querySelector<HTMLInputElement>(`[data-doc-field="${name}"]`)?.value || 0);
    return {
      id: row.dataset.docItem || `item_${index}`,
      lineType: "product" as const,
      productId: row.dataset.productId || "",
      imageUrl: row.dataset.imageUrl || "",
      product: field("product"),
      model: field("model"),
      material: field("material"),
      finish: field("finish"),
      hsCode: field("hsCode"),
      quantity: numberField("quantity"),
      unit: field("unit") || "PCS",
      unitPrice: numberField("unitPrice"),
      originCountry: field("originCountry"),
      weightKg: numberField("weightKg"),
      packageCount: Math.round(numberField("packageCount"))
    };
  });
}

function shippingCostLabel(language = qs<HTMLSelectElement>("#docLanguageInput")?.value || "EN") {
  return ({
    EN: "Shipping Cost",
    ES: "Coste de envío",
    RU: "Стоимость доставки",
    AR: "تكلفة الشحن",
    ZH: "运费"
  } as Record<string, string>)[language] || "Shipping Cost";
}

export function syncShippingCostLabel() {
  const label = qs<HTMLElement>("#docShippingCostLabel");
  if (label) label.textContent = shippingCostLabel();
}

function documentItemDisplayName(document: TradeDocument, item: TradeDocumentItem) {
  return item.lineType === "shipping_cost" ? shippingCostLabel(document.language) : item.product;
}

export function collectDocumentDraft(): TradeDocument {
  const existing = state.tradeDocuments.find((document) => document.id === state.selectedDocumentId);
  const items = collectDocumentItems();
  const shippingCost = Number(qs<HTMLInputElement>("#docShippingCostInput")?.value || 0);
  if (shippingCost > 0) {
    items.push({
      id: "shipping_cost",
      lineType: "shipping_cost",
      product: shippingCostLabel(),
      model: "",
      hsCode: "",
      quantity: 1,
      unit: "LOT",
      unitPrice: shippingCost,
      originCountry: "",
      weightKg: 0,
      packageCount: 0
    });
  }
  return {
    id: existing?.id || state.selectedDocumentId || "__new__",
    customerId: qs<HTMLSelectElement>("#docCustomerInput")?.value || existing?.customerId || "",
    dealId: qs<HTMLSelectElement>("#docDealInput")?.value || existing?.dealId || "",
    revision: existing?.revision || 1,
    derivedFromDocumentId: existing?.derivedFromDocumentId,
    derivedFromType: existing?.derivedFromType,
    type: currentDocumentType(),
    title: qs<HTMLInputElement>("#docTitleInput")?.value.trim() || "未命名单据",
    number: qs<HTMLInputElement>("#docNumberInput")?.value.trim() || `DOC-${Date.now()}`,
    issueDate: qs<HTMLInputElement>("#docIssueDateInput")?.value || todayDateInput(),
    buyer: qs<HTMLInputElement>("#docBuyerInput")?.value.trim() || "",
    buyerAddress: qs<HTMLInputElement>("#docBuyerAddressInput")?.value.trim() || "",
    buyerContact: qs<HTMLInputElement>("#docBuyerContactInput")?.value.trim() || "",
    seller: qs<HTMLInputElement>("#docSellerInput")?.value.trim() || "",
    brandMarkText: qs<HTMLInputElement>("#docBrandMarkTextInput")?.value.trim() || "",
    sellerAddress: qs<HTMLInputElement>("#docSellerAddressInput")?.value.trim() || "",
    sellerContact: qs<HTMLInputElement>("#docSellerContactInput")?.value.trim() || "",
    sellerPhone: qs<HTMLInputElement>("#docSellerPhoneInput")?.value.trim() || "",
    sellerEmail: qs<HTMLInputElement>("#docSellerEmailInput")?.value.trim() || "",
    sellerWebsite: qs<HTMLInputElement>("#docSellerWebsiteInput")?.value.trim() || "",
    sellerTaxNo: qs<HTMLInputElement>("#docSellerTaxNoInput")?.value.trim() || "",
    currency: qs<HTMLSelectElement>("#docCurrencyInput")?.value || "USD",
    incoterm: qs<HTMLSelectElement>("#docIncotermInput")?.value || "DAP",
    paymentTerm: qs<HTMLInputElement>("#docPaymentInput")?.value.trim() || "",
    shippingMethod: qs<HTMLSelectElement>("#docShippingInput")?.value || "Sea freight",
    portLoading: qs<HTMLInputElement>("#docPortLoadingInput")?.value.trim() || "",
    portDischarge: qs<HTMLInputElement>("#docPortDischargeInput")?.value.trim() || "",
    validityDate: qs<HTMLInputElement>("#docValidityInput")?.value || "",
    bankInfo: qs<HTMLTextAreaElement>("#docBankInput")?.value.trim() || "",
    notes: qs<HTMLTextAreaElement>("#docNotesInput")?.value.trim() || "",
    templateStyle: (qs<HTMLSelectElement>("#docTemplateInput")?.value as TradeDocument["templateStyle"]) || (qs<HTMLSelectElement>("#docThemeInput")?.value as TradeDocument["templateStyle"]) || "rose",
    language: (qs<HTMLSelectElement>("#docLanguageInput")?.value as TradeDocument["language"]) || "EN",
    status: existing?.status || "draft",
    audits: existing?.audits || [],
    sendRecords: existing?.sendRecords || [],
    letterheadId: qs<HTMLSelectElement>("#docSellerProfileInput")?.value ?? existing?.letterheadId ?? "",
    stampId: qs<HTMLInputElement>("#docStampIdInput")?.value ?? existing?.stampId ?? "",
    signatureId: qs<HTMLInputElement>("#docSignatureIdInput")?.value ?? existing?.signatureId ?? "",
    includeProductImages: existing?.includeProductImages || false,
    letterheadSnapshot: existing?.letterheadSnapshot,
    stampSnapshot: existing?.stampSnapshot,
    signatureSnapshot: existing?.signatureSnapshot,
    updatedAt: new Date().toISOString(),
    items
  };
}

function documentEditableSnapshot(document: TradeDocument) {
  return {
    customerId: document.customerId || "",
    dealId: document.dealId || "",
    type: document.type,
    title: document.title || "",
    number: document.number || "",
    issueDate: document.issueDate || "",
    buyer: document.buyer || "",
    buyerAddress: document.buyerAddress || "",
    buyerContact: document.buyerContact || "",
    seller: document.seller || "",
    brandMarkText: document.brandMarkText || "",
    sellerAddress: document.sellerAddress || "",
    sellerContact: document.sellerContact || "",
    sellerPhone: document.sellerPhone || "",
    sellerEmail: document.sellerEmail || "",
    sellerWebsite: document.sellerWebsite || "",
    sellerTaxNo: document.sellerTaxNo || "",
    currency: document.currency || "",
    incoterm: document.incoterm || "",
    paymentTerm: document.paymentTerm || "",
    shippingMethod: document.shippingMethod || "",
    portLoading: document.portLoading || "",
    portDischarge: document.portDischarge || "",
    validityDate: document.validityDate || "",
    bankInfo: document.bankInfo || "",
    notes: document.notes || "",
    language: document.language || "EN",
    templateStyle: document.templateStyle || "rose",
    letterheadId: document.letterheadId || "",
    stampId: document.stampId || "",
    signatureId: document.signatureId || "",
    includeProductImages: Boolean(document.includeProductImages),
    items: (document.items || []).map((item) => ({
      id: item.id || "",
      lineType: item.lineType || "product",
      productId: item.productId || "",
      imageUrl: item.imageUrl || "",
      product: item.product || "",
      model: item.model || "",
      material: item.material || "",
      finish: item.finish || "",
      hsCode: item.hsCode || "",
      quantity: Number(item.quantity) || 0,
      unit: item.unit || "",
      unitPrice: Number(item.unitPrice) || 0,
      originCountry: item.originCountry || "",
      weightKg: Number(item.weightKg) || 0,
      packageCount: Number(item.packageCount) || 0
    }))
  };
}

function documentDraftHasChanges(draft: TradeDocument, source: TradeDocument) {
  return JSON.stringify(documentEditableSnapshot(draft)) !== JSON.stringify(documentEditableSnapshot(source));
}

async function saveLockedDocumentDraftAsRevision(source: TradeDocument, draft: TradeDocument) {
  if (draft.customerId !== source.customerId || draft.dealId !== source.dealId) {
    throw new Error("已审批或已导出的单据不能更换客户或商机，请先恢复原关联后再导出");
  }
  const revisionResult = await api<{ document: TradeDocument }>(`/api/trade-documents/${source.id}/revision`, {
    method: "POST",
    body: JSON.stringify({})
  });
  const revision = revisionResult.document;
  const saved = await api<{
    document: TradeDocument;
    dealSync?: { deal: Deal; history: QuoteHistoryRecord; changes: string[]; changed: boolean } | null;
  }>(`/api/trade-documents/${revision.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...draft,
      customerId: revision.customerId,
      dealId: revision.dealId,
      revision: revision.revision,
      number: revision.number,
      title: draft.title === source.title ? revision.title : draft.title,
      status: "ready"
    })
  });
  state.tradeDocuments = [saved.document, ...state.tradeDocuments.filter((document) => document.id !== saved.document.id)];
  state.selectedDocumentId = saved.document.id;
  if (saved.dealSync?.deal) {
    state.deals = state.deals.map((deal) => deal.id === saved.dealSync!.deal.id ? saved.dealSync!.deal : deal);
    await refreshDealsData(false);
    toast(`新版本已保存，商机已同步 ${saved.dealSync.deal.items?.length || 0} 项产品及 ${formatDocumentMoney(saved.dealSync.deal.amount, saved.dealSync.deal.currency)}`);
  }
  renderTradeDocuments(state.tradeDocuments);
  return saved.document;
}

const DOC_I18N: Record<string, Record<string, string>> = {
  EN: { seller:"Seller", buyer:"Buyer", incoterm:"Incoterm", payment:"Payment", shipment:"Shipment", validity:"Validity", portLoading:"Port of Loading", portDischarge:"Port of Discharge", docType:"Document Type", status:"Status", description:"Description", model:"Model", hsCode:"HS Code", qty:"Qty", unitPrice:"Unit Price", amount:"Amount", origin:"Origin", weight:"Weight", pkgs:"Pkgs", shippingCost:"Shipping Cost", subTotal:"Subtotal", vat:"VAT", totalAmount:"Total Amount", bankNotes:"Bank / Notes", authorized:"AUTHORIZED", no:"No.", date:"Date", currency:"Currency", netWeight:"Net Weight", grossWeight:"Gross Weight", totalPackages:"Total Packages", totalWeight:"Total Weight", countryOfOrigin:"Country of Origin", signedBy:"Signed By", dateOfIssue:"Date of Issue", vessel:"Vessel", blNo:"B/L No.", container:"Container", eta:"ETA", etd:"ETD", marks:"Marks & Numbers", descriptionOfGoods:"Description of Goods", quantity:"Quantity", unit:"Unit", packageType:"Package Type", terms:"Terms & Conditions", signatures:"Signatures", sellerSign:"For and on behalf of Seller", buyerSign:"For and on behalf of Buyer", thisIsToCertify:"This is to certify that the goods mentioned in this invoice originated in", issuedUnder:"Issued under", referenceNo:"Reference No.", subject:"Subject", dearSirs:"Dear Sirs,", weArePleased:"We are pleased to inform you that the following shipment has been dispatched:", regards:"Best Regards", packingListDesc:"Packing List", contractDesc:"Sales Contract", quotationDesc:"Quotation", quoteValidUntil:"Quote Valid Until", quotedBy:"Quoted By", acceptedBy:"Accepted By", quoteTerms:"Quotation Terms", priceSubjectToChange:"Prices are subject to final confirmation. This quotation expires after the validity date.", revisionLabel:"Rev.", quoteNumber:"Quote No.", cooDesc:"Certificate of Origin", shippingDesc:"Shipping Advice", proformaDesc:"Proforma Invoice", poDesc:"Purchase Order", commercialDesc:"Commercial Invoice", customsTitle:"Customs Clearance Documents", customsSub:"Customs Declaration Package", exportDate:"Export Date", customsDecl:"Customs Declaration", declElements:"Declaration Elements", invoice:"Invoice", packingListShort:"Packing List", contractDoc:"Contract", authorization:"Power of Attorney", fillingGuide:"Filing Guide", shipperInfo:"Shipper Information", consigneeInfo:"Consignee Information", companyName:"Company Name", companyAddress:"Company Address", contactInfo:"Contact", transportInfo:"Transport & Logistics", totalGrossWeight:"Total Gross Weight", packageCount:"Package Count", tradeTerms:"Trade Terms", goodsList:"Goods Detail List", itemsUnit:"items", goodsName:"Goods Name", paymentTradeTerms:"Payment & Trade Terms", paymentCondition:"Payment Terms", customsNotice:"Please verify HS codes, brand/model, weight and other customs declaration elements" },
  ES: { seller:"Vendedor", buyer:"Comprador", incoterm:"Incoterm", payment:"Pago", shipment:"Envío", validity:"Validez", portLoading:"Puerto de Carga", portDischarge:"Puerto de Descarga", docType:"Tipo de Documento", status:"Estado", description:"Descripción", model:"Modelo", hsCode:"Código HS", qty:"Cant.", unitPrice:"Precio Unit.", amount:"Importe", origin:"Origen", weight:"Peso", pkgs:"Bultos", shippingCost:"Coste de envío", subTotal:"Subtotal", vat:"IVA", totalAmount:"Total", bankNotes:"Banco / Notas", authorized:"AUTORIZADO", no:"Nº", date:"Fecha", currency:"Moneda", netWeight:"Peso Neto", grossWeight:"Peso Bruto", totalPackages:"Total Bultos", totalWeight:"Peso Total", countryOfOrigin:"País de Origen", signedBy:"Firmado por", dateOfIssue:"Fecha de Emisión", vessel:"Buque", blNo:"Nº B/L", container:"Contenedor", eta:"ETA", etd:"ETD", marks:"Marcas y Números", descriptionOfGoods:"Descripción de Mercancías", quantity:"Cantidad", unit:"Unidad", packageType:"Tipo de Embalaje", terms:"Términos y Condiciones", signatures:"Firmas", sellerSign:"En nombre del Vendedor", buyerSign:"En nombre del Comprador", thisIsToCertify:"Por la presente se certifica que las mercancías mencionadas en esta factura son originarias de", issuedUnder:"Emitido bajo", referenceNo:"Nº de Referencia", subject:"Asunto", dearSirs:"Estimados Señores,", weArePleased:"Nos complace informarle que el siguiente envío ha sido despachado:", regards:"Saludos Cordiales", packingListDesc:"Lista de Empaque", contractDesc:"Contrato de Venta", quotationDesc:"Cotización", quoteValidUntil:"Oferta válida hasta", quotedBy:"Cotizado por", acceptedBy:"Aceptado por", quoteTerms:"Términos de la Cotización", priceSubjectToChange:"Los precios están sujetos a confirmación final. Esta cotización expira después de la fecha de validez.", revisionLabel:"Rev.", quoteNumber:"Nº de Cotización", cooDesc:"Certificado de Origen", shippingDesc:"Aviso de Embarque", proformaDesc:"Factura Proforma", poDesc:"Orden de Compra", commercialDesc:"Factura Comercial", customsTitle:"Documentos de Despacho Aduanero", customsSub:"Paquete de Declaración Aduanera", exportDate:"Fecha de Exportación", customsDecl:"Declaración Aduanera", declElements:"Elementos de Declaración", invoice:"Factura", packingListShort:"Lista de Empaque", contractDoc:"Contrato", authorization:"Carta Poder", fillingGuide:"Guía de Declaración", shipperInfo:"Información del Exportador", consigneeInfo:"Información del Consignatario", companyName:"Nombre de la Empresa", companyAddress:"Dirección de la Empresa", contactInfo:"Contacto", transportInfo:"Transporte y Logística", totalGrossWeight:"Peso Total Bruto", packageCount:"Número de Bultos", tradeTerms:"Términos Comerciales", goodsList:"Lista Detallada de Mercancías", itemsUnit:"artículos", goodsName:"Nombre del Producto", paymentTradeTerms:"Pago y Términos Comerciales", paymentCondition:"Condiciones de Pago", customsNotice:"Verifique códigos HS, marca/modelo, peso y otros elementos de declaración aduanera" },
  RU: { seller:"Продавец", buyer:"Покупатель", incoterm:"Инкотермс", payment:"Оплата", shipment:"Отгрузка", validity:"Срок действия", portLoading:"Порт погрузки", portDischarge:"Порт выгрузки", docType:"Тип документа", status:"Статус", description:"Описание", model:"Модель", hsCode:"Код ТН ВЭД", qty:"Кол-во", unitPrice:"Цена за ед.", amount:"Сумма", origin:"Происхождение", weight:"Вес", pkgs:"Мест", subTotal:"Подытог", vat:"НДС", totalAmount:"Итого", bankNotes:"Банк / Примечания", authorized:"АВТОРИЗОВАНО", no:"№", date:"Дата", currency:"Валюта", netWeight:"Чистый вес", grossWeight:"Брутто вес", totalPackages:"Всего мест", totalWeight:"Общий вес", countryOfOrigin:"Страна происхождения", signedBy:"Подписано", dateOfIssue:"Дата выдачи", vessel:"Судно", blNo:"№ коносамента", container:"Контейнер", eta:"ETA", etd:"ETD", marks:"Марки и номера", descriptionOfGoods:"Описание товаров", quantity:"Количество", unit:"Единица", packageType:"Тип упаковки", terms:"Условия", signatures:"Подписи", sellerSign:"От имени Продавца", buyerSign:"От имени Покупателя", thisIsToCertify:"Настоящим удостоверяется, что товары, указанные в этом счете, происхождением из", issuedUnder:"Выдано в соответствии с", referenceNo:"Референс №", subject:"Тема", dearSirs:"Уважаемые господа,", weArePleased:"С удовольствием сообщаем вам, что следующая партия товара была отгружена:", regards:"С уважением", packingListDesc:"Упаковочный лист", contractDesc:"Договор купли-продажи", quotationDesc:"Коммерческое предложение", quoteValidUntil:"Предложение действует до", quotedBy:"Подготовил", acceptedBy:"Принято", quoteTerms:"Условия предложения", priceSubjectToChange:"Цены подлежат окончательному подтверждению. Предложение утрачивает силу после истечения срока действия.", revisionLabel:"Ред.", quoteNumber:"№ предложения", cooDesc:"Сертификат происхождения", shippingDesc:"Извещение об отгрузке", proformaDesc:"Проформа-счет", poDesc:"Заказ на закупку", commercialDesc:"Коммерческий счет", customsTitle:"Таможенные документы", customsSub:"Таможенный пакет декларации", exportDate:"Дата экспорта", customsDecl:"Таможенная декларация", declElements:"Элементы декларации", invoice:"Счет-фактура", packingListShort:"Упаковочный лист", contractDoc:"Договор", authorization:"Доверенность", fillingGuide:"Руководство по заполнению", shipperInfo:"Информация об отправителе", consigneeInfo:"Информация о получателе", companyName:"Название компании", companyAddress:"Адрес компании", contactInfo:"Контакт", transportInfo:"Транспорт и логистика", totalGrossWeight:"Общий брутто вес", packageCount:"Количество мест", tradeTerms:"Торговые термины", goodsList:"Подробный перечень товаров", itemsUnit:"позиций", goodsName:"Наименование товара", paymentTradeTerms:"Оплата и торговые условия", paymentCondition:"Условия оплаты", customsNotice:"Проверьте коды ТН ВЭД, марку/модель, вес и другие элементы таможенной декларации" },
  AR: { seller:"البائع", buyer:"المشتري", incoterm:"إنكوترمز", payment:"الدفع", shipment:"الشحن", validity:"الصلاحية", portLoading:"ميناء التحميل", portDischarge:"ميناء التفريغ", docType:"نوع المستند", status:"الحالة", description:"الوصف", model:"الموديل", hsCode:"رمز HS", qty:"الكمية", unitPrice:"سعر الوحدة", amount:"المبلغ", origin:"المنشأ", weight:"الوزن", pkgs:"العبوات", subTotal:"المجموع الفرعي", vat:"الضريبة", totalAmount:"المجموع", bankNotes:"البنك / الملاحظات", authorized:"معتمد", no:"رقم", date:"التاريخ", currency:"العملة", netWeight:"الوزن الصافي", grossWeight:"الوزن الإجمالي", totalPackages:"إجمالي العبوات", totalWeight:"الوزن الكلي", countryOfOrigin:"بلد المنشأ", signedBy:"موقّع من", dateOfIssue:"تاريخ الإصدار", vessel:"السفينة", blNo:"رقم بوليصة الشحن", container:"الحاوية", eta:"ETA", etd:"ETD", marks:"العلامات والأرقام", descriptionOfGoods:"وصف البضائع", quantity:"الكمية", unit:"الوحدة", packageType:"نوع التعبئة", terms:"الشروط والأحكام", signatures:"التوقيعات", sellerSign:"نيابة عن البائع", buyerSign:"نيابة عن المشتري", thisIsToCertify:"نشهد بأن البضائع المذكورة في هذه الفاتورة منشأها", issuedUnder:"صدر بموجب", referenceNo:"رقم المرجع", subject:"الموضوع", dearSirs:"السادة المحترمون،", weArePleased:"يسعدنا إعلامكم بأن الشحنة التالية قد تم إرسالها:", regards:"مع خالص التحيات", packingListDesc:"قائمة التعبئة", contractDesc:"عقد البيع", quotationDesc:"عرض سعر", quoteValidUntil:"العرض ساري حتى", quotedBy:"مُعد من قبل", acceptedBy:"مقبول من قبل", quoteTerms:"شروط العرض", priceSubjectToChange:"الأسعار قابلة للتأكيد النهائي. ينتهي هذا العرض بعد تاريخ الصلاحية.", revisionLabel:"إصدار", quoteNumber:"رقم العرض", cooDesc:"شهادة المنشأ", shippingDesc:"إشعار الشحن", proformaDesc:"فاتورة مبدئية", poDesc:"أمر شراء", commercialDesc:"فاتورة تجارية", customsTitle:"وثائق التخليص الجمركي", customsSub:"حزمة الإقرار الجمركي", exportDate:"تاريخ التصدير", customsDecl:"الإقرار الجمركي", declElements:"عناصر الإقرار", invoice:"فاتورة", packingListShort:"قائمة التعبئة", contractDoc:"عقد", authorization:"وكالة", fillingGuide:"دليل التعبئة", shipperInfo:"معلومات المُصدّر", consigneeInfo:"معلومات المُستلم", companyName:"اسم الشركة", companyAddress:"عنوان الشركة", contactInfo:"جهة الاتصال", transportInfo:"النقل والخدمات اللوجستية", totalGrossWeight:"إجمالي الوزن الإجمالي", packageCount:"عدد العبوات", tradeTerms:"الشروط التجارية", goodsList:"قائمة تفصيلية للبضائع", itemsUnit:"أصناف", goodsName:"اسم المنتج", paymentTradeTerms:"الدفع والشروط التجارية", paymentCondition:"شروط الدفع", customsNotice:"يرجى التحقق من رموز HS والعلامة/الموديل والوزن وعناصر الإقرار الجمركي الأخرى" },
  ZH: { seller:"卖方", buyer:"买方", incoterm:"贸易条款", payment:"付款条款", shipment:"运输方式", validity:"有效期", portLoading:"装运港", portDischarge:"目的港", docType:"单据类型", status:"状态", description:"品名", model:"型号", hsCode:"HS编码", qty:"数量", unitPrice:"单价", amount:"金额", origin:"原产国", weight:"重量", pkgs:"包装", subTotal:"小计", vat:"增值税", totalAmount:"合计金额", bankNotes:"银行信息/备注", authorized:"授权签字", no:"编号", date:"日期", currency:"币种", netWeight:"净重", grossWeight:"毛重", totalPackages:"总包装数", totalWeight:"总重量", countryOfOrigin:"原产国", signedBy:"签字人", dateOfIssue:"签发日期", vessel:"船名", blNo:"提单号", container:"集装箱号", eta:"预计到港", etd:"预计开船", marks:"唛头", descriptionOfGoods:"货物描述", quantity:"数量", unit:"单位", packageType:"包装类型", terms:"条款与条件", signatures:"签字", sellerSign:"卖方代表签字", buyerSign:"买方代表签字", thisIsToCertify:"兹证明本发票所列货物原产于", issuedUnder:"签发依据", referenceNo:"参考号", subject:"事由", dearSirs:"敬启者：", weArePleased:"兹通知贵方，以下货物已发运：", regards:"此致敬礼", packingListDesc:"装箱单", contractDesc:"销售合同", quotationDesc:"报价单", quoteValidUntil:"报价有效期至", quotedBy:"报价方签字", acceptedBy:"客户确认签字", quoteTerms:"报价条款", priceSubjectToChange:"价格以最终确认为准，报价有效期后自动失效。", revisionLabel:"版本", quoteNumber:"报价编号", cooDesc:"原产地证书", shippingDesc:"装运通知", proformaDesc:"形式发票", poDesc:"采购订单", commercialDesc:"商业发票", customsTitle:"报关资料", customsSub:"Customs Clearance Documents", exportDate:"出口日期", customsDecl:"报关单", declElements:"申报要素", invoice:"发票", packingListShort:"箱单", contractDoc:"合同", authorization:"委托书", fillingGuide:"填制规范", shipperInfo:"发货人信息", consigneeInfo:"收货人信息", companyName:"公司名称", companyAddress:"公司地址", contactInfo:"联系方式", transportInfo:"运输与物流信息", totalGrossWeight:"总毛重", packageCount:"包装件数", tradeTerms:"贸易术语", goodsList:"货物明细清单", itemsUnit:"项商品", goodsName:"货物名称", paymentTradeTerms:"支付与贸易条款", paymentCondition:"付款条件", customsNotice:"请核对 HS 编码、品牌型号、重量等海关申报要素" }
};

const DOC_THEMES: Record<string, { primary: string; light: string; text: string }> = {
  indigo: { primary: "#3157d5", light: "#eef2ff", text: "#1e293b" },
  emerald: { primary: "#059669", light: "#ecfdf5", text: "#1e293b" },
  rose: { primary: "#e11d48", light: "#fff1f2", text: "#1e293b" },
  slate: { primary: "#475569", light: "#f1f5f9", text: "#1e293b" },
  amber: { primary: "#d97706", light: "#fffbeb", text: "#1e293b" },
  executive: { primary: "#1e293b", light: "#f1f5f9", text: "#1e293b" },
  classic: { primary: "#374151", light: "#f9fafb", text: "#1e293b" },
  compact: { primary: "#6b7280", light: "#f3f4f6", text: "#1e293b" },
  longtec: { primary: "#111111", light: "#d9fbfb", text: "#111111" },
  // 定制B 是黑白制式单据（不跟随主题色），这里只用于兜底取色
  "custom-b": { primary: "#111111", light: "#ededed", text: "#111111" }
};

/** 定制模板自带固定配色，色板只做兜底，不能把用户的模板选择覆盖掉 */
export const DOC_PINNED_TEMPLATE_STYLES = new Set<string>(["longtec", "custom-b"]);

function docLabel(document: TradeDocument, key: string): string {
  const lang = document.language || "EN";
  return (DOC_I18N[lang] || DOC_I18N.EN)[key] || (DOC_I18N.EN)[key] || key;
}

function docTypeTitle(document: TradeDocument): string {
  const map: Record<string, string> = { PI: "proformaDesc", CI: "commercialDesc", PO: "poDesc", PL: "packingListDesc", CONTRACT: "contractDesc", QUOTATION: "quotationDesc", COO: "cooDesc", SHIPPING: "shippingDesc" };
  return docLabel(document, map[document.type] || "proformaDesc");
}

export function renderDocumentPreview(document: TradeDocument) {
  // 一行式 Logo 调节器跟预览同源：预览画哪套值，这里就显示哪套（放在早返回之前保证每种模板都同步）
  syncDocumentLogoInline(document);
  const preview = qs<HTMLElement>("#documentPreview");
  if (!preview) return;

  // 报关资料使用专门预览
  if (document.type === "CUSTOMS") {
    renderCustomsDocumentPreview(document, preview);
    return;
  }

  if (document.type === "PI" && document.templateStyle === "longtec") {
    renderLongtecPiPreview(document, preview);
    return;
  }

  if (document.type === "PI" && document.templateStyle === "custom-b") {
    renderCustomBPiPreview(document, preview);
    return;
  }

  if (document.type === "PO" && document.templateStyle === "custom-b") {
    renderCustomBPoPreview(document, preview);
    return;
  }

  const lang = document.language || "EN";
  const isRTL = lang === "AR";
  const theme = DOC_THEMES[document.templateStyle] || DOC_THEMES.rose;
  const total = documentTotal(document);
  const totalWeight = document.items.reduce((s, i) => s + (i.weightKg || 0), 0);
  const totalPkgs = document.items.reduce((s, i) => s + (i.packageCount || 0), 0);
  const title = docTypeTitle(document);

  preview.className = `doc-paper ${document.templateStyle}`;
  preview.style.setProperty("--doc-primary", theme.primary);
  preview.style.setProperty("--doc-light", theme.light);
  preview.style.setProperty("--doc-text", theme.text);
  preview.dir = isRTL ? "rtl" : "ltr";

  // 不同单据类型的表格列
  const showPrices = !["PL", "COO", "SHIPPING"].includes(document.type);
  const showWeight = ["PL", "CI", "CUSTOMS", "COO", "SHIPPING"].includes(document.type);
  const showOrigin = ["CI", "COO", "CUSTOMS"].includes(document.type);
  const showMaterial = document.items.some((item) => Boolean(item.material?.trim()));
  const showFinish = document.items.some((item) => Boolean(item.finish?.trim()));

  let itemsTable = "";
  if (document.type === "SHIPPING") {
    // 装运通知 - 信函格式
    itemsTable = `
      <div style="margin:24px 0;padding:16px;border:1px solid ${theme.primary};border-radius:8px;background:${theme.light};">
        <p style="margin:4px 0;"><b>${docLabel(document,"vessel")}:</b> ${escapeHtml(document.shippingMethod || "—")}</p>
        <p style="margin:4px 0;"><b>${docLabel(document,"blNo")}:</b> ${escapeHtml(document.number)}</p>
        <p style="margin:4px 0;"><b>${docLabel(document,"portLoading")}:</b> ${escapeHtml(document.portLoading || "—")}</p>
        <p style="margin:4px 0;"><b>${docLabel(document,"portDischarge")}:</b> ${escapeHtml(document.portDischarge || "—")}</p>
        <p style="margin:4px 0;"><b>${docLabel(document,"date")}:</b> ${escapeHtml(document.issueDate)}</p>
      </div>
      <p style="margin:16px 0;font-size:14px;color:${theme.text};">${docLabel(document,"weArePleased")}</p>`;
  } else if (document.type === "COO") {
    // 原产地证 - 网格声明格式
    itemsTable = `
      <div style="margin:20px 0;padding:20px;border:2px solid ${theme.primary};border-radius:8px;text-align:center;">
        <p style="font-size:15px;line-height:1.8;color:${theme.text};">${docLabel(document,"thisIsToCertify")} <b>${escapeHtml(document.seller)}</b>.</p>
      </div>`;
  } else if (document.type === "CONTRACT") {
    // 销售合同 - 条款格式
    itemsTable = `
      <div style="margin:16px 0;padding:16px;border-radius:8px;background:${theme.light};">
        <h3 style="color:${theme.primary};margin:0 0 8px;font-size:14px;">${docLabel(document,"terms")}</h3>
        <ol style="margin:0;padding-${isRTL?"right":"left"}:20px;font-size:13px;line-height:1.8;color:${theme.text};">
          <li>${docLabel(document,"payment")}: ${escapeHtml(document.paymentTerm || "—")}</li>
          <li>${docLabel(document,"shipment")}: ${escapeHtml(document.shippingMethod || "—")}</li>
          <li>${docLabel(document,"incoterm")}: ${escapeHtml(document.incoterm || "—")}</li>
          <li>${docLabel(document,"validity")}: ${escapeHtml(document.validityDate || "—")}</li>
          <li>${escapeHtml(document.notes || docLabel(document,"terms"))}</li>
        </ol>
      </div>`;
  }

  // 通用商品明细表格
  if (document.type !== "SHIPPING" && document.type !== "COO") {
    let cols = `<th>#</th><th>${docLabel(document,"description")}</th><th>${docLabel(document,"model")}</th>`;
    if (showMaterial) cols += `<th>Material</th>`;
    if (showFinish) cols += `<th>Finish</th>`;
    if (document.type !== "CONTRACT") cols += `<th>${docLabel(document,"hsCode")}</th>`;
    cols += `<th>${docLabel(document,"qty")}</th>`;
    if (showWeight) cols += `<th>${docLabel(document,"weight")}</th><th>${docLabel(document,"pkgs")}</th>`;
    if (showOrigin) cols += `<th>${docLabel(document,"origin")}</th>`;
    if (showPrices) cols += `<th>${docLabel(document,"unitPrice")}</th><th>${docLabel(document,"amount")}</th>`;

    itemsTable += `
      <table class="doc-items-table ${document.type.toLowerCase()}" style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:${theme.primary};color:#fff;">${cols}</tr></thead>
        <tbody>${document.items.map((item, index) => {
          let row = `<tr style="border-bottom:1px solid #e5e7eb;">`;
          row += `<td style="padding:8px;text-align:center;">${index + 1}</td>`;
          row += `<td style="padding:8px;">${escapeHtml(documentItemDisplayName(document, item))}</td>`;
          row += `<td style="padding:8px;">${escapeHtml(item.model)}</td>`;
          if (showMaterial) row += `<td style="padding:8px;">${escapeHtml(item.material || "")}</td>`;
          if (showFinish) row += `<td style="padding:8px;">${escapeHtml(item.finish || "")}</td>`;
          if (document.type !== "CONTRACT") row += `<td style="padding:8px;">${escapeHtml(item.hsCode)}</td>`;
          row += `<td style="padding:8px;text-align:center;">${item.quantity} ${escapeHtml(item.unit)}</td>`;
          if (showWeight) row += `<td style="padding:8px;text-align:center;">${item.weightKg} kg</td><td style="padding:8px;text-align:center;">${item.packageCount}</td>`;
          if (showOrigin) row += `<td style="padding:8px;text-align:center;">${escapeHtml(item.originCountry)}</td>`;
          if (showPrices) row += `<td style="padding:8px;text-align:right;">${formatDocumentTableMoney(item.unitPrice)}</td><td style="padding:8px;text-align:right;">${formatDocumentTableMoney(item.quantity * item.unitPrice)}</td>`;
          row += `</tr>`;
          return row;
        }).join("")}</tbody>
      </table>`;
  }

  // 合同签字区
  let signArea = "";
  if (document.type === "CONTRACT") {
    signArea = `
      <div style="display:flex;justify-content:space-between;margin-top:32px;gap:24px;">
        <div style="flex:1;">
          <p style="border-top:1px solid ${theme.primary};padding-top:8px;font-size:13px;color:${theme.text};">${docLabel(document,"sellerSign")}</p>
          <p style="font-size:12px;color:#999;margin-top:4px;">${escapeHtml(document.seller)}</p>
        </div>
        <div style="flex:1;">
          <p style="border-top:1px solid ${theme.primary};padding-top:8px;font-size:13px;color:${theme.text};">${docLabel(document,"buyerSign")}</p>
          <p style="font-size:12px;color:#999;margin-top:4px;">${escapeHtml(document.buyer)}</p>
        </div>
      </div>`;
  } else if (document.type === "QUOTATION") {
    // 报价单 - 报价条款 + 双签字(报价方/客户确认)
    signArea = `
      <div class="doc-quote-terms" style="margin-top:20px;padding:16px;border-radius:8px;background:${theme.light};border:1px solid ${theme.primary}33;">
        <h3 style="color:${theme.primary};margin:0 0 8px;font-size:14px;">${docLabel(document,"quoteTerms")}</h3>
        <p style="margin:0;font-size:13px;line-height:1.7;color:${theme.text};">${escapeHtml(document.notes || docLabel(document,"priceSubjectToChange"))}</p>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:28px;gap:24px;">
        <div style="flex:1;">
          <p style="border-top:1px solid ${theme.primary};padding-top:8px;font-size:13px;color:${theme.text};">${docLabel(document,"quotedBy")}</p>
          <p style="font-size:12px;color:#999;margin-top:4px;">${escapeHtml(document.seller)}</p>
        </div>
        <div style="flex:1;">
          <p style="border-top:1px solid ${theme.primary};padding-top:8px;font-size:13px;color:${theme.text};">${docLabel(document,"acceptedBy")}</p>
          <p style="font-size:12px;color:#999;margin-top:4px;">${escapeHtml(document.buyer)}</p>
        </div>
      </div>`;
  } else {
    signArea = `
      <div class="doc-sign">
        <div class="doc-block"><h3 style="color:${theme.primary};">${docLabel(document,"bankNotes")}</h3><p>${escapeHtml(document.bankInfo)}</p><p>${escapeHtml(document.notes)}</p></div>
        <div class="doc-stamp" style="color:${theme.primary};border-color:${theme.primary};">${docLabel(document,"authorized")}</div>
      </div>`;
  }

  const brandMarkText = [...(document.brandMarkText || "").trim()].slice(0, 8).join("").toUpperCase() || [...(document.seller || "GJ").trim()].slice(0, 2).join("").toUpperCase() || "GJ";
  const brandMarkClass = [...brandMarkText].length > 4 ? " is-long" : [...brandMarkText].length > 2 ? " is-medium" : "";
  preview.innerHTML = `
    <div class="doc-print-head">
      <div class="doc-letterhead">
        <div class="doc-logo-mark${brandMarkClass}" style="background:${theme.primary};">${escapeHtml(brandMarkText)}</div>
        <div>
          <b>${escapeHtml(document.seller)}</b>
          <small>${escapeHtml(document.sellerAddress)}</small>
        </div>
      </div>
      <div class="doc-number-box">
        <p><b>${document.type === "QUOTATION" ? docLabel(document,"quoteNumber") : docLabel(document,"no")}</b> ${escapeHtml(document.number)}</p>
        <p><b>${docLabel(document,"date")}</b> ${escapeHtml(document.issueDate)}</p>
        ${document.type === "QUOTATION" && document.revision > 0 ? `<p><b>${docLabel(document,"revisionLabel")}</b> ${document.revision}</p>` : ""}
        ${showPrices ? `<p><b>${docLabel(document,"currency")}</b> ${escapeHtml(document.currency)}</p>` : ""}
      </div>
    </div>
    <div class="doc-title-band" style="background:${theme.light};border-${isRTL?"right":"left"}:4px solid ${theme.primary};">
      <h2 style="color:${theme.primary};">${title}</h2>
      <p>${escapeHtml(document.title)}</p>
    </div>
    <div class="doc-print-grid">
      <div class="doc-block"><h3 style="color:${theme.primary};">${docLabel(document,"seller")}</h3><p><b>${escapeHtml(document.seller)}</b></p><p>${escapeHtml(document.sellerAddress)}</p></div>
      <div class="doc-block"><h3 style="color:${theme.primary};">${docLabel(document,"buyer")}</h3><p><b>${escapeHtml(document.buyer)}</b></p><p>${escapeHtml(document.buyerAddress)}</p><p>${escapeHtml(document.buyerContact)}</p></div>
    </div>
    <div class="doc-terms">
      <div class="doc-term"><span>${docLabel(document,"incoterm")}</span><b>${escapeHtml(document.incoterm)}</b></div>
      <div class="doc-term"><span>${docLabel(document,"payment")}</span><b>${escapeHtml(document.paymentTerm)}</b></div>
      <div class="doc-term"><span>${docLabel(document,"shipment")}</span><b>${escapeHtml(document.shippingMethod)}</b></div>
      <div class="doc-term"><span>${docLabel(document,"validity")}</span><b>${escapeHtml(document.validityDate || "—")}</b></div>
      <div class="doc-term"><span>${docLabel(document,"portLoading")}</span><b>${escapeHtml(document.portLoading)}</b></div>
      <div class="doc-term"><span>${docLabel(document,"portDischarge")}</span><b>${escapeHtml(document.portDischarge || "—")}</b></div>
    </div>
    ${document.type === "QUOTATION" ? `
    <div style="margin:16px 0;padding:12px 20px;border-radius:8px;background:${theme.light};border:1px solid ${theme.primary};display:flex;align-items:center;gap:12px;">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${theme.primary}" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <span style="font-size:14px;color:${theme.primary};font-weight:600;">${docLabel(document,"quoteValidUntil")}:</span>
      <span style="font-size:14px;color:${theme.text};font-weight:700;">${escapeHtml(document.validityDate || "—")}</span>
    </div>` : ""}
    ${itemsTable}
    ${showPrices ? `<div class="doc-total" style="border-top:2px solid ${theme.primary};"><span>${docLabel(document,"totalAmount")}</span><b style="color:${theme.primary};">${formatDocumentMoney(total, document.currency)}</b></div>` : (showWeight ? `<div class="doc-total" style="border-top:2px solid ${theme.primary};"><span>${docLabel(document,"totalWeight")}</span><b>${totalWeight} kg</b></div><div class="doc-total"><span>${docLabel(document,"totalPackages")}</span><b>${totalPkgs}</b></div>` : "")}
    ${signArea}
  `;

  const meta = qs<HTMLElement>("#docPreviewMeta");
  if (meta) meta.textContent = `${document.type} · ${document.number} · ${showPrices ? formatDocumentMoney(total, document.currency) : (totalWeight + " kg")}`;
}

function formatLongtecDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return value || "—";
  const months = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec."];
  return `${Number(match[3])}, ${months[Number(match[2]) - 1] || match[2]} ${match[1]}`;
}

function formatLongtecMoney(value: number, currency = "USD") {
  const fractionDigits = Number.isInteger(value) ? 0 : 2;
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: 2 })}`;
}

function renderLongtecPiPreview(document: TradeDocument, preview: HTMLElement) {
  const total = documentTotal(document);
  const productItems = document.items.filter((item) => item.lineType !== "shipping_cost");
  const shippingItems = document.items.filter((item) => item.lineType === "shipping_cost");
  const subtotal = productItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const lang = document.language || "EN";
  const isRTL = lang === "AR";
  const labels: Record<string, Record<string, string>> = {
    EN: { buyer: "Buyer", seller: "Seller", date: "Date", no: "NO", item: "Item", description: "Description", unitPrice: "Unit Price", quantity: "Quantity", amount: "Amount", totalPayment: "Total payment", priceTerms: "Price terms", delivery: "Delivery / Shipment", paymentTerms: "Payment Terms", validity: "Validity", remark: "Remark", subTotal: "Sub-Total", vat: "Total VAT", totalOrder: "Total Order", signedBy: "Signed by", bankDetails: "Bank details" },
    ES: { buyer: "Comprador", seller: "Vendedor", date: "Fecha", no: "Nº", item: "Artículo", description: "Descripción", unitPrice: "Precio unitario", quantity: "Cantidad", amount: "Importe", totalPayment: "Pago total", priceTerms: "Términos de precio", delivery: "Entrega / Envío", paymentTerms: "Condiciones de pago", validity: "Validez", remark: "Observación", subTotal: "Subtotal", vat: "IVA total", totalOrder: "Pedido total", signedBy: "Firmado por", bankDetails: "Datos bancarios" },
    RU: { buyer: "Покупатель", seller: "Продавец", date: "Дата", no: "№", item: "Позиция", description: "Описание", unitPrice: "Цена за ед.", quantity: "Количество", amount: "Сумма", totalPayment: "Итого к оплате", priceTerms: "Условия цены", delivery: "Доставка / Отгрузка", paymentTerms: "Условия оплаты", validity: "Срок действия", remark: "Примечание", subTotal: "Подытог", vat: "Общий НДС", totalOrder: "Итого заказа", signedBy: "Подписано", bankDetails: "Банковские реквизиты" },
    AR: { buyer: "المشتري", seller: "البائع", date: "التاريخ", no: "الرقم", item: "البند", description: "الوصف", unitPrice: "سعر الوحدة", quantity: "الكمية", amount: "المبلغ", totalPayment: "إجمالي الدفع", priceTerms: "شروط السعر", delivery: "التسليم / الشحن", paymentTerms: "شروط الدفع", validity: "الصلاحية", remark: "ملاحظة", subTotal: "المجموع الفرعي", vat: "إجمالي الضريبة", totalOrder: "إجمالي الطلب", signedBy: "موقّع من", bankDetails: "تفاصيل البنك" },
    ZH: { buyer: "买方", seller: "卖方", date: "日期", no: "编号", item: "项目", description: "描述", unitPrice: "单价", quantity: "数量", amount: "金额", totalPayment: "总付款", priceTerms: "价格条款", delivery: "交付 / 运输", paymentTerms: "付款条款", validity: "有效期", remark: "备注", subTotal: "小计", vat: "增值税合计", totalOrder: "订单总额", signedBy: "签字人", bankDetails: "银行信息" }
  };
  const label = (key: string, fallback = key) => labels[lang]?.[key] || labels.EN[key] || fallback;
  const themeId = qs<HTMLSelectElement>("#docThemeInput")?.value || "rose";
  const theme = DOC_THEMES[themeId] || DOC_THEMES.rose;
  const accent = themeId === "longtec" ? "#111111" : theme.primary;
  const title = docTypeTitle(document).toUpperCase();
  // 顶部抬头优先取左侧选中的卖方公司档案（letterhead）的英文全称
  const headerLetterhead = document.letterheadId ? state.documentAssets.letterheads.find((item) => item.id === document.letterheadId) : undefined;
  const headerCompany = headerLetterhead?.companyName || document.seller || "—";
  const sellerContact = [document.sellerContact, document.sellerPhone, document.sellerEmail, document.sellerWebsite].filter(Boolean).join(" · ");
  const delivery = [document.shippingMethod, document.portLoading && `${label("portLoading", "From")}: ${document.portLoading}`, document.portDischarge && `${label("portDischarge", "To")}: ${document.portDischarge}`].filter(Boolean).join(" · ");
  const itemRows = productItems.map((item) => {
    const description = [item.model, item.material, item.finish, item.hsCode && `HS ${item.hsCode}`].filter(Boolean).join(" · ") || "—";
    return `<tr><td>${escapeHtml(item.product || "—")}</td><td>${escapeHtml(description)}</td><td class="money">${formatLongtecMoney(Number(item.unitPrice || 0), document.currency)}</td><td class="quantity">${escapeHtml(String(item.quantity || 0))} ${escapeHtml(item.unit || "")}</td><td class="money">${formatLongtecMoney(Number(item.quantity || 0) * Number(item.unitPrice || 0), document.currency)}</td></tr>`;
  }).join("");
  const shippingRows = shippingItems.map((item) => `<tr><td colspan="4" class="longtec-summary-label">${escapeHtml(documentItemDisplayName(document, item) || label("shippingCost", "Shipping Cost"))}</td><td class="money">${formatLongtecMoney(Number(item.quantity || 0) * Number(item.unitPrice || 0), document.currency)}</td></tr>`).join("");
  const terms = [
    [label("priceTerms"), document.incoterm],
    [label("delivery"), delivery],
    [label("paymentTerms"), document.paymentTerm],
    [label("validity"), document.validityDate]
  ].filter(([, value]) => value);
  const termsHtml = terms.map(([name, value]) => `<p><span>${escapeHtml(name)}:</span> ${escapeHtml(value || "")}</p>`).join("");
  const bankLines = document.bankInfo || "—";

  preview.className = "doc-paper longtec-pi";
  preview.style.setProperty("--doc-primary", accent);
  preview.style.setProperty("--doc-light", theme.light);
  preview.style.setProperty("--doc-text", "#111111");
  preview.style.setProperty("--longtec-accent", accent);
  preview.style.setProperty("--longtec-light", theme.light);
  preview.dir = isRTL ? "rtl" : "ltr";
  preview.innerHTML = `
    <header class="longtec-pi-header">
      <div class="longtec-pi-company">${escapeHtml(headerCompany)}</div>
      <div class="longtec-pi-rule"></div>
      <h2>${escapeHtml(title)}</h2>
      <div class="longtec-pi-meta"><p><b>${escapeHtml(label("date"))}:</b> ${escapeHtml(formatLongtecDate(document.issueDate))}</p><p><b>${escapeHtml(label("no"))}:</b> ${escapeHtml(document.number)}</p></div>
    </header>
    <section class="longtec-pi-parties">
      <div><h3>${escapeHtml(label("buyer"))}:</h3><b>${escapeHtml(document.buyer || "—")}</b><p>${escapeHtml(document.buyerAddress || "")}</p><p>${escapeHtml(document.buyerContact || "")}</p></div>
      <div><h3>${escapeHtml(label("seller"))}:</h3><b>${escapeHtml(document.seller || "—")}</b><p>${escapeHtml(document.sellerAddress || "")}</p><p>${escapeHtml(sellerContact)}</p></div>
    </section>
    <table class="longtec-pi-table">
      <thead><tr><th>${escapeHtml(label("item"))}</th><th>${escapeHtml(label("description"))}</th><th>${escapeHtml(label("unitPrice"))}</th><th>${escapeHtml(label("quantity"))}</th><th>${escapeHtml(label("amount"))}</th></tr></thead>
      <tbody>${itemRows || `<tr><td colspan="5">—</td></tr>`}${shippingRows}<tr><td colspan="4" class="longtec-summary-label">${escapeHtml(label("totalPayment"))}</td><td class="money">${formatLongtecMoney(total, document.currency)}</td></tr></tbody>
    </table>
    <section class="longtec-pi-lower">
      <div class="longtec-pi-terms">${termsHtml}<p><span>${escapeHtml(label("remark"))}:</span> ${escapeHtml(document.notes || "—")}</p></div>
      <div class="longtec-pi-totals"><p><b>${escapeHtml(label("subTotal"))}:</b> ${formatLongtecMoney(subtotal + shippingItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0), document.currency)}</p><p><b>${escapeHtml(label("vat"))}:</b> ${formatLongtecMoney(0, document.currency)}</p><p><b>${escapeHtml(label("totalOrder"))}:</b> ${formatLongtecMoney(total, document.currency)}</p><div class="longtec-pi-sign"><b>${escapeHtml(label("signedBy"))}</b><span>${escapeHtml(document.sellerContact || document.seller || "—")}</span></div></div>
    </section>
    <section class="longtec-pi-bank"><h3>${escapeHtml(label("bankDetails"))}:</h3><p>${escapeHtml(bankLines)}</p></section>
  `;
  const meta = qs<HTMLElement>("#docPreviewMeta");
  if (meta) meta.textContent = `PI · ${document.number} · ${formatLongtecMoney(total, document.currency)}`;
}

/** 定制B（PI）的固定文案：参考模板是纯英文单据，这里按单据语言给出对应标签 */
const CUSTOM_B_PI_TEXT: Record<string, Record<string, string>> = {
  EN: {
    company: "Company", address: "Address", tell: "Tell", email: "E-mail", attn: "Attn", item: "Item",
    expiry: "Expiry", reference: "Reference", quoteNumber: "Quote Number", amount: "Amount",
    onBehalf: "For and on behalf of", authorized: "Authorized Signature(s)", noVat: "No VAT",
    totalNoVat: "TOTAL NO VAT", totalPrefix: "TOTAL", conditions: "Conditions", dispatchBy: "Dispatch by", terms: "Terms",
    termsIntro: "By accepting this quote you agree to the terms and conditions below:"
  },
  ZH: {
    company: "公司", address: "地址", tell: "电话", email: "邮箱", attn: "联系人", item: "项目",
    expiry: "有效期至", reference: "参考号", quoteNumber: "单据编号", amount: "金额",
    onBehalf: "代表签署", authorized: "授权签字", noVat: "无增值税",
    totalNoVat: "合计（不含增值税）", totalPrefix: "合计", conditions: "贸易条件", dispatchBy: "发运方式", terms: "条款",
    termsIntro: "接受本报价即表示同意以下条款与条件："
  },
  ES: {
    company: "Empresa", address: "Dirección", tell: "Tel.", email: "Correo", attn: "Atención", item: "Ítem",
    expiry: "Vence", reference: "Referencia", quoteNumber: "Nº de Documento", amount: "Importe",
    onBehalf: "En nombre de", authorized: "Firma autorizada", noVat: "Sin IVA",
    totalNoVat: "TOTAL SIN IVA", totalPrefix: "TOTAL", conditions: "Condiciones", dispatchBy: "Envío", terms: "Términos",
    termsIntro: "Al aceptar esta cotización usted acepta los términos y condiciones siguientes:"
  },
  RU: {
    company: "Компания", address: "Адрес", tell: "Тел.", email: "E-mail", attn: "Внимание", item: "Позиция",
    expiry: "Действует до", reference: "Референс", quoteNumber: "Номер документа", amount: "Сумма",
    onBehalf: "От имени", authorized: "Подпись", noVat: "Без НДС",
    totalNoVat: "ИТОГО БЕЗ НДС", totalPrefix: "ИТОГО", conditions: "Условия", dispatchBy: "Отправка", terms: "Условия",
    termsIntro: "Принимая данное предложение, вы соглашаетесь со следующими условиями:"
  },
  AR: {
    company: "الشركة", address: "العنوان", tell: "الهاتف", email: "البريد", attn: "عناية", item: "البند",
    expiry: "ينتهي في", reference: "المرجع", quoteNumber: "رقم المستند", amount: "المبلغ",
    onBehalf: "نيابة عن", authorized: "توقيع معتمد", noVat: "بدون ضريبة",
    totalNoVat: "الإجمالي بدون ضريبة", totalPrefix: "الإجمالي", conditions: "الشروط", dispatchBy: "الشحن", terms: "الشروط",
    termsIntro: "بقبولك هذا العرض فإنك توافق على الشروط والأحكام التالية:"
  }
};

/**
 * 定制B：黑白制式 PI（版式照 桌面/新模版 里的 PI #ECORE GLOBAL CRM）。
 *
 * 与参考逐块对齐：
 *   - Logo 在右上角，等比例缩放（模板里不写死任何品牌素材）
 *   - 左侧大标题 + 右侧 Date / Expiry / Quote Number / Reference
 *   - 抬头信息块是「收件方」：Company / Address / E-mail / Attn
 *   - 明细表只有横线，没有外框和竖线，金额右对齐
 *   - 条款与银行信息在左，右下角斜体签署 For and on behalf of …
 *
 * Logo 取数顺序：所选公司档案 logoUrl → 单据快照 logoUrl → 文字标志。
 */
function renderCustomBPiPreview(document: TradeDocument, preview: HTMLElement) {
  const total = documentTotal(document);
  const productItems = document.items.filter((item) => item.lineType !== "shipping_cost");
  const shippingItems = document.items.filter((item) => item.lineType === "shipping_cost");
  const isRTL = (document.language || "EN") === "AR";
  const lang = document.language || "EN";
  const T = (key: string) => (CUSTOM_B_PI_TEXT[lang] || CUSTOM_B_PI_TEXT.EN)[key] || CUSTOM_B_PI_TEXT.EN[key] || key;
  const L = (key: string) => docLabel(document, key);
  const money = (value: number) => formatLongtecMoney(value, document.currency);

  const letterhead = document.letterheadId
    ? state.documentAssets.letterheads.find((item) => item.id === document.letterheadId)
    : undefined;
  // 已经选了卖方档案时，Logo 只认这份档案（档案没上传就是没有），
  // 否则换档案后还会沿用上一家的 logo；没选档案的老单据才回落到保存时的快照。
  const logoUrl = letterhead ? (letterhead.logoUrl || "") : (document.letterheadSnapshot?.logoUrl || "");
  const company = letterhead?.companyName || document.letterheadSnapshot?.companyName || document.seller || "—";
  const brandText = [...(document.brandMarkText || document.seller || "").trim()].slice(0, 14).join("").toUpperCase() || "—";
  // 「卖方公司」里为定制B · PI 单独调好的位置与大小在这里生效（没调过沿用通用值，未调整时默认版式不变）
  const logoStyle = documentLogoPlacementStyle(documentLogoPlacementFor(letterhead, document.letterheadSnapshot, "PI"), "right");
  const logoHtml = logoUrl
    ? `<img class="cb-logo-image" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(company)}"${logoStyle}>`
    : `<span class="cb-logo-text"${logoStyle}>${escapeHtml(brandText)}</span>`;

  const stamp = state.documentAssets.stamps.find((item) => item.id === document.stampId);
  const signature = state.documentAssets.signatures.find((item) => item.id === document.signatureId);

  // 参考 PI 的抬头固定五行（Company / Address / Tell / E-mail / Attn）：
  // 值为空也保留标签行 —— 行高固定，下面的明细表才能落在与参考件相同的纵向位置。
  // 买方只有一个 buyerContact 字段，按内容拆成电话 / 邮箱 / 联系人。
  const buyerContact = document.buyerContact || "";
  const emailMatch = buyerContact.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const phoneMatch = buyerContact.match(/(?:\+|00)?\d[\d\s()-]{6,}\d/);
  const contactName = buyerContact
    .split(/[,;，；\n]/)
    .map((part) => part.trim())
    .find((part) => part && !part.includes("@") && !/^(?:\+|00)?\d[\d\s()-]{6,}\d$/.test(part)) || "";
  const partyRows: [string, string][] = [
    [T("company"), document.buyer || ""],
    [T("address"), document.buyerAddress || ""],
    [T("tell"), phoneMatch ? phoneMatch[0] : ""],
    [T("email"), emailMatch ? emailMatch[0] : ""],
    [T("attn"), contactName]
  ];

  // 参考件的表格只有横线：表头除 Item / Description 外全部右对齐，正文 9pt 常规字重。
  const itemRows = productItems.map((item, index) => {
    const spec = [item.model, item.material, item.finish, item.hsCode && `HS ${item.hsCode}`].filter(Boolean).join(" · ");
    return `<tr>
      <td class="cbq-item-no">${escapeHtml(String(index + 1).padStart(3, "0"))}</td>
      <td class="cbq-desc">${escapeHtml(documentItemDisplayName(document, item) || "—")}${spec ? `<span>${escapeHtml(spec)}</span>` : ""}</td>
      <td class="cbq-money">${escapeHtml(`${Number(item.quantity || 0)}${item.unit ? ` ${item.unit}` : ""}`)}</td>
      <td class="cbq-money">${money(Number(item.unitPrice || 0))}</td>
      <td class="cbq-money cbq-vat">${escapeHtml(T("noVat"))}</td>
      <td class="cbq-money">${money(Number(item.quantity || 0) * Number(item.unitPrice || 0))}</td>
    </tr>`;
  }).join("");
  const shippingRows = shippingItems.map((item) => `<tr>
      <td class="cbq-item-no"></td>
      <td class="cbq-desc">${escapeHtml(documentItemDisplayName(document, item) || L("shippingCost"))}</td>
      <td class="cbq-money"></td>
      <td class="cbq-money"></td>
      <td class="cbq-money cbq-vat"></td>
      <td class="cbq-money">${money(Number(item.quantity || 0) * Number(item.unitPrice || 0))}</td>
    </tr>`).join("");
  const emptyRow = `<tr><td class="cbq-item-no"></td><td class="cbq-desc">—</td><td class="cbq-money"></td><td class="cbq-money"></td><td class="cbq-money cbq-vat"></td><td class="cbq-money"></td></tr>`;

  // 参考件的贸易条件压在最底部（Conditions / Payment / Dispatch by 三行紧凑排列），
  // 不跟银行信息混在一起。
  const conditionLines = [
    [T("conditions"), document.incoterm],
    [L("payment"), document.paymentTerm],
    [T("dispatchBy"), [document.shippingMethod, document.portLoading && `${L("portLoading")}: ${document.portLoading}`, document.portDischarge && `${L("portDischarge")}: ${document.portDischarge}`].filter(Boolean).join(" · ")]
  ].filter(([, value]) => value)
    .map(([label, value]) => `<p><b>${escapeHtml(String(label))}:</b> ${escapeHtml(String(value))}</p>`).join("");

  preview.className = "doc-paper custom-b-pi";
  preview.dir = isRTL ? "rtl" : "ltr";
  preview.innerHTML = `
    <div class="cbq-head">
      <header class="cbq-top"><div class="cbq-logo">${logoHtml}</div></header>
      <section class="cbq-body">
        <div class="cbq-left">
          <h1 class="cbq-title">${escapeHtml(docTypeTitle(document).toUpperCase())}</h1>
          <section class="cbq-party">
            ${partyRows.map(([label, value]) => `<p><b>${escapeHtml(label)}:</b><span>${escapeHtml(value)}</span></p>`).join("")}
          </section>
        </div>
        <div class="cbq-meta">
          <p><b>${escapeHtml(L("date"))}:</b><span>${escapeHtml(formatLongtecDate(document.issueDate))}</span></p>
          <p><b>${escapeHtml(T("expiry"))}:</b><span>${escapeHtml(document.validityDate ? formatLongtecDate(document.validityDate) : "")}</span></p>
          <p><b>${escapeHtml(T("quoteNumber"))}:</b><span>${escapeHtml(document.number || "")}</span></p>
          <p><b>${escapeHtml(T("reference"))}:</b><span></span></p>
        </div>
      </section>
    </div>
    <table class="cbq-table">
      <thead><tr>
        <th class="cbq-col-no">${escapeHtml(T("item"))}</th>
        <th class="cbq-col-desc">${escapeHtml(L("description"))}</th>
        <th class="cbq-col-qty">${escapeHtml(L("quantity"))}</th>
        <th class="cbq-col-price">${escapeHtml(L("unitPrice"))}</th>
        <th class="cbq-col-vat">${escapeHtml(L("vat"))}</th>
        <th class="cbq-col-amount">${escapeHtml(T("amount"))} ${escapeHtml(document.currency || "USD")}</th>
      </tr></thead>
      <tbody>${itemRows || emptyRow}${shippingRows}</tbody>
    </table>
    <section class="cbq-totals">
      <p><span>${escapeHtml(L("subTotal"))}</span><b>${money(total)}</b></p>
      <p><span>${escapeHtml(T("totalNoVat"))}</span><b>${money(total)}</b></p>
      <p><span>${escapeHtml(`${T("totalPrefix")} ${document.currency || "USD"}`)}</span><b>${money(total)}</b></p>
    </section>
    <h3 class="cbq-terms-title">${escapeHtml(T("terms"))}</h3>
    <section class="cbq-lower">
      <div class="cbq-terms">
        <p class="cbq-intro">${escapeHtml(T("termsIntro"))}</p>
        ${document.sellerWebsite ? `<p>${escapeHtml(document.sellerWebsite)}</p>` : ""}
        ${document.bankInfo ? `<p class="cbq-bank">${escapeHtml(document.bankInfo)}</p>` : ""}
        ${conditionLines ? `<div class="cbq-conditions">${conditionLines}</div>` : ""}
        ${document.notes ? `<p class="cbq-notes">${escapeHtml(document.notes)}</p>` : ""}
      </div>
      <div class="cbq-sign">
        <p class="cbq-sign-for">${escapeHtml(T("onBehalf"))}</p>
        <p class="cbq-sign-company">${escapeHtml(company)}</p>
        <div class="cbq-sign-rule">
          ${signature?.imageUrl ? `<img class="cbq-sign-image" src="${escapeHtml(signature.imageUrl)}" alt="${escapeHtml(signature.name || "signature")}">` : ""}
          ${stamp?.imageUrl ? `<img class="cbq-stamp-image" src="${escapeHtml(stamp.imageUrl)}" alt="${escapeHtml(stamp.name || "stamp")}">` : ""}
        </div>
        <p class="cbq-sign-caption">${escapeHtml(T("authorized"))}</p>
      </div>
    </section>
  `;

  const meta = qs<HTMLElement>("#docPreviewMeta");
  if (meta) meta.textContent = `PI · ${document.number} · ${money(total)}`;
}

/**
 * 定制B：黑白制式 PO（采购订单，版式照参考采购单）。
 *
 * 与 PI 版的区别：PO 的主体是「采购方」。
 *   - 左上角 Logo、右上公司名、Ship to、Confirmed By 都取买方口径
 *     （buyer 字段 → 所选公司档案 → 保存时的快照），
 *   - Vendor 一行才是供应商（seller / sellerAddress / sellerPhone / sellerEmail / sellerContact）。
 * Logo 依然不写死在模板里：优先所选公司档案上传的 logoUrl，其次单据快照，最后纯文字标志。
 * 表头固定英文（Condition / Warranty / Terms / Payment Term / Lead Time），
 * 因为采购单通常直接发给海外供应商；单据标题继续跟随单据语言。
 */
function renderCustomBPoPreview(document: TradeDocument, preview: HTMLElement) {
  const total = documentTotal(document);
  const productItems = document.items.filter((item) => item.lineType !== "shipping_cost");
  const shippingItems = document.items.filter((item) => item.lineType === "shipping_cost");
  const shippingTotal = shippingItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const isRTL = (document.language || "EN") === "AR";
  const money = (value: number) => formatLongtecMoney(value, document.currency);

  const letterhead = document.letterheadId
    ? state.documentAssets.letterheads.find((item) => item.id === document.letterheadId)
    : undefined;
  const logoUrl = letterhead ? (letterhead.logoUrl || "") : (document.letterheadSnapshot?.logoUrl || "");
  const buyerCompany = document.buyer
    || letterhead?.companyName
    || document.letterheadSnapshot?.companyName
    || document.seller
    || "—";
  const buyerBrandText = [...(document.brandMarkText || buyerCompany || "").trim()].slice(0, 14).join("").toUpperCase() || "—";
  // 「卖方公司」里为定制B · PO 单独调好的位置与大小（PO 的 Logo 在左上角，锚点取 left）
  const logoStyle = documentLogoPlacementStyle(documentLogoPlacementFor(letterhead, document.letterheadSnapshot, "PO"), "left");
  const logoHtml = logoUrl
    ? `<img class="cb-logo-image" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(buyerCompany)}"${logoStyle}>`
    : `<span class="cb-logo-text"${logoStyle}>${escapeHtml(buyerBrandText)}</span>`;

  const stamp = state.documentAssets.stamps.find((item) => item.id === document.stampId);
  const signature = state.documentAssets.signatures.find((item) => item.id === document.signatureId);

  const partyRow = (label: string, value: string) => `<div class="cbp-row"><span class="cbp-row-label">${escapeHtml(label)}</span><span class="cbp-row-value">${escapeHtml(value || "")}</span></div>`;

  const itemRows = productItems.map((item, index) => {
    const spec = [item.material, item.finish, item.hsCode && `HS ${item.hsCode}`].filter(Boolean).join(" · ");
    const itemNumber = item.model || item.hsCode || String(index + 1).padStart(2, "0");
    return `<tr>
      <td class="cbp-item-no">${escapeHtml(itemNumber)}</td>
      <td><b>${escapeHtml(documentItemDisplayName(document, item) || "—")}</b>${spec ? `<span class="cbp-item-spec">${escapeHtml(spec)}</span>` : ""}</td>
      <td class="cbp-center">${escapeHtml(`${Number(item.quantity || 0)}${item.unit ? ` ${item.unit}` : ""}`)}</td>
      <td class="cbp-money">${money(Number(item.unitPrice || 0))}</td>
      <td class="cbp-money">${money(Number(item.quantity || 0) * Number(item.unitPrice || 0))}</td>
    </tr>`;
  }).join("");
  const emptyItemRow = `<tr><td class="cbp-item-no"></td><td class="cbp-item-empty">—</td><td class="cbp-center"></td><td class="cbp-money"></td><td class="cbp-money"></td></tr>`;

  const shipmentDate = document.validityDate ? formatLongtecDate(document.validityDate) : "";

  preview.className = "doc-paper custom-b-po";
  preview.dir = isRTL ? "rtl" : "ltr";
  preview.innerHTML = `
    <header class="cbp-head">
      <div class="cb-logo cbp-logo">${logoHtml}</div>
      <b class="cbp-company">${escapeHtml(buyerCompany)}</b>
    </header>
    <section class="cbp-title">
      <h1>${escapeHtml(docTypeTitle(document).toUpperCase())}</h1>
      <div class="cbp-meta">
        <p><b>Order Date:</b><span>${escapeHtml(formatLongtecDate(document.issueDate))}</span></p>
        <p><b>Shipment date:</b><span>${escapeHtml(shipmentDate)}</span></p>
        <p><b>P.O.#:</b><span>${escapeHtml(document.number || "—")}</span></p>
      </div>
    </section>
    <section class="cbp-parties">
      <div class="cbp-party">
        <h3>Vendor</h3>
        <div class="cbp-party-body">
          ${partyRow("Company:", document.seller || "")}
          ${partyRow("Address:", document.sellerAddress || "")}
          ${partyRow("Tel.:", document.sellerPhone || "")}
          ${partyRow("E-mail:", document.sellerEmail || "")}
          ${partyRow("Attn:", document.sellerContact || "")}
        </div>
      </div>
      <div class="cbp-party">
        <h3>Ship to</h3>
        <div class="cbp-party-body">
          ${partyRow("Company:", buyerCompany)}
          ${partyRow("Address:", document.buyerAddress || letterhead?.address || "")}
          ${partyRow("Tel.:", letterhead?.phone || "")}
          ${partyRow("E-mail:", letterhead?.email || "")}
          ${partyRow("Attn:", document.buyerContact || "")}
        </div>
      </div>
    </section>
    <table class="cbp-table cbp-terms-table">
      <thead><tr>
        <th>Condition</th>
        <th>Warranty</th>
        <th>Terms</th>
        <th>Payment Term</th>
        <th>Lead Time</th>
      </tr></thead>
      <tbody><tr>
        <td></td>
        <td></td>
        <td>${escapeHtml(document.incoterm || "")}</td>
        <td>${escapeHtml(document.paymentTerm || "")}</td>
        <td></td>
      </tr></tbody>
    </table>
    <table class="cbp-table cbp-items-table">
      <thead><tr>
        <th class="cbp-item-no">Item Number</th>
        <th>Description</th>
        <th class="cbp-center">Qty</th>
        <th class="cbp-money">Rate</th>
        <th class="cbp-money">Total Amount (${escapeHtml(document.currency || "USD")})</th>
      </tr></thead>
      <tbody>${itemRows || emptyItemRow}</tbody>
      <tfoot>
        <tr class="cbp-shipping-row">
          <td></td>
          <td colspan="3" class="cbp-center">Shipping Fee</td>
          <td class="cbp-money">${shippingTotal ? money(shippingTotal) : ""}</td>
        </tr>
        <tr class="cbp-total-row">
          <td colspan="4">Total</td>
          <td class="cbp-money">${money(total)}</td>
        </tr>
      </tfoot>
    </table>
    <section class="cbp-sign">
      <div class="cbp-sign-cell">
        <h4>Confirmed By: ${escapeHtml(buyerCompany)}</h4>
        <div class="cbp-sign-body">
          ${stamp?.imageUrl ? `<img class="cbp-stamp-image" src="${escapeHtml(stamp.imageUrl)}" alt="${escapeHtml(stamp.name || "stamp")}">` : ""}
        </div>
      </div>
      <div class="cbp-sign-cell">
        <h4>For and on behalf of:</h4>
        <div class="cbp-sign-body">
          ${signature?.imageUrl ? `<img class="cbp-sign-image" src="${escapeHtml(signature.imageUrl)}" alt="${escapeHtml(signature.name || "signature")}">` : ""}
        </div>
      </div>
    </section>
    <section class="cbp-legal">
      <h4>STANDARD PURCHASE ORDER TERMS AND CONDITIONS:</h4>
      <p>The following Standard Purchase Order Terms and Conditions ("Terms"), together with any Buyer specifications, Special Conditions, drawings, master agreement and riders, whether physically attached or incorporated by reference (collectively "Purchase Order") shall constitute the entire and exclusive agreement between Supplier and Buyer for Goods ("Goods"). In the event of a conflict, the order of precedence shall be the Special Conditions, the master agreement, and then these Standard Purchase Order Terms and Conditions.</p>
      <h5>CONDITION AND QUALITY:</h5>
      <p>1. For Brand NEW Goods must be genuine, by original equipment manufacturer, and be new sealed and unused, which shall be defined as, but not limited to, Goods that are not remarked, pulled, refurbished, or have surface blemishes, scratches, cracks, unoriginal markings on the body of the part, or have bent, deformed, retinned, redipped, tarnished, oxidized, burnt or missing leads. Date codes shall be within 2 years.</p>
      <p>For Clean Pull/Grade A: Goods must be genuine, by original equipment manufacturer, which shall be defined as, but not limited to, Goods that are not remarked, refurbished or re-labelled, and which may only show minor cosmetic marks from normal handling.</p>
      ${document.notes ? `<p class="cbp-legal-notes">${escapeHtml(document.notes)}</p>` : ""}
    </section>
  `;

  const meta = qs<HTMLElement>("#docPreviewMeta");
  if (meta) meta.textContent = `PO · ${document.number} · ${money(total)}`;
}

function renderCustomsDocumentPreview(document: TradeDocument, preview: HTMLElement) {
  const total = documentTotal(document);
  const totalWeight = document.items.reduce((sum, item) => sum + (item.weightKg || 0), 0);
  const totalPackages = document.items.reduce((sum, item) => sum + (item.packageCount || 0), 0);
  const lang = document.language || "EN";
  const isRTL = lang === "AR";
  const theme = DOC_THEMES[document.templateStyle] || DOC_THEMES.rose;
  const L = (k: string) => docLabel(document, k);
  const showMaterial = document.items.some((item) => Boolean(item.material?.trim()));
  const showFinish = document.items.some((item) => Boolean(item.finish?.trim()));
  const itemGridColumns = [
    "34px", "minmax(0,1.8fr)", "minmax(0,.9fr)",
    ...(showMaterial ? ["minmax(0,.9fr)"] : []),
    ...(showFinish ? ["minmax(0,.9fr)"] : []),
    "minmax(0,1.05fr)", "minmax(0,.85fr)", "minmax(0,.9fr)",
    "minmax(0,1fr)", "minmax(0,.8fr)", "minmax(0,.75fr)", "minmax(0,.65fr)"
  ].join(" ");

  preview.className = `doc-paper customs-preview-modern ${document.templateStyle}`;
  preview.style.setProperty("--doc-primary", theme.primary);
  preview.style.setProperty("--doc-light", theme.light);
  preview.style.setProperty("--doc-text", theme.text);
  preview.dir = isRTL ? "rtl" : "ltr";

  preview.innerHTML = `
    <div class="customs-hero" style="background:${theme.light};border-${isRTL?"right":"left"}:4px solid ${theme.primary};">
      <div class="customs-hero-icon" style="color:${theme.primary};">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18"/>
          <path d="M9 21V9"/>
        </svg>
      </div>
      <div class="customs-hero-content">
        <h2 style="color:${theme.primary};">${L("customsTitle")}</h2>
        <p>${L("customsSub")}</p>
      </div>
      <div class="customs-hero-badge">
        <span class="customs-status-badge" style="color:${theme.primary};background:${theme.light};">${documentStatusText(document.status)}</span>
      </div>
    </div>

    <div class="customs-meta-bar" style="border-color:${theme.primary}33;">
      <div class="customs-meta-item">
        <span class="meta-label">${L("no")}</span>
        <span class="meta-value">${escapeHtml(document.number)}</span>
      </div>
      <div class="customs-meta-item">
        <span class="meta-label">${L("exportDate")}</span>
        <span class="meta-value">${escapeHtml(document.issueDate)}</span>
      </div>
      <div class="customs-meta-item">
        <span class="meta-label">${L("totalAmount")}</span>
        <span class="meta-value highlight" style="color:${theme.primary};">${formatDocumentMoney(total, document.currency)}</span>
      </div>
    </div>

    <div class="customs-docs-grid">
      <div class="customs-doc-card" style="border-color:${theme.primary}22;">
        <div class="doc-card-icon">📋</div>
        <div class="doc-card-name">${L("customsDecl")}</div>
      </div>
      <div class="customs-doc-card" style="border-color:${theme.primary}22;">
        <div class="doc-card-icon">🔍</div>
        <div class="doc-card-name">${L("declElements")}</div>
      </div>
      <div class="customs-doc-card" style="border-color:${theme.primary}22;">
        <div class="doc-card-icon">🧾</div>
        <div class="doc-card-name">${L("invoice")}</div>
      </div>
      <div class="customs-doc-card" style="border-color:${theme.primary}22;">
        <div class="doc-card-icon">📦</div>
        <div class="doc-card-name">${L("packingListShort")}</div>
      </div>
      <div class="customs-doc-card" style="border-color:${theme.primary}22;">
        <div class="doc-card-icon">📄</div>
        <div class="doc-card-name">${L("contractDoc")}</div>
      </div>
      <div class="customs-doc-card" style="border-color:${theme.primary}22;">
        <div class="doc-card-icon">✍️</div>
        <div class="doc-card-name">${L("authorization")}</div>
      </div>
      <div class="customs-doc-card" style="border-color:${theme.primary}22;">
        <div class="doc-card-icon">📖</div>
        <div class="doc-card-name">${L("fillingGuide")}</div>
      </div>
    </div>

    <div class="customs-info-cards">
      <div class="customs-info-card" style="border-color:${theme.primary}22;">
        <div class="info-card-header">
          <div class="info-card-icon">🏭</div>
          <h3 style="color:${theme.primary};">${L("shipperInfo")}</h3>
        </div>
        <div class="info-card-body">
          <div class="info-item">
            <label>${L("companyName")}</label>
            <span>${escapeHtml(document.seller)}</span>
          </div>
          <div class="info-item">
            <label>${L("companyAddress")}</label>
            <span>${escapeHtml(document.sellerAddress)}</span>
          </div>
        </div>
      </div>

      <div class="customs-info-card" style="border-color:${theme.primary}22;">
        <div class="info-card-header">
          <div class="info-card-icon">🌍</div>
          <h3 style="color:${theme.primary};">${L("consigneeInfo")}</h3>
        </div>
        <div class="info-card-body">
          <div class="info-item">
            <label>${L("companyName")}</label>
            <span>${escapeHtml(document.buyer)}</span>
          </div>
          <div class="info-item">
            <label>${L("companyAddress")}</label>
            <span>${escapeHtml(document.buyerAddress)}</span>
          </div>
          <div class="info-item">
            <label>${L("contactInfo")}</label>
            <span>${escapeHtml(document.buyerContact)}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="customs-transport-card" style="border-color:${theme.primary}22;">
      <div class="info-card-header">
        <div class="info-card-icon">🚢</div>
        <h3 style="color:${theme.primary};">${L("transportInfo")}</h3>
      </div>
      <div class="transport-grid">
        <div class="transport-item">
          <div class="transport-icon">📍</div>
          <div class="transport-content">
            <label>${L("portLoading")}</label>
            <span>${escapeHtml(document.portLoading)}</span>
          </div>
        </div>
        <div class="transport-item">
          <div class="transport-icon">🎯</div>
          <div class="transport-content">
            <label>${L("portDischarge")}</label>
            <span>${escapeHtml(document.portDischarge)}</span>
          </div>
        </div>
        <div class="transport-item">
          <div class="transport-icon">🚛</div>
          <div class="transport-content">
            <label>${L("shipment")}</label>
            <span>${escapeHtml(document.shippingMethod)}</span>
          </div>
        </div>
        <div class="transport-item">
          <div class="transport-icon">⚖️</div>
          <div class="transport-content">
            <label>${L("totalGrossWeight")}</label>
            <span>${totalWeight.toFixed(2)} KG</span>
          </div>
        </div>
        <div class="transport-item">
          <div class="transport-icon">📦</div>
          <div class="transport-content">
            <label>${L("packageCount")}</label>
            <span>${totalPackages}</span>
          </div>
        </div>
        <div class="transport-item">
          <div class="transport-icon">💼</div>
          <div class="transport-content">
            <label>${L("tradeTerms")}</label>
            <span>${escapeHtml(document.incoterm)}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="customs-items-section">
      <div class="info-card-header">
        <div class="info-card-icon">📝</div>
        <h3 style="color:${theme.primary};">${L("goodsList")}</h3>
        <span class="items-count">${document.items.length} ${L("itemsUnit")}</span>
      </div>
      <div class="customs-items-modern-table" style="--customs-item-columns:${itemGridColumns};">
        <div class="table-header" style="background:${theme.primary};">
          <div class="th th-num">#</div>
          <div class="th th-product">${L("goodsName")}</div>
          <div class="th">${L("model")}</div>
          ${showMaterial ? `<div class="th">Material</div>` : ""}
          ${showFinish ? `<div class="th">Finish</div>` : ""}
          <div class="th">${L("hsCode")}</div>
          <div class="th th-qty">${L("qty")}</div>
          <div class="th th-price">${L("unitPrice")}</div>
          <div class="th th-amount">${L("amount")}</div>
          <div class="th">${L("origin")}</div>
          <div class="th">${L("weight")}</div>
          <div class="th">${L("pkgs")}</div>
        </div>
        ${document.items.map((item, index) => `
          <div class="table-row">
            <div class="td td-num">${index + 1}</div>
            <div class="td td-product"><strong>${escapeHtml(documentItemDisplayName(document, item))}</strong></div>
            <div class="td">${escapeHtml(item.model)}</div>
            ${showMaterial ? `<div class="td">${escapeHtml(item.material || "")}</div>` : ""}
            ${showFinish ? `<div class="td">${escapeHtml(item.finish || "")}</div>` : ""}
            <div class="td"><code>${escapeHtml(item.hsCode)}</code></div>
            <div class="td td-qty">${item.quantity} <small>${escapeHtml(item.unit)}</small></div>
            <div class="td td-price">${formatDocumentTableMoney(item.unitPrice)}</div>
            <div class="td td-amount"><strong>${formatDocumentTableMoney(item.quantity * item.unitPrice)}</strong></div>
            <div class="td">${escapeHtml(item.originCountry || "China")}</div>
            <div class="td">${item.weightKg || 0} kg</div>
            <div class="td">${item.packageCount || 0}</div>
          </div>
        `).join("")}
        <div class="table-footer" style="border-top:2px solid ${theme.primary};">
          <div class="footer-label">${L("totalAmount")}</div>
          <div class="footer-values">
            <div class="footer-item">
              <label>${L("totalAmount")}</label>
              <span class="footer-highlight" style="color:${theme.primary};">${formatDocumentMoney(total, document.currency)}</span>
            </div>
            <div class="footer-item">
              <label>${L("totalWeight")}</label>
              <span>${totalWeight.toFixed(2)} KG</span>
            </div>
            <div class="footer-item">
              <label>${L("totalPackages")}</label>
              <span>${totalPackages}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="customs-payment-card" style="border-color:${theme.primary}22;">
      <div class="info-card-header">
        <div class="info-card-icon">💰</div>
        <h3 style="color:${theme.primary};">${L("paymentTradeTerms")}</h3>
      </div>
      <div class="payment-grid">
        <div class="payment-item">
          <label>${L("currency")}</label>
          <span class="payment-badge" style="color:${theme.primary};background:${theme.light};">${escapeHtml(document.currency)}</span>
        </div>
        <div class="payment-item">
          <label>${L("tradeTerms")}</label>
          <span class="payment-badge" style="color:${theme.primary};background:${theme.light};">${escapeHtml(document.incoterm)}</span>
        </div>
        <div class="payment-item payment-term">
          <label>${L("paymentCondition")}</label>
          <span>${escapeHtml(document.paymentTerm)}</span>
        </div>
      </div>
    </div>

    <div class="customs-footer-notice"><div class="notice-content"><p class="notice-warning" style="color:${theme.primary};">${L("customsNotice")}</p></div></div>
  `;

  const meta = qs<HTMLElement>("#docPreviewMeta");
  if (meta) meta.textContent = `${L("customsTitle")} · ${document.number} · ${formatDocumentMoney(total, document.currency)}`;
}

export function addDocumentItem() {
  const draft = collectDocumentDraft();
  draft.items.push({ id: `item_${Date.now()}`, product: "", model: "", hsCode: "", quantity: 1, unit: "PCS", unitPrice: 0, originCountry: "", weightKg: 0, packageCount: 0 });
  renderDocumentItems(draft.items);
  renderDocumentPreview(draft);
}

export function openNewDocument() {
  state.selectedDocumentId = "__new__";
  fillDocumentEditor(defaultTradeDocument(currentDocumentType()));
  qsa<HTMLElement>(".doc-list-card").forEach((card) => card.classList.remove("active"));
  toast("已创建单据草稿，保存后写入数据库");
}

export function renderDocThemeSwatches(activeTheme?: string) {
  const wrap = qs<HTMLElement>("#docThemeSwatches");
  if (!wrap) return;
  const themes = [
    { id: "indigo", color: "#3157d5" }, { id: "emerald", color: "#059669" },
    { id: "rose", color: "#e11d48" }, { id: "slate", color: "#475569" },
    { id: "amber", color: "#d97706" }
  ];
  const current = activeTheme || qs<HTMLSelectElement>("#docThemeInput")?.value || "rose";
  wrap.innerHTML = themes.map((t) =>
    `<button type="button" class="doc-swatch-btn${t.id === current ? " active" : ""}" data-theme-swatch="${t.id}" title="${t.id}" style="background:${t.color};color:${t.color};"></button>`
  ).join("");
  qsa<HTMLButtonElement>("[data-theme-swatch]", wrap).forEach((btn) => {
    btn.addEventListener("click", () => {
      const themeId = btn.dataset.themeSwatch || "rose";
      const th = qs<HTMLSelectElement>("#docThemeInput");
      const tpl = qs<HTMLSelectElement>("#docTemplateInput");
      if (th) th.value = themeId;
      if (tpl && !DOC_PINNED_TEMPLATE_STYLES.has(tpl.value)) tpl.value = themeId;
      renderDocThemeSwatches(themeId);
      renderDocumentPreview(collectDocumentDraft());
    });
  });
}

export function applyDataSource(source: string) {
  if (source === "manual") return;
  const draft = collectDocumentDraft();
  if (source === "deal") {
    const dealId = qs<HTMLSelectElement>("#docDealInput")?.value;
    const deal = state.deals.find((d) => d.id === dealId);
    if (!deal) { toast("请先选择关联商机", "error"); return; }
    const customer = state.customers.find((c) => c.id === deal.customerId);
    if (customer) {
      const vals: Record<string, string> = {
        docBuyerInput: customerDocumentName(customer),
        docBuyerAddressInput: customer.billingAddress?.trim() || "",
        docBuyerContactInput: customer.documentContact?.trim() || customer.contact,
        docIncotermInput: customer.defaultIncoterm?.trim() || "DAP",
        docPaymentInput: customer.defaultPaymentTerm?.trim() || "T/T 100% in advance",
        docPortDischargeInput: customer.defaultPortDischarge?.trim() || ""
      };
      Object.entries(vals).forEach(([id, v]) => { const el = qs<HTMLInputElement | HTMLSelectElement>(`#${id}`); if (el) el.value = v; });
    }
    if (deal.currency) { const c = qs<HTMLSelectElement>("#docCurrencyInput"); if (c) c.value = deal.currency; }
    applyMatchedSellerToEditor(customer, deal);
    // 从商机关联的产品填充行项目
    const dealProducts = (state as any).dealProducts?.filter((dp: any) => dp.dealId === deal.id) || [];
    if (dealProducts.length) {
      draft.items = dealProducts.map((dp: any, i: number) => {
        const product = (state as any).products?.find((p: any) => p.id === dp.productId);
        return {
          id: `item_${Date.now()}_${i}`, productId: product?.id || dp.productId || "", product: product?.name || dp.productName || "",
          model: product?.model || dp.model || "", hsCode: product?.hsCode || "",
          quantity: dp.quantity || 1, unit: dp.unit || product?.unit || "PCS",
          unitPrice: dp.unitPrice || product?.unitPrice || 0,
          originCountry: product?.originCountry || "China",
          weightKg: product?.weightKg || 0, packageCount: product?.packageCount || 0
        };
      });
    }
    toast("已从商机填充单据信息");
  } else if (source === "customer") {
    const customerId = qs<HTMLSelectElement>("#docCustomerInput")?.value;
    const customer = state.customers.find((c) => c.id === customerId);
    if (!customer) { toast("请先选择关联客户", "error"); return; }
    applyDocumentCustomerDefaults(customerId || "");
    toast("已从客户填充单据信息");
  } else if (source === "product") {
    openProductPicker();
  }
  renderDocumentPreview(collectDocumentDraft());
  // 重置为手动
  const ds = qs<HTMLSelectElement>("#docDataSourceInput");
  if (ds) ds.value = "manual";
}

function showPdfExportLoading(): HTMLElement {
  qs<HTMLElement>("#pdfExportLoading")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "pdfExportLoading";
  overlay.className = "pdf-export-overlay";
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-label", "正在导出 PDF");
  overlay.innerHTML = `<div class="pdf-export-box"><div class="pdf-export-spinner"></div><div class="pdf-export-text">正在导出 PDF…<small>正在渲染单据画面并生成文件，请稍候</small></div></div>`;
  document.body.appendChild(overlay);
  return overlay;
}

export async function exportTradeDocumentPdf() {
  const loading = showPdfExportLoading();
  try {
    await exportTradeDocumentPdfInner();
  } finally {
    loading.remove();
  }
}

async function exportTradeDocumentPdfInner() {
  const current = activeTradeDocument();
  const draft = collectDocumentDraft();
  let saved: TradeDocument | null = null;
  let createdRevision = false;
  try {
    if (current.id !== "__new__" && (current.status === "approved" || current.status === "exported")) {
      saved = documentDraftHasChanges(draft, current)
        ? await saveLockedDocumentDraftAsRevision(current, draft)
        : current;
      createdRevision = saved.id !== current.id;
    } else {
      saved = await saveTradeDocument();
    }
    if (!saved) return;
    const preview = qs<HTMLElement>("#documentPreview");
    if (!preview) {
      toast("未找到单据预览，无法导出", "error");
      return;
    }
    const fileName = `${saved.number || "document"}-${saved.type}.pdf`;
    if (saved.status === "approved" || saved.status === "exported") {
      try {
        const result = await api<{ document: TradeDocument; job: ImportExportJob; fileName: string }>(`/api/trade-documents/${saved.id}/export`, { method: "POST" });
        state.tradeDocuments = state.tradeDocuments.map((document) => document.id === result.document.id ? result.document : document);
        state.jobs.unshift(result.job);
        renderTradeDocuments(state.tradeDocuments);
        renderJobs(state.jobs);
      } catch (error) {
        toast(`正式导出记录失败，继续下载当前 PDF：${error instanceof Error ? error.message : "请求失败"}`, "error");
      }
    } else if (createdRevision) {
      toast("已另存为新版本，已导出当前修改内容；如需正式导出请提交审批");
    } else {
      toast("单据尚未审批，已直接导出当前预览 PDF");
    }
    await downloadDocumentPdf(qs<HTMLElement>("#documentPreview") || preview, fileName);
  } catch (error) {
    toast(error instanceof Error ? error.message : "单据 PDF 导出失败", "error");
  }
}

export function printDocumentPreview() {
  const preview = qs<HTMLElement>("#documentPreview");
  if (!preview) {
    window.print();
    return;
  }
  qs<HTMLElement>(".print-only-document")?.remove();
  const clone = preview.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.className = `${preview.className} print-only-document`;
  document.body.appendChild(clone);
  const cleanup = () => {
    clone.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
  window.setTimeout(cleanup, 30000);
}

// 单据 PDF 的位图压缩级别（jsPDF addImage 的第 8 个参数）。
// 不传这一项时 jsPDF 走 image_compression.NONE，整页位图按原始 RGB 落盘
// （1588×2246×3 ≈ 10.7MB），一页报价单就是 10MB。
// FAST = Flate + PNG Predictor，视觉无损、体积约 1/45。
// 所有单据类型（PI / CI / 报关资料 / 装箱单 / 合同 / 报价单 / 原产地证 / 装运通知）都走
// downloadDocumentPdf 这一条链路，压缩级别只在这里定义一次 —— 新增单据类型不要再另写导出。
const DOCUMENT_PDF_IMAGE_COMPRESSION = "FAST";

// 唯一允许调用 addImage 的地方：把一页位图贴到 PDF 上。
// 抽成函数是为了让「漏传压缩级别」在结构上不可能发生，也让 self-test 只需守一个出口。
function addDocumentPdfPage(
  pdf: import("jspdf").jsPDF,
  dataUrl: string,
  alias: string,
  x: number,
  y: number,
  width: number,
  height: number
) {
  pdf.addImage(dataUrl, "PNG", x, y, width, height, alias, DOCUMENT_PDF_IMAGE_COMPRESSION);
}

// 直接把单据预览渲染成彩色 PDF 并下载，绕开浏览器打印对话框（避免背景色丢失）
async function downloadDocumentPdf(preview: HTMLElement, fileName: string) {
  let captureHost: HTMLDivElement | null = null;
  try {
    const { toPng } = await import("html-to-image");
    const { jsPDF } = await import("jspdf");
    // html-to-image 使用浏览器原生渲染（SVG foreignObject），完整支持 color-mix / oklch /
    // color() 等现代 CSS 颜色函数。html2canvas 1.4.1 解析不了这些颜色会直接抛
    // "Attempting to parse an unsupported color function" 并降级到无背景的打印预览（黑屏）。
    // Capture an isolated A4-width copy. The live preview can be narrower
    // than A4 inside the three-column studio; capturing it directly lets its
    // auto-centering margin shift the image and clips the right-hand columns.
    // html-to-image also defaults to clientHeight, so the copy must expose its
    // full scrollHeight before it is converted to an image.
    const captureWidth = 794;
    captureHost = document.createElement("div");
    captureHost.setAttribute("aria-hidden", "true");
    Object.assign(captureHost.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      width: `${captureWidth}px`,
      overflow: "visible",
      pointerEvents: "none",
      opacity: "0",
      background: "#ffffff",
      zIndex: "-1",
    });
    const capture = preview.cloneNode(true) as HTMLElement;
    capture.removeAttribute("id");
    Object.assign(capture.style, {
      width: `${captureWidth}px`,
      maxWidth: "none",
      height: "auto",
      margin: "0",
      overflow: "visible",
      boxSizing: "border-box",
    });
    captureHost.appendChild(capture);
    document.body.appendChild(captureHost);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const captureHeight = Math.max(capture.scrollHeight, Math.ceil(capture.getBoundingClientRect().height), capture.clientHeight);
    const dataUrl = await toPng(capture, {
      width: captureWidth,
      height: captureHeight,
      pixelRatio: 2,
      backgroundColor: "#ffffff",
      cacheBust: true,
    });
    const img = new Image();
    img.src = dataUrl;
    await new Promise<void>((resolve) => { img.onload = () => resolve(); });
    const imgData = dataUrl;
    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgW = pageW;
    const imgH = (naturalH * imgW) / naturalW;
    // 两个老坑，都出在这一段：
    // ① 位图压缩级别见 DOCUMENT_PDF_IMAGE_COMPRESSION：漏传就是 10MB/页。
    // ② 一页 A4 在 794px 宽下正好是 1122.9px，而元素高度取整后是 1123px → imgH=297.015mm，
    //    比 297mm 多出 0.015mm，`while (heightLeft > 0)` 就必然再吐一张几乎空白的第二页，
    //    于是「预览只有一张，打印出来两张」。给一点点容差，宁可整体缩 2% 也不要甩出空白页。
    const ONE_PAGE_TOLERANCE = 1.02;
    const IMAGE_ALIAS = "doc-page";   // 同一张位图只嵌进 PDF 一次，分页时复用
    if (imgH <= pageH * ONE_PAGE_TOLERANCE) {
      const scale = imgH > pageH ? pageH / imgH : 1;
      const drawW = pageW * scale;
      const drawH = imgH * scale;
      addDocumentPdfPage(pdf, imgData, IMAGE_ALIAS, (pageW - drawW) / 2, 0, drawW, drawH);
    } else {
      let heightLeft = imgH;
      let position = 0;
      addDocumentPdfPage(pdf, imgData, IMAGE_ALIAS, 0, position, imgW, imgH);
      heightLeft -= pageH;
      // 余量不足 1mm 时不再另起一页：那点内容肉眼看不见，只会变成一张空白纸
      while (heightLeft > 1) {
        position -= pageH;
        pdf.addPage();
        addDocumentPdfPage(pdf, imgData, IMAGE_ALIAS, 0, position, imgW, imgH);
        heightLeft -= pageH;
      }
    }
    pdf.save(fileName);
    toast("PDF 已导出");
  } catch (err) {
    toast(err instanceof Error ? `PDF 生成失败：${err.message}` : "PDF 生成失败", "error");
    // 降级：仍走浏览器打印
    printDocumentPreview();
  } finally {
    captureHost?.remove();
  }
}

function parseNumberCell(value: unknown, fallback = 0) {
  const text = String(value ?? "").replace(/[,$￥¥\s]/g, "");
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMPORT_EXTENSIONS = new Set(["xlsx", "xls", "csv"]);

export function assertImportFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED_IMPORT_EXTENSIONS.has(extension)) {
    throw new Error("仅支持 XLSX、XLS 或 CSV 文件");
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error("导入文件不能超过 5 MB");
  }
}

async function parseCustomerImportFile(file: File): Promise<CustomerImportRow[]> {
  assertImportFile(file);
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", dense: true, sheetRows: 2002 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (rows.length > 2000) throw new Error("客户导入单次最多支持 2000 行");
  return rows.map((row, index) => {
    const customerId = String(rowValue(row, ["客户ID", "客户 ID", "customerId", "Customer ID", "id", "ID"]) || "").trim();
    const company = String(rowValue(row, ["公司简称", "公司名", "客户", "客户名称", "公司", "客户公司", "company", "Company"])).trim();
    const whatsappInput = String(rowValue(row, ["WhatsApp", "Whatsapp", "whatsapp", "WA号码", "WhatsApp号码"]) || "").trim();
    const whatsapp = whatsappInput ? normalizeWhatsAppPhone(whatsappInput) : "";
    if (whatsappInput && !whatsapp) throw new Error(`第 ${index + 2} 行 WhatsApp 号码无效，请填写含国家码的号码`);
    const lifecycleText = String(rowValue(row, ["成交状态", "客户状态", "状态", "Lifecycle Status", "lifecycleStatus"]) || "").trim().toLowerCase();
    const lifecycleStatus = ["已成交", "成交", "won", "closed won", "yes", "是"].includes(lifecycleText)
      ? "won" as const
      : ["未成交", "open", "active", "no", "否"].includes(lifecycleText)
        ? "open" as const
        : undefined;
    if (lifecycleText && !lifecycleStatus) throw new Error(`第 ${index + 2} 行成交状态无效，请填写“已成交”或“未成交”`);
    return {
      customerId,
      company,
      companyFullName: String(rowValue(row, ["公司全名", "公司全称", "正式公司名", "法定公司名", "单据公司全名", "Company Full Name", "companyFullName", "legalName"]) || "").trim(),
      country: String(rowValue(row, ["国家", "市场", "country", "Country"]) || "未知").trim(),
      contact: String(rowValue(row, ["联系人", "联系人姓名", "contact", "Contact"]) || "待维护").trim(),
      whatsapp,
      stage: String(rowValue(row, ["阶段", "客户阶段", "stage", "Stage"]) || "询盘").trim(),
      amount: parseNumberCell(rowValue(row, ["预计金额", "金额", "商机金额", "amount", "Amount"])),
      health: Math.max(0, Math.min(100, Math.round(parseNumberCell(rowValue(row, ["健康度", "评分", "health", "Health"]), 70)))),
      source: String(rowValue(row, ["客户来源", "来源", "获客渠道", "来源渠道", "Customer Source", "source", "Source"]) || "批量导入").trim(),
      lifecycleStatus,
      nextReminder: String(rowValue(row, ["下一提醒", "提醒", "下次跟进", "nextReminder", "Next Reminder"]) || "待跟进").trim(),
      phone: String(rowValue(row, ["电话", "手机号", "联系电话", "Phone", "Tel", "phone", "Telephone"]) || "").trim(),
      email: String(rowValue(row, ["邮箱", "电子邮件", "Email", "email", "E-mail"]) || "").trim(),
      contactRemark: String(rowValue(row, ["联系方式备注", "联系方式说明", "其它渠道", "其他渠道", "Contact Remark", "contactRemark", "contact_note"]) || "").trim(),
      website: String(rowValue(row, ["官网", "网站", "Website", "website", "URL", "主页"]) || "").trim(),
      wecomBound: false
    };
  }).filter((row) => row.company);
}

export async function importCustomersFromFile(button?: HTMLButtonElement) {
  const input = qs<HTMLInputElement>("#customerImportInput");
  const file = input?.files?.[0];
  if (!file) {
    toast("请先选择 Excel 或 CSV 客户文件", "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "导入中";
    }
    const rows = await parseCustomerImportFile(file);
    if (!rows.length) {
      toast("未识别到有效客户，请检查公司名表头", "error");
      return;
    }
    const result = await api<{ result: { created: number; updated: number; skipped: number; total: number }; job: ImportExportJob; customers: Customer[] }>("/api/import-export/customers/import", {
      method: "POST",
      body: JSON.stringify({ fileName: file.name, rows })
    });
    state.customers = result.customers;
    state.jobs.unshift(result.job);
    state.selectedCustomerId = result.customers[0]?.id || state.selectedCustomerId;
    renderCustomers(state.customers);
    renderJobs(state.jobs);
    renderTopbarStats();
    void refreshDashboardOnly();
    toast(`导入完成：新增 ${result.result.created}，更新 ${result.result.updated}，共 ${result.result.total} 行`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "客户导入失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "导入客户";
    }
  }
}

export async function exportCustomers() {
  try {
    const result = await api<{ customers: Customer[]; job: ImportExportJob }>("/api/import-export/customers/export", { method: "POST" });
    const rows = result.customers.map((customer) => ({
      客户ID: customer.id,
      公司简称: customer.company,
      公司全名: customerDocumentName(customer),
      国家: customer.country,
      联系人: customer.contact,
      WhatsApp: customer.whatsapp || customer.whatsappPhone || "",
      最高活跃商机阶段: customer.pipelineStage || "暂无活跃商机",
      活跃商机数: customer.activeDealCount || 0,
      在手商机额: customer.pipelineAmount || 0,
      健康度: customer.health,
      客户来源: customer.source || "未登记",
      成交状态: customer.hasWonDeal ? "已成交" : "未成交",
      下一提醒: customer.nextReminder,
      电话: customer.phone || "",
      邮箱: customer.email || "",
      "联系方式备注（其它渠道）": customer.contactRemark || "",
      官网: customer.website || "",
      通讯接入: "待接入"
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "客户清单");
    XLSX.writeFile(workbook, `GoodJob客户清单-${Date.now()}.xlsx`);
    state.jobs.unshift(result.job);
    renderJobs(state.jobs);
    toast(`客户已导出：${rows.length} 行`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "客户导出失败", "error");
  }
}

export function downloadCustomerTemplate() {
  const worksheet = XLSX.utils.aoa_to_sheet([["客户ID", "公司简称", "公司全名", "国家", "联系人", "电话", "邮箱", "联系方式备注（其它渠道）", "官网", "客户来源", "成交状态", "阶段", "预计金额", "健康度", "下一提醒"]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "客户导入模板");
  XLSX.writeFile(workbook, "GoodJob客户导入模板.xlsx");
  toast("客户导入模板已下载");
}
