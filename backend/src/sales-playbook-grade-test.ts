import assert from "node:assert/strict";
import {
  activateSalesPlaybook,
  publishSalesDistillation,
  salesPlaybookActionForStageAndGrade,
  salesPlaybookActionForStage
} from "./sales-distillation.js";
import { memoryStore, type CrmStore } from "./store.js";

function isolatedStore() {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.salesDistillations = [];
  store.salesPlaybookActivations = [];
  store.salesTrainingRuns = [];
  store.customerMaintenanceWatches = [];
  store.agentRunEvents = [];
  store.persist = async () => undefined;
  return store;
}

async function main() {
  const store = isolatedStore();
  const manager = store.users.find((item) => item.id === "u_manager_alex")!;
  const sales = store.users.find((item) => item.id === "u_sales_shirley")!;
  const distillation = await (await import("./sales-distillation.js")).createSalesDistillation(store, manager, sales.id, 90);
  await publishSalesDistillation(store, manager, distillation.id);
  await activateSalesPlaybook(store, sales, distillation.id);

  // 构造等级联动打法：[已报价·A级专属, 已报价·通配, 商机推进·通配]
  const playbook = distillation.playbook;
  playbook.length = 0;
  playbook.push(
    { stage: "已报价", action: "A级：24 小时内安排高管对接", evidence: "A级客户成交周期减半", targetGrades: ["A"] },
    { stage: "已报价", action: "通配：标准报价跟单", evidence: "通用跟单节奏" },
    { stage: "商机推进", action: "商机：推动样品确认", evidence: "商机阶段标准动作" }
  );

  // ---- A 级命中等级专属条目 ----
  const forA = salesPlaybookActionForStageAndGrade(store, sales, "已报价", "A");
  assert.ok(forA, "A级应命中");
  assert.equal(forA!.item.action, "A级：24 小时内安排高管对接");
  assert.equal(forA!.activation.distillationId, distillation.id);

  // ---- B 级无专属条目 → 回退通配条目 ----
  const forB = salesPlaybookActionForStageAndGrade(store, sales, "已报价", "B");
  assert.ok(forB, "B级应回退命中通配");
  assert.equal(forB!.item.action, "通配：标准报价跟单");

  // ---- grade 为 undefined → 与旧版纯 stage 匹配一致（首个 stage 命中） ----
  const legacy = salesPlaybookActionForStage(store, sales, "已报价");
  assert.ok(legacy, "undefined 等级应命中");
  assert.equal(legacy!.item.action, "A级：24 小时内安排高管对接");

  // ---- 无 stage 命中时走 fallback（商机/推进/跟进） ----
  const fallback = salesPlaybookActionForStageAndGrade(store, sales, "已发货", "C");
  assert.ok(fallback, "未匹配 stage 应走 fallback");
  assert.equal(fallback!.item.stage, "商机推进");

  // ---- 未激活打法的其他销售 → null ----
  const other = store.users.find((item) => item.id === "u_sales_mia")!;
  assert.equal(salesPlaybookActionForStageAndGrade(store, other, "已报价", "A"), null);

  console.log("W6 等级联动打法单测：全部通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
