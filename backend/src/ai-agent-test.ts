import assert from "node:assert/strict";
import {
  AgentBackgroundRunner,
  cancelAgentMission,
  createAgentPlan,
  executeAgentStep,
  executeQueuedAgentStep,
  getAgentRun,
  listAgentConversations,
  listAgentMissionCheckpoints,
  listAgentRuns,
  normalizeAgentNavigationView,
  resolveAgentNavigationTarget,
  pauseAgentMission,
  resumeAgentMission,
  restoreAgentMissionCheckpoint,
  steerAgentMission
} from "./ai-agent.js";
import { memoryStore, type CrmStore } from "./store.js";
import { createOutreachSequence } from "./outreach-sequences.js";

function isolatedStore() {
  const store = Object.fromEntries(
    Object.entries(memoryStore).map(([key, value]) => [
      key,
      Array.isArray(value) ? structuredClone(value) : value
    ])
  ) as unknown as CrmStore;
  let persistCount = 0;
  store.aiModelConfigs = [];
  store.agentRuns = [];
  store.agentRunSteps = [];
  store.agentRunEvents = [];
  store.persist = async () => { persistCount += 1; };
  return { store, persistCount: () => persistCount };
}

async function main() {
  const fixture = isolatedStore();
  const admin = fixture.store.users.find((item) => item.id === "u_admin")!;
  const otherUser = fixture.store.users.find((item) => item.id !== admin.id)!;

  const progressFixture = isolatedStore();
  const progressAdmin = progressFixture.store.users.find((item) => item.id === "u_admin")!;
  const planningProgress: Array<{ phase: string; requestKind: string; message: string }> = [];
  await createAgentPlan(progressFixture.store, progressAdmin, "新增一个客户，公司名称为 Streaming Intent Ltd", {}, (progress) => planningProgress.push(progress));
  assert.deepEqual(planningProgress.map((item) => item.phase), ["understanding", "intent", "planning", "planning", "planning", "ready"]);
  assert.ok(planningProgress.filter((item) => item.phase === "planning").length >= 3);
  assert.ok(planningProgress.some((item) => /装载系统知识|基础执行能力/u.test(item.message)));
  assert.ok(planningProgress.some((item) => /校验动作依赖/u.test(item.message)));
  assert.equal(planningProgress[1]?.requestKind, "execute");
  assert.match(planningProgress[1]?.message || "", /直接推进/u);
  assert.ok(planningProgress.findIndex((item) => item.phase === "intent") < planningProgress.findIndex((item) => item.phase === "planning"));

  const queryProgress: Array<{ phase: string; requestKind: string }> = [];
  await createAgentPlan(progressFixture.store, progressAdmin, "查看当前商机管道", {}, (progress) => queryProgress.push(progress));
  assert.equal(queryProgress[1]?.requestKind, "query");

  const greetingProgress: Array<{ phase: string; requestKind: string }> = [];
  const greetingRun = await createAgentPlan(progressFixture.store, progressAdmin, "你好", {}, (progress) => greetingProgress.push(progress));
  assert.equal(greetingProgress[1]?.requestKind, "conversation");
  assert.equal(greetingRun.status, "completed");
  assert.equal(greetingRun.steps.length, 0);
  assert.match(greetingRun.summary, /你好|GoodJob CRM/u);
  assert.equal(greetingRun.events.some((item) => item.message.includes("商机")), false);

  const readRun = await createAgentPlan(fixture.store, admin, "检查当前商机管道");
  assert.equal(fixture.store.agentRuns.length, 1);
  assert.equal(fixture.store.agentRunSteps.length, 1);
  assert.equal(fixture.store.agentRunEvents.length, 2);
  assert.ok(fixture.store.agentRunEvents.some((item) => item.message.startsWith("本轮语义判决：")));
  const readStep = readRun.steps[0]!;
  const readDone = await executeAgentStep(fixture.store, admin, readRun.id, readStep.id, readStep.signature, false);
  assert.equal(readDone.status, "completed");
  assert.equal(readDone.steps[0]?.status, "done");
  assert.ok(fixture.store.agentRunEvents.length >= 3);
  assert.equal(readDone.progress, 100);
  assert.equal(readDone.events.at(-1)?.type, "assistant");
  assert.equal(readDone.events.at(-1)?.message, readDone.summary);
  const readCheckpoints = listAgentMissionCheckpoints(fixture.store, admin, readRun.id, 80);
  assert.ok(readCheckpoints.length >= 2);
  assert.equal(new Set(readCheckpoints.map((item) => item.stateHash)).size, readCheckpoints.length);
  assert.throws(() => listAgentMissionCheckpoints(fixture.store, otherUser, readRun.id), /Agent 运行不存在/u);
  const restoredRead = await restoreAgentMissionCheckpoint(fixture.store, admin, readRun.id, readCheckpoints.at(-1)!.id);
  assert.equal(restoredRead.status, "running");
  assert.equal(restoredRead.steps[0]?.status, "ready");

  assert.throws(() => getAgentRun(fixture.store, readRun.id, otherUser), /Agent 运行不存在/u);
  assert.equal(listAgentRuns(fixture.store, otherUser).length, 0);
  assert.equal(listAgentRuns(fixture.store, admin).length, 1);

  const readOnlyRun = await createAgentPlan(fixture.store, admin, "检查我的待办数量，不要修改任何数据");
  assert.ok(readOnlyRun.steps.length > 0);
  assert.ok(readOnlyRun.steps.every((item) => item.risk === "read"));
  assert.ok(readOnlyRun.steps.every((item) => item.tool !== "crm.create_todo"));
  assert.equal(normalizeAgentNavigationView("deals"), "pipeline");
  assert.equal(normalizeAgentNavigationView("opportunities"), "pipeline");
  assert.equal(normalizeAgentNavigationView("pipeline"), "pipeline");
  assert.equal(normalizeAgentNavigationView("unknown-page"), "");
  const navigationCases = [
    ["我要写单据", "documents"],
    ["帮我做一份 PI", "documents"],
    ["准备商业发票和装箱单", "documents"],
    ["我需要处理报关资料", "documents"],
    ["带我去看看成交进度", "pipeline"],
    ["我想看今天的客户跟进提醒", "reminders"],
    ["我要找一批采购商", "lead-finder"],
    ["看看刚才搜到的候选企业", "prospect-list"],
    ["我要写客户开发邮件", "development-email"],
    ["我要维护产品资料", "knowledge"],
    ["我要写销售日报", "daily-reports"],
    ["我想处理业务问题", "problems"],
    ["我要配置大模型", "ai-config"],
    ["查看客户案例", "cases"]
  ] as const;
  navigationCases.forEach(([goal, expected]) => assert.equal(resolveAgentNavigationTarget(goal)?.view, expected, goal));

  const documentNavigationRun = await createAgentPlan(fixture.store, admin, "我要写单据");
  assert.equal(documentNavigationRun.steps[0]?.tool, "ui.navigate");
  assert.equal(documentNavigationRun.steps[0]?.input.view, "documents");
  assert.ok(Number(documentNavigationRun.steps[0]?.input.matchScore) >= 48);
  const documentNavigationDone = await executeAgentStep(fixture.store, admin, documentNavigationRun.id, documentNavigationRun.steps[0]!.id, documentNavigationRun.steps[0]!.signature, false);
  assert.equal((documentNavigationDone.steps[0]?.result?.uiAction as { view?: string } | undefined)?.view, "documents");

  const missingCustomerRecord = await createAgentPlan(fixture.store, admin, "新增个客记");
  assert.equal(missingCustomerRecord.status, "waiting_user");
  assert.equal(missingCustomerRecord.steps.length, 0);
  assert.match(missingCustomerRecord.stopReason, /客户名称/u);

  const writableCustomer = fixture.store.customers.find((item) => item.ownerId === admin.id)
    || fixture.store.customers[0]!;
  const customerRecordRun = await createAgentPlan(
    fixture.store,
    admin,
    "给当前客户记一条跟进：客户希望下周收到正式报价",
    { selectedCustomerId: writableCustomer.id, activeView: "customers" }
  );
  assert.equal(customerRecordRun.status, "running");
  const customerRecordStep = customerRecordRun.steps[0]!;
  assert.equal(customerRecordStep.tool, "crm.record_customer_followup");
  assert.equal(customerRecordStep.input.customerId, writableCustomer.id);
  assert.equal(customerRecordStep.input.content, "客户希望下周收到正式报价");
  const beforeActivities = fixture.store.customerActivities.length;
  assert.ok(customerRecordStep.approvedAt);
  const customerRecordDone = await executeAgentStep(fixture.store, admin, customerRecordRun.id, customerRecordStep.id, customerRecordStep.signature, false);
  assert.equal(customerRecordDone.status, "completed");
  assert.equal(fixture.store.customerActivities.length, beforeActivities + 1);

  const missingCustomerName = await createAgentPlan(fixture.store, admin, "新增一个客户", { conversationId: "agc_create_customer_test" });
  assert.equal(missingCustomerName.status, "waiting_user");
  assert.match(missingCustomerName.stopReason, /公司名称/u);
  const completedCustomerIntent = await resumeAgentMission(fixture.store, admin, missingCustomerName.id, "公司名称为 Agent Test Company");
  assert.ok(completedCustomerIntent);
  assert.equal(completedCustomerIntent!.status, "running");
  assert.equal(completedCustomerIntent!.steps.at(-1)?.tool, "api.write");
  assert.equal(completedCustomerIntent!.steps.at(-1)?.status, "ready");
  assert.ok(completedCustomerIntent!.steps.at(-1)?.approvedAt);
  assert.equal((completedCustomerIntent!.steps.at(-1)?.input.body as { company?: string })?.company, "Agent Test Company");

  const naturalCustomerIntent = await createAgentPlan(fixture.store, admin, "帮我加一个客户，名字叫 Quick Add Ltd", { conversationId: "agc_natural_customer_test" });
  assert.equal(naturalCustomerIntent.status, "running");
  assert.equal(naturalCustomerIntent.steps[0]?.tool, "api.write");
  assert.equal((naturalCustomerIntent.steps[0]?.input.body as { company?: string })?.company, "Quick Add Ltd");

  const naturalCustomerFollowup = await createAgentPlan(fixture.store, admin, "帮我加个客户", { conversationId: "agc_natural_customer_followup_test" });
  assert.equal(naturalCustomerFollowup.status, "waiting_user");
  const naturalCustomerFollowupDone = await resumeAgentMission(fixture.store, admin, naturalCustomerFollowup.id, "名字叫 Followup Add Ltd");
  assert.ok(naturalCustomerFollowupDone);
  assert.equal(naturalCustomerFollowupDone.status, "running");
  assert.equal((naturalCustomerFollowupDone.steps.at(-1)?.input.body as { company?: string })?.company, "Followup Add Ltd");

  const generatedCustomerIntent = await createAgentPlan(fixture.store, admin, "生成个客户，名叫goodjob01，其它你编", { conversationId: "agc_generated_customer_test" });
  assert.equal(generatedCustomerIntent.status, "running");
  assert.equal(generatedCustomerIntent.steps[0]?.tool, "api.write");
  assert.equal(generatedCustomerIntent.steps[0]?.status, "ready");
  assert.deepEqual(generatedCustomerIntent.steps[0]?.input.body, {
    company: "goodjob01", country: "未知", contact: "待维护", whatsapp: "", stage: "询盘", amount: 0,
    health: 72, grade: "C", billingName: "goodjob01", billingAddress: "", documentContact: "待维护",
    defaultPortDischarge: "", defaultIncoterm: "", defaultPaymentTerm: ""
  });
  assert.ok(generatedCustomerIntent.steps[0]?.approvedAt);

  const fullyDelegatedCustomer = await createAgentPlan(fixture.store, admin, "帮我生成一个客户，数据你看着来", { conversationId: "agc_fully_delegated_customer_test" });
  assert.equal(fullyDelegatedCustomer.status, "running");
  assert.equal(fullyDelegatedCustomer.steps[0]?.status, "ready");
  const fullyDelegatedBody = fullyDelegatedCustomer.steps[0]?.input.body as Record<string, unknown>;
  assert.match(String(fullyDelegatedBody.company), /^AI模拟客户-/u);
  assert.equal(fullyDelegatedBody.contact, "待维护");
  assert.equal(fullyDelegatedBody.health, 72);
  assert.ok(fullyDelegatedCustomer.steps[0]?.approvedAt);

  const memoIntent = await createAgentPlan(fixture.store, admin, "新建客户备忘：季度采购计划", { selectedCustomerId: writableCustomer.id });
  assert.equal(memoIntent.steps[0]?.tool, "api.write");
  assert.equal(memoIntent.steps[0]?.input.path, "/api/memos");
  assert.equal((memoIntent.steps[0]?.input.body as { title?: string }).title, "季度采购计划");
  assert.equal((memoIntent.steps[0]?.input.body as { customerId?: string }).customerId, writableCustomer.id);

  const apiCatalogRun = await createAgentPlan(fixture.store, admin, "查看客户相关接口");
  const apiCatalogStep = apiCatalogRun.steps[0]!;
  assert.equal(apiCatalogStep.tool, "api.catalog");
  assert.equal(apiCatalogStep.input.query, "customers");
  const apiCatalogDone = await executeAgentStep(fixture.store, admin, apiCatalogRun.id, apiCatalogStep.id, apiCatalogStep.signature, false, {
    listCrmApiCatalog: async () => ({ count: 2, routes: [{ method: "GET", path: "/api/customers", risk: "read" }, { method: "POST", path: "/api/customers", risk: "write" }] })
  });
  assert.equal(apiCatalogDone.steps[0]?.result?.count, 2);

  const apiWriteRun = await createAgentPlan(fixture.store, admin, 'POST /api/memos {"title":"接口测试","content":"受控写入"}');
  const apiWriteStep = apiWriteRun.steps[0]!;
  assert.equal(apiWriteStep.tool, "api.write");
  assert.equal(apiWriteStep.status, "ready");
  assert.ok(apiWriteStep.approvedAt);
  assert.deepEqual(apiWriteStep.input.body, { title: "接口测试", content: "受控写入" });
  const apiWriteDone = await executeAgentStep(fixture.store, admin, apiWriteRun.id, apiWriteStep.id, apiWriteStep.signature, false, {
    requestCrmApi: async (_actor, input, tool) => ({ status: 200, path: input.path, method: input.method, tool, uiAction: { type: "refresh", view: "memos" } })
  });
  assert.equal(apiWriteDone.steps[0]?.result?.status, 200);

  const destructiveWriteRun = await createAgentPlan(fixture.store, admin, "DELETE /api/memos/m_1");
  assert.equal(destructiveWriteRun.steps[0]?.status, "needs_confirmation");
  const bulkWriteRun = await createAgentPlan(fixture.store, admin, 'POST /api/customers/bulk-delete {"ids":["c_1"]}');
  assert.equal(bulkWriteRun.steps[0]?.status, "needs_confirmation");

  const apiExternalRun = await createAgentPlan(fixture.store, admin, 'POST /api/development-email/send {"entityId":"c1","subject":"Locked","body":"Locked body"}');
  assert.equal(apiExternalRun.steps[0]?.tool, "api.external");
  assert.equal(apiExternalRun.steps[0]?.status, "needs_confirmation");
  const unknownExternalStep = apiExternalRun.steps[0]!;
  await executeAgentStep(fixture.store, admin, apiExternalRun.id, unknownExternalStep.id, unknownExternalStep.signature, true);
  const unknownExternalOutcome = await executeQueuedAgentStep(fixture.store, {
    requestCrmApi: async () => { throw new Error("HTTP 503 upstream timeout"); }
  }, apiExternalRun.id, unknownExternalStep.id);
  assert.equal(unknownExternalOutcome?.status, "waiting_user");
  assert.match(unknownExternalOutcome?.stopReason || "", /实际渠道核验/u);
  assert.equal(unknownExternalOutcome?.steps[0]?.status, "failed");
  const deniedAccountRun = await createAgentPlan(fixture.store, admin, "GET /api/accounts");
  assert.equal(deniedAccountRun.steps[0]?.tool, "api.catalog");

  const writeRun = await createAgentPlan(fixture.store, admin, "整理待办并安排跟进");
  const writeStep = writeRun.steps.find((item) => item.risk === "write")!;
  assert.equal(writeStep.status, "ready");
  assert.ok(writeStep.approvedAt);
  const beforeTodos = fixture.store.todos.length;
  const writeDone = await executeAgentStep(fixture.store, admin, writeRun.id, writeStep.id, writeStep.signature, false);
  assert.equal(writeDone.steps.find((item) => item.id === writeStep.id)?.status, "done");
  assert.equal(fixture.store.todos.length, beforeTodos + 1);
  const writeInitialCheckpoint = listAgentMissionCheckpoints(fixture.store, admin, writeRun.id, 80).at(-1)!;
  await assert.rejects(
    restoreAgentMissionCheckpoint(fixture.store, admin, writeRun.id, writeInitialCheckpoint.id),
    /已完成 CRM 写入/u
  );
  await executeAgentStep(fixture.store, admin, writeRun.id, writeStep.id, writeStep.signature, true);
  assert.equal(fixture.store.todos.length, beforeTodos + 1);

  const steerRun = await createAgentPlan(fixture.store, admin, "整理待办并创建重点跟进任务");
  const replacedWriteStep = steerRun.steps.find((item) => item.risk === "write")!;
  const steered = await steerAgentMission(fixture.store, admin, steerRun.id, "只检查待办数量，不要修改、创建或发送任何数据");
  assert.equal(steered.id, steerRun.id);
  assert.equal(steered.steps.find((item) => item.id === replacedWriteStep.id)?.status, "skipped");
  assert.ok(steered.steps.filter((item) => item.status !== "skipped").every((item) => item.risk === "read"));
  await assert.rejects(
    executeAgentStep(fixture.store, admin, steerRun.id, replacedWriteStep.id, replacedWriteStep.signature, true),
    /已被新指令替代/u
  );
  const replacementRead = steered.steps.find((item) => item.status === "ready")!;
  const steeredDone = await executeAgentStep(fixture.store, admin, steerRun.id, replacementRead.id, replacementRead.signature, false);
  assert.equal(steeredDone.status, "completed");
  assert.ok(steeredDone.events.some((item) => item.message.startsWith("已应用改令：")));

  const expiringRun = await createAgentPlan(fixture.store, admin, "读取商机快照");
  const expiringRecord = fixture.store.agentRuns.find((item) => item.id === expiringRun.id)!;
  expiringRecord.expiresAt = new Date(Date.now() - 1_000).toISOString();
  assert.equal(getAgentRun(fixture.store, expiringRun.id, admin).id, expiringRun.id);
  await assert.rejects(
    executeAgentStep(fixture.store, admin, expiringRun.id, expiringRun.steps[0]!.id, expiringRun.steps[0]!.signature, false),
    /运行已过期/u
  );

  const currentCustomer = fixture.store.customers.find((item) => item.ownerId === admin.id)
    || fixture.store.customers[0]!;
  currentCustomer.whatsapp = "+46701234567";
  const uiRun = await createAgentPlan(
    fixture.store,
    admin,
    "打开当前客户的 Communication 聊天",
    { selectedCustomerId: currentCustomer.id, activeView: "customers" }
  );
  const uiStep = uiRun.steps[0]!;
  const uiDone = await executeAgentStep(fixture.store, admin, uiRun.id, uiStep.id, uiStep.signature, false);
  assert.deepEqual(uiDone.steps[0]?.result?.uiAction, { type: "open_communication", customerId: currentCustomer.id });

  const researchRun = await createAgentPlan(
    fixture.store,
    admin,
    "背调当前客户",
    { selectedCustomerId: currentCustomer.id, activeView: "customers" }
  );
  const researchStep = researchRun.steps.find((item) => item.tool === "research.run_background")!;
  const researchDone = await executeAgentStep(fixture.store, admin, researchRun.id, researchStep.id, researchStep.signature, false, {
    runBackgroundResearch: async () => ({
      research: { company: currentCustomer.company, score: 82, verdict: "资料较完整" },
      score: 82,
      verdict: "资料较完整",
      uiAction: { type: "open_research", entityType: "customer", entityId: currentCustomer.id }
    })
  });
  assert.equal(researchDone.steps.find((item) => item.id === researchStep.id)?.result?.score, 82);
  assert.deepEqual(researchDone.steps.find((item) => item.id === researchStep.id)?.result?.uiAction, { type: "open_research", entityType: "customer", entityId: currentCustomer.id });

  const inboxRun = await createAgentPlan(fixture.store, admin, "查看 Communication 未读消息");
  const inboxStep = inboxRun.steps.find((item) => item.tool === "communication.get_inbox")!;
  const inboxDone = await executeAgentStep(fixture.store, admin, inboxRun.id, inboxStep.id, inboxStep.signature, false, {
    getCommunicationInbox: async () => ({ count: 1, totalUnread: 2, connectedAccountCount: 1, conversations: [{ customerId: currentCustomer.id, customerCompany: currentCustomer.company }] })
  });
  assert.equal(inboxDone.steps.find((item) => item.id === inboxStep.id)?.result?.totalUnread, 2);

  const currentLead = fixture.store.leads.find((item) => item.ownerId === admin.id)
    || fixture.store.leads[0]!;
  const sendRun = await createAgentPlan(
    fixture.store,
    admin,
    "发送一封开发信并安排后续跟进",
    { selectedLeadId: currentLead.id, activeView: "leads" }
  );
  const draftStep = sendRun.steps.find((item) => item.tool === "outreach.draft_development_email")!;
  assert.equal(draftStep.input.prepareForSend, true);
  const prepared = await executeAgentStep(fixture.store, admin, sendRun.id, draftStep.id, draftStep.signature, false, {
    draftDevelopmentEmail: async () => ({
      draft: {
        entityType: "lead",
        entityId: currentLead.id,
        to: currentLead.email || "buyer@example.com",
        subject: "Locked subject",
        body: "This exact body must be visible before approval."
      }
    })
  });
  const sendStep = prepared.steps.find((item) => item.tool === "outreach.send_development_email")!;
  assert.equal(sendStep.status, "needs_confirmation");
  assert.equal(sendStep.input.subject, "Locked subject");
  assert.equal(sendStep.input.body, "This exact body must be visible before approval.");
  const queued = await executeAgentStep(fixture.store, admin, sendRun.id, sendStep.id, sendStep.signature, true);
  assert.equal(queued.steps.find((item) => item.id === sendStep.id)?.status, "queued");
  let externalSendCount = 0;
  const sent = await executeQueuedAgentStep(fixture.store, {
    sendDevelopmentEmail: async (_actor, input, executionId) => {
      externalSendCount += 1;
      return { sent: true, messageId: `message:${executionId}`, activityId: `activity:${executionId}`, entityId: input.entityId, executionId };
    }
  }, sendRun.id, sendStep.id);
  assert.equal(sent?.status, "completed");
  assert.equal(sent?.steps.find((item) => item.id === sendStep.id)?.status, "done");
  assert.equal(externalSendCount, 1);
  const externalCheckpoint = listAgentMissionCheckpoints(fixture.store, admin, sendRun.id, 80).at(-1)!;
  await assert.rejects(
    restoreAgentMissionCheckpoint(fixture.store, admin, sendRun.id, externalCheckpoint.id),
    /存在外部动作/u
  );
  const conversationId = "agc_test_conversation";
  await createAgentPlan(fixture.store, admin, "第一轮：分析客户", { conversationId });
  await createAgentPlan(fixture.store, admin, "第二轮：继续分析商机", { conversationId });
  const conversations = listAgentConversations(fixture.store, admin);
  assert.equal(conversations.find((item) => item.id === conversationId)?.turnCount, 2);
  await executeQueuedAgentStep(fixture.store, { sendDevelopmentEmail: async () => ({ sent: true, messageId: "replay", activityId: "activity:replay" }) }, sendRun.id, sendStep.id);
  assert.equal(externalSendCount, 1);

  const backgroundRun = await createAgentPlan(fixture.store, admin, "读取商机快照");
  const backgroundRunner = new AgentBackgroundRunner(fixture.store, {}, 60_000);
  await backgroundRunner.synchronize();
  assert.equal(getAgentRun(fixture.store, backgroundRun.id, admin).status, "completed");
  assert.equal(getAgentRun(fixture.store, backgroundRun.id, admin).steps[0]?.status, "done");
  assert.match(getAgentRun(fixture.store, backgroundRun.id, admin).summary, /客户 .*商机 .*商机金额/u);

  const searchMission = await createAgentPlan(fixture.store, admin, "启动并持续观察搜客任务");
  const searchRunRecord = fixture.store.agentRuns.find((item) => item.id === searchMission.id)!;
  const searchStepRecord = fixture.store.agentRunSteps.find((item) => item.runId === searchMission.id)!;
  searchRunRecord.status = "running";
  searchRunRecord.stopReason = "";
  Object.assign(searchStepRecord, {
    tool: "prospect.start_search",
    risk: "external",
    status: "queued",
    title: "启动正式搜客任务",
    input: { products: ["LED"], markets: ["Germany"] },
    result: undefined,
    error: undefined
  });
  let searchProgressPolls = 0;
  const searchRunner = new AgentBackgroundRunner(fixture.store, {
    startProspectSearch: async () => ({ runId: "pr_agent_test", status: "queued", providerCount: 2 }),
    getProspectSearchProgress: async () => {
      searchProgressPolls += 1;
      return searchProgressPolls === 1
        ? { runId: "pr_agent_test", status: "running", terminal: false, progress: 45, candidateCount: 3, verifiedCount: 1, filteredCount: 2, nextCheckAt: new Date(Date.now() + 30).toISOString() }
        : { runId: "pr_agent_test", status: "succeeded", terminal: true, progress: 100, candidateCount: 7, verifiedCount: 5, filteredCount: 3 };
    }
  }, 60_000);
  await searchRunner.synchronize();
  assert.equal(getAgentRun(fixture.store, searchMission.id, admin).status, "running");
  assert.match(getAgentRun(fixture.store, searchMission.id, admin).stopReason, /^wait_until:/u);
  await new Promise((resolve) => setTimeout(resolve, 45));
  await searchRunner.synchronize();
  const completedSearchMission = getAgentRun(fixture.store, searchMission.id, admin);
  assert.equal(completedSearchMission.status, "completed");
  assert.equal(searchProgressPolls, 2);
  assert.match(completedSearchMission.summary, /搜获候选 7 家.*已复核 5 家.*清洗淘汰 3 家/u);

  currentCustomer.ownerId = admin.id;
  currentCustomer.teamId = admin.teamId;
  const sequenceMission = await createAgentPlan(
    fixture.store,
    admin,
    "自动连续通过 Communication 跟进当前客户",
    { selectedCustomerId: currentCustomer.id }
  );
  const sequenceCreateStep = sequenceMission.steps.find((item) => item.tool === "outreach.create_sequence")!;
  await executeAgentStep(fixture.store, admin, sequenceMission.id, sequenceCreateStep.id, sequenceCreateStep.signature, true);
  let sequencePolls = 0;
  const sequenceMissionRunner = new AgentBackgroundRunner(fixture.store, {
    createOutreachSequence: async (actor, input, executionId, missionRunId) => {
      const sequence = await createOutreachSequence(fixture.store, actor, input, missionRunId, executionId);
      return { sequenceId: sequence.id, status: sequence.status, maxSends: sequence.maxSends };
    },
    getOutreachSequenceProgress: async (_actor, input) => {
      sequencePolls += 1;
      return sequencePolls === 1
        ? { sequenceId: input.sequenceId, status: "active", terminal: false, progress: 0, currentStep: 0, maxSends: 2, nextCheckAt: new Date(Date.now() + 25).toISOString() }
        : { sequenceId: input.sequenceId, status: "completed", terminal: true, progress: 100, currentStep: 2, maxSends: 2, stopReason: "" };
    }
  }, 60_000);
  await sequenceMissionRunner.synchronize();
  assert.equal(getAgentRun(fixture.store, sequenceMission.id, admin).status, "running");
  assert.match(getAgentRun(fixture.store, sequenceMission.id, admin).stopReason, /^wait_until:/u);
  await new Promise((resolve) => setTimeout(resolve, 35));
  await sequenceMissionRunner.synchronize();
  assert.equal(getAgentRun(fixture.store, sequenceMission.id, admin).status, "completed");
  assert.equal(sequencePolls, 2);

  const pausedRun = await createAgentPlan(fixture.store, admin, "读取商机快照");
  const paused = await pauseAgentMission(fixture.store, admin, pausedRun.id);
  assert.equal(paused.status, "paused");
  await backgroundRunner.synchronize();
  assert.equal(getAgentRun(fixture.store, pausedRun.id, admin).steps[0]?.status, "ready");
  await resumeAgentMission(fixture.store, admin, pausedRun.id, "继续原目标");
  await backgroundRunner.synchronize();
  const resumedDone = getAgentRun(fixture.store, pausedRun.id, admin);
  assert.equal(resumedDone.status, "completed");
  const supplementIndex = resumedDone.events.findIndex((item) => item.message === "用户补充：继续原目标");
  const replyAfterSupplement = resumedDone.events.findIndex((item, index) => index > supplementIndex && item.type === "assistant");
  assert.ok(supplementIndex >= 0 && replyAfterSupplement > supplementIndex);

  const cancelledRun = await createAgentPlan(fixture.store, admin, "读取商机快照");
  await cancelAgentMission(fixture.store, admin, cancelledRun.id);
  await backgroundRunner.synchronize();
  assert.equal(getAgentRun(fixture.store, cancelledRun.id, admin).status, "cancelled");
  assert.equal(getAgentRun(fixture.store, cancelledRun.id, admin).steps[0]?.status, "failed");
  assert.equal(getAgentRun(fixture.store, cancelledRun.id, admin).events.at(-1)?.type, "assistant");

  assert.ok(fixture.persistCount() >= 5);
  console.log(JSON.stringify({
    ok: true,
    persistedRuns: fixture.store.agentRuns.length,
    writeIdempotent: true,
    expiredExecutionBlocked: true,
    crossAccountHidden: true,
    pageControl: true,
    backgroundResearch: true,
    communicationInbox: true,
    externalActionQueued: true,
    backgroundSendIdempotent: true,
    exactEmailApprovalSnapshot: true,
    conversationHistory: true,
    missionBackgroundExecution: true,
    missionProspectObservation: true,
    missionOutreachSequenceObservation: true,
    missionPauseResume: true,
    missionCancel: true
  }, null, 2));
}

void main();
