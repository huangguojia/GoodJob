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
    consignee: customer.billingName || customer.company,
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
 * 导出报关资料为Excel文件
 */
export function exportCustomsDocumentToExcel(
  customsDoc: CustomsDocument,
  customer: Customer,
  deal: Deal
): Buffer {
  const workbook = XLSX.utils.book_new();

  // 1. 报关单
  const declarationSheet = createDeclarationSheet(customsDoc, customer);
  applySheetPresentation(declarationSheet, {
    widths: [8, 14, 20, 18, 12, 12, 14, 16, 14, 18],
    titleRows: [1], labelRows: [2, 4, 6, 8], headerRows: [11],
    dataRows: [12, 11 + customsDoc.items.length], totalRows: [12 + customsDoc.items.length],
    rowHeights: { 3: 34, 5: 40, 7: 34, 9: 28 },
    merges: [
      "A1:J1",
      "A2:B2", "C2:D2", "E2:F2", "G2:H2", "I2:J2",
      "A3:B3", "C3:D3", "E3:F3", "G3:H3", "I3:J3",
      "A4:B4", "C4:D4", "E4:F4", "G4:H4", "I4:J4",
      "A5:B5", "C5:D5", "E5:F5", "G5:H5", "I5:J5",
      "A6:B6", "C6:D6", "E6:F6", "G6:H6", "I6:J6",
      "A7:B7", "C7:D7", "E7:F7", "G7:H7", "I7:J7",
      "A8:B8", "C8:D8", "E8:F8", "G8:H8", "I8:J8",
      "A9:B9", "C9:D9", "E9:F9", "G9:H9", "I9:J9"
    ],
    orientation: "landscape"
  });
  applyNumberFormat(declarationSheet, 12, 12 + customsDoc.items.length, [5, 7, 8]);
  XLSX.utils.book_append_sheet(workbook, declarationSheet, "报关单");

  // 2. 申报要素
  const elementsSheet = createDeclarationElementsSheet(customsDoc);
  applySheetPresentation(elementsSheet, {
    widths: [8, 24, 16, 14, 14, 16, 14, 16, 30],
    titleRows: [1], sectionRows: [7], warningRows: [2, 3, 4, 5], headerRows: [8],
    dataRows: [9, 8 + customsDoc.items.length],
    merges: ["A1:I1", "A2:I2", "A3:I3", "A4:I4", "A5:I5", "A7:I7"], orientation: "landscape"
  });
  XLSX.utils.book_append_sheet(workbook, elementsSheet, "申报要素");

  // 3. 发票
  const invoiceSheet = createInvoiceSheet(customsDoc, customer);
  applySheetPresentation(invoiceSheet, {
    widths: [16, 32, 18, 14, 12, 18, 18],
    titleRows: [1], labelRows: [2, 3, 4, 5, 6], headerRows: [8],
    dataRows: [9, 8 + customsDoc.items.length], totalRows: [9 + customsDoc.items.length],
    rowHeights: { 2: 28, 3: 28, 4: 28, 5: 36, 6: 28 },
    merges: [
      "A1:G1",
      "B2:D2", "F2:G2", "B3:D3", "F3:G3", "B4:D4", "F4:G4",
      "B5:D5", "F5:G5", "B6:D6", "F6:G6"
    ],
    orientation: "landscape"
  });
  applyNumberFormat(invoiceSheet, 9, 9 + customsDoc.items.length, [4, 6, 7]);
  XLSX.utils.book_append_sheet(workbook, invoiceSheet, "发票");

  // 4. 箱单
  const packingSheet = createPackingListSheet(customsDoc, customer);
  applySheetPresentation(packingSheet, {
    widths: [14, 34, 14, 16, 12, 16, 16],
    titleRows: [1], labelRows: [2, 3, 4], headerRows: [6],
    dataRows: [7, 6 + customsDoc.items.length], totalRows: [7 + customsDoc.items.length],
    rowHeights: { 2: 28, 3: 28, 4: 36 },
    merges: ["A1:G1", "B2:D2", "F2:G2", "B3:D3", "F3:G3", "B4:D4", "F4:G4"],
    orientation: "landscape"
  });
  applyNumberFormat(packingSheet, 7, 7 + customsDoc.items.length, [3, 4, 6, 7]);
  XLSX.utils.book_append_sheet(workbook, packingSheet, "箱单");

  // 5. 合同
  const contractSheet = createContractSheet(customsDoc, customer);
  applySheetPresentation(contractSheet, {
    widths: [12, 34, 16, 14, 12, 18, 18],
    titleRows: [1], labelRows: [2, 3, 4, 5, 6, 7], headerRows: [9],
    dataRows: [10, 9 + customsDoc.items.length], totalRows: [10 + customsDoc.items.length],
    sectionRows: [12 + customsDoc.items.length],
    rowHeights: { 2: 28, 3: 28, 4: 28, 5: 28, 6: 28, 7: 36 },
    merges: [
      "A1:G1",
      "B2:D2", "F2:G2", "B3:D3", "F3:G3", "B4:D4", "F4:G4",
      "B5:D5", "F5:G5", "B6:D6", "F6:G6", "B7:D7", "F7:G7",
      `A${12 + customsDoc.items.length}:G${12 + customsDoc.items.length}`,
      `B${13 + customsDoc.items.length}:G${13 + customsDoc.items.length}`,
      `B${14 + customsDoc.items.length}:G${14 + customsDoc.items.length}`
    ],
    orientation: "landscape"
  });
  applyNumberFormat(contractSheet, 10, 10 + customsDoc.items.length, [4, 6, 7]);
  XLSX.utils.book_append_sheet(workbook, contractSheet, "合同");

  // 6. 委托书
  const authorizationSheet = createAuthorizationSheet(customsDoc);
  applySheetPresentation(authorizationSheet, {
    widths: [8, 20, 18, 18, 18, 18, 22],
    titleRows: [1], sectionRows: [16], labelRows: [11, 14],
    merges: [
      "A1:G1", "B3:F3", "B4:F4", "B5:F5", "B6:F6", "B7:F7", "B8:F8", "B9:F9", "B10:F10",
      "A11:B11", "A14:C14", "A16:G16", "B18:F18", "B19:F19", "B20:F20"
    ],
    orientation: "portrait"
  });
  XLSX.utils.book_append_sheet(workbook, authorizationSheet, "委托书");

  // 7. 填制规范
  const guideSheet = createGuideSheet();
  applySheetPresentation(guideSheet, {
    widths: [24, 92], titleRows: [1], headerRows: [3],
    dataRows: [4, 3 + GUIDE_ITEM_COUNT], merges: ["A1:B1"], orientation: "portrait"
  });
  XLSX.utils.book_append_sheet(workbook, guideSheet, "填制规范");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

const GUIDE_ITEM_COUNT = 10;
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

function applyNumberFormat(sheet: XLSX.WorkSheet, startRow: number, endRow: number, columns: number[]) {
  for (let row = startRow; row <= endRow; row += 1) {
    columns.forEach((column) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: row - 1, c: column - 1 })];
      if (cell && typeof cell.v === "number") cell.z = "#,##0.00";
    });
  }
}

function createDeclarationSheet(customsDoc: CustomsDocument, customer: Customer): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["中华人民共和国海关出口货物报关单"],
    ["境内发货人", "", "统一社会信用代码", "", "运输方式", "", "运输工具名称及航次号", "", "出境口岸", ""],
    [customsDoc.shipper, "", customsDoc.shipperTaxNo, "", customsDoc.transportMode, "", customsDoc.vesselName, "", customsDoc.exitPort, ""],
    ["境外收货人", "", "收货人地址", "", "贸易国（地区）", "", "运抵国（地区）", "", "监管方式", ""],
    [customsDoc.consignee, "", customsDoc.consigneeAddress, "", customsDoc.tradeCountry, "", customsDoc.destinationCountry, "", customsDoc.tradeMode, ""],
    ["生产销售单位", "", "统一社会信用代码", "", "合同协议号", "", "成交方式", "", "付款条件", ""],
    [customsDoc.manufacturer, "", customsDoc.manufacturerTaxNo, "", customsDoc.contractNo, "", customsDoc.tradeMethod, "", customsDoc.paymentTerm, ""],
    ["包装种类", "", "件数", "", "毛重（千克）", "", "净重（千克）", "", "币制", ""],
    [customsDoc.packageType, "", customsDoc.packageCount, "", customsDoc.grossWeight, "", customsDoc.netWeight, "", customsDoc.currency, ""],
    [],
    ["序号", "商品编号", "商品名称", "规格型号", "数量", "单位", "单价", "总价", "原产国", "备注"],
  ];

  customsDoc.items.forEach((item, index) => {
    const total = item.quantity * item.unitPrice;
    data.push([
      index + 1,
      item.hsCode || "",
      item.product,
      item.model || "",
      item.quantity,
      item.unit,
      item.unitPrice,
      total,
      item.originCountry || "中国",
      ""
    ]);
  });
  const quantityTotal = customsDoc.items.reduce((sum, item) => sum + item.quantity, 0);
  const amountTotal = customsDoc.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  data.push(["合计", "", "", "", quantityTotal, "", "", amountTotal, "", ""]);

  return XLSX.utils.aoa_to_sheet(data);
}

function createDeclarationElementsSheet(customsDoc: CustomsDocument): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["申报要素说明"],
    ["注意：产品或包装上有明显的logo、带R、TM标识的商标必须申报为品牌"],
    ["申报的牌子型号要在产品或包装上有一模一样显示"],
    ["检验检疫附加编号查询：https://e-service.shciq.gov.cn/shesp/"],
    ["申报要素查询：http://www.hscode.net/IntegrateQueries/QueryYS/"],
    [],
    ["申报要素"],
    ["序号", "品名", "海关HS编码", "检疫附加码", "品牌", "型号", "品牌类型", "出口享惠情况", "其他申报要素"],
  ];

  customsDoc.items.forEach((item, index) => {
    data.push([
      String(index + 1),
      item.product,
      item.hsCode || "",
      item.inspectionCode || "",
      item.brand || "无品牌",
      item.model || "",
      item.brandType || "无品牌",
      item.exportBenefit || "不享惠",
      ""
    ]);
  });

  return XLSX.utils.aoa_to_sheet(data);
}

function createInvoiceSheet(customsDoc: CustomsDocument, customer: Customer): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["商业发票 COMMERCIAL INVOICE"],
    ["卖方 Seller", customsDoc.shipper, "", "", "发票号 Invoice No.", customsDoc.contractNo, ""],
    ["卖方地址 Address", customsDoc.shipperAddress, "", "", "日期 Date", customsDoc.issueDate, ""],
    ["买方 Buyer", customsDoc.consignee, "", "", "贸易术语 Incoterm", customsDoc.tradeMethod, ""],
    ["买方地址 Address", customsDoc.consigneeAddress, "", "", "付款方式 Payment", customsDoc.paymentTerm, ""],
    ["装运口岸 Port", customsDoc.exitPort, "", "", "目的国 Destination", customsDoc.destinationCountry, ""],
    [],
    ["唛头 Mark", "货物名称 Description", "型号 Model", "数量 Quantity", "单位 Unit", `单价 Unit Price (${customsDoc.currency})`, `金额 Amount (${customsDoc.currency})`],
  ];

  let totalAmount = 0;
  customsDoc.items.forEach((item) => {
    const amount = item.quantity * item.unitPrice;
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

function createPackingListSheet(customsDoc: CustomsDocument, customer: Customer): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["装箱单 PACKING LIST"],
    ["客户 Consignee", customsDoc.consignee, "", "", "日期 Date", customsDoc.issueDate, ""],
    ["客户地址 Address", customsDoc.consigneeAddress, "", "", "合同号 Contract No.", customsDoc.contractNo, ""],
    ["运输路线 Route", `${customsDoc.exitPort} → ${customsDoc.destinationCountry}`, "", "", "付款方式 Payment", customsDoc.paymentTerm, ""],
    [],
    ["箱号 Ctn.No.", "货物名称及规格 Description", "箱数 Pkg", "数量 Quantity", "单位 Unit", "毛重 kg G.W.", "净重 kg N.W."],
  ];

  customsDoc.items.forEach((item, index) => {
    data.push([
      index + 1,
      item.productEnglish || item.product,
      item.packageCount || 0,
      item.quantity,
      item.unit,
      item.weightKg || 0,
      (item.weightKg || 0) * 0.9
    ]);
  });
  data.push([
    "合计 Total:",
    "",
    customsDoc.packageCount,
    customsDoc.items.reduce((sum, item) => sum + item.quantity, 0),
    "",
    customsDoc.grossWeight,
    customsDoc.netWeight
  ]);

  return XLSX.utils.aoa_to_sheet(data);
}

function createContractSheet(customsDoc: CustomsDocument, customer: Customer): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["销售合同 SALES CONTRACT"],
    ["合同号 Contract No.", customsDoc.contractNo, "", "", "日期 Date", customsDoc.issueDate, ""],
    ["卖方 Seller", customsDoc.shipper, "", "", "统一社会信用代码", customsDoc.shipperTaxNo, ""],
    ["卖方地址 Address", customsDoc.shipperAddress, "", "", "贸易术语 Incoterm", customsDoc.tradeMethod, ""],
    ["买方 Buyer", customsDoc.consignee, "", "", "目的国 Destination", customsDoc.destinationCountry, ""],
    ["买方地址 Address", customsDoc.consigneeAddress, "", "", "装运口岸 Port", customsDoc.exitPort, ""],
    ["收货人 Consignee", customsDoc.consignee, "", "", "付款方式 Payment", customsDoc.paymentTerm, ""],
    [],
    ["序号 No.", "货物名称 Name of Commodity", "型号 Model", "数量 Quantity", "单位 Unit", `单价 Unit Price (${customsDoc.currency})`, `金额 Amount (${customsDoc.currency})`],
  ];

  let totalAmount = 0;
  customsDoc.items.forEach((item) => {
    const amount = item.quantity * item.unitPrice;
    totalAmount += amount;
    data.push([
      customsDoc.items.indexOf(item) + 1,
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
  data.push(["付款方式 Payment", customsDoc.paymentTerm]);
  data.push(["交货条款 Delivery", `${customsDoc.tradeMethod} ${customsDoc.exitPort}`]);

  return XLSX.utils.aoa_to_sheet(data);
}

function createAuthorizationSheet(customsDoc: CustomsDocument): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["代理报关委托书"],
    [],
    ["", `委托单位：${customsDoc.shipper}`],
    ["", `统一社会信用代码：${customsDoc.shipperTaxNo}`],
    ["", `单位地址：${customsDoc.shipperAddress}`],
    ["", "我单位现委托代理报关企业办理本批货物的申报、预录入及相关通关事宜。"],
    ["", "我单位保证遵守《海关法》及国家有关法规，所提供资料真实、完整、单货相符。"],
    ["", "如有侵犯他人知识产权或申报资料不实的情形，我单位愿承担相关法律责任。"],
    ["", `本委托书有效期自签字之日起至 ${new Date().getFullYear()} 年 12 月 30 日止。`],
    [""],
    ["委托方（盖章）", "", "", "", "", "日期", customsDoc.issueDate],
    [""],
    [""],
    ["法定代表人或授权签字", "", "", "", "", "", ""],
    [""],
    ["委托报关协议"],
    [""],
    ["", "一、委托人应向代理人提供本批货物真实、完整的合同、发票、箱单及申报要素。"],
    ["", "二、代理人应对委托人提供的资料进行合理审查，并按确认内容办理申报。"],
    ["", "三、双方对申报内容、资料交接和异常处理承担各自责任。"],
  ];

  return XLSX.utils.aoa_to_sheet(data);
}

function createGuideSheet(): XLSX.WorkSheet {
  const data: Array<Array<string | number>> = [
    ["海关出口货物报关单填制规范"],
    [""],
    ["项目", "填制要求"],
    ["境内收发货人", "填报在海关备案的对外签订并执行进出口贸易合同的中国境内法人、其他组织名称及编码。"],
    ["进出境关别", "根据货物实际进出境的口岸海关，填报海关规定的《关区代码表》中相应口岸海关的名称及代码。"],
    ["备案号", "填报进出口货物收发货人、消费使用单位、生产销售单位在海关办理加工贸易合同备案或征、减、免税审核确认等手续时取得的备案号或批准文号。"],
    ["境外收发货人", "填报境外收货人或发货人的名称。"],
    ["运输方式", "根据货物实际运输方式填报，如：水路运输、铁路运输、公路运输、航空运输等。"],
    ["监管方式", "根据实际监管方式填报，一般贸易填报\"0110\"。"],
    ["贸易国（地区）", "填报与境内企业签订贸易合同的外方所属国家（地区）。"],
    ["包装种类", "根据货物实际包装情况填报，如：纸箱、木箱、托盘等。"],
    ["商品编号", "填报10位HS编码，必须准确。"],
    ["申报要素", "根据海关要求填报品牌、型号等申报要素，必须与实际货物一致。"],
  ];

  return XLSX.utils.aoa_to_sheet(data);
}
