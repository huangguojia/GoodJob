import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import XLSX from "xlsx-js-style";
import { app } from "./server.js";
import { renderExcelBufferToPdf } from "./excel-preview.js";
import { getStore } from "./store.js";
import { parseTradeDocumentImport } from "./trade-document-import.js";
import type { TradeDocumentImportAnalysis, User } from "./types.js";

process.env.LIBREOFFICE_BIN ||= "soffice";

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

async function login(email: string) {
  const response = await request("/api/auth/login", "", { method: "POST", body: JSON.stringify({ email, password: "goodjob123" }) });
  assert.equal(response.status, 200, `login failed: ${email}`);
  return String((await response.json()).token || "");
}

function importWorkbook() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["PROFORMA INVOICE"],
    ["Invoice No", "PI-IMPORT-001", "Invoice Date", "August 13, 2026"],
    ["Seller", "GoodJob Export Limited", "Buyer", "Northstar Distribution LLC"],
    ["Seller Address", "88 Harbour Road, Hong Kong", "Buyer Address", "10 Market Street, Seattle, USA"],
    ["Buyer Contact", "Ava / ava@northstar.example", "Currency", "USD"],
    ["Incoterm", "FOB", "Payment Term", "30% deposit, 70% before shipment"],
    ["Port of Loading", "Shenzhen", "Port of Discharge", "Seattle"],
    [],
    ["Description", "Model", "Material", "Finish", "HS Code", "Quantity", "Unit", "Unit Price", "Amount", "Country of Origin", "Net Weight", "Cartons"],
    ["LED Flood Light", "FL-200", "6061-T6", "Anodized", "940542", 10, "PCS", 25, 250, "China", 45, 2],
    ["Lighting Controller", "LC-12", "ABS", "Matte", "853710", 4, "PCS", 30, 120, "China", 8, 1],
    ["Grand Total", 370]
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "PI");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

function workbookFromRows(rows: unknown[][], sheetName: string) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

async function assertRealisticItemLayouts() {
  const quote = await parseTradeDocumentImport("quote.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", workbookFromRows([
    ["PRICE QUOTE"],
    ["Date", "August 5, 2026", "Valid Until", "September 5, 2026"],
    ["Quote#", "QT-2026-0813"],
    ["Item", "Part Name", "Des", "Image", "Material", "Finish", "Qty", "Unit Price", "Sum"],
    [1, "M008146-A", "LEAK DETECTOR MOUNTING BRACKET", "", "5052", "POWDER COAT", 2, "US$32.8", "US$65.6"],
    [2, "M011069-A", "WATER MANIFOLD, 19IN", "", "5052", "POWDER COAT", 4, "US$52.8", "US$211.2"],
    ["SUB TOTAL", "", "", "", "", "", "", "", "US$276.8"]
  ], "Price Quote"));
  assert.equal(quote.draft.type, "QUOTATION");
  assert.equal(quote.draft.issueDate, "2026-08-05", "English month date must be normalized for date inputs");
  assert.equal(quote.draft.validityDate, "2026-09-05");
  assert.equal(quote.draft.items.length, 2, "quote part rows must be extracted");
  assert.equal(quote.draft.items[0]?.model, "M008146-A");
  assert.equal(quote.draft.items[0]?.product, "LEAK DETECTOR MOUNTING BRACKET");
  assert.equal(quote.draft.items[0]?.material, "5052", "optional Material column must be retained");
  assert.equal(quote.draft.items[0]?.finish, "POWDER COAT", "optional Finish column must be retained");
  assert.equal(quote.draft.items[1]?.quantity, 4);
  assert.equal(quote.draft.items[1]?.unitPrice, 52.8);

  const invoice = await parseTradeDocumentImport("invoice.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", workbookFromRows([
    ["PROFORMA INVOICE"],
    ["Invoice #", "PI-REALISTIC-001"],
    ["Item #", "Part Name", "Image", "Material", "Finish", "Unit", "Price", "Line Total (USD)"],
    [1, "Threaded enclosure block", "", "6061", "No", 500, 0.81, 405],
    ["Notes", "Sample order"],
    ["TOTAL", "", "", "", "", "", "", 405]
  ], "Invoice"));
  assert.equal(invoice.draft.items.length, 1, "invoice item row must be extracted");
  assert.equal(invoice.draft.items[0]?.quantity, 500, "numeric Unit column must be treated as quantity");
  assert.equal(invoice.draft.items[0]?.unit, "PCS");
  assert.equal(invoice.draft.items[0]?.unitPrice, 0.81);
  assert.equal(invoice.draft.items[0]?.material, "6061");
  assert.equal(invoice.draft.items[0]?.finish, "No");

  const packing = await parseTradeDocumentImport("packing-list.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", workbookFromRows([
    ["PACKING LIST"],
    ["PO#2607-3753"],
    ["NO", "Name", "Picture", "材质", "后处理", "Qty"],
    [1, "Threaded block A", "", "6061", "MACHINED", 502],
    [2, "Threaded block B", "", "6061", "MACHINED", 300],
    ["Total", "", "", "", "", 802],
    ["Packing details", "Carton"]
  ], "Packing List"));
  assert.equal(packing.draft.items.length, 2, "packing-list Name/Qty rows must be extracted");
  assert.equal(packing.draft.items[0]?.product, "Threaded block A");
  assert.equal(packing.draft.items[0]?.material, "6061");
  assert.equal(packing.draft.items[0]?.finish, "MACHINED");
  assert.equal(packing.draft.items[1]?.quantity, 300);
  assert.notEqual(packing.draft.number, "Name", "NO column header must not become the document number");

  const datePdfSource = workbookFromRows([
    ["PROFORMA INVOICE"],
    ["Date", "30, Oct. 2025"],
    ["Description", "Quantity", "Unit Price", "Amount"],
    ["Loadcell transmitter", 35, 80, 2800],
    ["Total", "", "", 2800]
  ], "PI");
  const datePdf = await parseTradeDocumentImport("date.pdf", "application/pdf", await renderExcelBufferToPdf(datePdfSource));
  assert.equal(datePdf.draft.issueDate, "2025-10-30", "day-first English PDF date must be normalized");
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

let createdAnalysisId = "";
let secondAnalysisId = "";
let csvAnalysisId = "";
let pdfAnalysisId = "";
try {
  await assertRealisticItemLayouts();
  const store = getStore();
  store.tradeDocumentImportAnalyses.splice(0, store.tradeDocumentImportAnalyses.length);
  const otherAdmin: User = {
    id: "u_import_other_admin",
    name: "Import Other Admin",
    email: "import-other-admin@goodjob.com",
    password: "goodjob123",
    role: "admin",
    teamId: "import-other-team",
    avatar: "IO",
    status: "active",
    authVersion: 1
  };
  store.users.push(otherAdmin);
  const admin = await login("admin@goodjob.com");
  const otherTeam = await login(otherAdmin.email);

  const anonymous = await request("/api/trade-document-imports");
  assert.equal(anonymous.status, 401, "import analyses must require authentication");

  const forged = await request("/api/trade-document-imports/analyze", admin, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("forged.xlsx"), "x-file-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    body: Buffer.from("not a workbook")
  });
  assert.equal(forged.status, 422, "forged spreadsheet content must be rejected");

  const workbook = importWorkbook();
  const analyzed = await request("/api/trade-document-imports/analyze", admin, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("northstar-proforma.xlsx"), "x-file-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    body: workbook
  });
  assert.equal(analyzed.status, 201, "valid spreadsheet must be analyzed");
  const analyzedBody = await analyzed.json() as { analysis: TradeDocumentImportAnalysis; duplicate: boolean };
  const analysis = analyzedBody.analysis;
  createdAnalysisId = analysis.id;
  assert.equal(analyzedBody.duplicate, false);
  assert.equal(analysis.detectedType, "PI");
  assert.equal(analysis.extractedDocument.number, "PI-IMPORT-001");
  assert.equal(analysis.extractedDocument.seller, "GoodJob Export Limited");
  assert.equal(analysis.extractedDocument.buyer, "Northstar Distribution LLC");
  assert.equal(analysis.extractedDocument.items.length, 2);
  assert.equal(analysis.extractedDocument.items[0]?.hsCode, "940542");
  assert.equal(analysis.extractedDocument.items[0]?.material, "6061-T6");
  assert.equal(analysis.extractedDocument.items[0]?.finish, "Anodized");
  assert.equal(analysis.calculatedTotal, 370);
  assert.equal(analysis.declaredTotal, 370);
  assert.ok(analysis.confidence > 0.8);

  const csv = Buffer.from("PROFORMA INVOICE,,,,,,,\nInvoice No,PI-CSV-001,Invoice Date,2026-08-13,,,,,\nSeller,GoodJob Export Limited,Buyer,Northstar Distribution LLC,,,,,\nDescription,Model,HS Code,Quantity,Unit,Unit Price,Amount,Country of Origin\nLED Flood Light,FL-200,940542,10,PCS,25,250,China\nGrand Total,250,,,,,,\n");
  const csvResponse = await request("/api/trade-document-imports/analyze", otherTeam, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("sample.csv"), "x-file-type": "text/csv" },
    body: csv
  });
  assert.equal(csvResponse.status, 201, "CSV import must be supported");
  const csvAnalysis = (await csvResponse.json()).analysis as TradeDocumentImportAnalysis;
  csvAnalysisId = csvAnalysis.id;
  assert.equal(csvAnalysis.extractedDocument.number, "PI-CSV-001");
  assert.equal(csvAnalysis.extractedDocument.items.length, 1);
  assert.equal(csvAnalysis.extractedDocument.items[0]?.material, "", "Material must remain optional when absent");
  assert.equal(csvAnalysis.extractedDocument.items[0]?.finish, "", "Finish must remain optional when absent");
  await request(`/api/trade-document-imports/${csvAnalysis.id}`, otherTeam, { method: "DELETE" });

  const pdf = await renderExcelBufferToPdf(workbook);
  const pdfResponse = await request("/api/trade-document-imports/analyze", otherTeam, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("sample.pdf"), "x-file-type": "application/pdf" },
    body: pdf
  });
  assert.equal(pdfResponse.status, 201, "text PDF import must be supported");
  const pdfAnalysis = (await pdfResponse.json()).analysis as TradeDocumentImportAnalysis;
  pdfAnalysisId = pdfAnalysis.id;
  assert.equal(pdfAnalysis.detectedType, "PI");
  assert.ok(pdfAnalysis.sourcePreview.join(" ").includes("PI-IMPORT"));
  assert.equal(pdfAnalysis.extractedDocument.items.length, 2);
  assert.ok(pdfAnalysis.extractedDocument.items[0]?.product.startsWith("LED Flood"));
  assert.equal(pdfAnalysis.extractedDocument.items[0]?.quantity, 10);
  assert.equal(pdfAnalysis.extractedDocument.items[0]?.unitPrice, 25);
  assert.equal(pdfAnalysis.extractedDocument.items[0]?.material, "6061-T6", "text PDF Material must be recognized");
  assert.equal(pdfAnalysis.extractedDocument.items[0]?.finish, "Anodized", "text PDF Finish must be recognized");
  await request(`/api/trade-document-imports/${pdfAnalysis.id}`, otherTeam, { method: "DELETE" });

  const duplicate = await request("/api/trade-document-imports/analyze", admin, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("northstar-proforma.xlsx"), "x-file-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    body: workbook
  });
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.duplicate, true, "same team/file hash must be idempotent");
  assert.equal(duplicateBody.analysis.extractedDocument.items.length, 2, "unconfirmed duplicate must be reanalyzed with current parsing rules");

  const crossTeamRead = await request(`/api/trade-document-imports/${analysis.id}`, otherTeam);
  assert.equal(crossTeamRead.status, 404, "another team must not read analysis results");
  const crossTeamSource = await request(`/api/trade-document-imports/${analysis.id}/source`, otherTeam);
  assert.equal(crossTeamSource.status, 404, "another team must not read source files");
  const otherList = await request("/api/trade-document-imports", otherTeam);
  assert.equal(otherList.status, 200);
  assert.equal((await otherList.json()).analyses.length, 0, "another team list must remain empty");

  const secondBook = XLSX.read(workbook, { type: "buffer" });
  secondBook.Sheets.PI.A1.v = "PROFORMA INVOICE COPY";
  const secondFile = Buffer.from(XLSX.write(secondBook, { type: "buffer", bookType: "xlsx" }));
  const secondResponse = await request("/api/trade-document-imports/analyze", admin, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("deletable.xlsx"), "x-file-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    body: secondFile
  });
  assert.equal(secondResponse.status, 201);
  secondAnalysisId = String((await secondResponse.json()).analysis.id);
  const deleted = await request(`/api/trade-document-imports/${secondAnalysisId}`, admin, { method: "DELETE" });
  assert.equal(deleted.status, 200, "unconfirmed analysis must be removable");

  const source = await request(`/api/trade-document-imports/${analysis.id}/source`, admin);
  assert.equal(source.status, 200);
  assert.equal(sha256(Buffer.from(await source.arrayBuffer())), sha256(workbook), "source endpoint must return exact original bytes");

  const corrected = structuredClone(analysis.extractedDocument);
  corrected.issueDate = "";
  corrected.buyerContact = "Ava Stone / ava@northstar.example";
  corrected.items[0]!.quantity = 12;
  corrected.notes = "Reviewed against source document";
  const confirmed = await request(`/api/trade-document-imports/${analysis.id}/confirm`, admin, {
    method: "POST",
    body: JSON.stringify({ document: corrected })
  });
  assert.equal(confirmed.status, 201, "reviewed analysis must create a document draft");
  const confirmedBody = await confirmed.json();
  assert.equal(confirmedBody.document.status, "draft");
  assert.equal(confirmedBody.document.importAnalysisId, analysis.id);
  assert.equal(confirmedBody.document.importSourceFileName, "northstar-proforma.xlsx");
  assert.equal(confirmedBody.document.buyerContact, corrected.buyerContact);
  assert.equal(confirmedBody.document.issueDate, "2026-08-13", "legacy blank date must be refreshed from the controlled source file");
  assert.equal(confirmedBody.document.items[0].quantity, 12);
  assert.equal(confirmedBody.document.items[0].material, "6061-T6", "Material must persist on the generated draft");
  assert.equal(confirmedBody.document.items[0].finish, "Anodized", "Finish must persist on the generated draft");
  assert.equal(confirmedBody.analysis.status, "confirmed");

  const documentList = await request("/api/trade-documents", admin);
  assert.equal(documentList.status, 200);
  const persistedDocument = (await documentList.json()).documents.find((item: { id: string }) => item.id === confirmedBody.document.id);
  assert.equal(persistedDocument?.items[0]?.material, "6061-T6", "Material must survive persisted document reads");
  assert.equal(persistedDocument?.items[0]?.finish, "Anodized", "Finish must survive persisted document reads");

  const confirmAgain = await request(`/api/trade-document-imports/${analysis.id}/confirm`, admin, {
    method: "POST",
    body: JSON.stringify({ document: corrected })
  });
  assert.equal(confirmAgain.status, 200);
  assert.equal((await confirmAgain.json()).duplicate, true, "confirm must be idempotent");

  const converted = await request(`/api/trade-documents/${confirmedBody.document.id}/convert`, admin, {
    method: "POST",
    body: JSON.stringify({ targetType: "CI" })
  });
  assert.equal(converted.status, 200, "imported document must reuse the existing conversion flow");
  const convertedDocument = (await converted.json()).document;
  assert.equal(convertedDocument.type, "CI");
  assert.equal(convertedDocument.derivedFromDocumentId, confirmedBody.document.id);
  assert.equal(convertedDocument.items[0].quantity, 12);
  assert.equal(convertedDocument.items[0].material, "6061-T6", "Material must survive document conversion");
  assert.equal(convertedDocument.items[0].finish, "Anodized", "Finish must survive document conversion");

  const confirmedDelete = await request(`/api/trade-document-imports/${analysis.id}`, admin, { method: "DELETE" });
  assert.equal(confirmedDelete.status, 409, "confirmed source audit must not be deletable");

  console.log(JSON.stringify({ ok: true, analysisId: analysis.id, documentId: confirmedBody.document.id, convertedId: convertedDocument.id, confidence: analysis.confidence, items: analysis.extractedDocument.items.length }));
} finally {
  server.close();
  if (createdAnalysisId) {
    const importsDir = path.resolve(process.env.GOODJOB_UPLOADS_DIR?.trim() || path.resolve(process.cwd(), "uploads"), ".trade-document-imports");
    await rm(path.join(importsDir, `${createdAnalysisId}.xlsx`), { force: true }).catch(() => undefined);
  }
  if (secondAnalysisId) {
    const importsDir = path.resolve(process.env.GOODJOB_UPLOADS_DIR?.trim() || path.resolve(process.cwd(), "uploads"), ".trade-document-imports");
    await rm(path.join(importsDir, `${secondAnalysisId}.xlsx`), { force: true }).catch(() => undefined);
  }
  if (csvAnalysisId) {
    const importsDir = path.resolve(process.env.GOODJOB_UPLOADS_DIR?.trim() || path.resolve(process.cwd(), "uploads"), ".trade-document-imports");
    await rm(path.join(importsDir, `${csvAnalysisId}.csv`), { force: true }).catch(() => undefined);
  }
  if (pdfAnalysisId) {
    const importsDir = path.resolve(process.env.GOODJOB_UPLOADS_DIR?.trim() || path.resolve(process.cwd(), "uploads"), ".trade-document-imports");
    await rm(path.join(importsDir, `${pdfAnalysisId}.pdf`), { force: true }).catch(() => undefined);
  }
}
