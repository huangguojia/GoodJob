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
  const miaToken = await login("mia@goodjob.com");
  const managerToken = await login("alex@goodjob.com");
  const adminToken = await login("admin@goodjob.com");
  const superAdminToken = await login("super@goodjob.com");

  const salesCustomers = await request("/api/customers", { headers: { authorization: `Bearer ${salesToken}` } });
  const managerCustomers = await request("/api/customers", { headers: { authorization: `Bearer ${managerToken}` } });
  if (salesCustomers.json.customers.length >= managerCustomers.json.customers.length) {
    throw new Error("manager should see more customers than sales");
  }

  const boundaryCompany = `隔离删除客户-${Date.now()}`;
  const boundaryCustomer = await request("/api/customers", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ company: boundaryCompany, country: "德国", contact: "Boundary Buyer", stage: "询盘", amount: 1000 })
  });
  if (!boundaryCustomer.response.ok) throw new Error("boundary customer create failed");
  const managerBoundaryTodo = await request("/api/todos", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ title: `主管跟进 ${boundaryCompany}`, type: "customer", related: boundaryCompany })
  });
  const salesBoundaryTodo = await request("/api/todos", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: `销售跟进 ${boundaryCompany}`, type: "customer", related: boundaryCompany })
  });
  if (!managerBoundaryTodo.response.ok || !salesBoundaryTodo.response.ok) throw new Error("boundary todo create failed");
  const boundaryDelete = await request("/api/customers/bulk-delete", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ ids: [boundaryCustomer.json.customer.id] })
  });
  if (!boundaryDelete.response.ok) throw new Error("boundary customer delete failed");
  const managerTodosAfterBoundaryDelete = await request("/api/todos", { headers: { authorization: `Bearer ${managerToken}` } });
  const salesTodosAfterBoundaryDelete = await request("/api/todos", { headers: { authorization: `Bearer ${salesToken}` } });
  if (!managerTodosAfterBoundaryDelete.json.todos.some((todo: { id: string }) => todo.id === managerBoundaryTodo.json.todo.id)) throw new Error("customer delete must not remove manager personal todo");
  if (salesTodosAfterBoundaryDelete.json.todos.some((todo: { id: string }) => todo.id === salesBoundaryTodo.json.todo.id)) throw new Error("customer delete should remove current user's related todo");

  const ocr = await request("/api/tools/ocr/jobs/ocr1/sync-lead", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!ocr.response.ok || ocr.json.lead.company !== "NorthStar Lighting GmbH") {
    throw new Error("ocr sync failed");
  }
  const managerOcr = await request("/api/tools/ocr/jobs/ocr1", {
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!managerOcr.response.ok || managerOcr.json.job.ownerId !== "u_manager_alex") throw new Error("manager personal ocr job failed");
  const crossOcr = await request(`/api/tools/ocr/jobs/${managerOcr.json.job.id}`, {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (crossOcr.response.status !== 404) throw new Error("ocr job must be personal isolated");

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

  const aiConfigSecond = await request("/api/tools/ai-config", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      provider: "deepseek",
      protocol: "openai-compatible",
      name: "自动化AI解析配置-第二套Key",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "test-secret-5678",
      enabled: true,
      useLeadFinder: true,
      useWebsiteParse: false,
      useScoring: false,
      useEmailDraft: true,
      useExam: false
    })
  });
  if (!aiConfigSecond.response.ok || (aiConfigSecond.json.configs || []).length < 2 || aiConfigSecond.json.config?.apiKey !== "****5678") throw new Error("ai multi config save failed");

  const aiConfigRead = await request("/api/tools/ai-config", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!aiConfigRead.response.ok || (aiConfigRead.json.configs || []).length < 2 || aiConfigRead.json.config?.apiKey !== "****5678") throw new Error("ai config read failed");

  const aiConfigDelete = await request(`/api/tools/ai-config/${aiConfig.json.config.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!aiConfigDelete.response.ok || (aiConfigDelete.json.configs || []).some((item: { id: string }) => item.id === aiConfig.json.config.id) || aiConfigDelete.json.config?.apiKey !== "****5678") throw new Error("ai config delete failed");

  const profileBind = await request("/api/profile/email-binding", {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      outboundEmail: "shirley.sender@example.com",
      emailSenderName: "Shirley Sender",
      emailSignature: "Best regards,\\nShirley Sender",
      smtpHost: "smtp.test.local",
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: "shirley.sender@example.com",
      smtpPassword: "test-smtp-password"
    })
  });
  if (!profileBind.response.ok || profileBind.json.user?.outboundEmail !== "shirley.sender@example.com" || !profileBind.json.user?.hasSmtpPassword || !profileBind.json.token) {
    throw new Error("profile email binding failed");
  }

  const profileTestMail = await request("/api/profile/test-email", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!profileTestMail.response.ok || !profileTestMail.json.ok) {
    throw new Error("profile smtp test failed");
  }

  const profileMail = await request("/api/profile/send-development-email", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      to: "buyer@example.com",
      company: "Buyer Test GmbH",
      subject: "Instrumentation supplier for your local market",
      body: "Dear Buyer Test GmbH team, we supply pressure and flow instruments for local distributors."
    })
  });
  if (!profileMail.response.ok || profileMail.json.sent?.status !== "sent" || profileMail.json.user?.lastDevelopmentEmailTo !== "buyer@example.com") {
    throw new Error("development email send failed");
  }

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

  // 自动获客数据源中心：注册表 / 保存 Key（掩码）/ 删除
  const leadProviders = await request("/api/lead-finder/providers", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  const providerList = leadProviders.json.providers || [];
  if (!leadProviders.response.ok || providerList.length < 8) throw new Error("lead providers list failed");
  const freeReady = providerList.filter((item: any) => !item.requiresKey && item.ready).length;
  const hunterMeta = providerList.find((item: any) => item.id === "hunter");
  if (freeReady < 2 || !hunterMeta || hunterMeta.tier !== "paid") throw new Error("lead providers metadata failed");
  const aiSearchMeta = providerList.find((item: any) => item.id === "ai_search");
  if (!aiSearchMeta || aiSearchMeta.tier !== "ai" || aiSearchMeta.requiresKey !== false) throw new Error("ai search source metadata failed");

  const leadSourceSave = await request("/api/lead-finder/source-config", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ provider: "serper", apiKey: "serper-secret-9911", enabled: true })
  });
  const serperStatus = (leadSourceSave.json.providers || []).find((item: any) => item.id === "serper");
  if (!leadSourceSave.response.ok || leadSourceSave.json.config?.apiKey !== "****9911" || !serperStatus?.ready || !serperStatus?.enabled) {
    throw new Error("lead source config save failed");
  }

  const leadSourceReadBack = await request("/api/lead-finder/providers", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  const serperReadBack = (leadSourceReadBack.json.providers || []).find((item: any) => item.id === "serper");
  if (!serperReadBack?.hasApiKey || !serperReadBack?.ready) throw new Error("lead source config persist failed");

  const leadSourceDelete = await request("/api/lead-finder/source-config/serper", {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  const serperAfterDelete = (leadSourceDelete.json.providers || []).find((item: any) => item.id === "serper");
  if (!leadSourceDelete.response.ok || serperAfterDelete?.hasApiKey) throw new Error("lead source config delete failed");

  const prospectMail = await request(`/api/prospect-list/${websiteSync.json.created[0].opportunity.id}/send-development-email`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      to: "prospect@example.com",
      subject: "Instrumentation supplier support",
      body: "Dear team, we can support your pressure and flow instrumentation sourcing."
    })
  });
  if (!prospectMail.response.ok || prospectMail.json.opportunity?.lastDevelopmentEmailTo !== "prospect@example.com") {
    throw new Error("prospect list development email failed");
  }

  const deals = await request("/api/deals", { headers: { authorization: `Bearer ${managerToken}` } });
  if (deals.json.deals.length < 5) throw new Error("manager deals scope failed");

  const newDeal = await request("/api/deals", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ customerId: "c1", title: "自动化新增商机", product: "自动化压力仪表", quantity: 10, unitPrice: 1200, nextAction: "确认采购清单" })
  });
  if (!newDeal.response.ok || newDeal.json.deal.title !== "自动化新增商机" || newDeal.json.deal.amount !== 12000) throw new Error("deal create failed");

  const editedDeal = await request(`/api/deals/${newDeal.json.deal.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ customerId: "c1", title: "自动化编辑商机", stage: "已联系", product: "自动化温度仪表", quantity: 12, unitPrice: 900, nextAction: "发送修订报价" })
  });
  if (!editedDeal.response.ok || editedDeal.json.deal.product !== "自动化温度仪表" || editedDeal.json.deal.amount !== 10800) throw new Error("deal edit failed");

  const wonDeal = await request(`/api/deals/${newDeal.json.deal.id}/stage`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ stage: "成交" })
  });
  if (!wonDeal.response.ok || wonDeal.json.deal.stage !== "成交") throw new Error("deal won stage failed");
  const lostAfterWon = await request(`/api/deals/${newDeal.json.deal.id}/stage`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ stage: "丢单" })
  });
  if (lostAfterWon.response.status !== 400) throw new Error("won deal should not move to lost");
  const archivedDeal = await request(`/api/deals/${newDeal.json.deal.id}/archive`, {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!archivedDeal.response.ok || !archivedDeal.json.deal.archivedAt) throw new Error("deal archive failed");

  const lostDeal = await request("/api/deals", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ customerId: "c2", title: "自动化丢单商机", product: "测试样品", quantity: 8, unitPrice: 1000, nextAction: "客户选择竞品" })
  });
  const markedLost = await request(`/api/deals/${lostDeal.json.deal.id}/lost`, {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!markedLost.response.ok || markedLost.json.deal.stage !== "丢单" || !markedLost.json.deal.archivedAt) throw new Error("deal lost failed");

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
  if (dashboard.json.pipelineHealth.some((item: { stage: string }) => item.stage === "丢单")) throw new Error("pipeline health should exclude lost deals");
  if (dashboard.json.pipelineHealth.some((item: { count: number; width: number }) => item.count === 0 && item.width !== 0)) throw new Error("empty pipeline stages should have zero width");
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

  const planTask = await request("/api/plan-tasks", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      title: "自动化计划任务",
      phase: "客户开发",
      category: "仪表开拓",
      priority: "high",
      status: "planned",
      dueAt: "明天 18:00",
      target: "完成自动化计划任务自测",
      description: "验证计划任务可新增、编辑、持久化和权限隔离"
    })
  });
  if (!planTask.response.ok || planTask.json.task.ownerId !== "u_sales_shirley") throw new Error("plan task create failed");
  const editedPlanTask = await request(`/api/plan-tasks/${planTask.json.task.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ status: "active", target: "已更新验收目标" })
  });
  if (!editedPlanTask.response.ok || editedPlanTask.json.task.status !== "active" || editedPlanTask.json.task.target !== "已更新验收目标") throw new Error("plan task edit failed");
  const miaPlanTasks = await request("/api/plan-tasks", { headers: { authorization: `Bearer ${miaToken}` } });
  if (!miaPlanTasks.response.ok || miaPlanTasks.json.tasks.some((item: { id: string }) => item.id === planTask.json.task.id)) throw new Error("other sales should not see personal plan tasks");
  const managerPlanTasks = await request("/api/plan-tasks", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!managerPlanTasks.response.ok || managerPlanTasks.json.tasks.some((item: { id: string }) => item.id === planTask.json.task.id)) throw new Error("manager should not see personal plan tasks");
  const deletedPlanTask = await request(`/api/plan-tasks/${planTask.json.task.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!deletedPlanTask.response.ok || deletedPlanTask.json.ok !== true) throw new Error("plan task delete failed");

  const planTemplates = await request("/api/plan-templates", { headers: { authorization: `Bearer ${salesToken}` } });
  if (!planTemplates.response.ok || planTemplates.json.templates.length < 15) throw new Error("plan templates seed failed");
  if (!planTemplates.json.templates.some((item: { section: string }) => item.section === "execution")) throw new Error("execution templates seed failed");
  const templateId = planTemplates.json.templates[0].id;
  const editedTemplate = await request(`/api/plan-templates/${templateId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "自动化模板编辑", summary: "模板编辑自测", sortOrder: 1 })
  });
  if (!editedTemplate.response.ok || editedTemplate.json.template.title !== "自动化模板编辑") throw new Error("plan template edit failed");
  const deletedTemplate = await request(`/api/plan-templates/${templateId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!deletedTemplate.response.ok || deletedTemplate.json.ok !== true) throw new Error("plan template delete failed");

  const reminders = await request("/api/reminders", { headers: { authorization: `Bearer ${salesToken}` } });
  if (reminders.json.reminders.length < 2) throw new Error("reminders scope failed");

  const reminder = await request("/api/reminders", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "自动化提醒规则", ruleType: "quote_no_reply", targetStage: "已报价", days: 2, dueAt: "今天 18:00", channel: "企业微信", priority: "high" })
  });
  if (!reminder.response.ok || reminder.json.reminder.title !== "自动化提醒规则" || typeof reminder.json.reminder.generatedCount !== "number") throw new Error("reminder create failed");
  const reminderRun = await request(`/api/reminders/${reminder.json.reminder.id}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!reminderRun.response.ok || typeof reminderRun.json.createdCount !== "number") throw new Error("reminder rule run failed");

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

  const customerImport = await request("/api/import-export/customers/import", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      fileName: "self-test-customers.xlsx",
      rows: [
        { company: `自动化导入客户-${Date.now()}`, country: "德国", contact: "Import Buyer", stage: "询盘", amount: 19000, health: 76, nextReminder: "明天 10:00", wecomBound: true },
        { company: "Nordic Tools AB", country: "瑞典", contact: "Emma Import", stage: "已报价", amount: 36000, health: 68, nextReminder: "今天 18:00", wecomBound: true }
      ]
    })
  });
  if (!customerImport.response.ok || customerImport.json.result.created !== 1 || customerImport.json.result.updated !== 1) throw new Error("customer import failed");
  const customerExport = await request("/api/import-export/customers/export", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!customerExport.response.ok || !Array.isArray(customerExport.json.customers) || customerExport.json.customers.length < 1) throw new Error("customer export failed");

  const tradeDocument = await request("/api/trade-documents", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      type: "CI",
      title: "自动化商业发票",
      number: `CI-${Date.now()}`,
      issueDate: "2026-07-06",
      buyer: "Automation Buyer Ltd.",
      buyerAddress: "Berlin, Germany",
      buyerContact: "Auto Buyer",
      seller: "GoodJob Instrument Co., Ltd.",
      sellerAddress: "Tianjin, China",
      currency: "USD",
      incoterm: "FOB Tianjin",
      paymentTerm: "30% T/T deposit, 70% before shipment",
      shippingMethod: "Sea freight",
      portLoading: "Tianjin",
      portDischarge: "Hamburg",
      validityDate: "2026-07-20",
      bankInfo: "Bank of China",
      notes: "Automation document test",
      templateStyle: "executive",
      status: "ready",
      items: [
        { product: "Pressure Transmitter", model: "GJ-PT", hsCode: "902620", quantity: 3, unit: "PCS", unitPrice: 180, originCountry: "China", weightKg: 5, packageCount: 1 }
      ]
    })
  });
  if (!tradeDocument.response.ok || tradeDocument.json.document.type !== "CI") throw new Error("trade document create failed");

  const tradeDocuments = await request("/api/trade-documents", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!tradeDocuments.response.ok || !tradeDocuments.json.documents.some((item: { id: string }) => item.id === tradeDocument.json.document.id)) throw new Error("trade document list failed");

  const tradeDocumentExport = await request(`/api/trade-documents/${tradeDocument.json.document.id}/export`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!tradeDocumentExport.response.ok || tradeDocumentExport.json.document.status !== "exported") throw new Error("trade document export failed");

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

  const salesQuestionForbidden = await request("/api/exam-questions", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      stem: "销售不能维护题库？",
      category: "权限测试",
      options: ["能", "不能"],
      answerIndex: 1,
      explanation: "销售只能参加考试，不能维护题库。",
      difficulty: "easy"
    })
  });
  if (salesQuestionForbidden.response.status !== 403) throw new Error("sales must not maintain question bank");

  const salesExamForbidden = await request("/api/exams", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "销售不能发布考试", category: "权限测试", questionIds: ["q1"] })
  });
  if (salesExamForbidden.response.status !== 403) throw new Error("sales must not create exams");

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
    archivedDeal: Boolean(archivedDeal.json.deal.archivedAt),
    lostDeal: markedLost.json.deal.stage,
    createdReminder: reminder.json.reminder.title,
	    todoUndo: todoUndone.json.todo.done === false,
	    todoRestored: !restoredTodo.json.todo.historyAt,
    problemResolved: resolvedProblem.json.problem.status,
    memoPinned: pinnedMemo.json.memo.pinned,
    competitorThreat: competitorThreat.json.competitor.threatLevel,
    casePublished: publishedCase.json.caseStudy.status,
    aiConfigMasked: aiConfigRead.json.config.apiKey,
    aiConfigDeleteRemaining: aiConfigDelete.json.configs.length,
    profileOutboundEmail: profileBind.json.user.outboundEmail,
    profileSmtpTest: profileTestMail.json.ok,
    developmentEmailTo: profileMail.json.user.lastDevelopmentEmailTo,
    prospectEmailTo: prospectMail.json.opportunity.lastDevelopmentEmailTo,
    leadProviderCount: providerList.length,
    leadSourceMaskedKey: leadSourceSave.json.config.apiKey,
    leadSourceDeleted: !serperAfterDelete?.hasApiKey,
    importJob: customerImport.json.job.name,
    exportRows: customerExport.json.customers.length,
    tradeDocument: tradeDocument.json.document.number,
    tradeDocumentExported: tradeDocumentExport.json.document.status,
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
