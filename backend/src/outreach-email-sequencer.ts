/**
 * 阶段感知的开发信序列成稿器。
 *
 * 解决的问题（2026-10-06）：
 *   发信批次 / 自动发送方案以前**全体共用一套写死的 3 步模板**（首触 → 跟进 → 收尾），
 *   既不读客户现在处在哪个开发阶段，也不读背调。结果是一个已经回复过、或者已经发过
 *   5 封的客户进入批次后，照样从「首触」第 1 步重新发一遍。
 *
 * 本模块把「第几封」换成「接着客户现在的阶段往下走」：
 *   not_contacted   → 首触 → 第 2 封 → 收尾（最多 3 步）
 *   first_touch_sent→ 第 2 封 → 收尾（最多 2 步）
 *   following_up    → 收尾提醒（1 步）
 *   replied_interested / converted → 各 1 步（承接需求 / 轻量确认）
 *   replied_negative / bounced     → 0 步，并给出不该发的理由（合规/数据）
 *
 * 每封信的正文都来自 `development-email-skill.ts` 的阶段蓝图（objective/angle/mustInclude/
 * mustAvoid/maxWords/subjectRule），并把最近一次背调的事实、机会、话术线索、应用角度拼进蓝图。
 *
 * 两条纪律（都是踩过的坑）：
 *   ① 中文绝不进英文信 —— 走技能里的 englishOnly / englishCompany 守卫；
 *   ② 没有 AI 也要能出一封「能直接发出去的信」，所以默认用技能的分阶段兜底模板，
 *      引擎（AI API / 本机 CLI）可用时再由上层后台补写成更强版本。
 */
import {
  assembleDevelopmentEmailBrief,
  buildDevelopmentEmailFallback,
  developmentEmailMarketName,
  developmentEmailRecipientRole,
  type DevelopmentEmailBrief,
  type DevelopmentEmailBriefInput,
  type DevelopmentEmailDraftContent
} from "./development-email-skill.js";
import { outreachJourneyStageMeta, type OutreachJourneyStageKey } from "./outreach-journey.js";

/** 我方（发件方）写信身份 */
export interface OutreachWritingSender {
  name: string;
  company: string;
  products: string;
  website: string;
  signature: string;
}

/** 收件方写信上下文；`market` 缺省时由 country 推导 */
export interface OutreachWritingRecipient {
  company: string;
  contactName: string;
  email: string;
  country: string;
  market?: string;
  context: string;
}

/** 最近一次背调的结构化输入（与开发信工坊同一口径） */
export type OutreachWritingResearch = DevelopmentEmailBriefInput["research"];

export interface OutreachStageSequenceStep {
  /** 发这一封时，收件人处在哪个阶段（= 该用哪份阶段蓝图） */
  stageKey: OutreachJourneyStageKey;
  stageLabel: string;
  /** 相对序列第 1 步的延迟小时数（第 1 步永远 0） */
  delayHours: number;
  subject: string;
  body: string;
  /** 这一封的成稿依据（界面展示） */
  basis: string;
}

export interface StageSequencePlan {
  /** 依次要发的阶段；为空表示不该发 */
  stages: OutreachJourneyStageKey[];
  /** 非空 = 不该发，值是给用户看的原因 */
  blockedReason: string;
}

export interface StageSequenceResult {
  /** 推导/覆盖后的当前阶段 */
  stageKey: OutreachJourneyStageKey;
  stageLabel: string;
  steps: OutreachStageSequenceStep[];
  blockedReason: string;
  /** 本次成稿引用了哪些依据（背调、事实条数、应用角度…） */
  evidence: string[];
  /** 还缺哪些信息（缺了就写不出好信） */
  missing: string[];
  /** 收件人角色推断结果 */
  roleLabel: string;
}

/** 没有指定步数上限时的默认封数（与历史批次的 3 步一致） */
export const OUTREACH_SEQUENCE_DEFAULT_STEPS = 3;

/** 客户从冷到热的阶段阶梯；批次序列沿这条线往后走 */
export const OUTREACH_STAGE_LADDER: OutreachJourneyStageKey[] = [
  "not_contacted",
  "first_touch_sent",
  "following_up"
];

const ALL_STAGES: OutreachJourneyStageKey[] = [
  "not_contacted",
  "first_touch_sent",
  "following_up",
  "replied_interested",
  "replied_negative",
  "bounced",
  "converted"
];

export function isOutreachStageKey(value: unknown): value is OutreachJourneyStageKey {
  return typeof value === "string" && (ALL_STAGES as string[]).includes(value);
}

/** 阶段归一：非法/缺失一律当成「未接触」，与开发信工坊的兜底口径一致 */
export function normalizeOutreachStage(value: OutreachJourneyStageKey | string | undefined | null): OutreachJourneyStageKey {
  return isOutreachStageKey(value) ? value : "not_contacted";
}

export function outreachStageLabel(value: OutreachJourneyStageKey | string | undefined | null) {
  return outreachJourneyStageMeta(normalizeOutreachStage(value)).label;
}

/**
 * 这个收件人接下来该发哪几封。
 * `maxSteps` 是这批允许的最大封数（历史批次默认 3）；≤0 视为取默认值。
 *
 * `coldOnly`（批量/自动方案用）额外把三类目标挡在门外——批量通道本质是**冷触达自动化**，
 * 让它在这些目标上继续跑只会造成事故：
 *   · 已回复   → 批次自己的 stopOnReply 也会立刻停发，不如一开始就说清该走哪条通道；
 *   · 已转线索/客户 → 后续该走正式业务流程，不该再被冷触达序列碰一次；
 *   · 已拒绝/退信 → 合规与可达性问题，必须硬阻断。
 * 关掉 `coldOnly`（单封工坊 / 客户档案）时，这三类仍然各自有一封合适的信。
 */
export function planStageSequence(
  currentStage: OutreachJourneyStageKey | string | undefined | null,
  maxSteps: number = OUTREACH_SEQUENCE_DEFAULT_STEPS,
  options: { coldOnly?: boolean } = {}
): StageSequencePlan {
  const limit = Number.isFinite(maxSteps) && maxSteps > 0
    ? Math.min(Math.floor(maxSteps), 10)
    : OUTREACH_SEQUENCE_DEFAULT_STEPS;
  const key = normalizeOutreachStage(currentStage);
  const coldOnly = Boolean(options.coldOnly);
  // 显式标注类型：数组字面量会被推成 string[]，直接 slice 就丢掉了阶段键的联合类型
  const capped = (stages: OutreachJourneyStageKey[]) => stages.slice(0, limit);

  // 这两条无论在哪个通道都不该发：这里必须是硬阻断，不能退回「未接触」——
  // 那等于给已拒绝 / 已退信的地址继续发信。
  if (key === "replied_negative") {
    return {
      stages: [],
      blockedReason: "客户已明确拒绝或要求退订，任何继续发送都会违反外发合规约束，本条不再投递。"
    };
  }
  if (key === "bounced") {
    return {
      stages: [],
      blockedReason: "上一次投递被退回，同一个地址再发还会失败；请先补一个有效邮箱再入批。"
    };
  }
  if (key === "replied_interested") {
    if (coldOnly) {
      return {
        stages: [],
        blockedReason: "客户已回复，冷触达批次会按「回复即停」直接停发；请到开发信工坊或客户档案里用回复跟进信推进。"
      };
    }
    return { stages: capped(["replied_interested"]), blockedReason: "" };
  }
  if (key === "converted") {
    if (coldOnly) {
      return {
        stages: [],
        blockedReason: "这家客户已转线索 / 客户，后续走正式业务流程跟进，不再进入冷触达批次。"
      };
    }
    return { stages: capped(["converted"]), blockedReason: "" };
  }
  if (key === "following_up") {
    // 已经跟进多轮：再发就是一封收尾式提醒，不做第三次推销
    return { stages: capped(["following_up"]), blockedReason: "" };
  }
  if (key === "first_touch_sent") {
    return { stages: capped(["first_touch_sent", "following_up"]), blockedReason: "" };
  }
  return { stages: capped(OUTREACH_STAGE_LADDER), blockedReason: "" };
}

/** 收件方上下文归一（market 缺省时按国家推导，与开发信工坊同口径） */
export function normalizeOutreachRecipient(input: OutreachWritingRecipient): OutreachWritingRecipient {
  return {
    company: (input.company || "").trim(),
    contactName: (input.contactName || "").trim(),
    email: (input.email || "").trim(),
    country: (input.country || "").trim(),
    market: (input.market || "").trim() || developmentEmailMarketName(input.country || ""),
    context: (input.context || "").trim()
  };
}

/** 按阶段蓝图出一封信；`buildDevelopmentEmailFallback` 对 maxWords=0 的阶段也有安全分支 */
function letterForStage(
  stageKey: OutreachJourneyStageKey,
  sender: OutreachWritingSender,
  recipient: OutreachWritingRecipient,
  research: OutreachWritingResearch
): { brief: DevelopmentEmailBrief; draft: DevelopmentEmailDraftContent } {
  const brief = assembleDevelopmentEmailBrief({
    stageKey,
    sender: {
      name: sender.name || "",
      company: sender.company || "",
      products: sender.products || "",
      website: sender.website || "",
      signature: sender.signature || ""
    },
    recipient: {
      company: recipient.company,
      contactName: recipient.contactName,
      email: recipient.email,
      country: recipient.country,
      market: recipient.market || "",
      context: recipient.context
    },
    research: research || null
  });
  return { brief, draft: buildDevelopmentEmailFallback(brief) };
}

/**
 * 成稿：按客户当前阶段 + 最近一次背调，产出这批要发的每一封信。
 * 纯函数，不碰数据库 —— 阶段推导与背调读取由调用方完成后传进来。
 */
export function buildStageAwareSequence(input: {
  stageKey: OutreachJourneyStageKey | string | undefined | null;
  maxSteps?: number;
  stepIntervalHours: number;
  sender: OutreachWritingSender;
  recipient: OutreachWritingRecipient;
  research?: OutreachWritingResearch;
  /** 批量/自动方案的冷触达口径，见 planStageSequence */
  coldOnly?: boolean;
}): StageSequenceResult {
  const stageKey = normalizeOutreachStage(input.stageKey);
  const recipient = normalizeOutreachRecipient(input.recipient);
  const plan = planStageSequence(stageKey, input.maxSteps ?? OUTREACH_SEQUENCE_DEFAULT_STEPS, { coldOnly: input.coldOnly });
  const interval = Number.isFinite(input.stepIntervalHours) && input.stepIntervalHours > 0
    ? input.stepIntervalHours
    : 72;

  if (plan.blockedReason) {
    // 角色/依据仍然算出来，界面要能解释「为什么这条被跳过」
    const role = developmentEmailRecipientRole(recipient.contactName, recipient.email);
    return {
      stageKey,
      stageLabel: outreachStageLabel(stageKey),
      steps: [],
      blockedReason: plan.blockedReason,
      evidence: [],
      missing: [],
      roleLabel: role.label
    };
  }

  const steps: OutreachStageSequenceStep[] = [];
  let evidence: string[] = [];
  let missing: string[] = [];
  let roleLabel = "";

  plan.stages.forEach((target, index) => {
    const { brief, draft } = letterForStage(target, input.sender, recipient, input.research);
    // 依据/缺口取第一封的即可：同一批目标的收件人信息与背调是同一份
    if (index === 0) {
      evidence = brief.evidence;
      missing = brief.missing;
      roleLabel = brief.role.label;
    }
    steps.push({
      stageKey: target,
      stageLabel: outreachStageLabel(target),
      delayHours: index === 0 ? 0 : interval * index,
      subject: draft.subject,
      body: draft.body,
      basis: draft.basis
    });
  });

  return {
    stageKey,
    stageLabel: outreachStageLabel(stageKey),
    steps,
    blockedReason: "",
    evidence,
    missing,
    roleLabel
  };
}

/**
 * 一次生成的正文出自谁：固定模板 / AI 模型 / 本机 CLI。
 * 用同一份口径描述，前端才能把「依据」说清楚。
 */
export function outreachLetterEngineLabel(source: string, detail = "") {
  const name = detail.trim() || (source === "cli" ? "本机 CLI" : source === "ai" ? "AI API" : "固定模板");
  return name;
}
