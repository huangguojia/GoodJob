import assert from "node:assert/strict";
import { ProspectWorker } from "./prospect-worker.js";
import { getStore } from "./store.js";

// 空闲退避：没有可执行任务时轮询逐步放慢；wakeNow()（新建/变更运行时调用）立即恢复。
// 同时锁定「空转不写库」：没有过期租约、没有可领取任务时，两个内核入口都要在内存里短路。
const store = getStore();
let persistCalls = 0;
const originalPersist = store.persist.bind(store);
store.persist = async () => { persistCalls += 1; return originalPersist(); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const worker = new ProspectWorker({
  store,
  dispatcher: {} as never, // 空库没有可领取的任务，不会调用 dispatcher
  claimSecret: "prospect-worker-idle-backoff-test-secret-at-least-32",
  workerId: "worker-idle-backoff-test",
  pollMs: 100,
  idleMaxPollMs: 800,
  concurrency: 1
});

try {
  assert.equal(worker.idleDelayMs(), 100, "刚启动时按 pollMs 轮询");
  await worker.start();
  const startedAt = persistCalls;
  await sleep(3_000);
  const idlePersists = persistCalls - startedAt;
  // 空库空转必须一个持久化都不产生：recoverExpiredLeases / claimNext 都在内存短路。
  assert.equal(idlePersists, 0, `空闲时不应产生任何持久化，实际 ${idlePersists} 次`);
  assert.equal(worker.idleDelayMs(), 800, "持续空闲后退避到上限");

  worker.wakeNow();
  await sleep(80);
  assert.ok((worker as unknown as { idleStreak: number }).idleStreak <= 1,
    "唤醒后退避清零，重新从 pollMs 开始");
  assert.ok(worker.idleDelayMs() <= 200, "唤醒后从 pollMs 重新开始");
} finally {
  await worker.stop();
}

// 关闭退避：idleMaxPollMs 等于 pollMs 时行为与原来一致
const fixed = new ProspectWorker({
  store,
  dispatcher: {} as never,
  claimSecret: "prospect-worker-idle-backoff-test-secret-at-least-32",
  pollMs: 250,
  idleMaxPollMs: 250,
  concurrency: 1
});
assert.equal(fixed.idleDelayMs(), 250);

console.log(JSON.stringify({ ok: true, checked: "prospect-worker-idle-backoff" }, null, 2));
process.exit(0);
