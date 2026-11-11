// 入口：加载期代码按原顺序在此执行；函数与类型按业务拆分在 ./modules/*.ts。
import "xlsx"; // 保持依赖加载顺序与拆分前一致
import "echarts"; // 保持依赖加载顺序与拆分前一致
import isoCountries from "i18n-iso-countries";
import enCountries from "i18n-iso-countries/langs/en.json";
import zhCountries from "i18n-iso-countries/langs/zh.json";
import { resolveLeadSearchSources } from "./lead-source-selection";
import { resolveLeadAiSearchDraft } from "./lead-ai-search";
import { type MysqlDumpBatch, parseMysqlDump, readMysqlDumpFile, sha256File } from "./mysql-dump-import";
import "./integrations/integration-center"; // 保持依赖加载顺序与拆分前一致
import {
  type AgentStep, type AiEngineJobView, type BackgroundResearch, type BackgroundResearchEntity, type Customer,
  DASHBOARD_LIVE_REFRESH_MS, type DashboardPeriod, type Deal, type DocumentAssetsResponse, EXCHANGE_RATE_REFRESH_MS,
  type Lead, type LeadFinderJob, type LeadFinderLaunchResult, type LeadProviderStatus, type LfindTask,
  type LfindTaskResponse, type Memo, type ProspectRunApiRecord, type ProspectRunDetailApiResponse,
  type ProspectSuperSearchMissionApi, type QuoteHistoryRecord, type Shipment, type TeamSystemSettings, type Todo,
  type TradeDocument, type TradeDocumentOcrProviderConfig, type User, type WebsiteOpportunity,
  documentLogoPlacementKey
} from "./modules/models";
import {
  batchProcessPriorityTasks, filterTodos, loadLeadProviders, loadTenderDaily, refreshAll, refreshDashboardOnly,
  refreshExchangeTicker, refreshVisibleDashboard, renderDashboard, renderLeaderboardPage, renderTodoInsights,
  renderTodos, requestDashboardRefresh, resetLeadFilters, tenderDailyCard, updateTodoChips
} from "./modules/dashboard";
import { customerContactDetails, customerMapController, reloadCustomerScopes, renderCustomerPool, renderCustomers } from "./modules/customers";
import {
  PROSPECT_PAGE_SIZE, applyBriefMode, buildLeadFinderJobDetails, closeProspectRadar, currentLeadFinderResultJob,
  currentLeadFinderSources, currentLeadFinderSubtitle, currentLeadFinderTitle, destroyProspectRadar,
  enrichSelectedProspectContacts, fillLeadAiPreview, formatProspectJoinedAt, generateProspectMailDraft,
  latestContactEnrichment, leadFinderAiReadiness, leadFinderMode, leadFinderScore, populateLeadCountryDatalist,
  prospectBuyerRoleBadge, prospectEmailEligibilityBadge, prospectFilteredRows, prospectMailGenerateLabel,
  prospectRadarController, prospectRequestId, prospectResearchRunning, prospectStatusMeta, renderProspectDetail,
  renderProspectMailPreview, renderSuperAiDiscoveryOption, renderSuperMapSearchOption, renderSuperSearchPreview,
  renderSuperWebSearchOption, renderWebsiteOpportunities, requestProspectExclusion, researchRunningBadgeHtml,
  scrollLeadFinderLiveToLatest, selectedProspect, selectedSuperWebProviderIds, sendProspectDevelopmentEmail,
  setLeadFinderMode, startContactEnrichment, superAiDiscoveryMode, superMapProviders, superMapSearchMode,
  superWebProviders, superWebSearchMode, syncLeadFinderStartState, syncSelectedProspects, toggleSuperAiDiscovery,
  toggleSuperMapSearch, toggleSuperWebSearch, updateProspectBatch, websiteContactDisplay, websiteDomain
} from "./modules/prospecting";
import { installIntegrationCenterInteractions, integrationCenterController, prefillLoginCredentials, workspaceTabKey } from "./modules/events";
import {
  type DatabaseMaintenanceEvent, type DatabaseMaintenanceJob, type MysqlImportSelection, databaseJobStatusLabel,
  databaseJobTypeLabel, deleteBankQuestion, exportQuestionBank, formatFileSize, importQuestionBank,
  mysqlImportHeaders, newQuestionDraft, openExamCategoryModal, openExamCreateModal, openQuestionBankPage,
  renderQuestionBankRows, saveQuestion, setMysqlImportProgress
} from "./modules/exams";
import {
  type AppState, type LeadAiParsed, activeTodos, appliedAgentUiSteps, badge, cookieValue, escapeHtml,
  newAgentConversationId, qs, qsa, renderDashboardCurrentDate, resolvedMemoDrafts, setFieldValue, storage, viewLabels
} from "./modules/shared";
import {
  activeLeadFinderJobId, applySuperSearchMission, closeLeadFinderVerificationDrawer, collectLeadFinderRows,
  leadFinderRemovalSummary, leadFinderRemovedTotal, loadIdentityConflicts, loadProspectFeedback,
  prospectRunActiveStatuses, prospectRunJob, prospectRunStatusLabel, prospectScheduleFrequencyLabel,
  recordLeadFinderLaunchFailure, refreshLeadFinderOpportunities, renderLeadFinderCleaningLedger, renderLeadFinderJobs,
  renderLeadFinderSearchLinks, renderLeadTaskDetail, renderProspectSchedules, stopLeadFinderRunPolling,
  stopLeadTaskEventStream, syncLeadFinderLiveTransport, syncLeadFinderRunPolling, syncLeadTaskDetailClock,
  updateLeadFinderJob
} from "./modules/lead-finder";
import { closeCustomerDrawer, hideContactDock, openCustomerDetailPage } from "./modules/customer-detail";
import {
  ensureInstantCommunicationLoaded, openDevelopmentEmail, openWhatsAppForContact, renderBackgroundResearch,
  saveCompanyProfile
} from "./modules/development-email";
import {
  aiEngineSourceHint, awaitAiEngineJob, effectiveResearchSource, ensureAiEngineSettings, loadAiEngineSettings,
  renderTeamSystemSettings, saveAiEngineSettings, stopCliWaitTicker
} from "./modules/ai-engine-settings";
import { openWhatsAppCustomerPicker, refreshWhatsAppWorkspace, renderWhatsAppThreads, syncWhatsAppRefresh } from "./modules/whatsapp";
import {
  agentUiAction, approveAllExternalAgentSteps, closeAgentSkillDetail, controlAgentMission, createAgentPlan,
  ensureUiLayer, inspectAgentTuning, loadAgentGovernance, loadAgentKnowledge, loadAgentMemories, loadAgentRuns,
  loadAgentSkills, loadAgentTriggers, openAgentGovernance, openAgentKnowledgeCenter, openAgentMemoryManager,
  openAgentTriggerManager, openSkillResourceModal, renderAgent, renderAgentSkillList
} from "./modules/agent";
import {
  type MaintenanceMatrixRow, type MaintenancePresetKey, createSalesDistillationFromUi, loadSalesDistillationWorkspace,
  maintenanceMatrixPresets, readMaintenanceMatrixInputs
} from "./modules/sales-training";
import { loadAccessControl, loadTrialAccounts } from "./modules/access-control";
import { refreshApprovalCenter, refreshApprovalWorkflows, refreshPlatformOperations, setupApprovalEvents } from "./modules/platform-approvals";
import {
  applyAiProviderPreset, deleteAiConfig, loadOcrCard, newAiConfigDraft, recognizeOcrImage, removeOcrCard,
  saveAiConfig, testAiConfig, toggleAiConfigEnabled
} from "./modules/tools";
import { bindMaintenanceCenterEvents, loadMaintenanceCenter } from "./modules/maintenance-center";
import {
  bindOutreachBatchesEvents, bindOutreachJourneyToolbar, bindOutreachPlanCreateButton,
  createLeadOutreachBatchFromSelection, createOutreachBatchFromSelection, loadOutreachBatches,
  loadOutreachJourneyOverview, loadOutreachPlans, outreachJourneyOverview, renderOutreachCustomerJourneyPage,
  renderOutreachJourneyPage
} from "./modules/outreach";
import { bindExchangeEvents, loadExchangeData } from "./modules/exchange";
import { bindSalesSkillCenterEvents, loadSalesSkillCenter } from "./modules/sales-skill-center";
import { type ConfirmActionOptions, type ModalOptions, api, setButtonPending, toast } from "./modules/ui";
import {
  canAccessWorkspaceView, hasIamCapability, isAccessControlView, isPlatformOperator, isSystemAdministrator,
  loginWithPassword, updateProfileSmtpHints, viewPermissionRequirements
} from "./modules/auth";
import {
  changeProfilePassword, checkProfileEmailDomain, clearProfileEmailBinding, clearProfileImapPassword,
  loadEmailTrackingConfig, loadSenderMailboxes, openSenderMailboxModal, renderProfile, saveEmailTrackingConfig,
  saveProfileEmailBinding, sendProfileTestEmail, testProfileImap, updateStoredUser
} from "./modules/profile";
import { closeLeadDrawer, createLead, openLead, openLeadAssignModal, openLeadAssignmentsModal, reloadLeads, renderLeads } from "./modules/leads";
import {
  closeDealDrawer, formatDateTime, openDealModal, refreshClosedDeals, refreshDealArchive, refreshDealsData,
  renderPipeline
} from "./modules/deals";
import {
  PEER_PAGE_SIZE_OPTIONS, clearCurrentUserMemoDrafts, clearMemoDraft, closePeerDrawer, closeProblemDrawer,
  collectMemoEditorDraft, memoRelationText, openCaseModal, openCompetitorModal, openMemoModal, openPeerImportModal,
  openPeerModal, openProblemModal, openReminderModal, patchSelectedMemo, publishSelectedCase, readMemoDraft,
  renderMemoRelationOptions, renderPeers, renderProblems, resetPeerFilters, restoreSelectedMemo, setMemoSaveState,
  toggleCompetitorThreat, visibleMemos, writeMemoDraft
} from "./modules/workspace";
import {
  closeSupplierDrawer, exportSuppliers, filteredSuppliers, loadSuppliers, openSupplierModal, renderSuppliers,
  resetSupplierFilters, sortedSuppliers
} from "./modules/suppliers";
import {
  type AdvancedDocumentTemplate, DOC_PINNED_TEMPLATE_STYLES, activeTradeDocument, addDocumentItem,
  advancedDocumentCategoryLabels, applyDataSource, applyDocumentCustomerDefaults, applyMatchedSellerToEditor,
  approveActiveDocument, bindDocumentLogoInline, collectDocumentDraft, createDocumentRevision, currentDocumentType,
  defaultTradeDocument, documentTypeLabel, downloadAdvancedExcel, downloadCustomerTemplate, exportCustomers,
  exportTradeDocumentPdf, formatDocumentMoney, importCustomersFromFile, loadDocumentHistory, loadQuoteHistory,
  openDocumentAssetManager, openDocumentConversion, openNewDocument, openProductPicker, openTradeDocumentImport,
  openTradeDocumentOcr, rejectActiveDocument, renderDocThemeSwatches, renderDocumentPreview, renderTradeDocuments,
  resetDocumentHistoryFilters, resetQuoteHistoryFilters, saveDocumentDefaults, sendActiveDocument, setDocumentType,
  setDocumentWorkspaceMode, setQuoteHistoryMode, submitDocumentApproval, syncShippingCostLabel, updateActiveDocument
} from "./modules/trade-documents";
import { syncWecomMessages } from "./modules/wecom";
import { openKnowledgeModal, refreshKnowledgeAssets, renderKnowledge } from "./modules/knowledge";
import { bindKbTrainingEvents, loadKbTraining, stopKbTrainingPoll } from "./modules/kb-training";
import {
  databaseJobEndpoint, databaseLogText, databaseMaintenanceJobs, databaseMaintenanceStatus, downloadDatabaseBackup,
  downloadDatabaseLog, fitBatchToSchema, refreshDatabaseMaintenance, renderDatabaseStream, renderMysqlImport,
  splitLargeMysqlImportBatch, waitForMysqlImportRestart
} from "./modules/database-maintenance";
import {
  bulkDeleteProducts, closeProductModal, currentProductVisibleIds, deleteProduct, editingProductId,
  openProductCategoryManager, openProductDrawer, openProductModal, renderProducts, saveProduct
} from "./modules/products";
import {
  addShipmentItemRow, bulkDeleteShipments, currentShipmentVisibleIds, deleteShipment, openShipmentDrawer,
  renderShipments, saveShipment, searchDeals, shipmentDestinationDefaults, syncAllShipments, syncGlobalRouteDocuments,
  syncShipmentNow
} from "./modules/shipments";
import { renderGlobalMap, renderKpiBoard, renderRelationGraph, stopGmTimeline } from "./modules/insights";
import { loadLogs, openLogDrawer } from "./modules/logs";
import {
  type CliAcquirePayload, canSelectLeadFinderItem, createLeadFinderTodos, exportLeadFinderRows, leadFinderValues,
  leadSourceBlockedMessage, loadCliAcquireHistory, openCliAcquireModal, openLeadSourceCenter,
  registerWebsiteReferences, renderLeadFinder, upsertCliAcquireStore
} from "./modules/lead-sources";
import {
  createQuickTodo, exportPlanCsv, openPlanTaskModal, openTodoModal, openWebsiteQualification, pushPlanTasksToTodos,
  savePlanMemo
} from "./modules/plan-tasks";
import { openCustomerModal, syncOcrLead } from "./modules/customer-intake";
import { exportReport, localDateValue, openReportNoteModal, openReportRiskModal, refreshExecutiveReport } from "./modules/reports";
import {
  buildDailyDraft, fillDailyReportFromDraft, markAllInternalMessagesRead, nl2br, openDailyReportModal,
  refreshDailyReports, refreshInternalMessageBadge, refreshInternalMessages
} from "./modules/collaboration";
import {
  THEME_DEFAULT, THEME_PRESETS, applyTheme, contrastRatio, getInitialTheme, initSystemUpdate, loadProductConfig,
  openSecondaryDropdownForView, renderTopbarForView, resolveTopbarSearchView, restoreSession, saveTheme,
  setThemeStatus, workspaceViewStorageKey
} from "./modules/navigation";
import { disposeContainerLoad, renderContainerLoad } from "./modules/container-load";
import { renderEmailReturnFlow } from "./modules/email-return-flow";
import { MAIL_SECTION_ITEMS, loadMailCenter, mcComposeDraftSaveNow, renderMailSectionNav } from "./modules/mail-center";
import { loadOrders, openOrderDetail, ordWireList } from "./modules/orders";
import { bindFileCenterEvents, loadFileCenter } from "./modules/file-center";
import { renderAutoFlow, stopAutoFlowFeed } from "./modules/auto-flow";


isoCountries.registerLocale(enCountries);
isoCountries.registerLocale(zhCountries);
export const countryFlagAssets = Object.fromEntries(Object.entries(import.meta.glob(
  "../../node_modules/flag-icons/flags/4x3/*.svg",
  { eager: true, query: "?url", import: "default" }
) as Record<string, string>).map(([file, url]) => [file.split("/").pop()?.replace(/\.svg$/u, "") || "", url]));
let advancedExcelEditReturnTemplateId = "";

export const state: AppState = {
  user: null,
  iamCapabilities: null,
  summary: null,
  customers: [],
  publicCustomers: [],
  customerPoolCounts: { mineCount: 0, publicCount: 0 },
  customerPoolSearch: "",
  customerPoolGradeFilter: "all",
  leads: [],
  leadTrash: [],
  leadActivities: [],
  selectedLeadId: null,
  leadView: "active",
  leadStageFilter: "all",
  leadIntentFilter: "all",
  leadSourceFilter: "all",
  leadFollowFilter: "all",
  leadReplyFilter: "all",
  selectedLeadIds: [],
  leadSearch: "",
  leadPage: 1,
  whatsappThreads: [],
  whatsappMessages: [],
  whatsappBinding: null,
  whatsappModes: null,
  selectedWaCustomerId: null,
  waThreadSearch: "",
  todos: [],
  deals: [],
  dealEvents: [],
  closedDeals: [],
  closedDealTotal: 0,
  closedDealCounts: { won: 0, lost: 0, revisit: 0 },
  closedDealPage: 1,
  closedDealKeyword: "",
  closedDealStatus: "all",
  closedDealMonth: "",
  dealArchive: [],
  dealArchiveTotal: 0,
  dealArchiveCounts: { won: 0, lost: 0 },
  dealArchivePage: 1,
  dealArchiveKeyword: "",
  dealArchiveStage: "all",
  dealArchiveMonth: "",
  selectedDealId: null,
  pipelineStageFilter: "询盘",
  pipelineSearch: "",
  pipelineDueFilter: "all",
  reminders: [],
  reminderView: "tasks",
  reminderFilter: "pending",
  jobs: [],
  tradeDocuments: [],
  globalRouteDocuments: [],
  documentDefaultProfile: null,
  documentAssets: { letterheads: [], stamps: [], signatures: [], canManage: false },
  documentDefaultsCanManage: false,
  documentHistoryPage: 1,
  documentHistoryPageCount: 1,
  documentHistoryTotal: 0,
  quoteHistoryPage: 1,
  quoteHistoryPageCount: 1,
  quoteHistoryTotal: 0,
  quoteHistoryMode: "records",
  quoteProductAnalysis: undefined,
  quoteHistoryFocusId: "",
  wecomMessages: [],
  dailyReports: [],
  dailyReportOwners: [],
  dailyReportCanViewTeam: false,
  dailyReportComments: [],
  selectedDailyReportId: null,
  dailyReportFrom: "",
  dailyReportTo: "",
  dailyReportOwnerId: "",
  internalMessages: [],
  internalUnreadCount: 0,
  knowledgeAssets: [],
  knowledgeSearch: "",
  knowledgeCategoryFilter: "all",
  knowledgeSourceFilter: "all",
  knowledgeStatusFilter: "all",
  knowledgeTypeFilter: "all",
  selectedKnowledgeAssetId: null,
  exams: [],
  examQuestions: [],
  examReport: null,
  ocrJob: null,
  websiteOpportunities: [],
  agentRun: null,
  agentRuns: [],
  agentConversations: [],
  agentMissionCheckpoints: [],
  agentMemories: [],
  agentKnowledgeDocuments: [],
  agentKnowledgeOverview: null,
  agentSkills: [],
  agentSkillDirectory: "agent-skills",
  agentSkillCanManage: false,
  agentTriggerRules: [],
  agentTriggerEvents: [],
  agentGovernance: null,
  agentCheckpointRunId: "",
  outreachSequences: [],
  customerMaintenanceWatches: [],
  maintenancePreview: null,
  maintenanceFindings: {},
  maintenanceActiveWatchId: "",
  maintenanceLoading: false,
  outreachBatches: [],
  agentLoading: false,
  salesDistillations: [],
  salesPlaybookActivations: [],
  salesDistillationSources: [],
  salesDistillationLoading: false,
  salesTrainingRuns: [],
  aiConfig: null,
  aiConfigs: [],
  selectedAiConfigId: null,
  products: [],
  productCategories: [],
  shipments: [],
  logs: [],
  selectedProductIds: [],
  selectedShipmentIds: [],
  aiDraftMode: false,
  pendingAiDeleteId: null,
  problems: [],
  memos: [],
  deletedMemos: [],
  memoStatus: "active",
  memoSearch: "",
  memoPinnedOnly: false,
  planTasks: [],
  planTemplates: [],
  selectedPlanTaskIds: [],
  planTaskView: "today",
  planTaskStatusFilter: "open",
  competitors: [],
  peers: [],
  peerSearch: "",
  peerRelationFilter: "all",
  peerSort: "newest",
  peerPage: 1,
  peerPageSize: 20,
  selectedPeerId: null,
  suppliers: [],
  suppliersLoaded: false,
  supplierSearch: "",
  supplierStatusFilter: "all",
  supplierPage: 1,
  supplierPageSize: 20,
  selectedSupplierId: null,
  selectedSupplierIds: [],
  caseStudies: [],
  commissionProducts: [],
  commissionRules: [],
  commissionRecords: [],
  commissionCalculations: [],
  commissionItems: [],
  commissionCanManage: false,
  commissionCanReview: false,
  commissionCanSelectOwner: false,
  commissionOwners: [],
  selectedCommissionOwnerId: "",
  commissionMonth: new Date().toISOString().slice(0, 7),
  commissionFilter: "all",
  selectedCommissionRecordId: null,
  selectedCommissionCalculationId: null,
  accounts: [],
  executiveReport: null,
  reportNote: "",
  dashboardPeriod: "today",
  morningView: false,
  todoFilter: "all",
  openTodoMenuId: null,
  draggingTodoId: null,
  selectedCustomerId: null,
  selectedCustomerIds: [],
  customerSearch: "",
  customerQueueFilter: "all",
  customerOutcomeFilter: "open",
  customerViewMode: "list",
  customerPage: 1,
  customerPageSize: 20,
  selectedProblemId: null,
  problemSearch: "",
  problemStatusFilter: "all",
  problemSeverityFilter: "all",
  problemCategoryFilter: "all",
  selectedMemoId: null,
  selectedPlanTemplateId: null,
  selectedCompetitorId: null,
  selectedCaseId: null,
  selectedExamId: null,
  selectedExamIds: [],
  examCanManage: false,
  examCandidates: [],
  examWorkspaceMode: "mine",
  selectedQuestionId: null,
  selectedDocumentId: null,
  selectedLeadFinderId: null,
  leadFinderFilter: "all",
  leadFinderPage: 1,
  selectedProspectId: null,
  selectedProspectIds: [],
  prospectFilter: "all",
  prospectBuyerOnly: false,
  prospectJoinedRange: "all",
  prospectJoinedFrom: "",
  prospectJoinedTo: "",
  prospectSort: "joined_desc",
  prospectPage: 1,
  prospectAssignees: [],
  prospectQualifications: {},
  procurementContexts: {},
  prospectPerformance: null,
  prospectStrategySuggestions: [],
  prospectSchedules: [],
  identityConflicts: [],
  leadProviders: [],
  selectedLeadSources: [],
  leadSourceSelectionTouched: false
};

let memoDirty = false;
let memoSaving = false;
let memoSavePromise: Promise<void> | null = null;
let memoSaveTimer = 0;
let memoEditRevision = 0;
let memoMobileDetailOpen = false;
let memoDeleteBusy = false;
export let leadFinderJobs: LeadFinderJob[] = [];
let leadFinderRunsLoading = false;
let lfindTaskPollTimer = 0;
let leadFinderResultView: "candidates" | "cleaning" = "candidates";
export let leadFinderCleaningFilter: "all" | "merged" | "suppressed" | "rejected" = "all";
// 搜索简报的输入方式：自然语言 / 结构化表单，二者互斥，避免意图叠加互相限制
export let leadBriefMode: "nl" | "form" = "nl";
let leadAiParsed: LeadAiParsed | null = null;
let leadAiParseLastError = "";
let leadAiParseInFlight: Promise<boolean> | null = null;
let prospectMobileDetailOpen = false;
let prospectMobileListScrollY = 0;
export let backgroundResearchSubject: { entityType: BackgroundResearchEntity; entityId: string; company: string; backView: string } | null = null;
export let backgroundResearchResult: BackgroundResearch | null = null;
export let backgroundResearchLoading = false;
export let backgroundResearchStage = 0;
let backgroundResearchStageTimer = 0;
/** 走本机 CLI 时的进度提示（后端作业号 + 机器名），非 CLI 时为空 */
export let backgroundResearchProgressNote = "";
export let teamSystemSettings: TeamSystemSettings = { teamId: "", requireDocumentExcelApproval: false, updatedBy: "", updatedAt: "" };
export let tradeDocumentOcrProvider: TradeDocumentOcrProviderConfig = { provider: "none", enabled: false, hasApiKey: false, hasSecretKey: false, model: "", baseUrl: "" };
export let teamSystemSettingsCanManage = false;
export let agentOriginView = "dashboard";
let agentConversationId = "";
let agentConversationOwnerId = "";
export let agentSkillQuery = "";
export let agentSkillCategoryFilter = "all";
export let agentSkillStatusFilter = "all";
export let agentSkillSourceFilter = "all";
let openWorkspaceTabs = ["dashboard"];
let workspaceTabHistory = ["dashboard"];

export function ensureAgentConversationId(userId = state.user?.id || "anonymous") {
  const key = `gj_agent_conversation_${userId}`;
  if (!agentConversationId || agentConversationOwnerId !== userId) {
    agentConversationOwnerId = userId;
    agentConversationId = localStorage.getItem(key) || newAgentConversationId();
  }
  localStorage.setItem(key, agentConversationId);
  return agentConversationId;
}

function startNewAgentConversation() {
  agentConversationId = newAgentConversationId();
  ensureAgentConversationId();
  state.agentRun = null;
  state.agentRuns = [];
  appliedAgentUiSteps.clear();
  renderAgent(null);
  renderAgentConversations();
  qs<HTMLTextAreaElement>("#agentGoalInput")?.focus();
}

export function applyAgentUiAction(step: AgentStep) {
  if (step.status !== "done" || appliedAgentUiSteps.has(step.id)) return;
  const action = agentUiAction(step.result);
  if (!action) return;
  appliedAgentUiSteps.add(step.id);
  if (action.type === "refresh") {
    if (state.user) void refreshAll(state.user).then(() => renderAgent(state.agentRun));
    return;
  }
  if (action.type === "navigate" && action.view) {
    const aliases: Record<string, string> = { deals: "pipeline", deal: "pipeline", opportunities: "pipeline", opportunity: "pipeline", communication: "whatsapp", customer: "customers", lead: "leads", "trade-documents": "documents", document: "documents", invoices: "documents" };
    const view = aliases[action.view.toLowerCase()] || action.view;
    if (!qs<HTMLElement>(`#${CSS.escape(view)}`)) {
      toast("Agent 返回了未知页面，未执行跳转", "error");
      return;
    }
    activateNavView(view);
    return;
  }
  if (action.type === "open_customer" && action.customerId) {
    const customer = state.customers.find((item) => item.id === action.customerId);
    if (customer) openCustomerDetailPage(customer);
    return;
  }
  if (action.type === "open_lead" && action.leadId) {
    activateNavView("leads", () => void openLead(action.leadId || ""));
    return;
  }
  if (action.type === "open_development_email" && action.entityType && action.entityId) {
    const entity = action.entityType === "customer"
      ? state.customers.find((item) => item.id === action.entityId)
      : state.leads.find((item) => item.id === action.entityId);
    if (entity) openDevelopmentEmail(action.entityType, action.entityId, entity.company, "ai-agent", action.entityType === "customer" ? customerContactDetails(entity as Customer).whatsapp : (entity as Lead).phone || "");
    return;
  }
  if (action.type === "open_communication" && action.customerId) {
    const customer = state.customers.find((item) => item.id === action.customerId);
    if (customer) void openWhatsAppForContact({ phone: customerContactDetails(customer).whatsapp, displayName: customer.contact || customer.company });
    return;
  }
  if (action.type === "open_research" && action.entityType && action.entityId && step.result?.research) {
    const research = step.result.research as unknown as BackgroundResearch;
    backgroundResearchSubject = { entityType: action.entityType, entityId: action.entityId, company: research.company, backView: "ai-agent" };
    backgroundResearchResult = research;
    backgroundResearchLoading = false;
    activateNavView("ai-research", renderBackgroundResearch);
  }
}

export function renderAgentSkillFilters() {
  const select = qs<HTMLSelectElement>("#agentSkillsCategoryFilter");
  if (!select) return;
  const categories = [...new Set(state.agentSkills.map((skill) => skill.category).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
  select.innerHTML = `<option value="all">全部分类</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`;
  select.value = categories.includes(agentSkillCategoryFilter) ? agentSkillCategoryFilter : "all";
  agentSkillCategoryFilter = select.value;
}

export let maintenanceMatrixPreset: MaintenancePresetKey = "balanced";
export let maintenanceMatrixDraft: MaintenanceMatrixRow[] = [];

export function currentMaintenanceMatrixRows() {
  if (!maintenanceMatrixDraft.length) {
    maintenanceMatrixDraft = maintenanceMatrixPresets[maintenanceMatrixPreset].rows.map((row) => ({ ...row }));
  }
  return maintenanceMatrixDraft;
}

export function renderMaintenanceMatrix() {
  const body = qs<HTMLElement>("#maintenanceMatrixBody");
  const presets = qs<HTMLElement>("#maintenanceMatrixPresets");
  const note = qs<HTMLElement>("#maintenanceMatrixNote");
  if (presets) {
    presets.innerHTML = (Object.keys(maintenanceMatrixPresets) as MaintenancePresetKey[]).map((key) =>
      `<button class="mt-preset ${key === maintenanceMatrixPreset ? "active" : ""}" type="button" data-maintenance-preset="${key}">${escapeHtml(maintenanceMatrixPresets[key].label)}${key === "balanced" ? "（推荐）" : ""}</button>`
    ).join("");
  }
  if (note) note.textContent = maintenanceMatrixPresets[maintenanceMatrixPreset].note;
  if (body) {
    body.innerHTML = currentMaintenanceMatrixRows().map((row) => `<tr>
      <td><span class="mt-grade">${escapeHtml(row.label)}</span></td>
      <td><input type="number" min="1" max="90" value="${row.inactivityDays}" data-matrix-row="${row.id}" data-matrix-field="inactivityDays"></td>
      <td><input type="number" min="0" max="100" value="${row.healthBelow}" data-matrix-row="${row.id}" data-matrix-field="healthBelow"></td>
      <td><input type="number" min="1" max="168" value="${row.intervalHours}" data-matrix-row="${row.id}" data-matrix-field="intervalHours"></td>
      <td><input type="number" min="1" max="50" value="${row.maxTodosPerRun}" data-matrix-row="${row.id}" data-matrix-field="maxTodosPerRun"></td>
      <td>${escapeHtml(row.intensity)}</td>
      <td>${escapeHtml(row.automation)}</td>
    </tr>`).join("");
  }
  qsa<HTMLButtonElement>("#maintenanceMatrixPresets [data-maintenance-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      readMaintenanceMatrixInputs();
      maintenanceMatrixPreset = (button.dataset.maintenancePreset || "balanced") as MaintenancePresetKey;
      maintenanceMatrixDraft = maintenanceMatrixPresets[maintenanceMatrixPreset].rows.map((row) => ({ ...row }));
      renderMaintenanceMatrix();
    });
  });
}

export function renderAgentConversations() {
  const list = qs<HTMLElement>("#agentConversationList");
  if (!list) return;
  list.innerHTML = state.agentConversations.length
    ? state.agentConversations.slice(0, 12).map((item) => `<button type="button" class="agent-conversation-item${item.id === agentConversationId ? " active" : ""}" data-agent-conversation="${escapeHtml(item.id)}"><span>${escapeHtml(item.title)}</span><small>${item.turnCount} 轮 · ${new Date(item.updatedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}</small></button>`).join("")
    : `<div class="agent-conversation-empty">暂无历史对话</div>`;
  qsa<HTMLButtonElement>("[data-agent-conversation]", list).forEach((button) => button.addEventListener("click", () => {
    agentConversationId = button.dataset.agentConversation || newAgentConversationId();
    ensureAgentConversationId();
    state.agentRun = null;
    state.agentRuns = [];
    appliedAgentUiSteps.clear();
    renderAgent(null);
    renderAgentConversations();
    void loadAgentRuns();
  }));
}

let modalDismissHandler: (() => void) | null = null;
let modalReturnFocus: HTMLElement | null = null;
let modalBodyOverflow = "";
export let modalCloseOnBackdrop = false;

export function openModal(title: string, body: string, foot: string, options: ModalOptions = {}) {
  ensureUiLayer();
  if (modalDismissHandler) {
    const dismiss = modalDismissHandler;
    modalDismissHandler = null;
    dismiss();
  }
  const modalRoot = qs<HTMLElement>("#appModal")!;
  modalCloseOnBackdrop = options.closeOnBackdrop ?? false;
  if (!modalRoot.classList.contains("active")) {
    modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalBodyOverflow = document.body.style.overflow;
  }
  document.body.style.overflow = "hidden";
  modalRoot.setAttribute("role", "dialog");
  modalRoot.removeAttribute("aria-describedby");
  qs<HTMLElement>("#appModal .modal")?.classList.remove("customs-workspace-modal", "agent-memory-modal", "agent-knowledge-modal", "confirm-modal", "advanced-excel-modal", "excel-preview-modal", "trade-document-import-modal", "document-asset-editor-modal", "document-asset-manager-modal", "deal-editor-modal", "ac-guide-modal", "outreach-policy-modal", "outreach-plan-detail-modal", "outreach-plan-create-modal", "sender-mailbox-modal", "lead-assignment-modal", "customer-editor-modal", "supplier-editor-modal", "ord-edit-modal", "od-pick-modal");
  if (options.modalClass) qs<HTMLElement>("#appModal .modal")?.classList.add(options.modalClass);
  qs("#modalTitle")!.textContent = title;
  qs<HTMLElement>("#modalDescription")!.textContent = options.description
    ?? (title.includes("删除") || title.includes("停用") ? "此操作可能影响现有业务数据" : "填写信息后保存，随时可以关闭此窗口");
  qs("#modalBody")!.innerHTML = body;
  qs("#modalFoot")!.innerHTML = foot;
  qsa("[data-modal-close]", qs("#appModal")!).forEach((node) => node.addEventListener("click", closeModal));
  qs("#appModal")!.classList.add("active");
  window.setTimeout(() => qs<HTMLElement>("#appModal input, #appModal select, #appModal textarea, #appModal [data-modal-cancel], #appModal button:not([data-modal-close])")?.focus(), 50);
}

export function closeModal() {
  qs("#appModal")?.classList.remove("active");
  modalCloseOnBackdrop = false;
  document.body.style.overflow = modalBodyOverflow;
  const dismiss = modalDismissHandler;
  modalDismissHandler = null;
  dismiss?.();
  const returnFocus = modalReturnFocus;
  modalReturnFocus = null;
  window.setTimeout(() => {
    if (returnFocus?.isConnected) returnFocus.focus();
  }, 0);
}

export function confirmAction({
  title,
  message,
  consequences = [],
  detail = "",
  detailLabel = "本次选择",
  confirmLabel = "确认",
  tone = "danger",
  verificationText
}: ConfirmActionOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const verification = verificationText
      ? `<label class="confirm-verification"><span>输入 <b>${escapeHtml(verificationText)}</b> 以继续</span><input id="confirmVerificationInput" autocomplete="off" inputmode="numeric" aria-describedby="confirmVerificationHint"><small id="confirmVerificationHint">用于避免批量操作被误触</small></label>`
      : "";
    const consequenceList = consequences.length
      ? `<div class="confirm-consequences"><b>确认后将发生</b><ul>${consequences.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
      : "";
    const selection = detail ? `<div class="confirm-selection"><span>${escapeHtml(detailLabel)}</span><strong>${escapeHtml(detail)}</strong></div>` : "";

    openModal(title, `
      <div class="confirm-dialog confirm-${tone}">
        <div class="confirm-symbol" aria-hidden="true">!</div>
        <div class="confirm-copy">
          <p id="confirmDialogDescription">${escapeHtml(message)}</p>
          ${selection}
          ${consequenceList}
          ${verification}
        </div>
      </div>
    `, `<button class="btn" data-modal-close data-modal-cancel type="button">取消</button><button class="btn ${tone === "danger" ? "danger" : tone === "warning" ? "warning" : "primary"}" id="confirmActionButton" type="button" ${verificationText ? "disabled" : ""}>${escapeHtml(confirmLabel)}</button>`);

    const modalRoot = qs<HTMLElement>("#appModal")!;
    modalRoot.setAttribute("role", "alertdialog");
    modalRoot.setAttribute("aria-describedby", "confirmDialogDescription");
    qs<HTMLElement>("#appModal .modal")?.classList.add("confirm-modal");
    const confirmButton = qs<HTMLButtonElement>("#confirmActionButton")!;
    const input = qs<HTMLInputElement>("#confirmVerificationInput");
    if (input && verificationText) {
      input.addEventListener("input", () => {
        confirmButton.disabled = input.value.trim() !== verificationText;
      });
      input.focus();
    }
    modalDismissHandler = () => resolve(false);
    confirmButton.addEventListener("click", () => {
      modalDismissHandler = null;
      closeModal();
      resolve(true);
    });
  });
}

document.addEventListener("keydown", (event) => {
  const modalRoot = qs<HTMLElement>("#appModal");
  if (!modalRoot?.classList.contains("active")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = qsa<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])", modalRoot)
    .filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

export function syncWorkspaceAccess(user = state.user) {
  document.body.classList.toggle("platform-mode", isPlatformOperator(user));
  qsa<HTMLElement>("[data-admin-only]").forEach((node) => {
    node.hidden = !isSystemAdministrator(user);
  });
  const restrictedViews = new Set<string>();
  qsa<HTMLElement>(".sidebar button[data-view]").forEach((node) => {
    const view = node.dataset.view || "";
    const restricted = !canAccessWorkspaceView(view, user);
    node.hidden = restricted;
    if (restricted) restrictedViews.add(view);
  });
  Object.keys(viewPermissionRequirements).forEach((view) => {
    const node = qs<HTMLElement>(`#${CSS.escape(view)}`);
    if (node) node.hidden = !canAccessWorkspaceView(view, user);
  });
  qsa<HTMLElement>("[data-permission]").forEach((node) => {
    const permission = String(node.dataset.permission || "").trim();
    if (permission && state.iamCapabilities) node.hidden = !hasIamCapability(permission);
  });
  openWorkspaceTabs = openWorkspaceTabs.filter((view) => !restrictedViews.has(view));
  workspaceTabHistory = workspaceTabHistory.filter((view) => !restrictedViews.has(view));
  const activeRestrictedView = [...restrictedViews].find((view) => qs<HTMLElement>(`#${CSS.escape(view)}`)?.classList.contains("active"));
  if (activeRestrictedView) activateNavView(isPlatformOperator(user) ? "platform-operations" : "dashboard");
}

export async function runBackgroundResearch() {
  const subject = backgroundResearchSubject;
  if (!subject || backgroundResearchLoading) return;
  await ensureAiEngineSettings();
  const source = effectiveResearchSource();
  backgroundResearchLoading = true;
  backgroundResearchResult = null;
  backgroundResearchProgressNote = "";
  backgroundResearchStage = 0;
  if (backgroundResearchStageTimer) window.clearInterval(backgroundResearchStageTimer);
  backgroundResearchStageTimer = window.setInterval(() => {
    if (backgroundResearchStage < 4) {
      backgroundResearchStage += 1;
      renderBackgroundResearch();
    }
  }, 2600);
  renderBackgroundResearch();
  try {
    const result = await api<{
      research: BackgroundResearch | null;
      pending?: boolean;
      engineJob?: AiEngineJobView;
      runnerName?: string;
      engine?: string;
    }>("/api/ai-background-research", {
      method: "POST",
      body: JSON.stringify({ entityType: subject.entityType, entityId: subject.entityId, source })
    });
    if (result.pending && result.engineJob) {
      // 本机 CLI 还在跑：转到轮询，进度实时回显在背调动画下面
      backgroundResearchProgressNote = `已派给 ${result.runnerName || "本机 Runner"}（${result.engine || "CLI"}），正在调研…`;
      renderBackgroundResearch();
      const payload = await awaitAiEngineJob(result.engineJob, (job) => {
        backgroundResearchProgressNote = job.status === "running"
          ? `本机 CLI 执行中（${job.engine || "CLI"}），作业号 ${job.id.slice(-8)}…`
          : backgroundResearchProgressNote;
        renderBackgroundResearch();
      });
      backgroundResearchResult = (payload.research || null) as BackgroundResearch | null;
    } else {
      backgroundResearchResult = result.research;
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : "背调失败", "error");
  } finally {
    if (backgroundResearchStageTimer) window.clearInterval(backgroundResearchStageTimer);
    backgroundResearchStageTimer = 0;
    stopCliWaitTicker("research");
    backgroundResearchLoading = false;
    backgroundResearchProgressNote = "";
    renderBackgroundResearch();
  }
}

export function openBackgroundResearch(entityType: BackgroundResearchEntity, entityId: string, company: string, backView: string) {
  backgroundResearchSubject = { entityType, entityId, company, backView };
  backgroundResearchResult = null;
  closeLeadDrawer();
  closeCustomerDrawer();
  activateNavView("ai-research", () => {
    renderBackgroundResearch();
    void runBackgroundResearch();
  });
}

async function loadTeamSystemSettings() {
  const result = await api<{ settings: TeamSystemSettings; ocr: TradeDocumentOcrProviderConfig; canManage: boolean }>("/api/system-settings");
  teamSystemSettings = result.settings;
  tradeDocumentOcrProvider = result.ocr;
  teamSystemSettingsCanManage = result.canManage;
  await loadAiEngineSettings().catch(() => undefined);
  renderTeamSystemSettings();
  return result.settings;
}

async function saveTradeDocumentOcrProvider(button?: HTMLButtonElement) {
  if (!teamSystemSettingsCanManage) return;
  const provider = qs<HTMLSelectElement>("#tradeDocumentOcrProvider")?.value || "none";
  const enabled = Boolean(qs<HTMLInputElement>("#tradeDocumentOcrEnabled")?.checked);
  const apiKey = qs<HTMLInputElement>("#tradeDocumentOcrApiKey")?.value || "";
  const secretKey = qs<HTMLInputElement>("#tradeDocumentOcrSecretKey")?.value || "";
  const model = qs<HTMLInputElement>("#tradeDocumentOcrModel")?.value.trim() || "";
  try {
    if (button) setButtonPending(button, true, "保存 OCR 配置", "保存中");
    const result = await api<{ ocr: TradeDocumentOcrProviderConfig }>("/api/system-settings/ocr", { method: "PUT", body: JSON.stringify({ provider, enabled, apiKey, secretKey, model }) });
    tradeDocumentOcrProvider = result.ocr;
    if (qs<HTMLInputElement>("#tradeDocumentOcrApiKey")) qs<HTMLInputElement>("#tradeDocumentOcrApiKey")!.value = "";
    if (qs<HTMLInputElement>("#tradeDocumentOcrSecretKey")) qs<HTMLInputElement>("#tradeDocumentOcrSecretKey")!.value = "";
    renderTeamSystemSettings();
    toast(tradeDocumentOcrProvider.enabled ? "外部 OCR 已启用，识别时优先使用" : "外部 OCR 已关闭，将使用原 AI 视觉模型", "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "OCR 配置保存失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "保存 OCR 配置", "保存中");
  }
}

async function saveTeamSystemSettings(button?: HTMLButtonElement) {
  if (!teamSystemSettingsCanManage) return;
  const requireDocumentExcelApproval = Boolean(qs<HTMLInputElement>("#documentExcelApprovalSetting")?.checked);
  try {
    if (button) setButtonPending(button, true, "保存设置", "保存中");
    const result = await api<{ settings: TeamSystemSettings; canManage: boolean }>("/api/system-settings", {
      method: "PUT",
      body: JSON.stringify({ requireDocumentExcelApproval })
    });
    teamSystemSettings = result.settings;
    teamSystemSettingsCanManage = result.canManage;
    renderTeamSystemSettings();
    toast(requireDocumentExcelApproval ? "Excel 正式导出审批已开启" : "Excel 正式导出审批已关闭", "success");
  } catch (error) {
    renderTeamSystemSettings();
    toast(error instanceof Error ? error.message : "系统设置保存失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "保存设置", "保存中");
  }
}

export function renderMemos(_memos?: Memo[]) {
  const sorted = visibleMemos();
  if (state.selectedMemoId && !sorted.some((item) => item.id === state.selectedMemoId)) state.selectedMemoId = sorted[0]?.id || null;
  const list = qs<HTMLElement>("#memos .memo-list");
  if (list) {
    list.innerHTML = sorted.length ? sorted.map((memo) => `<article class="memo-card ${state.selectedMemoId === memo.id ? "selected" : ""} ${memo.archived ? "archived" : ""}" data-memo-id="${escapeHtml(memo.id)}">
      <div class="memo-top"><h3>${escapeHtml(memo.title)}</h3>${badge(memo.deletedAt ? "已删除" : memo.archived ? "归档" : memo.pinned ? "置顶" : memo.category, memo.deletedAt || memo.archived ? "" : memo.pinned ? "green" : "amber")}</div>
      <div class="memo-meta"><span>${escapeHtml(memo.category)}</span><span>${escapeHtml(memo.tags || "无标签")}</span><span>${escapeHtml(formatDateTime(memo.updatedAt))}</span></div>
      <p>${escapeHtml(memo.content.slice(0, 82) || "空白备忘")}</p>
      ${memoRelationText(memo) ? `<div class="memo-relation">${escapeHtml(memoRelationText(memo))}</div>` : ""}
    </article>`).join("") : `<div class="todo-history-empty">暂无备忘</div>`;
    qsa<HTMLElement>(".memo-card", list).forEach((card) => {
      card.addEventListener("click", async () => {
        await saveCurrentMemoDraft();
        state.selectedMemoId = card.dataset.memoId || null;
        memoMobileDetailOpen = true;
        renderMemos();
      });
    });
  }
  qsa<HTMLButtonElement>("[data-memo-status]").forEach((button) => button.classList.toggle("active", button.dataset.memoStatus === state.memoStatus));
  const pinnedOnly = qs<HTMLInputElement>("#memoPinnedOnly");
  if (pinnedOnly) pinnedOnly.checked = state.memoPinnedOnly;
  qs("#memoGrid")?.classList.toggle("detail-open", memoMobileDetailOpen);
  renderMemoDetail(sorted.find((item) => item.id === state.selectedMemoId) || sorted[0]);
}

function renderMemoDetail(memo?: Memo) {
  if (!memo) {
    qs("#memo-detail-title")!.textContent = "备忘详情";
    qs("#memo-detail-meta")!.textContent = "未选择";
    const titleEditor = qs<HTMLInputElement>("#memoTitleEditor");
    const tagsEditor = qs<HTMLInputElement>("#memoTagsEditor");
    const contentEditor = qs<HTMLTextAreaElement>("#memoContentEditor");
    // 不要用 value 当提示：写进 value 的「暂无备忘」点击后不会消失，
    // 也不可编辑（用户会以为里面已经有内容）。空着走 placeholder。
    if (titleEditor) titleEditor.value = "";
    if (tagsEditor) tagsEditor.value = "";
    if (contentEditor) contentEditor.value = "";
    const draftRecovery = qs<HTMLElement>("#memoDraftRecovery");
    if (draftRecovery) {
      draftRecovery.hidden = true;
      draftRecovery.innerHTML = "";
    }
    qs<HTMLButtonElement>("#memoPinButton")?.setAttribute("disabled", "true");
    qs<HTMLButtonElement>("#memoArchiveButton")?.setAttribute("disabled", "true");
    qs<HTMLButtonElement>("#memoDeleteButton")?.setAttribute("disabled", "true");
    return;
  }
  state.selectedMemoId = memo.id;
  const deleted = Boolean(memo.deletedAt);
  qs("#memo-detail-title")!.textContent = deleted ? "已删除备忘" : "备忘编辑";
  qs("#memo-detail-meta")!.textContent = deleted ? "恢复后可继续编辑" : `${memo.archived ? "已归档" : "个人私有"} · 输入停止后自动保存`;
  const titleEditor = qs<HTMLInputElement>("#memoTitleEditor");
  const categoryEditor = qs<HTMLSelectElement>("#memoCategoryEditor");
  const tagsEditor = qs<HTMLInputElement>("#memoTagsEditor");
  const customerEditor = qs<HTMLSelectElement>("#memoCustomerEditor");
  const dealEditor = qs<HTMLSelectElement>("#memoDealEditor");
  const contentEditor = qs<HTMLTextAreaElement>("#memoContentEditor");
  const editorValue = {
    title: memo.title,
    category: memo.category,
    tags: memo.tags,
    customerId: memo.customerId,
    dealId: memo.dealId,
    content: memo.content || ""
  };
  const draft = readMemoDraft(memo);
  if (titleEditor) titleEditor.value = editorValue.title;
  if (categoryEditor) categoryEditor.value = editorValue.category;
  if (tagsEditor) tagsEditor.value = editorValue.tags;
  renderMemoRelationOptions(editorValue.customerId, editorValue.dealId);
  if (customerEditor) customerEditor.value = editorValue.customerId;
  if (dealEditor) dealEditor.value = editorValue.dealId;
  if (contentEditor) contentEditor.value = editorValue.content;
  memoDirty = false;
  setMemoSaveState(deleted ? "只读" : "已保存到服务器");
  const draftRecovery = qs<HTMLElement>("#memoDraftRecovery");
  if (draftRecovery) {
    const recoverableDraft = !deleted && draft && !resolvedMemoDrafts.has(memo.id) ? draft : null;
    draftRecovery.hidden = !recoverableDraft;
    draftRecovery.innerHTML = recoverableDraft ? `
      <div class="memo-draft-recovery-copy">
        <span class="memo-draft-recovery-icon" aria-hidden="true">!</span>
        <div><b>${recoverableDraft.serverUpdatedAt !== memo.updatedAt ? "发现本机草稿，但服务器内容已更新" : "发现尚未同步的本机草稿"}</b><small>草稿保存于 ${escapeHtml(formatDateTime(recoverableDraft.draftAt))}，当前先展示服务器版本。</small></div>
      </div>
      <div class="memo-draft-recovery-actions">
        <button class="btn" id="memoKeepServerDraftButton" type="button">保留服务器版本</button>
        <button class="btn warning" id="memoRestoreLocalDraftButton" type="button">恢复本机草稿</button>
      </div>
    ` : "";
    draftRecovery.setAttribute("role", "status");
    qs<HTMLButtonElement>("#memoRestoreLocalDraftButton", draftRecovery)?.addEventListener("click", (event) => {
      if (!recoverableDraft) return;
      if (titleEditor) titleEditor.value = recoverableDraft.title;
      if (categoryEditor) categoryEditor.value = recoverableDraft.category;
      if (tagsEditor) tagsEditor.value = recoverableDraft.tags;
      renderMemoRelationOptions(recoverableDraft.customerId, recoverableDraft.dealId);
      if (customerEditor) customerEditor.value = recoverableDraft.customerId;
      if (dealEditor) dealEditor.value = recoverableDraft.dealId;
      if (contentEditor) contentEditor.value = recoverableDraft.content;
      resolvedMemoDrafts.add(memo.id);
      memoDirty = true;
      memoEditRevision += 1;
      setMemoSaveState("仅保存在本机，点击重试", true);
      draftRecovery.hidden = true;
      draftRecovery.innerHTML = "";
      (contentEditor || titleEditor || (event.currentTarget as HTMLButtonElement)).focus();
    });
    qs<HTMLButtonElement>("#memoKeepServerDraftButton", draftRecovery)?.addEventListener("click", (event) => {
      resolvedMemoDrafts.add(memo.id);
      clearMemoDraft(memo.id);
      memoDirty = false;
      setMemoSaveState("已保存到服务器");
      draftRecovery.hidden = true;
      draftRecovery.innerHTML = "";
      (titleEditor || (event.currentTarget as HTMLButtonElement)).focus();
    });
  }
  const pinButton = qs<HTMLButtonElement>("#memoPinButton");
  const archiveButton = qs<HTMLButtonElement>("#memoArchiveButton");
  const deleteButton = qs<HTMLButtonElement>("#memoDeleteButton");
  if (pinButton) pinButton.textContent = memo.pinned ? "取消置顶" : "置顶";
  if (archiveButton) archiveButton.textContent = deleted ? "恢复备忘" : memo.archived ? "恢复使用" : "归档";
  if (deleteButton) deleteButton.textContent = deleted ? "永久删除" : "删除";
  if (pinButton) pinButton.disabled = deleted;
  if (archiveButton) archiveButton.disabled = false;
  if (deleteButton) deleteButton.disabled = false;
  [titleEditor, categoryEditor, tagsEditor, customerEditor, dealEditor, contentEditor].forEach((input) => {
    if (input) input.disabled = deleted;
  });
  if (!deleted) bindMemoEditorEvents();
}

function bindMemoEditorEvents() {
  qsa<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#memoTitleEditor, #memoCategoryEditor, #memoTagsEditor, #memoCustomerEditor, #memoDealEditor, #memoContentEditor").forEach((input) => {
    if (input.dataset.memoBound === "true") return;
    input.dataset.memoBound = "true";
    input.addEventListener("input", () => {
      memoDirty = true;
      memoEditRevision += 1;
      const memo = state.memos.find((item) => item.id === state.selectedMemoId);
      if (memo) writeMemoDraft(memo);
      setMemoSaveState("仅保存在本机");
      window.clearTimeout(memoSaveTimer);
      memoSaveTimer = window.setTimeout(() => void saveCurrentMemoDraft(), 700);
    });
    input.addEventListener("change", () => {
      if (input.id === "memoCustomerEditor") {
        const customerId = (input as HTMLSelectElement).value;
        const dealEditor = qs<HTMLSelectElement>("#memoDealEditor");
        const currentDeal = state.deals.find((item) => item.id === dealEditor?.value);
        renderMemoRelationOptions(customerId, currentDeal?.customerId === customerId ? currentDeal.id : "");
      }
      if (input.id === "memoDealEditor") {
        const deal = state.deals.find((item) => item.id === (input as HTMLSelectElement).value);
        if (deal) renderMemoRelationOptions(deal.customerId, deal.id);
      }
      input.dispatchEvent(new Event("input"));
    });
    input.addEventListener("blur", () => {
      if (memoDirty) void saveCurrentMemoDraft();
    });
  });
}

export async function saveMemo() {
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
      content: qs<HTMLTextAreaElement>("#memoContentInput")?.value.trim() || "",
      customerId: qs<HTMLSelectElement>("#memoCustomerInput")?.value || "",
      dealId: qs<HTMLSelectElement>("#memoDealInput")?.value || ""
    })
  });
  state.memos.unshift(result.memo);
  state.selectedMemoId = result.memo.id;
  state.memoStatus = "active";
  memoMobileDetailOpen = true;
  renderMemos();
  closeModal();
  toast("备忘已保存");
}

export async function saveCurrentMemoDraft() {
  window.clearTimeout(memoSaveTimer);
  if (memoSavePromise) {
    await memoSavePromise;
    if (memoDirty) return saveCurrentMemoDraft();
    return;
  }
  if (!memoDirty) return;
  const memo = state.memos.find((item) => item.id === state.selectedMemoId);
  if (!memo) return;
  const revision = memoEditRevision;
  const draft = collectMemoEditorDraft(memo);
  memoSaving = true;
  setMemoSaveState("保存中");
  memoSavePromise = (async () => {
    try {
      const result = await api<{ memo: Memo }>(`/api/memos/${memo.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: draft.title,
          category: draft.category,
          tags: draft.tags,
          customerId: draft.customerId,
          dealId: draft.dealId,
          content: draft.content
        })
      });
      Object.assign(memo, result.memo);
      if (memoEditRevision === revision) {
        memoDirty = false;
        clearMemoDraft(memo.id);
        setMemoSaveState("已保存到服务器");
        renderMemos();
      } else {
        memoDirty = true;
        writeMemoDraft(memo);
        setMemoSaveState("仅保存在本机");
        memoSaveTimer = window.setTimeout(() => void saveCurrentMemoDraft(), 700);
      }
    } catch (error) {
      memoDirty = true;
      writeMemoDraft(memo);
      setMemoSaveState("保存失败，点击重试", true);
      throw error;
    }
  })();
  try {
    await memoSavePromise;
  } catch (error) {
    toast(error instanceof Error ? error.message : "备忘保存失败", "error");
  } finally {
    memoSaving = false;
    memoSavePromise = null;
  }
}

async function deleteSelectedMemo() {
  if (memoDeleteBusy) return;
  const memo = [...state.memos, ...state.deletedMemos].find((item) => item.id === state.selectedMemoId);
  if (!memo) {
    toast("请选择要删除的备忘", "error");
    return;
  }
  if (memo.deletedAt) {
    if (!await confirmAction({
      title: "永久删除备忘",
      message: `将永久删除「${memo.title}」。`,
      consequences: ["备忘内容和标签会被彻底移除", "删除后无法从“已删除”中恢复"],
      confirmLabel: "永久删除"
    })) return;
    memoDeleteBusy = true;
    qs<HTMLButtonElement>("#memoDeleteButton")?.setAttribute("disabled", "true");
    try {
      await api<{ ok: boolean; id: string }>(`/api/memos/${memo.id}/permanent`, { method: "DELETE" });
      state.deletedMemos = state.deletedMemos.filter((item) => item.id !== memo.id);
      clearMemoDraft(memo.id);
      state.selectedMemoId = state.deletedMemos[0]?.id || null;
      memoMobileDetailOpen = Boolean(state.selectedMemoId);
      renderMemos();
      toast("备忘已永久删除");
    } finally {
      memoDeleteBusy = false;
      qs<HTMLButtonElement>("#memoDeleteButton")?.removeAttribute("disabled");
    }
    return;
  }
  if (!await confirmAction({
    title: "移入已删除",
    message: `将把「${memo.title}」移入“已删除”。`,
    consequences: ["备忘会从当前列表移除", "之后仍可在“已删除”中恢复"],
    confirmLabel: "移入已删除",
    tone: "warning"
  })) return;
  memoDeleteBusy = true;
  qs<HTMLButtonElement>("#memoDeleteButton")?.setAttribute("disabled", "true");
  try {
    await saveCurrentMemoDraft();
    const result = await api<{ ok: boolean; memo: Memo }>(`/api/memos/${memo.id}`, { method: "DELETE" });
    state.memos = state.memos.filter((item) => item.id !== memo.id);
    state.deletedMemos = [result.memo, ...state.deletedMemos.filter((item) => item.id !== result.memo.id)];
    clearMemoDraft(memo.id);
    state.memoStatus = "deleted";
    state.selectedMemoId = result.memo.id;
    memoDirty = false;
    memoMobileDetailOpen = true;
    renderMemos();
    toast("备忘已移至已删除");
  } finally {
    memoDeleteBusy = false;
    qs<HTMLButtonElement>("#memoDeleteButton")?.removeAttribute("disabled");
  }
}

/** 单据编辑里那一行调节器只对真正消费该设置的模板出现（定制B 的 PI / PO） */
export const DOCUMENT_LOGO_INLINE_KEYS = new Set([documentLogoPlacementKey("custom-b", "PI"), documentLogoPlacementKey("custom-b", "PO")]);

async function openAdvancedExcelPanel() {
  let current = activeTradeDocument();
  if (!current.id || current.id === "__new__") {
    toast("请先保存当前单据，再使用高级 Excel", "error");
    return;
  }
  const editorType = currentDocumentType();
  if (current.type !== editorType) {
    const saved = await saveTradeDocument();
    if (!saved) return;
    current = saved;
  }
  let templates: AdvancedDocumentTemplate[] = [];
  let assets: DocumentAssetsResponse = { letterheads: [], stamps: [], signatures: [], canManage: false };
  try {
    const [templateResult, settings, assetResult] = await Promise.all([
      api<{ templates: AdvancedDocumentTemplate[] }>("/api/trade-document-templates"),
      loadTeamSystemSettings(),
      api<DocumentAssetsResponse>("/api/document-assets")
    ]);
    templates = templateResult.templates || [];
    teamSystemSettings = settings;
    assets = assetResult;
  } catch (error) {
    toast(error instanceof Error ? error.message : "模板列表加载失败", "error");
    return;
  }
  const available = templates.filter((template) => template.recommendedTypes.includes(current.type));
  const selectedLetterheadId = current.letterheadId || assets.letterheads.find((item) => item.enabled && item.isDefault)?.id || "";
  const cards = templates.map((template) => {
    const supported = template.recommendedTypes.includes(current.type);
    const overCapacity = !template.dynamicItems && current.items.length > template.maxItems;
    const disabled = !supported || overCapacity;
    const reasons = !supported ? `适用于：${template.recommendedTypes.map(documentTypeLabel).join("、")}` : overCapacity ? `当前 ${current.items.length} 项，超过模板上限 ${template.maxItems} 项` : "可用于当前单据";
    const capabilities = [
      template.assetCapabilities.includes("letterhead") ? "抬头" : "",
      template.assetCapabilities.includes("productImages") ? "产品图" : "",
      template.assetCapabilities.includes("stamp") ? "盖章" : ""
      ,template.assetCapabilities.includes("signature") ? "签名" : ""
    ].filter(Boolean).join(" · ");
    return `<article class="advanced-excel-card${supported ? " is-supported" : ""}">
      <div class="advanced-excel-card-head"><span class="advanced-excel-category">${escapeHtml(advancedDocumentCategoryLabels[template.category])}</span><span class="advanced-excel-capacity">${template.dynamicItems ? "明细自动扩展" : `最多 ${template.maxItems} 项`}</span></div>
      <h3>${escapeHtml(template.name)}</h3><p>${escapeHtml(template.description)}</p>
      <div class="advanced-excel-types">${template.recommendedTypes.map((type) => `<span class="${type === current.type ? "is-current" : ""}">${escapeHtml(documentTypeLabel(type))}${type === current.type ? " · 当前" : ""}</span>`).join("")}</div>
      <div class="advanced-excel-capabilities">${escapeHtml(capabilities || "仅数据填充")}</div>
      <div class="advanced-excel-warning">${escapeHtml(template.warnings[0] || "保留原模板版式")}</div>
      <div class="advanced-excel-actions">
        <button class="btn" type="button" data-advanced-excel-preview="${escapeHtml(template.id)}" ${disabled ? "disabled" : ""}>预览</button>
        <button class="btn${disabled ? "" : " primary"}" type="button" data-advanced-excel-template="${escapeHtml(template.id)}" ${disabled ? "disabled" : ""}>${disabled ? escapeHtml(reasons) : "导出 Excel"}</button>
      </div>
    </article>`;
  }).join("");
  openModal("高级 Excel 模式", `<div class="advanced-excel-panel">
    <div class="advanced-excel-intro"><div><b>${escapeHtml(current.title)}</b><span>${escapeHtml(current.number)} · ${escapeHtml(documentTypeLabel(current.type))}</span></div><strong>${current.items.length} 项明细</strong></div>
    <section class="advanced-excel-config">
      <label><span>本次抬头</span><select id="advancedExcelLetterhead"><option value="">使用单据当前卖方资料</option>${assets.letterheads.filter((item) => item.enabled).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selectedLetterheadId ? "selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.companyName)}</option>`).join("")}</select></label>
      <label><span>盖章</span><select id="advancedExcelStamp"><option value="">不盖章</option>${assets.stamps.filter((item) => item.enabled).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === current.stampId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label>
      <label><span>签名</span><select id="advancedExcelSignature"><option value="">不签名</option>${assets.signatures.filter((item) => item.enabled).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === current.signatureId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label>
      <label class="advanced-excel-image-toggle"><input id="advancedExcelProductImages" type="checkbox" ${current.includeProductImages ? "checked" : ""}><span><b>输出产品示例图</b><small>仅嵌入已上传到本系统的产品图</small></span></label>
      ${assets.canManage ? `<button class="btn" type="button" id="advancedExcelManageAssets">管理品牌资产</button>` : ""}
    </section>
    <p class="advanced-excel-note">直接套用 Excel 模板，保留原有工作表、合并单元格、边框、打印区域和公式。印章默认不输出；预览与正式导出使用同一份已保存配置。${teamSystemSettings.requireDocumentExcelApproval ? "预览无需审批；当前团队的正式导出需审批通过。" : "当前团队未启用正式导出审批，保存后即可预览和导出。"}</p>
    <div class="advanced-excel-grid">${cards || `<div class="empty-cell">暂无可用模板</div>`}</div>
  </div>`, `<button class="btn" data-modal-close>关闭</button>`);
  qs<HTMLElement>("#appModal .modal")?.classList.add("advanced-excel-modal");
  const prepare = async () => {
    const result = await api<{ document: TradeDocument }>(`/api/trade-documents/${encodeURIComponent(current.id)}/excel-options`, {
      method: "PATCH",
      body: JSON.stringify({
        letterheadId: qs<HTMLSelectElement>("#advancedExcelLetterhead")?.value || "",
        stampId: qs<HTMLSelectElement>("#advancedExcelStamp")?.value || "",
        signatureId: qs<HTMLSelectElement>("#advancedExcelSignature")?.value || "",
        includeProductImages: Boolean(qs<HTMLInputElement>("#advancedExcelProductImages")?.checked)
      })
    });
    updateActiveDocument(result.document);
    return result.document;
  };
  qsa<HTMLButtonElement>("[data-advanced-excel-preview]").forEach((button) => button.addEventListener("click", async () => {
    try { await previewAdvancedExcel(await prepare(), button.dataset.advancedExcelPreview || "", button); }
    catch (error) { toast(error instanceof Error ? error.message : "Excel 配置保存失败", "error"); }
  }));
  qsa<HTMLButtonElement>("[data-advanced-excel-template]").forEach((button) => button.addEventListener("click", async () => {
    try { await downloadAdvancedExcel(await prepare(), button.dataset.advancedExcelTemplate || "", button); }
    catch (error) { toast(error instanceof Error ? error.message : "Excel 配置保存失败", "error"); }
  }));
  qs<HTMLButtonElement>("#advancedExcelManageAssets")?.addEventListener("click", () => openDocumentAssetManager(assets));
  if (!available.length) toast("当前单据类型暂无匹配模板，请查看支持类型", "info");
}

async function previewAdvancedExcel(tradeDocument: TradeDocument, templateId: string, button: HTMLButtonElement) {
  if (!templateId) return;
  setButtonPending(button, true, "预览", "生成中");
  try {
    const response = await fetch(`/api/trade-documents/${encodeURIComponent(tradeDocument.id)}/preview-xlsx`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(cookieValue("gj_csrf") ? { "x-csrf-token": cookieValue("gj_csrf") } : {}) },
      body: JSON.stringify({ templateId })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: "Excel 预览失败" }));
      throw new Error(body.message || "Excel 预览失败");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    openModal("Excel 单据预览", `<div class="excel-preview-shell"><div class="excel-preview-meta"><div><b>${escapeHtml(tradeDocument.title)}</b><span>${escapeHtml(tradeDocument.number)} · ${escapeHtml(documentTypeLabel(tradeDocument.type))}</span></div><span>预览由最终 Excel 生成，修改后将重新生成</span></div><iframe class="excel-preview-frame" src="${escapeHtml(url)}" title="${escapeHtml(tradeDocument.number)} Excel 预览"></iframe></div>`, `<button class="btn" type="button" id="excelPreviewEditDocument">修改单据数据</button><button class="btn" type="button" id="excelPreviewRefresh">重新生成预览</button><button class="btn primary" type="button" id="excelPreviewDownload">导出 Excel</button><button class="btn" data-modal-close>关闭预览</button>`);
    qs<HTMLElement>("#appModal .modal")?.classList.add("excel-preview-modal");
    modalDismissHandler = () => URL.revokeObjectURL(url);
    qs<HTMLButtonElement>("#excelPreviewEditDocument")?.addEventListener("click", () => {
      advancedExcelEditReturnTemplateId = templateId;
      closeModal();
      state.selectedDocumentId = tradeDocument.id;
      renderTradeDocuments(state.tradeDocuments);
      qs<HTMLElement>("#documentStudioWorkspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => qs<HTMLInputElement>("#docTitleInput")?.focus(), 200);
      toast("修改后点击“保存配置”，系统会自动重新生成 Excel 预览", "info");
    });
    qs<HTMLButtonElement>("#excelPreviewRefresh")?.addEventListener("click", (event) => {
      void previewAdvancedExcel(activeTradeDocument(), templateId, event.currentTarget as HTMLButtonElement);
    });
    qs<HTMLButtonElement>("#excelPreviewDownload")?.addEventListener("click", (event) => {
      void downloadAdvancedExcel(activeTradeDocument(), templateId, event.currentTarget as HTMLButtonElement);
    });
  } catch (error) {
    setButtonPending(button, false, "预览", "生成中");
    toast(error instanceof Error ? error.message : "Excel 预览失败", "error");
  }
}

export async function saveTradeDocument() {
  const draft = collectDocumentDraft();
  if (!draft.seller) {
    toast("请填写卖方公司", "error");
    qs<HTMLInputElement>("#docSellerInput")?.focus();
    return null;
  }
  if (!draft.items.length) {
    toast("请至少保留一条商品明细", "error");
    return null;
  }
  if (draft.items.some((item) => !item.product.trim())) {
    toast("请填写每条商品明细的品名", "error");
    return null;
  }
  const existing = state.tradeDocuments.find((document) => document.id === state.selectedDocumentId);
  let result: {
    document: TradeDocument;
    dealSync?: { deal: Deal; history: QuoteHistoryRecord; changes: string[]; changed: boolean } | null;
  };
  try {
    result = await api<typeof result>(existing ? `/api/trade-documents/${existing.id}` : "/api/trade-documents", {
      method: existing ? "PATCH" : "POST",
      body: JSON.stringify({ ...draft, status: "ready" })
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : "单据保存失败", "error");
    return null;
  }
  state.tradeDocuments = existing
    ? state.tradeDocuments.map((document) => document.id === result.document.id ? result.document : document)
    : [result.document, ...state.tradeDocuments];
  state.selectedDocumentId = result.document.id;
  renderTradeDocuments(state.tradeDocuments);
  if (result.dealSync?.deal) {
    state.deals = state.deals.map((deal) => deal.id === result.dealSync!.deal.id ? result.dealSync!.deal : deal);
    if (!state.deals.some((deal) => deal.id === result.dealSync!.deal.id)) state.deals.unshift(result.dealSync.deal);
    await refreshDealsData(false);
    toast(result.dealSync.changed
      ? `单据已保存，商机已同步 ${result.dealSync.deal.items?.length || 0} 项产品及 ${formatDocumentMoney(result.dealSync.deal.amount, result.dealSync.deal.currency)}`
      : "单据已保存，报价内容未变化，无需重复记录");
  } else {
    toast("单据配置已保存到数据库");
  }
  if (advancedExcelEditReturnTemplateId) {
    const templateId = advancedExcelEditReturnTemplateId;
    advancedExcelEditReturnTemplateId = "";
    window.setTimeout(() => {
      const previewButton = document.createElement("button");
      previewButton.textContent = "预览";
      void previewAdvancedExcel(result.document, templateId, previewButton);
    }, 0);
  }
  return result.document;
}

export let mysqlImportSelection: MysqlImportSelection | null = null;
export let mysqlImportRunning = false;
export let databaseMaintenanceMode: "migration" | "backup" = "migration";
export let databaseCurrentJob: DatabaseMaintenanceJob | null = null;
export let databaseLocalEvents: DatabaseMaintenanceEvent[] = [];
let databaseMaintenancePollTimer = 0;
let databaseCancelRequested = false;
export let databaseLogFollow = true;

export function appendDatabaseLocalEvent(stage: string, message: string, level: DatabaseMaintenanceEvent["level"] = "info", table = "") {
  databaseLocalEvents.push({ id: `dbel_${crypto.randomUUID()}`, at: new Date().toISOString(), level, stage, table, message });
  databaseLocalEvents = databaseLocalEvents.slice(-500);
  renderDatabaseStream();
}

export function renderDatabaseHistory() {
  const tbody = qs<HTMLElement>("#databaseMaintenanceHistory");
  if (!tbody) return;
  tbody.innerHTML = databaseMaintenanceJobs.length ? databaseMaintenanceJobs.map((job) => {
    const rows = job.type === "migration" ? `${Number(job.importedRows || 0).toLocaleString()} 写入` : `${job.processedTables}/${job.totalTables} 张表`;
    const file = job.fileName ? `${escapeHtml(job.fileName)}${job.fileSize ? `<small>${formatFileSize(job.fileSize)}</small>` : ""}` : "--";
    const download = job.type === "backup" && job.status === "completed" ? `<button class="btn" data-database-download="${escapeHtml(job.id)}">下载</button>` : "";
    const remove = job.type === "backup" && !["queued", "running"].includes(job.status) ? `<button class="btn danger" data-database-delete="${escapeHtml(job.id)}" title="删除备份">删除</button>` : "";
    return `<tr data-database-job="${escapeHtml(job.id)}"><td><b>${escapeHtml(job.fileName || job.id)}</b><small>${escapeHtml(job.id)}</small></td><td>${databaseJobTypeLabel(job.type)}</td><td>${databaseJobStatusLabel(job.status)}</td><td>${rows}</td><td>${file}</td><td>${new Date(job.createdAt).toLocaleString("zh-CN", { hour12: false })}</td><td><div class="database-history-actions"><button class="btn" data-database-open="${escapeHtml(job.id)}">查看</button>${download}${remove}</div></td></tr>`;
  }).join("") : `<tr><td colspan="7" class="empty-cell">暂无维护记录</td></tr>`;
  qsa<HTMLButtonElement>("[data-database-open]", tbody).forEach((button) => button.addEventListener("click", () => {
    databaseCurrentJob = databaseMaintenanceJobs.find((job) => job.id === button.dataset.databaseOpen) || null;
    databaseLocalEvents = [];
    renderMysqlImport();
    if (databaseCurrentJob && ["queued", "running"].includes(databaseCurrentJob.status)) pollDatabaseJob(databaseCurrentJob);
  }));
  qsa<HTMLButtonElement>("[data-database-download]", tbody).forEach((button) => button.addEventListener("click", () => void downloadDatabaseBackup(button.dataset.databaseDownload || "")));
  qsa<HTMLButtonElement>("[data-database-delete]", tbody).forEach((button) => button.addEventListener("click", () => void removeDatabaseBackup(button.dataset.databaseDelete || "")));
}

async function prepareMysqlImportFile(file: File) {
  const badgeNode = qs<HTMLElement>("#mysqlImportState");
  const start = qs<HTMLButtonElement>("#mysqlImportStart");
  mysqlImportSelection = null;
  databaseCurrentJob = null;
  databaseLocalEvents = [];
  if (start) start.disabled = true;
  void badgeNode;
  appendDatabaseLocalEvent("file", `正在读取 ${file.name}`);
  setMysqlImportProgress(0, 1, "正在本地解析");
  try {
    const [sql, sha256] = await Promise.all([readMysqlDumpFile(file), sha256File(file)]);
    const plan = parseMysqlDump(sql);
    mysqlImportSelection = { file, plan, sha256 };
    appendDatabaseLocalEvent("parse", `解析完成：${Object.keys(plan.tableRows).length} 张表、${plan.rowCount} 条记录`, "success");
    if (plan.ignoredStatements) appendDatabaseLocalEvent("parse", `已忽略 ${plan.ignoredStatements} 条结构或控制语句`, "warning");
    setMysqlImportProgress(0, plan.rowCount, "等待迁移");
    renderMysqlImport();
  } catch (error) {
    appendDatabaseLocalEvent("parse", error instanceof Error ? error.message : "MySQL 文件解析失败", "error");
    setMysqlImportProgress(0, 1, "文件无法解析");
    renderMysqlImport();
    toast(error instanceof Error ? error.message : "MySQL 文件解析失败", "error");
  }
}

async function startMysqlImport() {
  if (!mysqlImportSelection || mysqlImportRunning) return;
  const token = mysqlImportHeaders()["x-database-import-token"];
  if (!token) {
    toast("请输入迁移授权码", "error");
    qs<HTMLInputElement>("#mysqlImportToken")?.focus();
    return;
  }
  const selection = mysqlImportSelection;
  let jobId = "";
  mysqlImportRunning = true;
  databaseCancelRequested = false;
  databaseLocalEvents = [];
  appendDatabaseLocalEvent("schema", "正在读取目标数据库结构");
  renderMysqlImport();
  try {
    const headers = mysqlImportHeaders();
    const schema = await api<{ tables: Record<string, { columns: string[]; primaryKeys: string[] }> }>("/api/system/database-import/schema", { headers });
    const created = await api<{ job: DatabaseMaintenanceJob }>("/api/system/database-import/jobs", {
      method: "POST",
      headers,
      body: JSON.stringify({
        fileName: selection.file.name,
        fileSize: selection.file.size,
        fileSha256: selection.sha256,
        conflictMode: qs<HTMLSelectElement>("#mysqlImportConflict")?.value === "overwrite" ? "overwrite" : "skip",
        tableRows: selection.plan.tableRows,
        ignoredStatements: selection.plan.ignoredStatements
      })
    });
    jobId = created.job.id;
    databaseCurrentJob = { ...created.job, type: "migration" } as DatabaseMaintenanceJob;
    appendDatabaseLocalEvent("schema", "目标结构核对完成", "success");
    const batches = selection.plan.batches
      .map((batch) => fitBatchToSchema(batch, schema.tables))
      .filter((batch): batch is MysqlDumpBatch => Boolean(batch))
      .flatMap(splitLargeMysqlImportBatch);
    const remaining = new Map<string, number>();
    batches.forEach((batch) => remaining.set(batch.table, (remaining.get(batch.table) || 0) + 1));
    for (const batch of batches) {
      if (databaseCancelRequested) throw new Error("迁移已取消");
      const left = (remaining.get(batch.table) || 1) - 1;
      remaining.set(batch.table, left);
      const response = await api<{ result: { imported: number; skipped: number; failed: number }; job: DatabaseMaintenanceJob }>(`/api/system/database-import/jobs/${encodeURIComponent(jobId)}/batches`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...batch, tableComplete: left === 0 })
      });
      databaseCurrentJob = { ...response.job, type: "migration" };
      renderMysqlImport();
    }
    const completed = await api<{ job: DatabaseMaintenanceJob; restartScheduled: boolean }>(`/api/system/database-import/jobs/${encodeURIComponent(jobId)}/complete`, {
      method: "POST",
      headers,
      body: "{}"
    });
    databaseCurrentJob = { ...completed.job, type: "migration" };
    appendDatabaseLocalEvent("completed", `迁移完成：写入 ${completed.job.importedRows || 0}，跳过 ${completed.job.skippedRows || 0}`, "success");
    toast(`已写入 ${completed.job.importedRows || 0} 条，跳过 ${completed.job.skippedRows || 0} 条`);
    await refreshDatabaseMaintenance();
    if (completed.restartScheduled) void waitForMysqlImportRestart();
    else toast("请重启本地后端以载入迁移数据");
  } catch (error) {
    if (jobId && !databaseCancelRequested) {
      await api(`/api/system/database-import/jobs/${encodeURIComponent(jobId)}/fail`, {
        method: "POST",
        headers: mysqlImportHeaders(),
        body: JSON.stringify({ message: error instanceof Error ? error.message : "数据库迁移失败" })
      }).catch(() => null);
    }
    appendDatabaseLocalEvent(databaseCancelRequested ? "cancelled" : "failed", error instanceof Error ? error.message : "数据库迁移失败", databaseCancelRequested ? "warning" : "error");
    if (!databaseCancelRequested) toast(error instanceof Error ? error.message : "数据库迁移失败", "error");
    await refreshDatabaseMaintenance();
  } finally {
    mysqlImportRunning = false;
    renderMysqlImport();
  }
}

function pollDatabaseJob(job: DatabaseMaintenanceJob) {
  window.clearInterval(databaseMaintenancePollTimer);
  databaseMaintenancePollTimer = window.setInterval(async () => {
    try {
      const response = await api<{ job: DatabaseMaintenanceJob }>(databaseJobEndpoint(job), { headers: mysqlImportHeaders() });
      databaseCurrentJob = { ...response.job, type: job.type };
      renderMysqlImport();
      if (!["queued", "running"].includes(response.job.status)) {
        window.clearInterval(databaseMaintenancePollTimer);
        await refreshDatabaseMaintenance();
      }
    } catch {
      appendDatabaseLocalEvent("connection", "连接中断，正在重连", "warning");
    }
  }, 700);
}

async function startDatabaseBackup() {
  const token = mysqlImportHeaders()["x-database-import-token"];
  if (!token) {
    toast("请输入数据库维护授权码", "error");
    qs<HTMLInputElement>("#mysqlImportToken")?.focus();
    return;
  }
  if (!databaseMaintenanceStatus?.backup.enabled) {
    toast("服务器已禁止本地备份", "error");
    return;
  }
  databaseLocalEvents = [];
  databaseCancelRequested = false;
  appendDatabaseLocalEvent("queued", "正在创建数据库备份任务");
  try {
    const response = await api<{ job: DatabaseMaintenanceJob }>("/api/system/database-backups/jobs", { method: "POST", headers: mysqlImportHeaders(), body: "{}" });
    databaseCurrentJob = { ...response.job, type: "backup" };
    renderMysqlImport();
    pollDatabaseJob(databaseCurrentJob);
  } catch (error) {
    appendDatabaseLocalEvent("failed", error instanceof Error ? error.message : "数据库备份启动失败", "error");
    toast(error instanceof Error ? error.message : "数据库备份启动失败", "error");
  }
}

async function cancelDatabaseMaintenanceTask() {
  const job = databaseCurrentJob;
  if (!job || !["queued", "running"].includes(job.status)) return;
  databaseCancelRequested = true;
  const path = job.type === "backup"
    ? `/api/system/database-backups/jobs/${encodeURIComponent(job.id)}/cancel`
    : `/api/system/database-import/jobs/${encodeURIComponent(job.id)}/cancel`;
  try {
    const response = await api<{ job: DatabaseMaintenanceJob }>(path, { method: "POST", headers: mysqlImportHeaders(), body: "{}" });
    databaseCurrentJob = { ...response.job, type: job.type };
    window.clearInterval(databaseMaintenancePollTimer);
    appendDatabaseLocalEvent("cancelled", "任务已停止", "warning");
    await refreshDatabaseMaintenance();
  } catch (error) {
    toast(error instanceof Error ? error.message : "停止任务失败", "error");
  }
}

async function removeDatabaseBackup(id: string) {
  if (!await confirmAction({
    title: "删除服务器本地备份",
    message: "该备份文件将从服务器永久删除。",
    consequences: ["无法再使用此备份恢复数据库", "删除后无法撤销"],
    confirmLabel: "永久删除备份"
  })) return;
  try {
    await api(`/api/system/database-backups/jobs/${encodeURIComponent(id)}`, { method: "DELETE", headers: mysqlImportHeaders() });
    if (databaseCurrentJob?.id === id) databaseCurrentJob = null;
    await refreshDatabaseMaintenance();
    toast("备份已删除");
  } catch (error) {
    toast(error instanceof Error ? error.message : "备份删除失败", "error");
  }
}
export let productViewMode: "grid" | "list" = "grid";

export let editingShipmentId: string | null = null;
let pendingTrackingImage: string = "";
export let pendingTrackingImageUrl: string = "";
export let logLevelFilterValue = "";
export let logCategoryFilterValue = "";
export let logSearchValue = "";

let dealSearchTimer: number | undefined;

export function openShipmentModal(shipment?: Shipment) {
  editingShipmentId = shipment?.id || null;
  const modal = qs<HTMLElement>("#shipmentModal");
  const title = qs<HTMLElement>("#shipmentModalTitle");
  if (title) title.textContent = shipment ? "编辑发货单" : "新增发货单";
  const set = (sel: string, val: string) => { const el = qs<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(sel); if (el) el.value = val || ""; };
  set("#shipmentNo", shipment?.shipmentNo || "");
  set("#shipmentStatus", shipment?.status || "draft");
  set("#shipmentCourier", shipment?.courier || "");
  set("#shipmentShippedAt", shipment?.shippedAt ? shipment.shippedAt.slice(0, 10) : "");
  set("#shipmentEta", shipment?.estimatedArrival ? shipment.estimatedArrival.slice(0, 10) : "");
  set("#shipmentTrackingCode", shipment?.trackingCode || "");
  set("#shipmentNote", shipment?.note || "");
  const dealIdEl = qs<HTMLInputElement>("#shipmentDealId");
  const dealSearchEl = qs<HTMLInputElement>("#shipmentDealSearch");
  const customerEl = qs<HTMLInputElement>("#shipmentCustomerName");
  const hint = qs<HTMLElement>("#shipmentDealHint");
  if (dealIdEl) dealIdEl.value = shipment?.dealId || "";
  if (dealSearchEl) dealSearchEl.value = shipment?.dealTitle || "";
  if (customerEl) customerEl.value = shipment?.customerName || "";
  if (hint) { hint.textContent = shipment?.dealTitle ? `已关联：${shipment.dealTitle}` : "未选择"; hint.style.color = "var(--muted)"; }
  const destinationDefaults = shipmentDestinationDefaults(shipment?.dealId || "", shipment?.customerName || "");
  set("#shipmentDestinationCountry", shipment?.destinationCountry || destinationDefaults.country);
  set("#shipmentDestinationPort", shipment?.destinationPort || destinationDefaults.port);
  set("#shipmentDestinationAddress", shipment?.destinationAddress || destinationDefaults.address);

  pendingTrackingImage = "";
  pendingTrackingImageUrl = shipment?.trackingImageUrl || "";
  const preview = qs<HTMLElement>("#shipmentOcrPreview");
  const img = qs<HTMLImageElement>("#shipmentOcrImg");
  const ocrHint = qs<HTMLElement>("#shipmentOcrHint");
  if (preview) preview.hidden = !pendingTrackingImageUrl;
  if (img && pendingTrackingImageUrl) img.src = pendingTrackingImageUrl.startsWith("http") ? pendingTrackingImageUrl : `${location.origin}${pendingTrackingImageUrl}`;
  if (ocrHint) ocrHint.textContent = "";

  const tbody = qs<HTMLElement>("#shipmentItemBody");
  if (tbody) tbody.innerHTML = "";
  (shipment?.items && shipment.items.length ? shipment.items : []).forEach((it) => addShipmentItemRow(it));

  const del = qs<HTMLButtonElement>("#shipmentDeleteButton");
  if (del) del.hidden = !shipment;
  if (modal) modal.classList.add("active");
  qs<HTMLInputElement>("#shipmentNo")?.focus();
}

export function closeShipmentModal() {
  const modal = qs<HTMLElement>("#shipmentModal");
  if (modal) modal.classList.remove("active");
  editingShipmentId = null;
  pendingTrackingImage = "";
  pendingTrackingImageUrl = "";
}

async function runShipmentOcr() {
  const fileInput = qs<HTMLInputElement>("#shipmentTrackingImage");
  const file = fileInput?.files?.[0];
  const hint = qs<HTMLElement>("#shipmentOcrHint");
  const btn = qs<HTMLButtonElement>("#shipmentOcrButton");
  if (!file) { if (hint) hint.textContent = "请先选择运单号图片"; return; }
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
  if (!dataUrl) { if (hint) hint.textContent = "图片读取失败"; return; }
  pendingTrackingImage = dataUrl;
  const preview = qs<HTMLElement>("#shipmentOcrPreview");
  const img = qs<HTMLImageElement>("#shipmentOcrImg");
  if (preview) preview.hidden = false;
  if (img) img.src = dataUrl;
  if (btn) { btn.disabled = true; btn.textContent = "识别中…"; }
  if (hint) hint.textContent = "AI 正在识别运单号…";
  try {
    const result = await api<{ ok: boolean; trackingCode: string; imageUrl: string; message?: string }>("/api/tools/shipments/ocr", {
      method: "POST",
      body: JSON.stringify({ image: dataUrl, mime: file.type || "image/png" })
    });
    if (result.ok && result.trackingCode) {
      const codeEl = qs<HTMLInputElement>("#shipmentTrackingCode");
      if (codeEl) codeEl.value = result.trackingCode;
      pendingTrackingImageUrl = result.imageUrl || pendingTrackingImageUrl;
      if (hint) hint.textContent = "AI 识别成功，已填入运单号";
    } else {
      if (hint) hint.textContent = (result.message || "未能识别") + "，请手动填写运单号";
    }
  } catch (err) {
    if (hint) hint.textContent = (err instanceof Error ? err.message : "识别失败") + "，请手动填写运单号";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "AI 识别"; }
  }
}

function closeProspectMobileDetail() {
  prospectMobileDetailOpen = false;
  document.body.classList.remove("prospect-mobile-detail-open");
  window.requestAnimationFrame(() => window.scrollTo({ top: prospectMobileListScrollY }));
}

export function renderProspectList() {
  const rows = qs<HTMLElement>("#prospectListRows");
  const total = qs<HTMLElement>("#prospectTotalCount");
  const preview = qs<HTMLElement>("#prospectPreviewCount");
  const contactable = qs<HTMLElement>("#prospectContactableCount");
  const contacted = qs<HTMLElement>("#prospectContactedCount");
  const synced = qs<HTMLElement>("#prospectSyncedCount");
  const excluded = qs<HTMLElement>("#prospectExcludedCount");
  const all = state.websiteOpportunities.filter((item) => Boolean(item.shortlistedAt));
  const filtered = prospectFilteredRows();
  const pageCount = Math.max(1, Math.ceil(filtered.length / PROSPECT_PAGE_SIZE));
  state.prospectPage = Math.min(Math.max(1, state.prospectPage), pageCount);
  const pageRows = filtered.slice((state.prospectPage - 1) * PROSPECT_PAGE_SIZE, state.prospectPage * PROSPECT_PAGE_SIZE);
  state.selectedProspectIds = state.selectedProspectIds.filter((id) => all.some((item) => item.id === id));
  if (!state.selectedProspectId || !all.some((item) => item.id === state.selectedProspectId)) state.selectedProspectId = pageRows[0]?.id || filtered[0]?.id || null;
  if (total) total.textContent = filtered.length === all.length ? `${all.length} 条候选` : `${filtered.length} 条显示 · ${all.length} 条总计`;
  if (preview) preview.textContent = String(all.filter((item) => item.status === "preview").length);
  if (contactable) contactable.textContent = String(all.filter((item) => item.status === "contactable").length);
  if (contacted) contacted.textContent = String(all.filter((item) => item.status === "contacted").length);
  if (synced) synced.textContent = String(all.filter((item) => item.status === "synced").length);
  if (excluded) excluded.textContent = String(all.filter((item) => item.status === "excluded").length);
  const selectedCount = qs<HTMLElement>("#prospectSelectedCount");
  if (selectedCount) selectedCount.textContent = `已选 ${state.selectedProspectIds.length} 条`;
  const pageSelect = qs<HTMLInputElement>("#prospectSelectPage");
  if (pageSelect) {
    pageSelect.checked = Boolean(pageRows.length) && pageRows.every((item) => state.selectedProspectIds.includes(item.id));
    pageSelect.indeterminate = pageRows.some((item) => state.selectedProspectIds.includes(item.id)) && !pageSelect.checked;
  }
  const pageSummary = qs<HTMLElement>("#prospectPageSummary");
  const pageNumber = qs<HTMLElement>("#prospectPageNumber");
  if (pageSummary) pageSummary.textContent = filtered.length ? `第 ${(state.prospectPage - 1) * PROSPECT_PAGE_SIZE + 1}-${Math.min(state.prospectPage * PROSPECT_PAGE_SIZE, filtered.length)} 条，共 ${filtered.length} 条` : "0 条结果";
  if (pageNumber) pageNumber.textContent = `${state.prospectPage} / ${pageCount}`;
  const prev = qs<HTMLButtonElement>("#prospectPrevPage");
  const next = qs<HTMLButtonElement>("#prospectNextPage");
  if (prev) prev.disabled = state.prospectPage <= 1;
  if (next) next.disabled = state.prospectPage >= pageCount;
  const assigneeSelect = qs<HTMLSelectElement>("#prospectAssigneeSelect");
  const assignButton = qs<HTMLButtonElement>("#prospectAssignButton");
  const canAssign = state.prospectAssignees.length > 0;
  if (assigneeSelect) {
    assigneeSelect.hidden = !canAssign;
    assigneeSelect.innerHTML = `<option value="">选择业务员</option>${state.prospectAssignees.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}`;
  }
  if (assignButton) assignButton.hidden = !canAssign;
  qsa<HTMLButtonElement>("[data-prospect-filter]").forEach((button) => button.classList.toggle("active", button.dataset.prospectFilter === state.prospectFilter));
  const buyerOnlyToggle = qs<HTMLButtonElement>("#prospectBuyerOnlyToggle");
  if (buyerOnlyToggle) {
    buyerOnlyToggle.classList.toggle("active", state.prospectBuyerOnly);
    buyerOnlyToggle.setAttribute("aria-pressed", String(state.prospectBuyerOnly));
  }
  qsa<HTMLButtonElement>("[data-prospect-date-filter]").forEach((button) => {
    const active = button.dataset.prospectDateFilter === state.prospectJoinedRange;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const customDates = qs<HTMLElement>("#prospectCustomDates");
  if (customDates) customDates.hidden = state.prospectJoinedRange !== "custom";
  const joinedFrom = qs<HTMLInputElement>("#prospectJoinedFrom");
  const joinedTo = qs<HTMLInputElement>("#prospectJoinedTo");
  if (joinedFrom) joinedFrom.value = state.prospectJoinedFrom;
  if (joinedTo) joinedTo.value = state.prospectJoinedTo;
  const sortSelect = qs<HTMLSelectElement>("#prospectSortSelect");
  if (sortSelect) sortSelect.value = state.prospectSort;
  if (rows) {
    rows.innerHTML = pageRows.length ? pageRows.map((item) => {
      const score = leadFinderScore(item);
      const status = prospectStatusMeta(item);
      const contactDisplay = websiteContactDisplay(item);
      const contactAttempt = latestContactEnrichment(item);
      const contactRunning = contactAttempt?.status === "queued" || contactAttempt?.status === "running";
      return `
        <article class="prospect-item ${item.id === state.selectedProspectId ? "active" : ""}" data-prospect-id="${escapeHtml(item.id)}">
          <input type="checkbox" data-prospect-select="${escapeHtml(item.id)}" ${state.selectedProspectIds.includes(item.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(item.company)}">
          <div class="prospect-item-main" data-prospect-open="${escapeHtml(item.id)}" role="button" tabindex="0">
            <div class="prospect-item-top"><h3>${escapeHtml(item.company)}</h3><span class="prospect-score">${score}</span></div>
            <p>${escapeHtml(item.business || "业务待维护")}</p>
            <small>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(websiteDomain(item.website || ""))}</small>
            <div class="prospect-meta-row">${badge(status.label, status.tone)}${prospectBuyerRoleBadge(item)}${prospectEmailEligibilityBadge(item)}${item.lastDevelopmentEmailAt ? badge("已发开发信", "green") : ""}${prospectResearchRunning(item) ? researchRunningBadgeHtml() : ""}</div>
            <div class="prospect-contact-quick-row">
              ${contactDisplay.tone === "ready"
                ? `<span class="prospect-contact-ready">已找到 · ${escapeHtml(contactDisplay.value)}</span>`
                : `<button class="prospect-contact-quick" type="button" data-prospect-contact="${escapeHtml(item.id)}" ${contactRunning ? "disabled" : ""}>${contactRunning ? "查询中" : "查联系方式"}</button>`}
            </div>
            <span class="prospect-next-action">下一步：${escapeHtml(status.action)}</span>
            <div class="prospect-joined-at"><span>加入搜客清单</span><time datetime="${escapeHtml(item.shortlistedAt || item.createdAt)}" title="${escapeHtml(formatProspectJoinedAt(item.shortlistedAt || item.createdAt))}">${escapeHtml(formatProspectJoinedAt(item.shortlistedAt || item.createdAt))}</time></div>
          </div>
        </article>
      `;
    }).join("") : `<div class="empty-cell">${state.prospectBuyerOnly
      ? "没有带「决策人/采购人邮箱」的候选。CLI 获客已按这个口径入库，历史候选需补到具名邮箱后才会出现在这里。"
      : "搜客清单暂无匹配记录。请从当前搜索结果中勾选候选加入。"}</div>`;
    qsa<HTMLInputElement>("[data-prospect-select]", rows).forEach((input) => {
      input.addEventListener("change", () => {
        const id = input.dataset.prospectSelect || "";
        state.selectedProspectIds = input.checked ? [...new Set([...state.selectedProspectIds, id])] : state.selectedProspectIds.filter((item) => item !== id);
        renderProspectList();
      });
    });
    qsa<HTMLElement>("[data-prospect-open]", rows).forEach((button) => {
      const select = () => {
        state.selectedProspectId = button.dataset.prospectOpen || null;
        prospectMobileDetailOpen = true;
        document.body.classList.add("prospect-mobile-detail-open");
        if (window.matchMedia("(max-width: 760px)").matches) {
          prospectMobileListScrollY = window.scrollY;
          qs<HTMLElement>("#prospect-list .prospect-detail-panel")?.scrollTo({ top: 0 });
        }
        qs<HTMLInputElement>("#prospectMailTo")!.value = "";
        qs<HTMLInputElement>("#prospectMailSubject")!.value = "";
        qs<HTMLTextAreaElement>("#prospectMailBody")!.value = "";
        renderProspectList();
      };
      button.addEventListener("click", select);
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") select();
      });
    });
    qsa<HTMLButtonElement>("[data-prospect-contact]", rows).forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const item = state.websiteOpportunities.find((row) => row.id === button.dataset.prospectContact);
        if (item) {
          state.selectedProspectId = item.id;
          void startContactEnrichment(item, button);
        }
      });
    });
  }
  renderProspectDetail(selectedProspect());
}

// 把自然语言目标交给后端 AI 模型，解析为标准英文搜索结构并渲染到可编辑预览面板
async function runLeadAiParse(): Promise<boolean> {
  const goal = qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.value.trim();
  if (!goal) {
    toast("请先输入自然语言目标", "error");
    return false;
  }
  // 去重：失焦自动解析与「开始搜客」自动解析可能同时触发，复用同一个进行中的请求
  if (leadAiParseInFlight) return leadAiParseInFlight;
  const btn = qs<HTMLButtonElement>("#leadAiParseButton");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "AI 解析中…";
  }
  leadAiParseInFlight = (async () => {
    try {
      const result = await api<LeadAiParsed>("/api/lead-finder/parse-goal", {
        method: "POST",
        body: JSON.stringify({ goal })
      });
      leadAiParsed = result;
      leadAiParseLastError = "";
      fillLeadAiPreview(result);
      toast("AI 已解析为标准搜索词", "success");
      return true;
    } catch (err) {
      clearLeadAiPreview(true);
      const detail = err instanceof Error ? err.message : "模型未返回可用结果";
      leadAiParseLastError = detail;
      toast(`${detail.startsWith("AI 解析失败") ? detail : `AI 解析失败：${detail}`}，未生成解析结果`, "error");
      return false;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "AI 解析为标准搜索词";
      }
    }
  })();
  try {
    return await leadAiParseInFlight;
  } finally {
    leadAiParseInFlight = null;
  }
}

function clearLeadAiPreview(silent = false) {
  leadAiParsed = null;
  const preview = qs<HTMLElement>("#leadAiPreview");
  if (preview) {
    preview.hidden = true;
    preview.querySelectorAll<HTMLInputElement>("input").forEach((el) => { el.value = ""; });
    const ct = qs<HTMLSelectElement>("#leadAiCustomerType");
    if (ct) ct.value = "*";
  }
  if (!silent) toast("已清除 AI 解析结果", "info");
}

export function renderLeadFinderResultView() {
  const candidateView = qs<HTMLElement>("#leadFinderCandidateView");
  const cleaningView = qs<HTMLElement>("#leadFinderCleaningView");
  const bulkbar = qs<HTMLElement>("#leadFinderBulkbar");
  const scope = qs<HTMLElement>("#leadFinderResultScope");
  const reconciliation = qs<HTMLElement>("#leadFinderResultReconciliation");
  if (!candidateView || !cleaningView) return;
  const cleaning = leadFinderResultView === "cleaning";
  candidateView.hidden = cleaning;
  cleaningView.hidden = !cleaning;
  if (bulkbar) bulkbar.hidden = cleaning;
  const currentJob = currentLeadFinderResultJob();
  const report = currentJob?.cleaningReport;
  const removedTotal = leadFinderRemovedTotal(report);
  if (reconciliation) {
    const data = report?.summary;
    reconciliation.hidden = !data || removedTotal < 1;
    reconciliation.innerHTML = data && removedTotal > 0 ? `
      <div><b>来源返回 ${data.providerRawCount} 条，${data.candidateCount} 条进入候选池，${removedTotal} 条已分流</b><span>${escapeHtml(leadFinderRemovalSummary(report))}</span></div>
      <button type="button" data-lead-open-cleaning>查看处理原因</button>
    ` : "";
    qs<HTMLButtonElement>("[data-lead-open-cleaning]", reconciliation)?.addEventListener("click", () => {
      leadFinderResultView = "cleaning";
      leadFinderCleaningFilter = "all";
      renderLeadFinderResultView();
    });
  }
  if (scope) scope.textContent = cleaning
    ? "逐条追溯当前任务的管线处置"
    : currentJob
      ? `当前搜索 · ${currentJob.title}`
      : "启动搜索后，这里只显示本次结果";
  qsa<HTMLButtonElement>("[data-lead-result-view]").forEach((button) => {
    const active = button.dataset.leadResultView === leadFinderResultView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderLeadFinderCleaningLedger();
}

export function createLeadFinderJob(status: LeadFinderJob["status"] = "running") {
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
  renderLeadFinder(state.websiteOpportunities);
  return job;
}

export async function loadProspectRuns(quiet = false) {
  if (!state.user || leadFinderRunsLoading) return;
  leadFinderRunsLoading = true;
  try {
    const [list, superList] = await Promise.all([
      api<{ runs: ProspectRunApiRecord[] }>("/api/prospect-runs?limit=20"),
      api<{ missions: ProspectSuperSearchMissionApi[] }>("/api/prospect-super-search?limit=6")
    ]);
    const superRunIds = new Set(superList.missions.flatMap((mission) => mission.rounds.map((round) => round.runId)));
    const detailResults = await Promise.allSettled(
      list.runs.filter((run) => !superRunIds.has(run.id)).slice(0, 6).map((run) => api<ProspectRunDetailApiResponse>(`/api/prospect-runs/${encodeURIComponent(run.id)}`))
    );
    const backendJobs = detailResults
      .filter((result): result is PromiseFulfilledResult<ProspectRunDetailApiResponse> => result.status === "fulfilled")
      .map((result) => prospectRunJob(result.value));
    const superDetails = await Promise.allSettled(
      superList.missions.map((mission) => mission.currentRunId
        ? api<ProspectRunDetailApiResponse>(`/api/prospect-runs/${encodeURIComponent(mission.currentRunId)}`)
        : Promise.reject(new Error("超级搜索尚未创建当前轮次")))
    );
    const superJobs = superDetails
      .map((result, index) => result.status === "fulfilled"
        ? applySuperSearchMission(prospectRunJob(result.value), superList.missions[index])
        : null)
      .filter((job): job is LeadFinderJob => Boolean(job));
    const localJobs = leadFinderJobs.filter((job) => !job.backendRunId);
    // CLI 获客历史：从引擎作业留档重建（终态沉淀 + 在途恢复跟踪），去重后并入队列
    const cliHistoryJobs = await loadCliAcquireHistory();
    leadFinderJobs = [...superJobs, ...backendJobs, ...cliHistoryJobs, ...localJobs]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 6);
    if ([...backendJobs, ...superJobs].some((job) =>
      ["running", "done", "partial", "failed"].includes(job.status)
      || Boolean(job.resultIds?.length)
    )) {
      await refreshLeadFinderOpportunities();
    }
    renderLeadFinderJobs();
    if (qs<HTMLElement>(".view.active")?.id === "lead-task-detail") renderLeadTaskDetail();
    void loadProspectFeedback(true);
    syncLeadFinderRunPolling();
    syncLeadFinderLiveTransport();
  } catch (error) {
    if (!quiet && state.iamCapabilities?.source !== "platform") {
      toast(error instanceof Error ? `获客任务加载失败：${error.message}` : "获客任务加载失败", "error");
    }
    stopLeadFinderRunPolling();
  } finally {
    leadFinderRunsLoading = false;
  }
}

/** CLI 获客的「挂起任务」：复用搜客任务流式框的卡片渲染（阶段 / 进度 / 细节行 / 查看详情） */
export function createCliAcquireJob(payload: CliAcquirePayload, existing?: { id: string; createdAt: string }): LeadFinderJob {
  const focus = (payload.goal || payload.productKeywords || payload.industry || "CLI 获客").slice(0, 30);
  const restored = Boolean(existing);
  const job: LeadFinderJob = {
    id: existing?.id || `lf_cli_${Date.now()}`,
    title: `CLI 获客 · ${focus}`,
    subtitle: "联网核实公司，并找决策人/采购人邮箱，命中即入池",
    status: "running",
    resultCount: 0,
    channelCount: 1,
    elapsedText: "刚刚开始",
    progress: 10,
    steps: ["解析获客目标", "CLI 联网搜寻核实", "候选实时入池", "同步完成"],
    createdAt: existing?.createdAt || new Date().toISOString(),
    expanded: true,
    resultIds: [],
    detailLines: [restored ? "页面刷新后恢复跟踪：任务仍在本机 CLI 后台执行，结果不会丢" : "后台任务已创建，等待本机 CLI 领取执行…"],
    progressLabel: "执行进度",
    progressValue: restored ? "恢复跟踪中" : "任务已挂起",
    processPhases: [
      { id: "parse", name: "解析获客目标", status: "succeeded", result: focus },
      { id: "search", name: "本机 CLI 联网搜寻核实", status: "running", result: restored ? "正在恢复跟踪…" : "等待本机 CLI 领取任务…" },
      { id: "sync", name: "候选实时入池", status: "pending", result: "搜到一家入池一家，列表实时可见" },
      { id: "finish", name: "同步完成", status: "pending", result: "" }
    ]
  };
  leadFinderJobs = [job, ...leadFinderJobs.filter((item) => item.id !== job.id)].slice(0, 6);
  renderLeadFinderJobs();
  if (!restored) upsertCliAcquireStore({ jobId: job.id, payload, createdAt: job.createdAt });
  return job;
}

async function launchProspectRunFromLeadFinder(
  sources: string[],
  limit: number,
  mode: "standard" | "super" = "standard",
  onStage?: (stage: string) => void
): Promise<LeadFinderLaunchResult> {
  // 自然语言 / 结构化表单 互斥：仅读取生效的那一组意图，避免叠加互相限制
  let products: string[];
  let markets: string[];
  let industries: string[];
  let exclusions: string[];
  let customerType: string;
  let goalInput: string;
  let marketOpen = false; // 自然语言未识别到具体市场时，按全球范围交给 AI 推断
  let parsedName = ""; // AI 解析给出的英文项目名称，优先于表单推导的标题
  if (leadBriefMode === "nl") {
    goalInput = qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.value.trim() || "";
    if (!goalInput) throw new Error("请先在自然语言目标中描述你希望寻找的客户");
    const setVal = (sel: string, value: string) => { const el = qs<HTMLInputElement>(sel); if (el) el.value = value; };
    if (leadAiParsed) {
      // 采用 AI 解析预览里的结构化英文值（尊重用户在面板上的手动修改）
      const resolved = resolveLeadAiSearchDraft({
        name: qs<HTMLInputElement>("#leadAiName")?.value || "",
        products: leadFinderValues("#leadAiProducts"),
        markets: leadFinderValues("#leadAiMarkets"),
        industries: leadFinderValues("#leadAiIndustries"),
        exclusions: leadFinderValues("#leadAiExclusions"),
        customerType: qs<HTMLSelectElement>("#leadAiCustomerType")?.value || "*"
      });
      ({ products, markets, industries, exclusions, customerType, marketOpen } = resolved);
      // 回填隐藏表单，复用既有提交流程与标题生成
      setVal("#leadProductKeywords", products.join(", "));
      setVal("#leadCountries", markets.join(", "));
      setVal("#leadIndustryInput", industries.join(", "));
      setVal("#leadExcludeKeywords", exclusions.join(", "));
      const ct = qs<HTMLSelectElement>("#leadCustomerTypes");
      if (ct) ct.value = customerType;
      parsedName = resolved.parsedName;
      // 解析成功后，搜索只使用当前预览字段；原始自然语言不再作为隐藏 ICP 约束参与执行。
      goalInput = "";
    } else throw new Error("请先完成 AI 解析，再启动自然语言搜索");
  } else {
    products = leadFinderValues("#leadProductKeywords");
    markets = leadFinderValues("#leadCountries");
    industries = leadFinderValues("#leadIndustryInput");
    exclusions = leadFinderValues("#leadExcludeKeywords");
    customerType = qs<HTMLSelectElement>("#leadCustomerTypes")?.value.trim() || "*";
    goalInput = ""; // 结构化模式不使用目标作为 ICP 规则，避免与表单约束叠加
  }
  if (!products.length) throw new Error("请先填写产品关键词");
  // 自然语言模式的市场由 AI 从整句推断兜底，仅结构化表单强制要求填写市场
  if (leadBriefMode !== "nl" && !markets.length) throw new Error("请先填写目标国家或地区");
  const goal = [
    `Products: ${products.join(", ")}`,
    `Markets: ${markets.join(", ")}`,
    industries.length ? `Industries: ${industries.join(", ")}` : "",
    customerType === "*" ? "Customer types: all" : `Customer type: ${customerType}`,
    exclusions.length ? `Exclusions: ${exclusions.join(", ")}` : ""
  ].filter(Boolean).join("; ");
  const normalizedSources = [...new Set(sources.map((source) => source.trim().toLocaleLowerCase("en-US")).filter(Boolean))];
  if (!normalizedSources.length) {
    throw new Error(mode === "super"
      ? "超级搜索当前没有可执行的数据源，请先选择并启用至少一个来源"
      : "当前没有可执行的数据源，请先完成配置或启用来源");
  }
  const strategy = {
    name: `${currentLeadFinderTitle()} · 自动策略`,
    query: {
      keywordMode: "campaign_products",
      positiveKeywords: [],
      synonyms: [],
      industryTerms: industries,
      purchaseScenarioTerms: industries,
      countryMode: marketOpen ? "global" : "campaign_markets",
      countries: [],
      languages: [],
      customerTypeMode: customerType === "*" ? "all" : "campaign_customer_types",
      customerTypes: [],
      exclusionKeywords: exclusions,
      exclusionDomains: [],
      timeWindow: { mode: "all", from: "", to: "" }
    },
    providerPlan: normalizedSources.map((providerId, index) => ({
      providerId,
      priority: index + 1,
      // Let the run-level allocator paginate a source when it has more
      // results; the total accepted result count is still capped globally.
      pageLimit: 100,
      resultLimit: Math.max(1, Math.min(1000, limit)),
      budgetLimit: null,
      currency: ""
    })),
    reason: "由自动搜客页面生成"
  };
  const costLimit = Number(qs<HTMLInputElement>("#leadSuperCost")?.value || 0);
  const superSearch = mode === "super" ? {
    targetCandidateCount: Number(qs<HTMLInputElement>("#leadSuperTarget")?.value || 300),
    maxDurationMinutes: Number(qs<HTMLSelectElement>("#leadSuperDuration")?.value || 480),
    depth: qs<HTMLSelectElement>("#leadSuperDepth")?.value || "deep",
    costLimit,
    currency: costLimit > 0 ? "USD" : "",
    aiMode: "auto",
    webSearchMode: superWebSearchMode(),
    mapSearchMode: superMapSearchMode(),
    aiDiscoveryMode: superAiDiscoveryMode()
  } : undefined;
  const schedule = mode === "standard"
    && qs<HTMLInputElement>("#leadFinderScheduleInput")?.checked
    ? {
        frequency: qs<HTMLSelectElement>("#leadFinderScheduleFrequency")?.value || "weekly",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
        recurringCostApproved: Boolean(
          qs<HTMLInputElement>("#leadFinderRecurringCostInput")?.checked
        )
      }
    : undefined;
  onStage?.("正在提交策略并启动搜索");
  return api<LeadFinderLaunchResult>("/api/lead-finder/launch", {
    method: "POST",
    headers: {
      "Idempotency-Key": `lead-finder:${crypto.randomUUID()}`
    },
    body: JSON.stringify({
      mode,
      campaign: {
        name: parsedName || currentLeadFinderTitle(),
        snapshot: {
          goal,
          products,
          markets,
          customerTypes: [customerType],
          applicationScenarios: industries,
          icpRules: [],
          exclusionRules: exclusions,
          sourceProviderIds: normalizedSources
        }
      },
      strategy,
      ...(superSearch ? { superSearch } : {}),
      ...(schedule ? { schedule } : {})
    })
  });
}

function lfindTaskStatus(status: LfindTask["status"]): LeadFinderJob["status"] {
  if (status === "succeeded") return "done";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "running";
}

function buildLfindSearchBody() {
  const products = leadFinderValues("#leadProductKeywords");
  const countries = leadFinderValues("#leadCountries");
  const industries = leadFinderValues("#leadIndustryInput");
  const exclusions = leadFinderValues("#leadExcludeKeywords");
  const customerType = qs<HTMLSelectElement>("#leadCustomerTypes")?.value.trim() || "*";
  return {
    goal: [
      qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.value.trim() || "",
      products.length ? `Products: ${products.join(", ")}` : "",
      countries.length ? `Markets: ${countries.join(", ")}` : "",
      industries.length ? `Industries: ${industries.join(", ")}` : "",
      customerType === "*" ? "" : `Customer type: ${customerType}`,
      exclusions.length ? `Exclusions: ${exclusions.join(", ")}` : ""
    ].filter(Boolean).join("; "),
    productKeywords: products.join(", "),
    countries: countries.join(", "),
    industry: industries.join(", "),
    customerType,
    excludeKeywords: exclusions.join(", "),
    limit: Number(qs<HTMLSelectElement>("#leadLimit")?.value || 12)
  };
}

async function prepareLfindSearchBody() {
  if (leadBriefMode === "nl") {
    const goal = qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.value.trim();
    if (!goal) throw new Error("请先输入自然语言搜索目标");
    if (!leadAiParsed) {
      const parsed = await runLeadAiParse();
      if (!parsed) throw new Error(leadAiParseLastError || "AI 未返回可执行的标准搜索条件");
    }
    const resolved = resolveLeadAiSearchDraft({
      name: qs<HTMLInputElement>("#leadAiName")?.value || "",
      products: leadFinderValues("#leadAiProducts"),
      markets: leadFinderValues("#leadAiMarkets"),
      industries: leadFinderValues("#leadAiIndustries"),
      exclusions: leadFinderValues("#leadAiExclusions"),
      customerType: qs<HTMLSelectElement>("#leadAiCustomerType")?.value || "*"
    });
    const setVal = (sel: string, value: string) => {
      const el = qs<HTMLInputElement>(sel);
      if (el) el.value = value;
    };
    setVal("#leadProductKeywords", resolved.products.join(", "));
    setVal("#leadCountries", resolved.markets.join(", "));
    setVal("#leadIndustryInput", resolved.industries.join(", "));
    setVal("#leadExcludeKeywords", resolved.exclusions.join(", "));
    const ct = qs<HTMLSelectElement>("#leadCustomerTypes");
    if (ct) ct.value = resolved.customerType;
  }
  const body = buildLfindSearchBody();
  if (!body.productKeywords) throw new Error("请先填写产品关键词");
  if (!body.countries && leadBriefMode !== "nl") throw new Error("请先填写目标国家或地区");
  return body;
}

function updateLfindJobFromResponse(job: LeadFinderJob, response: LfindTaskResponse) {
  const task = response.task;
  const events = response.events || [];
  const latest = [...events].reverse().find((event) => event.message)?.message || "";
  const terminal = ["succeeded", "failed", "cancelled"].includes(task.status);
  job.status = lfindTaskStatus(task.status);
  job.lfindEvents = events;
  job.lfindSkipped = response.skipped || job.lfindSkipped || [];
  job.lfindFailures = response.lfind?.failures || job.lfindFailures || [];
  job.lfindSynced = response.synced || job.lfindSynced;
  job.elapsedText = terminal ? "已结束" : "执行中";
  job.progress = terminal ? 100 : Math.min(92, Math.max(job.progress, 25 + events.length * 4));
  job.progressLabel = terminal ? "完成度" : "本地进度";
  job.progressValue = terminal ? "100%" : `${job.progress}%`;
  job.resultIds = response.opportunities?.map((item) => item.id) || job.resultIds || [];
  job.resultCount = job.resultIds.length;
  job.incrementalStats = response.incrementalStats || job.incrementalStats;
  const summary = response.lfind?.summary;
  job.metricLabel = "入池 / 原始";
  job.metricValue = response.incrementalStats
    ? `${response.incrementalStats.returnedCount} / ${response.incrementalStats.rawCount}`
    : `${job.resultCount} / ${summary?.rawFound ?? "..."}`;
  job.steps = terminal
    ? task.status === "succeeded"
      ? ["公开来源查询", "候选核验", "同步候选", "等待补全"]
      : ["公开来源查询", "执行失败", "查看原因", "调整后重试"]
    : ["提交本地 Runner", "调用 Lfind Skill", "公开来源核验", "等待结果同步"];
  const skippedLines = (response.skipped || []).slice(0, 5).map((item) =>
    `过滤：${item.company} · ${item.reason}`
  );
  const failureLines = (response.lfind?.failures || []).slice(0, 4).map((item) =>
    `失败：${item.stage} · ${item.reason}${item.suggestion ? ` · 建议：${item.suggestion}` : ""}`
  );
  job.detailLines = [
    ...buildLeadFinderJobDetails(job.resultIds),
    `Lfind 任务：${task.id}`,
    latest ? `最新进度：${latest}` : "最新进度：等待本地 Runner 领取任务",
    summary?.noResultReason ? `无结果原因：${summary.noResultReason}` : "",
    ...skippedLines,
    ...failureLines,
    task.errorMessage ? `执行错误：${task.errorMessage}` : ""
  ].filter(Boolean);
}

async function refreshLfindJob(job: LeadFinderJob) {
  if (!job.lfindTaskId) return;
  try {
    const wasSynced = Boolean(job.lfindSynced);
    const response = await api<LfindTaskResponse>(`/api/lead-finder/lfind-tasks/${encodeURIComponent(job.lfindTaskId)}`);
    updateLfindJobFromResponse(job, response);
    if (response.opportunities?.length) {
      const existing = state.websiteOpportunities
        .filter((item) => !response.opportunities!.some((next) => next.id === item.id))
        .map((item) => ({ ...item, selected: false }));
      state.websiteOpportunities = [
        ...response.opportunities.map((item) => ({ ...item, selected: false })),
        ...existing
      ];
      state.leadFinderPage = 1;
      state.selectedLeadFinderId = response.opportunities[0]?.id || state.selectedLeadFinderId;
      renderWebsiteOpportunities(state.websiteOpportunities);
      renderProspectList();
    }
    renderLeadFinder(state.websiteOpportunities);
    if (activeLeadFinderJobId === job.id && qs<HTMLElement>(".view.active")?.id === "lead-task-detail") {
      renderLeadTaskDetail();
    }
    if (["done", "partial"].includes(job.status) && response.synced && !wasSynced) {
      toast(`Lfind 已同步 ${response.opportunities?.length || 0} 条候选`);
      job.lfindSynced = true;
    }
  } catch (error) {
    job.status = "failed";
    job.progress = 100;
    job.elapsedText = "已结束";
    job.detailLines = [
      ...buildLeadFinderJobDetails(job.resultIds),
      `Lfind 同步失败：${error instanceof Error ? error.message : "任务结果无法同步"}`,
      "调整建议：在集成中心查看本地 Runner 任务记录，确认 Codex 最终回复是 goodjob-lfind-v1 JSON。"
    ];
    renderLeadFinder(state.websiteOpportunities);
  }
}

function syncLfindTaskPolling() {
  const active = leadFinderJobs.some((job) =>
    job.lfindTaskId && job.status === "running"
  );
  if (!active) {
    if (lfindTaskPollTimer) window.clearInterval(lfindTaskPollTimer);
    lfindTaskPollTimer = 0;
    return;
  }
  if (lfindTaskPollTimer) return;
  lfindTaskPollTimer = window.setInterval(() => {
    if (!state.user || document.hidden) return;
    leadFinderJobs
      .filter((job) => job.lfindTaskId && job.status === "running")
      .forEach((job) => void refreshLfindJob(job));
    syncLfindTaskPolling();
  }, 3_000);
}

async function runLfindLeadSearch(button?: HTMLButtonElement) {
  const originalText = button?.textContent || "Lfind 深入查询";
  const setBusy = (text: string) => {
    if (!button) return;
    button.disabled = true;
    button.classList.add("is-running");
    button.setAttribute("aria-busy", "true");
    button.textContent = text;
  };
  const restore = () => {
    if (!button) return;
    button.disabled = false;
    button.classList.remove("is-running");
    button.removeAttribute("aria-busy");
    button.textContent = originalText;
  };
  try {
    setBusy("准备 Lfind");
    const body = await prepareLfindSearchBody();
    const job: LeadFinderJob = {
      id: `lfind_${Date.now()}`,
      title: `Lfind 深入查询 · ${currentLeadFinderTitle()}`,
      subtitle: currentLeadFinderSubtitle(),
      status: "running",
      resultCount: 0,
      channelCount: 1,
      elapsedText: "刚刚开始",
      progress: 18,
      steps: ["提交本地 Runner", "调用 Lfind Skill", "公开来源核验", "等待结果同步"],
      createdAt: new Date().toISOString(),
      expanded: true,
      resultIds: [],
      detailLines: [...buildLeadFinderJobDetails(), "Lfind 任务：正在创建"]
    };
    leadFinderJobs = [job, ...leadFinderJobs].slice(0, 6);
    renderLeadFinder(state.websiteOpportunities);
    setBusy("提交 Lfind");
    const response = await api<{ task: LfindTask; message: string; suggestion: string }>("/api/lead-finder/lfind-tasks", {
      method: "POST",
      body: JSON.stringify(body)
    });
    job.lfindTaskId = response.task.id;
    job.detailLines = [
      ...buildLeadFinderJobDetails(),
      `Lfind 任务：${response.task.id}`,
      response.message,
      response.suggestion
    ];
    toast("Lfind 深入查询已提交，本地 Runner 会异步执行");
    renderLeadFinder(state.websiteOpportunities);
    syncLfindTaskPolling();
    void refreshLfindJob(job);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Lfind 深入查询启动失败", "error");
  } finally {
    restore();
  }
}

async function runLeadFinder(button?: HTMLButtonElement) {
  const originalText = button?.textContent || "生成并运行任务";
  let launchStage = "启动前校验";
  const setStartStage = (stage: string) => {
    launchStage = stage;
    if (button) {
      button.disabled = true;
      button.classList.add("is-running");
      button.setAttribute("aria-busy", "true");
      button.textContent = stage;
    }
  };
  const restoreStartButton = () => {
    if (!button) return;
    button.disabled = false;
    button.classList.remove("is-running");
    button.removeAttribute("aria-busy");
    button.textContent = originalText;
  };
  const input = qs<HTMLTextAreaElement>("#leadFinderUrlInput");
  const urls = (input?.value || "").split(/\n|,|，/).map((item) => item.trim()).filter(Boolean).slice(0, Number(qs<HTMLSelectElement>("#leadLimit")?.value || 20));
  renderLeadFinderSearchLinks();
  if (!urls.length) await loadLeadProviders();
  let sources: string[] = [];
  if (!urls.length) {
    const resolution = resolveLeadSearchSources(
      state.leadProviders,
      state.selectedLeadSources,
      state.leadSourceSelectionTouched
    );
    if (resolution.requiresSelection) {
      toast("请至少选择一个已启用的数据源", "error");
      return;
    }
    if (resolution.blocked.length) {
      toast(leadSourceBlockedMessage(resolution.blocked), "error");
      return;
    }
    if (!resolution.sources.length) {
      toast("当前没有可执行的数据源，请先完成配置或启用来源", "error");
      return;
    }
    sources = resolution.sources;
    if (leadFinderMode === "super") {
      const webIds = new Set(superWebProviders().map((provider) => provider.id));
      const selectedWebSources = sources.filter((providerId) => webIds.has(providerId));
      if (superWebSearchMode() === "api" && !selectedWebSources.length) {
        renderSuperWebSearchOption();
        openLeadSourceCenter(superWebProviders()[0]?.id);
        toast("实时网页搜索尚无可用来源，请先完成配置", "error");
        return;
      }
      if (superWebSearchMode() === "off") {
        sources = sources.filter((providerId) => !webIds.has(providerId));
      }
      const mapIds = new Set(superMapProviders().map((provider) => provider.id));
      const selectedMapSources = sources.filter((providerId) => mapIds.has(providerId));
      if (superMapSearchMode() === "google_places" && !selectedMapSources.includes("google_places")) {
        renderSuperMapSearchOption();
        openLeadSourceCenter("google_places");
        toast("地图企业搜索尚未配置 Google Places", "error");
        return;
      }
      if (superMapSearchMode() === "off") {
        sources = sources.filter((providerId) => !mapIds.has(providerId));
      }
      const selectedAiSources = sources.filter((providerId) => providerId === "ai_search");
      if (superAiDiscoveryMode() === "model" && !selectedAiSources.length) {
        renderSuperAiDiscoveryOption();
        activateNavView("ai-config", () => {
          qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
          toast("AI 深度发现尚无可用模型，请先完成配置", "error");
        });
        return;
      }
      if (superAiDiscoveryMode() === "off") {
        sources = sources.filter((providerId) => providerId !== "ai_search");
      }
    }
    if (!sources.length) {
      if (leadFinderMode === "super") {
        renderSuperSearchPreview();
        toast("超级搜索当前没有可执行的数据源，请开启网页、地图或 AI 深度发现，或选择一个企业数据源", "error");
      } else {
        const aiReadiness = leadFinderAiReadiness();
        toast(`当前没有可执行的数据源。你可以配置 AnySearch、Serper、Brave、SerpApi、Google Places，或启用 AI 搜索。${aiReadiness.ready ? "" : aiReadiness.message}`, "error");
      }
      return;
    }
    if (sources.includes("ai_search") && !leadFinderAiReadiness().ready) {
      toast(leadFinderAiReadiness().message, "error");
      return;
    }
  }
  const limit = Number(qs<HTMLSelectElement>("#leadLimit")?.value || 12);
  const scheduleEnabled = leadFinderMode === "standard" && Boolean(qs<HTMLInputElement>("#leadFinderScheduleInput")?.checked);

  // 先完成自然语言解析，再进入费用确认和后台启动，避免用户看到“解析成功”后
  // 仍不知道是否已经进入启动流程。失焦自动解析与这里的启动解析会复用同一个请求。
  if (!urls.length && leadBriefMode === "nl") {
    const goal = qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.value.trim();
    if (!goal) {
      toast("请先输入自然语言搜索目标", "error");
      return;
    }
    if (!leadAiParsed) {
      setStartStage("正在解析搜索目标");
      const parsed = await runLeadAiParse();
      if (!parsed) {
        recordLeadFinderLaunchFailure("AI 解析", leadAiParseLastError || "AI 未返回可执行的标准搜索条件");
        restoreStartButton();
        return;
      }
    }
  }

  // 计费源成本护栏：付费 API 与 AI 搜索都会产生费用，搜索前确认
  if (!urls.length) {
    const billed = sources.map((id) => state.leadProviders.find((p) => p.id === id)).filter((p): p is LeadProviderStatus => Boolean(p && (p.tier === "paid" || p.tier === "ai")));
    if (leadFinderMode === "super" && billed.length && Number(qs<HTMLInputElement>("#leadSuperCost")?.value || 0) <= 0) {
      toast("超级搜索选择了计费或 AI 来源，请先设置费用上限", "error");
      restoreStartButton();
      return;
    }
    if (billed.length) {
      const billingSummary = billed.map((p) => p.tier === "ai"
        ? `${p.name}：消耗你配置的 AI 模型 token`
        : `${p.name}：约 ${Math.min(limit, 15)} 次调用${p.usage ? `（${p.usage}）` : ""}`).join("；");
      if (!await confirmAction({
        title: "确认使用计费数据源",
        message: "本次搜客会调用可能产生费用的数据源。",
        detail: billingSummary,
        detailLabel: "计费来源",
        consequences: ["第三方 API 或 AI 模型可能产生实际费用", "具体费用以对应服务商账单为准", "任务创建后可在运行记录中查看调用情况"],
        confirmLabel: "确认并开始",
        tone: "warning"
      })) {
        restoreStartButton();
        return;
      }
    }
    if (scheduleEnabled
      && billed.length
      && !qs<HTMLInputElement>("#leadFinderRecurringCostInput")?.checked) {
      toast("定期任务包含计费或 AI 数据源，请单独勾选持续费用确认", "error");
      restoreStartButton();
      return;
    }
  }

  // 已有搜索任务在进行中时，先与用户确认是否排队，而不是直接撞后端 409
  if (!urls.length) {
    setStartStage("正在检查进行中的任务");
    let activeRuns: ProspectRunApiRecord[] = [];
    try {
      const list = await api<{ runs: ProspectRunApiRecord[] }>("/api/prospect-runs?limit=20");
      activeRuns = list.runs.filter((run) => prospectRunActiveStatuses.has(run.status));
    } catch {
      // 检查失败不阻塞启动，后端兜底校验仍会拦截真正的冲突
    }
    if (activeRuns.length) {
      const runningDetail = activeRuns.slice(0, 3).map((run) =>
        `${run.executionSnapshot?.campaign.name || "搜客任务"} · ${prospectRunStatusLabel(run.status)}`
      ).join("；") + (activeRuns.length > 3 ? ` 等 ${activeRuns.length} 个任务` : "");
      const queued = await confirmAction({
        title: "已有搜索任务进行中",
        message: "当前已经有搜索任务在进行中，是否将本次搜索任务进行排队？",
        detail: runningDetail,
        detailLabel: "进行中的任务",
        consequences: [
          "新任务会立即创建并进入执行队列，等待系统调度执行",
          "排队不会重复扣用已确认的计费来源，费用以实际执行为准",
          "也可以先取消，等当前任务完成后再启动"
        ],
        confirmLabel: "排队执行",
        tone: "warning"
      });
      if (!queued) {
        restoreStartButton();
        return;
      }
    }
  }

  let job: LeadFinderJob | null = null;
  setStartStage(urls.length ? "正在登记链接" : "正在创建任务");
  try {
    if (!urls.length) {
      // 自然语言模式：若尚未解析，启动前自动解析（描述完直接点搜索也能用，无需手动点「AI 解析」）
      if (leadBriefMode === "nl") {
        const goal = qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.value.trim();
        if (goal && !leadAiParsed) {
          setStartStage("正在解析搜索目标");
          const parsed = await runLeadAiParse();
          if (!parsed) return;
        }
      }
      const result = await launchProspectRunFromLeadFinder(
        sources,
        limit,
        leadFinderMode,
        (stage) => setStartStage(stage)
      );
      setStartStage("搜索已进入队列");
      const backendJob = prospectRunJob(result);
      if (result.launchTimings) {
        const timing = result.launchTimings;
        backendJob.detailLines = [
          ...(backendJob.detailLines || []),
          `任务准备耗时：${(timing.totalMs / 1000).toFixed(1)} 秒（项目 ${timing.campaignMs}ms、策略 ${Math.round(timing.strategyMs + timing.approvalMs)}ms、启动 ${Math.round(timing.activationMs + timing.runMs + timing.queueMs)}ms）`
        ];
        console.info("Lead finder launch timings", timing);
      }
      if (result.superSearch) {
        try {
          applySuperSearchMission(backendJob, result.superSearch);
        } catch (error) {
          // The run is already accepted by the backend. Keep it visible even
          // if an optional legacy snapshot field cannot be rendered yet.
          console.error("Unable to enrich super search task card", error);
          backendJob.detailLines = [
            ...(backendJob.detailLines || []),
            "超级搜索已进入队列，详细轮次正在同步"
          ];
        }
      }
      leadFinderJobs = [backendJob, ...leadFinderJobs.filter((item) => item.backendRunId !== backendJob.backendRunId)]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 6);
      renderLeadFinder(state.websiteOpportunities);
      if (result.schedule) {
        state.prospectSchedules = [
          result.schedule,
          ...state.prospectSchedules.filter((item) => item.id !== result.schedule?.id)
        ];
        renderProspectSchedules();
      }
      syncLeadFinderRunPolling();
      syncLeadFinderLiveTransport("lead-finder");
      if (result.scheduleError) {
        toast(`即时获客任务已创建，但定期计划未创建：${result.scheduleError}`, "error");
      } else {
        toast(result.schedule
          ? `获客任务已创建，定期计划将在${prospectScheduleFrequencyLabel(result.schedule.frequency)}继续运行`
          : `获客任务已创建，${result.shards.length} 个数据源正在后台执行`);
      }
      return;
    }
    job = createLeadFinderJob("running");
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-scrape/preview", {
      method: "POST",
      body: JSON.stringify({ urls })
    });
    const existing = state.websiteOpportunities
      .filter((item) => !result.opportunities.some((next) => next.website === item.website))
      .map((item) => ({ ...item, selected: false }));
    state.websiteOpportunities = [...result.opportunities.map((item) => ({ ...item, selected: false })), ...existing];
    state.leadFinderPage = 1;
    state.selectedLeadFinderId = result.opportunities[0]?.id || state.selectedLeadFinderId;
    updateLeadFinderJob(job.id, result.opportunities.map((item) => item.id), "done");
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    toast(`已登记 ${result.opportunities.length} 个官网链接，公开资料待补全`);
  } catch (error) {
    if (job) updateLeadFinderJob(job.id, [], "failed");
    const reason = error instanceof Error ? error.message : "请检查网络、AI 配置和数据源状态后重试";
    if (!job) recordLeadFinderLaunchFailure(launchStage, error);
    if (reason.includes("相同搜索范围")) {
      toast("当前已有相同搜索范围的搜索任务在进行中，本次未重复启动。可等待该任务完成，或调整搜索条件后再启动", "error");
    } else {
      toast(`搜客任务失败：未启动（${launchStage}）：${reason}`, "error");
    }
  } finally {
    restoreStartButton();
  }
}

export async function shortlistLeadFinderRows(
  button?: HTMLButtonElement,
  explicitIds?: string[],
  sourceRunId?: string
) {
  const ids = explicitIds?.length
    ? [...new Set(explicitIds)]
    : collectLeadFinderRows().map((item) => item.id);
  const selectedItems = state.websiteOpportunities.filter((item) =>
    ids.includes(item.id) && canSelectLeadFinderItem(item)
  );
  if (!selectedItems.length) {
    toast("请先勾选需要加入搜客清单的候选", "error");
    return false;
  }
  const originalText = button?.textContent || "加入搜客清单";
  if (button) {
    button.disabled = true;
    button.textContent = "加入中";
  }
  try {
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/prospect-list/batch", {
      method: "PATCH",
      body: JSON.stringify({
        ids: selectedItems.map((item) => item.id),
        action: "shortlist",
        sourceRunId: sourceRunId || currentLeadFinderResultJob()?.backendRunId || currentLeadFinderResultJob()?.id,
        requestId: prospectRequestId("prospect-shortlist"),
        effectiveAt: new Date().toISOString()
      })
    });
    result.opportunities.forEach((updated) => {
      const existing = state.websiteOpportunities.find((item) => item.id === updated.id);
      if (existing) Object.assign(existing, updated, { selected: false });
    });
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    toast(`已将 ${result.opportunities.length} 条候选加入搜客清单`);
    return true;
  } catch (error) {
    toast(`加入搜客清单失败：${error instanceof Error ? error.message : "请检查网络后重试"}`, "error");
    return false;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

export let dailyAutoDate = "";

function renderDailyAuto(): void {
  const root = qs<HTMLElement>("#dailyAuto");
  if (!root) return;
  const dateInput = qs<HTMLInputElement>("#dailyAutoDate");
  if (dateInput && !dateInput.value) dateInput.value = dailyAutoDate || localDateValue();
  if (dateInput && dateInput.value) dailyAutoDate = dateInput.value;
  const dateStr = dailyAutoDate || localDateValue();
  const draft = buildDailyDraft(dateStr);
  const set = (id: string, html: string) => { const el = qs<HTMLElement>(id); if (el) el.innerHTML = html; };
  set("#dailyAutoStats", [
    ["总操作", draft.total], ["新增产品", draft.productCreated + draft.productUpdated],
    ["发货动态", draft.shipmentCreated + draft.shipmentUpdated + draft.shipmentStatus],
    ["状态流转", draft.shipmentStatus], ["异常/警告", draft.warnings + draft.errors + draft.exceptions],
    ["登录次数", draft.logins]
  ].map(([k, v]) => `<div class="dy-stat"><b>${v}</b><span>${k}</span></div>`).join(""));
  set("#dailyAutoPreview", `
    <div class="dy-sec"><h4>今日完成工作</h4><div class="dy-prose">${nl2br(draft.completedWork)}</div></div>
    <div class="dy-sec"><h4>重点客户进展</h4><div class="dy-prose">${nl2br(draft.customerProgress)}</div></div>
    <div class="dy-sec"><h4>结果与数据</h4><div class="dy-prose">${nl2br(draft.results)}</div></div>
    <div class="dy-sec dy-sec-risk"><h4>风险与阻塞</h4><div class="dy-prose">${nl2br(draft.risks)}</div></div>
    <div class="dy-sec"><h4>下一步计划</h4><div class="dy-prose">${nl2br(draft.nextPlan)}</div></div>
  `);
  set("#dailyAutoAttention", draft.attentionHtml);
  set("#dailyAutoBreakdown", draft.breakdownHtml);
}

function installEvents() {
  ensureUiLayer();
  renderDashboardCurrentDate();
  window.setInterval(renderDashboardCurrentDate, 60_000);
  installIntegrationCenterInteractions();
  setupApprovalEvents();
  qs<HTMLButtonElement>("#prospectRadarCloseButton")?.addEventListener("click", closeProspectRadar);
  qs<HTMLButtonElement>("#prospectRadarPlayButton")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.dataset.playing === "true") prospectRadarController?.pause();
    else prospectRadarController?.resume();
  });
  qs<HTMLButtonElement>("#prospectRadarReplayButton")?.addEventListener("click", () => prospectRadarController?.replay());
  qs<HTMLDialogElement>("#prospectRadarDialog")?.addEventListener("close", destroyProspectRadar);
  window.setInterval(refreshVisibleDashboard, DASHBOARD_LIVE_REFRESH_MS);
  window.setInterval(() => {
    if (state.user && document.visibilityState === "visible") void refreshExchangeTicker();
  }, EXCHANGE_RATE_REFRESH_MS);
 window.setInterval(() => {
   if (state.user && document.visibilityState === "visible") void refreshInternalMessages(false);
 }, 30000);
  window.setInterval(() => {
    if (state.user && document.visibilityState === "visible") void refreshInternalMessageBadge();
  }, 5000);
  window.addEventListener("focus", refreshVisibleDashboard);
 window.addEventListener("focus", () => {
    if (state.user) {
      void refreshInternalMessages(false);
      void refreshInternalMessageBadge();
    }
 });
  document.addEventListener("visibilitychange", refreshVisibleDashboard);
  document.addEventListener("visibilitychange", () => {
    const view = qs<HTMLElement>(".view.active")?.id || "";
    if (document.hidden) {
      stopLeadTaskEventStream(false);
      return;
    }
    if (["lead-finder", "lead-task-detail"].includes(view)) {
      void loadProspectRuns(true);
      syncLeadFinderLiveTransport(view);
    }
  });
  window.addEventListener("pagehide", () => {
    const memo = state.memos.find((item) => item.id === state.selectedMemoId);
    if (memo && memoDirty) writeMemoDraft(memo);
    destroyProspectRadar();
    stopLeadTaskEventStream(false);
  });
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
  // 默认账号静默内嵌：登录页输入框自动填好默认管理员账号密码，页面上不展示明文提示块。
  // 实际填充见 prefillLoginCredentials()（启动与退出登录时触发）。
  qs<HTMLButtonElement>("#logoutButton")?.addEventListener("click", async () => {
    if (memoDirty && !await confirmAction({
      title: "退出并清除本机草稿",
      message: "当前备忘仍仅保存在本机，尚未同步到服务器。",
      consequences: ["退出后会清除此账号的本机备忘草稿", "服务器上已经保存的备忘不会受影响"],
      confirmLabel: "清除草稿并退出",
      tone: "danger"
    })) return;
    clearCurrentUserMemoDrafts();
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    localStorage.removeItem(storage.user);
    state.user = null;
    document.body.classList.remove("is-authenticated");
    prefillLoginCredentials();
    toast("已退出登录");
  });
  qs<HTMLButtonElement>("#profileEntryButton")?.addEventListener("click", () => activateNavView("profile", () => renderProfile()));
  qs<HTMLButtonElement>("#profileSaveButton")?.addEventListener("click", (event) => void saveProfileEmailBinding(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#profileChangePasswordButton")?.addEventListener("click", (event) => void changeProfilePassword(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#profileClearImapButton")?.addEventListener("click", (event) => void clearProfileImapPassword(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#profileTestImapButton")?.addEventListener("click", (event) => void testProfileImap(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#profileDomainAuthButton")?.addEventListener("click", (event) => void checkProfileEmailDomain(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#companyProfileSaveButton")?.addEventListener("click", () => void saveCompanyProfile());
  qs<HTMLButtonElement>("#mailboxPoolAddButton")?.addEventListener("click", () => openSenderMailboxModal());
  qs<HTMLButtonElement>("#trackingSaveButton")?.addEventListener("click", (event) => void saveEmailTrackingConfig(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#mysqlImportPicker")?.addEventListener("click", () => qs<HTMLInputElement>("#mysqlImportFile")?.click());
  qs<HTMLInputElement>("#mysqlImportFile")?.addEventListener("change", (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file) void prepareMysqlImportFile(file);
  });
  qs<HTMLButtonElement>("#mysqlImportStart")?.addEventListener("click", () => void startMysqlImport());
  qsa<HTMLButtonElement>("[data-database-mode]").forEach((button) => button.addEventListener("click", () => {
    databaseMaintenanceMode = button.dataset.databaseMode === "backup" ? "backup" : "migration";
    renderMysqlImport();
  }));
  qs<HTMLButtonElement>("#databaseMaintenanceRefresh")?.addEventListener("click", () => void refreshDatabaseMaintenance());
  qs<HTMLButtonElement>("#databaseBackupStart")?.addEventListener("click", () => void startDatabaseBackup());
  qs<HTMLButtonElement>("#databaseTaskCancel")?.addEventListener("click", () => void cancelDatabaseMaintenanceTask());
  qs<HTMLButtonElement>("#databaseLogFollow")?.addEventListener("click", () => {
    databaseLogFollow = !databaseLogFollow;
    renderDatabaseStream();
  });
  qs<HTMLButtonElement>("#databaseLogLatest")?.addEventListener("click", () => {
    databaseLogFollow = true;
    renderDatabaseStream();
  });
  qs<HTMLButtonElement>("#databaseLogCopy")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(databaseLogText());
    toast("运行记录已复制");
  });
  qs<HTMLButtonElement>("#databaseLogDownload")?.addEventListener("click", downloadDatabaseLog);
  qs<HTMLButtonElement>("#profileTestSmtpButton")?.addEventListener("click", (event) => void sendProfileTestEmail(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#profileClearEmailButton")?.addEventListener("click", (event) => void clearProfileEmailBinding(event.currentTarget as HTMLButtonElement));
  // 邮箱设置页的保存键跟个人页的「保存个人资料」是同一个动作（字段本来就是同一套）
  qs<HTMLButtonElement>("#mailSettingsSaveButton")?.addEventListener("click", (event) => void saveProfileEmailBinding(event.currentTarget as HTMLButtonElement));
  // 个人页只留入口：开发信发件配置提醒条 + 「发件身份」指标都能点进邮箱设置
  ["#profileDevelopmentEmailReady", "[data-goto-mail-settings]"].forEach((selector) => {
    const entry = qs<HTMLElement>(selector);
    if (!entry) return;
    entry.addEventListener("click", () => activateNavView("mail-settings"));
    entry.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        activateNavView("mail-settings");
      }
    });
  });
  qs<HTMLInputElement>("#profileSmtpPort")?.addEventListener("input", () => updateProfileSmtpHints());
  qs<HTMLSelectElement>("#profileSmtpSecure")?.addEventListener("change", () => updateProfileSmtpHints());
  qs<HTMLButtonElement>("#profileRefreshButton")?.addEventListener("click", async () => {
    const result = await api<{ user: User }>("/api/profile");
    updateStoredUser(result.user);
    toast("个人资料已刷新");
  });
  qs<HTMLButtonElement>("#profileOpenProspectsButton")?.addEventListener("click", () => activateNavView("prospect-list", renderProspectList));
  qs<HTMLButtonElement>("#profileOpenSettingsButton")?.addEventListener("click", () => {
    if (hasIamCapability("system.settings.manage")) activateNavView("settings");
    else toast("当前角色没有公司设置权限", "error");
  });
  qs<HTMLButtonElement>("#agentSkillsRefreshButton")?.addEventListener("click", () => void loadAgentSkills());
  qs<HTMLButtonElement>("#agentSkillAddButton")?.addEventListener("click", () => openSkillResourceModal());
  qs<HTMLButtonElement>("#agentTuningInspectButton")?.addEventListener("click", () => void inspectAgentTuning());
  qs<HTMLInputElement>("#agentTuningGoalInput")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void inspectAgentTuning();
  });
  qs<HTMLInputElement>("#agentSkillsSearchInput")?.addEventListener("input", (event) => {
    agentSkillQuery = (event.currentTarget as HTMLInputElement).value.trim();
    renderAgentSkillList();
  });
  qs<HTMLSelectElement>("#agentSkillsCategoryFilter")?.addEventListener("change", (event) => {
    agentSkillCategoryFilter = (event.currentTarget as HTMLSelectElement).value;
    renderAgentSkillList();
  });
  qs<HTMLSelectElement>("#agentSkillsStatusFilter")?.addEventListener("change", (event) => {
    agentSkillStatusFilter = (event.currentTarget as HTMLSelectElement).value;
    renderAgentSkillList();
  });
  qs<HTMLSelectElement>("#agentSkillsSourceFilter")?.addEventListener("change", (event) => {
    agentSkillSourceFilter = (event.currentTarget as HTMLSelectElement).value;
    renderAgentSkillList();
  });
  qs<HTMLElement>("#agentSkillDrawerBackdrop")?.addEventListener("click", closeAgentSkillDetail);
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
  qs<HTMLButtonElement>("#morningViewButton")?.addEventListener("click", () => {
    state.morningView = !state.morningView;
    if (state.summary) renderDashboard(state.summary, state.todos, state.customers);
    toast(state.morningView ? "晨会视图已打开" : "晨会视图已关闭");
  });
  qs<HTMLButtonElement>("#tenderDailyRefreshButton")?.addEventListener("click", () => {
    // 待查询 / 失败时用非 force：后端按天幂等，当天已有成功结果直接复用不烧积分；已出结果才是真的重查
    void loadTenderDaily(tenderDailyCard.phase === "ready");
  });
  qsa<HTMLButtonElement>("[data-dashboard-period]").forEach((button) => {
    button.addEventListener("click", () => {
      state.dashboardPeriod = (button.dataset.dashboardPeriod || "today") as DashboardPeriod;
      if (state.summary) renderDashboard(state.summary, state.todos, state.customers);
    });
  });
  qsa<HTMLButtonElement>("#todo .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增待办")) button.addEventListener("click", () => openTodoModal());
    if (button.textContent?.includes("批量完成")) button.addEventListener("click", async (event) => {
      const target = event.currentTarget as HTMLButtonElement;
      const pending = filterTodos(activeTodos(state.todos)).filter((todo) => !todo.done);
      // 提醒规则生成的待办必须逐条记录跟进结果，批量完成只处理普通待办，避免整批被后端驳回。
      const direct = pending.filter((todo) => !todo.reminderRuleId).slice(0, 5);
      const skipped = pending.filter((todo) => todo.reminderRuleId).length;
      if (!direct.length) {
        toast(skipped ? `${skipped} 条待办由提醒规则生成，请点击左侧圆圈逐条记录跟进结果` : "当前没有可完成的待办", "error");
        return;
      }
      target.disabled = true;
      try {
        for (const todo of direct) {
          const response = await api<{ todo: Todo }>(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ done: true }) });
          Object.assign(todo, response.todo);
        }
        renderTodos(state.todos);
        updateTodoChips(state.todos);
        void refreshDashboardOnly();
        toast(skipped ? `已完成 ${direct.length} 条；${skipped} 条提醒待办需逐条记录跟进结果` : `已完成 ${direct.length} 条待办`);
      } catch (error) {
        toast(error instanceof Error ? error.message : "批量完成失败，请稍后重试", "error");
      } finally {
        target.disabled = false;
      }
    });
  });
  qsa<HTMLButtonElement>("[data-todo-open-dashboard]").forEach((button) => button.addEventListener("click", () => activateNavView("dashboard")));
  // 顶栏「待办」：固定在站内信左边，点一下直达待办中心（视图自己的渲染在 activateNavView 里）
  qs<HTMLButtonElement>("#topTodoPill")?.addEventListener("click", () => activateNavView("todo"));
  qs<HTMLButtonElement>("#planTaskNewButton")?.addEventListener("click", () => openPlanTaskModal());
  qs<HTMLButtonElement>("#planTaskNewButtonInline")?.addEventListener("click", () => openPlanTaskModal());
  qs<HTMLButtonElement>("#planTaskPushSelectedButton")?.addEventListener("click", (event) => void pushPlanTasksToTodos(state.selectedPlanTaskIds, event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#planMemoButton")?.addEventListener("click", (event) => void savePlanMemo(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#planExportButton")?.addEventListener("click", exportPlanCsv);
  qs<HTMLButtonElement>("#batchPriorityButton")?.addEventListener("click", (event) => void batchProcessPriorityTasks(event.currentTarget as HTMLButtonElement));
  qsa<HTMLButtonElement>("#customers .page-head .btn.primary").forEach((button) => {
    if (button.textContent?.includes("新增客户")) button.addEventListener("click", () => openCustomerModal());
  });
  qs<HTMLSelectElement>("#customerViewModeSelect")?.addEventListener("change", (event) => {
    state.customerViewMode = (event.currentTarget as HTMLSelectElement).value as "list" | "map" | "board";
    renderCustomers(state.customers);
  });
  qs<HTMLInputElement>("#customerSearchInput")?.addEventListener("input", (event) => {
    state.customerSearch = (event.currentTarget as HTMLInputElement).value;
    state.customerPage = 1;
    renderCustomers(state.customers);
  });
  qs<HTMLSelectElement>("#customerQueueFilter")?.addEventListener("change", (event) => {
    state.customerQueueFilter = (event.currentTarget as HTMLSelectElement).value as AppState["customerQueueFilter"];
    state.customerPage = 1;
    renderCustomers(state.customers);
  });
  qs<HTMLButtonElement>("#customerFilterReset")?.addEventListener("click", () => {
    state.customerSearch = "";
    state.customerQueueFilter = "all";
    state.customerPage = 1;
    const search = qs<HTMLInputElement>("#customerSearchInput");
    const filter = qs<HTMLSelectElement>("#customerQueueFilter");
    if (search) search.value = "";
    if (filter) filter.value = "all";
    renderCustomers(state.customers);
  });
  qs<HTMLSelectElement>("#customerPageSize")?.addEventListener("change", (event) => {
    state.customerPageSize = Number((event.currentTarget as HTMLSelectElement).value) as AppState["customerPageSize"];
    state.customerPage = 1;
    renderCustomers(state.customers);
  });
  qs<HTMLButtonElement>("#customerPrevPage")?.addEventListener("click", () => {
    state.customerPage = Math.max(1, state.customerPage - 1);
    renderCustomers(state.customers);
  });
  qs<HTMLButtonElement>("#customerNextPage")?.addEventListener("click", () => {
    state.customerPage += 1;
    renderCustomers(state.customers);
  });
  // —— 供应商管理：列表筛选 / 分页 / 新增（行内按钮在每次渲染后重绑）——
  qs<HTMLButtonElement>("#supplierCreateButton")?.addEventListener("click", () => openSupplierModal());
  // 表头「导出」导出当前筛选结果，和批量工具条里的导出同一口径，只是不需要先勾选
  qs<HTMLButtonElement>("#supplierExportButton")?.addEventListener("click", () => exportSuppliers(sortedSuppliers(filteredSuppliers())));
  qs<HTMLInputElement>("#supplierSearchInput")?.addEventListener("input", (event) => {
    state.supplierSearch = (event.currentTarget as HTMLInputElement).value;
    state.supplierPage = 1;
    renderSuppliers();
  });
  qs<HTMLSelectElement>("#supplierStatusFilter")?.addEventListener("change", (event) => {
    state.supplierStatusFilter = (event.currentTarget as HTMLSelectElement).value as AppState["supplierStatusFilter"];
    state.supplierPage = 1;
    renderSuppliers();
  });
  qs<HTMLButtonElement>("#supplierFilterReset")?.addEventListener("click", resetSupplierFilters);
  qs<HTMLSelectElement>("#supplierPageSize")?.addEventListener("change", (event) => {
    state.supplierPageSize = Number((event.currentTarget as HTMLSelectElement).value) || 20;
    state.supplierPage = 1;
    renderSuppliers();
  });
  qs<HTMLButtonElement>("#supplierPrevPage")?.addEventListener("click", () => {
    state.supplierPage = Math.max(1, state.supplierPage - 1);
    renderSuppliers();
  });
  qs<HTMLButtonElement>("#supplierNextPage")?.addEventListener("click", () => {
    state.supplierPage += 1;
    renderSuppliers();
  });
  qs<HTMLElement>("#supplierDrawerBackdrop")?.addEventListener("click", closeSupplierDrawer);
  qs<HTMLInputElement>("#customerPoolSearch")?.addEventListener("input", (event) => {
    state.customerPoolSearch = (event.currentTarget as HTMLInputElement).value;
    renderCustomerPool();
  });
  qs<HTMLSelectElement>("#customerPoolGradeFilter")?.addEventListener("change", (event) => {
    state.customerPoolGradeFilter = (event.currentTarget as HTMLSelectElement).value as AppState["customerPoolGradeFilter"];
    renderCustomerPool();
  });
  qs<HTMLButtonElement>("#customerPoolResetButton")?.addEventListener("click", () => {
    state.customerPoolSearch = "";
    state.customerPoolGradeFilter = "all";
    setFieldValue("#customerPoolSearch", "");
    setFieldValue("#customerPoolGradeFilter", "all");
    renderCustomerPool();
  });
  qs<HTMLButtonElement>("#customerPoolRefreshButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "刷新中";
    try {
      await reloadCustomerScopes();
      toast("客户公池已刷新");
    } catch (error) {
      toast(error instanceof Error ? error.message : "客户公池刷新失败", "error");
    } finally {
      button.disabled = false;
      button.textContent = "刷新";
    }
  });
  qs("#customerDrawerBackdrop")?.addEventListener("click", closeCustomerDrawer);
  qs<HTMLButtonElement>("#pipeline .page-head .btn.primary")?.addEventListener("click", () => openDealModal());
  qs("#dealDrawerBackdrop")?.addEventListener("click", closeDealDrawer);
  qs("#leadFinderVerificationBackdrop")?.addEventListener("click", closeLeadFinderVerificationDrawer);
  qs<HTMLInputElement>("#pipelineSearchInput")?.addEventListener("input", (event) => {
    state.pipelineSearch = (event.currentTarget as HTMLInputElement).value.trim();
    renderPipeline(state.deals);
  });
  qs<HTMLSelectElement>("#pipelineDueFilter")?.addEventListener("change", (event) => {
    state.pipelineDueFilter = (event.currentTarget as HTMLSelectElement).value;
    renderPipeline(state.deals);
  });
  qs<HTMLButtonElement>("#pipelineFilterReset")?.addEventListener("click", () => {
    state.pipelineSearch = "";
    state.pipelineDueFilter = "all";
    setFieldValue("#pipelineSearchInput", "");
    setFieldValue("#pipelineDueFilter", "all");
    renderPipeline(state.deals);
  });
  qs<HTMLInputElement>("#pipelineClosedSearch")?.addEventListener("change", (event) => {
    state.closedDealKeyword = (event.currentTarget as HTMLInputElement).value.trim();
    state.closedDealPage = 1;
    void refreshClosedDeals();
  });
  qs<HTMLSelectElement>("#pipelineClosedStatus")?.addEventListener("change", (event) => {
    state.closedDealStatus = (event.currentTarget as HTMLSelectElement).value;
    state.closedDealPage = 1;
    void refreshClosedDeals();
  });
  qs<HTMLInputElement>("#pipelineClosedMonth")?.addEventListener("change", (event) => {
    state.closedDealMonth = (event.currentTarget as HTMLInputElement).value;
    state.closedDealPage = 1;
    void refreshClosedDeals();
  });
  qs<HTMLButtonElement>("#pipelineClosedPrev")?.addEventListener("click", () => {
    state.closedDealPage = Math.max(1, state.closedDealPage - 1);
    void refreshClosedDeals();
  });
  qs<HTMLButtonElement>("#pipelineClosedNext")?.addEventListener("click", () => {
    state.closedDealPage += 1;
    void refreshClosedDeals();
  });
  qs<HTMLButtonElement>("#pipelineArchiveEntry")?.addEventListener("click", () => activateNavView("deal-archive"));
  qs<HTMLButtonElement>("#dealArchiveBackButton")?.addEventListener("click", () => activateNavView("pipeline"));
  qs<HTMLInputElement>("#dealArchiveSearch")?.addEventListener("change", (event) => {
    state.dealArchiveKeyword = (event.currentTarget as HTMLInputElement).value.trim();
    state.dealArchivePage = 1;
    void refreshDealArchive();
  });
  qs<HTMLSelectElement>("#dealArchiveStage")?.addEventListener("change", (event) => {
    state.dealArchiveStage = (event.currentTarget as HTMLSelectElement).value;
    state.dealArchivePage = 1;
    void refreshDealArchive();
  });
  qs<HTMLInputElement>("#dealArchiveMonth")?.addEventListener("change", (event) => {
    state.dealArchiveMonth = (event.currentTarget as HTMLInputElement).value;
    state.dealArchivePage = 1;
    void refreshDealArchive();
  });
  qs<HTMLButtonElement>("#dealArchiveReset")?.addEventListener("click", () => {
    state.dealArchiveKeyword = "";
    state.dealArchiveStage = "all";
    state.dealArchiveMonth = "";
    state.dealArchivePage = 1;
    setFieldValue("#dealArchiveSearch", "");
    setFieldValue("#dealArchiveStage", "all");
    setFieldValue("#dealArchiveMonth", "");
    void refreshDealArchive();
  });
  qs<HTMLButtonElement>("#dealArchivePrev")?.addEventListener("click", () => {
    state.dealArchivePage = Math.max(1, state.dealArchivePage - 1);
    void refreshDealArchive();
  });
  qs<HTMLButtonElement>("#dealArchiveNext")?.addEventListener("click", () => {
    state.dealArchivePage += 1;
    void refreshDealArchive();
  });
  qs<HTMLButtonElement>("#reminders .page-head .btn.primary")?.addEventListener("click", () => openReminderModal());
  qs<HTMLButtonElement>("#chooseCustomerImportButton")?.addEventListener("click", () => qs<HTMLInputElement>("#customerImportInput")?.click());
  qs<HTMLInputElement>("#customerImportInput")?.addEventListener("change", (event) => {
    const fileName = (event.currentTarget as HTMLInputElement).files?.[0]?.name || "未选择文件";
    const label = qs<HTMLElement>("#customerImportFileName");
    if (label) label.textContent = fileName;
  });
  qs<HTMLButtonElement>("#runCustomerImportButton")?.addEventListener("click", (event) => void importCustomersFromFile(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#downloadCustomerTemplateButton")?.addEventListener("click", downloadCustomerTemplate);
  qs<HTMLButtonElement>("#exportCustomersButton")?.addEventListener("click", () => void exportCustomers());
  qs<HTMLButtonElement>("#reportExportButton")?.addEventListener("click", () => void exportReport());
  qs<HTMLButtonElement>("#reportRefreshButton")?.addEventListener("click", () => void refreshExecutiveReport(true));
  qs<HTMLButtonElement>("#reportNoteButton")?.addEventListener("click", openReportNoteModal);
  qs<HTMLButtonElement>("#reportRiskDetailButton")?.addEventListener("click", openReportRiskModal);
  qs<HTMLButtonElement>("#newDailyReportButton")?.addEventListener("click", () => openDailyReportModal());
  qs<HTMLButtonElement>("#dailyReportRefreshButton")?.addEventListener("click", () => void refreshDailyReports(true));
  qs<HTMLButtonElement>("#dailyReportFilterButton")?.addEventListener("click", () => {
    const from = qs<HTMLInputElement>("#dailyReportFromInput")?.value || "";
    const to = qs<HTMLInputElement>("#dailyReportToInput")?.value || "";
    if (from && to && from > to) {
      toast("开始日期不能晚于结束日期", "error");
      return;
    }
    state.dailyReportFrom = from;
    state.dailyReportTo = to;
    state.dailyReportOwnerId = state.dailyReportCanViewTeam ? qs<HTMLSelectElement>("#dailyReportOwnerFilter")?.value || "" : "";
    state.selectedDailyReportId = null;
    void refreshDailyReports(false);
  });
  // 日报自动生成面板
  qs<HTMLInputElement>("#dailyAutoDate")?.addEventListener("change", (event) => {
    dailyAutoDate = (event.currentTarget as HTMLInputElement).value;
    renderDailyAuto();
  });
  qs<HTMLButtonElement>("#dailyAutoGenButton")?.addEventListener("click", () => {
    dailyAutoDate = qs<HTMLInputElement>("#dailyAutoDate")?.value || localDateValue();
    renderDailyAuto();
    toast("已重新生成今日日报", "ok");
  });
  qs<HTMLButtonElement>("#dailyAutoCopy")?.addEventListener("click", () => {
    const draft = buildDailyDraft(dailyAutoDate || localDateValue());
    const done = () => toast("已复制 Markdown 到剪贴板", "ok");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(draft.markdown).then(done, () => toast("复制失败", "error"));
    } else {
      toast("当前环境不支持剪贴板", "error");
    }
  });
  qs<HTMLButtonElement>("#dailyAutoFill")?.addEventListener("click", fillDailyReportFromDraft);
  qs<HTMLButtonElement>("#inboxRefreshButton")?.addEventListener("click", () => void refreshInternalMessages(true));
  qs<HTMLButtonElement>("#inboxMarkAllReadButton")?.addEventListener("click", () => void markAllInternalMessagesRead());
  qs<HTMLButtonElement>("#leadRefreshButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    setButtonPending(button, true, "刷新", "刷新中");
    try {
      await reloadLeads();
      toast("线索已刷新");
    } catch (error) {
      toast(error instanceof Error ? error.message : "线索刷新失败", "error");
    } finally {
      setButtonPending(button, false, "刷新", "刷新中");
    }
  });
  qs<HTMLButtonElement>("#notificationBellButton")?.addEventListener("click", () => {
    activateNavView("inbox");
  });
  qs<HTMLButtonElement>("#knowledgeAddButton")?.addEventListener("click", () => openKnowledgeModal());
  qs<HTMLButtonElement>("#knowledgeRefreshButton")?.addEventListener("click", () => void refreshKnowledgeAssets(true));
  bindKbTrainingEvents();
  qs<HTMLInputElement>("#knowledgeSearchInput")?.addEventListener("input", (event) => {
    state.knowledgeSearch = (event.currentTarget as HTMLInputElement).value;
    renderKnowledge();
  });
  const knowledgeFilters: Array<[string, keyof Pick<AppState, "knowledgeSourceFilter" | "knowledgeStatusFilter" | "knowledgeTypeFilter">]> = [
    ["#knowledgeSourceFilter", "knowledgeSourceFilter"],
    ["#knowledgeStatusFilter", "knowledgeStatusFilter"],
    ["#knowledgeTypeFilter", "knowledgeTypeFilter"]
  ];
  knowledgeFilters.forEach(([selector, field]) => qs<HTMLSelectElement>(selector)?.addEventListener("change", (event) => {
    state[field] = (event.currentTarget as HTMLSelectElement).value;
    renderKnowledge();
  }));
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
  qs<HTMLButtonElement>("#agentPlanButton")?.addEventListener("click", () => void createAgentPlan());
  qs<HTMLTextAreaElement>("#agentGoalInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void createAgentPlan();
    }
  });
  qs<HTMLButtonElement>("#agentApproveAllButton")?.addEventListener("click", () => void approveAllExternalAgentSteps());
  qs<HTMLButtonElement>("#agentPauseButton")?.addEventListener("click", () => void controlAgentMission("pause"));
  qs<HTMLButtonElement>("#agentResumeButton")?.addEventListener("click", () => void controlAgentMission("resume"));
  qs<HTMLButtonElement>("#agentCancelButton")?.addEventListener("click", () => void controlAgentMission("cancel"));
  qs<HTMLButtonElement>("#agentMemoryStatus")?.addEventListener("click", () => void openAgentMemoryManager());
  qs<HTMLButtonElement>("#agentKnowledgeStatus")?.addEventListener("click", () => void openAgentKnowledgeCenter());
  qs<HTMLButtonElement>("#agentTriggerStatus")?.addEventListener("click", () => void openAgentTriggerManager());
  qs<HTMLButtonElement>("#agentGovernanceStatus")?.addEventListener("click", () => void openAgentGovernance());
  qs<HTMLButtonElement>("#salesDistillationButton")?.addEventListener("click", (event) => void createSalesDistillationFromUi(event.currentTarget as HTMLButtonElement));
  bindMaintenanceCenterEvents();
  bindFileCenterEvents();
  bindOutreachBatchesEvents();
  bindExchangeEvents();
  bindSalesSkillCenterEvents();
  qs<HTMLButtonElement>("#salesDistillationRefreshButton")?.addEventListener("click", () => void loadSalesDistillationWorkspace());
  qs<HTMLButtonElement>("#agentNewPlanButton")?.addEventListener("click", () => {
    setFieldValue("#agentGoalInput", "");
    startNewAgentConversation();
  });
  qsa<HTMLButtonElement>("[data-agent-goal]").forEach((button) => {
    button.addEventListener("click", () => {
      setFieldValue("#agentGoalInput", button.dataset.agentGoal || "");
      qs<HTMLTextAreaElement>("#agentGoalInput")?.focus();
    });
  });
  qs<HTMLButtonElement>("#topPrimaryAction")?.addEventListener("click", () => {
    const view = qs<HTMLElement>(".view.active")?.id;
    if (view === "customers") openCustomerModal();
  });
  qs<HTMLButtonElement>("#customerImportButton")?.addEventListener("click", () => {
    activateNavView("imports", () => qs<HTMLInputElement>("#customerImportInput")?.click());
  });
  qs<HTMLButtonElement>("#customerExportButton")?.addEventListener("click", () => {
    activateNavView("imports", () => void exportCustomers());
  });
  qsa<HTMLButtonElement>("[data-top-view]").forEach((button) => {
    button.addEventListener("click", () => activateNavView(button.dataset.topView || "dashboard"));
  });
  qsa<HTMLButtonElement>(".sidebar button[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.view === "customers") {
        state.customerOutcomeFilter = button.dataset.customerOutcome === "won" ? "won" : "open";
        state.customerPage = 1;
      }
      if (button.dataset.view === "suppliers") {
        // 「全部 / 合作中 / 考察中 / 已停用」是同一个视图的四种入口，和筛选器共享状态
        state.supplierStatusFilter = (button.dataset.supplierStatus || "all") as AppState["supplierStatusFilter"];
        state.supplierPage = 1;
      }
      activateNavView(button.dataset.view || "dashboard");
    });
  });
  qs<HTMLButtonElement>("#leadNewButton")?.addEventListener("click", () => {
    qs<HTMLElement>("#leadCreateForm")?.classList.toggle("is-hidden");
  });
  qs<HTMLButtonElement>("#leadCreateCancel")?.addEventListener("click", () => {
    qs<HTMLElement>("#leadCreateForm")?.classList.add("is-hidden");
  });
  qs<HTMLFormElement>("#leadCreateForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void createLead(event.currentTarget as HTMLFormElement);
  });
  qs<HTMLInputElement>("#leadSearchInput")?.addEventListener("input", (event) => {
    state.leadSearch = (event.target as HTMLInputElement).value;
    state.leadPage = 1;
    renderLeads();
  });
  qs<HTMLInputElement>("#peerSearchInput")?.addEventListener("input", (event) => {
    state.peerSearch = (event.target as HTMLInputElement).value;
    state.peerPage = 1;
    renderPeers();
  });
  qs<HTMLSelectElement>("#peerRelationFilter")?.addEventListener("change", (event) => {
    state.peerRelationFilter = ((event.target as HTMLSelectElement).value || "all") as typeof state.peerRelationFilter;
    state.peerPage = 1;
    renderPeers();
  });
  qs<HTMLSelectElement>("#peerSortSelect")?.addEventListener("change", (event) => {
    state.peerSort = ((event.target as HTMLSelectElement).value || "newest") as typeof state.peerSort;
    state.peerPage = 1;
    renderPeers();
  });
  // 分页控件现在是静态节点（不再由 renderPeers 重建），只在启动时绑一次
  qs<HTMLButtonElement>("#peerPrevPage")?.addEventListener("click", () => {
    if (state.peerPage <= 1) return;
    state.peerPage -= 1;
    renderPeers();
  });
  qs<HTMLButtonElement>("#peerNextPage")?.addEventListener("click", () => {
    state.peerPage += 1;
    renderPeers();
  });
  qs<HTMLSelectElement>("#peerPageSize")?.addEventListener("change", (event) => {
    const size = Number((event.target as HTMLSelectElement).value);
    state.peerPageSize = PEER_PAGE_SIZE_OPTIONS.includes(size) ? size : 20;
    state.peerPage = 1;
    renderPeers();
  });
  qs<HTMLButtonElement>("#peerFilterReset")?.addEventListener("click", resetPeerFilters);
  qs<HTMLElement>("#peerDrawerBackdrop")?.addEventListener("click", closePeerDrawer);
  qs<HTMLButtonElement>("#peerCreateButton")?.addEventListener("click", () => openPeerModal());
  qs<HTMLButtonElement>("#peerImportButton")?.addEventListener("click", () => openPeerImportModal());
  qs<HTMLInputElement>("#waThreadSearch")?.addEventListener("input", (event) => {
    state.waThreadSearch = (event.target as HTMLInputElement).value;
    renderWhatsAppThreads();
  });
  qs<HTMLButtonElement>("#waNewChatButton")?.addEventListener("click", openWhatsAppCustomerPicker);
  qs<HTMLButtonElement>("#waThreadNewButton")?.addEventListener("click", openWhatsAppCustomerPicker);
  qs<HTMLButtonElement>("#waRefreshButton")?.addEventListener("click", () => void refreshWhatsAppWorkspace());
  qs<HTMLButtonElement>("#leadActiveTab")?.addEventListener("click", () => {
    state.leadView = "active";
    state.leadPage = 1;
    state.leadStageFilter = "all";
    closeLeadDrawer();
    renderLeads();
  });
  qs<HTMLButtonElement>("#leadTrashTab")?.addEventListener("click", () => {
    state.leadView = "trash";
    state.leadPage = 1;
    state.leadStageFilter = "all";
    closeLeadDrawer();
    renderLeads();
  });
  qs<HTMLSelectElement>("#leadIntentFilter")?.addEventListener("change", (event) => {
    state.leadIntentFilter = (event.target as HTMLSelectElement).value;
    state.leadPage = 1;
    renderLeads();
  });
  qs<HTMLSelectElement>("#leadSourceFilter")?.addEventListener("change", (event) => {
    state.leadSourceFilter = (event.target as HTMLSelectElement).value;
    state.leadPage = 1;
    renderLeads();
  });
  qs<HTMLSelectElement>("#leadFollowFilter")?.addEventListener("change", (event) => {
    state.leadFollowFilter = (event.target as HTMLSelectElement).value;
    state.leadPage = 1;
    renderLeads();
  });
  qs<HTMLButtonElement>("#leadFilterReset")?.addEventListener("click", resetLeadFilters);
  qs<HTMLButtonElement>("#leadReplyFilterButton")?.addEventListener("click", (event) => {
    state.leadReplyFilter = state.leadReplyFilter === "all" ? "replied" : "all";
    (event.currentTarget as HTMLButtonElement).classList.toggle("primary", state.leadReplyFilter === "replied");
    state.leadPage = 1;
    renderLeads();
  });
  qs<HTMLButtonElement>("#leadCreateOutreachBatchButton")?.addEventListener("click", () => createLeadOutreachBatchFromSelection());
  qs<HTMLButtonElement>("#leadAssignButton")?.addEventListener("click", () => {
    if (!state.selectedLeadIds.length) {
      toast("先勾选要指派的线索", "error");
      return;
    }
    void openLeadAssignModal([...state.selectedLeadIds]);
  });
  qs<HTMLButtonElement>("#leadAssignmentsButton")?.addEventListener("click", () => void openLeadAssignmentsModal());
  qs("#leadDrawerBackdrop")?.addEventListener("click", closeLeadDrawer);
  ["#leadFinderGoalInput", "#leadProductKeywords", "#leadCountries", "#leadIndustryInput", "#leadCustomerTypes", "#leadExcludeKeywords"].forEach((selector) => {
    qs<HTMLElement>(selector)?.addEventListener("input", renderLeadFinderSearchLinks);
    qs<HTMLElement>(selector)?.addEventListener("change", renderLeadFinderSearchLinks);
    qs<HTMLElement>(selector)?.addEventListener("input", renderSuperSearchPreview);
    qs<HTMLElement>(selector)?.addEventListener("change", renderSuperSearchPreview);
  });
  qsa<HTMLButtonElement>("[data-lead-search-mode]").forEach((button) => {
    button.addEventListener("click", () => setLeadFinderMode(button.dataset.leadSearchMode === "super" ? "super" : "standard"));
  });
  qsa<HTMLButtonElement>("[data-lead-brief-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      leadBriefMode = button.dataset.leadBriefMode === "form" ? "form" : "nl";
      applyBriefMode();
    });
  });
  applyBriefMode();
  qs<HTMLButtonElement>("#leadAiParseButton")?.addEventListener("click", () => void runLeadAiParse());
  qs<HTMLButtonElement>("#leadAiClearButton")?.addEventListener("click", () => clearLeadAiPreview());
  qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.addEventListener("input", () => {
    leadAiParseLastError = "";
    if (leadAiParsed) clearLeadAiPreview(true);
  });
  // 自然语言框失焦时自动解析（描述完离开焦点即解析，预览自动出现，无需手动点「AI 解析」）
  qs<HTMLTextAreaElement>("#leadFinderGoalInput")?.addEventListener("blur", () => {
    if (leadBriefMode === "nl" && !leadAiParsed) void runLeadAiParse();
  });
  populateLeadCountryDatalist();
  ["#leadSuperTarget", "#leadSuperDuration", "#leadSuperDepth", "#leadSuperCost"].forEach((selector) => {
    qs<HTMLElement>(selector)?.addEventListener("input", renderSuperSearchPreview);
    qs<HTMLElement>(selector)?.addEventListener("change", renderSuperSearchPreview);
  });
  qs<HTMLInputElement>("#leadSuperWebSearch")?.addEventListener("change", (event) => {
    void toggleSuperWebSearch((event.currentTarget as HTMLInputElement).checked);
  });
  qs<HTMLButtonElement>("#leadSuperWebConfig")?.addEventListener("click", () => {
    openLeadSourceCenter(selectedSuperWebProviderIds()[0] || superWebProviders()[0]?.id);
  });
  qs<HTMLInputElement>("#leadSuperMapSearch")?.addEventListener("change", (event) => {
    void toggleSuperMapSearch((event.currentTarget as HTMLInputElement).checked);
  });
  qs<HTMLButtonElement>("#leadSuperMapConfig")?.addEventListener("click", () => {
    openLeadSourceCenter("google_places");
  });
  qs<HTMLInputElement>("#leadSuperAiDiscovery")?.addEventListener("change", (event) => {
    void toggleSuperAiDiscovery((event.currentTarget as HTMLInputElement).checked);
  });
  qs<HTMLButtonElement>("#leadSuperAiConfig")?.addEventListener("click", () => {
    activateNavView("ai-config", () => {
      qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
      toast("已打开 AI 模型配置");
    });
  });
  qsa<HTMLButtonElement>(".lead-entry-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      chip.classList.toggle("active");
      renderLeadFinderSearchLinks();
    });
  });
  qs<HTMLButtonElement>("#leadSourceCenterButton")?.addEventListener("click", () => openLeadSourceCenter());
  qs<HTMLButtonElement>("#leadSourceManageInline")?.addEventListener("click", () => openLeadSourceCenter());
  qs<HTMLButtonElement>("#leadFinderStartButton")?.addEventListener("click", (event) => void runLeadFinder(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderStartButtonInline")?.addEventListener("click", (event) => void runLeadFinder(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderLfindButton")?.addEventListener("click", (event) => void runLfindLeadSearch(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderLfindInlineButton")?.addEventListener("click", (event) => void runLfindLeadSearch(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderCliAcquireButton")?.addEventListener("click", () => openCliAcquireModal());
  // ===== 产品维护事件绑定 =====
  qs<HTMLButtonElement>("#productAddButton")?.addEventListener("click", () => openProductModal());
  qs<HTMLButtonElement>("#productEmptyAdd")?.addEventListener("click", () => openProductModal());
  qs<HTMLButtonElement>("#productCategoryManageButton")?.addEventListener("click", openProductCategoryManager);
  qs<HTMLButtonElement>("#productBulkDelete")?.addEventListener("click", () => void bulkDeleteProducts());
  qs<HTMLInputElement>("#productSelectAll")?.addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    state.selectedProductIds = checked
      ? Array.from(new Set([...state.selectedProductIds, ...currentProductVisibleIds]))
      : state.selectedProductIds.filter((id) => !currentProductVisibleIds.includes(id));
    renderProducts();
  });
  qs<HTMLButtonElement>("#productModalClose")?.addEventListener("click", closeProductModal);
  qs<HTMLButtonElement>("#productCancelButton")?.addEventListener("click", closeProductModal);
  qs<HTMLButtonElement>("#productSaveButton")?.addEventListener("click", () => void saveProduct());
  qs<HTMLButtonElement>("#productDeleteButton")?.addEventListener("click", () => { if (editingProductId) void deleteProduct(editingProductId); });
  qs<HTMLInputElement>("#productSearch")?.addEventListener("input", renderProducts);
  qs<HTMLSelectElement>("#productCurrencyFilter")?.addEventListener("change", renderProducts);
  qs<HTMLButtonElement>("#productViewGrid")?.addEventListener("click", () => { productViewMode = "grid"; qs<HTMLElement>("#productViewGrid")?.classList.add("is-active"); qs<HTMLElement>("#productViewList")?.classList.remove("is-active"); renderProducts(); });
  qs<HTMLButtonElement>("#productViewList")?.addEventListener("click", () => { productViewMode = "list"; qs<HTMLElement>("#productViewList")?.classList.add("is-active"); qs<HTMLElement>("#productViewGrid")?.classList.remove("is-active"); renderProducts(); });
  qs<HTMLElement>("#productGrid")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const editEl = target.closest<HTMLElement>("[data-product-edit]");
    const dupEl = target.closest<HTMLElement>("[data-product-duplicate]");
    if (editEl) {
      const product = state.products.find((p) => p.id === editEl.dataset.productEdit);
      if (product) openProductModal(product);
      return;
    }
    if (dupEl) {
      const product = state.products.find((p) => p.id === dupEl.dataset.productDuplicate);
      if (product) openProductModal({ ...product, id: `prod_${state.user?.id || ""}_${Date.now()}`, nameZh: `${product.nameZh} (副本)`, updatedAt: new Date().toISOString() });
      return;
    }
    const card = target.closest<HTMLElement>(".pc-card");
    if (card && !target.closest("button") && !target.closest("input")) {
      const product = state.products.find((p) => p.id === card.dataset.productId);
      if (product) openProductDrawer(product);
    }
  });
  // ===== 发货跟踪事件绑定 =====
  qs<HTMLButtonElement>("#shipmentAddButton")?.addEventListener("click", () => openShipmentModal());
  qs<HTMLButtonElement>("#shipmentEmptyAdd")?.addEventListener("click", () => openShipmentModal());
  qs<HTMLButtonElement>("#shipmentBulkDelete")?.addEventListener("click", () => void bulkDeleteShipments());
  qs<HTMLButtonElement>("#shipmentSyncAll")?.addEventListener("click", () => void syncAllShipments());
  qs<HTMLInputElement>("#shipmentSelectAll")?.addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    state.selectedShipmentIds = checked
      ? Array.from(new Set([...state.selectedShipmentIds, ...currentShipmentVisibleIds]))
      : state.selectedShipmentIds.filter((id) => !currentShipmentVisibleIds.includes(id));
    renderShipments();
  });
  qs<HTMLButtonElement>("#shipmentModalClose")?.addEventListener("click", closeShipmentModal);
  qs<HTMLButtonElement>("#shipmentCancelButton")?.addEventListener("click", closeShipmentModal);
  qs<HTMLButtonElement>("#shipmentSaveButton")?.addEventListener("click", () => void saveShipment());
  qs<HTMLButtonElement>("#shipmentDeleteButton")?.addEventListener("click", () => { if (editingShipmentId) void deleteShipment(editingShipmentId); });
  qs<HTMLInputElement>("#shipmentSearch")?.addEventListener("input", renderShipments);

  // 系统日志：筛选 / 搜索 / 刷新 / 导出 / 详情
  qs<HTMLElement>("#logLevelChips")?.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".lg-chip");
    if (!btn) return;
    logLevelFilterValue = btn.dataset.level || "";
    qsa<HTMLElement>("#logLevelChips .lg-chip").forEach((c) => c.classList.toggle("is-active", c === btn));
    void loadLogs();
  });
  qs<HTMLElement>("#logCategoryChips")?.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".lg-chip");
    if (!btn) return;
    logCategoryFilterValue = btn.dataset.category || "";
    qsa<HTMLElement>("#logCategoryChips .lg-chip").forEach((c) => c.classList.toggle("is-active", c === btn));
    void loadLogs();
  });
  let logSearchTimer = 0;
  qs<HTMLInputElement>("#logSearch")?.addEventListener("input", (event) => {
    const kw = (event.currentTarget as HTMLInputElement).value.trim();
    if (logSearchTimer) window.clearTimeout(logSearchTimer);
    logSearchTimer = window.setTimeout(() => { logSearchValue = kw; void loadLogs(); }, 250);
  });
  qs<HTMLButtonElement>("#logRefresh")?.addEventListener("click", () => void loadLogs());
  qs<HTMLButtonElement>("#logExport")?.addEventListener("click", () => {
    const data = JSON.stringify(state.logs, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `system-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("已导出日志", "ok");
  });
  qs<HTMLElement>("#logBoard")?.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".lg-row");
    if (!row) return;
    const id = row.dataset.logId;
    const log = state.logs.find((l) => l.id === id);
    if (log) openLogDrawer(log);
  });

  qs<HTMLInputElement>("#shipmentDealSearch")?.addEventListener("input", (event) => {
    const kw = (event.currentTarget as HTMLInputElement).value;
    const idEl = qs<HTMLInputElement>("#shipmentDealId");
    if (idEl) idEl.value = "";
    const hint = qs<HTMLElement>("#shipmentDealHint");
    if (hint) { hint.textContent = "未选择"; hint.style.color = "var(--muted)"; }
    if (dealSearchTimer) window.clearTimeout(dealSearchTimer);
    dealSearchTimer = window.setTimeout(() => void searchDeals(kw), 250);
  });
  document.addEventListener("click", (event) => {
    const results = qs<HTMLElement>("#shipmentDealResults");
    if (!results || results.hidden) return;
    const target = event.target as HTMLElement;
    if (!target.closest(".deal-picker")) results.hidden = true;
  });
  qs<HTMLInputElement>("#shipmentTrackingImage")?.addEventListener("change", () => void runShipmentOcr());
  qs<HTMLButtonElement>("#shipmentOcrButton")?.addEventListener("click", () => void runShipmentOcr());
  qs<HTMLButtonElement>("#shipmentOcrClear")?.addEventListener("click", () => {
    pendingTrackingImage = "";
    pendingTrackingImageUrl = "";
    const fileInput = qs<HTMLInputElement>("#shipmentTrackingImage");
    if (fileInput) fileInput.value = "";
    const preview = qs<HTMLElement>("#shipmentOcrPreview");
    if (preview) preview.hidden = true;
    const ocrHint = qs<HTMLElement>("#shipmentOcrHint");
    if (ocrHint) ocrHint.textContent = "";
  });
  qs<HTMLButtonElement>("#shipmentItemAdd")?.addEventListener("click", () => addShipmentItemRow());
  qs<HTMLElement>("#shipmentBoard")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const editEl = target.closest<HTMLElement>("[data-shipment-edit]");
    const trackEl = target.closest<HTMLElement>("[data-shipment-track]");
    const delEl = target.closest<HTMLElement>("[data-shipment-delete]");
    const orderEl = target.closest<HTMLElement>("[data-shipment-order]");
    if (orderEl) {
      void openOrderDetail(orderEl.dataset.shipmentOrder || "");
      return;
    }
    if (editEl) {
      const shipment = state.shipments.find((s) => s.id === editEl.dataset.shipmentEdit);
      if (shipment) openShipmentModal(shipment);
      return;
    }
    if (trackEl) {
      const shipment = state.shipments.find((s) => s.id === trackEl.dataset.shipmentTrack);
      if (shipment) void syncShipmentNow(shipment);
      return;
    }
    if (delEl) { void deleteShipment(delEl.dataset.shipmentDelete || ""); return; }
    const row = target.closest<HTMLElement>(".sh-row");
    if (row && !target.closest("button") && !target.closest("input")) {
      const shipment = state.shipments.find((s) => s.id === row.dataset.shipmentId);
      if (shipment) openShipmentDrawer(shipment);
    }
  });
  qs<HTMLElement>("#leadFinderLiveOverview")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-lead-live-follow]")) {
      event.preventDefault();
      scrollLeadFinderLiveToLatest();
      return;
    }
    if (target.closest("[data-lead-empty-start]")) {
      event.preventDefault();
      void runLeadFinder(target.closest("[data-lead-empty-start]") as HTMLButtonElement);
    }
    // 仅 CLI 模式下搜客助手空状态的入口：与顶部「CLI 获客」打开同一个弹窗
    if (target.closest("[data-lead-empty-cli]")) {
      event.preventDefault();
      openCliAcquireModal();
    }
  });
  qs<HTMLTextAreaElement>("#leadFinderUrlInput")?.addEventListener("input", syncLeadFinderStartState);
  syncLeadFinderStartState();
  qsa<HTMLButtonElement>("[data-lead-result-view]").forEach((button) => {
    button.addEventListener("click", () => {
      leadFinderResultView = button.dataset.leadResultView === "cleaning" ? "cleaning" : "candidates";
      renderLeadFinderResultView();
    });
  });
  qsa<HTMLButtonElement>("[data-lead-cleaning-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.leadCleaningFilter;
      leadFinderCleaningFilter = filter === "merged" || filter === "suppressed" || filter === "rejected" ? filter : "all";
      renderLeadFinderCleaningLedger();
    });
  });
  qs<HTMLInputElement>("#leadFinderScheduleInput")?.addEventListener("change", (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    const frequency = qs<HTMLSelectElement>("#leadFinderScheduleFrequency");
    const recurring = qs<HTMLInputElement>("#leadFinderRecurringCostInput");
    const recurringLine = qs<HTMLElement>("#leadFinderRecurringCostLine");
    if (frequency) frequency.disabled = !enabled;
    if (recurring) {
      recurring.disabled = !enabled;
      if (!enabled) recurring.checked = false;
    }
    recurringLine?.classList.toggle("is-disabled", !enabled);
  });
  qs<HTMLButtonElement>("#leadFinderSyncButton")?.addEventListener("click", (event) => void shortlistLeadFinderRows(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderTodoButton")?.addEventListener("click", (event) => void createLeadFinderTodos(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderExportButton")?.addEventListener("click", exportLeadFinderRows);
  qs<HTMLButtonElement>("#leadFinderSyncButtonSide")?.addEventListener("click", (event) => void shortlistLeadFinderRows(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderTodoButtonSide")?.addEventListener("click", (event) => void createLeadFinderTodos(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#leadFinderExportButtonSide")?.addEventListener("click", exportLeadFinderRows);
  qs<HTMLButtonElement>("#leadFinderAiConfigButtonSide")?.addEventListener("click", () => activateNavView("ai-config", () => {
    qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
    toast("已打开 AI 模型配置");
  }));
  qsa<HTMLButtonElement>("[data-lead-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.leadFinderFilter = (button.dataset.leadFilter || "all") as AppState["leadFinderFilter"];
      state.leadFinderPage = 1;
      renderLeadFinder(state.websiteOpportunities);
    });
  });
  qs<HTMLButtonElement>("#leadFinderPrevPage")?.addEventListener("click", () => {
    state.leadFinderPage = Math.max(1, state.leadFinderPage - 1);
    renderLeadFinder(state.websiteOpportunities);
  });
  qs<HTMLButtonElement>("#leadFinderNextPage")?.addEventListener("click", () => {
    state.leadFinderPage += 1;
    renderLeadFinder(state.websiteOpportunities);
  });
  qs<HTMLButtonElement>("#leadFinderAiConfigButton")?.addEventListener("click", () => activateNavView("ai-config", () => {
    qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
    toast("已打开 AI 模型配置，保存后回到智能搜客即可启用 AI 解析");
  }));
  qs<HTMLInputElement>("#prospectSearchInput")?.addEventListener("input", () => {
    state.prospectPage = 1;
    renderProspectList();
  });
  qsa<HTMLButtonElement>("[data-prospect-date-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const range = button.dataset.prospectDateFilter;
      state.prospectJoinedRange = range === "today" || range === "7d" || range === "30d" || range === "custom" ? range : "all";
      state.prospectPage = 1;
      renderProspectList();
      if (state.prospectJoinedRange === "custom") qs<HTMLInputElement>("#prospectJoinedFrom")?.focus();
    });
  });
  qs<HTMLInputElement>("#prospectJoinedFrom")?.addEventListener("change", (event) => {
    state.prospectJoinedFrom = (event.currentTarget as HTMLInputElement).value;
    state.prospectPage = 1;
    renderProspectList();
  });
  qs<HTMLInputElement>("#prospectJoinedTo")?.addEventListener("change", (event) => {
    state.prospectJoinedTo = (event.currentTarget as HTMLInputElement).value;
    state.prospectPage = 1;
    renderProspectList();
  });
  qs<HTMLSelectElement>("#prospectSortSelect")?.addEventListener("change", (event) => {
    state.prospectSort = (event.currentTarget as HTMLSelectElement).value as AppState["prospectSort"];
    state.prospectPage = 1;
    renderProspectList();
  });
  qs<HTMLButtonElement>("#prospectMobileDetailClose")?.addEventListener("click", closeProspectMobileDetail);
  qs<HTMLButtonElement>("#prospectOpenFinderButton")?.addEventListener("click", () => activateNavView("lead-finder", () => renderLeadFinder(state.websiteOpportunities)));
  qs<HTMLButtonElement>("#prospectRefreshButton")?.addEventListener("click", async () => {
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-opportunities");
    state.websiteOpportunities = result.opportunities;
    prospectMobileDetailOpen = false;
    document.body.classList.remove("prospect-mobile-detail-open");
    renderProspectList();
    renderLeadFinder(state.websiteOpportunities);
    toast("搜客清单已刷新");
  });
  qs<HTMLButtonElement>("#prospectGenerateMailButton")?.addEventListener("click", (event) => void generateProspectMailDraft(event.currentTarget as HTMLButtonElement));
  qs<HTMLSelectElement>("#prospectMailSourceSelect")?.addEventListener("change", (event) => {
    const select = event.currentTarget as HTMLSelectElement;
    select.title = aiEngineSourceHint(select.value);
    const button = qs<HTMLButtonElement>("#prospectGenerateMailButton");
    if (button && !button.disabled) button.textContent = prospectMailGenerateLabel(select.value);
  });
  qs<HTMLButtonElement>("#prospectPreviewMailButton")?.addEventListener("click", renderProspectMailPreview);
  qs<HTMLButtonElement>("#prospectSendMailButton")?.addEventListener("click", (event) => void sendProspectDevelopmentEmail(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectSyncButton")?.addEventListener("click", (event) => void syncSelectedProspects(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectEnrichContactsButton")?.addEventListener("click", (event) => void enrichSelectedProspectContacts(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectBatchCreateButton")?.addEventListener("click", (event) => void createOutreachBatchFromSelection(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectExcludeButton")?.addEventListener("click", (event) => requestProspectExclusion(state.selectedProspectIds, event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectAssignButton")?.addEventListener("click", (event) => void updateProspectBatch("assign", state.selectedProspectIds, event.currentTarget as HTMLButtonElement));
  qs<HTMLInputElement>("#prospectSelectPage")?.addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    const pageRows = prospectFilteredRows().slice((state.prospectPage - 1) * PROSPECT_PAGE_SIZE, state.prospectPage * PROSPECT_PAGE_SIZE);
    const pageIds = pageRows.map((item) => item.id);
    state.selectedProspectIds = checked
      ? [...new Set([...state.selectedProspectIds, ...pageIds])]
      : state.selectedProspectIds.filter((id) => !pageIds.includes(id));
    renderProspectList();
  });
  qs<HTMLButtonElement>("#prospectPrevPage")?.addEventListener("click", () => {
    state.prospectPage = Math.max(1, state.prospectPage - 1);
    renderProspectList();
  });
  qs<HTMLButtonElement>("#prospectNextPage")?.addEventListener("click", () => {
    state.prospectPage += 1;
    renderProspectList();
  });
  ["#prospectMailTo", "#prospectMailSubject", "#prospectMailBody"].forEach((selector) => {
    qs<HTMLInputElement | HTMLTextAreaElement>(selector)?.addEventListener("input", renderProspectMailPreview);
  });
  qsa<HTMLButtonElement>("[data-prospect-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.prospectFilter = (button.dataset.prospectFilter || "all") as AppState["prospectFilter"];
      state.prospectPage = 1;
      renderProspectList();
    });
  });
  qs<HTMLButtonElement>("#prospectBuyerOnlyToggle")?.addEventListener("click", () => {
    state.prospectBuyerOnly = !state.prospectBuyerOnly;
    state.prospectPage = 1;
    renderProspectList();
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
  // ---- 顶栏全局搜索：平时只是一个图标，点开才展开，失焦就收起 ----
  // 展开/收起完全由 CSS `:focus-within` 驱动，JS 只负责「把焦点放进去 / 拿出来」。
  // 用 class 记状态会被视图重渲染打断（切页后收起动作失效），焦点不会。
  const topSearchToggle = qs<HTMLButtonElement>("#topSearchToggle");
  const topSearchField = qs<HTMLInputElement>("#topSearchInput");
  const focusTopSearch = () => {
    if (!topSearchField) return;
    topSearchField.tabIndex = 0;
    topSearchField.focus();
  };
  const dismissTopSearch = () => {
    if (!topSearchField) return;
    topSearchField.blur();
    // 收起后不能被 Tab 选中：看不见的输入框接住焦点，光标会像凭空消失
    topSearchField.tabIndex = -1;
  };
  // 已展开时点按钮想收起，按钮的 mousedown 会先把焦点从 input 抢走。
  // 挡掉这次聚焦转移，click 里才能判断出「当前是展开的」。
  topSearchToggle?.addEventListener("mousedown", (event) => event.preventDefault());
  topSearchToggle?.addEventListener("click", () => {
    if (document.activeElement === topSearchField) dismissTopSearch();
    else focusTopSearch();
  });
  topSearchField?.addEventListener("focus", () => topSearchToggle?.setAttribute("aria-expanded", "true"));
  topSearchField?.addEventListener("blur", () => {
    topSearchToggle?.setAttribute("aria-expanded", "false");
    topSearchField.tabIndex = -1;
  });
  topSearchField?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      topSearchField.value = "";
      dismissTopSearch();
      return;
    }
    if (event.key !== "Enter") return;
    const nextView = resolveTopbarSearchView(topSearchField.value);
    if (!nextView) {
      toast("没有匹配到模块，可搜索：客户、商机、考试、资料、报表、备忘", "error");
      return;
    }
    topSearchField.value = "";
    dismissTopSearch();
    activateNavView(nextView);
  });
  // 顶栏只剩一个图标时，得给个不用鼠标也能打开的方式
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    focusTopSearch();
  });
  qs<HTMLButtonElement>("#ocrLoadButton")?.addEventListener("click", () => qs<HTMLInputElement>("#ocrFileInput")?.click());
  qs<HTMLInputElement>("#ocrFileInput")?.addEventListener("change", (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file) void loadOcrCard(file);
  });
  qs<HTMLButtonElement>("#ocrRecognizeButton")?.addEventListener("click", () => void recognizeOcrImage());
  qs<HTMLButtonElement>("#ocrRemoveButton")?.addEventListener("click", () => void removeOcrCard());
  qs<HTMLButtonElement>("#ocrConfigButton")?.addEventListener("click", () => activateNavView("ai-config"));
  qs<HTMLButtonElement>("#websiteReferenceRegisterButton")?.addEventListener("click", (event) => {
    void registerWebsiteReferences(event.currentTarget as HTMLButtonElement);
  });
  qs<HTMLButtonElement>("#websiteReferenceSyncButton")?.addEventListener("click", (event) => {
    void openWebsiteQualification(event.currentTarget as HTMLButtonElement);
  });
  qsa<HTMLElement>("#toolCards .tool-card").forEach((card) => {
    card.addEventListener("click", () => {
      const target = card.dataset.toolView || "dashboard";
      if (target === "ai-research") activateNavView("ai-research", renderBackgroundResearch);
      else activateNavView(target);
    });
  });
  qsa<HTMLButtonElement>("[data-tool-back]").forEach((button) => {
    button.addEventListener("click", () => activateNavView("tools"));
  });
  qs<HTMLButtonElement>("#newDocumentButton")?.addEventListener("click", openNewDocument);
  qs<HTMLButtonElement>("#documentImportButton")?.addEventListener("click", openTradeDocumentImport);
  qs<HTMLButtonElement>("#documentOcrButton")?.addEventListener("click", openTradeDocumentOcr);
  qs<HTMLButtonElement>("#documentDefaultsViewButton")?.addEventListener("click", () => setDocumentWorkspaceMode("defaults"));
  qs<HTMLButtonElement>("#documentDefaultsBackButton")?.addEventListener("click", () => setDocumentWorkspaceMode("studio"));
  qs<HTMLButtonElement>("#documentDefaultsSaveButton")?.addEventListener("click", () => void saveDocumentDefaults());
  qs<HTMLButtonElement>("#documentDefaultsManageAssets")?.addEventListener("click", () => openDocumentAssetManager(state.documentAssets));
  qs<HTMLButtonElement>("#documentSellerProfilesManage")?.addEventListener("click", () => openDocumentAssetManager(state.documentAssets));
  bindDocumentLogoInline();
  qs<HTMLButtonElement>("#documentHistoryViewButton")?.addEventListener("click", () => setDocumentWorkspaceMode("history"));
  qs<HTMLButtonElement>("#documentHistoryBackButton")?.addEventListener("click", () => setDocumentWorkspaceMode("studio"));
  qs<HTMLButtonElement>("#quoteHistoryViewButton")?.addEventListener("click", () => { state.quoteHistoryFocusId = ""; setQuoteHistoryMode("records", false); setDocumentWorkspaceMode("quote-history"); });
  qs<HTMLButtonElement>("#quoteHistoryBackButton")?.addEventListener("click", () => setDocumentWorkspaceMode("studio"));
  qs<HTMLButtonElement>("#quoteHistoryRecordsModeButton")?.addEventListener("click", () => setQuoteHistoryMode("records"));
  qs<HTMLButtonElement>("#quoteHistoryProductModeButton")?.addEventListener("click", () => setQuoteHistoryMode("product"));
  qs<HTMLButtonElement>("#documentConvertButton")?.addEventListener("click", openDocumentConversion);
  qs<HTMLButtonElement>("#selectDocumentProductsButton")?.addEventListener("click", openProductPicker);
  qs<HTMLButtonElement>("#documentHistorySearchButton")?.addEventListener("click", () => { state.documentHistoryPage = 1; void loadDocumentHistory(); });
  qs<HTMLButtonElement>("#documentHistoryResetButton")?.addEventListener("click", resetDocumentHistoryFilters);
  qs<HTMLButtonElement>("#documentHistoryPrevButton")?.addEventListener("click", () => { state.documentHistoryPage = Math.max(1, state.documentHistoryPage - 1); void loadDocumentHistory(); });
  qs<HTMLButtonElement>("#documentHistoryNextButton")?.addEventListener("click", () => { state.documentHistoryPage = Math.min(state.documentHistoryPageCount, state.documentHistoryPage + 1); void loadDocumentHistory(); });
  qs<HTMLInputElement>("#documentHistoryKeyword")?.addEventListener("keydown", (event) => { if (event.key === "Enter") { state.documentHistoryPage = 1; void loadDocumentHistory(); } });
  qs<HTMLButtonElement>("#quoteHistorySearchButton")?.addEventListener("click", () => { state.quoteHistoryFocusId = ""; state.quoteHistoryPage = 1; void loadQuoteHistory(); });
  qs<HTMLButtonElement>("#quoteHistoryResetButton")?.addEventListener("click", resetQuoteHistoryFilters);
  qs<HTMLButtonElement>("#quoteHistoryPrevButton")?.addEventListener("click", () => { state.quoteHistoryPage = Math.max(1, state.quoteHistoryPage - 1); void loadQuoteHistory(); });
  qs<HTMLButtonElement>("#quoteHistoryNextButton")?.addEventListener("click", () => { state.quoteHistoryPage = Math.min(state.quoteHistoryPageCount, state.quoteHistoryPage + 1); void loadQuoteHistory(); });
  qsa<HTMLInputElement>("#quoteHistoryKeyword, #quoteHistoryProduct, #quoteHistoryCustomer, #quoteHistoryDeal, #quoteHistoryCountry").forEach((input) => input.addEventListener("keydown", (event) => { if (event.key === "Enter") { state.quoteHistoryFocusId = ""; state.quoteHistoryPage = 1; void loadQuoteHistory(); } }));
  qs<HTMLButtonElement>("#saveDocumentButton")?.addEventListener("click", () => void saveTradeDocument());
  qs<HTMLButtonElement>("#advancedExcelButton")?.addEventListener("click", () => void openAdvancedExcelPanel());
  qs<HTMLButtonElement>("#exportDocumentPdfButton")?.addEventListener("click", () => void exportTradeDocumentPdf());

  const planetBtn = qs<HTMLButtonElement>("#planetViewButton");
  if (planetBtn && !planetBtn.dataset.planetBound) {
    planetBtn.dataset.planetBound = "1";
    let planetHandle: { unmount: () => void } | null = null;
    let planetMode = false;
    function exitPlanet() {
      planetMode = false;
      const studio = qs<HTMLElement>("#documentStudioWorkspace");
      const history = qs<HTMLElement>("#documentHistoryWorkspace");
      const planetView = qs<HTMLElement>("#planet-view");
      if (studio) studio.hidden = false;
      if (history) history.hidden = true;
      if (planetView) planetView.hidden = true;
      planetBtn!.textContent = "星球视图";
      if (planetHandle) { planetHandle.unmount(); planetHandle = null; }
    }
    qs<HTMLButtonElement>("#planetCloseButton")?.addEventListener("click", exitPlanet);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && planetMode) exitPlanet();
    });
    planetBtn.addEventListener("click", () => {
      const studio = qs<HTMLElement>("#documentStudioWorkspace");
      const history = qs<HTMLElement>("#documentHistoryWorkspace");
      const planetView = qs<HTMLElement>("#planet-view");
      if (!studio || !planetView) return;
      if (!planetMode) {
        if (history) history.hidden = true;
        studio.hidden = true;
        planetView.hidden = false;
        planetMode = true;
        planetBtn!.textContent = "返回列表";
        void import("./planet").then((mod) => {
          if (!planetMode || planetView.hidden) return;
          planetHandle = mod.mountPlanet(planetView, {
            customers: state.customers,
            documents: state.tradeDocuments,
            onSelectDocument: (docId: string) => {
              exitPlanet();
              state.selectedDocumentId = docId;
              renderTradeDocuments(state.tradeDocuments);
              qs<HTMLElement>(`[data-document-id="${CSS.escape(docId)}"]`)?.scrollIntoView({ block: "center" });
            }
          });
        }).catch(() => {
          exitPlanet();
          toast("星球视图加载失败，请稍后重试", "error");
        });
      } else {
        exitPlanet();
      }
    });
  }
  qs<HTMLButtonElement>("#documentSubmitApprovalButton")?.addEventListener("click", () => void submitDocumentApproval());
  qs<HTMLButtonElement>("#documentApproveButton")?.addEventListener("click", () => void approveActiveDocument());
  qs<HTMLButtonElement>("#documentRejectButton")?.addEventListener("click", () => void rejectActiveDocument());
  qs<HTMLButtonElement>("#documentSendButton")?.addEventListener("click", () => void sendActiveDocument());
  qs<HTMLButtonElement>("#documentNewRevisionButton")?.addEventListener("click", () => void createDocumentRevision());
  qs<HTMLSelectElement>("#docCustomerInput")?.addEventListener("change", (event) => {
    const customerId = (event.currentTarget as HTMLSelectElement).value;
    const dealSelect = qs<HTMLSelectElement>("#docDealInput");
    if (dealSelect) {
      const deals = state.deals.filter((deal) => !customerId || deal.customerId === customerId);
      dealSelect.innerHTML = `<option value="">未关联商机</option>${deals.map((deal) => `<option value="${escapeHtml(deal.id)}">${escapeHtml(deal.title)} · ${escapeHtml(deal.stage)}</option>`).join("")}`;
      dealSelect.value = "";
    }
    applyDocumentCustomerDefaults(customerId);
  });
  qs<HTMLSelectElement>("#docDealInput")?.addEventListener("change", (event) => {
    const dealId = (event.currentTarget as HTMLSelectElement).value;
    const deal = state.deals.find((item) => item.id === dealId);
    if (!deal) return;
    const customerSelect = qs<HTMLSelectElement>("#docCustomerInput");
    if (customerSelect) customerSelect.value = deal.customerId || "";
    const currency = qs<HTMLSelectElement>("#docCurrencyInput");
    if (currency && deal.currency) currency.value = deal.currency;
    applyDocumentCustomerDefaults(deal.customerId || "", deal);
  });
  qs<HTMLSelectElement>("#docCurrencyInput")?.addEventListener("change", () => {
    const customer = state.customers.find((item) => item.id === qs<HTMLSelectElement>("#docCustomerInput")?.value);
    const deal = state.deals.find((item) => item.id === qs<HTMLSelectElement>("#docDealInput")?.value);
    applyMatchedSellerToEditor(customer, deal);
  });
  qs<HTMLButtonElement>("#addDocumentItemButton")?.addEventListener("click", addDocumentItem);
  qs<HTMLButtonElement>("#refreshDocumentPreviewButton")?.addEventListener("click", () => renderDocumentPreview(collectDocumentDraft()));
  qsa<HTMLButtonElement>("#documentTypeTabs button").forEach((button) => {
    button.addEventListener("click", () => {
      const newType = (button.dataset.docType || "PI") as "PI" | "CI" | "PO" | "CUSTOMS" | "PL" | "CONTRACT" | "QUOTATION" | "COO" | "SHIPPING";
      setDocumentType(newType);
      const customer = state.customers.find((item) => item.id === qs<HTMLSelectElement>("#docCustomerInput")?.value);
      const deal = state.deals.find((item) => item.id === qs<HTMLSelectElement>("#docDealInput")?.value);
      applyMatchedSellerToEditor(customer, deal, newType);
      const title = qs<HTMLInputElement>("#docTitleInput");
      const number = qs<HTMLInputElement>("#docNumberInput");
      if (title && (!title.value || title.value.includes("新建"))) {
        const dd = defaultTradeDocument(newType);
        title.value = dd.title;
        if (number && (!number.value || number.value.includes("-"))) number.value = dd.number;
      }
      renderDocumentPreview(collectDocumentDraft());
    });
  });
  // 语言切换 - 实时更新预览
  qs<HTMLSelectElement>("#docLanguageInput")?.addEventListener("change", () => {
    syncShippingCostLabel();
    renderDocumentPreview(collectDocumentDraft());
  });
  // 主题切换 - 同步 templateInput 并更新预览
  qs<HTMLSelectElement>("#docThemeInput")?.addEventListener("change", (event) => {
    const val = (event.currentTarget as HTMLSelectElement).value;
    const tpl = qs<HTMLSelectElement>("#docTemplateInput");
    if (tpl && !DOC_PINNED_TEMPLATE_STYLES.has(tpl.value)) tpl.value = val;
    renderDocThemeSwatches(val);
    renderDocumentPreview(collectDocumentDraft());
  });
  qs<HTMLSelectElement>("#docTemplateInput")?.addEventListener("change", (event) => {
    const val = (event.currentTarget as HTMLSelectElement).value;
    const th = qs<HTMLSelectElement>("#docThemeInput");
    if (th) th.value = DOC_PINNED_TEMPLATE_STYLES.has(val) ? "rose" : val;
    renderDocThemeSwatches(th?.value || val);
    renderDocumentPreview(collectDocumentDraft());
  });
  // 数据源填充
  qs<HTMLSelectElement>("#docDataSourceInput")?.addEventListener("change", (event) => {
    const source = (event.currentTarget as HTMLSelectElement).value;
    applyDataSource(source);
  });
  qsa<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("#documents input, #documents select, #documents textarea").forEach((input) => {
    input.addEventListener("input", () => renderDocumentPreview(collectDocumentDraft()));
    input.addEventListener("change", () => renderDocumentPreview(collectDocumentDraft()));
  });
  qsa<HTMLButtonElement>("#ocrSyncTopButton, #ocrSyncButton").forEach((button) => {
    button.addEventListener("click", () => void syncOcrLead(button));
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
    if (button.textContent?.includes("新增问题")) button.addEventListener("click", () => openProblemModal());
    if (button.textContent?.includes("导出复盘")) button.addEventListener("click", () => toast("问题复盘已生成导出任务"));
  });
  qs<HTMLInputElement>("#problemSearchInput")?.addEventListener("input", (event) => {
    state.problemSearch = (event.currentTarget as HTMLInputElement).value;
    renderProblems(state.problems);
  });
  qs<HTMLSelectElement>("#problemStatusFilter")?.addEventListener("change", (event) => {
    state.problemStatusFilter = (event.currentTarget as HTMLSelectElement).value as AppState["problemStatusFilter"];
    renderProblems(state.problems);
  });
  qs<HTMLSelectElement>("#problemSeverityFilter")?.addEventListener("change", (event) => {
    state.problemSeverityFilter = (event.currentTarget as HTMLSelectElement).value as AppState["problemSeverityFilter"];
    renderProblems(state.problems);
  });
  qs<HTMLSelectElement>("#problemCategoryFilter")?.addEventListener("change", (event) => {
    state.problemCategoryFilter = (event.currentTarget as HTMLSelectElement).value;
    renderProblems(state.problems);
  });
  qs<HTMLButtonElement>("#problemResetFiltersButton")?.addEventListener("click", () => {
    state.problemSearch = "";
    state.problemStatusFilter = "all";
    state.problemSeverityFilter = "all";
    state.problemCategoryFilter = "all";
    const search = qs<HTMLInputElement>("#problemSearchInput");
    const status = qs<HTMLSelectElement>("#problemStatusFilter");
    const severity = qs<HTMLSelectElement>("#problemSeverityFilter");
    if (search) search.value = "";
    if (status) status.value = "all";
    if (severity) severity.value = "all";
    renderProblems(state.problems);
  });
  qs("#problemDrawerBackdrop")?.addEventListener("click", closeProblemDrawer);
  qs<HTMLButtonElement>("#memoNewButton")?.addEventListener("click", openMemoModal);
  qs<HTMLInputElement>("#memoSearchInput")?.addEventListener("input", (event) => {
    state.memoSearch = (event.currentTarget as HTMLInputElement).value;
    memoMobileDetailOpen = false;
    renderMemos();
  });
  qsa<HTMLButtonElement>("[data-memo-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      await saveCurrentMemoDraft();
      state.memoStatus = (button.dataset.memoStatus as AppState["memoStatus"]) || "active";
      state.memoPinnedOnly = state.memoStatus === "deleted" ? false : state.memoPinnedOnly;
      state.selectedMemoId = null;
      memoMobileDetailOpen = false;
      renderMemos();
    });
  });
  qs<HTMLInputElement>("#memoPinnedOnly")?.addEventListener("change", (event) => {
    state.memoPinnedOnly = (event.currentTarget as HTMLInputElement).checked;
    state.selectedMemoId = null;
    memoMobileDetailOpen = false;
    renderMemos();
  });
  qs<HTMLButtonElement>("#memoBackButton")?.addEventListener("click", async () => {
    await saveCurrentMemoDraft();
    memoMobileDetailOpen = false;
    renderMemos();
  });
  qs<HTMLButtonElement>("#memoSaveState")?.addEventListener("click", () => {
    if (memoDirty) void saveCurrentMemoDraft();
  });
  qs<HTMLButtonElement>("#memoPinButton")?.addEventListener("click", () => {
    const memo = state.memos.find((item) => item.id === state.selectedMemoId);
    if (memo) void patchSelectedMemo({ pinned: !memo.pinned });
  });
  qs<HTMLButtonElement>("#memoArchiveButton")?.addEventListener("click", () => {
    const deletedMemo = state.deletedMemos.find((item) => item.id === state.selectedMemoId);
    if (deletedMemo) {
      void restoreSelectedMemo();
      return;
    }
    const memo = state.memos.find((item) => item.id === state.selectedMemoId);
    if (memo) void patchSelectedMemo({ archived: !memo.archived });
  });
  qs<HTMLButtonElement>("#memoDeleteButton")?.addEventListener("click", () => void deleteSelectedMemo());
  const systemSettingsSaveButton = qs<HTMLButtonElement>("#systemSettingsSaveButton");
  systemSettingsSaveButton?.addEventListener("click", () => void saveTeamSystemSettings(systemSettingsSaveButton));
  qs<HTMLButtonElement>("#tradeDocumentOcrSaveButton")?.addEventListener("click", (event) => void saveTradeDocumentOcrProvider(event.currentTarget as HTMLButtonElement));
  const aiEngineSaveButton = qs<HTMLButtonElement>("#aiEngineSaveButton");
  aiEngineSaveButton?.addEventListener("click", () => void saveAiEngineSettings(aiEngineSaveButton));
  qs<HTMLSelectElement>("#tradeDocumentOcrProvider")?.addEventListener("change", () => {
    tradeDocumentOcrProvider = { ...tradeDocumentOcrProvider, provider: (qs<HTMLSelectElement>("#tradeDocumentOcrProvider")?.value || "none") as TradeDocumentOcrProviderConfig["provider"] };
    renderTeamSystemSettings();
  });
}

function rememberWorkspaceTab(view: string) {
  if (!qs<HTMLElement>(`#${CSS.escape(view)}`)) view = "dashboard";
  view = workspaceTabKey(view);
  if (!openWorkspaceTabs.includes(view)) openWorkspaceTabs.push(view);
  workspaceTabHistory = [view, ...workspaceTabHistory.filter((item) => item !== view && openWorkspaceTabs.includes(item))];
}

function closeWorkspaceTab(view: string) {
  if (view === "dashboard") return;
  openWorkspaceTabs = openWorkspaceTabs.filter((item) => item !== view);
  workspaceTabHistory = workspaceTabHistory.filter((item) => item !== view && openWorkspaceTabs.includes(item));
  const activeView = qs<HTMLElement>(".view.active")?.id || "dashboard";
  if (workspaceTabKey(activeView) === view) activateNavView(workspaceTabHistory[0] || "dashboard");
  else renderOpenWorkspaceTabs(activeView);
}

export function renderOpenWorkspaceTabs(activeView: string) {
  const wrap = qs<HTMLElement>("#topOpenTabs");
  if (!wrap) return;
  if (isPlatformOperator()) {
    openWorkspaceTabs = ["platform-operations"];
    workspaceTabHistory = ["platform-operations"];
    wrap.innerHTML = "";
    return;
  }
  openWorkspaceTabs = openWorkspaceTabs.filter((view) => canAccessWorkspaceView(view));
  workspaceTabHistory = workspaceTabHistory.filter((view) => canAccessWorkspaceView(view));
  if (canAccessWorkspaceView("dashboard") && !openWorkspaceTabs.includes("dashboard")) openWorkspaceTabs.unshift("dashboard");
  const activeTab = workspaceTabKey(activeView);
  wrap.innerHTML = openWorkspaceTabs.map((view) => {
    const label = viewLabels[view] || view;
    const active = view === activeTab ? " active" : "";
    const close = view === "dashboard" ? "" : `<span class="top-tab-close" data-close-tab="${view}" aria-label="关闭${label}">×</span>`;
    return `<button type="button" class="top-tab${active}" data-tab-view="${view}" title="${label}"><span class="top-tab-label">${label}</span>${close}</button>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-tab-view]", wrap).forEach((button) => {
    button.addEventListener("click", () => activateNavView(button.dataset.tabView || "dashboard"));
  });
  qsa<HTMLElement>("[data-close-tab]", wrap).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeWorkspaceTab(button.dataset.closeTab || "dashboard");
    });
  });
  qs<HTMLElement>(".top-tab.active", wrap)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

let themeCurrentSelection = getInitialTheme();

// 独立换肤界面：点预设/取色器仅预览，点「保存主题」才写入账号
function renderThemeView(): void {
  const wrap = qs<HTMLElement>("#themePresets");
  if (!wrap) return;
  const active = getInitialTheme();
  wrap.innerHTML = THEME_PRESETS.map((t) => `
    <button type="button" class="th-preset ${active === t.id ? "is-active" : ""}" data-theme-pick="${t.id}" title="${t.name}">
      <span class="th-preset-swatches">
        <i style="background:${t.colors[0]}"></i>
        <i style="background:${t.colors[1]}"></i>
        <i style="background:${t.colors[2]}"></i>
        <i style="background:${t.colors[3]}"></i>
      </span>
      <span class="th-preset-meta">
        <b>${t.name}${t.id === THEME_DEFAULT ? `<i class="th-preset-badge">系统默认</i>` : ""}</b>
        <small>${t.desc}</small>
      </span>
    </button>`).join("");
  qsa<HTMLButtonElement>("[data-theme-pick]", wrap).forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.themePick!;
      themeCurrentSelection = id;
      applyTheme(id);
      qsa(".th-preset", wrap).forEach((n) => n.classList.toggle("is-active", n === btn));
      setThemeStatus(`已预览「${THEME_PRESETS.find((t) => t.id === id)?.name}」，点「保存主题」生效`, "preview");
    });
  });
  const picker = qs<HTMLInputElement>("#themeCustomColor");
  const hexLabel = qs<HTMLElement>("#themeCustomHex");
  const hint = qs<HTMLElement>("#themeCustomHint");
  if (picker) {
    picker.addEventListener("input", () => {
      const hex = picker.value;
      if (hexLabel) hexLabel.textContent = hex.toUpperCase();
      themeCurrentSelection = `custom:${hex}`;
      applyTheme(themeCurrentSelection);
      const ok = contrastRatio("#ffffff", hex) >= 4.5;
      if (hint) hint.textContent = ok ? "白字对比度达标，可直接使用" : "该颜色偏浅，已自动加深以满足可读标准";
      qsa(".th-preset", wrap).forEach((n) => n.classList.remove("is-active"));
      setThemeStatus("自定义预览中，点「保存主题」生效", "preview");
    });
  }
  const saveBtn = qs<HTMLButtonElement>("#themeSave");
  if (saveBtn) saveBtn.onclick = async () => {
    await saveTheme(themeCurrentSelection);
    setThemeStatus("主题已保存并同步到账号", "saved");
    toast("主题已保存", "success");
  };
  const resetBtn = qs<HTMLButtonElement>("#themeReset");
  if (resetBtn) resetBtn.onclick = () => {
    themeCurrentSelection = THEME_DEFAULT;
    applyTheme(THEME_DEFAULT);
    qsa(".th-preset", wrap).forEach((n) => n.classList.toggle("is-active", (n as HTMLElement).dataset.themePick === THEME_DEFAULT));
    setThemeStatus("已恢复默认主题（晨白），点「保存主题」生效", "preview");
  };
}
let mcComposeDraftFlushBound = false;

// 关页面/刷新时兜底存一次草稿（700ms 防抖可能来不及跑）
if (!mcComposeDraftFlushBound) {
  mcComposeDraftFlushBound = true;
  window.addEventListener("beforeunload", mcComposeDraftSaveNow);
}

export function activateNavView(view: string, after?: () => void) {
  // 刷新后可能恢复到详情页，但没有订单 id：直接退回列表，避免空白页
  if (view === "order-detail" && !qs<HTMLElement>("#order-detail")?.dataset.orderId) {
    view = "orders";
  }
  if (view === "access-control") view = "member-management";
  if (!qs<HTMLElement>(`#${CSS.escape(view)}`)) view = "dashboard";
  if (!canAccessWorkspaceView(view)) {
    const platformOperator = isPlatformOperator();
    toast(platformOperator ? "业务模块请登录其他账号" : "当前账号无权访问系统设置", "error");
    view = platformOperator ? "platform-operations" : "dashboard";
    after = undefined;
  }
  const activeView = qs<HTMLElement>(".view.active")?.id;
  if (activeView === "global-map") stopGmTimeline();
  if (activeView === "kb-training" && view !== "kb-training") stopKbTrainingPoll();
  if (activeView === "container-load") disposeContainerLoad();
  if (activeView === "auto-flow" && view !== "auto-flow") stopAutoFlowFeed();
  if (["lead-finder", "lead-task-detail"].includes(activeView || "") && !["lead-finder", "lead-task-detail"].includes(view)) {
    stopLeadTaskEventStream(false);
  }
  if (view === "ai-agent" && activeView && activeView !== "ai-agent") agentOriginView = activeView;
  if (activeView === "memos" && view !== "memos" && memoDirty) void saveCurrentMemoDraft();
  if (view !== "leads") closeLeadDrawer();
  if (view !== "customers") closeCustomerDrawer();
  if (view !== "suppliers") closeSupplierDrawer();
  if (view !== "peers") closePeerDrawer();
  // 联系条同理：它代表「你刚刚点过的那一行」，换个页面就等于没点过 —— 回来时不许自己冒出来。
  if (view !== "customers") hideContactDock("customers");
  if (view !== "leads") hideContactDock("leads");
  if (view !== "customer-pool") hideContactDock("customer-pool");
  if (view !== "prospect-list" && prospectMobileDetailOpen) {
    prospectMobileDetailOpen = false;
    document.body.classList.remove("prospect-mobile-detail-open");
  }
  customerMapController?.setActive(view === "customers" && state.customerViewMode === "map");
  if (view !== "pipeline") closeDealDrawer();
  if (view !== "lead-finder") closeLeadFinderVerificationDrawer();
  rememberWorkspaceTab(view);
  sessionStorage.setItem(workspaceViewStorageKey(), view);
  qsa<HTMLElement>(".sidebar button[data-view]").forEach((button) => {
    const customerOutcome = button.dataset.customerOutcome;
    const supplierStatus = button.dataset.supplierStatus;
    const active = button.dataset.view === view
      && (view !== "customers" || customerOutcome === state.customerOutcomeFilter)
      && (view !== "suppliers" || (supplierStatus || "all") === state.supplierStatusFilter);
    button.classList.toggle("active", active);
  });
  // 自动发信 / 发信明细 / 邮箱设置 都归到「邮件中心」这一节下了（侧栏没有各自的入口），
  // 侧栏必须停在高亮「邮件中心」，否则用户会以为走丢到了别的模块
  if (view !== "mail-center" && MAIL_SECTION_ITEMS.some((item) => item.view === view)) {
    qsa<HTMLElement>('.sidebar button[data-view="mail-center"]').forEach((button) => button.classList.add("active"));
  }
  if (view === "business-card" || view === "website-verify") {
    qsa<HTMLElement>('.sidebar button[data-view="tools"]').forEach((button) => button.classList.add("active"));
  }
  openSecondaryDropdownForView(view);
  qsa<HTMLElement>(".view").forEach((node) => node.classList.toggle("active", node.id === view));
  renderMailSectionNav();
  const legacyWorkspace = qs<HTMLElement>("main.main > .workspace");
  if (legacyWorkspace) legacyWorkspace.hidden = !legacyWorkspace.querySelector(":scope > .view.active");
  document.body.classList.toggle("is-whatsapp-view", view === "whatsapp");
  syncLeadTaskDetailClock(view === "lead-task-detail");
  syncWhatsAppRefresh(false);
  renderTopbarForView(view);
  if (view === "customers") {
    renderCustomers(state.customers);
  }
  if (view === "suppliers") {
    // 先渲染（可能已有缓存），再按需拉一次；失败必须给出口，否则页面停在「加载中…」
    renderSuppliers();
    void loadSuppliers()
      .then(() => renderSuppliers())
      .catch((error) => toast(error instanceof Error ? error.message : "供应商加载失败", "error"));
  }
  if (view === "peers") {
    renderPeers();
  }
  if (view === "reports") {
    void refreshExecutiveReport();
  }
  if (view === "leaderboard") {
    renderLeaderboardPage();
  }
  if (view === "daily-reports") {
    void refreshDailyReports(false);
    void loadLogs().then(() => renderDailyAuto()).catch(() => renderDailyAuto());
  }
  if (view === "settings") {
    void loadTeamSystemSettings().catch((error) => toast(error instanceof Error ? error.message : "系统设置加载失败", "error"));
    void loadTrialAccounts().catch(() => undefined);
  }
  if (view === "inbox") {
    void refreshInternalMessages(false);
  }
  if (view === "integration-center") {
    void integrationCenterController?.refresh(false);
  }
  if (view === "exchange") {
    void loadExchangeData();
  }
  if (view === "dashboard") requestDashboardRefresh();
  if (view === "file-center") void loadFileCenter();
  if (view === "todo") {
    if (state.summary) renderTodoInsights(state.summary);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
  }
  if (view === "lead-finder") {
    void loadIdentityConflicts(true);
    void loadLeadProviders();
    void loadProspectRuns(true);
    syncLeadFinderLiveTransport(view);
  }
  if (view === "customer-pool") {
    renderCustomerPool();
    void reloadCustomerScopes().catch((error) => toast(error instanceof Error ? error.message : "客户公池加载失败", "error"));
  }
  if (view === "deal-archive") {
    void refreshDealArchive().catch((error) => toast(error instanceof Error ? error.message : "归档商机加载失败", "error"));
  }
  if (view === "sales-distillation") {
    void loadSalesDistillationWorkspace();
  }
  if (view === "maintenance-center") {
    void loadMaintenanceCenter();
  }
  if (view === "outreach-batches") {
    bindOutreachPlanCreateButton();
    void loadOutreachBatches();
    void loadOutreachPlans();
  }
  if (view === "outreach-journey") {
    bindOutreachJourneyToolbar();
    renderOutreachJourneyPage();
    if (!outreachJourneyOverview) void loadOutreachJourneyOverview();
  }
  if (view === "outreach-customer-journey") {
    renderOutreachCustomerJourneyPage();
  }
  if (view === "mail-center") {
    void loadMailCenter({ silent: true });
  }
  if (view === "mail-settings") {
    // 字段还是 profile* 那一套（保存逻辑不分叉），只是把面板搬到了邮件中心下面；
    // 进来时重新灌一次最新资料 + 拉邮箱池与追踪配置，免得显示登录时的旧值
    renderProfile(state.user);
    void loadSenderMailboxes();
    void loadEmailTrackingConfig();
  }
  if (view === "sales-skill-center") {
    void loadSalesSkillCenter();
  }
  if (view === "kb-training") {
    // 静默加载：进入视图不弹提示（导航一次点击可能触发两次 activateNavView，弹两条一样的 toast 是噪音）。
    void loadKbTraining({ silent: true });
  }
  if (view === "products") {
    renderProducts();
  }
  if (view === "shipments") {
    renderShipments();
    void syncAllShipments();
  }
  if (view === "orders") {
    ordWireList();
    void loadOrders();
  }
  if (view === "global-map") {
    renderGlobalMap();
    void syncGlobalRouteDocuments();
    void syncAllShipments();
  }
  if (view === "relation-graph") {
    renderRelationGraph();
  }
  if (view === "kpi-board") {
    renderKpiBoard();
  }
  if (view === "logs") {
    void loadLogs();
  }
  if (view === "theme") {
    renderThemeView();
  }
  if (view === "container-load") {
    renderContainerLoad();
  }
  if (view === "ai-agent") {
    renderAgent(state.agentRun);
    void loadAgentMemories(false);
    void loadAgentKnowledge(false);
    void loadAgentTriggers(false);
    void loadAgentGovernance(false);
    void loadAgentRuns();
  }
  if (view === "agent-skills") {
    void loadAgentSkills();
  }
  if (view === "database-maintenance") {
    void refreshDatabaseMaintenance();
  }
  if (isAccessControlView(view)) {
    void loadAccessControl();
  }
  if (view === "platform-operations") {
    void refreshPlatformOperations();
  }
  if (view === "approval-center") {
    void refreshApprovalCenter();
  }
  if (view === "approval-workflows") {
    void refreshApprovalWorkflows();
  }
  if (view === "whatsapp") {
    void ensureInstantCommunicationLoaded();
  }
  if (view === "email-return-flow") {
    void renderEmailReturnFlow();
  }
  if (view === "auto-flow") {
    renderAutoFlow();
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
  after?.();
}

void loadProductConfig();
// 首屏即落地主题：登录前也按默认/本地偏好渲染（默认晨白 Paper），
// 避免登录页停留在 :root 内置配色、登录后才跳变。
applyTheme(getInitialTheme());
installEvents();
renderTopbarForView(qs<HTMLElement>(".view.active")?.id || "dashboard");
void restoreSession()
  .catch(() => {})
  .finally(() => {
    // 未登录（需要展示登录页）时，静默内嵌默认账号密码
    if (!document.body.classList.contains("is-authenticated")) prefillLoginCredentials();
  });

// 页面加载后初始化更新模块
void initSystemUpdate();
