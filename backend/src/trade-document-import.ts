import { createHash } from "node:crypto";
import path from "node:path";
import * as cheerio from "cheerio";
import { strFromU8, unzipSync } from "fflate";
import XLSX from "xlsx-js-style";
import type {
  TradeDocument,
  TradeDocumentImportAnalysis,
  TradeDocumentImportDraft,
  TradeDocumentImportEvidence,
  TradeDocumentItem
} from "./types.js";

export const TRADE_DOCUMENT_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

const documentTypes: Array<{ type: TradeDocument["type"]; patterns: RegExp[] }> = [
  { type: "PI", patterns: [/proforma\s+invoice/i, /形式发票/u] },
  { type: "CI", patterns: [/commercial\s+invoice/i, /商业发票/u] },
  { type: "PL", patterns: [/packing\s+list/i, /装箱单/u] },
  { type: "CONTRACT", patterns: [/sales?\s+contract/i, /purchase\s+contract/i, /销售合同/u] },
  { type: "QUOTATION", patterns: [/quotation/i, /price\s+quote/i, /quote\s*(?:#|no|number)/i, /报价单/u] },
  { type: "COO", patterns: [/certificate\s+of\s+origin/i, /原产地证/u] },
  { type: "SHIPPING", patterns: [/shipping\s+(?:advice|notice)/i, /装运通知/u] },
  { type: "CUSTOMS", patterns: [/customs\s+declaration/i, /报关资料/u, /报关单/u] }
];

const fieldAliases: Record<Exclude<keyof TradeDocumentImportDraft, "items" | "type" | "language" | "templateStyle" | "customerId" | "dealId" | "title">, string[]> = {
  number: ["invoice no", "invoice number", "invoice #", "pi no", "quotation no", "quote no", "quote#", "quote #", "contract no", "document no", "no", "单据编号", "发票号", "合同号", "报价单号"],
  issueDate: ["invoice date", "issue date", "date", "签发日期", "发票日期", "日期"],
  buyer: ["buyer", "bill to", "customer", "importer", "consignee", "买方", "客户", "收货人"],
  buyerAddress: ["buyer address", "bill to address", "consignee address", "customer address", "买方地址", "客户地址", "收货人地址"],
  buyerContact: ["buyer contact", "contact person", "attention", "attn", "买方联系人", "联系人"],
  seller: ["seller", "sold by", "supplier", "vendor", "exporter", "shipper", "卖方", "供应商", "发货人"],
  sellerAddress: ["seller address", "supplier address", "exporter address", "shipper address", "卖方地址", "供应商地址", "发货人地址"],
  currency: ["currency", "币种", "货币"],
  incoterm: ["incoterm", "trade term", "price term", "贸易条款", "成交方式"],
  paymentTerm: ["payment term", "terms of payment", "payment", "付款条款", "付款方式"],
  shippingMethod: ["shipping method", "mode of transport", "transport mode", "运输方式"],
  portLoading: ["port of loading", "loading port", "port of shipment", "装运港", "起运港"],
  portDischarge: ["port of discharge", "destination port", "delivery port", "目的港", "卸货港"],
  validityDate: ["valid until", "validity date", "expiry date", "有效期", "有效日期"],
  bankInfo: ["bank information", "bank details", "beneficiary bank", "bank account", "银行信息", "收款银行"],
  notes: ["remarks", "remark", "notes", "note", "备注"]
};

const itemAliases = {
  product: ["description", "des", "name", "product", "product name", "item description", "part description", "goods", "commodity", "品名", "产品名称", "货物名称", "零件名称"],
  model: ["model", "model no", "part name", "part no", "part number", "part #", "drawing no", "规格型号", "型号", "图号"],
  material: ["material", "material grade", "raw material", "材质", "材料", "材料牌号"],
  finish: ["finish", "surface finish", "surface treatment", "finishing", "后处理", "表面处理", "表面工艺"],
  hsCode: ["hs code", "hscode", "tariff code", "海关编码", "商品编码"],
  quantity: ["quantity", "qty", "数量"],
  unit: ["unit", "uom", "单位"],
  unitPrice: ["unit price", "unitprice", "price", "单价"],
  amount: ["amount", "sum", "total", "line total", "line amount", "金额"],
  originCountry: ["origin", "country of origin", "原产国", "原产地"],
  weightKg: ["weight", "net weight", "n.w", "重量", "净重"],
  packageCount: ["packages", "package", "ctns", "cartons", "件数", "箱数"]
} as const;

const itemImageAliases = ["image", "picture", "photo", "product image", "产品图片", "产品图", "图片", "照片"];

export interface ParsedTradeDocumentSource {
  draft: TradeDocumentImportDraft;
  evidence: TradeDocumentImportEvidence[];
  warnings: string[];
  preview: string[];
  confidence: number;
  declaredTotal?: number;
  calculatedTotal: number;
  embeddedImages?: Array<{
    itemIndex: number;
    data: Uint8Array;
    extension: "png" | "jpg";
  }>;
}

export function tradeDocumentImportSha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeLabel(value: unknown) {
  return String(value ?? "")
    .replace(/[：:]+$/u, "")
    .replace(/[\s_./-]+/gu, " ")
    .trim()
    .toLowerCase();
}

function labelMatches(value: unknown, alias: string) {
  const normalized = normalizeLabel(value);
  const expected = normalizeLabel(alias);
  if (normalized === expected) return true;
  const shorter = normalized.length <= expected.length ? normalized : expected;
  const longer = normalized.length <= expected.length ? expected : normalized;
  return shorter.length >= 6 && shorter.length / longer.length >= 0.65 && longer.startsWith(shorter);
}

function cleanText(value: unknown, max = 4_000) {
  return String(value ?? "").replace(/\u0000/gu, "").replace(/[ \t\r\n]+/gu, " ").trim().slice(0, max);
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value ?? "").replace(/[,\s]/gu, "").replace(/[^0-9.+-]/gu, "");
  const result = Number(normalized);
  return Number.isFinite(result) ? Math.max(0, result) : 0;
}

function dateValue(value: unknown) {
  const format = (year: number, month: number, day: number) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return format(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === "number" && value > 20_000 && value < 80_000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return format(parsed.y, parsed.m, parsed.d);
  }
  const text = cleanText(value, 80).replace(/\b(?:[A-Za-z]\s+){2,}[A-Za-z]\.?/gu, (match) => match.replace(/\s/gu, ""));
  const yearFirst = text.match(/\b(20\d{2}|19\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/u);
  if (yearFirst) return format(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  const numeric = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2}|20\d{2}|19\d{2})\b/u);
  if (numeric) {
    const year = numeric[3]!.length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    return first > 12 ? format(year, second, first) : format(year, first, second);
  }
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthFirst = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(20\d{2}|19\d{2})\b/iu);
  const dayFirst = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*([A-Za-z]{3,9})\.?\s*,?\s*(20\d{2}|19\d{2})\b/iu);
  const monthName = monthFirst?.[1] || dayFirst?.[2] || "";
  const month = months.findIndex((candidate) => monthName.toLowerCase().startsWith(candidate)) + 1;
  if (month) {
    const day = Number(monthFirst?.[2] || dayFirst?.[1]);
    const year = Number(monthFirst?.[3] || dayFirst?.[3]);
    return format(year, month, day);
  }
  const chinese = text.match(/\b(20\d{2}|19\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/u);
  return chinese ? format(Number(chinese[1]), Number(chinese[2]), Number(chinese[3])) : "";
}

function sourceType(text: string): { type: TradeDocument["type"]; confidence: number } {
  for (const candidate of documentTypes) {
    if (candidate.patterns.some((pattern) => pattern.test(text))) return { type: candidate.type, confidence: 0.96 };
  }
  if (/invoice/i.test(text)) return { type: "CI", confidence: 0.68 };
  return { type: "PI", confidence: 0.35 };
}

function splitInlineField(value: string, aliases: readonly string[]) {
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = value.match(new RegExp(`^\\s*${escaped}\\s*[:：#-]\\s*(.+)$`, "iu"));
    if (match?.[1]) return cleanText(match[1]);
  }
  return "";
}

function findField(rows: unknown[][], aliases: readonly string[]) {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const raw = cleanText(row[columnIndex]);
      if (!raw) continue;
      const inline = splitInlineField(raw, aliases);
      if (inline) return { value: inline, source: `第 ${rowIndex + 1} 行`, confidence: 0.92 };
      const normalized = normalizeLabel(raw);
      const matchedAlias = aliases.find((alias) => labelMatches(normalized, alias));
      if (!matchedAlias || normalizeLabel(matchedAlias).length < 3) continue;
      for (let offset = 1; offset <= 3; offset += 1) {
        const adjacent = cleanText(row[columnIndex + offset]);
        if (adjacent) return { value: adjacent, source: `第 ${rowIndex + 1} 行`, confidence: offset === 1 ? 0.94 : 0.84 };
      }
      const below = cleanText(rows[rowIndex + 1]?.[columnIndex]);
      if (below) return { value: below, source: `第 ${rowIndex + 2} 行`, confidence: 0.76 };
    }
  }
  return null;
}

function itemHeaderKey(value: unknown) {
  const normalized = normalizeLabel(value);
  return (Object.entries(itemAliases) as Array<[keyof typeof itemAliases, readonly string[]]>)
    .find(([, aliases]) => aliases.some((alias) => labelMatches(normalized, alias)))?.[0];
}

function rowText(row: unknown[]) {
  return normalizeLabel(row.map((cell) => cleanText(cell)).filter(Boolean).join(" "));
}

function isItemSectionEnd(row: unknown[]) {
  const text = rowText(row);
  if (!text) return false;
  return /^(?:sub tota(?:l)?|subtotal|grand tota(?:l)?|total|total payment|invoice total|total amount|合计|总计)(?:\b|\s|$)/iu.test(text)
    || /^(?:notes?|remarks?|bank information|shipping information|special notes|terms and conditions|packing details|总备注|生产部确认|品质部确认|包装送货要求)(?:\b|\s|$)/iu.test(text);
}

function numericColumnRatio(rows: unknown[][], headerRow: number, column: number) {
  let values = 0;
  let numeric = 0;
  for (let index = headerRow + 1; index < Math.min(rows.length, headerRow + 16); index += 1) {
    if (isItemSectionEnd(rows[index] || [])) break;
    const raw = cleanText(rows[index]?.[column], 80);
    if (!raw) continue;
    values += 1;
    if (/[-+]?\d[\d,.]*/u.test(raw) && numberValue(raw) > 0) numeric += 1;
  }
  return values ? numeric / values : 0;
}

function extractItems(rows: unknown[][]) {
  let best: { rowIndex: number; columns: Partial<Record<keyof typeof itemAliases, number>>; score: number } | null = null;
  rows.forEach((row, rowIndex) => {
    const columns: Partial<Record<keyof typeof itemAliases, number>> = {};
    let genericItemColumn: number | undefined;
    row.forEach((cell, columnIndex) => {
      if (/^item(?:\s*(?:#|no|number))?$/iu.test(normalizeLabel(cell))) genericItemColumn ??= columnIndex;
      const key = itemHeaderKey(cell);
      if (key && columns[key] === undefined) columns[key] = columnIndex;
    });
    if (columns.model === undefined && genericItemColumn !== undefined && columns.product !== undefined) columns.model = genericItemColumn;
    if (columns.product === undefined && columns.model !== undefined) columns.product = columns.model;
    if (columns.quantity === undefined && columns.unit !== undefined && numericColumnRatio(rows, rowIndex, columns.unit) >= 0.6) {
      columns.quantity = columns.unit;
      delete columns.unit;
    }
    const score = Object.keys(columns).length + (columns.product !== undefined ? 2 : 0) + (columns.quantity !== undefined ? 1 : 0);
    if (score >= 5 && (!best || score > best.score)) best = { rowIndex, columns, score };
  });
  if (best === null) return [];
  const selected = best as { rowIndex: number; columns: Partial<Record<keyof typeof itemAliases, number>>; score: number };
  const { rowIndex, columns } = selected;
  if (columns.quantity === undefined && columns.unit !== undefined && numericColumnRatio(rows, rowIndex, columns.unit) >= 0.5) {
    columns.quantity = columns.unit;
    delete columns.unit;
  }
  const items: TradeDocumentItem[] = [];
  let emptyRows = 0;
  for (let index = rowIndex + 1; index < rows.length && items.length < 80; index += 1) {
    const row = rows[index] || [];
    if (isItemSectionEnd(row)) break;
    const product = cleanText(columns.product === undefined ? "" : row[columns.product], 500);
    const model = cleanText(columns.model === undefined ? "" : row[columns.model], 200);
    const quantity = numberValue(columns.quantity === undefined ? 0 : row[columns.quantity]);
    const unitPrice = numberValue(columns.unitPrice === undefined ? 0 : row[columns.unitPrice]);
    const amount = numberValue(columns.amount === undefined ? 0 : row[columns.amount]);
    if (!product && !model && !quantity && !unitPrice && !amount) {
      emptyRows += 1;
      if (emptyRows >= 2) break;
      continue;
    }
    if (product && !model && !quantity && !unitPrice && !amount && items.length) {
      const previous = items[items.length - 1]!;
      previous.product = previous.product === previous.model ? product : `${previous.product} ${product}`.trim();
      emptyRows = 0;
      continue;
    }
    emptyRows = 0;
    const inferredQuantity = quantity || (amount > 0 && unitPrice > 0 ? amount / unitPrice : 1);
    const inferredPrice = unitPrice || (amount > 0 && inferredQuantity > 0 ? amount / inferredQuantity : 0);
    const resolvedProduct = product || model;
    items.push({
      id: `import_item_${items.length + 1}`,
      product: resolvedProduct,
      model: columns.product === columns.model ? "" : model,
      material: cleanText(columns.material === undefined ? "" : row[columns.material], 200),
      finish: cleanText(columns.finish === undefined ? "" : row[columns.finish], 200),
      hsCode: cleanText(columns.hsCode === undefined ? "" : row[columns.hsCode], 40),
      quantity: inferredQuantity,
      unit: cleanText(columns.unit === undefined ? "PCS" : row[columns.unit], 40) || "PCS",
      unitPrice: inferredPrice,
      originCountry: cleanText(columns.originCountry === undefined ? "" : row[columns.originCountry], 80),
      weightKg: numberValue(columns.weightKg === undefined ? 0 : row[columns.weightKg]),
      packageCount: Math.round(numberValue(columns.packageCount === undefined ? 0 : row[columns.packageCount]))
    });
  }
  items.forEach((item) => {
    if (normalizeLabel(item.product) === normalizeLabel(item.model)) item.model = "";
  });
  return items;
}

function parseRows(rows: unknown[][], fileName: string): ParsedTradeDocumentSource {
  const compactRows = rows
    .map((row) => row.map((cell) => cleanText(cell)).filter((cell, index, cells) => cell || index < cells.length - 1))
    .filter((row) => row.some(Boolean))
    .slice(0, 2_000);
  const flattened = compactRows.map((row) => row.filter(Boolean).join(" | ")).join("\n");
  const detected = sourceType(flattened.slice(0, 20_000));
  const evidence: TradeDocumentImportEvidence[] = [];
  const extracted: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(fieldAliases)) {
    const found = findField(compactRows, aliases);
    if (!found) continue;
    let value = found.value;
    if (field === "issueDate" || field === "validityDate") value = dateValue(value);
    if (field === "currency") value = value.match(/\b(?:USD|EUR|CNY|RMB|GBP|JPY|AUD|CAD|HKD)\b/i)?.[0]?.toUpperCase() || value.toUpperCase().slice(0, 12);
    if (field === "incoterm") value = value.match(/\b(?:EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b/i)?.[0]?.toUpperCase() || value.slice(0, 80);
    extracted[field] = value;
    evidence.push({ field, value, source: found.source, confidence: found.confidence });
  }
  const items = extractItems(compactRows);
  const totalField = findField(compactRows, ["grand total", "invoice total", "total payment", "total order", "total amount", "amount due", "总金额", "合计"]);
  const declaredTotal = totalField ? numberValue(totalField.value) : undefined;
  const calculatedTotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const title = `${({ PI: "形式发票", CI: "商业发票", PL: "装箱单", CONTRACT: "合同", QUOTATION: "报价单", COO: "原产地证", SHIPPING: "装运通知", CUSTOMS: "报关资料" } as Record<string, string>)[detected.type]} · 导入自 ${fileName}`;
  const draft: TradeDocumentImportDraft = {
    customerId: "",
    dealId: "",
    type: detected.type,
    title: title.slice(0, 255),
    number: extracted.number || `${detected.type}-${new Date().toISOString().slice(0, 10).replace(/-/gu, "")}-IMPORT`,
    issueDate: extracted.issueDate || new Date().toISOString().slice(0, 10),
    buyer: extracted.buyer || "",
    buyerAddress: extracted.buyerAddress || "",
    buyerContact: extracted.buyerContact || "",
    seller: extracted.seller || "",
    sellerAddress: extracted.sellerAddress || "",
    currency: extracted.currency || "USD",
    incoterm: extracted.incoterm || "FOB",
    paymentTerm: extracted.paymentTerm || "",
    shippingMethod: extracted.shippingMethod || "Sea freight",
    portLoading: extracted.portLoading || "",
    portDischarge: extracted.portDischarge || "",
    validityDate: extracted.validityDate || "",
    bankInfo: extracted.bankInfo || "",
    notes: extracted.notes || "",
    language: /[\u4e00-\u9fff]/u.test(flattened) ? "ZH" : "EN",
    templateStyle: "indigo",
    items
  };
  const warnings: string[] = [];
  if (detected.confidence < 0.7) warnings.push("未找到明确的单据类型标题，请人工确认类型");
  if (!extracted.number) warnings.push("未识别到原单据编号，已生成临时编号");
  if (!extracted.issueDate) warnings.push("未识别到签发日期，已暂用今天，请核对");
  if (!draft.seller) warnings.push("未识别到卖方公司，确认导入前必须补充");
  if (!draft.buyer) warnings.push("未识别到买方公司，请核对");
  if (!items.length) warnings.push("未识别到商品表头或明细，请人工补充至少一条商品");
  if (items.some((item) => !item.product)) warnings.push("部分商品缺少品名，请补充后再导入");
  if (declaredTotal !== undefined && Math.abs(declaredTotal - calculatedTotal) > 0.02) warnings.push(`明细计算金额与原单合计相差 ${Math.abs(declaredTotal - calculatedTotal).toFixed(2)}，请重点核对`);
  const meaningfulFields = [draft.number, draft.buyer, draft.seller, draft.currency, draft.incoterm, ...items.map((item) => item.product)].filter(Boolean).length;
  const confidence = Math.min(0.98, Math.max(0.2, detected.confidence * 0.3 + Math.min(1, meaningfulFields / 8) * 0.7));
  return {
    draft,
    evidence,
    warnings,
    preview: compactRows.slice(0, 120).map((row) => row.filter(Boolean).join("  |  ").slice(0, 500)),
    confidence,
    declaredTotal,
    calculatedTotal
  };
}

async function pdfRows(buffer: Buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const document = await loadingTask.promise;
  const rows: string[][] = [];
  try {
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 40); pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: Array<{ y: number; cells: Array<{ x: number; width: number; text: string }> }> = [];
      for (const raw of content.items) {
        if (!("str" in raw) || !raw.str.trim()) continue;
        const y = Number(raw.transform?.[5] || 0);
        let line = lines.find((candidate) => Math.abs(candidate.y - y) <= 2);
        if (!line) {
          line = { y, cells: [] };
          lines.push(line);
        }
        line.cells.push({ x: Number(raw.transform?.[4] || 0), width: Number(raw.width || 0), text: raw.str });
      }
      const grouped = lines.sort((left, right) => right.y - left.y).map((line) => {
        const fragments = line.cells.sort((left, right) => left.x - right.x);
        const fragmentedText = fragments.filter((fragment) => cleanText(fragment.text).length === 1).length >= Math.max(4, fragments.length * 0.6);
        if (!fragmentedText) {
          return { y: line.y, cells: fragments.map((fragment) => ({ x: fragment.x, text: cleanText(fragment.text) })).filter((cell) => cell.text) };
        }
        const cells: Array<{ x: number; text: string }> = [];
        let text = "";
        let startX = 0;
        let rightEdge = 0;
        for (const fragment of fragments) {
          const gap = text ? fragment.x - rightEdge : 0;
          if (text && gap > 16) {
            cells.push({ x: startX, text: cleanText(text) });
            text = "";
          }
          if (!text) startX = fragment.x;
          if (text && gap > 2.5 && !/\s$/u.test(text)) text += " ";
          text += fragment.text;
          rightEdge = Math.max(rightEdge, fragment.x + fragment.width);
        }
        if (text) cells.push({ x: startX, text: cleanText(text) });
        return { y: line.y, cells: cells.filter((cell) => cell.text) };
      });
      const header = grouped.find((line) => line.cells.filter((cell) => itemHeaderKey(cell.text) || /^item(?:\s*(?:#|no|number))?$/iu.test(normalizeLabel(cell.text))).length >= 3);
      const headerCells = header?.cells.filter((cell) => itemHeaderKey(cell.text) || /^item(?:\s*(?:#|no|number))?$/iu.test(normalizeLabel(cell.text))) || [];
      const boundaries = headerCells.slice(1).map((cell) => cell.x - 6);
      grouped.forEach((line) => {
        if (!header || !headerCells.length || line.y > header.y + 2) {
          rows.push(line.cells.map((cell) => cell.text));
          return;
        }
        const row = Array.from({ length: headerCells.length }, () => "");
        for (const cell of line.cells) {
          let column = boundaries.findIndex((boundary) => cell.x < boundary);
          if (column < 0) column = headerCells.length - 1;
          row[column] = row[column] ? `${row[column]} ${cell.text}` : cell.text;
        }
        rows.push(row);
      });
    }
  } finally {
    await document.destroy();
  }
  return rows;
}

export function detectTradeDocumentImportFile(fileName: string, declaredMime: string, buffer: Buffer) {
  if (!buffer.length || buffer.length > TRADE_DOCUMENT_IMPORT_MAX_BYTES) throw new Error("单据文件大小必须在 8 MB 以内");
  const extension = fileName.toLowerCase().match(/\.(xlsx|xls|csv|pdf)$/u)?.[1] || "";
  const isZip = buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const isXls = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const isPdf = buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const textSample = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
  const isCsv = !textSample.includes(0) && /[,;\t]/u.test(textSample.toString("utf8"));
  const kind = isPdf ? "pdf" : isZip ? "xlsx" : isXls ? "xls" : isCsv ? "csv" : "";
  if (!kind || extension !== kind) throw new Error("文件内容与扩展名不一致，仅支持真实 XLSX、XLS、CSV 或文本型 PDF");
  const allowedMime = new Set([
    "application/octet-stream", "application/pdf", "text/csv", "application/csv", "text/plain",
    "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ]);
  if (declaredMime && !allowedMime.has(declaredMime.toLowerCase())) throw new Error("文件 MIME 类型不受支持");
  return kind as "xlsx" | "xls" | "csv" | "pdf";
}

function packageImage(files: Record<string, Uint8Array>, filePath: string) {
  const data = files[filePath];
  if (!data?.length) return undefined;
  const png = data.length >= 8 && data.slice(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]);
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!png && !jpeg) return undefined;
  return { data, extension: png ? "png" as const : "jpg" as const };
}

function relationshipMap(xml: string) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const result = new Map<string, string>();
  $("Relationship").each((_, node) => {
    const id = $(node).attr("Id") || "";
    const target = $(node).attr("Target") || "";
    if (id && target) result.set(id, target);
  });
  return result;
}

function isImageHeader(value: unknown) {
  return itemImageAliases.some((alias) => labelMatches(value, alias));
}

function hasImageHeader(sheet: XLSX.WorkSheet, row: number, column: number) {
  for (let index = row - 1; index >= Math.max(0, row - 20); index -= 1) {
    const value = sheet[XLSX.utils.encode_cell({ r: index, c: column })]?.v;
    if (isImageHeader(value)) return true;
  }
  return false;
}

function importedItemIndex(sheet: XLSX.WorkSheet, row: number, items: TradeDocumentItem[], fallbackIndex: number) {
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { s: { c: 0 }, e: { c: 30 } };
  const values: string[] = [];
  for (let column = range.s.c; column <= Math.min(range.e.c, 40); column += 1) {
    const value = cleanText(sheet[XLSX.utils.encode_cell({ r: row, c: column })]?.v, 500);
    if (value) values.push(value);
  }
  const normalizedRow = normalizeLabel(values.join(" "));
  let best = { index: -1, score: 0 };
  items.forEach((item, index) => {
    const model = normalizeLabel(item.model);
    const product = normalizeLabel(item.product);
    const score = (model.length >= 2 && normalizedRow.includes(model) ? 3 : 0)
      + (product.length >= 4 && normalizedRow.includes(product) ? 2 : 0);
    if (score > best.score) best = { index, score };
  });
  return best.index >= 0 ? best.index : Math.min(fallbackIndex, Math.max(0, items.length - 1));
}

function extractEmbeddedWorkbookImages(buffer: Buffer, workbook: XLSX.WorkBook, items: TradeDocumentItem[]) {
  if (!items.length || buffer.length < 4 || !buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return [];
  const files = unzipSync(new Uint8Array(buffer));
  const result = new Map<number, { itemIndex: number; data: Uint8Array; extension: "png" | "jpg" }>();
  const add = (sheet: XLSX.WorkSheet, row: number, column: number, image: ReturnType<typeof packageImage>, fallbackIndex: number) => {
    if (!image || !hasImageHeader(sheet, row, column)) return;
    const itemIndex = importedItemIndex(sheet, row, items, fallbackIndex);
    if (!result.has(itemIndex)) result.set(itemIndex, { itemIndex, ...image });
  };

  const cellImagesXml = files["xl/cellimages.xml"];
  const cellImagesRels = files["xl/_rels/cellimages.xml.rels"];
  if (cellImagesXml && cellImagesRels) {
    const rels = relationshipMap(strFromU8(cellImagesRels));
    const $ = cheerio.load(strFromU8(cellImagesXml), { xmlMode: true });
    const byId = new Map<string, ReturnType<typeof packageImage>>();
    $("etc\\:cellImage, cellImage").each((_, node) => {
      const id = $(node).find("xdr\\:cNvPr, cNvPr").first().attr("name") || "";
      const relationshipId = $(node).find("a\\:blip, blip").first().attr("r:embed") || "";
      const target = rels.get(relationshipId);
      if (!id || !target) return;
      byId.set(id, packageImage(files, path.posix.normalize(path.posix.join("xl", target))));
    });
    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet?.["!ref"]) return;
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      let fallbackIndex = 0;
      for (let row = range.s.r; row <= range.e.r; row += 1) {
        for (let column = range.s.c; column <= range.e.c; column += 1) {
          const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
          const formula = String(cell?.f || cell?.v || "");
          const id = formula.match(/DISPIMG\s*\(\s*["']([^"']+)["']/iu)?.[1] || "";
          if (!id) continue;
          const before = result.size;
          add(sheet, row, column, byId.get(id), fallbackIndex);
          if (result.size > before) fallbackIndex += 1;
        }
      }
    });
  }

  workbook.SheetNames.forEach((sheetName, sheetIndex) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;
    const worksheetPath = `xl/worksheets/sheet${sheetIndex + 1}.xml`;
    const worksheetXml = files[worksheetPath];
    const worksheetRelsPath = `xl/worksheets/_rels/sheet${sheetIndex + 1}.xml.rels`;
    const worksheetRels = files[worksheetRelsPath];
    if (!worksheetXml || !worksheetRels) return;
    const sheet$ = cheerio.load(strFromU8(worksheetXml), { xmlMode: true });
    const drawingRelId = sheet$("drawing").first().attr("r:id") || "";
    const drawingTarget = relationshipMap(strFromU8(worksheetRels)).get(drawingRelId);
    if (!drawingTarget) return;
    const drawingPath = path.posix.normalize(path.posix.join(path.posix.dirname(worksheetPath), drawingTarget));
    const drawingXml = files[drawingPath];
    const drawingRelsPath = path.posix.join(path.posix.dirname(drawingPath), "_rels", `${path.posix.basename(drawingPath)}.rels`);
    const drawingRels = files[drawingRelsPath];
    if (!drawingXml || !drawingRels) return;
    const rels = relationshipMap(strFromU8(drawingRels));
    const $ = cheerio.load(strFromU8(drawingXml), { xmlMode: true });
    let fallbackIndex = 0;
    $("xdr\\:twoCellAnchor, xdr\\:oneCellAnchor, twoCellAnchor, oneCellAnchor").each((_, anchor) => {
      const from = $(anchor).find("xdr\\:from, from").first();
      const row = Number(from.find("xdr\\:row, row").first().text());
      const column = Number(from.find("xdr\\:col, col").first().text());
      const relationshipId = $(anchor).find("a\\:blip, blip").first().attr("r:embed") || "";
      const target = rels.get(relationshipId);
      if (!target) return;
      const before = result.size;
      add(sheet, row, column, packageImage(files, path.posix.normalize(path.posix.join(path.posix.dirname(drawingPath), target))), fallbackIndex);
      if (result.size > before) fallbackIndex += 1;
    });
  });

  return [...result.values()].sort((left, right) => left.itemIndex - right.itemIndex);
}

export async function parseTradeDocumentImport(fileName: string, declaredMime: string, buffer: Buffer) {
  const kind = detectTradeDocumentImportFile(fileName, declaredMime, buffer);
  if (kind === "pdf") {
    const rows = await pdfRows(buffer);
    if (!rows.length || rows.flat().join("").trim().length < 20) throw new Error("PDF 没有可提取文本，可能是扫描件；请先使用合规 OCR 转为可搜索 PDF");
    return parseRows(rows, fileName);
  }
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, dense: false });
  const rows: unknown[][] = [];
  for (const sheetName of workbook.SheetNames.slice(0, 12)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    rows.push([`工作表：${sheetName}`]);
    rows.push(...XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false }).slice(0, 1_000));
  }
  if (!rows.length) throw new Error("表格中没有可识别内容");
  const parsed = parseRows(rows, fileName);
  parsed.embeddedImages = extractEmbeddedWorkbookImages(buffer, workbook, parsed.draft.items);
  if (parsed.embeddedImages.length) parsed.warnings.push(`已识别 ${parsed.embeddedImages.length} 张商品图片，将随单据保存并用于后续 Excel`);
  return parsed;
}

export function createTradeDocumentImportAnalysis(input: {
  id: string;
  fileName: string;
  mime: string;
  storageKey: string;
  sha256: string;
  sourceSize: number;
  ownerId: string;
  teamId: string;
  parsed: ParsedTradeDocumentSource;
}): TradeDocumentImportAnalysis {
  const now = new Date().toISOString();
  return {
    id: input.id,
    sourceFileName: input.fileName,
    sourceMime: input.mime,
    sourceStorageKey: input.storageKey,
    sourceSha256: input.sha256,
    sourceSize: input.sourceSize,
    status: "needs_review",
    detectedType: input.parsed.draft.type,
    confidence: input.parsed.confidence,
    extractedDocument: input.parsed.draft,
    fieldEvidence: input.parsed.evidence,
    warnings: input.parsed.warnings,
    sourcePreview: input.parsed.preview,
    calculatedTotal: input.parsed.calculatedTotal,
    declaredTotal: input.parsed.declaredTotal,
    totalDifference: input.parsed.declaredTotal === undefined ? undefined : input.parsed.declaredTotal - input.parsed.calculatedTotal,
    ownerId: input.ownerId,
    teamId: input.teamId,
    createdAt: now,
    updatedAt: now
  };
}
