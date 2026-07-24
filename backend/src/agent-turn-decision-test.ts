import assert from "node:assert/strict";
import { createAgentPlan, resolveAgentTurnDecision } from "./ai-agent.js";
import {
  deterministicAgentTurnDecision,
  finalizeAgentTurnDecision,
  resolveAgentMissionRoute,
  type AgentMissionContextSnapshot
} from "./agent-turn-decision.js";
import { memoryStore, type CrmStore } from "./store.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import type { AiModelConfig } from "./types.js";

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
  store.aiModelConfigs = [];
  store.persist = async () => {};
  return store;
}

function modelConfig(ownerId: string, teamId: string): AiModelConfig {
  return {
    id: "turn-model",
    provider: "custom",
    protocol: "openai-compatible",
    name: "Turn resolver test model",
    baseUrl: "https://turn-resolver.example/v1",
    model: "turn-resolver-test",
    apiKey: "turn-resolver-test-key",
    enabled: true,
    temperature: 0,
    useLeadFinder: true,
    useWebsiteParse: true,
    useScoring: true,
    useEmailDraft: true,
    useExam: false,
    ownerId,
    teamId,
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
}

const waitingCustomerMission: AgentMissionContextSnapshot = {
  id: "agr_waiting_customer",
  goal: "帮我创建一个客户",
  status: "waiting_user",
  stopReason: "请提供客户名称",
  topic: "customers",
  updatedAt: "2026-07-24T00:00:00.000Z"
};

const howToCreate = deterministicAgentTurnDecision("如何创建客户？", [waitingCustomerMission]);
assert.equal(howToCreate.speechAct, "explain");
assert.equal(howToCreate.relationToMission, "independent");
assert.equal(howToCreate.writeAuthorized, false);

const askAgentName = deterministicAgentTurnDecision("你叫什么名字？", [waitingCustomerMission]);
assert.equal(askAgentName.speechAct, "chat");
assert.equal(askAgentName.relationToMission, "independent");
assert.equal(askAgentName.writeAuthorized, false);

const dealCapabilities = deterministicAgentTurnDecision("商机能干什么", [waitingCustomerMission]);
assert.equal(dealCapabilities.speechAct, "explain");
assert.equal(dealCapabilities.topic, "deals");
assert.equal(dealCapabilities.writeAuthorized, false);

const requiredFields = deterministicAgentTurnDecision("创建客户需要什么资料？", [waitingCustomerMission]);
assert.equal(requiredFields.speechAct, "explain");
assert.equal(requiredFields.writeAuthorized, false);

const executeCreate = deterministicAgentTurnDecision("能不能帮我创建一个客户？", []);
assert.equal(executeCreate.speechAct, "execute");
assert.equal(executeCreate.writeAuthorized, true);

const executePi = deterministicAgentTurnDecision("帮我给客户 Nordic Tools AB 的活跃商机做一个PI", []);
assert.equal(executePi.speechAct, "execute");
assert.equal(executePi.topic, "documents");
assert.equal(executePi.writeAuthorized, true);

const explainPi = deterministicAgentTurnDecision("PI 是做什么的？", []);
assert.equal(explainPi.speechAct, "explain");
assert.equal(explainPi.topic, "documents");
assert.equal(explainPi.writeAuthorized, false);

const newDealTopic = deterministicAgentTurnDecision("商机怎么管理？", [waitingCustomerMission]);
assert.equal(newDealTopic.speechAct, "explain");
assert.equal(newDealTopic.topic, "deals");
assert.equal(newDealTopic.relationToMission, "independent");
assert.equal(resolveAgentMissionRoute(newDealTopic, waitingCustomerMission), "new");

const slotAnswer = deterministicAgentTurnDecision("客户名称叫 GoodJob 01，其他资料你编", [waitingCustomerMission]);
assert.equal(slotAnswer.speechAct, "answer_slot");
assert.equal(slotAnswer.relationToMission, "answer");
assert.equal(slotAnswer.missionId, waitingCustomerMission.id);
assert.equal(slotAnswer.writeAuthorized, true);
assert.equal(slotAnswer.delegatedFieldSynthesis, true);
assert.equal(resolveAgentMissionRoute(slotAnswer, waitingCustomerMission), "resume");

const explicitContinue = deterministicAgentTurnDecision("继续刚才的任务，其他资料你编", [waitingCustomerMission]);
assert.equal(explicitContinue.speechAct, "continue");
assert.equal(explicitContinue.relationToMission, "continue");
assert.equal(resolveAgentMissionRoute(explicitContinue, { ...waitingCustomerMission, status: "running" }), "keep_running");

const readOnlyOverride = deterministicAgentTurnDecision("不要创建客户，只告诉我操作步骤", [waitingCustomerMission]);
assert.equal(readOnlyOverride.speechAct, "explain");
assert.equal(readOnlyOverride.writeAuthorized, false);

const unsafeModelUpgrade = finalizeAgentTurnDecision("如何创建客户？", [waitingCustomerMission], {
  speechAct: "execute",
  relationToMission: "continue",
  missionId: waitingCustomerMission.id,
  writeAuthorized: true,
  intentConfidence: 0.99,
  missionRelationConfidence: 0.99,
  entityConfidence: 0.99
});
assert.equal(unsafeModelUpgrade.speechAct, "explain");
assert.equal(unsafeModelUpgrade.relationToMission, "independent");
assert.equal(unsafeModelUpgrade.writeAuthorized, false);

const modelUnderstandsNewExpression = finalizeAgentTurnDecision("替 Alex 建档，资料按合理默认值处理", [], {
  speechAct: "execute",
  topic: "customers",
  operation: "create",
  target: "Alex 客户档案",
  relationToMission: "independent",
  missionId: "",
  writeAuthorized: true,
  delegatedFieldSynthesis: true,
  intentConfidence: 0.93,
  missionRelationConfidence: 0.98,
  entityConfidence: 0.88,
  reason: "建档在 CRM 语境中表示创建客户档案"
});
assert.equal(modelUnderstandsNewExpression.speechAct, "execute");
assert.equal(modelUnderstandsNewExpression.writeAuthorized, true);
assert.equal(modelUnderstandsNewExpression.decidedBy, "model+runtime");

const crossTopicModelMistake = finalizeAgentTurnDecision("给我看看商机管道", [waitingCustomerMission], {
  speechAct: "query_data",
  topic: "deals",
  operation: "read",
  target: "商机管道",
  relationToMission: "continue",
  missionId: waitingCustomerMission.id,
  writeAuthorized: false,
  intentConfidence: 0.94,
  missionRelationConfidence: 0.72,
  entityConfidence: 0.92,
  reason: "错误地关联了上一任务"
});
assert.equal(crossTopicModelMistake.relationToMission, "independent");
assert.equal(crossTopicModelMistake.missionId, "");

const store = isolatedStore();
const actor = store.users.find((item) => item.status === "active")!;
const consultationRun = await createAgentPlan(store, actor, "如何创建客户？", {
  conversationId: "agc_turn_semantics",
  evaluationMode: true,
  missionSnapshots: [waitingCustomerMission]
});
assert.equal(consultationRun.status, "completed");
assert.equal(consultationRun.steps.length, 0);
assert.ok(consultationRun.events.some((item) => item.message.includes('"speechAct":"explain"')));
assert.equal(store.agentRunSteps.filter((item) => item.runId === consultationRun.id).length, 0);

const identityRun = await createAgentPlan(store, actor, "你叫什么名字？", {
  conversationId: "agc_agent_identity",
  evaluationMode: true,
  missionSnapshots: [waitingCustomerMission]
});
assert.equal(identityRun.status, "completed");
assert.equal(identityRun.steps.length, 0);
assert.match(identityRun.summary, /Kevin/u);

const capabilityRun = await createAgentPlan(store, actor, "商机能干什么", {
  conversationId: "agc_deal_capabilities",
  evaluationMode: true,
  missionSnapshots: [waitingCustomerMission]
});
assert.equal(capabilityRun.status, "completed");
assert.equal(capabilityRun.steps.length, 0);
assert.match(capabilityRun.summary, /销售管道|成交/u);

const knowledgeFallbackRun = await createAgentPlan(store, actor, "客户健康度是什么意思", {
  conversationId: "agc_consultation_knowledge_fallback",
  evaluationMode: true
});
assert.equal(knowledgeFallbackRun.steps.length, 0);
assert.doesNotMatch(knowledgeFallbackRun.summary, /你好，我在|暂时没有形成有效回答/u);
assert.match(knowledgeFallbackRun.summary, /客户|健康/u);

const queryRun = await createAgentPlan(store, actor, "查看当前客户情况", {
  conversationId: "agc_turn_query",
  evaluationMode: true
});
assert.ok(queryRun.steps.length > 0);
assert.ok(queryRun.steps.every((item) => item.risk === "read"));

const modelStore = isolatedStore();
const modelActor = modelStore.users.find((item) => item.status === "active")!;
modelStore.aiModelConfigs = [modelConfig(modelActor.id, modelActor.teamId)];
let modelDecisionPayload: Record<string, unknown> = {
  speechAct: "execute",
  topic: "customers",
  operation: "create",
  target: "Alex 客户档案",
  relationToMission: "independent",
  missionId: "",
  writeAuthorized: true,
  delegatedFieldSynthesis: true,
  intentConfidence: 0.95,
  missionRelationConfidence: 0.98,
  entityConfidence: 0.9,
  evidenceTurnIds: [],
  reason: "理解建档为创建客户档案"
};
let planningCall = 0;
let conversationReplyPayload: Record<string, unknown> = {
  summary: "我会在当前权限范围内处理：商机能干什么",
  askUser: "",
  steps: []
};
let conversationReviewPayload: Record<string, unknown> = conversationReplyPayload;
setProviderHttpTestTransport(async () => {
  planningCall += 1;
  const content = planningCall === 1
    ? JSON.stringify(modelDecisionPayload)
    : planningCall === 2
      ? JSON.stringify(conversationReplyPayload)
      : JSON.stringify(conversationReviewPayload);
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
});
try {
  const modelFirstDecision = await resolveAgentTurnDecision(modelStore, modelActor, "替 Alex 建档，资料按合理默认值处理");
  assert.equal(modelFirstDecision.decidedBy, "model+runtime");
  assert.equal(modelFirstDecision.speechAct, "execute");
  assert.equal(modelFirstDecision.writeAuthorized, true);

  modelDecisionPayload = {
    ...modelDecisionPayload,
    speechAct: "execute",
    relationToMission: "continue",
    missionId: waitingCustomerMission.id,
    writeAuthorized: true,
    reason: "错误地把咨询识别成执行"
  };
  planningCall = 0;
  const consultationProtected = await resolveAgentTurnDecision(
    modelStore,
    modelActor,
    "如何创建客户？",
    [waitingCustomerMission]
  );
  assert.equal(consultationProtected.decidedBy, "model+runtime");
  assert.equal(consultationProtected.speechAct, "explain");
  assert.equal(consultationProtected.relationToMission, "independent");
  assert.equal(consultationProtected.writeAuthorized, false);

  planningCall = 0;
  const modelReplyRun = await createAgentPlan(modelStore, modelActor, "商机能干什么", {
    conversationId: "agc_model_reply_quality",
    missionSnapshots: [waitingCustomerMission]
  });
  assert.equal(modelReplyRun.steps.length, 0);
  assert.match(modelReplyRun.summary, /销售机会|销售管道|成交/u);

  planningCall = 0;
  conversationReplyPayload = {
    answer: "客户健康度用于综合反映资料完整度、跟进活跃度和商机进展，帮助业务员确定维护优先级。",
    confidence: 0.94,
    sources: ["Kevin 系统咨询与业务答疑", "客户管理与客户全景"]
  };
  conversationReviewPayload = conversationReplyPayload;
  const jsonReplyRun = await createAgentPlan(modelStore, modelActor, "客户健康度是什么意思", {
    conversationId: "agc_consultation_json_contract"
  });
  assert.equal(jsonReplyRun.steps.length, 0);
  assert.match(jsonReplyRun.summary, /资料完整度|维护优先级/u);

  planningCall = 0;
  conversationReplyPayload = {
    answer: "新增客户至少需要公司名称。",
    confidence: 0.6,
    sources: ["客户管理与客户全景"]
  };
  conversationReviewPayload = {
    answer: "进入客户页面后点击新建客户，填写公司名称即可建立档案；国家、联系人、联系方式、分级和健康度可以同时维护，也可以创建后再补充。保存成功后可在客户全景继续查看相关商机、跟进记录和联系方式。",
    confidence: 0.95,
    sources: ["Kevin 系统咨询与业务答疑", "客户管理与客户全景"]
  };
  const reviewedReplyRun = await createAgentPlan(modelStore, modelActor, "如何创建一个客户", {
    conversationId: "agc_consultation_model_review"
  });
  assert.equal(reviewedReplyRun.steps.length, 0);
  assert.match(reviewedReplyRun.summary, /进入客户页面|客户全景/u);
  assert.doesNotMatch(reviewedReplyRun.summary, /^新增客户至少需要公司名称。$/u);
} finally {
  setProviderHttpTestTransport(null);
}

console.log(JSON.stringify({
  ok: true,
  suite: "agent-turn-decision",
  consultationWrites: 0,
  historicalAuthorizationInherited: 0,
  crossTopicMissionMutation: 0,
  modelExtensibilityPreserved: true
}));
