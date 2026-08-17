import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runConnectorDriverComplianceSuite, type ConnectorManifest } from "@goodjob/integration-connector-sdk";
import { ErpNextConnectorDriver } from "../src/drivers/erpnext-connector-driver.js";
import { EasyPostConnectorDriver } from "../src/drivers/easypost-connector-driver.js";
import { GoogleDriveConnectorDriver } from "../src/drivers/google-drive-connector-driver.js";
import type { DriverRuntimeContext } from "../src/drivers/connector-driver.js";

const requests: Array<{ method: string; path: string; authorization: string; contentType: string }> = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  let body: Record<string, unknown> = {};
  try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {}; } catch { body = {}; }
  requests.push({
    method: request.method || "GET", path: url.pathname,
    authorization: String(request.headers.authorization || ""), contentType: String(request.headers["content-type"] || "")
  });
  response.setHeader("content-type", "application/json");

  if (url.pathname === "/erp/api/method/frappe.auth.get_logged_user") return response.end(JSON.stringify({ message: "integration@example.test" }));
  if (url.pathname === "/erp/api/method/erpnext.stock.utils.get_stock_balance") return response.end(JSON.stringify({ message: 125 }));
  if (url.pathname === "/erp/api/resource/Customer") return response.end(JSON.stringify({ data: [{ name: "CUST-001", customer_name: "Acme Imports" }] }));
  if (url.pathname === "/erp/api/resource/Quotation" && request.method === "GET") return response.end(JSON.stringify({ data: [{ name: "QTN-001", customer_name: "Acme Imports", grand_total: 1200 }] }));
  if (url.pathname === "/erp/api/resource/Quotation" && request.method === "POST") return response.end(JSON.stringify({ data: { name: "QTN-NEW" } }));
  if (url.pathname === "/erp/api/resource/Quotation/QTN-001" || url.pathname === "/erp/api/resource/Quotation/QTN-NEW") return response.end(JSON.stringify({ data: { name: url.pathname.endsWith("NEW") ? "QTN-NEW" : "QTN-001", customer_name: "Acme Imports", items: [{ item_code: "LED-100", qty: 10 }] } }));
  if (url.pathname === "/erp/api/resource/Sales%20Order" && request.method === "GET") return response.end(JSON.stringify({ data: [{ name: "SO-001", customer: "CUST-001", status: "To Deliver" }] }));
  if (url.pathname === "/erp/api/resource/Sales%20Order" && request.method === "POST") return response.end(JSON.stringify({ data: { name: "SO-NEW" } }));
  if (url.pathname === "/erp/api/resource/Sales%20Order/SO-001" || url.pathname === "/erp/api/resource/Sales%20Order/SO-NEW") return response.end(JSON.stringify({ data: { name: url.pathname.endsWith("NEW") ? "SO-NEW" : "SO-001", customer: "CUST-001", items: [{ item_code: "LED-100", qty: 10 }] } }));
  if (url.pathname === "/erp/api/resource/Sales%20Invoice") return response.end(JSON.stringify({ data: [{ name: "SINV-001", outstanding_amount: 300 }] }));

  if (url.pathname === "/easy/v2/trackers" && request.method === "GET") return response.end(JSON.stringify({ trackers: [{ id: "trk_1", tracking_code: "1ZTEST", carrier: "UPS", status: "in_transit", tracking_details: [] }], has_more: false }));
  if (url.pathname === "/easy/v2/trackers" && request.method === "POST") return response.end(JSON.stringify({ id: "trk_new", tracking_code: "1ZNEW", carrier: "UPS", status: "pre_transit", tracking_details: [] }));
  if (url.pathname === "/easy/v2/trackers/trk_1") return response.end(JSON.stringify({ id: "trk_1", tracking_code: "1ZTEST", carrier: "UPS", status: "in_transit", tracking_details: [{ status: "in_transit", message: "Departed", datetime: "2026-08-07T08:00:00Z", tracking_location: { city: "Hong Kong", country: "HK" } }] }));
  if (url.pathname === "/easy/v2/trackers/trk_new") return response.end(JSON.stringify({ id: "trk_new", tracking_code: "1ZNEW", carrier: "UPS", status: "pre_transit", tracking_details: [] }));

  if (url.pathname === "/google/drive/v3/about") return response.end(JSON.stringify({ user: { displayName: "Seller", emailAddress: "seller@example.test" }, storageQuota: { usage: "100" } }));
  if (url.pathname === "/google/drive/v3/files" && request.method === "GET") return response.end(JSON.stringify({ files: [{ id: "file_1", name: "PI-001.pdf", mimeType: "application/pdf", appProperties: { goodjobCrm: "true", crmObjectId: "opp_1" } }], nextPageToken: "" }));
  if (url.pathname === "/google/drive/v3/files" && request.method === "POST") return response.end(JSON.stringify({ id: "folder_1", name: String(body.name || "Trade Docs"), mimeType: "application/vnd.google-apps.folder" }));
  if (url.pathname === "/google/upload/drive/v3/files" && request.method === "POST") return response.end(JSON.stringify({ id: "file_new", name: "PI-NEW.pdf", mimeType: "application/pdf" }));
  if (url.pathname === "/google/drive/v3/files/file_1" || url.pathname === "/google/drive/v3/files/file_new") return response.end(JSON.stringify({ id: url.pathname.endsWith("new") ? "file_new" : "file_1", name: "PI-001.pdf", mimeType: "application/pdf", appProperties: { goodjobCrm: "true" } }));
  if (url.pathname === "/google/drive/v3/files/file_1/permissions" && request.method === "POST") return response.end(JSON.stringify({ id: "perm_1", type: "user", role: "reader", emailAddress: "buyer@example.com" }));

  response.statusCode = 404;
  response.end(JSON.stringify({ error: { status: "NOT_FOUND", path: url.pathname } }));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
const port = address.port;
const common = { schemaVersion: "1.0" as const, stage: "available" as const, approvedHosts: ["127.0.0.1"], allowedPorts: [port], allowInsecureLoopback: true };

const erpContext: DriverRuntimeContext = {
  connectionId: "erp-connection", timeoutMs: 2_000, maxResponseBytes: 2_000_000,
  credentials: { apiKey: "erp-api-key", apiSecret: "erp-api-secret" }, requestId: "erp-request-1",
  manifest: { ...common, driver: "erpnext", endpoint: `http://127.0.0.1:${port}/erp/`, authentication: "api_token",
    credentialFields: [
      { key: "apiKey", label: "API Key", secret: true, minLength: 8, maxLength: 500 },
      { key: "apiSecret", label: "API Secret", secret: true, minLength: 8, maxLength: 500 }
    ], maxTools: 9 }
};
const erp = new ErpNextConnectorDriver();
assert.equal((await erp.discoverTools(erpContext)).tools.length, 9);
assert.equal(((await erp.invokeTool(erpContext, "erp.customers.search", { query: "Acme" })).structuredContent?.customers as unknown[]).length, 1);
assert.equal((await erp.invokeTool(erpContext, "erp.inventory.get_balance", { itemCode: "LED-100", warehouse: "Main" })).structuredContent?.balance, 125);
assert.equal((await erp.invokeTool(erpContext, "erp.quotations.create", {
  customer: "CUST-001", transactionDate: "2026-08-07", validTill: "2026-08-30", currency: "USD",
  items: [{ itemCode: "LED-100", qty: 10, rate: 12 }]
})).structuredContent?.readAfterWriteMatch, true);
assert.equal((await erp.invokeTool(erpContext, "erp.sales_orders.create", {
  customer: "CUST-001", deliveryDate: "2026-09-01", items: [{ itemCode: "LED-100", qty: 10, rate: 12 }]
})).structuredContent?.createdObjectId, "SO-NEW");

const easyContext: DriverRuntimeContext = {
  connectionId: "easy-connection", timeoutMs: 2_000, maxResponseBytes: 2_000_000,
  credentials: { apiKey: "EZTK_test_key" }, requestId: "easy-request-1",
  manifest: { ...common, driver: "easypost", endpoint: `http://127.0.0.1:${port}/easy/v2/`, authentication: "api_token",
    credentialFields: [{ key: "apiKey", label: "API Key", secret: true, minLength: 8, maxLength: 500 }], maxTools: 3 }
};
const easy = new EasyPostConnectorDriver();
assert.equal(((await easy.invokeTool(easyContext, "logistics.search_trackers", {})).structuredContent?.trackers as unknown[]).length, 1);
assert.equal((((await easy.invokeTool(easyContext, "logistics.get_tracking", { trackerId: "trk_1" })).structuredContent?.tracker as Record<string, unknown>).events as unknown[]).length, 1);
assert.equal((await easy.invokeTool(easyContext, "logistics.create_tracking", { trackingCode: "1ZNEW", carrier: "UPS" })).structuredContent?.readAfterWriteMatch, true);
assert.match(requests.find((item) => item.path === "/easy/v2/trackers")?.authorization || "", /^Basic /u);

const driveContext: DriverRuntimeContext = {
  connectionId: "drive-connection", timeoutMs: 2_000, maxResponseBytes: 8_000_000,
  accessToken: "drive-access-token", requestId: "drive-request-1",
  manifest: { ...common, approvedHosts: ["127.0.0.1", "accounts.google.test"], allowedPorts: [port, 443], driver: "google_drive", endpoint: `http://127.0.0.1:${port}/google/`, authentication: "oauth2",
    oauth: {
      profile: "fixed_oidc", clientId: "google-client", scopes: ["openid", "https://www.googleapis.com/auth/drive.file"],
      authorizationServerUrl: "https://accounts.google.test/", metadataUrl: "https://accounts.google.test/.well-known/openid-configuration",
      acceptedAudiences: ["google-client"], useResourceParameter: false
    }, maxTools: 5 }
};
const drive = new GoogleDriveConnectorDriver();
assert.equal(((await drive.invokeTool(driveContext, "storage.list_files", { crmObjectType: "opportunity", crmObjectId: "opp_1" })).structuredContent?.files as unknown[]).length, 1);
assert.equal((await drive.invokeTool(driveContext, "storage.create_folder", { name: "Acme Trade Docs", crmObjectType: "customer", crmObjectId: "cust_1" })).structuredContent?.createdObjectId, "folder_1");
const upload = await drive.invokeTool(driveContext, "storage.upload_trade_document", {
  name: "PI-NEW.pdf", contentType: "application/pdf", contentBase64: Buffer.from("test-pdf").toString("base64"),
  crmObjectType: "opportunity", crmObjectId: "opp_1"
});
assert.equal(upload.structuredContent?.fileId, "file_new");
assert.equal(String(upload.structuredContent?.checksum).length, 64);
assert.equal((await drive.invokeTool(driveContext, "storage.share_document", { fileId: "file_1", email: "buyer@example.com", role: "reader" })).structuredContent?.externalReceiptId, "perm_1");
assert.equal(requests.find((item) => item.path === "/google/upload/drive/v3/files")?.contentType.startsWith("multipart/related"), true);

for (const [driver, context, knownToolName, knownToolInput, maxTools] of [
  [erp, erpContext, "erp.customers.search", {}, 9],
  [easy, easyContext, "logistics.search_trackers", {}, 3],
  [drive, driveContext, "storage.list_files", {}, 5]
] as const) {
  const report = await runConnectorDriverComplianceSuite({
    driver, validManifest: context.manifest,
    invalidManifest: { ...context.manifest, endpoint: "https://unapproved.example.test/" } as ConnectorManifest,
    context, knownToolName, knownToolInput, maxTools,
    getToolNames: (value) => value.tools.map((tool) => tool.remoteName),
    validateKnownResult: (value) => assert.ok(value.structuredContent),
    isUnknownToolDenied: (error) => /INTEGRATION_TOOL_NOT_FOUND/u.test(error instanceof Error ? error.message : String(error))
  });
  assert.equal(report.ok, true);
}

assert.ok(requests.filter((item) => item.path.startsWith("/erp/")).every((item) => item.authorization === "token erp-api-key:erp-api-secret"));
assert.ok(requests.filter((item) => item.path.startsWith("/google/")).every((item) => item.authorization === "Bearer drive-access-token"));
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log("ERPNext, EasyPost and Google Drive connector tests passed");
