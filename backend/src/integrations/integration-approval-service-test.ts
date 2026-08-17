import assert from "node:assert/strict";
import type { DataScope } from "../authorization.js";
import { getStore } from "../store.js";
import type { SessionUser } from "../types.js";
import { IntegrationControlPlaneService } from "./integration-service.js";
import type { ApprovalDetail, CreateApprovalCallInput, ReconcileCallInput } from "./integration-control-repository.js";
import type { IntegrationApproval, IntegrationConnection, IntegrationToolCall, ToolSnapshot } from "./integration-types.js";

const now = "2026-08-07T00:00:00.000Z";
const key = "integration-stage3-approval-test-key-at-least-32-characters";
const sales: SessionUser = { id: "stage3_sales", teamId: "stage3_team", role: "sales", name: "Sales", email: "sales@stage3.test", avatar: "S", authVersion: 1 };
const manager: SessionUser = { id: "stage3_manager", teamId: "stage3_team", role: "manager", name: "Manager", email: "manager@stage3.test", avatar: "M", authVersion: 1 };
const foreignManager: SessionUser = { id: "stage3_foreign", teamId: "other_team", role: "manager", name: "Foreign", email: "foreign@stage3.test", avatar: "F", authVersion: 1 };
const store = getStore();
for (const user of [sales, manager, foreignManager]) {
  if (!store.users.some((item) => item.id === user.id)) store.users.push({ ...user, password: "unused", status: "active" });
}

const connection: IntegrationConnection = {
  id: "stage3_connection", connectorId: "stage3_connector", teamId: sales.teamId, ownerId: manager.id,
  scope: "team", scopeId: sales.teamId, status: "active", displayName: "Stage 3 Write MCP", revision: 1,
  lastHealthAt: now, lastErrorCode: "", lastErrorMessage: "", serverInfoJson: "{}", warningMessage: "",
  createdAt: now, updatedAt: now, disconnectedAt: ""
};
const review = {
  allowedRoles: ["sales", "manager"],
  fieldAllowlist: ["recipient", "subject", "body", "apiToken"],
  approvalPolicy: "always",
  completionEvidence: ["external_receipt_id"],
  dataEgressPolicy: {
    allowedClassifications: ["public", "business", "personal", "sensitive"],
    fieldClassifications: { recipient: "personal", subject: "business", body: "sensitive", apiToken: "secret" },
    secretFieldsDenied: true
  }
};
const tool: ToolSnapshot = {
  id: "stage3_tool", connectionId: connection.id, teamId: sales.teamId, remoteName: "email.send",
  stableAlias: "email.send", displayName: "发送邮件", description: "Send one approved email",
  inputSchemaJson: JSON.stringify({
    type: "object",
    properties: { recipient: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, apiToken: { type: "string" } },
    required: ["recipient", "subject", "body"], additionalProperties: false
  }),
  outputSchemaJson: "{}", schemaHash: "stage3_schema", riskLevel: 4, status: "active", revision: 1,
  discoveredAt: now, reviewedAt: now, reviewedBy: manager.id, permissionCode: "email.send",
  reviewJson: JSON.stringify(review), createdAt: now, updatedAt: now
};

function inScope(teamId: string, ownerId: string, scope: DataScope) {
  return scope.type === "platform" || (scope.teamId === teamId && (scope.type === "team" || scope.ownerId === ownerId));
}

class FakeApprovalRepository {
  calls: IntegrationToolCall[] = [];
  details: ApprovalDetail[] = [];
  contextChanged = false;
  reconciled: ReconcileCallInput | null = null;
  async findActiveToolByAlias(alias: string, scope: DataScope) { return alias === tool.stableAlias && inScope(tool.teamId, sales.id, scope) ? tool : null; }
  async hasActiveGrant(_tool: ToolSnapshot, actor: SessionUser) { return actor.teamId === sales.teamId; }
  async createApprovalCall(input: CreateApprovalCallInput) {
    const call: IntegrationToolCall = {
      id: input.id, requestId: input.requestId, teamId: input.teamId, ownerId: input.ownerId,
      actorId: input.actorId, actorAuthVersion: input.actorAuthVersion, connectionId: input.connectionId,
      toolSnapshotId: input.toolSnapshotId, approvalId: input.approval.id, status: "awaiting_approval",
      riskLevel: input.riskLevel, inputHash: input.inputHash, inputArtifactId: input.artifact.id,
      inputSummaryJson: JSON.stringify(input.inputSummary), outputHash: "", resultArtifactId: "",
      outputSummaryJson: "{}", idempotencyKeyHash: input.idempotencyKeyHash, externalReceipt: "",
      evidenceJson: "{}", errorCode: "", errorMessage: "", attemptCount: 0, createdAt: input.createdAt,
      queuedAt: "", startedAt: "", finishedAt: "", updatedAt: input.createdAt
    };
    const approval: IntegrationApproval = {
      id: input.approval.id, teamId: input.teamId, ownerId: input.ownerId, connectionId: input.connectionId,
      toolSnapshotId: input.toolSnapshotId, callId: input.id, status: "pending", riskLevel: input.riskLevel,
      frozenInputHash: input.inputHash, singleUseNonceHash: input.approval.singleUseNonceHash,
      requestedBy: input.actorId, decidedBy: "", decisionNote: "", expiresAt: input.approval.expiresAt,
      decidedAt: "", consumedAt: "", createdAt: input.createdAt, updatedAt: input.createdAt
    };
    this.calls.push(call);
    this.details.push({
      approval, requestId: input.requestId, actorAuthVersion: input.actorAuthVersion,
      callStatus: call.status, inputSummaryJson: call.inputSummaryJson, encryptedInput: input.artifact.encryptedValue,
      toolRemoteName: tool.remoteName, toolDisplayName: tool.displayName, toolStableAlias: tool.stableAlias,
      toolSchemaHash: tool.schemaHash, toolReviewJson: tool.reviewJson, connectionDisplayName: connection.displayName
    });
    return this.details.at(-1)!;
  }
  async getCall(id: string, scope: DataScope) { return this.calls.find((item) => item.id === id && inScope(item.teamId, item.ownerId, scope)) || null; }
  async getCallByRequestId(requestId: string, scope: DataScope) {
    return this.calls.find((item) => item.requestId === requestId && inScope(item.teamId, item.ownerId, scope)) || null;
  }
  async listApprovalDetails(scope: DataScope) { return this.details.filter((item) => inScope(item.approval.teamId, item.approval.ownerId, scope)); }
  async getApprovalDetail(id: string, scope: DataScope) { return this.details.find((item) => item.approval.id === id && inScope(item.approval.teamId, item.approval.ownerId, scope)) || null; }
  async consumeApproval(id: string, scope: DataScope, approverId: string) {
    const detail = await this.getApprovalDetail(id, scope);
    if (!detail) throw Object.assign(new Error("not found"), { status: 404 });
    if (this.contextChanged) {
      detail.approval.status = "cancelled";
      throw Object.assign(new Error("参数、权限或工具状态已变化"), { code: "INTEGRATION_APPROVAL_CHANGED", status: 409 });
    }
    if (detail.approval.status !== "pending") throw Object.assign(new Error("审批已处理，不能重复批准"), { status: 409 });
    detail.approval.status = "consumed";
    detail.approval.decidedBy = approverId;
    detail.callStatus = "queued";
    const call = this.calls.find((item) => item.id === detail.approval.callId)!;
    call.status = "queued";
    return call;
  }
  async rejectApproval() { throw new Error("not used"); }
  async reconcileCall(input: ReconcileCallInput, scope: DataScope) {
    const call = await this.getCall(input.callId, scope);
    if (!call) throw Object.assign(new Error("not found"), { status: 404 });
    if (!new Set(["unknown_outcome", "reconciliation_required"]).has(call.status)) {
      throw Object.assign(new Error("只有结果未知的调用可以对账"), { status: 409 });
    }
    this.reconciled = input;
    call.status = input.outcome;
    call.externalReceipt = input.externalReceipt;
    call.evidenceJson = JSON.stringify(input.evidence);
    call.resultArtifactId = input.artifact?.id || "";
    return call;
  }
}

class FakeQueue {
  calls: string[] = [];
  async enqueueToolCall(id: string) { this.calls.push(id); }
  async enqueueDiscovery() {}
  async enqueueAuthorizationPrepare() {}
  async enqueueAuthorizationComplete() {}
  async enqueueCredentialRevoke() {}
  async enqueueDisconnect() {}
  async enqueueWebhookSync() {}
  async enqueueTerminate() {}
  async close() {}
}

const repository = new FakeApprovalRepository();
const queue = new FakeQueue();
const service = new IntegrationControlPlaneService(repository as never, queue, key);
await assert.rejects(() => service.createReadOnlyCall(sales, tool.stableAlias, {
  recipient: "buyer@example.test", subject: "Quote", body: "Final quotation", apiToken: "must-not-leave"
}), /不允许发送/u);

const call = await service.createReadOnlyCall(sales, tool.stableAlias, {
  recipient: "buyer@example.test", subject: "Quote", body: "Final quotation"
}, "stage3_request_001");
assert.equal(call?.status, "awaiting_approval");
assert.equal(queue.calls.length, 0);
const pending = await service.approvals(manager, "pending");
assert.equal(pending.length, 1);
assert.equal(pending[0]!.frozenInput.recipient, "buyer@example.test");
assert.equal((pending[0]!.inputSummary.dataEgress as { fields: unknown[] }).fields.length, 3);
assert.equal((await service.approvals(foreignManager, "pending")).length, 0);
assert.ok(store.internalMessages.some((message) => message.relatedType === "integration_approval"
  && message.relatedId === call!.approvalId && message.recipientId === manager.id));

await service.approveExecution(manager, call!.approvalId);
assert.deepEqual(queue.calls, [call!.id]);
await assert.rejects(() => service.approveExecution(manager, call!.approvalId), /重复批准|已处理/u);
assert.deepEqual(queue.calls, [call!.id]);

const changedCall = await service.createReadOnlyCall(sales, tool.stableAlias, {
  recipient: "buyer2@example.test", subject: "Changed", body: "Changed context"
}, "stage3_request_002");
repository.contextChanged = true;
await assert.rejects(() => service.approveExecution(manager, changedCall!.approvalId), /已变化/u);
assert.deepEqual(queue.calls, [call!.id]);

const unknownCall: IntegrationToolCall = {
  ...repository.calls[0]!, id: "stage3_unknown_call", requestId: "stage3_unknown_request",
  status: "unknown_outcome", approvalId: "", errorCode: "INTEGRATION_UNKNOWN_OUTCOME",
  errorMessage: "socket closed after request", resultArtifactId: "", externalReceipt: ""
};
repository.calls.push(unknownCall);
await assert.rejects(() => service.reconcileExecution(foreignManager, unknownCall.id, {
  outcome: "succeeded", note: "checked", externalReceipt: "receipt-foreign"
}), /无权访问|不存在|not found/u);
const reconciled = await service.reconcileExecution(manager, unknownCall.id, {
  outcome: "succeeded", note: "在外部系统按请求号回查确认已发送", externalReceipt: "receipt-stage3-001"
});
assert.equal(reconciled?.status, "succeeded");
assert.ok(repository.reconciled?.artifact?.encryptedValue);
await assert.rejects(() => service.reconcileExecution(manager, unknownCall.id, {
  outcome: "succeeded", note: "repeat", externalReceipt: "receipt-stage3-001"
}), /只有结果未知/u);

console.log(JSON.stringify({
  ok: true,
  r4FrozenApproval: true,
  dataEgressSecretDenied: true,
  approverNotificationCreated: true,
  crossTeamApprovalHidden: true,
  approvalSingleUse: true,
  repeatedApprovalDoesNotQueueTwice: true,
  changedContextCancelsApproval: true,
  unknownOutcomeReconciledOnce: true
}, null, 2));
