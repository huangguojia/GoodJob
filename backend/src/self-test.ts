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
  const adminToken = await login("admin@goodjob.com");
  const superAdminToken = await login("super@goodjob.com");

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

  const aiConfig = await request("/api/tools/ai-config", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      name: "自动化AI解析配置",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "test-secret-1234",
      enabled: false
    })
  });
  if (!aiConfig.response.ok || aiConfig.json.config?.apiKey !== "****1234" || !aiConfig.json.config?.hasApiKey) throw new Error("ai config save failed");

  const aiConfigRead = await request("/api/tools/ai-config", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!aiConfigRead.response.ok || aiConfigRead.json.config?.apiKey !== "****1234") throw new Error("ai config read failed");

  const websitePreview = await request("/api/tools/website-scrape/preview", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ urls: ["https://example-instrument.test"] })
  });
  if (!websitePreview.response.ok || !websitePreview.json.opportunities?.[0]?.company) throw new Error("website scrape preview failed");

  const websiteSync = await request("/api/tools/website-scrape/sync-opportunities", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ opportunities: [{ ...websitePreview.json.opportunities[0], company: "自动化官网商机", business: "压力仪表" }] })
  });
  if (!websiteSync.response.ok || websiteSync.json.created?.[0]?.deal?.title !== "自动化官网商机 官网产品机会") {
    throw new Error("website opportunity sync failed");
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

  const managerDashboard = await request("/api/dashboard/summary", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!managerDashboard.response.ok || managerDashboard.json.scope !== "团队业务数据，本人待办") throw new Error("manager dashboard scope failed");
  const adminDashboard = await request("/api/dashboard/summary", { headers: { authorization: `Bearer ${adminToken}` } });
  if (!adminDashboard.response.ok || adminDashboard.json.scope !== "全局业务数据，本人待办") throw new Error("admin dashboard personal todo scope failed");

  const priorityBatch = await request("/api/dashboard/priority-tasks/batch-process", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!priorityBatch.response.ok || !Array.isArray(priorityBatch.json.created)) throw new Error("priority batch process failed");
  if (priorityBatch.json.created.some((item: { ownerId: string }) => item.ownerId !== "u_sales_shirley")) throw new Error("priority batch should create personal todos only");

  const managerTodos = await request("/api/todos", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!managerTodos.response.ok || managerTodos.json.todos.some((item: { ownerId: string }) => item.ownerId !== "u_manager_alex")) throw new Error("manager should only see own todos");
  const adminTodos = await request("/api/todos", { headers: { authorization: `Bearer ${adminToken}` } });
  if (!adminTodos.response.ok || adminTodos.json.todos.some((item: { ownerId: string }) => item.ownerId !== "u_admin")) throw new Error("admin should only see own todos");

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

  const archivedTodo = await request("/api/todos", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "自动归档待办", type: "other", priority: "normal", dueAt: "昨天 23:00", related: "归档自测" })
  });
  if (!archivedTodo.response.ok || !archivedTodo.json.todo.historyAt) throw new Error("todo should archive when due date is past");
  const restoredTodo = await request(`/api/todos/${archivedTodo.json.todo.id}/restore`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!restoredTodo.response.ok || restoredTodo.json.todo.historyAt) throw new Error("todo restore from history failed");
  await request(`/api/todos/${archivedTodo.json.todo.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });

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

  const managerMemos = await request("/api/memos", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!managerMemos.response.ok || managerMemos.json.memos.some((item: { ownerId: string }) => item.ownerId !== "u_manager_alex")) throw new Error("manager should only see own memos");
  const adminMemos = await request("/api/memos", { headers: { authorization: `Bearer ${adminToken}` } });
  if (!adminMemos.response.ok || adminMemos.json.memos.some((item: { ownerId: string }) => item.ownerId !== "u_admin")) throw new Error("admin should only see own memos");

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

  const examDetail = await request("/api/exams/e1/detail", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!examDetail.response.ok || !Array.isArray(examDetail.json.questions) || examDetail.json.questions.length < 1) {
    throw new Error("exam detail failed");
  }
  const examAnswers = Object.fromEntries(
    examDetail.json.questions.map((question: { id: string; answerIndex: number }) => [question.id, question.answerIndex])
  );
  const exam = await request("/api/exams/e1/submit", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ answers: examAnswers })
  });
  if (!exam.response.ok || exam.json.attempt.passed !== true || exam.json.attempt.score !== 100) throw new Error("exam submit failed");

  const bankQuestion = await request("/api/exam-questions", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({
      stem: "压力仪表报价前必须优先确认哪组参数？",
      category: "仪表产品",
      options: ["量程、精度、接口、介质和工况", "客户公司人数", "包装颜色", "输出信号与供电"],
      answerIndex: 0,
      answerIndexes: [0, 3],
      questionType: "multiple",
      tags: ["仪表", "报价", "多选"],
      explanation: "仪表选型先确认量程、精度、接口、介质和工况，同时关注输出信号与供电。",
      difficulty: "medium"
    })
  });
  if (!bankQuestion.response.ok || bankQuestion.json.question.tags[0] !== "仪表") throw new Error("bank question create failed");

  const importedBankQuestions = await request("/api/exam-questions/import", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({
      questions: [
        {
          stem: "Excel导入：压力表选型优先确认什么？",
          category: "仪表产品",
          options: ["量程和介质", "客户邮箱", "包装颜色"],
          answerIndex: 0,
          tags: ["导入", "压力表"],
          explanation: "压力表必须先确认量程、介质、精度和接口。",
          difficulty: "easy"
        },
        {
          stem: "Excel导入：防爆场景需要确认什么？",
          category: "仪表产品",
          options: ["防爆等级和认证", "名片颜色", "聊天工具", "使用区域"],
          answerIndex: 0,
          answerIndexes: [0, 3],
          questionType: "multiple",
          tags: ["导入", "防爆"],
          explanation: "防爆场景需要确认认证体系和等级。",
          difficulty: "hard"
        }
      ]
    })
  });
  if (!importedBankQuestions.response.ok || importedBankQuestions.json.importedCount !== 2) throw new Error("bank question import failed");

  const exportedBank = await request("/api/exam-questions/export", {
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!exportedBank.response.ok || exportedBank.json.questions.length < 3) throw new Error("bank question export failed");

  const deleteCandidate = importedBankQuestions.json.questions[0];
  const deletedBankQuestion = await request(`/api/exam-questions/${deleteCandidate.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!deletedBankQuestion.response.ok || deletedBankQuestion.json.question.id !== deleteCandidate.id) throw new Error("bank question delete failed");

  const questionIds = [bankQuestion.json.question.id, importedBankQuestions.json.questions[1].id];
  const createdExam = await request("/api/exams", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({
      title: "自动化仪表专项考试",
      category: "仪表产品",
      questionIds,
      durationMinutes: 15,
      passScore: 80,
      targetRole: "sales"
    })
  });
  if (!createdExam.response.ok || createdExam.json.exam.questionCount !== questionIds.length) throw new Error("exam create from bank failed");

  const publishedExam = await request(`/api/exams/${createdExam.json.exam.id}/publish`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!publishedExam.response.ok || publishedExam.json.exam.status !== "published") throw new Error("exam publish failed");

  const createdExamDetail = await request(`/api/exams/${createdExam.json.exam.id}/detail`, {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!createdExamDetail.response.ok || createdExamDetail.json.questions.length !== questionIds.length) throw new Error("created exam detail failed");

  const salesExamAnswers = Object.fromEntries(
    createdExamDetail.json.questions.map((question: { id: string; answerIndex: number; answerIndexes?: number[] }) => [
      question.id,
      question.answerIndexes?.length ? question.answerIndexes : question.answerIndex
    ])
  );
  const salesExamAttempt = await request(`/api/exams/${createdExam.json.exam.id}/submit`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ answers: salesExamAnswers })
  });
  if (!salesExamAttempt.response.ok || salesExamAttempt.json.attempt.score !== 100) throw new Error("multi-select exam scoring failed");

  const managerAccounts = await request("/api/accounts", {
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (managerAccounts.response.status !== 403) throw new Error("manager must not access account management");

  const accountList = await request("/api/accounts", {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  if (!accountList.response.ok || !accountList.json.accounts.some((item: { role: string }) => item.role === "super_admin")) throw new Error("admin account list failed");

  const forbiddenSuper = await request("/api/accounts", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: "Forbidden Super", email: `forbidden.super.${Date.now()}@goodjob.com`, password: "forbid123", role: "super_admin" })
  });
  if (forbiddenSuper.response.status !== 403) throw new Error("admin must not create super admin");

  const account = await request("/api/accounts", {
    method: "POST",
    headers: { authorization: `Bearer ${superAdminToken}` },
    body: JSON.stringify({ name: "Auto Sales", email: `auto.${Date.now()}@goodjob.com`, password: "start123", role: "sales" })
  });
  if (!account.response.ok || account.json.account.name !== "Auto Sales") throw new Error("account create failed");

  const passwordChanged = await request(`/api/accounts/${account.json.account.id}/password`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${superAdminToken}` },
    body: JSON.stringify({ password: "changed123" })
  });
  if (!passwordChanged.response.ok) throw new Error("account password update failed");
  const loginCreated = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: account.json.account.email, password: "changed123" })
  });
  if (!loginCreated.response.ok) throw new Error("created account password login failed");

  const disabled = await request(`/api/accounts/${account.json.account.id}/disable`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${superAdminToken}` }
  });
  if (!disabled.response.ok) throw new Error("account disable failed");

  const deleted = await request(`/api/accounts/${account.json.account.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${superAdminToken}` }
  });
  if (!deleted.response.ok || deleted.json.ok !== true) throw new Error("account delete failed");
  const loginDeleted = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: account.json.account.email, password: "changed123" })
  });
  if (loginDeleted.response.status !== 401) throw new Error("deleted account must not login");

  console.log(JSON.stringify({
    ok: true,
    salesCustomers: salesCustomers.json.customers.length,
    managerCustomers: managerCustomers.json.customers.length,
    syncedLead: ocr.json.lead.company,
    managerDeals: deals.json.deals.length,
    createdDeal: newDeal.json.deal.title,
	    createdReminder: reminder.json.reminder.title,
	    todoUndo: todoUndone.json.todo.done === false,
	    todoRestored: !restoredTodo.json.todo.historyAt,
    problemResolved: resolvedProblem.json.problem.status,
    memoPinned: pinnedMemo.json.memo.pinned,
    competitorThreat: competitorThreat.json.competitor.threatLevel,
    casePublished: publishedCase.json.caseStudy.status,
    aiConfigMasked: aiConfigRead.json.config.apiKey,
		    importJob: job.json.job.name,
    examPassed: exam.json.attempt.passed,
    examCreated: createdExam.json.exam.title,
    examPublished: publishedExam.json.exam.status,
    examImported: importedBankQuestions.json.importedCount,
    salesExamPublished: publishedExam.json.exam.status,
    multiExamScore: salesExamAttempt.json.attempt.score,
    accountCreated: account.json.account.name,
    accountPasswordLogin: loginCreated.response.ok,
    accountDeleted: deleted.json.ok,
    managerAccountForbidden: managerAccounts.response.status,
    adminSuperForbidden: forbiddenSuper.response.status
  }, null, 2));
} finally {
  server.close();
}
