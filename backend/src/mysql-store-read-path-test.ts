/**
 * 读路径回归：重载（readBarrier）不许做多余的事。
 *
 * 1) 只读校验视图不能整库深拷贝 —— reloadProspectRuns 每次都要校验新读出来的
 *    探索执行状态，validateProspectRunPersistence 只读不写，一层浅拷贝就够。
 *    历史上这里用 persistenceSnapshot(store)，把每个业务数组 structuredClone
 *    一遍（生产上曾占 CPU 热点 40%）。
 *
 * 2) 轮询接口可以声明「这么新的数据就够用」 —— 进度/候选列表每被轮询一次，
 *    readBarrier 就要重读 30 张表；给了窗口后，窗口内的重复轮询直接复用上一次
 *    的结果。写路径与调度路径不传窗口，行为不变（每次都读）。
 */
import assert from "node:assert/strict";
import { createReloadGuard, validationView } from "./mysql-store.js";
import type { CrmStore } from "./store.js";

// ── 1. 校验视图不深拷贝 ───────────────────────────────────────────
{
  const campaigns = [{ id: "pc_1", teamId: "team_1" }];
  const runs = [{ id: "pr_1", teamId: "team_1" }];
  let persistCalls = 0;

  const store = {
    prospectCampaigns: campaigns,
    prospectSearchRuns: runs,
    persist: async () => {
      persistCalls += 1;
    }
  } as unknown as CrmStore;

  const view = validationView(store);

  assert.notEqual(view, store, "校验视图不能就是真实 store 本身");
  assert.equal(
    view.prospectCampaigns,
    campaigns,
    "校验视图不允许深拷贝业务数组（必须是同一个引用）"
  );
  assert.equal(
    view.prospectSearchRuns,
    runs,
    "校验视图不允许深拷贝业务数组（必须是同一个引用）"
  );
  assert.equal(
    view.prospectCampaigns[0],
    campaigns[0],
    "校验视图连元素都不应该被复制"
  );

  const reloaded = [{ id: "pr_2", teamId: "team_1" }];
  view.prospectSearchRuns = reloaded as never;
  assert.equal(store.prospectSearchRuns, runs, "视图上的替换不能影响真实 store");
  assert.equal(view.prospectSearchRuns, reloaded);

  await view.persist();
  assert.equal(persistCalls, 0, "校验视图的 persist 必须是 no-op");

  // 反证：真深拷贝出来的引用必然不同，确保上面的引用断言有意义
  assert.notEqual(structuredClone(campaigns), campaigns);
}

// ── 2. 重载守卫 ───────────────────────────────────────────────────
{
  let reloads = 0;
  let clock = 1_000_000;
  const guard = createReloadGuard(async () => {
    reloads += 1;
  }, () => clock);

  // 不传窗口 → 每次都读（写路径/调度路径的既有行为，不能被改掉）
  await guard();
  await guard();
  assert.equal(reloads, 2, "不传窗口时必须每次都重读");

  // 给了窗口 → 窗口内复用，窗口外重读
  clock += 2_000;
  await guard(1_000);
  assert.equal(reloads, 3, "超出窗口后必须真读一次");
  clock += 400;
  await guard(1_000);
  assert.equal(reloads, 3, "窗口内的重复轮询必须复用上一次结果（不再读表）");
  clock += 700;
  await guard(1_000);
  assert.equal(reloads, 4, "超出窗口后必须重新读表");

  // 失败不刷新时间戳：失败后必须允许下一次立刻重试
  let failures = 0;
  let failNext = true;
  let flakyReloads = 0;
  const flaky = createReloadGuard(async () => {
    flakyReloads += 1;
    if (failNext) {
      failNext = false;
      failures += 1;
      throw new Error("boom");
    }
  }, () => clock);
  await assert.rejects(() => flaky(1_000), /boom/);
  assert.equal(failures, 1);
  await flaky(1_000);
  assert.equal(flakyReloads, 2, "上次失败不能被当成「刚读过」，必须重试");
}

console.log("mysql store read path tests passed");
