/**
 * 自动流：获客 → 背调 → 写信 → 发送 → 数据监控。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, openModal, state as appState } from "../prototype-api";
import { type AiEngineJobView, type BackgroundResearch, type LfindTaskResponse } from "./models";
import { escapeHtml, qs, qsa } from "./shared";
import { awaitAiEngineJob, effectiveResearchSource } from "./ai-engine-settings";
import { api, toast } from "./ui";

// ===========================================================================
// 自动流：把「获客 → 背调 → 定制开发信 → 发送」串成一条真实可跑的流水线
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
// - 任务归档：跑完一轮存一条，打开/点击/回复按该批次台账实时统计。
// - 第 5 步「数据监控」（2026-11-19）：发完自动进入，先取一次基线，之后常驻刷新——
//   它不是「等回信」的阻塞节点，回信是几小时到几天后的事；节点标完成但显示「监控中」。
// - 状态与产物写 localStorage（键 gj.autoflow.v2），刷新后能接着跑。
// ===========================================================================

/**
 * failed 与 paused 必须分开：
 * - paused = 用户主动暂停 / 发送节点等人工确认，随时能原样接着跑；
 * - failed  = 这一步报错中止，没有在跑的任务，进度不保留。
 * 以前失败一律写成 paused，界面显示「已暂停 4%」，看起来像"跑到 4% 卡住了"，
 * 实际一个请求都没派出去（2026-11-09 用户报「在运行的没有啊」）。
 */
type AutoFlowStatus = "idle" | "running" | "paused" | "failed" | "done";
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
  /** 第 1 步每次要找多少家候选（10 / 20 / 30 / 50） */
  targetCount?: number;
  /**
   * 本轮开发信用哪个邮箱发：
   * - ""（缺省）= 账号主发件邮箱
   * - "rotate"  = 按 senderRotateEvery 封轮换使用发件邮箱池
   * - 其它       = 发件邮箱池里某个具体邮箱地址
   */
  senderEmail?: string;
  /** 轮换模式下每发多少封换下一个邮箱 */
  senderRotateEvery?: number;
  /** 最近一次本地状态变更时间戳（用于与云端快照对比合并） */
  updatedAt?: number;
  /**
   * 本轮任务 id：开跑时生成，跑完据此归档一条任务记录。
   * 归档接口按它幂等 —— 多标签页 / 重复渲染只会更新同一条，不会刷出一串重复任务。
   */
  runId?: string;
  /** 本轮开跑时间（归档用；重置后清空） */
  startedAt?: string;
  /** 已经归档过的 runId（同一轮只归档一次） */
  archivedAt?: string;
}

/** 获客节点入池的一家候选（展示与勾选用的最小信息） */
interface AutoFlowCandidate {
  id: string;
  company: string;
  email: string;
  country?: string;
  website?: string;
  business?: string;
  contact?: string;
  source?: string;
  /** 关键人：获客时 CLI 找到的 + 背调补充的（姓名、岗位、邮箱） */
  people?: AutoFlowPerson[];
}

interface AutoFlowPerson {
  name: string;
  title: string;
  email: string;
}

/** 一封待确认/已发送的开发信 */
interface AutoFlowDraftItem {
  prospectId: string;
  company: string;
  to: string;
  subject: string;
  body: string;
  engineNote: string;
  /** 业务员手动改过 */
  edited?: boolean;
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
  /**
   * 这个任务号已经因为「结果格式不对」失败过一次。
   *
   * 格式问题不是 CLI 没跑 —— 任务往往已经跑完并产出了几十家候选，只是某个字段不合契约。
   * 第一次失败保留任务号，修好解析后点「重试」可以直接复用这份结果（不重跑 CLI）；
   * 复用后仍失败才丢弃任务号重新派单，避免真的坏结果被永久钉住。
   */
  lfindParseRetry?: boolean;
  /** 获客节点入池的候选（id/company/email 最小集） */
  opportunities: AutoFlowCandidate[];
  /**
   * 第 1 步停下后用户勾选、要交给背调的候选 id。undefined = 没动过，默认全选。
   * 重新获客时清空。
   */
  selectedIds?: string[];
  /** 背调结论：prospectId -> 摘要（null = 该家背调失败但流程继续） */
  researched: Record<string, { score: number; verdict: string; summary?: string } | null>;
  /** 写信节点备好的草稿 */
  drafts: AutoFlowDraftItem[];
  /** 发送台账 */
  sent: Array<{ to: string; subject: string; ok: boolean; note: string }>;
  /** 发送节点是否已拿到人工确认 */
  sendConfirmed?: boolean;
  /** 本轮发出的信归档成的发信批次 id（打开/回复按 `batch:<id>:` 前缀统计） */
  batchId?: string;
  /**
   * 待归档的批次明细（含每封的 requestId）与预生成的批次号。
   * 归档接口一旦失败，这一批就会变成「发了信但统计不到」；留着它才能在监控节点重试，
   * 而且重试用的是同一个批次号，不会在归档里刷出第二条空批次。
   */
  pendingBatchId?: string;
  pendingBatchItems?: Array<{
    prospectId: string;
    company: string;
    to: string;
    subject: string;
    body: string;
    sentAt: string;
    requestId: string;
  }>;
  /** 业务员给写信 AI 的统一要求（第 3 步初稿与「重写全部」都用它） */
  composeGoal?: string;
}

const AUTO_FLOW_STORAGE_KEY = "gj.autoflow.v2";
const AUTO_FLOW_TARGET_OPTIONS = [10, 20, 30, 50];
const AUTO_FLOW_TARGET_DEFAULT = 30;
/** 轮换发件邮箱时「每 N 封换一个」的可选步长 */
const AUTO_FLOW_ROTATE_EVERY_OPTIONS = [10, 20, 30, 50];
const AUTO_FLOW_ROTATE_EVERY_DEFAULT = 10;
const AUTO_FLOW_POLL_MS = 3_000;
const AUTO_FLOW_GAP_MS = 700;
const AUTO_FLOW_MAX_LOGS = 60;

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
    title: "数据监控",
    // 打开的是任务归档页：那一批的每个收件人、打开次数、回复时间都在里面
    view: "auto-flow-history",
    viewLabel: "监控明细",
    gate: "已发信",
    desc: "按这一批的台账实时统计送达、打开、点击、回复、退信；有人回复就点名，退信率超标提醒先停发。",
    input: "发信批次",
    output: "打开率 / 回复率 + 待跟进名单",
    tone: 5,
    seconds: 4,
    icon: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
    prompt:
      "对已发出的这一批做持续监控：按批次台账统计送达 / 打开 / 点击 / 回复 / 退信，按时段对比变化。打开率低先怀疑主题行与送达，回复率低先怀疑开场是否具体。退信率超过 5% 立即停发并清洗地址；出现回复立刻转人工跟进，绝不自动回信。"
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
    stepMode: false,
    targetCount: AUTO_FLOW_TARGET_DEFAULT,
    senderEmail: "",
    senderRotateEvery: AUTO_FLOW_ROTATE_EVERY_DEFAULT
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
          artifacts: { ...autoFlowFreshArtifacts(), ...(parsed.artifacts && typeof parsed.artifacts === "object" ? parsed.artifacts : {}) },
          // 步进模式必须一起恢复：漏了它，刷新页面后「步进运行」按钮会变回未激活，
          // 但日志里还写着"步进运行：…已完成并停下"，界面自相矛盾。
          stepMode: Boolean(parsed.stepMode),
          targetCount: AUTO_FLOW_TARGET_OPTIONS.includes(Number(parsed.targetCount)) ? Number(parsed.targetCount) : AUTO_FLOW_TARGET_DEFAULT,
          senderEmail: typeof parsed.senderEmail === "string" ? parsed.senderEmail : "",
          senderRotateEvery: AUTO_FLOW_ROTATE_EVERY_OPTIONS.includes(Number(parsed.senderRotateEvery))
            ? Number(parsed.senderRotateEvery)
            : AUTO_FLOW_ROTATE_EVERY_DEFAULT,
          // 必须恢复时间戳：漏了它，刷新后本地状态等于「零时间」，会被服务器上更旧的
          // 快照反手覆盖，产物（背调/草稿）瞬间变成空的，界面却还标着已完成。
          updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : undefined,
          // 归档标识也要恢复：漏了它，刷新页面会把同一轮任务再归档一次
          runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
          startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
          archivedAt: typeof parsed.archivedAt === "string" ? parsed.archivedAt : undefined
        };
      }
    }
  } catch {
    restored = null;
  }
  autoFlowState = restored ?? autoFlowInitialState();
  autoFlowHealLegacyFailure(autoFlowState);
  autoFlowHealEmptyArtifacts(autoFlowState);
  autoFlowHealLegacyMonitor(autoFlowState);
  // 旧版本在发送失败时没清这个标志：恢复历史状态时一并兜底，否则重试会直接外发
  if (autoFlowState.status.send === "failed" && autoFlowState.artifacts) autoFlowState.artifacts.sendConfirmed = false;
  // 发送停在「等人工确认」时，autoFlowSendPending 只是内存标志：刷新页面后详情区的
  // 确认列表会整块消失，用户只剩「继续运行」可点，看起来像流程丢了。按持久化状态重建它。
  if (autoFlowState.status.send === "paused" && !autoFlowState.activeKey && !autoFlowState.artifacts?.sendConfirmed) {
    autoFlowSendPending = Boolean(autoFlowState.artifacts?.drafts.some((draft) => draft.to));
  }
  return autoFlowState;
}

/**
 * 自愈「状态标着完成、实际没有产出」的残留。
 *
 * 典型现场：第 2、3 步都显示已完成，但背调 0 家、草稿 0 封；一进第 4 步就报
 * 「没有草稿可发送」，点「重试第 4 步」还是同一句——因为上游被标成 done，
 * 重试永远不会回头跑它，用户被钉死在第 4 步。
 *
 * 这里把「完成但没有产出」的那一步起全部退回待执行，让「开始运行」从真正
 * 缺产出的地方接着跑。只在加载时做一次，不影响正常跑完的流程。
 */
function autoFlowHealEmptyArtifacts(state: AutoFlowState) {
  const artifacts = state.artifacts;
  if (!artifacts) return;
  const hasDrafts = artifacts.drafts.length > 0;
  const hasResearch = Object.values(artifacts.researched).some(Boolean);
  const hasCandidates = artifacts.opportunities.length > 0;
  const missing: string[] = [];
  if (state.status.compose === "done" && !hasDrafts) missing.push("compose");
  if (state.status.research === "done" && !hasResearch && !hasDrafts) missing.push("research");
  if (state.status.prospect === "done" && !hasCandidates) missing.push("prospect");
  if (!missing.length) return;
  const indexes = missing
    .map((key) => AUTO_FLOW_STEPS.findIndex((step) => step.key === key))
    .filter((index) => index >= 0);
  if (!indexes.length) return;
  const firstIndex = Math.min(...indexes);
  // 从第一个缺产出的步骤起，后面的产出也不可能可信，一并退回待执行
  for (const step of AUTO_FLOW_STEPS.slice(firstIndex)) {
    if (state.status[step.key] === "done" || state.status[step.key] === "failed") state.status[step.key] = "idle";
    state.progress[step.key] = 0;
  }
  state.activeKey = null;
  const step = AUTO_FLOW_STEPS[firstIndex]!;
  state.logs.push({
    at: Date.now(),
    kind: "warn",
    text: `第 ${firstIndex + 1} 步「${step.title}」之前标着完成，但这一步没有任何产出，已自动退回待执行；点「开始运行」会从「${step.title}」重新跑。`
  });
  autoFlowWrite();
}

/**
 * 旧版本（四步）跑完的任务：send 已是 done，但本地/云端快照里没有 monitor 这一步。
 * 不补的话，历史任务会突然显示「4 / 5 已完成、下一步数据监控待执行」，看起来像跑失败了。
 * 只补「已经归档过」的那一轮：正在跑的那一轮要留给用户点「继续运行」真跑一次基线。
 */
function autoFlowHealLegacyMonitor(state: AutoFlowState) {
  if (state.status.send !== "done") return;
  if (state.status.monitor === "done" || state.status.monitor === "running") return;
  if (!state.runId || state.archivedAt !== state.runId) return;
  state.status.monitor = "done";
  state.progress.monitor = 100;
}

/**
 * 自愈历史残留状态。
 *
 * 旧版本把「节点执行失败」记成 paused，同时保留任务号和假进度（典型是 4%），于是界面显示
 * 「已暂停 4%」——看起来像跑到 4% 卡住了，实际后端一条任务都没有。这里把这种残缺状态纠正成
 * failed，并丢弃那个查一次报一次的坏任务号。
 *
 * 只处理「最后一条 warn 是失败」的 paused 节点：用户主动暂停写的是
 * 「…已暂停，点「继续运行」从断点接着跑」，不会被误伤。
 */
function autoFlowHealLegacyFailure(state: AutoFlowState) {
  let changed = false;
  for (const step of AUTO_FLOW_STEPS) {
    if (state.status[step.key] !== "paused" || state.activeKey) continue;
    const lastWarn = [...state.logs].reverse().find((entry) => entry.kind === "warn");
    if (!lastWarn || !lastWarn.text.includes("失败")) continue;
    state.status[step.key] = "failed";
    state.progress[step.key] = 0;
    changed = true;
  }
  if (!changed) return;
  const artifacts = state.artifacts!;
  // 失败残留的任务号一律丢弃：它多半就是那个"查询一次报一次"的坏结果
  artifacts.lfindTaskId = undefined;
  artifacts.lfindParseRetry = undefined;
  artifacts.opportunities = [];
  state.logs.push({
    at: Date.now(),
    kind: "warn",
    text: "已清理上次失败留下的残留状态（原来显示「已暂停 N%」，实际没有任务在跑）。点「重试」会重新派单。"
  });
  autoFlowWrite();
}

let autoFlowWriteTimer: number | null = null;
let autoFlowRemoteSyncTimer: number | null = null;
let autoFlowLastRemoteSig = "";
let autoFlowRemotePulledUser = "";

function autoFlowCompactRemotePayload() {
  if (!autoFlowState) return null;
  const schedule = autoFlowReadSchedule();
  const artifacts = autoFlowState.artifacts;
  const compactState = {
    status: autoFlowState.status,
    progress: autoFlowState.progress,
    logs: autoFlowState.logs.slice(-20),
    activeKey: autoFlowState.activeKey,
    command: autoFlowState.command,
    stepMode: Boolean(autoFlowState.stepMode),
    targetCount: autoFlowState.targetCount,
    senderEmail: autoFlowState.senderEmail,
    senderRotateEvery: autoFlowState.senderRotateEvery,
    // 归档标识：换设备/多标签页拉回快照后不能再归档一次；批次号决定打开/回复能不能对上
    runId: autoFlowState.runId,
    startedAt: autoFlowState.startedAt,
    archivedAt: autoFlowState.archivedAt,
    updatedAt: autoFlowState.updatedAt || Date.now(),
    artifacts: artifacts ? {
      lfindTaskId: artifacts.lfindTaskId,
      lfindParseRetry: artifacts.lfindParseRetry,
      selectedIds: artifacts.selectedIds,
      sendConfirmed: artifacts.sendConfirmed,
      composeGoal: artifacts.composeGoal,
      batchId: artifacts.batchId,
      sent: artifacts.sent.slice(-50),
      // 背调结论只存评分与判定（摘要会撑爆快照体积）：不存的话，
      // 换台设备/开新标签页拉回快照就会出现「第 2 步已完成、其实一家都没背调」。
      researched: Object.fromEntries(
        Object.entries(artifacts.researched)
          .slice(0, 80)
          .map(([id, item]) => [id, item ? { score: item.score, verdict: item.verdict } : null])
      ),
      opportunities: artifacts.opportunities.slice(0, 60).map((item) => ({
        id: item.id,
        company: item.company,
        email: item.email,
        country: item.country,
        website: item.website,
        contact: item.contact
      }))
    } : undefined
  };
  return {
    updatedAt: compactState.updatedAt,
    state: compactState,
    schedule
  };
}

function autoFlowScheduleRemoteSync() {
  if (!appState.user) return;
  if (autoFlowRemoteSyncTimer !== null) window.clearTimeout(autoFlowRemoteSyncTimer);
  autoFlowRemoteSyncTimer = window.setTimeout(() => {
    autoFlowRemoteSyncTimer = null;
    if (!appState.user) return;
    const payload = autoFlowCompactRemotePayload();
    if (!payload) return;
    const sig = JSON.stringify({ state: payload.state, schedule: payload.schedule });
    if (sig === autoFlowLastRemoteSig) return;
    autoFlowLastRemoteSig = sig;
    void api("/api/auto-flow/state", {
      method: "PUT",
      body: JSON.stringify(payload)
    }).catch(() => undefined);
  }, 1_500);
}

async function autoFlowPullRemoteState() {
  const userId = appState.user?.id || "";
  if (!userId || autoFlowRemotePulledUser === userId) return;
  autoFlowRemotePulledUser = userId;
  try {
    const res = await api<{ data?: { updatedAt?: number; state?: Partial<AutoFlowState>; schedule?: Partial<AutoFlowSchedule> } | null }>("/api/auto-flow/state");
    const remote = res?.data;
    if (!remote || !remote.updatedAt) return;
    const local = autoFlowEnsure();
    if ((local.updatedAt || 0) >= remote.updatedAt) return;
    if (remote.state && typeof remote.state === "object" && !local.activeKey) {
      const base = autoFlowInitialState();
      const localArtifacts = local.artifacts || autoFlowFreshArtifacts();
      const remoteArtifacts = (remote.state.artifacts || {}) as Partial<AutoFlowArtifacts>;
      // 快照存不下草稿正文，背调结论也可能是旧版本没带的：远端为空时保留本地已有产出。
      // 直接覆盖会出现「状态是第 3 步完成、产物却是 0 封草稿」的自相矛盾状态。
      const mergedArtifacts: AutoFlowArtifacts = {
        ...autoFlowFreshArtifacts(),
        ...remoteArtifacts,
        opportunities: (remoteArtifacts.opportunities || []).length ? remoteArtifacts.opportunities! : localArtifacts.opportunities,
        researched: Object.keys(remoteArtifacts.researched || {}).length ? remoteArtifacts.researched! : localArtifacts.researched,
        drafts: (remoteArtifacts.drafts || []).length ? remoteArtifacts.drafts! : localArtifacts.drafts
      };
      autoFlowState = {
        ...base,
        ...remote.state,
        status: { ...base.status, ...(remote.state.status || {}) },
        progress: { ...base.progress, ...(remote.state.progress || {}) },
        artifacts: mergedArtifacts,
        updatedAt: remote.updatedAt
      };
      // 拉回来的完成状态如果和产物对不上（快照缺产物），就地退回待执行，别让用户卡在下一步
      autoFlowHealEmptyArtifacts(autoFlowState);
      autoFlowHealLegacyMonitor(autoFlowState);
      try { localStorage.setItem(AUTO_FLOW_STORAGE_KEY, JSON.stringify(autoFlowState)); } catch { /* ignore */ }
      autoFlowSync();
      autoFlowRenderStage();
    }
    if (remote.schedule && typeof remote.schedule === "object") {
      const prevSchedule = autoFlowReadSchedule();
      const mergedSchedule: AutoFlowSchedule = {
        ...prevSchedule,
        enabled: Boolean(remote.schedule.enabled),
        repeat: remote.schedule.repeat === "weekdays" || remote.schedule.repeat === "once" ? remote.schedule.repeat : prevSchedule.repeat,
        time: /^\d{2}:\d{2}$/.test(String(remote.schedule.time || "")) ? String(remote.schedule.time) : prevSchedule.time,
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(remote.schedule.date || "")) ? String(remote.schedule.date) : prevSchedule.date,
        lastSlot: Math.max(prevSchedule.lastSlot || 0, Number(remote.schedule.lastSlot) || 0)
      };
      autoFlowWriteSchedule(mergedSchedule);
      autoFlowRenderSchedule();
    }
  } catch {
    // 云端同步失败不阻断本地使用
  }
}

function autoFlowWriteNow() {
  if (autoFlowWriteTimer !== null) {
    window.clearTimeout(autoFlowWriteTimer);
    autoFlowWriteTimer = null;
  }
  if (!autoFlowState) return;
  autoFlowState.updatedAt = Date.now();
  try {
    localStorage.setItem(AUTO_FLOW_STORAGE_KEY, JSON.stringify(autoFlowState));
  } catch {
    // 隐私模式/配额满：状态留在内存里，不影响本页推进
  }
  autoFlowScheduleRemoteSync();
}

function autoFlowWrite() {
  if (!autoFlowState) return;
  autoFlowState.updatedAt = Date.now();
  if (autoFlowWriteTimer !== null) return;
  autoFlowWriteTimer = window.setTimeout(autoFlowWriteNow, 250);
}

function autoFlowLog(kind: AutoFlowLogKind, text: string) {
  const state = autoFlowEnsure();
  state.logs.push({ at: Date.now(), kind, text });
  if (state.logs.length > AUTO_FLOW_MAX_LOGS) state.logs = state.logs.slice(-AUTO_FLOW_MAX_LOGS);
}

function autoFlowStepOf(key: string | null) {
  return key ? AUTO_FLOW_STEPS.find((step) => step.key === key) : undefined;
}

const AUTO_FLOW_CHECK_ICON = '<path d="M5 12.5l4.2 4.2L19 7"/>';

/**
 * 节点 = 轨道上的一个站点 + 下方的说明卡。
 * 站点圆圈本身就是状态：空心=待执行，进度环=进行中，实心勾=已完成，琥珀虚线=步进停下等你继续，红=失败。
 */
function autoFlowNodeHtml(step: AutoFlowStep, index: number) {
  return `
    <article class="af-node" style="--i:${index}" data-status="idle" data-step="${escapeHtml(step.key)}" data-focus="0" data-wait="0" tabindex="0" aria-label="第 ${index + 1} 步 ${escapeHtml(step.title)}">
      <div class="af-station" aria-hidden="true">
        <span class="af-dot">
          <b class="af-dot-num">${index + 1}</b>
          <svg class="af-dot-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${AUTO_FLOW_CHECK_ICON}</svg>
          <i class="af-dot-ripple"></i>
        </span>
      </div>
      <div class="af-card">
        <div class="af-card-top">
          <span class="af-step-no">第 ${index + 1} 步</span>
          <span class="af-chip" data-role="chip">待执行</span>
        </div>
        <h3 class="af-card-title">${escapeHtml(step.title)}</h3>
        <p class="af-card-desc">${escapeHtml(step.desc)}</p>
        <dl class="af-card-io">
          ${step.gate ? `<div><dt>进入条件</dt><dd>${escapeHtml(step.gate)}</dd></div>` : `<div><dt>输入</dt><dd>${escapeHtml(step.input)}</dd></div>`}
          <div><dt>产出</dt><dd>${escapeHtml(step.output)}</dd></div>
        </dl>
        <p class="af-card-wait" data-role="wait" aria-live="polite" hidden></p>
        <div class="af-card-foot">
          <span class="af-bar" aria-hidden="true"><i data-role="bar"></i></span>
          <span class="af-foot-note" data-role="foot-note"></span>
          <button class="af-res" type="button" data-res="${escapeHtml(step.key)}">查看结果 <b data-role="res-count">…</b></button>
        </div>
      </div>
    </article>`;
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


let autoFlowLive: AutoFlowLiveMetrics | null = null;


/** 本轮运行每一步的数量：卡片「查看结果」上的数字与节点详情「本次」都用它 */
function autoFlowRunCount(key: string): { value: number; of: number } {
  const artifacts = autoFlowEnsure().artifacts!;
  if (key === "prospect") return { value: autoFlowSelectedCandidates().length, of: artifacts.opportunities.length };
  if (key === "research") {
    const targets = autoFlowSelectedCandidates();
    return { value: targets.filter((item) => artifacts.researched[item.id]).length, of: targets.length };
  }
  if (key === "compose") {
    const ready = artifacts.opportunities.filter((item) => artifacts.researched[item.id]).length;
    return { value: artifacts.drafts.length, of: ready };
  }
  if (key === "send") {
    return { value: artifacts.sent.filter((item) => item.ok).length, of: artifacts.drafts.filter((draft) => draft.to).length };
  }
  if (key === "monitor") {
    // 第 5 步的分母是「这一批真发出去几封」，分子是「其中被打开几封」——和下方指标卡同口径
    const snapshot = autoFlowMonitorData;
    const engagement = snapshot && snapshot.batchId === artifacts.batchId ? snapshot.engagement : null;
    return {
      value: engagement ? engagement.opened : 0,
      of: engagement ? engagement.sent : artifacts.sent.filter((item) => item.ok).length
    };
  }
  return { value: 0, of: 0 };
}

function autoFlowLiveTextOf(key: string) {
  const { value, of } = autoFlowRunCount(key);
  if (key === "prospect") return of ? (value === of ? `找到 ${of} 家` : `选中 ${value} / ${of} 家`) : "还没有候选";
  if (key === "research") return of ? `已背调 ${value} / ${of} 家` : "等第 1 步交来名单";
  if (key === "compose") return of ? `已写 ${value} / ${of} 封` : "等背调通过的公司";
  if (key === "monitor") {
    const engagement = autoFlowMonitorData?.engagement;
    if (!engagement || !of) return of ? `已发 ${of} 封，等监控数据` : "等这一批发出去";
    return `打开 ${engagement.opened} / ${of} 封${engagement.sent ? `（${engagement.openRate}%）` : ""} · 回复 ${engagement.replied}`;
  }
  return of ? `已发出 ${value} / ${of} 封` : "等写好的信";
}

function autoFlowSyncLive() {
  for (const step of AUTO_FLOW_STEPS) {
    const node = qs<HTMLElement>(`.af-node[data-step="${step.key}"] [data-role="live"]`);
    if (node) node.textContent = autoFlowLiveTextOf(step.key);
  }
}

async function loadAutoFlowLive() {
  const sync = qs<HTMLElement>("#afSyncText");
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
  // 0% 的「暂停」不是跑了一半：发送等人工确认、或刚停下还没产出，都停在 0。
  // 写成「已暂停 0%」会被读成"跑到这里卡住了"。
  if (status === "paused") return progress > 0 ? `已暂停 ${value}` : "已暂停";
  // 失败不写百分比：失败时进度没有意义，写出来会被读成"跑到这里卡住了"
  if (status === "failed") return "失败 · 未在运行";
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
  // 失败节点优先于"下一个待执行"：详情区要停在出事的那一步，而不是跳到后面
  const failed = AUTO_FLOW_STEPS.find((item) => state.status[item.key] === "failed");
  if (failed) return failed;
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
  // 第 5 步不是「跑一下」而是「一直盯着」：完成后标签写「监控中」，详情区换成实时读数
  const isMonitor = step.key === "monitor";
  const tagText = isMonitor && status === "done" ? "监控中" : autoFlowStageLabel(status, state.progress[step.key] || 0);
  box.innerHTML = `
    <div class="af-stage-head">
      <span class="af-stage-no">第 ${AUTO_FLOW_STEPS.indexOf(step) + 1} 步</span>
      <h4 class="af-stage-title">${escapeHtml(step.title)}</h4>
      <span class="af-stage-tag" data-role="stage-tag"${isMonitor && status === "done" ? ' data-watch="1"' : ""}>${tagText}</span>
    </div>
    <p class="af-stage-wait" data-role="stage-wait" hidden></p>
    <p class="af-stage-desc">${escapeHtml(step.desc)}</p>
    <div class="af-stage-io">
      ${state.command ? `<span class="af-io-chip"><span>本次目标</span><b>${escapeHtml(state.command)}</b></span>` : ""}
      <span class="af-io-chip"><span>输入</span><b>${escapeHtml(step.input)}</b></span>
      <span class="af-io-chip"><span>产出</span><b>${escapeHtml(step.output)}</b></span>
    </div>
    ${isMonitor
      ? `<section class="af-mon" data-role="mon-body" aria-label="这一批的打开与回复">${autoFlowMonitorBodyHtml()}</section>`
      : `<aside class="af-stage-run" aria-label="本次进度">
      <div class="af-stage-run-h"><span>本次进度</span><b data-role="stage-run-count"></b></div>
      <ul class="af-stage-run-rows" data-role="stage-run-rows"></ul>
    </aside>`}
    <details class="af-stage-prompt">
      <summary>这一步按什么要求执行</summary>
      <p>${escapeHtml(step.prompt)}</p>
    </details>${
      step.key === "send" && autoFlowSendPending
        ? `<div class="af-send-confirm">
            <p class="af-send-confirm-title">发送前确认：共 ${artifacts.drafts.filter((draft) => draft.to).length} 封真实外发</p>
            <ul>${artifacts.drafts.filter((draft) => draft.to).map((draft) =>
              `<li data-af-draft="${escapeHtml(draft.prospectId)}" tabindex="0" role="button" title="点开查看全文、修改"><b>${escapeHtml(draft.company)}</b><span>${escapeHtml(draft.to)}</span><span>${escapeHtml(draft.subject)}</span><i>查看 / 编辑</i></li>`).join("")}</ul>
            <div class="af-send-confirm-sender">
              <label><span>发信身份</span>
                <select data-af-sender-select aria-label="本轮开发信用哪个邮箱发出"></select>
              </label>
              <label class="af-sender-every" data-af-sender-every hidden><span>每</span>
                <select data-af-sender-every-select aria-label="每多少封换一个发件邮箱">
                  <option value="10">10</option><option value="20">20</option><option value="30">30</option><option value="50">50</option>
                </select><span>封换一个</span>
              </label>
            </div>
            <p class="af-send-confirm-note">点「确认发送」后立即真实外发；未过资格门禁的地址会被后端拦下并记录。也可以先跳过，去搜客清单手动处理。</p>
            <div class="af-send-confirm-actions">
              <button class="btn primary" type="button" data-af-action="send-confirm">确认发送</button>
              <button class="btn" type="button" data-af-action="send-skip">跳过发送</button>
            </div>
          </div>`
        : ""
    }
    <button class="af-stage-open" type="button" data-open="${escapeHtml(step.view)}">打开${escapeHtml(step.viewLabel)}</button>`;
  qsa<HTMLElement>("#afTrack .af-node").forEach((node) => {
    node.dataset.focus = node.dataset.step === step.key ? "1" : "0";
  });
  autoFlowRenderSenderControl();
  autoFlowRenderWait();
  autoFlowStageRunSig = "";
  autoFlowFillStageRun();
  if (isMonitor) {
    void loadAutoFlowMonitor().then(() => {
      if (autoFlowStageKey === "monitor") autoFlowSyncMonitorStage();
    });
  }
}

let autoFlowStageRunSig = "";
/** 节点详情右栏：这一步本轮逐条的状态（背调到第几家、哪封信写好了） */
function autoFlowFillStageRun() {
  const key = autoFlowStageKey;
  const rowsEl = qs<HTMLElement>('#afStage [data-role="stage-run-rows"]');
  const countEl = qs<HTMLElement>('#afStage [data-role="stage-run-count"]');
  if (!key || !rowsEl) return;
  const artifacts = autoFlowEnsure().artifacts!;
  const sig = `${key}|${JSON.stringify(autoFlowRunCount(key))}|${Object.keys(artifacts.researched).length}|${artifacts.drafts.length}|${artifacts.sent.length}|${artifacts.opportunities.length}`;
  if (sig === autoFlowStageRunSig) return;
  autoFlowStageRunSig = sig;
  void loadAutoFlowResult(key).then((payload) => {
    if (autoFlowStageKey !== key) return;
    if (countEl) countEl.textContent = autoFlowLiveTextOf(key);
    const limit = 6;
    rowsEl.innerHTML = payload.rows.length
      ? payload.rows.slice(0, limit).map((row) => `
          <li data-tone="${row.tone || "wait"}"${key === "research" && row.id ? ` data-af-report="${escapeHtml(row.id)}" class="is-link" title="查看完整背调报告"` : (key === "compose" || key === "send") && row.id ? ` data-af-draft="${escapeHtml(row.id)}" class="is-link" title="查看并编辑这封信"` : ""}>
            <i aria-hidden="true"></i>
            <span class="af-run-name" title="${escapeHtml(row.c1)}">${escapeHtml(row.c1)}</span>
            <span class="af-run-note" title="${escapeHtml(row.c2)}">${escapeHtml(row.c2)}</span>
            ${row.tag ? `<em class="${row.tone || "wait"}">${escapeHtml(row.tag)}</em>` : ""}
          </li>`).join("") + (payload.rows.length > limit ? `<li class="af-run-more"><button type="button" data-af-stage-more="${escapeHtml(key)}">还有 ${payload.rows.length - limit} 条，查看全部</button></li>` : "")
      : `<li class="af-run-empty">${key === "prospect" ? `开始后会显示找到的公司，这次目标 ${autoFlowEnsure().targetCount || AUTO_FLOW_TARGET_DEFAULT} 家` : "这一步还没开始，开始后逐条显示在这里"}</li>`;
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
  if (tag) {
    const status = state.status[desired.key] || "idle";
    tag.textContent = desired.key === "monitor" && status === "done" ? "监控中" : autoFlowStageLabel(status, state.progress[desired.key] || 0);
  }
  const live = qs<HTMLElement>('#afStage [data-role="stage-live"]');
  if (live) live.textContent = autoFlowLiveTextOf(desired.key);
  autoFlowFillStageRun();
}

const AUTO_FLOW_RESULT_HEADERS: Record<string, [string, string, string]> = {
  prospect: ["公司", "国家 / 业务", "来源"],
  research: ["公司", "核验等级", "置信度"],
  compose: ["收件人", "主题", "生成时间"],
  send: ["收件人", "主题", "投递状态"],
  monitor: ["收件人", "最新状态", "时间"]
};

interface AutoFlowResultRow {
  /** 对应的候选 id（背调行可点开报告） */
  id?: string;
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

/**
 * 第 5 步「数据监控」的实时快照：这一批发出去几封、被打开几封、谁回复了。
 * 存的是「哪一批」的数据（batchId），换批次就作废，绝不让上一批的数字留在界面里。
 */
interface AutoFlowMonitorData {
  batchId: string;
  runId: string;
  engagement: AutoFlowEngagement;
  rows: AutoFlowRunRow[];
  /**
   * 这批信用的发件邮箱里，有几个在 IMAP 监听范围内。
   * 回信 / 退信只能靠收件箱同步回写，没覆盖到的邮箱这两栏永远是 0 —— 面板要说清楚。
   */
  replyCoverage: { watchers: number; senders: string[]; uncovered: string[]; unknownSender: number };
  /** 取数时间（毫秒），用于「上次刷新 hh:mm:ss」 */
  at: number;
}

let autoFlowMonitorData: AutoFlowMonitorData | null = null;
let autoFlowMonitorLoading = false;
let autoFlowMonitorError = "";


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

/**
 * 每一步的产出只看「本轮运行」自己的产物，和卡片上的数字、交给下一步的名单一一对应。
 * 以前读的是全局台账（搜客池 171 家、发信台账 26 封、收件箱 188 封），和这一轮毫无关系。
 * 历史全量去对应模块看（结果区右上角「打开…」）。
 */
async function loadAutoFlowResult(key: string): Promise<AutoFlowResultPayload> {
  const artifacts = autoFlowEnsure().artifacts!;
  const shortTime = (value: string) => autoFlowResultTimeOf(value);
  let rows: AutoFlowResultRow[] = [];
  if (key === "prospect") {
    const picked = new Set(autoFlowSelectedCandidates().map((item) => item.id));
    rows = artifacts.opportunities.map((item) => ({
      c1: item.company,
      c2: `${item.country || "—"}　${item.business || ""}`.trim(),
      c3: item.email || "缺邮箱",
      tag: picked.has(item.id) ? "已选" : "未选",
      tone: picked.has(item.id) ? "ok" : "wait"
    }));
  } else if (key === "research") {
    rows = autoFlowSelectedCandidates().map((item) => {
      const done = Object.prototype.hasOwnProperty.call(artifacts.researched, item.id);
      const result = artifacts.researched[item.id];
      return {
        id: item.id,
        c1: item.company,
        c2: result ? result.verdict || "已完成" : done ? "背调没有结果，已跳过" : "等待背调",
        c3: result ? `${result.score} 分` : "—",
        tag: result ? "已背调" : done ? "已跳过" : "待背调",
        tone: result ? "ok" : done ? "warn" : "wait"
      };
    });
  } else if (key === "compose") {
    rows = artifacts.drafts.map((draft) => ({
      id: draft.prospectId,
      c1: draft.to || `${draft.company}（缺邮箱）`,
      c2: draft.subject,
      c3: draft.engineNote,
      tag: draft.to ? "可发送" : "缺邮箱",
      tone: draft.to ? "ok" : "warn"
    }));
  } else if (key === "send") {
    const sentKeys = new Set(artifacts.sent.map((item) => `${item.to}|${item.subject}`));
    rows = [
      ...artifacts.sent.map((item) => ({ c1: item.to, c2: item.subject, c3: item.note, tag: item.ok ? "已发出" : "被拦下", tone: (item.ok ? "ok" : "warn") as AutoFlowResultRow["tone"] })),
      ...artifacts.drafts.filter((draft) => draft.to && !sentKeys.has(`${draft.to}|${draft.subject}`))
        .map((draft) => ({ id: draft.prospectId, c1: draft.to, c2: draft.subject, c3: "—", tag: "待确认发送", tone: "wait" as const }))
    ];
  } else if (key === "monitor") {
    // 回复最要紧，其次退信（要停发），再是打开过的；剩下的按发出时间倒序垫底
    const data = await loadAutoFlowMonitor();
    const rank = (row: AutoFlowRunRow) => row.repliedAt ? 0 : row.bouncedAt ? 1 : row.openCount > 0 ? 2 : 3;
    rows = (data?.rows || [])
      .slice()
      .sort((a, b) => rank(a) - rank(b) || String(b.sentAt).localeCompare(String(a.sentAt)))
      .map((row) => {
        const state = row.repliedAt
          ? { tag: "已回复", tone: "ok" as const, when: row.repliedAt, note: "回复时间" }
          : row.bouncedAt
            ? { tag: "退信", tone: "warn" as const, when: row.bouncedAt, note: "退信时间" }
            : row.openCount > 0
              ? { tag: `已打开 ${row.openCount} 次`, tone: "ok" as const, when: row.firstOpenedAt, note: "首次打开" }
              : row.dispatchStatus !== "sent"
                ? { tag: "未确认送达", tone: "warn" as const, when: row.sentAt, note: "发出时间" }
                : { tag: "已送达 · 未打开", tone: "wait" as const, when: row.sentAt, note: "发出时间" };
        return {
          c1: row.to || "—",
          c2: `${row.subject || "（无主题）"} · ${state.tag}`,
          c3: `${state.note} ${autoFlowResultTimeOf(state.when)}`,
          tag: state.tag,
          tone: state.tone
        };
      });
  }
  const payload = { total: rows.length, rows };
  autoFlowResults[key] = payload;
  return payload;
}

function autoFlowRenderResult(key: string, payload?: AutoFlowResultPayload, error?: string) {
  const box = qs<HTMLElement>("#afResult");
  if (!box) return;
  const step = autoFlowStepOf(key);
  if (!step) return;
  const head = AUTO_FLOW_RESULT_HEADERS[key] || ["", "", ""];
  if ((key === "compose" || key === "send") && !error) {
    box.dataset.mode = "drafts";
    box.innerHTML = autoFlowDraftsHtml(step);
    box.hidden = false;
    return;
  }
  if (key === "research" && !error && payload) {
    box.innerHTML = `
      <div class="af-result-h">
        <b>「背调」的产出 <span>${payload.total} 家，点任意一行看完整报告</span></b>
        <span class="af-result-tools">
          <button class="link" type="button" data-open="${escapeHtml(step.view)}">打开${escapeHtml(step.viewLabel)}</button>
          <button class="af-result-close" type="button" data-af-close aria-label="收起结果">收起</button>
        </span>
      </div>
      ${autoFlowResearchTableHtml()}`;
    box.hidden = false;
    return;
  }
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
                  `<tr><td title="${escapeHtml(row.c1)}">${escapeHtml(row.c1)}</td><td title="${escapeHtml(row.c2)}">${escapeHtml(row.c2)}</td><td>${escapeHtml(row.c3)}${
                    row.tag ? ` <em class="${row.tone || "wait"}">${escapeHtml(row.tag)}</em>` : ""
                  }</td></tr>`
              )
              .join("")}</tbody>
          </table></div>`
        : '<div class="af-result-empty">这一步本次还没有产出。以前的记录在右上角「打开' + escapeHtml(step.viewLabel) + '」里。</div>';

  box.innerHTML = `
    <div class="af-result-h">
      <b>「${escapeHtml(step.title)}」的产出 <span>${payload ? escapeHtml(String(payload.total)) : "—"} 条</span></b>
      <span class="af-result-tools">
        ${key === "prospect" ? autoFlowExcelImportButton() : ""}
        <button class="link" type="button" data-open="${escapeHtml(step.view)}">打开${escapeHtml(step.viewLabel)}</button>
        <button class="af-result-close" type="button" data-af-close aria-label="收起结果">收起</button>
      </span>
    </div>
    ${body}`;
  box.hidden = false;
}

// ---------- 关键人 / 邮箱 ----------
/** 从获客结果里取关键人：优先结构化的人员联系人，其次 CLI 给的 contact 文本（常见「姓名 - 岗位」） */
function autoFlowPeopleOf(item: { contact?: string; extractedContacts?: Array<{ kind: string; name: string; title: string; emails: string[] }> }): AutoFlowPerson[] {
  const people: AutoFlowPerson[] = (item.extractedContacts || [])
    .filter((contact) => contact.kind === "person" && (contact.name || contact.title))
    .map((contact) => ({ name: contact.name.trim(), title: contact.title.trim(), email: contact.emails?.[0] || "" }));
  const raw = String(item.contact || "").trim();
  if (!people.length && raw && !/@/.test(raw)) {
    const [name, ...rest] = raw.split(/\s*[-–—|,，(（]\s*/);
    people.push({ name: name || raw, title: rest.join(" ").replace(/[)）]$/, "").trim(), email: "" });
  }
  return autoFlowDedupePeople(people);
}

function autoFlowDedupePeople(people: AutoFlowPerson[]) {
  const seen = new Set<string>();
  return people.filter((person) => {
    const key = `${person.name.toLowerCase()}|${person.email.toLowerCase()}`;
    if (!person.name && !person.email) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

/** 背调报告里的关键人：事实里标为联系人/负责人/决策人的条目，以及联系方式里的邮箱 */
function autoFlowMergeResearch(candidate: AutoFlowCandidate, research: BackgroundResearch) {
  const emails = (research.contacts || [])
    .filter((contact) => /mail|邮箱/i.test(contact.channel) || /@/.test(contact.value))
    .map((contact) => contact.value.trim())
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  const people = [
    // 背调报告里的结构化关键人排最前（有岗位、有出处）
    ...(research.keyPeople || []).map((person) => ({ name: person.name, title: person.title, email: person.email })),
    ...(candidate.people || [])
  ];
  // 发信邮箱：候选本身没有时，优先用关键人的个人邮箱，其次公司邮箱
  if (!candidate.email) candidate.email = people.find((person) => person.email)?.email || emails[0] || "";
  for (const fact of research.facts || []) {
    if (!/联系人|关键人|决策|负责人|采购|经理|总监|CEO|owner|director|manager|buyer|purchas|contact/i.test(fact.label)) continue;
    const value = String(fact.value || "").trim();
    if (!value || value === "待核实") continue;
    const email = /[^\s@，,;；]+@[^\s@，,;；]+\.[a-z]{2,}/i.exec(value)?.[0] || "";
    const name = value.replace(email, "").split(/[，,;；|]/)[0]!.trim();
    people.push({ name: name || value, title: /联系人|contact/i.test(fact.label) ? "" : fact.label, email });
  }
  candidate.people = autoFlowDedupePeople(people);
}

function autoFlowPeopleText(people?: AutoFlowPerson[]) {
  if (!people?.length) return "";
  const first = people[0]!;
  return `${first.name || "（未署名）"}${first.title ? ` · ${first.title}` : ""}${people.length > 1 ? ` 等 ${people.length} 人` : ""}`;
}

function autoFlowResearchTableHtml() {
  const artifacts = autoFlowEnsure().artifacts!;
  const targets = autoFlowSelectedCandidates();
  if (!targets.length) return '<div class="af-result-empty">还没有交给背调的公司。</div>';
  return `<div class="af-tbl-wrap"><table class="af-tbl af-rs-tbl">
    <thead><tr><th>公司</th><th>关键人</th><th>邮箱</th><th>背调结论</th><th>匹配分</th></tr></thead>
    <tbody>${targets.map((item) => {
      const done = Object.prototype.hasOwnProperty.call(artifacts.researched, item.id);
      const result = artifacts.researched[item.id];
      const people = item.people || [];
      const first = people[0];
      return `<tr data-af-report="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="查看 ${escapeHtml(item.company)} 的背调报告">
        <td><b>${escapeHtml(item.company)}</b><small>${escapeHtml(item.country || "")}</small></td>
        <td>${first ? `<b class="af-rs-person">${escapeHtml(first.name || "（未署名）")}</b><small>${escapeHtml(first.title || "岗位未知")}${people.length > 1 ? `，另有 ${people.length - 1} 人` : ""}</small>` : '<span class="af-rs-none">未找到具名联系人</span>'}</td>
        <td>${item.email ? `<span class="af-rs-mail">${escapeHtml(item.email)}</span>` : '<em class="warn">缺邮箱</em>'}</td>
        <td><span class="af-rs-verdict">${result ? escapeHtml(result.verdict || "已完成") : done ? '<span class="af-rs-none">背调没有结果，已跳过</span>' : '<span class="af-rs-none">等待背调</span>'}</span></td>
        <td>${result ? `<span class="af-rs-score" data-tone="${result.score >= 75 ? "ok" : result.score >= 50 ? "mid" : "low"}">${result.score}</span>` : done ? '<em class="warn">已跳过</em>' : "<em>待背调</em>"}</td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

// ---------- 背调报告弹窗 ----------
const autoFlowReports = new Map<string, BackgroundResearch>();

async function openAutoFlowReport(candidateId: string) {
  const artifacts = autoFlowEnsure().artifacts!;
  const candidate = artifacts.opportunities.find((item) => item.id === candidateId);
  if (!candidate) return;
  const title = `${candidate.company} 背调报告`;
  let research = autoFlowReports.get(candidateId) || null;
  if (!research) {
    openModal(title, '<div class="af-report-loading">正在读取完整背调报告…</div>', '<button class="btn" type="button" data-modal-close>关闭</button>', { modalClass: "af-report-modal", description: "本次自动流第 2 步的背调结果" });
    try {
      const result = await api<{ research: BackgroundResearch | null }>(`/api/prospect-list/${encodeURIComponent(candidateId)}/background-research`);
      research = result.research || null;
      if (research) autoFlowReports.set(candidateId, research);
    } catch (error) {
      openModal(title, `<div class="af-report-loading">报告读取失败：${escapeHtml(error instanceof Error ? error.message : "未知错误")}</div>`, '<button class="btn" type="button" data-modal-close>关闭</button>', { modalClass: "af-report-modal" });
      return;
    }
  }
  if (!research) {
    const state = artifacts.researched[candidateId];
    openModal(title, `<div class="af-report-loading">${state === null ? "这家公司背调没有返回结果，已跳过。可以去搜客清单单独重跑背调。" : "这家公司还没有背调，第 2 步跑到它之后再来看。"}</div>`, '<button class="btn" type="button" data-modal-close>关闭</button>', { modalClass: "af-report-modal" });
    return;
  }
  openModal(title, autoFlowReportHtml(candidate, research), `
    <button class="btn" type="button" data-af-report-open="prospect-list">在搜客清单里打开</button>
    <button class="btn primary" type="button" data-modal-close>关闭</button>`, { modalClass: "af-report-modal", description: `${research.country || candidate.country || ""}${research.completedAt ? `　背调于 ${new Date(research.completedAt).toLocaleString("zh-CN", { hour12: false })}` : ""}`.trim() });
  qs<HTMLButtonElement>("[data-af-report-open]")?.addEventListener("click", () => {
    closeModal();
    activateNavView("prospect-list");
  });
}

function autoFlowReportHtml(candidate: AutoFlowCandidate, research: BackgroundResearch) {
  const score = Math.max(0, Math.min(100, Math.round(Number(research.score) || 0)));
  const tone = score >= 75 ? "ok" : score >= 50 ? "mid" : "low";
  const people = candidate.people || [];
  const contacts = (research.contacts || []).filter((item) => item.value);
  const list = (items: string[] | undefined) => (items || []).filter(Boolean).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const section = (title: string, body: string) => body ? `<section class="af-rp-sec"><h5>${escapeHtml(title)}</h5>${body}</section>` : "";
  const domain = autoFlowDomain(candidate.website);
  const riskLabel: Record<string, string> = { high: "高", medium: "中", low: "低" };
  return `
    <div class="af-rp">
      <header class="af-rp-hero">
        <div class="af-rp-score" data-tone="${tone}" style="--score:${score}">
          <b>${score}</b><span>匹配分</span>
        </div>
        <div class="af-rp-hero-main">
          <p class="af-rp-verdict">${escapeHtml(research.verdict || "未给出结论")}</p>
          ${research.scoreReason ? `<p class="af-rp-reason">${escapeHtml(research.scoreReason)}</p>` : ""}
          <div class="af-rp-meta">
            ${domain ? `<a href="${escapeHtml(/^https?:/i.test(candidate.website || "") ? candidate.website! : `https://${domain}`)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domain)}</a>` : ""}
            ${candidate.country ? `<span>${escapeHtml(candidate.country)}</span>` : ""}
            ${research.engine ? `<span>执行：${escapeHtml(research.engine)}</span>` : ""}
          </div>
        </div>
      </header>

      <div class="af-rp-grid">
        ${section("关键人", people.length
          ? `<ul class="af-rp-people">${people.map((person) => `
              <li>
                <span class="af-rp-avatar" aria-hidden="true">${escapeHtml((person.name || "?").trim().slice(0, 1).toUpperCase())}</span>
                <span class="af-rp-person"><b>${escapeHtml(person.name || "（未署名）")}</b><small>${escapeHtml(person.title || "岗位未知")}</small></span>
                ${person.email ? `<a href="mailto:${escapeHtml(person.email)}">${escapeHtml(person.email)}</a>` : '<em>无个人邮箱</em>'}
              </li>`).join("")}</ul>`
          : '<p class="af-rp-empty">公开资料里没有找到具名的关键人。写信会发到公司邮箱。</p>')}
        ${section("联系方式", `<ul class="af-rp-contacts">
            ${candidate.email ? `<li><span>发信邮箱</span><a href="mailto:${escapeHtml(candidate.email)}">${escapeHtml(candidate.email)}</a></li>` : '<li><span>发信邮箱</span><em>还没有找到，需要补充后才能发信</em></li>'}
            ${contacts.filter((item) => item.value !== candidate.email).map((item) => `<li><span>${escapeHtml(item.channel)}</span><b>${escapeHtml(item.value)}</b></li>`).join("")}
          </ul>`)}
      </div>

      ${section("摘要", research.summary ? `<p class="af-rp-text">${escapeHtml(research.summary)}</p>` : "")}
      ${section("核实到的事实", (research.facts || []).length ? `<dl class="af-rp-facts">${research.facts.map((fact) => `
          <div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}${fact.sourceUrl ? ` <a href="${escapeHtml(fact.sourceUrl)}" target="_blank" rel="noopener noreferrer">来源</a>` : ""}</dd></div>`).join("")}</dl>` : "")}
      <div class="af-rp-grid">
        ${section("合作机会", list(research.opportunities) ? `<ul class="af-rp-bullets">${list(research.opportunities)}</ul>` : "")}
        ${section("风险", (research.risks || []).length ? `<ul class="af-rp-risks">${research.risks.map((risk) => `<li data-level="${escapeHtml(risk.level)}"><em>${riskLabel[risk.level] || risk.level}</em><span><b>${escapeHtml(risk.title)}</b>${risk.detail ? `<small>${escapeHtml(risk.detail)}</small>` : ""}</span></li>`).join("")}</ul>` : "")}
      </div>
      ${section("建议切入话术", list(research.talkTracks) ? `<ul class="af-rp-bullets">${list(research.talkTracks)}</ul>` : "")}
      ${section("下一步", research.nextAction ? `<p class="af-rp-next">${escapeHtml(research.nextAction)}</p>` : "")}
      ${section(`证据来源（${(research.sources || []).length}）`, (research.sources || []).length ? `<ol class="af-rp-sources">${research.sources.map((source) => `
          <li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.url)}</a>${source.detail ? `<small>${escapeHtml(source.detail)}</small>` : ""}</li>`).join("")}</ol>` : "")}
    </div>`;
}

// ---------- 第 1 步结果：本次候选清单 + 勾选交给背调 ----------
function autoFlowSelectedCandidates() {
  const artifacts = autoFlowEnsure().artifacts!;
  const ids = artifacts.selectedIds;
  if (!ids) return artifacts.opportunities.slice();
  const picked = artifacts.opportunities.filter((item) => ids.includes(item.id));
  // 勾选记录和当前候选对不上（换过一轮获客、历史残留）时不能当成「一家都没选」：
  // 那会让背调直接失败，点重试也永远失败。按默认全选处理。
  if (!picked.length && artifacts.opportunities.length) {
    artifacts.selectedIds = undefined;
    return artifacts.opportunities.slice();
  }
  return picked;
}

/** 勾选只在「获客已完成、背调还没开始」时可改；之后锁定，避免改了已经交出去的名单 */
function autoFlowCanEditPick() {
  const state = autoFlowEnsure();
  return state.status.prospect === "done"
    && !state.activeKey
    && ["idle", "failed"].includes(state.status.research || "idle")
    && Object.keys(state.artifacts!.researched).length === 0;
}

function autoFlowDomain(url?: string) {
  const text = String(url || "").trim();
  if (!text) return "";
  try {
    return new URL(/^https?:/i.test(text) ? text : `https://${text}`).hostname.replace(/^www\./, "");
  } catch {
    return text.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
}

function autoFlowPickHtml() {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const list = artifacts.opportunities;
  const selected = new Set(autoFlowSelectedCandidates().map((item) => item.id));
  const editable = autoFlowCanEditPick();
  const withEmail = list.filter((item) => item.email).length;
  const rows = list.map((item, index) => {
    const on = selected.has(item.id);
    const domain = autoFlowDomain(item.website);
    return `
      <li class="af-pick-row" data-on="${on ? "1" : "0"}" style="--r:${index}">
        <label class="af-pick-check">
          <input type="checkbox" data-af-pick="${escapeHtml(item.id)}" ${on ? "checked" : ""} ${editable ? "" : "disabled"} aria-label="选择 ${escapeHtml(item.company)}">
          <span aria-hidden="true"></span>
        </label>
        <div class="af-pick-main">
          <b class="af-pick-name" title="${escapeHtml(item.company)}">${escapeHtml(item.company)}</b>
          ${item.people?.length ? `<span class="af-pick-person">${escapeHtml(autoFlowPeopleText(item.people))}</span>` : ""}
          ${domain ? `<a class="af-pick-site" href="${escapeHtml(/^https?:/i.test(item.website || "") ? item.website! : `https://${domain}`)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domain)}</a>` : '<span class="af-pick-site is-missing">暂无官网</span>'}
        </div>
        <span class="af-pick-country">${escapeHtml(item.country || "未知国家")}</span>
        <p class="af-pick-biz" title="${escapeHtml(item.business || "")}">${escapeHtml(item.business || "暂无业务描述")}</p>
        <span class="af-pick-mail" data-ok="${item.email ? "1" : "0"}" title="${escapeHtml(item.email || "还没有找到联系邮箱，写好的信需要先补邮箱才能发")}">${item.email ? "有邮箱" : "缺邮箱"}</span>
      </li>`;
  }).join("");
  const count = selected.size;
  return `
    <div class="af-result-h af-pick-head">
      <label class="af-pick-check af-pick-all">
        <input type="checkbox" data-af-pick-all ${count === list.length ? "checked" : ""} ${editable ? "" : "disabled"} aria-label="全选">
        <span aria-hidden="true"></span>
      </label>
      <b>本次找到 ${list.length} 家候选 <span>${withEmail} 家有邮箱</span></b>
      <span class="af-result-tools">
        ${autoFlowExcelImportButton()}
        <button class="link" type="button" data-open="lead-finder">打开搜客</button>
        <button class="af-result-close" type="button" data-af-close aria-label="收起结果">收起</button>
      </span>
    </div>
    <ul class="af-pick-list">${rows}</ul>
    <div class="af-pick-foot" data-editable="${editable ? "1" : "0"}">
      <span class="af-pick-count">已选 <b data-role="pick-count">${count}</b> / ${list.length} 家</span>
      ${editable
        ? `<span class="af-pick-hint">取消勾选的公司不会进入背调和写信</span>
           <button class="btn primary" type="button" data-af-pick-go ${count ? "" : "disabled"}>把选中的 <span data-role="pick-count">${count}</span> 家交给第 2 步背调</button>`
        : `<span class="af-pick-hint">${state.status.prospect === "done" ? "这批名单已经交给背调，勾选已锁定" : "第 1 步完成后可以在这里勾选"}</span>`}
    </div>`;
}

function autoFlowRenderPick() {
  const box = qs<HTMLElement>("#afResult");
  if (!box) return;
  box.dataset.mode = "pick";
  box.innerHTML = autoFlowPickHtml();
  box.hidden = false;
}

// ---------- Excel 名单导入（第 1 步结束后，用自己的名单补进本轮） ----------
/** 导入中：按钮显示进度文案并禁用，避免重复点 */
let autoFlowExcelBusy = false;
let autoFlowExcelHint = "";

function autoFlowExcelImportButton() {
  const label = autoFlowExcelBusy ? (autoFlowExcelHint || "识别中…") : "导入 Excel";
  return `<button class="link" type="button" data-af-excel-import ${autoFlowExcelBusy ? "disabled" : ""} title="把自己的名单（.xlsx / .xls / .csv，任意表头）交给本机 CLI 识别，并进本轮候选">${escapeHtml(label)}</button>`;
}

function autoFlowPickExcel() {
  if (autoFlowExcelBusy) return;
  let input = qs<HTMLInputElement>("#afExcelImportInput");
  if (!input) {
    input = document.createElement("input");
    input.type = "file";
    input.id = "afExcelImportInput";
    input.accept = ".xlsx,.xls,.csv";
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input?.files?.[0];
      if (input) input.value = "";
      if (file) void autoFlowImportExcel(file);
    });
    document.body.appendChild(input);
  }
  input.click();
}

function autoFlowRefreshProspectResult() {
  if (autoFlowResultKey === "prospect") autoFlowRenderPick();
  autoFlowSyncResultCounts();
  autoFlowCheckpointSig = "";
  autoFlowRenderCheckpoint();
}

async function autoFlowImportExcel(file: File) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const hadSelection = artifacts.selectedIds !== undefined;
  const previouslyPicked = new Set(autoFlowSelectedCandidates().map((item) => item.id));
  autoFlowExcelBusy = true;
  autoFlowExcelHint = "正在上传…";
  autoFlowRefreshProspectResult();
  try {
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("只支持 .xlsx / .xls / .csv 文件");
    if (file.size > 8 * 1024 * 1024) throw new Error("文件超过 8MB，请拆小后再传");
    const contentBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").replace(/^data:[^,]*,/, ""));
      reader.onerror = () => reject(new Error("本地读取文件失败"));
      reader.readAsDataURL(file);
    });
    const created = await api<{ task: { id: string } }>("/api/lead-finder/excel-imports", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contentBase64 })
    });
    autoFlowLog("start", `Excel「${file.name}」已交给本机 CLI 识别（任务 ${created.task.id.slice(-8)}）`);
    autoFlowWrite();
    autoFlowExcelHint = "CLI 正在识别表格…";
    autoFlowRefreshProspectResult();

    const startedAt = Date.now();
    for (;;) {
      await autoFlowSleep(4000);
      if (Date.now() - startedAt > 15 * 60_000) {
        throw new Error("识别超过 15 分钟仍未完成，可在集成中心查看这次执行记录");
      }
      const response = await api<LfindTaskResponse & { filename?: string }>(
        `/api/lead-finder/excel-imports/${encodeURIComponent(created.task.id)}`
      );
      const status = response.task.status;
      if (status === "failed" || status === "cancelled") {
        throw new Error(response.task.errorMessage || `识别任务${status === "cancelled" ? "已取消" : "失败"}`);
      }
      if (!response.synced) continue;
      const known = new Set(artifacts.opportunities.map((item) => item.id));
      const added: AutoFlowCandidate[] = (response.opportunities || [])
        .filter((item) => !known.has(item.id))
        .map((item) => ({
          id: item.id,
          company: item.company,
          email: item.emailEligibility?.recipient
            || item.extractedContacts?.find((contact) => contact.emails?.length)?.emails[0]
            || "",
          country: item.country || "",
          website: item.website || "",
          business: item.business || item.description || "",
          contact: item.contact || "",
          source: item.sourceLabel || item.source || "",
          people: autoFlowPeopleOf(item)
        }));
      artifacts.opportunities = [...artifacts.opportunities, ...added];
      // 新导入的公司默认选中：原本全选就继续保持全选；原本手动选过就追加进去
      artifacts.selectedIds = hadSelection
        ? [...new Set([...previouslyPicked, ...added.map((item) => item.id)])]
        : undefined;
      autoFlowWrite();
      const merged = (response.opportunities || []).length - added.length;
      const skipped = Array.isArray(response.skipped) ? response.skipped.length : 0;
      autoFlowLog(
        "done",
        `Excel 导入完成：新增 ${added.length} 家${merged > 0 ? `，${merged} 家已入池（合并了证据）` : ""}${skipped ? `，跳过 ${skipped} 家` : ""}`
      );
      autoFlowWrite();
      toast(`Excel 导入完成：新增 ${added.length} 家候选${merged > 0 ? `，${merged} 家已存在` : ""}`, added.length ? "success" : "error");
      return;
    }
  } catch (error) {
    autoFlowLog("warn", `Excel 导入失败：${error instanceof Error ? error.message : "未知错误"}`);
    autoFlowWrite();
    toast(error instanceof Error ? error.message : "Excel 导入失败", "error");
  } finally {
    autoFlowExcelBusy = false;
    autoFlowExcelHint = "";
    autoFlowRefreshProspectResult();
  }
}

/** 勾选变化：只更新计数与按钮，不重画整张清单（保留滚动位置与焦点） */
function autoFlowApplyPick(ids: string[]) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  artifacts.selectedIds = ids.length === artifacts.opportunities.length ? undefined : ids;
  autoFlowWrite();
  const set = new Set(ids);
  qsa<HTMLInputElement>("#afResult [data-af-pick]").forEach((input) => {
    input.checked = set.has(input.dataset.afPick || "");
    input.closest<HTMLElement>(".af-pick-row")?.setAttribute("data-on", input.checked ? "1" : "0");
  });
  const all = qs<HTMLInputElement>("#afResult [data-af-pick-all]");
  if (all) {
    all.checked = ids.length === artifacts.opportunities.length;
    all.indeterminate = ids.length > 0 && ids.length < artifacts.opportunities.length;
  }
  qsa<HTMLElement>('#afResult [data-role="pick-count"]').forEach((el) => { el.textContent = String(ids.length); });
  const go = qs<HTMLButtonElement>("#afResult [data-af-pick-go]");
  if (go) go.disabled = ids.length === 0;
  autoFlowCheckpointSig = ""; // 停靠点按钮上的家数跟着变
  autoFlowRenderCheckpoint();
  autoFlowSyncResultCounts();
}

/** 继续进入背调前：一家都没勾选就拦下 */
function autoFlowPickBlocked() {
  const state = autoFlowEnsure();
  const next = AUTO_FLOW_STEPS.find((item) => state.status[item.key] !== "done");
  if (next?.key !== "research" || !state.artifacts!.opportunities.length) return false;
  if (autoFlowSelectedCandidates().length) return false;
  toast("第 1 步的候选一家都没勾选，至少选一家再继续", "error");
  if (autoFlowResultKey !== "prospect") void autoFlowShowResult("prospect");
  return true;
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
  if (key === "prospect" && autoFlowEnsure().artifacts!.opportunities.length) {
    autoFlowRenderPick();
    return;
  }
  const resultBox = qs<HTMLElement>("#afResult");
  if (resultBox) resultBox.dataset.mode = "table";
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
    const { value, of } = autoFlowRunCount(step.key);
    // 有分母且没做满时显示「完成数/目标数」，否则只显示数量
    node.textContent = of && value !== of ? `${value}/${of}` : String(value);
    const note = qs<HTMLElement>(`.af-node[data-step="${step.key}"] [data-role="foot-note"]`);
    if (note) note.textContent = autoFlowLiveTextOf(step.key);
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
    const previous = node.dataset.status;
    node.dataset.status = status;
    if (previous && previous !== status && status === "done" && !autoFlowIntroActive()) autoFlowFlash(node, "af-just-done", 1100);
    if (previous && previous !== status && status === "running") autoFlowFlash(node, "af-just-start", 900);
    const chip = node.querySelector<HTMLElement>('[data-role="chip"]');
    const waiting = autoFlowWaitingKey(state) === step.key;
    node.dataset.wait = waiting ? "1" : "0";
    if (chip) {
      // 第 5 步完成后不是「已完成」，而是「监控中」：它一直在盯着这一批的打开与回复
      const watching = step.key === "monitor" && status === "done" && !waiting;
      let nextText = "待执行";
      if (waiting) nextText = "等你继续";
      else if (watching) nextText = "监控中";
      else if (status === "done") nextText = "已完成";
      else if (status === "running") nextText = `进行中 ${Math.round(progress)}%`;
      else if (status === "paused") nextText = progress > 0 ? `已暂停 ${Math.round(progress)}%` : "已暂停";
      else if (status === "failed") nextText = "失败";
      // 进度百分比每秒都在变，只在「状态类别」变化时翻一下，避免标签一直抖
      const kind = waiting ? "wait" : watching ? "watch" : status;
      if (chip.dataset.kind && chip.dataset.kind !== kind) autoFlowFlash(chip, "af-bump", 450);
      chip.dataset.kind = kind;
      chip.textContent = nextText;
    }
    node.dataset.watch = step.key === "monitor" && status === "done" ? "1" : "0";
    node.style.setProperty("--af-progress", `${status === "done" ? 100 : Math.round(progress)}%`);
  }


  const overall = Math.round(progressSum / AUTO_FLOW_STEPS.length);
  const overallText = qs<HTMLElement>("#afOverallText");
  if (overallText) autoFlowTweenNumber(overallText, overall, "%");
  qs<HTMLElement>("#afProgress")?.toggleAttribute("data-running", Boolean(state.activeKey));
  const doneText = qs<HTMLElement>("#afDoneText");
  if (doneText) doneText.textContent = `${doneCount} / ${AUTO_FLOW_STEPS.length}`;
  const currentText = qs<HTMLElement>("#afCurrentText");
  if (currentText) {
    const active = autoFlowStepOf(state.activeKey);
    const pausedStep = AUTO_FLOW_STEPS.find((step) => state.status[step.key] === "paused");
    const failedStep = AUTO_FLOW_STEPS.find((step) => state.status[step.key] === "failed");
    const lastDone = [...AUTO_FLOW_STEPS].reverse().find((step) => state.status[step.key] === "done");
    currentText.textContent = active
      ? `${active.title}${state.stepMode ? "（步进）" : ""}`
      : pausedStep
        ? `${pausedStep.title}（已暂停）`
        : failedStep
          ? `${failedStep.title}（失败 · 未在运行）`
          : doneCount === AUTO_FLOW_STEPS.length
            ? "全部完成"
            : state.stepMode && lastDone
              ? `${lastDone.title}已完成，等你继续`
              : "未开始";
  }
  const fill = qs<HTMLElement>("#afProgressFill");
  if (fill) fill.style.width = `${overall}%`;
  qs<HTMLElement>("#afProgress")?.setAttribute("aria-valuenow", String(overall));

  const runButton = qs<HTMLButtonElement>("#afRunButton");
  if (runButton) {
    const running = Boolean(state.activeKey);
    const paused = AUTO_FLOW_STEPS.some((step) => state.status[step.key] === "paused");
    const failed = AUTO_FLOW_STEPS.some((step) => state.status[step.key] === "failed");
    runButton.textContent = running
      ? "暂停"
      : failed
        ? "重试"
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

  const modeText = qs<HTMLElement>("#afModeText");
  if (modeText) {
    modeText.textContent = state.stepMode ? "步进运行：每步完成后停下" : "一次跑完";
    modeText.dataset.mode = state.stepMode ? "step" : "auto";
  }

  autoFlowRenderLogs();
  autoFlowSyncStage();
  autoFlowSyncResultCounts();
  autoFlowRefreshOpenResult();
  autoFlowRenderCheckpoint();
}

// ---------- 动效小工具 ----------
const autoFlowFlashTimers = new WeakMap<HTMLElement, number>();
/** 给元素挂一个一次性的动画 class：重复触发时先摘掉再挂，保证动画从头播放 */
function autoFlowFlash(el: HTMLElement | null, cls: string, ms: number) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // 强制回流，让同名动画重新开始
  el.classList.add(cls);
  const old = autoFlowFlashTimers.get(el);
  if (old) window.clearTimeout(old);
  autoFlowFlashTimers.set(el, window.setTimeout(() => el.classList.remove(cls), ms));
}

function autoFlowIntroActive() {
  return Boolean(qs<HTMLElement>("#afTrack")?.classList.contains("af-intro"));
}

function autoFlowReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** 数字缓动到目标值（总进度百分比），避免数字一跳一跳 */
function autoFlowTweenNumber(el: HTMLElement, target: number, suffix: string) {
  const from = Number(el.dataset.value ?? Number.parseInt(el.textContent || "0", 10)) || 0;
  el.dataset.value = String(target);
  if (from === target || autoFlowReducedMotion()) {
    el.textContent = `${target}${suffix}`;
    return;
  }
  const started = performance.now();
  const duration = 600;
  const tick = (now: number) => {
    if (el.dataset.value !== String(target)) return; // 有新的目标值，旧动画作废
    const t = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `${Math.round(from + (target - from) * eased)}${suffix}`;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let autoFlowOpenResultSig = "";
/** 结果区开着时，本轮产物有变化（背调完一家、写好一封）就跟着刷新 */
function autoFlowRefreshOpenResult() {
  const key = autoFlowResultKey;
  const box = qs<HTMLElement>("#afResult");
  if (!key || !box || box.hidden) return;
  const artifacts = autoFlowEnsure().artifacts!;
  const sig = `${key}|${box.dataset.mode}|${JSON.stringify(autoFlowRunCount(key))}|${Object.keys(artifacts.researched).length}|${artifacts.drafts.length}|${artifacts.sent.length}|${autoFlowCanEditPick()}`;
  if (sig === autoFlowOpenResultSig) return;
  autoFlowOpenResultSig = sig;
  if (box.dataset.mode === "pick") {
    if (key === "prospect") autoFlowRenderPick();
    return;
  }
  if (box.dataset.mode === "drafts") {
    autoFlowRefreshDraftsPanel();
    return;
  }
  void loadAutoFlowResult(key).then((payload) => { if (autoFlowResultKey === key) autoFlowRenderResult(key, payload); });
}

/** 步进停下时「下一步」是谁：没有节点在跑、没有暂停/失败、已有完成节点，且处在步进模式 */
function autoFlowWaitingKey(state: AutoFlowState) {
  if (!state.stepMode || state.activeKey) return null;
  if (AUTO_FLOW_STEPS.some((step) => state.status[step.key] === "paused" || state.status[step.key] === "failed")) return null;
  if (!AUTO_FLOW_STEPS.some((step) => state.status[step.key] === "done")) return null;
  return AUTO_FLOW_STEPS.find((step) => state.status[step.key] !== "done")?.key || null;
}

let autoFlowCheckpointSig = "";

/**
 * 停靠点：流水线停下来的时候（步进停下 / 手动暂停 / 某步失败），在轨道正下方明确告诉用户
 * 「停在哪、这一步产出了什么、下一步做什么」，并把继续按钮放在眼前，不用回到页头找。
 */
function autoFlowRenderCheckpoint() {
  const box = qs<HTMLElement>("#afCheckpoint");
  if (!box) return;
  const state = autoFlowEnsure();
  const paused = AUTO_FLOW_STEPS.find((step) => state.status[step.key] === "paused");
  const failed = AUTO_FLOW_STEPS.find((step) => state.status[step.key] === "failed");
  const waitingKey = autoFlowWaitingKey(state);
  const kind = state.activeKey ? "" : failed ? "failed" : paused ? "paused" : waitingKey ? "step" : "";
  /** 停在哪一步：退回按钮要按它算出「上一步」是第几步 */
  const currentKey = failed?.key || paused?.key || "";
  const doneSteps = AUTO_FLOW_STEPS.filter((step) => state.status[step.key] === "done");
  const lastDone = doneSteps[doneSteps.length - 1];
  const sig = `${kind}|${failed?.key || ""}|${paused?.key || ""}|${waitingKey || ""}|${lastDone?.key || ""}|${autoFlowSelectedCandidates().length}`;
  if (sig === autoFlowCheckpointSig) return;
  autoFlowCheckpointSig = sig;
  if (!kind) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const indexOf = (key: string) => AUTO_FLOW_STEPS.findIndex((step) => step.key === key) + 1;
  let title = "";
  let note = "";
  let primary = "";
  let summaryKey = "";
  if (kind === "step") {
    const next = autoFlowStepOf(waitingKey)!;
    title = `第 ${indexOf(lastDone!.key)} 步「${lastDone!.title}」已完成`;
    note = `流水线停在这里，等你看过结果再继续。下一步是第 ${indexOf(next.key)} 步「${next.title}」：${next.desc}`;
    primary = next.key === "research" && state.artifacts!.opportunities.length
      ? `继续第 ${indexOf(next.key)} 步：背调选中的 ${autoFlowSelectedCandidates().length} 家`
      : `继续第 ${indexOf(next.key)} 步：${next.title}`;
    summaryKey = lastDone!.key;
  } else if (kind === "paused") {
    title = `第 ${indexOf(paused!.key)} 步「${paused!.title}」已暂停`;
    note = paused!.key === "send" && autoFlowSendPending
      ? "开发信已经备好，正在等你确认收件人和主题。确认区在下方节点详情里。"
      : `已完成 ${Math.round(state.progress[paused!.key] || 0)}%，继续后从断点接着跑，不会重复派单。`;
    primary = "继续运行";
    summaryKey = lastDone?.key || "";
  } else {
    title = `第 ${indexOf(failed!.key)} 步「${failed!.title}」失败了`;
    const lastWarn = [...state.logs].reverse().find((entry) => entry.kind === "warn");
    note = lastWarn ? lastWarn.text : "这一步没有在运行。处理完原因后点重试，会从这一步开头重新执行。";
    primary = `重试第 ${indexOf(failed!.key)} 步`;
    summaryKey = lastDone?.key || "";
  }
  const summaryStep = autoFlowStepOf(summaryKey);
  box.dataset.kind = kind;
  box.innerHTML = `
    <div class="af-cp-main">
      <h4 class="af-cp-title">${escapeHtml(title)}</h4>
      <p class="af-cp-note">${escapeHtml(note)}</p>
      ${summaryStep ? `
        <div class="af-cp-result">
          <div class="af-cp-result-head">
            <span>「${escapeHtml(summaryStep.title)}」的产出</span>
            <b data-role="cp-total">读取中…</b>
          </div>
          <ul class="af-cp-rows" data-role="cp-rows"></ul>
        </div>` : ""}
    </div>
    <div class="af-cp-actions">
      <button class="btn primary" type="button" data-af-cp="continue">${escapeHtml(primary)}</button>
      ${(kind === "failed" || kind === "paused") && indexOf(currentKey) > 1
        ? `<button class="btn" type="button" data-af-cp="back" data-key="${escapeHtml(currentKey)}">退回第 ${indexOf(currentKey) - 1} 步重做</button>`
        : ""}
      ${kind === "step" ? '<button class="btn" type="button" data-af-cp="finish">一次跑完剩余</button>' : ""}
      ${kind === "failed" ? '<button class="btn" type="button" data-af-cp="restart">从头重新开始</button>' : ""}
      ${summaryStep ? `<button class="af-cp-link" type="button" data-af-cp="view" data-key="${escapeHtml(summaryStep.key)}">查看完整结果</button>` : ""}
    </div>`;
  box.hidden = false;
  if (summaryStep) void autoFlowFillCheckpointRows(summaryStep.key, sig);
}

async function autoFlowFillCheckpointRows(key: string, sig: string) {
  const fill = (payload?: AutoFlowResultPayload, error?: string) => {
    if (autoFlowCheckpointSig !== sig) return;
    const total = qs<HTMLElement>('#afCheckpoint [data-role="cp-total"]');
    const rows = qs<HTMLElement>('#afCheckpoint [data-role="cp-rows"]');
    if (total) total.textContent = error ? "读取失败" : `${payload?.total ?? 0} 条`;
    if (!rows) return;
    rows.innerHTML = error
      ? `<li class="af-cp-empty">${escapeHtml(error)}</li>`
      : payload && payload.rows.length
        ? payload.rows.slice(0, 3).map((row) => `<li><b>${escapeHtml(row.c1)}</b><span>${escapeHtml(row.c2)}</span>${
            row.tag ? `<em class="${row.tone || "wait"}">${escapeHtml(row.tag)}</em>` : `<span class="af-cp-c3">${escapeHtml(row.c3)}</span>`
          }</li>`).join("")
        : '<li class="af-cp-empty">这一步还没有可展示的产出</li>';
  };
  try {
    fill(await loadAutoFlowResult(key));
  } catch (error) {
    fill(undefined, error instanceof Error ? error.message : "结果读取失败");
  }
}

/** 节点完成后，结果缓存作废：步进停下时看到的必须是刚跑出来的数据 */
function autoFlowInvalidateResults() {
  autoFlowResults = {};
  for (const name of Object.keys(autoFlowSources)) delete autoFlowSources[name];
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

let autoFlowFeedLastAt = 0;

async function loadAutoFlowFeed() {
  if (document.visibilityState === "hidden") return;
  autoFlowFeedLastAt = Date.now();
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

let autoFlowFeedVisibilityBound = false;

function startAutoFlowFeed() {
  void loadAutoFlowFeed();
  if (!autoFlowFeedVisibilityBound) {
    autoFlowFeedVisibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && autoFlowFeedTimer !== null && Date.now() - autoFlowFeedLastAt > 10_000) {
        void loadAutoFlowFeed();
      }
    });
  }
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

/** 可被「暂停」打断的等待：点暂停后最多 200ms 就落到检查点，不用干等一整个轮询间隔 */
function autoFlowSleep(ms: number) {
  return new Promise<void>((resolve) => {
    const until = Date.now() + ms;
    const tick = () => {
      if (autoFlowPauseRequested || Date.now() >= until) resolve();
      else window.setTimeout(tick, Math.min(200, until - Date.now()));
    };
    tick();
  });
}

// ---------- 等待提示：正在等什么、已经等了多久（每秒刷新） ----------
let autoFlowWait: { key: string; label: string; detail: string; since: number; stepSince: number } | null = null;
let autoFlowWaitTicker: number | null = null;

function autoFlowClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * 设置当前节点正在等待的事情。阶段（label）变了才重新计时；
 * detail 是阶段内会变的补充（如「已收到 3 条进度」），更新它不会把计时清零。
 */
function autoFlowSetWait(key: string, label: string, detail = "") {
  const now = Date.now();
  if (autoFlowWait && autoFlowWait.key === key && autoFlowWait.label === label) {
    if (autoFlowWait.detail !== detail) {
      autoFlowWait.detail = detail;
      autoFlowRenderWait();
    }
    return;
  }
  autoFlowWait = { key, label, detail, since: now, stepSince: autoFlowWait?.key === key ? autoFlowWait.stepSince : now };
  autoFlowRenderWait();
  if (autoFlowWaitTicker === null) autoFlowWaitTicker = window.setInterval(autoFlowRenderWait, 1000);
}

function autoFlowClearWait() {
  autoFlowWait = null;
  if (autoFlowWaitTicker !== null) {
    window.clearInterval(autoFlowWaitTicker);
    autoFlowWaitTicker = null;
  }
  autoFlowRenderWait();
}

function autoFlowRenderWait() {
  const wait = autoFlowWait;
  const now = Date.now();
  qsa<HTMLElement>('#afTrack [data-role="wait"]').forEach((el) => {
    const mine = Boolean(wait) && el.closest<HTMLElement>(".af-node")?.dataset.step === wait!.key;
    el.hidden = !mine;
    if (mine) el.textContent = `${wait!.label}${wait!.detail}，已等 ${autoFlowClock(now - wait!.since)}`;
  });
  const stageEl = qs<HTMLElement>('#afStage [data-role="stage-wait"]');
  if (stageEl) {
    const mine = Boolean(wait) && autoFlowStageKey === wait!.key;
    stageEl.hidden = !mine;
    if (mine) {
      const phase = autoFlowClock(now - wait!.since);
      const step = autoFlowClock(now - wait!.stepSince);
      stageEl.textContent = phase === step ? `${wait!.label}${wait!.detail}，已等 ${phase}` : `${wait!.label}${wait!.detail}，已等 ${phase}（这一步共 ${step}）`;
    }
  }
}

/** 网络抖动 / 后端重启这类瞬时错误：重连几次再说，不要一次失败就把整步判死 */
function autoFlowIsTransient(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /failed to fetch|fetch failed|networkerror|load failed|econnrefused|econnreset|timeout|请求失败|bad gateway|service unavailable/i.test(message);
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
  autoFlowClearWait();
  const state = autoFlowEnsure();
  const step = autoFlowStepOf(key);
  if (state.status[key] === "running") state.status[key] = "paused";
  if (step) autoFlowLog("warn", `${step.title} 已暂停，点「继续运行」从断点接着跑`);
  state.activeKey = null;
  autoFlowWrite();
  autoFlowSync();
  return true;
}

/**
 * 把后端的 zod issues / 网络错误翻成人话。
 * 以前直接把 `[{"code":"invalid_type","expected":"array",...}]` 原样写进流程事件，
 * 用户只看到一大段机器话，既读不懂也不知道该做什么。
 */
function autoFlowFriendlyError(message: string) {
  const raw = String(message || "").trim();
  if (!raw) return "未知错误";
  if (/"code"\s*:\s*"(invalid_type|invalid_enum_value|invalid_union|invalid_date|too_small|too_big|not_multiple_of)"/.test(raw)) {
    const code = /"code"\s*:\s*"([^"]+)"/.exec(raw)?.[1] || "";
    // path 是数组：以前只取第一段，导致 opportunities[13].searchReport.sourceAuthenticity
    // 被显示成「opportunities」，完全看不出错在哪一层。
    const pathSegments = (() => {
      const bracket = /"path"\s*:\s*(\[[^\]]*\])/.exec(raw);
      if (!bracket) return /"path"\s*:\s*"([^"]+)"/.exec(raw)?.[1] || "";
      return [...bracket[1].matchAll(/"([^"]*)"|(\d+)/g)]
        .map((item) => (item[2] !== undefined ? `[${item[2]}]` : `.${item[1]}`))
        .join("")
        .replace(/^\./, "");
    })();
    const expected = /"expected"\s*:\s*"([^"]+)"/.exec(raw)?.[1] || "";
    const received = /"received"\s*:\s*"([^"]+)"/.exec(raw)?.[1] || "";
    const options = [...(/"options"\s*:\s*\[([^\]]*)\]/.exec(raw)?.[1] || "").matchAll(/"([^"]+)"/g)].map((item) => item[1]);
    const zh = (value: string) =>
      value === "array" ? "列表"
        : value === "number" ? "数字"
          : value === "integer" ? "整数"
            : value === "string" ? "文本"
              : value === "object" ? "对象"
                : value === "boolean" ? "是/否"
                  : value === "nan" ? "非数字"
                    : value === "undefined" ? "缺失"
                      : value === "null" ? "空值"
                        : value;
    const suffix = "这一步没有产出，点「重试」会重新派单。";
    if (pathSegments) {
      if (code === "invalid_enum_value" || options.length) {
        return `CLI 返回的结果格式不对：「${pathSegments}」收到了不在允许范围内的取值 ${received || "（空）"}${options.length ? `（只能是 ${options.join(" / ")}）` : ""}。${suffix}`;
      }
      return `CLI 返回的结果格式不对：「${pathSegments}」应该是${zh(expected) || "约定的类型"}，实际是${zh(received) || "别的类型"}。${suffix}`;
    }
    return "CLI 返回的结果格式不符合约定，这一步没有产出，点「重试」会重新派单。";
  }
  if (/failed to fetch|fetch failed|networkerror|load failed|econnrefused|bad port/i.test(raw)) {
    return `连不上后端或网络中断（${raw.slice(0, 60)}）。确认本地服务在跑，再点「重试」。`;
  }
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}

function autoFlowFailStep(key: string, message: string) {
  autoFlowClearWait();
  const state = autoFlowEnsure();
  const step = autoFlowStepOf(key);
  // 失败不是暂停：没有在跑的任务，也不该保留进度百分数
  state.status[key] = "failed";
  state.progress[key] = 0;
  if (state.activeKey === key) state.activeKey = null;
  // 人工确认只对「那一次点击」有效：发送失败后重试必须重新确认。
  // 不清这个标志，重试就等于把剩余的信自动外发，用户根本没再看一眼。
  if (key === "send" && state.artifacts) state.artifacts.sendConfirmed = false;
  const reason = autoFlowFriendlyError(message);
  if (step) autoFlowLog("warn", `${step.title} 失败：${reason}（点「重试」重新开始这一步）`);
  else autoFlowLog("warn", reason);
  autoFlowWrite();
  autoFlowSync();
}

/**
 * 当前节点缺前置产出时，把「真正没产出的那一步」退回去并标成失败态，
 * 让停靠点的主按钮指回正确的一步。
 *
 * 不这样做的话，当前节点只会一遍遍报同一句错误（例如「没有草稿可发送」），
 * 而重试永远重跑当前节点，用户既没法继续也没法回上一步，只能卡死。
 */
function autoFlowRollbackTo(upstreamKey: string, reason: string) {
  const state = autoFlowEnsure();
  const upstreamIndex = AUTO_FLOW_STEPS.findIndex((step) => step.key === upstreamKey);
  if (upstreamIndex < 0) return;
  state.activeKey = null;
  // 上游之后的步骤（含当前步）一起退回：它们的完成状态同样不可信
  for (const step of AUTO_FLOW_STEPS.slice(upstreamIndex)) {
    state.status[step.key] = step.key === upstreamKey ? "failed" : "idle";
    state.progress[step.key] = 0;
  }
  const upstream = AUTO_FLOW_STEPS[upstreamIndex]!;
  autoFlowLog("warn", `${reason} 已退回第 ${upstreamIndex + 1} 步「${upstream.title}」，点「重试第 ${upstreamIndex + 1} 步」从这一步重新跑。`);
  autoFlowWrite();
  autoFlowSync();
  autoFlowRenderStage();
}

/**
 * 把第 N 步及其下游的产物整段作废。
 *
 * 「退回上一步」必须连产物一起清：只改状态的话，重跑这一步会命中各节点的「续跑」分支
 * （背调只补没背过的、写信只补没写过的、发送只发没发过的），看着点了重做，实际一条都不会重来。
 * 上游产物保留，因为它们本来就是这一步的输入。
 */
function autoFlowDropArtifactsFrom(key: string): string[] {
  const artifacts = autoFlowEnsure().artifacts!;
  const index = AUTO_FLOW_STEPS.findIndex((step) => step.key === key);
  if (index < 0) return [];
  const from = (target: string) => AUTO_FLOW_STEPS.findIndex((step) => step.key === target) >= index;
  const erased: string[] = [];
  if (from("prospect")) {
    if (artifacts.opportunities.length) erased.push(`候选 ${artifacts.opportunities.length} 家`);
    artifacts.opportunities = [];
    artifacts.selectedIds = undefined;
    artifacts.lfindTaskId = undefined;
    artifacts.parsed = null;
  }
  if (from("research")) {
    const count = Object.keys(artifacts.researched).length;
    if (count) erased.push(`背调 ${count} 家`);
    artifacts.researched = {};
  }
  if (from("compose")) {
    if (artifacts.drafts.length) erased.push(`草稿 ${artifacts.drafts.length} 封`);
    artifacts.drafts = [];
  }
  if (from("send")) {
    const count = artifacts.sent.filter((item) => item.ok).length;
    if (count) erased.push(`发信记录 ${count} 条`);
    artifacts.sent = [];
    artifacts.batchId = undefined;
    artifacts.pendingBatchId = undefined;
    artifacts.pendingBatchItems = undefined;
    artifacts.sendConfirmed = false;
  }
  return erased;
}

/**
 * 手动退回上一步执行。
 *
 * 失败停靠点原来只有两个出口：重试这一步（前提没变，多半再失败一次）、从头重新开始（前面白跑）。
 * 缺的是中间那个——「这一步的前提就不对」，比如背调全被判不匹配、想改关键词重搜；
 * 或者信写偏了，想补两条背调证据再来。
 */
function autoFlowStepBack(fromKey: string) {
  const fromIndex = AUTO_FLOW_STEPS.findIndex((step) => step.key === fromKey);
  if (fromIndex <= 0) return;
  const targetNo = fromIndex; // 目标步 = 第 (fromIndex) 步（1-based），即当前步的前一步
  const target = AUTO_FLOW_STEPS[fromIndex - 1]!;
  const artifacts = autoFlowEnsure().artifacts!;
  const willDrop: string[] = [];
  if (targetNo <= 1 && artifacts.opportunities.length) willDrop.push(`候选 ${artifacts.opportunities.length} 家`);
  if (targetNo <= 2 && Object.keys(artifacts.researched).length) willDrop.push(`背调 ${Object.keys(artifacts.researched).length} 家`);
  if (targetNo <= 3 && artifacts.drafts.length) willDrop.push(`草稿 ${artifacts.drafts.length} 封`);
  if (targetNo <= 4 && artifacts.sent.length) willDrop.push(`发信记录 ${artifacts.sent.length} 条`);
  const upstream = targetNo > 1 ? `第 1～${targetNo - 1} 步的产物保留。` : "";
  if (!window.confirm(
    `退回第 ${targetNo} 步「${target.title}」重做。\n\n`
    + `会清掉：${willDrop.length ? willDrop.join("、") : "（这一步及之后还没有产物）"}\n`
    + `${upstream ? `${upstream}\n` : ""}\n继续？`
  )) return;
  const state = autoFlowEnsure();
  autoFlowRunToken += 1;
  autoFlowStopTimers();
  autoFlowPauseRequested = false;
  autoFlowSendPending = false;
  autoFlowClearWait();
  const erased = autoFlowDropArtifactsFrom(target.key);
  state.activeKey = null;
  for (const step of AUTO_FLOW_STEPS.slice(fromIndex - 1)) {
    state.status[step.key] = "idle";
    state.progress[step.key] = 0;
  }
  // 已归档过的轮次重做后要能重新归档；后端按同一个 id 覆盖，不会刷出第二条
  state.archivedAt = undefined;
  autoFlowFocusKey = target.key;
  autoFlowFocusPinned = true;
  autoFlowMonitorData = null;
  autoFlowMonitorError = "";
  autoFlowInvalidateResults();
  autoFlowLog("warn", `已退回第 ${targetNo} 步「${target.title}」：${erased.length ? `${erased.join("、")}已作废` : "没有产物需要作废"}；改完条件后点「继续运行」从这一步重跑`);
  autoFlowWrite();
  autoFlowSync();
  autoFlowRenderStage();
}

function autoFlowBeginStep(key: string, resume = false) {
  const state = autoFlowEnsure();
  const step = autoFlowStepOf(key);
  if (!step) return;
  // 新一轮从第 1 步开跑：生成新的任务号与开始时间，跑完据此归档一条任务
  if (key === "prospect" && !state.runId) {
    state.runId = `afr_${crypto.randomUUID()}`;
    state.startedAt = new Date().toISOString();
    state.archivedAt = undefined;
  }
  if (autoFlowResultKey === "prospect" && qs<HTMLElement>("#afResult")?.dataset.mode === "pick") {
    window.setTimeout(() => { if (autoFlowResultKey === "prospect") autoFlowRenderPick(); }, 0);
  }
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
  if (autoFlowLiveToken && autoFlowLiveToken === autoFlowRunToken) return; // 执行器还在跑，只是页面重新渲染
  const step = autoFlowStepOf(key);
  if (step) void autoFlowExecuteStep(step);
}

/** 本页内正在跑的执行器令牌：切走再切回自动流页时不再重复启动同一步（以前会重复派单） */
let autoFlowLiveToken = 0;

async function autoFlowExecuteStep(step: AutoFlowStep) {
  const token = ++autoFlowRunToken;
  autoFlowLiveToken = token;
  try {
    if (step.key === "prospect") await autoFlowRunProspect(token);
    else if (step.key === "research") await autoFlowRunResearch(token);
    else if (step.key === "compose") await autoFlowRunCompose(token);
    else if (step.key === "send") await autoFlowRunSend(token);
    else if (step.key === "monitor") await autoFlowRunMonitor(token);
  } catch (error) {
    if (token !== autoFlowRunToken) return;
    autoFlowFailStep(step.key, error instanceof Error ? error.message : "执行失败");
  } finally {
    if (autoFlowLiveToken === token) autoFlowLiveToken = 0;
    if (token === autoFlowRunToken && !autoFlowEnsure().activeKey) autoFlowClearWait();
  }
}

function autoFlowCompleteStep(key: string) {
  const state = autoFlowEnsure();
  const step = autoFlowStepOf(key);
  state.status[key] = "done";
  state.progress[key] = 100;
  if (state.activeKey === key) state.activeKey = null;
  autoFlowInvalidateResults();
  autoFlowClearWait();
  autoFlowLog("done", `${step?.title || key} 完成：${step?.output || ""}`);
  autoFlowWrite();
  autoFlowSync();

  const next = AUTO_FLOW_STEPS.find((item) => state.status[item.key] !== "done");
  if (next && state.stepMode) {
    // 步进运行：停在这里，把这一步的产出展开给用户看，等「继续运行」
    autoFlowLog("warn", `步进运行：${step?.title || key} 已完成并停下，可在下方查看运行结果；点「继续运行」进入下一步「${next.title}」`);
    autoFlowWrite();
    autoFlowSync();
    void prefetchAutoFlowResults();
    if (key === "prospect" && state.artifacts!.opportunities.length) {
      // 第 1 步停下：直接展开本次候选清单，默认全选，用户勾掉不要的再交给背调
      autoFlowResultKey = null;
      void autoFlowToggleResult("prospect").then(() => {
        qs<HTMLElement>("#afResult")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    } else {
      qs<HTMLElement>("#afCheckpoint")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    return;
  }
  if (next) {
    autoFlowAdvanceTimer = window.setTimeout(() => {
      autoFlowAdvanceTimer = null;
      autoFlowBeginStep(next.key);
    }, AUTO_FLOW_GAP_MS);
    return;
  }
  autoFlowLog("done", "整条流水线跑完：候选已入池、确认过的信已发出。本轮会归档成一条任务，点右上角「任务归档」按任务看打开与回复");
  autoFlowFlash(qs<HTMLElement>("#afTrack"), "af-finale", 2600);
  autoFlowWrite();
  autoFlowSync();
  void autoFlowArchiveRun();
}

// ---------- 节点 1 · 获客：自然语言 → AI 解析 → Lfind 任务（本地 Runner → 本机 CLI） ----------
/** 轮询间隔：刚派单时 1 秒一查（排队/领取通常很快），之后逐步放宽，避免长任务一直高频请求 */
function autoFlowPollDelay(elapsedMs: number) {
  if (elapsedMs < 20_000) return 1_000;
  if (elapsedMs < 120_000) return 2_000;
  return AUTO_FLOW_POLL_MS;
}
/** 排队超过这么久仍没被领取，判定 Runner 不在工作，不再干等 */
const AUTO_FLOW_QUEUE_GIVE_UP_MS = 10 * 60_000;
/** 本机 CLI 执行上限（后端任务超时是 30 分钟，前端多留 2 分钟收尾） */
const AUTO_FLOW_RUN_GIVE_UP_MS = 32 * 60_000;

async function autoFlowRunProspect(token: number) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const goal = state.command.trim();
  if (!goal) throw new Error("先用一句话描述你要找的客户");
  autoFlowSetProgress("prospect", 4);

  if (!artifacts.lfindTaskId) {
    let parsed: AutoFlowArtifacts["parsed"];
    try {
      autoFlowSetWait("prospect", "AI 正在理解你的目标");
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
      autoFlowLog("done", `解析结果：产品 ${parsed.products.join("、") || "—"}，市场 ${parsed.markets.join("、") || "全球"}${parsed.name ? `，项目 ${parsed.name}` : ""}`);
    } catch (error) {
      if (token !== autoFlowRunToken) return;
      parsed = null;
      autoFlowLog("warn", `AI 解析失败（${error instanceof Error ? error.message : "未知错误"}），改用原句直接搜客`);
    }
    artifacts.parsed = parsed ?? null;
    autoFlowWrite();
    if (autoFlowPausePoint("prospect")) return;
    autoFlowSetProgress("prospect", 10);

    autoFlowSetWait("prospect", "正在把任务交给本机 Runner");
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
        limit: state.targetCount || AUTO_FLOW_TARGET_DEFAULT
      })
    }).catch((error) => {
      // 最常见的是没有在线 Runner（409）：把怎么处理一起说清楚
      const message = error instanceof Error ? error.message : "派单失败";
      throw new Error(/runner/i.test(message) ? `${message}。请在「集成中心 · 本地 Runner」启动并配对 Runner，确认显示在线后点「重试」。` : message);
    });
    if (token !== autoFlowRunToken) return;
    artifacts.lfindTaskId = created.task.id;
    artifacts.lfindParseRetry = undefined;
    artifacts.opportunities = [];
    autoFlowWrite();
    autoFlowLog("done", `搜客任务 ${created.task.id} 已交给本地 Runner，由本机 CLI 执行，目标 ${state.targetCount || AUTO_FLOW_TARGET_DEFAULT} 家`);
    autoFlowSetProgress("prospect", 14);
  }

  // 轮询任务到终态（刷新/重试后带着 lfindTaskId 直接回到这里）
  const taskId = artifacts.lfindTaskId!;
  const pollStarted = Date.now();
  let seenEvents = 0;
  let transientFailures = 0;
  let queuedHintLevel = 0;
  let runningSince = 0;
  let lastStatus = "";
  try {
    for (;;) {
      if (token !== autoFlowRunToken) return;
      if (autoFlowPausePoint("prospect")) return;
      let response: LfindTaskResponse;
      try {
        response = await api<LfindTaskResponse>(`/api/lead-finder/lfind-tasks/${encodeURIComponent(taskId)}`);
        transientFailures = 0;
      } catch (error) {
        if (token !== autoFlowRunToken) return;
        // 网络抖动、后端重启：最多连续重连 4 次（约 20 秒），任务在本机照常跑，不丢
        if (autoFlowIsTransient(error) && transientFailures < 4) {
          transientFailures += 1;
          autoFlowSetWait("prospect", `连接中断，第 ${transientFailures} 次重连`);
          if (transientFailures === 1) autoFlowLog("warn", "查询任务进度时连接中断，正在自动重连，本机任务不受影响");
          await autoFlowSleep(transientFailures * 2_000);
          continue;
        }
        throw error;
      }
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
            || "",
          country: item.country || "",
          website: item.website || "",
          business: item.business || item.description || "",
          contact: item.contact || "",
          source: item.sourceLabel || item.source || "",
          people: autoFlowPeopleOf(item)
        }));
        artifacts.selectedIds = undefined; // 新的一批候选：默认全选
      }

      const now = Date.now();
      const current = state.progress.prospect || 0;
      if (task.status === "queued") {
        // 排队：从派单（或开始轮询）算起
        const queuedFor = now - (Date.parse(task.createdAt) || pollStarted);
        autoFlowSetWait("prospect", "排队中，等本机 Runner 领取任务");
        if (queuedFor > 45_000 && queuedHintLevel < 1) {
          queuedHintLevel = 1;
          autoFlowLog("warn", "Runner 还没领取任务：确认电脑上的 GoodJob Runner 在运行、电脑没有休眠");
        }
        if (queuedFor > 180_000 && queuedHintLevel < 2) {
          queuedHintLevel = 2;
          autoFlowLog("warn", "已排队 3 分钟仍未被领取，可能 Runner 已离线；打开「集成中心 · 本地 Runner」看它的在线状态");
        }
        if (queuedFor > AUTO_FLOW_QUEUE_GIVE_UP_MS) {
          artifacts.lfindTaskId = undefined;
          autoFlowWrite();
          throw new Error("排队 10 分钟没有 Runner 领取任务。请在「集成中心 · 本地 Runner」确认 Runner 在线后点「重试」");
        }
        autoFlowSetProgress("prospect", Math.max(current, 14 + 8 * (1 - Math.exp(-queuedFor / 60_000))));
      } else if (task.status === "running" || task.status === "cancelling") {
        if (lastStatus !== task.status && task.status === "running") autoFlowLog("start", "本机 CLI 已开始搜客");
        runningSince = runningSince || Date.parse(task.startedAt) || now;
        const runFor = now - runningSince;
        autoFlowSetWait("prospect", task.status === "cancelling" ? "任务正在取消" : "本机 CLI 正在搜客", events.length && task.status !== "cancelling" ? `，已收到 ${events.length} 条进度` : "");
        if (runFor > AUTO_FLOW_RUN_GIVE_UP_MS) {
          artifacts.lfindTaskId = undefined;
          autoFlowWrite();
          throw new Error("本机 CLI 搜客超过 30 分钟仍未结束，已停止等待。可在「集成中心」查看这次执行记录，或换个更具体的描述后重试");
        }
        // 时间推进 + 进度事件一起推进度，最多到 92%，剩下的留给结果入池
        const byTime = 70 * (1 - Math.exp(-runFor / 240_000));
        autoFlowSetProgress("prospect", Math.max(current, Math.min(92, 22 + byTime + events.length * 2)));
      }
      lastStatus = task.status;

      if (["succeeded", "failed", "cancelled"].includes(task.status)) {
        const stats = response.incrementalStats;
        const skipped = Array.isArray(response.skipped) ? response.skipped.length : Number(response.skipped) || 0;
        if (task.status !== "succeeded" || !artifacts.opportunities.length) {
          const reason = response.lfind?.summary?.noResultReason || task.errorMessage || `任务 ${task.status}`;
          // 查重已从 CLI 提示词移回后端（2026-11-22）：跑成功但一条新候选都没有时，
          // 真实原因通常是「这个市场上一轮已经搜过」，而不是 CLI 失败。给出可执行的下一步。
          const duplicateHint = task.status === "succeeded" && (stats?.unchangedCount || stats?.existingFilteredCount)
            ? `本轮没有新增候选：${stats?.unchangedCount || 0} 家与历史候选重复，${stats?.existingFilteredCount || 0} 家已在客户库或线索库。这个市场可能已经搜过，换个市场、产品或更具体的行业描述再试。`
            : "";
          // 终态任务不能复用：清掉任务号与候选，下一次「重试」会重新提交。
          // 否则瞬时故障（429 额度、超时）会把这个坏任务号永久钉在状态里，重试永远卡在同一处。
          artifacts.lfindTaskId = undefined;
          artifacts.opportunities = [];
          autoFlowWrite();
          throw new Error(duplicateHint || `没有候选入池（原始 ${response.lfind?.summary?.rawFound ?? 0} 条）：${reason}`);
        }
        autoFlowSetProgress("prospect", 100);
        const mergedEvidence = stats?.evidenceUpdatedCount || 0;
        const duplicateHistory = stats?.unchangedCount || 0;
        const duplicateExisting = stats?.existingFilteredCount || 0;
        autoFlowLog(
          "done",
          `本轮新增 ${artifacts.opportunities.length} 家候选`
          + (mergedEvidence ? `，${mergedEvidence} 家补到新来源证据` : "")
          + (duplicateHistory ? `；${duplicateHistory} 家与历史候选重复，已合并` : "")
          + (duplicateExisting ? `；${duplicateExisting} 家已在客户库/线索库，已跳过` : "")
          + (skipped ? `；共过滤 ${skipped} 条` : "")
          + `，用时 ${autoFlowClock(Date.now() - pollStarted)}`
        );
        autoFlowResults = {};
        artifacts.lfindParseRetry = undefined;
        autoFlowCompleteStep("prospect");
        return;
      }
      await autoFlowSleep(autoFlowPollDelay(Date.now() - pollStarted));
    }
  } catch (error) {
    // 🔴 关键：查询本身就抛错时（典型是结果字段不合 schema 的 422），原来只有"终态分支"会清任务号，
    // 抛错路径走不到那里 → lfindTaskId 被永久钉住 → 每点一次「继续运行」都拿同一个坏任务去查、
    // 每次都秒失败，界面永远停在 4%，后端一条新任务都不会派。这就是"运行不起来"的根因。
    //
    // 2026-11-22 补充：格式不符（zod invalid_*）与「任务本身失败」要分开处理。
    // 前者往往已经跑完并产出了几十家候选（实测 57KB / 20 家），直接丢任务号等于把
    // 3 分钟搜索和额度一起扔掉。所以第一次格式失败保留任务号，复用一次；再失败才重新派单。
    const failureText = error instanceof Error ? error.message : String(error || "");
    const parseFailure = /"code"\s*:\s*"invalid_/.test(failureText) || failureText.includes("LFIND_RESULT_INVALID");
    if (artifacts.lfindTaskId === taskId) {
      if (parseFailure && !artifacts.lfindParseRetry) {
        artifacts.lfindParseRetry = true;
        autoFlowWrite();
        autoFlowLog("warn", "结果格式不对，但任务本身已经跑完。这次结果先留着：点「重试第 1 步」会直接复用这份结果重新解析，不会重跑 CLI");
        throw error;
      }
      artifacts.lfindTaskId = undefined;
      artifacts.lfindParseRetry = undefined;
      artifacts.opportunities = [];
      autoFlowWrite();
      autoFlowLog("warn", "已丢弃这个任务号：下次重试会重新派单，不会卡在同一处");
    }
    throw error;
  }
}

/** 有上限的并发工作池：AI API 模式下加速背调与写信，本机 CLI 保持串行 */
async function autoFlowRunPool<T>(
  items: T[],
  concurrency: number,
  shouldStop: () => boolean,
  worker: (item: T, index: number) => Promise<void>
) {
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      if (shouldStop()) return;
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
}

// ---------- 节点 2 · 背调：引擎 CLI / AI，逐家出证据 ----------
async function autoFlowRunResearch(token: number) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const targets = autoFlowSelectedCandidates();
  if (!artifacts.opportunities.length) {
    autoFlowRollbackTo("prospect", "背调需要候选，但第 1 步「获客」没有留下任何候选。");
    return;
  }
  if (!targets.length) throw new Error("第 1 步的候选一家都没勾选，回到「获客」的结果里勾选后再继续");
  const source = effectiveResearchSource();
  const concurrency = source === "ai" ? 3 : 1;
  autoFlowLog("start", `对勾选的 ${targets.length} 家候选做背调（执行方式：${source === "cli" ? "本机 CLI" : source === "ai" ? "AI 模型 · 3 并发" : "本地"}）`);
  let doneCount = targets.filter((target) => artifacts.researched[target.id] !== undefined).length;
  const pendingTargets = targets.filter((target) => artifacts.researched[target.id] === undefined);

  await autoFlowRunPool(
    pendingTargets,
    concurrency,
    () => token !== autoFlowRunToken || autoFlowPauseRequested,
    async (target) => {
      if (token !== autoFlowRunToken || autoFlowPausePoint("research")) return;
      autoFlowLog("start", `背调 ${target.company}…`);
      autoFlowSetWait("research", `正在背调（已完成 ${doneCount}/${targets.length}）：${target.company}`);
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
          autoFlowSetWait("research", `本机 CLI 正在调研（已完成 ${doneCount}/${targets.length}）：${target.company}`);
          const payload = await awaitAiEngineJob(first.engineJob);
          if (token !== autoFlowRunToken) return;
          research = (payload.research || null) as { score: number; verdict: string; sources?: unknown[] } | null;
        }
        if (research) {
          const full = research as unknown as BackgroundResearch;
          autoFlowReports.set(target.id, full);
          const candidate = artifacts.opportunities.find((item) => item.id === target.id);
          if (candidate) autoFlowMergeResearch(candidate, full);
          artifacts.researched[target.id] = { score: Number(research.score || 0), verdict: String(research.verdict || ""), summary: String(full.summary || "").slice(0, 400) };
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
      doneCount += 1;
      autoFlowWrite();
      autoFlowSetProgress("research", Math.round((doneCount / targets.length) * 100));
    }
  );
  if (token !== autoFlowRunToken || autoFlowPausePoint("research")) return;
  const okCount = targets.filter((target) => artifacts.researched[target.id]).length;
  if (!okCount) throw new Error("本轮背调全部失败，请检查引擎配置后重试");
  autoFlowLog("done", `背调完成 ${okCount}/${targets.length} 家，够格进写信`);
  autoFlowResults = {};
  autoFlowCompleteStep("research");
}

// ---------- 节点 3 · 写信：引用背调结论逐家出草稿 ----------
async function autoFlowRunCompose(token: number) {
  const state = autoFlowEnsure(), artifacts = state.artifacts!;
  const targets = artifacts.opportunities.filter((item) => artifacts.researched[item.id]);
  if (!targets.length) {
    if (!artifacts.opportunities.length) {
      autoFlowRollbackTo("prospect", "写信需要候选，但第 1 步「获客」没有留下任何候选。");
    } else {
      autoFlowRollbackTo("research", "写信需要背调结论，但这一轮没有一家通过背调。");
    }
    return;
  }
  artifacts.drafts = artifacts.drafts.filter((draft) => targets.some((target) => target.id === draft.prospectId));
  const pendingTargets = targets.filter((target) => !artifacts.drafts.some((draft) => draft.prospectId === target.id));
  let doneCount = targets.length - pendingTargets.length;
  await autoFlowRunPool(pendingTargets, effectiveResearchSource() === "ai" ? 3 : 1, () => token !== autoFlowRunToken || autoFlowPauseRequested, async (target) => {
    if (token !== autoFlowRunToken || autoFlowPausePoint("compose")) return;
    autoFlowLog("start", `为 ${target.company} 写信…`);
    autoFlowSetWait("compose", `正在写信 ${doneCount}/${targets.length}：${target.company}`);
    const generated = await autoFlowGenerateDraft(target, artifacts.composeGoal || "", () => {
      autoFlowLog("start", `${target.company} 由本机 CLI 撰写…`);
      autoFlowSetWait("compose", `CLI 写信 ${doneCount}/${targets.length}：${target.company}`);
    });
    if (token !== autoFlowRunToken) return;
    const draft = generated?.draft || null, engineNote = generated?.engineNote || "";
    if (draft?.subject && draft?.body) {
      artifacts.drafts.push({ prospectId: target.id, company: target.company, to: target.email, subject: draft.subject, body: draft.body, engineNote });
      if (!target.email) autoFlowLog("warn", `${target.company} 暂无可用邮箱，草稿先备着，发送前需去搜客清单补联系方式`);
      autoFlowLog("done", `${target.company} 草稿就绪（${engineNote}）：${draft.subject}`);
    } else {
      autoFlowLog("warn", `${target.company} 没有拿到草稿，跳过`);
    }
    doneCount += 1;
    autoFlowWrite();
    autoFlowSetProgress("compose", Math.round((doneCount / targets.length) * 100));
  });
  if (token !== autoFlowRunToken || autoFlowPausePoint("compose")) return;
  if (!artifacts.drafts.length) throw new Error("一封草稿都没写成，请检查写信引擎配置");
  autoFlowLog("done", `${artifacts.drafts.length} 封草稿就绪，发送前需要人工确认`);
  autoFlowResults = {};
  autoFlowCompleteStep("compose");
}

/** 写一封（或按要求重写一封）开发信：AI API 直接返回，走本机 CLI 时等引擎作业 */
async function autoFlowGenerateDraft(target: AutoFlowCandidate, goal: string, onCli?: () => void) {
  const result = await api<{
    draft: { subject: string; body: string } | null;
    pending?: boolean;
    engineJob?: AiEngineJobView;
    readiness?: { aiGenerated: boolean; aiError: string };
  }>("/api/development-email/draft", {
    method: "POST",
    body: JSON.stringify({ entityType: "prospect", entityId: target.id, scenario: "first_touch", goal: goal.trim().slice(0, 1000) })
  });
  let draft = result.draft;
  let engineNote = result.readiness?.aiGenerated ? "AI 生成" : "模板";
  if (!draft && result.pending && result.engineJob) {
    onCli?.();
    const payload = await awaitAiEngineJob(result.engineJob);
    draft = (payload.draft || null) as { subject: string; body: string } | null;
    engineNote = "本机 CLI";
  }
  return draft?.subject && draft?.body ? { draft, engineNote } : null;
}

// ---------- 开发信：查看、手改、按要求让 AI 重写 ----------
function autoFlowDraftLocked(draft: AutoFlowDraftItem) {
  return autoFlowEnsure().artifacts!.sent.some((item) => item.ok && item.to === draft.to && item.subject === draft.subject);
}

function autoFlowWordCount(text: string) {
  return (text.match(/[A-Za-zÀ-ÿ0-9'’-]+/g) || []).length;
}

/** 正文去掉落款后的词数（落款不算长度） */
function autoFlowBodyWords(body: string) {
  const cut = body.search(/\n\s*(best regards|kind regards|regards|sincerely|thanks|thank you)[,!.]?\s*\n/i);
  return autoFlowWordCount(cut > 0 ? body.slice(0, cut) : body);
}

function autoFlowDraftsHtml(step: AutoFlowStep) {
  const artifacts = autoFlowEnsure().artifacts!;
  const drafts = artifacts.drafts;
  const busy = autoFlowRegenBusy;
  const cards = drafts.map((draft, index) => {
    const locked = autoFlowDraftLocked(draft);
    const words = autoFlowBodyWords(draft.body);
    const preview = draft.body.split(/\n+/).filter((line) => line.trim() && !/^(dear|hi|hello)\b/i.test(line.trim())).slice(0, 3).join(" ");
    return `
      <li class="af-mail" data-af-draft="${escapeHtml(draft.prospectId)}" tabindex="0" role="button" style="--r:${index}" aria-label="查看并编辑写给 ${escapeHtml(draft.company)} 的信">
        <div class="af-mail-top">
          <b>${escapeHtml(draft.company)}</b>
          <span class="af-mail-to" data-ok="${draft.to ? "1" : "0"}">${escapeHtml(draft.to || "缺收件邮箱")}</span>
        </div>
        <p class="af-mail-subject">${escapeHtml(draft.subject)}</p>
        <p class="af-mail-preview">${escapeHtml(preview)}</p>
        <div class="af-mail-foot">
          <span>${words} 词</span>
          <span>${escapeHtml(draft.edited ? "已手动修改" : draft.engineNote)}</span>
          ${locked ? '<em class="ok">已发出</em>' : '<span class="af-mail-edit">查看 / 编辑</span>'}
        </div>
      </li>`;
  }).join("");
  return `
    <div class="af-result-h">
      <b>「${escapeHtml(step.title)}」的产出 <span>${drafts.length} 封，点开可以查看全文、修改或让 AI 重写</span></b>
      <span class="af-result-tools">
        <button class="link" type="button" data-open="${escapeHtml(step.view)}">打开${escapeHtml(step.viewLabel)}</button>
        <button class="af-result-close" type="button" data-af-close aria-label="收起结果">收起</button>
      </span>
    </div>
    <div class="af-goal">
      <label for="afComposeGoal">写信要求</label>
      <textarea id="afComposeGoal" rows="2" maxlength="1000" placeholder="例：重点讲我们能帮他们减少称重误差带来的返工；语气直接；正文 80 词以内；结尾约一个 15 分钟电话">${escapeHtml(artifacts.composeGoal || "")}</textarea>
      <div class="af-goal-row">
        <span>AI 会结合每家公司的背调，找一个最痛的点来写；不会写进对方的联系方式、背调评分这类信息。</span>
        <button class="btn primary" type="button" data-af-regen-all ${drafts.length && !busy ? "" : "disabled"}>${busy ? escapeHtml(busy) : `按这个要求重写全部 ${drafts.filter((draft) => !autoFlowDraftLocked(draft)).length} 封`}</button>
      </div>
    </div>
    ${drafts.length ? `<ul class="af-mails">${cards}</ul>` : '<div class="af-result-empty">这一步本次还没有写出信。可以先填写上面的要求，第 3 步会按它来写。</div>'}`;
}

let autoFlowRegenBusy = "";

async function autoFlowRegenerateAll() {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  if (autoFlowRegenBusy) return;
  if (state.activeKey) {
    toast("流水线正在运行，等这一步停下后再重写", "error");
    return;
  }
  const goalInput = qs<HTMLTextAreaElement>("#afComposeGoal");
  if (goalInput) artifacts.composeGoal = goalInput.value.trim();
  autoFlowWrite();
  const targets = artifacts.drafts.filter((draft) => !autoFlowDraftLocked(draft));
  if (!targets.length) return;
  let done = 0;
  let failed = 0;
  autoFlowLog("start", `按要求重写 ${targets.length} 封开发信${artifacts.composeGoal ? `：${artifacts.composeGoal.slice(0, 60)}` : ""}`);
  for (const draft of targets) {
    autoFlowRegenBusy = `正在重写 ${done + failed + 1}/${targets.length}：${draft.company}`;
    autoFlowSetWait("compose", autoFlowRegenBusy);
    autoFlowRefreshDraftsPanel();
    const candidate = artifacts.opportunities.find((item) => item.id === draft.prospectId);
    try {
      const generated = candidate ? await autoFlowGenerateDraft(candidate, artifacts.composeGoal || "") : null;
      if (!generated) throw new Error("没有拿到新稿");
      Object.assign(draft, { subject: generated.draft.subject, body: generated.draft.body, engineNote: generated.engineNote, edited: false });
      done += 1;
    } catch (error) {
      failed += 1;
      autoFlowLog("warn", `${draft.company} 重写失败：${error instanceof Error ? error.message : "未知错误"}，保留原稿`);
    }
    autoFlowWrite();
  }
  autoFlowRegenBusy = "";
  autoFlowClearWait();
  autoFlowInvalidateResults();
  autoFlowLog("done", `重写完成 ${done} 封${failed ? `，${failed} 封失败保留原稿` : ""}`);
  autoFlowWrite();
  autoFlowSync();
  autoFlowRenderStage();
  autoFlowRefreshDraftsPanel(true);
  toast(failed ? `重写完成 ${done} 封，${failed} 封失败` : `已按要求重写 ${done} 封`, failed ? "error" : undefined);
}

/** 结果区正显示信件列表时重画（保留要求输入框里正在打的字） */
function autoFlowRefreshDraftsPanel(force = false) {
  const box = qs<HTMLElement>("#afResult");
  if (!box || box.hidden || box.dataset.mode !== "drafts") return;
  const step = autoFlowStepOf(autoFlowResultKey);
  if (!step) return;
  const typing = qs<HTMLTextAreaElement>("#afComposeGoal");
  const value = typing?.value;
  const focused = document.activeElement === typing;
  box.innerHTML = autoFlowDraftsHtml(step);
  const next = qs<HTMLTextAreaElement>("#afComposeGoal");
  if (next && value !== undefined && !force) next.value = value;
  if (next && focused) next.focus();
}

function openAutoFlowDraftEditor(prospectId: string) {
  const artifacts = autoFlowEnsure().artifacts!;
  const draft = artifacts.drafts.find((item) => item.prospectId === prospectId);
  if (!draft) return;
  const locked = autoFlowDraftLocked(draft);
  const candidate = artifacts.opportunities.find((item) => item.id === prospectId);
  const person = candidate?.people?.[0];
  openModal(`写给 ${draft.company} 的开发信`, `
    <div class="af-ed">
      <div class="af-ed-meta">
        <label><span>收件人</span><input id="afEdTo" type="email" value="${escapeHtml(draft.to)}" ${locked ? "disabled" : ""} placeholder="name@company.com"></label>
        ${person ? `<p class="af-ed-person">关键人：${escapeHtml(person.name || "（未署名）")}${person.title ? `，${escapeHtml(person.title)}` : ""}${person.email && person.email !== draft.to ? `　<button type="button" class="af-ed-use" data-email="${escapeHtml(person.email)}">改发给 ${escapeHtml(person.email)}</button>` : ""}</p>` : ""}
      </div>
      <label class="af-ed-field"><span>主题</span><input id="afEdSubject" value="${escapeHtml(draft.subject)}" maxlength="160" ${locked ? "disabled" : ""}></label>
      <label class="af-ed-field"><span>正文 <b id="afEdWords">${autoFlowBodyWords(draft.body)} 词</b></span><textarea id="afEdBody" rows="14" ${locked ? "disabled" : ""}>${escapeHtml(draft.body)}</textarea></label>
      ${locked ? '<p class="af-ed-locked">这封信已经发出，只能查看。</p>' : `
      <div class="af-ed-ai">
        <label for="afEdGoal">让 AI 按要求重写这一封</label>
        <div class="af-ed-ai-row">
          <input id="afEdGoal" maxlength="500" placeholder="例：开头直接讲他们给粮食客户做水分检测的痛点；更短一点" value="${escapeHtml(artifacts.composeGoal || "")}">
          <button class="btn" type="button" id="afEdRegen">AI 重写</button>
        </div>
        <p class="af-ed-hint" id="afEdHint">重写后会替换上面的主题和正文，保存前都可以再改。</p>
      </div>`}
    </div>`, locked
    ? '<button class="btn primary" type="button" data-modal-close>关闭</button>'
    : '<button class="btn" type="button" data-modal-close>取消</button><button class="btn primary" type="button" id="afEdSave">保存修改</button>', { modalClass: "af-report-modal", description: candidate ? `${candidate.country || ""}${candidate.website ? `　${autoFlowDomain(candidate.website)}` : ""}`.trim() : "" });
  if (locked) return;
  const bodyEl = qs<HTMLTextAreaElement>("#afEdBody");
  const wordsEl = qs<HTMLElement>("#afEdWords");
  bodyEl?.addEventListener("input", () => { if (wordsEl) wordsEl.textContent = `${autoFlowBodyWords(bodyEl.value)} 词`; });
  qs<HTMLButtonElement>(".af-ed-use")?.addEventListener("click", (event) => {
    const to = qs<HTMLInputElement>("#afEdTo");
    if (to) to.value = (event.currentTarget as HTMLButtonElement).dataset.email || to.value;
  });
  qs<HTMLButtonElement>("#afEdRegen")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const hint = qs<HTMLElement>("#afEdHint");
    if (!candidate) return;
    button.disabled = true;
    button.textContent = "重写中…";
    if (hint) { hint.textContent = "AI 正在结合背调重写这一封…"; hint.dataset.state = "busy"; }
    try {
      const goal = qs<HTMLInputElement>("#afEdGoal")?.value || "";
      const generated = await autoFlowGenerateDraft(candidate, goal, () => { if (hint) hint.textContent = "已交给本机 CLI 重写，通常需要 30 秒到 2 分钟…"; });
      if (!generated) throw new Error("没有拿到新稿");
      const subject = qs<HTMLInputElement>("#afEdSubject");
      if (subject) subject.value = generated.draft.subject;
      if (bodyEl) { bodyEl.value = generated.draft.body; bodyEl.dispatchEvent(new Event("input")); }
      button.dataset.engine = generated.engineNote;
      if (hint) { hint.textContent = `已重写（${generated.engineNote}），点「保存修改」才会替换原稿。`; hint.dataset.state = "ok"; }
    } catch (error) {
      if (hint) { hint.textContent = `重写失败：${error instanceof Error ? error.message : "未知错误"}`; hint.dataset.state = "error"; }
    } finally {
      button.disabled = false;
      button.textContent = "AI 重写";
    }
  });
  qs<HTMLButtonElement>("#afEdSave")?.addEventListener("click", () => {
    const to = (qs<HTMLInputElement>("#afEdTo")?.value || "").trim();
    const subject = (qs<HTMLInputElement>("#afEdSubject")?.value || "").trim();
    const body = (bodyEl?.value || "").trim();
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { toast("收件邮箱格式不对", "error"); return; }
    if (!subject || !body) { toast("主题和正文都不能为空", "error"); return; }
    const regenEngine = qs<HTMLButtonElement>("#afEdRegen")?.dataset.engine;
    const changed = to !== draft.to || subject !== draft.subject || body !== draft.body;
    Object.assign(draft, { to, subject, body });
    if (regenEngine) { draft.engineNote = regenEngine; draft.edited = false; }
    if (changed && !regenEngine) draft.edited = true;
    if (candidate && to && !candidate.email) candidate.email = to;
    autoFlowWrite();
    closeModal();
    autoFlowInvalidateResults();
    autoFlowSync();
    autoFlowRenderStage();
    autoFlowRefreshDraftsPanel(true);
    toast("开发信已保存");
  });
}

// ---------- 节点 4 · 发送：人工确认后才真发，资格门禁如实记账 ----------
async function autoFlowRunSend(token: number) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const alreadySent = new Set(artifacts.sent.map((item) => `${item.to}|${item.subject}`));
  const drafts = artifacts.drafts.filter((draft) => draft.to && !alreadySent.has(`${draft.to}|${draft.subject}`));
  if (!artifacts.drafts.length) {
    autoFlowRollbackTo("compose", "发送需要草稿，但第 3 步「写信」一封都没写出来。");
    return;
  }
  if (!drafts.length) {
    autoFlowLog("warn", "草稿都缺收件邮箱，发送节点跳过；请去搜客清单补联系方式");
    autoFlowCompleteStep("send");
    return;
  }
  autoFlowAssertSenderReady();
  if (!artifacts.sendConfirmed) {
    autoFlowSendPending = true;
    state.status.send = "paused";
    if (state.activeKey === "send") state.activeKey = null;
    autoFlowLog("warn", `发送前需人工确认：共 ${drafts.length} 封，发信身份「${autoFlowSenderLabel()}」。核对详情区列表后点「确认发送」`);
    autoFlowWrite();
    autoFlowSync();
    autoFlowRenderStage();
    return;
  }
  autoFlowSendPending = false;
  autoFlowLog("start", `已确认，按防风控随机间隔发送 ${drafts.length} 封（发信身份：${autoFlowSenderLabel()}）…`);
  autoFlowSetWait("send", `正在发送 ${drafts.length} 封`);
  // 轮换基准：本轮开始前已经成功发过几封（循环里 values 会变，必须先在循环外取）
  const sentOkBefore = artifacts.sent.filter((item) => item.ok).length;
  const archivedBatchItems: Array<{
    prospectId: string;
    company: string;
    to: string;
    subject: string;
    body: string;
    sentAt: string;
    requestId: string;
  }> = [];
  let consecutiveFailures = 0;

  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    const senderEmail = autoFlowSenderForIndex(index, sentOkBefore);
    if (token !== autoFlowRunToken) return;
    if (autoFlowPausePoint("send")) return;
    const requestId = `auto-flow:${crypto.randomUUID()}`;
    try {
      await api("/api/development-email/send", {
        method: "POST",
        body: JSON.stringify({
          entityType: "prospect",
          entityId: draft.prospectId,
          to: draft.to,
          subject: draft.subject,
          body: draft.body,
          requestId,
          ...(senderEmail ? { senderEmail } : {})
        })
      });
      consecutiveFailures = 0;
      const sentAt = new Date().toISOString();
      artifacts.sent.push({ to: draft.to, subject: draft.subject, ok: true, note: "已进入发件台账" });
      archivedBatchItems.push({
        prospectId: draft.prospectId,
        company: draft.company,
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        sentAt,
        requestId
      });
      autoFlowLog("done", `已发送：${draft.company} <${draft.to}> · ${draft.subject}${senderEmail ? `（发件：${senderEmail}）` : ""}`);
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : "发送失败";
      artifacts.sent.push({ to: draft.to, subject: draft.subject, ok: false, note: message });
      autoFlowLog("warn", `发送被拦下：${draft.company} · ${message}`);

      const isRiskOrSmtpError = /上限|停用|smtp|auth|535|550|554|spam|rate|quota|退信|blacklist/i.test(message);
      if ((isRiskOrSmtpError && consecutiveFailures >= 2) || consecutiveFailures >= 3) {
        state.status.send = "paused";
        state.activeKey = null;
        autoFlowLog("warn", `触发风控熔断：连续 ${consecutiveFailures} 封发送失败（${message}），已自动暂停发送，请检查发件邮箱状态后再点「继续运行」`);
        autoFlowWriteNow();
        autoFlowSync();
        autoFlowRenderStage();
        toast("连续发信失败，已自动暂停防风控", "error");
        return;
      }
    }
    autoFlowWrite();
    autoFlowSetProgress("send", Math.round(((index + 1) / drafts.length) * 100));

    // 每封之间加 3~8 秒随机抖动间隔（最后一封不等待）
    if (index < drafts.length - 1) {
      const jitterMs = 3_000 + Math.floor(Math.random() * 5_000);
      autoFlowSetWait("send", `防风控间隔 ${Math.round(jitterMs / 1000)}s，准备发第 ${index + 2}/${drafts.length} 封`);
      await autoFlowSleep(jitterMs);
    }
  }

  // 发送完成后归档为标准发信批次，自动触发后端 Excel 邮件总结 + 企业微信通知
  if (archivedBatchItems.length) {
    // 先把「待归档明细 + 预生成批次号」落盘：这次归档失败时，监控节点还能用同一批次号重试
    if (!artifacts.pendingBatchId) artifacts.pendingBatchId = `afb_${crypto.randomUUID()}`;
    artifacts.pendingBatchItems = archivedBatchItems;
    autoFlowWrite();
    try {
      const archived = await api<{ batchId?: string }>("/api/auto-flow/complete-send", {
        method: "POST",
        body: JSON.stringify({
          // 客户端带上批次号：重试同一批不会在归档里多出一条空批次
          batchId: artifacts.pendingBatchId,
          items: archivedBatchItems,
          // 失败封数只用于企业微信「本轮已发完」的文案，不参与归档统计
          failed: Math.max(0, drafts.length - archivedBatchItems.length)
        })
      });
      // 记住批次号：任务归档后，打开 / 点击 / 回复都按 `batch:<id>:` 前缀实时统计
      if (archived?.batchId) {
        artifacts.batchId = archived.batchId;
        // 归档成功：待归档明细可以清掉，别让缓存里一直压着一批正文
        artifacts.pendingBatchId = undefined;
        artifacts.pendingBatchItems = undefined;
      }
    } catch {
      // 归档失败不影响已发信台账；留给第 5 步「数据监控」用同一批次号重试
    }
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
    else void autoFlowArchiveRun();
    return;
  }
  if (state.artifacts) state.artifacts.sendConfirmed = true;
  autoFlowWrite();
  autoFlowBeginStep("send", true);
}

// ===========================================================================
// 任务归档：跑完一轮自动存一条，之后切换任务看这一批的打开 / 回复
//
// 「回复监控」原来被当成流水线第 5 步，其实是错的：第 4 步发完信，这一轮就结束了；
// 回信要等几小时到几天。所以改成「跑完归档一次」，归档里按批次台账实时统计打开与回复。
// ===========================================================================
interface AutoFlowEngagement {
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  openRate: number;
}

interface AutoFlowRunArchiveView {
  id: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  targetCount: number;
  counts: { candidates: number; researched: number; drafts: number; sent: number };
  batchId: string;
  senderEmail?: string;
  status: "sent" | "draft_only" | "partial";
  engagement: AutoFlowEngagement;
}

interface AutoFlowRunRow {
  to: string;
  subject: string;
  sentAt: string;
  dispatchStatus: string;
  openCount: number;
  clickCount: number;
  firstOpenedAt: string;
  lastOpenedAt: string;
  repliedAt: string;
  bouncedAt: string;
}

const EMPTY_ENGAGEMENT: AutoFlowEngagement = { sent: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, openRate: 0 };

// ---------------------------------------------------------------------------
// 通知总结：企业微信「本轮已发完」/ 发送总结邮件 / 打开回复统一刷新
// ---------------------------------------------------------------------------
interface AutoFlowNotifyDelivery {
  senderEmail: string;
  status: "sent" | "failed";
  at: string;
  fileName: string;
  messageId: string;
  error: string;
  attempts: number;
  customers: number;
  letters: number;
}

interface AutoFlowNotifyView {
  runId: string;
  batchId: string;
  senderEmail: string;
  wecom: {
    configured: boolean;
    enabled: boolean;
    mode: "app" | "robot";
    recipients: string[];
    ruleOn: boolean;
    entry: { at: string; title: string; recipients: string; status: "sent" | "failed" | "skipped"; message: string } | null;
  };
  email: {
    autoSend: boolean;
    updatedAt: string;
    deliveries: AutoFlowNotifyDelivery[];
    sent: number;
    failed: number;
  };
}

let autoFlowNotify: AutoFlowNotifyView | null = null;
let autoFlowNotifyLoading = false;
let autoFlowNotifyExtraOpen = false;
/** 推送是异步的：每轮只补查一次（不是轮询线程），避免刚发完就一直停在「等待推送」 */
const autoFlowNotifyRetried = new Set<string>();
/** 打开 / 回复只有一个刷新线程：所有任务共用这一条，不按任务开定时器 */
const AUTO_FLOW_MONITOR_INTERVAL_MS = 30_000;
let autoFlowMonitorTimer: number | null = null;
let autoFlowMonitorTicking = false;
let autoFlowMonitorLastAt = 0;
let autoFlowMonitorVisibilityBound = false;

let autoFlowRuns: AutoFlowRunArchiveView[] = [];
let autoFlowRunsLoaded = false;
let autoFlowRunsLoading = false;
let autoFlowSelectedRunId = "";
let autoFlowRunDetail: { id: string; rows: AutoFlowRunRow[] } | null = null;
let autoFlowRunDetailLoading = false;

function autoFlowArchiveWhen(value: string) {
  const at = Date.parse(value || "");
  if (!Number.isFinite(at)) return "—";
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 每一轮任务存一条归档（同一轮只存一次）。
 * reason=finished：四步跑完或跳过发送；reason=abandoned：中途重置/重开，也要留档，不能这一轮白跑。
 */
async function autoFlowArchiveRun(reason: "finished" | "abandoned" = "finished", snapshot?: AutoFlowState) {
  // 重置会先归档、再立刻把全局状态换成空白的下一轮：调用方必须把「要归档的那一轮」按快照传进来，
  // 否则异步走到这里时读到的已经是新状态，归档出来是一条空记录（或者干脆被 if (!runId) 挡掉）。
  const state = snapshot || autoFlowEnsure();
  const artifacts = state.artifacts!;
  const runId = state.runId;
  if (!runId) return;
  if (state.archivedAt === runId) return;
  // 快照归档时不要把 archivedAt 写回全局状态：那一轮已经被换下去了
  const isSnapshot = Boolean(snapshot);
  const counts = {
    candidates: artifacts.opportunities.length,
    researched: Object.values(artifacts.researched).filter(Boolean).length,
    drafts: artifacts.drafts.length,
    sent: artifacts.sent.filter((item) => item.ok).length
  };
  // 空跑（一条候选都没有）不归档，免得归档列表里全是没内容的记录
  if (!counts.candidates && !counts.drafts) return;
  const status: AutoFlowRunArchiveView["status"] = counts.sent > 0
    ? "sent"
    : reason === "abandoned" ? "partial" : "draft_only";
  state.archivedAt = runId;
  if (!isSnapshot) autoFlowWrite();
  try {
    await api("/api/auto-flow/runs", {
      method: "POST",
      body: JSON.stringify({
        id: runId,
        command: state.command || "",
        startedAt: state.startedAt || "",
        finishedAt: new Date().toISOString(),
        targetCount: state.targetCount || AUTO_FLOW_TARGET_DEFAULT,
        counts,
        batchId: artifacts.batchId || "",
        senderEmail: state.senderEmail || "",
        status
      })
    });
    autoFlowLog("done", isSnapshot
      ? `上一轮已归档（中途重置）：候选 ${counts.candidates} 家、草稿 ${counts.drafts} 封保留在「任务归档」里`
      : counts.sent > 0
        ? `本轮已归档：发出 ${counts.sent} 封，打开与回复会随邮件实时更新，可在右上角「任务归档」里切换任务查看`
        : reason === "abandoned"
          ? "本轮已归档（中途停下）：候选与草稿都留在归档里，下次可以照着这批继续"
          : "本轮已归档：这批信没有发出，可在归档里找回候选与草稿");
    autoFlowSelectedRunId = runId;
    await loadAutoFlowRuns(true);
    void loadAutoFlowNotify(runId);
  } catch (error) {
    // 没存上就把标记退回去：下次打开自动流页会补存一次（成功后才重新写 archivedAt）
    state.archivedAt = undefined;
    if (!isSnapshot) autoFlowWrite();
    autoFlowLog("warn", `任务归档没存上：${error instanceof Error ? error.message : "接口不可用"}`);
  }
}

/**
 * 跑完却没存上（关页、断网、接口 500）：回到自动流页时补一条归档。
 *
 * 不只看「全部 done」：步进运行停在「发送」之后、或者发完就关了页面，第 5 步还没跑，
 * 这一批同样必须有归档——否则监控按 runId 找不到这一轮，台账明明有数据却显示「还没进归档」。
 * 发送已完成就补，比四步全绿更接近"这一轮真的发过信"。
 */
function autoFlowArchiveIfFinished() {
  const state = autoFlowEnsure();
  if (!state.runId || state.archivedAt === state.runId) return;
  const allDone = AUTO_FLOW_STEPS.every((step) => state.status[step.key] === "done");
  if (!allDone && state.status.send !== "done") return;
  void autoFlowArchiveRun();
}

/** 归档列表的刷新与切换：列表在独立页面里，进哪次都要能点（事件委托只绑一次） */
let autoFlowArchiveBound = false;
function autoFlowBindArchive() {
  if (autoFlowArchiveBound) return;
  const refresh = qs<HTMLButtonElement>("#afArchiveRefresh");
  const list = qs<HTMLElement>("#afArchiveList");
  if (!refresh || !list) return;
  autoFlowArchiveBound = true;
  refresh.addEventListener("click", () => void loadAutoFlowRuns(true));
  list.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-af-run]");
    if (!button?.dataset.afRun) return;
    autoFlowSelectedRunId = button.dataset.afRun;
    autoFlowRunDetail = null;
    autoFlowRenderArchive();
    void loadAutoFlowRunDetail(autoFlowSelectedRunId);
  });
}

/** 任务归档页：从自动流右上角进入，独立一屏看历史任务 */
export function renderAutoFlowHistory() {
  if (!qs<HTMLElement>("#afArchiveList")) return;
  autoFlowBindArchive();
  autoFlowRenderArchive();
  void loadAutoFlowRuns(true);
  // 归档页同样共用自动流那一条刷新线程：打开/回复每 30 秒统一更新
  startAutoFlowMonitor();
}

async function loadAutoFlowRuns(force = false) {
  if (autoFlowRunsLoading) return;
  if (autoFlowRunsLoaded && !force) {
    autoFlowRenderArchive();
    return;
  }
  autoFlowRunsLoading = true;
  try {
    const payload = await api<{ runs?: AutoFlowRunArchiveView[] }>("/api/auto-flow/runs");
    autoFlowRuns = (payload.runs || []).map((run) => ({ ...run, engagement: { ...EMPTY_ENGAGEMENT, ...(run.engagement || {}) } }));
    autoFlowRunsLoaded = true;
    if (!autoFlowRuns.some((run) => run.id === autoFlowSelectedRunId)) autoFlowSelectedRunId = autoFlowRuns[0]?.id || "";
  } catch {
    // 拉不到就显示空态，不影响主流程
    autoFlowRunsLoaded = true;
  } finally {
    autoFlowRunsLoading = false;
    autoFlowRenderArchive();
    autoFlowRenderNotify();
    // 刚取过一次台账：记下时间，通知总结里的「上次刷新」才不会空着
    if (!autoFlowMonitorLastAt) autoFlowMonitorLastAt = Date.now();
    const run = autoFlowNotifyRun();
    if (run && autoFlowNotify?.runId !== run.id) void loadAutoFlowNotify(run.id);
    // 收件人明细只有归档页要看；自动流页的 30 秒统一刷新不该多取这一份
    const historyActive = qs<HTMLElement>("#auto-flow-history")?.classList.contains("active");
    if (historyActive && autoFlowSelectedRunId) void loadAutoFlowRunDetail(autoFlowSelectedRunId);
  }
}

async function loadAutoFlowRunDetail(runId: string) {
  if (autoFlowRunDetailLoading && autoFlowRunDetail?.id === runId) return;
  autoFlowRunDetailLoading = true;
  try {
    const payload = await api<{ run?: AutoFlowRunArchiveView; rows?: AutoFlowRunRow[] }>(`/api/auto-flow/runs/${encodeURIComponent(runId)}`);
    if (payload.run) {
      autoFlowRuns = autoFlowRuns.map((run) => run.id === runId ? { ...run, ...payload.run!, engagement: { ...EMPTY_ENGAGEMENT, ...(payload.run!.engagement || {}) } } : run);
    }
    autoFlowRunDetail = { id: runId, rows: payload.rows || [] };
  } catch {
    autoFlowRunDetail = { id: runId, rows: [] };
  } finally {
    autoFlowRunDetailLoading = false;
    if (autoFlowSelectedRunId === runId) autoFlowRenderArchive();
  }
}

/** 通知总结盯的是「这一轮」：正在跑/刚跑完的一轮优先，没有就取最近归档的一轮 */
function autoFlowNotifyRun() {
  const state = autoFlowEnsure();
  return autoFlowRuns.find((run) => run.id === state.runId) || autoFlowRuns[0] || null;
}

function autoFlowNotifyClock(value: string) {
  const at = Date.parse(value || "");
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function autoFlowNotifyRefreshClock(value: number) {
  if (!value) return "";
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

async function loadAutoFlowNotify(runId: string) {
  if (!runId) {
    autoFlowNotify = null;
    autoFlowRenderNotify();
    return;
  }
  if (autoFlowNotifyLoading) return;
  autoFlowNotifyLoading = true;
  try {
    const view = await api<AutoFlowNotifyView>(`/api/auto-flow/runs/${encodeURIComponent(runId)}/notify`);
    autoFlowNotify = view;
    // 推送是异步的：第一次读不到就 4 秒后补查一次（每轮只补一次，不是常驻轮询）
    if (view.wecom.configured && view.wecom.enabled && view.wecom.ruleOn
      && !view.wecom.entry && !autoFlowNotifyRetried.has(runId)) {
      autoFlowNotifyRetried.add(runId);
      window.setTimeout(() => { void loadAutoFlowNotify(runId); }, 4_000);
    }
  } catch {
    // 读不到就保留上一次结果：面板不能因为一次接口失败就变成空白
  } finally {
    autoFlowNotifyLoading = false;
    autoFlowRenderNotify();
  }
}

/**
 * 打开 / 回复只有一个刷新线程。
 * 不管归档里有多少轮任务，都共用这一个定时器：一次请求取回所有任务的统计，
 * 再分发给归档列表与「通知总结」。绝不按任务各开一条定时器。
 */
export function startAutoFlowMonitor() {
  if (autoFlowMonitorTimer !== null) return;
  if (!autoFlowMonitorVisibilityBound) {
    autoFlowMonitorVisibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible"
        && autoFlowMonitorTimer !== null
        && Date.now() - autoFlowMonitorLastAt > AUTO_FLOW_MONITOR_INTERVAL_MS) {
        void autoFlowMonitorTick();
      }
    });
  }
  autoFlowMonitorTimer = window.setInterval(() => void autoFlowMonitorTick(), AUTO_FLOW_MONITOR_INTERVAL_MS);
}

export function stopAutoFlowMonitor() {
  if (autoFlowMonitorTimer === null) return;
  window.clearInterval(autoFlowMonitorTimer);
  autoFlowMonitorTimer = null;
}

async function autoFlowMonitorTick() {
  if (autoFlowMonitorTicking) return;
  if (document.visibilityState !== "visible") return;
  if (!qs<HTMLElement>("#afNotify")) return;
  autoFlowMonitorTicking = true;
  try {
    await loadAutoFlowRuns(true);
    const run = autoFlowNotifyRun();
    if (run) await loadAutoFlowNotify(run.id);
    // 第 5 步正在看时，同一条线程顺手把这一批的读数也刷掉（不另开定时器）
    if (autoFlowStageKey === "monitor" && autoFlowEnsure().artifacts?.batchId) {
      await loadAutoFlowMonitor(true);
      autoFlowSyncMonitorStage();
    }
    autoFlowMonitorLastAt = Date.now();
  } finally {
    autoFlowMonitorTicking = false;
    autoFlowRenderNotify();
    autoFlowSyncResultCounts();
  }
}

async function autoFlowRefreshNotify(manual = false) {
  await loadAutoFlowRuns(true);
  const run = autoFlowNotifyRun();
  if (run) await loadAutoFlowNotify(run.id);
  autoFlowMonitorLastAt = Date.now();
  autoFlowRenderNotify();
  if (manual) toast("已刷新通知与打开回复");
}

// ===========================================================================
// 第 5 步 · 数据监控
//
// 这一步不"等回信"——回信是几小时到几天后才发生的事，把它做成阻塞节点会让整条流水线
// 永远停在 99%。所以它的语义是「发完信就自动进入，先取一次基线，然后常驻刷新」：
// - 跑：归档本轮批次 → 取一次 engagement + 每个收件人的状态 → 节点标完成（监控中）
// - 常驻：复用页面唯一那条 30 秒刷新线程，刷新时只换监控区里的数字，不动别处
// - 口径：全部来自发件台账 `batch:<批次id>:` 前缀，和「发信明细 / 任务归档」同一个数
// ===========================================================================

function autoFlowMonitorRate(part: number, whole: number) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

/**
 * 这一批最早一封发出去多久了（小时）。
 * 台账一行都没对上时返回 null —— 不能当成「刚发出 0 小时」，否则会给出"0 打开很正常"的错误结论。
 */
function autoFlowMonitorHours(data: AutoFlowMonitorData): number | null {
  const times = data.rows.map((row) => Date.parse(row.sentAt || "")).filter((at) => Number.isFinite(at));
  if (!times.length) return null;
  return Math.max(0, (Date.now() - Math.min(...times)) / 3_600_000);
}

/**
 * 读这一批的监控数据。
 * 先按 runId 找归档，找不到再按 batchId 找（旧状态、跨设备都可能没有 runId）；
 * 两条都没有说明这一批还没归档，直接返回 null，界面显示「等这一批进台账」。
 */
async function loadAutoFlowMonitor(force = false): Promise<AutoFlowMonitorData | null> {
  const artifacts = autoFlowEnsure().artifacts!;
  const batchId = artifacts.batchId || "";
  if (!batchId) {
    autoFlowMonitorData = null;
    autoFlowMonitorError = "";
    return null;
  }
  if (!force && autoFlowMonitorData?.batchId === batchId
    && Date.now() - autoFlowMonitorData.at < AUTO_FLOW_MONITOR_INTERVAL_MS) {
    return autoFlowMonitorData;
  }
  if (autoFlowMonitorLoading) return autoFlowMonitorData;
  autoFlowMonitorLoading = true;
  try {
    if (!autoFlowRunsLoaded) await loadAutoFlowRuns(true);
    const state = autoFlowEnsure();
    const run = autoFlowRuns.find((item) => item.id === state.runId)
      || autoFlowRuns.find((item) => item.batchId === batchId)
      || null;
    if (!run) {
      autoFlowMonitorError = "这一批还没进任务归档，监控稍后再试";
      return autoFlowMonitorData?.batchId === batchId ? autoFlowMonitorData : null;
    }
    const payload = await api<{
      run?: AutoFlowRunArchiveView;
      rows?: AutoFlowRunRow[];
      replyCoverage?: AutoFlowMonitorData["replyCoverage"];
    }>(`/api/auto-flow/runs/${encodeURIComponent(run.id)}`);
    autoFlowMonitorError = "";
    autoFlowMonitorData = {
      batchId,
      runId: run.id,
      engagement: { ...EMPTY_ENGAGEMENT, ...(payload.run?.engagement || run.engagement || {}) },
      rows: payload.rows || [],
      replyCoverage: payload.replyCoverage
        || { watchers: 0, senders: [], uncovered: [], unknownSender: 0 },
      at: Date.now()
    };
    return autoFlowMonitorData;
  } catch (error) {
    autoFlowMonitorError = error instanceof Error ? error.message : "监控数据读取失败";
    // 读失败保留上一次的快照：面板不能因为一次接口抖动就变成空白
    return autoFlowMonitorData?.batchId === batchId ? autoFlowMonitorData : null;
  } finally {
    autoFlowMonitorLoading = false;
  }
}

/** 这一批的读数要说明什么：先给结论，再给动作，不堆数字 */
function autoFlowMonitorAdvice(data: AutoFlowMonitorData): Array<{ tone: "ok" | "warn" | "bad" | "wait"; text: string }> {
  const e = data.engagement;
  const hours = autoFlowMonitorHours(data);
  const bounceRate = autoFlowMonitorRate(e.bounced, e.sent);
  const replyRate = autoFlowMonitorRate(e.replied, e.sent);
  const list: Array<{ tone: "ok" | "warn" | "bad" | "wait"; text: string }> = [];
  if (!e.sent) {
    return [{
      tone: "warn",
      text: "这一批已经没有「已送达」的信可以统计：可能还在投递队列，或全部被拦下。先看第 4 步「发送」的台账。"
    }];
  }
  if (e.replied > 0) {
    list.push({
      tone: "ok",
      text: `已有 ${e.replied} 家回信（回复率 ${replyRate}%）：回信不会自己变成商机，去「监控明细」逐个跟进，24 小时内回第一封。`
    });
  }
  if (bounceRate >= 5) {
    list.push({
      tone: "bad",
      text: `退信 ${e.bounced} 封，退信率 ${bounceRate}% 已超过 5%：先停下这一批用的发件域名，清洗地址后再发，否则域名信誉会被拖垮。`
    });
  } else if (bounceRate > 0) {
    list.push({ tone: "warn", text: `退信 ${e.bounced} 封（${bounceRate}%）：还在安全线内，把退信地址从名单里剔掉就行。` });
  }
  if (e.opened === 0) {
    list.push(hours !== null && hours >= 24
      ? { tone: "warn", text: `发出已 ${Math.round(hours)} 小时还是 0 打开：先查送达（是否进了垃圾箱），再改主题行——现在这版标题没人愿意点。` }
      : { tone: "wait", text: `刚发出 ${hours === null ? "不久" : Math.max(1, Math.round(hours)) + " 小时"}，0 打开是正常的：对方读信要先加载图片才会被记一次打开。` });
  } else if (e.replied === 0) {
    list.push(hours !== null && hours >= 48
      ? { tone: "warn", text: `打开 ${e.opened} 家、0 回复：信被看到了但没打动对方，下一步改开场那句（要引用对方的具体业务事实）。` }
      : { tone: "wait", text: `打开 ${e.opened} 家、暂未回复：给到 48 小时再看，期间不要重复发同一封。` });
  } else if (e.clicked === 0) {
    list.push({ tone: "wait", text: "有打开但没点击：正文里的链接没人点，说明对方只是扫了一眼，跟进时补一个有价值的资料链接。" });
  }
  if (!list.some((item) => item.tone === "ok" || item.tone === "bad")) {
    list.push({ tone: "ok", text: `打开率 ${e.openRate}%，回复率 ${replyRate}%：这一批跑得平稳，保持现在的主题行与开场写法。` });
  }
  return list;
}

function autoFlowMonitorMetric(label: string, value: string, note: string, tone: "ok" | "warn" | "bad" | "wait" | "dim") {
  return `<div class="af-mon-metric" data-tone="${tone}">
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(value)}</b>
      <i>${escapeHtml(note)}</i>
    </div>`;
}

/**
 * 数据源是否接通的说明。
 * 监控里「打开 / 点击」靠追踪像素（公网可达即可），但「回复 / 退信」只能靠 IMAP 轮询收件箱回写；
 * 没接通时这两栏恒为 0，必须明说，否则会被读成"客户都不回"。
 */
function autoFlowMonitorCoverageHtml(data: AutoFlowMonitorData, localSentOk: number): string {
  const coverage = data.replyCoverage;
  const blocks: string[] = [];
  if (!data.engagement.sent && localSentOk > 0) {
    blocks.push(`<div class="af-mon-alert" data-tone="bad">
      <b>这一批的台账没对上</b>
      <p>本地记着发出 ${localSentOk} 封，但按批次前缀在发件台账里一封都没统计到——归档时没把台账的关联号改成批次前缀。可以在下面重新归档一次（同一批只会归档一次）。</p>
      <button class="btn" type="button" data-af-monitor="rearchive">重新归档这一批</button>
    </div>`);
  }
  const uncovered = coverage?.uncovered || [];
  if (uncovered.length) {
    blocks.push(`<div class="af-mon-alert" data-tone="warn">
      <b>回复与退信统计没有接通</b>
      <p>这批用的 ${uncovered.map((email) => escapeHtml(email)).join("、")} 没有开启「IMAP 收信监听」。客户回信与退信通知都进这些邮箱，抓不到就一直是 0——打开与点击不受影响。</p>
      <button class="btn" type="button" data-af-monitor="imap">去开启收信监听</button>
    </div>`);
  } else if (!coverage?.senders?.length && coverage?.unknownSender && !coverage.watchers) {
    blocks.push(`<div class="af-mon-alert" data-tone="warn">
      <b>回复与退信统计没有接通</b>
      <p>账号还没有开启「IMAP 收信监听」，客户回信与退信不会被记进台账，这两栏会一直是 0——打开与点击不受影响。</p>
      <button class="btn" type="button" data-af-monitor="imap">去开启收信监听</button>
    </div>`);
  }
  return blocks.join("");
}

/** 监控区的正文：指标卡 + 结论 + 最近有动静的收件人 */
function autoFlowMonitorBodyHtml(): string {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const sentOk = artifacts.sent.filter((item) => item.ok).length;
  if (!artifacts.batchId) {
    if ((state.status.monitor || "idle") === "idle") {
      return `<div class="af-mon-empty">
        <p>还没跑到这一步：第 4 步点「确认发送」之后这里会自动接上，按这一批的发件台账统计打开、点击、回复与退信。</p>
      </div>`;
    }
    return `<div class="af-mon-empty">
        <p>${sentOk
          ? `这一批发出了 ${sentOk} 封，但归档接口没返回批次号，监控对不上台账。去「发信明细」按发件箱看打开与回复。`
          : "本轮没有发出信，没有可监控的数据。想监控打开与回复，先在「发送」节点确认发出这一批。"}</p>
        ${sentOk && artifacts.pendingBatchItems?.length
          ? `<button class="btn" type="button" data-af-monitor="rearchive">重新归档这一批</button>`
          : ""}
      </div>`;
  }
  const data = autoFlowMonitorData?.batchId === artifacts.batchId ? autoFlowMonitorData : null;
  if (!data) {
    return `<div class="af-mon-empty">
        <p>${autoFlowMonitorError ? escapeHtml(autoFlowMonitorError) : "正在读这一批的打开与回复…"}</p>
        <button class="btn" type="button" data-af-monitor="refresh">立即重试</button>
      </div>`;
  }
  const e = data.engagement;
  const hours = autoFlowMonitorHours(data);
  const replyRate = autoFlowMonitorRate(e.replied, e.sent);
  const bounceRate = autoFlowMonitorRate(e.bounced, e.sent);
  // 台账对不上时（本地发出 N 封、台账 0 封）上面已经报了原因，别再叠一句"可能还在投递队列"自相矛盾
  const ledgerMismatch = !e.sent && sentOk > 0;
  const chips = [
    `<span class="af-mon-chip">批次 ${escapeHtml(data.batchId.slice(-8))}</span>`,
    `<span class="af-mon-chip">${hours === null
      ? "台账里还没有发出记录"
      : `发出已 ${hours >= 1 ? `${Math.round(hours)} 小时` : `${Math.max(1, Math.round(hours * 60))} 分钟`}`}</span>`,
    `<span class="af-mon-chip">上次刷新 ${autoFlowNotifyRefreshClock(data.at)}</span>`
  ].join("");
  const hot = data.rows
    .filter((row) => row.repliedAt || row.bouncedAt || row.openCount > 0)
    .sort((a, b) => (b.repliedAt ? 1 : 0) - (a.repliedAt ? 1 : 0) || String(b.lastOpenedAt || b.bouncedAt).localeCompare(String(a.lastOpenedAt || a.bouncedAt)))
    .slice(0, 6);
  return `
    <div class="af-mon-metrics">
      ${autoFlowMonitorMetric("已发出", String(e.sent), "封", "dim")}
      ${autoFlowMonitorMetric("打开", String(e.opened), `${e.openRate}%`, e.opened ? "ok" : "wait")}
      ${autoFlowMonitorMetric("点击", String(e.clicked), "次", e.clicked ? "ok" : "dim")}
      ${autoFlowMonitorMetric("回复", String(e.replied), `${replyRate}%`, e.replied ? "ok" : "wait")}
      ${autoFlowMonitorMetric("退信", String(e.bounced), bounceRate ? `${bounceRate}%` : "0%", e.bounced ? (bounceRate >= 5 ? "bad" : "warn") : "dim")}
    </div>
    ${autoFlowMonitorCoverageHtml(data, sentOk)}
    ${ledgerMismatch ? "" : `<ul class="af-mon-advice">
      ${autoFlowMonitorAdvice(data).map((item) => `<li data-tone="${item.tone}"><i aria-hidden="true"></i>${escapeHtml(item.text)}</li>`).join("")}
    </ul>`}
    <div class="af-mon-hot">
      <div class="af-mon-hot-h"><span>最近有动静的收件人</span><b>${hot.length ? `前 ${hot.length} 个` : "还没有人打开"}</b></div>
      ${hot.length ? `<ul>${hot.map((row) => `<li>
          <b title="${escapeHtml(row.to)}">${escapeHtml(row.to || "—")}</b>
          <span>${row.repliedAt ? `已回复 · ${autoFlowResultTimeOf(row.repliedAt)}` : row.bouncedAt ? `退信 · ${autoFlowResultTimeOf(row.bouncedAt)}` : `打开 ${row.openCount} 次 · ${autoFlowResultTimeOf(row.firstOpenedAt)}`}</span>
        </li>`).join("")}</ul>` : `<p>发出后打开统计依赖对方加载邮件图片，通常要等几小时；有动静这里会第一个亮。</p>`}
    </div>
    <div class="af-mon-foot">
      ${chips}
      <button class="btn" type="button" data-af-monitor="refresh">刷新</button>
      <button class="btn" type="button" data-af-monitor="open">打开监控明细</button>
    </div>`;
}

/** 30 秒线程刷新到监控节点时，只换监控区，不整块重建详情（否则阅读位置会跳） */
function autoFlowSyncMonitorStage() {
  const body = qs<HTMLElement>('#afStage [data-role="mon-body"]');
  if (!body) return;
  body.innerHTML = autoFlowMonitorBodyHtml();
  const state = autoFlowEnsure();
  const running = state.status.monitor === "running";
  const tag = qs<HTMLElement>('#afStage [data-role="stage-tag"]');
  if (tag) {
    const watching = state.status.monitor === "done";
    tag.textContent = watching ? "监控中" : autoFlowStageLabel(state.status.monitor || "idle", 0);
    if (watching) tag.dataset.watch = "1";
    else delete tag.dataset.watch;
    if (running) tag.textContent = "读取中";
  }
}

async function autoFlowRefreshMonitorStage(manual = false) {
  if (manual) {
    const body = qs<HTMLElement>('#afStage [data-role="mon-body"]');
    if (body) body.innerHTML = `<div class="af-mon-empty"><p>正在读这一批的打开与回复…</p></div>`;
  }
  await loadAutoFlowMonitor(true);
  autoFlowSyncMonitorStage();
  autoFlowSyncResultCounts();
  if (manual) toast("已刷新这一批的打开与回复");
}

/**
 * 补归档：发信成功、但 /api/auto-flow/complete-send 没成（网络抖动、5xx）时，
 * 这一批就变成「发了信却统计不到」。用落盘的 pendingBatchItems + 同一个批次号重试，
 * 服务端按 id 覆盖，归档里不会多出第二条空批次。
 */
async function autoFlowRetryArchiveBatch(): Promise<boolean> {
  const artifacts = autoFlowEnsure().artifacts!;
  const items = artifacts.pendingBatchItems || [];
  if (!items.length) return false;
  if (!artifacts.pendingBatchId) artifacts.pendingBatchId = `afb_${crypto.randomUUID()}`;
  try {
    const archived = await api<{ batchId?: string }>("/api/auto-flow/complete-send", {
      method: "POST",
      body: JSON.stringify({ batchId: artifacts.pendingBatchId, items, failed: 0 })
    });
    if (!archived?.batchId) return false;
    artifacts.batchId = archived.batchId;
    artifacts.pendingBatchId = undefined;
    artifacts.pendingBatchItems = undefined;
    autoFlowWrite();
    return true;
  } catch {
    return false;
  }
}

/** 监控面板上的「重新归档这一批」：补批次号 → 用新批次号重存一次归档 → 重新取数 */
async function autoFlowManualRearchive() {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  if (!artifacts.pendingBatchItems?.length) {
    toast("这一批的发送明细没留在本地（可能换了设备），只能去「发信明细」核对", "error");
    return;
  }
  const ok = await autoFlowRetryArchiveBatch();
  if (!ok) {
    toast("重新归档失败：接口没返回批次号，稍后再试", "error");
    return;
  }
  // 归档记录里也要补上批次号：清掉已归档标记，让下一行重新存一次（同 runId 幂等）
  state.archivedAt = undefined;
  autoFlowWrite();
  await autoFlowArchiveRun();
  await loadAutoFlowMonitor(true);
  autoFlowSyncMonitorStage();
  autoFlowSyncResultCounts();
  toast("已重新归档这一批，打开与回复开始按批次统计");
}

/**
 * 第 5 步的执行体：这一步很快（只取一次基线），完成后进入「监控中」——
 * 状态仍是 done（流水线算跑完、能归档），但节点标签与详情区显示实时读数。
 */
async function autoFlowRunMonitor(token: number) {
  const state = autoFlowEnsure();
  const artifacts = state.artifacts!;
  const sentOk = artifacts.sent.filter((item) => item.ok).length;
  // 上一次发送完成后归档没存上：先用同一批次号补一次，否则这一批在台账里永远统计不到
  if (!artifacts.batchId && artifacts.pendingBatchItems?.length) {
    autoFlowSetWait("monitor", "补归档这一批（上次没存上）");
    autoFlowLog("start", "发现这一批发完没有归档成功，正在用同一批次号补归档…");
    const archivedOk = await autoFlowRetryArchiveBatch();
    if (token !== autoFlowRunToken) return;
    autoFlowLog(archivedOk ? "done" : "warn", archivedOk
      ? "补归档成功：这一批已进台账，打开与回复可以按批次统计了"
      : "补归档还是失败：打开与回复暂时统计不到，稍后点「重新归档这一批」再试");
  }
  if (!artifacts.batchId) {
    autoFlowLog("warn", sentOk
      ? `这一批发出了 ${sentOk} 封，但没拿到批次号，监控只能按发件明细粗看；点「打开监控明细」查看`
      : "本轮没有发出信，没有可监控的数据，监控节点直接跳过");
    autoFlowCompleteStep("monitor");
    return;
  }
  autoFlowSetWait("monitor", "读取这一批的打开与回复");
  autoFlowSetProgress("monitor", 25);
  // 监控按「批次台账」统计，所以先把本轮归档成一条任务（同 runId 幂等，跑完不会再存一次）
  await autoFlowArchiveRun();
  if (token !== autoFlowRunToken) return;
  autoFlowSetProgress("monitor", 70);
  const data = await loadAutoFlowMonitor(true);
  if (token !== autoFlowRunToken) return;
  if (!data) {
    autoFlowLog("warn", `监控数据暂时没取到：${autoFlowMonitorError || "接口不可用"}；节点照常完成，之后每 30 秒自动再试一次`);
  } else {
    const e = data.engagement;
    autoFlowLog("done", `监控基线：已发 ${e.sent} 封 · 打开 ${e.opened}${e.sent ? `（${e.openRate}%）` : ""} · 点击 ${e.clicked} · 回复 ${e.replied} · 退信 ${e.bounced}`);
  }
  autoFlowSetProgress("monitor", 100);
  autoFlowCompleteStep("monitor");
}

function autoFlowNotifyRow(
  valueEl: HTMLElement | null,
  detailEl: HTMLElement | null,
  value: string,
  tone: "ok" | "warn" | "bad" | "wait",
  detail: string
) {
  if (valueEl) {
    valueEl.textContent = value;
    valueEl.dataset.tone = tone;
  }
  if (detailEl) {
    detailEl.textContent = detail;
    detailEl.title = detail;
  }
}

function autoFlowNotifyExtraHtml() {
  const email = autoFlowNotify?.email;
  if (!email?.deliveries.length) {
    return `<div class="af-notify-extra-empty">还没有寄送记录：这一轮发完后，会按发件邮箱各寄一份 Excel 总结。</div>`;
  }
  const sorted = [...email.deliveries].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const rows = sorted.map((row) => `<tr>
      <td>${escapeHtml(row.senderEmail || "—")}</td>
      <td>${row.status === "sent" ? '<span class="af-notify-ok">已寄出</span>' : '<span class="af-notify-bad">失败</span>'}</td>
      <td>${row.customers} 家 / ${row.letters} 封</td>
      <td class="af-notify-file" title="${escapeHtml(row.fileName || "")}">${escapeHtml(row.fileName || "—")}</td>
      <td class="af-notify-file">${escapeHtml(autoFlowNotifyClock(row.at) || "—")}</td>
    </tr>${row.status === "failed" && row.error ? `<tr><td></td><td colspan="4" class="af-notify-bad">${escapeHtml(row.error)}</td></tr>` : ""}`).join("");
  return `<table>
    <thead><tr><th>发件邮箱</th><th>状态</th><th>客户 / 信件</th><th>发送总结附件</th><th>时间</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function autoFlowRenderNotify() {
  if (!qs<HTMLElement>("#afNotify")) return;
  const run = autoFlowNotifyRun();
  const notify = autoFlowNotify && run && autoFlowNotify.runId === run.id ? autoFlowNotify : null;

  // ① 企业微信：本轮发完了
  const wecomValue = qs<HTMLElement>("#afNotifyWecom");
  const wecomDetail = qs<HTMLElement>("#afNotifyWecomDetail");
  const wecomAction = qs<HTMLButtonElement>("#afNotifyWecomAction");
  let wecomActionText = "去配置";
  let wecomActionVisible = false;
  if (!run || !run.batchId) {
    autoFlowNotifyRow(wecomValue, wecomDetail, "还没有批次", "wait", "本轮发完最后一步后，自动推一条「本轮已发完」到企业微信");
  } else if (!notify) {
    autoFlowNotifyRow(wecomValue, wecomDetail, "读取中…", "wait", "正在读这一轮的推送结果");
  } else if (!notify.wecom.configured) {
    wecomActionText = "去配置";
    wecomActionVisible = true;
    autoFlowNotifyRow(wecomValue, wecomDetail, "未配置", "warn", "到系统设置里填企业微信 CorpID / Secret，或者用群机器人");
  } else if (!notify.wecom.enabled) {
    wecomActionText = "去开启";
    wecomActionVisible = true;
    autoFlowNotifyRow(wecomValue, wecomDetail, "未启用", "warn", "配置已保存，但企业微信推送开关还是关着的");
  } else if (!notify.wecom.ruleOn) {
    wecomActionText = "去设置";
    wecomActionVisible = true;
    autoFlowNotifyRow(wecomValue, wecomDetail, "规则已关", "warn", "「自动流本轮发完」这条推送规则没有勾选");
  } else if (notify.wecom.entry?.status === "sent") {
    autoFlowNotifyRow(
      wecomValue,
      wecomDetail,
      "已通知",
      "ok",
      `${autoFlowNotifyClock(notify.wecom.entry.at)} · ${notify.wecom.entry.recipients || "已推送"} · ${notify.wecom.entry.title}`
    );
  } else if (notify.wecom.entry?.status === "failed") {
    wecomActionText = "去检查";
    wecomActionVisible = true;
    autoFlowNotifyRow(wecomValue, wecomDetail, "推送失败", "bad", notify.wecom.entry.message || "企业微信拒绝了这条消息，去系统设置里看记录");
  } else {
    wecomActionVisible = false;
    autoFlowNotifyRow(wecomValue, wecomDetail, "等待推送", "wait", "批次已登记，推送正在路上；稍等几秒或点「刷新」");
  }
  if (wecomAction) {
    wecomAction.hidden = !wecomActionVisible;
    wecomAction.textContent = wecomActionText;
  }

  // ② 邮箱：本轮发送总结寄到各发件邮箱
  const emailValue = qs<HTMLElement>("#afNotifyEmail");
  const emailDetail = qs<HTMLElement>("#afNotifyEmailDetail");
  const emailAction = qs<HTMLButtonElement>("#afNotifyEmailAction");
  let emailHasRows = false;
  if (!run || !run.batchId) {
    autoFlowNotifyRow(emailValue, emailDetail, "还没发出", "wait", "本轮发完后，按发件邮箱各寄一份 Excel：客户清单 / 背调详情 / 开发信原文");
  } else if (!notify) {
    autoFlowNotifyRow(emailValue, emailDetail, "读取中…", "wait", "正在读这一轮的总结寄送结果");
  } else if (!notify.email.autoSend) {
    autoFlowNotifyRow(emailValue, emailDetail, "未开启自动寄送", "warn", "团队关掉了自动寄送；可到「邮件中心 · 自动发信」找到这批，点「发送总结」补寄");
  } else if (!notify.email.deliveries.length) {
    autoFlowNotifyRow(emailValue, emailDetail, "等待寄出", "wait", "总结正在生成，寄出后这里会显示每个发件邮箱与附件名");
  } else {
    emailHasRows = true;
    const latest = [...notify.email.deliveries].sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    const customers = notify.email.deliveries.reduce((sum, row) => sum + row.customers, 0);
    const letters = notify.email.deliveries.reduce((sum, row) => sum + row.letters, 0);
    if (!notify.email.sent) {
      autoFlowNotifyRow(emailValue, emailDetail, `寄送失败 ${notify.email.failed} 个`, "bad", latest?.error || "总结邮件没寄出去，可到邮件中心看发件记录");
    } else if (notify.email.failed) {
      autoFlowNotifyRow(
        emailValue,
        emailDetail,
        `已寄 ${notify.email.sent} 个 · ${notify.email.failed} 个失败`,
        "warn",
        `${customers} 家客户 / ${letters} 封信 · ${latest?.fileName || "见明细"}`
      );
    } else {
      autoFlowNotifyRow(
        emailValue,
        emailDetail,
        `已寄 ${notify.email.sent} 个邮箱`,
        "ok",
        `${autoFlowNotifyClock(latest?.at || "")} · ${customers} 家客户 / ${letters} 封信 · ${latest?.fileName || "见明细"}`
      );
    }
  }
  if (emailAction) {
    emailAction.hidden = !emailHasRows;
    emailAction.textContent = autoFlowNotifyExtraOpen ? "收起" : "明细";
    emailAction.setAttribute("aria-expanded", String(autoFlowNotifyExtraOpen && emailHasRows));
  }
  const extra = qs<HTMLElement>("#afNotifyExtra");
  if (extra) {
    const show = autoFlowNotifyExtraOpen && emailHasRows;
    extra.hidden = !show;
    if (show) extra.innerHTML = autoFlowNotifyExtraHtml();
  }

  // ③ 打开 / 回复：一条线程统一刷新所有任务
  const monitorValue = qs<HTMLElement>("#afNotifyMonitor");
  const monitorDetail = qs<HTMLElement>("#afNotifyMonitorDetail");
  const watched = autoFlowRuns.filter((item) => item.batchId);
  if (!watched.length) {
    autoFlowNotifyRow(monitorValue, monitorDetail, "等待第一轮", "wait", "跑完一轮后开始统计；所有任务共用同一次刷新，不会一个任务开一条线程");
  } else {
    const total = watched.reduce((sum, item) => {
      sum.sent += item.engagement.sent || item.counts.sent || 0;
      sum.opened += item.engagement.opened || 0;
      sum.clicked += item.engagement.clicked || 0;
      sum.replied += item.engagement.replied || 0;
      return sum;
    }, { sent: 0, opened: 0, clicked: 0, replied: 0 });
    const rate = total.sent ? Math.round((total.opened / total.sent) * 1000) / 10 : 0;
    const last = autoFlowNotifyRefreshClock(autoFlowMonitorLastAt);
    autoFlowNotifyRow(
      monitorValue,
      monitorDetail,
      `监控 ${watched.length} 轮`,
      total.replied ? "ok" : "wait",
      `打开 ${total.opened}/${total.sent}${total.sent ? `（${rate}%）` : ""} · 点击 ${total.clicked} · 回复 ${total.replied}${last ? ` · 上次刷新 ${last}` : ""}`
    );
  }

  const note = qs<HTMLElement>("#afNotifyNote");
  if (note) {
    note.textContent = `本轮发完后自动通知 · 打开回复由一条线程每 ${AUTO_FLOW_MONITOR_INTERVAL_MS / 1000} 秒统一刷新所有任务`;
  }
}

/** 「去配置」跳到系统设置里的企业微信推送区块 */
function autoFlowOpenWecomSettings() {
  activateNavView("settings");
  window.setTimeout(() => {
    qs<HTMLElement>("#wecomPushSection")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, 150);
}

function autoFlowEngagementChip(label: string, value: number, tone: "ok" | "wait" | "dim" = "dim") {
  return `<span class="af-arch-chip" data-tone="${value ? tone : "dim"}">${escapeHtml(label)} <b>${value}</b></span>`;
}

function autoFlowRenderArchive() {
  const list = qs<HTMLElement>("#afArchiveList");
  const detail = qs<HTMLElement>("#afArchiveDetail");
  const count = qs<HTMLElement>("#afArchiveCount");
  if (count) count.textContent = String(autoFlowRuns.length);
  const badge = qs<HTMLElement>("#afArchiveBadge");
  if (badge) badge.textContent = String(autoFlowRuns.length);
  if (list) {
    list.innerHTML = autoFlowRuns.length
      ? autoFlowRuns.map((run) => {
        const active = run.id === autoFlowSelectedRunId;
        const e = run.engagement;
        return `<li>
          <button class="af-arch-item${active ? " is-active" : ""}" type="button" data-af-run="${escapeHtml(run.id)}" aria-pressed="${active}">
            <span class="af-arch-when">${escapeHtml(autoFlowArchiveWhen(run.finishedAt || run.startedAt))}</span>
            <span class="af-arch-command" title="${escapeHtml(run.command || "")}">${escapeHtml(run.command || "（没有填目标）")}</span>
            <span class="af-arch-meta">
              <i>发 ${run.counts.sent}</i><i>打开 ${e.opened}</i><i>回复 ${e.replied}</i>${run.status === "sent" ? "" : `<i>${run.status === "partial" ? "未跑完" : "未发出"}</i>`}
            </span>
          </button>
        </li>`;
      }).join("")
      : `<li class="af-arch-empty">还没有归档的任务。跑完一轮（获客 → 背调 → 写信 → 发送）会自动存一条，这里就能看打开和回复。</li>`;
  }
  if (detail) {
    const run = autoFlowRuns.find((item) => item.id === autoFlowSelectedRunId);
    if (!run) {
      detail.innerHTML = `<div class="af-arch-placeholder">跑完一轮后，这里会显示这一批的已发、打开、点击、回复，以及每个收件人的明细。</div>`;
      return;
    }
    const e = run.engagement;
    const rows = autoFlowRunDetail?.id === run.id ? autoFlowRunDetail.rows : [];
    const stats = [
      ["已发", e.sent || run.counts.sent, ""],
      ["打开", e.opened, e.sent ? `${e.openRate}%` : ""],
      ["点击", e.clicked, ""],
      ["回复", e.replied, ""]
    ].map(([label, value, note]) => `<div class="af-arch-stat"><span>${label}</span><b>${value}</b>${note ? `<small>${note}</small>` : ""}</div>`).join("");
    const rowsHtml = rows.length
      ? `<div class="af-arch-table-wrap"><table class="af-arch-table"><thead><tr><th>收件人</th><th>主题</th><th>打开</th><th>回复</th><th>发送时间</th></tr></thead><tbody>${rows.map((row) => {
        const opened = row.openCount > 0;
        const replied = Boolean(row.repliedAt);
        const bounced = Boolean(row.bouncedAt) || row.dispatchStatus === "bounced";
        return `<tr>
          <td><span class="af-arch-to">${escapeHtml(row.to || "—")}</span>${bounced ? '<em class="af-arch-bad">退信</em>' : ""}</td>
          <td><span class="af-arch-subject" title="${escapeHtml(row.subject || "")}">${escapeHtml(row.subject || "（无主题）")}</span></td>
          <td>${opened ? `<span class="af-arch-ok">${row.openCount} 次</span><small>${escapeHtml(autoFlowArchiveWhen(row.lastOpenedAt || row.firstOpenedAt))}</small>` : '<span class="af-arch-dim">未打开</span>'}</td>
          <td>${replied ? `<span class="af-arch-ok">已回复</span><small>${escapeHtml(autoFlowArchiveWhen(row.repliedAt))}</small>` : '<span class="af-arch-dim">—</span>'}</td>
          <td><span class="af-arch-dim">${escapeHtml(autoFlowArchiveWhen(row.sentAt))}</span></td>
        </tr>`;
      }).join("")}</tbody></table></div>`
      : `<div class="af-arch-placeholder">${run.status === "draft_only"
        ? "这一轮没有发送（草稿留在产物里），所以没有打开与回复数据。"
        : run.status === "partial"
          ? "这一轮中途停下了（没跑完四步），只留下候选与草稿；重新跑一轮发信后才有打开与回复。"
          : "这批邮件还没有台账明细：发送完成后会写入，打开与回复随之更新。"}</div>`;
    detail.innerHTML = `
      <div class="af-arch-detail-head">
        <div>
          <h4>${escapeHtml(run.command || "（没有填目标）")}</h4>
          <p>${escapeHtml(autoFlowArchiveWhen(run.startedAt))} 开跑 · 候选 ${run.counts.candidates} 家 · 背调 ${run.counts.researched} 家 · 草稿 ${run.counts.drafts} 封 · 目标 ${run.targetCount} 家${run.batchId ? ` · 批次 ${escapeHtml(run.batchId.slice(-8))}` : ""}</p>
        </div>
        <div class="af-arch-stats">${stats}</div>
      </div>
      ${rowsHtml}`;
  }
}

/** 展开某一步的运行结果（已展开则只刷新），并把结果区滚到可见处 */
async function autoFlowShowResult(key: string) {
  if (autoFlowResultKey === key) autoFlowResultKey = null;
  await autoFlowToggleResult(key);
  qs<HTMLElement>("#afResult")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}


// ===========================================================================
// 定时运行：到点自动从第 1 步开始跑一轮（一次跑完；到「发送」前仍会停下等人工确认）
//
// 流水线本身在浏览器里执行，所以定时也在浏览器里：CRM 页面开着（任意页面都行）就会按时触发。
// 电脑关机 / 页面关闭错过的时间点，重新打开后 30 分钟内会补跑一次，再晚就跳过，避免突然外发。
// 配置存 localStorage（gj.autoflow.schedule.v1），按账号区分。
// ===========================================================================
type AutoFlowRepeat = "daily" | "weekdays" | "once";

interface AutoFlowSchedule {
  enabled: boolean;
  repeat: AutoFlowRepeat;
  /** HH:MM */
  time: string;
  /** 仅一次时的日期 YYYY-MM-DD */
  date: string;
  /** 上次触发的计划时间点（毫秒），防止同一个时间点重复触发 */
  lastSlot: number;
}

const AUTO_FLOW_SCHEDULE_KEY = "gj.autoflow.schedule.v1";
const AUTO_FLOW_SCHEDULE_GRACE_MS = 30 * 60_000;
const AUTO_FLOW_SCHEDULE_TICK_MS = 20_000;
let autoFlowScheduleTimer: number | null = null;

function autoFlowScheduleStorageKey() {
  return `${AUTO_FLOW_SCHEDULE_KEY}:${appState.user?.id || "anon"}`;
}

function autoFlowTodayText(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

let autoFlowScheduleCacheKey = "";
let autoFlowScheduleCache: AutoFlowSchedule | null = null;

function autoFlowReadSchedule(): AutoFlowSchedule {
  const key = autoFlowScheduleStorageKey();
  if (autoFlowScheduleCache && autoFlowScheduleCacheKey === key) return { ...autoFlowScheduleCache };
  const fallback: AutoFlowSchedule = { enabled: false, repeat: "daily", time: "09:00", date: autoFlowTodayText(), lastSlot: 0 };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      autoFlowScheduleCacheKey = key;
      autoFlowScheduleCache = fallback;
      return { ...fallback };
    }
    const parsed = JSON.parse(raw) as Partial<AutoFlowSchedule>;
    const normalized: AutoFlowSchedule = {
      enabled: Boolean(parsed.enabled),
      repeat: parsed.repeat === "weekdays" || parsed.repeat === "once" ? parsed.repeat : "daily",
      time: /^\d{2}:\d{2}$/.test(String(parsed.time || "")) ? String(parsed.time) : fallback.time,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || "")) ? String(parsed.date) : fallback.date,
      lastSlot: Number(parsed.lastSlot) || 0
    };
    autoFlowScheduleCacheKey = key;
    autoFlowScheduleCache = normalized;
    return { ...normalized };
  } catch {
    return fallback;
  }
}

function autoFlowWriteSchedule(schedule: AutoFlowSchedule) {
  const key = autoFlowScheduleStorageKey();
  autoFlowScheduleCacheKey = key;
  autoFlowScheduleCache = { ...schedule };
  try {
    localStorage.setItem(key, JSON.stringify(schedule));
  } catch {
    // 配额满：本次会话内仍按内存里的配置不生效，界面会提示保存失败
    toast("定时设置没能保存到本机", "error");
  }
}

function autoFlowSlotAt(day: Date, time: string) {
  const [hh, mm] = time.split(":").map((part) => Number(part));
  const at = new Date(day);
  at.setHours(hh || 0, mm || 0, 0, 0);
  return at.getTime();
}

/** 最近一个「已经到点、还在补跑窗口内」的计划时间点 */
function autoFlowDueSlot(schedule: AutoFlowSchedule, now = Date.now()) {
  if (!schedule.enabled) return 0;
  if (schedule.repeat === "once") {
    const slot = autoFlowSlotAt(new Date(`${schedule.date}T00:00:00`), schedule.time);
    return slot <= now && now - slot <= AUTO_FLOW_SCHEDULE_GRACE_MS ? slot : 0;
  }
  for (const offset of [0, 1]) {
    const day = new Date(now);
    day.setDate(day.getDate() - offset);
    if (schedule.repeat === "weekdays" && (day.getDay() === 0 || day.getDay() === 6)) continue;
    const slot = autoFlowSlotAt(day, schedule.time);
    if (slot <= now && now - slot <= AUTO_FLOW_SCHEDULE_GRACE_MS) return slot;
  }
  return 0;
}

/** 下一次会在什么时候跑（界面显示用） */
function autoFlowNextSlot(schedule: AutoFlowSchedule, now = Date.now()) {
  if (!schedule.enabled) return 0;
  if (schedule.repeat === "once") {
    const slot = autoFlowSlotAt(new Date(`${schedule.date}T00:00:00`), schedule.time);
    return slot > now ? slot : 0;
  }
  for (let offset = 0; offset < 8; offset += 1) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    if (schedule.repeat === "weekdays" && (day.getDay() === 0 || day.getDay() === 6)) continue;
    const slot = autoFlowSlotAt(day, schedule.time);
    if (slot > now) return slot;
  }
  return 0;
}

function autoFlowSlotText(at: number) {
  if (!at) return "";
  const date = new Date(at);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${hm}`;
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`;
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  return `${date.getMonth() + 1}月${date.getDate()}日（${week}）${hm}`;
}

function autoFlowRepeatText(schedule: AutoFlowSchedule) {
  return schedule.repeat === "weekdays" ? `工作日 ${schedule.time}` : schedule.repeat === "once" ? `${schedule.date} ${schedule.time}` : `每天 ${schedule.time}`;
}

/** 到点：上一轮没结束就跳过；否则保留目标，从第 1 步开始一次跑完 */
function autoFlowFireSchedule(schedule: AutoFlowSchedule, slot: number) {
  schedule.lastSlot = slot;
  if (schedule.repeat === "once") schedule.enabled = false;
  autoFlowWriteSchedule(schedule);
  const state = autoFlowEnsure();
  if (!state.command.trim()) {
    autoFlowLog("warn", "定时运行跳过：还没有填写要找什么样的客户");
    autoFlowWrite();
    autoFlowSync();
    toast("自动流定时运行跳过：先在自动流页填写要找什么样的客户", "error");
    return;
  }
  if (state.activeKey || autoFlowSendPending || AUTO_FLOW_STEPS.some((step) => state.status[step.key] === "paused")) {
    autoFlowLog("warn", "定时运行跳过：上一轮还没结束（在运行或等你确认）");
    autoFlowWrite();
    autoFlowSync();
    toast("自动流定时运行跳过：上一轮还没结束");
    return;
  }
  autoFlowReset(false);
  const fresh = autoFlowEnsure();
  fresh.stepMode = false;
  autoFlowLog("start", `定时运行（${autoFlowRepeatText(schedule)}）：从第 1 步开始，一次跑完；到发送前会停下等你确认`);
  autoFlowWrite();
  autoFlowBeginStep(AUTO_FLOW_STEPS[0]!.key);
  toast(`自动流已按定时开始运行：${fresh.command.slice(0, 18)}${fresh.command.length > 18 ? "…" : ""}`);
}

function autoFlowScheduleTick() {
  if (!appState.user) return;
  const schedule = autoFlowReadSchedule();
  if (schedule.enabled) {
    const slot = autoFlowDueSlot(schedule);
    if (slot && slot !== schedule.lastSlot) autoFlowFireSchedule(schedule, slot);
  }
  if (qs<HTMLElement>("#afScheduleButton")) autoFlowRenderSchedule();
}

/** 应用启动时调用一次：不管当前在哪个页面，定时都会按时检查 */
export function startAutoFlowScheduler() {
  if (autoFlowScheduleTimer !== null) return;
  autoFlowScheduleTimer = window.setInterval(autoFlowScheduleTick, AUTO_FLOW_SCHEDULE_TICK_MS);
  // 页面从后台切回来时立刻补查一次（浏览器会冻结后台标签页的定时器）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") autoFlowScheduleTick();
  });
  window.addEventListener("pagehide", autoFlowWriteNow);
  window.setTimeout(autoFlowScheduleTick, 3_000);
}

/** 页头按钮文案 + 面板内容 */
function autoFlowRenderSchedule() {
  const schedule = autoFlowReadSchedule();
  const button = qs<HTMLButtonElement>("#afScheduleButton");
  if (button) {
    button.textContent = schedule.enabled ? `定时：${autoFlowRepeatText(schedule)}` : "定时运行";
    button.classList.toggle("is-on", schedule.enabled);
  }
  const next = qs<HTMLElement>("#afScheduleNext");
  if (next) {
    const at = autoFlowNextSlot(schedule);
    next.textContent = !schedule.enabled
      ? "未开启。开启后，到点会从第 1 步开始一次跑完，到发送前停下等你确认。"
      : at
        ? `下次运行：${autoFlowSlotText(at)}。CRM 页面开着（任意页面）就会按时开始。`
        : "这个时间已经过了，请重新选择日期或时间。";
    next.dataset.state = schedule.enabled && !at ? "warn" : schedule.enabled ? "on" : "off";
  }
}

function autoFlowFillScheduleForm() {
  const schedule = autoFlowReadSchedule();
  const enabled = qs<HTMLInputElement>("#afScheduleEnabled");
  const repeat = qs<HTMLSelectElement>("#afScheduleRepeat");
  const time = qs<HTMLInputElement>("#afScheduleTime");
  const date = qs<HTMLInputElement>("#afScheduleDate");
  if (enabled) enabled.checked = schedule.enabled;
  if (repeat) repeat.value = schedule.repeat;
  if (time) time.value = schedule.time;
  if (date) {
    date.value = schedule.date;
    date.min = autoFlowTodayText();
  }
  qs<HTMLElement>("#afScheduleDateField")?.toggleAttribute("hidden", schedule.repeat !== "once");
  autoFlowRenderSchedule();
}

function autoFlowSaveScheduleForm() {
  const previous = autoFlowReadSchedule();
  const repeat = (qs<HTMLSelectElement>("#afScheduleRepeat")?.value || "daily") as AutoFlowRepeat;
  const next: AutoFlowSchedule = {
    enabled: Boolean(qs<HTMLInputElement>("#afScheduleEnabled")?.checked),
    repeat,
    time: qs<HTMLInputElement>("#afScheduleTime")?.value || "09:00",
    date: qs<HTMLInputElement>("#afScheduleDate")?.value || autoFlowTodayText(),
    lastSlot: previous.lastSlot
  };
  if (next.enabled && !autoFlowEnsure().command.trim() && !(qs<HTMLInputElement>("#afCommandInput")?.value || "").trim()) {
    toast("先在上面填写要找什么样的客户，定时运行才知道搜什么", "error");
    qs<HTMLInputElement>("#afCommandInput")?.focus();
    return;
  }
  autoFlowSyncCommandFromDom(autoFlowEnsure());
  // 刚保存的时间点如果正好落在补跑窗口里，不要立刻触发：只从下一个时间点开始
  const due = autoFlowDueSlot(next);
  if (due) next.lastSlot = due;
  autoFlowWriteSchedule(next);
  autoFlowScheduleRemoteSync();
  autoFlowRenderSchedule();
  const at = autoFlowNextSlot(next);
  toast(next.enabled ? (at ? `定时已保存，下次运行：${autoFlowSlotText(at)}` : "定时已保存，但这个时间已经过了") : "定时运行已关闭");
  if (next.enabled) autoFlowLog("start", `已设置定时运行：${autoFlowRepeatText(next)}`);
  else autoFlowLog("warn", "已关闭定时运行");
  autoFlowWrite();
  autoFlowSync();
  if (at || !next.enabled) qs<HTMLElement>("#afSchedulePanel")?.setAttribute("hidden", "");
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
  if (!state.activeKey && autoFlowPickBlocked()) return;
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
  // 失败节点的「重试」= 从这一步开头重跑（任务号已在失败时清掉，不会复用坏任务）
  const failed = AUTO_FLOW_STEPS.find((item) => state.status[item.key] === "failed");
  if (failed) {
    autoFlowBeginStep(failed.key);
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
  const previous = autoFlowEnsure();
  const previousArtifacts = previous.artifacts;
  const hadArtifacts = Boolean(previousArtifacts && (previousArtifacts.opportunities.length || previousArtifacts.drafts.length));
  // 重置是破坏性操作：本轮进度、产物会当场清空，必须先讲清楚清什么。
  // 定时任务走 autoFlowReset(false)，不会弹窗（没人坐在屏幕前）。
  if (withLog && hadArtifacts) {
    const detail = [
      previousArtifacts!.opportunities.length ? `候选 ${previousArtifacts!.opportunities.length} 家` : "",
      Object.keys(previousArtifacts!.researched || {}).length ? `背调 ${Object.keys(previousArtifacts!.researched).length} 家` : "",
      previousArtifacts!.drafts.length ? `草稿 ${previousArtifacts!.drafts.length} 封` : "",
      previousArtifacts!.sent.length ? `发信记录 ${previousArtifacts!.sent.length} 条` : ""
    ].filter(Boolean).join("、");
    if (!window.confirm(`重置会清空本轮进度与产物：${detail}。\n\n本轮${previous.archivedAt === previous.runId ? "已经" : "会先"}归档成「未跑完」，可在右上角「任务归档」找回。继续？`)) return;
  }
  // 中途重置 / 从头重开：这一轮已经跑出来的候选和草稿也要留一条归档，否则这一轮就白跑了。
  // 必须传快照——下面马上会把全局状态换成空白的下一轮，异步归档不能再去读全局。
  if (previous.runId && previous.archivedAt !== previous.runId && hadArtifacts) {
    void autoFlowArchiveRun("abandoned", previous);
  }
  const previousCommand = previous.command;
  const previousStepMode = Boolean(previous.stepMode);
  const previousTarget = previous.targetCount || AUTO_FLOW_TARGET_DEFAULT;
  // 发信邮箱是偏好设置，不是本轮数据：重置后沿用，免得每轮都要重选
  const previousSender = previous.senderEmail || "";
  const previousSenderEvery = previous.senderRotateEvery || AUTO_FLOW_ROTATE_EVERY_DEFAULT;
  autoFlowRunToken += 1;
  autoFlowStopTimers();
  autoFlowPauseRequested = false;
  autoFlowSendPending = false;
  autoFlowClearWait();
  autoFlowState = autoFlowInitialState();
  // 重置只清本轮产物与进度，**目标条件保留**：想换一批客户的人直接改输入框即可，
  // 想重跑的人不用把需求再打一遍（以前清空输入框，重置后还得重新描述一次）。
  autoFlowState.targetCount = previousTarget;
  autoFlowState.senderEmail = previousSender;
  autoFlowState.senderRotateEvery = previousSenderEvery;
  autoFlowState.command = previousCommand;
  // 步进模式是用户的工作方式，不是本轮数据：重置不该把它静默关掉，
  // 否则下一次点「开始运行」会一路跑到发送，和用户预期正好相反。
  autoFlowState.stepMode = previousStepMode;
  autoFlowRenderedLogCount = 0;
  // 焦点、监控快照、结果缓存都是「上一轮视角」的残留：不清的话重置后详情区还停在第 5 步、
  // 监控面板还挂着上一批的数字，看着像新一轮已经在监控。
  autoFlowFocusPinned = false;
  autoFlowFocusKey = null;
  autoFlowStageKey = null;
  autoFlowMonitorData = null;
  autoFlowMonitorError = "";
  autoFlowInvalidateResults();
  if (withLog) {
    const input = qs<HTMLInputElement>("#afCommandInput");
    if (input) input.value = previousCommand;
    autoFlowLog("warn", previousCommand
      ? `已重置：本轮产物与进度已清空${hadArtifacts ? "，上一轮已归档，可在「任务归档」找回" : "（这一轮还没有候选或草稿，没有可归档的内容）"}，找客户的目标保留在输入框里，点「开始运行」就能重新跑一轮`
      : "已重置，全部节点回到待执行");
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
  const count = qs<HTMLSelectElement>("#afTargetCount");
  if (count) count.value = String(state.targetCount || AUTO_FLOW_TARGET_DEFAULT);
  autoFlowRenderSenderControl();
  if (document.activeElement === input) return;
  // 状态为空时不要清空输入框：用户可能刚打完字还没回写，或另一个标签页重置过。
  // 清空会让「界面有字、状态为空」这个 bug 更隐蔽，交给 autoFlowSyncCommandFromDom 在启动时回写。
  if (state.command) input.value = state.command;
}

// ---------- 发信邮箱：本轮用账号主邮箱、池内某个邮箱，还是按封数轮换 ----------
interface AutoFlowMailboxOption {
  id: string;
  label: string;
  email: string;
  enabled: boolean;
  dailyLimit?: number;
  hasSmtpPassword?: boolean;
}

let autoFlowMailboxes: AutoFlowMailboxOption[] = [];
let autoFlowMailboxLoaded = false;
let autoFlowMailboxLoadedAt = 0;
let autoFlowMailboxLoading = false;

async function loadAutoFlowMailboxes(force = false) {
  if (autoFlowMailboxLoading) return;
  // 一分钟内不重复拉：邮箱池可能在个人设置里改过，切回本页要能刷新到
  if (autoFlowMailboxLoaded && !force && Date.now() - autoFlowMailboxLoadedAt < 60_000) {
    autoFlowRenderSenderControl();
    return;
  }
  autoFlowMailboxLoading = true;
  try {
    const payload = await api<{ mailboxes?: AutoFlowMailboxOption[] }>("/api/sender-mailboxes");
    // 没有 SMTP 授权码的邮箱发不出信，不列出来误导用户
    autoFlowMailboxes = (payload.mailboxes || []).filter((row) => row && row.email && row.hasSmtpPassword !== false);
    autoFlowMailboxLoaded = true;
    autoFlowMailboxLoadedAt = Date.now();
  } catch {
    // 拉不到池子就只保留「账号主邮箱」，发送本身不受影响
    autoFlowMailboxes = [];
  } finally {
    autoFlowMailboxLoading = false;
    autoFlowRenderSenderControl();
    autoFlowRenderStage();
  }
}

function autoFlowEnabledMailboxes() {
  return autoFlowMailboxes.filter((row) => row.enabled && row.email);
}

/** 发信身份的人话描述：界面只显示这个，不显示 "rotate" 之类的内部值 */
function autoFlowSenderLabel(setting = autoFlowEnsure().senderEmail || "") {
  const value = (setting || "").trim();
  if (!value) return "账号主发件邮箱";
  if (value === "rotate") {
    const pool = autoFlowEnabledMailboxes();
    const every = autoFlowEnsure().senderRotateEvery || AUTO_FLOW_ROTATE_EVERY_DEFAULT;
    return pool.length
      ? `池内轮换 · 每 ${every} 封换一个（共 ${pool.length} 个邮箱）`
      : "池内轮换（池里没有启用的邮箱，将用账号主发件邮箱）";
  }
  const mailbox = autoFlowMailboxes.find((row) => row.email.toLowerCase() === value.toLowerCase());
  if (!mailbox) return `${value}（已不在发件邮箱池）`;
  return `${mailbox.label || mailbox.email} · ${mailbox.email}${mailbox.enabled ? "" : "（已停用）"}`;
}

function autoFlowRenderSenderControl() {
  const state = autoFlowEnsure();
  const current = (state.senderEmail || "").trim();
  const known = autoFlowMailboxes.some((row) => row.email.toLowerCase() === current.toLowerCase());
  const options = [
    `<option value="">账号主发件邮箱</option>`,
    ...autoFlowMailboxes.map((row) => {
      const selected = current && current.toLowerCase() === row.email.toLowerCase();
      return `<option value="${escapeHtml(row.email)}"${selected ? " selected" : ""}${row.enabled ? "" : " disabled"}>${escapeHtml(row.label || row.email)} · ${escapeHtml(row.email)}${row.enabled ? "" : "（已停用）"}</option>`;
    }),
    `<option value="rotate"${current === "rotate" ? " selected" : ""}>按封数轮换</option>`
  ];
  // 之前选的邮箱已经从池里删掉：保留一条「已不在池」的选项，发送前会明确拦下而不是悄悄换主邮箱
  if (current && current !== "rotate" && !known) {
    options.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（已不在邮箱池）</option>`);
  }
  const html = options.join("");
  // 顶部命令栏与发送确认区各有一个选择器，两边共用同一份状态
  for (const select of qsa<HTMLSelectElement>("[data-af-sender-select]")) {
    select.innerHTML = html;
    select.value = current;
  }
  const showEvery = current === "rotate";
  for (const wrap of qsa<HTMLElement>("[data-af-sender-every]")) {
    wrap.hidden = !showEvery;
    // hidden 属性会被 display:inline-flex 压住，必须同时切内联样式
    wrap.style.display = showEvery ? "" : "none";
  }
  for (const every of qsa<HTMLSelectElement>("[data-af-sender-every-select]")) {
    every.value = String(state.senderRotateEvery || AUTO_FLOW_ROTATE_EVERY_DEFAULT);
  }
}

/**
 * 发送前的发信邮箱自检。选的是池内某个邮箱但它已被删除/停用时直接报错，
 * 避免「悄悄回落到主邮箱」把客户信从错误的身份发出去。
 */
function autoFlowAssertSenderReady() {
  const state = autoFlowEnsure();
  const setting = (state.senderEmail || "").trim();
  if (!setting) return;
  if (setting === "rotate") {
    if (autoFlowMailboxLoaded && !autoFlowEnabledMailboxes().length) {
      autoFlowLog("warn", "发件邮箱池里没有启用的邮箱，本轮改用账号主发件邮箱");
    }
    return;
  }
  if (!autoFlowMailboxLoaded) return; // 池子还没拉到 → 交给后端校验
  const mailbox = autoFlowMailboxes.find((row) => row.email.toLowerCase() === setting.toLowerCase());
  if (!mailbox) throw new Error(`选定的发信邮箱 ${setting} 已不在发件邮箱池里，请在上方「发信用」重新选择`);
  if (!mailbox.enabled) throw new Error(`选定的发信邮箱 ${setting} 已停用，请在上方「发信用」换一个`);
}

/** 本轮第 index 封信该用哪个发件邮箱；空串 = 账号主发件邮箱。
 *  sentOkBefore = 进入本轮发送前已成功的封数（必须在循环外取一次：
 *  artifacts.sent 每发一封就变长，循环里现取会把封数算两遍）。 */
function autoFlowSenderForIndex(index: number, sentOkBefore: number): string {
  const state = autoFlowEnsure();
  const setting = (state.senderEmail || "").trim();
  if (!setting) return "";
  if (setting !== "rotate") return setting;
  const pool = autoFlowEnabledMailboxes();
  if (!pool.length) return "";
  const every = Math.max(1, Math.floor(Number(state.senderRotateEvery) || AUTO_FLOW_ROTATE_EVERY_DEFAULT));
  return pool[Math.floor((sentOkBefore + index) / every) % pool.length]!.email;
}

/**
 * 旧版本缓存兼容：r73 及以前的 artifacts 每家只存 id / company / email，
 * 升级后新界面读 country / business / website 全是空，于是整张表显示
 * 「未知国家 / 暂无业务描述」——数据其实都在服务端，只是缓存里没有。
 * 打开页面时按 id 从候选接口补齐一次，用户不必重跑获客。
 */
let autoFlowBackfillDone = false;
async function autoFlowBackfillCandidates() {
  if (autoFlowBackfillDone) return;
  const artifacts = autoFlowEnsure().artifacts!;
  const list = artifacts.opportunities;
  if (!list.length) return;
  if (!list.some((item) => !item.country || !item.business || !item.website)) return;
  autoFlowBackfillDone = true;
  try {
    const response = await api<{ opportunities?: Array<{
      id: string; country?: string; business?: string; website?: string; contact?: string;
    }> }>("/api/tools/website-opportunities");
    const byId = new Map((response?.opportunities || []).map((row) => [row.id, row]));
    let changed = false;
    for (const item of list) {
      const row = byId.get(item.id);
      if (!row) continue;
      if (!item.country && row.country) { item.country = row.country; changed = true; }
      if (!item.business && row.business) { item.business = row.business; changed = true; }
      if (!item.website && row.website) { item.website = row.website; changed = true; }
      if (!item.contact && row.contact) { item.contact = row.contact; changed = true; }
    }
    if (changed) {
      autoFlowWrite();
      autoFlowRenderPick();
    }
  } catch {
    // 补齐失败不影响主流程：列表照旧显示，下次打开再试一次
    autoFlowBackfillDone = false;
  }
}

export function renderAutoFlow() {
  const track = qs<HTMLElement>("#afTrack");
  if (!track) return;
  autoFlowEnsure();
  autoFlowArchiveIfFinished();
  void autoFlowBackfillCandidates();
  void loadAutoFlowMailboxes();
  void loadAutoFlowRuns(true);
  // 第 5 步的数字要在节点卡片上就可见（打开 x / 已发 y），不必先点进这一步
  void loadAutoFlowMonitor().then(() => autoFlowSyncResultCounts());
  autoFlowRenderCommand();

  if (track.dataset.built !== "1") {
    track.innerHTML = AUTO_FLOW_STEPS.map((step, index) => autoFlowNodeHtml(step, index)).join("");
    track.dataset.built = "1";
    autoFlowFlash(track, "af-intro", 1700);
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
    // 第 5 步详情区里的「刷新 / 打开监控明细」：面板每次重绘都换节点，绑在 #afStage 上做委托
    qs<HTMLElement>("#afStage")?.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-af-monitor]")?.dataset.afMonitor;
      if (action === "refresh") void autoFlowRefreshMonitorStage(true);
      else if (action === "open") activateNavView("auto-flow-history");
      else if (action === "rearchive") void autoFlowManualRearchive();
      else if (action === "imap") {
        // 回复 / 退信靠 IMAP 收信监听，入口在邮件中心设置页的账号配置里
        activateNavView("mail-settings");
        window.setTimeout(() => {
          qs<HTMLElement>("#profileImapEnabled")?.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 200);
      }
    });
    // 通知总结：刷新 / 展开邮箱明细 / 去配置企业微信（事件委托，面板重绘不丢）
    qs<HTMLElement>("#afNotify")?.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-af-notify]")?.dataset.afNotify;
      if (action === "refresh") {
        void autoFlowRefreshNotify(true);
        return;
      }
      if (action === "email") {
        autoFlowNotifyExtraOpen = !autoFlowNotifyExtraOpen;
        autoFlowRenderNotify();
        return;
      }
      if (action === "wecom") autoFlowOpenWecomSettings();
    });
    // 定时运行
    qs<HTMLButtonElement>("#afScheduleButton")?.addEventListener("click", () => {
      const panel = qs<HTMLElement>("#afSchedulePanel");
      if (!panel) return;
      const opening = panel.hasAttribute("hidden");
      panel.toggleAttribute("hidden", !opening);
      qs<HTMLButtonElement>("#afScheduleButton")?.setAttribute("aria-expanded", String(opening));
      if (opening) {
        autoFlowFillScheduleForm();
        qs<HTMLInputElement>("#afScheduleTime")?.focus();
      }
    });
    qs<HTMLSelectElement>("#afScheduleRepeat")?.addEventListener("change", (event) => {
      qs<HTMLElement>("#afScheduleDateField")?.toggleAttribute("hidden", (event.currentTarget as HTMLSelectElement).value !== "once");
    });
    qs<HTMLButtonElement>("#afScheduleSave")?.addEventListener("click", () => autoFlowSaveScheduleForm());
    qs<HTMLButtonElement>("#afScheduleCancel")?.addEventListener("click", () => {
      qs<HTMLElement>("#afSchedulePanel")?.setAttribute("hidden", "");
      qs<HTMLButtonElement>("#afScheduleButton")?.setAttribute("aria-expanded", "false");
    });
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
    qs<HTMLSelectElement>("#afTargetCount")?.addEventListener("change", (event) => {
      const state = autoFlowEnsure();
      state.targetCount = Number((event.currentTarget as HTMLSelectElement).value) || AUTO_FLOW_TARGET_DEFAULT;
      autoFlowWrite();
      autoFlowRenderStage();
    });
    // 发信邮箱：顶部命令栏与发送确认区两个选择器共用同一份状态（委托到 document，
    // 确认区每次重渲染都会换节点，绑在节点上会丢）
    document.addEventListener("change", (event) => {
      const target = event.target as HTMLElement | null;
      const sender = target?.closest<HTMLSelectElement>("[data-af-sender-select]");
      if (sender) {
        const state = autoFlowEnsure();
        state.senderEmail = sender.value || "";
        autoFlowWrite();
        autoFlowRenderSenderControl();
        autoFlowRenderStage();
        return;
      }
      const every = target?.closest<HTMLSelectElement>("[data-af-sender-every-select]");
      if (every) {
        const state = autoFlowEnsure();
        state.senderRotateEvery = AUTO_FLOW_ROTATE_EVERY_OPTIONS.includes(Number(every.value))
          ? Number(every.value)
          : AUTO_FLOW_ROTATE_EVERY_DEFAULT;
        autoFlowWrite();
        autoFlowRenderSenderControl();
        autoFlowRenderStage();
      }
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
    // 停靠点：继续 / 一次跑完剩余 / 查看完整结果
    qs<HTMLElement>("#afCheckpoint")?.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-af-cp]");
      if (!action) return;
      if (action.dataset.afCp === "continue") autoFlowStart();
      else if (action.dataset.afCp === "finish") autoFlowToggleStepMode();
      else if (action.dataset.afCp === "back" && action.dataset.key) autoFlowStepBack(action.dataset.key);
      else if (action.dataset.afCp === "restart") {
        autoFlowReset();
        // 目标为空时别把第 1 步判成失败：先把人引到输入框
        if (!autoFlowEnsure().command.trim()) {
          toast("先写一句要找什么客户，再从头开始", "error");
          qs<HTMLInputElement>("#afCommandInput")?.focus();
        } else {
          autoFlowStart();
        }
      }
      else if (action.dataset.afCp === "view" && action.dataset.key) void autoFlowShowResult(action.dataset.key);
    });
    // 键盘：节点可聚焦，回车 = 点击
    track.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const node = (event.target as HTMLElement | null)?.closest<HTMLElement>(".af-node");
      if (!node || event.target !== node) return;
      event.preventDefault();
      node.click();
    });
    // 详情区里的「打开」直达真实模块
    qs<HTMLElement>("#afResult")?.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      if (!autoFlowCanEditPick()) return;
      if (input.matches("[data-af-pick-all]")) {
        autoFlowApplyPick(input.checked ? autoFlowEnsure().artifacts!.opportunities.map((item) => item.id) : []);
        return;
      }
      if (input.matches("[data-af-pick]")) {
        const ids = qsa<HTMLInputElement>("#afResult [data-af-pick]").filter((item) => item.checked).map((item) => item.dataset.afPick || "");
        autoFlowApplyPick(ids);
      }
    });
    const draftFromEvent = (event: Event) => {
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-af-draft]");
      if (!row?.dataset.afDraft) return false;
      openAutoFlowDraftEditor(row.dataset.afDraft);
      return true;
    };
    qs<HTMLElement>("#afResult")?.addEventListener("input", (event) => {
      const target = event.target as HTMLTextAreaElement;
      if (target.id !== "afComposeGoal") return;
      autoFlowEnsure().artifacts!.composeGoal = target.value.trim();
      autoFlowWrite();
    });
    const reportFromEvent = (event: Event) => {
      if (draftFromEvent(event)) return true;
      if ((event.target as HTMLElement | null)?.closest("[data-af-regen-all]")) {
        void autoFlowRegenerateAll();
        return true;
      }
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-af-report]");
      if (!row?.dataset.afReport) return false;
      if ((event.target as HTMLElement).closest("a")) return false;
      void openAutoFlowReport(row.dataset.afReport);
      return true;
    };
    qs<HTMLElement>("#afResult")?.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter" && reportFromEvent(event)) event.preventDefault();
    });
    qs<HTMLElement>("#afStage")?.addEventListener("click", (event) => { reportFromEvent(event); });
    qs<HTMLElement>("#afResult")?.addEventListener("click", (event) => {
      if (reportFromEvent(event)) return;
      if ((event.target as HTMLElement | null)?.closest("[data-af-excel-import]")) {
        autoFlowPickExcel();
        return;
      }
      if ((event.target as HTMLElement | null)?.closest("[data-af-pick-go]")) {
        autoFlowStart();
        return;
      }
      if ((event.target as HTMLElement | null)?.closest("[data-af-close]") && autoFlowResultKey) {
        void autoFlowToggleResult(autoFlowResultKey);
        return;
      }
      const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-open]");
      const target = trigger?.dataset.open || "";
      if (target) activateNavView(target);
    });
    qs<HTMLElement>("#afStage")?.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-open]");
      const view = target?.dataset.open || "";
      if (view) activateNavView(view);
      const more = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-af-stage-more]");
      if (more?.dataset.afStageMore) {
        void autoFlowShowResult(more.dataset.afStageMore);
        return;
      }
      const action = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-af-action]");
      if (action) autoFlowConfirmSend(action.dataset.afAction === "send-confirm");
    });
  }

  autoFlowRenderStage();
  autoFlowRenderSchedule();
  startAutoFlowScheduler();
  void autoFlowPullRemoteState();

  autoFlowSyncLive();
  autoFlowSyncResultCounts();
  if (!autoFlowLive) void loadAutoFlowLive();
  startAutoFlowFeed();
  autoFlowRenderNotify();
  startAutoFlowMonitor();

  autoFlowSync();

  const state = autoFlowEnsure();
  if (state.activeKey && state.status[state.activeKey] === "running") autoFlowResumeActive();
}
