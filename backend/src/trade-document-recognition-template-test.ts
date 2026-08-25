import assert from "node:assert/strict";
import {
  applyTradeDocumentRecognitionTemplate,
  buildTradeDocumentRecognitionTemplate,
  matchTradeDocumentRecognitionTemplate
} from "./trade-document-recognition-template.js";
import type { TradeDocumentImportAnalysis, TradeDocumentImportDraft } from "./types.js";
import type { ParsedTradeDocumentSource } from "./trade-document-import.js";

const draft: TradeDocumentImportDraft = {
  customerId: "",
  dealId: "",
  type: "PI",
  title: "Imported PI",
  number: "PI-001",
  issueDate: "2026-08-24",
  buyer: "Northwind LLC",
  buyerAddress: "New York",
  buyerContact: "Amy",
  seller: "Good Job Industrial Ltd.",
  sellerAddress: "Hong Kong",
  currency: "USD",
  incoterm: "FOB",
  paymentTerm: "30% deposit",
  shippingMethod: "Sea",
  portLoading: "Shenzhen",
  portDischarge: "New York",
  validityDate: "2026-09-24",
  bankInfo: "Example Bank",
  notes: "Sample",
  language: "EN",
  templateStyle: "rose",
  items: [{ id: "i1", product: "LED Light", model: "L-01", material: "Aluminum", finish: "Anodized", hsCode: "9405", quantity: 10, unit: "PCS", unitPrice: 12, originCountry: "China", weightKg: 8, packageCount: 1 }]
};

const preview = [
  "PROFORMA INVOICE",
  "Special Ref | PI-001",
  "Invoice Date | 2026-08-24",
  "Exporter Name | Good Job Industrial Ltd.",
  "Client Name | Northwind LLC",
  "Trade Currency | USD",
  "Goods Name | SKU Ref | Metal Grade | Surface Work | Order Qty | UOM | Sales Rate",
  "LED Light | L-01 | Aluminum | Anodized | 10 | PCS | 12",
  "Grand Total | 120"
];

const parsed: ParsedTradeDocumentSource = {
  draft: structuredClone(draft),
  evidence: [],
  warnings: [],
  preview,
  confidence: 0.7,
  calculatedTotal: 120
};
const analysis = {
  id: "analysis-1", sourceFileName: "sample.xlsx", sourceMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sourceStorageKey: "sample.xlsx", sourceSha256: "a".repeat(64), sourceSize: 100, status: "needs_review", detectedType: "PI",
  confidence: 0.7, extractedDocument: draft, fieldEvidence: [], warnings: [], sourcePreview: preview, calculatedTotal: 120,
  ownerId: "u1", teamId: "team-a", createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z"
} satisfies TradeDocumentImportAnalysis;

const templateV1 = buildTradeDocumentRecognitionTemplate({
  analysis, corrected: draft, id: "template-v1", familyId: "family-1", version: 1, name: "Supplier PI", sourceKind: "import",
  userId: "u1", teamId: "team-a", now: "2026-08-24T00:00:00.000Z"
});
assert.ok(templateV1.fingerprint.anchors.includes("Special Ref"), "should learn custom scalar labels");
assert.ok(templateV1.itemColumnRules.product?.includes("Goods Name"), "should learn custom item headers");

const archivedV1 = { ...templateV1, status: "archived" as const, archivedAt: "2026-08-24T01:00:00.000Z" };
const templateV2 = { ...templateV1, id: "template-v2", version: 2, status: "active" as const };
const match = matchTradeDocumentRecognitionTemplate({ templates: [archivedV1, templateV2], teamId: "team-a", sourceKind: "import", parsed });
assert.equal(match?.template.id, "template-v2", "only active version should participate in matching");
assert.equal(matchTradeDocumentRecognitionTemplate({ templates: [templateV2], teamId: "team-b", sourceKind: "import", parsed }), null, "templates must be team isolated");
assert.equal(matchTradeDocumentRecognitionTemplate({ templates: [templateV2], teamId: "team-a", sourceKind: "ocr", parsed }), null, "source kinds must not cross-match");

const nextParsed = structuredClone(parsed);
nextParsed.draft.number = "fallback-number";
nextParsed.draft.items = [];
nextParsed.preview = preview.map((line) => line.replace("PI-001", "PI-002").replace("LED Light", "Desk Light").replace("L-01", "D-02").replace("10 | PCS | 12", "20 | PCS | 9"));
const applied = applyTradeDocumentRecognitionTemplate(nextParsed, templateV2, match!.score);
assert.equal(applied.parsed.draft.number, "PI-002");
assert.equal(applied.parsed.draft.items[0]?.product, "Desk Light");
assert.equal(applied.parsed.draft.items[0]?.quantity, 20);
assert.equal(applied.parsed.calculatedTotal, 180);
assert.equal(applied.snapshot.version, 2);

console.log("trade document recognition template tests passed");
