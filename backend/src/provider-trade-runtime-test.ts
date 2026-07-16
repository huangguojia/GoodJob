import assert from "node:assert/strict";
import { encryptProviderConfiguration } from "./credential-security.js";
import { ProviderContractError } from "./provider-contract.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import {
  createProviderExecutionContext,
  executeProviderHealth,
  executeProviderTradeQuery,
  resetProviderTradeRuntimeStateForTests
} from "./provider-runtime.js";
import { getStore } from "./store.js";
import { UN_COMTRADE_PROVIDER } from "./un-comtrade-provider.js";
import type {
  ProviderCatalogItem,
  ProviderConnection,
  ProviderRequestLog
} from "./types.js";

const foundCatalog = createDefaultProviderCatalog()
  .find((item) => item.code === "un_comtrade");
assert.ok(foundCatalog);
const defaultCatalog: ProviderCatalogItem = foundCatalog;

const query = {
  reporterCodes: ["842"],
  partnerCodes: ["0"],
  flow: "import" as const,
  hsVersion: "HS2022" as const,
  commodityCodes: ["940542"],
  periods: ["2023"],
  frequency: "annual" as const,
  limit: 5
};

function context(teamId: string, ownerId: string, runId: string) {
  return createProviderExecutionContext({
    teamId,
    ownerId,
    runId,
    providerId: UN_COMTRADE_PROVIDER.id,
    operation: "trade",
    purpose: "market_analysis"
  });
}

function connection(teamId: string, ownerId: string, id: string): ProviderConnection {
  const now = "2026-07-13T00:00:00.000Z";
  const identity = {
    id,
    providerId: UN_COMTRADE_PROVIDER.id,
    ownerId,
    teamId
  };
  return {
    ...identity,
    scope: "personal",
    credentialRef: `credential_${id}`,
    configurationEncrypted: encryptProviderConfiguration(identity, {
      apiKey: "runtime-test-key",
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
    createdBy: ownerId,
    createdAt: now,
    updatedAt: now
  };
}

function catalog(ratePolicy: Record<string, unknown>): ProviderCatalogItem {
  return {
    ...defaultCatalog,
    defaultRatePolicy: ratePolicy
  };
}

function response() {
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
}

function clearRuntime() {
  resetProviderTradeRuntimeStateForTests();
  getStore().providerResponseCache.splice(0);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectCode(
  operation: Promise<unknown>,
  code: ProviderContractError["code"]
) {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof ProviderContractError && error.code === code
  );
}

clearRuntime();
let externalRequests = 0;
setProviderHttpTestTransport(async () => {
  externalRequests += 1;
  return response();
});

const teamALogs: ProviderRequestLog[] = [];
const teamA = await executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: defaultCatalog,
  context: context("team_a", "owner_a", "run_team_a"),
  credential: { apiKey: "" },
  query,
  onLogs(logs) {
    teamALogs.push(...logs);
  }
});
assert.equal(teamA.cacheStatus, "live");
assert.equal(teamA.observations.length, 1);
assert.equal(teamA.observations[0]?.classification, "HS2022");
assert.equal(externalRequests, 1);
assert.equal(teamALogs.length, 1);
assert.equal(teamALogs[0]?.teamId, "team_a");
assert.equal(teamALogs[0]?.ownerId, "owner_a");
assert.equal(teamALogs[0]?.quotaUnits, 1);

const teamBLogs: ProviderRequestLog[] = [];
const teamB = await executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: defaultCatalog,
  context: context("team_b", "owner_b", "run_team_b"),
  credential: { apiKey: "" },
  query,
  onLogs(logs) {
    teamBLogs.push(...logs);
  }
});
assert.equal(teamB.cacheStatus, "cache");
assert.equal(teamB.observations.length, 1);
assert.equal(teamB.usage.requestCount, 0);
assert.equal(teamB.usage.quotaUsed, 0);
assert.equal(externalRequests, 1);
assert.equal(teamBLogs.length, 1);
assert.equal(teamBLogs[0]?.teamId, "team_b");
assert.equal(teamBLogs[0]?.ownerId, "owner_b");
assert.equal(teamBLogs[0]?.quotaUnits, 0);
assert.notEqual(teamALogs[0]?.id, teamBLogs[0]?.id);
assert.equal(getStore().providerResponseCache.length, 1);
assert.equal("teamId" in getStore().providerResponseCache[0]!, false);

await executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: defaultCatalog,
  context: context("team_b", "owner_b", "run_team_b_new_period"),
  credential: { apiKey: "" },
  query: { ...query, periods: ["2022"] },
  onLogs() {}
});
assert.equal(externalRequests, 2);
assert.equal(getStore().providerResponseCache.length, 2);

const blockedCatalog: ProviderCatalogItem = {
  ...defaultCatalog,
  capabilities: []
};
await expectCode(executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: blockedCatalog,
  context: context("team_a", "owner_a", "run_blocked"),
  credential: { apiKey: "" },
  query,
  onLogs() {}
}), "PROVIDER_POLICY_BLOCKED");

clearRuntime();
externalRequests = 0;
let releaseSharedRequest!: () => void;
let markSharedRequestStarted!: () => void;
const sharedRequestStarted = new Promise<void>((resolve) => {
  markSharedRequestStarted = resolve;
});
const sharedRequestGate = new Promise<void>((resolve) => {
  releaseSharedRequest = resolve;
});
setProviderHttpTestTransport(async () => {
  externalRequests += 1;
  markSharedRequestStarted();
  await sharedRequestGate;
  return response();
});
const sharedCatalog = catalog({
  cacheTtlSeconds: 86400,
  maxConcurrentPerConnection: 1,
  minIntervalMs: 50,
  requestsPerMinute: 10
});
const connectionA = connection("team_a", "owner_a", "connection_a");
const connectionB = connection("team_b", "owner_b", "connection_b");
const leaderLogs: ProviderRequestLog[] = [];
const followerLogs: ProviderRequestLog[] = [];
const leaderPromise = executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: sharedCatalog,
  context: context("team_a", "owner_a", "run_shared_leader"),
  connection: connectionA,
  query,
  onLogs(logs) {
    leaderLogs.push(...logs);
  }
});
await sharedRequestStarted;
const followerPromise = executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: sharedCatalog,
  context: context("team_b", "owner_b", "run_shared_follower"),
  connection: connectionB,
  query,
  onLogs(logs) {
    followerLogs.push(...logs);
  }
});
await Promise.resolve();
releaseSharedRequest();
const [leaderResult, followerResult] = await Promise.all([leaderPromise, followerPromise]);
assert.equal(externalRequests, 1);
assert.equal(leaderResult.cacheStatus, "live");
assert.equal(followerResult.cacheStatus, "cache");
assert.equal(followerResult.usage.requestCount, 0);
assert.equal(followerResult.usage.quotaUsed, 0);
assert.equal(leaderLogs.length, 1);
assert.equal(leaderLogs[0]?.teamId, "team_a");
assert.equal(leaderLogs[0]?.connectionId, "connection_a");
assert.equal(leaderLogs[0]?.quotaUnits, 1);
assert.equal(followerLogs.length, 1);
assert.equal(followerLogs[0]?.teamId, "team_b");
assert.equal(followerLogs[0]?.connectionId, "connection_b");
assert.equal(followerLogs[0]?.quotaUnits, 0);
assert.notEqual(leaderLogs[0]?.id, followerLogs[0]?.id);

const cachedLogs: ProviderRequestLog[] = [];
const cachedResult = await executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: sharedCatalog,
  context: context("team_a", "owner_a", "run_cache_no_budget"),
  connection: connectionA,
  query,
  onLogs(logs) {
    cachedLogs.push(...logs);
  }
});
assert.equal(cachedResult.cacheStatus, "cache");
assert.equal(externalRequests, 1);
assert.equal(cachedLogs[0]?.quotaUnits, 0);

clearRuntime();
externalRequests = 0;
let releaseConcurrentRequest!: () => void;
let markConcurrentRequestStarted!: () => void;
const concurrentRequestStarted = new Promise<void>((resolve) => {
  markConcurrentRequestStarted = resolve;
});
const concurrentRequestGate = new Promise<void>((resolve) => {
  releaseConcurrentRequest = resolve;
});
setProviderHttpTestTransport(async () => {
  externalRequests += 1;
  markConcurrentRequestStarted();
  await concurrentRequestGate;
  return response();
});
const activePromise = executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: sharedCatalog,
  context: context("team_a", "owner_a", "run_active_request"),
  connection: connectionA,
  query: { ...query, periods: ["2020"] },
  onLogs() {}
});
await concurrentRequestStarted;
const concurrentLogs: ProviderRequestLog[] = [];
await expectCode(executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: sharedCatalog,
  context: context("team_a", "owner_a", "run_blocked_concurrent"),
  connection: connectionA,
  query: { ...query, periods: ["2021"] },
  onLogs(logs) {
    concurrentLogs.push(...logs);
  }
}), "PROVIDER_RATE_LIMITED");
assert.equal(externalRequests, 1);
assert.equal(concurrentLogs.length, 1);
assert.equal(concurrentLogs[0]?.httpStatus, 429);
assert.equal(concurrentLogs[0]?.quotaUnits, 0);
releaseConcurrentRequest();
await activePromise;

clearRuntime();
externalRequests = 0;
setProviderHttpTestTransport(async () => {
  externalRequests += 1;
  return response();
});
const intervalCatalog = catalog({
  cacheTtlSeconds: 86400,
  maxConcurrentPerConnection: 1,
  minIntervalMs: 40,
  requestsPerMinute: 10
});
await executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: intervalCatalog,
  context: context("team_a", "owner_a", "run_interval_first"),
  connection: connectionA,
  query: { ...query, periods: ["2019"] },
  onLogs() {}
});
await expectCode(executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: intervalCatalog,
  context: context("team_a", "owner_a", "run_interval_blocked"),
  connection: connectionA,
  query: { ...query, periods: ["2018"] },
  onLogs() {}
}), "PROVIDER_RATE_LIMITED");
assert.equal(externalRequests, 1);
await delay(100);
await executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: intervalCatalog,
  context: context("team_a", "owner_a", "run_interval_after_wait"),
  connection: connectionA,
  query: { ...query, periods: ["2018"] },
  onLogs() {}
});
assert.equal(externalRequests, 2);

clearRuntime();
externalRequests = 0;
const healthBudgetCatalog = catalog({
  cacheTtlSeconds: 86400,
  maxConcurrentPerConnection: 1,
  minIntervalMs: 40,
  requestsPerMinute: 10
});
setProviderHttpTestTransport(async () => {
  externalRequests += 1;
  return response();
});
const healthLogs: ProviderRequestLog[] = [];
const healthResult = await executeProviderHealth({
  provider: UN_COMTRADE_PROVIDER,
  catalog: healthBudgetCatalog,
  context: context("team_a", "owner_a", "run_health_budget"),
  connection: connectionA,
  onLogs(logs) {
    healthLogs.push(...logs);
  }
});
assert.equal(healthResult.ok, true);
assert.equal(externalRequests, 1);
assert.equal(healthLogs[0]?.quotaUnits, 1);
const tradeAfterHealthLogs: ProviderRequestLog[] = [];
await expectCode(executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: healthBudgetCatalog,
  context: context("team_a", "owner_a", "run_trade_after_health"),
  connection: connectionA,
  query: { ...query, periods: ["2014"] },
  onLogs(logs) {
    tradeAfterHealthLogs.push(...logs);
  }
}), "PROVIDER_RATE_LIMITED");
assert.equal(externalRequests, 1);
assert.equal(tradeAfterHealthLogs[0]?.quotaUnits, 0);
assert.equal(tradeAfterHealthLogs[0]?.httpStatus, 429);
await delay(100);
await executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: healthBudgetCatalog,
  context: context("team_a", "owner_a", "run_trade_after_health_wait"),
  connection: connectionA,
  query: { ...query, periods: ["2014"] },
  onLogs() {}
});
assert.equal(externalRequests, 2);

clearRuntime();
externalRequests = 0;
const minuteCatalog = catalog({
  cacheTtlSeconds: 86400,
  maxConcurrentPerConnection: 1,
  minIntervalMs: 0,
  requestsPerMinute: 2
});
for (const period of ["2015", "2016"]) {
  await executeProviderTradeQuery({
    provider: UN_COMTRADE_PROVIDER,
    catalog: minuteCatalog,
    context: context("team_a", "owner_a", `run_minute_${period}`),
    connection: connectionA,
    query: { ...query, periods: [period] },
    onLogs() {}
  });
}
await expectCode(executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: minuteCatalog,
  context: context("team_a", "owner_a", "run_minute_blocked"),
  connection: connectionA,
  query: { ...query, periods: ["2017"] },
  onLogs() {}
}), "PROVIDER_RATE_LIMITED");
assert.equal(externalRequests, 2);

clearRuntime();
externalRequests = 0;
const failureCatalog = catalog({
  cacheTtlSeconds: 86400,
  maxConcurrentPerConnection: 1,
  minIntervalMs: 40,
  requestsPerMinute: 10
});
setProviderHttpTestTransport(async () => {
  externalRequests += 1;
  return new Response("unavailable", { status: 503 });
});
const failedRequestLogs: ProviderRequestLog[] = [];
await expectCode(executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: failureCatalog,
  context: context("team_a", "owner_a", "run_failed_real_request"),
  connection: connectionA,
  query: { ...query, periods: ["2010"] },
  onLogs(logs) {
    failedRequestLogs.push(...logs);
  }
}), "PROVIDER_UNAVAILABLE");
const failedRetryLogs: ProviderRequestLog[] = [];
await expectCode(executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: failureCatalog,
  context: context("team_a", "owner_a", "run_failed_retry"),
  connection: connectionA,
  query: { ...query, periods: ["2011"] },
  onLogs(logs) {
    failedRetryLogs.push(...logs);
  }
}), "PROVIDER_RATE_LIMITED");
assert.equal(externalRequests, 1);
assert.equal(failedRequestLogs[0]?.quotaUnits, 1);
assert.equal(failedRetryLogs[0]?.quotaUnits, 0);

clearRuntime();
externalRequests = 0;
let releaseSharedFailure!: () => void;
let markSharedFailureStarted!: () => void;
const sharedFailureStarted = new Promise<void>((resolve) => {
  markSharedFailureStarted = resolve;
});
const sharedFailureGate = new Promise<void>((resolve) => {
  releaseSharedFailure = resolve;
});
setProviderHttpTestTransport(async () => {
  externalRequests += 1;
  markSharedFailureStarted();
  await sharedFailureGate;
  return new Response("unavailable", { status: 503 });
});
const sharedFailureCatalog = catalog({
  cacheTtlSeconds: 86400,
  maxConcurrentPerConnection: 1,
  minIntervalMs: 0,
  requestsPerMinute: 10
});
const leaderFailureLogs: ProviderRequestLog[] = [];
const followerFailureLogs: ProviderRequestLog[] = [];
const leaderFailure = executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: sharedFailureCatalog,
  context: context("team_a", "owner_a", "run_failure_leader"),
  connection: connectionA,
  query: { ...query, periods: ["2009"] },
  onLogs(logs) {
    leaderFailureLogs.push(...logs);
  }
});
await sharedFailureStarted;
const followerFailure = executeProviderTradeQuery({
  provider: UN_COMTRADE_PROVIDER,
  catalog: sharedFailureCatalog,
  context: context("team_b", "owner_b", "run_failure_follower"),
  connection: connectionB,
  query: { ...query, periods: ["2009"] },
  onLogs(logs) {
    followerFailureLogs.push(...logs);
  }
});
await Promise.resolve();
releaseSharedFailure();
const failureResults = await Promise.allSettled([leaderFailure, followerFailure]);
assert.equal(externalRequests, 1);
assert.equal(failureResults[0]?.status, "rejected");
assert.equal(failureResults[1]?.status, "rejected");
if (failureResults[0]?.status !== "rejected" || failureResults[1]?.status !== "rejected") {
  throw new Error("Expected both shared calls to fail");
}
assert.equal(failureResults[0].reason instanceof ProviderContractError, true);
assert.equal(failureResults[1].reason instanceof ProviderContractError, true);
assert.equal(failureResults[0].reason.code, "PROVIDER_UNAVAILABLE");
assert.equal(failureResults[1].reason.code, "PROVIDER_UNAVAILABLE");
assert.notEqual(failureResults[0].reason, failureResults[1].reason);
assert.equal(leaderFailureLogs.length, 1);
assert.equal(leaderFailureLogs[0]?.quotaUnits, 1);
assert.equal(followerFailureLogs.length, 1);
assert.equal(followerFailureLogs[0]?.teamId, "team_b");
assert.equal(followerFailureLogs[0]?.quotaUnits, 0);

setProviderHttpTestTransport(null);
clearRuntime();
console.log("Provider trade runtime cache, singleflight, rate limit and tenant log tests passed");
