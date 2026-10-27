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
  draftResearchSignals,
  draftUsesResearch,
  englishOnly,
  ensureDevelopmentEmailSignature,
  finalizePersonalization
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

  // ── 10. 千人千面：同阶段、不同背调，必须写出两封真正不同的信 ──
  {
    const researchFor = (company: string, facts: Array<{ label: string; value: string }>) => ({
      verdict: "可优先推进",
      summary: `${company} 的公开资料`,
      engine: "测试引擎",
      facts,
      opportunities: [] as string[],
      talkTracks: [] as string[],
      risks: [] as Array<{ level: string; title: string; detail: string }>
    });
    const make = (
      company: string,
      contactName: string,
      email: string,
      facts: Array<{ label: string; value: string }>
    ) => assembleDevelopmentEmailBrief({
      stageKey: "not_contacted",
      sender: baseInput("not_contacted").sender,
      recipient: { company, contactName, email, country: "Germany", market: "Germany", context: "" },
      research: researchFor(company, facts)
    });

    const a = make("Nordwaage GmbH", "Purchasing Manager", "buy@nordwaage.de", [
      { label: "业务", value: "explosion-proof weighing for chemical plants" },
      { label: "官网", value: "https://nordwaage.de" }
    ]);
    const b = make("Packwerk AG", "Technical Manager", "tech@packwerk.ch", [
      { label: "业务", value: "packaging and filling line integration" }
    ]);
    const draftA = buildDevelopmentEmailFallback(a);
    const draftB = buildDevelopmentEmailFallback(b);

    // 核心：换了一家客户，主题与正文都必须真的变
    check(draftA.subject !== draftB.subject, "同阶段两家客户的主题必须不同");
    check(draftA.body !== draftB.body, "同阶段两家客户的正文必须不同");
    check(draftA.body.includes("Nordwaage GmbH") && !draftA.body.includes("Packwerk AG"), "A 的信只能出现 A 的公司名");
    check(/explosion-proof|hazardous/iu.test(draftA.body), "A 的信必须引用 A 的背调角度（防爆）");
    check(/packaging|filling/iu.test(draftB.body), "B 的信必须引用 B 的背调角度（包装线）");
    check(!/explosion-proof|hazardous/iu.test(draftB.body), "B 的信不能串用 A 的角度");
    // 个性化必须前置：第一段就要点出对方，而不是先自我介绍再看像不像群发
    const aOpening = draftA.body.split("\n").slice(0, 4).join(" ");
    check(
      aOpening.includes("Nordwaage GmbH") || /explosion-proof|hazardous/iu.test(aOpening),
      "个性化内容必须出现在正文第一段"
    );

    check(a.personalization.personalized && b.personalization.personalized, "有背调时应判定为已个性化");
    check(a.personalization.factsUsed.length === 2, "应记录引用了哪几条背调事实");
    check(a.personalization.difference.includes("背调事实"), "差异说明必须点明引用了背调事实");
    check(draftUsesResearch(draftA.body, a), "A 的正文应被判定为引用了背调");
    check(!draftUsesResearch("We supply industrial equipment and would like to talk.", a), "泛泛而谈不能算引用了背调");

    // 角色决定收尾问题：采购问规格/交期，技术问技术数据，不该所有人都被问"15 分钟会议"
    check(/specification|lead time/iu.test(a.personalization.ask), "采购角色应索取规格与交期");
    check(/technical data|configuration/iu.test(b.personalization.ask), "技术角色应索取技术数据");
    check(a.personalization.ask !== b.personalization.ask, "不同角色的 CTA 不能一模一样");

    // 无背调时如实承认，不许假装千人千面
    const bare = buildDevelopmentEmailFallback(assembleDevelopmentEmailBrief({
      ...baseInput("not_contacted"),
      recipient: { ...baseInput("not_contacted").recipient, context: "" },
      research: null
    }));
    check(!bare.personalization.personalized, "无背调无角度时必须判定为未个性化");
    check(bare.personalization.difference.includes("只差公司名"), "无背调时必须如实说明只差公司名");
    check(bare.basis.includes("未引用背调"), "无背调时依据行必须写明未引用背调");

    // 自检要能抓住「有背调却没引用」这种情况
    const ignored = checkDevelopmentEmailDraft(
      { subject: "Hello", body: "We supply industrial equipment and would like to work with your company. Could we talk?" },
      a
    );
    check(ignored.issues.some((item) => item.includes("按这家公司写")), "有背调却没引用时，自检必须报「这封并没有真的按这家公司写」");
    check(!checkDevelopmentEmailDraft(draftA, a).issues.some((item) => item.includes("按这家公司写")), "引用了背调的信不应误报");

    // 提示词必须把个性化写成硬约束，并要求回传用了哪些事实
    const prompt = buildDevelopmentEmailPrompt(a);
    check(prompt.includes("Personalisation is mandatory"), "提示词必须把个性化设为硬约束");
    check(prompt.includes("Personalisation plan"), "提示词必须带上个性化方案");
    check(prompt.includes("factsUsed"), "提示词必须要求模型回传用了哪些事实");

    // 回归：签名里的网址曾让**每一封**都判定成"引用了背调"——
    // 「官网」这条事实里抽出 `https`，而签名里必有 `Website: https://…`。
    const convertedBrief = assembleDevelopmentEmailBrief({
      ...baseInput("converted"),
      research: researchFor("Tanaka Scale Vietnam Co., Ltd", [
        { label: "业务", value: "explosion-proof weighing for chemical plants" },
        { label: "官网", value: "https://tanaka-scale-vietnam.com" }
      ])
    });
    const convertedDraft = buildDevelopmentEmailFallback(convertedBrief);
    check(!draftResearchSignals(convertedBrief).includes("https"), "协议词 https 不能进背调信号（签名里每封都有）");
    check(
      !draftUsesResearch(convertedDraft.body, convertedBrief),
      "只有样板行（签名 / 网址）的流程确认信，不能判定成引用了背调"
    );
    check(!convertedDraft.personalization.personalized, "流程确认信没引用背调时，必须如实说未个性化");
    check(
      !convertedDraft.personalization.difference.includes("多引用了"),
      "没引用背调时不许在差异说明里谎称引用了背调"
    );
    check(
      String(convertedDraft.personalization.trace[0] || "").includes("没有引用背调"),
      "没引用背调时，依据清单开头必须说明「素材没用上」，不能让「引用背调事实 1 条」被读成已经用了"
    );

    // 反向：剥样板行不能把行业词一起误杀。
    // 这家客户的业务里只提取到「weighing」一个角度 —— 而 weighing 同时出现在我司产品线里，
    // 若为了防误判把产品词整类删掉，"Is weighing on your roadmap?" 这种真的问对了的话
    // 就会被判成没引用背调（上一版踩过这个坑）。
    const followBrief = assembleDevelopmentEmailBrief({
      ...baseInput("following_up"),
      recipient: { ...baseInput("following_up").recipient, context: "" },
      research: researchFor("Tanaka Scale Vietnam Co., Ltd", [
        { label: "业务", value: "weighing scales distributor for local industry" }
      ])
    });
    check(
      followBrief.personalization.angles.length === 1 && followBrief.personalization.angles[0] === "weighing equipment",
      "构造前提：这家的角度只提取到称重"
    );
    const followDraft = buildDevelopmentEmailFallback(followBrief);
    check(/weighing/iu.test(followDraft.body), "跟进信应点到对方的称重业务");
    check(
      draftUsesResearch(followDraft.body, followBrief),
      "跟进信里问到了对方所在行业，应算引用了背调（不能因为这个词我司也卖就判成没引用）"
    );

    // 词边界回归：'director' 里含 'cto'，曾把「Technical Director」判成 CEO
    check(
      developmentEmailRecipientRole("Doctor", "doctor@clinic.example").key !== "decision_maker",
      "不能把 Doctor 里的 cto 当成 CEO"
    );
    check(
      developmentEmailRecipientRole("Technical Director", "tech@x.com").key === "decision_maker",
      "Director 属于决策层"
    );
  }

  // ── 11. 「为什么这么写」：逐条理由要对得上正文，且不许套话 ──
  {
    const researchFor = (facts: Array<{ label: string; value: string }>) => ({
      verdict: "可优先推进",
      summary: "公开资料",
      engine: "测试引擎",
      facts,
      opportunities: [] as string[],
      talkTracks: [] as string[],
      risks: [] as Array<{ level: string; title: string; detail: string }>
    });
    const buyer = assembleDevelopmentEmailBrief({
      stageKey: "not_contacted",
      sender: baseInput("not_contacted").sender,
      recipient: {
        company: "Nordwaage GmbH",
        contactName: "Purchasing Manager",
        email: "buy@nordwaage.de",
        country: "Germany",
        market: "Germany",
        context: ""
      },
      research: researchFor([{ label: "业务", value: "explosion-proof weighing for chemical plants" }])
    });
    const draft = buildDevelopmentEmailFallback(buyer);
    const reasons = draft.personalization.reasons;

    check(Array.isArray(reasons) && reasons.length >= 4, "每封信都必须给出逐条的「为什么这么写」");
    check(
      reasons.every((item) => item.part && item.why.trim().length >= 12),
      "每条理由都要有段落名和一句真正的解释，不能留空或一句话带过"
    );
    // 关键：理由不能凭空编——凡是有摘录的，必须能在主题/正文里找到原句
    // （「篇幅」那一条的 text 是词数统计，不是摘录，所以不参与这条判定）
    const haystack = `${draft.subject}\n${draft.body}`.toLowerCase().replace(/\s+/gu, " ");
    const quoted = reasons.filter((item) => ["主题", "开场", "为什么是我们", "收尾问题"].includes(item.part));
    check(quoted.length >= 3, "主题 / 开场 / 收尾问题必须有理由");
    check(
      quoted.every((item) => item.text.trim() && haystack.includes(item.text.toLowerCase().replace(/\s+/gu, " "))),
      "理由里引用的原句必须真的出现在这封主题或正文里（不许编造）"
    );
    check(
      reasons.some((item) => item.part === "主题" && item.why.includes("标题") && !item.weak),
      "主题这一条要说明为什么用这个标题"
    );
    check(
      reasons.some((item) => item.part === "开场" && !item.weak),
      "开场这一条要说明为什么先点对方而不是先自我介绍"
    );
    // 收尾问题必须按角色给理由：采购与技术的"为什么"不能是同一句
    check(
      reasons.some((item) => item.part === "收尾问题" && item.why.includes("采购")),
      "采购角色的收尾问题要说明「因为他要横向比价」"
    );

    const tech = assembleDevelopmentEmailBrief({
      stageKey: "not_contacted",
      sender: baseInput("not_contacted").sender,
      recipient: {
        company: "Packwerk AG",
        contactName: "Technical Manager",
        email: "tech@packwerk.ch",
        country: "Germany",
        market: "Germany",
        context: ""
      },
      research: researchFor([{ label: "业务", value: "packaging and filling line integration" }])
    });
    const techDraft = buildDevelopmentEmailFallback(tech);
    check(
      techDraft.personalization.reasons.some((item) => item.part === "收尾问题" && item.why.includes("技术")),
      "技术角色的收尾问题理由是另一套（先给可验证的数据）"
    );

    // 没有背调：理由里必须有一条明确承认「这封没做到个性化」，而不是给每条都配漂亮话
    const bare = buildDevelopmentEmailFallback(assembleDevelopmentEmailBrief({
      ...baseInput("not_contacted"),
      recipient: { ...baseInput("not_contacted").recipient, context: "" },
      research: null
    }));
    check(
      bare.personalization.reasons.some((item) => item.part === "个性化" && item.weak),
      "没有背调时，理由里必须如实写出「这封和同阶段其他客户的信一样」"
    );

    // 正文被换成通用句（AI / CLI 会重写）→ 理由必须跟着变，不能继续吹"先点对方"
    const genericBody = "Dear Purchasing Manager,\n\nWe supply industrial equipment and would like to work with your company.\n\nWould you be open to a short call?";
    const recalibrated = finalizePersonalization(buyer.personalization, { subject: "Hello", body: genericBody }, buyer);
    check(
      recalibrated.reasons.some((item) => item.part === "开场" && item.weak),
      "正文换成通用句后，开场那条理由必须改口成「换掉公司名还能发」，不能沿用原来的说法"
    );
    check(
      recalibrated.reasons.some((item) => item.part === "主题" && item.weak),
      "主题没带角度时，主题那条理由必须如实标成短板"
    );
    check(!recalibrated.personalized, "通用正文必须判定为未个性化，理由才不会自相矛盾");

    // 真实数据踩到的坑①：公司资料没填「主营产品」时，relevance 会写成
    // "X is exactly the area we work in"，但理由却落到"没有能用的行业角度，只写了市场（your market）"
    // —— 既自相矛盾，又把英文占位符 your market 直接显示给中文用户。
    const noProducts = assembleDevelopmentEmailBrief({
      stageKey: "not_contacted",
      sender: { ...baseInput("not_contacted").sender, products: "" },
      recipient: {
        company: "Nordwaage GmbH",
        contactName: "Purchasing Manager",
        email: "buy@nordwaage.de",
        country: "Germany",
        market: "Germany",
        context: ""
      },
      research: researchFor([{ label: "业务", value: "explosion-proof weighing for chemical plants" }])
    });
    const noProductsReasons = buildDevelopmentEmailFallback(noProducts).personalization.reasons;
    const whyUs = noProductsReasons.find((item) => item.part === "为什么是我们");
    check(Boolean(whyUs), "没填主营产品时也必须解释「为什么是我们」这段");
    check(
      !/没有能用的行业角度/u.test(String(whyUs?.why || "")),
      "有角度只是没填产品时，不许说成「没有能用的行业角度」"
    );
    check(
      !/your market/u.test(JSON.stringify(noProductsReasons)),
      "理由里不许出现 your market 这种没替换掉的英文占位符"
    );

    // 真实数据踩到的坑②：手上两条事实，正文只写了一条时，差异说明不许把两条都算成"已引用"。
    const withCert = assembleDevelopmentEmailBrief({
      stageKey: "not_contacted",
      sender: baseInput("not_contacted").sender,
      recipient: {
        company: "Nordwaage GmbH",
        contactName: "Purchasing Manager",
        email: "buy@nordwaage.de",
        country: "Germany",
        market: "Germany",
        context: ""
      },
      research: researchFor([
        { label: "业务", value: "explosion-proof weighing for chemical plants" },
        { label: "认证", value: "ISO 9001 certified since 2009" }
      ])
    });
    const withCertDraft = buildDevelopmentEmailFallback(withCert);
    check(withCert.personalization.factsUsed.length === 2, "构造前提：手上确实有两条事实");
    check(!/ISO|9001|certified/iu.test(withCertDraft.body), "构造前提：正文并没有写认证那条事实");
    check(
      !withCertDraft.personalization.difference.includes("认证"),
      "正文没写的认证事实不许算进「引用了几条背调事实」"
    );
    check(
      withCertDraft.personalization.difference.includes("应用角度"),
      "差异说明要指出真正用上的那个角度"
    );

    // 逐阶段扫一遍：**理由引用的原句必须来自这封信本身**。
    // 曾经出现过 converted 阶段引用「Would it be useful if I sent the specified...」这种
    // 计划里的 CTA —— 那封信里根本没有这句，等于给面板配了一句不存在的原文。
    const stages: OutreachJourneyStageKey[] = ["not_contacted", "first_touch_sent", "following_up", "replied_interested", "converted"];
    for (const stage of stages) {
      const stageBrief = assembleDevelopmentEmailBrief({
        ...baseInput(stage),
        recipient: {
          company: "Tanaka Scale Vietnam Co., Ltd",
          contactName: "Purchasing Manager",
          email: "buy@tanaka-scale-vietnam.com",
          country: "Vietnam",
          market: "Vietnam",
          context: ""
        },
        research: researchFor([{ label: "业务", value: "weighing scales distributor for local industry" }])
      });
      const stageDraft = buildDevelopmentEmailFallback(stageBrief);
      const hay = `${stageDraft.subject}\n${stageDraft.body}`.toLowerCase().replace(/\s+/gu, " ");
      const quotedInStage = stageDraft.personalization.reasons.filter(
        (item) => ["主题", "开场", "为什么是我们", "收尾问题"].includes(item.part) && item.text.trim()
      );
      check(
        quotedInStage.every((item) => hay.includes(item.text.toLowerCase().replace(/\s+/gu, " "))),
        `${stage} 阶段：理由里引用的原句必须真的出现在这封信里`
      );
      check(stageDraft.personalization.reasons.length >= 4, `${stage} 阶段也必须给出逐条理由`);
    }

    // 流程确认信（converted）不用背调是设计，不是缺陷 —— 不许标成"没做好"
    const convertedBrief = assembleDevelopmentEmailBrief({
      ...baseInput("converted"),
      research: researchFor([{ label: "业务", value: "weighing scales distributor for local industry" }])
    });
    const convertedDraft = buildDevelopmentEmailFallback(convertedBrief);
    check(
      convertedDraft.personalization.reasons.every((item) => !item.weak),
      "流程确认信不该被标成「没写好」：这个阶段按设计就不用背调"
    );
    check(
      convertedDraft.personalization.reasons.some((item) => item.part === "个性化" && item.why.includes("按设计")),
      "流程确认信要说明「按设计不用背调」，而不是让人以为做漏了"
    );

    // 流程确认信没有背调时，不该把它列进「待补齐」——那是催人去跑一件本阶段不需要的事
    const convertedBare = assembleDevelopmentEmailBrief({
      ...baseInput("converted"),
      research: null
    });
    check(
      !convertedBare.missing.some((item) => item.includes("背调")),
      "流程确认信不要求背调，缺背调不算「待补齐」"
    );
    check(
      buildDevelopmentEmailFallback(convertedBare).personalization.difference.includes("按设计不引用背调"),
      "流程确认信没有背调时，差异说明要说「按设计」，不能说成「只差公司名」"
    );
  }

  console.log(JSON.stringify({ ok: true, checked }, null, 2));
}

main();
