import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IntegrationControlPlaneService } from "./integration-service.js";
import { decryptIntegrationValue, encryptIntegrationValue } from "./integration-credential-vault.js";
import type { ConnectorDefinition, IntegrationConnection, IntegrationConnectorReview, IntegrationToolCall, ToolSnapshot } from "./integration-types.js";
import type { SessionUser } from "../types.js";

function user(role: SessionUser["role"], id: string, teamId: string): SessionUser {
  return { id, teamId, role, name: id, email: `${id}@example.com`, avatar: id[0], authVersion: 1 };
}

const adminA = user("admin", "admin_a", "team_a");
const superAdmin = user("super_admin", "super_admin_test", "platform");
superAdmin.iamSource = "platform";
superAdmin.iamPermissions = { "platform.integration.connector.review": ["tenant"] };
const salesA = user("sales", "sales_a", "team_a");
const salesB = user("sales", "sales_b", "team_b");
const now = "2026-08-07T00:00:00.000Z";
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const connector: ConnectorDefinition = {
  id: "icn_fake", code: "fake-mcp", version: "1.0.0", type: "native_mcp",
  trust: "system", status: "active", teamId: "", name: "Fake MCP", description: "test",
  manifestJson: JSON.stringify({ endpoint: "https://mcp.example.test/mcp", approvedHosts: ["mcp.example.test"], allowedPorts: [443] }),
  manifestHash: "hash", createdBy: "system", createdAt: now, updatedAt: now
};
const googleConnector: ConnectorDefinition = {
  ...connector,
  id: "icn_system_google-workspace",
  code: "google-workspace",
  type: "official_api",
  name: "Google Workspace"
};

class FakeRepository {
  connectors = [connector, googleConnector];
  connectorReviews: IntegrationConnectorReview[] = [];
  connections: IntegrationConnection[] = [];
  tools: ToolSnapshot[] = [];
  calls: IntegrationToolCall[] = [];
  grants = new Set<string>();
  resultArtifacts = new Map<string, { encryptedValue: string; teamId: string; ownerId: string; connectionId: string }>();
  approvalInputs: Array<Record<string, any>> = [];
  businessLinks: Array<Record<string, any>> = [];
  webhookWritebacks: Array<Record<string, any>> = [];
  webhookLinkTransitions: string[] = [];
  dailyUsageRows = new Map<string, {
    usageDate: string; teamId: string; connectionId: string; toolSnapshotId: string;
    callCount: number; successCount: number; failureCount: number; inputBytes: number;
    outputBytes: number; estimatedCost: number; updatedAt: string;
  }>();

  private reserveDailyCallQuota(input: {
    createdAt: string; teamId: string; connectionId: string; toolSnapshotId: string;
    dailyCallLimit: number; inputBytes: number;
  }) {
    const usageDate = input.createdAt.slice(0, 10);
    const key = `${usageDate}:${input.teamId}:${input.connectionId}:${input.toolSnapshotId}`;
    const row = this.dailyUsageRows.get(key) || {
      usageDate, teamId: input.teamId, connectionId: input.connectionId, toolSnapshotId: input.toolSnapshotId,
      callCount: 0, successCount: 0, failureCount: 0, inputBytes: 0, outputBytes: 0,
      estimatedCost: 0, updatedAt: input.createdAt
    };
    if (row.callCount >= input.dailyCallLimit) {
      throw Object.assign(new Error(`今日调用次数已达到上限（${row.callCount}/${input.dailyCallLimit}）`), {
        code: "INTEGRATION_DAILY_QUOTA_EXCEEDED",
        status: 429
      });
    }
    row.callCount += 1;
    row.inputBytes += input.inputBytes;
    row.updatedAt = input.createdAt;
    this.dailyUsageRows.set(key, row);
  }

  async listCatalog(teamId: string, options: { includeReview?: boolean; platform?: boolean } = {}) {
    return this.connectors.filter((item) => options.platform
      || (item.teamId === "" && ["active", "draft"].includes(item.status))
      || (item.teamId === teamId && (item.status === "active" || (options.includeReview && ["review", "disabled"].includes(item.status)))));
  }
  async getConnector(id: string) { return this.connectors.find((item) => item.id === id) || null; }
  async findTeamConnectorByCode(teamId: string, code: string) {
    return this.connectors.find((item) => item.teamId === teamId && item.code === code) || null;
  }
  async createPrivateConnectorReview(privateConnector: ConnectorDefinition, review: IntegrationConnectorReview) {
    this.connectors.push(privateConnector);
    this.connectorReviews.push(review);
    return { connector: privateConnector, review };
  }
  async listConnectorReviews(status = "", teamId = "") {
    return this.connectorReviews.filter((item) => (!status || item.status === status) && (!teamId || item.teamId === teamId));
  }
  async decideConnectorReview(connectorId: string, reviewerId: string, decision: "approved" | "rejected", note: string) {
    const review = this.connectorReviews.find((item) => item.connectorId === connectorId);
    const privateConnector = this.connectors.find((item) => item.id === connectorId);
    if (!review || !privateConnector) throw new Error("not found");
    if (review.status !== "pending") throw new Error("review conflict");
    Object.assign(review, { status: decision, reviewedBy: reviewerId, reviewNote: note, updatedAt: now });
    Object.assign(privateConnector, {
      status: decision === "approved" ? "active" : "disabled",
      trust: decision === "approved" ? "certified" : "quarantined",
      updatedAt: now
    });
    return { connector: privateConnector, review };
  }
  async createConnection(input: Omit<IntegrationConnection, "revision" | "lastHealthAt" | "lastErrorCode" | "lastErrorMessage" | "serverInfoJson" | "warningMessage" | "createdAt" | "updatedAt" | "disconnectedAt">) {
    const value: IntegrationConnection = {
      ...input, revision: 1, lastHealthAt: "", lastErrorCode: "", lastErrorMessage: "",
      serverInfoJson: "{}", warningMessage: "", createdAt: now, updatedAt: now, disconnectedAt: ""
    };
    this.connections.push(value);
    return value;
  }
  async transitionConnection(id: string, _scope: unknown, expected: string, next: IntegrationConnection["status"]) {
    const value = this.connections.find((item) => item.id === id && item.status === expected);
    if (!value) throw new Error("state conflict");
    value.status = next;
    value.revision += 1;
    return value;
  }
  async listConnections(scope: { type: string; teamId?: string; ownerId?: string }) {
    return this.connections.filter((item) => scope.type === "platform"
      || (scope.type === "team" && item.teamId === scope.teamId)
      || (scope.type === "personal" && item.teamId === scope.teamId && (item.scope === "team" || item.ownerId === scope.ownerId)));
  }
  async getConnection(id: string, scope: { type: string; teamId?: string; ownerId?: string }) {
    return (await this.listConnections(scope)).find((item) => item.id === id) || null;
  }
  async listTools(scope: { type: string; teamId?: string; ownerId?: string }, connectionId = "") {
    return this.tools.filter((tool) => (!connectionId || tool.connectionId === connectionId)
      && (scope.type === "platform" || tool.teamId === scope.teamId)
      && (scope.type !== "personal" || this.connections.some((connection) => connection.id === tool.connectionId
        && (connection.scope === "team" || connection.ownerId === scope.ownerId))));
  }
  async getTool(id: string, scope: { type: string; teamId?: string; ownerId?: string }) {
    return (await this.listTools(scope)).find((item) => item.id === id) || null;
  }
  async reviewTool(id: string, scope: { type: string; teamId?: string; ownerId?: string }, input: {
    status: ToolSnapshot["status"]; stableAlias: string; riskLevel: number; permissionCode: string; review: unknown; reviewerId: string;
  }) {
    const tool = await this.getTool(id, scope);
    if (!tool) throw new Error("not found");
    Object.assign(tool, { status: input.status, stableAlias: input.stableAlias, riskLevel: input.riskLevel,
      permissionCode: input.permissionCode, reviewJson: JSON.stringify(input.review), reviewedBy: input.reviewerId });
    return tool;
  }
  async replaceGrants(tool: ToolSnapshot, _actorId: string, grants: Array<{ subjectId: string; permissionCode: string }>) {
    grants.forEach((grant) => this.grants.add(`${tool.id}:${grant.subjectId}:${grant.permissionCode}`));
    return [];
  }
  async countPendingReviewTools(connectionId: string) { return this.tools.filter((item) => item.connectionId === connectionId && item.status === "pending_review").length; }
  async countActiveTools(connectionId: string) { return this.tools.filter((item) => item.connectionId === connectionId && item.status === "active").length; }
  async connectionStatuses(connectionId: string) { return this.connections.find((item) => item.id === connectionId)?.status || null; }
  async cancelConnectionApprovals() {}
  async findActiveToolByAlias(alias: string, scope: { type: string; teamId?: string; ownerId?: string }) {
    return (await this.listTools(scope)).find((item) => item.stableAlias === alias && item.status === "active"
      && this.connections.find((connection) => connection.id === item.connectionId)?.status === "active") || null;
  }
  async findActivePersonalToolByRemoteName(remoteName: string, actor: SessionUser, connectorCode: string) {
    const connectorId = connectorCode === "microsoft-365"
      ? "icn_system_microsoft-365"
      : connectorCode === "google-workspace" ? "icn_system_google-workspace" : "";
    if (!connectorId) return null;
    return this.tools.find((tool) => tool.remoteName === remoteName && tool.status === "active"
      && this.connections.some((connection) => connection.id === tool.connectionId && connection.status === "active"
        && connection.connectorId === connectorId && connection.scope === "personal"
        && connection.ownerId === actor.id && connection.teamId === actor.teamId)) || null;
  }
  async hasActiveGrant(tool: ToolSnapshot, actor: SessionUser) { return this.grants.has(`${tool.id}:${tool.teamId}:${tool.permissionCode}`); }
  async createReadCall(input: {
    id: string; requestId: string; teamId: string; ownerId: string; actorId: string; actorAuthVersion: number;
    connectionId: string; toolSnapshotId: string; riskLevel: number; inputHash: string; inputSummary: unknown;
    dailyCallLimit: number; inputBytes: number; idempotencyKeyHash: string; artifact: { id: string }; createdAt: string;
  }) {
    this.reserveDailyCallQuota(input);
    const call: IntegrationToolCall = {
      id: input.id, requestId: input.requestId, teamId: input.teamId, ownerId: input.ownerId,
      actorId: input.actorId, actorAuthVersion: input.actorAuthVersion, connectionId: input.connectionId,
      toolSnapshotId: input.toolSnapshotId, approvalId: "", status: "queued", riskLevel: input.riskLevel,
      inputHash: input.inputHash, inputArtifactId: input.artifact.id, inputSummaryJson: JSON.stringify(input.inputSummary),
      outputHash: "", resultArtifactId: "", outputSummaryJson: "{}", idempotencyKeyHash: input.idempotencyKeyHash,
      externalReceipt: "", evidenceJson: "{}", errorCode: "", errorMessage: "", attemptCount: 0,
      createdAt: input.createdAt, queuedAt: input.createdAt, startedAt: "", finishedAt: "", updatedAt: input.createdAt
    };
    this.calls.push(call);
    return call;
  }
  async createApprovalCall(input: Record<string, any>) {
    this.reserveDailyCallQuota(input as {
      createdAt: string; teamId: string; connectionId: string; toolSnapshotId: string;
      dailyCallLimit: number; inputBytes: number;
    });
    this.approvalInputs.push(input);
    const call: IntegrationToolCall = {
      id: input.id, requestId: input.requestId, teamId: input.teamId, ownerId: input.ownerId,
      actorId: input.actorId, actorAuthVersion: input.actorAuthVersion, connectionId: input.connectionId,
      toolSnapshotId: input.toolSnapshotId, approvalId: input.approval.id, status: "awaiting_approval", riskLevel: input.riskLevel,
      inputHash: input.inputHash, inputArtifactId: input.artifact.id, inputSummaryJson: JSON.stringify(input.inputSummary),
      outputHash: "", resultArtifactId: "", outputSummaryJson: "{}", idempotencyKeyHash: input.idempotencyKeyHash,
      externalReceipt: "", evidenceJson: "{}", errorCode: "", errorMessage: "", attemptCount: 0,
      createdAt: input.createdAt, queuedAt: "", startedAt: "", finishedAt: "", updatedAt: input.createdAt
    };
    this.calls.push(call);
    if (input.businessLink) {
      this.businessLinks.push({
        ...input.businessLink, callId: input.id, teamId: input.teamId, ownerId: input.ownerId,
        externalObjectId: "", writebackStatus: "pending", lastError: "", createdAt: input.createdAt, updatedAt: input.createdAt
      });
    }
    return null;
  }
  async listCalls(scope: { type: string; teamId?: string; ownerId?: string }) {
    return this.calls.filter((item) => scope.type === "platform" || (item.teamId === scope.teamId && (scope.type === "team" || item.ownerId === scope.ownerId)));
  }
  async listDailyUsage(scope: { type: string; teamId?: string; ownerId?: string }, usageDate: string) {
    const visibleConnections = new Set((await this.listConnections(scope)).map((item) => item.id));
    return [...this.dailyUsageRows.values()].filter((item) => item.usageDate === usageDate
      && (scope.type === "platform" || (item.teamId === scope.teamId && visibleConnections.has(item.connectionId))));
  }
  async getCall(id: string, scope: { type: string; teamId?: string; ownerId?: string }) { return (await this.listCalls(scope)).find((item) => item.id === id) || null; }
  async getCallByRequestId(requestId: string, scope: { type: string; teamId?: string; ownerId?: string }) { return (await this.listCalls(scope)).find((item) => item.requestId === requestId) || null; }
  async getCallResultArtifact(id: string, scope: { type: string; teamId?: string; ownerId?: string }) {
    return await this.getCall(id, scope) ? this.resultArtifacts.get(id) || null : null;
  }
  async listPendingBusinessWritebacks() {
    return this.businessLinks.filter((link) => link.writebackStatus === "pending"
      && this.calls.some((call) => call.id === link.callId && call.status === "succeeded"));
  }
  async getBusinessLinkByCall(callId: string, scope: { type: string; teamId?: string; ownerId?: string }) {
    const call = await this.getCall(callId, scope);
    return call ? this.businessLinks.find((link) => link.callId === callId) || null : null;
  }
  async listBusinessThreadLinks(teamId: string, ownerId: string, threadIds: string[]) {
    return this.businessLinks.filter((link) => link.teamId === teamId && link.ownerId === ownerId
      && link.writebackStatus === "completed" && threadIds.includes(link.externalThreadId));
  }
  async completeBusinessWriteback(id: string, externalObjectId: string, externalThreadId: string) {
    const link = this.businessLinks.find((item) => item.id === id && item.writebackStatus === "pending");
    if (!link) return false;
    Object.assign(link, { writebackStatus: "completed", externalObjectId, externalThreadId });
    return true;
  }
  async failBusinessWriteback(id: string, error: unknown) {
    const link = this.businessLinks.find((item) => item.id === id);
    if (link) Object.assign(link, { writebackStatus: "failed", lastError: error instanceof Error ? error.message : String(error) });
  }
  async listPendingWebhookWritebacks() {
    return this.webhookWritebacks.filter((event) => event.writebackStatus === "pending");
  }
  async getWebhookEvent(id: string) {
    const event = this.webhookWritebacks.find((item) => item.eventId === id);
    return event ? {
      ...event,
      id: event.eventId,
      status: "processed",
      attemptCount: 1,
      resultJson: "{}",
      errorCode: "",
      errorMessage: "",
      receivedAt: now,
      processedAt: now,
      businessWrittenAt: event.writebackStatus === "completed" ? now : "",
      updatedAt: now
    } : null;
  }
  async linkWebhookEventCustomer(id: string, scope: { type: string; teamId?: string; ownerId?: string }, customerId: string) {
    const event = this.webhookWritebacks.find((item) => item.eventId === id
      && ["needs_match", "failed"].includes(item.writebackStatus)
      && (scope.type === "platform" || (item.teamId === scope.teamId
        && (scope.type === "team" || item.ownerId === scope.ownerId))));
    if (!event) throw new Error("事件不存在、无权访问或当前不需要关联客户");
    Object.assign(event, { linkedObjectId: customerId, writebackStatus: "pending" });
    this.webhookLinkTransitions.push(event.writebackStatus);
    return this.getWebhookEvent(id);
  }
  async completeWebhookWriteback(id: string, status: string, linkedObjectId = "") {
    const event = this.webhookWritebacks.find((item) => item.eventId === id && item.writebackStatus === "pending");
    if (!event) return false;
    Object.assign(event, { writebackStatus: status, linkedObjectId });
    return true;
  }
  async failWebhookWriteback(id: string, error: unknown) {
    const event = this.webhookWritebacks.find((item) => item.eventId === id);
    if (event) Object.assign(event, { writebackStatus: "failed", lastError: error instanceof Error ? error.message : String(error) });
  }
}

class FakeQueue {
  discoveries: Array<{ connectionId: string; mode: string }> = [];
  calls: string[] = [];
  terminations: string[] = [];
  async enqueueDiscovery(connectionId: string, mode: "initial" | "refresh") { this.discoveries.push({ connectionId, mode }); }
  async enqueueAuthorizationPrepare() {}
  async enqueueAuthorizationComplete() {}
  async enqueueCredentialRevoke(connectionId: string) { this.terminations.push(connectionId); }
  async enqueueDisconnect(connectionId: string) { this.terminations.push(connectionId); }
  async enqueueWebhookSync(connectionId: string) { this.terminations.push(connectionId); }
  async enqueueTerminate(connectionId: string) { this.terminations.push(connectionId); }
  async enqueueToolCall(callId: string) { this.calls.push(callId); }
  async close() {}
}

const repository = new FakeRepository();
const queue = new FakeQueue();
const credentialKey = "integration-test-key-with-at-least-32-characters";
const service = new IntegrationControlPlaneService(repository as never, queue, credentialKey);
const connection = await service.createConnection(adminA, { connectorId: connector.id, scope: "team", displayName: "Team A MCP" });
assert.equal(connection.status, "discovering");
assert.deepEqual(queue.discoveries, [{ connectionId: connection.id, mode: "initial" }]);

connection.status = "pending_review";
repository.tools.push({
  id: "tool_lookup", connectionId: connection.id, teamId: "team_a", remoteName: "company.lookup",
  stableAlias: "", displayName: "Company Lookup", description: "read", inputSchemaJson: JSON.stringify({
    type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false
  }), outputSchemaJson: "{}", schemaHash: "schema_1", riskLevel: 1, status: "pending_review", revision: 1,
  discoveredAt: now, reviewedAt: "", reviewedBy: "", permissionCode: "", reviewJson: "{}", createdAt: now, updatedAt: now
});
await assert.rejects(() => service.approveTool(salesA, "tool_lookup", {
  stableAlias: "company.lookup", riskLevel: 1, permissionCode: "company.read",
  fieldAllowlist: ["query"], dailyCallLimit: 100
}), /权限/u);
await assert.rejects(() => service.connection(salesB, connection.id), /无权访问/u);
await service.approveTool(adminA, "tool_lookup", {
  stableAlias: "company.lookup", riskLevel: 1, permissionCode: "company.read",
  fieldAllowlist: ["query"], dailyCallLimit: 100
});
assert.equal(connection.status, "active");
const agentCatalog = await service.agentToolCatalog(salesA);
assert.deepEqual(agentCatalog.map((item) => item.stableAlias), ["company.lookup"]);

const call = await service.createReadOnlyCall(salesA, "company.lookup", { query: "Example", teamId: "forged" }, "req_stage1_test");
assert.equal(call?.status, "queued");
assert.deepEqual(queue.calls, [call!.id]);
assert.equal(JSON.parse(call!.inputSummaryJson).fields.includes("teamId"), false);
await assert.rejects(() => service.createReadOnlyCall(salesB, "company.lookup", { query: "Example" }), /工具不存在/u);
await assert.rejects(() => service.call(salesB, call!.id), /无权访问/u);
call!.status = "succeeded";
call!.evidenceJson = JSON.stringify({ source: "fake-mcp://company.lookup", observedAt: now });
call!.outputSummaryJson = JSON.stringify({ structuredKeys: ["company", "source", "observedAt"] });
call!.externalReceipt = "fake-mcp://company.lookup";
repository.resultArtifacts.set(call!.id, {
  encryptedValue: encryptIntegrationValue({ structuredContent: { company: "Example", source: "fake-mcp://company.lookup", observedAt: now } }, credentialKey, {
    teamId: call!.teamId,
    ownerId: call!.ownerId,
    connectionId: call!.connectionId,
    artifactType: "tool_result"
  }),
  teamId: call!.teamId,
  ownerId: call!.ownerId,
  connectionId: call!.connectionId
});
const agentResult = await service.waitForReadOnlyCall(salesA, call!.id, 1_000);
assert.equal(agentResult.evidence.source, "fake-mcp://company.lookup");
assert.equal((agentResult.result.structuredContent as Record<string, unknown>).company, "Example");

repository.tools[0]!.status = "quarantined";
await service.approveTool(adminA, "tool_lookup", {
  stableAlias: "company.lookup", riskLevel: 1, permissionCode: "company.read",
  fieldAllowlist: ["query"], dailyCallLimit: 100
});
assert.equal(repository.tools[0]!.status, "active");

await service.pauseConnection(adminA, connection.id);
assert.equal(connection.status, "paused");
await assert.rejects(() => service.createReadOnlyCall(salesA, "company.lookup", { query: "Example" }), /工具不存在/u);
await service.resumeConnection(adminA, connection.id);
assert.equal(connection.status, "active");
const resumedCall = await service.createReadOnlyCall(salesA, "company.lookup", { query: "After resume" }, "req_after_resume");
assert.equal(resumedCall?.status, "queued");

const microsoftConnection: IntegrationConnection = {
  id: "icx_microsoft_sales_a", connectorId: "icn_system_microsoft-365", teamId: salesA.teamId,
  ownerId: salesA.id, scope: "personal", scopeId: salesA.id, status: "active", displayName: "Sales A Outlook",
  revision: 1, lastHealthAt: now, lastErrorCode: "", lastErrorMessage: "", serverInfoJson: "{}",
  warningMessage: "", createdAt: now, updatedAt: now, disconnectedAt: ""
};
repository.connections.push(microsoftConnection);
const mailSchema = {
  type: "object", additionalProperties: false, required: ["to", "subject", "body"],
  properties: {
    to: { type: "array", minItems: 1, items: { type: "string" } },
    cc: { type: "array", items: { type: "string" } },
    subject: { type: "string" }, body: { type: "string" }, bodyType: { type: "string" },
    threadId: { type: "string" }, inReplyTo: { type: "string" },
    attachments: { type: "array", items: { type: "object" } }
  }
};
repository.tools.push({
  id: "tool_mail_send", connectionId: microsoftConnection.id, teamId: salesA.teamId, remoteName: "mail.send_message",
  stableAlias: "mail.send_message", displayName: "发送邮件", description: "send", inputSchemaJson: JSON.stringify(mailSchema),
  outputSchemaJson: "{}", schemaHash: "schema_mail_send", riskLevel: 4, status: "active", revision: 1,
  discoveredAt: now, reviewedAt: now, reviewedBy: adminA.id, permissionCode: "mail.send",
  reviewJson: JSON.stringify({
    fieldAllowlist: Object.keys(mailSchema.properties), approvalPolicy: "always",
    completionEvidence: ["external_receipt_id", "delivery_acceptance"],
    dataEgressPolicy: { allowedClassifications: ["public", "business", "personal", "sensitive"], secretFieldsDenied: true }
  }), createdAt: now, updatedAt: now
});
repository.grants.add(`tool_mail_send:${salesA.teamId}:mail.send`);
const businessStore = (await import("../store.js")).getStore();
if (!businessStore.users.some((item) => item.id === salesA.id)) {
  businessStore.users.push({ ...salesA, password: "", status: "active" });
}
if (!businessStore.users.some((item) => item.id === adminA.id)) {
  businessStore.users.push({ ...adminA, password: "", status: "active" });
}
if (!businessStore.users.some((item) => item.id === superAdmin.id)) {
  businessStore.users.push({ ...superAdmin, password: "", status: "active" });
}
businessStore.customers.push({
  id: "customer_mail_a", company: "Mail Buyer", country: "US", contact: "Buyer", ownerId: salesA.id,
  teamId: salesA.teamId, stage: "已联系", amount: 0, health: 80, nextReminder: "", wecomBound: false,
  billingName: "", billingAddress: "", documentContact: "buyer@mailbuyer.example", defaultPortDischarge: "",
  defaultIncoterm: "", defaultPaymentTerm: "", poolStatus: "owned"
});
businessStore.customers.push({
  id: "customer_mail_b", company: "Foreign Buyer", country: "DE", contact: "Buyer", ownerId: salesB.id,
  teamId: salesB.teamId, stage: "已联系", amount: 0, health: 80, nextReminder: "", wecomBound: false,
  billingName: "", billingAddress: "", documentContact: "buyer@foreign.example", defaultPortDischarge: "",
  defaultIncoterm: "", defaultPaymentTerm: "", poolStatus: "owned"
});
businessStore.customers.push({
  id: "customer_mail_team_a", company: "Team Buyer", country: "GB", contact: "Team Buyer", ownerId: "sales_teammate_a",
  teamId: salesA.teamId, stage: "已联系", amount: 0, health: 80, nextReminder: "", wecomBound: false,
  billingName: "", billingAddress: "", documentContact: "team.buyer@team-buyer.example", defaultPortDischarge: "",
  defaultIncoterm: "", defaultPaymentTerm: "", poolStatus: "owned"
});
const mailBusinessCall = await service.microsoftSendMail(salesA, {
  customerId: "customer_mail_a", to: ["buyer@mailbuyer.example"], subject: "Quotation",
  body: "Please find our quotation attached.", nextFollowAt: "2026-08-12T09:00"
}, "request_microsoft_mail_send");
assert.equal(mailBusinessCall.call.status, "awaiting_approval");
assert.equal(repository.approvalInputs.length, 1);
assert.equal(repository.approvalInputs[0]!.businessLink.objectId, "customer_mail_a");
const frozenMailInput = decryptIntegrationValue<Record<string, unknown>>(repository.approvalInputs[0]!.artifact.encryptedValue, credentialKey, {
  teamId: salesA.teamId, ownerId: salesA.id, connectionId: microsoftConnection.id, artifactType: "tool_input"
});
assert.equal(Object.hasOwn(frozenMailInput, "customerId"), false);
assert.equal(frozenMailInput.subject, "Quotation");
assert.equal((JSON.parse(mailBusinessCall.call.inputSummaryJson).businessContext as Record<string, unknown>).objectId, "customer_mail_a");
const replayedMailBusinessCall = await service.microsoftSendMail(salesA, {
  customerId: "customer_mail_a", to: ["buyer@mailbuyer.example"], subject: "Quotation",
  body: "Please find our quotation attached.", nextFollowAt: "2026-08-12T09:00"
}, "request_microsoft_mail_send");
assert.equal(replayedMailBusinessCall.call.id, mailBusinessCall.call.id);
assert.equal(repository.approvalInputs.length, 1);
await assert.rejects(() => service.microsoftSendMail(salesA, {
  customerId: "customer_mail_a", to: ["buyer@mailbuyer.example"], subject: "Changed quotation", body: "Changed body"
}, "request_microsoft_mail_send"), /requestId/u);
mailBusinessCall.call.status = "succeeded";
mailBusinessCall.call.externalReceipt = "graph-message-001";
repository.resultArtifacts.set(mailBusinessCall.call.id, {
  encryptedValue: encryptIntegrationValue({ structuredContent: {
    messageId: "graph-message-001", externalReceiptId: "graph-message-001", deliveryAccepted: true,
    conversationId: "graph-thread-001", observedAt: "2026-08-07T03:00:00.000Z"
  } }, credentialKey, {
    teamId: salesA.teamId, ownerId: salesA.id, connectionId: microsoftConnection.id, artifactType: "tool_result"
  }),
  teamId: salesA.teamId, ownerId: salesA.id, connectionId: microsoftConnection.id
});
await service.processBusinessWritebacks();
const writebackActivity = businessStore.customerActivities.filter((activity) => activity.customerId === "customer_mail_a" && activity.content.includes("Quotation"));
const writebackTodo = businessStore.todos.filter((todo) => todo.triggerKey === `integration:${mailBusinessCall.call.id}`);
assert.equal(writebackActivity.length, 1);
assert.equal(writebackTodo.length, 1);
assert.equal(repository.businessLinks[0]!.writebackStatus, "completed");
assert.equal(repository.businessLinks[0]!.externalObjectId, "graph-message-001");
await service.processBusinessWritebacks();
assert.equal(businessStore.customerActivities.filter((activity) => activity.id === writebackActivity[0]!.id).length, 1);
assert.equal(businessStore.todos.filter((todo) => todo.id === writebackTodo[0]!.id).length, 1);

const googleConnection: IntegrationConnection = {
  ...microsoftConnection,
  id: "icx_google_sales_a",
  connectorId: "icn_system_google-workspace",
  displayName: "Sales A Gmail"
};
repository.connections.push(googleConnection);
repository.tools.push({
  ...repository.tools.find((tool) => tool.id === "tool_mail_send")!,
  id: "tool_google_mail_send",
  connectionId: googleConnection.id,
  schemaHash: "schema_google_mail_send"
});
repository.grants.add(`tool_google_mail_send:${salesA.teamId}:mail.send`);
const googleBusinessCall = await service.googleSendMail(salesA, {
  customerId: "customer_mail_a", to: ["buyer@mailbuyer.example"], subject: "Google quotation",
  body: "Please review the quotation.", conversationId: "gmail-thread-001", inReplyTo: "<gmail-message-000@example.com>"
}, "request_google_mail_send");
assert.equal(googleBusinessCall.call.status, "awaiting_approval");
const googleApproval = repository.approvalInputs.find((item) => item.id === googleBusinessCall.call.id)!;
const frozenGoogleInput = decryptIntegrationValue<Record<string, unknown>>(googleApproval.artifact.encryptedValue, credentialKey, {
  teamId: salesA.teamId, ownerId: salesA.id, connectionId: googleConnection.id, artifactType: "tool_input"
});
assert.equal(frozenGoogleInput.threadId, "gmail-thread-001");
assert.equal(frozenGoogleInput.inReplyTo, "<gmail-message-000@example.com>");
assert.equal(Object.hasOwn(frozenGoogleInput, "customerId"), false);
await assert.rejects(() => service.googleSendMail(salesB, {
  customerId: "customer_mail_b", to: ["buyer@foreign.example"], subject: "Foreign", body: "Hidden"
}, "request_google_foreign"), /Google Workspace/u);
googleBusinessCall.call.status = "succeeded";
googleBusinessCall.call.externalReceipt = "gmail-message-001";
repository.resultArtifacts.set(googleBusinessCall.call.id, {
  encryptedValue: encryptIntegrationValue({ structuredContent: {
    messageId: "gmail-message-001", externalReceiptId: "gmail-message-001", deliveryAccepted: true,
    threadId: "gmail-thread-001", observedAt: "2026-08-07T04:00:00.000Z"
  } }, credentialKey, {
    teamId: salesA.teamId, ownerId: salesA.id, connectionId: googleConnection.id, artifactType: "tool_result"
  }),
  teamId: salesA.teamId, ownerId: salesA.id, connectionId: googleConnection.id
});
await service.processBusinessWritebacks();
assert.equal(businessStore.customerActivities.filter((activity) => activity.customerId === "customer_mail_a" && activity.content.includes("Google Workspace 邮件已发送")).length, 1);
const inboundArtifact = {
  kind: "microsoft_inbound_message",
  message: {
    id: "graph-inbound-001",
    subject: "Re: Quotation",
    receivedDateTime: "2026-08-07T05:00:00.000Z",
    conversationId: "graph-thread-001",
    sender: { emailAddress: { address: "buyer@mailbuyer.example" } },
    body: { contentType: "text", content: "Please confirm delivery time." }
  },
  source: "microsoft-graph://me/messages/graph-inbound-001",
  observedAt: "2026-08-07T05:00:01.000Z"
};
repository.webhookWritebacks.push({
  eventId: "iev_inbound_001", connectionId: microsoftConnection.id, teamId: salesA.teamId,
  ownerId: salesA.id, eventType: "microsoft.message.created", externalEventId: "notification-inbound-001",
  resultArtifactId: "iar_inbound_001", linkedObjectId: "", writebackStatus: "pending",
  contentHash: hash(inboundArtifact),
  encryptedValue: encryptIntegrationValue(inboundArtifact, credentialKey, {
    teamId: salesA.teamId, ownerId: salesA.id, connectionId: microsoftConnection.id, artifactType: "webhook_result"
  })
});
await service.processInboundWebhookWritebacks();
assert.equal(repository.webhookWritebacks[0]!.writebackStatus, "completed");
assert.equal(repository.webhookWritebacks[0]!.linkedObjectId, "customer_mail_a");
assert.equal(businessStore.customerActivities.filter((activity) => activity.customerId === "customer_mail_a" && activity.content.includes("Re: Quotation")).length, 1);
assert.equal(businessStore.internalMessages.filter((message) => message.relatedType === "integration_event" && message.relatedId === "iev_inbound_001").length, 1);
const unmatchedArtifact = {
  kind: "microsoft_inbound_message",
  message: {
    id: "graph-inbound-unmatched-001",
    subject: "New sourcing request",
    receivedDateTime: "2026-08-07T06:00:00.000Z",
    conversationId: "graph-thread-unmatched-001",
    sender: { emailAddress: { address: "newbuyer@unknown-buyer.example" } },
    body: { contentType: "text", content: "Please send your catalog." }
  },
  source: "microsoft-graph://me/messages/graph-inbound-unmatched-001",
  observedAt: "2026-08-07T06:00:01.000Z"
};
repository.webhookWritebacks.push({
  eventId: "iev_inbound_unmatched_001", connectionId: microsoftConnection.id, teamId: salesA.teamId,
  ownerId: salesA.id, eventType: "microsoft.message.created", externalEventId: "notification-inbound-unmatched-001",
  resultArtifactId: "iar_inbound_unmatched_001", linkedObjectId: "", writebackStatus: "pending",
  contentHash: hash(unmatchedArtifact),
  encryptedValue: encryptIntegrationValue(unmatchedArtifact, credentialKey, {
    teamId: salesA.teamId, ownerId: salesA.id, connectionId: microsoftConnection.id, artifactType: "webhook_result"
  })
});
await service.processInboundWebhookWritebacks();
assert.equal(repository.webhookWritebacks[1]!.writebackStatus, "needs_match");
assert.equal(businessStore.customerActivities.filter((activity) => activity.content.includes("New sourcing request")).length, 0);
await service.linkWebhookEventCustomer(adminA, "iev_inbound_unmatched_001", "customer_mail_team_a");
assert.deepEqual(repository.webhookLinkTransitions, ["pending"]);
assert.equal(repository.webhookWritebacks[1]!.writebackStatus, "completed");
assert.equal(repository.webhookWritebacks[1]!.linkedObjectId, "customer_mail_team_a");
assert.equal(businessStore.customerActivities.filter((activity) => activity.customerId === "customer_mail_team_a" && activity.content.includes("New sourcing request")).length, 1);
await service.processInboundWebhookWritebacks();
assert.equal(businessStore.customerActivities.filter((activity) => activity.customerId === "customer_mail_team_a" && activity.content.includes("New sourcing request")).length, 1);
await assert.rejects(
  () => service.linkWebhookEventCustomer(adminA, "iev_inbound_unmatched_001", "customer_mail_b"),
  /不属于当前团队|不存在/u
);
await assert.rejects(() => service.microsoftSendMail(salesA, {
  customerId: "customer_mail_b", to: ["buyer@foreign.example"], subject: "Forbidden", body: "Should not send"
}, "request_cross_team_mail"), /不属于当前账号|不存在/u);

repository.dailyUsageRows.clear();
repository.tools[0]!.reviewJson = JSON.stringify({
  fieldAllowlist: ["query"], dailyCallLimit: 2
});
const quotaCallOne = await service.createReadOnlyCall(salesA, "company.lookup", { query: "Quota one" }, "request_quota_one");
const quotaReplay = await service.createReadOnlyCall(salesA, "company.lookup", { query: "Quota one" }, "request_quota_one");
assert.equal(quotaReplay?.id, quotaCallOne?.id);
await service.createReadOnlyCall(salesA, "company.lookup", { query: "Quota two" }, "request_quota_two");
await assert.rejects(
  () => service.createReadOnlyCall(salesA, "company.lookup", { query: "Quota three" }, "request_quota_three"),
  (cause: unknown) => (cause as { code?: string; status?: number }).code === "INTEGRATION_DAILY_QUOTA_EXCEEDED"
    && (cause as { status?: number }).status === 429
);
const usageDate = new Date().toISOString().slice(0, 10);
const ownUsage = await service.dailyUsage(salesA, usageDate);
assert.equal(ownUsage.length, 1);
assert.equal(ownUsage[0]!.callCount, 2);
assert.ok(ownUsage[0]!.inputBytes > 0);
assert.deepEqual(await service.dailyUsage(salesB, usageDate), []);
assert.equal(businessStore.internalMessages.filter((message) => message.recipientId === adminA.id
  && message.relatedType === "integration_connection" && message.relatedId === connection.id
  && message.subject.includes("配额已用尽")).length, 1);

await service.disconnectConnection(adminA, connection.id);
assert.equal(connection.status, "disconnected");
await assert.rejects(() => service.createReadOnlyCall(salesA, "company.lookup", { query: "After disconnect" }), /工具不存在/u);
assert.ok(queue.terminations.length >= 2);

const privateSubmission = await service.registerPrivateConnector(adminA, {
  name: "Team A Purchasing MCP",
  code: "team-a-purchasing",
  version: "1.0.0",
  description: "团队自有采购接口，只通过 Native MCP 协议访问。",
  manifest: {
    schemaVersion: "1.0",
    stage: "available",
    driver: "native_mcp",
    endpoint: "https://mcp.team-a.example/mcp",
    approvedHosts: ["mcp.team-a.example"],
    allowedPorts: [443],
    authentication: "none",
    maxTools: 20
  }
});
assert.equal(privateSubmission.connector.status, "review");
assert.equal(privateSubmission.connector.trust, "private");
await assert.rejects(
  () => service.createConnection(adminA, { connectorId: privateSubmission.connector.id, scope: "team", displayName: "Pending private MCP" }),
  /尚未开放连接/u
);
await assert.rejects(
  () => service.reviewPrivateConnector(adminA, privateSubmission.connector.id, { decision: "approved", note: "" }),
  /没有连接器审核权限/u
);
await assert.rejects(() => service.connectorReviews(salesA), /不能查看连接器审核/u);
assert.equal((await service.connectorReviews(adminA, "pending")).length, 1);
assert.equal((await service.catalog(salesB)).some((item) => item.id === privateSubmission.connector.id), false);
const approvedPrivate = await service.reviewPrivateConnector(superAdmin, privateSubmission.connector.id, {
  decision: "approved",
  note: "Manifest 与端点安全策略通过"
});
assert.equal(approvedPrivate.connector.status, "active");
assert.equal(approvedPrivate.connector.trust, "certified");
assert.equal((await service.catalog(salesA)).some((item) => item.id === privateSubmission.connector.id), true);
assert.equal((await service.catalog(salesB)).some((item) => item.id === privateSubmission.connector.id), false);
assert.ok(businessStore.internalMessages.some((message) => message.recipientId === superAdmin.id
  && message.relatedType === "integration_connector" && message.relatedId === privateSubmission.connector.id));
assert.ok(businessStore.internalMessages.some((message) => message.recipientId === adminA.id
  && message.relatedType === "integration_connector" && message.relatedId === privateSubmission.connector.id));

console.log(JSON.stringify({
  ok: true,
  connectionLifecycle: true,
  reviewAndGrant: true,
  salesReviewDenied: true,
  agentStableAliasCatalog: true,
  agentEvidenceReturned: true,
  quarantineReviewRecovery: true,
  teamToolVisibleToSales: true,
  crossTeamToolHidden: true,
  fieldAllowlistApplied: true,
  queuePayloadUsesIdsOnly: true,
  microsoftBusinessLinkInternalOnly: true,
  microsoftWriteRequiresApproval: true,
  microsoftRequestReplayIdempotent: true,
  microsoftCrmWritebackIdempotent: true,
  microsoftInboundMailMatchedAndWrittenBack: true,
  microsoftInboundMailManualLinkClosedLoop: true,
  microsoftInboundMailManualLinkIdempotent: true,
  microsoftCrossTeamCustomerDenied: true,
  googleWorkspaceWriteRequiresApproval: true,
  googleWorkspaceThreadReplyFrozen: true,
  googleWorkspaceCrmWritebackIdempotent: true,
  googleWorkspacePersonalAndTeamIsolation: true,
  dailyQuotaIdempotentAndIsolated: true,
  quotaAlertDeduplicated: true,
  privateConnectorReviewClosedLoop: true,
  privateConnectorTeamIsolation: true,
  pauseResumeDisconnect: true
}, null, 2));
