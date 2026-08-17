import { Queue, QueueEvents } from "bullmq";
import {
  redisConnectionOptions,
  type IntegrationWorkerConfig
} from "./runtime-config.js";

export interface IntegrationWorkerDependencies {
  toolCallQueue: Queue;
  toolCallEvents: QueueEvents;
  eventQueue: Queue;
}

export async function connectIntegrationWorkerDependencies(
  config: IntegrationWorkerConfig
): Promise<IntegrationWorkerDependencies> {
  if (!config.enabled || !config.workerEnabled) {
    throw new Error("Integration Worker 未启用");
  }
  const connection = redisConnectionOptions(config.redisUrl);
  const toolCallQueue = new Queue(config.queueName, { connection });
  const toolCallEvents = new QueueEvents(config.queueName, { connection });
  const eventQueue = new Queue(config.eventQueueName, { connection });
  try {
    await Promise.all([
      toolCallQueue.waitUntilReady(),
      toolCallEvents.waitUntilReady(),
      eventQueue.waitUntilReady()
    ]);
    return { toolCallQueue, toolCallEvents, eventQueue };
  } catch (error) {
    await Promise.allSettled([
      toolCallQueue.close(),
      toolCallEvents.close(),
      eventQueue.close()
    ]);
    throw error;
  }
}

export async function closeIntegrationWorkerDependencies(
  dependencies: IntegrationWorkerDependencies
) {
  await Promise.allSettled([
    dependencies.toolCallQueue.close(),
    dependencies.toolCallEvents.close(),
    dependencies.eventQueue.close()
  ]);
}
