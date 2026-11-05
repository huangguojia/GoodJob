/**
 * AI Agent路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canSeeOwner, hasIamPermission, requireAuth } from "../auth.js";
import { compileAgentGoalSpec } from "../agent-goal.js";
import { resolveAgentMissionRoute } from "../agent-turn-decision.js";
import { agentCatalog, agentMissionContextSnapshots, type AgentPlanningProgressHandler, cancelAgentMission, createAgentPlan, executeAgentStep, getAgentRun, listAgentConversations, listAgentMissionCheckpoints, listAgentRuns, pauseAgentMission, resolveAgentTurnDecision, restoreAgentMissionCheckpoint, resumeAgentMission, steerAgentMission } from "../ai-agent.js";
import { deleteAgentMemory, listAgentMemories, proposeAgentMemory, setAgentMemoryStatus, updateAgentMemory } from "../agent-memory.js";
import { agentKnowledgeOverview, createAgentKnowledgeDraft, listAgentKnowledgeDocuments, retrieveAgentKnowledge, setAgentKnowledgeStatus, updateAgentKnowledgeDraft } from "../agent-knowledge.js";
import { collectHubResources, collectHubResourcesDetailed, emptyEventCounts, getResourceHubRepository, MAX_VECTOR_CANDIDATES as MAX_RESOURCE_VECTOR_CANDIDATES, RESOURCE_HUB_EMBEDDING_MODEL, RESOURCE_SOURCE_TYPES, type ResourceEventStatsEntry, resourceKey, resourceReachable, type ResourceSourceType, resourceTerms, revealHubResource, scoreHubResources } from "../resource-hub.js";
import { getKnowledgeGovernanceRepository } from "../knowledge-governance.js";
import { createAgentTriggerRule, deleteAgentTriggerRule, listAgentTriggerEvents, listAgentTriggerRules, runAgentTriggerRule, setAgentTriggerRuleStatus, updateAgentTriggerRule } from "../agent-triggers.js";
import { agentModelMetrics, runAgentEvaluationSuite } from "../agent-model-governance.js";
import { getAgentSkill, listAgentSkills, publicAgentSkill, rankAgentSkills, selectAgentSkills } from "../agent-skills.js";
import { activateSalesPlaybook, createSalesDistillation, listDistillationSources, listSalesDistillations, listSalesPlaybookActivations, pauseSalesPlaybook, publishSalesDistillation } from "../sales-distillation.js";
import { controlSalesTrainingRun, createSalesTrainingRun, getSalesTrainingRun, listSalesTrainingRuns, publishSalesTrainingRun, retrainSalesTrainingRun, updateSalesTrainingSample } from "../sales-training.js";
import { controlOutreachSequence, listOutreachSequences } from "../outreach-sequences.js";
import { type SessionUser } from "../types.js";
import { controlCustomerMaintenanceWatch, createCustomerMaintenanceWatchDirect, customerMaintenanceWatchFor, listCustomerMaintenanceFindings, listCustomerMaintenanceWatches, previewCustomerMaintenance, runCustomerMaintenanceWatch } from "../customer-maintenance.js";
import { getStore } from "../store.js";
import {
  activeAgentBackgroundRunner,
  activeAgentTriggerRunner,
  activeCustomerMaintenanceRunner,
  activeOutreachSequenceRunner,
  activeSalesTrainingRunner,
  agentExecutionRuntime,
  asyncRoute,
  canSeeKnowledgeAsset,
  knowledgeAssetHasLink,
  knowledgeQualityFlags,
  normalizeKnowledgeSource,
  recordResourceHubEvents
} from "../server-core.js";

function canManageSkillResources(user?: SessionUser) {
  return hasIamPermission(user, "agent.manage");
}

const skillResourceInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(100).default("业务效率"),
  version: z.string().trim().min(1).max(40).default("1.0.0"),
  summary: z.string().trim().min(1).max(1200),
  usageGuide: z.string().trim().max(8000).optional().default(""),
  trainingGuide: z.string().trim().max(12000).optional().default(""),
  optimizationAdvice: z.string().trim().max(12000).optional().default(""),
  acquisitionInstructions: z.string().trim().max(4000).optional().default(""),
  downloadUrl: z.string().trim().min(1).max(2048),
  extractionCode: z.string().trim().max(64).optional().default(""),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional().default([]),
  author: z.string().trim().max(120).optional().default(""),
  license: z.string().trim().max(120).optional().default("内部使用")
});

function normalizeSkillResourceUrl(rawUrl: string) {
  const source = normalizeKnowledgeSource(rawUrl);
  return source.sourceUrl;
}

const agentPlanRequestSchema = z.object({
  goal: z.string().trim().min(2).max(2_000),
  context: z.record(z.unknown()).optional().default({})
});

async function resolveAgentPlanRequest(
  user: NonNullable<Request["user"]>,
  body: z.infer<typeof agentPlanRequestSchema>,
  onProgress?: AgentPlanningProgressHandler
) {
  const conversationId = typeof body.context.conversationId === "string" ? body.context.conversationId : "";
  const conversationRuns = conversationId ? listAgentRuns(getStore(), user, 20, conversationId) : [];
  const missionSnapshots = agentMissionContextSnapshots(conversationRuns);
  const turnDecision = await resolveAgentTurnDecision(getStore(), user, body.goal, missionSnapshots);
  const relatedMission = turnDecision.missionId
    ? conversationRuns.find((item) => item.id === turnDecision.missionId)
    : missionSnapshots[0]
      ? conversationRuns.find((item) => item.id === missionSnapshots[0]!.id)
      : undefined;
  const missionRoute = resolveAgentMissionRoute(turnDecision, relatedMission);
  const context = {
    conversationId: typeof body.context.conversationId === "string" ? body.context.conversationId : undefined,
    activeView: typeof body.context.activeView === "string" ? body.context.activeView : undefined,
    selectedCustomerId: typeof body.context.selectedCustomerId === "string" ? body.context.selectedCustomerId : undefined,
    selectedLeadId: typeof body.context.selectedLeadId === "string" ? body.context.selectedLeadId : undefined,
    selectedCustomerIds: Array.isArray(body.context.selectedCustomerIds)
      ? body.context.selectedCustomerIds.filter((item): item is string => typeof item === "string")
      : undefined,
    turnDecision,
    missionSnapshots
  };
  if (turnDecision.relationToMission !== "independent" && relatedMission) {
    onProgress?.({
      phase: "understanding",
      requestKind: turnDecision.speechAct === "query_data" ? "query" : "execute",
      message: "正在理解这条新指令与当前任务的关系",
      detail: `已识别为 ${turnDecision.relationToMission}，目标任务 ${relatedMission.id}`
    });
    onProgress?.({
      phase: "intent",
      requestKind: "execute",
      message: turnDecision.relationToMission === "answer"
        ? "已确认：这是对当前任务缺失信息的回答"
        : turnDecision.relationToMission === "continue"
          ? "已确认：继续当前任务"
          : turnDecision.relationToMission === "cancel"
            ? "已确认：停止当前任务"
            : "已确认：这是对当前任务的修正",
      detail: `${turnDecision.reason}（置信度 ${Math.round(turnDecision.missionRelationConfidence * 100)}%）`
    });
  }
  if (relatedMission && missionRoute === "cancel") {
    return await cancelAgentMission(getStore(), user, relatedMission.id);
  }
  if (relatedMission && missionRoute === "resume") {
    return await resumeAgentMission(getStore(), user, relatedMission.id, body.goal, turnDecision);
  }
  if (relatedMission && missionRoute === "keep_running") {
    return relatedMission;
  }
  if (relatedMission && missionRoute === "steer") {
    return await steerAgentMission(getStore(), user, relatedMission.id, body.goal, turnDecision);
  }
  return await createAgentPlan(getStore(), user, body.goal, context, onProgress);
}

// ---------------------------------------------------------------------------
// 资源中心（Resource Hub）：四类资源的统一目录 / 推荐 / 取真实地址 / 采纳埋点。
// 见 docs/RESOURCE-HUB-DESIGN.md。真实外链只有 reveal 一个出口。
// ---------------------------------------------------------------------------

const resourceSourceTypeSchema = z.enum([...RESOURCE_SOURCE_TYPES]);

/** 四源的中文名：warnings 与界面提示统一从这里取，别在各处写死。 */
const RESOURCE_SOURCE_LABELS: Record<ResourceSourceType, string> = {
  file: "文件中心",
  skill: "Skill 资源",
  knowledge: "智能体知识",
  product: "产品库"
};

const resourceListQuerySchema = z.object({
  q: z.string().trim().max(200).catch(""),
  sourceType: z.enum([...RESOURCE_SOURCE_TYPES, "all"]).catch("all"),
  category: z.string().trim().max(80).catch(""),
  fileType: z.string().trim().max(30).catch(""),
  limit: z.coerce.number().int().min(1).max(50).catch(20),
  offset: z.coerce.number().int().min(0).max(2000).catch(0),
  /** 传 "1" 时按可达性规则过滤（点了能拿到东西）。缺省不过滤 —— CRM 治理视图要能看到「待补链接」资料。 */
  reachable: z.enum(["0", "1"]).optional()
});

const resourceRecommendSchema = z.object({
  conversation: z.array(z.object({
    role: z.enum(["customer", "agent"]),
    text: z.string().trim().min(1).max(2000)
  })).min(1).max(20),
  customerId: z.string().trim().max(64).optional().default(""),
  conversationKey: z.string().trim().max(120).optional().default(""),
  limit: z.number().int().min(1).max(20).optional().default(6),
  sourceTypes: z.array(resourceSourceTypeSchema).max(4).optional(),
  signal: z.enum(["inbound", "compose", "manual"]).optional().default("manual"),
  /** 缺省 null = 跟随服务端配置；true/false 由调用方强制 */
  useVector: z.boolean().nullable().optional().default(null),
  /** 调用方自带的查询向量（CRM 不需要 embedding 凭据也能做精排） */
  queryVector: z.array(z.number()).max(2048).optional()
});

const resourceRevealSchema = z.object({
  reason: z.string().trim().max(300).optional().default(""),
  conversationKey: z.string().trim().max(120).optional().default("")
});

const resourceFeedbackSchema = z.object({
  items: z.array(z.object({
    resourceId: z.string().trim().min(1).max(90),
    sourceType: resourceSourceTypeSchema,
    action: z.enum(["accepted", "dismissed", "sent"])
  })).min(1).max(20),
  conversationKey: z.string().trim().max(120).optional().default("")
});

/**
 * 目录快照一份最多回多少条。
 *
 * 与 `resource-hub.ts::MAX_SCAN_PER_SOURCE` 同量级（400）：两个数字要是一大一小，
 * 「目录里没有但推荐里有」这种解释不清的现象就会出现。截断**必须明说**
 * （返回 `truncated`），静默截断正是这套治理要修掉的那类毛病。
 */
const MAX_RESOURCE_CATALOG_ITEMS = 400;

/**
 * 目录快照的查询参数。
 *
 * `since` 是**增量游标**：传上次响应的 `revision.latestUpdatedAt` 就只回变过的条目。
 * 刻意不做 offset 分页 —— 插件要的是一份「能画类目树、能提示质量」的快照，
 * 切片拼不出完整的类目树；条目本身另有 `limit` 封顶，且截断数会明说。
 */
const resourceCatalogQuerySchema = z.object({
  since: z.string().trim().max(40).catch(""),
  limit: z.coerce.number().int().min(1).max(MAX_RESOURCE_CATALOG_ITEMS).catch(200)
});

/** 本团队的「已发给客户」先验；读不到就返回空表，不影响检索。 */
async function resourceHubSentCounts(teamId: string): Promise<Map<string, number>> {
  const repository = getResourceHubRepository();
  if (!repository) return new Map();
  try {
    return await repository.sentCounts(teamId);
  } catch {
    return new Map();
  }
}

/** 反馈回流摘要的缓存时长。报表与排序共用，避免每次推荐都全表 GROUP BY。 */
const RESOURCE_FEEDBACK_CACHE_TTL_MS = 60_000;

let resourceFeedbackCache: {
  teamId: string;
  at: number;
  data: Map<string, { revealed: number; accepted: number; dismissed: number }>;
} | null = null;

/**
 * 近 30 天反馈摘要（P3-2 的输入）。键 `${sourceType}:${id}`。
 *
 * 反馈是**旁路**：读不到就返回空表，排序照常进行 —— 不能因为埋点表有问题
 * 就让业务员看不到推荐。缓存 60s，报表 Tab 也复用同一份。
 */
async function resourceHubFeedbackSummary(teamId: string) {
  const now = Date.now();
  if (resourceFeedbackCache && resourceFeedbackCache.teamId === teamId
    && now - resourceFeedbackCache.at < RESOURCE_FEEDBACK_CACHE_TTL_MS) {
    return resourceFeedbackCache.data;
  }
  const data = new Map<string, { revealed: number; accepted: number; dismissed: number }>();
  const repository = getResourceHubRepository();
  if (!repository) return data;
  try {
    const stats = await repository.eventStats(teamId, new Date(now - 30 * 86_400_000));
    for (const entry of stats.values()) {
      data.set(resourceKey(entry.resourceType, entry.resourceId), {
        revealed: entry.revealed,
        accepted: entry.accepted,
        dismissed: entry.dismissed
      });
    }
    resourceFeedbackCache = { teamId, at: now, data };
  } catch {
    // 读不到就不加权（保留上一次缓存也无意义：宁可这次保守）
  }
  return data;
}

/**
 * 词法归一化 v2 开关（P3-1）。默认**关** —— 核心排序变更不拿业务员体感赌，
 * 先开关上线、用回测脚本对完 Top5 重合度再打开。
 */
function resourceLexicalV2Enabled() {
  const raw = String(process.env.RESOURCE_LEXICAL_V2 || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * 结构化信号：全部来自**真实往来数据**，不猜客户属性。
 * ① 该客户历史报价单里的产品词  ② 当前会话里已经发过/取过的资料（靠 conversationKey）
 */
function resourceHubCustomerSignals(actor: SessionUser, customerId: string) {
  const store = getStore();
  const terms = new Set<string>();
  if (customerId) {
    const customer = store.customers.find((item) => item.id === customerId && item.teamId === actor.teamId);
    if (customer && canSeeOwner(actor, customer.ownerId, customer.teamId)) {
      const records = store.quoteHistory.filter((row) => row.customerId === customerId && row.teamId === actor.teamId);
      for (const record of records) {
        for (const item of record.items || []) {
          for (const term of resourceTerms(`${item.product || ""} ${item.model || ""}`)) terms.add(term);
        }
        for (const term of resourceTerms(record.dealTitle || "")) terms.add(term);
      }
    }
  }
  return { customerProductTerms: terms };
}

export function registerAgentRoutes(app: Express) {
  app.get("/api/agent/catalog", requireAuth, (_req, res) => {
    res.json({ tools: agentCatalog() });
  });

  app.get("/api/agent/outreach-sequences", requireAuth, (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
    res.json({ sequences: listOutreachSequences(getStore(), req.user!, limit) });
  });

  app.post("/api/agent/outreach-sequences/:id/:action", requireAuth, asyncRoute(async (req, res) => {
    const action = z.enum(["pause", "resume", "cancel"]).parse(req.params.action);
    const sequence = await controlOutreachSequence(getStore(), req.user!, req.params.id, action);
    void activeOutreachSequenceRunner?.synchronize();
    res.json({ sequence });
  }));

  app.get("/api/agent/customer-maintenance", requireAuth, (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
    res.json({ watches: listCustomerMaintenanceWatches(getStore(), req.user!, limit) });
  });

  // —— 自动维护中心（界面直连）———————————————————————————————
  // 设计文档 W1：后端引擎早已在跑，这里只补"看得见 + 可控制"所需的入口。
  // 创建不走 Agent 审批流（站内动作），发信等外部动作仍由发信批次冻结确认。
  // 注意：`/preview` 与 `/:id/run` 必须注册在 `/:id/:action` 之前，否则会被它抢先匹配。

  app.post("/api/agent/customer-maintenance/preview", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ rules: z.record(z.unknown()).optional() }).parse(req.body || {});
    res.json(previewCustomerMaintenance(getStore(), req.user!, (body.rules || {}) as Record<string, unknown>));
  }));

  app.post("/api/agent/customer-maintenance", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      name: z.string().trim().min(1).max(120).optional(),
      rules: z.record(z.unknown()).optional()
    }).parse(req.body || {});
    const watch = await createCustomerMaintenanceWatchDirect(getStore(), req.user!, {
      name: body.name || "客户自动维护",
      rules: body.rules || {}
    });
    void activeCustomerMaintenanceRunner?.synchronize();
    res.status(201).json({ watch });
  }));

  app.post("/api/agent/customer-maintenance/:id/run", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const watch = customerMaintenanceWatchFor(store, req.user!, req.params.id);
    if (!watch) {
      res.status(404).json({ message: "客户守护策略不存在或无权访问" });
      return;
    }
    const result = await runCustomerMaintenanceWatch(store, watch);
    res.json({
      watch: result.watch,
      findings: result.findings,
      created: result.created,
      skippedCount: result.skippedCount
    });
  }));

  app.get("/api/agent/customer-maintenance/:id/findings", requireAuth, asyncRoute(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(req.query.limit);
    const store = getStore();
    if (!customerMaintenanceWatchFor(store, req.user!, req.params.id)) {
      res.status(404).json({ message: "客户守护策略不存在或无权访问" });
      return;
    }
    res.json(listCustomerMaintenanceFindings(store, req.user!, req.params.id, limit));
  }));

  app.post("/api/agent/customer-maintenance/:id/:action", requireAuth, asyncRoute(async (req, res) => {
    const action = z.enum(["pause", "resume", "cancel"]).parse(req.params.action);
    const watch = await controlCustomerMaintenanceWatch(getStore(), req.user!, req.params.id, action);
    void activeCustomerMaintenanceRunner?.synchronize();
    res.json({ watch });
  }));

  app.get("/api/agent/sales-distillation/sources", requireAuth, (req, res) => {
    res.json({ sources: listDistillationSources(getStore(), req.user!) });
  });

  app.get("/api/agent/sales-training", requireAuth, (req, res) => {
    res.json({ runs: listSalesTrainingRuns(getStore(), req.user!) });
  });

  app.get("/api/agent/sales-training/:id", requireAuth, (req, res) => {
    res.json({ run: getSalesTrainingRun(getStore(), req.user!, req.params.id) });
  });

  app.post("/api/agent/sales-training", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ sourceUserId: z.string().min(1).max(100), periodDays: z.coerce.number().int().min(7).max(365).optional().default(90) }).parse(req.body || {});
    const run = await createSalesTrainingRun(getStore(), req.user!, body.sourceUserId, body.periodDays);
    void activeSalesTrainingRunner?.synchronize();
    res.status(201).json({ run });
  }));

  app.post("/api/agent/sales-training/:id/:action", requireAuth, asyncRoute(async (req, res, next) => {
    const parsed = z.enum(["pause", "resume", "cancel", "retrain", "publish"]).safeParse(req.params.action);
    if (!parsed.success) return next();
    try {
      if (parsed.data === "retrain") {
        const run = await retrainSalesTrainingRun(getStore(), req.user!, req.params.id);
        void activeSalesTrainingRunner?.synchronize();
        res.status(201).json({ run });
        return;
      }
      if (parsed.data === "publish") {
        const result = await publishSalesTrainingRun(getStore(), req.user!, req.params.id);
        res.json(result);
        return;
      }
      const run = await controlSalesTrainingRun(getStore(), req.user!, req.params.id, parsed.data);
      if (parsed.data === "resume") void activeSalesTrainingRunner?.synchronize();
      res.json({ run });
    } catch (error) {
      const message = error instanceof Error ? error.message : "销售训练操作失败";
      res.status(/无权|主管|管理员/u.test(message) ? 403 : 400).json({ message });
    }
  }));

  app.patch("/api/agent/sales-training/:id/samples/:sampleId", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ label: z.enum(["positive", "negative", "neutral"]).optional(), included: z.boolean().optional(), managerNote: z.string().max(500).optional() }).parse(req.body || {});
    const run = await updateSalesTrainingSample(getStore(), req.user!, req.params.id, req.params.sampleId, body);
    res.json({ run });
  }));

  app.get("/api/agent/sales-distillation", requireAuth, (req, res) => {
    res.json({
      distillations: listSalesDistillations(getStore(), req.user!),
      activations: listSalesPlaybookActivations(getStore(), req.user!)
    });
  });

  app.post("/api/agent/sales-distillation", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      sourceUserId: z.string().min(1).max(100),
      periodDays: z.coerce.number().int().min(7).max(365).optional().default(90)
    }).parse(req.body || {});
    const distillation = await createSalesDistillation(getStore(), req.user!, body.sourceUserId, body.periodDays);
    res.status(201).json({ distillation });
  }));

  app.post("/api/agent/sales-distillation/:id/publish", requireAuth, asyncRoute(async (req, res) => {
    try {
      const distillation = await publishSalesDistillation(getStore(), req.user!, req.params.id);
      res.json({ distillation });
    } catch (error) {
      const message = error instanceof Error ? error.message : "发布蒸馏打法失败";
      res.status(/无权|需要主管|不存在/u.test(message) ? 403 : 400).json({ message });
    }
  }));

  app.post("/api/agent/sales-distillation/:id/activate", requireAuth, asyncRoute(async (req, res) => {
    const activation = await activateSalesPlaybook(getStore(), req.user!, req.params.id);
    res.json({ activation, activations: listSalesPlaybookActivations(getStore(), req.user!) });
  }));

  app.post("/api/agent/sales-distillation/activations/:id/pause", requireAuth, asyncRoute(async (req, res) => {
    const activation = await pauseSalesPlaybook(getStore(), req.user!, req.params.id);
    res.json({ activation, activations: listSalesPlaybookActivations(getStore(), req.user!) });
  }));

  app.post("/api/agent/plan", requireAuth, asyncRoute(async (req, res) => {
    const body = agentPlanRequestSchema.parse(req.body || {});
    const run = await resolveAgentPlanRequest(req.user!, body);
    void activeAgentBackgroundRunner?.synchronize();
    res.status(201).json({ run, context: body.context });
  }));

  app.post("/api/agent/plan/stream", requireAuth, asyncRoute(async (req, res) => {
    const body = agentPlanRequestSchema.parse(req.body || {});
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const send = (eventName: string, payload: unknown) => {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
      (res as Response & { flush?: () => void }).flush?.();
    };
    try {
      const run = await resolveAgentPlanRequest(req.user!, body, (progress) => send("progress", progress));
      void activeAgentBackgroundRunner?.synchronize();
      send("complete", { run, context: body.context });
    } catch (error) {
      send("error", { message: error instanceof Error ? error.message : "Agent 任务理解失败" });
    } finally {
      res.end();
    }
  }));

  app.get("/api/agent/runs", requireAuth, (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
    const conversationId = z.string().trim().max(100).catch("").parse(req.query.conversationId);
    res.json({ runs: listAgentRuns(getStore(), req.user!, limit, conversationId) });
  });

  app.get("/api/agent/conversations", requireAuth, (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).catch(30).parse(req.query.limit);
    res.json({ conversations: listAgentConversations(getStore(), req.user!, limit) });
  });

  app.get("/api/agent/skills", requireAuth, (req, res) => {
    const query = z.string().trim().max(500).catch("").parse(req.query.query);
    const activeView = z.string().trim().max(80).catch("").parse(req.query.activeView);
    const all = listAgentSkills({ includeInactive: true });
    const matched = query
      ? new Set(selectAgentSkills(query, { activeView, limit: 4 }).map((skill) => skill.id))
      : new Set<string>();
    res.json({
      directory: process.env.AGENT_SKILLS_DIR || "agent-skills",
      skills: all.map((skill) => ({
        ...publicAgentSkill(skill),
        matched: matched.has(skill.id)
      }))
    });
  });

  app.get("/api/agent/skills/:id", requireAuth, (req, res) => {
    const id = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/u).parse(req.params.id);
    const skill = getAgentSkill(id);
    if (!skill) {
      res.status(404).json({ message: "Skill 不存在" });
      return;
    }
    res.json({ skill: publicAgentSkill(skill, true) });
  });

  app.get("/api/agent/skill-resources", requireAuth, (req, res) => {
    const canManage = canManageSkillResources(req.user);
    const resources = getStore().skillResources.filter((item) =>
      item.teamId === req.user!.teamId && (canManage || item.status === "published")
    ).map((item) => canManage ? item : {
      ...item,
      downloadUrl: "",
      extractionCode: "",
      downloadAvailable: Boolean(item.downloadUrl)
    });
    res.json({ resources, canManage });
  });

  app.post("/api/agent/skill-resources", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageSkillResources(req.user)) {
      res.status(403).json({ message: "当前账号没有上架 Skill 的权限" });
      return;
    }
    const body = skillResourceInputSchema.parse(req.body || {});
    let downloadUrl = "";
    try {
      downloadUrl = normalizeSkillResourceUrl(body.downloadUrl);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message.replaceAll("资料", "Skill") : "Skill 下载链接无效" });
      return;
    }
    const now = new Date().toISOString();
    const resource = {
      id: `skr_${randomUUID()}`,
      ...body,
      downloadUrl,
      tags: [...new Set(body.tags)],
      status: "draft" as const,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      accessCount: 0,
      createdAt: now,
      updatedAt: now
    };
    getStore().skillResources.unshift(resource);
    await getStore().persist();
    res.status(201).json({ resource });
  }));

  app.patch("/api/agent/skill-resources/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageSkillResources(req.user)) {
      res.status(403).json({ message: "当前账号没有维护 Skill 的权限" });
      return;
    }
    const resource = getStore().skillResources.find((item) => item.id === req.params.id && item.teamId === req.user!.teamId);
    if (!resource) {
      res.status(404).json({ message: "Skill 资源不存在" });
      return;
    }
    const body = skillResourceInputSchema.partial().parse(req.body || {});
    let downloadUrl = resource.downloadUrl;
    if (body.downloadUrl !== undefined) {
      try {
        downloadUrl = normalizeSkillResourceUrl(body.downloadUrl);
      } catch (error) {
        res.status(400).json({ message: error instanceof Error ? error.message.replaceAll("资料", "Skill") : "Skill 下载链接无效" });
        return;
      }
    }
    Object.assign(resource, body, {
      downloadUrl,
      ...(body.tags ? { tags: [...new Set(body.tags)] } : {}),
      updatedAt: new Date().toISOString()
    });
    await getStore().persist();
    res.json({ resource });
  }));

  app.patch("/api/agent/skill-resources/:id/status", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageSkillResources(req.user)) {
      res.status(403).json({ message: "当前账号没有发布 Skill 的权限" });
      return;
    }
    const status = z.enum(["draft", "published", "archived"]).parse(req.body?.status);
    const resource = getStore().skillResources.find((item) => item.id === req.params.id && item.teamId === req.user!.teamId);
    if (!resource) {
      res.status(404).json({ message: "Skill 资源不存在" });
      return;
    }
    resource.status = status;
    resource.updatedAt = new Date().toISOString();
    await getStore().persist();
    res.json({ resource });
  }));

  app.post("/api/agent/skill-resources/:id/access", requireAuth, asyncRoute(async (req, res) => {
    const canManage = canManageSkillResources(req.user);
    const resource = getStore().skillResources.find((item) =>
      item.id === req.params.id && item.teamId === req.user!.teamId && (canManage || item.status === "published")
    );
    if (!resource) {
      res.status(404).json({ message: "Skill 资源不存在或尚未发布" });
      return;
    }
    try {
      resource.downloadUrl = normalizeSkillResourceUrl(resource.downloadUrl);
    } catch {
      res.status(409).json({ message: "Skill 下载链接已失效，请联系维护人更新" });
      return;
    }
    resource.accessCount += 1;
    resource.lastAccessedAt = new Date().toISOString();
    await getStore().persist();
    res.json({ resource, access: { url: resource.downloadUrl, extractionCode: resource.extractionCode } });
  }));

  app.delete("/api/agent/skill-resources/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageSkillResources(req.user)) {
      res.status(403).json({ message: "当前账号没有删除 Skill 的权限" });
      return;
    }
    const index = getStore().skillResources.findIndex((item) => item.id === req.params.id && item.teamId === req.user!.teamId);
    if (index < 0) {
      res.status(404).json({ message: "Skill 资源不存在" });
      return;
    }
    const [resource] = getStore().skillResources.splice(index, 1);
    await getStore().persist();
    res.json({ resource, deleted: true });
  }));

  app.post("/api/agent/tuning/inspect", requireAuth, (req, res) => {
    const body = z.object({
      goal: z.string().trim().min(2).max(2_000),
      context: z.object({
        activeView: z.string().trim().max(80).optional(),
        selectedCustomerId: z.string().trim().max(120).optional(),
        selectedDealId: z.string().trim().max(120).optional(),
        selectedLeadId: z.string().trim().max(120).optional()
      }).strict().optional().default({})
    }).parse(req.body || {});
    const goalSpec = compileAgentGoalSpec(body.goal, body.context);
    const skillMatches = rankAgentSkills(body.goal, {
      activeView: body.context.activeView,
      goalSpec,
      limit: 4
    });
    const knowledgeHits = retrieveAgentKnowledge(getStore(), req.user!, body.goal, {
      activeView: body.context.activeView,
      limit: 6,
      trackUsage: false
    });
    const toolRefs = [...new Set(skillMatches.flatMap((item) => item.skill.toolRefs))];
    res.json({
      goalSpec,
      skills: skillMatches.map((item) => ({
        id: item.skill.id,
        name: item.skill.name,
        version: item.skill.version,
        score: Math.round(item.score),
        reasons: item.reasons,
        toolRefs: item.skill.toolRefs
      })),
      knowledge: knowledgeHits.map((item) => ({
        id: item.document.id,
        title: item.document.title,
        module: item.document.module,
        version: item.document.version,
        score: Number(item.score.toFixed(2)),
        reasons: item.reasons
      })),
      toolRefs,
      authorization: goalSpec.authorization
    });
  });

  app.get("/api/agent/memories", requireAuth, (req, res) => {
    const query = z.object({
      status: z.enum(["proposed", "active", "archived", "all"]).catch("all"),
      type: z.enum(["user_preference", "company_knowledge", "customer_memory", "team_playbook", "all"]).catch("all"),
      subjectId: z.string().trim().max(120).catch(""),
      query: z.string().trim().max(200).catch("")
    }).parse(req.query);
    res.json({ memories: listAgentMemories(getStore(), req.user!, query) });
  });

  app.post("/api/agent/memories", requireAuth, asyncRoute(async (req, res) => {
    const memory = await proposeAgentMemory(getStore(), req.user!, req.body || {});
    res.status(201).json({ memory });
  }));

  app.patch("/api/agent/memories/:id", requireAuth, asyncRoute(async (req, res) => {
    const memory = await updateAgentMemory(getStore(), req.user!, req.params.id, req.body || {});
    res.json({ memory });
  }));

  app.post("/api/agent/memories/:id/activate", requireAuth, asyncRoute(async (req, res) => {
    const memory = await setAgentMemoryStatus(getStore(), req.user!, req.params.id, "active");
    res.json({ memory });
  }));

  app.post("/api/agent/memories/:id/archive", requireAuth, asyncRoute(async (req, res) => {
    const memory = await setAgentMemoryStatus(getStore(), req.user!, req.params.id, "archived");
    res.json({ memory });
  }));

  app.delete("/api/agent/memories/:id", requireAuth, asyncRoute(async (req, res) => {
    const memory = await deleteAgentMemory(getStore(), req.user!, req.params.id);
    res.json({ deleted: memory.id });
  }));

  app.get("/api/agent/knowledge/overview", requireAuth, (req, res) => {
    res.json(agentKnowledgeOverview(getStore(), req.user!));
  });

  app.get("/api/agent/knowledge/documents", requireAuth, (req, res) => {
    const query = z.object({
      status: z.enum(["draft", "review", "published", "archived", "all"]).catch("all"),
      kind: z.enum(["system", "module", "workflow", "policy", "field", "playbook", "failure_case", "all"]).catch("all"),
      module: z.string().trim().max(80).catch(""),
      query: z.string().trim().max(200).catch("")
    }).parse(req.query);
    const actor = req.user!;
    const documents = listAgentKnowledgeDocuments(getStore(), actor, query).map((document) => ({
      ...document,
      canEdit: document.sourceType !== "system_file"
        && hasIamPermission(actor, "agent.manage")
        && canSeeOwner(actor, document.ownerId, document.teamId)
    }));
    res.json({ documents });
  });

  app.get("/api/agent/knowledge/search", requireAuth, (req, res) => {
    const query = z.object({
      query: z.string().trim().min(1).max(500),
      activeView: z.string().trim().max(80).catch(""),
      limit: z.coerce.number().int().min(1).max(12).catch(8)
    }).parse(req.query);
    const hits = retrieveAgentKnowledge(getStore(), req.user!, query.query, {
      activeView: query.activeView,
      limit: query.limit,
      trackUsage: false
    });
    res.json({ hits: hits.map((hit) => ({ document: hit.document, score: hit.score, reasons: hit.reasons })) });
  });

  app.post("/api/agent/knowledge/documents", requireAuth, asyncRoute(async (req, res) => {
    const document = await createAgentKnowledgeDraft(getStore(), req.user!, req.body || {});
    res.status(201).json({ document });
  }));

  app.patch("/api/agent/knowledge/documents/:id", requireAuth, asyncRoute(async (req, res) => {
    const document = await updateAgentKnowledgeDraft(getStore(), req.user!, req.params.id, req.body || {});
    res.json({ document });
  }));

  app.post("/api/agent/knowledge/documents/:id/:action", requireAuth, asyncRoute(async (req, res) => {
    const action = z.enum(["submit", "publish", "archive"]).parse(req.params.action);
    const document = await setAgentKnowledgeStatus(getStore(), req.user!, req.params.id, action);
    res.json({ document });
  }));

  app.get("/api/agent/resources", requireAuth, (req, res) => {
    const query = resourceListQuerySchema.parse(req.query);
    const actor = req.user!;
    const started = Date.now();
    const resources = collectHubResources(getStore(), actor, {
      sourceTypes: query.sourceType === "all" ? undefined : [query.sourceType as ResourceSourceType],
      category: query.category,
      fileType: query.fileType
    });
    // 插件面板的目录检索传 reachable=1：别把点了拿不到东西的资料摆给业务员。
    // CRM 自己的目录（治理对象包含「待补链接」）不传，保持全量可见。
    const visible = query.reachable === "1" ? resources.filter(resourceReachable) : resources;
    const ranked = scoreHubResources(visible, { query: query.q, limit: query.offset + query.limit + 1 });
    const page = ranked.slice(query.offset, query.offset + query.limit);
    res.json({
      resources: page,
      total: visible.length,
      nextCursor: ranked.length > query.offset + query.limit
        ? page[page.length - 1]
          ? `${page[page.length - 1].updatedAt}|${page[page.length - 1].id}`
          : null
        : null,
      retrievalMode: "weighted-lexical",
      vectorEnabled: false,
      tookMs: Date.now() - started
    });
  });

  /**
   * 资料库目录快照 —— 面向插件（3100）的「文件中心」只读视图，**含治理口径**。
   *
   * 与 `GET /api/agent/resources` 的分工很清楚：那个回答「这次该发哪几份」
   * （四源混合 + 打分排序，给推荐位用），这个回答「资料库里有什么、治理到什么程度」。
   * 它**只覆盖 `knowledge_assets` 一个源** —— 插件面板要画的类目树、要提示的
   * 「N 份未校订」「M 份缺链接」必须和 CRM 文件中心同一个口径；把 skill / 产品 /
   * 智能体知识混进来，这些数字就对不上账，治理提示也就没人信了。
   *
   * 三件必须守住的事：
   * 1. `items` 只给 **published**：目录要能展示「待补链接」的资料（那是治理对象本身），
   *    但草稿 / 已归档不给 —— 插件点 reveal 取不到（`collectKnowledgeAssets` 只收
   *    published），摆出来就是个必然 404 的按钮。而 `governance` 计数按**全量可见**算，
   *    否则「草稿 8 份」这种该催的数字永远看不见。
   * 2. `since` 是增量游标：响应里的 `revision.latestUpdatedAt` 就是下次该传的值。
   * 3. 计数口径与 `GET /api/knowledge/assets/governance` **同源**
   *    （`canSeeKnowledgeAsset` + `knowledgeQualityFlags`）。两处口径分叉比没有接口更糟。
   *
   * 不返回任何 `sourceUrl`：真实地址的唯一出口仍然是 `/reveal`（RESOURCE-HUB-DESIGN §「真实外链只有一个出口」）。
   */
  app.get("/api/agent/resources/catalog", requireAuth, asyncRoute(async (req, res) => {
    const query = resourceCatalogQuerySchema.parse(req.query);
    const actor = req.user!;
    const store = getStore();
    const warnings: string[] = [];

    const visible = store.knowledgeAssets.filter((asset) => canSeeKnowledgeAsset(actor, asset));
    const published = visible.filter((asset) => asset.status === "published");

    // ---- 治理计数：全量可见（含草稿 / 待审 / 已归档）—— 要催的正是这几个数 ----
    const counts = {
      total: visible.length,
      published: published.length,
      draft: visible.filter((asset) => asset.status === "draft").length,
      review: visible.filter((asset) => asset.status === "review").length,
      archived: visible.filter((asset) => asset.status === "archived").length
    };

    const qualityFlags: Record<string, number> = {};
    const byCategory = new Map<string, { category: string; total: number; verified: number; missingLink: number }>();
    let verified = 0;
    let missingLink = 0;
    for (const asset of published) {
      const label = asset.category || "未分类";
      const bucket = byCategory.get(label) ?? { category: label, total: 0, verified: 0, missingLink: 0 };
      bucket.total += 1;
      if (asset.verified) {
        verified += 1;
        bucket.verified += 1;
      }
      if (!knowledgeAssetHasLink(asset)) {
        missingLink += 1;
        bucket.missingLink += 1;
      }
      for (const flag of knowledgeQualityFlags(asset)) qualityFlags[flag] = (qualityFlags[flag] || 0) + 1;
      byCategory.set(label, bucket);
    }

    // 孤儿：owner 已不存在（团队归属无从判定）—— 与迁移里的 orphanIds 同口径
    const orphans = visible.filter((asset) => !store.users.some((user) => user.id === asset.ownerId)).length;

    // ---- 条目：只看 published，按 updatedAt 倒序；给了 since 就只出变过的 ----
    const updatedAtOf = (asset: { updatedAt?: string; createdAt?: string }) => String(asset.updatedAt || asset.createdAt || "");
    const ordered = [...published].sort((left, right) => updatedAtOf(right).localeCompare(updatedAtOf(left)));
    const changed = query.since ? ordered.filter((asset) => updatedAtOf(asset) > query.since) : ordered;
    const page = changed.slice(0, query.limit);

    const items = page.map((asset) => ({
      id: asset.id,
      title: asset.title,
      category: asset.category || "",
      tags: [...(asset.tags ?? [])],
      description: asset.description || "",
      fileType: asset.fileType || "other",
      version: asset.version || "",
      status: asset.status,
      verified: asset.verified === true,
      /** 两池归属，与检索排序同一口径：已校订进核心池，未校订的留在长尾池。 */
      pool: asset.verified === true ? ("core" as const) : ("longtail" as const),
      hasExternalLink: knowledgeAssetHasLink(asset),
      qualityFlags: knowledgeQualityFlags(asset),
      accessCount: Number(asset.accessCount || 0),
      author: store.users.find((user) => user.id === asset.ownerId)?.name || "",
      createdAt: String(asset.createdAt || ""),
      updatedAt: updatedAtOf(asset)
    }));

    // ---- 词表：插件画类目筛选 / 标签 chips 用。读不到就降级，绝不 500 ----
    let vocabulary: {
      categories: Array<{ value: string; usageCount: number }>;
      tags: Array<{ value: string; usageCount: number }>;
    } = { categories: [], tags: [] };
    try {
      const entries = await getKnowledgeGovernanceRepository().list(actor.teamId);
      const pick = (type: "category" | "tag") =>
        entries
          .filter((entry) => entry.type === type && entry.enabled)
          .sort((left, right) => right.usageCount - left.usageCount || left.value.localeCompare(right.value))
          .map((entry) => ({ value: entry.value, usageCount: entry.usageCount }));
      vocabulary = { categories: pick("category"), tags: pick("tag") };
    } catch {
      // 词表是旁路：拿不到时插件仍能用 items 里的 category 现凑类目，不该让整个目录作废
      warnings.push("词表未取到");
    }

    const latestUpdatedAt = ordered.length ? updatedAtOf(ordered[0]) : "";
    res.json({
      revision: {
        generatedAt: new Date().toISOString(),
        /** 下次请求该传的 `since`。空串 = 目录里一份 published 都没有。 */
        latestUpdatedAt,
        total: counts.published,
        /**
         * 治理口径摘要。插件拿它当「要不要重画面板」的廉价判据 ——
         * 比逐字段 diff 省事，也比只看 latestUpdatedAt 稳（归档这类动作改了计数、
         * 却未必动 updatedAt，只看时间戳会漏掉）。
         */
        fingerprint: `${counts.total}:${counts.published}:${counts.archived}:${verified}:${missingLink}:${latestUpdatedAt}`
      },
      vocabulary,
      governance: {
        ...counts,
        verified,
        unverified: counts.published - verified,
        /** 两池：核心池 = 已校订（检索 ×1.0），长尾池 = 未校订（检索 ×0.5）。 */
        corePool: verified,
        longTailPool: counts.published - verified,
        missingLink,
        orphans,
        qualityFlags,
        byCategory: [...byCategory.values()].sort((left, right) => right.total - left.total || left.category.localeCompare(right.category))
      },
      items,
      /** 本次因 `limit` 未返回的条数（>0 时插件应当提示「目录未看全」）。 */
      truncated: Math.max(0, changed.length - page.length),
      warnings
    });
  }));

  app.post("/api/agent/resources/recommend", requireAuth, asyncRoute(async (req, res) => {
    const body = resourceRecommendSchema.parse(req.body || {});
    const actor = req.user!;
    const started = Date.now();
    const warnings: string[] = [];

    const collection = collectHubResourcesDetailed(getStore(), actor, { sourceTypes: body.sourceTypes });
    // 可达性闸：推荐位只给「点了能拿到东西」的资料（G5）。
    // reveal 路径不过滤 —— 没链接的资料在推荐里消失后，用户连 409 的原因都看不到。
    const reachable = collection.resources.filter(resourceReachable);
    const unreachableSkipped = collection.resources.length - reachable.length;
    // 截断可见化（G6）：第 401 份起不进候选集，必须让用户知道，不能静默。
    for (const [sourceType, dropped] of Object.entries(collection.truncated)) {
      if (!dropped) continue;
      warnings.push(`${RESOURCE_SOURCE_LABELS[sourceType as ResourceSourceType]}有 ${dropped} 份资料因更新过早未进入本次候选`);
    }
    const resources = reachable;
    // 客户的话是主信号，业务员自己的话作补充（业务员常在复述客户需求）
    const customerText = body.conversation.filter((item) => item.role === "customer").map((item) => item.text);
    const agentText = body.conversation.filter((item) => item.role === "agent").map((item) => item.text);
    const query = [...customerText, ...agentText].join("\n");

    const sentCounts = await resourceHubSentCounts(actor.teamId);
    const signals = resourceHubCustomerSignals(actor, body.customerId);
    const feedback = await resourceHubFeedbackSummary(actor.teamId);
    let customerResourceKeys = new Set<string>();
    let dismissedKeys = new Set<string>();
    const repository = getResourceHubRepository();
    if (repository && body.conversationKey) {
      try {
        customerResourceKeys = await repository.customerResourceKeys(actor.teamId, body.conversationKey);
      } catch {
        warnings.push("会话历史信号未取到");
      }
      try {
        dismissedKeys = await repository.dismissedKeys(actor.teamId, body.conversationKey);
      } catch {
        // 单独 try：查看史拿到了、否决史没拿到，不该让整段历史信号作废
      }
    }

    const baseOptions = {
      query,
      limit: MAX_RESOURCE_VECTOR_CANDIDATES,
      sentCounts,
      customerResourceKeys,
      dismissedKeys,
      feedback,
      lexicalV2: resourceLexicalV2Enabled(),
      customerProductTerms: signals.customerProductTerms
    };

    // 第一遍：词法 + 结构化 + 语义。向量开启时这一遍同时充当预筛。
    const prefiltered = scoreHubResources(resources, baseOptions);

    let recommendations = prefiltered.slice(0, body.limit);
    let vectorEnabled = false;

    /**
     * 向量通道（G9）：`saveEmbeddings` 目前全项目无调用方，`resource_embeddings` 是空表，
     * 所以这条分支走不到、权重表里的 vector 0.12 暂不生效。这里把门槛改成**显式 opt-in**
     * （`useVector === true`），不再让"默认跟随配置"掩盖它其实是死代码这件事。
     * 要真正启用向量通道，先补上 embedding 回填任务，再改这里。
     */
    if (body.useVector === true && body.queryVector?.length && repository) {
      const bySource = new Map<ResourceSourceType, string[]>();
      for (const row of prefiltered) {
        const list = bySource.get(row.sourceType) || [];
        list.push(row.id);
        bySource.set(row.sourceType, list);
      }
      const vectors = new Map<string, Float32Array>();
      for (const [sourceType, ids] of bySource) {
        try {
          const loaded = await repository.loadEmbeddings(RESOURCE_HUB_EMBEDDING_MODEL, sourceType, ids);
          for (const [key, value] of loaded) vectors.set(key, value.vector);
        } catch {
          warnings.push(`向量读取失败（${sourceType}）`);
        }
      }
      if (vectors.size) {
        const queryVector = Float32Array.from(body.queryVector.slice(0, 2048));
        recommendations = scoreHubResources(
          resources.filter((row) => vectors.has(resourceKey(row.sourceType, row.id))),
          { ...baseOptions, vectors, queryVector }
        ).slice(0, body.limit);
        vectorEnabled = true;
      }
    } else if (body.useVector === true && !body.queryVector?.length) {
      warnings.push("未提供查询向量，本次退化为词法检索");
    }

    // 曝光埋点（旁路，失败不影响返回）
    void recordResourceHubEvents(recommendations.map((row) => ({
      ownerId: actor.id,
      teamId: actor.teamId,
      conversationKey: body.conversationKey,
      resourceType: row.sourceType,
      resourceId: row.id,
      eventType: "exposed" as const,
      score: row.score,
      channel: body.signal
    })));

    const customerId = body.customerId;
    const customer = customerId
      ? getStore().customers.find((item) => item.id === customerId && item.teamId === actor.teamId)
      : undefined;
    const matched = Boolean(customer && canSeeOwner(actor, customer.ownerId, customer.teamId));

    res.json({
      recommendations,
      retrieval: {
        mode: vectorEnabled ? "hybrid-lexical-vector" : "weighted-lexical",
        scanned: (body.sourceTypes?.length || RESOURCE_SOURCE_TYPES.length),
        candidates: resources.length,
        unreachableSkipped,
        vectorEnabled,
        tookMs: Date.now() - started
      },
      customer: matched ? { matched: true, id: customer!.id, company: customer!.company } : { matched: false, id: "", company: "" },
      warnings
    });
  }));

  app.post("/api/agent/resources/:sourceType/:id/reveal", requireAuth, asyncRoute(async (req, res) => {
    const parsed = resourceSourceTypeSchema.safeParse(req.params.sourceType);
    if (!parsed.success) {
      res.status(404).json({ message: "资源不存在或无权访问" });
      return;
    }
    const body = resourceRevealSchema.parse(req.body || {});
    const actor = req.user!;
    const store = getStore();
    const outcome = revealHubResource(store, actor, parsed.data, req.params.id);
    if (!outcome.ok) {
      if (outcome.reason === "no_link") {
        res.status(409).json({ message: "该资料尚未配置可访问的内容，请联系维护人补齐" });
        return;
      }
      res.status(404).json({ message: "资源不存在或无权访问" });
      return;
    }
    await store.persist();
    const accessId = `rae_${randomUUID().replace(/-/gu, "").slice(0, 24)}`;
    await recordResourceHubEvents([{
      id: accessId,
      ownerId: actor.id,
      teamId: actor.teamId,
      conversationKey: body.conversationKey,
      resourceType: parsed.data,
      resourceId: req.params.id,
      eventType: "revealed",
      channel: body.reason.slice(0, 30)
    }]);
    res.json({ resource: outcome.result.resource, access: outcome.result.access, accessId });
  }));

  app.post("/api/agent/resources/feedback", requireAuth, asyncRoute(async (req, res) => {
    const body = resourceFeedbackSchema.parse(req.body || {});
    const actor = req.user!;
    // 只接受当前账号可见的资源 id；不可见的一律静默丢弃（不给出「存在但你没权」的探测面）
    const visible = new Set(collectHubResources(getStore(), actor).map((row) => resourceKey(row.sourceType, row.id)));
    const items = body.items.filter((item) => visible.has(resourceKey(item.sourceType, item.resourceId)));
    const recorded = await recordResourceHubEvents(items.map((item) => ({
      ownerId: actor.id,
      teamId: actor.teamId,
      conversationKey: body.conversationKey,
      resourceType: item.sourceType,
      resourceId: item.resourceId,
      eventType: item.action
    })));
    res.json({ recorded, ignored: body.items.length - items.length });
  }));

  /**
   * 推荐效果报表（docs/RESOURCE-FEEDBACK-REPORT-DESIGN.md）。
   *
   * 口径（写进注释就是为了让以后的人别各算各的）：
   * - adoptionRate = accepted / max(1, revealed)、sendRate = sent / max(1, revealed)
   *   —— 分母都是 revealed：**看到了才谈得上采纳/发送**；exposed 只说明被推荐过。
   * - 全程 teamId 口径（与埋点写入同源），owner 维度不做隔离（同团队共享一份效果视图）。
   */
  app.get("/api/agent/resources/stats", requireAuth, asyncRoute(async (req, res) => {
    const actor = req.user!;
    const days = Math.min(90, Math.max(1, z.coerce.number().int().catch(30).parse(req.query.days)));
    const started = Date.now();
    const warnings: string[] = [];
    let stats = new Map<string, ResourceEventStatsEntry>();
    try {
      stats = await getResourceHubRepository().eventStats(actor.teamId, new Date(Date.now() - days * 86_400_000));
    } catch {
      // 统计是只读旁路：读不出就报"未取到"，绝不 500 把整个资源中心拖垮。
      warnings.push("埋点统计未取到");
    }

    const titleOf = new Map(
      collectHubResources(getStore(), actor).map((row) => [resourceKey(row.sourceType, row.id), row.title] as const)
    );

    const items = [...stats.values()]
      .map((entry) => {
        const denominator = Math.max(1, entry.revealed);
        return {
          sourceType: entry.resourceType,
          resourceId: entry.resourceId,
          title: titleOf.get(resourceKey(entry.resourceType, entry.resourceId)) ?? "（已移除）",
          counts: { exposed: entry.exposed, revealed: entry.revealed, accepted: entry.accepted, dismissed: entry.dismissed, sent: entry.sent },
          adoptionRate: Number((entry.accepted / denominator).toFixed(4)),
          sendRate: Number((entry.sent / denominator).toFixed(4))
        };
      })
      .sort((left, right) => right.adoptionRate - left.adoptionRate || right.counts.revealed - left.counts.revealed || left.resourceId.localeCompare(right.resourceId))
      .slice(0, 50);

    const totals = emptyEventCounts();
    for (const entry of stats.values()) {
      totals.exposed += entry.exposed;
      totals.revealed += entry.revealed;
      totals.accepted += entry.accepted;
      totals.dismissed += entry.dismissed;
      totals.sent += entry.sent;
    }
    const totalDenominator = Math.max(1, totals.revealed);
    res.json({
      days,
      totals: {
        ...totals,
        adoptionRate: Number((totals.accepted / totalDenominator).toFixed(4)),
        sendRate: Number((totals.sent / totalDenominator).toFixed(4))
      },
      items,
      warnings,
      tookMs: Date.now() - started
    });
  }));

  app.get("/api/agent/triggers", requireAuth, (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(req.query.limit);
    res.json({ rules: listAgentTriggerRules(getStore(), req.user!), events: listAgentTriggerEvents(getStore(), req.user!, limit) });
  });

  app.post("/api/agent/triggers", requireAuth, asyncRoute(async (req, res) => {
    const rule = await createAgentTriggerRule(getStore(), req.user!, req.body || {});
    void activeAgentTriggerRunner?.synchronize();
    res.status(201).json({ rule });
  }));

  app.patch("/api/agent/triggers/:id", requireAuth, asyncRoute(async (req, res) => {
    const rule = await updateAgentTriggerRule(getStore(), req.user!, req.params.id, req.body || {});
    res.json({ rule });
  }));

  app.post("/api/agent/triggers/:id/:action", requireAuth, asyncRoute(async (req, res) => {
    const action = z.enum(["pause", "resume", "run"]).parse(req.params.action);
    const store = getStore();
    const rule = listAgentTriggerRules(store, req.user!).find((item) => item.id === req.params.id);
    if (!rule) throw new Error("自动触发规则不存在或无权访问");
    if (action === "run") {
      const result = await runAgentTriggerRule(store, req.user!, rule, (actor, goal, context) => createAgentPlan(store, actor, goal, context));
      void activeAgentBackgroundRunner?.synchronize();
      res.json({ result, rules: listAgentTriggerRules(store, req.user!), events: listAgentTriggerEvents(store, req.user!, 50) });
      return;
    }
    const updated = await setAgentTriggerRuleStatus(store, req.user!, rule.id, action === "pause" ? "paused" : "active");
    if (action === "resume") void activeAgentTriggerRunner?.synchronize();
    res.json({ rule: updated });
  }));

  app.delete("/api/agent/triggers/:id", requireAuth, asyncRoute(async (req, res) => {
    const rule = await deleteAgentTriggerRule(getStore(), req.user!, req.params.id);
    res.json({ deleted: rule.id });
  }));

  app.get("/api/agent/governance", requireAuth, (req, res) => {
    res.json(agentModelMetrics(getStore(), req.user!));
  });

  app.post("/api/agent/evaluations/run", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const evaluation = await runAgentEvaluationSuite(store, req.user!, (goal, context) => createAgentPlan(store, req.user!, goal, context));
    res.json({ evaluation, metrics: agentModelMetrics(store, req.user!) });
  }));

  app.post("/api/agent/missions/:id/resume", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ message: z.string().trim().max(2_000).default("继续执行，保持原目标和完成标准") }).parse(req.body || {});
    const run = await resumeAgentMission(getStore(), req.user!, req.params.id, body.message);
    void activeAgentBackgroundRunner?.synchronize();
    res.json({ run });
  }));

  app.post("/api/agent/missions/:id/steer", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ message: z.string().trim().min(2).max(2_000) }).parse(req.body || {});
    const run = await steerAgentMission(getStore(), req.user!, req.params.id, body.message);
    void activeAgentBackgroundRunner?.synchronize();
    res.json({ run });
  }));

  app.get("/api/agent/missions/:id/checkpoints", requireAuth, (req, res) => {
    const limit = z.coerce.number().int().min(1).max(80).catch(30).parse(req.query.limit);
    res.json({ checkpoints: listAgentMissionCheckpoints(getStore(), req.user!, req.params.id, limit) });
  });

  app.post("/api/agent/missions/:id/checkpoints/:checkpointId/restore", requireAuth, asyncRoute(async (req, res) => {
    const run = await restoreAgentMissionCheckpoint(getStore(), req.user!, req.params.id, req.params.checkpointId);
    void activeAgentBackgroundRunner?.synchronize();
    res.json({ run, checkpoints: listAgentMissionCheckpoints(getStore(), req.user!, req.params.id, 30) });
  }));

  app.post("/api/agent/missions/:id/pause", requireAuth, asyncRoute(async (req, res) => {
    const run = await pauseAgentMission(getStore(), req.user!, req.params.id);
    res.json({ run });
  }));

  app.post("/api/agent/missions/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
    const run = await cancelAgentMission(getStore(), req.user!, req.params.id);
    res.json({ run });
  }));

  app.get("/api/agent/runs/:id", requireAuth, (req, res) => {
    try {
      res.json({ run: getAgentRun(getStore(), req.params.id, req.user!) });
    } catch (error) {
      res.status(404).json({ message: error instanceof Error ? error.message : "Agent 运行不存在" });
    }
  });

  app.post("/api/agent/execute", requireAuth, async (req, res, next) => {
    try {
      const body = z.object({
        runId: z.string().min(1).max(100),
        stepId: z.string().min(1).max(100),
        signature: z.string().min(1).max(200),
        approved: z.boolean().default(false)
      }).parse(req.body || {});
      const run = await executeAgentStep(
        getStore(),
        req.user!,
        body.runId,
        body.stepId,
        body.signature,
        body.approved,
        agentExecutionRuntime
      );
      void activeAgentBackgroundRunner?.synchronize();
      res.json({ run });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent 动作执行失败";
      if (/Agent (运行不存在|运行已过期|步骤不存在|步骤签名无效|步骤已被新指令替代)|需要确认|Mission 已停止/u.test(message)) {
        res.status(400).json({ message });
        return;
      }
      next(error);
    }
  });
}
