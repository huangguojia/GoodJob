import { randomUUID } from "node:crypto";
import { z } from "zod";
import { evaluateProspectEmailOutreachEligibility } from "./prospect-outreach-eligibility.js";
import {
  nextWindowStart,
  prospectBatchStepTemplates,
  shouldStopItemOnReply,
  type ProspectOutreachBatchRuntime
} from "./prospect-outreach-batch.js";
import type { CrmStore } from "./store.js";
import type {
  ProspectOutreachBatch,
  ProspectOutreachBatchItem,
  ProspectOutreachPlan,
  ProspectOutreachPlanEntry,
  ProspectOutreachPlanStatus,
  WebsiteOpportunity
} from "./types.js";

// ---------------------------------------------------------------------------
// 自动发送方案：一个长期运行的后台任务。配置目标筛选（国家/关键词/人数上限）
// 与发送频率（每日上限/步间隔/窗口/回复即停），后台线程按节奏持续从候选池
// 取人 → 按序列投递 → 转线索回流。方案可随时暂停/继续/停止，进度与每一步
// 发送结果全部落在 plan.items 上，前端可直接展示。
// ---------------------------------------------------------------------------

export type ProspectOutreachPlanActor = { id: string; teamId: string };

const PLAN_DEFAULT_POLICY = {
  dailyLimit: 20,
  stepIntervalHours: 72,
  sendWindowStartHour: 9,
  sendWindowEndHour: 18,
  stopOnReply: true,
  rotateMailboxEvery: 0
};

const planEntrySchema = z.object({
  entityType: z.enum(["candidate", "lead", "customer"]),
  entityId: z.string().trim().min(1).max(80)
});

const planCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  target: z.object({
    countries: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    keyword: z.string().trim().max(120).default(""),
    maxTargets: z.coerce.number().int().min(1).max(500).default(50),
    mode: z.enum(["rules", "manual"]).default("rules"),
    entries: z.array(planEntrySchema).max(500).default([])
  }).default({ countries: [], keyword: "", maxTargets: 50, mode: "rules", entries: [] }),
  policy: z.object({
    dailyLimit: z.coerce.number().int().min(1).max(200).default(PLAN_DEFAULT_POLICY.dailyLimit),
    stepIntervalHours: z.coerce.number().int().min(1).max(24 * 30).default(PLAN_DEFAULT_POLICY.stepIntervalHours),
    sendWindowStartHour: z.coerce.number().int().min(0).max(23).default(PLAN_DEFAULT_POLICY.sendWindowStartHour),
    sendWindowEndHour: z.coerce.number().int().min(1).max(24).default(PLAN_DEFAULT_POLICY.sendWindowEndHour),
    stopOnReply: z.coerce.boolean().default(PLAN_DEFAULT_POLICY.stopOnReply),
    // 每 N 封切换发件邮箱池里的下一个邮箱；0 = 不轮换（只用主发件邮箱）
    rotateMailboxEvery: z.coerce.number().int().min(0).max(1000).default(0)
  }).refine((value) => value.sendWindowStartHour < value.sendWindowEndHour, {
    message: "发送窗口起点必须早于终点"
  }).default(PLAN_DEFAULT_POLICY),
  // 自定义每步内容：给了就按这个发（占位符 {{company}}/{{contact}}/{{country}}），不给用系统默认模板
  steps: z.array(z.object({
    subject: z.string().trim().min(1, "邮件主题不能为空").max(300),
    body: z.string().trim().min(1, "邮件正文不能为空").max(20000)
  })).min(1).max(10).optional()
}).refine((value) => value.target.mode !== "manual" || value.target.entries.length > 0, {
  message: "手动名单模式至少勾选一个目标"
});

/** 手动名单条目解析结果（找不到/无权 = null，由调用方落跳过占位） */
function resolvePlanEntry(
  store: CrmStore,
  actor: ProspectOutreachPlanActor,
  entry: ProspectOutreachPlanEntry
): { company: string; contact: string; country: string; business: string; email: string } | null {
  if (entry.entityType === "lead") {
    const lead = store.leads.find((row) => row.id === entry.entityId && row.ownerId === actor.id && row.teamId === actor.teamId);
    if (!lead) return null;
    return { company: lead.company, contact: lead.contact, country: lead.country || "", business: lead.remark || "", email: (lead.email || "").trim() };
  }
  if (entry.entityType === "customer") {
    const customer = store.customers.find((row) => row.id === entry.entityId && row.ownerId === actor.id && row.teamId === actor.teamId);
    if (!customer) return null;
    return { company: customer.company, contact: customer.contact, country: customer.country || "", business: customer.otherNotes || "", email: (customer.email || "").trim() };
  }
  const candidate = store.websiteOpportunities.find((row) => row.id === entry.entityId && row.ownerId === actor.id && row.teamId === actor.teamId);
  if (!candidate) return null;
  return { company: candidate.company, contact: candidate.contact, country: candidate.country || "", business: candidate.business || "", email: (candidate.contactInfo || "").trim() };
}

/** 自定义步骤内容渲染：替换 {{company}} {{contact}} {{country}} 占位（未知占位原样保留，便于发现拼写问题） */
export function renderPlanStepContent(text: string, entity: { company: string; contact: string; country: string }) {
  return text
    .replace(/\{\{\s*company\s*\}\}/g, entity.company || "your company")
    .replace(/\{\{\s*contact\s*\}\}/g, entity.contact || "there")
    .replace(/\{\{\s*country\s*\}\}/g, entity.country || "your market");
}

function canAccess(plan: ProspectOutreachPlan, user: ProspectOutreachPlanActor) {
  return plan.ownerId === user.id && plan.teamId === user.teamId;
}

function isItemFinal(item: ProspectOutreachBatchItem) {
  return ["sent", "failed", "stopped", "skipped", "removed"].includes(item.status);
}

export function planProgress(plan: ProspectOutreachPlan) {
  const items = plan.items || [];
  const pendingSteps = items.reduce((sum, item) =>
    sum + (item.status === "ready" || item.status === "sending"
      ? item.steps.filter((step) => step.status === "pending" || step.status === "sending").length
      : 0), 0);
  // 「已发 N 封」按信计数（步骤级），而不是等整个序列走完才 +1——否则多步序列跑到一半界面永远显示已发 0
  const sentSteps = items.reduce((sum, item) =>
    sum + item.steps.filter((step) => step.status === "sent").length, 0);
  return {
    total: items.length,
    sent: items.filter((item) => item.status === "sent").length,
    sentSteps,
    failed: items.filter((item) => item.status === "failed").length,
    stopped: items.filter((item) => item.status === "stopped").length,
    skipped: items.filter((item) => item.status === "skipped" || item.status === "removed").length,
    inProgress: items.filter((item) => item.status === "ready" || item.status === "sending").length,
    converted: items.filter((item) => item.convertedLeadId).length,
    pendingSteps,
    targetCap: plan.target.maxTargets
  };
}

/** 方案目标筛选匹配（纯函数，供预览与取人共用） */
export function planCandidateMatches(
  store: CrmStore,
  user: ProspectOutreachPlanActor,
  target: ProspectOutreachPlan["target"],
  excludeIds: Set<string> = new Set()
): WebsiteOpportunity[] {
  const keyword = target.keyword.trim().toLowerCase();
  const countries = new Set(target.countries.map((row) => row.trim().toLowerCase()).filter(Boolean));
  return store.websiteOpportunities.filter((candidate) => {
    if (candidate.ownerId !== user.id || candidate.teamId !== user.teamId) return false;
    if (excludeIds.has(candidate.id)) return false;
    if (countries.size && !countries.has((candidate.country || "").trim().toLowerCase())) return false;
    if (keyword) {
      const haystack = [candidate.company, candidate.business, candidate.country]
        .join(" ").toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

/** 创建方案（立即启动）：只做配置登记，实际取人与投递由后台线程执行 */
export async function createProspectOutreachPlan(
  store: CrmStore,
  user: ProspectOutreachPlanActor,
  rawInput: Record<string, unknown>
) {
  const input = planCreateSchema.parse(rawInput);
  const now = new Date().toISOString();
  // 手动名单模式：上限 = 名单长度（每个勾选目标都会获得一个条目，含跳过占位）
  const manual = input.target.mode === "manual";
  const maxTargets = manual ? input.target.entries.length : input.target.maxTargets;
  const plan: ProspectOutreachPlan = {
    id: `pop_${randomUUID()}`,
    ownerId: user.id,
    teamId: user.teamId,
    name: input.name,
    target: {
      countries: manual ? [] : input.target.countries,
      keyword: manual ? "" : input.target.keyword,
      maxTargets,
      mode: input.target.mode,
      entries: manual ? input.target.entries : []
    },
    policy: { ...PLAN_DEFAULT_POLICY, ...input.policy },
    ...(input.steps?.length ? { steps: input.steps.map((step) => ({ subject: step.subject, body: step.body })) } : {}),
    items: [],
    status: "running",
    pauseReason: "",
    nextRunAt: now,
    lastRunAt: "",
    lastMessage: "方案已启动，等待后台线程开始处理",
    createdAt: now,
    updatedAt: now
  };
  store.prospectOutreachPlans.unshift(plan);
  await store.persist();
  return plan;
}

export function listProspectOutreachPlans(store: CrmStore, user: ProspectOutreachPlanActor, limit = 50) {
  return store.prospectOutreachPlans
    .filter((plan) => canAccess(plan, user))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, Math.min(200, limit)));
}

export function getProspectOutreachPlan(store: CrmStore, user: ProspectOutreachPlanActor, id: string) {
  const plan = store.prospectOutreachPlans.find((item) => item.id === id && canAccess(item, user));
  if (!plan) throw new Error("发送方案不存在或无权访问");
  return plan;
}

export async function controlProspectOutreachPlan(
  store: CrmStore,
  user: ProspectOutreachPlanActor,
  id: string,
  action: "pause" | "resume" | "stop"
) {
  const plan = getProspectOutreachPlan(store, user, id);
  if (action === "pause") {
    if (plan.status !== "running") throw Object.assign(new Error("只有运行中的方案可以暂停"), { statusCode: 409 });
    plan.status = "paused";
    plan.pauseReason = "用户暂停";
    plan.lastMessage = "方案已暂停，剩余目标等待继续";
  } else if (action === "resume") {
    if (plan.status !== "paused") throw Object.assign(new Error("只有暂停中的方案可以继续"), { statusCode: 409 });
    plan.status = "running";
    plan.pauseReason = "";
    plan.nextRunAt = new Date().toISOString();
    plan.lastMessage = "方案已恢复运行";
  } else {
    if (plan.status === "stopped" || plan.status === "completed") {
      throw Object.assign(new Error("该方案已结束"), { statusCode: 409 });
    }
    plan.status = "stopped";
    plan.pauseReason = "用户停止";
    plan.items.forEach((item) => {
      item.steps.forEach((step) => { if (step.status === "pending") step.status = "skipped"; });
      if (item.status === "ready" || item.status === "sending") item.status = "stopped";
    });
    plan.lastMessage = "方案已被用户停止，未发送的步骤全部跳过";
  }
  plan.updatedAt = new Date().toISOString();
  await store.persist();
  return plan;
}

export async function deleteProspectOutreachPlan(store: CrmStore, user: ProspectOutreachPlanActor, id: string) {
  const plan = getProspectOutreachPlan(store, user, id);
  if (plan.status === "running" || plan.status === "paused") {
    throw Object.assign(new Error("运行中/暂停中的方案不能删除，请先停止"), { statusCode: 409 });
  }
  store.prospectOutreachPlans = store.prospectOutreachPlans.filter((item) => item.id !== plan.id);
  await store.persist();
  return plan;
}

/** 方案视图 → 批次形状（复用共享发送 runtime；runtime 只用这几个字段） */
function planAsBatch(plan: ProspectOutreachPlan): ProspectOutreachBatch {
  return {
    id: plan.id,
    ownerId: plan.ownerId,
    teamId: plan.teamId,
    status: "approved",
    targetType: "candidate",
    policy: plan.policy,
    items: plan.items,
    counts: { total: plan.items.length, frozen: plan.items.length, skipped: 0 },
    frozenPayload: null,
    frozenHash: "",
    approvedBy: plan.ownerId,
    approvedAt: plan.createdAt,
    pauseReason: "",
    nextSendAt: plan.nextRunAt,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt
  };
}

/**
 * 方案后台线程：每个 tick 处理一个动作（发一步 / 入场一个新人），
 * 与批次 Runner 相同的保守节奏。调度顺序：
 *   1) 发送窗口 / 每日上限 / 退信熔断检查
 *   2) 续发：已入场目标的下一个到期步骤（回复停发、资格失效自动终止该目标）
 *   3) 入场：目标未满额时从候选池取下一个合格新人，生成序列并立即发第一步
 *   4) 终态判定：目标池取尽 + 全部终态 → completed；到达人数上限且全部终态 → completed
 */
export class ProspectOutreachPlanRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly store: CrmStore,
    private readonly runtime: ProspectOutreachBatchRuntime,
    private readonly pollMs = 15_000
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
      const plans = this.store.prospectOutreachPlans.filter((plan) => plan.status === "running");
      // TEMP-PROBE 2026-09-29: 排查自动方案后台线程为何不执行（用完即删）
      console.log(`[probe-plan] tick total=${this.store.prospectOutreachPlans.length} running=${plans.length} at=${new Date().toISOString()}`);
      for (const plan of plans) {
        try {
          await this.tick(plan);
        } catch (error) {
          plan.lastMessage = `后台处理异常：${error instanceof Error ? error.message : String(error)}`;
          plan.updatedAt = new Date().toISOString();
          await this.store.persist();
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async tick(plan: ProspectOutreachPlan) {
    const now = new Date();
    const nowIso = now.toISOString();
    // 1) 发送窗口
    if (now.getHours() < plan.policy.sendWindowStartHour || now.getHours() >= plan.policy.sendWindowEndHour) {
      plan.nextRunAt = nextWindowStart(now, plan.policy).toISOString();
      plan.lastMessage = `等待发送窗口（每日 ${plan.policy.sendWindowStartHour}:00–${plan.policy.sendWindowEndHour}:00）`;
      plan.updatedAt = nowIso;
      await this.store.persist();
      return;
    }
    if ((plan.nextRunAt || "") && nowIso < plan.nextRunAt) return;
    // 2) 每日上限（owner 全局口径，与批次一致）
    const sentToday = await this.runtime.sentCountToday(planAsBatch(plan));
    if (sentToday >= plan.policy.dailyLimit) {
      const tomorrow = nextWindowStart(new Date(now.getTime() + 86_400_000), plan.policy);
      plan.nextRunAt = tomorrow.toISOString();
      plan.lastMessage = `今日已发 ${sentToday} 封，达到每日上限 ${plan.policy.dailyLimit}，明早继续`;
      plan.updatedAt = nowIso;
      await this.store.persist();
      return;
    }
    // 3) 退信熔断
    const bounced = await this.runtime.bouncedCountForBatch(planAsBatch(plan));
    if (sentToday > 0 && bounced / sentToday > 0.05) {
      plan.status = "paused";
      plan.pauseReason = `退信熔断：今日已发 ${sentToday} 封中退信 ${bounced} 封，超过 5% 阈值，已自动暂停`;
      plan.lastMessage = plan.pauseReason;
      plan.updatedAt = nowIso;
      await this.store.persist();
      return;
    }
    // 4) 续发已入场目标的到期步骤
    const pending = this.pickNextPending(plan, now);
    if (pending) {
      await this.sendStep(plan, pending.item, pending.step);
      return;
    }
    // 5) 入场新人（规则模式从候选池筛选；手动名单模式按勾选名单逐个入场）
    if (plan.items.length >= plan.target.maxTargets) {
      if (plan.items.every(isItemFinal)) {
        plan.status = "completed";
        plan.nextRunAt = "";
        plan.lastMessage = `已达到目标人数上限（${plan.target.maxTargets}）且全部处理完成，方案完成`;
      } else {
        plan.lastMessage = `已达目标人数上限（${plan.target.maxTargets}），等待剩余步骤投递完成`;
      }
      plan.updatedAt = nowIso;
      await this.store.persist();
      return;
    }
    if (plan.target.mode === "manual") {
      await this.admitFromManualEntries(plan, nowIso);
      return;
    }
    await this.admitFromCandidatePool(plan, nowIso);
  }

  /** 规则模式：从候选池按国家/关键词取下一个合格新人（原入场逻辑） */
  private async admitFromCandidatePool(plan: ProspectOutreachPlan, nowIso: string) {
    const now = new Date();
    const actor = { id: plan.ownerId, teamId: plan.teamId };
    const excludeIds = new Set(plan.items.map((item) => item.candidateId));
    const candidates = planCandidateMatches(this.store, actor, plan.target, excludeIds);
    if (!candidates.length) {
      if (plan.items.length > 0 && plan.items.every(isItemFinal)) {
        plan.status = "completed";
        plan.nextRunAt = "";
        plan.lastMessage = "候选池中符合条件的目标已全部处理完成，方案完成";
      } else if (plan.items.length === 0) {
        plan.lastMessage = "候选池暂无符合条件的新目标，持续等待新候选";
      } else {
        plan.lastMessage = "候选池暂无新目标，等待剩余步骤投递完成";
      }
      plan.updatedAt = nowIso;
      await this.store.persist();
      return;
    }
    const candidate = candidates[0];
    const eligibility = evaluateProspectEmailOutreachEligibility(this.store, candidate, nowIso);
    if (!eligibility.ready || !eligibility.recipient) {
      // 不合格占位（防重复取同一候选），下一个 tick 再取下一个人
      plan.items.push({
        id: `pop_item_${randomUUID()}`,
        candidateId: candidate.id,
        company: candidate.company,
        recipient: "",
        status: "skipped",
        skipReason: `${eligibility.label}：${eligibility.message}`,
        steps: [],
        sentAt: "",
        convertedLeadId: ""
      });
      plan.lastMessage = `跳过 ${candidate.company}（${eligibility.message}），继续取下一个目标`;
      plan.updatedAt = nowIso;
      await this.store.persist();
      return;
    }
    const templates = prospectBatchStepTemplates(candidate, plan.policy);
    const steps = templates.map((template, index) => ({
      index,
      delayHours: template.delayHours,
      subject: template.subject,
      body: template.body,
      status: "pending" as const,
      scheduledAt: new Date(index === 0 ? now.getTime() : now.getTime() + template.delayHours * 3_600_000).toISOString(),
      sentAt: "",
      error: ""
    }));
    const item: ProspectOutreachBatchItem = {
      id: `pop_item_${randomUUID()}`,
      candidateId: candidate.id,
      company: candidate.company,
      recipient: eligibility.recipient,
      status: "ready",
      skipReason: "",
      steps,
      sentAt: "",
      convertedLeadId: ""
    };
    plan.items.push(item);
    plan.updatedAt = nowIso;
    await this.store.persist();
    await this.sendStep(plan, item, steps[0]);
  }

  /**
   * 手动名单模式：按勾选顺序逐个入场（每个 tick 至多一个，与规则模式同一保守节奏）。
   * 名单条目找不到/无权/缺邮箱/资格不合格都会落 skipped 占位，保证每个勾选目标恰好一个条目。
   */
  private async admitFromManualEntries(plan: ProspectOutreachPlan, nowIso: string) {
    const actor = { id: plan.ownerId, teamId: plan.teamId };
    const processed = new Set(plan.items.map((item) => `${item.entityType || "candidate"}:${item.candidateId}`));
    const entry = (plan.target.entries || []).find((row) => !processed.has(`${row.entityType}:${row.entityId}`));
    if (!entry) {
      if (plan.items.every(isItemFinal)) {
        plan.status = "completed";
        plan.nextRunAt = "";
        plan.lastMessage = "名单里的目标已全部处理完成，方案完成";
      } else {
        plan.lastMessage = "名单里的目标已全部入场，等待剩余步骤投递完成";
      }
      plan.updatedAt = nowIso;
      await this.store.persist();
      return;
    }
    const resolved = resolvePlanEntry(this.store, actor, entry);
    const placeholder = async (company: string, reason: string) => {
      plan.items.push({
        id: `pop_item_${randomUUID()}`,
        candidateId: entry.entityId,
        ...(entry.entityType === "lead" ? { leadId: entry.entityId } : {}),
        entityType: entry.entityType,
        company,
        recipient: "",
        status: "skipped",
        skipReason: reason,
        steps: [],
        sentAt: "",
        convertedLeadId: ""
      });
      plan.lastMessage = `跳过 ${company}（${reason}），继续处理下一个名单目标`;
      plan.updatedAt = nowIso;
      await this.store.persist();
    };
    if (!resolved) {
      await placeholder(`目标 ${entry.entityId}`, "目标不存在、已被删除或已不属于你");
      return;
    }
    let recipient = resolved.email;
    if (entry.entityType === "candidate") {
      const candidate = this.store.websiteOpportunities.find((row) => row.id === entry.entityId);
      if (!candidate) {
        await placeholder(resolved.company, "目标不存在、已被删除或已不属于你");
        return;
      }
      const eligibility = evaluateProspectEmailOutreachEligibility(this.store, candidate, nowIso);
      if (!eligibility.ready || !eligibility.recipient) {
        await placeholder(resolved.company, `${eligibility.label}：${eligibility.message}`);
        return;
      }
      recipient = eligibility.recipient;
    } else if (!recipient) {
      await placeholder(resolved.company, "缺收件邮箱：请先补全该目标的邮箱再发信");
      return;
    }
    // 自定义内容 → 占位符渲染；否则用系统默认序列模板（候选词形参兼容线索/客户字段）
    const shim = { company: resolved.company, business: resolved.business, country: resolved.country, contact: resolved.contact, contactInfo: resolved.email };
    const templates = plan.steps?.length
      ? plan.steps.map((step, index) => ({
        delayHours: index === 0 ? 0 : plan.policy.stepIntervalHours,
        subject: renderPlanStepContent(step.subject, shim),
        body: renderPlanStepContent(step.body, shim)
      }))
      : prospectBatchStepTemplates(shim, plan.policy);
    const steps = templates.map((template, index) => ({
      index,
      delayHours: template.delayHours,
      subject: template.subject,
      body: template.body,
      status: "pending" as const,
      scheduledAt: new Date(index === 0 ? Date.now() : Date.now() + template.delayHours * 3_600_000).toISOString(),
      sentAt: "",
      error: ""
    }));
    const item: ProspectOutreachBatchItem = {
      id: `pop_item_${randomUUID()}`,
      candidateId: entry.entityId,
      ...(entry.entityType === "lead" ? { leadId: entry.entityId } : {}),
      entityType: entry.entityType,
      company: resolved.company,
      recipient,
      status: "ready",
      skipReason: "",
      steps,
      sentAt: "",
      convertedLeadId: ""
    };
    plan.items.push(item);
    plan.updatedAt = nowIso;
    await this.store.persist();
    await this.sendStep(plan, item, steps[0]);
  }

  private pickNextPending(plan: ProspectOutreachPlan, now: Date) {
    for (const item of plan.items) {
      if (item.status !== "ready") continue;
      const step = item.steps.find((row) => row.status === "pending");
      if (!step) continue;
      if (step.scheduledAt && step.scheduledAt > now.toISOString()) continue;
      // 回复停发：候选按候选逻辑；名单里的线索/客户按触点里的 leadId/customerId 匹配回信
      let stopReason = "";
      if (plan.policy.stopOnReply) {
        if (item.entityType === "lead" || item.entityType === "customer") {
          const replied = this.store.prospectTouchpoints.some((touchpoint) =>
            (item.entityType === "lead" ? touchpoint.leadId === item.candidateId : touchpoint.customerId === item.candidateId)
            && (touchpoint.direction === "inbound" || touchpoint.eventType === "reply")
          );
          stopReason = replied ? "客户已回复，stopOnReply 策略停止剩余步骤" : "";
        } else {
          const candidate = this.store.websiteOpportunities.find((row) => row.id === item.candidateId);
          stopReason = shouldStopItemOnReply(this.store, item, candidate, plan.policy.stopOnReply);
        }
      }
      if (stopReason) {
        item.steps.forEach((row) => { if (row.status === "pending") row.status = "skipped"; });
        item.status = "stopped";
        item.skipReason = stopReason;
        continue;
      }
      return { item, step };
    }
    return null;
  }

  private async sendStep(plan: ProspectOutreachPlan, item: ProspectOutreachBatchItem, step: { index: number; status: string; subject: string; body: string; sentAt: string; error: string; scheduledAt: string }) {
    const nowIso = new Date().toISOString();
    item.status = "sending";
    step.status = "sending";
    plan.updatedAt = nowIso;
    try {
      const result = await this.runtime.send(planAsBatch(plan), item as ProspectOutreachBatchItem, step as ProspectOutreachBatchItem["steps"][number], `plan:${plan.id}:${item.id}:${step.index}`);
      step.status = "sent";
      step.sentAt = result.sentAt;
      step.error = "";
      item.recipient = result.recipient;
      const hasPending = item.steps.some((row) => row.status === "pending");
      if (!hasPending) {
        item.status = "sent";
        item.sentAt = result.sentAt;
        try {
          item.convertedLeadId = await this.runtime.convertToLead(planAsBatch(plan), item);
        } catch (error) {
          item.convertedLeadId = "";
          item.skipReason = `已发送但自动转线索失败：${error instanceof Error ? error.message : "未知错误"}`;
        }
        plan.lastMessage = `${item.company} 序列发送完成${item.convertedLeadId ? "，已回流为线索" : ""}`;
      } else {
        item.status = "ready";
        plan.lastMessage = `已发送 ${item.company} 第 ${step.index + 1} 步，下一封按间隔排期`;
      }
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : "发送失败";
      item.status = "failed";
      plan.lastMessage = `${item.company} 第 ${step.index + 1} 步发送失败：${step.error}`;
    }
    plan.lastRunAt = new Date().toISOString();
    plan.nextRunAt = nextWindowStart(new Date(), plan.policy).toISOString();
    if (plan.items.every(isItemFinal) && plan.items.length >= plan.target.maxTargets) {
      plan.status = "completed";
      plan.nextRunAt = "";
    }
    plan.updatedAt = new Date().toISOString();
    await this.store.persist();
  }
}
