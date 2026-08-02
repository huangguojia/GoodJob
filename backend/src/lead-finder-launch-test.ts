import assert from "node:assert/strict";
import { publicUser, signToken } from "./auth.js";
import {
  launchLeadFinder,
  type LaunchLeadFinderBody
} from "./lead-finder-launch.js";
import {
  getStore,
  type PersistedStoreMutation
} from "./store.js";
import type { User } from "./types.js";

const store = getStore();
const owner: User = {
  id: "lead-finder-launch-owner",
  name: "Lead Finder Launch Owner",
  email: "lead-finder-launch@example.test",
  password: "test-only",
  role: "sales",
  teamId: "lead-finder-launch-team",
  avatar: "LF",
  status: "active",
  authVersion: 1
};
store.users.push(owner);

let campaignMutationCalls = 0;
let executionMutationCalls = 0;
let generalMutationCalls = 0;
let superSearchPersistenceCalls = 0;
const applyMutation = async <T>(
  mutation: () => PersistedStoreMutation<T>
) => mutation().value;
store.persistProspectCampaignMutation = async <T>(
  mutation: () => PersistedStoreMutation<T>
) => {
  campaignMutationCalls += 1;
  return applyMutation(mutation);
};
store.persistProspectExecutionMutation = async <T>(
  mutation: () => PersistedStoreMutation<T>
) => {
  executionMutationCalls += 1;
  return applyMutation(mutation);
};
store.persistMutation = async <T>(
  _mutation: () => PersistedStoreMutation<T>
) => {
  generalMutationCalls += 1;
  throw new Error("搜客启动不应触发全 CRM 通用持久化");
};
store.persistProspectSuperSearches = async () => {
  superSearchPersistenceCalls += 1;
};

function launchBody(
  name: string,
  product: string,
  mode: "standard" | "super" = "standard"
): LaunchLeadFinderBody {
  return {
    mode,
    campaign: {
      name,
      snapshot: {
        goal: `Find German distributors for ${product}`,
        products: [product],
        markets: ["Germany"],
        customerTypes: ["Distributor"],
        applicationScenarios: ["industrial procurement"],
        icpRules: [],
        exclusionRules: ["consumer only"],
        sourceProviderIds: ["gleif"]
      }
    },
    strategy: {
      name: `${name} strategy`,
      query: {
        keywordMode: "campaign_products",
        positiveKeywords: [],
        synonyms: [],
        industryTerms: ["industrial procurement"],
        purchaseScenarioTerms: ["industrial procurement"],
        countryMode: "campaign_markets",
        countries: [],
        languages: [],
        customerTypeMode: "campaign_customer_types",
        customerTypes: [],
        exclusionKeywords: ["consumer only"],
        exclusionDomains: [],
        timeWindow: { mode: "all", from: "", to: "" }
      },
      providerPlan: [{
        providerId: "gleif",
        priority: 1,
        pageLimit: 1,
        resultLimit: 20,
        budgetLimit: null,
        currency: ""
      }],
      reason: "聚合启动测试"
    },
    ...(mode === "standard" ? {
      schedule: {
        frequency: "weekly" as const,
        timezone: "Asia/Shanghai",
        recurringCostApproved: false
      }
    } : {
      superSearch: {
        targetCandidateCount: 20,
        maxDurationMinutes: 60,
        depth: "balanced" as const,
        costLimit: 0,
        currency: "",
        aiMode: "auto" as const,
        webSearchMode: "off" as const,
        mapSearchMode: "off" as const,
        aiDiscoveryMode: "off" as const
      }
    })
  };
}

const emptyProviderPlanBody = launchBody(
  "Rejected empty source launch",
  "industrial process pump",
  "super"
);
emptyProviderPlanBody.strategy.providerPlan = [];
const campaignCountBeforeEmptyProviderPlan = store.prospectCampaigns.length;
await assert.rejects(
  () => launchLeadFinder({
    store,
    user: publicUser(owner),
    body: emptyProviderPlanBody,
    idempotencyKey: "lead-finder-launch-empty-sources-0001"
  }),
  /当前没有可执行的数据源/u
);
assert.equal(
  store.prospectCampaigns.length,
  campaignCountBeforeEmptyProviderPlan,
  "空来源启动必须在创建项目之前失败"
);

let queueSyncs = 0;
const standardBody = launchBody(
  "Aggregated standard launch",
  "industrial lighting"
);
const standard = await launchLeadFinder({
  store,
  user: publicUser(owner),
  body: standardBody,
  idempotencyKey: "lead-finder-launch-standard-0001",
  onRunCreated: () => { queueSyncs += 1; }
});
assert.equal(standard.campaign.status, "active");
assert.equal(standard.strategy.status, "approved");
assert.equal(standard.run.status, "queued");
assert.equal(standard.shards.length, 1);
assert.equal(standard.schedule?.status, "active");
assert.equal(standard.launchReplayed, false);
assert.equal(queueSyncs, 1);
assert.ok(standard.launchTimings.totalMs >= 0);

const replay = await launchLeadFinder({
  store,
  user: publicUser(owner),
  body: standardBody,
  idempotencyKey: "lead-finder-launch-standard-0001",
  onRunCreated: () => { queueSyncs += 1; }
});
assert.equal(replay.run.id, standard.run.id);
assert.equal(replay.campaign.id, standard.campaign.id);
assert.equal(replay.schedule?.id, standard.schedule?.id);
assert.equal(replay.launchReplayed, true);
assert.equal(queueSyncs, 1);

await assert.rejects(
  () => launchLeadFinder({
    store,
    user: publicUser(owner),
    body: launchBody("Changed request", "different product"),
    idempotencyKey: "lead-finder-launch-standard-0001"
  }),
  /请求标识已用于不同的搜客条件/u
);

const superResult = await launchLeadFinder({
  store,
  user: publicUser(owner),
  body: launchBody(
    "Aggregated super launch",
    "industrial process pump",
    "super"
  ),
  idempotencyKey: "lead-finder-launch-super-0001",
  onRunCreated: () => { queueSyncs += 1; }
});
assert.equal(superResult.campaign.status, "active");
assert.equal(superResult.strategy.status, "approved");
assert.equal(superResult.run.status, "queued");
assert.equal(superResult.superSearch?.status, "running");
assert.equal(superResult.superSearch?.currentRunId, superResult.run.id);
assert.equal(superResult.superSearch?.rounds?.length, 1);
assert.equal(superResult.superSearch?.acceptance?.outcome, "running");
assert.equal(queueSyncs, 2);

const superReplay = await launchLeadFinder({
  store,
  user: publicUser(owner),
  body: launchBody(
    "Aggregated super launch",
    "industrial process pump",
    "super"
  ),
  idempotencyKey: "lead-finder-launch-super-0001",
  onRunCreated: () => { queueSyncs += 1; }
});
assert.equal(superReplay.run.id, superResult.run.id);
assert.equal(superReplay.superSearch?.id, superResult.superSearch?.id);
assert.equal(superReplay.superSearch?.rounds?.length, 1);
assert.equal(superReplay.launchReplayed, true);
assert.equal(queueSyncs, 2);
assert.equal(generalMutationCalls, 0);
assert.ok(campaignMutationCalls >= 8);
assert.equal(executionMutationCalls, 2);
assert.equal(superSearchPersistenceCalls, 2);

const { app } = await import("./server.js");
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start lead finder launch HTTP test server");
}
const httpBody = launchBody(
  "Aggregated HTTP launch",
  "industrial control valve"
);
const requestHttpLaunch = async () => {
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/lead-finder/launch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${signToken(publicUser(owner))}`,
        "content-type": "application/json",
        "idempotency-key": "lead-finder-launch-http-0001"
      },
      body: JSON.stringify(httpBody)
    }
  );
  return {
    response,
    json: await response.json() as Record<string, any>
  };
};
try {
  const httpCreated = await requestHttpLaunch();
  assert.equal(httpCreated.response.status, 201);
  assert.ok(httpCreated.response.headers.get("server-timing")?.includes("total;dur="));
  assert.equal(httpCreated.response.headers.get("idempotency-replayed"), "false");
  assert.ok(String(httpCreated.json.run?.id || "").startsWith("pr_"));

  const httpReplay = await requestHttpLaunch();
  assert.equal(httpReplay.response.status, 200);
  assert.equal(httpReplay.response.headers.get("idempotency-replayed"), "true");
  assert.equal(httpReplay.json.run?.id, httpCreated.json.run?.id);
} finally {
  server.close();
}

console.log(JSON.stringify({
  ok: true,
  standardRunId: standard.run.id,
  superRunId: superResult.run.id,
  queueSyncs,
  campaignMutationCalls,
  executionMutationCalls,
  superSearchPersistenceCalls,
  httpRoute: true
}, null, 2));
