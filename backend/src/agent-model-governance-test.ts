import assert from "node:assert/strict";
import { agentModelCandidates, agentModelMetrics, callGovernedAgentModel, runAgentEvaluationSuite } from "./agent-model-governance.js";
import { AgentBackgroundRunner, createAgentPlan, getAgentRun } from "./ai-agent.js";
import { memoryStore, type CrmStore } from "./store.js";
import type { AiModelConfig } from "./types.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";

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

function config(id: string, model: string, updatedAt: string): AiModelConfig {
  return { id, provider: "custom", protocol: "openai-compatible", name: model, baseUrl: `https://${id}.example/v1`, model, apiKey: "test-key", enabled: true, temperature: 0.1, useLeadFinder: true, useWebsiteParse: true, useScoring: true, useEmailDraft: true, useExam: false, ownerId: "u_sales_shirley", teamId: "europe", updatedAt };
}

async function main() {
  const store = isolatedStore();
  const actor = store.users.find((item) => item.id === "u_sales_shirley")!;
  const other = store.users.find((item) => item.id === "u_sales_mia")!;
  const primary = config("model-primary", "primary-model", "2026-07-20T02:00:00.000Z");
  const fallback = config("model-fallback", "fallback-model", "2026-07-20T01:00:00.000Z");
  store.aiModelConfigs = [primary, fallback];
  assert.deepEqual(agentModelCandidates(store, actor, "planning", primary).map((item) => item.id), [primary.id, fallback.id]);
  assert.equal(agentModelCandidates(store, other, "planning").length, 0);

  const requested: string[] = [];
  const content = await callGovernedAgentModel({
    store,
    actor,
    runId: "mission-routing-test",
    purpose: "planning",
    preferred: primary,
    prompt: "只返回 JSON",
    maxInputChars: 2_000,
    fetcher: async (url) => {
      requested.push(url);
      if (url.includes("model-primary")) return new Response(JSON.stringify({ error: { message: "primary unavailable" } }), { status: 503, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(content, "{\"ok\":true}");
  assert.equal(requested.length, 2);
  assert.equal(store.agentModelCalls.length, 2);
  assert.equal(store.agentModelCalls[0]?.success, true);
  assert.equal(store.agentModelCalls[0]?.routeIndex, 1);
  assert.equal(store.agentModelCalls[1]?.success, false);
  assert.ok(store.agentModelCalls[0]!.inputTokens > 0);
  assert.ok(store.agentModelCalls[0]!.estimatedCostUsd > 0);

  const metrics = agentModelMetrics(store, actor);
  assert.equal(metrics.last24Hours.calls, 2);
  assert.equal(metrics.last24Hours.successes, 1);
  assert.equal(metrics.last24Hours.fallbackCalls, 1);
  assert.equal(agentModelMetrics(store, other).last24Hours.calls, 0);

  setProviderHttpTestTransport(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      summary: "先读取真实客户接口，再决定写入参数。",
      askUser: "",
      steps: [{ tool: "api.catalog", title: "AI 读取客户接口", input: { query: "customers", limit: 20 } }]
    }) } }]
  }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    const aiFirstRun = await createAgentPlan(store, actor, "新增一个客户，公司名称为 Model Priority Ltd");
    assert.equal(aiFirstRun.steps[0]?.tool, "api.catalog");
    assert.equal(aiFirstRun.steps[0]?.title, "AI 读取客户接口");
    assert.ok(aiFirstRun.events.some((item) => item.message.includes("当前模型生成计划")));
  } finally {
    setProviderHttpTestTransport(null);
  }

  const delegatedStore = isolatedStore();
  const delegatedActor = delegatedStore.users.find((item) => item.id === actor.id)!;
  delegatedStore.aiModelConfigs = [primary];
  setProviderHttpTestTransport(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      summary: "还缺少公司名称和联系人。",
      askUser: "请提供公司名称和联系人。",
      steps: []
    }) } }]
  }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    const delegatedRun = await createAgentPlan(delegatedStore, delegatedActor, "帮我生成一个客户，数据你看着来");
    assert.equal(delegatedRun.status, "running");
    assert.equal(delegatedRun.stopReason, "");
    assert.equal(delegatedRun.steps[0]?.tool, "api.write");
    assert.equal(delegatedRun.steps[0]?.status, "ready");
    assert.match(String((delegatedRun.steps[0]?.input.body as { company?: string })?.company), /^AI模拟客户-/u);
    assert.ok(delegatedRun.steps[0]?.approvedAt);
  } finally {
    setProviderHttpTestTransport(null);
  }

  const closureStore = isolatedStore();
  const closureActor = closureStore.users.find((item) => item.id === actor.id)!;
  closureStore.aiModelConfigs = [primary];
  let evaluatorCalls = 0;
  let customerWrites = 0;
  setProviderHttpTestTransport(async (_url, init) => {
    const request = JSON.parse(String(init.body || "{}")) as { messages?: Array<{ content?: string }> };
    const prompt = request.messages?.map((item) => item.content || "").join("\n") || "";
    const evaluationRound = prompt.includes("Mission Evaluator") ? evaluatorCalls++ : -1;
    const content = evaluationRound === 0
      ? JSON.stringify({ done: true, progress: 100, summary: "接口已读取，任务完成。", currentAction: "", askUser: "", nextSteps: [] })
      : evaluationRound === 1
        ? JSON.stringify({
            done: false,
            progress: 55,
            summary: "接口契约已读取，正在按约束创建客户。",
            currentAction: "调用客户新增接口",
            askUser: "",
            nextSteps: [{ tool: "api.write", title: "创建客户 goodjob01", input: { method: "POST", path: "/api/customers", query: {}, body: { company: "goodjob01", country: "未知", contact: "待维护", whatsapp: "", stage: "询盘", amount: 0, health: 72, grade: "C" } } }]
          })
        : evaluationRound >= 2
          ? JSON.stringify({ done: true, progress: 100, summary: "客户 goodjob01 已创建并核验。", currentAction: "", askUser: "", nextSteps: [] })
          : JSON.stringify({
          summary: "我会先读取客户接口契约，再按你的授权补齐安全默认值并创建。",
          askUser: "",
          steps: [{ tool: "api.write", title: "创建客户 goodjob01", input: { method: "POST", path: "/api/customers", query: {}, body: { company: "goodjob01" } } }]
        });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const closureRun = await createAgentPlan(closureStore, closureActor, "生成个客户，名叫goodjob01，其它你编");
    assert.equal(closureRun.steps[0]?.tool, "api.write");
    const runner = new AgentBackgroundRunner(closureStore, {
      requestCrmApi: async (_actor, input) => {
        customerWrites += 1;
        assert.deepEqual(input.body, {
          company: "goodjob01", country: "未知", contact: "待维护", whatsapp: "", stage: "询盘", amount: 0,
          health: 72, grade: "C", billingName: "goodjob01", billingAddress: "", documentContact: "待维护",
          phone: "", email: "", website: "",
          defaultPortDischarge: "", defaultIncoterm: "", defaultPaymentTerm: ""
        });
        return { status: 200, method: "POST", path: "/api/customers", data: { customer: { id: "c_goodjob01", ...input.body } }, uiAction: { type: "refresh", view: "customers" } };
      }
    }, 1);
    await runner.synchronize();
    const closureDone = getAgentRun(closureStore, closureRun.id, closureActor);
    assert.equal(closureDone.status, "completed");
    assert.equal(customerWrites, 1);
    assert.ok(closureDone.events.some((item) => item.message.includes("无需再调用模型评估")));
    const createStep = closureDone.steps.find((item) => item.tool === "api.write");
    assert.equal(createStep?.status, "done");
    assert.ok(createStep?.approvedAt);
    assert.equal((createStep?.result?.data as { customer?: { id?: string } } | undefined)?.customer?.id, "c_goodjob01");
  } finally {
    setProviderHttpTestTransport(null);
  }

  const evidenceFallbackStore = isolatedStore();
  const evidenceFallbackActor = evidenceFallbackStore.users.find((item) => item.id === actor.id)!;
  evidenceFallbackStore.aiModelConfigs = [primary];
  let evidenceFallbackWrites = 0;
  setProviderHttpTestTransport(async (_url, init) => {
    const request = JSON.parse(String(init.body || "{}")) as { messages?: Array<{ content?: string }> };
    const prompt = request.messages?.map((item) => item.content || "").join("\n") || "";
    const content = prompt.includes("Mission Evaluator")
      ? ""
      : JSON.stringify({ summary: "正在创建客户。", askUser: "", steps: [] });
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  try {
    const evidenceFallbackRun = await createAgentPlan(
      evidenceFallbackStore,
      evidenceFallbackActor,
      "生成个客户，名叫 EvidenceFallback Ltd，其它你编"
    );
    const runner = new AgentBackgroundRunner(evidenceFallbackStore, {
      requestCrmApi: async (_actor, input) => {
        evidenceFallbackWrites += 1;
        return {
          status: 200,
          method: "POST",
          path: "/api/customers",
          data: { customer: { id: "c_evidence_fallback", ...(input.body as Record<string, unknown>) } },
          completionEvidence: { type: "created_object_id", responsePaths: ["customer.id"] },
          uiAction: { type: "refresh", view: "customers" }
        };
      }
    }, 1);
    await runner.synchronize();
    const evidenceFallbackDone = getAgentRun(evidenceFallbackStore, evidenceFallbackRun.id, evidenceFallbackActor);
    assert.equal(evidenceFallbackWrites, 1);
    assert.equal(evidenceFallbackDone.status, "completed");
    assert.equal(evidenceFallbackDone.progress, 100);
    assert.match(evidenceFallbackDone.stopReason, /服务端完成证据/u);
    assert.ok(evidenceFallbackDone.events.some((item) => item.message.includes("确定性") || item.message.includes("完成证据")));
  } finally {
    setProviderHttpTestTransport(null);
  }

  store.aiModelConfigs = [];
  const customer = store.customers.find((item) => item.ownerId === actor.id)!;
  customer.whatsapp = "+46701234567";
  const evaluation = await runAgentEvaluationSuite(store, actor, (goal, context) => createAgentPlan(store, actor, goal, context));
  assert.equal(evaluation.total, 10);
  assert.ok(evaluation.results.find((item) => item.id === "intent-corpus-v1")?.passed);
  assert.equal(evaluation.passed, evaluation.total, JSON.stringify(evaluation.results));
  assert.equal(store.agentRuns.length, 1);
  assert.equal(store.agentEvaluationRuns.length, 1);

  const budgetStore = isolatedStore();
  budgetStore.aiModelConfigs = [primary];
  budgetStore.agentModelCalls.push({ id: "spent", runId: "other", ownerId: actor.id, teamId: actor.teamId, purpose: "planning", configId: primary.id, provider: primary.provider, model: primary.model, routeIndex: 0, success: true, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 10, latencyMs: 1, error: "", createdAt: new Date().toISOString() });
  await assert.rejects(() => callGovernedAgentModel({ store: budgetStore, actor, runId: "budget-test", purpose: "planning", preferred: primary, prompt: "test", maxInputChars: 100, fetcher: async () => new Response("{}") }), /预算已用尽/u);

  console.log(JSON.stringify({ ok: true, purposeRouting: true, aiPlanningPriority: true, catalogFirstClosedLoop: true, authorizedInternalCreate: true, completionEvidenceGate: true, evaluationEvidenceFallback: true, fallback: true, callAudit: true, tokenCostEstimate: true, accountIsolation: true, budgetGuard: true, fixedSafetySuite: true }, null, 2));
}

void main();
