import assert from "node:assert/strict";
import {
  decryptAgentJobPayload,
  encryptAgentJobPayload
} from "./agent-job-security.js";
import { publicUser, signToken } from "./auth.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import { app } from "./server.js";
import { getStore } from "./store.js";
import type { PersistedStoreMutation } from "./store.js";
import { createOpenApiDocument } from "./swagger.js";
import type { User } from "./types.js";

function testUser(id: string, teamId: string): User {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    password: "test-only",
    role: "sales",
    teamId,
    avatar: id.slice(0, 2).toUpperCase(),
    status: "active",
    authVersion: 1
  };
}

const store = getStore();
const teamAUser = testUser("market_run_sales_a", "market_run_team_a");
const teamAUser2 = testUser("market_run_sales_a_2", "market_run_team_a");
const teamBUser = testUser("market_run_sales_b", "market_run_team_b");
store.users.push(teamAUser, teamAUser2, teamBUser);
store.agentJobs.splice(0);
store.agentJobIdempotencyAliases.splice(0);
store.providerRequestLogs.splice(0);
store.providerResponseCache.splice(0);
store.marketTradeObservations.splice(0);

const tokenA = signToken(publicUser(teamAUser));
const tokenA2 = signToken(publicUser(teamAUser2));
const tokenB = signToken(publicUser(teamBUser));
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start market analysis test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

const baseBody = {
  providerId: "un_comtrade",
  reporterCodes: ["842"],
  partnerCodes: ["0"],
  flow: "import",
  hsVersion: "HS2022",
  commodityCodes: ["940542"],
  periods: ["2023"],
  frequency: "annual",
  limit: 5
};

const baseQuerySummary = {
  reporterCodes: baseBody.reporterCodes,
  partnerCodes: baseBody.partnerCodes,
  flow: baseBody.flow,
  hsVersion: baseBody.hsVersion,
  commodityCodes: baseBody.commodityCodes,
  periods: baseBody.periods,
  frequency: baseBody.frequency,
  limit: baseBody.limit
};

async function request(
  token: string | null,
  idempotencyKey: string | null,
  body: Record<string, unknown> = baseBody
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`${baseUrl}/api/prospect-campaigns/campaign_shared/market-analysis-runs`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  return {
    response,
    json: await response.json().catch(() => ({}))
  };
}

let externalRequests = 0;
setProviderHttpTestTransport(async () => {
  externalRequests += 1;
  return new Response(JSON.stringify({
    count: 1,
    data: [{
      reporterCode: 842,
      reporterISO: "USA",
      partnerCode: 0,
      partnerDesc: "World",
      flowCode: "M",
      classificationCode: "H7",
      classificationSearchCode: "HS",
      cmdCode: "940542",
      period: "2023",
      primaryValue: 1000000,
      netWgt: 12000,
      qty: 12000,
      qtyUnitAbbr: "kg",
      isAggregate: true,
      isReported: true
    }]
  }), { status: 200 });
});

try {
  const anonymous = await request(null, "market-run-anonymous");
  assert.equal(anonymous.response.status, 401);

  const missingIdempotency = await request(tokenA, null);
  assert.equal(missingIdempotency.response.status, 400);
  assert.equal(missingIdempotency.json.errorCode, "IDEMPOTENCY_KEY_REQUIRED");

  const ownerInjection = await request(tokenA, "market-run-injection", {
    ...baseBody,
    ownerId: teamBUser.id,
    teamId: teamBUser.teamId
  });
  assert.equal(ownerInjection.response.status, 400);
  assert.equal(store.agentJobs.length, 0);

  const teamAFirst = await request(tokenA, "market-run-shared-key");
  assert.equal(teamAFirst.response.status, 201);
  assert.equal(teamAFirst.json.duplicate, false);
  assert.equal(teamAFirst.json.campaignContractMode, "compat_v1");
  assert.equal(teamAFirst.json.campaignScope, "owner");
  assert.equal(teamAFirst.json.executionMode, "inline_single_instance_v1");
  assert.equal(teamAFirst.json.retryMode, "manual");
  assert.equal(teamAFirst.json.autoRetryScheduled, false);
  assert.equal(teamAFirst.json.job.status, "succeeded");
  assert.equal(teamAFirst.json.job.aggregateType, "prospect_campaign_ref_compat_v1");
  assert.equal(
    teamAFirst.response.headers.get("location"),
    `/api/prospect-agent-jobs/${teamAFirst.json.job.id}`
  );
  assert.equal(teamAFirst.json.job.ownerId, teamAUser.id);
  assert.equal(teamAFirst.json.job.teamId, teamAUser.teamId);
  assert.equal(teamAFirst.json.result.resultScope, "job_execution");
  assert.equal(teamAFirst.json.result.createdCount, 1);
  assert.deepEqual(teamAFirst.json.result.querySummary, baseQuerySummary);
  assert.equal(teamAFirst.json.result.observations.length, 1);
  assert.equal(teamAFirst.json.result.observations[0].providerId, "un_comtrade");
  assert.equal(teamAFirst.json.result.observations[0].reporterCode, "842");
  assert.equal(teamAFirst.json.result.observations[0].partnerCode, "0");
  assert.equal(teamAFirst.json.result.observations[0].commodityCode, "940542");
  assert.equal(teamAFirst.json.result.observations[0].period, "2023");
  assert.equal(teamAFirst.json.result.observations[0].tradeValueUsd, 1000000);
  assert.equal(teamAFirst.json.result.observations[0].adapterVersion, "1.1.0");
  assert.equal("teamId" in teamAFirst.json.result.observations[0], false);
  assert.equal("ownerId" in teamAFirst.json.result.observations[0], false);
  assert.equal("campaignId" in teamAFirst.json.result.observations[0], false);
  assert.equal("payloadHash" in teamAFirst.json.result.observations[0], false);
  assert.equal("rawRecordId" in teamAFirst.json.result.observations[0], false);
  assert.equal(externalRequests, 1);
  assert.equal(store.agentJobs.length, 1);
  assert.equal(store.providerRequestLogs.length, 1);
  assert.equal(store.marketTradeObservations.length, 1);
  assert.equal(store.marketTradeObservations[0]?.ownerId, teamAUser.id);
  assert.equal(store.marketTradeObservations[0]?.teamId, teamAUser.teamId);

  const teamALogCount = store.providerRequestLogs.length;
  const teamADuplicate = await request(tokenA, "market-run-shared-key");
  assert.equal(teamADuplicate.response.status, 200);
  assert.equal(teamADuplicate.json.duplicate, true);
  assert.equal(teamADuplicate.json.job.id, teamAFirst.json.job.id);
  assert.equal(teamADuplicate.json.result.resultScope, "job_execution");
  assert.equal(teamADuplicate.json.result.createdCount, 1);
  assert.deepEqual(
    teamADuplicate.json.result.querySummary,
    teamAFirst.json.result.querySummary
  );
  assert.deepEqual(
    teamADuplicate.json.result.observations,
    teamAFirst.json.result.observations
  );
  assert.equal(externalRequests, 1);
  assert.equal(store.agentJobs.length, 1);
  assert.equal(store.providerRequestLogs.length, teamALogCount);

  const teamAJob = store.agentJobs.find((item) => item.id === teamAFirst.json.job.id);
  assert.ok(teamAJob);
  const validEncryptedOutput = teamAJob.outputJsonEncrypted;
  const validOutput = decryptAgentJobPayload(
    teamAJob,
    "output",
    teamAJob.outputJsonEncrypted
  );
  teamAJob.outputJsonEncrypted = encryptAgentJobPayload(teamAJob, "output", {
    ...validOutput,
    createdCount: -1,
    usage: {
      ...(validOutput.usage as Record<string, unknown>),
      ownerId: teamBUser.id
    }
  });
  const invalidHistoricalReplay = await request(tokenA, "market-run-shared-key");
  assert.equal(invalidHistoricalReplay.response.status, 200);
  assert.equal(invalidHistoricalReplay.json.duplicate, true);
  assert.equal(invalidHistoricalReplay.json.result, null);
  assert.equal(JSON.stringify(invalidHistoricalReplay.json).includes(teamBUser.id), false);
  teamAJob.outputJsonEncrypted = validEncryptedOutput;

  const teamA2First = await request(tokenA2, "market-run-shared-key");
  assert.equal(teamA2First.response.status, 201);
  assert.equal(teamA2First.json.duplicate, false);
  assert.equal(teamA2First.json.job.ownerId, teamAUser2.id);
  assert.equal(teamA2First.json.job.teamId, teamAUser2.teamId);
  assert.equal(teamA2First.json.result.cacheStatus, "cache");
  assert.equal(externalRequests, 1);
  assert.equal(store.marketTradeObservations.length, 2);
  assert.equal(
    store.marketTradeObservations.filter((item) =>
      item.teamId === teamAUser.teamId && item.ownerId === teamAUser.id
    ).length,
    1
  );
  assert.equal(
    store.marketTradeObservations.filter((item) =>
      item.teamId === teamAUser2.teamId && item.ownerId === teamAUser2.id
    ).length,
    1
  );

  const conflictingReuse = await request(tokenA, "market-run-shared-key", {
    ...baseBody,
    periods: ["2022"]
  });
  assert.equal(conflictingReuse.response.status, 409);
  assert.equal(conflictingReuse.json.errorCode, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(externalRequests, 1);
  assert.equal(store.agentJobs.length, 2);

  const teamBFirst = await request(tokenB, "market-run-shared-key");
  assert.equal(teamBFirst.response.status, 201);
  assert.equal(teamBFirst.json.duplicate, false);
  assert.notEqual(teamBFirst.json.job.id, teamAFirst.json.job.id);
  assert.equal(teamBFirst.json.job.ownerId, teamBUser.id);
  assert.equal(teamBFirst.json.job.teamId, teamBUser.teamId);
  assert.equal(teamBFirst.json.result.cacheStatus, "cache");
  assert.equal(externalRequests, 1);
  assert.equal(store.agentJobs.length, 3);
  assert.equal(store.marketTradeObservations.length, 3);
  assert.equal(
    store.marketTradeObservations.filter((item) => item.teamId === teamAUser.teamId).length,
    2
  );
  assert.equal(
    store.marketTradeObservations.filter((item) => item.teamId === teamBUser.teamId).length,
    1
  );
  assert.equal(
    store.providerRequestLogs.filter((item) => item.teamId === teamAUser.teamId).length,
    2
  );
  assert.equal(
    store.providerRequestLogs.filter((item) => item.teamId === teamBUser.teamId).length,
    1
  );

  let cooldownBypassProviderCalls = 0;
  setProviderHttpTestTransport(async () => {
    cooldownBypassProviderCalls += 1;
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "60" }
    });
  });
  const jobsBeforeRateLimit = store.agentJobs.length;
  const aliasesBeforeRateLimit = store.agentJobIdempotencyAliases.length;
  const rateLimited = await request(tokenA, "market-run-rate-limited", {
    ...baseBody,
    periods: ["2022"]
  });
  assert.equal(rateLimited.response.status, 429);
  assert.equal(rateLimited.json.errorCode, "PROVIDER_RATE_LIMITED");
  assert.equal(rateLimited.json.retryable, true);
  assert.equal(rateLimited.json.campaignScope, "owner");
  assert.equal(rateLimited.json.executionMode, "inline_single_instance_v1");
  assert.equal(rateLimited.json.job.status, "failed");
  assert.ok(rateLimited.json.job.nextAttemptAt);
  assert.equal(
    store.marketTradeObservations.filter((item) => item.period === "2022").length,
    0
  );
  assert.equal(
    store.agentJobs.find((item) => item.id === rateLimited.json.job.id)?.teamId,
    teamAUser.teamId
  );
  assert.equal(
    rateLimited.response.headers.get("location"),
    `/api/prospect-agent-jobs/${rateLimited.json.job.id}`
  );
  const rateLimitedWithNewKey = await request(
    tokenA,
    "market-run-rate-limited-new-key",
    {
      ...baseBody,
      periods: ["2022"]
    }
  );
  assert.equal(rateLimitedWithNewKey.response.status, 429);
  assert.equal(rateLimitedWithNewKey.json.errorCode, "PROVIDER_RATE_LIMITED");
  assert.equal(rateLimitedWithNewKey.json.job.id, rateLimited.json.job.id);
  assert.equal(cooldownBypassProviderCalls, 1);
  assert.equal(store.agentJobs.length, jobsBeforeRateLimit + 1);
  assert.equal(
    store.agentJobIdempotencyAliases.length,
    aliasesBeforeRateLimit + 1
  );

  const rateLimitedJob = store.agentJobs.find((item) => item.id === rateLimited.json.job.id);
  assert.ok(rateLimitedJob);
  rateLimitedJob.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
  let rateLimitRetryCalls = 0;
  setProviderHttpTestTransport(async () => {
    rateLimitRetryCalls += 1;
    return new Response(JSON.stringify({
      count: 1,
      data: [{
        reporterCode: 842,
        reporterISO: "USA",
        partnerCode: 0,
        partnerDesc: "World",
        flowCode: "M",
        classificationCode: "H7",
        classificationSearchCode: "HS",
        cmdCode: "940542",
        period: "2022",
        primaryValue: 900000,
        netWgt: 10000,
        qty: 10000,
        qtyUnitAbbr: "kg",
        isAggregate: true,
        isReported: true
      }]
    }), { status: 200 });
  });
  const rateLimitedRetried = await request(tokenA, "market-run-rate-limited", {
    ...baseBody,
    periods: ["2022"]
  });
  assert.equal(rateLimitedRetried.response.status, 200);
  assert.equal(rateLimitedRetried.json.duplicate, true);
  assert.equal(rateLimitedRetried.json.job.id, rateLimited.json.job.id);
  assert.equal(rateLimitedRetried.json.job.status, "succeeded");
  assert.equal(rateLimitedRetried.json.job.attemptCount, 2);
  assert.equal(rateLimitRetryCalls, 1);
  assert.equal(
    store.marketTradeObservations.filter((item) => item.period === "2022").length,
    1
  );

  setProviderHttpTestTransport(async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "1" }
    })
  );
  const genericRetryFailure = await request(tokenA, "market-run-generic-retry", {
    ...baseBody,
    periods: ["2020"]
  });
  assert.equal(genericRetryFailure.response.status, 429);
  const genericRetryJob = store.agentJobs.find(
    (item) => item.id === genericRetryFailure.json.job.id
  );
  assert.ok(genericRetryJob);
  genericRetryJob.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
  let genericRetryCalls = 0;
  setProviderHttpTestTransport(async () => {
    genericRetryCalls += 1;
    return new Response(JSON.stringify({
      count: 1,
      data: [{
        reporterCode: 842,
        reporterISO: "USA",
        partnerCode: 0,
        partnerDesc: "World",
        flowCode: "M",
        classificationCode: "H7",
        classificationSearchCode: "HS",
        cmdCode: "940542",
        period: "2020",
        primaryValue: 800000,
        netWgt: 9500,
        qty: 9500,
        qtyUnitAbbr: "kg",
        isAggregate: true,
        isReported: true
      }]
    }), { status: 200 });
  });
  const crossOwnerRetry = await fetch(
    `${baseUrl}/api/prospect-agent-jobs/${genericRetryJob.id}/retry`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA2}`,
        "content-type": "application/json"
      },
      body: "{}"
    }
  );
  assert.equal(crossOwnerRetry.status, 404);
  const genericRetryResponse = await fetch(
    `${baseUrl}/api/prospect-agent-jobs/${genericRetryJob.id}/retry`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json"
      },
      body: "{}"
    }
  );
  const genericRetryJson = await genericRetryResponse.json();
  assert.equal(genericRetryResponse.status, 200);
  assert.equal(genericRetryJson.job.status, "succeeded");
  assert.equal(genericRetryJson.job.attemptCount, 2);
  assert.equal(genericRetryCalls, 1);
  assert.equal(
    genericRetryResponse.headers.get("location"),
    `/api/prospect-agent-jobs/${genericRetryJob.id}`
  );

  let releaseInitialPersistFailure!: () => void;
  let markInitialPersistStarted!: () => void;
  const initialPersistFailureGate = new Promise<void>((resolve) => {
    releaseInitialPersistFailure = resolve;
  });
  const initialPersistStarted = new Promise<void>((resolve) => {
    markInitialPersistStarted = resolve;
  });
  const originalInitialPersist = store.persist.bind(store);
  const jobsBeforeInitialPersistFailure = store.agentJobs.length;
  const aliasesBeforeInitialPersistFailure = store.agentJobIdempotencyAliases.length;
  store.persist = async () => {
    markInitialPersistStarted();
    await initialPersistFailureGate;
    throw new Error("simulated initial job persistence failure");
  };
  const initialPersistFailureBody = { ...baseBody, periods: ["2014"] };
  const initialPersistFailureFirstPromise = request(
    tokenA,
    "market-run-initial-persist-a",
    initialPersistFailureBody
  );
  await initialPersistStarted;
  const initialPersistFailureSecondPromise = request(
    tokenA,
    "market-run-initial-persist-b",
    initialPersistFailureBody
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    store.agentJobIdempotencyAliases.length,
    aliasesBeforeInitialPersistFailure
  );
  releaseInitialPersistFailure();
  const [initialPersistFailureFirst, initialPersistFailureSecond] = await Promise.all([
    initialPersistFailureFirstPromise,
    initialPersistFailureSecondPromise
  ]);
  store.persist = originalInitialPersist;
  assert.equal(initialPersistFailureFirst.response.status, 500);
  assert.equal(initialPersistFailureSecond.response.status, 500);
  assert.equal(store.agentJobs.length, jobsBeforeInitialPersistFailure);
  assert.equal(
    store.agentJobIdempotencyAliases.length,
    aliasesBeforeInitialPersistFailure
  );

  let releaseConcurrentRequest!: () => void;
  let markConcurrentRequestStarted!: () => void;
  const concurrentGate = new Promise<void>((resolve) => {
    releaseConcurrentRequest = resolve;
  });
  const concurrentRequestStarted = new Promise<void>((resolve) => {
    markConcurrentRequestStarted = resolve;
  });
  let concurrentProviderCalls = 0;
  setProviderHttpTestTransport(async () => {
    concurrentProviderCalls += 1;
    markConcurrentRequestStarted();
    await concurrentGate;
    return new Response(JSON.stringify({
      count: 1,
      data: [{
        reporterCode: 842,
        reporterISO: "USA",
        partnerCode: 0,
        partnerDesc: "World",
        flowCode: "M",
        classificationCode: "H7",
        classificationSearchCode: "HS",
        cmdCode: "940542",
        period: "2021",
        primaryValue: 750000,
        netWgt: 9000,
        qty: 9000,
        qtyUnitAbbr: "kg",
        isAggregate: true,
        isReported: true
      }]
    }), { status: 200 });
  });
  const concurrentBody = { ...baseBody, periods: ["2021"] };
  const jobsBeforeConcurrent = store.agentJobs.length;
  const aliasesBeforeConcurrent = store.agentJobIdempotencyAliases.length;
  const concurrentFirstPromise = request(tokenA, "market-run-concurrent-a", concurrentBody);
  await concurrentRequestStarted;
  const runningJob = store.agentJobs.find((item) =>
    item.ownerId === teamAUser.id
    && item.aggregateId === "campaign_shared"
    && item.jobType === "prospect.market_analysis"
    && item.status === "running"
  );
  assert.ok(runningJob);
  const cancelResponse = await fetch(
    `${baseUrl}/api/prospect-agent-jobs/${runningJob.id}/cancel`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json"
      },
      body: "{}"
    }
  );
  const cancelJson = await cancelResponse.json();
  assert.equal(cancelResponse.status, 409);
  assert.equal(cancelJson.errorCode, "INLINE_EXECUTION_NOT_CANCELLABLE");
  assert.equal(store.agentJobs.find((item) => item.id === runningJob.id)?.status, "running");
  const concurrentSecondPromise = request(
    tokenA,
    "market-run-concurrent-b",
    concurrentBody
  );
  const activeConflictingReuse = await request(
    tokenA,
    "market-run-shared-key",
    concurrentBody
  );
  assert.equal(activeConflictingReuse.response.status, 409);
  assert.equal(activeConflictingReuse.json.errorCode, "IDEMPOTENCY_KEY_REUSED");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(concurrentProviderCalls, 1);
  assert.equal(store.agentJobs.length, jobsBeforeConcurrent + 1);
  releaseConcurrentRequest();
  const [concurrentFirst, concurrentSecond] = await Promise.all([
    concurrentFirstPromise,
    concurrentSecondPromise
  ]);
  assert.equal(concurrentFirst.response.status, 201);
  assert.equal(concurrentFirst.json.duplicate, false);
  assert.equal(concurrentSecond.response.status, 200);
  assert.equal(concurrentSecond.json.duplicate, true);
  assert.equal(concurrentFirst.json.job.id, concurrentSecond.json.job.id);
  assert.equal(concurrentSecond.json.job.status, "succeeded");
  assert.equal(concurrentProviderCalls, 1);
  assert.equal(
    store.agentJobIdempotencyAliases.length,
    aliasesBeforeConcurrent + 1
  );
  const concurrentAlias = store.agentJobIdempotencyAliases.find(
    (item) => item.jobId === concurrentFirst.json.job.id
  );
  assert.ok(concurrentAlias);
  assert.match(concurrentAlias.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.notEqual(
    concurrentAlias.idempotencyKey,
    "market-run-concurrent-b"
  );
  assert.equal(
    store.agentJobs.filter((item) =>
      item.ownerId === teamAUser.id
      && item.aggregateId === "campaign_shared"
      && item.jobType === "prospect.market_analysis"
      && item.status === "succeeded"
      && item.createdAt === concurrentFirst.json.job.createdAt
    ).length,
    1
  );
  const concurrentSecondReplay = await request(
    tokenA,
    "market-run-concurrent-b",
    concurrentBody
  );
  assert.equal(concurrentSecondReplay.response.status, 200);
  assert.equal(concurrentSecondReplay.json.duplicate, true);
  assert.equal(concurrentSecondReplay.json.job.id, concurrentFirst.json.job.id);
  assert.equal(concurrentProviderCalls, 1);
  assert.equal(store.agentJobs.length, jobsBeforeConcurrent + 1);

  const concurrentAliasConflict = await request(
    tokenA,
    "market-run-concurrent-b",
    { ...baseBody, periods: ["2017"] }
  );
  assert.equal(concurrentAliasConflict.response.status, 409);
  assert.equal(concurrentAliasConflict.json.errorCode, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(concurrentProviderCalls, 1);
  assert.equal(store.agentJobs.length, jobsBeforeConcurrent + 1);

  let releaseRuntimeBindingProvider!: () => void;
  let markRuntimeBindingProviderStarted!: () => void;
  const runtimeBindingProviderGate = new Promise<void>((resolve) => {
    releaseRuntimeBindingProvider = resolve;
  });
  const runtimeBindingProviderStarted = new Promise<void>((resolve) => {
    markRuntimeBindingProviderStarted = resolve;
  });
  let runtimeBindingProviderCalls = 0;
  setProviderHttpTestTransport(async () => {
    runtimeBindingProviderCalls += 1;
    markRuntimeBindingProviderStarted();
    await runtimeBindingProviderGate;
    return new Response(JSON.stringify({
      count: 1,
      data: [{
        reporterCode: 842,
        reporterISO: "USA",
        partnerCode: 0,
        partnerDesc: "World",
        flowCode: "M",
        classificationCode: "H7",
        classificationSearchCode: "HS",
        cmdCode: "940542",
        period: "2013",
        primaryValue: 400000,
        netWgt: 6000,
        qty: 6000,
        qtyUnitAbbr: "kg",
        isAggregate: true,
        isReported: true
      }]
    }), { status: 200 });
  });
  const runtimeBindingBody = { ...baseBody, periods: ["2013"] };
  const jobsBeforeRuntimeBinding = store.agentJobs.length;
  const aliasesBeforeRuntimeBinding = store.agentJobIdempotencyAliases.length;
  const runtimeBindingPrimaryPromise = request(
    tokenA,
    "market-run-runtime-binding-primary",
    runtimeBindingBody
  );
  await runtimeBindingProviderStarted;

  const originalPersistMutation = store.persistMutation;
  const originalRuntimeBindingPersist = store.persist.bind(store);
  let releaseRuntimeBindingMutation!: () => void;
  let markRuntimeBindingMutationStarted!: () => void;
  const runtimeBindingMutationGate = new Promise<void>((resolve) => {
    releaseRuntimeBindingMutation = resolve;
  });
  const runtimeBindingMutationStarted = new Promise<void>((resolve) => {
    markRuntimeBindingMutationStarted = resolve;
  });
  let runtimeBindingMutationCount = 0;
  let runtimeBindingMutationTail: Promise<unknown> = Promise.resolve();
  store.persistMutation = <T>(
    mutation: () => PersistedStoreMutation<T>
  ): Promise<T> => {
    const current = runtimeBindingMutationTail.then(async () => {
      runtimeBindingMutationCount += 1;
      if (runtimeBindingMutationCount === 1) {
        markRuntimeBindingMutationStarted();
        await runtimeBindingMutationGate;
      }
      const applied = mutation();
      try {
        await originalRuntimeBindingPersist();
        return applied.value;
      } catch (error) {
        applied.rollback();
        throw error;
      }
    });
    runtimeBindingMutationTail = current.catch(() => undefined);
    return current;
  };

  const runtimeBindingAliasPromise = request(
    tokenA,
    "market-run-runtime-binding-shared",
    runtimeBindingBody
  );
  await runtimeBindingMutationStarted;
  const runtimeBindingConflictPromise = request(
    tokenA,
    "market-run-runtime-binding-shared",
    { ...baseBody, periods: ["2012"] }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.agentJobIdempotencyAliases.length, aliasesBeforeRuntimeBinding);
  releaseRuntimeBindingMutation();
  const runtimeBindingConflict = await runtimeBindingConflictPromise;
  assert.equal(runtimeBindingConflict.response.status, 409);
  assert.equal(runtimeBindingConflict.json.errorCode, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(runtimeBindingProviderCalls, 1);
  assert.equal(store.agentJobs.length, jobsBeforeRuntimeBinding + 1);
  assert.equal(
    store.agentJobIdempotencyAliases.length,
    aliasesBeforeRuntimeBinding + 1
  );
  store.persistMutation = originalPersistMutation;
  releaseRuntimeBindingProvider();
  const [runtimeBindingPrimary, runtimeBindingAlias] = await Promise.all([
    runtimeBindingPrimaryPromise,
    runtimeBindingAliasPromise
  ]);
  assert.equal(runtimeBindingPrimary.response.status, 201);
  assert.equal(runtimeBindingAlias.response.status, 200);
  assert.equal(runtimeBindingPrimary.json.job.id, runtimeBindingAlias.json.job.id);
  assert.equal(runtimeBindingProviderCalls, 1);

  let releaseConcurrentFailure!: () => void;
  let markConcurrentFailureStarted!: () => void;
  const concurrentFailureGate = new Promise<void>((resolve) => {
    releaseConcurrentFailure = resolve;
  });
  const concurrentFailureStarted = new Promise<void>((resolve) => {
    markConcurrentFailureStarted = resolve;
  });
  let concurrentFailureProviderCalls = 0;
  setProviderHttpTestTransport(async () => {
    concurrentFailureProviderCalls += 1;
    markConcurrentFailureStarted();
    await concurrentFailureGate;
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "60" }
    });
  });
  const concurrentFailureBody = { ...baseBody, periods: ["2016"] };
  const jobsBeforeConcurrentFailure = store.agentJobs.length;
  const aliasesBeforeConcurrentFailure = store.agentJobIdempotencyAliases.length;
  const concurrentFailureFirstPromise = request(
    tokenA,
    "market-run-concurrent-failure-a",
    concurrentFailureBody
  );
  await concurrentFailureStarted;
  const concurrentFailureSecondPromise = request(
    tokenA,
    "market-run-concurrent-failure-b",
    concurrentFailureBody
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(concurrentFailureProviderCalls, 1);
  assert.equal(store.agentJobs.length, jobsBeforeConcurrentFailure + 1);
  assert.equal(
    store.agentJobIdempotencyAliases.length,
    aliasesBeforeConcurrentFailure + 1
  );
  releaseConcurrentFailure();
  const [concurrentFailureFirst, concurrentFailureSecond] = await Promise.all([
    concurrentFailureFirstPromise,
    concurrentFailureSecondPromise
  ]);
  assert.equal(concurrentFailureFirst.response.status, 429);
  assert.equal(concurrentFailureSecond.response.status, 429);
  assert.equal(
    concurrentFailureFirst.json.job.id,
    concurrentFailureSecond.json.job.id
  );
  assert.equal(concurrentFailureFirst.json.job.status, "failed");
  assert.ok(concurrentFailureFirst.json.job.nextAttemptAt);
  const concurrentFailureReplay = await request(
    tokenA,
    "market-run-concurrent-failure-b",
    concurrentFailureBody
  );
  assert.equal(concurrentFailureReplay.response.status, 429);
  assert.equal(
    concurrentFailureReplay.json.job.id,
    concurrentFailureFirst.json.job.id
  );
  assert.equal(concurrentFailureProviderCalls, 1);
  assert.equal(store.agentJobs.length, jobsBeforeConcurrentFailure + 1);

  const concurrentFailureJob = store.agentJobs.find(
    (item) => item.id === concurrentFailureFirst.json.job.id
  );
  assert.ok(concurrentFailureJob);
  concurrentFailureJob.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
  setProviderHttpTestTransport(async () => {
    concurrentFailureProviderCalls += 1;
    return new Response(JSON.stringify({
      count: 1,
      data: [{
        reporterCode: 842,
        reporterISO: "USA",
        partnerCode: 0,
        partnerDesc: "World",
        flowCode: "M",
        classificationCode: "H7",
        classificationSearchCode: "HS",
        cmdCode: "940542",
        period: "2016",
        primaryValue: 500000,
        netWgt: 7000,
        qty: 7000,
        qtyUnitAbbr: "kg",
        isAggregate: true,
        isReported: true
      }]
    }), { status: 200 });
  });
  const concurrentFailureRetried = await request(
    tokenA,
    "market-run-concurrent-failure-b",
    concurrentFailureBody
  );
  assert.equal(concurrentFailureRetried.response.status, 200);
  assert.equal(
    concurrentFailureRetried.json.job.id,
    concurrentFailureFirst.json.job.id
  );
  assert.equal(concurrentFailureRetried.json.job.attemptCount, 2);
  assert.equal(concurrentFailureProviderCalls, 2);
  assert.equal(store.agentJobs.length, jobsBeforeConcurrentFailure + 1);

  let releaseAliasRollbackProvider!: () => void;
  let markAliasRollbackProviderStarted!: () => void;
  const aliasRollbackProviderGate = new Promise<void>((resolve) => {
    releaseAliasRollbackProvider = resolve;
  });
  const aliasRollbackProviderStarted = new Promise<void>((resolve) => {
    markAliasRollbackProviderStarted = resolve;
  });
  let aliasRollbackProviderCalls = 0;
  setProviderHttpTestTransport(async () => {
    aliasRollbackProviderCalls += 1;
    markAliasRollbackProviderStarted();
    await aliasRollbackProviderGate;
    return new Response(JSON.stringify({
      count: 1,
      data: [{
        reporterCode: 842,
        reporterISO: "USA",
        partnerCode: 0,
        partnerDesc: "World",
        flowCode: "M",
        classificationCode: "H7",
        classificationSearchCode: "HS",
        cmdCode: "940542",
        period: "2015",
        primaryValue: 450000,
        netWgt: 6500,
        qty: 6500,
        qtyUnitAbbr: "kg",
        isAggregate: true,
        isReported: true
      }]
    }), { status: 200 });
  });
  const aliasRollbackBody = { ...baseBody, periods: ["2015"] };
  const aliasRollbackFirstPromise = request(
    tokenA,
    "market-run-alias-rollback-a",
    aliasRollbackBody
  );
  await aliasRollbackProviderStarted;
  const aliasesBeforeRollback = store.agentJobIdempotencyAliases.length;
  const originalAliasPersist = store.persist.bind(store);
  let releaseAliasRollbackPersist!: () => void;
  let markAliasRollbackPersistStarted!: () => void;
  const aliasRollbackPersistGate = new Promise<void>((resolve) => {
    releaseAliasRollbackPersist = resolve;
  });
  const aliasRollbackPersistStarted = new Promise<void>((resolve) => {
    markAliasRollbackPersistStarted = resolve;
  });
  let aliasRollbackPersistCalls = 0;
  store.persist = async () => {
    aliasRollbackPersistCalls += 1;
    if (aliasRollbackPersistCalls === 1) {
      markAliasRollbackPersistStarted();
      await aliasRollbackPersistGate;
      throw new Error("simulated alias persistence failure");
    }
    await originalAliasPersist();
  };
  const aliasRollbackSecondPromise = request(
    tokenA,
    "market-run-alias-rollback-b",
    aliasRollbackBody
  );
  await aliasRollbackPersistStarted;
  let aliasRollbackFirstSettled = false;
  void aliasRollbackFirstPromise.finally(() => {
    aliasRollbackFirstSettled = true;
  });
  releaseAliasRollbackProvider();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    aliasRollbackFirstSettled,
    false,
    "主任务完成持久化必须等待并发别名写入完成或回滚"
  );
  releaseAliasRollbackPersist();
  const aliasRollbackSecond = await aliasRollbackSecondPromise;
  assert.equal(aliasRollbackSecond.response.status, 500);
  assert.equal(store.agentJobIdempotencyAliases.length, aliasesBeforeRollback);
  assert.equal(aliasRollbackProviderCalls, 1);
  const aliasRollbackFirst = await aliasRollbackFirstPromise;
  store.persist = originalAliasPersist;
  assert.equal(aliasRollbackFirst.response.status, 201);
  assert.equal(aliasRollbackFirst.json.job.status, "succeeded");
  assert.equal(aliasRollbackProviderCalls, 1);
  assert.ok(aliasRollbackPersistCalls >= 2);

  setProviderHttpTestTransport(async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "0" }
    })
  );
  const staleFailure = await request(tokenA, "market-run-stale", {
    ...baseBody,
    periods: ["2019"]
  });
  assert.equal(staleFailure.response.status, 429);
  const staleJob = store.agentJobs.find((item) => item.id === staleFailure.json.job.id);
  assert.ok(staleJob);
  staleJob.status = "running";
  staleJob.nextAttemptAt = "";
  staleJob.finishedAt = "";
  let staleRecoveryCalls = 0;
  setProviderHttpTestTransport(async () => {
    staleRecoveryCalls += 1;
    return new Response(JSON.stringify({
      count: 1,
      data: [{
        reporterCode: 842,
        reporterISO: "USA",
        partnerCode: 0,
        partnerDesc: "World",
        flowCode: "M",
        classificationCode: "H7",
        classificationSearchCode: "HS",
        cmdCode: "940542",
        period: "2019",
        primaryValue: 700000,
        netWgt: 8500,
        qty: 8500,
        qtyUnitAbbr: "kg",
        isAggregate: true,
        isReported: true
      }]
    }), { status: 200 });
  });
  const staleRecovered = await request(tokenA, "market-run-stale", {
    ...baseBody,
    periods: ["2019"]
  });
  assert.equal(staleRecovered.response.status, 200);
  assert.equal(staleRecovered.json.duplicate, true);
  assert.equal(staleRecovered.json.job.status, "succeeded");
  assert.equal(staleRecovered.json.job.errorCode, "");
  assert.equal(staleRecoveryCalls, 1);

  const originalPersist = store.persist.bind(store);
  let rollbackPersistCalls = 0;
  let unrelatedJobId = "";
  let unrelatedLogId = "";
  let unrelatedObservationId = "";
  store.persist = async () => {
    rollbackPersistCalls += 1;
    if (rollbackPersistCalls !== 3) return;
    const jobTemplate = store.agentJobs.find((item) => item.status === "succeeded");
    const logTemplate = store.providerRequestLogs[0];
    const observationTemplate = store.marketTradeObservations[0];
    assert.ok(jobTemplate);
    assert.ok(logTemplate);
    assert.ok(observationTemplate);
    unrelatedJobId = "aj_unrelated_rollback";
    unrelatedLogId = "prl_unrelated_rollback";
    unrelatedObservationId = "mto_unrelated_rollback";
    store.agentJobs.unshift({
      ...structuredClone(jobTemplate),
      id: unrelatedJobId,
      jobType: "prospect.unrelated_rollback_test",
      aggregateId: "unrelated_campaign",
      idempotencyKey: "f".repeat(64),
      createdAt: new Date().toISOString()
    });
    store.providerRequestLogs.unshift({
      ...structuredClone(logTemplate),
      id: unrelatedLogId,
      runId: "unrelated_run"
    });
    store.marketTradeObservations.unshift({
      ...structuredClone(observationTemplate),
      id: unrelatedObservationId,
      campaignId: "unrelated_campaign",
      period: "2018"
    });
    throw new Error("simulated final persistence failure");
  };
  setProviderHttpTestTransport(async () =>
    new Response(JSON.stringify({
      count: 1,
      data: [{
        reporterCode: 842,
        reporterISO: "USA",
        partnerCode: 0,
        partnerDesc: "World",
        flowCode: "M",
        classificationCode: "H7",
        classificationSearchCode: "HS",
        cmdCode: "940542",
        period: "2018",
        primaryValue: 600000,
        netWgt: 8000,
        qty: 8000,
        qtyUnitAbbr: "kg",
        isAggregate: true,
        isReported: true
      }]
    }), { status: 200 })
  );
  const rollbackFailure = await request(tokenA, "market-run-rollback", {
    ...baseBody,
    periods: ["2018"]
  });
  store.persist = originalPersist;
  assert.equal(rollbackFailure.response.status, 500);
  assert.ok(store.agentJobs.some((item) => item.id === unrelatedJobId));
  assert.ok(store.providerRequestLogs.some((item) => item.id === unrelatedLogId));
  assert.ok(store.marketTradeObservations.some((item) => item.id === unrelatedObservationId));
  const rollbackJob = store.agentJobs.find((item) =>
    item.ownerId === teamAUser.id
    && item.aggregateId === "campaign_shared"
    && item.status === "running"
  );
  assert.ok(rollbackJob);
  const rollbackRecovered = await request(tokenA, "market-run-rollback", {
    ...baseBody,
    periods: ["2018"]
  });
  assert.equal(rollbackRecovered.response.status, 200);
  assert.equal(rollbackRecovered.json.duplicate, true);
  assert.equal(rollbackRecovered.json.job.id, rollbackJob.id);
  assert.equal(rollbackRecovered.json.job.status, "succeeded");

  const document = createOpenApiDocument(app);
  const operation = (document.paths as Record<string, Record<string, any>>)
    ["/api/prospect-campaigns/{id}/market-analysis-runs"]?.post;
  assert.ok(operation);
  assert.equal(operation.tags[0], "获客项目");
  assert.ok(operation.parameters.some((item: any) =>
    item.in === "header" && item.name === "Idempotency-Key" && item.required === true
  ));
  assert.equal(
    operation.requestBody.content["application/json"].schema.additionalProperties,
    false
  );
  assert.ok(operation.responses["201"]);
  assert.equal(
    operation.responses["200"].content["application/json"].schema
      .properties.retryMode.enum[0],
    "manual"
  );
  assert.equal(
    operation.responses["201"].content["application/json"].schema
      .properties.result.properties.updatedCount.type,
    "integer"
  );
  assert.equal(
    operation.responses["201"].content["application/json"].schema
      .properties.result.properties.resultScope.enum[0],
    "job_execution"
  );
  assert.equal(
    operation.responses["201"].content["application/json"].schema
      .properties.result.properties.querySummary.additionalProperties,
    false
  );
  assert.equal(
    operation.responses["201"].content["application/json"].schema
      .properties.result.properties.observations.items.additionalProperties,
    false
  );
  assert.ok(operation.responses["400"].content["application/json"].schema.oneOf);
  for (const status of ["409", "413", "429", "500", "502", "504"]) {
    assert.ok(operation.responses[status].content["application/json"].schema);
  }
  assert.equal(
    operation.responses["429"].content["application/json"].schema.$ref,
    "#/components/schemas/MarketAnalysisProviderError"
  );
  assert.match(
    operation.responses["201"].headers.Location.description,
    /完整查询结果需重放本 POST/
  );
  assert.match(operation.description, /inline_single_instance_v1/);
  assert.match(operation.description, /重放本 POST 可恢复完整/);
  assert.match(operation.description, /resultScope=job_execution/);

  const schemas = (document.components as Record<string, any>).schemas;
  const requestErrorSchema = schemas.MarketAnalysisRequestError;
  assert.ok(requestErrorSchema.required.includes("message"));
  assert.ok(requestErrorSchema.required.includes("errorCode"));
  const providerErrorSchema = schemas.MarketAnalysisProviderError;
  for (const field of [
    "message",
    "errorCode",
    "retryable",
    "retryAfterAt",
    "campaignContractMode",
    "campaignScope",
    "executionMode",
    "retryMode",
    "autoRetryScheduled",
    "job"
  ]) {
    assert.ok(providerErrorSchema.required.includes(field));
    assert.ok(providerErrorSchema.properties[field]);
  }

  console.log("Market analysis run execution, retry, concurrency, rollback, isolation and Swagger tests passed");
} finally {
  setProviderHttpTestTransport(null);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
