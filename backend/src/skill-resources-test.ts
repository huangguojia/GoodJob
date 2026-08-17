import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start Skill resource test server");
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
  assert.equal(result.response.status, 200);
  return String(result.json.token);
}

try {
  const manager = await login("alex@goodjob.com");
  const sales = await login("shirley@goodjob.com");
  const otherTeam = { id: "u_skill_asia_test", name: "Skill Asia", email: "skill-asia-test@goodjob.com", password: "goodjob123", role: "sales" as const, teamId: "asia", avatar: "ST", status: "active" as const, authVersion: 1 };
  getStore().users.push(otherTeam);
  const asia = await login(otherTeam.email);

  const denied = await request("/api/agent/skill-resources", sales, { method: "POST", body: JSON.stringify({ name: "Denied", summary: "Denied", downloadUrl: "https://pan.baidu.com/s/denied" }) });
  assert.equal(denied.response.status, 403);

  const created = await request("/api/agent/skill-resources", manager, { method: "POST", body: JSON.stringify({
    name: "外贸开发信 Skill", category: "客户触达", version: "1.0.0", summary: "生成并优化开发信",
    usageGuide: "安装后输入客户画像", trainingGuide: "准备正反样本并逐轮评估", optimizationAdvice: "增加行业术语集",
    acquisitionInstructions: "下载后解压到 skills 目录", downloadUrl: "https://pan.baidu.com/s/skill-resource-test", extractionCode: "s123", tags: ["开发信", "外贸"]
  }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.json.resource.status, "draft");
  const id = String(created.json.resource.id);

  const salesDraft = await request("/api/agent/skill-resources", sales);
  assert.ok(!salesDraft.json.resources.some((item: { id: string }) => item.id === id));
  const published = await request(`/api/agent/skill-resources/${id}/status`, manager, { method: "PATCH", body: JSON.stringify({ status: "published" }) });
  assert.equal(published.response.status, 200);

  const salesList = await request("/api/agent/skill-resources", sales);
  const listed = salesList.json.resources.find((item: { id: string }) => item.id === id);
  assert.ok(listed);
  assert.equal(listed.downloadUrl, "");
  assert.equal(listed.extractionCode, "");
  assert.equal(listed.downloadAvailable, true);
  const asiaList = await request("/api/agent/skill-resources", asia);
  assert.ok(!asiaList.json.resources.some((item: { id: string }) => item.id === id));

  const access = await request(`/api/agent/skill-resources/${id}/access`, sales, { method: "POST", body: "{}" });
  assert.equal(access.response.status, 200);
  assert.equal(access.json.access.url, "https://pan.baidu.com/s/skill-resource-test");
  assert.equal(access.json.access.extractionCode, "s123");
  assert.equal(access.json.resource.accessCount, 1);
  const crossTeamAccess = await request(`/api/agent/skill-resources/${id}/access`, asia, { method: "POST", body: "{}" });
  assert.equal(crossTeamAccess.response.status, 404);

  console.log({ ok: true, managerOnlyPublishing: true, teamIsolation: true, delayedLinkDisclosure: true, accessAudited: true });
} finally {
  server.close();
}
