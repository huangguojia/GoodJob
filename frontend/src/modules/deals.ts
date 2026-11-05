/**
 * 商机管道、报关预览、商机详情与归档。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, confirmAction, openModal, state } from "../prototype-api";
import {
  type CommissionCalculation, type CommissionItem, type CommissionOwner, type CommissionProduct, type CommissionRule,
  type Customer, type CustomsDocument, type CustomsGenerationSource, type Deal, type DealEvent, type DealItem,
  type DealRecommendation, type DocumentLetterhead, type MonthlySalesRecord, type TradeDocument,
  type TradeDocumentItem
} from "./models";
import { refreshDashboardOnly } from "./dashboard";
import { badge, cookieValue, currencyAmount, escapeHtml, qs, qsa } from "./shared";
import { loadProspectFeedback } from "./lead-finder";
import { dealItemsOf, dealItemsSummary, dealProductsText } from "./customer-detail";
import { api, setButtonPending, toast } from "./ui";
import { customerDocumentName } from "./leads";
import { renderCommission } from "./commission";
import {
  defaultTradeDocument, documentTypeLabel, fillDocumentEditor, formatDocumentTableMoney, openQuoteHistoryForDeal,
  todayDateInput
} from "./trade-documents";
import { openOrderDetail } from "./orders";

export function renderPipeline(deals: Deal[]) {
  const strip = qs<HTMLElement>("#pipeline .pipeline-strip");
  if (!strip) return;
  const activeDeals = deals.filter((deal) => !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单");
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判"];
  if (!stages.includes(state.pipelineStageFilter)) state.pipelineStageFilter = stages[0];
  const today = todayDateInput();
  const filtered = activeDeals.filter((deal) => {
    const customer = state.customers.find((item) => item.id === deal.customerId);
    const haystack = `${deal.title} ${dealProductsText(deal)} ${customer?.company || ""} ${customer?.companyFullName || ""} ${customer?.id || ""}`.toLowerCase();
    if (state.pipelineSearch && !haystack.includes(state.pipelineSearch.toLowerCase())) return false;
    if (state.pipelineDueFilter === "overdue") return Boolean(deal.nextActionAt && deal.nextActionAt < today);
    if (state.pipelineDueFilter === "today") return deal.nextActionAt === today;
    if (state.pipelineDueFilter === "future") return Boolean(deal.nextActionAt && deal.nextActionAt > today);
    return true;
  });
  renderPipelineSummary(activeDeals);
  renderPipelineStageTabs(stages, filtered);
  strip.innerHTML = stages.map((stage) => {
    const stageDeals = filtered.filter((deal) => deal.stage === stage);
    const stageAmount = stageDeals.reduce((sum, deal) => sum + deal.amount, 0);
    const overdue = stageDeals.filter((deal) => deal.nextActionAt && deal.nextActionAt < today).length;
    return `<section class="stage ${stage === state.pipelineStageFilter ? "mobile-active" : ""}" data-pipeline-stage="${stage}" aria-label="${stage}阶段">
      <div class="stage-head"><span class="stage-head-main"><b>${stage}</b><small>${stageDeals.length} 个 · ${dealMoney(stageAmount, stageDeals[0]?.currency || "USD")}${overdue ? ` · ${overdue} 个逾期` : ""}</small></span><b>${stageDeals.length}</b></div>
      ${stageDeals.map((deal) => {
      const customer = state.customers.find((item) => item.id === deal.customerId);
      const isOverdue = Boolean(deal.nextActionAt && deal.nextActionAt < today);
      const hasDocument = state.tradeDocuments.some((document) => document.dealId === deal.id);
      return `<article class="deal" data-deal-id="${escapeHtml(deal.id)}" tabindex="0">
        <b>${escapeHtml(deal.title)}</b>
        <span class="deal-customer">${escapeHtml(customer?.company || "客户待确认")} · ${escapeHtml(customer?.country || "未知国家")}</span>
        <span class="deal-product">${escapeHtml(dealItemsSummary(deal))}</span>
        <span>${escapeHtml(deal.nextAction)}</span>
        <span class="deal-date ${isOverdue ? "overdue" : ""}">${isOverdue ? "已逾期" : "下一动作"} · ${escapeHtml(deal.nextActionAt || "待安排")}</span>
        <span class="deal-doc-status">${hasDocument ? "已关联单据" : "未关联单据"} · 预计成交 ${escapeHtml(deal.expectedCloseAt || "待评估")}</span>
        <div class="deal-foot"><span>${dealMoney(deal.amount, deal.currency)}</span>${badge(deal.stage, deal.stage === "已报价" ? "amber" : "")}</div>
        <div class="deal-actions">
          <button class="btn primary deal-primary-action" data-move-deal>${dealPrimaryAction(deal.stage)}</button>
          <div class="deal-secondary-actions">
            <button type="button" class="btn" data-record-deal>记录进展</button>
            <button type="button" class="btn" data-copy-deal>复制商机</button>
            ${deal.stage === "已联系" ? `<button type="button" class="btn" data-generate-deal-quotation>生成报价单</button>` : ""}
            ${["已报价", "样品", "谈判"].includes(deal.stage) ? `<button type="button" class="btn" data-print-deal-document>生成 PI</button>` : ""}
            ${["已报价", "样品", "谈判", "成交"].includes(deal.stage) ? `<button type="button" class="btn" data-generate-customs>生成报关资料</button>` : ""}
            <button type="button" class="btn danger" data-lost-deal>标记丢单</button>
          </div>
        </div>
      </article>`;
    }).join("") || `<div class="deal-empty">当前阶段暂无匹配商机</div>`}
    </section>`;
  }).join("");
  qsa<HTMLElement>(".deal[data-deal-id]", strip).forEach((card) => {
    const open = () => openDealDrawer(card.dataset.dealId || "");
    card.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button, summary, details")) return;
      open();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
  });
  qsa<HTMLButtonElement>("[data-record-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => openDealEventModal(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  qsa<HTMLButtonElement>("[data-copy-deal]", strip).forEach((button) => {
    button.addEventListener("click", (event) => void duplicateDeal(button.closest<HTMLElement>(".deal")?.dataset.dealId || "", event.currentTarget as HTMLButtonElement));
  });
  qsa<HTMLButtonElement>("[data-print-deal-document]", strip).forEach((button) => {
    button.addEventListener("click", () => void printDealDocument(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  qsa<HTMLButtonElement>("[data-generate-deal-quotation]", strip).forEach((button) => {
    button.addEventListener("click", () => void printDealDocument(button.closest<HTMLElement>(".deal")?.dataset.dealId || "", "QUOTATION"));
  });
  qsa<HTMLButtonElement>("[data-generate-customs]", strip).forEach((button) => {
    button.addEventListener("click", () => void generateCustomsDocument(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  qsa<HTMLButtonElement>("[data-move-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => openDealStageModal(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  qsa<HTMLButtonElement>("[data-lost-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => void markDealLost(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
}

export function dealMoney(value: number, currency = "USD") {
  return `${escapeHtml(currency || "USD")} ${Math.round(Number(value || 0)).toLocaleString("en-US")}`;
}

function dealPrimaryAction(stage: string) {
  return stage === "谈判" ? "确认成交" : "推进阶段";
}

function renderPipelineSummary(activeDeals: Deal[]) {
  const box = qs<HTMLElement>("#pipelineSummary");
  if (!box) return;
  const today = todayDateInput();
  const overdue = activeDeals.filter((deal) => deal.nextActionAt && deal.nextActionAt < today).length;
  const todayCount = activeDeals.filter((deal) => deal.nextActionAt === today).length;
  const missing = activeDeals.filter((deal) => !deal.nextActionAt || !deal.expectedCloseAt).length;
  const currencies = [...new Set(activeDeals.map((deal) => deal.currency || "USD"))];
  // 金额卡：单币种 → 数字 + 币种小字；多币种 → 币种数 + 「种币种」，长说明沉到 note 行，别挤数值位。
  const singleCurrency = currencies.length === 1;
  const amountValue = singleCurrency
    ? Math.round(activeDeals.reduce((sum, deal) => sum + deal.amount, 0)).toLocaleString("en-US")
    : String(currencies.length);
  const amountUnit = singleCurrency ? currencies[0] : "种币种";
  const amountNote = singleCurrency
    ? (missing ? `${missing} 个日期待补齐` : "日期完整")
    : `分币种查看 · ${missing ? `${missing} 个日期待补齐` : "日期完整"}`;
  box.innerHTML = [
    { label: "活跃商机", value: String(activeDeals.length), unit: "个", note: "仅含待推进五阶段", tone: "" },
    { label: "动作逾期", value: String(overdue), unit: "个", note: overdue ? "优先处理已过期承诺" : "暂无逾期动作", tone: overdue ? "is-alert" : "" },
    { label: "今天到期", value: String(todayCount), unit: "个", note: "今天应完成的下一动作", tone: todayCount ? "is-brand" : "" },
    { label: "在手金额", value: amountValue, unit: amountUnit, note: amountNote, tone: "" }
  ].map(({ label, value, unit, note, tone }) => `<div class="pipeline-summary-item ${tone}"><span>${label}</span><b>${value}${unit ? `<em>${unit}</em>` : ""}</b><small>${note}</small></div>`).join("");
}

function renderPipelineStageTabs(stages: string[], deals: Deal[]) {
  const box = qs<HTMLElement>("#pipelineStageTabs");
  if (!box) return;
  box.innerHTML = stages.map((stage) => `<button type="button" class="${stage === state.pipelineStageFilter ? "active" : ""}" data-pipeline-stage-tab="${stage}">${stage} ${deals.filter((deal) => deal.stage === stage).length}</button>`).join("");
  qsa<HTMLButtonElement>("[data-pipeline-stage-tab]", box).forEach((button) => {
    button.addEventListener("click", () => {
      state.pipelineStageFilter = button.dataset.pipelineStageTab || stages[0];
      renderPipeline(state.deals);
    });
  });
}

export function controlledDocumentImageUrl(value: string | undefined) {
  const imageUrl = value?.trim() || "";
  return /^\/uploads\/[A-Za-z0-9._-]+\.(?:png|jpe?g)$/i.test(imageUrl) ? imageUrl : "";
}

function sellerProfileMatchScore(profile: DocumentLetterhead, customer: Customer | undefined, currency: string, type: TradeDocument["type"]) {
  if (!profile.enabled) return -1;
  const normalize = (value: string) => value.trim().toLocaleLowerCase();
  const country = normalize(customer?.country || "");
  const countries = (profile.matchCountries || []).map(normalize).filter(Boolean);
  const currencies = (profile.matchCurrencies || []).map((value) => value.trim().toUpperCase()).filter(Boolean);
  const documentTypes = profile.matchDocumentTypes || [];
  if (countries.length && !countries.includes(country)) return -1;
  if (currencies.length && !currencies.includes(currency.trim().toUpperCase())) return -1;
  if (documentTypes.length && !documentTypes.includes(type)) return -1;
  return (countries.length ? 1000 : 0)
    + (currencies.length ? 200 : 0)
    + (documentTypes.length ? 50 : 0)
    + Math.max(0, Math.min(100, profile.matchPriority || 0))
    + (profile.isDefault ? 1 : 0);
}

export function matchedSellerProfile(customer: Customer | undefined, currency: string, type: TradeDocument["type"], explicitId = "", sellerName = "") {
  const available = state.documentAssets.letterheads.filter((item) => item.enabled);
  if (explicitId) return available.find((item) => item.id === explicitId);
  const normalizedSeller = sellerName.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (normalizedSeller) {
    const namedProfile = available.find((item) => item.companyName.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === normalizedSeller);
    if (namedProfile) return namedProfile;
  }
  return available
    .map((item) => ({ item, score: sellerProfileMatchScore(item, customer, currency, type) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || right.item.updatedAt.localeCompare(left.item.updatedAt))[0]?.item;
}

function sellerProfileDocumentDefaults(profile: DocumentLetterhead | undefined): Partial<TradeDocument> {
  if (!profile) return {};
  return {
    seller: profile.companyName,
    sellerAddress: profile.address,
    sellerContact: profile.contact || "",
    sellerPhone: profile.phone,
    sellerEmail: profile.email,
    sellerWebsite: profile.website,
    sellerTaxNo: profile.taxNo || "",
    ...(profile.bankInfo ? { bankInfo: profile.bankInfo } : {}),
    letterheadId: profile.id,
    stampId: profile.stampId || "",
    signatureId: profile.signatureId || ""
  };
}

export function sellerProfileMatchReason(profile: DocumentLetterhead, customer: Customer | undefined, currency: string, type: TradeDocument["type"]) {
  const reasons = [
    profile.matchCountries?.length && customer?.country ? `国家 ${customer.country}` : "",
    profile.matchCurrencies?.length ? `币种 ${currency}` : "",
    profile.matchDocumentTypes?.length ? `单据 ${documentTypeLabel(type)}` : "",
    profile.isDefault ? "默认公司" : ""
  ].filter(Boolean);
  return reasons.join(" · ") || "通用匹配";
}

function tradeDocumentFromDeal(deal: Deal, customer: Customer, requestedType?: TradeDocument["type"]): TradeDocument {
  const type: TradeDocument["type"] = requestedType || (deal.stage === "成交" ? "CI" : "PI");
  const date = todayDateInput();
  const product = dealProductsText(deal) || deal.title;
  const documentItems = dealItemsOf(deal).map((dealItem, index) => {
    const normalizedProduct = dealItem.product.trim().toLowerCase().replace(/[\s_-]+/g, " ");
    const matchedProduct = state.products.find((item) => item.id === dealItem.productId || [item.nameZh, item.nameEn, item.model]
      .some((value) => value.trim().toLowerCase().replace(/[\s_-]+/g, " ") === normalizedProduct));
    return {
      id: `deal_item_${deal.id}_${index + 1}`,
      productId: matchedProduct?.id || dealItem.productId || "",
      imageUrl: controlledDocumentImageUrl(matchedProduct?.imageUrl),
      product: dealItem.product,
      model: dealItem.model || matchedProduct?.model || "",
      hsCode: matchedProduct?.hsCode || "",
      quantity: dealItem.quantity,
      unit: matchedProduct?.unit || "PCS",
      unitPrice: Math.round(dealItem.unitPrice * 100) / 100,
      originCountry: "",
      weightKg: matchedProduct?.packWeight || 0,
      packageCount: 0
    };
  });
  const defaults = defaultTradeDocument(type);
  const sellerProfile = matchedSellerProfile(customer, deal.currency || defaults.currency, type);
  return {
    ...defaults,
    ...sellerProfileDocumentDefaults(sellerProfile),
    id: "__new__",
    customerId: customer.id,
    dealId: deal.id,
    revision: Math.max(0, ...state.tradeDocuments.filter((document) => document.dealId === deal.id && document.type === type).map((document) => document.revision || 1)) + 1,
    type,
    title: `${customer.company} ${product} ${type}`,
    number: `${type}-${date.replace(/-/g, "")}-${Math.floor(Date.now() / 1000).toString().slice(-4)}`,
    issueDate: date,
    buyer: customerDocumentName(customer),
    buyerAddress: customer.billingAddress?.trim() || "",
    buyerContact: customer.documentContact?.trim() || customer.contact,
    currency: deal.currency || "USD",
    incoterm: customer.defaultIncoterm?.trim() || defaults.incoterm,
    paymentTerm: customer.defaultPaymentTerm?.trim() || defaults.paymentTerm,
    portDischarge: customer.defaultPortDischarge?.trim() || "",
    includeProductImages: documentItems.some((item) => Boolean(item.imageUrl)) || defaults.includeProductImages,
    status: "ready",
    audits: [],
    sendRecords: [],
    updatedAt: new Date().toISOString(),
    items: documentItems
  };
}

async function printDealDocument(id: string, requestedType?: TradeDocument["type"]) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const customer = state.customers.find((item) => item.id === deal.customerId);
  if (!customer) {
    toast("请先给商机关联客户，再一键打印", "error");
    return;
  }
  const draft = tradeDocumentFromDeal(deal, customer, requestedType);
  state.selectedDocumentId = "__new__";
  activateNavView("documents");
  fillDocumentEditor(draft);
  qsa<HTMLElement>(".doc-list-card").forEach((card) => card.classList.remove("active"));
  const label = requestedType === "QUOTATION" ? "报价单" : draft.type;
  toast(`已按客户与商机资料生成${label}草稿，请补齐卖方和结算资料后保存`);
}

async function generateCustomsDocument(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const customer = state.customers.find((item) => item.id === deal.customerId);
  if (!customer) {
    toast("请先给商机关联客户", "error");
    return;
  }

  try {
    toast("正在生成报关资料...");
    const result = await api<{ customsDocument: CustomsDocument; customer: Customer; deal: Deal; source: CustomsGenerationSource }>(`/api/deals/${id}/generate-customs`, {
      method: "POST"
    });

    openCustomsDocumentModal(result.customsDocument, result.customer, result.deal, result.source);
  } catch (error) {
    toast("生成报关资料失败", "error");
    console.error(error);
  }
}

interface CustomsValidationIssue {
  label: string;
  field?: keyof CustomsDocument;
  itemIndex?: number;
  itemField?: keyof TradeDocumentItem;
}

function customsDocumentValidation(customsDoc: CustomsDocument): CustomsValidationIssue[] {
  const issues: CustomsValidationIssue[] = [];
  const required: Array<[keyof CustomsDocument, string]> = [
    ["shipper", "境内发货人"],
    ["shipperAddress", "发货人地址"],
    ["shipperTaxNo", "发货人统一社会信用代码"],
    ["manufacturer", "生产销售单位"],
    ["manufacturerTaxNo", "生产销售单位统一社会信用代码"],
    ["consignee", "境外收货人"],
    ["consigneeAddress", "收货人地址"],
    ["exitPort", "出境口岸"],
    ["destinationCountry", "运抵国"],
    ["contractNo", "合同号"],
    ["paymentTerm", "付款条件"]
  ];
  required.forEach(([field, label]) => {
    if (!String(customsDoc[field] || "").trim()) issues.push({ label, field });
  });
  ([
    ["packageCount", "包装件数"],
    ["grossWeight", "总毛重"],
    ["netWeight", "总净重"]
  ] as Array<[keyof CustomsDocument, string]>).forEach(([field, label]) => {
    if (Number(customsDoc[field] || 0) <= 0) issues.push({ label, field });
  });
  if (!customsDoc.items.length) issues.push({ label: "货物明细" });
  customsDoc.items.forEach((item, itemIndex) => {
    const prefix = `第${itemIndex + 1}行`;
    const itemRules: Array<[keyof TradeDocumentItem, string, boolean]> = [
      ["product", "品名", Boolean(item.product.trim())],
      ["hsCode", "HS编码", Boolean(item.hsCode.trim())],
      ["quantity", "数量", item.quantity > 0],
      ["unit", "单位", Boolean(item.unit.trim())],
      ["weightKg", "重量", item.weightKg > 0],
      ["packageCount", "包装数", item.packageCount > 0]
    ];
    itemRules.forEach(([itemField, label, valid]) => {
      if (!valid) issues.push({ label: `${prefix}${label}`, itemIndex, itemField });
    });
  });
  return issues;
}

function customsDocumentIssues(customsDoc: CustomsDocument) {
  return customsDocumentValidation(customsDoc).map((issue) => issue.label);
}

const CUSTOMS_PREVIEW_DOCUMENTS = [
  { key: "declaration", label: "报关单" },
  { key: "elements", label: "申报要素" },
  { key: "invoice", label: "商业发票" },
  { key: "packing", label: "装箱单" },
  { key: "contract", label: "销售合同" },
  { key: "authorization", label: "委托书" },
  { key: "guide", label: "填制规范" }
] as const;

type CustomsPreviewDocumentKey = typeof CUSTOMS_PREVIEW_DOCUMENTS[number]["key"];

function customsPreviewText(value: unknown, required = true) {
  const text = String(value ?? "").trim();
  if (!text) return required ? `<span class="customs-pack-preview-missing">待补充</span>` : "-";
  return escapeHtml(text);
}

function customsPreviewNumber(value: unknown, required = true) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || (required && number <= 0)) return `<span class="customs-pack-preview-missing">待补充</span>`;
  return number.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function customsPreviewAmount(value: number, currency: string) {
  return `${escapeHtml(currency || "USD")} ${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function customsPreviewHead(title: string, englishTitle: string, customsDoc: CustomsDocument) {
  return `
    <header class="customs-pack-doc-head">
      <div>
        <span class="customs-pack-doc-brand">${customsPreviewText(customsDoc.shipper)}</span>
        <h1>${escapeHtml(title)}${englishTitle ? ` <span>${escapeHtml(englishTitle)}</span>` : ""}</h1>
        <p>${customsPreviewText(customsDoc.destinationCountry)} · ${customsPreviewText(customsDoc.issueDate)}</p>
      </div>
      <div class="customs-pack-doc-number"><span>DOCUMENT NO.</span><b>${customsPreviewText(customsDoc.contractNo || customsDoc.number)}</b></div>
    </header>`;
}

function customsPreviewInfoCell(label: string, value: string, wide = false) {
  return `<div class="customs-pack-info-cell${wide ? " wide" : ""}"><label>${escapeHtml(label)}</label><span>${value}</span></div>`;
}

function renderCustomsPreviewSheet(customsDoc: CustomsDocument, key: CustomsPreviewDocumentKey) {
  const itemAmount = (item: TradeDocumentItem) => Number(item.quantity || 0) * Number(item.unitPrice || 0);
  const totalAmount = customsDoc.items.reduce((sum, item) => sum + itemAmount(item), 0);
  const totalQuantity = customsDoc.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const totalPackages = customsDoc.items.reduce((sum, item) => sum + Number(item.packageCount || 0), 0);
  const totalWeight = customsDoc.items.reduce((sum, item) => sum + Number(item.weightKg || 0), 0);
  const itemRows = customsDoc.items.length ? customsDoc.items : [{
    id: "preview_empty",
    product: "",
    model: "",
    hsCode: "",
    quantity: 0,
    unit: "",
    unitPrice: 0,
    originCountry: "",
    weightKg: 0,
    packageCount: 0
  }];

  if (key === "declaration") {
    return `${customsPreviewHead("中华人民共和国海关出口货物报关单", "", customsDoc)}
      <div class="customs-pack-info-grid">
        ${customsPreviewInfoCell("境内发货人", customsPreviewText(customsDoc.shipper), true)}
        ${customsPreviewInfoCell("统一社会信用代码", customsPreviewText(customsDoc.shipperTaxNo), true)}
        ${customsPreviewInfoCell("境外收货人", customsPreviewText(customsDoc.consignee), true)}
        ${customsPreviewInfoCell("收货人地址", customsPreviewText(customsDoc.consigneeAddress), true)}
        ${customsPreviewInfoCell("生产销售单位", customsPreviewText(customsDoc.manufacturer), true)}
        ${customsPreviewInfoCell("生产单位信用代码", customsPreviewText(customsDoc.manufacturerTaxNo), true)}
        ${customsPreviewInfoCell("运输方式", customsPreviewText(customsDoc.transportMode))}
        ${customsPreviewInfoCell("运输工具 / 航次", customsPreviewText(customsDoc.vesselName, false))}
        ${customsPreviewInfoCell("出境口岸", customsPreviewText(customsDoc.exitPort))}
        ${customsPreviewInfoCell("运抵国", customsPreviewText(customsDoc.destinationCountry))}
        ${customsPreviewInfoCell("监管方式", customsPreviewText(customsDoc.tradeMode))}
        ${customsPreviewInfoCell("成交方式", customsPreviewText(customsDoc.tradeMethod || customsDoc.incoterm))}
      </div>
      <div class="customs-pack-table-wrap"><table class="customs-pack-table">
        <thead><tr><th>序号</th><th>商品编号</th><th>商品名称</th><th>规格型号</th><th>数量</th><th>单位</th><th>单价</th><th>总价</th><th>原产国</th></tr></thead>
        <tbody>${itemRows.map((item, index) => `<tr><td class="num">${index + 1}</td><td>${customsPreviewText(item.hsCode)}</td><td>${customsPreviewText(item.product)}</td><td>${customsPreviewText(item.model, false)}</td><td class="num">${customsPreviewNumber(item.quantity)}</td><td>${customsPreviewText(item.unit)}</td><td class="num">${customsPreviewNumber(item.unitPrice, false)}</td><td class="num">${customsPreviewAmount(itemAmount(item), customsDoc.currency)}</td><td>${customsPreviewText(item.originCountry, false)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="4">合计</td><td class="num">${customsPreviewNumber(totalQuantity)}</td><td colspan="2"></td><td class="num">${customsPreviewAmount(totalAmount, customsDoc.currency)}</td><td></td></tr></tfoot>
      </table></div>
      <div class="customs-pack-summary">
        <div class="customs-pack-summary-item"><label>包装件数</label><b>${customsPreviewNumber(customsDoc.packageCount)}</b></div>
        <div class="customs-pack-summary-item"><label>毛重 kg</label><b>${customsPreviewNumber(customsDoc.grossWeight)}</b></div>
        <div class="customs-pack-summary-item"><label>净重 kg</label><b>${customsPreviewNumber(customsDoc.netWeight)}</b></div>
        <div class="customs-pack-summary-item"><label>币制</label><b>${customsPreviewText(customsDoc.currency)}</b></div>
      </div>`;
  }

  if (key === "elements") {
    return `${customsPreviewHead("申报要素", "DECLARATION ELEMENTS", customsDoc)}
      <div class="customs-pack-note">品牌、型号、HS 编码和出口享惠情况应与实际货物、包装标识及申报资料完全一致。</div>
      <div class="customs-pack-section-head"><b>商品申报要素</b><span>${customsDoc.items.length} 项商品</span></div>
      <div class="customs-pack-table-wrap"><table class="customs-pack-table">
        <thead><tr><th>序号</th><th>品名</th><th>HS编码</th><th>检疫附加码</th><th>品牌</th><th>型号</th><th>品牌类型</th><th>出口享惠</th></tr></thead>
        <tbody>${itemRows.map((item, index) => `<tr><td class="num">${index + 1}</td><td>${customsPreviewText(item.product)}</td><td>${customsPreviewText(item.hsCode)}</td><td>${customsPreviewText(item.inspectionCode, false)}</td><td>${customsPreviewText(item.brand || "无品牌", false)}</td><td>${customsPreviewText(item.model, false)}</td><td>${customsPreviewText(item.brandType || "无品牌", false)}</td><td>${customsPreviewText(item.exportBenefit || "不享惠", false)}</td></tr>`).join("")}</tbody>
      </table></div>`;
  }

  if (key === "invoice") {
    return `${customsPreviewHead("商业发票", "COMMERCIAL INVOICE", customsDoc)}
      <div class="customs-pack-info-grid">
        ${customsPreviewInfoCell("卖方 Seller", customsPreviewText(customsDoc.shipper), true)}
        ${customsPreviewInfoCell("发票日期 Date", customsPreviewText(customsDoc.issueDate), true)}
        ${customsPreviewInfoCell("卖方地址 Address", customsPreviewText(customsDoc.shipperAddress), true)}
        ${customsPreviewInfoCell("发票号 Invoice No.", customsPreviewText(customsDoc.contractNo), true)}
        ${customsPreviewInfoCell("买方 Buyer", customsPreviewText(customsDoc.consignee), true)}
        ${customsPreviewInfoCell("贸易术语 Incoterm", customsPreviewText(customsDoc.incoterm), true)}
        ${customsPreviewInfoCell("买方地址 Address", customsPreviewText(customsDoc.consigneeAddress), true)}
        ${customsPreviewInfoCell("付款方式 Payment", customsPreviewText(customsDoc.paymentTerm), true)}
      </div>
      <div class="customs-pack-table-wrap"><table class="customs-pack-table">
        <thead><tr><th>唛头 Mark</th><th>货物名称 Description</th><th>型号 Model</th><th>数量 Quantity</th><th>单位 Unit</th><th>单价 Unit Price</th><th>金额 Amount</th></tr></thead>
        <tbody>${itemRows.map((item) => `<tr><td>N/M</td><td>${customsPreviewText(item.productEnglish || item.product)}</td><td>${customsPreviewText(item.model, false)}</td><td class="num">${customsPreviewNumber(item.quantity)}</td><td>${customsPreviewText(item.unit)}</td><td class="num">${customsPreviewAmount(item.unitPrice, customsDoc.currency)}</td><td class="num">${customsPreviewAmount(itemAmount(item), customsDoc.currency)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="6">TOTAL</td><td class="num">${customsPreviewAmount(totalAmount, customsDoc.currency)}</td></tr></tfoot>
      </table></div>`;
  }

  if (key === "packing") {
    return `${customsPreviewHead("装箱单", "PACKING LIST", customsDoc)}
      <div class="customs-pack-info-grid">
        ${customsPreviewInfoCell("收货人 Consignee", customsPreviewText(customsDoc.consignee), true)}
        ${customsPreviewInfoCell("日期 Date", customsPreviewText(customsDoc.issueDate), true)}
        ${customsPreviewInfoCell("地址 Address", customsPreviewText(customsDoc.consigneeAddress), true)}
        ${customsPreviewInfoCell("合同号 Contract No.", customsPreviewText(customsDoc.contractNo), true)}
        ${customsPreviewInfoCell("运输路线 Route", `${customsPreviewText(customsDoc.exitPort)} → ${customsPreviewText(customsDoc.destinationCountry)}`, true)}
        ${customsPreviewInfoCell("包装种类 Package", customsPreviewText(customsDoc.packageType), true)}
      </div>
      <div class="customs-pack-table-wrap"><table class="customs-pack-table">
        <thead><tr><th>箱号 Ctn.No.</th><th>货物名称 Description</th><th>箱数 Pkg</th><th>数量 Quantity</th><th>单位 Unit</th><th>毛重 kg</th><th>净重 kg</th></tr></thead>
        <tbody>${itemRows.map((item, index) => `<tr><td class="num">${index + 1}</td><td>${customsPreviewText(item.productEnglish || item.product)}</td><td class="num">${customsPreviewNumber(item.packageCount)}</td><td class="num">${customsPreviewNumber(item.quantity)}</td><td>${customsPreviewText(item.unit)}</td><td class="num">${customsPreviewNumber(item.weightKg)}</td><td class="num">${customsPreviewNumber(Number(item.weightKg || 0) * .9)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="2">TOTAL</td><td class="num">${customsPreviewNumber(totalPackages)}</td><td class="num">${customsPreviewNumber(totalQuantity)}</td><td></td><td class="num">${customsPreviewNumber(totalWeight)}</td><td class="num">${customsPreviewNumber(customsDoc.netWeight)}</td></tr></tfoot>
      </table></div>`;
  }

  if (key === "contract") {
    return `${customsPreviewHead("销售合同", "SALES CONTRACT", customsDoc)}
      <div class="customs-pack-info-grid">
        ${customsPreviewInfoCell("卖方 Seller", customsPreviewText(customsDoc.shipper), true)}
        ${customsPreviewInfoCell("买方 Buyer", customsPreviewText(customsDoc.consignee), true)}
        ${customsPreviewInfoCell("卖方地址 Address", customsPreviewText(customsDoc.shipperAddress), true)}
        ${customsPreviewInfoCell("买方地址 Address", customsPreviewText(customsDoc.consigneeAddress), true)}
      </div>
      <div class="customs-pack-table-wrap"><table class="customs-pack-table">
        <thead><tr><th>No.</th><th>货物名称 Commodity</th><th>型号 Model</th><th>数量 Quantity</th><th>单位 Unit</th><th>单价 Unit Price</th><th>金额 Amount</th></tr></thead>
        <tbody>${itemRows.map((item, index) => `<tr><td class="num">${index + 1}</td><td>${customsPreviewText(item.productEnglish || item.product)}</td><td>${customsPreviewText(item.model, false)}</td><td class="num">${customsPreviewNumber(item.quantity)}</td><td>${customsPreviewText(item.unit)}</td><td class="num">${customsPreviewAmount(item.unitPrice, customsDoc.currency)}</td><td class="num">${customsPreviewAmount(itemAmount(item), customsDoc.currency)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="6">TOTAL</td><td class="num">${customsPreviewAmount(totalAmount, customsDoc.currency)}</td></tr></tfoot>
      </table></div>
      <div class="customs-pack-section-head"><b>付款与交货条款 PAYMENT & DELIVERY TERMS</b></div>
      <div class="customs-pack-info-grid">
        ${customsPreviewInfoCell("付款方式 Payment", customsPreviewText(customsDoc.paymentTerm), true)}
        ${customsPreviewInfoCell("交货条款 Delivery", `${customsPreviewText(customsDoc.incoterm)} ${customsPreviewText(customsDoc.exitPort)}`, true)}
      </div>`;
  }

  if (key === "authorization") {
    return `${customsPreviewHead("代理报关委托书", "", customsDoc)}
      <div class="customs-pack-letter">
        <p>委托单位：${customsPreviewText(customsDoc.shipper)}</p>
        <p>统一社会信用代码：${customsPreviewText(customsDoc.shipperTaxNo)}</p>
        <p>单位地址：${customsPreviewText(customsDoc.shipperAddress)}</p>
        <p>我单位现委托代理报关企业办理本批货物的申报、预录入及相关通关事宜。</p>
        <p>我单位保证遵守《海关法》及国家有关法规，所提供资料真实、完整、单货相符；如申报资料不实，我单位愿承担相关责任。</p>
      </div>
      <div class="customs-pack-signatures">
        <div class="customs-pack-signature">委托方（盖章）</div>
        <div class="customs-pack-signature">法定代表人或授权签字</div>
      </div>`;
  }

  const guideRows = [
    ["境内收发货人", "填报在海关备案并实际执行进出口合同的中国境内法人或组织名称及编码。"],
    ["境外收发货人", "填报境外收货人或发货人的完整名称及地址。"],
    ["运输方式", "根据货物实际运输方式填报，如水路、铁路、公路或航空运输。"],
    ["监管方式", "根据实际监管方式填报，一般贸易通常填报 0110。"],
    ["贸易国（地区）", "填报与境内企业签订贸易合同的外方所属国家或地区。"],
    ["包装种类", "根据货物实际包装填报，如纸箱、木箱、托盘。"],
    ["商品编号", "填报准确的 10 位 HS 编码。"],
    ["申报要素", "品牌、型号等要素必须与实际货物及包装标识一致。"]
  ];
  return `${customsPreviewHead("海关出口货物报关单填制规范", "", customsDoc)}
    <div class="customs-pack-section-head"><b>填制项目</b><span>正式申报前复核</span></div>
    <table class="customs-pack-table customs-pack-guide"><thead><tr><th>项目</th><th>填制要求</th></tr></thead><tbody>${guideRows.map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join("")}</tbody></table>`;
}

function closeCustomsPreviewPage() {
  qs("#customsPreviewPage")?.remove();
  document.body.classList.remove("customs-preview-open");
}

function openCustomsPreviewPage(customsDoc: CustomsDocument, customer: Customer, deal: Deal) {
  closeCustomsPreviewPage();
  const issues = customsDocumentValidation(customsDoc);
  const totalAmount = customsDoc.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  document.body.insertAdjacentHTML("beforeend", `
    <section class="customs-pack-preview-page" id="customsPreviewPage" role="dialog" aria-modal="true" aria-label="报关资料预览">
      <header class="customs-pack-preview-topbar">
        <button type="button" class="btn" id="customsPreviewBackButton">返回编辑</button>
        <div class="customs-pack-preview-title"><b>${escapeHtml(customer.company)} · 报关资料预览</b><span>${escapeHtml(deal.title)} · ${customsPreviewAmount(totalAmount, customsDoc.currency)}</span></div>
        <div class="customs-pack-preview-actions">
          <span class="customs-pack-preview-status${issues.length ? " has-issues" : ""}">${issues.length ? `${issues.length} 项待补` : "资料完整"}</span>
          <button type="button" class="btn primary" id="customsPreviewExportButton"${issues.length ? " disabled" : ""}>导出 Excel</button>
        </div>
      </header>
      <div class="customs-pack-preview-layout">
        <nav class="customs-pack-preview-nav" aria-label="资料预览类型">
          <div class="customs-pack-preview-nav-label">资料包 · 7 个工作表</div>
          ${CUSTOMS_PREVIEW_DOCUMENTS.map((document, index) => `<button type="button" class="customs-pack-preview-tab${index === 0 ? " active" : ""}" data-customs-preview-key="${document.key}"><span class="customs-pack-preview-tab-index">${index + 1}</span><span>${document.label}</span></button>`).join("")}
        </nav>
        <main class="customs-pack-preview-stage"><article class="customs-pack-preview-sheet" id="customsPreviewSheet"></article></main>
      </div>
    </section>`);
  document.body.classList.add("customs-preview-open");

  const render = (key: CustomsPreviewDocumentKey) => {
    const sheet = qs<HTMLElement>("#customsPreviewSheet");
    if (sheet) sheet.innerHTML = renderCustomsPreviewSheet(customsDoc, key);
    qsa<HTMLButtonElement>("[data-customs-preview-key]", qs("#customsPreviewPage")!).forEach((button) => {
      button.classList.toggle("active", button.dataset.customsPreviewKey === key);
    });
  };
  qsa<HTMLButtonElement>("[data-customs-preview-key]", qs("#customsPreviewPage")!).forEach((button) => {
    button.addEventListener("click", () => render((button.dataset.customsPreviewKey || "declaration") as CustomsPreviewDocumentKey));
  });
  qs<HTMLButtonElement>("#customsPreviewBackButton")?.addEventListener("click", closeCustomsPreviewPage);
  qs<HTMLButtonElement>("#customsPreviewExportButton")?.addEventListener("click", () => void exportCustomsDocument(customsDoc));
  render("declaration");
}

function openCustomsDocumentModal(customsDoc: CustomsDocument, customer: Customer, deal: Deal, source: CustomsGenerationSource) {
  const field = (name: keyof CustomsDocument, label: string, value: unknown, options: { type?: string; wide?: boolean; min?: number; step?: number } = {}) => `
    <label class="customs-field ${options.wide ? "wide" : ""}">
      <span>${label}</span>
      <input data-customs-field="${String(name)}" type="${options.type || "text"}" value="${escapeHtml(String(value ?? ""))}"${options.min !== undefined ? ` min="${options.min}"` : ""}${options.step !== undefined ? ` step="${options.step}"` : ""}>
    </label>`;

  openModal(`${customer.company} · 报关资料包`, `
    <div class="customs-workspace">
      <header class="customs-workspace-head">
        <div>
          <span class="customs-kicker">Customs Pack</span>
          <h3>出口报关资料工作台</h3>
          <p>${escapeHtml(deal.title)} · ${escapeHtml(customer.company)} · ${escapeHtml(customer.country)}</p>
        </div>
        <div class="customs-readiness"><strong id="customsReadinessValue">0%</strong><span>资料完整度</span></div>
      </header>

      <div class="customs-source-bar">
        <div><span>资料来源</span><strong>${escapeHtml(source.label)}</strong></div>
        <div><span>输出内容</span><strong>7个Excel工作表</strong></div>
        <div><span>当前金额</span><strong id="customsTotalAmount">--</strong></div>
      </div>

      <div class="customs-editor-layout">
        <main class="customs-form-sections">
          <section class="customs-form-section">
            <div class="customs-section-title"><div><b>单据与贸易</b><span>合同、币种和结算信息</span></div></div>
            <div class="customs-form-grid">
              ${field("number", "报关资料编号", customsDoc.number)}
              ${field("issueDate", "制单日期", customsDoc.issueDate, { type: "date" })}
              ${field("contractNo", "合同 / 发票号", customsDoc.contractNo)}
              ${field("exitDate", "预计出口日期", customsDoc.exitDate, { type: "date" })}
              ${field("tradeMode", "监管方式", customsDoc.tradeMode)}
              ${field("currency", "币种", customsDoc.currency)}
              ${field("incoterm", "贸易术语", customsDoc.incoterm)}
              ${field("paymentTerm", "付款条件", customsDoc.paymentTerm, { wide: true })}
            </div>
          </section>

          <section class="customs-form-section">
            <div class="customs-section-title"><div><b>收发货主体</b><span>以实际备案主体和合同买方为准</span></div></div>
            <div class="customs-form-grid">
              ${field("shipper", "境内发货人", customsDoc.shipper)}
              ${field("shipperTaxNo", "统一社会信用代码", customsDoc.shipperTaxNo)}
              ${field("shipperAddress", "发货人地址", customsDoc.shipperAddress, { wide: true })}
              ${field("manufacturer", "生产销售单位", customsDoc.manufacturer)}
              ${field("manufacturerTaxNo", "生产单位信用代码", customsDoc.manufacturerTaxNo)}
              ${field("consignee", "境外收货人", customsDoc.consignee)}
              ${field("consigneeAddress", "境外收货人地址", customsDoc.consigneeAddress, { wide: true })}
            </div>
          </section>

          <section class="customs-form-section">
            <div class="customs-section-title"><div><b>运输与包装</b><span>重量和件数可按商品明细自动汇总</span></div><button class="btn" type="button" id="customsRecalculateButton">按明细汇总</button></div>
            <div class="customs-form-grid">
              ${field("transportMode", "运输方式", customsDoc.transportMode)}
              ${field("vesselName", "运输工具 / 航次", customsDoc.vesselName)}
              ${field("exitPort", "出境口岸", customsDoc.exitPort)}
              ${field("destinationCountry", "运抵国", customsDoc.destinationCountry)}
              ${field("tradeCountry", "贸易国", customsDoc.tradeCountry)}
              ${field("packageType", "包装种类", customsDoc.packageType)}
              ${field("packageCount", "总件数", customsDoc.packageCount, { type: "number", min: 0 })}
              ${field("grossWeight", "总毛重 kg", customsDoc.grossWeight, { type: "number", min: 0, step: 0.01 })}
              ${field("netWeight", "总净重 kg", customsDoc.netWeight, { type: "number", min: 0, step: 0.01 })}
            </div>
          </section>
        </main>

        <aside class="customs-check-panel">
          <div class="customs-check-head"><b>导出检查</b><span id="customsIssueCount">--</span></div>
          <div id="customsIssueList" class="customs-issue-list"></div>
          <div class="customs-check-note">HS编码、品牌、型号、重量和包装应与实际货物及申报要素一致。</div>
        </aside>
      </div>

      <section class="customs-items-section-edit">
        <div class="customs-section-title"><div><b>商品申报明细</b><span>金额、箱单、发票和合同将共用以下明细</span></div><button class="btn" id="customsAddItemButton" type="button">增加商品</button></div>
        <div class="customs-items-editor-wrap"><div class="customs-items-editor" id="customsItemsEditor"></div></div>
      </section>

      <section class="customs-output-section">
        <div class="customs-section-title"><div><b>导出资料包</b><span>一次生成，工作表之间使用同一份确认数据</span></div></div>
        <div class="customs-output-list">
          <span>报关单</span><span>申报要素</span><span>商业发票</span><span>装箱单</span><span>销售合同</span><span>委托书</span><span>填制规范</span>
        </div>
      </section>
    </div>
  `, `
    <button class="btn" data-modal-close>取消</button>
    <button class="btn" id="previewCustomsButton">预览资料</button>
    <button class="btn primary" id="exportCustomsButton">检查资料</button>
  `);

  qs<HTMLElement>("#appModal .modal")?.classList.add("customs-workspace-modal");
  let workingDocument: CustomsDocument = { ...customsDoc, items: customsDoc.items.map((item) => ({ ...item })) };
  const itemsEditor = qs<HTMLElement>("#customsItemsEditor")!;

  const collectDraft = (): CustomsDocument => {
    const textValue = (name: keyof CustomsDocument) => qs<HTMLInputElement>(`[data-customs-field="${String(name)}"]`)?.value.trim() || "";
    const numberValue = (name: keyof CustomsDocument) => Number(qs<HTMLInputElement>(`[data-customs-field="${String(name)}"]`)?.value || 0);
    const items = qsa<HTMLElement>("[data-customs-item]", itemsEditor).map((row, index) => {
      const itemText = (name: string) => row.querySelector<HTMLInputElement>(`[data-customs-item-field="${name}"]`)?.value.trim() || "";
      const itemNumber = (name: string) => Number(row.querySelector<HTMLInputElement>(`[data-customs-item-field="${name}"]`)?.value || 0);
      return {
        id: row.dataset.customsItem || `customs_item_${Date.now()}_${index}`,
        product: itemText("product"),
        productEnglish: itemText("productEnglish"),
        model: itemText("model"),
        hsCode: itemText("hsCode"),
        brand: itemText("brand"),
        quantity: itemNumber("quantity"),
        unit: itemText("unit"),
        unitPrice: itemNumber("unitPrice"),
        originCountry: itemText("originCountry"),
        weightKg: itemNumber("weightKg"),
        packageCount: Math.round(itemNumber("packageCount"))
      };
    });
    return {
      ...workingDocument,
      number: textValue("number"),
      issueDate: textValue("issueDate"),
      contractNo: textValue("contractNo"),
      exitDate: textValue("exitDate"),
      tradeMode: textValue("tradeMode"),
      supervisionMode: textValue("tradeMode"),
      currency: textValue("currency").toUpperCase(),
      incoterm: textValue("incoterm"),
      tradeMethod: textValue("incoterm"),
      paymentTerm: textValue("paymentTerm"),
      shipper: textValue("shipper"),
      shipperAddress: textValue("shipperAddress"),
      shipperTaxNo: textValue("shipperTaxNo"),
      manufacturer: textValue("manufacturer"),
      manufacturerTaxNo: textValue("manufacturerTaxNo"),
      consignee: textValue("consignee"),
      consigneeAddress: textValue("consigneeAddress"),
      transportMode: textValue("transportMode"),
      vesselName: textValue("vesselName"),
      exitPort: textValue("exitPort"),
      destinationCountry: textValue("destinationCountry"),
      tradeCountry: textValue("tradeCountry"),
      packageType: textValue("packageType"),
      packageCount: numberValue("packageCount"),
      grossWeight: numberValue("grossWeight"),
      netWeight: numberValue("netWeight"),
      updatedAt: new Date().toISOString(),
      items
    };
  };

  const updateReadiness = () => {
    workingDocument = collectDraft();
    const validationIssues = customsDocumentValidation(workingDocument);
    const issues = validationIssues.map((issue) => issue.label);
    const totalChecks = 14 + Math.max(1, workingDocument.items.length) * 6;
    const score = Math.max(0, Math.round(((totalChecks - issues.length) / totalChecks) * 100));
    const totalAmount = workingDocument.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const workspace = qs<HTMLElement>("#appModal .customs-workspace");
    qsa<HTMLElement>(".is-missing, .has-missing", workspace || undefined).forEach((node) => node.classList.remove("is-missing", "has-missing"));
    qsa<HTMLInputElement>("[aria-invalid='true']", workspace || undefined).forEach((input) => input.removeAttribute("aria-invalid"));
    validationIssues.forEach((issue) => {
      const input = issue.field
        ? qs<HTMLInputElement>(`[data-customs-field="${String(issue.field)}"]`, workspace || undefined)
        : issue.itemIndex !== undefined && issue.itemField
          ? qsa<HTMLElement>("[data-customs-item]", itemsEditor)[issue.itemIndex]?.querySelector<HTMLInputElement>(`[data-customs-item-field="${String(issue.itemField)}"]`) || null
          : null;
      input?.classList.add("is-missing");
      input?.setAttribute("aria-invalid", "true");
      input?.closest("label")?.classList.add("is-missing");
      input?.closest("[data-customs-item]")?.classList.add("has-missing");
    });
    qs<HTMLElement>("#customsReadinessValue")!.textContent = `${score}%`;
    qs<HTMLElement>("#customsTotalAmount")!.textContent = `${workingDocument.currency || "USD"} ${formatDocumentTableMoney(totalAmount)}`;
  qs<HTMLElement>("#customsIssueCount")!.textContent = issues.length ? `${issues.length}项待补` : "检查通过";
    qs<HTMLElement>("#customsIssueList")!.innerHTML = validationIssues.length
      ? validationIssues.slice(0, 12).map((issue, index) => `<button type="button" data-customs-issue-index="${index}">${escapeHtml(issue.label)}</button>`).join("") + (validationIssues.length > 12 ? `<small>另有 ${validationIssues.length - 12} 项，请继续检查商品明细。</small>` : "")
      : `<div class="customs-ready-state"><b>资料检查通过</b></div>`;
    qsa<HTMLButtonElement>("[data-customs-issue-index]", qs("#customsIssueList")!).forEach((button) => {
      button.addEventListener("click", () => {
        const issue = validationIssues[Number(button.dataset.customsIssueIndex || 0)];
        const input = issue?.field
          ? qs<HTMLInputElement>(`[data-customs-field="${String(issue.field)}"]`, workspace || undefined)
          : issue?.itemIndex !== undefined && issue.itemField
            ? qsa<HTMLElement>("[data-customs-item]", itemsEditor)[issue.itemIndex]?.querySelector<HTMLInputElement>(`[data-customs-item-field="${String(issue.itemField)}"]`) || null
            : null;
        input?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        window.setTimeout(() => input?.focus(), 180);
      });
    });
    const exportButton = qs<HTMLButtonElement>("#exportCustomsButton")!;
    exportButton.disabled = Boolean(issues.length);
    exportButton.textContent = issues.length ? `还需补齐 ${issues.length} 项` : "导出 Excel 资料包";
  };

  const renderItems = () => {
    itemsEditor.innerHTML = workingDocument.items.map((item, index) => `
      <div class="customs-item-edit-row" data-customs-item="${escapeHtml(item.id || `item_${index}`)}">
        <span class="customs-item-index">${index + 1}</span>
        <label class="product"><span>中文品名</span><input data-customs-item-field="product" value="${escapeHtml(item.product)}"></label>
        <label class="product-en"><span>英文品名</span><input data-customs-item-field="productEnglish" value="${escapeHtml(item.productEnglish || "")}"></label>
        <label><span>型号</span><input data-customs-item-field="model" value="${escapeHtml(item.model || "")}"></label>
        <label><span>HS编码</span><input data-customs-item-field="hsCode" value="${escapeHtml(item.hsCode || "")}"></label>
        <label><span>品牌</span><input data-customs-item-field="brand" value="${escapeHtml(item.brand || "无品牌")}"></label>
        <label><span>数量</span><input data-customs-item-field="quantity" type="number" min="0" value="${item.quantity}"></label>
        <label><span>单位</span><input data-customs-item-field="unit" value="${escapeHtml(item.unit || "PCS")}"></label>
        <label><span>单价</span><input data-customs-item-field="unitPrice" type="number" min="0" step="0.01" value="${item.unitPrice}"></label>
        <label><span>原产国</span><input data-customs-item-field="originCountry" value="${escapeHtml(item.originCountry || "中国")}"></label>
        <label><span>重量kg</span><input data-customs-item-field="weightKg" type="number" min="0" step="0.01" value="${item.weightKg || 0}"></label>
        <label><span>包装数</span><input data-customs-item-field="packageCount" type="number" min="0" value="${item.packageCount || 0}"></label>
        <button type="button" class="customs-item-remove" title="删除商品" aria-label="删除第${index + 1}行">×</button>
      </div>
    `).join("");
    qsa<HTMLInputElement>("[data-customs-item-field]", itemsEditor).forEach((input) => input.addEventListener("input", updateReadiness));
    qsa<HTMLButtonElement>(".customs-item-remove", itemsEditor).forEach((button, index) => {
      button.addEventListener("click", () => {
        workingDocument = collectDraft();
        workingDocument.items.splice(index, 1);
        if (!workingDocument.items.length) {
          workingDocument.items.push({ id: `customs_item_${Date.now()}`, product: "", productEnglish: "", model: "", hsCode: "", brand: "无品牌", quantity: 1, unit: "PCS", unitPrice: 0, originCountry: "中国", weightKg: 0, packageCount: 0 });
        }
        renderItems();
        updateReadiness();
      });
    });
  };

  qsa<HTMLInputElement>("[data-customs-field]").forEach((input) => input.addEventListener("input", updateReadiness));
  qs<HTMLButtonElement>("#customsAddItemButton")?.addEventListener("click", () => {
    workingDocument = collectDraft();
    workingDocument.items.push({ id: `customs_item_${Date.now()}`, product: "", productEnglish: "", model: "", hsCode: "", brand: "无品牌", quantity: 1, unit: "PCS", unitPrice: 0, originCountry: "中国", weightKg: 0, packageCount: 0 });
    renderItems();
    updateReadiness();
  });
  qs<HTMLButtonElement>("#customsRecalculateButton")?.addEventListener("click", () => {
    workingDocument = collectDraft();
    const packageCount = workingDocument.items.reduce((sum, item) => sum + Number(item.packageCount || 0), 0);
    const grossWeight = workingDocument.items.reduce((sum, item) => sum + Number(item.weightKg || 0), 0);
    const values: Record<string, number> = { packageCount, grossWeight, netWeight: Math.round(grossWeight * 0.9 * 100) / 100 };
    Object.entries(values).forEach(([name, value]) => {
      const input = qs<HTMLInputElement>(`[data-customs-field="${name}"]`);
      if (input) input.value = String(value);
    });
    updateReadiness();
    toast("已按商品明细汇总件数和重量");
  });
  qs<HTMLButtonElement>("#previewCustomsButton")?.addEventListener("click", () => {
    workingDocument = collectDraft();
    openCustomsPreviewPage(workingDocument, customer, deal);
  });
  qs<HTMLButtonElement>("#exportCustomsButton")?.addEventListener("click", () => {
    const draft = collectDraft();
    const issues = customsDocumentIssues(draft);
    if (issues.length) {
      toast(`请先补齐：${issues.slice(0, 3).join("、")}`, "error");
      return;
    }
    void exportCustomsDocument(draft);
  });

  renderItems();
  updateReadiness();
}

async function exportCustomsDocument(customsDoc: CustomsDocument) {
  try {
    toast("正在生成 Excel 文件...");
    const csrfToken = cookieValue("gj_csrf");

    const response = await fetch("/api/customs-documents/export", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
      },
      body: JSON.stringify({ customsDocument: customsDoc })
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: "导出失败" }));
      throw new Error(body.message || "导出失败");
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${customsDoc.consignee}-报关资料-${customsDoc.issueDate}.xlsx`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    closeCustomsPreviewPage();
    closeModal();
    toast("报关资料已导出");
  } catch (error) {
    toast(error instanceof Error ? error.message : "导出失败，请重试", "error");
    console.error(error);
  }
}

function openDealStageModal(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) {
    toast("商机数据已变化，请刷新后重试", "error");
    return;
  }
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交"] as const;
  const currentStageIndex = stages.indexOf(deal.stage as typeof stages[number]);
  if (currentStageIndex < 0) {
    toast(`「${deal.stage}」不能继续推进，请使用丢单复盘或归档`, "error");
    return;
  }
  const nextStage = stages[Math.min(currentStageIndex + 1, stages.length - 1)];
  const resultLabel: Record<string, string> = {
    "已联系": "本次联系结果",
    "已报价": "报价依据或发送结果",
    "样品": "样品安排与反馈计划",
    "谈判": "客户异议与当前谈判条件",
    "成交": "客户确认结果"
  };
  openModal(`${deal.stage} → ${nextStage}`, `
    <div class="form-grid">
      <div class="form-field full"><label>${resultLabel[nextStage] || "本次推进结果"}</label><textarea id="dealStageResultInput" rows="4" placeholder="记录本次推进的事实依据"></textarea></div>
      <div class="form-field full"><label>下一步动作</label><input id="dealStageNextActionInput" value="${escapeHtml(nextDealAction(nextStage))}"></div>
      <div class="form-field"><label>下一动作日期</label><input id="dealStageNextActionAtInput" type="date" value="${escapeHtml(defaultFutureDate(2))}"></div>
      <div class="form-field"><label>预计成交日期${["已报价", "样品", "谈判", "成交"].includes(nextStage) ? "（必填）" : ""}</label><input id="dealStageExpectedCloseAtInput" type="date" value="${escapeHtml(deal.expectedCloseAt || defaultFutureDate(21))}"></div>
      ${nextStage === "成交" ? `<div class="form-field full"><label>成交依据</label><textarea id="dealWonReasonInput" rows="3" placeholder="例如：客户已确认 PI、金额、付款条件与订单日期"></textarea></div>` : ""}
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmDealStageButton">确认进入${nextStage}</button>`);
  qs("#confirmDealStageButton")?.addEventListener("click", () => void moveDeal(id, nextStage));
}

function nextDealAction(stage: string) {
  const map: Record<string, string> = {
    "已联系": "确认产品、数量与报价要求",
    "已报价": "跟进报价反馈并确认异议",
    "样品": "确认样品寄出与反馈日期",
    "谈判": "确认价格、账期、交期和贸易条款",
    "成交": "确认定金与订单交付"
  };
  return map[stage] || "安排下一步跟进";
}

export function defaultFutureDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function moveDeal(id: string, nextStage: string) {
  const resultText = qs<HTMLTextAreaElement>("#dealStageResultInput")?.value.trim() || "";
  const nextAction = qs<HTMLInputElement>("#dealStageNextActionInput")?.value.trim() || "";
  const nextActionAt = qs<HTMLInputElement>("#dealStageNextActionAtInput")?.value || "";
  const expectedCloseAt = qs<HTMLInputElement>("#dealStageExpectedCloseAtInput")?.value || "";
  const wonReason = qs<HTMLTextAreaElement>("#dealWonReasonInput")?.value.trim() || "";
  if (!resultText || !nextAction || !nextActionAt) {
    toast("请填写推进结果、下一动作和日期", "error");
    return;
  }
  if (["已报价", "样品", "谈判", "成交"].includes(nextStage) && !expectedCloseAt) {
    toast("进入该阶段前请填写预计成交日期", "error");
    return;
  }
  if (nextStage === "成交" && !wonReason) {
    toast("请填写客户确认成交的依据", "error");
    return;
  }
  const button = qs<HTMLButtonElement>("#confirmDealStageButton");
  if (button?.disabled) return;
  const idleLabel = `确认进入${nextStage}`;
  setButtonPending(button, true, idleLabel, "推进中…");
  let result: { deal: Deal; customer?: Customer };
  try {
    result = await api<{ deal: Deal; customer?: Customer }>(`/api/deals/${id}/stage`, {
      method: "PATCH",
      body: JSON.stringify({ stage: nextStage, result: resultText, nextAction, nextActionAt, expectedCloseAt, wonReason })
    });
  } catch (error) {
    setButtonPending(button, false, idleLabel, idleLabel);
    toast(error instanceof Error ? error.message : "商机推进失败，请重试", "error");
    return;
  }
  if (result.customer) {
    const customerIndex = state.customers.findIndex((customer) => customer.id === result.customer!.id);
    if (customerIndex >= 0) state.customers[customerIndex] = result.customer;
  }
  closeModal();
  toast(`商机已推进到：${nextStage}`);
  await refreshDealsData();
  void refreshDashboardOnly();
  void loadProspectFeedback(true, true);
}

async function archiveDeal(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) {
    toast("商机已不存在，请刷新后重试", "error");
    return;
  }
  try {
    const result = await api<{ deal: Deal }>(`/api/deals/${id}/archive`, { method: "POST" });
    Object.assign(deal, result.deal);
    if (state.selectedDealId === id) closeDealDrawer();
    toast("成交商机已归档");
    await refreshDealsData();
    void refreshDashboardOnly();
  } catch (error) {
    toast(error instanceof Error ? error.message : "归档失败，请稍后重试", "error");
  }
}

async function duplicateDeal(id: string, button: HTMLButtonElement | null = null) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) {
    toast("商机已不存在，请刷新后重试", "error");
    return;
  }
  if (button?.disabled) return;
  setButtonPending(button, true, "复制商机", "复制中…");
  try {
    const result = await api<{ deal: Deal }>(`/api/deals/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
    toast(`已复制为「${result.deal.title}」，新商机在询盘阶段，时间线与单据不随复制`);
    await refreshDealsData();
    void refreshDashboardOnly();
  } catch (error) {
    toast(error instanceof Error ? error.message : "复制失败，请稍后重试", "error");
    setButtonPending(button, false, "复制商机", "复制商机");
  }
}

async function restoreDeal(id: string, button: HTMLButtonElement | null = null) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) {
    toast("商机已不存在，请刷新后重试", "error");
    return;
  }
  if (button?.disabled) return;
  const confirmed = await confirmAction({
    title: "恢复归档商机",
    message: `确定要把「${deal.title}」从归档拉回来吗？`,
    consequences: [
      "仅取消归档标记，商机回到关闭商机列表（待归档）",
      "阶段保持不变，不重新进入推进管道",
      "客户成交状态、佣金与报表等关联数据不变更"
    ],
    confirmLabel: "确认恢复"
  });
  if (!confirmed) return;
  setButtonPending(button, true, "恢复", "恢复中…");
  try {
    const result = await api<{ deal: Deal }>(`/api/deals/${encodeURIComponent(id)}/restore`, { method: "POST" });
    Object.assign(deal, result.deal);
    toast(`「${result.deal.title}」已恢复（仅取消归档）`);
    await refreshDealsData();
    if (state.selectedDealId === id) renderDealDrawer(id);
  } catch (error) {
    toast(error instanceof Error ? error.message : "恢复失败，请稍后重试", "error");
    setButtonPending(button, false, "恢复", "恢复");
  }
}

async function deleteDeal(id: string, button: HTMLButtonElement | null = null) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) {
    toast("商机已不存在，请刷新后重试", "error");
    return;
  }
  if (button?.disabled) return;
  const confirmed = await confirmAction({
    title: "删除商机",
    message: `确定要删除商机「${deal.title}」吗？此操作不可恢复。`,
    consequences: [
      "商机的全部阶段与跟进时间线将一并删除",
      "关联该商机的待办会同时清除",
      "如已生成 PI/CI/报关资料等单据，需先处理单据后才能删除",
      "删除后无法恢复，客户资料不受影响"
    ],
    confirmLabel: "确认删除",
    tone: "danger"
  });
  if (!confirmed) return;
  setButtonPending(button, true, "删除商机", "删除中…");
  try {
    const result = await api<{ removed: { events: number; todos: number; quoteHistory: number } }>(`/api/deals/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.selectedDealId === id) closeDealDrawer();
    toast(`商机已删除${result.removed.todos ? `，同时清除了 ${result.removed.todos} 条相关待办` : ""}`);
    await refreshDealsData();
    void refreshDashboardOnly();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败，请稍后重试", "error");
    setButtonPending(button, false, "删除商机", "删除商机");
  }
}

function markDealLost(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  openModal("丢单复盘", `
    <div class="form-grid">
      <div class="form-field"><label>丢单原因分类</label><select id="dealLostCategoryInput"><option>价格原因</option><option>产品不匹配</option><option>交期原因</option><option>付款条件</option><option>客户项目取消</option><option>竞争对手</option><option>其他</option></select></div>
      <div class="form-field"><label>复访日期（可选）</label><input id="dealRevisitAtInput" type="date"></div>
      <div class="form-field full"><label>具体原因</label><textarea id="dealLostReasonInput" rows="4" placeholder="记录客户反馈、竞争情况和后续可能性"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn danger" id="confirmDealLostButton">确认丢单</button>`);
  qs("#confirmDealLostButton")?.addEventListener("click", () => void submitDealLost(id));
}

async function submitDealLost(id: string) {
  const category = qs<HTMLSelectElement>("#dealLostCategoryInput")?.value || "";
  const reason = qs<HTMLTextAreaElement>("#dealLostReasonInput")?.value.trim() || "";
  const revisitAt = qs<HTMLInputElement>("#dealRevisitAtInput")?.value || "";
  if (!reason) {
    toast("请填写具体丢单原因", "error");
    return;
  }
  const button = qs<HTMLButtonElement>("#confirmDealLostButton");
  if (button?.disabled) return;
  setButtonPending(button, true, "确认丢单", "提交中…");
  let result: { deal: Deal };
  try {
    result = await api<{ deal: Deal }>(`/api/deals/${id}/lost`, {
      method: "POST",
      body: JSON.stringify({ category, reason, revisitAt })
    });
  } catch (error) {
    setButtonPending(button, false, "确认丢单", "确认丢单");
    toast(error instanceof Error ? error.message : "丢单提交失败，请重试", "error");
    return;
  }
  Object.assign(state.deals.find((item) => item.id === id) || {}, result.deal);
  closeModal();
  toast("商机已标记丢单，可在关闭区复盘");
  await refreshDealsData();
  void refreshDashboardOnly();
  void loadProspectFeedback(true, true);
}

export function formatDateTime(value?: string) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export async function refreshClosedDeals() {
  const params = new URLSearchParams({
    page: String(state.closedDealPage),
    pageSize: "10",
    keyword: state.closedDealKeyword,
    status: state.closedDealStatus,
    month: state.closedDealMonth
  });
  const result = await api<{ deals: Deal[]; total: number; page: number; pageSize: number; counts: { won: number; lost: number; revisit: number; archived: number } }>(`/api/deals/closed?${params.toString()}`);
  state.closedDeals = result.deals;
  state.closedDealTotal = result.total;
  state.closedDealCounts = result.counts;
  renderArchivedDeals(result.deals, result.total, result.page, result.pageSize);
}

function renderArchivedDeals(deals: Deal[], total: number, page: number, pageSize: number) {
  const box = qs<HTMLElement>("#pipeline-archived-deals");
  if (!box) return;
  const summary = qs<HTMLElement>("#pipelineClosedSummary");
  if (summary) summary.textContent = `已成交 ${state.closedDealCounts.won} · 已丢单 ${state.closedDealCounts.lost} · 待复访 ${state.closedDealCounts.revisit} · 已归档 ${(state.closedDealCounts as { archived?: number }).archived || 0}`;
  box.innerHTML = deals.length ? deals.map((deal) => {
    const customer = state.customers.find((item) => item.id === deal.customerId);
    const product = dealItemsSummary(deal);
    const review = deal.stage === "丢单"
      ? `${deal.lostReasonCategory || "未分类"}：${deal.lostReason || "待补充复盘"}${deal.revisitAt ? ` · ${deal.revisitAt} 复访` : ""}`
      : `${deal.wonReason || "已成交"}${deal.archivedAt ? " · 已归档" : " · 待归档"}`;
    return `<tr data-closed-deal-id="${escapeHtml(deal.id)}"><td><b>${escapeHtml(deal.title)}</b><span>${escapeHtml(customer?.company || "客户待确认")} · ${escapeHtml(product)}</span></td><td>${dealMoney(deal.amount, deal.currency)}</td><td>${badge(deal.stage, deal.stage === "丢单" ? "red" : "green")}</td><td>${escapeHtml(formatDateTime(deal.closedAt || deal.archivedAt))}</td><td>${escapeHtml(review)}${deal.archivedAt ? ` <button type="button" class="btn" data-restore-deal="${escapeHtml(deal.id)}">恢复</button>` : ""}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="empty-cell">当前筛选下暂无关闭商机。</td></tr>`;
  qsa<HTMLElement>("[data-closed-deal-id]", box).forEach((row) => row.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    openDealDrawer(row.dataset.closedDealId || "");
  }));
  qsa<HTMLButtonElement>("[data-restore-deal]", box).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void restoreDeal(button.dataset.restoreDeal || "", event.currentTarget as HTMLButtonElement);
    });
  });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageLabel = qs<HTMLElement>("#pipelineClosedPage");
  if (pageLabel) pageLabel.textContent = `第 ${page} / ${totalPages} 页 · ${total} 条`;
  const prev = qs<HTMLButtonElement>("#pipelineClosedPrev");
  const next = qs<HTMLButtonElement>("#pipelineClosedNext");
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page >= totalPages;
}

/** 归档商机独立界面：status=archived + 可选成交结果细分，检索/翻页/拉回都在这一个界面完成。 */
export async function refreshDealArchive() {
  const params = new URLSearchParams({
    page: String(state.dealArchivePage),
    pageSize: "10",
    keyword: state.dealArchiveKeyword,
    status: "archived",
    stage: state.dealArchiveStage,
    month: state.dealArchiveMonth
  });
  const result = await api<{ deals: Deal[]; total: number; page: number; pageSize: number; counts: { won: number; lost: number; revisit: number; archived: number } }>(`/api/deals/closed?${params.toString()}`);
  state.dealArchive = result.deals;
  state.dealArchiveTotal = result.total;
  state.dealArchiveCounts = { won: result.counts.won, lost: result.counts.lost };
  renderDealArchive(result.deals, result.total, result.page, result.pageSize);
}

function renderDealArchive(deals: Deal[], total: number, page: number, pageSize: number) {
  const body = qs<HTMLElement>("#dealArchiveTableBody");
  if (!body) return;
  const summary = qs<HTMLElement>("#dealArchiveSummary");
  if (summary) {
    summary.innerHTML = `
      <div><span class="stat-label">归档商机</span><b class="stat-value">${total}</b><span class="stat-note">当前筛选下的归档总数</span></div>
      <div><span class="stat-label">已成交归档</span><b class="stat-value">${state.dealArchiveCounts.won}</b><span class="stat-note">恢复后阶段保持成交</span></div>
      <div><span class="stat-label">已丢单归档</span><b class="stat-value">${state.dealArchiveCounts.lost}</b><span class="stat-note">恢复后阶段保持丢单</span></div>`;
  }
  body.innerHTML = deals.length ? deals.map((deal) => {
    const customer = state.customers.find((item) => item.id === deal.customerId);
    const product = dealItemsSummary(deal);
    const review = deal.stage === "丢单"
      ? `${deal.lostReasonCategory || "未分类"}：${deal.lostReason || "待补充复盘"}${deal.revisitAt ? ` · ${deal.revisitAt} 复访` : ""}`
      : `${deal.wonReason || "已成交"}`;
    return `<tr data-archive-deal-id="${escapeHtml(deal.id)}"><td class="deal-archive-deal"><b>${escapeHtml(deal.title)}</b><span>${escapeHtml(customer?.company || "客户待确认")} · ${escapeHtml(product)}</span></td><td>${dealMoney(deal.amount, deal.currency)}</td><td>${badge(deal.stage, deal.stage === "丢单" ? "red" : "green")}</td><td>${escapeHtml(formatDateTime(deal.closedAt || deal.archivedAt))}</td><td class="deal-archive-review">${escapeHtml(review)}</td><td><div class="deal-archive-actions"><button type="button" class="btn" data-archive-view="${escapeHtml(deal.id)}">查看</button><button type="button" class="btn" data-archive-restore="${escapeHtml(deal.id)}">恢复</button></div></td></tr>`;
  }).join("") : `<tr><td colspan="6" class="empty-cell">当前筛选下暂无归档商机。</td></tr>`;
  qsa<HTMLElement>("[data-archive-deal-id]", body).forEach((row) => row.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    openArchivedDealInPipeline(row.dataset.archiveDealId || "");
  }));
  qsa<HTMLButtonElement>("[data-archive-view]", body).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openArchivedDealInPipeline(button.dataset.archiveView || "");
    });
  });
  qsa<HTMLButtonElement>("[data-archive-restore]", body).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void restoreDealFromArchive(button.dataset.archiveRestore || "", event.currentTarget as HTMLButtonElement);
    });
  });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageLabel = qs<HTMLElement>("#dealArchivePage");
  if (pageLabel) pageLabel.textContent = `第 ${page} / ${totalPages} 页 · ${total} 条`;
  const prev = qs<HTMLButtonElement>("#dealArchivePrev");
  const next = qs<HTMLButtonElement>("#dealArchiveNext");
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page >= totalPages;
}

/** 归档列表的「查看」：商机抽屉挂在商机管道视图里，先切过去再开。 */
export function openArchivedDealInPipeline(id: string) {
  if (!id) return;
  activateNavView("pipeline", () => openDealDrawer(id));
}

async function restoreDealFromArchive(id: string, button: HTMLButtonElement | null = null) {
  await restoreDeal(id, button);
  state.dealArchivePage = 1;
  await refreshDealArchive().catch(() => undefined);
}

export async function refreshDealsData(render = true) {
  const result = await api<{ deals: Deal[]; events: DealEvent[] }>("/api/deals");
  state.deals = result.deals;
  state.dealEvents = result.events;
  if (render) renderPipeline(state.deals);
  await refreshClosedDeals();
  if (state.selectedDealId) renderDealDrawer(state.selectedDealId);
}

export function dealEventLabel(type: string) {
  const labels: Record<string, string> = {
    created: "创建商机",
    updated: "关键信息更新",
    stage: "阶段变化",
    follow_up: "跟进记录",
    quote: "报价记录",
    sample: "样品记录",
    negotiation: "谈判记录",
    payment: "回款记录",
    document: "单据记录",
    won: "确认成交",
    lost: "丢单复盘",
    archived: "归档",
    restored: "恢复归档"
  };
  return labels[type] || type;
}

function openDealDrawer(id: string) {
  if (!id) return;
  state.selectedDealId = id;
  renderDealDrawer(id);
  qs("#dealDrawer")?.classList.add("open");
  qs("#dealDrawerBackdrop")?.classList.add("open");
}

export function closeDealDrawer() {
  state.selectedDealId = null;
  qs("#dealDrawer")?.classList.remove("open");
  qs("#dealDrawerBackdrop")?.classList.remove("open");
}

function renderDealDrawer(id: string) {
  const drawer = qs<HTMLElement>("#dealDrawer");
  if (!drawer) return;
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) {
    closeDealDrawer();
    return;
  }
  const customer = state.customers.find((item) => item.id === deal.customerId);
  const events = state.dealEvents.filter((event) => event.dealId === deal.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const documents = state.tradeDocuments.filter((document) => document.dealId === deal.id).sort((left, right) => right.revision - left.revision);
  const closed = deal.stage === "成交" || deal.stage === "丢单";
  drawer.innerHTML = `
    <div class="deal-detail-head">
      <div><h2>${escapeHtml(deal.title)}</h2><p>${escapeHtml(customer?.company || "客户待确认")} · ${escapeHtml(dealProductsText(deal))}</p></div>
      <button class="btn" id="closeDealDrawerButton">关闭</button>
    </div>
    <div class="deal-detail-grid">
      <div class="info"><span>当前阶段</span><b>${escapeHtml(deal.stage)} · 进入于 ${escapeHtml(formatDateTime(deal.stageChangedAt))}</b></div>
      <div class="info"><span>金额口径</span><b>${dealMoney(deal.amount, deal.currency)} · ${deal.amountType === "won" ? "成交额" : deal.amountType === "quoted" ? "报价额" : "估算额"}</b></div>
      <div class="info"><span>下一动作</span><b>${escapeHtml(deal.nextAction)} · ${escapeHtml(deal.nextActionAt || "待安排")}</b></div>
      <div class="info"><span>预计成交</span><b>${escapeHtml(deal.expectedCloseAt || "待评估")}</b></div>
      <div class="info"><span>关联单据</span><b>${documents.length ? documents.map((document) => `${document.type} ${escapeHtml(document.number)} v${document.revision}`).join(" · ") : "暂未关联 PI/CI"}</b></div>
      <div class="info"><span>${deal.stage === "丢单" ? "丢单复盘" : "关闭状态"}</span><b>${deal.stage === "丢单" ? `${escapeHtml(deal.lostReasonCategory || "未分类")}：${escapeHtml(deal.lostReason || "待补充")}` : deal.stage === "成交" ? escapeHtml(deal.wonReason || "已确认成交") : "活跃推进中"}</b></div>
    </div>
    <div class="deal-detail-products">
      <div class="section-head"><div><h3>产品明细</h3><span class="subline">${dealItemsOf(deal).length} 项 · ${dealMoney(deal.amount, deal.currency)}</span></div></div>
      ${dealItemsOf(deal).map((item) => `<div class="deal-detail-product-row"><span><b>${escapeHtml(item.product)}</b><small>${escapeHtml(item.model || "型号未填写")}</small></span><span>${item.quantity} × ${dealMoney(item.unitPrice, deal.currency)}</span><strong>${dealMoney(item.quantity * item.unitPrice, deal.currency)}</strong></div>`).join("")}
    </div>
    <div id="dealWinGauge"><div style="padding:12px;text-align:center;color:var(--muted);font-size:12px;">AI 赢率分析中...</div></div>
    <div class="deal-detail-actions">
      ${deal.stage === "成交" && deal.orderId ? `<button class="btn primary" id="drawerOpenOrderButton">查看订单</button>` : ""}
      ${closed ? "" : `<button class="btn primary" id="drawerAdvanceDealButton">${dealPrimaryAction(deal.stage)}</button><button class="btn" id="drawerRecordDealButton">记录进展</button><button class="btn" id="drawerEditDealButton">编辑</button>`}
      ${closed && !deal.archivedAt ? `<button class="btn" id="drawerDuplicateDealButton">复制商机</button>` : ""}
      ${deal.archivedAt ? `<button class="btn" id="drawerRestoreDealButton">恢复商机</button>` : ""}
      <button class="btn" id="drawerQuoteHistoryButton">报价历史</button>
      ${deal.stage === "已联系" ? `<button class="btn" id="drawerGenerateQuotationButton">生成报价单</button>` : ""}
      ${["已报价", "样品", "谈判", "成交"].includes(deal.stage) ? `<button class="btn" id="drawerPrintDealButton">${deal.stage === "成交" ? "生成 CI" : "生成 PI"}</button>` : ""}
      ${["已报价", "样品", "谈判", "成交"].includes(deal.stage) ? `<button class="btn" id="drawerGenerateCustomsButton">生成报关资料</button>` : ""}
      ${deal.stage === "成交" && !deal.archivedAt ? `<button class="btn" id="drawerArchiveDealButton">归档成交</button>` : ""}
      <button class="btn danger" id="drawerDeleteDealButton">删除商机</button>
    </div>
    <div class="section-head" style="margin-top:16px"><div><h3>商机时间线</h3><span class="subline">阶段、报价、样品、谈判、回款与关闭记录</span></div></div>
    <div class="deal-timeline">${events.length ? events.map((event) => `
      <div class="deal-event ${["follow_up", "quote", "sample", "negotiation", "payment"].includes(event.type) ? "manual" : ""}">
        <b>${escapeHtml(dealEventLabel(event.type))}${event.fromStage && event.toStage && event.fromStage !== event.toStage ? ` · ${escapeHtml(event.fromStage)} → ${escapeHtml(event.toStage)}` : ""}</b>
        <p>${escapeHtml(event.content)}</p>
        <span>${escapeHtml(event.operatorName || "未知操作人")} · ${escapeHtml(formatDateTime(event.createdAt))}${event.nextAction ? ` · 下一步：${escapeHtml(event.nextAction)} ${escapeHtml(event.nextActionAt || "")}` : ""}</span>
      </div>`).join("") : `<div class="deal-empty">暂无时间线记录</div>`}</div>
  `;
  qs("#closeDealDrawerButton", drawer)?.addEventListener("click", closeDealDrawer);
  qs("#drawerOpenOrderButton", drawer)?.addEventListener("click", () => {
    const orderId = deal.orderId || "";
    if (!orderId) return;
    closeDealDrawer();
    void openOrderDetail(orderId);
  });
  qs("#drawerAdvanceDealButton", drawer)?.addEventListener("click", () => openDealStageModal(deal.id));
  qs("#drawerRecordDealButton", drawer)?.addEventListener("click", () => openDealEventModal(deal.id));
  qs("#drawerEditDealButton", drawer)?.addEventListener("click", () => openDealModal(deal));
  qs("#drawerQuoteHistoryButton", drawer)?.addEventListener("click", () => openQuoteHistoryForDeal(deal.id));
  qs("#drawerGenerateQuotationButton", drawer)?.addEventListener("click", () => void printDealDocument(deal.id, "QUOTATION"));
  qs("#drawerPrintDealButton", drawer)?.addEventListener("click", () => void printDealDocument(deal.id));
  qs("#drawerGenerateCustomsButton", drawer)?.addEventListener("click", () => void generateCustomsDocument(deal.id));
  qs("#drawerArchiveDealButton", drawer)?.addEventListener("click", () => void archiveDeal(deal.id));
  qs("#drawerDuplicateDealButton", drawer)?.addEventListener("click", (event) => void duplicateDeal(deal.id, event.currentTarget as HTMLButtonElement));
  qs("#drawerRestoreDealButton", drawer)?.addEventListener("click", (event) => void restoreDeal(deal.id, event.currentTarget as HTMLButtonElement));
  qs("#drawerDeleteDealButton", drawer)?.addEventListener("click", (event) => void deleteDeal(deal.id, event.currentTarget as HTMLButtonElement));
  void loadDealWinProbability(deal.id);
}

async function loadDealWinProbability(dealId: string) {
  const container = qs<HTMLElement>("#dealWinGauge");
  if (!container) return;
  try {
    const result = await api<{
      winProbability: number;
      factors: { name: string; score: number; description: string }[];
      advice: string;
      isClosed: boolean;
    }>(`/api/deals/${encodeURIComponent(dealId)}/win-probability`);
    const prob = result.winProbability;
    const color = prob >= 61 ? "var(--green)" : prob >= 31 ? "var(--amber)" : "var(--rose)";
    const arcLen = 220;
    const dashOffset = Math.round(arcLen * (1 - prob / 100));
    container.innerHTML = `
      <div class="deal-win-gauge">
        <div class="gauge-wrap">
          <svg class="gauge-svg" viewBox="0 0 120 75">
            <path class="gauge-arc-bg" d="M 10 65 A 50 50 0 1 1 110 65" />
            <path class="gauge-arc-fg" id="gaugeArcFg" d="M 10 65 A 50 50 0 1 1 110 65"
              stroke="${color}"
              stroke-dasharray="${arcLen}"
              stroke-dashoffset="${arcLen}" />
          </svg>
          <div class="gauge-center">
            <b class="gauge-value" style="color:${color}">${prob}%</b>
            <span class="gauge-label">${result.isClosed ? "已关闭" : "AI 预测赢率"}</span>
          </div>
        </div>
        <div class="gauge-factors">
          ${result.factors.map((factor) => {
            const fc = factor.score >= 61 ? "var(--green)" : factor.score >= 31 ? "var(--amber)" : "var(--rose)";
            return `<div class="gauge-factor">
              <span class="gauge-factor-name">${escapeHtml(factor.name)}</span>
              <div class="gauge-factor-bar"><div class="gauge-factor-fill" style="width:0;background:${fc}" data-target="${factor.score}"></div></div>
              <span class="gauge-factor-score">${factor.score}</span>
            </div>`;
          }).join("")}
        </div>
        <div class="gauge-advice">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2a4 4 0 0 0-4 4v1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2V6a4 4 0 0 0-4-4z"/><path d="M9 14l2 2 4-4"/></svg>
          <p>${escapeHtml(result.advice)}</p>
        </div>
      </div>`;
    requestAnimationFrame(() => {
      const arc = qs<HTMLElement>("#gaugeArcFg", container);
      if (arc) arc.style.strokeDashoffset = String(dashOffset);
      qsa<HTMLElement>(".gauge-factor-fill", container).forEach((bar) => {
        const target = bar.dataset.target || "0";
        bar.style.width = `${target}%`;
      });
    });
  } catch {
    container.innerHTML = "";
  }
}

function openDealEventModal(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) {
    toast("商机数据已变化，请刷新后重试", "error");
    return;
  }
  const defaultType = deal.stage === "已报价" ? "quote" : deal.stage === "样品" ? "sample" : deal.stage === "谈判" ? "negotiation" : "follow_up";
  openModal("记录商机进展", `
    <div class="form-grid">
      <div class="form-field"><label>记录类型</label><select id="dealEventTypeInput">
        <option value="follow_up" ${defaultType === "follow_up" ? "selected" : ""}>跟进</option>
        <option value="quote" ${defaultType === "quote" ? "selected" : ""}>报价</option>
        <option value="sample" ${defaultType === "sample" ? "selected" : ""}>样品</option>
        <option value="negotiation" ${defaultType === "negotiation" ? "selected" : ""}>谈判</option>
        <option value="payment">回款节点（销售记录）</option>
      </select></div>
      <div class="form-field"><label>下一动作日期</label><input id="dealEventNextActionAtInput" type="date" value="${escapeHtml(deal.nextActionAt || defaultFutureDate(2))}"></div>
      <div class="form-field full"><label>本次进展</label><textarea id="dealEventContentInput" rows="4" placeholder="记录客户反馈、报价结果、样品状态或谈判结论"></textarea></div>
      <div class="form-field full"><label>下一步动作</label><input id="dealEventNextActionInput" value="${escapeHtml(deal.nextAction)}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveDealEventButton">保存进展</button>`);
  qs("#saveDealEventButton")?.addEventListener("click", () => void saveDealEvent(id));
}

async function saveDealEvent(id: string) {
  const type = qs<HTMLSelectElement>("#dealEventTypeInput")?.value || "follow_up";
  const content = qs<HTMLTextAreaElement>("#dealEventContentInput")?.value.trim() || "";
  const nextAction = qs<HTMLInputElement>("#dealEventNextActionInput")?.value.trim() || "";
  const nextActionAt = qs<HTMLInputElement>("#dealEventNextActionAtInput")?.value || "";
  if (!content || !nextAction || !nextActionAt) {
    toast("请填写本次进展、下一动作和日期", "error");
    return;
  }
  const button = qs<HTMLButtonElement>("#saveDealEventButton");
  if (button?.disabled) return;
  setButtonPending(button, true, "保存进展", "保存中…");
  try {
    await api(`/api/deals/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type, content, nextAction, nextActionAt })
    });
  } catch (error) {
    setButtonPending(button, false, "保存进展", "保存进展");
    toast(error instanceof Error ? error.message : "进展保存失败，请重试", "error");
    return;
  }
  closeModal();
  toast("商机进展已记录");
  await refreshDealsData();
}

export function openDealModal(
  editing?: Deal,
  recommendation?: DealRecommendation,
  customerId?: string
) {
  const selectedCustomerId = editing?.customerId
    || customerId
    || recommendation?.customerId
    || "";
  const defaultCustomer = selectedCustomerId
    ? state.customers.find((item) => item.id === selectedCustomerId)
    : undefined;
  const title = editing?.title || recommendation?.suggestedTitle || "";
  const existingItems = dealItemsOf(editing || {
    id: "",
    customerId: selectedCustomerId,
    title,
    stage: "询盘",
    product: recommendation?.suggestedProduct || "",
    quantity: recommendation?.suggestedQuantity || 30,
    unitPrice: recommendation?.suggestedUnitPrice || (recommendation?.suggestedAmount ? recommendation.suggestedAmount / Math.max(1, recommendation.suggestedQuantity || 1) : 600),
    amount: recommendation?.suggestedAmount || 18000,
    currency: recommendation?.currency || "USD",
    amountType: "estimate",
    nextAction: recommendation?.nextAction || "",
    nextActionAt: recommendation?.nextActionAt || "",
    expectedCloseAt: recommendation?.expectedCloseAt || "",
    stageChangedAt: ""
  });
  const productOptions = state.products.flatMap((product) => [product.nameZh, product.nameEn, product.model].filter(Boolean))
    .filter((value, index, list) => list.indexOf(value) === index)
    .map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
  openModal(editing ? "编辑商机" : "新增商机", `
    <div class="form-grid">
      <input id="dealIdInput" type="hidden" value="${escapeHtml(editing?.id || "")}">
      <input id="dealRecommendationIdInput" type="hidden" value="${escapeHtml(editing ? "" : recommendation?.id || "")}">
      <div class="form-field full"><label>商机名称</label><input id="dealTitleInput" value="${escapeHtml(title)}" placeholder="例如：年度采购项目"></div>
      <div class="form-field deal-customer-field">
        <label>关联客户（必选）</label>
        <input id="dealCustomerInput" value="${escapeHtml(defaultCustomer?.company || "")}" placeholder="输入客户简称并从列表选择" autocomplete="off">
        <input id="dealCustomerIdInput" type="hidden" value="${escapeHtml(defaultCustomer?.id || "")}">
        <button class="deal-customer-clear" id="clearDealCustomerButton" type="button" title="清空关联客户">×</button>
        <div class="deal-customer-options" id="dealCustomerOptions"></div>
      </div>
      <div class="form-field"><label>币种</label><select id="dealCurrencyInput">${["USD", "EUR", "GBP", "CNY", "JPY", "AED"].map((currency) => `<option ${currency === (editing?.currency || recommendation?.currency || "USD") ? "selected" : ""}>${currency}</option>`).join("")}</select></div>
      <div class="form-field full deal-items-field">
        <div class="deal-items-heading"><label>产品明细（至少一项）</label><button class="btn" id="addDealItemButton" type="button">+ 添加产品</button></div>
        <datalist id="dealProductCatalogOptions">${productOptions}</datalist>
        <div class="deal-items-list" id="dealItemsList">${existingItems.map((item) => renderDealItemEditorRow(item)).join("")}</div>
        <div class="deal-items-total"><span>商机总金额</span><b id="dealAmountDisplay">0.00</b></div>
      </div>
      <div class="form-field"><label>下一动作日期</label><input id="dealNextActionAtInput" type="date" value="${escapeHtml(editing?.nextActionAt || recommendation?.nextActionAt || defaultFutureDate(2))}"></div>
      <div class="form-field"><label>预计成交日期</label><input id="dealExpectedCloseAtInput" type="date" value="${escapeHtml(editing?.expectedCloseAt || recommendation?.expectedCloseAt || defaultFutureDate(21))}"></div>
      <div class="form-field full"><label>下一步动作</label><input id="dealNextActionInput" value="${escapeHtml(editing?.nextAction || recommendation?.nextAction || "确认采购清单并安排报价")}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveDealButton">${editing ? "保存修改" : "保存商机"}</button>`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("deal-editor-modal");
  bindDealCustomerPicker();
  bindDealItemsEditor();
  qs("#saveDealButton")?.addEventListener("click", () => void saveDeal());
}

function renderDealItemEditorRow(item: DealItem) {
  return `<div class="deal-item-row" data-deal-item-id="${escapeHtml(item.id)}" data-product-id="${escapeHtml(item.productId || "")}">
    <label class="deal-item-product"><span>产品</span><input data-deal-item-product list="dealProductCatalogOptions" value="${escapeHtml(item.product)}" placeholder="产品名称" autocomplete="off"></label>
    <label><span>型号</span><input data-deal-item-model value="${escapeHtml(item.model || "")}" placeholder="可选"></label>
    <label><span>数量</span><input data-deal-item-quantity type="number" min="1" step="1" value="${Number(item.quantity || 1)}"></label>
    <label><span>单价</span><input data-deal-item-price type="number" min="0" step="0.01" value="${Number(item.unitPrice || 0)}"></label>
    <span class="deal-item-subtotal"><small>小计</small><b data-deal-item-subtotal>0.00</b></span>
    <button class="deal-item-remove" data-remove-deal-item type="button" title="删除产品" aria-label="删除产品">×</button>
  </div>`;
}

function bindDealItemsEditor() {
  const list = qs<HTMLElement>("#dealItemsList");
  const total = qs<HTMLElement>("#dealAmountDisplay");
  if (!list || !total) return;
  const update = () => {
    let amount = 0;
    qsa<HTMLElement>(".deal-item-row", list).forEach((row) => {
      const subtotal = Number(qs<HTMLInputElement>("[data-deal-item-quantity]", row)?.value || 0)
        * Number(qs<HTMLInputElement>("[data-deal-item-price]", row)?.value || 0);
      amount += subtotal;
      const node = qs<HTMLElement>("[data-deal-item-subtotal]", row);
      if (node) node.textContent = subtotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    });
    total.textContent = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const bindRow = (row: HTMLElement) => {
    qsa<HTMLInputElement>("input", row).forEach((input) => input.addEventListener("input", update));
    qs<HTMLInputElement>("[data-deal-item-product]", row)?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLInputElement).value.trim().toLowerCase();
      const product = state.products.find((item) => [item.nameZh, item.nameEn, item.model].some((field) => field.trim().toLowerCase() === value));
      if (!product) return;
      row.dataset.productId = product.id;
      const model = qs<HTMLInputElement>("[data-deal-item-model]", row);
      const price = qs<HTMLInputElement>("[data-deal-item-price]", row);
      if (model && !model.value) model.value = product.model;
      if (price && !Number(price.value)) price.value = String(product.price || 0);
      update();
    });
    qs<HTMLButtonElement>("[data-remove-deal-item]", row)?.addEventListener("click", () => {
      if (qsa(".deal-item-row", list).length <= 1) {
        toast("商机至少保留一项产品", "error");
        return;
      }
      row.remove();
      update();
    });
  };
  qsa<HTMLElement>(".deal-item-row", list).forEach(bindRow);
  qs<HTMLButtonElement>("#addDealItemButton")?.addEventListener("click", () => {
    list.insertAdjacentHTML("beforeend", renderDealItemEditorRow({ id: `deal_item_${crypto.randomUUID()}`, product: "", model: "", quantity: 1, unitPrice: 0 }));
    const row = list.lastElementChild as HTMLElement | null;
    if (row) {
      bindRow(row);
      qs<HTMLInputElement>("[data-deal-item-product]", row)?.focus();
    }
    update();
  });
  update();
}

function filteredDealCustomers(keyword: string) {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return state.customers.slice(0, 8);
  return state.customers
    .filter((customer) => `${customer.company} ${customer.companyFullName || ""} ${customer.contact} ${customer.country} ${customer.id}`.toLowerCase().includes(normalized))
    .slice(0, 8);
}

function renderDealCustomerOptions(keyword = "") {
  const box = qs<HTMLElement>("#dealCustomerOptions");
  if (!box) return;
  const customers = filteredDealCustomers(keyword);
  box.innerHTML = customers.length ? customers.map((customer) => `
    <button type="button" data-deal-customer-id="${escapeHtml(customer.id)}">
      <b>${escapeHtml(customer.company)}</b>
      <span>${escapeHtml(customer.contact || "待维护")} · ${escapeHtml(customer.country || "未知国家")}</span>
    </button>
  `).join("") : `<div class="deal-customer-empty">没有匹配客户，请先到客户管理创建客户</div>`;
  qsa<HTMLButtonElement>("[data-deal-customer-id]", box).forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const customer = state.customers.find((item) => item.id === button.dataset.dealCustomerId);
      if (!customer) return;
      const input = qs<HTMLInputElement>("#dealCustomerInput");
      const idInput = qs<HTMLInputElement>("#dealCustomerIdInput");
      if (input) input.value = customer.company;
      if (idInput) idInput.value = customer.id;
      box.classList.remove("active");
    });
  });
}

function bindDealCustomerPicker() {
  const input = qs<HTMLInputElement>("#dealCustomerInput");
  const idInput = qs<HTMLInputElement>("#dealCustomerIdInput");
  const box = qs<HTMLElement>("#dealCustomerOptions");
  const clear = qs<HTMLButtonElement>("#clearDealCustomerButton");
  if (!input || !idInput || !box) return;
  renderDealCustomerOptions(input.value);
  input.addEventListener("focus", () => {
    renderDealCustomerOptions(input.value);
    box.classList.add("active");
  });
  input.addEventListener("input", () => {
    const exact = state.customers.find((customer) => customer.company.toLowerCase() === input.value.trim().toLowerCase());
    idInput.value = exact?.id || "";
    renderDealCustomerOptions(input.value);
    box.classList.add("active");
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const first = qs<HTMLButtonElement>("[data-deal-customer-id]", box);
      if (first && box.classList.contains("active")) {
        event.preventDefault();
        first.click();
      }
    }
    if (event.key === "Escape") box.classList.remove("active");
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => box.classList.remove("active"), 120);
  });
  clear?.addEventListener("click", () => {
    input.value = "";
    idInput.value = "";
    renderDealCustomerOptions("");
    box.classList.remove("active");
    input.focus();
  });
}

async function saveDeal() {
  const dealId = qs<HTMLInputElement>("#dealIdInput")?.value.trim() || "";
  const recommendationId = qs<HTMLInputElement>("#dealRecommendationIdInput")?.value.trim() || "";
  const title = qs<HTMLInputElement>("#dealTitleInput")?.value.trim() || "";
  const items = qsa<HTMLElement>("#dealItemsList .deal-item-row").map((row) => ({
    id: row.dataset.dealItemId || `deal_item_${crypto.randomUUID()}`,
    productId: row.dataset.productId || "",
    product: qs<HTMLInputElement>("[data-deal-item-product]", row)?.value.trim() || "",
    model: qs<HTMLInputElement>("[data-deal-item-model]", row)?.value.trim() || "",
    quantity: Number(qs<HTMLInputElement>("[data-deal-item-quantity]", row)?.value || 0),
    unitPrice: Number(qs<HTMLInputElement>("[data-deal-item-price]", row)?.value || 0)
  }));
  const customerText = qs<HTMLInputElement>("#dealCustomerInput")?.value.trim() || "";
  const customerId = qs<HTMLInputElement>("#dealCustomerIdInput")?.value.trim() || "";
  if (!title) {
    toast("请填写商机名称", "error");
    return;
  }
  if (!items.length || items.some((item) => !item.product || !Number.isInteger(item.quantity) || item.quantity <= 0 || item.unitPrice < 0)) {
    toast("请完整填写每项产品、数量和单价", "error");
    return;
  }
  if (!customerText || !customerId) {
    toast("请从下拉列表选择关联客户", "error");
    return;
  }
  const nextAction = qs<HTMLInputElement>("#dealNextActionInput")?.value.trim() || "";
  const nextActionAt = qs<HTMLInputElement>("#dealNextActionAtInput")?.value || "";
  if (!nextAction || !nextActionAt) {
    toast("请填写下一动作和日期", "error");
    return;
  }
  const product = items.length > 2 ? `${items.slice(0, 2).map((item) => item.product).join("、")} 等 ${items.length} 项` : items.map((item) => item.product).join("、");
  const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const unitPrice = items.length === 1 ? items[0].unitPrice : 0;
  const amount = Math.round(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) * 100) / 100;
  const result = await api<{ deal: Deal }>(dealId ? `/api/deals/${dealId}` : "/api/deals", {
    method: dealId ? "PATCH" : "POST",
    body: JSON.stringify({
      title,
      customerId,
      product,
      quantity,
      unitPrice,
      items,
      amount,
      currency: qs<HTMLSelectElement>("#dealCurrencyInput")?.value || "USD",
      nextAction,
      nextActionAt,
      expectedCloseAt: qs<HTMLInputElement>("#dealExpectedCloseAtInput")?.value || "",
      ...(!dealId && recommendationId ? { recommendationId } : {})
    })
  });
  closeModal();
  await refreshDealsData();
  void refreshDashboardOnly();
  toast(dealId ? "商机已更新" : "商机已新增");
}

export function commissionStatusLabel(status: string) {
  const map: Record<string, string> = { draft: "待确认", confirmed: "已确认", reviewed: "已复核", locked: "已锁定", pending: "待计算", calculated: "已计算" };
  return map[status] || status;
}

export function commissionStatusTone(status: string) {
  if (status === "locked" || status === "reviewed" || status === "confirmed" || status === "calculated") return "green";
  if (status === "draft" || status === "pending") return "amber";
  return "gray";
}

export function commissionRuleLabel(rule?: CommissionRule) {
  if (!rule) return "未配置";
  if (rule.ruleType === "rate") return `销售额 ${(rule.rate * 100).toFixed(2)}%`;
  if (rule.ruleType === "fixed") return `固定 ${currencyAmount(rule.fixedAmount)} / 件`;
  if (rule.ruleType === "gross_profit") return `毛利 ${(rule.grossProfitRate * 100).toFixed(2)}%`;
  if (rule.ruleType === "tier") return "阶梯计提";
  return "不计提";
}

export function commissionExchangeSourceLabel(source?: string) {
  if (source === "finance") return "财务汇率";
  if (source === "manual") return "手工汇率";
  return "待核汇率";
}

export function findCommissionProductForRecord(record: MonthlySalesRecord) {
  const normalized = record.productName.trim().toLowerCase();
  return state.commissionProducts.find((product) => product.id === record.productId)
    || state.commissionProducts.find((product) => product.status === "active" && (
      product.name.toLowerCase() === normalized ||
      product.model.toLowerCase() === normalized ||
      normalized.includes(product.name.toLowerCase()) ||
      (product.model && normalized.includes(product.model.toLowerCase()))
    ));
}

export function activeRuleForProduct(productId = "") {
  return state.commissionRules
    .filter((rule) => rule.productId === productId && rule.enabled)
    .filter((rule) => (!rule.effectiveFrom || rule.effectiveFrom <= state.commissionMonth) && (!rule.effectiveTo || rule.effectiveTo >= state.commissionMonth))
    .sort((left, right) => (right.effectiveFrom || "").localeCompare(left.effectiveFrom || "") || right.createdAt.localeCompare(left.createdAt))[0];
}

export function estimateCommissionForRecord(record: MonthlySalesRecord) {
  const product = findCommissionProductForRecord(record);
  const rule = activeRuleForProduct(product?.id || record.productId);
  const sales = Number(record.settlementAmount || record.salesAmount || 0);
  if (!rule || rule.ruleType === "none") return 0;
  if (rule.ruleType === "rate") return sales * Number(rule.rate || 0);
  if (rule.ruleType === "fixed") return Number(record.quantity || 1) * Number(rule.fixedAmount || 0);
  if (rule.ruleType === "gross_profit") {
    const cost = Number(product?.costPrice || 0) * Number(record.quantity || 0);
    return Math.max(0, sales - cost) * Number(rule.grossProfitRate || 0);
  }
  if (rule.ruleType === "tier") {
    try {
      const tiers = JSON.parse(rule.tierJson || "[]") as Array<{ from?: number; to?: number; rate?: number }>;
      const matched = tiers.find((tier) => sales >= Number(tier.from || 0) && sales < Number(tier.to || Number.MAX_SAFE_INTEGER));
      return sales * Number(matched?.rate || 0);
    } catch {
      return 0;
    }
  }
  return 0;
}

export async function refreshCommissionData() {
  const [products, records, calculations] = await Promise.all([
    api<{ products: CommissionProduct[]; rules: CommissionRule[]; canManage: boolean; canSelectOwner: boolean; owners: CommissionOwner[] }>("/api/commission/products"),
    api<{ records: MonthlySalesRecord[]; owners?: CommissionOwner[]; canSelectOwner?: boolean; selectedOwnerId?: string }>(`/api/commission/sales-records?month=${encodeURIComponent(state.commissionMonth)}&ownerId=${encodeURIComponent(state.selectedCommissionOwnerId || "")}`),
    api<{ calculations: CommissionCalculation[]; items: CommissionItem[]; canReview: boolean; canSelectOwner?: boolean; owners?: CommissionOwner[]; selectedOwnerId?: string }>(`/api/commission/calculations?month=${encodeURIComponent(state.commissionMonth)}&ownerId=${encodeURIComponent(state.selectedCommissionOwnerId || "")}`)
  ]);
  state.commissionProducts = products.products;
  state.commissionRules = products.rules;
  state.commissionCanManage = products.canManage;
  state.commissionCanSelectOwner = products.canSelectOwner;
  state.commissionOwners = products.owners || records.owners || calculations.owners || [];
  state.selectedCommissionOwnerId = state.commissionCanSelectOwner
    ? (records.selectedOwnerId || calculations.selectedOwnerId || state.selectedCommissionOwnerId || "all")
    : (state.user?.id || "");
  state.commissionRecords = records.records;
  state.commissionCalculations = calculations.calculations;
  state.commissionItems = calculations.items;
  state.commissionCanReview = calculations.canReview;
  renderCommission();
}
