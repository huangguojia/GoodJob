import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";
import { readFile } from "node:fs/promises";

async function loginWithCredentials(page: import("@playwright/test").Page, email: string, password: string, expectedName: string) {
  await page.goto("/");
  await page.locator("#loginEmail").fill(email);
  await page.locator("#loginPassword").fill(password);
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await expect(page.locator("#scopeUser")).toContainText(expectedName);
}

async function loginAsManager(page: import("@playwright/test").Page) {
  await loginWithCredentials(page, "alex@goodjob.com", "goodjob123", "Alex");
}

async function loginAsSales(page: import("@playwright/test").Page) {
  await loginWithCredentials(page, "shirley@goodjob.com", "goodjob123", "Shirley");
}

async function loginAsAdmin(page: import("@playwright/test").Page) {
  await loginWithCredentials(page, "admin@goodjob.com", "goodjob123", "Admin");
}

async function openView(page: import("@playwright/test").Page, view: string) {
  const button = page.locator(`.nav button[data-view="${view}"]`);
  if (!(await button.isVisible())) {
    const section = button.locator("xpath=ancestor::details[1]");
    if (await section.count()) {
      await section.locator("summary").click();
    }
  }
  await button.click();
  await expect(page.locator(`#${view}`)).toHaveClass(/active/);
}

async function apiFromPage<T>(
  page: import("@playwright/test").Page,
  path: string,
  init: { method?: string; body?: unknown } = {}
) {
  return page.evaluate(async ({ requestPath, requestInit }) => {
    const method = requestInit.method || "GET";
    const csrfToken = document.cookie
      .split("; ")
      .find((part) => part.startsWith("gj_csrf="))
      ?.split("=")
      .slice(1)
      .join("=");
    const response = await fetch(requestPath, {
      method,
      headers: {
        "content-type": "application/json",
        ...(!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) && csrfToken
          ? { "x-csrf-token": decodeURIComponent(csrfToken) }
          : {})
      },
      body: requestInit.body === undefined ? undefined : JSON.stringify(requestInit.body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `Request failed: ${response.status}`);
    return result;
  }, { requestPath: path, requestInit: init }) as Promise<T>;
}

function buildQuestionWorkbookBuffer() {
  const worksheet = XLSX.utils.json_to_sheet([
    {
      "题干": "Excel导入压力仪表：客户询价时第一步确认什么？",
      "类目": "仪表产品",
      "选项A": "量程、精度、接口、介质和工况",
      "选项B": "客户名片颜色",
      "选项C": "包装偏好",
      "正确答案": "A",
      "解析": "仪表报价必须先确认关键工况参数。",
      "难度": "基础"
    },
    {
      "题干": "Excel导入防爆仪表：需要优先确认什么？",
      "类目": "仪表产品",
      "选项A": "防爆等级、认证体系和使用区域",
      "选项B": "是否需要彩盒",
      "选项C": "客户头像",
      "选项D": "安装区域危险等级",
      "正确答案": "A,D",
      "解析": "防爆类产品必须确认认证和使用区域。",
      "难度": "高阶",
      "题型": "多选"
    }
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "题库");
  return Buffer.from(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}

function buildCustomerWorkbookBuffer(company: string) {
  const worksheet = XLSX.utils.json_to_sheet([
    {
      "公司名": company,
      "国家": "德国",
      "联系人": "Import Buyer",
      "阶段": "询盘",
      "预计金额": 23000,
      "健康度": 74,
      "下一提醒": "明天 11:00",
      "企微绑定": "已绑定"
    }
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "客户导入");
  return Buffer.from(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}

test.describe("GoodJob CRM prototype pages", () => {
  let runId: string;

  test.beforeEach(async ({ page }) => {
    runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await loginAsManager(page);
    await expect(page.locator("#roleSwitcher")).toHaveCount(0);
  });

  test("topbar works as a global command bar with scoped customer actions", async ({ page }) => {
    const topContext = page.locator("#topActionContext");
    const topSearch = page.locator("#topSearchWrap");
    const topPrimary = page.locator("#topPrimaryAction");
    const topImport = page.locator("#topImportButton");
    const topExport = page.locator("#topExportButton");

    await expect(topSearch).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#topSearchInput")).toHaveAttribute("placeholder", "全局搜索 / 输入模块名后回车跳转");
    await expect(topContext).toHaveClass(/is-hidden/);
    await expect(page.locator("#topTodoCount")).toHaveText(/\d+/);
    await expect(page.locator("#topReminderCount")).toHaveText(/\d+/);
    await expect(page.locator("#topOpenTabs [data-tab-view='dashboard']")).toHaveClass(/active/);

    await page.locator("#topSearchInput").fill("考试");
    await page.locator("#topSearchInput").press("Enter");
    await expect(page.locator("#exam")).toHaveClass(/active/);
    await expect(page.locator("#topOpenTabs [data-tab-view='exam']")).toHaveClass(/active/);
    await expect(topSearch).not.toHaveClass(/is-hidden/);
    await expect(topContext).toHaveClass(/is-hidden/);
    await expect(topPrimary).toBeHidden();

    await openView(page, "reports");
    await expect(page.locator("#reports")).toHaveClass(/active/);
    await expect(page.locator("#topOpenTabs [data-tab-view='reports']")).toHaveClass(/active/);
    await expect(topSearch).not.toHaveClass(/is-hidden/);
    await expect(topContext).toHaveClass(/is-hidden/);
    await expect(page.locator("#reports .page-head")).toContainText("导出文本报告");

    await openView(page, "customers");
    await expect(topSearch).not.toHaveClass(/is-hidden/);
    await expect(topContext).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#topSearchInput")).toHaveAttribute("placeholder", "搜索客户、联系人、国家或产品");
    await expect(topPrimary).toContainText("新增客户");
    await expect(topImport).toBeVisible();
    await expect(topExport).toBeVisible();

    await openView(page, "exam");
    await expect(topSearch).not.toHaveClass(/is-hidden/);
    await expect(topContext).toHaveClass(/is-hidden/);
    await expect(topPrimary).toBeHidden();
    await expect(topImport).toBeHidden();
    await expect(topExport).toBeHidden();
    await expect(page.locator("#exam .page-head .btn.primary")).toContainText("发布考试");
  });

  test("dashboard todo workflow is interactive", async ({ page }) => {
    const title = `自动化待办-${runId}`;
    await expect(page.locator("#dashboard .todo-list")).toBeVisible();
    const periodTabs = page.locator(".dashboard-period-tabs");
    await expect(periodTabs.locator("button")).toHaveCount(3);
    await expect(periodTabs).toContainText("今日");
    await expect(periodTabs).toContainText("本周");
    await expect(periodTabs).toContainText("本月");
    await expect(periodTabs.locator("[data-dashboard-period='today']")).toHaveClass(/active/);
    await expect(page.locator(".focus-metric").nth(2)).toContainText("今日预计成交金额");
    await expect(page.locator(".focus-title h2")).toContainText("今日");
    await expect(page.locator("#briefingBasis")).toContainText("依据");
    await expect(page.locator("#briefingAction")).toContainText("建议动作");
    await expect(page.locator("#briefingImpact")).toContainText("业务影响");
    const leadFunnel = page.locator("#dashboardLeadFunnel");
    await expect(page.locator("#dashboard .section-title", { hasText: "线索漏斗" })).toContainText("进入、清洗与转化");
    await expect(leadFunnel.locator(".lead-funnel-stage-row")).toHaveCount(5);
    await expect(leadFunnel.locator("[data-lead-funnel-chart] svg")).toBeVisible();
    await expect(leadFunnel).toContainText("待清洗");
    await expect(leadFunnel).toContainText("已建商机");
    await expect(leadFunnel.locator(".lead-funnel-filtered")).toContainText("无效 / 重复线索");
    await expect(leadFunnel.locator(".lead-funnel-summary")).toContainText("转商机率");
    const dashboardSummary = await apiFromPage<{
      periods: Record<"today" | "week" | "month", {
        expectedDeals: number;
        expectedAmounts: Array<{ currency: string; amount: number }>;
        highPriorityTodos: number;
        newLeads: number;
        briefing: {
          title: string;
          description: string;
          basis: string;
          action: string;
          impact: string;
        };
      }>;
      leadFunnel: {
        stages: Array<{ key: string; label: string; count: number; conversionRate: number }>;
        todayAdded: number;
        filteredOut: number;
        dealConversionRate: number;
      };
    }>(page, "/api/dashboard/summary");
    await periodTabs.locator("[data-dashboard-period='month']").click();
    await expect(periodTabs.locator("[data-dashboard-period='month']")).toHaveClass(/active/);
    await expect(page.locator(".focus-metric").nth(2)).toContainText("本月预计成交金额");
    await expect(page.locator(".focus-metric").nth(2)).toContainText(`${dashboardSummary.periods.month.expectedDeals} 个预计成交商机`);
    await expect(page.locator(".focus-metric").nth(1)).toContainText(`本月高优先级待办`);
    await expect(page.locator(".focus-metric").nth(1)).toContainText(`${dashboardSummary.periods.month.highPriorityTodos} 项`);
    await expect(page.locator(".focus-metric").nth(3)).toContainText(`本月新增线索`);
    await expect(page.locator(".focus-metric").nth(3)).toContainText(`${dashboardSummary.periods.month.newLeads} 条`);
    await expect(page.locator(".focus-title h2")).toHaveText(dashboardSummary.periods.month.briefing.title);
    await expect(page.locator(".focus-title p")).toHaveText(dashboardSummary.periods.month.briefing.description);
    await expect(page.locator("#briefingBasis")).toHaveText(dashboardSummary.periods.month.briefing.basis);
    await expect(page.locator("#briefingAction")).toHaveText(dashboardSummary.periods.month.briefing.action);
    await expect(page.locator("#briefingImpact")).toHaveText(dashboardSummary.periods.month.briefing.impact);
    const renderedStages = await leadFunnel.locator(".lead-funnel-stage-row").evaluateAll((rows) => rows.map((row) => ({
      key: (row as HTMLElement).dataset.leadFunnelKey,
      count: Number(row.getAttribute("aria-label")?.match(/\s(\d+)\s条/)?.[1] || 0)
    })));
    expect(renderedStages).toEqual(dashboardSummary.leadFunnel.stages.map((stage) => ({
      key: stage.key,
      count: stage.count
    })));
    await expect(leadFunnel.locator(".lead-funnel-filtered")).toContainText(String(dashboardSummary.leadFunnel.filteredOut));
    await leadFunnel.locator("[data-lead-funnel-key='pending']").click();
    await expect(page.locator("#leads")).toHaveClass(/active/);
    await expect(page.locator("#leadStageChips .lead-chip.active")).toContainText("新线索");
    await openView(page, "dashboard");
    await expect(page.locator("#dashboard .section-title", { hasText: "管道健康度" })).toContainText("真实商机阶段");
    await expect(page.locator("#dashboard .bars")).toContainText("单");
    await expect(page.locator("#dashboard .bars")).toContainText("$");
    const pipelineHealthRows = await page.locator("#dashboard .bars .bar-row").evaluateAll((rows) => rows.map((row) => {
      const fill = row.querySelector<HTMLElement>(".fill");
      return {
        stage: row.querySelector("span")?.textContent || "",
        count: Number(row.getAttribute("data-count") || 0),
        fillWidth: fill ? Number.parseFloat(fill.style.width || "0") : 0
      };
    }));
    expect(pipelineHealthRows.some((row) => row.stage === "丢单")).toBe(false);
    expect(pipelineHealthRows.filter((row) => row.count === 0).every((row) => row.fillWidth === 0)).toBe(true);
    await expect(page.locator("#dashboard .task-list .task").first()).toContainText("分");
    await expect(page.locator("#dashboard .task-list .task").first()).toContainText("金额权重");
    await expect(page.locator("#dashboardPeriodTabs")).toHaveCount(0);
    await expect(page.locator("#businessScopeTag")).toContainText("团队业务");
    await expect(page.locator("#todoScopeTag")).toContainText("本人待办");
    await expect(page.locator("#morningViewButton")).toBeVisible();
    await expect(page.locator("#morningPanel")).not.toHaveClass(/active/);
    await page.locator("#morningViewButton").click();
    await expect(page.locator("#morningPanel")).toHaveClass(/active/);
    await expect(page.locator("#morningSubtitle")).toContainText("今日晨会同步");
    await expect(page.locator("#morningRisk")).toContainText("$");
    await expect(page.locator("#dashboard-knowledge-panel")).toHaveCount(0);
    await expect(page.locator("#dashboard-exam-panel")).toHaveCount(0);
    await expect(page.locator("#dashboard-gap-panel")).toHaveCount(0);
    await page.locator("#batchPriorityButton").click();
    await expect(page.locator(".toast").last()).toContainText(/已生成|无需重复生成/);
    const todoInsight = page.locator("#dashboard .todo-score-card").filter({ hasText: "今日待办" }).locator("b");
    const beforeTodoCount = Number(await todoInsight.textContent());
    const quickTitle = `快速新增待办-${runId}`;

    await page.locator(".quick-add input").fill(quickTitle);
    await page.locator(".quick-add input").press("Enter");
    await expect(page.locator("#appModal")).not.toHaveClass(/active/);
    await expect(page.locator(".quick-add input")).toHaveValue("");
    await expect(page.locator("#dashboard .todo-list")).toContainText(quickTitle);
    const quickRow = page.locator("#dashboard .todo-row", { hasText: quickTitle }).first();
    await quickRow.click();
    await expect(page.locator(".toast").last()).not.toContainText("未设置关联对象和目标完成时间");
    await quickRow.dblclick();
    await expect(page.locator("#appModal")).not.toHaveClass(/active/);
    await quickRow.locator(".todo-more").click();
    await quickRow.locator("[data-todo-action='edit']").click();
    await expect(page.locator("#appModal")).toHaveClass(/active/);
    await expect(page.locator("#modalTitle")).toContainText("编辑待办");
    await page.locator("#todoTitleInput").fill(`${quickTitle}-编辑中`);
    await page.locator("#appModal").click({ position: { x: 8, y: 8 } });
    await expect(page.locator("#appModal")).toHaveClass(/active/);
    await expect(page.locator("#todoTitleInput")).toHaveValue(`${quickTitle}-编辑中`);
    await page.locator("[data-modal-close]").first().click();

    await page.getByRole("button", { name: "新增待办" }).click();
    await expect(page.locator("#appModal")).toHaveClass(/active/);
    await expect(page.locator("#todoTypeInput")).toHaveValue("other");
    await expect(page.locator("#modalBody label", { hasText: "目标完成时间" })).toBeVisible();
    await expect(page.locator("#todoDueInput")).toHaveValue("");
    await expect(page.locator("#todoRelatedInput")).toHaveValue("");
    await page.locator("#todoTitleInput").fill(title);
    await page.locator("#todoTitleInput").press("Enter");

    await expect(page.locator("#dashboard .todo-list")).toContainText(title);
    await expect(page.locator(".toast").last()).toContainText("待办已新增");
    await expect(todoInsight).toHaveText(String(beforeTodoCount + 2));
    const cacheSize = await page.evaluate(() => localStorage.getItem("gj_dashboard_cache")?.length || 0);
    expect(cacheSize).toBeGreaterThan(20);

    const todoRow = page.locator("#dashboard .todo-row", { hasText: title }).first();
    await expect(todoRow.locator(".todo-more")).toBeVisible();
    await todoRow.locator(".todo-run").click();
    await expect(page.locator("#dashboard .todo-row.in-progress", { hasText: title }).first()).toBeVisible();
    await expect(todoRow).toContainText("进行中");
    await expect(todoRow.locator(".subtask-bar.running")).toBeVisible();
    await expect(todoRow.locator(".todo-run")).toHaveAttribute("aria-label", "停止执行");
    await todoRow.locator(".todo-run").click();
    await expect(page.locator("#dashboard .todo-row.in-progress", { hasText: title })).toHaveCount(0);
    await expect(page.locator(".toast").last()).toContainText("已停止执行");
    await todoRow.locator(".todo-run").click();
    await expect(page.locator("#dashboard .todo-row.in-progress", { hasText: title }).first()).toBeVisible();

    await todoRow.locator(".todo-check").click();
    const doneRow = page.locator("#dashboard .todo-row.done", { hasText: title }).first();
    await expect(doneRow).toBeVisible();
    await expect(doneRow).not.toContainText("进行中");
    await expect(page.locator("#dashboard .todo-row.in-progress", { hasText: title })).toHaveCount(0);
    await doneRow.locator(".todo-check").click();
    await expect(page.locator("#dashboard .todo-row.done", { hasText: title })).toHaveCount(0);
    await expect(page.locator(".toast").last()).toContainText("已撤回未完成");
    await todoRow.locator(".todo-more").click();
    await todoRow.locator("[data-todo-action='edit']").click();
    await expect(page.locator("#appModal")).toHaveClass(/active/);
    await expect(page.locator("#modalTitle")).toContainText("编辑待办");
    const today = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const todayText = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())} 18:30`;
    await page.locator("#todoDueInput").fill(todayText);
    await page.locator("#todoRelatedInput").fill("菜单编辑验证");
    await page.locator("#saveTodoButton").click();
    await expect(page.locator(".toast").last()).toContainText("待办已更新");
    await expect(page.locator("#dashboard .todo-row", { hasText: title }).first()).toContainText(todayText);
    await expect(page.locator("#dashboard .todo-row", { hasText: title }).first()).not.toContainText(/t_\\d{10,}/);
    await page.locator("#dashboard .todo-row", { hasText: title }).first().locator(".todo-more").click();
    await page.locator("#dashboard .todo-row", { hasText: title }).first().locator("[data-todo-action='delete']").click();
    await expect(page.locator(".toast").last()).toContainText("待办已删除");
    await expect(page.locator("#dashboard .todo-row", { hasText: title })).toHaveCount(0);
    await quickRow.locator(".todo-more").click();
    await quickRow.locator("[data-todo-action='delete']").click();
    await expect(page.locator("#dashboard .todo-row", { hasText: quickTitle })).toHaveCount(0);
    await expect(todoInsight).toHaveText(String(beforeTodoCount));
  });

  test("sales dashboard keeps personal scope and hides manager briefing controls", async ({ page }) => {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await loginAsSales(page);
    await expect(page.locator("#businessScopeTag")).toContainText("本人业务");
    await expect(page.locator("#todoScopeTag")).toContainText("本人待办");
    await expect(page.locator("#scopeText")).toContainText("仅本人业务与本人待办");
    await expect(page.locator("#morningViewButton")).toBeHidden();
    await expect(page.locator("#dashboard .focus-metric").nth(1)).toContainText("高优先级待办");
    await expect(page.locator("#dashboard .focus-metric").nth(1)).toContainText("本人待办");
  });

  test("dashboard remains readable without horizontal overflow on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator("#dashboard")).toHaveClass(/active/);
    const layout = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      dashboardRight: document.querySelector("#dashboard")?.getBoundingClientRect().right || 0,
      historyOpen: document.querySelector("#dashboard .todo-history")?.hasAttribute("open") || false
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.dashboardRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.historyOpen).toBe(false);
    await expect(page.locator("#dashboard .focus-metrics")).toBeVisible();
    await expect(page.locator("#dashboard .todo-board")).toBeVisible();
    await expect(page.locator("#businessScopeTag")).toContainText(/本人业务|团队业务|全局业务/);
  });

  test("todo menu pins and long-press drag clears pin labels", async ({ page }) => {
    const pinned = `拖拽排序待办-${runId}`;
    const anchor = `拖拽目标待办-${runId}`;

    for (const title of [anchor, pinned]) {
      await page.getByRole("button", { name: "新增待办" }).click();
      await page.locator("#todoTitleInput").fill(title);
      await page.locator("#todoTitleInput").press("Enter");
      await expect(page.locator("#dashboard .todo-row", { hasText: title })).toBeVisible();
    }

    const currentTodoRows = page.locator("#dashboard .todo-list > .todo-row");
    const pinnedRow = currentTodoRows.filter({ hasText: pinned }).first();
    await expect(pinnedRow.locator(".todo-more span")).toHaveCount(3);
    await pinnedRow.locator(".todo-more").click();
    await expect(pinnedRow.locator(".todo-menu")).toBeVisible();
    await expect(pinnedRow.locator("[data-todo-action='edit']")).toBeVisible();
    await page.locator("#dashboard .todo-toolbar").click();
    await expect(pinnedRow.locator(".todo-menu")).toHaveCount(0);
    await pinnedRow.locator(".todo-more").click();
    await pinnedRow.locator("[data-todo-action='top']").click();
    await expect(currentTodoRows.first()).toContainText(pinned);
    await expect(pinnedRow).toContainText("置顶");

    const anchorRow = currentTodoRows.filter({ hasText: anchor }).first();
    await expect(pinnedRow).toBeVisible();
    await expect(anchorRow).toBeVisible();
    const fromBox = await pinnedRow.boundingBox();
    const toBox = await anchorRow.boundingBox();
    if (!fromBox || !toBox) throw new Error("todo drag boxes missing");
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(360);
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator(".toast").last()).toContainText("已按拖拽顺序保存");
    await expect(currentTodoRows.filter({ hasText: pinned }).first()).not.toContainText("置顶");
    await expect(currentTodoRows.filter({ hasText: pinned }).first()).not.toContainText("沉底");

    for (const title of [pinned, anchor]) {
      const row = currentTodoRows.filter({ hasText: title }).first();
      await row.locator(".todo-more").click();
      await row.locator("[data-todo-action='delete']").click();
      await expect(currentTodoRows.filter({ hasText: title })).toHaveCount(0);
    }
  });

  test("plan task page restores execution planner and keeps result workflow", async ({ page }) => {
    test.setTimeout(60_000);
    const localDateTime = (date: Date) => {
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const todayDue = new Date();
    todayDue.setSeconds(0, 0);
    const rescheduledDue = new Date(todayDue);
    rescheduledDue.setMinutes(rescheduledDue.getMinutes() + 30);

    await openView(page, "instrument-growth");
    await expect(page.locator("#instrument-growth")).toContainText("Personal Execution Planner");
    await expect(page.locator("#instrument-growth .instrument-hero")).toBeVisible();
    await expect(page.locator("#instrument-growth")).toContainText("目标客户池");
    await expect(page.locator("#instrument-growth")).toContainText("执行节奏建议");
    await expect(page.locator("#instrument-growth")).toContainText("英文话术与参数确认");
    await expect(page.locator("#knowledgeTemplateList")).toContainText("产品分类地图");
    await expect(page.locator("#executionTemplateList")).toContainText("第 1 天");
    const templateTitle = (await page.locator("#knowledgeTemplateList [data-plan-template-id]").first().locator("b").textContent()) || "";
    await page.locator("#knowledgeTemplateList [data-plan-template-id]").first().locator("[data-plan-template-add]").click();
    await expect(page.locator(".toast").last()).toContainText(/已加入计划任务|已在计划中/);
    await expect(page.locator(".plan-task-table")).toBeVisible();

    const taskTitle = `今日客户动作-${runId}`;
    await page.locator("#planTaskNewButton").click();
    await page.locator("#planTaskTitleInput").fill(taskTitle);
    await page.locator("#planTaskDueInput").fill(localDateTime(todayDue));
    await page.getByText("更多设置", { exact: true }).click();
    await page.locator("#planTaskRelationType").selectOption("customer");
    await page.locator("#planTaskCustomerInput").selectOption({ index: 1 });
    await page.locator("#planTaskPriorityInput").selectOption("high");
    await page.locator("#planTaskStatusInput").selectOption("active");
    await page.locator("#planTaskTargetInput").fill("确认报价反馈并约定下一步");
    await page.locator("#planTaskDescriptionInput").fill("页面级业务闭环自测");
    await page.locator("#savePlanTaskButton").click();
    await expect(page.locator(".toast").last()).toContainText("计划任务已新增");
    await expect(page.locator("#appModal")).not.toHaveClass(/active/);
    const completedRow = page.locator(".plan-task-table tr", { hasText: taskTitle });
    await expect(completedRow).toContainText("客户");
    await completedRow.locator("[data-plan-complete]").click();
    await page.locator("#planTaskCompleteResult").fill("客户确认关键参数，已发送新版报价，周五继续跟进。");
    await page.locator("#confirmPlanTaskComplete").click();
    await expect(page.locator(".toast").last()).toContainText("任务已完成");
    await expect(page.locator(".plan-task-table tr", { hasText: taskTitle })).toContainText("客户确认关键参数");

    const cancelTitle = `改期取消动作-${runId}`;
    await page.locator("#planTaskNewButton").click();
    await page.locator("#planTaskTitleInput").fill(cancelTitle);
    await page.locator("#planTaskDueInput").fill(localDateTime(todayDue));
    await page.locator("#savePlanTaskButton").click();
    await expect(page.locator("#appModal")).not.toHaveClass(/active/);
    const cancelRow = page.locator(".plan-task-table tr", { hasText: cancelTitle });

    const selectedTaskChecks = page.locator("[data-plan-task-check]:checked");
    for (let index = (await selectedTaskChecks.count()) - 1; index >= 0; index -= 1) {
      await selectedTaskChecks.nth(index).uncheck();
    }
    await cancelRow.locator("[data-plan-task-check]").check();
    await page.locator("#planTaskPushSelectedButton").click();
    await expect(page.locator(".toast").last()).toContainText("已推送 1 条计划任务到待办");
    const pushedTodos = await apiFromPage<{ todos: Array<{ id: string; title: string }> }>(page, "/api/todos");
    const pushedTodo = pushedTodos.todos.find((todo) => todo.title === cancelTitle);
    expect(pushedTodo).toBeTruthy();

    const memosBefore = await apiFromPage<{ memos: Array<{
      id: string;
      title: string;
      category: string;
      tags: string;
      content: string;
      pinned: boolean;
      customerId: string;
      dealId: string;
    }> }>(page, "/api/memos");
    const previousPlanMemo = memosBefore.memos.find((memo) => memo.title === "计划任务执行方案");
    await page.locator("#instrumentMemoButton").click();
    await expect(page.locator(".toast").last()).toContainText(/计划任务已写入备忘|计划任务备忘已更新/);
    const memosAfter = await apiFromPage<{ memos: Array<{ id: string; title: string; content: string }> }>(page, "/api/memos");
    const planMemo = memosAfter.memos.find((memo) => memo.title === "计划任务执行方案");
    expect(planMemo?.content).toContain(cancelTitle);

    await cancelRow.locator("[data-plan-reschedule]").click();
    await page.locator("#planTaskRescheduleDue").fill(localDateTime(rescheduledDue));
    await page.locator("#planTaskRescheduleReason").fill("等待客户补充图纸");
    await page.locator("#confirmPlanTaskReschedule").click();
    await expect(page.locator(".toast").last()).toContainText("计划时间已调整");
    await page.locator(".plan-task-table tr", { hasText: cancelTitle }).locator("[data-plan-cancel]").click();
    await page.locator("#planTaskCancelReason").fill("客户项目暂停，暂不继续推进");
    await page.locator("#confirmPlanTaskCancel").click();
    await expect(page.locator(".plan-task-table tr", { hasText: cancelTitle })).toContainText("客户项目暂停");

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#instrumentExportButton").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("计划任务执行表");
    await expect(page.locator(".toast").last()).toContainText("计划任务执行表已导出");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#instrument-growth .instrument-hero")).toBeVisible();
    await expect(page.locator("#instrument-growth .head-actions")).toBeVisible();
    const mobileLayout = await page.evaluate(() => {
      const taskList = document.querySelector<HTMLElement>("#instrument-growth .plan-task-list");
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        taskListClientWidth: taskList?.clientWidth || 0,
        taskListScrollWidth: taskList?.scrollWidth || 0
      };
    });
    expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth);
    expect(mobileLayout.taskListScrollWidth).toBeGreaterThan(mobileLayout.taskListClientWidth);

    if (pushedTodo) {
      await apiFromPage(page, `/api/todos/${pushedTodo.id}`, { method: "DELETE" });
    }
    if (planMemo) {
      if (previousPlanMemo) {
        await apiFromPage(page, `/api/memos/${previousPlanMemo.id}`, {
          method: "PATCH",
          body: {
            title: previousPlanMemo.title,
            category: previousPlanMemo.category,
            tags: previousPlanMemo.tags,
            content: previousPlanMemo.content,
            pinned: previousPlanMemo.pinned,
            customerId: previousPlanMemo.customerId,
            dealId: previousPlanMemo.dealId
          }
        });
      } else {
        await apiFromPage(page, `/api/memos/${planMemo.id}`, { method: "DELETE" });
        await apiFromPage(page, `/api/memos/${planMemo.id}/permanent`, { method: "DELETE" });
      }
    }

    for (const title of [taskTitle, cancelTitle, templateTitle ? `训练：${templateTitle}` : ""]) {
      if (!title) continue;
      const row = page.locator(".plan-task-table tr", { hasText: title }).first();
      if (!await row.count()) continue;
      page.once("dialog", (dialog) => dialog.accept());
      await row.locator("[data-plan-delete]").click();
      await expect(page.locator(".plan-task-table tr", { hasText: title })).toHaveCount(0);
    }
  });

  test("todo list sorts unfinished first and newest first", async ({ page }) => {
    const older = `排序较早待办-${runId}`;
    const newer = `排序较新待办-${runId}`;

    await page.getByRole("button", { name: "新增待办" }).click();
    await page.locator("#todoTitleInput").fill(older);
    await page.locator("#saveTodoButton").click();
    await expect(page.locator("#dashboard .todo-list")).toContainText(older);

    await page.waitForTimeout(20);
    await page.getByRole("button", { name: "新增待办" }).click();
    await page.locator("#todoTitleInput").fill(newer);
    await page.locator("#saveTodoButton").click();

    await expect(page.locator("#dashboard .todo-list .todo-row").first()).toContainText(newer);
    await page.locator("#dashboard .todo-row", { hasText: newer }).first().locator(".todo-check").click();
    await expect(page.locator("#dashboard .todo-list .todo-row").first()).toContainText(older);
  });

  test("next-day todos move into history list", async ({ page }) => {
    const title = `历史归档待办-${runId}`;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const pad = (value: number) => String(value).padStart(2, "0");
    const yesterdayText = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())} 09:30`;

    await page.getByRole("button", { name: "新增待办" }).click();
    await page.locator("#todoTitleInput").fill(title);
    await page.locator("#todoDueInput").fill(yesterdayText);
    await page.locator("#saveTodoButton").click();

    await expect(page.locator("#dashboard .todo-list .todo-row", { hasText: title })).toHaveCount(0);
    await expect(page.locator("#dashboard .todo-history")).not.toHaveAttribute("open", "");
    await page.locator("#dashboard .todo-history-head").click();
    await expect(page.locator("#dashboard .todo-history")).toHaveAttribute("open", "");
    await expect(page.locator("#dashboard .todo-history-list")).toContainText(title);
    await expect(page.locator("#dashboard .todo-history-row", { hasText: title })).toContainText("历史归档");
    await expect(page.locator("#dashboard .todo-history-row", { hasText: title }).locator("[data-todo-restore]")).toBeVisible();
    await expect(page.locator("#dashboard .todo-history-row", { hasText: title })).not.toContainText("资料/考试");
    await expect(page.locator("#dashboard .todo-chip").last()).toContainText("历史清单");
    await expect(page.locator("#dashboard .todo-chip").last()).not.toContainText("资料/考试");
    await page.locator("#dashboard .todo-chip").last().click();
    await expect(page.locator("#dashboard .todo-list .todo-row", { hasText: title })).toContainText("历史归档");
    await expect(page.locator("#todo-history-count")).toHaveText(/[1-9]\d* 条/);
    await page.locator("#dashboard .todo-list .todo-row", { hasText: title }).first().locator("[data-todo-restore]").click();
    await expect(page.locator(".toast").last()).toContainText("已恢复到今日清单");
    await page.locator("#dashboard .todo-chip").first().click();
    const restoredRow = page.locator("#dashboard .todo-list .todo-row", { hasText: title }).first();
    await expect(restoredRow.locator(".badge")).toContainText("其它");
    await expect(restoredRow.locator(".badge")).not.toContainText("历史归档");
  });

  test("customer page can create and inspect a customer", async ({ page }) => {
    const company = `示例仪表自动化-${runId}`;
    const companyEdited = `${company}-已编辑`;
    const deleteCompanyA = `批量客户A-${runId}`;
    const deleteCompanyB = `批量客户B-${runId}`;
    await openView(page, "customers");
    const activeCustomerRow = page.locator("#customers tbody tr", { hasText: "Nordic Tools AB" }).first();
    await expect(activeCustomerRow.locator(".customer-name")).toHaveClass(/has-active-deal/);
    await activeCustomerRow.locator("td").nth(2).click();
    await expect(page.locator("#customerDrawer")).not.toHaveClass(/open/);
    await activeCustomerRow.locator(".customer-name").click();
    await expect(page.locator("#customerDrawer")).toHaveClass(/open/);
    await expect(page.locator("#customerDrawer")).toContainText("相关商机进展");
    await expect(page.locator("#customerDrawer")).toContainText("Nordic Tools 电动工具年度采购");
    await expect(page.locator("#customerDrawer")).toContainText("Shirley");
    await page.locator("#customerDrawerClose").click();
    await expect(page.locator("#customerDrawer")).not.toHaveClass(/open/);

    await page.locator("#customers .page-head .btn.primary").click();
    await page.locator("#customerCompanyInput").fill(company);
    await page.locator("#customerContactInput").fill("Demo Contact");
    await page.locator("#saveCustomerButton").click();

    await expect(page.locator("#customers tbody")).toContainText(company);
    const createdCustomerRow = page.locator("#customers tbody tr", { hasText: company }).first();
    await expect(createdCustomerRow.locator(".customer-name")).not.toHaveClass(/has-active-deal/);
    await expect(page.locator("#customerDrawer")).not.toHaveClass(/open/);
    await createdCustomerRow.locator(".customer-name").click();
    await expect(page.locator("#customerDrawer")).toContainText(company);
    await expect(page.locator("#customerDrawer")).toContainText("暂无关联商机");
    await expect(page.locator("#customerDrawer")).toContainText("暂无活跃商机");
    await expect(page.locator("#customerDrawer")).toContainText("活跃商机数");
    await expect(page.locator(".toast").last()).toContainText("客户已新增");

    await page.locator("#customerDrawer [data-edit-customer-drawer]").click();
    await page.locator("#customerCompanyInput").fill(companyEdited);
    await page.locator("#customerReminderInput").fill("明天 18:00");
    await page.locator("#customerWecomInput").selectOption("true");
    await page.locator("#saveCustomerButton").click();
    await expect(page.locator(".toast").last()).toContainText("客户已保存");
    await expect(page.locator("#customers tbody")).toContainText(companyEdited);
    await expect(page.locator("#customerDrawer")).toContainText("明天 18:00");

    const followContent = `确认参数与报价-${runId}`;
    await page.locator("#customerDrawer [data-add-follow]").click();
    await page.locator("#customerFollowType").selectOption("email");
    await page.locator("#customerFollowContent").fill(followContent);
    await page.locator("#customerFollowNext").fill("后天 10:30");
    await page.locator("#saveCustomerFollowButton").click();
    await expect(page.locator("#customerDrawer .timeline")).toContainText(followContent);
    await expect(page.locator("#customerDrawer")).toContainText("后天 10:30");
    await page.reload();
    await openView(page, "customers");
    await page.locator("#customers tbody tr", { hasText: companyEdited }).first().locator(".customer-name").click();
    await expect(page.locator("#customerDrawer .timeline")).toContainText(followContent);
    await page.locator("#customerDrawerClose").click();

    for (const name of [deleteCompanyA, deleteCompanyB]) {
      await page.locator("#customers .page-head .btn.primary").click();
      await page.locator("#customerCompanyInput").fill(name);
      await page.locator("#customerContactInput").fill("Delete User");
      await page.locator("#saveCustomerButton").click();
      await expect(page.locator("#customers tbody")).toContainText(name);
    }
    for (const name of [deleteCompanyA, deleteCompanyB]) {
      await page.locator("#customers tbody tr", { hasText: name }).first().locator("[data-select-customer]").check();
    }
    await expect(page.locator("#customers .toolbar")).toContainText("已选 2 个客户");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#customers [data-bulk-delete-customers]").click();
    await expect(page.locator(".toast").last()).toContainText("已批量删除 2 个客户");
    await expect(page.locator("#customers tbody")).not.toContainText(deleteCompanyA);
    await expect(page.locator("#customers tbody")).not.toContainText(deleteCompanyB);
  });

  test("customer work queue is responsive and drawer does not block navigation", async ({ page }) => {
    await openView(page, "customers");
    await expect(page.locator("#customerSearchInput")).toBeVisible();
    await page.locator("#customerSearchInput").fill("Nordic Tools");
    await expect(page.locator("#customers tbody tr")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.locator("#customers tbody tr").locator("td").nth(3).click();
    await expect(page.locator("#customerDrawer")).not.toHaveClass(/open/);
    await page.locator("#customers tbody tr").locator(".customer-name").click();
    await expect(page.locator("#customerDrawer")).toHaveClass(/open/);
    await openView(page, "pipeline");
    await expect(page.locator("#customerDrawer")).not.toHaveClass(/open/);

    await page.setViewportSize({ width: 390, height: 844 });
    await openView(page, "customers");
    await page.locator("#customerFilterReset").click();
    await expect(page.locator("#customerMobileList .customer-mobile-card").first()).toBeVisible();
    const mobileCustomerCard = page.locator("#customerMobileList .customer-mobile-card").first();
    await mobileCustomerCard.locator(".customer-mobile-meta").click();
    await expect(page.locator("#customerDrawer")).not.toHaveClass(/open/);
    await mobileCustomerCard.locator(".customer-name").click();
    await expect(page.locator("#customerDrawer")).toHaveClass(/open/);
    const drawerBox = await page.locator("#customerDrawer").boundingBox();
    expect(drawerBox?.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });

  test("pipeline can create and move a deal", async ({ page }) => {
    test.setTimeout(60_000);
    const dealTitle = `自动化商机-${runId}`;
    const blockedDeal = `无客户商机-${runId}`;
    const lostDeal = `丢单商机-${runId}`;
    await page.evaluate(() => {
      window.print = () => document.body.setAttribute("data-print-called", "true");
    });
    await openView(page, "customers");
    await page.locator("#customers tbody tr", { hasText: "Nordic Tools AB" }).first().getByRole("button", { name: "编辑" }).click();
    await page.locator("#customerBillingNameInput").fill(`Nordic Print Buyer ${runId}`);
    await page.locator("#customerBillingAddressInput").fill("Automation Street 18, Stockholm, Sweden");
    await page.locator("#customerDocumentContactInput").fill("Emma / pi-print@example.com");
    await page.locator("#customerPortDischargeInput").fill("Stockholm");
    await page.locator("#customerIncotermInput").fill("FOB Tianjin");
    await page.locator("#customerPaymentTermInput").fill("40% deposit, 60% before shipment");
    await page.locator("#saveCustomerButton").click();
    await expect(page.locator("#customers .drawer")).toContainText(`Nordic Print Buyer ${runId}`);
    await openView(page, "pipeline");

    await page.locator("#pipeline .page-head .btn.primary").click();
    await expect(page.locator("#dealCustomerInput")).toHaveValue("");
    await page.locator("#dealTitleInput").fill(dealTitle);
    await page.locator("#dealCustomerInput").fill("Nordic");
    await expect(page.locator("#dealCustomerOptions")).toContainText("Nordic Tools AB");
    await page.locator("#dealCustomerOptions [data-deal-customer-id]").first().click();
    await expect(page.locator("#dealCustomerInput")).toHaveValue("Nordic Tools AB");
    await page.locator("#dealProductInput").fill("自动化压力变送器");
    await page.locator("#dealQuantityInput").fill("14");
    await page.locator("#dealUnitPriceInput").fill("2000");
    await expect(page.locator("#dealAmountInput")).toHaveValue("28000");
    await page.locator("#saveDealButton").click();

    await expect(page.locator("#pipeline .pipeline-strip")).toContainText(dealTitle);
    await expect(page.locator("#pipeline .deal", { hasText: dealTitle }).first()).toContainText("自动化压力变送器");
    const dealCard = () => page.locator("#pipeline .deal", { hasText: dealTitle }).first();
    await expect(dealCard().getByRole("button", { name: "记录进展" })).toBeVisible();
    await expect(dealCard().locator(".deal-more")).toHaveCount(0);
    await expect(dealCard().getByRole("button", { name: "推进阶段" })).toBeVisible();
    await expect(dealCard().getByRole("button", { name: "编辑商机" })).toHaveCount(0);
    await expect(dealCard().getByRole("button", { name: "查看详情" })).toHaveCount(0);
    await dealCard().getByText(dealTitle, { exact: true }).click();
    await expect(page.locator("#dealDrawer")).toHaveClass(/open/);
    await page.locator("#drawerEditDealButton").click();
    await page.locator("#dealProductInput").fill("自动化差压仪表");
    await page.locator("#dealQuantityInput").fill("16");
    await page.locator("#dealUnitPriceInput").fill("1800");
    await page.locator("#dealNextActionInput").fill("确认修订报价");
    await expect(page.locator("#dealAmountInput")).toHaveValue("28800");
    await page.locator("#saveDealButton").click();
    await expect(page.locator(".toast").last()).toContainText("商机已更新");
    await expect(dealCard()).toContainText("自动化差压仪表");
    await expect(dealCard()).toContainText("确认修订报价");
    await page.locator("#closeDealDrawerButton").click();
    await expect(page.locator("#dealDrawerBackdrop")).not.toHaveClass(/open/);

    await dealCard().getByRole("button", { name: "记录进展" }).click();
    await page.locator("#dealEventContentInput").fill("客户确认技术参数，允许准备正式报价");
    await page.locator("#dealEventNextActionInput").fill("安排首次联系结果复核");
    await page.locator("#saveDealEventButton").click();
    await expect(page.locator(".toast").last()).toContainText("商机进展已记录");

    const advanceDeal = async (won = false) => {
      await dealCard().locator("[data-move-deal]").click();
      await page.locator("#dealStageResultInput").fill(won ? "客户已确认订单、金额和付款条件" : "自动化阶段推进结果");
      if (won) await page.locator("#dealWonReasonInput").fill("客户已确认 PI、金额、付款条件与订单日期");
      await page.locator("#confirmDealStageButton").click();
      await expect(page.locator(".toast").last()).toContainText("商机已推进到");
    };

    await advanceDeal();
    await advanceDeal();
    await expect(dealCard()).toContainText("已报价");
    await expect(dealCard().getByRole("button", { name: "生成 PI" })).toBeVisible();
    await dealCard().getByRole("button", { name: "生成 PI" }).click();
    await expect(page.locator("#documents")).toHaveClass(/active/);
    await expect(page.locator("#documentPreview")).toContainText("PROFORMA INVOICE");
    await expect(page.locator("#documentPreview")).toContainText(`Nordic Print Buyer ${runId}`);
    await expect(page.locator("#documentPreview")).toContainText("自动化差压仪表");
    await expect(page.locator("body")).toHaveAttribute("data-print-called", "true");
    await openView(page, "pipeline");
    await advanceDeal();
    await advanceDeal();
    await advanceDeal(true);
    await expect(page.locator("#pipeline .pipeline-strip")).not.toContainText(dealTitle);
    await page.locator("#pipelineClosedPanel").evaluate((node: HTMLDetailsElement) => { node.open = true; });
    await expect(page.locator("#pipeline-archived-deals")).toContainText(dealTitle);
    await page.locator("#pipeline-archived-deals tr", { hasText: dealTitle }).click();
    await expect(page.locator("#dealDrawer")).toHaveClass(/open/);
    await expect(page.locator("#dealDrawer")).toContainText("确认成交");
    await expect(page.locator("#dealDrawer")).toContainText("PI");
    await page.locator("#drawerPrintDealButton").click();
    await expect(page.locator("#documents")).toHaveClass(/active/);
    await expect(page.locator("#documentPreview")).toContainText("COMMERCIAL INVOICE");
    await expect(page.locator("#documentPreview")).toContainText(`Nordic Print Buyer ${runId}`);
    await openView(page, "pipeline");
    await page.locator("#pipelineClosedPanel").evaluate((node: HTMLDetailsElement) => { node.open = true; });
    await page.locator("#pipeline-archived-deals tr", { hasText: dealTitle }).click();
    await page.locator("#drawerArchiveDealButton").click();
    await expect(page.locator(".toast").last()).toContainText("成交商机已归档");

    await page.locator("#pipeline .page-head .btn.primary").click();
    await page.locator("#dealTitleInput").fill(blockedDeal);
    await page.locator("#dealProductInput").fill("待确认产品");
    await expect(page.locator("#dealCustomerInput")).toHaveValue("");
    await page.locator("#saveDealButton").click();
    await expect(page.locator(".toast").last()).toContainText("选择关联客户");
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.locator("#pipeline .pipeline-strip")).not.toContainText(blockedDeal);

    await page.locator("#pipeline .page-head .btn.primary").click();
    await page.locator("#dealTitleInput").fill(lostDeal);
    await page.locator("#dealCustomerInput").fill("Atlas");
    await page.locator("#dealCustomerOptions [data-deal-customer-id]").first().click();
    await page.locator("#dealProductInput").fill("丢单测试仪表");
    await page.locator("#dealQuantityInput").fill("9");
    await page.locator("#dealUnitPriceInput").fill("1000");
    await page.locator("#saveDealButton").click();
    await expect(page.locator("#pipeline .pipeline-strip")).toContainText(lostDeal);
    const lostCard = page.locator("#pipeline .deal", { hasText: lostDeal }).first();
    await lostCard.getByRole("button", { name: "标记丢单" }).click();
    await page.locator("#dealLostCategoryInput").selectOption({ label: "竞争对手" });
    await page.locator("#dealLostReasonInput").fill("客户选择了本地低价竞品，三个月后复访");
    await page.locator("#dealRevisitAtInput").fill("2026-10-01");
    await page.locator("#confirmDealLostButton").click();
    await expect(page.locator(".toast").last()).toContainText("商机已标记丢单");
    await expect(page.locator("#pipeline .pipeline-strip")).not.toContainText(lostDeal);
    await page.locator("#pipelineClosedPanel").evaluate((node: HTMLDetailsElement) => { node.open = true; });
    await page.locator("#pipelineClosedSearch").fill(lostDeal);
    await page.locator("#pipelineClosedSearch").dispatchEvent("change");
    await expect(page.locator("#pipeline-archived-deals")).toContainText(lostDeal);
    await expect(page.locator("#pipeline-archived-deals")).toContainText("丢单");
    await expect(page.locator("#pipeline-archived-deals")).toContainText("竞争对手");
  });

  test("pipeline mobile view shows one stage and keeps actions usable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openView(page, "pipeline");
    await expect(page.locator("#pipelineStageTabs")).toBeVisible();
    await expect(page.locator("#pipeline .stage:visible")).toHaveCount(1);
    await page.locator("#pipelineStageTabs [data-pipeline-stage-tab='已报价']").click();
    await expect(page.locator("#pipeline .stage:visible")).toHaveAttribute("data-pipeline-stage", "已报价");
    const card = page.locator("#pipeline .stage:visible .deal").first();
    await expect(card).toBeVisible();
    const primaryBox = await card.locator("[data-move-deal]").boundingBox();
    expect(primaryBox?.height).toBeGreaterThanOrEqual(44);
    await expect(card.getByRole("button", { name: "记录进展" })).toBeVisible();
    const secondaryBoxes = await card.locator(".deal-secondary-actions .btn").evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().height)
    );
    expect(secondaryBoxes.every((height) => height >= 44)).toBeTruthy();
    await expect(card.getByRole("button", { name: "编辑商机" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "查看详情" })).toHaveCount(0);
    await card.locator(":scope > b").click();
    await expect(page.locator("#dealDrawer")).toHaveClass(/open/);
    const drawerBox = await page.locator("#dealDrawer").boundingBox();
    expect(drawerBox?.width).toBeLessThanOrEqual(391);
    await expect(page.locator("#dealDrawer")).toContainText("商机时间线");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });

  test("commission reconciliation explains amounts and keeps mobile records usable", async ({ page }) => {
    await page.locator("#logoutButton").click();
    await loginAsAdmin(page);
    const month = "2099-11";
    const suffix = Date.now();
    const product = await apiFromPage<{ product: { id: string } }>(page, "/api/commission/products", {
      method: "POST",
      body: { name: `E2E 提成产品 ${suffix}`, model: `E2E-${suffix}`, currency: "USD", defaultPrice: 1000, costPrice: 600 }
    });
    await apiFromPage(page, `/api/commission/products/${product.product.id}/rules`, {
      method: "POST",
      body: { ruleType: "rate", rate: 0.03, effectiveFrom: month, remark: "E2E 3%" }
    });
    const record = await apiFromPage<{ record: { id: string } }>(page, "/api/commission/sales-records", {
      method: "POST",
      body: {
        ownerId: "u_sales_shirley",
        month,
        customerName: `E2E 客户 ${suffix}`,
        productId: product.product.id,
        productName: `E2E 提成产品 ${suffix}`,
        quantity: 2,
        unitPrice: 1000,
        currency: "USD",
        exchangeRate: 7.2,
        exchangeRateDate: `${month}-10`,
        exchangeRateSource: "finance",
        settlementCurrency: "CNY",
        basisType: "receipt",
        basisDate: `${month}-10`,
        status: "confirmed"
      }
    });
    await apiFromPage(page, "/api/commission/calculations/recalculate", {
      method: "POST",
      body: { month, ownerId: "u_sales_shirley" }
    });
    await openView(page, "commission");
    const monthRefresh = page.waitForResponse((response) =>
      response.url().includes(`/api/commission/sales-records?month=${month}`)
    );
    await page.locator("#commissionMonthInput").fill(month);
    await page.locator("#commissionMonthInput").press("Tab");
    await monthRefresh;
    await page.locator("#commissionOwnerInput").selectOption("u_sales_shirley");
    await expect(page.locator("#commissionRecordRows")).toContainText(`E2E 客户 ${suffix}`);
    await expect(page.locator("#commissionRecordRows")).toContainText("CNY");
    const commissionRow = page.locator(`#commissionRecordRows tr[data-commission-record-id="${record.record.id}"]`);
    await expect(commissionRow).toContainText("CNY 432.00");
    await expect(commissionRow).toContainText("已计算");
    await page.locator(`#commissionRecordRows tr[data-commission-record-id="${record.record.id}"] [data-view-commission-detail]`).click();
    await expect(page.locator("#appModal")).toContainText("提成额");
    await expect(page.locator("#appModal")).toContainText("CNY 432.00");
    await expect(page.locator("#appModal")).toContainText("计算公式");
    await page.locator("#appModal [data-modal-close]").last().click();
    await expect(page.locator("#commissionCalculationRows")).toContainText("已计算");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#commissionRecordCards")).toBeVisible();
    await expect(page.locator("#commissionRecordCards")).toContainText(`E2E 客户 ${suffix}`);
    await expect(page.locator(`#commissionRecordCards [data-commission-record-id="${record.record.id}"]`)).toContainText("提成额");
    await expect(page.locator(`#commissionRecordCards [data-commission-record-id="${record.record.id}"]`)).toContainText("CNY 432.00");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test("commission row confirmation explains missing fields and succeeds after correction", async ({ page }) => {
    await page.locator("#logoutButton").click();
    await loginAsAdmin(page);
    const month = "2099-12";
    const suffix = `${runId}-confirm`;
    const record = await apiFromPage<{ record: { id: string } }>(page, "/api/commission/sales-records", {
      method: "POST",
      body: {
        ownerId: "u_sales_shirley",
        month,
        customerName: `确认测试客户 ${suffix}`,
        productName: `确认测试产品 ${suffix}`,
        quantity: 1,
        unitPrice: 500,
        currency: "USD",
        exchangeRate: 7.2,
        exchangeRateDate: "",
        exchangeRateSource: "pending",
        settlementCurrency: "CNY",
        basisType: "receipt",
        basisDate: "",
        status: "draft"
      }
    });

    await openView(page, "commission");
    const monthRefresh = page.waitForResponse((response) =>
      response.url().includes(`/api/commission/sales-records?month=${month}`)
    );
    await page.locator("#commissionMonthInput").fill(month);
    await page.locator("#commissionMonthInput").press("Tab");
    await monthRefresh;
    await page.locator("#commissionOwnerInput").selectOption("u_sales_shirley");
    const row = page.locator(`#commissionRecordRows tr[data-commission-record-id="${record.record.id}"]`);
    await expect(row.locator("[data-confirm-commission-record]")).toHaveCount(0);
    const completeButton = row.locator("[data-complete-commission-record]");
    await expect(completeButton).toHaveText("补齐资料");
    await completeButton.click();
    await expect(page.locator(".toast.error").last()).toContainText("计提日期、汇率日期、汇率来源");
    await expect(page.locator("#appModal")).toHaveClass(/active/);
    await expect(page.locator("#modalTitle")).toHaveText("编辑售卖记录");

    await page.locator("#commissionRecordExchangeDateInput").fill(`${month}-10`);
    await page.locator("#commissionRecordExchangeSourceInput").selectOption("finance");
    await page.locator("#commissionRecordBasisDateInput").fill(`${month}-10`);
    await page.locator("#commissionRecordEditNoteInput").fill("补齐确认所需的汇率和计提日期");
    await page.locator("#saveCommissionRecordButton").click();
    await expect(page.locator("#appModal")).not.toHaveClass(/active/);

    await row.locator("[data-confirm-commission-record]").click();
    await expect(row).toContainText("已确认");
    await expect(row.locator("[data-confirm-commission-record]")).toHaveCount(0);
    await expect(page.locator(".toast").last()).toContainText("销售记录已确认");
  });

  test("commission locked month disables row edits and rejects confirmation", async ({ page }) => {
    await page.locator("#logoutButton").click();
    await loginAsAdmin(page);
    const month = "2099-10";
    const seedRecord = await apiFromPage<{ record: { id: string } }>(page, "/api/commission/sales-records", {
      method: "POST",
      body: {
        ownerId: "u_sales_shirley",
        month,
        customerName: `锁定测试客户 ${runId}`,
        productName: `锁定测试产品 ${runId}`,
        quantity: 1,
        unitPrice: 100,
        currency: "CNY",
        exchangeRate: 1,
        exchangeRateDate: `${month}-10`,
        exchangeRateSource: "finance",
        settlementCurrency: "CNY",
        basisType: "receipt",
        basisDate: `${month}-10`,
        status: "confirmed"
      }
    });
    const recalculated = await apiFromPage<{ changedCalculations: Array<{ id: string }> }>(page, "/api/commission/calculations/recalculate", {
      method: "POST",
      body: { month, ownerId: "u_sales_shirley" }
    });
    const calculationId = recalculated.changedCalculations[0].id;
    await apiFromPage(page, `/api/commission/calculations/${calculationId}/review`, { method: "POST" });
    await apiFromPage(page, `/api/commission/calculations/${calculationId}/lock`, { method: "POST" });
    const lateRecord = await apiFromPage<{ record: { id: string } }>(page, "/api/commission/sales-records", {
      method: "POST",
      body: {
        ownerId: "u_sales_shirley",
        month,
        customerName: `锁定后新增客户 ${runId}`,
        productName: `锁定后新增产品 ${runId}`,
        quantity: 1,
        unitPrice: 200,
        currency: "CNY",
        exchangeRate: 1,
        exchangeRateDate: `${month}-11`,
        exchangeRateSource: "finance",
        settlementCurrency: "CNY",
        basisType: "receipt",
        basisDate: `${month}-11`,
        status: "draft"
      }
    });

    await openView(page, "commission");
    const monthRefresh = page.waitForResponse((response) =>
      response.url().includes(`/api/commission/sales-records?month=${month}`)
    );
    await page.locator("#commissionMonthInput").fill(month);
    await page.locator("#commissionMonthInput").press("Tab");
    await monthRefresh;
    await page.locator("#commissionOwnerInput").selectOption("u_sales_shirley");
    const row = page.locator(`#commissionRecordRows tr[data-commission-record-id="${lateRecord.record.id}"]`);
    await expect(row.locator("[data-edit-commission-record]")).toHaveCount(0);
    await expect(row.locator("[data-confirm-commission-record]")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "本月已锁定" })).toBeDisabled();

    const rejection = await page.evaluate(async ({ recordId }) => {
      const csrfToken = document.cookie
        .split("; ")
        .find((part) => part.startsWith("gj_csrf="))
        ?.split("=")
        .slice(1)
        .join("=");
      const response = await fetch(`/api/commission/sales-records/${recordId}/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(csrfToken ? { "x-csrf-token": decodeURIComponent(csrfToken) } : {})
        }
      });
      return { status: response.status, body: await response.json() };
    }, { recordId: lateRecord.record.id });
    expect(rejection.status).toBe(400);
    expect(rejection.body.message).toContain("本月提成单已锁定");
    expect(seedRecord.record.id).toBeTruthy();
  });

  test("reminders and import export modules perform real actions", async ({ page }) => {
    const reminderTitle = `自动化提醒-${runId}`;
    const importedCustomer = `Excel导入客户-${runId}`;
    await openView(page, "reminders");
    await page.locator("#reminders .page-head .btn.primary").click();
    await page.locator("#reminderTitleInput").fill(reminderTitle);
    await page.locator("#reminderRuleTypeInput").selectOption("inactive_customer");
    await page.locator("#reminderStageInput").selectOption("已报价");
    await page.locator("#reminderDaysInput").fill("0");
    await page.locator("#reminderPriorityInput").selectOption("high");
    await page.locator("#saveReminderButton").click();
    await expect(page.locator("#reminders .task-list")).toContainText(reminderTitle);
    await expect(page.locator("#reminders .task", { hasText: reminderTitle }).first()).toContainText("站内任务");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#reminders .task", { hasText: reminderTitle }).first().getByRole("button", { name: "手工运行" }).click();
    await expect(page.locator(".toast").last()).toContainText("手工运行完成");
    await expect(page.locator("#reminders .task", { hasText: reminderTitle }).first()).toContainText("最近手工运行");
    await openView(page, "dashboard");
    await expect(page.locator("#dashboard .todo-list")).toContainText(reminderTitle);
    await openView(page, "reminders");
    await page.getByRole("tab", { name: "待执行提醒" }).click();
    const reminderTask = page.locator("#reminders .reminder-task-card", { hasText: reminderTitle }).first();
    await expect(reminderTask).toBeVisible();
    await reminderTask.getByRole("button", { name: "记录结果" }).click();
    await page.locator("#reminderResultNote").fill("客户已回复，等待确认数量");
    await page.locator("#saveReminderResult").click();
    await expect(page.locator(".toast").last()).toContainText("跟进结果已记录");

    await openView(page, "imports");
    await page.locator("#customerImportInput").setInputFiles({
      name: `customers-${runId}.xlsx`,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buildCustomerWorkbookBuffer(importedCustomer)
    });
    await expect(page.locator("#customerImportFileName")).toContainText(`customers-${runId}.xlsx`);
    await page.locator("#runCustomerImportButton").click();
    await expect(page.locator(".toast").last()).toContainText("导入完成");
    await expect(page.locator("#imports tbody")).toContainText("客户导入");
    await openView(page, "customers");
    await expect(page.locator("#customers tbody")).toContainText(importedCustomer);
    await openView(page, "imports");
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#exportCustomersButton").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("GoodJob客户清单");
    await expect(page.locator("#imports tbody")).toContainText("客户清单导出");
  });

  test("reminders mobile view keeps the action queue readable and touchable", async ({ page }) => {
    const rule = await apiFromPage<{ reminder: { id: string } }>(page, "/api/reminders", {
      method: "POST",
      body: { title: `移动提醒-${runId}`, ruleType: "inactive_customer", targetStage: "已报价", days: 0, dueAt: "按触发日期生成", channel: "站内", priority: "high" }
    });
    const run = await apiFromPage<{ createdCount: number }>(page, `/api/reminders/${rule.reminder.id}/run`, { method: "POST" });
    expect(run.createdCount).toBeGreaterThan(0);
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await openView(page, "reminders");
    await expect(page.getByRole("tab", { name: "待执行提醒" })).toHaveClass(/active/);
    const card = page.locator("#reminders .reminder-task-card", { hasText: `移动提醒-${runId}` }).first();
    await expect(card).toBeVisible();
    const resultButton = card.getByRole("button", { name: "记录结果" });
    const snoozeButton = card.getByRole("button", { name: "延期" });
    expect((await resultButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect((await snoozeButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await snoozeButton.click();
    const expectedSnoozeAt = await page.evaluate(() => {
      const next = new Date();
      next.setDate(next.getDate() + 1);
      next.setHours(9, 0, 0, 0);
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T09:00`;
    });
    await expect(page.locator("#reminderSnoozeAt")).toHaveValue(expectedSnoozeAt);
    await page.getByRole("button", { name: "取消" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });

  test("document studio creates PI/CI documents and exports PDF task", async ({ page }) => {
    const docTitle = `自动化商业发票-${runId}`;
    await page.evaluate(() => {
      window.print = () => document.body.setAttribute("data-print-called", "true");
    });
    await openView(page, "documents");
    await expect(page.locator("#documents .doc-studio")).toBeVisible();
    await expect(page.locator("#documentPreview")).toContainText(/PROFORMA INVOICE|COMMERCIAL INVOICE/);

    await page.locator("#newDocumentButton").click();
    await page.locator("#documentTypeTabs button[data-doc-type='CI']").click();
    await page.locator("#docTitleInput").fill(docTitle);
    await page.locator("#docBuyerInput").fill(`发票客户-${runId}`);
    await page.locator("#docPortDischargeInput").fill("Hamburg");
    await page.locator("#docTemplateInput").selectOption("classic");
    await page.locator("#documentItemsEditor .doc-item-grid").first().locator("[data-doc-field='product']").fill("智能压力变送器 Smart Pressure Transmitter With Very Long Product Name For Wrapping Test");
    await page.locator("#documentItemsEditor .doc-item-grid").first().locator("[data-doc-field='hsCode']").fill("902620");
    await page.locator("#documentItemsEditor .doc-item-grid").first().locator("[data-doc-field='quantity']").fill("5");
    await page.locator("#documentItemsEditor .doc-item-grid").first().locator("[data-doc-field='unitPrice']").fill("210");
    await page.locator("#addDocumentItemButton").click();
    await page.locator("#documentItemsEditor .doc-item-grid").nth(1).locator("[data-doc-field='product']").fill("数字温度表");
    await page.locator("#documentItemsEditor .doc-item-grid").nth(1).locator("[data-doc-field='quantity']").fill("8");
    await page.locator("#documentItemsEditor .doc-item-grid").nth(1).locator("[data-doc-field='unitPrice']").fill("48");

    await expect(page.locator("#documentPreview")).toContainText("COMMERCIAL INVOICE");
    await expect(page.locator("#documentPreview")).toContainText("Export Documentation Center");
    await expect(page.locator("#documentPreview")).toContainText("智能压力变送器");
    await expect(page.locator("#documentPreview")).toContainText("HS Code");
    const tableFitsPaper = await page.locator("#documentPreview").evaluate((paper) => {
      const table = paper.querySelector("table");
      if (!table) return false;
      return table.getBoundingClientRect().right <= paper.getBoundingClientRect().right + 1;
    });
    expect(tableFitsPaper).toBe(true);
    await page.locator("#saveDocumentButton").click();
    await expect(page.locator(".toast").last()).toContainText("单据配置已保存到数据库");
    await expect(page.locator("#documentList")).toContainText(docTitle);

    await page.once("dialog", (dialog) => dialog.accept("确认客户、付款条款和交期"));
    await page.locator("#documentSubmitApprovalButton").click();
    await expect(page.locator("#docStatusBadge")).toContainText("待审批");
    await page.locator("#documentApproveButton").click();
    await expect(page.locator("#docStatusBadge")).toContainText("已审批");
    await page.locator("#saveDocumentButton").click();
    await expect(page.locator(".toast").last()).toContainText("不能直接覆盖");
    await page.locator("#documentSendButton").click();
    await page.locator("#documentSendRecipientInput").fill(`buyer-${runId}@example.com`);
    await page.locator("#confirmDocumentSendButton").click();
    await expect(page.locator(".toast").last()).toContainText("发送记录已保存");
    await page.locator("#documentNewRevisionButton").click();
    await expect(page.locator("#docStatusBadge")).toContainText("草稿");
    await expect(page.locator("#documentList")).toContainText(`${docTitle} v2`);

    await page.locator("#exportDocumentPdfButton").click();
    await expect(page.locator(".toast").last()).toContainText("已打印单据草稿");
    await expect(page.locator("body")).toHaveAttribute("data-print-called", "true");
  });

  test("document workflow remains usable on mobile", async ({ page }) => {
    await openView(page, "documents");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#documents .doc-workflow-bar")).toBeVisible();
    await expect(page.locator("#docCustomerInput")).toBeVisible();
    await expect(page.locator("#documentSubmitApprovalButton")).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      workflowWidth: document.querySelector<HTMLElement>(".doc-workflow-bar")?.getBoundingClientRect().width || 0
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.workflowWidth).toBeLessThanOrEqual(layout.viewport - 24);
  });

  test("knowledge and exam pages keep their dense content and key actions", async ({ page }) => {
    test.setTimeout(60_000);
    const assetTitle = `自动化资料-${runId}`;
    const examTitle = `自动化考试-${runId}`;
    const manualQuestion = `${examTitle} 中客户询价仪表时第一步确认什么？`;
    await openView(page, "knowledge");
    await expect(page.locator("#knowledge .knowledge-grid")).toBeVisible();
    await expect(page.locator("#knowledge .file-grid .file-card").first()).toBeVisible();

    await page.locator("#knowledge .page-head .btn.primary").click();
    await page.locator("#assetTitleInput").fill(assetTitle);
    await page.locator("#saveAssetButton").click();
    await expect(page.locator("#knowledge .file-grid")).toContainText(assetTitle);
    await openView(page, "dashboard");
    await expect(page.locator("#dashboard-knowledge-panel")).toHaveCount(0);

    await openView(page, "exam");
    await expect(page.locator("#exam .exam-grid")).toBeVisible();
    await page.locator("#exam .page-head .btn", { hasText: "题库维护" }).click();
    await expect(page.locator("#question-bank")).toHaveClass(/active/);
    await expect(page.locator("#question-bank h1")).toContainText("基础题库维护");
    await expect(page.locator("#question-bank .question-bank-import-row")).toBeVisible();
    await expect(page.locator("#question-bank .question-bank-list-panel #questionImportInput")).toHaveCount(1);
    await expect(page.locator("#question-bank .question-bank-editor-panel #questionImportInput")).toHaveCount(0);
    await expect(page.locator("#question-bank .question-option-input")).toHaveCount(4);
    await expect(page.locator("#question-bank .question-bank-editor-panel")).not.toContainText("选项 E");
    await expect(page.locator("#question-bank .question-bank-editor-panel")).not.toContainText("选项 F");
    await page.locator("#newQuestionButton").click();
    await page.locator("#questionStemInput").fill(manualQuestion);
    await page.locator("#questionCategoryInput").selectOption("仪表产品");
    await page.locator(".question-option-input").nth(3).fill("D选项：输出信号、供电和防护等级");
    await page.locator("#questionTypeInput").selectOption("multiple");
    await page.locator("#questionAnswerInput").fill("A,D");
    await page.locator("#questionTagsInput").fill(`仪表,自动化,${runId}`);
    await page.locator("#saveQuestionButton").click();
    await expect(page.locator(".toast").last()).toContainText("题目已加入基础题库");
    await expect(page.locator("#questionBankList")).toContainText(manualQuestion);

    await page.locator("#questionImportInput").setInputFiles({
      name: `exam-bank-${runId}.xlsx`,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buildQuestionWorkbookBuffer()
    });
    await page.locator("#importQuestionButton").click();
    await expect(page.locator(".toast").last()).toContainText("题库导入成功：2 道题");
    await expect(page.locator("#questionBankList")).toContainText("Excel导入压力仪表");
    await page.locator("#questionBankList .question-bank-row", { hasText: "Excel导入压力仪表" }).first().click();
    await page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#deleteQuestionButton").click();
    await expect(page.locator(".toast").last()).toContainText("题目已删除");
    await page.locator("#exportQuestionButton").click();
    await expect(page.locator(".toast").last()).toContainText("题库已导出");
    await page.locator("#backToExamButton").click();
    await expect(page.locator("#exam")).toHaveClass(/active/);

    await page.locator("#exam .page-head .btn.primary").click();
    await page.locator("#examTitleInput").fill(examTitle);
    await page.locator("#examCategoryInput").selectOption("仪表产品");
    await page.locator("#selectCategoryQuestionsButton").click();
    await expect(page.locator("#examCreateSelectionSummary")).toContainText(/已选 [1-9]/);
    await page.locator("#saveExamButton").click();
    await expect(page.locator(".toast").last()).toContainText("考试已创建，已组卷");
    await expect(page.locator("#exam .exam-sidebar .category-list")).toContainText(examTitle);
    await expect(page.locator("#exam .exam-paper")).toContainText(/Excel导入防爆仪表|客户询价仪表/);
    await expect(page.locator("#exam .exam-paper")).toContainText("多选");

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#exam .category-item", { hasText: examTitle }).first().getByRole("button", { name: "发布" }).click();
    await expect(page.locator(".toast").last()).toContainText("考试已发布");
    await page.locator("#exam .page-head .btn", { hasText: "分类目考试维护" }).click();
    await page.locator("#categoryExamInput").selectOption("仪表产品");
    await page.locator("#categoryExamTitleInput").fill(`专项-${runId}`);
    await page.locator("#createCategoryExamButton").click();
    await page.locator("#selectCategoryQuestionsButton").click();
    await page.locator("#saveExamButton").click();
    await expect(page.locator("#exam .exam-sidebar .category-list")).toContainText(`仪表产品专项-${runId}`);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#exam .category-item", { hasText: `仪表产品专项-${runId}` }).first().getByRole("button", { name: "删除" }).click();
    await expect(page.locator(".toast").last()).toContainText("考试已删除");
    await expect(page.locator("#exam .exam-sidebar .category-list")).not.toContainText(`仪表产品专项-${runId}`);

    const bulkExamTitles = [`批量删除A-${runId}`, `批量删除B-${runId}`];
    for (const title of bulkExamTitles) {
      await page.locator("#exam .page-head .btn.primary").click();
      await page.locator("#examTitleInput").fill(title);
      await page.locator("#examCategoryInput").selectOption("仪表产品");
      await page.locator("#selectCategoryQuestionsButton").click();
      await page.locator("#saveExamButton").click();
      await expect(page.locator("#exam .exam-sidebar .category-list")).toContainText(title);
    }
    for (const title of bulkExamTitles) {
      await page.locator("#exam .category-item", { hasText: title }).first().locator("[data-select-exam]").check();
    }
    await expect(page.locator("#exam .exam-bulk-bar")).toContainText("已选 2 场");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#exam [data-bulk-delete-exams]").click();
    await expect(page.locator(".toast").last()).toContainText("已批量删除 2 场考试");
    for (const title of bulkExamTitles) {
      await expect(page.locator("#exam .exam-sidebar .category-list")).not.toContainText(title);
    }

    await openView(page, "dashboard");
    await expect(page.locator("#dashboard-exam-panel")).toHaveCount(0);
    await expect(page.locator("#dashboard-gap-panel")).toHaveCount(0);

    await openView(page, "exam");
    await page.locator("#exam .category-item", { hasText: examTitle }).first().getByRole("button", { name: "考试" }).click();
    await expect(page.locator("#appModal [data-question]").first()).toBeVisible();
    const questionCount = await page.locator("#appModal [data-question]").count();
    expect(questionCount).toBeGreaterThanOrEqual(1);
    for (let index = 0; index < questionCount; index += 1) {
      const correctOptions = page.locator("#appModal [data-question]").nth(index).locator("[data-correct='true']");
      const correctCount = await correctOptions.count();
      for (let optionIndex = 0; optionIndex < correctCount; optionIndex += 1) {
        await correctOptions.nth(optionIndex).click();
      }
    }
    await page.locator("#submitExamButton").click();
    await expect(page.locator(".toast").last()).toContainText("交卷成功");
    await expect(page.locator("#exam .matrix-grid .panel").first()).toContainText(examTitle);
    await expect(page.locator("#exam .matrix-grid")).toContainText(/暂无补考人员|待补考/);
  });

  test("wecom sync and account management are operational", async ({ page }) => {
    const accountName = `Auto Account ${runId}`;
    await openView(page, "wecom");
    await expect(page.locator("#wecom .chat")).toBeVisible();
    await page.locator("#wecom .page-head .btn.primary").click();
    await expect(page.locator("#wecom .chat")).toContainText("已归档");

    await openView(page, "settings");
    await expect(page.locator("#settings tbody")).toContainText("账号管理仅管理员可用");
    await expect(page.locator("#settings .page-head .btn", { hasText: "新增账号" })).toBeDisabled();

    await page.locator("#logoutButton").click();
    await loginWithCredentials(page, "admin@goodjob.com", "goodjob123", "Admin");
    await openView(page, "settings");
    await expect(page.locator("#settings tbody")).toContainText("Super Admin");
    await expect(page.locator("#settings tbody tr", { hasText: "Super Admin" }).first().getByRole("button", { name: "受保护" })).toBeDisabled();
    await page.locator("#settings .page-head .btn", { hasText: "新增账号" }).click();
    await page.locator("#accountNameInput").fill(accountName);
    await page.locator("#accountEmailInput").fill(`auto.account.${runId}@goodjob.com`);
    await page.locator("#accountPasswordInput").fill(`pw${runId}`);
    await page.locator("#accountRoleInput").selectOption("sales");
    await page.locator("#saveAccountButton").click();
    await expect(page.locator("#settings tbody")).toContainText(accountName);

    await page.locator("#settings tbody tr", { hasText: accountName }).first().getByRole("button", { name: "设密码" }).click();
    await page.locator("#accountNewPasswordInput").fill(`newpw${runId}`);
    await page.locator("#savePasswordButton").click();
    await expect(page.locator(".toast").last()).toContainText("密码已更新");
    await page.locator("#logoutButton").click();
    await loginWithCredentials(page, `auto.account.${runId}@goodjob.com`, `newpw${runId}`, accountName);
    await expect(page.locator("#settings tbody")).not.toContainText("Super Admin");
    await page.locator("#logoutButton").click();
    await loginWithCredentials(page, "admin@goodjob.com", "goodjob123", "Admin");
    await openView(page, "settings");
    await page.locator("#settings tbody tr", { hasText: accountName }).first().getByRole("button", { name: "停用" }).click();
    await expect(page.locator("#settings tbody tr", { hasText: accountName }).first()).toContainText("停用");
    await page.locator("#settings tbody tr", { hasText: accountName }).first().getByRole("button", { name: "删除" }).click();
    await expect(page.locator(".toast").last()).toContainText("账号已删除");
    await expect(page.locator("#settings tbody")).not.toContainText(accountName);
  });

  test("tools OCR recognizes a card and syncs selected fields", async ({ page }) => {
    await openView(page, "tools");
    await expect(page.locator("#tools .tools-grid")).toBeVisible();

    await page.locator("#tools .section-head .btn", { hasText: "加载名片" }).click();
    await expect(page.locator("#tools .business-card")).toContainText("Demo Instrument Trading Co., Ltd.");
    await page.locator("#tools .field-card", { hasText: "公司名" }).locator("input[type='text']").fill("示例仪表");
    await page.locator("#tools .btn.primary", { hasText: /同步|确认同步/ }).first().click();

    await expect(page.locator("#tools .sync-row").nth(2)).toContainText("已同步");
    await expect(page.locator(".toast").last()).toContainText("OCR 线索已同步");
  });

  test("tools website scraping creates editable opportunities", async ({ page }) => {
    await openView(page, "tools");
    const websiteCompany = `example-instrument-${runId}`;
    await expect(page.locator("#aiConfigBadge")).toContainText(/规则解析|AI/);
    await page.locator("#aiConfigName").fill("自动化AI官网解析");
    await page.locator("#aiModelInput").fill("gpt-4o-mini");
    await page.locator("#aiEnabledInput").uncheck();
    await page.locator("#aiSaveButton").click();
    await expect(page.locator(".toast").last()).toContainText("已保存");
    await page.locator("#websiteUseAiInput").check();
    await page.locator("#websiteUrlInput").fill(`https://example.com/${websiteCompany}`);
    await page.locator("#tools .section-head .btn", { hasText: "解析官网" }).click();
    const aiToast = await page.locator(".toast").last().textContent();
    if (aiToast?.includes("请先保存并启用 AI 配置")) {
      await page.locator("#websiteUseAiInput").uncheck();
      await page.locator("#tools .section-head .btn", { hasText: "解析官网" }).click();
    }
    await expect(page.locator("#websiteOpportunityRows")).toContainText("example");
    await expect(page.locator("#websiteOpportunityRows")).toContainText("规则解析");
    const websiteRow = page.locator("#websiteOpportunityRows tr[data-website-opportunity-id]").first();
    const websiteCandidateId = await websiteRow.getAttribute("data-website-opportunity-id");
    expect(websiteCandidateId).toBeTruthy();
    const websiteContactInfo = `buyer.website.${runId}@example.com`;
    await websiteRow.locator("[data-website-field='company']").fill(`官网商机-${runId}`);
    await websiteRow.locator("[data-website-field='business']").fill("压力仪表 / 流量仪表");
    await websiteRow.locator("[data-website-field='contact']").fill("Website Buyer");
    await websiteRow.locator("[data-website-field='contactInfo']").fill(websiteContactInfo);
    await apiFromPage(page, `/api/prospect-list/${encodeURIComponent(websiteCandidateId!)}/details`, {
      method: "PATCH",
      body: {
        company: `官网商机-${runId}`,
        business: "压力仪表 / 流量仪表",
        country: await websiteRow.locator("[data-website-field='country']").inputValue(),
        website: await websiteRow.locator("[data-website-field='website']").inputValue(),
        contact: "Website Buyer",
        contactInfo: websiteContactInfo,
        description: await websiteRow.locator("[data-website-field='description']").inputValue()
      }
    });
    await apiFromPage(page, "/api/prospect-list/batch", {
      method: "PATCH",
      body: { ids: [websiteCandidateId], action: "mark-contactable" }
    });
    await page.locator("#tools .btn.primary", { hasText: "加入线索中心" }).click();
    await expect(page.locator(".toast").last()).toContainText("已加入 1 条线索");
    await openView(page, "leads");
    await expect(page.locator("#leadsTableBody")).toContainText(`官网商机-${runId}`);
    await openView(page, "pipeline");
    await expect(page.locator("#pipeline .pipeline-strip")).not.toContainText(`官网商机-${runId} 官网产品机会`);
  });

  test("lead management handles structured sources, trash, restore and permanent deletion", async ({ page }) => {
    const company = `线索工作区-${runId}`;
    const externalId = `ALI-RFQ-${runId}`;
    await openView(page, "leads");
    await page.locator("#leadNewButton").click();
    const form = page.locator("#leadCreateForm");
    await form.locator('[name="company"]').fill(company);
    await form.locator('[name="contact"]').fill("Lead Buyer");
    await form.locator('[name="country"]').fill("德国");
    await form.locator('[name="email"]').fill(`lead.${runId}@example.com`);
    await form.locator('[name="phone"]').fill("+49 30 1000 2000");
    await form.locator('[name="source"]').fill("Alibaba RFQ");
    await form.locator('[name="intent"]').selectOption("高");
    await form.locator('[name="estimatedAmount"]').fill("42000");
    await form.locator(".lead-create-advanced summary").click();
    await form.locator('[name="sourceType"]').selectOption("inbound");
    await form.locator('[name="sourceChannel"]').fill("alibaba");
    await form.locator('[name="sourceCampaign"]').fill("2026 Europe RFQ");
    await form.locator('[name="externalId"]').fill(externalId);
    await form.locator('[name="sourceUrl"]').fill(`https://partner.example/rfq/${runId}`);
    await form.locator('[name="nextFollowAt"]').fill("2026-07-12 10:00");
    await form.locator('[name="remark"]').fill("压力变送器，首轮确认量程与接口");
    await form.getByRole("button", { name: "保存线索" }).click();

    await expect(page.locator(".toast").last()).toContainText("线索已创建");
    await expect(page.locator("#leadDrawer")).not.toHaveClass(/open/);
    const createdRow = page.locator("#leadsTableBody tr", { hasText: company }).first();
    await createdRow.locator(".lead-name").click();
    await expect(page.locator("#leadDrawer")).toHaveClass(/open/);
    await expect(page.locator("#leadDrawer")).toContainText(company);
    await expect(page.locator("#leadDrawer")).toContainText("alibaba");
    await expect(page.locator("#leadDrawer")).toContainText(externalId);
    await expect(page.locator("#leadDrawer")).toContainText("同一业务员");
    await page.locator("#leadDrawer .lead-raw-payload summary").click();
    await expect(page.locator("#leadDrawer .lead-raw-payload")).toContainText("2026 Europe RFQ");

    await page.locator("#leadTrashButton").click();
    await page.locator("#confirmLeadTrashButton").click();
    await expect(page.locator(".toast").last()).toContainText("请填写删除原因");
    await page.locator("#leadDeleteReason").fill("测试垃圾箱审计");
    await page.locator("#confirmLeadTrashButton").click();
    await expect(page.locator(".toast").last()).toContainText("已移入垃圾箱");
    await expect(page.locator("#leadsTableBody")).not.toContainText(company);

    await page.locator("#leadTrashTab").click();
    const trashRow = page.locator("#leadsTableBody tr", { hasText: company }).first();
    await expect(trashRow).toBeVisible();
    await trashRow.locator(".lead-name").click();
    await expect(page.locator("#leadDrawer")).toContainText("测试垃圾箱审计");
    await expect(page.locator("#leadDrawer")).toContainText("计划清理");
    await page.locator("#leadRestoreButton").click();
    await expect(page.locator(".toast").last()).toContainText("已恢复到处理中");

    await page.locator("#leadActiveTab").click();
    const restoredRow = page.locator("#leadsTableBody tr", { hasText: company }).first();
    await expect(restoredRow).toBeVisible();
    await restoredRow.locator(".lead-name").click();
    await page.locator("#leadTrashButton").click();
    await page.locator("#leadDeleteReason").fill("永久删除流程测试");
    await page.locator("#confirmLeadTrashButton").click();
    await page.locator("#leadTrashTab").click();
    await page.locator("#leadsTableBody tr", { hasText: company }).first().locator(".lead-name").click();
    await page.locator("#leadPermanentButton").click();
    await page.locator("#confirmLeadPermanentButton").click();
    await expect(page.locator(".toast").last()).toContainText("请输入“永久删除”");
    await page.locator("#leadPermanentConfirmInput").fill("永久删除");
    await page.locator("#confirmLeadPermanentButton").click();
    await expect(page.locator(".toast").last()).toContainText("来源记录已永久删除");
    await expect(page.locator("#leadsTableBody")).not.toContainText(company);

    const convertedCompany = `已转客户线索-${runId}`;
    await page.locator("#leadActiveTab").click();
    await page.locator("#leadNewButton").click();
    await page.locator('#leadCreateForm [name="company"]').fill(convertedCompany);
    await page.locator('#leadCreateForm [name="source"]').fill("e2e");
    await page.locator("#leadCreateForm").getByRole("button", { name: "保存线索" }).click();
    await expect(page.locator("#leadDrawer")).not.toHaveClass(/open/);
    await page.locator("#leadsTableBody tr", { hasText: convertedCompany }).first().locator(".lead-name").click();
    await page.locator("#leadConvertButton").click();
    await page.locator('input[name="leadCustomerMode"][value="create"]').check();
    await page.locator("#confirmLeadConversionButton").click();
    await expect(page.locator(".toast").last()).toContainText("已入客户");
    await expect(page.locator("#leadDrawer")).toContainText("已转客户");
    await expect(page.locator("#leadTrashButton")).toHaveCount(0);
  });

  test("lead management uses mobile cards and a full-screen detail drawer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openView(page, "leads");
    await expect(page.locator("#leadMobileList .lead-mobile-card").first()).toBeVisible();
    await expect(page.locator(".lead-desktop-table")).toBeHidden();
    const overflowAudit = await page.evaluate(() => ({
      fits: document.documentElement.scrollWidth <= window.innerWidth,
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.right > window.innerWidth + 1;
        })
        .slice(0, 8)
        .map((element) => ({ tag: element.tagName, id: element.id, className: element.className, right: Math.round(element.getBoundingClientRect().right), width: Math.round(element.getBoundingClientRect().width) }))
    }));
    expect(overflowAudit.fits, JSON.stringify(overflowAudit)).toBe(true);
    const mobileCard = page.locator("#leadMobileList .lead-mobile-card").first();
    await mobileCard.locator(".lead-mobile-meta").click();
    await expect(page.locator("#leadDrawer")).not.toHaveClass(/open/);
    await mobileCard.locator(".lead-name").click();
    await expect(page.locator("#leadDrawer")).toHaveClass(/open/);
    const drawerBox = await page.locator("#leadDrawer").boundingBox();
    expect(drawerBox?.width).toBe(390);
    expect(drawerBox?.x).toBe(0);
    await page.locator("#leadDrawerClose").click();
    await expect(page.locator("#leadDrawer")).not.toHaveClass(/open/);
  });

  test("lead detail drawer keeps global module navigation available", async ({ page }) => {
    await openView(page, "leads");
    const firstLeadRow = page.locator("#leadsTableBody tr[data-lead-id]").first();
    await firstLeadRow.locator("td").nth(1).click();
    await expect(page.locator("#leadDrawer")).not.toHaveClass(/open/);
    await firstLeadRow.locator(".lead-name").click();
    await expect(page.locator("#leadDrawer")).toHaveClass(/open/);
    await expect(page.locator("#leadDrawerBackdrop")).toHaveClass(/active/);

    await page.locator(".sidebar button[data-view='customers']").click();

    await expect(page.locator("#customers")).toHaveClass(/active/);
    await expect(page.locator("#leadDrawer")).not.toHaveClass(/open/);
    await expect(page.locator("#leadDrawerBackdrop")).not.toHaveClass(/active/);
    await expect(page.locator("body")).not.toHaveClass(/lead-drawer-open/);
  });

  test("lead finder page searches candidates and links to CRM workflow", async ({ page }) => {
    const company = `leadfinder-${runId}`;
    await expect(page.locator(".nav button[data-view='dashboard'] + button[data-view='lead-finder']")).toBeVisible();
    await openView(page, "lead-finder");
    await expect(page.locator("#lead-finder .page-head")).toContainText("自动获客");
    await expect(page.locator("#leadFinderSearchLinks a").first()).toContainText(/pressure transmitter|flow meter/);
    await expect(page.locator(".lead-advanced-settings")).toHaveAttribute("open", "");
    await expect(page.locator(".lead-queue-panel")).toHaveAttribute("open", "");

    await page.locator("#leadFinderUrlInput").fill(`https://example.org/${company}`);
    await page.route("**/api/tools/website-scrape/preview", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.locator("#leadFinderStartButton").click();
    const jobCard = page.locator("#leadFinderJobList .lead-job-card").first();
    await expect(jobCard).toContainText("进行中");
    await jobCard.locator("[data-lead-job-toggle]").click();
    await expect(jobCard).toContainText("正在检索公开API");
    await expect(page.locator("#leadFinderResultRows")).toContainText("example.org");
    await expect(page.locator("#leadFinderJobList")).toContainText("已完成");
    await expect(jobCard).toContainText("example.org");
    await expect(page.locator("#leadFinderPendingCount")).not.toHaveText("0");

    let firstRow = page.locator("#leadFinderResultRows tr[data-lead-id]").first();
    await expect(firstRow.locator("[data-lead-select]")).not.toBeChecked();
    await firstRow.locator("[data-lead-field='company']").fill(company);
    await firstRow.locator("[data-lead-field='business']").fill("压力仪表 / 智能搜客测试");
    await firstRow.locator("[data-lead-field='country']").fill("德国");
    await firstRow.locator("[data-lead-field='contact']").fill("Lead Finder Buyer");
    const leadFinderContactInfo = `buyer.leadfinder.${runId}@example.com`;
    await firstRow.locator("[data-lead-field='contactInfo']").fill(leadFinderContactInfo);
    const leadFinderCandidateId = await firstRow.getAttribute("data-lead-id");
    expect(leadFinderCandidateId).toBeTruthy();
    await apiFromPage(page, `/api/prospect-list/${encodeURIComponent(leadFinderCandidateId!)}/details`, {
      method: "PATCH",
      body: {
        company,
        business: "压力仪表 / 智能搜客测试",
        country: "德国",
        website: await firstRow.locator("[data-lead-field='website']").inputValue(),
        contact: "Lead Finder Buyer",
        contactInfo: leadFinderContactInfo,
        description: await firstRow.locator("[data-lead-field='description']").inputValue()
      }
    });
    await apiFromPage(page, "/api/prospect-list/batch", {
      method: "PATCH",
      body: { ids: [leadFinderCandidateId], action: "mark-contactable" }
    });
    await page.reload();
    await openView(page, "lead-finder");
    firstRow = page.locator(`#leadFinderResultRows tr[data-lead-id="${leadFinderCandidateId}"]`);
    await expect(firstRow.locator("[data-lead-select]")).toBeEnabled();
    await firstRow.locator("[data-lead-select]").check();
    await firstRow.locator("[data-lead-pick]").evaluate((cell: HTMLElement) => cell.click());
    await expect(page.locator("#leadFinderDetail")).toContainText(company);
    await expect(page.locator("#leadFinderDetail")).toContainText("来源与外部编号");
    await expect(page.locator("#leadFinderDetail")).toContainText("重复与归属");

    await page.locator("#leadFinderTodoButton").click();
    await expect(page.locator(".toast").last()).toContainText("请先确认并加入线索");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#leadFinderSyncButton").click();
    await expect(page.locator(".toast").last()).toContainText("新建 1 条");
    await page.locator("#leadFinderTodoButton").click();
    await expect(page.locator(".toast").last()).toContainText("首个跟进待办");

    await openView(page, "leads");
    const leadRow = page.locator("#leadsTableBody tr", { hasText: company }).first();
    await expect(leadRow).toBeVisible();
    await leadRow.locator(".lead-name").click();
    await page.locator("#leadConvertButton").click();
    await expect(page.locator("#modalTitle")).toHaveText("转为客户");
    await page.locator('input[name="leadCustomerMode"][value="create"]').check();
    await page.locator("#leadCreateDealInput").check();
    const dealTitle = `${company} 首轮采购机会`;
    await page.locator("#leadDealTitleInput").fill(dealTitle);
    await page.locator("#leadDealProductInput").fill("压力仪表 / 智能搜客测试");
    await page.locator("#leadDealAmountInput").fill("28000");
    await page.locator("#leadDealNextActionInput").fill("确认技术参数并报价");
    await page.locator("#confirmLeadConversionButton").click();
    await expect(page.locator(".toast").last()).toContainText("已入客户并创建商机");
    await expect(page.locator("#leadDrawer")).toContainText("已转客户");
    await expect(page.locator("#leadDrawer")).toContainText("已建商机");
    await openView(page, "pipeline");
    await expect(page.locator("#pipeline .pipeline-strip")).toContainText(dealTitle);
    await page.locator("#topSearchInput").fill("搜客");
    await page.locator("#topSearchInput").press("Enter");
    await expect(page.locator("#lead-finder")).toHaveClass(/active/);
  });

  test("lead finder pagination and mobile layout remain usable", async ({ page }) => {
    await apiFromPage(page, "/api/tools/website-scrape/preview", {
      method: "POST",
      body: {
        urls: Array.from({ length: 12 }, (_, index) => `https://example.net/pagination-${runId}-${index + 1}`),
        useAi: false
      }
    });
    await page.reload();
    await openView(page, "lead-finder");
    await expect(page.locator("#leadFinderPageSummary")).toContainText(/共 \d+ 条/);
    await expect(page.locator("#leadFinderResultRows tr[data-lead-id]")).toHaveCount(10);
    await page.locator("#leadFinderNextPage").click();
    await expect(page.locator("#leadFinderPageNumber")).toContainText("2 /");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#leadFinderMobileRows")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBeFalsy();
  });

  test("prospect verification queue supports gated contact, pagination, bulk sync and lead return", async ({ page }) => {
    test.setTimeout(90_000);
    const prefix = `搜客清单自测-${runId}`;
    const previewResult = await apiFromPage<{ opportunities: Array<{ id: string }> }>(
      page,
      "/api/tools/website-scrape/preview",
      {
        method: "POST",
        body: {
          urls: Array.from({ length: 12 }, (_, index) => `https://example.com/prospect-${runId}-${index + 1}`),
          useAi: false
        }
      }
    );
    expect(previewResult.opportunities).toHaveLength(12);

    for (const [index, opportunity] of previewResult.opportunities.entries()) {
      await apiFromPage(page, `/api/prospect-list/${encodeURIComponent(opportunity.id)}/details`, {
        method: "PATCH",
        body: {
          company: `${prefix}-${String(index + 1).padStart(2, "0")}`,
          business: "工业仪表分销",
          country: index % 2 ? "德国" : "波兰",
          website: `https://example.com/prospect-${runId}-${index + 1}`,
          contact: "待核验采购联系人",
          contactInfo: "待维护",
          description: "E2E 搜客清单核验流程"
        }
      });
    }

    await openView(page, "prospect-list");
    await page.locator("#prospectRefreshButton").click();
    await page.locator("#prospectSearchInput").fill(prefix);
    await expect(page.locator("#prospectListRows .prospect-item")).toHaveCount(10);
    await expect(page.locator("#prospectPageNumber")).toHaveText("1 / 2");
    await expect(page.locator("#prospectPageSummary")).toContainText("第 1-10 条，共 12 条");
    await expect(page.locator("[data-prospect-filter]")).toHaveCount(6);
    await expect(page.locator("#prospectPreviewCount")).not.toHaveText("0");

    await page.locator("#prospectSelectPage").check();
    await expect(page.locator("#prospectSelectedCount")).toHaveText("已选 10 条");
    await page.locator("#prospectSelectPage").uncheck();
    await expect(page.locator("#prospectSelectedCount")).toHaveText("已选 0 条");
    await page.locator("#prospectNextPage").click();
    await expect(page.locator("#prospectListRows .prospect-item")).toHaveCount(2);
    await expect(page.locator("#prospectPageNumber")).toHaveText("2 / 2");
    await page.locator("#prospectPrevPage").click();

    const firstCompany = `${prefix}-01`;
    const secondCompany = `${prefix}-02`;
    const excludedCompany = `${prefix}-03`;
    await page.locator("#prospectSearchInput").fill(excludedCompany);
    await page.locator("#prospectListRows .prospect-item", { hasText: excludedCompany }).locator("[data-prospect-select]").check();
    await page.locator("#prospectExcludeButton").click();
    await expect(page.locator("#modalTitle")).toHaveText("排除候选");
    await page.locator("#prospectExcludeReasonInput").fill("非目标行业，E2E 验证排除原因");
    await page.locator("#confirmProspectExcludeButton").click();
    await expect(page.locator(".toast").last()).toContainText("已排除所选候选");
    await page.locator("[data-prospect-filter='excluded']").click();
    await expect(page.locator("#prospectListRows")).toContainText(excludedCompany);
    await page.locator("#prospectListRows .prospect-item", { hasText: excludedCompany }).locator("[data-prospect-open]").click();
    await expect(page.locator("#prospectDetail")).toContainText("非目标行业，E2E 验证排除原因");
    await page.locator("#prospectRestoreButton").click();
    await expect(page.locator(".toast").last()).toContainText("已恢复为待核验");

    await page.locator("[data-prospect-filter='all']").click();
    await page.locator("#prospectSearchInput").fill(firstCompany);
    await page.locator("#prospectListRows .prospect-item", { hasText: firstCompany }).locator("[data-prospect-open]").click();
    await expect(page.locator("#prospectDetail")).toContainText("待核验");
    await expect(page.locator("#prospectTodoButton")).toHaveCount(0);
    await expect(page.locator("#prospectDetailSyncButton")).toHaveCount(0);
    await page.locator("#prospectMailWorkspace").locator("summary").click();
    await page.locator("#prospectGenerateMailButton").click();
    await page.locator("#prospectSendMailButton").click();
    await expect(page.locator(".toast").last()).toContainText("请先核验联系方式并标记为可联系");

    await page.locator("#prospectListRows .prospect-item", { hasText: firstCompany }).locator("[data-prospect-select]").check();
    await page.locator("#prospectSyncButton").click();
    await expect(page.locator(".toast").last()).toContainText("只有“可联系”或“已联系”的候选可以入线索");
    await page.locator("#prospectListRows .prospect-item", { hasText: firstCompany }).locator("[data-prospect-open]").click();
    await page.locator("#prospectEditContact").fill("Anna Buyer");
    await page.locator("#prospectEditContactInfo").fill(`anna.${runId}@example.com`);
    await page.locator("#prospectEditDescription").fill("已核验官网采购邮箱，可进行首轮开发");
    await page.locator("#prospectSaveButton").click();
    await expect(page.locator(".toast").last()).toContainText("核验资料已保存");
    await page.locator("#prospectDetailMarkButton").click();
    await expect(page.locator(".toast").last()).toContainText("已标记为可联系");
    await expect(page.locator("#prospectDetail")).toContainText("可联系");
    await expect(page.locator("#prospectDetailSyncButton")).toBeVisible();
    await expect(page.locator("#prospectTodoButton")).toHaveCount(0);

    const secondId = previewResult.opportunities[1].id;
    await apiFromPage(page, `/api/prospect-list/${encodeURIComponent(secondId)}/details`, {
      method: "PATCH",
      body: {
        company: secondCompany,
        business: "工业仪表分销",
        country: "德国",
        website: `https://example.com/prospect-${runId}-2`,
        contact: "Mark Buyer",
        contactInfo: `mark.${runId}@example.com`,
        description: "已核验第二联系人"
      }
    });
    await apiFromPage(page, "/api/prospect-list/batch", {
      method: "PATCH",
      body: { ids: [secondId], action: "mark-contactable" }
    });
    await page.locator("#prospectRefreshButton").click();
    await page.locator("#prospectSearchInput").fill(prefix);

    for (const company of [firstCompany, secondCompany]) {
      await page.locator("#prospectListRows .prospect-item", { hasText: company }).locator("[data-prospect-select]").check();
    }
    await expect(page.locator("#prospectSelectedCount")).toHaveText("已选 2 条");
    await page.locator("#prospectSyncButton").click();
    await expect(page.locator(".toast").last()).toContainText("已加入 2 条线索");
    await expect(page.locator("#prospectSyncButton")).toHaveText("批量入线索");

    await page.locator("[data-prospect-filter='synced']").click();
    await expect(page.locator("#prospectListRows")).toContainText(firstCompany);
    await expect(page.locator("#prospectListRows")).toContainText(secondCompany);
    await page.locator("#prospectListRows .prospect-item", { hasText: firstCompany }).locator("[data-prospect-open]").click();
    await expect(page.locator("#prospectViewLeadButton")).toBeVisible();
    await expect(page.locator("#prospectTodoButton")).toBeVisible();
    await page.locator("#prospectViewLeadButton").click();
    await expect(page.locator("#leads")).toHaveClass(/active/);
    await expect(page.locator("#leadDrawer")).toContainText(firstCompany);
    await expect(page.locator("#leadBackToProspectButton")).toBeVisible();
    await page.locator("#leadBackToProspectButton").click();
    await expect(page.locator("#prospect-list")).toHaveClass(/active/);
    await expect(page.locator("#prospectDetail")).toContainText(firstCompany);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLayout = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      listColumns: getComputedStyle(document.querySelector(".prospect-list-layout")!).gridTemplateColumns
    }));
    expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth + 1);
    expect(mobileLayout.listColumns.split(" ")).toHaveLength(1);
    await expect(page.locator("#prospect-list .lead-command-strip")).toBeVisible();
    await expect(page.locator("#prospectDetail")).toBeVisible();
  });

  test("ai config page saves GPT API key and tests connectivity", async ({ page }) => {
    await openView(page, "ai-config");
    await expect(page.locator("#ai-config .page-head")).toContainText("AI模型配置");
    await expect(page.locator("#ai-config")).toContainText("OpenAI GPT");

    await page.locator("#gptConfigName").fill(`自动化GPT配置-${runId}`);
    await page.locator("#gptBaseUrlInput").fill("https://example.com/v1");
    await page.locator("#gptModelInput").fill("gpt-4o-mini");
    await page.locator("#gptApiKeyInput").fill(`sk-test-${runId}`);
    await page.locator("#gptEnabledSelect").selectOption("true");
    await page.locator("#gptSaveButton").click();
    await expect(page.locator(".toast").last()).toContainText("已保存并启用");
    await expect(page.locator("#gptApiKeyInput")).toHaveValue(/\\*\\*\\*\\*/);
    await expect(page.locator("#gptConfigState")).toContainText("已启用");
    await expect(page.locator("#aiConfigList")).toContainText(`自动化GPT配置-${runId}`);

    await page.locator("#gptTestButton").click();
    await expect(page.locator("#gptConnectionBadge")).toContainText("连接失败");
    await expect(page.locator(".toast").last()).toContainText("AI 连接失败");

    await page.locator("#topSearchInput").fill("gpt");
    await page.locator("#topSearchInput").press("Enter");
    await expect(page.locator("#ai-config")).toHaveClass(/active/);
  });

  test("profile page binds outbound email and signature", async ({ page }) => {
    await expect(page.locator(".nav-primary [data-view='whatsapp']")).toHaveCount(0);
    await page.locator("#profileEntryButton").click();
    await expect(page.locator("#profile")).toHaveClass(/active/);
    await expect(page.locator("#profileNameTitle")).toContainText("Alex");
    await expect(page.locator("#profileOpenWhatsAppButton")).toBeVisible();
    await page.locator("#profileOpenWhatsAppButton").click();
    await expect(page.locator("#whatsapp")).toHaveClass(/active/);
    await expect(page.locator("#whatsapp .page-head .sub")).toHaveText("开发中");
    await page.locator("#profileEntryButton").click();

    const outboundEmail = `alex.sender.${runId}@example.com`;
    await page.locator("#profileOutboundEmail").fill(outboundEmail);
    await page.locator("#profileSenderName").fill("Alex Export");
    await page.locator("#profileEmailSignature").fill("Best regards\\nAlex Export\\nGoodJob CRM");
    await page.locator("#profileSaveButton").click();
    await expect(page.locator(".toast").last()).toContainText("个人邮箱配置已保存");
    await expect(page.locator("#profileEmailStatus")).toContainText(outboundEmail);

    // 开发信触达已迁移到「搜客清单」页执行；个人主页只负责发件邮箱与签名绑定。
    await page.locator("#topSearchInput").fill("个人设置");
    await page.locator("#topSearchInput").press("Enter");
    await expect(page.locator("#profile")).toHaveClass(/active/);
  });

  test("competitor intelligence can create and update threat level", async ({ page }) => {
    const company = `自动化竞品公司-${runId}`;
    await openView(page, "competitors");
    await expect(page.locator("#competitors .intel-grid")).toBeVisible();
    await expect(page.locator("#competitors .intel-list .intel-card").first()).toBeVisible();

    await page.locator("#competitors .page-head .btn.primary").click();
    await page.locator("#competitorCompanyInput").fill(company);
    await page.locator("#competitorThreatInput").selectOption("high");
    await page.locator("#competitorProductsInput").fill("自动化测试产品");
    await page.locator("#competitorStrengthsInput").fill("本地仓交期快");
    await page.locator("#competitorWeaknessesInput").fill("定制能力弱");
    await page.locator("#competitorStrategyInput").fill("用小批量定制和资料完整度应对");
    await page.locator("#saveCompetitorButton").click();

    await expect(page.locator("#competitors .intel-list")).toContainText(company);
    await expect(page.locator("#competitor-detail-title")).toContainText(company);
    await expect(page.locator("#competitor-products")).toContainText("自动化测试产品");
    await page.locator("#competitorThreatButton").click();
    await expect(page.locator(".toast").last()).toContainText("中威胁");
  });

  test("case study library can create and publish a success case", async ({ page }) => {
    const caseTitle = `自动化成功案例-${runId}`;
    await openView(page, "cases");
    await expect(page.locator("#cases .case-grid")).toBeVisible();
    await expect(page.locator("#cases .case-list .case-card").first()).toBeVisible();

    await page.locator("#cases .page-head .btn.primary").click();
    await page.locator("#caseTitleInput").fill(caseTitle);
    await page.locator("#caseProductInput").fill("自动化工具套装");
    await page.locator("#caseIndustryInput").fill("工具批发");
    await page.locator("#caseResultInput").fill("拿下自动化首单");
    await page.locator("#caseStoryInput").fill("资料齐全后客户快速确认订单。");
    await page.locator("#caseReusableInput").fill("资料先行，报价后 48 小时复盘。");
    await page.locator("#saveCaseButton").click();

    await expect(page.locator("#cases .case-list")).toContainText(caseTitle);
    await expect(page.locator("#case-detail-title")).toContainText(caseTitle);
    await expect(page.locator("#case-product")).toContainText("自动化工具套装");
    await page.locator("#casePublishButton").click();
    await expect(page.locator(".toast").last()).toContainText("成功案例已发布");
    await expect(page.locator("#cases .case-card", { hasText: caseTitle }).first()).toContainText("已发布");
  });

  test("problem list can create and advance a solution workflow", async ({ page }) => {
    const problemTitle = `自动化问题-${runId}`;
    await openView(page, "problems");
    await expect(page.locator("#problems .problem-grid")).toBeVisible();
    await expect(page.locator("#problems .problem-list .problem-card").first()).toBeVisible();

    await page.locator("#problems .page-head .btn.primary").click();
    await page.locator("#problemTitleInput").fill(problemTitle);
    await page.locator("#problemSeverityInput").selectOption("high");
    await page.locator("#problemCustomerInput").fill("示例仪表客户");
    await page.locator("#problemRootInput").fill("客户审批缺少认证资料");
    await page.locator("#problemSolutionInput").fill("补发 CE 证书并同步报价模板");
    await page.locator("#problemNextInput").fill("今天 18:00 前完成二次确认");
    await page.locator("#saveProblemButton").click();

    await expect(page.locator("#problems .problem-list")).toContainText(problemTitle);
    await expect(page.locator("#problem-detail-title")).toContainText(problemTitle);
    await page.locator("#problemStatusButton").click();
    await expect(page.locator(".toast").last()).toContainText("解决中");
    await page.locator("#problemStatusButton").click();
    await expect(page.locator(".toast").last()).toContainText("已解决");
  });

  test("memo page can search autosave relate archive and recover notes", async ({ page }) => {
    const memoTitle = `自动化备忘-${runId}`;
    const switchMemoTitle = `切换目标备忘-${runId}`;
    await openView(page, "memos");
    await expect(page.locator("#memos .memo-grid")).toBeVisible();
    await expect(page.locator("#memos .memo-list .memo-card").first()).toBeVisible();

    await page.locator("#memos .page-head .btn.primary").click();
    await page.locator("#memoTitleInput").fill(memoTitle);
    await page.locator("#memoContentInput").fill("客户要求下次报价拆分认证资料和交期说明。");
    await page.locator(".memo-create-options summary").click();
    await page.locator("#memoCategoryInput").selectOption("客户备忘");
    await page.locator("#memoTagsInput").fill("自动化,客户");
    await page.locator("#memoDealInput").selectOption("d1");
    await page.locator("#saveMemoButton").click();

    await expect(page.locator("#memos .memo-list")).toContainText(memoTitle);
    await expect(page.locator("#memoTitleEditor")).toHaveValue(memoTitle);
    await expect(page.locator("#memoCustomerEditor")).toHaveValue("c1");
    await expect(page.locator("#memoDealEditor")).toHaveValue("d1");
    await page.locator("#memoSearchInput").fill("认证资料");
    await expect(page.locator("#memos .memo-list")).toContainText(memoTitle);
    await page.locator("#memoSearchInput").fill("");
    await page.locator("#memos .page-head .btn.primary").click();
    await page.locator("#memoTitleInput").fill(switchMemoTitle);
    await page.locator("#memoContentInput").fill("用于验证切换时自动保存。");
    await page.locator("#saveMemoButton").click();
    await expect(page.locator("#memos .memo-list")).toContainText(switchMemoTitle);
    await page.locator("#memos .memo-card", { hasText: memoTitle }).first().click();
    await page.locator("#memoContentEditor").fill("自动保存验证：切换左侧备忘前保存当前正文。");
    await expect(page.locator("#memoSaveState")).toContainText(/仅保存在本机|保存中/);
    await expect(page.locator("#memoSaveState")).toContainText("已保存到服务器", { timeout: 5000 });
    await page.locator("#memos .memo-card", { hasText: switchMemoTitle }).first().click();
    await page.locator("#memos .memo-card", { hasText: memoTitle }).first().click();
    await expect(page.locator("#memoContentEditor")).toHaveValue("自动保存验证：切换左侧备忘前保存当前正文。");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#memos .memo-detail")).toBeVisible();
    await expect(page.locator("#memos .memo-sidebar")).toBeHidden();
    const memoMobileLayout = await page.evaluate(() => ({
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      titleWidth: document.querySelector("#memo-detail-title")?.getBoundingClientRect().width || 0,
      actionHeights: ["#memoSaveState", "#memoPinButton", "#memoArchiveButton", "#memoDeleteButton"]
        .map((selector) => document.querySelector(selector)?.getBoundingClientRect().height || 0)
    }));
    expect(memoMobileLayout.noHorizontalOverflow).toBe(true);
    expect(memoMobileLayout.titleWidth).toBeGreaterThan(150);
    expect(memoMobileLayout.actionHeights.every((height) => height >= 44)).toBe(true);
    await page.locator("#memoBackButton").click();
    await expect(page.locator("#memos .memo-sidebar")).toBeVisible();
    await expect(page.locator("#memos .memo-detail")).toBeHidden();
    await page.locator("#memos .memo-card", { hasText: memoTitle }).first().click();
    await expect(page.locator("#memos .memo-detail")).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#memoPinButton").click();
    await expect(page.locator("#memos .memo-card", { hasText: memoTitle }).first()).toContainText("置顶");
    await page.locator("#memoArchiveButton").click();
    await expect(page.locator("#memos .memo-card", { hasText: memoTitle }).first()).toContainText("归档");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#memoDeleteButton").click();
    await expect(page.locator(".toast").last()).toContainText("已移至已删除");
    await expect(page.locator("#memos .memo-card", { hasText: memoTitle }).first()).toContainText("已删除");
    await page.locator("#memoArchiveButton").click();
    await expect(page.locator(".toast").last()).toContainText("恢复到归档");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#memoDeleteButton").click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#memoDeleteButton").click();
    await expect(page.locator(".toast").last()).toContainText("永久删除");
    await expect(page.locator("#memos .memo-card", { hasText: memoTitle })).toHaveCount(0);
  });

  test("executive report exports a presentation-ready file", async ({ page }) => {
    await openView(page, "reports");
    await expect(page.locator("#reports .report-deck")).toBeVisible();
    await expect(page.locator("#reportHeadline")).not.toContainText("正在加载", { timeout: 8_000 });
    await expect(page.locator("#reportPeriod")).toContainText("外贸销售实时经营快照");
    await expect(page.locator("#reportScope")).toContainText("本团队业务");
    await expect(page.locator("#reportAmountBasis")).toContainText("金额口径");
    await expect(page.locator("#reports")).not.toContainText("$428k");
    await expect(page.locator("#reports")).not.toContainText("42 单");
    await expect(page.locator("#reportPerformanceTable")).toBeVisible();
    await expect(page.locator("#reportPerformanceRows")).toContainText("Shirley");
    await expect(page.locator("#reportPerformanceRows")).toContainText("Mia");

    const scopedReports = await page.evaluate(async () => {
      const readReport = async (email: string) => {
        const loginResponse = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: "goodjob123" })
        });
        const login = await loginResponse.json();
        const reportResponse = await fetch("/api/reports/executive", {
          headers: { authorization: `Bearer ${login.token}` }
        });
        return reportResponse.json();
      };
      return {
        sales: await readReport("shirley@goodjob.com"),
        admin: await readReport("admin@goodjob.com")
      };
    });
    expect(scopedReports.sales.scope.label).toBe("本人业务");
    expect(scopedReports.sales.performance.every((row: { owner: string }) => row.owner === "Shirley")).toBe(true);
    expect(scopedReports.admin.scope.label).toBe("全公司业务");

    await page.locator("#reports .page-head .btn", { hasText: "汇报备注" }).click();
    await page.locator("#reportNoteInput").fill("自动化汇报备注：本周聚焦报价逾期客户");
    await page.locator("#saveReportNoteButton").click();
    await expect(page.locator("#reports .report-hero")).toContainText("自动化汇报备注");

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#reportExportButton").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("GoodJob-CRM");
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const exportText = await readFile(downloadPath!, "utf8");
    expect(exportText).toContain("本团队业务");
    expect(exportText).toContain("自动化汇报备注");
    expect(exportText).not.toContain("$428k");
    await expect(page.locator(".toast").last()).toContainText("汇报已生成下载");

    const riskButton = page.locator("#reportRiskDetailButton");
    if (await riskButton.isEnabled()) {
      await riskButton.click();
      await expect(page.locator(".modal")).toContainText("风险商机明细");
      await page.locator(".modal [data-modal-close]").last().click();
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileReportLayout = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      performanceCards: getComputedStyle(document.querySelector("#reportPerformanceCards")!).display,
      performanceTable: getComputedStyle(document.querySelector("#reportPerformanceTable")!).display
    }));
    expect(mobileReportLayout.documentWidth).toBeLessThanOrEqual(mobileReportLayout.viewportWidth + 1);
    expect(mobileReportLayout.performanceCards).toBe("grid");
    expect(mobileReportLayout.performanceTable).toBe("none");
  });
});
