import assert from "node:assert/strict";
import { decryptValue, encryptValue } from "../src/credential-vault.js";
import { IntegrationExecutionService } from "../src/integration-execution.js";
import { McpSessionManager } from "../src/mcp/mcp-session-manager.js";
import { canonicalJson, sha256, type DiscoveredToolSnapshot } from "../src/mcp/tool-schema.js";
import type {
  ClaimedToolCall,
  IntegrationWorkerRepository,
  WorkerConnectionContext
} from "../src/repository.js";
import { startFakeMcpServer } from "./fake-mcp-server.js";
import { sanitizeToolResult } from "../src/result-sanitizer.js";
import { ConnectorDriverRegistry } from "../src/drivers/connector-driver-registry.js";
import { NativeMcpConnectorDriver } from "../src/drivers/native-mcp-connector-driver.js";

const fake = await startFakeMcpServer();
const endpoint = new URL(fake.endpoint);
const credentialKey = "stage-1-worker-test-key";
const input = { query: "Example Lighting", country: "US" };

class FakeWorkerRepository {
  context: WorkerConnectionContext = {
    connectionId: "ic_test",
    connectorId: "connector_test",
    teamId: "team_a",
    ownerId: "admin_a",
    status: "discovering",
    manifest: {
      endpoint: fake.endpoint,
      approvedHosts: ["127.0.0.1"],
      allowedPorts: [Number(endpoint.port)],
      allowInsecureLoopback: true
    }
  };
  discoveredTools: DiscoveredToolSnapshot[] = [];
  claimed: ClaimedToolCall | null = null;
  completed: Parameters<IntegrationWorkerRepository["completeCallSuccess"]>[0] | null = null;
  failed: Array<{ callId: string; message: string }> = [];
  discoveryModes: Array<"initial" | "refresh"> = [];
  healthSuccesses: Array<{ connectionId: string; latencyMs: number }> = [];
  healthFailures: Array<{ connectionId: string; message: string }> = [];

  async loadConnectionContext() { return this.context; }

  async applyDiscovery(
    _context: WorkerConnectionContext,
    discovery: { tools: DiscoveredToolSnapshot[] },
    mode: "initial" | "refresh"
  ) {
    this.discoveryModes.push(mode);
    this.discoveredTools = discovery.tools;
    if (mode === "initial") this.context.status = "pending_review";
    return { created: discovery.tools.length, quarantined: mode === "refresh" ? 1 : 0, total: discovery.tools.length };
  }

  async markDiscoveryFailed() {}

  async listHealthCheckConnectionIds() { return [this.context.connectionId]; }

  async recordHealthSuccess(connectionId: string, latencyMs: number) {
    this.healthSuccesses.push({ connectionId, latencyMs });
    return { connectionId, status: "active", consecutiveSuccesses: 2 };
  }

  async recordHealthFailure(connectionId: string, error: unknown) {
    this.healthFailures.push({ connectionId, message: error instanceof Error ? error.message : String(error) });
    return { connectionId, status: "degraded", consecutiveFailures: 1, circuitState: "closed" };
  }

  async claimCall(callId: string) {
    assert.equal(this.claimed?.callId, callId);
    if (!this.claimed) throw new Error("missing claimed call");
    return this.claimed;
  }

  async getCallInputHash() { return sha256(canonicalJson(input)); }

  async completeCallSuccess(value: Parameters<IntegrationWorkerRepository["completeCallSuccess"]>[0]) {
    this.completed = value;
  }

  async completeCallFailure(call: ClaimedToolCall, error: unknown) {
    this.failed.push({ callId: call.callId, message: error instanceof Error ? error.message : String(error) });
  }
  async completeCallUnknownOutcome(call: ClaimedToolCall, error: unknown) {
    this.failed.push({ callId: call.callId, message: error instanceof Error ? error.message : String(error) });
  }
}

const repository = new FakeWorkerRepository();
const sessions = new McpSessionManager();
const drivers = new ConnectorDriverRegistry([new NativeMcpConnectorDriver(sessions)]);
const service = new IntegrationExecutionService(
  repository as unknown as IntegrationWorkerRepository,
  drivers,
  credentialKey,
  5_000,
  64 * 1024,
  7
);

try {
  const discovery = await service.discover(repository.context.connectionId, "initial");
  assert.equal(discovery.total, 2);
  assert.equal(repository.context.status, "pending_review");
  const tool = repository.discoveredTools.find((candidate) => candidate.remoteName === "company.lookup");
  assert.ok(tool);

  repository.context.status = "active";
  assert.deepEqual(await service.healthCheckConnectionIds(), [repository.context.connectionId]);
  const health = await service.healthCheck(repository.context.connectionId);
  assert.equal(health.status, "active");
  assert.equal(repository.healthSuccesses.length, 1);
  assert.equal(repository.healthFailures.length, 0);
  repository.claimed = {
    ...repository.context,
    callId: "itc_success",
    requestId: "req_success",
    actorId: "sales_a",
    actorRole: "sales",
    actorAuthVersion: 1,
    riskLevel: 1,
    toolSnapshotId: "its_lookup",
    remoteName: tool.remoteName,
    schemaHash: tool.schemaHash,
    inputArtifactId: "iar_input",
    createdAt: "2026-08-07T00:00:00.000Z",
    encryptedInput: encryptValue(input, credentialKey, {
      teamId: repository.context.teamId,
      ownerId: repository.context.ownerId,
      connectionId: repository.context.connectionId,
      artifactType: "tool_input"
    }),
    reviewJson: JSON.stringify({ completionEvidence: ["source", "observedAt"] })
  };

  const result = await service.executeReadCall(repository.claimed.callId);
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.source, "fake-mcp://company.lookup");
  assert.equal(result.evidence.observedAt, "2026-08-07T00:00:00.000Z");
  assert.ok(repository.completed);
  const decrypted = decryptValue<Record<string, unknown>>(
    repository.completed.artifact.encryptedValue,
    credentialKey,
    {
      teamId: repository.context.teamId,
      ownerId: repository.context.ownerId,
      connectionId: repository.context.connectionId,
      artifactType: "tool_result"
    }
  );
  assert.equal((decrypted.structuredContent as Record<string, unknown>).company, "Example Lighting");
  assert.equal(repository.completed.outputBytes, Buffer.byteLength(canonicalJson(decrypted), "utf8"));

  repository.claimed = {
    ...repository.claimed,
    callId: "itc_schema_changed",
    requestId: "req_schema_changed",
    schemaHash: "obsolete-schema-hash"
  };
  await assert.rejects(
    () => service.executeReadCall(repository.claimed!.callId),
    /INTEGRATION_TOOL_SCHEMA_CHANGED/u
  );
  assert.deepEqual(repository.discoveryModes, ["initial", "refresh", "refresh"]);
  assert.match(repository.failed.at(-1)?.message || "", /INTEGRATION_TOOL_SCHEMA_CHANGED/u);
} finally {
  await sessions.close();
  await fake.close();
}

const writeResult = sanitizeToolResult({
  content: [{ type: "text", text: "sent" }],
  structuredContent: { externalReceiptId: "receipt-001", acceptedRecipients: ["buyer@example.test"] }
}, { riskLevel: 4, completionEvidence: ["external_receipt_id", "delivery_acceptance"] });
assert.equal(writeResult.evidence.type, "write_completion");
assert.equal(writeResult.externalReceipt, "receipt-001");
assert.throws(() => sanitizeToolResult({
  content: [{ type: "text", text: "ambiguous" }],
  structuredContent: { status: "ok" }
}, { riskLevel: 4, completionEvidence: ["external_receipt_id"] }), /INTEGRATION_COMPLETION_EVIDENCE_MISSING/u);

console.log(JSON.stringify({
  ok: true,
  realMcpDiscovery: true,
  encryptedInputAndResult: true,
  customerDataFreeHealthCheck: true,
  evidenceRequired: true,
  schemaMismatchQuarantined: true,
  writeCompletionEvidenceRequired: true
}, null, 2));
