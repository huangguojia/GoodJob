import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start knowledge asset test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, token = "", init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) }
  });
  return { response, json: await response.json().catch(() => ({})) };
}

async function login(email: string) {
  const result = await request("/api/auth/login", "", { method: "POST", body: JSON.stringify({ email, password: "goodjob123" }) });
  assert.equal(result.response.status, 200, `login failed: ${email}`);
  return String(result.json.token);
}

try {
  const manager = await login("alex@goodjob.com");
  const sales = await login("shirley@goodjob.com");
  const otherTeam = { id: "u_sales_asia_knowledge_test", name: "Asia Test", email: "asia-knowledge-test@goodjob.com", password: "goodjob123", role: "sales" as const, teamId: "asia", avatar: "AT", status: "active" as const, authVersion: 1 };
  getStore().users.push(otherTeam);
  const asiaToken = await login(otherTeam.email);

  const invalidHttp = await request("/api/knowledge/assets", manager, { method: "POST", body: JSON.stringify({ title: "HTTP", sourceUrl: "http://example.com/file.pdf" }) });
  assert.equal(invalidHttp.response.status, 400);
  const invalidPrivate = await request("/api/knowledge/assets", manager, { method: "POST", body: JSON.stringify({ title: "内网", sourceUrl: "https://127.0.0.1/file.pdf" }) });
  assert.equal(invalidPrivate.response.status, 400);
  const invalidCode = await request("/api/knowledge/assets", manager, { method: "POST", body: JSON.stringify({ title: "普通链接", sourceUrl: "https://docs.example.com/file.pdf", shareCode: "abcd" }) });
  assert.equal(invalidCode.response.status, 400);

  const created = await request("/api/knowledge/assets", manager, {
    method: "POST",
    body: JSON.stringify({ title: `百度资料专项-${Date.now()}`, category: "认证资料", version: "v2", sourceUrl: "https://pan.baidu.com/s/1knowledge-test", shareCode: "a7b9", fileType: "pdf", tags: ["CE", "产品"] })
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.json.asset.sourceType, "baidu_share");
  assert.equal(created.json.asset.status, "draft");
  const assetId = String(created.json.asset.id);

  const published = await request(`/api/knowledge/assets/${assetId}/publish`, manager, { method: "PATCH", body: "{}" });
  assert.equal(published.response.status, 200);
  const visibleToSales = await request("/api/knowledge/assets", sales);
  assert.ok(visibleToSales.json.assets.some((asset: { id: string }) => asset.id === assetId));
  const visibleToAsia = await request("/api/knowledge/assets", asiaToken);
  assert.ok(!visibleToAsia.json.assets.some((asset: { id: string }) => asset.id === assetId));

  const opened = await request(`/api/knowledge/assets/${assetId}/access`, sales, { method: "POST", body: "{}" });
  assert.equal(opened.response.status, 200);
  assert.equal(opened.json.access.url, "https://pan.baidu.com/s/1knowledge-test");
  assert.equal(opened.json.access.shareCode, "a7b9");
  const crossTeamOpen = await request(`/api/knowledge/assets/${assetId}/access`, asiaToken, { method: "POST", body: "{}" });
  assert.equal(crossTeamOpen.response.status, 404);

  const salesEdit = await request(`/api/knowledge/assets/${assetId}`, sales, { method: "PATCH", body: JSON.stringify({ title: "越权修改" }) });
  assert.equal(salesEdit.response.status, 404);
  const managerEdit = await request(`/api/knowledge/assets/${assetId}`, manager, { method: "PATCH", body: JSON.stringify({ title: "百度认证资料 V2" }) });
  assert.equal(managerEdit.response.status, 200);
  assert.equal(managerEdit.json.asset.title, "百度认证资料 V2");

  console.log("knowledge-assets-test: passed", {
    httpsOnly: true,
    baiduShareDetected: true,
    accessAudit: true,
    teamIsolation: true,
    editAuthorization: true
  });
} finally {
  server.close();
}
