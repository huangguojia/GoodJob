import assert from "node:assert/strict";
import type { DataScope } from "../authorization.js";
import type { SessionUser } from "../types.js";
import { decryptIntegrationValue } from "./integration-credential-vault.js";
import { IntegrationControlPlaneService } from "./integration-service.js";
import type { ConnectorDefinition, IntegrationAuthTransaction, IntegrationConnection } from "./integration-types.js";

const now = "2026-08-07T00:00:00.000Z";
const key = "integration-oauth-service-test-key-with-32-characters";
const adminA: SessionUser = { id: "admin_a", teamId: "team_a", role: "admin", name: "A", email: "a@example.test", avatar: "A", authVersion: 1 };
const adminB: SessionUser = { id: "admin_b", teamId: "team_b", role: "admin", name: "B", email: "b@example.test", avatar: "B", authVersion: 1 };
const connector: ConnectorDefinition = {
  id: "icn_oauth", code: "oauth-mcp", version: "1.0.0", type: "native_mcp", trust: "system",
  status: "active", teamId: "", name: "OAuth MCP", description: "test", manifestHash: "hash", createdBy: "system",
  createdAt: now, updatedAt: now,
  manifestJson: JSON.stringify({
    endpoint: "https://mcp.example.test/mcp",
    approvedHosts: ["mcp.example.test", "auth.example.test"],
    allowedPorts: [443],
    authentication: "oauth2",
    oauth: { clientId: "goodjob-test", scopes: ["mcp.tools.read"] }
  })
};

function visible(connection: IntegrationConnection, scope: DataScope) {
  return scope.type === "platform" || (connection.teamId === scope.teamId
    && (scope.type === "team" || connection.ownerId === scope.ownerId));
}

class FakeOAuthRepository {
  connections: IntegrationConnection[] = [];
  transactions: IntegrationAuthTransaction[] = [];
  async getConnector(id: string) { return id === connector.id ? connector : null; }
  async createConnection(input: Omit<IntegrationConnection, "revision" | "lastHealthAt" | "lastErrorCode" | "lastErrorMessage" | "serverInfoJson" | "warningMessage" | "createdAt" | "updatedAt" | "disconnectedAt">) {
    const value: IntegrationConnection = { ...input, revision: 1, lastHealthAt: "", lastErrorCode: "", lastErrorMessage: "", serverInfoJson: "{}", warningMessage: "", createdAt: now, updatedAt: now, disconnectedAt: "" };
    this.connections.push(value);
    return value;
  }
  async getConnection(id: string, scope: DataScope) { return this.connections.find((item) => item.id === id && visible(item, scope)) || null; }
  async transitionConnection(id: string, scope: DataScope, expected: string, next: IntegrationConnection["status"]) {
    const value = await this.getConnection(id, scope);
    if (!value || value.status !== expected) throw new Error("state conflict");
    value.status = next;
    return value;
  }
  async latestAuthTransaction(connectionId: string, scope: DataScope) {
    const connection = await this.getConnection(connectionId, scope);
    return connection ? [...this.transactions].reverse().find((item) => item.connectionId === connectionId) || null : null;
  }
  async createAuthTransaction(input: IntegrationAuthTransaction) { this.transactions.push(input); return input; }
  async getAuthTransaction(id: string, scope: DataScope) {
    const value = this.transactions.find((item) => item.id === id);
    return value && await this.getConnection(value.connectionId, scope) ? value : null;
  }
  async findAuthTransactionForCallback(stateHash: string, code: string) {
    return code === connector.code ? this.transactions.find((item) => item.stateHash === stateHash) || null : null;
  }
  async markAuthCallbackReceived(id: string, encryptedContext: string) {
    const value = this.transactions.find((item) => item.id === id && item.status === "authorize_url_ready");
    if (!value) throw Object.assign(new Error("already consumed"), { status: 409 });
    value.status = "callback_received";
    value.encryptedContext = encryptedContext;
  }
  async failAuthTransaction(id: string) { const value = this.transactions.find((item) => item.id === id); if (value) value.status = "failed"; }
  async consumeAuthTransaction(id: string, connectionId: string) {
    const value = this.transactions.find((item) => item.id === id && item.connectionId === connectionId && item.status === "completed");
    if (!value) throw new Error("not complete");
    value.status = "consumed";
  }
}

class FakeOAuthQueue {
  prepared: string[] = [];
  completed: string[] = [];
  discoveries: string[] = [];
  async enqueueAuthorizationPrepare(id: string) { this.prepared.push(id); }
  async enqueueAuthorizationComplete(id: string) { this.completed.push(id); }
  async enqueueDiscovery(id: string) { this.discoveries.push(id); }
  async enqueueCredentialRevoke() {}
  async enqueueDisconnect() {}
  async enqueueWebhookSync() {}
  async enqueueTerminate() {}
  async enqueueToolCall() {}
  async close() {}
}

const repository = new FakeOAuthRepository();
const queue = new FakeOAuthQueue();
const service = new IntegrationControlPlaneService(repository as never, queue, key, "https://crm.example.test", "https://app.example.test/integrations");
const connection = await service.createConnection(adminA, { connectorId: connector.id, scope: "team", displayName: "Team OAuth" });
assert.equal(connection.status, "authorizing");
assert.deepEqual(queue.discoveries, []);

const started = await service.startAuthorization(adminA, connection.id);
assert.equal(started.status, "created");
assert.equal(queue.prepared.length, 1);
const transaction = repository.transactions[0]!;
const initialContext = decryptIntegrationValue<{ state: string; nonce: string }>(transaction.encryptedContext, key, {
  teamId: transaction.teamId, ownerId: transaction.ownerId, connectionId: transaction.connectionId, artifactType: "oauth_transaction"
});
assert.equal(Buffer.from(initialContext.state, "base64url").length, 32);
assert.equal(Buffer.from(initialContext.nonce, "base64url").length, 32);
assert.equal(transaction.encryptedContext.includes(initialContext.state), false);
await assert.rejects(() => service.authTransaction(adminB, transaction.id), /无权访问|不存在/u);

transaction.status = "authorize_url_ready";
transaction.issuer = "https://auth.example.test";
const callback = await service.receiveOAuthCallback(connector.code, { state: initialContext.state, code: "authorization-code-sensitive", iss: transaction.issuer });
assert.equal(callback.transactionId, transaction.id);
assert.deepEqual(queue.completed, [transaction.id]);
assert.equal(transaction.encryptedContext.includes("authorization-code-sensitive"), false);
await assert.rejects(() => service.receiveOAuthCallback(connector.code, { state: initialContext.state, code: "replay" }), /already consumed|已处理|状态/u);

transaction.status = "completed";
connection.status = "pending_confirmation";
await service.confirmAuthorization(adminA, connection.id, transaction.id);
assert.equal(transaction.status, "consumed");
assert.equal(connection.status, "discovering");
assert.deepEqual(queue.discoveries, [connection.id]);

console.log(JSON.stringify({
  ok: true,
  oauthConnectionWaitsForAuthorization: true,
  stateAndNonce256Bit: true,
  stateStoredAsHashAndEncryptedContext: true,
  callbackSingleUse: true,
  authorizationCodeNotPlaintext: true,
  crossTeamTransactionHidden: true,
  explicitAccountConfirmation: true
}, null, 2));
