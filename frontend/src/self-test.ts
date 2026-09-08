import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { resolveLeadAiSearchDraft } from "./lead-ai-search.js";
import {
  isLeadSourceAutoSelected,
  isLeadSourceExecutable,
  resolveLeadSearchSources
} from "./lead-source-selection.js";

const prototype = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const apiLayer = readFileSync(new URL("./prototype-api.ts", import.meta.url), "utf8");
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
  "refreshVisibleDashboard",
  "requestDashboardRefresh",
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
  "保留并转为线索",
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
assert.match(apiLayer, /deckTicker\.innerHTML = logs\.length \? seq \+ seq : seq/u, "空回流状态不得重复渲染滚动提示");

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
assert.match(apiLayer, /isAccessControlView\(view\) && user\.role === "super_admin"[\s\S]*platform\.tenant\.metadata\.read/, "超级管理员必须能以平台只读权限进入权限管理");
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
assert.match(apiLayer, /function prospectLookupDiagnosis[\s\S]*这不代表企业不存在/, "联系人缺失必须提供业务可理解的原因说明");
assert.match(apiLayer, /data-lead-lookup-reason/, "联系人和联系方式未找到状态必须可以点击查看原因");
assert.match(apiLayer, /function leadFinderNoResultReasons[\s\S]*清洗规则/, "整次搜索无结果时必须汇总来源和清洗原因");
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
assert.match(prototype, /data-view="settings" data-scope="manager"/, "业务员导航中必须隐藏系统设置");
assert.match(prototype, /id="settings" data-scope="manager"/, "业务员视图中必须隐藏系统设置页面");
assert.match(prototype, /data-view="database-maintenance" data-scope="admin"/, "数据库维护导航必须只向管理员显示");
assert.match(prototype, /id="database-maintenance" data-scope="admin"/, "数据库维护必须使用独立页面");
assert.equal(prototype.includes("id=\"mysqlImportPanel\""), false, "数据库迁移不能继续嵌在账号管理页");
assert.match(apiLayer, /"database-maintenance": "database\.maintain"/, "数据库维护页面必须绑定数据库维护能力");
assert.match(apiLayer, /"member-management": "member\.read"/, "成员管理页面必须绑定成员查看能力");
assert.match(apiLayer, /"role-management": "role\.read"/, "角色管理页面必须绑定角色查看能力");
assert.match(apiLayer, /连接中断，正在重连/, "数据库任务断流必须进入重连状态而非误报失败");
assert.match(apiLayer, /if \(!canAccessWorkspaceView\(view\)\) \{[\s\S]*view = "dashboard";/, "页面切换必须阻止业务员进入系统设置");
assert.match(apiLayer, /workspaceView: "gj_workspace_view"/, "工作区必须记录当前活动模块，避免刷新后退回主页");
assert.match(apiLayer, /sessionStorage\.setItem\(workspaceViewStorageKey\(\), view\)/, "导航切换必须按当前账号记住活动模块");
assert.match(apiLayer, /restoreSession\(\)[\s\S]*activateNavView\(state\.iamCapabilities\?\.source === "platform" \? "platform-operations" : rememberedWorkspaceView\(user\)\)/, "会话恢复后必须按身份回到刷新前的模块");
assert.match(apiLayer, /selectedDailyReportId = message\.relatedId;[\s\S]*activateNavView\("daily-reports"\)/);
assert.match(apiLayer, /if \(view === "ai-agent"\) \{[\s\S]*renderAgent\(state\.agentRun\);[\s\S]*void loadAgentRuns\(\);[\s\S]*\}/, "进入 Agent 页面必须刷新运行记录与后台任务状态");
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
    { id: "paid", tier: "paid", ready: true, enabled: true, accessMode: "api", recommended: true }
  ], [], false),
  { sources: ["paid"], blocked: [], requiresSelection: false }
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

console.log(JSON.stringify({ ok: true, checked: required.length }, null, 2));
