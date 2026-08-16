import assert from "node:assert/strict";
import {
  deleteAgentMemory,
  listAgentMemories,
  proposeAgentMemory,
  retrieveRelevantAgentMemories,
  setAgentMemoryStatus,
  updateAgentMemory
} from "./agent-memory.js";
import { memoryStore, type CrmStore } from "./store.js";

function isolatedStore() {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.agentMemories = [];
  store.persist = async () => {};
  return store;
}

async function main() {
  const store = isolatedStore();
  const shirley = store.users.find((item) => item.id === "u_sales_shirley")!;
  const mia = store.users.find((item) => item.id === "u_sales_mia")!;
  const manager = store.users.find((item) => item.id === "u_manager_alex")!;

  const personal = await proposeAgentMemory(store, shirley, {
    type: "user_preference",
    scope: "personal",
    title: "开发信语气",
    content: "开发信保持简洁专业，首封不超过一百二十词。",
    sourceType: "manual",
    confidence: 95
  });
  assert.equal(personal.status, "proposed");
  assert.equal(listAgentMemories(store, mia).length, 0);
  assert.equal(retrieveRelevantAgentMemories(store, shirley, "写一封简洁专业开发信").length, 0);

  await setAgentMemoryStatus(store, shirley, personal.id, "active");
  const relevant = retrieveRelevantAgentMemories(store, shirley, "写一封简洁专业开发信");
  assert.equal(relevant[0]?.id, personal.id);
  assert.equal(relevant[0]?.sourceType, "manual");
  assert.equal(relevant[0]?.confidence, 95);
  assert.ok(relevant[0]?.lastUsedAt);

  await updateAgentMemory(store, shirley, personal.id, { content: "开发信保持简洁专业，首封不超过九十词。" });
  assert.match(listAgentMemories(store, shirley, { status: "active" })[0]!.content, /九十词/u);

  const customer = await proposeAgentMemory(store, shirley, {
    type: "customer_memory",
    scope: "customer",
    subjectId: "c1",
    title: "Nordic 采购关注点",
    content: "采购负责人优先关注 CE 证书和交期。",
    sourceType: "crm",
    sourceId: "c1",
    confidence: 100
  });
  await setAgentMemoryStatus(store, shirley, customer.id, "active");
  assert.equal(retrieveRelevantAgentMemories(store, shirley, "准备 Nordic 跟进", { customerId: "c1" })[0]?.id, customer.id);
  await assert.rejects(() => proposeAgentMemory(store, mia, {
    type: "customer_memory",
    scope: "customer",
    subjectId: "c1",
    title: "越权客户记忆",
    content: "不应被创建",
    sourceType: "agent"
  }), /可见的客户/u);

  await assert.rejects(() => proposeAgentMemory(store, shirley, {
    type: "team_playbook",
    scope: "team",
    title: "团队打法",
    content: "先确认采购窗口再报价。",
    sourceType: "playbook"
  }), /主管或管理员/u);
  const teamMemory = await proposeAgentMemory(store, manager, {
    type: "team_playbook",
    scope: "team",
    title: "团队报价打法",
    content: "报价前确认采购窗口和决策链。",
    sourceType: "playbook",
    sourceId: "playbook-test"
  });
  assert.equal(listAgentMemories(store, shirley).some((item) => item.id === teamMemory.id), false);
  await setAgentMemoryStatus(store, manager, teamMemory.id, "active");
  assert.equal(listAgentMemories(store, shirley).some((item) => item.id === teamMemory.id), true);

  const expired = await proposeAgentMemory(store, shirley, {
    type: "user_preference",
    scope: "personal",
    title: "旧市场偏好",
    content: "优先开发旧市场客户。",
    sourceType: "manual",
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  await setAgentMemoryStatus(store, shirley, expired.id, "active");
  assert.equal(listAgentMemories(store, shirley, { status: "active" }).some((item) => item.id === expired.id), false);

  await setAgentMemoryStatus(store, shirley, personal.id, "archived");
  assert.equal(retrieveRelevantAgentMemories(store, shirley, "简洁专业开发信").some((item) => item.id === personal.id), false);
  await deleteAgentMemory(store, shirley, personal.id);
  assert.equal(store.agentMemories.some((item) => item.id === personal.id), false);

  console.log(JSON.stringify({
    ok: true,
    personalIsolation: true,
    customerVisibility: true,
    teamPublishControl: true,
    activeOnlyRetrieval: true,
    expiryRespected: true,
    sourcePreserved: true
  }, null, 2));
}

void main();
