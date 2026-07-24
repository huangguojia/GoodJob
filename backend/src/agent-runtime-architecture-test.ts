import assert from "node:assert/strict";
import { compileAgentGoalSpec } from "./agent-goal.js";
import { resolveAgentMissionNode } from "./agent-mission-state.js";
import { verifyAgentMissionOutcome } from "./agent-mission-verifier.js";
import { decideAgentStepRecovery } from "./agent-recovery.js";

const delegatedCompound = compileAgentGoalSpec(
  "生成一个客户并记录一条首次跟进，其它数据你看着来",
  { activeView: "customers", selectedCustomerId: "c_selected" }
);
assert.equal(delegatedCompound.protocol, "goodjob-goal/v1");
assert.equal(delegatedCompound.authorization.delegatedFieldSynthesis, true);
assert.equal(delegatedCompound.authorization.directExecution, true);
assert.equal(delegatedCompound.pageContext.selectedCustomerId, "c_selected");
assert.deepEqual(
  delegatedCompound.objectives.map((item) => `${item.action}:${item.domain}`),
  ["create:customers", "record:customers"]
);

const modelEnhanced = compileAgentGoalSpec(
  "帮我推进德国市场，找一批当地买家",
  { activeView: "lead-finder" },
  {
    primaryAction: "search",
    primaryDomain: "prospecting",
    subject: "德国当地买家",
    objectives: [{
      action: "search",
      domain: "prospecting",
      description: "搜索德国潜在买家",
      completionCriteria: ["搜客任务终态并返回候选统计"]
    }],
    constraints: ["使用已启用合法来源"],
    completionCriteria: ["至少形成可人工复核的候选"]
  }
);
assert.equal(modelEnhanced.compiledBy, "model+rules");
assert.equal(modelEnhanced.primaryDomain, "prospecting");
assert.ok(modelEnhanced.completionCriteria.includes("至少形成可人工复核的候选"));

const readOnly = compileAgentGoalSpec(
  "只读检查客户，不要修改或发送",
  {},
  {
    primaryAction: "send",
    primaryDomain: "communication",
    objectives: [{ action: "send", domain: "communication", description: "发送消息", completionCriteria: [] }]
  }
);
assert.equal(readOnly.authorization.readOnly, true);
assert.notEqual(readOnly.primaryAction, "send");
assert.ok(readOnly.objectives.every((item) => ["read", "analyze", "navigate"].includes(item.action)));

const customerOnly = [{
  tool: "api.write",
  risk: "write",
  status: "done",
  input: { method: "POST", path: "/api/customers" },
  result: { data: { customer: { id: "c_created" } } }
}];
const incompleteCompound = verifyAgentMissionOutcome({
  goal: delegatedCompound.rawGoal,
  goalSpec: delegatedCompound,
  steps: customerOnly
});
assert.equal(incompleteCompound.complete, false);
assert.equal(incompleteCompound.satisfied.length, 1);
assert.match(incompleteCompound.missing[0] || "", /跟进/u);

const completedCompound = verifyAgentMissionOutcome({
  goal: delegatedCompound.rawGoal,
  goalSpec: delegatedCompound,
  steps: [
    ...customerOnly,
    {
      tool: "crm.record_customer_followup",
      risk: "write",
      status: "done",
      input: { customerId: "c_created", content: "首次跟进" },
      result: { activity: { id: "ca_created" } }
    }
  ]
});
assert.equal(completedCompound.complete, true);
assert.equal(completedCompound.satisfied.length, 2);

const todoSpec = compileAgentGoalSpec("新建一个待办：下周联系客户");
assert.equal(verifyAgentMissionOutcome({
  goal: todoSpec.rawGoal,
  goalSpec: todoSpec,
  steps: [{ tool: "crm.create_todo", risk: "write", status: "done", input: {}, result: { todo: { id: "t_1" } } }]
}).complete, true);
const genericCreateSpec = compileAgentGoalSpec("创建一个知识记录");
assert.equal(verifyAgentMissionOutcome({
  goal: genericCreateSpec.rawGoal,
  goalSpec: genericCreateSpec,
  steps: [{
    tool: "api.write",
    risk: "write",
    status: "done",
    input: { method: "POST", path: "/api/knowledge" },
    result: { status: 201, data: { record: { id: "k_1" } }, completionEvidence: { type: "created_object_id", responsePaths: ["record.id"] } }
  }]
}).complete, true);

const piDownloadSpec = compileAgentGoalSpec("帮我给 Kanto Retail 的需求商机制作一个 PI，并下载");
assert.deepEqual(
  piDownloadSpec.objectives.map((item) => `${item.action}:${item.domain}`),
  ["create:documents", "export:documents"]
);
const piCreatedOnly = [{
  tool: "api.write",
  risk: "write",
  status: "done",
  input: { method: "POST", path: "/api/trade-documents" },
  result: { data: { document: { id: "td_kanto", customerId: "c_kanto", dealId: "d_kanto" } } }
}];
assert.equal(verifyAgentMissionOutcome({ goal: piDownloadSpec.rawGoal, goalSpec: piDownloadSpec, steps: piCreatedOnly }).complete, false);

const implicitPiDownloadSpec = compileAgentGoalSpec("帮我给客户 Nordic Tools AB 的活跃商机做一个PI");
assert.deepEqual(
  implicitPiDownloadSpec.objectives.map((item) => `${item.action}:${item.domain}`),
  ["create:documents", "export:documents"]
);
assert.equal(implicitPiDownloadSpec.authorization.directExecution, true);

const piDraftOnlySpec = compileAgentGoalSpec("根据当前商机生成一份 PI 草稿，保存到单据平台");
assert.deepEqual(
  piDraftOnlySpec.objectives.map((item) => `${item.action}:${item.domain}`),
  ["create:documents"]
);
assert.equal(verifyAgentMissionOutcome({
  goal: piDownloadSpec.rawGoal,
  goalSpec: piDownloadSpec,
  steps: [
    ...piCreatedOnly,
    {
      tool: "api.write",
      risk: "write",
      status: "done",
      input: { method: "POST", path: "/api/trade-documents/td_kanto/export" },
      result: { data: { document: { id: "td_kanto", status: "exported" }, job: { id: "io_kanto" }, fileName: "PI-KANTO.pdf" } }
    }
  ]
}).complete, true);

const unknownSpec = compileAgentGoalSpec("执行一个目前无法识别的业务动作");
assert.equal(unknownSpec.primaryAction, "unknown");
assert.equal(verifyAgentMissionOutcome({
  goal: unknownSpec.rawGoal,
  goalSpec: unknownSpec,
  steps: [{ tool: "crm.get_pipeline_snapshot", risk: "read", status: "done", input: {}, result: { customerCount: 9, dealCount: 5, amount: 181000 } }]
}).complete, false);
const sendSpec = compileAgentGoalSpec("给当前客户发送一条 Communication 消息");
assert.equal(verifyAgentMissionOutcome({
  goal: sendSpec.rawGoal,
  goalSpec: sendSpec,
  steps: [{ tool: "outreach.send_whatsapp", risk: "external", status: "done", input: {}, result: { accepted: true } }]
}).complete, false);
assert.equal(verifyAgentMissionOutcome({
  goal: sendSpec.rawGoal,
  goalSpec: sendSpec,
  steps: [{ tool: "outreach.send_whatsapp", risk: "external", status: "done", input: {}, result: { sent: true, messageId: "wamid.1", activityId: "ca_1" } }]
}).complete, true);

const sequenceSendSpec = compileAgentGoalSpec("给当前客户执行自动触达并发送跟进消息");
assert.equal(verifyAgentMissionOutcome({
  goal: sequenceSendSpec.rawGoal,
  goalSpec: sequenceSendSpec,
  steps: [{ tool: "outreach.create_sequence", risk: "external", status: "done", input: {}, result: { sequenceId: "seq_1" } }]
}).complete, false);
assert.equal(verifyAgentMissionOutcome({
  goal: sequenceSendSpec.rawGoal,
  goalSpec: sequenceSendSpec,
  steps: [{ tool: "outreach.get_sequence_progress", risk: "read", status: "done", input: {}, result: { terminal: true, currentStep: 0 } }]
}).complete, false);
assert.equal(verifyAgentMissionOutcome({
  goal: sequenceSendSpec.rawGoal,
  goalSpec: sequenceSendSpec,
  steps: [{ tool: "outreach.get_sequence_progress", risk: "read", status: "done", input: {}, result: { terminal: true, currentStep: 1 } }]
}).complete, true);

const prospectSpec = compileAgentGoalSpec("在德国至少找到 3 家潜在买家");
assert.equal(verifyAgentMissionOutcome({
  goal: prospectSpec.rawGoal,
  goalSpec: prospectSpec,
  steps: [{ tool: "prospect.get_search_progress", risk: "read", status: "done", input: {}, result: { terminal: true, candidateCount: 2 } }]
}).complete, false);
assert.equal(verifyAgentMissionOutcome({
  goal: prospectSpec.rawGoal,
  goalSpec: prospectSpec,
  steps: [{ tool: "prospect.get_search_progress", risk: "read", status: "done", input: {}, result: { terminal: true, candidateCount: 3 } }]
}).complete, true);

const updateSpec = compileAgentGoalSpec("把当前客户分级改成 A", { selectedCustomerId: "c_target" });
assert.equal(verifyAgentMissionOutcome({
  goal: updateSpec.rawGoal,
  goalSpec: updateSpec,
  steps: [{ tool: "crm.update_customer_profile", risk: "write", status: "done", input: { customerId: "c_other" }, result: { customer: { id: "c_other", grade: "A" } } }]
}).complete, false);
assert.equal(verifyAgentMissionOutcome({
  goal: updateSpec.rawGoal,
  goalSpec: updateSpec,
  steps: [{ tool: "crm.update_customer_profile", risk: "write", status: "done", input: { customerId: "c_target" }, result: { customer: { id: "c_target", grade: "A" } } }]
}).complete, true);
assert.equal(verifyAgentMissionOutcome({
  goal: updateSpec.rawGoal,
  goalSpec: updateSpec,
  steps: [{ tool: "crm.update_customer_profile", risk: "write", status: "done", input: { customerId: "c_target" }, result: { customer: { id: "c_target", grade: "B" } } }]
}).complete, false);

assert.equal(resolveAgentMissionNode({ status: "completed", stopReason: "", steps: [] }), "terminal");
assert.equal(resolveAgentMissionNode({ status: "running", stopReason: "wait_until:2099-01-01", steps: [] }), "wait_timer");
assert.equal(resolveAgentMissionNode({ status: "running", stopReason: "", steps: [{ status: "ready" }] }), "execute");
assert.equal(resolveAgentMissionNode({ status: "running", stopReason: "", steps: [{ status: "needs_confirmation" }] }), "approval");
assert.equal(resolveAgentMissionNode({ status: "running", stopReason: "", steps: [], hasPendingSteer: true }), "apply_steer");
assert.equal(resolveAgentMissionNode({ status: "running", stopReason: "", steps: [] }), "evaluate");

assert.equal(decideAgentStepRecovery({ tool: "api.read", risk: "read", input: {}, error: "HTTP 503 temporary unavailable" }).action, "retry_once");
assert.equal(decideAgentStepRecovery({ tool: "api.external", risk: "external", input: {}, error: "HTTP 503" }).action, "stop");
assert.equal(decideAgentStepRecovery({ tool: "api.write", risk: "write", input: {}, error: "ECONNRESET" }).action, "replan");
assert.equal(decideAgentStepRecovery({ tool: "api.write", risk: "write", input: { headers: { "Idempotency-Key": "gjab-1" } }, error: "ECONNRESET" }).action, "retry_once");
assert.equal(decideAgentStepRecovery({ tool: "api.write", risk: "write", input: {}, error: "HTTP 422 missing field" }).category, "validation");

console.log(JSON.stringify({
  ok: true,
  goalSpec: true,
  modelSafetyReview: true,
  compoundEvidence: true,
  externalReceipt: true,
  stateNodes: true,
  boundedRecovery: true
}, null, 2));
