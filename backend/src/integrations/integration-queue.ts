import { Queue } from "bullmq";

export interface IntegrationQueueDispatcher {
  enqueueDiscovery(connectionId: string, mode: "initial" | "refresh"): Promise<void>;
  enqueueAuthorizationPrepare(transactionId: string): Promise<void>;
  enqueueAuthorizationComplete(transactionId: string): Promise<void>;
  enqueueCredentialRevoke(connectionId: string): Promise<void>;
  enqueueDisconnect(connectionId: string): Promise<void>;
  enqueueWebhookSync(connectionId: string): Promise<void>;
  enqueueTerminate(connectionId: string): Promise<void>;
  enqueueToolCall(callId: string): Promise<void>;
  enqueueWebhookEvent(eventId: string): Promise<void>;
  close(): Promise<void>;
}

function redisConnectionOptions(redisUrl: string) {
  const url = new URL(redisUrl);
  if (!new Set(["redis:", "rediss:"]).has(url.protocol)) throw new Error("REDIS_URL 格式无效");
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "rediss:" ? 6380 : 6379)),
    username: decodeURIComponent(url.username || "default"),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.slice(1) || 0),
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null as null
  };
}

export class BullMqIntegrationQueueDispatcher implements IntegrationQueueDispatcher {
  private readonly control: Queue;
  private readonly toolCalls: Queue;
  private readonly events: Queue;

  constructor(redisUrl: string) {
    const connection = redisConnectionOptions(redisUrl);
    this.control = new Queue("goodjob:integration:control", { connection });
    this.toolCalls = new Queue("goodjob:integration:tool-calls", { connection });
    this.events = new Queue("goodjob:integration:events", { connection });
  }

  async ready() {
    await Promise.all([this.control.waitUntilReady(), this.toolCalls.waitUntilReady(), this.events.waitUntilReady()]);
  }

  async enqueueDiscovery(connectionId: string, mode: "initial" | "refresh") {
    await this.control.add(
      "discover",
      { kind: "discover", connectionId, mode },
      { jobId: `discover-${connectionId}-${mode}`, removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential", delay: 1_000 } }
    );
  }

  async enqueueAuthorizationPrepare(transactionId: string) {
    await this.control.add(
      "oauth-prepare",
      { kind: "oauth-prepare", transactionId },
      { jobId: `oauth-prepare-${transactionId}`, removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential", delay: 1_000 } }
    );
  }

  async enqueueAuthorizationComplete(transactionId: string) {
    await this.control.add(
      "oauth-complete",
      { kind: "oauth-complete", transactionId },
      { jobId: `oauth-complete-${transactionId}`, removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential", delay: 1_000 } }
    );
  }

  async enqueueCredentialRevoke(connectionId: string) {
    await this.control.add(
      "credential-revoke",
      { kind: "credential-revoke", connectionId },
      { jobId: `credential-revoke-${connectionId}`, removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential", delay: 1_000 } }
    );
  }

  async enqueueDisconnect(connectionId: string) {
    await this.control.add(
      "disconnect",
      { kind: "disconnect", connectionId },
      { jobId: `disconnect-${connectionId}`, removeOnComplete: 100, removeOnFail: 500, attempts: 5, backoff: { type: "exponential", delay: 2_000 } }
    );
  }

  async enqueueWebhookSync(connectionId: string) {
    const bucket = Math.floor(Date.now() / 300_000);
    await this.control.add(
      "webhook-sync",
      { kind: "webhook-sync", connectionId },
      { jobId: `webhook-sync-${connectionId}-${bucket}`, removeOnComplete: 100, removeOnFail: 500, attempts: 5, backoff: { type: "exponential", delay: 2_000 } }
    );
  }

  async enqueueTerminate(connectionId: string) {
    await this.control.add(
      "terminate",
      { kind: "terminate", connectionId },
      { jobId: `terminate-${connectionId}`, removeOnComplete: 100, removeOnFail: 500, attempts: 3 }
    );
  }

  async enqueueToolCall(callId: string) {
    await this.toolCalls.add(
      "read-tool",
      { callId },
      { jobId: callId, removeOnComplete: 500, removeOnFail: 1_000, attempts: 1 }
    );
  }

  async enqueueWebhookEvent(eventId: string) {
    await this.events.add(
      "webhook-event",
      { eventId },
      { jobId: eventId, removeOnComplete: 500, removeOnFail: 1_000, attempts: 5, backoff: { type: "exponential", delay: 2_000 } }
    );
  }

  async close() {
    await Promise.allSettled([this.control.close(), this.toolCalls.close(), this.events.close()]);
  }
}
