/**
 * 工作台：汇率、晨报、竞标日报、线索漏斗、待办、排行榜。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import * as echarts from "echarts";
import { isLeadSourceAutoSelected } from "../lead-source-selection";
import { activateNavView, confirmAction, createCliAcquireJob, loadProspectRuns, renderMemos, renderProspectList, state } from "../prototype-api";
import {
  type AiEngineJobView, type AiModelConfig, type CaseStudy, type CommissionCalculation, type CommissionItem,
  type CommissionOwner, type CommissionProduct, type CommissionRule, type Competitor, type Customer,
  type DashboardSummary, type Deal, type DealEvent, type DocumentAssetsResponse, type DocumentDefaultProfile,
  EXCHANGE_RATE_REFRESH_MS, type Exam, type ExamCandidate, type ExamReport, type ImportExportJob, type KnowledgeAsset,
  type Lead, type LeadProviderStatus, type Memo, type MonthlySalesRecord, type OcrJob, type Peer, type PlanTask,
  type PlanTemplate, type ProblemItem, type Product, type ProspectAssignee, type Reminder, type Shipment,
  type TodayExchangeRates, type Todo, type TradeDocument, type User, type WebsiteOpportunity, type WecomMessage
} from "./models";
import { renderCustomerPool, renderCustomers } from "./customers";
import {
  renderSuperAiDiscoveryOption, renderSuperMapSearchOption, renderSuperWebSearchOption, renderWebsiteOpportunities,
  websiteDomain
} from "./prospecting";
import { renderExams } from "./exams";
import {
  type AppState, activeTodos, badge, currentLocalDateIso, escapeHtml, historyTodos, money, parseTodoDate, qs, qsa,
  setFieldValue, storage, todoTypeText
} from "./shared";
import { loadIdentityConflicts, loadProspectFeedback, loadProspectSchedules, renderLeadFinderJobs, scheduleWebsiteProbeRefresh } from "./lead-finder";
import { cliWaitPanelHtml, startCliWaitTicker } from "./ai-engine-settings";
import { loadAgentConversations, loadAgentRuns, renderAgent } from "./agent";
import { renderAccounts } from "./access-control";
import { loadIamCapabilities, refreshPlatformOperations } from "./platform-approvals";
import { renderAiConfig, renderOcr } from "./tools";
import { api, setButtonPending, toast } from "./ui";
import { renderLeads } from "./leads";
import { formatDateTime, refreshClosedDeals, renderPipeline } from "./deals";
import { renderCommission } from "./commission";
import { openReminderTaskResult, renderCaseStudies, renderCompetitors, renderPeers, renderProblems, renderReminders } from "./workspace";
import { renderJobs, renderTradeDocuments } from "./trade-documents";
import { renderWecom } from "./wecom";
import { renderKnowledge } from "./knowledge";
import { renderProducts } from "./products";
import { renderShipments } from "./shipments";
import { type CliAcquirePayload, renderLeadFinder, renderLeadSourceChips, restoreCliAcquireJobs, runCliAcquireJob } from "./lead-sources";
import { openTodoModal, renderPlanTasks, renderPlanTemplates } from "./plan-tasks";
import { refreshDailyReports, refreshInternalMessages } from "./collaboration";
import { renderTopbarStats } from "./navigation";

let dashboardLeadFunnelChart: ReturnType<typeof echarts.init> | null = null;
/** 上一次成功渲染的漏斗：同一节点、数据与主题配色都没变时复用，见 renderLeadFunnel */
let leadFunnelRendered: { element: HTMLElement; signature: string } | null = null;
let dashboardLeadFunnelResizeObserver: ResizeObserver | null = null;
let dashboardRefreshPromise: Promise<void> | null = null;
let leadProvidersLoadedAt = 0;
let leadProvidersInFlight: Promise<void> | null = null;

export async function refreshAll(user: User) {
  await loadIamCapabilities(user);
  if (state.iamCapabilities?.source === "platform") {
    await refreshPlatformOperations();
    return;
  }
  renderDashboardCache(user);
  const [summary, customers, publicCustomers, leadsResp, leadTrashResp, todos, deals, reminders, jobs, tradeDocs, documentDefaults, documentAssets, wecom, knowledge, exams, ocr, websiteOps, prospectAssignees, aiConfig, problems, memos, deletedMemos, planTasks, planTemplates, competitors, peers, caseStudies, commissionProducts, commissionRecords, commissionCalculations] = await Promise.all([
    api<DashboardSummary>("/api/dashboard/summary"),
    api<{ customers: Customer[]; mineCount: number; publicCount: number }>("/api/customers"),
    api<{ customers: Customer[]; mineCount: number; publicCount: number }>("/api/customers?scope=public"),
    api<{ leads: Lead[] }>("/api/leads"),
    api<{ leads: Lead[] }>("/api/leads?trash=true"),
    api<{ todos: Todo[] }>("/api/todos"),
    api<{ deals: Deal[]; events: DealEvent[] }>("/api/deals"),
    api<{ reminders: Reminder[] }>("/api/reminders"),
    api<{ jobs: ImportExportJob[] }>("/api/import-export/jobs"),
    api<{ documents: TradeDocument[] }>("/api/trade-documents"),
    api<{ profile: DocumentDefaultProfile; canManage: boolean }>("/api/document-defaults"),
    api<DocumentAssetsResponse>("/api/document-assets"),
    api<{ messages: WecomMessage[] }>("/api/wecom/messages"),
    api<{ assets: KnowledgeAsset[] }>("/api/knowledge/assets"),
    api<{ exams: Exam[]; report: ExamReport; canManage: boolean; candidates: ExamCandidate[] }>("/api/exams"),
    api<{ job: OcrJob }>("/api/tools/ocr/jobs/current"),
    api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-opportunities"),
    api<{ assignees: ProspectAssignee[] }>("/api/prospect-list/assignees"),
    api<{ config: AiModelConfig | null; configs?: AiModelConfig[] }>("/api/tools/ai-config"),
    api<{ problems: ProblemItem[] }>("/api/problems"),
    api<{ memos: Memo[] }>("/api/memos"),
    api<{ memos: Memo[] }>("/api/memos?trash=true"),
    api<{ tasks: PlanTask[] }>("/api/plan-tasks"),
    api<{ templates: PlanTemplate[] }>("/api/plan-templates"),
    api<{ competitors: Competitor[] }>("/api/competitors"),
    api<{ peers: Peer[] }>("/api/peers"),
    api<{ caseStudies: CaseStudy[] }>("/api/case-studies"),
    api<{ products: CommissionProduct[]; rules: CommissionRule[]; canManage: boolean; canSelectOwner: boolean; owners: CommissionOwner[] }>("/api/commission/products"),
    api<{ records: MonthlySalesRecord[]; owners?: CommissionOwner[]; canSelectOwner?: boolean; selectedOwnerId?: string }>(`/api/commission/sales-records?month=${encodeURIComponent(state.commissionMonth)}&ownerId=${encodeURIComponent(state.selectedCommissionOwnerId || "")}`),
    api<{ calculations: CommissionCalculation[]; items: CommissionItem[]; canReview: boolean; canSelectOwner?: boolean; owners?: CommissionOwner[]; selectedOwnerId?: string }>(`/api/commission/calculations?month=${encodeURIComponent(state.commissionMonth)}&ownerId=${encodeURIComponent(state.selectedCommissionOwnerId || "")}`)
  ]);
  state.user = user;
  state.summary = summary;
  state.customers = customers.customers;
  state.publicCustomers = publicCustomers.customers;
  state.customerPoolCounts = { mineCount: customers.mineCount, publicCount: publicCustomers.publicCount };
  state.leads = leadsResp.leads;
  state.leadTrash = leadTrashResp.leads;
  state.todos = todos.todos;
  state.deals = deals.deals;
  state.dealEvents = deals.events;
  state.reminders = reminders.reminders;
  state.jobs = jobs.jobs;
  state.tradeDocuments = tradeDocs.documents;
  state.documentDefaultProfile = documentDefaults.profile;
  state.documentDefaultsCanManage = documentDefaults.canManage;
  state.documentAssets = documentAssets;
  state.wecomMessages = wecom.messages;
  state.knowledgeAssets = knowledge.assets;
  state.exams = exams.exams;
  state.examReport = exams.report;
  state.examCanManage = exams.canManage;
  state.examCandidates = exams.candidates || [];
  state.examWorkspaceMode = exams.canManage ? "manage" : "mine";
  state.ocrJob = ocr.job;
  state.websiteOpportunities = websiteOps.opportunities;
  state.prospectAssignees = prospectAssignees.assignees;
  state.aiConfig = aiConfig.config;
  state.aiConfigs = aiConfig.configs || (aiConfig.config ? [aiConfig.config] : []);
  state.selectedAiConfigId = state.selectedAiConfigId && state.aiConfigs.some((item) => item.id === state.selectedAiConfigId)
    ? state.selectedAiConfigId
    : state.aiConfig?.id || state.aiConfigs[0]?.id || null;
  state.problems = problems.problems;
  state.memos = memos.memos;
  state.deletedMemos = deletedMemos.memos;
  state.planTasks = planTasks.tasks;
  state.planTemplates = planTemplates.templates;
  state.competitors = competitors.competitors;
  state.peers = peers.peers;
  state.caseStudies = caseStudies.caseStudies;
  state.commissionProducts = commissionProducts.products;
  state.commissionRules = commissionProducts.rules;
  state.commissionCanManage = commissionProducts.canManage;
  state.commissionCanSelectOwner = commissionProducts.canSelectOwner;
  state.commissionOwners = commissionProducts.owners || commissionRecords.owners || commissionCalculations.owners || [];
  state.selectedCommissionOwnerId = state.commissionCanSelectOwner
    ? (commissionRecords.selectedOwnerId || commissionCalculations.selectedOwnerId || state.selectedCommissionOwnerId || "all")
    : (state.user?.id || "");
  state.commissionRecords = commissionRecords.records;
  state.commissionCalculations = commissionCalculations.calculations;
  state.commissionItems = commissionCalculations.items;
  state.commissionCanReview = commissionCalculations.canReview;
  const productsResp = await api<{ products: Product[]; categories: string[] }>("/api/tools/products").catch(() => ({ products: state.products || [], categories: state.productCategories || [] }));
  state.products = productsResp.products;
  state.productCategories = productsResp.categories || [];
  renderProducts();
  const shipmentsResp = await api<{ shipments: Shipment[] }>("/api/tools/shipments").catch(() => ({ shipments: state.shipments || [] }));
  state.shipments = shipmentsResp.shipments;
  renderShipments();
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
  renderCustomerPool();
  renderLeads();
  renderPipeline(deals.deals);
  void refreshClosedDeals();
  renderReminders(reminders.reminders);
  renderJobs(jobs.jobs);
  renderTradeDocuments(tradeDocs.documents);
  renderWecom(wecom.messages);
  renderKnowledge(knowledge.assets);
  renderExams(exams.exams);
  renderDashboardKnowledgePanels(knowledge.assets, exams.exams);
  renderProblems(problems.problems);
  renderMemos();
  renderPlanTasks(planTasks.tasks);
  renderPlanTemplates(planTemplates.templates);
  renderCompetitors(competitors.competitors);
  renderPeers();
  renderCaseStudies(caseStudies.caseStudies);
  renderCommission();
  await renderAccounts(user);
  renderOcr(ocr.job);
  renderAiConfig(state.aiConfig);
  renderAgent(state.agentRun);
  void loadAgentRuns();
  void loadAgentConversations();
  renderWebsiteOpportunities(state.websiteOpportunities);
  renderLeadFinder(state.websiteOpportunities);
  renderProspectList();
  renderTopbarStats();
  await Promise.all([
    refreshDailyReports(false),
    refreshInternalMessages(false)
  ]);
  void loadLeadProviders();
  void loadProspectFeedback(true, true);
  void loadProspectSchedules(true);
  scheduleWebsiteProbeRefresh();
  void loadIdentityConflicts(true);
  void loadProspectRuns(true);
  void restoreCliAcquireJobs();
}

export async function loadLeadProviders(force = false) {
  if (!force
    && state.leadProviders.length
    && Date.now() - leadProvidersLoadedAt < 30_000) return;
  if (leadProvidersInFlight) return leadProvidersInFlight;
  leadProvidersInFlight = (async () => {
    try {
      const result = await api<{ providers: LeadProviderStatus[] }>("/api/lead-finder/providers");
      state.leadProviders = result.providers || [];
      leadProvidersLoadedAt = Date.now();
      if (!state.leadSourceSelectionTouched) {
        // 默认启用已配置 API 与可用 AI；内置免费源保留为手动选择，避免默认结果质量不可控。
        state.selectedLeadSources = state.leadProviders.filter(isLeadSourceAutoSelected).map((item) => item.id);
      }
      renderLeadSourceChips();
      renderSuperWebSearchOption();
      renderSuperMapSearchOption();
      renderSuperAiDiscoveryOption();
      renderLeadFinderJobs();
    } catch {
      // 数据源加载失败时保留最近一次可用状态，由启动校验给出明确提示。
    }
  })();
  try {
    await leadProvidersInFlight;
  } finally {
    leadProvidersInFlight = null;
  }
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

let exchangeRatesInFlight: Promise<void> | null = null;
let exchangeRatesLoadedAt = 0;

function exchangeRateDateLabel(date: string) {
  const today = currentLocalDateIso();
  return date === today ? "今日参考汇率" : `最新交易日 ${date}`;
}

function renderExchangeTickerContent(content: string) {
  const track = qs<HTMLElement>("#dashboardExchangeTicker");
  if (!track) return;
  track.innerHTML = `<div class="dashboard-ticker-segment">${content}</div><div class="dashboard-ticker-segment" aria-hidden="true">${content}</div>`;
}

function renderExchangeTickerStatus(label: string, message: string) {
  renderExchangeTickerContent(`<span class="dashboard-ticker-label">${escapeHtml(label)}</span><b>///</b><span class="dashboard-rate-empty">${escapeHtml(message)}</span>`);
}

function renderExchangeTicker(rates: TodayExchangeRates) {
  const label = exchangeRateDateLabel(rates.date);
  const items = rates.rates
    .filter((rate) => Number.isFinite(rate.value) && rate.value > 0)
    .map((rate) => `<span class="dashboard-rate"><span class="dashboard-rate-key">${escapeHtml(rate.pair)}</span><strong class="dashboard-rate-value">${rate.value.toFixed(rate.decimals)}</strong></span>`)
    .join(`<b>///</b>`);
  renderExchangeTickerContent(`<span class="dashboard-ticker-label">${escapeHtml(label)}</span><b>///</b>${items || `<span class="dashboard-rate-empty">暂无报价</span>`}<b>///</b><span class="dashboard-rate-meta" title="数据源：${escapeHtml(rates.source)}；公开参考汇率仅提供最近一个交易日">公开参考源 · 仅提供最近一个交易日</span>`);
}

export async function refreshExchangeTicker(force = false) {
  if (!state.user || !qs<HTMLElement>("#dashboardExchangeTicker")) return;
  if (!force && Date.now() - exchangeRatesLoadedAt < EXCHANGE_RATE_REFRESH_MS) return;
  if (exchangeRatesInFlight) return exchangeRatesInFlight;
  if (!exchangeRatesLoadedAt) renderExchangeTickerStatus("汇率数据", "正在读取");
  exchangeRatesInFlight = (async () => {
    try {
      const rates = await api<TodayExchangeRates>("/api/exchange-rates/today");
      renderExchangeTicker(rates);
    } catch {
      renderExchangeTickerStatus("汇率数据", "今日参考汇率暂不可用");
    } finally {
      exchangeRatesLoadedAt = Date.now();
    }
  })();
  try {
    await exchangeRatesInFlight;
  } finally {
    exchangeRatesInFlight = null;
  }
}

export async function refreshDashboardOnly() {
  const user = state.user;
  if (!user) return;
  if (dashboardRefreshPromise) return dashboardRefreshPromise;
  dashboardRefreshPromise = (async () => {
    const [summary, todos, customers] = await Promise.all([
      api<DashboardSummary>("/api/dashboard/summary"),
      api<{ todos: Todo[] }>("/api/todos"),
      api<{ customers: Customer[] }>("/api/customers")
    ]);
    if (state.user?.id !== user.id) return;
    state.summary = summary;
    state.todos = todos.todos;
    state.customers = customers.customers;
    writeDashboardCache(user, summary, todos.todos, customers.customers);
    renderDashboard(summary, todos.todos, customers.customers);
    renderTopbarStats();
    void refreshExchangeTicker();
  })();
  try {
    await dashboardRefreshPromise;
  } finally {
    dashboardRefreshPromise = null;
  }
}

export function requestDashboardRefresh() {
  void refreshDashboardOnly().catch(() => {
    // Background refresh failures should not interrupt the current workflow.
  });
}

export function refreshVisibleDashboard() {
  if (!state.user || document.visibilityState !== "visible") return;
  if (qs<HTMLElement>(".view.active")?.id !== "dashboard") return;
  requestDashboardRefresh();
}

export function renderDashboard(summary: DashboardSummary, todos: Todo[], customers: Customer[], fromCache = false) {
  const businessScopes = state.iamCapabilities?.permissions["workspace.dashboard.read"] || [];
  const roleBusinessScope = businessScopes.includes("tenant") ? "全公司业务"
    : businessScopes.includes("org_subtree") || businessScopes.includes("org_unit") ? "组织业务" : "本人业务";
  const scopeLabels = summary.scopeLabels || {
    business: roleBusinessScope,
    todos: "本人待办"
  };
  qs("#scopeText")!.textContent = summary.scope;
  qs<HTMLElement>("#businessScopeTag")!.textContent = scopeLabels.business;
  qs<HTMLElement>("#todoScopeTag")!.textContent = scopeLabels.todos;
  qsa<HTMLElement>("[data-business-scope]").forEach((node) => {
    node.textContent = scopeLabels.business;
  });
  const period = summary.periods?.[state.dashboardPeriod] || {
    label: "今日",
    start: summary.updatedAt.slice(0, 10),
    end: summary.updatedAt.slice(0, 10),
    expectedDeals: summary.briefing.closableDeals,
    expectedAmounts: [{ currency: "USD", amount: summary.briefing.closableAmount }],
    pendingTodos: summary.metrics.todos,
    highPriorityTodos: summary.metrics.overdueTodos,
    newLeads: summary.leadFunnel.todayAdded,
    briefing: {
      title: summary.briefing.title,
      description: summary.briefing.description,
      basis: summary.briefing.basis,
      action: summary.briefing.action,
      impact: summary.briefing.impact
    }
  };
  qsa<HTMLButtonElement>("[data-dashboard-period]").forEach((button) => {
    const active = button.dataset.dashboardPeriod === state.dashboardPeriod;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  qs<HTMLElement>("#dashboardUpdatedAt")!.textContent = fromCache ? "缓存数据 · 后台刷新中" : `${formatTime(summary.updatedAt)} 已更新`;
  qs<HTMLElement>(".focus-title h2")!.textContent = period.briefing.title;
  qs<HTMLElement>(".focus-title p")!.textContent = period.briefing.description;
  const basis = qs<HTMLElement>("#briefingBasis");
  const action = qs<HTMLElement>("#briefingAction");
  const impact = qs<HTMLElement>("#briefingImpact");
  if (basis) basis.textContent = period.briefing.basis;
  if (action) action.textContent = period.briefing.action;
  if (impact) impact.textContent = period.briefing.impact;
  const focusMetrics = qsa<HTMLElement>(".focus-metric");
  if (focusMetrics[0]) focusMetrics[0].innerHTML = `<span>当前高风险金额 · ${escapeHtml(scopeLabels.business)}</span><b>${money(summary.briefing.riskAmount)}</b><small>${escapeHtml(summary.briefing.riskLabel)} · 实时快照</small>`;
  if (focusMetrics[1]) focusMetrics[1].innerHTML = `<span>${escapeHtml(period.label)}高优先级待办 · ${escapeHtml(scopeLabels.todos)}</span><b>${period.highPriorityTodos} 项</b><small>${period.pendingTodos} 个周期待办</small>`;
  if (focusMetrics[2]) focusMetrics[2].innerHTML = `<span>${escapeHtml(period.label)}预计成交金额 · ${escapeHtml(scopeLabels.business)}</span><b>${escapeHtml(dashboardMoneyText(period.expectedAmounts))}</b><small>${period.expectedDeals} 个预计成交商机 · ${escapeHtml(periodDateText(period.start, period.end))}</small>`;
  if (focusMetrics[3]) focusMetrics[3].innerHTML = `<span>${escapeHtml(period.label)}新增线索 · ${escapeHtml(scopeLabels.business)}</span><b>${period.newLeads} 条</b><small>当前另有 ${summary.briefing.unreadWecom} 条客户消息待处理</small>`;
  renderLeadFunnel(summary);
  renderTodoInsights(summary);
  renderPriorityTasks(summary);
  renderTodos(todos);
  updateTodoChips(todos);
  renderDashboardControls();
  renderMorningPanel(summary);
  ensureTenderDaily();
}

async function loadBadges(containerId = "leaderboardBadges", tagId?: string) {
  const container = qs<HTMLElement>(`#${containerId}`);
  const tag = tagId ? qs<HTMLElement>(`#${tagId}`) : null;
  if (!container) return;
  try {
    const result = await api<{ badges: Array<{ id: string; name: string; icon: string; desc: string; earned: boolean; progress: string }>; earnedCount: number; totalCount: number }>("/api/dashboard/badges");
    if (tag) tag.textContent = `${result.earnedCount}/${result.totalCount}`;
    container.innerHTML = result.badges.map((badge) => {
      return `<div class="badge-card${badge.earned ? " earned" : " locked"}">
        <span class="badge-icon">${badge.icon}</span>
        <span class="badge-name">${escapeHtml(badge.name)}</span>
        <span class="badge-progress">${badge.earned ? "已达成" : escapeHtml(badge.progress)}</span>
        <div class="badge-tooltip">${escapeHtml(badge.desc)}</div>
      </div>`;
    }).join("");
  } catch {
    container.innerHTML = "";
  }
}

type LeaderboardMetric = "wonAmount" | "newCustomers" | "followUps" | "score";
const leaderboardMetricLabels: Record<LeaderboardMetric, string> = {
  wonAmount: "成交额",
  newCustomers: "新客数",
  followUps: "跟进数",
  score: "综合战力"
};

let leaderboardState: { period: string; metric: LeaderboardMetric } = { period: "week", metric: "wonAmount" };

export function renderLeaderboardPage() {
  const view = qs<HTMLElement>("#leaderboard");
  if (!view) return;
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>排行</h1>
        <p class="page-sub">多维度比拼 · 让每一份努力都被看见</p>
      </div>
      <div class="head-actions">
        <div class="lb-period-tabs" role="tablist" aria-label="统计周期">
          <button type="button" data-lb-period="week" class="${leaderboardState.period === "week" ? "active" : ""}">近7天</button>
          <button type="button" data-lb-period="month" class="${leaderboardState.period === "month" ? "active" : ""}">本月</button>
          <button type="button" data-lb-period="quarter" class="${leaderboardState.period === "quarter" ? "active" : ""}">本季</button>
          <button type="button" data-lb-period="year" class="${leaderboardState.period === "year" ? "active" : ""}">本年</button>
        </div>
      </div>
    </div>

    <div class="lb-grid">
      <section class="panel lb-main">
        <div class="lb-metric-tabs" role="tablist" aria-label="排序维度">
          <button type="button" data-lb-metric="wonAmount" class="${leaderboardState.metric === "wonAmount" ? "active" : ""}">按成交额</button>
          <button type="button" data-lb-metric="newCustomers" class="${leaderboardState.metric === "newCustomers" ? "active" : ""}">按新客数</button>
          <button type="button" data-lb-metric="followUps" class="${leaderboardState.metric === "followUps" ? "active" : ""}">按跟进数</button>
          <button type="button" data-lb-metric="score" class="${leaderboardState.metric === "score" ? "active" : ""}">按综合战力</button>
        </div>
        <div class="lb-podium" id="lbPodium"><div class="lb-loading">加载中…</div></div>
        <div class="lb-table" id="lbTable"><div class="lb-loading">加载中…</div></div>
      </section>

      <aside class="lb-side">
        <section class="panel lb-hero" id="lbHero"><div class="lb-loading">加载中…</div></section>
        <section class="panel lb-badges">
          <div class="section-head">
            <div class="section-title"><span class="icon"><svg viewBox="0 0 24 24"><path d="M12 2l3 6 6 .9-4.5 4.4 1 6.2L12 17l-5.5 2.5 1-6.2L3 8.9 9 8z"/></svg></span><div><h2>成就徽章</h2></div></div>
            <span class="badge-progress-tag" id="leaderboardBadgeTag">0/8</span>
          </div>
          <div class="badges-grid" id="leaderboardBadges"><div style="padding:16px;text-align:center;color:var(--muted);font-size:12px;">加载中…</div></div>
        </section>
      </aside>
    </div>
  `;

  qsa<HTMLButtonElement>("[data-lb-period]", view).forEach((button) => {
    button.addEventListener("click", () => {
      leaderboardState.period = button.dataset.lbPeriod || "week";
      qsa<HTMLButtonElement>("[data-lb-period]", view).forEach((b) => b.classList.toggle("active", b === button));
      void loadLeaderboardData();
    });
  });
  qsa<HTMLButtonElement>("[data-lb-metric]", view).forEach((button) => {
    button.addEventListener("click", () => {
      leaderboardState.metric = (button.dataset.lbMetric as LeaderboardMetric) || "wonAmount";
      qsa<HTMLButtonElement>("[data-lb-metric]", view).forEach((b) => b.classList.toggle("active", b === button));
      void loadLeaderboardData();
    });
  });

  void loadLeaderboardData();
  void loadBadges("leaderboardBadges", "leaderboardBadgeTag");
}

function formatLbAmount(value: number) {
  if (value >= 1000) return `$${Number((value / 1000).toFixed(value % 1000 === 0 ? 0 : 1))}k`;
  return `$${value}`;
}

function formatLbMetric(metric: LeaderboardMetric, value: number) {
  if (metric === "wonAmount") return formatLbAmount(value);
  if (metric === "score") return `${value} 战力`;
  return String(value);
}

async function loadLeaderboardData() {
  const podium = qs<HTMLElement>("#lbPodium");
  const table = qs<HTMLElement>("#lbTable");
  const hero = qs<HTMLElement>("#lbHero");
  if (!podium || !table || !hero) return;
  try {
    const result = await api<{
      scope: string;
      period: string;
      entries: Array<{
        userId: string; userName: string; avatar: string;
        wonAmount: number; wonCount: number; newCustomers: number;
        conversionRate: number; followUps: number; prevWonAmount: number;
        score: number; rank: number;
      }>;
    }>(`/api/dashboard/leaderboard?period=${encodeURIComponent(leaderboardState.period)}`);

    const metric = leaderboardState.metric;
    const sorted = [...result.entries].sort((a, b) => (b[metric] as number) - (a[metric] as number) || a.rank - b.rank);
    sorted.forEach((entry, index) => { entry.rank = index + 1; });

    const top3 = sorted.slice(0, 3);
    const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean);
    const podiumHtml = podiumOrder.map((entry) => {
      const place = entry.rank;
      const medal = place === 1 ? "🥇" : place === 2 ? "🥈" : "🥉";
      const isMe = entry.userId === state.user?.id;
      return `<div class="lb-podium-card place${place}${isMe ? " me" : ""}">
        <div class="lb-podium-medal">${medal}</div>
        <div class="lb-podium-avatar">${escapeHtml(entry.userName.slice(0, 2))}</div>
        <div class="lb-podium-name">${escapeHtml(entry.userName)}${isMe ? " (我)" : ""}</div>
        <div class="lb-podium-value">${formatLbMetric(metric, entry[metric] as number)}</div>
        <div class="lb-podium-sub">${entry.wonCount}单 · ${entry.newCustomers}新客</div>
      </div>`;
    }).join("");
    podium.innerHTML = podiumHtml || `<div class="lb-empty">暂无排行数据</div>`;

    const maxValue = Math.max(1, ...sorted.map((entry) => entry[metric] as number));
    const tableHtml = sorted.map((entry) => {
      const isMe = entry.userId === state.user?.id;
      const value = entry[metric] as number;
      const pct = Math.round((value / maxValue) * 100);
      const delta = entry.wonAmount - entry.prevWonAmount;
      const deltaHtml = entry.prevWonAmount > 0
        ? `<span class="lb-delta ${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${formatLbAmount(Math.abs(delta))}</span>`
        : `<span class="lb-delta flat">—</span>`;
      return `<div class="lb-row${isMe ? " me" : ""}">
        <span class="lb-rank">${entry.rank}</span>
        <div class="lb-avatar">${escapeHtml(entry.userName.slice(0, 2))}</div>
        <span class="lb-name">${escapeHtml(entry.userName)}${isMe ? " (我)" : ""}</span>
        <span class="lb-value">${formatLbMetric(metric, value)}</span>
        ${deltaHtml}
        <div class="lb-bar"><span style="width:${pct}%"></span></div>
      </div>`;
    }).join("");
    table.innerHTML = tableHtml || `<div class="lb-empty">暂无排行数据</div>`;

    const me = sorted.find((entry) => entry.userId === state.user?.id) || sorted[0];
    const rankInMetric = sorted.findIndex((entry) => entry.userId === (state.user?.id)) + 1;
    const myIndex = sorted.findIndex((entry) => entry.userId === state.user?.id);
    const above = myIndex > 0 ? sorted[myIndex - 1] : null;
    const gap = above ? (above[metric] as number) - (me[metric] as number) : 0;
    hero.innerHTML = `
      <div class="section-head">
        <div class="section-title"><span class="icon"><svg viewBox="0 0 24 24"><path d="M12 2l3 6 6 .9-4.5 4.4 1 6.2L12 17l-5.5 2.5 1-6.2L3 8.9 9 8z"/></svg></span><div><h2>我的战绩</h2></div></div>
      </div>
      <div class="lb-hero-rank">第 <b>${myIndex >= 0 ? rankInMetric : "--"}</b> 名</div>
      <div class="lb-hero-metrics">
        <div class="lb-hero-metric"><span>成交额</span><b>${formatLbAmount(me?.wonAmount || 0)}</b></div>
        <div class="lb-hero-metric"><span>成交单数</span><b>${me?.wonCount || 0}</b></div>
        <div class="lb-hero-metric"><span>新客数</span><b>${me?.newCustomers || 0}</b></div>
        <div class="lb-hero-metric"><span>综合战力</span><b>${me?.score || 0}</b></div>
      </div>
      ${above ? `<div class="lb-hero-gap">距上一名还差 <b>${formatLbMetric(metric, gap)}</b>（${escapeHtml(above.userName)}）</div>` : `<div class="lb-hero-gap champion">🏆 当前维度已登顶！</div>`}
      <div class="lb-hero-conv">整体转化率 ${me?.conversionRate || 0}%</div>
    `;
  } catch {
    podium.innerHTML = `<div class="lb-empty">数据加载失败</div>`;
    table.innerHTML = "";
    hero.innerHTML = `<div class="lb-empty">数据加载失败</div>`;
  }
}

function dashboardMoneyText(rows: Array<{ currency: string; amount: number }>) {
  if (!rows.length) return "$0";
  return rows.map((row) => {
    const symbol = row.currency === "USD" ? "$" : row.currency === "CNY" ? "¥" : row.currency === "EUR" ? "€" : `${row.currency} `;
    const amount = Math.abs(row.amount) >= 1000
      ? `${Number((row.amount / 1000).toFixed(row.amount % 1000 === 0 ? 0 : 1))}k`
      : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(row.amount);
    return `${symbol}${amount}`;
  }).join(" / ");
}

function periodDateText(start: string, end: string) {
  const shortDate = (value: string) => {
    const [, month, day] = value.split("-");
    return `${Number(month)}月${Number(day)}日`;
  };
  return start === end ? shortDate(start) : `${shortDate(start)}-${shortDate(end)}`;
}

function renderDashboardControls() {
  const morningButton = qs<HTMLButtonElement>("#morningViewButton");
  if (morningButton) {
    morningButton.classList.toggle("primary", state.morningView);
    morningButton.textContent = state.morningView ? "退出晨会视图" : "晨会视图";
  }
}

function renderMorningPanel(summary: DashboardSummary) {
  const panel = qs<HTMLElement>("#morningPanel");
  panel?.classList.toggle("active", state.morningView);
  if (!panel) return;
  const subtitle = qs<HTMLElement>("#morningSubtitle");
  const conclusion = qs<HTMLElement>("#morningConclusion");
  const risk = qs<HTMLElement>("#morningRisk");
  const collab = qs<HTMLElement>("#morningCollab");
  const action = qs<HTMLElement>("#morningAction");
  if (subtitle) subtitle.textContent = "今日晨会同步：风险、成交、协同和下一步动作。";
  if (conclusion) conclusion.textContent = "先抢救逾期报价";
  if (risk) risk.textContent = money(summary.briefing.riskAmount);
  if (collab) collab.textContent = `${summary.metrics.overdueTodos} 项`;
  if (action) action.textContent = `${summary.priorityTasks.length || summary.metrics.todos} 条`;
}

// ── 海外竞标日报（工作主页 · CLI 通道）────────────────────────────
// 交互口径：打开工作台只读团队最新留档（GET /latest），**绝不自动派单**；
// 只有点「开始查询」才 POST /run 交给本机 CLI，避免每次刷新白烧积分。

interface TenderDailyItemView {
  title: string;
  country: string;
  buyer: string;
  products: string;
  deadline: string;
  budget: string;
  status: "open" | "upcoming" | "awarded";
  sourceUrl: string;
  relevance: number | null;
  action: string;
}

interface TenderDailyReportView {
  reportDate: string;
  summary: string;
  tenders: TenderDailyItemView[];
  notes: string[];
  engine: string;
  completedAt: string;
}

type TenderDailyCardState =
  | { phase: "idle" }
  | { phase: "loading"; engineJobId: string | null; runnerName?: string }
  | { phase: "ready"; report: TenderDailyReportView }
  | { phase: "error"; message: string };

export let tenderDailyCard: TenderDailyCardState = { phase: "idle" };
let tenderDailyPolling = false;
/** 本次页面会话是否已经读过留档（只读一次，避免每次 renderDashboard 都发请求） */
let tenderDailyBootstrapped = false;
/** 简报一键生成线索的去重：执行中的派单不重复发（键 = tender:all 或 tender:公告标题） */
const tenderLeadDispatched = new Set<string>();

const TENDER_STATUS_META: Record<TenderDailyItemView["status"], { label: string; tone: string }> = {
  open: { label: "进行中", tone: "green" },
  upcoming: { label: "即将开始", tone: "amber" },
  awarded: { label: "已开标", tone: "gray" }
};

function ensureTenderDaily() {
  if (tenderDailyBootstrapped) return;
  tenderDailyBootstrapped = true;
  void loadTenderDailySnapshot();
}

/** 只读取团队最新一份留档：不派单、不消耗积分。要查今天的必须手动点「开始查询」 */
async function loadTenderDailySnapshot() {
  try {
    const snapshot = await api<{
      report: TenderDailyReportView | null;
      engineJob: (AiEngineJobView & { errorMessage?: string }) | null;
      pending: boolean;
    }>("/api/tender-daily/latest");
    if (snapshot.pending && snapshot.engineJob) {
      tenderDailyCard = { phase: "loading", engineJobId: snapshot.engineJob.id, runnerName: "本机 CLI" };
      renderTenderDailyCard();
      void pollTenderDailyJob(snapshot.engineJob.id);
      return;
    }
    tenderDailyCard = snapshot.report
      ? { phase: "ready", report: snapshot.report }
      : { phase: "idle" };
    renderTenderDailyCard();
  } catch {
    // 读不到留档不是错误（可能今天还没查过 / 后端档位不支持），保持待查询让用户自己点
    tenderDailyCard = { phase: "idle" };
    renderTenderDailyCard();
  }
}

export async function loadTenderDaily(force = false) {
  if (tenderDailyCard.phase === "loading") return;
  tenderDailyCard = { phase: "loading", engineJobId: null };
  renderTenderDailyCard();
  try {
    const result = await api<{
      report: TenderDailyReportView | null;
      engineJob?: AiEngineJobView | null;
      pending?: boolean;
      runnerName?: string;
      engine?: string;
      message?: string;
      failed?: boolean;
      reused?: boolean;
    }>("/api/tender-daily/run", { method: "POST", body: JSON.stringify(force ? { force: true } : {}) });
    if (result.report) {
      tenderDailyCard = { phase: "ready", report: result.report };
      renderTenderDailyCard();
      if (force) toast("今日竞标日报已更新", "success");
      return;
    }
    if (result.pending && result.engineJob) {
      tenderDailyCard = {
        phase: "loading",
        engineJobId: result.engineJob.id,
        runnerName: result.runnerName || result.engine || "本机 CLI"
      };
      renderTenderDailyCard();
      toast("竞标日报已交给本机 CLI 查询，期间可以继续处理其他工作", "info");
      void pollTenderDailyJob(result.engineJob.id);
      return;
    }
    tenderDailyCard = { phase: "error", message: result.message || "竞标日报查询失败，请稍后重试" };
    renderTenderDailyCard();
  } catch (error) {
    tenderDailyCard = { phase: "error", message: error instanceof Error ? error.message : "竞标日报查询失败，请检查本机 Runner 是否在线" };
    renderTenderDailyCard();
  }
}

/** 轮询团队最新一份竞标日报作业到终态（不直连 /api/ai-engine/jobs，保证全队可见） */
async function pollTenderDailyJob(jobId: string) {
  if (tenderDailyPolling) return;
  tenderDailyPolling = true;
  const deadline = Date.now() + 30 * 60_000;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (tenderDailyCard.phase !== "loading" || tenderDailyCard.engineJobId !== jobId) return;
      let snapshot: {
        report: TenderDailyReportView | null;
        engineJob: (AiEngineJobView & { errorMessage?: string }) | null;
        pending: boolean;
      } | null = null;
      try {
        snapshot = await api<{
          report: TenderDailyReportView | null;
          engineJob: (AiEngineJobView & { errorMessage?: string }) | null;
          pending: boolean;
        }>("/api/tender-daily/latest");
      } catch {
        continue; // 网络抖动继续轮询，与获客轮询容错同口径
      }
      if (!snapshot.engineJob || snapshot.engineJob.id !== jobId) return;
      if (snapshot.report) {
        tenderDailyCard = { phase: "ready", report: snapshot.report };
        toast("今日海外竞标日报已生成", "success");
        return;
      }
      if (!snapshot.pending) {
        tenderDailyCard = { phase: "error", message: snapshot.engineJob.errorMessage || "本机 CLI 没有返回日报，请到「集成中心 · 本地 Runner」查看任务日志" };
        return;
      }
    }
    tenderDailyCard = { phase: "error", message: "本机 CLI 执行时间过长，已停止等待；稍后可点「重新查询」取回结果" };
  } finally {
    tenderDailyPolling = false;
    renderTenderDailyCard();
  }
}

/** 简报 → 获客 payload：单条公告按其国家/产品定向搜寻；整份日报按公告出现的国家与产品汇总 */
function tenderLeadPayload(report: TenderDailyReportView, item?: TenderDailyItemView): CliAcquirePayload {
  const industry = "public procurement / tender";
  const customerType = "project owner, procurement agency, local distributor";
  if (item) {
    const buyer = item.buyer ? `，采购方 ${item.buyer}` : "";
    const goal = `围绕今日竞标日报公告「${item.title}」（${item.country || "海外"}${buyer}）搜寻线索：能参与该采购/供货的当地供应商、项目业主、代理与分销渠道`.slice(0, 480);
    return {
      goal,
      productKeywords: (item.products || "").slice(0, 280),
      countries: (item.country || "").slice(0, 180),
      industry,
      customerType,
      excludeKeywords: "",
      limit: 8
    };
  }
  const countries = Array.from(new Set(report.tenders.map((t) => t.country.trim()).filter(Boolean))).slice(0, 6).join(", ");
  const products = Array.from(new Set(report.tenders.map((t) => t.products.trim()).filter(Boolean))).slice(0, 3).join("; ");
  const goal = `围绕今日海外竞标日报的 ${report.tenders.length} 条招标公告搜寻可合作线索：正在采购同类产品的当地采购方、项目业主、代理与分销渠道，优先核实有近期采购记录的主体`.slice(0, 480);
  return {
    goal,
    productKeywords: products.slice(0, 280),
    countries: countries.slice(0, 180),
    industry,
    customerType,
    excludeKeywords: "",
    limit: 12
  };
}

/** 简报一键生成线索：复用 CLI 获客链路——任务卡挂到搜客任务队列，候选实时入池 */
function dispatchTenderLeads(report: TenderDailyReportView, item?: TenderDailyItemView) {
  const key = item ? `tender:${item.title}` : "tender:all";
  if (tenderLeadDispatched.has(key)) {
    toast("该线索任务已派给本机 CLI，正在执行；可到搜客页查看实时进度");
    return;
  }
  tenderLeadDispatched.add(key);
  const payload = tenderLeadPayload(report, item);
  const job = createCliAcquireJob(payload);
  void runCliAcquireJob(job, payload).finally(() => tenderLeadDispatched.delete(key));
  toast(item
    ? "已派给本机 CLI：按此公告搜寻线索，任务卡挂在搜客任务队列，候选实时入池"
    : "已派给本机 CLI：按今日竞标日报搜寻线索，任务卡挂在搜客任务队列，候选实时入池", "success");
}

function renderTenderDailyCard() {
  const body = qs<HTMLElement>("#tenderDailyBody");
  if (!body) return;  const status = qs<HTMLElement>("#tenderDailyStatus");
  const sub = qs<HTMLElement>("#tenderDailySummary");
  if (status) {
    const map: Record<TenderDailyCardState["phase"], { text: string; cls: string }> = {
      idle: { text: "待查询", cls: "amber" },
      loading: { text: "CLI 查询中", cls: "amber" },
      ready: { text: "已更新", cls: "green" },
      error: { text: "查询失败", cls: "red" }
    };
    const meta = map[tenderDailyCard.phase];
    status.className = `badge ${meta.cls}`;
    status.textContent = meta.text;
  }
  if (sub) {
    sub.textContent = tenderDailyCard.phase === "ready"
      ? `报告日期 ${tenderDailyCard.report.reportDate} · 引擎 ${tenderDailyCard.report.engine} · 生成于 ${formatDateTime(tenderDailyCard.report.completedAt)}`
      : "点「开始查询」才会调用本机 CLI 检索；不点不会消耗积分，同一天的结果全团队共享。";
  }
  const actionButton = qs<HTMLButtonElement>("#tenderDailyRefreshButton");
  if (actionButton) {
    const actionLabel: Record<TenderDailyCardState["phase"], string> = {
      idle: "开始查询",
      loading: "查询中…",
      ready: "重新查询",
      error: "重试"
    };
    actionButton.textContent = actionLabel[tenderDailyCard.phase];
    actionButton.disabled = tenderDailyCard.phase === "loading";
  }
  if (tenderDailyCard.phase === "idle") {
    body.innerHTML = `<div class="tender-daily-empty">
      <b>今天还没有查询竞标日报</b>
      <span>点下面的按钮才会派给本机 CLI 检索，打开工作台不会自动消耗积分。</span>
      <button class="btn primary" type="button" data-tender-start>开始查询</button>
      <small>约需 1-3 分钟，期间可以离开本页；完成后结果自动显示在这里，全团队共享。</small>
    </div>`;
    qs<HTMLButtonElement>("[data-tender-start]", body)?.addEventListener("click", () => void loadTenderDaily(false));
    return;
  }
  if (tenderDailyCard.phase === "loading") {
    body.innerHTML = `${cliWaitPanelHtml("tender", tenderDailyCard.runnerName || "本机 CLI")}
      <p class="tender-daily-note">查询约需 1-3 分钟，期间可以离开本页；完成后结果自动显示在这里，全团队共享。</p>`;
    startCliWaitTicker("tender");
    return;
  }
  if (tenderDailyCard.phase === "error") {
    body.innerHTML = `<div class="tender-daily-error">
      <b>今天还没拿到竞标日报</b>
      <span>${escapeHtml(tenderDailyCard.message)}</span>
      <button class="btn" type="button" data-tender-retry>重试</button>
    </div>`;
    qs<HTMLButtonElement>("[data-tender-retry]", body)?.addEventListener("click", () => void loadTenderDaily(false));
    return;
  }
  const report = tenderDailyCard.report;
  if (!report.tenders.length) {
    body.innerHTML = `<div class="tender-daily-empty">
      <b>今天没有检索到与主营产品相关的海外招标公告</b>
      <span>${escapeHtml(report.summary || "本机 CLI 已完成检索；宁空勿假，未发现可靠公告就不列条目。")}</span>
      ${report.notes.map((note) => `<small>${escapeHtml(note)}</small>`).join("")}
    </div>`;
    return;
  }
  body.innerHTML = `
    <p class="tender-daily-summary">${escapeHtml(report.summary)}</p>
    <div class="tender-daily-actions">
      <button class="btn primary" type="button" data-tender-leads-all>${tenderLeadDispatched.has("tender:all") ? "线索任务执行中…" : "⚡ 一键生成线索"}</button>
      <small>按今日公告的国家与产品派本机 CLI 搜寻当地采购方 / 代理 / 分销商，候选实时入池</small>
    </div>
    <div class="tender-daily-list">
      ${report.tenders.map((item, index) => {
        const statusMeta = TENDER_STATUS_META[item.status] || TENDER_STATUS_META.open;
        const dispatched = tenderLeadDispatched.has(`tender:${item.title}`);
        return `<article class="tender-daily-item">
          <div class="tender-item-head">
            ${/^https?:\/\//iu.test(item.sourceUrl)
              ? `<a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer noopener"><b>${escapeHtml(item.title)}</b></a>`
              : `<b>${escapeHtml(item.title)}</b>`}
            <span class="tender-item-side">
              ${badge(statusMeta.label, statusMeta.tone)}
              ${item.relevance !== null ? badge(`相关 ${item.relevance}`, item.relevance >= 70 ? "green" : item.relevance >= 45 ? "amber" : "gray") : ""}
            </span>
          </div>
          <div class="tender-item-meta">
            ${item.country ? `<span>国家/地区：<b>${escapeHtml(item.country)}</b></span>` : ""}
            ${item.buyer ? `<span>采购方：<b>${escapeHtml(item.buyer)}</b></span>` : ""}
            ${item.deadline ? `<span>截标：<b>${escapeHtml(item.deadline)}</b></span>` : ""}
            ${item.budget ? `<span>预算：<b>${escapeHtml(item.budget)}</b></span>` : ""}
          </div>
          ${item.products ? `<p class="tender-item-match">${escapeHtml(item.products)}</p>` : ""}
          ${item.action ? `<p class="tender-item-action"><b>建议</b>${escapeHtml(item.action)}</p>` : ""}
          <div class="tender-item-foot">
            <small class="tender-item-source">${escapeHtml(websiteDomain(item.sourceUrl))}</small>
            <button class="tender-item-lead-btn" type="button" data-tender-lead-item="${index}" ${dispatched ? "disabled" : ""}>${dispatched ? "已派单…" : "按此公告找线索"}</button>
          </div>
        </article>`;
      }).join("")}
    </div>
    ${report.notes.length ? `<div class="tender-daily-notes">${report.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>` : ""}
  `;
  qs<HTMLButtonElement>("[data-tender-leads-all]", body)?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (tenderLeadDispatched.has("tender:all")) {
      toast("该线索任务已派给本机 CLI，正在执行；可到搜客页查看实时进度");
      return;
    }
    button.disabled = true;
    button.textContent = "已派单，任务卡在搜客队列…";
    dispatchTenderLeads(report);
  });
  body.querySelectorAll<HTMLButtonElement>("[data-tender-lead-item]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = report.tenders[Number(button.dataset.tenderLeadItem)];
      if (!item) return;
      if (tenderLeadDispatched.has(`tender:${item.title}`)) {
        toast("该公告的线索任务已在执行，可到搜客页查看进度");
        return;
      }
      button.disabled = true;
      button.textContent = "已派单…";
      dispatchTenderLeads(report, item);
    });
  });
}

export function formatTime(value: string) {
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

const LEAD_FUNNEL_THEME_VARS = [
  "--gj-funnel-entered", "--gj-funnel-pending", "--gj-funnel-valid", "--gj-funnel-customer", "--gj-funnel-deal",
  "--gj-funnel-line", "--gj-funnel-label", "--gj-funnel-marker-ring"
];

function leadFunnelSignature(funnel: HTMLElement, data: DashboardSummary["leadFunnel"]) {
  const style = getComputedStyle(funnel);
  return JSON.stringify({
    data: data ?? null,
    theme: LEAD_FUNNEL_THEME_VARS.map((name) => style.getPropertyValue(name).trim()),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches
  });
}

function renderLeadFunnel(summary: DashboardSummary) {
  const funnel = qs<HTMLElement>("#dashboardLeadFunnel");
  if (!funnel) return;
  // 性能：工作台每 10 秒自动刷新。漏斗数据与主题都没变时直接复用现有图表——
  // 销毁重建会重跑 ECharts 入场动画并重播流光，空闲时也持续占用 CPU。
  const funnelSignature = leadFunnelSignature(funnel, summary.leadFunnel);
  if (
    dashboardLeadFunnelChart
    && leadFunnelRendered?.element === funnel
    && leadFunnelRendered.signature === funnelSignature
    && funnel.querySelector("[data-lead-funnel-chart]")
  ) return;
  leadFunnelRendered = null;
  dashboardLeadFunnelResizeObserver?.disconnect();
  dashboardLeadFunnelResizeObserver = null;
  dashboardLeadFunnelChart?.dispose();
  dashboardLeadFunnelChart = null;
  const data = summary.leadFunnel;
  if (!data?.stages?.length) {
    funnel.innerHTML = `<div class="todo-history-empty">线索漏斗数据更新中</div>`;
    return;
  }
  // 图表配色统一由 CSS 变量驱动：这样换主题/换工作台方案时，折线与阶段点会跟着变，
  // 不再出现「靛蓝工作台里躺着一条荧光黄曲线」这种脱节。变量定义见 index.html 的
  // #dashboard.dashboard-v2 令牌块，各设计方案的覆盖文件可再行覆盖。
  const themeColor = (name: string, fallback: string) =>
    (getComputedStyle(funnel).getPropertyValue(name) || "").trim() || fallback;
  const colors: Record<string, string> = {
    entered: themeColor("--gj-funnel-entered", "#c7d2fe"),
    pending: themeColor("--gj-funnel-pending", "#a5b4fc"),
    valid: themeColor("--gj-funnel-valid", "#818cf8"),
    customer: themeColor("--gj-funnel-customer", "#6366f1"),
    deal: themeColor("--gj-funnel-deal", "#4f46e5")
  };
  const funnelLineColor = themeColor("--gj-funnel-line", "#6366f1");
  const funnelLabelColor = themeColor("--gj-funnel-label", "#1b2231");
  // 折线数据点的描边环：浅色底上取卡片色（形成留白环），深色底上取深底色。
  const funnelMarkerRing = themeColor("--gj-funnel-marker-ring", "#ffffff");
  funnel.innerHTML = `
    <div class="lead-funnel-chart-wrap">
      <div class="lead-funnel-chart" data-lead-funnel-chart role="img" aria-label="线索从进入系统、清洗到转为客户和商机的真实转化曲线"></div>
      <span class="lead-funnel-travel-light" data-lead-funnel-light aria-hidden="true"></span>
    </div>
    <div class="lead-funnel-stage-list" aria-label="线索漏斗阶段">
      ${data.stages.map((stage, index) => `
        <button type="button" class="lead-funnel-stage-row" data-lead-funnel-key="${escapeHtml(stage.key)}" aria-label="${escapeHtml(stage.label)} ${stage.count} 条，占进入系统 ${stage.conversionRate}%">
          <span class="lead-funnel-stage-dot" style="--stage-color:${colors[stage.key] || funnelLineColor}" aria-hidden="true"></span>
          <span>${escapeHtml(stage.label)}</span>
          <small>${index === 0 ? "总量" : `${stage.conversionRate}%`}</small>
        </button>
      `).join("")}
    </div>
    <div class="lead-funnel-filtered" aria-label="已过滤 ${data.filteredOut} 条无效或重复线索">
      <span class="lead-funnel-filter-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16l-6.4 7.1v5.2l-3.2 1.7v-6.9L4 5Z"/></svg></span>
      <span>清洗已过滤 <b>${data.filteredOut}</b> 条无效 / 重复线索</span>
    </div>
    <div class="lead-funnel-summary">
      <div><span>今日新增</span><b>${data.todayAdded}</b></div>
      <div><span>待清洗</span><b>${data.stages.find((stage) => stage.key === "pending")?.count || 0}</b></div>
      <div><span>转商机率</span><b>${data.dealConversionRate}%</b></div>
    </div>`;

  const chartHost = qs<HTMLElement>("[data-lead-funnel-chart]", funnel);
  if (chartHost) {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const maxCount = Math.max(1, ...data.stages.map((stage) => stage.count));
    try {
      const chart = echarts.init(chartHost, undefined, { renderer: "svg" });
      dashboardLeadFunnelChart = chart;
      chart.setOption({
      animation: !prefersReducedMotion,
      animationDuration: 720,
      animationDurationUpdate: 350,
      animationEasing: "cubicOut",
      grid: {
        left: 22,
        right: 22,
        top: 28,
        bottom: 8,
        containLabel: false
      },
      tooltip: {
        trigger: "item",
        confine: true,
        // 提示框跟随卡片语言：白底、细边、柔和投影。写死深色会在晨白页面上
        // 变成一块突兀的黑方块，换肤时也不跟手。
        backgroundColor: "#ffffff",
        borderColor: "#e3e7f0",
        borderWidth: 1,
        padding: [8, 10],
        extraCssText: "border-radius:8px;box-shadow:0 8px 24px rgba(23,28,40,.12);",
        textStyle: { color: "#171c28", fontSize: 12 },
        formatter: (params: { data: { label: string; value: number; conversionRate: number } }) =>
          `${escapeHtml(params.data.label)}<br/><b>${params.data.value} 条</b> · 占进入 ${params.data.conversionRate}%`
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: data.stages.map((stage) => stage.label),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false }
      },
      yAxis: {
        type: "value",
        min: 0,
        max: Math.max(2, Math.ceil(maxCount * 1.28)),
        show: false
      },
      series: [{
        type: "line",
        smooth: 0.34,
        smoothMonotone: "x",
        symbol: "circle",
        symbolSize: 8,
        showSymbol: true,
        connectNulls: true,
        lineStyle: {
          width: 2,
          color: funnelLineColor,
          cap: "round",
          shadowBlur: 0,
          shadowColor: "transparent"
        },
        areaStyle: {
          opacity: 0,
          color: "transparent"
        },
        label: {
          show: true,
          position: "top",
          distance: 7,
          color: funnelLabelColor,
          fontSize: 13,
          fontWeight: 700,
          formatter: (params: { value: number }) => String(params.value)
        },
        emphasis: {
          scale: 1.45,
          focus: "self",
          itemStyle: {
            borderWidth: 3,
            borderColor: funnelLineColor,
            shadowBlur: 0,
            shadowColor: "transparent"
          }
        },
        data: data.stages.map((stage) => ({
          value: stage.count,
          name: stage.label,
          key: stage.key,
          label: stage.label,
          conversionRate: stage.conversionRate,
          itemStyle: {
            color: colors[stage.key] || funnelLineColor,
            borderWidth: 2,
            borderColor: funnelMarkerRing,
            shadowBlur: 0,
            shadowColor: "transparent"
          }
        }))
      }]
      });
      chart.on("click", (params) => {
        const stage = params.data as { key?: string } | undefined;
        openLeadFunnelStage(stage?.key || "entered");
      });
      const travelLight = qs<HTMLElement>("[data-lead-funnel-light]", funnel);
      const positionTravelLight = () => {
        try {
          chart.resize();
          if (!travelLight || prefersReducedMotion) return;
          travelLight.style.offsetPath = buildLeadFlowMotionPath(
            chartHost.clientWidth,
            chartHost.clientHeight,
            data.stages.map((stage) => stage.count),
            Math.max(2, Math.ceil(maxCount * 1.28))
          );
        } catch {
          // Chart resize is optional; the stage list remains usable if the host is replaced.
        }
      };
      positionTravelLight();
      dashboardLeadFunnelResizeObserver = new ResizeObserver(positionTravelLight);
      dashboardLeadFunnelResizeObserver.observe(chartHost);
      leadFunnelRendered = { element: funnel, signature: funnelSignature };
    } catch {
      dashboardLeadFunnelChart = null;
      chartHost.innerHTML = `<div class="lead-funnel-chart-fallback" aria-label="线索漏斗图表暂时不可用">线索阶段数据已加载</div>`;
    }
  }

  qsa<HTMLButtonElement>("[data-lead-funnel-key]", funnel).forEach((button) => {
    button.addEventListener("click", () => {
      openLeadFunnelStage(button.dataset.leadFunnelKey || "entered");
    });
  });
}

function buildLeadFlowMotionPath(width: number, height: number, values: number[], maxValue: number) {
  const left = 22;
  const right = 22;
  const top = 28;
  const bottom = 8;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const points = values.map((value, index) => ({
    x: left + (values.length === 1 ? plotWidth / 2 : (index * plotWidth) / (values.length - 1)),
    y: top + (1 - value / maxValue) * plotHeight
  }));
  if (!points.length) return "none";
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] || points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] || next;
    const control1X = current.x + (next.x - previous.x) / 10;
    const control1Y = current.y + (next.y - previous.y) / 10;
    const control2X = next.x - (after.x - current.x) / 10;
    const control2Y = next.y - (after.y - current.y) / 10;
    path += ` C ${control1X.toFixed(2)} ${control1Y.toFixed(2)}, ${control2X.toFixed(2)} ${control2Y.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }
  return `path("${path}")`;
}

function openLeadFunnelStage(key: string) {
  resetLeadFilters();
  if (key === "pending") state.leadStageFilter = "新线索";
  if (key === "customer" || key === "deal") state.leadStageFilter = "已转化";
  activateNavView("leads", renderLeads);
}

export function renderDashboardKnowledgePanels(assets = state.knowledgeAssets, exams = state.exams) {
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

export function ownerName(ownerId: string) {
  if (!ownerId) return "未分配";
  if (state.user?.id === ownerId) return state.user.name;
  return state.accounts.find((account) => account.id === ownerId)?.name || "未知账号";
}

export function renderTodoInsights(summary: DashboardSummary) {
  const scoreCards = qsa<HTMLElement>(".todo-score-card b");
  if (scoreCards[0]) scoreCards[0].textContent = String(summary.todoInsights.total);
  if (scoreCards[1]) scoreCards[1].textContent = String(summary.todoInsights.overdue);
  if (scoreCards[2]) scoreCards[2].textContent = `${summary.todoInsights.completionRate}%`;
  if (scoreCards[3]) scoreCards[3].textContent = money(summary.todoInsights.impactAmount);
  const table = qs<HTMLElement>("#todo .todo-insights .mini-table tbody");
  if (table) {
    table.innerHTML = summary.todoInsights.typeRows.length ? summary.todoInsights.typeRows.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${row.count}</td><td>${badge(row.risk, row.risk === "高" ? "red" : row.risk === "中" ? "amber" : "")}</td></tr>`).join("") : `<tr><td>暂无待办</td><td>0</td><td>${badge("安全", "green")}</td></tr>`;
  }
  const calendar = qs<HTMLElement>("#todo .todo-calendar");
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

export async function batchProcessPriorityTasks(button?: HTMLButtonElement) {
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

export function renderTodos(todos: Todo[]) {
  const list = qs<HTMLElement>("#todo .todo-list");
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
    const sourceBadge = isAutoMaintenanceTodo(todo)
      ? `<span class="todo-source-badge" title="由自动维护中心生成，可在「自动维护」筛选中单独查看">自动维护</span>`
      : "";
    const optionalMeta = [formatTodoTime(todo.dueAt), todo.related].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join("");
    const isRunning = todo.status === "in_progress" && !todo.done;
    const pinBadge = todo.pinState === "top" ? badge("置顶", "aqua") : todo.pinState === "bottom" ? badge("沉底", "gray") : "";
    const statusBadge = isHistoryView
      ? todo.cancelledAt
        ? badge("已取消", "gray")
        : badge(todo.done ? "历史完成" : "历史归档", todo.done ? "green" : tone)
      : todo.done
        ? badge("已完成", "green")
        : isRunning
          ? badge("进行中", "aqua")
          : badge(todoTypeText(todo.type), tone);
    const runIcon = isRunning ? `<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>` : `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
    const menuOpen = state.openTodoMenuId === todo.id;
    return `<article class="todo-row ${todo.priority === "high" ? "urgent" : ""} ${isRunning ? "in-progress" : ""} ${todo.done ? "done" : ""} ${state.draggingTodoId === todo.id ? "dragging" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <i class="todo-check" title="${todo.done ? "撤回未完成" : todo.reminderRuleId ? "记录跟进结果并完成" : "完成待办"}"></i>
      <div class="todo-main"><h3>${escapeHtml(todo.title)}</h3><div class="todo-meta"><i class="priority-dot" style="--color:var(--${tone === "red" ? "rose" : tone})"></i><span>${escapeHtml(priorityText(todo.priority))}</span>${sourceBadge}${optionalMeta}${pinBadge}${statusBadge}</div></div>
      <div class="todo-side"><div class="todo-actions"><div class="assignee-stack"><span class="mini-avatar">我</span></div>${isHistoryView ? todo.cancelledAt ? "" : `<button class="btn" data-todo-restore>回到今日</button>` : todo.done ? "" : `<button class="todo-run ${isRunning ? "active" : ""}" title="${isRunning ? "停止执行" : "开始执行"}" aria-label="${isRunning ? "停止执行" : "开始执行"}">${runIcon}</button>`}<button class="todo-more ${menuOpen ? "active" : ""}" title="更多操作" aria-label="更多操作"><span></span><span></span><span></span></button>${menuOpen ? `<div class="todo-menu">${isHistoryView ? "" : `<button data-todo-action="edit">编辑</button><button data-todo-action="top">置顶</button><button data-todo-action="bottom">沉底</button>`}<button class="danger" data-todo-action="delete">删除</button></div>` : ""}</div><div class="subtask-bar ${isRunning ? "running" : ""}"><i style="--p:${todo.done ? "100%" : isRunning ? "74%" : "55%"}"></i></div></div>
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
        await deleteTodo(row.dataset.todoId, node as HTMLButtonElement);
        return;
      }
      if (isHistoryView) return;
      await pinTodo(row.dataset.todoId, action as "top" | "bottom");
    });
  });
  qsa<HTMLElement>(".todo-row .todo-check", list).forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      if (!row?.dataset.todoId) return;
      void toggleTodoDone(row.dataset.todoId);
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

/**
 * 待办中心左侧圆圈的统一入口：完成 / 撤回。
 * 提醒规则生成的待办在完成前必须先记录本次跟进处理结果（后端强制校验），
 * 直接 PATCH done=true 会被驳回，所以这里先弹出「记录跟进结果」弹窗；
 * 其余待办直接切换完成状态。
 */
async function toggleTodoDone(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) return;
  if (!todo.done && todo.reminderRuleId) {
    openReminderTaskResult(id);
    return;
  }
  await setTodoDone(id, !todo.done);
}

async function setTodoDone(id: string, done: boolean) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) return;
  try {
    const result = await api<{ todo: Todo }>(`/api/todos/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ done })
    });
    Object.assign(todo, result.todo);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    void refreshDashboardOnly();
    toast(done ? "待办已完成" : "已撤回未完成");
  } catch (error) {
    toast(error instanceof Error ? error.message : "操作失败，请稍后重试", "error");
  }
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
    if (!targetRow || targetRow.dataset.todoId === dragId || targetRow.closest("#todo .todo-list") !== list) return;
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
    const targetId = dropRow?.dataset.todoId && dropRow.closest("#todo .todo-list") === list ? dropRow.dataset.todoId : lastDropId;
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
  const list = qs<HTMLElement>("#todo .todo-history-list");
  const count = qs<HTMLElement>("#todo #todo-history-count");
  const amountNode = qs<HTMLElement>("#todo #todo-history-amount");
  if (count) count.textContent = `${todos.length} 条`;
  if (amountNode) amountNode.textContent = money(todos.reduce((sum, todo) => sum + (todo.impactAmount || 0), 0));
  if (!list) return;
  const recent = todos.slice(0, 5);
  list.innerHTML = recent.length ? recent.map((todo) => {
    const tone = todo.priority === "high" ? "red" : todo.priority === "medium" ? "amber" : "green";
    const meta = [formatTodoTime(todo.dueAt), todo.related, todo.historyAt ? `归档 ${formatTodoTime(todo.historyAt)}` : ""].filter(Boolean).join(" · ") || "未设置上下文";
    const menuOpen = state.openTodoMenuId === todo.id;
    return `<article class="todo-history-row ${todo.done ? "done" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <span class="history-dot ${tone}"></span>
      <div><b>${escapeHtml(todo.title)}</b><span>${escapeHtml(meta)}</span></div>
      <div class="todo-actions">${todo.cancelledAt ? badge("已取消", "gray") : badge(todo.done ? "历史完成" : "历史归档", todo.done ? "green" : tone)}${todo.cancelledAt ? "" : `<button class="btn" data-todo-restore>回到今日</button>`}<button class="todo-more ${menuOpen ? "active" : ""}" title="更多操作" aria-label="更多操作"><span></span><span></span><span></span></button>${menuOpen ? `<div class="todo-menu"><button class="danger" data-todo-action="delete">删除</button></div>` : ""}</div>
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
      if (row?.dataset.todoId) await deleteTodo(row.dataset.todoId, node as HTMLButtonElement);
    });
  });
  qsa<HTMLElement>(".todo-history-row", list).forEach((row) => {
    row.addEventListener("click", () => {
      const todo = state.todos.find((item) => item.id === row.dataset.todoId);
      if (todo) toast(["历史清单", todo.related, todo.dueAt].filter(Boolean).join(" · "));
    });
  });
}

async function deleteTodo(id: string, button?: HTMLButtonElement) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) {
    toast("待办不存在", "error");
    return;
  }
  const confirmed = await confirmAction({
    title: "永久删除待办",
    message: "这条待办会从当前清单和历史记录中永久移除。",
    detail: todo.title,
    detailLabel: "待删除待办",
    consequences: ["相关客户或商机不会被删除", "待办内容与执行记录无法恢复"],
    confirmLabel: "永久删除",
    tone: "danger"
  });
  if (!confirmed) {
    renderTodos(state.todos);
    window.setTimeout(() => {
      const row = qsa<HTMLElement>(".todo-row, .todo-history-row").find((item) => item.dataset.todoId === id);
      row?.querySelector<HTMLButtonElement>(".todo-more")?.focus();
    }, 0);
    return;
  }
  setButtonPending(button || null, true, "删除", "删除中");
  try {
    await api<{ ok: boolean; id: string }>(`/api/todos/${id}`, { method: "DELETE" });
    state.todos = state.todos.filter((item) => item.id !== id);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    void refreshDashboardOnly();
    toast("待办已永久删除");
  } catch (error) {
    setButtonPending(button || null, false, "删除", "删除中");
    toast(error instanceof Error ? error.message : "删除待办失败", "error");
  }
}

async function restoreTodoFromHistory(id: string) {
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) {
    toast("待办不存在", "error");
    return;
  }
  try {
    const result = await api<{ todo: Todo }>(`/api/todos/${id}/restore`, { method: "POST" });
    Object.assign(todo, result.todo);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    void refreshDashboardOnly();
    toast("已恢复到今日清单");
  } catch (error) {
    toast(error instanceof Error ? error.message : "恢复失败，请稍后重试", "error");
  }
}

export function filterTodos(todos: Todo[]) {
  if (state.todoFilter === "overdue") return todos.filter((todo) => todo.priority === "high" && !todo.done);
  if (state.todoFilter === "customer") return todos.filter((todo) => todo.type === "customer");
  if (state.todoFilter === "maintenance") return todos.filter((todo) => isAutoMaintenanceTodo(todo));
  return todos;
}

export function isAutoMaintenanceTodo(todo: Todo) {
  return Boolean(todo.reminderRuleId?.startsWith("maintenance_watch:"));
}

export function updateTodoChips(todos: Todo[]) {
  const chips = qsa<HTMLElement>("#todo .todo-chip");
  const currentTodos = activeTodos(todos);
  const values = [
    `今天 ${currentTodos.filter((todo) => !todo.done).length}`,
    `逾期 ${currentTodos.filter((todo) => todo.priority === "high" && !todo.done).length}`,
    `我负责 ${currentTodos.length}`,
    "客户跟进",
    `历史清单 ${historyTodos(todos).length}`,
    `自动维护 ${currentTodos.filter((todo) => isAutoMaintenanceTodo(todo) && !todo.done).length}`
  ];
  chips.forEach((chip, index) => {
    chip.textContent = values[index] || chip.textContent || "";
    const filters: AppState["todoFilter"][] = ["today", "overdue", "mine", "customer", "history", "maintenance"];
    chip.dataset.todoFilter = filters[index] || "all";
    chip.classList.toggle("active", state.todoFilter === chip.dataset.todoFilter || (state.todoFilter === "all" && index === 0));
  });
}

function priorityText(priority: string) {
  if (priority === "high") return "高优先级";
  if (priority === "medium") return "中优先级";
  return "普通";
}

export function severityText(severity: string) {
  if (severity === "high") return "高";
  if (severity === "medium") return "中";
  return "低";
}

export function severityTone(severity: string) {
  if (severity === "high") return "red";
  if (severity === "medium") return "amber";
  return "green";
}

export function problemStatusText(status: string) {
  if (status === "resolved") return "已解决";
  if (status === "solving") return "解决中";
  return "未解决";
}

export function threatText(level: string) {
  if (level === "high") return "高威胁";
  if (level === "medium") return "中威胁";
  return "低威胁";
}

export function caseStatusText(status: string) {
  return status === "published" ? "已发布" : "草稿";
}

export const LEAD_STAGES = ["新线索", "已联系", "已建联", "已报价", "已转化", "已放弃"];
export const LEAD_STATUS_LABEL: Record<string, string> = { new: "待跟进", following: "跟进中", converted: "已转化", invalid: "无效" };
export const LEAD_STATUS_TONE: Record<string, string> = { new: "gray", following: "amber", converted: "green", invalid: "red" };
export const LEAD_ACTIVITY_LABEL: Record<string, string> = { call: "电话", wechat: "微信", whatsapp: "WhatsApp", linkedin: "LinkedIn", email: "邮件", meeting: "会面", note: "备注", stage: "阶段", system: "系统" };
export const LEAD_PAGE_SIZE = 10;

export function leadStageTone(stage: string) {
  if (stage === "已转化") return "green";
  if (stage === "已报价" || stage === "已建联") return "amber";
  if (stage === "已放弃") return "red";
  return "";
}

export function leadFollowState(lead: Lead) {
  if (!lead.nextFollowAt) return "unset";
  const date = parseTodoDate(lead.nextFollowAt);
  if (!date) return "planned";
  return date.getTime() < Date.now() ? "overdue" : "planned";
}

export function leadSourceLabel(lead: Lead) {
  return lead.sourceChannel || lead.source || "未标注";
}

export function resetLeadFilters() {
  state.leadStageFilter = "all";
  state.leadIntentFilter = "all";
  state.leadSourceFilter = "all";
  state.leadFollowFilter = "all";
  state.leadSearch = "";
  state.leadPage = 1;
  setFieldValue("#leadSearchInput", "");
  setFieldValue("#leadIntentFilter", "all");
  setFieldValue("#leadSourceFilter", "all");
  setFieldValue("#leadFollowFilter", "all");
  state.leadReplyFilter = "all";
  qs<HTMLButtonElement>("#leadReplyFilterButton")?.classList.remove("primary");
  renderLeads();
}
