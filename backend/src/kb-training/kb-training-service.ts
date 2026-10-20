import { callAiModel } from "../ai-model-runtime.js";
import { runCliSummary } from "../cli-ai.js";
import type { AiModelConfig } from "../types.js";
import {
  getKbTrainingRepository,
  type KbTrainingCandidate,
  type KbTrainingProgress,
  type KbTrainingRun,
  type KbTrainingStats
} from "./kb-training-repository.js";
import {
  buildKbPrompt,
  KB_MAX_SEGMENTS,
  KB_SEGMENTS_PER_CALL,
  parseKbOutput,
  segmentDocuments,
  type KbSegment,
  type KbSourceItem
} from "./kb-training-prompt.js";

// ---------------------------------------------------------------------------
// 知识库训练：采集 → 分段 → 批量提炼 → 校验 → 入候选池
//
// 三条纪律（来自开发方案 §8.2 / §9）：
//  1. **批量**：每 20 段 1 次调用，禁止每条一调（100 段 ≈ 5 次，不是 100 次）。
//  2. **降级可见**：CLI 失败 → CRM 配置模型 → 都没有则 engine='none' 并如实失败，
//     **绝不假装成功**（"桩全绿≠能用"是踩过的坑）。
//  3. **无出处不入池**：候选必须能回指到资料段落，否则它是编出来的，直接丢。
//
// 后台姿态沿用 followup-sync：先落一条 running 的批次返回给前端，提炼在后台跑，
// 前端轮询批次状态。
// ---------------------------------------------------------------------------

/** CRM 侧统一开关。默认开；出问题时关掉即回到「没有这批功能」的状态，不需要回滚代码。 */
export function isKbTrainingEnabled(): boolean {
  const raw = String(process.env.KB_TRAINING_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "no"].includes(raw);
}

/** 单次 CLI 调用的上限。CLI 冷启动本来就慢，给足余量但别无限等。 */
const KB_CLI_TIMEOUT_MS = 120_000;

/** 提示词喂给模型的最大字符数（兜底，正常批次远小于此值）。 */
const KB_AI_MAX_INPUT_CHARS = 24_000;

/** 一次训练最多处理多少段（防一份超大资料把批次拖到天亮）；超了截断并记 warning。 */
export const KB_MAX_SEGMENTS_PER_RUN = 200;

export interface KbAssetRef {
  id: string;
  title: string;
  version: string;
  /** 文件中心的说明文字。有它才能当语料用 —— 实测绝大多数资料这里是空的。 */
  description: string;
}

export interface KbTrainingSourceSpec {
  /** 文件中心资料。P1 只用它们提供**出处**（标题/版本/链接）；正文请走 text。 */
  files?: { assetIds?: string[] };
  /** P1 的语料主体：粘贴/上传的资料正文。note = 来源描述（选填）。 */
  text?: { items?: Array<{ title?: string; body?: string; assetId?: string; note?: string }> };
  /** 会话源（P2）。P1 收到就如实报告未开放，不静默忽略。 */
  conversations?: { since?: string; limit?: number };
}

export interface KbCollectedSources {
  items: KbSourceItem[];
  warnings: string[];
  errors: string[];
}

/**
 * 采集：把入参解析成可分段语料 + 一份**给人看的**说明。
 *
 * `warnings` 是"能继续但你要知道"，`errors` 是"这部分做不了"。
 * 文件中心只存链接与元数据（实测 description 多为空），所以单独选资料**不足以**训练 ——
 * 这一点必须让用户看见，而不是训出一堆从标题臆造出来的垃圾。
 */
export function collectSourceItems(spec: KbTrainingSourceSpec, assets: Map<string, KbAssetRef>): KbCollectedSources {
  const items: KbSourceItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  /** 有正文但没有出处的条数：**出处是硬门槛**，不给它就不能进池。 */
  let withoutProvenance = 0;

  if (spec.conversations) {
    errors.push("会话源（conversations）在 P1 尚未开放，将在 P2 提供");
  }

  for (const raw of spec.text?.items ?? []) {
    const body = String(raw.body ?? "").trim();
    if (!body) continue;
    let assetId = String(raw.assetId ?? "").trim();
    let version = "";
    let title = String(raw.title ?? "").trim();
    if (assetId) {
      const asset = assets.get(assetId);
      if (!asset) {
        // 关联的资料找不到：**丢掉这个 id**而不是留个悬空出处。
        warnings.push(`关联的资料 ${assetId} 不存在，该条按纯文本处理`);
        assetId = "";
      } else {
        version = asset.version;
        if (!title) title = asset.title;
      }
    }
    // 「无出处不入池」：既没有关联资料、也没有标题的正文，回头没人能查它是哪来的。
    // 刻意**不**自动补一个「粘贴资料 1」之类的假标题 —— 那会让出处看起来存在，实则无意义。
    if (!assetId && !title) {
      withoutProvenance += 1;
      continue;
    }
    const note = String(raw.note ?? "").trim().slice(0, 200);
    items.push({ title, body, assetId, version, ...(note ? { note } : {}) });
  }

  for (const id of spec.files?.assetIds ?? []) {
    const asset = assets.get(id);
    if (!asset) { warnings.push(`资料 ${id} 不存在，已跳过`); continue; }
    const description = asset.description.trim();
    if (!description) {
      // 这是**关键提示**：用户以为「选了资料」就等于「把资料内容喂进去了」，其实没有。
      warnings.push(`《${asset.title}》没有正文（文件中心只存链接与说明），请把资料内容粘贴到下方文本框中`);
      continue;
    }
    items.push({ title: asset.title, body: description, assetId: asset.id, version: asset.version });
  }

  if (!items.length) {
    errors.push(withoutProvenance
      ? `有 ${withoutProvenance} 段正文没有出处：请为每份资料填一个标题，或关联一条文件中心资料（否则这条知识回头查不到来源）`
      : "没有任何可用正文。文件中心只保存资料链接与说明，不含正文 —— 请在训练框里粘贴资料内容（或先在文件中心把资料说明补上）");
  }
  return { items, warnings, errors };
}

export interface KbTrainingDeps {
  /** 资料 id → 元数据（由调用方从 store 解析） */
  assets: Map<string, KbAssetRef>;
  /** CRM 已配置且启用的模型：CLI 失败时的降级档。没有就只能如实失败。 */
  aiConfig?: AiModelConfig;
  /** 测试注入点：默认走本机 CLI（runCliSummary）。 */
  runCli?: (prompt: string, options?: { timeoutMs?: number }) => Promise<{ text: string; model: string }>;
  /** 测试注入点：默认走 callAiModel。 */
  callAi?: (config: AiModelConfig, prompt: string) => Promise<string>;
}

export interface KbTrainingActor {
  id: string;
  teamId: string;
}

/**
 * 发起训练：落一条 `running` 的批次并立即返回，提炼在后台继续。
 * 前端拿 run.id 轮询 `GET /api/kb/training/runs/:id`。
 */
export async function startKbTraining(options: {
  actor: KbTrainingActor;
  spec: KbTrainingSourceSpec;
  deps: KbTrainingDeps;
  /** 本批成果归属的知识库（由路由先 resolve 好，见 kb-knowledge-base-service）。 */
  kbId: string;
}): Promise<KbTrainingRun> {
  const repository = getKbTrainingRepository();
  if (!repository) throw new Error("知识库训练模块未初始化（数据库未挂载）");
  const run = await repository.createRun({
    teamId: options.actor.teamId,
    ownerId: options.actor.id,
    kbId: options.kbId,
    sourcesJson: JSON.stringify(options.spec)
  });
  // fire-and-forget：失败也只会落在批次的 error_message 上，不影响这次 HTTP 响应。
  void executeKbTrainingRun(run.id, options.actor, options.spec, options.deps).catch(() => undefined);
  return run;
}

/**
 * 后台执行。所有失败路径都必须写回批次状态 —— 批次卡在 `running` 是最糟的形态
 * （用户永远等不到结果，也不知道为什么）。
 */
export async function executeKbTrainingRun(
  runId: string,
  actor: KbTrainingActor,
  spec: KbTrainingSourceSpec,
  deps: KbTrainingDeps
): Promise<void> {
  const repository = getKbTrainingRepository();
  if (!repository) return;
  const stats: KbTrainingStats = { segments: 0, candidates: 0, duplicates: 0, skipped: 0, cliCalls: 0, invented: 0 };
  const warnings: string[] = [];
  let engine: "cli" | "ai" | "none" = "none";
  let model = "";
  let chosen: "cli" | "ai" | null = null;

  const startedAt = new Date().toISOString();
  const progress: KbTrainingProgress = {
    totalSegments: 0, processedSegments: 0, batches: 0, batchesDone: 0,
    stage: "collecting", startedAt, updatedAt: startedAt
  };
  /**
   * 写进度**失败不中断训练**：进度是给人看的辅助信息，
   * 让它把一次已经成功的提炼拖成 failed，是本末倒置。
   */
  const saveProgress = async (patch: Partial<KbTrainingProgress> = {}): Promise<void> => {
    Object.assign(progress, patch, { updatedAt: new Date().toISOString() });
    await repository.saveRunProgress(runId, progress).catch(() => undefined);
  };

  const finish = async (status: "succeeded" | "partial" | "failed" | "cancelled", errorMessage: string): Promise<void> => {
    await saveProgress({ stage: "done" });
    await repository.finishRun(runId, {
      status,
      engine,
      model,
      stats,
      errorMessage: [errorMessage, ...warnings].filter(Boolean).join("；").slice(0, 1_000)
    });
  };

  try {
    const collected = collectSourceItems(spec, deps.assets);
    warnings.push(...collected.warnings);
    if (collected.errors.length && !collected.items.length) {
      await finish("failed", collected.errors.join("；"));
      return;
    }
    warnings.push(...collected.errors);

    const { segments, truncated } = segmentDocuments(collected.items);
    const usable = segments.slice(0, KB_MAX_SEGMENTS_PER_RUN);
    // 截断要**说出来**：静默截断会让人以为「整份资料都训过了」。
    if (truncated || segments.length > usable.length) {
      warnings.push(`资料过长，本次只处理前 ${usable.length} 段（共 ${Math.max(segments.length, usable.length)} 段）`);
    }
    if (truncated) warnings.push(`单份资料最多切 ${KB_MAX_SEGMENTS} 段，超出部分已忽略`);
    stats.segments = usable.length;
    if (!usable.length) {
      await finish("failed", "分段后没有得到任何可用内容（资料是否只有标题？）");
      return;
    }
    // 进度在**开始提炼前**就写一次：否则前 20 段（一次 CLI 调用，可能 1~2 分钟）
    // 界面一直停在「已提交但没有任何数字」，和卡死没有区别。
    const totalBatches = Math.ceil(usable.length / KB_SEGMENTS_PER_CALL);
    await saveProgress({ totalSegments: usable.length, batches: totalBatches, stage: "extracting" });

    let batchFailed = "";
    for (let offset = 0; offset < usable.length; offset += KB_SEGMENTS_PER_CALL) {
      // 取消是「不开始下一批」，不是强行掐断飞行中的调用：掐断只会留下半截解析结果。
      if (await repository.isRunCancelRequested(runId).catch(() => false)) {
        await finish("cancelled", `已按请求取消：已入池 ${stats.candidates} 条保留在候选池，可继续确认或发布`);
        return;
      }
      const batch = usable.slice(offset, offset + KB_SEGMENTS_PER_CALL);
      const prompt = buildKbPrompt(batch, { documentTitle: collected.items[0]?.title });

      let raw = "";
      if (chosen === "ai" && deps.aiConfig) {
        raw = await runAi(deps, prompt);
      } else {
        try {
          const cli = await (deps.runCli ?? runCliSummary)(prompt, { timeoutMs: KB_CLI_TIMEOUT_MS });
          stats.cliCalls += 1;
          raw = cli.text;
          if (!chosen) { chosen = "cli"; engine = "cli"; model = cli.model; }
        } catch (error) {
          const cliReason = error instanceof Error ? error.message : "本机 CLI 调用失败";
          if (!deps.aiConfig) {
            // 没有降级档：如实失败，并把 CLI 的真实原因带出去（未登录 / 超时 / 不存在）。
            await finish("failed", `本机 CLI 提炼失败且未配置可降级的模型：${cliReason}`);
            return;
          }
          warnings.push(`本机 CLI 不可用，已改用 CRM 配置的模型：${cliReason.slice(0, 200)}`);
          engine = "ai";
          model = deps.aiConfig.model;
          chosen = "ai";
          raw = await runAi(deps, prompt);
        }
      }

      const parsed = parseKbOutput(raw, batch);
      if (parsed.error) {
        // 整批不可读：这批段一条都没产出，如实计入 skipped（不是"成功 0 条"）。
        stats.skipped += batch.length;
        batchFailed = parsed.error;
        await saveProgress({ processedSegments: offset + batch.length, batchesDone: progress.batchesDone + 1 });
        continue;
      }
      stats.skipped += parsed.discarded;
      stats.invented += parsed.invented;

      for (const item of parsed.items) {
        const segment = batch[item.segmentOrdinal - 1];
        if (!segment) { stats.skipped += 1; continue; }
        // 「无出处不入池」：回指不到资料段落的候选一律丢。这是语料质量的最后一道闸。
        const hasProvenance = Boolean(segment.assetId || segment.title.trim());
        if (!hasProvenance) { stats.skipped += 1; continue; }
        const inserted = await repository.insertCandidate({
          runId,
          teamId: actor.teamId,
          ownerId: actor.id,
          kind: item.kind,
          question: item.question,
          answer: item.answer,
          tags: item.tags,
          languages: item.languages,
          confidence: item.confidence,
          sourceType: "file",
          sourceRef: {
            type: "file",
            assetId: segment.assetId || undefined,
            title: segment.title,
            version: segment.version || undefined,
            note: segment.note || undefined,
            anchor: segment.anchor
          },
          rationale: item.rationale || `来自《${segment.title}》${segment.anchor}`,
          gapFlag: false,
          fingerprint: item.fingerprint,
          // 人工确认是闸门：**一律 pending**，不替人放行（预勾选只影响界面默认勾选）。
          status: "pending"
        });
        if (inserted.duplicate) stats.duplicates += 1;
        else stats.candidates += 1;
      }
      // 每批结束后落一次进度：这是用户唯一能看到的「还在往前走」的证据。
      await saveProgress({ processedSegments: offset + batch.length, batchesDone: progress.batchesDone + 1 });
    }

    // 最后一批期间点的「停止」：循环已经走完，没有下一批可以被跳过。
    // 这时不能直接报「成功」—— 用户刚点了停止，界面却显示成功，他会怀疑按钮没生效；
    // 也不该假装什么都没做 —— 事实是全部段落都提炼完了。如实写清楚停了以后发生了什么。
    const cancelledAtEnd = await repository.isRunCancelRequested(runId).catch(() => false);
    if (cancelledAtEnd) {
      await finish("cancelled", [
        batchFailed ? `部分批次输出无法解析（${batchFailed}）` : "",
        `已按请求停止：停止时最后一批已经跑完，${stats.segments} 段全部提炼完成，已入池 ${stats.candidates} 条`
      ].filter(Boolean).join("；"));
      return;
    }
    if (batchFailed && !stats.candidates) {
      await finish("partial", `模型输出无法解析（${batchFailed}）`);
      return;
    }
    if (batchFailed) {
      await finish("partial", `部分批次输出无法解析（${batchFailed}）`);
      return;
    }
    await finish("succeeded", "");
  } catch (error) {
    // 兜底：任何未预期异常都要落成 failed，绝不让批次永远停在 running。
    await finish("failed", error instanceof Error ? error.message : "训练过程出现未知错误").catch(() => undefined);
  }
}

async function runAi(deps: KbTrainingDeps, prompt: string): Promise<string> {
  if (!deps.aiConfig) throw new Error("未配置可用的 CRM 模型");
  if (deps.callAi) return deps.callAi(deps.aiConfig, prompt);
  return callAiModel(deps.aiConfig, prompt, KB_AI_MAX_INPUT_CHARS);
}

/** 供路由层复用：把批次里的段落信息整理成「出处」展示文案。 */
export function describeSegment(segment: KbSegment): string {
  return `${segment.title || "（未命名）"} ${segment.anchor}`;
}

// ---------------------------------------------------------------------------
// 发布编排
// ---------------------------------------------------------------------------

export interface KbPublishOutcome {
  published: Array<{ id: string; entryId: string }>;
  existing: Array<{ id: string; entryId: string }>;
  failed: Array<{ id: string; reason: string }>;
}

/**
 * 发布到插件训练库。
 *
 * 传输层（signToken + fetch 插件）由路由注入，这里只负责编排与**血缘回写**：
 * 成功后把插件侧条目 id 写进 `published_entry_id` —— 没有它，撤回与
 * "这条到底发出去没有"都无从查起。
 *
 * 「无出处不可发布」是硬判据（方案 §10.2 自检 #1）：`sourceRef` 被手工清成 NULL 的候选
 * 必须在这里被**拒绝并给出原因**，而不是静默发布成功。
 */
export async function publishKbCandidates(options: {
  actor: KbTrainingActor;
  ids: string[];
  publishToPlugin: (candidate: KbTrainingCandidate, context: { kbId: string }) => Promise<{ entryId: string; existing: boolean }>;
}): Promise<KbPublishOutcome> {
  const repository = getKbTrainingRepository();
  if (!repository) throw new Error("知识库训练模块未初始化（数据库未挂载）");
  const outcome: KbPublishOutcome = { published: [], existing: [], failed: [] };
  const targets = await repository.listCandidatesByIds(options.actor.teamId, options.ids);
  const found = new Set(targets.map((candidate) => candidate.id));
  for (const id of options.ids) {
    if (!found.has(id)) outcome.failed.push({ id, reason: "候选不存在或不属于当前团队" });
  }
  // 逐条带上归属知识库：插件据此知道「这条语料能被哪些账号出稿时读到」。
  const kbByRun = await repository.mapRunKnowledgeBaseIds(options.actor.teamId, targets.map((candidate) => candidate.runId));

  for (const candidate of targets) {
    if (!candidate.sourceRef || !(candidate.sourceRef.assetId || String(candidate.sourceRef.title || "").trim())) {
      outcome.failed.push({ id: candidate.id, reason: "无出处不可发布（找不到这条知识的来源段落）" });
      continue;
    }
    if (candidate.status === "rejected") {
      outcome.failed.push({ id: candidate.id, reason: "已丢弃的候选不能发布" });
      continue;
    }
    // 人工确认是闸门：界面上「确认 → 发布」是两步，后端不能允许绕过第一步。
    // 曾经的「待确认也能发」让整条确认链变成装饰 —— 界面上写着「确认后才进语料库」，
    // 实际点发布就直接生效，用户以为自己在控制的其实没控制。
    if (candidate.status === "pending") {
      outcome.failed.push({ id: candidate.id, reason: "还没确认：先在确认屏点「确认」，再发布" });
      continue;
    }
    try {
      const result = await options.publishToPlugin(candidate, { kbId: kbByRun.get(candidate.runId) || "" });
      await repository.markCandidatePublished(candidate.id, options.actor.teamId, result.entryId, options.actor.id);
      if (result.existing) outcome.existing.push({ id: candidate.id, entryId: result.entryId });
      else outcome.published.push({ id: candidate.id, entryId: result.entryId });
    } catch (error) {
      // 单条失败不污染整批：其余继续，失败原因逐条回给界面。
      outcome.failed.push({
        id: candidate.id,
        reason: error instanceof Error ? error.message : "发布失败"
      });
    }
  }
  return outcome;
}
