import assert from "node:assert/strict";
import {
  BOUNCE_RATE_PAUSE_THRESHOLD,
  LETTER_PENDING_MAX_MS,
  ProspectOutreachBatchRunner,
  approveProspectOutreachBatch,
  batchLetterProgress,
  composeItem,
  controlProspectOutreachBatch,
  createProspectOutreachBatch,
  getProspectOutreachBatch,
  itemLetterReadyToSend,
  letterProgressForItems,
  nextWindowStart,
  prospectBatchStepTemplates,
  toBatchSteps,
  updateProspectOutreachBatchItem,
  writingTargetForItem,
  type OutreachWritingRuntime,
  type OutreachWritingTarget
} from "./prospect-outreach-batch.js";
import { memoryStore, type CrmStore } from "./store.js";
import type { ProspectOutreachBatch, ProspectOutreachBatchItem, ProspectOutreachBatchPolicy } from "./types.js";

function isolatedStore() {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.prospectOutreachBatches = [];
  store.persist = async () => undefined;
  return store;
}

/**
 * 假的写信运行时：只回答「这家客户现在到哪一步了、有没有背调」，
 * 不做任何数据库/网络调用 —— 阶段感知成稿的契约可以脱离 server.ts 单测。
 */
function fakeWritingRuntime(options: {
  stageKey: string;
  stageSource?: "derived" | "manual";
  research?: Record<string, unknown> | null;
  researchId?: string;
  researchScore?: number;
  needsResearch?: boolean;
  engineWrites?: boolean;
  enrichmentEnabled?: boolean;
  maxSteps?: number;
}): OutreachWritingRuntime {
  const sender = {
    name: "Kevin Lau",
    company: "Hong Kong New Longtec Industrial Limited",
    products: "industrial weighing scales and load cells",
    website: "https://www.newlongtec.com",
    signature: ""
  };
  return {
    sender: () => sender,
    async resolve() {
      return {
        stageKey: options.stageKey as never,
        stageSource: options.stageSource || "derived",
        research: (options.research ?? null) as never,
        researchId: options.researchId || "",
        researchScore: options.researchScore || 0,
        needsResearch: options.needsResearch ?? !options.research,
        engineWrites: options.engineWrites ?? false,
        enrichmentEnabled: options.enrichmentEnabled ?? true,
        maxSteps: options.maxSteps ?? 3
      };
    }
  };
}

const WRITING_TARGET: OutreachWritingTarget = {
  entityType: "candidate",
  entityId: "cand_writing_test",
  company: "Tanaka Scale Vietnam",
  contactName: "Kenji Tanaka",
  email: "kenji@tanaka-scale.vn",
  country: "Vietnam",
  context: "distributor of weighing equipment"
};

const STAGE_POLICY: ProspectOutreachBatchPolicy = {
  dailyLimit: 20,
  stepIntervalHours: 72,
  sendWindowStartHour: 9,
  sendWindowEndHour: 18,
  stopOnReply: true,
  autoResearch: true
};

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

  // ==========================================================================
  // 阶段感知成稿（2026-10-06）
  //
  // 这一段的目的是把「接着客户现在的阶段往下走」钉死成契约：
  // 已经发过首触的客户**不能**再收到第一封信，缺背调的条目要能被后台补写，
  // 补写没完成前发送端要跳过它。
  // ==========================================================================
  const actor = { id: owner.id, teamId: owner.teamId };

  // ---- ① 不注入运行时 → 仍是历史固定 3 步模板（老行为不回退） ----
  const legacy = await composeItem(undefined, actor, STAGE_POLICY, WRITING_TARGET);
  assert.equal(legacy.steps.length, 3, "无运行时应退回固定 3 步模板");
  assert.equal(legacy.blockedReason, "");
  assert.equal(legacy.meta.letterStatus, undefined, "无运行时不该写阶段/正文元数据");
  assert.equal(legacy.steps[1]!.delayHours, 72);

  // ---- ② 未接触：完整阶梯 3 封 ----
  const freshRuntime = fakeWritingRuntime({ stageKey: "not_contacted" });
  const fresh = await composeItem(freshRuntime, actor, STAGE_POLICY, WRITING_TARGET);
  assert.equal(fresh.blockedReason, "");
  assert.equal(fresh.steps.length, 3, "未接触应排 3 封");
  assert.deepEqual(fresh.steps.map((step) => step.stageKey), ["not_contacted", "first_touch_sent", "following_up"]);
  assert.deepEqual(fresh.steps.map((step) => step.delayHours), [0, 72, 144]);
  assert.equal(fresh.meta.stageKey, "not_contacted");
  assert.equal(fresh.meta.stageLabel, "未接触");
  assert.equal(fresh.meta.stageSource, "derived");
  assert.equal(fresh.meta.letterEngine, "固定模板（阶段蓝图）");
  assert.ok(fresh.meta.letterBasis.length > 0, "应留下成稿依据");

  // ---- ③ 已发首触：本次只排第 2 封与收尾，且第 1 封正文与「未接触」的第 2 封逐字一致 ----
  const fromFirst = await composeItem(fakeWritingRuntime({ stageKey: "first_touch_sent" }), actor, STAGE_POLICY, WRITING_TARGET);
  assert.equal(fromFirst.steps.length, 2, "已发首触本次只应排 2 封");
  assert.deepEqual(fromFirst.steps.map((step) => step.stageKey), ["first_touch_sent", "following_up"]);
  assert.equal(fromFirst.steps[0]!.subject, fresh.steps[1]!.subject, "已发首触的第 1 封应等同于未接触序列的第 2 封");
  assert.equal(fromFirst.meta.stageLabel, "已发首触");

  // ---- ④ 跟进中：只发一封收尾提醒，绝不重新推销 ----
  const followingOnly = await composeItem(fakeWritingRuntime({ stageKey: "following_up" }), actor, STAGE_POLICY, WRITING_TARGET);
  assert.equal(followingOnly.steps.length, 1, "跟进中只应排 1 封");
  assert.equal(followingOnly.steps[0]!.stageKey, "following_up");
  assert.equal(followingOnly.steps[0]!.subject, fresh.steps[2]!.subject, "跟进的这一封应等同于阶梯末端的收尾信");
  assert.notEqual(followingOnly.steps[0]!.subject, fresh.steps[0]!.subject, "绝不能把首触信当成跟进信再发一次");

  // ---- ⑤ 已拒绝 / 退信：硬阻断，落 skipped 占位并写明原因 ----
  for (const stageKey of ["replied_negative", "bounced"]) {
    const blocked = await composeItem(fakeWritingRuntime({ stageKey }), actor, STAGE_POLICY, WRITING_TARGET);
    assert.equal(blocked.steps.length, 0, `${stageKey} 不应产出正文`);
    assert.ok(blocked.blockedReason.length > 0, `${stageKey} 应给出阻断原因`);
    assert.equal(blocked.meta.letterNote, blocked.blockedReason);
  }

  // ---- ⑥ 正文补写闸门：要引擎写 / 缺背调要补跑 → pending；否则 ready ----
  const pendingByEngine = await composeItem(
    fakeWritingRuntime({ stageKey: "not_contacted", engineWrites: true, research: { verdict: "ok" }, needsResearch: false }),
    actor, STAGE_POLICY, WRITING_TARGET
  );
  assert.equal(pendingByEngine.meta.letterStatus, "pending", "交给引擎写时应先标 pending");
  assert.ok(pendingByEngine.meta.letterPendingAt, "pending 必须带上时间戳，否则超时兜底算不出来");

  const pendingByResearch = await composeItem(
    fakeWritingRuntime({ stageKey: "not_contacted", needsResearch: true }),
    actor, STAGE_POLICY, WRITING_TARGET
  );
  assert.equal(pendingByResearch.meta.letterStatus, "pending", "缺背调且允许自动补跑时应先标 pending");

  const noAutoResearch = await composeItem(
    fakeWritingRuntime({ stageKey: "not_contacted", needsResearch: true }),
    actor, { ...STAGE_POLICY, autoResearch: false }, WRITING_TARGET
  );
  assert.equal(noAutoResearch.meta.letterStatus, "ready", "关掉自动补背调后不应再等补写");

  const enrichmentOff = await composeItem(
    fakeWritingRuntime({ stageKey: "not_contacted", engineWrites: true, enrichmentEnabled: false }),
    actor, STAGE_POLICY, WRITING_TARGET
  );
  assert.equal(enrichmentOff.meta.letterStatus, "ready", "补写工序关掉时不能置 pending，否则没人来收尾");

  const withResearch = await composeItem(
    fakeWritingRuntime({
      stageKey: "not_contacted",
      researchId: "bgr_test_1",
      researchScore: 77,
      research: { verdict: "worth_contacting", summary: "regional weighing distributor", facts: [{ label: "Founded", value: "2011" }] }
    }),
    actor, STAGE_POLICY, WRITING_TARGET
  );
  assert.equal(withResearch.meta.letterStatus, "ready", "有背调又不交给引擎时应直接 ready");
  assert.equal(withResearch.meta.researchId, "bgr_test_1");
  assert.equal(withResearch.meta.researchScore, 77);
  assert.match(withResearch.meta.letterBasis, /依据/u, "依据里应写出引用了什么");
  assert.equal(withResearch.meta.letterNote, "", "已引用背调就不该再提示补跑");

  // ---- ⑦ 封数上限由运行时决定 ----
  const capped = await composeItem(fakeWritingRuntime({ stageKey: "not_contacted", maxSteps: 1 }), actor, STAGE_POLICY, WRITING_TARGET);
  assert.equal(capped.steps.length, 1, "运行时给的上限应生效");

  // ---- ⑧ 中文收件人：绝不漏进英文信 ----
  const cjk = await composeItem(fakeWritingRuntime({ stageKey: "not_contacted" }), actor, STAGE_POLICY, {
    ...WRITING_TARGET,
    company: "上海衡器进出口有限公司",
    contactName: "王磊",
    context: "上海衡器进出口有限公司 主营衡器"
  });
  for (const step of cjk.steps) {
    assert.ok(!/[\u4e00-\u9fff]/u.test(step.subject), `主题不得含中文：${step.subject}`);
    assert.ok(!/[\u4e00-\u9fff]/u.test(step.body), "正文不得含中文");
  }

  // ---- ⑨ toBatchSteps：阶段信息随步骤落库 + 排期口径不变 ----
  // 注意：scheduledAt 是**逐封累加** delayHours（历史口径，本次未改动）。
  // 所以模板给出的绝对偏移 [0, 72, 144] 会落成 [0, 72, 216] —— 第三封比「同人间隔 72 小时」
  // 的提示更晚。这是既有行为，不在这里顺手改，避免影响已在跑的批次节奏。
  const nowMs = Date.parse("2026-10-06T09:00:00Z");
  const batchSteps = toBatchSteps(fresh, nowMs, true);
  assert.equal(batchSteps.length, 3);
  assert.equal(batchSteps[0]!.scheduledAt, new Date(nowMs).toISOString(), "第 1 步应立刻可发");
  assert.equal(batchSteps[1]!.scheduledAt, new Date(nowMs + 72 * 3_600_000).toISOString());
  assert.equal(batchSteps[2]!.scheduledAt, new Date(nowMs + 216 * 3_600_000).toISOString(), "排期仍是历史累加口径");
  assert.deepEqual(batchSteps.map((step) => step.stageKey), ["not_contacted", "first_touch_sent", "following_up"]);
  assert.equal(batchSteps[1]!.stageLabel, "已发首触");
  assert.deepEqual(batchSteps.map((step) => step.delayHours), [0, 72, 144]);
  assert.ok(batchSteps.every((step) => step.status === "pending"));

  // ---- ⑩ 发送前闸门：pending 未过期要跳过，过期要放行（否则引擎长期不可用会卡死整批） ----
  assert.equal(LETTER_PENDING_MAX_MS, 2 * 3_600_000, "超时兜底应为 2 小时");
  const pendingFresh = { letterStatus: "pending", letterPendingAt: new Date().toISOString() } as ProspectOutreachBatchItem;
  assert.equal(itemLetterReadyToSend(pendingFresh), false, "刚标 pending 的目标不该发");
  assert.equal(itemLetterReadyToSend({ letterStatus: "pending", letterPendingAt: new Date(Date.now() - LETTER_PENDING_MAX_MS - 1000).toISOString() } as ProspectOutreachBatchItem), true, "pending 超过 2 小时应放行");
  assert.equal(itemLetterReadyToSend({ letterStatus: "ready" } as ProspectOutreachBatchItem), true);
  assert.equal(itemLetterReadyToSend({ letterStatus: "failed" } as ProspectOutreachBatchItem), true, "补写失败也要能发（已降级为模板版）");
  assert.equal(itemLetterReadyToSend({} as ProspectOutreachBatchItem), true, "老数据没有 letterStatus，必须能正常发");
  assert.equal(itemLetterReadyToSend({ letterStatus: "pending" } as ProspectOutreachBatchItem), true, "缺时间戳时宁可放行，不能把整批永久卡死");

  // ---- ⑪ 补写进度计数（批次与方案共用口径） ----
  const progressItems = [
    { status: "ready", letterStatus: "pending", researchId: "" },
    { status: "ready", letterStatus: "ready", researchId: "bgr_1" },
    { status: "ready", letterStatus: "failed", researchId: "bgr_2" },
    { status: "sending", researchId: "bgr_3" },
    { status: "sent", letterStatus: "pending", researchId: "" }
  ] as ProspectOutreachBatchItem[];
  const letters = letterProgressForItems(progressItems);
  assert.equal(letters.total, 4, "只统计在投递的目标（sent 不算）");
  assert.equal(letters.pending, 1);
  assert.equal(letters.ready, 2);
  assert.equal(letters.failed, 1);
  assert.equal(letters.withResearch, 3);
  const progressBatch = makeBatch(store, { items: progressItems });
  assert.deepEqual(batchLetterProgress(progressBatch), letters, "batchLetterProgress 应等于共用口径");

  // ---- ⑫ 从已存在的批次项反推写信目标 ----
  store.websiteOpportunities.unshift({
    id: "cand_target_lookup",
    company: "Tanaka Scale Vietnam",
    contact: "Kenji Tanaka",
    country: "Vietnam",
    contactInfo: "kenji@tanaka-scale.vn",
    business: "weighing distributor",
    ownerId: owner.id,
    teamId: owner.teamId,
    status: "new",
    createdAt: new Date().toISOString()
  } as never);
  const lookupItem = { id: "i", candidateId: "cand_target_lookup", company: "Tanaka Scale Vietnam", recipient: "kenji@tanaka-scale.vn", entityType: "candidate", leadId: "", steps: [], status: "ready", skipReason: "", sentAt: "", convertedLeadId: "" } as ProspectOutreachBatchItem;
  const lookedUp = writingTargetForItem(store, lookupItem);
  assert.equal(lookedUp?.company, "Tanaka Scale Vietnam");
  assert.equal(lookedUp?.email, "kenji@tanaka-scale.vn");
  assert.equal(writingTargetForItem(store, { ...lookupItem, candidateId: "no_such_candidate" }), null, "目标不存在必须返回 null 而不是编一个");

  // ---- ⑬ 人工临时覆盖阶段：改标签就必须按新阶段重排正文 ----
  const overrideBatch = makeBatch(store, { id: "pob_stage_override", status: "draft" });
  overrideBatch.items = [{
    id: "pob_item_override",
    candidateId: "cand_target_lookup",
    company: "Tanaka Scale Vietnam",
    recipient: "kenji@tanaka-scale.vn",
    status: "ready",
    skipReason: "",
    steps: [{ index: 0, delayHours: 0, subject: "old", body: "old", status: "pending", scheduledAt: new Date().toISOString(), sentAt: "", error: "" }],
    sentAt: "",
    convertedLeadId: ""
  }];
  store.prospectOutreachBatches.unshift(overrideBatch);
  const derivedRuntime = fakeWritingRuntime({ stageKey: "following_up" });
  const overridden = await updateProspectOutreachBatchItem(store, owner, overrideBatch.id, "pob_item_override", "stage", { stageKey: "not_contacted" }, derivedRuntime);
  assert.equal(overridden.item.stageSource, "manual", "人工覆盖要标成 manual，不能和系统推导混淆");
  assert.equal(overridden.item.stageKey, "not_contacted");
  assert.equal(overridden.item.steps.length, 3, "改成未接触后应重排成 3 封");
  assert.deepEqual(overridden.item.steps.map((step) => step.stageKey), ["not_contacted", "first_touch_sent", "following_up"]);
  assert.equal(overridden.item.steps[0]!.subject, fresh.steps[0]!.subject, "重排后的正文应就是未接触阶段的首封信");

  // 撤销人工覆盖 → 回到系统推导（界面上的「按系统推导」不能是个假选项）
  const reverted = await updateProspectOutreachBatchItem(store, owner, overrideBatch.id, "pob_item_override", "stage", { stageKey: "" }, derivedRuntime);
  assert.equal(reverted.item.stageSource, "derived", "撤销覆盖后来源应回到推导");
  assert.equal(reverted.item.stageKey, "following_up", "撤销覆盖后应回到系统推导出的阶段");
  assert.equal(reverted.item.steps.length, 1, "撤销覆盖后正文也要跟着回到该阶段的序列");
  assert.equal(reverted.item.steps[0]!.stageKey, "following_up");

  // 非法阶段值 → 400
  await assert.rejects(
    () => updateProspectOutreachBatchItem(store, owner, overrideBatch.id, "pob_item_override", "stage", { stageKey: "не_стадия" }, derivedRuntime),
    (error) => (error as { statusCode?: number }).statusCode === 400
  );
  // 没有写信链路 → 409（只改标签不改正文等于自欺）
  await assert.rejects(
    () => updateProspectOutreachBatchItem(store, owner, overrideBatch.id, "pob_item_override", "stage", { stageKey: "following_up" }),
    (error) => (error as { statusCode?: number }).statusCode === 409
  );
  // 已投递过 → 409
  overrideBatch.items[0]!.steps[0]!.status = "sent";
  await assert.rejects(
    () => updateProspectOutreachBatchItem(store, owner, overrideBatch.id, "pob_item_override", "stage", { stageKey: "following_up" }, derivedRuntime),
    (error) => (error as { statusCode?: number }).statusCode === 409
  );
  overrideBatch.items[0]!.steps = [];
  overrideBatch.items[0]!.steps.push({ index: 0, delayHours: 0, subject: "old", body: "old", status: "pending", scheduledAt: new Date().toISOString(), sentAt: "", error: "" });
  // 已冻结批次 → 409
  overrideBatch.status = "approved";
  await assert.rejects(
    () => updateProspectOutreachBatchItem(store, owner, overrideBatch.id, "pob_item_override", "stage", { stageKey: "following_up" }, derivedRuntime),
    (error) => (error as { statusCode?: number }).statusCode === 409
  );
  overrideBatch.status = "draft";
  // 覆盖成「已拒绝」→ 阻断，且不该把已排的正文清空后落一个空批次（这里直接拒掉，由用户去取消重建）
  await assert.rejects(
    () => updateProspectOutreachBatchItem(store, owner, overrideBatch.id, "pob_item_override", "stage", { stageKey: "replied_negative" }, derivedRuntime),
    (error) => (error as { statusCode?: number }).statusCode === 409
  );

  // ---- ⑭ Runner：pending 的目标不能被送出，补写完成后才能发 ----
  const gateBatch = makeBatch(store, { id: "pob_pending_gate", status: "approved" });
  store.prospectOutreachBatches.unshift(gateBatch);
  gateBatch.items = [{
    id: "pob_item_gate",
    candidateId: candidateId,
    company: "Gate Co",
    recipient: "gate@acme.example",
    status: "ready",
    skipReason: "",
    letterStatus: "pending",
    letterPendingAt: new Date().toISOString(),
    steps: [{ index: 0, delayHours: 0, subject: "gate", body: "gate body", status: "pending", scheduledAt: new Date(Date.now() - 1000).toISOString(), sentAt: "", error: "" }],
    sentAt: "",
    convertedLeadId: ""
  }];
  candidateRef.lastReplyClassification = undefined;
  const gateSent: string[] = [];
  const gateRunner = new ProspectOutreachBatchRunner(store, {
    send: async (_batch, _item, step) => {
      gateSent.push(step.subject);
      return { recipient: "gate@acme.example", sentAt: new Date().toISOString(), messageId: "mid_gate" };
    },
    convertToLead: async () => "lead_gate",
    sentCountToday: async () => 0,
    bouncedCountForBatch: async () => 0
  }, 60_000);
  await gateRunner.synchronize();
  assert.equal(gateSent.length, 0, "正文还在补写时绝不能把半成品发出去");
  assert.equal(gateBatch.items[0]!.steps[0]!.status, "pending");
  // 补写完成 → 下一轮就能发
  gateBatch.items[0]!.letterStatus = "ready";
  gateBatch.items[0]!.letterPendingAt = "";
  await gateRunner.synchronize();
  assert.equal(gateSent.length, 1, "补写完成后应正常发出");

  console.log("Prospect outreach batch tests passed");
}

await main();
