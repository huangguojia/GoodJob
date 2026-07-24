import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentActor, AgentPlanContext } from "./ai-agent.js";
import type { CrmStore } from "./store.js";
import type { AgentTriggerEventRecord, AgentTriggerEventType, AgentTriggerRuleRecord } from "./types.js";

const triggerInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  eventType: z.enum(["lead_overdue", "customer_reply", "stalled_deal", "next_action_due", "health_decline", "communication_unread", "prospect_completed"]),
  mode: z.enum(["notify", "internal", "approval"]).default("notify"),
  intervalMinutes: z.coerce.number().int().min(5).max(10_080).default(60),
  thresholdDays: z.coerce.number().int().min(1).max(180).default(3),
  healthBelow: z.coerce.number().int().min(0).max(100).default(60),
  maxPerScan: z.coerce.number().int().min(1).max(20).default(5)
});

type TriggerFact = {
  factKey: string;
  entityType: AgentTriggerEventRecord["entityType"];
  entityId: string;
  title: string;
  message: string;
  context: AgentPlanContext;
};

export type AgentTriggerMissionFactory = (actor: AgentActor, goal: string, context: AgentPlanContext) => Promise<{ id: string }>;

function canAccess(rule: AgentTriggerRuleRecord, actor: AgentActor) {
  return rule.ownerId === actor.id && (actor.role === "super_admin" || rule.teamId === actor.teamId);
}

function hashFact(rule: AgentTriggerRuleRecord, parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify([rule.id, ...parts])).digest("hex");
}

function parseBusinessDate(value: string) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

export function detectAgentTriggerFacts(store: CrmStore, rule: AgentTriggerRuleRecord, now = new Date()): TriggerFact[] {
  const boundary = now.getTime() - rule.thresholdDays * 86_400_000;
  const customerMap = new Map(store.customers.filter((item) => item.ownerId === rule.ownerId && item.teamId === rule.teamId && item.poolStatus !== "public").map((item) => [item.id, item]));
  const facts: TriggerFact[] = [];
  if (rule.eventType === "lead_overdue") {
    for (const lead of store.leads.filter((item) => item.ownerId === rule.ownerId && item.teamId === rule.teamId && !item.deletedAt && ["new", "following"].includes(item.status))) {
      const referenceText = Number.isFinite(new Date(lead.lastActivityAt).getTime()) ? lead.lastActivityAt : lead.createdAt;
      const reference = parseBusinessDate(referenceText);
      if (reference > boundary) continue;
      facts.push({ factKey: hashFact(rule, [lead.id, lead.status, referenceText]), entityType: "lead", entityId: lead.id, title: `${lead.company} 线索待处理`, message: `${rule.thresholdDays} 天未形成有效推进`, context: { activeView: "leads", selectedLeadId: lead.id } });
    }
  }
  if (rule.eventType === "stalled_deal" || rule.eventType === "next_action_due") {
    for (const deal of store.deals.filter((item) => item.ownerId === rule.ownerId && item.teamId === rule.teamId && !item.archivedAt && !["成交", "丢单"].includes(item.stage))) {
      const customer = customerMap.get(deal.customerId);
      if (!customer) continue;
      const stalled = parseBusinessDate(deal.stageChangedAt) <= boundary;
      const due = Boolean(deal.nextActionAt) && parseBusinessDate(deal.nextActionAt) <= now.getTime();
      if ((rule.eventType === "stalled_deal" && !stalled) || (rule.eventType === "next_action_due" && !due)) continue;
      const message = rule.eventType === "stalled_deal" ? `${rule.thresholdDays} 天未推进，当前阶段 ${deal.stage}` : `下一动作“${deal.nextAction || "待补充"}”已到期`;
      facts.push({ factKey: hashFact(rule, [deal.id, deal.stage, deal.stageChangedAt, deal.nextActionAt]), entityType: "deal", entityId: deal.id, title: `${customer.company} 商机需要推进`, message, context: { activeView: "pipeline", selectedCustomerId: customer.id } });
    }
  }
  if (rule.eventType === "health_decline") {
    for (const customer of customerMap.values()) {
      if (customer.health >= rule.healthBelow) continue;
      facts.push({ factKey: hashFact(rule, [customer.id, customer.health, customer.grade]), entityType: "customer", entityId: customer.id, title: `${customer.company} 健康度下降`, message: `当前健康度 ${customer.health}，低于规则阈值 ${rule.healthBelow}`, context: { activeView: "customers", selectedCustomerId: customer.id } });
    }
  }
  if (rule.eventType === "communication_unread") {
    for (const binding of store.whatsappBindings.filter((item) => item.userId === rule.ownerId && item.unreadCount > 0)) {
      const customer = customerMap.get(binding.customerId);
      if (!customer) continue;
      facts.push({ factKey: hashFact(rule, [binding.id, binding.unreadCount, binding.lastMessageAt]), entityType: "communication", entityId: binding.id, title: `${customer.company} 有未读消息`, message: `Communication 有 ${binding.unreadCount} 条未读消息`, context: { activeView: "whatsapp", selectedCustomerId: customer.id } });
    }
  }
  if (rule.eventType === "customer_reply") {
    const allowedCustomers = new Set(store.whatsappBindings.filter((item) => item.userId === rule.ownerId).map((item) => item.customerId));
    for (const message of store.whatsappMessages.filter((item) => item.direction === "inbound" && allowedCustomers.has(item.customerId))) {
      const customer = customerMap.get(message.customerId);
      if (!customer) continue;
      facts.push({ factKey: hashFact(rule, [message.id, message.createdAt]), entityType: "communication", entityId: message.id, title: `${customer.company} 已回复`, message: "客户在 Communication 中产生新回复", context: { activeView: "whatsapp", selectedCustomerId: customer.id } });
    }
  }
  if (rule.eventType === "prospect_completed") {
    for (const run of store.prospectSearchRuns.filter((item) => item.ownerId === rule.ownerId && item.teamId === rule.teamId && ["succeeded", "succeeded_empty", "partial_success", "failed"].includes(item.status))) {
      facts.push({ factKey: hashFact(rule, [run.id, run.status, run.updatedAt]), entityType: "prospect_run", entityId: run.id, title: "搜客任务已结束", message: `搜客任务状态：${run.status}`, context: { activeView: "lead-finder" } });
    }
  }
  return facts;
}

export function listAgentTriggerRules(store: CrmStore, actor: AgentActor) {
  return store.agentTriggerRules.filter((item) => canAccess(item, actor)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function listAgentTriggerEvents(store: CrmStore, actor: AgentActor, limit = 50) {
  return store.agentTriggerEvents.filter((item) => item.ownerId === actor.id && (actor.role === "super_admin" || item.teamId === actor.teamId)).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, Math.max(1, Math.min(200, limit)));
}

export async function createAgentTriggerRule(store: CrmStore, actor: AgentActor, rawInput: unknown) {
  const input = triggerInputSchema.parse(rawInput);
  const now = new Date().toISOString();
  const rule: AgentTriggerRuleRecord = { id: `agtr_${randomUUID()}`, ownerId: actor.id, teamId: actor.teamId, name: input.name, eventType: input.eventType, mode: input.mode, status: "active", intervalMinutes: input.intervalMinutes, thresholdDays: input.thresholdDays, healthBelow: input.healthBelow, maxPerScan: input.maxPerScan, lastScanAt: "", lastTriggeredAt: "", nextScanAt: now, createdAt: now, updatedAt: now };
  store.agentTriggerRules.unshift(rule);
  await store.persist();
  return rule;
}

export async function updateAgentTriggerRule(store: CrmStore, actor: AgentActor, id: string, rawInput: unknown) {
  const rule = store.agentTriggerRules.find((item) => item.id === id && canAccess(item, actor));
  if (!rule) throw new Error("自动触发规则不存在或无权访问");
  const input = triggerInputSchema.partial().parse(rawInput);
  Object.assign(rule, input, { updatedAt: new Date().toISOString() });
  await store.persist();
  return rule;
}

export async function setAgentTriggerRuleStatus(store: CrmStore, actor: AgentActor, id: string, status: "active" | "paused") {
  const rule = store.agentTriggerRules.find((item) => item.id === id && canAccess(item, actor));
  if (!rule) throw new Error("自动触发规则不存在或无权访问");
  rule.status = status;
  rule.nextScanAt = status === "active" ? new Date().toISOString() : rule.nextScanAt;
  rule.updatedAt = new Date().toISOString();
  await store.persist();
  return rule;
}

export async function deleteAgentTriggerRule(store: CrmStore, actor: AgentActor, id: string) {
  const rule = store.agentTriggerRules.find((item) => item.id === id && canAccess(item, actor));
  if (!rule) throw new Error("自动触发规则不存在或无权访问");
  store.agentTriggerRules = store.agentTriggerRules.filter((item) => item.id !== id);
  await store.persist();
  return rule;
}

function missionGoal(rule: AgentTriggerRuleRecord, fact: TriggerFact) {
  if (rule.mode === "notify") return `只读检查这项业务提醒：${fact.title}。${fact.message}。不要修改、创建或发送任何数据。`;
  return `分析这项业务提醒并创建一条站内跟进待办：${fact.title}。${fact.message}。`;
}

export async function runAgentTriggerRule(store: CrmStore, actor: AgentActor, rule: AgentTriggerRuleRecord, createMission: AgentTriggerMissionFactory, now = new Date()) {
  if (!canAccess(rule, actor)) throw new Error("自动触发规则不存在或无权访问");
  if (rule.status !== "active") throw new Error("自动触发规则已暂停");
  const facts = detectAgentTriggerFacts(store, rule, now);
  const freshFacts = facts.filter((fact) => !store.agentTriggerEvents.some((item) => item.ruleId === rule.id && item.factKey === fact.factKey)).slice(0, rule.maxPerScan);
  const events: AgentTriggerEventRecord[] = [];
  for (const fact of freshFacts) {
    const createdAt = new Date().toISOString();
    try {
      const mission = await createMission(actor, missionGoal(rule, fact), { ...fact.context, conversationId: `agc_trigger_${rule.id}`, automationPolicy: rule.mode });
      events.push({ id: `agte_${randomUUID()}`, ruleId: rule.id, ownerId: rule.ownerId, teamId: rule.teamId, factKey: fact.factKey, entityType: fact.entityType, entityId: fact.entityId, title: fact.title, message: fact.message, missionRunId: mission.id, status: "mission_created", createdAt });
    } catch (error) {
      events.push({ id: `agte_${randomUUID()}`, ruleId: rule.id, ownerId: rule.ownerId, teamId: rule.teamId, factKey: fact.factKey, entityType: fact.entityType, entityId: fact.entityId, title: fact.title, message: error instanceof Error ? error.message : "Mission 创建失败", missionRunId: "", status: "failed", createdAt });
    }
  }
  store.agentTriggerEvents.unshift(...events);
  rule.lastScanAt = now.toISOString();
  rule.lastTriggeredAt = events.some((item) => item.status === "mission_created") ? now.toISOString() : rule.lastTriggeredAt;
  rule.nextScanAt = new Date(now.getTime() + rule.intervalMinutes * 60_000).toISOString();
  rule.updatedAt = now.toISOString();
  await store.persist();
  return { rule, matchedCount: facts.length, createdCount: events.filter((item) => item.status === "mission_created").length, skippedCount: Math.max(0, facts.length - freshFacts.length), events };
}

export class AgentTriggerRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly store: CrmStore, private readonly createMission: AgentTriggerMissionFactory, private readonly pollMs = 60_000) {}

  async synchronize(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const rule of this.store.agentTriggerRules.filter((item) => item.status === "active" && (!item.nextScanAt || new Date(item.nextScanAt).getTime() <= now.getTime()))) {
        const actor = this.store.users.find((item) => item.id === rule.ownerId && item.status === "active");
        if (!actor) continue;
        await runAgentTriggerRule(this.store, actor, rule, this.createMission, now);
      }
    } finally {
      this.running = false;
    }
  }

  async start() {
    await this.synchronize();
    this.timer = setInterval(() => void this.synchronize(), Math.max(5_000, this.pollMs));
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
