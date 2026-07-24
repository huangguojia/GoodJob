import { expect, test, type Page } from "@playwright/test";

async function loginAsManager(page: Page) {
  await page.goto("/");
  await page.locator("#loginEmail").fill("alex@goodjob.com");
  await page.locator("#loginPassword").fill("goodjob123");
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/u);
}

async function openView(page: Page, view: string) {
  await page.locator(`.nav button[data-view="${view}"]`).click();
  await expect(page.locator(`#${view}`)).toHaveClass(/active/u);
}

async function apiFromPage<T>(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(async ({ requestPath, requestMethod, requestBody }) => {
    const csrfToken = document.cookie
      .split("; ")
      .find((part) => part.startsWith("gj_csrf="))
      ?.split("=")
      .slice(1)
      .join("=");
    const response = await fetch(requestPath, {
      method: requestMethod,
      headers: {
        "content-type": "application/json",
        ...(!["GET", "HEAD", "OPTIONS"].includes(requestMethod) && csrfToken
          ? { "x-csrf-token": decodeURIComponent(csrfToken) }
          : {})
      },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `Request failed: ${response.status}`);
    return result;
  }, { requestPath: path, requestMethod: method, requestBody: body }) as Promise<T>;
}

test.describe("customer WhatsApp and public pool", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsManager(page);
  });

  test("shows a truthful prompt when a customer or lead has no WhatsApp number", async ({ page }) => {
    const suffix = `${Date.now()}`;
    const customerCompany = `No WhatsApp Customer ${suffix}`;
    const leadCompany = `No WhatsApp Lead ${suffix}`;
    await apiFromPage(page, "/api/customers", "POST", {
      company: customerCompany,
      country: "Germany",
      contact: "Buyer Without Number",
      stage: "询盘",
      amount: 0,
      health: 70,
      grade: "C"
    });
    await apiFromPage(page, "/api/leads", "POST", {
      company: leadCompany,
      contact: "Lead Without Number",
      country: "Germany",
      email: "",
      phone: "",
      source: "手动录入",
      intent: "中",
      estimatedAmount: 0
    });
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/is-authenticated/u);

    await openView(page, "customers");
    const customerRow = page.locator("#customers tbody tr", { hasText: customerCompany });
    await customerRow.locator("[data-customer-whatsapp]").click();
    await expect(page.locator(".toast").last()).toContainText("该客户没有 WhatsApp 号码");

    await page.setViewportSize({ width: 390, height: 844 });
    await openView(page, "leads");
    await page.locator("#leadMobileList .lead-mobile-card", { hasText: leadCompany }).locator(".lead-name").click();
    await expect(page.locator("#leadDrawer")).toBeVisible();
    expect(await page.locator("#leadDrawer").evaluate((drawer) => drawer.getBoundingClientRect().top)).toBeGreaterThanOrEqual(54);
    await page.locator("#leadWhatsAppButton").click();
    await expect(page.locator(".toast").last()).toContainText("该客户没有 WhatsApp 号码");
  });

  test("opens an existing plugin conversation from a customer", async ({ page }) => {
    const company = `WhatsApp Existing ${Date.now()}`;
    await apiFromPage(page, "/api/customers", "POST", {
      company,
      country: "China",
      contact: "Kevin +8618163201984",
      stage: "询盘",
      amount: 0,
      health: 72,
      grade: "B"
    });
    await page.route("**/whatsapp-plugin/api/v1/accounts", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "wa-account-1", name: "Sales", status: "connected" }])
    }));
    await page.route("**/whatsapp-plugin/api/v1/conversations", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "wa-conversation-1", accountId: "wa-account-1", contactPhone: "+8618163201984" }])
    }));
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/is-authenticated/u);
    await openView(page, "customers");
    await page.locator("#customers tbody tr", { hasText: company }).locator("[data-customer-whatsapp]").click();
    await expect(page.locator("#whatsapp")).toHaveClass(/active/u);
    await expect(page.locator("#whatsapp .whatsapp-plugin-frame")).toHaveAttribute("src", /accountId=wa-account-1/u);
    await expect(page.locator("#whatsapp .whatsapp-plugin-frame")).toHaveAttribute("src", /conversationId=wa-conversation-1/u);
  });

  test("releases a customer to the public pool and claims it back", async ({ page }) => {
    const company = `Public Pool Customer ${Date.now()}`;
    const reason = "近期暂无精力跟进，交由团队继续推进";
    await apiFromPage(page, "/api/customers", "POST", {
      company,
      country: "Canada",
      contact: "Pool Buyer",
      stage: "询盘",
      amount: 0,
      health: 66,
      grade: "C"
    });
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/is-authenticated/u);
    await openView(page, "customers");
    const customerRow = page.locator("#customers tbody tr", { hasText: company });
    await customerRow.locator("[data-release-customer]").click();
    await page.locator("#customerReleaseReason").fill(reason);
    await page.locator("#confirmCustomerReleaseButton").click();
    await expect(page.locator(".toast").last()).toContainText("客户已放入团队公池");
    await expect(customerRow).toHaveCount(0);

    await openView(page, "customer-pool");
    const poolRow = page.locator("#customerPoolTableBody tr", { hasText: company });
    await expect(poolRow).toContainText(reason);
    await expect(poolRow).toContainText("Alex");
    await poolRow.locator("[data-pool-claim]").click();
    await expect(page.locator(".toast").last()).toContainText("客户已领取到我的客户");
    await expect(poolRow).toHaveCount(0);

    await openView(page, "customers");
    await expect(page.locator("#customers tbody tr", { hasText: company })).toHaveCount(1);
  });

  test("public pool remains usable without horizontal overflow on mobile", async ({ page }) => {
    await openView(page, "customer-pool");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#customerPoolMobileList")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  });

  test("profile no longer exposes the legacy WhatsApp channel", async ({ page }) => {
    await page.locator("#profileEntryButton").click();
    await expect(page.locator("#profile")).toHaveClass(/active/u);
    await expect(page.locator("#profileOpenWhatsAppButton")).toHaveCount(0);
    await expect(page.locator("#profile")).not.toContainText("沟通渠道");
  });
});
