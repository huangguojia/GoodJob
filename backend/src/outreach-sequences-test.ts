import assert from "node:assert/strict";
import {
  OutreachSequenceRunner,
  controlOutreachSequence,
  createOutreachSequence,
  listOutreachSequences
} from "./outreach-sequences.js";
import { memoryStore, type CrmStore } from "./store.js";
import { cancelAgentMission, createAgentPlan, pauseAgentMission, resumeAgentMission } from "./ai-agent.js";

function isolatedStore() {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.outreachSequences = [];
  store.agentRunEvents = [];
  store.persist = async () => undefined;
  return store;
}

async function main() {
  const store = isolatedStore();
  const owner = store.users.find((item) => item.status === "active")!;
  const other = store.users.find((item) => item.id !== owner.id && item.status === "active")!;
  const customer = store.customers.find((item) => item.ownerId === owner.id) || store.customers[0]!;
  customer.ownerId = owner.id;
  customer.teamId = owner.teamId;
  customer.whatsapp = "+46701234567";
  const input = {
    entityType: "customer",
    entityId: customer.id,
    channel: "communication",
    steps: [
      { delayHours: 0, subject: "", body: "First approved message" },
      { delayHours: 24, subject: "", body: "Second approved message" }
    ]
  };
  const sequence = await createOutreachSequence(store, owner, input, "mission_sequence_test");
  input.steps[0]!.body = "mutated after approval";
  assert.equal(sequence.steps[0]?.body, "First approved message");
  assert.equal(sequence.maxSends, 2);
  assert.equal(listOutreachSequences(store, owner).length, 1);
  assert.equal(listOutreachSequences(store, other).length, 0);

  let sends = 0;
  let replyDetected = false;
  const runner = new OutreachSequenceRunner(store, {
    send: async (_sequence, step, executionId) => {
      sends += 1;
      assert.equal(step.body, "First approved message");
      assert.match(executionId, /^sequence:/u);
      return { sent: true };
    },
    stopReason: async () => replyDetected ? "Communication 已收到客户回复" : ""
  }, 60_000);
  await runner.synchronize();
  assert.equal(sends, 1);
  assert.equal(sequence.currentStep, 1);
  assert.equal(sequence.steps[0]?.status, "sent");

  sequence.nextExecutionAt = new Date(Date.now() - 1_000).toISOString();
  sequence.steps[1]!.scheduledAt = sequence.nextExecutionAt;
  replyDetected = true;
  await runner.synchronize();
  assert.equal(sends, 1);
  assert.equal(sequence.status, "stopped");
  assert.match(sequence.stopReason, /收到客户回复/u);
  assert.equal(sequence.steps[1]?.status, "skipped");

  const second = await createOutreachSequence(store, owner, {
    entityType: "customer",
    entityId: customer.id,
    channel: "communication",
    steps: [{ delayHours: 24, subject: "", body: "Another approved message" }]
  }, "mission_sequence_control_test");
  await controlOutreachSequence(store, owner, second.id, "pause");
  assert.equal(second.status, "paused");
  await controlOutreachSequence(store, owner, second.id, "resume");
  assert.equal(second.status, "active");
  await controlOutreachSequence(store, owner, second.id, "cancel");
  assert.equal(second.status, "cancelled");
  await assert.rejects(controlOutreachSequence(store, other, second.id, "resume"), /不存在/u);

  const mission = await createAgentPlan(store, owner, "检查当前商机管道");
  const missionSequence = await createOutreachSequence(store, owner, {
    entityType: "customer",
    entityId: customer.id,
    channel: "communication",
    steps: [{ delayHours: 24, subject: "", body: "Mission-controlled message" }]
  }, mission.id, "mission_control_step");
  await pauseAgentMission(store, owner, mission.id);
  assert.equal(missionSequence.status, "paused");
  await resumeAgentMission(store, owner, mission.id, "继续");
  assert.equal(missionSequence.status, "active");
  await cancelAgentMission(store, owner, mission.id);
  assert.equal(missionSequence.status, "cancelled");

  console.log(JSON.stringify({
    ok: true,
    immutableApprovalSnapshot: true,
    boundedSends: true,
    replyStopsSequence: true,
    ownerIsolation: true,
    pauseResumeCancel: true,
    missionControlCascades: true
  }, null, 2));
}

void main();
