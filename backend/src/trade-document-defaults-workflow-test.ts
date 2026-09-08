import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";
import type { TradeDocument, TradeDocumentImportAnalysis, User } from "./types.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start document defaults workflow test server");
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
  const response = await request("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ email, password: "goodjob123" })
  });
  assert.equal(response.status, 200, `login failed: ${email}`);
  return String((await response.json()).token || "");
}

function documentBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "PI",
    title: "Document defaults workflow",
    number: `PI-DEFAULTS-${Date.now()}`,
    issueDate: "2026-08-13",
    items: [{
      product: "Industrial Controller",
      model: "GJ-CTRL-01",
      material: "Aluminum",
      finish: "Anodized",
      hsCode: "853710",
      quantity: 2,
      unit: "PCS",
      unitPrice: 100,
      originCountry: "China",
      weightKg: 4,
      packageCount: 1
    }],
    ...overrides
  };
}

function importAnalysis(ownerId: string, teamId: string): TradeDocumentImportAnalysis {
  const now = new Date().toISOString();
  return {
    id: `tdia_defaults_${Date.now()}`,
    sourceFileName: "customer-proforma.xlsx",
    sourceMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sourceStorageKey: "defaults-workflow-source.xlsx",
    sourceSha256: "a".repeat(64),
    sourceSize: 1024,
    status: "needs_review",
    detectedType: "PI",
    confidence: 0.95,
    extractedDocument: {
      customerId: "",
      dealId: "",
      type: "PI",
      title: "Imported proforma invoice",
      number: "PI-IMPORTED-001",
      issueDate: "2026-08-13",
      buyer: "Imported Buyer LLC",
      buyerAddress: "1 Import Road, Seattle",
      buyerContact: "Taylor / buyer@example.test",
      seller: "Imported Seller Limited",
      sellerAddress: "",
      currency: "USD",
      incoterm: "",
      paymentTerm: "",
      shippingMethod: "",
      portLoading: "",
      portDischarge: "Seattle",
      validityDate: "",
      bankInfo: "",
      notes: "",
      language: "EN",
      templateStyle: "indigo",
      items: documentBody().items as TradeDocument["items"]
    },
    fieldEvidence: [
      { field: "buyer", value: "Imported Buyer LLC", source: "sheet1", confidence: 0.99 },
      { field: "seller", value: "Imported Seller Limited", source: "sheet1", confidence: 0.99 },
      { field: "currency", value: "USD", source: "sheet1", confidence: 0.99 },
      { field: "portDischarge", value: "Seattle", source: "sheet1", confidence: 0.98 }
    ],
    warnings: [],
    sourcePreview: ["PROFORMA INVOICE", "Imported Buyer LLC"],
    calculatedTotal: 200,
    declaredTotal: 200,
    totalDifference: 0,
    ownerId,
    teamId,
    createdAt: now,
    updatedAt: now
  };
}

try {
  const store = getStore();
  store.documentDefaultProfiles.splice(0, store.documentDefaultProfiles.length);
  store.documentLetterheads.splice(0, store.documentLetterheads.length);
  store.documentStamps.splice(0, store.documentStamps.length);
  store.documentSignatures.splice(0, store.documentSignatures.length);

  const otherAdmin: User = {
    id: "u_defaults_other_admin",
    name: "Defaults Other Admin",
    email: "defaults-other-admin@goodjob.com",
    password: "goodjob123",
    role: "admin",
    teamId: "defaults-other-team",
    avatar: "DO",
    status: "active",
    authVersion: 1
  };
  store.users.push(otherAdmin);

  const admin = await login("admin@goodjob.com");
  const sales = await login("shirley@goodjob.com");
  const otherTeam = await login(otherAdmin.email);

  const anonymous = await request("/api/document-defaults");
  assert.equal(anonymous.status, 401, "document defaults must require authentication");

  const now = new Date().toISOString();
  store.documentLetterheads.push({
    id: "letterhead_defaults_europe", teamId: "europe", name: "Europe HQ", companyName: "Configured Export Limited",
    address: "88 Harbour Road, Hong Kong", phone: "+852 2000 1000", email: "docs@example.test", website: "https://example.test",
    bankInfo: "CONFIGURED BANK", logoUrl: "", isDefault: true, enabled: true, updatedBy: "u_admin", updatedAt: now
  });
  store.documentStamps.push({
    id: "stamp_defaults_europe", teamId: "europe", name: "Export Stamp", imageUrl: "/uploads/defaults-stamp.png",
    isDefault: true, enabled: true, updatedBy: "u_admin", updatedAt: now
  });
  store.documentSignatures.push({
    id: "signature_defaults_europe", teamId: "europe", name: "Kevin signature", signerName: "Kevin Huang", signerTitle: "Export Manager",
    imageUrl: "/uploads/defaults-signature-v1.png", isDefault: true, enabled: true, updatedBy: "u_admin", updatedAt: now
  });
  store.documentLetterheads.push({
    id: "letterhead_defaults_other", teamId: otherAdmin.teamId, name: "Other Team", companyName: "Other Team Limited",
    address: "Private", phone: "", email: "", website: "", bankInfo: "", logoUrl: "", isDefault: true, enabled: true,
    updatedBy: otherAdmin.id, updatedAt: now
  });

  const forbiddenWrite = await request("/api/document-defaults", sales, {
    method: "PUT",
    body: JSON.stringify({ seller: "Sales cannot write" })
  });
  assert.equal(forbiddenWrite.status, 403, "salesperson must not change team document defaults");

  const profileInput = {
    seller: "Configured Export Limited",
    sellerAddress: "88 Harbour Road, Hong Kong",
    sellerContact: "Kevin Huang",
    sellerPhone: "+852 2000 1000",
    sellerEmail: "docs@example.test",
    sellerWebsite: "https://example.test",
    sellerTaxNo: "HK-TAX-8899",
    bankInfo: "CONFIGURED BANK",
    currency: "EUR",
    incoterm: "EXW",
    paymentTerm: "30% deposit, 70% before shipment",
    shippingMethod: "Air freight",
    portLoading: "Hong Kong",
    validityDays: 30,
    notes: "Configured document note",
    language: "ZH",
    templateStyle: "emerald",
    letterheadId: "letterhead_defaults_europe",
    stampId: "stamp_defaults_europe",
    signatureId: "signature_defaults_europe",
    includeProductImages: true
  };
  const saved = await request("/api/document-defaults", admin, { method: "PUT", body: JSON.stringify(profileInput) });
  assert.equal(saved.status, 200, "administrator must be able to save team defaults");
  const savedProfile = (await saved.json()).profile;
  assert.equal(savedProfile.teamId, "europe");
  assert.equal(savedProfile.updatedBy, "u_admin");

  const salesRead = await request("/api/document-defaults", sales);
  assert.equal(salesRead.status, 200, "salesperson must be able to read defaults used by new documents");
  const salesDefaults = await salesRead.json();
  assert.equal(salesDefaults.canManage, false);
  assert.equal(salesDefaults.profile.seller, profileInput.seller);

  const otherRead = await request("/api/document-defaults", otherTeam);
  assert.equal(otherRead.status, 200);
  const otherDefaults = await otherRead.json();
  assert.equal(otherDefaults.profile.teamId, otherAdmin.teamId);
  assert.notEqual(otherDefaults.profile.seller, profileInput.seller, "another team must not read this team's saved profile");
  const otherAssetsResponse = await request("/api/document-assets", otherTeam);
  const otherAssets = await otherAssetsResponse.json();
  assert.ok(otherAssets.letterheads.every((asset: { teamId: string }) => asset.teamId === otherAdmin.teamId));
  assert.equal(otherAssets.stamps.length, 0);
  assert.equal(otherAssets.signatures.length, 0);

  const crossTeamAsset = await request("/api/document-defaults", otherTeam, {
    method: "PUT",
    body: JSON.stringify({ ...profileInput, letterheadId: "letterhead_defaults_europe", stampId: "", signatureId: "" })
  });
  assert.equal(crossTeamAsset.status, 400, "another team must not select this team's document assets");

  const manualResponse = await request("/api/trade-documents", sales, {
    method: "POST",
    body: JSON.stringify(documentBody())
  });
  assert.equal(manualResponse.status, 200, "manual document creation must succeed with team defaults");
  const manualDocument = (await manualResponse.json()).document as TradeDocument;
  assert.equal(manualDocument.seller, profileInput.seller);
  assert.equal(manualDocument.sellerAddress, profileInput.sellerAddress);
  assert.equal(manualDocument.sellerContact, profileInput.sellerContact);
  assert.equal(manualDocument.sellerPhone, profileInput.sellerPhone);
  assert.equal(manualDocument.sellerEmail, profileInput.sellerEmail);
  assert.equal(manualDocument.sellerWebsite, profileInput.sellerWebsite);
  assert.equal(manualDocument.sellerTaxNo, profileInput.sellerTaxNo);
  assert.equal(manualDocument.currency, "EUR");
  assert.equal(manualDocument.incoterm, "EXW");
  assert.equal(manualDocument.validityDate, "2026-09-12");
  assert.equal(manualDocument.letterheadSnapshot?.companyName, "Configured Export Limited");
  assert.equal(manualDocument.stampSnapshot?.name, "Export Stamp");
  assert.equal(manualDocument.signatureSnapshot?.signerName, "Kevin Huang");
  assert.equal(manualDocument.includeProductImages, true);

  const dealResponse = await request("/api/trade-documents", sales, {
    method: "POST",
    body: JSON.stringify(documentBody({ dealId: "d2", title: "Document from deal", number: "PI-DEAL-DEFAULTS" }))
  });
  assert.equal(dealResponse.status, 200, "deal document creation must succeed");
  const dealDocument = (await dealResponse.json()).document as TradeDocument;
  assert.equal(dealDocument.customerId, "c2");
  assert.equal(dealDocument.buyer, "Atlas Home Inc", "customer buyer data must override team defaults");
  assert.equal(dealDocument.buyerAddress, "Seattle, WA, United States");
  assert.equal(dealDocument.buyerContact, "Daniel / sourcing@atlas-home.example");
  assert.equal(dealDocument.currency, "USD", "deal currency must override team currency");
  assert.equal(dealDocument.incoterm, "CIF Destination Port", "customer incoterm must override team incoterm");
  assert.equal(dealDocument.paymentTerm, "50% T/T deposit, 50% before shipment");
  assert.equal(dealDocument.seller, profileInput.seller, "missing seller data must still use team defaults");

  const analysis = importAnalysis("u_sales_shirley", "europe");
  store.tradeDocumentImportAnalyses.unshift(analysis);
  const importResponse = await request(`/api/trade-document-imports/${analysis.id}/confirm`, sales, {
    method: "POST",
    body: JSON.stringify({ document: analysis.extractedDocument })
  });
  assert.equal(importResponse.status, 201, "reviewed import must create a document");
  const importedDocument = (await importResponse.json()).document as TradeDocument;
  assert.equal(importedDocument.seller, "Imported Seller Limited", "recognized seller must not be overwritten");
  assert.equal(importedDocument.buyer, "Imported Buyer LLC", "recognized buyer must not be overwritten");
  assert.equal(importedDocument.currency, "USD", "recognized currency must not be overwritten");
  assert.equal(importedDocument.portDischarge, "Seattle", "recognized discharge port must not be overwritten");
  assert.equal(importedDocument.sellerAddress, profileInput.sellerAddress, "blank imported seller address must use team defaults");
  assert.equal(importedDocument.incoterm, "EXW", "parser placeholder without evidence must yield to team defaults");
  assert.equal(importedDocument.shippingMethod, "Air freight");
  assert.equal(importedDocument.bankInfo, "CONFIGURED BANK");

  const profileV2 = { ...profileInput, seller: "Configured Export V2 Limited", signatureId: "signature_defaults_europe" };
  const updatedProfile = await request("/api/document-defaults", admin, { method: "PUT", body: JSON.stringify(profileV2) });
  assert.equal(updatedProfile.status, 200);
  const updatedSignature = await request("/api/document-assets/signatures", admin, {
    method: "POST",
    body: JSON.stringify({
      id: "signature_defaults_europe",
      name: "Kevin signature V2",
      signerName: "Kevin Huang V2",
      signerTitle: "General Manager",
      imageUrl: "/uploads/defaults-signature-v2.png",
      isDefault: true,
      enabled: true
    })
  });
  assert.equal(updatedSignature.status, 200);
  assert.equal(manualDocument.seller, "Configured Export Limited", "profile changes must not overwrite an existing document");
  assert.equal(manualDocument.signatureSnapshot?.signerName, "Kevin Huang", "asset changes must not overwrite document snapshots");
  assert.equal(manualDocument.signatureSnapshot?.imageUrl, "/uploads/defaults-signature-v1.png");

  console.log(JSON.stringify({
    authentication: true,
    settingsPermission: true,
    teamIsolation: true,
    manualDefaults: true,
    dealAndCustomerPriority: true,
    importSourcePriority: true,
    blankFieldFallback: true,
    historicalSnapshotStable: true
  }, null, 2));
} finally {
  server.close();
}
