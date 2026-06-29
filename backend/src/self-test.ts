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

  const newDeal = await request("/api/deals", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ customerId: "c1", title: "自动化新增商机", amount: 12000, nextAction: "确认采购清单" })
  });
  if (!newDeal.response.ok || newDeal.json.deal.title !== "自动化新增商机") throw new Error("deal create failed");

  const stage = await request("/api/deals/d1/stage", {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ stage: "谈判" })
  });
  if (!stage.response.ok || stage.json.deal.stage !== "谈判") throw new Error("deal stage update failed");

  const dashboard = await request("/api/dashboard/summary", { headers: { authorization: `Bearer ${salesToken}` } });
  if (!dashboard.response.ok || !dashboard.json.briefing?.title || !Array.isArray(dashboard.json.schedule)) throw new Error("dashboard summary aggregation failed");
  if (!dashboard.json.briefing?.basis || !dashboard.json.briefing?.action || !dashboard.json.briefing?.impact) throw new Error("dashboard briefing guidance failed");
  if (typeof dashboard.json.metrics?.wecomBoundRate !== "number" || typeof dashboard.json.todoInsights?.completionRate !== "number") throw new Error("dashboard metrics aggregation failed");
  if (!Array.isArray(dashboard.json.pipelineHealth) || typeof dashboard.json.pipelineHealth[0]?.count !== "number") throw new Error("pipeline health aggregation failed");
  if (!dashboard.json.priorityTasks?.[0]?.reason || typeof dashboard.json.priorityTasks?.[0]?.score !== "number") throw new Error("priority task scoring failed");

  const priorityBatch = await request("/api/dashboard/priority-tasks/batch-process", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!priorityBatch.response.ok || !Array.isArray(priorityBatch.json.created)) throw new Error("priority batch process failed");

  const reminders = await request("/api/reminders", { headers: { authorization: `Bearer ${salesToken}` } });
  if (reminders.json.reminders.length < 2) throw new Error("reminders scope failed");

  const reminder = await request("/api/reminders", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "自动化提醒规则", rule: "报价后 2 天未回复", dueAt: "今天 18:00", channel: "企业微信" })
  });
  if (!reminder.response.ok || reminder.json.reminder.title !== "自动化提醒规则") throw new Error("reminder create failed");

  const todo = await request("/api/todos", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "可撤回待办", type: "other", priority: "normal", dueAt: "现在", related: "自测" })
  });
  if (!todo.response.ok || todo.json.todo.done !== false) throw new Error("todo create failed");

  const todoDone = await request(`/api/todos/${todo.json.todo.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ done: true })
  });
  if (!todoDone.response.ok || todoDone.json.todo.done !== true) throw new Error("todo complete toggle failed");

	  const todoUndone = await request(`/api/todos/${todo.json.todo.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ done: false })
  });
	  if (!todoUndone.response.ok || todoUndone.json.todo.done !== false) throw new Error("todo undo failed");

  const todoStarted = await request(`/api/todos/${todo.json.todo.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ status: "in_progress" })
  });
  if (!todoStarted.response.ok || todoStarted.json.todo.status !== "in_progress") throw new Error("todo in-progress status failed");

  const todoOrdered = await request("/api/todos/reorder", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ ids: [todo.json.todo.id], mode: "top", targetId: todo.json.todo.id })
  });
  if (!todoOrdered.response.ok || todoOrdered.json.todos[0].pinState !== "top" || todoOrdered.json.todos[0].sortOrder !== 1) throw new Error("todo reorder failed");

  const todoDeleted = await request(`/api/todos/${todo.json.todo.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!todoDeleted.response.ok || todoDeleted.json.ok !== true) throw new Error("todo delete failed");

  const problem = await request("/api/problems", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({
      title: "自动化问题清单",
      category: "报价跟进",
      severity: "high",
      rootCause: "客户审批缺少资料",
      solution: "补齐证书并二次确认",
      nextAction: "今天完成复盘"
    })
  });
  if (!problem.response.ok || problem.json.problem.title !== "自动化问题清单") throw new Error("problem create failed");

  const resolvedProblem = await request(`/api/problems/${problem.json.problem.id}/status`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ status: "resolved" })
  });
  if (!resolvedProblem.response.ok || resolvedProblem.json.problem.status !== "resolved") throw new Error("problem status failed");

  const memo = await request("/api/memos", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "自动化备忘录", content: "记录客户临时要求", category: "客户备忘", tags: "自动化,客户" })
  });
  if (!memo.response.ok || memo.json.memo.title !== "自动化备忘录") throw new Error("memo create failed");

	  const pinnedMemo = await request(`/api/memos/${memo.json.memo.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ pinned: true })
	  });
	  if (!pinnedMemo.response.ok || pinnedMemo.json.memo.pinned !== true) throw new Error("memo pin failed");

  const deletedMemo = await request(`/api/memos/${memo.json.memo.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!deletedMemo.response.ok || deletedMemo.json.ok !== true) throw new Error("memo delete failed");

  const competitor = await request("/api/competitors", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ company: "Auto Competitor", country: "德国", segment: "电动工具", threatLevel: "high", competingProducts: "电钻套装", ourStrategy: "小批量定制" })
  });
  if (!competitor.response.ok || competitor.json.competitor.company !== "Auto Competitor") throw new Error("competitor create failed");

  const competitorThreat = await request(`/api/competitors/${competitor.json.competitor.id}/threat`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ threatLevel: "low" })
  });
  if (!competitorThreat.response.ok || competitorThreat.json.competitor.threatLevel !== "low") throw new Error("competitor threat failed");

  const caseStudy = await request("/api/case-studies", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "自动化成功案例", customer: "Nordic Tools AB", product: "工具套装", result: "拿下首单", story: "资料齐全后成交", reusablePoints: "资料先行" })
  });
  if (!caseStudy.response.ok || caseStudy.json.caseStudy.title !== "自动化成功案例") throw new Error("case study create failed");

  const publishedCase = await request(`/api/case-studies/${caseStudy.json.caseStudy.id}/publish`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!publishedCase.response.ok || publishedCase.json.caseStudy.status !== "published") throw new Error("case study publish failed");

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

  const account = await request("/api/accounts", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ name: "Auto Sales", email: `auto.${Date.now()}@goodjob.com`, role: "sales" })
  });
  if (!account.response.ok || account.json.account.name !== "Auto Sales") throw new Error("account create failed");

  const disabled = await request(`/api/accounts/${account.json.account.id}/disable`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!disabled.response.ok) throw new Error("account disable failed");

  console.log(JSON.stringify({
    ok: true,
    salesCustomers: salesCustomers.json.customers.length,
    managerCustomers: managerCustomers.json.customers.length,
    syncedLead: ocr.json.lead.company,
    managerDeals: deals.json.deals.length,
    createdDeal: newDeal.json.deal.title,
	    createdReminder: reminder.json.reminder.title,
	    todoUndo: todoUndone.json.todo.done === false,
	    problemResolved: resolvedProblem.json.problem.status,
	    memoPinned: pinnedMemo.json.memo.pinned,
    competitorThreat: competitorThreat.json.competitor.threatLevel,
    casePublished: publishedCase.json.caseStudy.status,
		    importJob: job.json.job.name,
    examPassed: exam.json.attempt.passed,
    accountCreated: account.json.account.name
  }, null, 2));
} finally {
  server.close();
}
