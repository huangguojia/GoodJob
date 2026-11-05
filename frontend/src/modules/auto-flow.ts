/**
 * 自动流：获客 → 背调 → 写信 → 发送 → 回复监控。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView } from "../prototype-api";
import { type AiEngineJobView, type LfindTaskResponse } from "./models";
import { escapeHtml, qs, qsa } from "./shared";
import { awaitAiEngineJob, effectiveResearchSource } from "./ai-engine-settings";
import { api, toast } from "./ui";

// ===========================================================================
// 自动流：把「获客 → 背调 → 定制开发信 → 发送 → 回复监控」串成一条真实可跑的流水线
//
// 边界（2026-11-03 起从「预演」升级为「真跑」）：
// - 获客：自然语言先走 /api/lead-finder/parse-goal（AI 解析），再提交 /api/lead-finder/lfind-tasks
//   —— 真实链路是本地 Runner 派给本机 CLI（Lfind Skill），轮询回填候选入池。
// - 背调：/api/ai-background-research（entityType=prospect），按团队设置走本机 CLI 或 AI，
//   202+jobId 后轮询 /api/ai-engine/jobs/:id 到终态。
// - 写信：/api/development-email/draft（entityType=prospect），引用背调结论。
// - 发送：必须人工确认。草稿备齐后节点暂停，详情区列出每封信的收件人/主题，
//   点「确认发送」才逐封调 /api/development-email/send；资格门禁（未审查/禁联）会被
//   后端拒绝并如实记账，不会绕过。
// - 回信监控：只读 /api/outbound-emails 与 /api/mail-center/messages 的真实台账。
// - 状态与产物写 localStorage（键 gj.autoflow.v2），刷新后能接着跑。
// ===========================================================================

type AutoFlowStatus = "idle" | "running" | "paused" | "done";
type AutoFlowLogKind = "start" | "done" | "warn";

interface AutoFlowStep {
  key: string;
  title: string;
  desc: string;
  input: string;
  output: string;
  prompt: string;
  tone: 1 | 2 | 3 | 4 | 5;
  seconds: number;
  icon: string;
  /** 进入本节点的放行条件，画在它左边那条连线上。 */
  gate?: string;
  /** 点「打开」跳转到的真实模块。 */
  view: string;
  viewLabel: string;
}

interface AutoFlowLogEntry {
  at: number;
  kind: AutoFlowLogKind;
  text: string;
}

interface AutoFlowState {
  status: Record<string, AutoFlowStatus>;
  progress: Record<string, number>;
  logs: AutoFlowLogEntry[];
  activeKey: string | null;
  /** 用自然语言描述的目标条件，作为这条流水线的输入。 */
  command: string;
  /** 本轮真实跑出来的产物（候选/草稿/发送台账），刷新后接着用。 */
  artifacts?: AutoFlowArtifacts;
  /**
   * 步进运行：每个节点完成后停下，自动展开这一步的运行结果，等用户点「继续运行」再跑下一步。
   * 「开始运行」/「以此开始」从头启动时关闭它（一次性跑完）。存进 localStorage，刷新后模式不丢。
   */
  stepMode?: boolean;
}

/** 一封待确认/已发送的开发信 */
interface AutoFlowDraftItem {
  prospectId: string;
  company: string;
  to: string;
  subject: string;
  body: string;
  engineNote: string;
}

interface AutoFlowArtifacts {
  /** parse-goal 的结构化解析结果 */
  parsed?: {
    name: string;
    products: string[];
    markets: string[];
    industries: string[];
    customerType: string;
    exclusions: string[];
  } | null;
  lfindTaskId?: string;
  /** 获客节点入池的候选（id/company/email 最小集） */
  opportunities: Array<{ id: string; company: string; email: string }>;
  /** 背调结论：prospectId -> 摘要（null = 该家背调失败但流程继续） */
  researched: Record<string, { score: number; verdict: string } | null>;
  /** 写信节点备好的草稿 */
  drafts: AutoFlowDraftItem[];
  /** 发送台账 */
  sent: Array<{ to: string; subject: string; ok: boolean; note: string }>;
  /** 发送节点是否已拿到人工确认 */
  sendConfirmed?: boolean;
}

const AUTO_FLOW_STORAGE_KEY = "gj.autoflow.v2";
const AUTO_FLOW_POLL_MS = 3_000;
const AUTO_FLOW_GAP_MS = 700;
const AUTO_FLOW_MAX_LOGS = 60;
/** 背调/写信每轮最多处理的候选数（控时长，其余留在清单里手动跑） */
const AUTO_FLOW_BATCH_LIMIT = 3;

const AUTO_FLOW_TONE_COLORS: Record<number, string> = {
  1: "#0e7490",
  2: "#5b21b6",
  3: "#be123c",
  4: "#b45309",
  5: "#15803d"
};

const AUTO_FLOW_TONE_SOFT: Record<number, string> = {
  1: "#e8f5f8",
  2: "#f2edfc",
  3: "#fdecef",
  4: "#fbf2dd",
  5: "#e8f6ee"
};

/** 详情区展示哪个节点；为空时自动跟随正在跑的节点。 */
let autoFlowFocusKey: string | null = null;
/** 用户手动点过节点才固定；否则详情区一直跟着正在跑的节点走。 */
let autoFlowFocusPinned = false;
/** 详情区当前渲染的是哪个节点（避免标题与状态串到不同节点）。 */
let autoFlowStageKey: string | null = null;

const AUTO_FLOW_STEPS: AutoFlowStep[] = [
  {
    key: "prospect",
    title: "获客",
    view: "lead-finder",
    viewLabel: "搜客",
    desc: "按产品与市场条件，从公开数据源找到有采购迹象的公司。",
    input: "产品 / 市场 / 数量",
    output: "候选企业 + 来源",
    tone: 1,
    seconds: 9,
    icon: '<path d="M21 21l-4.3-4.3"/><circle cx="11" cy="11" r="7"/>',
    prompt:
      "以「产品关键词 × 目标市场」为条件，调用已启用的免费源（GLEIF、Wikidata、EU TED、各国采购公告）与搜索源，产出 20–50 家候选企业。每条必须带来源 URL 与抓取时间；同一注册域名合并为一条；没有官网的标记「待补官网」，不进入下一节点。"
  },
  {
    key: "research",
    title: "背调",
    view: "prospect-list",
    viewLabel: "搜客清单",
    gate: "官网可达",
    desc: "核验主体、判断采购匹配度，攒够证据才允许写信。",
    input: "候选企业",
    output: "证据 ≥3 条 + ICP 分",
    tone: 2,
    seconds: 11,
    icon: '<path d="M12 3l7 3v5c0 4.6-2.8 8.2-7 10-4.2-1.8-7-5.4-7-10V6l7-3Z"/><path d="M9 12l2 2 4-4"/>',
    prompt:
      "对候选企业逐家做背景调查：核验官网与工商登记主体是否一致、主营产品是否匹配采购品类、抓取近 12 个月的采购/中标/招聘信号。输出不少于 3 条可引用证据 + ICP 匹配分（0–100）。证据不足 3 条的退回获客节点，不进入写信。"
  },
  {
    key: "compose",
    title: "定制开发信",
    view: "development-email",
    viewLabel: "开发信",
    gate: "证据 ≥3",
    desc: "用背调证据写一封只讲一件事的开发信。",
    input: "证据 + 产品卖点",
    output: "120 词英文开发信",
    tone: 3,
    seconds: 10,
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    prompt:
      "基于背调证据写一封 120 词以内的英文开发信：开头引用对方的具体业务事实（禁止「贵司业务广泛」这类空话），中段只讲一个与我方产品对应的能力点，结尾给一个低门槛问题。禁止编造认证、交期与客户案例；不确定的信息一律不写。"
  },
  {
    key: "send",
    title: "发送",
    view: "outreach-journey",
    viewLabel: "发信明细",
    gate: "参数冻结",
    desc: "冻结参数后按批次发送，退信立即停。",
    input: "信件 + 发件箱",
    output: "发件台账 + 时间线",
    tone: 4,
    seconds: 8,
    icon: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
    prompt:
      "按冻结批次参数发送：单域名每日上限、随机间隔、退信即停。发送前二次校验邮箱可投递性（MX + 语法 + 历史退信），发送后写入发件台账并回写客户时间线。命中黑名单或投诉记录的地址不发送。"
  },
  {
    key: "monitor",
    title: "回复监控",
    view: "mail-center",
    viewLabel: "邮件中心",
    gate: "台账落库",
    desc: "按意图给回信分类，把询价和索样变成待办。",
    input: "回信",
    output: "意图标签 + 待办",
    tone: 5,
    seconds: 9,
    icon: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7Z"/>',
    prompt:
      "持续监控回信并按意图分类：询价、索样、比价、拒绝、自动回复。询价与索样立即生成待办并提醒负责人；拒绝类写入流失原因；自动回复不计入有效回复。超过 7 天无回复的进入二次跟进队列，同一客户最多追加两封。"
  }
];

let autoFlowState: AutoFlowState | null = null;
let autoFlowAdvanceTimer: number | null = null;
let autoFlowBound = false;
let autoFlowRenderedLogCount = 0;
/** 协作式暂停标志：执行器在每个子步骤/每轮轮询之间检查 */
let autoFlowPauseRequested = false;
/** 发送节点正在等待人工确认 */
let autoFlowSendPending = false;
/** 执行令牌：重置/重入后让在途执行器全部作废 */
let autoFlowRunToken = 0;

function autoFlowFreshArtifacts(): AutoFlowArtifacts {
  return { opportunities: [], researched: {}, drafts: [], sent: [] };
}

function autoFlowInitialState(): AutoFlowState {
  return {
    status: Object.fromEntries(AUTO_FLOW_STEPS.map((step) => [step.key, "idle" as AutoFlowStatus])),
    progress: Object.fromEntries(AUTO_FLOW_STEPS.map((step) => [step.key, 0])),
    logs: [],
    activeKey: null,
    command: "",
    artifacts: autoFlowFreshArtifacts(),
    stepMode: false
  };
}

function autoFlowEnsure(): AutoFlowState {
  if (autoFlowState) return autoFlowState;
  let restored: AutoFlowState | null = null;
  try {
    const raw = localStorage.getItem(AUTO_FLOW_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AutoFlowState>;
      if (parsed && typeof parsed === "object" && parsed.status && parsed.progress) {
        const base = autoFlowInitialState();
        restored = {
          status: { ...base.status, ...parsed.status },
          progress: { ...base.progress, ...parsed.progress },
          logs: Array.isArray(parsed.logs) ? parsed.logs.slice(-AUTO_FLOW_MAX_LOGS) : [],
          activeKey: typeof parsed.activeKey === "string" ? parsed.activeKey : null,
          command: typeof parsed.command === "string" ? parsed.command : "",
          artifacts: { ...autoFlowFreshArtifacts(), ...(parsed.artifacts && typeof parsed.artifacts === "object" ? parsed.artifacts : {}) }
        };
      }
    }
  } catch {
    restored = null;
  }
  autoFlowState = restored ?? autoFlowInitialState();
  return autoFlowState;
}

function autoFlowWrite() {
  if (!autoFlowState) return;
  try {
    localStorage.setItem(AUTO_FLOW_STORAGE_KEY, JSON.stringify(autoFlowState));
  } catch {
    // 隐私模式/配额满：状态留在内存里，不影响本页推进
  }
}

function autoFlowLog(kind: AutoFlowLogKind, text: string) {
  const state = autoFlowEnsure();
  state.logs.push({ at: Date.now(), kind, text });
  if (state.logs.length > AUTO_FLOW_MAX_LOGS) state.logs = state.logs.slice(-AUTO_FLOW_MAX_LOGS);
}

function autoFlowStepOf(key: string | null) {
  return key ? AUTO_FLOW_STEPS.find((step) => step.key === key) : undefined;
}

function autoFlowNodeHtml(step: AutoFlowStep, index: number) {
  return `
    <article class="af-node" data-tone="${step.tone}" data-status="idle" data-step="${escapeHtml(step.key)}" data-focus="0">
      <div class="af-node-head">
        <span class="af-node-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${step.icon}</svg>
        </span>
        <span class="af-node-idx">${String(index + 1).padStart(2, "0")}</span>
        <h3>${escapeHtml(step.title)}</h3>
      </div>
      <p class="af-node-desc">${escapeHtml(step.desc)}</p>
      <div class="af-node-meta">
        <span class="af-node-line">
          <span class="af-chip"><i></i><b data-role="chip">待执行</b></span>
          <button class="af-res" type="button" data-res="${escapeHtml(step.key)}">结果 <b data-role="res-count">…</b><i></i></button>
        </span>
        <span class="af-node-out"><span>产出</span><b>${escapeHtml(step.output)}</b></span>
      </div>
      <span class="af-node-progress"><i data-role="bar"></i></span>
    </article>`;
}

function autoFlowLinkHtml(tone: number, gate?: string) {
  return `
    <div class="af-link" data-state="idle" style="--af-flow-color:${AUTO_FLOW_TONE_COLORS[tone] || AUTO_FLOW_TONE_COLORS[1]}">
      <span class="af-link-label">${escapeHtml(gate || "")}</span>
      <span class="af-link-line" aria-hidden="true"><i class="af-link-fill"></i><i class="af-link-pulse"></i></span>
    </div>`;
}

// ---------- 实时数据（只读，失败不影响页面推进） ----------
interface AutoFlowLiveMetrics {
  candidates: number;
  verified: number;
  emailed: number;
  contacted: number;
  replies: number;
  leads: number;
  updatedAt: number;
}

const AUTO_FLOW_LIVE_UNITS: Record<string, string> = {
  prospect: "家",
  research: "家",
  compose: "封",
  send: "家",
  monitor: "封"
};

let autoFlowLive: AutoFlowLiveMetrics | null = null;
let autoFlowLiveState: "loading" | "ready" | "error" = "loading";

function autoFlowLiveValueOf(key: string) {
  if (!autoFlowLive) return 0;
  if (key === "prospect") return autoFlowLive.candidates;
  if (key === "research") return autoFlowLive.verified;
  if (key === "compose") return autoFlowLive.emailed;
  if (key === "send") return autoFlowLive.contacted;
  return autoFlowLive.replies;
}

function autoFlowLiveTextOf(key: string) {
  if (autoFlowLiveState === "loading") return "…";
  if (!autoFlowLive || autoFlowLiveState === "error") return "—";
  const value = autoFlowLiveValueOf(key);
  if (key === "research") return `${value} / ${autoFlowLive.candidates} 家`;
  return `${value} ${AUTO_FLOW_LIVE_UNITS[key] || ""}`.trim();
}

function autoFlowSyncLive() {
  for (const step of AUTO_FLOW_STEPS) {
    const node = qs<HTMLElement>(`.af-node[data-step="${step.key}"] [data-role="live"]`);
    if (node) node.textContent = autoFlowLiveTextOf(step.key);
  }
}

async function loadAutoFlowLive() {
  const sync = qs<HTMLElement>("#afSyncText");
  autoFlowLiveState = "loading";
  if (sync) {
    sync.textContent = "读取实时数据…";
    sync.dataset.state = "loading";
  }
  autoFlowSyncLive();
  let next: AutoFlowLiveMetrics | null = null;
  try {
    const [performance, opportunities] = await Promise.allSettled([
      api<{ performance?: { metrics?: Record<string, unknown> } }>("/api/prospect-performance"),
      api<{ opportunities?: Array<{ lastDevelopmentEmailAt?: string; scorecard?: { icpMatch?: { score?: number } } }> }>(
        "/api/tools/website-opportunities"
      )
    ]);
    const metrics = performance.status === "fulfilled" ? performance.value.performance?.metrics || {} : {};
    const list = opportunities.status === "fulfilled" ? opportunities.value.opportunities || [] : [];
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    next = {
      candidates: count(metrics.candidates) || list.length,
      verified: list.filter((item) => Number(item.scorecard?.icpMatch?.score || 0) > 0).length,
      emailed: list.filter((item) => Boolean(item.lastDevelopmentEmailAt)).length,
      contacted: count(metrics.contacted),
      replies: count(metrics.validReplies),
      leads: count(metrics.leads),
      updatedAt: Date.now()
    };
  } catch {
    next = null;
  }
  autoFlowLive = next;
  autoFlowLiveState = next ? "ready" : "error";
  autoFlowSyncLive();
  autoFlowSyncResultCounts();
  void prefetchAutoFlowResults();
  if (sync) {
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5);
    sync.textContent = next ? `实时数据 · ${stamp} 更新` : "实时数据不可用";
    sync.dataset.state = next ? "ok" : "error";
  }
}

function autoFlowStageLabel(status: AutoFlowStatus, progress: number) {
  const value = `${Math.round(progress)}%`;
  if (status === "done") return "已完成";
  if (status === "running") return `进行中 ${value}`;
  if (status === "paused") return `已暂停 ${value}`;
  return "待执行";
}

function autoFlowFocusStep() {
  const state = autoFlowEnsure();
  const known = autoFlowFocusPinned ? AUTO_FLOW_STEPS.find((item) => item.key === autoFlowFocusKey) : undefined;
  if (known) return known;
  const running = AUTO_FLOW_STEPS.find((item) => state.status[item.key] === "running");
  if (running) return running;
  const paused = AUTO_FLOW_STEPS.find((item) => state.status[item.key] === "paused");
  if (paused) return paused;
  const next = AUTO_FLOW_STEPS.find((item) => state.status[item.key] !== "done");
  return next || AUTO_FLOW_STEPS[0];
}

function autoFlowRenderStage() {
  const box = qs<HTMLElement>("#afStage");
  if (!box) return;
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const step = autoFlowFocusStep();
  autoFlowFocusKey = step.key;
  autoFlowStageKey = step.key;
  const status = state.status[step.key] || "idle";
  box.style.setProperty("--af-accent", AUTO_FLOW_TONE_COLORS[step.tone] || AUTO_FLOW_TONE_COLORS[1]);
  box.style.setProperty("--af-soft", AUTO_FLOW_TONE_SOFT[step.tone] || AUTO_FLOW_TONE_SOFT[1]);
  box.innerHTML = `
    <div class="af-stage-head">
      <h4 class="af-stage-title">${escapeHtml(step.title)}</h4>
      <span class="af-stage-tag" data-role="stage-tag">${autoFlowStageLabel(status, state.progress[step.key] || 0)}</span>
      <span class="af-stage-live">当前<b data-role="stage-live">${autoFlowLiveTextOf(step.key)}</b></span>
    </div>
    <p class="af-stage-desc">${escapeHtml(step.desc)}</p>
    <div class="af-stage-io">
      ${state.command ? `<span class="af-io-chip"><span>本次目标</span><b>${escapeHtml(state.command)}</b></span>` : ""}
      <span class="af-io-chip"><span>输入</span><b>${escapeHtml(step.input)}</b></span>
      <span class="af-io-arrow" aria-hidden="true">→</span>
      <span class="af-io-chip"><span>产出</span><b>${escapeHtml(step.output)}</b></span>
    </div>
    <div class="af-stage-prompt"><span>节点提示词</span><p>${escapeHtml(step.prompt)}</p></div>${
      step.key === "send" && autoFlowSendPending
        ? `<div class="af-send-confirm">
            <p class="af-send-confirm-title">发送前确认 · 共 ${artifacts.drafts.filter((draft) => draft.to).length} 封真实外发</p>
            <ul>${artifacts.drafts.filter((draft) => draft.to).map((draft) =>
              `<li><b>${escapeHtml(draft.company)}</b><span>${escapeHtml(draft.to)}</span><span>${escapeHtml(draft.subject)}</span></li>`).join("")}</ul>
            <p class="af-send-confirm-note">点「确认发送」后立即真实外发；未过资格门禁的地址会被后端拦下并记录。也可以先跳过，去搜客清单手动处理。</p>
            <div class="af-send-confirm-actions">
              <button class="btn primary" type="button" data-af-action="send-confirm">确认发送</button>
              <button class="btn" type="button" data-af-action="send-skip">跳过发送</button>
            </div>
          </div>`
        : ""
    }
    <button class="af-stage-open" type="button" data-open="${escapeHtml(step.view)}">打开 ${escapeHtml(step.viewLabel)} →</button>`;
  qsa<HTMLElement>("#afTrack .af-node").forEach((node) => {
    node.dataset.focus = node.dataset.step === step.key ? "1" : "0";
  });
}

/** 同一个节点：每帧只改文案；换了节点：整块重建（否则标题与状态会串） */
function autoFlowSyncStage() {
  const state = autoFlowEnsure();
  const desired = autoFlowFocusStep();
  if (desired.key !== autoFlowStageKey) {
    autoFlowRenderStage();
    return;
  }
  const tag = qs<HTMLElement>('#afStage [data-role="stage-tag"]');
  if (tag) tag.textContent = autoFlowStageLabel(state.status[desired.key] || "idle", state.progress[desired.key] || 0);
  const live = qs<HTMLElement>('#afStage [data-role="stage-live"]');
  if (live) live.textContent = autoFlowLiveTextOf(desired.key);
}

const AUTO_FLOW_RESULT_HEADERS: Record<string, [string, string, string]> = {
  prospect: ["公司", "国家 / 业务", "来源"],
  research: ["公司", "核验等级", "置信度"],
  compose: ["收件人", "主题", "生成时间"],
  send: ["收件人", "主题", "投递状态"],
  monitor: ["发件人", "主题", "时间"]
};

interface AutoFlowResultRow {
  c1: string;
  c2: string;
  c3: string;
  tag?: string;
  tone?: "ok" | "wait" | "warn";
}

interface AutoFlowResultPayload {
  total: number;
  rows: AutoFlowResultRow[];
}

let autoFlowResults: Record<string, AutoFlowResultPayload> = {};
let autoFlowResultKey: string | null = null;
/** 同一份数据只请求一次：获客与背调共用候选列表，写信与发送共用发信台账。 */
const autoFlowSources: Record<string, Promise<unknown>> = {};

function autoFlowSource<T>(name: string, path: string): Promise<T> {
  if (!autoFlowSources[name]) autoFlowSources[name] = api<T>(path);
  return autoFlowSources[name] as Promise<T>;
}

/** 进入页面后静默取一次，让卡片上的条数与展开看到的表完全一致。 */
async function prefetchAutoFlowResults() {
  await Promise.allSettled(AUTO_FLOW_STEPS.map((step) => loadAutoFlowResult(step.key)));
  autoFlowSyncResultCounts();
}

function autoFlowResultTimeOf(value: unknown) {
  const text = String(value || "").trim();
  const at = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(at) ? autoFlowShortTime(at) : "—";
}

async function loadAutoFlowResult(key: string): Promise<AutoFlowResultPayload> {
  const cached = autoFlowResults[key];
  if (cached) return cached;
  const clamp = (value: unknown, max = 26) => {
    const text = String(value || "").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text || "—";
  };
  let rows: AutoFlowResultRow[] = [];
  let total = 0;

  if (key === "prospect" || key === "research") {
    const data = await autoFlowSource<{ opportunities?: Array<Record<string, unknown>> }>("opportunities", "/api/tools/website-opportunities");
    const list = Array.isArray(data.opportunities) ? data.opportunities : [];
    total = list.length;
    rows = list.slice(0, 20).map((item) => {
      const report = (item.verificationReport || {}) as Record<string, unknown>;
      const scorecard = (item.scorecard || {}) as Record<string, unknown>;
      const confidence = (scorecard.enterpriseConfidence || {}) as Record<string, unknown>;
      return key === "prospect"
        ? {
            c1: clamp(item.company, 22),
            c2: clamp(`${String(item.country || "—")} · ${String(item.business || item.description || "").slice(0, 24)}`),
            c3: clamp(item.sourceLabel || item.source || "—", 12)
          }
        : {
            c1: clamp(item.company, 22),
            c2: clamp(report.levelLabel || report.level || "—", 16),
            c3: `${Number(confidence.score || 0)} 分`,
            tag: String(report.level || "").toUpperCase() === "L3" ? "已确认" : "待核验",
            tone: String(report.level || "").toUpperCase() === "L3" ? "ok" : "wait"
          };
    });
  } else if (key === "compose" || key === "send") {
    const data = await autoFlowSource<{ logs?: Array<Record<string, unknown>>; total?: number }>("outbound", "/api/outbound-emails?limit=20");
    const list = Array.isArray(data.logs) ? data.logs : [];
    total = Number(data.total || list.length);
    rows = list.slice(0, 20).map((log) => {
      const status = String(log.dispatchStatus || "—");
      const tone = status === "sent" ? "ok" : status === "bounced" || status === "failed" ? "warn" : "wait";
      const label = status === "sent" ? "已送达" : status === "bounced" ? "已退信" : status === "failed" ? "发送失败" : status;
      return key === "compose"
        ? { c1: clamp(log.to, 24), c2: clamp(log.subject, 46), c3: autoFlowResultTimeOf(log.sentAt || log.createdAt) }
        : {
            c1: clamp(log.to, 24),
            c2: clamp(log.subject, 46),
            c3: Number(log.openCount || 0) > 0 ? `已打开 ${log.openCount}` : autoFlowResultTimeOf(log.sentAt || log.createdAt),
            tag: label,
            tone
          };
    });
  } else {
    const data = await autoFlowSource<{ messages?: Array<Record<string, unknown>>; total?: number }>("mail", "/api/mail-center/messages?limit=20");
    const list = Array.isArray(data.messages) ? data.messages : [];
    const inbound = list.filter((item) => !item.direction || item.direction === "inbound");
    total = Number(data.total || inbound.length);
    rows = inbound.slice(0, 20).map((item) => ({
      c1: clamp(item.fromAddress || item.fromName || "—", 24),
      c2: clamp(item.subject, 46),
      c3: item.readAt ? "已读" : "未读",
      tag: item.readAt ? "已读" : "未读",
      tone: item.readAt ? "wait" : "ok"
    }));
  }

  autoFlowResults[key] = { total, rows };
  return autoFlowResults[key];
}

function autoFlowRenderResult(key: string, payload?: AutoFlowResultPayload, error?: string) {
  const box = qs<HTMLElement>("#afResult");
  if (!box) return;
  const step = autoFlowStepOf(key);
  if (!step) return;
  box.style.setProperty("--af-accent", AUTO_FLOW_TONE_COLORS[step.tone] || AUTO_FLOW_TONE_COLORS[1]);
  const head = AUTO_FLOW_RESULT_HEADERS[key] || ["", "", ""];
  const body = error
    ? `<div class="af-result-empty">${escapeHtml(error)}</div>`
    : !payload
      ? '<div class="af-result-empty">读取中…</div>'
      : payload.rows.length
        ? `<div class="af-tbl-wrap"><table class="af-tbl">
            <thead><tr><th>${escapeHtml(head[0])}</th><th>${escapeHtml(head[1])}</th><th>${escapeHtml(head[2])}</th></tr></thead>
            <tbody>${payload.rows
              .map(
                (row) =>
                  `<tr><td>${escapeHtml(row.c1)}</td><td>${escapeHtml(row.c2)}</td><td>${escapeHtml(row.c3)}${
                    row.tag ? ` <em class="${row.tone || "wait"}">${escapeHtml(row.tag)}</em>` : ""
                  }</td></tr>`
              )
              .join("")}</tbody>
          </table></div>`
        : '<div class="af-result-empty">这一节点还没有产出</div>';

  box.innerHTML = `
    <div class="af-result-h">
      <b>${escapeHtml(step.title)} · 本次产出 ${payload ? escapeHtml(String(payload.total)) : "—"} 条</b>
      <button class="link" type="button" data-open="${escapeHtml(step.view)}">去${escapeHtml(step.viewLabel)} →</button>
    </div>
    ${body}`;
  box.hidden = false;
}

async function autoFlowToggleResult(key: string) {
  const box = qs<HTMLElement>("#afResult");
  if (!box) return;
  qsa<HTMLElement>("#afTrack .af-node").forEach((node) => {
    node.dataset.resOpen = node.dataset.step === key && autoFlowResultKey !== key ? "1" : "0";
  });
  if (autoFlowResultKey === key) {
    autoFlowResultKey = null;
    box.hidden = true;
    return;
  }
  autoFlowResultKey = key;
  autoFlowRenderResult(key, autoFlowResults[key]);
  try {
    const payload = await loadAutoFlowResult(key);
    if (autoFlowResultKey !== key) return;
    autoFlowRenderResult(key, payload);
    const count = qs<HTMLElement>(`.af-node[data-step="${key}"] [data-role="res-count"]`);
    if (count) count.textContent = String(payload.total);
  } catch (err) {
    if (autoFlowResultKey !== key) return;
    autoFlowRenderResult(key, undefined, err instanceof Error ? err.message : "结果读取失败");
  }
}

function autoFlowSyncResultCounts() {
  for (const step of AUTO_FLOW_STEPS) {
    const node = qs<HTMLElement>(`.af-node[data-step="${step.key}"] [data-role="res-count"]`);
    if (!node) continue;
    const loaded = autoFlowResults[step.key];
    node.textContent = loaded ? String(loaded.total) : autoFlowLiveState === "ready" ? String(autoFlowLiveValueOf(step.key)) : "…";
  }
}

function autoFlowSync() {
  const state = autoFlowEnsure();
  let progressSum = 0;
  let doneCount = 0;

  for (const step of AUTO_FLOW_STEPS) {
    const status = state.status[step.key] || "idle";
    const progress = Math.max(0, Math.min(100, state.progress[step.key] || 0));
    progressSum += status === "done" ? 100 : progress;
    if (status === "done") doneCount += 1;

    const node = qs<HTMLElement>(`.af-node[data-step="${step.key}"]`);
    if (!node) continue;
    node.dataset.status = status;
    const chip = node.querySelector<HTMLElement>('[data-role="chip"]');
    if (chip) {
      chip.textContent = status === "done"
        ? "已完成"
        : status === "running"
          ? `进行中 ${Math.round(progress)}%`
          : status === "paused"
            ? `已暂停 ${Math.round(progress)}%`
            : "待执行";
    }
    node.style.setProperty("--af-progress", `${status === "done" ? 100 : Math.round(progress)}%`);
  }

  qsa<HTMLElement>("#afTrack .af-link").forEach((link, index) => {
    const left = state.status[AUTO_FLOW_STEPS[index]?.key || ""];
    const right = state.status[AUTO_FLOW_STEPS[index + 1]?.key || ""];
    const active = left === "running" || (left === "done" && right === "running");
    link.dataset.state = active ? "active" : left === "done" && right === "done" ? "done" : "idle";
  });

  const overall = Math.round(progressSum / AUTO_FLOW_STEPS.length);
  const overallText = qs<HTMLElement>("#afOverallText");
  if (overallText) overallText.textContent = `${overall}%`;
  const doneText = qs<HTMLElement>("#afDoneText");
  if (doneText) doneText.textContent = `${doneCount} / ${AUTO_FLOW_STEPS.length}`;
  const currentText = qs<HTMLElement>("#afCurrentText");
  if (currentText) {
    const active = autoFlowStepOf(state.activeKey);
    const pausedStep = AUTO_FLOW_STEPS.find((step) => state.status[step.key] === "paused");
    const lastDone = [...AUTO_FLOW_STEPS].reverse().find((step) => state.status[step.key] === "done");
    currentText.textContent = active
      ? `${active.title}${state.stepMode ? "（步进）" : ""}`
      : pausedStep
        ? `${pausedStep.title}（已暂停）`
        : doneCount === AUTO_FLOW_STEPS.length
          ? "全部完成"
          : state.stepMode && lastDone
            ? `${lastDone.title} 已完成 · 步进等待继续`
            : "未开始";
  }
  const fill = qs<HTMLElement>("#afProgressFill");
  if (fill) fill.style.width = `${overall}%`;
  qs<HTMLElement>("#afProgress")?.setAttribute("aria-valuenow", String(overall));

  const runButton = qs<HTMLButtonElement>("#afRunButton");
  if (runButton) {
    const running = Boolean(state.activeKey);
    const paused = AUTO_FLOW_STEPS.some((step) => state.status[step.key] === "paused");
    runButton.textContent = running
      ? "暂停"
      : paused || doneCount > 0 && doneCount < AUTO_FLOW_STEPS.length
        ? "继续运行"
        : doneCount === AUTO_FLOW_STEPS.length
          ? "重新运行"
          : "开始运行";
  }
  const stepButton = qs<HTMLButtonElement>("#afStepButton");
  if (stepButton) {
    const allDone = doneCount === AUTO_FLOW_STEPS.length;
    stepButton.textContent = state.stepMode && !allDone ? "一次跑完剩余" : "步进运行";
    stepButton.title = state.stepMode && !allDone
      ? "退出步进：剩余节点连续执行，不再逐步停下"
      : "每完成一个节点就停下，在下方查看这一步的运行结果，再点「继续运行」进入下一步";
    stepButton.classList.toggle("is-active", Boolean(state.stepMode) && !allDone);
  }

  autoFlowRenderLogs();
  autoFlowSyncStage();
}

function autoFlowShortTime(at: number) {
  const date = new Date(at);
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (date.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function autoFlowRenderLogs() {
  const list = qs<HTMLElement>("#afLogList");
  if (!list) return;
  const state = autoFlowEnsure();
  const count = qs<HTMLElement>("#afLogCount");
  if (count) count.textContent = `${state.logs.length} 条`;

  if (!state.logs.length) {
    list.innerHTML = '<li class="af-live-empty">还没有事件。点「开始运行」后，每个节点的开始与完成都会记在这里。</li>';
    autoFlowRenderedLogCount = 0;
    return;
  }
  const tagText: Record<AutoFlowLogKind, string> = { start: "开始", done: "完成", warn: "暂停" };
  const row = (entry: AutoFlowLogEntry) =>
    `<li><time>${autoFlowShortTime(entry.at)}</time><span class="af-live-tag" data-k="${entry.kind}">${tagText[entry.kind] || ""}</span><span>${escapeHtml(entry.text)}</span></li>`;
  const freshCount = state.logs.length - autoFlowRenderedLogCount;
  if (autoFlowRenderedLogCount === 0 || freshCount < 0 || freshCount > 5) {
    list.innerHTML = state.logs.slice().reverse().map(row).join("");
  } else if (freshCount > 0) {
    // 只把新事件插到最上面，旧行不动（滑入动画只属于新行）
    list.insertAdjacentHTML("afterbegin", state.logs.slice(-freshCount).reverse().map(row).join(""));
    while (list.children.length > 40) list.removeChild(list.lastElementChild as ChildNode);
  }
  autoFlowRenderedLogCount = state.logs.length;
}

// ---------- 系统动态：只读轮询，把三个模块的真实事件汇到右栏 ----------
type AutoFlowFeedKind = "prospect" | "send" | "reply";

interface AutoFlowFeedItem {
  at: number;
  kind: AutoFlowFeedKind;
  text: string;
}

const AUTO_FLOW_RUN_STATUS: Record<string, string> = {
  succeeded: "完成",
  failed: "失败",
  running: "进行中",
  queued: "排队",
  pending: "待执行",
  paused: "已暂停",
  cancelled: "已取消"
};

let autoFlowFeed: AutoFlowFeedItem[] = [];
let autoFlowFeedMaxAt = 0;
let autoFlowFeedTimer: number | null = null;

function autoFlowRenderFeed() {
  const list = qs<HTMLElement>("#afFeedList");
  if (!list) return;
  const tagText: Record<AutoFlowFeedKind, string> = { prospect: "获客", send: "发送", reply: "回信" };
  const row = (item: AutoFlowFeedItem) =>
    `<li><time>${autoFlowShortTime(item.at)}</time><span class="af-live-tag" data-k="${item.kind}">${tagText[item.kind]}</span><span>${escapeHtml(item.text)}</span></li>`;
  if (!autoFlowFeed.length) {
    list.innerHTML = '<li class="af-live-empty">暂无系统动态</li>';
    autoFlowFeedMaxAt = 0;
    return;
  }
  list.querySelector(".af-live-empty")?.remove();
  const newest = autoFlowFeed[0].at;
  const fresh = autoFlowFeed.filter((item) => item.at > autoFlowFeedMaxAt);
  if (autoFlowFeedMaxAt === 0 || newest < autoFlowFeedMaxAt) {
    list.innerHTML = autoFlowFeed.map(row).join("");
  } else if (fresh.length) {
    list.insertAdjacentHTML("afterbegin", fresh.map(row).join(""));
    while (list.children.length > 30) list.removeChild(list.lastElementChild as ChildNode);
  }
  autoFlowFeedMaxAt = Math.max(autoFlowFeedMaxAt, newest);
}

async function loadAutoFlowFeed() {
  const stamp = qs<HTMLElement>("#afFeedTime");
  const settled = await Promise.allSettled([
    api<{ runs?: Array<{ id?: string; status?: string; updatedAt?: string; createdAt?: string }> }>("/api/prospect-runs?limit=6"),
    api<{ logs?: Array<{ to?: string; subject?: string; sentAt?: string; createdAt?: string }> }>("/api/outbound-emails?limit=6"),
    api<{ messages?: Array<{ direction?: string; subject?: string; date?: string }> }>("/api/mail-center/messages?limit=8")
  ]);
  const parseTime = (value?: string) => {
    const at = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(at) ? at : 0;
  };
  const items: AutoFlowFeedItem[] = [];

  const runs = settled[0].status === "fulfilled" ? settled[0].value.runs || [] : [];
  for (const run of runs) {
    const at = parseTime(run.updatedAt || run.createdAt);
    if (!at) continue;
    const status = AUTO_FLOW_RUN_STATUS[run.status || ""] || run.status || "";
    items.push({ at, kind: "prospect", text: `搜客任务${status} · ${String(run.id || "").slice(-6)}` });
  }

  const outbound = settled[1].status === "fulfilled" ? settled[1].value.logs || [] : [];
  for (const log of outbound) {
    const at = parseTime(log.sentAt || log.createdAt);
    if (!at) continue;
    items.push({ at, kind: "send", text: `发给 ${log.to || "—"}${log.subject ? ` · ${log.subject}` : ""}` });
  }

  const messages = settled[2].status === "fulfilled" ? settled[2].value.messages || [] : [];
  for (const message of messages) {
    if (message.direction && message.direction !== "inbound") continue;
    const at = parseTime(message.date);
    if (!at) continue;
    items.push({ at, kind: "reply", text: message.subject || "（无主题）" });
  }

  autoFlowFeed = items.sort((a, b) => b.at - a.at).slice(0, 16);
  autoFlowRenderFeed();

  if (stamp) {
    const allFailed = settled.every((item) => item.status === "rejected");
    const now = new Date();
    stamp.textContent = allFailed
      ? "连接失败"
      : `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} 刷新`;
    stamp.dataset.state = allFailed ? "error" : "ok";
  }
}

function startAutoFlowFeed() {
  void loadAutoFlowFeed();
  if (autoFlowFeedTimer !== null) return;
  autoFlowFeedTimer = window.setInterval(() => void loadAutoFlowFeed(), 20_000);
}

export function stopAutoFlowFeed() {
  if (autoFlowFeedTimer === null) return;
  window.clearInterval(autoFlowFeedTimer);
  autoFlowFeedTimer = null;
}

function autoFlowStopTimers() {
  if (autoFlowAdvanceTimer !== null) {
    window.clearTimeout(autoFlowAdvanceTimer);
    autoFlowAdvanceTimer = null;
  }
}

function autoFlowSleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function autoFlowSetProgress(key: string, pct: number) {
  const state = autoFlowEnsure();
  state.progress[key] = Math.max(0, Math.min(100, Math.round(pct)));
  autoFlowWrite();
  autoFlowSync();
}

/** 协作式暂停检查点：落在子步骤之间，绝不把真实任务留在半途状态 */
function autoFlowPausePoint(key: string) {
  if (!autoFlowPauseRequested) return false;
  const state = autoFlowEnsure();
  const step = autoFlowStepOf(key);
  if (state.status[key] === "running") state.status[key] = "paused";
  if (step) autoFlowLog("warn", `${step.title} 已暂停，点「继续运行」从断点接着跑`);
  state.activeKey = null;
  autoFlowWrite();
  autoFlowSync();
  return true;
}

function autoFlowFailStep(key: string, message: string) {
  const state = autoFlowEnsure();
  const step = autoFlowStepOf(key);
  state.status[key] = "paused";
  if (state.activeKey === key) state.activeKey = null;
  if (step) autoFlowLog("warn", `${step.title} 失败：${message}（点「继续运行」重试）`);
  else autoFlowLog("warn", message);
  autoFlowWrite();
  autoFlowSync();
}

function autoFlowBeginStep(key: string, resume = false) {
  const state = autoFlowEnsure();
  const step = autoFlowStepOf(key);
  if (!step) return;
  if (!resume) autoFlowFocusPinned = false;
  autoFlowStopTimers();
  autoFlowPauseRequested = false;
  state.activeKey = key;
  state.status[key] = "running";
  if (!resume) state.progress[key] = 0;
  autoFlowLog("start", `${step.title} ${resume ? "继续" : "开始"}：${step.input} → ${step.output}`);
  autoFlowWrite();
  autoFlowSync();
  void autoFlowExecuteStep(step);
}

/** 页面加载时发现节点处于 running（刷新前在跑），恢复执行 */
function autoFlowResumeActive() {
  const state = autoFlowEnsure();
  const key = state.activeKey;
  if (!key || state.status[key] !== "running") return;
  const step = autoFlowStepOf(key);
  if (step) void autoFlowExecuteStep(step);
}

async function autoFlowExecuteStep(step: AutoFlowStep) {
  const token = ++autoFlowRunToken;
  try {
    if (step.key === "prospect") await autoFlowRunProspect(token);
    else if (step.key === "research") await autoFlowRunResearch(token);
    else if (step.key === "compose") await autoFlowRunCompose(token);
    else if (step.key === "send") await autoFlowRunSend(token);
    else if (step.key === "monitor") await autoFlowRunMonitor(token);
  } catch (error) {
    if (token !== autoFlowRunToken) return;
    autoFlowFailStep(step.key, error instanceof Error ? error.message : "执行失败");
  }
}

function autoFlowCompleteStep(key: string) {
  const state = autoFlowEnsure();
  const step = autoFlowStepOf(key);
  state.status[key] = "done";
  state.progress[key] = 100;
  if (state.activeKey === key) state.activeKey = null;
  autoFlowLog("done", `${step?.title || key} 完成：${step?.output || ""}`);
  autoFlowWrite();
  autoFlowSync();

  const next = AUTO_FLOW_STEPS.find((item) => state.status[item.key] !== "done");
  if (next && state.stepMode) {
    // 步进运行：停在这里，把这一步的产出展开给用户看，等「继续运行」
    autoFlowLog("warn", `步进运行：${step?.title || key} 已完成并停下，可在下方查看运行结果；点「继续运行」进入下一步「${next.title}」`);
    autoFlowWrite();
    autoFlowSync();
    void autoFlowShowResult(key);
    return;
  }
  if (next) {
    autoFlowAdvanceTimer = window.setTimeout(() => {
      autoFlowAdvanceTimer = null;
      autoFlowBeginStep(next.key);
    }, AUTO_FLOW_GAP_MS);
    return;
  }
  autoFlowLog("done", "整条流水线跑完：候选已入池、确认过的信已发出，回信进入持续监控");
  autoFlowWrite();
  autoFlowSync();
}

// ---------- 节点 1 · 获客：自然语言 → AI 解析 → Lfind 任务（本地 Runner → 本机 CLI） ----------
async function autoFlowRunProspect(token: number) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const goal = state.command.trim();
  if (!goal) throw new Error("先用一句话描述你要找的客户");
  autoFlowSetProgress("prospect", 4);

  if (!artifacts.lfindTaskId) {
    let parsed: AutoFlowArtifacts["parsed"];
    try {
      autoFlowLog("start", "AI 解析自然语言目标…");
      const data = await api<{ name?: string; markets?: string[]; products?: string[]; industries?: string[]; customerType?: string; exclusions?: string[] }>(
        "/api/lead-finder/parse-goal",
        { method: "POST", body: JSON.stringify({ goal }) }
      );
      if (token !== autoFlowRunToken) return;
      parsed = {
        name: String(data.name || "").slice(0, 120),
        products: (data.products || []).map((item) => String(item).trim()).filter(Boolean),
        markets: (data.markets || []).map((item) => String(item).trim()).filter(Boolean),
        industries: (data.industries || []).map((item) => String(item).trim()).filter(Boolean),
        customerType: String(data.customerType || "*"),
        exclusions: (data.exclusions || []).map((item) => String(item).trim()).filter(Boolean)
      };
      autoFlowLog("done", `解析结果：产品 ${parsed.products.join("、") || "—"} · 市场 ${parsed.markets.join("、") || "全球"}${parsed.name ? ` · 项目 ${parsed.name}` : ""}`);
    } catch (error) {
      if (token !== autoFlowRunToken) return;
      parsed = null;
      autoFlowLog("warn", `AI 解析失败（${error instanceof Error ? error.message : "未知错误"}），改用原句直接搜客`);
    }
    artifacts.parsed = parsed ?? null;
    autoFlowWrite();
    if (autoFlowPausePoint("prospect")) return;
    autoFlowSetProgress("prospect", 10);

    const products = parsed?.products.length ? parsed.products : [goal];
    const created = await api<{ task: { id: string }; message: string }>("/api/lead-finder/lfind-tasks", {
      method: "POST",
      body: JSON.stringify({
        goal: [
          goal,
          `Products: ${products.join(", ")}`,
          parsed?.markets.length ? `Markets: ${parsed.markets.join(", ")}` : "",
          parsed?.industries.length ? `Industries: ${parsed.industries.join(", ")}` : "",
          parsed && parsed.customerType && parsed.customerType !== "*" ? `Customer type: ${parsed.customerType}` : "",
          parsed?.exclusions.length ? `Exclusions: ${parsed.exclusions.join(", ")}` : ""
        ].filter(Boolean).join("; "),
        productKeywords: products.join(", "),
        countries: parsed?.markets.join(", ") || "",
        industry: parsed?.industries.join(", ") || "",
        customerType: parsed?.customerType || "*",
        excludeKeywords: parsed?.exclusions.join(", ") || "",
        limit: 12
      })
    });
    if (token !== autoFlowRunToken) return;
    artifacts.lfindTaskId = created.task.id;
    artifacts.opportunities = [];
    autoFlowWrite();
    autoFlowLog("done", `Lfind 任务 ${created.task.id} 已进本地 Runner 队列，由本机 CLI 执行`);
    autoFlowSetProgress("prospect", 14);
  }

  // 轮询任务到终态（刷新/重试后带着 lfindTaskId 直接回到这里）
  const taskId = artifacts.lfindTaskId!;
  let seenEvents = 0;
  for (;;) {
    if (token !== autoFlowRunToken) return;
    if (autoFlowPausePoint("prospect")) return;
    const response = await api<LfindTaskResponse>(`/api/lead-finder/lfind-tasks/${encodeURIComponent(taskId)}`);
    if (token !== autoFlowRunToken) return;
    const task = response.task;
    const events = response.events || [];
    for (; seenEvents < events.length; seenEvents += 1) {
      const message = events[seenEvents]?.message;
      if (message) autoFlowLog("start", message);
    }
    if (response.opportunities?.length) {
      artifacts.opportunities = response.opportunities.map((item) => ({
        id: item.id,
        company: item.company,
        email: item.emailEligibility?.recipient
          || item.extractedContacts?.find((contact) => contact.emails?.length)?.emails[0]
          || ""
      }));
    }
    autoFlowSetProgress("prospect", Math.min(92, 14 + events.length * 6));
    if (["succeeded", "failed", "cancelled"].includes(task.status)) {
      const skipped = (response.skipped || []).length;
      if (task.status !== "succeeded" || !artifacts.opportunities.length) {
        const reason = response.lfind?.summary?.noResultReason || task.errorMessage || `任务 ${task.status}`;
        // 终态任务不能复用：清掉任务号与候选，下一次「继续运行」会重新提交。
        // 否则瞬时故障（429 额度、超时）会把这个坏任务号永久钉在状态里，重试永远卡在同一处。
        artifacts.lfindTaskId = undefined;
        artifacts.opportunities = [];
        autoFlowWrite();
        throw new Error(`没有候选入池（原始 ${response.lfind?.summary?.rawFound ?? 0} 条）：${reason}`);
      }
      autoFlowSetProgress("prospect", 100);
      autoFlowLog("done", `候选入池 ${artifacts.opportunities.length} 家${skipped ? ` · 过滤掉 ${skipped} 条` : ""}（引擎：本机 CLI）`);
      autoFlowResults = {};
      autoFlowCompleteStep("prospect");
      return;
    }
    await autoFlowSleep(AUTO_FLOW_POLL_MS);
  }
}

// ---------- 节点 2 · 背调：引擎 CLI / AI，逐家出证据 ----------
async function autoFlowRunResearch(token: number) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const targets = artifacts.opportunities.slice(0, AUTO_FLOW_BATCH_LIMIT);
  if (!targets.length) throw new Error("上一节点没有候选，先跑获客");
  const source = effectiveResearchSource();
  autoFlowLog("start", `对前 ${targets.length} 家候选做背调（执行方式：${source === "cli" ? "本机 CLI" : source === "ai" ? "AI 模型" : "本地"}）`);
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    if (token !== autoFlowRunToken) return;
    if (autoFlowPausePoint("research")) return;
    if (artifacts.researched[target.id] !== undefined) continue;
    autoFlowSetProgress("research", Math.round((index / targets.length) * 100));
    autoFlowLog("start", `背调 ${target.company}…`);
    try {
      const first = await api<{
        research: { score: number; verdict: string; sources?: unknown[] } | null;
        pending?: boolean;
        engineJob?: AiEngineJobView;
        runnerName?: string;
        engine?: string;
      }>("/api/ai-background-research", {
        method: "POST",
        body: JSON.stringify({ entityType: "prospect", entityId: target.id, source })
      });
      if (token !== autoFlowRunToken) return;
      let research = first.research;
      if (!research && first.pending && first.engineJob) {
        autoFlowLog("start", `${target.company} 已派给 ${first.runnerName || "本机 Runner"}，CLI 调研中…`);
        const payload = await awaitAiEngineJob(first.engineJob);
        if (token !== autoFlowRunToken) return;
        research = (payload.research || null) as { score: number; verdict: string; sources?: unknown[] } | null;
      }
      if (research) {
        artifacts.researched[target.id] = { score: Number(research.score || 0), verdict: String(research.verdict || "") };
        autoFlowLog("done", `${target.company} 背调完成：评分 ${research.score} · ${research.verdict}${research.sources?.length ? ` · 证据 ${research.sources.length} 条` : ""}`);
      } else {
        artifacts.researched[target.id] = null;
        autoFlowLog("warn", `${target.company} 背调没有返回结果，先跳过（可去搜客清单单独重跑）`);
      }
    } catch (error) {
      if (token !== autoFlowRunToken) return;
      artifacts.researched[target.id] = null;
      autoFlowLog("warn", `${target.company} 背调失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
    autoFlowWrite();
    autoFlowSetProgress("research", Math.round(((index + 1) / targets.length) * 100));
  }
  const okCount = targets.filter((target) => artifacts.researched[target.id]).length;
  if (!okCount) throw new Error("本轮背调全部失败，请检查引擎配置后重试");
  autoFlowLog("done", `背调完成 ${okCount}/${targets.length} 家，够格进写信`);
  autoFlowResults = {};
  autoFlowCompleteStep("research");
}

// ---------- 节点 3 · 写信：引用背调结论逐家出草稿 ----------
async function autoFlowRunCompose(token: number) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const targets = artifacts.opportunities.filter((item) => artifacts.researched[item.id]).slice(0, AUTO_FLOW_BATCH_LIMIT);
  if (!targets.length) throw new Error("没有背调通过的候选，先跑背调节点");
  artifacts.drafts = artifacts.drafts.filter((draft) => targets.some((target) => target.id === draft.prospectId));
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    if (token !== autoFlowRunToken) return;
    if (autoFlowPausePoint("compose")) return;
    if (artifacts.drafts.some((draft) => draft.prospectId === target.id)) continue;
    autoFlowSetProgress("compose", Math.round((index / targets.length) * 100));
    autoFlowLog("start", `为 ${target.company} 撰写开发信…`);
    const result = await api<{
      draft: { subject: string; body: string } | null;
      pending?: boolean;
      engineJob?: AiEngineJobView;
      readiness?: { aiGenerated: boolean; aiError: string };
    }>("/api/development-email/draft", {
      method: "POST",
      body: JSON.stringify({ entityType: "prospect", entityId: target.id, scenario: "first_touch" })
    });
    if (token !== autoFlowRunToken) return;
    let draft = result.draft;
    let engineNote = result.readiness?.aiGenerated ? "AI 生成" : "模板";
    if (!draft && result.pending && result.engineJob) {
      autoFlowLog("start", `${target.company} 的信由本机 CLI 撰写中…`);
      const payload = await awaitAiEngineJob(result.engineJob);
      if (token !== autoFlowRunToken) return;
      draft = (payload.draft || null) as { subject: string; body: string } | null;
      engineNote = "本机 CLI";
    }
    if (!draft?.subject || !draft?.body) {
      autoFlowLog("warn", `${target.company} 没有拿到草稿，跳过`);
      continue;
    }
    artifacts.drafts.push({
      prospectId: target.id,
      company: target.company,
      to: target.email,
      subject: draft.subject,
      body: draft.body,
      engineNote
    });
    autoFlowWrite();
    if (!target.email) {
      autoFlowLog("warn", `${target.company} 暂无可用邮箱，草稿先备着，发送前需去搜客清单补联系方式`);
    }
    autoFlowLog("done", `${target.company} 草稿就绪（${engineNote}）：${draft.subject}`);
    autoFlowSetProgress("compose", Math.round(((index + 1) / targets.length) * 100));
  }
  if (!artifacts.drafts.length) throw new Error("一封草稿都没写成，请检查写信引擎配置");
  autoFlowLog("done", `${artifacts.drafts.length} 封草稿就绪，发送前需要人工确认`);
  autoFlowResults = {};
  autoFlowCompleteStep("compose");
}

// ---------- 节点 4 · 发送：人工确认后才真发，资格门禁如实记账 ----------
async function autoFlowRunSend(token: number) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const alreadySent = new Set(artifacts.sent.map((item) => `${item.to}|${item.subject}`));
  const drafts = artifacts.drafts.filter((draft) => draft.to && !alreadySent.has(`${draft.to}|${draft.subject}`));
  if (!artifacts.drafts.length) throw new Error("没有草稿可发送，先跑写信节点");
  if (!drafts.length) {
    autoFlowLog("warn", "草稿都缺收件邮箱，发送节点跳过；请去搜客清单补联系方式");
    autoFlowCompleteStep("send");
    return;
  }
  if (!artifacts.sendConfirmed) {
    autoFlowSendPending = true;
    state.status.send = "paused";
    if (state.activeKey === "send") state.activeKey = null;
    autoFlowLog("warn", `发送前需人工确认：共 ${drafts.length} 封。核对详情区列表后点「确认发送」`);
    autoFlowWrite();
    autoFlowSync();
    autoFlowRenderStage();
    return;
  }
  autoFlowSendPending = false;
  autoFlowLog("start", `已确认，逐封发送 ${drafts.length} 封…`);
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    if (token !== autoFlowRunToken) return;
    if (autoFlowPausePoint("send")) return;
    try {
      await api("/api/development-email/send", {
        method: "POST",
        body: JSON.stringify({
          entityType: "prospect",
          entityId: draft.prospectId,
          to: draft.to,
          subject: draft.subject,
          body: draft.body,
          requestId: `auto-flow:${crypto.randomUUID()}`
        })
      });
      artifacts.sent.push({ to: draft.to, subject: draft.subject, ok: true, note: "已进入发件台账" });
      autoFlowLog("done", `已发送：${draft.company} <${draft.to}> · ${draft.subject}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "发送失败";
      artifacts.sent.push({ to: draft.to, subject: draft.subject, ok: false, note: message });
      autoFlowLog("warn", `发送被拦下：${draft.company} · ${message}`);
    }
    autoFlowWrite();
    autoFlowSetProgress("send", Math.round(((index + 1) / drafts.length) * 100));
  }
  autoFlowResults = {};
  autoFlowCompleteStep("send");
}

/** 详情区「确认发送 / 跳过发送」 */
function autoFlowConfirmSend(confirmed: boolean) {
  const state = autoFlowEnsure();
  if (!autoFlowSendPending) return;
  autoFlowSendPending = false;
  if (!confirmed) {
    state.status.send = "done";
    state.progress.send = 100;
    autoFlowLog("warn", "已跳过发送：草稿留在产物里，可去搜客清单或邮件中心手动处理");
    autoFlowWrite();
    autoFlowSync();
    const next = AUTO_FLOW_STEPS.find((item) => state.status[item.key] !== "done");
    if (next) autoFlowBeginStep(next.key);
    return;
  }
  if (state.artifacts) state.artifacts.sendConfirmed = true;
  autoFlowWrite();
  autoFlowBeginStep("send", true);
}

// ---------- 节点 5 · 回复监控：只读真实台账，命中回信即时点名 ----------
async function autoFlowRunMonitor(token: number) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  autoFlowLog("start", "读取发件台账与收件箱…");
  const settled = await Promise.allSettled([
    api<{ logs?: Array<{ to?: string; subject?: string; dispatchStatus?: string; sentAt?: string }> }>("/api/outbound-emails?limit=20"),
    api<{ messages?: Array<{ direction?: string; fromAddress?: string; subject?: string; date?: string }> }>("/api/mail-center/messages?limit=20")
  ]);
  if (token !== autoFlowRunToken) return;
  if (autoFlowPausePoint("monitor")) return;
  const logs = settled[0].status === "fulfilled" ? settled[0].value.logs || [] : [];
  const messages = settled[1].status === "fulfilled" ? settled[1].value.messages || [] : [];
  const sentOk = artifacts.sent.filter((item) => item.ok);
  const normalize = (value: string) => value.trim().toLowerCase();
  const replies = messages
    .filter((message) => (message.direction || "inbound") === "inbound")
    .filter((message) => sentOk.some((item) => message.fromAddress && normalize(message.fromAddress).includes(normalize(item.to))));
  if (sentOk.length) {
    const bounced = logs.filter((log) => log.dispatchStatus === "bounced").length;
    autoFlowLog("done", `本轮已发出 ${sentOk.length} 封${bounced ? ` · 台账里有 ${bounced} 封退信` : ""}，可在「发信明细」核对`);
  }
  if (replies.length) {
    for (const reply of replies.slice(0, 3)) {
      autoFlowLog("done", `命中回信：${reply.fromAddress || "—"} · ${reply.subject || "（无主题）"}`);
    }
  } else {
    autoFlowLog("start", "暂无命中回信；新回信会实时进「邮件中心」，询价/索样会生成待办");
  }
  autoFlowSetProgress("monitor", 100);
  autoFlowResults = {};
  autoFlowCompleteStep("monitor");
}

/** 展开某一步的运行结果（已展开则只刷新），并把结果区滚到可见处 */
async function autoFlowShowResult(key: string) {
  if (autoFlowResultKey === key) autoFlowResultKey = null;
  await autoFlowToggleResult(key);
  qs<HTMLElement>("#afResult")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** 是否处在「还没开始 / 已全部跑完」：此时点开始类按钮算从头启动 */
function autoFlowAtStartLine(state: AutoFlowState) {
  if (state.activeKey) return false;
  const statuses = AUTO_FLOW_STEPS.map((item) => state.status[item.key]);
  return statuses.every((status) => status === "done") || statuses.every((status) => !status || status === "idle");
}

/** 「步进运行」按钮：未开启时开启并启动（或从当前位置继续）；已开启时改为一次跑完剩余 */
function autoFlowToggleStepMode() {
  const state = autoFlowEnsure();
  autoFlowSyncCommandFromDom(state);
  if (state.stepMode) {
    state.stepMode = false;
    autoFlowLog("start", "已切换为一次跑完：剩余节点会连续执行");
    autoFlowWrite();
    if (!state.activeKey) autoFlowStart();
    else autoFlowSync();
    return;
  }
  if (!state.command && autoFlowAtStartLine(state)) {
    toast("先用一句话描述你要找的客户，这条流水线才知道往哪儿搜", "error");
    qs<HTMLInputElement>("#afCommandInput")?.focus();
    return;
  }
  state.stepMode = true;
  autoFlowLog("start", state.activeKey
    ? "已切换为步进运行：当前节点完成后会停下"
    : "步进运行：每完成一个节点就停下，可在下方查看结果后再继续");
  autoFlowWrite();
  if (!state.activeKey) autoFlowStart();
  else autoFlowSync();
}

function autoFlowStart() {
  const state = autoFlowEnsure();
  // 启动前先以输入框为准兜底一次：重置/多标签页会让 localStorage 里的 command 与界面不一致，
  // 不兜底就会出现「输入框里明明有字，却报先用一句话描述」。
  autoFlowSyncCommandFromDom(state);
  if (state.activeKey) {
    autoFlowPause();
    return;
  }
  const paused = AUTO_FLOW_STEPS.find((item) => state.status[item.key] === "paused");
  if (paused) {
    autoFlowBeginStep(paused.key, true);
    return;
  }
  const next = AUTO_FLOW_STEPS.find((item) => state.status[item.key] !== "done");
  if (!next) {
    autoFlowReset(false);
    autoFlowBeginStep(AUTO_FLOW_STEPS[0]!.key);
    return;
  }
  autoFlowBeginStep(next.key);
}

function autoFlowPause() {
  autoFlowPauseRequested = true;
  const state = autoFlowEnsure();
  const step = autoFlowStepOf(state.activeKey);
  if (step) {
    autoFlowLog("start", `${step.title} 收到暂停请求，等当前动作落定后停在断点…`);
    autoFlowWrite();
    autoFlowSync();
  }
}

function autoFlowReset(withLog = true) {
  const previousCommand = autoFlowEnsure().command;
  const previousStepMode = Boolean(autoFlowEnsure().stepMode);
  autoFlowRunToken += 1;
  autoFlowStopTimers();
  autoFlowPauseRequested = false;
  autoFlowSendPending = false;
  autoFlowState = autoFlowInitialState();
  // 用户主动重置 → 目标一起清掉，输入框也清空，保证「界面所见 = 实际状态」；
  // 内部「全部跑完再来一轮」→ 保留原目标，否则重跑会立刻报缺少目标。
  if (!withLog) {
    autoFlowState.command = previousCommand;
    // 「全部跑完再来一轮」沿用原来的运行模式（步进 / 一次跑完）
    autoFlowState.stepMode = previousStepMode;
  }
  autoFlowRenderedLogCount = 0;
  if (withLog) {
    const input = qs<HTMLInputElement>("#afCommandInput");
    if (input) input.value = "";
    autoFlowLog("warn", "已重置，全部节点回到待执行");
  }
  autoFlowWrite();
  autoFlowSync();
}

/** 界面上输入框的值比状态新时（多标签页、重置时序），以输入框为准，避免「有字却报空目标」。 */
function autoFlowSyncCommandFromDom(state: AutoFlowState) {
  const input = qs<HTMLInputElement>("#afCommandInput");
  if (!input) return;
  const value = (input.value || "").trim();
  if (!value || value === state.command) return;
  state.command = value;
  autoFlowWrite();
}

function autoFlowRenderCommand() {
  const input = qs<HTMLInputElement>("#afCommandInput");
  if (!input) return;
  const state = autoFlowEnsure();
  if (document.activeElement === input) return;
  // 状态为空时不要清空输入框：用户可能刚打完字还没回写，或另一个标签页重置过。
  // 清空会让「界面有字、状态为空」这个 bug 更隐蔽，交给 autoFlowSyncCommandFromDom 在启动时回写。
  if (state.command) input.value = state.command;
}

export function renderAutoFlow() {
  const track = qs<HTMLElement>("#afTrack");
  if (!track) return;
  autoFlowEnsure();
  autoFlowRenderCommand();

  if (track.dataset.built !== "1") {
    track.innerHTML = AUTO_FLOW_STEPS
      .map((step, index) => `${index ? autoFlowLinkHtml(step.tone, step.gate) : ""}${autoFlowNodeHtml(step, index)}`)
      .join("");
    track.dataset.built = "1";
  }

  if (!autoFlowBound) {
    autoFlowBound = true;
    qs<HTMLButtonElement>("#afRunButton")?.addEventListener("click", () => {
      // 从头启动（还没开始 / 已全部跑完）= 一次性跑完；中途的「继续运行」保持当前模式
      const state = autoFlowEnsure();
      if (state.stepMode && autoFlowAtStartLine(state)) {
        state.stepMode = false;
        autoFlowWrite();
      }
      autoFlowStart();
    });
    qs<HTMLButtonElement>("#afStepButton")?.addEventListener("click", () => autoFlowToggleStepMode());
    qs<HTMLButtonElement>("#afResetButton")?.addEventListener("click", () => autoFlowReset());
    // 点节点 → 详情区切到这个节点（事件委托，只绑一次）
    track.addEventListener("click", (event) => {
      const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-res]");
      const resultKey = trigger?.dataset.res;
      if (resultKey) {
        event.stopPropagation();
        void autoFlowToggleResult(resultKey);
        return;
      }
      const node = (event.target as HTMLElement | null)?.closest<HTMLElement>(".af-node");
      const key = node?.dataset.step;
      if (!key) return;
      autoFlowFocusKey = key;
      autoFlowFocusPinned = true;
      autoFlowRenderStage();
    });
    // 自然语言条件：输入即记住，回车/按钮都能启动
    qs<HTMLInputElement>("#afCommandInput")?.addEventListener("input", (event) => {
      const state = autoFlowEnsure();
      state.command = (event.currentTarget as HTMLInputElement).value.trim();
      autoFlowWrite();
    });
    qs<HTMLInputElement>("#afCommandInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        qs<HTMLButtonElement>("#afCommandRun")?.click();
      }
    });
    qs<HTMLButtonElement>("#afCommandRun")?.addEventListener("click", () => {
      const state = autoFlowEnsure();
      const input = qs<HTMLInputElement>("#afCommandInput");
      state.command = (input?.value || "").trim();
      autoFlowWrite();
      if (!state.command) {
        toast("先用一句话描述你要找的客户，这条流水线才知道往哪儿搜", "error");
        input?.focus();
        return;
      }
      toast(`已按「${state.command.slice(0, 18)}${state.command.length > 18 ? "…" : ""}」启动流水线`);
      // 「以此开始」从头启动时一次性跑完；中途点它只是继续，保持当前模式
      if (autoFlowAtStartLine(state)) {
        state.stepMode = false;
        autoFlowWrite();
      }
      autoFlowStart();
      autoFlowRenderStage();
    });
    // 详情区里的「打开」直达真实模块
    qs<HTMLElement>("#afResult")?.addEventListener("click", (event) => {
      const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-open]");
      const target = trigger?.dataset.open || "";
      if (target) activateNavView(target);
    });
    qs<HTMLElement>("#afStage")?.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-open]");
      const view = target?.dataset.open || "";
      if (view) activateNavView(view);
      const action = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-af-action]");
      if (action) autoFlowConfirmSend(action.dataset.afAction === "send-confirm");
    });
  }

  autoFlowRenderStage();

  autoFlowSyncLive();
  autoFlowSyncResultCounts();
  if (!autoFlowLive) void loadAutoFlowLive();
  startAutoFlowFeed();

  autoFlowSync();

  const state = autoFlowEnsure();
  if (state.activeKey && state.status[state.activeKey] === "running") autoFlowResumeActive();
}
