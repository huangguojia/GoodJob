import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";
import type { TradeDocument, User } from "./types.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start quote history workflow test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, token = "", init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

async function login(email: string) {
  const result = await request("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ email, password: "goodjob123" })
  });
  assert.equal(result.response.status, 200, `login failed: ${email}`);
  return String(result.json.token || "");
}

function documentBody(unitPrice = 125) {
  return {
    customerId: "c1",
    dealId: "d1",
    type: "PI",
    title: "Quote history workflow PI",
    number: `PI-QH-${Date.now()}`,
    issueDate: "2026-08-19",
    buyer: "Nordic Tools AB",
    buyerAddress: "Stockholm, Sweden",
    buyerContact: "Emma",
    seller: "GoodJob Export Limited",
    sellerAddress: "Hong Kong",
    currency: "EUR",
    incoterm: "FOB",
    paymentTerm: "30% deposit",
    shippingMethod: "Sea freight",
    portLoading: "Shanghai",
    portDischarge: "Stockholm",
    validityDate: "2026-09-19",
    bankInfo: "TEST BANK",
    notes: "isolated quote history test",
    language: "EN",
    templateStyle: "rose",
    status: "ready",
    items: [
      { product: "LED Flood Light", model: "FL-100", hsCode: "940541", quantity: 10, unit: "PCS", unitPrice, originCountry: "China", weightKg: 2, packageCount: 1 },
      { product: "LED Driver", model: "DRV-24", hsCode: "850440", quantity: 5, unit: "PCS", unitPrice: 40, originCountry: "China", weightKg: 1, packageCount: 1 }
    ]
  } satisfies Partial<TradeDocument>;
}

try {
  const store = getStore();
  store.quoteHistory.splice(0, store.quoteHistory.length);
  const otherTeamUser: User = {
    id: "u_quote_other_team",
    name: "Quote Other Team",
    email: "quote-other-team@goodjob.com",
    password: "goodjob123",
    role: "admin",
    teamId: "quote-other-team",
    avatar: "QT",
    status: "active",
    authVersion: 1
  };
  store.users.push(otherTeamUser);

  const adminToken = await login("admin@goodjob.com");
  const otherToken = await login(otherTeamUser.email);

  const anonymous = await request("/api/quote-history");
  assert.equal(anonymous.response.status, 401, "quote history must require authentication");

  const created = await request("/api/trade-documents", adminToken, { method: "POST", body: JSON.stringify(documentBody()) });
  assert.equal(created.response.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.dealSync.changed, true);
  const document = created.json.document as TradeDocument;
  const deal = store.deals.find((item) => item.id === "d1");
  assert.ok(deal);
  assert.equal(deal.currency, "EUR");
  assert.equal(deal.amount, 1450);
  assert.equal(deal.items?.length, 2);
  assert.equal(store.quoteHistory.length, 1);

  const duplicate = await request(`/api/trade-documents/${document.id}`, adminToken, { method: "PATCH", body: JSON.stringify(documentBody()) });
  assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.json));
  assert.equal(duplicate.json.dealSync.changed, false);
  assert.equal(store.quoteHistory.length, 1, "identical save must not duplicate history");

  const changed = await request(`/api/trade-documents/${document.id}`, adminToken, { method: "PATCH", body: JSON.stringify(documentBody(138)) });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.json));
  assert.equal(changed.json.dealSync.changed, true);
  assert.equal(deal.amount, 1580);
  assert.equal(store.quoteHistory.length, 2);
  assert.ok(store.quoteHistory[0].changes.some((item) => item.includes("125.00") && item.includes("138.00")), "price change must include old and new values");
  assert.ok(store.dealEvents.some((item) => item.dealId === "d1" && item.type === "quote" && item.content.includes("125.00") && item.content.includes("138.00")), "deal event must contain detailed price change");
  assert.ok(store.internalMessages.some((item) => item.relatedType === "quote_history" && item.recipientId === "u_sales_shirley" && item.content.includes("125.00") && item.content.includes("138.00")), "deal owner notification must include the key price change");

  const filtered = await request("/api/quote-history?dealId=d1&product=FL-100&currency=EUR", adminToken);
  assert.equal(filtered.response.status, 200);
  assert.equal(filtered.json.total, 2);
  assert.equal(filtered.json.summary.dealCount, 1);
  assert.equal(filtered.json.summary.productCount, 2);

  const searchableFilters = await request("/api/quote-history?customerSearch=Nordic&dealSearch=Nordic&country=%E7%91%9E", adminToken);
  assert.equal(searchableFilters.response.status, 200);
  assert.equal(searchableFilters.json.total, 2, "typed customer, deal and country filters must support partial matching");

  const productAnalysis = await request("/api/quote-history?mode=product&product=FL-100&country=%E7%91%9E%E5%85%B8", adminToken);
  assert.equal(productAnalysis.response.status, 200);
  assert.equal(productAnalysis.json.productAnalysis.totalRecords, 2);
  assert.equal(productAnalysis.json.productAnalysis.rows.length, 1);
  assert.equal(productAnalysis.json.productAnalysis.rows[0].country, "瑞典");
  assert.equal(productAnalysis.json.productAnalysis.rows[0].currency, "EUR");
  assert.equal(productAnalysis.json.productAnalysis.rows[0].minUnitPrice, 125);
  assert.equal(productAnalysis.json.productAnalysis.rows[0].maxUnitPrice, 138);
  assert.equal(productAnalysis.json.productAnalysis.rows[0].quoteCount, 2);
  assert.equal(productAnalysis.json.productAnalysis.overall.length, 1);
  assert.equal(productAnalysis.json.productAnalysis.overall[0].minUnitPrice, 125);
  assert.equal(productAnalysis.json.productAnalysis.overall[0].maxUnitPrice, 138);
  assert.equal(productAnalysis.json.productAnalysis.countryRanges.length, 1);
  assert.equal(productAnalysis.json.productAnalysis.countryRanges[0].country, "瑞典");

  deal.stage = "成交";
  deal.amountType = "won";
  const afterWon = await request("/api/quote-history?dealId=d1", adminToken);
  assert.equal(afterWon.json.total, 2, "won deal must retain full quote history");

  const isolated = await request("/api/quote-history?dealId=d1", otherToken);
  assert.equal(isolated.response.status, 200);
  assert.equal(isolated.json.total, 0, "other team must not see quote history");
  const isolatedDetail = await request(`/api/quote-history/${store.quoteHistory[0].id}`, otherToken);
  assert.equal(isolatedDetail.response.status, 404, "other team must not open quote history detail");

  console.log(JSON.stringify({ ok: true, pricingSync: true, deduplicated: true, changeAudit: true, wonRetention: true, teamIsolation: true, notification: true }));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
