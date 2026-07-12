import jwt from "jsonwebtoken";
import { app } from "./server.js";
import { assertPublicHttpUrl } from "./outbound-security.js";
import { getStore } from "./store.js";

const TEST_JWT_SECRET = "goodjob-security-test-secret-at-least-32-characters";
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start security test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function cookieHeader(response: Response) {
  return response.headers.getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

function cookieValue(cookies: string, name: string) {
  return cookies.split("; ").find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

async function login(email: string, password: string) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  if (!result.response.ok) throw new Error(`login failed for ${email}`);
  return { ...result, cookies: cookieHeader(result.response) };
}

async function expectStatus(label: string, actual: number, expected: number) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

try {
  const results: Record<string, number | boolean> = {};

  const unauthenticated = await request("/api/customers");
  await expectStatus("protected endpoint", unauthenticated.response.status, 401);
  results.unauthenticated = unauthenticated.response.status;

  const malformedJson = await request("/api/auth/login", { method: "POST", body: "{\"email\":" });
  await expectStatus("malformed JSON", malformedJson.response.status, 400);
  results.malformedJson = malformedJson.response.status;

  const oversizedJson = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "nobody@example.com", password: "x", padding: "x".repeat(2 * 1024 * 1024 + 100) })
  });
  await expectStatus("oversized JSON", oversizedJson.response.status, 413);
  results.oversizedJson = oversizedJson.response.status;

  const malformedCookie = await request("/api/auth/me", { headers: { cookie: "gj_session=%E0%A4%A" } });
  await expectStatus("malformed cookie", malformedCookie.response.status, 401);
  results.malformedCookie = malformedCookie.response.status;

  const shirley = await login("shirley@goodjob.com", "goodjob123");
  const csrf = cookieValue(shirley.cookies, "gj_csrf");
  const setCookies = shirley.response.headers.getSetCookie().join("\n");
  if (!/gj_session=.*HttpOnly/i.test(setCookies) || !/SameSite=Strict/i.test(setCookies) || !csrf) {
    throw new Error("session cookie security attributes missing");
  }

  const cookieRead = await request("/api/auth/me", { headers: { cookie: shirley.cookies } });
  if (!cookieRead.response.ok || cookieRead.json.user?.id !== "u_sales_shirley") {
    throw new Error("cookie session read failed");
  }
  results.cookieSession = cookieRead.response.status;

  const docsWithoutLogin = await request("/api/docs/openapi.json");
  await expectStatus("API docs without login", docsWithoutLogin.response.status, 401);
  const docsAsSales = await request("/api/docs/openapi.json", { headers: bearer(shirley.json.token) });
  await expectStatus("API docs as salesperson", docsAsSales.response.status, 403);
  results.apiDocsProtected = true;

  const noCsrfWrite = await request("/api/todos", {
    method: "POST",
    headers: { cookie: shirley.cookies },
    body: JSON.stringify({ title: "CSRF blocked", type: "other", priority: "normal", dueAt: "今天", related: "security" })
  });
  await expectStatus("cookie write without CSRF", noCsrfWrite.response.status, 403);
  results.csrfBlocked = noCsrfWrite.response.status;

  const csrfWrite = await request("/api/todos", {
    method: "POST",
    headers: { cookie: shirley.cookies, "x-csrf-token": csrf },
    body: JSON.stringify({ title: "CSRF accepted", type: "other", priority: "normal", dueAt: "今天", related: "security" })
  });
  if (!csrfWrite.response.ok) throw new Error("cookie write with CSRF must succeed");
  results.csrfAccepted = csrfWrite.response.status;

  const tamperedToken = `${shirley.json.token.slice(0, -1)}${shirley.json.token.endsWith("a") ? "b" : "a"}`;
  const tampered = await request("/api/auth/me", { headers: bearer(tamperedToken) });
  await expectStatus("tampered token", tampered.response.status, 401);
  results.tamperedToken = tampered.response.status;

  const forgedClaimsToken = jwt.sign(
    { ver: 1, role: "super_admin", teamId: "all" },
    TEST_JWT_SECRET,
    {
      subject: "u_sales_shirley",
      issuer: "goodjob-crm",
      audience: "goodjob-crm-web",
      expiresIn: "1h",
      algorithm: "HS256"
    }
  );
  const forgedRole = await request("/api/accounts", { headers: bearer(forgedClaimsToken) });
  await expectStatus("forged role claims", forgedRole.response.status, 403);
  results.forgedRoleBlocked = forgedRole.response.status;

  const crossOwner = await request("/api/customers/c3", {
    method: "PATCH",
    headers: bearer(shirley.json.token),
    body: JSON.stringify({ contact: "Unauthorized change" })
  });
  await expectStatus("cross-sales update", crossOwner.response.status, 404);
  results.crossOwnerBlocked = crossOwner.response.status;

  const knowledge = await request("/api/knowledge/assets", { headers: bearer(shirley.json.token) });
  if (knowledge.json.assets?.some((asset: { id: string }) => asset.id === "k2")) {
    throw new Error("salesperson must not see another user's unpublished knowledge asset");
  }
  results.knowledgeIsolated = true;

  const jobs = await request("/api/import-export/jobs", { headers: bearer(shirley.json.token) });
  if (jobs.json.jobs?.some((job: { operatorId: string }) => job.operatorId !== "u_sales_shirley")) {
    throw new Error("salesperson must not see another operator's import/export jobs");
  }
  results.jobsIsolated = true;

  const examDetail = await request("/api/exams/e1/detail", { headers: bearer(shirley.json.token) });
  if (!examDetail.response.ok || examDetail.json.questions?.some((question: { answerIndex: number; answerIndexes: number[]; explanation: string }) =>
    question.answerIndex !== -1 || question.answerIndexes.length || question.explanation
  )) {
    throw new Error("exam answers must be redacted before submission");
  }
  const forgedScore = await request("/api/exams/e1/submit", {
    method: "POST",
    headers: bearer(shirley.json.token),
    body: JSON.stringify({ score: 100, answers: {} })
  });
  if (!forgedScore.response.ok || forgedScore.json.attempt?.score !== 0) {
    throw new Error("exam score must be calculated by the server");
  }
  results.examScoreProtected = true;

  const salesApproval = await request("/api/trade-documents/td_seed_pi/approve", {
    method: "POST",
    headers: bearer(shirley.json.token),
    body: "{}"
  });
  await expectStatus("sales trade-document approval", salesApproval.response.status, 403);
  results.salesApprovalBlocked = salesApproval.response.status;

  const forgedDocument = await request("/api/trade-documents", {
    method: "POST",
    headers: bearer(shirley.json.token),
    body: JSON.stringify({
      type: "PI",
      title: "Security state test",
      number: `PI-SEC-${Date.now()}`,
      issueDate: "2026-07-12",
      seller: "GoodJob",
      currency: "USD",
      incoterm: "FOB",
      status: "approved",
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: "Fake Approver",
      items: [{ product: "Test Product", quantity: 1, unitPrice: 1 }]
    })
  });
  if (!forgedDocument.response.ok || forgedDocument.json.document?.status === "approved"
    || forgedDocument.json.document?.approvedBy || forgedDocument.json.document?.approvedAt) {
    throw new Error("client must not forge trade-document approval state");
  }
  results.documentStateProtected = true;

  const store = getStore();
  store.whatsappBindings.push({
    id: "wab_security_cross_user",
    customerId: "c3",
    phoneNumber: "+819099999999",
    waProfileName: "Security",
    lastMessageAt: "",
    unreadCount: 0,
    createdAt: new Date().toISOString(),
    bindingMode: "web-scan",
    userId: "u_sales_mia",
    sessionData: "wa_web_security_cross_user",
    connectionStatus: "qr-pending"
  });
  const crossQrStatus = await request("/api/whatsapp/binding/web-scan/status/wa_web_security_cross_user", {
    headers: bearer(shirley.json.token)
  });
  await expectStatus("cross-user QR status", crossQrStatus.response.status, 404);
  results.qrSessionIsolated = true;

  for (const target of ["http://127.0.0.1:4188", "http://localhost", "http://169.254.169.254/latest/meta-data"]) {
    let blocked = false;
    try {
      await assertPublicHttpUrl(target);
    } catch {
      blocked = true;
    }
    if (!blocked) throw new Error(`SSRF target must be blocked: ${target}`);
  }
  results.ssrfBlocked = true;

  const admin = await login("admin@goodjob.com", "goodjob123");
  const docsAsAdmin = await request("/api/docs/openapi.json", { headers: bearer(admin.json.token) });
  if (!docsAsAdmin.response.ok || docsAsAdmin.json.openapi !== "3.0.3") {
    throw new Error("administrator must be able to read the OpenAPI document");
  }
  const documentedOperations = Object.values(docsAsAdmin.json.paths || {}).reduce(
    (total: number, pathItem) => total + Object.keys(pathItem as object).filter((method) =>
      ["get", "post", "put", "patch", "delete"].includes(method)
    ).length,
    0
  );
  const routeLayers: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }> = ((app as typeof app & {
    _router?: { stack?: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }> };
  })._router?.stack || []);
  const registeredOperations = routeLayers.reduce((total: number, layer) => {
    if (typeof layer.route?.path !== "string"
      || !layer.route.path.startsWith("/api/")
      || layer.route.path.startsWith("/api/docs")) return total;
    return total + Object.entries(layer.route.methods || {})
      .filter(([method, enabled]) => enabled && ["get", "post", "put", "patch", "delete"].includes(method))
      .length;
  }, 0);
  if (documentedOperations !== registeredOperations) {
    throw new Error(`OpenAPI coverage mismatch: ${documentedOperations}/${registeredOperations}`);
  }
  const docsUi = await fetch(`${baseUrl}/api/docs/`, {
    headers: { authorization: `Bearer ${admin.json.token}` }
  });
  const docsHtml = await docsUi.text();
  const docsInit = await fetch(`${baseUrl}/api/docs/swagger-ui-init.js`, {
    headers: { authorization: `Bearer ${admin.json.token}` }
  });
  const docsInitScript = await docsInit.text();
  if (!docsUi.ok || !docsHtml.includes("GoodJob CRM API 调试")
    || !docsInit.ok || !docsInitScript.includes("X-CSRF-Token")) {
    throw new Error("Swagger UI or automatic CSRF interceptor missing");
  }
  results.apiDocsOperations = documentedOperations;

  const tempEmail = `security-${Date.now()}@example.com`;
  const tempPassword = "Security-old-123";
  const createdAccount = await request("/api/accounts", {
    method: "POST",
    headers: bearer(admin.json.token),
    body: JSON.stringify({ name: "Security Asia Sales", email: tempEmail, password: tempPassword, role: "sales", teamId: "asia" })
  });
  if (!createdAccount.response.ok) throw new Error("temporary account creation failed");
  const tempUserId = createdAccount.json.account.id;
  const tempUser = await login(tempEmail, tempPassword);

  const asiaCustomer = await request("/api/customers", {
    method: "POST",
    headers: bearer(tempUser.json.token),
    body: JSON.stringify({ company: `Security Asia Customer ${Date.now()}`, country: "SG", contact: "Tester", stage: "询盘", amount: 100 })
  });
  if (!asiaCustomer.response.ok) throw new Error("temporary Asia customer creation failed");

  const manager = await login("alex@goodjob.com", "goodjob123");
  const managerCustomers = await request("/api/customers", { headers: bearer(manager.json.token) });
  if (managerCustomers.json.customers?.some((customer: { id: string }) => customer.id === asiaCustomer.json.customer.id)) {
    throw new Error("manager must not see another team's customer");
  }
  const managerCrossUpdate = await request(`/api/customers/${asiaCustomer.json.customer.id}`, {
    method: "PATCH",
    headers: bearer(manager.json.token),
    body: JSON.stringify({ contact: "Cross-team manager" })
  });
  await expectStatus("manager cross-team update", managerCrossUpdate.response.status, 404);
  results.managerTeamIsolated = true;

  const changedPassword = "Security-new-456";
  const passwordChanged = await request(`/api/accounts/${tempUserId}/password`, {
    method: "PATCH",
    headers: bearer(admin.json.token),
    body: JSON.stringify({ password: changedPassword })
  });
  if (!passwordChanged.response.ok) throw new Error("temporary password change failed");
  const oldBearerAfterPassword = await request("/api/auth/me", { headers: bearer(tempUser.json.token) });
  const oldCookieAfterPassword = await request("/api/auth/me", { headers: { cookie: tempUser.cookies } });
  await expectStatus("old bearer after password change", oldBearerAfterPassword.response.status, 401);
  await expectStatus("old cookie after password change", oldCookieAfterPassword.response.status, 401);
  const newLogin = await login(tempEmail, changedPassword);
  results.passwordInvalidatesSessions = true;

  const disabled = await request(`/api/accounts/${tempUserId}/disable`, {
    method: "PATCH",
    headers: bearer(admin.json.token)
  });
  if (!disabled.response.ok) throw new Error("temporary account disable failed");
  const bearerAfterDisable = await request("/api/auth/me", { headers: bearer(newLogin.json.token) });
  const cookieAfterDisable = await request("/api/auth/me", { headers: { cookie: newLogin.cookies } });
  const loginAfterDisable = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: tempEmail, password: changedPassword })
  });
  await expectStatus("bearer after disable", bearerAfterDisable.response.status, 401);
  await expectStatus("cookie after disable", cookieAfterDisable.response.status, 401);
  await expectStatus("login after disable", loginAfterDisable.response.status, 401);
  results.disableInvalidatesSessions = true;

  const corsBlocked = await request("/api/health", { headers: { origin: "https://attacker.example" } });
  await expectStatus("untrusted origin", corsBlocked.response.status, 403);
  results.corsBlocked = corsBlocked.response.status;

  console.log(JSON.stringify({ ok: true, ...results }, null, 2));
} finally {
  server.close();
}
