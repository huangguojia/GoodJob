import { expect, test } from "@playwright/test";

async function login(
  page: import("@playwright/test").Page,
  email: string,
  expectedName: string
) {
  await page.goto("/");
  await page.locator("#loginEmail").fill(email);
  await page.locator("#loginPassword").fill("goodjob123");
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await expect(page.locator("#scopeUser")).toContainText(expectedName);
}

async function logout(page: import("@playwright/test").Page) {
  await page.locator("#logoutButton").click();
  await expect(page.locator("body")).not.toHaveClass(/is-authenticated/);
}

async function openView(page: import("@playwright/test").Page, view: string) {
  const button = page.locator(`.nav button[data-view="${view}"]`);
  if (!(await button.isVisible())) {
    const section = button.locator("xpath=ancestor::details[1]");
    if (await section.count()) {
      await section.evaluate((element) => {
        (element as HTMLDetailsElement).open = true;
      });
    }
  }
  await button.click();
  await expect(page.locator(`#${view}`)).toHaveClass(/active/);
}

test("daily report and internal message collaboration flow", async ({ page }) => {
  const marker = `${Date.now()}`;
  const completedWork = `日报端到端测试 ${marker}`;
  const updatedWork = `${completedWork} 已更新`;
  const directSubject = `协同确认 ${marker}`;
  const managerComment = `主管反馈 ${marker}`;
  const salespersonReply = `业务回复 ${marker}`;

  await login(page, "shirley@goodjob.com", "Shirley");
  await openView(page, "daily-reports");
  await page.locator("#newDailyReportButton").click();
  await page.locator("#dailyReportCompletedInput").fill(completedWork);
  await page.locator("#dailyReportCustomerInput").fill("客户已确认产品参数，等待正式报价。");
  await page.locator("#dailyReportResultsInput").fill("新增 2 个有效触点");
  await page.locator("#dailyReportNextPlanInput").fill("次日上午发送报价");
  await page.locator("#saveDailyReportButton").click();
  await expect(page.locator("#appModal")).not.toHaveClass(/active/);
  await expect(page.locator("#dailyReportDetail")).toContainText(completedWork);

  await page.locator("#editDailyReportButton").click();
  await page.locator("#dailyReportCompletedInput").fill(updatedWork);
  await page.locator("#saveDailyReportButton").click();
  await expect(page.locator("#dailyReportList .daily-report-row")).toHaveCount(1);
  await expect(page.locator("#dailyReportDetail")).toContainText(updatedWork);

  await openView(page, "inbox");
  await page.locator("#composeMessageButton").click();
  await page.locator("#internalMessageRecipientInput").selectOption("u_sales_mia");
  await page.locator("#internalMessageSubjectInput").fill(directSubject);
  await page.locator("#internalMessageContentInput").fill("请复核该客户认证要求。");
  await page.locator("#sendInternalMessageButton").click();
  await expect(page.locator("[data-inbox-box='sent']")).toHaveClass(/active/);
  await expect(page.locator("#inboxMessageList")).toContainText(directSubject);

  await logout(page);
  await login(page, "alex@goodjob.com", "Alex");
  await openView(page, "daily-reports");
  await expect(page.locator("#dailyReportDetail")).toContainText(updatedWork);
  await page.locator("#dailyReportCommentInput").fill(managerComment);
  await page.locator("#submitDailyReportCommentButton").click();
  await expect(page.locator("#dailyReportDetail")).toContainText(managerComment);

  await logout(page);
  await login(page, "shirley@goodjob.com", "Shirley");
  await expect(page.locator("#internalMessageNavBadge")).toHaveText(/[1-9]\d*/);
  await expect(page.locator("#internalMessageNavBadge")).not.toHaveAttribute("hidden", "");
  await openView(page, "inbox");
  const commentNotification = page.locator("#inboxMessageList .inbox-message-row", {
    hasText: "评论了你的日报"
  }).first();
  await expect(commentNotification).toBeVisible();
  await commentNotification.click();
  await expect(commentNotification).not.toHaveClass(/unread/);
  await page.locator("#openRelatedDailyReportButton").click();
  await expect(page.locator("#daily-reports")).toHaveClass(/active/);
  await expect(page.locator("#dailyReportDetail")).toContainText(managerComment);
  await page.locator("[data-reply-daily-comment]").first().click();
  await page.locator("#dailyReportReplyInput").fill(salespersonReply);
  await page.locator("#sendDailyReportReplyButton").click();
  await expect(page.locator("#dailyReportDetail")).toContainText(salespersonReply);

  await logout(page);
  await login(page, "alex@goodjob.com", "Alex");
  await openView(page, "inbox");
  const replyNotification = page.locator("#inboxMessageList .inbox-message-row", {
    hasText: "回复了你的日报评论"
  }).first();
  await expect(replyNotification).toBeVisible();
  await replyNotification.click();
  await expect(replyNotification).not.toHaveClass(/unread/);
});

test("collaboration pages fit a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "shirley@goodjob.com", "Shirley");

  for (const view of ["daily-reports", "inbox"]) {
    await openView(page, view);
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    expect(hasHorizontalOverflow).toBe(false);
    await expect(page.locator(`#${view} .collab-page-head .head-actions .btn`).first()).toBeVisible();
  }
});
