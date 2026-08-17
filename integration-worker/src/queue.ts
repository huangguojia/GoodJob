import { Queue, Worker, type Job } from "bullmq";
import { IntegrationExecutionService } from "./integration-execution.js";
import { redisConnectionOptions, type IntegrationWorkerConfig } from "./runtime-config.js";

export interface IntegrationQueueWorkers {
  control: Worker;
  toolCalls: Worker;
  events: Worker;
  refreshProducer: Queue;
  refreshTimer: NodeJS.Timeout;
}

export async function startIntegrationQueueWorkers(
  config: IntegrationWorkerConfig,
  service: IntegrationExecutionService
): Promise<IntegrationQueueWorkers> {
  const connection = redisConnectionOptions(config.redisUrl);
  const refreshProducer = new Queue(config.controlQueueName, { connection });
  const control = new Worker(
    config.controlQueueName,
    async (job: Job<{
      kind: "discover" | "terminate" | "oauth-prepare" | "oauth-complete" | "credential-refresh" | "credential-revoke" | "webhook-sync" | "disconnect" | "health-check";
      connectionId?: string;
      transactionId?: string;
      credentialId?: string;
      mode?: "initial" | "refresh";
    }>) => {
      if (job.data.kind === "oauth-prepare") return service.prepareAuthorization(String(job.data.transactionId || ""));
      if (job.data.kind === "oauth-complete") return service.completeAuthorization(String(job.data.transactionId || ""));
      if (job.data.kind === "credential-refresh") return service.refreshCredential(String(job.data.credentialId || ""));
      if (job.data.kind === "credential-revoke") return service.revokeCredential(String(job.data.connectionId || ""));
      if (job.data.kind === "webhook-sync") return service.syncWebhookSubscription(String(job.data.connectionId || ""));
      if (job.data.kind === "health-check") return service.healthCheck(String(job.data.connectionId || ""));
      if (job.data.kind === "disconnect") return service.disconnectConnection(String(job.data.connectionId || ""));
      if (job.data.kind === "terminate") return service.terminateConnection(String(job.data.connectionId || ""));
      return service.discover(String(job.data.connectionId || ""), job.data.mode || "refresh");
    },
    { connection, concurrency: Math.min(config.globalConcurrency, 4) }
  );
  const toolCalls = new Worker(
    config.queueName,
    async (job: Job<{ callId: string }>) => service.executeReadCall(job.data.callId),
    { connection, concurrency: config.globalConcurrency }
  );
  const events = new Worker(
    config.eventQueueName,
    async (job: Job<{ eventId: string }>) => service.processWebhookEvent(
      job.data.eventId,
      job.attemptsMade + 1 >= Number(job.opts.attempts || 1)
    ),
    { connection, concurrency: Math.min(config.globalConcurrency, 4) }
  );
  await Promise.all([control.waitUntilReady(), toolCalls.waitUntilReady(), events.waitUntilReady(), refreshProducer.waitUntilReady()]);
  const enqueueRefreshes = async () => {
    const ids = await service.expiringCredentialIds();
    const webhookConnectionIds = await service.subscriptionSyncConnectionIds();
    const healthConnectionIds = await service.healthCheckConnectionIds();
    const bucket = Math.floor(Date.now() / 300_000);
    const healthBucket = Math.floor(Date.now() / 900_000);
    await Promise.all([
      ...ids.map((credentialId) => refreshProducer.add(
      "credential-refresh",
      { kind: "credential-refresh", credentialId },
      { jobId: `credential-refresh-${credentialId}-${bucket}`, removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential", delay: 5_000 } }
      )),
      ...webhookConnectionIds.map((connectionId) => refreshProducer.add(
        "webhook-sync",
        { kind: "webhook-sync", connectionId },
      { jobId: `webhook-sync-${connectionId}-${bucket}`, removeOnComplete: 100, removeOnFail: 500, attempts: 5, backoff: { type: "exponential", delay: 2_000 } }
      )),
      ...healthConnectionIds.map((connectionId) => refreshProducer.add(
        "health-check",
        { kind: "health-check", connectionId },
        { jobId: `health-check-${connectionId}-${healthBucket}`, removeOnComplete: 100, removeOnFail: 500, attempts: 1 }
      ))
    ]);
  };
  const refreshTimer = setInterval(() => void enqueueRefreshes().catch(() => undefined), 5 * 60_000);
  refreshTimer.unref();
  void enqueueRefreshes().catch(() => undefined);
  return { control, toolCalls, events, refreshProducer, refreshTimer };
}

export async function closeIntegrationQueueWorkers(workers: IntegrationQueueWorkers) {
  clearInterval(workers.refreshTimer);
  await Promise.allSettled([workers.control.close(), workers.toolCalls.close(), workers.events.close(), workers.refreshProducer.close()]);
}
