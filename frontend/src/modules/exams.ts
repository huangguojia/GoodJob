/**
 * 在线考试与题库。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import * as XLSX from "xlsx";
import { type MysqlDumpPlan } from "../mysql-dump-import";
import { activateNavView, closeModal, confirmAction, openModal, state } from "../prototype-api";
import {
  type Exam, type ExamAssignment, type ExamAttempt, type ExamCandidate, type ExamImportQuestion, type ExamQuestion,
  type ExamReport
} from "./models";
import { renderDashboardKnowledgePanels } from "./dashboard";
import { type AppState, badge, escapeHtml, qs, qsa } from "./shared";
import { api, setButtonPending, toast } from "./ui";
import { assertImportFile } from "./trade-documents";
import { correctIndexesForQuestion, difficultyTone, examStatusText, examStatusTone, formatExamDate, questionTypeText } from "./kb-training";

let examTimerHandle: number | null = null;

function examRuntimeText(exam: Exam) {
  return ({ draft: "草稿", upcoming: "未开始", open: "进行中", expired: "已截止", closed: "已关闭" } as Record<string, string>)[exam.runtimeStatus || exam.status] || examStatusText(exam.status);
}

function examRuntimeTone(exam: Exam) {
  return ({ draft: "", upcoming: "amber", open: "green", expired: "red", closed: "red" } as Record<string, string>)[exam.runtimeStatus || exam.status] || examStatusTone(exam.status);
}

export function renderExams(exams: Exam[]) {
  const root = qs<HTMLElement>("#examWorkspace");
  if (!root) return;
  const canManage = state.examCanManage;
  if (!canManage) state.examWorkspaceMode = "mine";
  const mode = state.examWorkspaceMode;
  const activeExam = exams.find((item) => item.id === state.selectedExamId) || exams[0];
  state.selectedExamId = activeExam?.id || null;
  const tabs = canManage ? `<div class="exam-view-tabs" role="tablist"><button class="${mode === "manage" ? "active" : ""}" data-exam-mode="manage">考试管理</button><button class="${mode === "mine" ? "active" : ""}" data-exam-mode="mine">我的考试</button><button class="${mode === "results" ? "active" : ""}" data-exam-mode="results">成绩分析</button></div>` : "";
  const actions = canManage && mode === "manage" ? `<button class="btn" data-exam-bank>题库维护</button><button class="btn primary" data-exam-create>创建考试</button>` : "";
  root.innerHTML = `<div class="exam-workspace-head"><div><h1>${mode === "manage" ? "考试管理" : mode === "results" ? "成绩分析" : "我的考试"}</h1><span>${mode === "manage" ? "组卷、发布并跟踪团队考试" : mode === "results" ? "查看参考、通过与补考情况" : "查看分配给你的考试任务与成绩"}</span></div><div class="head-actions">${actions}</div></div>${tabs}<div id="examWorkspaceBody"></div>`;
  if (mode === "manage") renderExamManagement(exams, state.examReport);
  else if (mode === "results") renderExamResultsWorkspace(exams);
  else renderMyExams(exams);
  qsa<HTMLButtonElement>("[data-exam-mode]", root).forEach((button) => button.addEventListener("click", () => {
    state.examWorkspaceMode = (button.dataset.examMode || "mine") as AppState["examWorkspaceMode"];
    renderExams(state.exams);
  }));
  qs("[data-exam-bank]", root)?.addEventListener("click", () => void openQuestionBankPage());
  qs("[data-exam-create]", root)?.addEventListener("click", () => void openExamCreateModal());
}

function renderExamManagement(exams: Exam[], report: ExamReport | null) {
  const body = qs<HTMLElement>("#examWorkspaceBody");
  if (!body) return;
  const selected = exams.find((item) => item.id === state.selectedExamId) || exams[0];
  body.innerHTML = `<div class="exam-metric-strip"><div><span>草稿</span><b>${exams.filter((item) => item.runtimeStatus === "draft").length}</b></div><div><span>进行中</span><b>${exams.filter((item) => item.runtimeStatus === "open").length}</b></div><div><span>累计参考</span><b>${report?.totalAttempts || 0}</b></div><div><span>平均通过率</span><b>${report?.totalAttempts ? Math.round(((report.passedAttempts || 0) / report.totalAttempts) * 100) : 0}%</b></div></div><div class="exam-ops-layout"><section class="panel exam-list-panel"><div class="exam-table-head"><span>考试</span><span>发布规则</span><span>参考进度</span><span>状态</span><span></span></div><div class="exam-table-body">${exams.length ? exams.map((exam) => `<article class="exam-table-row ${exam.id === selected?.id ? "selected" : ""}" data-manage-exam="${escapeHtml(exam.id)}"><div><b>${escapeHtml(exam.title)}</b><span>${escapeHtml(exam.category)} · ${exam.questionCount} 题 · ${exam.passScore || 80} 分及格</span></div><div><b>${exam.durationMinutes || 20} 分钟</b><span>${formatExamDate(exam.startAt)} 至 ${formatExamDate(exam.endAt)}</span></div><div><b>${exam.completedCount || 0} / ${exam.assignedCount || 0}</b><span>${exam.assignedCount ? Math.round(((exam.completedCount || 0) / exam.assignedCount) * 100) : 0}% 已参考</span></div><div>${badge(examRuntimeText(exam), examRuntimeTone(exam))}</div><button class="exam-row-more" title="查看考试">›</button></article>`).join("") : `<div class="empty-state"><b>还没有考试</b><span>从题库选择题目创建第一场考试。</span></div>`}</div></section><aside class="panel exam-inspector" id="examInspector"></aside></div>`;
  qsa<HTMLElement>("[data-manage-exam]", body).forEach((row) => row.addEventListener("click", () => { state.selectedExamId = row.dataset.manageExam || null; renderExamManagement(state.exams, state.examReport); }));
  renderExamInspector(selected);
}

function renderExamInspector(exam?: Exam) {
  const panel = qs<HTMLElement>("#examInspector");
  if (!panel) return;
  if (!exam) return void (panel.innerHTML = `<div class="empty-state"><b>选择一场考试</b></div>`);
  panel.innerHTML = `<div class="exam-inspector-head"><div><span>${escapeHtml(exam.category)}</span><h2>${escapeHtml(exam.title)}</h2></div>${badge(examRuntimeText(exam), examRuntimeTone(exam))}</div><p class="exam-instructions">${escapeHtml(exam.instructions || "尚未填写考试说明")}</p><dl class="exam-rule-grid"><div><dt>题量</dt><dd>${exam.questionCount} 题</dd></div><div><dt>时长</dt><dd>${exam.durationMinutes || 20} 分钟</dd></div><div><dt>及格线</dt><dd>${exam.passScore || 80} 分</dd></div><div><dt>作答次数</dt><dd>${exam.maxAttempts || 1} 次</dd></div></dl><div class="exam-inspector-actions">${exam.runtimeStatus === "draft" || exam.runtimeStatus === "upcoming" ? `<button class="btn primary" data-publish-exam>发布配置</button>` : ""}${exam.runtimeStatus === "open" || exam.runtimeStatus === "upcoming" ? `<button class="btn" data-close-exam>关闭考试</button>` : ""}<button class="btn" data-view-results>查看成绩</button><button class="btn danger" data-delete-exam>删除</button></div>`;
  qs("[data-publish-exam]", panel)?.addEventListener("click", () => void publishExam(exam.id));
  qs("[data-close-exam]", panel)?.addEventListener("click", () => void closeExam(exam.id));
  qs("[data-view-results]", panel)?.addEventListener("click", () => { state.examWorkspaceMode = "results"; renderExams(state.exams); });
  qs("[data-delete-exam]", panel)?.addEventListener("click", () => void deleteExam(exam.id));
}

function renderMyExams(exams: Exam[]) {
  const body = qs<HTMLElement>("#examWorkspaceBody");
  if (!body) return;
  const mine = exams.filter((exam) => exam.assignment || !state.examCanManage);
  const pending = mine.filter((exam) => exam.runtimeStatus === "open" && exam.assignment?.status !== "passed");
  body.innerHTML = `<div class="exam-metric-strip candidate"><div><span>待完成</span><b>${pending.length}</b></div><div><span>进行中</span><b>${mine.filter((item) => item.assignment?.status === "in_progress").length}</b></div><div><span>已通过</span><b>${mine.filter((item) => item.assignment?.status === "passed").length}</b></div><div><span>个人最佳</span><b>${Math.max(0, ...mine.map((item) => item.bestScore || 0))}</b></div></div><section class="exam-candidate-section"><div class="exam-section-label"><h2>考试任务</h2><span>${pending.length} 场待处理</span></div><div class="exam-task-grid">${mine.length ? mine.map((exam) => {
    const status = exam.assignment?.status;
    const canStart = exam.runtimeStatus === "open" && status !== "passed" && (exam.attemptsUsed || 0) < (exam.maxAttempts || 1);
    const hasResult = status === "passed" || (exam.attemptsUsed || 0) > 0;
    const action = exam.inProgressAttemptId ? "继续考试" : canStart ? "开始考试" : hasResult ? "查看结果" : exam.runtimeStatus === "upcoming" ? "尚未开始" : "已结束";
    return `<article class="exam-task-card"><div class="exam-task-top"><span>${escapeHtml(exam.category)}</span>${badge(status === "passed" ? "已通过" : examRuntimeText(exam), status === "passed" ? "green" : examRuntimeTone(exam))}</div><h3>${escapeHtml(exam.title)}</h3><p>${escapeHtml(exam.instructions || "请在规定时间内完成考试。")}</p><div class="exam-task-facts"><span>${exam.questionCount} 题</span><span>${exam.durationMinutes || 20} 分钟</span><span>${exam.passScore || 80} 分及格</span><span>剩余 ${Math.max(0, (exam.maxAttempts || 1) - (exam.attemptsUsed || 0))} 次</span></div><div class="exam-task-deadline"><span>${exam.runtimeStatus === "upcoming" ? "开始" : "截止"}</span><b>${formatExamDate(exam.runtimeStatus === "upcoming" ? exam.startAt : exam.endAt)}</b></div><button class="btn ${canStart || exam.inProgressAttemptId ? "primary" : ""}" data-candidate-exam="${escapeHtml(exam.id)}" data-result-only="${hasResult && !canStart && !exam.inProgressAttemptId ? "true" : "false"}" ${!canStart && !exam.inProgressAttemptId && !hasResult ? "disabled" : ""}>${action}</button></article>`;
  }).join("") : `<div class="empty-state"><b>暂无考试任务</b><span>发布人指派考试后会显示在这里。</span></div>`}</div></section>`;
  qsa<HTMLButtonElement>("[data-candidate-exam]", body).forEach((button) => button.addEventListener("click", () => button.dataset.resultOnly === "true" ? void openExamResult(button.dataset.candidateExam || "") : void openExamModal(button.dataset.candidateExam || "")));
}

function renderExamResultsWorkspace(exams: Exam[]) {
  const body = qs<HTMLElement>("#examWorkspaceBody");
  if (!body) return;
  const selected = exams.find((item) => item.id === state.selectedExamId) || exams[0];
  body.innerHTML = `<div class="exam-results-layout"><aside class="panel exam-result-exams">${exams.map((exam) => `<button class="${exam.id === selected?.id ? "active" : ""}" data-result-exam="${escapeHtml(exam.id)}"><span>${escapeHtml(exam.title)}</span><small>${exam.completedCount || 0}/${exam.assignedCount || 0} 已参考</small></button>`).join("")}</aside><section class="panel exam-result-detail" id="examResultDetail"><div class="exam-workspace-loading"><b>成绩加载中</b></div></section></div>`;
  qsa<HTMLButtonElement>("[data-result-exam]", body).forEach((button) => button.addEventListener("click", () => { state.selectedExamId = button.dataset.resultExam || null; renderExamResultsWorkspace(state.exams); }));
  if (selected) void loadExamResults(selected.id);
}

async function loadExamResults(id: string) {
  const panel = qs<HTMLElement>("#examResultDetail");
  if (!panel) return;
  try {
    const result = await api<{ exam: Exam; assignments: Array<ExamAssignment & { userName: string; attempts: ExamAttempt[] }> }>(`/api/exams/${id}/results`);
    const passed = result.assignments.filter((item) => item.status === "passed").length;
    panel.innerHTML = `<div class="exam-result-head"><div><span>${escapeHtml(result.exam.category)}</span><h2>${escapeHtml(result.exam.title)}</h2></div><div><b>${result.assignments.length ? Math.round((passed / result.assignments.length) * 100) : 0}%</b><span>通过率</span></div></div><div class="exam-result-table"><div class="exam-result-row head"><span>成员</span><span>状态</span><span>次数</span><span>最高分</span><span>最近提交</span></div>${result.assignments.length ? result.assignments.map((item) => `<div class="exam-result-row"><b>${escapeHtml(item.userName)}</b><span>${badge(item.status === "passed" ? "已通过" : item.status === "pending" ? "未参考" : item.status === "in_progress" ? "答题中" : "未通过", item.status === "passed" ? "green" : item.status === "failed" ? "red" : "")}</span><span>${item.attemptCount}</span><strong>${item.bestScore}</strong><span>${formatExamDate(item.attempts[0]?.submittedAt)}</span></div>`).join("") : `<div class="empty-state"><b>尚未指派考生</b></div>`}</div>`;
  } catch (error) {
    panel.innerHTML = `<div class="empty-state"><b>成绩加载失败</b><span>${escapeHtml(error instanceof Error ? error.message : "请稍后重试")}</span></div>`;
  }
}

async function renderExamPreview(exam?: Exam) {
  const paper = qs<HTMLElement>("#exam .exam-grid > .panel .exam-paper");
  const headBadge = qs<HTMLElement>("#exam .exam-grid > .panel .section-head .badge");
  const progressPanel = qs<HTMLElement>("#exam .exam-sidebar .panel:first-child");
  if (!paper) return;
  if (!exam) {
    paper.innerHTML = `<div class="empty-state"><b>暂无考试预览</b><span>创建考试后这里会展示真实题目。</span></div>`;
    return;
  }
  try {
    const detail = await api<{ exam: Exam; questions: ExamQuestion[]; latestAttempt: ExamAttempt | null; report: ExamReport }>(`/api/exams/${exam.id}/detail`);
    Object.assign(exam, detail.exam);
    state.examReport = detail.report;
    const answered = detail.latestAttempt?.totalQuestions || 0;
    const correct = detail.latestAttempt?.correctCount || 0;
    if (headBadge) headBadge.textContent = `${detail.exam.durationMinutes || 20} 分钟 · ${detail.exam.passScore || 80} 分及格`;
    paper.innerHTML = detail.questions.length ? detail.questions.slice(0, 4).map((question, index) => `
      <div class="question-card" data-preview-question="${escapeHtml(question.id)}">
        <div class="question-meta"><span>${escapeHtml(question.category)} · ${questionTypeText(question)}</span>${badge(question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用", difficultyTone(question.difficulty))}</div>
        <h3>${index + 1}. ${escapeHtml(question.stem)}</h3>
        <div class="option-row">${question.options.map((option, optionIndex) => `<span class="${correctIndexesForQuestion(question).includes(optionIndex) ? "active" : ""}">${String.fromCharCode(65 + optionIndex)}. ${escapeHtml(option)}</span>`).join("")}</div>
      </div>`).join("") : `<div class="empty-state"><b>题库为空</b></div>`;
    if (progressPanel) {
      progressPanel.innerHTML = `
        <div class="progress-ring" style="background:conic-gradient(var(--brand) 0 ${detail.exam.passRate}%, #e7edf6 ${detail.exam.passRate}% 100%)"><b>${detail.exam.passRate}%</b></div>
        <div class="section-head"><div class="section-title"><div><h2>考试进度</h2><span>${escapeHtml(detail.exam.title)}</span></div></div>${badge(`${detail.exam.questionCount} 题`, "")}</div>
        <table class="mini-table"><tbody><tr><td>最近已答</td><td>${answered}/${detail.exam.questionCount}</td></tr><tr><td>最近正确</td><td>${correct}</td></tr><tr><td>及格线</td><td>${detail.exam.passScore || 80} 分</td></tr><tr><td>最近成绩</td><td>${detail.latestAttempt ? `${detail.latestAttempt.score} 分` : "未参加"}</td></tr></tbody></table>`;
    }
  } catch (error) {
    paper.innerHTML = `<div class="empty-state"><b>考试预览加载失败</b><span>${escapeHtml(error instanceof Error ? error.message : "请稍后重试")}</span></div>`;
  }
}

function renderExamReport() {
  const report = state.examReport;
  const sections = qsa<HTMLElement>("#exam .matrix-grid .panel");
  if (!report || sections.length < 3) return;
  const [stats, retakes, types] = sections;
  const statBody = qs<HTMLElement>("tbody", stats);
  if (statBody) {
    statBody.innerHTML = report.categoryRows.length ? report.categoryRows.slice(0, 5).map((row) => `<tr><td>${escapeHtml(row.title)}</td><td>${row.participants}</td><td>${row.passRate}%</td><td>${row.avgScore}</td></tr>`).join("") : `<tr><td colspan="4">暂无成绩记录</td></tr>`;
  }
  const retakeBody = qs<HTMLElement>("tbody", retakes);
  if (retakeBody) {
    const rows = report.latestAttempts.filter((item) => !item.passed).slice(0, 5);
    retakeBody.innerHTML = rows.length ? rows.map((attempt) => `<tr><td>${escapeHtml(attempt.userName || "未知")}</td><td>${escapeHtml(attempt.category || "未分类")}</td><td>${badge(`${attempt.score} 分 · 待补考`, "red")}</td></tr>`).join("") : `<tr><td colspan="3">暂无补考人员</td></tr>`;
  }
  const typeBody = qs<HTMLElement>("tbody", types);
  if (typeBody) {
    typeBody.innerHTML = report.difficultyRows.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${row.count}</td><td>${row.ratio}%</td></tr>`).join("");
  }
}

function examAnswersFromUi() {
  const answers: Record<string, number | number[]> = {};
  qsa<HTMLElement>("#appModal [data-question]").forEach((question) => {
    const row = qs<HTMLElement>(".exam-answer-options", question);
    const active = qsa<HTMLElement>("[data-option-index].active", question);
    if (!active.length) return;
    const selected = active.map((item) => Number(item.dataset.optionIndex || 0));
    answers[question.dataset.question || ""] = row?.dataset.questionType === "multiple" ? selected : selected[0];
  });
  return answers;
}

function refreshExamTakingProgress() {
  const questions = qsa<HTMLElement>("#appModal [data-question]");
  const answered = questions.filter((item) => qsa("[data-option-index].active", item).length > 0).length;
  const value = qs<HTMLElement>("#examAnsweredCount");
  const fill = qs<HTMLElement>("#examAnswerProgress");
  if (value) value.textContent = `${answered} / ${questions.length}`;
  if (fill) fill.style.width = `${Math.round((answered / Math.max(questions.length, 1)) * 100)}%`;
  questions.forEach((question, index) => qs<HTMLElement>(`[data-exam-nav="${CSS.escape(question.dataset.question || "")}"]`)?.classList.toggle("answered", qsa("[data-option-index].active", question).length > 0));
}

async function openExamModal(id: string) {
  try {
    const result = await api<{ exam: Exam; attempt: ExamAttempt; questions: ExamQuestion[]; resumed: boolean }>(`/api/exams/${id}/start`, { method: "POST", body: "{}" });
    const answers = { ...result.attempt.answers };
    openModal(result.exam.title, `<div class="exam-taking-shell"><header class="exam-taking-head"><div><span>${escapeHtml(result.exam.category)}</span><b>${result.questions.length} 题 · ${result.exam.passScore || 80} 分及格</b></div><div class="exam-save-state" id="examSaveState">${result.resumed ? "已恢复上次进度" : "答案自动保存"}</div><div class="exam-countdown"><span>剩余时间</span><b id="examCountdown">--:--</b></div></header><div class="exam-taking-layout"><aside class="exam-question-nav"><div><span>答题进度</span><b id="examAnsweredCount">0 / ${result.questions.length}</b></div><div class="exam-answer-track"><i id="examAnswerProgress"></i></div><div class="exam-nav-grid">${result.questions.map((question, index) => `<button data-exam-nav="${escapeHtml(question.id)}">${index + 1}</button>`).join("")}</div><small>答案变更后自动保存</small></aside><main class="exam-question-stage">${result.questions.map((question, index) => {
      const selectedRaw = answers[question.id];
      const selected = Array.isArray(selectedRaw) ? selectedRaw : selectedRaw == null ? [] : [selectedRaw];
      const type = question.questionType || "single";
      return `<section class="exam-live-question" data-question="${escapeHtml(question.id)}"><div class="exam-live-meta"><span>第 ${index + 1} 题 / 共 ${result.questions.length} 题</span>${badge(questionTypeText(question), type === "multiple" ? "amber" : "")}</div><h2>${escapeHtml(question.stem)}</h2><div class="exam-answer-options" data-question-type="${type}">${question.options.map((option, optionIndex) => `<button type="button" class="${selected.includes(optionIndex) ? "active" : ""}" data-option-index="${optionIndex}"><i>${String.fromCharCode(65 + optionIndex)}</i><span>${escapeHtml(option)}</span></button>`).join("")}</div></section>`;
    }).join("")}</main></div></div>`, `<button class="btn" data-modal-close>暂时离开</button><button class="btn primary" id="submitExamButton">确认交卷</button>`, { closeOnBackdrop: false });
    const modal = qs<HTMLElement>("#appModal .modal");
    modal?.classList.add("exam-taking-modal");
    const modalBody = qs<HTMLElement>("#appModal .modal-body");
    if (modalBody) modalBody.scrollTop = 0;
    let saveTimer: number | null = null;
    const saveAnswers = async () => {
      const saveState = qs<HTMLElement>("#examSaveState");
      try {
        if (saveState) saveState.textContent = "保存中";
        await api(`/api/exam-attempts/${result.attempt.id}/answers`, { method: "PATCH", body: JSON.stringify({ answers: examAnswersFromUi() }) });
        if (saveState) saveState.textContent = `已保存 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`;
      } catch (error) {
        if (saveState) saveState.textContent = "保存失败，请重试";
        toast(error instanceof Error ? error.message : "答案保存失败", "error");
      }
    };
    qsa<HTMLButtonElement>("#appModal .exam-answer-options [data-option-index]").forEach((option) => option.addEventListener("click", () => {
      const row = option.closest<HTMLElement>(".exam-answer-options")!;
      if (row.dataset.questionType === "multiple") option.classList.toggle("active");
      else {
        qsa<HTMLElement>("[data-option-index]", row).forEach((item) => item.classList.remove("active"));
        option.classList.add("active");
      }
      if (modalBody) modalBody.scrollTop = 0;
      refreshExamTakingProgress();
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void saveAnswers(), 450);
    }));
    const questionStage = qs<HTMLElement>(".exam-question-stage");
    qsa<HTMLButtonElement>("[data-exam-nav]").forEach((button) => button.addEventListener("click", () => {
      const target = qs<HTMLElement>(`[data-question="${CSS.escape(button.dataset.examNav || "")}"]`);
      if (target && questionStage) questionStage.scrollTo({ top: Math.max(0, target.offsetTop - 16), behavior: "smooth" });
    }));
    refreshExamTakingProgress();
    if (examTimerHandle) window.clearInterval(examTimerHandle);
    const updateTimer = () => {
      const node = qs<HTMLElement>("#examCountdown");
      if (!node) {
        if (examTimerHandle) window.clearInterval(examTimerHandle);
        examTimerHandle = null;
        return;
      }
      const remaining = Math.max(0, new Date(result.attempt.expiresAt || "").getTime() - Date.now());
      const minutes = Math.floor(remaining / 60_000);
      const seconds = Math.floor((remaining % 60_000) / 1000);
      node.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      node.classList.toggle("urgent", remaining <= 5 * 60_000);
      if (remaining <= 0) void submitExam(result.attempt.id, true);
    };
    updateTimer();
    examTimerHandle = window.setInterval(updateTimer, 1000);
    qs("#submitExamButton")?.addEventListener("click", () => void submitExam(result.attempt.id));
  } catch (error) {
    toast(error instanceof Error ? error.message : "无法开始考试", "error");
    if (/最大作答次数|已经交卷/.test(error instanceof Error ? error.message : "")) void openExamResult(id);
  }
}

async function submitExam(attemptId: string, automatic = false) {
  const answers = examAnswersFromUi();
  const total = qsa<HTMLElement>("#appModal [data-question]").length;
  const unanswered = Math.max(0, total - Object.keys(answers).length);
  if (!automatic && !window.confirm(unanswered ? `还有 ${unanswered} 题未作答，仍要交卷吗？` : "确认提交试卷吗？提交后本次作答不能修改。")) return;
  const button = qs<HTMLButtonElement>("#submitExamButton");
  if (button) { button.disabled = true; button.textContent = automatic ? "超时交卷中" : "交卷中"; }
  try {
    const result = await api<{ attempt: ExamAttempt; exam: Exam; report: ExamReport; canReview: boolean }>(`/api/exam-attempts/${attemptId}/submit`, { method: "POST", body: JSON.stringify({ answers }) });
    if (examTimerHandle) window.clearInterval(examTimerHandle);
    examTimerHandle = null;
    state.examReport = result.report;
    await refreshExamData();
    closeModal();
    openExamScoreResult(result.attempt, result.exam, result.canReview);
  } catch (error) {
    toast(error instanceof Error ? error.message : "交卷失败", "error");
    if (button) { button.disabled = false; button.textContent = "确认交卷"; }
  }
}

function openExamScoreResult(attempt: ExamAttempt, exam: Exam, canReview: boolean) {
  openModal("考试结果", `<div class="exam-score-result ${attempt.passed ? "passed" : "failed"}"><div class="exam-score-ring"><b>${attempt.score}</b><span>分</span></div><div><span>${attempt.passed ? "考试通过" : "暂未通过"}</span><h2>${escapeHtml(exam.title)}</h2><p>答对 ${attempt.correctCount} / ${attempt.totalQuestions} 题 · 及格线 ${exam.passScore || 80} 分</p>${canReview ? `<small>本场考试允许查看答案解析，可在“我的考试”中打开结果。</small>` : `<small>本场考试暂不开放标准答案与解析。</small>`}</div></div>`, `<button class="btn primary" data-modal-close>完成</button>`);
}

async function openExamResult(id: string) {
  try {
    const detail = await api<{ exam: Exam; questions: ExamQuestion[]; latestAttempt: ExamAttempt | null; canReview: boolean }>(`/api/exams/${id}/detail`);
    if (!detail.latestAttempt || detail.latestAttempt.status === "in_progress") return void openExamModal(id);
    const attempt = detail.latestAttempt;
    openModal(`${detail.exam.title} · 考试结果`, `<div class="exam-review-summary"><div class="exam-score-ring"><b>${attempt.score}</b><span>分</span></div><div><h2>${attempt.passed ? "已通过" : "未通过"}</h2><p>答对 ${attempt.correctCount} / ${attempt.totalQuestions} 题 · ${formatExamDate(attempt.submittedAt)} 提交</p></div></div>${detail.canReview ? `<div class="exam-review-list">${detail.questions.map((question, index) => {
      const raw = attempt.answers[question.id];
      const selected = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      return `<article><span>第 ${index + 1} 题</span><h3>${escapeHtml(question.stem)}</h3><p>你的答案：${selected.length ? selected.map((item) => String.fromCharCode(65 + item)).join("、") : "未作答"} · 正确答案：${correctIndexesForQuestion(question).map((item) => String.fromCharCode(65 + item)).join("、")}</p><small>${escapeHtml(question.explanation)}</small></article>`;
    }).join("")}</div>` : `<div class="exam-review-locked"><b>答案解析暂未开放</b><span>发布人关闭考试或开启交卷后复盘后可查看。</span></div>`}`, `<button class="btn primary" data-modal-close>关闭</button>`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "结果加载失败", "error");
  }
}

async function closeExam(id: string) {
  const exam = state.exams.find((item) => item.id === id);
  if (!exam || !await confirmAction({ title: "关闭考试", message: `关闭「${exam.title}」后将不再允许开考。`, consequences: ["进行中的作答将按已保存答案自动交卷", "成绩与指派记录会保留"], confirmLabel: "关闭考试", tone: "warning" })) return;
  try {
    await api(`/api/exams/${id}/close`, { method: "PATCH", body: "{}" });
    await refreshExamData();
    toast("考试已关闭");
  } catch (error) {
    toast(error instanceof Error ? error.message : "关闭考试失败", "error");
  }
}

async function submitExamLegacy(id: string) {
  const answers: Record<string, number | number[]> = {};
  qsa<HTMLElement>("#appModal [data-question]").forEach((question) => {
    const optionRow = qs<HTMLElement>(".option-row", question);
    const active = qsa<HTMLElement>(".option-row span.active", question);
    if (!active.length) return;
    const selected = active.map((item) => Number(item.dataset.optionIndex || 0));
    answers[question.dataset.question || ""] = optionRow?.dataset.questionType === "multiple" ? selected : selected[0];
  });
  const total = qsa<HTMLElement>("#appModal [data-question]").length;
  if (Object.keys(answers).length < total) {
    toast("还有题目未作答", "error");
    return;
  }
  const result = await api<{ attempt: ExamAttempt; exam: Exam; report: ExamReport }>(`/api/exams/${id}/submit`, {
    method: "POST",
    body: JSON.stringify({ answers })
  });
  const exam = state.exams.find((item) => item.id === id);
  if (exam) Object.assign(exam, result.exam);
  state.examReport = result.report;
  renderExams(state.exams);
  closeModal();
  toast(`交卷成功：${result.attempt.score} 分，${result.attempt.passed ? "已通过" : "需补考"}`);
}

function examDateTimeInput(value?: string, fallbackHours = 0) {
  const date = value ? new Date(value) : new Date(Date.now() + fallbackHours * 60 * 60 * 1000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

async function publishExam(id: string) {
  const exam = state.exams.find((item) => item.id === id);
  if (!exam) return;
  const candidates = state.examCandidates;
  openModal("发布考试", `<div class="exam-publish-layout"><section><div class="exam-publish-paper"><span>${escapeHtml(exam.category)}</span><h2>${escapeHtml(exam.title)}</h2><p>${exam.questionCount} 题 · ${exam.durationMinutes || 20} 分钟 · ${exam.passScore || 80} 分及格</p></div><div class="form-grid"><div class="form-field full"><label>考试说明</label><textarea id="examPublishInstructions" rows="3">${escapeHtml(exam.instructions || "请在规定时间内独立完成考试。")}</textarea></div><div class="form-field"><label>开始时间</label><input type="datetime-local" id="examPublishStart" value="${examDateTimeInput(exam.startAt)}"></div><div class="form-field"><label>截止时间</label><input type="datetime-local" id="examPublishEnd" value="${examDateTimeInput(exam.endAt, 168)}"></div><div class="form-field"><label>答题时长（分钟）</label><input type="number" min="1" max="240" id="examPublishDuration" value="${exam.durationMinutes || 20}"></div><div class="form-field"><label>及格分</label><input type="number" min="1" max="100" id="examPublishPass" value="${exam.passScore || 80}"></div><div class="form-field"><label>最多作答次数</label><input type="number" min="1" max="10" id="examPublishAttempts" value="${exam.maxAttempts || 1}"></div><label class="exam-review-toggle"><input type="checkbox" id="examPublishReview" ${exam.allowReview ? "checked" : ""}><span><b>交卷后开放答案解析</b><small>考试仍在进行时也会显示标准答案，请谨慎开启</small></span></label></div></section><aside class="exam-assignee-picker"><div><h3>选择考生</h3><button class="btn" type="button" id="examSelectAllCandidates">全选</button></div><span>发布时固定应考名单，后续新成员不会自动加入。</span><div>${candidates.length ? candidates.map((candidate) => `<label><input type="checkbox" data-exam-candidate="${escapeHtml(candidate.id)}" checked><i>${escapeHtml(candidate.avatar || candidate.name.slice(0, 2))}</i><span><b>${escapeHtml(candidate.name)}</b><small>${candidate.role === "manager" ? "经理" : candidate.role === "admin" ? "管理员" : "业务员"}</small></span></label>`).join("") : `<div class="empty-state"><b>没有可指派成员</b></div>`}</div></aside></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmPublishExam" ${candidates.length ? "" : "disabled"}>确认发布</button>`);
  qs("#examSelectAllCandidates")?.addEventListener("click", () => {
    const boxes = qsa<HTMLInputElement>("[data-exam-candidate]");
    const shouldCheck = boxes.some((item) => !item.checked);
    boxes.forEach((item) => { item.checked = shouldCheck; });
  });
  qs<HTMLButtonElement>("#confirmPublishExam")?.addEventListener("click", async () => {
    const button = qs<HTMLButtonElement>("#confirmPublishExam")!;
    const assigneeIds = qsa<HTMLInputElement>("[data-exam-candidate]:checked").map((item) => item.dataset.examCandidate || "").filter(Boolean);
    if (!assigneeIds.length) return void toast("请至少选择 1 名考生", "error");
    const startValue = qs<HTMLInputElement>("#examPublishStart")?.value || "";
    const endValue = qs<HTMLInputElement>("#examPublishEnd")?.value || "";
    try {
      button.disabled = true;
      button.textContent = "发布中";
      await api(`/api/exams/${id}/publish`, { method: "PATCH", body: JSON.stringify({
        assigneeIds,
        startAt: new Date(startValue).toISOString(),
        endAt: new Date(endValue).toISOString(),
        durationMinutes: Number(qs<HTMLInputElement>("#examPublishDuration")?.value || 20),
        passScore: Number(qs<HTMLInputElement>("#examPublishPass")?.value || 80),
        maxAttempts: Number(qs<HTMLInputElement>("#examPublishAttempts")?.value || 1),
        allowReview: Boolean(qs<HTMLInputElement>("#examPublishReview")?.checked),
        instructions: qs<HTMLTextAreaElement>("#examPublishInstructions")?.value.trim() || ""
      }) });
      closeModal();
      await refreshExamData();
      toast("考试已发布并完成考生指派");
    } catch (error) {
      button.disabled = false;
      button.textContent = "确认发布";
      toast(error instanceof Error ? error.message : "发布失败", "error");
    }
  });
}

async function deleteExam(id: string) {
  const exam = state.exams.find((item) => item.id === id);
  if (!exam) return;
  if (!await confirmAction({
    title: "删除考试",
    message: `将删除「${exam.title}」。`,
    consequences: ["该考试的组卷关系会被清理", "已有考试成绩记录会同步删除"],
    confirmLabel: "删除考试"
  })) return;
  const deleteButton = qs<HTMLButtonElement>(`#exam [data-exam-id="${CSS.escape(id)}"] [data-delete-exam]`);
  try {
    if (deleteButton) {
      deleteButton.disabled = true;
      deleteButton.textContent = "删除中";
    }
    const result = await api<{ exam: Exam; exams: Exam[]; report: ExamReport }>(`/api/exams/${id}`, { method: "DELETE" });
    state.exams = result.exams;
    state.examReport = result.report;
    state.selectedExamIds = state.selectedExamIds.filter((selectedId) => selectedId !== id);
    state.selectedExamId = state.exams[0]?.id || null;
    renderExams(state.exams);
    renderDashboardKnowledgePanels();
    toast(`考试已删除：${result.exam.title}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除考试失败", "error");
  } finally {
    if (deleteButton) {
      deleteButton.disabled = false;
      deleteButton.textContent = "删除";
    }
  }
}

async function bulkDeleteExams() {
  const ids = state.selectedExamIds.filter((id) => state.exams.some((exam) => exam.id === id));
  if (!ids.length) {
    toast("请先勾选要删除的考试", "error");
    return;
  }
  const titles = state.exams.filter((exam) => ids.includes(exam.id)).map((exam) => exam.title);
  if (!await confirmAction({
    title: `批量删除 ${ids.length} 场考试`,
    message: "这是一项不可恢复的批量操作。",
    detail: `${titles.slice(0, 5).join("、")}${titles.length > 5 ? `等 ${ids.length} 场` : ""}`,
    consequences: ["相关组卷关系会被清理", "已有考试成绩记录会同步删除"],
    confirmLabel: `删除 ${ids.length} 场考试`,
    verificationText: String(ids.length)
  })) return;
  const button = qs<HTMLButtonElement>("#exam [data-bulk-delete-exams]");
  try {
    setButtonPending(button, true, "批量删除", `正在删除 ${ids.length} 场`);
    const result = await api<{ deleted: Exam[]; exams: Exam[]; report: ExamReport }>("/api/exams/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
    state.exams = result.exams;
    state.examReport = result.report;
    state.selectedExamIds = [];
    state.selectedExamId = state.exams.find((exam) => exam.id === state.selectedExamId)?.id || state.exams[0]?.id || null;
    renderExams(state.exams);
    renderDashboardKnowledgePanels();
    toast(`已批量删除 ${result.deleted.length} 场考试`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "批量删除考试失败", "error");
  } finally {
    setButtonPending(button, false, "批量删除", "删除中");
  }
}

function questionTagsText(question: ExamQuestion) {
  return (question.tags || []).join("、") || "未打标签";
}

function selectedQuestionIdsFromModal() {
  return qsa<HTMLInputElement>("#examQuestionPicker input[data-question-id]:checked").map((input) => input.dataset.questionId || "").filter(Boolean);
}

function updateExamCreateSelectionSummary() {
  const summary = qs<HTMLElement>("#examCreateSelectionSummary");
  if (!summary) return;
  const ids = selectedQuestionIdsFromModal();
  const selected = state.examQuestions.filter((question) => ids.includes(question.id));
  const multiple = selected.filter((question) => questionTypeText(question) === "多选").length;
  const hard = selected.filter((question) => question.difficulty === "hard").length;
  summary.innerHTML = `已选 <b>${selected.length}</b> 题 · 多选 ${multiple} 题 · 高阶 ${hard} 题`;
}

function renderExamQuestionPicker(filterCategory = "") {
  const picker = qs<HTMLElement>("#examQuestionPicker");
  if (!picker) return;
  const questions = filterCategory ? state.examQuestions.filter((question) => question.category === filterCategory) : state.examQuestions;
  picker.innerHTML = questions.length ? questions.map((question) => `
    <label class="exam-bank-row">
      <input type="checkbox" data-question-id="${escapeHtml(question.id)}">
      <span><b>${escapeHtml(question.stem)}</b><small>${escapeHtml(question.category)} · ${questionTypeText(question)} · ${escapeHtml(questionTagsText(question))}</small></span>
      ${badge(question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用", difficultyTone(question.difficulty))}
    </label>`).join("") : `<div class="empty-state"><b>当前筛选下没有题目</b></div>`;
  qsa<HTMLInputElement>("input[data-question-id]", picker).forEach((input) => input.addEventListener("change", updateExamCreateSelectionSummary));
  updateExamCreateSelectionSummary();
}

async function ensureExamQuestionsLoaded() {
  const result = await api<{ questions: ExamQuestion[]; report: ExamReport }>("/api/exam-questions");
  state.examQuestions = result.questions;
  state.examReport = result.report;
  return result.questions;
}

export async function openExamCreateModal(category = "产品知识") {
  await ensureExamQuestionsLoaded();
  const categories = Array.from(new Set([...state.examQuestions.map((question) => question.category), category, "产品知识", "认证资料", "报价规则"]));
  openModal("创建考试草稿", `
    <div class="form-grid exam-create-grid">
      <div class="form-field full"><label>考试名称</label><input id="examTitleInput" value="${escapeHtml(category)}新品知识抽考"></div>
      <div class="form-field"><label>类目</label><select id="examCategoryInput">${categories.map((item) => `<option ${item === category ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></div>
      <div class="form-field"><label>考试时长</label><input id="examDurationInput" type="number" value="20" min="5" max="180"></div>
      <div class="form-field"><label>及格分</label><input id="examPassInput" type="number" value="80" min="1" max="100"></div>
      <div class="form-field full"><label>考试说明</label><textarea id="examInstructionsInput" rows="2">请在规定时间内独立完成考试。</textarea></div>
      <div class="form-field full"><label>从基础题库勾选试题</label><div class="exam-bank-toolbar"><span id="examCreateSelectionSummary">已选 0 题</span><button class="btn" type="button" id="selectCategoryQuestionsButton">选中当前类目</button></div><div class="exam-bank-list" id="examQuestionPicker"></div></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveExamButton">保存草稿</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  renderExamQuestionPicker(category);
  qs<HTMLSelectElement>("#examCategoryInput")?.addEventListener("change", (event) => renderExamQuestionPicker((event.currentTarget as HTMLSelectElement).value));
  qs<HTMLButtonElement>("#selectCategoryQuestionsButton")?.addEventListener("click", () => {
    qsa<HTMLInputElement>("#examQuestionPicker input[data-question-id]").forEach((input) => { input.checked = true; });
    updateExamCreateSelectionSummary();
  });
  qs("#saveExamButton")?.addEventListener("click", (event) => void saveExam(event.currentTarget as HTMLButtonElement));
}

async function saveExam(button?: HTMLButtonElement) {
  const title = qs<HTMLInputElement>("#examTitleInput")?.value.trim() || "";
  const questionIds = selectedQuestionIdsFromModal();
  if (!title) {
    toast("请填写考试名称", "error");
    return;
  }
  if (!questionIds.length) {
    toast("请至少勾选 1 道题目", "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "创建中";
    }
    const result = await api<{ exam: Exam; questions: ExamQuestion[]; report: ExamReport }>("/api/exams", {
      method: "POST",
      body: JSON.stringify({
        title,
        category: qs<HTMLSelectElement>("#examCategoryInput")?.value || "产品知识",
        questionIds,
        durationMinutes: Number(qs<HTMLInputElement>("#examDurationInput")?.value || 20),
        passScore: Number(qs<HTMLInputElement>("#examPassInput")?.value || 80),
        targetRole: "all",
        instructions: qs<HTMLTextAreaElement>("#examInstructionsInput")?.value.trim() || ""
      })
    });
    state.exams.unshift(result.exam);
    state.selectedExamId = result.exam.id;
    state.examReport = result.report;
    await refreshExamData();
    closeModal();
    toast(`考试草稿已保存，已组卷 ${result.questions.length} 道题`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "创建考试失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "保存草稿";
    }
  }
}

function questionBankCategories() {
  return Array.from(new Set([...state.examQuestions.map((question) => question.category), "产品知识", "认证资料", "报价规则"])).filter(Boolean);
}

function refreshQuestionBankCategoryOptions() {
  const categories = questionBankCategories();
  const filter = qs<HTMLSelectElement>("#questionBankCategoryFilter");
  const editor = qs<HTMLSelectElement>("#questionCategoryInput");
  const currentFilter = filter?.value || "";
  const currentEditor = editor?.value || "";
  if (filter) {
    filter.innerHTML = `<option value="">全部类目</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`;
    filter.value = categories.includes(currentFilter) ? currentFilter : "";
  }
  if (editor) {
    editor.innerHTML = categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
    editor.value = categories.includes(currentEditor) ? currentEditor : categories[0] || "产品知识";
  }
}

function filteredQuestionBankRows() {
  const category = qs<HTMLSelectElement>("#questionBankCategoryFilter")?.value || "";
  const type = qs<HTMLSelectElement>("#questionBankTypeFilter")?.value || "";
  const keyword = qs<HTMLInputElement>("#questionBankSearchInput")?.value.trim().toLowerCase() || "";
  return state.examQuestions.filter((question) => {
    const matchesCategory = !category || question.category === category;
    const matchesType = !type || (question.questionType || (correctIndexesForQuestion(question).length > 1 ? "multiple" : "single")) === type;
    const haystack = `${question.stem} ${question.category} ${questionTagsText(question)} ${question.options.join(" ")}`.toLowerCase();
    return matchesCategory && matchesType && (!keyword || haystack.includes(keyword));
  });
}

function renderQuestionBankStats() {
  const total = state.examQuestions.length;
  const multi = state.examQuestions.filter((question) => questionTypeText(question) === "多选").length;
  const categories = questionBankCategories().filter((category) => state.examQuestions.some((question) => question.category === category));
  const selected = state.examQuestions.find((question) => question.id === state.selectedQuestionId);
  const totalCard = qs<HTMLElement>("#questionBankTotalCard");
  const multiCard = qs<HTMLElement>("#questionBankMultiCard");
  const categoryCard = qs<HTMLElement>("#questionBankCategoryCard");
  const selectedCard = qs<HTMLElement>("#questionBankSelectedCard");
  if (totalCard) totalCard.innerHTML = `<span>题库总量</span><b>${total}</b><small>真实基础题库</small>`;
  if (multiCard) multiCard.innerHTML = `<span>多选题</span><b>${multi}</b><small>${Math.round((multi / Math.max(total, 1)) * 100)}% 占比</small>`;
  if (categoryCard) categoryCard.innerHTML = `<span>类目数</span><b>${categories.length}</b><small>产品知识分类</small>`;
  if (selectedCard) selectedCard.innerHTML = `<span>当前题目</span><b>${selected ? questionTypeText(selected) : "未选择"}</b>${selected ? `<small>${escapeHtml(selected.category)}</small>` : ""}`;
}

export function renderQuestionBankRows(_questions = state.examQuestions) {
  const list = qs<HTMLElement>("#questionBankList");
  if (!list) return;
  refreshQuestionBankCategoryOptions();
  if (!state.selectedQuestionId && state.examQuestions.length) state.selectedQuestionId = state.examQuestions[0].id;
  const filtered = filteredQuestionBankRows();
  if (state.selectedQuestionId !== "__new__" && !filtered.some((question) => question.id === state.selectedQuestionId) && filtered[0]) state.selectedQuestionId = filtered[0].id;
  list.innerHTML = filtered.length ? filtered.map((question, index) => `
    <article class="question-bank-row ${question.id === state.selectedQuestionId ? "active" : ""}" data-bank-question="${escapeHtml(question.id)}">
      <div class="question-bank-row-meta"><span>#${index + 1}</span>${badge(questionTypeText(question), questionTypeText(question) === "多选" ? "amber" : "")}${badge(question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用", difficultyTone(question.difficulty))}</div>
      <h3>${escapeHtml(question.stem)}</h3>
      <div class="question-bank-row-foot"><span>${escapeHtml(question.category)}</span><span>${escapeHtml(questionTagsText(question))}</span><span>${question.options.length} 个选项</span></div>
    </article>`).join("") : `<div class="empty-state"><b>暂无匹配题目</b></div>`;
  qsa<HTMLElement>("[data-bank-question]", list).forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedQuestionId = row.dataset.bankQuestion || null;
      renderQuestionBankRows(state.examQuestions);
      fillQuestionEditor(state.examQuestions.find((question) => question.id === state.selectedQuestionId));
    });
  });
  renderQuestionBankStats();
  fillQuestionEditor(state.selectedQuestionId === "__new__" ? undefined : state.examQuestions.find((question) => question.id === state.selectedQuestionId));
}

function emptyQuestionDraft(): ExamQuestion {
  return {
    id: "",
    examId: "bank",
    stem: "",
    category: "产品知识",
    options: ["", "", "", ""],
    answerIndex: 0,
    answerIndexes: [0],
    questionType: "single",
    tags: [],
    explanation: "",
    difficulty: "medium"
  };
}

function fillQuestionEditor(question?: ExamQuestion) {
  const draft = question || emptyQuestionDraft();
  const hint = qs<HTMLElement>("#questionEditorHint");
  if (hint) hint.textContent = question ? `正在编辑：${draft.category} · ${questionTypeText(draft)}` : "新增题目，保存后进入基础题库";
  const stem = qs<HTMLTextAreaElement>("#questionStemInput");
  if (stem) stem.value = draft.stem;
  refreshQuestionBankCategoryOptions();
  const category = qs<HTMLSelectElement>("#questionCategoryInput");
  if (category) category.value = draft.category;
  const type = qs<HTMLSelectElement>("#questionTypeInput");
  if (type) type.value = draft.questionType || (correctIndexesForQuestion(draft).length > 1 ? "multiple" : "single");
  qsa<HTMLInputElement>(".question-option-input").forEach((input, index) => { input.value = draft.options[index] || ""; });
  const answer = qs<HTMLInputElement>("#questionAnswerInput");
  if (answer) answer.value = correctIndexesForQuestion(draft).map((index) => String.fromCharCode(65 + index)).join(",");
  const difficulty = qs<HTMLSelectElement>("#questionDifficultyInput");
  if (difficulty) difficulty.value = draft.difficulty || "medium";
  const tags = qs<HTMLInputElement>("#questionTagsInput");
  if (tags) tags.value = questionTagsText(draft) === "未打标签" ? "" : questionTagsText(draft);
  const explain = qs<HTMLTextAreaElement>("#questionExplainInput");
  if (explain) explain.value = draft.explanation || "";
  const deleteButton = qs<HTMLButtonElement>("#deleteQuestionButton");
  if (deleteButton) deleteButton.disabled = !question;
  renderQuestionBankStats();
}

export async function openQuestionBankPage(id = "") {
  await ensureExamQuestionsLoaded();
  const exam = state.exams.find((item) => item.id === id);
  const preferred = exam ? state.examQuestions.find((question) => question.category === exam.category) : null;
  state.selectedQuestionId = preferred?.id || state.selectedQuestionId || state.examQuestions[0]?.id || null;
  activateNavView("question-bank");
  renderQuestionBankRows(state.examQuestions);
}

export function newQuestionDraft() {
  state.selectedQuestionId = "__new__";
  fillQuestionEditor(undefined);
  renderQuestionBankRows(state.examQuestions);
  qs<HTMLTextAreaElement>("#questionStemInput")?.focus();
}

function parseTags(value: string) {
  return value.split(/[，,、\s]+/).map((item) => item.trim()).filter(Boolean);
}

export async function saveQuestion(button?: HTMLButtonElement) {
  const stem = qs<HTMLTextAreaElement>("#questionStemInput")?.value.trim() || qs<HTMLInputElement>("#questionStemInput")?.value.trim() || "";
  const options = qsa<HTMLInputElement>(".question-option-input").map((input) => input.value.trim()).filter(Boolean);
  const answerIndexes = normalizeAnswerIndexes(qs<HTMLInputElement>("#questionAnswerInput")?.value || "A");
  const questionType = qs<HTMLSelectElement>("#questionTypeInput")?.value === "multiple" || answerIndexes.length > 1 ? "multiple" : "single";
  const editingId = state.selectedQuestionId && state.selectedQuestionId !== "__new__" ? state.selectedQuestionId : "";
  if (!stem || options.length < 2) {
    toast("请填写题干和至少两个选项", "error");
    return;
  }
  if (!answerIndexes.length || answerIndexes.some((answerIndex) => answerIndex >= options.length)) {
    toast("正确答案超出选项范围", "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "保存中";
    }
    const result = await api<{ question: ExamQuestion; report: ExamReport }>(editingId ? `/api/exam-questions/${editingId}` : "/api/exam-questions", {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify({
        stem,
        category: qs<HTMLSelectElement>("#questionCategoryInput")?.value || "产品知识",
        options,
        answerIndex: answerIndexes[0],
        answerIndexes,
        questionType,
        tags: parseTags(qs<HTMLInputElement>("#questionTagsInput")?.value || ""),
        explanation: qs<HTMLTextAreaElement>("#questionExplainInput")?.value.trim() || qs<HTMLInputElement>("#questionExplainInput")?.value.trim() || "请补充解析",
        difficulty: qs<HTMLSelectElement>("#questionDifficultyInput")?.value || "medium"
      })
    });
    if (editingId) {
      state.examQuestions = state.examQuestions.map((question) => question.id === result.question.id ? result.question : question);
    } else {
      state.examQuestions.unshift(result.question);
    }
    state.selectedQuestionId = result.question.id;
    state.examReport = result.report;
    renderQuestionBankRows(state.examQuestions);
    renderExams(state.exams);
    toast(editingId ? "题目已保存" : "题目已加入基础题库");
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存题目失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "保存题目";
    }
  }
}

function normalizeAnswerIndexes(value: unknown) {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return [0];
  const tokens = text.includes(",") || text.includes("，") || text.includes("/") || /\s/.test(text)
    ? text.split(/[,\s，/、]+/).filter(Boolean)
    : /^[A-F]{2,}$/.test(text) ? text.split("") : [text];
  const indexes = tokens.map((token) => {
    if (/^[A-F]$/.test(token)) return token.charCodeAt(0) - 65;
    const numeric = Number(token);
    return Number.isFinite(numeric) ? Math.max(0, numeric - 1) : 0;
  });
  return [...new Set(indexes)].sort((left, right) => left - right);
}

function normalizeQuestionType(value: unknown, answerIndexes: number[]): "single" | "multiple" {
  const text = String(value ?? "").trim().toLowerCase();
  if (["multiple", "multi", "多选", "多选题"].includes(text)) return "multiple";
  if (["single", "单选", "单选题"].includes(text)) return "single";
  return answerIndexes.length > 1 ? "multiple" : "single";
}

function normalizeDifficulty(value: unknown): "easy" | "medium" | "hard" {
  const text = String(value ?? "").trim().toLowerCase();
  if (["easy", "基础", "简单"].includes(text)) return "easy";
  if (["hard", "困难", "高阶"].includes(text)) return "hard";
  return "medium";
}

export function rowValue(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim()) return row[key];
  }
  return "";
}

async function parseQuestionFile(file: File): Promise<ExamImportQuestion[]> {
  assertImportFile(file);
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", dense: true, sheetRows: 502 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (rows.length > 500) throw new Error("题库导入单次最多支持 500 行");
  return rows.map((row) => {
    const options = [
      rowValue(row, ["选项A", "选项 A", "A", "optionA", "Option A"]),
      rowValue(row, ["选项B", "选项 B", "B", "optionB", "Option B"]),
      rowValue(row, ["选项C", "选项 C", "C", "optionC", "Option C"]),
      rowValue(row, ["选项D", "选项 D", "D", "optionD", "Option D"])
    ].map((item) => String(item).trim()).filter(Boolean);
    const answerIndexes = normalizeAnswerIndexes(rowValue(row, ["正确答案", "答案", "answer", "Answer"]));
    return {
      stem: String(rowValue(row, ["题干", "题目", "问题", "stem", "question"])).trim(),
      category: String(rowValue(row, ["类目", "分类", "category", "Category"]) || "产品知识").trim(),
      options,
      answerIndex: answerIndexes[0] ?? 0,
      answerIndexes,
      questionType: normalizeQuestionType(rowValue(row, ["题型", "类型", "questionType", "type"]), answerIndexes),
      tags: parseTags(String(rowValue(row, ["标签", "tags", "Tags"]) || "")),
      explanation: String(rowValue(row, ["解析", "说明", "explanation", "Explanation"]) || "Excel题库导入题目，请补充解析。").trim(),
      difficulty: normalizeDifficulty(rowValue(row, ["难度", "difficulty", "Difficulty"]))
    };
  }).filter((item) => item.stem && item.options.length >= 2);
}

export async function importQuestionBank(button?: HTMLButtonElement) {
  const file = qs<HTMLInputElement>("#questionImportInput")?.files?.[0];
  if (!file) {
    toast("请选择 Excel 或 CSV 题库文件", "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "导入中";
    }
    const questions = await parseQuestionFile(file);
    if (!questions.length) {
      toast("未识别到有效题目，请检查表头和选项", "error");
      return;
    }
    const result = await api<{ importedCount: number; questions: ExamQuestion[]; report: ExamReport }>("/api/exam-questions/import", {
      method: "POST",
      body: JSON.stringify({ questions })
    });
    state.examQuestions.unshift(...result.questions);
    state.examReport = result.report;
    renderQuestionBankRows(state.examQuestions);
    renderExams(state.exams);
    toast(`题库导入成功：${result.importedCount} 道题`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "题库导入失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "导入";
    }
  }
}

export async function exportQuestionBank() {
  try {
    const result = await api<{ questions: ExamQuestion[] }>("/api/exam-questions/export");
    const rows = result.questions.map((question) => ({
      题干: question.stem,
      类目: question.category,
      题型: questionTypeText(question),
      标签: questionTagsText(question),
      选项A: question.options[0] || "",
      选项B: question.options[1] || "",
      选项C: question.options[2] || "",
      选项D: question.options[3] || "",
      正确答案: correctIndexesForQuestion(question).map((index) => String.fromCharCode(65 + index)).join(","),
      难度: question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用",
      解析: question.explanation
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "基础题库");
    XLSX.writeFile(workbook, `GoodJob基础题库-${Date.now()}.xlsx`);
    toast(`题库已导出：${rows.length} 道题`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "题库导出失败", "error");
  }
}

export async function deleteBankQuestion(id: string) {
  if (!id) return;
  if (!await confirmAction({
    title: "删除题库题目",
    message: "这道题将从题库中删除。",
    consequences: ["相关考试中的题目引用会同步移除", "已有考试结构可能发生变化"],
    confirmLabel: "删除题目"
  })) return;
  try {
    const result = await api<{ question: ExamQuestion; report: ExamReport }>(`/api/exam-questions/${id}`, { method: "DELETE" });
    state.examQuestions = state.examQuestions.filter((question) => question.id !== result.question.id);
    state.examReport = result.report;
    renderQuestionBankRows(state.examQuestions);
    await refreshExamData();
    toast("题目已删除");
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除题目失败", "error");
  }
}

export function openExamCategoryModal() {
  const categories = Array.from(new Set([...state.exams.map((exam) => exam.category), "产品知识", "认证资料", "报价规则"]));
  openModal("分类目考试维护", `
    <div class="form-grid">
      <div class="form-field full"><label>选择类目</label><select id="categoryExamInput">${categories.map((category) => `<option>${escapeHtml(category)}</option>`).join("")}</select></div>
      <div class="form-field"><label>默认题量</label><input id="categoryExamCountInput" type="number" value="3" min="1"></div>
      <div class="form-field"><label>及格分</label><input id="categoryExamPassInput" type="number" value="80" min="1" max="100"></div>
      <div class="form-field full"><label>命名规则</label><input id="categoryExamTitleInput" value="类目专项考试"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="createCategoryExamButton">生成分类考试</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#createCategoryExamButton")?.addEventListener("click", async () => {
    const category = qs<HTMLSelectElement>("#categoryExamInput")?.value || "产品知识";
    const titleRule = qs<HTMLInputElement>("#categoryExamTitleInput")?.value.trim() || "专项考试";
    const passValue = qs<HTMLInputElement>("#categoryExamPassInput")?.value || "80";
    closeModal();
    await openExamCreateModal(category);
    const title = qs<HTMLInputElement>("#examTitleInput");
    const pass = qs<HTMLInputElement>("#examPassInput");
    if (title) title.value = `${category}${titleRule}`;
    if (pass) pass.value = passValue;
    qsa<HTMLInputElement>("#examQuestionPicker input[data-question-id]").forEach((input) => { input.checked = true; });
    updateExamCreateSelectionSummary();
  });
}

async function refreshExamData() {
  const result = await api<{ exams: Exam[]; report: ExamReport; canManage: boolean; candidates: ExamCandidate[] }>("/api/exams");
  state.exams = result.exams;
  state.examReport = result.report;
  state.examCanManage = result.canManage;
  state.examCandidates = result.candidates || [];
  if (!state.examCanManage && state.examWorkspaceMode !== "mine") state.examWorkspaceMode = "mine";
  state.selectedExamId = state.selectedExamId || result.exams[0]?.id || null;
  renderExams(state.exams);
  renderDashboardKnowledgePanels();
}

export interface MysqlImportSelection {
  file: File;
  plan: MysqlDumpPlan;
  sha256: string;
}

export interface DatabaseMaintenanceEvent {
  id: string;
  at: string;
  level: "info" | "success" | "warning" | "error";
  stage: string;
  table: string;
  message: string;
}

export interface DatabaseTableStat {
  status?: "pending" | "running" | "completed" | "failed";
  total?: number;
  rows?: number;
  imported?: number;
  skipped?: number;
  failed?: number;
  bytes?: number;
}

export interface DatabaseMaintenanceJob {
  id: string;
  type: "migration" | "backup";
  status: "running" | "queued" | "completed" | "failed" | "cancelled" | "expired";
  phase: string;
  currentTable: string;
  totalTables: number;
  processedTables: number;
  totalRows?: number;
  processedRows?: number;
  importedRows?: number;
  skippedRows?: number;
  failedRows?: number;
  estimatedRows?: number;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  errorMessage: string;
  tableStats: Record<string, DatabaseTableStat>;
  events: DatabaseMaintenanceEvent[];
  createdAt: string;
  completedAt: string;
}

export interface DatabaseMaintenanceStatus {
  store: string;
  migration: { enabled: boolean; sourceStoredOnServer: boolean; maxFileSize: number; maxBatchRows: number };
  backup: { enabled: boolean; retentionDays: number; reason: string };
  latest: (DatabaseMaintenanceJob & { type: "migration" | "backup" }) | null;
}

export function mysqlImportHeaders() {
  return { "x-database-import-token": qs<HTMLInputElement>("#mysqlImportToken")?.value.trim() || "" };
}

export function formatFileSize(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function setMysqlImportProgress(processed: number, total: number, text: string, indeterminate = false) {
  const percent = total ? Math.min(100, Math.round(processed / total * 100)) : 0;
  const bar = qs<HTMLElement>("#mysqlImportProgressBar");
  const track = bar?.parentElement;
  if (bar) bar.style.width = `${percent}%`;
  track?.classList.toggle("is-indeterminate", indeterminate);
  const label = qs<HTMLElement>("#mysqlImportProgressText");
  const percentLabel = qs<HTMLElement>("#mysqlImportProgressPercent");
  if (label) label.textContent = text;
  if (percentLabel) percentLabel.textContent = indeterminate ? "进行中" : `${percent}%`;
}

export function databaseJobStatusLabel(status: DatabaseMaintenanceJob["status"]) {
  return ({ queued: "等待执行", running: "执行中", completed: "已完成", failed: "执行失败", cancelled: "已取消", expired: "已清理" } as Record<DatabaseMaintenanceJob["status"], string>)[status];
}

export function databaseJobTypeLabel(type: DatabaseMaintenanceJob["type"]) {
  return type === "backup" ? "本地备份" : "数据迁移";
}
