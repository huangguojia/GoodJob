/**
 * 通用工具：DOM 查询、格式化、转义、徽标。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import {
  type AgentConversation, type AgentGovernance, type AgentKnowledgeDocument, type AgentKnowledgeOverview,
  type AgentMemory, type AgentMissionCheckpoint, type AgentRun, type AgentSkill, type AgentTriggerEvent,
  type AgentTriggerRule, type AiModelConfig, type CaseStudy, type CollaborationUser, type CommissionCalculation,
  type CommissionItem, type CommissionOwner, type CommissionProduct, type CommissionRule, type Competitor,
  type Customer, type CustomerMaintenanceFindingsView, type CustomerMaintenancePreview, type CustomerMaintenanceWatch,
  type DailyReport, type DailyReportComment, type DashboardPeriod, type DashboardSummary, type Deal, type DealEvent,
  type DevelopmentEmailDraft, type DevelopmentEmailScenario, type DocumentAssetsResponse, type DocumentDefaultProfile,
  type Exam, type ExamCandidate, type ExamQuestion, type ExamReport, type ExecutiveReport, type IamCapabilitySnapshot,
  type ImportExportJob, type InternalMessage, type KnowledgeAsset, type Lead, type LeadActivity,
  type LeadProviderStatus, type Memo, type MonthlySalesRecord, type OcrJob, type OrganizationIdentityConflictItem,
  type OutreachSequence, type Peer, type PeerRelation, type PlanTask, type PlanTemplate, type ProblemItem,
  type ProcurementContext, type Product, type ProspectAssignee, type ProspectPerformance,
  type ProspectQualificationViewApi, type ProspectScheduleApiRecord, type ProspectStrategySuggestion,
  type QuoteHistoryResponse, type Reminder, type Role, type SalesDistillation, type SalesDistillationSource,
  type SalesPlaybookActivation, type SalesTrainingRun, type Shipment, type Supplier, type SupplierStatus, type Todo,
  type TradeDocument, type User, type WebsiteOpportunity, type WecomMessage, type WhatsAppBinding,
  type WhatsAppMessage, type WhatsAppModes, type WhatsAppThread
} from "./models";
import { type OutreachBatchView } from "./outreach";
import { type LogEntry } from "./logs";

export interface AppState {
  user: User | null;
  iamCapabilities: IamCapabilitySnapshot | null;
  summary: DashboardSummary | null;
  customers: Customer[];
  publicCustomers: Customer[];
  customerPoolCounts: { mineCount: number; publicCount: number };
  customerPoolSearch: string;
  customerPoolGradeFilter: "all" | "A" | "B" | "C" | "D";
  leads: Lead[];
  leadTrash: Lead[];
  leadActivities: LeadActivity[];
  selectedLeadId: string | null;
  leadView: "active" | "trash";
  leadStageFilter: string;
  leadIntentFilter: string;
  leadSourceFilter: string;
  leadFollowFilter: string;
  /** 只看有客户回复的线索（绿色邮箱图标来源） */
  leadReplyFilter: "all" | "replied";
  selectedLeadIds: string[];
  leadSearch: string;
  leadPage: number;
  whatsappThreads: WhatsAppThread[];
  whatsappMessages: WhatsAppMessage[];
  whatsappBinding: WhatsAppBinding | null;
  whatsappModes: WhatsAppModes | null;
  selectedWaCustomerId: string | null;
  waThreadSearch: string;
  todos: Todo[];
  deals: Deal[];
  dealEvents: DealEvent[];
  closedDeals: Deal[];
  closedDealTotal: number;
  closedDealCounts: { won: number; lost: number; revisit: number };
  closedDealPage: number;
  closedDealKeyword: string;
  closedDealStatus: string;
  closedDealMonth: string;
  dealArchive: Deal[];
  dealArchiveTotal: number;
  dealArchiveCounts: { won: number; lost: number };
  dealArchivePage: number;
  dealArchiveKeyword: string;
  dealArchiveStage: string;
  dealArchiveMonth: string;
  selectedDealId: string | null;
  pipelineStageFilter: string;
  pipelineSearch: string;
  pipelineDueFilter: string;
  reminders: Reminder[];
  reminderView: "tasks" | "rules";
  reminderFilter: "pending" | "overdue" | "today" | "future" | "snoozed" | "done";
  jobs: ImportExportJob[];
  tradeDocuments: TradeDocument[];
  globalRouteDocuments: TradeDocument[];
  documentDefaultProfile: DocumentDefaultProfile | null;
  documentAssets: DocumentAssetsResponse;
  documentDefaultsCanManage: boolean;
  documentHistoryPage: number;
  documentHistoryPageCount: number;
  documentHistoryTotal: number;
  quoteHistoryPage: number;
  quoteHistoryPageCount: number;
  quoteHistoryTotal: number;
  quoteHistoryMode: "records" | "product";
  quoteProductAnalysis: QuoteHistoryResponse["productAnalysis"];
  quoteHistoryFocusId: string;
  wecomMessages: WecomMessage[];
  dailyReports: DailyReport[];
  dailyReportOwners: CollaborationUser[];
  dailyReportCanViewTeam: boolean;
  dailyReportComments: DailyReportComment[];
  selectedDailyReportId: string | null;
  dailyReportFrom: string;
  dailyReportTo: string;
  dailyReportOwnerId: string;
  internalMessages: InternalMessage[];
  internalUnreadCount: number;
  knowledgeAssets: KnowledgeAsset[];
  knowledgeSearch: string;
  knowledgeCategoryFilter: string;
  knowledgeSourceFilter: string;
  knowledgeStatusFilter: string;
  knowledgeTypeFilter: string;
  selectedKnowledgeAssetId: string | null;
  exams: Exam[];
  examQuestions: ExamQuestion[];
  examReport: ExamReport | null;
  ocrJob: OcrJob | null;
  websiteOpportunities: WebsiteOpportunity[];
  agentRun: AgentRun | null;
  agentRuns: AgentRun[];
  agentConversations: AgentConversation[];
  agentMissionCheckpoints: AgentMissionCheckpoint[];
  agentMemories: AgentMemory[];
  agentKnowledgeDocuments: AgentKnowledgeDocument[];
  agentKnowledgeOverview: AgentKnowledgeOverview | null;
  agentSkills: AgentSkill[];
  agentSkillDirectory: string;
  agentSkillCanManage: boolean;
  agentTriggerRules: AgentTriggerRule[];
  agentTriggerEvents: AgentTriggerEvent[];
  agentGovernance: AgentGovernance | null;
  agentCheckpointRunId: string;
  outreachSequences: OutreachSequence[];
  customerMaintenanceWatches: CustomerMaintenanceWatch[];
  maintenancePreview: CustomerMaintenancePreview | null;
  maintenanceFindings: Record<string, CustomerMaintenanceFindingsView>;
  maintenanceActiveWatchId: string;
  maintenanceLoading: boolean;
  outreachBatches: OutreachBatchView[];
  agentLoading: boolean;
  salesDistillations: SalesDistillation[];
  salesPlaybookActivations: SalesPlaybookActivation[];
  salesDistillationSources: SalesDistillationSource[];
  salesDistillationLoading: boolean;
  salesTrainingRuns: SalesTrainingRun[];
  aiConfig: AiModelConfig | null;
  aiConfigs: AiModelConfig[];
  selectedAiConfigId: string | null;
  aiDraftMode: boolean;
  products: Product[];
  productCategories: string[];
  shipments: Shipment[];
  logs: LogEntry[];
  selectedProductIds: string[];
  selectedShipmentIds: string[];
  pendingAiDeleteId: string | null;
  problems: ProblemItem[];
  memos: Memo[];
  deletedMemos: Memo[];
  memoStatus: "active" | "archived" | "deleted";
  memoSearch: string;
  memoPinnedOnly: boolean;
  planTasks: PlanTask[];
  planTemplates: PlanTemplate[];
  selectedPlanTaskIds: string[];
  planTaskView: "today" | "week" | "templates";
  planTaskStatusFilter: "open" | "done" | "cancelled" | "all";
  competitors: Competitor[];
  peers: Peer[];
  peerSearch: string;
  peerRelationFilter: "all" | PeerRelation | "未标注";
  peerSort: "newest" | "oldest" | "company";
  peerPage: number;
  peerPageSize: number;
  selectedPeerId: string | null;
  suppliers: Supplier[];
  suppliersLoaded: boolean;
  supplierSearch: string;
  supplierStatusFilter: "all" | SupplierStatus;
  supplierPage: number;
  supplierPageSize: number;
  selectedSupplierId: string | null;
  selectedSupplierIds: string[];
  caseStudies: CaseStudy[];
  commissionProducts: CommissionProduct[];
  commissionRules: CommissionRule[];
  commissionRecords: MonthlySalesRecord[];
  commissionCalculations: CommissionCalculation[];
  commissionItems: CommissionItem[];
  commissionCanManage: boolean;
  commissionCanReview: boolean;
  commissionCanSelectOwner: boolean;
  commissionOwners: CommissionOwner[];
  selectedCommissionOwnerId: string;
  commissionMonth: string;
  commissionFilter: "all" | "draft" | "confirmed";
  selectedCommissionRecordId: string | null;
  selectedCommissionCalculationId: string | null;
  accounts: User[];
  executiveReport: ExecutiveReport | null;
  reportNote: string;
  dashboardPeriod: DashboardPeriod;
  morningView: boolean;
  todoFilter: "all" | "today" | "overdue" | "mine" | "customer" | "history" | "maintenance";
  openTodoMenuId: string | null;
  draggingTodoId: string | null;
  selectedCustomerId: string | null;
  selectedCustomerIds: string[];
  customerSearch: string;
  customerQueueFilter: "all" | "overdue" | "no-activity" | "no-deal";
  customerOutcomeFilter: "open" | "won";
  customerViewMode: "list" | "map" | "board";
  customerPage: number;
  customerPageSize: 20 | 50 | 100;
  selectedProblemId: string | null;
  problemSearch: string;
  problemStatusFilter: "all" | "open" | "solving" | "resolved";
  problemSeverityFilter: "all" | "high" | "medium" | "low";
  problemCategoryFilter: string;
  selectedMemoId: string | null;
  selectedPlanTemplateId: string | null;
  selectedCompetitorId: string | null;
  selectedCaseId: string | null;
  selectedExamId: string | null;
  selectedExamIds: string[];
  examCanManage: boolean;
  examCandidates: ExamCandidate[];
  examWorkspaceMode: "manage" | "mine" | "results";
  selectedQuestionId: string | null;
  selectedDocumentId: string | null;
  selectedLeadFinderId: string | null;
  leadFinderFilter: "all" | "pending" | "high" | "duplicate" | "shortlisted";
  leadFinderPage: number;
  selectedProspectId: string | null;
  selectedProspectIds: string[];
  prospectFilter: "all" | "preview" | "contactable" | "contacted" | "synced" | "excluded";
  /** 只看「有决策人/采购人邮箱」的候选（CLI 获客的准入口径，列表侧可按需收窄） */
  prospectBuyerOnly: boolean;
  prospectJoinedRange: "all" | "today" | "7d" | "30d" | "custom";
  prospectJoinedFrom: string;
  prospectJoinedTo: string;
  prospectSort: "joined_desc" | "joined_asc" | "priority" | "status_changed";
  prospectPage: number;
  prospectAssignees: ProspectAssignee[];
  prospectQualifications: Record<string, ProspectQualificationViewApi>;
  procurementContexts: Record<string, ProcurementContext>;
  prospectPerformance: ProspectPerformance | null;
  prospectStrategySuggestions: ProspectStrategySuggestion[];
  prospectSchedules: ProspectScheduleApiRecord[];
  identityConflicts: OrganizationIdentityConflictItem[];
  leadProviders: LeadProviderStatus[];
  selectedLeadSources: string[];
  leadSourceSelectionTouched: boolean;
}
export const resolvedMemoDrafts = new Set<string>();
export const prospectQualificationLoading = new Set<string>();
export const leadFinderStreamCursors = new Map<string, string>();
// AI 解析得到的自然语言目标结构（英文），预览面板可编辑，启动时直接采用
export interface LeadAiParsed {
  name: string;
  markets: string[];
  products: string[];
  industries: string[];
  customerType: string;
  exclusions: string[];
}
let profileDevelopmentEmailRequestId = "";
export const developmentEmailScenarioDrafts = new Map<DevelopmentEmailScenario, Pick<DevelopmentEmailDraft, "subject" | "body" | "engine"> & { aiGenerated: boolean }>();
export const appliedAgentUiSteps = new Set<string>();
export type PlatformTab = "overview" | "tenants" | "support" | "operators" | "health" | "audit";
let ocrBatchId = "";
export let ocrBatchJobs: OcrJob[] = [];

export const viewLabels: Record<string, string> = {
  dashboard: "工作台",
  todo: "待办中心",
  "lead-finder": "搜客",
  "auto-flow": "自动流获客",
  "lead-task-detail": "任务执行详情",
  "prospect-list": "搜客清单",
  "ai-agent": "AI Agent",
  "integration-center": "集成中心",
  exchange: "对接中心",
  "approval-center": "审批中心",
  "approval-workflows": "审批设置",
  "sales-distillation": "销售训练",
  leads: "线索",
  customers: "客户",
  suppliers: "供应商",
  "customer-pool": "客户公池",
  whatsapp: "即刻沟通",
  "outreach-journey": "发信明细",
  "outreach-customer-journey": "开发信过程",
  "customer-detail": "客户全景",
  "ai-research": "AI背调",
  "development-email": "开发信",
  "email-return-flow": "开发信回流",
  "mail-center": "邮件中心",
  pipeline: "商机",
  orders: "订单",
  "order-detail": "订单详情",
  reminders: "跟进提醒",
  "plan-growth": "计划任务",
  documents: "单据平台",
  "file-center": "文件中心",
  commission: "提成对账",
  leaderboard: "排行",
  reports: "报表",
  knowledge: "资料维护",
  "kb-training": "知识库训练",
  exam: "在线考试",
  "question-bank": "题库维护",
  wecom: "企业微信",
  "daily-reports": "团队日报",
  inbox: "消息通知",
  tools: "小工具",
  competitors: "竞争公司",
  peers: "同行管理",
  cases: "成功案例",
  problems: "问题清单",
  memos: "备忘录",
  imports: "导入导出",
  "database-maintenance": "数据库维护",
  "ai-config": "AI配置",
  "business-card": "名片识别",
  "agent-skills": "Agent Skills",
  "maintenance-center": "自动维护中心",
  "outreach-batches": "自动发信",
  "mail-settings": "邮箱设置",
  "sales-skill-center": "销售技能中心",
  "member-management": "成员管理",
  "organization-structure": "组织架构",
  "role-management": "角色管理",
  "ui-access": "界面开通",
  "member-authorization": "成员授权",
  "permission-audit": "权限审计",
  "platform-operations": "平台运维",
  settings: "系统设置",
  profile: "个人设置"
};

export const aiProviderPresets: Record<string, {
  label: string;
  protocol: AiModelConfig["protocol"];
  baseUrl: string;
  model: string;
  name: string;
}> = {
  openai: { label: "OpenAI", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", name: "OpenAI 业务模型" },
  anthropic: { label: "Claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet-latest", name: "Claude 长文本模型" },
  gemini: { label: "Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.0-flash", name: "Gemini 国际化模型" },
  deepseek: { label: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", name: "DeepSeek 搜客解析模型" },
  qwen: { label: "通义千问", protocol: "openai-compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", name: "通义千问业务模型" },
  moonshot: { label: "Kimi", protocol: "openai-compatible", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", name: "Kimi 业务模型" },
  zhipu: { label: "智谱GLM", protocol: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash-250414", name: "智谱GLM免费版" },
      siliconflow: { label: "硅基流动", protocol: "openai-compatible", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3", name: "硅基流动免费额度" },
  baidu: { label: "百度千帆", protocol: "openai-compatible", baseUrl: "https://qianfan.baidubce.com/v2", model: "ernie-4.0-turbo-8k", name: "百度千帆业务模型" },
  volcengine: { label: "豆包", protocol: "openai-compatible", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-pro-32k", name: "豆包业务模型" },
  mistral: { label: "Mistral", protocol: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest", name: "Mistral 业务模型" },
  groq: { label: "Groq", protocol: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.1-70b-versatile", name: "Groq 高速模型" },
  openrouter: { label: "OpenRouter", protocol: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", name: "OpenRouter 聚合模型" },
  ollama: { label: "Ollama", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", name: "本地 Ollama 模型" },
  custom: { label: "自定义", protocol: "openai-compatible", baseUrl: "https://example.com/v1", model: "your-model-name", name: "自定义兼容模型" }
};

export const roleLabel: Record<Role, string> = {
  sales: "业务员",
  manager: "销售主管",
  admin: "管理员",
  super_admin: "超级管理员"
};

export const storage = {
  user: "gj_user",
  dashboardCache: "gj_dashboard_cache",
  workspaceView: "gj_workspace_view"
};

export function newAgentConversationId() {
  return `agc_${crypto.randomUUID()}`;
}

export function cookieValue(name: string) {
  return document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

export function qs<T extends Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector(selector) as T | null;
}

export function qsa<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll(selector)] as T[];
}

export function setFieldValue(selector: string, value: string) {
  const input = qs<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
  if (input) input.value = value;
}

export function money(value: number) {
  if (Math.abs(value) >= 1000) return `$${Number((value / 1000).toFixed(value % 1000 === 0 ? 0 : 1))}k`;
  return `$${Math.round(value)}`;
}

export function amount(value: number) {
  return `$${value.toLocaleString("en-US")}`;
}

export function currencyAmount(value: number, currency = "CNY") {
  return `${escapeHtml(currency)} ${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function currentDateTimeText() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function currentLocalDateIso() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function renderDashboardCurrentDate() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  // 页头是一块「案头日历」：星期、日、月分三层显示，不是一个 2026.10.29 的字符串。
  // 拆开后日期格才能又小又好读，也让「今天」成为第一眼看到的信息。
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  const day = qs<HTMLElement>("#dashboardCurrentDate");
  if (day) day.textContent = pad(date.getDate());
  const week = qs<HTMLElement>("#dashboardWeekday");
  if (week) week.textContent = weekday;
  const month = qs<HTMLElement>("#dashboardMonthLabel");
  if (month) month.textContent = `${date.getMonth() + 1} 月 · ${date.getFullYear()}`;
}

function todayStart() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function parseTodoDate(value: string) {
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

export function activeTodos(todos: Todo[]) {
  return sortTodos(todos.filter((todo) => !isHistoricalTodo(todo)));
}

export function historyTodos(todos: Todo[]) {
  return sortTodos(todos.filter(isHistoricalTodo));
}

export function badge(text: string, tone = "") {
  return `<span class="badge ${tone}">${text}</span>`;
}

export function todoTypeText(type: string) {
  const map: Record<string, string> = {
    customer: "客户跟进",
    knowledge: "资料维护",
    exam: "在线考试",
    ocr: "OCR 线索",
    other: "其它"
  };
  return map[type] || "其它";
}

export function escapeHtml(value: string | number | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

export function leadFinderDisplayText(value: string | undefined) {
  return String(value || "")
    .replace(/爬取境外官网/gu, "核验境外官网公开资料")
    .replace(/(?:受控)?低频(?:官网)?验证/gu, "官网公开资料核验")
    .replace(/官网(?:爬取|抓取|探针)/gu, "官网公开资料核验")
    .replace(/爬虫|爬取|抓取|抓官网/gu, "公开资料核验")
    .replace(/robots\.txt/giu, "网站公开访问规则")
    .replace(/探针/gu, "资料核验")
    .replace(/低频/gu, "")
    .replace(/\b(?:web\s*)?crawlers?\b/giu, "public information service")
    .replace(/\b(?:web\s*)?scrap(?:e|es|ed|ing)\b/giu, "review public information")
    .replace(/\bspiders?\b/giu, "public information service");
}
