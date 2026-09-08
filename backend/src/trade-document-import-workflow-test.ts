import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import XLSX from "xlsx-js-style";
import { app } from "./server.js";
import { getStore } from "./store.js";
import { parseTradeDocumentImport } from "./trade-document-import.js";
import type { TradeDocumentImportAnalysis } from "./types.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start trade document import test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(apiPath: string, token = "", init: RequestInit = {}) {
  return fetch(`${baseUrl}${apiPath}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
}

async function login() {
  const response = await request("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ email: "admin@goodjob.com", password: "goodjob123" })
  });
  assert.equal(response.status, 200, "admin login must succeed");
  return String((await response.json()).token || "");
}

function workbookFromRows(rows: unknown[][], sheetName: string) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

function importWorkbook() {
  return workbookFromRows([
    ["PROFORMA INVOICE"],
    ["Invoice No", "PI-PUBLIC-IMPORT-001", "Invoice Date", "August 13, 2026"],
    ["Seller", "GoodJob Export Limited", "Buyer", "Northstar Distribution LLC"],
    ["Seller Address", "88 Harbour Road, Hong Kong", "Buyer Address", "10 Market Street, Seattle, USA"],
    ["Buyer Contact", "Ava / ava@northstar.example", "Currency", "USD"],
    ["Incoterm", "FOB", "Payment Term", "30% deposit, 70% before shipment"],
    [],
    ["Description", "Model", "Material", "Finish", "HS Code", "Quantity", "Unit", "Unit Price", "Amount"],
    ["LED Flood Light", "FL-200", "6061-T6", "Anodized", "940542", 10, "PCS", 25, 250],
    ["Lighting Controller", "LC-12", "ABS", "Matte", "853710", 4, "PCS", 30, 120],
    ["Grand Total", 370]
  ], "PI");
}

async function verifyParserLayouts() {
  const parsed = await parseTradeDocumentImport(
    "quote.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    workbookFromRows([
      ["PRICE QUOTE"],
      ["Date", "August 5, 2026", "Valid Until", "September 5, 2026"],
      ["Quote#", "QT-PUBLIC-001"],
      ["Item", "Part Name", "Des", "Material", "Finish", "Qty", "Unit Price", "Sum"],
      [1, "M008146-A", "LEAK DETECTOR MOUNTING BRACKET", "5052", "POWDER COAT", 2, "US$32.8", "US$65.6"],
      [2, "M011069-A", "WATER MANIFOLD, 19IN", "5052", "POWDER COAT", 4, "US$52.8", "US$211.2"],
      ["SUB TOTAL", "", "", "", "", "", "", "US$276.8"]
    ], "Price Quote")
  );
  assert.equal(parsed.draft.type, "QUOTATION");
  assert.equal(parsed.draft.issueDate, "2026-08-05");
  assert.equal(parsed.draft.validityDate, "2026-09-05");
  assert.equal(parsed.draft.items.length, 2);
  assert.equal(parsed.draft.items[0]?.model, "M008146-A");
  assert.equal(parsed.draft.items[0]?.material, "5052");
  assert.equal(parsed.draft.items[0]?.finish, "POWDER COAT");
  assert.equal(parsed.draft.items[1]?.quantity, 4);
  assert.equal(parsed.draft.items[1]?.unitPrice, 52.8);
}

let analysisId = "";
let sourceStorageKey = "";
try {
  await verifyParserLayouts();
  const store = getStore();
  store.tradeDocumentImportAnalyses.splice(0, store.tradeDocumentImportAnalyses.length);
  const token = await login();

  assert.equal((await request("/api/trade-document-imports")).status, 401);
  const forged = await request("/api/trade-document-imports/analyze", token, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("forged.xlsx"),
      "x-file-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    },
    body: Buffer.from("not a workbook")
  });
  assert.equal(forged.status, 422);

  const workbook = importWorkbook();
  const analyzed = await request("/api/trade-document-imports/analyze", token, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("northstar-proforma.xlsx"),
      "x-file-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    },
    body: workbook
  });
  assert.equal(analyzed.status, 201);
  const analyzedBody = await analyzed.json() as { analysis: TradeDocumentImportAnalysis; duplicate: boolean };
  const analysis = analyzedBody.analysis;
  analysisId = analysis.id;
  sourceStorageKey = analysis.sourceStorageKey;
  assert.equal(analyzedBody.duplicate, false);
  assert.equal(analysis.detectedType, "PI");
  assert.equal(analysis.extractedDocument.number, "PI-PUBLIC-IMPORT-001");
  assert.equal(analysis.extractedDocument.items.length, 2);
  assert.equal(analysis.extractedDocument.items[0]?.material, "6061-T6");
  assert.equal(analysis.extractedDocument.items[0]?.finish, "Anodized");
  assert.equal(analysis.calculatedTotal, 370);

  const duplicate = await request("/api/trade-document-imports/analyze", token, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("northstar-proforma.xlsx"),
      "x-file-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    },
    body: workbook
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const corrected = structuredClone(analysis.extractedDocument);
  corrected.buyerContact = "Ava Stone / ava@northstar.example";
  corrected.items[0]!.quantity = 12;
  const confirmed = await request(`/api/trade-document-imports/${analysis.id}/confirm`, token, {
    method: "POST",
    body: JSON.stringify({ document: corrected })
  });
  assert.equal(confirmed.status, 201);
  const confirmedBody = await confirmed.json();
  assert.equal(confirmedBody.document.status, "draft");
  assert.equal(confirmedBody.document.importAnalysisId, analysis.id);
  assert.equal(confirmedBody.document.items[0].quantity, 12);
  assert.equal(confirmedBody.document.items[0].material, "6061-T6");
  assert.equal(confirmedBody.document.items[0].finish, "Anodized");

  const converted = await request(`/api/trade-documents/${confirmedBody.document.id}/convert`, token, {
    method: "POST",
    body: JSON.stringify({ targetType: "CI" })
  });
  assert.equal(converted.status, 200);
  const convertedDocument = (await converted.json()).document;
  assert.equal(convertedDocument.type, "CI");
  assert.equal(convertedDocument.derivedFromDocumentId, confirmedBody.document.id);
  assert.equal(convertedDocument.items[0].material, "6061-T6");
  assert.equal(convertedDocument.items[0].finish, "Anodized");

  console.log(JSON.stringify({
    ok: true,
    analysisId: analysis.id,
    documentId: confirmedBody.document.id,
    convertedId: convertedDocument.id,
    items: analysis.extractedDocument.items.length
  }));
} finally {
  server.close();
  if (analysisId && sourceStorageKey) {
    const importsDir = path.resolve(
      process.env.GOODJOB_UPLOADS_DIR?.trim() || path.resolve(process.cwd(), "uploads"),
      ".trade-document-imports"
    );
    await rm(path.join(importsDir, sourceStorageKey), { force: true }).catch(() => undefined);
  }
}
