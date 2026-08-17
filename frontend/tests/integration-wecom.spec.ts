import { expect, test, type Page } from "@playwright/test";

const connector = {
  id: "connector_wecom",
  code: "wecom",
  name: "企业微信",
  version: "1.0.0",
  type: "official_api",
  trust: "official",
  status: "active",
  teamId: "team-a",
  createdBy: "system",
  manifestHash: "wecom-hash",
  description: "企业微信官方连接器",
  manifest: { stage: "available", authentication: "api_token", approvedHosts: [] }
};

const connection = {
  id: "connection_wecom",
  connectorId: connector.id,
  teamId: "team-a",
  ownerId: "u_admin",
  scope: "team",
  status: "active",
  displayName: "公司企业微信",
  lastHealthAt: "2026-08-08T08:00:00.000Z",
  lastHealthLatencyMs: 20,
  lastErrorMessage: "",
  serverInfoJson: "{}",
  updatedAt: "2026-08-08T08:00:00.000Z"
};

async function mockIntegrationState(page: Page) {
  await page.route("**/api/integrations/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let data: unknown[] = [];
    if (pathname.endsWith("/catalog")) data = [connector];
    if (pathname.endsWith("/connections")) data = [connection];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requestId: "e2e", data, uiAction: { type: "refresh" } }) });
  });
  await page.route("**/api/wecom-command/endpoints", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ endpoints: [{
      id: "endpoint_wecom", connectionId: connection.id, callbackPublicId: "wcb_e2e", teamId: "team-a", corpId: "ww_e2e_corp",
      status: "active", callbackPath: "/api/wecom/commands/wcb_e2e", callbackUrl: "https://crm.example.test/api/wecom/commands/wcb_e2e",
      createdAt: "2026-08-08T08:00:00.000Z", updatedAt: "2026-08-08T08:00:00.000Z"
    }] }) });
  });
  await page.route("**/api/wecom-command/bindings", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bindings: [{
      id: "binding_wecom", connectionId: connection.id, teamId: "team-a", wecomUserId: "zhangsan", crmUserId: "u_sales_shirley",
      crmUserName: "Shirley", status: "active", verifiedAt: "2026-08-08T08:00:00.000Z", createdAt: "2026-08-08T08:00:00.000Z", updatedAt: "2026-08-08T08:00:00.000Z"
    }] }) });
  });
  await page.route("**/api/accounts", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accounts: [
      { id: "u_sales_shirley", name: "Shirley", email: "shirley@goodjob.com", role: "sales", teamId: "team-a", avatar: "SH", status: "active" },
      { id: "u_sales_mia", name: "Mia", email: "mia@goodjob.com", role: "sales", teamId: "team-a", avatar: "MI", status: "active" }
    ] }) });
  });
}

async function login(page: Page, email: string, name: string) {
  await page.goto("/");
  await page.locator("#loginEmail").fill(email);
  await page.locator("#loginPassword").fill("goodjob123");
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/u);
  await expect(page.locator("#scopeUser")).toContainText(name);
}

async function openIntegrationCenter(page: Page) {
  await page.locator('.nav button[data-view="integration-center"]').click();
  await expect(page.locator("#integration-center")).toHaveClass(/active/u);
  await page.locator('[data-integration-tab="wecom-commands"]').click();
  await expect(page.locator('[data-integration-panel="wecom-commands"]')).toBeVisible();
}

test("管理员可以配置企业微信指令，凭证不回显", async ({ page }) => {
  await mockIntegrationState(page);
  await login(page, "admin@goodjob.com", "Admin");
  await openIntegrationCenter(page);
  await expect(page.locator('[data-integration-panel="wecom-commands"]')).toContainText("回调地址");
  await expect(page.locator('[data-integration-panel="wecom-commands"]')).toContainText("复制地址");
  await page.locator('[data-integration-panel="wecom-commands"] [data-wecom-configure]').first().click();
  await expect(page.locator("#integrationWecomToken")).toHaveAttribute("type", "password");
  await expect(page.locator("#integrationWecomAesKey")).toHaveAttribute("type", "password");
  await expect(page.locator("#integrationWecomToken")).toHaveValue("");
  await expect(page.locator("#integrationWecomAesKey")).toHaveValue("");
  await page.locator("[data-modal-close]").last().click();
});

test("业务员只能看到自己的企业微信绑定状态", async ({ page }) => {
  await mockIntegrationState(page);
  await login(page, "shirley@goodjob.com", "Shirley");
  await openIntegrationCenter(page);
  const panel = page.locator('[data-integration-panel="wecom-commands"]');
  await expect(panel).toContainText("当前账号已绑定企业微信");
  await expect(panel.locator("[data-wecom-configure], [data-wecom-bind], [data-wecom-revoke], [data-wecom-disable]")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).resolves.toBeTruthy();
});
