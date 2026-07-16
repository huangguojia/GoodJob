import assert from "node:assert/strict";
import { publicUser, signToken } from "./auth.js";
import {
  createCredentialRef,
  encryptProviderConfiguration
} from "./credential-security.js";
import {
  createProspectCampaign,
  prospectCampaignEtag,
  transitionProspectCampaign,
  updateProspectCampaign
} from "./prospect-campaigns.js";
import {
  normalizeProspectStrategyProviderPlan,
  normalizeProspectStrategyQuery,
  prospectStrategyFingerprint
} from "./prospect-strategies.js";
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
  campaignEvents: [...store.prospectCampaignEvents],
  strategies: [...store.prospectStrategies],
  strategyEvents: [...store.prospectStrategyEvents],
  providerCatalog: structuredClone(store.providerCatalog),
  providerConnections: [...store.providerConnections],
  aiModelConfigs: [...store.aiModelConfigs],
  persist: store.persist,
  persistMutation: store.persistMutation
};
const salesA = testUser("strategy_sales_a", "strategy_team_a", "sales");
const salesA2 = testUser("strategy_sales_a_2", "strategy_team_a", "sales");
const managerA = testUser("strategy_manager_a", "strategy_team_a", "manager");
const managerB = testUser("strategy_manager_b", "strategy_team_b", "manager");
const superAdmin = testUser("strategy_super", "all", "super_admin");
store.users.push(salesA, salesA2, managerA, managerB, superAdmin);
store.prospectCampaigns.splice(0);
store.prospectCampaignVersions.splice(0);
store.prospectCampaignEvents.splice(0);
store.prospectStrategies.splice(0);
store.prospectStrategyEvents.splice(0);
store.providerConnections.splice(0);
store.aiModelConfigs.splice(0);

const tokens = Object.fromEntries(
  [salesA, salesA2, managerA, managerB, superAdmin]
    .map((user) => [user.id, signToken(publicUser(user))])
);
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start prospect strategy test server");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(input: {
  path: string;
  method?: string;
  user?: User | null;
  body?: unknown;
  ifMatch?: string;
}) {
  const headers: Record<string, string> = {};
  if (input.user) headers.authorization = `Bearer ${tokens[input.user.id]}`;
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

const fullSnapshot = {
  goal: "开发德国工业照明进口商",
  products: ["LED Flood Light"],
  markets: ["Germany"],
  customerTypes: ["Importer"],
  applicationScenarios: ["Warehouse project"],
  icpRules: [],
  exclusionRules: [],
  sourceProviderIds: ["gleif"]
};

try {
  const created = await createProspectCampaign({
    store,
    user: publicUser(salesA),
    body: {
      name: "德国照明策略项目",
      snapshot: fullSnapshot
    },
    requestId: "strategy-campaign-create"
  });
  const campaignId = created.campaign.id;
  const defaultStrategy = store.prospectStrategies.find(
    (item) => item.campaignId === campaignId
  );
  assert.ok(defaultStrategy);
  assert.equal(defaultStrategy.status, "draft");
  assert.equal(defaultStrategy.campaignVersion, 1);
  assert.equal(store.prospectStrategyEvents.length, 1);

  const anonymous = await request({
    path: `/api/prospect-campaigns/${campaignId}/strategies`
  });
  assert.equal(anonymous.response.status, 401);

  const superList = await request({
    path: `/api/prospect-campaigns/${campaignId}/strategies`,
    user: superAdmin
  });
  assert.equal(superList.response.status, 403);
  assert.equal(superList.json.errorCode, "STRATEGY_CRUD_FORBIDDEN");

  const otherSalesList = await request({
    path: `/api/prospect-campaigns/${campaignId}/strategies`,
    user: salesA2
  });
  assert.equal(otherSalesList.response.status, 404);

  const managerList = await request({
    path: `/api/prospect-campaigns/${campaignId}/strategies`,
    user: managerA
  });
  assert.equal(managerList.response.status, 200);
  assert.equal(managerList.json.total, 1);

  const crossTeamList = await request({
    path: `/api/prospect-campaigns/${campaignId}/strategies`,
    user: managerB
  });
  assert.equal(crossTeamList.response.status, 404);
  assert.deepEqual(crossTeamList.json, otherSalesList.json);

  const detail = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}`,
    user: salesA
  });
  assert.equal(detail.response.status, 200);
  const strategyEtag1 = detail.response.headers.get("etag");
  assert.ok(strategyEtag1);

  const emptyPreview = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}/preview`,
    method: "POST",
    user: salesA,
    body: {}
  });
  assert.equal(emptyPreview.response.status, 200);
  assert.deepEqual(emptyPreview.json.resolvedQuery.positiveKeywords, [
    "led flood light"
  ]);
  assert.deepEqual(emptyPreview.json.resolvedQuery.countries, ["germany"]);
  assert.deepEqual(emptyPreview.json.resolvedQuery.customerTypes, ["importer"]);
  assert.equal(emptyPreview.json.readyForApproval, false);
  assert.equal(emptyPreview.json.history.available, false);
  assert.equal(emptyPreview.json.estimate.available, false);

  const visibleDuplicateCampaign = await createProspectCampaign({
    store,
    user: publicUser(salesA),
    body: {
      name: "本人重复范围项目",
      snapshot: fullSnapshot
    },
    requestId: "strategy-visible-duplicate"
  });
  const visibleDuplicatePreview = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}/preview`,
    method: "POST",
    user: salesA,
    body: {}
  });
  assert.equal(visibleDuplicatePreview.response.status, 200);
  assert.equal(visibleDuplicatePreview.json.duplicate.exists, true);
  assert.equal(
    visibleDuplicatePreview.json.duplicate.strategyId,
    store.prospectStrategies.find(
      (item) => item.campaignId === visibleDuplicateCampaign.campaign.id
    )?.id
  );

  const isolatedSnapshot = {
    ...fullSnapshot,
    products: ["industrial valve"],
    markets: ["canada"]
  };
  const isolatedOwnerCampaign = await createProspectCampaign({
    store,
    user: publicUser(salesA),
    body: {
      name: "隔离范围本人项目",
      snapshot: isolatedSnapshot
    },
    requestId: "strategy-isolated-owner"
  });
  const isolatedOwnerStrategy = store.prospectStrategies.find(
    (item) => item.campaignId === isolatedOwnerCampaign.campaign.id
  )!;
  await createProspectCampaign({
    store,
    user: publicUser(managerB),
    body: {
      name: "跨团队相同范围项目",
      snapshot: isolatedSnapshot
    },
    requestId: "strategy-cross-team-duplicate"
  });
  const crossTeamDuplicatePreview = await request({
    path: `/api/prospect-strategies/${isolatedOwnerStrategy.id}/preview`,
    method: "POST",
    user: salesA,
    body: {}
  });
  assert.equal(crossTeamDuplicatePreview.response.status, 200);
  assert.equal(crossTeamDuplicatePreview.json.duplicate.exists, false);

  const teamDuplicateCampaign = await createProspectCampaign({
    store,
    user: publicUser(managerA),
    body: {
      name: "团队他人相同范围项目",
      ownerId: salesA2.id,
      snapshot: isolatedSnapshot
    },
    requestId: "strategy-team-duplicate"
  });
  const hiddenTeamDuplicatePreview = await request({
    path: `/api/prospect-strategies/${isolatedOwnerStrategy.id}/preview`,
    method: "POST",
    user: salesA,
    body: {}
  });
  assert.equal(hiddenTeamDuplicatePreview.response.status, 200);
  assert.equal(hiddenTeamDuplicatePreview.json.duplicate.exists, false);
  const managerTeamDuplicatePreview = await request({
    path: `/api/prospect-strategies/${isolatedOwnerStrategy.id}/preview`,
    method: "POST",
    user: managerA,
    body: {}
  });
  assert.equal(managerTeamDuplicatePreview.response.status, 200);
  assert.equal(managerTeamDuplicatePreview.json.duplicate.exists, true);
  assert.equal(
    managerTeamDuplicatePreview.json.duplicate.strategyId,
    store.prospectStrategies.find(
      (item) => item.campaignId === teamDuplicateCampaign.campaign.id
    )?.id
  );

  const missingIfMatch = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}`,
    method: "PATCH",
    user: salesA,
    body: { name: "No ETag" }
  });
  assert.equal(missingIfMatch.response.status, 428);

  const duplicateProviders = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}`,
    method: "PATCH",
    user: salesA,
    ifMatch: strategyEtag1!,
    body: {
      providerPlan: [
        { providerId: "gleif" },
        { providerId: "GLEIF" }
      ]
    }
  });
  assert.equal(duplicateProviders.response.status, 400);

  const updated = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}`,
    method: "PATCH",
    user: salesA,
    ifMatch: strategyEtag1!,
    body: {
      name: "德国进口商搜索",
      query: {
        synonyms: ["Floodlight", " floodlight "],
        exclusionDomains: ["Example.COM"]
      },
      providerPlan: [{
        providerId: "GLEIF",
        priority: 10,
        pageLimit: 2,
        resultLimit: 40,
        budgetLimit: null,
        currency: ""
      }]
    }
  });
  assert.equal(updated.response.status, 200);
  assert.deepEqual(updated.json.strategy.query.synonyms, ["floodlight"]);
  assert.deepEqual(
    updated.json.strategy.query.exclusionDomains,
    ["example.com"]
  );
  assert.equal(updated.json.strategy.providerPlan[0].providerId, "gleif");
  const fingerprintBeforeLimitChange = updated.json.strategy.queryFingerprint;
  const strategyEtag2 = updated.response.headers.get("etag")!;

  const limitOnlyUpdate = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}`,
    method: "PATCH",
    user: salesA,
    ifMatch: strategyEtag2,
    body: {
      providerPlan: [{
        providerId: "gleif",
        priority: 80,
        pageLimit: 9,
        resultLimit: 300,
        budgetLimit: 50,
        currency: "USD"
      }]
    }
  });
  assert.equal(limitOnlyUpdate.response.status, 200);
  assert.equal(
    limitOnlyUpdate.json.strategy.queryFingerprint,
    fingerprintBeforeLimitChange
  );
  const strategyEtag3 = limitOnlyUpdate.response.headers.get("etag")!;

  const readyPreview = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}/preview`,
    method: "POST",
    user: salesA,
    body: {}
  });
  assert.equal(readyPreview.response.status, 200);
  assert.equal(readyPreview.json.readyForApproval, true);
  assert.deepEqual(readyPreview.json.executionOrder, ["gleif"]);

  const staleApprove = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}/approve`,
    method: "POST",
    user: salesA,
    ifMatch: strategyEtag2,
    body: {}
  });
  assert.equal(staleApprove.response.status, 412);

  const approved = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}/approve`,
    method: "POST",
    user: salesA,
    ifMatch: strategyEtag3,
    body: { reason: "关键词和数据源已确认" }
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.json.strategy.status, "approved");
  assert.equal(approved.json.strategy.approvedBy, salesA.id);
  const approvedEtag = approved.response.headers.get("etag")!;

  const mutateApproved = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}`,
    method: "PATCH",
    user: salesA,
    ifMatch: approvedEtag,
    body: { name: "Cannot Change" }
  });
  assert.equal(mutateApproved.response.status, 409);
  assert.equal(mutateApproved.json.errorCode, "STRATEGY_READ_ONLY");

  const copied = await request({
    path: `/api/prospect-campaigns/${campaignId}/strategies`,
    method: "POST",
    user: salesA,
    ifMatch: prospectCampaignEtag(store.prospectCampaigns[0]!),
    body: {
      name: "重复策略验证",
      copyFromStrategyId: defaultStrategy.id
    }
  });
  assert.equal(copied.response.status, 201);
  assert.equal(store.prospectCampaigns[0]?.revision, 2);
  assert.equal(
    copied.response.headers.get("x-campaign-etag"),
    prospectCampaignEtag(store.prospectCampaigns[0]!)
  );
  const copiedEtag = copied.response.headers.get("etag")!;

  const duplicateApprove = await request({
    path: `/api/prospect-strategies/${copied.json.strategy.id}/approve`,
    method: "POST",
    user: salesA,
    ifMatch: copiedEtag,
    body: {}
  });
  assert.equal(duplicateApprove.response.status, 409);
  assert.equal(
    duplicateApprove.json.errorCode,
    "STRATEGY_DUPLICATE_APPROVED"
  );

  const disabledCopy = await request({
    path: `/api/prospect-strategies/${copied.json.strategy.id}/disable`,
    method: "POST",
    user: salesA,
    ifMatch: copiedEtag,
    body: { reason: "重复草稿不再使用" }
  });
  assert.equal(disabledCopy.response.status, 200);
  assert.equal(disabledCopy.json.strategy.status, "disabled");
  assert.equal(disabledCopy.json.strategy.disableReason, "重复草稿不再使用");

  const activated = await request({
    path: `/api/prospect-campaigns/${campaignId}/activate`,
    method: "POST",
    user: salesA,
    ifMatch: prospectCampaignEtag(store.prospectCampaigns[0]!),
    body: {}
  });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.json.campaign.status, "active");
  assert.equal(store.prospectCampaigns[0]?.revision, 3);
  const activeCampaignEtag = activated.response.headers.get("etag")!;

  const createWhileActive = await request({
    path: `/api/prospect-campaigns/${campaignId}/strategies`,
    method: "POST",
    user: salesA,
    ifMatch: activeCampaignEtag,
    body: { name: "Active Create Forbidden" }
  });
  assert.equal(createWhileActive.response.status, 409);

  const disableLastApproved = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}/disable`,
    method: "POST",
    user: salesA,
    ifMatch: approvedEtag,
    body: {}
  });
  assert.equal(disableLastApproved.response.status, 409);
  assert.equal(disableLastApproved.json.errorCode, "STRATEGY_LAST_APPROVED");

  const paused = await transitionProspectCampaign({
    store,
    user: publicUser(salesA),
    campaignId,
    ifMatch: activeCampaignEtag,
    targetStatus: "paused",
    reason: "补充第二条策略",
    requestId: "strategy-pause"
  });
  assert.equal(paused.campaign.status, "paused");

  const secondCreated = await request({
    path: `/api/prospect-campaigns/${campaignId}/strategies`,
    method: "POST",
    user: salesA,
    ifMatch: prospectCampaignEtag(store.prospectCampaigns[0]!),
    body: {
      name: "仓库项目买家",
      query: {
        keywordMode: "specific",
        positiveKeywords: ["warehouse lighting buyer"]
      },
      providerPlan: [{ providerId: "gleif" }]
    }
  });
  assert.equal(secondCreated.response.status, 201);
  const secondApproved = await request({
    path: `/api/prospect-strategies/${secondCreated.json.strategy.id}/approve`,
    method: "POST",
    user: managerA,
    ifMatch: secondCreated.response.headers.get("etag")!,
    body: { reason: "经理复核" }
  });
  assert.equal(secondApproved.response.status, 200);
  assert.equal(secondApproved.json.strategy.approvedBy, managerA.id);

  const reactivated = await request({
    path: `/api/prospect-campaigns/${campaignId}/activate`,
    method: "POST",
    user: salesA,
    ifMatch: prospectCampaignEtag(store.prospectCampaigns[0]!),
    body: {}
  });
  assert.equal(reactivated.response.status, 200);

  const disableOneOfTwo = await request({
    path: `/api/prospect-strategies/${defaultStrategy.id}/disable`,
    method: "POST",
    user: salesA,
    ifMatch: approvedEtag,
    body: { reason: "切换为更精确的买家词" }
  });
  assert.equal(disableOneOfTwo.response.status, 200);

  const secondStrategyBeforeTransfer = store.prospectStrategies.find(
    (item) => item.id === secondCreated.json.strategy.id
  )!;
  const secondRevisionBeforeTransfer = secondStrategyBeforeTransfer.revision;
  const transferred = await updateProspectCampaign({
    store,
    user: publicUser(managerA),
    campaignId,
    ifMatch: prospectCampaignEtag(store.prospectCampaigns[0]!),
    body: {
      ownerId: salesA2.id,
      reason: "业务负责人调整"
    },
    requestId: "strategy-owner-transfer"
  });
  assert.equal(transferred.campaign.ownerId, salesA2.id);
  assert.ok(
    store.prospectStrategies
      .filter((item) => item.campaignId === campaignId)
      .every((item) => item.ownerId === salesA2.id)
  );
  assert.equal(
    store.prospectStrategies.find(
      (item) => item.id === secondStrategyBeforeTransfer.id
    )?.revision,
    secondRevisionBeforeTransfer + 1
  );

  const oldOwnerDetail = await request({
    path: `/api/prospect-strategies/${secondStrategyBeforeTransfer.id}`,
    user: salesA
  });
  const newOwnerDetail = await request({
    path: `/api/prospect-strategies/${secondStrategyBeforeTransfer.id}`,
    user: salesA2
  });
  assert.equal(oldOwnerDetail.response.status, 404);
  assert.equal(newOwnerDetail.response.status, 200);

  const inconsistentCampaign = await createProspectCampaign({
    store,
    user: publicUser(salesA),
    body: {
      name: "负责人一致性回滚",
      snapshot: fullSnapshot
    },
    requestId: "strategy-owner-consistency-create"
  });
  const inconsistentCampaignRecord = store.prospectCampaigns.find(
    (item) => item.id === inconsistentCampaign.campaign.id
  )!;
  const inconsistentStrategy = store.prospectStrategies.find(
    (item) => item.campaignId === inconsistentCampaignRecord.id
  )!;
  inconsistentStrategy.ownerId = salesA2.id;
  const inconsistentCampaignBefore = structuredClone(inconsistentCampaignRecord);
  const inconsistentStrategyBefore = structuredClone(inconsistentStrategy);
  const campaignEventCountBefore = store.prospectCampaignEvents.length;
  const strategyEventCountBefore = store.prospectStrategyEvents.length;
  const inconsistentTransfer = await updateProspectCampaign({
    store,
    user: publicUser(managerA),
    campaignId: inconsistentCampaignRecord.id,
    ifMatch: prospectCampaignEtag(inconsistentCampaignRecord),
    body: {
      ownerId: salesA2.id,
      reason: "验证异常历史数据不会产生部分转交"
    },
    requestId: "strategy-owner-consistency-transfer"
  }).then(
    () => null,
    (error) => error
  );
  assert.ok(inconsistentTransfer instanceof Error);
  assert.deepEqual(inconsistentCampaignRecord, inconsistentCampaignBefore);
  assert.deepEqual(inconsistentStrategy, inconsistentStrategyBefore);
  assert.equal(store.prospectCampaignEvents.length, campaignEventCountBefore);
  assert.equal(store.prospectStrategyEvents.length, strategyEventCountBefore);
  inconsistentStrategy.ownerId = salesA.id;

  const directVersion = store.prospectCampaignVersions.find(
    (item) => item.campaignId === campaignId && item.version === 1
  )!;
  const normalizedQueryA = normalizeProspectStrategyQuery({
    keywordMode: "specific",
    positiveKeywords: ["B", "Ａ", "b"],
    countryMode: "global",
    customerTypeMode: "all"
  });
  const normalizedQueryB = normalizeProspectStrategyQuery({
    keywordMode: "specific",
    positiveKeywords: ["a", "b"],
    countryMode: "global",
    customerTypeMode: "all"
  });
  const planA = normalizeProspectStrategyProviderPlan([{
    providerId: "gleif",
    priority: 99,
    pageLimit: 20,
    resultLimit: 500,
    budgetLimit: 100,
    currency: "USD"
  }]);
  const planB = normalizeProspectStrategyProviderPlan([{
    providerId: "gleif",
    priority: 1,
    pageLimit: 1,
    resultLimit: 1,
    budgetLimit: null,
    currency: ""
  }]);
  assert.equal(
    prospectStrategyFingerprint({
      version: directVersion,
      query: normalizedQueryA,
      providerPlan: planA
    }),
    prospectStrategyFingerprint({
      version: directVersion,
      query: normalizedQueryB,
      providerPlan: planB
    })
  );

  const keyCampaign = await createProspectCampaign({
    store,
    user: publicUser(salesA),
    body: {
      name: "需 Key 数据源项目",
      snapshot: {
        ...fullSnapshot,
        sourceProviderIds: ["serper"]
      }
    },
    requestId: "strategy-key-campaign"
  });
  const keyStrategy = store.prospectStrategies.find(
    (item) => item.campaignId === keyCampaign.campaign.id
  )!;
  const keyUpdate = await request({
    path: `/api/prospect-strategies/${keyStrategy.id}`,
    method: "PATCH",
    user: salesA,
    ifMatch: `"${keyStrategy.id}:${keyStrategy.revision}"`,
    body: { providerPlan: [{ providerId: "serper" }] }
  });
  const keyApproved = await request({
    path: `/api/prospect-strategies/${keyStrategy.id}/approve`,
    method: "POST",
    user: salesA,
    ifMatch: keyUpdate.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(keyApproved.response.status, 200);
  const keyActivation = await request({
    path: `/api/prospect-campaigns/${keyCampaign.campaign.id}/activate`,
    method: "POST",
    user: salesA,
    ifMatch: prospectCampaignEtag(
      store.prospectCampaigns.find(
        (item) => item.id === keyCampaign.campaign.id
      )!
    ),
    body: {}
  });
  assert.equal(keyActivation.response.status, 422);
  assert.equal(
    keyActivation.json.errorCode,
    "CAMPAIGN_PROVIDER_NOT_READY"
  );
  assert.ok(
    keyActivation.json.issues.some(
      (item: any) => item.code === "PROVIDER_CONNECTION_REQUIRED"
    )
  );

  const legacyConnectionId = "pc_strategy_legacy_team_scope";
  store.providerConnections.push({
    id: legacyConnectionId,
    providerId: "serper",
    scope: "team",
    credentialRef: createCredentialRef(),
    configurationEncrypted: encryptProviderConfiguration({
      id: legacyConnectionId,
      providerId: "serper",
      ownerId: salesA.id,
      teamId: salesA.teamId
    }, {
      apiKey: "legacy-team-key",
      baseUrl: ""
    }),
    status: "active",
    quotaPolicy: {},
    budgetPolicy: {},
    lastHealthAt: "",
    lastHealthStatus: "untested",
    lastErrorCode: "",
    lastHealthMessage: "",
    usage: "",
    ownerId: salesA.id,
    teamId: salesA.teamId,
    createdBy: salesA.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const legacyScopeActivation = await request({
    path: `/api/prospect-campaigns/${keyCampaign.campaign.id}/activate`,
    method: "POST",
    user: salesA,
    ifMatch: prospectCampaignEtag(
      store.prospectCampaigns.find(
        (item) => item.id === keyCampaign.campaign.id
      )!
    ),
    body: {}
  });
  assert.equal(legacyScopeActivation.response.status, 422);
  assert.ok(
    legacyScopeActivation.json.issues.some(
      (item: any) => item.code === "PROVIDER_CONNECTION_REQUIRED"
    )
  );
  store.providerConnections.splice(
    store.providerConnections.findIndex((item) => item.id === legacyConnectionId),
    1
  );

  const gleifCatalog = store.providerCatalog.find(
    (item) => item.code === "gleif"
  )!;
  const originalGleifAccessMode = gleifCatalog.accessMode;
  gleifCatalog.accessMode = "manual_assisted";
  const manualCampaign = await createProspectCampaign({
    store,
    user: publicUser(salesA),
    body: {
      name: "人工模式 Provider 门禁",
      snapshot: fullSnapshot
    },
    requestId: "strategy-manual-provider-create"
  });
  const manualStrategy = store.prospectStrategies.find(
    (item) => item.campaignId === manualCampaign.campaign.id
  )!;
  const manualUpdated = await request({
    path: `/api/prospect-strategies/${manualStrategy.id}`,
    method: "PATCH",
    user: salesA,
    ifMatch: `"${manualStrategy.id}:${manualStrategy.revision}"`,
    body: { providerPlan: [{ providerId: "gleif" }] }
  });
  const manualApproval = await request({
    path: `/api/prospect-strategies/${manualStrategy.id}/approve`,
    method: "POST",
    user: salesA,
    ifMatch: manualUpdated.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(manualApproval.response.status, 422);
  assert.ok(
    manualApproval.json.issues.some(
      (item: any) => item.code === "PROVIDER_RUNTIME_POLICY_INVALID"
    )
  );
  gleifCatalog.accessMode = originalGleifAccessMode;

  const ghostCatalog = {
    ...structuredClone(gleifCatalog),
    id: "provider_strategy_ghost",
    code: "strategy_ghost",
    name: "未安装适配器的数据源"
  };
  store.providerCatalog.push(ghostCatalog);
  const ghostCampaign = await createProspectCampaign({
    store,
    user: publicUser(salesA),
    body: {
      name: "缺失适配器 Provider 门禁",
      snapshot: {
        ...fullSnapshot,
        sourceProviderIds: ["strategy_ghost"]
      }
    },
    requestId: "strategy-ghost-provider-create"
  });
  const ghostStrategy = store.prospectStrategies.find(
    (item) => item.campaignId === ghostCampaign.campaign.id
  )!;
  const ghostUpdated = await request({
    path: `/api/prospect-strategies/${ghostStrategy.id}`,
    method: "PATCH",
    user: salesA,
    ifMatch: `"${ghostStrategy.id}:${ghostStrategy.revision}"`,
    body: { providerPlan: [{ providerId: "strategy_ghost" }] }
  });
  const ghostApproval = await request({
    path: `/api/prospect-strategies/${ghostStrategy.id}/approve`,
    method: "POST",
    user: salesA,
    ifMatch: ghostUpdated.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(ghostApproval.response.status, 422);
  assert.ok(
    ghostApproval.json.issues.some(
      (item: any) => item.code === "PROVIDER_ADAPTER_MISSING"
    )
  );
  store.providerCatalog.splice(
    store.providerCatalog.findIndex((item) => item.code === "strategy_ghost"),
    1
  );

  const emailOnlyCampaign = await createProspectCampaign({
    store,
    user: publicUser(salesA),
    body: {
      name: "邮箱补全 Provider 门禁",
      snapshot: {
        ...fullSnapshot,
        sourceProviderIds: ["hunter"]
      }
    },
    requestId: "strategy-email-provider-create"
  });
  const emailOnlyStrategy = store.prospectStrategies.find(
    (item) => item.campaignId === emailOnlyCampaign.campaign.id
  )!;
  const emailOnlyUpdated = await request({
    path: `/api/prospect-strategies/${emailOnlyStrategy.id}`,
    method: "PATCH",
    user: salesA,
    ifMatch: `"${emailOnlyStrategy.id}:${emailOnlyStrategy.revision}"`,
    body: { providerPlan: [{ providerId: "hunter" }] }
  });
  const emailOnlyApproval = await request({
    path: `/api/prospect-strategies/${emailOnlyStrategy.id}/approve`,
    method: "POST",
    user: salesA,
    ifMatch: emailOnlyUpdated.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(emailOnlyApproval.response.status, 422);
  assert.ok(
    emailOnlyApproval.json.issues.some(
      (item: any) => item.code === "PROVIDER_CAPABILITY_INVALID"
    )
  );

  const strategyCountBeforeFailure = store.prospectStrategies.length;
  const eventCountBeforeFailure = store.prospectStrategyEvents.length;
  store.persist = async () => {
    throw new Error("simulated strategy persistence failure");
  };
  const failedCreate = await createProspectCampaign({
    store,
    user: publicUser(salesA),
    body: {
      name: "策略原子回滚",
      snapshot: fullSnapshot
    },
    requestId: "strategy-rollback"
  }).then(
    () => null,
    (error) => error
  );
  assert.ok(failedCreate instanceof Error);
  assert.equal(store.prospectStrategies.length, strategyCountBeforeFailure);
  assert.equal(store.prospectStrategyEvents.length, eventCountBeforeFailure);
  assert.equal(
    store.prospectCampaigns.some((item) => item.name === "策略原子回滚"),
    false
  );
  store.persist = original.persist;

  const openApi = createOpenApiDocument(app) as any;
  const createStrategy = openApi.paths[
    "/api/prospect-campaigns/{id}/strategies"
  ]?.post;
  const patchStrategy = openApi.paths["/api/prospect-strategies/{id}"]?.patch;
  const previewStrategy = openApi.paths[
    "/api/prospect-strategies/{id}/preview"
  ]?.post;
  const approveStrategy = openApi.paths[
    "/api/prospect-strategies/{id}/approve"
  ]?.post;
  assert.ok(createStrategy);
  assert.ok(
    createStrategy.parameters.some(
      (item: any) => item.name === "If-Match" && item.required === true
    )
  );
  assert.ok(
    patchStrategy.parameters.some(
      (item: any) => item.name === "If-Match" && item.required === true
    )
  );
  assert.ok(previewStrategy);
  assert.ok(approveStrategy.responses["422"]);
  assert.ok(approveStrategy.responses["428"]);
  assert.ok(openApi.components.schemas.ProspectStrategyQueryInput);
  assert.ok(openApi.components.schemas.ProspectStrategyProviderPlanItem);

  console.log("Prospect strategy API, isolation, state, fingerprint and rollback tests passed");
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
    ...original.campaignEvents
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
  store.providerCatalog.splice(
    0,
    store.providerCatalog.length,
    ...original.providerCatalog
  );
  store.providerConnections.splice(
    0,
    store.providerConnections.length,
    ...original.providerConnections
  );
  store.aiModelConfigs.splice(
    0,
    store.aiModelConfigs.length,
    ...original.aiModelConfigs
  );
  store.persist = original.persist;
  store.persistMutation = original.persistMutation;
}
