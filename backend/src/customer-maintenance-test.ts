import assert from "node:assert/strict";
import {
  CustomerMaintenanceRunner,
  controlCustomerMaintenanceWatch,
  createCustomerMaintenanceWatch,
  listCustomerMaintenanceWatches,
  previewCustomerMaintenance,
  runCustomerMaintenanceWatch
} from "./customer-maintenance.js";
import { cancelAgentMission, createAgentPlan, pauseAgentMission, resumeAgentMission } from "./ai-agent.js";
import { memoryStore, type CrmStore } from "./store.js";

function isolatedStore() {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.customerMaintenanceWatches = [];
  store.agentRunEvents = [];
  store.agentRuns = [];
  store.agentRunSteps = [];
  store.persist = async () => undefined;
  return store;
}

async function main() {
  const store = isolatedStore();
  const owner = store.users.find((item) => item.id === "u_sales_shirley")!;
  const other = store.users.find((item) => item.id === "u_sales_mia")!;
  const rules = {
    intervalHours: 24,
    inactivityDays: 1,
    healthBelow: 70,
    includeOverdueReminder: true,
    includeMissingNextAction: true,
    grades: ["A", "B", "C", "D"],
    maxTodosPerRun: 2
  };
  const preview = previewCustomerMaintenance(store, owner, { rules });
  assert.ok(preview.matchedCount >= 1);
  assert.ok(preview.creatableCount <= 2);
  assert.ok(preview.findings.every((item) => store.customers.find((customer) => customer.id === item.customerId)?.ownerId === owner.id));

  const watch = await createCustomerMaintenanceWatch(store, owner, { name: "客户守护测试", rules }, "mission_maintenance_test", "step_maintenance_test");
  const replay = await createCustomerMaintenanceWatch(store, owner, { name: "重复创建", rules }, "mission_maintenance_test", "step_maintenance_test");
  assert.equal(replay.id, watch.id);
  assert.equal(listCustomerMaintenanceWatches(store, owner).length, 1);
  assert.equal(listCustomerMaintenanceWatches(store, other).length, 0);

  const beforeTodos = store.todos.length;
  const firstRun = await runCustomerMaintenanceWatch(store, watch, new Date("2026-07-19T08:00:00.000Z"));
  assert.ok(firstRun.created.length >= 1);
  assert.ok(firstRun.created.length <= 2);
  assert.equal(store.todos.length, beforeTodos + firstRun.created.length);
  assert.ok(firstRun.created.every((item) => item.ownerId === owner.id && item.triggerKey?.startsWith(`maintenance:${watch.id}:`)));
  const secondRun = await runCustomerMaintenanceWatch(store, watch, new Date("2026-07-19T09:00:00.000Z"));
  assert.equal(secondRun.created.length, 0);

  await controlCustomerMaintenanceWatch(store, owner, watch.id, "pause");
  assert.equal(watch.status, "paused");
  await controlCustomerMaintenanceWatch(store, owner, watch.id, "resume");
  assert.equal(watch.status, "active");
  await assert.rejects(controlCustomerMaintenanceWatch(store, other, watch.id, "pause"), /不存在/u);
  await controlCustomerMaintenanceWatch(store, owner, watch.id, "cancel");
  assert.equal(watch.status, "cancelled");

  const dueWatch = await createCustomerMaintenanceWatch(store, owner, { name: "调度测试", rules: { ...rules, maxTodosPerRun: 1 } }, "mission_runner_test", "step_runner_test");
  dueWatch.nextRunAt = new Date(Date.now() - 1_000).toISOString();
  const runner = new CustomerMaintenanceRunner(store, 60_000);
  await runner.synchronize();
  assert.ok(dueWatch.lastRunAt);
  assert.ok(new Date(dueWatch.nextRunAt).getTime() > Date.now());

  const plan = await createAgentPlan(store, owner, "启用客户守护，每天自动维护客户");
  assert.ok(plan.steps.some((item) => item.tool === "maintenance.preview" && item.status === "ready"));
  assert.ok(plan.steps.some((item) => item.tool === "maintenance.create_watch" && item.status === "ready" && item.approvedAt));

  const controlMission = await createAgentPlan(store, owner, "检查当前商机管道");
  const missionWatch = await createCustomerMaintenanceWatch(store, owner, { name: "Mission 联动", rules }, controlMission.id, "step_mission_watch");
  await pauseAgentMission(store, owner, controlMission.id);
  assert.equal(missionWatch.status, "paused");
  await resumeAgentMission(store, owner, controlMission.id, "继续");
  assert.equal(missionWatch.status, "active");
  await cancelAgentMission(store, owner, controlMission.id);
  assert.equal(missionWatch.status, "cancelled");

  console.log(JSON.stringify({
    ok: true,
    ownerScoped: true,
    boundedCreation: true,
    factIdempotency: true,
    persistentRunner: true,
    approvalRequired: true,
    controls: true,
    missionControlCascades: true
  }, null, 2));
}

void main();
