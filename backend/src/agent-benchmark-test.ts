import assert from "node:assert/strict";
import { AgentBackgroundRunner, createAgentPlan, executeAgentStep, getAgentRun, resumeAgentMission, steerAgentMission } from "./ai-agent.js";
import { agentApiBusinessContract } from "./agent-api-contracts.js";
import { aggregateGjabRuntimeMetrics, evaluateGjabRuntimeTrajectory, gjabPlanCases, runGjabPlanBenchmark } from "./agent-benchmark.js";
import { memoryStore, type CrmStore } from "./store.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import type { AiModelConfig, Deal, TradeDocument } from "./types.js";

function isolatedStore() {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.agentRuns = [];
  store.agentRunSteps = [];
  store.agentRunEvents = [];
  store.agentMissionCheckpoints = [];
  store.agentModelCalls = [];
  store.agentEvaluationRuns = [];
  store.persist = async () => {};
  return store;
}

function modelConfig(ownerId: string, teamId: string): AiModelConfig {
  return {
    id: "gjab-model",
    provider: "custom",
    protocol: "openai-compatible",
    name: "GJAB test model",
    baseUrl: "https://gjab.example/v1",
    model: "gjab-test",
    apiKey: "gjab-test-key",
    enabled: true,
    temperature: 0,
    useLeadFinder: true,
    useWebsiteParse: true,
    useScoring: true,
    useEmailDraft: true,
    useExam: false,
    ownerId,
    teamId,
    updatedAt: "2026-07-22T00:00:00.000Z"
  };
}

function addDeal(store: CrmStore, customerId: string, ownerId: string, teamId: string): Deal {
  const deal: Deal = {
    id: "d_gjab_pi",
    customerId,
    title: "GJAB Sample 商机",
    stage: "已报价",
    product: "GJAB Sample",
    quantity: 10,
    unitPrice: 25,
    amount: 250,
    currency: "USD",
    amountType: "quoted",
    ownerId,
    teamId,
    nextAction: "确认 PI 条款",
    nextActionAt: "2026-07-29T10:00:00.000Z",
    expectedCloseAt: "2026-08-15T10:00:00.000Z",
    stageChangedAt: "2026-07-22T00:00:00.000Z"
  };
  store.deals.unshift(deal);
  return deal;
}

function apiRoute(method: string, path: string, schema: Record<string, unknown>) {
  return { method, path, risk: "write", executable: true, operationId: `${method.toLowerCase()}-${path.replace(/[^a-z0-9]+/giu, "-")}`, parameters: [], requestSchema: JSON.stringify(schema), guidance: "GJAB 受控测试接口" };
}

async function main() {
  const store = isolatedStore();
  const actor = store.users.find((item) => item.id === "u_sales_shirley")!;
  const customer = store.customers.find((item) => item.ownerId === actor.id && item.teamId === actor.teamId)!;
  const deal = addDeal(store, customer.id, actor.id, actor.teamId);

  const plan = await runGjabPlanBenchmark(store, actor, (goal, context) => createAgentPlan(store, actor, goal, context));
  assert.equal(plan.results.length, gjabPlanCases(store, actor).length);
  assert.equal(plan.results.filter((item) => item.passed).length, plan.results.length, JSON.stringify(plan.results));
  assert.ok(plan.results.find((item) => item.id === "deal-create-autofill")?.passed);
  assert.ok(plan.results.find((item) => item.id === "pi-draft-from-deal")?.passed);
  assert.ok(plan.results.find((item) => item.id === "pi-create-export-named-deal")?.passed);

  const hostileStore = isolatedStore();
  const hostileActor = hostileStore.users.find((item) => item.id === actor.id)!;
  hostileStore.aiModelConfigs = [modelConfig(hostileActor.id, hostileActor.teamId)];
  setProviderHttpTestTransport(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "可以，已生成", askUser: "", steps: [{ tool: "api.write", title: "创建客户", input: { method: "POST", path: "/api/customers", body: { company: "GJAB Sanitized", email: "fake@example.com", phone: "+8613800000000", whatsapp: "+8613800000000" } } }] }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    const hostileRun = await createAgentPlan(hostileStore, hostileActor, "帮我生成一个客户，名叫 GJAB Sanitized，其它你编");
    const hostileStep = hostileRun.steps.find((item) => item.tool === "api.write");
    const hostileBody = hostileStep?.input.body as Record<string, unknown>;
    assert.equal(hostileRun.status, "running");
    assert.equal(hostileStep?.status, "ready");
    assert.deepEqual(hostileBody, {
      company: "GJAB Sanitized", country: "未知", contact: "待维护", whatsapp: "", stage: "询盘", amount: 0,
      health: 72, grade: "C", billingName: "GJAB Sanitized", billingAddress: "", documentContact: "待维护",
      defaultPortDischarge: "", defaultIncoterm: "", defaultPaymentTerm: ""
    });

    const resumeStore = isolatedStore();
    const resumeActor = resumeStore.users.find((item) => item.id === actor.id)!;
    const waiting = await createAgentPlan(resumeStore, resumeActor, "新增一个客户");
    assert.equal(waiting.status, "waiting_user");
    resumeStore.aiModelConfigs = [modelConfig(resumeActor.id, resumeActor.teamId)];
    const resumed = await resumeAgentMission(resumeStore, resumeActor, waiting.id, "名称和其它数据都由你自己编");
    assert.ok(resumed);
    const resumedStep = [...resumed.steps].reverse().find((item) => item.tool === "api.write" && item.input.path === "/api/customers");
    assert.ok(resumedStep, JSON.stringify(resumed));
    const resumedBody = resumedStep.input.body as Record<string, unknown>;
    assert.match(String(resumedBody.company), /^AI模拟客户-/u);
    assert.equal(resumedBody.contact, "待维护");
    assert.equal(resumedBody.whatsapp, "");
    assert.equal(resumedBody.email, undefined);

    const steerStore = isolatedStore();
    const steerActor = steerStore.users.find((item) => item.id === actor.id)!;
    const steerBase = await createAgentPlan(steerStore, steerActor, "读取当前商机快照");
    steerStore.aiModelConfigs = [modelConfig(steerActor.id, steerActor.teamId)];
    const steered = await steerAgentMission(steerStore, steerActor, steerBase.id, "改成生成一个客户，名字和其它数据你自己编");
    const steeredBody = steered.steps.at(-1)?.input.body as Record<string, unknown>;
    assert.match(String(steeredBody.company), /^AI模拟客户-/u);
    assert.equal(steeredBody.contact, "待维护");
    assert.equal(steeredBody.whatsapp, "");
    assert.equal(steeredBody.phone, undefined);
  } finally {
    setProviderHttpTestTransport(null);
  }

  const executionStore = isolatedStore();
  const executionActor = executionStore.users.find((item) => item.id === actor.id)!;
  const executionRun = await createAgentPlan(executionStore, executionActor, "生成个客户，名叫 GJAB Persisted，其它你编");
  const executionStep = executionRun.steps.find((item) => item.tool === "api.write")!;
  let createCalls = 0;
  const executeWithEvidence = async () => executeAgentStep(executionStore, executionActor, executionRun.id, executionStep.id, executionStep.signature, false, {
    requestCrmApi: async (_user, input) => {
      createCalls += 1;
      const body = input.body as Record<string, unknown>;
      const customerRecord = { id: "c_gjab_persisted", ...body, ownerId: executionActor.id, teamId: executionActor.teamId };
      executionStore.customers.unshift(customerRecord as typeof executionStore.customers[number]);
      return { status: 200, method: "POST", path: "/api/customers", data: { customer: customerRecord }, uiAction: { type: "refresh", view: "customers" } };
    }
  });
  const executed = await executeWithEvidence();
  assert.equal(executed.steps.find((item) => item.id === executionStep.id)?.status, "done");
  assert.equal(executed.steps.find((item) => item.id === executionStep.id)?.result?.data && "customer" in (executed.steps.find((item) => item.id === executionStep.id)?.result?.data as object), true);
  assert.equal(createCalls, 1);
  await assert.rejects(
    executeAgentStep(executionStore, executionActor, executionRun.id, executionStep.id, executionStep.signature, false),
    /Mission 已停止领取动作/u
  );
  assert.equal(createCalls, 1, "已完成步骤重放不得重复创建客户");
  const customerRuntimeResult = evaluateGjabRuntimeTrajectory({
    id: "customer-create-runtime",
    name: "客户创建端到端闭环",
    run: executed,
    requiredTools: ["api.write"]
  });
  assert.equal(customerRuntimeResult.passed, true, customerRuntimeResult.detail);

  const incompleteStore = isolatedStore();
  const incompleteActor = incompleteStore.users.find((item) => item.id === actor.id)!;
  const incompleteRun = await createAgentPlan(incompleteStore, incompleteActor, "生成一个客户并记录首次跟进，其它数据你看着来");
  const incompleteCreate = incompleteRun.steps.find((item) => item.tool === "api.write")!;
  const incompleteOutcome = await executeAgentStep(
    incompleteStore,
    incompleteActor,
    incompleteRun.id,
    incompleteCreate.id,
    incompleteCreate.signature,
    false,
    {
      requestCrmApi: async (_user, input) => ({
        status: 200,
        method: "POST",
        path: "/api/customers",
        data: { customer: { id: "c_compound_incomplete", ...(input.body as Record<string, unknown>) } }
      })
    }
  );
  assert.equal(incompleteOutcome.status, "failed");
  assert.match(incompleteOutcome.stopReason, /跟进/u);

  const recoveryStore = isolatedStore();
  const recoveryActor = recoveryStore.users.find((item) => item.id === actor.id)!;
  recoveryStore.aiModelConfigs = [modelConfig(recoveryActor.id, recoveryActor.teamId)];
  let recoveryEvaluationRound = 0;
  setProviderHttpTestTransport(async (_url, init) => {
    const request = JSON.parse(String(init.body || "{}")) as { messages?: Array<{ content?: string }> };
    const prompt = request.messages?.map((item) => item.content || "").join("\n") || "";
    const content = prompt.includes("Mission Evaluator")
      ? recoveryEvaluationRound++ === 0
        ? JSON.stringify({ done: false, progress: 45, summary: "首次参数失败，正在按契约修正。", currentAction: "修正待办参数", askUser: "", nextSteps: [{ tool: "crm.create_todo", title: "创建修正后的待办", input: { title: "跟进恢复测试", priority: "high" } }] })
        : JSON.stringify({ done: true, progress: 100, summary: "待办已创建并核验。", currentAction: "", askUser: "", nextSteps: [] })
      : JSON.stringify({ summary: "正在创建待办。", askUser: "", steps: [{ tool: "crm.create_todo", title: "创建缺少标题的待办", input: {} }] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const recoveryRun = await createAgentPlan(recoveryStore, recoveryActor, "创建一个高优先级待办");
    const recoveryRunner = new AgentBackgroundRunner(recoveryStore, {}, 1);
    await recoveryRunner.synchronize();
    const recoveryDone = getAgentRun(recoveryStore, recoveryRun.id, recoveryActor);
    assert.equal(recoveryDone.status, "completed", JSON.stringify(recoveryDone));
    assert.ok(recoveryDone.steps.some((item) => item.status === "skipped" && item.error?.includes("恢复规划替代")));
    assert.ok(recoveryDone.steps.some((item) => item.tool === "crm.create_todo" && item.status === "done"));
    assert.ok(recoveryDone.events.some((item) => item.message.includes("恢复规划已替代")));
  } finally {
    setProviderHttpTestTransport(null);
  }

  const closureStore = isolatedStore();
  const closureActor = closureStore.users.find((item) => item.id === actor.id)!;
  const closureCustomer = closureStore.customers.find((item) => item.ownerId === closureActor.id && item.teamId === closureActor.teamId)!;
  const closureDeal = addDeal(closureStore, closureCustomer.id, closureActor.id, closureActor.teamId);
  closureStore.aiModelConfigs = [modelConfig(closureActor.id, closureActor.teamId)];
  let evaluationRound = 0;
  let writtenDocument: TradeDocument | undefined;
  let piRuntimeResult: ReturnType<typeof evaluateGjabRuntimeTrajectory> | undefined;
  const documentContract = agentApiBusinessContract("POST", "/api/trade-documents")!;
  setProviderHttpTestTransport(async (_url, init) => {
    const request = JSON.parse(String(init.body || "{}")) as { messages?: Array<{ content?: string }> };
    const prompt = request.messages?.map((item) => item.content || "").join("\n") || "";
    const content = prompt.includes("Mission Evaluator")
      ? evaluationRound++ === 0
        ? JSON.stringify({ done: false, progress: 45, summary: "已读取 PI 接口契约，准备保存草稿。", currentAction: "保存 PI 草稿", askUser: "", nextSteps: [{ tool: "api.write", title: "保存 PI 草稿", input: { method: "POST", path: "/api/trade-documents", query: {}, body: { customerId: closureCustomer.id, dealId: closureDeal.id, revision: 1, type: "PI", title: `${closureDeal.title} PI`, number: "PI-GJAB-001", issueDate: "2026-07-22", buyer: closureCustomer.company, buyerAddress: "", buyerContact: closureCustomer.contact, seller: "GJAB Seller", sellerAddress: "", currency: closureDeal.currency, incoterm: "FOB", paymentTerm: "待确认", shippingMethod: "", portLoading: "", portDischarge: "", validityDate: "", bankInfo: "", notes: "GJAB PI 草稿", templateStyle: "executive", status: "draft", approvalNote: "", approvedAt: "", approvedBy: "", audits: [], sendRecords: [], items: [{ id: "item-1", product: closureDeal.product, model: "", hsCode: "", quantity: closureDeal.quantity, unit: "件", unitPrice: closureDeal.unitPrice, originCountry: "", weightKg: 0, packageCount: 0 }] } } }] })
        : evaluationRound === 2
          ? JSON.stringify({ done: false, progress: 70, summary: "PI 草稿已保存，正在核验单据编号。", currentAction: "核验 PI 草稿", askUser: "", nextSteps: [{ tool: "api.read", title: "核验 PI 草稿", input: { method: "GET", path: "/api/trade-documents", query: { id: writtenDocument?.id || "" } } }] })
          : JSON.stringify({ done: true, progress: 100, summary: "PI 草稿已创建并核验。", currentAction: "", askUser: "", nextSteps: [] })
      : JSON.stringify({ summary: "先读取真实 PI 接口契约，再保存草稿并核验结果。", askUser: "", steps: [{ tool: "api.catalog", title: "读取 PI 接口契约", input: { query: "trade-documents", method: "POST", limit: 30 } }] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  try {
    const run = await createAgentPlan(closureStore, closureActor, "根据当前商机生成一份 PI 草稿，保存到单据平台", { selectedCustomerId: closureCustomer.id, selectedDealId: closureDeal.id, activeView: "pipeline" });
    const runner = new AgentBackgroundRunner(closureStore, {
      listCrmApiCatalog: async () => ({ count: 1, total: 1, offset: 0, hasMore: false, routes: [apiRoute("POST", "/api/trade-documents", documentContract.schema as Record<string, unknown>)] }),
      requestCrmApi: async (_user, input, tool) => {
        if (tool === "api.read") return { status: 200, method: "GET", path: "/api/trade-documents", data: { document: writtenDocument } };
        const body = input.body as Record<string, unknown>;
        writtenDocument = { id: "td_gjab_pi", ...body, ownerId: closureActor.id, teamId: closureActor.teamId, updatedAt: new Date().toISOString() } as unknown as TradeDocument;
        closureStore.tradeDocuments.unshift(writtenDocument);
        return { status: 200, method: "POST", path: "/api/trade-documents", data: { document: writtenDocument }, uiAction: { type: "refresh", view: "documents" } };
      }
    }, 1);
    await runner.synchronize();
    await runner.synchronize();
    const done = getAgentRun(closureStore, run.id, closureActor);
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.equal(writtenDocument?.id, "td_gjab_pi");
    assert.equal(writtenDocument?.type, "PI");
    assert.equal(writtenDocument?.dealId, closureDeal.id);
    assert.ok(done.events.some((item) => item.message.includes("无需再调用模型评估")));
    piRuntimeResult = evaluateGjabRuntimeTrajectory({
      id: "pi-draft-runtime",
      name: "PI 草稿端到端闭环",
      run: done,
      requiredTools: ["api.write"]
    });
    assert.equal(piRuntimeResult.passed, true, piRuntimeResult.detail);
  } finally {
    setProviderHttpTestTransport(null);
  }

  const kantoStore = isolatedStore();
  const kantoActor = kantoStore.users.find((item) => item.id === actor.id)!;
  kantoActor.role = "manager";
  const kantoCustomer = kantoStore.customers.find((item) => item.ownerId === kantoActor.id && item.teamId === kantoActor.teamId)!;
  kantoCustomer.company = "Kanto Retail";
  const kantoDeal = addDeal(kantoStore, kantoCustomer.id, kantoActor.id, kantoActor.teamId);
  kantoDeal.title = "Kanto Retail 需求商机";
  kantoDeal.product = "工业组件 IC-300";
  kantoDeal.quantity = 80;
  kantoDeal.unitPrice = 600;
  kantoDeal.amount = 48_000;
  kantoStore.aiModelConfigs = [modelConfig(kantoActor.id, kantoActor.teamId)];
  let kantoDocument: TradeDocument | undefined;
  let piDownloadRuntimeResult: ReturnType<typeof evaluateGjabRuntimeTrajectory> | undefined;
  const kantoContracts = [
    ["/api/trade-documents", agentApiBusinessContract("POST", "/api/trade-documents")!],
    ["/api/trade-documents/{id}/submit-approval", agentApiBusinessContract("POST", "/api/trade-documents/{id}/submit-approval")!],
    ["/api/trade-documents/{id}/approve", agentApiBusinessContract("POST", "/api/trade-documents/{id}/approve")!],
    ["/api/trade-documents/{id}/export", agentApiBusinessContract("POST", "/api/trade-documents/{id}/export")!]
  ] as const;
  setProviderHttpTestTransport(async (_url, init) => {
    const request = JSON.parse(String(init.body || "{}")) as { messages?: Array<{ content?: string }> };
    const prompt = request.messages?.map((item) => item.content || "").join("\n") || "";
    let content: string;
    if (!prompt.includes("Mission Evaluator")) {
      content = `${JSON.stringify({ summary: "先读取贸易单据状态流转契约，再完成 PI 制作和导出。", askUser: "", steps: [{ tool: "api.catalog", title: "读取 PI 创建、审批与导出接口", input: { query: "trade-documents", method: "POST", limit: 30 } }] })}\n补充说明：已完成语义拆解。`;
    } else if (!kantoDocument) {
      content = JSON.stringify({
        done: false,
        progress: 30.4,
        summary: "接口契约已读取，正在按依赖关系完成 PI 创建、审批和导出。",
        currentAction: "创建并导出 PI",
        askUser: "",
        nextSteps: [
          { key: "create_pi", dependsOn: [], tool: "api.write", title: "创建 Kanto Retail PI", input: { method: "POST", path: "/api/trade-documents", query: {}, body: { customerId: kantoCustomer.id, dealId: kantoDeal.id, revision: 1, type: "PI", title: `${kantoDeal.title} PI`, number: "PI-KANTO-001", issueDate: "2026-07-24", buyer: kantoCustomer.company, buyerAddress: "", buyerContact: kantoCustomer.contact, seller: "GJAB Seller", sellerAddress: "", currency: "USD", incoterm: "FOB", paymentTerm: "待确认", shippingMethod: "", portLoading: "", portDischarge: "", validityDate: "", bankInfo: "", notes: "待业务员核验", templateStyle: "executive", status: "ready", approvalNote: "", approvedAt: "", approvedBy: "", audits: [], sendRecords: [], items: [{ id: "item-1", product: kantoDeal.product, model: "", hsCode: "", quantity: kantoDeal.quantity, unit: "件", unitPrice: kantoDeal.unitPrice, originCountry: "", weightKg: 0, packageCount: 0 }] } } },
          { key: "submit_pi", dependsOn: ["create_pi"], tool: "api.write", title: "提交 PI 审批", input: { method: "POST", path: "/api/trade-documents/{{step:create_pi:data.document.id}}/submit-approval", query: {}, body: { note: "按用户下载目标推进" } } },
          { key: "approve_pi", dependsOn: ["submit_pi"], tool: "api.write", title: "审批通过 PI", input: { method: "POST", path: "/api/trade-documents/{{step:create_pi:data.document.id}}/approve", query: {}, body: { note: "测试审批" } } },
          { key: "export_pi", dependsOn: ["approve_pi"], tool: "api.write", title: "导出 PI PDF", input: { method: "POST", path: "/api/trade-documents/{{step:create_pi:data.document.id}}/export", query: {}, body: {} } }
        ]
      });
    } else {
      content = `${JSON.stringify({ done: true, progress: 100, summary: "Kanto Retail PI 已创建并导出，可下载。", currentAction: "", askUser: "", nextSteps: [] })}\n核验结束。`;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const run = await createAgentPlan(kantoStore, kantoActor, "帮我给 Kanto Retail 的需求商机制作一个 PI，并下载", { activeView: "pipeline" });
    const runner = new AgentBackgroundRunner(kantoStore, {
      listCrmApiCatalog: async () => ({ count: kantoContracts.length, total: kantoContracts.length, offset: 0, hasMore: false, routes: kantoContracts.map(([path, contract]) => apiRoute("POST", path, contract.schema as Record<string, unknown>)) }),
      requestCrmApi: async (_user, input) => {
        const path = String(input.path || "");
        if (path === "/api/trade-documents") {
          kantoDocument = { id: "td_kanto_pi", ...(input.body as Record<string, unknown>), ownerId: kantoActor.id, teamId: kantoActor.teamId, updatedAt: new Date().toISOString() } as unknown as TradeDocument;
          kantoStore.tradeDocuments.unshift(kantoDocument);
          return { status: 200, method: "POST", path, data: { document: kantoDocument } };
        }
        if (!kantoDocument) throw new Error("PI 尚未创建");
        if (path.endsWith("/submit-approval")) kantoDocument.status = "pending_approval";
        else if (path.endsWith("/approve")) kantoDocument.status = "approved";
        else if (path.endsWith("/export")) {
          kantoDocument.status = "exported";
          return { status: 200, method: "POST", path, data: { document: kantoDocument, job: { id: "io_kanto_pi" }, fileName: "PI-KANTO-001-PI.pdf" } };
        }
        return { status: 200, method: "POST", path, data: { document: kantoDocument } };
      }
    }, 1);
    for (let index = 0; index < 10; index += 1) await runner.synchronize();
    const done = getAgentRun(kantoStore, run.id, kantoActor);
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.deepEqual(done.goalSpec?.objectives.map((item) => `${item.action}:${item.domain}`), ["create:documents", "export:documents"]);
    assert.ok(done.steps.some((item) => String(item.input.path || "").endsWith("/export") && item.status === "done"), JSON.stringify(done.steps));
    assert.equal(done.steps.find((item) => item.key === "export_pi")?.input.path, "/api/trade-documents/td_kanto_pi/export");
    assert.ok(done.events.some((item) => item.message.includes("真实前置结果生成最终执行参数")));
    assert.ok(!done.steps.some((item) => item.tool === "crm.get_pipeline_snapshot"));
    piDownloadRuntimeResult = evaluateGjabRuntimeTrajectory({ id: "pi-download-runtime", name: "指定商机 PI 制作下载闭环", run: done, requiredTools: ["api.write"] });
    assert.equal(piDownloadRuntimeResult.passed, true, piDownloadRuntimeResult.detail);
  } finally {
    setProviderHttpTestTransport(null);
  }

  const emptyEvaluationStore = isolatedStore();
  const emptyEvaluationActor = emptyEvaluationStore.users.find((item) => item.id === "u_admin")!;
  emptyEvaluationStore.aiModelConfigs = [modelConfig(emptyEvaluationActor.id, emptyEvaluationActor.teamId)];
  const nordicCustomer = emptyEvaluationStore.customers.find((item) => item.company === "Nordic Tools AB")!;
  let emptyEvaluationDocument: TradeDocument | undefined;
  let emptyEvaluationCalls = 0;
  setProviderHttpTestTransport(async (_url, init) => {
    const request = JSON.parse(String(init.body || "{}")) as { messages?: Array<{ content?: string }> };
    const prompt = request.messages?.map((item) => item.content || "").join("\n") || "";
    if (prompt.includes("Mission Evaluator")) {
      emptyEvaluationCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      summary: "先读取 Nordic Tools AB 的真实客户和商机。",
      askUser: "",
      steps: [{ key: "read_nordic", dependsOn: [], tool: "crm.get_customer_overview", title: "读取 Nordic Tools AB 客户和活跃商机", input: { customerId: nordicCustomer.id } }]
    }) }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const run = await createAgentPlan(emptyEvaluationStore, emptyEvaluationActor, "帮我给客户 Nordic Tools AB 的活跃商机做一个PI");
    const runner = new AgentBackgroundRunner(emptyEvaluationStore, {
      requestCrmApi: async (_user, input) => {
        const path = String(input.path || "");
        if (path === "/api/trade-documents") {
          emptyEvaluationDocument = {
            id: "td_nordic_empty_evaluation",
            ...(input.body as Record<string, unknown>),
            status: "ready",
            ownerId: emptyEvaluationActor.id,
            teamId: emptyEvaluationActor.teamId,
            updatedAt: new Date().toISOString()
          } as unknown as TradeDocument;
          emptyEvaluationStore.tradeDocuments.unshift(emptyEvaluationDocument);
          return { status: 200, method: "POST", path, data: { document: emptyEvaluationDocument } };
        }
        if (!emptyEvaluationDocument) throw new Error("PI 尚未创建");
        if (path.endsWith("/submit-approval")) emptyEvaluationDocument.status = "pending_approval";
        else if (path.endsWith("/approve")) emptyEvaluationDocument.status = "approved";
        else if (path.endsWith("/export")) {
          emptyEvaluationDocument.status = "exported";
          return { status: 200, method: "POST", path, data: { document: emptyEvaluationDocument, job: { id: "io_nordic_pi" }, fileName: "PI-NORDIC-001-PI.pdf" } };
        }
        return { status: 200, method: "POST", path, data: { document: emptyEvaluationDocument } };
      }
    }, 1);
    for (let index = 0; index < 8; index += 1) await runner.synchronize();
    const done = getAgentRun(emptyEvaluationStore, run.id, emptyEvaluationActor);
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.equal(emptyEvaluationDocument?.id, "td_nordic_empty_evaluation", JSON.stringify(done));
    assert.equal(emptyEvaluationCalls, 2, `only the pre-creation evaluation and its single repair retry should run, got ${emptyEvaluationCalls}`);
    assert.ok(done.steps.some((item) => String(item.input.path || "").endsWith("/export") && item.status === "done"));
    assert.ok(done.events.some((item) => item.message.includes("无需再调用模型评估")));
    assert.equal(done.stopReason, "目标已通过服务端完成证据核验");
  } finally {
    setProviderHttpTestTransport(null);
  }

  const runtimeMetrics = aggregateGjabRuntimeMetrics([customerRuntimeResult, piRuntimeResult!, piDownloadRuntimeResult!]);
  assert.equal(runtimeMetrics.taskSuccessRate, 100);
  assert.equal(runtimeMetrics.outcomeVerificationRate, 100);
  assert.equal(runtimeMetrics.falseCompletionCount, 0);
  console.log(JSON.stringify({ ok: true, suite: "GJAB", planCases: plan.results.length, planPassed: plan.results.length, runtimeMetrics, prematureCompletionBlocked: true, failedStepRecovery: true, emptyEvaluationDeterministicRecovery: true, piClosedLoop: true, dealId: deal.id }));
}

await main();
