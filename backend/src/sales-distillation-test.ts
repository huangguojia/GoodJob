import assert from "node:assert/strict";
import {
  activateSalesPlaybook,
  activeSalesPlaybookContext,
  createSalesDistillation,
  listSalesPlaybookActivations,
  pauseSalesPlaybook,
  publishSalesDistillation,
  recordSalesPlaybookUsage,
  salesPlaybookActionForStage
} from "./sales-distillation.js";
import {
  advanceSalesTrainingRun,
  controlSalesTrainingRun,
  createSalesTrainingRun,
  publishSalesTrainingRun,
  retrainSalesTrainingRun,
  updateSalesTrainingSample
} from "./sales-training.js";
import { createCustomerMaintenanceWatch, runCustomerMaintenanceWatch } from "./customer-maintenance.js";
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
  const otherSales = store.users.find((item) => item.id === "u_sales_mia")!;
  const trainingCustomer = store.customers.find((item) => item.ownerId === sales.id)!;
  const dealTemplate = store.deals[0]!;
  store.deals.push(
    { ...structuredClone(dealTemplate), id: "d_training_won", customerId: trainingCustomer.id, ownerId: sales.id, teamId: sales.teamId, title: "训练成交样本", stage: "成交", archivedAt: undefined },
    { ...structuredClone(dealTemplate), id: "d_training_lost", customerId: trainingCustomer.id, ownerId: sales.id, teamId: sales.teamId, title: "训练丢单样本", stage: "丢单", archivedAt: undefined },
    { ...structuredClone(dealTemplate), id: "d_training_active", customerId: trainingCustomer.id, ownerId: sales.id, teamId: sales.teamId, title: "训练推进样本", stage: "已报价", archivedAt: undefined }
  );

  const training = await createSalesTrainingRun(store, manager, sales.id, 90);
  assert.equal(training.status, "queued");
  for (let index = 0; index < 6; index += 1) await advanceSalesTrainingRun(store, training.id);
  assert.equal(training.status, "awaiting_review");
  assert.equal(training.rounds.length, 5);
  assert.ok(training.samples.length >= 3);
  assert.ok(training.events.length >= 6);
  assert.ok(training.evaluation.overall > 0);
  const reviewedSample = training.samples[0]!;
  await updateSalesTrainingSample(store, manager, training.id, reviewedSample.id, { managerNote: "主管已核对证据链", included: true });
  assert.equal(reviewedSample.managerNote, "主管已核对证据链");
  assert.equal(training.evaluation.passed, true);
  const publishedTraining = await publishSalesTrainingRun(store, manager, training.id);
  assert.equal(publishedTraining.run.status, "published");
  assert.equal(publishedTraining.distillation.trainingRunId, training.id);
  assert.equal(publishedTraining.distillation.version, 1);
  const retraining = await retrainSalesTrainingRun(store, manager, training.id);
  assert.equal(retraining.version, 2);
  await controlSalesTrainingRun(store, manager, retraining.id, "pause");
  assert.equal(retraining.status, "paused");
  await controlSalesTrainingRun(store, manager, retraining.id, "resume");
  assert.notEqual(retraining.status, "paused");
  await controlSalesTrainingRun(store, manager, retraining.id, "cancel");
  assert.equal(retraining.status, "cancelled");

  const first = await createSalesDistillation(store, manager, sales.id, 90);
  await assert.rejects(activateSalesPlaybook(store, sales, first.id), /已发布/u);
  await publishSalesDistillation(store, manager, first.id);
  const firstActivation = await activateSalesPlaybook(store, sales, first.id);
  assert.equal(firstActivation.status, "active");
  assert.equal(activeSalesPlaybookContext(store, sales)?.distillation.id, first.id);
  assert.equal(listSalesPlaybookActivations(store, otherSales).length, 0);

  const action = salesPlaybookActionForStage(store, sales, "已报价");
  assert.ok(action?.item.action);
  recordSalesPlaybookUsage(store, firstActivation.id, true);
  assert.equal(firstActivation.applicationCount, 1);
  assert.equal(firstActivation.taskCount, 1);

  const second = await createSalesDistillation(store, manager, sales.id, 30);
  await publishSalesDistillation(store, manager, second.id);
  const secondActivation = await activateSalesPlaybook(store, sales, second.id);
  assert.equal(secondActivation.status, "active");
  assert.equal(firstActivation.status, "paused");
  assert.equal(activeSalesPlaybookContext(store, sales)?.distillation.id, second.id);

  const watch = await createCustomerMaintenanceWatch(store, sales, {
    name: "打法应用测试",
    rules: { intervalHours: 24, inactivityDays: 1, healthBelow: 100, includeOverdueReminder: true, includeMissingNextAction: true, grades: ["A", "B", "C", "D"], maxTodosPerRun: 3 }
  }, "mission_playbook_test", "step_playbook_test");
  const maintenance = await runCustomerMaintenanceWatch(store, watch, new Date("2026-07-19T08:00:00.000Z"));
  assert.ok(maintenance.findings.some((item) => item.playbookActivationId === secondActivation.id && item.playbookAction));
  assert.ok(maintenance.created.some((item) => item.related.includes("打法：")));
  assert.ok(secondActivation.taskCount >= 1);

  await pauseSalesPlaybook(store, sales, secondActivation.id);
  assert.equal(activeSalesPlaybookContext(store, sales), null);
  await assert.rejects(pauseSalesPlaybook(store, otherSales, secondActivation.id), /不存在/u);

  console.log(JSON.stringify({
    ok: true,
    publishBeforeActivation: true,
    oneActivePlaybook: true,
    agentContextAvailable: true,
    maintenanceUsesPlaybook: true,
    usageMeasured: true,
    ownerIsolation: true
    , trainingPipeline: true
    , sampleReview: true
    , versionedPublish: true
    , pauseResumeCancelTraining: true
  }, null, 2));
}

void main();
