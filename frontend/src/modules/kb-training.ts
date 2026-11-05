/**
 * 知识库训练与知识库。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { confirmAction } from "../prototype-api";
import { type ExamQuestion, type KnowledgeAsset } from "./models";
import { formatTime } from "./dashboard";
import { cookieValue, escapeHtml, qs, qsa } from "./shared";
import { api, setButtonPending, toast } from "./ui";
import { openKnowledgeAsset } from "./knowledge";

// ---------------------------------------------------------------------------
// 知识库训练工作台（P1）：选资料 → 提炼入池 → 人工确认 → 发布到训练库 → 试问验证
//
// 三屏同页：左「选资料」跑批次，中「确认候选」做人工闸，右「试问」验真实命中。
// `preselect` 由后端按纯函数算好（高置信 + 有出处 + 未碰商务红线），前端只照着勾 ——
// 规则不在前端重算一遍，否则两边迟早不一致。
// 候选列表走「批次详情」（一次拿到 counts + 全部候选），筛选在前端本地做：
// P1 单批上限 100 条，本地过滤比多打一次带游标的往返更省事；
// `GET /api/kb/training/candidates` 的游标分页留给 P2 的跨批次视图。
// ---------------------------------------------------------------------------
type KbCandidateKind = "qa" | "snippet" | "policy" | "forbidden";
type KbCandidateStatus = "pending" | "approved" | "rejected" | "published";
type KbRunStatus = "running" | "succeeded" | "partial" | "failed" | "cancelled";
type KbEngine = "cli" | "ai" | "none";

interface KbTrainingSourceRef {
  type?: string;
  assetId?: string;
  title?: string;
  version?: string;
  anchor?: string;
  /** 来源描述（选填，训练时自填），跟着出处一起显示 */
  note?: string;
}

interface KbTrainingCandidate {
  id: string;
  runId: string;
  kind: KbCandidateKind;
  question: string;
  answer: string;
  tags: string[];
  languages: string[];
  confidence: number;
  sourceType: string;
  sourceRef: KbTrainingSourceRef | null;
  rationale: string;
  gapFlag: boolean;
  status: KbCandidateStatus;
  publishedEntryId: string;
  reviewedAt: string;
  createdAt: string;
  preselect: boolean;
}

interface KbTrainingRunStats {
  segments: number;
  candidates: number;
  duplicates: number;
  skipped: number;
  cliCalls: number;
  invented: number;
}

interface KbTrainingProgress {
  totalSegments: number;
  processedSegments: number;
  batches: number;
  batchesDone: number;
  stage: "collecting" | "extracting" | "done";
  startedAt: string;
  updatedAt: string;
}

interface KbTrainingRun {
  id: string;
  status: KbRunStatus;
  engine: KbEngine;
  model: string;
  /** 本批成果归属的知识库。空串 = 本次改动之前的老批次（没有归属）。 */
  kbId?: string;
  stats: KbTrainingRunStats | null;
  /** 运行中进度（老批次为 null）。没有它只能显示「运行中」，用户分不清在跑还是卡死。 */
  progress?: KbTrainingProgress | null;
  /** 这一批还有多少条没确认 —— 列表默认要跳到真正有活的那批。 */
  pendingCount?: number;
  /** 发起时的入参快照：失败后「填回资料」靠它，不必让用户重新选文件。 */
  sourcesJson?: string;
  errorMessage: string;
  createdAt: string;
  finishedAt: string;
}

/**
 * 知识库（训练成果的资产形态）。
 *
 * `isOwner` 决定能不能改（改名 / 切公开私用）—— **别人的公开库只能勾选启用，改不动**，
 * 否则等于谁都能改你的知识口径。`enabled` 是「当前账号的出稿读不读它」。
 */
interface KbKnowledgeBaseView {
  id: string;
  name: string;
  visibility: "owner" | "team";
  ownerId: string;
  ownerName: string;
  isOwner: boolean;
  enabled: boolean;
  /** 已发布到训练库、真正参与出稿的条目数 */
  entryCount: number;
  /** 还没确认的候选数（这个库还在长） */
  pendingCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 启用清单保存结果。插件没推成功必须让用户看见（清单在 CRM 生效、运行端还没生效）。 */
interface KbEnabledSaveResult {
  enabled: string[];
  rejected: Array<{ id: string; reason: string }>;
  pluginPushed: boolean;
  pluginError: string;
}

interface KbProbeEntry {
  id: string;
  kind: KbCandidateKind;
  question: string;
  answer: string;
  verified?: boolean;
  hitCount?: number;
  adoptedCount?: number;
}

/**
 * 一条问答命中，字段与插件 `TrainingLibraryMatch` 逐字一致。
 *
 * 这里踩过一次坑：`hits` 曾经被当成出处（citation）的形状来渲染
 * （读 title/snippet/score），结果每条都渲染成空壳 —— 两者是**不同结构**，
 * 「命中」回答的是「哪条问答对上了、像多少、对了哪些词」，
 * 「出处」回答的是「这句话出自哪一条、切片是什么、历史命中几次」。
 * 所以正文用 `citations`（四类合一、已去重），`hits` 只用来补问答特有的信息。
 */
interface KbProbeMatch {
  entry: KbProbeEntry;
  similarity: number;
  matched: number;
  matchedTerms: string[];
  /** >0 说明这条命中含词典等价匹配（跨语言召回的痕迹）。 */
  expandedHits?: number;
}

/** 可展开的出处（`TrainingCitation`）：三类用途共用，界面按 kind 分组。 */
interface KbProbeCitation {
  refId: string;
  kind: KbCandidateKind;
  title: string;
  snippet: string;
  anchor: string;
  score: number;
  hitTerms: string[];
  verified: boolean;
  adopted: boolean;
  hitCount: number;
  /** 出处三件套（哪个文件 / 哪一段 / 来源描述）：随发布带到插件，有就显示「《文件》§段落 · 描述」。 */
  sourceTitle?: string;
  sourceAnchor?: string;
  sourceNote?: string;
}

/**
 * 插件 `resolve()` 的原样返回。**没有 `blocked` 这个字段** ——
 * 护栏判决在 `verdict` 里（文案由插件给），被拦的场景在 `forbidden` 里。
 * `message` 是前端本地失败（插件不可达 / 路由报错）时自己填的，不是插件字段。
 */
interface KbProbeResult {
  query?: string;
  hits?: KbProbeMatch[];
  snippets?: KbProbeEntry[];
  policies?: KbProbeEntry[];
  forbidden?: KbProbeMatch[];
  forbiddenPhrases?: string[];
  citations?: KbProbeCitation[];
  verdict?: string;
  warnings?: string[];
  /** 插件回报的「知识库清单对本次检索的影响」：没命中时用来区分"被清单挡掉"与"没这条语料"。 */
  kbScope?: {
    configured: boolean;
    enabledKbIds: string[];
    considered: number;
    skippedByScope: number;
  };
  message?: string;
}

interface KbPublishOutcome {
  published: Array<{ id: string; entryId: string }>;
  existing: Array<{ id: string; entryId: string }>;
  failed: Array<{ id: string; reason: string }>;
}

const KB_KIND_TEXT: Record<string, string> = {
  qa: "问答对",
  snippet: "口径片段",
  policy: "政策",
  forbidden: "禁用词"
};

/** 视图态：纯视图偏好 + 本次会话数据，不进 AppState（不该跟着全量持久化走）。 */
const kbTrainingState = {
  loaded: false,
  loading: false,
  runs: [] as KbTrainingRun[],
  activeRunId: "",
  counts: null as Record<string, number> | null,
  candidates: [] as KbTrainingCandidate[],
  /** 本批候选总数（来自 counts）；大于已装条数说明界面只装了前 N 条 —— 必须说出来。 */
  candidateTotal: 0,
  /** 用户在屏 1 暂存的多份资料（本地读取），提交时一起进 `sources.text.items`。note = 来源描述（选填）。 */
  staged: [] as Array<{ title: string; body: string; note: string }>,
  /** 文件中心资料缓存：候选出处可点开时要靠它拿到 asset 对象。 */
  assets: [] as KnowledgeAsset[],
  /** 用户手动动过勾选的候选：预勾选不再覆盖它们，避免"我取消了又被勾回来"。 */
  touched: new Set<string>(),
  selected: new Set<string>(),
  focusIndex: -1,
  /** 正在行内编辑的候选（一次只编辑一条）：编辑态的草稿放这里，重绘不丢。 */
  editId: "",
  editQuestion: "",
  editAnswer: "",
  probe: null as KbProbeResult | null,
  probeQuestion: "",
  /** 自动刷新连续失败次数；到上限就停轮询，避免每 3 秒弹一次错。 */
  pollFailures: 0,
  pollStopped: false,
  /**
   * 已经发出停止请求、但批次还没停下来的 id。
   * 取消是**请求**不是结果（要等飞行中的模型调用结束），这段时间里按钮必须显示
   * 「正在停止…」并禁用 —— 否则按钮回到可点状态，用户会以为没生效而反复点，
   * 而它本来就要等几十秒。
   */
  cancelPending: new Set<string>()
};

/**
 * 知识库屏的状态。与 `kbTrainingState` 分开放：知识库是**账号级**资产（跨批次、可被别人分享），
 * 批次是**本次操作**的上下文，两者的刷新时机不同（勾选启用不该重绘批次列表）。
 */
const kbKnowledgeState = {
  items: [] as KbKnowledgeBaseView[],
  /** 当前账号的启用清单（来自后端，不靠 items[].enabled 拼，避免列表截断时算漏）。 */
  enabledIds: [] as string[],
  loading: false,
  /** 正在提交的行 id：那一行按钮禁用，避免连点产生互相覆盖的两次保存。 */
  pending: new Set<string>(),
  /** 行内改名的草稿（一次只改一条）。 */
  renameId: "",
  renameValue: "",
  /** 顶部搜索框的草稿：只过滤卡片展示，不影响「归入哪个库」下拉（那是提交口径）。 */
  query: "",
  /** 面板底部的常驻提示（插件没同步成功这类"保存成功但没生效"必须留在屏幕上）。 */
  notice: "",
  noticeOk: false
};

/** 自动刷新连续失败几次就停（再刷只是重复报同一个错）。 */
const KB_POLL_FAILURE_LIMIT = 3;

/**
 * 纯展示用的推算常数：后端每 20 段语料调一次 CLI（`kb-training-prompt.ts`
 * 的 `KB_SEGMENTS_PER_CALL`）。前端**不参与提炼决策**，只用它把
 * 「段数 vs 调用次数」翻译成「还有几段没处理」给用户看（§9 降级矩阵 #2）。
 */
const KB_DISPLAY_SEGMENTS_PER_CALL = 20;

let kbTrainingPollTimer: ReturnType<typeof setTimeout> | null = null;
let kbTrainingKeysBound = false;

function kbRunStatusMeta(status: KbRunStatus) {
  if (status === "running") return { text: "运行中", cls: "is-run" };
  if (status === "succeeded") return { text: "已完成", cls: "is-ok" };
  // 注意：文案避开「部分+完成」这个组合词 —— 既有自检禁止在状态展示里用它（易与搜客任务终态混淆）。
  if (status === "partial") return { text: "部分入池", cls: "is-warn" };
  if (status === "cancelled") return { text: "已取消", cls: "is-idle" };
  return { text: "失败", cls: "is-bad" };
}

function kbEngineText(engine: KbEngine, model?: string) {
  if (engine === "cli") return model ? `CLI（${model}）` : "CLI";
  if (engine === "ai") return model ? `模型（${model}）` : "配置模型";
  return "未生效";
}

function kbSourceRefHtml(ref: KbTrainingSourceRef | null, sourceType: string) {
  if (!ref) return "（无出处）";
  const title = ref.title || ref.assetId || "未命名资料";
  const anchor = ref.anchor ? ` ${ref.anchor}` : "";
  const scope = sourceType === "conversation" ? "会话" : ref.assetId ? "文件中心" : "粘贴资料";
  // 关联了文件中心资料就把标题做成链接：候选的出处要能一键回到资料本身，
  // 否则「有出处」只是台账上的一句话，核对仍得自己去文件中心翻。
  const label = ref.assetId
    ? `<a href="#" data-kb-asset="${escapeHtml(ref.assetId)}">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  // 来源描述（选填）：跟着出处一起显示，让人不用翻原文就知道这份资料是谁给的、什么时候的口径。
  const note = ref.note ? ` · ${escapeHtml(ref.note)}` : "";
  return `${label}${escapeHtml(anchor)}${note} · ${scope}`;
}

function kbCandidateStatusTag(candidate: KbTrainingCandidate) {
  if (candidate.status === "published") return `<span class="kb-tag is-ok">已发布</span>`;
  if (candidate.status === "approved") return `<span class="kb-tag is-brand">已确认</span>`;
  if (candidate.status === "rejected") return `<span class="kb-tag is-bad">已丢弃</span>`;
  return `<span class="kb-tag">待确认</span>`;
}

function kbKindTag(candidate: KbTrainingCandidate) {
  const tone = candidate.kind === "qa" ? " is-brand" : candidate.kind === "policy" ? " is-ok" : candidate.kind === "forbidden" ? " is-bad" : "";
  return `<span class="kb-tag${tone}">${escapeHtml(KB_KIND_TEXT[candidate.kind] || candidate.kind)}</span>`;
}

function kbVisibleCandidates(): KbTrainingCandidate[] {
  const status = qs<HTMLSelectElement>("#kbCandidateStatusFilter")?.value || "pending";
  const kind = qs<HTMLSelectElement>("#kbCandidateKindFilter")?.value || "all";
  const confidence = qs<HTMLSelectElement>("#kbCandidateConfidenceFilter")?.value || "all";
  const gapOnly = Boolean(qs<HTMLInputElement>("#kbCandidateGapOnly")?.checked);
  return kbTrainingState.candidates.filter((candidate) => {
    if (status !== "all" && candidate.status !== status) return false;
    if (kind !== "all" && candidate.kind !== kind) return false;
    if (confidence === "high" && candidate.confidence < 0.9) return false;
    if (confidence === "mid" && (candidate.confidence < 0.5 || candidate.confidence >= 0.9)) return false;
    if (confidence === "low" && candidate.confidence >= 0.5) return false;
    if (gapOnly && !candidate.gapFlag) return false;
    return true;
  });
}

/** 从批次 stats 推算「还有多少段没提炼」——有数才能说人话（§9#2）。 */
function kbUnprocessedSegments(run: KbTrainingRun) {
  const stats = run.stats;
  if (!stats || run.status !== "partial") return 0;
  const processed = stats.cliCalls * KB_DISPLAY_SEGMENTS_PER_CALL;
  return Math.max(0, stats.segments - processed);
}

/** 批次卡片下方的「该怎么办」提示：降级必须可见，而且要能照着做（§9 全表）。 */
function kbRunAdvice(run: KbTrainingRun) {
  const unprocessed = kbUnprocessedSegments(run);
  // 取消的「发生了什么」由批次自带的说明负责（停在半路 / 停在最后一批，说法不同）；
  // 这里只说**下一步做什么**，否则同一张卡片上两行字在重复同一句话。
  if (run.status === "cancelled") return "下一步：确认右侧候选后发布；剩余段落要补齐，点下面「用同一份资料再训一次」";
  if (run.status === "failed") return "引擎或插件不可用：修好后把同一份资料再提交一次即可（重复条目不会再进库）";
  if (unprocessed > 0) return `还有约 ${unprocessed} 段没提炼：把同一份资料再提交一次补齐，已进库的不会重复`;
  if (run.status === "succeeded" && run.stats && run.stats.candidates === 0) {
    const why = run.stats.duplicates > 0
      ? `${run.stats.duplicates} 条与库里既有条目重复`
      : "这份资料里没有能变成问答 / 口径 / 政策的内容";
    return `本批没有新增条目：${why}。可以换一份更具体（参数、口径、常见问答）的资料`;
  }
  if (run.status === "partial") return "本批只完成了一部分：先把已出的候选处理掉，再补提剩余段落";
  return "";
}

/** 运行耗时：结束时用 finishedAt，运行中用「此刻」—— 每秒刷新由轮询重绘带动。 */
function kbRunElapsedText(run: KbTrainingRun): string {
  const start = new Date(run.progress?.startedAt || run.createdAt).getTime();
  const end = run.status === "running" ? Date.now() : new Date(run.finishedAt || run.createdAt).getTime();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** 进度百分比：没有总段数时不画进度条（宁可没有，也不要一个假的 0%）。 */
function kbRunPercent(run: KbTrainingRun): number {
  const progress = run.progress;
  if (!progress?.totalSegments) return 0;
  const done = Math.max(0, Math.min(progress.processedSegments, progress.totalSegments));
  return Math.max(2, Math.round((done / progress.totalSegments) * 100));
}

/**
 * 批次卡片里的进度行。
 *
 * 为什么值得单独一行：200 段资料 = 10 次 CLI 调用，最坏要十几分钟。
 * 没有百分比时用户只有两种解读 —— 「在跑」或「卡死了」，而这两种的下一步完全相反
 * （等 vs 取消重来）。进度条 + 「第 3/10 批 · 已处理 45/200 段 · 2m 10s」就是那份证据。
 */
function kbRunProgressHtml(run: KbTrainingRun): string {
  if (run.status !== "running") {
    // 结束态保留一行极简事实：这批到底处理了多少段（失败时更要看）。
    const progress = run.progress;
    if (!progress?.totalSegments) return "";
    return `<div class="kb-run-done"><span>已处理 ${progress.processedSegments}/${progress.totalSegments} 段</span><span>${kbRunElapsedText(run)}</span></div>`;
  }
  const percent = kbRunPercent(run);
  const progress = run.progress;
  const elapsed = kbRunElapsedText(run);
  // 第一批还在飞时进度必然是 0：一次 CLI 调用常 30~90 秒，条子钉在 2% 与「卡死」无法区分。
  // 这一段改用不定长扫光，并把「单批要多久」直接写出来 —— 用户据此决定等还是停。
  const pendingFirstBatch = Boolean(progress?.totalSegments) && (progress?.batchesDone ?? 0) === 0;
  const detail = progress?.totalSegments
    ? (pendingFirstBatch
      ? `模型正在提炼第 1/${progress.batches} 批（单批通常 1~2 分钟）· 已等待 ${elapsed}`
      : `第 ${Math.min(progress.batchesDone + 1, progress.batches)}/${progress.batches} 批 · 已处理 ${progress.processedSegments}/${progress.totalSegments} 段 · ${elapsed}`)
    : `正在读取资料 · ${elapsed}`;
  const bar = pendingFirstBatch
    ? `<div class="kb-run-bar"><i></i></div>`
    : `<div class="kb-run-bar"><i style="width:${percent}%"></i></div>`;
  const aria = pendingFirstBatch
    ? `aria-busy="true"`
    : `aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"`;
  return `<div class="kb-run-progress${pendingFirstBatch ? " is-pending" : ""}" role="progressbar" ${aria}>
    ${bar}
    <span>${detail}</span>
  </div>`;
}

function renderKbRunList() {
  const host = qs<HTMLElement>("#kbRunList");
  if (!host) return;
  if (kbTrainingState.loading && !kbTrainingState.runs.length) {
    host.innerHTML = `<div class="kb-empty">正在读取训练批次…</div>`;
    return;
  }
  if (!kbTrainingState.runs.length) {
    host.innerHTML = `<div class="kb-empty">还没有训练批次：填好标题与正文，点「开始训练」</div>`;
    return;
  }
  // 轮询连续失败后停掉自动刷新：界面必须说明「停在哪一步、怎么恢复」，
  // 否则用户只会看到数据不再变化，以为是自己看错了。
  const notice = kbTrainingState.pollStopped
    ? `<div class="kb-truncated">自动刷新已停（连续 ${kbTrainingState.pollFailures} 次读取失败）：点右上角「刷新」重试</div>`
    : "";
  host.innerHTML = notice + kbTrainingState.runs.map((run) => {
    const meta = kbRunStatusMeta(run.status);
    const stats = run.stats;
    const statsText = stats
      ? `语料 ${stats.segments} 段 · 入池 ${stats.candidates} 条 · 重复 ${stats.duplicates} · 无出处 ${stats.skipped} · 越界 ${stats.invented}`
      : "等待提炼结果…";
    const advice = kbRunAdvice(run);
    // 批次上标明「这批发布后会归入哪个库」：发布是逐条带上 kbId 的，
    // 用户不在卡片上看到归属，发布完就只能在知识库列表里反推。
    const kbName = kbKnowledgeNameOf(run.kbId);
    return `<article class="kb-run-card${run.id === kbTrainingState.activeRunId ? " is-active" : ""}" data-kb-run="${escapeHtml(run.id)}" role="button" tabindex="0">
      <div class="kb-run-top">
        <span class="kb-tag ${meta.cls}">${meta.text}</span>
        <span class="kb-tag">${escapeHtml(kbEngineText(run.engine, run.model))}</span>
        ${kbName ? `<span class="kb-tag is-kb" title="这批发布的候选归入：${escapeHtml(kbName)}">库：${escapeHtml(kbName)}</span>` : ""}
        ${run.pendingCount ? `<span class="kb-tag is-warn">待确认 ${run.pendingCount}</span>` : ""}
        <span class="kb-run-time">${escapeHtml(formatTime(run.createdAt))}</span>
      </div>
      ${kbRunProgressHtml(run)}
      <div class="kb-run-stats">${escapeHtml(statsText)}</div>
      ${advice ? `<div class="kb-run-stats kb-run-advice">${escapeHtml(advice)}</div>` : ""}
      ${run.errorMessage ? `<div class="kb-run-error">${escapeHtml(run.errorMessage)}</div>` : ""}
      ${run.status === "running"
        ? (kbTrainingState.cancelPending.has(run.id)
          ? `<div class="kb-run-actions"><button type="button" class="kb-run-action" data-kb-run-cancel="${escapeHtml(run.id)}" disabled>正在停止…（等当前这批结束）</button></div>`
          : `<div class="kb-run-actions"><button type="button" class="kb-run-action" data-kb-run-cancel="${escapeHtml(run.id)}">停止这批</button></div>`)
        : run.status === "failed" || run.status === "partial" || run.status === "cancelled"
          ? `<div class="kb-run-actions"><button type="button" class="kb-run-action" data-kb-run-retry="${escapeHtml(run.id)}">用同一份资料再训一次</button></div>`
          : ""}
    </article>`;
  }).join("");
}

function syncKbCandidateSelection() {
  const count = qs<HTMLElement>("#kbCandidateSelectedCount");
  if (count) count.textContent = `已选 ${kbTrainingState.selected.size} 条`;
  qsa<HTMLInputElement>("#kbCandidateList input[data-kb-pick]").forEach((input) => {
    const id = input.dataset.kbPick || "";
    const picked = kbTrainingState.selected.has(id);
    input.checked = picked;
    input.closest(".kb-candidate")?.classList.toggle("is-selected", picked);
  });
  const size = kbTrainingState.selected.size;
  ["#kbReviewSelectedButton", "#kbDropSelectedButton", "#kbPublishButton"].forEach((selector) => {
    const button = qs<HTMLButtonElement>(selector);
    if (button) button.disabled = size === 0;
  });
  // 「全选本页」是**有状态的**：这一屏已经全勾上时同一个位置变成「取消全选」。
  // 只换文案与 title，不新增第二个按钮 —— 两个并列按钮里总有一个是当前点不动的。
  const selectVisible = qs<HTMLButtonElement>("#kbSelectVisibleButton");
  if (selectVisible) {
    const rows = kbVisibleCandidates();
    const allPicked = rows.length > 0 && rows.every((candidate) => kbTrainingState.selected.has(candidate.id));
    selectVisible.disabled = rows.length === 0;
    selectVisible.textContent = allPicked ? "取消全选" : "全选本页";
    selectVisible.title = rows.length
      ? `${allPicked ? "取消勾选" : "勾选"}当前筛选下这一屏的 ${rows.length} 条（列表外的条目不受影响）`
      : "当前筛选下没有候选";
  }
}

/** 重绘前记住编辑框的光标位置：轮询 / 其它重绘不该把正在打字的人打断。 */
function kbEditFocusSnapshot(): { field: string; start: number; end: number } | null {
  const active = document.activeElement as HTMLTextAreaElement | null;
  const field = active?.dataset?.kbEdit;
  if (!field) return null;
  return { field, start: active!.selectionStart, end: active!.selectionEnd };
}

function kbRestoreEditFocus(snapshot: { field: string; start: number; end: number } | null) {
  if (!snapshot) return;
  const el = qs<HTMLTextAreaElement>(`#kbCandidateList textarea[data-kb-edit="${snapshot.field}"]`);
  if (!el) return;
  el.focus();
  el.setSelectionRange(snapshot.start, snapshot.end);
}

/** 空候选 / 截断都得说清是哪一种：三者（截断、筛掉了、真没有）用户的下一步完全不同。 */
function kbCandidateNoticeText(visibleCount: number): string {
  if (kbTrainingState.candidateTotal > kbTrainingState.candidates.length) {
    return `本批共 ${kbTrainingState.candidateTotal} 条候选，界面只装了前 ${kbTrainingState.candidates.length} 条：先按状态 / 类型筛着处理，剩下的下一屏再来。`;
  }
  if (!visibleCount && kbTrainingState.activeRunId) {
    const run = kbTrainingState.runs.find((item) => item.id === kbTrainingState.activeRunId);
    const stats = run?.stats;
    if (stats && stats.candidates === 0) {
      return kbRunAdvice(run!) || "本批没有提炼出候选：换一份内容更具体的资料再试。";
    }
    return "当前筛选下没有候选：把上面的状态或类型切回「全部」看看。";
  }
  return "";
}

function renderKbCandidateList() {
  const host = qs<HTMLElement>("#kbCandidateList");
  const summary = qs<HTMLElement>("#kbCandidateSummary");
  const counts = kbTrainingState.counts;
  if (summary) {
    // 只显示条数：在这里追加「运行端读副本」会把标题挤成三行（1280 宽实测 96px vs 60px），
    // 那句话放副标与按钮 title 里，位置更合适。
    summary.textContent = counts
      ? `待确认 ${counts.pending || 0} · 已确认 ${counts.approved || 0} · 已发布 ${counts.published || 0} 条 · 已丢弃 ${counts.rejected || 0}`
      : "选一个批次开始";
  }
  if (!host) return;
  const notice = qs<HTMLElement>("#kbCandidateNotice");
  const setNotice = (text: string) => {
    if (!notice) return;
    notice.textContent = text;
    notice.hidden = !text;
  };
  if (!kbTrainingState.activeRunId) {
    host.innerHTML = `<div class="kb-empty">先在左侧选中一个训练批次</div>`;
    setNotice("");
    syncKbCandidateSelection();
    return;
  }
  const rows = kbVisibleCandidates();
  if (kbTrainingState.focusIndex >= rows.length) kbTrainingState.focusIndex = rows.length - 1;
  if (!rows.length) {
    host.innerHTML = `<div class="kb-empty">当前筛选下没有候选</div>`;
    setNotice(kbCandidateNoticeText(0));
    syncKbCandidateSelection();
    return;
  }
  setNotice(kbCandidateNoticeText(rows.length));
  const focusSnapshot = kbEditFocusSnapshot();
  host.innerHTML = rows.map((candidate, index) => {
    const editing = candidate.id === kbTrainingState.editId;
    const meta = [
      `<span>出处：${kbSourceRefHtml(candidate.sourceRef, candidate.sourceType)}</span>`,
      candidate.rationale ? `<span>依据：${escapeHtml(candidate.rationale)}</span>` : "",
      candidate.tags?.length ? `<span>标签：${escapeHtml(candidate.tags.join("、"))}</span>` : ""
    ].filter(Boolean).join("");
    const actions = candidate.status === "published"
      ? `<button class="btn" data-kb-act="revoke" data-kb-id="${escapeHtml(candidate.id)}">从训练库撤回</button>`
      : editing
        ? `<button class="btn" data-kb-act="edit-cancel" data-kb-id="${escapeHtml(candidate.id)}">取消编辑</button>
           <button class="btn primary" data-kb-act="edit-confirm" data-kb-id="${escapeHtml(candidate.id)}">保存并确认</button>`
        // 待确认的行**不渲染发布键**：发布是确认之后的事，把按钮摆在第一步就会有人点。
        // 后端也会拒，但界面上少一个「点了报错」的入口，比事后解释更省事。
        : `<button class="btn" data-kb-act="edit-start" data-kb-id="${escapeHtml(candidate.id)}">编辑</button>
           ${candidate.status === "pending" ? `<button class="btn" data-kb-act="confirm" data-kb-id="${escapeHtml(candidate.id)}">确认</button>` : ""}
           <button class="btn" data-kb-act="drop" data-kb-id="${escapeHtml(candidate.id)}">丢弃</button>
           ${candidate.status === "approved" ? `<button class="btn primary" data-kb-act="publish" data-kb-id="${escapeHtml(candidate.id)}">发布</button>` : ""}`;
    const note = editing
      ? "改完点「保存并确认」：改过内容的条目会重算指纹，下次训练同一份资料不会再被当成重复"
      : candidate.status === "published"
        ? "已进训练库（运行端读副本）；撤回只是下架，运行端保留留痕"
        : !candidate.sourceRef
          ? "没有出处，无法发布"
          : candidate.status === "approved"
            ? "已确认，点「发布」后进训练库"
            : "人工确认后才会进训练库";
    const content = editing
      ? `<div class="kb-edit">
           <label><span>问法（口径片段 / 政策可为空）</span><textarea data-kb-edit="question" rows="2" maxlength="2000">${escapeHtml(kbTrainingState.editQuestion)}</textarea></label>
           <label><span>答案</span><textarea data-kb-edit="answer" rows="6" maxlength="4000">${escapeHtml(kbTrainingState.editAnswer)}</textarea></label>
         </div>`
      : `${candidate.question ? `<div class="kb-candidate-q">${escapeHtml(candidate.question)}</div>` : ""}
         <div class="kb-candidate-a">${escapeHtml(candidate.answer)}</div>`;
    return `<article class="kb-candidate${candidate.status === "published" ? " is-published" : ""}${editing ? " is-editing" : ""}" data-kb-candidate="${escapeHtml(candidate.id)}" data-kb-index="${index}" tabindex="0">
      <label class="kb-check"><input type="checkbox" data-kb-pick="${escapeHtml(candidate.id)}"></label>
      <div class="kb-candidate-body">
        <div class="kb-candidate-top">
          ${kbKindTag(candidate)}
          ${kbCandidateStatusTag(candidate)}
          ${candidate.preselect ? `<span class="kb-tag is-run">预勾选</span>` : ""}
          ${candidate.gapFlag ? `<span class="kb-tag is-warn">知识缺口</span>` : ""}
          <span class="kb-conf">置信 ${escapeHtml(candidate.confidence.toFixed(2))}</span>
        </div>
        ${content}
        <div class="kb-candidate-meta">${meta}</div>
        <div class="kb-candidate-actions">
          <span>${note}</span>
          ${actions}
        </div>
      </div>
    </article>`;
  }).join("");
  if (kbTrainingState.focusIndex >= 0) focusKbCandidate(kbTrainingState.focusIndex);
  kbRestoreEditFocus(focusSnapshot);
  syncKbCandidateSelection();
}

/**
 * 出处按类型分组 —— `citations` 四类合一是按「主依据 → 分数」排的，
 * 直接平铺看不出层次。禁用类不在这里列：它已经在红色块里说过一次了。
 */
const KB_PROBE_GROUPS: Array<{ kind: KbCandidateKind; title: string }> = [
  { kind: "qa", title: "命中的问答对" },
  { kind: "snippet", title: "会一并进提示词的口径片段" },
  { kind: "policy", title: "并入护栏的政策（全量注入）" }
];

function kbProbeCitationHtml(citation: KbProbeCitation, match?: KbProbeMatch) {
  const tags = [
    citation.verified ? `<span class="kb-tag is-ok">已校订</span>` : "",
    citation.adopted ? `<span class="kb-tag is-brand">被采纳过</span>` : "",
    citation.hitCount ? `<span class="kb-tag">历史命中 ${citation.hitCount}</span>` : "",
    match?.expandedHits ? `<span class="kb-tag is-run">含词典等价命中 ${match.expandedHits}</span>` : ""
  ].filter(Boolean).join(" ");
  // 问答对报相似度与共同特征数；口径 / 政策报分数（政策恒为 1，不代表相关度）。
  const detail = [
    citation.hitTerms?.length ? `命中词：${citation.hitTerms.join("、")}` : "",
    match ? `相似度 ${match.similarity.toFixed(3)} · 共同特征 ${match.matched}` : `得分 ${citation.score.toFixed(3)}`
  ].filter(Boolean).join(" · ");
  // 出处三件套：「《文件》§段落 · 描述」。anchor 自带 § 前缀（生成时就是 `§${index}`），
  // 这里只拼不加工。有才显示 —— 历史条目 / 人工录入没有这套。
  const sourceBits = [
    citation.sourceTitle ? `《${citation.sourceTitle}》` : "",
    citation.sourceAnchor || "",
    citation.sourceNote || ""
  ].filter(Boolean).join(" ");
  return `<div class="kb-probe-hit">
    <b>${escapeHtml(citation.title || citation.refId)}</b> ${tags}
    ${sourceBits ? `<div class="kb-cite"><em>出处：${escapeHtml(sourceBits)}</em></div>` : ""}
    ${citation.anchor ? `<div class="kb-cite"><em>章节：${escapeHtml(citation.anchor)}</em></div>` : ""}
    <div>${escapeHtml(citation.snippet)}</div>
    ${detail ? `<div class="kb-cite"><em>${escapeHtml(detail)}</em></div>` : ""}
  </div>`;
}

function renderKbProbe() {
  const host = qs<HTMLElement>("#kbProbeResult");
  if (!host) return;
  const probe = kbTrainingState.probe;
  if (!probe) {
    host.innerHTML = `<div class="kb-empty">输入一句客户问法，看运行端实际会引用哪几条、会不会撞护栏</div>`;
    return;
  }
  // 本地失败（插件不可达 / 路由报错）只有 message，没有 verdict —— 别把它当成「知识缺口」。
  if (probe.message && !probe.verdict) {
    host.innerHTML = `<div class="kb-empty">${escapeHtml(probe.message)}</div>`;
    return;
  }
  const citations = probe.citations || [];
  const forbidden = probe.forbidden || [];
  const parts: string[] = [];
  // ① 护栏判决：文案是插件那条 resolve() 自己给的结论，前端不另行总结。
  parts.push(`<div class="kb-verdict"><b>问法：</b>${escapeHtml(kbTrainingState.probeQuestion)}${probe.verdict ? `<div>${escapeHtml(probe.verdict)}</div>` : ""}</div>`);
  // ①.5 检索范围：**「明明有这个库却没命中」的唯一判据就在这里**。
  //      停用某个知识库后某条问法突然答不上来，用户只能靠这三个数（启用几个库 /
  //      实际读了几条 / 被清单挡了几条）判断是"被清单挡掉"还是"库里压根没有这条语料"。
  const scope = probe.kbScope;
  if (scope) {
    const enabledCount = scope.enabledKbIds?.length || 0;
    const scopeText = (scope.configured
      ? `检索范围：启用 ${enabledCount} 个知识库，参与检索 ${scope.considered} 条语料`
      : `检索范围：还没设置默认知识库（按兼容口径读自有语料）${scope.considered} 条`)
      + (scope.skippedByScope ? `，另有 ${scope.skippedByScope} 条因不在启用清单里被跳过` : "");
    parts.push(`<div class="kb-cite">${escapeHtml(scopeText)}</div>`);
  }
  // ② 「哪句被拦、为什么」：客户这句踩到禁用场景就该转人工，不是让模型自由发挥。
  if (forbidden.length) {
    parts.push(`<div class="kb-forbidden"><b>客户这句话踩到禁用场景，自动回复会转人工。</b>${forbidden
      .map((item) => `<div>命中的禁用场景：${escapeHtml(item.entry.question || item.entry.answer)}</div>`)
      .join("")}</div>`);
  }
  for (const warning of probe.warnings || []) parts.push(`<div class="kb-warn-line">${escapeHtml(warning)}</div>`);
  if (!citations.length) {
    parts.push(`<div class="kb-empty">没有命中任何条目：这条问法就是知识缺口 —— 运行端不会给出业务口径，只会走话术库或转人工。把它补成一条问答再试。</div>`);
    host.innerHTML = parts.join("");
    return;
  }
  // ③ 分组出处：citations 已经四类合一且按条目去重，**不能**再跟 hits 相加
  //    （同一问答会出现在两处，条数会凭空翻倍）。hits 只用来补问答特有的相似度与词典等价命中。
  const matchesById = new Map((probe.hits || []).map((hit) => [hit.entry.id, hit]));
  for (const group of KB_PROBE_GROUPS) {
    const items = citations.filter((citation) => citation.kind === group.kind);
    if (!items.length) continue;
    parts.push(`<section class="kb-probe-group"><header>${group.title} · ${items.length}</header>${
      items.map((citation) => kbProbeCitationHtml(citation, matchesById.get(citation.refId))).join("")
    }</section>`);
  }
  if (probe.forbiddenPhrases?.length) {
    parts.push(`<div class="kb-cite"><em>库里启用 ${probe.forbiddenPhrases.length} 条禁用短语，出稿时会逐条校验回复内容</em></div>`);
  }
  host.innerHTML = parts.join("");
}

/**
 * 五步流水线。这一屏最容易迷路的地方是「我现在该做什么」：
 * 选资料 / 确认 / 发布分散在三块面板里，每块都在说自己的事。
 * 顶部这条把「已完成到哪、下一步是什么」压成一句话，并让当前该做的那步高亮。
 */
function renderKbPipeline() {
  const host = qs<HTMLElement>("#kbPipeline");
  if (!host) return;
  const run = kbTrainingState.runs.find((item) => item.id === kbTrainingState.activeRunId);
  const counts = kbTrainingState.counts;
  const staged = kbTrainingState.staged.length;
  const pending = counts?.pending || 0;
  const published = counts?.published || 0;
  const enabledBases = kbKnowledgeState.enabledIds.length;
  const running = run?.status === "running";
  const steps = [
    {
      key: "source",
      label: "选资料",
      value: staged ? `已就绪 ${staged} 份` : "PDF / Word / 文本",
      done: staged > 0 || Boolean(run),
      active: !run && staged === 0
    },
    {
      key: "train",
      label: "提炼",
      value: running
        ? `${kbRunPercent(run!)}% · ${kbRunElapsedText(run!)}`
        : run
          ? kbRunStatusMeta(run.status).text
          : "等待提交",
      done: Boolean(run && run.status !== "running"),
      active: running
    },
    {
      key: "review",
      label: "确认",
      value: pending ? `待确认 ${pending}` : "没有待确认",
      done: pending === 0 && Boolean(counts?.total),
      active: Boolean(run && !running && pending > 0)
    },
    {
      key: "publish",
      label: "发布",
      value: published ? `已发布 ${published} 条` : "等待确认",
      done: published > 0,
      active: Boolean(run && !running && pending === 0 && (counts?.approved || 0) > 0)
    },
    {
      key: "live",
      label: "生效",
      value: enabledBases ? `启用 ${enabledBases} 个库` : "未启用任何库",
      done: enabledBases > 0,
      active: published > 0 && enabledBases === 0
    }
  ];
  host.innerHTML = `<ol>${steps.map((step, index) => `
    <li class="kb-step${step.done ? " is-done" : ""}${step.active ? " is-active" : ""}" data-kb-step="${step.key}">
      <b>${String(index + 1).padStart(2, "0")}</b>
      <span>${step.label}</span>
      <em>${escapeHtml(step.value)}</em>
    </li>`).join("")}</ol>`;
}

function renderKbTraining() {
  renderKbPipeline();
  renderKbRunList();
  renderKbKnowledgePanel();
  renderKbCandidateList();
  renderKbProbe();
}

// ---------------------------------------------------------------------------
// 知识库：公开 / 私用 + 账号级「默认知识库」多选启用
//
// 这一块是「训练成果能不能被别人用」的全部入口。三条判据：
//  1. **勾选即启用，启用即生效**：没有"保存"按钮 —— 多一步就会有人勾完不点保存，
//     然后以为启用了（出稿没变化，只能靠猜）。每次勾选都立刻落库并推给插件。
//  2. **保存成功 ≠ 生效**：CRM 存下了但插件没推成功时，必须**常驻提示**，
//     因为这时试问/自动回复仍按旧清单走 —— 只弹一个会消失的 toast 等于没说。
//  3. **改不动就直说**：别人的库不渲染「改名 / 切公开」按钮（而不是渲染出来点了报错）。
// ---------------------------------------------------------------------------

function setKbKnowledgeNotice(text: string, ok = false) {
  kbKnowledgeState.notice = text;
  kbKnowledgeState.noticeOk = ok;
  const host = qs<HTMLElement>("#kbKnowledgeNotice");
  if (!host) return;
  host.hidden = !text;
  host.textContent = text;
  host.classList.toggle("is-ok", ok);
}

async function loadKbKnowledgeBases(options: { silent?: boolean } = {}) {
  if (kbKnowledgeState.loading) return;
  kbKnowledgeState.loading = true;
  try {
    const result = await api<{ items: KbKnowledgeBaseView[]; enabledIds: string[] }>("/api/kb/training/knowledge-bases");
    kbKnowledgeState.items = result.items || [];
    kbKnowledgeState.enabledIds = result.enabledIds || [];
    // 服务端已推的清单与本地勾选若有出入（例如插件恢复后重新同步），以服务端为准；
    // 只在没有待提交的行时清提示，否则会把用户刚看到的结果冲掉。
    if (!kbKnowledgeState.pending.size && !kbKnowledgeState.notice) setKbKnowledgeNotice("");
  } catch (error) {
    if (!options.silent) {
      setKbKnowledgeNotice(error instanceof Error ? error.message : "知识库加载失败", false);
      toast("知识库加载失败", "error");
    }
  } finally {
    kbKnowledgeState.loading = false;
    renderKbKnowledgePanel();
  }
}

/** 自己的排前面：要改的东西聚在一起，别人的分享只用来勾选。 */
function kbKnowledgeSorted(): KbKnowledgeBaseView[] {
  return [...kbKnowledgeState.items].sort((left, right) => {
    if (left.isOwner !== right.isOwner) return left.isOwner ? -1 : 1;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

/** 知识库卡片：语言同「工具中心」tool-card（图标 + 标题 + 徽标 + hover 抬升）。
    卡片上的勾选框就是启用开关 —— 数据属性与旧的行式布局完全一致，
    事件仍委托在 #kbKnowledgeList 容器上，这里只换壳不换行为。 */
function kbKnowledgeRowHtml(item: KbKnowledgeBaseView): string {
  const id = escapeHtml(item.id);
  const busy = kbKnowledgeState.pending.has(item.id);
  const icon = `<span class="kb-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5V5.5"/><path d="M9 7.5h7M9 11.5h5"/></svg></span>`;
  if (kbKnowledgeState.renameId === item.id) {
    return `<article class="kb-card is-renaming" data-kb-kb="${id}">
      ${icon}
      <div class="kb-card-rename">
        <input data-kb-kb-name-input maxlength="200" placeholder="给这个知识库起个名字，列表里才认得出" value="${escapeHtml(kbKnowledgeState.renameValue)}">
        <button type="button" data-kb-kb-name-save ${busy ? "disabled" : ""}>保存</button>
        <button type="button" data-kb-kb-name-cancel>取消</button>
      </div>
    </article>`;
  }
  const tags = [
    item.isOwner
      ? `<span class="kb-kb-tag is-mine">我创建的</span>`
      : `<span class="kb-kb-tag">${escapeHtml(item.ownerName)} 分享</span>`,
    item.visibility === "team"
      ? `<span class="kb-kb-tag is-public">公开</span>`
      : `<span class="kb-kb-tag">私用</span>`
  ].join("");
  const stats = [
    `已发布 ${item.entryCount} 条`,
    item.pendingCount ? `待确认 ${item.pendingCount} 条` : "",
    `更新于 ${formatTime(item.updatedAt)}`
  ].filter(Boolean).join(" · ");
  return `<article class="kb-card${item.enabled ? "" : " is-off"}" data-kb-kb="${id}">
    <div class="kb-card-main">
      ${icon}
      <div class="kb-card-body">
        <div class="kb-card-title"><span class="kb-kb-name">${escapeHtml(item.name)}</span>${tags}</div>
        <div class="kb-card-desc">${escapeHtml(stats)}</div>
      </div>
    </div>
    <div class="kb-card-foot">
      <label class="kb-card-switch" title="勾选即启用：出稿与试问立刻按这个清单读语料">
        <input type="checkbox" data-kb-kb-enable="${id}" ${item.enabled ? "checked" : ""} ${busy ? "disabled" : ""}>
        <span>${item.enabled ? "启用中" : "未启用"}</span>
      </label>
      <div class="kb-card-actions">
        <button type="button" data-kb-kb-open="${id}">查看 ${item.entryCount} 条</button>
        ${item.isOwner ? `<button type="button" data-kb-kb-visibility="${id}" ${busy ? "disabled" : ""}>${item.visibility === "team" ? "改为私用" : "公开给团队"}</button>` : ""}
        ${item.isOwner ? `<button type="button" data-kb-kb-rename="${id}" ${busy ? "disabled" : ""}>改名</button>` : ""}
        ${item.isOwner ? `<button type="button" class="is-danger" data-kb-kb-delete="${id}" ${busy ? "disabled" : ""}>删除</button>` : ""}
      </div>
    </div>
  </article>`;
}

function renderKbKnowledgePanel() {
  renderKbTargetOptions();
  const query = kbKnowledgeState.query.trim().toLowerCase();
  const all = kbKnowledgeSorted();
  // 搜索只过滤展示，不动提交口径：「归入哪个库」下拉仍列全量（上面 renderKbTargetOptions）。
  const items = query ? all.filter((item) => item.name.toLowerCase().includes(query)) : all;
  const summary = qs<HTMLElement>("#kbKnowledgeSummary");
  if (summary) {
    if (!all.length) {
      summary.textContent = "还没有知识库";
    } else if (query) {
      summary.textContent = `匹配 ${items.length} / 共 ${all.length} 个`;
    } else {
      const enabled = kbKnowledgeState.enabledIds.length;
      const shared = all.filter((item) => !item.isOwner).length;
      summary.textContent = `已启用 ${enabled} / 可勾选 ${all.length} 个${shared ? ` · 其中 ${shared} 个是别人分享的` : ""}`;
    }
  }
  const host = qs<HTMLElement>("#kbKnowledgeList");
  if (host) {
    // 知识库是后来才有的：更早的批次 kbId 为空，语料已经发布、也仍在参与出稿。
    // 不说明这件事，用户看到「0 个知识库 / 8 条已发布」只会觉得系统自相矛盾。
    const legacyRuns = kbTrainingState.runs.filter((run) => !run.kbId).length;
    const legacyNotice = legacyRuns
      ? `<div class="kb-kb-legacy">另有 ${legacyRuns} 个历史批次（知识库功能上线前）没有归库：它们的语料照常参与出稿，不影响使用。</div>`
      : "";
    host.innerHTML = legacyNotice + (items.length
      ? items.map(kbKnowledgeRowHtml).join("")
      : query
        ? `<div class="kb-empty">没有匹配「${escapeHtml(kbKnowledgeState.query.trim())}」的知识库：换个名字试试，或清空搜索看全部。</div>`
        : `<div class="kb-empty">还没有知识库。在左边发起一次训练会自动建一个；训练完把候选发布进它，它才会参与出稿。</div>`);
  }
  const notice = qs<HTMLElement>("#kbKnowledgeNotice");
  if (notice) {
    notice.hidden = !kbKnowledgeState.notice;
    notice.textContent = kbKnowledgeState.notice;
    notice.classList.toggle("is-ok", kbKnowledgeState.noticeOk);
  }
  // 启用清单影响流水线第 5 步（「生效」），重绘知识库后顺手刷新步骤条。
  renderKbPipeline();
}

/**
 * 保存启用清单。**不做乐观更新**：清单的实际生效点是插件，先按用户点的那一份渲染、
 * 失败再回滚，会在失败时留下一瞬间的假象；这里改成"提交中禁用该行 → 按服务端返回重绘"。
 */
async function saveKbEnabledKnowledgeBases(nextIds: string[], successText: string) {
  const result = await api<KbEnabledSaveResult>("/api/kb/training/knowledge-bases/defaults", {
    method: "PUT",
    body: JSON.stringify({ kbIds: nextIds })
  });
  kbKnowledgeState.enabledIds = result.enabled || [];
  if (result.rejected?.length) {
    setKbKnowledgeNotice(
      `有 ${result.rejected.length} 个知识库没能启用（${result.rejected.map((item) => item.id).join("、")}）：${result.rejected[0].reason}`,
      false
    );
  } else if (!result.pluginPushed) {
    setKbKnowledgeNotice(
      `清单已存到 CRM，但同步到 WhatsApp 插件失败（${result.pluginError}）：在插件恢复前，出稿与试问仍按旧清单读语料。`,
      false
    );
  } else {
    setKbKnowledgeNotice(`${successText}：已启用 ${kbKnowledgeState.enabledIds.length} 个知识库，出稿与试问即刻按这个清单读语料。`, true);
  }
}

async function toggleKbKnowledgeEnabled(id: string, next: boolean) {
  if (kbKnowledgeState.pending.has(id)) return;
  const nextIds = new Set(kbKnowledgeState.enabledIds);
  if (next) nextIds.add(id);
  else nextIds.delete(id);
  kbKnowledgeState.pending.add(id);
  renderKbKnowledgePanel();
  try {
    await saveKbEnabledKnowledgeBases([...nextIds], next ? "已启用" : "已停用");
  } catch (error) {
    const message = error instanceof Error ? error.message : "启用清单保存失败";
    setKbKnowledgeNotice(message, false);
    toast(message, "error");
  } finally {
    kbKnowledgeState.pending.delete(id);
    // 无论成败都以后端为准重读：失败时它负责把勾选状态改回来。
    await loadKbKnowledgeBases({ silent: true });
  }
}

async function toggleKbKnowledgeVisibility(id: string) {
  const item = kbKnowledgeState.items.find((kb) => kb.id === id);
  if (!item || !item.isOwner || kbKnowledgeState.pending.has(id)) return;
  const next = item.visibility === "team" ? "owner" : "team";
  kbKnowledgeState.pending.add(id);
  renderKbKnowledgePanel();
  try {
    await api(`/api/kb/training/knowledge-bases/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: next })
    });
    setKbKnowledgeNotice(
      next === "team"
        ? `「${item.name}」已公开：同团队账号可以在他们自己的清单里勾选启用它。`
        : `「${item.name}」已改为私用：除了你，别人看不到了。`,
      true
    );
    toast(next === "team" ? "已公开给团队" : "已改为私用");
  } catch (error) {
    const message = error instanceof Error ? error.message : "公开状态修改失败";
    setKbKnowledgeNotice(message, false);
    toast(message, "error");
  } finally {
    kbKnowledgeState.pending.delete(id);
    await loadKbKnowledgeBases({ silent: true });
  }
}

/**
 * 删除知识库。
 *
 * 界面上其他按钮（改名 / 公开 / 启用）都是可逆的，只有这一个不可撤销，
 * 所以必须二次确认，并且**把"哪些会没、哪些会留"逐条说清**：
 * 只说「确定删除吗」会让用户以为训练成果一起没了，实际批次和原文都还在。
 */
async function deleteKbKnowledgeBase(id: string) {
  const item = kbKnowledgeState.items.find((kb) => kb.id === id);
  if (!item || !item.isOwner || kbKnowledgeState.pending.has(id)) return;
  const ok = await confirmAction({
    title: "删除知识库",
    message: `「${item.name}」会从列表里删除，库里的语料不再参与出稿。`,
    detail: item.name,
    detailLabel: "要删除的知识库",
    consequences: [
      `${item.entryCount} 条已发布语料会从 WhatsApp 训练库下线（保留留痕，可重新发布到别的库）`,
      "训练批次、候选和原文都保留，只解除它们与这个库的归属",
      "删除后不可撤销"
    ],
    confirmLabel: "删除知识库"
  });
  if (!ok) return;
  kbKnowledgeState.pending.add(id);
  renderKbKnowledgePanel();
  const button = qs<HTMLButtonElement>(`#kbKnowledgeList [data-kb-kb-delete="${id}"]`);
  setButtonPending(button, true, "删除", "删除中…");
  try {
    const result = await api<{ archivedEntries: number; detachedRuns: number }>(
      `/api/kb/training/knowledge-bases/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    setKbKnowledgeNotice(
      `已删除「${item.name}」：${result.archivedEntries} 条语料已从训练库下线，${result.detachedRuns} 个训练批次解除归库（批次与原文保留）。`,
      true
    );
    toast("知识库已删除");
    // 详情弹窗正看着这个库 → 关掉，否则会停在空白列表上，看着像"库还在、只是空了"。
    if (kbEntriesState.kbId === id) {
      kbEntriesState.kbId = "";
      qs<HTMLElement>("#kbEntriesModal")?.classList.remove("active");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识库删除失败";
    setKbKnowledgeNotice(message, false);
    toast(message, "error");
  } finally {
    kbKnowledgeState.pending.delete(id);
    // 批次卡片上写着「归入哪个库」：不重读就会继续显示刚被删掉的那个名字。
    await loadKbTraining({ silent: true });
  }
}

function startKbKnowledgeRename(id: string) {
  const item = kbKnowledgeState.items.find((kb) => kb.id === id);
  if (!item || !item.isOwner) return;
  kbKnowledgeState.renameId = id;
  kbKnowledgeState.renameValue = item.name;
  renderKbKnowledgePanel();
  const input = qs<HTMLInputElement>("#kbKnowledgeList [data-kb-kb-name-input]");
  input?.focus();
  input?.select();
}

function cancelKbKnowledgeRename() {
  kbKnowledgeState.renameId = "";
  kbKnowledgeState.renameValue = "";
  renderKbKnowledgePanel();
}

async function confirmKbKnowledgeRename() {
  const id = kbKnowledgeState.renameId;
  if (!id) return;
  const item = kbKnowledgeState.items.find((kb) => kb.id === id);
  const name = kbKnowledgeState.renameValue.trim();
  if (!item) {
    cancelKbKnowledgeRename();
    return;
  }
  // 空名字/没改：不提交也不报错，直接退出编辑态 —— 名字为空会让列表没法认，静默改成默认名更糟。
  if (!name || name === item.name) {
    cancelKbKnowledgeRename();
    return;
  }
  kbKnowledgeState.pending.add(id);
  try {
    await api(`/api/kb/training/knowledge-bases/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
    toast("知识库已改名");
    setKbKnowledgeNotice(`已改名为「${name}」。`, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : "改名失败";
    setKbKnowledgeNotice(message, false);
    toast(message, "error");
  } finally {
    kbKnowledgeState.pending.delete(id);
    kbKnowledgeState.renameId = "";
    kbKnowledgeState.renameValue = "";
    await loadKbKnowledgeBases({ silent: true });
  }
}

/** 批次卡片上显示「这批归入哪个知识库」：发布前就知道东西会进哪个库，不是盲发。 */
function kbKnowledgeNameOf(kbId: string | undefined): string {
  const id = String(kbId ?? "");
  if (!id) return "";
  return kbKnowledgeState.items.find((item) => item.id === id)?.name || "已归入一个知识库";
}

/**
 * 屏 1 的「这批成果归入哪个知识库」下拉。
 *
 * 存在的理由：一次训练默认新建一个库，同一份资料反复提炼（第一次失败、补内容再提）
 * 会攒出一堆同名近似的库 —— 「选择默认知识库」那张清单就没法看了。
 *
 * 只列**自己的**库：往别人的库发语料后端会 403 拒掉，与其让用户点了再报错，不如压根不列。
 */
function renderKbTargetOptions() {
  const select = qs<HTMLSelectElement>("#kbTargetKnowledgeBase");
  if (!select) return;
  const current = select.value;
  const owned = kbKnowledgeSorted().filter((item) => item.isOwner);
  select.innerHTML = `<option value="">新建一个知识库（用资料标题命名）</option>` + owned.map((item) =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}（已发布 ${item.entryCount} 条）</option>`
  ).join("");
  // 保留用户当前的选择；只有那个库已经不在可选集合里（被删 / 不再属于自己）才退回"新建"。
  select.value = owned.some((item) => item.id === current) ? current : "";
}

function renderKbAssetOptions(assets: KnowledgeAsset[]) {
  const select = qs<HTMLSelectElement>("#kbSourceAsset");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">不关联</option>` + assets.map((asset) =>
    `<option value="${escapeHtml(asset.id)}">${escapeHtml(asset.title || asset.id)}</option>`
  ).join("");
  if (current) select.value = current;
}

function focusKbCandidate(index: number) {
  const rows = qsa<HTMLElement>("#kbCandidateList .kb-candidate");
  if (!rows.length) return;
  const next = Math.max(0, Math.min(rows.length - 1, index));
  kbTrainingState.focusIndex = next;
  rows.forEach((row, i) => row.classList.toggle("is-focused", i === next));
  rows[next]?.scrollIntoView({ block: "nearest" });
}

function toggleKbCandidate(id: string, force?: boolean) {
  kbTrainingState.touched.add(id);
  const next = force ?? !kbTrainingState.selected.has(id);
  if (next) kbTrainingState.selected.add(id);
  else kbTrainingState.selected.delete(id);
  syncKbCandidateSelection();
}

/**
 * 全选 / 取消全选**当前筛选下这一屏**的候选。
 *
 * 为什么是"这一屏"而不是"整批"：列表只装了前 `counts.total` 条里的一部分
 * （`candidateTotal` 可能远大于 `candidates.length`，见 `kbCandidateNoticeText`）。
 * 「全选整批」会勾上一堆页面上根本没渲染的条目，用户点完「发布到训练库」才发现
 * 发出去的东西自己没见过 —— 这种"看不见的选择"比多按几次按钮危险得多。
 *
 * 不复用 `toggleKbCandidate` 逐条调用：那会同步刷新 N 次（每次都要重扫整张列表），
 * 一次几百条时明显卡顿。这里一次性改完集合，最后只同步一次。
 *
 * 不重绘列表：只同步勾选框与行样式，正在编辑的输入框和光标不会被打断。
 */
function toggleKbVisibleSelection() {
  const rows = kbVisibleCandidates();
  if (!rows.length) return;
  const ids = rows.map((candidate) => candidate.id);
  const allPicked = ids.every((id) => kbTrainingState.selected.has(id));
  ids.forEach((id) => {
    kbTrainingState.touched.add(id);
    if (allPicked) kbTrainingState.selected.delete(id);
    else kbTrainingState.selected.add(id);
  });
  syncKbCandidateSelection();
}

function setKbSourceHint(text: string, warn = false) {
  const hint = qs<HTMLElement>("#kbSourceHint");
  if (!hint) return;
  hint.textContent = text;
  hint.classList.toggle("is-warn", warn);
}

export function stopKbTrainingPoll() {
  if (kbTrainingPollTimer) {
    clearTimeout(kbTrainingPollTimer);
    kbTrainingPollTimer = null;
  }
}

/** 只要还有 running 的批次就每 3 秒回来看一眼 —— 提炼是异步的，没有它界面永远停在「运行中」。 */
function scheduleKbTrainingPoll() {
  stopKbTrainingPoll();
  // 连续失败到上限、或正在行内编辑时都不再自动刷新：
  // 前者只会重复报同一个错，后者的重绘会打断正在打字的人（光标被吞掉）。
  if (kbTrainingState.pollStopped || kbTrainingState.editId) return;
  if (!kbTrainingState.runs.some((run) => run.status === "running")) return;
  kbTrainingPollTimer = setTimeout(() => {
    kbTrainingPollTimer = null;
    void loadKbTraining({ silent: true });
  }, 3000);
}

/** 自动刷新失败一次：够次数就停下来并把原因留给界面（禁止静默，也禁止刷屏）。 */
function kbNotePollFailure() {
  kbTrainingState.pollFailures += 1;
  if (kbTrainingState.pollFailures >= KB_POLL_FAILURE_LIMIT) kbTrainingState.pollStopped = true;
}

async function refreshKbRunDetail(options: { showToast?: boolean; silent?: boolean } = {}) {
  const runId = kbTrainingState.activeRunId;
  if (!runId) {
    kbTrainingState.counts = null;
    kbTrainingState.candidates = [];
    kbTrainingState.candidateTotal = 0;
    kbTrainingState.selected.clear();
    kbTrainingState.touched.clear();
    kbTrainingState.focusIndex = -1;
    kbTrainingState.editId = "";
    renderKbTraining();
    return;
  }
  try {
    const result = await api<{ run: KbTrainingRun; counts: Record<string, number>; candidates: KbTrainingCandidate[] }>(
      `/api/kb/training/runs/${encodeURIComponent(runId)}`
    );
    kbTrainingState.counts = result.counts || null;
    kbTrainingState.candidates = result.candidates || [];
    // counts.total 来自数据库计数，candidates 是「装进界面的那批」——
    // 两者不等就说明被 limit 截断了，界面必须说出来（静默截断是历史踩过的坑）。
    kbTrainingState.candidateTotal = Number(result.counts?.total ?? kbTrainingState.candidates.length);
    if (result.run) {
      const index = kbTrainingState.runs.findIndex((run) => run.id === result.run.id);
      if (index >= 0) kbTrainingState.runs[index] = result.run;
      else kbTrainingState.runs.unshift(result.run);
    }
    // 刷新不清掉用户的勾选：轮询每 3 秒来一次，清了就没法选了。
    const alive = new Set(kbTrainingState.candidates.map((candidate) => candidate.id));
    [...kbTrainingState.selected].forEach((id) => { if (!alive.has(id)) kbTrainingState.selected.delete(id); });
    kbTrainingState.candidates.forEach((candidate) => {
      if (candidate.preselect && candidate.status === "pending" && !kbTrainingState.touched.has(candidate.id)) {
        kbTrainingState.selected.add(candidate.id);
      }
    });
    // 正在编辑的那条若已不在本批（换批次 / 被别处处理），退出编辑态。
    if (kbTrainingState.editId && !alive.has(kbTrainingState.editId)) kbTrainingState.editId = "";
    kbTrainingState.pollFailures = 0;
    kbTrainingState.pollStopped = false;
    if (options.showToast) toast("候选已刷新");
  } catch (error) {
    const message = error instanceof Error ? error.message : "候选加载失败";
    if (options.silent) kbNotePollFailure();
    else toast(message, "error");
  } finally {
    renderKbTraining();
    renderKbRunList();
    scheduleKbTrainingPoll();
  }
}

export async function loadKbTraining(options: { silent?: boolean } = {}) {
  if (kbTrainingState.loading) {
    if (!options.silent) toast("正在加载，请稍候");
    return;
  }
  kbTrainingState.loading = true;
  if (!kbTrainingState.runs.length) renderKbRunList();
  try {
    const assetResult = await api<{ assets: KnowledgeAsset[] }>("/api/knowledge/assets")
      .catch(() => ({ assets: [] as KnowledgeAsset[] }));
    kbTrainingState.assets = assetResult.assets;
    renderKbAssetOptions(assetResult.assets);
    const runResult = await api<{ runs: KbTrainingRun[] }>("/api/kb/training/runs?limit=30");
    kbTrainingState.runs = runResult.runs || [];
    // 停止请求的标记要跟着状态走：批次已经不在 running，标记就该消失，
    // 否则下一批同名卡片会带着「正在停止…」的禁用按钮出现。
    kbTrainingState.cancelPending.forEach((id) => {
      const live = kbTrainingState.runs.find((run) => run.id === id);
      if (!live || live.status !== "running") kbTrainingState.cancelPending.delete(id);
    });
    if (!kbTrainingState.activeRunId || !kbTrainingState.runs.some((run) => run.id === kbTrainingState.activeRunId)) {
      // 默认落在**真正有待确认**的那一批：原来固定取最新一批，
      // 于是「昨天那批还有 8 条没确认，今天又提交了一批失败的」会看到空候选屏，
      // 用户以为候选丢了。没有待确认的批次才退回最新一批。
      const withPending = kbTrainingState.runs.find((run) => (run.pendingCount || 0) > 0);
      kbTrainingState.activeRunId = (withPending ?? kbTrainingState.runs[0])?.id || "";
      kbTrainingState.editId = "";
    }
    kbTrainingState.loaded = true;
    // 知识库是账号级资产，与批次一起刷新：批次卡片要显示"归入哪个库"，
    // 缺了它卡片只能显示一个 id。它的失败**不拖垮**整屏加载（自己内部消化并提示）。
    await loadKbKnowledgeBases({ silent: options.silent });
    await refreshKbRunDetail({ silent: options.silent });
    if (!options.silent) toast("知识库训练已刷新");
  } catch (error) {
    // 轮询路径失败不弹 toast（每 3 秒一次会把界面刷满），但也不能吞掉：计入失败次数，
    // 到上限就让批次列表顶上那条提示说明「自动刷新已停」。
    if (options.silent) kbNotePollFailure();
    else toast(error instanceof Error ? error.message : "知识库训练加载失败", "error");
  } finally {
    kbTrainingState.loading = false;
    renderKbRunList();
  }
}

/** 关联资料是「这一份资料的出处」：暂存多份时无法指向具体哪一份 —— 宁可禁用，也不猜。 */
function syncKbAssetSelect() {
  const select = qs<HTMLSelectElement>("#kbSourceAsset");
  if (!select) return;
  const ambiguous = kbTrainingState.staged.length > 1;
  if (ambiguous) select.value = "";
  select.disabled = ambiguous;
}

/** 暂存清单：本地读取的多份资料，提交时一起进 `sources.text.items`（后端上限 50 条）。 */
function renderKbStaged() {
  const host = qs<HTMLElement>("#kbStagedList");
  syncKbAssetSelect();
  if (!host) return;
  const staged = kbTrainingState.staged;
  host.hidden = !staged.length;
  if (!staged.length) {
    host.innerHTML = "";
    return;
  }
  const chars = staged.reduce((sum, item) => sum + item.body.length, 0);
  host.innerHTML = `<div class="kb-staged-item"><b>已暂存 ${staged.length} 份</b><span>共 ${chars.toLocaleString()} 字符</span><button type="button" data-kb-staged="clear">全部移除</button></div>`
    + staged.map((item, index) => `<div class="kb-staged-item"><b>${escapeHtml(item.title)}</b><span>${item.body.length.toLocaleString()} 字符</span><button type="button" data-kb-staged="${index}">移除</button><input data-kb-staged-note="${index}" maxlength="200" placeholder="来源描述（选填）：这份资料从哪来 / 谁给的口径" value="${escapeHtml(item.note)}"></div>`).join("");
}

async function startKbTrainingRun(button: HTMLButtonElement | null) {
  const titleInput = qs<HTMLInputElement>("#kbSourceTitle");
  const title = titleInput?.value.trim() || "";
  const body = qs<HTMLTextAreaElement>("#kbSourceBody")?.value ?? "";
  const assetId = qs<HTMLSelectElement>("#kbSourceAsset")?.value || "";
  // 主表单的「来源描述」：属于正文框/关联资料这一份；暂存的多份资料各自有自己的描述输入框。
  const mainNote = qs<HTMLInputElement>("#kbSourceNote")?.value.trim().slice(0, 200) || "";
  const staged = kbTrainingState.staged;
  // 暂存只有一份、正文框空着时，把「资料标题 / 关联资料 / 来源描述」应用到这唯一一份上
  // —— 否则本地读来的单份资料永远挂不上文件中心出处。
  const soloStaged = staged.length === 1 && !body.trim();
  // 出处 = 标题 或 关联资料，**有一个就够**（后端会用关联资料的标题兜底）。
  if (body.trim() && !title && !assetId) {
    setKbSourceHint("正文框里有内容，但这段正文没有出处：填个标题，或关联一条文件中心资料。", true);
    titleInput?.focus();
    return;
  }
  const items: Array<{ title: string; body: string; assetId?: string; note?: string }> = staged.map((item) => ({
    title: soloStaged && title ? title : item.title,
    body: item.body,
    assetId: soloStaged && assetId ? assetId : undefined,
    note: soloStaged && mainNote ? mainNote : item.note || undefined
  }));
  if (body.trim()) items.push({ title, body, assetId: assetId || undefined, note: mainNote || undefined });
  if (!items.length) {
    setKbSourceHint("先粘一段资料正文，或点上面的方框选一份 PDF / Word / txt / md 文件。", true);
    return;
  }
  if (!staged.length && body.trim().length < 20) {
    setKbSourceHint("正文太短，至少贴一段有内容的资料再开始（文件中心只存链接与说明，正文不在库里）。", true);
    qs<HTMLTextAreaElement>("#kbSourceBody")?.focus();
    return;
  }
  if (button?.disabled) return;
  if (button) setButtonPending(button, true, "开始训练", "提交中…");
  // 归入哪个库：空 = 新建（后端按资料标题命名）。选了已有库就把成果追加进去，
  // 避免同一份资料反复提炼攒出一堆同名近似的库。
  const targetKbId = qs<HTMLSelectElement>("#kbTargetKnowledgeBase")?.value || "";
  try {
    setKbSourceHint(`已提交 ${items.length} 份资料，正在提炼（每 20 段一次调用，长资料需要点时间）…`);
    const result = await api<{ run: KbTrainingRun; knowledgeBaseSync?: { ok: boolean; error?: string } }>("/api/kb/training/runs", {
      method: "POST",
      body: JSON.stringify({
        // 出处只走 `text.items[].assetId`：后端解析资产元数据时会把它并进同一张映射表，
        // 出处照样能回指。**刻意不发 `files.assetIds`** —— 那条路径会把资料自身的说明
        // 也当成一份语料喂进去（文件中心的说明常常只有几个字），凭空多出一段垃圾语料。
        sources: { text: { items } },
        ...(targetKbId ? { kbId: targetKbId } : {})
      })
    });
    if (result.run) {
      kbTrainingState.runs = [result.run, ...kbTrainingState.runs.filter((run) => run.id !== result.run.id)];
      // 提交后**切到这批**：用户刚点下「开始训练」，等的是它的进度；
      // 停在上一批会让人以为没提交成功（勾选与编辑态本来就随提交清空了，不存在半途打断）。
      kbTrainingState.activeRunId = result.run.id;
    }
    kbTrainingState.touched.clear();
    kbTrainingState.selected.clear();
    kbTrainingState.editId = "";
    kbTrainingState.staged = [];
    renderKbStaged();
    setKbSourceHint("批次已提交，已切到这一批：跑完候选项会自动出现。");
    toast("训练批次已提交");
    // 新建库时会**自动把库勾进创建者的清单**，那条清单一变就必须推给运行端；
    // 推失败时运行端仍按旧清单出稿 —— 只弹一个会消失的 toast 等于没说，所以走面板上的常驻提示。
    if (result.knowledgeBaseSync && !result.knowledgeBaseSync.ok) {
      setKbKnowledgeNotice(
        `知识库已建好，但启用清单没同步到 WhatsApp 插件（${result.knowledgeBaseSync.error}）：在插件恢复前，出稿仍按旧清单读语料。在下面勾选任意一个知识库可以重试同步。`,
        false
      );
    }
    // 新批次 = 新知识库（默认私用、且已给自己勾上），列表必须立刻反映出来，
    // 否则用户会以为这批成果"没有归到任何地方"。
    void loadKbKnowledgeBases({ silent: true });
    await refreshKbRunDetail();
    renderKbRunList();
    scheduleKbTrainingPoll();
  } catch (error) {
    const message = error instanceof Error ? error.message : "提交失败";
    setKbSourceHint(message, true);
    toast(message, "error");
  } finally {
    if (button) setButtonPending(button, false, "开始训练", "提交中…");
  }
}

/** 拖入 / 选择的文件按扩展名分两路：文本本地读，PDF / Word 交后端抽取。 */
function kbSourceFileKind(name: string): "text" | "extract" | "" {
  if (/\.(txt|md|markdown|csv|tsv|json)$/i.test(name)) return "text";
  if (/\.(pdf|docx)$/i.test(name)) return "extract";
  return "";
}

/**
 * PDF / Word 的正文只能由后端抽（浏览器读不了）。
 * 走同源 fetch 而不是 api()：这里要发原始字节，不能被 `content-type: application/json` 覆盖。
 */
async function kbExtractSourceFile(file: File): Promise<{ title: string; body: string; warnings: string[]; chars: number }> {
  const csrfToken = cookieValue("gj_csrf");
  const response = await fetch("/api/kb/training/extract", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
      "x-file-type": file.type || "application/octet-stream",
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
    },
    body: file
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: "抽取失败" }));
    throw new Error(body.message || "抽取失败");
  }
  return response.json() as Promise<{ title: string; body: string; warnings: string[]; chars: number }>;
}

/** 本地 txt / md 读取（可多选）：一次训练就能带上好几份资料，不必一份份点。 */
async function readKbLocalFiles(dropped?: File[]) {
  const input = qs<HTMLInputElement>("#kbSourceFile");
  const files = dropped ?? Array.from(input?.files ?? []);
  if (!files.length) return;
  const room = Math.max(0, 50 - kbTrainingState.staged.length);
  const accepted = files.slice(0, room);
  const clipped: string[] = [];
  const extractNotes: string[] = [];
  let added = 0;
  let unsupported = 0;
  for (const file of accepted) {
    const kind = kbSourceFileKind(file.name);
    if (!kind) { unsupported += 1; continue; }
    try {
      if (kind === "text") {
        const text = await file.text();
        const body = text.slice(0, 200_000);
        if (body.length < text.length) clipped.push(file.name);
        kbTrainingState.staged.push({
          title: file.name.replace(/\.[^.]+$/u, "").slice(0, 200) || file.name.slice(0, 200),
          body,
          note: ""
        });
      } else {
        // 扫描件要在后端逐页做本机 OCR（约 0.4 秒/页，第一次还要编译识别组件），
        // 提示里说清楚"可能要等"，否则用户会以为卡住又点一次。
        setKbSourceHint(`正在抽取《${file.name}》的正文…扫描件要逐页 OCR，可能需要十几秒到一分钟，请不要关闭页面`);
        const extracted = await kbExtractSourceFile(file);
        // 单份资料上限 20 万字符（与文本路径一致）：后端抽出来的是整本书，
        // 一次训练也跑不完，截断并如实说明比悄悄塞进 200 段更有用。
        const body = extracted.body.slice(0, 200_000);
        if (body.length < extracted.body.length) clipped.push(file.name);
        kbTrainingState.staged.push({ title: extracted.title.slice(0, 200), body, note: "" });
        if (extracted.warnings.length) extractNotes.push(`《${file.name}》${extracted.warnings.join("，")}`);
      }
      added += 1;
    } catch (error) {
      toast(`读取 ${file.name} 失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }
  // 拖拽进来的文件不经过 input，清空它的值没有意义；反过来点选后必须清，
  // 否则下一次选同一批文件不触发 change。
  if (!dropped && input) input.value = "";
  renderKbStaged();
  const skipped = files.length - accepted.length;
  const notes = [`已读入 ${added} 份`];
  if (clipped.length) notes.push(`${clipped.length} 份超过单份 20 万字符上限已截断`);
  if (skipped > 0) notes.push(`${skipped} 份超出单批 50 份上限未读入`);
  if (unsupported) notes.push(`${unsupported} 份格式不支持（只收 PDF / Word / txt / md / csv）`);
  notes.push(...extractNotes);
  notes.push(kbTrainingState.staged.length > 1
    ? "多份资料各自用文件名作出处；要给某一份挂文件中心资料，请单独训那一份"
    : "可用上方「关联文件中心资料」给这份资料挂出处");
  notes.push("确认无误后点「开始训练」");
  setKbSourceHint(notes.join("；"), clipped.length > 0 || skipped > 0 || unsupported > 0);
}

/** 进入行内编辑：编辑期间暂停自动刷新，否则重绘会打断正在打字的人。 */
function startKbEdit(id: string) {
  const candidate = kbTrainingState.candidates.find((item) => item.id === id);
  if (!candidate || candidate.status === "published") return;
  kbTrainingState.editId = id;
  kbTrainingState.editQuestion = candidate.question || "";
  kbTrainingState.editAnswer = candidate.answer;
  stopKbTrainingPoll();
  renderKbCandidateList();
  qs<HTMLTextAreaElement>('#kbCandidateList textarea[data-kb-edit="answer"]')?.focus();
}

function cancelKbEdit() {
  kbTrainingState.editId = "";
  kbTrainingState.editQuestion = "";
  kbTrainingState.editAnswer = "";
  renderKbCandidateList();
  scheduleKbTrainingPoll();
}

/** 「保存并确认」：编辑与确认是同一个动作 —— 改了不确认等于没改，确认了不带新内容等于白改。 */
async function confirmKbEdit(id: string) {
  const answer = kbTrainingState.editAnswer.trim();
  if (!answer) {
    toast("答案不能为空：空答案进库只会污染提示词", "error");
    return;
  }
  await reviewKbCandidates("confirm", [id], [{ id, question: kbTrainingState.editQuestion.trim(), answer }]);
}

async function reviewKbCandidates(
  action: "confirm" | "drop",
  ids?: string[],
  edits?: Array<{ id: string; question?: string; answer?: string }>
) {
  const target = ids?.length ? ids : [...kbTrainingState.selected];
  if (!target.length) {
    toast("先勾选要处理的候选", "error");
    return;
  }
  try {
    // 后端单次上限 20 条。**分批提交**而不是 slice(0,20)：静默丢掉用户选中的后半截，
    // 界面却提示「已处理 N 条」，是最难发现的一类不诚实。
    const chunks: string[][] = [];
    for (let index = 0; index < target.length; index += 20) chunks.push(target.slice(index, index + 20));
    for (const chunk of chunks) {
      await api("/api/kb/training/candidates/review", {
        method: "POST",
        body: JSON.stringify({ ids: chunk, action, edits: edits?.length ? edits : undefined })
      });
    }
    // 「确认」保留勾选并把筛选切到「已确认」：主流程是「勾选 → 确认 → 发布」，
    // 确认后那几条会从「待确认」里消失，切过去才能看到它们仍勾着、直接发布。
    // 「丢弃」必须清掉勾选 —— 已丢弃的候选留在勾选里只会让发布做无效事。
    if (action === "drop") {
      target.forEach((id) => kbTrainingState.selected.delete(id));
    } else {
      const filter = qs<HTMLSelectElement>("#kbCandidateStatusFilter");
      if (filter) filter.value = "approved";
    }
    if (edits?.length) {
      kbTrainingState.editId = "";
      kbTrainingState.editQuestion = "";
      kbTrainingState.editAnswer = "";
    }
    toast(action === "confirm"
      ? (edits?.length ? `已保存修改并确认 ${target.length} 条，可直接发布` : `已确认 ${target.length} 条，可直接发布`)
      : `已丢弃 ${target.length} 条`);
    await refreshKbRunDetail();
  } catch (error) {
    toast(error instanceof Error ? error.message : "候选处理失败", "error");
  }
}

/**
 * 一键确认本批里「高置信 + 未确认」的候选。
 *
 * 为什么需要它：模型给出的 0.9 以上问答往往占大半，逐条点「确认」是纯体力活；
 * 而体力活会让人干脆跳过确认、直接发布 —— 闸门就废了。给人一条快路，
 * 前提是这一步仍然**只确认、不发布**（发布依旧要人再点一次）。
 */
async function confirmKbHighConfidence(button: HTMLButtonElement | null) {
  const target = kbTrainingState.candidates
    .filter((candidate) => candidate.status === "pending" && candidate.confidence >= 0.9)
    .map((candidate) => candidate.id);
  if (!target.length) {
    toast("本批没有置信度 ≥0.90 的待确认候选", "error");
    return;
  }
  if (button?.disabled) return;
  if (button) setButtonPending(button, true, "确认高置信", "确认中…");
  try {
    await reviewKbCandidates("confirm", target);
  } finally {
    if (button) setButtonPending(button, false, "确认高置信", "确认中…");
  }
}

async function publishKbCandidates(button: HTMLButtonElement | null, ids?: string[]) {
  const target = ids?.length ? ids : [...kbTrainingState.selected];
  if (!target.length) {
    toast("先勾选要发布的候选", "error");
    return;
  }
  // 待确认的不能发布：后端也会拒，但在这里拦住能说清「是哪几条、下一步做什么」，
  // 而不是让用户点完看到一条 400。
  const unconfirmed = kbTrainingState.candidates.filter(
    (candidate) => target.includes(candidate.id) && candidate.status === "pending"
  );
  if (unconfirmed.length) {
    toast(`有 ${unconfirmed.length} 条还没确认：先在「待确认」里点确认，再发布`, "error");
    return;
  }
  if (button?.disabled) return;
  if (button) setButtonPending(button, true, "发布到训练库", "发布中…");
  try {
    const total: KbPublishOutcome = { published: [], existing: [], failed: [] };
    for (let index = 0; index < target.length; index += 20) {
      const chunk = target.slice(index, index + 20);
      const result = await api<KbPublishOutcome>("/api/kb/training/candidates/publish", {
        method: "POST",
        body: JSON.stringify({ ids: chunk })
      });
      total.published.push(...(result.published || []));
      total.existing.push(...(result.existing || []));
      total.failed.push(...(result.failed || []));
    }
    const failed = total.failed || [];
    const ok = (total.published?.length || 0) + (total.existing?.length || 0);
    target.forEach((id) => kbTrainingState.selected.delete(id));
    if (failed.length) {
      toast(`发布 ${ok} 条，失败 ${failed.length} 条：${failed[0].reason}`, "error");
    } else {
      toast(`已发布 ${ok} 条到训练库（其中 ${total.existing?.length || 0} 条原本就在）`);
    }
    // 发布改变了知识库的「已发布条数」：不刷新的话列表上那个数字会一直停在旧值，
    // 用户会以为发了个寂寞。
    void loadKbKnowledgeBases({ silent: true });
    await refreshKbRunDetail();
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "发布到训练库", "发布中…");
  }
}

async function revokeKbCandidate(id: string) {
  try {
    await api(`/api/kb/training/candidates/${encodeURIComponent(id)}/revoke`, { method: "POST", body: JSON.stringify({}) });
    toast("已从训练库撤回（运行端归档留痕，不硬删）");
    kbTrainingState.selected.delete(id);
    await refreshKbRunDetail();
    // 知识库详情弹窗开着时同步刷新它：否则刚撤回的那条还挂在列表里。
    if (kbEntriesState.kbId) void loadKbKnowledgeEntries(kbEntriesState.kbId, { silent: true });
  } catch (error) {
    toast(error instanceof Error ? error.message : "撤回失败", "error");
  }
}

/**
 * 停止运行中的批次。取消是**请求**：后端在当前这批模型调用结束后才停，
 * 所以界面不能立刻把状态改成「已取消」—— 先切按钮文案，等轮询回报终态。
 */
async function cancelKbRun(id: string, button: HTMLButtonElement | null) {
  if (button?.disabled) return;
  if (button) setButtonPending(button, true, "停止这批", "正在停止…");
  kbTrainingState.cancelPending.add(id);
  try {
    await api(`/api/kb/training/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({}) });
    toast("已发出停止请求：当前这批处理完就停，已入池的候选保留");
    await refreshKbRunDetail();
    // 不在这里移除：批次此刻仍是 running，标记要留到状态真的变了（见 loadKbTraining）。
    renderKbRunList();
  } catch (error) {
    kbTrainingState.cancelPending.delete(id);
    toast(error instanceof Error ? error.message : "取消失败", "error");
    renderKbRunList();
  } finally {
    if (button) setButtonPending(button, false, "停止这批", "正在停止…");
  }
}

/**
 * 失败 / 取消之后把当时提交的资料填回左侧表单。
 *
 * 为什么不是「一键重跑」：同一份资料重跑会再花一次模型调用；先让人看见原文、
 * 顺手改掉那几段写得不清楚的地方，再点开始，才是这件事的真实用法。
 * 资料来源是批次里的 `sourcesJson` 快照 —— 提交时前后端都保留了正文，不必让用户重新选文件。
 */
function restoreKbRunSources(id: string) {
  const run = kbTrainingState.runs.find((item) => item.id === id);
  if (!run?.sourcesJson) {
    toast("这批没有留下资料快照，请重新选择文件", "error");
    return;
  }
  let items: Array<{ title?: string; body?: string; note?: string }> = [];
  try {
    const spec = JSON.parse(run.sourcesJson) as { text?: { items?: Array<{ title?: string; body?: string; note?: string }> } };
    items = spec?.text?.items ?? [];
  } catch {
    items = [];
  }
  const usable = items
    .map((item) => ({
      title: String(item.title || "未命名资料").slice(0, 200),
      body: String(item.body || ""),
      note: String(item.note || "").slice(0, 200)
    }))
    .filter((item) => item.body.trim());
  if (!usable.length) {
    toast("这批没有可回填的正文（可能是会话源或已被截断）", "error");
    return;
  }
  kbTrainingState.staged = usable;
  renderKbStaged();
  // 只有一份时把它填进主表单，用户能直接改标题/关联资料；多份则留在暂存清单里各自成条。
  if (usable.length === 1) {
    const titleInput = qs<HTMLInputElement>("#kbSourceTitle");
    if (titleInput) titleInput.value = usable[0].title;
  }
  qs<HTMLElement>("#kbUploadButton")?.scrollIntoView({ behavior: "smooth", block: "center" });
  setKbSourceHint(`已把 ${usable.length} 份资料填回上方（共 ${usable.reduce((sum, item) => sum + item.body.length, 0).toLocaleString()} 字符），确认无误后点「开始训练」`);
  toast("资料已填回，可直接重新训练");
}

// ---------------------------------------------------------------------------
// 知识库详情（点卡片进入）：已发布条目 + 单条撤回
// ---------------------------------------------------------------------------

const kbEntriesState = {
  kbId: "",
  name: "",
  entries: [] as KbTrainingCandidate[],
  query: "",
  loading: false
};

function kbEntriesRowHtml(entry: KbTrainingCandidate) {
  const source = entry.sourceRef
    ? [entry.sourceRef.title ? `《${entry.sourceRef.title}》` : "", entry.sourceRef.anchor || ""].filter(Boolean).join(" ")
    : "";
  return `<article class="kb-entry" data-kb-entry="${escapeHtml(entry.id)}">
    <div class="kb-entry-top">
      ${kbKindTag(entry)}
      <span class="kb-conf">置信 ${entry.confidence.toFixed(2)}</span>
      ${source ? `<span class="kb-entry-source">${escapeHtml(source)}</span>` : ""}
    </div>
    ${entry.question ? `<div class="kb-entry-q">${escapeHtml(entry.question)}</div>` : ""}
    <div class="kb-entry-a">${escapeHtml(entry.answer)}</div>
    <div class="kb-entry-foot">
      <span>${entry.reviewedAt ? `确认于 ${escapeHtml(formatTime(entry.reviewedAt))}` : "已发布"}</span>
      <button type="button" class="kb-entry-revoke" data-kb-entry-revoke="${escapeHtml(entry.id)}">从训练库撤回</button>
    </div>
  </article>`;
}

function renderKbEntriesModal() {
  const host = qs<HTMLElement>("#kbEntriesList");
  if (!host) return;
  const title = qs<HTMLElement>("#kbEntriesTitle");
  if (title) title.textContent = kbEntriesState.name || "知识库";
  const query = kbEntriesState.query.trim().toLowerCase();
  const items = query
    ? kbEntriesState.entries.filter((entry) => `${entry.question} ${entry.answer}`.toLowerCase().includes(query))
    : kbEntriesState.entries;
  const summary = qs<HTMLElement>("#kbEntriesSummary");
  if (summary) summary.textContent = kbEntriesState.loading
    ? "正在读取…"
    : query
      ? `匹配 ${items.length} / 共 ${kbEntriesState.entries.length} 条`
      : `共 ${kbEntriesState.entries.length} 条已发布语料`;
  if (kbEntriesState.loading) {
    host.innerHTML = `<div class="kb-empty">正在读取这个知识库的条目…</div>`;
    return;
  }
  host.innerHTML = items.length
    ? items.map(kbEntriesRowHtml).join("")
    : `<div class="kb-empty">${query ? "没有匹配的条目" : "这个库还没有已发布的条目：先训练、确认，再发布"}</div>`;
}

async function loadKbKnowledgeEntries(kbId: string, options: { silent?: boolean } = {}) {
  kbEntriesState.kbId = kbId;
  kbEntriesState.loading = true;
  renderKbEntriesModal();
  try {
    const result = await api<{ knowledgeBase: KbKnowledgeBaseView; entries: KbTrainingCandidate[] }>(
      `/api/kb/training/knowledge-bases/${encodeURIComponent(kbId)}/entries`
    );
    kbEntriesState.name = result.knowledgeBase?.name || "";
    kbEntriesState.entries = result.entries || [];
  } catch (error) {
    if (!options.silent) toast(error instanceof Error ? error.message : "知识库条目读取失败", "error");
  } finally {
    kbEntriesState.loading = false;
    renderKbEntriesModal();
  }
}

function openKbKnowledgeEntries(kbId: string) {
  const modal = qs<HTMLElement>("#kbEntriesModal");
  if (!modal) return;
  const item = kbKnowledgeState.items.find((entry) => entry.id === kbId);
  kbEntriesState.kbId = kbId;
  kbEntriesState.name = item?.name || "知识库";
  kbEntriesState.entries = [];
  kbEntriesState.query = "";
  const search = qs<HTMLInputElement>("#kbEntriesSearch");
  if (search) search.value = "";
  renderKbEntriesModal();
  modal.classList.add("active");
  void loadKbKnowledgeEntries(kbId);
}

async function runKbProbe(button: HTMLButtonElement | null) {
  const question = qs<HTMLInputElement>("#kbProbeInput")?.value.trim() || "";
  if (!question) {
    toast("先输入一句客户问法", "error");
    qs<HTMLInputElement>("#kbProbeInput")?.focus();
    return;
  }
  if (button?.disabled) return;
  if (button) setButtonPending(button, true, "试问", "检索中…");
  kbTrainingState.probeQuestion = question;
  try {
    kbTrainingState.probe = await api<KbProbeResult>("/api/kb/training/probe", {
      method: "POST",
      body: JSON.stringify({ body: question })
    });
  } catch (error) {
    kbTrainingState.probe = { message: error instanceof Error ? error.message : "试问失败" };
    toast(kbTrainingState.probe.message || "试问失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "试问", "检索中…");
    renderKbProbe();
  }
}

function kbTrainingKeyHandler(event: KeyboardEvent) {
  if (!qs<HTMLElement>("#kb-training")?.classList.contains("active")) return;
  // 试问弹窗开着时：Esc 收起，且 J/K 等候选快捷键不生效（焦点语义属于弹窗）。
  // 这条要放在「INPUT 早退」之前 —— 弹窗里焦点常在输入框上，早退后就轮不到这里了。
  const probeModal = qs<HTMLElement>("#kbProbeModal");
  if (probeModal?.classList.contains("active")) {
    if (event.key === "Escape") {
      event.preventDefault();
      probeModal.classList.remove("active");
    }
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
  if (event.key === "Escape" && kbTrainingState.editId) {
    event.preventDefault();
    cancelKbEdit();
    return;
  }
  const rows = kbVisibleCandidates();
  if (!rows.length) return;
  const key = event.key.toLowerCase();
  if (key === "j" || key === "k") {
    event.preventDefault();
    const base = kbTrainingState.focusIndex < 0 ? 0 : kbTrainingState.focusIndex + (key === "j" ? 1 : -1);
    focusKbCandidate(Math.max(0, Math.min(rows.length - 1, base)));
    return;
  }
  const focused = kbTrainingState.focusIndex >= 0 ? rows[kbTrainingState.focusIndex] : undefined;
  if (event.key === " ") {
    if (!focused) return;
    event.preventDefault();
    toggleKbCandidate(focused.id);
    return;
  }
  if (event.key === "Enter") {
    if (!focused) return;
    event.preventDefault();
    void reviewKbCandidates("confirm", [focused.id]);
    return;
  }
  if (key === "d") {
    if (!focused) return;
    event.preventDefault();
    void reviewKbCandidates("drop", [focused.id]);
    return;
  }
  if (key === "e") {
    if (!focused || focused.status === "published") return;
    event.preventDefault();
    startKbEdit(focused.id);
  }
}

export function bindKbTrainingEvents() {
  const refresh = qs<HTMLButtonElement>("#kbRefreshButton");
  if (refresh) refresh.onclick = async () => {
    if (refresh.disabled) return;
    setButtonPending(refresh, true, "刷新", "刷新中");
    try {
      await loadKbTraining();
    } finally {
      setButtonPending(refresh, false, "刷新", "刷新中");
    }
  };

  const start = qs<HTMLButtonElement>("#kbStartRunButton");
  if (start) start.onclick = () => void startKbTrainingRun(start);

  // 上传区（.kb-dropzone）就是文件入口：点击打开系统多选窗口、Enter/空格可达、
  // 拖拽整批导入 —— 三条路共用同一套读入管线（readKbLocalFiles）。
  const upload = qs<HTMLElement>("#kbUploadButton");
  const fileInput = qs<HTMLInputElement>("#kbSourceFile");
  if (upload) {
    upload.onclick = () => fileInput?.click();
    upload.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      fileInput?.click();
    };
    upload.ondragover = (event) => {
      event.preventDefault();
      upload.classList.add("is-drag");
    };
    upload.ondragleave = () => upload.classList.remove("is-drag");
    upload.ondrop = (event) => {
      event.preventDefault();
      upload.classList.remove("is-drag");
      const all = Array.from(event.dataTransfer?.files ?? []);
      if (!all.length) return;
      const ok = all.filter((item) => kbSourceFileKind(item.name) !== "");
      const skipped = all.length - ok.length;
      if (skipped > 0) toast(`${skipped} 个文件格式不支持，已跳过：拖入只收 PDF / Word / txt / md / csv`, "error");
      if (ok.length) void readKbLocalFiles(ok);
    };
  }
  if (fileInput) fileInput.onchange = () => void readKbLocalFiles();

  const stagedList = qs<HTMLElement>("#kbStagedList");
  // 来源描述只存草稿、**不重绘**：重绘会换掉 input 本身，打字的人光标就没了。
  if (stagedList) stagedList.oninput = (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input) return;
    const raw = input.dataset?.kbStagedNote;
    if (raw === undefined) return;
    const index = Number(raw);
    if (Number.isInteger(index) && index >= 0 && kbTrainingState.staged[index]) {
      kbTrainingState.staged[index].note = input.value.slice(0, 200);
    }
  };
  if (stagedList) stagedList.onclick = (event) => {
    const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-kb-staged]");
    const raw = trigger?.dataset?.kbStaged;
    if (raw === undefined) return;
    if (raw === "clear") kbTrainingState.staged = [];
    else {
      const index = Number(raw);
      if (Number.isInteger(index) && index >= 0) kbTrainingState.staged.splice(index, 1);
    }
    renderKbStaged();
    setKbSourceHint(kbTrainingState.staged.length ? `已暂存 ${kbTrainingState.staged.length} 份，点「开始训练」提交` : "");
  };

  const runList = qs<HTMLElement>("#kbRunList");
  if (runList) runList.onclick = (event) => {
    const target = event.target as HTMLElement | null;
    const card = target?.closest<HTMLElement>("[data-kb-run]");
    const id = card?.dataset.kbRun;
    // 卡片级动作先于「选中这批」处理：否则点「停止」会顺带切批次，用户看到的是另一批的进度。
    const cancel = target?.closest<HTMLButtonElement>("[data-kb-run-cancel]");
    if (cancel) {
      event.stopPropagation();
      void cancelKbRun(cancel.dataset.kbRunCancel || "", cancel);
      return;
    }
    const retry = target?.closest<HTMLButtonElement>("[data-kb-run-retry]");
    if (retry) {
      event.stopPropagation();
      if (id) restoreKbRunSources(retry.dataset.kbRunRetry || id);
      return;
    }
    if (!id || id === kbTrainingState.activeRunId) return;
    kbTrainingState.activeRunId = id;
    kbTrainingState.selected.clear();
    kbTrainingState.touched.clear();
    kbTrainingState.focusIndex = -1;
    kbTrainingState.editId = "";
    kbTrainingState.editQuestion = "";
    kbTrainingState.editAnswer = "";
    renderKbRunList();
    void refreshKbRunDetail();
  };

  // 知识库面板：勾选即启用（**没有保存按钮** —— 多一步就会有人勾完不点保存，
  // 然后以为启用了）、行内改名、公开/私用切换。
  // 用事件委托挂在容器上：面板每轮重绘都换掉 innerHTML，逐个 addEventListener 会随重绘一起丢。
  const knowledgeList = qs<HTMLElement>("#kbKnowledgeList");
  if (knowledgeList) {
    knowledgeList.onchange = (event) => {
      const input = event.target as HTMLInputElement | null;
      const id = input?.dataset?.kbKbEnable;
      if (id) void toggleKbKnowledgeEnabled(id, Boolean(input?.checked));
    };
    // 改名草稿只存内存、**不重绘**（与候选编辑框同理）：一重绘就把光标和正在打的字冲掉。
    knowledgeList.oninput = (event) => {
      const input = event.target as HTMLInputElement | null;
      if (input?.dataset?.kbKbNameInput === undefined) return;
      kbKnowledgeState.renameValue = input.value;
    };
    knowledgeList.onkeydown = (event) => {
      const input = event.target as HTMLInputElement | null;
      if (input?.dataset?.kbKbNameInput === undefined) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void confirmKbKnowledgeRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelKbKnowledgeRename();
      }
    };
    knowledgeList.onclick = (event) => {
      const target = event.target as HTMLElement | null;
      // 复选框自己会派发 change；这里再处理一次就是同一动作提交两遍（两次 PUT 互相覆盖）。
      if (target?.closest("input[data-kb-kb-enable]")) return;
      const rename = target?.closest<HTMLElement>("[data-kb-kb-rename]")?.dataset.kbKbRename;
      if (rename) {
        startKbKnowledgeRename(rename);
        return;
      }
      const visibility = target?.closest<HTMLElement>("[data-kb-kb-visibility]")?.dataset.kbKbVisibility;
      if (visibility) {
        void toggleKbKnowledgeVisibility(visibility);
        return;
      }
      const open = target?.closest<HTMLElement>("[data-kb-kb-open]")?.dataset.kbKbOpen;
      if (open) {
        openKbKnowledgeEntries(open);
        return;
      }
      const remove = target?.closest<HTMLElement>("[data-kb-kb-delete]")?.dataset.kbKbDelete;
      if (remove) {
        void deleteKbKnowledgeBase(remove);
        return;
      }
      if (target?.closest("[data-kb-kb-name-save]")) void confirmKbKnowledgeRename();
      else if (target?.closest("[data-kb-kb-name-cancel]")) cancelKbKnowledgeRename();
    };
  }

  // 顶部搜索框：只过滤卡片展示（含「归入哪个库」下拉不受影响 —— 提交口径不能被搜索框收窄）。
  const knowledgeSearch = qs<HTMLInputElement>("#kbKnowledgeSearch");
  if (knowledgeSearch) knowledgeSearch.oninput = () => {
    kbKnowledgeState.query = knowledgeSearch.value.slice(0, 200);
    renderKbKnowledgePanel();
  };

  ["#kbCandidateStatusFilter", "#kbCandidateKindFilter", "#kbCandidateConfidenceFilter", "#kbCandidateGapOnly"].forEach((selector) => {
    qs<HTMLElement>(selector)?.addEventListener("change", () => {
      kbTrainingState.focusIndex = -1;
      renderKbCandidateList();
    });
  });

  const list = qs<HTMLElement>("#kbCandidateList");
  if (list) {
    list.onchange = (event) => {
      const input = event.target as HTMLInputElement | null;
      const id = input?.dataset?.kbPick;
      if (id) toggleKbCandidate(id, Boolean(input?.checked));
    };
    // 编辑框只更新内存草稿、**不重绘**：一重绘就把光标和正在打的字冲掉。
    list.oninput = (event) => {
      const field = (event.target as HTMLTextAreaElement | null)?.dataset?.kbEdit;
      if (field === "question") kbTrainingState.editQuestion = (event.target as HTMLTextAreaElement).value;
      else if (field === "answer") kbTrainingState.editAnswer = (event.target as HTMLTextAreaElement).value;
    };
    list.onclick = (event) => {
      const target = event.target as HTMLElement | null;
      // 出处链到文件中心：候选的出处要能一键回到资料本身（否则「有出处」只是台账上的一句话）。
      const assetLink = target?.closest<HTMLElement>("[data-kb-asset]");
      if (assetLink) {
        event.preventDefault();
        event.stopPropagation();
        const assetId = assetLink.dataset.kbAsset || "";
        const asset = kbTrainingState.assets.find((item) => item.id === assetId);
        if (asset) void openKnowledgeAsset(asset);
        else toast("这条资料不在当前可见范围内（可能已删除或不属于你的团队）", "error");
        return;
      }
      const button = target?.closest<HTMLButtonElement>("button[data-kb-act]");
      if (button) {
        event.stopPropagation();
        const id = button.dataset.kbId || "";
        const action = button.dataset.kbAct || "";
        if (action === "confirm") void reviewKbCandidates("confirm", [id]);
        else if (action === "drop") void reviewKbCandidates("drop", [id]);
        else if (action === "revoke") void revokeKbCandidate(id);
        else if (action === "publish") void publishKbCandidates(button, [id]);
        else if (action === "edit-start") startKbEdit(id);
        else if (action === "edit-cancel") cancelKbEdit();
        else if (action === "edit-confirm") void confirmKbEdit(id);
        return;
      }
      const row = target?.closest<HTMLElement>("[data-kb-candidate]");
      if (row) focusKbCandidate(Number(row.dataset.kbIndex || 0));
    };
  }

  const selectVisibleButton = qs<HTMLButtonElement>("#kbSelectVisibleButton");
  if (selectVisibleButton) selectVisibleButton.onclick = () => toggleKbVisibleSelection();
  const reviewButton = qs<HTMLButtonElement>("#kbReviewSelectedButton");
  if (reviewButton) reviewButton.onclick = () => void reviewKbCandidates("confirm");
  const dropButton = qs<HTMLButtonElement>("#kbDropSelectedButton");
  if (dropButton) dropButton.onclick = () => void reviewKbCandidates("drop");
  const publishButton = qs<HTMLButtonElement>("#kbPublishButton");
  if (publishButton) publishButton.onclick = () => void publishKbCandidates(publishButton);
  const highConfidenceButton = qs<HTMLButtonElement>("#kbHighConfidenceButton");
  if (highConfidenceButton) highConfidenceButton.onclick = () => void confirmKbHighConfidence(highConfidenceButton);

  // 知识库详情弹窗：条目列表、搜索、单条撤回。与试问弹窗同一套 .modal-backdrop 语言。
  const entriesModal = qs<HTMLElement>("#kbEntriesModal");
  const entriesClose = qs<HTMLButtonElement>("#kbEntriesClose");
  if (entriesModal && entriesClose) entriesClose.onclick = () => entriesModal.classList.remove("active");
  if (entriesModal) entriesModal.onclick = (event) => {
    if (event.target === entriesModal) entriesModal.classList.remove("active");
  };
  const entriesSearch = qs<HTMLInputElement>("#kbEntriesSearch");
  if (entriesSearch) entriesSearch.oninput = () => {
    kbEntriesState.query = entriesSearch.value.slice(0, 120);
    renderKbEntriesModal();
  };
  const entriesList = qs<HTMLElement>("#kbEntriesList");
  if (entriesList) entriesList.onclick = (event) => {
    const id = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-kb-entry-revoke]")?.dataset.kbEntryRevoke;
    if (id) void revokeKbCandidate(id);
  };

  const probeInput = qs<HTMLInputElement>("#kbProbeInput");
  if (probeInput) probeInput.onkeydown = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void runKbProbe(qs<HTMLButtonElement>("#kbProbeButton"));
  };
  const probeButton = qs<HTMLButtonElement>("#kbProbeButton");
  if (probeButton) probeButton.onclick = () => void runKbProbe(probeButton);

  // 试问验证收进弹窗：入口在视图头部（「问一句试试」），打开即聚焦输入框，
  // 点遮罩或关闭键收起 —— 与全局其它弹窗同一套 .modal-backdrop.active 语言。
  const kbProbeModal = qs<HTMLElement>("#kbProbeModal");
  const kbProbeOpenButton = qs<HTMLButtonElement>("#kbProbeOpenButton");
  if (kbProbeModal && kbProbeOpenButton) kbProbeOpenButton.onclick = () => {
    kbProbeModal.classList.add("active");
    qs<HTMLInputElement>("#kbProbeInput")?.focus();
  };
  const kbProbeModalClose = qs<HTMLButtonElement>("#kbProbeModalClose");
  if (kbProbeModal && kbProbeModalClose) kbProbeModalClose.onclick = () => kbProbeModal.classList.remove("active");
  if (kbProbeModal) kbProbeModal.onclick = (event) => {
    if (event.target === kbProbeModal) kbProbeModal.classList.remove("active");
  };

  if (!kbTrainingKeysBound) {
    kbTrainingKeysBound = true;
    document.addEventListener("keydown", kbTrainingKeyHandler);
  }
}

export function examStatusText(status: string) {
  if (status === "published") return "发布";
  if (status === "draft") return "草稿";
  return "排期";
}

export function examStatusTone(status: string) {
  if (status === "published") return "green";
  if (status === "draft") return "amber";
  return "";
}

function examTargetText(targetRole?: string) {
  if (targetRole === "manager") return "主管必考";
  if (targetRole === "all") return "全员必考";
  return "销售必考";
}

export function difficultyTone(difficulty: string) {
  if (difficulty === "hard") return "red";
  if (difficulty === "easy") return "green";
  return "amber";
}

export function correctIndexesForQuestion(question: ExamQuestion) {
  return [...new Set(question.answerIndexes?.length ? question.answerIndexes : [question.answerIndex])].sort((left, right) => left - right);
}

export function questionTypeText(question: ExamQuestion) {
  return question.questionType === "multiple" || correctIndexesForQuestion(question).length > 1 ? "多选" : "单选";
}

export function formatExamDate(value?: string) {
  if (!value) return "长期有效";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "--";
}
