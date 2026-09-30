import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { evaluateProspectEmailOutreachEligibility } from "./prospect-outreach-eligibility.js";
import { englishOnly, developmentEmailAngles } from "./development-email-skill.js";
import type { CrmStore } from "./store.js";
import type {
  Lead,
  ProspectOutreachBatch,
  ProspectOutreachBatchItem,
  ProspectOutreachBatchPolicy,
  ProspectOutreachBatchStep,
  WebsiteOpportunity
} from "./types.js";

export type ProspectOutreachBatchActor = { id: string; teamId: string };

const DEFAULT_POLICY: ProspectOutreachBatchPolicy = {
  dailyLimit: 20,
  stepIntervalHours: 72,
  sendWindowStartHour: 9,
  sendWindowEndHour: 11,
  stopOnReply: true
};

/** 退信熔断阈值：本批次当日已发邮件中退信占比超过该值即自动暂停整批 */
export const BOUNCE_RATE_PAUSE_THRESHOLD = 0.05;

const policyShapeSchema = z.object({
  dailyLimit: z.coerce.number().int().min(1).max(200).default(DEFAULT_POLICY.dailyLimit),
  stepIntervalHours: z.coerce.number().int().min(1).max(24 * 30).default(DEFAULT_POLICY.stepIntervalHours),
  sendWindowStartHour: z.coerce.number().int().min(0).max(23).default(DEFAULT_POLICY.sendWindowStartHour),
  sendWindowEndHour: z.coerce.number().int().min(1).max(24).default(DEFAULT_POLICY.sendWindowEndHour),
  stopOnReply: z.coerce.boolean().default(DEFAULT_POLICY.stopOnReply)
});

const policySchema = policyShapeSchema.refine((value) => value.sendWindowStartHour < value.sendWindowEndHour, {
  message: "发送窗口起点必须早于终点"
});

const createInputSchema = z.object({
  candidateIds: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  /** 发送对象：candidate=搜客候选（默认）；lead=正式线索 */
  targetType: z.enum(["candidate", "lead"]).default("candidate"),
  leadIds: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  policy: policyShapeSchema.partial()
    .refine((value) => (value.sendWindowStartHour ?? DEFAULT_POLICY.sendWindowStartHour) < (value.sendWindowEndHour ?? DEFAULT_POLICY.sendWindowEndHour), {
      message: "发送窗口起点必须早于终点"
    })
    .optional()
}).refine((value) => (value.targetType === "lead" ? (value.leadIds?.length ?? 0) > 0 : (value.candidateIds?.length ?? 0) > 0), {
  message: "请提供要发信的对象列表"
});

function canAccess(batch: ProspectOutreachBatch, user: ProspectOutreachBatchActor) {
  return batch.ownerId === user.id && batch.teamId === user.teamId;
}

/** 线索批次资格：归属 + 未删除 + 未转客户 + 有邮箱；已回复由 stopOnReply 在发送前拦截 */
function evaluateLeadBatchItemEligibility(store: CrmStore, lead: Lead): { ready: boolean; message: string; recipient: string } {
  if (lead.deletedAt) return { ready: false, message: "线索已删除", recipient: "" };
  if (lead.convertedCustomerId) return { ready: false, message: "线索已转客户，不再进入发信批次", recipient: "" };
  const recipient = (lead.email || "").trim();
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { ready: false, message: "该线索还没有可用邮箱，先补全联系方式", recipient: "" };
  }
  return { ready: true, message: "可直接发信", recipient };
}

function recalcCounts(batch: ProspectOutreachBatch) {
  batch.counts = {
    total: batch.items.length,
    frozen: batch.items.filter((item) => item.status === "ready" || isItemFinal(item)).length,
    skipped: batch.items.filter((item) => item.status === "skipped" || item.status === "removed").length
  };
}

function isItemFinal(item: ProspectOutreachBatchItem) {
  return ["sent", "failed", "stopped"].includes(item.status);
}

function isBatchClosed(batch: ProspectOutreachBatch) {
  return batch.items.length > 0 && batch.items.every((item) => isItemFinal(item) || item.status === "skipped" || item.status === "removed");
}

/**
 * 批次序列草稿：≤3 步（首触 + 最多两次跟进），间隔由 policy.stepIntervalHours 决定。
 * 只用候选已有字段，不虚构事实。
 *
 * ⚠️ 语言约束：候选的 `business` 常是中文调研摘要，**绝不能原样拼进英文信**
 * （2026-09-29 真实事故：客户收到的信里夹了一整句中文）。
 * 这里统一走 `englishOnly` 守卫；若中文被拦掉，则改为引用由关键词词典提取出的英文应用角度。
 */
export function prospectBatchStepTemplates(
  candidate: Pick<WebsiteOpportunity, "company" | "business" | "country" | "contact" | "contactInfo">,
  policy: ProspectOutreachBatchPolicy
): Array<{ delayHours: number; subject: string; body: string }> {
  // 含中文时 englishOnly 返回空串：宁可不提，也不把中文发给英文客户。
  const business = englishOnly(candidate.business || "", "");
  const market = englishOnly(candidate.country || "", "your market");
  const angles = developmentEmailAngles(candidate.business, candidate.company);
  const greetingName = candidate.contact && !/待/i.test(candidate.contact) ? candidate.contact : `${candidate.company} team`;
  const anglePhrase = angles.length
    ? angles.slice(0, 2).map((angle) => angle.angle).join(" and ")
    : "";
  const angleKeyword = angles[0]?.keyword || "sourcing from a Chinese supplier";

  return [
    {
      delayHours: 0,
      subject: `Potential cooperation with ${candidate.company}`,
      body: [
        `Dear ${greetingName},`,
        "",
        anglePhrase
          ? `I am reaching out to ${candidate.company} because your work on ${anglePhrase} overlaps with what we supply and support.`
          : business
            ? `I am reaching out to ${candidate.company} regarding ${business}.`
            : `I am reaching out to ${candidate.company} as a potential supply partner for your market.`,
        "We work with overseas buyers on product selection, specifications, certificates, quotations and sample coordination.",
        "",
        "Would it be useful if I sent the specifications most relevant to your line?",
        "",
        "Best regards"
      ].join("\n")
    },
    {
      delayHours: policy.stepIntervalHours,
      subject: `Following up with ${candidate.company}`,
      body: [
        `Dear ${greetingName},`,
        "",
        `Following up once on my previous note to ${candidate.company}. Rather than repeat it, here is one thing I left out:`,
        "",
        angles.length
          ? `on ${angleKeyword}, the deciding factors are usually the operating environment and the certification your market requires. We support both, and can send the specifications that matter for your configuration.`
          : `we can send specifications, lead times and export documents up front, instead of leaving you to ask for them one by one.`,
        "",
        `If it is useful, I will send the two-page summary. If this is not relevant to your plans in ${market}, tell me and I will close the file.`,
        "",
        "Best regards"
      ].join("\n")
    },
    {
      delayHours: policy.stepIntervalHours * 2,
      subject: `Closing the loop on ${candidate.company}`,
      body: [
        `Dear ${greetingName},`,
        "",
        "I have written a couple of times without a reply, so I will keep this one short.",
        `If ${angleKeyword} is on your roadmap, tell me and I will send a quotation. If not, one word back and I will close the file — no hard feelings.`,
        "",
        "Best regards"
      ].join("\n")
    }
  ];
}

/** 纯函数：下一个发送窗口起点（本地时区的小时判断，便于测试） */
export function nextWindowStart(now: Date, policy: ProspectOutreachBatchPolicy): Date {
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  start.setHours(policy.sendWindowStartHour);
  if (now.getHours() >= policy.sendWindowEndHour || now.getHours() < policy.sendWindowStartHour) {
    if (now.getHours() >= policy.sendWindowEndHour) start.setDate(start.getDate() + 1);
    return start;
  }
  return now;
}

/**
 * 只能操作自己的线索 / 候选。
 * ⚠️ 创建、恢复、放行三处必须共用这一套归属校验。曾经只有创建时校验，恢复与放行只按 id 查，
 * 于是"创建时被判无权"的目标点一下「恢复」就变成可发送并成功放行 —— 等于给别人的线索发信（越权发信）。
 */
function findOwnedLead(store: CrmStore, user: ProspectOutreachBatchActor, leadId: string) {
  return store.leads.find((row) => row.id === leadId && row.ownerId === user.id && row.teamId === user.teamId);
}

function findOwnedCandidate(store: CrmStore, user: ProspectOutreachBatchActor, candidateId: string) {
  return store.websiteOpportunities.find((row) => row.id === candidateId && row.ownerId === user.id && row.teamId === user.teamId);
}

function buildItems(
  store: CrmStore,
  user: ProspectOutreachBatchActor,
  candidateIds: string[],
  policy: ProspectOutreachBatchPolicy
): ProspectOutreachBatchItem[] {
  return candidateIds.map((candidateId) => {
    const candidate = findOwnedCandidate(store, user, candidateId);
    if (!candidate) {
      // 找不到不等于"不存在"：同团队但归属别人时候选还在，只是当前账号无权用它发信。
      // 分开表述并回填真实公司名，否则界面只能拿内部 ID 当公司名，用户看不出这是谁。
      const teammateCandidate = store.websiteOpportunities.find((item) => item.id === candidateId && item.teamId === user.teamId);
      return {
        id: `pob_item_${randomUUID()}`,
        candidateId,
        company: teammateCandidate ? teammateCandidate.company : "",
        recipient: "",
        status: "skipped" as const,
        skipReason: teammateCandidate ? "该候选属于其他业务员，你无权用它发信" : "候选已被删除",
        steps: [],
        sentAt: "",
        convertedLeadId: ""
      };
    }
    const eligibility = evaluateProspectEmailOutreachEligibility(store, candidate, new Date().toISOString());
    if (!eligibility.ready || !eligibility.recipient) {
      return {
        id: `pob_item_${randomUUID()}`,
        candidateId,
        company: candidate.company,
        recipient: "",
        status: "skipped" as const,
        skipReason: `${eligibility.label}：${eligibility.message}`,
        steps: [],
        sentAt: "",
        convertedLeadId: ""
      };
    }
    const templates = prospectBatchStepTemplates(candidate, policy);
    let cursor = Date.now();
    const steps = templates.map((template, index): ProspectOutreachBatchStep => {
      cursor += template.delayHours * 3_600_000;
      return {
        index,
        delayHours: template.delayHours,
        subject: template.subject,
        body: template.body,
        status: "pending",
        scheduledAt: new Date(index === 0 ? Date.now() : cursor).toISOString(),
        sentAt: "",
        error: ""
      };
    });
    return {
      id: `pob_item_${randomUUID()}`,
      candidateId,
      company: candidate.company,
      recipient: eligibility.recipient,
      status: "ready" as const,
      skipReason: "",
      steps,
      sentAt: "",
      convertedLeadId: ""
    };
  });
}

/** 线索批次条目构建：复用候选序列模板（Lead 映射到同一形状），资格用轻量校验 */
function buildLeadItems(
  store: CrmStore,
  user: ProspectOutreachBatchActor,
  leadIds: string[],
  policy: ProspectOutreachBatchPolicy
): ProspectOutreachBatchItem[] {
  return leadIds.map((leadId) => {
    const lead = findOwnedLead(store, user, leadId);
    if (!lead) {
      // 同上：同团队但归别人的线索仍然存在，回填公司名 + 明确说清"不是不存在，是没权限"。
      const teammateLead = store.leads.find((item) => item.id === leadId && item.teamId === user.teamId);
      return {
        id: `pob_item_${randomUUID()}`,
        candidateId: leadId,
        leadId,
        company: teammateLead ? teammateLead.company : "",
        recipient: "",
        status: "skipped" as const,
        skipReason: teammateLead ? "该线索属于其他业务员，你无权用它发信" : "线索已被删除",
        steps: [],
        sentAt: "",
        convertedLeadId: ""
      };
    }
    const eligibility = evaluateLeadBatchItemEligibility(store, lead);
    if (!eligibility.ready || !eligibility.recipient) {
      return {
        id: `pob_item_${randomUUID()}`,
        candidateId: leadId,
        leadId,
        company: lead.company,
        recipient: "",
        status: "skipped" as const,
        skipReason: eligibility.message,
        steps: [],
        sentAt: "",
        convertedLeadId: ""
      };
    }
    const templates = prospectBatchStepTemplates({
      company: lead.company,
      business: lead.inquiryContent ? lead.inquiryContent.slice(0, 200) : "",
      country: lead.country,
      contact: lead.contact,
      contactInfo: lead.email
    }, policy);
    let cursor = Date.now();
    const steps = templates.map((template, index): ProspectOutreachBatchStep => {
      cursor += template.delayHours * 3_600_000;
      return {
        index,
        delayHours: template.delayHours,
        subject: template.subject,
        body: template.body,
        status: "pending",
        scheduledAt: new Date(index === 0 ? Date.now() : cursor).toISOString(),
        sentAt: "",
        error: ""
      };
    });
    return {
      id: `pob_item_${randomUUID()}`,
      candidateId: leadId,
      leadId,
      company: lead.company,
      recipient: eligibility.recipient,
      status: "ready" as const,
      skipReason: "",
      steps,
      sentAt: "",
      convertedLeadId: ""
    };
  });
}

export async function createProspectOutreachBatch(
  store: CrmStore,
  user: ProspectOutreachBatchActor,
  rawInput: Record<string, unknown>
) {
  const input = createInputSchema.parse(rawInput);
  const policy: ProspectOutreachBatchPolicy = { ...DEFAULT_POLICY, ...(input.policy || {}) };
  const targetType = input.targetType || "candidate";
  const items = targetType === "lead"
    ? buildLeadItems(store, user, input.leadIds || [], policy)
    : buildItems(store, user, input.candidateIds || [], policy);
  const now = new Date().toISOString();
  const batch: ProspectOutreachBatch = {
    id: `pob_${randomUUID()}`,
    ownerId: user.id,
    teamId: user.teamId,
    status: "draft",
    targetType,
    policy,
    items,
    counts: { total: items.length, frozen: 0, skipped: 0 },
    frozenPayload: null,
    frozenHash: "",
    approvedBy: "",
    approvedAt: "",
    pauseReason: "",
    nextSendAt: "",
    createdAt: now,
    updatedAt: now
  };
  recalcCounts(batch);
  store.prospectOutreachBatches.unshift(batch);
  await store.persist();
  return batch;
}

export function listProspectOutreachBatches(store: CrmStore, user: ProspectOutreachBatchActor, limit = 20) {
  return store.prospectOutreachBatches
    .filter((item) => canAccess(item, user))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export function getProspectOutreachBatch(store: CrmStore, user: ProspectOutreachBatchActor, id: string) {
  const batch = store.prospectOutreachBatches.find((item) => item.id === id && canAccess(item, user));
  if (!batch) throw new Error("发信批次不存在或无权访问");
  return batch;
}

/** 删除批次：仅草稿或已取消批次可删，放行过/进行中的一律拒绝。 */
export async function deleteProspectOutreachBatch(store: CrmStore, user: ProspectOutreachBatchActor, id: string) {
  const batch = getProspectOutreachBatch(store, user, id);
  if (batch.status !== "draft" && batch.status !== "cancelled") {
    throw Object.assign(new Error("仅草稿或已取消的批次可以删除"), { statusCode: 409 });
  }
  store.prospectOutreachBatches = store.prospectOutreachBatches.filter((item) => item.id !== batch.id);
  await store.persist();
  return batch;
}

/**
 * 冻结放行：重算 item 集合 → 写 frozenPayload + frozenHash → status=approved。
 * 冻结后 items 不可再改（updateBatchItem 对非 draft 返回 409）。
 */
export async function approveProspectOutreachBatch(
  store: CrmStore,
  user: ProspectOutreachBatchActor,
  id: string
) {
  const batch = getProspectOutreachBatch(store, user, id);
  if (batch.status === "cancelled") throw Object.assign(new Error("已取消的批次不能放行，请重建批次"), { statusCode: 409 });
  if (batch.status !== "draft") throw Object.assign(new Error("该批次已放行或已结束"), { statusCode: 409 });
  // 重算：放行时再次评估资格，资格已失效的从冻结快照中剔除
  for (const item of batch.items) {
    if (item.status !== "ready") continue;
    if (batch.targetType === "lead") {
      const lead = findOwnedLead(store, user, item.leadId || "");
      const leadCheck = lead ? evaluateLeadBatchItemEligibility(store, lead) : null;
      if (!leadCheck?.ready || !leadCheck.recipient) {
        item.status = "skipped";
        item.skipReason = `放行复核未通过：${leadCheck?.message || "线索不存在或不属于你"}`;
      } else if (leadCheck.recipient !== item.recipient) {
        item.recipient = leadCheck.recipient;
      }
      continue;
    }
    const candidate = findOwnedCandidate(store, user, item.candidateId || "");
    const eligibility = candidate
      ? evaluateProspectEmailOutreachEligibility(store, candidate, new Date().toISOString())
      : null;
    if (!eligibility?.ready || !eligibility.recipient) {
      item.status = "skipped";
      item.skipReason = `放行复核未通过：${eligibility?.message || "候选不存在或不属于你"}`;
    } else if (eligibility.recipient !== item.recipient) {
      item.recipient = eligibility.recipient;
    }
  }
  const frozenItems = batch.items.filter((item) => item.status === "ready");
  if (!frozenItems.length) throw Object.assign(new Error("批次内没有可发送的候选，无法放行"), { statusCode: 409 });
  const now = new Date();
  batch.frozenPayload = {
    approvedAt: now.toISOString(),
    approvedBy: user.id,
    items: frozenItems.map((item) => ({
      itemId: item.id,
      candidateId: item.candidateId,
      recipient: item.recipient,
      steps: item.steps.map((step) => ({ index: step.index, subject: step.subject, body: step.body }))
    }))
  };
  batch.frozenHash = createHash("sha256")
    .update(JSON.stringify({ policy: batch.policy, payload: batch.frozenPayload }))
    .digest("hex");
  batch.approvedBy = user.id;
  batch.approvedAt = now.toISOString();
  batch.status = "approved";
  batch.nextSendAt = nextWindowStart(now, batch.policy).toISOString();
  batch.pauseReason = "";
  recalcCounts(batch);
  batch.updatedAt = now.toISOString();
  store.logs.unshift({
    id: `log_pob_${user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    level: "success",
    category: "system",
    action: "prospect_outreach_batch_approved",
    message: `发信批次已冻结放行：${frozenItems.length} 封（哈希 ${batch.frozenHash.slice(0, 12)}…）`,
    actorId: user.id,
    actorName: user.id,
    meta: {
      batchId: batch.id,
      frozenHash: batch.frozenHash,
      frozenCount: frozenItems.length,
      skippedCount: batch.counts.skipped
    },
    createdAt: now.toISOString(),
    ownerId: user.id,
    teamId: user.teamId
  });
  await store.persist();
  return batch;
}

/** 单个移除/恢复：只有 draft 批次可改；冻结后改动返回 409 */
export async function updateProspectOutreachBatchItem(
  store: CrmStore,
  user: ProspectOutreachBatchActor,
  id: string,
  itemId: string,
  action: "remove" | "restore" | "edit",
  payload?: { stepIndex: number; subject: string; body: string }
) {
  const batch = getProspectOutreachBatch(store, user, id);
  if (batch.status !== "draft") {
    throw Object.assign(new Error("批次已冻结，不可再改动；如需调整请取消后重建"), { statusCode: 409 });
  }
  const item = batch.items.find((row) => row.id === itemId);
  if (!item) throw new Error("批次项不存在");
  if (action === "edit") {
    if (item.status !== "ready") throw new Error("只有待发送项可以编辑内容");
    const step = item.steps.find((row) => row.index === payload?.stepIndex);
    if (!step) throw new Error("编辑的步骤不存在");
    if (step.status !== "pending") throw Object.assign(new Error("该步骤已投递或已结束，不可编辑"), { statusCode: 409 });
    const subject = String(payload?.subject || "").trim();
    const body = String(payload?.body || "").trim();
    if (!subject || subject.length > 160) throw Object.assign(new Error("主题需 1-160 字"), { statusCode: 400 });
    if (!body || body.length < 10 || body.length > 6000) throw Object.assign(new Error("正文需 10-6000 字"), { statusCode: 400 });
    step.subject = subject;
    step.body = body;
    recalcCounts(batch);
    await store.persist();
    return { batch };
  }
  if (action === "remove") {
    // 被跳过的项（不属于你 / 线索已删除 / 没邮箱）以前既发不出去、又清理不掉，只能整批取消。
    // 允许 remove 给一条出路；removed 仍可再 restore，不会丢数据。
    if (item.status !== "ready" && item.status !== "skipped") throw new Error("只有待发送或被跳过的项可以移除");
    item.status = "removed";
    item.skipReason = "用户勾选移除";
  } else {
    if (item.status !== "removed" && item.status !== "skipped") throw new Error("只有被移除或被跳过的项可以恢复");
    if (batch.targetType === "lead") {
      const lead = findOwnedLead(store, user, item.leadId || "");
      const leadCheck = lead ? evaluateLeadBatchItemEligibility(store, lead) : null;
      if (!leadCheck?.ready || !leadCheck.recipient) {
        item.status = "skipped";
        item.skipReason = `恢复复核未通过：${leadCheck?.message || "线索不存在或不属于你"}`;
      } else {
        if (!item.steps.length) {
          const templates = prospectBatchStepTemplates({
            company: lead!.company,
            business: lead!.inquiryContent ? lead!.inquiryContent.slice(0, 200) : "",
            country: lead!.country,
            contact: lead!.contact,
            contactInfo: lead!.email
          }, batch.policy);
          let cursor = Date.now();
          item.steps = templates.map((template, index): ProspectOutreachBatchStep => {
            cursor += template.delayHours * 3_600_000;
            return {
              index,
              delayHours: template.delayHours,
              subject: template.subject,
              body: template.body,
              status: "pending",
              scheduledAt: new Date(index === 0 ? Date.now() : cursor).toISOString(),
              sentAt: "",
              error: ""
            };
          });
        }
        item.recipient = leadCheck.recipient;
        item.status = "ready";
        item.skipReason = "";
      }
    } else {
    const candidate = findOwnedCandidate(store, user, item.candidateId || "");
    const eligibility = candidate
      ? evaluateProspectEmailOutreachEligibility(store, candidate, new Date().toISOString())
      : null;
    if (!eligibility?.ready || !eligibility.recipient) {
      item.status = "skipped";
      item.skipReason = `恢复复核未通过：${eligibility?.message || "候选不存在或不属于你"}`;
    } else {
      if (!item.steps.length) {
        const templates = prospectBatchStepTemplates(candidate!, batch.policy);
        let cursor = Date.now();
        item.steps = templates.map((template, index): ProspectOutreachBatchStep => {
          cursor += template.delayHours * 3_600_000;
          return {
            index,
            delayHours: template.delayHours,
            subject: template.subject,
            body: template.body,
            status: "pending",
            scheduledAt: new Date(index === 0 ? Date.now() : cursor).toISOString(),
            sentAt: "",
            error: ""
          };
        });
      }
      item.recipient = eligibility.recipient;
      item.status = "ready";
      item.skipReason = "";
    }
    }
  }
  recalcCounts(batch);
  batch.updatedAt = new Date().toISOString();
  await store.persist();
  return { batch, item };
}

export async function controlProspectOutreachBatch(
  store: CrmStore,
  user: ProspectOutreachBatchActor,
  id: string,
  action: "pause" | "resume" | "cancel"
) {
  const batch = getProspectOutreachBatch(store, user, id);
  if (action === "pause") {
    if (batch.status !== "approved") throw new Error("只有运行中的批次可以暂停");
    batch.status = "paused";
    batch.pauseReason = "用户暂停";
  } else if (action === "resume") {
    if (batch.status !== "paused") throw new Error("只有暂停的批次可以继续");
    batch.status = "approved";
    batch.pauseReason = "";
  } else {
    if (batch.status === "cancelled") throw new Error("该批次已取消");
    batch.status = "cancelled";
    batch.pauseReason = "用户取消";
    batch.items.forEach((item) => {
      item.steps.forEach((step) => { if (step.status === "pending") step.status = "skipped"; });
    });
  }
  batch.updatedAt = new Date().toISOString();
  await store.persist();
  return batch;
}

export interface ProspectOutreachBatchRuntime {
  /** 真实发一封：资格复核 + 投递 + 触点登记。抛错视为本步失败。 */
  send(batch: ProspectOutreachBatch, item: ProspectOutreachBatchItem, step: ProspectOutreachBatchStep, executionId: string): Promise<{ recipient: string; sentAt: string; messageId: string }>;
  /** 发送成功的候选自动转线索，返回 leadId（失败抛错，只影响该 item） */
  convertToLead(batch: ProspectOutreachBatch, item: ProspectOutreachBatchItem): Promise<string>;
  /** 该 owner 当日（自然日）已发信总数（含本批与其他通道），用于每日上限 */
  sentCountToday(batch: ProspectOutreachBatch): Promise<number>;
  /** 本批次当日已发邮件中的退信数，用于退信熔断 */
  bouncedCountForBatch(batch: ProspectOutreachBatch): Promise<number>;
}

export class ProspectOutreachBatchRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly store: CrmStore,
    private readonly runtime: ProspectOutreachBatchRuntime,
    private readonly pollMs = 10_000
  ) {}

  start() {
    this.timer = setInterval(() => void this.synchronize(), this.pollMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async synchronize() {
    if (this.busy) return;
    this.busy = true;
    try {
      const batch = this.store.prospectOutreachBatches
        .filter((item) => item.status === "approved" && item.frozenPayload)
        .sort((left, right) => (left.nextSendAt || "").localeCompare(right.nextSendAt || ""))[0];
      if (!batch) return;
      const now = new Date();
      // 发送窗口
      if (now.getHours() < batch.policy.sendWindowStartHour || now.getHours() >= batch.policy.sendWindowEndHour) {
        batch.nextSendAt = nextWindowStart(now, batch.policy).toISOString();
        return;
      }
      if ((batch.nextSendAt || "") && now.toISOString() < batch.nextSendAt) return;
      // 退信熔断
      const sentToday = await this.runtime.sentCountToday(batch);
      const bounced = await this.runtime.bouncedCountForBatch(batch);
      if (sentToday > 0 && bounced / sentToday > BOUNCE_RATE_PAUSE_THRESHOLD) {
        batch.status = "paused";
        batch.pauseReason = `退信熔断：本批次已发送 ${sentToday} 封中退信 ${bounced} 封，超过 ${(BOUNCE_RATE_PAUSE_THRESHOLD * 100).toFixed(0)}% 阈值，已自动暂停`;
        batch.updatedAt = now.toISOString();
        await this.store.persist();
        return;
      }
      // 每日上限
      if (sentToday >= batch.policy.dailyLimit) {
        const tomorrow = nextWindowStart(new Date(now.getTime() + 86_400_000), batch.policy);
        batch.nextSendAt = tomorrow.toISOString();
        await this.store.persist();
        return;
      }
      const pending = this.pickNextItem(batch, now);
      if (!pending) {
        if (isBatchClosed(batch)) {
          batch.status = "completed";
          batch.nextSendAt = "";
          batch.updatedAt = now.toISOString();
          await this.store.persist();
        }
        return;
      }
      await this.sendItemStep(batch, pending.item, pending.step);
    } finally {
      this.busy = false;
    }
  }

  private pickNextItem(batch: ProspectOutreachBatch, now: Date) {
    for (const item of batch.items) {
      if (item.status !== "ready") continue;
      const step = item.steps.find((row) => row.status === "pending");
      if (!step) continue;
      if (step.scheduledAt && step.scheduledAt > now.toISOString()) continue;
      if (batch.targetType === "lead") {
        const lead = this.store.leads.find((row) => row.id === item.leadId);
        if (!lead || lead.deletedAt) {
          item.steps.forEach((row) => { if (row.status === "pending") row.status = "skipped"; });
          item.status = "stopped";
          item.skipReason = "线索不存在或已删除";
          continue;
        }
        if (batch.policy.stopOnReply && lead.lastEmailReplyAt) {
          item.steps.forEach((row) => { if (row.status === "pending") row.status = "skipped"; });
          item.status = "stopped";
          item.skipReason = "线索已回复，stopOnReply 策略停止剩余步骤";
          continue;
        }
        return { item, step };
      }
      // stopOnReply：候选已回复则停止该候选剩余步骤
      const candidate = this.store.websiteOpportunities.find((row) => row.id === item.candidateId);
      const stopReason = shouldStopItemOnReply(this.store, item, candidate, batch.policy.stopOnReply);
      if (stopReason) {
        item.steps.forEach((row) => { if (row.status === "pending") row.status = "skipped"; });
        item.status = "stopped";
        item.skipReason = stopReason;
        continue;
      }
      // 发送前的资格硬校验由 runtime.send 内部 assertProspectEmailOutreachEligible 兜底
      return { item, step };
    }
    return null;
  }

  private async sendItemStep(batch: ProspectOutreachBatch, item: ProspectOutreachBatchItem, step: ProspectOutreachBatchStep) {
    const nowIso = new Date().toISOString();
    item.status = "sending";
    step.status = "sending";
    batch.updatedAt = nowIso;
    try {
      const result = await this.runtime.send(batch, item, step, `batch:${batch.id}:${item.id}:${step.index}`);
      step.status = "sent";
      step.sentAt = result.sentAt;
      step.error = "";
      item.recipient = result.recipient;
      const hasPending = item.steps.some((row) => row.status === "pending");
      if (!hasPending) {
        item.status = "sent";
        item.sentAt = result.sentAt;
        try {
          item.convertedLeadId = await this.runtime.convertToLead(batch, item);
        } catch (error) {
          // 转线索失败不回滚发信，只记录原因
          item.convertedLeadId = "";
          item.skipReason = `已发送但自动转线索失败：${error instanceof Error ? error.message : "未知错误"}`;
        }
      } else {
        item.status = "ready";
      }
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : "发送失败";
      item.status = "failed";
    }
    batch.nextSendAt = nextWindowStart(new Date(), batch.policy).toISOString();
    if (isBatchClosed(batch)) {
      batch.status = "completed";
      batch.nextSendAt = "";
    }
    batch.updatedAt = new Date().toISOString();
    await this.store.persist();
  }
}

/** stopOnReply / 发送前资格复核由 runtime.send 与 pickNextItem 前置检查共同保证 */
export function shouldStopItemOnReply(
  store: CrmStore,
  item: ProspectOutreachBatchItem,
  candidate: WebsiteOpportunity | undefined,
  stopOnReply: boolean
): string {
  if (!stopOnReply) return "";
  const replied = candidate?.lastReplyClassification
    || store.prospectTouchpoints.some((touchpoint) =>
      touchpoint.prospectCandidateId === item.candidateId
      && (touchpoint.direction === "inbound" || touchpoint.eventType === "reply")
    );
  return replied ? "候选已回复，stopOnReply 策略停止剩余步骤" : "";
}
