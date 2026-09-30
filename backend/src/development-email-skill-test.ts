/**
 * 开发信撰写技能回归测试。
 *
 * 重点覆盖 2026-09-29 的真实事故：候选的 business 字段是中文调研摘要，
 * 被批次模板原样拼进英文信，客户收到一封夹着中文的开发信。
 */
import {
  assembleDevelopmentEmailBrief,
  buildDevelopmentEmailFallback,
  buildDevelopmentEmailPrompt,
  checkDevelopmentEmailDraft,
  containsCjk,
  developmentEmailAngles,
  developmentEmailRecipientRole,
  developmentEmailSignature,
  developmentEmailStagePlan,
  englishOnly,
  ensureDevelopmentEmailSignature
} from "./development-email-skill.js";
import { prospectBatchStepTemplates } from "./prospect-outreach-batch.js";
import type { OutreachJourneyStageKey } from "./outreach-journey.js";
import type { ProspectOutreachBatchPolicy } from "./types.js";

const BATCH_POLICY: ProspectOutreachBatchPolicy = {
  dailyLimit: 20,
  stepIntervalHours: 72,
  sendWindowStartHour: 9,
  sendWindowEndHour: 11,
  stopOnReply: true
};

let checked = 0;
function check(condition: unknown, message: string) {
  checked += 1;
  if (!condition) throw new Error(`AssertionError: ${message}`);
}

/** 真实的候选调研摘要（中文，含日文与越南文专用名） */
const CHINESE_BUSINESS =
  "日本 Tanaka Scale 在越制造子公司（2011 年成立，Dong Nai Nhơn Trạch 3 工业区），"
  + "专注工业称重：防水秤、本安型防爆称重系统、联网汽车衡，Yellow Pages Vietnam 实名认证企业";

function baseInput(stageKey: OutreachJourneyStageKey) {
  return {
    stageKey,
    sender: {
      name: "Kevin",
      company: "Zhuhai Changlu Industrial Automatic Control System Co., Ltd.",
      products: "industrial weighing and batching control systems",
      website: "https://www.longtec.com",
      signature: "Best regards,\nKevin"
    },
    recipient: {
      company: "Tanaka Scale Vietnam Co., Ltd",
      contactName: "待维护",
      email: "info@tanaka-scale-vietnam.com",
      country: "Vietnam",
      market: "Vietnam",
      context: CHINESE_BUSINESS
    }
  };
}

function main() {
  // ── 1. 阶段策略：每个阶段都要有目标和话术，禁止发送的阶段必须为 0 词 ──
  {
    const stages: OutreachJourneyStageKey[] = [
      "not_contacted", "first_touch_sent", "following_up",
      "replied_interested", "replied_negative", "bounced", "converted"
    ];
    for (const key of stages) {
      const plan = developmentEmailStagePlan(key);
      check(plan.key === key, `阶段 ${key} 应能取到对应策略`);
      check(Boolean(plan.objective), `阶段 ${key} 必须有明确目标`);
    }
    check(developmentEmailStagePlan("replied_negative").maxWords === 0, "明确拒绝的阶段不能生成可发送正文");
    check(developmentEmailStagePlan("bounced").maxWords === 0, "退信阶段不能生成可发送正文");
    check(developmentEmailStagePlan(undefined).key === "not_contacted", "缺少阶段时应默认按未接触处理");
    check(developmentEmailStagePlan("nonexistent-key").key === "not_contacted", "未知阶段不能抛错");
    check(
      developmentEmailStagePlan("first_touch_sent").mustAvoid.some((item) => item.includes("重复")),
      "第 2 封必须明确禁止重复首封内容"
    );
  }

  // ── 2. 收件人角色与决策权 ──
  {
    check(developmentEmailRecipientRole("Alice Chen", "alice.chen@x.com").key === "unknown", "只有姓名时不能假设决策权");
    check(developmentEmailRecipientRole("Purchasing Manager", "buy@x.com").key === "procurement", "采购角色应识别为 procurement");
    check(developmentEmailRecipientRole("CEO", "ceo@x.com").key === "decision_maker", "决策层应识别为 decision_maker");
    check(developmentEmailRecipientRole("采购经理 王", "wang@x.com").key === "procurement", "中文职位也要能识别");
    check(developmentEmailRecipientRole("待维护", "info@x.com").key === "general", "info@ 应识别为通用邮箱");
    check(developmentEmailRecipientRole("待维护", "sales@x.com").key === "general", "sales@ 应识别为通用邮箱");
    check(developmentEmailRecipientRole("待维护", "Zhang Wei").key === "unknown", "占位联系人应识别为待确认");
    check(
      developmentEmailRecipientRole("待维护", "x@y.com").authority.includes("转呈"),
      "联系人未知时应提示按可转呈来写"
    );
  }

  // ── 3. 语言守卫：中文绝不进英文信 ──
  {
    check(containsCjk(CHINESE_BUSINESS), "应能识别中文");
    check(!containsCjk("industrial weighing systems"), "英文不应被误判为中文");
    check(englishOnly(CHINESE_BUSINESS, "your sourcing needs") === "your sourcing needs", "中文必须被拦下并回落");
    check(englishOnly("load cells", "fallback") === "load cells", "英文应原样放行");
    check(englishOnly("   ", "fallback") === "fallback", "空值应回落");
  }

  // ── 4. 行业词典：只从真实出现的关键词里提取英文角度 ──
  {
    const angles = developmentEmailAngles(CHINESE_BUSINESS);
    const keywords = angles.map((angle) => angle.keyword);
    check(keywords.includes("weighing"), "应识别称重");
    check(keywords.includes("wash-down"), "应识别防水");
    check(keywords.includes("explosion-proof"), "应识别防爆");
    check(keywords.includes("truck scales"), "应识别汽车衡");
    check(keywords.includes("networked"), "应识别联网");
    check(developmentEmailAngles("bluetooth speakers").length === 0, "无关文本不应提取出角度");
    check(developmentEmailAngles("").length === 0, "空文本不应提取出角度");
  }

  // ── 5. 蓝图组装 ──
  {
    const brief = assembleDevelopmentEmailBrief(baseInput("first_touch_sent"));
    check(brief.plan.key === "first_touch_sent", "蓝图应带上阶段策略");
    check(brief.role.key === "general", "info@ 收件人应为通用邮箱角色");
    check(brief.recipient.salutation === "Tanaka Scale Vietnam Co., Ltd team", "占位联系人应改用「公司 team」称呼");
    check(brief.recipient.contactName === "", "占位联系人不能进 AI 提示词（否则会写出 Dear 待维护）");
    check(brief.angles.length >= 4, "应提取出多个应用角度");
    check(brief.missing.includes("背调结果（建议先跑一次 AI 背调）"), "缺背调时必须如实列出");
    check(!brief.missing.some((item) => item.includes("公司名称")), "我方公司名已提供时不应报缺失");

    // 「待补齐」文案必须准确：姓名已知时说"姓名也缺"是自相矛盾（实测踩过）
    const namedNoTitle = assembleDevelopmentEmailBrief({
      ...baseInput("first_touch_sent"),
      recipient: { ...baseInput("first_touch_sent").recipient, contactName: "Simon", email: "simon@tanaka-scale-vietnam.com" }
    });
    check(namedNoTitle.role.key === "unknown", "只有个人邮箱、无职位信息时应标为联系人待确认");
    check(namedNoTitle.missing.includes("收件人职位"), "姓名已知时缺的只是职位");
    check(!namedNoTitle.missing.includes("收件人姓名"), "姓名已知时不能说姓名也缺");

    const nameMissing = assembleDevelopmentEmailBrief({
      ...baseInput("first_touch_sent"),
      recipient: { ...baseInput("first_touch_sent").recipient, contactName: "待维护", email: "simon@tanaka-scale-vietnam.com" }
    });
    check(nameMissing.role.key === "unknown", "无角色线索的邮箱应为待确认角色");
    check(nameMissing.missing.includes("收件人姓名"), "占位联系人时应缺姓名");
    check(!nameMissing.missing.includes("收件人职位"), "姓名都没拿到时不该单列职位");

    // 我方资料缺失必须带"我方"前缀，否则与「收件邮箱」并列会被读成收件人信息
    const noSenderProfile = assembleDevelopmentEmailBrief({
      ...baseInput("first_touch_sent"),
      sender: { ...baseInput("first_touch_sent").sender, company: "", products: "" }
    });
    check(noSenderProfile.missing.includes("我方公司名称"), "缺我方公司名要带「我方」前缀");
    check(noSenderProfile.missing.includes("我方主营产品"), "缺我方主营产品要带「我方」前缀");

    const withResearch = assembleDevelopmentEmailBrief({
      ...baseInput("first_touch_sent"),
      research: {
        verdict: "可优先推进",
        summary: "Tanaka Scale 在越南生产工业称重设备。",
        engine: "gpt-5.6-sol · 四路联网深挖",
        facts: [{ label: "业务", value: "工业称重" }],
        opportunities: ["确认防爆称重系统的采购节奏"],
        talkTracks: ["从防爆认证切入"]
      }
    });
    check(withResearch.evidence.some((item) => item.includes("背调")), "有背调时应记录依据");
    check(withResearch.evidence.some((item) => item.includes("话术线索")), "话术线索应计入依据");
    check(withResearch.researchVerdict === "可优先推进", "结论应带入蓝图");
  }

  // ── 6. 兜底模板：中文绝不泄漏，且按阶段变形 ──
  {
    const stages: OutreachJourneyStageKey[] = ["not_contacted", "first_touch_sent", "following_up", "replied_interested", "converted"];
    for (const key of stages) {
      const brief = assembleDevelopmentEmailBrief(baseInput(key));
      const draft = buildDevelopmentEmailFallback(brief);
      check(!containsCjk(draft.subject), `阶段 ${key} 的主题不能出现中文`);
      check(!containsCjk(draft.body), `阶段 ${key} 的正文不能出现中文：「${draft.body.slice(0, 60)}」`);
      check(draft.body.includes("Tanaka Scale Vietnam Co., Ltd"), `阶段 ${key} 的正文应出现对方公司名`);
      check(draft.body.includes("[" ) === false || !/\[(Company name|Products and services)\]/u.test(draft.body), `阶段 ${key} 不应残留占位符`);
      check(draft.basis.length > 0, `阶段 ${key} 应给出生成依据`);
      check(/[?]/u.test(draft.body), `阶段 ${key} 必须包含一个问句，否则收件人没有回复的理由`);
    }

    const first = buildDevelopmentEmailFallback(assembleDevelopmentEmailBrief(baseInput("not_contacted")));
    check(first.subject.includes("Tanaka Scale Vietnam Co., Ltd"), "首触主题应含对方公司名");
    check(/weighing|wash-down|explosion-proof/u.test(first.body), "首触正文应引用背调里真实出现的应用角度");

    const second = buildDevelopmentEmailFallback(assembleDevelopmentEmailBrief(baseInput("first_touch_sent")));
    check(/^Re:/u.test(second.subject), "第 2 封应复用主题作为回复线索");
    check(/left out|did not include|Rather than repeat/iu.test(second.body), "第 2 封必须提供首封没有的新信息");
    check(/close the file/iu.test(second.body), "第 2 封应给体面的退出选项");

    const closing = buildDevelopmentEmailFallback(assembleDevelopmentEmailBrief(baseInput("following_up")));
    check(/Closing the loop/iu.test(closing.subject), "跟进中阶段应是收尾式主题");
    check(closing.body.split(/\s+/u).filter(Boolean).length < 110, "收尾信应足够短");

    // 无背调、无角度时也不能崩，也不能编造角度
    const bare = buildDevelopmentEmailFallback(assembleDevelopmentEmailBrief({
      ...baseInput("not_contacted"),
      recipient: { ...baseInput("not_contacted").recipient, context: "" }
    }));
    check(!containsCjk(bare.body), "无上下文时也不能出现中文");
    // 兜底只在"按阶段撰写"路径上出现，阶段依据必然存在 → 不能说"暂无阶段依据"（实测踩过）
    check(bare.basis.includes("按阶段"), "兜底依据应声明是按当前阶段撰写的");
    check(bare.basis.includes("未引用背调"), "没有背调时应如实说明");
    check(!bare.basis.includes("暂无"), "不能笼统宣称「暂无阶段依据」，与实际来源矛盾");
    check(bare.body.length > 0, "无背调也要产出可用的信，不能空");

    // 落款：属于"按我的身份写信"的一部分，模板必带；AI 漏写时由 ensureDevelopmentEmailSignature 兜底
    const signedFallback = buildDevelopmentEmailFallback(assembleDevelopmentEmailBrief(baseInput("not_contacted")));
    check(signedFallback.body.includes("Best regards,\nKevin"), "兜底模板正文必须带配置的落款");
    check(
      ensureDevelopmentEmailSignature("Hello there.\n\nBest regards,\nKevin", "Best regards,\nKevin") === "Hello there.\n\nBest regards,\nKevin",
      "已有落款时不能重复追加"
    );
    check(
      ensureDevelopmentEmailSignature("Hello there.", "Best regards,\nKevin").endsWith("Best regards,\nKevin"),
      "AI 漏写落款时必须补上"
    );
    check(buildDevelopmentEmailPrompt(assembleDevelopmentEmailBrief(baseInput("not_contacted")), {}).includes("Best regards"), "提示词必须把落款交给模型");
    check(
      developmentEmailSignature(assembleDevelopmentEmailBrief({
        ...baseInput("not_contacted"),
        sender: { ...baseInput("not_contacted").sender, signature: "此致敬礼，凯文" }
      })).startsWith("Best regards,"),
      "中文落款必须换成英文兜底落款"
    );

    // 中文联系人名 / 中文公司名绝不能进英文信（真实事故同类：客户收到夹中文开发信）
    const cjkContactOnly = assembleDevelopmentEmailBrief({
      ...baseInput("first_touch_sent"),
      recipient: { ...baseInput("first_touch_sent").recipient, contactName: "王磊" }
    });
    check(cjkContactOnly.recipient.contactName === "", "中文联系人名不能进提示词");
    check(
      cjkContactOnly.recipient.salutation === "Tanaka Scale Vietnam Co., Ltd team",
      "中文联系人名应退回「公司 team」称呼"
    );

    const cjkAll = assembleDevelopmentEmailBrief({
      ...baseInput("first_touch_sent"),
      recipient: {
        ...baseInput("first_touch_sent").recipient,
        company: "上海捷弗康贸易有限公司",
        contactName: "王磊",
        email: "wang@example.com"
      }
    });
    check(cjkAll.recipient.englishCompany === "", "中文公司名不应有英文安全版");
    check(cjkAll.recipient.salutation === "Sales team", "公司名与联系人都不能用时，称呼退到 Sales team");
    const cjkDraft = buildDevelopmentEmailFallback(cjkAll);
    check(!containsCjk(cjkDraft.subject), `中文公司名不能进主题：「${cjkDraft.subject}」`);
    check(!containsCjk(cjkDraft.body), `中文公司名不能进正文：「${cjkDraft.body.slice(0, 80)}」`);
    check(/^[A-Z]/u.test(cjkDraft.subject), "没有公司名打头时主题要正常大写");
    check(
      !buildDevelopmentEmailPrompt(cjkAll, {}).includes("上海捷弗康贸易有限公司"),
      "提示词不应带中文公司名，否则模型会照抄"
    );

    // 每个阶段的兜底主题在「无公司名」时也不能夹中文
    for (const key of stages) {
      const noName = buildDevelopmentEmailFallback(assembleDevelopmentEmailBrief({
        ...baseInput(key),
        recipient: { ...baseInput(key).recipient, company: "上海捷弗康贸易有限公司" }
      }));
      check(!containsCjk(noName.subject), `阶段 ${key} 无英文公司名时主题仍不能出现中文`);
      check(!containsCjk(noName.body), `阶段 ${key} 无英文公司名时正文仍不能出现中文`);
    }
  }

  // ── 7. 批次模板（真实事故回归）──
  {
    const steps = prospectBatchStepTemplates(
      {
        company: "Tanaka Scale Vietnam Co., Ltd",
        business: CHINESE_BUSINESS,
        country: "Vietnam",
        contact: "待维护",
        contactInfo: "info@tanaka-scale-vietnam.com"
      },
      BATCH_POLICY
    );
    check(steps.length === 3, "批次序列应仍为 3 步");
    for (const [index, step] of steps.entries()) {
      check(!containsCjk(step.body), `批次第 ${index + 1} 步正文泄漏了中文：「${step.body.slice(0, 80)}」`);
      check(!containsCjk(step.subject), `批次第 ${index + 1} 步主题泄漏了中文`);
      check(!step.body.includes("待维护"), `批次第 ${index + 1} 步不应把占位联系人写进称呼`);
      check(step.body.includes("Tanaka Scale Vietnam Co., Ltd team"), `批次第 ${index + 1} 步应改用公司 team 称呼`);
    }
    check(/weighing|wash-down|explosion-proof/u.test(steps[0]!.body), "批次首触应引用真实出现的英文应用角度");
    check(!/international sourcing and distribution/u.test(steps[0]!.body), "有真实角度时不应回落到泛泛的兜底描述");
  }

  // ── 8. AI 提示词：必须带上阶段、角色、背调与语言硬约束 ──
  {
    const brief = assembleDevelopmentEmailBrief({
      ...baseInput("first_touch_sent"),
      research: {
        verdict: "可优先推进",
        summary: "工业称重制造商",
        facts: [{ label: "业务", value: "工业称重" }],
        opportunities: ["确认防爆称重系统采购节奏"],
        talkTracks: ["从防爆认证切入"],
        risks: [{ level: "medium", title: "联系方式", detail: "只有通用邮箱" }]
      }
    });
    const prompt = buildDevelopmentEmailPrompt(brief, { tone: "professional", goal: "争取一次报价机会" });
    check(prompt.includes("Write ONLY in English"), "提示词必须强制英文");
    check(prompt.includes("Never invent"), "提示词必须禁止编造事实");
    check(prompt.includes(brief.plan.objective), "提示词必须包含本封的唯一目标");
    check(prompt.includes("Call to action"), "提示词必须包含行动号召要求");
    check(prompt.includes(brief.role.authority), "提示词必须包含收件人角色与决策权说明");
    check(prompt.includes("工业称重"), "提示词应把背调事实交给模型");
    check(prompt.includes("从防爆认证切入"), "提示词应把话术线索交给模型");
    check(prompt.includes("争取一次报价机会"), "提示词应带上业务员给的目标");
    check(prompt.includes("at most 140 words") || /at most \d+ words/u.test(prompt), "提示词必须带篇幅上限");
  }

  // ── 9. 发送前质量自检 ──
  {
    const brief = assembleDevelopmentEmailBrief(baseInput("first_touch_sent"));
    const cjk = checkDevelopmentEmailDraft({ subject: "Test", body: "你好，我们是供应商。" }, brief);
    check(!cjk.ok && cjk.issues.some((item) => item.includes("中文")), "必须能检出正文夹中文");
    const filler = checkDevelopmentEmailDraft({ subject: "Test", body: "I hope this email finds you well. Regards." }, brief);
    check(filler.issues.some((item) => item.includes("客套")), "必须能检出空泛客套开头");
    const placeholder = checkDevelopmentEmailDraft({ subject: "Test", body: "We are [Company name] and we supply [Products and services]. Ready?" }, brief);
    check(placeholder.issues.some((item) => item.includes("占位符")), "必须能检出未替换的占位符");
    const noQuestion = checkDevelopmentEmailDraft({ subject: "Test", body: "We supply weighing systems and would like to cooperate with you." }, brief);
    check(noQuestion.issues.some((item) => item.includes("问")), "必须能检出通篇没有问句");
    // 「回复 A 或 B」这种指令式 CTA 没有问号，但同样是有效的回复请求，不应误报
    const replyCta = checkDevelopmentEmailDraft(
      { subject: "Test", body: "Reply \"materials\" and I will send the specs; otherwise reply \"not suitable\" and I will close the loop." },
      brief
    );
    check(!replyCta.issues.some((item) => item.includes("问")), "指令式回复 CTA 不应被误报为没有回复请求");
    const good = checkDevelopmentEmailDraft(
      buildDevelopmentEmailFallback(assembleDevelopmentEmailBrief(baseInput("first_touch_sent"))),
      brief
    );
    check(good.ok, `兜底模板自身应通过质量自检，实际：${good.issues.join("；")}`);
  }

  console.log(JSON.stringify({ ok: true, checked }, null, 2));
}

main();
