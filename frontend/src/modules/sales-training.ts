/**
 * 销售训练与销售蒸馏。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { maintenanceMatrixDraft, state } from "../prototype-api";
import {
  type SalesDistillation, type SalesDistillationMetrics, type SalesDistillationSource, type SalesPlaybookActivation,
  type SalesTrainingMaturity, type SalesTrainingRun, type SalesTrainingSampleLabel, type SalesTrainingStatus
} from "./models";
import { amount, escapeHtml, qs, qsa, roleLabel } from "./shared";
import { renderAgent, salesDistillationMetricLabel } from "./agent";
import { api, toast } from "./ui";
import { hasIamCapability } from "./auth";
import { formatDateTime } from "./deals";

let selectedSalesTrainingRunId = "";
let salesTrainingPollTimer = 0;

function salesTrainingStatusLabel(status: SalesTrainingStatus) {
  return ({ queued: "等待训练", collecting: "采集样本", cleaning: "清洗证据", labeling: "结果标注", training: "策略训练", evaluating: "离线评测", awaiting_review: "等待审核", published: "已发布", paused: "已暂停", failed: "训练失败", cancelled: "已取消" } as Record<SalesTrainingStatus, string>)[status];
}

export function salesTrainingMaturityLabel(maturity: SalesTrainingMaturity) {
  return ({ observation: "观察级", trial: "试用级", production: "生产级", stable: "稳定级" } as Record<SalesTrainingMaturity, string>)[maturity];
}

function renderSalesTrainingWorkspace() {
  const queue = qs<HTMLElement>("#salesTrainingQueue");
  const count = qs<HTMLElement>("#salesTrainingQueueCount");
  const detail = qs<HTMLElement>("#salesTrainingDetail");
  const quality = qs<HTMLElement>("#salesTrainingQuality");
  if (!queue || !detail || !quality) return;
  if (count) count.textContent = String(state.salesTrainingRuns.length);
  if (!selectedSalesTrainingRunId || !state.salesTrainingRuns.some((item) => item.id === selectedSalesTrainingRunId)) selectedSalesTrainingRunId = state.salesTrainingRuns[0]?.id || "";
  queue.innerHTML = state.salesTrainingRuns.length
    ? state.salesTrainingRuns.map((item) => {
        const tone = ["queued", "collecting", "cleaning", "labeling", "training", "evaluating"].includes(item.status) ? "running" : item.status === "awaiting_review" ? "review" : item.status === "published" ? "published" : "";
        return `<button class="sales-training-queue-item ${tone}${item.id === selectedSalesTrainingRunId ? " active" : ""}" type="button" data-sales-training-run="${escapeHtml(item.id)}"><div><b>${escapeHtml(item.sourceUserName)} · V${item.version}</b><i></i></div><small>${escapeHtml(salesTrainingStatusLabel(item.status))} · ${item.progress}%</small></button>`;
      }).join("")
    : `<div class="sales-training-empty">暂无训练任务</div>`;
  qsa<HTMLButtonElement>("[data-sales-training-run]", queue).forEach((button) => button.addEventListener("click", () => { selectedSalesTrainingRunId = button.dataset.salesTrainingRun || ""; renderSalesTrainingWorkspace(); }));
  const run = state.salesTrainingRuns.find((item) => item.id === selectedSalesTrainingRunId);
  if (!run) {
    detail.innerHTML = `<div class="sales-training-welcome"><span>AI</span><div><h2>暂无训练任务</h2></div></div>`;
    quality.innerHTML = `<div class="sales-training-quality-empty">暂无训练质量</div>`;
    return;
  }
  const active = ["queued", "collecting", "cleaning", "labeling", "training", "evaluating"].includes(run.status);
  const canReviewSamples = ["awaiting_review", "paused", "failed"].includes(run.status);
  const stageNames = ["样本采集", "证据清洗", "结果标注", "策略训练", "离线评测"];
  const stageCards = stageNames.map((name, index) => {
    const round = run.rounds.find((item) => item.index === index + 1);
    const status = round?.status || "pending";
    return `<div class="sales-training-stage ${status}"><b>${escapeHtml(name)}</b><small>${escapeHtml(round?.summary || (status === "running" ? "正在运行" : "等待开始"))}</small></div>`;
  }).join("");
  const controls = active
    ? `<button class="btn" type="button" data-sales-training-control="pause">暂停</button><button class="btn" type="button" data-sales-training-control="cancel">取消</button>`
    : ["paused", "failed"].includes(run.status)
      ? `<button class="btn primary" type="button" data-sales-training-control="resume">继续训练</button><button class="btn" type="button" data-sales-training-control="cancel">取消</button>`
      : "";
  detail.innerHTML = `<div class="sales-training-run-head"><div><h2>${escapeHtml(run.sourceUserName)} 销售能力训练</h2><p>第 ${run.version} 版 · 近 ${run.periodDays} 天 · ${escapeHtml(run.modelLabel)}</p></div><div class="head-actions">${controls}</div></div>
    <div class="sales-training-progress"><div><span>${escapeHtml(run.currentAction || salesTrainingStatusLabel(run.status))}</span><strong>${run.progress}%</strong></div><span><i style="width:${Math.max(0, Math.min(100, run.progress))}%"></i></span></div>
    <div class="sales-training-stages">${stageCards}</div>
    <div class="sales-training-section-title"><h3>训练动态</h3><span>${run.events.length} 条</span></div>
    <div class="sales-training-events">${[...run.events].reverse().slice(0, 30).map((item) => `<div class="sales-training-event"><b>${escapeHtml(salesTrainingStatusLabel(item.stage))}</b><span>${escapeHtml(item.message)}</span><time>${new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>`).join("")}</div>
    <div class="sales-training-section-title"><h3>训练样本</h3><span>有效 ${run.sampleStats.valid} · 淘汰 ${run.sampleStats.rejected}</span></div>
    <div class="sales-training-samples">${run.samples.length ? run.samples.slice(0, 12).map((sample) => `<div class="sales-training-sample"><input type="checkbox" data-sales-training-sample-include="${escapeHtml(sample.id)}" ${sample.included ? "checked" : ""} ${canReviewSamples ? "" : "disabled"}><div><b>${escapeHtml(sample.title)}</b><small>${escapeHtml(sample.summary)}</small></div><select data-sales-training-sample-label="${escapeHtml(sample.id)}" ${canReviewSamples ? "" : "disabled"}><option value="positive" ${sample.label === "positive" ? "selected" : ""}>正向</option><option value="negative" ${sample.label === "negative" ? "selected" : ""}>负向</option><option value="neutral" ${sample.label === "neutral" ? "selected" : ""}>中性</option></select></div>`).join("") : `<div class="sales-training-empty">暂无训练样本</div>`}</div>`;
  qsa<HTMLButtonElement>("[data-sales-training-control]", detail).forEach((button) => button.addEventListener("click", () => void controlSalesTrainingFromUi(button.dataset.salesTrainingControl as "pause" | "resume" | "cancel")));
  qsa<HTMLInputElement>("[data-sales-training-sample-include]", detail).forEach((input) => input.addEventListener("change", () => void updateSalesTrainingSampleFromUi(input.dataset.salesTrainingSampleInclude || "", { included: input.checked })));
  qsa<HTMLSelectElement>("[data-sales-training-sample-label]", detail).forEach((select) => select.addEventListener("change", () => void updateSalesTrainingSampleFromUi(select.dataset.salesTrainingSampleLabel || "", { label: select.value as SalesTrainingSampleLabel })));
  const evaluationRows = [["覆盖度", run.evaluation.coverage], ["样本平衡", run.evaluation.balance], ["证据追溯", run.evaluation.traceability], ["策略完整", run.evaluation.strategy], ["安全性", run.evaluation.safety]] as Array<[string, number]>;
  const canPublish = Boolean(hasIamCapability("training.manage") && run.status === "awaiting_review" && run.evaluation.passed);
  quality.innerHTML = `<div class="sales-quality-head"><span>训练成熟度</span><b>${escapeHtml(salesTrainingMaturityLabel(run.maturity))}</b></div>
    <div class="sales-quality-grid"><div class="sales-quality-metric"><span>有效样本</span><b>${run.sampleStats.valid}</b></div><div class="sales-quality-metric"><span>淘汰样本</span><b>${run.sampleStats.rejected}</b></div><div class="sales-quality-metric"><span>正向 / 负向</span><b>${run.sampleStats.positive} / ${run.sampleStats.negative}</b></div><div class="sales-quality-metric"><span>留出评测</span><b>${run.sampleStats.holdout}</b></div></div>
    <div class="sales-training-section-title"><h3>离线评测</h3><span>${run.evaluation.overall} 分</span></div>${evaluationRows.map(([label, value]) => `<div class="sales-evaluation-row"><span>${label}</span><b>${value}</b></div>`).join("")}
    ${run.evaluation.blockers.map((item) => `<div class="sales-training-blocker">${escapeHtml(item)}</div>`).join("")}
    ${canPublish ? `<button class="btn primary" type="button" id="salesTrainingPublishButton">审核并发布能力</button>` : ""}
    ${["awaiting_review", "published", "failed", "cancelled"].includes(run.status) ? `<button class="btn" type="button" id="salesTrainingRetrainButton">创建下一训练版本</button>` : ""}`;
  qs<HTMLButtonElement>("#salesTrainingPublishButton", quality)?.addEventListener("click", () => void publishSalesTrainingFromUi());
  qs<HTMLButtonElement>("#salesTrainingRetrainButton", quality)?.addEventListener("click", () => void retrainSalesTrainingFromUi());
}

function renderSalesDistillation() {
  const sourceSelect = qs<HTMLSelectElement>("#salesDistillationSource");
  const periodSelect = qs<HTMLSelectElement>("#salesDistillationPeriod");
  const list = qs<HTMLElement>("#salesDistillationCards");
  if (!sourceSelect || !periodSelect || !list) return;
  const selectedSource = sourceSelect.value || state.user?.id || "";
  sourceSelect.innerHTML = state.salesDistillationSources.map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.name)} · ${escapeHtml(roleLabel[source.role])}</option>`).join("");
  sourceSelect.value = state.salesDistillationSources.some((source) => source.id === selectedSource) ? selectedSource : state.salesDistillationSources[0]?.id || "";
  renderSalesTrainingWorkspace();
  const canPublish = hasIamCapability("training.manage");
  const published = state.salesDistillations.filter((item) => item.status === "published");
  if (!published.length) {
    list.innerHTML = `<div class="sales-distillation-empty"><div class="sales-distillation-empty-icon">◎</div><h3>暂无已发布能力</h3></div>`;
    return;
  }
  list.innerHTML = published.map((item) => {
    const metrics = Object.entries(item.metrics) as Array<[keyof SalesDistillationMetrics, number]>;
    const activation = state.salesPlaybookActivations.find((entry) => entry.distillationId === item.id);
    const active = activation?.status === "active";
    const statusText = item.version ? `能力 V${item.version}` : "历史打法";
    const publishButton = canPublish && item.status !== "published" ? `<button class="btn primary" type="button" data-sales-distillation-publish="${escapeHtml(item.id)}">发布团队打法</button>` : "";
    const applyButton = item.status === "published"
      ? active
        ? `<button class="btn" type="button" data-sales-playbook-pause="${escapeHtml(activation.id)}">停用当前打法</button>`
        : `<button class="btn primary" type="button" data-sales-playbook-activate="${escapeHtml(item.id)}">应用到我的 Agent</button>`
      : "";
    const usage = activation
      ? `<span class="sales-playbook-usage ${active ? "active" : ""}"><b>${active ? "正在应用" : "已停用"}</b><small>应用 ${activation.applicationCount} 次 · 生成待办 ${activation.taskCount} 个${activation.lastUsedAt ? ` · 最近 ${escapeHtml(formatDateTime(activation.lastUsedAt))}` : ""}</small></span>`
      : `<span></span>`;
    return `<article class="sales-distillation-card">
      <header class="sales-card-head"><div class="sales-person"><span class="sales-person-avatar">${escapeHtml(item.sourceUserName.slice(0, 1))}</span><div><h3>${escapeHtml(item.sourceUserName)}</h3><p>${escapeHtml(roleLabel[state.salesDistillationSources.find((source) => source.id === item.sourceUserId)?.role || "sales"])} · ${escapeHtml(item.maturity ? salesTrainingMaturityLabel(item.maturity) : "历史能力")} · ${item.sampleCount || 0} 个样本</p></div></div><div class="sales-card-meta"><span class="badge ${active ? "blue" : "green"}">${active ? "当前能力" : statusText}</span><small>评测 ${item.evaluationScore || "-"} · ${escapeHtml(item.modelLabel)} · ${new Date(item.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small></div></header>
      <div class="sales-metric-grid">${metrics.map(([key, value]) => `<div class="sales-metric"><span>${salesDistillationMetricLabel(key)}</span><b>${key === "wonAmount" ? amount(Number(value)) : Number(value).toLocaleString("zh-CN")}</b></div>`).join("")}</div>
      <div class="sales-card-columns"><section><div class="sales-section-title"><span>01</span><h4>优势模式</h4></div><ul>${item.patterns.map((pattern) => `<li>${escapeHtml(pattern)}</li>`).join("")}</ul></section><section><div class="sales-section-title"><span>02</span><h4>可复制打法</h4></div><div class="sales-playbook">${item.playbook.map((step) => `<div class="sales-playbook-row"><b>${escapeHtml(step.stage)}</b><p>${escapeHtml(step.action)}</p><small>依据：${escapeHtml(step.evidence)}</small></div>`).join("")}</div></section><section><div class="sales-section-title"><span>03</span><h4>下一步训练</h4></div><ol>${item.coachingActions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ol></section></div>
      <footer class="sales-card-foot">${usage}<div class="head-actions">${publishButton}${applyButton}</div></footer>
    </article>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-sales-distillation-publish]", list).forEach((button) => button.addEventListener("click", () => void publishSalesDistillationFromUi(button.dataset.salesDistillationPublish || "", button)));
  qsa<HTMLButtonElement>("[data-sales-playbook-activate]", list).forEach((button) => button.addEventListener("click", () => void activateSalesPlaybookFromUi(button.dataset.salesPlaybookActivate || "", button)));
  qsa<HTMLButtonElement>("[data-sales-playbook-pause]", list).forEach((button) => button.addEventListener("click", () => void pauseSalesPlaybookFromUi(button.dataset.salesPlaybookPause || "", button)));
}

export async function loadSalesDistillationWorkspace() {
  try {
    const [sources, distillations, training] = await Promise.all([
      api<{ sources: SalesDistillationSource[] }>("/api/agent/sales-distillation/sources"),
      api<{ distillations: SalesDistillation[]; activations: SalesPlaybookActivation[] }>("/api/agent/sales-distillation"),
      api<{ runs: SalesTrainingRun[] }>("/api/agent/sales-training")
    ]);
    state.salesDistillationSources = sources.sources || [];
    state.salesDistillations = distillations.distillations || [];
    state.salesPlaybookActivations = distillations.activations || [];
    state.salesTrainingRuns = training.runs || [];
    renderSalesDistillation();
    syncSalesTrainingPolling();
  } catch (error) {
    toast(error instanceof Error ? error.message : "销售训练中心加载失败", "error");
  }
}

function syncSalesTrainingPolling() {
  const active = state.salesTrainingRuns.some((item) => ["queued", "collecting", "cleaning", "labeling", "training", "evaluating"].includes(item.status));
  if (!active) {
    if (salesTrainingPollTimer) window.clearInterval(salesTrainingPollTimer);
    salesTrainingPollTimer = 0;
    return;
  }
  if (!salesTrainingPollTimer) salesTrainingPollTimer = window.setInterval(() => {
    if (qs<HTMLElement>("#sales-distillation")?.classList.contains("active")) void loadSalesDistillationWorkspace();
  }, 1_500);
}

export async function createSalesDistillationFromUi(button: HTMLButtonElement) {
  const sourceUserId = qs<HTMLSelectElement>("#salesDistillationSource")?.value || state.user?.id || "";
  const periodDays = Number(qs<HTMLSelectElement>("#salesDistillationPeriod")?.value || 90);
  if (!sourceUserId) {
    toast("当前账号没有可训练的业务员数据", "error");
    return;
  }
  state.salesDistillationLoading = true;
  button.disabled = true;
  button.textContent = "正在创建";
  try {
    const result = await api<{ run: SalesTrainingRun }>("/api/agent/sales-training", { method: "POST", body: JSON.stringify({ sourceUserId, periodDays }) });
    state.salesTrainingRuns = [result.run, ...state.salesTrainingRuns.filter((item) => item.id !== result.run.id)];
    selectedSalesTrainingRunId = result.run.id;
    renderSalesDistillation();
    syncSalesTrainingPolling();
    toast(`${result.run.sourceUserName} 的训练任务已启动`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "创建训练任务失败", "error");
  } finally {
    state.salesDistillationLoading = false;
    button.disabled = false;
    button.textContent = "开始训练";
  }
}

async function controlSalesTrainingFromUi(action: "pause" | "resume" | "cancel") {
  if (!selectedSalesTrainingRunId) return;
  try {
    const result = await api<{ run: SalesTrainingRun }>(`/api/agent/sales-training/${encodeURIComponent(selectedSalesTrainingRunId)}/${action}`, { method: "POST" });
    state.salesTrainingRuns = [result.run, ...state.salesTrainingRuns.filter((item) => item.id !== result.run.id)];
    renderSalesDistillation();
    syncSalesTrainingPolling();
    toast(action === "pause" ? "训练已暂停" : action === "resume" ? "训练已继续" : "训练已取消");
  } catch (error) { toast(error instanceof Error ? error.message : "训练控制失败", "error"); }
}

async function updateSalesTrainingSampleFromUi(sampleId: string, body: { label?: SalesTrainingSampleLabel; included?: boolean }) {
  if (!selectedSalesTrainingRunId || !sampleId) return;
  try {
    const result = await api<{ run: SalesTrainingRun }>(`/api/agent/sales-training/${encodeURIComponent(selectedSalesTrainingRunId)}/samples/${encodeURIComponent(sampleId)}`, { method: "PATCH", body: JSON.stringify(body) });
    state.salesTrainingRuns = [result.run, ...state.salesTrainingRuns.filter((item) => item.id !== result.run.id)];
    renderSalesDistillation();
  } catch (error) { toast(error instanceof Error ? error.message : "样本复核失败", "error"); }
}

async function publishSalesTrainingFromUi() {
  if (!selectedSalesTrainingRunId) return;
  try {
    const result = await api<{ run: SalesTrainingRun; distillation: SalesDistillation }>(`/api/agent/sales-training/${encodeURIComponent(selectedSalesTrainingRunId)}/publish`, { method: "POST" });
    state.salesTrainingRuns = [result.run, ...state.salesTrainingRuns.filter((item) => item.id !== result.run.id)];
    state.salesDistillations = [result.distillation, ...state.salesDistillations.filter((item) => item.id !== result.distillation.id)];
    renderSalesDistillation();
    toast(`${result.run.sourceUserName} 的第 ${result.run.version} 版能力已发布`);
  } catch (error) { toast(error instanceof Error ? error.message : "能力发布失败", "error"); }
}

async function retrainSalesTrainingFromUi() {
  if (!selectedSalesTrainingRunId) return;
  try {
    const result = await api<{ run: SalesTrainingRun }>(`/api/agent/sales-training/${encodeURIComponent(selectedSalesTrainingRunId)}/retrain`, { method: "POST" });
    state.salesTrainingRuns = [result.run, ...state.salesTrainingRuns.filter((item) => item.id !== result.run.id)];
    selectedSalesTrainingRunId = result.run.id;
    renderSalesDistillation();
    syncSalesTrainingPolling();
    toast(`第 ${result.run.version} 版训练已启动`);
  } catch (error) { toast(error instanceof Error ? error.message : "创建再训练版本失败", "error"); }
}

export async function publishSalesDistillationFromUi(id: string, button: HTMLButtonElement) {
  if (!id) return;
  button.disabled = true;
  try {
    const result = await api<{ distillation: SalesDistillation }>(`/api/agent/sales-distillation/${encodeURIComponent(id)}/publish`, { method: "POST" });
    state.salesDistillations = state.salesDistillations.map((item) => item.id === id ? result.distillation : item);
    renderSalesDistillation();
    toast("已发布为团队可复用打法");
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布失败", "error");
    button.disabled = false;
  }
}

export async function activateSalesPlaybookFromUi(id: string, button: HTMLButtonElement) {
  if (!id) return;
  button.disabled = true;
  try {
    const result = await api<{ activation: SalesPlaybookActivation; activations: SalesPlaybookActivation[] }>(`/api/agent/sales-distillation/${encodeURIComponent(id)}/activate`, { method: "POST" });
    state.salesPlaybookActivations = result.activations || [result.activation];
    renderSalesDistillation();
    renderAgent(state.agentRun);
    toast("已应用到你的 Agent 和客户守护");
  } catch (error) {
    toast(error instanceof Error ? error.message : "应用打法失败", "error");
    button.disabled = false;
  }
}

export async function pauseSalesPlaybookFromUi(id: string, button: HTMLButtonElement) {
  if (!id) return;
  button.disabled = true;
  try {
    const result = await api<{ activation: SalesPlaybookActivation; activations: SalesPlaybookActivation[] }>(`/api/agent/sales-distillation/activations/${encodeURIComponent(id)}/pause`, { method: "POST" });
    state.salesPlaybookActivations = result.activations || [result.activation];
    renderSalesDistillation();
    renderAgent(state.agentRun);
    toast("当前蒸馏打法已停用");
  } catch (error) {
    toast(error instanceof Error ? error.message : "停用打法失败", "error");
    button.disabled = false;
  }
}

// ————————————————————————————————————————————————————————————————
// 自动维护中心（独立视图）
// 后端引擎 customer-maintenance.ts 早已在跑，这里只补「看得见 + 可控制」。
// 三条原则：自动 ≠ 放权（只建站内待办）、可解释（原因 + 跳过数）、幂等可叫停。
// ————————————————————————————————————————————————————————————————

export const maintenanceReasonLabels: Record<string, string> = {
  low_health: "健康度低于阈值",
  overdue_followup: "客户跟进已逾期",
  inactive_customer: "超期未跟进",
  missing_next_action: "商机缺少下一动作",
  next_action_due: "商机下一动作已到期"
};

export const maintenancePriorityText: Record<string, string> = { high: "高", medium: "中", normal: "低" };

export interface MaintenanceMatrixRow {
  id: string;
  label: string;
  grades: Array<"A" | "B" | "C" | "D">;
  intervalHours: number;
  inactivityDays: number;
  healthBelow: number;
  maxTodosPerRun: number;
  intensity: string;
  automation: string;
}

export type MaintenancePresetKey = "aggressive" | "balanced" | "conservative";

/**
 * 等级矩阵不 1:1 映射成一个 watch —— 后端 rules.grades 的语义是「哪些等级纳入扫描」，
 * 不支持「每个等级不同阈值」。所以界面呈现为矩阵，底层生成 A / B / C+D 三个守护策略。
 */
export const maintenanceMatrixPresets: Record<MaintenancePresetKey, { label: string; note: string; rows: MaintenanceMatrixRow[] }> = {
  aggressive: {
    label: "激进",
    note: "全等级密集跟进。适合人手充足、需要快速激活存量客户的阶段。",
    rows: [
      { id: "a", label: "A 级", grades: ["A"], intervalHours: 6, inactivityDays: 2, healthBelow: 75, maxTodosPerRun: 10, intensity: "高", automation: "建待办 + 生成发信草稿" },
      { id: "b", label: "B 级", grades: ["B"], intervalHours: 12, inactivityDays: 4, healthBelow: 65, maxTodosPerRun: 10, intensity: "中", automation: "建待办 + 生成发信草稿" },
      { id: "cd", label: "C / D 级", grades: ["C", "D"], intervalHours: 24, inactivityDays: 10, healthBelow: 50, maxTodosPerRun: 5, intensity: "低", automation: "仅建待办" }
    ]
  },
  balanced: {
    label: "均衡",
    note: "推荐。A 级 12 小时盯一次，B 级每天一次，C/D 两天一次。历史数据较多时建议先只启用 A、B 两行观察命中质量。",
    rows: [
      { id: "a", label: "A 级", grades: ["A"], intervalHours: 12, inactivityDays: 3, healthBelow: 70, maxTodosPerRun: 8, intensity: "高", automation: "建待办 + 生成发信草稿" },
      { id: "b", label: "B 级", grades: ["B"], intervalHours: 24, inactivityDays: 7, healthBelow: 60, maxTodosPerRun: 8, intensity: "中", automation: "建待办 + 生成发信草稿" },
      { id: "cd", label: "C / D 级", grades: ["C", "D"], intervalHours: 48, inactivityDays: 14, healthBelow: 50, maxTodosPerRun: 5, intensity: "低", automation: "仅建待办" }
    ]
  },
  conservative: {
    label: "保守",
    note: "只守 A / B 两档，C / D 交给月度复核，避免打扰低价值客户。",
    rows: [
      { id: "a", label: "A 级", grades: ["A"], intervalHours: 24, inactivityDays: 5, healthBelow: 70, maxTodosPerRun: 5, intensity: "中", automation: "建待办 + 生成发信草稿" },
      { id: "b", label: "B 级", grades: ["B"], intervalHours: 72, inactivityDays: 14, healthBelow: 55, maxTodosPerRun: 5, intensity: "低", automation: "仅建待办" }
    ]
  }
};

export function readMaintenanceMatrixInputs() {
  if (!maintenanceMatrixDraft.length) return;
  const fields = ["inactivityDays", "healthBelow", "intervalHours", "maxTodosPerRun"] as const;
  for (const row of maintenanceMatrixDraft) {
    for (const field of fields) {
      const input = qs<HTMLInputElement>(`#maintenanceMatrixBody [data-matrix-row="${row.id}"][data-matrix-field="${field}"]`);
      if (!input) continue;
      const value = Number(input.value);
      if (Number.isFinite(value)) row[field] = Math.round(value);
    }
  }
}
