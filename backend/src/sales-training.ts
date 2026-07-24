import { randomUUID } from "node:crypto";
import { z } from "zod";
import { callAiModel } from "./ai-model-runtime.js";
import type { CrmStore } from "./store.js";
import type {
  AiModelConfig,
  SalesDistillation,
  SalesDistillationMetrics,
  SalesTrainingEvaluation,
  SalesTrainingMaturity,
  SalesTrainingRun,
  SalesTrainingSample,
  SalesTrainingSampleLabel,
  SalesTrainingStatus,
  User
} from "./types.js";

type TrainingActor = Pick<User, "id" | "teamId" | "role">;

const EMPTY_METRICS: SalesDistillationMetrics = { customerCount: 0, leadCount: 0, activeDealCount: 0, wonDealCount: 0, wonAmount: 0, followupCount: 0, completedTodoCount: 0, reportCount: 0 };
const EMPTY_EVALUATION: SalesTrainingEvaluation = { coverage: 0, balance: 0, traceability: 0, strategy: 0, safety: 100, overall: 0, passed: false, blockers: [] };
const ACTIVE_STATUSES: SalesTrainingStatus[] = ["queued", "collecting", "cleaning", "labeling", "training", "evaluating"];

function canManageTeam(actor: TrainingActor) {
  return ["manager", "admin", "super_admin"].includes(actor.role);
}

function canAccessSource(actor: TrainingActor, source: User) {
  return source.id === actor.id || (canManageTeam(actor) && (actor.role === "super_admin" || source.teamId === actor.teamId));
}

function canSeeRun(actor: TrainingActor, run: SalesTrainingRun) {
  return run.createdBy === actor.id || run.sourceUserId === actor.id || (canManageTeam(actor) && (actor.role === "super_admin" || run.teamId === actor.teamId));
}

function event(run: SalesTrainingRun, stage: SalesTrainingStatus, message: string) {
  run.events.push({ id: `ste_${randomUUID()}`, stage, message, createdAt: new Date().toISOString() });
  run.updatedAt = new Date().toISOString();
}

function selectedModel(store: CrmStore, actorId: string, teamId: string): AiModelConfig | undefined {
  return store.aiModelConfigs
    .filter((item) => item.ownerId === actorId && item.teamId === teamId && item.enabled && item.apiKey)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function metricsForSource(store: CrmStore, source: User, periodDays: number): SalesDistillationMetrics {
  const cutoff = Date.now() - periodDays * 86_400_000;
  const customers = store.customers.filter((item) => item.ownerId === source.id && item.teamId === source.teamId);
  const customerIds = new Set(customers.map((item) => item.id));
  const leads = store.leads.filter((item) => item.ownerId === source.id && item.teamId === source.teamId && !item.deletedAt);
  const deals = store.deals.filter((item) => item.ownerId === source.id && item.teamId === source.teamId);
  const activities = store.customerActivities.filter((item) => customerIds.has(item.customerId) && new Date(item.createdAt).getTime() >= cutoff);
  const todos = store.todos.filter((item) => item.ownerId === source.id && item.teamId === source.teamId && item.done && (!item.completedAt || new Date(item.completedAt).getTime() >= cutoff));
  const reports = store.dailyReports.filter((item) => item.ownerId === source.id && item.teamId === source.teamId && new Date(item.createdAt).getTime() >= cutoff);
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

function sampleLabel(stage: string): SalesTrainingSampleLabel {
  if (stage === "成交") return "positive";
  if (stage === "丢单") return "negative";
  return "neutral";
}

function collectSamples(store: CrmStore, run: SalesTrainingRun): SalesTrainingSample[] {
  const cutoff = Date.now() - run.periodDays * 86_400_000;
  const parent = run.parentRunId ? store.salesTrainingRuns.find((item) => item.id === run.parentRunId) : undefined;
  const prior = new Map((parent?.samples || []).map((item) => [`${item.entityType}:${item.entityId}`, item]));
  const customers = store.customers.filter((item) => item.ownerId === run.sourceUserId && item.teamId === run.teamId);
  const customerIds = new Set(customers.map((item) => item.id));
  const samples: SalesTrainingSample[] = [];
  for (const deal of store.deals.filter((item) => item.ownerId === run.sourceUserId && item.teamId === run.teamId)) {
    const customer = customers.find((item) => item.id === deal.customerId);
    const activities = store.customerActivities.filter((item) => item.customerId === deal.customerId && new Date(item.createdAt).getTime() >= cutoff);
    const todos = store.todos.filter((item) => item.ownerId === run.sourceUserId && item.customerId === deal.customerId);
    const key = `deal:${deal.id}`;
    const previous = prior.get(key);
    samples.push({
      id: `sts_${randomUUID()}`,
      entityType: "deal",
      entityId: deal.id,
      title: deal.title,
      market: customer?.country || "未知市场",
      stage: deal.stage,
      outcome: deal.stage === "成交" ? "成交" : deal.stage === "丢单" ? "丢单" : "进行中",
      label: previous?.label || sampleLabel(deal.stage),
      included: previous?.included ?? true,
      activityCount: activities.length,
      todoCount: todos.length,
      evidenceIds: [deal.id, ...activities.slice(0, 8).map((item) => item.id), ...todos.slice(0, 5).map((item) => item.id)],
      summary: `${customer?.company || "客户"} · ${deal.product} · ${deal.stage} · 跟进 ${activities.length} 次 · 待办 ${todos.length} 项`,
      managerNote: previous?.managerNote || ""
    });
  }
  for (const customer of customers.filter((item) => !store.deals.some((deal) => deal.customerId === item.id))) {
    const activities = store.customerActivities.filter((item) => item.customerId === customer.id && new Date(item.createdAt).getTime() >= cutoff);
    const previous = prior.get(`customer:${customer.id}`);
    samples.push({ id: `sts_${randomUUID()}`, entityType: "customer", entityId: customer.id, title: customer.company, market: customer.country, stage: customer.stage, outcome: "客户维护", label: previous?.label || "neutral", included: previous?.included ?? activities.length > 0, activityCount: activities.length, todoCount: store.todos.filter((item) => item.customerId === customer.id && item.ownerId === run.sourceUserId).length, evidenceIds: [customer.id, ...activities.slice(0, 8).map((item) => item.id)], summary: `${customer.company} · ${customer.country} · ${customer.grade}级 · 健康度 ${customer.health} · 跟进 ${activities.length} 次`, managerNote: previous?.managerNote || "" });
  }
  for (const lead of store.leads.filter((item) => item.ownerId === run.sourceUserId && item.teamId === run.teamId && !item.deletedAt)) {
    const activities = store.leadActivities.filter((item) => item.leadId === lead.id && new Date(item.createdAt).getTime() >= cutoff);
    const previous = prior.get(`lead:${lead.id}`);
    samples.push({ id: `sts_${randomUUID()}`, entityType: "lead", entityId: lead.id, title: lead.company, market: lead.country || "未知市场", stage: lead.stage, outcome: lead.status === "converted" ? "已转化" : lead.status === "invalid" ? "无效" : "培育中", label: previous?.label || (lead.status === "converted" ? "positive" : lead.status === "invalid" ? "negative" : "neutral"), included: previous?.included ?? true, activityCount: activities.length, todoCount: 0, evidenceIds: [lead.id, ...activities.slice(0, 8).map((item) => item.id)], summary: `${lead.company} · ${lead.intent}意向 · ${lead.stage} · 活动 ${activities.length} 次`, managerNote: previous?.managerNote || "" });
  }
  return samples.filter((item) => item.entityType !== "customer" || customerIds.has(item.entityId));
}

function sampleStats(samples: SalesTrainingSample[]) {
  const valid = samples.filter((item) => item.included);
  return { source: samples.length, valid: valid.length, rejected: samples.length - valid.length, positive: valid.filter((item) => item.label === "positive").length, negative: valid.filter((item) => item.label === "negative").length, neutral: valid.filter((item) => item.label === "neutral").length, holdout: Math.max(valid.length >= 5 ? 1 : 0, Math.floor(valid.length * 0.2)) };
}

function maturityFor(stats: SalesTrainingRun["sampleStats"]): SalesTrainingMaturity {
  if (stats.valid >= 12 && stats.positive >= 2 && stats.negative >= 2) return "production";
  if (stats.valid >= 3 && stats.positive >= 1 && stats.negative >= 1) return "trial";
  return "observation";
}

function fallbackContent(run: SalesTrainingRun) {
  const stats = run.sampleStats;
  return {
    patterns: [
      stats.positive > 0 ? `已识别 ${stats.positive} 个正向结果样本，可追溯成交或转化前的推进动作` : "正向结果样本不足，当前只形成观察结论",
      stats.negative > 0 ? `已纳入 ${stats.negative} 个负向样本，用于识别无效跟进和丢单风险` : "负向样本不足，无法可靠判断停止条件",
      run.metrics.followupCount >= Math.max(6, run.metrics.customerCount) ? "跟进记录密度稳定，适合训练下一动作和回访节奏" : "跟进记录密度偏低，需要补充连续沟通链路"
    ],
    playbook: [
      { stage: "线索进入", action: "当天补齐采购对象、需求证据和下一跟进日期；缺少企业身份和联系方式时保持待核实。", evidence: `${stats.valid} 个有效样本，${run.metrics.leadCount} 条线索` },
      { stage: "客户分层", action: "结合采购信号、回复状态、商机金额和最近跟进对客户分级，不凭单一字段调整等级。", evidence: `${run.metrics.customerCount} 个客户，正负样本 ${stats.positive + stats.negative} 个` },
      { stage: "商机推进", action: "每次沟通后记录客户关注点、明确责任人和下一动作；没有客户反馈时不提前升级阶段。", evidence: `${run.metrics.activeDealCount} 个活跃商机，${run.metrics.followupCount} 条跟进` },
      { stage: "异议处理", action: "围绕价格、交期、认证和付款方式分别记录异议证据，优先解决阻塞成交的单一关键条件。", evidence: `${stats.negative} 个负向样本参与风险训练` },
      { stage: "成交复盘", action: "成交和丢单都回溯关键节点、跟进间隔与客户反馈，形成下一版本训练标签。", evidence: `${run.metrics.wonDealCount} 个成交商机，成交金额 ${run.metrics.wonAmount.toLocaleString("en-US")}` }
    ],
    coachingActions: ["补充缺少结果标签的进行中商机", "为负向样本标注真实丢单或无回复原因", "把关键客户回复与对应下一动作关联到同一证据链"]
  };
}

const modelContentSchema = z.object({
  patterns: z.array(z.string().min(1).max(240)).min(1).max(8),
  playbook: z.array(z.object({ stage: z.string().min(1).max(80), action: z.string().min(1).max(300), evidence: z.string().min(1).max(240) })).min(3).max(8),
  coachingActions: z.array(z.string().min(1).max(240)).min(1).max(8)
});

async function trainContent(store: CrmStore, run: SalesTrainingRun) {
  const fallback = fallbackContent(run);
  const config = selectedModel(store, run.createdBy, run.teamId);
  if (!config) return { ...fallback, modelLabel: "结构化策略训练" };
  try {
    const evidence = run.samples.filter((item) => item.included).slice(0, 40).map((item) => ({ id: item.id, type: item.entityType, market: item.market, stage: item.stage, outcome: item.outcome, label: item.label, activityCount: item.activityCount, todoCount: item.todoCount, summary: item.summary }));
    const raw = await callAiModel(config, ["你是外贸销售策略训练器，只输出 JSON。", "根据已脱敏、带结果标签的训练样本生成可执行策略；不得编造样本外事实。每条 evidence 必须引用样本数量或样本 ID。", `训练版本：${run.version}；样本：${JSON.stringify(evidence)}`, "输出：{\"patterns\":[\"...\"],\"playbook\":[{\"stage\":\"...\",\"action\":\"...\",\"evidence\":\"...\"}],\"coachingActions\":[\"...\"]}"].join("\n"), 12_000);
    return { ...modelContentSchema.parse(JSON.parse(raw)), modelLabel: `${config.provider} / ${config.model}` };
  } catch {
    return { ...fallback, modelLabel: "结构化策略训练（模型回退）" };
  }
}

function evaluate(run: SalesTrainingRun): SalesTrainingEvaluation {
  const stats = run.sampleStats;
  const coverage = Math.min(100, Math.round(stats.valid / 12 * 100));
  const labelled = stats.positive + stats.negative;
  const balance = labelled ? Math.min(100, Math.round(Math.min(stats.positive, stats.negative) / Math.max(stats.positive, stats.negative) * 100)) : 0;
  const traceability = stats.valid ? Math.round(run.samples.filter((item) => item.included && item.evidenceIds.length > 0).length / stats.valid * 100) : 0;
  const strategy = Math.min(100, 45 + run.playbook.length * 9 + Math.min(10, run.patterns.length * 2));
  const safety = 100;
  const overall = Math.round(coverage * .25 + balance * .2 + traceability * .2 + strategy * .25 + safety * .1);
  const blockers: string[] = [];
  if (run.maturity === "observation") blockers.push("有效正负样本不足，当前仅达到观察级");
  if (traceability < 90) blockers.push("部分训练结论缺少可追溯证据");
  if (overall < 65) blockers.push("综合评测未达到试用发布门槛 65 分");
  return { coverage, balance, traceability, strategy, safety, overall, passed: run.maturity !== "observation" && overall >= 65 && safety >= 90, blockers };
}

function startRound(run: SalesTrainingRun, index: number, name: string) {
  const now = new Date().toISOString();
  const round = run.rounds.find((item) => item.index === index);
  if (round) {
    round.status = "running";
    round.startedAt ||= now;
    return round;
  }
  const created = { id: `str_${randomUUID()}`, index, name, status: "running" as const, summary: "", startedAt: now, completedAt: "" };
  run.rounds.push(created);
  return created;
}

function completeRound(run: SalesTrainingRun, index: number, summary: string) {
  const round = run.rounds.find((item) => item.index === index);
  if (!round) return;
  round.status = "completed";
  round.summary = summary;
  round.completedAt = new Date().toISOString();
}

export async function createSalesTrainingRun(store: CrmStore, actor: TrainingActor, sourceUserId: string, periodDays = 90, parentRunId = "") {
  const source = store.users.find((item) => item.id === sourceUserId && item.status === "active");
  if (!source || !canAccessSource(actor, source)) throw new Error("没有权限训练该业务员的数据");
  const active = store.salesTrainingRuns.find((item) => item.sourceUserId === source.id && ACTIVE_STATUSES.includes(item.status));
  if (active) return active;
  const version = Math.max(0, ...store.salesTrainingRuns.filter((item) => item.sourceUserId === source.id).map((item) => item.version || 0)) + 1;
  const now = new Date().toISOString();
  const run: SalesTrainingRun = {
    id: `st_${randomUUID()}`, sourceUserId: source.id, sourceUserName: source.name, teamId: source.teamId, createdBy: actor.id, parentRunId, version,
    periodDays: Math.max(7, Math.min(365, Math.round(periodDays))), status: "queued", resumeStatus: "queued", progress: 2, currentAction: "等待训练工作器领取任务", maturity: "observation",
    metrics: { ...EMPTY_METRICS }, sampleStats: { source: 0, valid: 0, rejected: 0, positive: 0, negative: 0, neutral: 0, holdout: 0 }, samples: [], rounds: [], events: [], patterns: [], playbook: [], coachingActions: [], evaluation: { ...EMPTY_EVALUATION }, modelLabel: "待训练", candidateDistillationId: "", error: "", createdAt: now, updatedAt: now, completedAt: "", publishedAt: ""
  };
  event(run, "queued", `已创建 ${source.name} 的第 ${version} 版训练任务`);
  store.salesTrainingRuns.unshift(run);
  await store.persist();
  return run;
}

export function listSalesTrainingRuns(store: CrmStore, actor: TrainingActor) {
  return store.salesTrainingRuns.filter((item) => canSeeRun(actor, item)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 40);
}

export function getSalesTrainingRun(store: CrmStore, actor: TrainingActor, id: string) {
  const run = store.salesTrainingRuns.find((item) => item.id === id && canSeeRun(actor, item));
  if (!run) throw new Error("销售训练任务不存在或无权访问");
  return run;
}

export async function advanceSalesTrainingRun(store: CrmStore, id: string) {
  const run = store.salesTrainingRuns.find((item) => item.id === id);
  if (!run || !ACTIVE_STATUSES.includes(run.status)) return run;
  const source = store.users.find((item) => item.id === run.sourceUserId);
  if (!source) {
    run.status = "failed"; run.error = "训练对象不存在或已停用"; event(run, "failed", run.error); await store.persist(); return run;
  }
  try {
    if (run.status === "queued") {
      run.status = "collecting"; run.progress = 8; run.currentAction = "读取客户、线索、商机、跟进和待办证据"; startRound(run, 1, "样本采集"); event(run, run.status, run.currentAction);
    } else if (run.status === "collecting") {
      run.metrics = metricsForSource(store, source, run.periodDays); run.samples = collectSamples(store, run); run.sampleStats = sampleStats(run.samples); completeRound(run, 1, `采集 ${run.samples.length} 个候选样本`); run.status = "cleaning"; run.progress = 24; run.currentAction = "清洗无证据、重复和不可训练样本"; startRound(run, 2, "证据清洗"); event(run, run.status, `已采集 ${run.samples.length} 个候选样本，开始证据清洗`);
    } else if (run.status === "cleaning") {
      run.samples.forEach((item) => { if (!item.evidenceIds.length || (!item.activityCount && item.entityType === "customer")) item.included = false; }); run.sampleStats = sampleStats(run.samples); completeRound(run, 2, `保留 ${run.sampleStats.valid} 个，淘汰 ${run.sampleStats.rejected} 个`); run.status = "labeling"; run.progress = 42; run.currentAction = "根据成交、丢单和转化结果生成训练标签"; startRound(run, 3, "结果标注"); event(run, run.status, `清洗完成：保留 ${run.sampleStats.valid} 个，淘汰 ${run.sampleStats.rejected} 个`);
    } else if (run.status === "labeling") {
      run.sampleStats = sampleStats(run.samples); run.maturity = maturityFor(run.sampleStats); completeRound(run, 3, `正向 ${run.sampleStats.positive}、负向 ${run.sampleStats.negative}、中性 ${run.sampleStats.neutral}`); run.status = "training"; run.progress = 58; run.currentAction = "对比正负样本并训练分阶段销售策略"; startRound(run, 4, "策略训练"); event(run, run.status, `标签完成，当前训练成熟度为 ${run.maturity}`);
    } else if (run.status === "training") {
      const content = await trainContent(store, run); run.patterns = content.patterns; run.playbook = content.playbook; run.coachingActions = content.coachingActions; run.modelLabel = content.modelLabel; completeRound(run, 4, `形成 ${run.patterns.length} 个模式和 ${run.playbook.length} 条阶段策略`); run.status = "evaluating"; run.progress = 78; run.currentAction = "使用留出样本评测覆盖度、平衡性和证据质量"; startRound(run, 5, "离线评测"); event(run, run.status, `策略训练完成，开始评测 ${run.sampleStats.holdout} 个留出样本`);
    } else if (run.status === "evaluating") {
      run.evaluation = evaluate(run); completeRound(run, 5, `综合评测 ${run.evaluation.overall} 分`); run.status = "awaiting_review"; run.progress = 100; run.currentAction = run.evaluation.passed ? "训练完成，等待主管审核发布" : "训练完成，需要补充样本或修正标签"; run.completedAt = new Date().toISOString(); event(run, run.status, `${run.currentAction}；综合得分 ${run.evaluation.overall}`);
    }
    run.updatedAt = new Date().toISOString();
    await store.persist();
  } catch (error) {
    run.status = "failed"; run.error = error instanceof Error ? error.message : "训练任务失败"; run.currentAction = "训练中断"; event(run, "failed", run.error); await store.persist();
  }
  return run;
}

export async function controlSalesTrainingRun(store: CrmStore, actor: TrainingActor, id: string, action: "pause" | "resume" | "cancel") {
  const run = getSalesTrainingRun(store, actor, id);
  if (action === "pause") {
    if (ACTIVE_STATUSES.includes(run.status)) { run.resumeStatus = run.status; run.status = "paused"; run.currentAction = "训练已暂停"; event(run, "paused", "用户已暂停训练任务"); }
  } else if (action === "resume") {
    if (!["paused", "failed"].includes(run.status)) throw new Error("当前训练任务不需要恢复");
    run.status = ACTIVE_STATUSES.includes(run.resumeStatus) ? run.resumeStatus : "queued"; run.error = ""; run.currentAction = "正在从训练检查点恢复"; event(run, run.status, "已从训练检查点恢复");
  } else if (!["published", "cancelled"].includes(run.status)) {
    run.status = "cancelled"; run.currentAction = "训练已取消"; event(run, "cancelled", "用户已取消训练任务");
  }
  run.updatedAt = new Date().toISOString(); await store.persist(); return run;
}

export async function updateSalesTrainingSample(store: CrmStore, actor: TrainingActor, runId: string, sampleId: string, input: { label?: SalesTrainingSampleLabel; included?: boolean; managerNote?: string }) {
  const run = getSalesTrainingRun(store, actor, runId);
  if (!canManageTeam(actor) && run.sourceUserId !== actor.id) throw new Error("无权修改该训练样本");
  if (!['awaiting_review', 'paused', 'failed'].includes(run.status)) throw new Error("训练运行中不能修改样本，请先暂停任务");
  const sample = run.samples.find((item) => item.id === sampleId);
  if (!sample) throw new Error("训练样本不存在");
  if (input.label) sample.label = input.label;
  if (typeof input.included === "boolean") sample.included = input.included;
  if (typeof input.managerNote === "string") sample.managerNote = input.managerNote.trim().slice(0, 500);
  run.sampleStats = sampleStats(run.samples); run.maturity = maturityFor(run.sampleStats); run.evaluation = evaluate(run); event(run, run.status, `已人工复核样本：${sample.title}`); await store.persist(); return run;
}

export async function retrainSalesTrainingRun(store: CrmStore, actor: TrainingActor, id: string) {
  const prior = getSalesTrainingRun(store, actor, id);
  if (!['awaiting_review', 'published', 'failed', 'cancelled'].includes(prior.status)) throw new Error("当前训练尚未结束，不能创建新版本");
  return await createSalesTrainingRun(store, actor, prior.sourceUserId, prior.periodDays, prior.id);
}

export async function publishSalesTrainingRun(store: CrmStore, actor: TrainingActor, id: string) {
  const run = getSalesTrainingRun(store, actor, id);
  if (!canManageTeam(actor)) throw new Error("发布团队能力需要主管或管理员确认");
  if (run.status !== "awaiting_review") throw new Error("只有完成评测的训练版本可以发布");
  if (!run.evaluation.passed) throw new Error(run.evaluation.blockers[0] || "训练评测未达到发布门槛");
  const now = new Date().toISOString();
  const distillation: SalesDistillation = { id: `sd_${randomUUID()}`, sourceUserId: run.sourceUserId, sourceUserName: run.sourceUserName, teamId: run.teamId, periodDays: run.periodDays, metrics: run.metrics, patterns: run.patterns, playbook: run.playbook, coachingActions: run.coachingActions, modelLabel: run.modelLabel, status: "published", createdBy: run.createdBy, createdAt: run.createdAt, publishedBy: actor.id, publishedAt: now, trainingRunId: run.id, version: run.version, maturity: run.maturity, evaluationScore: run.evaluation.overall, sampleCount: run.sampleStats.valid };
  store.salesDistillations.unshift(distillation); run.status = "published"; run.candidateDistillationId = distillation.id; run.publishedAt = now; run.currentAction = "能力版本已发布，可应用到 AI Agent"; event(run, "published", `第 ${run.version} 版能力已发布`); await store.persist(); return { run, distillation };
}

export class SalesTrainingRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private readonly store: CrmStore, private readonly intervalMs = 1_200) {}
  async start() { await this.synchronize(); this.timer = setInterval(() => void this.synchronize(), this.intervalMs); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async synchronize() {
    if (this.busy) return;
    this.busy = true;
    try {
      const run = this.store.salesTrainingRuns.filter((item) => ACTIVE_STATUSES.includes(item.status)).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
      if (run) await advanceSalesTrainingRun(this.store, run.id);
    } finally { this.busy = false; }
  }
}
