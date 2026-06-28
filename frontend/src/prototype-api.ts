type Role = "sales" | "manager" | "admin";

interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string;
  avatar: string;
}

interface Customer {
  id: string;
  company: string;
  country: string;
  contact: string;
  stage: string;
  amount: number;
  health: number;
  nextReminder: string;
  wecomBound: boolean;
}

interface Todo {
  id: string;
  title: string;
  type: string;
  priority: string;
  dueAt: string;
  related: string;
  done: boolean;
  impactAmount?: number;
  createdAt?: string;
}

interface Deal {
  id: string;
  title: string;
  stage: string;
  amount: number;
  nextAction: string;
}

interface Reminder {
  id: string;
  title: string;
  rule: string;
  dueAt: string;
  channel: string;
  status: string;
}

interface ImportExportJob {
  id: string;
  name: string;
  type: string;
  rows: number;
  status: string;
  createdAt: string;
}

interface KnowledgeAsset {
  id: string;
  title: string;
  category: string;
  status: string;
  version: string;
}

interface Exam {
  id: string;
  title: string;
  category: string;
  status: string;
  passRate: number;
  questionCount: number;
}

interface WecomMessage {
  id: string;
  summary: string;
  status: string;
}

interface OcrJob {
  id: string;
  status: string;
  confidence: number;
  fields: Record<string, string>;
}

interface ProblemItem {
  id: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  relatedCustomer: string;
  rootCause: string;
  solution: string;
  nextAction: string;
  dueAt: string;
  createdAt: string;
}

interface Memo {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
}

interface Competitor {
  id: string;
  company: string;
  country: string;
  segment: string;
  threatLevel: string;
  website: string;
  strengths: string;
  weaknesses: string;
  competingProducts: string;
  ourStrategy: string;
  updatedAt: string;
}

interface CaseStudy {
  id: string;
  title: string;
  customer: string;
  country: string;
  product: string;
  industry: string;
  result: string;
  story: string;
  reusablePoints: string;
  status: string;
  updatedAt: string;
}

interface DashboardSummary {
  scope: string;
  updatedAt: string;
  briefing: {
    title: string;
    description: string;
    basis: string;
    action: string;
    impact: string;
    riskAmount: number;
    riskLabel: string;
    closableDeals: number;
    closableAmount: number;
    unreadWecom: number;
  };
  metrics: {
    customers: number;
    todos: number;
    overdueTodos: number;
    forecastAmount: number;
    wecomBoundRate: number;
    pendingKnowledge: number;
    examPassRate: number;
    unfinishedExams: number;
    customerCompleteness: number;
  };
  schedule: Array<{ time: string; title: string; subtitle: string; tone: string }>;
  quality: {
    followHealth: number;
    overdueRate: number;
    avgResponseHours: number;
  };
  pipelineHealth: Array<{ stage: string; count: number; amount: number; riskCount: number; width: number; tone: string }>;
  todoInsights: {
    total: number;
    overdue: number;
    completionRate: number;
    impactAmount: number;
    typeRows: Array<{ type: string; label: string; count: number; risk: string }>;
    weekLoad: Array<{ day: string; count: number }>;
    historyCount: number;
    historyAmount: number;
  };
  priorityTasks: Array<{ id: string; customerId: string; title: string; subtitle: string; score: number; reason: string; action: string; tone: string; badge: string }>;
}

interface AppState {
  user: User | null;
  summary: DashboardSummary | null;
  customers: Customer[];
  todos: Todo[];
  deals: Deal[];
  reminders: Reminder[];
  jobs: ImportExportJob[];
  wecomMessages: WecomMessage[];
  knowledgeAssets: KnowledgeAsset[];
  exams: Exam[];
  ocrJob: OcrJob | null;
  problems: ProblemItem[];
  memos: Memo[];
  competitors: Competitor[];
  caseStudies: CaseStudy[];
  accounts: User[];
  reportNote: string;
  todoFilter: "all" | "today" | "overdue" | "mine" | "customer" | "history";
  selectedCustomerId: string | null;
  selectedProblemId: string | null;
  selectedMemoId: string | null;
  selectedCompetitorId: string | null;
  selectedCaseId: string | null;
}

const state: AppState = {
  user: null,
  summary: null,
  customers: [],
  todos: [],
  deals: [],
  reminders: [],
  jobs: [],
  wecomMessages: [],
  knowledgeAssets: [],
  exams: [],
  ocrJob: null,
  problems: [],
  memos: [],
  competitors: [],
  caseStudies: [],
  accounts: [],
  reportNote: "",
  todoFilter: "all",
  selectedCustomerId: null,
  selectedProblemId: null,
  selectedMemoId: null,
  selectedCompetitorId: null,
  selectedCaseId: null
};

let memoDirty = false;
let memoSaving = false;
let memoSavePromise: Promise<void> | null = null;

const roleEmail: Record<Role, string> = {
  sales: "shirley@goodjob.com",
  manager: "alex@goodjob.com",
  admin: "admin@goodjob.com"
};

const roleLabel: Record<Role, string> = {
  sales: "业务员",
  manager: "销售主管",
  admin: "管理员"
};

const storage = {
  token: "gj_token",
  user: "gj_user",
  dashboardCache: "gj_dashboard_cache"
};

function qs<T extends Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector(selector) as T | null;
}

function qsa<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll(selector)] as T[];
}

function money(value: number) {
  return `$${Math.round(value / 1000)}k`;
}

function amount(value: number) {
  return `$${value.toLocaleString("en-US")}`;
}

function currentDateTimeText() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function todayStart() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseTodoDate(value: string) {
  const text = value.trim();
  const exact = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/);
  if (exact) {
    const [, year, month, day, hour = "0", minute = "0"] = exact;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  }
  const base = todayStart();
  if (/^(\d{1,2}):(\d{2})$/.test(text) || text.includes("今天")) return base;
  if (text.includes("昨天")) return new Date(base.getTime() - 86400000);
  if (text.includes("前天")) return new Date(base.getTime() - 86400000 * 2);
  if (text.includes("明天")) return new Date(base.getTime() + 86400000);
  return null;
}

function isHistoricalTodo(todo: Todo) {
  const date = parseTodoDate(todo.dueAt);
  if (!date) return false;
  return date < todayStart();
}

function todoCreatedTime(todo: Todo, fallbackIndex = 0) {
  if (todo.createdAt) {
    const parsed = new Date(todo.createdAt).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  const idTime = todo.id.match(/^t_(\d{10,})$/);
  if (idTime) return Number(idTime[1]);
  const due = parseTodoDate(todo.dueAt)?.getTime();
  if (due && Number.isFinite(due)) return due;
  return -fallbackIndex;
}

function sortTodos(todos: Todo[]) {
  return todos
    .map((todo, index) => ({ todo, index }))
    .sort((left, right) => {
      if (left.todo.done !== right.todo.done) return left.todo.done ? 1 : -1;
      return todoCreatedTime(right.todo, right.index) - todoCreatedTime(left.todo, left.index);
    })
    .map((item) => item.todo);
}

function activeTodos(todos: Todo[]) {
  return sortTodos(todos.filter((todo) => !isHistoricalTodo(todo)));
}

function historyTodos(todos: Todo[]) {
  return sortTodos(todos.filter(isHistoricalTodo));
}

function badge(text: string, tone = "") {
  return `<span class="badge ${tone}">${text}</span>`;
}

function todoTypeText(type: string) {
  const map: Record<string, string> = {
    customer: "客户跟进",
    knowledge: "资料维护",
    exam: "在线考试",
    ocr: "OCR 线索",
    other: "其它"
  };
  return map[type] || "其它";
}

function escapeHtml(value: string | number | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function ensureUiLayer() {
  if (!qs(".toast-stack")) {
    document.body.insertAdjacentHTML("beforeend", `<div class="toast-stack" aria-live="polite"></div>`);
  }
  if (!qs("#appModal")) {
    document.body.insertAdjacentHTML("beforeend", `
      <div class="modal-backdrop" id="appModal" role="dialog" aria-modal="true">
        <div class="modal">
          <div class="modal-head"><h2 id="modalTitle">操作</h2><button class="btn icon-only" data-modal-close title="关闭">×</button></div>
          <div class="modal-body" id="modalBody"></div>
          <div class="modal-foot" id="modalFoot"></div>
        </div>
      </div>
    `);
    qs("[data-modal-close]")?.addEventListener("click", closeModal);
    qs("#appModal")?.addEventListener("click", (event) => {
      if (event.target === qs("#appModal")) closeModal();
    });
  }
}

function toast(message: string, type: "ok" | "error" = "ok") {
  ensureUiLayer();
  const stack = qs<HTMLElement>(".toast-stack")!;
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  stack.appendChild(item);
  window.setTimeout(() => item.remove(), 2600);
}

function openModal(title: string, body: string, foot: string) {
  ensureUiLayer();
  qs("#modalTitle")!.textContent = title;
  qs("#modalBody")!.innerHTML = body;
  qs("#modalFoot")!.innerHTML = foot;
  qsa("[data-modal-close]", qs("#appModal")!).forEach((node) => node.addEventListener("click", closeModal));
  qs("#appModal")!.classList.add("active");
}

function closeModal() {
  qs("#appModal")?.classList.remove("active");
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(storage.token);
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: "请求失败" }));
    throw new Error(body.message || "请求失败");
  }
  return response.json() as Promise<T>;
}

async function loginByRole(role: Role) {
  const result = await api<{ token: string; user: User }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: roleEmail[role], password: "goodjob123" })
  });
  localStorage.setItem(storage.token, result.token);
  localStorage.setItem(storage.user, JSON.stringify(result.user));
  state.user = result.user;
  applyAuthedUser(result.user);
  document.body.classList.add("is-authenticated");
  await refreshAll(result.user);
  toast(`已登录：${result.user.name}`);
}

function applyAuthedUser(user: User) {
  const profileName = `${user.name} / ${roleLabel[user.role]}`;
  document.body.dataset.role = user.role === "sales" ? "sales" : "manager";
  qs("#scopeUser")!.textContent = profileName;
  qs("#scopeText")!.textContent = user.role === "sales" ? "仅本人客户、本人待办、本人线索" : user.role === "manager" ? "欧洲组全部客户、全部待办、团队考试成绩" : "全量客户、账号、权限、审计与系统配置";
  qs("#currentAvatar")!.textContent = user.avatar;
  const roleSwitcher = qs<HTMLSelectElement>("#roleSwitcher");
  const loginRole = qs<HTMLSelectElement>("#loginRole");
  if (roleSwitcher) roleSwitcher.value = user.role;
  if (loginRole) loginRole.value = user.role;
}

async function refreshAll(user: User) {
  renderDashboardCache(user);
  const [summary, customers, todos, deals, reminders, jobs, wecom, knowledge, exams, ocr, problems, memos, competitors, caseStudies] = await Promise.all([
    api<DashboardSummary>("/api/dashboard/summary"),
    api<{ customers: Customer[] }>("/api/customers"),
    api<{ todos: Todo[] }>("/api/todos"),
    api<{ deals: Deal[] }>("/api/deals"),
    api<{ reminders: Reminder[] }>("/api/reminders"),
    api<{ jobs: ImportExportJob[] }>("/api/import-export/jobs"),
    api<{ messages: WecomMessage[] }>("/api/wecom/messages"),
    api<{ assets: KnowledgeAsset[] }>("/api/knowledge/assets"),
    api<{ exams: Exam[] }>("/api/exams"),
    api<{ job: OcrJob }>("/api/tools/ocr/jobs/ocr1"),
    api<{ problems: ProblemItem[] }>("/api/problems"),
    api<{ memos: Memo[] }>("/api/memos"),
    api<{ competitors: Competitor[] }>("/api/competitors"),
    api<{ caseStudies: CaseStudy[] }>("/api/case-studies")
  ]);
  state.user = user;
  state.summary = summary;
  state.customers = customers.customers;
  state.todos = todos.todos;
  state.deals = deals.deals;
  state.reminders = reminders.reminders;
  state.jobs = jobs.jobs;
  state.wecomMessages = wecom.messages;
  state.knowledgeAssets = knowledge.assets;
  state.exams = exams.exams;
  state.ocrJob = ocr.job;
  state.problems = problems.problems;
  state.memos = memos.memos;
  state.competitors = competitors.competitors;
  state.caseStudies = caseStudies.caseStudies;
  state.selectedCustomerId = state.selectedCustomerId || customers.customers[0]?.id || null;
  state.selectedProblemId = state.selectedProblemId || problems.problems[0]?.id || null;
  state.selectedMemoId = state.selectedMemoId || memos.memos[0]?.id || null;
  state.selectedCompetitorId = state.selectedCompetitorId || competitors.competitors[0]?.id || null;
  state.selectedCaseId = state.selectedCaseId || caseStudies.caseStudies[0]?.id || null;
  writeDashboardCache(user, summary, todos.todos, customers.customers);
  renderDashboard(summary, todos.todos, customers.customers);
  renderCustomers(customers.customers);
  renderPipeline(deals.deals);
  renderReminders(reminders.reminders);
  renderJobs(jobs.jobs);
  renderWecom(wecom.messages);
  renderKnowledge(knowledge.assets);
  renderExams(exams.exams);
  renderProblems(problems.problems);
  renderMemos(memos.memos);
  renderCompetitors(competitors.competitors);
  renderCaseStudies(caseStudies.caseStudies);
  await renderAccounts(user);
  renderOcr(ocr.job);
}

function dashboardCacheKey(user: User) {
  return `${user.id}:${user.role}:${user.teamId}`;
}

function readDashboardCache(user: User) {
  try {
    const raw = localStorage.getItem(storage.dashboardCache);
    if (!raw) return null;
    const cache = JSON.parse(raw) as Record<string, { summary: DashboardSummary; todos: Todo[]; customers: Customer[]; cachedAt: string }>;
    const item = cache[dashboardCacheKey(user)];
    if (!item) return null;
    const age = Date.now() - new Date(item.cachedAt).getTime();
    return age < 5 * 60 * 1000 ? item : null;
  } catch {
    return null;
  }
}

function writeDashboardCache(user: User, summary: DashboardSummary, todos: Todo[], customers: Customer[]) {
  try {
    const raw = localStorage.getItem(storage.dashboardCache);
    const cache = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    cache[dashboardCacheKey(user)] = { summary, todos, customers, cachedAt: new Date().toISOString() };
    localStorage.setItem(storage.dashboardCache, JSON.stringify(cache));
  } catch {
    // Cache is an optimization; rendering must not depend on it.
  }
}

function renderDashboardCache(user: User) {
  const cached = readDashboardCache(user);
  if (!cached) return;
  state.summary = cached.summary;
  state.todos = cached.todos;
  state.customers = cached.customers;
  renderDashboard(cached.summary, cached.todos, cached.customers, true);
}

async function refreshDashboardOnly() {
  if (!state.user) return;
  const [summary, todos, customers] = await Promise.all([
    api<DashboardSummary>("/api/dashboard/summary"),
    api<{ todos: Todo[] }>("/api/todos"),
    api<{ customers: Customer[] }>("/api/customers")
  ]);
  state.summary = summary;
  state.todos = todos.todos;
  state.customers = customers.customers;
  writeDashboardCache(state.user, summary, todos.todos, customers.customers);
  renderDashboard(summary, todos.todos, customers.customers);
}

function renderDashboard(summary: DashboardSummary, todos: Todo[], customers: Customer[], fromCache = false) {
  qs("#scopeText")!.textContent = summary.scope;
  qs<HTMLElement>(".focus-top span:last-child")!.textContent = fromCache ? "缓存数据 · 后台刷新中" : `${formatTime(summary.updatedAt)} 已更新`;
  qs<HTMLElement>(".focus-title h2")!.textContent = summary.briefing.title;
  qs<HTMLElement>(".focus-title p")!.textContent = summary.briefing.description;
  const basis = qs<HTMLElement>("#briefingBasis");
  const action = qs<HTMLElement>("#briefingAction");
  const impact = qs<HTMLElement>("#briefingImpact");
  if (basis) basis.textContent = summary.briefing.basis;
  if (action) action.textContent = summary.briefing.action;
  if (impact) impact.textContent = summary.briefing.impact;
  const focusMetrics = qsa<HTMLElement>(".focus-metric");
  if (focusMetrics[0]) focusMetrics[0].innerHTML = `<span>高风险金额</span><b>${money(summary.briefing.riskAmount)}</b><small>${escapeHtml(summary.briefing.riskLabel)}</small>`;
  if (focusMetrics[1]) focusMetrics[1].innerHTML = `<span>待主管协同</span><b>${summary.metrics.overdueTodos} 项</b><small>高优先级待办</small>`;
  if (focusMetrics[2]) focusMetrics[2].innerHTML = `<span>今日可成交</span><b>${summary.briefing.closableDeals} 单</b><small>预计 ${money(summary.briefing.closableAmount)}</small>`;
  if (focusMetrics[3]) focusMetrics[3].innerHTML = `<span>企微未读提醒</span><b>${summary.briefing.unreadWecom} 条</b><small>来自客户会话</small>`;
  const kpis = qsa<HTMLElement>("#dashboard .kpi strong");
  if (kpis[0]) kpis[0].textContent = String(summary.metrics.todos);
  if (kpis[1]) kpis[1].textContent = String(summary.metrics.customers);
  if (kpis[2]) kpis[2].textContent = money(summary.metrics.forecastAmount);
  if (kpis[3]) kpis[3].textContent = `${summary.metrics.wecomBoundRate}%`;
  const kpiNotes = qsa<HTMLElement>("#dashboard .kpi p");
  if (kpiNotes[0]) kpiNotes[0].innerHTML = badge(`${summary.metrics.overdueTodos} 个高优先级`, summary.metrics.overdueTodos ? "red" : "green");
  if (kpiNotes[1]) kpiNotes[1].textContent = `当前账号可见客户 ${summary.metrics.customers} 个`;
  if (kpiNotes[2]) kpiNotes[2].textContent = `按可见商机金额汇总`;
  if (kpiNotes[3]) kpiNotes[3].textContent = `${customers.filter((customer) => !customer.wecomBound).length} 个客户待绑定`;
  renderSchedule(summary);
  renderPipelineHealth(summary);
  renderDashboardDense(summary);
  renderTodoInsights(summary);
  renderPriorityTasks(summary);
  renderTodos(todos);
  updateTodoChips(todos);
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function renderSchedule(summary: DashboardSummary) {
  const list = qs<HTMLElement>(".schedule-list");
  if (list) {
    list.innerHTML = summary.schedule.length ? summary.schedule.map((item) => `<div class="schedule-item"><div class="timebox">${escapeHtml(item.time)}</div><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.subtitle)}</span></div>${badge(item.tone === "red" ? "高优先级" : item.tone === "amber" ? "中优先级" : "待处理", item.tone)}</div>`).join("") : `<div class="todo-history-empty">暂无今日节奏</div>`;
  }
  const quality = qsa<HTMLElement>(".quality b");
  if (quality[0]) quality[0].textContent = `${summary.quality.followHealth}%`;
  if (quality[1]) quality[1].textContent = `${summary.quality.overdueRate}%`;
  if (quality[2]) quality[2].textContent = `${summary.quality.avgResponseHours}h`;
}

function renderPipelineHealth(summary: DashboardSummary) {
  const box = qs<HTMLElement>("#dashboard .bars");
  if (!box) return;
  box.innerHTML = summary.pipelineHealth.length ? summary.pipelineHealth.map((item) => {
    const toneClass = item.tone === "green" ? "green" : item.tone === "amber" ? "amber" : item.tone === "red" ? "red" : "aqua";
    const risk = item.riskCount ? ` · ${item.riskCount} 风险` : "";
    return `<div class="bar-row"><span>${escapeHtml(item.stage)}</span><div class="track"><div class="fill ${toneClass}" style="width:${item.width}%"></div></div><b>${item.count} 单 · ${money(item.amount)}${risk}</b></div>`;
  }).join("") : `<div class="todo-history-empty">暂无商机管道数据</div>`;
}

function renderDashboardDense(summary: DashboardSummary) {
  const cards = qsa<HTMLElement>("#dashboard > .dense-grid .dense-card");
  const values = [
    { label: "资料待更新", value: String(summary.metrics.pendingKnowledge), note: "来自资料库" },
    { label: "产品知识考试通过率", value: `${summary.metrics.examPassRate}%`, note: "已发布考试均值" },
    { label: "未发布考试", value: String(summary.metrics.unfinishedExams), note: "待维护" },
    { label: "客户资料完整度", value: `${summary.metrics.customerCompleteness}%`, note: "按关键字段计算" }
  ];
  cards.forEach((card, index) => {
    const item = values[index];
    if (!item) return;
    card.innerHTML = `<span>${item.label}</span><b>${item.value}</b><small>${item.note}</small>`;
  });
}

function renderTodoInsights(summary: DashboardSummary) {
  const scoreCards = qsa<HTMLElement>(".todo-score-card b");
  if (scoreCards[0]) scoreCards[0].textContent = String(summary.todoInsights.total);
  if (scoreCards[1]) scoreCards[1].textContent = String(summary.todoInsights.overdue);
  if (scoreCards[2]) scoreCards[2].textContent = `${summary.todoInsights.completionRate}%`;
  if (scoreCards[3]) scoreCards[3].textContent = money(summary.todoInsights.impactAmount);
  const table = qs<HTMLElement>("#dashboard .todo-insights .mini-table tbody");
  if (table) {
    table.innerHTML = summary.todoInsights.typeRows.length ? summary.todoInsights.typeRows.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${row.count}</td><td>${badge(row.risk, row.risk === "高" ? "red" : row.risk === "中" ? "amber" : "")}</td></tr>`).join("") : `<tr><td>暂无待办</td><td>0</td><td>${badge("安全", "green")}</td></tr>`;
  }
  const calendar = qs<HTMLElement>("#dashboard .todo-calendar");
  if (calendar) {
    calendar.innerHTML = summary.todoInsights.weekLoad.map((item) => `<div class="todo-day ${item.count >= 4 ? "hot" : item.count <= 1 ? "ok" : ""}">${escapeHtml(item.day)}<br>${item.count}</div>`).join("");
  }
}

function renderPriorityTasks(summary: DashboardSummary) {
  const list = qs<HTMLElement>("#dashboard .task-list");
  if (!list) return;
  list.innerHTML = summary.priorityTasks.length ? summary.priorityTasks.map((task) => `<article class="task" data-priority-task-id="${escapeHtml(task.id)}" style="--accent: var(--${task.tone === "red" ? "rose" : task.tone})">
    <i class="task-line"></i>
    <div><h3>${escapeHtml(task.action)}</h3><p>${escapeHtml(task.subtitle)}</p><div class="priority-task-meta"><span>${escapeHtml(task.reason)}</span></div></div>
    <div class="priority-score">${task.score}<br>分</div>
    ${badge(task.badge, task.tone === "red" ? "red" : task.tone === "amber" ? "amber" : "")}
  </article>`).join("") : `<div class="todo-history-empty">暂无高优先级跟进任务</div>`;
}

async function batchProcessPriorityTasks(button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "生成中";
  }
  try {
    const result = await api<{ created: Todo[]; processed: number; skipped: number }>("/api/dashboard/priority-tasks/batch-process", { method: "POST" });
    if (result.created.length) {
      state.todos.unshift(...result.created);
      renderTodos(state.todos);
      updateTodoChips(state.todos);
    }
    await refreshDashboardOnly();
    toast(result.created.length ? `已生成 ${result.created.length} 条跟进待办` : "推荐项已有待办，无需重复生成");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "批量生成跟进待办";
    }
  }
}

function renderTodos(todos: Todo[]) {
  const list = qs<HTMLElement>("#dashboard .todo-list");
  if (!list) return;
  const currentTodos = activeTodos(todos);
  const archivedTodos = historyTodos(todos);
  const isHistoryView = state.todoFilter === "history";
  const visibleTodos = isHistoryView ? archivedTodos : filterTodos(currentTodos);
  list.innerHTML = visibleTodos.map((todo) => {
    const tone = todo.priority === "high" ? "red" : todo.priority === "medium" ? "amber" : "green";
    const optionalMeta = [todo.dueAt, todo.related].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join("");
    return `<article class="todo-row ${todo.priority === "high" ? "urgent" : ""} ${todo.done ? "done" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <i class="todo-check" title="${todo.done ? "撤回未完成" : "完成待办"}"></i>
      <div class="todo-main"><h3>${escapeHtml(todo.title)}</h3><div class="todo-meta"><i class="priority-dot" style="--color:var(--${tone === "red" ? "rose" : tone})"></i><span>${escapeHtml(priorityText(todo.priority))}</span>${optionalMeta}${badge(todo.done ? "已完成" : isHistoryView ? "历史归档" : todoTypeText(todo.type), todo.done ? "green" : tone)}</div></div>
      <div class="todo-side"><div class="todo-actions"><div class="assignee-stack"><span class="mini-avatar">我</span></div><button class="todo-delete" title="删除待办" aria-label="删除待办"><svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg></button></div><div class="subtask-bar"><i style="--p:${todo.done ? "100%" : "55%"}"></i></div></div>
    </article>`;
  }).join("");
  qsa<HTMLElement>(".todo-row .todo-delete", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      if (row?.dataset.todoId) await deleteTodo(row.dataset.todoId);
    });
  });
  qsa<HTMLElement>(".todo-row .todo-check", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      if (!row?.dataset.todoId) return;
      const todo = state.todos.find((item) => item.id === row.dataset.todoId);
      if (!todo) return;
      const nextDone = !todo.done;
      const result = await api<{ todo: Todo }>(`/api/todos/${todo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ done: nextDone })
      });
      Object.assign(todo, result.todo);
      renderTodos(state.todos);
      updateTodoChips(state.todos);
      void refreshDashboardOnly();
      toast(todo.done ? "待办已完成" : "已撤回未完成");
    });
  });
  qsa<HTMLElement>(".todo-row", list).forEach((row) => {
    row.addEventListener("click", () => {
      const todo = state.todos.find((item) => item.id === row.dataset.todoId);
      if (todo) toast([todo.related, todo.dueAt].filter(Boolean).join(" · ") || "未设置关联对象和目标完成时间");
    });
  });
  const total = visibleTodos.length;
  const overdue = visibleTodos.filter((todo) => todo.priority === "high" && !todo.done).length;
  const done = visibleTodos.filter((todo) => todo.done).length;
  const scoreCards = qsa<HTMLElement>(".todo-score-card b");
  if (scoreCards[0]) scoreCards[0].textContent = String(total);
  if (scoreCards[1]) scoreCards[1].textContent = String(overdue);
  if (scoreCards[2]) scoreCards[2].textContent = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
  if (scoreCards[3]) scoreCards[3].textContent = money(visibleTodos.reduce((sum, todo) => sum + (todo.impactAmount || 0), 0));
  renderTodoHistory(archivedTodos);
}

function renderTodoHistory(todos: Todo[]) {
  const list = qs<HTMLElement>("#dashboard .todo-history-list");
  const count = qs<HTMLElement>("#dashboard #todo-history-count");
  const amountNode = qs<HTMLElement>("#dashboard #todo-history-amount");
  if (count) count.textContent = `${todos.length} 条`;
  if (amountNode) amountNode.textContent = money(todos.reduce((sum, todo) => sum + (todo.impactAmount || 0), 0));
  if (!list) return;
  const recent = todos.slice(0, 6);
  list.innerHTML = recent.length ? recent.map((todo) => {
    const tone = todo.priority === "high" ? "red" : todo.priority === "medium" ? "amber" : "green";
    const meta = [todo.dueAt, todo.related].filter(Boolean).join(" · ") || "未设置上下文";
    return `<article class="todo-history-row ${todo.done ? "done" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <span class="history-dot ${tone}"></span>
      <div><b>${escapeHtml(todo.title)}</b><span>${escapeHtml(meta)}</span></div>
      <div class="todo-actions">${badge(todo.done ? "历史完成" : "历史归档", todo.done ? "green" : tone)}<button class="todo-delete" title="删除待办" aria-label="删除待办"><svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg></button></div>
    </article>`;
  }).join("") : `<div class="todo-history-empty">暂无隔天历史待办</div>`;
  qsa<HTMLElement>(".todo-history-row .todo-delete", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-history-row");
      if (row?.dataset.todoId) await deleteTodo(row.dataset.todoId);
    });
  });
  qsa<HTMLElement>(".todo-history-row", list).forEach((row) => {
    row.addEventListener("click", () => {
      const todo = state.todos.find((item) => item.id === row.dataset.todoId);
      if (todo) toast(["历史清单", todo.related, todo.dueAt].filter(Boolean).join(" · "));
    });
  });
}

async function deleteTodo(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) {
    toast("待办不存在", "error");
    return;
  }
  await api<{ ok: boolean; id: string }>(`/api/todos/${id}`, { method: "DELETE" });
  state.todos = state.todos.filter((item) => item.id !== id);
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  toast("待办已删除");
}

function filterTodos(todos: Todo[]) {
  if (state.todoFilter === "overdue") return todos.filter((todo) => todo.priority === "high" && !todo.done);
  if (state.todoFilter === "customer") return todos.filter((todo) => todo.type === "customer");
  return todos;
}

function updateTodoChips(todos: Todo[]) {
  const chips = qsa<HTMLElement>("#dashboard .todo-chip");
  const currentTodos = activeTodos(todos);
  const values = [
    `今天 ${currentTodos.filter((todo) => !todo.done).length}`,
    `逾期 ${currentTodos.filter((todo) => todo.priority === "high" && !todo.done).length}`,
    `我负责 ${currentTodos.length}`,
    "客户跟进",
    `历史清单 ${historyTodos(todos).length}`
  ];
  chips.forEach((chip, index) => {
    chip.textContent = values[index] || chip.textContent || "";
    const filters: AppState["todoFilter"][] = ["today", "overdue", "mine", "customer", "history"];
    chip.dataset.todoFilter = filters[index] || "all";
    chip.classList.toggle("active", state.todoFilter === chip.dataset.todoFilter || (state.todoFilter === "all" && index === 0));
  });
}

function priorityText(priority: string) {
  if (priority === "high") return "高优先级";
  if (priority === "medium") return "中优先级";
  return "普通";
}

function severityText(severity: string) {
  if (severity === "high") return "高";
  if (severity === "medium") return "中";
  return "低";
}

function severityTone(severity: string) {
  if (severity === "high") return "red";
  if (severity === "medium") return "amber";
  return "green";
}

function problemStatusText(status: string) {
  if (status === "resolved") return "已解决";
  if (status === "solving") return "解决中";
  return "未解决";
}

function problemStatusTone(status: string) {
  if (status === "resolved") return "green";
  if (status === "solving") return "amber";
  return "red";
}

function threatText(level: string) {
  if (level === "high") return "高威胁";
  if (level === "medium") return "中威胁";
  return "低威胁";
}

function caseStatusText(status: string) {
  return status === "published" ? "已发布" : "草稿";
}

function renderCustomers(customers: Customer[]) {
  const tbody = qs<HTMLElement>("#customers tbody");
  if (!tbody) return;
  tbody.innerHTML = customers.map((customer, index) => `<tr class="${index === 0 ? "selected" : ""}">
    <td><div class="company"><span class="flag">${countryFlag(customer.country)}</span><div><b>${escapeHtml(customer.company)}</b><span>${escapeHtml(customer.contact)}</span></div></div></td>
    <td>${escapeHtml(customer.country)}</td>
    <td>${badge(customer.stage, customer.stage === "成交" || customer.stage === "谈判" ? "green" : customer.stage === "已报价" ? "amber" : "")}</td>
    <td class="amount">${amount(customer.amount)}</td>
    <td>${health(customer.health)}</td>
    <td>今天</td>
    <td>${customer.nextReminder.includes("逾期") ? badge(customer.nextReminder, "red") : escapeHtml(customer.nextReminder)}</td>
    <td>${badge(customer.wecomBound ? "已绑定" : "未绑定", customer.wecomBound ? "green" : "gray")}</td>
    <td>${customer.id === "c3" || customer.id === "c4" ? "Mia" : "Shirley"}</td>
  </tr>`).join("");
  qsa<HTMLElement>("tr", tbody).forEach((row, index) => {
    const customer = customers[index];
    row.dataset.customerId = customer.id;
    row.classList.toggle("selected", customer.id === (state.selectedCustomerId || customers[0]?.id));
    row.addEventListener("click", () => {
      state.selectedCustomerId = customer.id;
      renderCustomerDrawer(customer);
      qsa<HTMLElement>("tr", tbody).forEach((item) => item.classList.toggle("selected", item.dataset.customerId === customer.id));
    });
  });
  renderCustomerDrawer(customers.find((item) => item.id === state.selectedCustomerId) || customers[0]);
}

function renderCustomerDrawer(customer?: Customer) {
  const drawer = qs<HTMLElement>("#customers .drawer");
  if (!drawer || !customer) return;
  drawer.innerHTML = `
    <div class="drawer-head">
      <div><h2>${escapeHtml(customer.company)}</h2><p>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact)} · ${escapeHtml(customer.stage)}</p></div>
      ${customer.nextReminder.includes("逾期") ? badge("报价未回复", "red") : badge("跟进中", "green")}
    </div>
    <div class="score-card">
      <div class="score-ring"><span>${customer.health}</span></div>
      <div><b>成交评分：${customer.health >= 80 ? "高" : customer.health >= 60 ? "中" : "需抢救"}</b><p>系统按金额、阶段、健康度和下一提醒生成优先级。</p></div>
    </div>
    <div class="info-grid">
      <div class="info"><span>预计金额</span><b>${amount(customer.amount)}</b></div>
      <div class="info"><span>健康度</span><b>${customer.health}%</b></div>
      <div class="info"><span>当前阶段</span><b>${escapeHtml(customer.stage)}</b></div>
      <div class="info"><span>下一提醒</span><b>${escapeHtml(customer.nextReminder)}</b></div>
    </div>
    <button class="btn primary" data-add-follow style="width:100%">新增跟进记录</button>
    <div class="timeline">
      <div class="timeline-item"><b>企微摘要</b><span>${customer.wecomBound ? "客户已绑定企微，可归档会话摘要。" : "客户暂未绑定企微，建议补充联系方式。"}</span></div>
      <div class="timeline-item"><b>系统提醒</b><span>${escapeHtml(customer.nextReminder)}</span></div>
      <div class="timeline-item"><b>客户阶段</b><span>${escapeHtml(customer.stage)} · ${amount(customer.amount)}</span></div>
    </div>
  `;
  qs<HTMLButtonElement>("[data-add-follow]", drawer)?.addEventListener("click", () => addFollowRecord(customer));
}

function countryFlag(country: string) {
  const flags: Record<string, string> = { 瑞典: "SE", 美国: "US", 日本: "JP", 阿联酋: "AE", 德国: "DE" };
  return flags[country] || "GL";
}

function health(value: number) {
  const active = Math.max(1, Math.round(value / 20));
  return `<span class="health ${value < 60 ? "bad" : value < 75 ? "warn" : ""}">${[1, 2, 3, 4, 5].map((item) => `<i class="${item <= active ? "on" : ""}"></i>`).join("")}</span>`;
}

function renderPipeline(deals: Deal[]) {
  const strip = qs<HTMLElement>("#pipeline .pipeline-strip");
  if (!strip) return;
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"];
  strip.innerHTML = stages.map((stage) => {
    const stageDeals = deals.filter((deal) => deal.stage === stage || (stage === "成交" && deal.stage === "成交"));
    return `<div class="stage"><div class="stage-head"><span>${stage === "成交" ? "成交/丢单" : stage}</span><b>${stageDeals.length}</b></div>${stageDeals.map((deal) => `<div class="deal" data-deal-id="${escapeHtml(deal.id)}"><b>${escapeHtml(deal.title)}</b><span>${escapeHtml(deal.nextAction)}</span><div class="deal-foot"><span>${money(deal.amount)}</span>${badge(deal.stage, deal.stage === "成交" ? "green" : deal.stage === "已报价" ? "red" : "")}</div><button class="btn" data-move-deal>推进阶段</button></div>`).join("") || `<div class="deal"><b>暂无商机</b><span>等待新线索进入</span><div class="deal-foot"><span>$0k</span><span>空</span></div></div>`}</div>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-move-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => void moveDeal(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
}

async function moveDeal(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"] as const;
  const nextStage = stages[Math.min(stages.indexOf(deal.stage as typeof stages[number]) + 1, stages.length - 1)];
  const result = await api<{ deal: Deal }>(`/api/deals/${id}/stage`, {
    method: "PATCH",
    body: JSON.stringify({ stage: nextStage })
  });
  Object.assign(deal, result.deal);
  renderPipeline(state.deals);
  void refreshDashboardOnly();
  toast(`商机已推进到：${nextStage}`);
}

function openDealModal() {
  openModal("新增商机", `
    <div class="form-grid">
      <div class="form-field full"><label>商机名称</label><input id="dealTitleInput" value="${escapeHtml(state.customers[0]?.company || "新客户")} 采购机会"></div>
      <div class="form-field"><label>关联客户</label><select id="dealCustomerInput">${state.customers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.company)}</option>`).join("")}</select></div>
      <div class="form-field"><label>阶段</label><select id="dealStageInput"><option>询盘</option><option>已联系</option><option>已报价</option><option>样品</option><option>谈判</option></select></div>
      <div class="form-field"><label>金额</label><input id="dealAmountInput" type="number" value="18000"></div>
      <div class="form-field full"><label>下一步动作</label><input id="dealNextActionInput" value="确认采购清单并安排报价"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveDealButton">保存商机</button>`);
  qs("#saveDealButton")?.addEventListener("click", () => void saveDeal());
}

async function saveDeal() {
  const title = qs<HTMLInputElement>("#dealTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写商机名称", "error");
    return;
  }
  const result = await api<{ deal: Deal }>("/api/deals", {
    method: "POST",
    body: JSON.stringify({
      title,
      customerId: qs<HTMLSelectElement>("#dealCustomerInput")?.value || state.customers[0]?.id,
      stage: qs<HTMLSelectElement>("#dealStageInput")?.value || "询盘",
      amount: Number(qs<HTMLInputElement>("#dealAmountInput")?.value || 0),
      nextAction: qs<HTMLInputElement>("#dealNextActionInput")?.value || "首次跟进"
    })
  });
  state.deals.unshift(result.deal);
  renderPipeline(state.deals);
  void refreshDashboardOnly();
  closeModal();
  toast("商机已新增");
}

function renderReminders(reminders: Reminder[]) {
  const list = qs<HTMLElement>("#reminders .task-list");
  if (!list) return;
  list.innerHTML = reminders.map((reminder) => `<article class="task" data-reminder-id="${escapeHtml(reminder.id)}" style="--accent: var(--${reminder.status === "done" ? "green" : "rose"})"><i class="task-line"></i><div><h3>${escapeHtml(reminder.title)}</h3><p>${escapeHtml(reminder.rule)} · ${escapeHtml(reminder.dueAt)} · ${escapeHtml(reminder.channel)}</p></div><button class="btn">${reminder.status === "done" ? "已完成" : "完成"}</button></article>`).join("");
  qsa<HTMLButtonElement>("#reminders .task .btn", list).forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest<HTMLElement>(".task");
      if (!row?.dataset.reminderId) return;
      await api(`/api/reminders/${row.dataset.reminderId}/done`, { method: "POST" });
      const reminder = state.reminders.find((item) => item.id === row.dataset.reminderId);
      if (reminder) reminder.status = "done";
      button.textContent = "已完成";
      toast("提醒已完成");
    });
  });
}

function renderProblems(problems: ProblemItem[]) {
  const sorted = [...problems].sort((a, b) => {
    const statusWeight = (item: ProblemItem) => item.status === "resolved" ? 2 : item.status === "solving" ? 1 : 0;
    const severityWeight = (item: ProblemItem) => item.severity === "high" ? 0 : item.severity === "medium" ? 1 : 2;
    return statusWeight(a) - statusWeight(b) || severityWeight(a) - severityWeight(b) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const list = qs<HTMLElement>("#problems .problem-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((problem) => `<article class="problem-card ${state.selectedProblemId === problem.id ? "selected" : ""}" data-problem-id="${escapeHtml(problem.id)}">
      <div class="problem-top"><h3>${escapeHtml(problem.title)}</h3>${badge(severityText(problem.severity), severityTone(problem.severity))}</div>
      <div class="problem-meta"><span>${escapeHtml(problem.category)}</span><span>${escapeHtml(problemStatusText(problem.status))}</span><span>${escapeHtml(problem.dueAt || "未设截止")}</span><span>${escapeHtml(problem.relatedCustomer || "未关联客户")}</span></div>
      <p>${escapeHtml(problem.rootCause || "暂未填写原因")}</p>
    </article>`).join("") : `<div class="todo-history-empty">暂无问题，点击“新增问题”建立解决闭环</div>`;
    qsa<HTMLElement>(".problem-card", list).forEach((card) => {
      card.addEventListener("click", () => {
        state.selectedProblemId = card.dataset.problemId || null;
        renderProblems(state.problems);
      });
    });
  }
  const open = problems.filter((item) => item.status === "open").length;
  const solving = problems.filter((item) => item.status === "solving").length;
  const resolved = problems.filter((item) => item.status === "resolved").length;
  const high = problems.filter((item) => item.severity === "high" && item.status !== "resolved").length;
  qs("#problem-open-count")!.textContent = String(open);
  qs("#problem-solving-count")!.textContent = String(solving);
  qs("#problem-resolved-count")!.textContent = String(resolved);
  qs("#problem-high-count")!.textContent = String(high);
  renderProblemDetail(sorted.find((item) => item.id === state.selectedProblemId) || sorted[0]);
}

function renderProblemDetail(problem?: ProblemItem) {
  if (!problem) {
    qs("#problem-detail-title")!.textContent = "问题解决方案";
    qs("#problem-detail-meta")!.textContent = "选择左侧问题查看闭环";
    qs("#problem-root-cause")!.textContent = "暂无问题";
    qs("#problem-solution")!.textContent = "暂无解决方案";
    qs("#problem-next-action")!.textContent = "暂无下一动作";
    return;
  }
  state.selectedProblemId = problem.id;
  qs("#problem-detail-title")!.textContent = problem.title;
  qs("#problem-detail-meta")!.textContent = `${problem.category} · ${problemStatusText(problem.status)} · ${problem.relatedCustomer || "未关联客户"}`;
  qs("#problem-root-cause")!.textContent = problem.rootCause || "暂未填写原因";
  qs("#problem-solution")!.textContent = problem.solution || "暂未填写解决方案";
  qs("#problem-next-action")!.textContent = problem.nextAction || "暂未填写下一动作";
  const button = qs<HTMLButtonElement>("#problemStatusButton");
  if (button) button.textContent = problem.status === "resolved" ? "重新打开" : problem.status === "open" ? "开始解决" : "标记解决";
  const groups = state.problems.reduce<Record<string, { count: number; high: boolean }>>((acc, item) => {
    acc[item.category] = acc[item.category] || { count: 0, high: false };
    acc[item.category].count += 1;
    acc[item.category].high = acc[item.category].high || item.severity === "high";
    return acc;
  }, {});
  const tbody = qs<HTMLElement>("#problem-category-table");
  if (tbody) tbody.innerHTML = Object.entries(groups).map(([category, item]) => `<tr><td>${escapeHtml(category)}</td><td>${item.count}</td><td>${badge(item.high ? "高" : "可控", item.high ? "red" : "green")}</td></tr>`).join("");
}

function renderMemos(memos: Memo[]) {
  const sorted = [...memos].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(a.archived) - Number(b.archived) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const list = qs<HTMLElement>("#memos .memo-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((memo) => `<article class="memo-card ${state.selectedMemoId === memo.id ? "selected" : ""} ${memo.archived ? "archived" : ""}" data-memo-id="${escapeHtml(memo.id)}">
      <div class="memo-top"><h3>${escapeHtml(memo.title)}</h3>${badge(memo.archived ? "归档" : memo.pinned ? "置顶" : memo.category, memo.archived ? "" : memo.pinned ? "green" : "amber")}</div>
      <div class="memo-meta"><span>${escapeHtml(memo.category)}</span><span>${escapeHtml(memo.tags || "无标签")}</span></div>
      <p>${escapeHtml(memo.content.slice(0, 82) || "空白备忘")}</p>
    </article>`).join("") : `<div class="todo-history-empty">暂无备忘，点击“新增备忘”开始记录</div>`;
	    qsa<HTMLElement>(".memo-card", list).forEach((card) => {
	      card.addEventListener("click", async () => {
	        await saveCurrentMemoDraft();
	        state.selectedMemoId = card.dataset.memoId || null;
	        renderMemos(state.memos);
	      });
	    });
  }
  const totalCount = qs("#memo-total-count");
  const pinnedCount = qs("#memo-pinned-count");
  const customerCount = qs("#memo-customer-count");
  const archivedCount = qs("#memo-archived-count");
  if (totalCount) totalCount.textContent = String(memos.length);
  if (pinnedCount) pinnedCount.textContent = String(memos.filter((memo) => memo.pinned && !memo.archived).length);
  if (customerCount) customerCount.textContent = String(memos.filter((memo) => memo.category.includes("客户")).length);
  if (archivedCount) archivedCount.textContent = String(memos.filter((memo) => memo.archived).length);
  renderMemoDetail(sorted.find((item) => item.id === state.selectedMemoId) || sorted[0]);
}

function renderMemoDetail(memo?: Memo) {
  if (!memo) {
    qs("#memo-detail-title")!.textContent = "备忘详情";
    qs("#memo-detail-meta")!.textContent = "选择左侧备忘查看内容";
    const titleEditor = qs<HTMLInputElement>("#memoTitleEditor");
    const tagsEditor = qs<HTMLInputElement>("#memoTagsEditor");
    const contentEditor = qs<HTMLTextAreaElement>("#memoContentEditor");
    if (titleEditor) titleEditor.value = "暂无备忘";
    if (tagsEditor) tagsEditor.value = "";
    if (contentEditor) contentEditor.value = "点击“新增备忘”记录客户偏好、报价复盘或临时事项。";
    qs<HTMLButtonElement>("#memoPinButton")?.setAttribute("disabled", "true");
    qs<HTMLButtonElement>("#memoArchiveButton")?.setAttribute("disabled", "true");
    qs<HTMLButtonElement>("#memoDeleteButton")?.setAttribute("disabled", "true");
    return;
  }
  state.selectedMemoId = memo.id;
  qs("#memo-detail-title")!.textContent = "备忘编辑";
  qs("#memo-detail-meta")!.textContent = `${memo.category} · ${memo.archived ? "已归档" : "自动保存"}`;
  const titleEditor = qs<HTMLInputElement>("#memoTitleEditor");
  const tagsEditor = qs<HTMLInputElement>("#memoTagsEditor");
  const contentEditor = qs<HTMLTextAreaElement>("#memoContentEditor");
  if (titleEditor) titleEditor.value = memo.title;
  if (tagsEditor) tagsEditor.value = memo.tags;
  if (contentEditor) contentEditor.value = memo.content || "";
  memoDirty = false;
  setMemoSaveState("已保存");
  const pinButton = qs<HTMLButtonElement>("#memoPinButton");
  const archiveButton = qs<HTMLButtonElement>("#memoArchiveButton");
  const deleteButton = qs<HTMLButtonElement>("#memoDeleteButton");
  if (pinButton) pinButton.textContent = memo.pinned ? "取消置顶" : "置顶";
  if (archiveButton) archiveButton.textContent = memo.archived ? "恢复" : "归档";
  if (pinButton) pinButton.disabled = false;
  if (archiveButton) archiveButton.disabled = false;
  if (deleteButton) deleteButton.disabled = false;
  bindMemoEditorEvents();
}

function renderCompetitors(competitors: Competitor[]) {
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
    </article>`).join("") : `<div class="todo-history-empty">暂无竞争公司，点击“新增竞争公司”建立情报库</div>`;
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
  if (!competitor) return;
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

function renderCaseStudies(caseStudies: CaseStudy[]) {
  const sorted = [...caseStudies].sort((a, b) => Number(b.status === "published") - Number(a.status === "published") || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const list = qs<HTMLElement>("#cases .case-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((item) => `<article class="case-card ${state.selectedCaseId === item.id ? "selected" : ""}" data-case-id="${escapeHtml(item.id)}">
      <div class="case-top"><h3>${escapeHtml(item.title)}</h3>${badge(caseStatusText(item.status), item.status === "published" ? "green" : "amber")}</div>
      <div class="case-meta"><span>${escapeHtml(item.customer || "未关联客户")}</span><span>${escapeHtml(item.product || "未维护产品")}</span><span>${escapeHtml(item.country || "未知国家")}</span></div>
      <p>${escapeHtml(item.result || "暂未填写成果")}</p>
    </article>`).join("") : `<div class="todo-history-empty">暂无成功案例，点击“新增成功案例”沉淀销售素材</div>`;
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
  if (!caseStudy) return;
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

function bindMemoEditorEvents() {
  qsa<HTMLInputElement | HTMLTextAreaElement>("#memoTitleEditor, #memoTagsEditor, #memoContentEditor").forEach((input) => {
    if (input.dataset.memoBound === "true") return;
    input.dataset.memoBound = "true";
    input.addEventListener("input", () => {
      memoDirty = true;
      setMemoSaveState("未保存");
    });
    input.addEventListener("blur", () => void saveCurrentMemoDraft());
  });
}

function setMemoSaveState(text: string) {
  const node = qs<HTMLElement>("#memoSaveState");
  if (node) node.textContent = text;
}

function openReminderModal() {
  openModal("设置提醒规则", `
    <div class="form-grid">
      <div class="form-field full"><label>提醒名称</label><input id="reminderTitleInput" value="自动化报价跟进提醒"></div>
      <div class="form-field full"><label>触发规则</label><input id="reminderRuleInput" value="报价后 2 天未回复自动提醒"></div>
      <div class="form-field"><label>提醒时间</label><input id="reminderDueInput" value="今天 18:00"></div>
      <div class="form-field"><label>渠道</label><select id="reminderChannelInput"><option>企业微信</option><option>站内</option><option>邮件</option></select></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReminderButton">保存规则</button>`);
  qs("#saveReminderButton")?.addEventListener("click", () => void saveReminder());
}

async function saveReminder() {
  const title = qs<HTMLInputElement>("#reminderTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写提醒名称", "error");
    return;
  }
  const result = await api<{ reminder: Reminder }>("/api/reminders", {
    method: "POST",
    body: JSON.stringify({
      title,
      rule: qs<HTMLInputElement>("#reminderRuleInput")?.value || "报价后未回复",
      dueAt: qs<HTMLInputElement>("#reminderDueInput")?.value || "今天",
      channel: qs<HTMLSelectElement>("#reminderChannelInput")?.value || "企业微信"
    })
  });
  state.reminders.unshift(result.reminder);
  renderReminders(state.reminders);
  closeModal();
  toast("提醒规则已保存");
}

function openProblemModal() {
  openModal("新增问题", `
    <div class="form-grid">
      <div class="form-field full"><label>问题标题</label><input id="problemTitleInput" placeholder="例如：客户报价后超过 5 天未回复"></div>
      <div class="form-field"><label>类别</label><select id="problemCategoryInput"><option>报价跟进</option><option>资料维护</option><option>工具/OCR</option><option>客户服务</option><option>团队执行</option></select></div>
      <div class="form-field"><label>严重程度</label><select id="problemSeverityInput"><option value="medium">中</option><option value="high">高</option><option value="low">低</option></select></div>
      <div class="form-field"><label>关联客户</label><input id="problemCustomerInput" placeholder="可选：客户或线索名称"></div>
      <div class="form-field"><label>截止时间</label><input id="problemDueInput" placeholder="例如：今天 18:00"></div>
      <div class="form-field full"><label>问题原因</label><textarea id="problemRootInput" placeholder="描述问题产生原因"></textarea></div>
      <div class="form-field full"><label>解决方案</label><textarea id="problemSolutionInput" placeholder="写清楚解决路径、标准和注意事项"></textarea></div>
      <div class="form-field full"><label>下一动作</label><input id="problemNextInput" placeholder="例如：今天发送补充资料，明天企微确认"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveProblemButton">保存问题</button>`);
  qs("#saveProblemButton")?.addEventListener("click", () => void saveProblem());
  qs<HTMLInputElement>("#problemTitleInput")?.focus();
}

async function saveProblem() {
  const title = qs<HTMLInputElement>("#problemTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写问题标题", "error");
    return;
  }
  const result = await api<{ problem: ProblemItem }>("/api/problems", {
    method: "POST",
    body: JSON.stringify({
      title,
      category: qs<HTMLSelectElement>("#problemCategoryInput")?.value || "客户问题",
      severity: qs<HTMLSelectElement>("#problemSeverityInput")?.value || "medium",
      relatedCustomer: qs<HTMLInputElement>("#problemCustomerInput")?.value.trim() || "",
      rootCause: qs<HTMLTextAreaElement>("#problemRootInput")?.value.trim() || "",
      solution: qs<HTMLTextAreaElement>("#problemSolutionInput")?.value.trim() || "",
      nextAction: qs<HTMLInputElement>("#problemNextInput")?.value.trim() || "",
      dueAt: qs<HTMLInputElement>("#problemDueInput")?.value.trim() || ""
    })
  });
  state.problems.unshift(result.problem);
  state.selectedProblemId = result.problem.id;
  renderProblems(state.problems);
  closeModal();
  toast("问题已新增");
}

async function advanceProblemStatus() {
  const problem = state.problems.find((item) => item.id === state.selectedProblemId);
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

function openMemoModal() {
  openModal("新增备忘", `
    <div class="form-grid">
      <div class="form-field full"><label>标题</label><input id="memoTitleInput" placeholder="例如：某客户报价偏好"></div>
      <div class="form-field"><label>分类</label><select id="memoCategoryInput"><option>客户备忘</option><option>销售话术</option><option>产品知识</option><option>报价复盘</option><option>个人记录</option></select></div>
      <div class="form-field"><label>标签</label><input id="memoTagsInput" placeholder="多个标签用逗号分隔"></div>
      <div class="form-field full"><label>内容</label><textarea id="memoContentInput" placeholder="记录关键信息、背景、下一步或复盘结论"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveMemoButton">保存备忘</button>`);
  qs("#saveMemoButton")?.addEventListener("click", () => void saveMemo());
  qs<HTMLInputElement>("#memoTitleInput")?.focus();
}

async function saveMemo() {
  const title = qs<HTMLInputElement>("#memoTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写备忘标题", "error");
    return;
  }
  const result = await api<{ memo: Memo }>("/api/memos", {
    method: "POST",
    body: JSON.stringify({
      title,
      category: qs<HTMLSelectElement>("#memoCategoryInput")?.value || "客户备忘",
      tags: qs<HTMLInputElement>("#memoTagsInput")?.value.trim() || "",
      content: qs<HTMLTextAreaElement>("#memoContentInput")?.value.trim() || ""
    })
  });
  state.memos.unshift(result.memo);
  state.selectedMemoId = result.memo.id;
  renderMemos(state.memos);
  closeModal();
  toast("备忘已保存");
}

async function saveCurrentMemoDraft() {
  if (memoSavePromise) return memoSavePromise;
  if (!memoDirty) return;
  const memo = state.memos.find((item) => item.id === state.selectedMemoId);
  if (!memo) return;
  const title = qs<HTMLInputElement>("#memoTitleEditor")?.value.trim() || memo.title;
  const tags = qs<HTMLInputElement>("#memoTagsEditor")?.value.trim() || "";
  const content = qs<HTMLTextAreaElement>("#memoContentEditor")?.value || "";
  memoSaving = true;
  setMemoSaveState("保存中");
  memoSavePromise = (async () => {
    const result = await api<{ memo: Memo }>(`/api/memos/${memo.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title, tags, content })
    });
    Object.assign(memo, result.memo);
    memoDirty = false;
    setMemoSaveState("已自动保存");
    renderMemos(state.memos);
  })();
  try {
    await memoSavePromise;
  } finally {
    memoSaving = false;
    memoSavePromise = null;
  }
}

async function patchSelectedMemo(payload: Partial<Pick<Memo, "title" | "content" | "category" | "tags" | "pinned" | "archived">>) {
  await saveCurrentMemoDraft();
  const memo = state.memos.find((item) => item.id === state.selectedMemoId);
  if (!memo) return;
  const result = await api<{ memo: Memo }>(`/api/memos/${memo.id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  Object.assign(memo, result.memo);
  renderMemos(state.memos);
  toast(memo.archived ? "备忘已归档" : memo.pinned ? "备忘已置顶" : "备忘已更新");
}

async function deleteSelectedMemo() {
  const memo = state.memos.find((item) => item.id === state.selectedMemoId);
  if (!memo) {
    toast("请选择要删除的备忘", "error");
    return;
  }
  await api<{ ok: boolean; id: string }>(`/api/memos/${memo.id}`, { method: "DELETE" });
  state.memos = state.memos.filter((item) => item.id !== memo.id);
  state.selectedMemoId = state.memos[0]?.id || null;
  memoDirty = false;
  renderMemos(state.memos);
  toast("备忘已删除");
}

function openCompetitorModal() {
  openModal("新增竞争公司", `
    <div class="form-grid">
      <div class="form-field full"><label>公司名称</label><input id="competitorCompanyInput" placeholder="例如：EuroLift Tools GmbH"></div>
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

async function toggleCompetitorThreat() {
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

function openCaseModal() {
  openModal("新增成功案例", `
    <div class="form-grid">
      <div class="form-field full"><label>案例标题</label><input id="caseTitleInput" placeholder="例如：Nordic Tools 年度工具套装复购"></div>
      <div class="form-field"><label>客户</label><input id="caseCustomerInput" value="${escapeHtml(state.customers[0]?.company || "")}"></div>
      <div class="form-field"><label>国家</label><input id="caseCountryInput" value="${escapeHtml(state.customers[0]?.country || "")}"></div>
      <div class="form-field"><label>产品</label><input id="caseProductInput" placeholder="例如：18V 无刷电钻套装"></div>
      <div class="form-field"><label>行业</label><input id="caseIndustryInput" placeholder="例如：工具批发"></div>
      <div class="form-field full"><label>成果</label><input id="caseResultInput" placeholder="例如：拿下 $36,000 首单"></div>
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

async function publishSelectedCase() {
  const caseStudy = state.caseStudies.find((item) => item.id === state.selectedCaseId);
  if (!caseStudy || caseStudy.status === "published") return;
  const result = await api<{ caseStudy: CaseStudy }>(`/api/case-studies/${caseStudy.id}/publish`, { method: "PATCH" });
  Object.assign(caseStudy, result.caseStudy);
  renderCaseStudies(state.caseStudies);
  toast("成功案例已发布");
}

function renderJobs(jobs: ImportExportJob[]) {
  const tbody = qs<HTMLElement>("#imports tbody");
  if (!tbody) return;
  tbody.innerHTML = jobs.map((job) => `<tr><td>${escapeHtml(job.name)}</td><td>${job.type === "import" ? "导入" : "导出"}</td><td>${job.rows.toLocaleString("en-US")} 行</td><td>${badge(job.status === "done" ? "完成" : "待审批", job.status === "done" ? "green" : "amber")}</td><td>当前账号</td><td>${escapeHtml(job.createdAt)}</td></tr>`).join("");
}

async function createJob(type: "import" | "export") {
  const result = await api<{ job: ImportExportJob }>("/api/import-export/jobs", {
    method: "POST",
    body: JSON.stringify({
      name: type === "import" ? "手工导入客户" : "客户清单导出",
      type,
      rows: type === "import" ? 25 : state.customers.length
    })
  });
  state.jobs.unshift(result.job);
  renderJobs(state.jobs);
  toast(type === "import" ? "导入任务已创建" : "导出任务已提交审批");
}

function renderWecom(messages: WecomMessage[]) {
  const chat = qs<HTMLElement>("#wecom .chat");
  if (!chat) return;
  chat.innerHTML = messages.map((message, index) => `<div class="bubble ${index % 2 ? "me" : ""}">${escapeHtml(message.summary)} ${message.status === "archived" ? "已归档" : "待归档"}</div>`).join("");
}

async function syncWecomMessages() {
  const pending = state.wecomMessages.filter((message) => message.status !== "archived");
  for (const message of pending) {
    const result = await api<{ message: WecomMessage }>(`/api/wecom/messages/${message.id}/archive`, { method: "POST" });
    Object.assign(message, result.message);
  }
  renderWecom(state.wecomMessages);
  toast(pending.length ? `已同步 ${pending.length} 条企微摘要` : "企微摘要已是最新");
}

function renderKnowledge(assets: KnowledgeAsset[]) {
  const grid = qs<HTMLElement>("#knowledge .file-grid");
  if (!grid) return;
  grid.innerHTML = assets.map((asset) => `<div class="file-card" data-asset-id="${escapeHtml(asset.id)}"><div class="file-icon">${escapeHtml(assetIcon(asset.category))}</div><b>${escapeHtml(asset.title)}</b><span>${escapeHtml(asset.category)} · ${asset.status === "published" ? "已发布" : "待审核"} · ${escapeHtml(asset.version)}</span><button class="btn" data-publish-asset>${asset.status === "published" ? "已发布" : "发布"}</button></div>`).join("");
  const total = qsa<HTMLElement>("#knowledge .dense-card b");
  if (total[0]) total[0].textContent = String(assets.length);
  if (total[1]) total[1].textContent = String(assets.filter((item) => item.status !== "published").length);
  qsa<HTMLButtonElement>("[data-publish-asset]", grid).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void publishAsset(button.closest<HTMLElement>(".file-card")?.dataset.assetId || "");
    });
  });
}

async function publishAsset(id: string) {
  const asset = state.knowledgeAssets.find((item) => item.id === id);
  if (!asset || asset.status === "published") {
    toast("资料已经是发布状态");
    return;
  }
  try {
    const result = await api<{ asset: KnowledgeAsset }>(`/api/knowledge/assets/${id}/publish`, { method: "PATCH" });
    Object.assign(asset, result.asset);
    renderKnowledge(state.knowledgeAssets);
    toast("资料已发布");
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布失败", "error");
  }
}

function openKnowledgeModal() {
  openModal("上传资料", `
    <div class="form-grid">
      <div class="form-field full"><label>资料标题</label><input id="assetTitleInput" value="新品参数说明"></div>
      <div class="form-field"><label>资料类目</label><select id="assetCategoryInput"><option>产品知识</option><option>认证资料</option><option>报价规则</option><option>销售 SOP</option></select></div>
      <div class="form-field"><label>版本</label><input id="assetVersionInput" value="v1"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveAssetButton">上传资料</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveAssetButton")?.addEventListener("click", () => void saveAsset());
}

async function saveAsset() {
  const title = qs<HTMLInputElement>("#assetTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写资料标题", "error");
    return;
  }
  const result = await api<{ asset: KnowledgeAsset }>("/api/knowledge/assets", {
    method: "POST",
    body: JSON.stringify({
      title,
      category: qs<HTMLSelectElement>("#assetCategoryInput")?.value || "产品知识",
      version: qs<HTMLInputElement>("#assetVersionInput")?.value || "v1"
    })
  });
  state.knowledgeAssets.unshift(result.asset);
  renderKnowledge(state.knowledgeAssets);
  closeModal();
  toast("资料已上传");
}

function assetIcon(category: string) {
  if (category.includes("报价")) return "XLS";
  if (category.includes("认证")) return "DOC";
  return "PDF";
}

function renderExams(exams: Exam[]) {
  const list = qs<HTMLElement>("#exam .exam-sidebar .category-list");
  if (!list) return;
  list.innerHTML = exams.map((exam) => `<div class="category-item" data-exam-id="${escapeHtml(exam.id)}"><div><b>${escapeHtml(exam.title)}</b><span>${exam.questionCount} 题 · 通过率 ${exam.passRate}% · ${escapeHtml(exam.category)}</span></div><div style="display:flex; gap:6px; align-items:center">${badge(exam.status === "published" ? "发布" : exam.status === "draft" ? "草稿" : "排期", exam.status === "published" ? "green" : exam.status === "draft" ? "amber" : "")}<button class="btn" data-start-exam>考试</button><button class="btn" data-publish-exam>发布</button></div></div>`).join("");
  const cards = qsa<HTMLElement>("#exam .dense-card b");
  if (cards[0]) cards[0].textContent = String(exams.filter((item) => item.status !== "draft").length);
  if (cards[2]) cards[2].textContent = `${Math.round(exams.reduce((sum, item) => sum + item.passRate, 0) / Math.max(exams.length, 1))}%`;
  qsa<HTMLButtonElement>("[data-start-exam]", list).forEach((button) => {
    button.addEventListener("click", () => openExamModal(button.closest<HTMLElement>(".category-item")?.dataset.examId || ""));
  });
  qsa<HTMLButtonElement>("[data-publish-exam]", list).forEach((button) => {
    button.addEventListener("click", () => void publishExam(button.closest<HTMLElement>(".category-item")?.dataset.examId || ""));
  });
}

function openExamModal(id: string) {
  const exam = state.exams.find((item) => item.id === id) || state.exams[0];
  if (!exam) return;
  openModal(`${exam.title} · 在线考试`, `
    <div class="exam-paper">
      <div class="question-card"><h3>1. 客户要求 CE 证书时应优先提供什么？</h3><div class="option-row" data-question><span>A. 工厂营业执照</span><span data-correct="true">B. 对应产品型号的 CE 证书与测试报告</span><span>C. 宣传图</span></div></div>
      <div class="question-card"><h3>2. MOQ 变化需要同步更新哪些内容？</h3><div class="option-row" data-question><span>A. 仅备注</span><span data-correct="true">B. 单价、装箱、交期、付款条款影响</span><span>C. 客户国家</span></div></div>
      <div class="question-card"><h3>3. 样品寄出后何时触发反馈提醒？</h3><div class="option-row" data-question><span>A. 不提醒</span><span data-correct="true">B. 签收后 3 天</span><span>C. 30 天</span></div></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="submitExamButton">交卷</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qsa<HTMLElement>("#appModal [data-question] span").forEach((option) => {
    option.addEventListener("click", () => {
      qsa<HTMLElement>("span", option.parentElement!).forEach((item) => item.classList.remove("active"));
      option.classList.add("active");
    });
  });
  qs("#submitExamButton")?.addEventListener("click", () => void submitExam(exam.id));
}

async function submitExam(id: string) {
  const questions = qsa<HTMLElement>("#appModal [data-question]");
  const correct = questions.filter((question) => qs<HTMLElement>("span.active[data-correct='true']", question)).length;
  const score = Math.round((correct / Math.max(questions.length, 1)) * 100);
  const result = await api<{ attempt: { score: number; passed: boolean } }>(`/api/exams/${id}/submit`, {
    method: "POST",
    body: JSON.stringify({ score })
  });
  closeModal();
  toast(`交卷成功：${result.attempt.score} 分，${result.attempt.passed ? "已通过" : "需补考"}`);
}

async function publishExam(id: string) {
  const exam = state.exams.find((item) => item.id === id);
  if (!exam) return;
  try {
    const result = await api<{ exam: Exam }>(`/api/exams/${id}/publish`, { method: "PATCH" });
    Object.assign(exam, result.exam);
    renderExams(state.exams);
    toast("考试已发布");
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布失败", "error");
  }
}

function openExamCreateModal() {
  openModal("发布考试", `
    <div class="form-grid">
      <div class="form-field full"><label>考试名称</label><input id="examTitleInput" value="新品知识抽考"></div>
      <div class="form-field"><label>类目</label><select id="examCategoryInput"><option>产品知识</option><option>认证资料</option><option>报价规则</option></select></div>
      <div class="form-field"><label>题量</label><input id="examCountInput" type="number" value="20"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveExamButton">创建考试</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveExamButton")?.addEventListener("click", () => void saveExam());
}

async function saveExam() {
  const title = qs<HTMLInputElement>("#examTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写考试名称", "error");
    return;
  }
  const result = await api<{ exam: Exam }>("/api/exams", {
    method: "POST",
    body: JSON.stringify({
      title,
      category: qs<HTMLSelectElement>("#examCategoryInput")?.value || "产品知识",
      questionCount: Number(qs<HTMLInputElement>("#examCountInput")?.value || 20)
    })
  });
  state.exams.unshift(result.exam);
  renderExams(state.exams);
  closeModal();
  toast("考试已创建");
}

async function renderAccounts(user: User) {
  const tbody = qs<HTMLElement>("#settings tbody");
  if (!tbody) return;
  let accounts: User[] = [user];
  if (user.role !== "sales") {
    accounts = (await api<{ accounts: User[] }>("/api/accounts")).accounts;
  }
  state.accounts = accounts;
  tbody.innerHTML = accounts.map((account) => `<tr data-account-id="${escapeHtml(account.id)}"><td><div class="company"><span class="avatar">${escapeHtml(account.avatar)}</span><div><b>${escapeHtml(account.name)}</b><span>${escapeHtml(account.email)}</span></div></div></td><td>${badge(roleLabel[account.role], account.role === "admin" ? "amber" : account.role === "manager" ? "green" : "")}</td><td>${account.role === "sales" ? "仅本人数据" : account.role === "manager" ? "欧洲组全部" : "全量权限"}</td><td>${account.role === "admin" ? "全部" : account.role === "manager" ? "团队全部" : "本人客户"}</td><td>${badge((account as User & { status?: string }).status === "disabled" ? "停用" : "启用", (account as User & { status?: string }).status === "disabled" ? "gray" : "green")}</td><td><button class="btn" data-disable-account>${account.id === user.id ? "当前账号" : "停用"}</button></td></tr>`).join("");
  qsa<HTMLButtonElement>("[data-disable-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => void disableAccount(button.closest<HTMLElement>("tr")?.dataset.accountId || ""));
  });
}

function openAccountModal() {
  openModal("新增账号", `
    <div class="form-grid">
      <div class="form-field"><label>姓名</label><input id="accountNameInput" value="New Sales"></div>
      <div class="form-field"><label>角色</label><select id="accountRoleInput"><option value="sales">业务员</option><option value="manager">主管</option></select></div>
      <div class="form-field full"><label>邮箱</label><input id="accountEmailInput" value="new.sales.${Date.now()}@goodjob.com"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveAccountButton">保存账号</button>`);
  qs("#saveAccountButton")?.addEventListener("click", () => void saveAccount());
}

async function saveAccount() {
  const name = qs<HTMLInputElement>("#accountNameInput")?.value.trim() || "";
  const email = qs<HTMLInputElement>("#accountEmailInput")?.value.trim() || "";
  if (!name || !email) {
    toast("请填写账号姓名和邮箱", "error");
    return;
  }
  const result = await api<{ account: User }>("/api/accounts", {
    method: "POST",
    body: JSON.stringify({
      name,
      email,
      role: qs<HTMLSelectElement>("#accountRoleInput")?.value || "sales"
    })
  });
  state.accounts.unshift(result.account);
  await renderAccounts(state.user!);
  closeModal();
  toast("账号已新增");
}

async function disableAccount(id: string) {
  if (!id || id === state.user?.id) {
    toast("当前登录账号不能停用", "error");
    return;
  }
  await api(`/api/accounts/${id}/disable`, { method: "PATCH" });
  await renderAccounts(state.user!);
  toast("账号已停用");
}

function renderOcr(job: OcrJob) {
  const fields = job.fields;
  const mapping: Record<string, string> = {
    company: "公司名",
    contact: "联系人",
    title: "职位",
    email: "邮箱",
    whatsapp: "WhatsApp",
    wechat: "微信",
    phone: "电话",
    country: "国家",
    city: "城市"
  };
  const cards = qs<HTMLElement>("#tools .ocr-fields");
  if (!cards) return;
  cards.innerHTML = Object.entries(mapping).map(([key, label]) => `<div class="field-card"><input type="checkbox" checked data-ocr-field="${escapeHtml(key)}"><div><label>${label}</label><input type="text" value="${escapeHtml(fields[key])}"></div></div>`).join("") +
    `<div class="field-card"><input type="checkbox"><div><label>标签</label><input type="text" value="LED灯具 / 欧洲进口商"></div></div>`;
  const statusRows = qsa<HTMLElement>("#tools .sync-row");
  if (statusRows[0]) statusRows[0].innerHTML = `<span>识别状态</span><b>${job.status === "synced" ? "已同步" : "完成"}</b>${badge(`${job.confidence}% 置信度`, "green")}`;
  const cardTitle = qs<HTMLElement>("#tools .business-card h2");
  if (cardTitle) cardTitle.textContent = fields.company;
  const card = qs<HTMLElement>("#tools .business-card");
  if (card) {
    card.innerHTML = `<h2>${escapeHtml(fields.company)}</h2><p>Import & Distribution</p><strong>${escapeHtml(fields.contact)}</strong><span>${escapeHtml(fields.title)}</span><span>${escapeHtml(fields.email)}</span><span>WhatsApp ${escapeHtml(fields.whatsapp)}</span><span>WeChat ${escapeHtml(fields.wechat)}</span><span>${escapeHtml(fields.city)}, ${escapeHtml(fields.country)}</span>`;
  }
}

async function recognizeOcr(overrides: Partial<Record<string, string>> = {}) {
  const result = await api<{ job: OcrJob }>("/api/tools/ocr/jobs/ocr1/recognize", {
    method: "POST",
    body: JSON.stringify({ confidence: 96, ...overrides })
  });
  state.ocrJob = result.job;
  renderOcr(result.job);
  toast("名片已识别");
}

function collectOcrFields() {
  const fields: Record<string, string> = {};
  qsa<HTMLInputElement>("#tools .field-card input[data-ocr-field]").forEach((checkbox) => {
    if (!checkbox.checked) return;
    const key = checkbox.dataset.ocrField;
    const input = checkbox.parentElement?.querySelector<HTMLInputElement>("input[type='text']");
    if (key && input) fields[key] = input.value;
  });
  return fields;
}

function openTodoModal(prefill = "") {
  openModal("新增待办", `
    <div class="form-grid">
      <div class="form-field full"><label>待办内容</label><input id="todoTitleInput" value="${escapeHtml(prefill)}" placeholder="例如：明天 10 点跟进 Nordic Tools 报价"></div>
      <div class="form-field"><label>类型</label><select id="todoTypeInput"><option value="other" selected>其它</option><option value="customer">客户跟进</option><option value="knowledge">资料维护</option><option value="exam">在线考试</option><option value="ocr">OCR 线索</option></select></div>
      <div class="form-field"><label>优先级</label><select id="todoPriorityInput"><option value="normal">普通</option><option value="medium">中优先级</option><option value="high">高优先级</option></select></div>
      <div class="form-field"><label>目标完成时间</label><input id="todoDueInput" value="" placeholder="例如：2026-06-27 18:00"></div>
      <div class="form-field"><label>关联对象</label><input id="todoRelatedInput" value="" placeholder="可选：客户、商机、资料或考试名称"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveTodoButton">保存待办</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveTodoButton")?.addEventListener("click", () => void saveTodo());
  qs<HTMLInputElement>("#todoTitleInput")?.focus();
}

async function saveTodo() {
  const title = qs<HTMLInputElement>("#todoTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写待办内容", "error");
    return;
  }
  const result = await api<{ todo: Todo }>("/api/todos", {
    method: "POST",
    body: JSON.stringify({
      title,
      type: qs<HTMLSelectElement>("#todoTypeInput")?.value || "other",
      priority: qs<HTMLSelectElement>("#todoPriorityInput")?.value || "normal",
      dueAt: qs<HTMLInputElement>("#todoDueInput")?.value.trim() || "",
      related: qs<HTMLInputElement>("#todoRelatedInput")?.value.trim() || ""
    })
  });
  state.todos.unshift(result.todo);
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  closeModal();
  toast("待办已新增");
}

function openCustomerModal() {
  openModal("新增客户", `
    <div class="form-grid">
      <div class="form-field full"><label>公司名</label><input id="customerCompanyInput" placeholder="例如：天津马赫进出口有限公司"></div>
      <div class="form-field"><label>联系人</label><input id="customerContactInput" value="待维护"></div>
      <div class="form-field"><label>国家</label><input id="customerCountryInput" value="中国"></div>
      <div class="form-field"><label>阶段</label><select id="customerStageInput"><option>询盘</option><option>已联系</option><option>已报价</option><option>样品</option><option>谈判</option></select></div>
      <div class="form-field"><label>预计金额</label><input id="customerAmountInput" type="number" value="12000"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCustomerButton">保存客户</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveCustomerButton")?.addEventListener("click", () => void saveCustomer());
  qs<HTMLInputElement>("#customerCompanyInput")?.focus();
}

async function saveCustomer() {
  const company = qs<HTMLInputElement>("#customerCompanyInput")?.value.trim() || "";
  if (!company) {
    toast("请填写公司名", "error");
    return;
  }
  const result = await api<{ customer: Customer }>("/api/customers", {
    method: "POST",
    body: JSON.stringify({
      company,
      contact: qs<HTMLInputElement>("#customerContactInput")?.value || "待维护",
      country: qs<HTMLInputElement>("#customerCountryInput")?.value || "未知",
      stage: qs<HTMLSelectElement>("#customerStageInput")?.value || "询盘",
      amount: Number(qs<HTMLInputElement>("#customerAmountInput")?.value || 0)
    })
  });
  state.customers.unshift(result.customer);
  state.selectedCustomerId = result.customer.id;
  renderCustomers(state.customers);
  void refreshDashboardOnly();
  closeModal();
  toast("客户已新增");
}

function addFollowRecord(customer: Customer) {
  const timeline = qs<HTMLElement>("#customers .drawer .timeline");
  if (!timeline) return;
  timeline.insertAdjacentHTML("afterbegin", `<div class="timeline-item"><b>手动跟进</b><span>已新增 ${escapeHtml(customer.company)} 的电话/邮件跟进记录。</span></div>`);
  toast(`已记录 ${customer.company} 的跟进动作`);
}

async function syncOcrLead(button: HTMLButtonElement) {
  button.disabled = true;
  button.textContent = "同步中";
  try {
    await api("/api/tools/ocr/jobs/ocr1/recognize", {
      method: "POST",
      body: JSON.stringify(collectOcrFields())
    });
    await api("/api/tools/ocr/jobs/ocr1/sync-lead", { method: "POST" });
    button.textContent = "已同步";
    qsa<HTMLElement>("#tools .sync-row").at(2)!.innerHTML = `<span>目标模块</span><b>线索池 / 欧洲组</b>${badge("已同步", "green")}`;
    toast("OCR 线索已同步");
  } catch (error) {
    button.disabled = false;
    button.textContent = error instanceof Error ? error.message : "同步失败";
  }
}

async function exportReport() {
  const report = await api<{ title: string; forecastAmount: number; conversionRate: number; riskAmount: number; conclusions: string[] }>("/api/reports/executive");
  const content = [
    report.title,
    `预测成交额：${amount(report.forecastAmount)}`,
    `漏斗转化率：${report.conversionRate}%`,
    `高风险金额：${amount(report.riskAmount)}`,
    "",
    ...report.conclusions.map((item, index) => `${index + 1}. ${item}`)
  ].join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "GoodJob-CRM-经营汇报.txt";
  link.click();
  URL.revokeObjectURL(link.href);
  toast("汇报已生成下载");
}

function openReportNoteModal() {
  openModal("汇报备注", `<div class="form-field full"><label>备注</label><input id="reportNoteInput" value="${escapeHtml(state.reportNote || "本周重点抢救欧洲报价逾期客户")}"></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReportNoteButton">保存备注</button>`);
  qs("#saveReportNoteButton")?.addEventListener("click", saveReportNote);
}

function saveReportNote() {
  state.reportNote = qs<HTMLInputElement>("#reportNoteInput")?.value.trim() || "";
  const hero = qs<HTMLElement>("#reports .report-hero p");
  if (hero && state.reportNote) hero.textContent = state.reportNote;
  closeModal();
  toast("汇报备注已保存");
}

function installEvents() {
  ensureUiLayer();
  qs<HTMLButtonElement>("#loginButton")?.addEventListener("click", (event) => {
    event.stopImmediatePropagation();
    const role = (qs<HTMLSelectElement>("#loginRole")?.value || "sales") as Role;
    void loginByRole(role);
  }, true);
  qs<HTMLSelectElement>("#roleSwitcher")?.addEventListener("change", (event) => {
    event.stopImmediatePropagation();
    void loginByRole((event.currentTarget as HTMLSelectElement).value as Role);
  }, true);
  qs<HTMLButtonElement>("#logoutButton")?.addEventListener("click", () => {
    localStorage.removeItem(storage.token);
    localStorage.removeItem(storage.user);
    state.user = null;
    toast("已退出登录");
  });
  qsa<HTMLElement>(".todo-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.todoFilter = (chip.dataset.todoFilter || "today") as AppState["todoFilter"];
      renderTodos(state.todos);
      updateTodoChips(state.todos);
    });
  });
  qs<HTMLInputElement>(".quick-add input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = event.currentTarget as HTMLInputElement;
    openTodoModal(input.value.trim());
    input.value = "";
  });
  qsa<HTMLButtonElement>("#dashboard .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增待办")) button.addEventListener("click", () => openTodoModal());
    if (button.textContent?.includes("批量完成")) button.addEventListener("click", async () => {
      const pending = filterTodos(activeTodos(state.todos)).filter((todo) => !todo.done).slice(0, 5);
      await Promise.all(pending.map((todo) => api(`/api/todos/${todo.id}/complete`, { method: "POST" })));
      pending.forEach((todo) => { todo.done = true; });
      renderTodos(state.todos);
      updateTodoChips(state.todos);
      void refreshDashboardOnly();
      toast(`已完成 ${pending.length} 条待办`);
    });
  });
  qs<HTMLButtonElement>("#batchPriorityButton")?.addEventListener("click", (event) => void batchProcessPriorityTasks(event.currentTarget as HTMLButtonElement));
  qsa<HTMLButtonElement>("#customers .page-head .btn.primary, .top-actions .btn.primary").forEach((button) => {
    if (button.textContent?.includes("新增客户")) button.addEventListener("click", openCustomerModal);
  });
  qs<HTMLButtonElement>("#pipeline .page-head .btn.primary")?.addEventListener("click", openDealModal);
  qs<HTMLButtonElement>("#reminders .page-head .btn.primary")?.addEventListener("click", openReminderModal);
  qs<HTMLButtonElement>("#imports .page-head .btn.primary")?.addEventListener("click", () => void createJob("import"));
  qsa<HTMLButtonElement>("#reports .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("导出")) button.addEventListener("click", () => void exportReport());
    if (button.textContent?.includes("切换月份")) button.addEventListener("click", () => toast("已切换到 2026 年 6 月经营汇报"));
    if (button.textContent?.includes("汇报备注")) button.addEventListener("click", openReportNoteModal);
  });
  qsa<HTMLButtonElement>("#knowledge .page-head .btn, #knowledge .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("上传资料")) button.addEventListener("click", openKnowledgeModal);
    if (button.textContent?.includes("新建类目")) button.addEventListener("click", () => toast("资料类目已新增：新品资料"));
    if (button.textContent?.includes("批量发布")) button.addEventListener("click", async () => {
      const pending = state.knowledgeAssets.filter((asset) => asset.status !== "published");
      for (const asset of pending) await publishAsset(asset.id);
      if (!pending.length) toast("没有待发布资料");
    });
    if (button.textContent?.includes("调整排序")) button.addEventListener("click", () => toast("资料类目排序已保存"));
  });
  qsa<HTMLButtonElement>("#exam .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("发布考试")) button.addEventListener("click", openExamCreateModal);
    if (button.textContent?.includes("题库维护")) button.addEventListener("click", () => toast("题库已新增 1 道产品知识题"));
    if (button.textContent?.includes("分类目考试维护")) button.addEventListener("click", () => toast("分类目考试规则已保存"));
  });
  qs<HTMLButtonElement>("#wecom .page-head .btn.primary")?.addEventListener("click", () => void syncWecomMessages());
  qsa<HTMLButtonElement>(".top-actions .btn.ghost").forEach((button) => {
    if (button.textContent?.includes("导入")) button.addEventListener("click", () => activateNavView("imports", () => void createJob("import")));
    if (button.textContent?.includes("导出")) button.addEventListener("click", () => activateNavView("imports", () => void createJob("export")));
  });
  qsa<HTMLButtonElement>("#tools .page-head .btn, #tools .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("加载名片")) button.addEventListener("click", () => void recognizeOcr({ company: "Tianjin Mahe Trading Co., Ltd.", contact: "Ma He", email: "sales@tjmahe.com", country: "中国" }));
    if (button.textContent?.includes("重新识别")) button.addEventListener("click", () => void recognizeOcr());
    if (button.textContent?.includes("工具配置")) button.addEventListener("click", () => toast("OCR 字段映射配置已保存"));
  });
  qsa<HTMLButtonElement>("#tools .btn.primary").forEach((button) => {
    if (button.textContent?.includes("同步")) button.addEventListener("click", () => void syncOcrLead(button));
  });
  qsa<HTMLButtonElement>("#competitors .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增竞争公司")) button.addEventListener("click", openCompetitorModal);
    if (button.textContent?.includes("导出情报")) button.addEventListener("click", () => toast("竞争情报已加入导出任务"));
  });
  qs<HTMLButtonElement>("#competitorThreatButton")?.addEventListener("click", () => void toggleCompetitorThreat());
  qsa<HTMLButtonElement>("#cases .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增成功案例")) button.addEventListener("click", openCaseModal);
    if (button.textContent?.includes("导出案例集")) button.addEventListener("click", () => toast("成功案例集已加入导出任务"));
  });
  qs<HTMLButtonElement>("#casePublishButton")?.addEventListener("click", () => void publishSelectedCase());
  qsa<HTMLButtonElement>("#problems .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增问题")) button.addEventListener("click", openProblemModal);
    if (button.textContent?.includes("导出复盘")) button.addEventListener("click", () => toast("问题复盘已生成导出任务"));
  });
  qs<HTMLButtonElement>("#problemStatusButton")?.addEventListener("click", () => void advanceProblemStatus());
  qsa<HTMLButtonElement>("#memos .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增备忘")) button.addEventListener("click", openMemoModal);
    if (button.textContent?.includes("只看置顶")) button.addEventListener("click", () => {
      const pinned = state.memos.filter((memo) => memo.pinned && !memo.archived);
      renderMemos(pinned.length ? pinned : state.memos);
      toast(pinned.length ? `已筛出 ${pinned.length} 条置顶备忘` : "暂无置顶备忘");
    });
  });
  qs<HTMLButtonElement>("#memoPinButton")?.addEventListener("click", () => {
    const memo = state.memos.find((item) => item.id === state.selectedMemoId);
    if (memo) void patchSelectedMemo({ pinned: !memo.pinned });
  });
  qs<HTMLButtonElement>("#memoArchiveButton")?.addEventListener("click", () => {
    const memo = state.memos.find((item) => item.id === state.selectedMemoId);
    if (memo) void patchSelectedMemo({ archived: !memo.archived });
  });
  qs<HTMLButtonElement>("#memoDeleteButton")?.addEventListener("click", () => void deleteSelectedMemo());
  qsa<HTMLButtonElement>("#settings .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增账号")) button.addEventListener("click", openAccountModal);
    if (button.textContent?.includes("权限模板")) button.addEventListener("click", () => toast("权限模板已应用"));
    if (button.textContent?.includes("保存设置")) button.addEventListener("click", () => toast("账号与权限设置已保存"));
  });
}

function activateNavView(view: string, after?: () => void) {
  qsa<HTMLElement>(".nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  qsa<HTMLElement>(".view").forEach((node) => node.classList.toggle("active", node.id === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
  after?.();
}

async function restoreSession() {
  const rawUser = localStorage.getItem(storage.user);
  const token = localStorage.getItem(storage.token);
  if (!rawUser || !token) return;
  try {
    const { user } = await api<{ user: User }>("/api/auth/me");
    localStorage.setItem(storage.user, JSON.stringify(user));
    state.user = user;
    applyAuthedUser(user);
    document.body.classList.add("is-authenticated");
    await refreshAll(user);
  } catch {
    localStorage.removeItem(storage.token);
    localStorage.removeItem(storage.user);
  }
}

installEvents();
void restoreSession();
