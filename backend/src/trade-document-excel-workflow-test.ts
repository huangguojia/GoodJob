import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { strFromU8, unzipSync } from "fflate";
import { app } from "./server.js";
import { getStore } from "./store.js";
import type { TradeDocument, User } from "./types.js";

process.env.LIBREOFFICE_BIN ||= "soffice";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start Excel workflow test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, token = "", init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
}

async function login(email: string) {
  const response = await request("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ email, password: "goodjob123" })
  });
  assert.equal(response.status, 200, `login failed: ${email}`);
  return String((await response.json()).token || "");
}

function testDocument(id: string, ownerId: string, teamId: string, status: TradeDocument["status"] = "draft"): TradeDocument {
  return {
    id,
    customerId: "",
    dealId: "",
    revision: 1,
    type: "PI",
    title: `Excel workflow ${id}`,
    number: `PI-${id}`,
    issueDate: "2026-08-13",
    buyer: "Northstar Test Buyer",
    buyerAddress: "10 Harbor Road, London",
    buyerContact: "Ava / ava@example.test",
    seller: "GoodJob Test Seller",
    sellerAddress: "Shanghai, China",
    currency: "USD",
    incoterm: "FOB",
    paymentTerm: "30% deposit, 70% before shipment",
    shippingMethod: "Sea freight",
    portLoading: "Shanghai",
    portDischarge: "London",
    validityDate: "2026-09-13",
    bankInfo: "TEST BANK DATA",
    notes: "Excel workflow isolated test",
    language: "EN",
    templateStyle: "indigo",
    status,
    audits: [],
    sendRecords: [],
    ownerId,
    teamId,
    updatedAt: new Date().toISOString(),
    items: [{
      id: `${id}-item`,
      product: "Verification Light",
      model: "GJ-VERIFY-01",
      material: "Aluminum 6061-T6",
      finish: "Black anodized",
      hsCode: "940541",
      quantity: 3,
      unit: "PCS",
      unitPrice: 128.5,
      originCountry: "China",
      weightKg: 12,
      packageCount: 1
    }]
  };
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function packageText(files: Record<string, Uint8Array>) {
  return Object.entries(files)
    .filter(([filePath]) => filePath.endsWith(".xml") || filePath.endsWith(".rels"))
    .map(([filePath, bytes]) => `${filePath}\n${strFromU8(bytes)}`)
    .join("\n");
}

const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOUlEQVR4nO3OMQEAMAgAIOn9O1u6B3IMoiiKoiiKoiiKoiiKoiiKoiiKoiiKoiiKoiiKoiiKoiiKovgAXW8BPXoG68wAAAAASUVORK5CYII=", "base64");

function crc32(buffer: Buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}

function transparentStampPng(size = 320) {
  const center = (size - 1) / 2;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const star = Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 ? size * 0.105 : size * 0.235;
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    return [center + Math.cos(angle) * radius, center + Math.sin(angle) * radius];
  });
  const inside = (x: number, y: number) => {
    let hit = false;
    for (let left = 0, right = star.length - 1; left < star.length; right = left++) {
      const [lx, ly] = star[left];
      const [rx, ry] = star[right];
      if ((ly > y) !== (ry > y) && x < ((rx - lx) * (y - ly)) / (ry - ly) + lx) hit = !hit;
    }
    return hit;
  };
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    rows[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const painted = Math.abs(distance - size * 0.43) < size * 0.018 || Math.abs(distance - size * 0.34) < size * 0.007 || inside(x, y);
      if (!painted) continue;
      const offset = rowStart + 1 + x * 4;
      rows[offset] = 198;
      rows[offset + 1] = 40;
      rows[offset + 2] = 40;
      rows[offset + 3] = 218;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function testVariableTemplatePackage(buffer: Buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const text = packageText(files);
  for (const value of [
    "PI-variable-template",
    "Northstar Test Buyer",
    "GoodJob Export Limited",
    "Verification Light",
    "Control Enclosure",
    "Precision Bracket",
    "London",
    "GOODJOB TEST BANK"
  ]) assert.ok(text.includes(value), `generated variable template must contain ${value}`);
  for (const forbidden of ["{{", "#REF!", "#NAME?", "#VALUE!", "#DIV/0!", "2607-3753", "PT202537", "Nelly Huang", "Römerstrasse"]) {
    assert.ok(!text.includes(forbidden), `generated variable template must not contain ${forbidden}`);
  }
  const sheet1 = strFromU8(files["xl/worksheets/sheet1.xml"]);
  const sheet2 = strFromU8(files["xl/worksheets/sheet2.xml"]);
  for (const sheet of [sheet1, sheet2]) {
    assert.match(sheet, /<f>G17\*F17<\/f>/);
    assert.match(sheet, /<f>G18\*F18<\/f>/);
    assert.match(sheet, /<f>G19\*F19<\/f>/);
    assert.match(sheet, /<f>SUM\(H17:H19\)<\/f>/);
  }
  const workbookXml = strFromU8(files["xl/workbook.xml"]);
  assert.match(workbookXml, /H(?:\$|&#x24;)45/);
  assert.match(workbookXml, /H(?:\$|&#x24;)46/);
  assert.match(sheet1, /<brk id="46"/);
  assert.match(sheet2, /<brk id="47"/);
  for (const filePath of [
    "xl/styles.xml",
    "xl/theme/theme1.xml",
    "xl/drawings/drawing1.xml",
    "xl/drawings/drawing2.xml"
  ]) assert.ok(files[filePath]?.length, `generated variable template must preserve ${filePath}`);
  return files;
}

try {
  const store = getStore();
  store.teamSystemSettings.splice(0, store.teamSystemSettings.length);
  store.documentLetterheads.splice(0, store.documentLetterheads.length);
  store.documentStamps.splice(0, store.documentStamps.length);
  store.documentSignatures.splice(0, store.documentSignatures.length);
  const otherAdmin: User = {
    id: "u_excel_other_admin",
    name: "Excel Other Admin",
    email: "excel-other-admin@goodjob.com",
    password: "goodjob123",
    role: "admin",
    teamId: "excel-other-team",
    avatar: "EO",
    status: "active",
    authVersion: 1
  };
  store.users.push(otherAdmin);
  const directDocument = testDocument("default-direct", "u_sales_shirley", "europe");
  const approvalDocument = testDocument("approval-required", "u_sales_shirley", "europe");
  const variableDocument = testDocument("variable-template", "u_sales_shirley", "europe");
  variableDocument.items.push(
    {
      id: "variable-template-item-2",
      product: "Control Enclosure",
      model: "GJ-BOX-02",
      material: "ABS",
      finish: "Matte",
      hsCode: "853810",
      quantity: 7,
      unit: "PCS",
      unitPrice: 86.25,
      originCountry: "China",
      weightKg: 28,
      packageCount: 2
    },
    {
      id: "variable-template-item-3",
      product: "Precision Bracket",
      model: "GJ-BRACKET-03",
      material: "SUS304",
      finish: "Brushed",
      hsCode: "732690",
      quantity: 11,
      unit: "PCS",
      unitPrice: 19.8,
      originCountry: "China",
      weightKg: 8,
      packageCount: 1
    }
  );
  const elevenItemPiDocument = testDocument("eleven-item-pi", "u_sales_shirley", "europe");
  elevenItemPiDocument.items = Array.from({ length: 11 }, (_, index) => ({
    ...elevenItemPiDocument.items[0]!,
    id: `eleven-item-pi-${index + 1}`,
    product: `Dynamic PI Product ${index + 1}`,
    model: `DYNAMIC-${String(index + 1).padStart(2, "0")}`,
    quantity: index + 1
  }));
  store.tradeDocuments.unshift(directDocument, approvalDocument, variableDocument, elevenItemPiDocument);

  const anonymousSettings = await request("/api/system-settings");
  assert.equal(anonymousSettings.status, 401, "system settings must require authentication");

  const admin = await login("admin@goodjob.com");
  const sales = await login("shirley@goodjob.com");
  const otherTeam = await login(otherAdmin.email);

  const anonymousAssets = await request("/api/document-assets");
  assert.equal(anonymousAssets.status, 401, "document assets must require authentication");

  const invalidUpload = await request("/api/document-assets/upload", admin, {
    method: "POST",
    body: JSON.stringify({ image: Buffer.from("not-an-image").toString("base64"), mime: "image/png", kind: "stamp" })
  });
  assert.equal(invalidUpload.status, 400, "forged image mime must be rejected");

  const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources/document-templates");
  const visualOutput = process.env.GOODJOB_EXCEL_TEST_OUTPUT?.trim();
  const visualBaseFiles = unzipSync(new Uint8Array(await readFile(path.join(templateRoot, "proforma-invoice-variable-base.xlsx"))));
  const logoPng = Buffer.from(visualBaseFiles["xl/media/image1.png"]);
  const productPng = Buffer.from(unzipSync(new Uint8Array(await readFile(path.join(templateRoot, "quotation.xlsx"))))["xl/media/image10.png"]);
  const stampPng = transparentStampPng();

  const upload = async (kind: "letterhead-logo" | "stamp" | "signature" | "product", data: Buffer) => {
    const response = await request("/api/document-assets/upload", admin, {
      method: "POST",
      body: JSON.stringify({ image: data.toString("base64"), mime: "image/png", kind })
    });
    assert.equal(response.status, 200, `${kind} upload must succeed`);
    return String((await response.json()).imageUrl);
  };
  const logoUrl = await upload("letterhead-logo", logoPng);
  const stampUrl = await upload("stamp", stampPng);
  const signatureUrl = await upload("signature", tinyPng);
  const productImageUrl = await upload("product", productPng);

  const forbiddenAssetWrite = await request("/api/document-assets/letterheads", sales, {
    method: "POST",
    body: JSON.stringify({ name: "Forbidden", companyName: "Forbidden" })
  });
  assert.equal(forbiddenAssetWrite.status, 403, "salesperson must not maintain document assets");

  const letterheadResponse = await request("/api/document-assets/letterheads", admin, {
    method: "POST",
    body: JSON.stringify({ name: "Export HQ", companyName: "GoodJob Export Limited", address: "88 Harbour Road, Hong Kong", bankInfo: "GOODJOB TEST BANK", logoUrl, logoPlacement: { horizontal: "right", vertical: "bottom", offsetX: -12, offsetY: -8, scale: 125 }, isDefault: true, enabled: true })
  });
  assert.equal(letterheadResponse.status, 200);
  const letterhead = (await letterheadResponse.json()).asset;
  const stampResponse = await request("/api/document-assets/stamps", admin, {
    method: "POST",
    body: JSON.stringify({ name: "Contract Stamp", imageUrl: stampUrl, placement: { horizontal: "center", vertical: "middle", offsetX: 10, offsetY: 6, scale: 75 }, isDefault: false, enabled: true })
  });
  assert.equal(stampResponse.status, 200);
  const stamp = (await stampResponse.json()).asset;
  assert.deepEqual(letterhead.logoPlacement, { horizontal: "right", vertical: "bottom", offsetX: -12, offsetY: -8, scale: 125 });
  assert.deepEqual(stamp.placement, { horizontal: "center", vertical: "middle", offsetX: 10, offsetY: 6, scale: 75 });

  const invalidPlacementResponse = await request("/api/document-assets/stamps", admin, {
    method: "POST",
    body: JSON.stringify({ name: "Invalid stamp", imageUrl: stampUrl, placement: { horizontal: "left", vertical: "top", offsetX: 201, offsetY: 0, scale: 100 } })
  });
  assert.equal(invalidPlacementResponse.status, 400, "out-of-bounds asset placement must be rejected");
  const signatureResponse = await request("/api/document-assets/signatures", admin, {
    method: "POST",
    body: JSON.stringify({ name: "Kevin Signature", signerName: "Kevin Huang", signerTitle: "Export Manager", imageUrl: signatureUrl, isDefault: true, enabled: true })
  });
  assert.equal(signatureResponse.status, 200);
  const signature = (await signatureResponse.json()).asset;

  const product = {
    id: "prod_excel_visual", nameZh: "测试灯具", nameEn: "Visual Verification Light", model: "GJ-IMG-01", category: "Lighting", unit: "PCS", price: 168, currency: "USD", hsCode: "940541", descriptionZh: "", descriptionEn: "", tags: [], imageUrl: productImageUrl, ownerId: "u_sales_shirley", teamId: "europe", updatedAt: new Date().toISOString()
  };
  store.products.unshift(product);
  variableDocument.items.forEach((item) => { item.productId = product.id; });
  const snapshotImageDocument = testDocument("snapshot-image", "u_sales_shirley", "europe");
  snapshotImageDocument.type = "QUOTATION";
  snapshotImageDocument.includeProductImages = true;
  snapshotImageDocument.items[0]!.productId = "";
  snapshotImageDocument.items[0]!.imageUrl = productImageUrl;
  store.tradeDocuments.unshift(snapshotImageDocument);

  const templateDocument = (id: string, type: TradeDocument["type"], itemCount: number) => {
    const document = testDocument(id, "u_sales_shirley", "europe");
    document.type = type;
    document.items = variableDocument.items.slice(0, itemCount).map((item, index) => ({
      ...item,
      id: `${id}-item-${index + 1}`,
      productId: product.id
    }));
    store.tradeDocuments.unshift(document);
    return document;
  };
  const packingDocument = templateDocument("packing-assets", "PL", 3);
  const dynamicPackingDocument = templateDocument("packing-dynamic", "PL", 3);
  dynamicPackingDocument.items = Array.from({ length: 12 }, (_, index) => ({
    ...dynamicPackingDocument.items[index % dynamicPackingDocument.items.length]!,
    id: `packing-dynamic-item-${index + 1}`,
    product: `Dynamic Packing Product ${index + 1}`,
    model: `PACK-${String(index + 1).padStart(2, "0")}`,
    quantity: index + 1,
    packageCount: 1
  }));
  const quotationDocument = templateDocument("quotation-assets", "QUOTATION", 3);
  const contractDocument = templateDocument("contract-assets", "CONTRACT", 3);
  const importedCustomsDocument = templateDocument("imported-customs", "CUSTOMS", 3);
  importedCustomsDocument.importAnalysisId = "tdia_excel_imported";
  importedCustomsDocument.importSourceFileName = "customer-source.xlsx";

  const crossTeamOptions = await request(`/api/trade-documents/${variableDocument.id}/excel-options`, otherTeam, {
    method: "PATCH",
    body: JSON.stringify({ letterheadId: letterhead.id, stampId: stamp.id, signatureId: signature.id, includeProductImages: true })
  });
  assert.equal(crossTeamOptions.status, 404, "another team must not alter Excel options");

  const selectedOptions = await request(`/api/trade-documents/${variableDocument.id}/excel-options`, admin, {
    method: "PATCH",
    body: JSON.stringify({ letterheadId: letterhead.id, stampId: stamp.id, signatureId: signature.id, includeProductImages: true })
  });
  assert.equal(selectedOptions.status, 200, "valid Excel options must save");
  const selectedDocument = (await selectedOptions.json()).document as TradeDocument;
  assert.equal(selectedDocument.seller, "GoodJob Test Seller", "selecting a letterhead must not overwrite document business data");
  assert.equal(selectedDocument.letterheadSnapshot?.bankInfo, "GOODJOB TEST BANK");
  assert.deepEqual(selectedDocument.letterheadSnapshot?.logoPlacement, letterhead.logoPlacement);
  assert.equal(selectedDocument.stampSnapshot?.imageUrl, stampUrl);
  assert.deepEqual(selectedDocument.stampSnapshot?.placement, stamp.placement);
  assert.equal(selectedDocument.signatureSnapshot?.signerName, "Kevin Huang");
  assert.equal(selectedDocument.signatureSnapshot?.imageUrl, signatureUrl);

  const updateStampPlacement = await request("/api/document-assets/stamps", admin, {
    method: "POST",
    body: JSON.stringify({ ...stamp, placement: { horizontal: "left", vertical: "top", offsetX: 0, offsetY: 0, scale: 110 } })
  });
  assert.equal(updateStampPlacement.status, 200, "stamp placement update must succeed");
  assert.deepEqual(selectedDocument.stampSnapshot?.placement, { horizontal: "center", vertical: "middle", offsetX: 10, offsetY: 6, scale: 75 }, "editing an asset must not mutate an existing document snapshot");

  for (const document of [packingDocument, dynamicPackingDocument, quotationDocument, contractDocument, importedCustomsDocument]) {
    const response = await request(`/api/trade-documents/${document.id}/excel-options`, admin, {
      method: "PATCH",
      body: JSON.stringify({ letterheadId: letterhead.id, stampId: stamp.id, signatureId: signature.id, includeProductImages: true })
    });
    assert.equal(response.status, 200, `${document.type} asset options must save`);
  }

  const invalidSelection = await request(`/api/trade-documents/${directDocument.id}/excel-options`, admin, {
    method: "PATCH",
    body: JSON.stringify({ letterheadId: "missing-letterhead", stampId: "", signatureId: "", includeProductImages: false })
  });
  assert.equal(invalidSelection.status, 400, "invalid asset selection must be rejected");
  assert.equal(directDocument.letterheadId, undefined, "rejected asset selection must not partially mutate the document");

  const defaultSettingsResponse = await request("/api/system-settings", admin);
  assert.equal(defaultSettingsResponse.status, 200);
  const defaultSettings = await defaultSettingsResponse.json();
  assert.equal(defaultSettings.settings.requireDocumentExcelApproval, false, "approval must default to disabled");

  const forbiddenSettings = await request("/api/system-settings", sales, {
    method: "PUT",
    body: JSON.stringify({ requireDocumentExcelApproval: true })
  });
  assert.equal(forbiddenSettings.status, 403, "salesperson must not change team settings");

  const directExport = await request(`/api/trade-documents/${directDocument.id}/export-xlsx`, admin, {
    method: "POST",
    body: JSON.stringify({ templateId: "proforma-invoice-dual-currency" })
  });
  assert.equal(directExport.status, 200, "draft Excel must export when approval is disabled");
  const directHash = directExport.headers.get("x-goodjob-excel-sha256");
  assert.match(directHash || "", /^[a-f0-9]{64}$/);
  const directBytes = Buffer.from(await directExport.arrayBuffer());
  assert.equal(directBytes.subarray(0, 2).toString(), "PK", "download must be a valid XLSX package");
  const directFiles = unzipSync(new Uint8Array(directBytes));
  const directPackage = packageText(directFiles);
  assert.match(directPackage, /GoodJobLetterheadLogo/u, "an export without a configured logo must use the GoodJob default logo");
  assert.doesNotMatch(directPackage, /ProtoTech|Spreadsheet123|huawei|VNN\.R9/iu, "default export metadata and XML must be brand-safe");
  assert.match(strFromU8(directFiles["docProps/core.xml"]), /GoodJob CRM/u, "export metadata must identify GoodJob CRM");

  const snapshotExport = await request(`/api/trade-documents/${snapshotImageDocument.id}/export-xlsx`, admin, {
    method: "POST",
    body: JSON.stringify({ templateId: "quotation-blue" })
  });
  assert.equal(snapshotExport.status, 200, "document item image snapshot must export without a product-library id");
  const snapshotFiles = unzipSync(new Uint8Array(await snapshotExport.arrayBuffer()));
  assert.match(packageText(snapshotFiles), /GoodJobProduct1/, "snapshot image must be placed in the Excel drawing");
  assert.ok(Object.keys(snapshotFiles).some((filePath) => filePath.includes("GoodJobProduct1")), "snapshot image media must exist in the Excel package");

  const templatesResponse = await request("/api/trade-document-templates", admin);
  assert.equal(templatesResponse.status, 200);
  const templates = (await templatesResponse.json()).templates as Array<{ id: string }>;
  assert.ok(templates.some((template) => template.id === "proforma-invoice-variable-base"), "variable template must be selectable");
  assert.ok(templates.some((template) => template.id === "universal-trade-document"), "universal template must be selectable for imported documents");
  const templateCapacity = new Map((templates as Array<{ id: string; maxItems: number }>).map((template) => [template.id, template.maxItems]));
  assert.equal(templateCapacity.get("proforma-invoice-dual-currency"), 80, "fixed PI template must expose its dynamic item capacity");
  assert.equal(templateCapacity.get("proforma-invoice-variable-base"), 80, "variable PI template must expose its dynamic item capacity");
  const packingTemplate = (templates as Array<{ id: string; dynamicItems?: boolean }>).find((template) => template.id === "packing-list-sample");
  assert.equal(packingTemplate?.dynamicItems, true, "packing list must advertise dynamic item rows");

  const dynamicPackingPreview = await request(`/api/trade-documents/${dynamicPackingDocument.id}/preview-xlsx`, admin, {
    method: "POST",
    body: JSON.stringify({ templateId: "packing-list-sample" })
  });
  assert.equal(dynamicPackingPreview.status, 200, "packing list preview must accept more than three items");
  const dynamicPackingPreviewHash = dynamicPackingPreview.headers.get("x-goodjob-excel-sha256");
  const dynamicPackingPreviewBytes = Buffer.from(await dynamicPackingPreview.arrayBuffer());
  assert.equal(dynamicPackingPreviewBytes.subarray(0, 4).toString(), "%PDF");
  assert.ok(dynamicPackingPreviewBytes.length > 1_000, "dynamic packing preview must not be empty");

  const dynamicPackingExport = await request(`/api/trade-documents/${dynamicPackingDocument.id}/export-xlsx`, admin, {
    method: "POST",
    body: JSON.stringify({ templateId: "packing-list-sample" })
  });
  assert.equal(dynamicPackingExport.status, 200, "packing list export must accept more than three items");
  assert.equal(dynamicPackingExport.headers.get("x-goodjob-excel-sha256"), dynamicPackingPreviewHash, "packing preview and export must use identical XLSX bytes");
  const dynamicPackingBytes = Buffer.from(await dynamicPackingExport.arrayBuffer());
  const dynamicPackingFiles = unzipSync(new Uint8Array(dynamicPackingBytes));
  const dynamicPackingPackage = packageText(dynamicPackingFiles);
  assert.match(dynamicPackingPackage, /Dynamic Packing Product 12/, "packing list must retain the 12th item");
  assert.match(dynamicPackingPackage, /PACK-12/, "packing list must retain the 12th model");
  assert.match(strFromU8(dynamicPackingFiles["xl/worksheets/sheet1.xml"]), /<f>SUM\(F8:F19\)<\/f>/, "packing total must include every dynamic item row");
  assert.match(strFromU8(dynamicPackingFiles["xl/workbook.xml"]), /F(?:\$|&#x24;)29/, "packing print area must expand with item rows");
  assert.match(strFromU8(dynamicPackingFiles["xl/workbook.xml"]), /_xlnm\.Print_Titles/, "packing list must repeat its item header on later pages");
  const dynamicPackingDrawing = strFromU8(dynamicPackingFiles["xl/drawings/drawing1.xml"]);
  assert.match(dynamicPackingDrawing, /GoodJobProduct12/, "packing list must place the 12th product image");
  const dynamicPackingStampAnchor = [...dynamicPackingDrawing.matchAll(/<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/gu)]
    .map((match) => match[0])
    .find((anchor) => anchor.includes("GoodJobStamp")) || "";
  assert.match(dynamicPackingStampAnchor, /<xdr:row>28<\/xdr:row>/u, "packing stamp must move below expanded item rows");
  if (visualOutput) {
    await mkdir(visualOutput, { recursive: true });
    await writeFile(path.join(visualOutput, "packing-list-12-items.xlsx"), dynamicPackingBytes);
    await writeFile(path.join(visualOutput, "packing-list-12-items.pdf"), dynamicPackingPreviewBytes);
  }

  const templateCapabilities = new Map(templates.map((template: { id: string; assetCapabilities?: string[] }) => [template.id, template.assetCapabilities || []]));
  for (const templateId of ["universal-trade-document", "packing-list-sample", "proforma-invoice-dual-currency", "proforma-invoice-variable-base", "quotation-blue", "supplier-work-order-zh", "purchase-contract-blue-gray"]) {
    assert.ok(templateCapabilities.get(templateId)?.includes("letterhead"), `${templateId} must declare letterhead support`);
    assert.ok(templateCapabilities.get(templateId)?.includes("stamp"), `${templateId} must declare stamp support`);
    assert.ok(templateCapabilities.get(templateId)?.includes("signature"), `${templateId} must declare signature support`);
  }

  const originalTemplate = await readFile(path.join(templateRoot, "proforma-invoice.xlsx"));
  const variableBase = await readFile(path.join(templateRoot, "proforma-invoice-variable-base.xlsx"));
  assert.equal(sha256(originalTemplate), "7e80c636e77e9eaefc3ca3383736582f2552906b09cca53ce4ac3eea4247196b", "original PI template must remain unchanged");
  assert.notEqual(sha256(variableBase), sha256(originalTemplate), "variable base must be a separate workbook copy");
  assert.match(packageText(unzipSync(new Uint8Array(variableBase))), /\{\{document\.number\}\}/, "variable base must contain placeholders");

  const variablePreview = await request(`/api/trade-documents/${variableDocument.id}/preview-xlsx`, admin, {
    method: "POST",
    body: JSON.stringify({ templateId: "proforma-invoice-variable-base" })
  });
  assert.equal(variablePreview.status, 200, "variable template preview must succeed");
  assert.equal(variablePreview.headers.get("content-type"), "application/pdf");
  const variablePreviewHash = variablePreview.headers.get("x-goodjob-excel-sha256");
  const variablePreviewBytes = Buffer.from(await variablePreview.arrayBuffer());
  assert.equal(variablePreviewBytes.subarray(0, 4).toString(), "%PDF");
  assert.ok(variablePreviewBytes.length > 1_000, "variable template preview PDF must not be empty");

  const variableExport = await request(`/api/trade-documents/${variableDocument.id}/export-xlsx`, admin, {
    method: "POST",
    body: JSON.stringify({ templateId: "proforma-invoice-variable-base" })
  });
  assert.equal(variableExport.status, 200, "variable template export must succeed");
  assert.equal(variableExport.headers.get("x-goodjob-excel-sha256"), variablePreviewHash, "variable preview and export must use identical XLSX bytes");
  const variableBytes = Buffer.from(await variableExport.arrayBuffer());
  const variableFiles = testVariableTemplatePackage(variableBytes);
  const drawing1 = strFromU8(variableFiles["xl/drawings/drawing1.xml"]);
  const drawing2 = strFromU8(variableFiles["xl/drawings/drawing2.xml"]);
  for (const drawing of [drawing1, drawing2]) {
    assert.match(drawing, /GoodJobLetterheadLogo/);
    assert.match(drawing, /GoodJobProduct1/);
    assert.match(drawing, /GoodJobProduct2/);
    assert.match(drawing, /GoodJobProduct3/);
    assert.match(drawing, /GoodJobStamp/);
    assert.match(drawing, /GoodJobSignature/);
    const stampAnchor = [...drawing.matchAll(/<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/gu)].map((match) => match[0]).find((anchor) => anchor.includes("GoodJobStamp")) || "";
    assert.match(stampAnchor, /<xdr:col>1<\/xdr:col>/u, "custom stamp alignment must change the drawing column");
    assert.match(stampAnchor, /<xdr:ext cx="533400" cy="533400"\/>/u, "75% stamp scale must change the drawing dimensions");
  }
  assert.ok(Object.keys(variableFiles).some((filePath) => filePath.includes("GoodJobProduct1")), "product image media must exist");
  assert.ok(Object.keys(variableFiles).some((filePath) => filePath.includes("GoodJobStamp")), "stamp media must exist");
  assert.ok(Object.keys(variableFiles).some((filePath) => filePath.includes("GoodJobSignature")), "signature media must exist");
  if (visualOutput) {
    await mkdir(visualOutput, { recursive: true });
    await writeFile(path.join(visualOutput, "PI-assets-verification.xlsx"), variableBytes);
    await writeFile(path.join(visualOutput, "PI-assets-verification.pdf"), variablePreviewBytes);
  }
  const variableBaseFiles = unzipSync(new Uint8Array(variableBase));
  for (const filePath of ["xl/styles.xml", "xl/theme/theme1.xml"]) {
    assert.equal(sha256(variableFiles[filePath]), sha256(variableBaseFiles[filePath]), `${filePath} must remain byte-identical`);
  }

  for (const templateId of ["proforma-invoice-dual-currency", "proforma-invoice-variable-base"]) {
    const oversizedPreview = await request(`/api/trade-documents/${elevenItemPiDocument.id}/preview-xlsx`, admin, {
      method: "POST",
      body: JSON.stringify({ templateId })
    });
    assert.equal(oversizedPreview.status, 200, `${templateId} must preview an 11-item document`);
    const previewHash = oversizedPreview.headers.get("x-goodjob-excel-sha256");
    const previewBytes = Buffer.from(await oversizedPreview.arrayBuffer());
    assert.equal(previewBytes.subarray(0, 4).toString(), "%PDF", `${templateId} 11-item preview must be PDF`);

    const oversizedExport = await request(`/api/trade-documents/${elevenItemPiDocument.id}/export-xlsx`, admin, {
      method: "POST",
      body: JSON.stringify({ templateId })
    });
    assert.equal(oversizedExport.status, 200, `${templateId} must export an 11-item document`);
    assert.equal(oversizedExport.headers.get("x-goodjob-excel-sha256"), previewHash, `${templateId} 11-item preview and export must match`);
    const packageXml = packageText(unzipSync(new Uint8Array(await oversizedExport.arrayBuffer())));
    assert.match(packageXml, /Dynamic PI Product 11/, `${templateId} must retain the 11th item`);
    assert.match(packageXml, /DYNAMIC-11/, `${templateId} must retain the 11th item model`);
  }

  const allTemplateCases = [
    { templateId: "universal-trade-document", document: importedCustomsDocument, productImages: true, expectedPages: 1 },
    { templateId: "packing-list-sample", document: packingDocument, productImages: true, expectedPages: 1 },
    { templateId: "proforma-invoice-dual-currency", document: variableDocument, productImages: true, expectedPages: 2 },
    { templateId: "quotation-blue", document: quotationDocument, productImages: true, expectedPages: 2 },
    { templateId: "supplier-work-order-zh", document: contractDocument, productImages: true, expectedPages: 1 },
    { templateId: "purchase-contract-blue-gray", document: contractDocument, productImages: false, expectedPages: 2 }
  ];
  const allTemplateResults: Array<{ templateId: string; pdfBytes: number; xlsxBytes: number; hash: string }> = [];
  for (const testCase of allTemplateCases) {
    const previewResponse = await request(`/api/trade-documents/${testCase.document.id}/preview-xlsx`, admin, {
      method: "POST",
      body: JSON.stringify({ templateId: testCase.templateId })
    });
    assert.equal(previewResponse.status, 200, `${testCase.templateId} preview must succeed`);
    const previewBuffer = Buffer.from(await previewResponse.arrayBuffer());
    assert.equal(previewBuffer.subarray(0, 4).toString(), "%PDF", `${testCase.templateId} preview must be PDF`);
    const pageCount = [...previewBuffer.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length;
    assert.equal(pageCount, testCase.expectedPages, `${testCase.templateId} preview must preserve the template page count`);
    const previewSha = String(previewResponse.headers.get("x-goodjob-excel-sha256") || "");

    const exportResponse = await request(`/api/trade-documents/${testCase.document.id}/export-xlsx`, admin, {
      method: "POST",
      body: JSON.stringify({ templateId: testCase.templateId })
    });
    assert.equal(exportResponse.status, 200, `${testCase.templateId} export must succeed`);
    assert.equal(exportResponse.headers.get("x-goodjob-excel-sha256"), previewSha, `${testCase.templateId} preview/export XLSX must match`);
    const xlsxBuffer = Buffer.from(await exportResponse.arrayBuffer());
    const files = unzipSync(new Uint8Array(xlsxBuffer));
    const packageXml = packageText(files);
    assert.doesNotMatch(packageXml, /ProtoTech|Spreadsheet123|huawei|VNN\.R9/iu, `${testCase.templateId} must not retain legacy brand text or metadata`);
    const forbiddenLegacyMediaHashes = new Set([
      "08ca63deb4ad8ceea529c2f278c014873c8314cc54d4c179f6ff981d10c31125",
      "0528d9d88d2b57ec79d1c99a33990bce9ce14da1cdb76c27843e211e444d07b9",
      "b2a8b3ef88c6822ed5c9461b1396e21804d0f51e65c7832627bdc2234f9f176f"
    ]);
    Object.entries(files)
      .filter(([filePath]) => filePath.startsWith("xl/media/"))
      .forEach(([filePath, bytes]) => {
        assert.ok(!forbiddenLegacyMediaHashes.has(sha256(bytes)), `${testCase.templateId} must remove legacy branded media ${filePath}`);
      });
    if (["universal-trade-document", "quotation-blue"].includes(testCase.templateId)) {
      assert.match(packageXml, /Aluminum 6061-T6/, `${testCase.templateId} must export optional Material`);
      assert.match(packageXml, /Black anodized/, `${testCase.templateId} must export optional Finish`);
    }
    assert.match(packageXml, /GoodJobLetterheadLogo/, `${testCase.templateId} must contain selected letterhead logo`);
    assert.match(packageXml, /GoodJobStamp/, `${testCase.templateId} must contain selected stamp`);
    assert.match(packageXml, /GoodJobSignature/, `${testCase.templateId} must contain selected signature`);
    if (testCase.productImages) assert.match(packageXml, /GoodJobProduct1/, `${testCase.templateId} must contain selected product image`);
    else assert.ok(!packageXml.includes("GoodJobProduct1"), `${testCase.templateId} must not place products over a template without an image column`);
    assert.ok(Object.keys(files).some((filePath) => filePath.includes("GoodJobStamp")), `${testCase.templateId} stamp media must exist`);
    assert.ok(Object.keys(files).some((filePath) => filePath.includes("GoodJobSignature")), `${testCase.templateId} signature media must exist`);
    if (testCase.productImages) assert.ok(Object.keys(files).some((filePath) => filePath.includes("GoodJobProduct1")), `${testCase.templateId} product media must exist`);
    assert.ok(files["[Content_Types].xml"]?.length, `${testCase.templateId} package must contain content types`);
    if (visualOutput) {
      await writeFile(path.join(visualOutput, `${testCase.templateId}.xlsx`), xlsxBuffer);
      await writeFile(path.join(visualOutput, `${testCase.templateId}.pdf`), previewBuffer);
    }
    allTemplateResults.push({ templateId: testCase.templateId, pdfBytes: previewBuffer.length, xlsxBytes: xlsxBuffer.length, hash: previewSha });
  }

  const enabledResponse = await request("/api/system-settings", admin, {
    method: "PUT",
    body: JSON.stringify({ requireDocumentExcelApproval: true })
  });
  assert.equal(enabledResponse.status, 200);
  assert.equal((await enabledResponse.json()).settings.requireDocumentExcelApproval, true);

  const blockedExport = await request(`/api/trade-documents/${approvalDocument.id}/export-xlsx`, admin, {
    method: "POST",
    body: JSON.stringify({ templateId: "proforma-invoice-dual-currency" })
  });
  assert.equal(blockedExport.status, 409, "draft Excel must be blocked after approval is enabled");

  const preview = await request(`/api/trade-documents/${approvalDocument.id}/preview-xlsx`, sales, {
    method: "POST",
    body: JSON.stringify({ templateId: "proforma-invoice-dual-currency" })
  });
  assert.equal(preview.status, 200, "preview must remain available without approval");
  assert.equal(preview.headers.get("content-type"), "application/pdf");
  const previewHash = preview.headers.get("x-goodjob-excel-sha256");
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  assert.equal(previewBytes.subarray(0, 4).toString(), "%PDF");
  assert.ok(previewBytes.length > 1_000, "preview PDF must not be empty");
  assert.equal(approvalDocument.status, "draft", "preview must not mutate document status");

  approvalDocument.status = "approved";
  const approvedExport = await request(`/api/trade-documents/${approvalDocument.id}/export-xlsx`, admin, {
    method: "POST",
    body: JSON.stringify({ templateId: "proforma-invoice-dual-currency" })
  });
  assert.equal(approvedExport.status, 200, "approved Excel must export when approval is enabled");
  assert.equal(approvedExport.headers.get("x-goodjob-excel-sha256"), previewHash, "preview and download must use the same generated XLSX bytes");

  const otherSettingsResponse = await request("/api/system-settings", otherTeam);
  assert.equal(otherSettingsResponse.status, 200);
  const otherSettings = await otherSettingsResponse.json();
  assert.equal(otherSettings.settings.teamId, otherAdmin.teamId);
  assert.equal(otherSettings.settings.requireDocumentExcelApproval, false, "another team must retain its own default");

  const crossTeamPreview = await request(`/api/trade-documents/${approvalDocument.id}/preview-xlsx`, otherTeam, {
    method: "POST",
    body: JSON.stringify({ templateId: "proforma-invoice-dual-currency" })
  });
  assert.equal(crossTeamPreview.status, 404, "another team must not preview this team's document");

  console.log(JSON.stringify({
    defaultApprovalRequired: false,
    enabledApprovalBlocksDraft: true,
    previewBypassesApproval: true,
    previewPdfBytes: previewBytes.length,
    variablePreviewPdfBytes: variablePreviewBytes.length,
    variableTemplateExcelSha256: variablePreviewHash,
    variableTemplateItems: variableDocument.items.length,
    originalTemplateUnchanged: true,
    variableTemplateAssetsPreserved: true,
    documentAssetSecurity: true,
    documentItemImageSnapshot: true,
    assetPlacementValidation: true,
    assetPlacementSnapshotStable: true,
    assetPlacementAppliedToDrawing: true,
    letterheadStampSignatureProductImages: true,
    allTemplateResults,
    sharedExcelSha256: previewHash,
    teamIsolation: true,
    settingsPermission: true
  }, null, 2));
} finally {
  server.close();
}
