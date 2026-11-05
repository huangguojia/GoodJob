import assert from "node:assert/strict";
import { ProspectWorker } from "./prospect-worker.js";
import { getStore } from "./store.js";

// 空闲退避：没有可执行任务时轮询逐步放慢；wakeNow()（新建/变更运行时调用）立即恢复。
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
  const idleCycles = (persistCalls - startedAt) / 2; // 每个空转周期：recoverExpiredLeases + claimNext
  // 不退避时 3 秒约 30 个周期；退避（100→200→400→800 封顶）后约 5~6 个
  assert.ok(idleCycles >= 3 && idleCycles <= 9, `空闲 3 秒应只轮询少数几次，实际 ${idleCycles} 次`);
  assert.equal(worker.idleDelayMs(), 800, "持续空闲后退避到上限");

  const beforeWake = persistCalls;
  worker.wakeNow();
  await sleep(60);
  assert.ok(persistCalls - beforeWake >= 2, "wakeNow() 必须立即触发一次轮询，不等退避到期");
  assert.ok(worker.idleDelayMs() <= 200, "唤醒后退避清零，重新从 pollMs 开始");
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
