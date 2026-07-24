import { randomUUID } from "node:crypto";
import { z } from "zod";
import { callAiModel } from "./ai-model-runtime.js";
import type { CrmStore } from "./store.js";
import type { AiModelConfig, SalesDistillation, SalesDistillationMetrics, User } from "./types.js";

type DistillationActor = Pick<User, "id" | "teamId" | "role">;

function canManageTeam(actor: DistillationActor) {
  return ["manager", "admin", "super_admin"].includes(actor.role);
}

function canAccessSource(actor: DistillationActor, source: User) {
  return source.id === actor.id || (canManageTeam(actor) && (actor.role === "super_admin" || source.teamId === actor.teamId));
}

function selectedModel(store: CrmStore, actor: DistillationActor): AiModelConfig | undefined {
  return store.aiModelConfigs.filter((item) => item.ownerId === actor.id && item.teamId === actor.teamId && item.enabled && item.apiKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function metricSnapshot(store: CrmStore, source: User, periodDays: number): SalesDistillationMetrics {
  const cutoff = Date.now() - periodDays * 86_400_000;
  const owns = <T extends { ownerId: string; teamId: string }>(items: T[]) => items.filter((item) => item.ownerId === source.id && item.teamId === source.teamId);
  const customers = owns(store.customers);
  const leads = owns(store.leads).filter((item) => !item.deletedAt);
  const deals = owns(store.deals);
  const activities = store.customerActivities.filter((item) => customers.some((customer) => customer.id === item.customerId) && new Date(item.createdAt).getTime() >= cutoff);
  const todos = owns(store.todos).filter((item) => item.done && (!item.completedAt || new Date(item.completedAt).getTime() >= cutoff));
  const reports = owns(store.dailyReports).filter((item) => new Date(item.createdAt).getTime() >= cutoff);
  const wonDeals = deals.filter((item) => item.stage === "成交");
  return {
    customerCount: customers.length,
    leadCount: leads.length,
    activeDealCount: deals.filter((item) => !item.archivedAt && !["成交", "丢单"].includes(item.stage)).length,
    wonDealCount: wonDeals.length,
    wonAmount: wonDeals.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    followupCount: activities.length,
    completedTodoCount: todos.length,
    reportCount: reports.length
  };
}

function fallbackDistillation(metrics: SalesDistillationMetrics) {
  return {
    patterns: [
      metrics.followupCount >= 12 ? "跟进频率稳定，能够持续推动客户进入下一节点" : "跟进频率偏低，需要建立固定回访节奏",
      metrics.wonDealCount > 0 ? "具备成交案例，可提炼成交前的报价、异议处理和推进动作" : "当前成交样本不足，优先沉淀有效商机推进过程",
      metrics.completedTodoCount >= metrics.followupCount ? "待办闭环意识较强，跟进行动有记录" : "部分跟进没有形成待办闭环，需要强化下一步动作"
    ],
    playbook: [
      { stage: "线索进入", action: "收到有效线索后当天完成联系人、需求和下一步日期记录", evidence: `${metrics.leadCount} 条有效线索作为当前样本` },
      { stage: "商机推进", action: "每次沟通都记录客户关心点，并把下一步动作落成待办", evidence: `${metrics.activeDealCount} 个活跃商机、${metrics.completedTodoCount} 个已完成待办` },
      { stage: "成交复盘", action: "围绕成交客户提炼报价节奏、关键异议和促成条件，形成团队可复用话术", evidence: `${metrics.wonDealCount} 个成交商机，成交金额 ${metrics.wonAmount.toLocaleString("en-US")}` }
    ],
    coachingActions: ["选择一条近期跟进记录，补充客户痛点和下一步动作", "把一条成功报价过程整理成可复用的英文沟通模板", "本周完成一次成交或丢单复盘并提交团队知识库"]
  };
}

const aiOutputSchema = z.object({
  patterns: z.array(z.string().min(1).max(240)).max(8).default([]),
  playbook: z.array(z.object({ stage: z.string().min(1).max(80), action: z.string().min(1).max(300), evidence: z.string().min(1).max(240) })).max(8).default([]),
  coachingActions: z.array(z.string().min(1).max(240)).max(8).default([])
});

export function listDistillationSources(store: CrmStore, actor: DistillationActor) {
  return store.users.filter((user) => user.status === "active" && canAccessSource(actor, user)).map((user) => ({ id: user.id, name: user.name, role: user.role, teamId: user.teamId }));
}

export async function createSalesDistillation(store: CrmStore, actor: DistillationActor, sourceUserId: string, periodDays = 90) {
  const source = store.users.find((item) => item.id === sourceUserId && item.status === "active");
  if (!source || !canAccessSource(actor, source)) throw new Error("没有权限蒸馏该业务员的数据");
  const boundedDays = Math.max(7, Math.min(365, Math.round(periodDays)));
  const metrics = metricSnapshot(store, source, boundedDays);
  const fallback = fallbackDistillation(metrics);
  const config = selectedModel(store, actor);
  let content = fallback;
  if (config) {
    try {
      const raw = await callAiModel(config, [
        "你是外贸销售教练，只能输出 JSON。",
        "根据匿名业务指标提炼可复制的业务员打法；不要编造事实，不要输出客户隐私。",
        `业务员：${source.name}；周期：${boundedDays} 天；指标：${JSON.stringify(metrics)}`,
        "输出：{\"patterns\":[\"...\"],\"playbook\":[{\"stage\":\"...\",\"action\":\"...\",\"evidence\":\"...\"}],\"coachingActions\":[\"...\"]}"
      ].join("\n"), 6_000);
      const parsed = aiOutputSchema.parse(JSON.parse(raw));
      content = { patterns: parsed.patterns.length ? parsed.patterns : fallback.patterns, playbook: parsed.playbook.length ? parsed.playbook : fallback.playbook, coachingActions: parsed.coachingActions.length ? parsed.coachingActions : fallback.coachingActions };
    } catch {
      // 模型不可用时保留确定性蒸馏结果。
    }
  }
  const distillation: SalesDistillation = {
    id: `sd_${randomUUID()}`, sourceUserId: source.id, sourceUserName: source.name, teamId: source.teamId,
    periodDays: boundedDays, metrics, patterns: content.patterns, playbook: content.playbook, coachingActions: content.coachingActions,
    modelLabel: config ? `${config.provider} / ${config.model}` : "规则蒸馏", status: "draft", createdBy: actor.id, createdAt: new Date().toISOString()
  };
  store.salesDistillations.unshift(distillation);
  await store.persist();
  return distillation;
}

export function listSalesDistillations(store: CrmStore, actor: DistillationActor) {
  return store.salesDistillations.filter((item) => item.createdBy === actor.id
    || (item.status === "published" && (actor.role === "super_admin" || item.teamId === actor.teamId))
    || (canManageTeam(actor) && (actor.role === "super_admin" || item.teamId === actor.teamId)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
}

export async function publishSalesDistillation(store: CrmStore, actor: DistillationActor, id: string) {
  const item = store.salesDistillations.find((candidate) => candidate.id === id);
  if (!item || !(item.createdBy === actor.id || (canManageTeam(actor) && (actor.role === "super_admin" || item.teamId === actor.teamId)))) throw new Error("蒸馏记录不存在或无权访问");
  if (!canManageTeam(actor)) throw new Error("发布团队蒸馏打法需要主管或管理员确认");
  item.status = "published";
  item.publishedBy = actor.id;
  item.publishedAt = new Date().toISOString();
  await store.persist();
  return item;
}

export function listSalesPlaybookActivations(store: CrmStore, actor: DistillationActor) {
  return store.salesPlaybookActivations
    .filter((item) => item.ownerId === actor.id && (actor.role === "super_admin" || item.teamId === actor.teamId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function activateSalesPlaybook(store: CrmStore, actor: DistillationActor, distillationId: string) {
  const distillation = store.salesDistillations.find((item) => item.id === distillationId);
  if (!distillation || distillation.status !== "published" || (actor.role !== "super_admin" && distillation.teamId !== actor.teamId)) {
    throw new Error("只有当前团队已发布的蒸馏打法可以应用");
  }
  const now = new Date().toISOString();
  store.salesPlaybookActivations
    .filter((item) => item.ownerId === actor.id && item.status === "active")
    .forEach((item) => { item.status = "paused"; item.updatedAt = now; });
  let activation = store.salesPlaybookActivations.find((item) => item.ownerId === actor.id && item.distillationId === distillation.id);
  if (activation) {
    activation.status = "active";
    activation.updatedAt = now;
  } else {
    activation = {
      id: `spa_${randomUUID()}`,
      distillationId: distillation.id,
      ownerId: actor.id,
      teamId: actor.teamId,
      status: "active",
      applicationCount: 0,
      taskCount: 0,
      lastUsedAt: "",
      activatedBy: actor.id,
      activatedAt: now,
      updatedAt: now
    };
    store.salesPlaybookActivations.unshift(activation);
  }
  await store.persist();
  return activation;
}

export async function pauseSalesPlaybook(store: CrmStore, actor: DistillationActor, activationId: string) {
  const activation = store.salesPlaybookActivations.find((item) => item.id === activationId && item.ownerId === actor.id && (actor.role === "super_admin" || item.teamId === actor.teamId));
  if (!activation) throw new Error("打法应用记录不存在");
  activation.status = "paused";
  activation.updatedAt = new Date().toISOString();
  await store.persist();
  return activation;
}

export function activeSalesPlaybookContext(store: CrmStore, actor: DistillationActor) {
  const activation = store.salesPlaybookActivations
    .filter((item) => item.ownerId === actor.id && item.status === "active" && (actor.role === "super_admin" || item.teamId === actor.teamId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!activation) return null;
  const distillation = store.salesDistillations.find((item) => item.id === activation.distillationId && item.status === "published");
  return distillation ? { activation, distillation } : null;
}

export function salesPlaybookActionForStage(store: CrmStore, actor: DistillationActor, stage: string) {
  const context = activeSalesPlaybookContext(store, actor);
  if (!context) return null;
  const normalizedStage = stage.trim();
  const exact = context.distillation.playbook.find((item) => item.stage === normalizedStage || item.stage.includes(normalizedStage) || normalizedStage.includes(item.stage));
  const fallback = normalizedStage === "成交"
    ? context.distillation.playbook.find((item) => /(成交|复购|复盘)/u.test(item.stage))
    : context.distillation.playbook.find((item) => /(商机|推进|跟进)/u.test(item.stage));
  const item = exact || fallback || context.distillation.playbook[0];
  return item ? { activation: context.activation, distillation: context.distillation, item } : null;
}

export function recordSalesPlaybookUsage(store: CrmStore, activationId: string, taskCreated: boolean) {
  const activation = store.salesPlaybookActivations.find((item) => item.id === activationId && item.status === "active");
  if (!activation) return;
  activation.applicationCount += 1;
  if (taskCreated) activation.taskCount += 1;
  activation.lastUsedAt = new Date().toISOString();
  activation.updatedAt = activation.lastUsedAt;
}
