import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { publicUser, signToken } from "./auth.js";
import { app } from "./server.js";
import { getStore } from "./store.js";
import { createOpenApiDocument } from "./swagger.js";
import type { Role, User } from "./types.js";

function testUser(id: string, teamId: string, role: Role): User {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    password: "test-only",
    role,
    teamId,
    avatar: id.slice(0, 2).toUpperCase(),
    status: "active",
    authVersion: 1
  };
}

const store = getStore();
const original = {
  users: [...store.users],
  campaigns: [...store.prospectCampaigns],
  versions: [...store.prospectCampaignVersions],
  events: [...store.prospectCampaignEvents],
  strategies: [...store.prospectStrategies],
  strategyEvents: [...store.prospectStrategyEvents],
  persist: store.persist,
  persistMutation: store.persistMutation
};
const salesA = testUser("campaign_sales_a", "campaign_team_a", "sales");
const salesA2 = testUser("campaign_sales_a_2", "campaign_team_a", "sales");
const managerA = testUser("campaign_manager_a", "campaign_team_a", "manager");
const adminA = testUser("campaign_admin_a", "campaign_team_a", "admin");
const salesB = testUser("campaign_sales_b", "campaign_team_b", "sales");
const managerB = testUser("campaign_manager_b", "campaign_team_b", "manager");
const superAdmin = testUser("campaign_super", "all", "super_admin");
const departingSales = testUser(
  "campaign_departing_sales",
  "campaign_team_a",
  "sales"
);
store.users.push(
  salesA,
  salesA2,
  managerA,
  adminA,
  salesB,
  managerB,
  superAdmin,
  departingSales
);
store.prospectCampaigns.splice(0);
store.prospectCampaignVersions.splice(0);
store.prospectCampaignEvents.splice(0);
store.prospectStrategies.splice(0);
store.prospectStrategyEvents.splice(0);

const tokens = Object.fromEntries(
  [
    salesA,
    salesA2,
    managerA,
    adminA,
    salesB,
    managerB,
    superAdmin,
    departingSales
  ]
    .map((user) => [user.id, signToken(publicUser(user))])
);
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start prospect campaign test server");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(input: {
  path: string;
  method?: string;
  token?: string | null;
  body?: unknown;
  ifMatch?: string;
}) {
  const headers: Record<string, string> = {};
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  if (input.body !== undefined) headers["content-type"] = "application/json";
  if (input.ifMatch) headers["if-match"] = input.ifMatch;
  const response = await fetch(`${baseUrl}${input.path}`, {
    method: input.method || "GET",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });
  return {
    response,
    json: await response.json().catch(() => ({}))
  };
}

function token(user: User) {
  return tokens[user.id] as string;
}

const fullSnapshot = {
  goal: "开发有室外工程照明采购计划的进口商",
  products: ["LED flood light"],
  markets: ["Germany"],
  customerTypes: ["Importer"],
  applicationScenarios: ["Warehouse and outdoor project lighting"],
  icpRules: ["Has a public industrial lighting catalog"],
  exclusionRules: ["Consumer-only retailer"],
  sourceProviderIds: ["un_comtrade"]
};

try {
  const anonymous = await request({ path: "/api/prospect-campaigns" });
  assert.equal(anonymous.response.status, 401);

  const superList = await request({
    path: "/api/prospect-campaigns",
    token: token(superAdmin)
  });
  assert.equal(superList.response.status, 403);
  assert.equal(superList.json.errorCode, "CAMPAIGN_CRUD_FORBIDDEN");

  const ownerInjection = await request({
    path: "/api/prospect-campaigns",
    method: "POST",
    token: token(salesA),
    body: {
      name: "Injected Team",
      teamId: salesB.teamId
    }
  });
  assert.equal(ownerInjection.response.status, 400);

  const created = await request({
    path: "/api/prospect-campaigns",
    method: "POST",
    token: token(salesA),
    body: { name: "Germany Lighting Draft" }
  });
  assert.equal(created.response.status, 201);
  assert.match(created.json.campaign.id, /^pc_[0-9a-f-]{36}$/i);
  assert.equal(created.json.campaign.status, "draft");
  assert.equal(created.json.campaign.ownerId, salesA.id);
  assert.equal(created.json.campaign.revision, 1);
  assert.equal("teamId" in created.json.campaign, false);
  assert.equal(created.json.currentVersion.version, 1);
  assert.deepEqual(created.json.currentVersion.snapshot.products, []);
  assert.equal(created.json.versions.length, 1);
  assert.equal(created.json.events[0].eventType, "created");
  const campaignId = created.json.campaign.id as string;
  const etag1 = created.response.headers.get("etag");
  assert.ok(etag1);
  assert.equal(store.prospectCampaigns.length, 1);
  assert.equal(store.prospectCampaignVersions.length, 1);
  assert.equal(store.prospectCampaignEvents.length, 1);
  assert.equal(store.prospectStrategies.length, 1);
  assert.equal(store.prospectStrategies[0]?.status, "draft");
  assert.equal(store.prospectStrategies[0]?.campaignVersion, 1);
  assert.equal(store.prospectStrategyEvents.length, 1);

  const ownerList = await request({
    path: "/api/prospect-campaigns",
    token: token(salesA)
  });
  assert.equal(ownerList.response.status, 200);
  assert.equal(ownerList.json.total, 1);

  const otherSalesList = await request({
    path: "/api/prospect-campaigns",
    token: token(salesA2)
  });
  assert.equal(otherSalesList.response.status, 200);
  assert.equal(otherSalesList.json.total, 0);

  const otherSalesDetail = await request({
    path: `/api/prospect-campaigns/${campaignId}`,
    token: token(salesA2)
  });
  assert.equal(otherSalesDetail.response.status, 404);
  assert.equal(otherSalesDetail.json.errorCode, "CAMPAIGN_NOT_FOUND");

  const teamManagerDetail = await request({
    path: `/api/prospect-campaigns/${campaignId}`,
    token: token(managerA)
  });
  assert.equal(teamManagerDetail.response.status, 200);

  const crossTeamDetail = await request({
    path: `/api/prospect-campaigns/${campaignId}`,
    token: token(managerB)
  });
  assert.equal(crossTeamDetail.response.status, 404);
  assert.deepEqual(crossTeamDetail.json, otherSalesDetail.json);

  const missingIfMatch = await request({
    path: `/api/prospect-campaigns/${campaignId}`,
    method: "PATCH",
    token: token(salesA),
    body: { name: "No If Match" }
  });
  assert.equal(missingIfMatch.response.status, 428);
  assert.equal(missingIfMatch.json.errorCode, "PRECONDITION_REQUIRED");

  const wrongIfMatch = await request({
    path: `/api/prospect-campaigns/${campaignId}`,
    method: "PATCH",
    token: token(salesA),
    ifMatch: `"${campaignId}:99"`,
    body: { name: "Wrong Revision" }
  });
  assert.equal(wrongIfMatch.response.status, 412);
  assert.equal(wrongIfMatch.json.errorCode, "CAMPAIGN_REVISION_CONFLICT");

  const emptyActivation = await request({
    path: `/api/prospect-campaigns/${campaignId}/activate`,
    method: "POST",
    token: token(salesA),
    ifMatch: etag1!,
    body: {}
  });
  assert.equal(emptyActivation.response.status, 422);
  assert.equal(emptyActivation.json.errorCode, "CAMPAIGN_FIELDS_REQUIRED");
  assert.deepEqual(
    [...emptyActivation.json.missingFields].sort(),
    [
      "applicationScenarios",
      "customerTypes",
      "goal",
      "markets",
      "products",
      "sourceProviderIds"
    ].sort()
  );
  assert.equal(store.prospectCampaigns[0]?.revision, 1);
  assert.equal(store.prospectCampaignEvents.length, 1);

  const versionCreated = await request({
    path: `/api/prospect-campaigns/${campaignId}/versions`,
    method: "POST",
    token: token(salesA),
    ifMatch: etag1!,
    body: {
      snapshot: fullSnapshot,
      changeSummary: "补全德国市场画像"
    }
  });
  assert.equal(versionCreated.response.status, 201);
  assert.equal(versionCreated.json.created, true);
  assert.equal(versionCreated.json.campaign.currentVersion, 2);
  assert.equal(versionCreated.json.campaign.revision, 2);
  assert.equal(versionCreated.json.versions.length, 2);
  assert.equal(
    versionCreated.json.currentVersion.contentHash.length,
    64
  );
  const etag2 = versionCreated.response.headers.get("etag");
  assert.ok(etag2);

  const staleUpdate = await request({
    path: `/api/prospect-campaigns/${campaignId}`,
    method: "PATCH",
    token: token(salesA),
    ifMatch: etag1!,
    body: { name: "Stale Update" }
  });
  assert.equal(staleUpdate.response.status, 412);

  const duplicateVersion = await request({
    path: `/api/prospect-campaigns/${campaignId}/versions`,
    method: "POST",
    token: token(salesA),
    ifMatch: etag2!,
    body: { snapshot: fullSnapshot }
  });
  assert.equal(duplicateVersion.response.status, 200);
  assert.equal(duplicateVersion.json.created, false);
  assert.equal(duplicateVersion.json.campaign.revision, 2);
  assert.equal(store.prospectCampaignVersions.length, 2);

  const strategyGate = await request({
    path: `/api/prospect-campaigns/${campaignId}/activate`,
    method: "POST",
    token: token(salesA),
    ifMatch: etag2!,
    body: {}
  });
  assert.equal(strategyGate.response.status, 409);
  assert.equal(strategyGate.json.errorCode, "CAMPAIGN_STRATEGY_REQUIRED");
  assert.equal(store.prospectCampaigns[0]?.status, "draft");
  assert.equal(store.prospectCampaigns[0]?.revision, 2);

  const departingCampaignCreated = await request({
    path: "/api/prospect-campaigns",
    method: "POST",
    token: token(adminA),
    body: {
      name: "离职交接测试项目",
      ownerId: departingSales.id
    }
  });
  assert.equal(departingCampaignCreated.response.status, 201);
  const departingCampaignId = departingCampaignCreated.json.campaign.id as string;
  const departingCreateEtag = departingCampaignCreated.response.headers.get("etag");
  assert.ok(departingCreateEtag);

  const archivedDepartingCampaign = await request({
    path: `/api/prospect-campaigns/${departingCampaignId}/archive`,
    method: "POST",
    token: token(adminA),
    ifMatch: departingCreateEtag!,
    body: { reason: "离职前归档" }
  });
  assert.equal(archivedDepartingCampaign.response.status, 200);
  assert.equal(archivedDepartingCampaign.json.campaign.status, "archived");
  const archivedDepartingEtag = archivedDepartingCampaign.response.headers.get("etag");
  assert.ok(archivedDepartingEtag);

  const deleteBlockedByArchivedCampaign = await request({
    path: `/api/accounts/${departingSales.id}`,
    method: "DELETE",
    token: token(adminA)
  });
  assert.equal(deleteBlockedByArchivedCampaign.response.status, 409);

  const terminalRenameBlocked = await request({
    path: `/api/prospect-campaigns/${departingCampaignId}`,
    method: "PATCH",
    token: token(adminA),
    ifMatch: archivedDepartingEtag!,
    body: { name: "归档后不允许改名" }
  });
  assert.equal(terminalRenameBlocked.response.status, 409);
  assert.equal(terminalRenameBlocked.json.errorCode, "CAMPAIGN_READ_ONLY");

  const terminalOwnerTransferred = await request({
    path: `/api/prospect-campaigns/${departingCampaignId}`,
    method: "PATCH",
    token: token(adminA),
    ifMatch: archivedDepartingEtag!,
    body: {
      ownerId: salesA2.id,
      reason: "离职项目交接"
    }
  });
  assert.equal(terminalOwnerTransferred.response.status, 200);
  assert.equal(terminalOwnerTransferred.json.campaign.status, "archived");
  assert.equal(terminalOwnerTransferred.json.campaign.ownerId, salesA2.id);
  assert.equal(
    terminalOwnerTransferred.json.events.some(
      (item: { eventType: string; reason: string }) =>
        item.eventType === "owner_transferred"
        && item.reason === "离职项目交接"
    ),
    true
  );

  const departingAccountDeleted = await request({
    path: `/api/accounts/${departingSales.id}`,
    method: "DELETE",
    token: token(adminA)
  });
  assert.equal(departingAccountDeleted.response.status, 200);
  assert.equal(
    store.users.some((item) => item.id === departingSales.id),
    false
  );

  const formalRunBlocked = await request({
    path: `/api/prospect-campaigns/${campaignId}/market-analysis-runs`,
    method: "POST",
    token: token(salesA),
    body: {}
  });
  assert.equal(formalRunBlocked.response.status, 409);
  assert.equal(formalRunBlocked.json.errorCode, "CAMPAIGN_NOT_ACTIVE");

  const absentFormalId = `pc_${randomUUID()}`;
  const absentFormalRead = await request({
    path: `/api/prospect-campaigns/${absentFormalId}/trade-observations`,
    token: token(salesA)
  });
  assert.equal(absentFormalRead.response.status, 404);
  assert.equal(absentFormalRead.json.errorCode, "CAMPAIGN_NOT_FOUND");

  const legacyRead = await request({
    path: "/api/prospect-campaigns/legacy_campaign_ref/trade-observations",
    token: token(salesA)
  });
  assert.equal(legacyRead.response.status, 200);
  assert.equal(legacyRead.json.campaignContractMode, "compat_v1");
  assert.equal(legacyRead.json.campaignScope, "owner");

  const transferred = await request({
    path: `/api/prospect-campaigns/${campaignId}`,
    method: "PATCH",
    token: token(managerA),
    ifMatch: etag2!,
    body: {
      ownerId: salesA2.id,
      reason: "调整德国市场负责人"
    }
  });
  assert.equal(transferred.response.status, 200);
  assert.equal(transferred.json.campaign.ownerId, salesA2.id);
  assert.equal(transferred.json.campaign.revision, 3);
  assert.equal(transferred.json.events[0].eventType, "owner_transferred");
  const etag3 = transferred.response.headers.get("etag");
  assert.ok(etag3);

  const oldOwnerAfterTransfer = await request({
    path: `/api/prospect-campaigns/${campaignId}`,
    token: token(salesA)
  });
  assert.equal(oldOwnerAfterTransfer.response.status, 404);
  const newOwnerAfterTransfer = await request({
    path: `/api/prospect-campaigns/${campaignId}`,
    token: token(salesA2)
  });
  assert.equal(newOwnerAfterTransfer.response.status, 200);

  const archived = await request({
    path: `/api/prospect-campaigns/${campaignId}/archive`,
    method: "POST",
    token: token(salesA2),
    ifMatch: etag3!,
    body: { reason: "项目暂不继续" }
  });
  assert.equal(archived.response.status, 200);
  assert.equal(archived.json.campaign.status, "archived");
  assert.equal(archived.json.campaign.revision, 4);
  assert.ok(archived.json.campaign.archivedAt);
  const archivedEtag = archived.response.headers.get("etag");
  assert.ok(archivedEtag);

  const archivedUpdate = await request({
    path: `/api/prospect-campaigns/${campaignId}`,
    method: "PATCH",
    token: token(salesA2),
    ifMatch: archivedEtag!,
    body: { name: "Archived Rename" }
  });
  assert.equal(archivedUpdate.response.status, 409);
  assert.equal(archivedUpdate.json.errorCode, "CAMPAIGN_READ_ONLY");

  const defaultArchivedList = await request({
    path: "/api/prospect-campaigns",
    token: token(managerA)
  });
  assert.equal(defaultArchivedList.json.total, 0);
  const includedArchivedList = await request({
    path: "/api/prospect-campaigns?includeArchived=true",
    token: token(managerA)
  });
  assert.equal(includedArchivedList.json.total, 2);

  const activeFixture = await request({
    path: "/api/prospect-campaigns",
    method: "POST",
    token: token(salesB),
    body: { name: "State Matrix Fixture", snapshot: fullSnapshot }
  });
  assert.equal(activeFixture.response.status, 201);
  const activeCampaign = store.prospectCampaigns.find(
    (item) => item.id === activeFixture.json.campaign.id
  );
  assert.ok(activeCampaign);
  activeCampaign.status = "active";
  const paused = await request({
    path: `/api/prospect-campaigns/${activeCampaign.id}/pause`,
    method: "POST",
    token: token(salesB),
    ifMatch: activeFixture.response.headers.get("etag")!,
    body: { reason: "暂停自动获客" }
  });
  assert.equal(paused.response.status, 200);
  assert.equal(paused.json.campaign.status, "paused");
  const completed = await request({
    path: `/api/prospect-campaigns/${activeCampaign.id}/complete`,
    method: "POST",
    token: token(salesB),
    ifMatch: paused.response.headers.get("etag")!,
    body: { reason: "达到阶段目标" }
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.json.campaign.status, "completed");
  const invalidResume = await request({
    path: `/api/prospect-campaigns/${activeCampaign.id}/activate`,
    method: "POST",
    token: token(salesB),
    ifMatch: completed.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(invalidResume.response.status, 409);
  assert.equal(invalidResume.json.errorCode, "CAMPAIGN_STATE_INVALID");

  const concurrentFixture = await request({
    path: "/api/prospect-campaigns",
    method: "POST",
    token: token(salesA),
    body: { name: "Concurrent Fixture" }
  });
  const concurrentId = concurrentFixture.json.campaign.id as string;
  const concurrentEtag = concurrentFixture.response.headers.get("etag")!;
  const concurrentResults = await Promise.all([
    request({
      path: `/api/prospect-campaigns/${concurrentId}`,
      method: "PATCH",
      token: token(salesA),
      ifMatch: concurrentEtag,
      body: { name: "Concurrent A" }
    }),
    request({
      path: `/api/prospect-campaigns/${concurrentId}`,
      method: "PATCH",
      token: token(salesA),
      ifMatch: concurrentEtag,
      body: { name: "Concurrent B" }
    })
  ]);
  assert.deepEqual(
    concurrentResults.map((item) => item.response.status).sort(),
    [200, 412]
  );

  const countBeforeFailedCreate = store.prospectCampaigns.length;
  store.persist = async () => {
    throw new Error("simulated campaign persistence failure");
  };
  const failedCreate = await request({
    path: "/api/prospect-campaigns",
    method: "POST",
    token: token(salesA),
    body: { name: "Must Roll Back" }
  });
  assert.equal(failedCreate.response.status, 500);
  assert.equal(store.prospectCampaigns.length, countBeforeFailedCreate);
  assert.equal(
    store.prospectCampaigns.some((item) => item.name === "Must Roll Back"),
    false
  );
  store.persist = original.persist;

  const openApi = createOpenApiDocument(app) as any;
  const campaignCreate = openApi.paths["/api/prospect-campaigns"]?.post;
  const campaignVersion = openApi.paths["/api/prospect-campaigns/{id}/versions"]?.post;
  const campaignActivate = openApi.paths["/api/prospect-campaigns/{id}/activate"]?.post;
  assert.ok(campaignCreate);
  assert.ok(campaignCreate.responses["201"]);
  assert.equal(
    campaignCreate.requestBody.content["application/json"].schema.required[0],
    "name"
  );
  assert.ok(
    campaignVersion.parameters.some(
      (item: any) => item.name === "If-Match" && item.required === true
    )
  );
  assert.ok(campaignVersion.responses["428"]);
  assert.ok(campaignVersion.responses["412"]);
  assert.ok(campaignActivate.responses["422"]);

  console.log("Prospect campaign tests passed");
} finally {
  server.close();
  store.users.splice(0, store.users.length, ...original.users);
  store.prospectCampaigns.splice(
    0,
    store.prospectCampaigns.length,
    ...original.campaigns
  );
  store.prospectCampaignVersions.splice(
    0,
    store.prospectCampaignVersions.length,
    ...original.versions
  );
  store.prospectCampaignEvents.splice(
    0,
    store.prospectCampaignEvents.length,
    ...original.events
  );
  store.prospectStrategies.splice(
    0,
    store.prospectStrategies.length,
    ...original.strategies
  );
  store.prospectStrategyEvents.splice(
    0,
    store.prospectStrategyEvents.length,
    ...original.strategyEvents
  );
  store.persist = original.persist;
  store.persistMutation = original.persistMutation;
}
