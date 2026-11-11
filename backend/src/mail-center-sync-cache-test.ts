// 邮件中心同步轮询的「邮箱列表缓存」回归：
// 空闲时 tick 不得反复读 sender_mailboxes；写路径 bump 编号后必须立刻重新读。
import assert from "node:assert/strict";
import {
  MailCenterSyncService,
  setMailCenterRepository,
  createMysqlMailCenterRepository
} from "./mail-center.js";
import { bumpMailboxSyncCache, getMailboxSyncEpoch } from "./sender-mailbox.js";

let listCalls = 0;
let executeCalls = 0;
const fakePool = {
  async query() {
    listCalls++;
    return [[]];
  },
  async execute() {
    executeCalls++;
    return [{ affectedRows: 1 }, undefined];
  }
} as unknown as import("mysql2/promise").Pool;

const repo = createMysqlMailCenterRepository(fakePool);
setMailCenterRepository(repo);
const service = new MailCenterSyncService(fakePool);

try {
  const before = getMailboxSyncEpoch();
  await service.tick();
  assert.equal(listCalls, 1, "首轮 tick 必须真读一次同步候选");

  await service.tick();
  await service.tick();
  assert.equal(listCalls, 1, "编号没变时 tick 必须走缓存，不得再读库");

  await repo.setSyncSettings("smb_x", false, 60);
  assert.equal(executeCalls, 1, "setSyncSettings 落库一次");
  assert.notEqual(getMailboxSyncEpoch(), before, "写路径必须 bump 失效编号");

  await service.tick();
  assert.equal(listCalls, 2, "bump 后下一个 tick 必须重新读库");

  await service.tick();
  assert.equal(listCalls, 2, "重新读完后继续走缓存");

  await repo.updateSyncState("smb_x", {
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: "ok",
    lastSyncError: "",
    lastSyncScanned: 0,
    lastSyncSaved: 0,
    syncCursor: {}
  });
  assert.notEqual(getMailboxSyncEpoch(), before, "updateSyncState 也要 bump");

  bumpMailboxSyncCache();
  await service.tick();
  assert.equal(listCalls, 3, "手动 bump 同样触发重读");

  console.log("mail-center 同步缓存回归：全部通过（listCalls 终值 =", listCalls, "，若没有缓存这里会是 6+）");
} finally {
  setMailCenterRepository(null);
}
