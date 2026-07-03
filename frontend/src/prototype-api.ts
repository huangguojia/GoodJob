type Role = "sales" | "manager" | "admin" | "super_admin";

import * as XLSX from "xlsx";

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
  status?: string;
  pinState?: string;
  sortOrder?: number;
  dueAt: string;
  related: string;
  done: boolean;
  impactAmount?: number;
  createdAt?: string;
  historyAt?: string;
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
  ownerId: string;
  version: string;
}

interface Exam {
  id: string;
  title: string;
  category: string;
  status: string;
  passRate: number;
  questionCount: number;
  durationMinutes?: number;
  passScore?: number;
  targetRole?: "all" | "sales" | "manager";
  updatedAt?: string;
}

interface ExamQuestion {
  id: string;
  examId?: string;
  category: string;
  stem: string;
  options: string[];
  answerIndex: number;
  answerIndexes?: number[];
  questionType?: "single" | "multiple";
  tags?: string[];
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
}

interface ExamAttempt {
  id: string;
  examId: string;
  userId: string;
  score: number;
  passed: boolean;
  answers: Record<string, number | number[]>;
  correctCount: number;
  totalQuestions: number;
  submittedAt: string;
  examTitle?: string;
  category?: string;
  userName?: string;
}

interface ExamReport {
  totalAttempts: number;
  passedAttempts: number;
  retakeAttempts: number;
  averageScore: number;
  questionCount: number;
  categoryRows: Array<{ examId: string; title: string; category: string; participants: number; passRate: number; avgScore: number }>;
  difficultyRows: Array<{ difficulty: string; label: string; count: number; ratio: number }>;
  latestAttempts: ExamAttempt[];
}

interface ExamImportQuestion {
  stem: string;
  category: string;
  options: string[];
  answerIndex: number;
  answerIndexes: number[];
  questionType: "single" | "multiple";
  tags: string[];
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
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

interface WebsiteOpportunity {
  id: string;
  company: string;
  business: string;
  country: string;
  website: string;
  contact: string;
  contactInfo: string;
  description: string;
  status: string;
  createdAt: string;
  customerId?: string;
  dealId?: string;
  parseMode?: "rule" | "ai" | "fallback";
  selected?: boolean;
}

interface AiModelConfig {
  id: string;
  provider: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
  enabled: boolean;
  updatedAt: string;
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
  examQuestions: ExamQuestion[];
  examReport: ExamReport | null;
  ocrJob: OcrJob | null;
  websiteOpportunities: WebsiteOpportunity[];
  aiConfig: AiModelConfig | null;
  problems: ProblemItem[];
  memos: Memo[];
  competitors: Competitor[];
  caseStudies: CaseStudy[];
  accounts: User[];
  reportNote: string;
  dashboardPeriod: "today" | "week" | "month";
  morningView: boolean;
  todoFilter: "all" | "today" | "overdue" | "mine" | "customer" | "history";
  openTodoMenuId: string | null;
  draggingTodoId: string | null;
  selectedCustomerId: string | null;
  selectedProblemId: string | null;
  selectedMemoId: string | null;
  selectedCompetitorId: string | null;
  selectedCaseId: string | null;
  selectedExamId: string | null;
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
  examQuestions: [],
  examReport: null,
  ocrJob: null,
  websiteOpportunities: [],
  aiConfig: null,
  problems: [],
  memos: [],
  competitors: [],
  caseStudies: [],
  accounts: [],
  reportNote: "",
  dashboardPeriod: "today",
  morningView: false,
  todoFilter: "all",
  openTodoMenuId: null,
  draggingTodoId: null,
  selectedCustomerId: null,
  selectedProblemId: null,
  selectedMemoId: null,
  selectedCompetitorId: null,
  selectedCaseId: null,
  selectedExamId: null
};

let memoDirty = false;
let memoSaving = false;
let memoSavePromise: Promise<void> | null = null;

const roleLabel: Record<Role, string> = {
  sales: "业务员",
  manager: "销售主管",
  admin: "管理员",
  super_admin: "超级管理员"
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
  return Boolean(todo.historyAt);
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
      const leftOrder = typeof left.todo.sortOrder === "number" ? left.todo.sortOrder : 0;
      const rightOrder = typeof right.todo.sortOrder === "number" ? right.todo.sortOrder : 0;
      if (leftOrder || rightOrder) return leftOrder - rightOrder || todoCreatedTime(right.todo, right.index) - todoCreatedTime(left.todo, left.index);
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

const instrumentWeekTodos = [
  "第1天：整理仪表产品分类与参数卡",
  "第1天：建立仪表客户搜索关键词库10组",
  "第2天：整理公司证书与报价资料清单",
  "第2天：新增30家仪表目标客户到客户池",
  "第3天：完成客户角色-痛点-话术表",
  "第3天：首触达20家高匹配客户",
  "第4天：整理竞品替代切入点5条",
  "第4天：跟进昨日未回复客户10家",
  "第5天：制作参数确认表模板",
  "第5天：深挖3家A类客户并写入CRM",
  "第6天：完成第一周开发周报",
  "第7天：复盘并优化ICP规则"
];

const instrumentMemoTitle = "仪表外贸新客户开拓90天执行方案";

function instrumentPlanMemoContent() {
  return [
    "90天总目标：600+目标客户池，900+有效触达，60个有效回复，20个深度沟通，8个RFQ/样品/会议机会。",
    "",
    "每日最低动作：新增客户30家，首触达20家，二次跟进10家，深挖3家A类客户，CRM更新30条，15分钟复盘。",
    "",
    "前置知识：压力/温度/流量/液位/分析仪表/记录仪；量程、精度、介质、温压、连接方式、输出信号、供电、防护等级、材质；CE、RoHS、EMC、ATEX/IECEx、防爆、SIL、校准证书、ISO、材质报告。",
    "",
    "客户画像：工业自动化经销商、系统集成商、OEM设备厂、EPC/工程承包商、MRO维修服务商、终端工厂采购/工程师。",
    "",
    "周报结构：新增客户池、有效触达、有效回复、深度沟通、RFQ/样品/会议机会、问题与改进、下周计划。"
  ].join("\n");
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

async function loginWithPassword(email: string, password: string) {
  const result = await api<{ token: string; user: User }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
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
  document.body.dataset.role = user.role;
  qs("#scopeUser")!.textContent = profileName;
  qs("#scopeText")!.textContent = user.role === "sales" ? "仅本人业务与本人待办" : user.role === "manager" ? "团队业务数据，本人待办私有" : user.role === "admin" ? "全局业务数据、账号管理，本人待办私有" : "全局业务数据、最高账号权限，本人待办私有";
  qs("#currentAvatar")!.textContent = user.avatar;
  const topUserName = qs<HTMLElement>("#topUserName");
  const topUserRole = qs<HTMLElement>("#topUserRole");
  if (topUserName) topUserName.textContent = user.name;
  if (topUserRole) topUserRole.textContent = roleLabel[user.role];
}

async function refreshAll(user: User) {
  renderDashboardCache(user);
  const [summary, customers, todos, deals, reminders, jobs, wecom, knowledge, exams, ocr, websiteOps, aiConfig, problems, memos, competitors, caseStudies] = await Promise.all([
    api<DashboardSummary>("/api/dashboard/summary"),
    api<{ customers: Customer[] }>("/api/customers"),
    api<{ todos: Todo[] }>("/api/todos"),
    api<{ deals: Deal[] }>("/api/deals"),
    api<{ reminders: Reminder[] }>("/api/reminders"),
    api<{ jobs: ImportExportJob[] }>("/api/import-export/jobs"),
    api<{ messages: WecomMessage[] }>("/api/wecom/messages"),
    api<{ assets: KnowledgeAsset[] }>("/api/knowledge/assets"),
    api<{ exams: Exam[]; report: ExamReport }>("/api/exams"),
    api<{ job: OcrJob }>("/api/tools/ocr/jobs/ocr1"),
    api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-opportunities"),
    api<{ config: AiModelConfig | null }>("/api/tools/ai-config"),
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
  state.examReport = exams.report;
  state.ocrJob = ocr.job;
  state.websiteOpportunities = websiteOps.opportunities;
  state.aiConfig = aiConfig.config;
  state.problems = problems.problems;
  state.memos = memos.memos;
  state.competitors = competitors.competitors;
  state.caseStudies = caseStudies.caseStudies;
  state.selectedCustomerId = state.selectedCustomerId || customers.customers[0]?.id || null;
  state.selectedProblemId = state.selectedProblemId || problems.problems[0]?.id || null;
  state.selectedMemoId = state.selectedMemoId || memos.memos[0]?.id || null;
  state.selectedCompetitorId = state.selectedCompetitorId || competitors.competitors[0]?.id || null;
  state.selectedCaseId = state.selectedCaseId || caseStudies.caseStudies[0]?.id || null;
  state.selectedExamId = state.selectedExamId || exams.exams[0]?.id || null;
  writeDashboardCache(user, summary, todos.todos, customers.customers);
  renderDashboard(summary, todos.todos, customers.customers);
  renderCustomers(customers.customers);
  renderPipeline(deals.deals);
  renderReminders(reminders.reminders);
  renderJobs(jobs.jobs);
  renderWecom(wecom.messages);
  renderKnowledge(knowledge.assets);
  renderExams(exams.exams);
  renderDashboardKnowledgePanels(knowledge.assets, exams.exams);
  renderProblems(problems.problems);
  renderMemos(memos.memos);
  renderCompetitors(competitors.competitors);
  renderCaseStudies(caseStudies.caseStudies);
  await renderAccounts(user);
  renderOcr(ocr.job);
  renderAiConfig(state.aiConfig);
  renderWebsiteOpportunities(state.websiteOpportunities);
  renderTopbarStats();
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
  renderTopbarStats();
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
  renderTopbarStats();
}

function renderDashboard(summary: DashboardSummary, todos: Todo[], customers: Customer[], fromCache = false) {
  qs("#scopeText")!.textContent = summary.scope;
  const periodLabel = dashboardPeriodLabel();
  qs<HTMLElement>(".focus-top span:first-child")!.textContent = `${periodLabel}优先处理建议`;
  qs<HTMLElement>(".focus-top span:last-child")!.textContent = fromCache ? "缓存数据 · 后台刷新中" : `${formatTime(summary.updatedAt)} 已更新`;
  qs<HTMLElement>(".focus-title h2")!.textContent = dashboardPeriodTitle(summary);
  qs<HTMLElement>(".focus-title p")!.textContent = dashboardPeriodDescription(summary);
  const basis = qs<HTMLElement>("#briefingBasis");
  const action = qs<HTMLElement>("#briefingAction");
  const impact = qs<HTMLElement>("#briefingImpact");
  if (basis) basis.textContent = summary.briefing.basis;
  if (action) action.textContent = summary.briefing.action;
  if (impact) impact.textContent = summary.briefing.impact;
  const focusMetrics = qsa<HTMLElement>(".focus-metric");
  if (focusMetrics[0]) focusMetrics[0].innerHTML = `<span>高风险金额</span><b>${money(summary.briefing.riskAmount)}</b><small>${escapeHtml(summary.briefing.riskLabel)}</small>`;
  if (focusMetrics[1]) focusMetrics[1].innerHTML = `<span>待主管协同</span><b>${summary.metrics.overdueTodos} 项</b><small>高优先级待办</small>`;
  if (focusMetrics[2]) focusMetrics[2].innerHTML = `<span>${periodLabel}可成交</span><b>${summary.briefing.closableDeals} 单</b><small>预计 ${money(summary.briefing.closableAmount)}</small>`;
  if (focusMetrics[3]) focusMetrics[3].innerHTML = `<span>企微未读提醒</span><b>${summary.briefing.unreadWecom} 条</b><small>来自客户会话</small>`;
  const kpis = qsa<HTMLElement>("#dashboard .kpi strong");
  const multiplier = dashboardPeriodMultiplier();
  if (kpis[0]) kpis[0].textContent = String(Math.max(summary.metrics.todos, Math.round(summary.metrics.todos * multiplier)));
  if (kpis[1]) kpis[1].textContent = String(Math.max(summary.metrics.customers, Math.round(summary.metrics.customers * multiplier)));
  if (kpis[2]) kpis[2].textContent = money(Math.round(summary.metrics.forecastAmount * multiplier));
  if (kpis[3]) kpis[3].textContent = `${summary.metrics.wecomBoundRate}%`;
  const kpiNotes = qsa<HTMLElement>("#dashboard .kpi p");
  if (kpiNotes[0]) kpiNotes[0].innerHTML = badge(`${summary.metrics.overdueTodos} 个高优先级`, summary.metrics.overdueTodos ? "red" : "green");
  if (kpiNotes[1]) kpiNotes[1].textContent = `${periodLabel}客户视角 · 当前账号可见 ${summary.metrics.customers} 个`;
  if (kpiNotes[2]) kpiNotes[2].textContent = `${periodLabel}按可见商机金额汇总`;
  if (kpiNotes[3]) kpiNotes[3].textContent = `${customers.filter((customer) => !customer.wecomBound).length} 个客户待绑定`;
  renderSchedule(summary);
  renderPipelineHealth(summary);
  renderDashboardDense(summary);
  renderTodoInsights(summary);
  renderPriorityTasks(summary);
  renderTodos(todos);
  updateTodoChips(todos);
  renderDashboardPeriodControls();
  renderMorningPanel(summary);
}

function dashboardPeriodLabel() {
  if (state.dashboardPeriod === "week") return "本周";
  if (state.dashboardPeriod === "month") return "本月";
  return "今日";
}

function dashboardPeriodMultiplier() {
  if (state.dashboardPeriod === "week") return 2.4;
  if (state.dashboardPeriod === "month") return 5.8;
  return 1;
}

function dashboardPeriodTitle(summary: DashboardSummary) {
  if (state.dashboardPeriod === "week") return `本周重点推进 ${summary.briefing.closableDeals} 个可成交商机，同时压降 ${summary.metrics.overdueTodos} 个高优先级风险。`;
  if (state.dashboardPeriod === "month") return `本月核心目标是守住 ${money(Math.round(summary.metrics.forecastAmount * dashboardPeriodMultiplier()))} 预测成交额，并提升客户资料完整度。`;
  return summary.briefing.title;
}

function dashboardPeriodDescription(summary: DashboardSummary) {
  if (state.dashboardPeriod === "week") return "系统按本周跟进节奏、逾期风险、样品反馈和企微状态汇总，适合周计划和周复盘使用。";
  if (state.dashboardPeriod === "month") return "系统按本月客户新增、预测成交、培训资料和商机健康度汇总，适合月度目标跟踪。";
  return summary.briefing.description;
}

function renderDashboardPeriodControls() {
  qsa<HTMLButtonElement>("[data-dashboard-period]").forEach((button) => {
    button.classList.toggle("active", button.dataset.dashboardPeriod === state.dashboardPeriod);
  });
  const morningButton = qs<HTMLButtonElement>("#morningViewButton");
  if (morningButton) {
    morningButton.classList.toggle("primary", state.morningView);
    morningButton.textContent = state.morningView ? "退出晨会视图" : "晨会视图";
  }
  const scheduleTitle = qs<HTMLElement>("#dashboard .schedule-panel .section-title h2");
  const scheduleSub = qs<HTMLElement>("#dashboard .schedule-panel .section-title span:last-child");
  if (scheduleTitle) scheduleTitle.textContent = `${dashboardPeriodLabel()}节奏`;
  if (scheduleSub) scheduleSub.textContent = state.dashboardPeriod === "today" ? "按成交影响排序" : state.dashboardPeriod === "week" ? "按本周推进优先级排序" : "按月度经营目标排序";
  const todoLabel = qs<HTMLElement>("#dashboard .kpi label");
  if (todoLabel) todoLabel.textContent = `${dashboardPeriodLabel()}待跟进`;
}

function renderMorningPanel(summary: DashboardSummary) {
  const panel = qs<HTMLElement>("#morningPanel");
  panel?.classList.toggle("active", state.morningView);
  if (!panel) return;
  const periodLabel = dashboardPeriodLabel();
  const subtitle = qs<HTMLElement>("#morningSubtitle");
  const conclusion = qs<HTMLElement>("#morningConclusion");
  const risk = qs<HTMLElement>("#morningRisk");
  const collab = qs<HTMLElement>("#morningCollab");
  const action = qs<HTMLElement>("#morningAction");
  if (subtitle) subtitle.textContent = `${periodLabel}晨会同步：风险、成交、协同和下一步动作。`;
  if (conclusion) conclusion.textContent = state.dashboardPeriod === "today" ? "先抢救逾期报价" : state.dashboardPeriod === "week" ? "推进高概率商机" : "盯紧月度成交目标";
  if (risk) risk.textContent = money(summary.briefing.riskAmount);
  if (collab) collab.textContent = `${summary.metrics.overdueTodos} 项`;
  if (action) action.textContent = `${summary.priorityTasks.length || summary.metrics.todos} 条`;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatTodoTime(value = ""): string {
  const text = value.trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isFinite(date.getTime())) {
    const pad = (item: number) => String(item).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  const idTime = text.match(/^t_(\d{10,}).*/);
  if (idTime) {
    const stampDate = new Date(Number(idTime[1]));
    if (Number.isFinite(stampDate.getTime())) return formatTodoTime(stampDate.toISOString());
  }
  return text;
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

function renderDashboardKnowledgePanels(assets = state.knowledgeAssets, exams = state.exams) {
  const assetBody = qs<HTMLElement>("#dashboard-knowledge-panel tbody");
  if (assetBody) {
    assetBody.innerHTML = assets.length ? assets.slice(0, 4).map((asset) => {
      const statusText = asset.status === "published" ? "已发布" : asset.status === "review" ? "待审" : "草稿";
      const tone = asset.status === "published" ? "green" : asset.status === "review" ? "amber" : "";
      return `<tr><td>${escapeHtml(asset.title)}</td><td>${escapeHtml(asset.category)}</td><td>${badge(statusText, tone)}</td><td>${escapeHtml(ownerName(asset.ownerId))}</td></tr>`;
    }).join("") : `<tr><td colspan="4">暂无资料数据</td></tr>`;
  }

  const examBody = qs<HTMLElement>("#dashboard-exam-panel tbody");
  if (examBody) {
    examBody.innerHTML = exams.length ? exams.slice(0, 4).map((exam) => `<tr><td>${escapeHtml(exam.title)}</td><td>${exam.questionCount}</td><td>${exam.passRate}%</td></tr>`).join("") : `<tr><td colspan="3">暂无考试数据</td></tr>`;
  }

  const gapBody = qs<HTMLElement>("#dashboard-gap-panel tbody");
  if (!gapBody) return;
  const grouped = exams.reduce<Record<string, { total: number; count: number }>>((acc, exam) => {
    acc[exam.category] ||= { total: 0, count: 0 };
    acc[exam.category].total += exam.passRate;
    acc[exam.category].count += 1;
    return acc;
  }, {});
  const rows = Object.entries(grouped)
    .map(([category, item]) => ({ category, passRate: Math.round(item.total / Math.max(item.count, 1)) }))
    .sort((left, right) => left.passRate - right.passRate);
  gapBody.innerHTML = rows.length ? rows.slice(0, 4).map((row) => {
    const action = row.passRate < 70 ? "补考" : row.passRate < 85 ? "复训" : "达标";
    const tone = row.passRate < 70 ? "red" : row.passRate < 85 ? "amber" : "green";
    return `<tr><td>${escapeHtml(row.category)}</td><td>${row.passRate}%</td><td>${badge(action, tone)}</td></tr>`;
  }).join("") : `<tr><td colspan="3">暂无考试类目数据</td></tr>`;
}

function ownerName(ownerId: string) {
  const map: Record<string, string> = {
    u_sales_shirley: "Shirley",
    u_sales_mia: "Mia",
    u_manager_alex: "Alex",
    u_admin: "Admin",
    u_super_admin: "Super Admin"
  };
  return map[ownerId] || "当前账号";
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
  renderTopbarStats();
  const currentTodos = activeTodos(todos);
  const archivedTodos = historyTodos(todos);
  const isHistoryView = state.todoFilter === "history";
  const visibleTodos = isHistoryView ? archivedTodos : filterTodos(currentTodos);
  if (!visibleTodos.length) {
    list.innerHTML = `<div class="todo-history-empty">${isHistoryView ? "暂无隔天历史待办" : "暂无当前清单待办，使用上方快速新增开始安排。"}</div>`;
  } else {
    list.innerHTML = visibleTodos.map((todo) => {
    const tone = todo.priority === "high" ? "red" : todo.priority === "medium" ? "amber" : "green";
    const optionalMeta = [formatTodoTime(todo.dueAt), todo.related].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join("");
    const isRunning = todo.status === "in_progress" && !todo.done;
    const pinBadge = todo.pinState === "top" ? badge("置顶", "aqua") : todo.pinState === "bottom" ? badge("沉底", "gray") : "";
    const statusBadge = isHistoryView ? badge(todo.done ? "历史完成" : "历史归档", todo.done ? "green" : tone) : todo.done ? badge("已完成", "green") : isRunning ? badge("进行中", "aqua") : badge(todoTypeText(todo.type), tone);
    const runIcon = isRunning ? `<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>` : `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
    const menuOpen = state.openTodoMenuId === todo.id;
    return `<article class="todo-row ${todo.priority === "high" ? "urgent" : ""} ${isRunning ? "in-progress" : ""} ${todo.done ? "done" : ""} ${state.draggingTodoId === todo.id ? "dragging" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <i class="todo-check" title="${todo.done ? "撤回未完成" : "完成待办"}"></i>
      <div class="todo-main"><h3>${escapeHtml(todo.title)}</h3><div class="todo-meta"><i class="priority-dot" style="--color:var(--${tone === "red" ? "rose" : tone})"></i><span>${escapeHtml(priorityText(todo.priority))}</span>${optionalMeta}${pinBadge}${statusBadge}</div></div>
      <div class="todo-side"><div class="todo-actions"><div class="assignee-stack"><span class="mini-avatar">我</span></div>${isHistoryView ? `<button class="btn" data-todo-restore>回到今日</button>` : todo.done ? "" : `<button class="todo-run ${isRunning ? "active" : ""}" title="${isRunning ? "停止执行" : "开始执行"}" aria-label="${isRunning ? "停止执行" : "开始执行"}">${runIcon}</button>`}<button class="todo-more ${menuOpen ? "active" : ""}" title="更多操作" aria-label="更多操作"><span></span><span></span><span></span></button>${menuOpen ? `<div class="todo-menu">${isHistoryView ? "" : `<button data-todo-action="edit">编辑</button><button data-todo-action="top">置顶</button><button data-todo-action="bottom">沉底</button>`}<button class="danger" data-todo-action="delete">删除</button></div>` : ""}</div><div class="subtask-bar ${isRunning ? "running" : ""}"><i style="--p:${todo.done ? "100%" : isRunning ? "74%" : "55%"}"></i></div></div>
    </article>`;
    }).join("");
  }
  qsa<HTMLElement>(".todo-row [data-todo-restore]", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      if (row?.dataset.todoId) await restoreTodoFromHistory(row.dataset.todoId);
    });
  });
  qsa<HTMLElement>(".todo-row .todo-run", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      if (row?.dataset.todoId) await toggleTodoExecution(row.dataset.todoId);
    });
  });
  qsa<HTMLElement>(".todo-row .todo-more", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      state.openTodoMenuId = state.openTodoMenuId === row?.dataset.todoId ? null : row?.dataset.todoId || null;
      renderTodos(state.todos);
    });
  });
  qsa<HTMLElement>(".todo-row .todo-menu button", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      const action = node.dataset.todoAction;
      if (!row?.dataset.todoId || !action) return;
      state.openTodoMenuId = null;
      if (action === "edit") {
        const todo = state.todos.find((item) => item.id === row.dataset.todoId);
        if (todo) openTodoModal("", todo);
        return;
      }
      if (action === "delete") {
        await deleteTodo(row.dataset.todoId);
        return;
      }
      if (isHistoryView) return;
      await pinTodo(row.dataset.todoId, action as "top" | "bottom");
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
  bindTodoDrag(list, visibleTodos, isHistoryView);
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

function visibleTodoIds(todos: Todo[]) {
  return todos.map((todo) => todo.id);
}

async function persistTodoOrder(ids: string[], mode: "manual" | "top" | "bottom", targetId?: string) {
  const result = await api<{ todos: Todo[] }>("/api/todos/reorder", {
    method: "POST",
    body: JSON.stringify({ ids, mode, targetId })
  });
  result.todos.forEach((updated) => {
    const todo = state.todos.find((item) => item.id === updated.id);
    if (todo) Object.assign(todo, updated);
  });
  renderTodos(state.todos);
  updateTodoChips(state.todos);
}

async function pinTodo(id: string, mode: "top" | "bottom") {
  const current = filterTodos(activeTodos(state.todos));
  const sameGroup = current.filter((todo) => todo.done === state.todos.find((item) => item.id === id)?.done);
  const rest = sameGroup.filter((todo) => todo.id !== id).map((todo) => todo.id);
  const ids = mode === "top" ? [id, ...rest] : [...rest, id];
  await persistTodoOrder(ids, mode, id);
  toast(mode === "top" ? "已置顶" : "已沉底");
}

function bindTodoDrag(list: HTMLElement, visibleTodos: Todo[], isHistoryView: boolean) {
  if (isHistoryView) return;
  let holdTimer = 0;
  let dragId = "";
  let pointerId = 0;
  let lastDropId = "";
  const clearHold = () => {
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = 0;
  };
  const markDropTarget = (clientX: number, clientY: number) => {
    const targetRow = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".todo-row");
    if (!targetRow || targetRow.dataset.todoId === dragId || targetRow.closest("#dashboard .todo-list") !== list) return;
    lastDropId = targetRow.dataset.todoId || "";
    qsa<HTMLElement>(".todo-row.drop-target", list).forEach((item) => item.classList.remove("drop-target"));
    targetRow.classList.add("drop-target");
  };
  const documentMove = (event: PointerEvent) => {
    if (!dragId) return;
    markDropTarget(event.clientX, event.clientY);
  };
  const documentUp = (event: PointerEvent) => {
    void finishDrag(event.clientX, event.clientY);
  };
  const removeDocumentDragEvents = () => {
    document.removeEventListener("pointermove", documentMove);
    document.removeEventListener("pointerup", documentUp);
    document.removeEventListener("pointercancel", cancelDrag);
  };
  const finishDrag = async (clientX: number, clientY: number) => {
    clearHold();
    if (!dragId) return;
    removeDocumentDragEvents();
    const dropRow = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".todo-row");
    const dragged = visibleTodos.find((todo) => todo.id === dragId);
    const targetId = dropRow?.dataset.todoId && dropRow.closest("#dashboard .todo-list") === list ? dropRow.dataset.todoId : lastDropId;
    const target = visibleTodos.find((todo) => todo.id === targetId);
    const draggedId = dragId;
    dragId = "";
    lastDropId = "";
    state.draggingTodoId = null;
    qsa<HTMLElement>(".todo-row.dragging, .todo-row.drop-target", list).forEach((item) => item.classList.remove("dragging", "drop-target"));
    if (!dragged || !target || dragged.id === target.id || dragged.done !== target.done) {
      renderTodos(state.todos);
      return;
    }
    const group = visibleTodos.filter((todo) => todo.done === dragged.done);
    const ids = visibleTodoIds(group).filter((id) => id !== draggedId);
    ids.splice(ids.indexOf(target.id), 0, draggedId);
    await persistTodoOrder(ids, "manual", draggedId);
    toast("已按拖拽顺序保存");
  };
  const cancelDrag = () => {
    clearHold();
    removeDocumentDragEvents();
    dragId = "";
    lastDropId = "";
    state.draggingTodoId = null;
    renderTodos(state.todos);
  };
  qsa<HTMLElement>(".todo-row", list).forEach((row) => {
    row.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("button") || target.closest(".todo-check") || target.closest(".todo-menu")) return;
      const id = row.dataset.todoId;
      if (!id) return;
      pointerId = event.pointerId;
      holdTimer = window.setTimeout(() => {
        dragId = id;
        state.draggingTodoId = id;
        state.openTodoMenuId = null;
        row.classList.add("dragging");
        row.setPointerCapture(pointerId);
        document.addEventListener("pointermove", documentMove);
        document.addEventListener("pointerup", documentUp);
        document.addEventListener("pointercancel", cancelDrag);
        toast("拖动到目标位置后松手排序");
      }, 280);
    });
    row.addEventListener("pointermove", (event) => {
      if (!dragId || state.draggingTodoId !== dragId) return;
      markDropTarget(event.clientX, event.clientY);
    });
    row.addEventListener("pointerup", (event) => void finishDrag(event.clientX, event.clientY));
    row.addEventListener("pointercancel", cancelDrag);
    row.addEventListener("pointerleave", clearHold);
  });
  list.addEventListener("pointermove", (event) => {
    if (!dragId) return;
    markDropTarget(event.clientX, event.clientY);
  });
  list.addEventListener("pointerup", (event) => void finishDrag(event.clientX, event.clientY));
  list.addEventListener("pointercancel", cancelDrag);
}

async function toggleTodoExecution(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo || todo.done) return;
  const nextStatus = todo.status === "in_progress" ? "pending" : "in_progress";
  const result = await api<{ todo: Todo }>(`/api/todos/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: nextStatus })
  });
  Object.assign(todo, result.todo);
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  toast(nextStatus === "in_progress" ? "已开始执行" : "已停止执行");
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
    const meta = [formatTodoTime(todo.dueAt), todo.related, todo.historyAt ? `归档 ${formatTodoTime(todo.historyAt)}` : ""].filter(Boolean).join(" · ") || "未设置上下文";
    const menuOpen = state.openTodoMenuId === todo.id;
    return `<article class="todo-history-row ${todo.done ? "done" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <span class="history-dot ${tone}"></span>
      <div><b>${escapeHtml(todo.title)}</b><span>${escapeHtml(meta)}</span></div>
      <div class="todo-actions">${badge(todo.done ? "历史完成" : "历史归档", todo.done ? "green" : tone)}<button class="btn" data-todo-restore>回到今日</button><button class="todo-more ${menuOpen ? "active" : ""}" title="更多操作" aria-label="更多操作"><span></span><span></span><span></span></button>${menuOpen ? `<div class="todo-menu"><button class="danger" data-todo-action="delete">删除</button></div>` : ""}</div>
    </article>`;
  }).join("") : `<div class="todo-history-empty">暂无隔天历史待办</div>`;
  qsa<HTMLElement>(".todo-history-row [data-todo-restore]", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-history-row");
      if (row?.dataset.todoId) await restoreTodoFromHistory(row.dataset.todoId);
    });
  });
  qsa<HTMLElement>(".todo-history-row .todo-more", list).forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-history-row");
      state.openTodoMenuId = state.openTodoMenuId === row?.dataset.todoId ? null : row?.dataset.todoId || null;
      renderTodoHistory(todos);
    });
  });
  qsa<HTMLElement>(".todo-history-row .todo-menu button", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-history-row");
      state.openTodoMenuId = null;
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

async function restoreTodoFromHistory(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) {
    toast("待办不存在", "error");
    return;
  }
  const result = await api<{ todo: Todo }>(`/api/todos/${id}/restore`, { method: "POST" });
  Object.assign(todo, result.todo);
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  void refreshDashboardOnly();
  toast("已恢复到今日清单");
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
  renderTopbarStats();
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
      renderTopbarStats();
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
    renderDashboardKnowledgePanels();
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
  renderDashboardKnowledgePanels();
  closeModal();
  toast("资料已上传");
}

function assetIcon(category: string) {
  if (category.includes("报价")) return "XLS";
  if (category.includes("认证")) return "DOC";
  return "PDF";
}

function examStatusText(status: string) {
  if (status === "published") return "发布";
  if (status === "draft") return "草稿";
  return "排期";
}

function examStatusTone(status: string) {
  if (status === "published") return "green";
  if (status === "draft") return "amber";
  return "";
}

function examTargetText(targetRole?: string) {
  if (targetRole === "manager") return "主管必考";
  if (targetRole === "all") return "全员必考";
  return "销售必考";
}

function difficultyTone(difficulty: string) {
  if (difficulty === "hard") return "red";
  if (difficulty === "easy") return "green";
  return "amber";
}

function correctIndexesForQuestion(question: ExamQuestion) {
  return [...new Set(question.answerIndexes?.length ? question.answerIndexes : [question.answerIndex])].sort((left, right) => left - right);
}

function questionTypeText(question: ExamQuestion) {
  return question.questionType === "multiple" || correctIndexesForQuestion(question).length > 1 ? "多选" : "单选";
}

function renderExams(exams: Exam[]) {
  const list = qs<HTMLElement>("#exam .exam-sidebar .category-list");
  if (!list) return;
  const report = state.examReport;
  const activeExam = exams.find((item) => item.id === state.selectedExamId) || exams[0];
  state.selectedExamId = activeExam?.id || null;
  list.innerHTML = exams.length ? exams.map((exam) => `
    <div class="category-item ${exam.id === state.selectedExamId ? "selected" : ""}" data-exam-id="${escapeHtml(exam.id)}">
      <div><b>${escapeHtml(exam.title)}</b><span>${exam.questionCount} 题 · ${exam.passScore || 80} 分及格 · ${escapeHtml(exam.category)} · ${examTargetText(exam.targetRole)}</span></div>
      <div class="exam-actions">${badge(examStatusText(exam.status), examStatusTone(exam.status))}<button class="btn" data-start-exam>考试</button><button class="btn" data-question-bank>题库</button><button class="btn" data-publish-exam>发布</button></div>
    </div>`).join("") : `<div class="empty-state"><b>暂无考试</b><span>点击发布考试或分类目考试维护创建第一套题。</span></div>`;
  const cards = qsa<HTMLElement>("#exam .dense-card");
  const values = [
    { label: "进行中考试", value: String(exams.filter((item) => item.status !== "draft").length), note: `${exams.filter((item) => item.status === "published").length} 场已发布` },
    { label: "题库总量", value: String(report?.questionCount || exams.reduce((sum, item) => sum + item.questionCount, 0)), note: "来自真实题库" },
    { label: "平均通过率", value: `${Math.round(exams.reduce((sum, item) => sum + item.passRate, 0) / Math.max(exams.length, 1))}%`, note: `均分 ${report?.averageScore || 0}` },
    { label: "需补考人数", value: String(report?.retakeAttempts || 0), note: "按未通过记录" }
  ];
  cards.forEach((card, index) => {
    const item = values[index];
    if (item) card.innerHTML = `<span>${item.label}</span><b>${item.value}</b><small>${item.note}</small>`;
  });
  renderExamPreview(activeExam);
  renderExamReport();
  qsa<HTMLElement>(".category-item", list).forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedExamId = row.dataset.examId || null;
      renderExams(state.exams);
    });
  });
  qsa<HTMLButtonElement>("[data-start-exam]", list).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void openExamModal(button.closest<HTMLElement>(".category-item")?.dataset.examId || "");
    });
  });
  qsa<HTMLButtonElement>("[data-question-bank]", list).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openQuestionBankModal(button.closest<HTMLElement>(".category-item")?.dataset.examId || "");
    });
  });
  qsa<HTMLButtonElement>("[data-publish-exam]", list).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void publishExam(button.closest<HTMLElement>(".category-item")?.dataset.examId || "");
    });
  });
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
      </div>`).join("") : `<div class="empty-state"><b>题库为空</b><span>点击题库维护添加产品知识题。</span></div>`;
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

async function openExamModal(id: string) {
  const exam = state.exams.find((item) => item.id === id) || state.exams[0];
  if (!exam) return;
  const detail = await api<{ exam: Exam; questions: ExamQuestion[]; latestAttempt: ExamAttempt | null; report: ExamReport }>(`/api/exams/${exam.id}/detail`);
  state.examReport = detail.report;
  openModal(`${detail.exam.title} · 在线考试`, `
    <div class="exam-modal-summary">
      <span>${escapeHtml(detail.exam.category)}</span><span>${detail.exam.questionCount} 题</span><span>${detail.exam.durationMinutes || 20} 分钟</span><span>${detail.exam.passScore || 80} 分及格</span>
    </div>
    <div class="exam-paper exam-paper-live">
      ${detail.questions.map((question, index) => `
        <div class="question-card" data-question="${escapeHtml(question.id)}">
          <div class="question-meta"><span>${escapeHtml(question.category)} · ${questionTypeText(question)}</span>${badge(question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用", difficultyTone(question.difficulty))}</div>
          <h3>${index + 1}. ${escapeHtml(question.stem)}</h3>
          <div class="option-row" data-question-type="${question.questionType || (correctIndexesForQuestion(question).length > 1 ? "multiple" : "single")}">${question.options.map((option, optionIndex) => `<span data-option-index="${optionIndex}" ${correctIndexesForQuestion(question).includes(optionIndex) ? "data-correct=\"true\"" : ""}>${String.fromCharCode(65 + optionIndex)}. ${escapeHtml(option)}</span>`).join("")}</div>
          <small class="question-explain">解析：${escapeHtml(question.explanation)}</small>
        </div>`).join("")}
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="submitExamButton">交卷判分</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qsa<HTMLElement>("#appModal [data-question] .option-row span").forEach((option) => {
    option.addEventListener("click", () => {
      const row = option.parentElement!;
      if ((row as HTMLElement).dataset.questionType === "multiple") {
        option.classList.toggle("active");
        return;
      }
      qsa<HTMLElement>("span", row).forEach((item) => item.classList.remove("active"));
      option.classList.add("active");
    });
  });
  qs("#submitExamButton")?.addEventListener("click", () => void submitExam(exam.id));
}

async function submitExam(id: string) {
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

async function publishExam(id: string) {
  const exam = state.exams.find((item) => item.id === id);
  if (!exam) return;
  if (exam.status === "published" && !window.confirm("该考试已经发布，是否重新发布并刷新状态？")) return;
  if (exam.status !== "published" && !window.confirm(`确认发布「${exam.title}」？发布后销售即可参加考试。`)) return;
  const publishButton = qs<HTMLButtonElement>(`#exam [data-exam-id="${CSS.escape(id)}"] [data-publish-exam]`);
  try {
    if (publishButton) {
      publishButton.disabled = true;
      publishButton.textContent = "发布中";
    }
    const result = await api<{ exam: Exam; report: ExamReport }>(`/api/exams/${id}/publish`, { method: "PATCH" });
    Object.assign(exam, result.exam);
    state.examReport = result.report;
    renderExams(state.exams);
    renderDashboardKnowledgePanels();
    toast("考试已发布");
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布失败", "error");
  } finally {
    if (publishButton) {
      publishButton.disabled = false;
      publishButton.textContent = "发布";
    }
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
    </label>`).join("") : `<div class="empty-state"><b>当前筛选下没有题目</b><span>请先在基础题库维护中新增或导入题目。</span></div>`;
  qsa<HTMLInputElement>("input[data-question-id]", picker).forEach((input) => input.addEventListener("change", updateExamCreateSelectionSummary));
  updateExamCreateSelectionSummary();
}

async function ensureExamQuestionsLoaded() {
  const result = await api<{ questions: ExamQuestion[]; report: ExamReport }>("/api/exam-questions");
  state.examQuestions = result.questions;
  state.examReport = result.report;
  return result.questions;
}

async function openExamCreateModal(category = "产品知识") {
  await ensureExamQuestionsLoaded();
  const categories = Array.from(new Set([...state.examQuestions.map((question) => question.category), category, "产品知识", "认证资料", "报价规则", "仪表产品"]));
  openModal("发布考试 · 勾选题目组卷", `
    <div class="form-grid exam-create-grid">
      <div class="form-field full"><label>考试名称</label><input id="examTitleInput" value="${escapeHtml(category)}新品知识抽考"></div>
      <div class="form-field"><label>类目</label><select id="examCategoryInput">${categories.map((item) => `<option ${item === category ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></div>
      <div class="form-field"><label>考试时长</label><input id="examDurationInput" type="number" value="20" min="5" max="180"></div>
      <div class="form-field"><label>及格分</label><input id="examPassInput" type="number" value="80" min="1" max="100"></div>
      <div class="form-field"><label>适用对象</label><select id="examRoleInput"><option value="sales">销售必考</option><option value="manager">主管必考</option><option value="all">全员必考</option></select></div>
      <div class="form-field full"><label>从基础题库勾选试题</label><div class="exam-bank-toolbar"><span id="examCreateSelectionSummary">已选 0 题</span><button class="btn" type="button" id="selectCategoryQuestionsButton">选中当前类目</button></div><div class="exam-bank-list" id="examQuestionPicker"></div></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveExamButton">创建考试</button>`);
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
        targetRole: qs<HTMLSelectElement>("#examRoleInput")?.value || "sales"
      })
    });
    state.exams.unshift(result.exam);
    state.selectedExamId = result.exam.id;
    state.examReport = result.report;
    await refreshExamData();
    closeModal();
    toast(`考试已创建，已组卷 ${result.questions.length} 道题`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "创建考试失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "创建考试";
    }
  }
}

function renderQuestionBankRows(questions: ExamQuestion[]) {
  const list = qs<HTMLElement>("#questionBankList");
  if (!list) return;
  const category = qs<HTMLSelectElement>("#questionBankCategoryFilter")?.value || "";
  const type = qs<HTMLSelectElement>("#questionBankTypeFilter")?.value || "";
  const keyword = qs<HTMLInputElement>("#questionBankSearchInput")?.value.trim() || "";
  const filtered = questions.filter((question) => {
    const matchesCategory = !category || question.category === category;
    const matchesType = !type || (question.questionType || (correctIndexesForQuestion(question).length > 1 ? "multiple" : "single")) === type;
    const haystack = `${question.stem} ${question.category} ${questionTagsText(question)}`;
    return matchesCategory && matchesType && (!keyword || haystack.includes(keyword));
  });
  list.innerHTML = filtered.length ? filtered.map((question, index) => `
    <article class="question-card exam-bank-card" data-bank-question="${escapeHtml(question.id)}">
      <div class="question-meta"><span>#${index + 1} · ${escapeHtml(question.category)} · ${questionTypeText(question)}</span><span>${escapeHtml(questionTagsText(question))}</span></div>
      <h3>${escapeHtml(question.stem)}</h3>
      <div class="option-row">${question.options.map((option, optionIndex) => `<span class="${correctIndexesForQuestion(question).includes(optionIndex) ? "active" : ""}">${String.fromCharCode(65 + optionIndex)}. ${escapeHtml(option)}</span>`).join("")}</div>
      <small class="question-explain">解析：${escapeHtml(question.explanation)}</small>
      <div class="exam-bank-card-actions">${badge(question.difficulty === "hard" ? "高阶" : question.difficulty === "easy" ? "基础" : "应用", difficultyTone(question.difficulty))}<button class="btn danger" data-delete-bank-question>删除</button></div>
    </article>`).join("") : `<div class="empty-state"><b>暂无匹配题目</b><span>可以调整筛选条件，或新增/导入题目。</span></div>`;
  qsa<HTMLButtonElement>("[data-delete-bank-question]", list).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = button.closest<HTMLElement>("[data-bank-question]")?.dataset.bankQuestion || "";
      void deleteBankQuestion(id);
    });
  });
}

async function openQuestionBankModal(id = "") {
  await ensureExamQuestionsLoaded();
  const exam = state.exams.find((item) => item.id === id);
  const categories = Array.from(new Set([...state.examQuestions.map((question) => question.category), "产品知识", "认证资料", "报价规则", "仪表产品"]));
  openModal("基础题库维护", `
    <div class="exam-bank-layout">
      <aside class="exam-bank-editor">
        <div class="form-grid">
          <div class="form-field full"><label>题干</label><textarea id="questionStemInput" rows="3">客户询问仪表量程时，销售应优先确认哪些参数？</textarea></div>
          <div class="form-field"><label>类目</label><select id="questionCategoryInput">${categories.map((category) => `<option ${category === (exam?.category || "产品知识") ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}</select></div>
          <div class="form-field"><label>题型</label><select id="questionTypeInput"><option value="single">单选题</option><option value="multiple">多选题</option></select></div>
          <div class="form-field full"><label>选项 A</label><input class="question-option-input" value="量程、精度、接口、工况"></div>
          <div class="form-field full"><label>选项 B</label><input class="question-option-input" value="客户公司规模"></div>
          <div class="form-field full"><label>选项 C</label><input class="question-option-input" value="包装颜色"></div>
          <div class="form-field full"><label>选项 D</label><input class="question-option-input" value="输出信号、供电和防护等级"></div>
          <div class="form-field"><label>正确答案</label><input id="questionAnswerInput" value="A"><small>多选填 A,D 或 1,4</small></div>
          <div class="form-field"><label>难度</label><select id="questionDifficultyInput"><option value="easy">基础</option><option value="medium" selected>应用</option><option value="hard">高阶</option></select></div>
          <div class="form-field full"><label>标签</label><input id="questionTagsInput" value="仪表,技术参数"><small>用逗号分隔，如：仪表,报价,认证</small></div>
          <div class="form-field full"><label>解析</label><textarea id="questionExplainInput" rows="3">仪表类产品报价必须先确认量程、精度、接口和实际工况，避免型号匹配错误。</textarea></div>
          <div class="form-field full"><label>Excel / CSV 批量导入题库</label><input id="questionImportInput" type="file" accept=".xlsx,.xls,.csv"><small>表头支持：题干、类目、选项A-F、正确答案、题型、标签、解析、难度。</small></div>
        </div>
      </aside>
      <section class="exam-bank-browser">
        <div class="exam-bank-toolbar">
          <select id="questionBankCategoryFilter"><option value="">全部类目</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}</select>
          <select id="questionBankTypeFilter"><option value="">全部题型</option><option value="single">单选</option><option value="multiple">多选</option></select>
          <input id="questionBankSearchInput" placeholder="搜索题干 / 标签">
        </div>
        <div class="exam-bank-list" id="questionBankList"></div>
      </section>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn" id="exportQuestionButton">导出题库</button><button class="btn" id="importQuestionButton">导入题库</button><button class="btn primary" id="saveQuestionButton">保存题目</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  renderQuestionBankRows(state.examQuestions);
  ["#questionBankCategoryFilter", "#questionBankTypeFilter", "#questionBankSearchInput"].forEach((selector) => qs<HTMLElement>(selector)?.addEventListener("input", () => renderQuestionBankRows(state.examQuestions)));
  qs("#saveQuestionButton")?.addEventListener("click", (event) => void saveQuestion(event.currentTarget as HTMLButtonElement));
  qs("#importQuestionButton")?.addEventListener("click", (event) => void importQuestionBank(event.currentTarget as HTMLButtonElement));
  qs("#exportQuestionButton")?.addEventListener("click", () => void exportQuestionBank());
}

function parseTags(value: string) {
  return value.split(/[，,、\s]+/).map((item) => item.trim()).filter(Boolean);
}

async function saveQuestion(button?: HTMLButtonElement) {
  const stem = qs<HTMLTextAreaElement>("#questionStemInput")?.value.trim() || qs<HTMLInputElement>("#questionStemInput")?.value.trim() || "";
  const options = qsa<HTMLInputElement>(".question-option-input").map((input) => input.value.trim()).filter(Boolean);
  const answerIndexes = normalizeAnswerIndexes(qs<HTMLInputElement>("#questionAnswerInput")?.value || "A");
  const questionType = qs<HTMLSelectElement>("#questionTypeInput")?.value === "multiple" || answerIndexes.length > 1 ? "multiple" : "single";
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
    const result = await api<{ question: ExamQuestion; report: ExamReport }>("/api/exam-questions", {
      method: "POST",
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
    state.examQuestions.unshift(result.question);
    state.examReport = result.report;
    renderQuestionBankRows(state.examQuestions);
    renderExams(state.exams);
    toast("题目已加入基础题库");
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

function rowValue(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim()) return row[key];
  }
  return "";
}

async function parseQuestionFile(file: File): Promise<ExamImportQuestion[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  return rows.map((row) => {
    const options = [
      rowValue(row, ["选项A", "选项 A", "A", "optionA", "Option A"]),
      rowValue(row, ["选项B", "选项 B", "B", "optionB", "Option B"]),
      rowValue(row, ["选项C", "选项 C", "C", "optionC", "Option C"]),
      rowValue(row, ["选项D", "选项 D", "D", "optionD", "Option D"]),
      rowValue(row, ["选项E", "选项 E", "E", "optionE", "Option E"]),
      rowValue(row, ["选项F", "选项 F", "F", "optionF", "Option F"])
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

async function importQuestionBank(button?: HTMLButtonElement) {
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
      button.textContent = "导入题库";
    }
  }
}

async function exportQuestionBank() {
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
      选项E: question.options[4] || "",
      选项F: question.options[5] || "",
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

async function deleteBankQuestion(id: string) {
  if (!id) return;
  if (!window.confirm("确认删除这道题？相关考试中的引用也会同步移除。")) return;
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

function openExamCategoryModal() {
  const categories = Array.from(new Set([...state.exams.map((exam) => exam.category), "仪表产品", "认证资料", "报价规则"]));
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
  const result = await api<{ exams: Exam[]; report: ExamReport }>("/api/exams");
  state.exams = result.exams;
  state.examReport = result.report;
  state.selectedExamId = state.selectedExamId || result.exams[0]?.id || null;
  renderExams(state.exams);
  renderDashboardKnowledgePanels();
}

async function renderAccounts(user: User) {
  const tbody = qs<HTMLElement>("#settings tbody");
  if (!tbody) return;
  const canManage = user.role === "admin" || user.role === "super_admin";
  const addButton = qsa<HTMLButtonElement>("#settings .page-head .btn").find((button) => button.textContent?.includes("新增账号"));
  if (addButton) {
    addButton.disabled = !canManage;
    addButton.title = canManage ? "新增系统账号" : "只有管理员和超级管理员可以管理账号";
  }
  if (!canManage) {
    state.accounts = [user];
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>账号管理仅管理员可用</b><span>当前账号可查看授权范围说明；账号新增、停用和角色调整由管理员或超级管理员处理。</span></div></td></tr>`;
    return;
  }
  const accounts = (await api<{ accounts: User[] }>("/api/accounts")).accounts;
  state.accounts = accounts;
  tbody.innerHTML = accounts.map((account) => {
    const status = (account as User & { status?: string }).status === "disabled" ? "停用" : "启用";
    const disableAllowed = account.id !== user.id && (user.role === "super_admin" || account.role !== "super_admin");
    return `<tr data-account-id="${escapeHtml(account.id)}"><td><div class="company"><span class="avatar">${escapeHtml(account.avatar)}</span><div><b>${escapeHtml(account.name)}</b><span>${escapeHtml(account.email)}</span></div></div></td><td>${badge(roleLabel[account.role], account.role === "super_admin" ? "red" : account.role === "admin" ? "amber" : account.role === "manager" ? "green" : "")}</td><td>${accountBusinessScope(account.role)}</td><td>${accountPersonalScope(account.role)}</td><td>${badge(status, status === "停用" ? "gray" : "green")}</td><td><div class="inline-actions"><button class="btn" data-password-account ${canManageRoleInUi(account) ? "" : "disabled"}>设密码</button><button class="btn" data-disable-account ${disableAllowed ? "" : "disabled"}>${account.id === user.id ? "当前账号" : disableAllowed ? "停用" : "受保护"}</button><button class="btn danger" data-delete-account ${disableAllowed ? "" : "disabled"}>删除</button></div></td></tr>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-password-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => openPasswordModal(button.closest<HTMLElement>("tr")?.dataset.accountId || ""));
  });
  qsa<HTMLButtonElement>("[data-disable-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => void disableAccount(button.closest<HTMLElement>("tr")?.dataset.accountId || ""));
  });
  qsa<HTMLButtonElement>("[data-delete-account]", tbody).forEach((button) => {
    button.addEventListener("click", () => void deleteAccount(button.closest<HTMLElement>("tr")?.dataset.accountId || ""));
  });
}

function canManageRoleInUi(account: User) {
  return state.user?.role === "super_admin" || account.role !== "super_admin";
}

function accountBusinessScope(role: Role) {
  if (role === "sales") return "本人业务数据";
  if (role === "manager") return "本团队业务数据";
  if (role === "admin") return "全局业务数据";
  return "全局业务数据 + 最高权限";
}

function accountPersonalScope(_role: Role) {
  return "待办/备忘仅本人";
}

function openAccountModal() {
  if (!state.user || (state.user.role !== "admin" && state.user.role !== "super_admin")) {
    toast("只有管理员和超级管理员可以新增账号", "error");
    return;
  }
  const roleOptions = [
    `<option value="sales">业务员</option>`,
    `<option value="manager">销售主管</option>`,
    `<option value="admin">管理员</option>`,
    state.user.role === "super_admin" ? `<option value="super_admin">超级管理员</option>` : ""
  ].join("");
  openModal("新增账号", `
    <div class="form-grid">
      <div class="form-field"><label>姓名</label><input id="accountNameInput" value="New Sales"></div>
      <div class="form-field"><label>角色</label><select id="accountRoleInput">${roleOptions}</select></div>
      <div class="form-field full"><label>邮箱</label><input id="accountEmailInput" value="new.sales.${Date.now()}@goodjob.com"></div>
      <div class="form-field full"><label>初始密码</label><input id="accountPasswordInput" type="password" value="goodjob123" autocomplete="new-password"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveAccountButton">保存账号</button>`);
  qs("#saveAccountButton")?.addEventListener("click", () => void saveAccount());
}

async function saveAccount() {
  if (!state.user || (state.user.role !== "admin" && state.user.role !== "super_admin")) {
    toast("无账号管理权限", "error");
    return;
  }
  const name = qs<HTMLInputElement>("#accountNameInput")?.value.trim() || "";
  const email = qs<HTMLInputElement>("#accountEmailInput")?.value.trim() || "";
  const password = qs<HTMLInputElement>("#accountPasswordInput")?.value || "";
  if (!name || !email || password.length < 6) {
    toast("请填写账号姓名、邮箱和至少 6 位密码", "error");
    return;
  }
  const result = await api<{ account: User }>("/api/accounts", {
    method: "POST",
    body: JSON.stringify({
      name,
      email,
      password,
      role: qs<HTMLSelectElement>("#accountRoleInput")?.value || "sales"
    })
  });
  state.accounts.unshift(result.account);
  await renderAccounts(state.user!);
  closeModal();
  toast("账号已新增");
}

function openPasswordModal(id: string) {
  const account = state.accounts.find((item) => item.id === id);
  if (!account) {
    toast("账号不存在", "error");
    return;
  }
  if (!canManageRoleInUi(account)) {
    toast("无权设置该账号密码", "error");
    return;
  }
  openModal("设置账号密码", `
    <div class="form-grid">
      <div class="form-field full"><label>账号</label><input value="${escapeHtml(account.email)}" disabled></div>
      <div class="form-field full"><label>新密码</label><input id="accountNewPasswordInput" type="password" value="" autocomplete="new-password" placeholder="至少 6 位"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="savePasswordButton">保存密码</button>`);
  qs("#savePasswordButton")?.addEventListener("click", () => void saveAccountPassword(id));
}

async function saveAccountPassword(id: string) {
  const password = qs<HTMLInputElement>("#accountNewPasswordInput")?.value || "";
  if (password.length < 6) {
    toast("密码至少 6 位", "error");
    return;
  }
  await api(`/api/accounts/${id}/password`, {
    method: "PATCH",
    body: JSON.stringify({ password })
  });
  closeModal();
  toast("密码已更新");
}

async function disableAccount(id: string) {
  if (!id || id === state.user?.id) {
    toast("当前登录账号不能停用", "error");
    return;
  }
  const account = state.accounts.find((item) => item.id === id);
  if (state.user?.role === "admin" && account?.role === "super_admin") {
    toast("管理员不能停用超级管理员", "error");
    return;
  }
  await api(`/api/accounts/${id}/disable`, { method: "PATCH" });
  await renderAccounts(state.user!);
  toast("账号已停用");
}

async function deleteAccount(id: string) {
  if (!id || id === state.user?.id) {
    toast("当前登录账号不能删除", "error");
    return;
  }
  const account = state.accounts.find((item) => item.id === id);
  if (!account || !canManageRoleInUi(account)) {
    toast("无权删除该账号", "error");
    return;
  }
  await api(`/api/accounts/${id}`, { method: "DELETE" });
  state.accounts = state.accounts.filter((item) => item.id !== id);
  await renderAccounts(state.user!);
  toast("账号已删除");
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

function renderAiConfig(config: AiModelConfig | null) {
  const name = qs<HTMLInputElement>("#aiConfigName");
  const baseUrl = qs<HTMLInputElement>("#aiBaseUrlInput");
  const model = qs<HTMLInputElement>("#aiModelInput");
  const apiKey = qs<HTMLInputElement>("#aiApiKeyInput");
  const enabled = qs<HTMLInputElement>("#aiEnabledInput");
  const useAi = qs<HTMLInputElement>("#websiteUseAiInput");
  const badgeNode = qs<HTMLElement>("#aiConfigBadge");
  if (name) name.value = config?.name || "官网商机解析模型";
  if (baseUrl) baseUrl.value = config?.baseUrl || "https://api.openai.com/v1";
  if (model) model.value = config?.model || "gpt-4o-mini";
  if (apiKey) {
    apiKey.value = config?.apiKey || "";
    apiKey.placeholder = config?.hasApiKey ? "已保存，重新填写可覆盖" : "保存后仅后端持久化";
  }
  if (enabled) enabled.checked = Boolean(config?.enabled);
  if (useAi) useAi.checked = Boolean(config?.enabled && config?.hasApiKey);
  if (badgeNode) {
    const ready = Boolean(config?.enabled && config?.hasApiKey);
    badgeNode.className = `badge ${ready ? "green" : config?.enabled ? "amber" : ""}`;
    badgeNode.textContent = ready ? `AI已启用 · ${config?.model}` : config?.enabled ? "规则解析 · 缺少API Key" : "规则解析";
  }
}

function collectAiConfigPayload() {
  return {
    name: qs<HTMLInputElement>("#aiConfigName")?.value.trim() || "官网商机解析模型",
    baseUrl: qs<HTMLInputElement>("#aiBaseUrlInput")?.value.trim() || "https://api.openai.com/v1",
    model: qs<HTMLInputElement>("#aiModelInput")?.value.trim() || "gpt-4o-mini",
    apiKey: qs<HTMLInputElement>("#aiApiKeyInput")?.value.trim() || "",
    enabled: Boolean(qs<HTMLInputElement>("#aiEnabledInput")?.checked)
  };
}

async function saveAiConfig(button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "保存中";
  }
  try {
    const result = await api<{ config: AiModelConfig }>("/api/tools/ai-config", {
      method: "POST",
      body: JSON.stringify(collectAiConfigPayload())
    });
    state.aiConfig = result.config;
    renderAiConfig(result.config);
    toast(result.config.enabled ? "AI解析配置已保存" : "AI配置已保存，当前仍使用规则解析");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "保存AI配置";
    }
  }
}

async function testAiConfig(button?: HTMLButtonElement) {
  await saveAiConfig();
  if (button) {
    button.disabled = true;
    button.textContent = "测试中";
  }
  try {
    const result = await api<{ ok: boolean; message: string }>("/api/tools/ai-config/test", { method: "POST" });
    toast(result.message, result.ok ? "ok" : "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "测试连接";
    }
  }
}

function renderWebsiteOpportunities(opportunities: WebsiteOpportunity[]) {
  const tbody = qs<HTMLElement>("#websiteOpportunityRows");
  const count = qs<HTMLElement>("#websiteOpportunityCount");
  const status = qs<HTMLElement>("#websiteScrapeStatus");
  const modeText = (mode?: WebsiteOpportunity["parseMode"]) => mode === "ai" ? "AI解析" : mode === "fallback" ? "AI回退" : "规则解析";
  const modeTone = (mode?: WebsiteOpportunity["parseMode"]) => mode === "ai" ? "green" : mode === "fallback" ? "amber" : "";
  if (count) count.textContent = `${opportunities.length} 条`;
  if (status && opportunities.length) {
    const synced = opportunities.filter((item) => item.status === "synced").length;
    const aiCount = opportunities.filter((item) => item.parseMode === "ai").length;
    status.innerHTML = `<b>${opportunities.length}</b><span>已解析官网</span>${badge(`${synced} 条已同步`, synced ? "green" : "")}${badge(aiCount ? `${aiCount} 条AI` : "规则/回退", aiCount ? "green" : "")}`;
  }
  if (!tbody) return;
  tbody.innerHTML = opportunities.length ? opportunities.map((item) => `
    <tr data-website-opportunity-id="${escapeHtml(item.id)}">
      <td><input type="checkbox" ${item.selected ?? item.status !== "synced" ? "checked" : ""} data-website-select></td>
      <td><input value="${escapeHtml(item.company)}" data-website-field="company"></td>
      <td><input value="${escapeHtml(item.business)}" data-website-field="business"></td>
      <td><input value="${escapeHtml(item.country)}" data-website-field="country"></td>
      <td><input value="${escapeHtml(item.website)}" data-website-field="website"></td>
      <td><input value="${escapeHtml(item.contact)}" data-website-field="contact"></td>
      <td><input value="${escapeHtml(item.contactInfo)}" data-website-field="contactInfo"></td>
      <td><textarea data-website-field="description">${escapeHtml(item.description)}</textarea></td>
      <td>${badge(item.status === "synced" ? "已同步" : "待同步", item.status === "synced" ? "green" : "amber")}${badge(modeText(item.parseMode), modeTone(item.parseMode))}</td>
    </tr>
  `).join("") : `<tr><td colspan="9" class="empty-cell">粘贴官网后点击解析，系统会抓取产品、联系方式和国家线索。</td></tr>`;
}

function collectWebsiteRows() {
  return qsa<HTMLTableRowElement>("#websiteOpportunityRows tr[data-website-opportunity-id]")
    .filter((row) => row.querySelector<HTMLInputElement>("[data-website-select]")?.checked)
    .map((row) => {
      const value = (field: string) => {
        const node = row.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-website-field="${field}"]`);
        return node?.value.trim() || "";
      };
      return {
        id: row.dataset.websiteOpportunityId || "",
        company: value("company"),
        business: value("business"),
        country: value("country"),
        website: value("website"),
        contact: value("contact"),
        contactInfo: value("contactInfo"),
        description: value("description")
      };
    }).filter((item) => item.company && item.website);
}

async function parseWebsiteOpportunities(button?: HTMLButtonElement) {
  const input = qs<HTMLTextAreaElement>("#websiteUrlInput");
  const urls = (input?.value || "").split(/\n|,|，/).map((item) => item.trim()).filter(Boolean);
  const useAi = Boolean(qs<HTMLInputElement>("#websiteUseAiInput")?.checked);
  if (!urls.length) {
    toast("请先粘贴官网地址", "error");
    return;
  }
  if (useAi && (!state.aiConfig?.enabled || !state.aiConfig?.hasApiKey)) {
    toast("请先保存并启用 AI 配置，或关闭本次 AI 解析", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = useAi ? "AI解析中" : "解析中";
  }
  try {
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-scrape/preview", {
      method: "POST",
      body: JSON.stringify({ urls, useAi })
    });
    const existing = state.websiteOpportunities
      .filter((item) => !result.opportunities.some((next) => next.website === item.website))
      .map((item) => ({ ...item, selected: false }));
    state.websiteOpportunities = [...result.opportunities.map((item) => ({ ...item, selected: true })), ...existing];
    renderWebsiteOpportunities(state.websiteOpportunities);
    toast(`${useAi ? "AI增强" : "规则"}已解析 ${result.opportunities.length} 个官网`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "解析官网";
    }
  }
}

async function syncWebsiteOpportunities(button?: HTMLButtonElement) {
  const opportunities = collectWebsiteRows();
  if (!opportunities.length) {
    toast("请至少勾选一条官网商机", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "同步中";
  }
  try {
    const result = await api<{ created: Array<{ customer: Customer; deal: Deal; opportunity: WebsiteOpportunity }> }>("/api/tools/website-scrape/sync-opportunities", {
      method: "POST",
      body: JSON.stringify({ opportunities })
    });
    result.created.forEach((item) => {
      if (!state.customers.some((customer) => customer.id === item.customer.id)) state.customers.unshift(item.customer);
      if (!state.deals.some((deal) => deal.id === item.deal.id)) state.deals.unshift(item.deal);
      const existing = state.websiteOpportunities.find((row) => row.id === item.opportunity.id || row.website === item.opportunity.website);
      if (existing) Object.assign(existing, item.opportunity);
      else state.websiteOpportunities.unshift(item.opportunity);
    });
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderCustomers(state.customers);
    renderPipeline(state.deals);
    void refreshDashboardOnly();
    toast(`已同步 ${result.created.length} 条官网商机`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "同步为商机";
    }
  }
}

function openTodoModal(prefill = "", editing?: Todo) {
  const titleValue = editing?.title || prefill;
  openModal(editing ? "编辑待办" : "新增待办", `
    <div class="form-grid">
      <div class="form-field full"><label>待办内容</label><input id="todoTitleInput" value="${escapeHtml(titleValue)}" placeholder="例如：明天 10 点跟进 Nordic Tools 报价"></div>
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

async function createQuickTodo(title: string) {
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

async function createInstrumentWeekTodos(button?: HTMLButtonElement) {
  const existingTitles = new Set(state.todos.map((todo) => todo.title));
  const missingTitles = instrumentWeekTodos.filter((title) => !existingTitles.has(title));
  if (!missingTitles.length) {
    toast("首周仪表开拓待办已存在，无需重复生成");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "生成中";
  }
  try {
    const created: Todo[] = [];
    for (const [index, title] of missingTitles.entries()) {
      const result = await api<{ todo: Todo }>("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          title,
          type: "customer",
          priority: index < 4 ? "high" : index < 8 ? "medium" : "normal",
          dueAt: "",
          related: "仪表开拓90天方案"
        })
      });
      created.push(result.todo);
    }
    state.todos.unshift(...created);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    void refreshDashboardOnly();
    toast(`已生成 ${created.length} 条首周仪表开拓待办`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "一键推到待办清单";
    }
  }
}

async function saveInstrumentPlanMemo(button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "写入中";
  }
  try {
    const existing = state.memos.find((memo) => memo.title === instrumentMemoTitle);
    const payload = {
      title: instrumentMemoTitle,
      category: "销售方案",
      tags: "仪表,外贸开拓,90天计划",
      content: instrumentPlanMemoContent(),
      pinned: true
    };
    if (existing) {
      const result = await api<{ memo: Memo }>(`/api/memos/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      Object.assign(existing, result.memo);
      state.selectedMemoId = existing.id;
      toast("仪表开拓方案备忘已更新");
    } else {
      const result = await api<{ memo: Memo }>("/api/memos", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      state.memos.unshift(result.memo);
      state.selectedMemoId = result.memo.id;
      toast("仪表开拓方案已写入备忘");
    }
    renderMemos(state.memos);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "写入备忘";
    }
  }
}

function exportInstrumentPlanCsv() {
  const rows = [
    ["模块", "事项", "目标/标准", "执行说明"],
    ["90天目标", "目标客户池", "600+", "按国家、客户类型、产品线维护到CRM"],
    ["90天目标", "有效触达", "900+", "邮件、LinkedIn、WhatsApp、企业微信等渠道记录"],
    ["90天目标", "有效回复", "60", "有需求、参数、采购计划或后续沟通意愿"],
    ["90天目标", "RFQ/样品/会议机会", "8", "进入报价、样品、线上会议或项目清单阶段"],
    ["每日动作", "新增客户", "30家/天", "经销商、系统集成商、OEM、EPC、MRO、终端工程师"],
    ["每日动作", "首触达", "20家/天", "按角色发送对应英文话术"],
    ["每日动作", "二次跟进", "10家/天", "补资料、问参数、推进到有效回复"],
    ["每日动作", "深挖A类客户", "3家/天", "查官网、联系人、产品线、项目线索和竞品"],
    ["前置知识", "关键参数", "必须掌握", "量程、精度、介质、温压、连接、输出、供电、防护、材质"],
    ["前置知识", "认证资料", "资料化", "CE、RoHS、EMC、ATEX/IECEx、防爆、SIL、校准证书、ISO、材质报告"],
    ...instrumentWeekTodos.map((title, index) => ["首周执行", title, `第${index + 1}项`, "完成后在CRM更新结果与下一动作"])
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "仪表外贸新客户开拓90天执行表.csv";
  link.click();
  URL.revokeObjectURL(link.href);
  toast("仪表开拓执行表已导出");
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
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest(".todo-actions")) return;
    if (!state.openTodoMenuId) return;
    state.openTodoMenuId = null;
    renderTodos(state.todos);
  }, true);
  qs<HTMLButtonElement>("#loginButton")?.addEventListener("click", (event) => {
    event.stopImmediatePropagation();
    const email = qs<HTMLInputElement>("#loginEmail")?.value.trim() || "";
    const password = qs<HTMLInputElement>("#loginPassword")?.value || "";
    void loginWithPassword(email, password).catch((error) => toast(error instanceof Error ? error.message : "登录失败", "error"));
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
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    void createQuickTodo(title);
  });
  qsa<HTMLButtonElement>("[data-dashboard-period]").forEach((button) => {
    button.addEventListener("click", () => {
      state.dashboardPeriod = (button.dataset.dashboardPeriod || "today") as AppState["dashboardPeriod"];
      if (state.summary) renderDashboard(state.summary, state.todos, state.customers);
      toast(`已切换到${dashboardPeriodLabel()}视图`);
    });
  });
  qs<HTMLButtonElement>("#morningViewButton")?.addEventListener("click", () => {
    state.morningView = !state.morningView;
    if (state.summary) renderDashboard(state.summary, state.todos, state.customers);
    toast(state.morningView ? "晨会视图已打开" : "晨会视图已关闭");
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
  qsa<HTMLButtonElement>("#instrumentTodoButton, #instrumentTodoButtonInline").forEach((button) => {
    button.addEventListener("click", (event) => void createInstrumentWeekTodos(event.currentTarget as HTMLButtonElement));
  });
  qs<HTMLButtonElement>("#instrumentMemoButton")?.addEventListener("click", (event) => void saveInstrumentPlanMemo(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#instrumentExportButton")?.addEventListener("click", exportInstrumentPlanCsv);
  qs<HTMLButtonElement>("#batchPriorityButton")?.addEventListener("click", (event) => void batchProcessPriorityTasks(event.currentTarget as HTMLButtonElement));
  qsa<HTMLButtonElement>("#customers .page-head .btn.primary").forEach((button) => {
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
    if (button.textContent?.includes("发布考试")) button.addEventListener("click", () => openExamCreateModal());
    if (button.textContent?.includes("题库维护")) button.addEventListener("click", () => openQuestionBankModal());
    if (button.textContent?.includes("分类目考试维护")) button.addEventListener("click", openExamCategoryModal);
  });
  qs<HTMLButtonElement>("#wecom .page-head .btn.primary")?.addEventListener("click", () => void syncWecomMessages());
  qs<HTMLButtonElement>("#aiSaveButton")?.addEventListener("click", (event) => void saveAiConfig(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#aiTestButton")?.addEventListener("click", (event) => void testAiConfig(event.currentTarget as HTMLButtonElement));
  qs<HTMLInputElement>("#aiEnabledInput")?.addEventListener("change", () => {
    const useAi = qs<HTMLInputElement>("#websiteUseAiInput");
    if (useAi) useAi.checked = Boolean(qs<HTMLInputElement>("#aiEnabledInput")?.checked && state.aiConfig?.hasApiKey);
  });
  qs<HTMLButtonElement>("#topPrimaryAction")?.addEventListener("click", () => {
    const view = qs<HTMLElement>(".view.active")?.id;
    if (view === "customers") openCustomerModal();
  });
  qs<HTMLButtonElement>("#topImportButton")?.addEventListener("click", () => {
    const view = qs<HTMLElement>(".view.active")?.id;
    if (view === "customers") activateNavView("imports", () => void createJob("import"));
  });
  qs<HTMLButtonElement>("#topExportButton")?.addEventListener("click", () => {
    const view = qs<HTMLElement>(".view.active")?.id;
    if (view === "customers") activateNavView("imports", () => void createJob("export"));
  });
  qsa<HTMLButtonElement>("[data-top-view]").forEach((button) => {
    button.addEventListener("click", () => activateNavView(button.dataset.topView || "dashboard"));
  });
  qs<HTMLInputElement>("#topSearchInput")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = event.currentTarget as HTMLInputElement;
    const nextView = resolveTopbarSearchView(input.value);
    if (!nextView) {
      toast("没有匹配到模块，可搜索：客户、商机、考试、资料、报表、备忘", "error");
      return;
    }
    activateNavView(nextView);
    input.value = "";
  });
  qsa<HTMLButtonElement>("#tools .page-head .btn, #tools .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("加载名片")) button.addEventListener("click", () => void recognizeOcr({ company: "Tianjin Mahe Trading Co., Ltd.", contact: "Ma He", email: "sales@tjmahe.com", country: "中国" }));
    if (button.textContent?.includes("重新识别")) button.addEventListener("click", () => void recognizeOcr());
    if (button.textContent?.includes("工具配置")) button.addEventListener("click", () => toast("OCR 字段映射配置已保存"));
    if (button.textContent?.includes("解析官网")) button.addEventListener("click", (event) => void parseWebsiteOpportunities(event.currentTarget as HTMLButtonElement));
  });
  qsa<HTMLButtonElement>("#tools .btn.primary").forEach((button) => {
    if (button.textContent?.includes("同步为商机")) button.addEventListener("click", (event) => void syncWebsiteOpportunities(event.currentTarget as HTMLButtonElement));
    else if (button.textContent?.includes("同步")) button.addEventListener("click", () => void syncOcrLead(button));
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
  renderTopbarForView(view);
  window.scrollTo({ top: 0, behavior: "smooth" });
  after?.();
}

function renderTopbarForView(view: string) {
  const searchWrap = qs<HTMLElement>("#topSearchWrap");
  const searchInput = qs<HTMLInputElement>("#topSearchInput");
  const context = qs<HTMLElement>("#topActionContext");
  const importButton = qs<HTMLButtonElement>("#topImportButton");
  const exportButton = qs<HTMLButtonElement>("#topExportButton");
  const primaryButton = qs<HTMLButtonElement>("#topPrimaryAction");
  const primaryText = primaryButton?.querySelector("span");
  const isCustomerView = view === "customers";

  searchWrap?.classList.remove("is-hidden");
  context?.classList.toggle("is-hidden", !isCustomerView);
  if (searchInput) {
    searchInput.placeholder = isCustomerView ? "搜索客户、联系人、国家或产品" : "全局搜索 / 输入模块名后回车跳转";
  }
  if (importButton) importButton.hidden = !isCustomerView;
  if (exportButton) exportButton.hidden = !isCustomerView;
  if (primaryButton) primaryButton.hidden = !isCustomerView;
  if (primaryText && isCustomerView) primaryText.textContent = "新增客户";
  qsa<HTMLElement>("[data-top-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.topView === view);
  });
  renderTopbarStats();
}

function renderTopbarStats() {
  const todoCount = activeTodos(state.todos).filter((todo) => !todo.done).length;
  const reminderCount = state.reminders.filter((reminder) => reminder.status !== "done").length;
  const todoNode = qs<HTMLElement>("#topTodoCount");
  const reminderNode = qs<HTMLElement>("#topReminderCount");
  if (todoNode) todoNode.textContent = String(todoCount);
  if (reminderNode) reminderNode.textContent = String(reminderCount);
}

function resolveTopbarSearchView(rawValue: string) {
  const value = rawValue.trim().toLowerCase();
  if (!value) return null;
  const candidates: Array<[string, string]> = [
    ["工作台", "dashboard"],
    ["待办", "dashboard"],
    ["todo", "dashboard"],
    ["客户", "customers"],
    ["customer", "customers"],
    ["商机", "pipeline"],
    ["pipeline", "pipeline"],
    ["提醒", "reminders"],
    ["reminder", "reminders"],
    ["导入", "imports"],
    ["导出", "imports"],
    ["import", "imports"],
    ["报表", "reports"],
    ["report", "reports"],
    ["企业微信", "wecom"],
    ["微信", "wecom"],
    ["资料", "knowledge"],
    ["knowledge", "knowledge"],
    ["考试", "exam"],
    ["exam", "exam"],
    ["工具", "tools"],
    ["ocr", "tools"],
    ["竞争", "competitors"],
    ["competitor", "competitors"],
    ["案例", "cases"],
    ["case", "cases"],
    ["问题", "problems"],
    ["problem", "problems"],
    ["备忘", "memos"],
    ["memo", "memos"],
    ["设置", "settings"],
    ["account", "settings"]
  ];
  return candidates.find(([keyword]) => value.includes(keyword))?.[1] || null;
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
renderTopbarForView(qs<HTMLElement>(".view.active")?.id || "dashboard");
void restoreSession();
