/**
 * 发信批次、自动发送方案、发信明细与开发信档案。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, confirmAction, openBackgroundResearch, openModal, state } from "../prototype-api";
import { prospectRequestId } from "./prospecting";
import { badge, escapeHtml, qs, qsa } from "./shared";
import { renderCustomerDetailPage } from "./customer-detail";
import { researchButtonIcon } from "./development-email";
import { api, setButtonPending, toast } from "./ui";
import { formatDateTime } from "./deals";

// ---------------------------------------------------------------------------
// W4 · 发信批次：批次列表 + 预览/冻结放行
// ---------------------------------------------------------------------------

interface OutreachBatchStepView {
  index: number;
  subject: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt: string;
  error: string;
  /** 这一封按哪个阶段的蓝图写成（阶段感知序列才有） */
  stageKey?: string;
  stageLabel?: string;
}

interface OutreachBatchItemView {
  id: string;
  candidateId: string;
  /** targetType=lead 的批次里记录对应线索 id */
  leadId?: string;
  /** 方案手动名单模式的来源类型（缺省 = candidate） */
  entityType?: "candidate" | "lead" | "customer";
  company: string;
  recipient: string;
  status: "ready" | "skipped" | "removed" | "sending" | "sent" | "failed" | "stopped";
  skipReason: string;
  steps: OutreachBatchStepView[];
  sentAt: string;
  convertedLeadId: string;
  /** 推导（或人工覆盖）出的客户开发阶段；决定这一条从第几封开始发 */
  stageKey?: string;
  stageLabel?: string;
  stageSource?: "derived" | "manual";
  /** 本次成稿引用的背调留档 */
  researchId?: string;
  researchScore?: number;
  /** 正文补写状态：pending 表示正在补背调/重写，发送端会等它（有超时兜底） */
  letterStatus?: "pending" | "ready" | "failed";
  letterEngine?: string;
  letterBasis?: string;
  letterNote?: string;
}

export interface OutreachBatchView {
  id: string;
  status: string;
  targetType?: "candidate" | "lead";
  policy: { dailyLimit: number; stepIntervalHours: number; sendWindowStartHour: number; sendWindowEndHour: number; stopOnReply: boolean; autoResearch?: boolean };
  items: OutreachBatchItemView[];
  counts: { total: number; frozen: number; skipped: number };
  /** 后端算好的正文补写进度；缺省时前端按同一口径兜底计算 */
  letterProgress?: { total: number; pending: number; ready: number; failed: number; withResearch: number };
  frozenHash: string;
  approvedAt: string;
  pauseReason: string;
  nextSendAt: string;
  createdAt: string;
}

const OUTREACH_BATCH_STATUS_META: Record<string, { label: string; tone: string }> = {
  draft: { label: "待确认", tone: "amber" },
  approved: { label: "定期投递中", tone: "green" },
  paused: { label: "已暂停", tone: "amber" },
  completed: { label: "已完成", tone: "green" },
  cancelled: { label: "已取消", tone: "gray" }
};

// ---------------------------------------------------------------------------
// 开发阶段徽标 + 成稿依据（批次明细行 / 方案明细行共用）
//
// 批量链路现在按「每个收件人自己的阶段」写信，界面上必须能看出两件事：
//   ① 这条是沿着客户**当前**阶段往下走的（而不是一律从首触发起）；
//   ② 这封信的正文是怎么来的（引用了哪次背调、由谁写的）。
// 两处各写一份必然漂移，所以统一放这里。
// ---------------------------------------------------------------------------

const OUTREACH_STAGE_TONE: Record<string, string> = {
  not_contacted: "gray",
  first_touch_sent: "blue",
  following_up: "amber",
  replied_interested: "green",
  replied_negative: "red",
  bounced: "red",
  converted: "green"
};

/** 阶段徽标：人工覆盖过的阶段会额外标「人工」，避免和系统推导混淆 */
function outreachStageBadge(source: { stageKey?: string; stageLabel?: string; stageSource?: string }): string {
  if (!source.stageKey && !source.stageLabel) return "";
  const label = source.stageLabel || source.stageKey || "";
  const tone = OUTREACH_STAGE_TONE[source.stageKey || ""] || "gray";
  return badge(`${escapeHtml(label)}${source.stageSource === "manual" ? " · 人工" : ""}`, tone);
}

/** 正文补写状态：还没写完的条目在界面上要看得见，否则用户会以为"点开始就发出去了" */
const OUTREACH_LETTER_STATUS_META: Record<string, { label: string; tone: string }> = {
  pending: { label: "正文补写中", tone: "amber" },
  ready: { label: "正文已就绪", tone: "green" },
  failed: { label: "正文退回模板", tone: "gray" }
};

function outreachLetterStatusBadge(item: { letterStatus?: string; researchId?: string }): string {
  if (!item.letterStatus) return item.researchId ? badge("已引用背调", "blue") : "";
  const meta = OUTREACH_LETTER_STATUS_META[item.letterStatus] || { label: item.letterStatus, tone: "gray" };
  return badge(meta.label, meta.tone);
}

/** 成稿依据一行：引擎 + 背调评分 + 依据说明（悬停看全文） */
function outreachLetterBasisNote(item: {
  letterEngine?: string; letterBasis?: string; letterNote?: string; researchScore?: number;
}): string {
  const bits: string[] = [];
  if (item.letterEngine) bits.push(item.letterEngine);
  if (typeof item.researchScore === "number") bits.push(`背调 ${item.researchScore} 分`);
  const detail = [item.letterBasis, item.letterNote].filter(Boolean).join(" · ");
  if (!bits.length && !detail) return "";
  const title = escapeHtml([bits.join(" · "), detail].filter(Boolean).join("："));
  return `<span class="ob-note" title="${title}">${escapeHtml(bits.join(" · ") || detail)}</span>`;
}

/** 阶段下拉（草稿批次可就地改这一条的口径）：只在草稿批次、正文就绪、且未投递过时出现 */
function outreachStageSelect(item: OutreachBatchItemView, batch: OutreachBatchView): string {
  if (batch.status !== "draft") return "";
  if (item.status !== "ready") return "";
  if (item.steps.some((step) => step.status !== "pending" && step.status !== "skipped")) return "";
  // 空值 = 撤销人工覆盖，回到系统推导；只有人工改过时才选中具体阶段，否则默认停在「按系统推导」
  const current = item.stageSource === "manual" ? (item.stageKey || "") : "";
  const options = [
    ["", "按系统推导"],
    ["not_contacted", "未接触"],
    ["first_touch_sent", "已发首触"],
    ["following_up", "跟进中"]
  ];
  return `<label class="ob-stage-select" title="${escapeHtml(
    item.stageSource === "manual"
      ? "已人工指定；选「按系统推导」可撤销，回到按触达记录自动判定的阶段"
      : "系统没抓到对方的变化时，可以在这里临时改这一条的口径"
  )}">
    <span>阶段</span>
    <select data-item-stage="${item.id}">
      ${options.map(([value, label]) => `<option value="${value}"${current === value ? " selected" : ""}>${label}</option>`).join("")}
    </select>
  </label>`;
}

// ---------------------------------------------------------------------------
// 自动发送方案（后台任务）
// ---------------------------------------------------------------------------

interface OutreachPlanStepLite { index: number; status: string; sentAt: string; stageKey?: string; stageLabel?: string }
interface OutreachPlanItemLite {
  id: string; candidateId: string; company: string; recipient: string;
  status: string; skipReason: string; sentAt: string; convertedLeadId: string;
  entityType?: "candidate" | "lead" | "customer";
  stageKey?: string; stageLabel?: string; stageSource?: "derived" | "manual";
  researchId?: string; researchScore?: number;
  letterStatus?: "pending" | "ready" | "failed"; letterEngine?: string; letterBasis?: string; letterNote?: string;
  stepStatuses: OutreachPlanStepLite[];
}
interface OutreachPlanLetterProgress { total: number; pending: number; ready: number; failed: number; withResearch: number }
interface OutreachPlanProgress {
  total: number; sent: number; sentSteps: number; failed: number; stopped: number;
  skipped: number; inProgress: number; converted: number; pendingSteps: number; targetCap: number;
  letters?: OutreachPlanLetterProgress;
}
interface OutreachPlanView {
  id: string;
  name: string;
  status: "running" | "paused" | "stopped" | "completed";
  target: {
    countries: string[]; keyword: string; maxTargets: number;
    mode?: "rules" | "manual";
    entries?: Array<{ entityType: "candidate" | "lead" | "customer"; entityId: string }>;
  };
  steps?: Array<{ subject: string; body: string }>;
  policy: { dailyLimit: number; stepIntervalHours: number; sendWindowStartHour: number; sendWindowEndHour: number; stopOnReply: boolean; rotateMailboxEvery?: number };
  pauseReason: string;
  nextRunAt: string;
  lastRunAt: string;
  lastMessage: string;
  createdAt: string;
  updatedAt: string;
  progress: OutreachPlanProgress;
  recentItems: OutreachPlanItemLite[];
}

const OUTREACH_PLAN_STATUS_META: Record<string, { label: string; tone: string }> = {
  running: { label: "运行中", tone: "green" },
  paused: { label: "已暂停", tone: "amber" },
  stopped: { label: "已停止", tone: "gray" },
  completed: { label: "已完成", tone: "green" }
};

let outreachPlans: OutreachPlanView[] = [];
let outreachPlanPollTimer: ReturnType<typeof setTimeout> | null = null;

function stopOutreachPlanPolling() {
  if (outreachPlanPollTimer) {
    clearTimeout(outreachPlanPollTimer);
    outreachPlanPollTimer = null;
  }
}

function scheduleOutreachPlanPolling() {
  stopOutreachPlanPolling();
  const hasActive = outreachPlans.some((plan) => plan.status === "running" || plan.status === "paused");
  const isActiveView = document.querySelector("#outreach-batches.active") !== null
    || document.querySelector('.nav-item[data-view="outreach-batches"].active') !== null;
  if (hasActive && isActiveView) {
    outreachPlanPollTimer = setTimeout(() => void loadOutreachPlans(), 15_000);
  }
}

export async function loadOutreachPlans() {
  try {
    const result = await api<{ plans: OutreachPlanView[] }>("/api/outreach-plans?limit=50");
    outreachPlans = result.plans || [];
    renderOutreachPlans();
  } catch {
    // 方案加载失败不阻塞批次区域
  } finally {
    scheduleOutreachPlanPolling();
  }
}

/** 数字滚动记忆：同一个 key 首次出现时从 0 滚上来，之后只在数值变化时滚动并闪一下。
    渲染用的是 innerHTML 重建，所以动画靠「记住上一次的值」驱动，而不是靠 DOM 复用。 */
const outreachNumberMemory = new Map<string, number>();

/** 生成一个会被 animateOutreachNumbers() 接管的数字节点（key 必须在整页唯一且稳定）。
    tag 默认 b（沿用卡片里原有的加粗），摘要这类纯文本容器传 span 以免改变排版。 */
function outreachNumberHtml(key: string, value: number, tag = "b"): string {
  return `<${tag} data-ob-num="${escapeHtml(key)}" data-ob-val="${value}">${value}</${tag}>`;
}

/** 驱动 root 内所有 [data-ob-num]：滚动到新值；数值有变化时额外闪一下（绿色渐隐） */
function animateOutreachNumbers(root: HTMLElement | null) {
  if (!root) return;
  const reduce = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  qsa<HTMLElement>("[data-ob-num]", root).forEach((node) => {
    const key = node.dataset.obNum || "";
    const target = Number(node.dataset.obVal || "0");
    const previous = outreachNumberMemory.get(key);
    outreachNumberMemory.set(key, target);
    if (reduce || previous === target) return;
    const from = previous === undefined ? 0 : previous;
    const duration = previous === undefined ? 620 : 420;
    const start = performance.now();
    const tick = (now: number) => {
      const ratio = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - ratio, 3);
      if (ratio < 1) {
        node.textContent = String(Math.round(from + (target - from) * eased));
        requestAnimationFrame(tick);
        return;
      }
      node.textContent = String(target);
      if (previous === undefined) return;
      node.classList.remove("is-flash");
      void node.offsetWidth; // 强制重排，保证同一个 class 能再次触发动画
      node.classList.add("is-flash");
    };
    node.textContent = String(from);
    requestAnimationFrame(tick);
  });
}

function outreachPlanProgressTrack(progress: OutreachPlanProgress): string {
  const cap = Math.max(progress.targetCap, progress.total, 1);
  let segmentIndex = 0;
  const seg = (count: number, cls: string) => {
    if (count <= 0) return "";
    const index = segmentIndex++;
    return `<i class="${cls}" style="width:${((count / cap) * 100).toFixed(1)}%;--ob-seg:${index}"></i>`;
  };
  return `<div class="ob-plan-track" title="已发 ${progress.sentSteps} 封 / 待发 ${progress.pendingSteps} 封 / 完成 ${progress.sent} 人 / 失败 ${progress.failed} / 跳过 ${progress.skipped} / 目标上限 ${progress.targetCap}">
    ${seg(progress.sent, "bar-sent")}${seg(progress.inProgress, "bar-progress")}${seg(progress.failed, "bar-failed")}${seg(progress.skipped, "bar-skipped")}
  </div>`;
}

/** 发信通道状态条：只在通道未配置完整（会导致真发失败）时出现；配置正常时不占位置、不提示 */
function renderOutreachSendChannelNote() {
  const node = qs<HTMLElement>("#outreachSendChannelNote");
  if (!node) return;
  const user = state.user;
  const from = user?.outboundEmail || user?.smtpUser || "";
  const host = user?.smtpHost || "";
  const ready = Boolean(from && host && user?.smtpUser && user?.hasSmtpPassword);
  if (ready) {
    node.hidden = true;
    node.className = "ob-channel-note";
    node.innerHTML = "";
    return;
  }
  node.hidden = false;
  node.className = "ob-channel-note is-missing";
  node.innerHTML = `<b>发信通道未配置完整：</b>请到「邮件中心 → 邮箱设置」补全发件邮箱、SMTP 服务器与授权码；否则方案取到人后会在发送这一步失败（失败原因会写在方案卡片的运行状态里）。`;
}

function renderOutreachPlans() {
  const listBox = qs<HTMLElement>("#outreachPlanList");
  if (!listBox) return;
  bindOutreachPlanCreateButton();
  renderOutreachSendChannelNote();
  if (!outreachPlans.length) {
    listBox.innerHTML = `<div class="empty-cell ob-plan-empty">
      <b>还没有自动发送方案</b>
      <button class="btn primary" type="button" data-plan-create>新建自动发送方案</button>
    </div>`;
    qsa<HTMLButtonElement>("[data-plan-create]", listBox).forEach((button) =>
      button.addEventListener("click", () => openOutreachPlanModal()));
    return;
  }
  listBox.innerHTML = outreachPlans.map((plan, index) => {
    const meta = OUTREACH_PLAN_STATUS_META[plan.status] || { label: plan.status, tone: "gray" };
    const progress = plan.progress;
    const scope = plan.target.mode === "manual"
      ? `手动名单 ${plan.target.entries?.length || 0} 人${plan.steps?.length ? ` · 自定义内容 ${plan.steps.length} 步` : ""}`
      : [
        progress.targetCap ? `目标上限 ${progress.targetCap} 人` : "",
        plan.target.countries.length ? `国家：${plan.target.countries.join("、")}` : "国家不限",
        plan.target.keyword ? `关键词「${plan.target.keyword}」` : ""
      ].filter(Boolean).join(" · ");
    const rhythm = `每天最多 ${plan.policy.dailyLimit} 封 · 每日 ${plan.policy.sendWindowStartHour}:00–${plan.policy.sendWindowEndHour}:00 · 同一客户间隔 ${plan.policy.stepIntervalHours}h${plan.policy.stopOnReply ? " · 回复即停" : ""}${plan.policy.rotateMailboxEvery ? ` · 每 ${plan.policy.rotateMailboxEvery} 封轮换发件邮箱` : ""}`;
    const counts = `已发 ${outreachNumberHtml(`plan:${plan.id}:sentSteps`, progress.sentSteps)} 封 · 待发 ${outreachNumberHtml(`plan:${plan.id}:pending`, progress.pendingSteps)} 封 · 失败 ${outreachNumberHtml(`plan:${plan.id}:failed`, progress.failed)} · 跳过 ${outreachNumberHtml(`plan:${plan.id}:skipped`, progress.skipped)}${progress.sent ? ` · 完成 ${outreachNumberHtml(`plan:${plan.id}:sent`, progress.sent)} 人` : ""}${progress.converted ? ` · 已回流线索 ${outreachNumberHtml(`plan:${plan.id}:converted`, progress.converted)}` : ""}`;
    const nextRun = plan.status === "running" && plan.nextRunAt
      ? `<span class="ob-next-send">下一封 ${escapeHtml(formatDateTime(plan.nextRunAt))}</span>` : "";
    const actions = [`<button class="btn tiny" data-plan-detail="${escapeHtml(plan.id)}">详情</button>`];
    if (plan.status === "running") actions.push(`<button class="btn tiny" data-plan-control="${escapeHtml(plan.id)}" data-plan-action="pause">暂停</button>`);
    if (plan.status === "paused") actions.push(`<button class="btn tiny primary" data-plan-control="${escapeHtml(plan.id)}" data-plan-action="resume">继续</button>`);
    if (plan.status === "running" || plan.status === "paused") actions.push(`<button class="btn tiny danger subtle" data-plan-control="${escapeHtml(plan.id)}" data-plan-action="stop">停止</button>`);
    if (plan.status === "stopped" || plan.status === "completed") actions.push(`<button class="btn tiny danger subtle" data-plan-delete="${escapeHtml(plan.id)}">删除</button>`);
    return `<div class="ob-plan-card is-${plan.status}" data-plan-id="${escapeHtml(plan.id)}" style="--ob-i:${index}">
      <div class="ob-plan-head">${badge(meta.label, meta.tone)}<b>${escapeHtml(plan.name)}</b>${nextRun}</div>
      <div class="ob-plan-meta"><span>${scope}</span><span>${rhythm}</span></div>
      ${outreachPlanProgressTrack(progress)}
      <div class="ob-plan-meta"><span>${counts}</span></div>
      <div class="ob-plan-status">${escapeHtml(plan.pauseReason || plan.lastMessage || "—")}</div>
      <footer style="display:flex;gap:6px;flex-wrap:wrap">${actions.join("")}</footer>
    </div>`;
  }).join("");

  bindOutreachPlanCreateButton();
  animateOutreachNumbers(listBox);
  // 整张卡片可点进详情（卡片自带 cursor:pointer），按钮区域除外
  listBox.onclick = (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest("button")) return;
    const card = target.closest<HTMLElement>("[data-plan-id]");
    if (card?.dataset.planId) void openOutreachPlanDetail(card.dataset.planId);
  };
  qsa<HTMLButtonElement>("[data-plan-detail]", listBox).forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    void openOutreachPlanDetail(button.dataset.planDetail || "");
  }));
  qsa<HTMLButtonElement>("[data-plan-control]", listBox).forEach((button) => button.addEventListener("click", () => {
    const plan = outreachPlans.find((item) => item.id === button.dataset.planControl);
    if (plan) void controlOutreachPlan(plan, (button.dataset.planAction || "") as "pause" | "resume" | "stop");
  }));
  qsa<HTMLButtonElement>("[data-plan-delete]", listBox).forEach((button) => button.addEventListener("click", () => {
    const plan = outreachPlans.find((item) => item.id === button.dataset.planDelete);
    if (plan) void deleteOutreachPlan(plan);
  }));
}

/** 新建自动发送方案按钮绑定：用 onclick 赋值保证幂等（渲染多次不会叠加监听器）。
    必须在视图激活时调用一次——早期版本只在「方案列表非空」的渲染分支里绑定，
    导致新用户（零方案）点「新建自动发送方案」完全没有反应。 */
export function bindOutreachPlanCreateButton() {
  const button = qs<HTMLButtonElement>("#outreachPlanCreateButton");
  if (button) button.onclick = () => openOutreachPlanModal();
}

/** 新建自动发送方案弹窗：目标（条件筛选 / 手动勾选名单）+ 发送节奏 + 自定义每步内容 + 命中预览 */
function openOutreachPlanModal() {
  const sourceLabels = { candidate: "搜客候选", lead: "线索", customer: "客户" } as const;
  type PlanSourceKey = keyof typeof sourceLabels;
  const picker = {
    mode: "rules" as "rules" | "manual",
    source: "candidate" as PlanSourceKey,
    rows: [] as Array<{ id: string; company: string; email: string }>,
    loaded: new Set<PlanSourceKey>(),
    loading: false,
    selected: new Map<string, { entityType: PlanSourceKey; entityId: string; company: string; email: string }>(),
    steps: [{ subject: "", body: "" }] as Array<{ subject: string; body: string }>
  };
  const body = `
    <div class="form-grid">
      <div class="form-field full"><label>方案名称 *</label><input id="obPlanName" placeholder="例如：泰国台秤客户开发"></div>
      <div class="form-field full"><label>目标来源</label>
        <div class="ob-plan-mode-grid" role="radiogroup" aria-label="目标来源">
          <label class="ob-plan-mode-card"><input type="radio" name="obPlanMode" value="rules" checked><span><b>按条件筛选候选池</b><small>按国家、关键词从搜客候选自动取人</small></span></label>
          <label class="ob-plan-mode-card"><input type="radio" name="obPlanMode" value="manual"><span><b>手动勾选名单</b><small>从候选、线索、客户里逐个勾选</small></span></label>
        </div>
      </div>
      <div id="obPlanRulesFields" class="form-field full" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div class="form-field" style="margin:0"><label>国家筛选（逗号分隔，留空=不限）</label><input id="obPlanCountries" placeholder="泰国, 马来西亚"></div>
        <div class="form-field" style="margin:0"><label>关键词（公司/业务包含）</label><input id="obPlanKeyword" placeholder="scale / weighing"></div>
        <div class="form-field" style="margin:0"><label>目标人数上限（1–500）</label><input id="obPlanMaxTargets" type="number" min="1" max="500" value="50"></div>
      </div>
      <div id="obPlanManualFields" class="form-field full" hidden>
        <div style="display:flex;gap:6px;margin-bottom:8px" class="ob-plan-source-tabs">
          ${(["candidate", "lead", "customer"] as PlanSourceKey[]).map((key) => `<button type="button" class="btn tiny${key === "candidate" ? " active" : ""}" data-plan-source="${key}">${sourceLabels[key]}</button>`).join("")}
        </div>
        <input id="obPlanSearch" placeholder="搜索公司名 / 邮箱…" style="margin-bottom:8px">
        <div id="obPlanPickList" class="ob-plan-pick-list"></div>
        <div id="obPlanPickedSummary" style="margin-top:8px"></div>
      </div>
      <div class="form-field"><label>每天最多发送（1–200 封）</label><input id="obPlanDailyLimit" type="number" min="1" max="200" value="20"></div>
      <div class="form-field"><label>同一客户两封信间隔（小时）</label><input id="obPlanStepInterval" type="number" min="1" max="720" value="72"></div>
      <div class="form-field"><label>发送时段开始（0–23 点）</label><input id="obPlanWindowStart" type="number" min="0" max="23" value="9"></div>
      <div class="form-field"><label>发送时段结束（1–24 点）</label><input id="obPlanWindowEnd" type="number" min="1" max="24" value="18"></div>
      <label class="form-field full" style="display:flex;gap:8px;align-items:center"><input id="obPlanStopOnReply" type="checkbox" checked>客户回复后自动停发该客户剩余邮件（推荐）</label>
      <div class="form-field"><label>每 N 封换下一个发件邮箱（0 = 不轮换）</label><input id="obPlanRotateEvery" type="number" min="0" max="1000" value="0"></div>
      <div class="form-field"><label>发件邮箱池</label><b id="obPlanRotateHint" style="font-size:12px;align-self:center;font-weight:500">读取中…</b></div>
      <label class="form-field full" style="display:flex;gap:8px;align-items:center"><input id="obPlanCustomSteps" type="checkbox">自定义每步邮件内容（不勾选 = 使用系统默认开发信模板）</label>
      <div class="form-field full" id="obPlanStepsEditor" hidden></div>
      <div class="form-field full" id="obPlanPreviewBox"></div>
    </div>`;
  const foot = `<button class="btn" data-modal-close>取消</button><button class="btn" id="obPlanPreviewButton">预览命中</button><button class="btn primary" id="obPlanCreateButton2">启动方案</button>`;
  openModal("新建自动发送方案", body, foot, { closeOnBackdrop: false });
  qs<HTMLElement>("#appModal .modal")?.classList.add("outreach-plan-create-modal");
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  // 发件邮箱池状态：有几箱就提示能轮换，没有就说明去哪登记
  void api<{ mailboxes: Array<{ id: string; email: string; enabled: boolean }> }>("/api/sender-mailboxes")
    .then((result) => {
      const hint = qs<HTMLElement>("#obPlanRotateHint");
      if (!hint) return;
      const total = result.mailboxes?.length || 0;
      const enabled = (result.mailboxes || []).filter((row) => row.enabled).length;
      if (!total) {
        hint.textContent = "未登记 · 到「邮件中心 → 邮箱设置 → 发件邮箱池」添加后可按量轮换";
        hint.style.color = "var(--text-tertiary,#8a94a6)";
      } else {
        hint.textContent = enabled > 1 ? `已登记 ${total} 个（启用 ${enabled} 个）· 可轮换` : `已登记 ${total} 个 · 轮换需至少启用 2 个`;
        hint.style.color = enabled > 1 ? "var(--ink,#17233d)" : "var(--text-tertiary,#8a94a6)";
      }
    })
    .catch(() => {
      const hint = qs<HTMLElement>("#obPlanRotateHint");
      if (hint) hint.textContent = "状态读取失败";
    });
  // ---- 模式切换：条件筛选 / 手动名单 ----
  const syncMode = () => {
    const rulesBox = qs<HTMLElement>("#obPlanRulesFields");
    const manualBox = qs<HTMLElement>("#obPlanManualFields");
    // 规则区有内联 display:grid，会压住 hidden 属性——必须直接切 display
    if (rulesBox) rulesBox.style.display = picker.mode === "rules" ? "grid" : "none";
    // .form-field 的 display:grid 同样会压住 manualBox 的 hidden 属性（截图实测弹窗里漏显示），display 一起切
    if (manualBox) {
      manualBox.hidden = picker.mode !== "manual";
      manualBox.style.display = picker.mode === "manual" ? "grid" : "none";
      // 切进手动名单时自动加载当前页签，避免列表空着等用户再点一次页签
      if (picker.mode === "manual") void loadPickRows();
    }
  };
  qsa<HTMLInputElement>('input[name="obPlanMode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      picker.mode = radio.value as "rules" | "manual";
      syncMode();
    });
  });
  // ---- 手动名单：来源页签 / 搜索 / 勾选列表 / 已选摘要 ----
  const renderPickedSummary = () => {
    const box = qs<HTMLElement>("#obPlanPickedSummary");
    if (!box) return;
    const all = [...picker.selected.values()];
    if (!all.length) {
      box.innerHTML = `<small style="color:var(--text-tertiary,#8a94a6)">还没勾选目标。按勾选顺序投递。</small>`;
      return;
    }
    const missing = all.filter((row) => !row.email).length;
    const chips = all.map((row) => `<span class="ob-plan-pick-chip">${escapeHtml(row.company)}<button type="button" data-pick-remove="${row.entityType}:${escapeHtml(row.entityId)}" title="移除">×</button></span>`).join("");
    box.innerHTML = `<small style="color:var(--text-tertiary,#8a94a6)">已选 <b style="color:var(--ink,#17233d)">${all.length}</b> 人${missing ? `（${missing} 人缺邮箱，发送时会被跳过）` : ""}</small><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${chips}</div>`;
    qsa<HTMLButtonElement>("[data-pick-remove]", box).forEach((button) => {
      button.addEventListener("click", () => {
        picker.selected.delete(button.dataset.pickRemove || "");
        renderPickedSummary();
        renderPickList();
      });
    });
  };
  const renderPickList = () => {
    const list = qs<HTMLElement>("#obPlanPickList");
    if (!list) return;
    if (picker.loading) {
      list.innerHTML = `<div class="ob-plan-pick-empty">加载中…</div>`;
      return;
    }
    const search = (qs<HTMLInputElement>("#obPlanSearch")?.value || "").trim().toLowerCase();
    const rows = picker.rows.filter((row) => !search || `${row.company} ${row.email}`.toLowerCase().includes(search));
    if (!rows.length) {
      list.innerHTML = `<div class="ob-plan-pick-empty">${search ? "没有匹配的结果" : "这里还没有数据"}</div>`;
      return;
    }
    list.innerHTML = rows.slice(0, 200).map((row) => {
      const checked = picker.selected.has(`${picker.source}:${row.id}`);
      return `<label class="ob-plan-pick-row" title="${escapeHtml(row.company)}">
        <input type="checkbox" data-pick-source="${picker.source}" data-pick-id="${escapeHtml(row.id)}" data-pick-company="${escapeHtml(row.company)}" data-pick-email="${escapeHtml(row.email)}" ${checked ? "checked" : ""}>
        <span class="ob-plan-pick-name">${escapeHtml(row.company)}</span>
        <small>${row.email ? escapeHtml(row.email) : '<i class="ob-plan-pick-noemail">缺邮箱 · 会被跳过</i>'}</small>
      </label>`;
    }).join("") + (rows.length > 200 ? `<div class="ob-plan-pick-empty">仅显示前 200 条，请用搜索缩小范围</div>` : "");
    qsa<HTMLInputElement>("input[data-pick-id]", list).forEach((input) => {
      input.addEventListener("change", () => {
        const key = `${input.dataset.pickSource}:${input.dataset.pickId}`;
        if (input.checked) {
          picker.selected.set(key, {
            entityType: (input.dataset.pickSource || "candidate") as PlanSourceKey,
            entityId: input.dataset.pickId || "",
            company: input.dataset.pickCompany || "",
            email: input.dataset.pickEmail || ""
          });
        } else {
          picker.selected.delete(key);
        }
        renderPickedSummary();
      });
    });
  };
  const loadPickRows = async () => {
    if (picker.loaded.has(picker.source)) {
      renderPickList();
      return;
    }
    picker.loading = true;
    renderPickList();
    try {
      if (picker.source === "candidate") {
        const result = await api<{ opportunities: Array<{ id: string; company: string; contactInfo?: string }> }>("/api/tools/website-opportunities");
        picker.rows = (result.opportunities || []).map((row) => ({ id: row.id, company: row.company, email: (row.contactInfo || "").trim() }));
      } else if (picker.source === "lead") {
        const result = await api<{ leads: Array<{ id: string; company: string; email?: string }> }>("/api/leads");
        picker.rows = (result.leads || []).map((row) => ({ id: row.id, company: row.company, email: (row.email || "").trim() }));
      } else {
        const result = await api<{ customers: Array<{ id: string; company: string; email?: string }> }>("/api/customers");
        picker.rows = (result.customers || []).map((row) => ({ id: row.id, company: row.company, email: (row.email || "").trim() }));
      }
      picker.loaded.add(picker.source);
    } catch (error) {
      toast(error instanceof Error ? error.message : "名单加载失败", "error");
    }
    picker.loading = false;
    renderPickList();
  };
  qsa<HTMLButtonElement>("[data-plan-source]").forEach((button) => {
    button.addEventListener("click", () => {
      picker.source = (button.dataset.planSource || "candidate") as PlanSourceKey;
      qsa<HTMLButtonElement>("[data-plan-source]").forEach((row) => row.classList.toggle("active", row === button));
      void loadPickRows();
    });
  });
  qs<HTMLInputElement>("#obPlanSearch")?.addEventListener("input", renderPickList);
  // ---- 自定义每步内容编辑器 ----
  const readStepsFromDom = () => {
    picker.steps = picker.steps.map((step, index) => ({
      subject: qs<HTMLInputElement>(`[data-step-subject="${index}"]`)?.value ?? step.subject,
      body: qs<HTMLTextAreaElement>(`[data-step-body="${index}"]`)?.value ?? step.body
    }));
  };
  const renderStepsEditor = () => {
    const box = qs<HTMLElement>("#obPlanStepsEditor");
    if (!box) return;
    box.innerHTML = picker.steps.map((step, index) => `
      <div class="ob-plan-step-card">
        <div class="ob-plan-step-head">
          <span class="ob-plan-step-tag">第 ${index + 1} 封</span>
          <small>占位符：{{company}} 公司名 · {{contact}} 联系人 · {{country}} 国家</small>
          ${picker.steps.length > 1 ? `<button type="button" class="btn tiny danger subtle" data-step-remove="${index}" style="margin-left:auto">删除本步</button>` : ""}
        </div>
        <input data-step-subject="${index}" placeholder="邮件主题" value="${escapeHtml(step.subject)}" style="margin-bottom:6px">
        <textarea data-step-body="${index}" rows="6" placeholder="邮件正文（纯文本）">${escapeHtml(step.body)}</textarea>
      </div>`).join("") + (picker.steps.length < 10 ? `<button type="button" class="btn tiny" data-step-add>＋ 添加一步（按发送间隔排期）</button>` : "");
    qsa<HTMLButtonElement>("[data-step-add]", box).forEach((button) => {
      button.addEventListener("click", () => {
        readStepsFromDom();
        picker.steps.push({ subject: "", body: "" });
        renderStepsEditor();
      });
    });
    qsa<HTMLButtonElement>("[data-step-remove]", box).forEach((button) => {
      button.addEventListener("click", () => {
        readStepsFromDom();
        picker.steps.splice(Number(button.dataset.stepRemove), 1);
        renderStepsEditor();
      });
    });
  };
  qs<HTMLInputElement>("#obPlanCustomSteps")?.addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    const box = qs<HTMLElement>("#obPlanStepsEditor");
    if (box) box.hidden = !checked;
    if (checked) renderStepsEditor();
  });
  qs<HTMLButtonElement>("#obPlanPreviewButton")?.addEventListener("click", async () => {
    const box = qs<HTMLElement>("#obPlanPreviewBox");
    if (!box) return;
    if (picker.mode === "manual") {
      const all = [...picker.selected.values()];
      const missing = all.filter((row) => !row.email).length;
      box.innerHTML = all.length
        ? `<small style="color:var(--text-tertiary,#8a94a6)">已选 <b style="color:var(--ink,#17233d)">${all.length}</b> 人${missing ? `，其中 ${missing} 人缺邮箱会被跳过，实际发送 ${all.length - missing} 人` : ""}。按勾选顺序投递。</small>`
        : `<small style="color:#b45309">请先在名单里勾选目标</small>`;
      return;
    }
    box.innerHTML = `<small style="color:var(--text-tertiary,#8a94a6)">正在统计候选池命中…</small>`;
    try {
      const countries = (qs<HTMLInputElement>("#obPlanCountries")?.value || "").split(/[,，]/).map((row) => row.trim()).filter(Boolean);
      const keyword = qs<HTMLInputElement>("#obPlanKeyword")?.value.trim() || "";
      const result = await api<{ matched: number; sample: Array<{ company: string; country: string; hasEmail: boolean }> }>(
        "/api/outreach-plans/preview",
        { method: "POST", body: JSON.stringify({ countries, keyword }) }
      );
      const sample = result.sample.map((item) => `${escapeHtml(item.company)}（${escapeHtml(item.country || "未知")}）${item.hasEmail ? "" : " ·缺邮箱"}`).join("、");
      box.innerHTML = `<small style="color:var(--text-tertiary,#8a94a6)">候选池命中 <b style="color:var(--ink,#17233d)">${result.matched}</b> 人。样例：${sample || "无"}。</small>`;
    } catch (error) {
      box.innerHTML = `<small style="color:#b03a3a">预览失败：${escapeHtml(error instanceof Error ? error.message : "未知错误")}</small>`;
    }
  });
  qs<HTMLButtonElement>("#obPlanCreateButton2")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const name = qs<HTMLInputElement>("#obPlanName")?.value.trim() || "";
    if (!name) {
      toast("请填写方案名称", "error");
      return;
    }
    if (picker.mode === "manual" && !picker.selected.size) {
      toast("手动名单模式至少勾选一个目标", "error");
      return;
    }
    let customSteps: Array<{ subject: string; body: string }> | undefined;
    if (qs<HTMLInputElement>("#obPlanCustomSteps")?.checked) {
      readStepsFromDom();
      customSteps = picker.steps.map((step) => ({ subject: step.subject.trim(), body: step.body.trim() }));
      if (customSteps.some((step) => !step.subject || !step.body)) {
        toast("自定义内容里每一步的主题和正文都要填写（不用的步骤请删除）", "error");
        return;
      }
    }
    const target = picker.mode === "manual"
      ? { mode: "manual", entries: [...picker.selected.values()].map((row) => ({ entityType: row.entityType, entityId: row.entityId })) }
      : {
        mode: "rules",
        countries: (qs<HTMLInputElement>("#obPlanCountries")?.value || "").split(/[,，]/).map((row) => row.trim()).filter(Boolean),
        keyword: qs<HTMLInputElement>("#obPlanKeyword")?.value.trim() || "",
        maxTargets: Number(qs<HTMLInputElement>("#obPlanMaxTargets")?.value || 50)
      };
    const payload = {
      name,
      target,
      ...(customSteps ? { steps: customSteps } : {}),
      policy: {
        dailyLimit: Number(qs<HTMLInputElement>("#obPlanDailyLimit")?.value || 20),
        sendWindowStartHour: Number(qs<HTMLInputElement>("#obPlanWindowStart")?.value || 9),
        sendWindowEndHour: Number(qs<HTMLInputElement>("#obPlanWindowEnd")?.value || 18),
        stepIntervalHours: Number(qs<HTMLInputElement>("#obPlanStepInterval")?.value || 72),
        stopOnReply: qs<HTMLInputElement>("#obPlanStopOnReply")?.checked ?? true,
        rotateMailboxEvery: Math.max(0, Number(qs<HTMLInputElement>("#obPlanRotateEvery")?.value || 0))
      }
    };
    button.disabled = true;
    try {
      await api("/api/outreach-plans", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      toast(`方案「${name}」已启动，后台将按节奏自动发送`, "success");
      await loadOutreachPlans();
    } catch (error) {
      toast(error instanceof Error ? error.message : "创建失败", "error");
      button.disabled = false;
    }
  });
}

async function controlOutreachPlan(plan: OutreachPlanView, action: "pause" | "resume" | "stop") {
  const labels: Record<string, string> = { pause: "暂停", resume: "继续", stop: "停止" };
  const consequences: Record<string, string[]> = {
    pause: ["后台线程将停止取人发信，已排期的邮件冻结", "随时可以「继续」恢复运行"],
    resume: ["方案恢复运行，在发送时段内继续按节奏取人投递"],
    stop: ["方案永久停止，未发送的邮件步骤全部跳过", "停止后不可恢复，只能删除"]
  };
  const ok = await confirmAction({
    title: `${labels[action]}方案「${plan.name}」`,
    message: action === "stop"
      ? `确定停止该方案吗？当前进度：已发 ${plan.progress.sent} / 目标 ${plan.progress.targetCap}。`
      : `确定${labels[action]}该方案吗？`,
    consequences: consequences[action] || [],
    confirmLabel: labels[action],
    tone: action === "stop" ? "danger" : "normal"
  });
  if (!ok) return;
  try {
    await api(`/api/outreach-plans/${encodeURIComponent(plan.id)}/control`, { method: "POST", body: JSON.stringify({ action }) });
    toast(`方案已${labels[action]}`, "success");
    await loadOutreachPlans();
  } catch (error) {
    toast(error instanceof Error ? error.message : "操作失败", "error");
  }
}

async function deleteOutreachPlan(plan: OutreachPlanView) {
  const ok = await confirmAction({
    title: "删除方案",
    message: `确定删除方案「${plan.name}」吗？`,
    consequences: ["方案配置与目标明细会永久删除", "已发送的邮件与已转的线索不受影响"],
    confirmLabel: "删除",
    tone: "danger"
  });
  if (!ok) return;
  try {
    await api(`/api/outreach-plans/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
    toast("方案已删除", "success");
    await loadOutreachPlans();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败", "error");
  }
}

/** 方案详情：每个目标的发送进度 + 回流状态（线索 ID） */
async function openOutreachPlanDetail(planId: string) {
  try {
    const result = await api<{ plan: OutreachPlanView & { items: Array<OutreachBatchItemView> }; progress: OutreachPlanProgress }>(
      `/api/outreach-plans/${encodeURIComponent(planId)}`
    );
    const plan = result.plan;
    const progress = result.progress;
    const meta = OUTREACH_PLAN_STATUS_META[plan.status] || { label: plan.status, tone: "gray" };
    const itemsHtml = (plan.items || []).length ? plan.items.map((item, index) => {
      const skipped = item.status === "skipped" || item.status === "removed";
      const statusLabel = item.status === "sent" ? "已完成" : item.status === "failed" ? "失败" : item.status === "stopped" ? "已停止" : item.status === "skipped" ? "已跳过" : item.status === "sending" ? "发送中" : "进行中";
      const tone = item.status === "sent" ? "green" : item.status === "failed" ? "red" : skipped ? "gray" : "amber";
      const planJourneyId = item.leadId || item.candidateId || "";
      const planJourneyType: OutreachJourneyEntityType = item.entityType === "lead" || (!item.entityType && item.leadId) ? "lead"
        : item.entityType === "customer" ? "customer" : "prospect_candidate";
      const journeyButton = planJourneyId
        ? `<button class="btn" data-plan-item-journey="${escapeHtml(planJourneyId)}" data-plan-item-journey-type="${planJourneyType}" data-plan-item-company="${escapeHtml(item.company)}">查看过程</button>`
        : "";
      const companyHint = [item.company, item.leadId, item.candidateId].filter(Boolean).join(" · ");
      // 跳过项本来就没有收件人，别给它挂「未取到邮箱」——那会让人误以为"差个邮箱就能发"
      const head = (withRecipient: boolean) => `<div class="opd-target-head">
          <div class="opd-target-id"><b title="${escapeHtml(companyHint)}">${escapeHtml(outreachItemCompanyLabel(item))}</b>${withRecipient ? `<small>${escapeHtml(item.recipient || "未取到邮箱")}</small>` : ""}</div>
          <div class="opd-target-tags">${outreachStageBadge(item)}${outreachLetterStatusBadge(item)}${badge(statusLabel, tone)}</div>
        </div>`;
      // 跳过 / 已移除：没有发送时间轴，只保留「为什么跳过」一行
      if (skipped) {
        return `<article class="opd-target is-${item.status}" style="--opd-i:${index}">
          ${head(false)}
          <div class="opd-target-foot"><span class="opd-note" title="${escapeHtml(item.skipReason || "")}">${escapeHtml(outreachSkipReasonLabel(item.skipReason || "已跳过"))}</span>${journeyButton}</div>
        </article>`;
      }
      // 页脚结论：已发完 / 哪一封失败 / 下一封什么时候发
      const pendingStep = item.steps.find((step) => step.status === "pending");
      const failedStep = item.steps.find((step) => step.status === "failed");
      const summary = item.status === "sent" ? "序列已发完"
        : failedStep ? `第 ${failedStep.index + 1} 封发送失败：${failedStep.error || "未知原因"}`
        : pendingStep && pendingStep.scheduledAt ? `下一封 ${formatDateTime(pendingStep.scheduledAt)}`
        : "";
      const steps = item.steps.map((step) => {
        const cls = step.status === "sent" ? "is-done" : step.status === "failed" ? "is-fail" : "is-next";
        const tag = step.status === "sent" ? "已发" : step.status === "failed" ? "失败" : step.status === "sending" ? "发送中" : step.status === "skipped" ? "已跳过" : "待发";
        const when = step.status === "sent" ? formatDateTime(step.sentAt)
          : step.status === "failed" ? (step.error || "发送失败")
          : step.status === "sending" ? "正在投递…"
          : step.status === "skipped" ? "已跳过"
          : formatDateTime(step.scheduledAt);
        return `<li class="opd-step ${cls}">
          <span class="opd-rail"><i class="opd-dot"></i><i class="opd-link"></i></span>
          <b>第 ${step.index + 1} 封 · ${tag}${step.stageLabel ? ` · ${escapeHtml(step.stageLabel)}` : ""}</b>
          <small title="${escapeHtml(when)}">${escapeHtml(when)}</small>
        </li>`;
      }).join("");
      const basisNote = outreachLetterBasisNote(item);
      const footBits = [item.convertedLeadId ? badge("已回流线索", "green") : "", summary ? `<span class="opd-note">${escapeHtml(summary)}</span>` : "", basisNote, journeyButton].filter(Boolean).join("");
      return `<article class="opd-target" style="--opd-i:${index}">
        ${head(true)}
        <ol class="opd-steps">${steps}</ol>
        ${footBits ? `<div class="opd-target-foot">${footBits}</div>` : ""}
      </article>`;
    }).join("") : `<div class="opd-empty">还没有目标入场。</div>`;
    const barCap = Math.max(progress.targetCap, progress.total, 1);
    const seg = (count: number, cls: string) => count > 0
      ? `<i class="${cls}" style="width:${((count / barCap) * 100).toFixed(1)}%"></i>`
      : "";
    const detail = `<section class="opd-overview">
        <div class="opd-overview-head">${badge(meta.label, meta.tone)}<em>${escapeHtml(plan.pauseReason || plan.lastMessage || "运行正常")}</em></div>
        <div class="opd-metrics">
          <div class="opd-metric is-blue"><b>${progress.total}<span class="of"> / ${progress.targetCap}</span></b><small>已入场 / 目标上限</small></div>
          <div class="opd-metric${progress.sent > 0 ? " is-green" : ""}"><b>${progress.sent}</b><small>已发完序列</small></div>
          <div class="opd-metric${progress.converted > 0 ? " is-green" : ""}"><b>${progress.converted}</b><small>已回流线索</small></div>
          <div class="opd-metric${progress.failed > 0 ? " is-red" : ""}"><b>${progress.failed}</b><small>失败</small></div>
          <div class="opd-metric${progress.skipped > 0 ? " is-amber" : ""}"><b>${progress.skipped}</b><small>跳过</small></div>
          ${progress.letters && (progress.letters.pending > 0 || progress.letters.withResearch > 0)
            ? `<div class="opd-metric${progress.letters.pending > 0 ? " is-amber" : " is-green"}" title="正文按每个客户自己的阶段 + 最近一次背调逐封写成">
                <b>${progress.letters.pending > 0 ? progress.letters.pending : progress.letters.withResearch}</b>
                <small>${progress.letters.pending > 0 ? "正文补写中" : "按背调成稿"}</small>
              </div>`
            : ""}
        </div>
        <div class="opd-bar" title="已发 ${progress.sentSteps} 封 · 待发 ${progress.pendingSteps} 封 · 完成 ${progress.sent} 人 · 失败 ${progress.failed} · 跳过 ${progress.skipped}">${seg(progress.sent, "sent")}${seg(progress.inProgress, "progress")}${seg(progress.failed, "failed")}${seg(progress.skipped, "skipped")}</div>
      </section>
      <div class="opd-targets">${itemsHtml}</div>`;
    openModal(`方案详情 · ${plan.name}`, detail, `<button class="btn" data-modal-close>关闭</button>`);
    qs<HTMLElement>("#appModal .modal")?.classList.add("outreach-plan-detail-modal");
    qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
    qsa<HTMLButtonElement>("[data-plan-item-journey]").forEach((button) => {
      button.addEventListener("click", () => {
        closeModal();
        void openOutreachCustomerJourney(
          (button.dataset.planItemJourneyType || "prospect_candidate") as OutreachJourneyEntityType,
          button.dataset.planItemJourney || "",
          button.dataset.planItemCompany || "",
          "outreach-batches"
        );
      });
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : "方案详情加载失败", "error");
  }
}

// ---------------------------------------------------------------------------
// 发信明细 + 客户开发信过程档案
//
// 「发信明细」把批次 / 方案 / 单发的收件人按客户聚合成一行（阶段 + 进度 + 回复 + 背调），
// 「开发信过程档案」是单个客户的完整留档：发送历史、回复、背调、按阶段发下一封。
// 两者都是整页视图（与「客户全景」同一形态），不是弹窗。
// ---------------------------------------------------------------------------

type OutreachJourneyEntityType = "customer" | "lead" | "prospect_candidate";

interface OutreachJourneyStageSnapshot {
  key: string;
  label: string;
  tone: string;
  description: string;
  nextStepLabel: string;
  canSend: boolean;
  blockReason: string;
  outboundCount: number;
  lastSentAt: string;
  lastReplyAt: string;
  lastReplyClassification: string;
  lastReplyLabel: string;
}

interface OutreachJourneyEmailView {
  messageId: string;
  index: number;
  subject: string;
  bodyPreview: string;
  body: string;
  recipient: string;
  sentAt: string;
  sourceLabel: string;
  batchName: string;
  dispatchStatus: string;
  dispatchError: string;
  openCount: number;
  clickCount: number;
  repliedAt: string;
  bouncedAt: string;
}

interface OutreachJourneyReplyView {
  id: string;
  occurredAt: string;
  eventType: string;
  classification: string;
  classificationLabel: string;
  subject: string;
  content: string;
  contactValue: string;
}

interface OutreachJourneyTimelineEntry {
  kind: string;
  at: string;
  title: string;
  detail: string;
  tone: string;
}

interface OutreachJourneyResearchSummary {
  id: string;
  score: number;
  verdict: string;
  summary: string;
  engine: string;
  crmOnly: boolean;
  createdAt: string;
  createdByName: string;
}

/** 一封已发信与背调的配对（后端按"写信时刻最近一次背调"推导，并验证角度是否写进信里） */
interface OutreachJourneyResearchLinkView {
  emailIndex: number;
  messageId: string;
  subject: string;
  sentAt: string;
  linked: boolean;
  researchId: string;
  researchScore: number | null;
  researchVerdict: string;
  researchEngine: string;
  researchCreatedAt: string;
  researchAgeDays: number | null;
  angles: Array<{ keyword: string; angle: string; used: boolean }>;
  factsCount: number;
  verified: boolean;
}

interface OutreachJourneyEntityView {
  entityType: OutreachJourneyEntityType;
  entityId: string;
  company: string;
  contact: string;
  email: string;
  country: string;
  website: string;
  ownerName: string;
  customerId: string;
  leadId: string;
  candidateId: string;
  convertedToLead: boolean;
  convertedToCustomer: boolean;
  suppressed: boolean;
  suppressedReason: string;
  nextFollowAt: string;
}

export interface OutreachJourneyView {
  entity: OutreachJourneyEntityView;
  stage: OutreachJourneyStageSnapshot;
  emails: OutreachJourneyEmailView[];
  replies: OutreachJourneyReplyView[];
  timeline: OutreachJourneyTimelineEntry[];
  research: { latest: OutreachJourneyResearchSummary | null; history: OutreachJourneyResearchSummary[]; links: OutreachJourneyResearchLinkView[]; coverage: { total: number; linked: number; verified: number } };
  batches: Array<{ id: string; label: string }>;
  stats: {
    outboundCount: number; replyCount: number; openCount: number; clickCount: number;
    bounceCount: number; firstSentAt: string; lastSentAt: string; lastEventAt: string;
  };
}

interface OutreachJourneyListItem {
  entityType: OutreachJourneyEntityType;
  entityId: string;
  company: string;
  contact: string;
  email: string;
  country: string;
  ownerName: string;
  stageKey: string;
  stageLabel: string;
  stageTone: string;
  outboundCount: number;
  lastSentAt: string;
  lastSubject: string;
  replyCount: number;
  lastReplyAt: string;
  lastReplyLabel: string;
  bounceCount: number;
  openCount: number;
  converted: boolean;
  convertedTo: string;
  nextFollowAt: string;
  researchScore: number | null;
  researchAt: string;
}

interface OutreachJourneyOverview {
  items: OutreachJourneyListItem[];
  summary: { total: number; byStage: Record<string, number>; replied: number; converted: number; bounced: number };
}

const OUTREACH_JOURNEY_STAGE_FALLBACK: Record<string, { label: string; tone: string }> = {
  not_contacted: { label: "未接触", tone: "gray" },
  first_touch_sent: { label: "已发首触", tone: "amber" },
  following_up: { label: "跟进中", tone: "amber" },
  replied_interested: { label: "已回复·可推进", tone: "green" },
  replied_negative: { label: "已回复·明确拒绝", tone: "red" },
  bounced: { label: "联系方式退信", tone: "red" },
  converted: { label: "已转线索 / 客户", tone: "blue" }
};

const OUTREACH_JOURNEY_STAGE_FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "全部阶段" },
  { key: "not_contacted", label: "未接触" },
  { key: "first_touch_sent", label: "已发首触" },
  { key: "following_up", label: "跟进中" },
  { key: "replied_interested", label: "已回复·可推进" },
  { key: "replied_negative", label: "已回复·明确拒绝" },
  { key: "bounced", label: "联系方式退信" },
  { key: "converted", label: "已转线索 / 客户" }
];

export let outreachJourneyOverview: OutreachJourneyOverview | null = null;
let outreachJourneyScope: "self" | "team" = "self";
let outreachJourneyStageFilter = "all";
let outreachJourneySearch = "";
let outreachJourneySubject: { entityType: OutreachJourneyEntityType; entityId: string; company: string; backView: string } | null = null;
let outreachJourneyDetail: OutreachJourneyView | null = null;
let outreachJourneyDetailLoading = false;
let outreachJourneyDetailError = "";

/** badge() 的 gray 对应无 tone 类（.badge.gray 不存在） */
export function outreachBadgeTone(tone: string) {
  return tone === "gray" ? "" : tone;
}

function outreachJourneyKey(item: { entityType: string; entityId: string }) {
  return `${item.entityType}:${item.entityId}`;
}

/** 发信明细页工具条绑定：用 onclick / oninput 赋值保证幂等（多次进视图不会叠加监听器） */
export function bindOutreachJourneyToolbar() {
  const scope = qs<HTMLSelectElement>("#ojScopeFilter");
  if (scope) scope.onchange = () => {
    outreachJourneyScope = scope.value === "team" ? "team" : "self";
    void loadOutreachJourneyOverview();
  };
  const search = qs<HTMLInputElement>("#ojSearch");
  if (search) search.oninput = () => {
    outreachJourneySearch = search.value;
    renderOutreachJourneyPage();
  };
  const stageSelect = qs<HTMLSelectElement>("#ojStageFilter");
  if (stageSelect) stageSelect.onchange = () => {
    outreachJourneyStageFilter = stageSelect.value || "all";
    renderOutreachJourneyPage();
  };
  const reset = qs<HTMLButtonElement>("#ojResetButton");
  if (reset) reset.onclick = () => {
    outreachJourneySearch = "";
    outreachJourneyStageFilter = "all";
    if (search) search.value = "";
    renderOutreachJourneyPage();
  };
  const refresh = qs<HTMLButtonElement>("#ojRefreshButton");
  if (refresh) refresh.onclick = () => void loadOutreachJourneyOverview();
}

export async function loadOutreachJourneyOverview() {
  const body = qs<HTMLElement>("#ojTableBody");
  if (body) body.innerHTML = `<tr><td colspan="7" style="padding:22px;text-align:center;color:var(--muted)">正在汇总发信明细…</td></tr>`;
  try {
    const result = await api<OutreachJourneyOverview>(`/api/outreach-journey/overview?scope=${encodeURIComponent(outreachJourneyScope)}`);
    outreachJourneyOverview = result;
    renderOutreachJourneyPage();
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="7" style="padding:22px;text-align:center;color:#b03a3a">${escapeHtml(error instanceof Error ? error.message : "发信明细加载失败")}</td></tr>`;
  }
}

function outreachJourneyFilteredItems() {
  const items = outreachJourneyOverview?.items || [];
  const keyword = outreachJourneySearch.trim().toLowerCase();
  return items.filter((item) => {
    if (outreachJourneyStageFilter !== "all" && item.stageKey !== outreachJourneyStageFilter) return false;
    if (!keyword) return true;
    return [item.company, item.contact, item.email, item.lastSubject, item.country]
      .some((field) => (field || "").toLowerCase().includes(keyword));
  });
}

function outreachJourneyProgressDots(item: OutreachJourneyListItem) {
  const total = Math.max(item.outboundCount, 1);
  const dots = Array.from({ length: Math.min(Math.max(item.outboundCount, 1), 3) }, (_unused, index) => `<i class="oj-dot on" style="--oj-dot:${index}"></i>`).join("");
  const replied = item.replyCount > 0 ? `<i class="oj-dot reply"></i>` : "";
  return `<span class="oj-progress" title="共发出 ${item.outboundCount} 封">${dots}${replied}<small>${item.outboundCount} 封</small></span>`;
}

function outreachJourneyReplyCell(item: OutreachJourneyListItem) {
  if (item.stageKey === "bounced" || item.bounceCount) return badge("退信", "red");
  if (!item.lastReplyAt) return `<span style="color:var(--muted)">尚未回复</span>`;
  const meta = item.stageKey === "replied_negative" ? { label: item.lastReplyLabel || "已回复", tone: "red" } : { label: item.lastReplyLabel || "已回复", tone: "green" };
  return `${badge(meta.label, meta.tone)}<div style="margin-top:3px;color:var(--muted);font-size:10px">${escapeHtml(formatDateTime(item.lastReplyAt))}</div>`;
}

function outreachJourneyResearchCell(item: OutreachJourneyListItem) {
  if (item.researchScore === null || item.researchScore === undefined) return `<span style="color:var(--muted)">未背调</span>`;
  const tone = item.researchScore >= 78 ? "green" : item.researchScore >= 60 ? "amber" : "red";
  return `${badge(`评分 ${item.researchScore}`, tone)}<div style="margin-top:3px;color:var(--muted);font-size:10px">${escapeHtml(formatDateTime(item.researchAt))}</div>`;
}

export function renderOutreachJourneyPage() {
  const summaryBox = qs<HTMLElement>("#ojSummary");
  const body = qs<HTMLElement>("#ojTableBody");
  const mobile = qs<HTMLElement>("#ojMobileList");
  const stageSelect = qs<HTMLSelectElement>("#ojStageFilter");
  if (!summaryBox || !body || !mobile) return;
  const overview = outreachJourneyOverview;
  if (stageSelect && stageSelect.options.length !== OUTREACH_JOURNEY_STAGE_FILTERS.length) {
    stageSelect.innerHTML = OUTREACH_JOURNEY_STAGE_FILTERS
      .map((option) => `<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`).join("");
  }
  if (stageSelect) stageSelect.value = outreachJourneyStageFilter;
  const scopeSelect = qs<HTMLSelectElement>("#ojScopeFilter");
  if (scopeSelect) scopeSelect.value = outreachJourneyScope;

  if (!overview) {
    summaryBox.innerHTML = "";
    body.innerHTML = `<tr><td colspan="7" style="padding:22px;text-align:center;color:var(--muted)">正在汇总发信明细…</td></tr>`;
    mobile.innerHTML = "";
    return;
  }

  const byStage = overview.summary.byStage || {};
  const cards: Array<[string, string, number, string]> = [
    ["all", "全部有发信记录", overview.summary.total, "已进入开发信流程的客户"],
    ["first_touch_sent", "已发首触", byStage.first_touch_sent || 0, "等回复"],
    ["following_up", "跟进中", byStage.following_up || 0, "已发 2 封以上"],
    ["replied_interested", "已回复·可推进", byStage.replied_interested || 0, "可以转商机"],
    ["bounced", "退信", overview.summary.bounced || 0, "地址需要修"],
    ["converted", "已转线索/客户", overview.summary.converted || 0, "已回流业务库"]
  ];
  summaryBox.innerHTML = cards.map(([key, label, value, note], index) =>
    `<button type="button" data-oj-stage="${escapeHtml(key)}" style="--oj-i:${index}" class="${outreachJourneyStageFilter === key ? "is-active" : ""}"><span>${escapeHtml(label)}</span>${outreachNumberHtml(`oj:${key}`, value)}<small>${escapeHtml(note)}</small></button>`
  ).join("");
  animateOutreachNumbers(summaryBox);

  const items = outreachJourneyFilteredItems();
  if (!items.length) {
    const emptyHtml = `<div class="oj-empty">
      <b>${overview.summary.total ? "当前筛选条件下没有匹配的客户" : "还没有任何发信记录"}</b>
      <span>${overview.summary.total
        ? "换一个阶段或清空搜索词试试。"
        : "先去「发信批次」建一个自动发送方案，或到「搜客清单 / 线索」勾选客户生成发信批次；发出的每一封都会在这里按客户归档。"}</span>
      <button class="btn primary" type="button" data-oj-goto-batches>去发信批次 →</button>
    </div>`;
    body.innerHTML = `<tr><td colspan="7" style="padding:0">${emptyHtml}</td></tr>`;
    mobile.innerHTML = emptyHtml;
  } else {
    body.innerHTML = items.map((item, index) => {
      const tone = outreachBadgeTone(item.stageTone);
      return `<tr class="oj-row" style="--oj-i:${index}" data-oj-open="${escapeHtml(outreachJourneyKey(item))}" data-oj-company="${escapeHtml(item.company)}">
        <td><div class="oj-company"><b>${escapeHtml(item.company)}</b><span>${escapeHtml([item.contact, item.email].filter(Boolean).join(" · ") || "联系人与邮箱待补充")}</span></div></td>
        <td>${badge(item.stageLabel, tone)}</td>
        <td>${outreachJourneyProgressDots(item)}</td>
        <td><div class="oj-company"><span>${escapeHtml(item.lastSentAt ? formatDateTime(item.lastSentAt) : "—")}</span><b style="font-size:11px;font-weight:500">${escapeHtml(item.lastSubject || "—")}</b></div></td>
        <td>${outreachJourneyReplyCell(item)}</td>
        <td>${outreachJourneyResearchCell(item)}</td>
        <td style="text-align:right"><button class="btn tiny" type="button" data-oj-open="${escapeHtml(outreachJourneyKey(item))}" data-oj-company="${escapeHtml(item.company)}">查看过程</button></td>
      </tr>`;
    }).join("");
    mobile.innerHTML = items.map((item, index) => {
      const tone = outreachBadgeTone(item.stageTone);
      return `<div class="oj-card" style="--oj-i:${index}" data-oj-open="${escapeHtml(outreachJourneyKey(item))}" data-oj-company="${escapeHtml(item.company)}">
        <div class="oj-card-head"><b>${escapeHtml(item.company)}</b>${badge(item.stageLabel, tone)}</div>
        <div class="oj-card-meta"><span>${escapeHtml(item.contact || "联系人待补充")}</span><span>${escapeHtml(item.email || "邮箱待补充")}</span><span>${item.outboundCount} 封</span>${item.lastReplyAt ? `<span>已回复</span>` : ""}</div>
        <div class="oj-card-meta"><span>最近：${escapeHtml(item.lastSentAt ? formatDateTime(item.lastSentAt) : "—")}</span></div>
      </div>`;
    }).join("");
  }

  qsa<HTMLButtonElement>("[data-oj-stage]", summaryBox).forEach((button) => {
    button.addEventListener("click", () => {
      outreachJourneyStageFilter = button.dataset.ojStage || "all";
      renderOutreachJourneyPage();
    });
  });
  qsa<HTMLElement>("[data-oj-open]", body).forEach((node) => node.addEventListener("click", () => {
    const [entityType, ...rest] = (node.dataset.ojOpen || "").split(":");
    if (!entityType || !rest.length) return;
    void openOutreachCustomerJourney(entityType as OutreachJourneyEntityType, rest.join(":"), node.dataset.ojCompany || "", "outreach-journey");
  }));
  qsa<HTMLElement>("[data-oj-open]", mobile).forEach((node) => node.addEventListener("click", () => {
    const [entityType, ...rest] = (node.dataset.ojOpen || "").split(":");
    if (!entityType || !rest.length) return;
    void openOutreachCustomerJourney(entityType as OutreachJourneyEntityType, rest.join(":"), node.dataset.ojCompany || "", "outreach-journey");
  }));
  qsa<HTMLButtonElement>("[data-oj-goto-batches]", basicScope()).forEach((button) =>
    button.addEventListener("click", () => activateNavView("outreach-batches")));
}

function basicScope() {
  const active = qs<HTMLElement>("#outreach-journey");
  return active || document;
}

/** 进入单个客户的开发信过程档案（整页） */
export async function openOutreachCustomerJourney(
  entityType: OutreachJourneyEntityType,
  entityId: string,
  company: string,
  backView: string
) {
  outreachJourneySubject = { entityType, entityId, company, backView };
  outreachJourneyDetail = null;
  outreachJourneyDetailError = "";
  outreachJourneyDetailLoading = true;
  activateNavView("outreach-customer-journey", () => renderOutreachCustomerJourneyPage());
  try {
    const view = await api<OutreachJourneyView>(
      `/api/outreach-journey?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`
    );
    outreachJourneyDetail = view;
  } catch (error) {
    outreachJourneyDetailError = error instanceof Error ? error.message : "开发信过程加载失败";
  } finally {
    outreachJourneyDetailLoading = false;
    if (qs<HTMLElement>("#outreach-customer-journey")?.classList.contains("active")) renderOutreachCustomerJourneyPage();
  }
}

function outreachJourneyBack() {
  const backView = outreachJourneySubject?.backView || "outreach-journey";
  if (backView === "customer-detail") {
    activateNavView("customer-detail", () => renderCustomerDetailPage());
    return;
  }
  if (backView === "customer-drawer") {
    activateNavView("customers");
    return;
  }
  activateNavView(backView);
}

/** 时间线条目：index 由 map 自动传入，用来做错峰进场（--oj-i） */
function outreachJourneyEventBlock(entry: OutreachJourneyTimelineEntry, index = 0) {
  const tone = outreachBadgeTone(entry.tone);
  return `<div class="ojc-event${tone ? ` is-${tone}` : ""}" style="--oj-i:${index}">
    <i></i>
    <div>
      <div class="ojc-event-head"><b>${escapeHtml(entry.title)}</b><time>${escapeHtml(entry.at ? formatDateTime(entry.at) : "")}</time></div>
      ${entry.detail ? `<p>${escapeHtml(entry.detail)}</p>` : ""}
    </div>
  </div>`;
}

export function renderOutreachCustomerJourneyPage() {
  const box = qs<HTMLElement>("#outreachCustomerJourneyPage");
  const subject = outreachJourneySubject;
  if (!box || !subject) return;
  const backButton = `<button class="customer-page-back" type="button" data-ojc-back title="返回" aria-label="返回"><svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></button>`;

  if (outreachJourneyDetailLoading && !outreachJourneyDetail) {
    box.innerHTML = `<header class="ojc-head"><div class="ojc-identity">${backButton}<div><h1>${escapeHtml(subject.company || "开发信过程")}</h1><p>正在读取这家客户的完整开发信档案…</p></div></div></header>
      <div class="ojc-empty">汇总发送历史、回复记录与背调结果，请稍候。</div>`;
    qs<HTMLButtonElement>("[data-ojc-back]", box)?.addEventListener("click", outreachJourneyBack);
    return;
  }
  if (outreachJourneyDetailError || !outreachJourneyDetail) {
    box.innerHTML = `<header class="ojc-head"><div class="ojc-identity">${backButton}<div><h1>${escapeHtml(subject.company || "开发信过程")}</h1><p>读取失败</p></div></div></header>
      <div class="ojc-empty">${escapeHtml(outreachJourneyDetailError || "没有找到这家客户的开发信记录。")}<br><br><button class="btn" type="button" data-ojc-back2>返回</button></div>`;
    qs<HTMLButtonElement>("[data-ojc-back]", box)?.addEventListener("click", outreachJourneyBack);
    qs<HTMLButtonElement>("[data-ojc-back2]", box)?.addEventListener("click", outreachJourneyBack);
    return;
  }

  const view = outreachJourneyDetail;
  const entity = view.entity;
  const stage = view.stage;
  const tone = outreachBadgeTone(stage.tone);
  const stats = view.stats;
  const emailsHtml = view.emails.length ? view.emails.slice().reverse().map((email) => `
    <article class="ojc-email">
      <div class="ojc-email-head">
        <b>第 ${email.index} 封 · ${escapeHtml(email.subject || "（无主题）")}</b>
        <small>${escapeHtml(formatDateTime(email.sentAt))} · ${escapeHtml(email.recipient || "未记录收件人")} · ${escapeHtml(email.sourceLabel || "手动发送")}${email.batchName ? ` · ${escapeHtml(email.batchName)}` : ""}</small>
      </div>
      <div class="ojc-email-head" style="margin-top:6px">
        <span>${badge(email.dispatchStatus === "sent" ? "已投递" : email.dispatchStatus === "pending" ? "投递中" : "结果待确认", email.dispatchStatus === "sent" ? "green" : email.dispatchStatus === "pending" ? "amber" : "red")}
        ${email.openCount ? badge(`打开 ${email.openCount}`, "blue") : ""}
        ${email.clickCount ? badge(`点击 ${email.clickCount}`, "blue") : ""}
        ${email.repliedAt ? badge("已回复", "green") : ""}
        ${email.bouncedAt ? badge("已退信", "red") : ""}</span>
      </div>
      ${email.dispatchError ? `<p style="color:#b03a3a">${escapeHtml(email.dispatchError)}</p>` : ""}
      ${email.body ? `<details><summary>查看这封信的完整正文</summary><pre>${escapeHtml(email.body)}</pre></details>` : `<p>${escapeHtml(email.bodyPreview || "（未留存正文）")}</p>`}
    </article>`).join("") : `<div class="ojc-empty">还没有发过信。点右上角「按当前阶段发送」发出第一封。</div>`;

  const repliesHtml = view.replies.length ? view.replies.slice().reverse().map((reply) => {
    const isBounce = reply.eventType === "bounce" || reply.classification === "bounced";
    const isNegative = reply.classification === "rejected" || reply.classification === "unsubscribed";
    return `<article class="ojc-email">
      <div class="ojc-email-head">
        <b>${escapeHtml(isBounce ? "退信" : reply.classificationLabel || "客户回复")}</b>
        <small>${escapeHtml(formatDateTime(reply.occurredAt))} · ${escapeHtml(reply.contactValue || "—")}</small>
      </div>
      <p>${escapeHtml(reply.content || reply.subject || "（无正文）")}</p>
      ${badge(isBounce ? "地址无效" : isNegative ? "已停止发送" : "可继续推进", isBounce || isNegative ? "red" : "green")}
    </article>`;
  }).join("") : `<div class="ojc-empty">还没有收到回复。回复 / 退信会由回信监听自动归档到这里。</div>`;

  const researchHtml = view.research.latest ? `
    <div class="ojc-research">
      ${view.research.history.map((record, index) => `
        <article class="ojc-research-card${index === 0 ? " is-latest" : ""}">
          <div class="ojc-research-head">
            <b>${index === 0 ? "最近一次背调" : `历史背调 #${view.research.history.length - index}`} · 评分 ${record.score}</b>
            <small>${escapeHtml(formatDateTime(record.createdAt))}${record.createdByName ? ` · ${escapeHtml(record.createdByName)}` : ""}</small>
          </div>
          <p><b>${escapeHtml(record.verdict || "未给结论")}</b></p>
          <p>${escapeHtml(record.summary || record.engine || "（无摘要）")}</p>
        </article>`).join("")}
    </div>` : `<div class="ojc-empty">这家客户还没有背调记录。点右上角「AI 背调」跑一次，结果会自动留档在这里，之后可以对比每次变化。</div>`;

  const batchesHtml = view.batches.length
    ? `<div class="ojc-section-body" style="display:grid;gap:6px">${view.batches.map((batch) => `<div style="font-size:11px;color:var(--muted)">${escapeHtml(batch.label)}</div>`).join("")}</div>`
    : `<div class="ojc-empty">还没有归属的发信批次或方案。</div>`;

  // 背调 × 开发信关联：每封信按"写信时刻最近一次背调"配对，绿色角度 = 真的写进了信里
  const researchById = new Map(view.research.history.map((record) => [record.id, record]));
  const linkCards = view.research.links.slice().reverse().map((link, index) => {
    const record = link.researchId ? researchById.get(link.researchId) : null;
    const staleNote = link.linked && (link.researchAgeDays || 0) > 60
      ? `<span class="ojc-link-stale">背调已偏旧 ${link.researchAgeDays} 天，建议重跑</span>` : "";
    const researchSide = link.linked
      ? `<div class="ojc-link-basis">
          ${badge(`依据背调 · 评分 ${link.researchScore ?? "—"}`, "blue")}
          ${link.verified ? badge("角度已写进信里", "green") : badge("角度未引用", "gray")}
          <small>${escapeHtml(formatDateTime(link.researchCreatedAt))}${link.researchEngine ? ` · ${escapeHtml(link.researchEngine)}` : ""}${link.factsCount ? ` · ${link.factsCount} 条事实` : ""}</small>
          ${staleNote}
        </div>
        ${link.angles.length ? `<div class="ojc-link-angles">${link.angles.map((angle) => `<span class="ojc-link-angle${angle.used ? " is-used" : ""}" title="${escapeHtml(angle.angle)}">${angle.used ? "✓ " : ""}${escapeHtml(angle.keyword)}</span>`).join("")}</div>` : ""}
        ${record?.summary ? `<details class="ojc-link-detail"><summary>当次背调结论</summary><p>${escapeHtml(link.researchVerdict || "未给结论")} — ${escapeHtml(record.summary)}</p></details>` : ""}`
      : `<div class="ojc-link-basis"><span class="ojc-link-none">写信时还没有背调留档</span></div>`;
    return `
      <article class="ojc-link-card${link.verified ? " is-verified" : link.linked ? "" : " is-unlinked"}" style="--oj-i:${index}">
        <div class="ojc-link-mail">
          <b>第 ${link.emailIndex} 封 · ${escapeHtml(link.subject || "（无主题）")}</b>
          <small>${escapeHtml(formatDateTime(link.sentAt))}</small>
        </div>
        ${researchSide}
      </article>`;
  }).join("");
  const coverage = view.research.coverage;
  const linkSectionHtml = !view.emails.length
    ? ""
    : `<section class="ojc-section ojc-link-section">
        <div class="ojc-section-head"><div><h2>背调 × 开发信关联</h2><small>每封信依据的是写信时刻最近的一次背调；带 ✓ 的角度表示真的写进了那封信里</small></div><b style="font-size:12px;color:var(--muted)">${coverage.linked}/${coverage.total} 封有背调依据 · ${coverage.verified} 封已引用角度</b></div>
        <div class="ojc-section-body"><div class="ojc-link-list">${linkCards || `<div class="ojc-empty">还没有可关联的发送记录。</div>`}</div></div>
      </section>`;

  // AI 背调的请求契约只接受 customer / lead；纯搜客候选没有可背调的主体，按钮置灰而不是点了报错。
  const researchTargetId = entity.customerId || entity.leadId || "";

  box.innerHTML = `
    <header class="ojc-head">
      <div class="ojc-identity">
        ${backButton}
        <div>
          <h1>${escapeHtml(entity.company || subject.company || "开发信过程")} ${badge(stage.label, tone)}</h1>
          <p>${escapeHtml([entity.country, entity.contact, entity.email].filter(Boolean).join(" · ") || "资料待补充")} · 负责人 ${escapeHtml(entity.ownerName || "未分配")}</p>
        </div>
      </div>
      <div class="head-actions">
        ${entity.customerId ? `<button class="btn" type="button" data-ojc-open-customer>打开客户资料</button>` : entity.leadId ? `<button class="btn" type="button" data-ojc-open-lead>打开线索</button>` : `<button class="btn" type="button" data-ojc-open-candidate>打开搜客候选</button>`}
        ${researchTargetId
          ? `<button class="btn ai-entry-button" type="button" data-ojc-research>${researchButtonIcon()}AI 背调</button>`
          : `<button class="btn ai-entry-button" type="button" disabled title="AI 背调只支持客户与线索；搜客候选需先转为线索">${researchButtonIcon()}AI 背调</button>`}
        <button class="btn ${stage.canSend ? "primary" : ""}" type="button" data-ojc-send ${stage.canSend ? "" : "disabled"} title="${escapeHtml(stage.blockReason || stage.nextStepLabel)}">${escapeHtml(stage.canSend ? `按阶段发送：${stage.nextStepLabel.replace(/^发送/u, "")}` : "当前阶段不可发送")}</button>
      </div>
    </header>

    <section class="ojc-stage${tone ? ` is-${tone}` : ""}">
      <div>${badge(stage.label, tone)}</div>
      <div class="ojc-stage-main">
        <h2>当前阶段判定：${escapeHtml(stage.description)}</h2>
        <p>下一步建议：<em>${escapeHtml(stage.nextStepLabel)}</em></p>
        <p>${entity.convertedToCustomer ? "这家客户已回流到客户档案，正式跟进请走客户流程。" : entity.convertedToLead ? "这家客户已回流为正式线索，正式跟进请走线索流程。" : `判定依据：共发出 ${stats.outboundCount} 封${stats.replyCount ? `、收到 ${stats.replyCount} 次回复` : "、暂无回复"}。`}</p>
      </div>
      <div class="ojc-stage-side">
        <b>${stats.outboundCount} 封</b>
        <small>${stats.lastSentAt ? `最近发送 ${escapeHtml(formatDateTime(stats.lastSentAt))}` : "还没有发送记录"}</small>
        ${entity.nextFollowAt ? `<small>下次跟进 ${escapeHtml(entity.nextFollowAt)}</small>` : ""}
      </div>
    </section>
    ${stage.canSend ? "" : `<div class="ojc-block-note">${escapeHtml(stage.blockReason)}</div>`}

    <section class="ojc-stats">
      <div style="--oj-i:0"><span>已发送</span><b>${stats.outboundCount}</b><small>封开发信</small></div>
      <div style="--oj-i:1"><span>客户回复</span><b>${stats.replyCount}</b><small>次</small></div>
      <div style="--oj-i:2"><span>邮件被打开</span><b>${stats.openCount}</b><small>次（含重复打开）</small></div>
      <div style="--oj-i:3"><span>链接被点击</span><b>${stats.clickCount}</b><small>次</small></div>
      <div style="--oj-i:4"><span>退信</span><b>${stats.bounceCount}</b><small>次</small></div>
      <div style="--oj-i:5"><span>首次触达</span><b>${stats.firstSentAt ? escapeHtml(formatDateTime(stats.firstSentAt).slice(0, 10)) : "—"}</b><small>${stats.firstSentAt ? "开始接触的日期" : "尚未接触"}</small></div>
    </section>

    ${linkSectionHtml}

    <div class="ojc-grid">
      <div>
        <section class="ojc-section">
          <div class="ojc-section-head"><div><h2>发送历史</h2><small>这家客户收到过的每一封开发信，按时间倒序，可展开看完整正文</small></div><b style="font-size:12px;color:var(--muted)">${view.emails.length} 封</b></div>
          <div class="ojc-section-body">${emailsHtml}</div>
        </section>
        <section class="ojc-section">
          <div class="ojc-section-head"><div><h2>过程时间线</h2><small>发送、打开、点击、回复、退信、背调、回流合并成一条可留档的轨迹</small></div></div>
          <div class="ojc-section-body"><div class="ojc-timeline">${view.timeline.length ? view.timeline.map(outreachJourneyEventBlock).join("") : `<div class="ojc-empty">还没有过程记录。</div>`}</div></div>
        </section>
      </div>
      <div>
        <section class="ojc-section">
          <div class="ojc-section-head"><div><h2>回复情况</h2><small>客户回信与退信会自动归档到这里</small></div><b style="font-size:12px;color:var(--muted)">${view.replies.length} 条</b></div>
          <div class="ojc-section-body">${repliesHtml}</div>
        </section>
        <section class="ojc-section">
          <div class="ojc-section-head"><div><h2>自动背调结果</h2><small>每次背调都会留档，方便对比客户变化</small></div>${view.research.latest ? badge(`共 ${view.research.history.length} 次`, "blue") : ""}</div>
          <div class="ojc-section-body">${researchHtml}</div>
        </section>
        <section class="ojc-section">
          <div class="ojc-section-head"><div><h2>归属批次 / 方案</h2><small>这些信是从哪几个发信任务发出去的</small></div></div>
          ${batchesHtml}
        </section>
      </div>
    </div>`;

  qs<HTMLButtonElement>("[data-ojc-back]", box)?.addEventListener("click", outreachJourneyBack);
  qs<HTMLButtonElement>("[data-ojc-send]", box)?.addEventListener("click", () => void openOutreachStageSendModal());
  qs<HTMLButtonElement>("[data-ojc-research]", box)?.addEventListener("click", () => {
    const targetType = entity.customerId ? "customer" : "lead";
    const targetId = researchTargetId;
    if (!targetId) {
      toast("搜客候选还不支持直接背调，请先把它转为线索", "error");
      return;
    }
    void openBackgroundResearch(targetType as "customer" | "lead", targetId, entity.company, "outreach-customer-journey");
  });
  qs<HTMLButtonElement>("[data-ojc-open-customer]", box)?.addEventListener("click", () => {
    const customer = state.customers.find((item) => item.id === entity.customerId);
    if (!customer) {
      toast("客户资料尚未加载，请到客户列表查看", "error");
      return;
    }
    activateNavView("customer-detail", () => renderCustomerDetailPage(customer));
  });
  qs<HTMLButtonElement>("[data-ojc-open-lead]", box)?.addEventListener("click", () => activateNavView("leads"));
  qs<HTMLButtonElement>("[data-ojc-open-candidate]", box)?.addEventListener("click", () => activateNavView("prospect-list"));
}

/** 按阶段生成下一封草稿 → 人工确认 → 真实投递 */
async function openOutreachStageSendModal() {
  const subject = outreachJourneySubject;
  if (!subject) return;
  const body = `<p class="modal-hint">正在按客户当前阶段生成草稿…</p>`;
  openModal("按阶段发送开发信", body, `<button class="btn" data-modal-close>取消</button>`, { closeOnBackdrop: false });
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  let draft: { stageKey: string; stepIndex: number; subject: string; body: string; tips: string[] } | null = null;
  let stageSnapshot: OutreachJourneyStageSnapshot | null = null;
  let recipient = "";
  try {
    const result = await api<{
      draft: { stageKey: string; stepIndex: number; subject: string; body: string; tips: string[] };
      stage: OutreachJourneyStageSnapshot;
      entity: OutreachJourneyEntityView;
      recipient: string;
      sourceLabel: string;
    }>(`/api/outreach-journey/draft?entityType=${encodeURIComponent(subject.entityType)}&entityId=${encodeURIComponent(subject.entityId)}`);
    draft = result.draft;
    stageSnapshot = result.stage;
    recipient = result.recipient || result.entity.email || "";
  } catch (error) {
    closeModal();
    toast(error instanceof Error ? error.message : "草稿生成失败", "error");
    return;
  }
  const stageLabel = stageSnapshot?.label || "";
  const bodyHtml = `
    <div style="display:grid;gap:10px">
      <div style="padding:10px 12px;border:1px solid var(--line);border-left:3px solid var(--brand);border-radius:8px;background:var(--surface-2);font-size:12px;line-height:1.75">
        <b>当前阶段：${escapeHtml(stageLabel)}</b> · 这是第 <b>${draft.stepIndex}</b> 封
        <div style="color:var(--muted);margin-top:4px">${escapeHtml(stageSnapshot?.description || "")}</div>
      </div>
      <div class="form-grid">
        <div class="form-field full"><label>收件人 *</label><input id="ojSendTo" value="${escapeHtml(recipient)}" placeholder="name@company.com"></div>
        <div class="form-field full"><label>主题 *</label><input id="ojSendSubject" value="${escapeHtml(draft.subject)}"></div>
        <div class="form-field full"><label>正文 *</label><textarea id="ojSendBody" rows="12" style="font-family:var(--font-mono,monospace);font-size:12px">${escapeHtml(draft.body)}</textarea></div>
      </div>
      ${draft.tips.length ? `<ul style="margin:0;padding-left:18px;color:var(--muted);font-size:11px;line-height:1.8">${draft.tips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("")}</ul>` : ""}
      <div style="font-size:11px;color:var(--muted);line-height:1.75">发出后这封信会立即登记到「发送历史」并计入这家客户的阶段判定；正文里 <code>{{sender}}</code> 会替换成你的发件署名。</div>
    </div>`;
  const footHtml = `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="ojSendConfirmButton">确认发送</button>`;
  openModal(`按阶段发送 · ${subject.company || "开发信"}`, bodyHtml, footHtml, { closeOnBackdrop: false });
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs<HTMLButtonElement>("#ojSendConfirmButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.disabled) return;
    const to = qs<HTMLInputElement>("#ojSendTo")?.value.trim() || "";
    const mailSubject = qs<HTMLInputElement>("#ojSendSubject")?.value.trim() || "";
    const mailBody = qs<HTMLTextAreaElement>("#ojSendBody")?.value.trim() || "";
    if (!to || !mailSubject || !mailBody) {
      toast("收件人、主题、正文都不能为空", "error");
      return;
    }
    const ok = await confirmAction({
      title: "确认发送这封开发信",
      message: `确认后会立即通过你的 SMTP 账号真实投递到 ${to}，不是模拟发送。`,
      consequences: [
        "这封信会写入客户的开发信档案并计入阶段判定",
        "内容即刻冻结，已发出的邮件不可撤回",
        "仍受每日发信上限、同域名频率与退信率熔断保护"
      ],
      confirmLabel: "真实发送",
      tone: "danger"
    });
    if (!ok) return;
    setButtonPending(button, true, "确认发送", "发送中…");
    try {
      await api("/api/outreach-journey/send", {
        method: "POST",
        body: JSON.stringify({
          entityType: subject.entityType,
          entityId: subject.entityId,
          requestId: prospectRequestId("journey-send"),
          to,
          subject: mailSubject,
          body: mailBody
        })
      });
      closeModal();
      toast("已发送，档案已更新", "success");
      if (outreachJourneySubject) await openOutreachCustomerJourney(subject.entityType, subject.entityId, subject.company, subject.backView);
    } catch (error) {
      toast(error instanceof Error ? error.message : "发送失败", "error");
      setButtonPending(button, false, "确认发送", "确认发送");
    }
  });
}

export async function loadOutreachBatches() {
  try {
    const result = await api<{ batches: OutreachBatchView[] }>("/api/prospect-outreach-batches?limit=50");
    state.outreachBatches = result.batches || [];
    // 已消失的批次不该继续占着折叠状态，否则下次同名 id 复用时会被误判成收起
    for (const id of [...outreachBatchCollapsed]) {
      if (!state.outreachBatches.some((item) => item.id === id)) outreachBatchCollapsed.delete(id);
    }
    renderOutreachBatches();
  } catch (error) {
    toast(error instanceof Error ? error.message : "发信批次加载失败", "error");
  }
}

/** 批次内各步骤的发送进度统计 */
function outreachBatchProgress(batch: OutreachBatchView) {
  let sent = 0, failed = 0, pending = 0;
  for (const item of batch.items) {
    for (const step of item.steps) {
      if (step.status === "sent") sent++;
      else if (step.status === "failed") failed++;
      else if (step.status === "pending") pending++;
    }
  }
  return { sent, failed, pending };
}

/** 批次下一封计划发送时间：最早一条待发步骤的 scheduledAt */
function outreachBatchNextSendAt(batch: OutreachBatchView): string {
  let best = "";
  for (const item of batch.items) {
    for (const step of item.steps) {
      if (step.status !== "pending" || !step.scheduledAt) continue;
      if (!best || step.scheduledAt < best) best = step.scheduledAt;
    }
  }
  return best;
}

/** 间隔小时转人话：72 → "3 天"，48 → "2 天"，5 → "5 小时" */
function outreachIntervalLabel(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24} 天`;
  return `${hours} 小时`;
}

/** 批次项的公司名：后端在「找不到线索/候选」时会把内部 ID 塞进 company 字段，别拿 ID 当公司名给人看 */
function outreachItemCompanyLabel(item: { company?: string; leadId?: string; candidateId?: string }): string {
  const raw = (item.company || "").trim();
  const looksLikeId = Boolean(raw) && (raw === (item.leadId || "") || raw === (item.candidateId || "")
    || /^(lead_|cand_|prospect_candidate_|website_opportunit)/.test(raw));
  return raw && !looksLikeId ? raw : "客户名不可用";
}

/** 老批次里存的是旧文案——"不存在或无权访问"把「真删了」和「不是你的」混成一句，读出来时改成能读懂的 */
const OUTREACH_SKIP_REASON_LABELS: Record<string, string> = {
  "线索不存在或无权访问": "线索已删除，或不属于你（无法用它发信）",
  "候选不存在或无权访问": "候选已删除，或不属于你（无法用它发信）"
};

function outreachSkipReasonLabel(reason: string): string {
  const raw = (reason || "").trim();
  return OUTREACH_SKIP_REASON_LABELS[raw] || raw;
}

/** 这些跳过原因"修也修不好"：线索/候选没了或不属于你 → 点「恢复」必然再失败，界面只该给「移出」 */
const OUTREACH_TERMINAL_SKIP_REASONS = new Set([
  "线索不存在或无权访问",
  "候选不存在或无权访问",
  "线索已被删除",
  "候选已被删除",
  "该线索属于其他业务员，你无权用它发信",
  "该候选属于其他业务员，你无权用它发信"
]);

function outreachSkipIsTerminal(reason: string): boolean {
  return OUTREACH_TERMINAL_SKIP_REASONS.has((reason || "").trim());
}

/** 折叠状态：默认全部展开（手动批次直接铺成两级列表），点一级行才收起。
    放进模块级 Set 而不是 state——它是纯视图偏好，不该跟着数据一起持久化。 */
const outreachBatchCollapsed = new Set<string>();

/** 批次级操作按钮（放一级行右侧，收起了也能操作） */
function outreachBatchActionButtons(batch: OutreachBatchView): string {
  const buttons: string[] = [];
  if (batch.status === "draft") {
    // 一封可发的都没有时，「确认开始发送」点了也没有任何效果——直接禁用并说明原因，别让按钮骗人
    buttons.push(batch.counts.frozen > 0
      ? `<button class="btn tiny primary" data-batch-approve="${batch.id}">确认开始发送</button>`
      : `<button class="btn tiny primary" data-batch-approve="${batch.id}" disabled title="这批没有可发送的客户：目标已被删除、不属于你或没取到邮箱。先补齐线索邮箱，或把发不出去的目标移除。">确认开始发送</button>`);
  }
  if (batch.status === "approved") buttons.push(`<button class="btn tiny" data-batch-control="${batch.id}" data-batch-action="pause">暂停</button>`);
  if (batch.status === "paused") buttons.push(`<button class="btn tiny primary" data-batch-control="${batch.id}" data-batch-action="resume">继续</button>`);
  if (!["completed", "cancelled"].includes(batch.status)) buttons.push(`<button class="btn tiny" data-batch-control="${batch.id}" data-batch-action="cancel">取消批次</button>`);
  return `<div class="head-actions">${buttons.join("")}</div>`;
}

/** 二级列表：批次里勾选的一个客户一行（名称/邮箱 → 每封的状态药丸 → 状态与操作） */
function outreachBatchCustomerRow(item: OutreachBatchItemView, index: number, batch: OutreachBatchView): string {
  const skipped = item.status === "skipped" || item.status === "removed";
  const companyHint = [item.company, item.leadId, item.candidateId].filter(Boolean).join(" · ");
  const refId = item.leadId || item.candidateId || "";
  if (skipped) {
    // 跳过项没发过信：说清"是谁"（拿不到公司名时给目标编号，别让内部 ID 冒充公司名），原因就是这一行的内容
    const terminal = outreachSkipIsTerminal(item.skipReason || "");
    // 「恢复」对"线索没了 / 不是你的"必然再次复核失败，这种只给「移出」，不给注定失败的按钮
    const actions = batch.status !== "draft" ? ""
      : item.status === "removed" ? `<button class="btn" data-item-restore="${item.id}">恢复</button>`
      : terminal ? `<button class="btn" data-item-remove="${item.id}">移出批次</button>`
      : `<button class="btn" data-item-restore="${item.id}">恢复</button><button class="btn" data-item-remove="${item.id}">移出批次</button>`;
    return `<div class="ob-cust is-${item.status}" style="--ob-j:${index}">
      <div class="ob-cust-main">
        <div class="ob-cust-name"><b title="${escapeHtml(companyHint)}">${escapeHtml(outreachItemCompanyLabel(item))}</b></div>
        ${refId ? `<small class="ob-cust-mail">目标编号 ${escapeHtml(refId)}</small>` : ""}
        <div class="ob-cust-steps"><span class="ob-pill">${escapeHtml(outreachSkipReasonLabel(item.skipReason || "—"))}</span></div>
      </div>
      <div class="ob-cust-side is-row">${badge(item.status === "removed" ? "已移除" : "已跳过", "gray")}${actions}</div>
    </div>`;
  }
  const steps = item.steps.map((step) => {
    const cls = step.status === "sent" ? "is-done" : step.status === "failed" ? "is-fail" : step.status === "skipped" ? "" : "is-next";
    const label = step.status === "sent" ? "已发" : step.status === "failed" ? "失败" : step.status === "skipped" ? "已跳过" : "待发";
    const when = step.status === "sent" && step.sentAt
      ? formatDateTime(step.sentAt)
      : step.status === "pending" && step.scheduledAt
        ? formatDateTime(step.scheduledAt)
        : "";
    // 每一封自己属于哪个阶段：让人一眼看出「第 2 封是承接，不是又发首触」
    const stageText = step.stageLabel ? `${step.stageLabel} · ` : "";
    return `<span class="ob-pill${cls ? ` ${cls}` : ""}" title="${escapeHtml(step.error || (when ? `${stageText}${label} · ${when}` : `${stageText}${label}`))}"><i></i>第 ${step.index + 1} 封 · ${label}${step.stageLabel ? ` · ${escapeHtml(step.stageLabel)}` : ""}${when ? ` ${escapeHtml(when)}` : ""}</span>`;
  }).join("");
  const statusMeta = item.status === "sent" ? { label: "全部已发", tone: "green" }
    : item.status === "failed" ? { label: "发送失败", tone: "red" }
    : item.status === "stopped" ? { label: "已停止（客户已回复）", tone: "gray" }
    : item.status === "sending" ? { label: "发送中", tone: "amber" }
    : { label: "按计划进行中", tone: "amber" };
  const journeyId = item.leadId || item.candidateId || "";
  const editButtons = batch.status === "draft" && item.status === "ready"
    ? `<button class="btn" data-item-edit="${item.id}">编辑信件</button><button class="btn" data-item-remove="${item.id}">移出批次</button>`
    : "";
  const subjectPreview = item.steps[0]
    ? `<span class="ob-note" title="${escapeHtml(item.steps[0].subject)}">首封主题：${escapeHtml(item.steps[0].subject)}</span>`
    : `<span class="ob-note"></span>`;
  const basisNote = outreachLetterBasisNote(item);
  return `<div class="ob-cust" style="--ob-j:${index}">
    <div class="ob-cust-main">
      <div class="ob-cust-name"><b>${escapeHtml(outreachItemCompanyLabel(item))}</b>${item.convertedLeadId ? badge("已转线索", "green") : ""}${outreachStageBadge(item)}${outreachLetterStatusBadge(item)}</div>
      <small class="ob-cust-mail">${escapeHtml(item.recipient || "收件人待定")}</small>
      <div class="ob-cust-steps">${steps}</div>
      ${basisNote || outreachStageSelect(item, batch) ? `<div class="ob-cust-basis">${outreachStageSelect(item, batch)}${basisNote}</div>` : ""}
    </div>
    <div class="ob-cust-side">${badge(statusMeta.label, statusMeta.tone)}</div>
    <div class="ob-cust-foot">
      ${subjectPreview}
      ${journeyId ? `<button class="btn" data-item-journey="${escapeHtml(journeyId)}" data-item-journey-type="${item.leadId ? "lead" : "prospect_candidate"}" data-item-company="${escapeHtml(outreachItemCompanyLabel(item))}">开发信过程</button>` : ""}
      ${editButtons}
    </div>
  </div>`;
}

/** 一级行：批次摘要 + 批次级操作；展开时把二级客户列表挂在下面 */
/** 批次的正文补写进度：优先用后端算好的（单一口径），拿不到时按同一公式兜底 */
function outreachBatchLetterProgress(batch: OutreachBatchView) {
  if (batch.letterProgress) return batch.letterProgress;
  const active = batch.items.filter((item) => item.status === "ready" || item.status === "sending");
  return {
    total: active.length,
    pending: active.filter((item) => item.letterStatus === "pending").length,
    failed: active.filter((item) => item.letterStatus === "failed").length,
    withResearch: active.filter((item) => Boolean(item.researchId)).length
  };
}

function renderOutreachBatchCard(batch: OutreachBatchView, index: number): string {
  const meta = OUTREACH_BATCH_STATUS_META[batch.status] || { label: batch.status, tone: "gray" };
  const progress = outreachBatchProgress(batch);
  const letters = outreachBatchLetterProgress(batch);
  const nextAt = batch.status === "approved" ? outreachBatchNextSendAt(batch) : "";
  const converted = batch.items.filter((item) => item.convertedLeadId).length;
  const batchKey = `batch:${batch.id}`;
  const open = !outreachBatchCollapsed.has(batch.id);
  const stat = batch.status === "draft"
    ? `${batch.counts.frozen > 0
      ? `可发送 ${outreachNumberHtml(`${batchKey}:frozen`, batch.counts.frozen)} 封`
      : `<b class="ob-zero">可发送 0 封</b>`}${batch.counts.skipped ? ` · 跳过 ${outreachNumberHtml(`${batchKey}:skipped`, batch.counts.skipped)} 位` : ""}`
    : `共 ${outreachNumberHtml(`${batchKey}:frozen`, batch.counts.frozen)} 封 · 已发 ${outreachNumberHtml(`${batchKey}:sent`, progress.sent)}${progress.failed ? ` · 失败 ${outreachNumberHtml(`${batchKey}:failed`, progress.failed)}` : ""}${progress.pending ? ` · 待发 ${outreachNumberHtml(`${batchKey}:pending`, progress.pending)}` : ""}`;
  const caret = `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M4 2.4 8 6l-4 3.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
  const rhythm = [
    `每天最多 ${batch.policy.dailyLimit} 封`,
    `同人间隔 ${outreachIntervalLabel(batch.policy.stepIntervalHours)}`,
    `${batch.policy.sendWindowStartHour}:00–${batch.policy.sendWindowEndHour}:00 发送`,
    batch.policy.stopOnReply ? "回复即停" : "回复后仍继续",
    // 按阶段成稿的两个提示：还没写完的、已经引用了背调的
    letters.pending ? `正文补写中 ${letters.pending} 条` : "",
    letters.withResearch ? `按背调成稿 ${letters.withResearch} 条` : "",
    letters.failed ? `正文退回模板 ${letters.failed} 条` : "",
    batch.frozenHash ? `内容指纹 ${batch.frozenHash.slice(0, 10)}…` : ""
  ].filter(Boolean);
  const body = open
    ? `<div class="ob-batch-body">
      <div class="ob-batch-rhythm">${rhythm.map((text) => `<span class="ob-chip">${escapeHtml(text)}</span>`).join("")}</div>
      <div class="ob-cust-list">${batch.items.map((item, itemIndex) => outreachBatchCustomerRow(item, itemIndex, batch)).join("")}</div>
    </div>`
    : "";
  return `<article class="ob-batch${open ? " is-open" : ""}" data-batch-id="${batch.id}" style="--ob-i:${index}">
    <div class="ob-batch-head" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}" data-batch-head="${batch.id}">
      <span class="ob-batch-caret">${caret}</span>
      <span class="ob-batch-seq">${index + 1}</span>
      ${badge(meta.label, meta.tone)}
      <span class="ob-batch-title"><b>${batch.targetType === "lead" ? "线索" : "搜客候选"}批次</b><small>${escapeHtml(formatDateTime(batch.createdAt))}</small></span>
      <span class="ob-batch-stat">${stat}${nextAt ? `<span class="ob-next-send">下一封 ${escapeHtml(formatDateTime(nextAt))}</span>` : ""}${converted ? badge(`已转线索 ${converted}`, "green") : ""}</span>
      ${outreachBatchActionButtons(batch)}
    </div>
    ${body}
  </article>`;
}

function renderOutreachBatches() {
  const listBox = qs<HTMLElement>("#outreachBatchList");
  if (!listBox) return;
  const manualCount = qs<HTMLElement>("#outreachManualBatchCount");
  if (manualCount) manualCount.textContent = state.outreachBatches.length ? `共 ${state.outreachBatches.length} 个批次` : "";
  if (!state.outreachBatches.length) {
    listBox.innerHTML = `<div class="ob-empty">
      <p>还没有发送批次。</p>
      <button class="btn primary" id="obEmptyGotoProspectButton" type="button">去搜客清单勾选 →</button>
    </div>`;
  } else {
    listBox.innerHTML = state.outreachBatches.map((batch, index) => renderOutreachBatchCard(batch, index)).join("");
  }
  animateOutreachNumbers(listBox);

  const batchIdOf = (node: HTMLElement | null) => node?.closest<HTMLElement>("[data-batch-id]")?.dataset.batchId || "";
  // 一级行：点空白处展开/收起；行内的按钮不参与折叠
  qsa<HTMLElement>("[data-batch-head]", listBox).forEach((head) => {
    const toggle = (event: Event) => {
      if ((event.target as HTMLElement | null)?.closest("button")) return;
      const id = head.dataset.batchHead || "";
      if (!id) return;
      if (outreachBatchCollapsed.has(id)) outreachBatchCollapsed.delete(id);
      else outreachBatchCollapsed.add(id);
      renderOutreachBatches();
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle(event);
    });
  });
  qsa<HTMLButtonElement>("[data-batch-approve]", listBox).forEach((button) => button.addEventListener("click", async (event) => {
    const target = event.currentTarget as HTMLButtonElement;
    if (target.disabled) return;
    await confirmStartOutreachBatch(batchIdOf(target), target);
  }));
  qsa<HTMLButtonElement>("[data-batch-control]", listBox).forEach((button) => button.addEventListener("click", (event) => {
    const target = event.currentTarget as HTMLButtonElement;
    void controlOutreachBatch(batchIdOf(target), (target.dataset.batchAction || "cancel") as "pause" | "resume" | "cancel", target);
  }));
  // 二级行：编辑 / 移出 / 恢复 / 开发信过程
  qsa<HTMLButtonElement>("[data-item-edit]", listBox).forEach((button) => button.addEventListener("click", (event) => {
    const target = event.currentTarget as HTMLButtonElement;
    openOutreachItemEditor(batchIdOf(target), target.dataset.itemEdit || "");
  }));
  qsa<HTMLButtonElement>("[data-item-remove]", listBox).forEach((button) => button.addEventListener("click", (event) => {
    const target = event.currentTarget as HTMLButtonElement;
    void updateOutreachBatchItem(batchIdOf(target), "remove", target.dataset.itemRemove || "");
  }));
  qsa<HTMLButtonElement>("[data-item-restore]", listBox).forEach((button) => button.addEventListener("click", (event) => {
    const target = event.currentTarget as HTMLButtonElement;
    void updateOutreachBatchItem(batchIdOf(target), "restore", target.dataset.itemRestore || "");
  }));
  qsa<HTMLButtonElement>("[data-item-journey]", listBox).forEach((button) => button.addEventListener("click", (event) => {
    const target = event.currentTarget as HTMLButtonElement;
    void openOutreachCustomerJourney(
      (target.dataset.itemJourneyType || "prospect_candidate") as OutreachJourneyEntityType,
      target.dataset.itemJourney || "",
      target.dataset.itemCompany || "",
      "outreach-batches"
    );
  }));
  // 草稿批次：就地改这一条的开发阶段口径（系统没抓到对方变化时的兜底；空值 = 撤销覆盖）
  qsa<HTMLSelectElement>("[data-item-stage]", listBox).forEach((select) => select.addEventListener("change", (event) => {
    const target = event.currentTarget as HTMLSelectElement;
    void updateOutreachBatchItem(batchIdOf(target), "stage", target.dataset.itemStage || "", { stageKey: target.value });
  }));
  qs<HTMLButtonElement>("#obEmptyGotoProspectButton", listBox)?.addEventListener("click", () => activateNavView("lead-finder"));
}

/** 确认开始发送：把"冻结放行"的后果用人话讲清楚，再执行 */
async function confirmStartOutreachBatch(batchId: string, button?: HTMLButtonElement) {
  const batch = state.outreachBatches.find((item) => item.id === batchId);
  if (!batch) return;
  const letters = outreachBatchLetterProgress(batch);
  const ok = await confirmAction({
    title: "确认开始发送",
    message: "确认后这批开发信会按下方节奏自动投递，期间不需要再人工操作。",
    consequences: [
      `共 ${batch.counts.frozen} 封开发信进入自动发送队列`,
      "所有信件内容即刻锁定，之后不能再修改",
      `每天最多发 ${batch.policy.dailyLimit} 封，只在 ${batch.policy.sendWindowStartHour}:00–${batch.policy.sendWindowEndHour}:00 发送`,
      batch.policy.stopOnReply ? "客户一回复，自动停发给他的其余信件" : "注意：客户回复后不会自动停发，建议谨慎",
      // 正文还在补写时空等会让人以为卡住了，必须提前说清
      letters.pending
        ? `其中 ${letters.pending} 位正在按背调补写正文，会先跳过他们，补写完成后自动接着发`
        : ""
    ].filter(Boolean),
    confirmLabel: "开始发送",
    tone: "normal"
  });
  if (ok) await controlOutreachBatch(batchId, "approve", button);
}

async function controlOutreachBatch(batchId: string, action: "approve" | "pause" | "resume" | "cancel", button?: HTMLButtonElement) {
  if (!batchId) return;
  if (button) button.disabled = true;
  try {
    const result = await api<{ batch: OutreachBatchView }>(`/api/prospect-outreach-batches/${encodeURIComponent(batchId)}${action === "approve" ? "/approve" : `/${action}`}`, {
      method: "POST",
      body: JSON.stringify({})
    });
    const index = state.outreachBatches.findIndex((item) => item.id === batchId);
    if (index >= 0) state.outreachBatches[index] = result.batch;
    toast(action === "approve" ? `已开始发送，共 ${result.batch.counts.frozen} 封进入自动投递队列` : action === "pause" ? "批次已暂停，可随时继续" : action === "resume" ? "批次已恢复发送" : "批次已取消");
    renderOutreachBatches();
  } catch (error) {
    toast(error instanceof Error ? error.message : "操作失败", "error");
    if (button) button.disabled = false;
  }
}

async function updateOutreachBatchItem(
  batchId: string,
  action: "remove" | "restore" | "edit" | "stage",
  itemId: string,
  payload?: { stepIndex: number; subject: string; body: string } | { stageKey: string }
) {
  if (!batchId || !itemId) return;
  try {
    const result = await api<{ batch: OutreachBatchView }>(`/api/prospect-outreach-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}`, {
      method: "POST",
      body: JSON.stringify(payload ? { action, ...payload } : { action })
    });
    const index = state.outreachBatches.findIndex((item) => item.id === batchId);
    if (index >= 0) state.outreachBatches[index] = result.batch;
    renderOutreachBatches();
    if (action === "edit") toast("邮件内容已更新", "success");
    if (action === "stage") toast("已按新阶段重排这条的开发信", "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "操作失败", "error");
    // 重排失败要让界面回到真实状态，否则下拉停在用户选的那一项、实际没改
    if (action === "stage") renderOutreachBatches();
  }
}

/** 冻结前逐封编辑批次邮件（弹窗内编辑所有待发步骤的主题与正文） */
function openOutreachItemEditor(batchId: string, itemId: string) {
  const batch = state.outreachBatches.find((item) => item.id === batchId);
  const item = batch?.items.find((row) => row.id === itemId);
  if (!batch || !item) return;
  const pendingSteps = item.steps.filter((step) => step.status === "pending");
  if (!pendingSteps.length) {
    toast("该候选没有可编辑的待发步骤", "error");
    return;
  }
  const body = pendingSteps.map((step) => `
    <div class="form-grid" style="margin-bottom:14px">
      <label style="grid-column:1/-1">步骤 ${step.index + 1} 主题<textarea id="obEditSubject_${step.index}" rows="2" style="margin-top:4px">${escapeHtml(step.subject)}</textarea></label>
      <label style="grid-column:1/-1">步骤 ${step.index + 1} 正文<textarea id="obEditBody_${step.index}" rows="8" style="margin-top:4px;font-family:var(--font-mono,monospace);font-size:12px">${escapeHtml(step.body)}</textarea></label>
    </div>`).join("");
  const foot = `<button class="btn" data-modal-cancel>取消</button><button class="btn primary" id="obEditSaveButton">保存全部步骤</button>`;
  openModal(`编辑开发信 · ${outreachItemCompanyLabel(item)}`, body, foot);
  qs<HTMLButtonElement>("#obEditSaveButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      for (const step of pendingSteps) {
        const subject = qs<HTMLTextAreaElement>(`#obEditSubject_${step.index}`)?.value.trim() || "";
        const bodyText = qs<HTMLTextAreaElement>(`#obEditBody_${step.index}`)?.value.trim() || "";
        await updateOutreachBatchItem(batchId, "edit", itemId, { stepIndex: step.index, subject, body: bodyText });
      }
      closeModal();
    } finally {
      button.disabled = false;
    }
  });
}

/** 发送策略弹窗（候选/线索共用）：校验通过后回调创建 */
const OUTREACH_POLICY_PRESETS: Array<{ key: string; label: string; note: string; policy: OutreachPolicyInput }> = [
  { key: "steady", label: "稳健", note: "新客户首选：每天 20 封 · 3 天一跟进 · 工作时段发送", policy: { dailyLimit: 20, stepIntervalHours: 72, sendWindowStartHour: 9, sendWindowEndHour: 18, stopOnReply: true } },
  { key: "active", label: "进取", note: "量大时用：每天 50 封 · 2 天一跟进 · 更长发送时段", policy: { dailyLimit: 50, stepIntervalHours: 48, sendWindowStartHour: 8, sendWindowEndHour: 20, stopOnReply: true } }
];

function openOutreachBatchPolicyModal(count: number, targetLabel: string, onCreate: (policy: OutreachPolicyInput) => Promise<void>) {
  const body = `
    <p style="margin:0 0 10px;color:var(--text-secondary,#5f6b7a);font-size:12px">将创建 ${count} 个${targetLabel}的发信批次。先选一个节奏，再按需微调数字；确认发送后这些设置不可再改：</p>
    <div style="display:grid;gap:8px;margin-bottom:12px" id="obPolicyPresetRow">
      ${OUTREACH_POLICY_PRESETS.map((preset) => `
        <label style="display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border:1px solid #dbe4f0;border-radius:8px;cursor:pointer">
          <input type="radio" name="obPolicyPreset" value="${preset.key}" ${preset.key === "steady" ? "checked" : ""} style="margin-top:2px">
          <span><b style="font-size:12px;color:#17233d">${preset.label}</b><small style="display:block;margin-top:2px;color:#728099;font-size:10px">${preset.note}</small></span>
        </label>`).join("")}
    </div>
    <div class="form-grid">
      <label>每天最多发多少封<input id="obPolicyDailyLimit" type="number" min="1" max="200" value="20"><small style="color:#8a96a7;font-size:10px">超出的自动顺延到下一天，防止被对方邮箱判为垃圾邮件</small></label>
      <label>跟进信间隔多久<input id="obPolicyStepInterval" type="number" min="1" max="720" value="72"><small style="color:#8a96a7;font-size:10px">单位小时：72 = 3 天后再发第 2 封</small></label>
      <label>发送时段从几点<input id="obPolicyWindowStart" type="number" min="0" max="23" value="9"><small style="color:#8a96a7;font-size:10px">时段外只排队、不发送，避免深夜打扰</small></label>
      <label>发送时段到几点<input id="obPolicyWindowEnd" type="number" min="1" max="24" value="18"><small style="color:#8a96a7;font-size:10px">0–24 之间的整点</small></label>
      <label style="grid-column:1/-1;display:flex;gap:8px;align-items:center"><input id="obPolicyStopOnReply" type="checkbox" checked>客户回复后自动停止发给他其余的信（推荐）</label>
    </div>`;
  const foot = `<button class="btn" data-modal-cancel>取消</button><button class="btn primary" id="obPolicyCreateButton">创建批次</button>`;
  openModal(`发送节奏 · ${count} 个${targetLabel}`, body, foot);
  // 数字微调框需要专属样式（否则吃浏览器原生样式，又大又黑），挂作用域类
  qs<HTMLElement>("#appModal .modal")?.classList.add("outreach-policy-modal");
  const applyPreset = (key: string) => {
    const preset = OUTREACH_POLICY_PRESETS.find((item) => item.key === key);
    if (!preset) return;
    qs<HTMLInputElement>("#obPolicyDailyLimit")!.value = String(preset.policy.dailyLimit);
    qs<HTMLInputElement>("#obPolicyStepInterval")!.value = String(preset.policy.stepIntervalHours);
    qs<HTMLInputElement>("#obPolicyWindowStart")!.value = String(preset.policy.sendWindowStartHour);
    qs<HTMLInputElement>("#obPolicyWindowEnd")!.value = String(preset.policy.sendWindowEndHour);
    qs<HTMLInputElement>("#obPolicyStopOnReply")!.checked = preset.policy.stopOnReply;
  };
  qs<HTMLElement>("#obPolicyPresetRow")?.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.name === "obPolicyPreset" && target.value) applyPreset(target.value);
  });
  qs<HTMLButtonElement>("#obPolicyCreateButton")?.addEventListener("click", async (event) => {
    const createButton = event.currentTarget as HTMLButtonElement;
    const dailyLimit = Number(qs<HTMLInputElement>("#obPolicyDailyLimit")?.value);
    const stepIntervalHours = Number(qs<HTMLInputElement>("#obPolicyStepInterval")?.value);
    const sendWindowStartHour = Number(qs<HTMLInputElement>("#obPolicyWindowStart")?.value);
    const sendWindowEndHour = Number(qs<HTMLInputElement>("#obPolicyWindowEnd")?.value);
    const stopOnReply = qs<HTMLInputElement>("#obPolicyStopOnReply")?.checked ?? true;
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 200) {
      toast("「每天最多发多少封」请填 1–200 的整数", "error");
      return;
    }
    if (!Number.isInteger(stepIntervalHours) || stepIntervalHours < 1 || stepIntervalHours > 720) {
      toast("「跟进信间隔多久」请填 1–720 的整数小时", "error");
      return;
    }
    if (!Number.isInteger(sendWindowStartHour) || sendWindowStartHour < 0 || sendWindowStartHour > 23 || !Number.isInteger(sendWindowEndHour) || sendWindowEndHour < 1 || sendWindowEndHour > 24 || sendWindowStartHour >= sendWindowEndHour) {
      toast("发送时段需为 0–24 之间的整点，且开始早于结束", "error");
      return;
    }
    createButton.disabled = true;
    try {
      await onCreate({ dailyLimit, stepIntervalHours, sendWindowStartHour, sendWindowEndHour, stopOnReply });
    } finally {
      createButton.disabled = false;
    }
  });
}

type OutreachPolicyInput = {
  dailyLimit: number;
  stepIntervalHours: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  stopOnReply: boolean;
};

/** 线索批量发信：勾选线索 → 策略弹窗 → targetType=lead 批次 */
export function createLeadOutreachBatchFromSelection() {
  const ids = [...state.selectedLeadIds];
  if (!ids.length) {
    toast("请先勾选要发信的线索（表格第一列勾选框）", "error");
    return;
  }
  const missingEmail = state.leads.filter((lead) => ids.includes(lead.id) && !(lead.email || "").trim()).length;
  if (missingEmail === ids.length) {
    toast("勾选的线索都没有邮箱，先补全联系方式", "error");
    return;
  }
  if (missingEmail > 0) toast(`${missingEmail} 条线索没有邮箱，将进入跳过清单`, "error");
  void openOutreachBatchPolicyModal(ids.length, "线索", async (policy) => {
    const result = await api<{ batch: OutreachBatchView }>("/api/prospect-outreach-batches", {
      method: "POST",
      body: JSON.stringify({ targetType: "lead", leadIds: ids, policy })
    });
    state.outreachBatches.unshift(result.batch);
    state.selectedLeadIds = [];
    closeModal();
    toast(`线索批次已创建：${result.batch.counts.frozen} 封待发送${result.batch.counts.skipped ? `，${result.batch.counts.skipped} 位无邮箱/不合格的会被自动跳过` : ""}。回批次页核对后点「确认开始发送」`);
    activateNavView("outreach-batches", () => renderOutreachBatches());
  });
}

/** 从搜客清单勾选创建批次：先弹发送策略设置，确认后创建 */
export function createOutreachBatchFromSelection(button?: HTMLButtonElement) {
  const ids = [...state.selectedProspectIds];
  if (!ids.length) {
    toast("请先在搜客清单勾选要发信的候选", "error");
    return;
  }
  void openOutreachBatchPolicyModal(ids.length, "候选", async (policy) => {
    const result = await api<{ batch: OutreachBatchView }>("/api/prospect-outreach-batches", {
      method: "POST",
      body: JSON.stringify({ targetType: "candidate", candidateIds: ids, policy })
    });
    state.outreachBatches.unshift(result.batch);
    closeModal();
    toast(`批次已创建：${result.batch.counts.frozen} 封待发送${result.batch.counts.skipped ? `，${result.batch.counts.skipped} 位无邮箱/不合格的会被自动跳过` : ""}。核对好信件内容后点「确认开始发送」`);
    activateNavView("outreach-batches", () => renderOutreachBatches());
  });
}

export function bindOutreachBatchesEvents() {
  const button = qs<HTMLButtonElement>("#outreachBatchRefreshButton");
  if (!button) return;
  // 用 onclick 赋值保证幂等（重复绑定不会叠加监听器）；旋转图标至少转 450ms，避免"闪一下就没"
  button.onclick = async () => {
    if (button.classList.contains("is-busy")) return;
    button.classList.add("is-busy");
    try {
      await Promise.all([loadOutreachBatches(), loadOutreachPlans()]);
    } finally {
      window.setTimeout(() => button.classList.remove("is-busy"), 450);
    }
  };
}
