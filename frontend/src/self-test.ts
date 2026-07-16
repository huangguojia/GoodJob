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
  "todo-board",
  "report-deck",
  "id=\"knowledge\"",
  "id=\"exam\"",
  "id=\"tools\"",
  "id=\"settings\"",
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
  "部分完成",
  "执行失败",
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
  "leadFinderDetailMarkButton",
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
  "查看日报"
];

for (const token of required) {
  if (!prototype.includes(token) && !apiLayer.includes(token)) throw new Error(`missing ${token}`);
}

assert.equal(prototype.includes("data-view=\"inbox\""), false, "消息通知不应出现在左侧导航");
assert.equal(prototype.includes("写站内信"), false, "通知中心不应提供人工写信入口");
assert.equal(apiLayer.includes("openInternalMessageComposeModal"), false, "不应保留旧写信交互");
assert.match(apiLayer, /selectedDailyReportId = message\.relatedId;[\s\S]*activateNavView\("daily-reports"\)/);
assert.equal(productConfig.productName, "GoodJob CRM");
assert.match(productConfig.version || "", /^\d+\.\d+$/);

assert.equal(isLeadSourceExecutable({ id: "ready", ready: true, enabled: true, accessMode: "api" }), true);
assert.equal(isLeadSourceExecutable({ id: "disabled", ready: true, enabled: false, accessMode: "api" }), false);
assert.equal(isLeadSourceExecutable({ id: "manual", ready: true, enabled: true, accessMode: "manual_assisted" }), false);
assert.deepEqual(
  resolveLeadSearchSources([
    { id: "ai_search", ready: true, enabled: true, accessMode: "api" },
    { id: "gleif", ready: true, enabled: true, accessMode: "api", recommended: true },
    { id: "wikidata", ready: true, enabled: false, accessMode: "api", recommended: true }
  ], [], false),
  { sources: ["gleif"], blocked: [], requiresSelection: false }
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

console.log(JSON.stringify({ ok: true, checked: required.length }, null, 2));
