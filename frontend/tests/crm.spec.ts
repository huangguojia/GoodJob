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
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
    });
    await loginAsManager(page);
  });

  test("dashboard todo workflow is interactive", async ({ page }) => {
    await expect(page.locator("#dashboard .todo-list .todo-row").first()).toBeVisible();

    await page.getByRole("button", { name: "新增待办" }).click();
    await expect(page.locator("#appModal")).toHaveClass(/active/);
    await page.locator("#todoTitleInput").fill("自动化测试：跟进天津马赫报价");
    await page.locator("#todoTypeInput").selectOption("customer");
    await page.locator("#saveTodoButton").click();

    await expect(page.locator("#dashboard .todo-list")).toContainText("自动化测试：跟进天津马赫报价");
    await expect(page.locator(".toast").last()).toContainText("待办已新增");

    await page.locator("#dashboard .todo-row", { hasText: "自动化测试：跟进天津马赫报价" }).locator(".todo-check").click();
    await expect(page.locator("#dashboard .todo-row.done", { hasText: "自动化测试：跟进天津马赫报价" })).toBeVisible();
  });

  test("customer page can create and inspect a customer", async ({ page }) => {
    await openView(page, "customers");

    await page.locator("#customers .page-head .btn.primary").click();
    await page.locator("#customerCompanyInput").fill("天津马赫自动化测试");
    await page.locator("#customerContactInput").fill("Ma He");
    await page.locator("#customerAmountInput").fill("36000");
    await page.locator("#saveCustomerButton").click();

    await expect(page.locator("#customers tbody")).toContainText("天津马赫自动化测试");
    await expect(page.locator("#customers .drawer")).toContainText("天津马赫自动化测试");
    await expect(page.locator(".toast").last()).toContainText("客户已新增");
  });

  test("knowledge and exam pages keep their dense content and key actions", async ({ page }) => {
    await openView(page, "knowledge");
    await expect(page.locator("#knowledge .knowledge-grid")).toBeVisible();
    await expect(page.locator("#knowledge .file-grid .file-card").first()).toBeVisible();

    await page.locator("#knowledge .page-head .btn.primary").click();
    await page.locator("#assetTitleInput").fill("自动化测试资料");
    await page.locator("#saveAssetButton").click();
    await expect(page.locator("#knowledge .file-grid")).toContainText("自动化测试资料");

    await openView(page, "exam");
    await expect(page.locator("#exam .exam-grid")).toBeVisible();
    await page.locator("#exam .page-head .btn.primary").click();
    await page.locator("#examTitleInput").fill("自动化测试考试");
    await page.locator("#saveExamButton").click();
    await expect(page.locator("#exam .exam-sidebar .category-list")).toContainText("自动化测试考试");

    await page.locator("#exam .category-item", { hasText: "自动化测试考试" }).getByRole("button", { name: "考试" }).click();
    await page.locator("#appModal [data-question]").nth(0).locator("[data-correct='true']").click();
    await page.locator("#appModal [data-question]").nth(1).locator("[data-correct='true']").click();
    await page.locator("#appModal [data-question]").nth(2).locator("[data-correct='true']").click();
    await page.locator("#submitExamButton").click();
    await expect(page.locator(".toast").last()).toContainText("交卷成功");
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

  test("executive report exports a presentation-ready file", async ({ page }) => {
    await openView(page, "reports");
    await expect(page.locator("#reports .report-deck")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#reports .page-head .btn.primary").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("GoodJob-CRM");
    await expect(page.locator(".toast").last()).toContainText("汇报已生成下载");
  });
});
