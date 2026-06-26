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
  const json = await response.json();
  return { response, json };
}

async function login(email: string) {
  const { response, json } = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "goodjob123" })
  });
  if (!response.ok) throw new Error(`login failed ${email}`);
  return json.token as string;
}

try {
  const salesToken = await login("shirley@goodjob.com");
  const managerToken = await login("alex@goodjob.com");

  const salesCustomers = await request("/api/customers", { headers: { authorization: `Bearer ${salesToken}` } });
  const managerCustomers = await request("/api/customers", { headers: { authorization: `Bearer ${managerToken}` } });
  if (salesCustomers.json.customers.length >= managerCustomers.json.customers.length) {
    throw new Error("manager should see more customers than sales");
  }

  const ocr = await request("/api/tools/ocr/jobs/ocr1/sync-lead", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!ocr.response.ok || ocr.json.lead.company !== "NorthStar Lighting GmbH") {
    throw new Error("ocr sync failed");
  }

  const deals = await request("/api/deals", { headers: { authorization: `Bearer ${managerToken}` } });
  if (deals.json.deals.length < 5) throw new Error("manager deals scope failed");

  const stage = await request("/api/deals/d1/stage", {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ stage: "谈判" })
  });
  if (!stage.response.ok || stage.json.deal.stage !== "谈判") throw new Error("deal stage update failed");

  const reminders = await request("/api/reminders", { headers: { authorization: `Bearer ${salesToken}` } });
  if (reminders.json.reminders.length < 2) throw new Error("reminders scope failed");

  const job = await request("/api/import-export/jobs", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ name: "测试导入", type: "import", rows: 3 })
  });
  if (!job.response.ok || job.json.job.name !== "测试导入") throw new Error("import job create failed");

  const exam = await request("/api/exams/e1/submit", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ score: 88 })
  });
  if (!exam.response.ok || exam.json.attempt.passed !== true) throw new Error("exam submit failed");

  console.log(JSON.stringify({
    ok: true,
    salesCustomers: salesCustomers.json.customers.length,
    managerCustomers: managerCustomers.json.customers.length,
    syncedLead: ocr.json.lead.company,
    managerDeals: deals.json.deals.length,
    importJob: job.json.job.name,
    examPassed: exam.json.attempt.passed
  }, null, 2));
} finally {
  server.close();
}
