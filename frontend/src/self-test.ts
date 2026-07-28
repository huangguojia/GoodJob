import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { isLeadSourceExecutable, resolveLeadSearchSources } from "./lead-source-selection.js";

const prototype = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const apiLayer = readFileSync(new URL("./prototype-api.ts", import.meta.url), "utf8");
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
  "/api/prospect-strategies/",
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
  "prospect-mobile-detail-open"
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
assert.match(apiLayer, /\["merged", "suppressed", "rejected"\]\.includes\(record\.outcome\)/, "清洗去除视图只能显示真实的归并、抑制与拒绝记录");
assert.match(prototype, /data-view="settings" data-scope="manager"/, "业务员导航中必须隐藏系统设置");
assert.match(prototype, /id="settings" data-scope="manager"/, "业务员视图中必须隐藏系统设置页面");
assert.match(prototype, /data-view="database-maintenance" data-scope="admin"/, "数据库维护导航必须只向管理员显示");
assert.match(prototype, /id="database-maintenance" data-scope="admin"/, "数据库维护必须使用独立页面");
assert.equal(prototype.includes("id=\"mysqlImportPanel\""), false, "数据库迁移不能继续嵌在账号管理页");
assert.match(apiLayer, /view === "database-maintenance"[\s\S]*user\?\.role === "admin"[\s\S]*user\?\.role === "super_admin"/, "数据库维护页面必须限制管理员角色");
assert.match(apiLayer, /连接中断，正在重连/, "数据库任务断流必须进入重连状态而非误报失败");
assert.match(apiLayer, /if \(!canAccessWorkspaceView\(view\)\) \{[\s\S]*view = "dashboard";/, "页面切换必须阻止业务员进入系统设置");
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
