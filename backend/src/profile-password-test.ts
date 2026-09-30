import assert from "node:assert/strict";
import { app } from "./server.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

async function login(password: string) {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@goodjob.com", password })
  });
}

try {
  const initial = await login("goodjob123");
  assert.equal(initial.response.status, 200);
  const token = String(initial.json.token);
  const headers = { authorization: `Bearer ${token}` };
  const passwordBody = (currentPassword: string, newPassword: string, confirmPassword = newPassword) =>
    JSON.stringify({ currentPassword, newPassword, confirmPassword });

  const wrong = await request("/api/profile/password", { method: "PATCH", headers, body: passwordBody("wrong-pass", "Goodjob-test-2026") });
  assert.equal(wrong.response.status, 400);
  assert.equal(wrong.json.message, "当前密码错误");

  const same = await request("/api/profile/password", { method: "PATCH", headers, body: passwordBody("goodjob123", "goodjob123") });
  assert.equal(same.response.status, 400);
  assert.equal(same.json.message, "新密码不能与当前密码相同");

  const mismatch = await request("/api/profile/password", { method: "PATCH", headers, body: passwordBody("goodjob123", "Goodjob-test-2026", "different-pass") });
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.json.message, "两次输入的新密码不一致");

  const changed = await request("/api/profile/password", { method: "PATCH", headers, body: passwordBody("goodjob123", "Goodjob-test-2026") });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.json.requiresRelogin, true);

  const oldSession = await request("/api/auth/me", { headers });
  assert.equal(oldSession.response.status, 401);
  assert.equal((await login("goodjob123")).response.status, 401);
  assert.equal((await login("Goodjob-test-2026")).response.status, 200);

  console.log(JSON.stringify({
    ok: true,
    wrongPasswordRejected: true,
    samePasswordRejected: true,
    mismatchRejected: true,
    oldSessionRevoked: true,
    oldPasswordRejected: true,
    newPasswordAccepted: true
  }, null, 2));
} finally {
  server.close();
}
