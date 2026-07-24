import assert from "node:assert/strict";
import {
  createAgentTriggerRule,
  detectAgentTriggerFacts,
  listAgentTriggerEvents,
  listAgentTriggerRules,
  runAgentTriggerRule,
  setAgentTriggerRuleStatus
} from "./agent-triggers.js";
import { createAgentPlan, type AgentActor, type AgentPlanContext } from "./ai-agent.js";
import { memoryStore, type CrmStore } from "./store.js";

function isolatedStore() {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.aiModelConfigs = [];
  store.agentRuns = [];
  store.agentRunSteps = [];
  store.agentRunEvents = [];
  store.agentMissionCheckpoints = [];
  store.agentTriggerRules = [];
  store.agentTriggerEvents = [];
  store.persist = async () => {};
  return store;
}

async function main() {
  const store = isolatedStore();
  const shirley = store.users.find((item) => item.id === "u_sales_shirley")!;
  const mia = store.users.find((item) => item.id === "u_sales_mia")!;
  const customer = store.customers.find((item) => item.ownerId === shirley.id)!;
  customer.health = 35;

  const notifyRule = await createAgentTriggerRule(store, shirley, {
    name: "低健康度客户提醒",
    eventType: "health_decline",
    mode: "notify",
    healthBelow: 60,
    maxPerScan: 1,
    intervalMinutes: 30
  });
  assert.equal(listAgentTriggerRules(store, mia).length, 0);
  assert.ok(detectAgentTriggerFacts(store, notifyRule).some((item) => item.entityId === customer.id));

  const missionFactory = (actor: AgentActor, goal: string, context: AgentPlanContext) => createAgentPlan(store, actor, goal, context);
  const first = await runAgentTriggerRule(store, shirley, notifyRule, missionFactory);
  assert.equal(first.createdCount, 1);
  const notifyMission = store.agentRuns.find((item) => item.id === first.events[0]?.missionRunId)!;
  const notifySteps = store.agentRunSteps.filter((item) => item.runId === notifyMission.id);
  assert.ok(notifySteps.length > 0);
  assert.ok(notifySteps.every((item) => item.risk === "read"));
  assert.equal(notifySteps.some((item) => item.risk === "external"), false);

  const replay = await runAgentTriggerRule(store, shirley, notifyRule, missionFactory);
  assert.equal(replay.createdCount, 0);
  assert.ok(replay.skippedCount >= 1);
  customer.health = 34;
  const changedFact = await runAgentTriggerRule(store, shirley, notifyRule, missionFactory);
  assert.equal(changedFact.createdCount, 1);
  assert.equal(new Set(store.agentTriggerEvents.map((item) => item.factKey)).size, store.agentTriggerEvents.length);

  const deal = store.deals.find((item) => item.ownerId === shirley.id && !["成交", "丢单"].includes(item.stage))!;
  deal.nextActionAt = new Date(Date.now() - 86_400_000).toISOString();
  const internalRule = await createAgentTriggerRule(store, shirley, {
    name: "下一动作到期",
    eventType: "next_action_due",
    mode: "internal",
    maxPerScan: 1
  });
  const internal = await runAgentTriggerRule(store, shirley, internalRule, missionFactory);
  assert.equal(internal.createdCount, 1);
  const internalSteps = store.agentRunSteps.filter((item) => item.runId === internal.events[0]?.missionRunId);
  assert.ok(internalSteps.some((item) => item.tool === "crm.create_todo" && item.status === "needs_confirmation"));
  assert.equal(internalSteps.some((item) => item.risk === "external"), false);

  await setAgentTriggerRuleStatus(store, shirley, internalRule.id, "paused");
  await assert.rejects(() => runAgentTriggerRule(store, shirley, internalRule, missionFactory), /已暂停/u);
  assert.equal(listAgentTriggerEvents(store, mia).length, 0);
  assert.equal(listAgentTriggerEvents(store, shirley).length, 3);

  console.log(JSON.stringify({
    ok: true,
    ownerIsolation: true,
    factDetection: true,
    idempotentTrigger: true,
    changedFactRetriggers: true,
    notifyReadOnly: true,
    internalWriteApproval: true,
    noExternalSend: true
  }, null, 2));
}

void main();
