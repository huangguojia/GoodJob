import assert from "node:assert/strict";
import { createMemoryApprovalService } from "./approval-service.js";
import type { SessionUser } from "../types.js";

const actor = (id: string, teamId: string): SessionUser => ({
  id, teamId, name: id, email: `${id}@example.test`, avatar: id[0] || "A",
  role: "manager", authVersion: 1,
  iamDataScope: { permissionCode: "approval.read", tenantWide: true, ownerIds: [] }
});

const service = createMemoryApprovalService();
const manager = actor("manager_a", "tenant_a");
const outsider = actor("manager_b", "tenant_b");

const created = await service.createWorkflow(manager, {
  code: "quote_approval",
  name: "报价审批",
  businessType: "quote",
  nodes: [{ name: "经理审批", approverStrategy: "requester_manager", approverConfig: {}, approvalMode: "single" }]
});
const workflow = created.workflow as Record<string, unknown>;
assert.equal(workflow.status, "draft");
assert.equal((await service.listWorkflows(outsider)).workflows instanceof Array, true);
assert.equal(((await service.listWorkflows(outsider)).workflows as unknown[]).length, 0);

const published = await service.publishWorkflow(manager, String(workflow.id));
assert.equal((published.workflow as Record<string, unknown>).status, "active");
const submitted = await service.createInstance(manager, {
  workflowId: workflow.id,
  title: "测试报价审批",
  summary: "验证版本化审批闭环",
  businessId: "deal_test",
  idempotencyKey: "approval-test-submit-001"
});
const instance = submitted.instance as Record<string, unknown>;
const task = (submitted.tasks as Array<Record<string, unknown>>)[0];
assert.equal(instance.status, "running");
assert.equal(task.status, "pending");

const decided = await service.decideTask(manager, String(task.id), "approve", {
  version: 1,
  comment: "同意",
  idempotencyKey: "approval-test-approve-001"
});
assert.equal((decided.instance as Record<string, unknown>).status, "approved");
assert.equal(((await service.listInstances(outsider)).instances as unknown[]).length, 0);

const startId = "start_quote";
const conditionId = "condition_amount";
const managerNodeId = "approval_manager";
const financeNodeId = "approval_finance";
const endId = "end_quote";
const conditional = await service.createWorkflow(manager, {
  code: "quote_amount_routing",
  name: "报价金额分级审批",
  businessType: "quote",
  priority: 10,
  isDefault: false,
  triggerConfig: { enabled: true, conditions: [{ field: "amount", operator: "greater_than", value: 50000 }] },
  nodes: [
    { id: startId, type: "start", name: "发起申请", position: { x: 0, y: 100 } },
    { id: conditionId, type: "condition", name: "判断报价金额", position: { x: 200, y: 100 } },
    { id: managerNodeId, type: "approval", name: "经理审批", position: { x: 430, y: 20 }, approverStrategy: "requester_manager", approverConfig: {}, approvalMode: "single" },
    { id: financeNodeId, type: "approval", name: "财务审批", position: { x: 430, y: 190 }, approverStrategy: "permission_holder", approverConfig: { permissionCode: "approval.task.act" }, approvalMode: "single" },
    { id: endId, type: "end", name: "流程结束", position: { x: 700, y: 100 } }
  ],
  edges: [
    { source: startId, target: conditionId, priority: 10 },
    { source: conditionId, target: financeNodeId, label: "大额报价", priority: 10, condition: { field: "amount", operator: "greater_than", value: 50000 } },
    { source: conditionId, target: managerNodeId, label: "普通报价", priority: 20 },
    { source: managerNodeId, target: endId, priority: 10 },
    { source: financeNodeId, target: endId, priority: 10 }
  ]
});
const conditionalId = String((conditional.workflow as Record<string, unknown>).id);
const graphValidation = await service.validateWorkflow(manager, conditionalId) as { valid: boolean; issues: string[] };
assert.equal(graphValidation.valid, true, graphValidation.issues.join("; "));
await service.publishWorkflow(manager, conditionalId);

const resolved = await service.resolveWorkflow(manager, { businessType: "quote", context: { amount: 88000 } }) as { matched: boolean; workflow: Record<string, unknown> };
assert.equal(resolved.matched, true);
assert.equal(resolved.workflow.id, conditionalId);

const highValue = await service.createInstance(manager, {
  workflowId: "", businessType: "quote", businessId: "quote_high", title: "大额报价", formData: { amount: 88000 }, idempotencyKey: "approval-test-high-value"
});
const highTask = (highValue.tasks as Array<Record<string, unknown>>)[0];
assert.equal(highTask.nodeId, financeNodeId);

await service.updateWorkflow(manager, conditionalId, {
  ...(conditional.workflow as Record<string, unknown>),
  name: "报价金额分级审批（新版）",
  nodes: (conditional.workflow as Record<string, unknown>).nodes,
  edges: (conditional.workflow as Record<string, unknown>).edges
});
const oldInstanceCompleted = await service.decideTask(manager, String(highTask.id), "approve", { comment: "同意", idempotencyKey: "approval-test-high-approve" });
assert.equal((oldInstanceCompleted.instance as Record<string, unknown>).status, "approved");

const lowValue = await service.createInstance(manager, {
  workflowId: conditionalId, businessId: "quote_low", title: "普通报价", formData: { amount: 12000 }, idempotencyKey: "approval-test-low-value"
});
const lowTask = (lowValue.tasks as Array<Record<string, unknown>>)[0];
assert.equal(lowTask.nodeId, managerNodeId);
assert.equal(((await service.listWorkflows(outsider)).workflows as unknown[]).length, 0);

console.log(JSON.stringify({ ok: true, workflowPublished: true, instanceApproved: true, conditionalRouting: true, automaticMatching: true, immutableRunningVersion: true, tenantIsolation: true }, null, 2));
