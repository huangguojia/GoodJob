import type { CustomsDocument, TradeDocument, Deal, Customer } from "./types.js";
import XLSX from "xlsx-js-style";

/**
 * 从商机和客户信息生成报关资料
 */
export function generateCustomsDocumentFromDeal(
  deal: Deal,
  customer: Customer,
  tradeDocument?: TradeDocument
): CustomsDocument {
  const date = new Date().toISOString().slice(0, 10);
  const dateShort = date.replace(/-/g, "");
  const sourceItems = tradeDocument?.items?.length
    ? tradeDocument.items
    : deal.items?.length
      ? deal.items.map((item, index) => ({
        id: item.id || `customs_item_${Date.now()}_${index + 1}`,
        productId: item.productId || "",
        product: item.product,
        model: item.model || "",
        hsCode: "",
        quantity: item.quantity,
        unit: "PCS",
        unitPrice: item.unitPrice,
        originCountry: "中国",
        weightKg: 0,
        packageCount: 0
      }))
      : [{
        id: `customs_item_${Date.now()}`,
        product: deal.product || deal.title,
        model: "",
        hsCode: "",
        quantity: deal.quantity || 1,
        unit: "PCS",
        unitPrice: deal.unitPrice || (deal.quantity ? deal.amount / deal.quantity : deal.amount) || 0,
        originCountry: "中国",
        weightKg: 0,
        packageCount: 0
      }];

  return {
    id: `customs_${Date.now()}`,
    customerId: customer.id,
    dealId: deal.id,
    tradeDocumentId: tradeDocument?.id,
    number: `CUSTOMS-${dateShort}-${Math.floor(Date.now() / 1000).toString().slice(-4)}`,
    issueDate: date,

    // 发货人信息（卖方/出口方）
    shipper: tradeDocument?.seller || "",
    shipperAddress: tradeDocument?.sellerAddress || "",
    shipperTaxNo: "",

    // 收货人信息（买方/进口方）
    consignee: customer.companyFullName || customer.billingName || customer.company,
    consigneeAddress: customer.billingAddress || "",

    // 生产销售单位
    manufacturer: tradeDocument?.seller || "",
    manufacturerTaxNo: "",

    // 运输信息
    transportMode: tradeDocument?.shippingMethod === "Sea freight" ? "水运" : tradeDocument?.shippingMethod || "水运",
    vesselName: "",
    exitPort: tradeDocument?.portLoading || "",
    exitDate: date,
    tradeMode: "一般贸易",
    supervisionMode: "一般贸易",

    // 贸易信息
    tradeCountry: customer.country,
    destinationCountry: customer.country,
    packageType: "纸箱",
    packageCount: sourceItems.reduce((sum, item) => sum + (item.packageCount || 0), 0),
    grossWeight: sourceItems.reduce((sum, item) => sum + (item.weightKg || 0), 0),
    netWeight: sourceItems.reduce((sum, item) => sum + (item.weightKg || 0) * 0.9, 0),
    tradeMethod: tradeDocument?.incoterm || "FOB",
    contractNo: tradeDocument?.number || `CONTRACT-${dateShort}`,

    // 支付信息
    currency: tradeDocument?.currency || deal.currency || "USD",
    incoterm: tradeDocument?.incoterm || customer.defaultIncoterm || "FOB",
    paymentTerm: tradeDocument?.paymentTerm || customer.defaultPaymentTerm || "T/T",

    // 其他信息
    notes: "",
    status: "draft",
    ownerId: deal.ownerId || "",
    teamId: deal.teamId || "",
    updatedAt: new Date().toISOString(),
    items: sourceItems
  };
}

export function customsDocumentExportIssues(customsDoc: CustomsDocument) {
  const issues: string[] = [];
  const requiredText: Array<[string, unknown]> = [
    ["境内发货人", customsDoc.shipper],
    ["发货人地址", customsDoc.shipperAddress],
    ["发货人统一社会信用代码", customsDoc.shipperTaxNo],
    ["生产销售单位", customsDoc.manufacturer],
    ["生产销售单位统一社会信用代码", customsDoc.manufacturerTaxNo],
    ["境外收货人", customsDoc.consignee],
    ["收货人地址", customsDoc.consigneeAddress],
    ["出境口岸", customsDoc.exitPort],
    ["运抵国", customsDoc.destinationCountry],
    ["合同号", customsDoc.contractNo],
    ["付款条件", customsDoc.paymentTerm]
  ];
  requiredText.forEach(([label, value]) => {
    if (!String(value || "").trim()) issues.push(label);
  });
  if (Number(customsDoc.packageCount || 0) <= 0) issues.push("包装件数");
  if (Number(customsDoc.grossWeight || 0) <= 0) issues.push("总毛重");
  if (Number(customsDoc.netWeight || 0) <= 0) issues.push("总净重");
  if (!Array.isArray(customsDoc.items) || !customsDoc.items.length) {
    issues.push("货物明细");
  } else {
    customsDoc.items.forEach((item, index) => {
      const prefix = `第${index + 1}行`;
      if (!String(item.product || "").trim()) issues.push(`${prefix}品名`);
      if (!String(item.hsCode || "").trim()) issues.push(`${prefix}HS编码`);
      if (Number(item.quantity || 0) <= 0) issues.push(`${prefix}数量`);
      if (!String(item.unit || "").trim()) issues.push(`${prefix}单位`);
      if (Number(item.weightKg || 0) <= 0) issues.push(`${prefix}重量`);
      if (Number(item.packageCount || 0) <= 0) issues.push(`${prefix}包装数`);
    });
  }
  return issues;
}

/**
 * 导出报关资料为 Excel 文件
 * 所有单元格均为纯值（无公式），金额/重量等在 JS 中预计算后直接写入
 */
export function exportCustomsDocumentToExcel(
  customsDoc: CustomsDocument,
  customer: Customer,
  deal: Deal
): Buffer {
  const workbook = XLSX.utils.book_new();
  const itemCount = customsDoc.items.length;

  // ── 1. 报关单 (9 列，无备注列) ──
  const declarationSheet = createDeclarationSheet(customsDoc);
  applySheetPresentation(declarationSheet, {
    widths: [10, 18, 22, 18, 10, 10, 12, 14, 14],
    titleRows: [1], labelRows: [2, 4, 6, 8], headerRows: [11],
    dataRows: [12, 11 + itemCount], totalRows: [12 + itemCount],
    merges: [
      "A1:I1",
      "A2:B2", "C2:D2", "E2:F2", "G2:H2",
      "A3:B3", "C3:D3", "E3:F3", "G3:H3",
      "A4:B4", "C4:D4", "E4:F4", "G4:H4",
      "A5:B5", "C5:D5", "E5:F5", "G5:H5",
      "A6:B6", "C6:D6", "E6:F6", "G6:H6",
      "A7:B7", "C7:D7", "E7:F7", "G7:H7",
      "A8:B8", "C8:D8", "E8:F8", "G8:H8",
      "A9:B9", "C9:D9", "E9:F9", "G9:H9"
    ],
    orientation: "landscape"
  });
  applyNumberFormat(declarationSheet, 12, 12 + itemCount, [5, 7, 8]);
  XLSX.utils.book_append_sheet(workbook, declarationSheet, "报关单");

  // ── 2. 申报要素 (8 列，无其他申报要素列) ──
  const elementsSheet = createDeclarationElementsSheet(customsDoc);
  applySheetPresentation(elementsSheet, {
    widths: [8, 24, 16, 14, 14, 16, 14, 14],
    titleRows: [1], sectionRows: [5], warningRows: [2, 3], headerRows: [6],
    dataRows: [7, 6 + itemCount],
    merges: ["A1:H1", "A2:H2", "A3:H3", "A5:H5"],
    orientation: "landscape"
  });
  XLSX.utils.book_append_sheet(workbook, elementsSheet, "申报要素");

  // ── 3. 发票 ──
  const invoiceSheet = createInvoiceSheet(customsDoc);
  applySheetPresentation(invoiceSheet, {
    widths: [16, 32, 18, 14, 10, 16, 16],
    titleRows: [1], labelRows: [2, 3, 4, 5], headerRows: [7],
    dataRows: [8, 7 + itemCount], totalRows: [8 + itemCount],
    rowHeights: { 2: 28, 3: 28, 4: 28, 5: 28 },
    merges: [
      "A1:G1",
      "B2:D2", "F2:G2", "B3:D3", "F3:G3",
      "B4:D4", "F4:G4", "B5:D5", "F5:G5"
    ],
    orientation: "landscape"
  });
  applyNumberFormat(invoiceSheet, 8, 8 + itemCount, [4, 6, 7]);
  XLSX.utils.book_append_sheet(workbook, invoiceSheet, "发票");

  // ── 4. 箱单 ──
  const packingSheet = createPackingListSheet(customsDoc);
  applySheetPresentation(packingSheet, {
    widths: [14, 32, 12, 14, 10, 14, 14],
    titleRows: [1], labelRows: [2, 3, 4], headerRows: [6],
    dataRows: [7, 6 + itemCount], totalRows: [7 + itemCount],
    rowHeights: { 2: 28, 3: 28, 4: 28 },
    merges: ["A1:G1", "B2:D2", "F2:G2", "B3:D3", "F3:G3", "B4:D4", "F4:G4"],
    orientation: "landscape"
  });
  applyNumberFormat(packingSheet, 7, 7 + itemCount, [3, 4, 6, 7]);
  XLSX.utils.book_append_sheet(workbook, packingSheet, "箱单");

  // ── 5. 合同 (精简信息区，与模板一致) ──
  const contractSheet = createContractSheet(customsDoc);
  const contractTotalRow = 6 + itemCount;
  const contractTermsRow = contractTotalRow + 2;
  applySheetPresentation(contractSheet, {
    widths: [12, 34, 16, 14, 10, 16, 16],
    titleRows: [1], labelRows: [2, 3], headerRows: [5],
    dataRows: [6, 5 + itemCount], totalRows: [contractTotalRow],
    sectionRows: [contractTermsRow],
    rowHeights: { 2: 28, 3: 28 },
    merges: [
      "A1:G1",
      "B2:D2", "F2:G2", "B3:D3", "F3:G3",
      `A${contractTermsRow}:G${contractTermsRow}`,
      `B${contractTermsRow + 1}:D${contractTermsRow + 1}`, `F${contractTermsRow + 1}:G${contractTermsRow + 1}`,
      `B${contractTermsRow + 2}:D${contractTermsRow + 2}`, `F${contractTermsRow + 2}:G${contractTermsRow + 2}`
    ],
    orientation: "landscape"
  });
  applyNumberFormat(contractSheet, 6, 5 + itemCount, [4, 6, 7]);
  XLSX.utils.book_append_sheet(workbook, contractSheet, "合同");

  // ── 6. 委托书 (去掉委托报关协议，与模板一致) ──
  const authorizationSheet = createAuthorizationSheet(customsDoc);
  applySheetPresentation(authorizationSheet, {
    widths: [8, 20, 18, 18, 18, 18, 22],
    titleRows: [1], labelRows: [10],
    merges: [
      "A1:G1", "B3:F3", "B4:F4", "B5:F5", "B6:F6", "B7:F7",
      "A10:B10", "E10:F10"
    ],
    orientation: "portrait"
  });
  XLSX.utils.book_append_sheet(workbook, authorizationSheet, "委托书");

  // ── 7. 填制规范 (8 项，与模板一致) ──
  const guideSheet = createGuideSheet();
  applySheetPresentation(guideSheet, {
    widths: [24, 92], titleRows: [1], sectionRows: [3], headerRows: [4],
    dataRows: [5, 4 + GUIDE_ITEM_COUNT], merges: ["A1:B1", "A3:B3"], orientation: "portrait"
  });
  XLSX.utils.book_append_sheet(workbook, guideSheet, "填制规范");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

// ──────────────────────────────────────────────
//  样式常量 & 工具函数
// ──────────────────────────────────────────────

const GUIDE_ITEM_COUNT = 8;
const STYLE_COLORS = {
  navy: "1F365C",
  brand: "3157D5",
  teal: "0F766E",
  paleBlue: "EAF0FA",
  paleTeal: "EAF7F3",
  paleAmber: "FFF4D6",
  stripe: "F7F9FC",
  border: "C9D3E2",
  text: "1F2937",
  muted: "667085",
  white: "FFFFFF"
} as const;

interface SheetPresentation {
  widths: number[];
  titleRows?: number[];
  sectionRows?: number[];
  headerRows?: number[];
  labelRows?: number[];
  warningRows?: number[];
  totalRows?: number[];
  dataRows?: [number, number];
  rowHeights?: Record<number, number>;
  merges?: string[];
  orientation: "portrait" | "landscape";
}

function applySheetPresentation(sheet: XLSX.WorkSheet, plan: SheetPresentation) {
  sheet["!cols"] = plan.widths.map((wch) => ({ wch }));
  sheet["!merges"] = (plan.merges || []).map((range) => XLSX.utils.decode_range(range));
  sheet["!margins"] = { left: 0.35, right: 0.35, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
  (sheet as XLSX.WorkSheet & { "!pageSetup"?: Record<string, unknown> })["!pageSetup"] = {
    orientation: plan.orientation,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9
  };
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
  const rows = sheet["!rows"] || [];
  sheet["!rows"] = rows;
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    rows[row] = { hpt: plan.rowHeights?.[row + 1] || 22 };
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = sheet[address] || (sheet[address] = { t: "s", v: "" });
      cell.s = {
        font: { name: "Arial", sz: 10, color: { rgb: STYLE_COLORS.text } },
        fill: { patternType: "solid", fgColor: { rgb: STYLE_COLORS.white } },
        alignment: { vertical: "center", wrapText: true },
        border: thinBorder()
      };
    }
  }
  if (plan.dataRows) {
    const [start, end] = plan.dataRows;
    for (let row = start; row <= end; row += 1) {
      if ((row - start) % 2 === 1) styleRow(sheet, row, { fill: STYLE_COLORS.stripe });
    }
  }
  (plan.labelRows || []).forEach((row) => styleRow(sheet, row, { fill: STYLE_COLORS.paleBlue, bold: true }));
  (plan.warningRows || []).forEach((row) => styleRow(sheet, row, { fill: STYLE_COLORS.paleAmber, color: "805A00" }));
  (plan.totalRows || []).forEach((row) => styleRow(sheet, row, { fill: STYLE_COLORS.paleTeal, bold: true }));
  (plan.sectionRows || []).forEach((row) => styleRow(sheet, row, { fill: STYLE_COLORS.teal, color: STYLE_COLORS.white, bold: true, center: true, height: 25 }));
  (plan.headerRows || []).forEach((row) => styleRow(sheet, row, { fill: STYLE_COLORS.brand, color: STYLE_COLORS.white, bold: true, center: true, height: 28 }));
  (plan.titleRows || []).forEach((row) => styleRow(sheet, row, { fill: STYLE_COLORS.navy, color: STYLE_COLORS.white, bold: true, center: true, height: 34, size: 17 }));
}

function thinBorder() {
  const side = { style: "thin", color: { rgb: STYLE_COLORS.border } } as const;
  return { top: side, right: side, bottom: side, left: side };
}

function styleRow(
  sheet: XLSX.WorkSheet,
  rowNumber: number,
  options: { fill?: string; color?: string; bold?: boolean; center?: boolean; height?: number; size?: number }
) {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
  const rowIndex = rowNumber - 1;
  if (rowIndex < 0 || rowIndex > range.e.r) return;
  const rows = sheet["!rows"] || [];
  sheet["!rows"] = rows;
  rows[rowIndex] = { hpt: options.height || rows[rowIndex]?.hpt || 22 };
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const address = XLSX.utils.encode_cell({ r: rowIndex, c: column });
    const cell = sheet[address] || (sheet[address] = { t: "s", v: "" });
    cell.s = {
      ...(cell.s || {}),
      font: {
        name: "Arial",
        sz: options.size || 10,
        bold: options.bold || false,
        color: { rgb: options.color || STYLE_COLORS.text }
      },
      fill: options.fill ? { patternType: "solid", fgColor: { rgb: options.fill } } : cell.s?.fill,
      alignment: {
        vertical: "center",
        horizontal: options.center ? "center" : cell.t === "n" ? "right" : "left",
        wrapText: true
      },
      border: thinBorder()
    };
  }
}

/** 仅设置数字格式（非公式），让数值显示千分位 */
function applyNumberFormat(sheet: XLSX.WorkSheet, startRow: number, endRow: number, columns: number[]) {
  for (let row = startRow; row <= endRow; row += 1) {
    columns.forEach((column) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: row - 1, c: column - 1 })];
      if (cell && typeof cell.v === "number") cell.z = "#,##0.00";
    });
  }
}

// ──────────────────────────────────────────────
//  7 个 Sheet 创建函数 — 所有值均为纯值，无公式
// ──────────────────────────────────────────────

/** 1. 报关单 — 9 列（序号~原产国），无备注列 */
function createDeclarationSheet(customsDoc: CustomsDocument): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["中华人民共和国海关出口货物报关单"],
    ["境内发货人", "", "统一社会信用代码", "", "运输方式", "", "运输工具/航次", "", "出境口岸"],
    [customsDoc.shipper, "", customsDoc.shipperTaxNo, "", customsDoc.transportMode, "", customsDoc.vesselName, "", customsDoc.exitPort],
    ["境外收货人", "", "收货人地址", "", "贸易国（地区）", "", "运抵国（地区）", "", "监管方式"],
    [customsDoc.consignee, "", customsDoc.consigneeAddress, "", customsDoc.tradeCountry, "", customsDoc.destinationCountry, "", customsDoc.tradeMode],
    ["生产销售单位", "", "统一社会信用代码", "", "合同协议号", "", "成交方式", "", "付款条件"],
    [customsDoc.manufacturer, "", customsDoc.manufacturerTaxNo, "", customsDoc.contractNo, "", customsDoc.tradeMethod, "", customsDoc.paymentTerm],
    ["包装种类", "", "件数", "", "毛重（千克）", "", "净重（千克）", "", "币制"],
    [customsDoc.packageType, "", customsDoc.packageCount, "", customsDoc.grossWeight, "", customsDoc.netWeight, "", customsDoc.currency],
    [],
    ["序号", "商品编号", "商品名称", "规格型号", "数量", "单位", "单价", "总价", "原产国"],
  ];

  // 商品明细行 — 总价在 JS 中预计算，直接写入数值
  customsDoc.items.forEach((item, index) => {
    const total = Number(item.quantity || 0) * Number(item.unitPrice || 0);
    data.push([
      index + 1,
      item.hsCode || "",
      item.product,
      item.model || "",
      item.quantity,
      item.unit,
      item.unitPrice,
      total,
      item.originCountry || "中国"
    ]);
  });

  // 合计行 — 纯数值，无 SUM 公式
  const quantityTotal = customsDoc.items.reduce((sum, item) => sum + item.quantity, 0);
  const amountTotal = customsDoc.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  data.push(["合计", "", "", "", quantityTotal, "", "", amountTotal, ""]);

  return XLSX.utils.aoa_to_sheet(data);
}

/** 2. 申报要素 — 8 列（序号~出口享惠），无其他申报要素列 */
function createDeclarationElementsSheet(customsDoc: CustomsDocument): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["申报要素 / DECLARATION ELEMENTS"],
    ["注意：产品或包装上有明显的logo、带R、TM标识的商标必须申报为品牌"],
    ["申报的牌子型号要在产品或包装上有一模一样显示"],
    [],
    ["商品申报要素"],
    ["序号", "品名", "海关HS编码", "检疫附加码", "品牌", "型号", "品牌类型", "出口享惠情况"],
  ];

  customsDoc.items.forEach((item, index) => {
    data.push([
      index + 1,
      item.product,
      item.hsCode || "",
      item.inspectionCode || "",
      item.brand || "无品牌",
      item.model || "",
      item.brandType || "无品牌",
      item.exportBenefit || "不享惠"
    ]);
  });

  return XLSX.utils.aoa_to_sheet(data);
}

/** 3. 商业发票 — 贸易术语用 incoterm（与模板一致） */
function createInvoiceSheet(customsDoc: CustomsDocument): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["商业发票 COMMERCIAL INVOICE"],
    ["卖方 Seller", customsDoc.shipper, "", "", "发票号 Invoice No.", customsDoc.contractNo, ""],
    ["卖方地址 Address", customsDoc.shipperAddress, "", "", "日期 Date", customsDoc.issueDate, ""],
    ["买方 Buyer", customsDoc.consignee, "", "", "贸易术语 Incoterm", customsDoc.incoterm, ""],
    ["买方地址 Address", customsDoc.consigneeAddress, "", "", "付款方式 Payment", customsDoc.paymentTerm, ""],
    [],
    ["唛头 Mark", "货物名称 Description", "型号 Model", "数量 Quantity", "单位 Unit", `单价 Unit Price (${customsDoc.currency})`, `金额 Amount (${customsDoc.currency})`],
  ];

  let totalAmount = 0;
  customsDoc.items.forEach((item) => {
    const amount = Number(item.quantity || 0) * Number(item.unitPrice || 0);
    totalAmount += amount;
    data.push([
      "N/M",
      item.productEnglish || item.product,
      item.model || "",
      item.quantity,
      item.unit,
      item.unitPrice,
      amount
    ]);
  });
  data.push(["合计 Total", "", "", "", "", "", totalAmount]);

  return XLSX.utils.aoa_to_sheet(data);
}

/** 4. 装箱单 — 净重在 JS 中预计算（毛重×0.9），直接写入 */
function createPackingListSheet(customsDoc: CustomsDocument): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["装箱单 PACKING LIST"],
    ["收货人 Consignee", customsDoc.consignee, "", "", "日期 Date", customsDoc.issueDate, ""],
    ["地址 Address", customsDoc.consigneeAddress, "", "", "合同号 Contract No.", customsDoc.contractNo, ""],
    ["运输路线 Route", `${customsDoc.exitPort} → ${customsDoc.destinationCountry}`, "", "", "包装种类 Package", customsDoc.packageType, ""],
    [],
    ["箱号 Ctn.No.", "货物名称 Description", "箱数 Pkg", "数量 Quantity", "单位 Unit", "毛重 kg G.W.", "净重 kg N.W."],
  ];

  customsDoc.items.forEach((item, index) => {
    data.push([
      index + 1,
      item.productEnglish || item.product,
      item.packageCount || 0,
      item.quantity,
      item.unit,
      item.weightKg || 0,
      Number(item.weightKg || 0) * 0.9
    ]);
  });

  const totalPackages = customsDoc.items.reduce((sum, item) => sum + (item.packageCount || 0), 0);
  const totalQuantity = customsDoc.items.reduce((sum, item) => sum + item.quantity, 0);
  const totalWeight = customsDoc.items.reduce((sum, item) => sum + (item.weightKg || 0), 0);
  data.push([
    "合计 Total:",
    "",
    totalPackages,
    totalQuantity,
    "",
    totalWeight,
    customsDoc.netWeight
  ]);

  return XLSX.utils.aoa_to_sheet(data);
}

/** 5. 销售合同 — 精简信息区（卖方/买方/地址），交货条款用 incoterm */
function createContractSheet(customsDoc: CustomsDocument): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["销售合同 SALES CONTRACT"],
    ["卖方 Seller", customsDoc.shipper, "", "", "买方 Buyer", customsDoc.consignee, ""],
    ["卖方地址 Address", customsDoc.shipperAddress, "", "", "买方地址 Address", customsDoc.consigneeAddress, ""],
    [],
    ["序号 No.", "货物名称 Name of Commodity", "型号 Model", "数量 Quantity", "单位 Unit", `单价 Unit Price (${customsDoc.currency})`, `金额 Amount (${customsDoc.currency})`],
  ];

  let totalAmount = 0;
  customsDoc.items.forEach((item, index) => {
    const amount = Number(item.quantity || 0) * Number(item.unitPrice || 0);
    totalAmount += amount;
    data.push([
      index + 1,
      item.productEnglish || item.product,
      item.model || "",
      item.quantity,
      item.unit,
      item.unitPrice,
      amount
    ]);
  });
  data.push(["合计 Total", "", "", "", "", "", totalAmount]);
  data.push([]);
  data.push(["付款与交货条款 PAYMENT & DELIVERY TERMS"]);
  data.push(["付款方式 Payment", customsDoc.paymentTerm, "", "", "交货条款 Delivery", `${customsDoc.incoterm} ${customsDoc.exitPort}`, ""]);

  return XLSX.utils.aoa_to_sheet(data);
}

/** 6. 代理报关委托书 — 去掉委托报关协议，与模板一致 */
function createAuthorizationSheet(customsDoc: CustomsDocument): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["代理报关委托书"],
    [],
    ["", `委托单位：${customsDoc.shipper}`],
    ["", `统一社会信用代码：${customsDoc.shipperTaxNo}`],
    ["", `单位地址：${customsDoc.shipperAddress}`],
    ["", "我单位现委托代理报关企业办理本批货物的申报、预录入及相关通关事宜。"],
    ["", "我单位保证遵守《海关法》及国家有关法规，所提供资料真实、完整、单货相符。"],
    ["", "如申报资料不实，我单位愿承担相关责任。"],
    [],
    ["委托方（盖章）", "", "", "", "日期", customsDoc.issueDate, ""],
  ];

  return XLSX.utils.aoa_to_sheet(data);
}

/** 7. 填制规范 — 8 项，与模板一致 */
function createGuideSheet(): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["海关出口货物报关单填制规范"],
    [],
    ["填制项目（正式申报前复核）"],
    ["项目", "填制要求"],
    ["境内收发货人", "填报在海关备案并实际执行进出口合同的中国境内法人或组织名称及编码。"],
    ["境外收发货人", "填报境外收货人或发货人的完整名称及地址。"],
    ["运输方式", "根据货物实际运输方式填报，如水路、铁路、公路或航空运输。"],
    ["监管方式", "根据实际监管方式填报，一般贸易通常填报 0110。"],
    ["贸易国（地区）", "填报与境内企业签订贸易合同的外方所属国家或地区。"],
    ["包装种类", "根据货物实际包装填报，如纸箱、木箱、托盘。"],
    ["商品编号", "填报准确的 10 位 HS 编码。"],
    ["申报要素", "品牌、型号等要素必须与实际货物及包装标识一致。"],
  ];

  return XLSX.utils.aoa_to_sheet(data);
}
