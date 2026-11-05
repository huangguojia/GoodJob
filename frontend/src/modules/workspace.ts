/**
 * 提醒、问题、备忘、竞品、同行、案例。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, confirmAction, openModal, renderMemos, saveCurrentMemoDraft, saveMemo, state } from "../prototype-api";
import {
  type CaseStudy, type Competitor, type Memo, type MemoDraft, type Peer, type PeerRelation, type ProblemItem,
  type Reminder, type Todo
} from "./models";
import {
  caseStatusText, isAutoMaintenanceTodo, problemStatusText, refreshDashboardOnly, renderTodos, severityText,
  severityTone, threatText, updateTodoChips
} from "./dashboard";
import { renderCustomers } from "./customers";
import { type AppState, badge, escapeHtml, qs, qsa } from "./shared";
import { countryFlag, openCustomerDrawer, renderCustomerDrawer } from "./customer-detail";
import { api, setButtonPending, toast } from "./ui";
import { formatLeadDate } from "./leads";
import { formatDateTime } from "./deals";
import { reminderRunNote } from "./commission";
import { renderTopbarStats } from "./navigation";

export function renderReminders(reminders: Reminder[]) {
  const list = qs<HTMLElement>("#reminders .task-list");
  renderTopbarStats();
  if (!list) return;
  qsa<HTMLButtonElement>("[data-reminder-view]", qs("#reminders") || undefined).forEach((button) => {
    button.classList.toggle("active", button.dataset.reminderView === state.reminderView);
    button.onclick = () => {
      state.reminderView = button.dataset.reminderView === "rules" ? "rules" : "tasks";
      renderReminders(state.reminders);
    };
  });
  const filters = qs<HTMLElement>("#reminderTaskFilters");
  if (filters) filters.hidden = state.reminderView !== "tasks";
  qsa<HTMLButtonElement>("[data-reminder-filter]", filters || undefined).forEach((button) => {
    button.classList.toggle("active", button.dataset.reminderFilter === state.reminderFilter);
    button.onclick = () => {
      state.reminderFilter = (button.dataset.reminderFilter as AppState["reminderFilter"]) || "pending";
      renderReminders(state.reminders);
    };
  });
  if (state.reminderView === "tasks") {
    renderReminderTasks(list);
    return;
  }
  list.innerHTML = reminders.length ? reminders.map((reminder) => {
    const priorityTone = reminder.priority === "high" ? "red" : reminder.priority === "medium" ? "amber" : "";
    const enabled = reminder.enabled !== false;
    const accent = enabled ? reminder.priority === "high" ? "rose" : "brand" : "gray";
    const runSummary = reminder.lastRunAt
      ? `最近运行 ${escapeHtml(formatDateTime(reminder.lastRunAt))}｜匹配 ${reminder.lastMatchedCount || 0}｜新建 ${reminder.lastCreatedCount || 0}｜跳过 ${reminder.lastSkippedCount || 0}｜失败 ${reminder.lastFailedCount || 0}`
      : "尚未运行";
    // 第二行回答「这一次为什么没生成」：优先显示后端上一次运行的真实跳过原因（含客户名）。
    const generates = reminder.generateTodo !== false;
    const liveTodos = liveReminderTodoCount(reminder.id);
    const runNote = reminderRunNote(reminder, liveTodos);
    return `<article class="task reminder-rule-card" data-reminder-id="${escapeHtml(reminder.id)}" style="--accent: var(--${accent})">
      <i class="task-line"></i>
      <div>
        <div class="reminder-rule-heading"><div><h3>${escapeHtml(reminder.title)}</h3><p>${escapeHtml(reminder.rule)}</p></div>${badge(enabled ? "已启用" : "已停用", enabled ? "green" : "gray")}</div>
        <div class="reminder-rule-meta">
          ${badge(reminderRuleTypeText(reminder.ruleType), "")}
          ${badge(reminder.targetStage || "不限阶段", "")}
          ${badge(`${reminder.days ?? 3} ${reminderTimeUnitText(reminder.timeUnit)}`, "")}
          ${badge(reminder.targetCustomerIds?.length ? `关联客户 ${reminder.targetCustomerIds.length} 家` : "全部客户", "")}
          ${badge(reminder.priority === "high" ? "高优先级" : reminder.priority === "medium" ? "中优先级" : "普通", priorityTone)}
          ${badge(generates ? "生成待办" : "仅统计", generates ? "" : "gray")}
        </div>
        <div class="reminder-run-summary">${runSummary}${reminder.lastError ? `｜${escapeHtml(reminder.lastError)}` : ""}</div>
        <div class="reminder-run-summary" style="color:${runNote.tone === "amber" ? "var(--amber)" : "var(--muted)"}">${escapeHtml(runNote.text)}</div>
      </div>
      <div class="reminder-rule-actions">
        <button class="btn" data-run-reminder ${enabled ? "" : "disabled"}>手工运行</button>
        <button class="btn" data-edit-reminder aria-label="编辑规则">编辑</button>
        <button class="btn" data-toggle-reminder>${enabled ? "停用" : "启用"}</button>
      </div>
    </article>`;
  }).join("") : `<div class="reminder-empty">暂无个人提醒规则，可从右上角开始设置。</div>`;
  qsa<HTMLButtonElement>("[data-toggle-reminder]", list).forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest<HTMLElement>(".task");
      if (!row?.dataset.reminderId) return;
      const result = await api<{ reminder: Reminder }>(`/api/reminders/${row.dataset.reminderId}/toggle`, { method: "POST" });
      state.reminders = state.reminders.map((item) => item.id === result.reminder.id ? result.reminder : item);
      renderReminders(state.reminders);
      toast(result.reminder.enabled === false ? "规则已停用" : "规则已启用");
    });
  });
  qsa<HTMLButtonElement>("[data-run-reminder]", list).forEach((button) => {
    button.addEventListener("click", () => void runReminderRule(button.closest<HTMLElement>(".task")?.dataset.reminderId || "", button));
  });
  qsa<HTMLButtonElement>("[data-edit-reminder]", list).forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.closest<HTMLElement>(".task")?.dataset.reminderId;
      const reminder = state.reminders.find((item) => item.id === id);
      if (reminder) openReminderModal(reminder);
    });
  });
}

function reminderDueDate(todo: Todo) {
  const parsed = new Date(todo.dueAt.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function reminderTaskBucket(todo: Todo) {
  if (todo.done) return "done";
  const due = reminderDueDate(todo);
  if (!due) return "future";
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(start.getTime() + 86400000);
  if (due < start) return "overdue";
  if (due < tomorrow) return "today";
  if (todo.snoozeCount) return "snoozed";
  return "future";
}

function renderReminderTasks(list: HTMLElement) {
  const tasks = state.todos
    .filter((todo) => todo.reminderRuleId)
    .filter((todo) => state.reminderFilter === "pending" ? !todo.done : reminderTaskBucket(todo) === state.reminderFilter)
    .sort((left, right) => (reminderDueDate(left)?.getTime() || Number.MAX_SAFE_INTEGER) - (reminderDueDate(right)?.getTime() || Number.MAX_SAFE_INTEGER));
  list.innerHTML = tasks.length ? tasks.map((todo) => {
    const customer = state.customers.find((item) => item.id === todo.customerId);
    const deal = state.deals.find((item) => item.id === todo.dealId);
    const bucket = reminderTaskBucket(todo);
    const status = bucket === "overdue" ? badge("逾期", "red") : bucket === "today" ? badge("今天", "amber") : bucket === "snoozed" ? badge(`已延期 ${todo.snoozeCount || 1} 次`, "") : bucket === "done" ? badge("已完成", "green") : badge("未来", "gray");
    return `<article class="task reminder-task-card" data-reminder-task-id="${escapeHtml(todo.id)}" style="--accent: var(--${bucket === "overdue" ? "rose" : bucket === "done" ? "green" : "brand"})">
      <i class="task-line"></i>
      <div>
        <div class="reminder-task-heading"><div><h3><button data-open-reminder-customer>${escapeHtml(customer?.company || todo.related)}</button></h3><p>${deal ? `${escapeHtml(deal.title)} · ` : ""}${escapeHtml(todo.title)}</p></div>${status}</div>
        <div class="reminder-run-summary">计划 ${escapeHtml(todo.dueAt)}${todo.snoozeReason ? `｜延期原因：${escapeHtml(todo.snoozeReason)}` : ""}${todo.completionResult ? `｜处理结果：${escapeHtml(todo.completionResult)}` : ""}</div>
      </div>
      <div class="reminder-task-actions">
        ${todo.done ? `<button class="btn" disabled>已完成</button>` : `<button class="btn primary" data-complete-reminder-task>记录结果</button><button class="btn" data-snooze-reminder-task aria-label="延期">延期</button>`}
      </div>
    </article>`;
  }).join("") : `<div class="reminder-empty">${state.reminderFilter === "pending" ? "当前没有待处理提醒。" : "当前筛选下没有提醒。"}</div>`;
  qsa<HTMLButtonElement>("[data-open-reminder-customer]", list).forEach((button) => {
    button.addEventListener("click", () => {
      const todo = state.todos.find((item) => item.id === button.closest<HTMLElement>(".task")?.dataset.reminderTaskId);
      const customer = state.customers.find((item) => item.id === todo?.customerId);
      if (!customer) return;
      activateNavView("customers", () => {
        state.selectedCustomerId = customer.id;
        renderCustomers(state.customers);
        renderCustomerDrawer(customer);
        openCustomerDrawer();
      });
    });
  });
  qsa<HTMLButtonElement>("[data-complete-reminder-task]", list).forEach((button) => {
    button.addEventListener("click", () => openReminderTaskResult(button.closest<HTMLElement>(".task")?.dataset.reminderTaskId || ""));
  });
  qsa<HTMLButtonElement>("[data-snooze-reminder-task]", list).forEach((button) => {
    button.addEventListener("click", () => openReminderTaskSnooze(button.closest<HTMLElement>(".task")?.dataset.reminderTaskId || ""));
  });
}

export function openReminderTaskResult(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) return;
  const rule = state.reminders.find((item) => item.id === todo.reminderRuleId);
  const ruleLabel = isAutoMaintenanceTodo(todo) ? "自动维护巡检" : rule?.title || "提醒规则";
  openModal("记录跟进结果", `
    <div class="form-grid">
      <div class="form-field full" style="grid-column:1/-1;margin:0;padding:9px 10px;border:1px solid #dbe8e5;border-radius:6px;background:#f4faf8;color:#5c6f6b;font-size:11px;line-height:1.6">这条待办由「${escapeHtml(ruleLabel)}」生成，完成前需要记录本次跟进结果：用于回访留痕，并作为下一次提醒的重新计时起点。</div>
      <div class="form-field full"><label>处理结果</label><select id="reminderResultType"><option>已联系客户，等待回复</option><option>客户已回复</option><option>已更新报价或方案</option><option>已记录样品反馈</option><option>无需继续跟进</option></select></div>
      <div class="form-field full"><label>补充说明</label><textarea id="reminderResultNote" rows="3" placeholder="例如：客户周五前确认采购数量"></textarea></div>
    </div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReminderResult">保存并完成</button>`);
  qs("#saveReminderResult")?.addEventListener("click", async () => {
    const button = qs<HTMLButtonElement>("#saveReminderResult");
    const note = qs<HTMLTextAreaElement>("#reminderResultNote")?.value.trim() || "";
    const result = `${qs<HTMLSelectElement>("#reminderResultType")?.value || "已处理"}${note ? `：${note}` : ""}`.slice(0, 255);
    if (button) button.disabled = true;
    try {
      const response = await api<{ todo: Todo }>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ done: true, completionResult: result }) });
      state.todos = state.todos.map((item) => item.id === id ? response.todo : item);
      renderReminders(state.reminders);
      renderTodos(state.todos);
      updateTodoChips(state.todos);
      void refreshDashboardOnly();
      closeModal();
      toast("跟进结果已记录，待办已完成");
    } catch (error) {
      if (button) button.disabled = false;
      toast(error instanceof Error ? error.message : "保存失败，请稍后重试", "error");
    }
  });
}

function openReminderTaskSnooze(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) return;
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  const localDateTime = [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, "0"),
    String(next.getDate()).padStart(2, "0")
  ].join("-") + `T${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  openModal("延期提醒", `
    <div class="form-grid">
      <div class="form-field full"><label>新的跟进时间</label><input id="reminderSnoozeAt" type="datetime-local" value="${escapeHtml(localDateTime)}"></div>
      <div class="form-field full"><label>延期原因</label><input id="reminderSnoozeReason" placeholder="例如：客户要求下周再联系"></div>
    </div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReminderSnooze">确认延期</button>`);
  qs("#saveReminderSnooze")?.addEventListener("click", async () => {
    const dueAt = qs<HTMLInputElement>("#reminderSnoozeAt")?.value.replace("T", " ") || "";
    const snoozeReason = qs<HTMLInputElement>("#reminderSnoozeReason")?.value.trim() || "";
    if (!dueAt || !snoozeReason) {
      toast("请选择时间并填写延期原因", "error");
      return;
    }
    const response = await api<{ todo: Todo }>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ dueAt, snoozeReason }) });
    state.todos = state.todos.map((item) => item.id === id ? response.todo : item);
    renderReminders(state.reminders);
    closeModal();
    toast("提醒已延期并保留记录");
  });
}

function reminderRuleTypeText(ruleType = "quote_no_reply") {
  const map: Record<string, string> = {
    quote_no_reply: "已报价阶段停滞",
    sample_feedback: "样品阶段待确认",
    inactive_customer: "长期未产生客户活动",
    high_value_revisit: "高价值复访",
    custom_due: "商机下一动作到期"
  };
  return map[ruleType] || "自定义规则";
}

export function renderProblems(problems: ProblemItem[]) {
  const categories = [...new Set(problems.map((item) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (state.problemCategoryFilter !== "all" && !categories.includes(state.problemCategoryFilter)) state.problemCategoryFilter = "all";
  const categorySelect = qs<HTMLSelectElement>("#problemCategoryFilter");
  if (categorySelect) {
    categorySelect.innerHTML = `<option value="all">全部分类</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`;
    categorySelect.value = state.problemCategoryFilter;
  }
  const keyword = state.problemSearch.trim().toLocaleLowerCase();
  const sorted = problems.filter((problem) => {
    const matchesKeyword = !keyword || [problem.title, problem.category, problem.relatedCustomer, problem.rootCause, problem.solution, problem.nextAction]
      .some((value) => String(value || "").toLocaleLowerCase().includes(keyword));
    const matchesStatus = state.problemStatusFilter === "all" || problem.status === state.problemStatusFilter;
    const matchesSeverity = state.problemSeverityFilter === "all" || problem.severity === state.problemSeverityFilter;
    const matchesCategory = state.problemCategoryFilter === "all" || problem.category === state.problemCategoryFilter;
    return matchesKeyword && matchesStatus && matchesSeverity && matchesCategory;
  }).sort((a, b) => {
    const statusWeight = (item: ProblemItem) => item.status === "resolved" ? 2 : item.status === "solving" ? 1 : 0;
    const severityWeight = (item: ProblemItem) => item.severity === "high" ? 0 : item.severity === "medium" ? 1 : 2;
    return statusWeight(a) - statusWeight(b) || severityWeight(a) - severityWeight(b) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const list = qs<HTMLElement>("#problems .problem-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((problem) => `<div class="problem-row" data-problem-id="${escapeHtml(problem.id)}">
      <div class="problem-row-title" title="${escapeHtml(problem.title)}"><button class="problem-name" type="button" data-problem-open="${escapeHtml(problem.id)}">${escapeHtml(problem.title)}</button></div>
      <span class="problem-row-cell" title="${escapeHtml(problem.category)}">${escapeHtml(problem.category)}</span>
      <span>${badge(severityText(problem.severity), severityTone(problem.severity))}</span>
      <span>${badge(problemStatusText(problem.status), problem.status === "resolved" ? "green" : problem.status === "solving" ? "amber" : "red")}</span>
      <span class="problem-row-cell" title="${escapeHtml(formatDateTime(problem.createdAt))}">${escapeHtml(formatDateTime(problem.createdAt))}</span>
      <span class="problem-row-cell" title="${escapeHtml(formatDateTime(problem.resolvedAt))}">${escapeHtml(formatDateTime(problem.resolvedAt))}</span>
      <div class="problem-row-actions"><button class="btn" type="button" data-problem-edit="${escapeHtml(problem.id)}">编辑</button><button class="btn" type="button" data-problem-status="${escapeHtml(problem.id)}">${problem.status === "resolved" ? "重新打开" : problem.status === "open" ? "开始解决" : "标记解决"}</button><button class="btn danger subtle" type="button" data-problem-delete="${escapeHtml(problem.id)}">删除</button></div>
    </div>`).join("") : `<div class="problem-empty">没有符合当前筛选条件的问题</div>`;
    qsa<HTMLButtonElement>("[data-problem-open]", list).forEach((button) => button.addEventListener("click", () => openProblemDrawer(button.dataset.problemOpen || "")));
    qsa<HTMLButtonElement>("[data-problem-edit]", list).forEach((button) => button.addEventListener("click", () => {
      const problem = state.problems.find((item) => item.id === button.dataset.problemEdit);
      if (problem) openProblemModal(problem);
    }));
    qsa<HTMLButtonElement>("[data-problem-status]", list).forEach((button) => button.addEventListener("click", () => void advanceProblemStatus(button.dataset.problemStatus || "")));
    qsa<HTMLButtonElement>("[data-problem-delete]", list).forEach((button) => button.addEventListener("click", () => void deleteSelectedProblem(button.dataset.problemDelete || "")));
  }
  const resultCount = qs("#problemResultCount");
  if (resultCount) resultCount.textContent = `${sorted.length} / ${problems.length} 条`;
  if (qs("#problemDrawer")?.classList.contains("open")) {
    const selected = state.problems.find((item) => item.id === state.selectedProblemId);
    if (selected) renderProblemDrawer(selected);
    else closeProblemDrawer();
  }
}

function openProblemDrawer(problemId: string) {
  const problem = state.problems.find((item) => item.id === problemId);
  if (!problem) return;
  state.selectedProblemId = problem.id;
  renderProblemDrawer(problem);
  qs("#problemDrawer")?.classList.add("open");
  qs("#problemDrawerBackdrop")?.classList.add("active");
  document.body.classList.add("problem-drawer-open");
}

export function closeProblemDrawer() {
  qs("#problemDrawer")?.classList.remove("open");
  qs("#problemDrawerBackdrop")?.classList.remove("active");
  document.body.classList.remove("problem-drawer-open");
}

function renderProblemDrawer(problem: ProblemItem) {
  const drawer = qs<HTMLElement>("#problemDrawer");
  if (!drawer) return;
  const summary: Array<[string, string]> = [
    ["分类", problem.category || "未分类"],
    ["严重程度", severityText(problem.severity)],
    ["状态", problemStatusText(problem.status)],
    ["问题时间", formatDateTime(problem.createdAt)],
    ["解决时间", formatDateTime(problem.resolvedAt)],
    ["截止时间", problem.dueAt || "未设置"],
    ["关联对象", problem.relatedCustomer || "未关联"]
  ];
  drawer.innerHTML = `
    <div class="drawer-head">
      <div><h2>${escapeHtml(problem.title)}</h2><p>${escapeHtml(problem.category)} · ${escapeHtml(problemStatusText(problem.status))}</p></div>
      <button class="btn icon-only" id="problemDrawerClose" type="button" title="关闭" aria-label="关闭问题详情">×</button>
    </div>
    <div class="problem-drawer-summary">${summary.map(([label, value]) => `<div class="info"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join("")}</div>
    <div class="problem-drawer-blocks">
      <div class="detail-block"><span>问题原因</span><p>${escapeHtml(problem.rootCause || "暂未填写")}</p></div>
      <div class="detail-block problem-solution-highlight"><span>解决方案</span><p>${escapeHtml(problem.solution || "暂未填写")}</p></div>
      <div class="detail-block"><span>下一动作</span><p>${escapeHtml(problem.nextAction || "暂未填写")}</p></div>
    </div>
    <div class="problem-drawer-actions"><button class="btn" id="problemDrawerEdit" type="button">编辑</button><button class="btn primary" id="problemDrawerStatus" type="button">${problem.status === "resolved" ? "重新打开" : problem.status === "open" ? "开始解决" : "标记解决"}</button><button class="btn danger subtle" id="problemDrawerDelete" type="button">删除</button></div>`;
  qs("#problemDrawerClose", drawer)?.addEventListener("click", closeProblemDrawer);
  qs("#problemDrawerEdit", drawer)?.addEventListener("click", () => openProblemModal(problem));
  qs("#problemDrawerStatus", drawer)?.addEventListener("click", () => void advanceProblemStatus(problem.id));
  qs("#problemDrawerDelete", drawer)?.addEventListener("click", () => void deleteSelectedProblem(problem.id));
}

export function visibleMemos() {
  const source = state.memoStatus === "deleted"
    ? state.deletedMemos
    : state.memos.filter((memo) => state.memoStatus === "archived" ? memo.archived : !memo.archived);
  const keyword = state.memoSearch.trim().toLocaleLowerCase();
  return source
    .filter((memo) => !state.memoPinnedOnly || memo.pinned)
    .filter((memo) => !keyword || [memo.title, memo.content, memo.tags].some((value) => value.toLocaleLowerCase().includes(keyword)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function memoRelationText(memo: Memo) {
  const deal = memo.dealId ? state.deals.find((item) => item.id === memo.dealId) : undefined;
  const customer = memo.customerId ? state.customers.find((item) => item.id === memo.customerId) : undefined;
  if (deal) return `商机：${deal.title}`;
  if (customer) return `客户：${customer.company}`;
  if (memo.dealId || memo.customerId) return "关联对象不可访问";
  return "";
}

function memoDraftKey(id: string) {
  return `goodjob:memo-draft:${state.user?.id || "anonymous"}:${id}`;
}

export function collectMemoEditorDraft(memo: Memo): MemoDraft {
  return {
    title: qs<HTMLInputElement>("#memoTitleEditor")?.value.trim() || memo.title,
    category: qs<HTMLSelectElement>("#memoCategoryEditor")?.value || memo.category,
    tags: qs<HTMLInputElement>("#memoTagsEditor")?.value.trim() || "",
    customerId: qs<HTMLSelectElement>("#memoCustomerEditor")?.value || "",
    dealId: qs<HTMLSelectElement>("#memoDealEditor")?.value || "",
    content: qs<HTMLTextAreaElement>("#memoContentEditor")?.value || "",
    serverUpdatedAt: memo.updatedAt,
    draftAt: new Date().toISOString()
  };
}

export function writeMemoDraft(memo: Memo) {
  localStorage.setItem(memoDraftKey(memo.id), JSON.stringify(collectMemoEditorDraft(memo)));
}

export function readMemoDraft(memo: Memo): MemoDraft | null {
  try {
    const raw = localStorage.getItem(memoDraftKey(memo.id));
    if (!raw) return null;
    return JSON.parse(raw) as MemoDraft;
  } catch {
    clearMemoDraft(memo.id);
    return null;
  }
}

export function clearMemoDraft(id: string) {
  localStorage.removeItem(memoDraftKey(id));
}

export function clearCurrentUserMemoDrafts() {
  const prefix = `goodjob:memo-draft:${state.user?.id || "anonymous"}:`;
  Object.keys(localStorage).filter((key) => key.startsWith(prefix)).forEach((key) => localStorage.removeItem(key));
}

export function renderMemoRelationOptions(customerId: string, dealId: string) {
  const customerEditor = qs<HTMLSelectElement>("#memoCustomerEditor");
  const dealEditor = qs<HTMLSelectElement>("#memoDealEditor");
  if (customerEditor) {
    const inaccessible = customerId && !state.customers.some((item) => item.id === customerId);
    customerEditor.innerHTML = `<option value="">不关联客户</option>${inaccessible ? `<option value="${escapeHtml(customerId)}">关联对象不可访问</option>` : ""}${state.customers.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.company)}</option>`).join("")}`;
    customerEditor.value = customerId;
  }
  if (dealEditor) {
    const available = state.deals.filter((item) => !customerId || item.customerId === customerId);
    const inaccessible = dealId && !available.some((item) => item.id === dealId);
    dealEditor.innerHTML = `<option value="">不关联商机</option>${inaccessible ? `<option value="${escapeHtml(dealId)}">关联对象不可访问</option>` : ""}${available.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}`;
    dealEditor.value = dealId;
  }
}

export function renderCompetitors(competitors: Competitor[]) {
  const sorted = [...competitors].sort((a, b) => {
    const weight = (item: Competitor) => item.threatLevel === "high" ? 0 : item.threatLevel === "medium" ? 1 : 2;
    return weight(a) - weight(b) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const list = qs<HTMLElement>("#competitors .intel-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((item) => `<article class="intel-card ${state.selectedCompetitorId === item.id ? "selected" : ""}" data-competitor-id="${escapeHtml(item.id)}">
      <div class="intel-top"><h3>${escapeHtml(item.company)}</h3>${badge(threatText(item.threatLevel), severityTone(item.threatLevel))}</div>
      <div class="intel-meta"><span>${escapeHtml(item.country || "未知国家")}</span><span>${escapeHtml(item.segment || "未分类")}</span><span>${escapeHtml(item.competingProducts || "未维护产品")}</span></div>
      <p>${escapeHtml(item.strengths || "暂未维护竞争优势")}</p>
    </article>`).join("") : `<div class="todo-history-empty">暂无竞争公司</div>`;
    qsa<HTMLElement>(".intel-card", list).forEach((card) => {
      card.addEventListener("click", () => {
        state.selectedCompetitorId = card.dataset.competitorId || null;
        renderCompetitors(state.competitors);
      });
    });
  }
  qs("#competitor-total-count")!.textContent = String(competitors.length);
  qs("#competitor-high-count")!.textContent = String(competitors.filter((item) => item.threatLevel === "high").length);
  qs("#competitor-segment-count")!.textContent = String(new Set(competitors.map((item) => item.segment).filter(Boolean)).size);
  qs("#competitor-strategy-count")!.textContent = String(competitors.filter((item) => item.ourStrategy).length);
  renderCompetitorDetail(sorted.find((item) => item.id === state.selectedCompetitorId) || sorted[0]);
}

function renderCompetitorDetail(competitor?: Competitor) {
  if (!competitor) {
    qs("#competitor-detail-title")!.textContent = "竞争公司详情";
    qs("#competitor-detail-meta")!.textContent = "";
    qs("#competitor-products")!.textContent = "暂无记录";
    qs("#competitor-strengths")!.textContent = "暂无记录";
    qs("#competitor-weaknesses")!.textContent = "暂无记录";
    qs("#competitor-strategy")!.textContent = "暂无记录";
    const button = qs<HTMLButtonElement>("#competitorThreatButton");
    if (button) button.textContent = "更新威胁等级";
    return;
  }
  state.selectedCompetitorId = competitor.id;
  qs("#competitor-detail-title")!.textContent = competitor.company;
  qs("#competitor-detail-meta")!.textContent = `${competitor.country || "未知国家"} · ${competitor.segment || "未分类"} · ${threatText(competitor.threatLevel)}`;
  qs("#competitor-products")!.textContent = competitor.competingProducts || "暂未维护";
  qs("#competitor-strengths")!.textContent = competitor.strengths || "暂未维护";
  qs("#competitor-weaknesses")!.textContent = competitor.weaknesses || "暂未维护";
  qs("#competitor-strategy")!.textContent = competitor.ourStrategy || "暂未维护";
  const button = qs<HTMLButtonElement>("#competitorThreatButton");
  if (button) button.textContent = competitor.threatLevel === "high" ? "降为中威胁" : "设为高威胁";
}

export const PEER_PAGE_SIZE_OPTIONS = [10, 20, 50];
const PEER_RELATION_TONE: Record<PeerRelation, string> = { "互补": "green", "竞争": "red", "互相推荐": "blue" };

/** 联系方式列：邮箱/电话可直接点，官网跳新标签，显示精简域名 */
function peerContactCell(peer: Peer) {
  const parts: string[] = [];
  if (peer.email) parts.push(`<a href="mailto:${escapeHtml(peer.email)}" title="发邮件">${escapeHtml(peer.email)}</a>`);
  if (peer.phone) parts.push(`<a href="tel:${escapeHtml(peer.phone.replace(/\s+/g, ""))}" title="打电话">${escapeHtml(peer.phone)}</a>`);
  if (peer.wechat) parts.push(`<span title="微信 / WhatsApp">${escapeHtml(peer.wechat)}</span>`);
  if (peer.website) {
    const url = /^https?:\/\//i.test(peer.website) ? peer.website : `https://${peer.website.replace(/^\/+/, "")}`;
    const host = url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    parts.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="打开官网">${escapeHtml(host)}</a>`);
  }
  return parts.length ? parts.join(`<span class="peer-contact-sep">·</span>`) : "—";
}

/** 关系徽标串：一个关系都没标时给一句可操作的提示，而不是留一块空白 */
function peerRelationBadges(peer: Peer): string {
  return peer.relations.length
    ? peer.relations.map((relation) => badge(relation, PEER_RELATION_TONE[relation] || "gray")).join(" ")
    : `<span class="badge gray" title="在编辑里勾选互补 / 竞争 / 互相推荐">未标注</span>`;
}

/** 公司名主色：竞争优先（要盯防），其次互补（可联合报价），其余走品牌色 */
function peerNameToneClass(peer: Peer): string {
  if (peer.relations.includes("竞争")) return "is-rival";
  if (peer.relations.includes("互补")) return "is-complement";
  return "";
}

/** 与「未成交客户」同一套筛选口径：关键词命中任一字段 AND 关系标签命中 */
function filteredPeers(): Peer[] {
  const q = state.peerSearch.trim().toLowerCase();
  return state.peers.filter((peer) => {
    const matchRelation = state.peerRelationFilter === "all"
      || (state.peerRelationFilter === "未标注" ? peer.relations.length === 0 : peer.relations.includes(state.peerRelationFilter));
    const haystack = [peer.company, peer.country, peer.industry, peer.contact, peer.phone, peer.email, peer.wechat, peer.website, peer.remark, peer.source]
      .filter(Boolean).join(" ").toLowerCase();
    return matchRelation && (!q || haystack.includes(q));
  });
}

function sortedPeers(peers: Peer[]): Peer[] {
  return [...peers].sort((a, b) => {
    if (state.peerSort === "company") return a.company.localeCompare(b.company, "zh-Hans-CN");
    const da = new Date(a.createdAt).getTime() || 0;
    const db = new Date(b.createdAt).getTime() || 0;
    return state.peerSort === "oldest" ? da - db : db - da;
  });
}

/** 分页切片：页码先夹到合法区间，避免筛选变窄后停在空白页 */
function peerPageRows(peers: Peer[]) {
  const pageCount = Math.max(1, Math.ceil(peers.length / state.peerPageSize));
  state.peerPage = Math.min(Math.max(1, state.peerPage), pageCount);
  const start = (state.peerPage - 1) * state.peerPageSize;
  return { pageCount, start, rows: peers.slice(start, start + state.peerPageSize) };
}

function renderPeerPagination(total: number, pageCount: number, start: number) {
  const summary = qs<HTMLElement>("#peerPageSummary");
  const number = qs<HTMLElement>("#peerPageNumber");
  const prev = qs<HTMLButtonElement>("#peerPrevPage");
  const next = qs<HTMLButtonElement>("#peerNextPage");
  const size = qs<HTMLSelectElement>("#peerPageSize");
  if (summary) {
    summary.textContent = total
      ? `共 ${total} 条，当前 ${start + 1}-${Math.min(start + state.peerPageSize, total)} 条`
      : "共 0 条";
  }
  if (number) number.textContent = `${state.peerPage} / ${pageCount}`;
  if (prev) prev.disabled = state.peerPage <= 1;
  if (next) next.disabled = state.peerPage >= pageCount;
  if (size && PEER_PAGE_SIZE_OPTIONS.includes(state.peerPageSize)) size.value = String(state.peerPageSize);
}

export function resetPeerFilters() {
  state.peerSearch = "";
  state.peerRelationFilter = "all";
  state.peerSort = "newest";
  state.peerPage = 1;
  const search = qs<HTMLInputElement>("#peerSearchInput");
  if (search) search.value = "";
  const relation = qs<HTMLSelectElement>("#peerRelationFilter");
  if (relation) relation.value = "all";
  const sort = qs<HTMLSelectElement>("#peerSortSelect");
  if (sort) sort.value = "newest";
  renderPeers();
}

export function renderPeers() {
  const tbody = qs<HTMLElement>("#peersTableBody");
  if (!tbody) return;
  const visible = sortedPeers(filteredPeers());
  const { pageCount, start, rows } = peerPageRows(visible);
  renderPeerPagination(visible.length, pageCount, start);

  const industryText = (peer: Peer, limit: number) => {
    if (!peer.industry) return "";
    return peer.industry.length > limit ? `${peer.industry.slice(0, limit)}…` : peer.industry;
  };

  tbody.innerHTML = rows.length ? rows.map((peer) => `<tr data-peer-id="${escapeHtml(peer.id)}" class="${peer.id === state.selectedPeerId ? "selected" : ""}">
    <td><div class="company">${countryFlag(peer.country)}<div><button type="button" class="customer-name ${peerNameToneClass(peer)}" data-open-peer="${escapeHtml(peer.id)}" title="查看这家同行">${escapeHtml(peer.company)}</button><span>${escapeHtml(peer.contact || "联系人待补充")} · ${escapeHtml(peer.country || "国家待补充")}</span></div></div></td>
    <td><div class="peer-relation-cell">${peerRelationBadges(peer)}</div></td>
    <td><div class="peer-industry-cell" title="${escapeHtml(peer.industry || "")}">${escapeHtml(industryText(peer, 60) || "待补充行业介绍")}</div></td>
    <td><div class="peer-contact-cell">${peerContactCell(peer)}</div></td>
    <td><div class="customer-follow-cell"><b>${escapeHtml(peer.source || "未登记")}</b><span>来源渠道</span></div></td>
    <td><div class="customer-follow-cell"><b>${escapeHtml(formatLeadDate(peer.createdAt))}</b><span>${peer.updatedAt ? `更新 ${escapeHtml(formatDateTime(peer.updatedAt))}` : "未更新"}</span></div></td>
    <td><div class="customer-row-actions"><button class="btn" type="button" data-peer-action="edit" data-peer-row-id="${escapeHtml(peer.id)}">编辑</button><button class="btn danger" type="button" data-peer-action="delete" data-peer-row-id="${escapeHtml(peer.id)}">删除</button></div></td>
  </tr>`).join("") : (state.peers.length
    ? `<tr><td colspan="7" class="empty-cell">没有符合筛选条件的同行。<button class="btn tiny" id="peerEmptyReset" type="button">清空筛选</button></td></tr>`
    : `<tr><td colspan="7" class="empty-cell">暂无同行，点右上角「新增同行」开始维护这张关系网络。</td></tr>`);

  const mobile = qs<HTMLElement>("#peerMobileList");
  if (mobile) {
    mobile.innerHTML = rows.length ? rows.map((peer) => `
    <article class="customer-mobile-card" data-peer-mobile-id="${escapeHtml(peer.id)}">
      <span class="customer-mobile-top"><span class="customer-mobile-company">${countryFlag(peer.country)}<button type="button" class="customer-name ${peerNameToneClass(peer)}" data-open-peer="${escapeHtml(peer.id)}">${escapeHtml(peer.company)}</button></span><span class="peer-relation-cell">${peerRelationBadges(peer)}</span></span>
      <span>${escapeHtml(peer.contact || "联系人待补充")} · ${escapeHtml(peer.country || "国家待补充")}</span>
      <span class="peer-mobile-meta"><i>来源 · ${escapeHtml(peer.source || "未登记")}</i><i>添加 ${escapeHtml(formatLeadDate(peer.createdAt))}</i><i>${escapeHtml(industryText(peer, 40) || "行业待补充")}</i></span>
      <div class="peer-contact-cell">${peerContactCell(peer)}</div>
      <div class="customer-row-actions"><button class="btn" type="button" data-peer-action="edit" data-peer-row-id="${escapeHtml(peer.id)}">编辑</button><button class="btn danger" type="button" data-peer-action="delete" data-peer-row-id="${escapeHtml(peer.id)}">删除</button></div>
    </article>`).join("") : `<div class="empty-cell">${state.peers.length ? "没有符合筛选条件的同行。" : "暂无同行。"}</div>`;
  }

  // —— 关系汇总：总数 + 互补 / 竞争 / 互相推荐三条关系各自的家人数 ——
  const setCount = (id: string, value: number) => {
    const node = qs<HTMLElement>(`#${id}`);
    if (node) node.textContent = String(value);
  };
  setCount("peerTotalCount", state.peers.length);
  setCount("peerComplementCount", state.peers.filter((item) => item.relations.includes("互补")).length);
  setCount("peerRivalCount", state.peers.filter((item) => item.relations.includes("竞争")).length);
  setCount("peerReferralCount", state.peers.filter((item) => item.relations.includes("互相推荐")).length);

  // —— 事件：桌面表格行与移动卡片共用同一批 data-* 标记，一次绑完 ——
  const scope = qs<HTMLElement>("#peers");
  if (scope) {
    qsa<HTMLButtonElement>("[data-open-peer]", scope).forEach((button) => button.addEventListener("click", () => {
      const peer = state.peers.find((item) => item.id === button.dataset.openPeer);
      if (!peer) return;
      state.selectedPeerId = peer.id;
      renderPeerDrawer(peer);
      openPeerDrawer();
      qsa<HTMLElement>("tr[data-peer-id]", tbody).forEach((row) => row.classList.toggle("selected", row.dataset.peerId === peer.id));
    }));
    qsa<HTMLButtonElement>("[data-peer-action]", scope).forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const peer = state.peers.find((item) => item.id === button.dataset.peerRowId);
      if (!peer) return;
      if (button.dataset.peerAction === "edit") openPeerModal(peer);
      if (button.dataset.peerAction === "delete") void deletePeer(peer);
    }));
  }
  qs<HTMLButtonElement>("#peerEmptyReset")?.addEventListener("click", resetPeerFilters);

  // 抽屉开着时同步刷新（编辑保存 / 删除后仍显示最新内容）
  const selected = state.peers.find((item) => item.id === state.selectedPeerId);
  if (selected && qs("#peerDrawer")?.classList.contains("open")) renderPeerDrawer(selected);
}

/** 同行详情抽屉：与「未成交客户」同一个右侧抽屉形态，只读展示 + 编辑 / 删除入口 */
function renderPeerDrawer(peer?: Peer) {
  const drawer = qs<HTMLElement>("#peerDrawer");
  if (!drawer || !peer) return;
  const websiteUrl = peer.website
    ? (/^https?:\/\//i.test(peer.website) ? peer.website : `https://${peer.website.replace(/^\/+/, "")}`)
    : "";
  const websiteHost = websiteUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const contactItems = [peer.contact, peer.email, peer.phone, peer.wechat, peer.website].filter(Boolean).length;
  drawer.innerHTML = `
    <div class="drawer-head">
      <div>
        <h2>${escapeHtml(peer.company)}</h2>
        <p>${escapeHtml(peer.country || "国家待补充")} · ${escapeHtml(peer.contact || "联系人待补充")} · ${escapeHtml(peer.source || "来源未登记")}</p>
        <div class="peer-drawer-relations">${peerRelationBadges(peer)}</div>
      </div>
      <div class="inline-actions"><button class="btn icon-only" id="peerDrawerClose" type="button" title="关闭" aria-label="关闭同行详情">×</button></div>
    </div>
    <div class="info-grid">
      <div class="info"><span>关系标注</span><b>${peer.relations.length ? escapeHtml(peer.relations.join(" / ")) : "未标注"}</b></div>
      <div class="info"><span>国家 / 地区</span><b>${escapeHtml(peer.country || "待补充")}</b></div>
      <div class="info"><span>来源</span><b>${escapeHtml(peer.source || "未登记")}</b></div>
      <div class="info"><span>添加时间</span><b>${escapeHtml(formatLeadDate(peer.createdAt))}</b></div>
      <div class="info"><span>最近更新</span><b>${peer.updatedAt ? escapeHtml(formatDateTime(peer.updatedAt)) : "未更新"}</b></div>
      <div class="info"><span>联系方式</span><b>${contactItems} 项</b></div>
    </div>
    <section class="peer-drawer-block">
      <h3>联系方式</h3>
      <div class="info-grid">
        <div class="info"><span>主联系人</span><b>${escapeHtml(peer.contact || "未维护")}</b></div>
        <div class="info"><span>邮箱</span><b>${peer.email ? `<a href="mailto:${escapeHtml(peer.email)}">${escapeHtml(peer.email)}</a>` : "未维护"}</b></div>
        <div class="info"><span>电话</span><b>${peer.phone ? `<a href="tel:${escapeHtml(peer.phone.replace(/\s+/g, ""))}">${escapeHtml(peer.phone)}</a>` : "未维护"}</b></div>
        <div class="info"><span>微信 / WhatsApp</span><b>${escapeHtml(peer.wechat || "未维护")}</b></div>
        <div class="info"><span>官网</span><b>${websiteUrl ? `<a href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(websiteHost)}</a>` : "未维护"}</b></div>
      </div>
    </section>
    <section class="peer-drawer-block">
      <h3>行业介绍</h3>
      <p class="peer-drawer-text">${peer.industry ? escapeHtml(peer.industry) : "暂未维护这家同行的主营业务、产品线与市场覆盖。"}</p>
    </section>
    <section class="peer-drawer-block">
      <h3>备注</h3>
      <p class="peer-drawer-text">${peer.remark ? escapeHtml(peer.remark) : "暂未维护合作历史与注意事项。"}</p>
    </section>
    <div class="inline-actions peer-drawer-actions">
      <button class="btn primary" type="button" data-peer-drawer-edit>编辑同行</button>
      <button class="btn danger" type="button" data-peer-drawer-delete>删除同行</button>
    </div>`;
  qs("#peerDrawerClose", drawer)?.addEventListener("click", closePeerDrawer);
  qsa<HTMLButtonElement>("[data-peer-drawer-edit]", drawer).forEach((button) => button.addEventListener("click", () => openPeerModal(peer)));
  qs<HTMLButtonElement>("[data-peer-drawer-delete]", drawer)?.addEventListener("click", () => void deletePeer(peer));
}

function openPeerDrawer() {
  qs("#peerDrawer")?.classList.add("open");
  qs("#peerDrawerBackdrop")?.classList.add("active");
  document.body.classList.add("customer-drawer-open");
}

export function closePeerDrawer() {
  qs("#peerDrawer")?.classList.remove("open");
  qs("#peerDrawerBackdrop")?.classList.remove("active");
  // 客户抽屉也复用同一个 body 类，别把它一起解锁了
  if (!qs("#customerDrawer")?.classList.contains("open")) document.body.classList.remove("customer-drawer-open");
}

export function openPeerModal(peer?: Peer) {
  const editing = Boolean(peer);
  const relations = peer?.relations || [];
  const relationCheckbox = (relation: PeerRelation) => `<label class="peer-relation-option"><input type="checkbox" name="peerRelation" value="${relation}" ${relations.includes(relation) ? "checked" : ""}>${badge(relation, PEER_RELATION_TONE[relation])}</label>`;
  openModal(editing ? "编辑同行" : "新增同行", `
    <p class="modal-hint">同行 = 同行业的外贸公司。关系可多选：互补（产品/市场互补）、竞争（同赛道）、互相推荐（转介绍伙伴）。</p>
    <div class="form-grid">
      <div class="form-field"><label>公司名 *</label><input id="peerCompanyInput" value="${escapeHtml(peer?.company || "")}" placeholder="例如：Acme Instruments GmbH"></div>
      <div class="form-field"><label>国家 / 地区</label><input id="peerCountryInput" value="${escapeHtml(peer?.country || "")}" placeholder="例如：德国"></div>
      <div class="form-field full"><label>关系（可多选）</label><div class="peer-relation-row">${(["互补", "竞争", "互相推荐"] as PeerRelation[]).map(relationCheckbox).join("")}</div></div>
      <div class="form-field full"><label>行业介绍</label><textarea id="peerIndustryInput" rows="3" maxlength="4000" placeholder="主营业务、产品线、规模、市场覆盖等">${escapeHtml(peer?.industry || "")}</textarea></div>
      <div class="form-field"><label>联系人</label><input id="peerContactInput" value="${escapeHtml(peer?.contact || "")}"></div>
      <div class="form-field"><label>电话</label><input id="peerPhoneInput" value="${escapeHtml(peer?.phone || "")}"></div>
      <div class="form-field"><label>邮箱</label><input id="peerEmailInput" type="email" value="${escapeHtml(peer?.email || "")}"></div>
      <div class="form-field"><label>微信 / WhatsApp</label><input id="peerWechatInput" value="${escapeHtml(peer?.wechat || "")}"></div>
      <div class="form-field full"><label>官网</label><input id="peerWebsiteInput" value="${escapeHtml(peer?.website || "")}" placeholder="例如 https://example.com"></div>
      <div class="form-field"><label>来源</label><input id="peerSourceInput" value="${escapeHtml(peer?.source || (editing ? "" : "手动新增"))}" placeholder="展会、LinkedIn、转介绍等"></div>
      <div class="form-field full"><label>备注</label><textarea id="peerRemarkInput" rows="2" maxlength="2000" placeholder="合作历史、注意事项等">${escapeHtml(peer?.remark || "")}</textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="savePeerButton" data-editing-id="${escapeHtml(peer?.id || "")}">${editing ? "保存修改" : "保存同行"}</button>`, { closeOnBackdrop: false });
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#savePeerButton")?.addEventListener("click", () => void savePeer());
  qs<HTMLInputElement>("#peerCompanyInput")?.focus();
}

async function savePeer() {
  const company = qs<HTMLInputElement>("#peerCompanyInput")?.value.trim() || "";
  if (!company) {
    toast("请填写公司名", "error");
    return;
  }
  const saveButton = qs<HTMLButtonElement>("#savePeerButton");
  const editingId = saveButton?.dataset.editingId || "";
  const relations = qsa<HTMLInputElement>('input[name="peerRelation"]:checked').map((node) => node.value as PeerRelation);
  const payload = {
    company,
    country: qs<HTMLInputElement>("#peerCountryInput")?.value.trim() || "",
    industry: qs<HTMLTextAreaElement>("#peerIndustryInput")?.value.trim() || "",
    relations,
    contact: qs<HTMLInputElement>("#peerContactInput")?.value.trim() || "",
    phone: qs<HTMLInputElement>("#peerPhoneInput")?.value.trim() || "",
    email: qs<HTMLInputElement>("#peerEmailInput")?.value.trim() || "",
    wechat: qs<HTMLInputElement>("#peerWechatInput")?.value.trim() || "",
    website: qs<HTMLInputElement>("#peerWebsiteInput")?.value.trim() || "",
    source: qs<HTMLInputElement>("#peerSourceInput")?.value.trim() || (editingId ? "" : "手动新增"),
    remark: qs<HTMLTextAreaElement>("#peerRemarkInput")?.value.trim() || ""
  };
  try {
    if (editingId) {
      const result = await api<{ peer: Peer }>(`/api/peers/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
      state.peers = state.peers.map((item) => item.id === result.peer.id ? result.peer : item);
      toast("同行已保存");
    } else {
      const result = await api<{ peer: Peer }>("/api/peers", { method: "POST", body: JSON.stringify(payload) });
      state.peers.unshift(result.peer);
      toast("同行已新增");
    }
    closeModal();
    renderPeers();
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
  }
}

/** 同行批量导入：列名 → 字段映射（表头识别用，键全部小写去空格） */
const PEER_IMPORT_ALIAS: Record<string, string> = {
  "公司": "company", "公司名": "company", "company": "company",
  "国家": "country", "国家/地区": "country", "地区": "country", "country": "country",
  "关系": "relations", "关系标注": "relations", "relations": "relations",
  "联系人": "contact", "contact": "contact",
  "电话": "phone", "手机": "phone", "phone": "phone",
  "邮箱": "email", "email": "email",
  "微信": "wechat", "wechat": "wechat", "whatsapp": "wechat",
  "官网": "website", "网站": "website", "网址": "website", "website": "website",
  "来源": "source", "source": "source",
  "备注": "remark", "remark": "remark", "note": "remark"
};
const PEER_IMPORT_ORDER = ["company", "country", "relations", "contact", "phone", "email", "wechat", "website", "source", "remark"] as const;

/** 解析粘贴的 CSV/TSV 文本：支持带引号转义的字段；首行若含列名则按表头映射，否则按固定列序 */
function parsePeerImportText(text: string): { rows: Array<Record<string, string>>; errors: string[] } {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], errors: ["没有可导入的内容"] };
  const delim = lines[0]!.includes("\t") ? "\t" : ",";
  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === "\"") {
        if (inQuotes && line[i + 1] === "\"") { cur += "\""; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === delim && !inQuotes) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((cell) => cell.trim());
  };
  const firstCells = splitLine(lines[0]!);
  const hasHeader = firstCells.some((cell) => PEER_IMPORT_ALIAS[cell.toLowerCase().replace(/\s+/g, "")]);
  const colIndex: Partial<Record<string, number>> = {};
  let dataLines = lines;
  if (hasHeader) {
    firstCells.forEach((cell, index) => {
      const key = PEER_IMPORT_ALIAS[cell.toLowerCase().replace(/\s+/g, "")];
      if (key && colIndex[key] === undefined) colIndex[key] = index;
    });
    dataLines = lines.slice(1);
    if (colIndex.company === undefined) errors.push("表头里没找到「公司名」列，无法识别哪列是公司名");
  } else {
    PEER_IMPORT_ORDER.forEach((key, index) => { colIndex[key] = index; });
  }
  const rows: Array<Record<string, string>> = [];
  dataLines.forEach((line, idx) => {
    const cells = splitLine(line);
    const row: Record<string, string> = {};
    for (const key of PEER_IMPORT_ORDER) {
      const i = colIndex[key];
      row[key] = i === undefined ? "" : (cells[i] || "");
    }
    if (!row.company) {
      errors.push(`第 ${idx + (hasHeader ? 2 : 1)} 行缺少公司名，已跳过`);
      return;
    }
    rows.push(row);
  });
  return { rows, errors };
}

/** 关系文本 → 枚举数组，未识别的词忽略 */
function peerRelationsFromText(text: string): PeerRelation[] {
  return text.split(/[，,、/|;；]/).map((part) => part.trim())
    .filter((part): part is PeerRelation => (["互补", "竞争", "互相推荐"] as string[]).includes(part));
}

export function openPeerImportModal() {
  const example = "公司名,国家,关系,联系人,邮箱,官网\nAcme Trading GmbH,德国,互补,Anna,anna@acme.de,https://acme.de\nNorth Scale Ltd,英国,竞争;互相推荐,John,john@northscale.co.uk,";
  const body = `
    <p class="modal-hint">支持粘贴 CSV / Excel 复制内容（Tab 分隔）或选文件。首行如果写了列名（公司名/国家/关系/联系人/电话/邮箱/微信/官网/来源/备注）会自动识别；没写列名则按这个顺序读。<b>公司名必填</b>，其余可留空。</p>
    <div class="form-field"><label>选择文件（.csv / .txt，可选）</label><input id="peerImportFile" type="file" accept=".csv,.txt,.tsv"></div>
    <div class="form-field"><label>或直接粘贴内容</label><textarea id="peerImportText" rows="10" style="font-family:var(--font-mono,monospace);font-size:12px" placeholder="${escapeHtml(example)}"></textarea></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:12px"><input id="peerImportSkipDuplicates" type="checkbox" checked>跳过与现有同行重复的记录（公司名+国家相同）</label>
    <details style="margin-top:8px"><summary style="cursor:pointer;color:#1570ef;font-size:11px">查看格式示例</summary><pre style="margin:8px 0 0;padding:10px;background:#f6f8fb;border:1px solid #e4eaf3;border-radius:8px;font-size:11px;white-space:pre-wrap">${escapeHtml(example)}</pre></details>`;
  const foot = `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="peerImportSubmitButton">开始导入</button>`;
  openModal("批量导入同行", body, foot, { closeOnBackdrop: false });
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs<HTMLInputElement>("#peerImportFile")?.addEventListener("change", async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const text = await file.text();
    const textarea = qs<HTMLTextAreaElement>("#peerImportText");
    if (textarea) textarea.value = text;
  });
  qs<HTMLButtonElement>("#peerImportSubmitButton")?.addEventListener("click", (event) => void submitPeerImport(event.currentTarget as HTMLButtonElement));
}

async function submitPeerImport(button: HTMLButtonElement) {
  const textarea = qs<HTMLTextAreaElement>("#peerImportText");
  const parsed = parsePeerImportText(textarea?.value || "");
  if (!parsed.rows.length) {
    toast(parsed.errors[0] || "没有可导入的行", "error");
    return;
  }
  const skipDuplicates = qs<HTMLInputElement>("#peerImportSkipDuplicates")?.checked ?? true;
  const payload = parsed.rows.map((row) => ({
    company: row.company,
    country: row.country || "",
    relations: peerRelationsFromText(row.relations),
    contact: row.contact || "",
    phone: row.phone || "",
    email: row.email || "",
    wechat: row.wechat || "",
    website: row.website || "",
    source: row.source || "批量导入",
    remark: row.remark || ""
  }));
  button.disabled = true;
  try {
    const result = await api<{ created: number; skipped: Array<{ company: string; reason: string }>; peers: Peer[] }>("/api/peers/import", {
      method: "POST",
      body: JSON.stringify({ peers: payload, skipDuplicates })
    });
    state.peers = result.peers;
    state.peerPage = 1;
    renderPeers();
    closeModal();
    toast(`导入完成：成功 ${result.created} 条${result.skipped.length ? `，跳过 ${result.skipped.length} 条重复记录` : ""}`, result.created ? "success" : "error");
    if (result.skipped.length) {
      const list = result.skipped.slice(0, 30).map((item) => `<li>${escapeHtml(item.company)} — ${escapeHtml(item.reason)}</li>`).join("");
      const more = result.skipped.length > 30 ? `<li>…另有 ${result.skipped.length - 30} 条</li>` : "";
      openModal("已跳过的记录", `<ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.9;color:#475467">${list}${more}</ul>`, `<button class="btn primary" data-modal-close>知道了</button>`);
      qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : "导入失败", "error");
  } finally {
    button.disabled = false;
  }
}

async function deletePeer(peer: Peer) {
  const ok = await confirmAction({
    title: "删除同行",
    message: `确定删除同行「${peer.company}」吗？`,
    consequences: ["该同行的关系标注、行业介绍、联系方式等资料会一并删除", "删除后不可恢复"],
    confirmLabel: "删除",
    tone: "danger"
  });
  if (!ok) return;
  try {
    const result = await api<{ deleted: string; peers: Peer[] }>(`/api/peers/${peer.id}`, { method: "DELETE" });
    state.peers = result.peers;
    if (state.selectedPeerId === peer.id) state.selectedPeerId = null;
    closePeerDrawer();
    toast("同行已删除");
    renderPeers();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败", "error");
  }
}

export function renderCaseStudies(caseStudies: CaseStudy[]) {
  const sorted = [...caseStudies].sort((a, b) => Number(b.status === "published") - Number(a.status === "published") || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const list = qs<HTMLElement>("#cases .case-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((item) => `<article class="case-card ${state.selectedCaseId === item.id ? "selected" : ""}" data-case-id="${escapeHtml(item.id)}">
      <div class="case-top"><h3>${escapeHtml(item.title)}</h3>${badge(caseStatusText(item.status), item.status === "published" ? "green" : "amber")}</div>
      <div class="case-meta"><span>${escapeHtml(item.customer || "未关联客户")}</span><span>${escapeHtml(item.product || "未维护产品")}</span><span>${escapeHtml(item.country || "未知国家")}</span></div>
      <p>${escapeHtml(item.result || "暂未填写成果")}</p>
    </article>`).join("") : `<div class="todo-history-empty">暂无成功案例</div>`;
    qsa<HTMLElement>(".case-card", list).forEach((card) => {
      card.addEventListener("click", () => {
        state.selectedCaseId = card.dataset.caseId || null;
        renderCaseStudies(state.caseStudies);
      });
    });
  }
  qs("#case-total-count")!.textContent = String(caseStudies.length);
  qs("#case-published-count")!.textContent = String(caseStudies.filter((item) => item.status === "published").length);
  qs("#case-product-count")!.textContent = String(new Set(caseStudies.map((item) => item.product).filter(Boolean)).size);
  qs("#case-draft-count")!.textContent = String(caseStudies.filter((item) => item.status !== "published").length);
  renderCaseDetail(sorted.find((item) => item.id === state.selectedCaseId) || sorted[0]);
}

function renderCaseDetail(caseStudy?: CaseStudy) {
  if (!caseStudy) {
    qs("#case-detail-title")!.textContent = "成功案例详情";
    qs("#case-detail-meta")!.textContent = "";
    qs("#case-product")!.textContent = "暂无记录";
    qs("#case-result")!.textContent = "暂无记录";
    qs("#case-industry")!.textContent = "暂无记录";
    qs("#case-story")!.textContent = "暂无记录";
    qs("#case-reusable")!.textContent = "暂无记录";
    const button = qs<HTMLButtonElement>("#casePublishButton");
    if (button) button.textContent = "发布案例";
    return;
  }
  state.selectedCaseId = caseStudy.id;
  qs("#case-detail-title")!.textContent = caseStudy.title;
  qs("#case-detail-meta")!.textContent = `${caseStudy.customer || "未关联客户"} · ${caseStudy.country || "未知国家"} · ${caseStatusText(caseStudy.status)}`;
  qs("#case-product")!.textContent = caseStudy.product || "暂未维护";
  qs("#case-result")!.textContent = caseStudy.result || "暂未维护";
  qs("#case-industry")!.textContent = caseStudy.industry || "暂未维护";
  qs("#case-story")!.textContent = caseStudy.story || "暂未维护";
  qs("#case-reusable")!.textContent = caseStudy.reusablePoints || "暂未维护";
  const button = qs<HTMLButtonElement>("#casePublishButton");
  if (button) button.textContent = caseStudy.status === "published" ? "已发布" : "发布案例";
}

export function setMemoSaveState(text: string, retry = false) {
  const node = qs<HTMLButtonElement>("#memoSaveState");
  if (node) {
    node.textContent = text;
    node.classList.toggle("needs-retry", retry);
    node.disabled = !retry;
  }
}

export function reminderTimeUnitText(timeUnit?: string) {
  return timeUnit === "minute" ? "分钟" : timeUnit === "hour" ? "小时" : timeUnit === "week" ? "周" : "天";
}

/** 当前正在编辑/新建的规则（表单提示要按规则 id 找它名下的「活的」待办）。 */
let editingReminder: Reminder | undefined;

function reminderGenerateTodoChecked() {
  return Boolean(qs<HTMLInputElement>("#reminderGenerateTodoInput")?.checked);
}

/** 规则名下「活的」待办数（未完成、未归档、未取消）—— 与后端 shouldSkipReminderMatch 口径一致。 */
function liveReminderTodoCount(ruleId?: string) {
  if (!ruleId) return 0;
  return state.todos.filter((todo) => todo.reminderRuleId === ruleId && !todo.done && !todo.historyAt && !todo.cancelledAt).length;
}

/**
 * 表单里那条随勾选/阈值实时变化的说明：讲清这次会不会生成待办、以及生成的判定规则，
 * 免得「待办悄悄挡住后续提醒」这种事要靠翻代码才知道。
 */
function updateReminderGenerateHint() {
  const node = qs<HTMLElement>("#reminderGenerateHint");
  if (!node) return;
  const days = qs<HTMLInputElement>("#reminderDaysInput")?.value || "3";
  const unit = reminderTimeUnitText(qs<HTMLSelectElement>("#reminderTimeUnitInput")?.value);
  const span = `${days} ${unit}`;
  const live = liveReminderTodoCount(editingReminder?.id);
  const tone = !reminderGenerateTodoChecked() ? "off" : live ? "warn" : "on";
  const strongColor = tone === "off" ? "var(--text)" : tone === "on" ? "var(--brand-strong)" : "var(--amber)";
  const strong = (text: string) => `<b style="font-weight:600;color:${strongColor}">${text}</b>`;
  node.dataset.tone = tone;
  node.style.cssText = `display:block;padding:9px 11px;border:1px solid transparent;border-radius:6px;font-size:12px;line-height:1.65;${{
    off: "background:var(--surface-2);border-color:var(--line-soft);color:var(--muted)",
    on: "background:var(--brand-tint);color:var(--brand-strong)",
    warn: "background:var(--amber-tint);color:var(--amber)"
  }[tone]}`;
  node.innerHTML = tone === "off"
    ? `${strong("不会生成待办：")}规则仍会按周期自动匹配、更新「命中 N 条」的统计，但不会在待办中心产生任何任务，也就不占用你的待办队列。`
    : tone === "warn"
      ? `${strong(`当前已存在 ${live} 条未完成待办，本轮不会生成新的提醒和待办。`)}把这 ${live} 条处理完（标记完成）后，再过 ${escapeHtml(span)} 会自动重新生成一条。`
      : `${strong("命中后会生成待办：")}出现在左侧导航的「待办中心」与「提醒」模块里；该客户若已有未完成待办则跳过、不重复催办，待办完成后按 ${escapeHtml(span)} 重新计时再提醒。`;
}

export function openReminderModal(reminder?: Reminder) {
  const type = reminder?.ruleType || "quote_no_reply";
  const stage = reminder?.targetStage || "已报价";
  const days = reminder?.days ?? 3;
  const unit = reminder?.timeUnit || "day";
  // 「生成待办中心任务」：新建规则默认不勾选（只匹配统计、不打扰）；编辑历史规则沿用其存值。
  const generateTodoChecked = reminder ? reminder.generateTodo !== false : false;
  editingReminder = reminder;
  const selectedCustomerIds = new Set(reminder?.targetCustomerIds || []);
  const customerOptions = state.customers
    .slice()
    .sort((left, right) => left.company.localeCompare(right.company, "zh-CN"));
  openModal(reminder ? "编辑提醒规则" : "设置提醒规则", `
    <div class="form-grid">
      <div class="form-field full"><label>规则模板</label><select id="reminderRuleTypeInput"><option value="quote_no_reply" ${type === "quote_no_reply" ? "selected" : ""}>已报价阶段停滞</option><option value="sample_feedback" ${type === "sample_feedback" ? "selected" : ""}>进入样品阶段后待确认</option><option value="inactive_customer" ${type === "inactive_customer" ? "selected" : ""}>长期未产生客户活动</option><option value="high_value_revisit" ${type === "high_value_revisit" ? "selected" : ""}>高价值客户复访</option><option value="custom_due" ${type === "custom_due" ? "selected" : ""}>商机下一动作到期</option></select></div>
      <div class="form-field full"><label>提醒名称</label><input id="reminderTitleInput" data-auto-title="${reminder ? "false" : "true"}" value="${escapeHtml(reminder?.title || "报价阶段停滞提醒")}"></div>
      <div class="form-field"><label>适用阶段</label><select id="reminderStageInput">${["已报价", "样品", "谈判", "询盘", "已联系", "成交", "丢单"].map((item) => `<option ${item === stage ? "selected" : ""}>${item}</option>`).join("")}</select></div>
      <div class="form-field"><label>触发间隔</label><div style="display:flex;gap:6px"><input id="reminderDaysInput" type="number" min="0" max="365" value="${days}" style="flex:1;min-width:0"><select id="reminderTimeUnitInput" style="width:82px;flex:0 0 auto"><option value="minute" ${unit === "minute" ? "selected" : ""}>分钟</option><option value="day" ${unit === "day" ? "selected" : ""}>天</option><option value="hour" ${unit === "hour" ? "selected" : ""}>小时</option><option value="week" ${unit === "week" ? "selected" : ""}>周</option></select></div></div>
      <div class="form-field"><label>任务时间说明</label><input id="reminderDueInput" value="${escapeHtml(reminder?.dueAt || "按触发日期生成")}"></div>
      <label class="form-field full" style="display:flex;gap:8px;align-items:center;cursor:pointer"><input id="reminderGenerateTodoInput" type="checkbox" ${generateTodoChecked ? "checked" : ""}><span>生成待办中心任务 <em style="font-style:normal;font-weight:normal;color:#8a94a6">（默认不勾选）</em></span></label>
      <div class="form-field full"><div class="reminder-generate-hint" id="reminderGenerateHint"></div></div>
      <div class="form-field"><label>优先级</label><select id="reminderPriorityInput"><option value="high">高优先级</option><option value="medium" selected>中优先级</option><option value="normal">普通</option></select></div>
      <label class="form-field"><span>规则状态</span><select id="reminderEnabledInput"><option value="true">启用</option><option value="false">停用</option></select></label>
      <div class="form-field full"><label>规则说明</label><input id="reminderRuleInput" value="${escapeHtml(reminder?.rule || "进入已报价阶段 3 天未更新时生成站内任务")}"></div>
      <div class="form-field full">
        <label>关联客户 <span style="color:#8a94a6;font-weight:normal">（不勾选 = 对全部客户生效）</span></label>
        <input id="reminderCustomerSearch" placeholder="搜索客户名筛选列表" style="margin-bottom:6px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span id="reminderCustomerCount" style="font-size:11px;color:#5c6b80">已选 0 家</span>
          <span><button class="btn" type="button" id="reminderCustomerSelectAll" style="min-height:26px;padding:2px 10px;font-size:11px">全选</button> <button class="btn" type="button" id="reminderCustomerClear" style="min-height:26px;padding:2px 10px;font-size:11px">清空</button></span>
        </div>
        <div id="reminderCustomerList" style="max-height:190px;overflow-y:auto;border:1px solid #dde4ee;border-radius:8px;padding:6px">
          ${customerOptions.length ? customerOptions.map((customer) => `<label style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;cursor:pointer" data-reminder-customer-row data-company="${escapeHtml(customer.company.toLowerCase())}"><input type="checkbox" data-reminder-customer value="${escapeHtml(customer.id)}" ${selectedCustomerIds.has(customer.id) ? "checked" : ""}><span style="font-size:12px">${escapeHtml(customer.company)}<small style="color:#8a94a6"> · ${escapeHtml(customer.country || "地区未知")}</small></span></label>`).join("") : `<div style="padding:12px;text-align:center;color:#8a94a6;font-size:11px">暂无客户</div>`}
        </div>
      </div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReminderButton">${reminder ? "保存修改" : "保存规则"}</button>`, { closeOnBackdrop: false });
  const priority = qs<HTMLSelectElement>("#reminderPriorityInput");
  if (priority) priority.value = reminder?.priority || "medium";
  const enabled = qs<HTMLSelectElement>("#reminderEnabledInput");
  if (enabled) enabled.value = reminder?.enabled === false ? "false" : "true";
  bindReminderRulePreset(!reminder);
  bindReminderCustomerPicker();
  updateReminderGenerateHint();
  qs("#saveReminderButton")?.addEventListener("click", () => void saveReminder(reminder?.id));
}

function bindReminderCustomerPicker() {
  const list = qs<HTMLElement>("#reminderCustomerList");
  if (!list) return;
  const countLabel = qs<HTMLElement>("#reminderCustomerCount");
  const updateCount = () => {
    const checked = qsa<HTMLInputElement>("[data-reminder-customer]:checked", list).length;
    if (countLabel) countLabel.textContent = `已选 ${checked} 家`;
  };
  qsa<HTMLInputElement>("[data-reminder-customer]", list).forEach((box) => box.addEventListener("change", updateCount));
  qs<HTMLInputElement>("#reminderCustomerSearch")?.addEventListener("input", (event) => {
    const keyword = (event.currentTarget as HTMLInputElement).value.trim().toLowerCase();
    qsa<HTMLElement>("[data-reminder-customer-row]", list).forEach((row) => {
      row.style.display = !keyword || row.dataset.company?.includes(keyword) ? "" : "none";
    });
  });
  qs("#reminderCustomerSelectAll")?.addEventListener("click", () => {
    qsa<HTMLInputElement>("[data-reminder-customer]", list).forEach((box) => {
      if (box.closest<HTMLElement>("[data-reminder-customer-row]")?.style.display !== "none") box.checked = true;
    });
    updateCount();
  });
  qs("#reminderCustomerClear")?.addEventListener("click", () => {
    qsa<HTMLInputElement>("[data-reminder-customer]", list).forEach((box) => { box.checked = false; });
    updateCount();
  });
  updateCount();
}

function reminderRulePreset(type: string) {
  if (type === "sample_feedback") {
    return { title: "样品阶段待确认", stage: "样品", days: "3" };
  }
  if (type === "inactive_customer") {
    return { title: "长期未联系提醒", days: "14" };
  }
  if (type === "high_value_revisit") {
    return { title: "高价值客户复访", days: "7" };
  }
  if (type === "custom_due") {
    return { title: "商机下一动作到期提醒" };
  }
  return { title: "报价阶段停滞提醒", stage: "已报价", days: "3" };
}

function reminderRuleDraft(applyPreset = false) {
  const type = qs<HTMLSelectElement>("#reminderRuleTypeInput")?.value || "quote_no_reply";
  const stageInput = qs<HTMLSelectElement>("#reminderStageInput");
  const daysInput = qs<HTMLInputElement>("#reminderDaysInput");
  const titleInput = qs<HTMLInputElement>("#reminderTitleInput");
  const preset = reminderRulePreset(type);
  if (applyPreset) {
    if (stageInput && preset.stage) stageInput.value = preset.stage;
    if (daysInput && preset.days) daysInput.value = preset.days;
    if (titleInput && titleInput.dataset.autoTitle !== "false") {
      titleInput.value = preset.title;
      titleInput.dataset.autoTitle = "true";
    }
  }
  const ruleInput = qs<HTMLInputElement>("#reminderRuleInput");
  const stage = qs<HTMLSelectElement>("#reminderStageInput")?.value || "已报价";
  const days = qs<HTMLInputElement>("#reminderDaysInput")?.value || "3";
  const unit = reminderTimeUnitText(qs<HTMLSelectElement>("#reminderTimeUnitInput")?.value);
  if (ruleInput) {
    ruleInput.value = reminderGenerateTodoChecked()
      ? `${stage}阶段 ${days} ${unit}未更新时生成站内任务`
      : `${stage}阶段 ${days} ${unit}未更新时提醒（仅统计，不生成待办）`;
  }
  updateReminderGenerateHint();
}

/**
 * 绑定「规则模板」联动。
 * ⚠️ `isNewRule = false`（编辑已有规则）时**只绑事件、绝不套模板预设**：
 * 否则一打开编辑弹窗，触发间隔就会被预设覆盖（如「长期未产生客户活动」预设 14），
 * 用户直接点保存就把库里的 1 分钟阈值静默改成了 14。模板预设只对「新建规则」生效，
 * 或在用户主动切换规则模板（select change）时生效。
 */
function bindReminderRulePreset(isNewRule = true) {
  qs<HTMLInputElement>("#reminderTitleInput")?.addEventListener("input", (event) => {
    (event.currentTarget as HTMLInputElement).dataset.autoTitle = "false";
  });
  qs<HTMLElement>("#reminderRuleTypeInput")?.addEventListener("change", () => reminderRuleDraft(true));
  ["#reminderStageInput", "#reminderDaysInput", "#reminderTimeUnitInput"].forEach((selector) => {
    qs<HTMLElement>(selector)?.addEventListener("change", () => reminderRuleDraft());
    qs<HTMLElement>(selector)?.addEventListener("input", () => reminderRuleDraft());
  });
  qs<HTMLElement>("#reminderGenerateTodoInput")?.addEventListener("change", () => reminderRuleDraft());
  if (isNewRule) reminderRuleDraft(true);
  else updateReminderGenerateHint();
}

async function saveReminder(id?: string) {
  const title = qs<HTMLInputElement>("#reminderTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写提醒名称", "error");
    return;
  }
  const result = await api<{ reminder: Reminder }>(id ? `/api/reminders/${id}` : "/api/reminders", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify({
      title,
      rule: qs<HTMLInputElement>("#reminderRuleInput")?.value || "已报价阶段超过设定天数未更新",
      dueAt: qs<HTMLInputElement>("#reminderDueInput")?.value || "今天",
      channel: "站内",
      ruleType: qs<HTMLSelectElement>("#reminderRuleTypeInput")?.value || "quote_no_reply",
      targetStage: qs<HTMLSelectElement>("#reminderStageInput")?.value || "已报价",
      days: Number(qs<HTMLInputElement>("#reminderDaysInput")?.value || 3),
      timeUnit: (qs<HTMLSelectElement>("#reminderTimeUnitInput")?.value || "day") as "minute" | "day" | "hour" | "week",
      targetCustomerIds: qsa<HTMLInputElement>("#reminderCustomerList [data-reminder-customer]:checked").map((box) => box.value),
      generateTodo: reminderGenerateTodoChecked(),
      priority: qs<HTMLSelectElement>("#reminderPriorityInput")?.value || "medium",
      enabled: qs<HTMLSelectElement>("#reminderEnabledInput")?.value !== "false"
    })
  });
  state.reminders = id
    ? state.reminders.map((item) => item.id === id ? result.reminder : item)
    : [result.reminder, ...state.reminders];
  state.reminderView = "rules";
  renderReminders(state.reminders);
  closeModal();
  toast(id ? "提醒规则已更新" : "提醒规则已保存，可先预览再手工运行");
}

async function runReminderRule(id: string, button?: HTMLButtonElement) {
  if (!id) return;
  try {
    const preview = await api<{ matchedCount: number; creatableCount: number; skippedCount: number; preview: Array<{ customer: string; deal: string }> }>(`/api/reminders/${id}/preview`);
    const sample = preview.preview.map((item) => `${item.customer}${item.deal ? ` / ${item.deal}` : ""}`).join("、") || "无";
    const generates = state.reminders.find((item) => item.id === id)?.generateTodo !== false;
    if (!await confirmAction({
      title: "手工运行提醒规则",
      message: generates
        ? `预计命中 ${preview.matchedCount} 条记录，可新建 ${preview.creatableCount} 条提醒。`
        : `预计命中 ${preview.matchedCount} 条记录；该规则未勾选「生成待办中心任务」，本次只刷新命中统计，不会产生待办。`,
      detail: sample,
      detailLabel: "命中示例",
      consequences: generates
        ? [`将跳过 ${preview.skippedCount} 条重复或不符合条件的记录`, "新提醒会立即加入当前账号的待办队列"]
        : [`将跳过 ${preview.skippedCount} 条（未开启生成待办）`, "不会新增任何待办；需要生成请先编辑规则勾选「生成待办中心任务」"],
      confirmLabel: "运行规则",
      tone: "normal"
    })) return;
    if (button) {
      button.disabled = true;
      button.textContent = "运行中";
    }
    const result = await api<{ reminder: Reminder; createdCount: number; matchedCount: number; skippedCount: number; failedCount: number }>(`/api/reminders/${id}/run`, { method: "POST" });
    state.reminders = state.reminders.map((reminder) => reminder.id === result.reminder.id ? result.reminder : reminder);
    const todos = await api<{ todos: Todo[] }>("/api/todos");
    state.todos = todos.todos;
    renderReminders(state.reminders);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    renderTopbarStats();
    toast(`手工运行完成：匹配 ${result.matchedCount}，新建 ${result.createdCount}，跳过 ${result.skippedCount}，失败 ${result.failedCount}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "执行提醒规则失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "手工运行";
    }
  }
}

let editingProblemId = "";

export function openProblemModal(problem?: ProblemItem) {
  editingProblemId = problem?.id || "";
  const categories = [...new Set(["其它", "报价跟进", "资料维护", "工具/OCR", "客户服务", "团队执行", problem?.category || ""].filter(Boolean))];
  const selected = (value: string, current?: string) => value === current ? " selected" : "";
  openModal(problem ? "编辑问题" : "新增问题", `
    <div class="form-grid">
      <div class="form-field full"><label>问题标题</label><input id="problemTitleInput" value="${escapeHtml(problem?.title || "")}" placeholder="例如：客户报价后超过 5 天未回复"></div>
      <div class="form-field"><label>问题类型</label><select id="problemCategoryInput">${categories.map((category) => `<option${selected(category, problem?.category || "其它")}>${escapeHtml(category)}</option>`).join("")}</select></div>
      <div class="form-field"><label>严重程度</label><select id="problemSeverityInput"><option value="medium"${selected("medium", problem?.severity || "medium")}>中</option><option value="high"${selected("high", problem?.severity)}>高</option><option value="low"${selected("low", problem?.severity)}>低</option></select></div>
      <div class="form-field"><label>状态</label><select id="problemStatusInput"><option value="open"${selected("open", problem?.status || "open")}>未解决</option><option value="solving"${selected("solving", problem?.status)}>解决中</option><option value="resolved"${selected("resolved", problem?.status)}>已解决</option></select></div>
      <div class="form-field"><label>关联客户</label><input id="problemCustomerInput" value="${escapeHtml(problem?.relatedCustomer || "")}" placeholder="可选：客户或线索名称"></div>
      <div class="form-field"><label>截止时间</label><input id="problemDueInput" value="${escapeHtml(problem?.dueAt || "")}" placeholder="例如：今天 18:00"></div>
      <div class="form-field full"><label>问题原因</label><textarea id="problemRootInput" placeholder="描述问题产生原因">${escapeHtml(problem?.rootCause || "")}</textarea></div>
      <div class="form-field full problem-solution-field"><label>解决方案</label><textarea id="problemSolutionInput" placeholder="写清楚解决路径、标准和注意事项">${escapeHtml(problem?.solution || "")}</textarea></div>
      <div class="form-field full"><label>下一动作</label><input id="problemNextInput" value="${escapeHtml(problem?.nextAction || "")}" placeholder="例如：今天发送补充资料，明天企微确认"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveProblemButton">${problem ? "保存修改" : "保存问题"}</button>`, { closeOnBackdrop: false });
  qs("#saveProblemButton")?.addEventListener("click", () => void saveProblem());
  qs<HTMLInputElement>("#problemTitleInput")?.focus();
}

async function saveProblem() {
  const title = qs<HTMLInputElement>("#problemTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写问题标题", "error");
    return;
  }
  const button = qs<HTMLButtonElement>("#saveProblemButton");
  const body = {
    title,
    category: qs<HTMLSelectElement>("#problemCategoryInput")?.value || "其它",
    severity: qs<HTMLSelectElement>("#problemSeverityInput")?.value || "medium",
    status: qs<HTMLSelectElement>("#problemStatusInput")?.value || "open",
    relatedCustomer: qs<HTMLInputElement>("#problemCustomerInput")?.value.trim() || "",
    rootCause: qs<HTMLTextAreaElement>("#problemRootInput")?.value.trim() || "",
    solution: qs<HTMLTextAreaElement>("#problemSolutionInput")?.value.trim() || "",
    nextAction: qs<HTMLInputElement>("#problemNextInput")?.value.trim() || "",
    dueAt: qs<HTMLInputElement>("#problemDueInput")?.value.trim() || ""
  };
  try {
    setButtonPending(button, true, editingProblemId ? "保存修改" : "保存问题", "保存中");
    const result = await api<{ problem: ProblemItem }>(editingProblemId ? `/api/problems/${encodeURIComponent(editingProblemId)}` : "/api/problems", {
      method: editingProblemId ? "PATCH" : "POST",
      body: JSON.stringify(body)
    });
    const index = state.problems.findIndex((item) => item.id === result.problem.id);
    if (index >= 0) state.problems[index] = result.problem;
    else state.problems.unshift(result.problem);
    state.selectedProblemId = result.problem.id;
    renderProblems(state.problems);
    closeModal();
    toast(editingProblemId ? "问题已更新" : "问题已新增");
    editingProblemId = "";
  } catch (error) {
    toast(error instanceof Error ? error.message : "问题保存失败", "error");
    setButtonPending(button, false, editingProblemId ? "保存修改" : "保存问题", "保存中");
  }
}

async function advanceProblemStatus(problemId = state.selectedProblemId || "") {
  const problem = state.problems.find((item) => item.id === problemId);
  if (!problem) return;
  const nextStatus = problem.status === "open" ? "solving" : problem.status === "solving" ? "resolved" : "open";
  const result = await api<{ problem: ProblemItem }>(`/api/problems/${problem.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: nextStatus })
  });
  Object.assign(problem, result.problem);
  renderProblems(state.problems);
  toast(`问题状态已更新：${problemStatusText(problem.status)}`);
}

async function deleteSelectedProblem(problemId = state.selectedProblemId || "") {
  const problem = state.problems.find((item) => item.id === problemId);
  if (!problem || !await confirmAction({
    title: "删除问题",
    message: `确定删除“${problem.title}”吗？`,
    consequences: ["该问题记录会从团队问题清单中永久移除", "此操作无法撤销"],
    detail: problem.category,
    detailLabel: "问题分类",
    confirmLabel: "删除问题",
    tone: "danger"
  })) return;
  try {
    await api(`/api/problems/${encodeURIComponent(problem.id)}`, { method: "DELETE" });
    state.problems = state.problems.filter((item) => item.id !== problem.id);
    state.selectedProblemId = null;
    closeProblemDrawer();
    renderProblems(state.problems);
    toast("问题已删除");
  } catch (error) {
    toast(error instanceof Error ? error.message : "问题删除失败", "error");
  }
}

export function openMemoModal() {
  openModal("新增备忘", `
    <div class="form-grid">
      <div class="form-field full"><label>标题</label><input id="memoTitleInput" placeholder="例如：某客户报价偏好"></div>
      <div class="form-field full"><label>内容</label><textarea id="memoContentInput" placeholder="记录关键信息、背景、下一步或复盘结论"></textarea></div>
      <details class="form-field full memo-create-options">
        <summary>关联与分类（可选）</summary>
        <div class="form-grid">
          <div class="form-field"><label>分类</label><select id="memoCategoryInput"><option>客户备忘</option><option>销售话术</option><option>产品知识</option><option>报价复盘</option><option>个人记录</option></select></div>
          <div class="form-field"><label>标签</label><input id="memoTagsInput" placeholder="多个标签用逗号分隔"></div>
          <div class="form-field"><label>关联客户</label><select id="memoCustomerInput"><option value="">不关联客户</option>${state.customers.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.company)}</option>`).join("")}</select></div>
          <div class="form-field"><label>关联商机</label><select id="memoDealInput"><option value="">不关联商机</option>${state.deals.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}</select></div>
        </div>
      </details>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveMemoButton">保存备忘</button>`);
  qs("#saveMemoButton")?.addEventListener("click", () => void saveMemo());
  qs<HTMLSelectElement>("#memoCustomerInput")?.addEventListener("change", (event) => {
    const customerId = (event.currentTarget as HTMLSelectElement).value;
    const dealInput = qs<HTMLSelectElement>("#memoDealInput");
    if (!dealInput) return;
    dealInput.innerHTML = `<option value="">不关联商机</option>${state.deals.filter((item) => !customerId || item.customerId === customerId).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}`;
  });
  qs<HTMLSelectElement>("#memoDealInput")?.addEventListener("change", (event) => {
    const deal = state.deals.find((item) => item.id === (event.currentTarget as HTMLSelectElement).value);
    if (deal) {
      const customerInput = qs<HTMLSelectElement>("#memoCustomerInput");
      if (customerInput) customerInput.value = deal.customerId;
    }
  });
  qs<HTMLInputElement>("#memoTitleInput")?.focus();
}

export async function patchSelectedMemo(payload: Partial<Pick<Memo, "title" | "content" | "category" | "tags" | "pinned" | "archived">>) {
  await saveCurrentMemoDraft();
  const memo = state.memos.find((item) => item.id === state.selectedMemoId);
  if (!memo) return;
  const result = await api<{ memo: Memo }>(`/api/memos/${memo.id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  Object.assign(memo, result.memo);
  if (typeof payload.archived === "boolean") state.memoStatus = payload.archived ? "archived" : "active";
  renderMemos();
  toast(memo.archived ? "备忘已归档" : memo.pinned ? "备忘已置顶" : "备忘已更新");
}

export async function restoreSelectedMemo() {
  const memo = state.deletedMemos.find((item) => item.id === state.selectedMemoId);
  if (!memo) return;
  const result = await api<{ memo: Memo }>(`/api/memos/${memo.id}/restore`, { method: "POST" });
  state.deletedMemos = state.deletedMemos.filter((item) => item.id !== memo.id);
  state.memos.unshift(result.memo);
  state.memoStatus = result.memo.archived ? "archived" : "active";
  state.selectedMemoId = result.memo.id;
  renderMemos();
  toast(result.memo.archived ? "备忘已恢复到归档" : "备忘已恢复");
}

export function openCompetitorModal() {
  openModal("新增竞争公司", `
    <div class="form-grid">
      <div class="form-field full"><label>公司名称</label><input id="competitorCompanyInput" placeholder="请输入竞争公司名称"></div>
      <div class="form-field"><label>国家</label><input id="competitorCountryInput" value="德国"></div>
      <div class="form-field"><label>品类/赛道</label><input id="competitorSegmentInput" value="电动工具"></div>
      <div class="form-field"><label>威胁等级</label><select id="competitorThreatInput"><option value="medium">中威胁</option><option value="high">高威胁</option><option value="low">低威胁</option></select></div>
      <div class="form-field"><label>官网</label><input id="competitorWebsiteInput" placeholder="可选"></div>
      <div class="form-field full"><label>竞争产品</label><input id="competitorProductsInput" placeholder="例如：18V 无刷电钻、角磨机"></div>
      <div class="form-field full"><label>优势</label><textarea id="competitorStrengthsInput" placeholder="对方强在哪里"></textarea></div>
      <div class="form-field full"><label>弱点</label><textarea id="competitorWeaknessesInput" placeholder="我们可以突破的地方"></textarea></div>
      <div class="form-field full"><label>应对策略</label><textarea id="competitorStrategyInput" placeholder="报价、资料、谈判、交付策略"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCompetitorButton">保存竞争公司</button>`);
  qs("#saveCompetitorButton")?.addEventListener("click", () => void saveCompetitor());
  qs<HTMLInputElement>("#competitorCompanyInput")?.focus();
}

async function saveCompetitor() {
  const company = qs<HTMLInputElement>("#competitorCompanyInput")?.value.trim() || "";
  if (!company) {
    toast("请填写竞争公司名称", "error");
    return;
  }
  const result = await api<{ competitor: Competitor }>("/api/competitors", {
    method: "POST",
    body: JSON.stringify({
      company,
      country: qs<HTMLInputElement>("#competitorCountryInput")?.value.trim() || "",
      segment: qs<HTMLInputElement>("#competitorSegmentInput")?.value.trim() || "",
      threatLevel: qs<HTMLSelectElement>("#competitorThreatInput")?.value || "medium",
      website: qs<HTMLInputElement>("#competitorWebsiteInput")?.value.trim() || "",
      competingProducts: qs<HTMLInputElement>("#competitorProductsInput")?.value.trim() || "",
      strengths: qs<HTMLTextAreaElement>("#competitorStrengthsInput")?.value.trim() || "",
      weaknesses: qs<HTMLTextAreaElement>("#competitorWeaknessesInput")?.value.trim() || "",
      ourStrategy: qs<HTMLTextAreaElement>("#competitorStrategyInput")?.value.trim() || ""
    })
  });
  state.competitors.unshift(result.competitor);
  state.selectedCompetitorId = result.competitor.id;
  renderCompetitors(state.competitors);
  closeModal();
  toast("竞争公司已新增");
}

export async function toggleCompetitorThreat() {
  const competitor = state.competitors.find((item) => item.id === state.selectedCompetitorId);
  if (!competitor) return;
  const nextThreat = competitor.threatLevel === "high" ? "medium" : "high";
  const result = await api<{ competitor: Competitor }>(`/api/competitors/${competitor.id}/threat`, {
    method: "PATCH",
    body: JSON.stringify({ threatLevel: nextThreat })
  });
  Object.assign(competitor, result.competitor);
  renderCompetitors(state.competitors);
  toast(`威胁等级已更新：${threatText(competitor.threatLevel)}`);
}

export function openCaseModal() {
  openModal("新增成功案例", `
    <div class="form-grid">
      <div class="form-field full"><label>案例标题</label><input id="caseTitleInput" placeholder="例如：重点客户年度订单复购"></div>
      <div class="form-field"><label>客户</label><input id="caseCustomerInput" value="${escapeHtml(state.customers[0]?.company || "")}"></div>
      <div class="form-field"><label>国家</label><input id="caseCountryInput" value="${escapeHtml(state.customers[0]?.country || "")}"></div>
      <div class="form-field"><label>产品</label><input id="caseProductInput" placeholder="例如：18V 无刷电钻套装"></div>
      <div class="form-field"><label>行业</label><input id="caseIndustryInput" placeholder="例如：工具批发"></div>
      <div class="form-field full"><label>成果</label><input id="caseResultInput" placeholder="请输入成交结果或客户反馈"></div>
      <div class="form-field full"><label>成交故事</label><textarea id="caseStoryInput" placeholder="客户背景、阻力、关键动作和成交过程"></textarea></div>
      <div class="form-field full"><label>可复用打法</label><textarea id="caseReusableInput" placeholder="可复制到其他客户的步骤和话术"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCaseButton">保存案例</button>`);
  qs("#saveCaseButton")?.addEventListener("click", () => void saveCaseStudy());
  qs<HTMLInputElement>("#caseTitleInput")?.focus();
}

async function saveCaseStudy() {
  const title = qs<HTMLInputElement>("#caseTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写案例标题", "error");
    return;
  }
  const result = await api<{ caseStudy: CaseStudy }>("/api/case-studies", {
    method: "POST",
    body: JSON.stringify({
      title,
      customer: qs<HTMLInputElement>("#caseCustomerInput")?.value.trim() || "",
      country: qs<HTMLInputElement>("#caseCountryInput")?.value.trim() || "",
      product: qs<HTMLInputElement>("#caseProductInput")?.value.trim() || "",
      industry: qs<HTMLInputElement>("#caseIndustryInput")?.value.trim() || "",
      result: qs<HTMLInputElement>("#caseResultInput")?.value.trim() || "",
      story: qs<HTMLTextAreaElement>("#caseStoryInput")?.value.trim() || "",
      reusablePoints: qs<HTMLTextAreaElement>("#caseReusableInput")?.value.trim() || ""
    })
  });
  state.caseStudies.unshift(result.caseStudy);
  state.selectedCaseId = result.caseStudy.id;
  renderCaseStudies(state.caseStudies);
  closeModal();
  toast("成功案例已新增");
}

export async function publishSelectedCase() {
  const caseStudy = state.caseStudies.find((item) => item.id === state.selectedCaseId);
  if (!caseStudy || caseStudy.status === "published") return;
  const result = await api<{ caseStudy: CaseStudy }>(`/api/case-studies/${caseStudy.id}/publish`, { method: "PATCH" });
  Object.assign(caseStudy, result.caseStudy);
  renderCaseStudies(state.caseStudies);
  toast("成功案例已发布");
}
