/**
 * AI 引擎任务、AI 背调、海外竞标日报路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { z } from "zod";
import { canSeeOwner, hasIamPermission, isPlatformIdentity, requireAuth } from "../auth.js";
import { AI_ENGINE_ADAPTERS, AI_ENGINE_CLI_EFFORTS, AI_ENGINE_CLI_MODELS, AI_ENGINE_CODEX_EFFORTS, AI_ENGINE_CODEX_MODELS, EMAIL_ENGINE_SOURCES, readTeamAiEngineSettings, RESEARCH_ENGINE_SOURCES, sanitizeTeamAiEngineSettings, writeTeamAiEngineSettings } from "../ai-engine-settings.js";
import { buildAcquisitionCliPrompt, buildTenderDailyCliPrompt, collectReportedTenderLines, type TenderDailyReport } from "../ai-engine-prompts.js";
import { type AiEngineJob } from "../ai-engine-jobs.js";
import { listEngineRunners, waitForEngineCliTask } from "../ai-engine-service.js";
import { type SessionUser } from "../types.js";
import { getStore } from "../store.js";
import {
  asyncRoute,
  backgroundResearchRequestSchema,
  buildBackgroundResearch,
  companyProfileForTeam,
  engineJobRepositoryOrNull,
  engineRequestWaitMs,
  finalizeEngineCliJob,
  persistBackgroundResearchRecord,
  publicEngineJob,
  runEngineCliJob,
  syncAcquisitionFindingsFromEvents
} from "../server-core.js";

/**
 * 引擎作业的可见性。
 *
 * 这里刻意**不直接**用 canSeeOwner()：canSeeOwner 对已接入 IAM 的账号要求先由中间件
 * 解析 iamDataScope，否则只看 iamPermissions 就直接返回 false（auth.ts: `if (user.iamPermissions) return false;`）。
 * 引擎作业是「随用随建」的留档——创建它的业务员必须能回读自己的作业，
 * 所以规则是：本人作业永远可见 → 跨团队不可见 → 有 IAM 数据范围时按范围判 → 否则同团队管理员可见。
 */
function engineJobVisible(user: SessionUser, job: AiEngineJob) {
  if (job.ownerId && job.ownerId === user.id) return true;
  if (job.teamId && job.teamId !== user.teamId) return false;
  if (user.iamDataScope) return canSeeOwner(user, job.ownerId, job.teamId);
  if (isPlatformIdentity(user)) return false;
  return user.role === "admin" || user.role === "super_admin" || user.role === "manager";
}

const aiAcquisitionRequestSchema = z.object({
  goal: z.string().trim().max(500).optional().default(""),
  productKeywords: z.string().trim().max(300).optional().default(""),
  countries: z.string().trim().max(200).optional().default(""),
  industry: z.string().trim().max(200).optional().default(""),
  customerType: z.string().trim().max(200).optional().default(""),
  excludeKeywords: z.string().trim().max(200).optional().default(""),
  limit: z.coerce.number().int().min(1).max(30).optional().default(8),
  runnerId: z.string().trim().max(80).optional().default("")
});

// ---------------------------------------------------------------------------
// 海外竞标日报（工作主页 · CLI 通道）
//
// 「每天查询」的实现方式：服务器不做定时器，而是前端每次打开工作主页时调
// POST /api/tender-daily/run（不带 force）。幂等规则：
//   今天已有成功的日报 → 直接复用留档结果，不再打扰 CLI；
//   今天已有跑着的作业 → 返回同一份作业，绝不重复派发；
//   今天还没有       → 组提示词（公司资料里的主营产品 = 相关性锚点）派一次 CLI。
// 这样机器开着的第一个工作时段就会自动产出当天日报，也随时可以手动重查。
// ---------------------------------------------------------------------------

function tenderDailyDate() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 竞标日报的相关性锚点：公司资料里的主营产品为空时，从团队自己的业务数据里
 * 推导高频产品词（搜客候选的业务方向 + 成交记录的产品）。推不出来就留空，
 * 让日报按「全球招标、通用工业品」口径跑，并在 notes 里说明局限。
 */
function teamProductKeywordFallback(teamId: string) {
  const store = getStore();
  const counts = new Map<string, number>();
  const bump = (value: unknown) => {
    const text = String(value || "").trim();
    if (!text) return;
    for (const token of text.split(/[，,、;；/|·]+/u).map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 60)) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  };
  store.websiteOpportunities.filter((item) => item.teamId === teamId).forEach((item) => bump(item.business));
  store.deals.filter((item) => item.teamId === teamId).forEach((item) => bump(item.product));
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10).map(([token]) => token).join("、");
}

function tenderReportFromJob(job: AiEngineJob): TenderDailyReport | null {
  if (job.status !== "succeeded" || !job.resultJson) return null;
  try {
    const parsed = JSON.parse(job.resultJson) as { report?: TenderDailyReport };
    return parsed.report || null;
  } catch {
    return null;
  }
}

export function registerAiEngineRoutes(app: Express) {
  app.post("/api/ai-engine/acquire", requireAuth, asyncRoute(async (req, res) => {
    const body = aiAcquisitionRequestSchema.parse(req.body);
    if (!body.goal && !body.productKeywords && !body.industry) {
      res.status(400).json({ message: "请至少填写获客目标、产品关键词或行业之一" });
      return;
    }
    const result = await runEngineCliJob(req.user!, {
      kind: "search",
      entityType: "prospect-acquisition",
      entityId: `acq_${Date.now()}`,
      request: { query: { ...body } },
      prompt: buildAcquisitionCliPrompt({
        goal: body.goal,
        productKeywords: body.productKeywords,
        countries: body.countries,
        industry: body.industry,
        customerType: body.customerType,
        excludeKeywords: body.excludeKeywords,
        limit: body.limit
      }),
      runnerId: body.runnerId || undefined,
      waitMs: engineRequestWaitMs()
    });
    if (result.pending) {
      res.status(202).json({ acquisition: null, ...result });
      return;
    }
    res.json(result.payload);
  }));

  // ---------------------------------------------------------------------------
  // CLI 获客任务历史：引擎作业本就按 kind=search + entityType=prospect-acquisition
  // 留档在 ai_engine_jobs（request_json 存派单参数、result_json 存入池统计），
  // 这里把它翻出来给搜客任务队列重建历史卡——任务卡不再「刷新即蒸发」，
  // 历史以数据库为准，可见性沿用 engineJobVisible（本人 / 数据范围内 / 管理层）。
  // ---------------------------------------------------------------------------
  app.get("/api/ai-engine/acquire-history", requireAuth, asyncRoute(async (req, res) => {
    const repository = engineJobRepositoryOrNull();
    if (!repository) {
      res.status(503).json({ message: "AI 引擎作业需要 MySQL 持久化档位" });
      return;
    }
    const parseStored = (raw: string | null): Record<string, unknown> => {
      try { return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { return {}; }
    };
    const jobs = (await repository.listTeamByKind(req.user!.teamId, "search", 80))
      .filter((job) => job.entityType === "prospect-acquisition" && engineJobVisible(req.user!, job))
      .slice(0, 12);
    res.json({
      jobs: jobs.map((job) => ({
        engineJob: publicEngineJob(job),
        request: (parseStored(job.requestJson).query || {}) as Record<string, unknown>,
        acquisition: (parseStored(job.resultJson).acquisition || null) as Record<string, unknown> | null
      }))
    });
  }));

  app.post("/api/ai-background-research", requireAuth, asyncRoute(async (req, res) => {
    const body = backgroundResearchRequestSchema.parse(req.body);
    const outcome = await buildBackgroundResearch(req.user!, body);
    if (!outcome) {
      res.status(404).json({
        message: body.entityType === "lead"
          ? "线索不存在或无权访问"
          : body.entityType === "customer"
            ? "客户不存在或无权访问"
            : "搜客候选不存在或无权访问"
      });
      return;
    }
    if (outcome.kind === "research") {
      await persistBackgroundResearchRecord(req.user!, outcome.research);
      res.json({ research: outcome.research, engineJob: null });
      return;
    }
    const result = await runEngineCliJob(req.user!, {
      kind: "research",
      entityType: body.entityType,
      entityId: body.entityId,
      request: { skeleton: outcome.skeleton },
      prompt: outcome.prompt,
      runnerId: body.runnerId,
      // 与获客口径一致：请求内只等 10 秒（任务创建 + 前几秒执行），到点 202 交前端轮询，
      // 等待动画点按钮即亮，不再让 HTTP 请求挂住背调页面 75 秒。
      waitMs: engineRequestWaitMs()
    });
    if (result.pending) {
      res.status(202).json({ research: null, ...result });
      return;
    }
    if (result.payload.failed) {
      res.status(400).json({ research: null, ...result.payload });
      return;
    }
    res.json(result.payload);
  }));

  app.get("/api/tender-daily/latest", requireAuth, asyncRoute(async (req, res) => {
    const repository = engineJobRepositoryOrNull();
    if (!repository) {
      res.status(503).json({ message: "竞标日报需要 MySQL 持久化档位" });
      return;
    }
    const jobs = await repository.listTeamByKind(req.user!.teamId, "tender", 1);
    const job = jobs[0] || null;
    if (!job) {
      res.json({ report: null, engineJob: null, pending: false });
      return;
    }
    res.json({ report: tenderReportFromJob(job), engineJob: publicEngineJob(job), pending: job.status === "running" });
  }));

  app.post("/api/tender-daily/run", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      /** true = 无视当天缓存强制重查 */
      force: z.boolean().optional(),
      /** 本次重点关注的地区（可选，默认全球） */
      regions: z.string().trim().max(300).optional(),
      /** 本次附加的检索提示（可选） */
      note: z.string().trim().max(500).optional()
    }).strict().parse(req.body || {});
    const repository = engineJobRepositoryOrNull();
    if (!repository) {
      res.status(503).json({ message: "竞标日报需要 MySQL 持久化档位" });
      return;
    }
    const today = tenderDailyDate();
    if (!body.force) {
      const jobs = await repository.listTeamByKind(req.user!.teamId, "tender", 5);
      const running = jobs.find((job) => job.status === "running" && job.createdAt.slice(0, 10) === today);
      if (running) {
        res.status(202).json({ report: null, engineJob: publicEngineJob(running), pending: true, reused: true });
        return;
      }
      const doneToday = jobs.find((job) => job.status === "succeeded" && (job.finishedAt || job.createdAt).slice(0, 10) === today);
      if (doneToday) {
        res.json({ report: tenderReportFromJob(doneToday), engineJob: publicEngineJob(doneToday), pending: false, reused: true });
        return;
      }
    }
    const profile = companyProfileForTeam(req.user!.teamId);
    const productKeywords = profile.productSummary.trim() || teamProductKeywordFallback(req.user!.teamId);
    // 跨期去重：把近 7 天已报过的条目指纹交给 CLI。日报检索窗口是 14 天且每天自动跑，
    // 不给历史清单它就会照着同一批公告天天重报一遍——同一份日报连续三天长得一样，
    // 等于把「今日新增情报」退化成了「本月存量清单」。
    const recentJobs = await repository.listTeamByKind(req.user!.teamId, "tender", 8);
    const previouslyReported = collectReportedTenderLines(
      recentJobs.map((job) => tenderReportFromJob(job)),
      { excludeDate: today, days: 7 }
    );
    const prompt = buildTenderDailyCliPrompt({
      reportDate: today,
      companyName: profile.companyName,
      productSummary: productKeywords,
      regions: body.regions || "",
      focusNote: body.note || "",
      previouslyReported
    });
    const result = await runEngineCliJob(req.user!, {
      kind: "tender",
      entityType: "tender",
      entityId: `daily-${today}`,
      request: {
        reportDate: today,
        productSummary: productKeywords,
        productSummarySource: profile.productSummary.trim() ? "company_profile" : "team_data_fallback",
        regions: body.regions || "",
        note: body.note || "",
        previouslyReportedCount: previouslyReported.length
      },
      prompt,
      // 与背调/开发信同口径：请求内只等一小段，到点 202 交前端轮询
      waitMs: engineRequestWaitMs()
    });
    if (result.pending) {
      res.status(202).json(result);
      return;
    }
    const payload = result.payload as { failed?: boolean; message?: string };
    if (payload.failed) {
      res.status(400).json({ report: null, pending: false, failed: true, message: payload.message || "竞标日报查询失败" });
      return;
    }
    res.json({ ...payload, pending: false });
  }));

  app.get("/api/ai-engine/settings", requireAuth, asyncRoute(async (req, res) => {
    const settings = await readTeamAiEngineSettings(req.user!.teamId);
    const runners = await listEngineRunners(req.user!);
    res.json({
      settings,
      canManage: hasIamPermission(req.user!, "system.settings.manage"),
      runners,
      researchSources: RESEARCH_ENGINE_SOURCES,
      emailSources: EMAIL_ENGINE_SOURCES,
      adapters: AI_ENGINE_ADAPTERS,
      // 模型清单由后端给：三处白名单（本文件 / CLI --help / Runner）以后升级 CLI 时只改后端这一份
      cliModels: AI_ENGINE_CLI_MODELS,
      cliEfforts: AI_ENGINE_CLI_EFFORTS,
      // Codex 的模型 / 档位单独一份：两个 CLI 的模型命名互不相通
      codexModels: AI_ENGINE_CODEX_MODELS,
      codexEfforts: AI_ENGINE_CODEX_EFFORTS,
      // 首选 CLI 不可用时会自动改用另一个，所以「能执行」= 任一 CLI 在线可用
      cliReady: runners.some((runner) => runner.online && (runner.capabilities.includes("workbuddy") || runner.capabilities.includes("codex"))),
      // 每个 CLI 当前是否有在线 Runner 可用：设置页据此提示「两个都配了可选 / 只配了一个会自动用它」
      adapterAvailability: Object.fromEntries(AI_ENGINE_ADAPTERS.map((adapter) => [
        adapter,
        runners.some((runner) => runner.online && runner.capabilities.includes(adapter))
      ]))
    });
  }));

  app.put("/api/ai-engine/settings", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user!, "system.settings.manage")) {
      res.status(403).json({ message: "当前账号没有系统设置权限" });
      return;
    }
    const body = z.object({
      researchSource: z.enum(["crm", "ai", "cli"]).optional(),
      emailSource: z.enum(["template", "ai", "cli"]).optional(),
      cliAdapter: z.enum(["workbuddy", "codex"]).optional(),
      // 空串 = 跟随 CLI 默认；非白名单值由 sanitizeTeamAiEngineSettings 回落到旧值
      cliModel: z.string().trim().max(60).optional(),
      cliEffort: z.string().trim().max(20).optional(),
      // Codex 模型：空串 = 跟随本机 ~/.codex/config.toml；非法字符由 sanitize 回落到旧值
      codexModel: z.string().trim().max(64).optional(),
      codexEffort: z.string().trim().max(20).optional(),
      cliWorkspace: z.string().trim().max(1000).optional(),
      cliTimeoutSeconds: z.number().int().min(60).max(86_400).optional(),
      runnerId: z.string().trim().max(80).optional()
    }).strict().parse(req.body);
    const current = await readTeamAiEngineSettings(req.user!.teamId);
    const saved = await writeTeamAiEngineSettings(sanitizeTeamAiEngineSettings(req.user!.teamId, {
      ...current,
      ...body,
      updatedBy: req.user!.id,
      updatedAt: new Date().toISOString()
    }, current));
    res.json({ settings: saved, canManage: true });
  }));

  /**
   * 轮询引擎作业。
   * 前端在收到 202（CLI 还在跑）后调这里；这里最多等 20 秒再回，减少空转请求。
   * 作业一旦收尾，结果会留档在 resultJson 里，重复调用只会返回同一份结果。
   */
  app.get("/api/ai-engine/jobs/:id", requireAuth, asyncRoute(async (req, res) => {
    const repository = engineJobRepositoryOrNull();
    if (!repository) {
      res.status(503).json({ message: "AI 引擎作业需要 MySQL 持久化档位" });
      return;
    }
    const job = await repository.get(req.params.id);
    if (!job || !engineJobVisible(req.user!, job)) {
      res.status(404).json({ message: "引擎作业不存在或无权访问" });
      return;
    }
    if (job.status !== "running") {
      res.json({
        engineJob: publicEngineJob(job),
        pending: false,
        payload: job.resultJson ? JSON.parse(job.resultJson) as Record<string, unknown> : null
      });
      return;
    }
    if (!job.cliTaskId) {
      await repository.finish(job.id, "failed", "", "引擎作业没有关联到本机任务");
      res.status(409).json({ message: "引擎作业没有关联到本机任务", engineJob: publicEngineJob({ ...job, status: "failed" }) });
      return;
    }
    const snapshot = await waitForEngineCliTask(req.user!, job.cliTaskId, 20_000);
    if (!snapshot || !["succeeded", "failed", "cancelled"].includes(snapshot.status)) {
      // 获客作业：轮询顺路做增量入池——CLI 边搜边打 @@FOUND@@ 标记，前端实时显示已找到几家
      const acquiredCount = await syncAcquisitionFindingsFromEvents(job, [
        ...(snapshot?.events || []).map((event) => event.message),
        snapshot?.resultText || ""
      ]);
      res.json({ engineJob: publicEngineJob(job), pending: true, payload: null, acquiredCount });
      return;
    }
    const payload = await finalizeEngineCliJob(req.user!, job, snapshot);
    const refreshed = await repository.get(job.id);
    res.json({ engineJob: publicEngineJob(refreshed || job), pending: false, payload });
  }));
}
