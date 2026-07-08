type Role = "sales" | "manager" | "admin" | "super_admin";

import * as XLSX from "xlsx";

interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string;
  avatar: string;
  outboundEmail?: string;
  emailSenderName?: string;
  emailSignature?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  hasSmtpPassword?: boolean;
  lastDevelopmentEmailAt?: string;
  lastDevelopmentEmailTo?: string;
  lastDevelopmentEmailSubject?: string;
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
  billingName?: string;
  billingAddress?: string;
  documentContact?: string;
  defaultPortDischarge?: string;
  defaultIncoterm?: string;
  defaultPaymentTerm?: string;
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
  customerId?: string;
  title: string;
  stage: string;
  product?: string;
  quantity?: number;
  unitPrice?: number;
  amount: number;
  nextAction: string;
  archivedAt?: string;
}

interface Reminder {
  id: string;
  title: string;
  rule: string;
  dueAt: string;
  channel: string;
  status: string;
  ruleType?: string;
  targetStage?: string;
  days?: number;
  priority?: "high" | "medium" | "normal";
  enabled?: boolean;
  generatedCount?: number;
}

interface ImportExportJob {
  id: string;
  name: string;
  type: string;
  rows: number;
  status: string;
  createdAt: string;
}

interface TradeDocumentItem {
  id: string;
  product: string;
  model: string;
  hsCode: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  originCountry: string;
  weightKg: number;
  packageCount: number;
}

interface TradeDocument {
  id: string;
  type: "PI" | "CI";
  title: string;
  number: string;
  issueDate: string;
  buyer: string;
  buyerAddress: string;
  buyerContact: string;
  seller: string;
  sellerAddress: string;
  currency: string;
  incoterm: string;
  paymentTerm: string;
  shippingMethod: string;
  portLoading: string;
  portDischarge: string;
  validityDate: string;
  bankInfo: string;
  notes: string;
  templateStyle: "executive" | "classic" | "compact";
  status: "draft" | "ready" | "exported";
  updatedAt: string;
  items: TradeDocumentItem[];
}

interface CustomerImportRow {
  company: string;
  country: string;
  contact: string;
  stage: string;
  amount: number;
  health: number;
  nextReminder: string;
  wecomBound: boolean;
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
  lastDevelopmentEmailAt?: string;
  lastDevelopmentEmailSubject?: string;
  lastDevelopmentEmailTo?: string;
  selected?: boolean;
}

interface LeadFinderJob {
  id: string;
  title: string;
  subtitle: string;
  status: "ready" | "running" | "done" | "needs_input";
  resultCount: number;
  channelCount: number;
  elapsedText: string;
  progress: number;
  steps: string[];
  createdAt: string;
  expanded?: boolean;
  resultIds?: string[];
  detailLines?: string[];
}

interface AiModelConfig {
  id: string;
  provider: string;
  protocol: "openai-compatible" | "anthropic" | "gemini";
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
  enabled: boolean;
  temperature: number;
  useLeadFinder: boolean;
  useWebsiteParse: boolean;
  useScoring: boolean;
  useEmailDraft: boolean;
  useExam: boolean;
  lastTestAt?: string;
  lastTestStatus?: "untested" | "passed" | "failed";
  lastTestMessage?: string;
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

interface PlanTask {
  id: string;
  title: string;
  phase: string;
  category: string;
  priority: "high" | "medium" | "normal";
  status: "planned" | "active" | "done";
  dueAt: string;
  target: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface PlanTemplate {
  id: string;
  section: "knowledge" | "persona" | "execution";
  title: string;
  summary: string;
  output: string;
  badge: string;
  badgeTone: string;
  phase: string;
  category: string;
  priority: "high" | "medium" | "normal";
  target: string;
  description: string;
  sortOrder: number;
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
  tradeDocuments: TradeDocument[];
  wecomMessages: WecomMessage[];
  knowledgeAssets: KnowledgeAsset[];
  exams: Exam[];
  examQuestions: ExamQuestion[];
  examReport: ExamReport | null;
  ocrJob: OcrJob | null;
  websiteOpportunities: WebsiteOpportunity[];
  aiConfig: AiModelConfig | null;
  aiConfigs: AiModelConfig[];
  selectedAiConfigId: string | null;
  aiDraftMode: boolean;
  pendingAiDeleteId: string | null;
  problems: ProblemItem[];
  memos: Memo[];
  planTasks: PlanTask[];
  planTemplates: PlanTemplate[];
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
  selectedCustomerIds: string[];
  selectedProblemId: string | null;
  selectedMemoId: string | null;
  selectedPlanTaskIds: string[];
  selectedPlanTemplateId: string | null;
  selectedCompetitorId: string | null;
  selectedCaseId: string | null;
  selectedExamId: string | null;
  selectedExamIds: string[];
  selectedQuestionId: string | null;
  selectedDocumentId: string | null;
  selectedLeadFinderId: string | null;
  leadFinderFilter: "all" | "pending" | "high" | "duplicate" | "synced";
  selectedProspectId: string | null;
  prospectFilter: "all" | "pending" | "mailed" | "high" | "synced";
}

const state: AppState = {
  user: null,
  summary: null,
  customers: [],
  todos: [],
  deals: [],
  reminders: [],
  jobs: [],
  tradeDocuments: [],
  wecomMessages: [],
  knowledgeAssets: [],
  exams: [],
  examQuestions: [],
  examReport: null,
  ocrJob: null,
  websiteOpportunities: [],
  aiConfig: null,
  aiConfigs: [],
  selectedAiConfigId: null,
  aiDraftMode: false,
  pendingAiDeleteId: null,
  problems: [],
  memos: [],
  planTasks: [],
  planTemplates: [],
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
  selectedCustomerIds: [],
  selectedProblemId: null,
  selectedMemoId: null,
  selectedPlanTaskIds: [],
  selectedPlanTemplateId: null,
  selectedCompetitorId: null,
  selectedCaseId: null,
  selectedExamId: null,
  selectedExamIds: [],
  selectedQuestionId: null,
  selectedDocumentId: null,
  selectedLeadFinderId: null,
  leadFinderFilter: "all",
  selectedProspectId: null,
  prospectFilter: "all"
};

let memoDirty = false;
let memoSaving = false;
let memoSavePromise: Promise<void> | null = null;
let leadFinderJobs: LeadFinderJob[] = [];
let customerClockTimer = 0;

const aiProviderPresets: Record<string, {
  label: string;
  protocol: AiModelConfig["protocol"];
  baseUrl: string;
  model: string;
  name: string;
}> = {
  openai: { label: "OpenAI", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", name: "OpenAI 业务模型" },
  anthropic: { label: "Claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet-latest", name: "Claude 长文本模型" },
  gemini: { label: "Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-1.5-flash", name: "Gemini 国际化模型" },
  deepseek: { label: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", name: "DeepSeek 搜客解析模型" },
  qwen: { label: "通义千问", protocol: "openai-compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", name: "通义千问业务模型" },
  moonshot: { label: "Kimi", protocol: "openai-compatible", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", name: "Kimi 业务模型" },
  zhipu: { label: "智谱GLM", protocol: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", name: "智谱GLM业务模型" },
  baidu: { label: "百度千帆", protocol: "openai-compatible", baseUrl: "https://qianfan.baidubce.com/v2", model: "ernie-4.0-turbo-8k", name: "百度千帆业务模型" },
  volcengine: { label: "豆包", protocol: "openai-compatible", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-pro-32k", name: "豆包业务模型" },
  mistral: { label: "Mistral", protocol: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest", name: "Mistral 业务模型" },
  groq: { label: "Groq", protocol: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.1-70b-versatile", name: "Groq 高速模型" },
  openrouter: { label: "OpenRouter", protocol: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", name: "OpenRouter 聚合模型" },
  ollama: { label: "Ollama", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", name: "本地 Ollama 模型" },
  custom: { label: "自定义", protocol: "openai-compatible", baseUrl: "https://example.com/v1", model: "your-model-name", name: "自定义兼容模型" }
};

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

const instrumentMemoTitle = "计划任务执行方案";

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
  renderProfile(user);
}

function roleScopeText(user: User) {
  if (user.role === "sales") return "仅本人业务与本人待办";
  if (user.role === "manager") return "团队业务数据，本人待办私有";
  if (user.role === "admin") return "全局业务数据、账号管理，本人待办私有";
  return "全局业务数据、最高账号权限，本人待办私有";
}

function renderProfile(user = state.user) {
  if (!user) return;
  const setValue = (selector: string, value: string) => {
    const input = qs<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (input) input.value = value;
  };
  const avatar = qs<HTMLElement>("#profileAvatarLarge");
  const name = qs<HTMLElement>("#profileNameTitle");
  const role = qs<HTMLElement>("#profileRoleText");
  const status = qs<HTMLElement>("#profileEmailStatus");
  const signatureStatus = qs<HTMLElement>("#profileSignatureStatus");
  const teamText = user.teamId === "all" ? "全局团队" : `${user.teamId} 组`;
  const mailReady = Boolean(user.outboundEmail);
  if (avatar) avatar.textContent = user.avatar;
  if (name) name.textContent = user.name;
  if (role) role.textContent = `${roleLabel[user.role]} · ${roleScopeText(user)}`;
  qs<HTMLElement>("#profileStatusBadge")!.textContent = "账号正常";
  qs<HTMLElement>("#profileTeamBadge")!.textContent = teamText;
  const emailBadge = qs<HTMLElement>("#profileEmailBadge");
  if (emailBadge) {
    emailBadge.className = `badge ${mailReady ? "green" : "amber"}`;
    emailBadge.textContent = mailReady ? "发件邮箱已绑定" : "发件邮箱待绑定";
  }
  qs<HTMLElement>("#profileScopeMetric")!.textContent = user.role === "sales" ? "本人业务" : user.role === "manager" ? "团队业务" : "全局业务";
  qs<HTMLElement>("#profileRoleMetric")!.textContent = roleLabel[user.role];
  qs<HTMLElement>("#profileMailMetric")!.textContent = mailReady && user.smtpHost && user.hasSmtpPassword ? "可真实发信" : mailReady ? "待配SMTP" : "未绑定";
  qs<HTMLElement>("#profileLoginEmailText")!.textContent = user.email;
  qs<HTMLElement>("#profileIdText")!.textContent = user.id;
  qs<HTMLElement>("#profileScopeText")!.textContent = roleScopeText(user);
  setValue("#profileLoginEmail", user.email);
  setValue("#profileOutboundEmail", user.outboundEmail || "");
  setValue("#profileSenderName", user.emailSenderName || user.name);
  setValue("#profileEmailSignature", user.emailSignature || `Best regards,\n${user.name}\nGoodJob Instrument Sales`);
  setValue("#profileSmtpHost", user.smtpHost || "");
  setValue("#profileSmtpPort", String(user.smtpPort || 465));
  setValue("#profileSmtpUser", user.smtpUser || user.outboundEmail || "");
  setValue("#profileSmtpPassword", "");
  const smtpSecure = qs<HTMLSelectElement>("#profileSmtpSecure");
  if (smtpSecure) smtpSecure.value = String(user.smtpSecure ?? true);
  if (status) status.innerHTML = user.outboundEmail ? `${badge("已绑定", "green")} ${escapeHtml(user.outboundEmail)}` : `${badge("未绑定", "amber")} 请先绑定发件邮箱`;
  if (signatureStatus) signatureStatus.innerHTML = user.emailSignature?.trim() ? `${badge("已设置", "green")} ${escapeHtml((user.emailSignature.split("\n")[0] || "签名已维护").slice(0, 36))}` : `${badge("待完善", "amber")} 建议补充英文签名`;
  const smtpStatus = qs<HTMLElement>("#profileSmtpStatus");
  if (smtpStatus) smtpStatus.innerHTML = user.smtpHost && user.smtpUser && user.hasSmtpPassword ? `${badge("已配置", "green")} ${escapeHtml(user.smtpHost)}` : `${badge("未完整", "amber")} 填写SMTP后才能真实发信`;
}

function collectDevelopmentEmailDraft() {
  const sender = qs<HTMLInputElement>("#profileSenderName")?.value.trim() || state.user?.name || "GoodJob Sales";
  const from = qs<HTMLInputElement>("#profileOutboundEmail")?.value.trim() || state.user?.outboundEmail || "";
  const signature = qs<HTMLTextAreaElement>("#profileEmailSignature")?.value.trim() || "";
  return {
    to: qs<HTMLInputElement>("#devEmailTo")?.value.trim() || "",
    company: qs<HTMLInputElement>("#devEmailCompany")?.value.trim() || "",
    subject: qs<HTMLInputElement>("#devEmailSubject")?.value.trim() || "",
    body: qs<HTMLTextAreaElement>("#devEmailBody")?.value.trim() || "",
    sender,
    from,
    signature
  };
}

function generateDevelopmentEmailDraft() {
  const company = qs<HTMLInputElement>("#devEmailCompany")?.value.trim() || "your company";
  const sender = qs<HTMLInputElement>("#profileSenderName")?.value.trim() || state.user?.name || "GoodJob Sales";
  const signature = qs<HTMLTextAreaElement>("#profileEmailSignature")?.value.trim() || `Best regards,\n${sender}\nGoodJob Instrument Sales`;
  const body = [
    `Dear ${company} team,`,
    "",
    "We supply pressure, temperature, flow and level instruments for distributors, system integrators and industrial projects.",
    "If you are evaluating instrumentation suppliers for your local market, we can support product selection, certificates, technical datasheets and quotation for your project requirements.",
    "",
    "Could you share the main product categories you are currently sourcing and the applications you are focused on?",
    "",
    signature
  ].join("\n");
  const input = qs<HTMLTextAreaElement>("#devEmailBody");
  if (input) input.value = body;
  renderDevelopmentEmailPreview();
}

function renderDevelopmentEmailPreview() {
  const draft = collectDevelopmentEmailDraft();
  const preview = qs<HTMLElement>("#devEmailPreview");
  if (!preview) return;
  preview.textContent = [
    `From: ${draft.sender}${draft.from ? ` <${draft.from}>` : " <未绑定>"}`,
    `To: ${draft.to || "未填写"}`,
    `Subject: ${draft.subject || "未填写"}`,
    "",
    draft.body || "填写内容后可预览开发信。"
  ].join("\n");
}

function updateStoredUser(user: User, token?: string) {
  state.user = user;
  localStorage.setItem(storage.user, JSON.stringify(user));
  if (token) localStorage.setItem(storage.token, token);
  applyAuthedUser(user);
}

async function saveProfileEmailBinding(button?: HTMLButtonElement) {
  const outboundEmail = qs<HTMLInputElement>("#profileOutboundEmail")?.value.trim() || "";
  const emailSenderName = qs<HTMLInputElement>("#profileSenderName")?.value.trim() || "";
  const emailSignature = qs<HTMLTextAreaElement>("#profileEmailSignature")?.value.trim() || "";
  const smtpHost = qs<HTMLInputElement>("#profileSmtpHost")?.value.trim() || "";
  const smtpPort = Number(qs<HTMLInputElement>("#profileSmtpPort")?.value || 465);
  const smtpSecure = qs<HTMLSelectElement>("#profileSmtpSecure")?.value !== "false";
  const smtpUser = qs<HTMLInputElement>("#profileSmtpUser")?.value.trim() || "";
  const smtpPassword = qs<HTMLInputElement>("#profileSmtpPassword")?.value || "";
  if (!outboundEmail || !emailSenderName) {
    toast("请填写发件邮箱和发件人名称", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "保存中";
  }
  try {
    const result = await api<{ user: User; token: string }>("/api/profile/email-binding", {
      method: "PATCH",
      body: JSON.stringify({ outboundEmail, emailSenderName, emailSignature, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword })
    });
    updateStoredUser(result.user, result.token);
    toast("发件邮箱已绑定");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "保存个人资料";
    }
  }
}

async function sendProfileTestEmail(button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ ok: boolean; simulated: boolean; messageId?: string }>("/api/profile/test-email", { method: "POST" });
    toast(result.simulated ? "测试邮件已生成（测试环境未外发）" : "测试邮件已发送，请检查发件邮箱收件箱");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "发送测试邮件";
    }
  }
}

async function sendDevelopmentEmail(button?: HTMLButtonElement) {
  const draft = collectDevelopmentEmailDraft();
  if (!draft.from) {
    toast("请先绑定发件邮箱", "error");
    return;
  }
  if (!draft.to || !draft.company || !draft.subject || draft.body.length < 10) {
    toast("请补齐收件邮箱、目标公司、主题和正文", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ sent: { simulated: boolean }; user: User }>("/api/profile/send-development-email", {
      method: "POST",
      body: JSON.stringify({ to: draft.to, company: draft.company, subject: draft.subject, body: draft.body })
    });
    updateStoredUser(result.user);
    toast(result.sent.simulated ? "开发信已发送（系统模拟记录）" : "开发信已发送");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "发送开发信";
    }
  }
}

async function refreshAll(user: User) {
  renderDashboardCache(user);
  const [summary, customers, todos, deals, reminders, jobs, tradeDocs, wecom, knowledge, exams, ocr, websiteOps, aiConfig, problems, memos, planTasks, planTemplates, competitors, caseStudies] = await Promise.all([
    api<DashboardSummary>("/api/dashboard/summary"),
    api<{ customers: Customer[] }>("/api/customers"),
    api<{ todos: Todo[] }>("/api/todos"),
    api<{ deals: Deal[] }>("/api/deals"),
    api<{ reminders: Reminder[] }>("/api/reminders"),
    api<{ jobs: ImportExportJob[] }>("/api/import-export/jobs"),
    api<{ documents: TradeDocument[] }>("/api/trade-documents"),
    api<{ messages: WecomMessage[] }>("/api/wecom/messages"),
    api<{ assets: KnowledgeAsset[] }>("/api/knowledge/assets"),
    api<{ exams: Exam[]; report: ExamReport }>("/api/exams"),
    api<{ job: OcrJob }>("/api/tools/ocr/jobs/ocr1"),
    api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-opportunities"),
    api<{ config: AiModelConfig | null; configs?: AiModelConfig[] }>("/api/tools/ai-config"),
    api<{ problems: ProblemItem[] }>("/api/problems"),
    api<{ memos: Memo[] }>("/api/memos"),
    api<{ tasks: PlanTask[] }>("/api/plan-tasks"),
    api<{ templates: PlanTemplate[] }>("/api/plan-templates"),
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
  state.tradeDocuments = tradeDocs.documents;
  state.wecomMessages = wecom.messages;
  state.knowledgeAssets = knowledge.assets;
  state.exams = exams.exams;
  state.examReport = exams.report;
  state.ocrJob = ocr.job;
  state.websiteOpportunities = websiteOps.opportunities;
  state.aiConfig = aiConfig.config;
  state.aiConfigs = aiConfig.configs || (aiConfig.config ? [aiConfig.config] : []);
  state.selectedAiConfigId = state.selectedAiConfigId && state.aiConfigs.some((item) => item.id === state.selectedAiConfigId)
    ? state.selectedAiConfigId
    : state.aiConfig?.id || state.aiConfigs[0]?.id || null;
  state.problems = problems.problems;
  state.memos = memos.memos;
  state.planTasks = planTasks.tasks;
  state.planTemplates = planTemplates.templates;
  state.competitors = competitors.competitors;
  state.caseStudies = caseStudies.caseStudies;
  state.selectedCustomerId = state.selectedCustomerId || customers.customers[0]?.id || null;
  state.selectedProblemId = state.selectedProblemId || problems.problems[0]?.id || null;
  state.selectedMemoId = state.selectedMemoId || memos.memos[0]?.id || null;
  state.selectedCompetitorId = state.selectedCompetitorId || competitors.competitors[0]?.id || null;
  state.selectedCaseId = state.selectedCaseId || caseStudies.caseStudies[0]?.id || null;
  state.selectedExamId = state.selectedExamId || exams.exams[0]?.id || null;
  state.selectedDocumentId = state.selectedDocumentId || tradeDocs.documents[0]?.id || null;
  writeDashboardCache(user, summary, todos.todos, customers.customers);
  renderDashboard(summary, todos.todos, customers.customers);
  renderCustomers(customers.customers);
  renderPipeline(deals.deals);
  renderReminders(reminders.reminders);
  renderJobs(jobs.jobs);
  renderTradeDocuments(tradeDocs.documents);
  renderWecom(wecom.messages);
  renderKnowledge(knowledge.assets);
  renderExams(exams.exams);
  renderDashboardKnowledgePanels(knowledge.assets, exams.exams);
  renderProblems(problems.problems);
  renderMemos(memos.memos);
  renderPlanTasks(planTasks.tasks);
  renderPlanTemplates(planTemplates.templates);
  renderCompetitors(competitors.competitors);
  renderCaseStudies(caseStudies.caseStudies);
  await renderAccounts(user);
  renderOcr(ocr.job);
  renderAiConfig(state.aiConfig);
  renderWebsiteOpportunities(state.websiteOpportunities);
  renderLeadFinder(state.websiteOpportunities);
  renderProspectList();
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
    return `<div class="bar-row" data-stage="${escapeHtml(item.stage)}" data-count="${item.count}"><span>${escapeHtml(item.stage)}</span><div class="track" aria-label="${escapeHtml(item.stage)} ${item.count} 单"><div class="fill ${toneClass}" style="width:${item.width}%"></div></div><b>${item.count} 单 · ${money(item.amount)}${risk}</b></div>`;
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
  state.selectedCustomerIds = state.selectedCustomerIds.filter((id) => customers.some((customer) => customer.id === id));
  renderCustomerBulkBar(customers);
  tbody.innerHTML = customers.map((customer, index) => {
    const checked = state.selectedCustomerIds.includes(customer.id);
    const owner = customer.id === "c3" || customer.id === "c4" ? "Mia" : "Shirley";
    const reminder = customer.nextReminder.includes("逾期") ? badge(customer.nextReminder, "red") : escapeHtml(customer.nextReminder);
    return `<tr class="${index === 0 ? "selected" : ""} ${checked ? "checked" : ""}">
    <td><input type="checkbox" data-select-customer ${checked ? "checked" : ""}></td>
    <td><div class="company"><span class="flag">${countryFlag(customer.country)}</span><div><b>${escapeHtml(customer.company)}</b><span>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact)} · ${owner}</span></div></div></td>
    <td>${badge(customer.stage, customer.stage === "成交" || customer.stage === "谈判" ? "green" : customer.stage === "已报价" ? "amber" : "")}</td>
    <td><div class="customer-health-cell">${health(customer.health)}<span>${customer.health}%</span></div></td>
    <td><div class="customer-follow-cell"><span>最近 今天</span><b>${reminder}</b></div></td>
    <td>${badge(customer.wecomBound ? "已绑定" : "未绑定", customer.wecomBound ? "green" : "gray")}</td>
    <td><button class="btn" data-edit-customer>编辑</button></td>
  </tr>`;
  }).join("");
  qsa<HTMLElement>("tr", tbody).forEach((row, index) => {
    const customer = customers[index];
    row.dataset.customerId = customer.id;
    row.classList.toggle("selected", customer.id === (state.selectedCustomerId || customers[0]?.id));
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button,input,label")) return;
      state.selectedCustomerId = customer.id;
      renderCustomerDrawer(customer);
      qsa<HTMLElement>("tr", tbody).forEach((item) => item.classList.toggle("selected", item.dataset.customerId === customer.id));
    });
  });
  qsa<HTMLInputElement>("[data-select-customer]", tbody).forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      const id = checkbox.closest<HTMLElement>("tr")?.dataset.customerId || "";
      if (!id) return;
      state.selectedCustomerIds = checkbox.checked
        ? Array.from(new Set([...state.selectedCustomerIds, id]))
        : state.selectedCustomerIds.filter((selectedId) => selectedId !== id);
      renderCustomers(state.customers);
    });
  });
  qsa<HTMLButtonElement>("[data-edit-customer]", tbody).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const customer = state.customers.find((item) => item.id === button.closest<HTMLElement>("tr")?.dataset.customerId);
      if (customer) openCustomerModal(customer);
    });
  });
  renderCustomerDrawer(customers.find((item) => item.id === state.selectedCustomerId) || customers[0]);
}

function renderCustomerBulkBar(customers: Customer[]) {
  const toolbar = qs<HTMLElement>("#customers .toolbar");
  if (!toolbar) return;
  const selectedCount = state.selectedCustomerIds.length;
  const allSelected = customers.length > 0 && selectedCount === customers.length;
  toolbar.innerHTML = `
    <label class="customer-select-all"><input type="checkbox" data-select-all-customers ${allSelected ? "checked" : ""}>全选</label>
    <span class="filter">已选 ${selectedCount} 个客户</span>
    <span class="filter">国家：全部</span><span class="filter">阶段：全部</span><span class="filter">最近跟进：30 天</span>
    <button class="btn danger" data-bulk-delete-customers ${selectedCount ? "" : "disabled"}>批量删除</button>
    <button class="btn">批量导出</button>
  `;
  qs<HTMLInputElement>("[data-select-all-customers]", toolbar)?.addEventListener("change", (event) => {
    state.selectedCustomerIds = (event.currentTarget as HTMLInputElement).checked ? customers.map((customer) => customer.id) : [];
    renderCustomers(state.customers);
  });
  qs<HTMLButtonElement>("[data-bulk-delete-customers]", toolbar)?.addEventListener("click", () => void bulkDeleteCustomers());
}

function customerRelatedDeals(customer: Customer) {
  return state.deals
    .filter((deal) => deal.customerId === customer.id)
    .sort((left, right) => Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)) || right.amount - left.amount);
}

function dealTone(deal: Deal) {
  if (deal.stage === "丢单") return "red";
  if (deal.stage === "成交") return "green";
  if (deal.archivedAt) return "gray";
  if (deal.stage === "已报价") return "amber";
  return "";
}

function renderCustomerDealProgress(customer: Customer) {
  const deals = customerRelatedDeals(customer);
  if (!deals.length) {
    return `
      <section class="customer-deals">
        <div class="customer-deals-head"><h3>相关商机进展</h3><button class="btn" data-view-related-deals>查看商机管道</button></div>
        <div class="customer-deal-empty">暂无关联商机。新增商机时选择该客户后，会自动显示在这里。</div>
      </section>
    `;
  }
  return `
    <section class="customer-deals">
      <div class="customer-deals-head"><h3>相关商机进展</h3><button class="btn" data-view-related-deals>查看商机管道</button></div>
      <div class="customer-deal-list">
        ${deals.map((deal) => `
          <article class="customer-deal-row">
            <div>
              <b>${escapeHtml(deal.title)}</b>
              <span>${escapeHtml(deal.nextAction)}${deal.archivedAt ? ` · ${escapeHtml(formatDateTime(deal.archivedAt))}` : ""}</span>
            </div>
            <div class="customer-deal-meta">
              ${badge(deal.archivedAt && deal.stage !== "丢单" ? "已归档" : deal.stage, dealTone(deal))}
              <strong>${money(deal.amount)}</strong>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function customerTimeZone(country = "") {
  const normalized = country.trim().toLowerCase();
  const zones: Record<string, string> = {
    中国: "Asia/Shanghai",
    china: "Asia/Shanghai",
    瑞典: "Europe/Stockholm",
    sweden: "Europe/Stockholm",
    美国: "America/New_York",
    usa: "America/New_York",
    "united states": "America/New_York",
    日本: "Asia/Tokyo",
    japan: "Asia/Tokyo",
    阿联酋: "Asia/Dubai",
    uae: "Asia/Dubai",
    德国: "Europe/Berlin",
    germany: "Europe/Berlin",
    法国: "Europe/Paris",
    france: "Europe/Paris",
    意大利: "Europe/Rome",
    italy: "Europe/Rome",
    西班牙: "Europe/Madrid",
    spain: "Europe/Madrid",
    荷兰: "Europe/Amsterdam",
    netherlands: "Europe/Amsterdam",
    英国: "Europe/London",
    uk: "Europe/London",
    印度: "Asia/Kolkata",
    india: "Asia/Kolkata",
    澳大利亚: "Australia/Sydney",
    australia: "Australia/Sydney",
    土耳其: "Europe/Istanbul",
    turkey: "Europe/Istanbul",
    智利: "America/Santiago",
    chile: "America/Santiago"
  };
  return zones[normalized] || zones[country.trim()] || "UTC";
}

function customerWorldTimeParts(country: string) {
  const timeZone = customerTimeZone(country);
  const now = new Date();
  try {
    const time = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
    const date = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      weekday: "short",
      month: "2-digit",
      day: "2-digit"
    }).format(now);
    const hourText = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(now);
    const hour = Number(hourText);
    const dayPart = hour >= 6 && hour < 12 ? "上午" : hour >= 12 && hour < 18 ? "下午" : hour >= 18 && hour < 22 ? "晚上" : "深夜";
    const contactHint = hour >= 8 && hour < 18 ? "适合联系" : hour >= 18 && hour < 22 ? "谨慎联系" : "建议预约";
    return { time, date, timeZone, dayPart, contactHint };
  } catch {
    return { time: now.toLocaleTimeString("zh-CN"), date: now.toLocaleDateString("zh-CN"), timeZone: "UTC", dayPart: "未知", contactHint: "待确认" };
  }
}

function renderCustomerWorldClock(customer: Customer) {
  const clock = qs<HTMLElement>("#customerWorldClock");
  const date = qs<HTMLElement>("#customerWorldDate");
  const zone = qs<HTMLElement>("#customerWorldZone");
  const status = qs<HTMLElement>("#customerWorldStatus");
  if (!clock || !date || !zone || !status) return;
  const parts = customerWorldTimeParts(customer.country);
  clock.textContent = parts.time;
  date.textContent = `${customer.country}当地 · ${parts.date}`;
  zone.textContent = parts.timeZone;
  status.textContent = `${parts.dayPart} · ${parts.contactHint}`;
}

function renderCustomerDrawer(customer?: Customer) {
  const drawer = qs<HTMLElement>("#customers .drawer");
  if (!drawer || !customer) return;
  const billingName = customer.billingName || customer.company;
  const billingAddress = customer.billingAddress || `${customer.country} / 地址待维护`;
  const documentContact = customer.documentContact || customer.contact;
  const portDischarge = customer.defaultPortDischarge || "待确认";
  const incoterm = customer.defaultIncoterm || "FOB Tianjin";
  const paymentTerm = customer.defaultPaymentTerm || "30% T/T deposit, 70% before shipment";
  drawer.innerHTML = `
    <div class="drawer-head">
      <div><h2>${escapeHtml(customer.company)}</h2><p>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact)} · ${escapeHtml(customer.stage)}</p></div>
      ${customer.nextReminder.includes("逾期") ? badge("报价未回复", "red") : badge("跟进中", "green")}
    </div>
    <section class="customer-time-card" aria-label="客户世界时间">
      <div>
        <span>客户世界时间</span>
        <strong id="customerWorldClock">--:--:--</strong>
        <small id="customerWorldDate">当地日期加载中</small>
      </div>
      <div class="customer-time-side">
        <b id="customerWorldStatus">待确认</b>
        <em id="customerWorldZone">UTC</em>
      </div>
    </section>
    <div class="score-card">
      <div class="score-ring"><span>${customer.health}</span></div>
      <div><b>跟进评分：${customer.health >= 80 ? "健康" : customer.health >= 60 ? "需保持" : "需抢救"}</b><p>系统按阶段、健康度、企微状态和下一提醒生成跟进优先级。</p></div>
    </div>
    <div class="info-grid">
      <div class="info"><span>健康度</span><b>${customer.health}%</b></div>
      <div class="info"><span>当前阶段</span><b>${escapeHtml(customer.stage)}</b></div>
      <div class="info"><span>下一提醒</span><b>${escapeHtml(customer.nextReminder)}</b></div>
      <div class="info"><span>企微状态</span><b>${customer.wecomBound ? "已绑定" : "未绑定"}</b></div>
    </div>
    <div class="inline-actions"><button class="btn primary" data-add-follow>新增跟进记录</button><button class="btn" data-edit-customer-drawer>编辑客户</button></div>
    <section class="customer-doc-info">
      <div class="customer-deals-head"><h3>单据基础信息</h3><button class="btn" data-edit-customer-document-info>维护信息</button></div>
      <div class="info-grid">
        <div class="info"><span>单据抬头</span><b>${escapeHtml(billingName)}</b></div>
        <div class="info"><span>单据联系人</span><b>${escapeHtml(documentContact)}</b></div>
        <div class="info"><span>目的港</span><b>${escapeHtml(portDischarge)}</b></div>
        <div class="info"><span>贸易条款</span><b>${escapeHtml(incoterm)}</b></div>
      </div>
      <div class="timeline-item"><b>账单地址</b><span>${escapeHtml(billingAddress)}</span></div>
      <div class="timeline-item"><b>付款条款</b><span>${escapeHtml(paymentTerm)}</span></div>
    </section>
    <div class="timeline">
      <div class="timeline-item"><b>企微摘要</b><span>${customer.wecomBound ? "客户已绑定企微，可归档会话摘要。" : "客户暂未绑定企微，建议补充联系方式。"}</span></div>
      <div class="timeline-item"><b>系统提醒</b><span>${escapeHtml(customer.nextReminder)}</span></div>
      <div class="timeline-item"><b>客户阶段</b><span>${escapeHtml(customer.stage)} · ${customer.health}% 健康度</span></div>
    </div>
    ${renderCustomerDealProgress(customer)}
  `;
  if (customerClockTimer) window.clearInterval(customerClockTimer);
  renderCustomerWorldClock(customer);
  customerClockTimer = window.setInterval(() => renderCustomerWorldClock(customer), 1000);
  qs<HTMLButtonElement>("[data-add-follow]", drawer)?.addEventListener("click", () => addFollowRecord(customer));
  qsa<HTMLButtonElement>("[data-edit-customer-drawer]", drawer).forEach((button) => {
    button.addEventListener("click", () => openCustomerModal(customer));
  });
  qsa<HTMLButtonElement>("[data-edit-customer-document-info]", drawer).forEach((button) => {
    button.addEventListener("click", () => openCustomerModal(customer));
  });
  qs<HTMLButtonElement>("[data-view-related-deals]", drawer)?.addEventListener("click", () => activateNavView("pipeline"));
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
  const activeDeals = deals.filter((deal) => !deal.archivedAt);
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交"];
  strip.innerHTML = stages.map((stage) => {
    const stageDeals = activeDeals.filter((deal) => deal.stage === stage);
    return `<div class="stage"><div class="stage-head"><span>${stage}</span><b>${stageDeals.length}</b></div>${stageDeals.map((deal) => {
      const isWon = deal.stage === "成交";
      const product = deal.product?.trim() || "产品待维护";
      const quantity = Number(deal.quantity || 0);
      const unitPrice = Number(deal.unitPrice || 0);
      return `<div class="deal" data-deal-id="${escapeHtml(deal.id)}"><b>${escapeHtml(deal.title)}</b><span class="deal-product">${escapeHtml(product)} · ${quantity || "-"} 件 × ${money(unitPrice)}</span><span>${escapeHtml(deal.nextAction)}</span><div class="deal-foot"><span>${money(deal.amount)}</span>${badge(deal.stage, isWon ? "green" : deal.stage === "已报价" ? "red" : "")}</div><div class="deal-actions"><button class="btn" data-edit-deal>编辑</button><button class="btn primary" data-print-deal-document>${isWon ? "打印CI" : "打印PI"}</button>${isWon ? `<button class="btn" data-archive-deal>归档</button>` : `<button class="btn danger" data-lost-deal>丢单</button><button class="btn" data-move-deal>推进阶段</button>`}</div></div>`;
    }).join("") || `<div class="deal"><b>暂无商机</b><span>等待新线索进入</span><div class="deal-foot"><span>$0k</span><span>空</span></div></div>`}</div>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-edit-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.closest<HTMLElement>(".deal")?.dataset.dealId || "";
      const deal = state.deals.find((item) => item.id === id);
      if (deal) openDealModal(deal);
    });
  });
  qsa<HTMLButtonElement>("[data-print-deal-document]", strip).forEach((button) => {
    button.addEventListener("click", () => void printDealDocument(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  qsa<HTMLButtonElement>("[data-move-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => void moveDeal(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  qsa<HTMLButtonElement>("[data-archive-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => void archiveDeal(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  qsa<HTMLButtonElement>("[data-lost-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => void markDealLost(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
  renderArchivedDeals(deals);
}

function tradeDocumentFromDeal(deal: Deal, customer: Customer): TradeDocument {
  const type: "PI" | "CI" = deal.stage === "成交" ? "CI" : "PI";
  const date = todayDateInput();
  const quantity = Math.max(1, Math.round(Number(deal.quantity || 0)));
  const unitPrice = Number(deal.unitPrice || 0) || Number(deal.amount || 0) / quantity;
  const product = deal.product?.trim() || deal.title;
  return {
    id: "__new__",
    type,
    title: `${customer.company} ${product} ${type}`,
    number: `${type}-${date.replace(/-/g, "")}-${Math.floor(Date.now() / 1000).toString().slice(-4)}`,
    issueDate: date,
    buyer: customer.billingName?.trim() || customer.company,
    buyerAddress: customer.billingAddress?.trim() || `${customer.country} / address to be confirmed`,
    buyerContact: customer.documentContact?.trim() || customer.contact,
    seller: "GoodJob Instrument Co., Ltd.",
    sellerAddress: "Tianjin, China",
    currency: "USD",
    incoterm: customer.defaultIncoterm?.trim() || "FOB Tianjin",
    paymentTerm: customer.defaultPaymentTerm?.trim() || "30% T/T deposit, 70% before shipment",
    shippingMethod: "Sea freight",
    portLoading: "Tianjin, China",
    portDischarge: customer.defaultPortDischarge?.trim() || "",
    validityDate: "",
    bankInfo: "Beneficiary: GoodJob Instrument Co., Ltd. / Bank: Bank of China Tianjin Branch / SWIFT: BKCHCNBJ",
    notes: `Generated from deal: ${deal.title}. ${deal.nextAction}`,
    templateStyle: "executive",
    status: "ready",
    updatedAt: new Date().toISOString(),
    items: [{
      id: `deal_item_${deal.id}`,
      product,
      model: "",
      hsCode: "",
      quantity,
      unit: "PCS",
      unitPrice: Math.round(unitPrice * 100) / 100,
      originCountry: "China",
      weightKg: 0,
      packageCount: 0
    }]
  };
}

async function printDealDocument(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const customer = state.customers.find((item) => item.id === deal.customerId);
  if (!customer) {
    toast("请先给商机关联客户，再一键打印", "error");
    return;
  }
  const draft = tradeDocumentFromDeal(deal, customer);
  const created = await api<{ document: TradeDocument }>("/api/trade-documents", {
    method: "POST",
    body: JSON.stringify(draft)
  });
  state.tradeDocuments = [created.document, ...state.tradeDocuments.filter((document) => document.id !== created.document.id)];
  state.selectedDocumentId = created.document.id;
  activateNavView("documents");
  renderTradeDocuments(state.tradeDocuments);
  const exported = await api<{ document: TradeDocument; job: ImportExportJob; fileName: string }>(`/api/trade-documents/${created.document.id}/export`, { method: "POST" });
  state.tradeDocuments = state.tradeDocuments.map((document) => document.id === exported.document.id ? exported.document : document);
  state.jobs.unshift(exported.job);
  state.selectedDocumentId = exported.document.id;
  renderTradeDocuments(state.tradeDocuments);
  renderJobs(state.jobs);
  toast(`已按客户资料生成并打印：${exported.fileName}`);
  printDocumentPreview();
}

async function moveDeal(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交"] as const;
  const nextStage = stages[Math.min(stages.indexOf(deal.stage as typeof stages[number]) + 1, stages.length - 1)];
  if (deal.stage === "成交") {
    await archiveDeal(id);
    return;
  }
  const result = await api<{ deal: Deal }>(`/api/deals/${id}/stage`, {
    method: "PATCH",
    body: JSON.stringify({ stage: nextStage })
  });
  Object.assign(deal, result.deal);
  renderPipeline(state.deals);
  void refreshDashboardOnly();
  toast(`商机已推进到：${nextStage}`);
}

async function archiveDeal(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const result = await api<{ deal: Deal }>(`/api/deals/${id}/archive`, { method: "POST" });
  Object.assign(deal, result.deal);
  renderPipeline(state.deals);
  void refreshDashboardOnly();
  toast("商机已归档，可在已归档商机中查询");
}

async function markDealLost(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  if (!window.confirm(`确认将「${deal.title}」标记为丢单？`)) return;
  const result = await api<{ deal: Deal }>(`/api/deals/${id}/lost`, { method: "POST" });
  Object.assign(deal, result.deal);
  renderPipeline(state.deals);
  void refreshDashboardOnly();
  toast("商机已标记丢单，可在归档/丢单商机中查询");
}

function formatDateTime(value?: string) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderArchivedDeals(deals: Deal[]) {
  const box = qs<HTMLElement>("#pipeline-archived-deals");
  if (!box) return;
  const archived = deals.filter((deal) => deal.archivedAt).sort((a, b) => new Date(b.archivedAt || 0).getTime() - new Date(a.archivedAt || 0).getTime());
  box.innerHTML = archived.length ? archived.map((deal) => {
    const customer = state.customers.find((item) => item.id === deal.customerId);
    const product = `${deal.product?.trim() || "产品待维护"} · ${Number(deal.quantity || 0) || "-"} 件 × ${money(Number(deal.unitPrice || 0))}`;
    return `<tr><td><b>${escapeHtml(deal.title)}</b><span>${escapeHtml(customer?.company || "无关联客户")} · ${escapeHtml(product)}</span></td><td>${money(deal.amount)}</td><td>${badge(deal.stage, deal.stage === "丢单" ? "red" : "green")}</td><td>${escapeHtml(formatDateTime(deal.archivedAt))}</td><td>${escapeHtml(deal.nextAction)}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="empty-cell">暂无归档/丢单商机。成交后点“归档”，未成交失败点“丢单”，都会沉淀到这里查询。</td></tr>`;
}

function openDealModal(editing?: Deal) {
  const defaultCustomer = editing?.customerId ? state.customers.find((item) => item.id === editing.customerId) : state.customers[0];
  const title = editing?.title || `${defaultCustomer?.company || "新客户"} 采购机会`;
  const storedQuantity = Number(editing?.quantity || 0);
  const storedUnitPrice = Number(editing?.unitPrice || 0);
  const quantity = editing && !storedQuantity && !storedUnitPrice && editing.amount ? 1 : storedQuantity;
  const unitPrice = editing && !storedQuantity && !storedUnitPrice && editing.amount ? Number(editing.amount) : storedUnitPrice;
  const computedAmount = editing ? Number(editing.amount || quantity * unitPrice) : 18000;
  openModal(editing ? "编辑商机" : "新增商机", `
    <div class="form-grid">
      <input id="dealIdInput" type="hidden" value="${escapeHtml(editing?.id || "")}">
      <div class="form-field full"><label>商机名称</label><input id="dealTitleInput" value="${escapeHtml(title)}"></div>
      <div class="form-field deal-customer-field">
        <label>关联客户</label>
        <input id="dealCustomerInput" value="${escapeHtml(defaultCustomer?.company || "")}" placeholder="输入客户名称过滤，留空则不关联" autocomplete="off">
        <input id="dealCustomerIdInput" type="hidden" value="${escapeHtml(defaultCustomer?.id || "")}">
        <button class="deal-customer-clear" id="clearDealCustomerButton" type="button" title="清空关联客户">×</button>
        <div class="deal-customer-options" id="dealCustomerOptions"></div>
      </div>
      <div class="form-field"><label>阶段</label><select id="dealStageInput">${["询盘", "已联系", "已报价", "样品", "谈判", "成交"].map((stage) => `<option ${stage === editing?.stage ? "selected" : ""}>${stage}</option>`).join("")}</select></div>
      <div class="form-field full"><label>产品</label><input id="dealProductInput" value="${escapeHtml(editing?.product || "")}" placeholder="例如：压力变送器 PT-2088"></div>
      <div class="form-field"><label>数量</label><input id="dealQuantityInput" type="number" min="0" step="1" value="${quantity || 30}"></div>
      <div class="form-field"><label>单价</label><input id="dealUnitPriceInput" type="number" min="0" step="0.01" value="${unitPrice || 600}"></div>
      <div class="form-field"><label>金额</label><input id="dealAmountInput" type="number" value="${computedAmount}" readonly></div>
      <div class="form-field full"><label>下一步动作</label><input id="dealNextActionInput" value="${escapeHtml(editing?.nextAction || "确认采购清单并安排报价")}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveDealButton">${editing ? "保存修改" : "保存商机"}</button>`);
  bindDealCustomerPicker();
  bindDealAmountCalculator();
  qs("#saveDealButton")?.addEventListener("click", () => void saveDeal());
}

function bindDealAmountCalculator() {
  const quantity = qs<HTMLInputElement>("#dealQuantityInput");
  const unitPrice = qs<HTMLInputElement>("#dealUnitPriceInput");
  const amount = qs<HTMLInputElement>("#dealAmountInput");
  const update = () => {
    if (!amount) return;
    const next = Number(quantity?.value || 0) * Number(unitPrice?.value || 0);
    amount.value = String(Math.round(next * 100) / 100);
  };
  quantity?.addEventListener("input", update);
  unitPrice?.addEventListener("input", update);
  update();
}

function filteredDealCustomers(keyword: string) {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return state.customers.slice(0, 8);
  return state.customers
    .filter((customer) => `${customer.company} ${customer.contact} ${customer.country}`.toLowerCase().includes(normalized))
    .slice(0, 8);
}

function renderDealCustomerOptions(keyword = "") {
  const box = qs<HTMLElement>("#dealCustomerOptions");
  if (!box) return;
  const customers = filteredDealCustomers(keyword);
  box.innerHTML = customers.length ? customers.map((customer) => `
    <button type="button" data-deal-customer-id="${escapeHtml(customer.id)}">
      <b>${escapeHtml(customer.company)}</b>
      <span>${escapeHtml(customer.contact || "待维护")} · ${escapeHtml(customer.country || "未知国家")}</span>
    </button>
  `).join("") : `<div class="deal-customer-empty">没有匹配客户，可清空后保存为无关联商机</div>`;
  qsa<HTMLButtonElement>("[data-deal-customer-id]", box).forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const customer = state.customers.find((item) => item.id === button.dataset.dealCustomerId);
      if (!customer) return;
      const input = qs<HTMLInputElement>("#dealCustomerInput");
      const idInput = qs<HTMLInputElement>("#dealCustomerIdInput");
      if (input) input.value = customer.company;
      if (idInput) idInput.value = customer.id;
      box.classList.remove("active");
    });
  });
}

function bindDealCustomerPicker() {
  const input = qs<HTMLInputElement>("#dealCustomerInput");
  const idInput = qs<HTMLInputElement>("#dealCustomerIdInput");
  const box = qs<HTMLElement>("#dealCustomerOptions");
  const clear = qs<HTMLButtonElement>("#clearDealCustomerButton");
  if (!input || !idInput || !box) return;
  renderDealCustomerOptions(input.value);
  input.addEventListener("focus", () => {
    renderDealCustomerOptions(input.value);
    box.classList.add("active");
  });
  input.addEventListener("input", () => {
    const exact = state.customers.find((customer) => customer.company.toLowerCase() === input.value.trim().toLowerCase());
    idInput.value = exact?.id || "";
    renderDealCustomerOptions(input.value);
    box.classList.add("active");
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const first = qs<HTMLButtonElement>("[data-deal-customer-id]", box);
      if (first && box.classList.contains("active")) {
        event.preventDefault();
        first.click();
      }
    }
    if (event.key === "Escape") box.classList.remove("active");
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => box.classList.remove("active"), 120);
  });
  clear?.addEventListener("click", () => {
    input.value = "";
    idInput.value = "";
    renderDealCustomerOptions("");
    box.classList.remove("active");
    input.focus();
  });
}

async function saveDeal() {
  const dealId = qs<HTMLInputElement>("#dealIdInput")?.value.trim() || "";
  const title = qs<HTMLInputElement>("#dealTitleInput")?.value.trim() || "";
  const customerText = qs<HTMLInputElement>("#dealCustomerInput")?.value.trim() || "";
  const customerId = qs<HTMLInputElement>("#dealCustomerIdInput")?.value.trim() || "";
  if (!title) {
    toast("请填写商机名称", "error");
    return;
  }
  if (customerText && !customerId) {
    toast("请从下拉列表选择现有客户，或清空关联客户", "error");
    return;
  }
  const quantity = Number(qs<HTMLInputElement>("#dealQuantityInput")?.value || 0);
  const unitPrice = Number(qs<HTMLInputElement>("#dealUnitPriceInput")?.value || 0);
  const result = await api<{ deal: Deal }>(dealId ? `/api/deals/${dealId}` : "/api/deals", {
    method: dealId ? "PATCH" : "POST",
    body: JSON.stringify({
      title,
      customerId,
      stage: qs<HTMLSelectElement>("#dealStageInput")?.value || "询盘",
      product: qs<HTMLInputElement>("#dealProductInput")?.value.trim() || "",
      quantity,
      unitPrice,
      amount: Math.round(quantity * unitPrice * 100) / 100,
      nextAction: qs<HTMLInputElement>("#dealNextActionInput")?.value || "首次跟进"
    })
  });
  const existing = state.deals.find((item) => item.id === result.deal.id);
  if (existing) Object.assign(existing, result.deal);
  else state.deals.unshift(result.deal);
  renderPipeline(state.deals);
  void refreshDashboardOnly();
  closeModal();
  toast(dealId ? "商机已更新" : "商机已新增");
}

function renderReminders(reminders: Reminder[]) {
  const list = qs<HTMLElement>("#reminders .task-list");
  renderTopbarStats();
  if (!list) return;
  const statusText: Record<string, string> = { pending: "待执行", sent: "已执行", done: "已完成" };
  list.innerHTML = reminders.map((reminder) => {
    const priorityTone = reminder.priority === "high" ? "red" : reminder.priority === "medium" ? "amber" : "";
    const accent = reminder.status === "done" ? "green" : reminder.priority === "high" ? "rose" : reminder.status === "sent" ? "brand" : "amber";
    return `<article class="task reminder-rule-card" data-reminder-id="${escapeHtml(reminder.id)}" style="--accent: var(--${accent})">
      <i class="task-line"></i>
      <div>
        <div class="reminder-rule-top"><h3>${escapeHtml(reminder.title)}</h3>${badge(statusText[reminder.status] || reminder.status, reminder.status === "done" ? "green" : reminder.status === "sent" ? "amber" : "")}</div>
        <p>${escapeHtml(reminder.rule)} · ${escapeHtml(reminder.dueAt)} · ${escapeHtml(reminder.channel)}</p>
        <div class="reminder-rule-meta">
          ${badge(reminderRuleTypeText(reminder.ruleType), "")}
          ${badge(reminder.targetStage || "不限阶段", "")}
          ${badge(`${reminder.days ?? 3} 天`, "")}
          ${badge(reminder.priority === "high" ? "高优先级" : reminder.priority === "medium" ? "中优先级" : "普通", priorityTone)}
          ${badge(`命中 ${reminder.generatedCount || 0}`, reminder.generatedCount ? "green" : "gray")}
        </div>
      </div>
      <div class="reminder-rule-actions">
        <button class="btn primary" data-run-reminder ${reminder.status === "done" ? "disabled" : ""}>执行规则</button>
        <button class="btn" data-done-reminder>${reminder.status === "done" ? "已完成" : "完成"}</button>
      </div>
    </article>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-done-reminder]", list).forEach((button) => {
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
  qsa<HTMLButtonElement>("[data-run-reminder]", list).forEach((button) => {
    button.addEventListener("click", () => void runReminderRule(button.closest<HTMLElement>(".task")?.dataset.reminderId || "", button));
  });
}

function reminderRuleTypeText(ruleType = "quote_no_reply") {
  const map: Record<string, string> = {
    quote_no_reply: "报价未回复",
    sample_feedback: "样品反馈",
    inactive_customer: "长期未联系",
    high_value_revisit: "高价值复访",
    custom_due: "自定义日期"
  };
  return map[ruleType] || "自定义规则";
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
      <div class="form-field full"><label>规则模板</label><select id="reminderRuleTypeInput"><option value="quote_no_reply">报价后未回复</option><option value="sample_feedback">样品签收后待反馈</option><option value="inactive_customer">长期未联系客户</option><option value="high_value_revisit">高价值客户复访</option><option value="custom_due">自定义阶段提醒</option></select></div>
      <div class="form-field full"><label>提醒名称</label><input id="reminderTitleInput" data-auto-title="true" value="报价后未回复提醒"></div>
      <div class="form-field"><label>适用阶段</label><select id="reminderStageInput"><option>已报价</option><option>样品</option><option>谈判</option><option>询盘</option><option>已联系</option><option>成交</option></select></div>
      <div class="form-field"><label>触发天数</label><input id="reminderDaysInput" type="number" min="0" max="90" value="3"></div>
      <div class="form-field"><label>提醒时间</label><input id="reminderDueInput" value="今天 18:00"></div>
      <div class="form-field"><label>渠道</label><select id="reminderChannelInput"><option>企业微信</option><option>站内</option><option>邮件</option></select></div>
      <div class="form-field"><label>优先级</label><select id="reminderPriorityInput"><option value="high">高优先级</option><option value="medium" selected>中优先级</option><option value="normal">普通</option></select></div>
      <label class="form-field"><span>规则状态</span><select id="reminderEnabledInput"><option value="true">启用</option><option value="false">停用</option></select></label>
      <div class="form-field full"><label>规则说明</label><input id="reminderRuleInput" value="已报价阶段客户报价后 3 天未回复，通过企业微信提醒"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReminderButton">保存规则</button>`);
  bindReminderRulePreset();
  qs("#saveReminderButton")?.addEventListener("click", () => void saveReminder());
}

function reminderRulePreset(type: string) {
  if (type === "sample_feedback") {
    return { title: "样品反馈提醒", stage: "样品", days: "3" };
  }
  if (type === "inactive_customer") {
    return { title: "长期未联系提醒", days: "14" };
  }
  if (type === "high_value_revisit") {
    return { title: "高价值客户复访", days: "7" };
  }
  if (type === "custom_due") {
    return { title: "自定义阶段提醒" };
  }
  return { title: "报价后未回复提醒", stage: "已报价", days: "3" };
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
  const channel = qs<HTMLSelectElement>("#reminderChannelInput")?.value || "企业微信";
  const stage = qs<HTMLSelectElement>("#reminderStageInput")?.value || "已报价";
  const days = qs<HTMLInputElement>("#reminderDaysInput")?.value || "3";
  if (ruleInput) ruleInput.value = `${stage}阶段客户 ${days} 天未推进，通过${channel}提醒`;
}

function bindReminderRulePreset() {
  qs<HTMLInputElement>("#reminderTitleInput")?.addEventListener("input", (event) => {
    (event.currentTarget as HTMLInputElement).dataset.autoTitle = "false";
  });
  qs<HTMLElement>("#reminderRuleTypeInput")?.addEventListener("change", () => reminderRuleDraft(true));
  ["#reminderStageInput", "#reminderDaysInput", "#reminderChannelInput"].forEach((selector) => {
    qs<HTMLElement>(selector)?.addEventListener("change", () => reminderRuleDraft());
    qs<HTMLElement>(selector)?.addEventListener("input", () => reminderRuleDraft());
  });
  reminderRuleDraft(true);
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
      channel: qs<HTMLSelectElement>("#reminderChannelInput")?.value || "企业微信",
      ruleType: qs<HTMLSelectElement>("#reminderRuleTypeInput")?.value || "quote_no_reply",
      targetStage: qs<HTMLSelectElement>("#reminderStageInput")?.value || "已报价",
      days: Number(qs<HTMLInputElement>("#reminderDaysInput")?.value || 3),
      priority: qs<HTMLSelectElement>("#reminderPriorityInput")?.value || "medium",
      enabled: qs<HTMLSelectElement>("#reminderEnabledInput")?.value !== "false"
    })
  });
  state.reminders.unshift(result.reminder);
  renderReminders(state.reminders);
  closeModal();
  toast("提醒规则已保存：在本页执行规则后，会生成到工作台/待办清单");
}

async function runReminderRule(id: string, button?: HTMLButtonElement) {
  if (!id) return;
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "执行中";
    }
    const result = await api<{ reminder: Reminder; createdCount: number; matchedCount: number }>(`/api/reminders/${id}/run`, { method: "POST" });
    state.reminders = state.reminders.map((reminder) => reminder.id === result.reminder.id ? result.reminder : reminder);
    const todos = await api<{ todos: Todo[] }>("/api/todos");
    state.todos = todos.todos;
    renderReminders(state.reminders);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    renderTopbarStats();
    toast(`规则已执行：命中 ${result.matchedCount}，生成 ${result.createdCount} 条待办，可到工作台/待办清单查看`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "执行提醒规则失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "执行规则";
    }
  }
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
  tbody.innerHTML = jobs.length ? jobs.map((job) => `<tr><td>${escapeHtml(job.name)}</td><td>${job.type === "import" ? "导入" : "导出"}</td><td>${job.rows.toLocaleString("en-US")} 行</td><td>${badge(job.status === "done" ? "完成" : job.status === "failed" ? "失败" : "待审批", job.status === "done" ? "green" : job.status === "failed" ? "red" : "amber")}</td><td>当前账号</td><td>${escapeHtml(job.createdAt)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty-cell">暂无导入导出任务</td></tr>`;
}

function documentStatusText(status: string) {
  const map: Record<string, string> = { draft: "草稿", ready: "已配置", exported: "已导出" };
  return map[status] || "草稿";
}

function documentTotal(document: TradeDocument) {
  return document.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
}

function formatDocumentMoney(value: number, currency = "USD") {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDocumentTableMoney(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayDateInput() {
  return new Date().toISOString().slice(0, 10);
}

function defaultTradeDocument(type: "PI" | "CI" = "PI"): TradeDocument {
  const date = todayDateInput();
  return {
    id: "__new__",
    type,
    title: type === "PI" ? "新建形式发票 PI" : "新建商业发票 CI",
    number: `${type}-${date.replace(/-/g, "")}-${Math.floor(Date.now() / 1000).toString().slice(-4)}`,
    issueDate: date,
    buyer: state.customers[0]?.company || "Buyer Company",
    buyerAddress: state.customers[0] ? `${state.customers[0].country} / address to be confirmed` : "",
    buyerContact: state.customers[0]?.contact || "",
    seller: "GoodJob Instrument Co., Ltd.",
    sellerAddress: "Tianjin, China",
    currency: "USD",
    incoterm: "FOB Tianjin",
    paymentTerm: "30% T/T deposit, 70% before shipment",
    shippingMethod: "Sea freight",
    portLoading: "Tianjin, China",
    portDischarge: "",
    validityDate: "",
    bankInfo: "Beneficiary: GoodJob Instrument Co., Ltd. / Bank: Bank of China Tianjin Branch / SWIFT: BKCHCNBJ",
    notes: type === "PI" ? "Lead time starts after deposit and technical confirmation." : "The goods are of China origin and packed for export shipment.",
    templateStyle: "executive",
    status: "draft",
    updatedAt: new Date().toISOString(),
    items: [
      { id: "new_item_1", product: "Smart Pressure Transmitter", model: "GJ-PT3051", hsCode: "902620", quantity: 10, unit: "PCS", unitPrice: 185, originCountry: "China", weightKg: 16, packageCount: 1 }
    ]
  };
}

function activeTradeDocument() {
  return state.tradeDocuments.find((document) => document.id === state.selectedDocumentId) || state.tradeDocuments[0] || defaultTradeDocument();
}

function renderTradeDocuments(documents: TradeDocument[]) {
  const list = qs<HTMLElement>("#documentList");
  if (!list) return;
  const active = documents.find((document) => document.id === state.selectedDocumentId) || documents[0] || defaultTradeDocument();
  state.selectedDocumentId = active.id;
  list.innerHTML = `
    <div class="section-title"><h2>单据列表</h2><span>${documents.length} 份</span></div>
    ${documents.length ? documents.map((document) => `
      <article class="doc-list-card ${document.id === active.id ? "active" : ""}" data-document-id="${escapeHtml(document.id)}">
        <b>${escapeHtml(document.title)}</b>
        <span>${escapeHtml(document.number)} · ${document.type}</span>
        <small>${documentStatusText(document.status)} · ${formatDocumentMoney(documentTotal(document), document.currency)}</small>
      </article>
    `).join("") : `<div class="empty-cell">暂无单据，点击新建单据开始。</div>`}
  `;
  qsa<HTMLElement>("[data-document-id]", list).forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedDocumentId = card.dataset.documentId || null;
      renderTradeDocuments(state.tradeDocuments);
    });
  });
  fillDocumentEditor(active);
}

function fillDocumentEditor(document: TradeDocument) {
  setDocumentType(document.type);
  const values: Record<string, string> = {
    docTitleInput: document.title,
    docNumberInput: document.number,
    docIssueDateInput: document.issueDate,
    docTemplateInput: document.templateStyle,
    docBuyerInput: document.buyer,
    docBuyerContactInput: document.buyerContact,
    docBuyerAddressInput: document.buyerAddress,
    docSellerInput: document.seller,
    docCurrencyInput: document.currency,
    docSellerAddressInput: document.sellerAddress,
    docIncotermInput: document.incoterm,
    docShippingInput: document.shippingMethod,
    docPortLoadingInput: document.portLoading,
    docPortDischargeInput: document.portDischarge,
    docValidityInput: document.validityDate,
    docPaymentInput: document.paymentTerm,
    docBankInput: document.bankInfo,
    docNotesInput: document.notes
  };
  Object.entries(values).forEach(([id, value]) => {
    const input = qs<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`);
    if (input) input.value = value || "";
  });
  renderDocumentItems(document.items);
  renderDocumentPreview(collectDocumentDraft());
}

function setDocumentType(type: "PI" | "CI") {
  qsa<HTMLButtonElement>("#documentTypeTabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.docType === type);
  });
}

function currentDocumentType(): "PI" | "CI" {
  return qs<HTMLButtonElement>("#documentTypeTabs button.active")?.dataset.docType === "CI" ? "CI" : "PI";
}

function renderDocumentItems(items: TradeDocumentItem[]) {
  const box = qs<HTMLElement>("#documentItemsEditor");
  if (!box) return;
  box.innerHTML = items.map((item, index) => `
    <div class="doc-item-grid" data-doc-item="${escapeHtml(item.id || `item_${index}`)}">
      <label data-doc-size="name"><span>品名</span><input data-doc-field="product" value="${escapeHtml(item.product)}"></label>
      <label><span>型号</span><input data-doc-field="model" value="${escapeHtml(item.model)}"></label>
      <label><span>HS Code</span><input data-doc-field="hsCode" value="${escapeHtml(item.hsCode)}"></label>
      <label data-doc-size="short"><span>数量</span><input data-doc-field="quantity" type="number" min="0" value="${item.quantity}"></label>
      <label data-doc-size="short"><span>单位</span><input data-doc-field="unit" value="${escapeHtml(item.unit)}"></label>
      <label data-doc-size="price"><span>单价</span><input data-doc-field="unitPrice" type="number" min="0" step="0.01" value="${item.unitPrice}"></label>
      <label><span>原产国</span><input data-doc-field="originCountry" value="${escapeHtml(item.originCountry)}"></label>
      <label data-doc-size="short"><span>重量kg</span><input data-doc-field="weightKg" type="number" min="0" step="0.01" value="${item.weightKg}"></label>
      <label data-doc-size="short"><span>包装</span><input data-doc-field="packageCount" type="number" min="0" value="${item.packageCount}"></label>
      <button class="doc-item-remove" type="button" title="删除明细">×</button>
    </div>
  `).join("");
  qsa<HTMLInputElement>("[data-doc-field]", box).forEach((input) => input.addEventListener("input", () => renderDocumentPreview(collectDocumentDraft())));
  qsa<HTMLButtonElement>(".doc-item-remove", box).forEach((button) => {
    button.addEventListener("click", () => {
      button.closest(".doc-item-grid")?.remove();
      if (!qsa(".doc-item-grid", box).length) addDocumentItem();
      renderDocumentPreview(collectDocumentDraft());
    });
  });
}

function collectDocumentItems(): TradeDocumentItem[] {
  return qsa<HTMLElement>("#documentItemsEditor .doc-item-grid").map((row, index) => {
    const field = (name: string) => row.querySelector<HTMLInputElement>(`[data-doc-field="${name}"]`)?.value.trim() || "";
    const numberField = (name: string) => Number(row.querySelector<HTMLInputElement>(`[data-doc-field="${name}"]`)?.value || 0);
    return {
      id: row.dataset.docItem || `item_${index}`,
      product: field("product") || "Product",
      model: field("model"),
      hsCode: field("hsCode"),
      quantity: numberField("quantity"),
      unit: field("unit") || "PCS",
      unitPrice: numberField("unitPrice"),
      originCountry: field("originCountry") || "China",
      weightKg: numberField("weightKg"),
      packageCount: Math.round(numberField("packageCount"))
    };
  });
}

function collectDocumentDraft(): TradeDocument {
  const existing = state.tradeDocuments.find((document) => document.id === state.selectedDocumentId);
  return {
    id: existing?.id || state.selectedDocumentId || "__new__",
    type: currentDocumentType(),
    title: qs<HTMLInputElement>("#docTitleInput")?.value.trim() || "未命名单据",
    number: qs<HTMLInputElement>("#docNumberInput")?.value.trim() || `DOC-${Date.now()}`,
    issueDate: qs<HTMLInputElement>("#docIssueDateInput")?.value || todayDateInput(),
    buyer: qs<HTMLInputElement>("#docBuyerInput")?.value.trim() || "Buyer Company",
    buyerAddress: qs<HTMLInputElement>("#docBuyerAddressInput")?.value.trim() || "",
    buyerContact: qs<HTMLInputElement>("#docBuyerContactInput")?.value.trim() || "",
    seller: qs<HTMLInputElement>("#docSellerInput")?.value.trim() || "GoodJob Instrument Co., Ltd.",
    sellerAddress: qs<HTMLInputElement>("#docSellerAddressInput")?.value.trim() || "",
    currency: qs<HTMLSelectElement>("#docCurrencyInput")?.value || "USD",
    incoterm: qs<HTMLSelectElement>("#docIncotermInput")?.value || "FOB Tianjin",
    paymentTerm: qs<HTMLInputElement>("#docPaymentInput")?.value.trim() || "",
    shippingMethod: qs<HTMLSelectElement>("#docShippingInput")?.value || "Sea freight",
    portLoading: qs<HTMLInputElement>("#docPortLoadingInput")?.value.trim() || "",
    portDischarge: qs<HTMLInputElement>("#docPortDischargeInput")?.value.trim() || "",
    validityDate: qs<HTMLInputElement>("#docValidityInput")?.value || "",
    bankInfo: qs<HTMLTextAreaElement>("#docBankInput")?.value.trim() || "",
    notes: qs<HTMLTextAreaElement>("#docNotesInput")?.value.trim() || "",
    templateStyle: (qs<HTMLSelectElement>("#docTemplateInput")?.value as TradeDocument["templateStyle"]) || "executive",
    status: existing?.status || "draft",
    updatedAt: new Date().toISOString(),
    items: collectDocumentItems()
  };
}

function renderDocumentPreview(document: TradeDocument) {
  const preview = qs<HTMLElement>("#documentPreview");
  if (!preview) return;
  const total = documentTotal(document);
  const title = document.type === "PI" ? "PROFORMA INVOICE" : "COMMERCIAL INVOICE";
  const status = document.type === "PI" ? "Quotation confirmation" : "Customs / shipment document";
  preview.className = `doc-paper ${document.templateStyle}`;
  preview.innerHTML = `
    <div class="doc-print-head">
      <div class="doc-letterhead">
        <div class="doc-logo-mark">GJ</div>
        <div>
          <b>${escapeHtml(document.seller)}</b>
          <small>${escapeHtml(document.sellerAddress || "Tianjin, China")}<br>Export Documentation Center</small>
        </div>
      </div>
      <div class="doc-number-box">
        <p><b>No.</b> ${escapeHtml(document.number)}</p>
        <p><b>Date</b> ${escapeHtml(document.issueDate)}</p>
        <p><b>Currency</b> ${escapeHtml(document.currency)}</p>
      </div>
    </div>
    <div class="doc-title-band">
      <h2>${title}</h2>
      <p>${escapeHtml(status)} · ${escapeHtml(document.title)}</p>
    </div>
    <div class="doc-print-grid">
      <div class="doc-block"><h3>Seller</h3><p><b>${escapeHtml(document.seller)}</b></p><p>${escapeHtml(document.sellerAddress)}</p></div>
      <div class="doc-block"><h3>Buyer</h3><p><b>${escapeHtml(document.buyer)}</b></p><p>${escapeHtml(document.buyerAddress)}</p><p>${escapeHtml(document.buyerContact)}</p></div>
    </div>
    <div class="doc-terms">
      <div class="doc-term"><span>Incoterm</span><b>${escapeHtml(document.incoterm)}</b></div>
      <div class="doc-term"><span>Payment</span><b>${escapeHtml(document.paymentTerm)}</b></div>
      <div class="doc-term"><span>Shipment</span><b>${escapeHtml(document.shippingMethod)}</b></div>
      <div class="doc-term"><span>Validity</span><b>${escapeHtml(document.validityDate || "To be confirmed")}</b></div>
      <div class="doc-term"><span>Port of Loading</span><b>${escapeHtml(document.portLoading)}</b></div>
      <div class="doc-term"><span>Port of Discharge</span><b>${escapeHtml(document.portDischarge || "To be confirmed")}</b></div>
      <div class="doc-term"><span>Document Type</span><b>${document.type}</b></div>
      <div class="doc-term"><span>Status</span><b>${documentStatusText(document.status)}</b></div>
    </div>
    <table class="doc-items-table ${document.type === "CI" ? "ci" : "pi"}">
      <thead><tr><th>#</th><th>Description</th><th>Model</th><th>HS Code</th><th>Qty</th><th>Unit Price</th><th>Amount</th>${document.type === "CI" ? "<th>Origin</th><th>Weight</th><th>Pkgs</th>" : ""}</tr></thead>
      <tbody>${document.items.map((item, index) => `
        <tr>
          <td class="doc-num">${index + 1}</td>
          <td class="doc-desc">${escapeHtml(item.product)}</td>
          <td>${escapeHtml(item.model)}</td>
          <td>${escapeHtml(item.hsCode)}</td>
          <td class="doc-qty">${item.quantity} ${escapeHtml(item.unit)}</td>
          <td class="doc-money">${formatDocumentTableMoney(item.unitPrice)}</td>
          <td class="doc-money">${formatDocumentTableMoney(item.quantity * item.unitPrice)}</td>
          ${document.type === "CI" ? `<td class="doc-origin">${escapeHtml(item.originCountry)}</td><td class="doc-weight">${item.weightKg} kg</td><td class="doc-pkgs">${item.packageCount}</td>` : ""}
        </tr>
      `).join("")}</tbody>
    </table>
    <div class="doc-total"><span>Total Amount</span><b>${formatDocumentMoney(total, document.currency)}</b></div>
    <div class="doc-sign">
      <div class="doc-block"><h3>Bank / Notes</h3><p>${escapeHtml(document.bankInfo)}</p><p>${escapeHtml(document.notes)}</p></div>
      <div class="doc-stamp">AUTHORIZED</div>
    </div>
  `;
  const meta = qs<HTMLElement>("#docPreviewMeta");
  if (meta) meta.textContent = `${document.type} · ${document.number} · ${formatDocumentMoney(total, document.currency)}`;
}

function addDocumentItem() {
  const draft = collectDocumentDraft();
  draft.items.push({ id: `item_${Date.now()}`, product: "", model: "", hsCode: "", quantity: 1, unit: "PCS", unitPrice: 0, originCountry: "China", weightKg: 0, packageCount: 0 });
  renderDocumentItems(draft.items);
  renderDocumentPreview(draft);
}

function openNewDocument() {
  state.selectedDocumentId = "__new__";
  fillDocumentEditor(defaultTradeDocument());
  qsa<HTMLElement>(".doc-list-card").forEach((card) => card.classList.remove("active"));
  toast("已创建单据草稿，保存后写入数据库");
}

async function saveTradeDocument() {
  const draft = collectDocumentDraft();
  if (!draft.items.length) {
    toast("请至少保留一条商品明细", "error");
    return null;
  }
  const existing = state.tradeDocuments.find((document) => document.id === state.selectedDocumentId);
  const result = await api<{ document: TradeDocument }>(existing ? `/api/trade-documents/${existing.id}` : "/api/trade-documents", {
    method: existing ? "PATCH" : "POST",
    body: JSON.stringify({ ...draft, status: draft.status === "exported" ? "ready" : "ready" })
  });
  state.tradeDocuments = existing
    ? state.tradeDocuments.map((document) => document.id === result.document.id ? result.document : document)
    : [result.document, ...state.tradeDocuments];
  state.selectedDocumentId = result.document.id;
  renderTradeDocuments(state.tradeDocuments);
  toast("单据配置已保存到数据库");
  return result.document;
}

async function exportTradeDocumentPdf() {
  const saved = await saveTradeDocument();
  if (!saved) return;
  const result = await api<{ document: TradeDocument; job: ImportExportJob; fileName: string }>(`/api/trade-documents/${saved.id}/export`, { method: "POST" });
  state.tradeDocuments = state.tradeDocuments.map((document) => document.id === result.document.id ? result.document : document);
  state.jobs.unshift(result.job);
  renderTradeDocuments(state.tradeDocuments);
  renderJobs(state.jobs);
  toast(`已生成 PDF 导出任务：${result.fileName}`);
  printDocumentPreview();
}

function printDocumentPreview() {
  const preview = qs<HTMLElement>("#documentPreview");
  if (!preview) {
    window.print();
    return;
  }
  qs<HTMLElement>(".print-only-document")?.remove();
  const clone = preview.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.className = `${preview.className} print-only-document`;
  document.body.appendChild(clone);
  const cleanup = () => {
    clone.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
  window.setTimeout(cleanup, 30000);
}

function parseNumberCell(value: unknown, fallback = 0) {
  const text = String(value ?? "").replace(/[,$￥¥\s]/g, "");
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function parseBooleanCell(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "y", "是", "已绑定", "绑定"].includes(text);
}

async function parseCustomerImportFile(file: File): Promise<CustomerImportRow[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  return rows.map((row) => {
    const company = String(rowValue(row, ["公司名", "客户", "客户名称", "公司", "客户公司", "company", "Company"])).trim();
    return {
      company,
      country: String(rowValue(row, ["国家", "市场", "country", "Country"]) || "未知").trim(),
      contact: String(rowValue(row, ["联系人", "联系人姓名", "contact", "Contact"]) || "待维护").trim(),
      stage: String(rowValue(row, ["阶段", "客户阶段", "stage", "Stage"]) || "询盘").trim(),
      amount: parseNumberCell(rowValue(row, ["预计金额", "金额", "商机金额", "amount", "Amount"])),
      health: Math.max(0, Math.min(100, Math.round(parseNumberCell(rowValue(row, ["健康度", "评分", "health", "Health"]), 70)))),
      nextReminder: String(rowValue(row, ["下一提醒", "提醒", "下次跟进", "nextReminder", "Next Reminder"]) || "待跟进").trim(),
      wecomBound: parseBooleanCell(rowValue(row, ["企微绑定", "企业微信", "企微", "wecomBound", "WeCom"]))
    };
  }).filter((row) => row.company);
}

async function importCustomersFromFile(button?: HTMLButtonElement) {
  const input = qs<HTMLInputElement>("#customerImportInput");
  const file = input?.files?.[0];
  if (!file) {
    toast("请先选择 Excel 或 CSV 客户文件", "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "导入中";
    }
    const rows = await parseCustomerImportFile(file);
    if (!rows.length) {
      toast("未识别到有效客户，请检查公司名表头", "error");
      return;
    }
    const result = await api<{ result: { created: number; updated: number; skipped: number; total: number }; job: ImportExportJob; customers: Customer[] }>("/api/import-export/customers/import", {
      method: "POST",
      body: JSON.stringify({ fileName: file.name, rows })
    });
    state.customers = result.customers;
    state.jobs.unshift(result.job);
    state.selectedCustomerId = result.customers[0]?.id || state.selectedCustomerId;
    renderCustomers(state.customers);
    renderJobs(state.jobs);
    renderTopbarStats();
    void refreshDashboardOnly();
    toast(`导入完成：新增 ${result.result.created}，更新 ${result.result.updated}，共 ${result.result.total} 行`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "客户导入失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "导入客户";
    }
  }
}

async function exportCustomers() {
  try {
    const result = await api<{ customers: Customer[]; job: ImportExportJob }>("/api/import-export/customers/export", { method: "POST" });
    const rows = result.customers.map((customer) => ({
      公司名: customer.company,
      国家: customer.country,
      联系人: customer.contact,
      阶段: customer.stage,
      预计金额: customer.amount,
      健康度: customer.health,
      下一提醒: customer.nextReminder,
      企微绑定: customer.wecomBound ? "已绑定" : "未绑定"
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "客户清单");
    XLSX.writeFile(workbook, `GoodJob客户清单-${Date.now()}.xlsx`);
    state.jobs.unshift(result.job);
    renderJobs(state.jobs);
    toast(`客户已导出：${rows.length} 行`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "客户导出失败", "error");
  }
}

function downloadCustomerTemplate() {
  const worksheet = XLSX.utils.json_to_sheet([
    { 公司名: "Demo Instrument Trading Co., Ltd.", 国家: "德国", 联系人: "Demo Contact", 阶段: "询盘", 预计金额: 12000, 健康度: 70, 下一提醒: "明天 10:00", 企微绑定: "未绑定" }
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "客户导入模板");
  XLSX.writeFile(workbook, "GoodJob客户导入模板.xlsx");
  toast("客户导入模板已下载");
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
  state.selectedExamIds = state.selectedExamIds.filter((id) => exams.some((exam) => exam.id === id));
  const selectedCount = state.selectedExamIds.length;
  const allSelected = exams.length > 0 && selectedCount === exams.length;
  list.innerHTML = exams.length ? `
    <div class="exam-bulk-bar">
      <label class="exam-select-all"><input type="checkbox" data-select-all-exams ${allSelected ? "checked" : ""}>全选</label>
      <span>已选 ${selectedCount} 场</span>
      <button class="btn danger" data-bulk-delete-exams ${selectedCount ? "" : "disabled"}>批量删除</button>
    </div>
    ${exams.map((exam) => {
      const checked = state.selectedExamIds.includes(exam.id);
      return `
        <div class="category-item exam-row ${exam.id === state.selectedExamId ? "selected" : ""} ${checked ? "checked" : ""}" data-exam-id="${escapeHtml(exam.id)}">
          <label class="exam-row-check" title="选择考试"><input type="checkbox" data-select-exam ${checked ? "checked" : ""}></label>
          <div class="exam-row-main"><b>${escapeHtml(exam.title)}</b><span>${exam.questionCount} 题 · ${exam.passScore || 80} 分及格 · ${escapeHtml(exam.category)} · ${examTargetText(exam.targetRole)}</span></div>
          <div class="exam-actions">${badge(examStatusText(exam.status), examStatusTone(exam.status))}<button class="btn" data-start-exam>考试</button><button class="btn" data-question-bank>题库</button><button class="btn" data-publish-exam>发布</button><button class="btn danger" data-delete-exam>删除</button></div>
        </div>`;
    }).join("")}` : `<div class="empty-state"><b>暂无考试</b><span>点击发布考试或分类目考试维护创建第一套题。</span></div>`;
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
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button,input,label")) return;
      state.selectedExamId = row.dataset.examId || null;
      renderExams(state.exams);
    });
  });
  qs<HTMLInputElement>("[data-select-all-exams]", list)?.addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    state.selectedExamIds = checked ? state.exams.map((exam) => exam.id) : [];
    renderExams(state.exams);
  });
  qsa<HTMLInputElement>("[data-select-exam]", list).forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      const id = checkbox.closest<HTMLElement>(".category-item")?.dataset.examId || "";
      if (!id) return;
      state.selectedExamIds = checkbox.checked
        ? Array.from(new Set([...state.selectedExamIds, id]))
        : state.selectedExamIds.filter((selectedId) => selectedId !== id);
      renderExams(state.exams);
    });
  });
  qs<HTMLButtonElement>("[data-bulk-delete-exams]", list)?.addEventListener("click", (event) => {
    event.stopPropagation();
    void bulkDeleteExams();
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
      void openQuestionBankPage(button.closest<HTMLElement>(".category-item")?.dataset.examId || "");
    });
  });
  qsa<HTMLButtonElement>("[data-publish-exam]", list).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void publishExam(button.closest<HTMLElement>(".category-item")?.dataset.examId || "");
    });
  });
  qsa<HTMLButtonElement>("[data-delete-exam]", list).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteExam(button.closest<HTMLElement>(".category-item")?.dataset.examId || "");
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

async function deleteExam(id: string) {
  const exam = state.exams.find((item) => item.id === id);
  if (!exam) return;
  if (!window.confirm(`确认删除「${exam.title}」？删除后会同步清理组卷关系和考试成绩记录。`)) return;
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
  if (!window.confirm(`确认批量删除 ${ids.length} 场考试？\n${titles.slice(0, 5).join("、")}${titles.length > 5 ? "等" : ""}\n删除后会同步清理组卷关系和考试成绩记录。`)) return;
  const button = qs<HTMLButtonElement>("#exam [data-bulk-delete-exams]");
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "删除中";
    }
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
    if (button) {
      button.disabled = false;
      button.textContent = "批量删除";
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

function questionBankCategories() {
  return Array.from(new Set([...state.examQuestions.map((question) => question.category), "产品知识", "认证资料", "报价规则", "仪表产品"])).filter(Boolean);
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
  if (selectedCard) selectedCard.innerHTML = `<span>当前题目</span><b>${selected ? questionTypeText(selected) : "未选择"}</b><small>${selected ? escapeHtml(selected.category) : "点击列表编辑"}</small>`;
}

function renderQuestionBankRows(_questions = state.examQuestions) {
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
    </article>`).join("") : `<div class="empty-state"><b>暂无匹配题目</b><span>可以调整筛选条件，或点击新增题目。</span></div>`;
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
    stem: "客户询问仪表量程时，销售应优先确认哪些参数？",
    category: "仪表产品",
    options: ["量程、精度、接口、工况", "客户公司规模", "包装颜色", "输出信号、供电和防护等级"],
    answerIndex: 0,
    answerIndexes: [0, 3],
    questionType: "multiple",
    tags: ["仪表", "技术参数"],
    explanation: "仪表类产品报价必须先确认量程、精度、接口和实际工况，避免型号匹配错误。",
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

async function openQuestionBankPage(id = "") {
  await ensureExamQuestionsLoaded();
  const exam = state.exams.find((item) => item.id === id);
  const preferred = exam ? state.examQuestions.find((question) => question.category === exam.category) : null;
  state.selectedQuestionId = preferred?.id || state.selectedQuestionId || state.examQuestions[0]?.id || null;
  activateNavView("question-bank");
  renderQuestionBankRows(state.examQuestions);
}

function newQuestionDraft() {
  state.selectedQuestionId = "__new__";
  fillQuestionEditor(undefined);
  renderQuestionBankRows(state.examQuestions);
  qs<HTMLTextAreaElement>("#questionStemInput")?.focus();
}

function parseTags(value: string) {
  return value.split(/[，,、\s]+/).map((item) => item.trim()).filter(Boolean);
}

async function saveQuestion(button?: HTMLButtonElement) {
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
      button.textContent = "导入";
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
  const selected = state.aiDraftMode ? null : (state.aiConfigs.find((item) => item.id === state.selectedAiConfigId) || config || state.aiConfigs[0] || null);
  config = selected;
  if (!state.aiDraftMode) {
    state.selectedAiConfigId = selected?.id || null;
    if (selected) state.aiConfig = selected;
  }
  const name = qs<HTMLInputElement>("#aiConfigName");
  const baseUrl = qs<HTMLInputElement>("#aiBaseUrlInput");
  const model = qs<HTMLInputElement>("#aiModelInput");
  const apiKey = qs<HTMLInputElement>("#aiApiKeyInput");
  const enabled = qs<HTMLInputElement>("#aiEnabledInput");
  const useAi = qs<HTMLInputElement>("#websiteUseAiInput");
  const badgeNode = qs<HTMLElement>("#aiConfigBadge");
  const gptName = qs<HTMLInputElement>("#gptConfigName");
  const gptBaseUrl = qs<HTMLInputElement>("#gptBaseUrlInput");
  const gptModel = qs<HTMLInputElement>("#gptModelInput");
  const gptApiKey = qs<HTMLInputElement>("#gptApiKeyInput");
  const gptEnabled = qs<HTMLSelectElement>("#gptEnabledSelect");
  const providerSelect = qs<HTMLSelectElement>("#gptProviderSelect");
  const protocolSelect = qs<HTMLSelectElement>("#gptProtocolSelect");
  const temperatureInput = qs<HTMLInputElement>("#gptTemperatureInput");
  const gptBadge = qs<HTMLElement>("#gptConfigBadge");
  const gptConnectionBadge = qs<HTMLElement>("#gptConnectionBadge");
  const gptConnectionTitle = qs<HTMLElement>("#gptConnectionTitle");
  const gptConnectionText = qs<HTMLElement>("#gptConnectionText");
  const gptState = qs<HTMLElement>("#gptConfigState");
  const gptSub = qs<HTMLElement>("#gptConfigSub");
  const gptModelState = qs<HTMLElement>("#gptModelState");
  const providerState = qs<HTMLElement>("#gptProviderState");
  const protocolState = qs<HTMLElement>("#gptProtocolState");
  const useState = qs<HTMLElement>("#gptUseState");
  const countText = qs<HTMLElement>("#aiConfigCountText");
  const list = qs<HTMLElement>("#aiConfigList");
  const modeAlert = qs<HTMLElement>("#aiConfigModeAlert");
  const deleteButton = qs<HTMLButtonElement>("#aiDeleteConfigButton");
  const toggleButton = qs<HTMLButtonElement>("#aiToggleEnabledButton");
  const draftMode = state.aiDraftMode;
  const defaultName = "";
  const defaultBaseUrl = "";
  const defaultModel = "";
  const provider = draftMode ? (providerSelect?.value || "openai") : (config?.provider || "openai");
  const preset = aiProviderPresets[provider] || aiProviderPresets.openai;
  const protocol = draftMode ? ((protocolSelect?.value as AiModelConfig["protocol"]) || preset.protocol) : (config?.protocol || preset.protocol);
  const ready = Boolean(config?.enabled && config?.hasApiKey);
  const tested = config?.lastTestStatus === "passed";
  const failed = config?.lastTestStatus === "failed";
  const useFlags = {
    leadFinder: config?.useLeadFinder ?? true,
    websiteParse: config?.useWebsiteParse ?? true,
    scoring: config?.useScoring ?? true,
    emailDraft: config?.useEmailDraft ?? true,
    exam: config?.useExam ?? false
  };
  const useCount = Object.values(useFlags).filter(Boolean).length;
  if (countText) countText.textContent = `${state.aiConfigs.length} 个配置实例`;
  if (list) {
    const draftRow = state.aiDraftMode ? `
      <button class="ai-instance-row active is-draft" type="button" data-ai-draft-row>
        <span><b>未保存的新配置</b><small>填写参数后点击保存，系统会创建独立实例</small></span>
        <em>${badge("新增", "amber")}</em>
      </button>
    ` : "";
    const savedRows = state.aiConfigs.map((item) => {
      const itemPreset = aiProviderPresets[item.provider] || aiProviderPresets.custom;
      const itemUseCount = [item.useLeadFinder, item.useWebsiteParse, item.useScoring, item.useEmailDraft, item.useExam].filter(Boolean).length;
      const active = !state.aiDraftMode && item.id === state.selectedAiConfigId;
      return `
        <button class="ai-instance-row ${active ? "active" : ""}" type="button" data-ai-config-id="${escapeHtml(item.id)}">
          <span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(itemPreset.label)} · ${escapeHtml(item.model)} · ${itemUseCount} 个用途</small></span>
          <em>${badge(item.enabled ? "启用" : "停用", item.enabled ? "green" : "gray")}${badge(item.hasApiKey ? "有Key" : "缺Key", item.hasApiKey ? "green" : "amber")}</em>
        </button>
      `;
    }).join("");
    list.innerHTML = draftRow || savedRows ? `${draftRow}${savedRows}` : `<div class="empty-cell">暂无配置，点击“新增配置”。</div>`;
    qsa<HTMLButtonElement>("#aiConfigList [data-ai-config-id]").forEach((button) => {
      button.addEventListener("click", () => {
        state.aiDraftMode = false;
        state.pendingAiDeleteId = null;
        state.selectedAiConfigId = button.dataset.aiConfigId || null;
        renderAiConfig(state.aiConfigs.find((item) => item.id === state.selectedAiConfigId) || null);
      });
    });
  }
  if (modeAlert) {
    modeAlert.innerHTML = state.pendingAiDeleteId && state.pendingAiDeleteId === config?.id
      ? `<b>确认删除</b><span>将删除“${escapeHtml(config.name)}”，再次点击“确认删除”才会执行。</span>`
      : state.aiDraftMode
      ? `<b>新增配置</b><span>当前内容尚未保存，不会影响已有配置；保存后生成独立实例。</span>`
      : config
        ? `<b>编辑配置</b><span>${escapeHtml(config.name)} · 修改后点击保存，应用范围和启用状态会持久化。</span>`
        : `<b>暂无配置</b><span>点击“新增配置”创建第一套模型参数。</span>`;
  }
  if (deleteButton) {
    deleteButton.disabled = state.aiDraftMode || !config;
    deleteButton.textContent = state.pendingAiDeleteId && state.pendingAiDeleteId === config?.id ? "确认删除" : "删除当前";
  }
  if (toggleButton) {
    toggleButton.disabled = state.aiDraftMode || !config;
    toggleButton.textContent = config?.enabled ? "停用当前" : "启用当前";
  }
  if (name && !draftMode) name.value = config?.name || defaultName;
  if (baseUrl && !draftMode) baseUrl.value = config?.baseUrl || defaultBaseUrl;
  if (model && !draftMode) model.value = config?.model || defaultModel;
  if (apiKey && !draftMode) {
    apiKey.value = config?.apiKey || "";
    apiKey.placeholder = config?.hasApiKey ? "已保存，重新填写可覆盖" : "保存后仅后端持久化";
  }
  if (enabled && !draftMode) enabled.checked = Boolean(config?.enabled);
  if (useAi) useAi.checked = Boolean(config?.enabled && config?.hasApiKey && useFlags.websiteParse);
  if (badgeNode) {
    badgeNode.className = `badge ${ready ? "green" : config?.enabled ? "amber" : ""}`;
    badgeNode.textContent = ready ? `AI已启用 · ${config?.model}` : config?.enabled ? "规则解析 · 缺少API Key" : "规则解析";
  }
  if (gptName && !draftMode) gptName.value = config?.name || defaultName;
  if (gptBaseUrl && !draftMode) gptBaseUrl.value = config?.baseUrl || defaultBaseUrl;
  if (gptModel && !draftMode) gptModel.value = config?.model || defaultModel;
  if (providerSelect && !draftMode) providerSelect.value = provider;
  if (protocolSelect && !draftMode) protocolSelect.value = protocol;
  if (temperatureInput && !draftMode) temperatureInput.value = String(config?.temperature ?? 0.1);
  if (gptApiKey && !draftMode) {
    gptApiKey.value = config?.apiKey || "";
    gptApiKey.placeholder = config?.hasApiKey ? "已保存，重新填写可覆盖" : "保存后仅显示末四位";
  }
  if (gptEnabled && !draftMode) gptEnabled.value = config?.enabled === false ? "false" : "true";
  if (gptBadge) {
    gptBadge.className = `badge ${ready ? "green" : config?.enabled ? "amber" : ""}`;
    gptBadge.textContent = ready ? "当前" : config?.enabled ? "缺Key" : "当前";
  }
  qsa<HTMLElement>("[data-ai-provider]").forEach((card) => {
    const active = card.dataset.aiProvider === provider;
    card.classList.toggle("active", active);
    const badgeNodeInCard = card.querySelector<HTMLElement>(".badge");
    if (badgeNodeInCard) {
      badgeNodeInCard.className = `badge ${active ? "green" : "gray"}`;
      badgeNodeInCard.textContent = active ? "当前" : (card.dataset.aiProvider === "anthropic" || card.dataset.aiProvider === "gemini" ? "原生" : "兼容");
    }
  });
  if (gptConnectionBadge) {
    gptConnectionBadge.className = `badge ${tested ? "green" : failed ? "red" : ready ? "amber" : ""}`;
    gptConnectionBadge.textContent = tested ? "连接通过" : failed ? "连接失败" : ready ? "待测试" : "未启用";
  }
  if (gptConnectionTitle) gptConnectionTitle.textContent = tested ? "AI 连接测试通过" : failed ? "AI 连接测试失败" : ready ? "已保存，建议立即测试" : config?.enabled ? "还需要填写 API Key" : "等待启用 AI";
  if (gptConnectionText) gptConnectionText.textContent = config?.lastTestMessage || (ready ? `当前模型：${config?.model}。已勾选 ${useCount} 个业务模块。` : "配置完成后，自动获客、官网解析、线索评分、开发信草稿和考试资料可以按需调用。");
  if (gptState) gptState.textContent = ready ? "已启用" : config?.enabled ? "待补Key" : "未启用";
  if (gptSub) gptSub.textContent = tested ? "最近测试通过" : ready ? "可测试连接和调用" : "等待 API Key";
  if (gptModelState) gptModelState.textContent = config?.model || defaultModel;
  if (providerState) providerState.textContent = preset.label;
  if (protocolState) protocolState.textContent = protocol === "anthropic" ? "Anthropic Messages" : protocol === "gemini" ? "Gemini generateContent" : "OpenAI兼容协议";
  if (useState) useState.textContent = `${useCount} 个模块`;
  [
    ["#aiUseLeadFinder", useFlags.leadFinder],
    ["#aiUseWebsiteParse", useFlags.websiteParse],
    ["#aiUseScoring", useFlags.scoring],
    ["#aiUseEmailDraft", useFlags.emailDraft],
    ["#aiUseExam", useFlags.exam]
  ].forEach(([selector, checked]) => {
    const input = qs<HTMLInputElement>(String(selector));
    if (input && !draftMode) input.checked = Boolean(checked);
  });
  Object.entries(useFlags).forEach(([key, on]) => {
    const row = qs<HTMLElement>(`[data-ai-use-row="${key}"]`);
    const stateBadge = row?.querySelector<HTMLElement>(".badge");
    if (stateBadge) {
      stateBadge.className = `badge ${ready && on ? "green" : on ? "amber" : "gray"}`;
      stateBadge.textContent = ready && on ? "已启用" : on ? "待Key" : "关闭";
    }
  });
}

function collectAiConfigPayload() {
  const activeView = qs<HTMLElement>(".view.active")?.id;
  const useGptPage = activeView === "ai-config" || Boolean(qs<HTMLInputElement>("#gptConfigName")?.matches(":focus"));
  if (useGptPage) {
    return {
      id: state.selectedAiConfigId || undefined,
      provider: qs<HTMLSelectElement>("#gptProviderSelect")?.value || "openai",
      protocol: qs<HTMLSelectElement>("#gptProtocolSelect")?.value || "openai-compatible",
      name: qs<HTMLInputElement>("#gptConfigName")?.value.trim() || "",
      baseUrl: qs<HTMLInputElement>("#gptBaseUrlInput")?.value.trim() || "",
      model: qs<HTMLInputElement>("#gptModelInput")?.value.trim() || "",
      apiKey: qs<HTMLInputElement>("#gptApiKeyInput")?.value.trim() || "",
      enabled: qs<HTMLSelectElement>("#gptEnabledSelect")?.value !== "false",
      temperature: Number(qs<HTMLInputElement>("#gptTemperatureInput")?.value || 0.1),
      useLeadFinder: Boolean(qs<HTMLInputElement>("#aiUseLeadFinder")?.checked),
      useWebsiteParse: Boolean(qs<HTMLInputElement>("#aiUseWebsiteParse")?.checked),
      useScoring: Boolean(qs<HTMLInputElement>("#aiUseScoring")?.checked),
      useEmailDraft: Boolean(qs<HTMLInputElement>("#aiUseEmailDraft")?.checked),
      useExam: Boolean(qs<HTMLInputElement>("#aiUseExam")?.checked)
    };
  }
  return {
    id: state.selectedAiConfigId || state.aiConfig?.id || undefined,
    provider: state.aiConfig?.provider || "openai",
    protocol: state.aiConfig?.protocol || "openai-compatible",
    name: qs<HTMLInputElement>("#aiConfigName")?.value.trim() || "官网商机解析模型",
    baseUrl: qs<HTMLInputElement>("#aiBaseUrlInput")?.value.trim() || "https://api.openai.com/v1",
    model: qs<HTMLInputElement>("#aiModelInput")?.value.trim() || "gpt-4o-mini",
    apiKey: qs<HTMLInputElement>("#aiApiKeyInput")?.value.trim() || "",
    enabled: Boolean(qs<HTMLInputElement>("#aiEnabledInput")?.checked),
    temperature: state.aiConfig?.temperature ?? 0.1,
    useLeadFinder: state.aiConfig?.useLeadFinder ?? true,
    useWebsiteParse: state.aiConfig?.useWebsiteParse ?? true,
    useScoring: state.aiConfig?.useScoring ?? true,
    useEmailDraft: state.aiConfig?.useEmailDraft ?? true,
    useExam: state.aiConfig?.useExam ?? false
  };
}

function applyAiProviderPreset(provider: string) {
  const preset = aiProviderPresets[provider] || aiProviderPresets.custom;
  const providerSelect = qs<HTMLSelectElement>("#gptProviderSelect");
  const protocolSelect = qs<HTMLSelectElement>("#gptProtocolSelect");
  const nameInput = qs<HTMLInputElement>("#gptConfigName");
  const baseInput = qs<HTMLInputElement>("#gptBaseUrlInput");
  const modelInput = qs<HTMLInputElement>("#gptModelInput");
  if (providerSelect) providerSelect.value = provider in aiProviderPresets ? provider : "custom";
  if (protocolSelect) protocolSelect.value = preset.protocol;
  if (nameInput) nameInput.value = state.aiDraftMode ? "" : preset.name;
  if (baseInput) baseInput.value = preset.baseUrl;
  if (modelInput) modelInput.value = state.aiDraftMode ? "" : preset.model;
  qsa<HTMLElement>("[data-ai-provider]").forEach((card) => card.classList.toggle("active", card.dataset.aiProvider === provider));
}

function newAiConfigDraft(provider = "openai") {
  const preset = aiProviderPresets[provider] || aiProviderPresets.openai;
  state.aiDraftMode = true;
  state.selectedAiConfigId = null;
  state.pendingAiDeleteId = null;
  const nameInput = qs<HTMLInputElement>("#gptConfigName");
  const apiKeyInput = qs<HTMLInputElement>("#gptApiKeyInput");
  const enabledSelect = qs<HTMLSelectElement>("#gptEnabledSelect");
  const tempInput = qs<HTMLInputElement>("#gptTemperatureInput");
  const providerSelect = qs<HTMLSelectElement>("#gptProviderSelect");
  const protocolSelect = qs<HTMLSelectElement>("#gptProtocolSelect");
  const baseInput = qs<HTMLInputElement>("#gptBaseUrlInput");
  const modelInput = qs<HTMLInputElement>("#gptModelInput");
  if (providerSelect) providerSelect.value = provider in aiProviderPresets ? provider : "custom";
  if (protocolSelect) protocolSelect.value = preset.protocol;
  if (nameInput) nameInput.value = "";
  if (baseInput) baseInput.value = preset.baseUrl;
  if (modelInput) modelInput.value = "";
  if (apiKeyInput) {
    apiKeyInput.value = "";
    apiKeyInput.placeholder = "新配置请填写 API Key";
  }
  if (enabledSelect) enabledSelect.value = "false";
  if (tempInput) tempInput.value = "0.1";
  ["#aiUseLeadFinder", "#aiUseWebsiteParse", "#aiUseScoring", "#aiUseEmailDraft"].forEach((selector) => {
    const input = qs<HTMLInputElement>(selector);
    if (input) input.checked = false;
  });
  const exam = qs<HTMLInputElement>("#aiUseExam");
  if (exam) exam.checked = false;
  renderAiConfig(null);
}

async function deleteAiConfig(button?: HTMLButtonElement) {
  if (!state.selectedAiConfigId) {
    toast("请先选择要删除的配置", "error");
    return;
  }
  const current = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  if (!current) return;
  if (state.pendingAiDeleteId !== current.id) {
    state.pendingAiDeleteId = current.id;
    renderAiConfig(current);
    return;
  }
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "删除中";
  }
  try {
    const result = await api<{ config: AiModelConfig | null; configs: AiModelConfig[] }>(`/api/tools/ai-config/${encodeURIComponent(current.id)}`, { method: "DELETE" });
    state.aiConfigs = result.configs || [];
    state.aiConfig = result.config;
    state.aiDraftMode = false;
    state.pendingAiDeleteId = null;
    state.selectedAiConfigId = result.config?.id || state.aiConfigs[0]?.id || null;
    renderAiConfig(state.aiConfig);
    renderLeadFinder(state.websiteOpportunities);
    toast(`已删除：${current.name}`);
  } finally {
    if (button) {
      const selected = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
      button.disabled = state.aiDraftMode || !selected;
      button.textContent = selected && state.pendingAiDeleteId === selected.id ? "确认删除" : (originalText === "确认删除" ? "删除当前" : originalText || "删除当前");
    }
  }
}

async function toggleAiConfigEnabled(button?: HTMLButtonElement) {
  if (state.aiDraftMode || !state.selectedAiConfigId) {
    toast("请先保存或选择一个配置", "error");
    return;
  }
  const current = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  if (!current) return;
  const enabledSelect = qs<HTMLSelectElement>("#gptEnabledSelect");
  if (enabledSelect) enabledSelect.value = current.enabled ? "false" : "true";
  await saveAiConfig(button);
}

async function saveAiConfig(button?: HTMLButtonElement, options: { silent?: boolean } = {}) {
  const originalText = button?.textContent || "";
  const payload = collectAiConfigPayload();
  const selected = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  const hasSubmittedKey = typeof payload.apiKey === "string" && payload.apiKey.length > 0 && !payload.apiKey.includes("****");
  if (!payload.name || !payload.baseUrl || !payload.model) {
    toast("请填写配置名称、Base URL 和模型名称", "error");
    return;
  }
  if (payload.enabled && !hasSubmittedKey && !selected?.hasApiKey) {
    toast("请先填写 API Key，再启用该配置", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "保存中";
  }
  try {
    const result = await api<{ config: AiModelConfig; configs?: AiModelConfig[] }>("/api/tools/ai-config", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.aiConfig = result.config;
    state.aiConfigs = result.configs || state.aiConfigs.filter((item) => item.id !== result.config.id).concat(result.config);
    state.selectedAiConfigId = result.config.id;
    state.aiDraftMode = false;
    state.pendingAiDeleteId = null;
    renderAiConfig(result.config);
    renderLeadFinder(state.websiteOpportunities);
    if (!options.silent) toast(result.config.enabled ? `已保存并启用：${result.config.name}` : `已保存：${result.config.name}`);
  } finally {
    if (button) {
      button.disabled = false;
      if (button.id === "aiToggleEnabledButton") {
        button.textContent = state.aiConfig?.enabled ? "停用当前" : "启用当前";
      } else {
        button.textContent = originalText || "保存AI配置";
      }
    }
  }
}

async function testAiConfig(button?: HTMLButtonElement) {
  await saveAiConfig(undefined, { silent: true });
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "测试中";
  }
  try {
    const result = await api<{ ok: boolean; message: string; config?: AiModelConfig; configs?: AiModelConfig[] }>("/api/tools/ai-config/test", {
      method: "POST",
      body: JSON.stringify({ id: state.selectedAiConfigId || undefined })
    });
    if (result.config) {
      state.aiConfig = result.config;
      state.aiConfigs = result.configs || state.aiConfigs.map((item) => item.id === result.config?.id ? result.config : item);
      state.selectedAiConfigId = result.config.id;
      renderAiConfig(result.config);
      renderLeadFinder(state.websiteOpportunities);
    }
    const gptConnectionBadge = qs<HTMLElement>("#gptConnectionBadge");
    const gptConnectionTitle = qs<HTMLElement>("#gptConnectionTitle");
    const gptConnectionText = qs<HTMLElement>("#gptConnectionText");
    if (gptConnectionBadge) {
      gptConnectionBadge.className = `badge ${result.ok ? "green" : "red"}`;
      gptConnectionBadge.textContent = result.ok ? "连接通过" : "连接失败";
    }
    if (gptConnectionTitle) gptConnectionTitle.textContent = result.ok ? "AI 连接测试通过" : "AI 连接测试失败";
    if (gptConnectionText) gptConnectionText.textContent = result.message;
    toast(result.message, result.ok ? "ok" : "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || "测试连接";
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

function websiteDomain(value: string) {
  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  }
}

function leadFinderScore(item: WebsiteOpportunity) {
  let score = 42;
  if (item.company && !/unknown|待维护/i.test(item.company)) score += 12;
  if (item.business && !item.business.includes("待维护")) score += 12;
  if (item.country && item.country !== "未知") score += 8;
  if (item.contact && !item.contact.includes("待维护")) score += 8;
  if (item.contactInfo) score += 10;
  if (item.description && item.description.length > 30) score += 8;
  if (item.parseMode === "ai") score += 6;
  if (item.status === "synced") score += 4;
  return Math.max(35, Math.min(score, 96));
}

function leadFinderDuplicateState(item: WebsiteOpportunity) {
  const domain = websiteDomain(item.website);
  const duplicatedCustomer = state.customers.find((customer) => {
    const sameCompany = customer.company.trim().toLowerCase() === item.company.trim().toLowerCase();
    const docText = `${customer.billingName || ""} ${customer.documentContact || ""}`.toLowerCase();
    return sameCompany || (domain && docText.includes(domain));
  });
  if (item.customerId || duplicatedCustomer) return { text: "已有客户", tone: "amber" };
  if (item.status === "synced") return { text: "已同步", tone: "green" };
  return { text: "新候选", tone: "green" };
}

function leadFinderFilteredRows(opportunities: WebsiteOpportunity[]) {
  return opportunities.filter((item) => {
    const duplicate = leadFinderDuplicateState(item);
    const score = leadFinderScore(item);
    if (state.leadFinderFilter === "pending") return item.status !== "synced";
    if (state.leadFinderFilter === "high") return score >= 76;
    if (state.leadFinderFilter === "duplicate") return duplicate.text === "已有客户";
    if (state.leadFinderFilter === "synced") return item.status === "synced";
    return true;
  });
}

function contactEmail(value: string) {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
}

function prospectFilteredRows() {
  const keyword = qs<HTMLInputElement>("#prospectSearchInput")?.value.trim().toLowerCase() || "";
  return [...state.websiteOpportunities]
    .filter((item) => {
      const haystack = `${item.company} ${item.business} ${item.country} ${item.website} ${item.contact} ${item.contactInfo} ${item.description}`.toLowerCase();
      if (keyword && !haystack.includes(keyword)) return false;
      if (state.prospectFilter === "pending") return item.status !== "synced" || !item.lastDevelopmentEmailAt;
      if (state.prospectFilter === "mailed") return Boolean(item.lastDevelopmentEmailAt);
      if (state.prospectFilter === "high") return leadFinderScore(item) >= 76;
      if (state.prospectFilter === "synced") return item.status === "synced";
      return true;
    })
    .sort((left, right) => {
      const leftMail = left.lastDevelopmentEmailAt ? 1 : 0;
      const rightMail = right.lastDevelopmentEmailAt ? 1 : 0;
      if (left.status !== right.status) return left.status === "synced" ? 1 : -1;
      if (leftMail !== rightMail) return leftMail - rightMail;
      return leadFinderScore(right) - leadFinderScore(left);
    });
}

function selectedProspect() {
  return state.websiteOpportunities.find((item) => item.id === state.selectedProspectId) || null;
}

function renderProspectMailPreview() {
  const preview = qs<HTMLElement>("#prospectMailPreview");
  const item = selectedProspect();
  if (!preview) return;
  const sender = state.user?.emailSenderName || state.user?.name || "GoodJob Sales";
  const from = state.user?.outboundEmail || "";
  preview.textContent = [
    `From: ${sender}${from ? ` <${from}>` : " <未绑定发件邮箱>"}`,
    `To: ${qs<HTMLInputElement>("#prospectMailTo")?.value.trim() || "未填写"}`,
    `Subject: ${qs<HTMLInputElement>("#prospectMailSubject")?.value.trim() || "未填写"}`,
    "",
    qs<HTMLTextAreaElement>("#prospectMailBody")?.value.trim() || (item ? "点击“生成正文”创建开发信。" : "选择一条线索后，可生成并预览开发信。")
  ].join("\n");
}

function generateProspectMailDraft() {
  const item = selectedProspect();
  if (!item) {
    toast("请先选择一条搜客线索", "error");
    return;
  }
  const sender = state.user?.emailSenderName || state.user?.name || "GoodJob Sales";
  const signature = state.user?.emailSignature?.trim() || `Best regards,\n${sender}\nGoodJob Instrument Sales`;
  const mailTo = qs<HTMLInputElement>("#prospectMailTo");
  const subject = qs<HTMLInputElement>("#prospectMailSubject");
  const body = qs<HTMLTextAreaElement>("#prospectMailBody");
  if (mailTo && !mailTo.value.trim()) mailTo.value = contactEmail(item.contactInfo) || contactEmail(item.contact) || "";
  if (subject && !subject.value.trim()) subject.value = `${item.business || "Instrumentation"} supplier support for ${item.company}`;
  if (body) {
    body.value = [
      `Dear ${item.company} team,`,
      "",
      `I noticed your company is active in ${item.business || "industrial instrumentation related business"}${item.country ? ` in ${item.country}` : ""}.`,
      "GoodJob supplies pressure, temperature, flow and level instruments for distributors, system integrators and industrial projects.",
      "We can support product selection, datasheets, certificates, quotation and sample coordination for your local projects.",
      "",
      "May I know which instrumentation categories you are currently sourcing, and whether you have any upcoming project requirements?",
      "",
      signature
    ].join("\n");
  }
  renderProspectMailPreview();
}

function renderProspectDetail(item?: WebsiteOpportunity | null) {
  const box = qs<HTMLElement>("#prospectDetail");
  const sender = qs<HTMLElement>("#prospectSenderStatus");
  if (sender) {
    sender.innerHTML = state.user?.outboundEmail
      ? `当前发件人：${escapeHtml(state.user.emailSenderName || state.user.name)} &lt;${escapeHtml(state.user.outboundEmail)}&gt;`
      : `请先到个人主页绑定发件邮箱，再发送开发信。`;
  }
  if (!box) return;
  if (!item) {
    box.innerHTML = `<div class="empty-cell">点击左侧线索查看详情。</div>`;
    renderProspectMailPreview();
    return;
  }
  const score = leadFinderScore(item);
  const duplicate = leadFinderDuplicateState(item);
  box.innerHTML = `
    <div class="prospect-detail-hero">
      ${badge(item.status === "synced" ? "已转化" : "待跟进", item.status === "synced" ? "green" : "amber")} ${badge(`${score}分`, score >= 76 ? "green" : score >= 60 ? "amber" : "gray")} ${badge(duplicate.text, duplicate.tone)}
      <h2>${escapeHtml(item.company)}</h2>
      <p>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(item.business || "业务待维护")} · ${escapeHtml(websiteDomain(item.website || ""))}</p>
    </div>
    <div class="prospect-field-grid">
      <div class="prospect-field"><span>官网</span><b>${escapeHtml(item.website || "待补齐")}</b></div>
      <div class="prospect-field"><span>联系人</span><b>${escapeHtml(item.contact || "待维护")}</b></div>
      <div class="prospect-field"><span>联系方式</span><b>${escapeHtml(item.contactInfo || "待补齐")}</b></div>
      <div class="prospect-field"><span>最近开发信</span><b>${item.lastDevelopmentEmailAt ? `${formatTime(item.lastDevelopmentEmailAt)} · ${escapeHtml(item.lastDevelopmentEmailSubject || "开发信")}` : "尚未发送"}</b></div>
      <div class="prospect-field" style="grid-column:1/-1"><span>说明</span><b>${escapeHtml(item.description || "暂无说明")}</b></div>
    </div>
    <div class="inline-alert"><b>建议动作</b><span>${score >= 76 ? "优先发开发信并同步客户/商机，随后创建电话或WhatsApp跟进待办。" : "先补齐联系人和业务证据，再决定是否首轮触达。"}</span></div>
  `;
  if (!qs<HTMLInputElement>("#prospectMailTo")?.value.trim()) generateProspectMailDraft();
  else renderProspectMailPreview();
}

function renderProspectList() {
  const rows = qs<HTMLElement>("#prospectListRows");
  const total = qs<HTMLElement>("#prospectTotalCount");
  const pending = qs<HTMLElement>("#prospectPendingCount");
  const mailed = qs<HTMLElement>("#prospectMailedCount");
  const synced = qs<HTMLElement>("#prospectSyncedCount");
  const all = state.websiteOpportunities;
  const filtered = prospectFilteredRows();
  if (!state.selectedProspectId || !all.some((item) => item.id === state.selectedProspectId)) state.selectedProspectId = filtered[0]?.id || all[0]?.id || null;
  if (total) total.textContent = String(all.length);
  if (pending) pending.textContent = String(all.filter((item) => item.status !== "synced" || !item.lastDevelopmentEmailAt).length);
  if (mailed) mailed.textContent = String(all.filter((item) => item.lastDevelopmentEmailAt).length);
  if (synced) synced.textContent = String(all.filter((item) => item.status === "synced").length);
  qsa<HTMLButtonElement>("[data-prospect-filter]").forEach((button) => button.classList.toggle("active", button.dataset.prospectFilter === state.prospectFilter));
  if (rows) {
    rows.innerHTML = filtered.length ? filtered.map((item) => {
      const score = leadFinderScore(item);
      return `
        <button class="prospect-item ${item.id === state.selectedProspectId ? "active" : ""}" type="button" data-prospect-id="${escapeHtml(item.id)}">
          <div class="prospect-item-top"><h3>${escapeHtml(item.company)}</h3><span class="prospect-score">${score}</span></div>
          <p>${escapeHtml(item.business || "业务待维护")}</p>
          <small>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(websiteDomain(item.website || ""))}</small>
          <div class="prospect-meta-row">${badge(item.status === "synced" ? "已转化" : "待跟进", item.status === "synced" ? "green" : "amber")}${item.lastDevelopmentEmailAt ? badge("已发开发信", "green") : badge("未触达", "")}</div>
        </button>
      `;
    }).join("") : `<div class="empty-cell">暂无匹配线索。请调整筛选，或去自动获客生成新结果。</div>`;
    qsa<HTMLButtonElement>("[data-prospect-id]", rows).forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedProspectId = button.dataset.prospectId || null;
        qs<HTMLInputElement>("#prospectMailTo")!.value = "";
        qs<HTMLInputElement>("#prospectMailSubject")!.value = "";
        qs<HTMLTextAreaElement>("#prospectMailBody")!.value = "";
        renderProspectList();
      });
    });
  }
  renderProspectDetail(selectedProspect());
}

function selectedProspectAsSyncRow() {
  const item = selectedProspect();
  if (!item) return [];
  return [{
    id: item.id,
    company: item.company,
    business: item.business,
    country: item.country,
    website: item.website,
    contact: item.contact,
    contactInfo: item.contactInfo,
    description: item.description
  }];
}

async function syncSelectedProspect(button?: HTMLButtonElement) {
  const opportunities = selectedProspectAsSyncRow();
  if (!opportunities.length) {
    toast("请先选择一条搜客线索", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "转化中";
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
      state.selectedProspectId = item.opportunity.id;
    });
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    renderCustomers(state.customers);
    renderPipeline(state.deals);
    void refreshDashboardOnly();
    toast("已转为客户和商机");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "转客户/商机";
    }
  }
}

async function createSelectedProspectTodo(button?: HTMLButtonElement) {
  const item = selectedProspect();
  if (!item) {
    toast("请先选择一条搜客线索", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "生成中";
  }
  try {
    const result = await api<{ todo: Todo }>("/api/todos", {
      method: "POST",
      body: JSON.stringify({
        title: `跟进搜客线索：${item.company}`,
        type: "customer",
        priority: leadFinderScore(item) >= 76 ? "high" : "medium",
        dueAt: currentDateTimeText(),
        related: item.company
      })
    });
    state.todos.unshift(result.todo);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    renderTopbarStats();
    toast("已生成搜客跟进待办");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "生成待办";
    }
  }
}

async function sendProspectDevelopmentEmail(button?: HTMLButtonElement) {
  const item = selectedProspect();
  if (!item) {
    toast("请先选择一条搜客线索", "error");
    return;
  }
  if (!state.user?.outboundEmail) {
    toast("请先在个人主页绑定发件邮箱", "error");
    return;
  }
  const to = qs<HTMLInputElement>("#prospectMailTo")?.value.trim() || "";
  const subject = qs<HTMLInputElement>("#prospectMailSubject")?.value.trim() || "";
  const body = qs<HTMLTextAreaElement>("#prospectMailBody")?.value.trim() || "";
  if (!to || !subject || body.length < 10) {
    toast("请补齐收件邮箱、主题和正文", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ sent: { simulated: boolean }; opportunity: WebsiteOpportunity; user: User }>(`/api/prospect-list/${encodeURIComponent(item.id)}/send-development-email`, {
      method: "POST",
      body: JSON.stringify({ to, subject, body })
    });
    updateStoredUser(result.user);
    const existing = state.websiteOpportunities.find((row) => row.id === result.opportunity.id);
    if (existing) Object.assign(existing, result.opportunity);
    renderProspectList();
    renderLeadFinder(state.websiteOpportunities);
    toast(result.sent.simulated ? "开发信已发送（测试模拟记录）" : "开发信已发送");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "发送开发信";
    }
  }
}

function currentLeadFinderTitle() {
  const product = qs<HTMLInputElement>("#leadProductKeywords")?.value.trim().split(/,|，/)[0]?.trim() || "产品";
  const country = qs<HTMLInputElement>("#leadCountries")?.value.trim().split(/,|，/)[0]?.trim() || "目标市场";
  const type = qs<HTMLSelectElement>("#leadCustomerTypes")?.value.split("/")[0]?.trim() || "客户";
  return `${country} · ${product} · ${type}`;
}

function currentLeadFinderSubtitle() {
  const mode = qs<HTMLSelectElement>("#leadSearchModeInput")?.value || "公开公司获客";
  const depth = qs<HTMLSelectElement>("#leadSearchDepthInput")?.value || "标准";
  const validation = qs<HTMLSelectElement>("#leadValidationInput")?.value || "标准验证";
  return `${mode} · ${depth} · ${validation}`;
}

function currentLeadFinderSources() {
  return qsa<HTMLInputElement>("[data-lead-source]")
    .filter((item) => item.checked)
    .map((item) => item.closest("label")?.querySelector("b")?.textContent?.trim() || item.dataset.leadSource || "搜索源")
    .filter(Boolean);
}

function buildLeadFinderJobDetails(resultIds: string[] = []) {
  const product = qs<HTMLInputElement>("#leadProductKeywords")?.value.trim() || "未填写产品";
  const countries = qs<HTMLInputElement>("#leadCountries")?.value.trim() || "未填写市场";
  const industry = qs<HTMLInputElement>("#leadIndustryInput")?.value.trim() || "未填写行业";
  const customerType = qs<HTMLSelectElement>("#leadCustomerTypes")?.value || "未选择客户类型";
  const sourceText = currentLeadFinderSources().join("、") || "默认公开源";
  const lines = [
    `产品：${product}`,
    `市场：${countries}`,
    `行业：${industry}`,
    `客户类型：${customerType}`,
    `渠道：${sourceText}`
  ];
  if (resultIds.length) lines.unshift(`本次已搜到 ${resultIds.length} 条候选，展开可查看公司、国家和官网。`);
  return lines;
}

function leadFinderJobStatusText(job: LeadFinderJob) {
  if (job.status === "done") return "已完成";
  if (job.status === "needs_input") return "待导入";
  if (job.status === "ready") return "待运行";
  return "进行中";
}

function leadFinderJobStatusTone(job: LeadFinderJob) {
  if (job.status === "done") return "green";
  if (job.status === "needs_input") return "amber";
  if (job.status === "running") return "blue";
  return "";
}

function renderLeadFinderJobDetails(job: LeadFinderJob) {
  const found = (job.resultIds || [])
    .map((id) => state.websiteOpportunities.find((item) => item.id === id))
    .filter(Boolean) as WebsiteOpportunity[];
  const foundHtml = found.length ? `
    <div class="lead-job-found-list">
      ${found.slice(0, 8).map((item) => `
        <button type="button" data-lead-job-pick="${escapeHtml(item.id)}">
          <b>${escapeHtml(item.company || "公司待确认")}</b>
          <span>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(websiteDomain(item.website || ""))}</span>
          <em>${leadFinderScore(item)}分</em>
        </button>
      `).join("")}
    </div>
  ` : `<div class="lead-job-loading">${job.status === "running" ? "正在检索公开API、生成平台搜索入口并等待候选结果..." : "本次任务暂无候选结果，可导入官网/平台链接继续解析。"}</div>`;
  return `
    <div class="lead-job-detail" ${job.expanded ? "" : "hidden"}>
      <div class="lead-job-detail-lines">${(job.detailLines || buildLeadFinderJobDetails(job.resultIds)).map((line) => `<span>${escapeHtml(line)}</span>`).join("")}</div>
      ${foundHtml}
    </div>
  `;
}

function renderLeadFinderJobs() {
  const box = qs<HTMLElement>("#leadFinderJobList");
  if (!box) return;
  if (!leadFinderJobs.length) {
    box.innerHTML = `<div class="empty-cell">还没有搜客任务。填写条件后点击“生成并运行任务”。</div>`;
    return;
  }
  box.innerHTML = leadFinderJobs.map((job) => `
    <article class="lead-job-card" data-lead-job-id="${escapeHtml(job.id)}">
      <div class="lead-job-top">
        <button class="lead-job-toggle" type="button" data-lead-job-toggle aria-label="${job.expanded ? "收起任务详情" : "展开任务详情"}">${job.expanded ? "▾" : "▸"}</button>
        <div><h3>${escapeHtml(job.title)}</h3><p>${escapeHtml(job.subtitle)}</p></div>
        ${badge(leadFinderJobStatusText(job), leadFinderJobStatusTone(job))}
      </div>
      <div class="lead-job-metrics">
        <div><span>线索进度</span><b>${job.resultCount}/目标</b></div>
        <div><span>已耗时</span><b>${escapeHtml(job.elapsedText)}</b></div>
        <div><span>启用渠道</span><b>${job.channelCount} 个</b></div>
        <div><span>预计进度</span><b>${job.progress}%</b></div>
      </div>
      <div class="lead-job-progress"><i style="--p:${job.progress}%"></i></div>
      <div class="lead-job-steps">${job.steps.map((step, index) => `<span>${index + 1} ${escapeHtml(step)}</span>`).join("")}</div>
      ${renderLeadFinderJobDetails(job)}
      <div class="lead-job-actions"><button class="btn" data-lead-job-import>导入结果链接</button><button class="btn primary" data-lead-job-sync>同步选中结果</button></div>
    </article>
  `).join("");
  qsa<HTMLButtonElement>("[data-lead-job-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.closest<HTMLElement>("[data-lead-job-id]")?.dataset.leadJobId;
      const job = leadFinderJobs.find((item) => item.id === id);
      if (!job) return;
      job.expanded = !job.expanded;
      renderLeadFinderJobs();
    });
  });
  qsa<HTMLButtonElement>("[data-lead-job-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedLeadFinderId = button.dataset.leadJobPick || null;
      renderLeadFinder(state.websiteOpportunities);
    });
  });
  qsa<HTMLButtonElement>("[data-lead-job-import]").forEach((button) => {
    button.addEventListener("click", () => {
      qs<HTMLDetailsElement>(".lead-import-drawer")?.setAttribute("open", "true");
      qs<HTMLTextAreaElement>("#leadFinderUrlInput")?.focus();
    });
  });
  qsa<HTMLButtonElement>("[data-lead-job-sync]").forEach((button) => {
    button.addEventListener("click", (event) => void syncLeadFinderRows(event.currentTarget as HTMLButtonElement));
  });
}

function createLeadFinderJob(status: LeadFinderJob["status"] = "running") {
  const enabledSources = currentLeadFinderSources().length || 1;
  const job: LeadFinderJob = {
    id: `lf_${Date.now()}`,
    title: currentLeadFinderTitle(),
    subtitle: currentLeadFinderSubtitle(),
    status,
    resultCount: 0,
    channelCount: enabledSources,
    elapsedText: status === "running" ? "刚刚开始" : "待导入",
    progress: status === "running" ? 18 : 35,
    steps: status === "running" ? ["生成搜索语法", "检索公开API", "等待返回结果"] : ["生成搜索语法", "打开平台入口", "导入官网/询盘链接"],
    createdAt: new Date().toISOString(),
    expanded: false,
    resultIds: [],
    detailLines: buildLeadFinderJobDetails()
  };
  leadFinderJobs = [job, ...leadFinderJobs].slice(0, 6);
  renderLeadFinderJobs();
  return job;
}

function updateLeadFinderJob(jobId: string, resultIds: string[], status: LeadFinderJob["status"]) {
  const job = leadFinderJobs.find((item) => item.id === jobId);
  if (!job) return;
  job.status = status;
  job.resultCount = resultIds.length;
  job.elapsedText = status === "done" ? "已完成" : "待导入";
  job.progress = status === "done" ? 100 : 52;
  job.steps = status === "done" ? ["生成搜索语法", "检索公开API", "提取公司资料", "等待同步"] : ["生成搜索语法", "打开平台入口", "导入官网/询盘链接"];
  job.resultIds = resultIds;
  job.detailLines = buildLeadFinderJobDetails(resultIds);
  renderLeadFinderJobs();
}

function renderLeadFinderSearchLinks() {
  const box = qs<HTMLElement>("#leadFinderSearchLinks");
  if (!box) return;
  const goal = qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.value.trim() || "";
  const keywords = qs<HTMLInputElement>("#leadProductKeywords")?.value.trim() || "pressure transmitter";
  const countries = (qs<HTMLInputElement>("#leadCountries")?.value.trim() || "Germany").split(/,|，/).map((item) => item.trim()).filter(Boolean).slice(0, 3);
  const industries = (qs<HTMLInputElement>("#leadIndustryInput")?.value.trim() || "").split(/,|，/).map((item) => item.trim()).filter(Boolean).slice(0, 2);
  const customerType = qs<HTMLSelectElement>("#leadCustomerTypes")?.value.split("/")[1]?.trim() || qs<HTMLSelectElement>("#leadCustomerTypes")?.value || "distributor";
  const exclude = (qs<HTMLInputElement>("#leadExcludeKeywords")?.value.trim() || "").split(/,|，/).map((item) => item.trim()).filter(Boolean).map((item) => `-${item}`).join(" ");
  const enabledSources = qsa<HTMLInputElement>("[data-lead-source]")
    .filter((item) => item.checked)
    .map((item) => item.dataset.leadSource || "google")
    .filter((source) => !["gleif", "wikidata"].includes(source));
  const countryList = countries.length ? countries : ["Germany", "UK", "Turkey"];
  const industryText = industries.length ? industries.join(" ") : "";
  const sourceTemplates: Record<string, { label: string; query: (country: string) => string }> = {
    google: { label: "Google/Web", query: (country) => `${goal} ${keywords} ${industryText} ${customerType} ${country} company website ${exclude}` },
    alibaba: { label: "Alibaba询盘", query: (country) => `site:alibaba.com/rfq ${goal} ${keywords} ${industryText} ${country} buyer inquiry ${exclude}` },
    madein: { label: "Made-in-China询盘", query: (country) => `site:made-in-china.com ${goal} ${keywords} ${industryText} ${country} sourcing request buyer ${exclude}` },
    globalsources: { label: "Global Sources", query: (country) => `site:globalsources.com ${goal} ${keywords} ${industryText} ${country} buyer request ${exclude}` },
    europages: { label: "Europages", query: (country) => `site:europages.com ${goal} ${keywords} ${industryText} ${customerType} ${country} ${exclude}` }
  };
  const rows = countryList.flatMap((country) => enabledSources.slice(0, 5).map((source) => {
    const template = sourceTemplates[source] || sourceTemplates.google;
    const query = template.query(country).replace(/\s+/g, " ").trim();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    return `<a href="${url}" target="_blank" rel="noreferrer"><b>${escapeHtml(template.label)}</b><span>${escapeHtml(query)}</span></a>`;
  })).slice(0, 12);
  box.innerHTML = rows.join("");
}

function collectLeadFinderRows() {
  return qsa<HTMLTableRowElement>("#leadFinderResultRows tr[data-lead-id]")
    .filter((row) => row.querySelector<HTMLInputElement>("[data-lead-select]")?.checked)
    .map((row) => {
      const value = (field: string) => {
        const node = row.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-lead-field="${field}"]`);
        return node?.value.trim() || "";
      };
      return {
        id: row.dataset.leadId || "",
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

function renderLeadFinderDetail(item?: WebsiteOpportunity) {
  const box = qs<HTMLElement>("#leadFinderDetail");
  if (!box) return;
  if (!item) {
    box.innerHTML = `<span>未选择</span><b>点击候选列表中的公司行查看详情。</b>`;
    return;
  }
  const score = leadFinderScore(item);
  const duplicate = leadFinderDuplicateState(item);
  const domain = websiteDomain(item.website);
  box.innerHTML = `
    <div class="lead-profile-head">
      <div><h3>${escapeHtml(item.company)}</h3><p>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(domain)} · ${escapeHtml(item.business || "业务待维护")}</p></div>
      <div class="lead-profile-score">${score}</div>
    </div>
    <div class="lead-detail-stack">
      <div class="lead-detail-card"><span>ICP 判断</span><b>${score >= 76 ? "高匹配，建议优先核实采购/工程联系人。" : score >= 60 ? "中匹配，需要补齐联系人和产品证据。" : "信息不足，先确认官网和业务范围。"}</b></div>
      <div class="lead-detail-card"><span>联系方式</span><b>${escapeHtml(item.contactInfo || item.contact || "待补齐")}</b></div>
      <div class="lead-detail-card"><span>来源状态</span><b>${badge(item.parseMode === "ai" ? "AI解析" : "规则解析", item.parseMode === "ai" ? "green" : "")} ${badge(`${score}分`, score >= 76 ? "green" : score >= 60 ? "amber" : "gray")} ${badge(duplicate.text, duplicate.tone)}</b></div>
      <div class="lead-detail-card"><span>下一步建议</span><b>${escapeHtml(item.status === "synced" ? "已进入客户/商机，可在商机页继续推进报价、样品或跟进提醒。" : "先核实联系人与采购角色，再同步为客户和询盘商机，并生成首次触达待办。")}</b></div>
    </div>
  `;
}

function renderLeadFinder(opportunities = state.websiteOpportunities) {
  const rows = qs<HTMLElement>("#leadFinderResultRows");
  const total = qs<HTMLElement>("#leadFinderTotalCount");
  const pending = qs<HTMLElement>("#leadFinderPendingCount");
  const synced = qs<HTMLElement>("#leadFinderSyncedCount");
  const aiState = qs<HTMLElement>("#leadFinderAiState");
  const aiSub = qs<HTMLElement>("#leadFinderAiSub");
  const aiBadge = qs<HTMLElement>("#leadFinderAiBadge");
  const sourceAiBadge = qs<HTMLElement>("#leadFinderSourceAiBadge");
  const ready = Boolean(state.aiConfig?.enabled && state.aiConfig?.hasApiKey && state.aiConfig?.useLeadFinder);
  const sortedAll = [...opportunities].sort((a, b) => {
    if (a.status !== b.status) return a.status === "synced" ? 1 : -1;
    return leadFinderScore(b) - leadFinderScore(a);
  });
  const sorted = leadFinderFilteredRows(sortedAll);
  if (!state.selectedLeadFinderId || !sortedAll.some((item) => item.id === state.selectedLeadFinderId)) {
    state.selectedLeadFinderId = sortedAll[0]?.id || null;
  }
  if (total) total.textContent = String(sortedAll.length);
  if (pending) pending.textContent = String(sortedAll.filter((item) => item.status !== "synced").length);
  if (synced) synced.textContent = String(sortedAll.filter((item) => item.status === "synced").length);
  if (aiState) aiState.textContent = ready ? "AI" : "规则";
  if (aiSub) aiSub.textContent = ready ? `${state.aiConfig?.model || "已配置"} 可用于解析` : "未启用或未授权自动获客时使用规则解析";
  [aiBadge, sourceAiBadge].forEach((node) => {
    if (!node) return;
    node.className = `badge ${ready ? "green" : ""}`;
    node.textContent = ready ? "AI已配置" : "规则解析";
  });
  const useAi = qs<HTMLInputElement>("#leadFinderUseAiInput");
  if (useAi) useAi.disabled = !ready;
  if (!rows) return;
  qsa<HTMLButtonElement>("[data-lead-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.leadFilter === state.leadFinderFilter);
  });
  rows.innerHTML = sorted.length ? sorted.map((item) => {
    const score = leadFinderScore(item);
    const duplicate = leadFinderDuplicateState(item);
    const selected = state.selectedLeadFinderId === item.id;
    return `
      <tr data-lead-id="${escapeHtml(item.id)}" class="${selected ? "selected" : ""}">
        <td><input type="checkbox" data-lead-select ${(item.selected ?? item.status !== "synced") ? "checked" : ""}></td>
        <td class="lead-company-cell" data-lead-pick><div class="lead-cell-title"><input data-lead-field="company" value="${escapeHtml(item.company)}"><span>${escapeHtml(websiteDomain(item.website))}</span><div class="lead-cell-tags"><span class="lead-mini-badge">${escapeHtml(item.country || "未知")}</span><span class="lead-mini-badge">${score >= 76 ? "高匹配" : "待补全"}</span></div></div></td>
        <td><input data-lead-field="business" value="${escapeHtml(item.business)}"></td>
        <td><input data-lead-field="country" value="${escapeHtml(item.country)}"></td>
        <td><input data-lead-field="website" value="${escapeHtml(item.website)}"></td>
        <td><input data-lead-field="contact" value="${escapeHtml(item.contact)}"></td>
        <td><input data-lead-field="contactInfo" value="${escapeHtml(item.contactInfo)}"></td>
        <td><textarea data-lead-field="description">${escapeHtml(item.description)}</textarea></td>
        <td><div class="lead-score"><b>${score}分</b><i style="--p:${score}%"></i></div></td>
        <td>${badge(item.status === "synced" ? "已同步" : "待确认", item.status === "synced" ? "green" : "amber")}${badge(duplicate.text, duplicate.tone)}${badge(item.parseMode === "ai" ? "AI" : "规则", item.parseMode === "ai" ? "green" : "")}</td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="10" class="empty-cell">暂无候选客户。输入官网后点击“开始搜客”。</td></tr>`;
  qsa<HTMLElement>("#leadFinderResultRows tr[data-lead-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).matches("input, textarea")) return;
      state.selectedLeadFinderId = row.dataset.leadId || null;
      renderLeadFinder(state.websiteOpportunities);
    });
  });
  renderLeadFinderDetail(sortedAll.find((item) => item.id === state.selectedLeadFinderId));
  renderLeadFinderSearchLinks();
  renderLeadFinderJobs();
}

async function runLeadFinder(button?: HTMLButtonElement) {
  const originalText = button?.textContent || "生成并运行任务";
  const input = qs<HTMLTextAreaElement>("#leadFinderUrlInput");
  const urls = (input?.value || "").split(/\n|,|，/).map((item) => item.trim()).filter(Boolean).slice(0, Number(qs<HTMLSelectElement>("#leadLimit")?.value || 20));
  const useAi = Boolean(qs<HTMLInputElement>("#leadFinderUseAiInput")?.checked);
  renderLeadFinderSearchLinks();
  if (useAi && (!state.aiConfig?.enabled || !state.aiConfig?.hasApiKey || !state.aiConfig?.useLeadFinder)) {
    toast("请先配置并启用 AI 模型，或关闭 AI 解析", "error");
    return;
  }
  const job = createLeadFinderJob("running");
  if (button) {
    button.disabled = true;
    button.textContent = useAi ? "AI搜客中" : "搜客任务运行中";
  }
  try {
    if (!urls.length) {
      const result = await api<{ opportunities: WebsiteOpportunity[]; sources: { gleif: number; wikidata: number } }>("/api/lead-finder/free-search", {
        method: "POST",
        body: JSON.stringify({
          goal: qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.value.trim() || "",
          productKeywords: qs<HTMLInputElement>("#leadProductKeywords")?.value.trim() || "",
          countries: qs<HTMLInputElement>("#leadCountries")?.value.trim() || "",
          industry: qs<HTMLInputElement>("#leadIndustryInput")?.value.trim() || "",
          customerType: qs<HTMLSelectElement>("#leadCustomerTypes")?.value || "",
          limit: Number(qs<HTMLSelectElement>("#leadLimit")?.value || 10)
        })
      });
      const existing = state.websiteOpportunities
        .filter((item) => !result.opportunities.some((next) => next.website === item.website || next.company === item.company))
        .map((item) => ({ ...item, selected: false }));
      state.websiteOpportunities = [...result.opportunities.map((item) => ({ ...item, selected: true })), ...existing];
      state.selectedLeadFinderId = result.opportunities[0]?.id || state.selectedLeadFinderId;
      updateLeadFinderJob(job.id, result.opportunities.map((item) => item.id), result.opportunities.length ? "done" : "needs_input");
      renderLeadFinder(state.websiteOpportunities);
      renderProspectList();
      toast(result.opportunities.length ? `免费公开API已找到 ${result.opportunities.length} 条候选，GLEIF ${result.sources.gleif} / Wikidata ${result.sources.wikidata}` : "免费公开API暂无结果；右侧已生成平台搜索入口，可继续导入官网/询盘链接");
      return;
    }
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-scrape/preview", {
      method: "POST",
      body: JSON.stringify({ urls, useAi })
    });
    const existing = state.websiteOpportunities
      .filter((item) => !result.opportunities.some((next) => next.website === item.website))
      .map((item) => ({ ...item, selected: false }));
    state.websiteOpportunities = [...result.opportunities.map((item) => ({ ...item, selected: true })), ...existing];
    state.selectedLeadFinderId = result.opportunities[0]?.id || state.selectedLeadFinderId;
    updateLeadFinderJob(job.id, result.opportunities.map((item) => item.id), "done");
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    toast(`已生成 ${result.opportunities.length} 条候选客户`);
  } catch (error) {
    updateLeadFinderJob(job.id, [], "needs_input");
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function syncLeadFinderRows(button?: HTMLButtonElement) {
  const opportunities = collectLeadFinderRows();
  if (!opportunities.length) {
    toast("请至少勾选一条候选客户", "error");
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
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    renderCustomers(state.customers);
    renderPipeline(state.deals);
    void refreshDashboardOnly();
    toast(`已同步 ${result.created.length} 条候选客户`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "同步客户/商机";
    }
  }
}

async function createLeadFinderTodos(button?: HTMLButtonElement) {
  const opportunities = collectLeadFinderRows();
  if (!opportunities.length) {
    toast("请先勾选需要跟进的候选客户", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "生成中";
  }
  try {
    const created: Todo[] = [];
    for (const item of opportunities) {
      const result = await api<{ todo: Todo }>("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          title: `核实搜客线索：${item.company}`,
          type: "customer",
          priority: "medium",
          dueAt: currentDateTimeText(),
          related: item.company
        })
      });
      created.push(result.todo);
    }
    state.todos.unshift(...created);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    renderTopbarStats();
    toast(`已生成 ${created.length} 条搜客跟进待办`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "生成待办";
    }
  }
}

function exportLeadFinderRows() {
  const rows = collectLeadFinderRows();
  const source = rows.length ? rows : state.websiteOpportunities;
  if (!source.length) {
    toast("暂无搜客结果可导出", "error");
    return;
  }
  const worksheet = XLSX.utils.json_to_sheet(source.map((item) => ({
    "公司名": item.company,
    "业务": item.business,
    "国家": item.country,
    "官网": item.website,
    "联系人": item.contact,
    "联系方式": item.contactInfo,
    "说明": item.description,
    "评分": "status" in item ? leadFinderScore(item as WebsiteOpportunity) : "",
    "状态": "status" in item ? ((item as WebsiteOpportunity).status === "synced" ? "已同步" : "待确认") : "待确认"
  })));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "智能搜客结果");
  XLSX.writeFile(workbook, `GoodJob智能搜客结果-${Date.now()}.xlsx`);
  toast("搜客结果已导出");
}

async function parseWebsiteOpportunities(button?: HTMLButtonElement) {
  const input = qs<HTMLTextAreaElement>("#websiteUrlInput");
  const urls = (input?.value || "").split(/\n|,|，/).map((item) => item.trim()).filter(Boolean);
  const useAi = Boolean(qs<HTMLInputElement>("#websiteUseAiInput")?.checked);
  if (!urls.length) {
    toast("请先粘贴官网地址", "error");
    return;
  }
  if (useAi && (!state.aiConfig?.enabled || !state.aiConfig?.hasApiKey || !state.aiConfig?.useWebsiteParse)) {
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
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
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
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
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

function planTaskPriorityText(priority: PlanTask["priority"]) {
  return priority === "high" ? "高优先级" : priority === "medium" ? "中优先级" : "普通";
}

function planTaskStatusText(status: PlanTask["status"]) {
  return status === "active" ? "进行中" : status === "done" ? "已完成" : "计划中";
}

function planTemplatePlanTitle(template: PlanTemplate) {
  return `${template.section === "knowledge" ? "训练" : template.section === "execution" ? "首周执行" : "客户画像"}：${template.title}`;
}

function renderPlanTemplates(templates = state.planTemplates) {
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
  `).join("") : `<div class="empty-state"><b>暂无前置知识训练项</b><span>可在后续版本中新增模板，当前先使用计划任务手动维护。</span></div>`;
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
  }).join("") : `<div class="empty-state"><b>暂无客户画像</b><span>可在后续版本中新增模板，当前先使用计划任务手动维护。</span></div>`;
  execution.innerHTML = executionItems.length ? executionItems.map((item) => `
    <div class="execution-day" data-plan-template-id="${escapeHtml(item.id)}">
      <div class="execution-title-row"><h3>${escapeHtml(item.title)}</h3><span class="badge ${escapeHtml(item.badgeTone)}">${escapeHtml(item.badge || "执行")}</span></div>
      <ul>${(item.output || item.summary).split("\n").filter(Boolean).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      <div class="template-actions"><button class="btn compact" data-plan-template-add="${escapeHtml(item.id)}">加入计划</button><button class="btn compact" data-plan-template-edit="${escapeHtml(item.id)}">编辑</button></div>
    </div>
  `).join("") : `<div class="empty-state"><b>暂无首周执行拆解</b><span>可编辑模板恢复首周节奏。</span></div>`;
  qsa<HTMLButtonElement>("[data-plan-template-add]").forEach((button) => button.addEventListener("click", () => void createPlanTaskFromTemplate(button.dataset.planTemplateAdd || "", button)));
  qsa<HTMLButtonElement>("[data-plan-template-edit]").forEach((button) => button.addEventListener("click", () => openPlanTemplateModal(state.planTemplates.find((item) => item.id === button.dataset.planTemplateEdit))));
  qsa<HTMLButtonElement>("[data-plan-template-delete]").forEach((button) => button.addEventListener("click", () => void deletePlanTemplate(button.dataset.planTemplateDelete || "")));
}

function renderPlanTasks(tasks = state.planTasks) {
  const container = qs<HTMLElement>("#planTaskList");
  if (!container) return;
  const sorted = [...tasks].sort((left, right) => {
    const statusWeight = { active: 0, planned: 1, done: 2 } as Record<PlanTask["status"], number>;
    const priorityWeight = { high: 0, medium: 1, normal: 2 } as Record<PlanTask["priority"], number>;
    return statusWeight[left.status] - statusWeight[right.status]
      || priorityWeight[left.priority] - priorityWeight[right.priority]
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
      <div><span>可推待办</span><b>${tasks.filter((task) => task.status !== "done").length}</b></div>
    `;
  }
  container.innerHTML = sorted.length ? `
    <table class="plan-task-table">
      <thead><tr><th><input id="planTaskSelectAll" type="checkbox"></th><th>任务</th><th>阶段/分类</th><th>目标</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
      <tbody>
        ${sorted.map((task) => `
          <tr data-plan-task-id="${escapeHtml(task.id)}">
            <td><input type="checkbox" data-plan-task-check="${escapeHtml(task.id)}" ${state.selectedPlanTaskIds.includes(task.id) ? "checked" : ""}></td>
            <td class="plan-title-cell"><b>${escapeHtml(task.title)}</b><small>${escapeHtml(task.description || "暂无说明")}</small></td>
            <td><span class="badge aqua">${escapeHtml(task.phase)}</span><small>${escapeHtml(task.category)}</small></td>
            <td>${escapeHtml(task.target || "未填写")}</td>
            <td><span class="badge ${task.status === "done" ? "green" : task.status === "active" ? "amber" : ""}">${planTaskStatusText(task.status)}</span><small>${planTaskPriorityText(task.priority)}</small></td>
            <td>${escapeHtml(task.dueAt || "未设置")}</td>
            <td class="row-actions"><button class="btn compact" data-plan-push="${escapeHtml(task.id)}">推待办</button><button class="btn compact" data-plan-edit="${escapeHtml(task.id)}">编辑</button><button class="btn compact danger" data-plan-delete="${escapeHtml(task.id)}">删除</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : `<div class="empty-state"><b>还没有计划任务</b><span>先新增一条开拓任务，再推送到待办执行。</span></div>`;
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
  qsa<HTMLButtonElement>("[data-plan-push]", container).forEach((button) => button.addEventListener("click", () => void pushPlanTasksToTodos([button.dataset.planPush || ""], button)));
}

function openPlanTaskModal(task?: PlanTask) {
  const editing = Boolean(task);
  openModal(editing ? "编辑计划任务" : "新增计划任务", `
    <div class="form-grid">
      <div class="form-field full"><label>任务标题</label><input id="planTaskTitleInput" value="${escapeHtml(task?.title || "")}" placeholder="例如：新增30家目标客户到客户池"></div>
      <div class="form-field"><label>阶段</label><input id="planTaskPhaseInput" value="${escapeHtml(task?.phase || "首周执行")}" placeholder="前置准备 / 触达准备"></div>
      <div class="form-field"><label>分类</label><input id="planTaskCategoryInput" value="${escapeHtml(task?.category || "客户开发")}" placeholder="客户开发 / 产品知识"></div>
      <div class="form-field"><label>优先级</label><select id="planTaskPriorityInput"><option value="high" ${task?.priority === "high" ? "selected" : ""}>高</option><option value="medium" ${task?.priority === "medium" ? "selected" : ""}>中</option><option value="normal" ${!task || task.priority === "normal" ? "selected" : ""}>普通</option></select></div>
      <div class="form-field"><label>状态</label><select id="planTaskStatusInput"><option value="planned" ${!task || task.status === "planned" ? "selected" : ""}>计划中</option><option value="active" ${task?.status === "active" ? "selected" : ""}>进行中</option><option value="done" ${task?.status === "done" ? "selected" : ""}>已完成</option></select></div>
      <div class="form-field full"><label>目标完成时间</label><input id="planTaskDueInput" value="${escapeHtml(task?.dueAt || "")}" placeholder="可留空，例如：2026-07-08 18:00"></div>
      <div class="form-field full"><label>验收目标</label><input id="planTaskTargetInput" value="${escapeHtml(task?.target || "")}" placeholder="做到什么程度才算完成"></div>
      <div class="form-field full"><label>执行说明</label><textarea id="planTaskDescriptionInput" rows="5" placeholder="写清动作、口径、资料和复盘标准">${escapeHtml(task?.description || "")}</textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="savePlanTaskButton" data-editing-id="${escapeHtml(task?.id || "")}">${editing ? "保存修改" : "保存任务"}</button>`);
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
  const payload = {
    title,
    phase: qs<HTMLInputElement>("#planTaskPhaseInput")?.value.trim() || "计划任务",
    category: qs<HTMLInputElement>("#planTaskCategoryInput")?.value.trim() || "客户开发",
    priority: (qs<HTMLSelectElement>("#planTaskPriorityInput")?.value || "normal") as PlanTask["priority"],
    status: (qs<HTMLSelectElement>("#planTaskStatusInput")?.value || "planned") as PlanTask["status"],
    dueAt: qs<HTMLInputElement>("#planTaskDueInput")?.value.trim() || "",
    target: qs<HTMLInputElement>("#planTaskTargetInput")?.value.trim() || "",
    description: qs<HTMLTextAreaElement>("#planTaskDescriptionInput")?.value.trim() || ""
  };
  const result = await api<{ task: PlanTask }>(editingId ? `/api/plan-tasks/${editingId}` : "/api/plan-tasks", {
    method: editingId ? "PATCH" : "POST",
    body: JSON.stringify(payload)
  });
  state.planTasks = editingId ? state.planTasks.map((task) => task.id === result.task.id ? result.task : task) : [result.task, ...state.planTasks];
  renderPlanTasks(state.planTasks);
  closeModal();
  toast(editingId ? "计划任务已保存" : "计划任务已新增");
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
  if (!id || !window.confirm("确认删除这条模板？已生成的计划任务不会被删除。")) return;
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
  if (!id || !window.confirm("确认删除这条计划任务？")) return;
  await api(`/api/plan-tasks/${id}`, { method: "DELETE" });
  state.planTasks = state.planTasks.filter((task) => task.id !== id);
  state.selectedPlanTaskIds = state.selectedPlanTaskIds.filter((item) => item !== id);
  renderPlanTasks(state.planTasks);
  toast("计划任务已删除");
}

async function pushPlanTasksToTodos(ids: string[], button?: HTMLButtonElement) {
  const tasks = ids.map((id) => state.planTasks.find((task) => task.id === id)).filter(Boolean) as PlanTask[];
  const pending = tasks.filter((task) => task.status !== "done");
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
          related: `计划任务 / ${task.phase}`
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

async function saveInstrumentPlanMemo(button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "写入中";
  }
  try {
    const existing = state.memos.find((memo) => memo.title === instrumentMemoTitle);
    const taskLines = state.planTasks.length
      ? state.planTasks.map((task, index) => `${index + 1}. [${planTaskStatusText(task.status)}][${planTaskPriorityText(task.priority)}] ${task.title} - ${task.target || task.description || "待补充目标"}`).join("\n")
      : instrumentWeekTodos.map((title, index) => `${index + 1}. ${title}`).join("\n");
    const payload = {
      title: instrumentMemoTitle,
      category: "计划任务",
      tags: "计划任务,外贸开拓,执行计划",
      content: `${instrumentPlanMemoContent()}\n\n当前计划任务：\n${taskLines}`,
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

function exportInstrumentPlanCsv() {
  const taskRows = state.planTasks.length
    ? state.planTasks.map((task) => [task.phase, task.title, planTaskPriorityText(task.priority), planTaskStatusText(task.status), task.dueAt || "", task.target || "", task.description || ""])
    : instrumentWeekTodos.map((title, index) => ["首周执行", title, index < 4 ? "高优先级" : index < 8 ? "中优先级" : "普通", "计划中", "", "完成后在CRM更新结果与下一动作", ""]);
  const rows = [
    ["阶段", "任务", "优先级", "状态", "目标完成时间", "验收目标", "执行说明"],
    ["90天目标", "目标客户池", "高优先级", "计划中", "", "600+", "按国家、客户类型、产品线维护到CRM"],
    ["90天目标", "有效触达", "高优先级", "计划中", "", "900+", "邮件、LinkedIn、WhatsApp、企业微信等渠道记录"],
    ["90天目标", "有效回复", "中优先级", "计划中", "", "60", "有需求、参数、采购计划或后续沟通意愿"],
    ["90天目标", "RFQ/样品/会议机会", "中优先级", "计划中", "", "8", "进入报价、样品、线上会议或项目清单阶段"],
    ["每日动作", "新增客户", "高优先级", "计划中", "", "30家/天", "经销商、系统集成商、OEM、EPC、MRO、终端工程师"],
    ["每日动作", "首触达", "高优先级", "计划中", "", "20家/天", "按角色发送对应英文话术"],
    ["每日动作", "二次跟进", "中优先级", "计划中", "", "10家/天", "补资料、问参数、推进到有效回复"],
    ["每日动作", "深挖A类客户", "中优先级", "计划中", "", "3家/天", "查官网、联系人、产品线、项目线索和竞品"],
    ["前置知识", "关键参数", "高优先级", "计划中", "", "必须掌握", "量程、精度、介质、温压、连接、输出、供电、防护、材质"],
    ["前置知识", "认证资料", "中优先级", "计划中", "", "资料化", "CE、RoHS、EMC、ATEX/IECEx、防爆、SIL、校准证书、ISO、材质报告"],
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

function openCustomerModal(customer?: Customer) {
  const editing = Boolean(customer);
  const stageOptions = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"];
  openModal(editing ? "编辑客户" : "新增客户", `
    <div class="form-grid">
      <div class="form-field full"><label>公司名</label><input id="customerCompanyInput" placeholder="例如：示例仪表进出口有限公司" value="${escapeHtml(customer?.company || "")}"></div>
      <div class="form-field"><label>联系人</label><input id="customerContactInput" value="${escapeHtml(customer?.contact || "待维护")}"></div>
      <div class="form-field"><label>国家</label><input id="customerCountryInput" value="${escapeHtml(customer?.country || "中国")}"></div>
      <div class="form-field"><label>阶段</label><select id="customerStageInput">${stageOptions.map((stage) => `<option ${stage === customer?.stage ? "selected" : ""}>${stage}</option>`).join("")}</select></div>
      <div class="form-field"><label>预计金额</label><input id="customerAmountInput" type="number" value="${customer?.amount ?? 12000}"></div>
      <div class="form-field"><label>下一提醒</label><input id="customerReminderInput" value="${escapeHtml(customer?.nextReminder || "明天 10:00")}"></div>
      <label class="form-field"><span>企微绑定</span><select id="customerWecomInput"><option value="false" ${customer?.wecomBound ? "" : "selected"}>未绑定</option><option value="true" ${customer?.wecomBound ? "selected" : ""}>已绑定</option></select></label>
      <div class="form-field full"><label>单据抬头</label><input id="customerBillingNameInput" value="${escapeHtml(customer?.billingName || customer?.company || "")}" placeholder="用于对外单据的英文/正式公司名"></div>
      <div class="form-field full"><label>账单地址</label><input id="customerBillingAddressInput" value="${escapeHtml(customer?.billingAddress || "")}" placeholder="公司地址、城市、国家"></div>
      <div class="form-field full"><label>单据联系人</label><input id="customerDocumentContactInput" value="${escapeHtml(customer?.documentContact || customer?.contact || "")}" placeholder="联系人 / 邮箱 / 电话"></div>
      <div class="form-field"><label>默认目的港</label><input id="customerPortDischargeInput" value="${escapeHtml(customer?.defaultPortDischarge || "")}" placeholder="例如 Hamburg"></div>
      <div class="form-field"><label>默认贸易条款</label><input id="customerIncotermInput" value="${escapeHtml(customer?.defaultIncoterm || "FOB Tianjin")}"></div>
      <div class="form-field full"><label>默认付款条款</label><input id="customerPaymentTermInput" value="${escapeHtml(customer?.defaultPaymentTerm || "30% T/T deposit, 70% before shipment")}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCustomerButton" data-editing-id="${escapeHtml(customer?.id || "")}">${editing ? "保存修改" : "保存客户"}</button>`);
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
  const saveButton = qs<HTMLButtonElement>("#saveCustomerButton");
  const editingId = saveButton?.dataset.editingId || "";
  const payload = {
    company,
    contact: qs<HTMLInputElement>("#customerContactInput")?.value || "待维护",
    country: qs<HTMLInputElement>("#customerCountryInput")?.value || "未知",
    stage: qs<HTMLSelectElement>("#customerStageInput")?.value || "询盘",
    amount: Number(qs<HTMLInputElement>("#customerAmountInput")?.value || 0),
    nextReminder: qs<HTMLInputElement>("#customerReminderInput")?.value || "明天 10:00",
    wecomBound: qs<HTMLSelectElement>("#customerWecomInput")?.value === "true",
    billingName: qs<HTMLInputElement>("#customerBillingNameInput")?.value.trim() || company,
    billingAddress: qs<HTMLInputElement>("#customerBillingAddressInput")?.value.trim() || "",
    documentContact: qs<HTMLInputElement>("#customerDocumentContactInput")?.value.trim() || qs<HTMLInputElement>("#customerContactInput")?.value || "待维护",
    defaultPortDischarge: qs<HTMLInputElement>("#customerPortDischargeInput")?.value.trim() || "",
    defaultIncoterm: qs<HTMLInputElement>("#customerIncotermInput")?.value.trim() || "FOB Tianjin",
    defaultPaymentTerm: qs<HTMLInputElement>("#customerPaymentTermInput")?.value.trim() || "30% T/T deposit, 70% before shipment"
  };
  const result = await api<{ customer: Customer }>(editingId ? `/api/customers/${editingId}` : "/api/customers", {
    method: editingId ? "PATCH" : "POST",
    body: JSON.stringify(payload)
  });
  if (editingId) {
    state.customers = state.customers.map((customer) => customer.id === result.customer.id ? result.customer : customer);
  } else {
    state.customers.unshift(result.customer);
  }
  state.selectedCustomerId = result.customer.id;
  renderCustomers(state.customers);
  void refreshDashboardOnly();
  closeModal();
  toast(editingId ? "客户已保存" : "客户已新增");
}

async function bulkDeleteCustomers() {
  const ids = state.selectedCustomerIds.filter((id) => state.customers.some((customer) => customer.id === id));
  if (!ids.length) {
    toast("请先勾选要删除的客户", "error");
    return;
  }
  const names = state.customers.filter((customer) => ids.includes(customer.id)).map((customer) => customer.company);
  if (!window.confirm(`确认批量删除 ${ids.length} 个客户？\n${names.slice(0, 6).join("、")}${names.length > 6 ? "等" : ""}\n关联商机和待办会同步清理。`)) return;
  const button = qs<HTMLButtonElement>("#customers [data-bulk-delete-customers]");
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "删除中";
    }
    const result = await api<{ deleted: Customer[]; customers: Customer[] }>("/api/customers/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
    state.customers = result.customers;
    state.selectedCustomerIds = [];
    state.selectedCustomerId = state.customers.find((customer) => customer.id === state.selectedCustomerId)?.id || state.customers[0]?.id || null;
    renderCustomers(state.customers);
    void refreshDashboardOnly();
    toast(`已批量删除 ${result.deleted.length} 个客户`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "批量删除客户失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "批量删除";
    }
  }
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
  qs<HTMLButtonElement>("#profileEntryButton")?.addEventListener("click", () => activateNavView("profile", () => renderProfile()));
  qs<HTMLButtonElement>("#profileSaveButton")?.addEventListener("click", (event) => void saveProfileEmailBinding(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#profileTestSmtpButton")?.addEventListener("click", (event) => void sendProfileTestEmail(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#profileRefreshButton")?.addEventListener("click", async () => {
    const result = await api<{ user: User }>("/api/profile");
    updateStoredUser(result.user);
    toast("个人资料已刷新");
  });
  qs<HTMLButtonElement>("#profileOpenProspectsButton")?.addEventListener("click", () => activateNavView("prospect-list", renderProspectList));
  qs<HTMLButtonElement>("#profileOpenSettingsButton")?.addEventListener("click", () => {
    if (state.user && ["admin", "super_admin"].includes(state.user.role)) activateNavView("settings");
    else toast("账号管理仅管理员和超级管理员可进入", "error");
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
  qs<HTMLButtonElement>("#planTaskNewButton")?.addEventListener("click", () => openPlanTaskModal());
  qs<HTMLButtonElement>("#planTaskNewButtonInline")?.addEventListener("click", () => openPlanTaskModal());
  qs<HTMLButtonElement>("#planTaskPushSelectedButton")?.addEventListener("click", (event) => void pushPlanTasksToTodos(state.selectedPlanTaskIds, event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#instrumentMemoButton")?.addEventListener("click", (event) => void saveInstrumentPlanMemo(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#instrumentExportButton")?.addEventListener("click", exportInstrumentPlanCsv);
  qs<HTMLButtonElement>("#batchPriorityButton")?.addEventListener("click", (event) => void batchProcessPriorityTasks(event.currentTarget as HTMLButtonElement));
  qsa<HTMLButtonElement>("#customers .page-head .btn.primary").forEach((button) => {
    if (button.textContent?.includes("新增客户")) button.addEventListener("click", () => openCustomerModal());
  });
  qs<HTMLButtonElement>("#pipeline .page-head .btn.primary")?.addEventListener("click", () => openDealModal());
  qs<HTMLButtonElement>("#reminders .page-head .btn.primary")?.addEventListener("click", openReminderModal);
  qs<HTMLButtonElement>("#chooseCustomerImportButton")?.addEventListener("click", () => qs<HTMLInputElement>("#customerImportInput")?.click());
  qs<HTMLInputElement>("#customerImportInput")?.addEventListener("change", (event) => {
    const fileName = (event.currentTarget as HTMLInputElement).files?.[0]?.name || "未选择文件";
    const label = qs<HTMLElement>("#customerImportFileName");
    if (label) label.textContent = fileName;
  });
  qs<HTMLButtonElement>("#runCustomerImportButton")?.addEventListener("click", (event) => void importCustomersFromFile(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#downloadCustomerTemplateButton")?.addEventListener("click", downloadCustomerTemplate);
  qs<HTMLButtonElement>("#exportCustomersButton")?.addEventListener("click", () => void exportCustomers());
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
    if (button.textContent?.includes("题库维护")) button.addEventListener("click", () => void openQuestionBankPage());
    if (button.textContent?.includes("分类目考试维护")) button.addEventListener("click", openExamCategoryModal);
  });
  qs<HTMLButtonElement>("#backToExamButton")?.addEventListener("click", () => activateNavView("exam"));
  qs<HTMLButtonElement>("#newQuestionButton")?.addEventListener("click", newQuestionDraft);
  qsa<HTMLButtonElement>("#saveQuestionButton, #saveQuestionButtonBottom").forEach((button) => {
    button.addEventListener("click", (event) => void saveQuestion(event.currentTarget as HTMLButtonElement));
  });
  qs<HTMLButtonElement>("#deleteQuestionButton")?.addEventListener("click", () => void deleteBankQuestion(state.selectedQuestionId || ""));
  qs<HTMLButtonElement>("#importQuestionButton")?.addEventListener("click", (event) => void importQuestionBank(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#exportQuestionButton")?.addEventListener("click", () => void exportQuestionBank());
  qs<HTMLInputElement>("#questionImportInput")?.addEventListener("change", (event) => {
    const fileName = (event.currentTarget as HTMLInputElement).files?.[0]?.name || "支持 .xlsx / .xls / .csv 题库";
    const label = qs<HTMLElement>("#questionImportFileName");
    if (label) label.textContent = fileName;
  });
  ["#questionBankCategoryFilter", "#questionBankTypeFilter", "#questionBankSearchInput"].forEach((selector) => {
    qs<HTMLElement>(selector)?.addEventListener("input", () => renderQuestionBankRows(state.examQuestions));
    qs<HTMLElement>(selector)?.addEventListener("change", () => renderQuestionBankRows(state.examQuestions));
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
    if (view === "customers") activateNavView("imports", () => qs<HTMLInputElement>("#customerImportInput")?.click());
  });
  qs<HTMLButtonElement>("#topExportButton")?.addEventListener("click", () => {
    const view = qs<HTMLElement>(".view.active")?.id;
    if (view === "customers") activateNavView("imports", () => void exportCustomers());
  });
  qsa<HTMLButtonElement>("[data-top-view]").forEach((button) => {
    button.addEventListener("click", () => activateNavView(button.dataset.topView || "dashboard"));
  });
  qsa<HTMLButtonElement>(".nav button[data-view]").forEach((button) => {
    button.addEventListener("click", () => activateNavView(button.dataset.view || "dashboard"));
  });
  ["#leadFinderGoalInput", "#leadSearchModeInput", "#leadSearchDepthInput", "#leadSearchLanguageInput", "#leadValidationInput", "#leadProductKeywords", "#leadCountries", "#leadIndustryInput", "#leadCustomerTypes", "#leadExcludeKeywords"].forEach((selector) => {
    qs<HTMLElement>(selector)?.addEventListener("input", renderLeadFinderSearchLinks);
    qs<HTMLElement>(selector)?.addEventListener("change", renderLeadFinderSearchLinks);
  });
  qsa<HTMLInputElement>("[data-lead-source]").forEach((input) => {
    input.addEventListener("change", renderLeadFinderSearchLinks);
  });
  qs<HTMLButtonElement>("#leadFinderStartButton")?.addEventListener("click", (event) => void runLeadFinder(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderStartButtonInline")?.addEventListener("click", (event) => void runLeadFinder(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderSyncButton")?.addEventListener("click", (event) => void syncLeadFinderRows(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderTodoButton")?.addEventListener("click", (event) => void createLeadFinderTodos(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderExportButton")?.addEventListener("click", exportLeadFinderRows);
  qs<HTMLButtonElement>("#leadFinderExportButtonQueue")?.addEventListener("click", exportLeadFinderRows);
  qs<HTMLButtonElement>("#leadFinderSyncButtonSide")?.addEventListener("click", (event) => void syncLeadFinderRows(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderTodoButtonSide")?.addEventListener("click", (event) => void createLeadFinderTodos(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderExportButtonSide")?.addEventListener("click", exportLeadFinderRows);
  qs<HTMLButtonElement>("#leadFinderAiConfigButtonSide")?.addEventListener("click", () => activateNavView("ai-config", () => {
    qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
    toast("已打开 AI 模型配置");
  }));
  qsa<HTMLButtonElement>("[data-lead-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.leadFinderFilter = (button.dataset.leadFilter || "all") as AppState["leadFinderFilter"];
      renderLeadFinder(state.websiteOpportunities);
    });
  });
  qs<HTMLButtonElement>("#leadFinderAiConfigButton")?.addEventListener("click", () => activateNavView("ai-config", () => {
    qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
    toast("已打开 AI 模型配置，保存后回到智能搜客即可启用 AI 解析");
  }));
  qs<HTMLInputElement>("#prospectSearchInput")?.addEventListener("input", renderProspectList);
  qs<HTMLButtonElement>("#prospectOpenFinderButton")?.addEventListener("click", () => activateNavView("lead-finder", () => renderLeadFinder(state.websiteOpportunities)));
  qs<HTMLButtonElement>("#prospectRefreshButton")?.addEventListener("click", async () => {
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-opportunities");
    state.websiteOpportunities = result.opportunities;
    renderProspectList();
    renderLeadFinder(state.websiteOpportunities);
    toast("搜客清单已刷新");
  });
  qs<HTMLButtonElement>("#prospectGenerateMailButton")?.addEventListener("click", generateProspectMailDraft);
  qs<HTMLButtonElement>("#prospectPreviewMailButton")?.addEventListener("click", renderProspectMailPreview);
  qs<HTMLButtonElement>("#prospectSendMailButton")?.addEventListener("click", (event) => void sendProspectDevelopmentEmail(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectTodoButton")?.addEventListener("click", (event) => void createSelectedProspectTodo(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectSyncButton")?.addEventListener("click", (event) => void syncSelectedProspect(event.currentTarget as HTMLButtonElement));
  ["#prospectMailTo", "#prospectMailSubject", "#prospectMailBody"].forEach((selector) => {
    qs<HTMLInputElement | HTMLTextAreaElement>(selector)?.addEventListener("input", renderProspectMailPreview);
  });
  qsa<HTMLButtonElement>("[data-prospect-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.prospectFilter = (button.dataset.prospectFilter || "all") as AppState["prospectFilter"];
      renderProspectList();
    });
  });
  qsa<HTMLButtonElement>("#gptSaveButton, #gptSaveButtonTop").forEach((button) => {
    button.addEventListener("click", (event) => void saveAiConfig(event.currentTarget as HTMLButtonElement));
  });
  qsa<HTMLButtonElement>("#gptTestButton, #gptTestButtonTop").forEach((button) => {
    button.addEventListener("click", (event) => void testAiConfig(event.currentTarget as HTMLButtonElement));
  });
  qs<HTMLButtonElement>("#aiNewConfigButton")?.addEventListener("click", () => newAiConfigDraft(qs<HTMLSelectElement>("#gptProviderSelect")?.value || "openai"));
  qs<HTMLButtonElement>("#aiToggleEnabledButton")?.addEventListener("click", (event) => void toggleAiConfigEnabled(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#aiDeleteConfigButton")?.addEventListener("click", (event) => void deleteAiConfig(event.currentTarget as HTMLButtonElement));
  qsa<HTMLElement>("[data-ai-provider]").forEach((button) => {
    button.addEventListener("click", () => applyAiProviderPreset(button.dataset.aiProvider || "custom"));
  });
  qs<HTMLSelectElement>("#gptProviderSelect")?.addEventListener("change", (event) => {
    applyAiProviderPreset((event.currentTarget as HTMLSelectElement).value);
  });
  qs<HTMLButtonElement>("#gptRevealKeyButton")?.addEventListener("click", (event) => {
    const input = qs<HTMLInputElement>("#gptApiKeyInput");
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
    (event.currentTarget as HTMLButtonElement).textContent = input.type === "password" ? "显示" : "隐藏";
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
    if (button.textContent?.includes("加载名片")) button.addEventListener("click", () => void recognizeOcr({ company: "Demo Instrument Trading Co., Ltd.", contact: "Demo Contact", email: "sales@example.com", country: "中国" }));
    if (button.textContent?.includes("重新识别")) button.addEventListener("click", () => void recognizeOcr());
    if (button.textContent?.includes("工具配置")) button.addEventListener("click", () => toast("OCR 字段映射配置已保存"));
    if (button.textContent?.includes("解析官网")) button.addEventListener("click", (event) => void parseWebsiteOpportunities(event.currentTarget as HTMLButtonElement));
  });
  qs<HTMLButtonElement>("#newDocumentButton")?.addEventListener("click", openNewDocument);
  qs<HTMLButtonElement>("#saveDocumentButton")?.addEventListener("click", () => void saveTradeDocument());
  qs<HTMLButtonElement>("#exportDocumentPdfButton")?.addEventListener("click", () => void exportTradeDocumentPdf());
  qs<HTMLButtonElement>("#addDocumentItemButton")?.addEventListener("click", addDocumentItem);
  qs<HTMLButtonElement>("#refreshDocumentPreviewButton")?.addEventListener("click", () => renderDocumentPreview(collectDocumentDraft()));
  qsa<HTMLButtonElement>("#documentTypeTabs button").forEach((button) => {
    button.addEventListener("click", () => {
      setDocumentType(button.dataset.docType === "CI" ? "CI" : "PI");
      const title = qs<HTMLInputElement>("#docTitleInput");
      if (title && (!title.value || title.value.includes("形式发票") || title.value.includes("商业发票"))) title.value = currentDocumentType() === "PI" ? "新建形式发票 PI" : "新建商业发票 CI";
      renderDocumentPreview(collectDocumentDraft());
    });
  });
  qsa<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("#documents input, #documents select, #documents textarea").forEach((input) => {
    input.addEventListener("input", () => renderDocumentPreview(collectDocumentDraft()));
    input.addEventListener("change", () => renderDocumentPreview(collectDocumentDraft()));
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
    ["搜客清单", "prospect-list"],
    ["开发信", "prospect-list"],
    ["清单", "prospect-list"],
    ["搜客", "lead-finder"],
    ["获客", "lead-finder"],
    ["线索搜索", "lead-finder"],
    ["lead", "lead-finder"],
    ["prospect", "prospect-list"],
    ["ai", "ai-config"],
    ["gpt", "ai-config"],
    ["模型", "ai-config"],
    ["apikey", "ai-config"],
    ["api key", "ai-config"],
    ["AI配置", "ai-config"],
    ["个人", "profile"],
    ["个人主页", "profile"],
    ["个人设置", "profile"],
    ["邮箱", "profile"],
    ["profile", "profile"],
    ["客户", "customers"],
    ["customer", "customers"],
    ["商机", "pipeline"],
    ["pipeline", "pipeline"],
    ["提醒", "reminders"],
    ["reminder", "reminders"],
    ["导入", "imports"],
    ["导出", "imports"],
    ["import", "imports"],
    ["单据", "documents"],
    ["发票", "documents"],
    ["pi", "documents"],
    ["ci", "documents"],
    ["invoice", "documents"],
    ["document", "documents"],
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
