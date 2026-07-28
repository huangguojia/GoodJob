import { expect, test } from "@playwright/test";

async function loginAsSales(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("#loginEmail").fill("shirley@goodjob.com");
  await page.locator("#loginPassword").fill("goodjob123");
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
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
      body: requestInit.body === undefined
        ? undefined
        : JSON.stringify(requestInit.body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `Request failed: ${response.status}`);
    return result;
  }, { requestPath: path, requestInit: init }) as Promise<T>;
}

async function openProspectList(page: import("@playwright/test").Page) {
  const button = page.locator('.nav button[data-view="prospect-list"]');
  if (!(await button.isVisible())) {
    await button.locator("xpath=ancestor::details[1]").locator("summary").click();
  }
  await button.click();
  await expect(page.locator("#prospect-list")).toHaveClass(/active/);
}

test("identity bootstrap streams progress and ends with details folded", async ({ page }) => {
  test.setTimeout(45_000);
  await loginAsSales(page);
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const preview = await apiFromPage<{ opportunities: Array<Record<string, unknown>> }>(
    page,
    "/api/tools/website-scrape/preview",
    {
      method: "POST",
      body: {
        urls: [`https://identity-ui-${suffix}.example.test`],
        useAi: false
      }
    }
  );
  const candidate = preview.opportunities[0]!;
  const candidateId = String(candidate.id);
  const company = `Identity Bootstrap UI ${suffix}`;
  Object.assign(candidate, {
    company,
    business: "Industrial identity test",
    country: "Global",
    ownerId: "u_sales_shirley",
    teamId: "europe",
    identityBootstrapAttempts: []
  });
  await apiFromPage(page, `/api/prospect-list/${encodeURIComponent(candidateId)}/details`, {
    method: "PATCH",
    body: {
      company,
      business: candidate.business,
      country: candidate.country,
      website: candidate.website,
      contact: candidate.contact,
      contactInfo: candidate.contactInfo,
      description: "Identity bootstrap UI regression",
      requestId: `identity-ui-details-${suffix}`
    }
  });

  const now = new Date().toISOString();
  const lei = "529900T8BM49AURSDO55";
  const attemptId = `pib_ui_${suffix}`;
  const baseAttempt = {
    id: attemptId,
    version: "prospect-identity-bootstrap-v1",
    requestIdHash: "a".repeat(64),
    providerId: "gleif",
    registrationNumber: lei,
    normalizedIdentifier: lei,
    taskStatus: "running",
    outcome: "pending",
    campaignId: `campaign_ui_${suffix}`,
    campaignVersion: 1,
    strategyId: `strategy_ui_${suffix}`,
    runId: `run_ui_${suffix}`,
    sourceCandidateId: "",
    sourceRawRecordId: "",
    sourceHitId: "",
    resolutionId: "",
    conflictId: "",
    organizationId: "",
    tenantProspectId: "",
    errorCode: "",
    errorMessage: "",
    events: [{
      id: `${attemptId}:event:1`,
      sequence: 1,
      stage: "validation",
      status: "completed",
      label: "权威注册号已校验",
      detail: `GLEIF LEI · ${lei}`,
      createdAt: now
    }, {
      id: `${attemptId}:event:2`,
      sequence: 2,
      stage: "campaign",
      status: "completed",
      label: "正式搜索上下文已建立",
      detail: `Campaign campaign_ui_${suffix} / Run run_ui_${suffix}`,
      createdAt: now
    }],
    createdBy: "u_sales_shirley",
    createdAt: now,
    updatedAt: now,
    endedAt: ""
  };
  const providers = [{
    id: "gleif",
    name: "GLEIF LEI",
    jurisdiction: "GLOBAL",
    market: "Global",
    identifierLabel: "LEI",
    example: "20 位 LEI",
    profileCode: "gleif-company-identity",
    scheme: "iso-17442",
    requiresKey: false,
    credentialKind: "none",
    setupNote: "免费官方接口，无需注册或配置凭据。",
    catalogStatus: "active",
    docsUrl: "https://www.gleif.org/en/lei-data/gleif-api",
    runtime: {
      id: "gleif",
      name: "GLEIF 法人库",
      requiresKey: false,
      hasApiKey: false,
      ready: true,
      enabled: true,
      accessMode: "api"
    }
  }];
  let reconcileCount = 0;
  await page.route(
    `**/api/prospect-list/${candidateId}/identity-bootstrap**`,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            candidateId,
            formallyResolved: false,
            providers,
            attempts: []
          })
        });
        return;
      }
      if (path.endsWith("/reconcile")) {
        reconcileCount += 1;
        const ended = reconcileCount >= 2;
        const attempt = {
          ...baseAttempt,
          taskStatus: ended ? "ended" : "running",
          outcome: ended ? "not_found" : "pending",
          errorCode: ended ? "AUTHORITY_IDENTIFIER_NOT_FOUND" : "",
          errorMessage: ended ? "权威来源未找到与该注册号完全一致的企业" : "",
          endedAt: ended ? new Date().toISOString() : "",
          events: [...baseAttempt.events, {
            id: `${attemptId}:event:3`,
            sequence: 3,
            stage: "provider",
            status: ended ? "failed" : "completed",
            label: ended ? "权威来源未找到该注册号" : "权威来源已返回候选",
            detail: ended ? "未建立任何正式企业身份" : "已取得 1 条实时原始候选，正在执行强标识解析",
            createdAt: new Date().toISOString()
          }]
        };
        Object.assign(candidate, { identityBootstrapAttempts: [attempt] });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            taskStatus: attempt.taskStatus,
            taskStatusLabel: ended ? "已结束" : "进行中",
            attempt,
            candidate,
            progress: {
              status: ended ? "succeeded_empty" : "running",
              terminal: ended,
              progress: ended ? 100 : 62,
              currentAction: ended ? "权威来源搜索已结束" : "正在归一强注册标识",
              sourceCount: 1,
              settledSources: ended ? 1 : 0,
              candidateCount: 1,
              verifiedCount: 0,
              filteredCount: ended ? 1 : 0,
              candidates: [{
                id: `candidate_live_${suffix}`,
                company: "Live Authority Candidate",
                country: "DE",
                source: "GLEIF",
                verificationLevel: "待强标识解析"
              }]
            }
          })
        });
        return;
      }
      Object.assign(candidate, { identityBootstrapAttempts: [baseAttempt] });
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          replayed: false,
          taskStatus: "running",
          taskStatusLabel: "进行中",
          attempt: baseAttempt,
          candidateId
        })
      });
    }
  );

  await page.reload();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await openProspectList(page);
  await page.locator("#prospectSearchInput").fill(company);
  await page.locator("#prospectListRows [data-prospect-open]").first().click();

  const panel = page.locator(".prospect-identity-panel");
  await expect(panel).toContainText("正式身份引导");
  await expect(page.locator("#prospectIdentityProvider")).toBeVisible();
  await expect(page.locator("#prospectIdentityRegistration")).toHaveAttribute("placeholder", "20 位 LEI");
  await expect(page.locator("#prospectIdentityProviderHint")).toContainText("无需注册或配置凭据");
  await page.locator("#prospectIdentityRegistration").fill(lei);
  await page.locator("#prospectIdentityStartButton").click();

  await expect(panel.locator(".prospect-probe-head .badge")).toHaveText("进行中");
  await expect(panel).toContainText("Live Authority Candidate");
  await expect(panel).toContainText("进度 62%");
  await expect(panel).toContainText("正在归一强注册标识");

  await expect(panel.locator(".prospect-probe-head .badge")).toHaveText("已结束", { timeout: 8_000 });
  await expect(panel).not.toContainText("部分完成");
  const details = panel.locator("details.prospect-identity-detail");
  await expect(details).not.toHaveAttribute("open", "");
  await expect(details.locator(".prospect-identity-result")).toBeHidden();
  await details.locator("summary").click();
  await expect(details.locator(".prospect-identity-result")).toBeVisible();
  await expect(panel).toContainText("权威来源未找到该注册号");
  await expect(panel).not.toContainText("AUTHORITY_IDENTIFIER_NOT_FOUND");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
});
