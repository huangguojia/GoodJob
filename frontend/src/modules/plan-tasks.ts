/**
 * 官网资格入口、待办弹窗、计划任务与模板。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, confirmAction, openModal, renderMemos, renderProspectList, state } from "../prototype-api";
import { type Memo, type PlanTask, type PlanTemplate, type Todo, type WebsiteOpportunity } from "./models";
import { refreshDashboardOnly, renderTodos, updateTodoChips } from "./dashboard";
import { collectWebsiteRows, loadProspectQualification, prospectRequestId } from "./prospecting";
import { escapeHtml, qs, qsa } from "./shared";
import { api, toast } from "./ui";
import { formatDateTime } from "./deals";

export async function openWebsiteQualification(button?: HTMLButtonElement) {
  const opportunities = collectWebsiteRows();
  if (!opportunities.length) {
    toast("请至少勾选一条官网候选", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "保存中";
  }
  try {
    const saved = await Promise.all(opportunities.map((item) =>
      api<{ opportunity: WebsiteOpportunity }>(`/api/prospect-list/${encodeURIComponent(item.id)}/details`, {
        method: "PATCH",
        body: JSON.stringify({
          ...item,
          requestId: prospectRequestId("candidate-details")
        })
      })
    ));
    saved.forEach((result) => {
      const existing = state.websiteOpportunities.find((item) =>
        item.id === result.opportunity.id
      );
      if (existing) Object.assign(existing, result.opportunity);
    });
    const first = saved[0]?.opportunity;
    if (!first) return;
    state.selectedProspectId = first.id;
    state.prospectFilter = "all";
    activateNavView("prospect-list", () => {
      renderProspectList();
      void loadProspectQualification(first, false, true);
    });
  } catch (error) {
    toast(`候选资料保存失败：${error instanceof Error ? error.message : "请检查后重试"}`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "保存并打开候选";
    }
  }
}

export function openTodoModal(prefill = "", editing?: Todo) {
  const titleValue = editing?.title || prefill;
  openModal(editing ? "编辑待办" : "新增待办", `
    <div class="form-grid">
      <div class="form-field full"><label>待办内容</label><input id="todoTitleInput" value="${escapeHtml(titleValue)}" placeholder="例如：明天 10 点跟进重点客户报价"></div>
      <div class="form-field"><label>类型</label><select id="todoTypeInput"><option value="other">其它</option><option value="customer">客户跟进</option><option value="knowledge">资料维护</option><option value="exam">在线考试</option><option value="ocr">OCR 线索</option></select></div>
      <div class="form-field"><label>优先级</label><select id="todoPriorityInput"><option value="normal">普通</option><option value="medium">中优先级</option><option value="high">高优先级</option></select></div>
      <div class="form-field"><label>目标完成时间</label><input id="todoDueInput" value="${escapeHtml(editing?.dueAt || "")}" placeholder="例如：2026-06-27 18:00"></div>
      <div class="form-field"><label>关联对象</label><input id="todoRelatedInput" value="${escapeHtml(editing?.related || "")}" placeholder="可选：客户、商机、资料或考试名称"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveTodoButton">${editing ? "保存修改" : "保存待办"}</button>`);
  qs<HTMLSelectElement>("#todoTypeInput")!.value = editing?.type || "other";
  qs<HTMLSelectElement>("#todoPriorityInput")!.value = editing?.priority || "normal";
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveTodoButton")?.addEventListener("click", () => void saveTodo(editing?.id));
  qsa<HTMLInputElement | HTMLSelectElement>("#todoTitleInput, #todoTypeInput, #todoPriorityInput, #todoDueInput, #todoRelatedInput").forEach((node) => {
    node.addEventListener("keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== "Enter" || keyboardEvent.isComposing) return;
      event.preventDefault();
      void saveTodo(editing?.id);
    });
  });
  qs<HTMLInputElement>("#todoTitleInput")?.focus();
}

async function saveTodo(id?: string) {
  const title = qs<HTMLInputElement>("#todoTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写待办内容", "error");
    return;
  }
  const payload = {
    title,
    type: qs<HTMLSelectElement>("#todoTypeInput")?.value || "other",
    priority: qs<HTMLSelectElement>("#todoPriorityInput")?.value || "normal",
    dueAt: qs<HTMLInputElement>("#todoDueInput")?.value.trim() || "",
    related: qs<HTMLInputElement>("#todoRelatedInput")?.value.trim() || ""
  };
  const result = await api<{ todo: Todo }>(id ? `/api/todos/${id}` : "/api/todos", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(payload)
  });
  if (id) {
    const todo = state.todos.find((item) => item.id === id);
    if (todo) Object.assign(todo, result.todo);
  } else {
    state.todos.unshift(result.todo);
  }
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  closeModal();
  toast(id ? "待办已更新" : "待办已新增");
}

export async function createQuickTodo(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return;
  const result = await api<{ todo: Todo }>("/api/todos", {
    method: "POST",
    body: JSON.stringify({
      title: trimmed,
      type: "other",
      priority: "normal",
      dueAt: "",
      related: ""
    })
  });
  state.todos.unshift(result.todo);
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  toast("待办已新增");
}

function planTaskPriorityText(priority: PlanTask["priority"]) {
  return priority === "high" ? "高优先级" : priority === "medium" ? "中优先级" : "普通";
}

function planTaskStatusText(status: PlanTask["status"]) {
  return status === "active" ? "进行中" : status === "done" ? "已完成" : status === "cancelled" ? "已取消" : "计划中";
}

function parsePlanTaskDate(value: string) {
  const matched = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!matched) return null;
  const [, year, month, day, hour, minute] = matched;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (
    date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)
    || date.getHours() !== Number(hour)
    || date.getMinutes() !== Number(minute)
  ) return null;
  return date;
}

function planTaskWeekRange(reference = new Date()) {
  const start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const offset = start.getDay() === 0 ? 6 : start.getDay() - 1;
  start.setDate(start.getDate() - offset);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

function sameLocalDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function planTaskTimeState(task: PlanTask, now = new Date()) {
  const due = parsePlanTaskDate(task.dueAt);
  if (!due) return "unplanned" as const;
  if (sameLocalDay(due, now)) return "today" as const;
  if (due.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) return "overdue" as const;
  const week = planTaskWeekRange(now);
  if (due >= week.start && due < week.end) return "week" as const;
  return "future" as const;
}

function formatPlanTaskTime(value?: string) {
  if (!value) return "未排期";
  const date = parsePlanTaskDate(value) || new Date(value);
  if (!Number.isFinite(date.getTime())) return "未排期";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

export function localDateTimeValue(date = new Date(Date.now() + 60 * 60 * 1000)) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function planTaskRelationLabel(task: PlanTask) {
  if (task.leadId) {
    const lead = state.leads.find((item) => item.id === task.leadId);
    return lead ? `线索 · ${lead.company}` : "线索 · 已不可见";
  }
  const customer = state.customers.find((item) => item.id === task.customerId);
  const deal = state.deals.find((item) => item.id === task.dealId);
  if (deal) return `${customer?.company || "客户"} · ${deal.title}`;
  if (customer) return `客户 · ${customer.company}`;
  return "未关联业务";
}

function planTaskStatusTone(status: PlanTask["status"]) {
  return status === "done" ? "green" : status === "cancelled" ? "red" : status === "active" ? "amber" : "";
}

const planMemoTitle = "计划任务执行方案";

function planMemoContent() {
  const active = state.planTasks.filter((task) => task.status === "active" || task.status === "planned");
  const done = state.planTasks.filter((task) => task.status === "done");
  const taskLines = state.planTasks.map((task, index) => {
    const result = task.completionResult || task.cancellationReason || task.target || task.description || "待补充目标";
    return `${index + 1}. [${planTaskStatusText(task.status)}][${planTaskPriorityText(task.priority)}] ${task.title} - ${result}`;
  });
  return [
    `计划任务总数：${state.planTasks.length}`,
    `待执行：${active.length}`,
    `已完成：${done.length}`,
    "",
    taskLines.length ? taskLines.join("\n") : "当前账号尚未创建计划任务。"
  ].join("\n");
}

function planTemplatePlanTitle(template: PlanTemplate) {
  return `${template.section === "knowledge" ? "训练" : template.section === "execution" ? "首周执行" : "客户画像"}：${template.title}`;
}

export function renderPlanTemplates(templates = state.planTemplates) {
  const knowledge = qs<HTMLElement>("#knowledgeTemplateList");
  const persona = qs<HTMLElement>("#personaTemplateList");
  const execution = qs<HTMLElement>("#executionTemplateList");
  if (!knowledge || !persona || !execution) return;
  const sorted = [...templates].sort((left, right) => left.sortOrder - right.sortOrder);
  const knowledgeItems = sorted.filter((item) => item.section === "knowledge");
  const personaItems = sorted.filter((item) => item.section === "persona");
  const executionItems = sorted.filter((item) => item.section === "execution");
  knowledge.innerHTML = knowledgeItems.length ? knowledgeItems.map((item, index) => `
    <div class="knowledge-row" data-plan-template-id="${escapeHtml(item.id)}">
      <strong>${String(index + 1).padStart(2, "0")}</strong>
      <div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.summary)}</span></div>
      <em>${escapeHtml(item.output || "输出物：待维护")}</em>
      <div class="template-actions">
        <button class="btn compact" data-plan-template-add="${escapeHtml(item.id)}">加入计划</button>
        <button class="btn compact" data-plan-template-edit="${escapeHtml(item.id)}">编辑</button>
        <button class="btn compact danger" data-plan-template-delete="${escapeHtml(item.id)}">删除</button>
      </div>
    </div>
  `).join("") : `<div class="empty-state"><b>暂无前置知识训练项</b></div>`;
  persona.innerHTML = personaItems.length ? personaItems.map((item) => {
    const [keyword = "", action = ""] = item.output.split("\n");
    return `
      <article class="persona-card" data-plan-template-id="${escapeHtml(item.id)}">
        <div class="persona-head"><b>${escapeHtml(item.title)}</b><span class="badge ${escapeHtml(item.badgeTone)}">${escapeHtml(item.badge || "画像")}</span></div>
        <p>${escapeHtml(item.summary)}</p>
        <dl><dt>关键词</dt><dd>${escapeHtml(keyword.replace(/^关键词[:：]\s*/, "") || "待维护")}</dd><dt>首触达</dt><dd>${escapeHtml(action.replace(/^首触达[:：]\s*/, "") || "待维护")}</dd></dl>
        <div class="template-actions"><button class="btn compact" data-plan-template-add="${escapeHtml(item.id)}">加入计划</button><button class="btn compact" data-plan-template-edit="${escapeHtml(item.id)}">编辑</button><button class="btn compact danger" data-plan-template-delete="${escapeHtml(item.id)}">删除</button></div>
      </article>
    `;
  }).join("") : `<div class="empty-state"><b>暂无客户画像</b></div>`;
  execution.innerHTML = executionItems.length ? executionItems.map((item) => `
    <div class="execution-day" data-plan-template-id="${escapeHtml(item.id)}">
      <div class="execution-title-row"><h3>${escapeHtml(item.title)}</h3><span class="badge ${escapeHtml(item.badgeTone)}">${escapeHtml(item.badge || "执行")}</span></div>
      <ul>${(item.output || item.summary).split("\n").filter(Boolean).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      <div class="template-actions"><button class="btn compact" data-plan-template-add="${escapeHtml(item.id)}">加入计划</button><button class="btn compact" data-plan-template-edit="${escapeHtml(item.id)}">编辑</button></div>
    </div>
  `).join("") : `<div class="empty-state"><b>暂无首周执行拆解</b></div>`;
  qsa<HTMLButtonElement>("[data-plan-template-add]").forEach((button) => button.addEventListener("click", () => void createPlanTaskFromTemplate(button.dataset.planTemplateAdd || "", button)));
  qsa<HTMLButtonElement>("[data-plan-template-edit]").forEach((button) => button.addEventListener("click", () => openPlanTemplateModal(state.planTemplates.find((item) => item.id === button.dataset.planTemplateEdit))));
  qsa<HTMLButtonElement>("[data-plan-template-delete]").forEach((button) => button.addEventListener("click", () => void deletePlanTemplate(button.dataset.planTemplateDelete || "")));
}

export function renderPlanTasks(tasks = state.planTasks) {
  const container = qs<HTMLElement>("#planTaskList");
  if (!container) return;
  const sorted = [...tasks].sort((left, right) => {
    const statusWeight = { active: 0, planned: 1, done: 2, cancelled: 3 } as Record<PlanTask["status"], number>;
    const priorityWeight = { high: 0, medium: 1, normal: 2 } as Record<PlanTask["priority"], number>;
    const leftDue = parsePlanTaskDate(left.dueAt)?.getTime() || Number.MAX_SAFE_INTEGER;
    const rightDue = parsePlanTaskDate(right.dueAt)?.getTime() || Number.MAX_SAFE_INTEGER;
    return statusWeight[left.status] - statusWeight[right.status]
      || priorityWeight[left.priority] - priorityWeight[right.priority]
      || leftDue - rightDue
      || String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  });
  const stats = qs<HTMLElement>("#planTaskStats");
  if (stats) {
    const active = tasks.filter((task) => task.status === "active").length;
    const done = tasks.filter((task) => task.status === "done").length;
    stats.innerHTML = `
      <div><span>任务总数</span><b>${tasks.length}</b></div>
      <div><span>进行中</span><b>${active}</b></div>
      <div><span>已完成</span><b>${done}</b></div>
      <div><span>可推待办</span><b>${tasks.filter((task) => task.status === "planned" || task.status === "active").length}</b></div>
    `;
  }
  container.innerHTML = sorted.length ? `
    <table class="plan-task-table">
      <thead><tr><th><input id="planTaskSelectAll" type="checkbox" aria-label="全选计划任务"></th><th>任务</th><th>阶段/分类</th><th>业务关联</th><th>目标/结果</th><th>状态/时间</th><th>操作</th></tr></thead>
      <tbody>
        ${sorted.map((task) => {
    const result = task.status === "done"
      ? task.completionResult || "未记录完成结果"
      : task.status === "cancelled"
        ? task.cancellationReason || "未记录取消原因"
        : task.target || task.description || "未填写验收目标";
    const open = task.status === "planned" || task.status === "active";
    return `
          <tr data-plan-task-id="${escapeHtml(task.id)}">
            <td><input type="checkbox" data-plan-task-check="${escapeHtml(task.id)}" ${state.selectedPlanTaskIds.includes(task.id) ? "checked" : ""} aria-label="选择${escapeHtml(task.title)}"></td>
            <td class="plan-title-cell"><b>${escapeHtml(task.title)}</b><small>${escapeHtml(task.description || "暂无执行说明")}</small></td>
            <td><span class="badge aqua">${escapeHtml(task.phase)}</span><small>${escapeHtml(task.category)}</small></td>
            <td><b>${escapeHtml(planTaskRelationLabel(task))}</b><small>${task.rescheduleReason ? `最近改期：${escapeHtml(task.rescheduleReason)}` : "仅本人可见"}</small></td>
            <td><b>${escapeHtml(result)}</b><small>${task.status === "done" && task.completedAt ? `完成于 ${escapeHtml(formatDateTime(task.completedAt))}` : task.status === "cancelled" && task.cancelledAt ? `取消于 ${escapeHtml(formatDateTime(task.cancelledAt))}` : "完成时记录真实结果"}</small></td>
            <td><span class="badge ${planTaskStatusTone(task.status)}">${planTaskStatusText(task.status)}</span><small>${planTaskPriorityText(task.priority)} · ${escapeHtml(formatPlanTaskTime(task.dueAt))}</small></td>
            <td class="row-actions">
              ${open ? `<button class="btn compact" data-plan-push="${escapeHtml(task.id)}">推待办</button><button class="btn compact primary" data-plan-complete="${escapeHtml(task.id)}">完成</button><button class="btn compact" data-plan-reschedule="${escapeHtml(task.id)}">改期</button><button class="btn compact" data-plan-edit="${escapeHtml(task.id)}">编辑</button><button class="btn compact" data-plan-cancel="${escapeHtml(task.id)}">取消</button>` : ""}
              <button class="btn compact danger" data-plan-delete="${escapeHtml(task.id)}">删除</button>
            </td>
          </tr>
    `;
  }).join("")}
      </tbody>
    </table>
  ` : `<div class="empty-state"><b>还没有计划任务</b><span>先新增一条开拓任务，再推送到待办执行。</span><button class="btn primary plan-empty-action" data-plan-empty-new>新增任务</button></div>`;
  qs<HTMLInputElement>("#planTaskSelectAll")?.addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    state.selectedPlanTaskIds = checked ? sorted.map((task) => task.id) : [];
    renderPlanTasks(state.planTasks);
  });
  qsa<HTMLInputElement>("[data-plan-task-check]", container).forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.dataset.planTaskCheck || "";
      state.selectedPlanTaskIds = input.checked
        ? Array.from(new Set([...state.selectedPlanTaskIds, id]))
        : state.selectedPlanTaskIds.filter((item) => item !== id);
    });
  });
  qsa<HTMLButtonElement>("[data-plan-edit]", container).forEach((button) => button.addEventListener("click", () => openPlanTaskModal(state.planTasks.find((task) => task.id === button.dataset.planEdit))));
  qsa<HTMLButtonElement>("[data-plan-delete]", container).forEach((button) => button.addEventListener("click", () => void deletePlanTask(button.dataset.planDelete || "")));
  qsa<HTMLButtonElement>("[data-plan-complete]", container).forEach((button) => button.addEventListener("click", () => openPlanTaskCompleteModal(button.dataset.planComplete || "")));
  qsa<HTMLButtonElement>("[data-plan-cancel]", container).forEach((button) => button.addEventListener("click", () => openPlanTaskCancelModal(button.dataset.planCancel || "")));
  qsa<HTMLButtonElement>("[data-plan-reschedule]", container).forEach((button) => button.addEventListener("click", () => openPlanTaskRescheduleModal(button.dataset.planReschedule || "")));
  qsa<HTMLButtonElement>("[data-plan-push]", container).forEach((button) => button.addEventListener("click", () => void pushPlanTasksToTodos([button.dataset.planPush || ""], button)));
  qs<HTMLButtonElement>("[data-plan-empty-new]", container)?.addEventListener("click", () => openPlanTaskModal());
}

export function openPlanTaskModal(task?: PlanTask) {
  const editing = Boolean(task);
  if (task && (task.status === "done" || task.status === "cancelled")) {
    toast("已结束任务只保留结果记录，不能再编辑", "error");
    return;
  }
  const relationType = task?.leadId ? "lead" : task?.dealId ? "deal" : task?.customerId ? "customer" : "none";
  const leadOptions = state.leads
    .filter((lead) => !lead.deletedAt && lead.status !== "converted")
    .map((lead) => `<option value="${escapeHtml(lead.id)}" ${task?.leadId === lead.id ? "selected" : ""}>${escapeHtml(lead.company)} · ${escapeHtml(lead.contact || "待维护")}</option>`)
    .join("");
  const customerOptions = state.customers
    .map((customer) => `<option value="${escapeHtml(customer.id)}" ${task?.customerId === customer.id ? "selected" : ""}>${escapeHtml(customer.company)}${customer.country ? ` · ${escapeHtml(customer.country)}` : ""}</option>`)
    .join("");
  openModal(editing ? "编辑计划任务" : "新增计划任务", `
    <div class="form-grid">
      <div class="form-field full"><label>任务标题</label><input id="planTaskTitleInput" value="${escapeHtml(task?.title || "")}" placeholder="例如：跟进重点客户报价反馈"></div>
      <div class="form-field full"><label>计划时间</label><input id="planTaskDueInput" type="datetime-local" value="${escapeHtml(task?.dueAt || localDateTimeValue())}"></div>
    </div>
    <details class="modal-advanced">
      <summary>更多设置</summary>
      <div class="form-grid" style="margin-top:12px">
        <div class="form-field"><label>关联类型</label><select id="planTaskRelationType"><option value="none" ${relationType === "none" ? "selected" : ""}>不关联</option><option value="lead" ${relationType === "lead" ? "selected" : ""}>线索</option><option value="customer" ${relationType === "customer" ? "selected" : ""}>客户</option><option value="deal" ${relationType === "deal" ? "selected" : ""}>客户 + 商机</option></select></div>
        <div class="form-field"><label>优先级</label><select id="planTaskPriorityInput"><option value="high" ${task?.priority === "high" ? "selected" : ""}>高</option><option value="medium" ${task?.priority === "medium" ? "selected" : ""}>中</option><option value="normal" ${!task || task.priority === "normal" ? "selected" : ""}>普通</option></select></div>
        <div class="form-field full" id="planTaskLeadField"><label>关联线索</label><select id="planTaskLeadInput"><option value="">请选择线索</option>${leadOptions}</select></div>
        <div class="form-field" id="planTaskCustomerField"><label>关联客户</label><select id="planTaskCustomerInput"><option value="">请选择客户</option>${customerOptions}</select></div>
        <div class="form-field" id="planTaskDealField"><label>关联商机</label><select id="planTaskDealInput"></select></div>
        <div class="form-field"><label>执行状态</label><select id="planTaskStatusInput"><option value="planned" ${!task || task.status === "planned" ? "selected" : ""}>计划中</option><option value="active" ${task?.status === "active" ? "selected" : ""}>进行中</option></select></div>
        <div class="form-field full"><label>验收目标</label><input id="planTaskTargetInput" value="${escapeHtml(task?.target || "")}" placeholder="做到什么程度才算完成"></div>
        <div class="form-field full"><label>执行说明</label><textarea id="planTaskDescriptionInput" rows="4" placeholder="可选：关键口径、资料要求或注意事项">${escapeHtml(task?.description || "")}</textarea></div>
      </div>
    </details>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="savePlanTaskButton" data-editing-id="${escapeHtml(task?.id || "")}">${editing ? "保存修改" : "保存任务"}</button>`);
  const relationSelect = qs<HTMLSelectElement>("#planTaskRelationType");
  const customerSelect = qs<HTMLSelectElement>("#planTaskCustomerInput");
  const dealSelect = qs<HTMLSelectElement>("#planTaskDealInput");
  const updateDealOptions = () => {
    if (!dealSelect || !customerSelect) return;
    const deals = state.deals.filter((deal) => !customerSelect.value || deal.customerId === customerSelect.value);
    dealSelect.innerHTML = `<option value="">请选择商机</option>${deals.map((deal) => `<option value="${escapeHtml(deal.id)}" ${task?.dealId === deal.id ? "selected" : ""}>${escapeHtml(deal.title)}</option>`).join("")}`;
  };
  const updateRelationFields = () => {
    const value = relationSelect?.value || "none";
    const leadField = qs<HTMLElement>("#planTaskLeadField");
    const customerField = qs<HTMLElement>("#planTaskCustomerField");
    const dealField = qs<HTMLElement>("#planTaskDealField");
    if (leadField) leadField.hidden = value !== "lead";
    if (customerField) customerField.hidden = value !== "customer" && value !== "deal";
    if (dealField) dealField.hidden = value !== "deal";
    if (value === "deal") updateDealOptions();
  };
  relationSelect?.addEventListener("change", updateRelationFields);
  customerSelect?.addEventListener("change", updateDealOptions);
  dealSelect?.addEventListener("change", () => {
    const deal = state.deals.find((item) => item.id === dealSelect.value);
    if (deal && customerSelect) {
      customerSelect.value = deal.customerId;
      updateDealOptions();
      dealSelect.value = deal.id;
    }
  });
  updateRelationFields();
  qs("#savePlanTaskButton")?.addEventListener("click", () => void savePlanTask());
  qs<HTMLInputElement>("#planTaskTitleInput")?.focus();
}

async function savePlanTask() {
  const title = qs<HTMLInputElement>("#planTaskTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写任务标题", "error");
    return;
  }
  const saveButton = qs<HTMLButtonElement>("#savePlanTaskButton");
  const editingId = saveButton?.dataset.editingId || "";
  const relationType = qs<HTMLSelectElement>("#planTaskRelationType")?.value || "none";
  const leadId = relationType === "lead" ? qs<HTMLSelectElement>("#planTaskLeadInput")?.value || "" : "";
  const customerId = relationType === "customer" || relationType === "deal" ? qs<HTMLSelectElement>("#planTaskCustomerInput")?.value || "" : "";
  const dealId = relationType === "deal" ? qs<HTMLSelectElement>("#planTaskDealInput")?.value || "" : "";
  if (relationType === "lead" && !leadId) {
    toast("请选择关联线索", "error");
    return;
  }
  if ((relationType === "customer" || relationType === "deal") && !customerId) {
    toast("请选择关联客户", "error");
    return;
  }
  if (relationType === "deal" && !dealId) {
    toast("请选择关联商机", "error");
    return;
  }
  const payload = {
    title,
    phase: "计划任务",
    category: "客户开发",
    priority: (qs<HTMLSelectElement>("#planTaskPriorityInput")?.value || "normal") as PlanTask["priority"],
    status: (qs<HTMLSelectElement>("#planTaskStatusInput")?.value || "planned") as PlanTask["status"],
    dueAt: qs<HTMLInputElement>("#planTaskDueInput")?.value.trim() || "",
    target: qs<HTMLInputElement>("#planTaskTargetInput")?.value.trim() || "",
    description: qs<HTMLTextAreaElement>("#planTaskDescriptionInput")?.value.trim() || "",
    leadId,
    customerId,
    dealId
  };
  if (saveButton) saveButton.disabled = true;
  try {
    const result = await api<{ task: PlanTask }>(editingId ? `/api/plan-tasks/${editingId}` : "/api/plan-tasks", {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    state.planTasks = editingId ? state.planTasks.map((task) => task.id === result.task.id ? result.task : task) : [result.task, ...state.planTasks];
    renderPlanTasks(state.planTasks);
    closeModal();
    toast(editingId ? "计划任务已保存" : "计划任务已新增");
  } catch (error) {
    toast(error instanceof Error ? error.message : "计划任务保存失败", "error");
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

function replacePlanTask(updated: PlanTask) {
  state.planTasks = state.planTasks.map((task) => task.id === updated.id ? updated : task);
  renderPlanTasks(state.planTasks);
}

function openPlanTaskCompleteModal(id: string) {
  const task = state.planTasks.find((item) => item.id === id);
  if (!task) return;
  openModal("完成并记录结果", `
    <div class="form-grid">
      <div class="form-field full"><label>任务</label><input value="${escapeHtml(task.title)}" disabled></div>
      <div class="form-field full"><label>完成结果</label><textarea id="planTaskCompleteResult" rows="5" placeholder="例如：客户确认参数，已发送新版报价，预计周五回复"></textarea></div>
    </div>
    <div class="template-actions" style="justify-content:flex-start;margin-top:10px">
      <button class="btn compact" type="button" data-plan-result-preset="已完成触达，等待客户回复。">已触达</button>
      <button class="btn compact" type="button" data-plan-result-preset="客户已回复，需求与关键参数已记录。">已回复</button>
      <button class="btn compact" type="button" data-plan-result-preset="已完成报价或资料发送，并约定下一步。">已报价/发资料</button>
    </div>
  `, `<button class="btn" data-modal-close>暂不完成</button><button class="btn primary" id="confirmPlanTaskComplete">确认完成</button>`);
  qsa<HTMLButtonElement>("[data-plan-result-preset]").forEach((button) => button.addEventListener("click", () => {
    const input = qs<HTMLTextAreaElement>("#planTaskCompleteResult");
    if (input) {
      input.value = button.dataset.planResultPreset || "";
      input.focus();
    }
  }));
  qs<HTMLButtonElement>("#confirmPlanTaskComplete")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const result = qs<HTMLTextAreaElement>("#planTaskCompleteResult")?.value.trim() || "";
    if (!result) {
      toast("请记录完成结果", "error");
      return;
    }
    button.disabled = true;
    try {
      const response = await api<{ task: PlanTask }>(`/api/plan-tasks/${id}/complete`, {
        method: "POST",
        body: JSON.stringify({ result })
      });
      replacePlanTask(response.task);
      closeModal();
      toast("任务已完成，结果已记录");
    } catch (error) {
      toast(error instanceof Error ? error.message : "任务完成失败", "error");
      button.disabled = false;
    }
  });
  qs<HTMLTextAreaElement>("#planTaskCompleteResult")?.focus();
}

function openPlanTaskCancelModal(id: string) {
  const task = state.planTasks.find((item) => item.id === id);
  if (!task) return;
  openModal("取消计划任务", `
    <div class="form-grid">
      <div class="form-field full"><label>任务</label><input value="${escapeHtml(task.title)}" disabled></div>
      <div class="form-field full"><label>取消原因</label><textarea id="planTaskCancelReason" rows="4" placeholder="说明为什么不再执行，便于后续复盘"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>返回</button><button class="btn danger" id="confirmPlanTaskCancel">确认取消</button>`);
  qs<HTMLButtonElement>("#confirmPlanTaskCancel")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const reason = qs<HTMLTextAreaElement>("#planTaskCancelReason")?.value.trim() || "";
    if (!reason) {
      toast("请填写取消原因", "error");
      return;
    }
    button.disabled = true;
    try {
      const response = await api<{ task: PlanTask }>(`/api/plan-tasks/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason })
      });
      replacePlanTask(response.task);
      closeModal();
      toast("任务已取消，原因已记录");
    } catch (error) {
      toast(error instanceof Error ? error.message : "任务取消失败", "error");
      button.disabled = false;
    }
  });
  qs<HTMLTextAreaElement>("#planTaskCancelReason")?.focus();
}

function openPlanTaskRescheduleModal(id: string) {
  const task = state.planTasks.find((item) => item.id === id);
  if (!task) return;
  const overdue = planTaskTimeState(task) === "overdue";
  openModal("调整计划时间", `
    <div class="form-grid">
      <div class="form-field full"><label>任务</label><input value="${escapeHtml(task.title)}" disabled></div>
      <div class="form-field full"><label>新的计划时间</label><input id="planTaskRescheduleDue" type="datetime-local" value="${escapeHtml(task.dueAt || localDateTimeValue())}"></div>
      <div class="form-field full"><label>改期原因${overdue ? "（逾期任务必填）" : "（选填）"}</label><textarea id="planTaskRescheduleReason" rows="3" placeholder="例如：等待客户补充技术参数"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>返回</button><button class="btn primary" id="confirmPlanTaskReschedule">确认改期</button>`);
  qs<HTMLButtonElement>("#confirmPlanTaskReschedule")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const dueAt = qs<HTMLInputElement>("#planTaskRescheduleDue")?.value || "";
    const reason = qs<HTMLTextAreaElement>("#planTaskRescheduleReason")?.value.trim() || "";
    if (!dueAt) {
      toast("请选择新的计划时间", "error");
      return;
    }
    if (overdue && !reason) {
      toast("逾期任务请填写改期原因", "error");
      return;
    }
    button.disabled = true;
    try {
      const response = await api<{ task: PlanTask }>(`/api/plan-tasks/${id}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ dueAt, reason })
      });
      replacePlanTask(response.task);
      closeModal();
      toast("计划时间已调整");
    } catch (error) {
      toast(error instanceof Error ? error.message : "任务改期失败", "error");
      button.disabled = false;
    }
  });
}

function openPlanTemplateModal(template?: PlanTemplate) {
  if (!template) return;
  openModal("编辑模板", `
    <div class="form-grid">
      <div class="form-field"><label>模块</label><select id="planTemplateSectionInput"><option value="knowledge" ${template.section === "knowledge" ? "selected" : ""}>前置知识</option><option value="persona" ${template.section === "persona" ? "selected" : ""}>客户画像</option><option value="execution" ${template.section === "execution" ? "selected" : ""}>首周执行</option></select></div>
      <div class="form-field"><label>排序</label><input id="planTemplateSortInput" type="number" value="${template.sortOrder}"></div>
      <div class="form-field full"><label>标题</label><input id="planTemplateTitleInput" value="${escapeHtml(template.title)}"></div>
      <div class="form-field full"><label>说明</label><textarea id="planTemplateSummaryInput" rows="4">${escapeHtml(template.summary)}</textarea></div>
      <div class="form-field full"><label>输出物 / 关键词与首触达</label><textarea id="planTemplateOutputInput" rows="3" placeholder="客户画像可写两行：关键词：... / 首触达：...">${escapeHtml(template.output)}</textarea></div>
      <div class="form-field"><label>标签</label><input id="planTemplateBadgeInput" value="${escapeHtml(template.badge)}"></div>
      <div class="form-field"><label>标签颜色</label><select id="planTemplateToneInput"><option value="" ${!template.badgeTone ? "selected" : ""}>默认</option><option value="green" ${template.badgeTone === "green" ? "selected" : ""}>绿色</option><option value="aqua" ${template.badgeTone === "aqua" ? "selected" : ""}>蓝绿</option><option value="amber" ${template.badgeTone === "amber" ? "selected" : ""}>橙色</option><option value="red" ${template.badgeTone === "red" ? "selected" : ""}>红色</option></select></div>
      <div class="form-field"><label>计划阶段</label><input id="planTemplatePhaseInput" value="${escapeHtml(template.phase)}"></div>
      <div class="form-field"><label>计划分类</label><input id="planTemplateCategoryInput" value="${escapeHtml(template.category)}"></div>
      <div class="form-field"><label>优先级</label><select id="planTemplatePriorityInput"><option value="high" ${template.priority === "high" ? "selected" : ""}>高</option><option value="medium" ${template.priority === "medium" ? "selected" : ""}>中</option><option value="normal" ${template.priority === "normal" ? "selected" : ""}>普通</option></select></div>
      <div class="form-field full"><label>加入计划后的验收目标</label><input id="planTemplateTargetInput" value="${escapeHtml(template.target)}"></div>
      <div class="form-field full"><label>加入计划后的执行说明</label><textarea id="planTemplateDescriptionInput" rows="4">${escapeHtml(template.description)}</textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="savePlanTemplateButton" data-template-id="${escapeHtml(template.id)}">保存模板</button>`);
  qs("#savePlanTemplateButton")?.addEventListener("click", () => void savePlanTemplate());
  qs<HTMLInputElement>("#planTemplateTitleInput")?.focus();
}

async function savePlanTemplate() {
  const saveButton = qs<HTMLButtonElement>("#savePlanTemplateButton");
  const id = saveButton?.dataset.templateId || "";
  const title = qs<HTMLInputElement>("#planTemplateTitleInput")?.value.trim() || "";
  if (!id || !title) {
    toast("请填写模板标题", "error");
    return;
  }
  const payload = {
    section: (qs<HTMLSelectElement>("#planTemplateSectionInput")?.value || "knowledge") as PlanTemplate["section"],
    title,
    summary: qs<HTMLTextAreaElement>("#planTemplateSummaryInput")?.value.trim() || "",
    output: qs<HTMLTextAreaElement>("#planTemplateOutputInput")?.value.trim() || "",
    badge: qs<HTMLInputElement>("#planTemplateBadgeInput")?.value.trim() || "",
    badgeTone: qs<HTMLSelectElement>("#planTemplateToneInput")?.value || "",
    phase: qs<HTMLInputElement>("#planTemplatePhaseInput")?.value.trim() || "计划任务",
    category: qs<HTMLInputElement>("#planTemplateCategoryInput")?.value.trim() || "客户开发",
    priority: (qs<HTMLSelectElement>("#planTemplatePriorityInput")?.value || "normal") as PlanTemplate["priority"],
    target: qs<HTMLInputElement>("#planTemplateTargetInput")?.value.trim() || "",
    description: qs<HTMLTextAreaElement>("#planTemplateDescriptionInput")?.value.trim() || "",
    sortOrder: Number(qs<HTMLInputElement>("#planTemplateSortInput")?.value || 0)
  };
  const result = await api<{ template: PlanTemplate }>(`/api/plan-templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  state.planTemplates = state.planTemplates.map((item) => item.id === result.template.id ? result.template : item);
  renderPlanTemplates(state.planTemplates);
  closeModal();
  toast("模板已保存");
}

async function deletePlanTemplate(id: string) {
  if (!id || !await confirmAction({
    title: "删除计划模板",
    message: "该模板将无法再用于创建计划任务。",
    consequences: ["模板配置会被删除", "已生成的计划任务不会受影响"],
    confirmLabel: "删除模板"
  })) return;
  await api(`/api/plan-templates/${id}`, { method: "DELETE" });
  state.planTemplates = state.planTemplates.filter((item) => item.id !== id);
  renderPlanTemplates(state.planTemplates);
  toast("模板已删除");
}

async function createPlanTaskFromTemplate(id: string, button?: HTMLButtonElement) {
  const template = state.planTemplates.find((item) => item.id === id);
  if (!template) return;
  const title = planTemplatePlanTitle(template);
  if (state.planTasks.some((task) => task.title === title)) {
    renderPlanTasks(state.planTasks);
    toast("这条训练任务已在计划中");
    return;
  }
  if (button) button.disabled = true;
  try {
    const result = await api<{ task: PlanTask }>("/api/plan-tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        phase: template.phase || "计划任务",
        category: template.category || "客户开发",
        priority: template.priority || "normal",
        status: "planned",
        dueAt: "",
        target: template.target || "",
        description: template.description || template.summary || ""
      })
    });
    state.planTasks = [result.task, ...state.planTasks];
    state.selectedPlanTaskIds = Array.from(new Set([...state.selectedPlanTaskIds, result.task.id]));
    renderPlanTasks(state.planTasks);
    toast("已加入计划任务");
  } finally {
    if (button) button.disabled = false;
  }
}

async function deletePlanTask(id: string) {
  if (!id || !await confirmAction({
    title: "删除计划任务",
    message: "这条计划任务将从计划清单中删除。",
    consequences: ["任务状态与备注会被移除", "已经推送到待办的事项不会自动删除"],
    confirmLabel: "删除任务"
  })) return;
  await api(`/api/plan-tasks/${id}`, { method: "DELETE" });
  state.planTasks = state.planTasks.filter((task) => task.id !== id);
  state.selectedPlanTaskIds = state.selectedPlanTaskIds.filter((taskId) => taskId !== id);
  renderPlanTasks(state.planTasks);
  toast("计划任务已删除");
}

export async function pushPlanTasksToTodos(ids: string[], button?: HTMLButtonElement) {
  const tasks = ids.map((id) => state.planTasks.find((task) => task.id === id)).filter(Boolean) as PlanTask[];
  const pending = tasks.filter((task) => task.status === "planned" || task.status === "active");
  if (!pending.length) {
    toast("请选择未完成的计划任务", "error");
    return;
  }
  const existingTitles = new Set(state.todos.filter((todo) => !todo.done).map((todo) => todo.title));
  const missing = pending.filter((task) => !existingTitles.has(task.title));
  if (!missing.length) {
    toast("所选计划任务已在待办中");
    return;
  }
  if (button) button.disabled = true;
  try {
    const created: Todo[] = [];
    for (const task of missing) {
      const result = await api<{ todo: Todo }>("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          title: task.title,
          type: "other",
          priority: task.priority,
          dueAt: task.dueAt,
          related: planTaskRelationLabel(task) === "未关联业务" ? `计划任务 / ${task.phase}` : planTaskRelationLabel(task)
        })
      });
      created.push(result.todo);
    }
    state.todos.unshift(...created);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    void refreshDashboardOnly();
    toast(`已推送 ${created.length} 条计划任务到待办`);
  } finally {
    if (button) button.disabled = false;
  }
}

export async function savePlanMemo(button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "写入中";
  }
  try {
    const existing = state.memos.find((memo) => memo.title === planMemoTitle);
    const payload = {
      title: planMemoTitle,
      category: "计划任务",
      tags: "计划任务,执行计划",
      content: planMemoContent(),
      pinned: true
    };
    if (existing) {
      const result = await api<{ memo: Memo }>(`/api/memos/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      Object.assign(existing, result.memo);
      state.selectedMemoId = existing.id;
      toast("计划任务备忘已更新");
    } else {
      const result = await api<{ memo: Memo }>("/api/memos", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      state.memos.unshift(result.memo);
      state.selectedMemoId = result.memo.id;
      toast("计划任务已写入备忘");
    }
    renderMemos(state.memos);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "写入备忘";
    }
  }
}

export function exportPlanCsv() {
  const taskRows = state.planTasks.map((task) => [
    task.title,
    planTaskPriorityText(task.priority),
    planTaskStatusText(task.status),
    task.dueAt || "",
    planTaskRelationLabel(task),
    task.target || "",
    task.description || "",
    task.completionResult || "",
    task.completedAt || "",
    task.cancellationReason || "",
    task.cancelledAt || "",
    task.rescheduledFrom || "",
    task.rescheduleReason || "",
    task.phase,
    task.category
  ]);
  const rows = [
    ["任务", "优先级", "状态", "计划时间", "业务关联", "验收目标", "执行说明", "完成结果", "完成时间", "取消原因", "取消时间", "改期前时间", "改期原因", "历史阶段", "历史分类"],
    ...taskRows
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "计划任务执行表.csv";
  link.click();
  URL.revokeObjectURL(link.href);
  toast("计划任务执行表已导出");
}
