/**
 * 外贸单证、单证导入与识别模板、文档素材与默认值、报价历史、报关资料路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { exportAdvancedDocumentTemplate, listAdvancedDocumentTemplates } from "../advanced-document-templates.js";
import { excelBufferSha256, ExcelPreviewUnavailableError, renderExcelBufferToPdf } from "../excel-preview.js";
import { createTradeDocumentImportAnalysis, parseTradeDocumentImport, TRADE_DOCUMENT_IMPORT_MAX_BYTES, tradeDocumentImportSha256 } from "../trade-document-import.js";
import { applyTradeDocumentRecognitionTemplate, buildTradeDocumentRecognitionTemplate, matchTradeDocumentRecognitionTemplate } from "../trade-document-recognition-template.js";
import { canSeeOwner, hasIamPermission, requireAuth } from "../auth.js";
import { isTradeDocumentOcrMime, recognizeConfiguredTradeDocument, recognizeTradeDocument } from "../trade-document-ocr.js";
import { type Customer, type Deal, type DocumentDefaultProfile, type DocumentLetterhead, type DocumentSignature, type DocumentStamp, normalizeDocumentAssetPlacement, normalizeDocumentLogoPlacements, type QuoteHistoryItem, type QuoteHistoryRecord, type SessionUser, type TradeDocument, type TradeDocumentImportAnalysis, type TradeDocumentSendRecord } from "../types.js";
import { getStore } from "../store.js";
import { customsDocumentExportIssues, exportCustomsDocumentToExcel } from "../customs-export.js";
import {
  asyncRoute,
  createDealEvent,
  createInternalNotification,
  currentMinuteText,
  dealProductSummary,
  documentAssetUrlForLocalFile,
  getAiConfig,
  teamSystemSettingsForTeam,
  tradeDocumentOcrProviderForTeam,
  uploadsDir
} from "../server-core.js";

function canApproveTradeDocuments(user?: SessionUser) {
  return hasIamPermission(user, "approval.task.act");
}

function quoteHistoryItems(document: TradeDocument): QuoteHistoryItem[] {
  return document.items.map((item) => ({
    productId: item.productId || "",
    product: item.product.trim(),
    model: item.model?.trim() || "",
    quantity: Number(item.quantity || 0),
    unit: item.unit?.trim() || "PCS",
    unitPrice: Math.round(Number(item.unitPrice || 0) * 100) / 100,
    lineTotal: Math.round(Number(item.quantity || 0) * Number(item.unitPrice || 0) * 100) / 100
  }));
}

function quoteItemKey(item: { productId?: string; product: string; model?: string }) {
  const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/[\s_-]+/gu, " ");
  return item.productId || `${normalize(item.product)}|${normalize(item.model || "")}`;
}

function quotePricingFingerprint(document: TradeDocument, items = quoteHistoryItems(document)) {
  return createHash("sha256").update(JSON.stringify({
    type: document.type,
    currency: document.currency.toUpperCase(),
    items: items.map((item) => ({ productId: item.productId, product: item.product, model: item.model, quantity: item.quantity, unit: item.unit, unitPrice: item.unitPrice }))
  })).digest("hex");
}

function quotePricingChanges(previous: QuoteHistoryRecord | undefined, document: TradeDocument, currentItems: QuoteHistoryItem[]) {
  if (!previous) return [`首次记录报价，共 ${currentItems.length} 项，合计 ${document.currency} ${currentItems.reduce((sum, item) => sum + item.lineTotal, 0).toFixed(2)}`];
  const changes: string[] = [];
  if (previous.currency !== document.currency) changes.push(`币种：${previous.currency} → ${document.currency}`);
  const previousItems = new Map(previous.items.map((item) => [quoteItemKey(item), item]));
  const currentMap = new Map(currentItems.map((item) => [quoteItemKey(item), item]));
  currentItems.forEach((item) => {
    const old = previousItems.get(quoteItemKey(item));
    const label = [item.product, item.model].filter(Boolean).join(" / ");
    if (!old) changes.push(`新增 ${label}：${item.quantity} ${item.unit} × ${document.currency} ${item.unitPrice.toFixed(2)}`);
    else {
      if (old.quantity !== item.quantity) changes.push(`${label} 数量：${old.quantity} → ${item.quantity} ${item.unit}`);
      if (old.unitPrice !== item.unitPrice || previous.currency !== document.currency) changes.push(`${label} 单价：${previous.currency} ${old.unitPrice.toFixed(2)} → ${document.currency} ${item.unitPrice.toFixed(2)}`);
    }
  });
  previous.items.forEach((item) => {
    if (!currentMap.has(quoteItemKey(item))) changes.push(`移除 ${[item.product, item.model].filter(Boolean).join(" / ")}`);
  });
  const total = currentItems.reduce((sum, item) => sum + item.lineTotal, 0);
  if (previous.totalAmount !== total || previous.currency !== document.currency) {
    changes.push(`报价合计：${previous.currency} ${previous.totalAmount.toFixed(2)} → ${document.currency} ${total.toFixed(2)}`);
  }
  return changes;
}

function syncDealPricingFromDocument(document: TradeDocument, user: SessionUser) {
  if (!document.dealId || !["PI", "QUOTATION"].includes(document.type)) return null;
  const store = getStore();
  const deal = store.deals.find((item) => item.id === document.dealId && item.teamId === document.teamId);
  if (!deal) return null;
  const customer = store.customers.find((item) => item.id === deal.customerId && item.teamId === deal.teamId);
  const items = quoteHistoryItems(document);
  const fingerprint = quotePricingFingerprint(document, items);
  const previous = store.quoteHistory
    .filter((item) => item.dealId === deal.id)
    .sort((left, right) => right.quotedAt.localeCompare(left.quotedAt))[0];
  const existingRecord = store.quoteHistory.find((item) => item.documentId === document.id && item.fingerprint === fingerprint);
  const changes = quotePricingChanges(previous, document, items);
  const beforeFingerprint = createHash("sha256").update(JSON.stringify({
    currency: deal.currency,
    items: (deal.items || []).map((item) => ({ productId: item.productId || "", product: item.product, model: item.model || "", quantity: item.quantity, unitPrice: item.unitPrice }))
  })).digest("hex");
  const nextDealItems = items.map((item, index) => {
    const current = (deal.items || []).find((entry) => quoteItemKey(entry) === quoteItemKey(item));
    return { id: current?.id || `deal_item_quote_${Date.now()}_${index + 1}`, productId: item.productId, product: item.product, model: item.model, quantity: item.quantity, unitPrice: item.unitPrice };
  });
  deal.items = nextDealItems;
  deal.product = dealProductSummary(nextDealItems);
  deal.quantity = nextDealItems.reduce((sum, item) => sum + item.quantity, 0);
  deal.unitPrice = nextDealItems.length === 1 ? nextDealItems[0].unitPrice : 0;
  deal.amount = Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100;
  deal.currency = document.currency.toUpperCase();
  if (deal.stage !== "成交") deal.amountType = "quoted";
  const afterFingerprint = createHash("sha256").update(JSON.stringify({
    currency: deal.currency,
    items: nextDealItems.map((item) => ({ productId: item.productId || "", product: item.product, model: item.model || "", quantity: item.quantity, unitPrice: item.unitPrice }))
  })).digest("hex");
  const dealChanged = beforeFingerprint !== afterFingerprint;
  let history = existingRecord;
  if (!history) {
    const now = new Date().toISOString();
    history = {
      id: `qh_${randomUUID()}`,
      dealId: deal.id,
      customerId: deal.customerId,
      documentId: document.id,
      documentType: document.type as "PI" | "QUOTATION",
      documentNumber: document.number,
      documentRevision: document.revision || 1,
      issueDate: document.issueDate,
      customerName: customer?.companyFullName || customer?.billingName || customer?.company || document.buyer,
      dealTitle: deal.title,
      dealStage: deal.stage,
      currency: deal.currency,
      totalAmount: deal.amount,
      items,
      changes,
      fingerprint,
      operatorId: user.id,
      operatorName: user.name,
      ownerId: deal.ownerId,
      teamId: deal.teamId,
      quotedAt: now
    };
    store.quoteHistory.unshift(history);
  }
  if (dealChanged || !existingRecord) {
    const eventChanges = changes.length ? changes.slice(0, 8).join("；") : `报价明细同步为 ${deal.currency} ${deal.amount.toFixed(2)}`;
    createDealEvent({
      dealId: deal.id,
      type: "quote",
      content: `${document.type === "PI" ? "PI" : "报价单"} ${document.number} 同步商机：${eventChanges}`,
      operatorId: user.id,
      fromStage: deal.stage,
      toStage: deal.stage,
      nextAction: deal.nextAction,
      nextActionAt: deal.nextActionAt,
      relatedDocumentId: document.id
    });
    appendDocumentAudit(document, "dealPricingSync", previous ? `${previous.currency} ${previous.totalAmount.toFixed(2)}` : "", `${deal.currency} ${deal.amount.toFixed(2)}；${changes.join("；")}`, user);
  }
  if (!existingRecord && deal.ownerId !== user.id) {
    createInternalNotification({
      senderId: user.id,
      recipientId: deal.ownerId,
      teamId: deal.teamId,
      subject: `商机报价已更新：${deal.title}`,
      content: `${user.name} 通过 ${document.type} ${document.number} 更新了 ${items.length} 项产品，当前报价 ${deal.currency} ${deal.amount.toFixed(2)}。${changes.slice(0, 3).join("；")}`,
      relatedType: "quote_history",
      relatedId: history.id,
      threadId: `quote_${deal.id}`
    });
  }
  return { deal, history, changes, changed: dealChanged || !existingRecord };
}

const documentItemSchema = z.object({
  id: z.string().max(64).optional().default(""),
  lineType: z.enum(["product", "shipping_cost"]).optional().default("product"),
  productId: z.string().max(64).optional().default(""),
  imageUrl: z.string().trim().max(512).optional().default("").refine((value) => !value || /^\/uploads\/[A-Za-z0-9._-]+\.(?:png|jpe?g)$/iu.test(value), "商品图片必须来自本系统"),
  product: z.string().min(1).max(500),
  model: z.string().max(200).optional().default(""),
  material: z.string().max(200).optional().default(""),
  finish: z.string().max(200).optional().default(""),
  hsCode: z.string().max(40).optional().default(""),
  quantity: z.number().nonnegative().default(1),
  unit: z.string().max(40).optional().default("PCS"),
  unitPrice: z.number().nonnegative().default(0),
  originCountry: z.string().max(80).optional().default(""),
  weightKg: z.number().nonnegative().default(0),
  packageCount: z.number().int().nonnegative().default(0)
});

const documentBodySchema = z.object({
  customerId: z.string().trim().max(64).optional().default(""),
  dealId: z.string().trim().max(64).optional().default(""),
  /** 关联订单：单据可由订单预填，但单据金额不回写订单（两份口径允许有差）。 */
  orderId: z.string().trim().max(64).optional().default(""),
  revision: z.coerce.number().int().positive().optional(),
  derivedFromDocumentId: z.string().max(64).optional().default(""),
  derivedFromType: z.enum(["PI", "CI", "PO", "CUSTOMS", "PL", "CONTRACT", "QUOTATION", "COO", "SHIPPING"]).optional(),
  type: z.enum(["PI", "CI", "PO", "CUSTOMS", "PL", "CONTRACT", "QUOTATION", "COO", "SHIPPING"]).default("PI"),
  title: z.string().min(1).max(255),
  number: z.string().min(1).max(80),
  issueDate: z.string().min(1).max(40),
  buyer: z.string().max(200).optional().default(""),
  buyerAddress: z.string().max(4_000).optional().default(""),
  buyerContact: z.string().max(200).optional().default(""),
  seller: z.string().max(200).optional().default(""),
  brandMarkText: z.string().trim().max(8).optional(),
  sellerAddress: z.string().max(4_000).optional().default(""),
  sellerContact: z.string().max(200).optional().default(""),
  sellerPhone: z.string().max(120).optional().default(""),
  sellerEmail: z.string().max(180).optional().default(""),
  sellerWebsite: z.string().max(500).optional().default(""),
  sellerTaxNo: z.string().max(160).optional().default(""),
  currency: z.string().max(12).optional().default(""),
  incoterm: z.string().max(80).optional().default(""),
  paymentTerm: z.string().max(255).optional().default(""),
  shippingMethod: z.string().max(120).optional().default(""),
  portLoading: z.string().max(120).optional().default(""),
  portDischarge: z.string().max(120).optional().default(""),
  validityDate: z.string().max(40).optional().default(""),
  bankInfo: z.string().max(8_000).optional().default(""),
  notes: z.string().max(8_000).optional().default(""),
  language: z.enum(["EN", "ES", "RU", "AR", "ZH"]).optional().default("EN"),
  templateStyle: z.enum(["executive", "classic", "compact", "indigo", "emerald", "rose", "slate", "amber", "longtec", "custom-b"]).default("rose"),
  status: z.enum(["draft", "ready", "pending_approval", "approved", "rejected", "exported"]).optional().default("draft"),
  approvalNote: z.string().max(2_000).optional().default(""),
  approvedAt: z.string().max(100).optional(),
  approvedBy: z.string().max(64).optional(),
  audits: z.array(z.any()).optional().default([]),
  sendRecords: z.array(z.any()).optional().default([]),
  letterheadId: z.string().trim().max(64).optional().default(""),
  stampId: z.string().trim().max(64).optional().default(""),
  signatureId: z.string().trim().max(64).optional().default(""),
  includeProductImages: z.boolean().optional().default(false),
  items: z.array(documentItemSchema).min(1).max(80)
});

function documentLetterheadSnapshot(asset: DocumentLetterhead) {
  return {
    name: asset.name,
    companyName: asset.companyName,
    address: asset.address,
    phone: asset.phone,
    email: asset.email,
    website: asset.website,
    bankInfo: asset.bankInfo,
    contact: asset.contact || "",
    taxNo: asset.taxNo || "",
    logoUrl: documentAssetUrlForLocalFile(asset.logoUrl),
    logoPlacement: normalizeDocumentAssetPlacement(asset.logoPlacement),
    logoPlacements: normalizeDocumentLogoPlacements(asset.logoPlacements)
  };
}

function documentStampSnapshot(asset: DocumentStamp) {
  return { name: asset.name, imageUrl: documentAssetUrlForLocalFile(asset.imageUrl), placement: normalizeDocumentAssetPlacement(asset.placement) };
}

function documentSignatureSnapshot(asset: DocumentSignature) {
  return {
    name: asset.name,
    signerName: asset.signerName,
    signerTitle: asset.signerTitle,
    imageUrl: documentAssetUrlForLocalFile(asset.imageUrl)
  };
}

function applyDocumentAssetSelection(document: TradeDocument, user: SessionUser, previous?: TradeDocument) {
  const store = getStore();
  if (document.letterheadId) {
    if (previous?.letterheadId === document.letterheadId && previous.letterheadSnapshot) {
      document.letterheadSnapshot = previous.letterheadSnapshot;
    } else {
      const asset = store.documentLetterheads.find((item) => item.id === document.letterheadId && item.teamId === user.teamId && item.enabled);
      if (!asset) throw new Error("所选卖方公司不存在、已停用或不属于当前团队");
      document.letterheadSnapshot = documentLetterheadSnapshot(asset);
    }
  } else {
    document.letterheadSnapshot = undefined;
  }
  if (document.stampId) {
    if (previous?.stampId === document.stampId && previous.stampSnapshot) {
      document.stampSnapshot = previous.stampSnapshot;
    } else {
      const asset = store.documentStamps.find((item) => item.id === document.stampId && item.teamId === user.teamId && item.enabled);
      if (!asset) throw new Error("所选印章不存在、已停用或不属于当前团队");
      document.stampSnapshot = documentStampSnapshot(asset);
    }
  } else {
    document.stampSnapshot = undefined;
  }
  if (document.signatureId) {
    if (previous?.signatureId === document.signatureId && previous.signatureSnapshot) {
      document.signatureSnapshot = previous.signatureSnapshot;
    } else {
      const asset = store.documentSignatures.find((item) => item.id === document.signatureId && item.teamId === user.teamId && item.enabled);
      if (!asset) throw new Error("所选签名不存在、已停用或不属于当前团队");
      document.signatureSnapshot = documentSignatureSnapshot(asset);
    }
  } else {
    document.signatureSnapshot = undefined;
  }
  for (const item of document.items) {
    if (!item.productId) continue;
    const product = store.products.find((candidate) => candidate.id === item.productId && candidate.teamId === user.teamId && canSeeOwner(user, candidate.ownerId, candidate.teamId));
    if (!product) throw new Error(`明细“${item.product}”关联的产品不存在或无权访问`);
  }
  return document;
}

function normalizeDocument(body: z.infer<typeof documentBodySchema>, user: SessionUser, existing?: TradeDocument): TradeDocument {
  const status = existing
    ? (["draft", "ready", "rejected"].includes(existing.status) && ["draft", "ready"].includes(body.status) ? body.status : existing.status)
    : (body.status === "ready" ? "ready" : "draft");
  return applyDocumentAssetSelection({
    ...body,
    brandMarkText: body.brandMarkText ?? existing?.brandMarkText ?? "",
    id: existing?.id || `td_${Date.now()}`,
    customerId: body.customerId || existing?.customerId || "",
    dealId: body.dealId || existing?.dealId || "",
    orderId: body.orderId || existing?.orderId || "",
    revision: body.revision || existing?.revision || 1,
    derivedFromDocumentId: body.derivedFromDocumentId || existing?.derivedFromDocumentId || undefined,
    derivedFromType: body.derivedFromType || existing?.derivedFromType || undefined,
    importAnalysisId: existing?.importAnalysisId,
    importSourceFileName: existing?.importSourceFileName,
    importSourceSha256: existing?.importSourceSha256,
    ownerId: existing?.ownerId || user.id,
    teamId: existing?.teamId || user.teamId,
    status,
    approvalNote: existing?.approvalNote || "",
    approvedAt: existing?.approvedAt,
    approvedBy: existing?.approvedBy,
    audits: existing?.audits || [],
    sendRecords: existing?.sendRecords || [],
    updatedAt: new Date().toISOString(),
    items: body.items.map((item, index) => ({ ...item, id: item.id || `tdi_${Date.now()}_${index}` }))
  }, user, existing);
}

function appendDocumentAudit(document: TradeDocument, field: string, oldValue: unknown, newValue: unknown, user: SessionUser) {
  if (String(oldValue ?? "") === String(newValue ?? "")) return;
  document.audits = [...(document.audits || []), {
    id: `tda_${Date.now()}_${document.audits?.length || 0}`,
    field,
    oldValue: String(oldValue ?? ""),
    newValue: String(newValue ?? ""),
    operatorId: user.id,
    operatorName: user.name,
    createdAt: new Date().toISOString()
  }];
}

function documentBusinessDefaults(customer?: Customer, deal?: Deal) {
  if (!customer) return {};
  return {
    buyer: customer.companyFullName || customer.billingName || customer.company,
    buyerAddress: customer.billingAddress || "",
    buyerContact: customer.documentContact || customer.contact,
    incoterm: customer.defaultIncoterm || "",
    paymentTerm: customer.defaultPaymentTerm || "",
    portDischarge: customer.defaultPortDischarge || "",
    currency: deal?.currency || ""
  };
}

function sellerProfileMatchScore(
  profile: DocumentLetterhead,
  customer: Customer | undefined,
  currency: string,
  documentType: TradeDocument["type"]
) {
  if (!profile.enabled) return -1;
  const normalize = (value: string) => value.trim().toLocaleLowerCase();
  const country = normalize(customer?.country || "");
  const countries = (profile.matchCountries || []).map(normalize).filter(Boolean);
  const currencies = (profile.matchCurrencies || []).map((value) => value.trim().toUpperCase()).filter(Boolean);
  const types = profile.matchDocumentTypes || [];
  if (countries.length && !countries.includes(country)) return -1;
  if (currencies.length && !currencies.includes(currency.trim().toUpperCase())) return -1;
  if (types.length && !types.includes(documentType)) return -1;
  return (countries.length ? 1000 : 0)
    + (currencies.length ? 200 : 0)
    + (types.length ? 50 : 0)
    + Math.max(0, Math.min(100, profile.matchPriority || 0))
    + (profile.isDefault ? 1 : 0);
}

function matchedSellerProfile(
  user: SessionUser,
  customer: Customer | undefined,
  currency: string,
  documentType: TradeDocument["type"],
  explicitId = "",
  sellerName = ""
) {
  const available = getStore().documentLetterheads.filter((item) => item.teamId === user.teamId && item.enabled);
  if (explicitId) return available.find((item) => item.id === explicitId);
  const normalizedSeller = sellerName.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (normalizedSeller) {
    const namedProfile = available.find((item) => item.companyName.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === normalizedSeller);
    if (namedProfile) return namedProfile;
  }
  return available
    .map((item) => ({ item, score: sellerProfileMatchScore(item, customer, currency, documentType) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || right.item.updatedAt.localeCompare(left.item.updatedAt))[0]?.item;
}

function defaultDocumentProfile(teamId: string): DocumentDefaultProfile {
  const now = new Date().toISOString();
  return {
    teamId,
    seller: "",
    brandMarkText: "",
    sellerAddress: "",
    sellerContact: "",
    sellerPhone: "",
    sellerEmail: "",
    sellerWebsite: "",
    sellerTaxNo: "",
    bankInfo: "",
    currency: "USD",
    incoterm: "DAP",
    paymentTerm: "T/T 100% in advance",
    shippingMethod: "Sea freight",
    portLoading: "",
    validityDays: 0,
    notes: "",
    language: "EN",
    templateStyle: "rose",
    letterheadId: "",
    stampId: "",
    signatureId: "",
    includeProductImages: false,
    updatedBy: "",
    updatedAt: now
  };
}

function documentDefaultProfileForTeam(teamId: string) {
  const store = getStore();
  const saved = store.documentDefaultProfiles.find((item) => item.teamId === teamId);
  if (saved) return { ...saved, brandMarkText: saved.brandMarkText || "" };
  const company = store.companyProfiles.find((item) => item.teamId === teamId);
  const letterhead = store.documentLetterheads.find((item) => item.teamId === teamId && item.enabled && item.isDefault)
    || store.documentLetterheads.find((item) => item.teamId === teamId && item.enabled);
  const stamp = store.documentStamps.find((item) => item.teamId === teamId && item.enabled && item.isDefault);
  const signature = store.documentSignatures.find((item) => item.teamId === teamId && item.enabled && item.isDefault);
  const profile = defaultDocumentProfile(teamId);
  return {
    ...profile,
    seller: letterhead?.companyName || company?.companyName || "",
    sellerAddress: letterhead?.address || company?.address || "",
    sellerContact: letterhead?.contact || "",
    sellerPhone: letterhead?.phone || company?.phone || "",
    sellerEmail: letterhead?.email || company?.email || "",
    sellerWebsite: letterhead?.website || company?.website || "",
    sellerTaxNo: letterhead?.taxNo || "",
    bankInfo: letterhead?.bankInfo || "",
    letterheadId: letterhead?.id || "",
    stampId: letterhead?.stampId || stamp?.id || "",
    signatureId: letterhead?.signatureId || signature?.id || ""
  };
}

function nonEmpty(value: unknown) {
  return typeof value === "string" ? Boolean(value.trim()) : value !== undefined && value !== null;
}

function validityDateFromDays(issueDate: string, days: number) {
  if (!issueDate || days <= 0) return "";
  const date = new Date(`${issueDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function applyDocumentCreationDefaults(
  body: z.infer<typeof documentBodySchema>,
  user: SessionUser,
  customer?: Customer,
  deal?: Deal,
  sourceFields?: Set<string>
) {
  const profile = documentDefaultProfileForTeam(user.teamId);
  const customerDefaults = documentBusinessDefaults(customer, deal);
  const resolvedCurrency = String(body.currency || deal?.currency || profile.currency || "USD").toUpperCase();
  const sellerProfile = matchedSellerProfile(user, customer, resolvedCurrency, body.type, body.letterheadId || "", body.seller || "");
  const sourceOwns = (field: string, value: unknown) => nonEmpty(value) && (!sourceFields || sourceFields.has(field));
  const choose = (field: string, sourceValue: unknown, customerValue: unknown, profileValue: unknown, systemValue = "") => {
    if (sourceOwns(field, sourceValue)) return sourceValue;
    if (nonEmpty(customerValue)) return customerValue;
    if (nonEmpty(profileValue)) return profileValue;
    return systemValue;
  };
  const issueDate = body.issueDate || new Date().toISOString().slice(0, 10);
  return {
    ...body,
    buyer: choose("buyer", body.buyer, customerDefaults.buyer, "") as string,
    buyerAddress: choose("buyerAddress", body.buyerAddress, customerDefaults.buyerAddress, "") as string,
    buyerContact: choose("buyerContact", body.buyerContact, customerDefaults.buyerContact, "") as string,
    seller: choose("seller", body.seller, "", sellerProfile?.companyName || profile.seller) as string,
    brandMarkText: choose("brandMarkText", body.brandMarkText, "", profile.brandMarkText || "") as string,
    sellerAddress: choose("sellerAddress", body.sellerAddress, "", sellerProfile?.address || profile.sellerAddress) as string,
    sellerContact: choose("sellerContact", body.sellerContact, "", sellerProfile?.contact || profile.sellerContact) as string,
    sellerPhone: choose("sellerPhone", body.sellerPhone, "", sellerProfile?.phone || profile.sellerPhone) as string,
    sellerEmail: choose("sellerEmail", body.sellerEmail, "", sellerProfile?.email || profile.sellerEmail) as string,
    sellerWebsite: choose("sellerWebsite", body.sellerWebsite, "", sellerProfile?.website || profile.sellerWebsite) as string,
    sellerTaxNo: choose("sellerTaxNo", body.sellerTaxNo, "", sellerProfile?.taxNo || profile.sellerTaxNo) as string,
    currency: choose("currency", body.currency, customerDefaults.currency, profile.currency, "USD") as string,
    incoterm: choose("incoterm", body.incoterm, customerDefaults.incoterm, profile.incoterm, "DAP") as string,
    paymentTerm: choose("paymentTerm", body.paymentTerm, customerDefaults.paymentTerm, profile.paymentTerm, "T/T 100% in advance") as string,
    shippingMethod: choose("shippingMethod", body.shippingMethod, "", profile.shippingMethod, "Sea freight") as string,
    portLoading: choose("portLoading", body.portLoading, "", profile.portLoading) as string,
    portDischarge: choose("portDischarge", body.portDischarge, customerDefaults.portDischarge, "") as string,
    validityDate: choose("validityDate", body.validityDate, "", validityDateFromDays(issueDate, profile.validityDays)) as string,
    bankInfo: choose("bankInfo", body.bankInfo, "", sellerProfile?.bankInfo || profile.bankInfo) as string,
    notes: choose("notes", body.notes, "", profile.notes) as string,
    language: choose("language", body.language, "", profile.language, "EN") as TradeDocument["language"],
    templateStyle: choose("templateStyle", body.templateStyle, "", profile.templateStyle, "rose") as TradeDocument["templateStyle"],
    letterheadId: choose("letterheadId", body.letterheadId, "", sellerProfile?.id || profile.letterheadId) as string,
    stampId: choose("stampId", body.stampId, "", sellerProfile?.stampId || profile.stampId) as string,
    signatureId: choose("signatureId", body.signatureId, "", sellerProfile?.signatureId || profile.signatureId) as string,
    includeProductImages: sourceOwns("includeProductImages", body.includeProductImages) ? body.includeProductImages : profile.includeProductImages
  };
}

function documentTypeLabelForApi(type: TradeDocument["type"]) {
  return ({
    PI: "形式发票", CI: "商业发票", PO: "采购订单", CUSTOMS: "报关资料", PL: "装箱单",
    CONTRACT: "合同", QUOTATION: "报价单", COO: "原产地证", SHIPPING: "装运通知"
  } as Record<TradeDocument["type"], string>)[type] || type;
}

async function readLocalAdvancedDocumentImage(value: string) {
  const imageUrl = documentAssetUrlForLocalFile(value);
  if (!imageUrl) return undefined;
  const filePath = path.join(uploadsDir, path.basename(imageUrl));
  const data = await readFile(filePath).catch(() => null);
  if (!data) return undefined;
  const png = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!png && !jpeg) return undefined;
  return { data: new Uint8Array(data), extension: png ? "png" as const : "jpg" as const };
}

async function advancedDocumentAssets(document: TradeDocument, user: SessionUser) {
  const store = getStore();
  const productImages: Record<string, Awaited<ReturnType<typeof readLocalAdvancedDocumentImage>>> = {};
  if (document.includeProductImages) {
    for (const [index, item] of document.items.entries()) {
      const imageKey = item.id || item.productId || `item-${index + 1}`;
      if (productImages[imageKey]) continue;
      let imageUrl = documentAssetUrlForLocalFile(item.imageUrl || "");
      if (!imageUrl && item.productId) {
        const product = store.products.find((candidate) => candidate.id === item.productId && candidate.teamId === document.teamId && canSeeOwner(user, candidate.ownerId, candidate.teamId));
        imageUrl = documentAssetUrlForLocalFile(product?.imageUrl || "");
      }
      if (!imageUrl) {
        const normalized = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/gu, " ");
        const itemNames = [normalized(item.model || ""), normalized(item.product || "")].filter((value) => value.length >= 3);
        const product = store.products.find((candidate) => candidate.teamId === document.teamId
          && canSeeOwner(user, candidate.ownerId, candidate.teamId)
          && Boolean(documentAssetUrlForLocalFile(candidate.imageUrl || ""))
          && [candidate.model, candidate.nameEn, candidate.nameZh].some((value) => itemNames.includes(normalized(value || ""))));
        imageUrl = documentAssetUrlForLocalFile(product?.imageUrl || "");
      }
      if (!imageUrl) continue;
      productImages[imageKey] = await readLocalAdvancedDocumentImage(imageUrl);
    }
  }
  const compactProductImages = Object.fromEntries(Object.entries(productImages).filter((entry): entry is [string, NonNullable<typeof entry[1]>] => Boolean(entry[1])));
  return {
    logo: document.letterheadSnapshot?.logoUrl ? await readLocalAdvancedDocumentImage(document.letterheadSnapshot.logoUrl) : undefined,
    logoPlacement: normalizeDocumentAssetPlacement(document.letterheadSnapshot?.logoPlacement),
    stamp: document.stampSnapshot?.imageUrl ? await readLocalAdvancedDocumentImage(document.stampSnapshot.imageUrl) : undefined,
    stampPlacement: normalizeDocumentAssetPlacement(document.stampSnapshot?.placement),
    signature: document.signatureSnapshot?.imageUrl ? await readLocalAdvancedDocumentImage(document.signatureSnapshot.imageUrl) : undefined,
    productImages: compactProductImages
  };
}

async function persistImportedItemImages(
  parsed: Awaited<ReturnType<typeof parseTradeDocumentImport>>,
  importId: string,
  teamId: string
) {
  if (!parsed.embeddedImages?.length) return 0;
  await mkdir(uploadsDir, { recursive: true });
  let saved = 0;
  for (const embedded of parsed.embeddedImages) {
    const item = parsed.draft.items[embedded.itemIndex];
    if (!item || item.imageUrl) continue;
    const safeTeam = teamId.replace(/[^A-Za-z0-9_-]/gu, "_");
    const fileName = `document-item-${safeTeam}-${importId.replace(/[^A-Za-z0-9_-]/gu, "_")}-${embedded.itemIndex + 1}-${randomUUID()}.${embedded.extension}`;
    await writeFile(path.join(uploadsDir, fileName), embedded.data, { flag: "wx" });
    item.imageUrl = `/uploads/${fileName}`;
    saved += 1;
  }
  return saved;
}

const legacyDocumentImageRecoveryByUser = new Map<string, Promise<number>>();

async function restoreLegacyImportedDocumentImages(user: SessionUser) {
  const recoveryKey = `${user.teamId}:${user.id}`;
  const activeRecovery = legacyDocumentImageRecoveryByUser.get(recoveryKey);
  if (activeRecovery) return activeRecovery;
  const recovery = (async () => {
    const store = getStore();
    let restored = 0;
    for (const analysis of store.tradeDocumentImportAnalyses) {
      if (!analysis.createdDocumentId || !canSeeOwner(user, analysis.ownerId, analysis.teamId)) continue;
      const rootDocument = store.tradeDocuments.find((document) => document.id === analysis.createdDocumentId && canSeeOwner(user, document.ownerId, document.teamId));
      if (!rootDocument) continue;

      let sourceItems = analysis.extractedDocument.items || [];
      const normalized = (value: string | undefined) => (value || "").trim().toLowerCase().replace(/[\s_-]+/gu, " ");
      if (!sourceItems.some((item) => item.imageUrl) && /^[A-Za-z0-9._-]+$/u.test(analysis.sourceStorageKey)) {
        const source = await readFile(path.join(tradeDocumentImportsDir, analysis.sourceStorageKey)).catch(() => null);
        if (source) {
          const parsed = await parseTradeDocumentImport(analysis.sourceFileName, analysis.sourceMime, source).catch(() => null);
          if (parsed) {
            await persistImportedItemImages(parsed, analysis.id, analysis.teamId);
            if (parsed.draft.items.some((item) => item.imageUrl)) {
              if (!sourceItems.length) sourceItems = parsed.draft.items;
              else sourceItems.forEach((item, index) => {
                const model = normalized(item.model);
                const product = normalized(item.product);
                const matched = parsed.draft.items.find((candidate) => model && normalized(candidate.model) === model)
                  || parsed.draft.items.find((candidate) => product && normalized(candidate.product) === product)
                  || parsed.draft.items[index];
                if (matched?.imageUrl) item.imageUrl = matched.imageUrl;
              });
              analysis.extractedDocument.items = sourceItems;
              restored += sourceItems.filter((item) => item.imageUrl).length;
            }
          }
        }
      }
      if (!sourceItems.some((item) => item.imageUrl)) continue;

      const relatedIds = new Set([rootDocument.id]);
      let added = true;
      while (added) {
        added = false;
        for (const document of store.tradeDocuments) {
          if (document.teamId !== analysis.teamId
            || !canSeeOwner(user, document.ownerId, document.teamId)
            || !document.derivedFromDocumentId
            || !relatedIds.has(document.derivedFromDocumentId)
            || relatedIds.has(document.id)) continue;
          relatedIds.add(document.id);
          added = true;
        }
      }
      for (const document of store.tradeDocuments.filter((item) => item.teamId === analysis.teamId && relatedIds.has(item.id) && canSeeOwner(user, item.ownerId, item.teamId))) {
        let documentRestored = 0;
        document.items.forEach((item, index) => {
          if (item.imageUrl) return;
          const model = normalized(item.model);
          const product = normalized(item.product);
          const matched = sourceItems.find((sourceItem) => model && normalized(sourceItem.model) === model)
            || sourceItems.find((sourceItem) => product && normalized(sourceItem.product) === product)
            || sourceItems[index];
          if (!matched?.imageUrl) return;
          item.imageUrl = matched.imageUrl;
          documentRestored += 1;
        });
        if (documentRestored) {
          document.includeProductImages = true;
          restored += documentRestored;
        }
      }
    }
    if (restored) await store.persist();
    return restored;
  })().finally(() => legacyDocumentImageRecoveryByUser.delete(recoveryKey));
  legacyDocumentImageRecoveryByUser.set(recoveryKey, recovery);
  return recovery;
}

function documentForAdvancedExcel(document: TradeDocument) {
  if (!document.letterheadSnapshot) return document;
  return {
    ...document,
    seller: document.letterheadSnapshot.companyName,
    sellerAddress: document.letterheadSnapshot.address,
    sellerContact: document.letterheadSnapshot.contact,
    sellerPhone: document.letterheadSnapshot.phone,
    sellerEmail: document.letterheadSnapshot.email,
    sellerWebsite: document.letterheadSnapshot.website,
    sellerTaxNo: document.letterheadSnapshot.taxNo,
    bankInfo: document.letterheadSnapshot.bankInfo
  };
}

function publicTradeDocumentImportAnalysis(analysis: TradeDocumentImportAnalysis) {
  const { sourceStorageKey: _sourceStorageKey, ...publicAnalysis } = analysis;
  return publicAnalysis;
}

function visibleTradeDocumentImportAnalysis(id: string, user: SessionUser) {
  return getStore().tradeDocumentImportAnalyses.find((item) => item.id === id && canSeeOwner(user, item.ownerId, item.teamId));
}

function applyActiveTradeDocumentRecognitionTemplate(
  parsed: Awaited<ReturnType<typeof parseTradeDocumentImport>>,
  user: SessionUser,
  sourceKind: "import" | "ocr"
) {
  const match = matchTradeDocumentRecognitionTemplate({
    templates: getStore().tradeDocumentRecognitionTemplates,
    teamId: user.teamId,
    sourceKind,
    parsed
  });
  if (!match) return { parsed, recognitionTemplate: undefined };
  const applied = applyTradeDocumentRecognitionTemplate(parsed, match.template, match.score);
  return { parsed: applied.parsed, recognitionTemplate: applied.snapshot };
}

const recognitionTemplateBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  familyId: z.string().trim().max(64).optional(),
  document: documentBodySchema
});

function editableRecognitionTemplate(id: string, user: SessionUser) {
  const template = getStore().tradeDocumentRecognitionTemplates.find((item) => item.id === id && item.teamId === user.teamId);
  if (!template) return null;
  if (template.createdBy !== user.id && !hasIamPermission(user, "system.settings.manage")) return null;
  return template;
}

const documentAssetPlacementSchema = z.object({
  horizontal: z.enum(["template", "left", "center", "right"]).default("template"),
  vertical: z.enum(["template", "top", "middle", "bottom"]).default("template"),
  offsetX: z.coerce.number().int().min(-200).max(200).default(0),
  offsetY: z.coerce.number().int().min(-200).max(200).default(0),
  scale: z.coerce.number().int().min(50).max(150).default(100)
});

const documentLetterheadSchema = z.object({
  id: z.string().trim().max(64).optional(),
  name: z.string().trim().min(1).max(160),
  companyName: z.string().trim().min(1).max(240),
  address: z.string().trim().max(4_000).default(""),
  phone: z.string().trim().max(120).default(""),
  email: z.string().trim().max(180).default(""),
  website: z.string().trim().max(500).default(""),
  bankInfo: z.string().trim().max(8_000).default(""),
  contact: z.string().trim().max(200).default(""),
  taxNo: z.string().trim().max(160).default(""),
  logoUrl: z.string().trim().max(512).default(""),
  logoPlacement: documentAssetPlacementSchema.optional(),
  logoPlacements: z.record(z.string().trim().min(3).max(40), documentAssetPlacementSchema).optional(),
  matchCountries: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  matchCurrencies: z.array(z.string().trim().regex(/^[A-Z]{3}$/)).max(20).default([]),
  matchDocumentTypes: z.array(z.enum(["PI", "CI", "PO", "CUSTOMS", "PL", "CONTRACT", "QUOTATION", "COO", "SHIPPING"])).max(9).default([]),
  matchPriority: z.coerce.number().int().min(0).max(100).default(0),
  stampId: z.string().trim().max(64).default(""),
  signatureId: z.string().trim().max(64).default(""),
  isDefault: z.boolean().default(false),
  enabled: z.boolean().default(true)
});

const documentStampSchema = z.object({
  id: z.string().trim().max(64).optional(),
  name: z.string().trim().min(1).max(160),
  imageUrl: z.string().trim().min(1).max(512),
  placement: z.object({
    horizontal: z.enum(["template", "left", "center", "right"]).default("template"),
    vertical: z.enum(["template", "top", "middle", "bottom"]).default("template"),
    offsetX: z.coerce.number().int().min(-200).max(200).default(0),
    offsetY: z.coerce.number().int().min(-200).max(200).default(0),
    scale: z.coerce.number().int().min(50).max(150).default(100)
  }).optional(),
  isDefault: z.boolean().default(false),
  enabled: z.boolean().default(true)
});

const documentSignatureSchema = z.object({
  id: z.string().trim().max(64).optional(),
  name: z.string().trim().min(1).max(160),
  signerName: z.string().trim().max(160).default(""),
  signerTitle: z.string().trim().max(160).default(""),
  imageUrl: z.string().trim().min(1).max(512),
  isDefault: z.boolean().default(false),
  enabled: z.boolean().default(true)
});

const documentDefaultProfileSchema = z.object({
  seller: z.string().trim().max(240).default(""),
  brandMarkText: z.string().trim().max(8).default(""),
  sellerAddress: z.string().trim().max(4_000).default(""),
  sellerContact: z.string().trim().max(200).default(""),
  sellerPhone: z.string().trim().max(120).default(""),
  sellerEmail: z.string().trim().max(180).default(""),
  sellerWebsite: z.string().trim().max(500).default(""),
  sellerTaxNo: z.string().trim().max(160).default(""),
  bankInfo: z.string().trim().max(8_000).default(""),
  currency: z.string().trim().max(12).default("USD"),
  incoterm: z.string().trim().max(80).default("DAP"),
  paymentTerm: z.string().trim().max(255).default("T/T 100% in advance"),
  shippingMethod: z.string().trim().max(120).default("Sea freight"),
  portLoading: z.string().trim().max(120).default(""),
  validityDays: z.coerce.number().int().min(0).max(365).default(0),
  notes: z.string().trim().max(8_000).default(""),
  language: z.enum(["EN", "ES", "RU", "AR", "ZH"]).default("EN"),
  templateStyle: z.enum(["executive", "classic", "compact", "indigo", "emerald", "rose", "slate", "amber", "longtec", "custom-b"]).default("rose"),
  letterheadId: z.string().trim().max(64).default(""),
  stampId: z.string().trim().max(64).default(""),
  signatureId: z.string().trim().max(64).default(""),
  includeProductImages: z.boolean().default(false)
});

const tradeDocumentImportsDir = path.join(uploadsDir, ".trade-document-imports");

const documentAssetUploadSchema = z.object({
  image: z.string().min(1),
  mime: z.enum(["image/png", "image/jpeg"]),
  kind: z.enum(["letterhead-logo", "stamp", "signature", "product"])
});

function decodeVerifiedDocumentImage(image: string, declaredMime: "image/png" | "image/jpeg") {
  const encoded = image.includes(",") ? image.slice(image.indexOf(",") + 1) : image;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) throw new Error("图片 Base64 格式无效");
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw new Error("图片大小必须在 2 MB 以内");
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const actualMime = png ? "image/png" : jpeg ? "image/jpeg" : "";
  if (!actualMime || actualMime !== declaredMime) throw new Error("图片内容与声明格式不一致，仅支持真实 PNG/JPEG");
  return { buffer, extension: png ? "png" : "jpg" };
}

export function registerTradeDocumentsRoutes(app: Express) {
  app.get("/api/trade-document-imports", requireAuth, (req, res) => {
    const analyses = getStore().tradeDocumentImportAnalyses
      .filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 30)
      .map(publicTradeDocumentImportAnalysis);
    res.json({ analyses });
  });

  app.get("/api/trade-document-imports/:id", requireAuth, (req, res) => {
    const analysis = visibleTradeDocumentImportAnalysis(req.params.id, req.user!);
    if (!analysis) {
      res.status(404).json({ message: "导入分析不存在或无权访问" });
      return;
    }
    res.json({ analysis: publicTradeDocumentImportAnalysis(analysis) });
  });

  app.get("/api/trade-document-recognition-templates", requireAuth, (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    const templates = getStore().tradeDocumentRecognitionTemplates
      .filter((item) => item.teamId === req.user!.teamId && (includeArchived || item.status === "active"))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    res.json({ templates });
  });

  app.post("/api/trade-document-imports/:id/recognition-template", requireAuth, asyncRoute(async (req, res) => {
    const analysis = visibleTradeDocumentImportAnalysis(req.params.id, req.user!);
    if (!analysis) {
      res.status(404).json({ message: "导入分析不存在或无权访问" });
      return;
    }
    const body = recognitionTemplateBodySchema.parse(req.body);
    const store = getStore();
    const sourceKind = analysis.sourceMime.startsWith("image/") ? "ocr" : analysis.recognitionSource || "import";
    const normalizedName = body.name.trim().toLowerCase();
    const requestedFamily = body.familyId
      ? store.tradeDocumentRecognitionTemplates.find((item) => item.id === body.familyId || item.familyId === body.familyId)
      : store.tradeDocumentRecognitionTemplates.find((item) => item.teamId === req.user!.teamId
        && item.documentType === body.document.type
        && item.sourceKind === sourceKind
        && item.name.trim().toLowerCase() === normalizedName);
    if (requestedFamily && requestedFamily.teamId !== req.user!.teamId) {
      res.status(404).json({ message: "识别模板不存在或无权访问" });
      return;
    }
    const familyId = requestedFamily?.familyId || `tdrtf_${randomUUID()}`;
    const familyVersions = store.tradeDocumentRecognitionTemplates.filter((item) => item.teamId === req.user!.teamId && item.familyId === familyId);
    const activeFamilyCount = new Set(store.tradeDocumentRecognitionTemplates
      .filter((item) => item.teamId === req.user!.teamId && item.status === "active" && item.documentType === body.document.type && item.sourceKind === sourceKind)
      .map((item) => item.familyId)).size;
    if (!familyVersions.length && activeFamilyCount >= 30) {
      res.status(409).json({ message: "当前类型已有 30 个启用模板，请先归档不再使用的模板" });
      return;
    }
    const now = new Date().toISOString();
    const template = buildTradeDocumentRecognitionTemplate({
      analysis,
      corrected: body.document,
      id: `tdrt_${randomUUID()}`,
      familyId,
      version: Math.max(0, ...familyVersions.map((item) => item.version)) + 1,
      name: body.name,
      sourceKind,
      userId: req.user!.id,
      teamId: req.user!.teamId,
      now
    });
    if (template.fingerprint.anchors.length < 2) {
      res.status(422).json({ message: "当前原文可学习的稳定标签不足，请保留至少两个清晰字段标签或商品表头后重试" });
      return;
    }
    familyVersions.filter((item) => item.status === "active").forEach((item) => {
      item.status = "archived";
      item.archivedAt = now;
    });
    store.tradeDocumentRecognitionTemplates.unshift(template);
    analysis.recognitionTemplate = { templateId: template.id, familyId, name: template.name, version: template.version, matchScore: 1, matchedAt: now };
    analysis.updatedAt = now;
    await store.persist();
    res.status(201).json({ template, archivedVersions: familyVersions.filter((item) => item.status === "archived").map((item) => item.id) });
  }));

  app.post("/api/trade-document-recognition-templates/:id/archive", requireAuth, asyncRoute(async (req, res) => {
    const template = editableRecognitionTemplate(req.params.id, req.user!);
    if (!template) {
      res.status(404).json({ message: "识别模板不存在、无权管理或已被隔离" });
      return;
    }
    if (template.status === "active") {
      template.status = "archived";
      template.archivedAt = new Date().toISOString();
      await getStore().persist();
    }
    res.json({ template });
  }));

  app.post("/api/trade-document-recognition-templates/:id/restore", requireAuth, asyncRoute(async (req, res) => {
    const source = editableRecognitionTemplate(req.params.id, req.user!);
    if (!source) {
      res.status(404).json({ message: "识别模板不存在、无权管理或已被隔离" });
      return;
    }
    const store = getStore();
    const family = store.tradeDocumentRecognitionTemplates.filter((item) => item.teamId === req.user!.teamId && item.familyId === source.familyId);
    const now = new Date().toISOString();
    family.filter((item) => item.status === "active").forEach((item) => { item.status = "archived"; item.archivedAt = now; });
    const restored = { ...structuredClone(source), id: `tdrt_${randomUUID()}`, version: Math.max(...family.map((item) => item.version)) + 1, status: "active" as const, createdBy: req.user!.id, createdAt: now, archivedAt: undefined };
    store.tradeDocumentRecognitionTemplates.unshift(restored);
    await store.persist();
    res.status(201).json({ template: restored });
  }));

  app.get("/api/trade-document-imports/:id/source", requireAuth, asyncRoute(async (req, res) => {
    const analysis = visibleTradeDocumentImportAnalysis(req.params.id, req.user!);
    if (!analysis || !/^[A-Za-z0-9._-]+$/u.test(analysis.sourceStorageKey)) {
      res.status(404).json({ message: "源单据不存在或无权访问" });
      return;
    }
    const source = await readFile(path.join(tradeDocumentImportsDir, analysis.sourceStorageKey)).catch(() => null);
    if (!source) {
      res.status(404).json({ message: "源单据文件已不存在" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", analysis.sourceMime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(analysis.sourceFileName)}`);
    res.send(source);
  }));

  app.delete("/api/trade-document-imports/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const index = store.tradeDocumentImportAnalyses.findIndex((item) => item.id === req.params.id && canSeeOwner(req.user!, item.ownerId, item.teamId));
    const analysis = index >= 0 ? store.tradeDocumentImportAnalyses[index] : undefined;
    if (!analysis) {
      res.status(404).json({ message: "导入分析不存在或无权访问" });
      return;
    }
    if (analysis.status === "confirmed" || analysis.createdDocumentId) {
      res.status(409).json({ message: "该分析已生成正式单据，需保留来源审计，不能删除" });
      return;
    }
    store.tradeDocumentImportAnalyses.splice(index, 1);
    await store.persist();
    if (/^[A-Za-z0-9._-]+$/u.test(analysis.sourceStorageKey)) {
      await rm(path.join(tradeDocumentImportsDir, analysis.sourceStorageKey), { force: true }).catch(() => undefined);
    }
    res.json({ ok: true });
  }));

  app.post("/api/trade-document-imports/analyze", requireAuth, express.raw({ type: "application/octet-stream", limit: TRADE_DOCUMENT_IMPORT_MAX_BYTES }), asyncRoute(async (req, res) => {
    const encodedFileName = String(req.headers["x-file-name"] || "").trim();
    let fileName = "";
    try {
      fileName = decodeURIComponent(encodedFileName);
    } catch {
      res.status(400).json({ message: "文件名编码无效" });
      return;
    }
    fileName = path.basename(fileName).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 255);
    const mime = String(req.headers["x-file-type"] || "application/octet-stream").trim().toLowerCase().slice(0, 120);
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!fileName) {
      res.status(400).json({ message: "请选择要分析的单据文件" });
      return;
    }
    let parsed: Awaited<ReturnType<typeof parseTradeDocumentImport>>;
    try {
      parsed = await parseTradeDocumentImport(fileName, mime, buffer);
    } catch (error) {
      res.status(422).json({ message: error instanceof Error ? error.message : "单据解析失败" });
      return;
    }
    const recognized = applyActiveTradeDocumentRecognitionTemplate(parsed, req.user!, "import");
    parsed = recognized.parsed;
    const sha256 = tradeDocumentImportSha256(buffer);
    const duplicate = getStore().tradeDocumentImportAnalyses.find((item) => item.teamId === req.user!.teamId && item.sourceSha256 === sha256);
    if (duplicate) {
      if (!canSeeOwner(req.user!, duplicate.ownerId, duplicate.teamId)) {
        res.status(409).json({ message: "该文件已由团队其他成员导入，请联系有权限的负责人" });
        return;
      }
      if (duplicate.status === "needs_review") {
        await persistImportedItemImages(parsed, duplicate.id, req.user!.teamId);
        duplicate.detectedType = parsed.draft.type;
        duplicate.confidence = parsed.confidence;
        duplicate.extractedDocument = parsed.draft;
        duplicate.fieldEvidence = parsed.evidence;
        duplicate.warnings = parsed.warnings;
        duplicate.sourcePreview = parsed.preview;
        duplicate.calculatedTotal = parsed.calculatedTotal;
        duplicate.declaredTotal = parsed.declaredTotal;
        duplicate.totalDifference = parsed.declaredTotal === undefined ? undefined : parsed.declaredTotal - parsed.calculatedTotal;
        duplicate.recognitionSource = "import";
        duplicate.recognitionTemplate = recognized.recognitionTemplate;
        duplicate.updatedAt = new Date().toISOString();
        await getStore().persist();
      }
      res.json({ analysis: publicTradeDocumentImportAnalysis(duplicate), duplicate: true });
      return;
    }
    const id = `tdia_${randomUUID()}`;
    await persistImportedItemImages(parsed, id, req.user!.teamId);
    const extension = fileName.toLowerCase().match(/\.(xlsx|xls|csv|pdf)$/u)?.[1] || "bin";
    const storageKey = `${id}.${extension}`;
    await mkdir(tradeDocumentImportsDir, { recursive: true });
    await writeFile(path.join(tradeDocumentImportsDir, storageKey), buffer, { flag: "wx" });
    const analysis = createTradeDocumentImportAnalysis({
      id,
      fileName,
      mime,
      storageKey,
      sha256,
      sourceSize: buffer.length,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      parsed,
      recognitionSource: "import",
      recognitionTemplate: recognized.recognitionTemplate
    });
    getStore().tradeDocumentImportAnalyses.unshift(analysis);
    await getStore().persist();
    res.status(201).json({ analysis: publicTradeDocumentImportAnalysis(analysis), duplicate: false });
  }));

  app.post("/api/trade-document-imports/analyze-ocr", requireAuth, asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const dataUrl = typeof body.image === "string" ? body.image.trim() : "";
    const requestedMime = typeof body.mime === "string" ? body.mime.trim().toLowerCase() : "";
    const fileName = path.basename(typeof body.fileName === "string" ? body.fileName : "单据图片").replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 255) || "单据图片";
    const dataMatch = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/u);
    const mime = dataMatch?.[1] || requestedMime;
    const base64 = dataMatch?.[2]?.replace(/\s+/gu, "") || "";
    if (!dataMatch || !isTradeDocumentOcrMime(mime) || !base64 || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) {
      res.status(400).json({ message: "请上传 PNG、JPG/JPEG 或 WEBP 格式的单据图片" });
      return;
    }
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) {
      res.status(400).json({ message: "图片内容为空，请重新选择文件" });
      return;
    }
    if (buffer.length > TRADE_DOCUMENT_IMPORT_MAX_BYTES) {
      res.status(413).json({ message: "单据图片不能超过 8 MB，请压缩图片后重试" });
      return;
    }
    const validSignature = (mime === "image/png" && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (mime === "image/jpeg" && buffer.subarray(0, 2).equals(Buffer.from([255, 216])))
      || (mime === "image/webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP");
    if (!validSignature) {
      res.status(400).json({ message: "图片内容与声明格式不一致，请重新导出或选择原始图片" });
      return;
    }
    const config = getAiConfig(req.user!);
    const ocrProvider = tradeDocumentOcrProviderForTeam(req.user!.teamId);
    let parsed: Awaited<ReturnType<typeof recognizeTradeDocument>>;
    try {
      parsed = await recognizeConfiguredTradeDocument({ dataUrl, mime, fileName, provider: ocrProvider, aiConfig: config });
    } catch (error) {
      res.status(422).json({ message: error instanceof Error ? error.message : "单据图片识别失败", suggestion: "请确认模型支持视觉输入、图片清晰且配置可用" });
      return;
    }
    const recognized = applyActiveTradeDocumentRecognitionTemplate(parsed, req.user!, "ocr");
    parsed = recognized.parsed;
    const sha256 = tradeDocumentImportSha256(buffer);
    const store = getStore();
    const duplicate = store.tradeDocumentImportAnalyses.find((item) => item.teamId === req.user!.teamId && item.sourceSha256 === sha256);
    if (duplicate) {
      if (!canSeeOwner(req.user!, duplicate.ownerId, duplicate.teamId)) {
        res.status(409).json({ message: "该图片已由团队其他成员导入，请联系有权限的负责人" });
        return;
      }
      if (duplicate.status === "confirmed" && duplicate.createdDocumentId) {
        res.json({ analysis: publicTradeDocumentImportAnalysis(duplicate), duplicate: true });
        return;
      }
      duplicate.detectedType = parsed.draft.type;
      duplicate.confidence = parsed.confidence;
      duplicate.extractedDocument = parsed.draft;
      duplicate.fieldEvidence = parsed.evidence;
      duplicate.warnings = parsed.warnings;
      duplicate.sourcePreview = parsed.preview;
      duplicate.calculatedTotal = parsed.calculatedTotal;
      duplicate.declaredTotal = parsed.declaredTotal;
      duplicate.totalDifference = parsed.declaredTotal === undefined ? undefined : parsed.declaredTotal - parsed.calculatedTotal;
      duplicate.recognitionSource = "ocr";
      duplicate.recognitionTemplate = recognized.recognitionTemplate;
      duplicate.updatedAt = new Date().toISOString();
      await store.persist();
      res.json({ analysis: publicTradeDocumentImportAnalysis(duplicate), duplicate: true });
      return;
    }
    const id = `tdia_ocr_${randomUUID()}`;
    const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const storageKey = `${id}.${extension}`;
    await mkdir(tradeDocumentImportsDir, { recursive: true });
    await writeFile(path.join(tradeDocumentImportsDir, storageKey), buffer, { flag: "wx" });
    const analysis = createTradeDocumentImportAnalysis({
      id,
      fileName,
      mime,
      storageKey,
      sha256,
      sourceSize: buffer.length,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      parsed,
      recognitionSource: "ocr",
      recognitionTemplate: recognized.recognitionTemplate
    });
    store.tradeDocumentImportAnalyses.unshift(analysis);
    await store.persist();
    res.status(201).json({ analysis: publicTradeDocumentImportAnalysis(analysis), duplicate: false });
  }));

  app.post("/api/trade-document-imports/:id/confirm", requireAuth, asyncRoute(async (req, res) => {
    const analysis = visibleTradeDocumentImportAnalysis(req.params.id, req.user!);
    if (!analysis) {
      res.status(404).json({ message: "导入分析不存在或无权访问" });
      return;
    }
    if (analysis.status === "confirmed" && analysis.createdDocumentId) {
      const existing = getStore().tradeDocuments.find((item) => item.id === analysis.createdDocumentId && canSeeOwner(req.user!, item.ownerId, item.teamId));
      if (existing) {
        res.json({ analysis: publicTradeDocumentImportAnalysis(analysis), document: existing, duplicate: true });
        return;
      }
    }
    let requestDocument = req.body?.document;
    const submittedIssueDate = typeof requestDocument?.issueDate === "string" ? requestDocument.issueDate.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(submittedIssueDate) && /^[A-Za-z0-9._-]+$/u.test(analysis.sourceStorageKey)) {
      const source = await readFile(path.join(tradeDocumentImportsDir, analysis.sourceStorageKey)).catch(() => null);
      if (source) {
        const refreshed = await parseTradeDocumentImport(analysis.sourceFileName, analysis.sourceMime, source).catch(() => null);
        if (refreshed?.draft.issueDate) {
          requestDocument = {
            ...(typeof requestDocument === "object" && requestDocument ? requestDocument : {}),
            issueDate: refreshed.draft.issueDate,
            validityDate: typeof requestDocument?.validityDate === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(requestDocument.validityDate)
              ? requestDocument.validityDate
              : refreshed.draft.validityDate
          };
          analysis.extractedDocument.issueDate = refreshed.draft.issueDate;
          analysis.extractedDocument.validityDate = refreshed.draft.validityDate;
          analysis.updatedAt = new Date().toISOString();
        }
      }
    }
    const parsedBody = documentBodySchema.safeParse(requestDocument);
    if (!parsedBody.success) {
      const labels: Record<string, string> = {
        title: "单据标题", number: "单据编号", issueDate: "签发日期", seller: "卖方公司", currency: "币种",
        incoterm: "贸易条款", product: "商品名称", quantity: "数量", unitPrice: "单价", packageCount: "箱数", items: "商品明细"
      };
      const issue = parsedBody.error.issues[0];
      const pathParts = issue?.path.map(String) || [];
      const field = pathParts.at(-1) || "document";
      const itemIndex = pathParts[0] === "items" && /^\d+$/u.test(pathParts[1] || "") ? Number(pathParts[1]) + 1 : 0;
      const label = labels[field] || labels[pathParts[0] || ""] || "单据内容";
      res.status(400).json({ message: `${itemIndex ? `第 ${itemIndex} 条明细的` : ""}${label}格式不正确或未填写`, issues: parsedBody.error.issues });
      return;
    }
    const body = parsedBody.data;
    const store = getStore();
    const deal = body.dealId ? store.deals.find((item) => item.id === body.dealId && canSeeOwner(req.user!, item.ownerId, item.teamId)) : undefined;
    if (body.dealId && !deal) {
      res.status(404).json({ message: "关联商机不存在或无权访问" });
      return;
    }
    const customerId = body.customerId || deal?.customerId || "";
    const customer = customerId ? store.customers.find((item) => item.id === customerId && canSeeOwner(req.user!, item.ownerId, item.teamId)) : undefined;
    if (customerId && !customer) {
      res.status(404).json({ message: "关联客户不存在或无权访问" });
      return;
    }
    if (deal && body.customerId && deal.customerId !== body.customerId) {
      res.status(400).json({ message: "单据客户与商机关联客户不一致" });
      return;
    }
    const evidenceFields = new Set((analysis.fieldEvidence || []).map((item) => item.field));
    const sourceFields = new Set(Object.keys(body).filter((field) => {
      if (["currency", "incoterm", "shippingMethod"].includes(field)) return evidenceFields.has(field);
      const submitted = (body as Record<string, unknown>)[field];
      const extracted = (analysis.extractedDocument as unknown as Record<string, unknown>)[field];
      return evidenceFields.has(field) || (nonEmpty(submitted) && String(submitted) !== String(extracted ?? ""));
    }));
    const document = normalizeDocument(applyDocumentCreationDefaults({
      ...body,
      customerId,
      status: "draft",
      includeProductImages: body.includeProductImages || body.items.some((item) => Boolean(item.imageUrl))
    }, req.user!, customer, deal, sourceFields), req.user!);
    if (!document.seller.trim()) {
      res.status(400).json({ message: "卖方公司未识别且团队默认配置未填写，请先补充卖方公司" });
      return;
    }
    document.importAnalysisId = analysis.id;
    document.importSourceFileName = analysis.sourceFileName;
    document.importSourceSha256 = analysis.sourceSha256;
    document.audits = [{
      id: `tda_${Date.now()}_import`,
      field: "importedFrom",
      oldValue: "",
      newValue: analysis.sourceFileName,
      operatorId: req.user!.id,
      operatorName: req.user!.name,
      createdAt: new Date().toISOString()
    }];
    store.tradeDocuments.unshift(document);
    analysis.status = "confirmed";
    analysis.extractedDocument = { ...analysis.extractedDocument, ...body, customerId, items: document.items };
    analysis.createdDocumentId = document.id;
    analysis.confirmedBy = req.user!.id;
    analysis.confirmedAt = new Date().toISOString();
    analysis.updatedAt = analysis.confirmedAt;
    if (deal) {
      createDealEvent({
        dealId: deal.id,
        type: "document",
        content: `${document.type} ${document.number} 由导入分析创建`,
        operatorId: req.user!.id,
        fromStage: deal.stage,
        toStage: deal.stage,
        nextAction: deal.nextAction,
        nextActionAt: deal.nextActionAt,
        relatedDocumentId: document.id
      });
    }
    const dealSync = syncDealPricingFromDocument(document, req.user!);
    await store.persist();
    res.status(201).json({ analysis: publicTradeDocumentImportAnalysis(analysis), document, dealSync, duplicate: false });
  }));

  app.get("/api/trade-documents", requireAuth, asyncRoute(async (req, res) => {
    await restoreLegacyImportedDocumentImages(req.user!);
    const { tradeDocuments } = getStore();
    const orderId = String(req.query.orderId || "");
    const documents = tradeDocuments
      .filter((document) => canSeeOwner(req.user!, document.ownerId, document.teamId))
      .filter((document) => !orderId || document.orderId === orderId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, orderId ? 100 : 9);
    res.json({ documents });
  }));

  app.get("/api/trade-document-templates", requireAuth, (req, res) => {
    res.json({ templates: listAdvancedDocumentTemplates() });
  });

  app.get("/api/document-assets", requireAuth, (req, res) => {
    const store = getStore();
    const canManage = hasIamPermission(req.user!, "system.settings.manage");
    const visible = <T extends { teamId: string; enabled: boolean; isDefault: boolean; updatedAt: string }>(items: T[]) => items
      .filter((item) => item.teamId === req.user!.teamId && (canManage || item.enabled))
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || right.updatedAt.localeCompare(left.updatedAt));
    res.json({
      letterheads: visible(store.documentLetterheads),
      stamps: visible(store.documentStamps),
      signatures: visible(store.documentSignatures),
      canManage
    });
  });

  app.get("/api/document-defaults", requireAuth, (req, res) => {
    res.json({
      profile: documentDefaultProfileForTeam(req.user!.teamId),
      canManage: hasIamPermission(req.user!, "system.settings.manage")
    });
  });

  app.put("/api/document-defaults", requireAuth, asyncRoute(async (req, res) => {
    const body = documentDefaultProfileSchema.parse(req.body);
    const store = getStore();
    const assetAvailable = (items: Array<{ id: string; teamId: string; enabled: boolean }>, id: string) => !id || items.some((item) => item.id === id && item.teamId === req.user!.teamId && item.enabled);
    if (!assetAvailable(store.documentLetterheads, body.letterheadId)
      || !assetAvailable(store.documentStamps, body.stampId)
      || !assetAvailable(store.documentSignatures, body.signatureId)) {
      res.status(400).json({ message: "默认卖方公司、印章或签名不存在、已停用或不属于当前团队" });
      return;
    }
    const profile: DocumentDefaultProfile = {
      ...body,
      teamId: req.user!.teamId,
      updatedBy: req.user!.id,
      updatedAt: new Date().toISOString()
    };
    const index = store.documentDefaultProfiles.findIndex((item) => item.teamId === req.user!.teamId);
    if (index >= 0) store.documentDefaultProfiles[index] = profile;
    else store.documentDefaultProfiles.push(profile);
    await store.persist();
    res.json({ profile });
  }));

  app.post("/api/document-assets/letterheads", requireAuth, asyncRoute(async (req, res) => {
    const body = documentLetterheadSchema.parse(req.body);
    const store = getStore();
    const existing = body.id ? store.documentLetterheads.find((item) => item.id === body.id && item.teamId === req.user!.teamId) : undefined;
    if (body.id && !existing) {
      res.status(404).json({ message: "卖方公司不存在或不属于当前团队" });
      return;
    }
    const logoUrl = body.logoUrl ? documentAssetUrlForLocalFile(body.logoUrl) : "";
    if (body.logoUrl && !logoUrl) {
      res.status(400).json({ message: "卖方公司 Logo 必须先上传到本系统" });
      return;
    }
    const linkedAssetAvailable = (items: Array<{ id: string; teamId: string; enabled: boolean }>, id: string) => !id || items.some((item) => item.id === id && item.teamId === req.user!.teamId && item.enabled);
    if (!linkedAssetAvailable(store.documentStamps, body.stampId) || !linkedAssetAvailable(store.documentSignatures, body.signatureId)) {
      res.status(400).json({ message: "卖方公司的默认印章或签名不存在、已停用或不属于当前团队" });
      return;
    }
    if (body.isDefault) store.documentLetterheads.filter((item) => item.teamId === req.user!.teamId).forEach((item) => { item.isDefault = false; });
    const asset: DocumentLetterhead = {
      ...body,
      id: existing?.id || `letterhead_${randomUUID()}`,
      logoUrl,
      logoPlacement: normalizeDocumentAssetPlacement(body.logoPlacement ?? existing?.logoPlacement),
      logoPlacements: normalizeDocumentLogoPlacements(body.logoPlacements ?? existing?.logoPlacements),
      teamId: req.user!.teamId,
      updatedBy: req.user!.id,
      updatedAt: new Date().toISOString()
    };
    if (existing) Object.assign(existing, asset);
    else store.documentLetterheads.unshift(asset);
    await store.persist();
    res.json({ asset });
  }));

  app.delete("/api/document-assets/letterheads/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const index = store.documentLetterheads.findIndex((item) => item.id === req.params.id && item.teamId === req.user!.teamId);
    if (index < 0) {
      res.status(404).json({ message: "卖方公司不存在或不属于当前团队" });
      return;
    }
    if (store.tradeDocuments.some((item) => item.teamId === req.user!.teamId && item.letterheadId === req.params.id)) {
      store.documentLetterheads[index].enabled = false;
      store.documentLetterheads[index].isDefault = false;
      store.documentLetterheads[index].updatedAt = new Date().toISOString();
    } else {
      store.documentLetterheads.splice(index, 1);
    }
    await store.persist();
    res.json({ ok: true });
  }));

  app.post("/api/document-assets/stamps", requireAuth, asyncRoute(async (req, res) => {
    const body = documentStampSchema.parse(req.body);
    const store = getStore();
    const existing = body.id ? store.documentStamps.find((item) => item.id === body.id && item.teamId === req.user!.teamId) : undefined;
    if (body.id && !existing) {
      res.status(404).json({ message: "印章不存在或不属于当前团队" });
      return;
    }
    const imageUrl = documentAssetUrlForLocalFile(body.imageUrl);
    if (!imageUrl) {
      res.status(400).json({ message: "印章图片必须先上传到本系统" });
      return;
    }
    if (body.isDefault) store.documentStamps.filter((item) => item.teamId === req.user!.teamId).forEach((item) => { item.isDefault = false; });
    const asset: DocumentStamp = {
      ...body,
      id: existing?.id || `stamp_${randomUUID()}`,
      imageUrl,
      placement: normalizeDocumentAssetPlacement(body.placement ?? existing?.placement),
      teamId: req.user!.teamId,
      updatedBy: req.user!.id,
      updatedAt: new Date().toISOString()
    };
    if (existing) Object.assign(existing, asset);
    else store.documentStamps.unshift(asset);
    await store.persist();
    res.json({ asset });
  }));

  app.delete("/api/document-assets/stamps/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const index = store.documentStamps.findIndex((item) => item.id === req.params.id && item.teamId === req.user!.teamId);
    if (index < 0) {
      res.status(404).json({ message: "印章不存在或不属于当前团队" });
      return;
    }
    if (store.tradeDocuments.some((item) => item.teamId === req.user!.teamId && item.stampId === req.params.id)) {
      store.documentStamps[index].enabled = false;
      store.documentStamps[index].isDefault = false;
      store.documentStamps[index].updatedAt = new Date().toISOString();
    } else {
      store.documentStamps.splice(index, 1);
    }
    await store.persist();
    res.json({ ok: true });
  }));

  app.post("/api/document-assets/signatures", requireAuth, asyncRoute(async (req, res) => {
    const body = documentSignatureSchema.parse(req.body);
    const store = getStore();
    const existing = body.id ? store.documentSignatures.find((item) => item.id === body.id && item.teamId === req.user!.teamId) : undefined;
    if (body.id && !existing) {
      res.status(404).json({ message: "签名不存在或不属于当前团队" });
      return;
    }
    const imageUrl = documentAssetUrlForLocalFile(body.imageUrl);
    if (!imageUrl) {
      res.status(400).json({ message: "签名图片必须先上传到本系统" });
      return;
    }
    if (body.isDefault) store.documentSignatures.filter((item) => item.teamId === req.user!.teamId).forEach((item) => { item.isDefault = false; });
    const asset: DocumentSignature = {
      ...body,
      id: existing?.id || `signature_${randomUUID()}`,
      imageUrl,
      teamId: req.user!.teamId,
      updatedBy: req.user!.id,
      updatedAt: new Date().toISOString()
    };
    if (existing) Object.assign(existing, asset);
    else store.documentSignatures.unshift(asset);
    await store.persist();
    res.json({ asset });
  }));

  app.delete("/api/document-assets/signatures/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const index = store.documentSignatures.findIndex((item) => item.id === req.params.id && item.teamId === req.user!.teamId);
    if (index < 0) {
      res.status(404).json({ message: "签名不存在或不属于当前团队" });
      return;
    }
    if (store.tradeDocuments.some((item) => item.teamId === req.user!.teamId && item.signatureId === req.params.id)) {
      store.documentSignatures[index].enabled = false;
      store.documentSignatures[index].isDefault = false;
      store.documentSignatures[index].updatedAt = new Date().toISOString();
    } else {
      store.documentSignatures.splice(index, 1);
    }
    await store.persist();
    res.json({ ok: true });
  }));

  app.get("/api/trade-documents/history", requireAuth, asyncRoute(async (req, res) => {
    await restoreLegacyImportedDocumentImages(req.user!);
    const store = getStore();
    const query = String(req.query.q || "").trim().toLowerCase();
    const type = String(req.query.type || "").trim();
    const status = String(req.query.status || "").trim();
    const customerId = String(req.query.customerId || "").trim();
    const dealId = String(req.query.dealId || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.min(50, Math.max(10, Number.parseInt(String(req.query.pageSize || "20"), 10) || 20));
    const visible = store.tradeDocuments
      .filter((document) => canSeeOwner(req.user!, document.ownerId, document.teamId))
      .filter((document) => !type || document.type === type)
      .filter((document) => !status || document.status === status)
      .filter((document) => !customerId || document.customerId === customerId)
      .filter((document) => !dealId || document.dealId === dealId)
      .filter((document) => !from || document.issueDate >= from)
      .filter((document) => !to || document.issueDate <= to)
      .filter((document) => {
        if (!query) return true;
        const customer = store.customers.find((item) => item.id === document.customerId);
        const deal = store.deals.find((item) => item.id === document.dealId);
        return [document.title, document.number, document.buyer, document.seller, customer?.company, deal?.title]
          .filter(Boolean).join(" ").toLowerCase().includes(query);
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const total = visible.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    res.json({ documents: visible.slice((safePage - 1) * pageSize, safePage * pageSize), total, page: safePage, pageSize, pageCount });
  }));

  app.get("/api/quote-history", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const mode = String(req.query.mode || "records").trim() === "product" ? "product" : "records";
    const query = String(req.query.q || "").trim().toLowerCase();
    const customerId = String(req.query.customerId || "").trim();
    const customerSearch = String(req.query.customerSearch || "").trim().toLowerCase();
    const dealId = String(req.query.dealId || "").trim();
    const dealSearch = String(req.query.dealSearch || "").trim().toLowerCase();
    const product = String(req.query.product || "").trim().toLowerCase();
    const country = String(req.query.country || "").trim().toLowerCase();
    const documentType = String(req.query.documentType || "").trim();
    const currency = String(req.query.currency || "").trim().toUpperCase();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const recordId = String(req.query.recordId || "").trim();
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.min(50, Math.max(10, Number.parseInt(String(req.query.pageSize || "20"), 10) || 20));
    const visible = store.quoteHistory
      .filter((record) => canSeeOwner(req.user!, record.ownerId, record.teamId))
      .filter((record) => !recordId || record.id === recordId)
      .filter((record) => !customerId || record.customerId === customerId)
      .filter((record) => !customerSearch || record.customerName.toLowerCase().includes(customerSearch))
      .filter((record) => !country || (store.customers.find((customer) => customer.id === record.customerId)?.country || "").trim().toLowerCase().includes(country))
      .filter((record) => !dealId || record.dealId === dealId)
      .filter((record) => !dealSearch || dealSearch.split(/\s*[·|/]\s*/u).filter(Boolean).every((term) => [record.dealTitle, record.customerName].join(" ").toLowerCase().includes(term)))
      .filter((record) => !documentType || record.documentType === documentType)
      .filter((record) => !currency || record.currency === currency)
      .filter((record) => !from || record.quotedAt.slice(0, 10) >= from)
      .filter((record) => !to || record.quotedAt.slice(0, 10) <= to)
      .filter((record) => !product || record.items.some((item) =>
        [item.product, item.model, item.productId].join(" ").toLowerCase().includes(product)))
      .filter((record) => {
        if (!query) return true;
        return [record.customerName, record.dealTitle, record.documentNumber, record.operatorName,
          ...record.items.flatMap((item) => [item.product, item.model])]
          .join(" ").toLowerCase().includes(query);
      })
      .sort((left, right) => right.quotedAt.localeCompare(left.quotedAt));
    const total = visible.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const totals = visible.reduce<Record<string, number>>((summary, record) => {
      summary[record.currency] = Math.round(((summary[record.currency] || 0) + record.totalAmount) * 100) / 100;
      return summary;
    }, {});
    const productAnalysis = mode === "product" ? (() => {
      type ProductQuoteGroup = {
        productId: string;
        product: string;
        model: string;
        country: string;
        currency: string;
        prices: number[];
        recordIds: Set<string>;
        latest?: { quotedAt: string; unitPrice: number; customerName: string; documentNumber: string };
      };
      type PriceRangeGroup = {
        country?: string;
        currency: string;
        prices: number[];
        recordIds: Set<string>;
        countries: Set<string>;
        latest?: { quotedAt: string; unitPrice: number };
      };
      const groups = new Map<string, ProductQuoteGroup>();
      const overallGroups = new Map<string, PriceRangeGroup>();
      const countryGroups = new Map<string, PriceRangeGroup>();
      visible.forEach((record) => {
        const country = store.customers.find((customer) => customer.id === record.customerId)?.country?.trim() || "未填写国家";
        record.items.forEach((item) => {
          const itemText = [item.product, item.model, item.productId].join(" ").toLowerCase();
          if (product && !itemText.includes(product)) return;
          const key = `${quoteItemKey(item)}|${country}|${record.currency}`;
          const group = groups.get(key) || {
            productId: item.productId,
            product: item.product,
            model: item.model,
            country,
            currency: record.currency,
            prices: [],
            recordIds: new Set<string>()
          };
          group.prices.push(item.unitPrice);
          group.recordIds.add(record.id);
          if (!group.latest || record.quotedAt > group.latest.quotedAt) {
            group.latest = { quotedAt: record.quotedAt, unitPrice: item.unitPrice, customerName: record.customerName, documentNumber: record.documentNumber };
          }
          groups.set(key, group);
          const updateRange = (map: Map<string, PriceRangeGroup>, rangeKey: string, range: PriceRangeGroup) => {
            range.prices.push(item.unitPrice);
            range.recordIds.add(record.id);
            range.countries.add(country);
            if (!range.latest || record.quotedAt > range.latest.quotedAt) range.latest = { quotedAt: record.quotedAt, unitPrice: item.unitPrice };
            map.set(rangeKey, range);
          };
          updateRange(overallGroups, record.currency, overallGroups.get(record.currency) || { currency: record.currency, prices: [], recordIds: new Set<string>(), countries: new Set<string>() });
          const countryKey = `${country}|${record.currency}`;
          updateRange(countryGroups, countryKey, countryGroups.get(countryKey) || { country, currency: record.currency, prices: [], recordIds: new Set<string>(), countries: new Set<string>() });
        });
      });
      const rangeRows = (source: Map<string, PriceRangeGroup>) => [...source.values()].map((group) => ({
        country: group.country || "",
        currency: group.currency,
        quoteCount: group.recordIds.size,
        countryCount: group.countries.size,
        minUnitPrice: Math.min(...group.prices),
        maxUnitPrice: Math.max(...group.prices),
        averageUnitPrice: Math.round((group.prices.reduce((sum, price) => sum + price, 0) / group.prices.length) * 100) / 100,
        latestUnitPrice: group.latest?.unitPrice || 0,
        latestQuotedAt: group.latest?.quotedAt || ""
      })).sort((left, right) => `${left.country}${left.currency}`.localeCompare(`${right.country}${right.currency}`));
      const rows = [...groups.values()].map((group) => {
        const minUnitPrice = Math.min(...group.prices);
        const maxUnitPrice = Math.max(...group.prices);
        const averageUnitPrice = Math.round((group.prices.reduce((sum, price) => sum + price, 0) / group.prices.length) * 100) / 100;
        return {
          productId: group.productId,
          product: group.product,
          model: group.model,
          country: group.country,
          currency: group.currency,
          quoteCount: group.recordIds.size,
          minUnitPrice,
          maxUnitPrice,
          averageUnitPrice,
          latestUnitPrice: group.latest?.unitPrice || 0,
          latestQuotedAt: group.latest?.quotedAt || "",
          latestCustomerName: group.latest?.customerName || "",
          latestDocumentNumber: group.latest?.documentNumber || "",
          recordIds: [...group.recordIds]
        };
      }).sort((left, right) => `${left.product}${left.model}${left.country}${left.currency}`.localeCompare(`${right.product}${right.model}${right.country}${right.currency}`));
      const detailRecords = visible.filter((record) => record.items.some((item) => {
        const itemText = [item.product, item.model, item.productId].join(" ").toLowerCase();
        return !product || itemText.includes(product);
      })).slice(0, 200);
      return { rows, overall: rangeRows(overallGroups), countryRanges: rangeRows(countryGroups), detailRecords, totalRecords: visible.length };
    })() : undefined;
    res.json({
      records: visible.slice((safePage - 1) * pageSize, safePage * pageSize),
      total,
      page: safePage,
      pageSize,
      pageCount,
      summary: {
        recordCount: total,
        customerCount: new Set(visible.map((record) => record.customerId)).size,
        dealCount: new Set(visible.map((record) => record.dealId)).size,
        productCount: new Set(visible.flatMap((record) => record.items.map((item) => quoteItemKey(item)))).size,
        totals
      },
      productAnalysis
    });
  }));

  app.get("/api/quote-history/:id", requireAuth, asyncRoute(async (req, res) => {
    const record = getStore().quoteHistory.find((item) => item.id === req.params.id && canSeeOwner(req.user!, item.ownerId, item.teamId));
    if (!record) {
      res.status(404).json({ message: "报价记录不存在或无权访问" });
      return;
    }
    res.json({ record });
  }));

  app.post("/api/trade-documents", requireAuth, asyncRoute(async (req, res) => {
    const body = documentBodySchema.parse(req.body);
    const store = getStore();
    const deal = body.dealId ? store.deals.find((item) => item.id === body.dealId && canSeeOwner(req.user!, item.ownerId, item.teamId)) : undefined;
    if (body.dealId && !deal) {
      res.status(404).json({ message: "关联商机不存在" });
      return;
    }
    const customerId = body.customerId || deal?.customerId || "";
    const customer = customerId ? store.customers.find((item) => item.id === customerId && canSeeOwner(req.user!, item.ownerId, item.teamId)) : undefined;
    if (customerId && !customer) {
      res.status(404).json({ message: "关联客户不存在" });
      return;
    }
    if (deal && body.customerId && deal.customerId !== body.customerId) {
      res.status(400).json({ message: "单据客户与商机关联客户不一致" });
      return;
    }
    const completedBody = applyDocumentCreationDefaults({ ...body, customerId }, req.user!, customer, deal, new Set(Object.keys(req.body || {})));
    if (!completedBody.seller.trim()) {
      res.status(400).json({ message: "请填写卖方公司，或先在单据默认配置中维护公司资料" });
      return;
    }
    const revision = body.revision || (body.dealId
      ? Math.max(0, ...store.tradeDocuments.filter((item) => item.dealId === body.dealId && item.type === body.type).map((item) => item.revision || 1)) + 1
      : 1);
    const document = normalizeDocument({ ...completedBody, revision }, req.user!);
    store.tradeDocuments.unshift(document);
    if (deal) {
      createDealEvent({
        dealId: deal.id,
        type: "document",
        content: `${document.type} ${document.number} v${document.revision} 已创建`,
        operatorId: req.user!.id,
        fromStage: deal.stage,
        toStage: deal.stage,
        nextAction: deal.nextAction,
        nextActionAt: deal.nextActionAt,
        relatedDocumentId: document.id
      });
    }
    const dealSync = syncDealPricingFromDocument(document, req.user!);
    await store.persist();
    res.json({ document, dealSync });
  }));

  app.patch("/api/trade-documents/:id", requireAuth, asyncRoute(async (req, res) => {
    const body = documentBodySchema.parse(req.body);
    const store = getStore();
    const index = store.tradeDocuments.findIndex((document) => document.id === req.params.id);
    const existing = index >= 0 ? store.tradeDocuments[index] : undefined;
    if (!existing || !canSeeOwner(req.user!, existing.ownerId, existing.teamId)) {
      res.status(404).json({ message: "单据不存在" });
      return;
    }
    if (existing.status === "approved" || existing.status === "exported") {
      res.status(409).json({ message: "已审批或已导出的单据不能直接覆盖，请先另存新版本" });
      return;
    }
    if (body.dealId && body.dealId !== existing.dealId) {
      res.status(400).json({ message: "单据创建后不能更换关联商机" });
      return;
    }
    const document = normalizeDocument({
      ...body,
      customerId: existing.customerId,
      dealId: existing.dealId,
      revision: existing.revision
    }, req.user!, existing);
    const auditFields = [
      "title", "number", "issueDate", "buyer", "buyerAddress", "buyerContact", "seller",
      "sellerAddress", "currency", "incoterm", "paymentTerm", "shippingMethod",
      "portLoading", "portDischarge", "validityDate", "bankInfo", "notes", "templateStyle", "language", "status"
    ] as const;
    auditFields.forEach((field) => appendDocumentAudit(document, field, existing[field], document[field], req.user!));
    store.tradeDocuments[index] = document;
    const dealSync = syncDealPricingFromDocument(document, req.user!);
    await store.persist();
    res.json({ document, dealSync });
  }));

  app.post("/api/trade-documents/:id/revision", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const source = store.tradeDocuments.find((item) => item.id === req.params.id);
    if (!source || !canSeeOwner(req.user!, source.ownerId, source.teamId)) {
      res.status(404).json({ message: "单据不存在" });
      return;
    }
    const revision = Math.max(0, ...store.tradeDocuments
      .filter((item) => item.number.split("-R")[0] === source.number.split("-R")[0] && item.type === source.type)
      .map((item) => item.revision || 1)) + 1;
    const baseNumber = source.number.replace(/-R\d+$/, "");
    const document: TradeDocument = {
      ...source,
      id: `td_${Date.now()}`,
      number: `${baseNumber}-R${revision}`,
      title: `${source.title.replace(/\s+v\d+$/, "")} v${revision}`,
      revision,
      status: "draft",
      approvalNote: "",
      approvedAt: undefined,
      approvedBy: undefined,
      audits: [],
      sendRecords: [],
      updatedAt: new Date().toISOString(),
      items: source.items.map((item, index) => ({ ...item, id: `tdi_${Date.now()}_${index}` }))
    };
    store.tradeDocuments.unshift(document);
    await store.persist();
    res.json({ document });
  }));

  app.post("/api/trade-documents/:id/convert", requireAuth, asyncRoute(async (req, res) => {
    const targetType = String(req.body?.targetType || "").trim();
    const allowedTypes = new Set(["PI", "CI", "PO", "CUSTOMS", "PL", "CONTRACT", "QUOTATION", "COO", "SHIPPING"]);
    if (!allowedTypes.has(targetType)) {
      res.status(400).json({ message: "不支持的目标单据类型" });
      return;
    }
    const store = getStore();
    const source = store.tradeDocuments.find((item) => item.id === req.params.id);
    if (!source || !canSeeOwner(req.user!, source.ownerId, source.teamId)) {
      res.status(404).json({ message: "源单据不存在或无权访问" });
      return;
    }
    const type = targetType as TradeDocument["type"];
    const revision = Math.max(0, ...store.tradeDocuments
      .filter((item) => item.dealId === source.dealId && item.type === type)
      .map((item) => item.revision || 1)) + 1;
    const baseNumber = `${type}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(Date.now()).slice(-5)}`;
    const document: TradeDocument = {
      ...source,
      id: `td_${Date.now()}`,
      type,
      title: `${type} 由 ${source.type} ${source.number} 转换` ,
      number: revision > 1 ? `${baseNumber}-R${revision}` : baseNumber,
      revision,
      derivedFromDocumentId: source.id,
      derivedFromType: source.type,
      status: "draft",
      approvalNote: "",
      approvedAt: undefined,
      approvedBy: undefined,
      audits: [{
        id: `tda_${Date.now()}_convert`, field: "convertedFrom", oldValue: "", newValue: `${source.type} ${source.number}`,
        operatorId: req.user!.id, operatorName: req.user!.name, createdAt: new Date().toISOString()
      }],
      sendRecords: [],
      updatedAt: new Date().toISOString(),
      items: source.items.map((item, index) => ({ ...item, id: `tdi_${Date.now()}_${index}` }))
    };
    store.tradeDocuments.unshift(document);
    await store.persist();
    res.json({ document });
  }));

  app.patch("/api/trade-documents/:id/excel-options", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      letterheadId: z.string().trim().max(64).optional().default(""),
      stampId: z.string().trim().max(64).optional().default(""),
      signatureId: z.string().trim().max(64).optional().default(""),
      includeProductImages: z.boolean().optional().default(false)
    }).parse(req.body);
    const store = getStore();
    const document = store.tradeDocuments.find((item) => item.id === req.params.id);
    if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
      res.status(404).json({ message: "单据不存在" });
      return;
    }
    const changed = (document.letterheadId || "") !== body.letterheadId
      || (document.stampId || "") !== body.stampId
      || (document.signatureId || "") !== body.signatureId
      || Boolean(document.includeProductImages) !== body.includeProductImages;
    if (changed && ["approved", "exported"].includes(document.status)) {
      res.status(409).json({ message: "已审批或已导出的单据不能更换抬头、印章、签名或图片设置，请先另存新版本" });
      return;
    }
    const oldSelection = `${document.letterheadId || ""}|${document.stampId || ""}|${document.signatureId || ""}|${Boolean(document.includeProductImages)}`;
    const candidate: TradeDocument = {
      ...document,
      letterheadId: body.letterheadId || undefined,
      stampId: body.stampId || undefined,
      signatureId: body.signatureId || undefined,
      includeProductImages: body.includeProductImages
    };
    try {
      applyDocumentAssetSelection(candidate, req.user!, document);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : "Excel 选项无效" });
      return;
    }
    Object.assign(document, candidate);
    document.updatedAt = new Date().toISOString();
    appendDocumentAudit(document, "excelOptions", oldSelection, `${document.letterheadId || ""}|${document.stampId || ""}|${document.signatureId || ""}|${Boolean(document.includeProductImages)}`, req.user!);
    await store.persist();
    res.json({ document });
  }));

  app.post("/api/trade-documents/:id/submit-approval", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const document = store.tradeDocuments.find((item) => item.id === req.params.id);
    if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
      res.status(404).json({ message: "单据不存在" });
      return;
    }
    if (!["draft", "ready", "rejected"].includes(document.status)) {
      res.status(400).json({ message: "当前单据状态不能提交审批" });
      return;
    }
    const oldStatus = document.status;
    document.status = "pending_approval";
    document.approvalNote = String(req.body?.note || "");
    document.updatedAt = new Date().toISOString();
    appendDocumentAudit(document, "status", oldStatus, document.status, req.user!);
    await store.persist();
    res.json({ document });
  }));

  app.post("/api/trade-documents/:id/approve", requireAuth, asyncRoute(async (req, res) => {
    if (!canApproveTradeDocuments(req.user)) {
      res.status(403).json({ message: "只有主管和管理员可以审批单据" });
      return;
    }
    const store = getStore();
    const document = store.tradeDocuments.find((item) => item.id === req.params.id);
    if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
      res.status(404).json({ message: "单据不存在" });
      return;
    }
    if (document.status !== "pending_approval") {
      res.status(400).json({ message: "只有待审批单据可以审批通过" });
      return;
    }
    const oldStatus = document.status;
    document.status = "approved";
    document.approvalNote = String(req.body?.note || document.approvalNote || "");
    document.approvedAt = new Date().toISOString();
    document.approvedBy = req.user!.name;
    document.updatedAt = new Date().toISOString();
    appendDocumentAudit(document, "status", oldStatus, document.status, req.user!);
    await store.persist();
    res.json({ document });
  }));

  app.post("/api/trade-documents/:id/reject", requireAuth, asyncRoute(async (req, res) => {
    if (!canApproveTradeDocuments(req.user)) {
      res.status(403).json({ message: "只有主管和管理员可以驳回单据" });
      return;
    }
    const note = String(req.body?.note || "").trim();
    if (!note) {
      res.status(400).json({ message: "驳回必须填写原因" });
      return;
    }
    const store = getStore();
    const document = store.tradeDocuments.find((item) => item.id === req.params.id);
    if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
      res.status(404).json({ message: "单据不存在" });
      return;
    }
    if (document.status !== "pending_approval") {
      res.status(400).json({ message: "只有待审批单据可以驳回" });
      return;
    }
    const oldStatus = document.status;
    document.status = "rejected";
    document.approvalNote = note;
    document.updatedAt = new Date().toISOString();
    appendDocumentAudit(document, "status", oldStatus, document.status, req.user!);
    appendDocumentAudit(document, "approvalNote", "", note, req.user!);
    await store.persist();
    res.json({ document });
  }));

  app.post("/api/trade-documents/:id/send", requireAuth, asyncRoute(async (req, res) => {
    const channel = ["email", "whatsapp", "wechat", "manual"].includes(req.body?.channel) ? req.body.channel : "manual";
    const recipient = String(req.body?.recipient || "").trim();
    if (!recipient) {
      res.status(400).json({ message: "请填写发送对象" });
      return;
    }
    const store = getStore();
    const document = store.tradeDocuments.find((item) => item.id === req.params.id);
    if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
      res.status(404).json({ message: "单据不存在" });
      return;
    }
    if (!["approved", "exported"].includes(document.status)) {
      res.status(409).json({ message: "单据审批通过后才能记录发送" });
      return;
    }
    const record: TradeDocumentSendRecord = {
      id: `tds_${Date.now()}`,
      channel,
      recipient,
      message: String(req.body?.message || ""),
      operatorId: req.user!.id,
      operatorName: req.user!.name,
      createdAt: new Date().toISOString()
    };
    document.sendRecords = [...(document.sendRecords || []), record];
    document.updatedAt = new Date().toISOString();
    appendDocumentAudit(document, "send", "", `${channel}:${recipient}`, req.user!);
    await store.persist();
    res.json({ document, record });
  }));

  app.post("/api/trade-documents/:id/export", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const document = store.tradeDocuments.find((item) => item.id === req.params.id);
    if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
      res.status(404).json({ message: "单据不存在" });
      return;
    }
    if (!["approved", "exported"].includes(document.status)) {
      res.status(409).json({ message: "单据审批通过后才能导出正式 PDF" });
      return;
    }
    const oldStatus = document.status;
    document.status = "exported";
    document.updatedAt = new Date().toISOString();
    appendDocumentAudit(document, "status", oldStatus, document.status, req.user!);
    const exportedAt = new Date().toISOString();
    const fingerprint = quotePricingFingerprint(document);
    const quoteRecord = store.quoteHistory.find((item) => item.documentId === document.id && item.fingerprint === fingerprint);
    if (quoteRecord) quoteRecord.exportedAt = exportedAt;
    const job = {
      id: `io_document_export_${Date.now()}`,
      name: `${document.type} 单据 PDF 导出：${document.number}`,
      type: "export" as const,
      rows: document.items.length,
      status: "done" as const,
      operatorId: req.user!.id,
      createdAt: currentMinuteText()
    };
    store.importExportJobs.unshift(job);
    await store.persist();
    res.json({ document, job, fileName: `${document.number}-${document.type}.pdf` });
  }));

  app.post("/api/trade-documents/:id/export-xlsx", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const document = store.tradeDocuments.find((item) => item.id === req.params.id);
    if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
      res.status(404).json({ message: "单据不存在" });
      return;
    }
    const settings = teamSystemSettingsForTeam(document.teamId);
    if (settings.requireDocumentExcelApproval && !["approved", "exported"].includes(document.status)) {
      res.status(409).json({ message: "当前团队已开启正式 Excel 导出审批，请先完成审批" });
      return;
    }
    const templateId = String(req.body?.templateId || "").trim();
    const template = listAdvancedDocumentTemplates().find((item) => item.id === templateId);
    if (!template) {
      res.status(400).json({ message: "请选择有效的 Excel 模板" });
      return;
    }
    if (!template.recommendedTypes.includes(document.type)) {
      res.status(400).json({ message: `${template.name} 不支持当前 ${documentTypeLabelForApi(document.type)} 单据` });
      return;
    }
    try {
      const result = await exportAdvancedDocumentTemplate(templateId, documentForAdvancedExcel(document), await advancedDocumentAssets(document, req.user!));
      const oldStatus = document.status;
      document.status = "exported";
      document.updatedAt = new Date().toISOString();
      appendDocumentAudit(document, "status", oldStatus, document.status, req.user!);
      const exportedAt = new Date().toISOString();
      const fingerprint = quotePricingFingerprint(document);
      const quoteRecord = store.quoteHistory.find((item) => item.documentId === document.id && item.fingerprint === fingerprint);
      if (quoteRecord) quoteRecord.exportedAt = exportedAt;
      const job = {
        id: `io_document_xlsx_${Date.now()}`,
        name: `${document.type} 单据 Excel 导出：${document.number}`,
        type: "export" as const,
        rows: document.items.length,
        status: "done" as const,
        operatorId: req.user!.id,
        createdAt: currentMinuteText()
      };
      store.importExportJobs.unshift(job);
      await store.persist();
      const fileName = `${document.number}-${result.template.fileName}`.replace(/[\\/:*?"<>|]/g, "-");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-GoodJob-Excel-SHA256", excelBufferSha256(result.buffer));
      res.send(result.buffer);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : "高级 Excel 导出失败" });
    }
  }));

  app.post("/api/trade-documents/:id/preview-xlsx", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const document = store.tradeDocuments.find((item) => item.id === req.params.id);
    if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
      res.status(404).json({ message: "单据不存在" });
      return;
    }
    const templateId = String(req.body?.templateId || "").trim();
    const template = listAdvancedDocumentTemplates().find((item) => item.id === templateId);
    if (!template) {
      res.status(400).json({ message: "请选择有效的 Excel 模板" });
      return;
    }
    if (!template.recommendedTypes.includes(document.type)) {
      res.status(400).json({ message: `${template.name} 不支持当前 ${documentTypeLabelForApi(document.type)} 单据` });
      return;
    }
    try {
      const result = await exportAdvancedDocumentTemplate(templateId, documentForAdvancedExcel(document), await advancedDocumentAssets(document, req.user!));
      const pdf = await renderExcelBufferToPdf(result.buffer);
      const previewName = `${document.number}-${result.template.fileName.replace(/\.xlsx$/i, "")}-preview.pdf`.replace(/[\\/:*?"<>|]/g, "-");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(previewName)}"; filename*=UTF-8''${encodeURIComponent(previewName)}`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-GoodJob-Excel-SHA256", excelBufferSha256(result.buffer));
      res.send(pdf);
    } catch (error) {
      res.status(error instanceof ExcelPreviewUnavailableError ? 503 : 400).json({
        message: error instanceof Error ? error.message : "Excel 预览失败"
      });
    }
  }));

  app.post("/api/customs-documents/export", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const { customsDocument } = req.body;

    if (!customsDocument || !customsDocument.dealId) {
      res.status(400).json({ message: "报关资料数据不完整" });
      return;
    }

    const deal = store.deals.find((item) => item.id === customsDocument.dealId);
    if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
      res.status(404).json({ message: "商机不存在" });
      return;
    }

    const customer = store.customers.find((item) =>
      item.id === customsDocument.customerId
      && item.id === deal.customerId
      && canSeeOwner(req.user!, item.ownerId, item.teamId)
    );
    if (!customer) {
      res.status(404).json({ message: "客户不存在" });
      return;
    }

    const exportIssues = customsDocumentExportIssues(customsDocument);
    if (exportIssues.length) {
      res.status(422).json({
        message: `请先补齐：${exportIssues.slice(0, 4).join("、")}${exportIssues.length > 4 ? ` 等${exportIssues.length}项` : ""}`,
        missingFields: exportIssues
      });
      return;
    }

    try {
      const excelBuffer = exportCustomsDocumentToExcel(customsDocument, customer, deal);

      // 创建导出任务记录
      const job = {
        id: `io_customs_export_${Date.now()}`,
        name: `报关资料导出：${customer.company}`,
        type: "export" as const,
        rows: customsDocument.items.length,
        status: "done" as const,
        operatorId: req.user!.id,
        createdAt: currentMinuteText()
      };
      store.importExportJobs.unshift(job);
      await store.persist();

      // 设置响应头
      const downloadName = `${customer.company}-报关资料-${customsDocument.issueDate}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="customs-${customsDocument.issueDate}.xlsx"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
      );
      res.send(excelBuffer);
    } catch (error) {
      console.error("报关资料导出失败:", error);
      res.status(500).json({ message: "导出失败" });
    }
  }));

  app.post("/api/document-assets/upload", requireAuth, asyncRoute(async (req, res) => {
    const body = documentAssetUploadSchema.parse(req.body);
    let image: ReturnType<typeof decodeVerifiedDocumentImage>;
    try {
      image = decodeVerifiedDocumentImage(body.image, body.mime);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : "图片格式无效" });
      return;
    }
    const fileName = `document-${body.kind}-${req.user!.teamId.replace(/[^A-Za-z0-9_-]/g, "_")}-${randomUUID()}.${image.extension}`;
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(path.join(uploadsDir, fileName), image.buffer, { flag: "wx" });
    res.json({ imageUrl: `/uploads/${fileName}` });
  }));
}
