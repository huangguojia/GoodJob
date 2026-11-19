/**
 * 知识库训练路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import express, { type Response } from "express";
import path from "node:path";
import { z } from "zod";
import { requireAuth, signToken } from "../auth.js";
import { type AiModelConfig, type SessionUser } from "../types.js";
import { getKbTrainingRepository, type KbTrainingCandidate } from "../kb-training/kb-training-repository.js";
import { isKbTrainingEnabled, type KbAssetRef, type KbTrainingSourceSpec, publishKbCandidates, startKbTraining } from "../kb-training/kb-training-service.js";
import { shouldPreselect } from "../kb-training/kb-training-prompt.js";
import { extractKbSource, KB_SOURCE_MAX_BYTES, KbSourceExtractError } from "../kb-training/kb-source-extract.js";
import { deleteKnowledgeBase, linkKnowledgeBaseToRun, listKnowledgeBases, parseKbVisibility, renameOrShareKnowledgeBase, resolveKnowledgeBaseForRun, saveEnabledKnowledgeBases } from "../kb-training/kb-knowledge-base-service.js";
import { getStore } from "../store.js";
import { asyncRoute, canSeeKnowledgeAsset } from "../server-core.js";

// ---------------------------------------------------------------------------
// 知识库训练（KB Training）：发起批次 / 候选确认 / 发布回写 / 试问代理
//
// 见 docs/KNOWLEDGE-TRAINING-DEV-PLAN.md。P1 的闭环是「一份资料 → 一批候选 →
// 人工确认 → 发布到插件 → 现场试问」。治理控制面，与 /api/exchange 同级，
// 在 agent-api-policy 里整条前缀禁用（Agent 通道不得直接操作）。
// ---------------------------------------------------------------------------
const kbSourcesSchema = z.object({
  /** 文件中心资料：P1 只用它们提供**出处**（标题/版本）；正文不在库里。 */
  files: z.object({
    assetIds: z.array(z.string().trim().min(1).max(64)).max(50)
  }).optional(),
  /** P1 的语料主体：粘贴 / 上传的资料正文。 */
  text: z.object({
    items: z.array(z.object({
      title: z.string().trim().max(200).optional(),
      body: z.string().max(200_000).optional(),
      assetId: z.string().trim().max(64).optional(),
      // 来源描述（选填）：这份资料从哪来 / 谁写的 / 什么时候的口径。
      // 它进候选的 sourceRef 供人核对出处，**不**进运行端提示词（描述不是知识内容）。
      note: z.string().trim().max(200).optional()
    })).max(50)
  }).optional(),
  /** 会话源（P2）：P1 收到就如实报「未开放」，不静默忽略。 */
  conversations: z.object({
    since: z.string().trim().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
  }).optional()
});

function kbTrainingRepositoryOr503(res: Response) {
  const repository = getKbTrainingRepository();
  if (!repository) {
    res.status(503).json({ message: "知识库训练模块未启用（当前存储不支持）" });
    return null;
  }
  return repository;
}

/** 统一开关：关掉即回到「没有这批功能」，不需要回滚代码。 */
function kbTrainingEnabledOr503(res: Response): boolean {
  if (isKbTrainingEnabled()) return true;
  res.status(503).json({ message: "知识库训练已关闭（KB_TRAINING_ENABLED=0）", code: "KB_TRAINING_DISABLED" });
  return false;
}

/** 资料 id → 元数据。只取调用者可见的资产 —— 别的团队的资料不能当出处。 */
function kbAssetIndex(actor: SessionUser, ids: string[]): Map<string, KbAssetRef> {
  const wanted = new Set(ids.map((id) => String(id || "").trim()).filter(Boolean));
  const index = new Map<string, KbAssetRef>();
  if (!wanted.size) return index;
  for (const asset of getStore().knowledgeAssets) {
    if (!wanted.has(asset.id) || !canSeeKnowledgeAsset(actor, asset)) continue;
    index.set(asset.id, {
      id: asset.id,
      title: asset.title,
      version: asset.version || "",
      description: asset.description || ""
    });
  }
  return index;
}

/** CLI 失败时的降级档：本团队里已启用且填了 key 的模型，取最近更新的那个。 */
function kbAiConfigFor(actor: SessionUser): AiModelConfig | undefined {
  return getStore().aiModelConfigs
    .filter((item) => item.ownerId === actor.id && item.teamId === actor.teamId && item.enabled && item.apiKey && item.baseUrl && item.model)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function kbSourceAssetIds(spec: KbTrainingSourceSpec): string[] {
  return [
    ...(spec.files?.assetIds ?? []),
    ...(spec.text?.items ?? []).map((item) => item.assetId ?? "")
  ];
}

/** 候选出参：补 `preselect`（预勾选标记）。规则在纯函数里，前端只负责照着勾。 */
function kbCandidatePayload(candidate: KbTrainingCandidate) {
  return { ...candidate, preselect: shouldPreselect(candidate) };
}

/** 调插件训练库（发布 / 撤回 / 试问共用一条通道，统一带操作者身份的令牌）。 */
async function callPluginTrainingLibrary(
  actor: SessionUser,
  path: string,
  init: { method: string; body?: unknown }
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const pluginBase = (process.env.WHATSAPP_PLUGIN_BASE_URL || "http://127.0.0.1:3100").replace(/\/+$/u, "");
  const response = await fetch(`${pluginBase}${path}`, {
    method: init.method,
    headers: { authorization: `Bearer ${signToken(actor)}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000)
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

// ---------------------------------------------------------------------------
// 知识库（训练成果的资产形态）：公开 / 私用 + 账号级「默认知识库」多选启用
//
// 为什么要有一个"库"这一层：批次是执行日志（会失败、会堆），知识库是资产（有名字、
// 有创建者、能被别人勾选启用）。「出稿读哪些语料」最终由**启用清单**决定，而不是
// "库里有什么就全用"——这一层就是「多不伤、扁平的多才伤」的落地。
// ---------------------------------------------------------------------------

/** 把启用清单推给插件。插件是运行端：自动回复在它内部跑，没有 CRM 请求上下文，只能由 CRM 主动推。 */
async function pushKbEnabledToPlugin(actor: SessionUser, kbIds: string[]): Promise<{ ok: boolean; error?: string }> {
  const response = await callPluginTrainingLibrary(actor, "/api/v1/training/kb-subscriptions", {
    method: "PUT",
    body: { kbIds }
  });
  if (response.ok) return { ok: true };
  return {
    ok: false,
    error: String(response.data.message || response.data.error || `插件返回 HTTP ${response.status}`)
  };
}

export function registerKbRoutes(app: Express) {
  /**
   * 资料正文抽取（PDF / DOCX / 文本）——训练入口的第一步。
   *
   * 为什么不放到前端：浏览器读不了 PDF / Word；也不能只让用户「自己转成 txt」——
   * 用户手里的资料九成是 PDF/Word，那等于把功能关在门外。
   * 这里只做**抽取**（不做理解），抽取结果回前端暂存，提交训练时才真正发给模型。
   */
  app.post("/api/kb/training/extract", requireAuth, express.raw({ type: () => true, limit: KB_SOURCE_MAX_BYTES }), asyncRoute(async (req, res) => {
    // 类型判定交给字节（%PDF- / ZIP 头），不信 content-type：前端固定发 octet-stream，
    // 但其它调用方可能带 application/pdf。若上游已有 urlencoded/json 解析器先吃掉了 body，
    // 这里会拿到空 buffer —— 报「文件是空的」，比静默抽空正文好排查。
    if (!kbTrainingEnabledOr503(res)) return;
    const encodedFileName = String(req.headers["x-file-name"] || "").trim();
    let fileName = "";
    try {
      fileName = decodeURIComponent(encodedFileName);
    } catch {
      res.status(400).json({ message: "文件名编码无效" });
      return;
    }
    fileName = path.basename(fileName).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 255);
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const extracted = await extractKbSource({
        fileName,
        buffer,
        declaredMime: String(req.headers["x-file-type"] || "").trim()
      });
      res.json(extracted);
    } catch (error) {
      if (error instanceof KbSourceExtractError) {
        res.status(error.status).json({ message: error.message });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/kb/training/runs", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const body = z.object({
      sources: kbSourcesSchema.default({}),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      /** 归属知识库。不给就新建一个（默认私用），名字取自首份语料标题。 */
      kbId: z.string().trim().max(64).optional(),
      kbName: z.string().trim().max(200).optional()
    }).parse(req.body || {});
    const spec = body.sources as KbTrainingSourceSpec;
    const assets = kbAssetIndex(req.user!, kbSourceAssetIds(spec));
    const actor = { id: req.user!.id, teamId: req.user!.teamId };
    // 先定库再开训：库是资产，批次是"哪次训练喂了它"，所以库必须比批次先存在。
    // 定库失败（比如指定了别人的库）要**明确报错**，不能退回"随便建一个"。
    const knowledgeBase = await resolveKnowledgeBaseForRun({
      actor,
      spec,
      kbId: body.kbId,
      name: body.kbName
    });
    const run = await startKbTraining({
      actor,
      spec,
      kbId: knowledgeBase.id,
      deps: { assets, aiConfig: kbAiConfigFor(req.user!) }
    });
    await linkKnowledgeBaseToRun(knowledgeBase.id, run.id, actor.teamId, actor.id);
    // ⚠️ 新建库会**自动把这个库勾进创建者的启用清单**（见 createKnowledgeBase），
    //    而清单的唯一权威在 CRM、执行在插件 —— 所以清单一变就必须推，否则会出现
    //    「面板上勾着这个库、运行端却按旧清单出稿」：用户看不见，也没有任何东西会触发下一次同步。
    //    老用户会因此从「从未配置（自有语料全用）」切成「严格按清单」，但清单里本来就是他自己的全部库，
    //    对自己的语料覆盖范围完全一致；真正被排除的只有"他本来就没启用过的那些库"。
    //    指定了已有 kbId 时不推：那种情况下清单没变。
    let knowledgeBaseSync: { ok: boolean; error?: string } = { ok: true };
    if (!String(body.kbId ?? "").trim()) {
      const enabledIds = await repository.listEnabledKnowledgeBaseIds(actor.id);
      knowledgeBaseSync = await pushKbEnabledToPlugin(req.user!, enabledIds).catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "插件不可达"
      }));
      if (!knowledgeBaseSync.ok) {
        console.warn(`[kb] 启用清单同步失败（知识库 ${knowledgeBase.id}）：${knowledgeBaseSync.error}`);
      }
    }
    res.status(201).json({ run, knowledgeBase, knowledgeBaseSync });
  }));

  app.post("/api/kb/training/runs/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const id = String(req.params.id || "").trim();
    if (!/^kbr_[a-z0-9]{4,40}$/u.test(id)) {
      res.status(400).json({ message: "训练批次号无效" });
      return;
    }
    const run = await repository.getRun(id, req.user!.teamId);
    if (!run) {
      res.status(404).json({ message: "训练批次不存在" });
      return;
    }
    if (run.status !== "running") {
      res.status(409).json({ message: `这批已经${run.status === "cancelled" ? "取消" : "结束"}，不需要再取消` });
      return;
    }
    const accepted = await repository.requestRunCancel(id, req.user!.teamId);
    // 取消是**请求**不是结果：正在飞的那批模型调用结束后才会停。界面据此把按钮切到「正在停止…」，
    // 直接报「已取消」会在真正停下来之前就开始撒谎。
    res.json({ accepted, run: await repository.getRun(id, req.user!.teamId) });
  }));

  app.get("/api/kb/training/runs", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).catch(30) }).parse(req.query);
    res.json({ runs: await repository.listRuns(req.user!.teamId, query.limit) });
  }));

  app.get("/api/kb/training/runs/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const run = await repository.getRun(String(req.params.id || ""), req.user!.teamId);
    if (!run) {
      res.status(404).json({ message: "训练批次不存在" });
      return;
    }
    // 批次详情顺带把该批候选一起给前端：轮询一次就能刷新「提炼结果」，少一次往返。
    const candidates = await repository.listCandidates(req.user!.teamId, { runId: run.id, status: "all", limit: 100 });
    res.json({
      run,
      counts: await repository.countCandidatesByRun(req.user!.teamId, run.id),
      candidates: candidates.map(kbCandidatePayload)
    });
  }));

  app.get("/api/kb/training/candidates", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const query = z.object({
      status: z.enum(["pending", "approved", "rejected", "published", "all"]).catch("pending"),
      runId: z.string().trim().max(64).catch(""),
      kind: z.enum(["qa", "snippet", "policy", "forbidden", "all"]).catch("all"),
      gap: z.enum(["1", "0"]).catch("0"),
      limit: z.coerce.number().int().min(1).max(100).catch(20),
      cursor: z.coerce.number().int().min(0).catch(0)
    }).parse(req.query);
    const items = await repository.listCandidates(req.user!.teamId, {
      status: query.status,
      runId: query.runId || undefined,
      kind: query.kind,
      gapOnly: query.gap === "1",
      limit: query.limit + 1,
      offset: query.cursor
    });
    const hasMore = items.length > query.limit;
    res.json({
      items: items.slice(0, query.limit).map(kbCandidatePayload),
      nextCursor: hasMore ? query.cursor + query.limit : null
    });
  }));

  app.post("/api/kb/training/candidates/review", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const body = z.object({
      ids: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
      action: z.enum(["confirm", "drop"]),
      edits: z.array(z.object({
        id: z.string().trim().min(1).max(64),
        question: z.string().trim().max(2_000).optional(),
        answer: z.string().trim().max(4_000).optional(),
        tags: z.array(z.string().trim().min(1).max(60)).max(20).optional()
      })).max(20).optional()
    }).parse(req.body || {});
    const updated = await repository.reviewCandidates(
      req.user!.teamId,
      body.ids,
      body.action,
      body.edits ?? [],
      req.user!.id
    );
    res.json({ candidates: updated.map(kbCandidatePayload) });
  }));

  app.post("/api/kb/training/candidates/publish", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const body = z.object({
      ids: z.array(z.string().trim().min(1).max(64)).min(1).max(20)
    }).parse(req.body || {});
    // ⚠️ 这里**没有**「发布给谁」参数，是刻意的：跨账号共用走的不是"把语料复制到别人名下"，
    //    而是「库切公开 → 对方在他的启用清单里勾上」（见 PUT /api/kb/training/knowledge-bases/defaults）。
    //    复制一份的坏处是两份会各自漂移：你改了 A 库，对方的副本还是老的，而且他停用不掉。
    //    旧的 `targetOwnerId` 占位符已删除 —— 收下却不用 = 静默无效参数，比不提供更糟。
    const actor = req.user!;
    const result = await publishKbCandidates({
      actor: { id: actor.id, teamId: actor.teamId },
      ids: body.ids,
      publishToPlugin: async (candidate, context) => {
        const response = await callPluginTrainingLibrary(actor, "/api/v1/training/library", {
          method: "POST",
          body: {
            kind: candidate.kind,
            question: candidate.question || undefined,
            answer: candidate.answer,
            tags: candidate.tags,
            languages: candidate.languages,
            // kbId 必须带上：插件要靠它判断「这条语料该不该出现在某个账号的出稿里」。
            // 空串 = 老批次（无归属），插件侧按"历史条目"处理，仍然只对它自己的 owner 生效。
            kbId: context.kbId || undefined,
            // 出处三件套（哪个文件 / 哪一段 / 来源描述）：插件引用卡片显示「《文件》§段落 · 描述」。
            // 不进插件运行端提示词，只服务人核对出处。
            sourceTitle: candidate.sourceRef?.title || undefined,
            sourceAnchor: candidate.sourceRef?.anchor || undefined,
            sourceNote: candidate.sourceRef?.note || undefined
          }
        });
        if (!response.ok) {
          const message = String(response.data.message || response.data.error || "").trim();
          throw new Error(message || `插件返回 HTTP ${response.status}`);
        }
        const entryId = String(response.data.id || "");
        if (!entryId) throw new Error("插件没有返回条目 id，血缘无法回写");
        // 插件撞指纹时返回 200 + 既有条目 —— 那不是失败，是「已经在了」。
        return { entryId, existing: response.status === 200 };
      }
    });
    res.json(result);
  }));

  app.post("/api/kb/training/candidates/:id/revoke", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const candidate = await repository.getCandidate(String(req.params.id || ""), req.user!.teamId);
    if (!candidate) {
      res.status(404).json({ message: "候选不存在" });
      return;
    }
    if (!candidate.publishedEntryId) {
      res.status(400).json({ message: "该候选还没有发布过，无需撤回" });
      return;
    }
    // 插件侧置 archived（保留行留痕，不硬删）—— 复用它的候选确认通道（action=drop）。
    const response = await callPluginTrainingLibrary(req.user!, "/api/v1/training/library/confirm", {
      method: "POST",
      body: { ids: [candidate.publishedEntryId], action: "drop" }
    }).catch((error: unknown) => {
      throw new Error(`插件不可达：${error instanceof Error ? error.message : "未知错误"}`);
    });
    if (!response.ok) {
      res.status(response.status).json({ message: String(response.data.message || response.data.error || "插件撤回失败") });
      return;
    }
    await repository.markCandidateRevoked(candidate.id, req.user!.teamId, req.user!.id);
    const fresh = await repository.getCandidate(candidate.id, req.user!.teamId);
    res.json({ candidate: fresh ? kbCandidatePayload(fresh) : null });
  }));

  app.get("/api/kb/training/knowledge-bases", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const result = await listKnowledgeBases({ id: req.user!.id, teamId: req.user!.teamId });
    res.json(result);
  }));

  app.get("/api/kb/training/knowledge-bases/:id/entries", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const id = String(req.params.id || "").trim();
    const knowledgeBase = await repository.getKnowledgeBase(id, req.user!.teamId);
    if (!knowledgeBase) {
      res.status(404).json({ message: "知识库不存在或不属于当前团队" });
      return;
    }
    // 可见性由 listKnowledgeBases 定义（自有 + 团队公开）；这里再守一道，避免直接猜 id 就能看别人的私库。
    const visible = await repository.listKnowledgeBases(req.user!.teamId, req.user!.id);
    if (!visible.some((item) => item.id === id)) {
      res.status(403).json({ message: "这个知识库没有公开给你" });
      return;
    }
    const entries = await repository.listPublishedCandidatesByKnowledgeBase(req.user!.teamId, id);
    res.json({ knowledgeBase: visible.find((item) => item.id === id), entries: entries.map(kbCandidatePayload) });
  }));

  app.put("/api/kb/training/knowledge-bases/defaults", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const body = z.object({
      kbIds: z.array(z.string().trim().min(1).max(64)).max(200)
    }).parse(req.body || {});
    const actor = { id: req.user!.id, teamId: req.user!.teamId };
    const result = await saveEnabledKnowledgeBases({
      actor,
      kbIds: body.kbIds,
      pushToPlugin: (kbIds) => pushKbEnabledToPlugin(req.user!, kbIds)
    });
    // 插件没推成功**照样返回 200 + 明确标记**：清单在 CRM 侧已经存下了，
    // 谎报 500 会让用户以为没保存而反复重试。但 `pluginPushed=false` 必须让界面能看见。
    res.json(result);
  }));

  app.patch("/api/kb/training/knowledge-bases/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const repository = kbTrainingRepositoryOr503(res);
    if (!repository) return;
    const body = z.object({
      name: z.string().trim().min(1).max(200).optional(),
      /** 只认 owner / team；界面上的「私用 / 公开」就是这两个值。 */
      visibility: z.enum(["owner", "team"]).optional()
    }).parse(req.body || {});
    const knowledgeBase = await renameOrShareKnowledgeBase(
      { id: req.user!.id, teamId: req.user!.teamId },
      String(req.params.id || ""),
      {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.visibility === undefined ? {} : { visibility: parseKbVisibility(body.visibility) })
      }
    );
    res.json({ knowledgeBase });
  }));

  app.delete("/api/kb/training/knowledge-bases/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const result = await deleteKnowledgeBase({
      actor: { id: req.user!.id, teamId: req.user!.teamId },
      id: String(req.params.id || ""),
      // 先插件后 CRM：插件 `drop` 幂等（已归档再归档不报错），失败时重试能收敛。
      // 一次最多 20 条是插件 `confirm` 的硬上限，超出必须分批 —— 少批一次就会漏下线。
      archiveEntries: async (entryIds) => {
        for (let index = 0; index < entryIds.length; index += 20) {
          const chunk = entryIds.slice(index, index + 20);
          const response = await callPluginTrainingLibrary(req.user!, "/api/v1/training/library/confirm", {
            method: "POST",
            body: { ids: chunk, action: "drop" }
          });
          if (!response.ok) {
            const message = String(response.data.message || response.data.error || "").trim();
            throw new Error(message || `插件返回 HTTP ${response.status}`);
          }
        }
      }
    });
    res.json(result);
  }));

  app.post("/api/kb/training/probe", requireAuth, asyncRoute(async (req, res) => {
    if (!kbTrainingEnabledOr503(res)) return;
    const body = z.object({
      body: z.string().trim().min(1).max(10_000),
      accountId: z.string().trim().max(64).optional()
    }).parse(req.body || {});
    // 试问严格代理插件自己的 match：**同源**才能保证"试问看到的就是真实链路会用的"。
    const response = await callPluginTrainingLibrary(req.user!, "/api/v1/training/library/match", {
      method: "POST",
      body: { body: body.body, accountId: body.accountId }
    }).catch((error: unknown) => {
      throw new Error(`WhatsApp 插件服务不可达：${error instanceof Error ? error.message : "未知错误"}`);
    });
    if (!response.ok) {
      res.status(response.status).json({ message: String(response.data.message || response.data.error || "试问失败") });
      return;
    }
    res.json(response.data);
  }));
}
