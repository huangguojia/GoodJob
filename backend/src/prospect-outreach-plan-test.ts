import assert from "node:assert/strict";
import {
  ProspectOutreachPlanRunner,
  controlProspectOutreachPlan,
  createProspectOutreachPlan,
  getProspectOutreachPlan,
  planCandidateMatches,
  planProgress
} from "./prospect-outreach-plan.js";
import { memoryStore, type CrmStore } from "./store.js";
import type { OutreachWritingRuntime } from "./prospect-outreach-batch.js";
import type { ProspectOutreachBatchItem, ProspectOutreachPlan, WebsiteOpportunity } from "./types.js";

function isolatedStore() {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.prospectOutreachPlans = [];
  store.persist = async () => undefined;
  return store;
}

function makeCandidate(store: CrmStore, overrides: Partial<WebsiteOpportunity> = {}): WebsiteOpportunity {
  const now = new Date().toISOString();
  const candidate = {
    id: `cand_${Math.random().toString(36).slice(2, 8)}`,
    ownerId: "u_admin",
    teamId: "europe",
    company: "Test Co",
    business: "weighing equipment",
    country: "泰国",
    contact: "Somchai",
    contactInfo: "somchai@test.co.th",
    website: "",
    status: "new",
    score: 80,
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as WebsiteOpportunity;
  store.websiteOpportunities.unshift(candidate);
  return candidate;
}

function fakeRuntime() {
  const sent: string[] = [];
  const subjects: string[] = [];
  const converted: string[] = [];
  let sentToday = 0;
  return {
    runtime: {
      async send(_batch, item: ProspectOutreachBatchItem, step, _executionId) {
        sent.push(`${item.candidateId}:${step.index}`);
        subjects.push(step.subject);
        return { recipient: item.recipient, sentAt: new Date().toISOString(), messageId: `mid_${sent.length}` };
      },
      async convertToLead(_batch, item: ProspectOutreachBatchItem) {
        // 与 server.ts 真实 runtime 同语义：线索条目回指自身，客户条目不回流
        if (item.entityType === "lead") return item.candidateId;
        if (item.entityType === "customer") return "";
        const leadId = `lead_${converted.length + 1}`;
        converted.push(`${item.candidateId}:${leadId}`);
        return leadId;
      },
      async sentCountToday() {
        return sentToday;
      },
      async bouncedCountForBatch() {
        return 0;
      }
    },
    sent,
    subjects,
    converted,
    setSentToday(value: number) {
      sentToday = value;
    }
  };
}

async function main() {
  const store = isolatedStore();
  const actor = { id: "u_admin", teamId: "europe" };

  // ---- 准备候选池：2 个合格（泰国），1 个缺邮箱（会被跳过占位），1 个别国（被筛选排除） ----
  const good1 = makeCandidate(store, { company: "Thai Scale A" });
  const good2 = makeCandidate(store, { company: "Thai Scale B" });
  const noEmail = makeCandidate(store, { company: "Thai NoEmail", contactInfo: "" });
  makeCandidate(store, { company: "German Excluded", country: "德国" });

  // ---- 创建方案：仅泰国、上限 10、宽窗口 ----
  const plan = await createProspectOutreachPlan(store, actor, {
    name: "泰国台秤开发",
    target: { countries: ["泰国"], keyword: "", maxTargets: 10 },
    policy: { dailyLimit: 50, stepIntervalHours: 1, sendWindowStartHour: 0, sendWindowEndHour: 24, stopOnReply: true }
  });
  assert.equal(plan.status, "running");

  // ---- 预览匹配：排除已入场前应命中 4（泰国 3 + 别国排除后 3？德国被过滤 → 3） ----
  assert.equal(planCandidateMatches(store, actor, plan.target).length, 3, "国家筛选应排除德国候选");

  const fake = fakeRuntime();
  const runner = new ProspectOutreachPlanRunner(store, fake.runtime, 60_000);

  // ---- tick 1~3：依次入场（noEmail → skipped 占位；good2/good1 → 发第一步） ----
  // 候选按数组序（unshift 后进先出），noEmail 最先被扫描或最后取决于插入顺序；逐 tick 直到全部终态
  for (let i = 0; i < 5; i += 1) {
    await runner.synchronize();
  }
  const mid = getProspectOutreachPlan(store, actor, plan.id);
  assert.equal(fake.sent.filter((key) => key.endsWith(":0")).length, 2, "两个合格候选应各发第一步");
  assert.equal(mid.items.filter((item) => item.status === "skipped").length, 1, "缺邮箱候选应跳过占位");
  assert.ok(mid.lastMessage.includes("暂无符合条件的新目标") || mid.lastMessage.includes("等待剩余步骤"), `lastMessage=${mid.lastMessage}`);

  // ---- 模拟时间流逝：把第 2/3 步的排期拨到过去，继续 tick 直到完成 ----
  const past = new Date(Date.now() - 3_600_000).toISOString();
  for (const item of mid.items) {
    for (const step of item.steps) {
      if (step.status === "pending") step.scheduledAt = past;
    }
  }
  for (let i = 0; i < 15 && getProspectOutreachPlan(store, actor, plan.id).status === "running"; i += 1) {
    await runner.synchronize();
  }
  const done = getProspectOutreachPlan(store, actor, plan.id);
  const progress = planProgress(done);
  assert.equal(done.status, "completed", `应完成，lastMessage=${done.lastMessage}`);
  assert.equal(progress.sent, 2, "两个合格候选应发送完成");
  assert.equal(progress.sentSteps, 6, "已发封数按信计：2 目标 × 3 步 = 6 封");
  assert.equal(progress.pendingSteps, 0, "完成后不应有待发步骤");
  assert.equal(progress.skipped, 1, "缺邮箱候选应跳过占位");
  assert.equal(progress.converted, 2, "发送完成应自动转线索回流");
  assert.equal(fake.sent.length, 6, "每个目标应发满 3 步（2 目标 × 3 步）");
  // 回流线索 ID 应写入 item
  const convertedItems = done.items.filter((item) => item.convertedLeadId);
  assert.equal(convertedItems.length, 2);
  assert.ok(convertedItems.every((item) => item.convertedLeadId.startsWith("lead_")));

  // ---- 停止 / 删除控制 ----
  const plan2 = await createProspectOutreachPlan(store, actor, {
    name: "待停方案",
    target: { countries: [], keyword: "", maxTargets: 5 },
    policy: { sendWindowStartHour: 0, sendWindowEndHour: 24 }
  });
  const paused = await controlProspectOutreachPlan(store, actor, plan2.id, "pause");
  assert.equal(paused.status, "paused");
  const resumed = await controlProspectOutreachPlan(store, actor, plan2.id, "resume");
  assert.equal(resumed.status, "running");
  const stopped = await controlProspectOutreachPlan(store, actor, plan2.id, "stop");
  assert.equal(stopped.status, "stopped");

  // ---- 每日上限：sentToday 达上限 → 不发送，lastMessage 提示 ----
  const plan3 = await createProspectOutreachPlan(store, actor, {
    name: "限流方案",
    target: { countries: [], keyword: "", maxTargets: 5 },
    policy: { dailyLimit: 2, sendWindowStartHour: 0, sendWindowEndHour: 24 }
  });
  const fake3 = fakeRuntime();
  fake3.setSentToday(2);
  const runner3 = new ProspectOutreachPlanRunner(store, fake3.runtime, 60_000);
  await runner3.synchronize();
  const afterLimit = getProspectOutreachPlan(store, actor, plan3.id);
  assert.equal(afterLimit.status, "running");
  assert.ok(afterLimit.lastMessage.includes("每日上限"), `应提示每日上限：${afterLimit.lastMessage}`);
  assert.equal(fake3.sent.length, 0, "达每日上限后不应发送");

  // ---- 手动名单 + 自定义步骤内容：候选/线索/客户混合，含缺失目标占位 ----
  const manualLead = {
    id: "lead_manual_1", company: "Manual Lead Co", contact: "Mr. Lee", country: "泰国",
    email: "lee@manual.co", remark: "scale distributor", ownerId: "u_admin", teamId: "europe"
  };
  const manualCustomer = {
    id: "cust_manual_1", company: "Manual Customer Co", contact: "Ms. Tan", country: "泰国",
    email: "tan@manual.co", ownerId: "u_admin", teamId: "europe"
  };
  store.leads.unshift(manualLead as never);
  store.customers.unshift(manualCustomer as never);
  const planManual = await createProspectOutreachPlan(store, actor, {
    name: "名单方案",
    target: {
      mode: "manual",
      entries: [
        { entityType: "candidate", entityId: good1.id },
        { entityType: "lead", entityId: "lead_manual_1" },
        { entityType: "customer", entityId: "cust_manual_1" },
        { entityType: "lead", entityId: "lead_missing" }
      ]
    },
    policy: { dailyLimit: 50, stepIntervalHours: 1, sendWindowStartHour: 0, sendWindowEndHour: 24, stopOnReply: false },
    steps: [
      { subject: "Hello {{company}}", body: "Dear {{contact}}, greeting from {{company}} in {{country}}." },
      { subject: "Again {{company}}", body: "Dear {{contact}}, following up on {{company}}." }
    ]
  });
  assert.equal(planManual.target.maxTargets, 4, "手动名单模式上限 = 名单长度");
  assert.equal(planManual.steps?.length, 2);
  const fakeManual = fakeRuntime();
  const runnerManual = new ProspectOutreachPlanRunner(store, fakeManual.runtime, 60_000);
  // 逐 tick 入场：4 个名单目标 → 3 个发首步 + 1 个缺失占位
  for (let i = 0; i < 6; i += 1) await runnerManual.synchronize();
  // 模拟时间流逝：第 2 步排期拨到过去，继续 tick 到完成
  const midManual = getProspectOutreachPlan(store, actor, planManual.id);
  for (const item of midManual.items) {
    for (const step of item.steps) {
      if (step.status === "pending") step.scheduledAt = new Date(Date.now() - 3_600_000).toISOString();
    }
  }
  for (let i = 0; i < 10 && getProspectOutreachPlan(store, actor, planManual.id).status === "running"; i += 1) {
    await runnerManual.synchronize();
  }
  const doneManual = getProspectOutreachPlan(store, actor, planManual.id);
  const progressManual = planProgress(doneManual);
  assert.equal(doneManual.status, "completed", `名单方案应完成：${doneManual.lastMessage}`);
  assert.equal(progressManual.sent, 3, "候选/线索/客户都应发完序列");
  assert.equal(progressManual.skipped, 1, "缺失目标应跳过占位");
  assert.equal(progressManual.sentSteps, 6, "3 目标 × 2 步 = 6 封");
  assert.equal(progressManual.converted, 2, "候选转线索 + 线索回指自身 = 2 条回流（客户不回流）");
  assert.ok(fakeManual.subjects.includes("Hello Thai Scale A"), `候选占位符应渲染：${fakeManual.subjects.join(" | ")}`);
  assert.ok(fakeManual.subjects.includes("Hello Manual Lead Co"), "线索占位符应渲染");
  assert.ok(fakeManual.subjects.includes("Hello Manual Customer Co"), "客户占位符应渲染");
  const leadItem = doneManual.items.find((item) => item.entityType === "lead");
  assert.equal(leadItem?.convertedLeadId, "lead_manual_1", "线索条目完成应回指自身");
  const customerItem = doneManual.items.find((item) => item.entityType === "customer");
  assert.equal(customerItem?.recipient, "tan@manual.co", "客户条目收件人取客户邮箱");
  assert.ok(fakeManual.sent.includes("lead_manual_1:0") && fakeManual.sent.includes("lead_manual_1:1"), "线索条目应走 lead 通道发送");
  assert.ok(fakeManual.sent.includes("cust_manual_1:0"), "客户条目应发送");

  // ==========================================================================
  // 阶段感知成稿（2026-10-06）
  //
  // 方案以前和批次一样：无论客户处于什么阶段，全体都从「首触」发第 1 封。
  // 这一段钉住新口径：每个目标按**自己的**阶段入场，已该阻断的直接落 skipped 占位。
  // ==========================================================================
  const stageFollow = makeCandidate(store, { company: "StageFollow Co" });
  const stageRejected = makeCandidate(store, { company: "StageRejected Co" });
  const stageFresh = makeCandidate(store, { company: "StageFresh Co" });
  const stagePlan = await createProspectOutreachPlan(store, actor, {
    name: "阶段感知方案",
    target: { countries: ["泰国"], keyword: "Stage", maxTargets: 10 },
    policy: { dailyLimit: 50, stepIntervalHours: 1, sendWindowStartHour: 0, sendWindowEndHour: 24, stopOnReply: true }
  });
  const stageByEntity: Record<string, string> = {
    [stageFollow.id]: "following_up",
    [stageRejected.id]: "replied_negative",
    [stageFresh.id]: "not_contacted"
  };
  const stageWriting: OutreachWritingRuntime = {
    sender: () => ({ name: "Kevin Lau", company: "Hong Kong New Longtec", products: "scales and load cells", website: "", signature: "" }),
    async resolve(_actor, target) {
      return {
        stageKey: (stageByEntity[target.entityId] || "not_contacted") as never,
        stageSource: "derived" as const,
        research: null,
        researchId: "",
        researchScore: 0,
        needsResearch: false,
        engineWrites: false,
        enrichmentEnabled: true,
        maxSteps: 3
      };
    }
  };
  const fakeStage = fakeRuntime();
  const stageRunner = new ProspectOutreachPlanRunner(store, fakeStage.runtime, 60_000, stageWriting);
  for (let i = 0; i < 4; i += 1) await stageRunner.synchronize();
  const stagedPlan = getProspectOutreachPlan(store, actor, stagePlan.id);
  const followItem = stagedPlan.items.find((item) => item.candidateId === stageFollow.id)!;
  const rejectedItem = stagedPlan.items.find((item) => item.candidateId === stageRejected.id)!;
  const freshItem = stagedPlan.items.find((item) => item.candidateId === stageFresh.id)!;

  assert.equal(followItem.steps.length, 1, "跟进中的目标只应排 1 封（不能重发首触）");
  assert.equal(followItem.steps[0]!.stageKey, "following_up");
  assert.equal(followItem.steps[0]!.stageLabel, "跟进中");
  assert.equal(followItem.stageKey, "following_up");
  assert.equal(followItem.stageSource, "derived");

  assert.equal(freshItem.steps.length, 3, "未接触的目标应排完整 3 封");
  assert.deepEqual(freshItem.steps.map((step) => step.stageKey), ["not_contacted", "first_touch_sent", "following_up"]);
  assert.equal(freshItem.steps[0]!.stageLabel, "未接触");

  assert.equal(rejectedItem.status, "skipped", "已拒绝的目标必须落 skipped 占位，不能进投递");
  assert.match(rejectedItem.skipReason, /拒绝|退订/u);
  assert.equal(rejectedItem.steps.length, 0);

  assert.equal(fakeStage.sent.filter((key) => key.startsWith(`${stageFollow.id}:`)).length, 1, "跟进目标只应发 1 封");
  assert.equal(fakeStage.sent.filter((key) => key.startsWith(`${stageRejected.id}:`)).length, 0, "已拒绝的目标一封都不该发");
  assert.ok(stagedPlan.lastMessage.length > 0);

  // 正文补写进度按批次/方案同一口径汇总
  const stagedProgress = planProgress(stagedPlan);
  assert.ok(stagedProgress.letters, "方案进度里应带正文补写口径");
  assert.equal(stagedProgress.letters!.total, stagedPlan.items.filter((item) => item.status === "ready" || item.status === "sending").length);

  // 没有注入写信运行时 → 退回历史固定 3 步模板（老行为不回退）
  const legacyCand = makeCandidate(store, { company: "LegacyTemplate Co" });
  const legacyPlan = await createProspectOutreachPlan(store, actor, {
    name: "无运行时方案",
    target: { countries: ["泰国"], keyword: "LegacyTemplate", maxTargets: 5 },
    policy: { dailyLimit: 50, stepIntervalHours: 1, sendWindowStartHour: 0, sendWindowEndHour: 24, stopOnReply: true }
  });
  const fakeLegacy = fakeRuntime();
  const legacyRunner = new ProspectOutreachPlanRunner(store, fakeLegacy.runtime, 60_000);
  for (let i = 0; i < 3; i += 1) await legacyRunner.synchronize();
  const legacyItem = getProspectOutreachPlan(store, actor, legacyPlan.id).items.find((item) => item.candidateId === legacyCand.id)!;
  assert.equal(legacyItem.steps.length, 3, "没有运行时仍应是 3 步模板");
  assert.equal(legacyItem.steps[0]!.stageKey, undefined, "模板步骤不带阶段标签");

  console.log("prospect-outreach-plan-test: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
