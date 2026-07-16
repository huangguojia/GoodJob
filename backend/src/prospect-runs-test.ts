import assert from "node:assert/strict";
import { decryptAgentJobPayload } from "./agent-job-security.js";
import {
  attachAgentJobIdempotencyAlias,
  cancelAgentJob,
  completeAgentJob,
  enqueueAgentJob,
  failAgentJob,
  publicAgentJob,
  recoverInterruptedAgentJobs,
  retryAgentJob,
  startAgentJob
} from "./agent-jobs.js";
import { publicUser, signToken } from "./auth.js";
import {
  activateProspectCampaign,
  createProspectCampaign,
  prospectCampaignEtag,
  transitionProspectCampaign
} from "./prospect-campaigns.js";
import { getProvider } from "./lead-providers.js";
import {
  approveProspectStrategy,
  prospectStrategyEtag,
  updateProspectStrategy
} from "./prospect-strategies.js";
import {
  createProspectRun,
  ProspectRunRequestError,
  transitionProspectRun,
  validateProspectRunSecurity
} from "./prospect-runs.js";
import {
  validateAllProspectRunQueueBridges,
  validateProspectRunQueueBridge
} from "./prospect-run-queue-bridge.js";
import { app } from "./server.js";
import {
  getStore,
  type PersistedStoreMutation
} from "./store.js";
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
let prospectExecutionMutationCalls = 0;

function installSerializedRunMutationHarness() {
  let tail: Promise<unknown> = Promise.resolve();
  const persistSerializedMutation = <T>(
    mutation: () => PersistedStoreMutation<T>
  ) => {
    const current = tail.then(async () => {
      const applied = mutation();
      try {
        const idempotencyScopes = new Set<string>();
        const activeScopes = new Set<string>();
        for (const run of store.prospectSearchRuns) {
          const idempotencyScope = [
            run.teamId,
            run.createdBy,
            run.operationCode,
            run.idempotencyKeyHash
          ].join("\u001f");
          if (idempotencyScopes.has(idempotencyScope)) {
            throw new Error("test duplicate run idempotency scope");
          }
          idempotencyScopes.add(idempotencyScope);
          if (run.status === "queued" || run.status === "paused") {
            const activeScope = [
              run.teamId,
              run.ownerId,
              run.queryFingerprint
            ].join("\u001f");
            if (activeScopes.has(activeScope)) {
              throw new Error("test duplicate active run scope");
            }
            activeScopes.add(activeScope);
          }
        }
        await store.persist();
        return applied.value;
      } catch (error) {
        applied.rollback();
        throw error;
      }
    });
    tail = current.catch(() => undefined);
    return current;
  };
  store.persistMutation = persistSerializedMutation;
  store.persistProspectExecutionMutation = <T>(
    mutation: () => PersistedStoreMutation<T>
  ) => {
    prospectExecutionMutationCalls += 1;
    return persistSerializedMutation(mutation);
  };
}

const original = {
  users: [...store.users],
  campaigns: [...store.prospectCampaigns],
  versions: [...store.prospectCampaignVersions],
  campaignEvents: [...store.prospectCampaignEvents],
  strategies: [...store.prospectStrategies],
  strategyEvents: [...store.prospectStrategyEvents],
  runs: [...store.prospectSearchRuns],
  shards: [...store.prospectRunShards],
  runEvents: [...store.prospectRunEvents],
  jobs: [...store.agentJobs],
  jobAliases: [...store.agentJobIdempotencyAliases],
  parentBindings: [...store.prospectRunQueueParentBindings],
  childBindings: [...store.prospectRunQueueChildBindings],
  persist: store.persist,
  persistMutation: store.persistMutation,
  persistProspectExecutionMutation: store.persistProspectExecutionMutation,
  reloadProspectRuns: store.reloadProspectRuns
};

const salesA = testUser("run_sales_a", "run_team_a", "sales");
const salesA2 = testUser("run_sales_a_2", "run_team_a", "sales");
const managerA = testUser("run_manager_a", "run_team_a", "manager");
const managerB = testUser("run_manager_b", "run_team_b", "manager");
const superAdmin = testUser("run_super", "all", "super_admin");
store.users.push(salesA, salesA2, managerA, managerB, superAdmin);
store.prospectCampaigns.splice(0);
store.prospectCampaignVersions.splice(0);
store.prospectCampaignEvents.splice(0);
store.prospectStrategies.splice(0);
store.prospectStrategyEvents.splice(0);
store.prospectSearchRuns.splice(0);
store.prospectRunShards.splice(0);
store.prospectRunEvents.splice(0);
store.agentJobs.splice(0);
store.agentJobIdempotencyAliases.splice(0);
store.prospectRunQueueParentBindings.splice(0);
store.prospectRunQueueChildBindings.splice(0);

const tokens = Object.fromEntries(
  [salesA, salesA2, managerA, managerB, superAdmin]
    .map((user) => [user.id, signToken(publicUser(user))])
);
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cannot start prospect run test server");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(input: {
  path: string;
  method?: string;
  user?: User | null;
  body?: unknown;
  ifMatch?: string;
  idempotencyKey?: string;
}) {
  const headers: Record<string, string> = {};
  if (input.user) headers.authorization = `Bearer ${tokens[input.user.id]}`;
  if (input.body !== undefined) headers["content-type"] = "application/json";
  if (input.ifMatch) headers["if-match"] = input.ifMatch;
  if (input.idempotencyKey) {
    headers["idempotency-key"] = input.idempotencyKey;
  }
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
  products: ["LED flood light"],
  markets: ["Germany"],
  customerTypes: ["Importer"],
  applicationScenarios: ["Warehouse project"],
  icpRules: ["Has an industrial lighting catalog"],
  exclusionRules: ["Consumer only"],
  sourceProviderIds: ["gleif"]
};

async function createReadyCampaign(input: {
  actor: User;
  ownerId?: string;
  name: string;
}) {
  const created = await createProspectCampaign({
    store,
    user: publicUser(input.actor),
    body: {
      name: input.name,
      ownerId: input.ownerId,
      snapshot: fullSnapshot
    },
    requestId: `${input.name}-campaign-create`
  });
  const strategy = store.prospectStrategies.find(
    (item) => item.campaignId === created.campaign.id
  )!;
  await updateProspectStrategy({
    store,
    user: publicUser(input.actor),
    strategyId: strategy.id,
    ifMatch: prospectStrategyEtag(strategy),
    body: {
      providerPlan: [{
        providerId: "gleif",
        priority: 10,
        pageLimit: 2,
        resultLimit: 50,
        budgetLimit: null,
        currency: ""
      }]
    },
    requestId: `${input.name}-strategy-update`
  });
  await approveProspectStrategy({
    store,
    user: publicUser(input.actor),
    strategyId: strategy.id,
    ifMatch: prospectStrategyEtag(strategy),
    requestId: `${input.name}-strategy-approve`
  });
  await activateProspectCampaign({
    store,
    user: publicUser(input.actor),
    campaignId: created.campaign.id,
    ifMatch: prospectCampaignEtag(created.campaign),
    requestId: `${input.name}-campaign-activate`
  });
  return {
    campaign: store.prospectCampaigns.find(
      (item) => item.id === created.campaign.id
    )!,
    strategy
  };
}

const gleif = getProvider("gleif");
assert.ok(gleif);
const originalGleifSearch = gleif.search;
let providerSearchCalls = 0;
gleif.search = async () => {
  providerSearchCalls += 1;
  throw new Error("Search Run control plane must not invoke Provider search");
};

try {
  const unready = await createProspectCampaign({
    store,
    user: publicUser(salesA),
    body: {
      name: "Unready Run Campaign",
      snapshot: fullSnapshot
    },
    requestId: "unready-run-campaign"
  });
  const unreadyStrategy = store.prospectStrategies.find(
    (item) => item.campaignId === unready.campaign.id
  )!;
  const unreadyResult = await request({
    path: `/api/prospect-strategies/${unreadyStrategy.id}/runs`,
    method: "POST",
    user: salesA,
    ifMatch: prospectStrategyEtag(unreadyStrategy),
    idempotencyKey: "run-unready-key-001",
    body: {}
  });
  assert.equal(unreadyResult.response.status, 422);
  assert.equal(unreadyResult.json.errorCode, "RUN_NOT_READY");
  const unreadyCodes = new Set(
    (unreadyResult.json.issues as Array<{ code: string }>).map(
      (issue) => issue.code
    )
  );
  assert.ok(unreadyCodes.has("CAMPAIGN_NOT_ACTIVE"));
  assert.ok(unreadyCodes.has("STRATEGY_NOT_APPROVED"));
  assert.ok(unreadyCodes.has("PROVIDERS_REQUIRED"));

  const main = await createReadyCampaign({
    actor: salesA,
    name: "Main Run Campaign"
  });
  const strategyEtag = prospectStrategyEtag(main.strategy);
  const campaignEtag = prospectCampaignEtag(main.campaign);
  const createPath = `/api/prospect-strategies/${main.strategy.id}/runs`;
  const createBody = { reason: "排队首轮公开数据搜索" };
  const createKey = "run-create-main-001";

  const anonymous = await request({ path: "/api/prospect-runs" });
  assert.equal(anonymous.response.status, 401);

  const superList = await request({
    path: "/api/prospect-runs",
    user: superAdmin
  });
  assert.equal(superList.response.status, 403);
  assert.equal(superList.json.errorCode, "RUN_ACCESS_FORBIDDEN");

  const otherSalesCreate = await request({
    path: createPath,
    method: "POST",
    user: salesA2,
    ifMatch: strategyEtag,
    idempotencyKey: "run-hidden-owner-001",
    body: {}
  });
  assert.equal(otherSalesCreate.response.status, 404);

  const crossTeamCreate = await request({
    path: createPath,
    method: "POST",
    user: managerB,
    ifMatch: strategyEtag,
    idempotencyKey: "run-cross-team-001",
    body: {}
  });
  assert.equal(crossTeamCreate.response.status, 404);
  assert.deepEqual(crossTeamCreate.json, otherSalesCreate.json);

  const missingKey = await request({
    path: createPath,
    method: "POST",
    user: salesA,
    ifMatch: strategyEtag,
    body: {}
  });
  assert.equal(missingKey.response.status, 400);
  assert.equal(missingKey.json.errorCode, "IDEMPOTENCY_KEY_REQUIRED");

  const missingIfMatch = await request({
    path: createPath,
    method: "POST",
    user: salesA,
    idempotencyKey: "run-missing-etag-001",
    body: {}
  });
  assert.equal(missingIfMatch.response.status, 428);
  assert.equal(missingIfMatch.json.errorCode, "PRECONDITION_REQUIRED");

  const created = await request({
    path: createPath,
    method: "POST",
    user: salesA,
    ifMatch: strategyEtag,
    idempotencyKey: createKey,
    body: createBody
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.response.headers.get("idempotency-replayed"), "false");
  assert.equal(created.json.executionMode, "control_plane_only_v1");
  assert.equal(created.json.executionAvailable, false);
  assert.equal(created.json.hasExecutionData, false);
  assert.equal(created.json.run.status, "queued");
  assert.equal(created.json.run.ownerId, salesA.id);
  assert.equal(created.json.shards.length, 1);
  assert.equal(created.json.shards[0].providerCode, "gleif");
  assert.equal(created.json.shards[0].hasCursor, false);
  assert.equal(created.json.events.length, 1);
  assert.equal(created.json.events[0].eventType, "created");
  assert.equal(created.json.teamDuplicateAssociation, null);
  assert.equal(providerSearchCalls, 0);
  assert.equal(store.prospectSearchRuns.length, 1);
  assert.equal(store.prospectRunShards.length, 1);
  assert.equal(store.prospectRunEvents.length, 1);
  assert.equal(store.prospectSearchRuns[0]?.queueBridgeVersion, "v1");
  assert.equal(store.prospectRunQueueParentBindings.length, 1);
  assert.equal(store.prospectRunQueueChildBindings.length, 1);
  assert.equal(store.agentJobs.length, 2);
  assert.equal(JSON.stringify(store.prospectSearchRuns).includes(createKey), false);
  const runId = created.json.run.id as string;
  const createRunEtag = created.response.headers.get("etag")!;
  const parentBinding = store.prospectRunQueueParentBindings[0]!;
  const childBinding = store.prospectRunQueueChildBindings[0]!;
  const parentJob = store.agentJobs.find(
    (item) => item.id === parentBinding.jobId
  )!;
  const childJob = store.agentJobs.find(
    (item) => item.id === childBinding.jobId
  )!;
  assert.equal(parentJob.jobType, "prospect.orchestrate");
  assert.equal(parentJob.parentJobId, "");
  assert.equal(parentJob.maxAttempts, 1);
  assert.equal(parentJob.nextAttemptAt, "");
  assert.equal(childJob.jobType, "prospect.provider.fetch");
  assert.equal(childJob.parentJobId, parentJob.id);
  assert.equal(childJob.maxAttempts, 3);
  assert.equal(childJob.nextAttemptAt, "");
  assert.equal(parentJob.teamId, salesA.teamId);
  assert.equal(parentJob.ownerId, salesA.id);
  assert.equal(childJob.teamId, salesA.teamId);
  assert.equal(childJob.ownerId, salesA.id);
  const parentPayload = decryptAgentJobPayload(
    parentJob,
    "input",
    parentJob.inputJsonEncrypted
  );
  const childPayload = decryptAgentJobPayload(
    childJob,
    "input",
    childJob.inputJsonEncrypted
  );
  assert.deepEqual(Object.keys(parentPayload).sort(), [
    "bridgeVersion",
    "executionSnapshotHash",
    "runId"
  ]);
  assert.deepEqual(Object.keys(childPayload).sort(), [
    "bridgeVersion",
    "executionSnapshotHash",
    "providerCode",
    "runId",
    "shardId"
  ]);
  assert.equal(parentPayload.runId, runId);
  assert.equal(childPayload.runId, runId);
  assert.equal(childPayload.shardId, created.json.shards[0].id);
  assert.equal(childPayload.providerCode, "gleif");
  assert.doesNotThrow(() => validateAllProspectRunQueueBridges(store));
  assert.throws(() => startAgentJob(parentJob), /通用任务入口/);
  assert.throws(
    () => completeAgentJob(parentJob),
    /通用任务入口/
  );
  assert.throws(
    () => failAgentJob(parentJob, "PROVIDER_TIMEOUT"),
    /通用任务入口/
  );
  assert.throws(() => retryAgentJob(parentJob), /通用任务入口/);
  assert.throws(() => cancelAgentJob(parentJob), /通用任务入口/);
  assert.throws(() => publicAgentJob(parentJob), /通用任务入口/);
  assert.throws(
    () => attachAgentJobIdempotencyAlias(
      store,
      parentJob,
      "forbidden-bridge-alias"
    ),
    /通用任务入口/
  );
  assert.throws(
    () => recoverInterruptedAgentJobs(store, "prospect.orchestrate"),
    /通用恢复入口/
  );
  assert.throws(() => enqueueAgentJob(store, {
    teamId: salesA.teamId,
    ownerId: salesA.id,
    jobType: "prospect.provider.fetch",
    aggregateType: "test",
    aggregateId: runId,
    idempotencyKey: "forbidden-bridge-enqueue"
  }), /仅允许由搜索运行桥接器创建/);

  const hiddenBridgeList = await request({
    path: `/api/prospect-agent-jobs?aggregateId=${runId}`,
    user: salesA
  });
  assert.equal(hiddenBridgeList.response.status, 200);
  assert.equal(hiddenBridgeList.json.total, 0);
  const hiddenBridgeDetail = await request({
    path: `/api/prospect-agent-jobs/${parentJob.id}`,
    user: salesA
  });
  assert.equal(hiddenBridgeDetail.response.status, 404);
  const hiddenBridgeRetry = await request({
    path: `/api/prospect-agent-jobs/${childJob.id}/retry`,
    method: "POST",
    user: salesA
  });
  assert.equal(hiddenBridgeRetry.response.status, 404);
  const hiddenBridgeCancel = await request({
    path: `/api/prospect-agent-jobs/${childJob.id}/cancel`,
    method: "POST",
    user: salesA
  });
  assert.equal(hiddenBridgeCancel.response.status, 404);

  const publicPayload = JSON.stringify(created.json);
  for (const forbidden of [
    "teamId",
    "idempotencyKeyHash",
    "requestHash",
    "executionSnapshotHash",
    "queueBridgeVersion",
    "queryFingerprint",
    "baseUrl",
    "apiKey"
  ]) {
    assert.equal(publicPayload.includes(forbidden), false);
  }

  const changedReplay = await request({
    path: createPath,
    method: "POST",
    user: salesA,
    ifMatch: strategyEtag,
    idempotencyKey: createKey,
    body: { reason: "不同请求" }
  });
  assert.equal(changedReplay.response.status, 409);
  assert.equal(changedReplay.json.errorCode, "IDEMPOTENCY_KEY_CONFLICT");

  const exactReplay = await request({
    path: createPath,
    method: "POST",
    user: salesA,
    ifMatch: strategyEtag,
    idempotencyKey: createKey,
    body: createBody
  });
  assert.equal(exactReplay.response.status, 200);
  assert.equal(exactReplay.response.headers.get("idempotency-replayed"), "true");
  assert.equal(exactReplay.json.run.id, runId);
  assert.equal(store.prospectSearchRuns.length, 1);
  assert.equal(store.agentJobs.length, 2);
  assert.equal(store.prospectRunQueueParentBindings.length, 1);
  assert.equal(store.prospectRunQueueChildBindings.length, 1);

  const originalParentIdempotencyKey = parentJob.idempotencyKey;
  parentJob.idempotencyKey = "0".repeat(64);
  const integrityBlockedReplay = await request({
    path: createPath,
    method: "POST",
    user: salesA,
    ifMatch: strategyEtag,
    idempotencyKey: createKey,
    body: createBody
  });
  assert.equal(integrityBlockedReplay.response.status, 409);
  assert.equal(
    integrityBlockedReplay.json.errorCode,
    "RUN_QUEUE_BRIDGE_INTEGRITY_INVALID"
  );
  parentJob.idempotencyKey = originalParentIdempotencyKey;

  const originalTraceId = parentJob.traceId;
  parentJob.traceId = "trace_x";
  assert.throws(
    () => validateProspectRunQueueBridge(store, store.prospectSearchRuns[0]!),
    /任务字段完整性校验失败/
  );
  parentJob.traceId = originalTraceId;

  const originalChildPayload = childJob.inputJsonEncrypted;
  childJob.inputJsonEncrypted = `${originalChildPayload.slice(0, -1)}x`;
  const payloadTamperDetail = await request({
    path: `/api/prospect-runs/${runId}`,
    user: salesA
  });
  assert.equal(payloadTamperDetail.response.status, 409);
  assert.equal(
    payloadTamperDetail.json.errorCode,
    "RUN_QUEUE_BRIDGE_INTEGRITY_INVALID"
  );
  childJob.inputJsonEncrypted = originalChildPayload;

  childJob.status = "running";
  const integrityBlockedPause = await request({
    path: `/api/prospect-runs/${runId}/pause`,
    method: "POST",
    user: salesA,
    ifMatch: createRunEtag,
    body: {}
  });
  assert.equal(integrityBlockedPause.response.status, 409);
  assert.equal(
    integrityBlockedPause.json.errorCode,
    "RUN_QUEUE_BRIDGE_INTEGRITY_INVALID"
  );
  assert.equal(store.prospectSearchRuns[0]?.status, "queued");
  assert.equal(store.prospectRunEvents.length, 1);
  childJob.status = "queued";

  const paused = await request({
    path: `/api/prospect-runs/${runId}/pause`,
    method: "POST",
    user: salesA,
    ifMatch: createRunEtag,
    body: { reason: "人工暂停" }
  });
  assert.equal(paused.response.status, 200);
  assert.equal(paused.json.run.status, "paused");
  assert.equal(paused.json.shards[0].status, "paused");
  assert.equal(parentJob.status, "queued");
  assert.equal(childJob.status, "queued");

  const replayAfterPause = await request({
    path: createPath,
    method: "POST",
    user: salesA,
    ifMatch: strategyEtag,
    idempotencyKey: createKey,
    body: createBody
  });
  assert.equal(replayAfterPause.response.status, 200);
  assert.equal(replayAfterPause.json.run.status, "paused");
  assert.equal(
    replayAfterPause.response.headers.get("etag"),
    paused.response.headers.get("etag")
  );

  const staleResume = await request({
    path: `/api/prospect-runs/${runId}/resume`,
    method: "POST",
    user: salesA,
    ifMatch: createRunEtag,
    body: {}
  });
  assert.equal(staleResume.response.status, 412);

  const resumed = await request({
    path: `/api/prospect-runs/${runId}/resume`,
    method: "POST",
    user: salesA,
    ifMatch: paused.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.json.run.status, "queued");

  const transferBlocked = await request({
    path: `/api/prospect-campaigns/${main.campaign.id}`,
    method: "PATCH",
    user: managerA,
    ifMatch: campaignEtag,
    body: { ownerId: salesA2.id }
  });
  assert.equal(transferBlocked.response.status, 409);
  assert.equal(transferBlocked.json.errorCode, "CAMPAIGN_ACTIVE_RUNS");

  const versionBlocked = await request({
    path: `/api/prospect-campaigns/${main.campaign.id}/versions`,
    method: "POST",
    user: salesA,
    ifMatch: campaignEtag,
    body: {
      snapshot: { markets: ["France"] },
      changeSummary: "活动运行期间变更市场"
    }
  });
  assert.equal(versionBlocked.response.status, 409);
  assert.equal(versionBlocked.json.errorCode, "CAMPAIGN_ACTIVE_RUNS");

  const disableBlocked = await request({
    path: `/api/prospect-strategies/${main.strategy.id}/disable`,
    method: "POST",
    user: salesA,
    ifMatch: strategyEtag,
    body: {}
  });
  assert.equal(disableBlocked.response.status, 409);
  assert.equal(disableBlocked.json.errorCode, "STRATEGY_ACTIVE_RUNS");

  const completeBlocked = await request({
    path: `/api/prospect-campaigns/${main.campaign.id}/complete`,
    method: "POST",
    user: salesA,
    ifMatch: campaignEtag,
    body: {}
  });
  assert.equal(completeBlocked.response.status, 409);
  assert.equal(completeBlocked.json.errorCode, "CAMPAIGN_ACTIVE_RUNS");

  store.prospectRunShards[0]!.status = "paused";
  const shardStateBlockedCampaignPause = await request({
    path: `/api/prospect-campaigns/${main.campaign.id}/pause`,
    method: "POST",
    user: salesA,
    ifMatch: campaignEtag,
    body: { reason: "分片状态异常时禁止暂停项目" }
  });
  assert.equal(shardStateBlockedCampaignPause.response.status, 409);
  assert.equal(
    shardStateBlockedCampaignPause.json.errorCode,
    "RUN_QUEUE_BRIDGE_INTEGRITY_INVALID"
  );
  store.prospectRunShards[0]!.status = "queued";

  const campaignPaused = await request({
    path: `/api/prospect-campaigns/${main.campaign.id}/pause`,
    method: "POST",
    user: salesA,
    ifMatch: campaignEtag,
    body: { reason: "暂停项目复核目标市场" }
  });
  assert.equal(campaignPaused.response.status, 200);
  assert.equal(store.prospectSearchRuns[0]?.status, "paused");
  assert.equal(store.prospectRunShards[0]?.status, "paused");
  assert.equal(store.prospectRunEvents.at(-1)?.requestId.length! > 0, true);
  const campaignPauseRunEvent = store.prospectRunEvents.at(-1)!;
  const campaignPauseEvent = store.prospectCampaignEvents.at(-1)!;
  assert.equal(campaignPauseRunEvent.requestId, campaignPauseEvent.requestId);

  const reactivated = await request({
    path: `/api/prospect-campaigns/${main.campaign.id}/activate`,
    method: "POST",
    user: salesA,
    ifMatch: campaignPaused.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(reactivated.response.status, 200);
  assert.equal(store.prospectSearchRuns[0]?.status, "paused");

  const runAfterCampaignPause = await request({
    path: `/api/prospect-runs/${runId}`,
    user: salesA
  });
  const resumedAfterActivation = await request({
    path: `/api/prospect-runs/${runId}/resume`,
    method: "POST",
    user: salesA,
    ifMatch: runAfterCampaignPause.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(resumedAfterActivation.response.status, 200);
  assert.equal(resumedAfterActivation.json.run.status, "queued");

  const cancelled = await request({
    path: `/api/prospect-runs/${runId}/cancel`,
    method: "POST",
    user: salesA,
    ifMatch: resumedAfterActivation.response.headers.get("etag")!,
    body: { reason: "结束控制平面验证" }
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.json.run.status, "cancelled");
  assert.equal(cancelled.json.shards[0].status, "cancelled");
  assert.equal(parentJob.status, "cancelled");
  assert.equal(childJob.status, "cancelled");
  assert.deepEqual(
    cancelled.json.events.map((event: { sequence: number }) => event.sequence),
    [1, 2, 3, 4, 5, 6]
  );

  const terminalCancel = await request({
    path: `/api/prospect-runs/${runId}/cancel`,
    method: "POST",
    user: salesA,
    ifMatch: cancelled.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(terminalCancel.response.status, 409);
  assert.equal(terminalCancel.json.errorCode, "RUN_STATE_INVALID");

  const transferred = await request({
    path: `/api/prospect-campaigns/${main.campaign.id}`,
    method: "PATCH",
    user: managerA,
    ifMatch: reactivated.response.headers.get("etag")!,
    body: { ownerId: salesA2.id, reason: "转交后续项目" }
  });
  assert.equal(transferred.response.status, 200);
  assert.equal(store.prospectSearchRuns[0]?.ownerId, salesA.id);

  const oldOwnerHistory = await request({
    path: `/api/prospect-runs/${runId}`,
    user: salesA
  });
  assert.equal(oldOwnerHistory.response.status, 404);

  const newOwnerHistory = await request({
    path: `/api/prospect-runs/${runId}`,
    user: salesA2
  });
  assert.equal(newOwnerHistory.response.status, 200);
  assert.equal(newOwnerHistory.json.run.ownerId, salesA.id);

  const oldOwnerReplay = await request({
    path: createPath,
    method: "POST",
    user: salesA,
    ifMatch: strategyEtag,
    idempotencyKey: createKey,
    body: createBody
  });
  assert.equal(oldOwnerReplay.response.status, 404);

  const currentStrategyEtag = prospectStrategyEtag(main.strategy);
  const secondRun = await request({
    path: createPath,
    method: "POST",
    user: salesA2,
    ifMatch: currentStrategyEtag,
    idempotencyKey: "run-create-new-owner-001",
    body: {}
  });
  assert.equal(secondRun.response.status, 201);
  assert.equal(secondRun.json.run.ownerId, salesA2.id);
  const secondRunId = secondRun.json.run.id as string;

  const firstPage = await request({
    path: "/api/prospect-runs?limit=1",
    user: salesA2
  });
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.json.total, 2);
  assert.equal(firstPage.json.pageCount, 1);
  assert.equal(firstPage.json.hasMore, true);
  assert.ok(firstPage.json.nextCursor);

  const secondPage = await request({
    path: `/api/prospect-runs?limit=1&cursor=${encodeURIComponent(
      firstPage.json.nextCursor
    )}`,
    user: salesA2
  });
  assert.equal(secondPage.response.status, 200);
  assert.equal(secondPage.json.pageCount, 1);
  assert.notEqual(secondPage.json.runs[0].id, firstPage.json.runs[0].id);

  const tamperedCursor = `${firstPage.json.nextCursor.slice(0, -1)}x`;
  const tampered = await request({
    path: `/api/prospect-runs?limit=1&cursor=${encodeURIComponent(
      tamperedCursor
    )}`,
    user: salesA2
  });
  assert.equal(tampered.response.status, 400);
  assert.equal(tampered.json.errorCode, "RUN_CURSOR_INVALID");

  const otherScopeCursor = await request({
    path: `/api/prospect-runs?limit=1&cursor=${encodeURIComponent(
      firstPage.json.nextCursor
    )}`,
    user: managerA
  });
  assert.equal(otherScopeCursor.response.status, 400);
  assert.equal(otherScopeCursor.json.errorCode, "RUN_CURSOR_INVALID");

  const crossTeamList = await request({
    path: "/api/prospect-runs",
    user: managerB
  });
  assert.equal(crossTeamList.response.status, 200);
  assert.equal(crossTeamList.json.total, 0);

  const salesDuplicate = await createReadyCampaign({
    actor: salesA,
    name: "Same Fingerprint Sales Campaign"
  });
  const salesDuplicateRun = await request({
    path: `/api/prospect-strategies/${salesDuplicate.strategy.id}/runs`,
    method: "POST",
    user: salesA,
    ifMatch: prospectStrategyEtag(salesDuplicate.strategy),
    idempotencyKey: "run-sales-no-side-channel-001",
    body: {}
  });
  assert.equal(salesDuplicateRun.response.status, 201);
  assert.equal(salesDuplicateRun.json.teamDuplicateAssociation, null);

  const cancelledSalesDuplicate = await request({
    path: `/api/prospect-runs/${salesDuplicateRun.json.run.id}/cancel`,
    method: "POST",
    user: salesA,
    ifMatch: salesDuplicateRun.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(cancelledSalesDuplicate.response.status, 200);

  const managerDuplicateRun = await request({
    path: `/api/prospect-strategies/${salesDuplicate.strategy.id}/runs`,
    method: "POST",
    user: managerA,
    ifMatch: prospectStrategyEtag(salesDuplicate.strategy),
    idempotencyKey: "run-manager-team-association-001",
    body: {}
  });
  assert.equal(managerDuplicateRun.response.status, 201);
  assert.equal(managerDuplicateRun.json.teamDuplicateAssociation.exists, true);
  assert.equal(
    managerDuplicateRun.json.teamDuplicateAssociation.runId,
    secondRunId
  );

  const crossTeam = await createReadyCampaign({
    actor: managerB,
    name: "Cross Team Same Fingerprint"
  });
  const crossTeamRun = await request({
    path: `/api/prospect-strategies/${crossTeam.strategy.id}/runs`,
    method: "POST",
    user: managerB,
    ifMatch: prospectStrategyEtag(crossTeam.strategy),
    idempotencyKey: "run-cross-team-no-association-001",
    body: {}
  });
  assert.equal(crossTeamRun.response.status, 201);
  assert.equal(crossTeamRun.json.teamDuplicateAssociation, null);

  const cancelledCrossTeam = await request({
    path: `/api/prospect-runs/${crossTeamRun.json.run.id}/cancel`,
    method: "POST",
    user: managerB,
    ifMatch: crossTeamRun.response.headers.get("etag")!,
    body: {}
  });
  assert.equal(cancelledCrossTeam.response.status, 200);

  installSerializedRunMutationHarness();
  const executionMutationCallsBeforeCreate =
    prospectExecutionMutationCalls;

  const sameStoreCampaign = await createReadyCampaign({
    actor: managerB,
    name: "Same Store Concurrent Run"
  });
  const sameStoreKey = "run-same-store-concurrent-001";
  const sameStoreRequests = await Promise.all([
    createProspectRun({
      store,
      user: publicUser(managerB),
      strategyId: sameStoreCampaign.strategy.id,
      ifMatch: prospectStrategyEtag(sameStoreCampaign.strategy),
      idempotencyKey: sameStoreKey,
      body: { reason: "同实例并发幂等创建" },
      requestId: "run-same-store-concurrent-a"
    }),
    createProspectRun({
      store,
      user: publicUser(managerB),
      strategyId: sameStoreCampaign.strategy.id,
      ifMatch: prospectStrategyEtag(sameStoreCampaign.strategy),
      idempotencyKey: sameStoreKey,
      body: { reason: "同实例并发幂等创建" },
      requestId: "run-same-store-concurrent-b"
    })
  ]);
  const sameStoreCreated = sameStoreRequests.find(
    (item) => !item.idempotencyReplayed
  )!;
  const sameStoreReplayed = sameStoreRequests.find(
    (item) => item.idempotencyReplayed
  )!;
  assert.ok(sameStoreCreated);
  assert.ok(sameStoreReplayed);
  assert.equal(sameStoreCreated.run.id, sameStoreReplayed.run.id);
  assert.equal(
    store.prospectSearchRuns.filter(
      (item) => item.campaignId === sameStoreCampaign.campaign.id
    ).length,
    1
  );
  await transitionProspectRun({
    store,
    user: publicUser(managerB),
    runId: sameStoreCreated.run.id,
    ifMatch: `"${sameStoreCreated.run.id}:${sameStoreCreated.run.revision}"`,
    action: "cancel",
    body: { reason: "结束同实例幂等验证" },
    requestId: "run-same-store-cancel"
  });

  const differentKeyResults = await Promise.allSettled([
    createProspectRun({
      store,
      user: publicUser(managerB),
      strategyId: sameStoreCampaign.strategy.id,
      ifMatch: prospectStrategyEtag(sameStoreCampaign.strategy),
      idempotencyKey: "run-same-store-active-a",
      body: { reason: "同指纹异键并发 A" },
      requestId: "run-same-store-active-a"
    }),
    createProspectRun({
      store,
      user: publicUser(managerB),
      strategyId: sameStoreCampaign.strategy.id,
      ifMatch: prospectStrategyEtag(sameStoreCampaign.strategy),
      idempotencyKey: "run-same-store-active-b",
      body: { reason: "同指纹异键并发 B" },
      requestId: "run-same-store-active-b"
    })
  ]);
  const differentKeyCreated = differentKeyResults.find(
    (item): item is PromiseFulfilledResult<
      Awaited<ReturnType<typeof createProspectRun>>
    > => item.status === "fulfilled"
  );
  const differentKeyRejected = differentKeyResults.find(
    (item): item is PromiseRejectedResult => item.status === "rejected"
  );
  assert.ok(differentKeyCreated);
  assert.ok(differentKeyRejected);
  assert.equal(
    differentKeyRejected.reason instanceof ProspectRunRequestError,
    true
  );
  assert.equal(differentKeyRejected.reason.code, "ACTIVE_RUN_EXISTS");
  await transitionProspectRun({
    store,
    user: publicUser(managerB),
    runId: differentKeyCreated.value.run.id,
    ifMatch: `"${differentKeyCreated.value.run.id}:${
      differentKeyCreated.value.run.revision
    }"`,
    action: "cancel",
    body: { reason: "结束同指纹并发验证" },
    requestId: "run-same-store-active-cancel"
  });

  const pauseRaceCampaign = await createReadyCampaign({
    actor: managerB,
    name: "Campaign Pause Create Race"
  });
  const pauseCreateResults = await Promise.allSettled([
    transitionProspectCampaign({
      store,
      user: publicUser(managerB),
      campaignId: pauseRaceCampaign.campaign.id,
      ifMatch: prospectCampaignEtag(pauseRaceCampaign.campaign),
      targetStatus: "paused",
      reason: "并发暂停项目",
      requestId: "run-pause-create-race-pause"
    }),
    createProspectRun({
      store,
      user: publicUser(managerB),
      strategyId: pauseRaceCampaign.strategy.id,
      ifMatch: prospectStrategyEtag(pauseRaceCampaign.strategy),
      idempotencyKey: "run-pause-create-race-001",
      body: { reason: "与项目暂停交错创建" },
      requestId: "run-pause-create-race-create"
    })
  ]);
  assert.equal(pauseCreateResults[0]?.status, "fulfilled");
  assert.equal(pauseCreateResults[1]?.status, "rejected");
  const pauseCreateError = (
    pauseCreateResults[1] as PromiseRejectedResult
  ).reason;
  assert.equal(pauseCreateError instanceof ProspectRunRequestError, true);
  assert.equal(pauseCreateError.code, "RUN_NOT_READY");
  assert.equal(
    (pauseCreateError.details.issues as Array<{ code: string }>).some(
      (item) => item.code === "CAMPAIGN_NOT_ACTIVE"
    ),
    true
  );
  assert.equal(
    store.prospectSearchRuns.some(
      (item) => item.campaignId === pauseRaceCampaign.campaign.id
    ),
    false
  );
  assert.ok(
    prospectExecutionMutationCalls > executionMutationCallsBeforeCreate
  );
  store.persistMutation = original.persistMutation;
  store.persistProspectExecutionMutation =
    original.persistProspectExecutionMutation;

  const lengthsBeforeRollback = {
    runs: store.prospectSearchRuns.length,
    shards: store.prospectRunShards.length,
    events: store.prospectRunEvents.length,
    jobs: store.agentJobs.length,
    aliases: store.agentJobIdempotencyAliases.length,
    parentBindings: store.prospectRunQueueParentBindings.length,
    childBindings: store.prospectRunQueueChildBindings.length
  };
  store.persistMutation = undefined;
  store.persistProspectExecutionMutation = undefined;
  store.persist = async () => {
    throw new Error("forced persistence failure");
  };
  await assert.rejects(
    createProspectRun({
      store,
      user: publicUser(managerB),
      strategyId: crossTeam.strategy.id,
      ifMatch: prospectStrategyEtag(crossTeam.strategy),
      idempotencyKey: "run-rollback-check-001",
      body: {},
      requestId: "run-rollback-check"
    }),
    /forced persistence failure/
  );
  assert.deepEqual({
    runs: store.prospectSearchRuns.length,
    shards: store.prospectRunShards.length,
    events: store.prospectRunEvents.length,
    jobs: store.agentJobs.length,
    aliases: store.agentJobIdempotencyAliases.length,
    parentBindings: store.prospectRunQueueParentBindings.length,
    childBindings: store.prospectRunQueueChildBindings.length
  }, lengthsBeforeRollback);
  store.persist = original.persist;
  store.persistMutation = original.persistMutation;
  store.persistProspectExecutionMutation =
    original.persistProspectExecutionMutation;

  const document = createOpenApiDocument(app) as {
    paths: Record<string, Record<string, {
      description?: string;
      parameters?: Array<{ name: string; in: string; required?: boolean }>;
      responses?: Record<string, unknown>;
    }>>;
  };
  const createRunDoc =
    document.paths["/api/prospect-strategies/{id}/runs"]?.post;
  assert.ok(createRunDoc);
  assert.match(createRunDoc.description || "", /control_plane_only_v1/);
  assert.ok(createRunDoc.parameters?.some(
    (item) => item.name === "If-Match" && item.required
  ));
  assert.ok(createRunDoc.parameters?.some(
    (item) => item.name === "Idempotency-Key" && item.required
  ));
  assert.ok(createRunDoc.responses?.["201"]);
  assert.ok(createRunDoc.responses?.["422"]);
  const runListDoc = document.paths["/api/prospect-runs"]?.get;
  assert.ok(runListDoc?.parameters?.some((item) => item.name === "cursor"));
  assert.equal(
    JSON.stringify(document).includes("prospect.orchestrate"),
    false
  );
  assert.equal(
    JSON.stringify(document).includes("prospect.provider.fetch"),
    false
  );

  const legacyRun = {
    ...structuredClone(store.prospectSearchRuns[0]!),
    id: "pr_00000000-0000-4000-8000-000000000001",
    queueBridgeVersion: null
  };
  store.prospectSearchRuns.push(legacyRun);
  assert.deepEqual(
    validateProspectRunQueueBridge(store, legacyRun),
    { parentJob: null, childJobs: [] }
  );
  assert.equal(
    store.prospectRunQueueParentBindings.some(
      (item) => item.runId === legacyRun.id
    ),
    false
  );
  assert.equal(
    store.prospectRunQueueChildBindings.some(
      (item) => item.runId === legacyRun.id
    ),
    false
  );
  store.prospectSearchRuns.pop();

  const previousNodeEnv = process.env.NODE_ENV;
  const previousIdempotencySecret =
    process.env.PROSPECT_RUN_IDEMPOTENCY_SECRET;
  const previousCursorSecret = process.env.PROSPECT_RUN_CURSOR_SECRET;
  process.env.NODE_ENV = "production";
  delete process.env.PROSPECT_RUN_IDEMPOTENCY_SECRET;
  delete process.env.PROSPECT_RUN_CURSOR_SECRET;
  assert.throws(validateProspectRunSecurity, /IDEMPOTENCY_SECRET/);
  process.env.PROSPECT_RUN_IDEMPOTENCY_SECRET = "i".repeat(32);
  assert.throws(validateProspectRunSecurity, /CURSOR_SECRET/);
  process.env.PROSPECT_RUN_CURSOR_SECRET = "c".repeat(32);
  assert.doesNotThrow(validateProspectRunSecurity);
  process.env.NODE_ENV = previousNodeEnv;
  if (previousIdempotencySecret === undefined) {
    delete process.env.PROSPECT_RUN_IDEMPOTENCY_SECRET;
  } else {
    process.env.PROSPECT_RUN_IDEMPOTENCY_SECRET = previousIdempotencySecret;
  }
  if (previousCursorSecret === undefined) {
    delete process.env.PROSPECT_RUN_CURSOR_SECRET;
  } else {
    process.env.PROSPECT_RUN_CURSOR_SECRET = previousCursorSecret;
  }

  assert.equal(providerSearchCalls, 0);
  console.log("Prospect Run control plane tests passed");
} finally {
  gleif.search = originalGleifSearch;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  store.users.splice(0, store.users.length, ...original.users);
  store.prospectCampaigns.splice(0, store.prospectCampaigns.length, ...original.campaigns);
  store.prospectCampaignVersions.splice(0, store.prospectCampaignVersions.length, ...original.versions);
  store.prospectCampaignEvents.splice(0, store.prospectCampaignEvents.length, ...original.campaignEvents);
  store.prospectStrategies.splice(0, store.prospectStrategies.length, ...original.strategies);
  store.prospectStrategyEvents.splice(0, store.prospectStrategyEvents.length, ...original.strategyEvents);
  store.prospectSearchRuns.splice(0, store.prospectSearchRuns.length, ...original.runs);
  store.prospectRunShards.splice(0, store.prospectRunShards.length, ...original.shards);
  store.prospectRunEvents.splice(0, store.prospectRunEvents.length, ...original.runEvents);
  store.agentJobs.splice(0, store.agentJobs.length, ...original.jobs);
  store.agentJobIdempotencyAliases.splice(
    0,
    store.agentJobIdempotencyAliases.length,
    ...original.jobAliases
  );
  store.prospectRunQueueParentBindings.splice(
    0,
    store.prospectRunQueueParentBindings.length,
    ...original.parentBindings
  );
  store.prospectRunQueueChildBindings.splice(
    0,
    store.prospectRunQueueChildBindings.length,
    ...original.childBindings
  );
  store.persist = original.persist;
  store.persistMutation = original.persistMutation;
  store.persistProspectExecutionMutation =
    original.persistProspectExecutionMutation;
  store.reloadProspectRuns = original.reloadProspectRuns;
}
