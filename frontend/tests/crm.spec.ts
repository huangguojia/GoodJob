import { expect, test } from "@playwright/test";

async function loginAsManager(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("#loginRole").selectOption("manager");
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await expect(page.locator("#scopeUser")).toContainText("Alex");
}

async function openView(page: import("@playwright/test").Page, view: string) {
  await page.locator(`.nav button[data-view="${view}"]`).click();
  await expect(page.locator(`#${view}`)).toHaveClass(/active/);
}

test.describe("GoodJob CRM prototype pages", () => {
  let runId: string;

  test.beforeEach(async ({ page }) => {
    runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await page.addInitScript(() => {
      localStorage.clear();
    });
    await loginAsManager(page);
  });

  test("dashboard todo workflow is interactive", async ({ page }) => {
    const title = `自动化待办-${runId}`;
    await expect(page.locator("#dashboard .todo-list .todo-row").first()).toBeVisible();
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
    await page.locator("#batchPriorityButton").click();
    await expect(page.locator(".toast").last()).toContainText(/已生成|无需重复生成/);
    const todoKpi = page.locator("#dashboard .kpi").filter({ hasText: "今日待跟进" }).locator("strong");
    const beforeTodoCount = Number(await todoKpi.textContent());

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
    await expect(todoKpi).toHaveText(String(beforeTodoCount + 1));
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
    await todoRow.dblclick();
    await expect(page.locator("#appModal")).toHaveClass(/active/);
    await expect(page.locator("#modalTitle")).toContainText("编辑待办");
    await page.locator("#todoDueInput").fill("2026-06-29 18:30");
    await page.locator("#todoRelatedInput").fill("双击编辑验证");
    await page.locator("#saveTodoButton").click();
    await expect(page.locator(".toast").last()).toContainText("待办已更新");
    await expect(page.locator("#dashboard .todo-row", { hasText: title }).first()).toContainText("2026-06-29 18:30");
    await expect(page.locator("#dashboard .todo-row", { hasText: title }).first()).not.toContainText(/t_\\d{10,}/);
    await page.locator("#dashboard .todo-row", { hasText: title }).first().locator(".todo-more").click();
    await page.locator("#dashboard .todo-row", { hasText: title }).first().locator("[data-todo-action='delete']").click();
    await expect(page.locator(".toast").last()).toContainText("待办已删除");
    await expect(page.locator("#dashboard .todo-row", { hasText: title })).toHaveCount(0);
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

    const pinnedRow = page.locator("#dashboard .todo-row", { hasText: pinned }).first();
    await expect(pinnedRow.locator(".todo-more span")).toHaveCount(3);
    await pinnedRow.locator(".todo-more").click();
    await expect(pinnedRow.locator(".todo-menu")).toBeVisible();
    await page.locator("#dashboard .todo-toolbar").click();
    await expect(pinnedRow.locator(".todo-menu")).toHaveCount(0);
    await pinnedRow.locator(".todo-more").click();
    await pinnedRow.locator("[data-todo-action='top']").click();
    await expect(page.locator("#dashboard .todo-list .todo-row").first()).toContainText(pinned);
    await expect(pinnedRow).toContainText("置顶");

    const anchorRow = page.locator("#dashboard .todo-row", { hasText: anchor }).first();
    const fromBox = await pinnedRow.boundingBox();
    const toBox = await anchorRow.boundingBox();
    if (!fromBox || !toBox) throw new Error("todo drag boxes missing");
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(360);
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator(".toast").last()).toContainText("已按拖拽顺序保存");
    await expect(page.locator("#dashboard .todo-row", { hasText: pinned }).first()).not.toContainText("置顶");
    await expect(page.locator("#dashboard .todo-row", { hasText: pinned }).first()).not.toContainText("沉底");

    for (const title of [pinned, anchor]) {
      const row = page.locator("#dashboard .todo-row", { hasText: title }).first();
      await row.locator(".todo-more").click();
      await row.locator("[data-todo-action='delete']").click();
      await expect(page.locator("#dashboard .todo-row", { hasText: title })).toHaveCount(0);
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
    await expect(page.locator("#dashboard .todo-history-list")).toContainText(title);
    await expect(page.locator("#dashboard .todo-history-row", { hasText: title })).toContainText("历史归档");
    await expect(page.locator("#dashboard .todo-history-row", { hasText: title })).not.toContainText("资料/考试");
    await expect(page.locator("#dashboard .todo-chip").last()).toContainText("历史清单");
    await expect(page.locator("#dashboard .todo-chip").last()).not.toContainText("资料/考试");
    await page.locator("#dashboard .todo-chip").last().click();
    await expect(page.locator("#dashboard .todo-list .todo-row", { hasText: title })).toContainText("历史归档");
    await expect(page.locator("#todo-history-count")).toHaveText(/[1-9]\d* 条/);
  });

  test("customer page can create and inspect a customer", async ({ page }) => {
    const company = `天津马赫自动化-${runId}`;
    await openView(page, "customers");

    await page.locator("#customers .page-head .btn.primary").click();
    await page.locator("#customerCompanyInput").fill(company);
    await page.locator("#customerContactInput").fill("Ma He");
    await page.locator("#customerAmountInput").fill("36000");
    await page.locator("#saveCustomerButton").click();

    await expect(page.locator("#customers tbody")).toContainText(company);
    await expect(page.locator("#customers .drawer")).toContainText(company);
    await expect(page.locator(".toast").last()).toContainText("客户已新增");

    await page.locator("#customers .drawer [data-add-follow]").click();
    await expect(page.locator("#customers .drawer .timeline")).toContainText("手动跟进");
  });

  test("pipeline can create and move a deal", async ({ page }) => {
    const dealTitle = `自动化商机-${runId}`;
    await openView(page, "pipeline");

    await page.locator("#pipeline .page-head .btn.primary").click();
    await page.locator("#dealTitleInput").fill(dealTitle);
    await page.locator("#dealAmountInput").fill("28000");
    await page.locator("#saveDealButton").click();

    await expect(page.locator("#pipeline .pipeline-strip")).toContainText(dealTitle);
    await page.locator("#pipeline .deal", { hasText: dealTitle }).first().getByRole("button", { name: "推进阶段" }).click();
    await expect(page.locator(".toast").last()).toContainText("商机已推进到");
  });

  test("reminders and import export modules perform real actions", async ({ page }) => {
    const reminderTitle = `自动化提醒-${runId}`;
    await openView(page, "reminders");
    await page.locator("#reminders .page-head .btn.primary").click();
    await page.locator("#reminderTitleInput").fill(reminderTitle);
    await page.locator("#saveReminderButton").click();
    await expect(page.locator("#reminders .task-list")).toContainText(reminderTitle);

    await page.locator("#reminders .task", { hasText: reminderTitle }).first().getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.locator(".toast").last()).toContainText("提醒已完成");

    await openView(page, "imports");
    await page.locator("#imports .page-head .btn.primary").click();
    await expect(page.locator("#imports tbody")).toContainText("手工导入客户");
  });

  test("knowledge and exam pages keep their dense content and key actions", async ({ page }) => {
    const assetTitle = `自动化资料-${runId}`;
    const examTitle = `自动化考试-${runId}`;
    await openView(page, "knowledge");
    await expect(page.locator("#knowledge .knowledge-grid")).toBeVisible();
    await expect(page.locator("#knowledge .file-grid .file-card").first()).toBeVisible();

    await page.locator("#knowledge .page-head .btn.primary").click();
    await page.locator("#assetTitleInput").fill(assetTitle);
    await page.locator("#saveAssetButton").click();
    await expect(page.locator("#knowledge .file-grid")).toContainText(assetTitle);

    await openView(page, "exam");
    await expect(page.locator("#exam .exam-grid")).toBeVisible();
    await page.locator("#exam .page-head .btn.primary").click();
    await page.locator("#examTitleInput").fill(examTitle);
    await page.locator("#saveExamButton").click();
    await expect(page.locator("#exam .exam-sidebar .category-list")).toContainText(examTitle);

    await page.locator("#exam .category-item", { hasText: examTitle }).first().getByRole("button", { name: "考试" }).click();
    await page.locator("#appModal [data-question]").nth(0).locator("[data-correct='true']").click();
    await page.locator("#appModal [data-question]").nth(1).locator("[data-correct='true']").click();
    await page.locator("#appModal [data-question]").nth(2).locator("[data-correct='true']").click();
    await page.locator("#submitExamButton").click();
    await expect(page.locator(".toast").last()).toContainText("交卷成功");
  });

  test("wecom sync and account management are operational", async ({ page }) => {
    const accountName = `Auto Account ${runId}`;
    await openView(page, "wecom");
    await expect(page.locator("#wecom .chat")).toBeVisible();
    await page.locator("#wecom .page-head .btn.primary").click();
    await expect(page.locator("#wecom .chat")).toContainText("已归档");

    await openView(page, "settings");
    await page.locator("#settings .page-head .btn", { hasText: "新增账号" }).click();
    await page.locator("#accountNameInput").fill(accountName);
    await page.locator("#accountEmailInput").fill(`auto.account.${runId}@goodjob.com`);
    await page.locator("#saveAccountButton").click();
    await expect(page.locator("#settings tbody")).toContainText(accountName);

    await page.locator("#settings tbody tr", { hasText: accountName }).first().getByRole("button", { name: "停用" }).click();
    await expect(page.locator("#settings tbody tr", { hasText: accountName }).first()).toContainText("停用");
  });

  test("tools OCR recognizes a card and syncs selected fields", async ({ page }) => {
    await openView(page, "tools");
    await expect(page.locator("#tools .tools-grid")).toBeVisible();

    await page.locator("#tools .section-head .btn", { hasText: "加载名片" }).click();
    await expect(page.locator("#tools .business-card")).toContainText("Tianjin Mahe Trading Co., Ltd.");
    await page.locator("#tools .field-card", { hasText: "公司名" }).locator("input[type='text']").fill("天津马赫");
    await page.locator("#tools .btn.primary", { hasText: /同步|确认同步/ }).first().click();

    await expect(page.locator("#tools .sync-row").nth(2)).toContainText("已同步");
    await expect(page.locator(".toast").last()).toContainText("OCR 线索已同步");
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
    await page.locator("#problemCustomerInput").fill("天津马赫");
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
    await page.locator("#memoContentEditor").fill("自动保存验证：切换左侧备忘前保存当前正文。");
    await expect(page.locator("#memoSaveState")).toContainText("未保存");
    await page.locator("#memos .memo-card", { hasText: "欧洲客户常问认证资料" }).first().click();
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
