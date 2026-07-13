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

  const superAdmin = await login("super@goodjob.com", "goodjob123");
  const tenantSuffix = Date.now();
  const tenantTeamId = `security-beta-${tenantSuffix}`;
  const tenantAdminEmail = `security-admin-${tenantSuffix}@example.com`;
  const tenantAdminPassword = "Security-admin-123";
  const createdTenantAdmin = await request("/api/accounts", {
    method: "POST",
    headers: bearer(superAdmin.json.token),
    body: JSON.stringify({
      name: "Security Beta Admin",
      email: tenantAdminEmail,
      password: tenantAdminPassword,
      role: "admin",
      teamId: tenantTeamId
    })
  });
  if (!createdTenantAdmin.response.ok) throw new Error("tenant administrator creation failed");
  const duplicateTenantAdmin = await request("/api/accounts", {
    method: "POST",
    headers: bearer(superAdmin.json.token),
    body: JSON.stringify({
      name: "Duplicate Security Beta Admin",
      email: `security-admin-duplicate-${tenantSuffix}@example.com`,
      password: tenantAdminPassword,
      role: "admin",
      teamId: tenantTeamId
    })
  });
  await expectStatus("one administrator per tenant", duplicateTenantAdmin.response.status, 409);
  const tenantAdmin = await login(tenantAdminEmail, tenantAdminPassword);
  const tempEmail = `security-sales-${tenantSuffix}@example.com`;
  const tempPassword = "Security-old-123";
  const createdAccount = await request("/api/accounts", {
    method: "POST",
    headers: bearer(tenantAdmin.json.token),
    body: JSON.stringify({ name: "Security Beta Sales", email: tempEmail, password: tempPassword, role: "sales", teamId: "forged-team" })
  });
  if (!createdAccount.response.ok) throw new Error("temporary account creation failed");
  if (createdAccount.json.account.teamId !== tenantTeamId) {
    throw new Error("tenant administrator must not choose another team for a new account");
  }
  const tempUserId = createdAccount.json.account.id;
  const tempUser = await login(tempEmail, tempPassword);

  const tenantCustomer = await request("/api/customers", {
    method: "POST",
    headers: bearer(tempUser.json.token),
    body: JSON.stringify({ company: `Security Beta Customer ${Date.now()}`, country: "SG", contact: "Tester", stage: "询盘", amount: 100 })
  });
  if (!tenantCustomer.response.ok) throw new Error("temporary tenant customer creation failed");

  const isolationMarker = `TENANT-B-${tenantSuffix}`;
  const cloneSeed = <T extends object>(items: T[], overrides: Partial<T>) => {
    if (!items[0]) throw new Error("tenant isolation test requires seeded data");
    return { ...items[0], ...overrides } as T;
  };
  const tenantLeadId = `lead_${tenantSuffix}`;
  const tenantDealId = `deal_${tenantSuffix}`;
  const tenantReminderId = `reminder_${tenantSuffix}`;
  const tenantDocumentId = `document_${tenantSuffix}`;
  const tenantProblemId = `problem_${tenantSuffix}`;
  const tenantCompetitorId = `competitor_${tenantSuffix}`;
  const tenantCaseId = `case_${tenantSuffix}`;
  const tenantKnowledgeId = `knowledge_${tenantSuffix}`;
  const tenantExamId = `exam_${tenantSuffix}`;
  const tenantExamQuestionId = `question_${tenantSuffix}`;
  const tenantWebsiteId = `website_${tenantSuffix}`;
  const tenantWecomId = `wecom_${tenantSuffix}`;
  const tenantCommissionProductId = `commission_product_${tenantSuffix}`;
  const tenantSalesRecordId = `sales_record_${tenantSuffix}`;
  const tenantCalculationId = `calculation_${tenantSuffix}`;
  const tenantImportJobId = `import_job_${tenantSuffix}`;
  const tenantWhatsAppBindingId = `whatsapp_binding_${tenantSuffix}`;
  const tenantWhatsAppMessageId = `whatsapp_message_${tenantSuffix}`;

  store.leads.unshift(cloneSeed(store.leads, {
    id: tenantLeadId,
    company: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId,
    convertedCustomerId: "",
    convertedDealId: ""
  }));
  store.deals.unshift(cloneSeed(store.deals, {
    id: tenantDealId,
    customerId: tenantCustomer.json.customer.id,
    title: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId
  }));
  store.reminders.unshift(cloneSeed(store.reminders, {
    id: tenantReminderId,
    title: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId,
    targetOwnerId: tempUserId
  }));
  store.tradeDocuments.unshift(cloneSeed(store.tradeDocuments, {
    id: tenantDocumentId,
    customerId: tenantCustomer.json.customer.id,
    dealId: tenantDealId,
    title: isolationMarker,
    number: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId
  }));
  store.problems.unshift(cloneSeed(store.problems, {
    id: tenantProblemId,
    title: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId
  }));
  store.competitors.unshift(cloneSeed(store.competitors, {
    id: tenantCompetitorId,
    company: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId
  }));
  store.caseStudies.unshift(cloneSeed(store.caseStudies, {
    id: tenantCaseId,
    title: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId
  }));
  store.knowledgeAssets.unshift(cloneSeed(store.knowledgeAssets, {
    id: tenantKnowledgeId,
    title: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId,
    status: "published"
  }));
  store.examQuestions.unshift(cloneSeed(store.examQuestions, {
    id: tenantExamQuestionId,
    stem: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId
  }));
  store.exams.unshift(cloneSeed(store.exams, {
    id: tenantExamId,
    title: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId,
    status: "published"
  }));
  store.examQuestionLinks.unshift({ examId: tenantExamId, questionId: tenantExamQuestionId, sortOrder: 1 });
  store.websiteOpportunities.unshift(cloneSeed(store.websiteOpportunities, {
    id: tenantWebsiteId,
    company: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId
  }));
  store.wecomMessages.unshift(cloneSeed(store.wecomMessages, {
    id: tenantWecomId,
    summary: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId
  }));
  store.commissionProducts.unshift(cloneSeed(store.commissionProducts, {
    id: tenantCommissionProductId,
    name: isolationMarker,
    ownerId: tempUserId,
    teamId: tenantTeamId
  }));
  const tenantNow = new Date().toISOString();
  store.monthlySalesRecords.unshift({
    id: tenantSalesRecordId,
    month: tenantNow.slice(0, 7),
    ownerId: tempUserId,
    teamId: tenantTeamId,
    customerId: tenantCustomer.json.customer.id,
    customerName: isolationMarker,
    dealId: tenantDealId,
    productId: tenantCommissionProductId,
    productName: isolationMarker,
    quantity: 1,
    unitPrice: 100,
    salesAmount: 100,
    currency: "USD",
    exchangeRate: 7,
    exchangeRateDate: tenantNow.slice(0, 10),
    exchangeRateSource: "manual",
    settlementCurrency: "CNY",
    settlementAmount: 700,
    basisType: "receipt",
    basisDate: tenantNow.slice(0, 10),
    dealArchivedAt: tenantNow,
    sourceType: "manual",
    status: "draft",
    edited: false,
    editNote: "",
    lastEditedBy: tempUserId,
    lastEditedAt: tenantNow,
    createdAt: tenantNow,
    updatedAt: tenantNow
  });
  store.commissionCalculations.unshift({
    id: tenantCalculationId,
    month: tenantNow.slice(0, 7),
    ownerId: tempUserId,
    teamId: tenantTeamId,
    salesAmount: 100,
    autoCommission: 5,
    manualAdjustment: 0,
    finalCommission: 5,
    status: "calculated",
    version: 1,
    isCurrent: true,
    calculatedAt: tenantNow,
    reviewedBy: "",
    reviewedAt: "",
    lockedBy: "",
    lockedAt: "",
    unlockReason: ""
  });
  store.importExportJobs.unshift(cloneSeed(store.importExportJobs, {
    id: tenantImportJobId,
    name: isolationMarker,
    operatorId: tempUserId
  }));
  store.whatsappBindings.unshift(cloneSeed(store.whatsappBindings, {
    id: tenantWhatsAppBindingId,
    customerId: tenantCustomer.json.customer.id,
    phoneNumber: `+852${String(tenantSuffix).slice(-8)}`,
    waProfileName: isolationMarker,
    userId: tempUserId,
    sessionData: `wa_${tenantSuffix}`
  }));
  store.whatsappMessages.unshift(cloneSeed(store.whatsappMessages, {
    id: tenantWhatsAppMessageId,
    customerId: tenantCustomer.json.customer.id,
    content: isolationMarker,
    contentTranslated: isolationMarker,
    waMessageId: `wa_message_${tenantSuffix}`
  }));

  const tenantListChecks: Array<[string, string]> = [
    ["/api/leads", "leads"],
    ["/api/deals", "deals"],
    ["/api/reminders", "reminders"],
    ["/api/import-export/jobs", "import/export jobs"],
    ["/api/trade-documents", "trade documents"],
    ["/api/wecom/messages", "WeCom messages"],
    ["/api/tools/website-opportunities", "website opportunities"],
    ["/api/whatsapp/threads", "WhatsApp threads"],
    ["/api/problems", "problems"],
    ["/api/competitors", "competitors"],
    ["/api/case-studies", "case studies"],
    ["/api/knowledge/assets", "knowledge assets"],
    ["/api/exams", "exams"],
    ["/api/commission/products", "commission products"],
    ["/api/commission/sales-records", "commission sales records"],
    ["/api/commission/calculations", "commission calculations"],
    ["/api/dashboard/summary", "dashboard"],
    ["/api/reports/executive", "executive report"]
  ];
  for (const [path, label] of tenantListChecks) {
    const result = await request(path, { headers: bearer(admin.json.token) });
    if (!result.response.ok) throw new Error(`${label} tenant isolation request failed`);
    if (JSON.stringify(result.json).includes(isolationMarker)) {
      throw new Error(`${label} leaked another tenant's data`);
    }
  }

  const tenantMutationChecks: Array<[string, RequestInit, string]> = [
    [`/api/leads/${tenantLeadId}`, { method: "PATCH", body: JSON.stringify({ remark: "cross-team" }) }, "lead"],
    [`/api/deals/${tenantDealId}/archive`, { method: "POST", body: "{}" }, "deal"],
    [`/api/reminders/${tenantReminderId}`, { method: "PATCH", body: JSON.stringify({ title: "cross-team" }) }, "reminder"],
    [`/api/trade-documents/${tenantDocumentId}/approve`, { method: "POST", body: "{}" }, "trade document"],
    [`/api/problems/${tenantProblemId}/status`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }, "problem"],
    [`/api/competitors/${tenantCompetitorId}/threat`, { method: "PATCH", body: JSON.stringify({ threatLevel: "low" }) }, "competitor"],
    [`/api/case-studies/${tenantCaseId}/publish`, { method: "PATCH", body: "{}" }, "case study"],
    [`/api/knowledge/assets/${tenantKnowledgeId}/publish`, { method: "PATCH", body: "{}" }, "knowledge asset"],
    [`/api/exams/${tenantExamId}/publish`, { method: "PATCH", body: "{}" }, "exam"],
    [`/api/commission/products/${tenantCommissionProductId}`, { method: "PATCH", body: JSON.stringify({ name: "cross-team" }) }, "commission product"],
    [`/api/wecom/messages/${tenantWecomId}/archive`, { method: "POST", body: "{}" }, "WeCom message"],
    [`/api/prospect-list/${tenantWebsiteId}/details`, {
      method: "PATCH",
      body: JSON.stringify({ company: "cross-team", business: "", country: "", website: "https://example.com", contact: "", contactInfo: "", description: "" })
    }, "website opportunity"]
  ];
  for (const [path, options, label] of tenantMutationChecks) {
    const result = await request(path, { ...options, headers: bearer(admin.json.token) });
    await expectStatus(`cross-tenant ${label} mutation`, result.response.status, 404);
  }
  results.crossModuleTenantIsolation = tenantListChecks.length;

  const manager = await login("alex@goodjob.com", "goodjob123");
  const managerCustomers = await request("/api/customers", { headers: bearer(manager.json.token) });
  if (managerCustomers.json.customers?.some((customer: { id: string }) => customer.id === tenantCustomer.json.customer.id)) {
    throw new Error("manager must not see another team's customer");
  }
  const managerCrossUpdate = await request(`/api/customers/${tenantCustomer.json.customer.id}`, {
    method: "PATCH",
    headers: bearer(manager.json.token),
    body: JSON.stringify({ contact: "Cross-team manager" })
  });
  await expectStatus("manager cross-team update", managerCrossUpdate.response.status, 404);
  const adminAccounts = await request("/api/accounts", { headers: bearer(admin.json.token) });
  if (adminAccounts.json.accounts?.some((account: { id: string }) => account.id === tempUserId || account.id === createdTenantAdmin.json.account.id)) {
    throw new Error("tenant administrator account list leaked another tenant");
  }
  const crossTenantPassword = await request(`/api/accounts/${tempUserId}/password`, {
    method: "PATCH",
    headers: bearer(admin.json.token),
    body: JSON.stringify({ password: "Cross-tenant-password-123" })
  });
  await expectStatus("cross-tenant account management", crossTenantPassword.response.status, 404);
  const tenantAdminCreatesAdmin = await request("/api/accounts", {
    method: "POST",
    headers: bearer(tenantAdmin.json.token),
    body: JSON.stringify({
      name: "Forbidden Tenant Admin",
      email: `forbidden-admin-${tenantSuffix}@example.com`,
      password: tenantAdminPassword,
      role: "admin",
      teamId: `forbidden-${tenantSuffix}`
    })
  });
  await expectStatus("tenant admin cannot create admin", tenantAdminCreatesAdmin.response.status, 403);
  const superAccounts = await request("/api/accounts", { headers: bearer(superAdmin.json.token) });
  if (!superAccounts.json.accounts?.some((account: { id: string }) => account.id === tempUserId)
    || !superAccounts.json.accounts?.some((account: { id: string }) => account.id === createdTenantAdmin.json.account.id)) {
    throw new Error("super administrator must retain global account visibility");
  }
  results.managerTeamIsolated = true;
  results.tenantAccountsIsolated = true;

  const changedPassword = "Security-new-456";
  const passwordChanged = await request(`/api/accounts/${tempUserId}/password`, {
    method: "PATCH",
    headers: bearer(tenantAdmin.json.token),
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
    headers: bearer(tenantAdmin.json.token)
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
