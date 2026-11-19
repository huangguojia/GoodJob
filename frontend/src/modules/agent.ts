/**
 * AI Agent：会话、检查点、记忆、知识、技能、触发器、治理、运行记录。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import {
  activateNavView, agentOriginView, agentSkillCategoryFilter, agentSkillQuery, agentSkillSourceFilter,
  agentSkillStatusFilter, applyAgentUiAction, closeModal, confirmAction, ensureAgentConversationId,
  modalCloseOnBackdrop, openModal, renderAgentConversations, renderAgentSkillFilters, state
} from "../prototype-api";
import {
  type AgentConversation, type AgentGovernance, type AgentKnowledgeDocument, type AgentKnowledgeKind,
  type AgentKnowledgeOverview, type AgentKnowledgeStatus, type AgentMemory, type AgentMemoryStatus,
  type AgentMissionCheckpoint, type AgentPlanningProgress, type AgentRisk, type AgentRun, type AgentSkill,
  type AgentStep, type AgentStepStatus, type AgentTriggerEvent, type AgentTriggerEventType, type AgentTriggerRule,
  type AgentTuningInspection, type AgentUiAction, type CustomerMaintenanceWatch, type OutreachSequence,
  type SalesDistillation, type SalesDistillationMetrics, type SalesPlaybookActivation
} from "./models";
import { refreshAll } from "./dashboard";
import { cookieValue, escapeHtml, qs, qsa } from "./shared";
import { loadSalesDistillationWorkspace, salesTrainingMaturityLabel } from "./sales-training";
import { api, toast } from "./ui";
import { hasIamCapability } from "./auth";
import { printDocumentPreview, renderTradeDocuments } from "./trade-documents";
import { copyToClipboard } from "./insights";

let agentRunPollTimer = 0;
let agentPendingGoal = "";
let agentPendingProgress: AgentPlanningProgress[] = [];
let agentMemoryTab: AgentMemoryStatus = "active";
let agentKnowledgeStatus: AgentKnowledgeStatus | "all" = "all";
let agentKnowledgeModule = "all";
let agentKnowledgeQuery = "";
let selectedAgentSkillId = "";

function agentRiskLabel(risk: AgentRisk) {
  return ({ read: "读取", draft: "草稿", write: "写入", external: "外部" } as Record<AgentRisk, string>)[risk];
}

function agentStepStatusLabel(status: AgentStepStatus) {
  return ({ ready: "待运行", needs_confirmation: "待确认", queued: "后台排队", running: "执行中", done: "已完成", failed: "失败", skipped: "已替代" } as Record<AgentStepStatus, string>)[status];
}

function agentRunStatusLabel(status: AgentRun["status"] | "idle" | "expired") {
  return ({ idle: "等待目标", expired: "已过期", planning: "正在规划", awaiting_confirmation: "等待确认", running: "执行中", paused: "已暂停", waiting_user: "等待补充", completed: "已完成", failed: "执行受阻", cancelled: "已取消" } as Record<AgentRun["status"] | "idle" | "expired", string>)[status];
}

function agentResultSummary(result: Record<string, unknown> | undefined) {
  if (!result) return "";
  const parts: string[] = [];
  ["count", "customerCount", "dealCount", "leadCount"].forEach((key) => {
    if (typeof result[key] === "number") parts.push(`${key === "count" ? "结果" : key === "customerCount" ? "客户" : key === "dealCount" ? "商机" : "线索"} ${result[key]}`);
  });
  if (typeof result.amount === "number") parts.push(`金额 ${Number(result.amount).toLocaleString("en-US")}`);
  if (typeof result.progress === "number") parts.push(`进度 ${result.progress}%`);
  if (typeof result.settledSources === "number" && typeof result.sourceCount === "number") parts.push(`来源 ${result.settledSources}/${result.sourceCount}`);
  if (typeof result.candidateCount === "number") parts.push(`候选 ${result.candidateCount}`);
  if (typeof result.verifiedCount === "number") parts.push(`已复核 ${result.verifiedCount}`);
  if (typeof result.filteredCount === "number") parts.push(`已淘汰 ${result.filteredCount}`);
  if (typeof result.approvedCount === "number") parts.push(`可转线索 ${result.approvedCount}`);
  if (typeof result.providerCount === "number") parts.push(`数据源 ${result.providerCount}`);
  if (typeof result.message === "string") parts.push(result.message);
  if (result.todo && typeof result.todo === "object") parts.push("已创建待办");
  if (result.activity && typeof result.activity === "object") parts.push("已记录跟进");
  if (typeof result.body === "string") parts.push(`正文 ${result.body.length} 字`);
  if (result.draft && typeof result.draft === "object") parts.push("开发信草稿已生成");
  if (result.sent === true) parts.push(result.replayed === true ? "发送记录已确认" : "已真实发送");
  if (result.followUpCreated === true) parts.push("已创建后续跟进");
  if (typeof result.accountName === "string") parts.push(`发送账号 ${result.accountName}`);
  if (typeof result.sequenceId === "string") {
    const maxSends = typeof result.maxSends === "number" ? ` · 最多 ${result.maxSends} 次` : "";
    parts.push(`自动触达已启动${maxSends}`);
  }
  if (typeof result.matchedCount === "number" && typeof result.creatableCount === "number") parts.push(`发现 ${result.matchedCount} 项 · 可建待办 ${result.creatableCount}`);
  if (typeof result.watchId === "string") parts.push(`客户守护已启用${typeof result.intervalHours === "number" ? ` · 每 ${result.intervalHours} 小时` : ""}`);
  if (typeof result.score === "number" && typeof result.verdict === "string") parts.push(`背调可信度 ${result.score} · ${result.verdict}`);
  if (typeof result.totalUnread === "number") parts.push(`即刻沟通未读 ${result.totalUnread} 条`);
  if (typeof result.status === "number" && typeof result.path === "string") parts.push(`${result.status} · ${result.path}`);
  const apiData = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : undefined;
  if (typeof apiData?.fileName === "string") parts.push(`文件 ${apiData.fileName}`);
  return parts.join(" · ") || "已返回结构化结果";
}

function agentExportDownload(step: AgentStep) {
  const data = step.result?.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const document = record.document;
  const documentId = document && typeof document === "object" ? String((document as Record<string, unknown>).id || "") : "";
  const fileName = typeof record.fileName === "string" ? record.fileName : "";
  return documentId && fileName ? { documentId, fileName } : null;
}

function agentWorkflowMarkup(run: AgentRun | null) {
  if (!run?.goalSpec) return `<div class="agent-workflow-empty">行动方案生成后将在这里显示</div>`;
  const isActionable = run.goalSpec.objectives.some((objective) => objective.action !== "unknown") || run.steps.length > 0 || run.stopReason.includes("高自由度推理");
  if (!isActionable) return "";
  const objectives = run.goalSpec.objectives.map((objective, index) =>
    `<li><span>${index + 1}</span><div><b>${escapeHtml(objective.description)}</b><small>${escapeHtml(objective.completionCriteria.join("；"))}</small></div></li>`
  ).join("");
  const highFreedom = run.status === "waiting_user" && run.stopReason.includes("高自由度推理")
    ? `<button class="btn primary" type="button" id="agentHighFreedomButton">启用高自由度推理</button>`
    : "";
  return `<div class="agent-workflow-head"><div><b>${escapeHtml(run.goalSpec.subject || run.goal)}</b><small>${run.goalSpec.compiledBy === "model+rules" ? "模型理解 + 服务端契约" : "服务端目标契约"}</small></div><div>${highFreedom}<button class="btn" type="button" id="agentSkillDraftButton">保存为 Skill 草稿</button></div></div><ol>${objectives}</ol>`;
}

async function openAgentExportDownload(stepId: string) {
  const step = state.agentRun?.steps.find((item) => item.id === stepId);
  const exportResult = step ? agentExportDownload(step) : null;
  if (!exportResult || !state.user) return;
  await refreshAll(state.user);
  state.selectedDocumentId = exportResult.documentId;
  activateNavView("documents", () => renderTradeDocuments(state.tradeDocuments));
  window.setTimeout(() => printDocumentPreview(), 120);
}

async function saveAgentRunAsSkillDraft() {
  const run = state.agentRun;
  if (!run?.goalSpec) return;
  const toolRefs = [...new Set(run.steps.map((step) => step.tool))];
  const content = [
    `用户目标：${run.goal}`,
    "",
    "执行流程：",
    ...run.goalSpec.objectives.map((item, index) => `${index + 1}. ${item.description}`),
    "",
    "目标契约：",
    JSON.stringify(run.goalSpec, null, 2)
  ].join("\n").slice(0, 8_000);
  try {
    await api("/api/agent/knowledge/documents", {
      method: "POST",
      body: JSON.stringify({
        kind: "workflow",
        scope: "team",
        module: run.goalSpec.primaryDomain || "agent",
        title: `${run.goalSpec.subject || run.goal} Skill 草稿`.slice(0, 160),
        summary: "由真实 Agent 执行目标、步骤和完成证据生成，发布前需要人工审核。",
        content,
        keywords: [run.goalSpec.primaryDomain, run.goalSpec.primaryAction, ...run.goalSpec.objectives.map((item) => item.action)].filter(Boolean),
        roles: ["sales", "manager", "admin", "super_admin"],
        toolRefs,
        successCriteria: run.goalSpec.completionCriteria.slice(0, 20),
        failureCases: ["不得用无关读取结果替代写入或导出目标", "缺少确定性完成证据时不得宣布任务完成"],
        sourceType: "agent_feedback",
        sourceId: run.id
      })
    });
    toast("已保存为待审核的 Skill 调教草稿");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Skill 草稿保存失败", "error");
  }
}

export function agentUiAction(result: Record<string, unknown> | undefined) {
  const action = result?.uiAction;
  if (!action || typeof action !== "object") return null;
  return action as AgentUiAction;
}

function syncAgentRunPolling(run = state.agentRun) {
  const pending = Boolean(run && (["planning", "running"].includes(run.status)
    || run.steps.some((step) => step.status === "queued" || step.status === "running")
    || state.outreachSequences.some((item) => item.status === "active" || item.steps.some((step) => step.status === "sending"))));
  if (!pending) {
    if (agentRunPollTimer) window.clearInterval(agentRunPollTimer);
    agentRunPollTimer = 0;
    return;
  }
  if (agentRunPollTimer) return;
  agentRunPollTimer = window.setInterval(() => {
    if (state.agentRun?.id) void refreshAgentRun(state.agentRun.id, true);
  }, 1_000);
}

function outreachSequenceStatusLabel(status: OutreachSequence["status"]) {
  return ({ active: "运行中", paused: "已暂停", completed: "已完成", stopped: "自动停止", cancelled: "已取消", failed: "发送受阻" } as Record<OutreachSequence["status"], string>)[status];
}

function renderOutreachSequences(run = state.agentRun) {
  const box = qs<HTMLElement>("#agentSequenceList");
  if (!box) return;
  const related = state.outreachSequences.filter((item) => !run || item.missionRunId === run.id);
  const sequences = (related.length ? related : state.outreachSequences).slice(0, 3);
  box.innerHTML = sequences.length ? sequences.map((sequence) => {
    const percent = Math.round((sequence.currentStep / Math.max(1, sequence.maxSends)) * 100);
    const next = sequence.nextExecutionAt && sequence.status === "active"
      ? new Date(sequence.nextExecutionAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      : sequence.stopReason || outreachSequenceStatusLabel(sequence.status);
    const controls = sequence.status === "active"
      ? `<button class="btn" type="button" data-sequence-control="pause" data-sequence-id="${escapeHtml(sequence.id)}">暂停</button><button class="btn" type="button" data-sequence-control="cancel" data-sequence-id="${escapeHtml(sequence.id)}">取消</button>`
      : sequence.status === "paused"
        ? `<button class="btn primary" type="button" data-sequence-control="resume" data-sequence-id="${escapeHtml(sequence.id)}">继续</button><button class="btn" type="button" data-sequence-control="cancel" data-sequence-id="${escapeHtml(sequence.id)}">取消</button>`
        : "";
    return `<article class="agent-sequence-card">
      <header><div><b>${escapeHtml(sequence.entityName)}</b><span>${sequence.channel === "email" ? "Email" : "即刻沟通"} · ${escapeHtml(sequence.recipient)}</span></div><small>${outreachSequenceStatusLabel(sequence.status)}</small></header>
      <div class="agent-sequence-track"><i style="width:${percent}%"></i></div>
      <div class="agent-sequence-meta"><span>已发送 ${sequence.currentStep}/${sequence.maxSends}</span><span>${escapeHtml(next)}</span></div>
      <div class="agent-sequence-steps">${sequence.steps.map((step) => `<i class="${escapeHtml(step.status)}" title="第 ${step.index + 1} 次"></i>`).join("")}</div>
      ${controls ? `<footer>${controls}</footer>` : ""}
    </article>`;
  }).join("") : `<div class="agent-sequence-empty">暂无自动触达序列</div>`;
  qsa<HTMLButtonElement>("[data-sequence-control]", box).forEach((button) => button.addEventListener("click", () => void controlOutreachSequenceFromUi(
    button.dataset.sequenceId || "",
    button.dataset.sequenceControl as "pause" | "resume" | "cancel"
  )));
}

function agentSequenceApprovalPreview(step: AgentStep) {
  if (step.tool !== "outreach.create_sequence" || !Array.isArray(step.input.steps)) return "";
  const channel = step.input.channel === "communication" ? "即刻沟通" : "Email";
  const rows = step.input.steps.slice(0, 5).map((value, index) => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const delay = Number(item.delayHours || 0);
    const subject = typeof item.subject === "string" ? item.subject : "";
    const body = typeof item.body === "string" ? item.body : "";
    return `<details class="agent-sequence-approval-step" ${index === 0 ? "open" : ""}><summary>第 ${index + 1} 次 · ${delay ? `${delay} 小时后` : "批准后"}${subject ? ` · ${escapeHtml(subject)}` : ""}</summary><p>${escapeHtml(body)}</p></details>`;
  }).join("");
  return `<div class="agent-sequence-approval"><b>${channel} · 最多 ${step.input.steps.length} 次</b>${rows}</div>`;
}

function maintenanceWatchStatusLabel(status: CustomerMaintenanceWatch["status"]) {
  return ({ active: "守护中", paused: "已暂停", cancelled: "已取消", error: "巡检受阻" } as Record<CustomerMaintenanceWatch["status"], string>)[status];
}

function renderCustomerMaintenanceWatches(run = state.agentRun) {
  const box = qs<HTMLElement>("#agentMaintenanceList");
  if (!box) return;
  const related = state.customerMaintenanceWatches.filter((item) => !run || item.missionRunId === run.id);
  const watches = (related.length ? related : state.customerMaintenanceWatches).slice(0, 3);
  box.innerHTML = watches.length ? watches.map((watch) => {
    const next = watch.status === "active"
      ? new Date(watch.nextRunAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      : watch.lastError || maintenanceWatchStatusLabel(watch.status);
    const controls = watch.status === "active"
      ? `<button class="btn" type="button" data-maintenance-control="pause" data-maintenance-id="${escapeHtml(watch.id)}">暂停</button><button class="btn" type="button" data-maintenance-control="cancel" data-maintenance-id="${escapeHtml(watch.id)}">取消</button>`
      : ["paused", "error"].includes(watch.status)
        ? `<button class="btn primary" type="button" data-maintenance-control="resume" data-maintenance-id="${escapeHtml(watch.id)}">继续</button><button class="btn" type="button" data-maintenance-control="cancel" data-maintenance-id="${escapeHtml(watch.id)}">取消</button>`
        : "";
    const findings = watch.lastFindings.slice(0, 3).map((item) => `<li><b>${escapeHtml(item.customerName)}</b><span>${escapeHtml(item.reason)}</span></li>`).join("");
    return `<article class="agent-maintenance-card">
      <header><div><b>${escapeHtml(watch.name)}</b><span>每 ${watch.rules.intervalHours} 小时 · 单次上限 ${watch.rules.maxTodosPerRun}</span></div><small>${maintenanceWatchStatusLabel(watch.status)}</small></header>
      <div class="agent-maintenance-metrics"><span><b>${watch.lastMatchedCount}</b>发现</span><span><b>${watch.lastCreatedCount}</b>新建</span><span><b>${watch.lastSkippedCount}</b>跳过</span><span><b>${watch.totalCreatedCount}</b>累计</span></div>
      ${findings ? `<ul class="agent-maintenance-findings">${findings}</ul>` : ""}
      <div class="agent-maintenance-next"><span>下次巡检</span><b>${escapeHtml(next)}</b></div>
      ${controls ? `<footer>${controls}</footer>` : ""}
    </article>`;
  }).join("") : `<div class="agent-sequence-empty">暂无客户守护策略</div>`;
  qsa<HTMLButtonElement>("[data-maintenance-control]", box).forEach((button) => button.addEventListener("click", () => void controlCustomerMaintenanceFromUi(
    button.dataset.maintenanceId || "",
    button.dataset.maintenanceControl as "pause" | "resume" | "cancel"
  )));
}

function agentMaintenanceApprovalPreview(step: AgentStep) {
  if (step.tool !== "maintenance.create_watch") return "";
  const rules = step.input.rules && typeof step.input.rules === "object" ? step.input.rules as Record<string, unknown> : {};
  const grades = Array.isArray(rules.grades) ? rules.grades.join("/") : "A/B/C/D";
  return `<div class="agent-maintenance-approval"><span>每 ${escapeHtml(Number(rules.intervalHours || 24))} 小时</span><span>${escapeHtml(Number(rules.inactivityDays || 7))} 天未跟进</span><span>健康度低于 ${escapeHtml(Number(rules.healthBelow ?? 60))}</span><span>${escapeHtml(grades)} 级</span><span>单次最多 ${escapeHtml(Number(rules.maxTodosPerRun || 10))} 个待办</span></div>`;
}

function agentExternalApprovalPreview(step: AgentStep) {
  if (["api.write", "api.external"].includes(step.tool)) {
    const method = String(step.input.method || "");
    const path = String(step.input.path || "");
    const payload = JSON.stringify({ query: step.input.query || {}, body: step.input.body ?? null }, null, 2);
    return `<details class="agent-external-preview" open><summary>${escapeHtml(method)} · ${escapeHtml(path)}</summary><p>${escapeHtml(payload)}</p></details>`;
  }
  if (step.risk !== "external" || step.tool === "outreach.create_sequence") return "";
  if (step.tool === "outreach.send_development_email") {
    return `<details class="agent-external-preview" open><summary>${escapeHtml(String(step.input.to || "收件邮箱由客户资料确定"))} · ${escapeHtml(String(step.input.subject || ""))}</summary><p>${escapeHtml(String(step.input.body || ""))}</p></details>`;
  }
  if (step.tool === "outreach.send_whatsapp") {
    return `<details class="agent-external-preview" open><summary>即刻沟通 · ${escapeHtml(String(step.input.customerId || "当前客户"))}</summary><p>${escapeHtml(String(step.input.body || ""))}</p></details>`;
  }
  if (step.tool === "prospect.start_search") {
    const products = Array.isArray(step.input.products) ? step.input.products.join("、") : "";
    const markets = Array.isArray(step.input.markets) ? step.input.markets.join("、") : "";
    return `<div class="agent-external-scope"><span>产品 ${escapeHtml(products)}</span><span>市场 ${escapeHtml(markets)}</span><span>上限 ${escapeHtml(Number(step.input.limit || 20))}</span></div>`;
  }
  return "";
}

function renderAgentCheckpoints(run = state.agentRun) {
  const list = qs<HTMLElement>("#agentCheckpointList");
  if (!list) return;
  if (!run) {
    list.innerHTML = `<div class="agent-checkpoint-empty">暂无检查点</div>`;
    return;
  }
  if (state.agentCheckpointRunId !== run.id) {
    list.innerHTML = `<div class="agent-checkpoint-empty">正在读取检查点</div>`;
    return;
  }
  const checkpoints = state.agentMissionCheckpoints.slice(0, 6);
  list.innerHTML = checkpoints.length ? checkpoints.map((item, index) => `<div class="agent-checkpoint-item"><div><b>${escapeHtml(item.reason)}</b><small>第 ${item.iteration} 轮 · ${escapeHtml(agentRunStatusLabel(item.status))} · ${escapeHtml(new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }))}</small></div>${index === 0 ? `<span class="badge gray">当前</span>` : `<button class="btn" type="button" data-agent-checkpoint-restore="${escapeHtml(item.id)}">恢复</button>`}</div>`).join("") : `<div class="agent-checkpoint-empty">暂无可用检查点</div>`;
  qsa<HTMLButtonElement>("[data-agent-checkpoint-restore]", list).forEach((button) => button.addEventListener("click", () => void restoreAgentCheckpointFromUi(button.dataset.agentCheckpointRestore || "", button)));
}

async function loadAgentCheckpoints(runId: string) {
  if (!runId) return;
  try {
    const result = await api<{ checkpoints: AgentMissionCheckpoint[] }>(`/api/agent/missions/${encodeURIComponent(runId)}/checkpoints?limit=30`);
    if (state.agentRun?.id !== runId) return;
    state.agentMissionCheckpoints = result.checkpoints || [];
    state.agentCheckpointRunId = runId;
    renderAgentCheckpoints(state.agentRun);
  } catch (error) {
    if (state.agentRun?.id === runId) {
      state.agentMissionCheckpoints = [];
      state.agentCheckpointRunId = runId;
      renderAgentCheckpoints(state.agentRun);
    }
    toast(error instanceof Error ? error.message : "Mission 检查点读取失败", "error");
  }
}

async function restoreAgentCheckpointFromUi(checkpointId: string, button: HTMLButtonElement) {
  if (!state.agentRun || !checkpointId || state.agentLoading) return;
  if (!await confirmAction({
    title: "恢复 Mission 检查点",
    message: "Mission 将回到所选检查点继续执行。",
    consequences: ["未开始的后续步骤会被替换", "涉及写入的动作需要重新审批"],
    confirmLabel: "恢复检查点",
    tone: "warning"
  })) return;
  state.agentLoading = true;
  button.disabled = true;
  try {
    const result = await api<{ run: AgentRun; checkpoints: AgentMissionCheckpoint[] }>(`/api/agent/missions/${encodeURIComponent(state.agentRun.id)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`, { method: "POST" });
    state.agentRun = result.run;
    state.agentRuns = [result.run, ...state.agentRuns.filter((item) => item.id !== result.run.id)];
    state.agentMissionCheckpoints = result.checkpoints || [];
    state.agentCheckpointRunId = result.run.id;
    renderAgent(result.run);
    toast("Mission 已恢复到安全检查点");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Mission 检查点恢复失败", "error");
  } finally {
    state.agentLoading = false;
    renderAgent(state.agentRun);
  }
}

function agentMemoryScopeLabel(scope: AgentMemory["scope"]) {
  return ({ personal: "个人偏好", team: "团队打法", customer: "客户记忆", company: "公司知识" } as Record<AgentMemory["scope"], string>)[scope];
}

function agentMemorySourceLabel(source: AgentMemory["sourceType"]) {
  return ({ crm: "CRM 事实", manual: "手动维护", agent: "Agent 建议", playbook: "蒸馏打法" } as Record<AgentMemory["sourceType"], string>)[source];
}

function renderAgentMemoryStatus() {
  const button = qs<HTMLButtonElement>("#agentMemoryStatus");
  if (!button) return;
  const active = state.agentMemories.filter((item) => item.status === "active").length;
  const proposed = state.agentMemories.filter((item) => item.status === "proposed").length;
  button.innerHTML = `<span>业务记忆</span><b>${active ? `已启用 ${active} 条` : "尚无已启用记忆"}</b><small>${proposed ? `${proposed} 条待确认` : "偏好、客户事实和团队打法"}</small>`;
}

export async function loadAgentMemories(showError = true) {
  try {
    const result = await api<{ memories: AgentMemory[] }>("/api/agent/memories?status=all");
    state.agentMemories = result.memories || [];
    renderAgentMemoryStatus();
  } catch (error) {
    if (showError) toast(error instanceof Error ? error.message : "业务记忆读取失败", "error");
  }
}

function agentMemoryManagerBody() {
  const counts = (status: AgentMemoryStatus) => state.agentMemories.filter((item) => item.status === status).length;
  const items = state.agentMemories.filter((item) => item.status === agentMemoryTab);
  const cards = items.map((item) => {
    const expiry = item.expiresAt ? ` · 有效至 ${new Date(item.expiresAt).toLocaleDateString("zh-CN")}` : "";
    const activate = item.status !== "active" ? `<button class="btn primary" type="button" data-agent-memory-action="activate" data-agent-memory-id="${escapeHtml(item.id)}">启用</button>` : "";
    const archive = item.status === "active" ? `<button class="btn" type="button" data-agent-memory-action="archive" data-agent-memory-id="${escapeHtml(item.id)}">停用</button>` : "";
    return `<article class="agent-memory-card"><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.content)}</p><small>${escapeHtml(agentMemoryScopeLabel(item.scope))} · ${escapeHtml(agentMemorySourceLabel(item.sourceType))} · 可信度 ${item.confidence}%${escapeHtml(expiry)}</small></div><div class="agent-memory-actions">${activate}${archive}<button class="btn" type="button" data-agent-memory-edit="${escapeHtml(item.id)}">编辑</button><button class="btn" type="button" data-agent-memory-action="delete" data-agent-memory-id="${escapeHtml(item.id)}">删除</button></div></article>`;
  }).join("");
  return `<div class="agent-memory-toolbar"><div class="agent-memory-tabs"><button type="button" data-agent-memory-tab="active" class="${agentMemoryTab === "active" ? "active" : ""}">已启用 ${counts("active")}</button><button type="button" data-agent-memory-tab="proposed" class="${agentMemoryTab === "proposed" ? "active" : ""}">待确认 ${counts("proposed")}</button><button type="button" data-agent-memory-tab="archived" class="${agentMemoryTab === "archived" ? "active" : ""}">已停用 ${counts("archived")}</button></div><button class="btn primary" type="button" id="agentMemoryCreateButton">新增记忆</button></div><div class="agent-memory-list">${cards || `<div class="agent-memory-empty">当前分组暂无业务记忆</div>`}</div>`;
}

function bindAgentMemoryManager() {
  const modal = qs<HTMLElement>("#appModal");
  qsa<HTMLButtonElement>("[data-agent-memory-tab]", modal || document).forEach((button) => button.addEventListener("click", () => {
    agentMemoryTab = button.dataset.agentMemoryTab as AgentMemoryStatus;
    openAgentMemoryManager(false);
  }));
  qs<HTMLButtonElement>("#agentMemoryCreateButton", modal || document)?.addEventListener("click", () => openAgentMemoryEditor());
  qsa<HTMLButtonElement>("[data-agent-memory-edit]", modal || document).forEach((button) => button.addEventListener("click", () => {
    const memory = state.agentMemories.find((item) => item.id === button.dataset.agentMemoryEdit);
    if (memory) openAgentMemoryEditor(memory);
  }));
  qsa<HTMLButtonElement>("[data-agent-memory-action]", modal || document).forEach((button) => button.addEventListener("click", () => void mutateAgentMemory(
    button.dataset.agentMemoryId || "",
    button.dataset.agentMemoryAction as "activate" | "archive" | "delete",
    button
  )));
}

export async function openAgentMemoryManager(reload = true) {
  if (reload) await loadAgentMemories();
  openModal("业务记忆", agentMemoryManagerBody(), `<button class="btn" data-modal-close>关闭</button>`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("agent-memory-modal");
  bindAgentMemoryManager();
}

function openAgentMemoryEditor(memory?: AgentMemory) {
  const canManageTeam = hasIamCapability("agent.manage");
  const selectedCustomerId = memory?.subjectId || state.selectedCustomerId || state.customers[0]?.id || "";
  const scopeOptions = memory
    ? `<option value="${escapeHtml(memory.scope)}">${escapeHtml(agentMemoryScopeLabel(memory.scope))}</option>`
    : `<option value="personal">个人偏好</option><option value="customer">客户记忆</option>${canManageTeam ? `<option value="team">团队打法</option><option value="company">公司知识</option>` : ""}`;
  const customerOptions = state.customers.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selectedCustomerId ? "selected" : ""}>${escapeHtml(item.company)}</option>`).join("");
  const expiry = memory?.expiresAt ? memory.expiresAt.slice(0, 10) : "";
  openModal(memory ? "编辑业务记忆" : "新增业务记忆", `<div class="form-grid"><div class="form-field"><label>范围</label><select id="agentMemoryScopeInput" ${memory ? "disabled" : ""}>${scopeOptions}</select></div><div class="form-field" id="agentMemoryCustomerField"><label>关联客户</label><select id="agentMemoryCustomerInput">${customerOptions || `<option value="">暂无客户</option>`}</select></div><div class="form-field full"><label>标题</label><input id="agentMemoryTitleInput" maxlength="120" value="${escapeHtml(memory?.title || "")}"></div><div class="form-field full"><label>内容</label><textarea id="agentMemoryContentInput" rows="6" maxlength="2000">${escapeHtml(memory?.content || "")}</textarea></div><div class="form-field"><label>有效期</label><input id="agentMemoryExpiryInput" type="date" value="${escapeHtml(expiry)}"></div></div>`, `<button class="btn" id="agentMemoryBackButton">返回</button><button class="btn primary" id="agentMemorySaveButton">保存</button>`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("agent-memory-modal");
  const syncCustomer = () => {
    const scope = qs<HTMLSelectElement>("#agentMemoryScopeInput")?.value;
    const field = qs<HTMLElement>("#agentMemoryCustomerField");
    if (field) field.style.display = scope === "customer" ? "grid" : "none";
  };
  qs<HTMLSelectElement>("#agentMemoryScopeInput")?.addEventListener("change", syncCustomer);
  syncCustomer();
  qs<HTMLButtonElement>("#agentMemoryBackButton")?.addEventListener("click", () => void openAgentMemoryManager(false));
  qs<HTMLButtonElement>("#agentMemorySaveButton")?.addEventListener("click", (event) => void saveAgentMemory(memory, event.currentTarget as HTMLButtonElement));
}

async function saveAgentMemory(memory: AgentMemory | undefined, button: HTMLButtonElement) {
  const scope = (qs<HTMLSelectElement>("#agentMemoryScopeInput")?.value || memory?.scope || "personal") as AgentMemory["scope"];
  const title = qs<HTMLInputElement>("#agentMemoryTitleInput")?.value.trim() || "";
  const content = qs<HTMLTextAreaElement>("#agentMemoryContentInput")?.value.trim() || "";
  const expiry = qs<HTMLInputElement>("#agentMemoryExpiryInput")?.value || "";
  if (title.length < 2 || content.length < 2) { toast("请完整填写标题和内容", "error"); return; }
  const typeByScope: Record<AgentMemory["scope"], AgentMemory["type"]> = { personal: "user_preference", customer: "customer_memory", team: "team_playbook", company: "company_knowledge" };
  button.disabled = true;
  try {
    await api(memory ? `/api/agent/memories/${encodeURIComponent(memory.id)}` : "/api/agent/memories", {
      method: memory ? "PATCH" : "POST",
      body: JSON.stringify(memory ? { title, content, expiresAt: expiry } : {
        type: typeByScope[scope], scope, subjectId: scope === "customer" ? qs<HTMLSelectElement>("#agentMemoryCustomerInput")?.value || "" : "",
        title, content, sourceType: "manual", confidence: 100, expiresAt: expiry
      })
    });
    agentMemoryTab = memory?.status || "proposed";
    await loadAgentMemories();
    openAgentMemoryManager(false);
    toast(memory ? "业务记忆已更新" : "业务记忆已保存，确认启用后生效");
  } catch (error) {
    button.disabled = false;
    toast(error instanceof Error ? error.message : "业务记忆保存失败", "error");
  }
}

async function mutateAgentMemory(id: string, action: "activate" | "archive" | "delete", button: HTMLButtonElement) {
  if (!id) return;
  if (action === "delete") {
    const confirmed = await confirmAction({
      title: "删除业务记忆",
      message: "这条业务记忆将不再参与 Agent 判断。",
      consequences: ["记忆内容会被移除", "后续 Agent 任务不会再引用它"],
      confirmLabel: "删除记忆"
    });
    if (!confirmed) {
      openAgentMemoryManager(false);
      return;
    }
  }
  button.disabled = true;
  try {
    await api(`/api/agent/memories/${encodeURIComponent(id)}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST" });
    if (action === "activate") agentMemoryTab = "active";
    if (action === "archive") agentMemoryTab = "archived";
    await loadAgentMemories();
    openAgentMemoryManager(false);
    toast(action === "activate" ? "业务记忆已启用" : action === "archive" ? "业务记忆已停用" : "业务记忆已删除");
  } catch (error) {
    button.disabled = false;
    toast(error instanceof Error ? error.message : "业务记忆操作失败", "error");
  }
}

function agentKnowledgeKindLabel(kind: AgentKnowledgeKind) {
  return ({ system: "系统", module: "模块", workflow: "流程", policy: "政策", field: "字段", playbook: "打法", failure_case: "失败案例" } as Record<AgentKnowledgeKind, string>)[kind];
}

function agentKnowledgeStatusLabel(status: AgentKnowledgeStatus) {
  return ({ draft: "草稿", review: "待审核", published: "已发布", archived: "已归档" } as Record<AgentKnowledgeStatus, string>)[status];
}

function renderAgentKnowledgeStatus() {
  const button = qs<HTMLButtonElement>("#agentKnowledgeStatus");
  const overview = state.agentKnowledgeOverview;
  if (!button || !overview) return;
  button.innerHTML = `<span>学习中心</span><b>${overview.systemCount + overview.publishedCount + overview.distillationCount} 条有效知识</b><small>${overview.reviewCount ? `${overview.reviewCount} 条待审核` : `${overview.modules.length} 个业务模块`}</small>`;
}

export async function loadAgentKnowledge(showError = true) {
  try {
    const [overview, documents] = await Promise.all([
      api<AgentKnowledgeOverview>("/api/agent/knowledge/overview"),
      api<{ documents: AgentKnowledgeDocument[] }>("/api/agent/knowledge/documents?status=all")
    ]);
    state.agentKnowledgeOverview = overview;
    state.agentKnowledgeDocuments = documents.documents || [];
    renderAgentKnowledgeStatus();
  } catch (error) {
    if (showError) toast(error instanceof Error ? error.message : "知识中心读取失败", "error");
  }
}

function renderAgentSkillMarkdown(source: string) {
  const output: string[] = [];
  let listType: "ul" | "ol" | "" = "";
  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = "";
  };
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) { closeList(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) {
      closeList();
      output.push(`<h${heading[1]!.length}>${escapeHtml(heading[2]!)}</h${heading[1]!.length}>`);
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/u.exec(line);
    const ordered = /^\d+\.\s+(.+)$/u.exec(line);
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) { closeList(); listType = nextType; output.push(`<${listType}>`); }
      output.push(`<li>${escapeHtml((unordered || ordered)![1]!)}</li>`);
      continue;
    }
    closeList();
    output.push(`<p>${escapeHtml(line)}</p>`);
  }
  closeList();
  return output.join("");
}

function filteredAgentSkills() {
  const query = agentSkillQuery.toLocaleLowerCase("zh-CN");
  return state.agentSkills.filter((skill) => {
    if (agentSkillCategoryFilter !== "all" && skill.category !== agentSkillCategoryFilter) return false;
    if (agentSkillStatusFilter !== "all" && skill.status !== agentSkillStatusFilter) return false;
    if (agentSkillSourceFilter !== "all" && (skill.sourceType || "builtin") !== agentSkillSourceFilter) return false;
    if (!query) return true;
    return [
      skill.name,
      skill.description,
      skill.category,
      ...(skill.triggers || []),
      ...(skill.keywords || []),
      ...(skill.toolRefs || []),
      ...(skill.modules || []),
      skill.acquisitionMethod,
      skill.acquisitionInstructions,
      skill.usageGuide,
      skill.trainingGuide,
      skill.optimizationAdvice,
      skill.author
    ].join(" ").toLocaleLowerCase("zh-CN").includes(query);
  });
}

function agentSkillStatusLabel(status: AgentSkill["status"]) {
  return ({ active: "系统启用", published: "已上架", draft: "草稿", archived: "已归档" } as const)[status];
}

function agentSkillSourceLabel(sourceType: AgentSkill["sourceType"] | undefined) {
  return ({ builtin: "系统内置", download: "下载包", repository: "代码仓库", marketplace: "Skill 市场", manual: "人工获取" } as const)[sourceType || "builtin"];
}

function isHttpsUrl(value: string | undefined) {
  if (!value) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

export function renderAgentSkillList() {
  const list = qs<HTMLElement>("#agentSkillsGrid");
  if (!list) return;
  const skills = filteredAgentSkills();
  const count = qs<HTMLElement>("#agentSkillsResultCount");
  if (count) count.textContent = `${skills.length} 个 Skill`;
  list.innerHTML = skills.length
    ? skills.map((skill) => {
      const tags = (skill.modules || []).slice(0, 3);
      return `<button type="button" class="agent-skill-card${skill.id === selectedAgentSkillId ? " active" : ""}" data-agent-skill-id="${escapeHtml(skill.id)}" data-agent-skill-kind="${escapeHtml(skill.resourceKind || "system")}" aria-label="查看 ${escapeHtml(skill.name)}">
        <span class="agent-skill-card-top"><span class="agent-skill-category${skill.resourceKind === "download" ? " agent-skill-resource-mark" : ""}">${escapeHtml(skill.resourceKind === "download" ? `下载资源 · ${skill.category}` : skill.category)}</span><span class="agent-skill-state ${escapeHtml(skill.status)}">${escapeHtml(agentSkillStatusLabel(skill.status))}</span></span>
        <h2>${escapeHtml(skill.name)}</h2>
        <p>${escapeHtml(skill.description)}</p>
        <span class="agent-skill-card-tags">${tags.map((module) => `<span>${escapeHtml(module)}</span>`).join("")}${(skill.modules || []).length > 3 ? `<span>+${skill.modules.length - 3}</span>` : ""}</span>
        <span class="agent-skill-card-foot"><span class="agent-skill-source">${escapeHtml(skill.acquisitionMethod || agentSkillSourceLabel(skill.sourceType))}</span><b>${skill.resourceKind === "download" ? `${skill.accessCount || 0} 次获取` : `V${escapeHtml(skill.version)}`}</b></span>
      </button>`;
    }).join("")
    : `<div class="agent-skills-empty">没有符合当前条件的 Skill，请调整搜索或筛选条件</div>`;
  qsa<HTMLButtonElement>("[data-agent-skill-id]", list).forEach((button) => button.addEventListener("click", () => void openAgentSkill(button.dataset.agentSkillId || "", button.dataset.agentSkillKind || "system")));
}

export function closeAgentSkillDetail() {
  const target = qs<HTMLElement>("#agentSkillsDetail");
  const backdrop = qs<HTMLElement>("#agentSkillDrawerBackdrop");
  target?.classList.remove("open");
  target?.setAttribute("aria-hidden", "true");
  backdrop?.classList.remove("active");
  document.body.classList.remove("agent-skill-drawer-open");
}

function agentSkillCopyField(label: string, value: string, full = false) {
  if (!value) return "";
  return `<div class="agent-skill-copy-field${full ? " full" : ""}"><span>${escapeHtml(label)}</span><div class="agent-skill-copy-row"><code title="${escapeHtml(value)}">${escapeHtml(value)}</code><button type="button" data-agent-skill-copy="${escapeHtml(value)}" data-agent-skill-copy-label="${escapeHtml(label)}">复制</button></div></div>`;
}

function renderAgentSkillDetail(skill?: AgentSkill) {
  const target = qs<HTMLElement>("#agentSkillsDetail");
  if (!target) return;
  if (!skill) {
    target.innerHTML = `<div class="agent-skills-welcome"><span>SK</span><div><h2>选择一个 Skill</h2></div></div>`;
    return;
  }
  const sourceLabel = agentSkillSourceLabel(skill.sourceType);
  const downloadUrl = isHttpsUrl(skill.downloadUrl) ? skill.downloadUrl : "";
  const homepageUrl = isHttpsUrl(skill.homepageUrl) ? skill.homepageUrl : "";
  const canDownload = Boolean(downloadUrl || skill.downloadAvailable);
  const acquisitionFields = [
    downloadUrl ? `<div class="agent-skill-copy-field full"><span>下载链接</span><div class="agent-skill-copy-row"><a href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(downloadUrl)}">${escapeHtml(downloadUrl)}</a><button type="button" data-agent-skill-copy="${escapeHtml(downloadUrl)}" data-agent-skill-copy-label="下载链接">复制</button></div></div>` : "",
    agentSkillCopyField("提取码", skill.extractionCode || ""),
    agentSkillCopyField("安装命令", skill.installCommand || "", !skill.extractionCode),
  ].join("");
  const acquisition = `<section class="agent-skill-section"><h3>${skill.resourceKind === "download" ? "下载与安装" : "获取与安装"}</h3><div class="agent-skill-acquisition-grid">
      <div class="agent-skill-copy-field"><span>来源类型</span><div class="agent-skill-copy-row"><code>${escapeHtml(sourceLabel)}</code></div></div>
      <div class="agent-skill-copy-field"><span>获取方式</span><div class="agent-skill-copy-row"><code>${escapeHtml(skill.acquisitionMethod || sourceLabel)}</code></div></div>
      ${acquisitionFields}
    </div>
    ${skill.acquisitionInstructions ? `<p style="margin-top:11px">${escapeHtml(skill.acquisitionInstructions)}</p>` : skill.sourceType === "builtin" || !skill.sourceType ? `<p style="margin-top:11px">该 Skill 随系统目录加载，无需单独下载或安装。</p>` : ""}
    ${homepageUrl || canDownload ? `<div class="agent-skill-actions">${canDownload ? `<a class="btn primary" href="${escapeHtml(downloadUrl || "#")}" target="_blank" rel="noopener noreferrer">去下载</a>` : ""}${homepageUrl ? `<a class="btn" href="${escapeHtml(homepageUrl)}" target="_blank" rel="noopener noreferrer">访问主页</a>` : ""}</div>` : ""}
  </section>`;
  const learning = skill.resourceKind === "download" ? `<section class="agent-skill-section"><h3>学习与训练</h3><div class="agent-skill-learning">
      <details open><summary>使用说明</summary><article>${escapeHtml(skill.usageGuide || "暂无使用说明")}</article></details>
      <details><summary>如何训练这个 Skill</summary><article>${escapeHtml(skill.trainingGuide || "暂无训练教程")}</article></details>
      <details><summary>后续优化方向</summary><article>${escapeHtml(skill.optimizationAdvice || "暂无优化建议")}</article></details>
    </div></section>` : "";
  const management = skill.resourceKind === "download" && state.agentSkillCanManage ? `<div class="agent-skill-actions"><button class="btn" id="agentSkillResourceEdit">编辑</button>${skill.status !== "published" ? `<button class="btn primary" id="agentSkillResourcePublish">发布上架</button>` : `<button class="btn" id="agentSkillResourceArchive">下架</button>`}<button class="btn danger" id="agentSkillResourceDelete">删除</button></div>` : "";
  target.innerHTML = `<div class="agent-skill-detail-bar"><span>${skill.resourceKind === "download" ? "Skill 资源详情" : "系统 Skill 详情"}</span><button class="agent-skill-detail-close" id="agentSkillDetailClose" type="button" aria-label="关闭" title="关闭">×</button></div>
    <div class="agent-skill-detail-head"><div><span>${escapeHtml(skill.category)} · ${escapeHtml(agentSkillStatusLabel(skill.status))}</span><h2>${escapeHtml(skill.name)}</h2><p>${escapeHtml(skill.description)}</p></div><div class="agent-skill-version">V${escapeHtml(skill.version)}</div></div>
    <div class="agent-skill-meta"><div><span>${skill.resourceKind === "download" ? "资源类型" : "目录"}</span><b>${escapeHtml(skill.resourceKind === "download" ? "可下载 Skill" : skill.directory)}</b></div><div><span>适用范围</span><b>${escapeHtml((skill.modules || []).join("、") || "通用")}</b></div><div><span>${skill.resourceKind === "download" ? "累计获取" : "优先级"}</span><b>${skill.resourceKind === "download" ? `${skill.accessCount || 0} 次` : skill.priority}</b></div><div><span>作者</span><b>${escapeHtml(skill.author || "未填写")}</b></div><div><span>许可</span><b>${escapeHtml(skill.license || "未填写")}</b></div><div><span>版本</span><b>${escapeHtml(skill.version)}</b></div></div>
    ${acquisition}
    ${learning}
    ${(skill.toolRefs || []).length ? `<section class="agent-skill-section"><h3>关联工具</h3><div class="agent-skill-chips">${skill.toolRefs.map((tool) => `<span>${escapeHtml(tool)}</span>`).join("")}</div></section>` : ""}
    ${skill.instructions ? `<section class="agent-skill-section"><h3>Skill 说明</h3><article class="agent-skill-markdown">${renderAgentSkillMarkdown(skill.instructions)}</article></section>` : ""}
    ${management}`;
  qs<HTMLButtonElement>("#agentSkillDetailClose", target)?.addEventListener("click", closeAgentSkillDetail);
  qsa<HTMLButtonElement>("[data-agent-skill-copy]", target).forEach((button) => button.addEventListener("click", async () => {
    await copyToClipboard(button.dataset.agentSkillCopy || "");
    toast(`${button.dataset.agentSkillCopyLabel || "内容"}已复制`);
  }));
  qs<HTMLAnchorElement>(".agent-skill-actions a.btn.primary", target)?.addEventListener("click", (event) => {
    if (skill.resourceKind !== "download") return;
    event.preventDefault();
    void accessSkillResource(skill);
  });
  qs("#agentSkillResourceEdit", target)?.addEventListener("click", () => openSkillResourceModal(skill));
  qs("#agentSkillResourcePublish", target)?.addEventListener("click", () => void updateSkillResourceStatus(skill, "published"));
  qs("#agentSkillResourceArchive", target)?.addEventListener("click", () => void updateSkillResourceStatus(skill, "archived"));
  qs("#agentSkillResourceDelete", target)?.addEventListener("click", () => void deleteSkillResource(skill));
}

async function openAgentSkill(id: string, kind = "system") {
  if (!id) return;
  try {
    let selected = state.agentSkills.find((skill) => skill.id === id);
    if (kind !== "download") {
      const result = await api<{ skill: AgentSkill }>(`/api/agent/skills/${encodeURIComponent(id)}`);
      selected = { ...result.skill, resourceKind: "system" };
      state.agentSkills = state.agentSkills.map((skill) => skill.id === result.skill.id ? selected! : skill);
    }
    if (!selected) throw new Error("Skill 不存在");
    selectedAgentSkillId = selected.id;
    renderAgentSkillList();
    renderAgentSkillDetail(selected);
    const target = qs<HTMLElement>("#agentSkillsDetail");
    target?.classList.add("open");
    target?.setAttribute("aria-hidden", "false");
    qs<HTMLElement>("#agentSkillDrawerBackdrop")?.classList.add("active");
    document.body.classList.add("agent-skill-drawer-open");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Skill 读取失败", "error");
  }
}

export async function loadAgentSkills(showError = true) {
  try {
    const [result, resourceResult] = await Promise.all([
      api<{ directory: string; skills: AgentSkill[] }>("/api/agent/skills"),
      api<{ resources: Array<Record<string, any>>; canManage: boolean }>("/api/agent/skill-resources")
    ]);
    const resources: AgentSkill[] = (resourceResult.resources || []).map((item) => ({
      id: item.id, name: item.name, version: item.version, category: item.category, description: item.summary,
      status: item.status, priority: 0, triggers: [], keywords: item.tags || [], modules: item.tags || [], toolRefs: [],
      sourceType: "download", acquisitionMethod: "百度网盘获取", downloadUrl: item.downloadUrl,
      extractionCode: item.extractionCode || "", installCommand: "", acquisitionInstructions: item.acquisitionInstructions || "",
      homepageUrl: "", author: item.author || "", license: item.license || "", directory: "团队资源库",
      resourceKind: "download", usageGuide: item.usageGuide || "", trainingGuide: item.trainingGuide || "",
      optimizationAdvice: item.optimizationAdvice || "", accessCount: item.accessCount || 0, ownerId: item.ownerId,
      teamId: item.teamId, createdAt: item.createdAt, updatedAt: item.updatedAt, downloadAvailable: Boolean(item.downloadAvailable || item.downloadUrl)
    }));
    state.agentSkills = [...resources, ...(result.skills || []).map((skill) => ({ ...skill, resourceKind: "system" as const }))];
    state.agentSkillCanManage = resourceResult.canManage;
    state.agentSkillDirectory = result.directory || "agent-skills";
    const active = state.agentSkills.filter((skill) => skill.status === "active");
    const system = active.filter((skill) => skill.category === "system");
    const setText = (selector: string, value: string) => { const node = qs<HTMLElement>(selector); if (node) node.textContent = value; };
    setText("#agentSkillsActiveCount", String(active.length + resources.filter((item) => item.status === "published").length));
    setText("#agentSkillsSystemCount", String((result.skills || []).length));
    setText("#agentSkillsBusinessCount", String(resources.length));
    setText("#agentSkillsDirectory", String(resources.reduce((sum, item) => sum + (item.accessCount || 0), 0)));
    const addButton = qs<HTMLButtonElement>("#agentSkillAddButton");
    if (addButton) addButton.hidden = !state.agentSkillCanManage;
    if (!state.agentSkills.some((skill) => skill.id === selectedAgentSkillId)) selectedAgentSkillId = "";
    renderAgentSkillFilters();
    renderAgentSkillList();
    const selected = state.agentSkills.find((skill) => skill.id === selectedAgentSkillId);
    if (qs<HTMLElement>("#agentSkillsDetail")?.classList.contains("open") && selected) await openAgentSkill(selected.id, selected.resourceKind || "system");
  } catch (error) {
    if (showError) toast(error instanceof Error ? error.message : "Skills 读取失败", "error");
  }
}

function skillResourcePayload() {
  const value = (selector: string) => qs<HTMLInputElement | HTMLTextAreaElement>(selector)?.value.trim() || "";
  return {
    name: value("#skillResourceName"),
    category: value("#skillResourceCategory") || "业务效率",
    version: value("#skillResourceVersion") || "1.0.0",
    summary: value("#skillResourceSummary"),
    usageGuide: value("#skillResourceUsage"),
    trainingGuide: value("#skillResourceTraining"),
    optimizationAdvice: value("#skillResourceOptimization"),
    acquisitionInstructions: value("#skillResourceAcquisition"),
    downloadUrl: value("#skillResourceUrl"),
    extractionCode: value("#skillResourceCode"),
    tags: value("#skillResourceTags").split(/[，,]/u).map((item) => item.trim()).filter(Boolean),
    author: value("#skillResourceAuthor"),
    license: value("#skillResourceLicense") || "内部使用"
  };
}

export function openSkillResourceModal(skill?: AgentSkill) {
  if (!state.agentSkillCanManage) return;
  openModal(skill ? "编辑 Skill" : "上架 Skill", `<div class="form-grid">
    <div class="form-field full"><label>Skill 名称</label><input id="skillResourceName" maxlength="160" value="${escapeHtml(skill?.name || "")}" placeholder="例如：外贸开发信优化 Skill"></div>
    <div class="form-field"><label>分类</label><input id="skillResourceCategory" maxlength="100" value="${escapeHtml(skill?.category || "业务效率")}"></div>
    <div class="form-field"><label>版本</label><input id="skillResourceVersion" maxlength="40" value="${escapeHtml(skill?.version || "1.0.0")}"></div>
    <div class="form-field full"><label>简介</label><textarea id="skillResourceSummary" rows="3" maxlength="1200" placeholder="说清楚它能解决什么问题、适合谁使用">${escapeHtml(skill?.description || "")}</textarea></div>
    <div class="form-field full"><label>百度网盘链接</label><input id="skillResourceUrl" value="${escapeHtml(skill?.downloadUrl || "")}" placeholder="https://pan.baidu.com/s/..."></div>
    <div class="form-field"><label>提取码</label><input id="skillResourceCode" maxlength="64" value="${escapeHtml(skill?.extractionCode || "")}"></div>
    <div class="form-field"><label>作者</label><input id="skillResourceAuthor" maxlength="120" value="${escapeHtml(skill?.author || state.user?.name || "")}"></div>
    <div class="form-field"><label>许可说明</label><input id="skillResourceLicense" maxlength="120" value="${escapeHtml(skill?.license || "内部使用")}"></div>
    <div class="form-field"><label>标签</label><input id="skillResourceTags" value="${escapeHtml((skill?.keywords || []).join("，"))}" placeholder="开发信，销售，写作"></div>
    <div class="form-field full"><label>使用说明</label><textarea id="skillResourceUsage" rows="5" maxlength="8000" placeholder="安装位置、触发方式、输入要求和使用步骤">${escapeHtml(skill?.usageGuide || "")}</textarea></div>
    <div class="form-field full"><label>训练教程</label><textarea id="skillResourceTraining" rows="6" maxlength="12000" placeholder="如何准备样本、调整指令、验证结果和迭代版本">${escapeHtml(skill?.trainingGuide || "")}</textarea></div>
    <div class="form-field full"><label>优化方向建议</label><textarea id="skillResourceOptimization" rows="5" maxlength="12000" placeholder="当前边界、常见失败和下一步可提升方向">${escapeHtml(skill?.optimizationAdvice || "")}</textarea></div>
    <div class="form-field full"><label>获取与安装说明</label><textarea id="skillResourceAcquisition" rows="4" maxlength="4000" placeholder="下载、解压、放置目录及启用方法">${escapeHtml(skill?.acquisitionInstructions || "")}</textarea></div>
  </div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="skillResourceSave">${skill ? "保存修改" : "保存草稿"}</button>`);
  qs("#skillResourceSave")?.addEventListener("click", () => void saveSkillResource(skill));
}

async function saveSkillResource(skill?: AgentSkill) {
  const payload = skillResourcePayload();
  if (!payload.name || !payload.summary || !payload.downloadUrl) return void toast("名称、简介和下载链接为必填", "error");
  try {
    await api(skill ? `/api/agent/skill-resources/${skill.id}` : "/api/agent/skill-resources", { method: skill ? "PATCH" : "POST", body: JSON.stringify(payload) });
    closeModal();
    await loadAgentSkills(false);
    toast(skill ? "Skill 已更新" : "Skill 草稿已保存，可在详情中发布");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Skill 保存失败", "error");
  }
}

async function updateSkillResourceStatus(skill: AgentSkill, status: "published" | "archived") {
  try {
    await api(`/api/agent/skill-resources/${skill.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
    closeAgentSkillDetail();
    await loadAgentSkills(false);
    toast(status === "published" ? "Skill 已发布上架" : "Skill 已下架");
  } catch (error) {
    toast(error instanceof Error ? error.message : "状态更新失败", "error");
  }
}

async function accessSkillResource(skill: AgentSkill) {
  const popup = window.open("", "_blank");
  if (popup) popup.opener = null;
  try {
    const result = await api<{ access: { url: string; extractionCode: string } }>(`/api/agent/skill-resources/${skill.id}/access`, { method: "POST", body: "{}" });
    if (result.access.extractionCode) await copyToClipboard(result.access.extractionCode);
    if (popup) popup.location.href = result.access.url;
    else window.open(result.access.url, "_blank", "noopener,noreferrer");
    toast(result.access.extractionCode ? "已打开网盘，提取码已复制" : "已打开下载链接");
    void loadAgentSkills(false);
  } catch (error) {
    popup?.close();
    toast(error instanceof Error ? error.message : "Skill 获取失败", "error");
  }
}

async function deleteSkillResource(skill: AgentSkill) {
  if (!await confirmAction({ title: "删除 Skill", message: `确定删除「${skill.name}」吗？`, consequences: ["只删除 CRM 中的上架记录", "不会删除百度网盘中的文件"], confirmLabel: "删除", tone: "danger" })) return;
  try {
    await api(`/api/agent/skill-resources/${skill.id}`, { method: "DELETE", body: "{}" });
    closeAgentSkillDetail();
    await loadAgentSkills(false);
    toast("Skill 已删除");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Skill 删除失败", "error");
  }
}

function agentTuningAuthorizationLabel(result: AgentTuningInspection) {
  const authorization = result.goalSpec.authorization;
  if (authorization.readOnly) return "只读自动执行";
  if (authorization.externalConfirmationRequired) return "外部动作确认一次";
  if (authorization.destructiveConfirmationRequired) return "高影响动作需确认";
  if (authorization.directExecution) return "站内动作直接授权";
  return "按目标继续判断";
}

function renderAgentTuningInspection(result: AgentTuningInspection) {
  const target = qs<HTMLElement>("#agentTuningResult");
  if (!target) return;
  const skills = result.skills.filter((item) => item.id !== "system-overview");
  const primarySkill = skills[0] || result.skills[0];
  const primaryKnowledge = result.knowledge[0];
  target.hidden = false;
  target.innerHTML = [
    `<section><span>目标契约</span><b>${escapeHtml(result.goalSpec.primaryAction)} / ${escapeHtml(result.goalSpec.primaryDomain)}</b><small>${escapeHtml(result.goalSpec.completionCriteria.slice(0, 2).join("；") || result.goalSpec.subject)}</small></section>`,
    `<section><span>授权</span><b>${escapeHtml(agentTuningAuthorizationLabel(result))}</b><small>${result.goalSpec.authorization.delegatedFieldSynthesis ? "允许补齐非敏感字段" : "仅使用明确字段与真实业务数据"}</small></section>`,
    `<section><span>Skill</span><b>${escapeHtml(primarySkill ? `${primarySkill.name} · ${primarySkill.score}` : "系统基础能力")}</b><small>${escapeHtml(primarySkill?.reasons.join("；") || "使用通用 Tool 契约")}</small></section>`,
    `<section><span>知识与工具</span><b>${escapeHtml(primaryKnowledge?.title || "未命中专项知识")}</b><small>${result.knowledge.length} 条知识 · ${result.toolRefs.length} 个工具</small></section>`
  ].join("");
}

export async function inspectAgentTuning() {
  const input = qs<HTMLInputElement>("#agentTuningGoalInput");
  const button = qs<HTMLButtonElement>("#agentTuningInspectButton");
  const goal = input?.value.trim() || "";
  if (!goal) {
    input?.focus();
    return;
  }
  if (button) button.disabled = true;
  try {
    const activeView = qs<HTMLElement>(".view.active")?.id || "agent-skills";
    const result = await api<AgentTuningInspection>("/api/agent/tuning/inspect", {
      method: "POST",
      body: JSON.stringify({ goal, context: { activeView } })
    });
    renderAgentTuningInspection(result);
  } catch (error) {
    toast(error instanceof Error ? error.message : "调教诊断失败", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function agentKnowledgeCenterBody() {
  const overview = state.agentKnowledgeOverview;
  if (!overview) return `<div class="agent-memory-empty">知识索引正在加载</div>`;
  const modules = ["all", ...overview.modules];
  const filtered = state.agentKnowledgeDocuments
    .filter((item) => agentKnowledgeStatus === "all" || item.status === agentKnowledgeStatus)
    .filter((item) => agentKnowledgeModule === "all" || item.module === agentKnowledgeModule)
    .filter((item) => !agentKnowledgeQuery || `${item.title} ${item.summary} ${item.content} ${item.keywords.join(" ")}`.toLowerCase().includes(agentKnowledgeQuery.toLowerCase()));
  const rows = filtered.map((item) => {
    const source = item.sourceType === "system_file" ? "系统版本" : item.sourceType === "distillation" ? "蒸馏打法" : item.sourceType === "agent_feedback" ? "执行经验" : "团队维护";
    const action = item.sourceType === "system_file" || item.sourceType === "distillation"
      ? ""
      : item.status === "draft"
        ? `<button class="btn" data-agent-knowledge-action="submit" data-agent-knowledge-id="${escapeHtml(item.id)}">提交审核</button>`
        : item.status === "review" && overview.canPublish
          ? `<button class="btn primary" data-agent-knowledge-action="publish" data-agent-knowledge-id="${escapeHtml(item.id)}">发布</button>`
          : item.status !== "archived"
            ? `<button class="btn" data-agent-knowledge-action="archive" data-agent-knowledge-id="${escapeHtml(item.id)}">归档</button>`
            : "";
    return `<article class="agent-knowledge-row"><button class="agent-knowledge-open" type="button" data-agent-knowledge-open="${escapeHtml(item.id)}"><span>${escapeHtml(item.module)} · ${escapeHtml(agentKnowledgeKindLabel(item.kind))}</span><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.summary)}</p><small>${escapeHtml(source)} · ${escapeHtml(item.version)} · ${escapeHtml(agentKnowledgeStatusLabel(item.status))}</small></button><div class="agent-knowledge-row-actions">${action}${item.canEdit ? `<button class="btn" data-agent-knowledge-edit="${escapeHtml(item.id)}">编辑</button>` : ""}</div></article>`;
  }).join("");
  const statusTabs: Array<[AgentKnowledgeStatus | "all", string]> = [["all", "全部"], ["published", "已发布"], ["review", "待审核"], ["draft", "草稿"], ["archived", "归档"]];
  return `<div class="agent-knowledge-workspace">
    <div class="agent-knowledge-metrics">
      <div><span>系统知识</span><b>${overview.systemCount}</b></div>
      <div><span>团队发布</span><b>${overview.publishedCount}</b></div>
      <div><span>待审核</span><b>${overview.reviewCount}</b></div>
      <div><span>蒸馏打法</span><b>${overview.distillationCount}</b></div>
    </div>
    <div class="agent-knowledge-toolbar">
      <input id="agentKnowledgeQuery" value="${escapeHtml(agentKnowledgeQuery)}" placeholder="搜索知识、流程或失败案例">
      <select id="agentKnowledgeModule">${modules.map((item) => `<option value="${escapeHtml(item)}" ${item === agentKnowledgeModule ? "selected" : ""}>${item === "all" ? "全部模块" : escapeHtml(item)}</option>`).join("")}</select>
      <button class="btn primary" id="agentKnowledgeCreate">新增知识</button>
    </div>
    <div class="agent-memory-tabs">${statusTabs.map(([value, label]) => `<button type="button" data-agent-knowledge-status="${value}" class="${agentKnowledgeStatus === value ? "active" : ""}">${label}</button>`).join("")}</div>
    <div class="agent-knowledge-grid">
      <section class="agent-knowledge-list">${rows || `<div class="agent-memory-empty">当前条件下没有知识</div>`}</section>
      <aside class="agent-knowledge-test">
        <div><span>检索模式</span><b>${escapeHtml(overview.retrievalMode)}</b></div>
        <input id="agentKnowledgeTestQuery" placeholder="输入一条真实业务指令">
        <button class="btn" id="agentKnowledgeTestButton">测试检索</button>
        <div id="agentKnowledgeTestResults"><div class="agent-knowledge-test-empty">等待检索</div></div>
      </aside>
    </div>
  </div>`;
}

function bindAgentKnowledgeCenter() {
  const modal = qs<HTMLElement>("#appModal");
  qs<HTMLInputElement>("#agentKnowledgeQuery", modal || document)?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    agentKnowledgeQuery = (event.currentTarget as HTMLInputElement).value.trim();
    openAgentKnowledgeCenter(false);
  });
  qs<HTMLSelectElement>("#agentKnowledgeModule", modal || document)?.addEventListener("change", (event) => {
    agentKnowledgeModule = (event.currentTarget as HTMLSelectElement).value;
    openAgentKnowledgeCenter(false);
  });
  qsa<HTMLButtonElement>("[data-agent-knowledge-status]", modal || document).forEach((button) => button.addEventListener("click", () => {
    agentKnowledgeStatus = button.dataset.agentKnowledgeStatus as AgentKnowledgeStatus | "all";
    openAgentKnowledgeCenter(false);
  }));
  qs<HTMLButtonElement>("#agentKnowledgeCreate", modal || document)?.addEventListener("click", () => openAgentKnowledgeEditor());
  qsa<HTMLButtonElement>("[data-agent-knowledge-open]", modal || document).forEach((button) => button.addEventListener("click", () => {
    const item = state.agentKnowledgeDocuments.find((entry) => entry.id === button.dataset.agentKnowledgeOpen);
    if (item) openAgentKnowledgeDetail(item);
  }));
  qsa<HTMLButtonElement>("[data-agent-knowledge-edit]", modal || document).forEach((button) => button.addEventListener("click", () => {
    const item = state.agentKnowledgeDocuments.find((entry) => entry.id === button.dataset.agentKnowledgeEdit);
    if (item) openAgentKnowledgeEditor(item);
  }));
  qsa<HTMLButtonElement>("[data-agent-knowledge-action]", modal || document).forEach((button) => button.addEventListener("click", () => void mutateAgentKnowledge(
    button.dataset.agentKnowledgeId || "",
    button.dataset.agentKnowledgeAction as "submit" | "publish" | "archive",
    button
  )));
  qs<HTMLButtonElement>("#agentKnowledgeTestButton", modal || document)?.addEventListener("click", (event) => void testAgentKnowledgeRetrieval(event.currentTarget as HTMLButtonElement));
}

export async function openAgentKnowledgeCenter(reload = true) {
  if (reload) await loadAgentKnowledge();
  openModal("Agent 学习中心", agentKnowledgeCenterBody(), `<button class="btn" data-modal-close>关闭</button>`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("agent-knowledge-modal");
  bindAgentKnowledgeCenter();
}

function openAgentKnowledgeDetail(document: AgentKnowledgeDocument) {
  const criteria = document.successCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const failures = document.failureCases.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  openModal(document.title, `<div class="agent-knowledge-detail"><header><span>${escapeHtml(document.module)} · ${escapeHtml(agentKnowledgeKindLabel(document.kind))}</span><b>${escapeHtml(document.version)}</b></header><p>${escapeHtml(document.content)}</p>${criteria ? `<section><h3>完成标准</h3><ul>${criteria}</ul></section>` : ""}${failures ? `<section><h3>常见失败</h3><ul>${failures}</ul></section>` : ""}<footer>${document.toolRefs.map((item) => `<code>${escapeHtml(item)}</code>`).join("")}</footer></div>`, `<button class="btn" id="agentKnowledgeBack">返回</button>${document.canEdit ? `<button class="btn primary" id="agentKnowledgeEditCurrent">编辑</button>` : ""}`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("agent-knowledge-modal");
  qs<HTMLButtonElement>("#agentKnowledgeBack")?.addEventListener("click", () => void openAgentKnowledgeCenter(false));
  qs<HTMLButtonElement>("#agentKnowledgeEditCurrent")?.addEventListener("click", () => openAgentKnowledgeEditor(document));
}

function openAgentKnowledgeEditor(document?: AgentKnowledgeDocument) {
  const kindOptions: AgentKnowledgeKind[] = ["module", "workflow", "policy", "field", "playbook", "failure_case"];
  openModal(document ? "编辑团队知识" : "新增团队知识", `<div class="agent-knowledge-editor"><div class="form-grid">
      <div class="form-field"><label>模块</label><input id="agentKnowledgeModuleInput" maxlength="80" value="${escapeHtml(document?.module || "")}"></div>
      <div class="form-field"><label>类型</label><select id="agentKnowledgeKindInput">${kindOptions.map((item) => `<option value="${item}" ${item === document?.kind ? "selected" : ""}>${agentKnowledgeKindLabel(item)}</option>`).join("")}</select></div>
      <div class="form-field"><label>范围</label><select id="agentKnowledgeScopeInput"><option value="team" ${document?.scope !== "company" ? "selected" : ""}>团队</option><option value="company" ${document?.scope === "company" ? "selected" : ""}>公司</option></select></div>
      <div class="form-field agent-knowledge-role-field"><label>适用权限</label><input id="agentKnowledgePermissionsInput" value="${escapeHtml((document?.permissionCodes || ["agent.use"]).join("，"))}"></div>
      <div class="form-field full"><label>标题</label><input id="agentKnowledgeTitleInput" maxlength="160" value="${escapeHtml(document?.title || "")}"></div>
      <div class="form-field full"><label>摘要</label><input id="agentKnowledgeSummaryInput" maxlength="500" value="${escapeHtml(document?.summary || "")}"></div>
      <div class="form-field full"><label>知识正文</label><textarea id="agentKnowledgeContentInput" rows="8" maxlength="8000">${escapeHtml(document?.content || "")}</textarea></div>
      <div class="form-field full"><label>关键词</label><input id="agentKnowledgeKeywordsInput" value="${escapeHtml((document?.keywords || []).join("，"))}"></div>
      <div class="form-field full"><label>关联工具</label><input id="agentKnowledgeToolsInput" value="${escapeHtml((document?.toolRefs || []).join("，"))}"></div>
      <div class="form-field"><label>完成标准</label><textarea id="agentKnowledgeCriteriaInput" rows="5">${escapeHtml((document?.successCriteria || []).join("\n"))}</textarea></div>
      <div class="form-field"><label>常见失败</label><textarea id="agentKnowledgeFailuresInput" rows="5">${escapeHtml((document?.failureCases || []).join("\n"))}</textarea></div>
    </div></div>`, `<button class="btn" id="agentKnowledgeEditorBack">返回</button><button class="btn primary" id="agentKnowledgeSave">保存</button>`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("agent-knowledge-modal");
  qs<HTMLButtonElement>("#agentKnowledgeEditorBack")?.addEventListener("click", () => void openAgentKnowledgeCenter(false));
  qs<HTMLButtonElement>("#agentKnowledgeSave")?.addEventListener("click", (event) => void saveAgentKnowledge(document, event.currentTarget as HTMLButtonElement));
}

function agentKnowledgeListValue(selector: string, splitLines = false) {
  const value = qs<HTMLInputElement | HTMLTextAreaElement>(selector)?.value || "";
  return value.split(splitLines ? /\r?\n/u : /[,，]/u).map((item) => item.trim()).filter(Boolean);
}

async function saveAgentKnowledge(document: AgentKnowledgeDocument | undefined, button: HTMLButtonElement) {
  const body = {
    module: qs<HTMLInputElement>("#agentKnowledgeModuleInput")?.value.trim() || "",
    kind: qs<HTMLSelectElement>("#agentKnowledgeKindInput")?.value,
    scope: qs<HTMLSelectElement>("#agentKnowledgeScopeInput")?.value,
    title: qs<HTMLInputElement>("#agentKnowledgeTitleInput")?.value.trim() || "",
    summary: qs<HTMLInputElement>("#agentKnowledgeSummaryInput")?.value.trim() || "",
    content: qs<HTMLTextAreaElement>("#agentKnowledgeContentInput")?.value.trim() || "",
    keywords: agentKnowledgeListValue("#agentKnowledgeKeywordsInput"),
    toolRefs: agentKnowledgeListValue("#agentKnowledgeToolsInput"),
    successCriteria: agentKnowledgeListValue("#agentKnowledgeCriteriaInput", true),
    failureCases: agentKnowledgeListValue("#agentKnowledgeFailuresInput", true),
    permissionCodes: agentKnowledgeListValue("#agentKnowledgePermissionsInput"),
    sourceType: document?.sourceType === "agent_feedback" ? "agent_feedback" : "manual",
    sourceId: document?.sourceId || ""
  };
  if (!body.module || body.title.length < 2 || body.summary.length < 2 || body.content.length < 10 || !body.permissionCodes.length) {
    toast("请完整填写模块、标题、摘要、正文和适用权限", "error");
    return;
  }
  button.disabled = true;
  try {
    await api(document ? `/api/agent/knowledge/documents/${encodeURIComponent(document.id)}` : "/api/agent/knowledge/documents", {
      method: document ? "PATCH" : "POST",
      body: JSON.stringify(body)
    });
    await loadAgentKnowledge();
    agentKnowledgeStatus = document?.status === "published" ? "review" : document?.status || "draft";
    openAgentKnowledgeCenter(false);
    toast(document ? "知识已更新并进入审核" : "知识草稿已保存");
  } catch (error) {
    button.disabled = false;
    toast(error instanceof Error ? error.message : "知识保存失败", "error");
  }
}

async function mutateAgentKnowledge(id: string, action: "submit" | "publish" | "archive", button: HTMLButtonElement) {
  if (!id) return;
  button.disabled = true;
  try {
    await api(`/api/agent/knowledge/documents/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    await loadAgentKnowledge();
    agentKnowledgeStatus = action === "submit" ? "review" : action === "publish" ? "published" : "archived";
    openAgentKnowledgeCenter(false);
    toast(action === "submit" ? "已提交审核" : action === "publish" ? "团队知识已发布" : "知识已归档");
  } catch (error) {
    button.disabled = false;
    toast(error instanceof Error ? error.message : "知识操作失败", "error");
  }
}

async function testAgentKnowledgeRetrieval(button: HTMLButtonElement) {
  const query = qs<HTMLInputElement>("#agentKnowledgeTestQuery")?.value.trim() || "";
  if (!query) { toast("请输入业务指令", "error"); return; }
  button.disabled = true;
  try {
    const result = await api<{ hits: Array<{ document: AgentKnowledgeDocument; score: number; reasons: string[] }> }>(`/api/agent/knowledge/search?query=${encodeURIComponent(query)}&activeView=ai-agent&limit=8`);
    const target = qs<HTMLElement>("#agentKnowledgeTestResults");
    if (target) target.innerHTML = result.hits.length ? result.hits.map((hit) => `<button type="button" data-agent-knowledge-test-open="${escapeHtml(hit.document.id)}"><b>${escapeHtml(hit.document.title)}</b><span>${hit.score} · ${escapeHtml(hit.reasons.join("、") || hit.document.trustLevel)}</span></button>`).join("") : `<div class="agent-knowledge-test-empty">没有匹配知识</div>`;
    qsa<HTMLButtonElement>("[data-agent-knowledge-test-open]").forEach((item) => item.addEventListener("click", () => {
      const document = result.hits.find((hit) => hit.document.id === item.dataset.agentKnowledgeTestOpen)?.document;
      if (document) openAgentKnowledgeDetail(document);
    }));
  } catch (error) {
    toast(error instanceof Error ? error.message : "检索测试失败", "error");
  } finally {
    button.disabled = false;
  }
}

function agentTriggerTypeLabel(type: AgentTriggerEventType) {
  return ({ lead_overdue: "线索超时", customer_reply: "客户新回复", stalled_deal: "商机停滞", next_action_due: "下一动作到期", health_decline: "客户健康下降", communication_unread: "即刻沟通未读", prospect_completed: "搜客任务结束" } as Record<AgentTriggerEventType, string>)[type];
}

function agentTriggerModeLabel(mode: AgentTriggerRule["mode"]) {
  return ({ notify: "只读提醒", internal: "站内任务待确认", approval: "审批型建议" } as Record<AgentTriggerRule["mode"], string>)[mode];
}

function renderAgentTriggerStatus() {
  const button = qs<HTMLButtonElement>("#agentTriggerStatus");
  if (!button) return;
  const active = state.agentTriggerRules.filter((item) => item.status === "active").length;
  const recent = state.agentTriggerEvents.filter((item) => Date.now() - new Date(item.createdAt).getTime() < 86_400_000).length;
  button.innerHTML = `<span>自动触发</span><b>${active ? `${active} 条规则运行中` : "尚未创建运行规则"}</b><small>${recent ? `近 24 小时触发 ${recent} 次` : ""}</small>`;
}

export async function loadAgentTriggers(showError = true) {
  try {
    const result = await api<{ rules: AgentTriggerRule[]; events: AgentTriggerEvent[] }>("/api/agent/triggers?limit=50");
    state.agentTriggerRules = result.rules || [];
    state.agentTriggerEvents = result.events || [];
    renderAgentTriggerStatus();
  } catch (error) {
    if (showError) toast(error instanceof Error ? error.message : "自动触发规则读取失败", "error");
  }
}

function agentTriggerManagerBody() {
  const rules = state.agentTriggerRules.map((rule) => {
    const action = rule.status === "active" ? "pause" : "resume";
    const last = rule.lastTriggeredAt ? new Date(rule.lastTriggeredAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "尚未触发";
    return `<article class="agent-trigger-card"><div><h3>${escapeHtml(rule.name)}</h3><p>${escapeHtml(agentTriggerTypeLabel(rule.eventType))} · ${escapeHtml(agentTriggerModeLabel(rule.mode))} · 每 ${rule.intervalMinutes} 分钟</p><small>${rule.status === "active" ? `运行中 · 最近 ${escapeHtml(last)}` : "已暂停"}</small></div><div class="agent-trigger-actions"><button class="btn" type="button" data-agent-trigger-action="run" data-agent-trigger-id="${escapeHtml(rule.id)}">立即扫描</button><button class="btn" type="button" data-agent-trigger-edit="${escapeHtml(rule.id)}">编辑</button><button class="btn" type="button" data-agent-trigger-action="${action}" data-agent-trigger-id="${escapeHtml(rule.id)}">${action === "pause" ? "暂停" : "继续"}</button><button class="btn" type="button" data-agent-trigger-action="delete" data-agent-trigger-id="${escapeHtml(rule.id)}">删除</button></div></article>`;
  }).join("");
  const events = state.agentTriggerEvents.slice(0, 8).map((item) => `<div class="agent-trigger-event"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.message)} · ${escapeHtml(new Date(item.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }))}${item.missionRunId ? ` · <button class="btn" type="button" data-agent-trigger-mission="${escapeHtml(item.missionRunId)}">查看 Mission</button>` : ""}</span></div>`).join("");
  return `<div class="agent-memory-toolbar"><div><b>${state.agentTriggerRules.length} 条规则</b></div><button class="btn primary" type="button" id="agentTriggerCreateButton">新增规则</button></div><div class="agent-trigger-list">${rules || `<div class="agent-memory-empty">尚未创建自动触发规则</div>`}</div><section class="agent-trigger-events"><h3>最近触发</h3>${events || `<div class="agent-memory-empty">暂无触发记录</div>`}</section>`;
}

function bindAgentTriggerManager() {
  qs<HTMLButtonElement>("#agentTriggerCreateButton")?.addEventListener("click", () => openAgentTriggerEditor());
  qsa<HTMLButtonElement>("[data-agent-trigger-edit]").forEach((button) => button.addEventListener("click", () => {
    const rule = state.agentTriggerRules.find((item) => item.id === button.dataset.agentTriggerEdit);
    if (rule) openAgentTriggerEditor(rule);
  }));
  qsa<HTMLButtonElement>("[data-agent-trigger-action]").forEach((button) => button.addEventListener("click", () => void mutateAgentTrigger(
    button.dataset.agentTriggerId || "",
    button.dataset.agentTriggerAction as "run" | "pause" | "resume" | "delete",
    button
  )));
  qsa<HTMLButtonElement>("[data-agent-trigger-mission]").forEach((button) => button.addEventListener("click", () => {
    closeModal();
    void loadAgentRun(button.dataset.agentTriggerMission || "");
  }));
}

export async function openAgentTriggerManager(reload = true) {
  if (reload) await loadAgentTriggers();
  openModal("自动触发", agentTriggerManagerBody(), `<button class="btn" data-modal-close>关闭</button>`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("agent-memory-modal");
  bindAgentTriggerManager();
}

function openAgentTriggerEditor(rule?: AgentTriggerRule) {
  const options: Array<[AgentTriggerEventType, string]> = [["lead_overdue", "线索超时"], ["customer_reply", "客户新回复"], ["stalled_deal", "商机停滞"], ["next_action_due", "下一动作到期"], ["health_decline", "客户健康下降"], ["communication_unread", "即刻沟通未读"], ["prospect_completed", "搜客任务结束"]];
  openModal(rule ? "编辑自动触发" : "新增自动触发", `<div class="form-grid"><div class="form-field full"><label>规则名称</label><input id="agentTriggerNameInput" maxlength="120" value="${escapeHtml(rule?.name || "")}"></div><div class="form-field"><label>触发事件</label><select id="agentTriggerTypeInput">${options.map(([value, label]) => `<option value="${value}" ${rule?.eventType === value ? "selected" : ""}>${label}</option>`).join("")}</select></div><div class="form-field"><label>处理方式</label><select id="agentTriggerModeInput"><option value="notify" ${rule?.mode === "notify" ? "selected" : ""}>只读提醒</option><option value="internal" ${rule?.mode === "internal" ? "selected" : ""}>站内任务待确认</option><option value="approval" ${rule?.mode === "approval" ? "selected" : ""}>审批型建议</option></select></div><div class="form-field"><label>扫描间隔（分钟）</label><input id="agentTriggerIntervalInput" type="number" min="5" max="10080" value="${rule?.intervalMinutes || 60}"></div><div class="form-field"><label>超时阈值（天）</label><input id="agentTriggerDaysInput" type="number" min="1" max="180" value="${rule?.thresholdDays || 3}"></div><div class="form-field"><label>健康度阈值</label><input id="agentTriggerHealthInput" type="number" min="0" max="100" value="${rule?.healthBelow ?? 60}"></div><div class="form-field"><label>单次上限</label><input id="agentTriggerMaxInput" type="number" min="1" max="20" value="${rule?.maxPerScan || 5}"></div></div>`, `<button class="btn" id="agentTriggerBackButton">返回</button><button class="btn primary" id="agentTriggerSaveButton">保存</button>`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("agent-memory-modal");
  qs<HTMLButtonElement>("#agentTriggerBackButton")?.addEventListener("click", () => void openAgentTriggerManager(false));
  qs<HTMLButtonElement>("#agentTriggerSaveButton")?.addEventListener("click", (event) => void saveAgentTrigger(rule, event.currentTarget as HTMLButtonElement));
}

async function saveAgentTrigger(rule: AgentTriggerRule | undefined, button: HTMLButtonElement) {
  const name = qs<HTMLInputElement>("#agentTriggerNameInput")?.value.trim() || "";
  if (name.length < 2) { toast("请填写规则名称", "error"); return; }
  button.disabled = true;
  try {
    await api(rule ? `/api/agent/triggers/${encodeURIComponent(rule.id)}` : "/api/agent/triggers", { method: rule ? "PATCH" : "POST", body: JSON.stringify({ name, eventType: qs<HTMLSelectElement>("#agentTriggerTypeInput")?.value, mode: qs<HTMLSelectElement>("#agentTriggerModeInput")?.value, intervalMinutes: Number(qs<HTMLInputElement>("#agentTriggerIntervalInput")?.value || 60), thresholdDays: Number(qs<HTMLInputElement>("#agentTriggerDaysInput")?.value || 3), healthBelow: Number(qs<HTMLInputElement>("#agentTriggerHealthInput")?.value || 60), maxPerScan: Number(qs<HTMLInputElement>("#agentTriggerMaxInput")?.value || 5) }) });
    await loadAgentTriggers();
    openAgentTriggerManager(false);
    toast(rule ? "自动触发规则已更新" : "自动触发规则已启动");
  } catch (error) {
    button.disabled = false;
    toast(error instanceof Error ? error.message : "自动触发规则保存失败", "error");
  }
}

async function mutateAgentTrigger(id: string, action: "run" | "pause" | "resume" | "delete", button: HTMLButtonElement) {
  if (!id) return;
  if (action === "delete") {
    const confirmed = await confirmAction({
      title: "删除自动触发规则",
      message: "这条规则将停止后续自动扫描。",
      consequences: ["规则配置会被删除", "已经产生的历史触发记录会保留"],
      confirmLabel: "删除规则"
    });
    if (!confirmed) {
      openAgentTriggerManager(false);
      return;
    }
  }
  button.disabled = true;
  try {
    await api(`/api/agent/triggers/${encodeURIComponent(id)}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST" });
    await loadAgentTriggers();
    openAgentTriggerManager(false);
    toast(action === "run" ? "扫描完成，符合条件的 Mission 已创建" : action === "pause" ? "规则已暂停" : action === "resume" ? "规则已恢复" : "规则已删除");
    if (action === "run") void loadAgentConversations();
  } catch (error) {
    button.disabled = false;
    toast(error instanceof Error ? error.message : "自动触发操作失败", "error");
  }
}

function renderAgentGovernanceStatus() {
  const button = qs<HTMLButtonElement>("#agentGovernanceStatus");
  if (!button) return;
  const metrics = state.agentGovernance?.last24Hours;
  button.innerHTML = metrics
    ? `<span>运行与成本</span><b>成功率 ${metrics.successRate}%</b><small>24 小时 ${metrics.calls} 次 · 估算 $${metrics.estimatedCostUsd.toFixed(4)}</small>`
    : `<span>运行与成本</span><b>等待统计</b><small>模型路由、预算与安全评测</small>`;
}

export async function loadAgentGovernance(showError = true) {
  try {
    state.agentGovernance = await api<AgentGovernance>("/api/agent/governance");
    renderAgentGovernanceStatus();
  } catch (error) {
    if (showError) toast(error instanceof Error ? error.message : "Agent 运行统计读取失败", "error");
  }
}

function agentGovernanceBody() {
  const governance = state.agentGovernance;
  if (!governance) return `<div class="agent-memory-empty">正在读取运行统计</div>`;
  const metrics = governance.last24Hours;
  const latest = governance.evaluations[0];
  const evaluationResults = latest?.results.map((item) => `<div class="agent-evaluation-result ${item.passed ? "" : "failed"}"><span>${escapeHtml(item.name)}</span><b>${item.passed ? "通过" : "未通过"}</b></div>`).join("") || `<div class="agent-memory-empty">尚未运行安全评测</div>`;
  const calls = governance.recentCalls.slice(0, 8).map((item) => `<div class="agent-trigger-event"><b>${escapeHtml(item.purpose === "planning" ? "任务规划" : "结果核验")} · ${escapeHtml(item.model)}</b><span>${item.success ? `${item.inputTokens + item.outputTokens} Token · ${item.latencyMs} ms · 估算 $${item.estimatedCostUsd.toFixed(6)}` : `失败 · ${escapeHtml(item.error)}`}${item.routeIndex > 0 ? " · 已降级" : ""}</span></div>`).join("") || `<div class="agent-memory-empty">暂无模型调用记录</div>`;
  return `<div class="agent-governance-metrics"><div class="agent-governance-metric"><span>调用</span><b>${metrics.calls}</b></div><div class="agent-governance-metric"><span>成功率</span><b>${metrics.successRate}%</b></div><div class="agent-governance-metric"><span>平均延迟</span><b>${metrics.averageLatencyMs}ms</b></div><div class="agent-governance-metric"><span>估算成本</span><b>$${metrics.estimatedCostUsd.toFixed(4)}</b></div></div><section class="agent-governance-section"><header><h3>模型路由与预算</h3></header><div class="agent-governance-route"><span>任务规划</span><b>${escapeHtml(governance.routes.planning)}</b></div><div class="agent-governance-route"><span>结果核验</span><b>${escapeHtml(governance.routes.evaluation)}</b></div><div class="agent-governance-route"><span>预算上限</span><b>每日 $${governance.budgets.dailyUsd} · 单 Mission $${governance.budgets.missionUsd}</b></div></section><section class="agent-governance-section"><header><h3>安全评测${latest ? ` · ${latest.passed}/${latest.total}` : ""}</h3><button class="btn primary" type="button" id="agentEvaluationRunButton">运行评测</button></header>${evaluationResults}</section><section class="agent-governance-section"><header><h3>最近模型调用</h3></header>${calls}</section>`;
}

export async function openAgentGovernance(reload = true) {
  if (reload) await loadAgentGovernance();
  openModal("Agent 运行与成本", agentGovernanceBody(), `<button class="btn" data-modal-close>关闭</button>`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("agent-memory-modal");
  qs<HTMLButtonElement>("#agentEvaluationRunButton")?.addEventListener("click", (event) => void runAgentEvaluationFromUi(event.currentTarget as HTMLButtonElement));
}

async function runAgentEvaluationFromUi(button: HTMLButtonElement) {
  button.disabled = true;
  button.textContent = "评测中";
  try {
    const result = await api<{ evaluation: AgentGovernance["evaluations"][number]; metrics: AgentGovernance }>("/api/agent/evaluations/run", { method: "POST" });
    state.agentGovernance = result.metrics;
    openAgentGovernance(false);
    toast(`安全评测完成：${result.evaluation.passed}/${result.evaluation.total} 通过`, result.evaluation.passed === result.evaluation.total ? "ok" : "error");
  } catch (error) {
    button.disabled = false;
    button.textContent = "运行评测";
    toast(error instanceof Error ? error.message : "Agent 安全评测失败", "error");
  }
}

function agentRelativeTime(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 5_000) return "刚刚更新";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)} 秒前更新`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前更新`;
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function agentDecisionTrace(run: AgentRun) {
  const raw = [...run.events].reverse().find((item) => item.message.startsWith("本轮语义判决："))?.message.slice("本轮语义判决：".length);
  if (!raw) return { action: "正在理解目标", target: run.goalSpec?.subject || run.goal, confidence: 0 };
  try {
    const decision = JSON.parse(raw) as { speechAct?: string; operation?: string; target?: string; intentConfidence?: number };
    const actionLabels: Record<string, string> = {
      execute: "执行业务动作",
      query_data: "查询并核验数据",
      navigate: "打开业务页面",
      explain: "回答业务问题",
      chat: "普通对话",
      cancel: "停止当前任务"
    };
    return {
      action: actionLabels[String(decision.speechAct || "")] || String(decision.operation || "已识别业务目标"),
      target: String(decision.target || run.goalSpec?.subject || run.goal),
      confidence: Math.round(Number(decision.intentConfidence || 0) * 100)
    };
  } catch {
    return { action: "已识别业务目标", target: run.goalSpec?.subject || run.goal, confidence: 0 };
  }
}

function agentStepTarget(step: AgentStep) {
  if (["api.read", "api.write", "api.external"].includes(step.tool)) {
    return `${String(step.input.method || "REQUEST").toUpperCase()} ${String(step.input.path || "待解析接口")}`;
  }
  if (step.tool.startsWith("ui.")) return `界面动作 · ${String(step.input.view || step.input.customerId || step.input.leadId || "当前页面")}`;
  const references = ["customerId", "leadId", "dealId", "entityId", "runId", "sequenceId"]
    .map((key) => step.input[key] ? `${key}=${String(step.input[key])}` : "")
    .filter(Boolean)
    .slice(0, 2);
  return references.length ? `${step.tool} · ${references.join(" · ")}` : step.tool;
}

function agentFailureDiagnosis(error = "") {
  if (!error) return "执行器没有返回明确错误，请查看执行记录。";
  if (/(403|无权|权限|forbidden)/iu.test(error)) return `权限校验未通过：${error}`;
  if (/(404|不存在|not found)/iu.test(error)) return `目标接口或业务对象不存在：${error}`;
  if (/(400|参数|字段|schema|validation|invalid)/iu.test(error)) return `接口参数或契约校验失败：${error}`;
  if (/(timeout|timed out|fetch failed|network|ECONN|连接)/iu.test(error)) return `网络或上游服务调用失败：${error}`;
  if (/(工作流|依赖|结果路径|前置步骤)/u.test(error)) return `动作依赖或结果引用失败：${error}`;
  return error;
}

function agentStepTraceDetail(step: AgentStep, run: AgentRun) {
  const dependencies = step.dependsOn || [];
  const dependencyStates = dependencies.map((key) => {
    const source = run.steps.find((candidate) => candidate.key === key);
    return `${key}=${source ? agentStepStatusLabel(source.status) : "不存在"}`;
  });
  if (step.status === "failed" || step.status === "skipped") return agentFailureDiagnosis(step.error || "");
  if (dependencyStates.length && !dependencies.every((key) => run.steps.some((candidate) => candidate.key === key && candidate.status === "done"))) {
    return `等待前置结果：${dependencyStates.join("，")}`;
  }
  if (step.status === "running") return `执行器正在调用 ${agentStepTarget(step)}`;
  if (step.status === "queued") return `已经进入后台队列，等待执行器领取；目标 ${agentStepTarget(step)}`;
  if (step.status === "needs_confirmation") return `最终参数已锁定，等待确认后调用 ${agentStepTarget(step)}`;
  if (step.status === "ready") return `参数和权限校验已通过，等待调用 ${agentStepTarget(step)}`;
  const evidence = agentResultSummary(step.result);
  return `${evidence || "动作已完成"}${dependencyStates.length ? `；前置 ${dependencyStates.join("，")}` : ""}`;
}

function agentTraceSteps(run: AgentRun) {
  const indexed = run.steps.map((step, index) => ({ step, index }));
  const selected = new Map<number, { step: AgentStep; index: number }>();
  indexed.filter(({ step }) => ["running", "queued", "needs_confirmation", "ready", "failed", "skipped"].includes(step.status))
    .slice(0, 6)
    .forEach((item) => selected.set(item.index, item));
  [...indexed].reverse().filter(({ step }) => step.status === "done").slice(0, 3)
    .forEach((item) => selected.set(item.index, item));
  return [...selected.values()].sort((left, right) => left.index - right.index).slice(-9);
}

function agentExecutionTrace(run: AgentRun, live: boolean) {
  if (!run.steps.length) return "";
  const decision = agentDecisionTrace(run);
  const completed = run.steps.filter((step) => step.status === "done").length;
  const traceSteps = agentTraceSteps(run);
  const recentEvents = run.events
    .filter((item) => item.type !== "assistant" && !item.message.startsWith("本轮语义判决：") && !item.message.startsWith("任务上下文："))
    .slice(-4);
  const currentLabel = run.currentAction || (run.status === "completed" ? "完成证据已核验" : run.stopReason || "等待下一步");
  const stepRows = traceSteps.map(({ step, index }) => {
    const dependenciesReady = (step.dependsOn || []).every((key) => run.steps.some((candidate) => candidate.key === key && candidate.status === "done"));
    const status = !dependenciesReady && ["ready", "needs_confirmation"].includes(step.status) ? "等待前置" : agentStepStatusLabel(step.status);
    const approval = step.status === "needs_confirmation" && step.risk === "write" && dependenciesReady
      ? `<button type="button" class="agent-chat-confirm" data-agent-chat-approve="${escapeHtml(step.id)}">确认写入</button>`
      : `<small>${escapeHtml(status)}</small>`;
    return `<div class="agent-trace-step ${escapeHtml(step.status)}"><span>${index + 1}</span><i></i><div><b>${escapeHtml(step.title)}</b><small>${escapeHtml(agentStepTarget(step))}</small><p class="${["failed", "skipped"].includes(step.status) ? "is-error" : ""}">${escapeHtml(agentStepTraceDetail(step, run))}</p></div>${approval}</div>`;
  }).join("");
  const eventRows = recentEvents.map((item) => `<div class="agent-trace-event ${escapeHtml(item.type)}"><i></i><span>${escapeHtml(item.message)}</span><time>${escapeHtml(agentRelativeTime(item.createdAt))}</time></div>`).join("");
  const traceOpen = live || (run.status === "failed" && run.id === state.agentRun?.id);
  return `<div class="agent-live-execution">
    <div class="agent-live-current"><i class="${live && !["awaiting_confirmation", "paused"].includes(run.status) ? "" : "still"}"></i><div><small>当前阶段 · ${escapeHtml(agentRelativeTime(run.updatedAt))}</small><b>${escapeHtml(currentLabel)}</b></div><strong>${completed} / ${run.steps.length}</strong></div>
    <div class="agent-trace-context"><div><span>意图</span><b>${escapeHtml(decision.action)}</b></div><div><span>目标</span><b>${escapeHtml(decision.target)}</b></div><div><span>判断</span><b>${decision.confidence ? `${decision.confidence}%` : `第 ${run.iteration} 轮`}</b></div></div>
    <details class="agent-action-chain" ${traceOpen ? "open" : ""}><summary><span>可审计动作链</span><small>${traceSteps.length < run.steps.length ? `显示关键 ${traceSteps.length} 步 · 全部 ${run.steps.length} 步` : `${run.steps.length} 个动作`}</small></summary><div class="agent-trace-list">${stepRows || `<div class="agent-trace-empty">正在生成动作</div>`}</div></details>
    ${eventRows ? `<div class="agent-trace-events"><header><span>最近执行记录</span><small>${live ? "持续更新" : "执行快照"}</small></header>${eventRows}</div>` : ""}
  </div>`;
}

function renderAgentConversation() {
  const container = qs<HTMLElement>("#agentChatMessages");
  if (!container) return;
  const wasFollowing = !container.dataset.timelineReady
    || container.scrollHeight - container.scrollTop - container.clientHeight < 120
    || Boolean(agentPendingGoal);
  const runs = [...state.agentRuns].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (!runs.length && !agentPendingGoal) {
    container.innerHTML = `<div class="agent-chat-welcome"><span>AI</span><div><h2>今天想推进什么？</h2></div></div>`;
    container.dataset.timelineReady = "1";
    return;
  }

  const timeLabel = (value: string) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const assistantRow = (message: string, createdAt: string, status: string, tone: string, live = false, execution = "") => `<div class="agent-chat-row assistant">
    <span class="agent-chat-avatar">AI</span>
    <div class="agent-chat-answer ${live ? "is-progress" : "is-final"}">
      <div class="agent-chat-answer-head"><span class="agent-chat-reply-state ${escapeHtml(tone)}"><i></i>${escapeHtml(status)}</span><time>${escapeHtml(timeLabel(createdAt))}</time></div>
      <p>${escapeHtml(message)}</p>
      ${execution}
    </div>
  </div>`;
  const terminalReply = (item: AgentRun) => {
    if (item.status === "completed") return item.summary || item.stopReason || "任务已完成。";
    if (item.status === "waiting_user") {
      if (!item.stopReason || item.summary.includes(item.stopReason)) return item.summary || item.stopReason;
      return `${item.summary}${item.summary ? "\n\n" : ""}需要你补充：${item.stopReason}`;
    }
    if (item.status === "cancelled") return "任务已取消，未执行的动作已经停止。";
    return item.stopReason || item.summary || "任务未能完成，请检查执行记录。";
  };

  container.innerHTML = runs.map((item) => {
    const selected = item.id === state.agentRun?.id ? " active" : "";
    const timeline: Array<{ role: "user" | "assistant"; message: string; createdAt: string; order: number }> = [{ role: "user", message: item.goal, createdAt: item.createdAt, order: 0 }];
    item.events.forEach((entry, index) => {
      if (entry.type === "assistant") timeline.push({ role: "assistant", message: entry.message, createdAt: entry.createdAt, order: index + 1 });
      if (entry.type === "plan" && entry.message.startsWith("用户补充：")) timeline.push({ role: "user", message: entry.message.slice(5), createdAt: entry.createdAt, order: index + 1 });
    });
    timeline.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.order - right.order);
    let latestUserIndex = -1;
    let latestReplyIndex = -1;
    timeline.forEach((entry, index) => {
      if (entry.role === "user") latestUserIndex = index;
      if (entry.role === "assistant") latestReplyIndex = index;
    });
    const settled = ["completed", "waiting_user", "failed", "cancelled"].includes(item.status);
    if (settled && latestReplyIndex < latestUserIndex) {
      timeline.push({ role: "assistant", message: terminalReply(item), createdAt: item.updatedAt, order: Number.MAX_SAFE_INTEGER });
    }
    const terminalAssistantIndex = settled
      ? timeline.reduce((latest, entry, index) => entry.role === "assistant" ? index : latest, -1)
      : -1;
    const messages = timeline.map((entry, index) => {
      if (entry.role === "user") return `<div class="agent-chat-row user"><div class="agent-chat-bubble">${escapeHtml(entry.message)}</div><time>${escapeHtml(timeLabel(entry.createdAt))}</time></div>`;
      const followedByUser = timeline.slice(index + 1).some((candidate) => candidate.role === "user");
      const replyStatus = followedByUser || item.status === "waiting_user" ? "等你回复" : item.status === "failed" ? "未完成" : item.status === "cancelled" ? "已取消" : "已完成";
      const replyTone = followedByUser || item.status === "waiting_user" ? "waiting" : item.status === "failed" ? "danger" : item.status === "cancelled" ? "muted" : "done";
      return assistantRow(entry.message, entry.createdAt, replyStatus, replyTone, false, index === terminalAssistantIndex ? agentExecutionTrace(item, false) : "");
    })
      .join("");
    const live = !settled;
    const liveStatus = item.status === "awaiting_confirmation" ? "等待确认" : item.status === "paused" ? "已暂停" : "进行中";
    const liveTone = item.status === "awaiting_confirmation" ? "waiting" : item.status === "paused" ? "muted" : "running";
    const liveMessage = item.status === "awaiting_confirmation"
      ? item.currentAction || "行动计划等待确认，批准后会从当前位置继续。"
      : item.status === "paused"
        ? item.stopReason || "任务已暂停。"
        : item.currentAction || item.summary || "正在理解目标并生成行动计划。";
    const execution = agentExecutionTrace(item, true);
    const liveRow = live ? assistantRow(liveMessage, item.updatedAt, liveStatus, liveTone, true, execution) : "";
    return `<div class="agent-chat-turn${selected}" data-agent-chat-run="${escapeHtml(item.id)}">${messages}${liveRow}</div>`;
  }).join("") + (agentPendingGoal ? (() => {
    const progress = agentPendingProgress.length ? agentPendingProgress : [{
      phase: "understanding" as const,
      requestKind: "conversation" as const,
      message: "正在理解你的目标和当前业务上下文",
      detail: "先判断你希望获取信息，还是让我直接完成一项工作"
    }];
    const current = progress.at(-1)!;
    const labels: Record<AgentPlanningProgress["phase"], string> = current.requestKind === "conversation"
      ? { understanding: "理解中", intent: "已识别", planning: "组织回复", ready: "回复中" }
      : current.requestKind === "query"
        ? { understanding: "理解中", intent: "已识别", planning: "准备查询", ready: "开始查询" }
        : { understanding: "理解中", intent: "已识别", planning: "准备执行", ready: "即将开始" };
    const stream = `<div class="agent-thinking-stream">${progress.map((item, index) => `<div class="agent-thinking-line ${index === progress.length - 1 ? "active" : "done"}"><i></i><div><b>${escapeHtml(item.message)}</b><small>${escapeHtml(item.detail)}</small></div><span>${index === progress.length - 1 ? labels[item.phase] : "完成"}</span></div>`).join("")}</div>`;
    return `<div class="agent-chat-turn pending"><div class="agent-chat-row user"><div class="agent-chat-bubble">${escapeHtml(agentPendingGoal)}</div></div>${assistantRow(current.message, new Date().toISOString(), labels[current.phase], "running", true, stream)}</div>`;
  })() : "");
  qsa<HTMLElement>("[data-agent-chat-run]", container).forEach((item) => item.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const copyableText = target.closest(".agent-chat-bubble, .agent-chat-answer > p, .agent-live-current b, .agent-live-step span, .agent-thinking-line b, .agent-thinking-line small");
    if (copyableText || window.getSelection()?.toString().trim()) return;
    const runId = item.dataset.agentChatRun || "";
    const run = state.agentRuns.find((candidate) => candidate.id === runId);
    if (run) {
      state.agentRun = run;
      renderAgent(run);
    }
  }));
  qsa<HTMLButtonElement>("[data-agent-chat-approve]", container).forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    void executeAgentStepFromUi(button.dataset.agentChatApprove || "", true);
  }));
  container.dataset.timelineReady = "1";
  if (wasFollowing) container.scrollTop = container.scrollHeight;
}

export function renderAgent(run = state.agentRun) {
  renderAgentMemoryStatus();
  renderAgentKnowledgeStatus();
  renderAgentTriggerStatus();
  renderAgentGovernanceStatus();
  const modelStatus = qs<HTMLElement>("#agentModelStatus");
  const modelConfig = state.aiConfig;
  if (modelStatus) {
    modelStatus.innerHTML = modelConfig?.enabled && modelConfig.hasApiKey
      ? `<span class="badge green">模型已启用</span><span>${escapeHtml(modelConfig.name || modelConfig.model || "当前模型")}</span>`
      : `<span class="badge amber">基础执行</span><span>常用任务可用</span>`;
  }
  const playbookStatus = qs<HTMLButtonElement>("#agentPlaybookStatus");
  if (playbookStatus) {
    const activation = state.salesPlaybookActivations.find((item) => item.status === "active");
    const distillation = activation ? state.salesDistillations.find((item) => item.id === activation.distillationId) : undefined;
    playbookStatus.classList.toggle("active", Boolean(activation && distillation));
    playbookStatus.innerHTML = activation && distillation
      ? `<span>当前销售能力</span><b>${escapeHtml(distillation.sourceUserName)}${distillation.version ? ` · V${distillation.version}` : ""}</b><small>${distillation.maturity ? salesTrainingMaturityLabel(distillation.maturity) : "历史能力"} · 应用 ${activation.applicationCount} 次 · 待办 ${activation.taskCount} 个</small>`
      : `<span>当前销售能力</span><b>尚未应用</b><small></small>`;
    playbookStatus.onclick = () => activateNavView("sales-distillation", () => void loadSalesDistillationWorkspace());
  }
  const expired = Boolean(run && new Date(run.expiresAt).getTime() <= Date.now());
  const runStatus = qs<HTMLElement>("#agentRunStatus");
  if (runStatus) {
    const tone = expired || ["cancelled", "paused"].includes(run?.status || "")
      ? "gray"
      : run?.status === "completed"
        ? "green"
        : run?.status === "failed"
          ? "red"
          : ["awaiting_confirmation", "waiting_user"].includes(run?.status || "")
            ? "amber"
            : run
              ? "blue"
              : "gray";
    runStatus.innerHTML = `<span class="badge ${tone}">${agentRunStatusLabel(expired ? "expired" : run?.status || "idle")}</span>`;
  }
  const summary = qs<HTMLElement>("#agentPlanSummary");
  if (summary) summary.textContent = run?.summary || "";
  const workflow = qs<HTMLElement>("#agentWorkflowPreview");
  if (workflow) {
    workflow.innerHTML = agentWorkflowMarkup(run);
    qs<HTMLButtonElement>("#agentHighFreedomButton", workflow)?.addEventListener("click", () => void controlAgentMission("resume", "启用高自由度推理，自主读取相关接口契约并持续执行到全部完成标准满足"));
    qs<HTMLButtonElement>("#agentSkillDraftButton", workflow)?.addEventListener("click", () => void saveAgentRunAsSkillDraft());
  }
  const mission = qs<HTMLElement>("#agentMissionProgress");
  if (mission) {
    const completed = run?.steps.filter((step) => step.status === "done").length || 0;
    const statusTone = run?.status === "completed" ? "done"
      : run?.status === "failed" || run?.status === "cancelled" ? "failed"
        : ["awaiting_confirmation", "waiting_user", "paused"].includes(run?.status || "") ? "waiting"
          : run ? "running" : "";
    mission.innerHTML = run
      ? `<div class="agent-mission-state ${statusTone}"><i></i><b>${escapeHtml(agentRunStatusLabel(run.status))}</b><strong>${completed} / ${run.steps.length}</strong></div><div class="agent-mission-action">${escapeHtml(run.currentAction || run.stopReason || run.summary)}</div><div class="agent-mission-round">第 ${run.iteration} 轮 · 最多 ${run.maxIterations} 轮</div>`
      : `<div class="agent-mission-state"><i></i><b>等待任务</b><strong>0 / 0</strong></div>`;
  }
  renderOutreachSequences(run);
  renderCustomerMaintenanceWatches(run);
  renderAgentCheckpoints(run);
  renderAgentConversation();
  const backgroundStatus = qs<HTMLElement>("#agentBackgroundStatus");
  if (backgroundStatus) {
    const queued = run?.steps.filter((step) => step.status === "queued").length || 0;
    const running = run?.steps.filter((step) => step.status === "running").length || 0;
    backgroundStatus.textContent = running
      ? `${running} 个动作正在后台执行`
      : queued
        ? `${queued} 个动作正在等待后台执行`
        : "队列已就绪";
  }
  const approveAll = qs<HTMLButtonElement>("#agentApproveAllButton");
  if (approveAll) {
    const count = run?.steps.filter((step) => step.status === "needs_confirmation" && step.risk === "external").length || 0;
    approveAll.hidden = count < 2;
    approveAll.textContent = count ? `批准全部外部动作（${count}）` : "批准全部外部动作";
    approveAll.disabled = state.agentLoading;
  }
  const pauseButton = qs<HTMLButtonElement>("#agentPauseButton");
  const resumeButton = qs<HTMLButtonElement>("#agentResumeButton");
  const cancelButton = qs<HTMLButtonElement>("#agentCancelButton");
  if (pauseButton) {
    pauseButton.hidden = !run || !["planning", "running", "awaiting_confirmation"].includes(run.status);
    pauseButton.disabled = state.agentLoading;
  }
  if (resumeButton) {
    resumeButton.hidden = !run || !["paused", "waiting_user", "failed", "cancelled"].includes(run.status);
    resumeButton.disabled = state.agentLoading;
  }
  if (cancelButton) {
    cancelButton.hidden = !run || ["completed", "cancelled"].includes(run.status);
    cancelButton.disabled = state.agentLoading;
  }
  const list = qs<HTMLElement>("#agentStepList");
  if (list) {
    list.innerHTML = run?.steps.length
      ? run.steps.map((step, index) => {
          const controlsLocked = !run || ["paused", "waiting_user", "completed", "cancelled"].includes(run.status);
          const dependencies = step.dependsOn || [];
          const dependenciesReady = dependencies.every((key) => run.steps.some((candidate) => candidate.key === key && candidate.status === "done"));
          const dependencyText = dependencies.length
            ? `<div class="agent-step-tool">${dependenciesReady ? "前置结果已就绪" : "等待前置步骤"} · ${escapeHtml(dependencies.join("、"))}</div>`
            : "";
          const action = expired || controlsLocked || !dependenciesReady ? "" : step.status === "needs_confirmation" || (step.status === "failed" && step.risk === "external")
            ? `<button class="btn primary" type="button" data-agent-approve="${escapeHtml(step.id)}">${step.status === "failed" ? "确认重试" : "确认执行"}</button>`
            : step.status === "ready"
              ? `<button class="btn" type="button" data-agent-run="${escapeHtml(step.id)}">运行</button>`
              : step.status === "failed" && step.risk !== "external"
                ? `<button class="btn" type="button" data-agent-run="${escapeHtml(step.id)}">重试</button>`
                : "";
          const result = agentResultSummary(step.result);
          const traceDetail = agentStepTraceDetail(step, run);
          const exportDownload = agentExportDownload(step);
          const downloadAction = exportDownload ? `<button class="btn primary" type="button" data-agent-document-download="${escapeHtml(step.id)}">打开并下载</button>` : "";
          const approvalPreview = agentSequenceApprovalPreview(step);
          const maintenancePreview = agentMaintenanceApprovalPreview(step);
          const externalPreview = agentExternalApprovalPreview(step);
          return `<article class="agent-step agent-step-${step.status}">
            <span class="agent-step-index">${index + 1}</span>
            <div><div class="agent-step-title">${escapeHtml(step.title)}</div><div class="agent-step-tool">${escapeHtml(step.key || step.id)} · ${escapeHtml(step.tool)} · ${agentRiskLabel(step.risk)}</div><div class="agent-step-target">${escapeHtml(agentStepTarget(step))}</div>${dependencyText}${approvalPreview}${maintenancePreview}${externalPreview}<div class="agent-step-trace ${["failed", "skipped"].includes(step.status) ? "is-error" : ""}">${escapeHtml(traceDetail || result)}</div></div>
            <div class="agent-step-action"><span class="badge ${step.status === "done" ? "green" : step.status === "failed" ? "red" : step.status === "needs_confirmation" ? "amber" : ["queued", "running"].includes(step.status) ? "blue" : "gray"}">${!dependenciesReady && ["ready", "needs_confirmation"].includes(step.status) ? "等待前置步骤" : agentStepStatusLabel(step.status)}</span>${dependenciesReady ? downloadAction : ""}${action}</div>
          </article>`;
        }).join("")
      : `<div class="agent-empty">暂无行动步骤</div>`;
    qsa<HTMLButtonElement>("[data-agent-run]", list).forEach((button) => button.addEventListener("click", () => void executeAgentStepFromUi(button.dataset.agentRun || "", false)));
    qsa<HTMLButtonElement>("[data-agent-approve]", list).forEach((button) => button.addEventListener("click", () => void executeAgentStepFromUi(button.dataset.agentApprove || "", true)));
    qsa<HTMLButtonElement>("[data-agent-document-download]", list).forEach((button) => button.addEventListener("click", () => void openAgentExportDownload(button.dataset.agentDocumentDownload || "")));
  }
  const events = qs<HTMLElement>("#agentEventList");
  if (events) {
    const auditEvents = run?.events.filter((item) => item.type !== "assistant" && !item.message.startsWith("任务上下文：")) || [];
    events.innerHTML = auditEvents.length
      ? [...auditEvents].reverse().map((item) => `<div class="agent-event"><b>${escapeHtml(item.message)}</b><time>${new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>`).join("")
      : `<div class="agent-empty">暂无执行事件</div>`;
  }
  const history = qs<HTMLElement>("#agentRecentRuns");
  if (history) {
    history.innerHTML = state.agentRuns.length
      ? state.agentRuns.slice(0, 6).map((item) => {
          const itemExpired = new Date(item.expiresAt).getTime() <= Date.now();
          const active = run?.id === item.id ? " active" : "";
          return `<button type="button" class="agent-history-item${active}" data-agent-run-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.goal)}</span><small>${agentRunStatusLabel(itemExpired ? "expired" : item.status)} · ${new Date(item.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small></button>`;
        }).join("")
      : `<div class="agent-history-empty">暂无运行记录</div>`;
    qsa<HTMLButtonElement>("[data-agent-run-id]", history).forEach((button) => button.addEventListener("click", () => void loadAgentRun(button.dataset.agentRunId || "")));
  }
  run?.steps.forEach(applyAgentUiAction);
  syncAgentRunPolling(run);
}

export function salesDistillationMetricLabel(key: keyof SalesDistillationMetrics) {
  return ({
    customerCount: "客户",
    leadCount: "有效线索",
    activeDealCount: "活跃商机",
    wonDealCount: "成交商机",
    wonAmount: "成交金额",
    followupCount: "跟进记录",
    completedTodoCount: "完成待办",
    reportCount: "日报"
  } as Record<keyof SalesDistillationMetrics, string>)[key];
}

export async function loadAgentRuns() {
  try {
    const conversationId = ensureAgentConversationId();
    const [result, sequenceResult, maintenanceResult, playbookResult] = await Promise.all([
      api<{ runs: AgentRun[] }>(`/api/agent/runs?limit=50&conversationId=${encodeURIComponent(conversationId)}`),
      api<{ sequences: OutreachSequence[] }>("/api/agent/outreach-sequences?limit=20"),
      api<{ watches: CustomerMaintenanceWatch[] }>("/api/agent/customer-maintenance?limit=20"),
      api<{ distillations: SalesDistillation[]; activations: SalesPlaybookActivation[] }>("/api/agent/sales-distillation")
    ]);
    state.agentRuns = result.runs;
    state.outreachSequences = sequenceResult.sequences;
    state.customerMaintenanceWatches = maintenanceResult.watches;
    state.salesDistillations = playbookResult.distillations || [];
    state.salesPlaybookActivations = playbookResult.activations || [];
    state.agentRun = result.runs[0] || null;
    state.agentMissionCheckpoints = [];
    state.agentCheckpointRunId = "";
    renderAgent(state.agentRun);
    if (state.agentRun) void loadAgentCheckpoints(state.agentRun.id);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Agent 历史加载失败", "error");
  }
}

export async function loadAgentConversations() {
  try {
    const result = await api<{ conversations: AgentConversation[] }>("/api/agent/conversations?limit=30");
    state.agentConversations = result.conversations || [];
    renderAgentConversations();
  } catch (error) {
    toast(error instanceof Error ? error.message : "Agent 对话历史加载失败", "error");
  }
}

async function loadAgentRun(runId: string) {
  if (!runId || state.agentLoading) return;
  await refreshAgentRun(runId, false);
}

async function refreshAgentRun(runId: string, quiet: boolean) {
  if (!runId || (!quiet && state.agentLoading)) return;
  try {
    const [result, sequenceResult, maintenanceResult, playbookResult] = await Promise.all([
      api<{ run: AgentRun }>(`/api/agent/runs/${encodeURIComponent(runId)}`),
      api<{ sequences: OutreachSequence[] }>("/api/agent/outreach-sequences?limit=20"),
      api<{ watches: CustomerMaintenanceWatch[] }>("/api/agent/customer-maintenance?limit=20"),
      api<{ distillations: SalesDistillation[]; activations: SalesPlaybookActivation[] }>("/api/agent/sales-distillation")
    ]);
    state.agentRun = result.run;
    state.outreachSequences = sequenceResult.sequences;
    state.customerMaintenanceWatches = maintenanceResult.watches;
    state.salesDistillations = playbookResult.distillations || [];
    state.salesPlaybookActivations = playbookResult.activations || [];
    state.agentRuns = [result.run, ...state.agentRuns.filter((item) => item.id !== result.run.id)];
    renderAgent(result.run);
    void loadAgentCheckpoints(result.run.id);
  } catch (error) {
    if (!quiet) toast(error instanceof Error ? error.message : "Agent 运行记录加载失败", "error");
  }
}

async function controlOutreachSequenceFromUi(id: string, action: "pause" | "resume" | "cancel") {
  if (!id) return;
  try {
    const result = await api<{ sequence: OutreachSequence }>(`/api/agent/outreach-sequences/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    state.outreachSequences = [result.sequence, ...state.outreachSequences.filter((item) => item.id !== result.sequence.id)];
    renderOutreachSequences(state.agentRun);
    toast(action === "pause" ? "自动触达已暂停" : action === "resume" ? "自动触达已继续" : "自动触达已取消");
  } catch (error) {
    toast(error instanceof Error ? error.message : "自动触达控制失败", "error");
  }
}

async function controlCustomerMaintenanceFromUi(id: string, action: "pause" | "resume" | "cancel") {
  if (!id) return;
  try {
    const result = await api<{ watch: CustomerMaintenanceWatch }>(`/api/agent/customer-maintenance/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    state.customerMaintenanceWatches = [result.watch, ...state.customerMaintenanceWatches.filter((item) => item.id !== result.watch.id)];
    renderCustomerMaintenanceWatches(state.agentRun);
    toast(action === "pause" ? "客户守护已暂停" : action === "resume" ? "客户守护已继续" : "客户守护已取消");
  } catch (error) {
    toast(error instanceof Error ? error.message : "客户守护控制失败", "error");
  }
}

async function executeAgentStepFromUi(stepId: string, approved: boolean) {
  if (!state.agentRun || !stepId || state.agentLoading) return;
  const step = state.agentRun.steps.find((item) => item.id === stepId);
  if (!step) return;
  state.agentLoading = true;
  renderAgent(state.agentRun);
  try {
    const result = await api<{ run: AgentRun }>("/api/agent/execute", {
      method: "POST",
      body: JSON.stringify({ runId: state.agentRun.id, stepId, signature: step.signature, approved })
    });
    state.agentRun = result.run;
    state.agentRuns = [result.run, ...state.agentRuns.filter((item) => item.id !== result.run.id)];
    renderAgent(state.agentRun);
    void loadAgentCheckpoints(result.run.id);
    toast(result.run.steps.find((item) => item.id === stepId)?.status === "queued" ? "已批准，Agent 将在后台执行" : "Agent 步骤已完成");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Agent 步骤执行失败", "error");
  } finally {
    state.agentLoading = false;
    renderAgent(state.agentRun);
  }
}

export async function approveAllExternalAgentSteps() {
  const steps = state.agentRun?.steps.filter((step) => step.status === "needs_confirmation" && step.risk === "external") || [];
  if (!steps.length) return;
  const confirmed = await confirmAction({
    title: `批准 ${steps.length} 个外部动作`,
    message: "这些动作获批后将由 Agent 依次提交到外部系统。",
    detail: steps.map((step, index) => `${index + 1}. ${step.title}`).join("；"),
    detailLabel: "待批准动作",
    consequences: ["动作会按当前任务参数执行", "每个动作的执行结果会写入任务记录", "外部系统产生的变更可能需要单独撤回"],
    confirmLabel: `批准 ${steps.length} 个动作`,
    tone: "warning",
    verificationText: steps.length > 1 ? String(steps.length) : undefined
  });
  if (!confirmed) return;
  for (const step of steps) {
    await executeAgentStepFromUi(step.id, true);
  }
}

export async function controlAgentMission(action: "pause" | "resume" | "cancel", resumeMessage = "继续执行，保持原目标和完成标准") {
  if (!state.agentRun || state.agentLoading) return;
  state.agentLoading = true;
  renderAgent(state.agentRun);
  try {
    const result = await api<{ run: AgentRun }>(`/api/agent/missions/${encodeURIComponent(state.agentRun.id)}/${action}`, {
      method: "POST",
      body: action === "resume" ? JSON.stringify({ message: resumeMessage }) : undefined
    });
    state.agentRun = result.run;
    state.agentRuns = [result.run, ...state.agentRuns.filter((item) => item.id !== result.run.id)];
    void loadAgentCheckpoints(result.run.id);
    toast(action === "pause" ? "Mission 已暂停" : action === "resume" ? "Mission 已恢复" : "Mission 已取消");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Mission 控制失败", "error");
  } finally {
    state.agentLoading = false;
    renderAgent(state.agentRun);
  }
}

export async function createAgentPlan() {
  const input = qs<HTMLTextAreaElement>("#agentGoalInput");
  const goal = input?.value.trim() || "";
  if (goal.length < 2) {
    toast("请先输入 Agent 目标", "error");
    input?.focus();
    return;
  }
  const button = qs<HTMLButtonElement>("#agentPlanButton");
  state.agentLoading = true;
  agentPendingGoal = goal;
  agentPendingProgress = [{
    phase: "understanding",
    requestKind: "conversation",
    message: "正在理解你的目标和当前业务上下文",
    detail: "先判断你希望获取信息，还是让我直接完成一项工作"
  }];
  if (input) input.value = "";
  renderAgentConversation();
  if (button) { button.disabled = true; button.textContent = "思考中"; }
  try {
    const waitForPresentation = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
    let progressPresentation = waitForPresentation(360);
    const queuedProgress = new Set(agentPendingProgress.map((item) => `${item.phase}:${item.message}:${item.detail}`));
    const presentProgress = (progress: AgentPlanningProgress) => {
      const key = `${progress.phase}:${progress.message}:${progress.detail}`;
      if (queuedProgress.has(key)) return;
      queuedProgress.add(key);
      progressPresentation = progressPresentation.then(async () => {
        agentPendingProgress.push(progress);
        if (agentPendingProgress.length > 9) agentPendingProgress.splice(0, agentPendingProgress.length - 9);
        renderAgentConversation();
        await waitForPresentation(progress.phase === "ready" ? 160 : 340);
      });
    };
    const result = await streamAgentPlan(goal, {
      conversationId: ensureAgentConversationId(),
      activeView: agentOriginView,
      selectedCustomerId: state.selectedCustomerId || undefined,
      selectedLeadId: state.selectedLeadId || undefined,
      selectedCustomerIds: state.selectedCustomerIds
    }, presentProgress);
    await progressPresentation;
    agentPendingGoal = "";
    agentPendingProgress = [];
    state.agentRun = result.run;
    state.agentRuns = [result.run, ...state.agentRuns.filter((item) => item.id !== result.run.id)];
    state.agentMissionCheckpoints = [];
    state.agentCheckpointRunId = "";
    void loadAgentConversations();
    renderAgent(state.agentRun);
    void loadAgentCheckpoints(result.run.id);
    toast(result.run.status === "waiting_user" ? "Mission 等待你补充信息" : "Mission 已启动，将在后台持续执行");
  } catch (error) {
    agentPendingGoal = "";
    agentPendingProgress = [];
    if (input && !input.value) input.value = goal;
    toast(error instanceof Error ? error.message : "Agent 计划生成失败", "error");
  } finally {
    state.agentLoading = false;
    if (button) { button.disabled = false; button.textContent = "发送"; }
    renderAgent(state.agentRun);
  }
}

async function streamAgentPlan(
  goal: string,
  context: Record<string, unknown>,
  onProgress: (progress: AgentPlanningProgress) => void
): Promise<{ run: AgentRun }> {
  const csrfToken = cookieValue("gj_csrf");
  const response = await fetch("/api/agent/plan/stream", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
    },
    body: JSON.stringify({ goal, context })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: "Agent 任务理解失败" }));
    throw new Error(body.message || "Agent 任务理解失败");
  }
  if (!response.body) throw new Error("当前浏览器不支持 Agent 流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const streamState: { completed?: { run: AgentRun }; error?: string } = {};
  const consume = (block: string) => {
    const eventName = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const dataText = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!dataText) return;
    const payload = JSON.parse(dataText) as AgentPlanningProgress | { run: AgentRun } | { message: string };
    if (eventName === "progress") onProgress(payload as AgentPlanningProgress);
    if (eventName === "complete") streamState.completed = payload as { run: AgentRun };
    if (eventName === "error") streamState.error = (payload as { message: string }).message || "Agent 任务理解失败";
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/gu, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer.trim());
  if (streamState.error) throw new Error(streamState.error);
  if (!streamState.completed) throw new Error("Agent 流式响应未返回执行任务");
  return streamState.completed;
}

export function ensureUiLayer() {
  if (!qs(".toast-stack")) {
    document.body.insertAdjacentHTML("beforeend", `<div class="toast-stack" aria-live="polite"></div>`);
  }
  if (!qs("#appModal")) {
    document.body.insertAdjacentHTML("beforeend", `
      <div class="modal-backdrop" id="appModal" role="dialog" aria-modal="true">
        <div class="modal">
          <div class="modal-head"><div class="modal-heading"><span class="modal-heading-mark" aria-hidden="true"></span><div><h2 id="modalTitle">操作</h2><p id="modalDescription">填写信息后保存，随时可以关闭此窗口</p></div></div><button class="btn icon-only modal-close" data-modal-close title="关闭" aria-label="关闭弹窗">×</button></div>
          <div class="modal-body" id="modalBody"></div>
          <div class="modal-foot" id="modalFoot"></div>
        </div>
      </div>
    `);
    qs("[data-modal-close]")?.addEventListener("click", closeModal);
    qs<HTMLElement>("#appModal")?.addEventListener("mousedown", (event) => {
      if (modalCloseOnBackdrop && event.target === event.currentTarget) closeModal();
    });
  }
}
