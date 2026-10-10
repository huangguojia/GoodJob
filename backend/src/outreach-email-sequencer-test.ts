import assert from "node:assert/strict";
import { containsCjk } from "./development-email-skill.js";
import {
  buildStageAwareSequence,
  isOutreachStageKey,
  normalizeOutreachStage,
  OUTREACH_SEQUENCE_DEFAULT_STEPS,
  OUTREACH_STAGE_LADDER,
  outreachLetterEngineLabel,
  outreachStageLabel,
  planStageSequence
} from "./outreach-email-sequencer.js";
import type { OutreachJourneyStageKey } from "./outreach-journey.js";

// ---------------------------------------------------------------------------
// 阶段感知的开发信序列成稿器（纯函数，不碰库、不发信）
//
// 这里守的是那两条最容易回归的纪律：
//   ① 「接着客户现在的阶段往下走」——已经发过首触的客户不能再被当成新客户重发第一封；
//   ② 中文绝不进英文信 —— 中文公司名 / 联系人名必须被 englishOnly 守卫吃掉。
// ---------------------------------------------------------------------------

let checks = 0;
function ok(value: unknown, message: string) {
  checks += 1;
  assert.ok(value, message);
}
function equal<T>(actual: T, expected: T, message: string) {
  checks += 1;
  assert.equal(actual, expected, message);
}
function deepEqual(actual: unknown, expected: unknown, message: string) {
  checks += 1;
  assert.deepEqual(actual, expected, message);
}

const ALL_STAGES: OutreachJourneyStageKey[] = [
  "not_contacted",
  "first_touch_sent",
  "following_up",
  "replied_interested",
  "replied_negative",
  "bounced",
  "converted"
];

const SENDER = {
  name: "Kevin Lau",
  company: "Hong Kong New Longtec Industrial Limited",
  products: "industrial weighing scales and load cells",
  website: "https://www.newlongtec.com",
  signature: ""
};

function recipient(overrides: Partial<{ company: string; contactName: string; email: string; country: string; context: string }> = {}) {
  return {
    company: "Tanaka Scale Vietnam",
    contactName: "Kenji Tanaka",
    email: "kenji@tanaka-scale.vn",
    country: "Vietnam",
    context: "distributor of weighing equipment",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. 阶段键的识别 / 归一 / 标签
// ---------------------------------------------------------------------------
for (const stage of ALL_STAGES) {
  ok(isOutreachStageKey(stage), `阶段键「${stage}」应被识别`);
}
ok(!isOutreachStageKey("первый"), "未知阶段键不应被识别");
ok(!isOutreachStageKey(""), "空串不应被识别");
ok(!isOutreachStageKey(undefined), "undefined 不应被识别");
ok(!isOutreachStageKey(42), "数字不应被识别");

equal(normalizeOutreachStage("following_up"), "following_up", "合法阶段应原样返回");
equal(normalizeOutreachStage("bogus"), "not_contacted", "非法阶段应归一为未接触");
equal(normalizeOutreachStage(undefined), "not_contacted", "缺失阶段应归一为未接触");
equal(normalizeOutreachStage(null), "not_contacted", "null 阶段应归一为未接触");

equal(outreachStageLabel("first_touch_sent"), "已发首触", "已发首触的标签");
equal(outreachStageLabel("replied_interested"), "已回复·可推进", "已回复可推进的标签");
equal(outreachStageLabel("nope"), "未接触", "未知阶段标签退化为未接触");
ok(outreachStageLabel("bounced").includes("退信"), "退信阶段标签应含「退信」");

// ---------------------------------------------------------------------------
// 2. planStageSequence：冷触达口径（批量 / 自动方案）
// ---------------------------------------------------------------------------
{
  const plan = planStageSequence("not_contacted", 3, { coldOnly: true });
  deepEqual(plan.stages, OUTREACH_STAGE_LADDER, "未接触：应沿完整阶梯走 3 步");
  equal(plan.blockedReason, "", "未接触不应被阻断");

  const fromFirst = planStageSequence("first_touch_sent", 3, { coldOnly: true });
  deepEqual(fromFirst.stages, ["first_touch_sent", "following_up"], "已发首触：本次只应发第 2 封与收尾，不能重发首触");

  const following = planStageSequence("following_up", 3, { coldOnly: true });
  deepEqual(following.stages, ["following_up"], "跟进中：再发只应是一封收尾提醒");

  // 已回复 / 已转线索：冷触达通道必须阻断（走 stopOnReply 只是事后补救，不如一开始就说清）
  for (const stage of ["replied_interested", "converted"] as OutreachJourneyStageKey[]) {
    const blocked = planStageSequence(stage, 3, { coldOnly: true });
    equal(blocked.stages.length, 0, `冷触达：${stage} 不应产生任何步骤`);
    ok(blocked.blockedReason.length > 0, `冷触达：${stage} 应给出跳过原因`);
  }

  // 已拒绝 / 退信：任何通道都硬阻断
  for (const stage of ["replied_negative", "bounced"] as OutreachJourneyStageKey[]) {
    for (const coldOnly of [true, false]) {
      const blocked = planStageSequence(stage, 3, { coldOnly });
      equal(blocked.stages.length, 0, `${stage}（coldOnly=${coldOnly}）不应产生任何步骤`);
      ok(blocked.blockedReason.length > 0, `${stage}（coldOnly=${coldOnly}）应给出阻断原因`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. planStageSequence：单封口径（工坊 / 客户档案）
// ---------------------------------------------------------------------------
{
  const interested = planStageSequence("replied_interested", 3, { coldOnly: false });
  deepEqual(interested.stages, ["replied_interested"], "单封口径：已回复应能出一封承接需求信");
  equal(interested.blockedReason, "", "单封口径：已回复不应被阻断");

  const converted = planStageSequence("converted", 3, { coldOnly: false });
  deepEqual(converted.stages, ["converted"], "单封口径：已转化应能出一封轻量确认信");
}

// ---------------------------------------------------------------------------
// 4. planStageSequence：封数上限与默认值
// ---------------------------------------------------------------------------
{
  equal(OUTREACH_SEQUENCE_DEFAULT_STEPS, 3, "默认封数应为 3");
  deepEqual(planStageSequence("not_contacted", 1, {}).stages, ["not_contacted"], "上限 1 应只保留第一步");
  deepEqual(planStageSequence("not_contacted", 2, {}).stages, ["not_contacted", "first_touch_sent"], "上限 2 应保留前两步");
  equal(planStageSequence("not_contacted", 0, {}).stages.length, OUTREACH_SEQUENCE_DEFAULT_STEPS, "上限 0 应退回默认封数");
  equal(planStageSequence("not_contacted", Number.NaN, {}).stages.length, OUTREACH_SEQUENCE_DEFAULT_STEPS, "上限 NaN 应退回默认封数");
  equal(planStageSequence("not_contacted", -5, {}).stages.length, OUTREACH_SEQUENCE_DEFAULT_STEPS, "上限负数应退回默认封数");
  equal(planStageSequence("not_contacted", 999, {}).stages.length, OUTREACH_SEQUENCE_DEFAULT_STEPS, "上限超 10 应被截到阶梯长度（3）");
  equal(planStageSequence("not_contacted", undefined, {}).stages.length, OUTREACH_SEQUENCE_DEFAULT_STEPS, "未传上限应取默认封数");
}

// ---------------------------------------------------------------------------
// 5. buildStageAwareSequence：正文按阶段产出、延迟递增、来源可解释
// ---------------------------------------------------------------------------
{
  const result = buildStageAwareSequence({
    stageKey: "not_contacted",
    maxSteps: 3,
    stepIntervalHours: 72,
    sender: SENDER,
    recipient: recipient(),
    coldOnly: true
  });
  equal(result.stageKey, "not_contacted", "结果应回显当前阶段");
  equal(result.stageLabel, "未接触", "结果应回显当前阶段标签");
  equal(result.blockedReason, "", "未接触不应被阻断");
  equal(result.steps.length, 3, "未接触应产出 3 封");
  deepEqual(result.steps.map((step) => step.stageKey), ["not_contacted", "first_touch_sent", "following_up"], "3 封应沿阶梯推进");
  deepEqual(result.steps.map((step) => step.delayHours), [0, 72, 144], "延迟应按步间隔递增");
  for (const step of result.steps) {
    ok(step.subject.trim().length > 0, `${step.stageKey} 的主题不应为空`);
    ok(step.body.trim().length > 0, `${step.stageKey} 的正文不应为空`);
    ok(step.basis.length > 0, `${step.stageKey} 应给出来源说明`);
    ok(!containsCjk(step.body), `${step.stageKey} 的正文不得含中文`);
    ok(!containsCjk(step.subject), `${step.stageKey} 的主题不得含中文`);
    ok(step.stageLabel.length > 0, `${step.stageKey} 应有阶段标签`);
  }
  ok(result.roleLabel.length > 0, "应能推断收件人角色");
}
{
  const fromFirst = buildStageAwareSequence({
    stageKey: "first_touch_sent",
    stepIntervalHours: 48,
    sender: SENDER,
    recipient: recipient(),
    coldOnly: true
  });
  equal(fromFirst.steps.length, 2, "已发首触本次只应产出 2 封");
  deepEqual(fromFirst.steps.map((step) => step.stageKey), ["first_touch_sent", "following_up"], "已发首触应从第 2 封起步");
  deepEqual(fromFirst.steps.map((step) => step.delayHours), [0, 48], "第 2 封应间隔 48 小时");

  const following = buildStageAwareSequence({
    stageKey: "following_up",
    stepIntervalHours: 48,
    sender: SENDER,
    recipient: recipient(),
    coldOnly: true
  });
  equal(following.steps.length, 1, "跟进中应只产出 1 封");
}
{
  // 非法的步间隔退回 72 小时，避免界面传 0 导致三封同时发
  const result = buildStageAwareSequence({
    stageKey: "not_contacted",
    stepIntervalHours: 0,
    sender: SENDER,
    recipient: recipient(),
    coldOnly: true
  });
  deepEqual(result.steps.map((step) => step.delayHours), [0, 72, 144], "步间隔 0 应退回默认 72 小时");
}

// ---------------------------------------------------------------------------
// 6. 被阻断时不给正文，但仍能解释「为什么跳过」
// ---------------------------------------------------------------------------
{
  const result = buildStageAwareSequence({
    stageKey: "replied_negative",
    stepIntervalHours: 72,
    sender: SENDER,
    recipient: recipient(),
    research: { verdict: "rejected", engine: "cli" },
    coldOnly: false
  });
  equal(result.steps.length, 0, "已拒绝不应产出任何正文");
  ok(result.blockedReason.includes("拒绝") || result.blockedReason.includes("退订"), "阻断原因应点明拒绝/退订");
  ok(result.roleLabel.length > 0, "被阻断时仍应给出角色，便于界面解释");

  const bounced = buildStageAwareSequence({
    stageKey: "bounced",
    stepIntervalHours: 72,
    sender: SENDER,
    recipient: recipient(),
    coldOnly: false
  });
  ok(bounced.blockedReason.includes("退回"), "退信阻断原因应点明退回");
}

// ---------------------------------------------------------------------------
// 7. 中文守卫：中文公司名 / 联系人名绝不能漏进英文信
// ---------------------------------------------------------------------------
{
  const result = buildStageAwareSequence({
    stageKey: "not_contacted",
    stepIntervalHours: 72,
    sender: { ...SENDER, company: "香港新龙泰工业有限公司", products: "工业衡器" },
    recipient: recipient({ company: "上海衡器进出口有限公司", contactName: "王磊", context: "上海衡器进出口有限公司 主营衡器" }),
    coldOnly: true
  });
  for (const step of result.steps) {
    ok(!containsCjk(step.subject), `中文收件人：主题不得含中文（${step.stageKey}）`);
    ok(!containsCjk(step.body), `中文收件人：正文不得含中文（${step.stageKey}）`);
    ok(step.body.includes("Best regards"), `${step.stageKey} 的落款应退到英文安全版`);
  }
}
{
  // 英文公司名应当出现在主题里，用来让收件人一眼知道这封信是写给谁的
  const result = buildStageAwareSequence({
    stageKey: "not_contacted",
    stepIntervalHours: 72,
    sender: SENDER,
    recipient: recipient({ company: "Tanaka Scale Vietnam" }),
    coldOnly: true
  });
  ok(result.steps[0].subject.includes("Tanaka Scale Vietnam"), "英文公司名应出现在首封信主题里");

  const cjk = buildStageAwareSequence({
    stageKey: "not_contacted",
    stepIntervalHours: 72,
    sender: SENDER,
    recipient: recipient({ company: "上海衡器进出口有限公司" }),
    coldOnly: true
  });
  ok(!cjk.steps[0].subject.includes("上海"), "中文公司名不得出现在主题里");
}

// ---------------------------------------------------------------------------
// 8. 背调注入：有背调时依据里要能看出来
// ---------------------------------------------------------------------------
{
  const noResearch = buildStageAwareSequence({
    stageKey: "not_contacted",
    stepIntervalHours: 72,
    sender: SENDER,
    recipient: recipient({ context: "" }),
    coldOnly: true
  });
  deepEqual(noResearch.evidence, [], "无背调、无角度时依据应为空");
  ok(noResearch.steps[0].basis.includes("按阶段"), "无背调时的来源说明应点明「按阶段」");

  const withResearch = buildStageAwareSequence({
    stageKey: "not_contacted",
    stepIntervalHours: 72,
    sender: SENDER,
    recipient: recipient(),
    research: {
      verdict: "worth_contacting",
      summary: "Tanaka Scale is a regional weighing distributor expanding into calibration services.",
      engine: "本机 CLI",
      score: 82,
      facts: [
        { label: "Founded", value: "2011" },
        { label: "Employees", value: "45" }
      ],
      opportunities: ["Calibration service expansion"],
      talkTracks: ["Ask about their calibration lab plans"],
      nextAction: "Send an intro email referencing calibration expansion"
    },
    coldOnly: true
  });
  ok(withResearch.evidence.length > 0, "有背调时依据不应为空");
  ok(withResearch.evidence.some((item) => item.includes("背调")), "依据里应标注引用了背调");
  ok(withResearch.evidence.some((item) => item.includes("事实")), "依据里应标注事实条数");
  ok(withResearch.steps[0].basis.includes("依据"), "来源说明应点明依据");
}

// ---------------------------------------------------------------------------
// 9. 收件人归一：market 缺省时按国家推导；地址/公司缺失也不能崩
// ---------------------------------------------------------------------------
{
  const result = buildStageAwareSequence({
    stageKey: "not_contacted",
    stepIntervalHours: 72,
    sender: SENDER,
    recipient: { company: "", contactName: "", email: "", country: "Vietnam", context: "" },
    coldOnly: true
  });
  equal(result.steps.length, 3, "收件人信息缺失也应产出可发正文");
  ok(!containsCjk(result.steps[0].body), "信息缺失时正文仍须为英文");
  ok(result.missing.length > 0, "缺收件人必要信息时应在 missing 里列出");
}

// ---------------------------------------------------------------------------
// 10. 引擎来源标签
// ---------------------------------------------------------------------------
{
  equal(outreachLetterEngineLabel("ai"), "AI API", "AI 来源标签");
  equal(outreachLetterEngineLabel("cli"), "本机 CLI", "CLI 来源标签");
  equal(outreachLetterEngineLabel("template"), "固定模板", "模板来源标签");
  equal(outreachLetterEngineLabel("ai", "Codex (gpt-5.5)"), "Codex (gpt-5.5)", "有明细时应优先显示明细");
  equal(outreachLetterEngineLabel("cli", "   "), "本机 CLI", "明细为空白时应退回来源标签");
}

console.log(`outreach-email-sequencer-test: ${checks} 项断言全部通过`);
