import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start development email test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  return { response, json: await response.json() };
}

const store = getStore();
const config = store.aiModelConfigs.find((item) => item.ownerId === "u_sales_shirley");
const originalConfig = config ? structuredClone(config) : null;

try {
  const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "shirley@goodjob.com", password: "goodjob123" }) });
  assert.equal(login.response.ok, true);
  const authorization = `Bearer ${String(login.json.token || "")}`;
  assert.ok(config);
  Object.assign(config, { baseUrl: "http://127.0.0.1:1/v1", apiKey: "configured-but-unreachable-test-key", enabled: true, useEmailDraft: true });

  const scenarios = ["first_touch", "daily_contact", "holiday_greeting", "new_product", "custom_goal"] as const;
  const subjects = new Set<string>();
  for (const scenario of scenarios) {
    const draft = await request("/api/development-email/draft", { method: "POST", headers: { authorization }, body: JSON.stringify({ entityType: "lead", entityId: "l1", scenario, requireAi: false }) });
    assert.equal(draft.response.ok, true, `${scenario} base template must not call the configured AI model`);
    assert.equal(draft.json.readiness.aiReady, true);
    assert.equal(draft.json.readiness.aiGenerated, false);
    assert.equal(draft.json.draft.engine, "基础模板");
    assert.ok(String(draft.json.draft.body || "").length >= 10);
    subjects.add(String(draft.json.draft.subject || ""));
  }
  assert.equal(subjects.size, scenarios.length, "each writing scenario must provide a distinct base subject");
  const explicitAi = await request("/api/development-email/draft", { method: "POST", headers: { authorization }, body: JSON.stringify({ entityType: "lead", entityId: "l1", scenario: "custom_goal", goal: "Invite the customer to a short video meeting", requireAi: true }) });
  assert.equal(explicitAi.response.status, 400, "only an explicit AI request may reach the configured model");
  console.log(JSON.stringify({ ok: true, scenarios: scenarios.length }));
} finally {
  if (config && originalConfig) Object.assign(config, originalConfig);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
