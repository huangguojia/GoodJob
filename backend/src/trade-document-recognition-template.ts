import type {
  TradeDocumentImportAnalysis,
  TradeDocumentImportDraft,
  TradeDocumentItem,
  TradeDocumentRecognitionFieldRule,
  TradeDocumentRecognitionSource,
  TradeDocumentRecognitionTemplate,
  TradeDocumentRecognitionTemplateSnapshot
} from "./types.js";
import type { ParsedTradeDocumentSource } from "./trade-document-import.js";

const scalarFields: TradeDocumentRecognitionFieldRule["field"][] = [
  "number", "issueDate", "buyer", "buyerAddress", "buyerContact", "seller", "sellerAddress", "currency",
  "incoterm", "paymentTerm", "shippingMethod", "portLoading", "portDischarge", "validityDate", "bankInfo", "notes"
];

const itemFields = [
  "product", "model", "material", "finish", "hsCode", "quantity", "unit", "unitPrice", "amount", "originCountry", "weightKg", "packageCount"
] as const;

function clean(value: unknown, max = 500) {
  return String(value ?? "").replace(/\u0000/gu, "").replace(/[ \t\r\n]+/gu, " ").trim().slice(0, max);
}

export function normalizeRecognitionToken(value: unknown) {
  return clean(value)
    .replace(/[：:#]+$/gu, "")
    .replace(/[\s_./-]+/gu, " ")
    .trim()
    .toLowerCase();
}

function previewRows(preview: string[]) {
  return preview.map((line) => line.split(/\s+\|\s+|\t/gu).map((cell) => clean(cell)).filter(Boolean)).filter((row) => row.length);
}

function usableLabel(value: string) {
  const normalized = normalizeRecognitionToken(value);
  if (normalized.length < 2 || normalized.length > 80) return "";
  if (/^(?:\d[\d.,/: -]*|usd|eur|cny|rmb|gbp|jpy|aud|cad|hkd)$/iu.test(normalized)) return "";
  return clean(value, 80).replace(/[：:# -]+$/gu, "");
}

function labelForValue(rows: string[][], rawValue: unknown) {
  const value = clean(rawValue, 500);
  const normalizedValue = normalizeRecognitionToken(value);
  if (!normalizedValue || normalizedValue.length < 2) return "";
  for (const row of rows) {
    const cellIndex = row.findIndex((cell) => {
      const normalized = normalizeRecognitionToken(cell);
      return normalized === normalizedValue || (normalizedValue.length >= 5 && normalized.includes(normalizedValue));
    });
    if (cellIndex > 0) {
      const label = usableLabel(row[cellIndex - 1]!);
      if (label) return label;
    }
    const inline = row.find((cell) => normalizeRecognitionToken(cell).includes(normalizedValue));
    if (inline) {
      const index = normalizeRecognitionToken(inline).indexOf(normalizedValue);
      const label = usableLabel(inline.slice(0, index));
      if (label) return label;
    }
  }
  return "";
}

function headerForItemValue(rows: string[][], rawValue: unknown) {
  const normalizedValue = normalizeRecognitionToken(rawValue);
  if (!normalizedValue || normalizedValue.length < 2) return "";
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const column = rows[rowIndex]!.findIndex((cell) => normalizeRecognitionToken(cell) === normalizedValue);
    if (column < 0) continue;
    for (let headerIndex = rowIndex - 1; headerIndex >= Math.max(0, rowIndex - 12); headerIndex -= 1) {
      const candidate = usableLabel(rows[headerIndex]?.[column] || "");
      if (candidate && normalizeRecognitionToken(candidate) !== normalizedValue) return candidate;
    }
  }
  return "";
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => clean(value, 80)).filter(Boolean))];
}

export function buildTradeDocumentRecognitionTemplate(input: {
  analysis: TradeDocumentImportAnalysis;
  corrected: TradeDocumentImportDraft;
  id: string;
  familyId: string;
  version: number;
  name: string;
  sourceKind: TradeDocumentRecognitionSource;
  userId: string;
  teamId: string;
  now?: string;
}): TradeDocumentRecognitionTemplate {
  const rows = previewRows(input.analysis.sourcePreview || []);
  const fieldRules = scalarFields.flatMap((field) => {
    const label = labelForValue(rows, input.corrected[field]);
    return label ? [{ field, labels: [label] }] : [];
  });
  const firstItems = input.corrected.items.slice(0, 3);
  const itemColumnRules: TradeDocumentRecognitionTemplate["itemColumnRules"] = {};
  itemFields.forEach((field) => {
    const labels = unique(firstItems.map((item) => headerForItemValue(rows, field === "amount" ? item.quantity * item.unitPrice : item[field as keyof TradeDocumentItem])));
    if (labels.length) itemColumnRules[field] = labels;
  });
  const anchors = unique([
    ...fieldRules.flatMap((rule) => rule.labels),
    ...Object.values(itemColumnRules).flatMap((labels) => labels || [])
  ]).slice(0, 40);
  const now = input.now || new Date().toISOString();
  return {
    id: input.id,
    familyId: input.familyId,
    version: input.version,
    name: clean(input.name, 120),
    documentType: input.corrected.type,
    sourceKind: input.sourceKind,
    status: "active",
    fingerprint: { anchors, sellerHint: clean(input.corrected.seller, 240) || undefined },
    fieldRules,
    itemColumnRules,
    sampleAnalysisId: input.analysis.id,
    createdBy: input.userId,
    teamId: input.teamId,
    createdAt: now
  };
}

function sourceContains(preview: string[], value: string) {
  const haystack = normalizeRecognitionToken(preview.join(" "));
  const needle = normalizeRecognitionToken(value);
  return needle.length >= 2 && haystack.includes(needle);
}

export function matchTradeDocumentRecognitionTemplate(input: {
  templates: TradeDocumentRecognitionTemplate[];
  teamId: string;
  sourceKind: TradeDocumentRecognitionSource;
  parsed: ParsedTradeDocumentSource;
}) {
  const candidates = input.templates.filter((template) => template.teamId === input.teamId
    && template.status === "active"
    && template.sourceKind === input.sourceKind
    && template.documentType === input.parsed.draft.type);
  let best: { template: TradeDocumentRecognitionTemplate; score: number } | null = null;
  for (const template of candidates) {
    const anchors = template.fingerprint.anchors || [];
    if (anchors.length < 2) continue;
    const matchedAnchors = anchors.filter((anchor) => sourceContains(input.parsed.preview, anchor)).length;
    const anchorScore = matchedAnchors / anchors.length;
    const sellerScore = template.fingerprint.sellerHint && sourceContains(input.parsed.preview, template.fingerprint.sellerHint) ? 1 : 0;
    const score = Math.min(1, 0.3 + anchorScore * 0.6 + sellerScore * 0.1);
    if (matchedAnchors < 2 || score < 0.7) continue;
    if (!best || score > best.score || (score === best.score && template.version > best.template.version)) best = { template, score };
  }
  return best;
}

function valueAfterLabel(rows: string[][], labels: string[]) {
  const expected = labels.map(normalizeRecognitionToken);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    for (let column = 0; column < row.length; column += 1) {
      const raw = row[column] || "";
      const normalized = normalizeRecognitionToken(raw);
      const label = expected.find((candidate) => normalized === candidate || normalized.startsWith(`${candidate} `));
      if (!label) continue;
      const inline = clean(raw.slice(raw.toLowerCase().indexOf(label) + label.length).replace(/^[：:# -]+/u, ""));
      if (inline) return inline;
      for (let offset = 1; offset <= 3; offset += 1) if (clean(row[column + offset])) return clean(row[column + offset]);
      if (clean(rows[rowIndex + 1]?.[column])) return clean(rows[rowIndex + 1]?.[column]);
    }
  }
  return "";
}

function numberValue(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/[,\s]/gu, "").replace(/[^0-9.+-]/gu, ""));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function mappedItems(rows: string[][], template: TradeDocumentRecognitionTemplate, fallback: TradeDocumentItem[]) {
  const normalizedRules = Object.fromEntries(Object.entries(template.itemColumnRules).map(([field, labels]) => [field, (labels || []).map(normalizeRecognitionToken)]));
  let header: { index: number; columns: Record<string, number> } | null = null;
  rows.forEach((row, index) => {
    const columns: Record<string, number> = {};
    row.forEach((cell, column) => {
      const normalized = normalizeRecognitionToken(cell);
      const field = Object.entries(normalizedRules).find(([, labels]) => labels.includes(normalized))?.[0];
      if (field && columns[field] === undefined) columns[field] = column;
    });
    if (Object.keys(columns).length >= 2 && (!header || Object.keys(columns).length > Object.keys(header.columns).length)) header = { index, columns };
  });
  if (!header) return fallback;
  const resolvedHeader = header as { index: number; columns: Record<string, number> };
  const items: TradeDocumentItem[] = [];
  let empty = 0;
  for (let index = resolvedHeader.index + 1; index < rows.length && items.length < 500; index += 1) {
    const row = rows[index] || [];
    const rowText = normalizeRecognitionToken(row.join(" "));
    if (/^(?:subtotal|grand total|total|合计|总计|notes|remarks|备注)(?:\b| )/iu.test(rowText)) break;
    const read = (field: string) => clean(row[resolvedHeader.columns[field] ?? -1]);
    const product = read("product");
    const model = read("model");
    const quantity = numberValue(read("quantity"));
    const unitPrice = numberValue(read("unitPrice"));
    const amount = numberValue(read("amount"));
    if (!product && !model && !quantity && !unitPrice && !amount) {
      empty += 1;
      if (empty >= 2) break;
      continue;
    }
    empty = 0;
    const finalQuantity = quantity || (amount && unitPrice ? amount / unitPrice : 1);
    const finalPrice = unitPrice || (amount && finalQuantity ? amount / finalQuantity : 0);
    const previous = fallback[items.length];
    items.push({
      id: previous?.id || `template_item_${items.length + 1}`,
      imageUrl: previous?.imageUrl,
      product: product || model,
      model,
      material: read("material"),
      finish: read("finish"),
      hsCode: read("hsCode"),
      quantity: finalQuantity,
      unit: read("unit") || "PCS",
      unitPrice: finalPrice,
      originCountry: read("originCountry"),
      weightKg: numberValue(read("weightKg")),
      packageCount: Math.round(numberValue(read("packageCount")))
    });
  }
  return items.length ? items : fallback;
}

export function applyTradeDocumentRecognitionTemplate(parsed: ParsedTradeDocumentSource, template: TradeDocumentRecognitionTemplate, score: number) {
  const rows = previewRows(parsed.preview);
  const draft = structuredClone(parsed.draft);
  const evidence = [...parsed.evidence];
  for (const rule of template.fieldRules) {
    const value = valueAfterLabel(rows, rule.labels);
    if (!value) continue;
    (draft as unknown as Record<string, unknown>)[rule.field] = value;
    evidence.push({ field: rule.field, value, source: `${template.name} V${template.version}`, confidence: Math.max(0.7, score) });
  }
  draft.items = mappedItems(rows, template, draft.items);
  const calculatedTotal = draft.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const snapshot: TradeDocumentRecognitionTemplateSnapshot = {
    templateId: template.id,
    familyId: template.familyId,
    name: template.name,
    version: template.version,
    matchScore: score,
    matchedAt: new Date().toISOString()
  };
  return {
    parsed: {
      ...parsed,
      draft,
      evidence,
      calculatedTotal,
      confidence: Math.max(parsed.confidence, Math.min(0.99, score)),
      warnings: [`已匹配识别模板“${template.name}”V${template.version}，请继续核对识别结果`, ...parsed.warnings]
    },
    snapshot
  };
}
