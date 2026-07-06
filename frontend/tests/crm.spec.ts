import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";

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

async function openView(page: import("@playwright/test").Page, view: string) {
  await page.locator(`.nav button[data-view="${view}"]`).click();
  await expect(page.locator(`#${view}`)).toHaveClass(/active/);
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
    await page.addInitScript(() => {
      localStorage.clear();
    });
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
    await expect(page.locator("[data-top-view='dashboard']")).toHaveClass(/active/);

    await page.locator("#topSearchInput").fill("考试");
    await page.locator("#topSearchInput").press("Enter");
    await expect(page.locator("#exam")).toHaveClass(/active/);
    await expect(page.locator("[data-top-view='exam']")).toHaveClass(/active/);
    await expect(topSearch).not.toHaveClass(/is-hidden/);
    await expect(topContext).toHaveClass(/is-hidden/);
    await expect(topPrimary).toBeHidden();

    await page.locator("[data-top-view='reports']").click();
    await expect(page.locator("#reports")).toHaveClass(/active/);
    await expect(page.locator("[data-top-view='reports']")).toHaveClass(/active/);
    await expect(topSearch).not.toHaveClass(/is-hidden/);
    await expect(topContext).toHaveClass(/is-hidden/);
    await expect(page.locator("#reports .page-head")).toContainText("导出 PDF");

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
    await expect(page.locator(".focus-top")).toContainText("今日优先处理建议");
    await expect(page.locator(".focus-title h2")).toContainText("待办");
    await expect(page.locator("#briefingBasis")).toContainText("依据");
    await expect(page.locator("#briefingAction")).toContainText("建议动作");
    await expect(page.locator("#briefingImpact")).toContainText("影响范围");
    await expect(page.locator("#dashboard .section-title", { hasText: "管道健康度" })).toContainText("真实商机阶段");
    await expect(page.locator("#dashboard .bars")).toContainText("单");
    await expect(page.locator("#dashboard .bars")).toContainText("$");
    await expect(page.locator("#dashboard .task-list .task").first()).toContainText("分");
    await expect(page.locator("#dashboard .task-list .task").first()).toContainText("金额权重");
    await expect(page.locator("#dashboardPeriodTabs [data-dashboard-period='today']")).toHaveClass(/active/);
    await page.locator("#dashboardPeriodTabs [data-dashboard-period='week']").click();
    await expect(page.locator("#dashboardPeriodTabs [data-dashboard-period='week']")).toHaveClass(/active/);
    await expect(page.locator(".focus-top span").first()).toContainText("本周优先处理建议");
    await expect(page.locator("#dashboard .schedule-panel .section-title h2")).toContainText("本周节奏");
    await page.locator("#dashboardPeriodTabs [data-dashboard-period='month']").click();
    await expect(page.locator("#dashboardPeriodTabs [data-dashboard-period='month']")).toHaveClass(/active/);
    await expect(page.locator(".focus-top span").first()).toContainText("本月优先处理建议");
    await expect(page.locator("#dashboard .schedule-panel .section-title h2")).toContainText("本月节奏");
    await expect(page.locator("#morningPanel")).not.toHaveClass(/active/);
    await page.locator("#morningViewButton").click();
    await expect(page.locator("#morningPanel")).toHaveClass(/active/);
    await expect(page.locator("#morningPanel")).toContainText("晨会视图");
    await expect(page.locator("#morningSubtitle")).toContainText("本月晨会同步");
    await expect(page.locator("#morningRisk")).toContainText("$");
    await page.locator("#dashboardPeriodTabs [data-dashboard-period='today']").click();
    await expect(page.locator("#morningSubtitle")).toContainText("今日晨会同步");
    await page.locator("#batchPriorityButton").click();
    await expect(page.locator(".toast").last()).toContainText(/已生成|无需重复生成/);
    const todoKpi = page.locator("#dashboard .kpi").filter({ hasText: "今日待跟进" }).locator("strong");
    const beforeTodoCount = Number(await todoKpi.textContent());
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
    await expect(todoKpi).toHaveText(String(beforeTodoCount + 2));
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
    await expect(todoKpi).toHaveText(String(beforeTodoCount));
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

  test("instrument growth page creates execution assets", async ({ page }) => {
    await openView(page, "instrument-growth");
    await expect(page.locator("#instrument-growth")).toContainText("仪表外贸新客户开拓作战台");
    await expect(page.locator("#instrument-growth")).toContainText("前置知识清单");
    await expect(page.locator("#instrument-growth")).toContainText("客户画像与搜索入口");
    await expect(page.locator("#instrument-growth")).toContainText("首周执行拆解");
    await expect(page.locator("#instrument-growth")).toContainText("英文话术与参数确认");
    await expect(page.locator("#instrument-growth")).toContainText("KPI周报");

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#instrumentExportButton").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("仪表外贸新客户开拓90天执行表");
    await expect(page.locator(".toast").last()).toContainText("仪表开拓执行表已导出");

    await expect(page.locator("#instrumentTodoButton")).toContainText("一键推到待办清单");
    await page.locator("#instrumentTodoButton").click();
    await expect(page.locator(".toast").last()).toContainText(/已生成|已存在/);
    await openView(page, "dashboard");
    await expect(page.locator("#dashboard .todo-list")).toContainText("第1天：整理仪表产品分类与参数卡");

    await openView(page, "instrument-growth");
    await page.locator("#instrumentMemoButton").click();
    await expect(page.locator(".toast").last()).toContainText(/已写入备忘|备忘已更新/);
    await openView(page, "memos");
    await expect(page.locator("#memos .memo-list")).toContainText("仪表外贸新客户开拓90天执行方案");
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
    await page.locator("#customers tbody tr", { hasText: "Nordic Tools AB" }).first().click();
    await expect(page.locator("#customers .drawer")).toContainText("相关商机进展");
    await expect(page.locator("#customers .drawer")).toContainText("Nordic Tools 电动工具年度采购");

    await page.locator("#customers .page-head .btn.primary").click();
    await page.locator("#customerCompanyInput").fill(company);
    await page.locator("#customerContactInput").fill("Demo Contact");
    await page.locator("#customerAmountInput").fill("36000");
    await page.locator("#saveCustomerButton").click();

    await expect(page.locator("#customers tbody")).toContainText(company);
    await expect(page.locator("#customers .drawer")).toContainText(company);
    await expect(page.locator("#customers .drawer")).toContainText("暂无关联商机");
    await expect(page.locator(".toast").last()).toContainText("客户已新增");

    await page.locator("#customers .drawer [data-edit-customer-drawer]").click();
    await page.locator("#customerCompanyInput").fill(companyEdited);
    await page.locator("#customerStageInput").selectOption("谈判");
    await page.locator("#customerReminderInput").fill("明天 18:00");
    await page.locator("#customerWecomInput").selectOption("true");
    await page.locator("#saveCustomerButton").click();
    await expect(page.locator(".toast").last()).toContainText("客户已保存");
    await expect(page.locator("#customers tbody")).toContainText(companyEdited);
    await expect(page.locator("#customers .drawer")).toContainText("明天 18:00");

    await page.locator("#customers .drawer [data-add-follow]").click();
    await expect(page.locator("#customers .drawer .timeline")).toContainText("手动跟进");

    for (const name of [deleteCompanyA, deleteCompanyB]) {
      await page.locator("#customers .page-head .btn.primary").click();
      await page.locator("#customerCompanyInput").fill(name);
      await page.locator("#customerContactInput").fill("Delete User");
      await page.locator("#customerAmountInput").fill("12000");
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

  test("pipeline can create and move a deal", async ({ page }) => {
    const dealTitle = `自动化商机-${runId}`;
    const emptyCustomerDeal = `无关联商机-${runId}`;
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
    await page.locator("#pipeline .deal", { hasText: dealTitle }).first().getByRole("button", { name: "编辑" }).click();
    await page.locator("#dealProductInput").fill("自动化差压仪表");
    await page.locator("#dealQuantityInput").fill("16");
    await page.locator("#dealUnitPriceInput").fill("1800");
    await page.locator("#dealNextActionInput").fill("确认修订报价");
    await expect(page.locator("#dealAmountInput")).toHaveValue("28800");
    await page.locator("#saveDealButton").click();
    await expect(page.locator(".toast").last()).toContainText("商机已更新");
    await expect(page.locator("#pipeline .deal", { hasText: dealTitle }).first()).toContainText("自动化差压仪表");
    await expect(page.locator("#pipeline .deal", { hasText: dealTitle }).first()).toContainText("确认修订报价");
    const dealActions = page.locator("#pipeline .deal", { hasText: dealTitle }).first().locator(".deal-actions button");
    await expect(dealActions.last()).toHaveText("推进阶段");
    await page.locator("#pipeline .deal", { hasText: dealTitle }).first().getByRole("button", { name: "打印PI" }).click();
    await expect(page.locator("#documents")).toHaveClass(/active/);
    await expect(page.locator("#documentPreview")).toContainText("PROFORMA INVOICE");
    await expect(page.locator("#documentPreview")).toContainText(`Nordic Print Buyer ${runId}`);
    await expect(page.locator("#documentPreview")).toContainText("自动化差压仪表");
    await expect(page.locator("body")).toHaveAttribute("data-print-called", "true");
    await openView(page, "pipeline");
    await page.locator("#pipeline .deal", { hasText: dealTitle }).first().getByRole("button", { name: "推进阶段" }).click();
    await expect(page.locator(".toast").last()).toContainText("商机已推进到");
    for (let index = 0; index < 4; index += 1) {
      await page.locator("#pipeline .deal", { hasText: dealTitle }).first().getByRole("button", { name: "推进阶段" }).click();
    }
    await expect(page.locator("#pipeline .deal", { hasText: dealTitle }).first()).toContainText("成交");
    await expect(page.locator("#pipeline .deal", { hasText: dealTitle }).first().getByRole("button", { name: "打印CI" })).toBeVisible();
    await page.locator("#pipeline .deal", { hasText: dealTitle }).first().getByRole("button", { name: "打印CI" }).click();
    await expect(page.locator("#documents")).toHaveClass(/active/);
    await expect(page.locator("#documentPreview")).toContainText("COMMERCIAL INVOICE");
    await expect(page.locator("#documentPreview")).toContainText(`Nordic Print Buyer ${runId}`);
    await openView(page, "pipeline");
    await page.locator("#pipeline .deal", { hasText: dealTitle }).first().getByRole("button", { name: "归档" }).click();
    await expect(page.locator(".toast").last()).toContainText("商机已归档");
    await expect(page.locator("#pipeline .pipeline-strip")).not.toContainText(dealTitle);
    await expect(page.locator("#pipeline-archived-deals")).toContainText(dealTitle);

    await page.locator("#pipeline .page-head .btn.primary").click();
    await page.locator("#dealTitleInput").fill(emptyCustomerDeal);
    await page.locator("#clearDealCustomerButton").click();
    await expect(page.locator("#dealCustomerInput")).toHaveValue("");
    await page.locator("#saveDealButton").click();
    await expect(page.locator("#pipeline .pipeline-strip")).toContainText(emptyCustomerDeal);

    await page.locator("#pipeline .page-head .btn.primary").click();
    await page.locator("#dealTitleInput").fill(lostDeal);
    await page.locator("#dealProductInput").fill("丢单测试仪表");
    await page.locator("#dealQuantityInput").fill("9");
    await page.locator("#dealUnitPriceInput").fill("1000");
    await page.locator("#saveDealButton").click();
    await expect(page.locator("#pipeline .pipeline-strip")).toContainText(lostDeal);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#pipeline .deal", { hasText: lostDeal }).first().getByRole("button", { name: "丢单" }).click();
    await expect(page.locator(".toast").last()).toContainText("商机已标记丢单");
    await expect(page.locator("#pipeline .pipeline-strip")).not.toContainText(lostDeal);
    await expect(page.locator("#pipeline-archived-deals")).toContainText(lostDeal);
    await expect(page.locator("#pipeline-archived-deals")).toContainText("丢单");
  });

  test("reminders and import export modules perform real actions", async ({ page }) => {
    const reminderTitle = `自动化提醒-${runId}`;
    const importedCustomer = `Excel导入客户-${runId}`;
    await openView(page, "reminders");
    await page.locator("#reminders .page-head .btn.primary").click();
    await page.locator("#reminderTitleInput").fill(reminderTitle);
    await page.locator("#reminderRuleTypeInput").selectOption("quote_no_reply");
    await page.locator("#reminderStageInput").selectOption("已报价");
    await page.locator("#reminderDaysInput").fill("2");
    await page.locator("#reminderPriorityInput").selectOption("high");
    await page.locator("#saveReminderButton").click();
    await expect(page.locator("#reminders .task-list")).toContainText(reminderTitle);
    await expect(page.locator("#reminders .task", { hasText: reminderTitle }).first()).toContainText("命中");
    await page.locator("#reminders .task", { hasText: reminderTitle }).first().getByRole("button", { name: "执行规则" }).click();
    await expect(page.locator(".toast").last()).toContainText("规则已执行");
    await openView(page, "dashboard");
    await expect(page.locator("#dashboard .todo-list")).toContainText(reminderTitle);
    await openView(page, "reminders");

    await page.locator("#reminders .task", { hasText: reminderTitle }).first().getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.locator(".toast").last()).toContainText("提醒已完成");

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

    await page.locator("#exportDocumentPdfButton").click();
    await expect(page.locator(".toast").last()).toContainText("已生成 PDF 导出任务");
    await expect(page.locator("body")).toHaveAttribute("data-print-called", "true");
    await openView(page, "imports");
    await expect(page.locator("#imports tbody")).toContainText("单据 PDF 导出");
  });

  test("knowledge and exam pages keep their dense content and key actions", async ({ page }) => {
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
    await expect(page.locator("#dashboard-knowledge-panel tbody")).toContainText(assetTitle);

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
    await expect(page.locator("#dashboard-exam-panel tbody")).toContainText(examTitle);
    await expect(page.locator("#dashboard-gap-panel tbody")).toContainText("仪表产品");

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
    await page.locator("#aiEnabledInput").check();
    await page.locator("#aiSaveButton").click();
    await expect(page.locator(".toast").last()).toContainText("AI解析配置已保存");
    await page.locator("#websiteUseAiInput").check();
    await page.locator("#websiteUrlInput").fill(`https://${websiteCompany}.com`);
    await page.locator("#tools .section-head .btn", { hasText: "解析官网" }).click();
    await expect(page.locator(".toast").last()).toContainText("请先保存并启用 AI 配置");
    await page.locator("#websiteUseAiInput").uncheck();
    await page.locator("#tools .section-head .btn", { hasText: "解析官网" }).click();
    await expect(page.locator("#websiteOpportunityRows")).toContainText(websiteCompany);
    await expect(page.locator("#websiteOpportunityRows")).toContainText("规则解析");
    await page.locator("#websiteOpportunityRows tr").first().locator("[data-website-field='company']").fill(`官网商机-${runId}`);
    await page.locator("#websiteOpportunityRows tr").first().locator("[data-website-field='business']").fill("压力仪表 / 流量仪表");
    await page.locator("#tools .btn.primary", { hasText: "同步为商机" }).click();
    await expect(page.locator(".toast").last()).toContainText("已同步 1 条官网商机");
    await openView(page, "pipeline");
    await expect(page.locator("#pipeline .pipeline-strip")).toContainText(`官网商机-${runId} 官网产品机会`);
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

  test("memo page can create pin and archive notes", async ({ page }) => {
    const memoTitle = `自动化备忘-${runId}`;
    const switchMemoTitle = `切换目标备忘-${runId}`;
    await openView(page, "memos");
    await expect(page.locator("#memos .memo-grid")).toBeVisible();
    await expect(page.locator("#memos .memo-list .memo-card").first()).toBeVisible();

    await page.locator("#memos .page-head .btn.primary").click();
    await page.locator("#memoTitleInput").fill(memoTitle);
    await page.locator("#memoCategoryInput").selectOption("客户备忘");
    await page.locator("#memoTagsInput").fill("自动化,客户");
    await page.locator("#memoContentInput").fill("客户要求下次报价拆分认证资料和交期说明。");
    await page.locator("#saveMemoButton").click();

    await expect(page.locator("#memos .memo-list")).toContainText(memoTitle);
    await expect(page.locator("#memoTitleEditor")).toHaveValue(memoTitle);
    await page.locator("#memos .page-head .btn.primary").click();
    await page.locator("#memoTitleInput").fill(switchMemoTitle);
    await page.locator("#memoCategoryInput").selectOption("客户备忘");
    await page.locator("#memoContentInput").fill("用于验证切换时自动保存。");
    await page.locator("#saveMemoButton").click();
    await expect(page.locator("#memos .memo-list")).toContainText(switchMemoTitle);
    await page.locator("#memos .memo-card", { hasText: memoTitle }).first().click();
    await page.locator("#memoContentEditor").fill("自动保存验证：切换左侧备忘前保存当前正文。");
    await expect(page.locator("#memoSaveState")).toContainText("未保存");
    await page.locator("#memos .memo-card", { hasText: switchMemoTitle }).first().click();
    await expect(page.locator("#memoSaveState")).toContainText(/已自动保存|已保存/);
    await page.locator("#memos .memo-card", { hasText: memoTitle }).first().click();
    await expect(page.locator("#memoContentEditor")).toHaveValue("自动保存验证：切换左侧备忘前保存当前正文。");
    await page.locator("#memoPinButton").click();
    await expect(page.locator("#memos .memo-card", { hasText: memoTitle }).first()).toContainText("置顶");
    await page.locator("#memoArchiveButton").click();
    await expect(page.locator("#memos .memo-card", { hasText: memoTitle }).first()).toContainText("归档");
    await page.locator("#memoDeleteButton").click();
    await expect(page.locator(".toast").last()).toContainText("备忘已删除");
    await expect(page.locator("#memos .memo-card", { hasText: memoTitle })).toHaveCount(0);
  });

  test("executive report exports a presentation-ready file", async ({ page }) => {
    await openView(page, "reports");
    await expect(page.locator("#reports .report-deck")).toBeVisible();

    await page.locator("#reports .page-head .btn", { hasText: "汇报备注" }).click();
    await page.locator("#reportNoteInput").fill("自动化汇报备注：本周聚焦报价逾期客户");
    await page.locator("#saveReportNoteButton").click();
    await expect(page.locator("#reports .report-hero")).toContainText("自动化汇报备注");

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#reports .page-head .btn.primary").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("GoodJob-CRM");
    await expect(page.locator(".toast").last()).toContainText("汇报已生成下载");
  });
});
