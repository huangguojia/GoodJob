import assert from "node:assert/strict";
import {
  BOUNCE_RATE_PAUSE_THRESHOLD,
  ProspectOutreachBatchRunner,
  approveProspectOutreachBatch,
  controlProspectOutreachBatch,
  createProspectOutreachBatch,
  getProspectOutreachBatch,
  nextWindowStart,
  prospectBatchStepTemplates,
  updateProspectOutreachBatchItem
} from "./prospect-outreach-batch.js";
import { memoryStore, type CrmStore } from "./store.js";
import type { ProspectOutreachBatch } from "./types.js";

function isolatedStore() {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.prospectOutreachBatches = [];
  store.persist = async () => undefined;
  return store;
}

function makeBatch(store: CrmStore, overrides: Partial<ProspectOutreachBatch> = {}): ProspectOutreachBatch {
  const now = new Date().toISOString();
  return {
    id: "pob_test_1",
    ownerId: "u_admin",
    teamId: "europe",
    status: "approved",
    policy: { dailyLimit: 5, stepIntervalHours: 1, sendWindowStartHour: 0, sendWindowEndHour: 24, stopOnReply: true },
    items: [],
    counts: { total: 0, frozen: 0, skipped: 0 },
    frozenPayload: { approvedAt: now, approvedBy: "u_admin", items: [] },
    frozenHash: "hash_test",
    approvedBy: "u_admin",
    approvedAt: now,
    pauseReason: "",
    nextSendAt: "",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

async function main() {
  const store = isolatedStore();
  const owner = store.users.find((item) => item.id === "u_admin" && item.status === "active")!;

  // ---- 纯函数：发送窗口 ----
  const policy = { dailyLimit: 20, stepIntervalHours: 72, sendWindowStartHour: 9, sendWindowEndHour: 11, stopOnReply: true };
  const at10 = new Date("2026-09-12T10:00:00");
  assert.equal(nextWindowStart(at10, policy).getTime(), at10.getTime(), "窗口内应立即可发");
  const at8 = new Date("2026-09-12T08:30:00");
  assert.equal(nextWindowStart(at8, policy).getHours(), 9, "窗口前应推迟到当天窗口起点");
  const at14 = new Date("2026-09-12T14:00:00");
  assert.equal(nextWindowStart(at14, policy).getDate(), at14.getDate() + 1, "窗口后应推迟到明天窗口起点");

  // ---- 纯函数：序列草稿 ≤3 步 ----
  const templates = prospectBatchStepTemplates({ company: "Acme GmbH", business: "fasteners", country: "Germany", contact: "", contactInfo: "" }, policy);
  assert.equal(templates.length, 3);
  assert.equal(templates[1]!.delayHours, 72);
  assert.equal(templates[2]!.delayHours, 144);
  assert.match(templates[0]!.body, /Acme GmbH/u);

  // ---- 创建批次：不存在/不合格候选进 skipped 且带原因 ----
  const candidateId = "web_auto_batch_test_candidate";
  store.websiteOpportunities.unshift({
    id: candidateId,
    company: "Acme GmbH",
    business: "fasteners",
    country: "Germany",
    website: "https://acme.example",
    contact: "",
    contactInfo: "",
    description: "",
    ownerId: owner.id,
    teamId: owner.teamId,
    status: "contactable",
    createdAt: new Date().toISOString()
  } as never);
  const batch = await createProspectOutreachBatch(store, owner, {
    candidateIds: [candidateId, "no_such_candidate"],
    policy: { dailyLimit: 7, sendWindowStartHour: 0, sendWindowEndHour: 24 }
  });
  assert.equal(batch.counts.total, 2);
  const missing = batch.items.find((item) => item.candidateId === "no_such_candidate")!;
  assert.equal(missing.status, "skipped");
  // 「找不到」要区分「已被删除」和「属于别人、你无权」，且不能把内部 ID 塞进 company 当公司名给界面
  assert.equal(missing.skipReason, "候选已被删除");
  assert.equal(missing.company, "");

  // ---- 线索批次：同团队但归别人 → 回填真实公司名 + 说清是"无权"而不是"不存在" ----
  const foreignLeadId = "lead_owned_by_teammate_test";
  store.leads.unshift({
    id: foreignLeadId,
    company: "Shirley Trading",
    contact: "Shirley",
    country: "Malaysia",
    email: "shirley@example.com",
    phone: "",
    wechat: "",
    source: "manual",
    intent: "",
    stage: "new",
    status: "new",
    ownerId: "u_sales_shirley",
    teamId: owner.teamId,
    estimatedAmount: 0,
    nextFollowAt: "",
    lastActivityAt: "",
    remark: "",
    convertedCustomerId: "",
    convertedDealId: "",
    sourceType: "manual"
  } as never);
  const leadBatch = await createProspectOutreachBatch(store, owner, {
    targetType: "lead",
    leadIds: [foreignLeadId, "lead_no_such_at_all"],
    policy: { dailyLimit: 5, sendWindowStartHour: 0, sendWindowEndHour: 24 }
  });
  const foreignItem = leadBatch.items.find((item) => item.leadId === foreignLeadId)!;
  assert.equal(foreignItem.status, "skipped");
  assert.equal(foreignItem.company, "Shirley Trading", "无权访问的线索仍要显示真实公司名，不能拿内部 ID 顶替");
  assert.match(foreignItem.skipReason, /无权/u);
  const deletedItem = leadBatch.items.find((item) => item.leadId === "lead_no_such_at_all")!;
  assert.equal(deletedItem.company, "", "线索真不存在时不能把 ID 当公司名");
  assert.equal(deletedItem.skipReason, "线索已被删除");
  // 被跳过的项以前既发不出去、也清理不掉（remove 只允许 ready），只能整批取消 —— 现在要能移出，且可再恢复
  const cleaned = await updateProspectOutreachBatchItem(store, owner, leadBatch.id, foreignItem.id, "remove");
  assert.equal(cleaned.item.status, "removed");
  const restored = await updateProspectOutreachBatchItem(store, owner, leadBatch.id, foreignItem.id, "restore");
  assert.equal(restored.item.status, "skipped", "移出后可恢复；恢复复核必须再校验归属，别人的线索恢复不了");
  // 越权防线：即使把"不属于自己的线索"硬塞成 ready，放行复核也必须把它剔除（曾经只按 id 查，会放行出去发信）
  foreignItem.status = "ready";
  foreignItem.recipient = "shirley@example.com";
  foreignItem.steps = [{ index: 0, delayHours: 0, subject: "s", body: "b", status: "pending", scheduledAt: new Date().toISOString(), sentAt: "", error: "" }];
  await assert.rejects(() => approveProspectOutreachBatch(store, owner, leadBatch.id), (error) => (error as { statusCode?: number }).statusCode === 409);
  assert.equal(foreignItem.status, "skipped", "放行复核必须把不属于当前账号的线索剔除");
  assert.equal(batch.policy.dailyLimit, 7, "policy 覆盖生效");

  // 该候选在内存库中没有人工批准记录 → 评估为 skipped（资格硬约束生效）
  const evaluated = batch.items.find((item) => item.candidateId === candidateId)!;
  assert.equal(evaluated.status, "skipped");
  assert.ok(evaluated.skipReason.length > 0, `skipReason 应带原因：${evaluated.skipReason}`);

  // ---- approve：无可发候选 → 409 ----
  await assert.rejects(() => approveProspectOutreachBatch(store, owner, batch.id), (error) => (error as { statusCode?: number }).statusCode === 409);

  // ---- 冻结状态机：注入 ready 项模拟已批准候选 ----
  batch.status = "approved";
  batch.items = [{
    id: "pob_item_fake",
    candidateId: candidateId,
    company: "Fake",
    recipient: "buyer@acme.example",
    status: "ready",
    skipReason: "",
    steps: [{ index: 0, delayHours: 0, subject: "s", body: "b", status: "pending", scheduledAt: new Date().toISOString(), sentAt: "", error: "" }],
    sentAt: "",
    convertedLeadId: ""
  }];
  batch.status = "draft";
  // draft 中可以移除/恢复
  const removed = await updateProspectOutreachBatchItem(store, owner, batch.id, "pob_item_fake", "remove");
  assert.equal(removed.item.status, "removed");
  await updateProspectOutreachBatchItem(store, owner, batch.id, "pob_item_fake", "restore");
  assert.equal(removed.item.status === "ready" || removed.item.status === "skipped", true);

  // ---- edit：draft 中可编辑待发送步骤的主题/正文 ----
  removed.item.status = "ready";
  const edited = await updateProspectOutreachBatchItem(store, owner, batch.id, "pob_item_fake", "edit", {
    stepIndex: 0,
    subject: "Custom subject for Acme",
    body: "Dear buyer, this content was hand-edited before freeze."
  });
  const editedStep = (edited.batch as ProspectOutreachBatch).items[0]!.steps[0]!;
  assert.equal(editedStep.subject, "Custom subject for Acme");
  assert.match(editedStep.body, /hand-edited/u);
  // 校验拒绝：主题超长 / 正文过短
  await assert.rejects(() => updateProspectOutreachBatchItem(store, owner, batch.id, "pob_item_fake", "edit", { stepIndex: 0, subject: "x".repeat(200), body: "b".repeat(30) }), (error) => (error as { statusCode?: number }).statusCode === 400);
  await assert.rejects(() => updateProspectOutreachBatchItem(store, owner, batch.id, "pob_item_fake", "edit", { stepIndex: 0, subject: "ok", body: "短" }), (error) => (error as { statusCode?: number }).statusCode === 400);
  // 已投递步骤不可编辑
  removed.item.steps[0]!.status = "sent";
  await assert.rejects(() => updateProspectOutreachBatchItem(store, owner, batch.id, "pob_item_fake", "edit", { stepIndex: 0, subject: "ok", body: "valid body here" }), (error) => (error as { statusCode?: number }).statusCode === 409);
  removed.item.steps[0]!.status = "pending";
  // 已冻结批次不可编辑
  batch.status = "approved";
  await assert.rejects(() => updateProspectOutreachBatchItem(store, owner, batch.id, "pob_item_fake", "edit", { stepIndex: 0, subject: "ok", body: "valid body here" }), (error) => (error as { statusCode?: number }).statusCode === 409);
  batch.status = "draft";

  // ---- Runner：注入已冻结批次 → 发送 → 全部步骤完成后 item sent + 自动转线索 ----
  batch.status = "approved";
  batch.frozenPayload = { approvedAt: new Date().toISOString(), approvedBy: "u_admin", items: [] };
  batch.items = [{
    id: "pob_item_fake",
    candidateId: candidateId,
    company: "Fake Co",
    recipient: "buyer@acme.example",
    status: "ready",
    skipReason: "",
    steps: [
      { index: 0, delayHours: 0, subject: "s0", body: "b0", status: "pending", scheduledAt: new Date(Date.now() - 1000).toISOString(), sentAt: "", error: "" },
      { index: 1, delayHours: 0, subject: "s1", body: "b1", status: "pending", scheduledAt: new Date(Date.now() - 1000).toISOString(), sentAt: "", error: "" }
    ],
    sentAt: "",
    convertedLeadId: ""
  }];
  const candidateRef = store.websiteOpportunities.find((item) => item.id === candidateId)!;
  candidateRef.lastReplyClassification = undefined;
  const sent: string[] = [];
  let convertCalls = 0;
  const runner = new ProspectOutreachBatchRunner(store, {
    send: async (_batch, _item, step) => {
      sent.push(step.subject);
      return { recipient: "buyer@acme.example", sentAt: new Date().toISOString(), messageId: "mid" };
    },
    convertToLead: async () => {
      convertCalls += 1;
      return "lead_fake_1";
    },
    sentCountToday: async () => sent.length,
    bouncedCountForBatch: async () => 0
  }, 60_000);
  await runner.synchronize();
  assert.equal(sent.length, 1);
  assert.equal(batch.items[0]!.steps[0]!.status, "sent");
  assert.equal(batch.items[0]!.status, "ready", "还有后续步骤时应保持 ready");
  await runner.synchronize();
  assert.equal(sent.length, 2);
  assert.equal(batch.items[0]!.status, "sent");
  assert.equal(convertCalls, 1, "发送完成后应自动转线索");
  assert.equal(batch.items[0]!.convertedLeadId, "lead_fake_1");
  assert.equal(batch.status, "completed", "所有 item 终态后批次完成");

  // ---- 退信熔断 ----
  const bounceBatch = makeBatch();
  store.prospectOutreachBatches.unshift(bounceBatch);
  bounceBatch.items = [{
    id: "pob_item_b",
    candidateId: candidateId,
    company: "B Co",
    recipient: "b@acme.example",
    status: "sent",
    skipReason: "",
    steps: [],
    sentAt: new Date().toISOString(),
    convertedLeadId: ""
  }];
  const bouncingRunner = new ProspectOutreachBatchRunner(store, {
    send: async () => ({ recipient: "", sentAt: "", messageId: "" }),
    convertToLead: async () => "lead_x",
    sentCountToday: async () => 10,
    bouncedCountForBatch: async () => Math.ceil(10 * (BOUNCE_RATE_PAUSE_THRESHOLD + 0.01))
  }, 60_000);
  bounceBatch.status = "approved";
  await bouncingRunner.synchronize();
  assert.equal(bounceBatch.status, "paused", "退信率超阈值应自动暂停");
  assert.match(bounceBatch.pauseReason, /退信熔断/u);

  // ---- stopOnReply：候选已回复 → 剩余步骤停止 ----
  const replyBatch = makeBatch();
  store.prospectOutreachBatches.unshift(replyBatch);
  candidateRef.lastReplyClassification = "clear_demand";
  replyBatch.items = [{
    id: "pob_item_r",
    candidateId: candidateId,
    company: "R Co",
    recipient: "r@acme.example",
    status: "ready",
    skipReason: "",
    steps: [{ index: 0, delayHours: 0, subject: "s", body: "b", status: "pending", scheduledAt: new Date().toISOString(), sentAt: "", error: "" }],
    sentAt: "",
    convertedLeadId: ""
  }];
  const replyRunner = new ProspectOutreachBatchRunner(store, {
    send: async () => {
      throw new Error("不应发送已回复的候选");
    },
    convertToLead: async () => "lead_r",
    sentCountToday: async () => 0,
    bouncedCountForBatch: async () => 0
  }, 60_000);
  await replyRunner.synchronize();
  assert.equal(replyBatch.items[0]!.status, "stopped");
  assert.match(replyBatch.items[0]!.skipReason, /已回复/u);
  candidateRef.lastReplyClassification = undefined;

  // ---- 取消后不能放行 ----
  const cancelTarget = await createProspectOutreachBatch(store, owner, { candidateIds: [candidateId, "no_such_candidate"] });
  await controlProspectOutreachBatch(store, owner, cancelTarget.id, "cancel");
  assert.equal(getProspectOutreachBatch(store, owner, cancelTarget.id).status, "cancelled");
  await assert.rejects(() => approveProspectOutreachBatch(store, owner, cancelTarget.id), (error) => (error as { statusCode?: number }).statusCode === 409);

  console.log("Prospect outreach batch tests passed");
}

await main();
