import assert from "node:assert/strict";
import { IntegrationControlPlaneService } from "./integration-service.js";
import { decryptIntegrationValue } from "./integration-credential-vault.js";
import type { ConnectorDefinition, IntegrationConnection } from "./integration-types.js";
import type { DataScope } from "../authorization.js";
import type { SessionUser } from "../types.js";

const now = "2026-08-07T00:00:00.000Z";
const encryptionKey = "api-token-service-test-key-at-least-32-characters";
const adminA: SessionUser = { id: "admin_a", teamId: "team_a", role: "admin", name: "A", email: "a@example.test", avatar: "A", authVersion: 1 };
const adminB: SessionUser = { id: "admin_b", teamId: "team_b", role: "admin", name: "B", email: "b@example.test", avatar: "B", authVersion: 1 };
const connector: ConnectorDefinition = {
  id: "icn_system_easypost", code: "international-logistics", version: "1.0.0", type: "official_api",
  trust: "system", status: "active", teamId: "", name: "EasyPost 国际物流", description: "test",
  manifestHash: "manifest-hash", createdBy: "system", createdAt: now, updatedAt: now,
  manifestJson: JSON.stringify({
    schemaVersion: "1.0", stage: "available", driver: "easypost", endpoint: "https://api.easypost.com/v2/",
    approvedHosts: ["api.easypost.com"], allowedPorts: [443], authentication: "api_token",
    credentialFields: [{ key: "apiKey", label: "EasyPost API Key", secret: true, minLength: 8, maxLength: 500 }], maxTools: 3
  })
};

function visible(connection: IntegrationConnection, scope: DataScope) {
  return scope.type === "platform" || (connection.teamId === scope.teamId
    && (scope.type === "team" || connection.scope === "team" || connection.ownerId === scope.ownerId));
}

class FakeRepository {
  connections: IntegrationConnection[] = [];
  credentials: Array<{ connectionId: string; teamId: string; encryptedValue: string; fingerprint: string }> = [];
  async listCatalog() { return [connector]; }
  async getConnector(id: string) { return id === connector.id ? connector : null; }
  async createConnection(input: Omit<IntegrationConnection, "revision" | "lastHealthAt" | "lastErrorCode" | "lastErrorMessage" | "serverInfoJson" | "warningMessage" | "createdAt" | "updatedAt" | "disconnectedAt">) {
    const connection: IntegrationConnection = {
      ...input, revision: 1, lastHealthAt: "", lastHealthLatencyMs: 0, lastErrorCode: "", lastErrorMessage: "",
      serverInfoJson: "{}", warningMessage: "", createdAt: now, updatedAt: now, disconnectedAt: ""
    };
    this.connections.push(connection);
    return connection;
  }
  async getConnection(id: string, scope: DataScope) {
    return this.connections.find((connection) => connection.id === id && visible(connection, scope)) || null;
  }
  async transitionConnection(id: string, scope: DataScope, expected: string, next: IntegrationConnection["status"]) {
    const connection = await this.getConnection(id, scope);
    if (!connection || connection.status !== expected) throw new Error("state conflict");
    connection.status = next;
    connection.revision += 1;
    return connection;
  }
  async saveApiCredential(input: { connectionId: string; teamId: string; encryptedValue: string; fingerprint: string }) {
    const connection = this.connections.find((item) => item.id === input.connectionId && item.teamId === input.teamId && item.status === "authorizing");
    if (!connection) throw new Error("credential scope conflict");
    const existing = this.credentials.find((item) => item.connectionId === input.connectionId);
    if (existing) Object.assign(existing, input); else this.credentials.push(input);
  }
}

class FakeQueue {
  discoveries: string[] = [];
  async enqueueDiscovery(id: string) { this.discoveries.push(id); }
}

const repository = new FakeRepository();
const queue = new FakeQueue();
const service = new IntegrationControlPlaneService(repository as never, queue as never, encryptionKey);

const connection = await service.createConnection(adminA, {
  connectorId: connector.id, scope: "team", displayName: "Team A EasyPost", credentials: { apiKey: "EZTK_team_a_secret" }
});
assert.equal(connection.teamId, "team_a");
assert.equal(connection.status, "discovering");
assert.equal(queue.discoveries.length, 1);
assert.equal(repository.credentials.length, 1);
assert.equal(repository.credentials[0]!.encryptedValue.includes("EZTK_team_a_secret"), false);
assert.deepEqual(decryptIntegrationValue(repository.credentials[0]!.encryptedValue, encryptionKey, {
  teamId: "team_a", ownerId: "admin_a", connectionId: connection.id, artifactType: "api_token"
}), { apiKey: "EZTK_team_a_secret" });
assert.throws(() => decryptIntegrationValue(repository.credentials[0]!.encryptedValue, encryptionKey, {
  teamId: "team_b", ownerId: "admin_b", connectionId: connection.id, artifactType: "api_token"
}), /authenticate|Unsupported state|unable/iu);

await assert.rejects(() => service.connection(adminB, connection.id), /不存在|无权/u);
await assert.rejects(() => service.createConnection(adminA, {
  connectorId: connector.id, scope: "team", displayName: "Invalid", credentials: { apiKey: "EZTK_valid_value", injected: "not-allowed" }
}), /未支持字段/u);

connection.status = "reauthorization_required";
await assert.rejects(() => service.replaceApiCredentials(adminB, connection.id, { apiKey: "EZTK_team_b_secret" }), /不存在|无权/u);
const refreshed = await service.replaceApiCredentials(adminA, connection.id, { apiKey: "EZTK_team_a_rotated" });
assert.equal(refreshed.status, "discovering");
assert.deepEqual(decryptIntegrationValue(repository.credentials[0]!.encryptedValue, encryptionKey, {
  teamId: "team_a", ownerId: "admin_a", connectionId: connection.id, artifactType: "api_token"
}), { apiKey: "EZTK_team_a_rotated" });

const catalog = await service.catalog(adminA);
assert.equal(JSON.stringify(catalog).includes("EZTK_team_a"), false);
assert.equal(catalog[0]?.manifest.credentialFields[0]?.key, "apiKey");
console.log("Integration API token encryption and team isolation tests passed");
