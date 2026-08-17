import assert from "node:assert/strict";
import { decryptValue, encryptValue } from "../src/credential-vault.js";
import { ConnectorDriverRegistry } from "../src/drivers/connector-driver-registry.js";
import { IntegrationExecutionService } from "../src/integration-execution.js";
import { sha256 } from "../src/mcp/tool-schema.js";

const credentialKey = "integration-webhook-worker-key-at-least-32-characters";
const context = {
  eventId: "iev_test_001",
  connectionId: "icx_test_001",
  connectorCode: "microsoft-365",
  teamId: "team_test",
  ownerId: "owner_test",
  eventType: "microsoft.message.created",
  externalEventId: "event_test_001",
  artifactId: "iar_test_001",
  attemptCount: 1,
  leaseId: "iwl_test_001"
};
const rawBody = JSON.stringify({ value: [{ resourceData: { id: "message_001" } }] });

class FakeWebhookRepository {
  payloadHash = sha256(rawBody);
  encryptedPayload = encryptValue({
    rawBody,
    notification: { resourceData: { id: "message_001" }, bodyPreview: "sensitive body" }
  }, credentialKey, { ...context, artifactType: "webhook_raw" });
  completed: Record<string, unknown> | null = null;
  completedOutput: Record<string, unknown> | undefined;
  failed: { deadLetter: boolean; error: string } | null = null;

  async claimWebhookEvent() {
    return { ...context, payloadHash: this.payloadHash, encryptedPayload: this.encryptedPayload };
  }
  async completeWebhookEvent(_eventId: string, _leaseId: string, result: Record<string, unknown>, output?: Record<string, unknown>) {
    this.completed = result;
    this.completedOutput = output;
  }
  async failWebhookEvent(_eventId: string, _leaseId: string, cause: unknown, deadLetter: boolean) {
    this.failed = { deadLetter, error: cause instanceof Error ? cause.message : String(cause) };
  }
  async loadConnectionContext() {
    return {
      connectionId: context.connectionId,
      connectorId: "icn_microsoft",
      connectorCode: "microsoft-365",
      teamId: context.teamId,
      ownerId: context.ownerId,
      status: "active",
      webhookPublicId: "iwp_test",
      manifest: {
        driver: "microsoft_graph" as const,
        endpoint: "https://graph.microsoft.com/v1.0/",
        approvedHosts: ["graph.microsoft.com"],
        allowedPorts: [443],
        authentication: "none" as const
      }
    };
  }
}

const repository = new FakeWebhookRepository();
const fakeMicrosoftDriver = {
  type: "microsoft_graph",
  validateConfiguration() {},
  async prepareAuthorization() { throw new Error("not used"); },
  async completeAuthorization() { throw new Error("not used"); },
  async refreshCredential() { throw new Error("not used"); },
  async revokeCredential() { return { remoteRevocationSupported: false }; },
  async discoverTools() { throw new Error("not used"); },
  async healthCheck() { return { ok: true as const, latencyMs: 1, checkedAt: "2026-08-07T00:00:00.000Z" }; },
  async invokeTool() {
    return {
      content: [{ type: "text" as const, text: "message" }],
      structuredContent: {
        message: {
          id: "message_001",
          subject: "Sensitive quotation request",
          sender: { emailAddress: { address: "buyer@example.test" } },
          body: { contentType: "text", content: "sensitive body" }
        },
        source: "microsoft-graph://me/messages/message_001",
        observedAt: "2026-08-07T03:00:00.000Z"
      }
    };
  },
  async closeConnection() {}
};
const service = new IntegrationExecutionService(
  repository as never,
  new ConnectorDriverRegistry([fakeMicrosoftDriver as never]),
  credentialKey,
  15_000,
  2_097_152,
  7
);

const completed = await service.processWebhookEvent(context.eventId);
assert.equal(completed.status, "processed");
assert.equal(repository.completed?.normalized, true);
assert.equal(JSON.stringify(repository.completed).includes("sensitive body"), false);
assert.equal(repository.completedOutput?.writebackStatus, "pending");
const resultArtifact = repository.completedOutput?.artifact as { encryptedValue: string };
const decrypted = decryptValue<{ message: { body: { content: string } } }>(resultArtifact.encryptedValue, credentialKey, {
  ...context,
  artifactType: "webhook_result"
});
assert.equal(decrypted.message.body.content, "sensitive body");

repository.completed = null;
repository.payloadHash = sha256(`${rawBody}tampered`);
const deadLetter = await service.processWebhookEvent(context.eventId, true);
assert.equal(deadLetter.status, "dead_letter");
assert.equal(repository.failed?.deadLetter, true);
assert.match(repository.failed?.error || "", /完整性/u);

class FakeSubscriptionRepository {
  failure: { connectionId: string; teamId: string; provider: string; resource: string; cause: unknown } | null = null;
  async withWebhookSubscriptionLease(_connectionId: string, work: () => Promise<unknown>) {
    return { acquired: true, value: await work() };
  }
  async loadConnectionContext() {
    return {
      connectionId: context.connectionId,
      connectorId: "icn_microsoft",
      connectorCode: "microsoft-365",
      teamId: context.teamId,
      ownerId: context.ownerId,
      status: "active",
      webhookPublicId: "iwp_test_001",
      manifest: {
        driver: "microsoft_graph" as const,
        endpoint: "https://graph.microsoft.com/v1.0/",
        approvedHosts: ["graph.microsoft.com"],
        allowedPorts: [443],
        authentication: "none" as const
      }
    };
  }
  async loadWebhookSubscription() { return null; }
  async recordWebhookSubscriptionFailure(input: FakeSubscriptionRepository["failure"]) { this.failure = input; }
}

const subscriptionRepository = new FakeSubscriptionRepository();
const failingSubscriptionDriver = {
  ...fakeMicrosoftDriver,
  async registerWebhook() { throw new Error("INTEGRATION_REMOTE_UNAVAILABLE: Graph subscription rejected"); },
  async renewWebhook() { throw new Error("not used"); }
};
const subscriptionService = new IntegrationExecutionService(
  subscriptionRepository as never,
  new ConnectorDriverRegistry([failingSubscriptionDriver as never]),
  credentialKey,
  15_000,
  2_097_152,
  7,
  "https://crm.example.test"
);
await assert.rejects(() => subscriptionService.syncWebhookSubscription(context.connectionId), /Graph subscription rejected/u);
assert.equal(subscriptionRepository.failure?.connectionId, context.connectionId);
assert.equal(subscriptionRepository.failure?.teamId, context.teamId);
assert.equal(subscriptionRepository.failure?.provider, "microsoft_graph");
assert.equal(subscriptionRepository.failure?.resource, "me/mailFolders('Inbox')/messages");

console.log(JSON.stringify({
  ok: true,
  encryptedPayloadVerified: true,
  processedState: true,
  microsoftMessageFetchedAndEncrypted: true,
  sensitiveBodyExcludedFromSummary: true,
  tamperedPayloadDeadLettered: true,
  initialSubscriptionFailureRecorded: true
}, null, 2));
