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
  "/api/tools/ocr/jobs/ocr1/sync-lead",
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
  "加入线索失败",
  "/conversion-preview",
  "转为客户",
  "createDeal",
  "pipelineAmount",
  "/api/leads?trash=true",
  "sourceEvents",
  "leadPermanentConfirmInput",
  "加入线索中心",
  "leadSourceCenterButton",
  "leadSourceChips",
  "openLeadSourceCenter",
  "data-ls-import",
  "返回并导入链接",
  "leadFinderDetailSaveButton",
  "leadFinderDetailQualificationButton",
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
  "可加入线索的候选",
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
  "加入候选池时间",
  "prospect-mobile-detail-open",
  "prospectRadarDialog",
  "data-lead-live-radar",
  "buildProspectRadarModel",
  "buildProspectPoolRadarModel",
  "data-lead-pool-radar",
  "关系连线仅来自已记录证据"
];

for (const token of required) {
  if (!prototype.includes(token) && !apiLayer.includes(token)) throw new Error(`missing ${token}`);
}

assert.equal(prototype.includes("data-view=\"inbox\""), false, "消息通知不应出现在左侧导航");
assert.equal(prototype.includes("写站内信"), false, "通知中心不应提供人工写信入口");
assert.equal(apiLayer.includes("openInternalMessageComposeModal"), false, "不应保留旧写信交互");
assert.equal(apiLayer.includes("leadFinderDetailMarkButton"), false, "自动获客不应保留标记可联系的授权语义");
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
assert.match(apiLayer, /来源返回 \/ 候选池 \/ RRQ \/ VQA/, "标准和超级搜客详情必须展示统一四段漏斗");
assert.match(apiLayer, /partial_success: "部分成功"/, "部分成功只能保留在任务详情验收结论中");
assert.match(apiLayer, /failed: "失败"/, "失败只能保留在任务详情验收结论中");
assert.equal(apiLayer.includes("部分完成"), false, "任务与来源状态不得使用容易误解的“部分完成”提示");
assert.match(apiLayer, /function localDateInputBoundary[\s\S]*new Date\(Number\(match\[1\]\), Number\(match\[2\]\) - 1, Number\(match\[3\]\)\)/, "加入时间必须按本地日期构造，不能把日期输入误解析为 UTC");
assert.match(apiLayer, /localDateInputBoundary\(state\.prospectJoinedTo, 1\)/, "自定义结束日期必须使用次日零点作为排他边界");
assert.match(apiLayer, /function syncLeadFinderLiveTransport[\s\S]*startLeadTaskEventStream/, "自动搜客主界面与详情必须共用实时任务传输入口");
assert.match(apiLayer, /function applySuperSearchMission[\s\S]*const rounds = Array\.isArray\(mission\.rounds\)/, "超级搜索首屏缺少轮次快照时不能因 undefined 崩溃");
assert.match(apiLayer, /if \(result\.superSearch\) \{[\s\S]*applySuperSearchMission\(backendJob, result\.superSearch\)[\s\S]*超级搜索已进入队列，详细轮次正在同步/, "超级搜索快照增强失败时任务也必须先显示在队列");
assert.equal(apiLayer.includes("parseGoalToBrief"), false, "AI 解析失败后不得使用本地规则伪装成成功结果");
assert.match(apiLayer, /async function runLeadAiParse\(\): Promise<boolean>[\s\S]*catch \(err\)[\s\S]*clearLeadAiPreview\(true\)[\s\S]*未生成解析结果[\s\S]*return false;/, "AI 解析失败必须清空预览、明确报错并返回失败");
const leadFinderLaunchFlow = apiLayer.slice(
  apiLayer.indexOf("async function runLeadFinder"),
  apiLayer.indexOf("async function syncLeadFinderRows")
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
assert.match(apiLayer, /view === "database-maintenance"[\s\S]*user\?\.role === "admin"[\s\S]*user\?\.role === "super_admin"/, "数据库维护页面必须限制管理员角色");
assert.match(apiLayer, /连接中断，正在重连/, "数据库任务断流必须进入重连状态而非误报失败");
assert.match(apiLayer, /if \(!canAccessWorkspaceView\(view\)\) \{[\s\S]*view = "dashboard";/, "页面切换必须阻止业务员进入系统设置");
assert.match(apiLayer, /workspaceView: "gj_workspace_view"/, "工作区必须记录当前活动模块，避免刷新后退回主页");
assert.match(apiLayer, /sessionStorage\.setItem\(workspaceViewStorageKey\(\), view\)/, "导航切换必须按当前账号记住活动模块");
assert.match(apiLayer, /restoreSession\(\)[\s\S]*activateNavView\(rememberedWorkspaceView\(user\)\)/, "会话恢复后必须回到刷新前的模块");
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
const pipelineNavIndex = prototype.indexOf('data-view="pipeline" title="商机"');
const customerPoolNavIndex = prototype.indexOf('data-view="customer-pool" title="客户公池"');
const whatsappNavIndex = prototype.indexOf('data-view="whatsapp" title="Communication"');
assert.ok(pipelineNavIndex >= 0 && pipelineNavIndex < customerPoolNavIndex && customerPoolNavIndex < whatsappNavIndex, "customer pool and WhatsApp must follow pipeline in primary navigation");

console.log(JSON.stringify({ ok: true, checked: required.length }, null, 2));
