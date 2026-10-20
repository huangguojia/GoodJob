import { expect, test, type Page } from "@playwright/test";

async function loginAsManager(page: Page) {
  await page.goto("/");
  await page.locator("#loginEmail").fill("alex@goodjob.com");
  await page.locator("#loginPassword").fill("goodjob123");
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/u);
}

async function openView(page: Page, view: string) {
  // 「客户管理」下有「未成交客户 / 已成交客户」两个同 data-view 的入口，取第一个（未成交）
  await page.locator(`.nav button[data-view="${view}"]`).first().click();
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
    // 客户没有 WhatsApp 号码时，列表入口本身就是 disabled + 说明性 title（诚实的提示就是"点不动 + 说明原因"），
    // 而不是点了再弹 toast —— 这里按当前行为断言（2026-10-14 同步）。
    const customerWhatsApp = page.locator("#customers tbody tr", { hasText: customerCompany }).locator("[data-customer-whatsapp]");
    await expect(customerWhatsApp).toBeDisabled();
    await expect(customerWhatsApp).toHaveAttribute("title", /未维护 WhatsApp 号码/u);

    await page.setViewportSize({ width: 390, height: 844 });
    await openView(page, "leads");
    await page.locator("#leadMobileList .lead-mobile-card", { hasText: leadCompany }).locator(".lead-name").click();
    await expect(page.locator("#leadDrawer")).toBeVisible();
    expect(await page.locator("#leadDrawer").evaluate((drawer) => drawer.getBoundingClientRect().top)).toBeGreaterThanOrEqual(54);
    // 线索侧同理：没有号码时入口是 disabled + 说明性 title，点不动也就不会误发
    await expect(page.locator("#leadWhatsAppButton")).toBeDisabled();
    await expect(page.locator("#leadWhatsAppButton")).toHaveAttribute("title", /未维护电话 \/ WhatsApp 号码/u);
  });

  test("opens the customer WhatsApp conversation in a new tab", async ({ page, context }) => {
    const company = `WhatsApp Existing ${Date.now()}`;
    await apiFromPage(page, "/api/customers", "POST", {
      company,
      country: "China",
      contact: "Kevin +8618163201984",
      // 列表里的 WhatsApp 入口只认 whatsapp 字段（不再从 contact 文本里猜号码），
      // 缺了它按钮就是 disabled，点不动 —— 2026-10-14 同步。
      whatsapp: "+8618163201984",
      stage: "询盘",
      amount: 0,
      health: 72,
      grade: "B"
    });
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/is-authenticated/u);
    await openView(page, "customers");
    // 现行行为：入口在新标签打开网页版会话（刻意不用 wa.me —— 会唤起桌面客户端、落到别的关联设备），
    // 不再把会话内嵌进 CRM。这里只验跳转地址，目标站点用桩顶掉，保持用例不依赖外网（2026-10-14 同步）。
    await context.route("https://web.whatsapp.com/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>wa-stub</body></html>"
    }));
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      page.locator("#customers tbody tr", { hasText: company }).locator("[data-customer-whatsapp]").click()
    ]);
    await expect.poll(() => popup.url()).toContain("web.whatsapp.com/send");
    expect(popup.url()).toContain("8618163201984");
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

  test("点击列表行在筛选条右端出现快捷联系方式（只留图标 + 文字，无按钮外框）", async ({ page }) => {
    const suffix = `${Date.now()}`;
    const customerCompany = `Dock Customer ${suffix}`;
    const leadCompany = `Dock Lead ${suffix}`;
    const poolCompany = `Dock Pool ${suffix}`;
    await apiFromPage(page, "/api/customers", "POST", {
      company: customerCompany,
      country: "Germany",
      contact: "Dock Buyer",
      email: `dock.${suffix}@example.com`,
      phone: "+49 151 2345 678",
      whatsapp: "+491512345678",
      wechat: `dock-${suffix}`,
      stage: "询盘",
      amount: 0,
      health: 70,
      grade: "C"
    });
    await apiFromPage(page, "/api/leads", "POST", {
      company: leadCompany,
      contact: "Dock Lead Buyer",
      country: "Germany",
      email: `lead.${suffix}@example.com`,
      phone: "+491511111111",
      source: "手动录入",
      intent: "中",
      estimatedAmount: 0
    });
    await apiFromPage(page, "/api/customers", "POST", {
      company: poolCompany,
      country: "Canada",
      contact: "Pool Dock Buyer",
      email: `pool.${suffix}@example.com`,
      stage: "询盘",
      amount: 0,
      health: 66,
      grade: "C"
    });
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/is-authenticated/u);

    /* --- 客户列表：点行 → 联系方式落到批量操作条右端，抽屉不打开 --- */
    await openView(page, "customers");
    const customerDock = page.locator("#customers .contact-dock");
    await expect(customerDock).toHaveCount(0);
    const customerRow = page.locator("#customers tbody tr", { hasText: customerCompany });
    await customerRow.locator("td").nth(3).click();
    await expect(customerDock).toBeVisible();
    // 只放联系方式，不再把公司名 / 负责人搬进联系条（2026-10-14 用户要求）
    await expect(customerDock).not.toContainText(customerCompany);
    await expect(customerDock).toContainText("邮箱");
    await expect(customerDock.locator('[data-contact-dock-channel="email"]')).toHaveClass(/is-ready/u);
    await expect(customerDock.locator('[data-contact-dock-channel="whatsapp"]')).toHaveClass(/is-ready/u);
    // 去按钮化：没有边框、没有底色（它要看起来是一条状态，不是一组按钮）
    const dockSkin = await customerDock.locator('[data-contact-dock-channel="email"]').evaluate((node) => {
      const style = getComputedStyle(node);
      return { border: style.borderTopWidth, background: style.backgroundColor };
    });
    expect(dockSkin.border).toBe("0px");
    expect(["rgba(0, 0, 0, 0)", "transparent"]).toContain(dockSkin.background);
    await expect(page.locator("#customerDrawer")).not.toHaveClass(/open/u);
    // 落在批量工具条内部、并且贴住它的右端
    expect(await customerDock.evaluate((node) => node.parentElement?.id)).toBe("customerBulkToolbar");
    const customerDockBox = await customerDock.boundingBox();
    const customerToolbarBox = await page.locator("#customerBulkToolbar").boundingBox();
    expect(Math.abs((customerDockBox?.x || 0) + (customerDockBox?.width || 0) - ((customerToolbarBox?.x || 0) + (customerToolbarBox?.width || 0)))).toBeLessThanOrEqual(2);
    const customerTableBox = await page.locator("#customers .customer-desktop-table").boundingBox();
    expect((customerDockBox?.y || 0) + (customerDockBox?.height || 0)).toBeLessThanOrEqual((customerTableBox?.y || 0) + 1);
    // 列表重渲染（勾选 / 筛选）不能把联系条冲掉
    await customerRow.locator("[data-select-customer]").check();
    await expect(customerDock).toBeVisible();

    /* 行内的按钮不受行点击影响：点客户名仍是进详情，联系条保持不动 */
    await customerRow.locator(".customer-name").click();
    await expect(page.locator("#customerDrawer")).toHaveClass(/open/u);
    await expect(customerDock).toBeVisible();
    await page.locator("#customerDrawerClose").click();

    /* --- 「不点客户就不显示」：离开这一页、或换个标签页，联系条都必须收起 ---
       它代表的只是「你刚刚点过的那一行」，换个上下文就等于没点过（用户口径 2026-10-14）。 */
    await openView(page, "dashboard");
    await openView(page, "customers");
    await expect(customerDock).not.toBeVisible();

    await customerRow.locator("td").nth(3).click();
    await expect(customerDock).toBeVisible();
    // 切到「已成交客户」：刚点的那一行不在这个列表里 → 收起
    await page.locator('.nav button[data-view="customers"][data-customer-outcome="won"]').first().click();
    await expect(page.locator("#customers")).toHaveClass(/active/u);
    await expect(customerDock).not.toBeVisible();
    // 切回「未成交客户」也不算点过 —— 不许自己冒出来
    await openView(page, "customers");
    await expect(customerDock).not.toBeVisible();

    /* --- 线索列表 --- */
    await openView(page, "leads");
    const leadDock = page.locator("#leads .contact-dock");
    const leadRow = page.locator("#leadsTableBody tr", { hasText: leadCompany });
    await leadRow.locator("td").nth(2).click();
    await expect(leadDock).toBeVisible();
    await expect(leadDock).not.toContainText(leadCompany);
    await expect(leadDock.locator('[data-contact-dock-channel="email"]')).toHaveClass(/is-ready/u);
    await expect(page.locator("#leadDrawer")).not.toHaveClass(/open/u);
    expect(await leadDock.evaluate((node) => node.parentElement?.className || "")).toContain("lead-filter-row");
    const leadDockBox = await leadDock.boundingBox();
    const leadTableBox = await page.locator("#leads .lead-desktop-table").boundingBox();
    expect((leadDockBox?.y || 0) + (leadDockBox?.height || 0)).toBeLessThanOrEqual((leadTableBox?.y || 0) + 1);
    // 搜索把这一行筛掉了 → 联系条跟着收起；再清空搜索也不会自己回来（要重新点）
    await page.locator("#leadSearchInput").fill(`no-such-lead-${suffix}`);
    await expect(leadDock).not.toBeVisible();
    await page.locator("#leadSearchInput").fill("");
    await expect(leadDock).not.toBeVisible();

    /* --- 客户公池：先把客户放进去，再点行 --- */
    await openView(page, "customers");
    await page.locator("#customers tbody tr", { hasText: poolCompany }).locator("[data-release-customer]").click();
    await page.locator("#customerReleaseReason").fill("联系条验证用");
    await page.locator("#confirmCustomerReleaseButton").click();
    await expect(page.locator(".toast").last()).toContainText("客户已放入团队公池");
    await openView(page, "customer-pool");
    const poolDock = page.locator("#customer-pool .contact-dock");
    const poolRow = page.locator("#customerPoolTableBody tr", { hasText: poolCompany });
    await poolRow.locator("td").nth(1).click();
    await expect(poolDock).toBeVisible();
    await expect(poolDock).not.toContainText(poolCompany);
    await expect(poolDock.locator('[data-contact-dock-channel="email"]')).toHaveClass(/is-ready/u);
    expect(await poolDock.evaluate((node) => node.parentElement?.className || "")).toContain("customer-pool-toolbar");
  });
});
