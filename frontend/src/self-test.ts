import { readdirSync, readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { resolveLeadAiSearchDraft } from "./lead-ai-search.js";
import {
  isLeadSourceAutoSelected,
  isLeadSourceExecutable,
  resolveLeadSearchSources
} from "./lead-source-selection.js";

// 后端 server.ts 已拆分为 server.ts（入口）+ server-core.ts（共享内核）+ routes/*.ts（各业务路由）；
// 前后端对齐检查读取全部后端 HTTP 源码。后端目录不存在时抛错，由各调用点的 try/catch 跳过。
function readBackendServerSources() {
  const backendSrc = new URL("../../backend/src/", import.meta.url);
  const routeFiles = readdirSync(new URL("routes/", backendSrc)).filter((name) => name.endsWith(".ts")).sort();
  return ["server.ts", "server-core.ts", ...routeFiles.map((name) => `routes/${name}`)]
    .map((file) => readFileSync(new URL(file, backendSrc), "utf8"))
    .join("\n");
}
const prototype = readFileSync(new URL("../index.html", import.meta.url), "utf8");
// prototype-api.ts 已拆分为入口 + modules/*.ts（函数逐字迁移），源码级断言读取入口与全部模块。
const apiLayer = [
  "./prototype-api.ts",
  ...readdirSync(new URL("./modules/", import.meta.url)).filter((name) => name.endsWith(".ts")).sort().map((name) => `./modules/${name}`)
].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
const prospectRadar = readFileSync(new URL("./prospect-radar.ts", import.meta.url), "utf8");
const integrationCenter = readFileSync(new URL("./integrations/integration-center.ts", import.meta.url), "utf8");
const productConfig = JSON.parse(readFileSync(new URL("../public/product-config.json", import.meta.url), "utf8")) as {
  productName?: string;
  version?: string;
};

const required = [
  "login-screen",
  "loginProductVersion",
  "previewCustomsButton",
  "customsPreviewPage",
  "customs-pack-preview-page",
  "customsDocumentValidation",
  "is-missing",
  "todo-board",
  "report-deck",
  "id=\"knowledge\"",
  "id=\"exam\"",
  "id=\"tools\"",
  "id=\"settings\"",
  "id=\"database-maintenance\"",
  "data-view=\"database-maintenance\"",
  "MYSQL_LOCAL_BACKUP_ENABLED=true",
  "/api/system/database-maintenance/status",
  "/api/system/database-backups/jobs",
  "databaseStreamLog",
  "databaseTableProgressMeta",
  "暂停滚动",
  "下载日志",
  "prototype-api.ts",
  "/api/auth/login",
  "/api/dashboard/summary",
  "DASHBOARD_LIVE_REFRESH_MS",
  "EXCHANGE_RATE_REFRESH_MS",
  "refreshVisibleDashboard",
  "requestDashboardRefresh",
  "/api/exchange-rates/today",
  "dashboardExchangeTicker",
  "dashboardCurrentDate",
  "仅提供最近一个交易日",
  "/api/knowledge/assets",
  "/api/exams",
  "/api/tools/ocr/jobs/current/image",
  "}/recognize-image",
  "}/sync-lead",
  "ocrFileInput",
  "/api/lead-finder/providers",
  "/api/lead-finder/launch",
  "/api/lead-finder/source-config",
  "retryAfterAt",
  "后可重试",
  "errorCode",
  "可稍后重试",
  "incrementalStats",
  "净新增 / 命中",
  "历史未变化",
  "已结束",
  "事实事件同步",
  "lead-job-source-list",
  "搜客任务失败",
  "加入搜客清单失败",
  "/conversion-preview",
  "转为客户",
  "createDeal",
  "pipelineAmount",
  "/api/leads?trash=true",
  "sourceEvents",
  "leadPermanentConfirmInput",
  "data-problem-delete",
  "deleteSelectedProblem",
  "problemSearchInput",
  "problemStatusFilter",
  "problemSeverityFilter",
  "problemCategoryFilter",
  "data-problem-edit",
  "data-problem-open",
  "problemDrawer",
  "resolvedAt",
  "problem-solution-highlight",
  "problem-solution-field",
  "closeOnBackdrop: false",
  "prospectEnrichContactsButton",
  "No qualification review is required first",
  "leadSourceCenterButton",
  "leadSourceChips",
  "openLeadSourceCenter",
  "data-ls-import",
  "返回并导入链接",
  "leadFinderDetailSaveButton",
  "leadFinderDetailShortlistButton",
  "leadFinderLookupDiagnosis",
  "查看原因详情",
  "本次未找到候选的原因",
  "advanced-excel-types",
  "is-current",
  "stageCurrency",
  "来源证据",
  "sourceEvidence",
  "ai_search",
  "data-view=\"commission\"",
  "id=\"commission\"",
  "commissionSyncDealsButton",
  "commissionRecalculateButton",
  "/api/commission/products",
  "/api/commission/sales-records",
  "/api/commission/calculations/recalculate",
  "renderCommission",
  "notificationBellButton",
  "notificationBellBadge",
  "消息通知",
  "navigateFromInternalMessage",
  "查看日报",
  "quoteHistoryViewButton",
  "quoteHistoryWorkspace",
  "quoteHistoryProduct",
  "quoteHistoryCountry",
  "quoteHistoryProductModeButton",
  "quoteHistoryProductRows",
  "quoteHistoryProductOverview",
  "productAnalysis",
  "openQuoteHistoryForDeal",
  "查看报价变化",
  "/api/quote-history",
  "agentPendingGoal",
  "agentPendingProgress",
  "/api/agent/plan/stream",
  "正在理解你的目标和当前业务上下文",
  "agent-live-execution",
  "agent-action-chain",
  "可审计动作链",
  "最近执行记录",
  "agentFailureDiagnosis",
  "data-view=\"integration-center\"",
  "aria-label=\"权限管理\"",
  "data-admin-only",
  "id=\"integration-center\"",
  "data-integration-tab=\"catalog\"",
  "data-integration-tab=\"mail-calendar\"",
  "data-integration-tab=\"connected\"",
  "data-integration-tab=\"permissions\"",
  "data-integration-tab=\"approvals\"",
  "data-integration-tab=\"activity\"",
  "installIntegrationCenterInteractions",
  "integrationPrototypeConnect",
  "entry.type === \"assistant\"",
  "data-agent-chat-approve",
  "确认写入",
  "agentKnowledgeStatus",
  "/api/agent/knowledge/overview",
  "/api/agent/knowledge/search",
  "Agent 学习中心",
  "leadSuperWebSearch",
  "leadSuperMapSearch",
  "leadSuperAiDiscovery",
  "webSearchMode: superWebSearchMode()",
  "mapSearchMode: superMapSearchMode()",
  "aiDiscoveryMode: superAiDiscoveryMode()",
  "google_places",
  "leadTaskCandidates",
  "leadTaskSyncCandidates",
  "纳入候选池",
  "可加入搜客清单的候选",
  "leadFinderLiveOverview",
  "leadFinderCleaningRows",
  "最近一次执行",
  "最多展示 100 条管线处置记录",
  "来源解析阶段的数据无效与页内重复仅提供汇总",
  "record.sourceRecordId",
  "record.sourceCompany",
  "record.sourceDomain",
  "data-prospect-date-filter=\"today\"",
  "prospectJoinedFrom",
  "prospectSortSelect",
  "加入搜客清单时间",
  "prospect-mobile-detail-open",
  "prospectRadarDialog",
  "data-lead-live-radar",
  "buildProspectRadarModel",
  "buildProspectPoolRadarModel",
  "data-lead-pool-radar",
  "关系连线仅来自已记录证据"
];

assert.match(apiLayer, /"email-return-flow": "开发信回流"/u, "开发信回流工作区标签必须使用中文名称");
assert.match(apiLayer, /if \(!logs\.length\) \{\s*list\.innerHTML = `<div class="erf-empty">/u, "空回流状态渲染单个静态空态并提前返回，不再滚动提示");
assert.match(apiLayer, /const captureHeight = Math\.max\(capture\.scrollHeight/u, "PDF 导出必须捕获完整预览高度");
assert.match(apiLayer, /const captureWidth = 794[\s\S]*captureHost = document\.createElement\("div"\)/u, "PDF 导出必须使用独立的 A4 宽度画布");
assert.match(apiLayer, /height: captureHeight/u, "PDF 导出必须把完整预览高度传给截图引擎");
assert.match(apiLayer, /capture\.style[\s\S]*maxWidth: "none"[\s\S]*margin: "0"/u, "PDF 导出画布不得继承屏幕预览的居中偏移");
assert.match(prototype, /\.print-only-document\.doc-paper \{[\s\S]*max-height: none !important;[\s\S]*overflow: visible !important;/u, "打印降级不能裁切多页单据");

for (const token of required) {
  if (!prototype.includes(token) && !apiLayer.includes(token)) throw new Error(`missing ${token}`);
}

assert.equal(prototype.includes("data-view=\"inbox\""), false, "消息通知不应出现在左侧导航");
assert.equal(prototype.includes("写站内信"), false, "通知中心不应提供人工写信入口");
assert.equal(apiLayer.includes("openInternalMessageComposeModal"), false, "不应保留旧写信交互");
const systemNavigation = prototype.slice(
  prototype.indexOf('<details class="nav-section" aria-label="系统配置">'),
  prototype.indexOf("</nav>")
);
assert.equal(systemNavigation.includes('data-view="member-management"'), false, "权限模块不得继续混在系统配置导航中");
assert.match(prototype, /aria-label="权限管理"[\s\S]*data-view="member-management"[\s\S]*data-view="permission-audit"/, "权限页面必须集中在独立权限管理分组");
assert.match(apiLayer, /isAccessControlView\(view\) && !isSystemAdministrator\(user\)/, "权限页面必须额外校验管理员或超级管理员身份");
assert.match(apiLayer, /function isPlatformOperator[\s\S]*user\.role === "super_admin"/, "超级管理员必须被识别为平台运维身份");
assert.match(apiLayer, /if \(isPlatformOperator\(user\)\) \{[\s\S]*return view === "platform-operations"/, "平台运维账号只能进入运维中心");
assert.match(apiLayer, /view = platformOperator \? "platform-operations" : "dashboard"/, "平台运维账号非法跳转时必须返回运维中心");
assert.match(prototype, /运维专用账号[\s\S]*业务模块，请登录其他账号/, "运维中心必须明确提示业务模块使用其他账号");
assert.match(apiLayer, /if \(isPlatformOperator\(\)\) \{[\s\S]*openWorkspaceTabs = \["platform-operations"\][\s\S]*wrap\.innerHTML = ""/, "超级管理员顶部不得残留工作台标签");
assert.match(prototype, /body\.platform-mode #topOpenTabs,[\s\S]*body\.platform-mode \.top-status,[\s\S]*body\.platform-mode #notificationBellButton/, "运维模式必须隐藏业务工作台状态栏");
assert.match(apiLayer, /node\.hidden = !isSystemAdministrator\(user\)/, "权限管理导航只按管理员身份显示");
assert.match(apiLayer, /class="ac-workbench ac-role-layout"[\s\S]*class="ac-role-list"[\s\S]*class="ac-permission-table"/, "角色管理必须使用角色目录与当前角色权限双栏结构");
assert.match(apiLayer, /class="ac-role-checks" id="iamMemberRoleIds"[\s\S]*type="checkbox"/, "成员授权必须使用清晰的角色复选项，不能退回原生多选框");
assert.match(apiLayer, /data-ac-guide aria-label="权限使用说明"/, "权限模块必须提供独立的使用说明入口");
assert.match(apiLayer, /仅超级管理员和管理员可以设置[\s\S]*建立组织架构[\s\S]*创建角色并配置权限[\s\S]*给成员分配角色[\s\S]*通过审计复核/, "权限使用说明必须覆盖访问限制与完整配置顺序");
assert.match(apiLayer, /function bindAccessControlInteractions[\s\S]*const root = activeAccessControlRoot\(\)[\s\S]*root\.querySelector<T>/, "权限页面交互必须绑定在当前页面，不能误绑到隐藏的成员管理页面");
assert.doesNotMatch(apiLayer, /class="ac-metrics"|class="ac-loading-metrics"/, "权限页面和加载态都不得继续显示顶部五项统计条");
const systemSettingsView = prototype.slice(
  prototype.indexOf('<div class="view" id="settings"'),
  prototype.indexOf('<section class="view" id="products">')
);
assert.match(systemSettingsView, /<h1>系统设置<\/h1>/, "系统设置页面必须使用正确标题");
assert.doesNotMatch(systemSettingsView, /账号列表|新增账号|权限模板|角色权限/, "人员与权限配置不得在系统设置中重复出现");
assert.match(systemSettingsView, /公司资料[\s\S]*单据设置[\s\S]*系统更新/, "系统设置必须保留公司资料、单据设置与系统更新");
assert.equal(apiLayer.includes("leadFinderDetailMarkButton"), false, "自动获客不应保留标记可联系的授权语义");
assert.match(apiLayer, /function prospectLookupDiagnosis[\s\S]*This does not mean the company is inactive/, "联系人缺失必须提供业务可理解的原因说明");
assert.match(apiLayer, /data-lead-lookup-reason/, "联系人和联系方式未找到状态必须可以点击查看原因");
assert.match(apiLayer, /function leadFinderNoResultReasons[\s\S]*清洗规则/, "整次搜索无结果时必须汇总来源和清洗原因");
assert.match(
  apiLayer,
  /async function openAdvancedExcelPanel\(\)[\s\S]*const editorType = currentDocumentType\(\)[\s\S]*if \(current\.type !== editorType\)[\s\S]*await saveTradeDocument\(\)[\s\S]*type === current\.type \? "is-current"/,
  "高级 Excel 必须先同步当前编辑器单据类型，并高亮当前类型模板"
);
const standardRunStatusContract = apiLayer.slice(
  apiLayer.indexOf("function prospectRunStatusLabel"),
  apiLayer.indexOf("function prospectRunActivityLabel")
);
for (const status of ["cancelled", "succeeded", "succeeded_empty", "partial_success", "failed"]) {
  assert.match(
    standardRunStatusContract,
    new RegExp(`${status}: \\"已结束\\"`),
    `标准搜客终态 ${status} 的任务卡必须统一显示已结束`
  );
}
const superSearchStatusContract = apiLayer.slice(
  apiLayer.indexOf("function superSearchStatusLabel"),
  apiLayer.indexOf("function superSearchThemeLabel")
);
for (const status of ["cancelled", "succeeded", "partial_success", "failed"]) {
  assert.match(
    superSearchStatusContract,
    new RegExp(`${status}: \\"已结束\\"`),
    `超级搜客终态 ${status} 的任务卡必须统一显示已结束`
  );
}
assert.match(apiLayer, /来源返回 \/ 候选池 \/ 待审核 \/ 审核通过/, "标准和超级搜客详情必须展示统一四段漏斗");
assert.match(apiLayer, /partial_success: "部分成功"/, "部分成功只能保留在任务详情验收结论中");
assert.match(apiLayer, /failed: "失败"/, "失败只能保留在任务详情验收结论中");
assert.equal(apiLayer.includes("部分完成"), false, "任务与来源状态不得使用容易误解的“部分完成”提示");
assert.match(apiLayer, /function localDateInputBoundary[\s\S]*new Date\(Number\(match\[1\]\), Number\(match\[2\]\) - 1, Number\(match\[3\]\)\)/, "加入时间必须按本地日期构造，不能把日期输入误解析为 UTC");
assert.match(apiLayer, /localDateInputBoundary\(state\.prospectJoinedTo, 1\)/, "自定义结束日期必须使用次日零点作为排他边界");
assert.match(apiLayer, /function syncLeadFinderLiveTransport[\s\S]*startLeadTaskEventStream/, "自动搜客主界面与详情必须共用实时任务传输入口");
assert.match(
  apiLayer,
  /function scheduleLeadTaskEventRefresh[\s\S]*leadFinderOpportunityRefreshPending = true[\s\S]*const refreshOpportunities = leadFinderOpportunityRefreshPending[\s\S]*if \(refreshOpportunities\) await refreshLeadFinderOpportunities\(\)/,
  "候选事件被合并时仍必须触发候选池和地图实时刷新"
);
assert.match(
  apiLayer,
  /function scheduleLeadTaskEventRefresh[\s\S]*event\.type === "candidate\.persisted"[\s\S]*job\.resultIds = \[\.\.\.new Set/,
  "候选落库事件必须立即并入当前任务，不能等待下一轮任务轮询"
);
assert.match(
  apiLayer,
  /async function refreshLeadFinderOpportunities[\s\S]*renderLeadFinderJobs\(\)[\s\S]*renderLeadTaskDetail\(\)/,
  "候选池刷新后必须重绘实时任务区和已打开的任务详情"
);
assert.match(apiLayer, /function leadFinderSourceWaitText[\s\S]*AI 模型正在生成候选/, "AI 来源等待时必须显示真实等待原因");
assert.match(apiLayer, /已有 \$\{candidateCount\} 个候选先展示/, "已有候选不得被未结束的来源阻塞展示");
assert.match(
  apiLayer,
  /\["running", "done", "partial", "failed"\]\.includes\(job\.status\)[\s\S]*Boolean\(job\.resultIds\?\.length\)[\s\S]*refreshLeadFinderOpportunities\(\)/,
  "运行中的搜客任务也必须刷新候选池，不能只在任务结束后刷新"
);
assert.match(apiLayer, /function applySuperSearchMission[\s\S]*const rounds = Array\.isArray\(mission\.rounds\)/, "超级搜索首屏缺少轮次快照时不能因 undefined 崩溃");
assert.match(apiLayer, /if \(result\.superSearch\) \{[\s\S]*applySuperSearchMission\(backendJob, result\.superSearch\)[\s\S]*超级搜索已进入队列，详细轮次正在同步/, "超级搜索快照增强失败时任务也必须先显示在队列");
assert.equal(apiLayer.includes("parseGoalToBrief"), false, "AI 解析失败后不得使用本地规则伪装成成功结果");
assert.match(apiLayer, /async function runLeadAiParse\(\): Promise<boolean>[\s\S]*catch \(err\)[\s\S]*clearLeadAiPreview\(true\)[\s\S]*未生成解析结果[\s\S]*return false;/, "AI 解析失败必须清空预览、明确报错并返回失败");
const leadFinderLaunchFlow = apiLayer.slice(
  apiLayer.indexOf("async function runLeadFinder"),
  apiLayer.indexOf("async function shortlistLeadFinderRows")
);
assert.ok(
  leadFinderLaunchFlow.indexOf("const parsed = await runLeadAiParse()") < leadFinderLaunchFlow.indexOf("launchProspectRunFromLeadFinder"),
  "直接输入自然语言后搜索时必须先完成 AI 解析，再创建搜索任务"
);
assert.match(leadFinderLaunchFlow, /const parsed = await runLeadAiParse\(\);[\s\S]*if \(!parsed\) return;/, "AI 解析失败时不得继续启动搜索");
const parsedLeadFinderInputFlow = apiLayer.slice(
  apiLayer.indexOf("async function launchProspectRunFromLeadFinder"),
  apiLayer.indexOf("async function runLeadFinder")
);
for (const selector of ["#leadAiProducts", "#leadAiMarkets", "#leadAiIndustries", "#leadAiExclusions", "#leadAiCustomerType", "#leadAiName"]) {
  assert.ok(parsedLeadFinderInputFlow.includes(selector), `启动搜索必须读取用户修改后的解析字段 ${selector}`);
}
assert.match(parsedLeadFinderInputFlow, /const resolved = resolveLeadAiSearchDraft\(/, "启动搜索必须通过无降级的解析结果校验器读取预览字段");
assert.equal(parsedLeadFinderInputFlow.includes("products = [goalInput]"), false, "启动搜索不得偷偷回退为原始中文句子");
assert.match(parsedLeadFinderInputFlow, /parsedName = resolved\.parsedName;[\s\S]*goalInput = "";/, "解析成功后原始自然语言不得继续作为隐藏搜索约束");
assert.match(parsedLeadFinderInputFlow, /const goal = \[[\s\S]*Products:[\s\S]*Markets:[\s\S]*Industries:[\s\S]*Customer type:[\s\S]*Exclusions:/, "活动搜索目标必须由当前解析预览字段重新生成");
assert.equal(parsedLeadFinderInputFlow.includes("icpRules: goalInput"), false, "修改解析结果后不得继续写入旧自然语言 ICP 规则");
assert.match(parsedLeadFinderInputFlow, /\/api\/lead-finder\/launch/, "自动搜客必须通过单次聚合请求创建并启动任务");
for (const legacyPath of ["/api/prospect-campaigns", "/api/prospect-strategies/"]) {
  assert.equal(parsedLeadFinderInputFlow.includes(legacyPath), false, `自动搜客启动不得继续串行调用 ${legacyPath}`);
}
assert.match(leadFinderLaunchFlow, /正在解析搜索目标[\s\S]*搜索已进入队列/, "创建按钮必须反馈真实的解析和入队阶段");
assert.match(
  leadFinderLaunchFlow,
  /if \(!sources\.length\) \{[\s\S]*超级搜索当前没有可执行的数据源/,
  "超级搜索来源二次过滤为空时必须在创建任务前阻断"
);
assert.match(parsedLeadFinderInputFlow, /onStage\?\.\("正在提交策略并启动搜索"\)/, "聚合启动请求必须反馈正在提交策略的真实阶段");
assert.deepEqual(resolveLeadAiSearchDraft({
  name: "Edited Mexico Filling Equipment",
  products: ["edited liquid filling machines"],
  markets: ["Mexico"],
  industries: ["coatings manufacturing"],
  exclusions: ["trading companies"],
  customerType: "终端工厂"
}), {
  parsedName: "Edited Mexico Filling Equipment",
  products: ["edited liquid filling machines"],
  markets: ["Mexico"],
  industries: ["coatings manufacturing"],
  exclusions: ["trading companies"],
  customerType: "终端工厂",
  marketOpen: false
}, "启动搜索必须完整采用用户修改后的 AI 解析字段");
assert.throws(() => resolveLeadAiSearchDraft({
  name: "",
  products: [],
  markets: ["China"],
  industries: [],
  exclusions: [],
  customerType: "*"
}), /产品关键词不能为空/, "修改后的必填搜索词为空时必须停止，不能降级");
assert.match(apiLayer, /const relations: ProspectRadarRelation\[\] = \(job\.deepMining\?\.edges \|\| \[\]\)\.map/, "演示模式关系线必须只读取深挖关系证据");
assert.match(apiLayer, /function syncProspectRadar[\s\S]*prospectRadarController\.update\(model\)/, "运行中的演示模式必须跟随真实任务事件增量更新");
assert.match(apiLayer, /id: "pool:ready"[\s\S]*等待首个候选/, "候选池为空时仍必须保留可打开的雷达待命帧");
assert.match(apiLayer, /data-lead-pool-radar[\s\S]*打开全球雷达/, "没有任务和候选时仍必须显示全球雷达入口");
assert.match(prospectRadar, /\.arcsData\(relationRows\)/, "3D 地球只能渲染模型提供的真实关系数据");
assert.match(prospectRadar, /\.htmlElementsData\(focusedPoint \? \[focusedPoint\] : \[\]\)/, "公司名称必须使用浏览器原生文字层以完整支持中文");
assert.match(prospectRadar, /function companyMarker[\s\S]*company\.textContent = item\.company/, "中文公司名称必须通过 textContent 安全渲染");
assert.equal(prospectRadar.includes(".labelText("), false, "公司名称不能继续使用缺少中文字形的 3D 纹理文字");
assert.match(prospectRadar, /function createCaptureFeed[\s\S]*role\", \"log\"[\s\S]*aria-live\", \"polite\"/, "回放必须提供可访问的实时企业捕获流");
assert.match(prospectRadar, /frame\.kind === \"candidate\" && focusedPoint[\s\S]*captureFeed\.addCandidate/, "捕获流只能从真实候选事件追加企业");
assert.match(prospectRadar, /function captureMilestone[\s\S]*count === 5[\s\S]*count === 10[\s\S]*count === 20/, "捕获流必须按真实企业数量插入阶段反馈");
assert.match(prospectRadar, /replay\(\)[\s\S]*captureFeed\.reset\(\)/, "重播必须清空旧捕获流后重新按事件打印");
assert.match(prototype, /\.prospect-radar-capture-list[\s\S]*mask-image: linear-gradient/, "捕获流顶部和底部必须渐隐，避免旧结果硬切消失");
assert.match(prospectRadar, /prefers-reduced-motion: reduce/, "演示模式必须支持低动态偏好");
assert.match(prospectRadar, /destroy\(\)[\s\S]*resizeObserver\.disconnect\(\)[\s\S]*globe\._destructor\(\)/, "关闭演示必须完整释放 WebGL 和尺寸监听器");
assert.match(apiLayer, /\["merged", "suppressed", "rejected"\]\.includes\(record\.outcome\)/, "清洗去除视图只能显示真实的归并、抑制与拒绝记录");
assert.match(apiLayer, /function leadFinderRemovedTotal[\s\S]*providerInvalidCount[\s\S]*providerDuplicateCount[\s\S]*rejectedCount[\s\S]*suppressedCount[\s\S]*mergedCount/, "清洗去除总数必须覆盖来源预处理与候选管线的全部分流结果");
assert.match(apiLayer, /data-lead-open-cleaning[\s\S]*leadFinderResultView = "cleaning"/, "候选结果必须提供可直达处理原因的入口");
assert.match(apiLayer, /PROVIDER_INVALID_RECORD[\s\S]*PROVIDER_DUPLICATE_RECORD[\s\S]*未保存无效或重复记录的公司名称/, "来源预处理原因必须如实按数量汇总，不能伪造公司名称");
assert.match(apiLayer, /source\.outcome === "timed_out"[\s\S]*Timed out/, "联系人来源超时必须在搜客清单明确显示");
assert.match(apiLayer, /Next step: \$\{escapeHtml\(source\.suggestion\)\}/, "联系人来源失败或未配置时必须展示调整建议");
assert.match(apiLayer, /waitedMs >= 130_000[\s\S]*响应超时[\s\S]*调整建议/, "自动搜索长时间无返回时必须展示超时原因和调整建议");
assert.match(prototype, /data-view="settings" data-scope="manager"/, "业务员导航中必须隐藏系统设置");
assert.match(prototype, /id="settings" data-scope="manager"/, "业务员视图中必须隐藏系统设置页面");
assert.match(prototype, /data-view="database-maintenance" data-scope="admin"/, "数据库维护导航必须只向管理员显示");
assert.match(prototype, /id="database-maintenance" data-scope="admin"/, "数据库维护必须使用独立页面");
assert.equal(prototype.includes("id=\"mysqlImportPanel\""), false, "数据库迁移不能继续嵌在账号管理页");
assert.match(apiLayer, /"database-maintenance": "database\.maintain"/, "数据库维护页面必须绑定数据库维护能力");
assert.match(apiLayer, /"member-management": "member\.read"/, "成员管理页面必须绑定成员查看能力");
assert.match(apiLayer, /"role-management": "role\.read"/, "角色管理页面必须绑定角色查看能力");
assert.match(apiLayer, /"ui-access": "role\.read"/, "界面开通页面必须绑定角色查看能力");
assert.match(prototype, /data-view="ui-access" title="界面开通"/, "权限管理导航必须提供界面开通入口");
assert.match(prototype, /id="ui-access" data-scope="admin" data-iam-page="ui"/, "界面开通必须使用独立权限页面");
assert.match(apiLayer, /interface AccessControlUiModule[\s\S]*edition: string/, "界面开通必须把界面模块和版本说明结构化");
assert.match(apiLayer, /function renderAccessControlUiAccess[\s\S]*界面会按角色权限自动出现[\s\S]*data-ac-module-enable[\s\S]*data-ac-module-disable/, "界面开通必须支持按角色查看并开通或关闭模块");
assert.match(apiLayer, /function mutateAccessControlModule/, "界面模块开通必须有独立的批量发布函数");
assert.match(apiLayer, /\/api\/v1\/roles\/\$\{encodeURIComponent\(role\.id\)\}\/permissions/, "界面模块开通必须复用角色权限发布接口");
assert.match(apiLayer, /开通界面模块：\$\{module\.name\}/, "界面模块开通必须留下审计原因");
assert.match(apiLayer, /introducedVersion\?: string/, "权限项必须携带引入版本，方便按界面版本解释权限");
assert.match(apiLayer, /连接中断，正在重连/, "数据库任务断流必须进入重连状态而非误报失败");
assert.match(apiLayer, /if \(!canAccessWorkspaceView\(view\)\) \{[\s\S]*view = platformOperator \? "platform-operations" : "dashboard";/, "页面切换必须阻止越权访问，并按账号身份回到正确首页");
assert.match(apiLayer, /workspaceView: "gj_workspace_view"/, "工作区必须记录当前活动模块，避免刷新后退回主页");
assert.match(apiLayer, /sessionStorage\.setItem\(workspaceViewStorageKey\(\), view\)/, "导航切换必须按当前账号记住活动模块");
assert.match(apiLayer, /restoreSession\(\)[\s\S]*activateNavView\(state\.iamCapabilities\?\.source === "platform" \? "platform-operations" : rememberedWorkspaceView\(user\)\)/, "会话恢复后必须按身份回到刷新前的模块");
assert.match(apiLayer, /selectedDailyReportId = message\.relatedId;[\s\S]*activateNavView\("daily-reports"\)/);
assert.match(apiLayer, /if \(view === "ai-agent"\) \{[\s\S]*renderAgent\(state\.agentRun\);[\s\S]*void loadAgentRuns\(\);[\s\S]*\}/, "进入 Agent 页面必须刷新蒸馏打法与后台任务状态");
assert.match(apiLayer, /void loadAgentKnowledge\(false\)/, "进入 Agent 页面必须加载系统知识状态");
assert.match(prototype, /\.agent-chat-bubble,[\s\S]*\.agent-chat-answer > p[\s\S]*user-select: text;/, "Agent 对话正文必须允许选择复制");
assert.match(apiLayer, /copyableText \|\| window\.getSelection\(\)\?\.toString\(\)\.trim\(\)/, "选择 Agent 对话文字时不得触发整轮重新渲染");
assert.match(apiLayer, /agentPendingProgress\.push\(progress\)/, "Agent 规划流必须保留同阶段的细粒度动作，不能互相覆盖");
assert.match(apiLayer, /权限校验未通过：[\s\S]*接口参数或契约校验失败：[\s\S]*网络或上游服务调用失败：/, "Agent 失败链必须给出可读诊断");
assert.equal(productConfig.productName, "GoodJob CRM");
assert.match(productConfig.version || "", /^\d+\.\d+(?:\.\d+)?$/);

assert.equal(isLeadSourceExecutable({ id: "ready", ready: true, enabled: true, accessMode: "api" }), true);
assert.equal(isLeadSourceExecutable({ id: "disabled", ready: true, enabled: false, accessMode: "api" }), false);
assert.equal(isLeadSourceExecutable({ id: "manual", ready: true, enabled: true, accessMode: "manual_assisted" }), false);
assert.equal(
  isLeadSourceAutoSelected({ id: "free", tier: "free", ready: true, enabled: true, accessMode: "api", recommended: true }),
  false
);
assert.equal(
  isLeadSourceAutoSelected({ id: "byok-free", tier: "byok_free", ready: true, enabled: true, accessMode: "api", recommended: true }),
  false
);
assert.equal(
  isLeadSourceAutoSelected({ id: "serper", tier: "byok_free", category: "web", capabilities: ["web"], hasApiKey: true, ready: true, enabled: true, accessMode: "api" }),
  true,
  "已配置的搜索 API 必须自动进入默认来源，不能被 AI 搜索绑架"
);
assert.equal(
  isLeadSourceAutoSelected({ id: "paid", tier: "paid", ready: true, enabled: true, accessMode: "api", recommended: true }),
  true
);
assert.deepEqual(
  resolveLeadSearchSources([
    { id: "ai_search", ready: true, enabled: true, accessMode: "api" },
    { id: "gleif", ready: true, enabled: true, accessMode: "api", recommended: true },
    { id: "wikidata", ready: true, enabled: false, accessMode: "api", recommended: true }
  ], [], false),
  { sources: ["ai_search", "gleif"], blocked: [], requiresSelection: false }
);
assert.deepEqual(
  resolveLeadSearchSources([
    { id: "free", tier: "free", ready: true, enabled: true, accessMode: "api", recommended: true },
    { id: "byok-free", tier: "byok_free", ready: true, enabled: true, accessMode: "api", recommended: true },
    { id: "serper", tier: "byok_free", category: "web", capabilities: ["web"], hasApiKey: true, ready: true, enabled: true, accessMode: "api", recommended: false },
    { id: "paid", tier: "paid", ready: true, enabled: true, accessMode: "api", recommended: true }
  ], [], false),
  { sources: ["serper", "paid"], blocked: [], requiresSelection: false }
);
assert.deepEqual(
  resolveLeadSearchSources([
    { id: "ai_search", ready: false, enabled: false, accessMode: "api" },
    { id: "gleif", ready: true, enabled: true, accessMode: "api", recommended: true }
  ], ["ai_search"], true),
  {
    sources: [],
    blocked: [{ id: "ai_search", reason: "not_ready" }],
    requiresSelection: false
  }
);
assert.deepEqual(
  resolveLeadSearchSources([
    { id: "serper", ready: true, enabled: false, accessMode: "api" },
    { id: "gleif", ready: true, enabled: true, accessMode: "api", recommended: true }
  ], ["serper"], true),
  {
    sources: [],
    blocked: [{ id: "serper", reason: "disabled" }],
    requiresSelection: false
  }
);
assert.deepEqual(
  resolveLeadSearchSources([{ id: "gleif", ready: true, enabled: true, accessMode: "api", recommended: true }], [], true),
  { sources: [], blocked: [], requiresSelection: true }
);
assert.deepEqual(
  resolveLeadSearchSources([
    { id: "importyeti", ready: true, enabled: true, accessMode: "manual_assisted" }
  ], ["importyeti"], true),
  {
    sources: [],
    blocked: [{ id: "importyeti", reason: "not_executable" }],
    requiresSelection: false
  }
);

if (!prototype.includes(".report-hero") || !prototype.includes(".ocr-workbench") || !prototype.includes(".account-grid")) {
  throw new Error("missing high fidelity prototype styles");
}

assert.equal(prototype.includes("collab-inbox-nav"), false, "message center must not remain in sidebar navigation");
assert.match(prototype, /class="lead-settings-summary"/, "来源与执行设置必须有醒目的标题样式");
assert.match(prototype, /免费源效果可能不佳，默认不勾选/, "来源设置必须提示免费源默认不勾选及质量风险");
assert.match(prototype, /lead-settings-summary::before/, "来源设置必须显示可展开的箭头 affordance");
assert.match(prototype, /content: "展开"/, "来源设置必须显示展开状态提示");
assert.match(apiLayer, /function renderLeadSourceChips[\s\S]*更多免费来源（效果可能不佳，默认不勾选）/, "免费来源必须集中展示并带质量提示");
assert.equal(prototype.includes("id=\"composeMessageButton\""), false, "notification center must not present direct-message composition as its primary workflow");
assert.match(apiLayer, /data-pending-hit-id/, "待清洗结果必须支持逐条选择");
assert.match(apiLayer, /selectedPendingHitIds/, "待清洗导入必须保留明确选择状态");
assert.match(apiLayer, /prospect-super-search\/\$\{encodeURIComponent\(job\.superSearchMissionId\)\}\/pending-candidates/, "超级搜索必须汇总全部轮次待清洗结果");
assert.match(apiLayer, /body: JSON\.stringify\(\{ hitIds \}\)/, "手动导入只能提交已选择的原始记录");
assert.equal(apiLayer.includes("lead-job-card is-openable"), false, "任务卡片不能整卡点击进入详情");
assert.equal(apiLayer.includes("同步本任务结果"), false, "任务结果操作必须使用明确的候选与线索语义");
assert.match(apiLayer, /data-lead-job-open[\s\S]*查看详情/, "只有查看详情按钮可以进入任务详情页");
const customerSectionIndex = prototype.indexOf('aria-label="客户管理"');
const customerOpenNavIndex = prototype.indexOf('data-view="customers" data-customer-outcome="open" title="未成交客户"');
const customerWonNavIndex = prototype.indexOf('data-view="customers" data-customer-outcome="won" title="已成交客户"');
const customerPoolNavIndex = prototype.indexOf('data-view="customer-pool" title="客户公池"');
assert.ok(customerSectionIndex >= 0 && customerSectionIndex < customerOpenNavIndex && customerOpenNavIndex < customerWonNavIndex && customerWonNavIndex < customerPoolNavIndex, "customers and customer pool must share one navigation group");
assert.match(prototype, /id="customerPageTitle">未成交客户/, "customer page must expose the default outcome context");
assert.match(apiLayer, /customerOutcomeFilter: "open" \| "won"/, "customer outcome filter must be explicit in app state");
assert.match(apiLayer, /state\.customerOutcomeFilter === "won" \? customer\.hasWonDeal === true : customer\.hasWonDeal !== true/, "customer navigation must filter won and open customers from real data");
assert.match(apiLayer, /if \(view === "customers"\) \{\s*renderCustomers\(state\.customers\);\s*\}/, "switching customer outcome navigation must redraw the shared customer page");
assert.match(apiLayer, /\["成交状态", "客户状态", "状态", "Lifecycle Status", "lifecycleStatus"\]/, "customer import must accept an explicit lifecycle status");
assert.match(apiLayer, /成交状态: customer\.hasWonDeal \? "已成交" : "未成交"/, "customer export must preserve lifecycle status");
assert.doesNotMatch(apiLayer, /由关联商机自动判断/, "customer status must not be described as a live deal-derived value");
assert.match(apiLayer, /customer\.wonDealCount \? `已成交 \$\{customer\.wonDealCount\} 次` : "已成交客户"/, "imported won customers without deals must not invent a transaction count");
assert.doesNotMatch(apiLayer, /wonDealCount \|\| 1/, "customer UI must not fabricate one won deal for imported customers");
assert.match(apiLayer, /class="deal-items-list" id="dealItemsList"/, "deal editor must support multiple product rows");
assert.match(apiLayer, /items\.reduce\(\(sum, item\) => sum \+ item\.quantity \* item\.unitPrice/, "deal amount must be calculated from all product rows");
assert.match(apiLayer, /items: documentItems/, "PI and CI generation must carry every deal product row");
assert.match(prototype, /id="instantCommunicationState"/, "即刻沟通必须有明确的服务加载状态");
assert.match(apiLayer, /function ensureInstantCommunicationLoaded/, "即刻沟通必须在进入页面时检查服务状态");
assert.match(apiLayer, /联系方式备注 \/ 其它渠道/, "客户表单必须支持登记其它渠道联系方式");
assert.match(apiLayer, /contactRemark/, "客户联系方式备注必须进入前端数据链路");
assert.match(apiLayer, /closeOnBackdrop: false/, "客户新增弹窗点击背景不能自动关闭");
assert.match(apiLayer, /let modalCloseOnBackdrop = false;/, "通用居中弹窗必须默认禁止点击背景关闭");
assert.match(apiLayer, /modalCloseOnBackdrop = options\.closeOnBackdrop \?\? false;/, "未显式配置时不得允许背景点击关闭弹窗");
assert.doesNotMatch(apiLayer, /#productModal[\s\S]{0,160}event\.target ===/, "产品编辑弹窗点击背景不得关闭");
assert.doesNotMatch(apiLayer, /#shipmentModal[\s\S]{0,160}event\.target ===/, "发货单编辑弹窗点击背景不得关闭");
assert.match(apiLayer, /联系方式备注（其它渠道）/, "客户导入导出必须包含联系方式备注列");
assert.match(apiLayer, /id="customerSourceInput"/, "客户新增编辑表单必须支持登记客户来源");
assert.match(apiLayer, /客户来源: customer\.source/, "客户导出必须包含客户来源");
assert.match(apiLayer, /\["客户来源", "来源", "获客渠道"/, "客户导入必须识别客户来源列及常用别名");
assert.match(prototype, /<th>客户来源<\/th>/, "客户列表必须使用客户来源替换健康度列");
assert.match(apiLayer, /<span>客户来源<\/span><b>\$\{escapeHtml\(current\.source/, "客户全景必须展示客户来源");
assert.match(apiLayer, /<span>客户来源<\/span><b>\$\{escapeHtml\(customer\.source/, "客户侧边详情必须展示客户来源");
assert.match(apiLayer, /customerFullNameInput|customerCompanyFullNameInput/, "客户表单必须支持公司全名");
assert.match(apiLayer, /客户ID: customer\.id/, "客户导出必须包含稳定客户 ID");
assert.doesNotMatch(apiLayer, /· ID \$\{escapeHtml\(customer(?:\?|\.)\.id/, "客户和商机日常界面不得显示内置客户 ID");
assert.doesNotMatch(apiLayer, /客户编号 \$\{escapeHtml\(current\.id\)/, "客户全景不得显示内置客户编号");
assert.doesNotMatch(apiLayer, /<label>客户 ID<\/label>/, "客户编辑弹窗不得显示系统主键");
assert.match(apiLayer, /公司简称: customer\.company/, "客户导出必须区分客户简称");
assert.match(apiLayer, /customerDocumentName\(customer\)/, "单据生成必须优先使用公司全名");
assert.match(prototype, /公司全名/, "客户界面必须提供公司全名字段");
assert.equal(prototype.includes("topReminderCount"), false, "全局顶部栏不应继续显示提醒计数");
assert.equal(prototype.includes("主库 <b>MySQL<\/b>"), false, "全局顶部栏不应显示数据库实现信息");
assert.equal(prototype.includes("topImportButton"), false, "客户导入不能继续占用全局顶部栏");
assert.equal(prototype.includes("topExportButton"), false, "客户导出不能继续占用全局顶部栏");
assert.match(prototype, /class="customer-head-actions"[\s\S]*id="customerImportButton"[\s\S]*id="customerExportButton"/, "客户导入导出必须位于客户页右上角");
assert.match(prototype, /id="customerPagination"[\s\S]*id="customerPageSize"[\s\S]*id="customerPrevPage"[\s\S]*id="customerNextPage"/, "客户列表必须保留分页和每页数量控制");
assert.match(apiLayer, /function customerPageRows[\s\S]*customers\.slice\(start, start \+ state\.customerPageSize\)/, "客户列表必须只渲染当前页数据");
assert.match(apiLayer, /state\.customerPage = Math\.min\(Math\.max\(1, state\.customerPage\), pageCount\)/, "客户数据减少后必须自动校正页码");
assert.match(apiLayer, /customerSearchInput[\s\S]*state\.customerPage = 1[\s\S]*customerQueueFilter[\s\S]*state\.customerPage = 1/, "客户搜索和队列筛选必须回到第一页");
assert.match(prototype, /id="agentSkillsGrid"/, "Skill 管理必须使用卡片目录");
assert.match(prototype, /class="integration-launcher"/, "集成中心必须使用卡片入口页");
assert.equal((prototype.match(/data-integration-launch-tab=/gu) || []).length, 10, "集成中心必须保留全部十个功能入口");
assert.match(prototype, /class="integration-tabs"[^>]*hidden/, "集成中心旧横向标签必须保持隐藏");
assert.doesNotMatch(prototype, /Stage 6/, "集成中心不得显示内部开发阶段字样");
assert.match(integrationCenter, /data-integration-home/, "每个集成工作区必须提供返回入口");
assert.match(integrationCenter, /showHome\(\)/, "集成中心首次进入必须显示卡片入口页");
assert.match(prototype, /id="agentSkillsCategoryFilter"/, "Skill 管理必须支持分类筛选");
assert.match(prototype, /id="agentSkillsStatusFilter"/, "Skill 管理必须支持状态筛选");
assert.match(prototype, /id="agentSkillsSourceFilter"/, "Skill 管理必须支持获取方式筛选");
assert.match(prototype, /id="agentSkillDrawerBackdrop"/, "Skill 详情必须有独立抽屉");
assert.match(apiLayer, /skill\.acquisitionInstructions/, "Skill 搜索与详情必须覆盖获取说明");
assert.match(apiLayer, /function isHttpsUrl/, "Skill 外部链接必须进行 HTTPS 二次校验");
assert.match(apiLayer, /data-agent-skill-copy/, "Skill 提取码、链接和安装命令必须支持复制");
assert.doesNotMatch(apiLayer, /exec\(skill\.installCommand|eval\(skill\.installCommand/, "Skill 安装命令只能展示和复制，不能在浏览器执行");
assert.match(prototype, /id="agentSkillAddButton"/, "Skill 资源中心必须提供权限控制的上架入口");
assert.match(apiLayer, /skillResourceTraining/, "Skill 资源必须支持训练教程维护");
assert.match(apiLayer, /skillResourceOptimization/, "Skill 资源必须支持优化方向维护");
assert.match(apiLayer, /\/api\/agent\/skill-resources/, "Skill 资源必须通过持久化 API 管理");
assert.match(apiLayer, /accessSkillResource/, "Skill 下载必须通过受控访问接口获取链接");
assert.match(apiLayer, /type DevelopmentEmailScenario = "first_touch" \| "daily_contact" \| "holiday_greeting" \| "new_product" \| "custom_goal"/, "开发信必须提供五种明确写作场景");
assert.match(apiLayer, /正在加载开发信工作区/, "开发信进入时必须表达为加载工作区而非自动生成");
assert.doesNotMatch(apiLayer, /正在生成开发信/, "开发信进入时不得暗示已自动调用 AI");
assert.match(apiLayer, /scenario: developmentEmailScenario,[\s\S]*goal: developmentEmailGoal,[\s\S]*requireAi/, "开发信 AI 请求必须携带场景、自然语言目标和明确生成开关");
assert.match(apiLayer, /developmentEmailScenario === "custom_goal" && !developmentEmailGoal/, "自然语言目标场景调用 AI 前必须校验目标");
assert.match(apiLayer, /activateNavView\("development-email", \(\) => void generateDevelopmentEmailDraftPage\(\)\)/, "进入开发信页面只能加载基础模板");
assert.match(apiLayer, /return state\.user\?\.theme \|\| getStoredTheme\(\) \|\| THEME_DEFAULT;/, "系统无已保存主题时必须回落到系统默认主题（晨白 Paper）");
assert.match(apiLayer, /templateStyle: profile\?\.templateStyle \|\| "rose" as const/, "新建单据必须默认使用团队玫红主题");
assert.match(apiLayer, /document\.type === "PI" && document\.templateStyle === "longtec"/, "PI 必须支持 Longtec 专用模板预览");
assert.match(prototype, /id="docTemplateInput">[\s\S]*value="longtec"/, "单据编辑器必须提供 Longtec 可选模板");
assert.match(prototype, /id="docThemeInput">[\s\S]*value="longtec"/, "单据主题选择必须同步提供 Longtec");
assert.match(prototype, /id="documentDefaultTemplateStyle"><option value="rose">Rose<\/option>/, "单据默认配置必须优先显示玫红主题");
assert.match(prototype, /id="documentSellerProfilesList"/, "单据默认配置必须展示全部卖方公司档案");
assert.match(prototype, /id="documentSellerProfilesManage"/, "管理员必须能从默认配置进入卖方公司管理");
assert.match(prototype, /id="docSellerProfileInput"/, "单据编辑器必须允许人工切换卖方公司");
assert.match(prototype, /id="docBrandMarkTextInput"[^>]*maxlength="8"/, "单据编辑器必须允许单据级配置左上色块文字");
assert.match(prototype, /id="documentDefaultBrandMarkText"[^>]*maxlength="8"/, "团队单据默认配置必须支持色块文字");
assert.match(prototype, /id="docShippingCostInput"[^>]*type="number"/, "单据编辑器必须提供可选的运费输入");
assert.match(apiLayer, /lineType: "shipping_cost"/, "填写运费后必须生成独立的 shipping_cost 明细");
assert.match(apiLayer, /items = items\.filter\(\(item\) => item\.lineType !== "shipping_cost"\)/, "运费明细不能重复出现在产品编辑行中");
assert.match(apiLayer, /function matchedSellerProfile[\s\S]*sellerProfileMatchScore/, "新建单据必须通过统一规则自动匹配卖方公司");
assert.match(apiLayer, /function renderSellerProfilesInDefaults/, "默认配置必须渲染卖方公司及其匹配规则");
assert.match(apiLayer, /letterheadId: qs<HTMLSelectElement>\("#docSellerProfileInput"\)/, "单据保存必须持久化人工选择的卖方公司");
assert.match(apiLayer, /applyDocumentCustomerDefaults[\s\S]*applyMatchedSellerToEditor/, "客户或商机变化后必须重新匹配卖方公司");
assert.match(apiLayer, /function applyFallbackSellerToEditor/, "人工切回或规则未命中时必须真正恢复兜底卖方资料");
assert.match(apiLayer, /brandMarkText: documentDefaultValue\("documentDefaultBrandMarkText"\)/, "团队色块文字必须通过默认配置 API 持久化");
assert.match(apiLayer, /brandMarkText: qs<HTMLInputElement>\("#docBrandMarkTextInput"\)/, "单据级色块文字必须随单据保存");

// 定制B（PI）：黑白制式模板。左上角 Logo 必须取卖方公司档案，模板里不许出现品牌素材或品牌名。
assert.match(apiLayer, /document\.type === "PI" && document\.templateStyle === "custom-b"/, "PI 必须支持「定制B」专用模板预览");
assert.match(
  apiLayer,
  /function renderCustomBPiPreview[\s\S]{0,1400}?letterhead \? \(letterhead\.logoUrl \|\| ""\) : \(document\.letterheadSnapshot\?\.logoUrl \|\| ""\)/,
  "定制B 的左上角 Logo 必须取所选卖方公司档案的 logoUrl（没选档案的老单据才用保存快照），不能写死在模板里"
);
assert.match(apiLayer, /function renderCustomBPiPreview[\s\S]{0,9000}?cb-logo-image/, "定制B 必须把 Logo 真正渲染在页头（参考 PI 在右上角）");
assert.doesNotMatch(apiLayer, /function renderCustomBPiPreview[\s\S]{0,9000}?ecore/i, "定制B 模板里不能残留参考件的品牌名");
assert.match(prototype, /id="docTemplateInput">(?:(?!<\/select>)[\s\S])*?<option value="custom-b">定制B<\/option>/, "单据编辑器必须提供「定制B」模板选项");
assert.match(prototype, /id="docThemeInput">(?:(?!<\/select>)[\s\S])*?<option value="custom-b">定制B<\/option>/, "主题选择必须同步提供「定制B」");
assert.match(prototype, /id="documentDefaultTemplateStyle">(?:(?!<\/select>)[\s\S])*?<option value="custom-b">定制B<\/option>/, "团队单据默认配置必须能选「定制B」");
assert.match(prototype, /\.doc-paper\.custom-b-pi \{/, "定制B 必须有独立纸张样式（去掉主题色顶边、A4 内距）");
assert.match(prototype, /\.custom-b-pi \.cb-logo-image \{[\s\S]{0,200}?object-fit: contain/, "定制B 的 Logo 必须等比例缩放，不能拉伸变形");
assert.match(apiLayer, /DOC_PINNED_TEMPLATE_STYLES[\s\S]{0,200}?"custom-b"/, "主题色板切换不能覆盖定制模板的选择");
// 定制B（PI）必须逐块对上参考 PI（595×842pt，1pt = 1.334px）：坐标由参考件量取后写死。
assert.match(prototype, /\.doc-paper\.custom-b-pi \{[\s\S]{0,120}?padding: 54px 37px 60px/, "定制B 必须按参考 PI 的页边距（28.34pt）排版");
assert.match(prototype, /\.custom-b-pi \.cbq-top \{[\s\S]{0,120}?justify-content: flex-end/, "定制B 的 Logo 必须靠右上（参考 PI 的页头）");
assert.match(prototype, /\.custom-b-pi \.cbq-title \{[\s\S]{0,160}?font-size: 32px;[\s\S]{0,40}?font-weight: 400/, "标题必须是参考件的 24pt 常规字重");
assert.match(prototype, /\.custom-b-pi \.cbq-party p:nth-child\(3\) \{ margin-top: 10\.5px; \}/, "抬头必须是参考件的五行结构（Company/Address 松、Tell/E-mail/Attn 紧）");
assert.match(apiLayer, /partyRows[\s\S]{0,400}?T\("tell"\)/, "抬头必须输出 Tell 行（参考件有电话标签）");
assert.match(prototype, /\.custom-b-pi \.cbq-col-no \{ width: 10%; \}[\s\S]{0,300}?\.custom-b-pi \.cbq-col-amount \{ width: 15%; \}/, "明细表列宽必须是参考件的 10/35/15/15/10/15");
assert.match(prototype, /\.custom-b-pi \.cbq-table th,[\s\S]{0,120}?border: 0 !important/, "定制B 的明细表必须去掉竖线与外框，只保留横线");
assert.match(prototype, /\.custom-b-pi \.cbq-table th \{[\s\S]{0,160}?border-bottom: 1\.3px solid #000/, "表头下必须只有一条 1pt 横线");
assert.match(prototype, /\.custom-b-pi \.cbq-table td \{[\s\S]{0,160}?border-bottom: 1px solid #000/, "明细行下必须是 .75pt 细横线");
assert.doesNotMatch(prototype, /\.custom-b-pi \.cbq-table tbody tr:last-child/, "明细表末行不能再加粗线（参考件整表同一条 .75pt 线）");
assert.match(prototype, /\.custom-b-pi \.cbq-totals p:nth-child\(2\) \{[\s\S]{0,80}?border-bottom: 1px solid #000/, "合计区第一条线在 TOTAL NO VAT 下方");
assert.match(prototype, /\.custom-b-pi \.cbq-totals p:nth-child\(3\) \{[\s\S]{0,120}?border-bottom: 1px solid #000/, "合计区第二条线在 TOTAL USD 下方");
assert.match(prototype, /\.custom-b-pi \.cbq-terms-title \{ margin: 94px 0 0;[\s\S]{0,120}?border-bottom: 1px solid #000/, "Terms 标题下的线必须整幅通栏（参考件跨到右边距）");
assert.match(apiLayer, /<h3 class="cbq-terms-title">[\s\S]{0,120}?<\/h3>\s*<section class="cbq-lower">/, "Terms 通栏线必须在左右两栏之外，不能被左列宽度截断");
assert.match(prototype, /\.custom-b-pi \.cbq-sign \{ width: 251px; margin-top: 122\.3px; \}/, "签署块必须落在参考件右下角的位置");
assert.match(prototype, /\.custom-b-pi \.cbq-sign-for \{[\s\S]{0,200}?color: #241a7d;[\s\S]{0,120}?font-style: italic/, "签署块必须是参考件的深紫衬线斜体");
assert.match(prototype, /\.custom-b-pi \.cbq-sign-rule \{[\s\S]{0,120}?border-top: 3px dotted #241a7d/, "签署处必须有参考件的点状虚线");
assert.match(prototype, /\.custom-b-pi \.cbq-table th\.cbq-col-vat,[\s\S]{0,90}?display: none/, "手机宽度必须收起恒为 No VAT 的列，否则六列会挤在一起");
assert.match(apiLayer, /function renderCustomBPiPreview[\s\S]{0,9000}?class="cbq-body"/, "定制B 必须是「左标题 + 右侧元信息」两列结构");
// 卖方公司的 Logo 调节器：两行（上下左右 / 缩小放大），且必须真的作用到定制B 的 PI / PO。
// 以前这两个模板完全忽略 logoPlacement，用户在「卖方公司」里怎么调都看不到变化。
assert.match(apiLayer, /data-placement-nudge-dir="\$\{prefix\}" data-nudge-x="0" data-nudge-y="-1"/, "Logo 调节器第一行必须有上移键");
assert.match(apiLayer, /data-placement-nudge-dir="\$\{prefix\}" data-nudge-x="1" data-nudge-y="0"/, "Logo 调节器第一行必须有右移键");
assert.match(apiLayer, /data-placement-zoom="\$\{prefix\}" data-zoom="-5"[\s\S]{0,400}?data-placement-zoom="\$\{prefix\}" data-zoom="5"/, "Logo 调节器第二行必须是缩小与放大");
assert.match(apiLayer, /function documentLogoPlacementStyle[\s\S]{0,700}?transform-origin:\$\{anchor\} top/, "HTML 模板的缩放锚点必须取模板自身的角（PI 右上 / PO 左上）");
assert.match(apiLayer, /if \(!value\.offsetX && !value\.offsetY && value\.scale === 100\) return "";/, "没调过 Logo 位置时不能输出 transform（默认版式必须与参考件一致）");
assert.match(apiLayer, /function renderCustomBPiPreview[\s\S]{0,2400}?documentLogoPlacementStyle\(documentLogoPlacementFor\([\s\S]{0,120}?"PI"\), "right"\)[\s\S]{0,4000}?class="cb-logo-image"[^>]*?\$\{logoStyle\}/, "定制B PI 必须把卖方公司里为 PI 调好的 Logo 位置贴到 Logo 上（锚点取右上）");
assert.match(apiLayer, /function renderCustomBPoPreview[\s\S]{0,2400}?documentLogoPlacementStyle\(documentLogoPlacementFor\([\s\S]{0,120}?"PO"\), "left"\)[\s\S]{0,4000}?class="cb-logo-image"[^>]*?\$\{logoStyle\}/, "定制B PO 必须把卖方公司里为 PO 调好的 Logo 位置贴到 Logo 上（锚点取左上）");
// 分模板记忆：同一张 Logo 在 PI / PO / 通用（Excel 导出）各存一套，互不覆盖
assert.match(apiLayer, /function documentLogoPlacementFor[\s\S]{0,620}?source\.logoPlacements\?\.\[key\] \|\| source\.logoPlacement/, "没单独调过的模板必须回落到通用值（不能让老档案突然丢掉已调好的位置）");
assert.match(apiLayer, /data-placement-tab-key="\$\{escapeHtml\(slot\.key\)\}"[\s\S]{0,200}?data-placement-tab-excel=/, "Logo 调节器必须按模板分页签");
assert.match(apiLayer, /\{ key: "custom-b:PI"[\s\S]{0,400}?\{ key: "custom-b:PO"[\s\S]{0,400}?\{ key: ""/, "页签必须包含定制B · PI、定制B · PO 与通用（Excel 导出）");
assert.match(apiLayer, /const persistDraft = \(\) => \{[\s\S]{0,220}?drafts\[currentKey\] = readDocumentAssetPlacement\(prefix\);/, "切模板前必须先把当前这套调节值存进草稿，否则来回切会丢");
assert.match(apiLayer, /function readDocumentLetterheadLogoPlacements[\s\S]{0,700}?logoPlacement: documentAssetPlacementValue\(map\[""\]\)/, "保存时必须把通用值单独取出来回传 logoPlacement");
assert.match(apiLayer, /logoUrl, \.\.\.readDocumentLetterheadLogoPlacements\("assetLetterhead"\)/, "保存卖方公司必须同时回传 logoPlacement 与分模板的 logoPlacements");
// 单据编辑里的一行式 Logo 调节器：挂在卖方公司档案下拉下，随预览同步，停手后静默存回档案
assert.match(prototype, /id="docSellerProfileInput"[\s\S]{0,1400}?class="doc-logo-inline" id="docLogoInline"/, "一行式 Logo 调节器必须放在卖方公司档案下方（单据编辑表单里）");
assert.match(prototype, /id="docLogoInline"[^>]*hidden[\s\S]{0,600}?data-doc-logo-dir="0\|-1"[\s\S]{0,800}?data-doc-logo-zoom="-5"[\s\S]{0,400}?data-doc-logo-zoom="5"/, "一行调节器默认隐藏，且必须带方向键与缩小/放大键");
assert.match(apiLayer, /function syncDocumentLogoInline[\s\S]{0,400}?if \(!active \|\| !letterhead\) \{\s*row\.hidden = true;\s*return;/, "调节器只对会消费该设置的模板出现（定制B 的 PI / PO），其余模板必须隐藏");
assert.match(apiLayer, /function renderDocumentPreview\([\s\S]{0,200}?syncDocumentLogoInline\(document\);/, "调节器必须随预览刷新同步（预览画哪套值，调节器就显示哪套）");
assert.match(apiLayer, /letterhead\.logoPlacements = \{ \.\.\.\(letterhead\.logoPlacements \|\| \{\}\), \[key\]: value \}/, "行内调节必须按当前模板的键写入对应那一套，不能覆盖其他模板");
assert.match(apiLayer, /docLogoInlineSaveTimer = window\.setTimeout\([\s\S]{0,120}?saveDocumentLogoInline/, "行内调节必须停手后静默保存，不能只在内存里改");
assert.match(apiLayer, /async function saveDocumentLogoInline[\s\S]{0,900}?\/api\/document-assets\/letterheads[\s\S]{0,700}?logoPlacements: asset\.logoPlacements \|\| \{\}/, "静默保存必须把分模板 logoPlacements 一并回传给卖方公司档案");

// 定制B（PO）：采购订单版式。买方主体在页头（Logo / 公司名 / Ship to / Confirmed By），
// Vendor 才是供应商；Logo 仍然取公司档案，不写死在模板里。
assert.match(apiLayer, /document\.type === "PO" && document\.templateStyle === "custom-b"/, "PO 必须支持「定制B」专用模板预览");
assert.match(
  apiLayer,
  /function renderCustomBPoPreview[\s\S]{0,1500}?letterhead \? \(letterhead\.logoUrl \|\| ""\) : \(document\.letterheadSnapshot\?\.logoUrl \|\| ""\)/,
  "PO 定制B 的左上角 Logo 也必须取所选公司档案的 logoUrl，不能写死在模板里"
);
assert.match(apiLayer, /function renderCustomBPoPreview[\s\S]{0,12000}?cbp-parties/, "PO 定制B 必须有 Vendor / Ship to 两栏");
assert.match(apiLayer, /function renderCustomBPoPreview[\s\S]{0,12000}?Confirmed By:/, "PO 定制B 必须有 Confirmed By 签章区");
assert.match(apiLayer, /function renderCustomBPoPreview[\s\S]{0,12000}?STANDARD PURCHASE ORDER TERMS AND CONDITIONS/, "PO 定制B 必须带标准采购条款");
assert.doesNotMatch(apiLayer, /function renderCustomBPoPreview[\s\S]{0,12000}?ecore/i, "PO 定制B 模板里不能残留参考件的品牌名");
assert.match(prototype, /data-doc-type="PO"/, "单据类型页签必须能切到 PO");
assert.match(apiLayer, /PO: "采购订单"/, "PO 必须登记中文单据名");
assert.match(prototype, /\.doc-paper\.custom-b-po \{/, "PO 定制B 必须有独立纸张样式");
assert.match(prototype, /\.custom-b-po \.cbp-parties \{[\s\S]{0,200}?grid-template-columns: 1fr 1fr/, "PO 的 Vendor / Ship to 必须是两栏等高");
assert.match(prototype, /\.custom-b-po \.cbp-table th \{[\s\S]{0,160}?background: #d9d9d9/, "PO 表头必须是黑白模板的浅灰底");
assert.match(prototype, /\.custom-b-po \.cbp-head \{[\s\S]{0,160}?justify-content: space-between/, "PO 页头必须是 Logo 与公司名左右分置");
assert.match(prototype, /\.custom-b-po \.cbp-sign \{[\s\S]{0,120}?grid-template-columns: 1fr 1fr/, "PO 的 Confirmed By / For and on behalf of 必须是双栏签章区");
assert.match(prototype, /\.custom-b-po \.cbp-terms-table th:nth-child\(4\) \{ width: 26%; \}/, "PO 条款表必须固定五列比例，否则 Payment Term 会把 Terms 挤没");
assert.match(prototype, /id="leadFinderLfindButton"[\s\S]*Lfind 深入查询/, "自动获客页必须提供 Lfind 深入查询入口");
assert.match(prototype, /id="leadFinderLfindInlineButton"[\s\S]*Lfind 深入查询/, "来源与执行设置中必须提供 Lfind 深入查询入口");
assert.match(apiLayer, /\/api\/lead-finder\/lfind-tasks/, "前端必须通过 Lfind 任务接口启动和轮询本地 Skill");
assert.match(apiLayer, /function runLfindLeadSearch/, "前端必须有独立的 Lfind 启动流程");
assert.match(apiLayer, /syncLfindTaskPolling/, "Lfind 必须异步轮询任务并同步结果");
assert.match(apiLayer, /searchReport/, "搜客候选必须接收每行搜索报告");
assert.match(apiLayer, /renderLeadSearchReportCell/, "自动搜客表格必须展示每行搜索报告摘要");
assert.match(apiLayer, /renderLeadSearchReportPanel/, "候选详情必须展示完整搜索报告和验证来源");

// ---------------------------------------------------------------------------
// 知识库训练工作台（P1）
//
// 这组断言守的是**最容易静默失效的地方**：控件 id 必须 index.html 与 prototype-api.ts
// 两端都对得上（少一个就是「点了没反应」），以及前端调用的路由后端必须真的存在。
// ---------------------------------------------------------------------------
/**
 * 断言源码里存在**生效的**代码行 —— 注释里出现同名字符串不算数。
 *
 * 这条是踩出来的：第一版用 `apiLayer.includes("bindKbTrainingEvents();")` 断言，
 * 把调用整行注释掉后断言依然通过（注释里也有那串字符）。会红的自检才算自检。
 */
function kbHasLiveLine(source: string, matcher: (line: string) => boolean, message: string) {
  const hit = source.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
    return matcher(line);
  });
  assert.ok(hit, message);
}

/**
 * 取「某函数定义之后、下一个函数定义之前」的源码片段 —— 用于「这段逻辑必须落在这个函数里」的断言。
 *
 * 这条也是踩出来的：写「勾选后必须在 finally 里重读」时用的是
 * `toggleKbKnowledgeEnabled[\s\S]{0,1600}?finally \{…await loadKbKnowledgeBases…`，
 * 但同一文件后面还有两个函数也有 `finally` + 同样的调用，惰性匹配直接跳过去命中它们 ——
 * 把该函数里的那一行删掉，断言依然全绿。凡"必须在这个函数里"的判据都得先切出函数体。
 */
function kbSourceBetween(source: string, fromMarker: string, toMarker: string): string {
  const start = source.indexOf(fromMarker);
  if (start < 0) return "";
  const end = source.indexOf(toMarker, start + fromMarker.length);
  return source.slice(start, end < 0 ? source.length : end);
}

assert.match(prototype, /<div class="view" id="kb-training">/, "index.html 必须提供知识库训练视图容器");
assert.match(prototype, /data-view="kb-training"/, "知识库训练必须有导航入口");
// ⚠️ 真实事故（用户报「为什么所有界面都有知识库训练？？？」）：视图自带的 <style> 里
//    写成 `#kb-training { display:flex }`（权重 1,0,0），压掉了全局的
//    `.view { display:none }`（权重 0,1,0）→ 该视图不再受活动态约束，**每个页面都渲染**。
//    这类错误的通用形态是「以视图 id 为唯一主体、且体内写 display」，所以按视图清单逐个扫。
//    注意：判据必须跑在**剥掉注释**的副本上 —— 上面那段说明文字里就写着 `#kb-training { display:flex }`，
//    不剥注释的话断言会命中自己的注释（第一版就这么误报过一次）。
const prototypeNoComments = prototype.replace(/\/\*[\s\S]*?\*\//gu, "");
const kbViewIdList = [...prototype.matchAll(/<div class="view" id="([^"]+)"/gu)].map((match) => match[1]);
kbViewIdList.forEach((viewId) => {
  assert.doesNotMatch(
    prototypeNoComments,
    new RegExp(`#${viewId}\\s*\\{[^}]*display\\s*:`, "u"),
    `视图 #${viewId} 的样式不得直接写 display —— 会压掉 .view{display:none}，该视图会在所有页面渲染（布局态请写 #${viewId}.active）`
  );
});
assert.match(
  prototypeNoComments,
  /#kb-training\.active\s*\{[^}]*display:\s*flex/u,
  "知识库训练激活态必须以 flex 渲染三屏（布局态限定在 .active 上）"
);
// 来源描述：资料从哪来 / 谁给的口径，跟着候选出处一起显示。三个落点缺一不可 ——
// 少了输入框用户填不了；少了提交体填了也不生效；少了出处渲染生效了也看不见。
assert.match(prototype, /id="kbSourceNote"/u, "屏 1 必须有「来源描述」输入框 #kbSourceNote");
kbHasLiveLine(apiLayer, (line) => line.includes('"#kbSourceNote"'), "prototype-api.ts 必须读取 #kbSourceNote");
assert.match(prototype, /data-kb-staged-note/u, "暂存清单每行必须有「来源描述」输入框");
kbHasLiveLine(apiLayer, (line) => line.includes("kbStagedNote"), "暂存描述输入必须绑定 data-kb-staged-note（dataset.kbStagedNote）");
kbHasLiveLine(apiLayer, (line) => line.includes("note: soloStaged && mainNote ? mainNote : item.note || undefined"), "暂存项提交时必须带上来源描述");
kbHasLiveLine(apiLayer, (line) => line.includes("note: mainNote || undefined"), "正文框那一份提交时必须带上来源描述");
assert.match(
  kbSourceBetween(apiLayer, "function kbSourceRefHtml", "function kbCandidateStatusTag"),
  /escapeHtml\(ref\.note\)/u,
  "候选出处必须渲染来源描述（且要过 escapeHtml）"
);
// 出处三件套随发布到插件：试问引用卡片必须显示「《文件》§段落 · 描述」。
// KbProbeCitation 要有三件套字段；kbProbeCitationHtml 里要拼《标题》并渲染出处行（都过 escapeHtml）。
assert.match(
  apiLayer,
  /interface KbProbeCitation\s*\{[^}]*sourceTitle\?[^}]*sourceAnchor\?[^}]*sourceNote\?/u,
  "KbProbeCitation 必须声明出处三件套（sourceTitle/sourceAnchor/sourceNote）"
);
assert.match(
  kbSourceBetween(apiLayer, "function kbProbeCitationHtml", "function renderKbProbe"),
  /citation\.sourceTitle \? `《\$\{citation\.sourceTitle\}》`/u,
  "试问引用必须显示文件名（《文件》格式，出处整行统一过 escapeHtml）"
);
assert.match(
  kbSourceBetween(apiLayer, "function kbProbeCitationHtml", "function renderKbProbe"),
  /出处：\$\{escapeHtml\(sourceBits\)\}/u,
  "试问引用必须渲染「出处：」整行（且要过 escapeHtml）"
);
kbHasLiveLine(apiLayer, (line) => line.trim() === '"kb-training": "知识库训练",', "viewLabels 必须注册知识库训练");
kbHasLiveLine(apiLayer, (line) => line.trim() === '"kb-training": "training.read",', "知识库训练必须复用 training.read 权限");
kbHasLiveLine(apiLayer, (line) => line.trim() === 'if (view === "kb-training") {', "进入知识库训练必须挂载加载钩子");
kbHasLiveLine(apiLayer, (line) => line.trim() === "void loadKbTraining({ silent: true });", "进入知识库训练必须加载工作台（且为静默加载）");
kbHasLiveLine(apiLayer, (line) => line.trim() === "bindKbTrainingEvents();", "知识库训练事件必须在启动时绑定一次");
kbHasLiveLine(apiLayer, (line) => line.trim() === 'if (activeView === "kb-training" && view !== "kb-training") stopKbTrainingPoll();', "离开知识库训练必须停止轮询");
kbHasLiveLine(apiLayer, (line) => line.includes('candidate.preselect && candidate.status === "pending"'), "预勾选必须直接采用后端算出的 preselect");
assert.doesNotMatch(apiLayer, /shouldPreselect|KB_PRESELECT_CONFIDENCE/, "前端不得复制后端的预勾选规则（规则只在后端有一份）");
const kbTrainingIds = [
  "kbRefreshButton",
  "kbSourceTitle",
  "kbSourceAsset",
  "kbSourceBody",
  "kbSourceFile",
  "kbUploadButton",
  "kbStartRunButton",
  "kbTargetKnowledgeBase",
  "kbStagedList",
  "kbSourceHint",
  "kbRunList",
  "kbCandidateSummary",
  "kbCandidateStatusFilter",
  "kbCandidateKindFilter",
  "kbCandidateConfidenceFilter",
  "kbCandidateGapOnly",
  "kbCandidateList",
  "kbCandidateNotice",
  "kbCandidateSelectedCount",
  "kbReviewSelectedButton",
  "kbDropSelectedButton",
  "kbPublishButton",
  "kbProbeInput",
  "kbProbeButton",
  "kbProbeResult",
  "kbProbeOpenButton",
  "kbProbeModal",
  "kbProbeModalClose",
  "kbKnowledgeSummary",
  "kbKnowledgeList",
  "kbKnowledgeNotice",
  "kbKnowledgeSearch"
];
kbTrainingIds.forEach((id) => {
  assert.ok(prototype.includes(`id="${id}"`), `知识库训练缺少控件 #${id}`);
  kbHasLiveLine(apiLayer, (line) => line.includes(`"#${id}"`), `prototype-api.ts 从未引用 #${id}（选择器拼错即静默不生效）`);
});
// 顶部搜索框只过滤卡片展示：判据落在真正过滤的那一行上。
// 「归入哪个库」下拉仍走全量（renderKbTargetOptions 用 kbKnowledgeSorted() 原样取），
// 提交口径不能被搜索框收窄 —— 收窄了用户搜着字发布，就会把成果发进没搜出来的库。
kbHasLiveLine(apiLayer, (line) => line.includes("item.name.toLowerCase().includes(query)"), "知识库搜索必须按名称过滤卡片");
kbHasLiveLine(apiLayer, (line) => line.includes("匹配 ${items.length} / 共 ${all.length} 个"), "搜索时摘要必须显示匹配数（否则不知道是筛过了还是真没有）");
kbHasLiveLine(apiLayer, (line) => line.includes("没有匹配「"), "搜索无结果必须区分「没有匹配」与「还没有知识库」两种空态");
// 试问验证必须是「按钮 → 弹窗」：弹窗复用全局 .modal-backdrop/.modal 语言
//（自造一套浮层会让关闭/遮罩/Esc 的行为与其它弹窗不一致），且打开即聚焦输入框。
assert.match(prototype, /class="modal-backdrop" id="kbProbeModal"/u, "试问验证必须用全局弹窗语言（.modal-backdrop + #kbProbeModal），不得自造浮层");
assert.match(prototype, /id="kbProbeModalClose"[^>]*aria-label="关闭"/u, "试问弹窗必须有关闭键（aria-label=\"关闭\"）");
kbHasLiveLine(apiLayer, (line) => line.includes('kbProbeModal.classList.add("active")'), "试问弹窗必须由「问一句试试」按钮打开（.active 显隐与全局弹窗一致）");
kbHasLiveLine(apiLayer, (line) => line.includes('kbProbeModal.classList.remove("active")'), "试问弹窗必须可关闭（关闭键/遮罩点击）");
kbHasLiveLine(apiLayer, (line) => line.includes('qs<HTMLInputElement>("#kbProbeInput")?.focus()'), "试问弹窗打开后必须聚焦输入框（打开即问）");
// 指标条的 <small> 是「这格是什么」，不是「取值范围枚举」：
// 曾经写成「CLI / 模型 / 未生效」，于是引擎正常工作时也摆着一个「未生效」，
// 用户读到的结论是「我的引擎没生效」—— 真降级反而被这句话淹掉。
assert.doesNotMatch(prototype, /<small>[^<]*未生效[^<]*<\/small>/u, "指标条说明位不得把「未生效」写成静态取值：引擎正常时会被读成「当前未生效」，真降级反而看不出");

// ---------------------------------------------------------------------------
// 知识库训练：试问屏必须与插件 resolve() 的真实出参对齐
//
// 这里守的是本轮修掉的一类错：前端曾经按「出处」的形状去渲染 `hits`
// （读 title/snippet/score），结果每条都渲染成空壳 —— 而真相是 `hits` 是
// `TrainingLibraryMatch`（{entry, similarity, matchedTerms}），`citations` 才是出处。
// 契约不一致时界面不会报错，只会安静地少显示东西，所以必须由断言守住。
// ---------------------------------------------------------------------------
// 判据必须落在**真正渲染的那一行**上：只断言「出现过 probe.verdict」是不够的
// —— 守卫条件 `if (probe.message && !probe.verdict)` 里也有它，把渲染那一行删掉照样通过。
kbHasLiveLine(apiLayer, (line) => line.includes("escapeHtml(probe.verdict)"), "试问必须展示插件给的护栏判决（verdict）");
kbHasLiveLine(apiLayer, (line) => line.includes("for (const warning of probe.warnings"), "试问必须展示插件给的提示（warnings）");
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("item.entry.question || item.entry.answer"),
  "试问必须指出踩到的禁用场景（哪句被拦、为什么）"
);
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("citations.filter((citation) => citation.kind === group.kind)"),
  "试问的正文出处必须以 citations 分组渲染"
);
assert.doesNotMatch(
  apiLayer,
  /probe\.blocked|blocked\?:\s*boolean/u,
  "插件 resolve() 没有 blocked 字段：前端不得伪造（假字段只会让界面永远少显示一句真话）"
);
assert.doesNotMatch(
  apiLayer,
  /\.\.\.\(probe\.hits \|\| \[\]\),\s*\.\.\.\(probe\.citations/u,
  "hits 与 citations 是同一次检索的两种视图，相加会让同一条问答被列两遍、条数翻倍"
);
assert.match(
  apiLayer,
  /interface KbProbeMatch \{[\s\S]{0,400}?entry: KbProbeEntry;/u,
  "hits 的类型必须是插件的 TrainingLibraryMatch（含 entry），不是出处形状"
);

// 行内编辑：人工确认闸必须能润色答案，否则不合口径的候选只有「丢弃」一条路。
kbHasLiveLine(
  apiLayer,
  (line) => line.trim() === "body: JSON.stringify({ ids: chunk, action, edits: edits?.length ? edits : undefined })",
  "确认时必须把 edits 一起提交（后端支持 edits，不传等于改了不生效）"
);
kbHasLiveLine(apiLayer, (line) => line.includes('data-kb-edit="answer"'), "编辑态必须有答案输入框");
// 同上：光有字符串不够 —— 渲染处与聚焦选择器是两件事，缺一个就是「编辑框打不开或点不到」。
assert.ok(
  (apiLayer.match(/data-kb-edit="answer"/gu) || []).length >= 2,
  "答案输入框必须既被渲染、也被聚焦逻辑引用（进编辑态要能直接开始打字）"
);
kbHasLiveLine(apiLayer, (line) => line.includes('"edit-confirm"'), "编辑态必须有「保存并确认」动作");

// 多份资料：一次训练要能带上好几份（后端 text.items 上限 50 条）。
assert.match(prototype, /id="kbSourceFile"[^>]*\bmultiple\b/u, "本地文件读取必须支持多选（一次只训一份是真实摩擦）");
// 上传区是 div 不是 button：键盘可达性与拖拽导入必须手动补齐，缺了就是"只能用鼠标"。
kbHasLiveLine(apiLayer, (line) => line.includes('upload.onkeydown = (event) =>'), "上传区必须键盘可达（Enter / 空格打开选择窗口）");
kbHasLiveLine(apiLayer, (line) => line.includes("upload.ondrop = (event) =>"), "上传区必须支持拖拽导入（点选之外的第二条路）");
kbHasLiveLine(apiLayer, (line) => line.includes("all.filter((item) => kbSourceFileKind(item.name) !== \"\")"), "拖入文件必须按扩展名过滤（二进制会被 text() 读成乱码语料）");
// PDF / Word 不能走 file.text()：浏览器读不出正文，必须交后端抽取。
kbHasLiveLine(apiLayer, (line) => line.includes("await kbExtractSourceFile(file)"), "PDF / Word 必须走后端抽取，不能本地当文本读");
kbHasLiveLine(apiLayer, (line) => line.includes("void readKbLocalFiles(ok)"), "拖拽与点选必须共用同一套读入管线（两套管线迟早读出两种结果）");
kbHasLiveLine(apiLayer, (line) => line.includes("sources: { text: { items } }"), "提交时必须以 text.items 携带多份资料（不是只发一份）");
assert.doesNotMatch(
  apiLayer,
  /files:\s*\{ assetIds:/u,
  "前端不得把关联资料同时塞进 files.assetIds：那条路径会把资料自身的说明当成一份语料喂进去"
);
kbHasLiveLine(apiLayer, (line) => line.includes("items.push({ title, body, assetId: assetId || undefined, note: mainNote || undefined })"), "正文框内容必须作为一份资料一起提交（含来源描述）");
assert.ok(
  (apiLayer.match(/kbTrainingState\.staged = \[\]/gu) || []).length >= 2,
  "暂存清单必须既能提交后自动清空、也能手动清空"
);

// 降级可见（§9）：轮询失败不许刷屏、不许静默；截断必须说出来。
// 断言计数而非「存在一处」：轮询与批次加载是两条独立的失败路径，
// 只守其中一条，另一条改成弹 toast 就会每 3 秒刷满界面（同名字符串会掩盖它）。
assert.ok(
  (apiLayer.match(/if \(options\.silent\) kbNotePollFailure\(\);/gu) || []).length >= 2,
  "轮询与批次加载两条失败路径都必须静默计数，不能每 3 秒弹一次错"
);
kbHasLiveLine(apiLayer, (line) => line.trim() === "if (kbTrainingState.pollStopped || kbTrainingState.editId) return;", "连续失败或编辑中必须停自动刷新");
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("kbTrainingState.candidateTotal > kbTrainingState.candidates.length"),
  "候选被 limit 截断时必须明说（静默截断是历史踩过的坑）"
);

// 出处可点：候选的出处要能一键回到文件中心资料本身。
kbHasLiveLine(apiLayer, (line) => line.includes("data-kb-asset="), "候选出处必须渲染成可点链接（关联了文件中心资料时）");
kbHasLiveLine(apiLayer, (line) => line.includes('"[data-kb-asset]"'), "出处链接必须有事件处理");

// ---------------------------------------------------------------------------
// 知识库：公开 / 私用 + 账号级「默认知识库」多选启用
//
// 这一组守三件**错了也不会报错、只会安静地不对**的事：
//  ① 勾选即启用 —— 一旦退回「勾完再点保存」，用户勾完就走，出稿没变化且无从察觉；
//  ② 保存成功 ≠ 生效 —— 插件没推成功时必须**常驻**提示（清单在 CRM 生效、运行端还没生效）；
//  ③ 别人的库改不动 —— 只渲染勾选框，不渲染「改名 / 切公开」按钮
//     （渲染出来点了报错，比压根不渲染更糟：用户会以为是自己没权限）。
// ---------------------------------------------------------------------------
assert.doesNotMatch(
  apiLayer,
  /data-kb-kb-save/u,
  "启用清单不得有「保存」按钮：勾选即启用，多一步就会有人勾完不点保存，然后以为生效了"
);
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("data-kb-kb-enable=") && line.includes("item.enabled"),
  "知识库勾选框必须反映当前启用状态（不看状态就渲染，界面会与真实清单不一致）"
);
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("data-kb-kb-visibility=") && line.includes("item.isOwner"),
  "别人的知识库不得渲染「公开 / 私用」按钮：别人的库只能勾选启用，改不动"
);
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("data-kb-kb-rename=") && line.includes("item.isOwner"),
  "别人的知识库不得渲染改名按钮（渲染出来点了报错比不渲染更糟）"
);
// 保存成功 ≠ 生效：这两条分支必须把「还没生效」留在屏幕上，而不是弹一个会消失的 toast。
kbHasLiveLine(apiLayer, (line) => line.includes("!result.pluginPushed"), "插件未同步必须显式提示：清单在 CRM 生效、运行端还没生效");
kbHasLiveLine(apiLayer, (line) => line.includes("result.rejected?.length"), "知识库被拒时必须说明是哪几个、为什么（静默忽略等于谎报成功）");
assert.ok(
  /finally \{[\s\S]*?await loadKbKnowledgeBases\(\{ silent: true \}\)/u.test(
    kbSourceBetween(apiLayer, "async function toggleKbKnowledgeEnabled", "async function toggleKbKnowledgeVisibility")
  ),
  "勾选后必须以后端清单为准重读：失败时由后端把勾选状态改回来（乐观更新会在失败时留下假象）"
);
assert.doesNotMatch(
  apiLayer,
  /function setKbKnowledgeNotice[\s\S]{0,400}?setTimeout/u,
  "知识库提示必须常驻：清单没同步到插件时出稿仍按旧清单走，自动消失的提示等于没说"
);
// 训练完成 / 发布候选之后都要静默重读知识库：条目数会变，不重读就看不到自己的成果进了哪个库。
// 断言的是**那一处调用本身**（`void` 形式），不是"文件里出现过这串字符"——
// 三个 finally 里的 `await` 形式也含同样的字符串，只数总量的话把这两处删掉也不会红。
assert.ok(
  (apiLayer.match(/void loadKbKnowledgeBases\(\{ silent: true \}\)/gu) || []).length >= 2,
  "发起训练与发布候选后都必须静默重读知识库（否则「已发布 N 条」永远停在旧数字）"
);
// 试问必须回报「这次读了什么范围」：没命中时这是唯一能区分
// 「被启用清单挡掉」与「库里压根没有这条语料」的证据，缺了用户只能靠猜。
kbHasLiveLine(apiLayer, (line) => line.includes("probe.kbScope"), "试问必须展示检索范围（插件回报的 kbScope）");
// 判据落在**给用户看的那句话**上：只断言 `scope.skippedByScope` 是不够的 ——
// 同一行模板里它出现两次，删掉三元判断、留下插值照样通过。
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("条因不在启用清单里被跳过"),
  "检索范围必须包含「因不在启用清单里被跳过」的条数"
);
// 批次卡片要标明归属：发布是逐条带 kbId 的，卡片不显示，发布完就只能去知识库列表里反推。
kbHasLiveLine(apiLayer, (line) => line.includes("kbKnowledgeNameOf(run.kbId)"), "批次卡片必须标明这批归入哪个知识库");
// 面板每轮重绘都换掉 innerHTML：事件必须委托在容器上，逐行 addEventListener 会随重绘一起丢。
kbHasLiveLine(
  apiLayer,
  (line) => line.trim() === 'const knowledgeList = qs<HTMLElement>("#kbKnowledgeList");',
  "知识库面板的事件必须委托在容器上（行内按钮是每次重绘新建的）"
);
// 屏 1 的「这批成果归入哪个库」：不提供就等于每训一次多一个库，
// 同一份资料反复提炼（第一次失败、补内容再提）会把「选择默认知识库」那张清单彻底搞乱。
// 判据落在**真的提交了 kbId** 那一行上：只断言"有这个下拉"是抓不到"选了没发"的。
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("...(targetKbId ? { kbId: targetKbId } : {})"),
  "屏 1 选中的归属知识库必须真的提交，否则选了等于没选"
);
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("kbKnowledgeSorted().filter((item) => item.isOwner)"),
  "归属目标只列自己的知识库：别人的库后端会 403，列出来只会让用户点了报错"
);
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("!result.knowledgeBaseSync.ok"),
  "新建库后清单同步失败必须提示（否则运行端仍按旧清单出稿，界面却显示已启用）"
);

// 运行中必须能回答「还在跑吗」与「能不能停」：只有「运行中」三个字时，
// 用户分不清在跑还是卡死，而这两种情况的下一步完全相反（等 vs 停下重来）。
kbHasLiveLine(apiLayer, (line) => line.includes("批 · 已处理"), "运行中的批次必须显示批次级进度（第几批/共几批）");
kbHasLiveLine(apiLayer, (line) => line.includes("data-kb-run-cancel="), "运行中的批次必须有停止入口");
// 停止是「请求」不是「结果」：发出后按钮必须停在「正在停止…」而不是弹回可点状态，
// 否则用户会以为没生效、反复点，而它本来就要等当前这批跑完。
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("正在停止…（等当前这批结束）"),
  "停止请求发出后必须显示等待态（否则用户会以为没生效）"
);
kbHasLiveLine(apiLayer, (line) => line.includes("data-kb-run-retry="), "失败/取消的批次必须能一键把资料填回来");
// 第一批在飞时进度必然为 0：一条钉在 2% 的条子和「卡死」无法区分，
// 必须切成不定长扫光并在文案里给出单批耗时，用户才敢决定「再等等」还是「停掉」。
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("pendingFirstBatch ? \" is-pending\" : \"\""),
  "第一批未返回时必须切到不定长进度（0% 与卡死无法区分）"
);
kbHasLiveLine(
  apiLayer,
  (line) => line.includes("单批通常 1~2 分钟"),
  "不定长进度必须写明单批耗时（否则用户仍然只能猜）"
);
kbHasLiveLine(
  prototype,
  (line) => line.includes("animation: kbBarIndeterminate"),
  "不定长进度必须有扫光动画（否则是静止的 38% 色块）"
);
// 发布是确认之后的事：待确认的行不得渲染发布键（摆在那里就会有人点，点了必然被后端拒）。
kbHasLiveLine(
  apiLayer,
  (line) => line.includes('candidate.status === "approved" ? `<button class="btn primary" data-kb-act="publish"'),
  "发布键只给已确认的候选"
);
assert.match(prototype, /id="kbPipeline"/u, "知识库训练必须有流水线步骤条（这一屏最容易迷路）");
assert.match(prototype, /id="kbEntriesModal"/u, "知识库必须能展开查看已发布条目（否则「已发布 N 条」只是个数字）");
assert.match(prototype, /id="kbEntriesSearch"/u, "知识库条目必须可搜索");
kbHasLiveLine(apiLayer, (line) => line.includes("openKbKnowledgeEntries(open)"), "知识库卡片必须有查看条目的入口");
// 删除知识库：不可撤销，入口 + 二次确认缺一不可（只有创建者拿得到这个按钮，判据在后端）。
kbHasLiveLine(apiLayer, (line) => line.includes('data-kb-kb-delete="${id}"'), "知识库卡片必须有删除入口");
kbHasLiveLine(apiLayer, (line) => line.includes('title: "删除知识库"'), "删除知识库必须二次确认（不可撤销）");

// 前后端路由对齐：前端调了而后端没有 = 上线即 404。后端目录不在时跳过（前端可单独跑）。
let kbBackendServer = "";
try {
  kbBackendServer = readBackendServerSources();
} catch {
  kbBackendServer = "";
}
if (kbBackendServer) {
  const kbRoutes: Array<[string, string]> = [
    ["post", "/api/kb/training/extract"],
    ["post", "/api/kb/training/runs"],
    ["get", "/api/kb/training/runs"],
    ["get", "/api/kb/training/runs/:id"],
    ["post", "/api/kb/training/runs/:id/cancel"],
    ["get", "/api/kb/training/candidates"],
    ["post", "/api/kb/training/candidates/review"],
    ["post", "/api/kb/training/candidates/publish"],
    ["post", "/api/kb/training/candidates/:id/revoke"],
    ["get", "/api/kb/training/knowledge-bases"],
    ["get", "/api/kb/training/knowledge-bases/:id/entries"],
    ["put", "/api/kb/training/knowledge-bases/defaults"],
    ["patch", "/api/kb/training/knowledge-bases/:id"],
    ["delete", "/api/kb/training/knowledge-bases/:id"],
    ["post", "/api/kb/training/probe"]
  ];
  kbRoutes.forEach(([method, path]) => {
    assert.ok(kbBackendServer.includes(`app.${method}("${path}"`), `后端缺少 ${method.toUpperCase()} ${path}`);
  });
  [
    "/api/kb/training/runs",
    "/api/kb/training/candidates/review",
    "/api/kb/training/candidates/publish",
    "/revoke",
    "/api/kb/training/knowledge-bases",
    "/api/kb/training/probe"
  ].forEach((fragment) => {
    kbHasLiveLine(apiLayer, (line) => line.includes(fragment), `前端工作台缺少对 ${fragment} 的调用`);
  });

  // 批次候选计数必须四态齐全：界面那行「待确认 / 已确认 / 已发布 / 已丢弃」按状态对齐，
  // 后端少给一态，界面对应的数字就恒为 0 —— 看起来像「还没确认过」，其实是没查。
  let kbRepoSource = "";
  try {
    kbRepoSource = readFileSync(new URL("../../backend/src/kb-training/kb-training-repository.ts", import.meta.url), "utf8");
  } catch {
    kbRepoSource = "";
  }
  if (kbRepoSource.includes("countCandidatesByRun")) {
    ["pending", "approved", "rejected", "published"].forEach((status) => {
      assert.ok(
        kbRepoSource.includes(`SUM(status = '${status}')`),
        `批次候选计数缺少 ${status} 一态（界面「已确认 / 已丢弃」这类数字会恒为 0）`
      );
    });
  }
}

// ── 邮件中心：视图 / 导航 / 页签 / 路由必须成套存在 ──────────────────────────
assert.ok(prototype.includes('id="mail-center"'), "缺少邮件中心视图容器 #mail-center");
assert.ok(prototype.includes('data-view="mail-center"'), "缺少左侧导航「邮件中心」入口");
["收件箱", "客户速查", "交互旅程", "工具箱"].forEach((label) => {
  assert.ok(apiLayer.includes(`"${label}"`), `邮件中心缺少页签「${label}」`);
});
assert.ok(
  apiLayer.includes('"mail-center": "communication.read"'),
  "邮件中心视图缺少权限要求 communication.read"
);
assert.ok(
  apiLayer.includes('if (view === "mail-center")'),
  "activateNavView 缺少邮件中心的加载钩子（进入视图不会拉数据）"
);
// 收件箱里必须能切到已发送 / 垃圾箱 / 垃圾邮件，少了这几项用户只能看到一半往来
["inbox", "sent", "trash", "junk"].forEach((kind) => {
  assert.ok(
    apiLayer.includes(`kind: "${kind}"`),
    `邮件中心缺少文件夹「${kind}」（收件箱外的已发送/垃圾箱/垃圾邮件）`
  );
});
assert.ok(apiLayer.includes("data-mc-folder"), "文件夹切换缺少 data-mc-folder 标记（点了没反应）");
assert.ok(
  apiLayer.includes('params.set("folder"') || apiLayer.includes('folder: mailCenterState.folder'),
  "邮件列表请求没有带 folder 参数（切文件夹不会换数据）"
);
// 旅程必须合并多源，少一路就会「只有发信、看不到回复」
["outbound_log", "mail_center", "touchpoint", "customer_activity"].forEach((source) => {
  assert.ok(
    apiLayer.includes(`"${source}"`) || readFileSync(new URL("../../backend/src/mail-center.ts", import.meta.url), "utf8").includes(`"${source}"`),
    `交互旅程缺少 ${source} 来源`
  );
});
// 写邮件 / 回复都必须长在阅读栏那一整块里（用户明确：不要右下角小浮窗、不要侧边抽屉）
assert.ok(
  apiLayer.includes('id = "mcComposePane"') && apiLayer.includes("openMailCenterComposePane(host"),
  "写邮件没有挂到阅读栏（#mcComposePane）——又退回右下角浮窗 / 侧边抽屉了"
);
assert.ok(
  /\.mc-compose-pane\s*\{[^}]*width:\s*100%/u.test(prototype),
  "阅读栏写信区没有压掉 .mail-center-compose-modal 的 680px 固定宽（会顶出右栏）"
);
assert.ok(
  /\.mc-compose-inline\s*\{[^}]*width:\s*auto/u.test(prototype),
  "就地回复卡片没有覆盖 680px 固定宽（会把阅读栏撑出横向滚动、正文被推着往左跑）"
);
// 回复框必须钉在阅读栏底部（原信上半截自己滚），不能接在长正文末尾——那样一点「回复」只看到半个框
assert.ok(apiLayer.includes('classList.add("is-replying")'), "回复没有进入阅读栏底部布局（is-replying）");
assert.ok(prototype.includes("mc-detail-scroll"), "阅读栏缺少可滚动区包装 .mc-detail-scroll");
assert.ok(
  /#mcMessageDetail\.is-replying\s*\{[^}]*display:\s*flex/u.test(prototype),
  "缺少回复态的两段式布局样式（#mcMessageDetail.is-replying）"
);
// 回复卡是「阅读栏的一个区」，不是浮在里面的小窗：圆角/外边距/投影一留，观感立刻回到小弹窗
assert.ok(
  /\.mc-compose-inline\s*\{[^}]*border-radius:\s*0/u.test(prototype),
  "就地回复卡还留着圆角（观感上仍是浮窗，而不是阅读栏底部的一块）"
);
// 800px 高的窗口里，页头+账号卡占 250px，三栏只剩 360px：不回血 130px，回复框一开原信就没了
assert.ok(
  apiLayer.includes('classList.toggle("is-writing"') &&
    /#mail-center\.is-writing\s+\.mc-accounts\s*\{[^}]*display:\s*none/u.test(prototype),
  "写信/回复时没有收起账号统计条（阅读栏太矮，原信会被回复框挤没）"
);
assert.ok(
  apiLayer.includes("mcFocusWriting(false)"),
  "关闭写信后没有撤销专注态（账号统计条会一直不回来）"
);
// 抬头「取消」不能抢页脚的 #mcComposeCancel（重复 id 会让「存草稿并收起」失去处理函数）
assert.ok(
  apiLayer.includes("data-mc-compose-cancel") &&
    (apiLayer.match(/id="mcComposeCancel"/gu) || []).length === 1,
  "就地回复抬头的取消按钮没有接线，或与页脚按钮复用了同一个 id"
);
// 就地回复抬头不许出现 ×/最小化：那两个是浮窗的招牌动作，留着就还是「小弹窗」
assert.ok(
  apiLayer.includes("mcComposeHeadButtonsHtml(false, false)"),
  "就地回复抬头又带上了 × 或最小化按钮（观感会退回小弹窗）"
);
// 切文件夹/切账号会重建 #mcTabBody，把写信界面整个换掉：专注态必须同时撤，
// 否则账号统计条一直藏着不回来（实测切「已发送」后复现）。先切出函数体，避免正则跨函数误命中。
const tabBodyFn = (() => {
  const start = apiLayer.indexOf("function renderMailCenterTabBody()");
  const end = apiLayer.indexOf("function renderMailCenterMessageList()");
  return start >= 0 && end > start ? apiLayer.slice(start, end) : "";
})();
assert.ok(
  tabBodyFn.includes("mcFocusWriting(false)"),
  "重建页签体时没有撤销专注态（切文件夹后账号统计条再也不回来）"
);
const mailCenterServer = (() => {
  try {
    return readBackendServerSources();
  } catch {
    return "";
  }
})();
if (mailCenterServer) {
  [
    ["get", "/api/mail-center/accounts"],
    ["patch", "/api/mail-center/accounts/:id/sync"],
    ["post", "/api/mail-center/accounts/:id/sync"],
    ["post", "/api/mail-center/accounts/:id/check"],
    ["get", "/api/mail-center/folders"],
    ["get", "/api/mail-center/messages"],
    ["get", "/api/mail-center/messages/:id"],
    ["post", "/api/mail-center/messages/:id/read"],
    ["get", "/api/mail-center/customers"],
    ["get", "/api/mail-center/customer/:entityType/:entityId"],
    ["get", "/api/mail-center/journey/:entityType/:entityId"]
  ].forEach(([method, route]) => {
    assert.ok(
      mailCenterServer.includes(`app.${method}("${route}"`),
      `后端缺少 ${method.toUpperCase()} ${route}`
    );
  });
}

/* ------------------------------ 订单履约 ------------------------------ */
assert.ok(prototype.includes('id="orders"') && prototype.includes('data-view="orders"'), "缺少订单列表视图或导航入口");
assert.ok(prototype.includes('id="order-detail"'), "缺少订单详情视图");
assert.ok(/\.ord-badge\.t-(warn|info|accent|ok|done|muted)/u.test(prototype), "订单状态徽章样式不完整");
// 弹窗挂在 #appModal，不在 #orders 子树：令牌少一份 → .ord-btn.primary 白底白字，主按钮像消失
assert.ok(
  prototype.includes("#orders, #order-detail, #appModal"),
  "订单弹窗没有继承 --od-* 令牌，主按钮会白底白字"
);
// display:flex 会压掉 [hidden]，空横幅会留一条空胶囊
assert.ok(prototype.includes(".ord-banner[hidden]"), "订单横幅缺少 [hidden] 兜底，没有缺单时也会留一条空条");
// 视图显隐只能由 .view.active 控制：任何以 #orders 为唯一主体的 display 规则都会压掉它
assert.ok(
  !/#orders\s*\{[^}]*display\s*:/u.test(prototype),
  "订单视图写了以 #orders 为主体的 display 规则，会覆盖 .view 的显隐"
);
assert.ok(apiLayer.includes("/api/orders") && apiLayer.includes("expectedStatus"), "订单接口缺少幂等状态参数");
assert.ok(
  apiLayer.includes("orderItemId") && apiLayer.includes("/api/tools/shipments"),
  "发货回写没有传 orderItemId，进度只能靠品名猜"
);
assert.ok(apiLayer.includes('data-ord-attach') && apiLayer.includes("/api/knowledge/assets"), "订单缺少文件关联入口");
// 文件管理不是「挂个链接」：打开必须走 access（否则百度网盘提取码拿不到），分类必须可改，
// 文件中心必须能反查被哪些订单引用。
assert.ok(
  apiLayer.includes("/api/knowledge/assets/${assetId}/access")
    && !apiLayer.includes('data-ord-open-file="${escapeHtml(file.sourceUrl)}"'),
  "订单里打开文件绕过了 access 接口：百度网盘只给链接不给提取码，用户点开是死路"
);
assert.ok(
  apiLayer.includes("ordEditFileKind") && apiLayer.includes("data-ord-file-kind"),
  "订单文件分类选错后改不了，只能删了重挂"
);
assert.ok(
  apiLayer.includes("#ordAssetList") && apiLayer.includes("#ordAssetSearch"),
  "关联文件弹窗没有搜索：文件一多只能翻列表"
);
// 弹窗读的是 /api/knowledge/assets（资料维护），按钮却叫「去文件中心」并跳到 knowledge，
// 而菜单里的「文件中心」是另一套 files 台账 —— 名字撞车，用户点了只会更困惑。
assert.ok(
  !apiLayer.includes("data-ord-goto-knowledge>去文件中心"),
  "订单文件弹窗还把资料维护叫「文件中心」：菜单里另有同名页面，用户会以为跳错地方"
);
assert.ok(
  apiLayer.includes("去资料维护添加") && apiLayer.includes('activateNavView("knowledge")'),
  "订单里想新增可复用资料时没有回到资料维护的入口"
);
assert.ok(
  apiLayer.includes("资料维护里还没有资料——切到「上传新文件」"),
  "资料为空时仍让用户去别处找资料：应直接引导到同一弹窗的上传页签"
);
assert.ok(
  /let tab: "assets" \| "upload" = selectable\.length \? "assets" : "upload"/u.test(apiLayer),
  "资料维护为空时默认打开空列表：应默认落在「上传新文件」，让用户在订单里就能传完"
);
assert.ok(
  apiLayer.includes("linkedOrderCount") && apiLayer.includes("data-knowledge-order"),
  "文件中心看不到「被哪些订单引用」，只能从订单单向看文件"
);
assert.ok(
  apiLayer.includes("data-ord-page") && apiLayer.includes("ORD_PAGE_SIZE"),
  "订单列表没有分页：超过一页的结果会被静默截断，用户看不到后面还有单"
);
assert.ok(apiLayer.includes("ordReqSeq"), "订单列表没有请求序号：快速切筛选时旧响应会盖掉新结果");
assert.ok(
  apiLayer.includes('tabindex="0"') && apiLayer.includes('event.key !== "Enter"'),
  "订单行只能鼠标点开，键盘用户进不去详情"
);
assert.ok(
  apiLayer.includes("data-line-product") && apiLayer.includes("itemsLocked"),
  "编辑弹窗改不了明细，或没有锁住已有发货记录的明细"
);
// 详情页一页一件事：六块内容如果又平铺回一条长页，用户翻到底也不知道先做哪件
assert.ok(
  apiLayer.includes('data-od-tab="${key}"') && apiLayer.includes('data-od-page="ov"') && apiLayer.includes("function ordShowTab"),
  "订单详情没有页签结构：明细/单证/发货/文件又会被平铺成一条长页"
);
assert.ok(
  apiLayer.includes("ordDetailTabOrderId") && apiLayer.includes("function ordPrimaryAction"),
  "订单详情改完状态就退回概览，或缺少唯一主动作（页头与「下一步」各弹一个主按钮）"
);
assert.ok(
  !/class="od-grid"/u.test(apiLayer) && !/class="od-stats"/u.test(apiLayer),
  "订单详情还在用两栏长页版式（od-grid / od-stats），旧版式已由页签取代"
);
// 串联：成交之后三个入口缺一个，用户就会在界面里「找不到单」
assert.ok(
  apiLayer.includes("drawerOpenOrderButton"),
  "商机详情没有「查看订单」入口：成交后用户在界面上找不到这张单"
);assert.ok(
  apiLayer.includes("renderCustomerOrders") && apiLayer.includes("customerId=${encodeURIComponent(customer.id)}"),
  "客户详情没有订单履约区块：跟进客户时看不到货发到哪一步"
);

const orderServer = (() => {
  try {
    return readBackendServerSources();
  } catch {
    return "";
  }
})();
const orderService = (() => {
  try {
    return readFileSync(new URL("../../backend/src/order-service.ts", import.meta.url), "utf8");
  } catch {
    return "";
  }
})();
const iamService = (() => {
  try {
    return readFileSync(new URL("../../backend/src/iam/iam-management-service.ts", import.meta.url), "utf8");
  } catch {
    return "";
  }
})();
const deriveSource = (() => {
  try {
    return readFileSync(new URL("../../backend/src/file-derive.ts", import.meta.url), "utf8");
  } catch {
    return "";
  }
})();
const storageSource = (() => {
  try {
    return readFileSync(new URL("../../backend/src/file-storage.ts", import.meta.url), "utf8");
  } catch {
    return "";
  }
})();
if (orderServer && orderService) {
  // 成员必须能删除：停用不释放邮箱，同邮箱重建会 409 —— 这条链路不能靠「停用」糊过去
  assert.match(orderServer, /app\.delete\("\/api\/v1\/members\/:id"/, "成员缺少删除接口，停用后邮箱会被永久占用");
  assert.match(orderServer, /confirmName: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(100\)/, "删除成员必须要求输入姓名二次确认");
  assert.match(iamService, /operation === "member\.delete"/, "IAM 服务缺少删除成员分支");
  assert.match(iamService, /UPDATE users SET email = \?, status = 'deleted'/, "删除有业务引用的成员必须释放邮箱");
  assert.match(iamService, /不能删除当前登录账号/, "删除成员必须拦住删除自己");
  assert.match(iamService, /最后一个管理员/, "删除成员必须拦住删掉最后一个管理员");
  assert.match(iamService, /memberBusinessReferences/, "删除成员前必须先查业务引用，否则会留下孤儿数据");
  assert.match(apiLayer, /data-ac-member-delete/, "成员列表没有删除入口");
  assert.match(apiLayer, /data-ac-member-toggle/, "成员列表没有停用入口");
  assert.match(apiLayer, /请输入完整的成员姓名以确认删除/, "删除确认没有比对成员姓名");
  assert.ok(orderServer.includes('app.use("/api/orders"'), "订单路由没有挂权限中间件");
  assert.ok(orderServer.includes("order.status.override"), "缺少订单状态回退/强推的权限校验");
  // 红线：订单模块不得写客户跟进记录（它是业绩考核数据源，写入不可逆）
  assert.ok(
    !orderService.includes("customerActivities"),
    "订单规则层出现 customerActivities：业绩考核数据被污染"
  );
  assert.ok(
    orderServer.includes("sumOrderItems(items)"),
    "订单金额没有服务端按明细汇总"
  );
  assert.ok(
    orderServer.includes("dealTitle: deal?.title"),
    "订单详情没有带来源商机标题：界面上只能看到一个 dealId"
  );
  // 回退只改状态不清时间 → 详情时间条会把「已签收」和「已发货」并排显示
  assert.ok(
    orderServer.includes("clearForwardTimestamps(order, body.toStatus)"),
    "状态回退没有清理目标阶段之后的时间戳"
  );
  assert.ok(
    orderService.includes("export function clearForwardTimestamps"),
    "规则层缺少 clearForwardTimestamps"
  );
  // 订单详情必须把提取码/关联人一起带出来，否则前端只能显示一个裸类型
  assert.ok(
    orderServer.includes("shareCode: visible ? asset!.shareCode")
      && orderServer.includes("createdByName: store.users.find"),
    "订单详情的文件没有带提取码与关联人，百度网盘资料在订单里打不开"
  );
  assert.ok(
    orderServer.includes('app.patch("/api/orders/:id/files/:fileId"'),
    "订单文件分类没有修改接口：选错只能删了重挂"
  );
  assert.ok(
    orderServer.includes("linkedOrders") && orderServer.includes("linkedOrderCount"),
    "文件中心接口没有反向索引，看不到资料被哪些订单引用"
  );

  // ---- 两个单号：CRM 系统编号 ≠ 公司实际订单号 ----
  // 系统编号是 GJ-SO-YYMM-NNNN 流水号，公司对外用的是自己编的号；
  // 以前把系统编号当公司单号展示，业务员以为单号已经有了，实际合同/单证上没有号可填。
  assert.ok(
    apiLayer.includes("function ordIdentity") && apiLayer.includes("companyOrderNo"),
    "订单没有区分「系统编号」与「公司单号」：界面上会把 CRM 流水号当成公司实际订单号"
  );
  assert.ok(
    apiLayer.includes("待补公司单号") && apiLayer.includes("系统编号"),
    "公司单号为空时界面上没有任何提示，用户无法发现这张单还缺对外单号"
  );
  assert.ok(
    apiLayer.includes("data-ord-numbers") && apiLayer.includes("function ordNumbersModal")
      && apiLayer.includes("ordNumCompany") && apiLayer.includes("ordNumPo") && apiLayer.includes("ordNumErp"),
    "单号入口只开放了公司单号：客户 PO / ERP 单号在界面上没有可编辑的地方"
  );
  // 列表主标识必须走 ordIdentity，不能再直接把 orderNo 当单号印在首列
  assert.ok(
    !/class="ord-no">\$\{escapeHtml\(order\.orderNo\)\}/u.test(apiLayer),
    "订单列表仍把系统编号当主标识显示"
  );
  assert.ok(
    orderServer.includes("companyOrderNo: z.string().trim().max(80).optional()")
      && orderServer.includes("companyOrderNo: z.string().trim().max(80).optional().default"),
    "建单/改单接口不收 companyOrderNo，界面上填了也存不下来"
  );
  assert.ok(
    orderServer.includes("${row.companyOrderNo} ${row.orderNo}"),
    "订单搜索不含公司单号：业务员拿真实单号搜不到单"
  );
  assert.ok(
    orderService.includes("companyOrderNo: \"\""),
    "成交自动建单没有初始化 companyOrderNo 字段"
  );
  // 单号是「标识」不是「条款」：公司单号 / 客户 PO / ERP 单号都不能跟着发货后锁定
  assert.ok(
    !/editableFields = \[[^\]]*(companyOrderNo|buyerPoNo|erpOrderNo)/u.test(orderServer),
    "单号类字段被卷进「已发货后锁定」的清单：发货后财务/生产给的号永远补不上"
  );
  assert.ok(
    orderServer.includes("erpOrderNo: z.string().trim().max(80).optional()")
      && orderServer.includes("order.erpOrderNo = body.erpOrderNo"),
    "改单接口不收 erpOrderNo，ERP 单号界面上填了也存不下来"
  );
}

// ---- 文件中心（M1–M6）----
// 视图显隐靠 .view.active。视图自带的 <style> 一旦写「以视图 id 为唯一主体」的 display，
// ID 权重会压掉 .view → 每页都渲染（2026-10-16 事故）。这条必须在。
assert.ok(
  !/#file-center\s*\{[^}]*display\s*:/s.test(prototype),
  "文件中心样式直接用 #file-center 写 display：会压掉 .view 的显隐"
);
assert.ok(
  prototype.includes('class="view" id="file-center"') && prototype.includes('data-view="file-center"'),
  "文件中心缺少视图容器或侧栏入口"
);
assert.ok(
  apiLayer.includes('"file-center": "文件中心"') && apiLayer.includes('if (view === "file-center") void loadFileCenter();'),
  "文件中心没有接进 VIEW_TITLES 或导航懒加载"
);
// 全局 table{min-width:900px}：放进窄栏的自建表格必须显式 min-width:0，
// 否则 width:100% + table-layout:fixed 全失效，右侧列被 overflow:hidden 裁掉
assert.ok(
  /#file-center table\.fc-table \{[^}]*min-width:0/s.test(prototype),
  "文件中心表格没有覆盖全局 table min-width，右侧列会被裁掉"
);
// 审计表列的含义和台账不同（首列是占位而非勾选），共用列宽会把「文件」压成 84px 只显示 id
assert.ok(
  /#file-center table\.fc-audit th:nth-child\(5\)/.test(prototype),
  "审计表没有独立列宽：文件名会被截断成文件 id"
);
// .fc-bulk 是 display:flex，会压掉 [hidden] 的 display:none → 未选中时留一条空横幅
assert.ok(
  /#file-center \.fc-bulk\[hidden\] \{ display:none; \}/.test(prototype),
  "批量条缺 [hidden] 兜底：没选中文件也会留一条空横幅"
);
// 列表过一屏必须分页；只设固定 pageSize 不配分页会静默截断
assert.ok(
  apiLayer.includes("#fcPager") && apiLayer.includes("fileCenterState.pageSize"),
  "文件台账没有分页：超出 pageSize 的记录会被静默截断"
);
// 分享状态必须跟真实可用性一致：文件已删还标「有效」，点开是 410
assert.ok(
  apiLayer.includes('"文件已删除"') && apiLayer.includes('share.fileStatus !== "active"'),
  "分享列表没有按文件真实状态降级显示，「有效」的链接点开可能是 410"
);
// 审计日志表只有 file_id，接口不回填文件名，列表就只能显示一串 id
assert.ok(
  orderServer.includes('fileName: log.fileId ? names.get(log.fileId)'),
  "审计接口没有回填文件名"
);
// 文本响应不带 charset 时，Chrome 按本地编码解码 → 中文 txt/csv 预览整篇乱码
assert.ok(
  orderServer.includes('baseType.startsWith("text/")') && orderServer.includes("charset=utf-8"),
  "文本预览响应没有声明 charset=utf-8：中文 txt/csv 会整篇乱码"
);
// text/csv 在 iframe 里会被 Chrome 直接触发下载，「预览」按钮变成下载文件
assert.ok(
  apiLayer.includes('contentType.startsWith("text/")') && apiLayer.includes("od-preview-text"),
  "文本类预览仍交给 iframe：Chrome 对 text/csv 会直接下载而不是显示"
);
// sips/soffice 的 stderr 是给开发者的（"Try 'sips --help'"），不能拼进用户可见文案
assert.ok(
  deriveSource.length > 2000 &&
    !deriveSource.includes("brew install --cask libreoffice") &&
    !deriveSource.includes("line.slice(0, 160)"),
  "派生失败文案把安装命令或外部工具 stderr 甩给了业务用户"
);
// 「转换失败 N」如果点不进去，用户只知道有失败、不知道是哪几个文件
assert.ok(
  apiLayer.includes("data-fc-metric-failed") && apiLayer.includes("fcDeriveFailedOnly") && orderServer.includes("deriveFailed"),
  "转换失败指标卡没有落到具体文件的入口"
);
// 预览能力不可见 = Office/HEIC 全失败时没人知道是缺组件还是文件坏了
assert.ok(
  apiLayer.includes("在线预览能力") && apiLayer.includes("derive?.capabilities"),
  "存储设置没有展示在线预览能力，转换失败时无从判断原因"
);
// 项目要开源，服务器可能是 Windows / Linux。安装指引写死 brew 等于把人带进沟里
assert.ok(
  apiLayer.includes("winget install TheDocumentFoundation.LibreOffice") &&
    apiLayer.includes("apt install libreoffice-writer") &&
    apiLayer.includes("caps?.platform"),
  "存储设置的安装指引只考虑了 macOS：Windows / Linux 部署会拿到错误的安装命令"
);
// 能力探测要把平台带出去，前端才有依据切换指引
assert.ok(
  deriveSource.includes("platform: process.platform"),
  "能力探测没有返回 platform，前端无法按服务器平台给安装指引"
);
// 跨平台部署资产：开源后最主流的两种装法是 Docker 和 Windows 便携部署
{
  const readRepoFile = (rel: string) => {
    try {
      return readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
    } catch {
      return "";
    }
  };
  // 只检查真实配置，不检查注释：注释里提一句「别用 macOS 的目录」不该触发断言
  const linuxFontconf = readRepoFile("deploy/fontconfig/fonts.linux.conf").replace(/<!--[\s\S]*?-->/gu, "");
  assert.ok(
    linuxFontconf.includes("/usr/share/fonts") && !linuxFontconf.includes("/System/Library/Fonts"),
    "Linux fontconfig 用了 macOS 的字体目录：容器里会被当成「系统没有字体」，中文全丢"
  );
  assert.ok(
    linuxFontconf.includes("Noto Serif CJK SC") && linuxFontconf.includes("微软雅黑"),
    "Linux fontconfig 缺字体名别名：docx 里写的「宋体/微软雅黑」在 Linux 上会退到无中文字形的字体"
  );

  const winInstall = readRepoFile("deploy/install-libreoffice.ps1");
  const findBody = winInstall.match(/function Find-Soffice[\s\S]*?\n}/)?.[0] || "";
  assert.ok(
    findBody.includes("soffice.com") && !findBody.includes("soffice.exe"),
    "Windows 安装脚本的探测没有只认 soffice.com：用 soffice.exe 会立刻返回 0，转换实际没完成"
  );
  assert.ok(
    winInstall.includes("/a") && winInstall.includes("TARGETDIR"),
    "Windows 安装脚本没有免管理员的解包路径：普通用户装不上就没法预览"
  );

  const dockerfile = readRepoFile("deploy/docker-compose/Dockerfile.backend");
  assert.ok(
    dockerfile.includes("libreoffice-writer") && dockerfile.includes("libreoffice-impress"),
    "后端镜像只装了 libreoffice-calc：docx/pptx 预览会全部转换失败"
  );
  assert.ok(
    dockerfile.includes("poppler-utils") && dockerfile.includes("deploy/fontconfig"),
    "后端镜像缺 pdftoppm 或 fontconfig：缩略图没有，中文也可能整段消失"
  );
}

// 文件中心自己不提供上传入口时，不属于任何订单的基础文档根本进不了文件池
assert.ok(
  prototype.includes('id="fcUploadButton"') && prototype.includes('id="fcUploadInput"'),
  "文件中心没有上传入口：通用基础文档无处可放"
);
// 只放 .docx/.xlsx 会把用 WPS 专有格式存的单据挡在门外
assert.ok(
  /id="fcUploadInput"[\s\S]{0,400}accept="[^"]*\.wps/.test(prototype),
  "上传控件 accept 没有包含 WPS 格式：客户用 WPS 存的单据选不到"
);
assert.ok(
  apiLayer.includes("/api/files?kind=other") && apiLayer.includes("/api/files/uploads"),
  "文件中心上传没有同时支持直传与分片：大文件断线要整份重传"
);

// LibreOffice 在 macOS 上默认看不见系统字体，中文会整段消失，而转换仍报「成功」
assert.ok(
  deriveSource.includes("export function fontConfigEnv") && deriveSource.includes("env: fontConfigEnv()"),
  "转换子进程没有注入 fontconfig：macOS 上会把中文转丢，只剩数字和英文"
);
// 缩略图：sips 不依赖 QuickLook 服务，必须排在 qlmanage 之前
{
  const thumbBody = deriveSource.match(/private async pdfThumb\([\s\S]*?\n  \}/)?.[0] || "";
  assert.ok(
    thumbBody.includes("caps.sips") && thumbBody.indexOf("caps.sips") < thumbBody.indexOf("caps.pdftoppm"),
    "PDF 缩略图没有优先用 sips：qlmanage 在后台服务里会 sandbox 初始化失败"
  );
}
// 按后缀硬转会失败：WPS 常把 OOXML 存成 .doc/.wps
assert.ok(
  deriveSource.includes("export function conversionExtension") && deriveSource.includes("if (!isZip) return fallback;"),
  "转换前没有按魔数纠正后缀：WPS 存出的 .doc/.wps 会解析失败"
);
// OLE2（97-2003 与 WPS 原生格式）不识别 → sniff 返回 null → 上传直接被 415 拒掉
assert.ok(
  storageSource.includes("0xd0 && buffer[1] === 0xcf") && storageSource.includes('wps: "application/x-wps"'),
  "文件类型探测不识别 OLE2：WPS/老版 Office 文件会被 415 拒绝"
);

// 工作台不再展示「管道健康度」：商机阶段口径归商机页，工作台只留漏斗 / 跟进队列 / 竞标日报。
// 删掉后海外竞标日报要吃掉整行（span 12），否则右半边会空出 5 列。
assert.ok(
  !prototype.includes("管道健康度") && !prototype.includes("dp-pipeline") && !apiLayer.includes("renderPipelineHealth"),
  "工作台「管道健康度」已下线，不要再挂回来（区块 DOM / CSS / 渲染函数三处都要保持为空）"
);
assert.ok(
  /#dashboard\.dashboard-v2 \.dp-tasks \{ grid-column: span 7; \}\s*\n\s*#dashboard\.dashboard-v2 \.dp-tender \{ grid-column: span 12; \}/.test(prototype)
    && !/#dashboard\.dashboard-v2 \.dp-tender \{ grid-column: span 7; \}/.test(prototype),
  "管道健康度下线后，海外竞标日报必须通栏（基础栅格 span 12），否则第二行右侧留白 5 列"
);
// 竞标日报是付费动作（派本机 CLI 联网检索），必须手动触发：
// 打开工作台只读团队留档（GET /api/tender-daily/latest），绝不能在 ensureTenderDaily 里 POST /run。
{
  const ensureIdx = apiLayer.indexOf("function ensureTenderDaily()");
  const ensureBody = ensureIdx >= 0 ? apiLayer.slice(ensureIdx, ensureIdx + 260) : "";
  assert.ok(
    ensureIdx > -1
      && ensureBody.includes("loadTenderDailySnapshot()")
      && !ensureBody.includes("loadTenderDaily(")
      && !/ensureTenderDaily[\s\S]{0,160}loadTenderDaily\(/u.test(apiLayer),
    "海外竞标日报又变回自动派单了：打开工作台只能读留档（loadTenderDailySnapshot），必须点「开始查询」才 POST /run，否则每次刷新都烧积分"
  );
}

// 顶栏页签的选中态要点主题色：换肤时跟着 --brand 走，不能写死近黑。
assert.ok(
  /\.top-tab\.active \{[^}]*color: var\(--brand-strong\)[^}]*\}/.test(prototype)
    && /\.top-tab\.active::after \{[^}]*background: var\(--brand\)[^}]*\}/.test(prototype),
  "顶栏页签选中项没有主题色（文字 + 下划线都应取 --brand），换肤后仍是黑白"
);

// 顶栏「待办」：固定在右上动作区（站内信左侧），点一下直达待办中心，颜色跟主题色走。
{
  const actionsIdx = prototype.indexOf('<div class="top-actions">');
  const pillIdx = prototype.indexOf('id="topTodoPill"');
  const bellIdx = prototype.indexOf('id="notificationBellButton"');
  assert.ok(
    actionsIdx > -1 && pillIdx > actionsIdx && bellIdx > pillIdx,
    "顶栏待办入口不在站内信旁边：必须放在 .top-actions 里、通知铃之前，否则页签一变它就跟着漂"
  );
  assert.ok(
    apiLayer.includes('qs<HTMLButtonElement>("#topTodoPill")?.addEventListener("click", () => activateNavView("todo"))'),
    "顶栏待办入口点了不跳转（应 activateNavView(\"todo\")）"
  );
  assert.ok(
    /\.top-pill \{[^}]*background: var\(--brand-tint\)/.test(prototype)
      && /\.top-pill b \{[^}]*background: var\(--brand\)/.test(prototype),
    "顶栏待办按钮没用主题色（底色与计数都应取 --brand 系）"
  );
}

// 顶栏账号头像：浅色半透明品牌色，换肤自动跟随；禁止再写死渐变（绿/紫都不行）。
assert.ok(
  /\.avatar \{[^}]*background: color-mix\(in srgb, var\(--brand\) 12%, transparent\)/s.test(prototype)
    && /\.avatar \{[^}]*color: var\(--brand-strong\)/s.test(prototype),
  "顶栏头像不是半透明品牌色（底色 color-mix 12% + 文字 --brand-strong），换肤后会跟主题脱节"
);
assert.ok(
  !/\.avatar \{[^}]*background: linear-gradient/s.test(prototype),
  "顶栏头像不能再用写死的渐变，换肤时不会跟随主题"
);

// 订单详情必须跟着工作区宽度自适应：写死 max-width 会在 2K/4K 上缩成居中窄栏，
// 和客户列表（满宽）完全两个版式。宽度只由 .workspace 决定。
assert.ok(
  /#order-detail \.od-page \{[^}]*\}/s.test(prototype)
    && !/#order-detail \.od-page \{[^}]*max-width:\s*\d+px/s.test(prototype),
  "订单详情页不能写死 max-width（会在大屏上缩成窄栏、两侧空出上千像素）"
);

// 单据 PDF 导出：一页报价单曾经 10MB，且「显示一张、打印两张」。
// ① jsPDF 的 addImage 不传压缩级别时默认 image_compression.NONE，整页位图按原始 RGB 写进 PDF
//    （1588×2246×3 ≈ 10.7MB）；
// ② A4 在 794px 宽下正好 1122.9px，元素高度取整成 1123px → 297.02mm，比 297mm 多 0.02mm，
//    `while (heightLeft > 0)` 必然再吐一张空白页。
// ③ 8 种单据（PI/CI/报关/装箱单/合同/报价/原产地证/装运通知）共用同一条导出链路，
//    所以压缩不能只保证报价单：整份源码只允许一个 addImage 出口，且必须带压缩级别常量。
{
  const start = apiLayer.indexOf("async function downloadDocumentPdf(");
  const end = apiLayer.indexOf("function parseNumberCell(", start);
  const body = start > -1 && end > start ? apiLayer.slice(start, end) : "";
  // 注释行里也会出现被禁的写法（解释"老坑"时引用了旧代码），断言只对去注释后的真实代码生效
  const code = body.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(body.length > 0, "找不到 downloadDocumentPdf 的代码，PDF 导出逻辑被挪走了，请同步本断言");
  const addImageCalls = (code.match(/\.addImage\(/g) || []).length;
  assert.ok(addImageCalls === 0, "downloadDocumentPdf 必须通过 addDocumentPdfPage 贴图，不要在函数里直接写 addImage");
  assert.ok(
    !/while\s*\(\s*heightLeft\s*>\s*0\s*\)/.test(code),
    "PDF 分页不能再写 while (heightLeft > 0)：像素取整后必然多出零点几毫米，会多打印一张空白纸"
  );
  assert.ok(
    /const\s+ONE_PAGE_TOLERANCE\s*=/.test(code) && /imgH\s*<=\s*pageH\s*\*\s*ONE_PAGE_TOLERANCE/.test(code),
    "PDF 导出缺少「一页容差」：接近 A4 高度的单据必须压回一页，不能甩出几乎空白的第二页"
  );

  // 全文件只允许一个 addImage 出口，且压缩级别来自常量。新增单据类型若另起一条位图导出，
  // 这里立刻变红 —— 这正是「报价单压了、PI/CI/装箱单又变 10MB」的防线。
  const allCode = apiLayer.replace(/^\s*\/\/.*$/gm, "");
  assert.equal((allCode.match(/\.addImage\(/g) || []).length, 1,
    "整份源码只允许一个 addImage 出口（addDocumentPdfPage），否则新单据类型可能绕开压缩");
  assert.ok(
    /const\s+DOCUMENT_PDF_IMAGE_COMPRESSION\s*=\s*"FAST"/.test(allCode),
    "PDF 位图压缩级别必须是常量 DOCUMENT_PDF_IMAGE_COMPRESSION = \"FAST\"（Flate 无损，约 1/45 体积）"
  );
  assert.ok(
    /function\s+addDocumentPdfPage\([\s\S]{0,700}?\.addImage\([\s\S]{0,200}?DOCUMENT_PDF_IMAGE_COMPRESSION\s*\)/.test(allCode),
    "addDocumentPdfPage 必须把 DOCUMENT_PDF_IMAGE_COMPRESSION 作为 addImage 的第 8 个参数传进去"
  );
  assert.ok(
    (code.match(/addDocumentPdfPage\(/g) || []).length >= 3,
    "单页 / 多页首屏 / 多页续页三条分支都必须走 addDocumentPdfPage"
  );

  // 所有单据类型共用一个导出函数，不允许按 type 分流到别的 PDF 实现。
  const exportStart = apiLayer.indexOf("async function exportTradeDocumentPdfInner(");
  const exportEnd = apiLayer.indexOf("function printDocumentPreview(", exportStart);
  const exportCode = exportStart > -1 ? apiLayer.slice(exportStart, exportEnd > exportStart ? exportEnd : exportStart + 4000) : "";
  assert.ok(/await\s+downloadDocumentPdf\(/.test(exportCode),
    "单据导出必须统一调用 downloadDocumentPdf，不能按单据类型分流");
  const unionLine = (apiLayer.match(/type:\s*("PI"[^;]*);/) || [])[1] || "";
  ["PI", "CI", "PO", "CUSTOMS", "PL", "CONTRACT", "QUOTATION", "COO", "SHIPPING"].forEach((type) => {
    assert.ok(unionLine.includes(`"${type}"`), `单据类型 ${type} 必须留在 TradeDocumentType 里，共用同一条导出链路`);
  });
}

// 报价单默认付款条款：全款预付。曾经写死成 30% 定金 + 发货前付清，
// 每次新建报价单都要手改，客户看到也会以为要压款。
{
  const start = apiLayer.indexOf('...(type === "QUOTATION" ? {');
  const body = start > -1 ? apiLayer.slice(start, start + 600) : "";
  assert.ok(body.length > 0, "找不到报价单默认值（defaultTradeDocument 里的 QUOTATION 分支），请同步本断言");
  assert.ok(
    /paymentTerm:\s*"T\/T 100% in advance"/.test(body),
    "报价单默认付款条款必须是 T/T 100% in advance"
  );
  assert.ok(
    !/30%\s*deposit/.test(body),
    "报价单默认付款条款不能再带 30% 定金：报价阶段写分期会让客户以为要压款"
  );
}

// CLI 获客「只要决策人/采购人邮箱」（2026-10-31 用户要求）：
// 准入判定在后端（ai-engine-prompts 的 acquisitionContactRole + syncAcquisitionCandidates），
// 前端只负责读取后端写进 extractedContacts[].reasonCodes 的角色、打徽章并允许收窄列表。
// 这三处任一被移除，用户就会看到「没有邮箱的候选混进清单」或「没法按角色筛」。
{
  assert.ok(
    prototype.includes('id="prospectBuyerOnlyToggle"') && prototype.includes("只看决策人/采购人邮箱"),
    "搜客清单必须有「只看决策人/采购人邮箱」开关（否则 CLI 获客的准入口径在界面上无法验证）"
  );
  assert.ok(
    /\.prospect-buyer-toggle\s*\{[^}]*margin-left:\s*auto/s.test(prototype),
    "角色筛选开关必须靠右独立成 pill，不能塞进 .prospect-tabs（那条规则会把按钮压成无边框页签）"
  );
  assert.ok(
    /function\s+prospectBuyerContacts\(/.test(apiLayer)
      && /function\s+prospectBuyerRoleBadge\(/.test(apiLayer),
    "候选清单必须按 reasonCodes 识别决策人/采购人并给出角色徽章"
  );
  assert.ok(
    /state\.prospectBuyerOnly\s*&&\s*!prospectBuyerContacts\(item\)\.length/.test(apiLayer),
    "「只看决策人/采购人邮箱」开关必须真的参与过滤，不能只是视觉状态"
  );
  assert.ok(
    apiLayer.includes('"决策人邮箱"') && apiLayer.includes('"采购人邮箱"'),
    "角色徽章要区分决策人与采购人，不能只写一个笼统的「有邮箱」"
  );
  assert.ok(
    /openCliAcquireModal[\s\S]{0,1200}?决策人或采购人/.test(apiLayer),
    "CLI 获客弹窗必须提前说明硬门槛（找不到决策人/采购人邮箱的公司不入池）"
  );
  assert.ok(
    /stats\.rejected/.test(apiLayer),
    "CLI 获客完成后必须回报「多少家因缺决策人/采购人邮箱未入池」，否则用户会以为漏数据"
  );
}

// 供应商管理（仿「客户管理」：列表 + 筛选 + 分页 + 详情抽屉 + 新增/编辑/删除）
{
  assert.ok(/data-view="suppliers"/.test(prototype), "侧栏必须有「供应商管理」入口，否则视图进不去");
  assert.ok(
    /<details class="nav-section" aria-label="供应商管理"[\s\S]{0,700}data-view="suppliers"/.test(prototype),
    "供应商必须是侧栏的独立分栏，不能塞在「客户管理」下面当一个二级按钮"
  );
  assert.ok(
    /<div class="view" id="suppliers">[\s\S]{0,1200}customer-filter-row customer-view-filter[\s\S]{0,900}customer-list-workspace/.test(prototype),
    "供应商列表要复用客户管理的骨架（筛选行 + 列表工作区），另起一套样式就和客户管理长得不一样了"
  );
  assert.ok(/<div class="view" id="suppliers">/.test(prototype), "供应商视图容器必须存在");
  assert.ok(
    prototype.includes('id="suppliersTableBody"') && prototype.includes('id="supplierDrawer"'),
    "供应商列表与详情抽屉的挂载点必须存在"
  );
  assert.ok(
    /suppliers:\s*"supplier\.read"/.test(apiLayer),
    "供应商视图必须挂 supplier.read 权限，不能裸奔给所有账号"
  );
  assert.ok(
    /async function loadSuppliers[\s\S]{0,200}?api<\{ suppliers: Supplier\[\] \}>\("\/api\/suppliers"\)/.test(apiLayer),
    "供应商列表必须来自 /api/suppliers，不能在本地造假数据"
  );
  assert.ok(
    /async function saveSupplier[\s\S]{0,2600}?\/api\/suppliers/.test(apiLayer),
    "保存供应商必须走后端接口（新增 POST / 编辑 PATCH），不能只改内存"
  );
  assert.ok(
    apiLayer.includes('"/api/suppliers/bulk-delete"'),
    "删除供应商务必走确认后的批量删除接口（单条与多条同一条链路）"
  );
  assert.ok(
    /if \(view !== "suppliers"\) closeSupplierDrawer\(\)/.test(apiLayer),
    "离开供应商页必须收起详情抽屉，否则回到该页会自己弹开"
  );
  assert.ok(
    /"supplier-editor-modal"/.test(apiLayer) && /supplier-editor-modal/.test(prototype),
    "供应商编辑弹窗的专属宽度类必须在两处都声明，否则字段会被 520px 的基础弹窗挤成一团"
  );
  assert.ok(
    /function renderSupplierBulkToolbar[\s\S]{0,900}?data-supplier-bulk-delete/.test(apiLayer),
    "供应商列表要有和客户管理同一条批量工具条（全选 / 已选计数 / 批量删除 / 导出）"
  );
  assert.ok(
    /function exportSuppliers[\s\S]{0,1600}?text\/csv/.test(apiLayer),
    "批量导出必须真出文件（CSV + BOM），不能挂一个没实现的按钮"
  );
  assert.ok(
    /function syncSupplierStatusNav\(\)[\s\S]{0,700}?\[data-view="suppliers"\]/.test(apiLayer),
    "侧栏「全部/合作中/考察中/已停用」与页内状态筛选必须共享同一份状态，否则两边会各说各话"
  );
  assert.ok(
    /setButtonPending\(saveButton, true/.test(apiLayer),
    "保存供应商要有防重复提交（按钮进入 pending），否则连点会重复建档"
  );
  // —— 颜值对齐：结构抄对了但皮肤没抄，是供应商列表比客户列表「廉价」的真正原因 ——
  assert.ok(
    /#suppliers \.table-wrap \{[^}]*border-radius: 14px[^}]*box-shadow/.test(prototype)
      && /#suppliers \.panel\.section \{ padding: 18px; \}/.test(prototype)
      && /#suppliers tbody tr \{ height: 73px/.test(prototype),
    "供应商表格必须套用客户管理那套皮肤（18px 内边距 / 14px 圆角 + 投影 / 73px 行高），只继承全局 table 样式会比客户表矮一档"
  );
  assert.ok(
    /#suppliers table \{ min-width: 0; \}/.test(prototype),
    "供应商表格要放开全局 min-width:900px，否则窄栏里会横向滚动"
  );
  assert.ok(
    /<th>供应商名称<\/th><th>供应品类<\/th><th>供应等级<\/th><th>联系方式<\/th>/.test(prototype),
    "供应商表格必须是 8 列（与客户管理同列数）：分级与状态合并成「供应等级」，多一列会把名称列压到 241px"
  );
  assert.ok(
    /function supplierGradeChip[\s\S]{0,600}?customer-grade customer-grade-/.test(apiLayer),
    "供应分级必须复用客户管理「客户价值」的字母方块（customer-grade），用 badge 会变成一颗横躺的大药丸"
  );
  // 正则不跨函数体扫：先切出 supplierContactCell 的函数体，再在体内断言两行结构
  const supplierContactBody = (() => {
    const start = apiLayer.indexOf("function supplierContactCell");
    if (start < 0) return "";
    const end = apiLayer.indexOf("function supplierUpdatedCell", start);
    return apiLayer.slice(start, end > start ? end : start + 2000);
  })();
  assert.ok(
    /sup-contact-primary/.test(supplierContactBody) && /sup-contact-secondary/.test(supplierContactBody),
    "联系方式必须拆成固定两行（邮箱 / 电话·官网），一串链接用 · 连接会在窄列折成三行、行高参差"
  );
  assert.ok(
    /#suppliers \.customer-mobile-meta \{ display: flex/.test(prototype),
    "供应商移动卡片的元信息 chip 样式要单独声明：#customers 作用域里的那批选择器管不到供应商"
  );
  assert.ok(
    !/sup-mobile-meta|sup-badge-cell/.test(prototype + apiLayer),
    "旧的供应商专用小类（sup-mobile-meta / sup-badge-cell）已并入客户管理同款，不能残留"
  );

  // —— 供应商编码：类型 / 表单 / 列表 / 导出四段都要通，只在后端加列等于没做 ——
  assert.ok(
    /interface Supplier \{[\s\S]{0,300}?code: string;/.test(apiLayer),
    "前端 Supplier 类型必须带 code，否则编码拿不到，列表和导出这一列永远是空的"
  );
  assert.ok(
    /id="supplierCodeInput"/.test(apiLayer) && /code: qs<HTMLInputElement>\("#supplierCodeInput"\)/.test(apiLayer),
    "供应商弹窗要有编码输入，且保存时真的提交 code（只有输入框不提交等于没做）"
  );
  assert.ok(
    /supplier\.code \? `<b class="sup-code">/.test(apiLayer),
    "列表必须显示供应商编码（等宽小字），否则同名供应商对不上号"
  );
  assert.ok(
    /\["供应商编码", "供应商名称"/.test(apiLayer) && /item\.code, item\.company/.test(apiLayer),
    "导出 CSV 必须带编码列，且列头与数据同序"
  );
  assert.ok(
    /#suppliers \.sup-code, #supplierDrawer \.sup-code \{/.test(prototype),
    "编码要有独立样式（等宽字体），混在正文里看不出这是编号"
  );

  // —— 供应商文件：走文件中心的 file_references，不另造一套附件表 ——
  assert.ok(
    /id="supplierFileList"/.test(apiLayer) && /id="supplierFileUploadButton"/.test(apiLayer),
    "供应商抽屉必须有文件列表与上传入口"
  );
  assert.ok(
    /\/api\/files\?entityType=supplier&entityId=/.test(apiLayer),
    "供应商文件必须按 file_references 查询，不能另造一套附件存储"
  );
  assert.ok(
    /contextType=supplier&contextId=/.test(apiLayer) && /contextType: "supplier"/.test(apiLayer),
    "上传必须带 contextType=supplier：直传与分片两条路都要，漏一条大文件就传不进去"
  );
  assert.ok(
    /\/recycle`,/.test(apiLayer) && /reason: "供应商附件移除"/.test(apiLayer),
    "移除附件必须走回收站（可恢复），不能物理删除"
  );
  assert.ok(
    /#supplierDrawer \.sup-file-row \{ display: grid/.test(prototype),
    "抽屉里的文件行要有自己的布局样式，否则文件名与三个按钮会挤成一行"
  );
  assert.ok(
    /#supplierDrawer \.sup-file-ops \{ grid-column: 1 \/ -1;/.test(prototype),
    "手机抽屉必须把文件操作按钮换到第二行，否则 420px 下文件名只剩几个字"
  );
}

// ---- 自动流：必须是真实链路，不许退回计时器动画（2026-11-03） ----
assert.equal(apiLayer.includes("autoFlowStartTicking"), false, "自动流不得残留旧的计时器模拟引擎");
assert.match(apiLayer, /gj\.autoflow\.v2/u, "自动流状态键升到 v2，避免读到旧版预演状态");
assert.match(apiLayer, /autoFlowRunProspect\(token: number\)[\s\S]{0,3000}\/api\/lead-finder\/parse-goal"/u, "获客节点必须先用 AI 解析自然语言目标");
assert.match(apiLayer, /autoFlowRunProspect\(token: number\)[\s\S]{0,5000}\/api\/lead-finder\/lfind-tasks"/u, "获客节点必须提交 Lfind 任务（本地 Runner → 本机 CLI）");
assert.match(apiLayer, /autoFlowRunResearch\(token: number\)[\s\S]{0,2500}\/api\/ai-background-research"/u, "背调节点必须调真实背调接口");
assert.match(apiLayer, /autoFlowRunCompose\(token: number\)[\s\S]{0,2500}\/api\/development-email\/draft"/u, "写信节点必须调真实草稿接口");
assert.match(apiLayer, /autoFlowRunSend\(token: number\)[\s\S]{0,2500}\/api\/development-email\/send"/u, "发送节点必须走真实发送接口");
assert.match(apiLayer, /if \(!artifacts\.sendConfirmed\) \{[\s\S]{0,600}autoFlowSendPending = true;/u, "发送节点必须在拿到人工确认前暂停，不得自动外发");
assert.match(apiLayer, /data-af-action="send-confirm"[\s\S]{0,400}data-af-action="send-skip"/u, "发送确认区必须同时提供确认与跳过两个动作");
assert.match(apiLayer, /autoFlowConfirmSend\(action\.dataset\.afAction === "send-confirm"\)/u, "确认/跳过必须经事件委托接到 autoFlowConfirmSend");
assert.match(apiLayer, /autoFlowPausePoint\(key: string\)[\s\S]{0,800}autoFlowPauseRequested/u, "暂停必须是协作式检查点，不打断真实任务");
assert.match(apiLayer, /function autoFlowStart\(\) \{[\s\S]{0,400}autoFlowSyncCommandFromDom\(state\);/u, "启动/继续前必须以输入框为准回写目标，否则重置后会出现「输入框有字却报先用一句话描述」");
assert.match(apiLayer, /function autoFlowRenderCommand\(\)[\s\S]{0,500}if \(state\.command\) input\.value = state\.command;/u, "状态为空时不得清空输入框：界面有字、状态为空是最难查的错位");
assert.match(apiLayer, /artifacts\.lfindTaskId = undefined;[\s\S]{0,200}throw new Error\(`没有候选入池/u, "终态失败的 Lfind 任务必须清掉任务号，否则重试永远卡在同一个坏任务上");

// —— 客户成交状态：弹窗可编辑、默认未成交、保存必须真的提交 lifecycleStatus（2026-11-05） ——
assert.match(
  apiLayer,
  /<label class="form-field"><span>成交状态<\/span><select id="customerLifecycleInput"><option value="open" \$\{customerLifecycle !== "won" \? "selected" : ""\}>未成交<\/option>/u,
  "客户弹窗必须有成交状态下拉：未成交在前且为默认选中（open），已成交第二项"
);
assert.match(
  apiLayer,
  /const customerLifecycle = customer\?\.lifecycleStatus === "won" \? "won" : "open";/u,
  "编辑客户时按当前状态回显，没有值的旧客户一律当未成交"
);
assert.match(
  apiLayer,
  /lifecycleStatus: \(qs<HTMLSelectElement>\("#customerLifecycleInput"\)\?\.value === "won" \? "won" : "open"\)/u,
  "保存客户必须真的提交 lifecycleStatus，只有下拉框不提交等于没做"
);
assert.match(
  apiLayer,
  /商机阶段确认为「成交」时这里会自动变为已成交/u,
  "成交状态要带一句来源提示：商机确认成交会自动改写，避免误以为只能手动改"
);

// ---- 开发信三件套：打开/点击可见、DKIM 签名、发件邮箱池日限额（2026-11-09） ----
{
  const outreachSource = readFileSync(new URL("./modules/outreach.ts", import.meta.url), "utf8");
  const profileSource = readFileSync(new URL("./modules/profile.ts", import.meta.url), "utf8");
  const authSource = readFileSync(new URL("../../backend/src/auth.ts", import.meta.url), "utf8");
  const mailboxSource = readFileSync(new URL("../../backend/src/sender-mailbox.ts", import.meta.url), "utf8");
  const serverCoreSource = readFileSync(new URL("../../backend/src/server-core.ts", import.meta.url), "utf8");

  // ① 打开/点击：像素与点击跳转在后端早已落地，前端不展示 = 用户仍然「不知道客户看没看」
  assert.ok(
    prototype.includes("<th>打开 / 点击</th>"),
    "发信明细缺少「打开 / 点击」列：追踪数据存了却没人看得见"
  );
  assert.ok(
    outreachSource.includes("<td>${outreachJourneyEngagementCell(item)}</td>"),
    "发信明细行没有接入打开/点击单元格（只加表头不加单元格，整行会错位）"
  );
  assert.equal(
    outreachSource.includes('colspan="7"'),
    false,
    "表头已扩到 8 列，任何残留的 colspan=7 都会让加载态/空态整行错位"
  );
  assert.ok(
    outreachSource.includes("打开 ${item.openCount}"),
    "手机卡片没有显示打开数：窄屏用户完全看不到追踪结果"
  );

  // ② DKIM：nodemailer 只在 mailOptions 带 dkim 时才签名；配了不注入 = 配了白配
  assert.match(
    serverCoreSource,
    /\.\.\.\(user\.dkimDomain && user\.dkimSelector && user\.dkimPrivateKey \? \{\s*dkim: \{/u,
    "发信没有注入 DKIM 选项：账号里配了域名/selector/私钥也不会真的签名"
  );
  assert.ok(
    prototype.includes('id="profileDkimDomain"')
      && prototype.includes('id="profileDkimSelector"')
      && prototype.includes('id="profileDkimPrivateKey"'),
    "个人资料页缺 DKIM 三个输入：用户没地方配域名/selector/私钥"
  );
  assert.ok(
    authSource.includes("hasDkimPrivateKey: Boolean(user.dkimPrivateKey)"),
    "接口必须只回 hasDkimPrivateKey，不能把 DKIM 私钥回显给前端"
  );
  assert.equal(
    /dkimPrivateKey: user\.dkimPrivateKey/.test(authSource),
    false,
    "会话数据里回显了 DKIM 私钥（只允许回布尔 hasDkimPrivateKey）"
  );
  assert.ok(
    /\.\.\.\(qs<HTMLTextAreaElement>\("#smbDkimPrivateKey"\)\?\.value \? \{ dkimPrivateKey:/.test(profileSource),
    "池子邮箱编辑时私钥留空必须不提交该字段（否则保存一次就把已有私钥抹掉）"
  );
  assert.ok(
    mailboxSource.includes('input.dkimPrivateKey !== undefined ? input.dkimPrivateKey : existing.dkimPrivateKey'),
    "更新池子邮箱时留空必须沿用原私钥，不能写成空串"
  );

  // ③ 发件邮箱池日限额：轮换的意义是保护主邮箱，全部到限时必须暂停而不是回落主邮箱
  assert.ok(
    /dkimPrivateKey: mailbox\.dkimPrivateKey \|\| ""/.test(mailboxSource),
    "池子邮箱覆盖发件身份时必须带 DKIM：换到池子邮箱后签名就丢了"
  );
  assert.ok(
    mailboxSource.includes('ensureSenderMailboxColumn(pool, "daily_limit"'),
    "sender_mailboxes 没有 daily_limit 列：老库升级后日限额无处存"
  );
  assert.ok(
    /export function pickSenderMailbox\([\s\S]{0,200}skipEmails/u.test(mailboxSource),
    "pickSenderMailbox 必须支持跳过已达日限额的邮箱"
  );
  assert.ok(
    serverCoreSource.includes("发件邮箱池今日额度已用完"),
    "全部邮箱到限额时必须暂停本批次，不能悄悄回落主发件邮箱（保护主邮箱才是本功能目的）"
  );
  assert.ok(
    serverCoreSource.includes('senderEmail: user.outboundEmail || ""'),
    "台账必须记录实际发件邮箱（senderEmail），否则日限额算不出来"
  );
}

console.log(JSON.stringify({ ok: true, checked: required.length }, null, 2));
