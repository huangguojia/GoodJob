import {
  getKbTrainingRepository,
  normalizeKbVisibility,
  type KbKnowledgeBase,
  type KbKnowledgeBaseVisibility,
  type KbKnowledgeBaseView
} from "./kb-training-repository.js";
import type { KbTrainingSourceSpec } from "./kb-training-service.js";

// ---------------------------------------------------------------------------
// 知识库（训练成果的资产形态）：命名 → 归属 → 公开/私用 → 账号级启用清单
//
// 三条判据（本次改动新增，缺一条功能就不闭环）：
//  1. **库是资产不是日志**：一次训练产生一个库，库有名字、有创建者、有可见性；
//     批次（run）只是"哪次训练喂了它"的执行记录。
//  2. **只有创建者能改**：改名与切公开/私用都要求 `owner_id = actor.id`，
//     别人的库只能看、只能勾选启用，不能改（否则等于允许别人改你的知识口径）。
//  3. **只能启用看得见的库**：保存清单时逐个校验可见性，不可见的 id 必须**拒绝并报出来**，
//     不是静默过滤 —— 静默过滤会让用户以为勾上了，实际没生效。
// ---------------------------------------------------------------------------

export interface KbKnowledgeBaseActor {
  id: string;
  teamId: string;
}

/**
 * 带 HTTP 状态码的知识库错误。全局错误处理只认 `error.status`（4xx 原样回前端），
 * 不带状态码的错误会变成 500「服务器处理请求失败」—— 用户根本不知道是权限问题。
 */
export class KbKnowledgeBaseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "KbKnowledgeBaseError";
  }
}

/** 启用清单的落库结果。`rejected` 非空时界面必须提示，不能当成功。 */
export interface KbEnabledSaveResult {
  enabled: string[];
  /** 被拒绝的 id → 原因（不可见 / 不存在） */
  rejected: Array<{ id: string; reason: string }>;
  /** 推送到插件是否成功。失败 = 历史出稿仍按旧清单走，必须让用户看见。 */
  pluginPushed: boolean;
  pluginError: string;
}

function shortDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * 默认库名：优先用第一份语料的标题（用户一眼能认出这是哪份资料训出来的），
 * 没有标题才退回时间戳。**不编造"知识库 1"这类名字** —— 那样列表里十条全一样，
 * 后面"选择默认知识库"就没法选了。
 */
export function defaultKnowledgeBaseName(spec: KbTrainingSourceSpec, now = new Date()): string {
  const titles = (spec.text?.items ?? [])
    .map((item) => String(item.title ?? "").trim())
    .filter(Boolean);
  if (titles.length === 1) return titles[0].slice(0, 200);
  if (titles.length > 1) return `${titles[0].slice(0, 180)} 等 ${titles.length} 份资料`;
  return `训练 ${shortDate(now)}`;
}

/**
 * 取本批要用的知识库：
 *  - 显式给了 `kbId` → 必须是**自己的**库（往别人库发会污染别人的出稿口径）；
 *  - 没给 → 新建，默认**私用**（含商务口径的资料不该默认公开）。
 */
export async function resolveKnowledgeBaseForRun(options: {
  actor: KbKnowledgeBaseActor;
  spec: KbTrainingSourceSpec;
  kbId?: string;
  name?: string;
}): Promise<KbKnowledgeBase> {
  const repository = getKbTrainingRepository();
  if (!repository) throw new Error("知识库训练模块未初始化（数据库未挂载）");
  const requested = String(options.kbId ?? "").trim();
  if (requested) {
    const existing = await repository.getKnowledgeBase(requested, options.actor.teamId);
    if (!existing) throw new KbKnowledgeBaseError("指定的知识库不存在或不属于当前团队", 404);
    if (existing.ownerId !== options.actor.id) {
      throw new KbKnowledgeBaseError("只能把语料发进自己创建的知识库", 403);
    }
    return existing;
  }
  return repository.createKnowledgeBase({
    teamId: options.actor.teamId,
    ownerId: options.actor.id,
    name: String(options.name ?? "").trim().slice(0, 200) || defaultKnowledgeBaseName(options.spec),
    visibility: "owner",
    runId: ""
  });
}

/** 批次建好后把 run_id 回填到库上：这样"这个库是哪批训出来的"在库里也查得到。 */
export async function linkKnowledgeBaseToRun(kbId: string, runId: string, teamId: string, ownerId: string): Promise<void> {
  const repository = getKbTrainingRepository();
  if (!repository || !kbId) return;
  await repository.attachKnowledgeBaseRun(kbId, runId, teamId, ownerId);
}

/** 可见性只允许这两个值；界面传别的（比如旧版本的 `public`）一律按私用处理，绝不意外公开。 */
export function parseKbVisibility(raw: unknown): KbKnowledgeBaseVisibility {
  return normalizeKbVisibility(raw);
}

export async function listKnowledgeBases(actor: KbKnowledgeBaseActor): Promise<{
  items: KbKnowledgeBaseView[];
  /** 当前账号的启用清单；空数组 = 一个都没启用（合法状态：不用知识库出稿）。 */
  enabledIds: string[];
}> {
  const repository = getKbTrainingRepository();
  if (!repository) throw new Error("知识库训练模块未初始化（数据库未挂载）");
  const [items, enabledIds] = await Promise.all([
    repository.listKnowledgeBases(actor.teamId, actor.id),
    repository.listEnabledKnowledgeBaseIds(actor.id)
  ]);
  return { items, enabledIds };
}

export async function renameOrShareKnowledgeBase(
  actor: KbKnowledgeBaseActor,
  id: string,
  patch: { name?: string; visibility?: KbKnowledgeBaseVisibility }
): Promise<KbKnowledgeBase> {
  const repository = getKbTrainingRepository();
  if (!repository) throw new Error("知识库训练模块未初始化（数据库未挂载）");
  const existing = await repository.getKnowledgeBase(id, actor.teamId);
  if (!existing) throw new KbKnowledgeBaseError("知识库不存在或不属于当前团队", 404);
  if (existing.ownerId !== actor.id) {
    throw new KbKnowledgeBaseError("只有创建者可以修改知识库的公开状态或名称", 403);
  }
  const ok = await repository.updateKnowledgeBase(id, actor.teamId, actor.id, patch);
  if (!ok) throw new KbKnowledgeBaseError("知识库更新失败（没有可变更的字段）", 400);
  const fresh = await repository.getKnowledgeBase(id, actor.teamId);
  if (!fresh) throw new KbKnowledgeBaseError("知识库更新后读回失败", 500);
  return fresh;
}

/** 删除知识库的结果：界面要按这三个数说清楚"删掉了什么、保留了什么"。 */
export interface KbKnowledgeBaseDeleteResult {
  id: string;
  name: string;
  /** 已从插件训练库下线的条目数（插件侧置 archived，保留留痕）。 */
  archivedEntries: number;
  /** 解除归库的训练批次数；批次与候选本身保留，原文也还在。 */
  detachedRuns: number;
}

/**
 * 删除知识库。
 *
 * 顺序是刻意的：**先让插件下线条目，再删 CRM 的库**。
 * 插件是运行端，按 `kb_id` 读语料；反过来做（先删库）一旦插件调用失败，
 * 库里那些语料就会永远留在插件里继续参与出稿 —— 界面上库没了，客户仍在收到
 * 这个库教出来的话术，排查时几乎无从下手。
 *
 * 插件侧 `drop` 是幂等的（已归档再归档不报错），所以"部分成功 → 重试"能收敛。
 */
export async function deleteKnowledgeBase(options: {
  actor: KbKnowledgeBaseActor;
  id: string;
  /** 由路由注入：把指定条目在插件侧归档。服务层不碰传输层。 */
  archiveEntries: (entryIds: string[]) => Promise<void>;
}): Promise<KbKnowledgeBaseDeleteResult> {
  const repository = getKbTrainingRepository();
  if (!repository) throw new Error("知识库训练模块未初始化（数据库未挂载）");
  const existing = await repository.getKnowledgeBase(options.id, options.actor.teamId);
  if (!existing) throw new KbKnowledgeBaseError("知识库不存在或不属于当前团队", 404);
  // 与改名/切公开同一条判据：删除比它们更重，更不能让非创建者做。
  if (existing.ownerId !== options.actor.id) {
    throw new KbKnowledgeBaseError("只有创建者可以删除知识库", 403);
  }
  const entryIds = await repository.listPublishedEntryIdsByKnowledgeBase(options.actor.teamId, existing.id);
  if (entryIds.length) {
    try {
      await options.archiveEntries(entryIds);
    } catch (error) {
      throw new KbKnowledgeBaseError(
        `插件里的 ${entryIds.length} 条语料没能下线，已中止删除：${error instanceof Error ? error.message : "插件不可达"}。可以直接重试（下线操作可重复执行）。`,
        502
      );
    }
  }
  await repository.markCandidatesRevokedByKnowledgeBase(options.actor.teamId, existing.id, options.actor.id);
  const result = await repository.deleteKnowledgeBase(existing.id, options.actor.teamId, options.actor.id);
  if (!result.deleted) throw new KbKnowledgeBaseError("知识库删除失败：它已不存在，或你不是创建者", 409);
  return {
    id: existing.id,
    name: existing.name,
    archivedEntries: entryIds.length,
    detachedRuns: result.runsDetached
  };
}

/**
 * 保存「默认知识库」多选清单。
 *
 * `pushToPlugin` 由路由注入（传输层不进服务层，与 `publishKbCandidates` 同姿态）：
 * 插件必须拿到这份清单 —— 自动回复在插件里跑，没有 CRM 请求上下文，
 * 临场问不了 CRM，只能靠 CRM 主动推。
 */
export async function saveEnabledKnowledgeBases(options: {
  actor: KbKnowledgeBaseActor;
  kbIds: string[];
  pushToPlugin: (kbIds: string[]) => Promise<{ ok: boolean; error?: string }>;
}): Promise<KbEnabledSaveResult> {
  const repository = getKbTrainingRepository();
  if (!repository) throw new Error("知识库训练模块未初始化（数据库未挂载）");
  const visible = await repository.listKnowledgeBases(options.actor.teamId, options.actor.id);
  const visibleById = new Map(visible.map((item) => [item.id, item]));
  const rejected: Array<{ id: string; reason: string }> = [];
  const accepted: string[] = [];
  for (const raw of [...new Set(options.kbIds.map((id) => String(id ?? "").trim()).filter(Boolean))]) {
    const kb = visibleById.get(raw);
    if (!kb) {
      rejected.push({ id: raw, reason: "知识库不存在、不在当前团队，或没有公开给你" });
      continue;
    }
    accepted.push(raw);
  }
  const enabled = await repository.setEnabledKnowledgeBases(options.actor.id, options.actor.teamId, accepted);
  // 只要有被拒的就**不推插件**：半套清单推过去比不推更危险（用户看到"已保存"、实际清单是错的）。
  if (rejected.length) {
    return { enabled, rejected, pluginPushed: false, pluginError: "有知识库被拒绝，未同步到 WhatsApp 插件" };
  }
  let pluginPushed = false;
  let pluginError = "";
  try {
    const result = await options.pushToPlugin(enabled);
    pluginPushed = result.ok;
    pluginError = result.ok ? "" : String(result.error || "插件返回失败");
  } catch (error) {
    pluginError = error instanceof Error ? error.message : "插件不可达";
  }
  return { enabled, rejected, pluginPushed, pluginError };
}
