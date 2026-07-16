import assert from "node:assert/strict";
import { validateProspectRedisUrl } from "./prospect-bullmq-backend.js";
import {
  ProspectQueueCoordinator,
  type ProspectQueueBackend,
  type ProspectQueueEnqueueOptions,
  type ProspectQueueSignal,
  type ProspectQueueSignalKind
} from "./prospect-queue-coordinator.js";
import type { CrmStore } from "./store.js";

interface EnqueuedSignal {
  kind: ProspectQueueSignalKind;
  signal: ProspectQueueSignal;
  options: ProspectQueueEnqueueOptions;
}

class FakeQueueBackend implements ProspectQueueBackend {
  readonly mode = "fake_bullmq";
  readonly enqueued: EnqueuedSignal[] = [];
  failAgentJobId = "";
  private handler: ((
    signal: ProspectQueueSignal,
    kind: ProspectQueueSignalKind
  ) => Promise<void>) | null = null;

  async start(
    handler: (
      signal: ProspectQueueSignal,
      kind: ProspectQueueSignalKind
    ) => Promise<void>
  ) {
    this.handler = handler;
  }

  async enqueue(
    kind: ProspectQueueSignalKind,
    signal: ProspectQueueSignal,
    options: ProspectQueueEnqueueOptions
  ) {
    if (signal.agentJobId === this.failAgentJobId) {
      const error = new Error("queue unavailable");
      Object.assign(error, { code: "TEST_QUEUE_UNAVAILABLE" });
      throw error;
    }
    this.enqueued.push({
      kind,
      signal: { ...signal },
      options: { ...options }
    });
  }

  async emit(
    signal: ProspectQueueSignal,
    kind: ProspectQueueSignalKind = "execution"
  ) {
    await this.handler?.(signal, kind);
  }

  async stop() {
    this.handler = null;
  }
}

const now = "2026-07-15T00:00:00.000Z";
const delayedAt = "2026-07-15T00:01:00.000Z";
const teamId = "queue_team_a";
const ownerId = "queue_owner_a";

const store = {
  prospectSearchRuns: [
    {
      id: "run_ready",
      teamId,
      ownerId,
      status: "queued"
    },
    {
      id: "run_delayed",
      teamId,
      ownerId,
      status: "running"
    },
    {
      id: "run_dead",
      teamId,
      ownerId,
      status: "failed"
    }
  ],
  prospectRunShards: [
    {
      id: "shard_ready",
      teamId,
      runId: "run_ready",
      status: "queued"
    },
    {
      id: "shard_delayed",
      teamId,
      runId: "run_delayed",
      status: "retry_scheduled"
    },
    {
      id: "shard_dead",
      teamId,
      runId: "run_dead",
      status: "failed"
    }
  ],
  agentJobs: [
    {
      id: "job_ready",
      teamId,
      ownerId,
      status: "queued",
      attemptCount: 0,
      nextAttemptAt: "",
      finishedAt: "",
      createdAt: now
    },
    {
      id: "job_delayed",
      teamId,
      ownerId,
      status: "retry_scheduled",
      attemptCount: 2,
      nextAttemptAt: delayedAt,
      finishedAt: "",
      createdAt: now
    },
    {
      id: "job_dead",
      teamId,
      ownerId,
      status: "dead_letter",
      attemptCount: 5,
      nextAttemptAt: "",
      finishedAt: delayedAt,
      createdAt: now
    }
  ],
  prospectRunQueueChildBindings: [
    {
      teamId,
      ownerId,
      runId: "run_ready",
      shardId: "shard_ready",
      jobId: "job_ready"
    },
    {
      teamId,
      ownerId,
      runId: "run_delayed",
      shardId: "shard_delayed",
      jobId: "job_delayed"
    },
    {
      teamId,
      ownerId,
      runId: "run_dead",
      shardId: "shard_dead",
      jobId: "job_dead"
    }
  ],
  async readBarrier() {
    // The fake store has no persistence queue.
  }
} as unknown as CrmStore;

const backend = new FakeQueueBackend();
const woken: string[] = [];
const coordinator = new ProspectQueueCoordinator({
  store,
  backend,
  now: () => new Date(now),
  syncIntervalMs: 60_000,
  onWake(agentJobId) {
    woken.push(agentJobId);
  }
});

await coordinator.start();

assert.equal(backend.enqueued.length, 3);
const ready = backend.enqueued.find((item) =>
  item.signal.agentJobId === "job_ready"
);
const delayed = backend.enqueued.find((item) =>
  item.signal.agentJobId === "job_delayed"
);
const dead = backend.enqueued.find((item) =>
  item.signal.agentJobId === "job_dead"
);
assert.ok(ready);
assert.ok(delayed);
assert.ok(dead);
assert.equal(ready.kind, "execution");
assert.equal(ready.options.delayMs, 0);
assert.equal(delayed.kind, "execution");
assert.equal(delayed.options.delayMs, 60_000);
assert.equal(dead.kind, "dead_letter");
assert.equal(dead.options.delayMs, 0);

for (const item of backend.enqueued) {
  assert.deepEqual(Object.keys(item.signal), ["agentJobId"]);
  assert.ok(!JSON.stringify(item).includes(teamId));
  assert.ok(!JSON.stringify(item).includes(ownerId));
}

const firstSignalIds = backend.enqueued.map((item) =>
  item.options.signalId
);
await coordinator.synchronize();
assert.deepEqual(
  backend.enqueued.slice(3).map((item) => item.options.signalId),
  firstSignalIds
);

await backend.emit({ agentJobId: "unknown_job" });
await backend.emit({ agentJobId: "job_dead" });
assert.deepEqual(woken, []);
await backend.emit({ agentJobId: "job_ready" });
assert.deepEqual(woken, ["job_ready"]);

store.agentJobs.find((item) => item.id === "job_ready")!.status =
  "succeeded";
await backend.emit({ agentJobId: "job_ready" });
assert.deepEqual(woken, ["job_ready"]);

backend.failAgentJobId = "job_delayed";
await coordinator.synchronize();
assert.equal(coordinator.status().degraded, true);
assert.equal(
  coordinator.status().lastErrorCode,
  "TEST_QUEUE_UNAVAILABLE"
);
backend.failAgentJobId = "";
await coordinator.synchronize();
assert.equal(coordinator.status().degraded, false);
assert.equal(coordinator.status().lastErrorCode, "");

assert.equal(
  validateProspectRedisUrl("redis://127.0.0.1:6379/0"),
  "redis://127.0.0.1:6379/0"
);
assert.equal(
  validateProspectRedisUrl("rediss://user:password@example.test:6380/2"),
  "rediss://user:password@example.test:6380/2"
);
assert.throws(
  () => validateProspectRedisUrl("https://example.test"),
  /redis/
);
assert.throws(
  () => validateProspectRedisUrl("redis://127.0.0.1/1/2"),
  /REDIS_URL/
);

await coordinator.stop();

console.log("Prospect queue coordination tests passed");
